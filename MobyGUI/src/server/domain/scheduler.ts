import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import {
  getAllAssetStates, getApiKeyById,
  getInflightCount,
  isEnabled,
  getEnabledAssetConfigs,
  hasAnyApiKeys,
  isExchangeEnabled,
  type AssetConfigRecord,
} from '../db/repositories.js';
import { startWithdrawal, isEligibleForWithdrawal } from './withdrawWorker.js';
import { getClientPool } from '../exchanges/clientPool.js';
import { getExchangeRegistry } from '../exchanges/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { WithdrawalJob, ExchangeId } from './types.js';
import type { ExchangeRestClient } from '../exchanges/types.js';

const logger = createChildLogger('scheduler');

export interface SchedulerOptions {
  config: AppConfig;
  syncTrades?: (exchange: ExchangeId, client: ExchangeRestClient) => Promise<unknown>;
}

export interface SchedulerEvents {
  withdrawalStarted: (job: WithdrawalJob) => void;
  withdrawalFailed: (exchange: ExchangeId, asset: string, error: string) => void;
  tick: () => void;
}

export class Scheduler extends EventEmitter {
  private config: AppConfig;

  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private wakeRequested = false;
  private ticking = false;
  private revision = 0;
  readonly assetNotices = new Map<string, string>();
  private readonly disabledTickMs = 10_000;
  private syncTrades?: SchedulerOptions['syncTrades'];

  constructor(options: SchedulerOptions) {
    super();
    this.config = options.config;
    this.syncTrades = options.syncTrades;
  }

  /**
   * Start the scheduler loop
   */
  start(): void {
    if (this.running) {
      logger.debug('Scheduler already running');
      return;
    }

    logger.info('Starting scheduler');
    this.running = true;
    this.scheduleTick();
  }

  /**
   * Stop the scheduler loop
   * @param silent - If true, don't log (used during process exit when logger may be unavailable)
   */
  stop(silent = false): void {
    if (!this.running) {
      return;
    }

    if (!silent) {
      logger.info('Stopping scheduler');
    }
    this.running = false;
    this.revision++;

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Wake the scheduler immediately (e.g., when a new fill arrives)
   */
  wake(): void {
    this.wakeRequested = true;
    if (!this.running || this.ticking) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.scheduleTick(0);
  }

  /**
   * Update configuration
   */
  updateConfig(config: AppConfig): void {
    this.config = config;
    this.assetNotices.clear();
    this.revision++;
    this.wake();
  }

  /**
   * Schedule the next tick
   */
  private scheduleTick(delayMs?: number): void {
    if (!this.running) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);

    this.tickTimer = setTimeout(
      () => this.tick(),
      delayMs ?? this.config.global.schedulerTickMs
    );
  }

  /**
   * Run one scheduler tick
   */
  private async tick(): Promise<void> {
    // Check if stopped (handles race condition during shutdown)
    if (!this.running || this.ticking) return;
    this.ticking = true;
    this.tickTimer = null;

    this.wakeRequested = false;
    this.emit('tick');

    try {
      // Check if enabled
      if (!isEnabled()) {
        logger.debug('Scheduler disabled, skipping tick');
        return;
      }

      // Process all exchanges that have API keys and are enabled (database toggle)
      const registry = getExchangeRegistry();
      const allExchanges = registry.getAll().map((a) => a.exchangeId);
      const enabledExchanges = allExchanges.filter(
        (id) => hasAnyApiKeys(id) && isExchangeEnabled(id)
      );

      for (const exchange of enabledExchanges) {
        await this.processExchange(exchange);
      }
    } catch (error) {
      logger.error({ error }, 'Scheduler tick error');
    } finally {
      this.ticking = false;
      this.scheduleTick(this.wakeRequested ? 0 : isEnabled() ? this.config.global.schedulerTickMs : this.disabledTickMs);
    }
  }

  /**
   * Process withdrawals for a specific exchange
   */
  private async processExchange(exchange: ExchangeId): Promise<void> {
    const globalInflight = getInflightCount();
    const { maxInflightWithdrawals } = this.config.global;

    // Check global limit
    if (globalInflight >= maxInflightWithdrawals) {
      logger.debug(
        { exchange, globalInflight, max: maxInflightWithdrawals },
        'At global inflight limit'
      );
      return;
    }

    // Check if we have API keys for this exchange
    const pool = getClientPool(exchange);
    if (!pool.hasAvailableClients()) {
      logger.debug({ exchange }, 'No available API keys');
      return;
    }

    // Get enabled asset configs for this exchange from database
    const assetConfigs = getEnabledAssetConfigs(exchange);

    if (assetConfigs.length === 0) {
      return;
    }

    // Sort by priority (lower number = higher priority)
    assetConfigs.sort((a, b) => a.priority - b.priority);

    // Get current states for this exchange
    const states = new Map(
      getAllAssetStates(exchange).map((s) => [s.asset, s])
    );

    // Process assets in priority order
    let withdrawalsStarted = 0;
    const availableSlots = maxInflightWithdrawals - globalInflight;

    for (const assetConfig of assetConfigs) {
      if (withdrawalsStarted >= availableSlots) {
        break;
      }

      const result = await this.tryWithdrawAsset(
        exchange,
        assetConfig,
        states,
        globalInflight + withdrawalsStarted
      );

      if (result === 'started') {
        withdrawalsStarted++;
      }
    }

    if (withdrawalsStarted > 0) {
      logger.info({ exchange, count: withdrawalsStarted }, 'Started withdrawals this tick');
    }
  }

  /**
   * Try to start a withdrawal for a specific asset
   */
  private async tryWithdrawAsset(
    exchange: ExchangeId,
    assetConfig: AssetConfigRecord,
    states: Map<string, { pendingAmount: number }>,
    currentGlobalInflight: number
  ): Promise<'started' | 'skipped' | 'failed'> {
    const { asset, threshold, reserve, destKeys } = assetConfig;
    const state = states.get(asset);
    const pendingAmount = state?.pendingAmount ?? 0;

    // Check threshold - simple coin amount check
    if (pendingAmount < threshold) {
      return 'skipped';
    }

    // Check eligibility (backoff, inflight limits, etc.)
    const assetInflight = getInflightCount(exchange, asset);
    const eligibility = isEligibleForWithdrawal(
      exchange,
      asset,
      assetConfig,
      this.config.global,
      assetInflight,
      currentGlobalInflight
    );

    if (!eligibility.eligible) {
      logger.debug({ exchange, asset, reason: eligibility.reason }, 'Asset not eligible');
      return 'skipped';
    }

    // Get a client from the pool
    const pool = getClientPool(exchange);
    const selection = pool.selectBestKey();

    if (!selection) {
      logger.warn({ exchange, asset }, 'No available API keys for withdrawal');
      return 'skipped';
    }

    const revision = this.revision;
    // Try withdrawal
    const result = await startWithdrawal(asset, assetConfig, {
      exchangeClient: selection.client,
      exchange,
      globalConfig: this.config.global,
      beforeBalanceCheck: () => this.syncTrades?.(exchange, selection.client) ?? Promise.resolve(),
      canSubmit: () => this.running && this.revision === revision && !!getApiKeyById(selection.keyId)?.isActive,
    });

    // Record usage regardless of outcome
    pool.recordUsage(selection.keyId, 2); // Withdrawals cost more

    if (result.success && result.job) {
      this.assetNotices.delete(`${exchange}:${asset}`);
      this.emit('withdrawalStarted', result.job);
      return 'started';
    }

    if (result.skipped) {
      this.assetNotices.set(`${exchange}:${asset}`, result.skipReason || 'Waiting');
      logger.debug({ exchange, asset, reason: result.skipReason }, 'Withdrawal skipped');
      return 'skipped';
    }

    if (result.error) {
      pool.handleError(selection.keyId, result.error);
      this.emit('withdrawalFailed', exchange, asset, result.error);
      return 'failed';
    }

    return 'skipped';
  }
}

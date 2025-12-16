import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import {
  getAllAssetStates,
  getInflightCount,
  isEnabled,
} from '../db/repositories.js';
import { meetsSweepThreshold } from './chunking.js';
import { startWithdrawal, isEligibleForWithdrawal } from './withdrawWorker.js';
import { getClientPool } from '../exchanges/clientPool.js';
import type { AppConfig, AssetConfig } from '../config/schema.js';
import { getExchangeAssets, getEnabledExchanges } from '../config/schema.js';
import type { PriceProvider } from './chunking.js';
import type { WithdrawalJob, ExchangeId } from './types.js';

const logger = createChildLogger('scheduler');

export interface SchedulerOptions {
  config: AppConfig;
  priceProvider?: PriceProvider;
}

export interface SchedulerEvents {
  withdrawalStarted: (job: WithdrawalJob) => void;
  withdrawalFailed: (exchange: ExchangeId, asset: string, error: string) => void;
  tick: () => void;
}

export class Scheduler extends EventEmitter {
  private config: AppConfig;
  private priceProvider?: PriceProvider;

  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private wakeRequested = false;

  constructor(options: SchedulerOptions) {
    super();
    this.config = options.config;
    this.priceProvider = options.priceProvider;
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
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    logger.info('Stopping scheduler');
    this.running = false;

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

    // If we have a pending tick, cancel it and run immediately
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
      setImmediate(() => this.tick());
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /**
   * Schedule the next tick
   */
  private scheduleTick(): void {
    if (!this.running) return;

    this.tickTimer = setTimeout(
      () => this.tick(),
      this.config.global.schedulerTickMs
    );
  }

  /**
   * Run one scheduler tick
   */
  private async tick(): Promise<void> {
    this.wakeRequested = false;
    this.emit('tick');

    try {
      // Check if enabled
      if (!isEnabled()) {
        logger.debug('Scheduler disabled, skipping tick');
        this.scheduleTick();
        return;
      }

      // Process all enabled exchanges
      const enabledExchanges = getEnabledExchanges(this.config);
      for (const exchange of enabledExchanges) {
        await this.processExchange(exchange);
      }
    } catch (error) {
      logger.error({ error }, 'Scheduler tick error');
    }

    // Schedule next tick
    this.scheduleTick();
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

    // Get all configured assets for this exchange sorted by priority
    const exchangeAssets = getExchangeAssets(this.config, exchange);
    const configuredAssets = Object.entries(exchangeAssets)
      .map(([asset, config]) => ({ asset, config }))
      .sort((a, b) => a.config.priority - b.config.priority);

    if (configuredAssets.length === 0) {
      return;
    }

    // Get current states for this exchange
    const states = new Map(
      getAllAssetStates(exchange).map((s) => [s.asset, s])
    );

    // Process assets in priority order
    let withdrawalsStarted = 0;
    const availableSlots = maxInflightWithdrawals - globalInflight;

    for (const { asset, config } of configuredAssets) {
      if (withdrawalsStarted >= availableSlots) {
        break;
      }

      const result = await this.tryWithdrawAsset(
        exchange,
        asset,
        config,
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
    asset: string,
    assetConfig: AssetConfig,
    states: Map<string, { pendingAmount: number }>,
    currentGlobalInflight: number
  ): Promise<'started' | 'skipped' | 'failed'> {
    const state = states.get(asset);
    const pendingAmount = state?.pendingAmount ?? 0;

    // Check threshold
    const meetsThreshold = await meetsSweepThreshold(
      asset,
      pendingAmount,
      assetConfig,
      this.priceProvider
    );

    if (!meetsThreshold) {
      return 'skipped';
    }

    // Check eligibility
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

    // Try withdrawal
    const result = await startWithdrawal(asset, assetConfig, {
      exchangeClient: selection.client,
      exchange,
      globalConfig: this.config.global,
      priceProvider: this.priceProvider,
    });

    // Record usage regardless of outcome
    pool.recordUsage(selection.keyId, 2); // Withdrawals cost more

    if (result.success && result.job) {
      this.emit('withdrawalStarted', result.job);
      return 'started';
    }

    if (result.skipped) {
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

/**
 * Create a simple price provider using the exchange client pool
 */
export function createPriceProvider(): PriceProvider {
  const cache = new Map<string, { price: number; timestamp: number }>();
  const CACHE_TTL_MS = 60000; // 1 minute

  return {
    async getUsdPrice(asset: string): Promise<number | null> {
      // Check cache
      const cached = cache.get(asset);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.price;
      }

      try {
        // Try Kraken first (most common)
        const pool = getClientPool('kraken');
        if (!pool.hasAvailableClients()) {
          return null;
        }

        const selection = pool.selectRoundRobin();
        if (!selection) {
          return null;
        }

        // Build pair name (e.g., XBTUSD, ETHUSD)
        const pair = `${asset}USD`;
        const ticker = await selection.client.getTicker([pair]);
        pool.recordUsage(selection.keyId, 1);

        // Try to find the price
        const key = Object.keys(ticker).find(
          (k) => k.includes(asset) && k.includes('USD')
        );

        if (key && ticker[key]?.c?.[0]) {
          const price = parseFloat(ticker[key].c[0]);
          cache.set(asset, { price, timestamp: Date.now() });
          return price;
        }

        return null;
      } catch (error) {
        logger.warn({ asset, error }, 'Failed to get USD price');
        return null;
      }
    },
  };
}

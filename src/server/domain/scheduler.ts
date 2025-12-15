import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import {
  getAllAssetStates,
  getInflightCount,
  isEnabled,
} from '../db/repositories.js';
import { meetsSweepThreshold } from './chunking.js';
import { startWithdrawal, isEligibleForWithdrawal } from './withdrawWorker.js';
import type { AppConfig, AssetConfig } from '../config/schema.js';
import type { KrakenRestClient } from '../kraken/restClient.js';
import type { PriceProvider } from './chunking.js';
import type { WithdrawalJob } from './types.js';

const logger = createChildLogger('scheduler');

export interface SchedulerOptions {
  config: AppConfig;
  krakenClient: KrakenRestClient;
  priceProvider?: PriceProvider;
}

export interface SchedulerEvents {
  withdrawalStarted: (job: WithdrawalJob) => void;
  withdrawalFailed: (asset: string, error: string) => void;
  tick: () => void;
}

export class Scheduler extends EventEmitter {
  private config: AppConfig;
  private krakenClient: KrakenRestClient;
  private priceProvider?: PriceProvider;

  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private wakeRequested = false;

  constructor(options: SchedulerOptions) {
    super();
    this.config = options.config;
    this.krakenClient = options.krakenClient;
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
   * Update Kraken client (e.g., after API key change)
   */
  updateKrakenClient(client: KrakenRestClient): void {
    this.krakenClient = client;
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

      // Get eligible assets and try withdrawals
      await this.processEligibleAssets();
    } catch (error) {
      logger.error({ error }, 'Scheduler tick error');
    }

    // Schedule next tick
    this.scheduleTick();
  }

  /**
   * Find and process eligible assets for withdrawal
   */
  private async processEligibleAssets(): Promise<void> {
    const globalInflight = getInflightCount();
    const { maxInflightWithdrawals } = this.config.global;

    // Check global limit
    if (globalInflight >= maxInflightWithdrawals) {
      logger.debug(
        { globalInflight, max: maxInflightWithdrawals },
        'At global inflight limit'
      );
      return;
    }

    // Get all configured assets sorted by priority
    const configuredAssets = Object.entries(this.config.assets)
      .map(([asset, config]) => ({ asset, config }))
      .sort((a, b) => a.config.priority - b.config.priority);

    // Get current states
    const states = new Map(
      getAllAssetStates().map((s) => [s.asset, s])
    );

    // Process assets in priority order
    let withdrawalsStarted = 0;
    const availableSlots = maxInflightWithdrawals - globalInflight;

    for (const { asset, config } of configuredAssets) {
      if (withdrawalsStarted >= availableSlots) {
        break;
      }

      const result = await this.tryWithdrawAsset(asset, config, states, globalInflight + withdrawalsStarted);

      if (result === 'started') {
        withdrawalsStarted++;
      }
    }

    if (withdrawalsStarted > 0) {
      logger.info({ count: withdrawalsStarted }, 'Started withdrawals this tick');
    }
  }

  /**
   * Try to start a withdrawal for a specific asset
   */
  private async tryWithdrawAsset(
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
    const assetInflight = getInflightCount(asset);
    const eligibility = isEligibleForWithdrawal(
      asset,
      assetConfig,
      this.config.global,
      assetInflight,
      currentGlobalInflight
    );

    if (!eligibility.eligible) {
      logger.debug({ asset, reason: eligibility.reason }, 'Asset not eligible');
      return 'skipped';
    }

    // Try withdrawal
    const result = await startWithdrawal(asset, assetConfig, {
      krakenClient: this.krakenClient,
      globalConfig: this.config.global,
      priceProvider: this.priceProvider,
    });

    if (result.success && result.job) {
      this.emit('withdrawalStarted', result.job);
      return 'started';
    }

    if (result.skipped) {
      logger.debug({ asset, reason: result.skipReason }, 'Withdrawal skipped');
      return 'skipped';
    }

    if (result.error) {
      this.emit('withdrawalFailed', asset, result.error);
      return 'failed';
    }

    return 'skipped';
  }
}

/**
 * Create a simple price provider using the Kraken client
 */
export function createPriceProvider(krakenClient: KrakenRestClient): PriceProvider {
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
        // Build pair name (e.g., XBTUSD, ETHUSD)
        const pair = `${asset}USD`;
        const ticker = await krakenClient.getTicker([pair]);

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

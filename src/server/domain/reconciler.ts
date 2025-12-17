import { createChildLogger } from '../utils/logger.js';
import {
  getFillEventExists,
  saveFillEvent,
  addPendingAmount,
  getAssetState,
  setPendingAmount,
  getAppStateValue,
  setAppStateValue,
  getAllAssetConfigs,
} from '../db/repositories.js';
import type { ExchangeRestClient, TradeHistoryRecord } from '../exchanges/types.js';
import type { ExchangeId, FillEvent } from './types.js';
import { parsePair, normalizeAsset } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { getAssetConfig } from '../db/repositories.js';

const logger = createChildLogger('reconciler');

// How far back to look for trades on reconciliation (24 hours)
const TRADE_HISTORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// Minimum time between balance reconciliations (5 minutes)
const BALANCE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export interface ReconcilerOptions {
  config: AppConfig;
  onPendingUpdated?: (exchange: ExchangeId, asset: string, amount: number) => void;
}

export class Reconciler {
  private config: AppConfig;
  private readonly onPendingUpdated?: (exchange: ExchangeId, asset: string, amount: number) => void;

  constructor(options: ReconcilerOptions) {
    this.config = options.config;
    this.onPendingUpdated = options.onPendingUpdated;
  }

  /**
   * Sync trade history from exchange REST API
   * Processes any trades that weren't captured via WebSocket
   * Returns count of newly processed trades
   */
  async syncTradeHistory(
    exchange: ExchangeId,
    client: ExchangeRestClient
  ): Promise<{ processed: number; skipped: number }> {
    if (!client.getTradesHistory) {
      logger.debug({ exchange }, 'Exchange does not support trade history API');
      return { processed: 0, skipped: 0 };
    }

    // Get last sync timestamp
    const lastSyncKey = `reconcile_trades_${exchange}`;
    const lastSync = getAppStateValue(lastSyncKey);
    const lastSyncTime = lastSync ? parseInt(lastSync, 10) : Date.now() - TRADE_HISTORY_LOOKBACK_MS;

    logger.info(
      { exchange, since: new Date(lastSyncTime).toISOString() },
      'Syncing trade history'
    );

    try {
      const trades = await client.getTradesHistory({
        start: lastSyncTime,
      });

      let processed = 0;
      let skipped = 0;

      for (const trade of trades) {
        // Check if we already processed this trade
        if (getFillEventExists(trade.tradeId, exchange)) {
          skipped++;
          continue;
        }

        // Convert to FillEvent format and process
        const fill: FillEvent = {
          tradeId: trade.tradeId,
          orderId: trade.orderId,
          pair: trade.pair,
          side: trade.side,
          orderType: trade.orderType,
          price: trade.price,
          volume: trade.volume,
          cost: trade.cost,
          fee: trade.fee,
          feeCurrency: trade.feeCurrency,
          timestamp: trade.timestamp,
        };

        const result = this.processFillFromHistory(exchange, fill);
        if (result) {
          processed++;
          logger.info(
            { exchange, tradeId: trade.tradeId, asset: result.asset, amount: result.amount },
            'Processed missed trade from history'
          );
        }
      }

      // Update last sync time
      setAppStateValue(lastSyncKey, Date.now().toString());

      logger.info(
        { exchange, processed, skipped, total: trades.length },
        'Trade history sync complete'
      );

      return { processed, skipped };
    } catch (error) {
      logger.error(
        { exchange, error: error instanceof Error ? error.message : 'Unknown error' },
        'Failed to sync trade history'
      );
      return { processed: 0, skipped: 0 };
    }
  }

  /**
   * Process a fill from trade history (similar to FillProcessor but for historical trades)
   */
  private processFillFromHistory(
    exchange: ExchangeId,
    fill: FillEvent
  ): { asset: string; amount: number } | null {
    // Check allowed order types
    const allowed = this.config.global.allowedOrderTypes;
    if (!allowed.includes(fill.orderType.toLowerCase())) {
      // Still save for audit
      const received = this.computeReceivedAsset(fill);
      if (received) {
        saveFillEvent(exchange, fill, received.asset, received.amount);
      }
      return null;
    }

    // Compute received asset
    const received = this.computeReceivedAsset(fill);
    if (!received) {
      return null;
    }

    // Check if asset is configured for sweeping
    const assetConfig = getAssetConfig(exchange, received.asset);
    if (!assetConfig || !assetConfig.enabled) {
      // Still save for audit
      saveFillEvent(exchange, fill, received.asset, received.amount);
      return null;
    }

    // Save and update pending
    saveFillEvent(exchange, fill, received.asset, received.amount);
    addPendingAmount(exchange, received.asset, received.amount);

    // Notify scheduler
    if (this.onPendingUpdated) {
      this.onPendingUpdated(exchange, received.asset, received.amount);
    }

    return received;
  }

  /**
   * Compute what asset was received from a fill
   */
  private computeReceivedAsset(fill: FillEvent): { asset: string; amount: number } | null {
    const { base, quote } = parsePair(fill.pair);

    let receivedAsset: string;
    let receivedAmount: number;

    if (fill.side === 'buy') {
      receivedAsset = base;
      receivedAmount = fill.volume;
      if (normalizeAsset(fill.feeCurrency) === receivedAsset) {
        receivedAmount -= fill.fee;
      }
    } else {
      receivedAsset = quote;
      receivedAmount = fill.cost;
      if (normalizeAsset(fill.feeCurrency) === receivedAsset) {
        receivedAmount -= fill.fee;
      }
    }

    if (receivedAmount <= 0) {
      return null;
    }

    return { asset: receivedAsset, amount: receivedAmount };
  }

  /**
   * Reconcile pending amounts with actual exchange balances
   * Adjusts pending_amount down if actual balance is lower (e.g., manual withdrawal)
   */
  async reconcileBalances(
    exchange: ExchangeId,
    client: ExchangeRestClient
  ): Promise<{ adjusted: string[]; unchanged: string[] }> {
    // Check if enough time has passed since last reconciliation
    const lastReconcileKey = `reconcile_balance_${exchange}`;
    const lastReconcile = getAppStateValue(lastReconcileKey);
    const lastReconcileTime = lastReconcile ? parseInt(lastReconcile, 10) : 0;

    if (Date.now() - lastReconcileTime < BALANCE_RECONCILE_INTERVAL_MS) {
      logger.debug({ exchange }, 'Skipping balance reconciliation (too soon)');
      return { adjusted: [], unchanged: [] };
    }

    logger.info({ exchange }, 'Reconciling balances');

    try {
      // Get actual balances from exchange
      const balances = await client.getBalance();

      // Get configured assets for this exchange
      const assetConfigs = getAllAssetConfigs(exchange);
      const adjusted: string[] = [];
      const unchanged: string[] = [];

      for (const config of assetConfigs) {
        const asset = config.asset;
        const state = getAssetState(exchange, asset);
        const pendingAmount = state?.pendingAmount ?? 0;

        // Get actual balance (parse from string, default to 0)
        const actualBalanceStr = balances[asset] || '0';
        const actualBalance = parseFloat(actualBalanceStr);

        // If pending amount is greater than actual balance, adjust down
        // This catches manual withdrawals by the user
        if (pendingAmount > actualBalance && actualBalance >= 0) {
          const oldPending = pendingAmount;
          const newPending = Math.max(0, actualBalance);

          setPendingAmount(exchange, asset, newPending);
          adjusted.push(asset);

          logger.warn(
            {
              exchange,
              asset,
              oldPending,
              newPending,
              actualBalance,
              difference: oldPending - newPending,
            },
            'Adjusted pending amount down (possible manual withdrawal detected)'
          );

          // Notify scheduler of the change
          if (this.onPendingUpdated) {
            this.onPendingUpdated(exchange, asset, newPending);
          }
        } else {
          unchanged.push(asset);
        }
      }

      // Update last reconcile time
      setAppStateValue(lastReconcileKey, Date.now().toString());

      logger.info(
        { exchange, adjusted: adjusted.length, unchanged: unchanged.length },
        'Balance reconciliation complete'
      );

      return { adjusted, unchanged };
    } catch (error) {
      logger.error(
        { exchange, error: error instanceof Error ? error.message : 'Unknown error' },
        'Failed to reconcile balances'
      );
      return { adjusted: [], unchanged: [] };
    }
  }

  /**
   * Run full reconciliation (trade history + balance check)
   */
  async runFullReconciliation(
    exchange: ExchangeId,
    client: ExchangeRestClient
  ): Promise<void> {
    logger.info({ exchange }, 'Running full reconciliation');

    // First sync trade history to catch missed fills
    await this.syncTradeHistory(exchange, client);

    // Then reconcile balances to catch manual withdrawals
    await this.reconcileBalances(exchange, client);
  }

  /**
   * Update config (e.g., after reload)
   */
  updateConfig(newConfig: AppConfig): void {
    this.config = newConfig;
  }
}

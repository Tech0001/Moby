import { createChildLogger } from '../utils/logger.js';
import {
  addPendingAmount,
  saveFillEvent,
  getFillEventExists,
  getAppStateValue,
  getAssetConfig,
} from '../db/repositories.js';
import type { FillEvent, ReceivedAsset, ExchangeId } from './types.js';
import { parsePair, normalizeAsset } from './types.js';
import type { AppConfig } from '../config/schema.js';

const logger = createChildLogger('fill-processor');

export interface FillProcessorOptions {
  config: AppConfig;
  onPendingUpdated?: (exchange: ExchangeId, asset: string, amount: number) => void;
}

export class FillProcessor {
  private config: AppConfig;
  private readonly onPendingUpdated?: (exchange: ExchangeId, asset: string, amount: number) => void;

  constructor(options: FillProcessorOptions) {
    this.config = options.config;
    this.onPendingUpdated = options.onPendingUpdated;
  }

  /**
   * Process a fill event from WebSocket
   * Returns the received asset info if processed, null if skipped
   */
  processFill(exchange: ExchangeId, fill: FillEvent): ReceivedAsset | null {
    // Check if we've already processed this trade (idempotency)
    if (getFillEventExists(fill.tradeId, exchange)) {
      logger.debug({ exchange, tradeId: fill.tradeId }, 'Fill already processed, skipping');
      return null;
    }

    // Check if order type is allowed
    if (!this.isAllowedOrderType(fill.orderType)) {
      // Save for audit even if we don't act on it
      const received = this.computeReceivedAsset(fill);
      if (received) {
        saveFillEvent(exchange, fill, received.asset, received.amount);
      }
      logger.debug({ exchange, tradeId: fill.tradeId, orderType: fill.orderType }, 'Order type not in allowlist');
      return null;
    }

    // Determine what asset was received
    const received = this.computeReceivedAsset(fill);

    if (!received) {
      logger.warn({ exchange, fill }, 'Could not determine received asset');
      return null;
    }

    // Check if we're configured to sweep this asset for this exchange
    const assetConfig = getAssetConfig(exchange, received.asset);
    if (!assetConfig || !assetConfig.enabled) {
      logger.debug(
        { exchange, asset: received.asset },
        'Asset not configured for sweeping, skipping'
      );
      // Still save the fill event for audit
      saveFillEvent(exchange, fill, received.asset, received.amount);
      return null;
    }

    // Save fill event and update pending amount
    saveFillEvent(exchange, fill, received.asset, received.amount);
    addPendingAmount(exchange, received.asset, received.amount);

    logger.info(
      {
        exchange,
        tradeId: fill.tradeId,
        asset: received.asset,
        amount: received.amount,
        side: fill.side,
        pair: fill.pair,
      },
      'Fill processed, pending amount updated'
    );

    // Notify scheduler
    if (this.onPendingUpdated) {
      this.onPendingUpdated(exchange, received.asset, received.amount);
    }

    return received;
  }

  /**
   * Check if order type is in the allowed list
   */
  private isAllowedOrderType(orderType: string): boolean {
    const allowed = this.config.global.allowedOrderTypes;
    return allowed.includes(orderType.toLowerCase());
  }

  /**
   * Compute what asset was received from a fill
   * BUY: receive base asset
   * SELL: receive quote asset
   */
  private computeReceivedAsset(fill: FillEvent): ReceivedAsset | null {
    const { base, quote } = parsePair(fill.pair);

    let receivedAsset: string;
    let receivedAmount: number;

    if (fill.side === 'buy') {
      // Bought base asset, received volume minus any fee if fee is in base
      receivedAsset = base;
      receivedAmount = fill.volume;

      // Deduct fee if it's in the received asset
      if (normalizeAsset(fill.feeCurrency) === receivedAsset) {
        receivedAmount -= fill.fee;
      }
    } else {
      // Sold base asset, received quote (cost) minus any fee if fee is in quote
      receivedAsset = quote;
      receivedAmount = fill.cost;

      // Deduct fee if it's in the received asset
      if (normalizeAsset(fill.feeCurrency) === receivedAsset) {
        receivedAmount -= fill.fee;
      }
    }

    // Sanity check
    if (receivedAmount <= 0) {
      logger.warn(
        { fill, receivedAsset, receivedAmount },
        'Computed received amount is <= 0'
      );
      return null;
    }

    return {
      asset: receivedAsset,
      amount: receivedAmount,
      fromFill: fill,
    };
  }

  /**
   * Update config (e.g., after reload)
   */
  updateConfig(newConfig: AppConfig): void {
    this.config = newConfig;
  }
}

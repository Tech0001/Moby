import { createChildLogger } from '../utils/logger.js';
import {
  accountFill,
  getFillEventExists,
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
    if (!fill.tradeId || !fill.orderId || !['buy', 'sell'].includes(fill.side) ||
        ![fill.price, fill.volume, fill.cost, fill.fee, fill.timestamp].every(n => Number.isFinite(n) && n >= 0) || fill.volume <= 0) return null;
    // Check if we've already processed this trade (idempotency)
    if (getFillEventExists(fill.tradeId, exchange)) {
      logger.debug({ exchange, tradeId: fill.tradeId }, 'Fill already processed, skipping');
      return null;
    }

    const received = this.computeReceivedAsset(fill);
    if (!received) return null;
    const { base, quote } = parsePair(fill.pair);
    const spent = [{ asset: fill.side === 'sell' ? base : quote, amount: fill.side === 'sell' ? fill.volume : fill.cost }];
    const feeAsset = normalizeAsset(fill.feeCurrency);
    if (fill.fee > 0 && feeAsset !== received.asset) spent.push({ asset: feeAsset, amount: fill.fee });
    const credit = this.isAllowedOrderType(fill.orderType) && !!getAssetConfig(exchange, received.asset)?.enabled;
    // All trades spend assets, even when their proceeds are not configured for
    // sweeping or their order type is excluded. Deduplicate both sides together.
    if (!accountFill(exchange, fill, received, credit, spent)) return null;
    if (!credit) return null;

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
    return allowed.map(type => type.toLowerCase().replaceAll('_', '-')).includes(orderType.toLowerCase().replaceAll('_', '-'));
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

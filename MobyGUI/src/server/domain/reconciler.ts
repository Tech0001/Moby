import { createChildLogger } from '../utils/logger.js';
import { checkBalances } from './balanceGuard.js';
import { FillProcessor } from './fillProcessor.js';
import type { ExchangeRestClient } from '../exchanges/types.js';
import type { ExchangeId } from './types.js';
import type { AppConfig } from '../config/schema.js';

const logger = createChildLogger('reconciler');
export interface ReconcilerOptions {
  config: AppConfig;
  onPendingUpdated?: (exchange: ExchangeId, asset: string, amount: number) => void;
}
export class Reconciler {
  readonly monitoringSince = Date.now();
  readonly health = new Map<ExchangeId, { lastSuccessAt: number | null; error: string | null }>();
  private processor: FillProcessor;
  private cursor = new Map<ExchangeId, number>();
  private syncing = new Map<ExchangeId, Promise<{ processed: number; skipped: number }>>();
  private stopped = false;
  constructor(options: ReconcilerOptions) { this.processor = new FillProcessor(options); }
  updateConfig(config: AppConfig): void { this.processor.updateConfig(config); }
  stop(): void { this.stopped = true; }
  syncTradeHistory(exchange: ExchangeId, client: ExchangeRestClient): Promise<{ processed: number; skipped: number }> {
    const current = this.syncing.get(exchange);
    if (current) return current;
    const task = this.sync(exchange, client).finally(() => this.syncing.delete(exchange));
    this.syncing.set(exchange, task);
    return task;
  }
  private async sync(exchange: ExchangeId, client: ExchangeRestClient) {
    if (this.stopped || !client.getTradesHistory) return { processed: 0, skipped: 0 };
    const end = Date.now(), start = Math.max(this.monitoringSince, (this.cursor.get(exchange) ?? this.monitoringSince) - 60000);
    try {
      const trades = await client.getTradesHistory({ start, end });
      let processed = 0, skipped = 0;
      for (const trade of trades.sort((a, b) => a.timestamp - b.timestamp || a.tradeId.localeCompare(b.tradeId))) {
        if (this.stopped) return { processed, skipped };
        if (trade.timestamp < this.monitoringSince || trade.timestamp > end) { skipped++; continue; }
        if (this.processor.processFill(exchange, trade)) processed++; else skipped++;
      }
      if (!this.stopped) {
        this.cursor.set(exchange, end);
        this.health.set(exchange, { lastSuccessAt: Date.now(), error: null });
      }
      return { processed, skipped };
    } catch (error) {
      if (!this.stopped) this.health.set(exchange, { lastSuccessAt: this.health.get(exchange)?.lastSuccessAt ?? null,
        error: error instanceof Error ? error.message : 'Trade history sync failed' });
      throw error;
    }
  }
  async reconcileBalances(exchange: ExchangeId, client: ExchangeRestClient) {
    if (this.stopped) throw new Error('Monitoring stopped');
    const result = await checkBalances(exchange, client, () => !this.stopped);
    if (result.adjusted.length) logger.warn({ exchange, assets: result.adjusted }, 'Pending reduced to confirmed balances');
    return result;
  }
  async runFullReconciliation(exchange: ExchangeId, client: ExchangeRestClient) {
    const trades = await this.syncTradeHistory(exchange, client);
    const balances = await this.reconcileBalances(exchange, client);
    return { trades, balances };
  }
}

import { vi } from 'vitest';
import { AppConfigSchema } from '../src/server/config/schema.js';
import type { KrakenClient } from '../src/server/exchanges/kraken/restClient.js';

export function config() {
  return AppConfigSchema.parse({
    global: { maxInflightWithdrawals: 1, perAssetMaxInflight: 1, schedulerTickMs: 100, backoffSeconds: [1] },
    polling: { withdrawStatus: { fastSeconds: 1, mediumSeconds: 1, slowSeconds: 1 } },
    assets: { BTC: { priority: 1, method: 'Bitcoin', walletKeys: ['cold', 'cold2'], sweepThresholdCoin: 0.1,
      cooldownSeconds: 0, chunk: { mode: 'fixedCoin', amount: 1 } } },
  });
}
export function client() {
  return {
    getWithdrawInfo: vi.fn(async (_asset: string, _key: string, amount: number) => ({ method: 'Bitcoin', amount: amount - 0.001, fee: 0.001, limit: 100 })),
    withdraw: vi.fn(async () => ({ refid: 'ref-1' })),
    getWithdrawStatus: vi.fn<KrakenClient['getWithdrawStatus']>(async () => []),
    getTradesHistory: vi.fn<KrakenClient['getTradesHistory']>(async () => ({ trades: {}, count: 0 })),
    getTicker: vi.fn<KrakenClient['getTicker']>(async () => ({ XXBTZUSD: { c: ['100000', '1'] } })),
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const trade = (time = Date.now() / 1000) => ({
  ordertxid: 'order1', pair: 'XBT/USD', type: 'buy', ordertype: 'limit', price: '60000',
  vol: '1', cost: '60000', fee: '2', time,
});
export const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

import { it, expect, afterEach, vi } from 'vitest';
import { KrakenAdapterFactory } from '../src/server/exchanges/kraken/factory.js';
import { GeminiAdapterFactory } from '../src/server/exchanges/gemini/factory.js';
import { KuCoinAdapterFactory } from '../src/server/exchanges/kucoin/factory.js';
import { GateAdapterFactory } from '../src/server/exchanges/gateio/factory.js';
import { validateBalances } from '../src/server/exchanges/balances.js';
const options = { apiKey: 'fake', apiSecret: 'ZmFrZQ==', passphrase: 'fake' };
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });
it('normalizes Kraken assets and refuses malformed snapshots before interpreting missing assets', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ error: [], result: { XXBT: '2', ZUSD: '0' } })));
  expect(await KrakenAdapterFactory.createRestClient(options).getBalance({ includeHeld: true })).toEqual({ BTC: '2', USD: '0' });
  vi.stubGlobal('fetch', vi.fn(async () => reply({ error: [], result: [] })));
  await expect(KrakenAdapterFactory.createRestClient(options).getBalance()).rejects.toThrow('Invalid account balance');
});
it('retains Gemini funds held in open orders for queue reconciliation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply([{ currency: 'BTC', amount: '3', available: '0', availableForWithdrawal: '0' }])));
  const c = GeminiAdapterFactory.createRestClient(options);
  expect(await c.getBalance()).toEqual({ BTC: '0' }); expect(await c.getBalance({ includeHeld: true })).toEqual({ BTC: '3' });
});
it('sums KuCoin total balances across spot accounts without losing held funds', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ code: '200000', data: [
    { currency: 'BTC', type: 'main', balance: '1', available: '1', holds: '0' },
    { currency: 'BTC', type: 'trade', balance: '2', available: '0', holds: '2' },
  ] })));
  const c = KuCoinAdapterFactory.createRestClient(options);
  expect(await c.getBalance()).toEqual({ BTC: '1' }); expect(await c.getBalance({ includeHeld: true })).toEqual({ BTC: '3' });
});
it('retains Gate locked funds and rejects invalid numeric fields instead of omitting the asset', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply([{ currency: 'BTC', available: '0', locked: '3' }])));
  const c = GateAdapterFactory.createRestClient(options);
  expect(await c.getBalance()).toEqual({ BTC: '0' }); expect(await c.getBalance({ includeHeld: true })).toEqual({ BTC: '3' });
  vi.stubGlobal('fetch', vi.fn(async () => reply([{ currency: 'BTC', available: 'garbage', locked: '3' }])));
  await expect(c.getBalance({ includeHeld: true })).rejects.toThrow('invalid balance response');
});
it('accepts normalized dust amounts but rejects partial numeric strings', () => {
  expect(() => validateBalances({ BTC: '1e-8' })).not.toThrow();
  expect(() => validateBalances({ BTC: '1 coin' })).toThrow();
});

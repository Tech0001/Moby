import { it, expect, afterEach, vi } from 'vitest';
import { KrakenRestClient, KrakenApiError } from '../src/server/exchanges/kraken/restClient.js';
import { RateLimiter } from '../src/server/exchanges/kraken/rateLimiter.js';
import { deferred } from './helpers.js';
const makeClient = () => new KrakenRestClient({ apiKey: 'fake', apiSecret: 'ZmFrZQ==', rateLimiter: new RateLimiter({ maxTokens: 100 }) });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('paginates withdrawal history beyond the first page', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: [], result: { withdrawals: [{ refid: 'new' }], cursor: 'page2' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: [], result: { withdrawals: [{ refid: 'old-held' }], cursor: '' } })));
  vi.stubGlobal('fetch', fetch);
  expect((await makeClient().getWithdrawStatus()).map(s => s.refid)).toEqual(['new', 'old-held']);
  expect(new URLSearchParams(fetch.mock.calls[1][1].body).get('cursor')).toBe('page2');
});
it('preserves the quoted fee ceiling and formats amounts as decimal strings', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: [], result: { refid: 'ok' } })));
  vi.stubGlobal('fetch', fetch); await makeClient().withdraw('BTC', 'cold', 0.001, 0.000001);
  const body = new URLSearchParams((fetch.mock.calls[0] as any)[1].body);
  expect(body.get('amount')).toBe('0.00100000'); expect(body.get('max_fee')).toBe('0.00000100');
});
it('checks the stop condition after waiting in the request queue', async () => {
  const reply = deferred<Response>();
  const fetch = vi.fn().mockImplementationOnce(() => reply.promise);
  vi.stubGlobal('fetch', fetch);
  const c = makeClient(); let enabled = true;
  const first = c.getBalance();
  const withdrawal = c.withdraw('BTC', 'cold', 1, 0.001, () => enabled);
  enabled = false;
  reply.resolve(new Response(JSON.stringify({ error: [], result: {} })));
  await first; await expect(withdrawal).rejects.toBeInstanceOf(KrakenApiError);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not let concurrent rate limiter waiters overspend tokens', async () => {
  vi.useFakeTimers(); const r = new RateLimiter({ maxTokens: 1, refillRate: 1 });
  await r.waitForToken(); let completed = 0;
  const a = r.waitForToken().then(() => completed++), b = r.waitForToken().then(() => completed++);
  await vi.advanceTimersByTimeAsync(1000); expect(completed).toBe(1); expect(r.getTokens()).toBeGreaterThanOrEqual(0);
  await vi.advanceTimersByTimeAsync(1000); await Promise.all([a, b]); expect(completed).toBe(2);
});

import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../src/server/db/sqlite.js';
import * as repo from '../src/server/db/repositories.js';
import { startWithdrawal } from '../src/server/domain/withdrawWorker.js';
import { StatusPoller } from '../src/server/domain/statusPoller.js';
import { Scheduler } from '../src/server/domain/scheduler.js';
import { FillProcessor } from '../src/server/domain/fillProcessor.js';
import { Reconciler } from '../src/server/domain/reconciler.js';
import { AppConfigSchema } from '../src/server/config/schema.js';
import { KrakenApiError } from '../src/server/exchanges/kraken/restClient.js';
import { KrakenAdapterFactory } from '../src/server/exchanges/kraken/factory.js';
import { registerExchange, hasExchange } from '../src/server/exchanges/registry.js';
import { getClientPool, resetPoolManager } from '../src/server/exchanges/clientPool.js';
import type { ExchangeRestClient } from '../src/server/exchanges/types.js';
import { deferred, flush } from './helpers.js';

const config = () => AppConfigSchema.parse({ global: { maxInflightWithdrawals: 1, perAssetMaxInflight: 1, schedulerTickMs: 100, backoffSeconds: [1, 2, 4] },
  polling: { withdrawStatus: { fastSeconds: 1, mediumSeconds: 1, slowSeconds: 1 } } });
function client() {
  return { exchangeId: 'kraken', getBalance: vi.fn(async () => ({ BTC: '10' })),
    getWithdrawInfo: vi.fn(async (_a: string, _k: string, amount: number) => ({ amount: amount - 0.001, fee: 0.001, method: 'Bitcoin', limit: 100 })),
    withdraw: vi.fn(async () => ({ refId: 'ref1' })), getWithdrawStatus: vi.fn(async () => []),
    getWithdrawAddresses: vi.fn(async () => []), getOpenOrders: vi.fn(async () => ({ open: {} })),
    getTradesHistory: vi.fn(async () => []), getTicker: vi.fn(async () => ({ XXBTZUSD: { c: ['100000', '1'] } })),
    testConnection: vi.fn(async () => ({ success: true, hasBalance: true, hasWithdraw: true })) } as unknown as ExchangeRestClient;
}
function asset(overrides = {}) {
  repo.upsertAssetConfig('kraken', 'BTC', { enabled: true, threshold: 0.01, reserve: 0, destKeys: ['cold', 'cold2'],
    cooldownSeconds: 0, method: 'Bitcoin', chunkAmount: 1, ...overrides });
  return repo.getAssetConfig('kraken', 'BTC')!;
}
const submit = (c = client(), a = repo.getAssetConfig('kraken', 'BTC')!, cfg = config()) => startWithdrawal('BTC', a, { exchange: 'kraken', exchangeClient: c, globalConfig: cfg.global });
beforeEach(() => {
  process.env.MOBY_ENCRYPTION_KEY = 'a'.repeat(64); vi.useFakeTimers(); initDb(); resetPoolManager();
  if (!hasExchange('kraken')) registerExchange(KrakenAdapterFactory); repo.setEnabled(true); repo.addPendingAmount('kraken', 'BTC', 3); asset();
  repo.upsertExchangeAddress('kraken', 'BTC', 'Bitcoin', 'cold', 'wallet1'); repo.upsertExchangeAddress('kraken', 'BTC', 'Bitcoin', 'cold2', 'wallet2');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); closeDb(); resetPoolManager(); });
it('atomically reserves a job before sending and prevents overlapping submissions', async () => {
  const c = client(), reply = deferred<{ refId: string }>(); vi.mocked(c.withdraw).mockImplementation(() => reply.promise);
  const first = submit(c); await flush();
  expect(repo.getActiveWithdrawalJobs()).toHaveLength(1); expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(2);
  expect((await submit(c)).skipped).toBe(true); reply.resolve({ refId: 'ref1' }); await first;
  expect(c.withdraw).toHaveBeenCalledTimes(1);
});
it('retains the reservation after a lost response and quarantines interrupted submissions', async () => {
  const c = client(); vi.mocked(c.withdraw).mockRejectedValueOnce(new Error('connection reset'));
  await submit(c); const job = repo.getActiveWithdrawalJobs()[0]; expect(job.status).toBe('unknown');
  await vi.advanceTimersByTimeAsync(5000); expect((await submit(c)).skipped).toBe(true);
  repo.updateWithdrawalJob(job.id, { status: 'submitted' }); repo.recoverInterruptedWithdrawals();
  expect(repo.getWithdrawalJob(job.id)?.status).toBe('unknown'); expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(2);
});
it('releases definite rejections once and retains escalating backoff across failures', async () => {
  const c = client(); vi.mocked(c.withdraw).mockRejectedValue(new KrakenApiError(['EFunding:Invalid amount']));
  const first = await submit(c); expect(repo.releaseWithdrawal(first.job!.id, 'failed')).toBe(false);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3);
  await vi.advanceTimersByTimeAsync(1100); await submit(c);
  expect(repo.getAssetState('kraken', 'BTC')?.consecutiveFailures).toBe(2);
});
it('never submits in dry-run mode, after stop, or after configuration changes during preparation', async () => {
  const c = client(), cfg = config(); cfg.global.dryRun = true;
  expect((await submit(c, asset(), cfg)).skipped).toBe(true); expect(c.withdraw).not.toHaveBeenCalled();
  const quote = deferred<any>(); vi.mocked(c.getWithdrawInfo).mockImplementation(() => quote.promise);
  const pending = submit(c); await flush(); repo.setEnabled(false);
  quote.resolve({ amount: 0.999, fee: 0.001, limit: 100, method: 'Bitcoin' });
  expect((await pending).skipped).toBe(true); expect(repo.getInflightCount()).toBe(0);
});
it('enforces cumulative caps, uses the next wallet, and fails closed without a USD price', async () => {
  const c = client(), old = repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 1); repo.updateWithdrawalJob(old.id, { status: 'complete' });
  await submit(c, asset({ perWalletCapCoin: 1 }));
  expect(c.withdraw).toHaveBeenCalledWith('BTC', 'cold2', 'wallet2', 1, expect.objectContaining({ maxFee: 0.001 }));
  repo.updateWithdrawalJob(repo.getActiveWithdrawalJobs()[0].id, { status: 'complete' });
  expect((await submit(c)).skipped).toBe(true);
  vi.mocked(c.getTicker).mockRejectedValue(new Error('offline'));
  expect((await submit(c, asset({ perWalletCapUsd: 50 }))).skipped).toBe(true);
});
it('rejects network mismatch and floors chunks without enlarging dust', async () => {
  const c = client(); vi.mocked(c.getWithdrawInfo).mockResolvedValue({ amount: 1, fee: 0.001, method: 'Lightning', limit: 100 });
  expect((await submit(c)).skipped).toBe(true); expect(c.withdraw).not.toHaveBeenCalled();
});
it('polls held jobs, does not overlap polls, and refunds cancellation only once', async () => {
  const c = client(); await submit(c); const job = repo.getActiveWithdrawalJobs()[0]; repo.updateWithdrawalJob(job.id, { status: 'held' });
  const pool = getClientPool('kraken'); vi.spyOn(pool, 'selectBestKey').mockReturnValue({ keyId: 'fake', client: c, estimatedCounter: 0, headroom: 10 });
  const reply = deferred<any>(); vi.mocked(c.getWithdrawStatus).mockImplementation(() => reply.promise);
  const poller = new StatusPoller({ pollingConfig: config().polling, enabledExchanges: ['kraken'] }); poller.start(); poller.pollNow(); poller.pollNow(); await flush();
  expect(c.getWithdrawStatus).toHaveBeenCalledTimes(1);
  reply.resolve([{ refId: 'ref1', status: 'cancelled', asset: 'BTC', amount: 1, fee: 0.001, timestamp: Date.now() }]); await flush();
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3); poller.pollNow(); await flush();
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3); poller.stop();
});
it('continues polling after starting with no jobs', async () => {
  const c = client(), pool = getClientPool('kraken'); vi.spyOn(pool, 'selectBestKey').mockReturnValue({ keyId: 'fake', client: c, estimatedCounter: 0, headroom: 10 });
  const poller = new StatusPoller({ pollingConfig: config().polling, enabledExchanges: ['kraken'] }); poller.start(); poller.pollNow(); await flush();
  await submit(c); poller.pollNow(); await flush(); expect(c.getWithdrawStatus).toHaveBeenCalledTimes(1); poller.stop();
});
it('does not start overlapping scheduler ticks when woken while preparing a withdrawal', async () => {
  repo.createApiKey('key1', 'kraken', 'test', 'key', 'c2VjcmV0'); const c = client(), quote = deferred<any>();
  vi.mocked(c.getWithdrawInfo).mockImplementation(() => quote.promise);
  vi.spyOn(getClientPool('kraken'), 'selectBestKey').mockReturnValue({ keyId: 'key1', client: c, estimatedCounter: 0, headroom: 10 });
  const scheduler = new Scheduler({ config: config() }); scheduler.start(); scheduler.wake(); await vi.advanceTimersByTimeAsync(1);
  scheduler.wake(); scheduler.wake(); await vi.advanceTimersByTimeAsync(1000); expect(c.getWithdrawInfo).toHaveBeenCalledTimes(1);
  scheduler.stop(); quote.resolve({ amount: 0.999, fee: 0.001, method: 'Bitcoin', limit: 100 }); await flush(); expect(c.withdraw).not.toHaveBeenCalled();
});
it('atomically deduplicates fills per exchange and rejects malformed numbers', () => {
  const processor = new FillProcessor({ config: config() }); repo.setPendingAmount('kraken', 'BTC', 0);
  const fill = { tradeId: 'same', orderId: 'order', pair: 'XXBTZUSD', side: 'buy' as const, orderType: 'market', price: 100,
    volume: 1, cost: 100, fee: 1, feeCurrency: 'USD', timestamp: Date.now() };
  processor.processFill('kraken', fill); processor.processFill('kraken', fill);
  repo.upsertAssetConfig('gemini', 'BTC', { threshold: 0.01, destKeys: ['cold'] }); processor.processFill('gemini', fill);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(1); expect(repo.getAssetState('gemini', 'BTC')?.pendingAmount).toBe(1);
  processor.processFill('kraken', { ...fill, tradeId: 'bad', volume: NaN }); expect(repo.getFillEventExists('bad')).toBe(false);
});
it('limits catch-up to this run and preserves the cursor when history fails', async () => {
  const c = client(), reconciler = new Reconciler({ config: config() });
  const fill = { tradeId: 'new', orderId: 'order', pair: 'BTC/USD', side: 'buy' as const, orderType: 'market', price: 100, volume: 1, cost: 100, fee: 1, feeCurrency: 'USD', timestamp: Date.now() };
  vi.mocked(c.getTradesHistory!).mockResolvedValue([fill, { ...fill, tradeId: 'old', timestamp: Date.now() - 1000 }]);
  await reconciler.syncTradeHistory('kraken', c); expect(repo.getFillEventExists('old')).toBe(false); expect(repo.getFillEventExists('new')).toBe(true);
  await vi.advanceTimersByTimeAsync(2000); vi.mocked(c.getTradesHistory!).mockRejectedValueOnce(new Error('offline'));
  await expect(reconciler.syncTradeHistory('kraken', c)).rejects.toThrow('offline'); expect(reconciler.health.get('kraken')?.error).toBe('offline'); reconciler.stop();
});
it('does not overwrite fills that arrive while fetching an account balance', async () => {
  const c = client(), reconciler = new Reconciler({ config: config() }), reply = deferred<Record<string, string>>();
  vi.mocked(c.getBalance).mockImplementation(() => reply.promise);
  const request = reconciler.reconcileBalances('kraken', c); await flush(); repo.addPendingAmount('kraken', 'BTC', 1);
  reply.resolve({ BTC: '1' }); await expect(request).rejects.toThrow('Account activity changed'); expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(4); reconciler.stop();
});
it('rechecks wallet caps atomically when multiple prepared submissions compete', () => {
  const cfg = asset({ perWalletCapCoin: 1, destKeys: ['cold'] });
  const first = repo.reserveWithdrawal('kraken', 'BTC', 'Bitcoin', 'cold', 1, cfg, { global: 3, perAsset: 3 });
  const second = repo.reserveWithdrawal('kraken', 'BTC', 'Bitcoin', 'cold', 1, cfg, { global: 3, perAsset: 3 });
  expect(first).not.toBeNull(); expect(second).toBeNull(); expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(2);
});

it('retires a sold-out or manually withdrawn asset before requesting a withdrawal quote', async () => {
  const c = client(); vi.mocked(c.getBalance).mockResolvedValue({ USD: '100' });
  const result = await submit(c);
  expect(result.skipped).toBe(true); expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(0);
  expect(c.getWithdrawInfo).not.toHaveBeenCalled(); expect(c.withdraw).not.toHaveBeenCalled();
  vi.mocked(c.getBalance).mockResolvedValue({ BTC: '10' }); await submit(c);
  expect(c.withdraw).not.toHaveBeenCalled(); // A later deposit cannot resurrect the retired queue.
});
it('reduces pending to the remaining balance and preserves the configured reserve', async () => {
  const c = client(); vi.mocked(c.getBalance).mockResolvedValue({ BTC: '0.5' });
  await submit(c, asset({ reserve: 0.1 }));
  expect(c.withdraw).toHaveBeenCalledWith('BTC', 'cold', 'wallet1', 0.4, expect.anything());
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBeCloseTo(0.1);
});
it.each([null, [], { BTC: '' }, { BTC: 'invalid' }, { BTC: 'Infinity' }, { BTC: 0 }])('blocks an invalid balance response without erasing pending: %j', async response => {
  const c = client(); vi.mocked(c.getBalance).mockResolvedValue(response as any);
  expect((await submit(c)).skipped).toBe(true);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3); expect(c.withdraw).not.toHaveBeenCalled();
});
it('blocks when the balance endpoint is offline without recording a withdrawal failure', async () => {
  const c = client(); vi.mocked(c.getBalance).mockRejectedValue(new Error('Balance permission denied'));
  expect((await submit(c)).skipReason).toContain('Balance permission denied');
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3);
  expect(repo.getAssetState('kraken', 'BTC')?.consecutiveFailures).toBe(0); expect(c.withdraw).not.toHaveBeenCalled();
});
it('checks funds again after quoting and blocks a manual withdrawal during preparation', async () => {
  const c = client(); vi.mocked(c.getBalance).mockResolvedValueOnce({ BTC: '3' }).mockResolvedValueOnce({});
  expect((await submit(c)).skipped).toBe(true); expect(c.getWithdrawInfo).toHaveBeenCalled();
  expect(c.withdraw).not.toHaveBeenCalled(); expect(repo.getInflightCount()).toBe(0);
});
it('does not erase order-held funds when the spendable balance is zero', async () => {
  const c = client(); vi.mocked(c.getBalance).mockImplementation(async options => options?.includeHeld ? { BTC: '3' } : { BTC: '0' });
  expect((await submit(c)).skipped).toBe(true); expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3);
  expect(c.withdraw).not.toHaveBeenCalled();
});
it('rejects a snapshot after debits and credits restore the same pending amount', async () => {
  const c = client(), reconciler = new Reconciler({ config: config() }), reply = deferred<Record<string, string>>();
  vi.mocked(c.getBalance).mockImplementation(() => reply.promise);
  const check = reconciler.reconcileBalances('kraken', c);
  repo.subtractPendingAmount('kraken', 'BTC', 1); repo.addPendingAmount('kraken', 'BTC', 1);
  reply.resolve({}); await expect(check).rejects.toThrow('Account activity changed');
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3);
});
it('checks unrelated assets even when an exchange has an active withdrawal', async () => {
  const c = client(), reconciler = new Reconciler({ config: config() });
  repo.addPendingAmount('kraken', 'ETH', 2); const job = repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 1);
  vi.mocked(c.getBalance).mockResolvedValue({});
  const check = await reconciler.reconcileBalances('kraken', c);
  expect(check.adjusted).toEqual(['ETH']); expect(check.deferred).toEqual(['BTC']);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3);
  repo.updateWithdrawalJob(job.id, { status: 'complete' }); await reconciler.reconcileBalances('kraken', c);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(0);
});
it('invalidates a prepared withdrawal across a pause and resume cycle', async () => {
  const c = client(), quote = deferred<any>(); vi.mocked(c.getWithdrawInfo).mockImplementation(() => quote.promise);
  const pending = submit(c); await flush(); repo.setEnabled(false); repo.setEnabled(true);
  quote.resolve({ amount: 0.999, fee: 0.001, limit: 100, method: 'Bitcoin' });
  expect((await pending).skipped).toBe(true); expect(c.withdraw).not.toHaveBeenCalled();
});
it('accounts for sold assets and fees once while paused, even for excluded order types', () => {
  repo.setEnabled(false); repo.addPendingAmount('kraken', 'USD', 10);
  const cfg = config(); cfg.global.allowedOrderTypes = ['limit'];
  const processor = new FillProcessor({ config: cfg });
  const fill = { tradeId: 'sell', orderId: 'order', pair: 'BTC/USD', side: 'sell' as const, orderType: 'market', price: 100,
    volume: 2, cost: 200, fee: 0.01, feeCurrency: 'BTC', timestamp: Date.now() };
  processor.processFill('kraken', fill); processor.processFill('kraken', fill);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBeCloseTo(0.99);
  expect(repo.getAssetState('kraken', 'USD')?.pendingAmount).toBe(10);
  expect(repo.isEnabled()).toBe(false);
});
it('debits the quote currency spent by a buy and any third-currency fees', () => {
  repo.addPendingAmount('kraken', 'USD', 300); repo.addPendingAmount('kraken', 'ETH', 1);
  new FillProcessor({ config: config() }).processFill('kraken', { tradeId: 'buy', orderId: 'order', pair: 'BTC/USD', side: 'buy',
    orderType: 'market', price: 100, volume: 2, cost: 200, fee: 0.01, feeCurrency: 'ETH', timestamp: Date.now() });
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(5);
  expect(repo.getAssetState('kraken', 'USD')?.pendingAmount).toBe(100);
  expect(repo.getAssetState('kraken', 'ETH')?.pendingAmount).toBeCloseTo(0.99);
});
it('processes trade history chronologically so a sale does not leave a stale earlier purchase queued', async () => {
  const c = client(), reconciler = new Reconciler({ config: config() }); repo.setPendingAmount('kraken', 'BTC', 0);
  const buy = { tradeId: 'buy', orderId: 'order', pair: 'BTC/USD', side: 'buy' as const, orderType: 'market', price: 100,
    volume: 1, cost: 100, fee: 1, feeCurrency: 'USD', timestamp: Date.now() };
  await vi.advanceTimersByTimeAsync(1000);
  vi.mocked(c.getTradesHistory!).mockResolvedValue([{ ...buy, tradeId: 'sell', side: 'sell', timestamp: Date.now() }, buy]);
  await reconciler.syncTradeHistory('kraken', c);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(0);
});

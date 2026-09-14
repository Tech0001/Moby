import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initDb, closeDb } from '../src/server/db/sqlite.js';
import * as repo from '../src/server/db/repositories.js';
import { WithdrawalControl, initializeWithdrawalState, clearQueuedAmounts, getQueuePreview } from '../src/server/domain/withdrawalControl.js';
import { FillProcessor } from '../src/server/domain/fillProcessor.js';
import { createWithdrawalControlRoutes } from '../src/server/web/withdrawalControl.js';
import { createWebServer, startServer } from '../src/server/web/server.js';
import { config, deferred } from './helpers.js';

beforeEach(() => { initDb(); repo.setEnabled(false); repo.addPendingAmount('kraken', 'BTC', 2); });
afterEach(() => { closeDb(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('keeps submissions paused until every enabled exchange passes its checks', async () => {
  const first = deferred<void>(), second = deferred<void>(), wake = vi.fn();
  const check = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const control = new WithdrawalControl({ exchanges: () => ['kraken', 'gemini'], check, wake });
  const resume = control.resume(); expect(repo.isEnabled()).toBe(false);
  first.resolve(); await first.promise; expect(repo.isEnabled()).toBe(false);
  second.resolve(); await resume; expect(repo.isEnabled()).toBe(true); expect(wake).toHaveBeenCalledTimes(1);
});
it('leaves withdrawals paused after any balance or history check fails', async () => {
  const control = new WithdrawalControl({ exchanges: () => ['kraken', 'gemini'], check: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline')), wake: vi.fn() });
  await expect(control.resume()).rejects.toThrow('offline'); expect(repo.isEnabled()).toBe(false);
});
it('a pause cancels a pending resume and duplicate resumes cannot overlap', async () => {
  const check = deferred<void>(), control = new WithdrawalControl({ exchanges: () => ['kraken'], check: () => check.promise, wake: vi.fn() });
  const resume = control.resume(); await expect(control.resume()).rejects.toThrow('already running'); control.pause(); check.resolve();
  await expect(resume).rejects.toThrow('cancelled'); expect(repo.isEnabled()).toBe(false);
});
it('a disconnected caller cannot enable withdrawals after the balance check completes', async () => {
  const check = deferred<void>(); let connected = true;
  const control = new WithdrawalControl({ exchanges: () => ['kraken'], check: () => check.promise, wake: vi.fn() });
  const resume = control.resume(() => connected); connected = false; check.resolve();
  await expect(resume).rejects.toThrow('cancelled'); expect(repo.isEnabled()).toBe(false);
});
it('preserves an explicit pause over enabled-on-boot and gates an allowed boot', () => {
  expect(initializeWithdrawalState(true)).toBe(false); // Older version's persisted pause.
  repo.setEnabled(true); expect(initializeWithdrawalState(true)).toBe(true); expect(repo.isEnabled()).toBe(false);
  repo.setAppStateValue('manual_pause', 'true'); repo.setEnabled(true);
  expect(initializeWithdrawalState(true)).toBe(false); expect(repo.isEnabled()).toBe(false);
});
it('clears only a reviewed unchanged queue while paused and retains history and configuration', () => {
  repo.upsertAssetConfig('kraken', 'BTC', { threshold: 0.01, destKeys: ['cold'] });
  const job = repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 1); repo.updateWithdrawalJob(job.id, { status: 'complete' });
  const preview = getQueuePreview(); clearQueuedAmounts(preview.token);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(0);
  expect(repo.getWithdrawalJob(job.id)?.status).toBe('complete'); expect(repo.getAssetConfig('kraken', 'BTC')?.destKeys).toEqual(['cold']);
  expect(repo.isEnabled()).toBe(false); expect(() => clearQueuedAmounts(preview.token)).toThrow('queue changed');
});
it('rejects clearing after a new fill, while running, or with an unresolved withdrawal', () => {
  const preview = getQueuePreview(); repo.addPendingAmount('kraken', 'BTC', 1);
  expect(() => clearQueuedAmounts(preview.token)).toThrow('queue changed');
  repo.setEnabled(true); expect(() => clearQueuedAmounts(getQueuePreview().token)).toThrow('Pause'); repo.setEnabled(false);
  repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 1);
  expect(() => clearQueuedAmounts(getQueuePreview().token)).toThrow('active withdrawals');
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(3);
});
it('does not resurrect cleared amounts from delayed fills, and accepts new fills afterwards', () => {
  vi.useFakeTimers(); repo.upsertAssetConfig('kraken', 'BTC', { threshold: 0.01, destKeys: ['cold'] });
  const fill = { tradeId: 'delayed', orderId: 'order', pair: 'BTC/USD', side: 'buy' as const, orderType: 'market', price: 100,
    volume: 1, cost: 100, fee: 1, feeCurrency: 'USD', timestamp: Date.now() };
  clearQueuedAmounts(getQueuePreview().token);
  const processor = new FillProcessor({ config: config() }); processor.processFill('kraken', fill);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(0);
  vi.setSystemTime(Date.now() + 1); processor.processFill('kraken', { ...fill, tradeId: 'after', timestamp: Date.now() });
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(1);
});
it('requires authentication and explicit clear confirmation, and reports failed resume over HTTP', async () => {
  const web = { ...config().web, host: '127.0.0.1', port: 0, sessionSecret: 'a'.repeat(32) };
  const app = createWebServer({ config: web }); let authenticated = false;
  app.use((req, _res, next) => { if (authenticated) req.session.userId = 'test'; next(); });
  const control = new WithdrawalControl({ exchanges: () => ['kraken'], check: async () => { throw new Error('Balance unavailable'); }, wake: vi.fn() });
  app.use('/api/control', createWithdrawalControlRoutes(control)); const server = await startServer(app, web);
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/control`;
  const post = (route: string, body: unknown = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    expect((await post('/start')).status).toBe(401); authenticated = true;
    const failed = await post('/start'); expect(failed.status).toBe(409); expect((await failed.json()).error).toBe('Balance unavailable');
    const preview = await (await fetch(url + '/queue')).json();
    expect((await post('/queue/clear', { token: preview.token })).status).toBe(400);
    expect((await post('/queue/clear', { token: preview.token, confirmed: true })).status).toBe(200);
    expect(repo.isEnabled()).toBe(false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

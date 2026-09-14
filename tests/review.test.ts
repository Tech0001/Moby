import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../src/server/db/sqlite.js';
import * as repo from '../src/server/db/repositories.js';
import { createWithdrawalReviewRoutes } from '../src/server/web/withdrawalReview.js';
import { createWebServer, startServer } from '../src/server/web/server.js';
import { KrakenAdapterFactory } from '../src/server/exchanges/kraken/factory.js';
import { registerExchange, hasExchange } from '../src/server/exchanges/registry.js';
import { getClientPool, resetPoolManager } from '../src/server/exchanges/clientPool.js';
import { config } from './helpers.js';
import type { Server } from 'node:http';
let server: Server, url: string, id: string;
beforeEach(async () => {
  initDb(); resetPoolManager(); if (!hasExchange('kraken')) registerExchange(KrakenAdapterFactory);
  const job = repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 1); id = job.id;
  repo.updateWithdrawalJob(id, { status: 'unknown' }); getDb().prepare('UPDATE withdrawal_jobs SET created_at = ? WHERE id = ?').run(Date.now() - 180000, id);
  repo.upsertExchangeAddress('kraken', 'BTC', 'Bitcoin', 'cold', 'wallet1');
  const web = { ...config().web, host: '127.0.0.1', port: 0, sessionSecret: 'a'.repeat(32) };
  const app = createWebServer({ config: web }); app.use((req, _res, next) => { req.session.userId = 'test'; next(); });
  app.use('/api/withdrawals', createWithdrawalReviewRoutes(() => {})); server = await startServer(app, web);
  url = `http://127.0.0.1:${(server.address() as any).port}/api/withdrawals/${id}/resolve`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeDb(); resetPoolManager(); vi.restoreAllMocks(); });
const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
it('requires explicit confirmation and releases the reservation at most once', async () => {
  expect((await post({ outcome: 'not_sent' })).status).toBe(400);
  expect((await post({ outcome: 'not_sent', confirmed: true })).status).toBe(200);
  expect((await post({ outcome: 'not_sent', confirmed: true })).status).toBe(409);
  expect(repo.getAssetState('kraken', 'BTC')?.pendingAmount).toBe(1);
});
it('rejects a mismatched destination and accepts a matching reference without crediting funds', async () => {
  const remote = { refId: 'real', asset: 'BTC', amount: 0.999, fee: 0.001, status: 'pending' as const, timestamp: Date.now(), address: 'wallet1' };
  const execute = vi.spyOn(getClientPool('kraken'), 'execute').mockResolvedValue([{ ...remote, address: 'different' }]);
  expect((await post({ refid: 'real' })).status).toBe(400);
  execute.mockResolvedValue([remote]); expect((await post({ refid: 'real' })).status).toBe(200);
  expect(repo.getWithdrawalJob(id)?.exchangeRef).toBe('real'); expect(repo.getAssetState('kraken', 'BTC')).toBeNull();
});
it('rejects a reference already linked to another job', async () => {
  const other = repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 1); repo.updateWithdrawalJob(other.id, { exchangeRef: 'real', status: 'pending' });
  vi.spyOn(getClientPool('kraken'), 'execute').mockResolvedValue([{ refId: 'real', asset: 'BTC', amount: 1, fee: 0, status: 'pending', timestamp: Date.now(), address: 'wallet1' }]);
  expect((await post({ refid: 'real' })).status).toBe(409); expect(repo.getWithdrawalJob(id)?.status).toBe('unknown');
});

import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../src/server/db/sqlite.js';
import * as repo from '../src/server/db/repositories.js';
import { TelegramNotifications, TelegramError, sendTelegram, type TelegramSender } from '../src/server/notifications/telegram.js';
import { createNotificationRoutes } from '../src/server/web/notifications.js';
import { createWebServer, startServer } from '../src/server/web/server.js';
import { config, deferred } from './helpers.js';
const token = '123456:abcdefghijklmnopqrstuvwxyz_123456789';
const secret = 'test-secret'.repeat(4);
let now: number, sender: ReturnType<typeof vi.fn<TelegramSender>>, notifications: TelegramNotifications;
beforeEach(() => {
  process.env.MOBY_ENCRYPTION_KEY = 'a'.repeat(64);
  initDb(); now = 1_000_000; sender = vi.fn<TelegramSender>().mockResolvedValue(undefined);
  notifications = new TelegramNotifications(sender, () => now);
});
afterEach(() => { notifications.stop(); closeDb(); vi.unstubAllGlobals(); });
const enable = () => notifications.configure({ enabled: true, chatId: '123', botToken: token });
function job(status: 'pending' | 'complete' | 'held' | 'unknown' | 'failed' = 'pending', ref = true) {
  const job = repo.createWithdrawalJob('kraken', 'BTC', 'Bitcoin', 'cold', 0.1);
  repo.updateWithdrawalJob(job.id, { status, ...(ref ? { exchangeRef: `ref-${job.id}` } : {}) });
  return job.id;
}
it('encrypts the bot token, never returns it, and preserves it when saving a blank form', async () => {
  enable();
  expect(JSON.stringify(notifications.getStatus())).not.toContain(token);
  expect(repo.getAppStateValue('telegram.settings')).not.toContain(token);
  notifications.configure({ enabled: true, chatId: '456' });
  await notifications.test();
  expect(sender).toHaveBeenCalledWith(token, '456', expect.stringContaining('Moby test'), expect.any(AbortSignal));
  expect(() => notifications.configure({ enabled: true, chatId: 'https://attacker.test' })).toThrow();
});
it('does not replay historical withdrawals or send alerts while disabled', async () => {
  job('complete'); enable(); await notifications.tick(); expect(sender).not.toHaveBeenCalled();
  notifications.configure({ enabled: false, chatId: '123' });
  job('unknown', false); await notifications.tick(); expect(sender).not.toHaveBeenCalled();
});
it('sends one started alert for a burst and batches completed chunks after a minute', async () => {
  enable(); const first = job(); await notifications.tick();
  expect(sender).toHaveBeenCalledTimes(1); expect(sender.mock.calls[0][2]).toContain('accepted a chunk');
  now += 5000; const second = job(); await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
  repo.updateWithdrawalJob(first, { status: 'complete' }); await notifications.tick();
  now += 30000; repo.updateWithdrawalJob(second, { status: 'complete' }); await notifications.tick();
  expect(sender).toHaveBeenCalledTimes(1);
  now += 30000; await notifications.tick();
  expect(sender).toHaveBeenCalledTimes(2);
  expect(sender.mock.calls[1][2]).toContain('2 chunks complete'); expect(sender.mock.calls[1][2]).toContain('0.2 BTC');
  now += 60000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(2);
});
it('prioritizes held/unknown/failed alerts and deduplicates repeated status observations', async () => {
  enable(); const first = job('unknown', false); await notifications.tick();
  expect(sender.mock.calls[0][2]).toContain('withdrawal unknown');
  now += 5000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
  repo.updateWithdrawalJob(first, { status: 'pending', exchangeRef: 'reconciled' }); await notifications.tick();
  now += 5000; repo.updateWithdrawalJob(first, { status: 'held' }); await notifications.tick();
  expect(sender.mock.calls.at(-1)![2]).toContain('withdrawal held');
  now += 5000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(3);
  job('failed', false); await notifications.tick(); expect(sender.mock.calls.at(-1)![2]).toContain('withdrawal failed');
});
it('retains failed deliveries across service restarts and honors retry_after', async () => {
  enable(); job('unknown', false); sender.mockRejectedValueOnce(new TelegramError('Rate limited', 120));
  await notifications.tick(); expect(notifications.getStatus().pending).toBe(1);
  notifications.stop(); notifications = new TelegramNotifications(sender, () => now);
  now += 119000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
  now += 1000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(2);
  expect(notifications.getStatus().pending).toBe(0); expect(notifications.getStatus().lastError).toBeNull();
});
it('captures concurrent changes without overlapping sends or losing new completion events', async () => {
  enable(); job('complete'); await notifications.tick(); // started
  now += 61000;
  const reply = deferred<void>(); sender.mockImplementationOnce(() => reply.promise);
  const sending = notifications.tick(); await Promise.resolve();
  job('complete'); await notifications.tick();
  expect(sender).toHaveBeenCalledTimes(2);
  reply.resolve(); await sending;
  expect(notifications.getStatus().pending).toBe(1);
  now += 61000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(3);
});
it('aborts old recipient delivery and clears pending events when the chat changes', async () => {
  enable(); job('unknown', false);
  const reply = deferred<void>(); sender.mockImplementationOnce(() => reply.promise);
  const sending = notifications.tick(); await Promise.resolve();
  notifications.configure({ enabled: true, chatId: '456' });
  expect(sender.mock.calls[0][3].aborted).toBe(true);
  reply.resolve(); await sending;
  expect(notifications.getStatus().lastSentAt).toBeNull(); expect(notifications.getStatus().pending).toBe(0);
  now += 60000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
});
it('uses plain text, handles Telegram rate limits and redacts network errors', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetcher);
  await sendTelegram(token, '123', 'test <>&', new AbortController().signal);
  const request = fetcher.mock.calls[0][1]; const body = JSON.parse(request.body);
  expect(body.chat_id).toBe('123'); expect(body.text).toBe('test <>&'); expect(body.parse_mode).toBeUndefined();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 429, description: token, parameters: { retry_after: 80 } }), { status: 429 }));
  await expect(sendTelegram(token, '123', 'test', new AbortController().signal)).rejects.toMatchObject({ retryAfterSeconds: 80 });
  fetcher.mockRejectedValueOnce(new Error(`fetch failed https://api.telegram.org/bot${token}`));
  await expect(sendTelegram(token, '123', 'test', new AbortController().signal)).rejects.toThrow('could not confirm delivery');
});
it('requires authentication for settings and test messages, and never exposes the token via HTTP', async () => {
  const app = createWebServer({ config: { ...config().web, sessionSecret: secret } });
  app.use('/api/notifications/telegram', createNotificationRoutes(notifications));
  const server = await startServer(app, { ...config().web, port: 0, host: '127.0.0.1' });
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/notifications/telegram`;
    for (const method of ['GET', 'PUT', 'POST']) {
      const response = await fetch(url + (method === 'POST' ? '/test' : ''), { method });
      expect(response.status).toBe(401);
    }
    expect(sender).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('finds private chats without sending a message or confirming the update offset', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [
    { message: { chat: { id: 123, type: 'private', username: 'owner' } } },
    { message: { chat: { id: -456, type: 'group', title: 'group' } } },
  ] })));
  vi.stubGlobal('fetch', fetcher);
  expect(await notifications.findChats({ botToken: token })).toEqual([{ id: '123', name: '@owner' }]);
  expect(fetcher.mock.calls[0][0]).toContain('/getUpdates'); expect(JSON.parse(fetcher.mock.calls[0][1].body).offset).toBeUndefined();
  expect(sender).not.toHaveBeenCalled();
});

it('waits through brief outages, sends once across restart, and reports recovery once', async () => {
  const health = { enabled: true, dryRun: false, assets: [], activeJobs: [], connection: { exchanges: [{ exchange: 'kraken', connected: false, error: null }] } };
  notifications = new TelegramNotifications(sender, () => now, () => health as any); enable();
  await notifications.tick(); now += 299000; await notifications.tick(); expect(sender).not.toHaveBeenCalled();
  notifications.stop(); notifications = new TelegramNotifications(sender, () => now, () => health as any);
  now += 1000; await notifications.tick(); expect(sender.mock.calls[0][2]).toContain('connection needs attention');
  now += 60000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
  health.connection.exchanges[0].connected = true; await notifications.tick(); expect(sender.mock.calls[1][2]).toContain('connection recovered');
  now += 60000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(2);
});
it('clears a brief outage without sending and does not mistake disabling an exchange for recovery', async () => {
  const health = { enabled: true, dryRun: false, assets: [], activeJobs: [], connection: { exchanges: [{ exchange: 'kraken', connected: false }] } };
  notifications = new TelegramNotifications(sender, () => now, () => health as any); enable(); await notifications.tick();
  now += 10000; health.connection.exchanges[0].connected = true; await notifications.tick(); expect(sender).not.toHaveBeenCalled();
  health.connection.exchanges[0].connected = false; await notifications.tick(); now += 300001; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
  health.connection.exchanges=[]; now+=5000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
});
it('sends a stalled-withdrawal alert once even without a working status poller', async () => {
  const id = job(); getDb().prepare('UPDATE withdrawal_jobs SET created_at = ? WHERE id = ?').run(now - 31 * 60000, id);
  enable(); await notifications.tick(); expect(sender.mock.calls[0][2]).toContain('taking longer than expected');
  now += 60000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
});
it('alerts on an idle queue but stops tracking it when withdrawals are paused or dry-run', async () => {
  const health = { enabled: true, dryRun: false, assets: [{ exchange:'kraken', asset:'BTC', enabled:true, pendingAmount:1, threshold:0.1, state:'Waiting' }], activeJobs: [], connection: { exchanges: [] } };
  notifications = new TelegramNotifications(sender, () => now, () => health as any); enable(); await notifications.tick();
  now += 29 * 60000; health.enabled=false; await notifications.tick(); now += 5*60000; await notifications.tick(); expect(sender).not.toHaveBeenCalled();
  health.enabled=true; await notifications.tick(); now += 30*60000; await notifications.tick(); expect(sender.mock.calls[0][2]).toContain('queue needs attention');
  now += 60000; await notifications.tick(); expect(sender).toHaveBeenCalledTimes(1);
  health.dryRun=true; await notifications.tick(); expect(getDb().prepare('SELECT * FROM health_alert_state').all()).toHaveLength(0);
});
it('disabling health alerts drops their queued delivery while preserving withdrawal alerts', async () => {
  const health = { enabled:true, dryRun:false, assets:[], activeJobs:[], connection:{exchanges:[{exchange:'kraken',connected:false}]} };
  notifications = new TelegramNotifications(sender, () => now, () => health as any); enable(); await notifications.tick();
  sender.mockRejectedValueOnce(new TelegramError('Offline')); now += 300000; await notifications.tick();
  expect(notifications.getStatus().pending).toBe(1);
  notifications.configure({ enabled:true,chatId:'123',healthAlerts:false }); expect(notifications.getStatus().pending).toBe(0);
  now += 31000; job('unknown',false); await notifications.tick(); expect(sender.mock.calls.at(-1)![2]).toContain('withdrawal unknown');
});

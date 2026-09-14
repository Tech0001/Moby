import { encrypt, decrypt } from '../utils/encryption.js';
import { z } from 'zod';
import { getDb } from '../db/sqlite.js';
import { getAppStateValue, setAppStateValue } from '../db/repositories.js';
import { createChildLogger } from '../utils/logger.js';
import type { DashboardStatus } from '../domain/dashboardStatus.js';

const logger = createChildLogger('telegram');
const SettingsSchema = z.object({
  enabled: z.boolean(),
  chatId: z.string().trim().max(100).refine(v => !v || /^-?\d+$|^@[A-Za-z0-9_]+$/.test(v)),
  botToken: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{20,}$/).max(200).optional(),
  healthAlerts: z.boolean().optional(),
  outageMinutes: z.number().int().min(1).max(1440).optional(),
  stalledMinutes: z.number().int().min(1).max(10080).optional(),
}).strict();
type Settings = { enabled: boolean; chatId: string; encryptedToken: string; healthAlerts: boolean; outageMinutes: number; stalledMinutes: number };
type Event = { event_id: string; kind: string; exchange: string; asset: string; amount: number; message: string };
type Job = { id: string; asset: string; exchange: string; amount: number; status: string; exchange_ref: string | null;
  previous_status: string | null; previous_ref: string | null };
export class TelegramError extends Error {
  constructor(message: string, readonly retryAfterSeconds = 30) { super(message); }
}
export type TelegramSender = (token: string, chatId: string, message: string, signal: AbortSignal) => Promise<void>;

export const sendTelegram: TelegramSender = async (token, chatId, message, signal) => {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message.slice(0, 4000), link_preview_options: { is_disabled: true } }),
    });
    const body = await response.json() as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
    if (!response.ok || !body.ok) {
      const code = body.error_code ?? response.status;
      // Do not surface Telegram descriptions or fetch errors: they can contain the bot URL/token.
      const reason = code === 401 ? 'Telegram rejected the bot token.' : code === 403
        ? 'Telegram cannot message this chat. Start or unblock your bot.' : code === 400
        ? 'Telegram rejected the chat. Check the chat ID and start your bot.' : code === 429
        ? 'Telegram rate limit reached. Delivery will retry.' : 'Telegram is unavailable. Delivery will retry.';
      const retry = body.parameters?.retry_after;
      throw new TelegramError(reason, Number.isFinite(retry) && retry! > 0 ? retry! : 30);
    }
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError('Telegram could not confirm delivery. Delivery will retry.');
  }
};

/** Persist observations and queued alerts independently of withdrawal execution. */
export class TelegramNotifications {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private revision = 0;
  private controller?: AbortController;

  constructor(private send: TelegramSender = sendTelegram, private now = Date.now,
    private health?: () => DashboardStatus) {}
  private settings(): Settings {
    return { healthAlerts: true, outageMinutes: 5, stalledMinutes: 30,
      ...JSON.parse(getAppStateValue('telegram.settings') || '{"enabled":false,"chatId":"","encryptedToken":""}') };
  }
  private encrypt(token: string): string { return encrypt(token); }
  private decrypt(token: string): string {
    try { return decrypt(token); }
    catch { throw new TelegramError('Saved bot token cannot be read. Enter it again in Notifications.'); }
  }
  getStatus() {
    const settings = this.settings();
    const pending = getDb().prepare('SELECT COUNT(*) AS count FROM telegram_outbox WHERE sent_at IS NULL').get() as { count: number };
    return { enabled: settings.enabled, chatId: settings.chatId, hasToken: !!settings.encryptedToken,
      healthAlerts: settings.healthAlerts, outageMinutes: settings.outageMinutes, stalledMinutes: settings.stalledMinutes,
      pending: pending.count, lastError: getAppStateValue('telegram.lastError') || null,
      lastSentAt: Number(getAppStateValue('telegram.lastSentAt')) || null };
  }
  configure(input: unknown) {
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) throw new Error('Enter a valid bot token and numeric chat ID (or @channel name).');
    const previous = this.settings(), { botToken, ...fields } = parsed.data;
    const settings = { ...previous, ...fields, encryptedToken: botToken ? this.encrypt(botToken) : previous.encryptedToken };
    if (settings.enabled && (!settings.encryptedToken || !settings.chatId)) throw new Error('A bot token and chat ID are required to enable alerts.');
    this.revision++; this.controller?.abort();
    getDb().transaction(() => {
      if (previous.enabled !== settings.enabled || previous.chatId !== settings.chatId || botToken) {
        // Changing recipients must never deliver the previous recipient's queued activity.
        getDb().exec(`DELETE FROM health_alert_state; DELETE FROM telegram_outbox; DELETE FROM telegram_job_state;
          INSERT INTO telegram_job_state SELECT id, status, exchange_ref FROM withdrawal_jobs;
          DELETE FROM app_state WHERE key LIKE 'telegram.burst.%';`);
        setAppStateValue('telegram.nextAttempt', '0');
      }
      if (previous.healthAlerts !== settings.healthAlerts || previous.outageMinutes !== settings.outageMinutes || previous.stalledMinutes !== settings.stalledMinutes) {
        getDb().exec("DELETE FROM health_alert_state; DELETE FROM telegram_outbox WHERE sent_at IS NULL AND kind IN ('outage','recovered','stalled','queue_stalled')");
      }
      setAppStateValue('telegram.settings', JSON.stringify(settings));
      setAppStateValue('telegram.lastError', '');
    }).immediate();
    return this.getStatus();
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 2000);
    this.wake();
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.controller?.abort(); }
  wake(): void { void this.tick().catch(() => logger.warn('Notification queue could not be processed; will retry')); }

  private capture(): void {
    const db = getDb(), now = this.now();
    db.transaction(() => {
      const changed = db.prepare(`SELECT j.*, s.status AS previous_status, s.ref AS previous_ref
        FROM withdrawal_jobs j LEFT JOIN telegram_job_state s ON s.job_id = j.id
        WHERE s.job_id IS NULL OR s.status != j.status OR s.ref IS NOT j.exchange_ref
        ORDER BY j.created_at, j.id`).all() as Job[];
      const queue = (job: Job, kind: string, message: string) => {
        db.prepare(`INSERT OR IGNORE INTO telegram_outbox
          (event_id, kind, exchange, asset, amount, message, created_at, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`${job.id}:${kind}`, kind, job.exchange, job.asset, job.amount, message, now, kind === 'complete' ? now + 60000 : now);
      };
      for (const job of changed) {
        if (job.exchange_ref && !job.previous_ref) {
          const key = `telegram.burst.${job.exchange}.${job.asset}`, previous = getAppStateValue(key);
          if (!previous || now - Number(previous) >= 300000) {
            queue(job, 'started', `Moby: ${job.exchange} ${job.asset} withdrawals started\nThe exchange accepted a chunk of ${job.amount} ${job.asset}. Check Moby for its current status.`);
          }
          setAppStateValue(key, String(now));
        }
        if (job.status !== job.previous_status) {
          if (job.status === 'complete') queue(job, 'complete', '');
          else if (['held', 'unknown', 'failed', 'cancelled'].includes(job.status)) {
            const detail = job.status === 'unknown' ? 'The exchange has not confirmed whether it accepted this request. Review it in Moby before retrying.'
              : job.status === 'held' ? 'The exchange has placed this withdrawal on hold. Review it in Moby.'
              : 'Review this withdrawal in Moby for details.';
            queue(job, job.status, `Moby: withdrawal ${job.status}\n${job.amount} ${job.asset}\n${detail}\nJob: ${job.id}`);
          }
        }
        db.prepare('INSERT OR REPLACE INTO telegram_job_state (job_id, status, ref) VALUES (?, ?, ?)').run(job.id, job.status, job.exchange_ref);
      }
    }).immediate();
  }

  private captureHealth(settings: Settings): void {
    if (!settings.healthAlerts) return;
    const now = this.now(), db = getDb();
    const status = this.health?.();
    const conditions = new Map<string, { exchange: string; asset: string; message: string; kind: string; delay: number }>();
    for (const exchange of status?.connection.exchanges ?? []) {
      if (!exchange.connected || exchange.error) conditions.set(`exchange:${exchange.exchange}`, { exchange: exchange.exchange, asset: '', kind: 'outage',
        message: `Moby: ${exchange.exchange} connection needs attention\nLive monitoring or trade catch-up is unavailable. Moby is retrying. Check the app for details.`, delay: settings.outageMinutes * 60000 });
    }
    if (status?.enabled && !status.dryRun) for (const asset of status.assets) {
      if (asset.enabled && asset.pendingAmount > 0 && asset.pendingAmount >= asset.threshold &&
          !['Disabled', 'Exchange paused', 'Paused', 'Reserve'].includes(asset.state) &&
          !status.activeJobs.some(j => j.exchange === asset.exchange && j.asset === asset.asset)) {
        conditions.set(`queue:${asset.exchange}:${asset.asset}`, { exchange: asset.exchange, asset: asset.asset, kind: 'queue_stalled',
          message: `Moby: ${asset.exchange} ${asset.asset} queue needs attention\nFunds have been waiting without an active withdrawal. Open the Sweep monitor to see the waiting reason.`, delay: settings.stalledMinutes * 60000 });
      }
    }
    db.transaction(() => {
      const queue = (id: string, item: { exchange: string; asset: string; kind: string; message: string }) => {
        db.prepare(`INSERT OR IGNORE INTO telegram_outbox (event_id, kind, exchange, asset, amount, message, created_at, ready_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)`).run(id, item.kind, item.exchange, item.asset, item.message, now, now);
      };
      for (const [key, item] of conditions) {
        db.prepare('INSERT OR IGNORE INTO health_alert_state (key, since_at) VALUES (?, ?)').run(key, now);
        const state = db.prepare('SELECT since_at, alerted FROM health_alert_state WHERE key = ?').get(key) as { since_at: number; alerted: number };
        if (!state.alerted && now - state.since_at >= item.delay) {
          queue(`${key}:${state.since_at}:${item.kind}`, item);
          db.prepare('UPDATE health_alert_state SET alerted = 1 WHERE key = ?').run(key);
        }
      }
      if (status) for (const state of db.prepare('SELECT key, since_at, alerted FROM health_alert_state').all() as Array<{ key: string; since_at: number; alerted: number }>) {
        if (!conditions.has(state.key)) {
          const exchange = state.key.slice('exchange:'.length);
          // Removing/disabling a key is not evidence that the connection recovered.
          if (state.key.startsWith('exchange:') && state.alerted && status.connection.exchanges.some(e => e.exchange === exchange && e.connected && !e.error)) {
            queue(`${state.key}:${state.since_at}:recovered`, { exchange, asset: '', kind: 'recovered', message: `Moby: ${exchange} connection recovered\nLive monitoring and trade catch-up are available again.` });
          }
          db.prepare('DELETE FROM health_alert_state WHERE key = ?').run(state.key);
        }
      }
      const stalled = db.prepare("SELECT id, exchange, asset, amount FROM withdrawal_jobs WHERE status IN ('submitted','pending') AND created_at <= ?")
        .all(now - settings.stalledMinutes * 60000) as Array<{ id: string; exchange: string; asset: string; amount: number }>;
      for (const job of stalled) queue(`${job.id}:stalled`, { exchange: job.exchange, asset: job.asset, kind: 'stalled',
        message: `Moby: withdrawal taking longer than expected\n${job.exchange}: ${job.amount} ${job.asset}\nStill awaiting completion after ${settings.stalledMinutes} minutes. No withdrawal was retried by this alert.\nJob: ${job.id}` });
    }).immediate();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const settings = this.settings();
    if (!settings.enabled) return;
    // Capture changes even when a previous Telegram request is still pending.
    this.capture();
    this.captureHealth(settings);
    if (this.busy || this.now() < Number(getAppStateValue('telegram.nextAttempt') || 0)) return;
    const db = getDb(), now = this.now();
    const first = db.prepare(`SELECT * FROM telegram_outbox WHERE sent_at IS NULL AND ready_at <= ?
      ORDER BY CASE WHEN kind IN ('held','unknown','failed','cancelled','outage','stalled','queue_stalled') THEN 0 ELSE 1 END, created_at, event_id LIMIT 1`).get(now) as Event | undefined;
    if (!first) return;
    const events = first.kind === 'complete' ? db.prepare(`SELECT * FROM telegram_outbox WHERE sent_at IS NULL
      AND kind = 'complete' AND exchange = ? AND asset = ? ORDER BY created_at LIMIT 500`).all(first.exchange, first.asset) as Event[] : [first];
    const amount = Number(events.reduce((sum, event) => sum + event.amount, 0).toFixed(8));
    const message = first.kind === 'complete'
      ? `Moby: ${first.exchange} ${first.asset} withdrawal update\nThe exchange marked ${events.length} chunk${events.length === 1 ? '' : 's'} complete.\nRequested total: ${amount} ${first.asset} (before withdrawal fees).\nCheck your wallet for receipt.`
      : first.message;
    await this.deliver(settings, message, events);
  }
  private async deliver(settings: Settings, message: string, events: Event[] = []): Promise<void> {
    this.busy = true;
    this.controller = new AbortController();
    const revision = this.revision;
    try {
      await this.send(this.decrypt(settings.encryptedToken), settings.chatId, message, this.controller.signal);
      if (this.stopped || revision !== this.revision) return;
      getDb().transaction(() => {
        for (const event of events) getDb().prepare('UPDATE telegram_outbox SET sent_at = ? WHERE event_id = ?').run(this.now(), event.event_id);
        setAppStateValue('telegram.lastSentAt', String(this.now()));
        setAppStateValue('telegram.lastError', '');
        setAppStateValue('telegram.nextAttempt', String(this.now() + 3000));
      }).immediate();
    } catch (error) {
      if (this.stopped || revision !== this.revision) return;
      const safe = error instanceof TelegramError ? error : new TelegramError('Telegram could not confirm delivery. Delivery will retry.');
      setAppStateValue('telegram.lastError', safe.message);
      setAppStateValue('telegram.nextAttempt', String(this.now() + Math.max(30, safe.retryAfterSeconds) * 1000));
      if (!events.length) throw safe;
    } finally { this.busy = false; this.controller = undefined; }
  }
  async test(): Promise<void> {
    const settings = this.settings();
    if (!settings.encryptedToken || !settings.chatId) throw new Error('Save a bot token and chat ID first.');
    if (this.busy || this.now() < Number(getAppStateValue('telegram.nextAttempt') || 0)) throw new Error('Telegram delivery is busy or waiting to retry. Try again shortly.');
    await this.deliver(settings, 'Moby test: Telegram notifications are connected. No withdrawal was made by this test.');
  }
  async findChats(input: unknown): Promise<Array<{ id: string; name: string }>> {
    const parsed = SettingsSchema.pick({ botToken: true }).safeParse(input);
    if (!parsed.success) throw new Error('Enter a valid bot token first.');
    const saved = this.settings();
    const token = parsed.data.botToken || (saved.encryptedToken ? this.decrypt(saved.encryptedToken) : '');
    if (!token) throw new Error('Enter a bot token first.');
    try {
      // Read recent messages without advancing the update offset or sending anything.
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100, timeout: 0 }),
      });
      const body = await response.json() as { ok?: boolean; result?: Array<{ message?: {
        chat?: { id: number; type: string; first_name?: string; username?: string } } }> };
      if (!response.ok || !body.ok || !Array.isArray(body.result)) throw new Error();
      const chats = new Map<string, string>();
      for (const update of body.result) {
        const chat = update.message?.chat;
        if (chat?.type === 'private' && Number.isSafeInteger(chat.id)) {
          chats.set(String(chat.id), chat.username ? `@${chat.username}` : chat.first_name || String(chat.id));
        }
      }
      return [...chats].map(([id, name]) => ({ id, name }));
    } catch { throw new Error('Could not find chats. Check the bot token, send /start to your bot, or enter the chat ID manually. Bots using a webhook require manual entry.'); }
  }
}

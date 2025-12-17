import { v4 as uuid } from 'uuid';
import { getDb } from './sqlite.js';
import { encrypt, safeDecrypt, isEncrypted } from '../utils/encryption.js';
import type {
  AssetState,
  WithdrawalJob,
  WithdrawalStatus,
  FillEvent,
  AppState,
  ExchangeId,
} from '../domain/types.js';

// ============== Asset State Repository ==============

export function getAssetState(exchange: ExchangeId, asset: string): AssetState | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT exchange, asset, pending_amount, rr_index, last_withdraw_at,
              consecutive_failures, backoff_until
       FROM asset_state WHERE exchange = ? AND asset = ?`
    )
    .get(exchange, asset) as {
    exchange: ExchangeId;
    asset: string;
    pending_amount: number;
    rr_index: number;
    last_withdraw_at: number | null;
    consecutive_failures: number;
    backoff_until: number | null;
  } | undefined;

  if (!row) return null;

  return {
    exchange: row.exchange,
    asset: row.asset,
    pendingAmount: row.pending_amount,
    rrIndex: row.rr_index,
    lastWithdrawAt: row.last_withdraw_at,
    consecutiveFailures: row.consecutive_failures,
    backoffUntil: row.backoff_until,
  };
}

/**
 * Get recent fill events
 */
export function getRecentFills(limit = 50, exchange?: ExchangeId): FillEvent[] {
  const db = getDb();
  let sql = 'SELECT * FROM fill_events';
  const params: unknown[] = [];

  if (exchange) {
    sql += ' WHERE exchange = ?';
    params.push(exchange);
  }
  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as any[];

  return rows.map((row) => ({
    tradeId: row.id, // map id back to tradeId
    orderId: row.order_id,
    pair: row.pair,
    side: row.side,
    orderType: row.order_type,
    price: row.price,
    volume: row.volume,
    cost: row.cost,
    fee: row.fee,
    feeCurrency: row.fee_currency,
    timestamp: row.ts,
    exchange: row.exchange as ExchangeId,
  }));
}

export function getAllAssetStates(exchange?: ExchangeId): AssetState[] {
  const db = getDb();
  let sql = `SELECT exchange, asset, pending_amount, rr_index, last_withdraw_at,
              consecutive_failures, backoff_until FROM asset_state`;
  const params: unknown[] = [];

  if (exchange) {
    sql += ' WHERE exchange = ?';
    params.push(exchange);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    exchange: ExchangeId;
    asset: string;
    pending_amount: number;
    rr_index: number;
    last_withdraw_at: number | null;
    consecutive_failures: number;
    backoff_until: number | null;
  }>;

  return rows.map((row) => ({
    exchange: row.exchange,
    asset: row.asset,
    pendingAmount: row.pending_amount,
    rrIndex: row.rr_index,
    lastWithdrawAt: row.last_withdraw_at,
    consecutiveFailures: row.consecutive_failures,
    backoffUntil: row.backoff_until,
  }));
}

export function upsertAssetState(state: AssetState): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO asset_state (exchange, asset, pending_amount, rr_index, last_withdraw_at, consecutive_failures, backoff_until)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exchange, asset) DO UPDATE SET
       pending_amount = excluded.pending_amount,
       rr_index = excluded.rr_index,
       last_withdraw_at = excluded.last_withdraw_at,
       consecutive_failures = excluded.consecutive_failures,
       backoff_until = excluded.backoff_until`
  ).run(
    state.exchange,
    state.asset,
    state.pendingAmount,
    state.rrIndex,
    state.lastWithdrawAt,
    state.consecutiveFailures,
    state.backoffUntil
  );
}

export function addPendingAmount(exchange: ExchangeId, asset: string, amount: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO asset_state (exchange, asset, pending_amount, rr_index, consecutive_failures)
     VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(exchange, asset) DO UPDATE SET
       pending_amount = pending_amount + ?`
  ).run(exchange, asset, amount, amount);
}

export function subtractPendingAmount(exchange: ExchangeId, asset: string, amount: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE asset_state SET pending_amount = MAX(0, pending_amount - ?) WHERE exchange = ? AND asset = ?`
  ).run(amount, exchange, asset);
}

export function setPendingAmount(exchange: ExchangeId, asset: string, amount: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE asset_state SET pending_amount = ? WHERE exchange = ? AND asset = ?`
  ).run(amount, exchange, asset);
}

export function advanceRrIndex(exchange: ExchangeId, asset: string, walletCount: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE asset_state SET rr_index = (rr_index + 1) % ? WHERE exchange = ? AND asset = ?`
  ).run(walletCount, exchange, asset);
}

export function recordWithdrawalAttempt(exchange: ExchangeId, asset: string, success: boolean, backoffUntil?: number): void {
  const db = getDb();
  const now = Date.now();

  if (success) {
    db.prepare(
      `UPDATE asset_state SET
         last_withdraw_at = ?,
         consecutive_failures = 0,
         backoff_until = NULL
       WHERE exchange = ? AND asset = ?`
    ).run(now, exchange, asset);
  } else {
    db.prepare(
      `UPDATE asset_state SET
         consecutive_failures = consecutive_failures + 1,
         backoff_until = ?
       WHERE exchange = ? AND asset = ?`
    ).run(backoffUntil || null, exchange, asset);
  }
}

// ============== Withdrawal Jobs Repository ==============

export function createWithdrawalJob(
  exchange: ExchangeId,
  asset: string,
  method: string,
  destKey: string,
  amount: number
): WithdrawalJob {
  const db = getDb();
  const now = Date.now();
  const job: WithdrawalJob = {
    id: uuid(),
    exchange,
    asset,
    method,
    destKey,
    amount,
    status: 'submitted',
    createdAt: now,
    updatedAt: now,
    pollCount: 0,
  };

  db.prepare(
    `INSERT INTO withdrawal_jobs
     (id, exchange, asset, method, dest_key, amount, status, created_at, updated_at, poll_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(job.id, job.exchange, job.asset, job.method, job.destKey, job.amount, job.status, job.createdAt, job.updatedAt, job.pollCount);

  return job;
}

export function getWithdrawalJob(id: string): WithdrawalJob | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM withdrawal_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapWithdrawalJobRow(row) : null;
}

export function getActiveWithdrawalJobs(exchange?: ExchangeId): WithdrawalJob[] {
  const db = getDb();
  let sql = `SELECT * FROM withdrawal_jobs WHERE status IN ('submitted', 'pending')`;
  const params: unknown[] = [];

  if (exchange) {
    sql += ' AND exchange = ?';
    params.push(exchange);
  }
  sql += ' ORDER BY created_at ASC';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapWithdrawalJobRow);
}

export function getInflightCount(exchange?: ExchangeId, asset?: string): number {
  const db = getDb();
  let sql = `SELECT COUNT(*) as count FROM withdrawal_jobs WHERE status IN ('submitted', 'pending')`;
  const params: unknown[] = [];

  if (exchange) {
    sql += ' AND exchange = ?';
    params.push(exchange);
  }
  if (asset) {
    sql += ' AND asset = ?';
    params.push(asset);
  }

  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

export function updateWithdrawalJob(
  id: string,
  updates: Partial<Pick<WithdrawalJob, 'status' | 'exchangeRef' | 'txid' | 'lastError' | 'pollCount'>>
): void {
  const db = getDb();
  const now = Date.now();

  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.exchangeRef !== undefined) {
    setClauses.push('exchange_ref = ?');
    values.push(updates.exchangeRef);
  }
  if (updates.txid !== undefined) {
    setClauses.push('txid = ?');
    values.push(updates.txid);
  }
  if (updates.lastError !== undefined) {
    setClauses.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.pollCount !== undefined) {
    setClauses.push('poll_count = ?');
    values.push(updates.pollCount);
  }

  values.push(id);

  db.prepare(`UPDATE withdrawal_jobs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function incrementPollCount(id: string): void {
  const db = getDb();
  db.prepare('UPDATE withdrawal_jobs SET poll_count = poll_count + 1, updated_at = ? WHERE id = ?').run(
    Date.now(),
    id
  );
}

function mapWithdrawalJobRow(row: Record<string, unknown>): WithdrawalJob {
  return {
    id: row.id as string,
    exchange: row.exchange as ExchangeId,
    asset: row.asset as string,
    method: row.method as string,
    destKey: row.dest_key as string,
    amount: row.amount as number,
    status: row.status as WithdrawalStatus,
    exchangeRef: row.exchange_ref as string | undefined,
    txid: row.txid as string | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    pollCount: row.poll_count as number,
    lastError: row.last_error as string | undefined,
  };
}

// ============== Fill Events Repository ==============

export function saveFillEvent(exchange: ExchangeId, fill: FillEvent, netReceivedAsset: string, netReceivedAmount: number): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO fill_events
     (id, exchange, order_id, pair, side, order_type, price, volume, cost, fee, fee_currency,
      net_received_asset, net_received_amount, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fill.tradeId,
    exchange,
    fill.orderId,
    fill.pair,
    fill.side,
    fill.orderType,
    fill.price,
    fill.volume,
    fill.cost,
    fill.fee,
    fill.feeCurrency,
    netReceivedAsset,
    netReceivedAmount,
    fill.timestamp
  );
}

export function getFillEventExists(tradeId: string, exchange?: ExchangeId): boolean {
  const db = getDb();
  if (exchange) {
    const row = db.prepare('SELECT 1 FROM fill_events WHERE id = ? AND exchange = ?').get(tradeId, exchange);
    return !!row;
  }
  const row = db.prepare('SELECT 1 FROM fill_events WHERE id = ?').get(tradeId);
  return !!row;
}

// ============== App State Repository ==============

export function getAppStateValue(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppStateValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function isEnabled(): boolean {
  return getAppStateValue('enabled') === 'true';
}

export function setEnabled(enabled: boolean): void {
  setAppStateValue('enabled', enabled ? 'true' : 'false');
}

// ============== API Keys Repository (Multi-Key Support) ==============

export type ApiKeyTier = 'starter' | 'intermediate' | 'pro';

export interface ApiKeyRecord {
  id: string;
  exchange: ExchangeId;
  name: string;
  apiKey: string;
  apiSecret: string;
  tier: ApiKeyTier;
  isActive: boolean;
  isValid: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  rateLimitedUntil: number | null;
  estimatedCounter: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// Tier configurations for all exchanges
const TIER_CONFIG: Record<string, { maxCounter: number; decayRate: number }> = {
  // Kraken tiers
  starter: { maxCounter: 15, decayRate: 0.33 },
  intermediate: { maxCounter: 20, decayRate: 0.5 },
  pro: { maxCounter: 20, decayRate: 1.0 },
  // Gemini tiers
  standard: { maxCounter: 600, decayRate: 10 },
  // KuCoin tiers
  vip1: { maxCounter: 60, decayRate: 6 },
  vip2: { maxCounter: 100, decayRate: 10 },
};

// Default tier config as fallback
const DEFAULT_TIER_CONFIG = { maxCounter: 30, decayRate: 3 };

export function getTierConfig(tier: ApiKeyTier) {
  return TIER_CONFIG[tier] || DEFAULT_TIER_CONFIG;
}

function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  // Decrypt API credentials (safeDecrypt handles both encrypted and plaintext)
  const apiKey = safeDecrypt(row.api_key as string);
  const apiSecret = safeDecrypt(row.api_secret as string);

  return {
    id: row.id as string,
    exchange: (row.exchange || 'kraken') as ExchangeId,
    name: row.name as string,
    apiKey,
    apiSecret,
    tier: row.tier as ApiKeyTier,
    isActive: row.is_active === 1,
    isValid: row.is_valid === 1,
    lastError: row.last_error as string | null,
    lastErrorAt: row.last_error_at as number | null,
    rateLimitedUntil: row.rate_limited_until as number | null,
    estimatedCounter: row.estimated_counter as number,
    lastUsedAt: row.last_used_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function getAllApiKeys(exchange?: ExchangeId): ApiKeyRecord[] {
  const db = getDb();
  if (exchange) {
    const rows = db.prepare('SELECT * FROM api_keys WHERE exchange = ? ORDER BY created_at ASC').all(exchange) as Array<Record<string, unknown>>;
    return rows.map(mapApiKeyRow);
  }
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
  return rows.map(mapApiKeyRow);
}

export function getActiveApiKeys(exchange?: ExchangeId): ApiKeyRecord[] {
  const db = getDb();
  if (exchange) {
    const rows = db
      .prepare('SELECT * FROM api_keys WHERE exchange = ? AND is_active = 1 AND is_valid = 1 ORDER BY created_at ASC')
      .all(exchange) as Array<Record<string, unknown>>;
    return rows.map(mapApiKeyRow);
  }
  const rows = db
    .prepare('SELECT * FROM api_keys WHERE is_active = 1 AND is_valid = 1 ORDER BY created_at ASC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapApiKeyRow);
}

export function getApiKeyById(id: string): ApiKeyRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapApiKeyRow(row) : null;
}

export function createApiKey(
  id: string,
  exchange: ExchangeId,
  name: string,
  apiKey: string,
  apiSecret: string,
  tier: ApiKeyTier = 'starter'
): ApiKeyRecord {
  const db = getDb();
  const now = Date.now();

  // Encrypt API credentials before storing
  const encryptedApiKey = encrypt(apiKey);
  const encryptedApiSecret = encrypt(apiSecret);

  db.prepare(
    `INSERT INTO api_keys (id, exchange, name, api_key, api_secret, tier, is_active, is_valid, estimated_counter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
  ).run(id, exchange, name, encryptedApiKey, encryptedApiSecret, tier, now, now);
  return getApiKeyById(id)!;
}

export function updateApiKey(
  id: string,
  updates: Partial<Pick<ApiKeyRecord, 'name' | 'tier' | 'isActive'>>
): void {
  const db = getDb();
  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    values.push(updates.name);
  }
  if (updates.tier !== undefined) {
    setClauses.push('tier = ?');
    values.push(updates.tier);
  }
  if (updates.isActive !== undefined) {
    setClauses.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }

  values.push(id);
  db.prepare(`UPDATE api_keys SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteApiKey(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function markApiKeyUsed(id: string, counterIncrement: number = 1): void {
  const db = getDb();
  const now = Date.now();

  // Get current state to calculate decayed counter
  const key = getApiKeyById(id);
  if (!key) return;

  const config = TIER_CONFIG[key.tier];
  const elapsed = key.lastUsedAt ? (now - key.lastUsedAt) / 1000 : 0;
  const decayedCounter = Math.max(0, key.estimatedCounter - elapsed * config.decayRate);
  const newCounter = decayedCounter + counterIncrement;

  db.prepare(
    `UPDATE api_keys SET estimated_counter = ?, last_used_at = ?, updated_at = ? WHERE id = ?`
  ).run(newCounter, now, now, id);
}

export function markApiKeyRateLimited(id: string, untilTimestamp: number): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE api_keys SET rate_limited_until = ?, updated_at = ? WHERE id = ?`
  ).run(untilTimestamp, now, id);
}

export function clearApiKeyRateLimit(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE api_keys SET rate_limited_until = NULL, estimated_counter = 0, updated_at = ? WHERE id = ?`
  ).run(now, id);
}

export function markApiKeyInvalid(id: string, error: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE api_keys SET is_valid = 0, last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?`
  ).run(error, now, now, id);
}

export function markApiKeyValid(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE api_keys SET is_valid = 1, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?`
  ).run(now, id);
}

export function hasAnyApiKeys(exchange?: ExchangeId): boolean {
  const db = getDb();
  if (exchange) {
    const row = db.prepare('SELECT 1 FROM api_keys WHERE exchange = ? AND is_active = 1 AND is_valid = 1 LIMIT 1').get(exchange);
    return !!row;
  }
  const row = db.prepare('SELECT 1 FROM api_keys WHERE is_active = 1 AND is_valid = 1 LIMIT 1').get();
  return !!row;
}

/**
 * Migrate existing plaintext API keys to encrypted format
 * This is idempotent - already encrypted keys are skipped
 */
export function migrateApiKeysToEncrypted(): { migrated: number; skipped: number } {
  const db = getDb();
  const rows = db.prepare('SELECT id, api_key, api_secret FROM api_keys').all() as Array<{
    id: string;
    api_key: string;
    api_secret: string;
  }>;

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    const keyEncrypted = isEncrypted(row.api_key);
    const secretEncrypted = isEncrypted(row.api_secret);

    if (keyEncrypted && secretEncrypted) {
      skipped++;
      continue;
    }

    // Encrypt if not already encrypted
    const newApiKey = keyEncrypted ? row.api_key : encrypt(row.api_key);
    const newApiSecret = secretEncrypted ? row.api_secret : encrypt(row.api_secret);

    db.prepare('UPDATE api_keys SET api_key = ?, api_secret = ?, updated_at = ? WHERE id = ?').run(
      newApiKey,
      newApiSecret,
      Date.now(),
      row.id
    );
    migrated++;
  }

  return { migrated, skipped };
}

// Legacy compatibility - get first active key for an exchange (for simple cases)
export function getApiCredentials(exchange: ExchangeId = 'kraken'): { apiKey: string; apiSecret: string } | null {
  const keys = getActiveApiKeys(exchange);
  if (keys.length === 0) return null;
  return { apiKey: keys[0].apiKey, apiSecret: keys[0].apiSecret };
}

// ============== User Repository ==============

export function getUserByUsername(username: string): { id: string; username: string; passwordHash: string } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as { id: string; username: string; password_hash: string } | undefined;

  if (!row) return null;
  return { id: row.id, username: row.username, passwordHash: row.password_hash };
}

export function createUser(username: string, passwordHash: string): string {
  const db = getDb();
  const id = uuid();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    username,
    passwordHash,
    Date.now()
  );
  return id;
}

export function userExists(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM users LIMIT 1').get();
  return !!row;
}

// ============== Exchange Addresses Repository ==============

export interface ExchangeAddressRecord {
  id: number;
  exchange: ExchangeId;
  asset: string;
  method: string;
  key: string;
  address: string;
  createdAt: number;
  lastSeenAt: number;
}

export function getAllExchangeAddresses(exchange?: ExchangeId): ExchangeAddressRecord[] {
  const db = getDb();
  let sql = `SELECT id, exchange, asset, method, key, address, created_at, last_seen_at
             FROM exchange_addresses`;
  const params: unknown[] = [];

  if (exchange) {
    sql += ' WHERE exchange = ?';
    params.push(exchange);
  }
  sql += ' ORDER BY exchange, asset, key';

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    exchange: ExchangeId;
    asset: string;
    method: string;
    key: string;
    address: string;
    created_at: number;
    last_seen_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    exchange: row.exchange,
    asset: row.asset,
    method: row.method,
    key: row.key,
    address: row.address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export function getExchangeAddressesByAsset(exchange: ExchangeId, asset: string): ExchangeAddressRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, exchange, asset, method, key, address, created_at, last_seen_at
       FROM exchange_addresses
       WHERE exchange = ? AND asset = ?
       ORDER BY key`
    )
    .all(exchange, asset) as Array<{
    id: number;
    exchange: ExchangeId;
    asset: string;
    method: string;
    key: string;
    address: string;
    created_at: number;
    last_seen_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    exchange: row.exchange,
    asset: row.asset,
    method: row.method,
    key: row.key,
    address: row.address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export function upsertExchangeAddress(
  exchange: ExchangeId,
  asset: string,
  method: string,
  key: string,
  address: string
): { isNew: boolean } {
  const db = getDb();
  const now = Date.now();

  // Check if it exists
  const existing = db
    .prepare('SELECT id FROM exchange_addresses WHERE exchange = ? AND asset = ? AND key = ?')
    .get(exchange, asset, key) as { id: number } | undefined;

  if (existing) {
    // Update last_seen_at
    db.prepare(
      `UPDATE exchange_addresses
       SET method = ?, address = ?, last_seen_at = ?
       WHERE exchange = ? AND asset = ? AND key = ?`
    ).run(method, address, now, exchange, asset, key);

    return { isNew: false };
  }

  // Insert new
  db.prepare(
    `INSERT INTO exchange_addresses (exchange, asset, method, key, address, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(exchange, asset, method, key, address, now, now);

  return { isNew: true };
}

export function deleteRemovedAddresses(exchange: ExchangeId, currentKeys: Array<{ asset: string; key: string }>): number {
  const db = getDb();

  // Build a set of current asset+key combinations
  const currentSet = new Set(currentKeys.map((k) => `${k.asset}:${k.key}`));

  // Get all addresses for this exchange
  const allAddresses = db
    .prepare('SELECT id, asset, key FROM exchange_addresses WHERE exchange = ?')
    .all(exchange) as Array<{ id: number; asset: string; key: string }>;

  let deletedCount = 0;

  for (const addr of allAddresses) {
    if (!currentSet.has(`${addr.asset}:${addr.key}`)) {
      // This address is no longer on the exchange, delete it
      db.prepare('DELETE FROM exchange_addresses WHERE id = ?').run(addr.id);
      deletedCount++;
    }
  }

  return deletedCount;
}

export function hasAnyExchangeAddresses(exchange?: ExchangeId): boolean {
  const db = getDb();
  if (exchange) {
    const row = db.prepare('SELECT 1 FROM exchange_addresses WHERE exchange = ? LIMIT 1').get(exchange);
    return !!row;
  }
  const row = db.prepare('SELECT 1 FROM exchange_addresses LIMIT 1').get();
  return !!row;
}

// Legacy aliases for backward compatibility
export const getAllKrakenAddresses = () => getAllExchangeAddresses('kraken');
export const getKrakenAddressesByAsset = (asset: string) => getExchangeAddressesByAsset('kraken', asset);
export const getActiveKrakenAddresses = () => getAllExchangeAddresses('kraken');
export const upsertKrakenAddress = (asset: string, method: string, key: string, address: string) =>
  upsertExchangeAddress('kraken', asset, method, key, address);
export const hasAnyKrakenAddresses = () => hasAnyExchangeAddresses('kraken');
export type KrakenAddressRecord = ExchangeAddressRecord;

// ============== Exchange Settings Repository ==============

export interface ExchangeSettingsRecord {
  exchange: ExchangeId;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export function getExchangeSettings(exchange: ExchangeId): ExchangeSettingsRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM exchange_settings WHERE exchange = ?')
    .get(exchange) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    exchange: row.exchange as ExchangeId,
    enabled: row.enabled === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function getAllExchangeSettings(): ExchangeSettingsRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM exchange_settings ORDER BY exchange').all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    exchange: row.exchange as ExchangeId,
    enabled: row.enabled === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }));
}

export function isExchangeEnabled(exchange: ExchangeId): boolean {
  const settings = getExchangeSettings(exchange);
  // Default to enabled if no settings exist
  return settings ? settings.enabled : true;
}

export function setExchangeEnabled(exchange: ExchangeId, enabled: boolean): void {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO exchange_settings (exchange, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(exchange) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run(exchange, enabled ? 1 : 0, now, now);
}

export function getEnabledExchanges(): ExchangeId[] {
  const db = getDb();
  // Get exchanges that either have no settings (default enabled) or are explicitly enabled
  // We need to check api_keys table to know which exchanges have keys
  const rows = db.prepare(`
    SELECT DISTINCT ak.exchange
    FROM api_keys ak
    LEFT JOIN exchange_settings es ON ak.exchange = es.exchange
    WHERE ak.is_active = 1 AND ak.is_valid = 1
      AND (es.enabled IS NULL OR es.enabled = 1)
  `).all() as Array<{ exchange: ExchangeId }>;

  return rows.map((r) => r.exchange);
}

// ============== Asset Configs Repository ==============

export interface AssetConfigRecord {
  exchange: ExchangeId;
  asset: string;
  enabled: boolean;
  threshold: number;
  reserve: number;
  destKeys: string[];
  priority: number;
  cooldownSeconds: number;
  method: string | null;
  chunkAmount: number | null;
  createdAt: number;
  updatedAt: number;
}

function mapAssetConfigRow(row: Record<string, unknown>): AssetConfigRecord {
  return {
    exchange: row.exchange as ExchangeId,
    asset: row.asset as string,
    enabled: row.enabled === 1,
    threshold: row.threshold as number,
    reserve: row.reserve as number,
    destKeys: JSON.parse(row.dest_keys as string),
    priority: (row.priority as number) ?? 10,
    cooldownSeconds: (row.cooldown_seconds as number) ?? 60,
    method: row.method as string | null,
    chunkAmount: row.chunk_amount as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function getAssetConfig(exchange: ExchangeId, asset: string): AssetConfigRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM asset_configs WHERE exchange = ? AND asset = ?')
    .get(exchange, asset) as Record<string, unknown> | undefined;
  return row ? mapAssetConfigRow(row) : null;
}

export function getAllAssetConfigs(exchange?: ExchangeId): AssetConfigRecord[] {
  const db = getDb();
  let sql = 'SELECT * FROM asset_configs';
  const params: unknown[] = [];

  if (exchange) {
    sql += ' WHERE exchange = ?';
    params.push(exchange);
  }
  sql += ' ORDER BY exchange, asset';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapAssetConfigRow);
}

export function getEnabledAssetConfigs(exchange?: ExchangeId): AssetConfigRecord[] {
  const db = getDb();
  let sql = 'SELECT * FROM asset_configs WHERE enabled = 1';
  const params: unknown[] = [];

  if (exchange) {
    sql += ' AND exchange = ?';
    params.push(exchange);
  }
  sql += ' ORDER BY exchange, asset';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapAssetConfigRow);
}

export interface AssetConfigInput {
  enabled?: boolean;
  threshold: number;
  reserve?: number;
  destKeys: string[];
  priority?: number;
  cooldownSeconds?: number;
  method?: string | null;
  chunkAmount?: number | null;
}

export function upsertAssetConfig(
  exchange: ExchangeId,
  asset: string,
  config: AssetConfigInput
): void {
  const db = getDb();
  const now = Date.now();
  const enabled = config.enabled !== undefined ? config.enabled : true;
  const reserve = config.reserve ?? 0;
  const priority = config.priority ?? 10;
  const cooldownSeconds = config.cooldownSeconds ?? 60;
  const method = config.method ?? null;
  const chunkAmount = config.chunkAmount ?? null;

  db.prepare(
    `INSERT INTO asset_configs (exchange, asset, enabled, threshold, reserve, dest_keys, priority, cooldown_seconds, method, chunk_amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exchange, asset) DO UPDATE SET
       enabled = excluded.enabled,
       threshold = excluded.threshold,
       reserve = excluded.reserve,
       dest_keys = excluded.dest_keys,
       priority = excluded.priority,
       cooldown_seconds = excluded.cooldown_seconds,
       method = excluded.method,
       chunk_amount = excluded.chunk_amount,
       updated_at = excluded.updated_at`
  ).run(
    exchange,
    asset,
    enabled ? 1 : 0,
    config.threshold,
    reserve,
    JSON.stringify(config.destKeys),
    priority,
    cooldownSeconds,
    method,
    chunkAmount,
    now,
    now
  );
}

export function deleteAssetConfig(exchange: ExchangeId, asset: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM asset_configs WHERE exchange = ? AND asset = ?').run(exchange, asset);
  return result.changes > 0;
}

export function setAssetConfigEnabled(exchange: ExchangeId, asset: string, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE asset_configs SET enabled = ?, updated_at = ? WHERE exchange = ? AND asset = ?').run(
    enabled ? 1 : 0,
    Date.now(),
    exchange,
    asset
  );
}

export function hasAnyAssetConfigs(exchange?: ExchangeId): boolean {
  const db = getDb();
  if (exchange) {
    const row = db.prepare('SELECT 1 FROM asset_configs WHERE exchange = ? LIMIT 1').get(exchange);
    return !!row;
  }
  const row = db.prepare('SELECT 1 FROM asset_configs LIMIT 1').get();
  return !!row;
}

// ============== Wallet Storage Repository ==============

export type WalletChain = 'ethereum' | 'bitcoin' | 'solana' | 'xrp' | 'xlm' | 'lunc' | 'algorand' | 'cardano';

export interface WalletRecord {
  id: string;
  name: string;
  chain: WalletChain;
  address: string;
  encryptedPrivateKey: string;
  salt: string;
  encryptedMnemonic?: string;
  mnemonicSalt?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WalletPublicRecord {
  id: string;
  name: string;
  chain: WalletChain;
  address: string;
  createdAt: number;
}

function mapWalletRow(row: Record<string, unknown>): WalletRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    chain: (row.chain as WalletChain) || 'ethereum',
    address: row.address as string,
    encryptedPrivateKey: row.encrypted_private_key as string,
    salt: row.salt as string,
    encryptedMnemonic: row.encrypted_mnemonic as string | undefined,
    mnemonicSalt: row.mnemonic_salt as string | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapWalletPublicRow(row: Record<string, unknown>): WalletPublicRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    chain: (row.chain as WalletChain) || 'ethereum',
    address: row.address as string,
    createdAt: row.created_at as number,
  };
}

export function getAllWallets(chain?: WalletChain): WalletPublicRecord[] {
  const db = getDb();
  if (chain) {
    const rows = db.prepare('SELECT id, name, chain, address, created_at FROM wallets WHERE chain = ? ORDER BY created_at DESC').all(chain) as Array<Record<string, unknown>>;
    return rows.map(mapWalletPublicRow);
  }
  const rows = db.prepare('SELECT id, name, chain, address, created_at FROM wallets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(mapWalletPublicRow);
}

export function getWalletById(id: string): WalletRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapWalletRow(row) : null;
}

export function getWalletByAddress(address: string): WalletRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM wallets WHERE address = ?').get(address) as Record<string, unknown> | undefined;
  return row ? mapWalletRow(row) : null;
}

export function createWallet(
  id: string,
  name: string,
  chain: WalletChain,
  address: string,
  encryptedPrivateKey: string,
  salt: string,
  encryptedMnemonic?: string,
  mnemonicSalt?: string
): WalletRecord {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO wallets (id, name, chain, address, encrypted_private_key, salt, encrypted_mnemonic, mnemonic_salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, chain, address, encryptedPrivateKey, salt, encryptedMnemonic ?? null, mnemonicSalt ?? null, now, now);

  return {
    id,
    name,
    chain,
    address,
    encryptedPrivateKey,
    salt,
    encryptedMnemonic,
    mnemonicSalt,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateWallet(id: string, updates: { name?: string; encryptedPrivateKey?: string; salt?: string }): void {
  const db = getDb();
  const now = Date.now();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.encryptedPrivateKey !== undefined) {
    fields.push('encrypted_private_key = ?');
    values.push(updates.encryptedPrivateKey);
  }
  if (updates.salt !== undefined) {
    fields.push('salt = ?');
    values.push(updates.salt);
  }

  values.push(id);
  db.prepare(`UPDATE wallets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteWallet(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM wallets WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============== Wallet Settings Repository ==============

export function getWalletSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM wallet_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setWalletSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO wallet_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function deleteWalletSetting(key: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM wallet_settings WHERE key = ?').run(key);
  return result.changes > 0;
}

// ============== Withdrawal Methods Cache ==============

export interface WithdrawalMethodRecord {
  id: number;
  exchange: ExchangeId;
  asset: string;
  method: string;
  network: string | null;
  minimum: number;
  maximum: number | null;
  fee: number | null;
  genAddress: boolean;
  lastSyncedAt: number;
  createdAt: number;
  updatedAt: number;
}

export function getWithdrawalMethod(
  exchange: ExchangeId,
  asset: string,
  method: string
): WithdrawalMethodRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, exchange, asset, method, network, minimum, maximum, fee,
              gen_address, last_synced_at, created_at, updated_at
       FROM withdrawal_methods
       WHERE exchange = ? AND asset = ? AND method = ?`
    )
    .get(exchange, asset, method) as {
    id: number;
    exchange: ExchangeId;
    asset: string;
    method: string;
    network: string | null;
    minimum: number;
    maximum: number | null;
    fee: number | null;
    gen_address: number;
    last_synced_at: number;
    created_at: number;
    updated_at: number;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    exchange: row.exchange,
    asset: row.asset,
    method: row.method,
    network: row.network,
    minimum: row.minimum,
    maximum: row.maximum,
    fee: row.fee,
    genAddress: row.gen_address === 1,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getWithdrawalMethodsForAsset(
  exchange: ExchangeId,
  asset: string
): WithdrawalMethodRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, exchange, asset, method, network, minimum, maximum, fee,
              gen_address, last_synced_at, created_at, updated_at
       FROM withdrawal_methods
       WHERE exchange = ? AND asset = ?
       ORDER BY method`
    )
    .all(exchange, asset) as Array<{
    id: number;
    exchange: ExchangeId;
    asset: string;
    method: string;
    network: string | null;
    minimum: number;
    maximum: number | null;
    fee: number | null;
    gen_address: number;
    last_synced_at: number;
    created_at: number;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    exchange: row.exchange,
    asset: row.asset,
    method: row.method,
    network: row.network,
    minimum: row.minimum,
    maximum: row.maximum,
    fee: row.fee,
    genAddress: row.gen_address === 1,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getAllWithdrawalMethods(exchange?: ExchangeId): WithdrawalMethodRecord[] {
  const db = getDb();
  let query = `SELECT id, exchange, asset, method, network, minimum, maximum, fee,
                      gen_address, last_synced_at, created_at, updated_at
               FROM withdrawal_methods`;
  const params: string[] = [];

  if (exchange) {
    query += ' WHERE exchange = ?';
    params.push(exchange);
  }

  query += ' ORDER BY exchange, asset, method';

  const rows = db.prepare(query).all(...params) as Array<{
    id: number;
    exchange: ExchangeId;
    asset: string;
    method: string;
    network: string | null;
    minimum: number;
    maximum: number | null;
    fee: number | null;
    gen_address: number;
    last_synced_at: number;
    created_at: number;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    exchange: row.exchange,
    asset: row.asset,
    method: row.method,
    network: row.network,
    minimum: row.minimum,
    maximum: row.maximum,
    fee: row.fee,
    genAddress: row.gen_address === 1,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function upsertWithdrawalMethod(
  exchange: ExchangeId,
  asset: string,
  method: string,
  data: {
    network?: string;
    minimum: number;
    maximum?: number;
    fee?: number;
    genAddress?: boolean;
  }
): void {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO withdrawal_methods (exchange, asset, method, network, minimum, maximum, fee, gen_address, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(exchange, asset, method) DO UPDATE SET
       network = excluded.network,
       minimum = excluded.minimum,
       maximum = excluded.maximum,
       fee = excluded.fee,
       gen_address = excluded.gen_address,
       last_synced_at = excluded.last_synced_at,
       updated_at = excluded.updated_at`
  ).run(
    exchange,
    asset,
    method,
    data.network ?? null,
    data.minimum,
    data.maximum ?? null,
    data.fee ?? null,
    data.genAddress ? 1 : 0,
    now,
    now,
    now
  );
}

export function deleteWithdrawalMethodsForExchange(exchange: ExchangeId): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM withdrawal_methods WHERE exchange = ?').run(exchange);
  return result.changes;
}

export function isWithdrawalMethodCacheStale(
  exchange: ExchangeId,
  maxAgeMs: number = 24 * 60 * 60 * 1000 // 24 hours default
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MIN(last_synced_at) as oldest_sync
       FROM withdrawal_methods
       WHERE exchange = ?`
    )
    .get(exchange) as { oldest_sync: number | null } | undefined;

  if (!row || row.oldest_sync === null) {
    return true; // No cache exists
  }

  return Date.now() - row.oldest_sync > maxAgeMs;
}

// ============== Global Settings Repository ==============

export interface GlobalSettings {
  dryRun: boolean;
  maxInflightWithdrawals: number;
  perAssetMaxInflight: number;
  keyNamePrefix: string;
  allowedOrderTypes: string[];
}

const SETTINGS_DEFAULTS: GlobalSettings = {
  dryRun: false,
  maxInflightWithdrawals: 2,
  perAssetMaxInflight: 1,
  keyNamePrefix: '',
  allowedOrderTypes: ['limit', 'take_profit', 'take_profit_limit'],
};

export function getSetting<K extends keyof GlobalSettings>(key: K): GlobalSettings[K] {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;

  if (!row) {
    return SETTINGS_DEFAULTS[key];
  }

  try {
    return JSON.parse(row.value) as GlobalSettings[K];
  } catch {
    return SETTINGS_DEFAULTS[key];
  }
}

export function setSetting<K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]): void {
  const db = getDb();
  const now = Date.now();
  const jsonValue = JSON.stringify(value);

  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, jsonValue, now);
}

export function getAllSettings(): GlobalSettings {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;

  const settings = { ...SETTINGS_DEFAULTS };

  for (const row of rows) {
    try {
      const key = row.key as keyof GlobalSettings;
      if (key in SETTINGS_DEFAULTS) {
        (settings as Record<string, unknown>)[key] = JSON.parse(row.value);
      }
    } catch {
      // Skip invalid values
    }
  }

  return settings;
}

export function setAllSettings(settings: Partial<GlobalSettings>): void {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  );

  for (const [key, value] of Object.entries(settings)) {
    if (key in SETTINGS_DEFAULTS && value !== undefined) {
      stmt.run(key, JSON.stringify(value), now);
    }
  }
}

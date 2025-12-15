import { v4 as uuid } from 'uuid';
import { getDb } from './sqlite.js';
import type {
  AssetState,
  WithdrawalJob,
  WithdrawalStatus,
  FillEvent,
  AppState,
} from '../domain/types.js';

// ============== Asset State Repository ==============

export function getAssetState(asset: string): AssetState | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT asset, pending_amount, rr_index, last_withdraw_at,
              consecutive_failures, backoff_until
       FROM asset_state WHERE asset = ?`
    )
    .get(asset) as {
    asset: string;
    pending_amount: number;
    rr_index: number;
    last_withdraw_at: number | null;
    consecutive_failures: number;
    backoff_until: number | null;
  } | undefined;

  if (!row) return null;

  return {
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
export function getRecentFills(limit = 50): FillEvent[] {
  const db = getDb();
  const stmt = db.prepare<[number]>('SELECT * FROM fill_events ORDER BY ts DESC LIMIT ?');
  const rows = stmt.all(limit) as any[];

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
  }));
}

export function getAllAssetStates(): AssetState[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT asset, pending_amount, rr_index, last_withdraw_at,
              consecutive_failures, backoff_until
       FROM asset_state`
    )
    .all() as Array<{
    asset: string;
    pending_amount: number;
    rr_index: number;
    last_withdraw_at: number | null;
    consecutive_failures: number;
    backoff_until: number | null;
  }>;

  return rows.map((row) => ({
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
    `INSERT INTO asset_state (asset, pending_amount, rr_index, last_withdraw_at, consecutive_failures, backoff_until)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset) DO UPDATE SET
       pending_amount = excluded.pending_amount,
       rr_index = excluded.rr_index,
       last_withdraw_at = excluded.last_withdraw_at,
       consecutive_failures = excluded.consecutive_failures,
       backoff_until = excluded.backoff_until`
  ).run(
    state.asset,
    state.pendingAmount,
    state.rrIndex,
    state.lastWithdrawAt,
    state.consecutiveFailures,
    state.backoffUntil
  );
}

export function addPendingAmount(asset: string, amount: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO asset_state (asset, pending_amount, rr_index, consecutive_failures)
     VALUES (?, ?, 0, 0)
     ON CONFLICT(asset) DO UPDATE SET
       pending_amount = pending_amount + ?`
  ).run(asset, amount, amount);
}

export function subtractPendingAmount(asset: string, amount: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE asset_state SET pending_amount = MAX(0, pending_amount - ?) WHERE asset = ?`
  ).run(amount, asset);
}

export function advanceRrIndex(asset: string, walletCount: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE asset_state SET rr_index = (rr_index + 1) % ? WHERE asset = ?`
  ).run(walletCount, asset);
}

export function recordWithdrawalAttempt(asset: string, success: boolean, backoffUntil?: number): void {
  const db = getDb();
  const now = Date.now();

  if (success) {
    db.prepare(
      `UPDATE asset_state SET
         last_withdraw_at = ?,
         consecutive_failures = 0,
         backoff_until = NULL
       WHERE asset = ?`
    ).run(now, asset);
  } else {
    db.prepare(
      `UPDATE asset_state SET
         consecutive_failures = consecutive_failures + 1,
         backoff_until = ?
       WHERE asset = ?`
    ).run(backoffUntil || null, asset);
  }
}

// ============== Withdrawal Jobs Repository ==============

export function createWithdrawalJob(
  asset: string,
  method: string,
  destKey: string,
  amount: number
): WithdrawalJob {
  const db = getDb();
  const now = Date.now();
  const job: WithdrawalJob = {
    id: uuid(),
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
     (id, asset, method, dest_key, amount, status, created_at, updated_at, poll_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(job.id, job.asset, job.method, job.destKey, job.amount, job.status, job.createdAt, job.updatedAt, job.pollCount);

  return job;
}

export function getWithdrawalJob(id: string): WithdrawalJob | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM withdrawal_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapWithdrawalJobRow(row) : null;
}

export function getActiveWithdrawalJobs(): WithdrawalJob[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM withdrawal_jobs
       WHERE status IN ('submitted', 'pending')
       ORDER BY created_at ASC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map(mapWithdrawalJobRow);
}

export function getInflightCount(asset?: string): number {
  const db = getDb();
  if (asset) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM withdrawal_jobs
         WHERE asset = ? AND status IN ('submitted', 'pending')`
      )
      .get(asset) as { count: number };
    return row.count;
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM withdrawal_jobs
       WHERE status IN ('submitted', 'pending')`
    )
    .get() as { count: number };
  return row.count;
}

export function updateWithdrawalJob(
  id: string,
  updates: Partial<Pick<WithdrawalJob, 'status' | 'krakenRef' | 'txid' | 'lastError' | 'pollCount'>>
): void {
  const db = getDb();
  const now = Date.now();

  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.krakenRef !== undefined) {
    setClauses.push('kraken_ref = ?');
    values.push(updates.krakenRef);
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
    asset: row.asset as string,
    method: row.method as string,
    destKey: row.dest_key as string,
    amount: row.amount as number,
    status: row.status as WithdrawalStatus,
    krakenRef: row.kraken_ref as string | undefined,
    txid: row.txid as string | undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    pollCount: row.poll_count as number,
    lastError: row.last_error as string | undefined,
  };
}

// ============== Fill Events Repository ==============

export function saveFillEvent(fill: FillEvent, netReceivedAsset: string, netReceivedAmount: number): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO fill_events
     (id, order_id, pair, side, order_type, price, volume, cost, fee, fee_currency,
      net_received_asset, net_received_amount, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fill.tradeId,
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

export function getFillEventExists(tradeId: string): boolean {
  const db = getDb();
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

const TIER_CONFIG: Record<ApiKeyTier, { maxCounter: number; decayRate: number }> = {
  starter: { maxCounter: 15, decayRate: 0.33 },
  intermediate: { maxCounter: 20, decayRate: 0.5 },
  pro: { maxCounter: 20, decayRate: 1.0 },
};

export function getTierConfig(tier: ApiKeyTier) {
  return TIER_CONFIG[tier];
}

function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    apiKey: row.api_key as string,
    apiSecret: row.api_secret as string,
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

export function getAllApiKeys(): ApiKeyRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at ASC').all() as Array<Record<string, unknown>>;
  return rows.map(mapApiKeyRow);
}

export function getActiveApiKeys(): ApiKeyRecord[] {
  const db = getDb();
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
  name: string,
  apiKey: string,
  apiSecret: string,
  tier: ApiKeyTier = 'starter'
): ApiKeyRecord {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO api_keys (id, name, api_key, api_secret, tier, is_active, is_valid, estimated_counter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?, ?)`
  ).run(id, name, apiKey, apiSecret, tier, now, now);
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

export function hasAnyApiKeys(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM api_keys WHERE is_active = 1 AND is_valid = 1 LIMIT 1').get();
  return !!row;
}

// Legacy compatibility - get first active key (for simple cases)
export function getApiCredentials(): { apiKey: string; apiSecret: string } | null {
  const keys = getActiveApiKeys();
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

// ============== Kraken Addresses Repository ==============

export interface KrakenAddressRecord {
  id: number;
  asset: string;
  method: string;
  key: string;
  address: string;
  createdAt: number;
  lastSeenAt: number;
  removedAt: number | null;
}

export function getAllKrakenAddresses(): KrakenAddressRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, asset, method, key, address, created_at, last_seen_at, removed_at
       FROM kraken_addresses
       ORDER BY asset, key`
    )
    .all() as Array<{
    id: number;
    asset: string;
    method: string;
    key: string;
    address: string;
    created_at: number;
    last_seen_at: number;
    removed_at: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    asset: row.asset,
    method: row.method,
    key: row.key,
    address: row.address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
  }));
}

export function getKrakenAddressesByAsset(asset: string): KrakenAddressRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, asset, method, key, address, created_at, last_seen_at, removed_at
       FROM kraken_addresses
       WHERE asset = ?
       ORDER BY key`
    )
    .all(asset) as Array<{
    id: number;
    asset: string;
    method: string;
    key: string;
    address: string;
    created_at: number;
    last_seen_at: number;
    removed_at: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    asset: row.asset,
    method: row.method,
    key: row.key,
    address: row.address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
  }));
}

export function getActiveKrakenAddresses(): KrakenAddressRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, asset, method, key, address, created_at, last_seen_at, removed_at
       FROM kraken_addresses
       WHERE removed_at IS NULL
       ORDER BY asset, key`
    )
    .all() as Array<{
    id: number;
    asset: string;
    method: string;
    key: string;
    address: string;
    created_at: number;
    last_seen_at: number;
    removed_at: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    asset: row.asset,
    method: row.method,
    key: row.key,
    address: row.address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
  }));
}

export function upsertKrakenAddress(
  asset: string,
  method: string,
  key: string,
  address: string
): { isNew: boolean; wasRemoved: boolean } {
  const db = getDb();
  const now = Date.now();

  // Check if it exists
  const existing = db
    .prepare('SELECT id, removed_at FROM kraken_addresses WHERE asset = ? AND key = ?')
    .get(asset, key) as { id: number; removed_at: number | null } | undefined;

  if (existing) {
    // Update last_seen_at and clear removed_at if it was flagged
    db.prepare(
      `UPDATE kraken_addresses
       SET method = ?, address = ?, last_seen_at = ?, removed_at = NULL
       WHERE asset = ? AND key = ?`
    ).run(method, address, now, asset, key);

    return { isNew: false, wasRemoved: existing.removed_at !== null };
  }

  // Insert new
  db.prepare(
    `INSERT INTO kraken_addresses (asset, method, key, address, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(asset, method, key, address, now, now);

  return { isNew: true, wasRemoved: false };
}

export function flagRemovedAddresses(currentKeys: Array<{ asset: string; key: string }>): number {
  const db = getDb();
  const now = Date.now();

  // Build a set of current asset+key combinations
  const currentSet = new Set(currentKeys.map((k) => `${k.asset}:${k.key}`));

  // Get all addresses that are currently not flagged as removed
  const activeAddresses = db
    .prepare('SELECT id, asset, key FROM kraken_addresses WHERE removed_at IS NULL')
    .all() as Array<{ id: number; asset: string; key: string }>;

  let flaggedCount = 0;

  for (const addr of activeAddresses) {
    if (!currentSet.has(`${addr.asset}:${addr.key}`)) {
      // This address is no longer in Kraken, flag it
      db.prepare('UPDATE kraken_addresses SET removed_at = ? WHERE id = ?').run(now, addr.id);
      flaggedCount++;
    }
  }

  return flaggedCount;
}

export function hasAnyKrakenAddresses(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM kraken_addresses LIMIT 1').get();
  return !!row;
}

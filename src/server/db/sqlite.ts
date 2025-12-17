import Database from 'better-sqlite3';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('sqlite');

// Use MOBY_DATA_PATH (set by Electron) or fall back to local data folder
const dataDir = process.env.MOBY_DATA_PATH || './data';
const DB_PATH = process.env.DB_PATH || `${dataDir}/moby.db`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): Database.Database {
  if (db) {
    return db;
  }

  logger.info({ path: DB_PATH }, 'Initializing SQLite database');

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// Single consolidated schema for v1.0 release
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema_v1',
    sql: `
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      -- App state (key-value store for flags like 'enabled')
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Global settings (editable in UI)
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- User credentials (for local auth)
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- API keys (multi-key, multi-exchange support)
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL,
        api_secret TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'starter',
        is_active INTEGER NOT NULL DEFAULT 1,
        is_valid INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        last_error_at INTEGER,
        rate_limited_until INTEGER,
        estimated_counter REAL NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active, is_valid);
      CREATE INDEX IF NOT EXISTS idx_api_keys_exchange ON api_keys(exchange);

      -- Exchange-level settings (enabled toggle per exchange)
      CREATE TABLE IF NOT EXISTS exchange_settings (
        exchange TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Exchange withdrawal addresses (synced from exchanges)
      CREATE TABLE IF NOT EXISTS exchange_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange TEXT NOT NULL,
        asset TEXT NOT NULL,
        method TEXT NOT NULL,
        key TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(exchange, asset, key)
      );
      CREATE INDEX IF NOT EXISTS idx_exchange_addresses_exchange ON exchange_addresses(exchange);
      CREATE INDEX IF NOT EXISTS idx_exchange_addresses_asset ON exchange_addresses(asset);

      -- Withdrawal methods cache (minimums, fees per asset/method)
      CREATE TABLE IF NOT EXISTS withdrawal_methods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange TEXT NOT NULL,
        asset TEXT NOT NULL,
        method TEXT NOT NULL,
        network TEXT,
        minimum REAL NOT NULL,
        maximum REAL,
        fee REAL,
        gen_address INTEGER NOT NULL DEFAULT 0,
        last_synced_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(exchange, asset, method)
      );
      CREATE INDEX IF NOT EXISTS idx_withdrawal_methods_exchange_asset ON withdrawal_methods(exchange, asset);

      -- Asset sweep configurations
      CREATE TABLE IF NOT EXISTS asset_configs (
        exchange TEXT NOT NULL,
        asset TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        threshold REAL NOT NULL,
        reserve REAL NOT NULL DEFAULT 0,
        dest_keys TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 10,
        cooldown_seconds INTEGER NOT NULL DEFAULT 60,
        method TEXT,
        chunk_mode TEXT NOT NULL DEFAULT 'fixedCoin',
        chunk_amount REAL,
        chunk_max REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (exchange, asset)
      );
      CREATE INDEX IF NOT EXISTS idx_asset_configs_exchange ON asset_configs(exchange);
      CREATE INDEX IF NOT EXISTS idx_asset_configs_enabled ON asset_configs(enabled);

      -- Asset state (pending amounts, round-robin indices)
      CREATE TABLE IF NOT EXISTS asset_state (
        exchange TEXT NOT NULL,
        asset TEXT NOT NULL,
        pending_amount REAL NOT NULL DEFAULT 0,
        rr_index INTEGER NOT NULL DEFAULT 0,
        last_withdraw_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until INTEGER,
        PRIMARY KEY (exchange, asset)
      );

      -- Withdrawal jobs
      CREATE TABLE IF NOT EXISTS withdrawal_jobs (
        id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        asset TEXT NOT NULL,
        method TEXT NOT NULL,
        dest_key TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        exchange_ref TEXT,
        txid TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        poll_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_exchange ON withdrawal_jobs(exchange);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_asset ON withdrawal_jobs(asset);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_status ON withdrawal_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_created ON withdrawal_jobs(created_at);

      -- Fill events (trade audit trail)
      CREATE TABLE IF NOT EXISTS fill_events (
        id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        order_id TEXT NOT NULL,
        pair TEXT NOT NULL,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        price REAL NOT NULL,
        volume REAL NOT NULL,
        cost REAL NOT NULL,
        fee REAL NOT NULL,
        fee_currency TEXT NOT NULL,
        net_received_asset TEXT NOT NULL,
        net_received_amount REAL NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fill_events_ts ON fill_events(ts);
      CREATE INDEX IF NOT EXISTS idx_fill_events_asset ON fill_events(net_received_asset);
      CREATE INDEX IF NOT EXISTS idx_fill_events_exchange ON fill_events(exchange);

      -- Wallet storage (generated wallets, multi-chain)
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        chain TEXT NOT NULL DEFAULT 'ethereum',
        address TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        salt TEXT NOT NULL,
        encrypted_mnemonic TEXT,
        mnemonic_salt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(chain, address)
      );
      CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
      CREATE INDEX IF NOT EXISTS idx_wallets_chain ON wallets(chain);

      -- Wallet settings (password hash, etc.)
      CREATE TABLE IF NOT EXISTS wallet_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'app_config_table',
    sql: `
      -- App configuration stored in the database (replaces config.yaml)
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

function runMigrations(database: Database.Database): void {
  // Get current version
  const versionTableExists = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();

  let currentVersion = 0;

  if (versionTableExists) {
    const row = database.prepare('SELECT MAX(version) as version FROM schema_version').get() as
      | { version: number }
      | undefined;
    currentVersion = row?.version || 0;
  }

  logger.info({ currentVersion }, 'Current schema version');

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      logger.info({ version: migration.version, name: migration.name }, 'Running migration');

      // Run each SQL statement from the migration
      const statements = migration.sql.split(';').filter(s => s.trim());
      for (const stmt of statements) {
        if (stmt.trim()) {
          database.prepare(stmt).run();
        }
      }

      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);

      logger.info({ version: migration.version }, 'Migration complete');
    }
  }
}

// Export for testing
export { MIGRATIONS };

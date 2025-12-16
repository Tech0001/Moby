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

// Migrations
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- Asset state for tracking pending amounts and round-robin indices
      CREATE TABLE IF NOT EXISTS asset_state (
        asset TEXT PRIMARY KEY,
        pending_amount REAL NOT NULL DEFAULT 0,
        rr_index INTEGER NOT NULL DEFAULT 0,
        last_withdraw_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until INTEGER
      );

      -- Withdrawal jobs
      CREATE TABLE IF NOT EXISTS withdrawal_jobs (
        id TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        method TEXT NOT NULL,
        dest_key TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        kraken_ref TEXT,
        txid TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        poll_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_asset ON withdrawal_jobs(asset);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_status ON withdrawal_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_created ON withdrawal_jobs(created_at);

      -- Fill events (for audit trail)
      CREATE TABLE IF NOT EXISTS fill_events (
        id TEXT PRIMARY KEY,
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

      -- App state (key-value store for flags)
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- User credentials (for local auth)
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- API credentials (encrypted storage)
      CREATE TABLE IF NOT EXISTS api_credentials (
        id TEXT PRIMARY KEY DEFAULT 'default',
        api_key TEXT NOT NULL,
        api_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `,
  },
  {
    version: 2,
    name: 'kraken_addresses',
    sql: `
      -- Kraken withdrawal addresses (synced from exchange)
      CREATE TABLE IF NOT EXISTS kraken_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset TEXT NOT NULL,
        method TEXT NOT NULL,
        key TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        removed_at INTEGER,
        UNIQUE(asset, key)
      );

      CREATE INDEX IF NOT EXISTS idx_kraken_addresses_asset ON kraken_addresses(asset);
      CREATE INDEX IF NOT EXISTS idx_kraken_addresses_removed ON kraken_addresses(removed_at);
    `,
  },
  {
    version: 3,
    name: 'multi_api_keys',
    sql: `
      -- Drop old single-key table and create multi-key table
      DROP TABLE IF EXISTS api_credentials;

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
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
    `,
  },
  {
    version: 4,
    name: 'multi_exchange_support',
    sql: `
      -- Add exchange column to api_keys
      ALTER TABLE api_keys ADD COLUMN exchange TEXT NOT NULL DEFAULT 'kraken';

      -- Add exchange column to fill_events
      ALTER TABLE fill_events ADD COLUMN exchange TEXT NOT NULL DEFAULT 'kraken';

      -- Recreate asset_state with composite primary key (exchange, asset)
      CREATE TABLE asset_state_new (
        exchange TEXT NOT NULL DEFAULT 'kraken',
        asset TEXT NOT NULL,
        pending_amount REAL NOT NULL DEFAULT 0,
        rr_index INTEGER NOT NULL DEFAULT 0,
        last_withdraw_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until INTEGER,
        PRIMARY KEY (exchange, asset)
      );
      INSERT INTO asset_state_new (exchange, asset, pending_amount, rr_index, last_withdraw_at, consecutive_failures, backoff_until)
        SELECT 'kraken', asset, pending_amount, rr_index, last_withdraw_at, consecutive_failures, backoff_until FROM asset_state;
      DROP TABLE asset_state;
      ALTER TABLE asset_state_new RENAME TO asset_state;

      -- Recreate withdrawal_jobs with exchange column and rename kraken_ref to exchange_ref
      CREATE TABLE withdrawal_jobs_new (
        id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL DEFAULT 'kraken',
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
      INSERT INTO withdrawal_jobs_new (id, exchange, asset, method, dest_key, amount, status, exchange_ref, txid, created_at, updated_at, poll_count, last_error)
        SELECT id, 'kraken', asset, method, dest_key, amount, status, kraken_ref, txid, created_at, updated_at, poll_count, last_error FROM withdrawal_jobs;
      DROP TABLE withdrawal_jobs;
      ALTER TABLE withdrawal_jobs_new RENAME TO withdrawal_jobs;
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_exchange ON withdrawal_jobs(exchange);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_asset ON withdrawal_jobs(asset);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_status ON withdrawal_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_jobs_created ON withdrawal_jobs(created_at);

      -- Rename kraken_addresses to exchange_addresses and add exchange column
      CREATE TABLE exchange_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange TEXT NOT NULL DEFAULT 'kraken',
        asset TEXT NOT NULL,
        method TEXT NOT NULL,
        key TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(exchange, asset, key)
      );
      INSERT INTO exchange_addresses (id, exchange, asset, method, key, address, created_at, last_seen_at)
        SELECT id, 'kraken', asset, method, key, address, created_at, last_seen_at FROM kraken_addresses WHERE removed_at IS NULL;
      DROP TABLE kraken_addresses;
      CREATE INDEX IF NOT EXISTS idx_exchange_addresses_exchange ON exchange_addresses(exchange);
      CREATE INDEX IF NOT EXISTS idx_exchange_addresses_asset ON exchange_addresses(asset);
    `,
  },
  {
    version: 5,
    name: 'asset_configs_table',
    sql: `
      -- Asset sweep configurations (moved from YAML to database)
      CREATE TABLE IF NOT EXISTS asset_configs (
        exchange TEXT NOT NULL,
        asset TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        threshold REAL NOT NULL,
        reserve REAL NOT NULL DEFAULT 0,
        dest_keys TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (exchange, asset)
      );

      CREATE INDEX IF NOT EXISTS idx_asset_configs_exchange ON asset_configs(exchange);
      CREATE INDEX IF NOT EXISTS idx_asset_configs_enabled ON asset_configs(enabled);
    `,
  },
  {
    version: 6,
    name: 'exchange_settings_and_asset_config_extensions',
    sql: `
      -- Exchange-level settings (enabled toggle per exchange)
      CREATE TABLE IF NOT EXISTS exchange_settings (
        exchange TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Add missing columns to asset_configs for priority, cooldown, and chunking
      ALTER TABLE asset_configs ADD COLUMN priority INTEGER NOT NULL DEFAULT 10;
      ALTER TABLE asset_configs ADD COLUMN cooldown_seconds INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE asset_configs ADD COLUMN method TEXT;
      ALTER TABLE asset_configs ADD COLUMN chunk_mode TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE asset_configs ADD COLUMN chunk_amount REAL;
      ALTER TABLE asset_configs ADD COLUMN chunk_max REAL;
    `,
  },
  {
    version: 7,
    name: 'remove_all_chunk_mode',
    sql: `
      -- Update any existing 'all' chunk modes to 'fixedCoin'
      UPDATE asset_configs SET chunk_mode = 'fixedCoin' WHERE chunk_mode = 'all';
    `,
  },
  {
    version: 8,
    name: 'wallet_management',
    sql: `
      -- Wallet storage for generated wallets (multi-chain)
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        chain TEXT NOT NULL DEFAULT 'ethereum',
        address TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        salt TEXT NOT NULL,
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
    version: 9,
    name: 'add_wallet_chain_column',
    sql: `
      -- No-op: chain column now included in migration 8
      -- This migration was for databases that ran an older v8 without the chain column
      SELECT 1;
    `,
  },
  {
    version: 10,
    name: 'add_wallet_mnemonic',
    sql: `
      -- Add encrypted mnemonic column for seed phrase storage
      ALTER TABLE wallets ADD COLUMN encrypted_mnemonic TEXT;
      ALTER TABLE wallets ADD COLUMN mnemonic_salt TEXT;
    `,
  },
  {
    version: 11,
    name: 'withdrawal_methods_cache',
    sql: `
      -- Cache withdrawal methods with minimums and fees per asset/method
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

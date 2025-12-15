import Database from 'better-sqlite3';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('sqlite');

const DB_PATH = process.env.DB_PATH || './data/sweeper.db';

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

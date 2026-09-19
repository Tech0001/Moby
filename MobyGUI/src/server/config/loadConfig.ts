import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { AppConfigSchema, AppConfig } from './schema.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/sqlite.js';

// Default config object (used when no persisted config exists)
const DEFAULT_CONFIG: AppConfig = {
  global: {
    enabledOnBoot: false,
    dryRun: false,
    dailyFeeBudgetUsd: null,
    maxInflightWithdrawals: 2,
    perAssetMaxInflight: 1,
    schedulerTickMs: 1000,
    backoffSeconds: [15, 30, 60, 120, 300, 600],
    allowedOrderTypes: ['market', 'limit', 'take-profit', 'take-profit-limit'],
    disabledExchanges: [],
  },
  polling: {
    withdrawStatus: {
      fastSeconds: 10,
      fastCount: 6,
      mediumSeconds: 30,
      mediumCount: 10,
      slowSeconds: 120,
      stuckMinutes: 30,
    },
  },
  web: {
    port: 3000,
    host: '0.0.0.0',
    trustProxy: false,
  },
};

const CONFIG_KEY = 'app_config';
const DATA_ROOT = process.env.MOBY_DATA_PATH || process.env.DATA_DIR || process.cwd();
const LEGACY_CONFIG_PATH = process.env.CONFIG_PATH || join(DATA_ROOT, 'config.yaml');

function readConfigFromDb(): AppConfig | null {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get(CONFIG_KEY) as { value: string } | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.value) as AppConfig;
  } catch (error) {
    logger.error({ error }, 'Failed to parse config JSON from database');
    return null;
  }
}

function writeConfigToDb(config: AppConfig): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(CONFIG_KEY, JSON.stringify(config), Date.now());
}

function migrateLegacyConfigFile(): AppConfig | null {
  if (!existsSync(LEGACY_CONFIG_PATH)) {
    return null;
  }

  try {
    const raw = readFileSync(LEGACY_CONFIG_PATH, 'utf-8');
    const parsed = parse(raw);
    const result = AppConfigSchema.safeParse(parsed);
    if (result.success) {
      logger.info({ path: LEGACY_CONFIG_PATH }, 'Migrated legacy config.yaml into database');
      try {
        unlinkSync(LEGACY_CONFIG_PATH);
        logger.info({ path: LEGACY_CONFIG_PATH }, 'Removed legacy config.yaml');
      } catch {
        // Non-fatal if deletion fails
      }
      return result.data;
    }
    logger.warn({ errors: result.error.format() }, 'Legacy config.yaml invalid, falling back to defaults');
  } catch (error) {
    logger.warn({ error }, 'Failed to read legacy config.yaml, falling back to defaults');
  }
  return null;
}

export function loadConfig(): AppConfig {
  // Prefer DB-stored config; if missing, migrate from legacy file once; otherwise use defaults.
  const fromDb = readConfigFromDb();
  const legacy = fromDb ? null : migrateLegacyConfigFile();
  const baseConfig = fromDb || legacy || DEFAULT_CONFIG;

  const result = AppConfigSchema.safeParse(baseConfig);
  if (!result.success) {
    logger.error({ errors: result.error.format() }, 'Config validation failed');
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  const config = result.data;
  writeConfigToDb(config); // ensure DB has the validated config

  logger.info({ source: fromDb ? 'database' : legacy ? 'legacy-file' : 'default' }, 'Configuration loaded');

  return config;
}

export function saveConfig(config: AppConfig): void {
  const result = AppConfigSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  writeConfigToDb(result.data);
  logger.info('Configuration saved to database');
}

export function reloadConfig(): AppConfig {
  logger.info('Reloading configuration');
  return loadConfig();
}

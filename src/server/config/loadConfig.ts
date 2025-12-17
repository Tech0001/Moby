import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { parse, stringify } from 'yaml';
import { randomBytes } from 'crypto';
import { AppConfigSchema, AppConfig } from './schema.js';
import { logger } from '../utils/logger.js';

// Default to the app data directory so packaged apps have a writable location
const DATA_ROOT = process.env.MOBY_DATA_PATH || process.env.DATA_DIR || process.cwd();
const CONFIG_PATH = process.env.CONFIG_PATH || join(DATA_ROOT, 'config.yaml');

// Default config template
const DEFAULT_CONFIG = `# Moby Configuration
global:
  enabledOnBoot: false
  dryRun: false
  maxInflightWithdrawals: 2
  perAssetMaxInflight: 1
  schedulerTickMs: 1000
  backoffSeconds: [15, 30, 60, 120, 300, 600]
  allowedOrderTypes: ["limit", "take-profit", "take-profit-limit"]
  # keyNamePrefix: "COLD_"  # Optional: only use wallet keys starting with this prefix

polling:
  withdrawStatus:
    fastSeconds: 10
    fastCount: 6
    mediumSeconds: 30
    mediumCount: 10
    slowSeconds: 120
    stuckMinutes: 30

web:
  port: 3000
  host: "0.0.0.0"
  trustProxy: false

# Note: Asset sweep configurations are stored in the database.
# Use the web UI to configure which assets to sweep for each exchange.
`;

export function loadConfig(): AppConfig {
  // Ensure the directory exists for the config path (especially when defaulting to app data)
  const configDir = dirname(CONFIG_PATH);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  if (!existsSync(CONFIG_PATH)) {
    logger.info({ path: CONFIG_PATH }, 'No config file found, creating default');
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG, 'utf-8');
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parse(raw);

  const result = AppConfigSchema.safeParse(parsed);

  if (!result.success) {
    logger.error({ errors: result.error.format() }, 'Config validation failed');
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  const config = result.data;

  // Session secret will be initialized after database is ready (in app.ts)
  // This allows us to persist it across restarts

  logger.info(
    { enabledOnBoot: config.global.enabledOnBoot, dryRun: config.global.dryRun },
    'Configuration loaded'
  );

  return config;
}

export function saveConfig(config: AppConfig): void {
  const result = AppConfigSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  const yaml = stringify(config, { indent: 2 });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
  logger.info({ path: CONFIG_PATH }, 'Configuration saved');
}

export function reloadConfig(): AppConfig {
  logger.info('Reloading configuration');
  return loadConfig();
}

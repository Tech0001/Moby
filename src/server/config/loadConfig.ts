import { readFileSync, existsSync, writeFileSync } from 'fs';
import { parse, stringify } from 'yaml';
import { randomBytes } from 'crypto';
import { AppConfigSchema, AppConfig } from './schema.js';
import { logger } from '../utils/logger.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './config.yaml';

// Default config template
const DEFAULT_CONFIG = `# Moby Configuration
global:
  enabledOnBoot: false
  dryRun: false
  maxInflightWithdrawals: 2
  perAssetMaxInflight: 1
  schedulerTickMs: 1000
  backoffSeconds: [15, 30, 60, 120, 300, 600]
  allowedOrderTypes: ["limit", "take_profit", "take_profit_limit"]
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

  // Generate session secret if not provided
  if (!config.web.sessionSecret) {
    config.web.sessionSecret = randomBytes(32).toString('hex');
    logger.info('Generated session secret (not persisted - provide in config for persistence)');
  }

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

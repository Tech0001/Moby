import { z } from 'zod';
import type { ExchangeId } from '../domain/types.js';

// Supported exchange identifiers
export const ExchangeIdSchema = z.enum(['kraken', 'gemini', 'kucoin', 'gateio']);

// Polling configuration for withdrawal status
export const PollingConfigSchema = z.object({
  withdrawStatus: z.object({
    fastSeconds: z.number().int().positive().default(10),
    fastCount: z.number().int().positive().default(6),
    mediumSeconds: z.number().int().positive().default(30),
    mediumCount: z.number().int().positive().default(10),
    slowSeconds: z.number().int().positive().default(120),
    stuckMinutes: z.number().int().positive().default(30),
  }).default({}),
});

// Global configuration
export const GlobalConfigSchema = z.object({
  enabledOnBoot: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  maxInflightWithdrawals: z.number().int().positive().default(2),
  perAssetMaxInflight: z.number().int().positive().default(1),
  schedulerTickMs: z.number().int().positive().default(1000),
  backoffSeconds: z.array(z.number().positive()).default([15, 30, 60, 120, 300, 600]),
  allowedOrderTypes: z.array(z.string()).default(['limit', 'take_profit', 'take_profit_limit']),
  disabledExchanges: z.array(ExchangeIdSchema).default([]),
});

// Web UI / Auth configuration
export const WebConfigSchema = z.object({
  port: z.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  sessionSecret: z.string().min(32).optional(), // Generated if not provided
  trustProxy: z.boolean().default(false), // Set true behind reverse proxy
});

// Full application configuration
// Asset configs are now stored in the database, not YAML
export const AppConfigSchema = z.object({
  global: GlobalConfigSchema.default({}),
  polling: PollingConfigSchema.default({}),
  web: WebConfigSchema.default({}),
});

// Type exports
export type PollingConfig = z.infer<typeof PollingConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type WebConfig = z.infer<typeof WebConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

// Legacy AssetConfig type for API compatibility - actual configs stored in DB
export interface AssetConfig {
  enabled: boolean;
  threshold: number;
  reserve: number;
  destKeys: string[];
}

// Helper functions (operate on database now, but kept for API compatibility)
export function getExchangeAssets(_config: AppConfig, _exchange: ExchangeId): Record<string, AssetConfig> {
  // Asset configs are now in database - this is a no-op placeholder
  // Use repository functions instead
  return {};
}

export function isExchangeEnabled(_config: AppConfig, _exchange: ExchangeId): boolean {
  // All exchanges with API keys are considered enabled
  // Use hasAnyApiKeys(exchange) from repositories instead
  return true;
}

export function getEnabledExchanges(_config: AppConfig): ExchangeId[] {
  // Use getActiveApiKeys() from repositories to determine enabled exchanges
  return [];
}

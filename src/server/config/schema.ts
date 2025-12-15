import { z } from 'zod';

// Chunk configuration - either fixed coin amount or USD-based
export const ChunkConfigSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('fixedCoin'),
    amount: z.number().positive(),
    max: z.number().positive().optional(),
  }),
  z.object({
    mode: z.literal('usd'),
    targetUsd: z.number().positive(),
    maxUsd: z.number().positive().optional(),
  }),
]);

// Per-asset configuration
export const AssetConfigSchema = z.object({
  priority: z.number().int().positive(),
  method: z.string().min(1), // Kraken withdrawal method name (e.g., "Bitcoin", "Ethereum")
  walletKeys: z.array(z.string().min(1)).min(1), // Pre-saved Kraken withdrawal address keys

  // Threshold - at least one required
  sweepThresholdCoin: z.number().positive().optional(),
  sweepThresholdUsd: z.number().positive().optional(),

  reserveCoin: z.number().nonnegative().default(0), // Leave this much behind
  cooldownSeconds: z.number().int().nonnegative().default(30),

  chunk: ChunkConfigSchema,

  // Optional caps
  perWalletCapUsd: z.number().positive().optional(),
  perWalletCapCoin: z.number().positive().optional(),
}).refine(
  (data) => data.sweepThresholdCoin !== undefined || data.sweepThresholdUsd !== undefined,
  { message: 'Either sweepThresholdCoin or sweepThresholdUsd must be specified' }
);

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
  maxInflightWithdrawals: z.number().int().positive().default(2),
  perAssetMaxInflight: z.number().int().positive().default(1),
  schedulerTickMs: z.number().int().positive().default(1000),
  backoffSeconds: z.array(z.number().positive()).default([15, 30, 60, 120, 300, 600]),
  allowedOrderTypes: z.array(z.string()).default(['limit', 'take_profit', 'take_profit_limit']),
  keyNamePrefix: z.string().optional(), // Optional safety filter for wallet key names
});

// Web UI / Auth configuration
export const WebConfigSchema = z.object({
  port: z.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  sessionSecret: z.string().min(32).optional(), // Generated if not provided
  trustProxy: z.boolean().default(false), // Set true behind reverse proxy
});

// Full application configuration
export const AppConfigSchema = z.object({
  global: GlobalConfigSchema.default({}),
  polling: PollingConfigSchema.default({}),
  web: WebConfigSchema.default({}),
  assets: z.record(z.string(), AssetConfigSchema).default({}),
});

// Type exports
export type ChunkConfig = z.infer<typeof ChunkConfigSchema>;
export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type PollingConfig = z.infer<typeof PollingConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type WebConfig = z.infer<typeof WebConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

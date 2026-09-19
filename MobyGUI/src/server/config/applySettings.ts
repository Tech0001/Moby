import type { AppConfig } from './schema.js';
import type { GlobalSettings } from '../db/repositories.js';

/**
 * Overlay persisted DB settings onto the in-memory config.
 * Ensures allowedOrderTypes are normalized to lowercase for comparisons.
 */
export function applySettingsToConfig(config: AppConfig, settings: GlobalSettings): AppConfig {
  const normalizedOrderTypes = settings.allowedOrderTypes.map((t) => t.toLowerCase());

  return {
    ...config,
    global: {
      ...config.global,
      dryRun: settings.dryRun,
      dailyFeeBudgetUsd: settings.dailyFeeBudgetUsd,
      maxInflightWithdrawals: settings.maxInflightWithdrawals,
      perAssetMaxInflight: settings.perAssetMaxInflight,
      keyNamePrefix: settings.keyNamePrefix,
      allowedOrderTypes: normalizedOrderTypes,
    },
  };
}

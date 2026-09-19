import { createChildLogger } from '../utils/logger.js';
import { getAssetState, advanceRrIndex, upsertAssetState } from '../db/repositories.js';
import type { ExchangeId } from './types.js';

const logger = createChildLogger('rr-selector');

/**
 * Advance the RR index after a successful withdrawal submission
 */
export function advanceWalletIndex(exchange: ExchangeId, asset: string, walletCount: number): void {
  advanceRrIndex(exchange, asset, walletCount);
  logger.debug({ exchange, asset }, 'Advanced RR index');
}

/**
 * Get current wallet key without advancing
 */
export function getCurrentWalletKey(exchange: ExchangeId, asset: string, walletKeys: string[]): string {
  if (walletKeys.length === 0) {
    throw new Error(`No wallet keys configured for ${asset}`);
  }

  const state = getAssetState(exchange, asset);
  const index = (state?.rrIndex ?? 0) % walletKeys.length;
  return walletKeys[index];
}

/**
 * Reset RR index to 0 (useful for testing or manual reset)
 */
export function resetWalletIndex(exchange: ExchangeId, asset: string): void {
  const state = getAssetState(exchange, asset);
  if (state) {
    state.rrIndex = 0;
    upsertAssetState(state);
    logger.info({ exchange, asset }, 'Reset RR index to 0');
  }
}

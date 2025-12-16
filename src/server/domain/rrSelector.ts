import { createChildLogger } from '../utils/logger.js';
import { getAssetState, advanceRrIndex, upsertAssetState } from '../db/repositories.js';
import type { AssetConfig } from '../config/schema.js';
import type { PriceProvider } from './chunking.js';
import { checkWalletCap } from './chunking.js';
import type { ExchangeId } from './types.js';

const logger = createChildLogger('rr-selector');

export interface WalletSelection {
  key: string;
  index: number;
}

/**
 * Select the next wallet key using round-robin
 * Optionally skips wallets that have exceeded their cap
 */
export async function selectNextWallet(
  exchange: ExchangeId,
  asset: string,
  assetConfig: AssetConfig,
  proposedAmount: number,
  walletTotals: Map<string, number>, // Total already withdrawn to each wallet
  priceProvider?: PriceProvider
): Promise<WalletSelection | null> {
  const { walletKeys } = assetConfig;

  if (walletKeys.length === 0) {
    logger.error({ exchange, asset }, 'No wallet keys configured');
    return null;
  }

  // Get current RR index
  let state = getAssetState(exchange, asset);
  if (!state) {
    // Initialize state if doesn't exist
    state = {
      exchange,
      asset,
      pendingAmount: 0,
      rrIndex: 0,
      lastWithdrawAt: null,
      consecutiveFailures: 0,
      backoffUntil: null,
    };
    upsertAssetState(state);
  }

  const startIndex = state.rrIndex % walletKeys.length;
  let currentIndex = startIndex;
  let attempts = 0;

  // Try each wallet in round-robin order
  while (attempts < walletKeys.length) {
    const key = walletKeys[currentIndex];
    const totalToWallet = walletTotals.get(key) ?? 0;

    // Check if wallet can accept this amount
    const capCheck = await checkWalletCap(
      asset,
      key,
      totalToWallet,
      proposedAmount,
      assetConfig,
      priceProvider
    );

    if (capCheck.allowed) {
      logger.debug({ asset, key, index: currentIndex }, 'Selected wallet');
      return { key, index: currentIndex };
    }

    logger.debug({ asset, key, reason: capCheck.reason }, 'Wallet skipped due to cap');

    // Try next wallet
    currentIndex = (currentIndex + 1) % walletKeys.length;
    attempts++;
  }

  // All wallets exceeded cap
  logger.warn({ asset }, 'All wallets exceeded cap, cannot select destination');
  return null;
}

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

import { createChildLogger } from '../utils/logger.js';
import type { AssetConfig, ChunkConfig } from '../config/schema.js';
import type { WithdrawInfo } from './types.js';

const logger = createChildLogger('chunking');

export interface ChunkResult {
  amount: number;
  fee: number;
  netAmount: number; // amount after fee
  reason?: string;   // If amount is 0, why
}

export interface PriceProvider {
  getUsdPrice(asset: string): Promise<number | null>;
}

/**
 * Compute the withdrawal chunk amount for an asset
 */
export async function computeChunkAmount(
  asset: string,
  pendingAmount: number,
  assetConfig: AssetConfig,
  priceProvider?: PriceProvider
): Promise<number> {
  const { chunk, reserveCoin = 0 } = assetConfig;

  // Available to withdraw (minus reserve)
  const available = Math.max(0, pendingAmount - reserveCoin);

  // If no chunk config, return all available
  if (!chunk) {
    return Math.floor(available * 1e8) / 1e8;
  }

  if (available <= 0) {
    logger.debug({ asset, pendingAmount, reserveCoin }, 'Nothing available after reserve');
    return 0;
  }

  let chunkAmount: number;

  if (chunk.mode === 'fixedCoin') {
    // Fixed coin amount per chunk
    chunkAmount = Math.min(available, chunk.amount);

    // Apply max if specified
    if (chunk.max) {
      chunkAmount = Math.min(chunkAmount, chunk.max);
    }
  } else {
    // USD-based chunking
    if (!priceProvider) {
      logger.warn({ asset }, 'USD chunking requested but no price provider');
      return 0;
    }

    const price = await priceProvider.getUsdPrice(asset);
    if (!price || price <= 0) {
      logger.warn({ asset }, 'Could not get USD price for chunking');
      return 0;
    }

    if (!chunk.targetUsd) {
      logger.warn({ asset }, 'USD chunking mode but no targetUsd specified');
      return 0;
    }

    // Convert target USD to coin amount
    const targetCoin = chunk.targetUsd / price;
    chunkAmount = Math.min(available, targetCoin);

    // Apply max USD if specified
    if (chunk.maxUsd) {
      const maxCoin = chunk.maxUsd / price;
      chunkAmount = Math.min(chunkAmount, maxCoin);
    }
  }

  logger.debug({ asset, pendingAmount, available, chunkAmount }, 'Computed chunk amount');

  return Number.isFinite(chunkAmount) ? Math.floor(chunkAmount * 1e8) / 1e8 : 0;
}

/**
 * Clamp amount based on Kraken WithdrawInfo constraints
 */
export function clampWithWithdrawInfo(
  requestedAmount: number,
  withdrawInfo: WithdrawInfo,
  minWithdrawAmount?: number
): ChunkResult {
  const { fee, limit, amount: adjustedAmount } = withdrawInfo;

  // Check if requested amount is below minimum (including fee)
  const effectiveMin = minWithdrawAmount ?? fee * 2; // At least 2x fee as minimum

  if (requestedAmount < effectiveMin) {
    return {
      amount: 0,
      fee: 0,
      netAmount: 0,
      reason: `Amount ${requestedAmount} below minimum ${effectiveMin}`,
    };
  }

  // Clamp to Kraken's limit
  let finalAmount = Math.min(requestedAmount, limit);

  // Ensure we have enough to cover fee
  if (finalAmount <= fee) {
    return {
      amount: 0,
      fee: 0,
      netAmount: 0,
      reason: `Amount ${finalAmount} does not cover fee ${fee}`,
    };
  }

  const netAmount = finalAmount - fee;

  return {
    amount: finalAmount,
    fee,
    netAmount,
  };
}

/**
 * Check if pending amount meets sweep threshold
 */
export async function meetsSweepThreshold(
  asset: string,
  pendingAmount: number,
  assetConfig: AssetConfig,
  priceProvider?: PriceProvider
): Promise<boolean> {
  const { sweepThresholdCoin, sweepThresholdUsd } = assetConfig;

  // Check coin threshold
  if (sweepThresholdCoin !== undefined) {
    return pendingAmount >= sweepThresholdCoin;
  }

  // Check USD threshold
  if (sweepThresholdUsd !== undefined) {
    if (!priceProvider) {
      logger.warn({ asset }, 'USD threshold check but no price provider');
      return false;
    }

    const price = await priceProvider.getUsdPrice(asset);
    if (!price) {
      logger.warn({ asset }, 'Could not get USD price for threshold check');
      return false;
    }

    const pendingUsd = pendingAmount * price;
    return pendingUsd >= sweepThresholdUsd;
  }

  // No threshold configured - shouldn't happen due to schema validation
  logger.warn({ asset }, 'No sweep threshold configured');
  return false;
}

/**
 * Check if a wallet has reached its cap
 */
export async function checkWalletCap(
  asset: string,
  walletKey: string,
  totalWithdrawnToWallet: number,
  proposedAmount: number,
  assetConfig: AssetConfig,
  priceProvider?: PriceProvider
): Promise<{ allowed: boolean; reason?: string }> {
  const { perWalletCapUsd, perWalletCapCoin } = assetConfig;

  // Check coin cap
  if (perWalletCapCoin !== undefined) {
    const totalAfter = totalWithdrawnToWallet + proposedAmount;
    if (totalAfter > perWalletCapCoin) {
      return {
        allowed: false,
        reason: `Wallet ${walletKey} would exceed coin cap (${totalAfter} > ${perWalletCapCoin})`,
      };
    }
  }

  // Check USD cap
  if (perWalletCapUsd !== undefined) {
    if (!priceProvider) {
      // Can't check USD cap without price - allow conservatively
      return { allowed: false, reason: 'USD price unavailable for wallet cap' };
    }

    const price = await priceProvider.getUsdPrice(asset);
    if (!price || !Number.isFinite(price) || price <= 0) {
      return { allowed: false, reason: 'USD price unavailable for wallet cap' };
    }

    const totalAfterUsd = (totalWithdrawnToWallet + proposedAmount) * price;
    if (totalAfterUsd > perWalletCapUsd) {
      return {
        allowed: false,
        reason: `Wallet ${walletKey} would exceed USD cap ($${totalAfterUsd.toFixed(2)} > $${perWalletCapUsd})`,
      };
    }
  }

  return { allowed: true };
}

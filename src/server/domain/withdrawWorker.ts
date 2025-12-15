import { createChildLogger } from '../utils/logger.js';
import {
  getAssetState,
  subtractPendingAmount,
  recordWithdrawalAttempt,
  createWithdrawalJob,
  updateWithdrawalJob,
} from '../db/repositories.js';
import { advanceWalletIndex, getCurrentWalletKey } from './rrSelector.js';
import { computeChunkAmount, clampWithWithdrawInfo } from './chunking.js';
import type { KrakenRestClient } from '../kraken/restClient.js';
import type { AssetConfig, GlobalConfig } from '../config/schema.js';
import type { WithdrawalJob } from './types.js';
import type { PriceProvider } from './chunking.js';

const logger = createChildLogger('withdraw-worker');

export interface WithdrawWorkerOptions {
  krakenClient: KrakenRestClient;
  globalConfig: GlobalConfig;
  priceProvider?: PriceProvider;
}

export interface WithdrawResult {
  success: boolean;
  job?: WithdrawalJob;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Attempt to start a withdrawal for an asset
 */
export async function startWithdrawal(
  asset: string,
  assetConfig: AssetConfig,
  options: WithdrawWorkerOptions
): Promise<WithdrawResult> {
  const { krakenClient, globalConfig, priceProvider } = options;

  try {
    // Get current state
    const state = getAssetState(asset);
    if (!state) {
      return { success: false, skipped: true, skipReason: 'No asset state' };
    }

    // Compute chunk amount
    const chunkAmount = await computeChunkAmount(
      asset,
      state.pendingAmount,
      assetConfig,
      priceProvider
    );

    if (chunkAmount <= 0) {
      return {
        success: false,
        skipped: true,
        skipReason: 'Computed chunk amount is 0',
      };
    }

    // Get destination wallet key
    const destKey = getCurrentWalletKey(asset, assetConfig.walletKeys);

    // Check prefix filter if configured
    if (globalConfig.keyNamePrefix) {
      if (!destKey.startsWith(globalConfig.keyNamePrefix)) {
        logger.warn(
          { asset, destKey, prefix: globalConfig.keyNamePrefix },
          'Wallet key does not match prefix filter'
        );
        return {
          success: false,
          skipped: true,
          skipReason: `Wallet key ${destKey} does not match prefix ${globalConfig.keyNamePrefix}`,
        };
      }
    }

    // Get withdrawal info from Kraken (validates amount, gets fees)
    const withdrawInfo = await krakenClient.getWithdrawInfo(
      asset,
      destKey,
      chunkAmount
    );

    // Clamp amount based on Kraken constraints
    const chunkResult = clampWithWithdrawInfo(chunkAmount, withdrawInfo);

    if (chunkResult.amount <= 0) {
      return {
        success: false,
        skipped: true,
        skipReason: chunkResult.reason || 'Amount too small after clamping',
      };
    }

    // Submit withdrawal
    logger.info(
      {
        asset,
        amount: chunkResult.amount,
        destKey,
        fee: chunkResult.fee,
        netAmount: chunkResult.netAmount,
      },
      'Submitting withdrawal'
    );

    const result = await krakenClient.withdraw(asset, destKey, chunkResult.amount);

    // Success - update state
    subtractPendingAmount(asset, chunkResult.amount);
    advanceWalletIndex(asset, assetConfig.walletKeys.length);
    recordWithdrawalAttempt(asset, true);

    // Create job record
    const job = createWithdrawalJob(
      asset,
      assetConfig.method,
      destKey,
      chunkResult.amount
    );

    // Update with Kraken reference
    updateWithdrawalJob(job.id, {
      krakenRef: result.refid,
      status: 'pending',
    });

    job.krakenRef = result.refid;
    job.status = 'pending';

    logger.info(
      {
        asset,
        amount: chunkResult.amount,
        destKey,
        refid: result.refid,
        jobId: job.id,
      },
      'Withdrawal submitted successfully'
    );

    return { success: true, job };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ asset, error: errorMsg }, 'Withdrawal failed');

    // Calculate backoff
    const state = getAssetState(asset);
    const failures = (state?.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, globalConfig.backoffSeconds.length - 1);
    const backoffMs = globalConfig.backoffSeconds[backoffIndex] * 1000;
    const backoffUntil = Date.now() + backoffMs;

    recordWithdrawalAttempt(asset, false, backoffUntil);

    return { success: false, error: errorMsg };
  }
}

/**
 * Check if an asset is eligible for withdrawal attempt
 */
export function isEligibleForWithdrawal(
  asset: string,
  assetConfig: AssetConfig,
  globalConfig: GlobalConfig,
  inflightCount: number,
  globalInflightCount: number
): { eligible: boolean; reason?: string } {
  const now = Date.now();
  const state = getAssetState(asset);

  if (!state) {
    return { eligible: false, reason: 'No asset state' };
  }

  // Check if in backoff
  if (state.backoffUntil && now < state.backoffUntil) {
    const remainingMs = state.backoffUntil - now;
    return {
      eligible: false,
      reason: `In backoff for ${Math.ceil(remainingMs / 1000)}s`,
    };
  }

  // Check cooldown
  if (state.lastWithdrawAt) {
    const elapsed = now - state.lastWithdrawAt;
    const cooldownMs = assetConfig.cooldownSeconds * 1000;
    if (elapsed < cooldownMs) {
      const remainingMs = cooldownMs - elapsed;
      return {
        eligible: false,
        reason: `In cooldown for ${Math.ceil(remainingMs / 1000)}s`,
      };
    }
  }

  // Check per-asset inflight limit
  if (inflightCount >= globalConfig.perAssetMaxInflight) {
    return {
      eligible: false,
      reason: `At per-asset inflight limit (${inflightCount}/${globalConfig.perAssetMaxInflight})`,
    };
  }

  // Check global inflight limit
  if (globalInflightCount >= globalConfig.maxInflightWithdrawals) {
    return {
      eligible: false,
      reason: `At global inflight limit (${globalInflightCount}/${globalConfig.maxInflightWithdrawals})`,
    };
  }

  // Check pending amount meets threshold
  // Note: This is checked in the scheduler, not here, for efficiency

  return { eligible: true };
}

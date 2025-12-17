import { createChildLogger } from '../utils/logger.js';
import {
  getAssetState,
  subtractPendingAmount,
  addPendingAmount,
  recordWithdrawalAttempt,
  createWithdrawalJob,
  updateWithdrawalJob,
  getExchangeAddressesByAsset,
  getWithdrawalMethod,
  type AssetConfigRecord,
} from '../db/repositories.js';
import { advanceWalletIndex, getCurrentWalletKey } from './rrSelector.js';
import type { ExchangeRestClient } from '../exchanges/types.js';
import type { GlobalConfig } from '../config/schema.js';
import type { WithdrawalJob, ExchangeId } from './types.js';

const logger = createChildLogger('withdraw-worker');

export interface WithdrawWorkerOptions {
  exchangeClient: ExchangeRestClient;
  exchange: ExchangeId;
  globalConfig: GlobalConfig;
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
  assetConfig: AssetConfigRecord,
  options: WithdrawWorkerOptions
): Promise<WithdrawResult> {
  const { exchangeClient, exchange, globalConfig } = options;
  const { destKeys, reserve } = assetConfig;

  // Track if we've reserved funds (for rollback on failure)
  let reservedAmount = 0;

  try {
    // Get current state
    const state = getAssetState(exchange, asset);
    if (!state) {
      return { success: false, skipped: true, skipReason: 'No asset state' };
    }

    // Calculate withdrawal amount (pendingAmount - reserve)
    const withdrawAmount = Math.max(0, state.pendingAmount - reserve);

    if (withdrawAmount <= 0) {
      return {
        success: false,
        skipped: true,
        skipReason: 'Amount after reserve is 0 or negative',
      };
    }

    // IMPORTANT: Reserve the funds immediately to prevent race conditions
    // If another withdrawal is triggered concurrently, it will see reduced pending amount
    subtractPendingAmount(exchange, asset, withdrawAmount);
    reservedAmount = withdrawAmount;
    logger.debug({ exchange, asset, amount: withdrawAmount }, 'Reserved funds for withdrawal');

    // Get destination wallet key using round-robin
    const destKey = getCurrentWalletKey(exchange, asset, destKeys);

    // Check prefix filter if configured
    if (globalConfig.keyNamePrefix) {
      if (!destKey.startsWith(globalConfig.keyNamePrefix)) {
        logger.warn(
          { exchange, asset, destKey, prefix: globalConfig.keyNamePrefix },
          'Wallet key does not match prefix filter'
        );
        // Restore reserved funds
        addPendingAmount(exchange, asset, reservedAmount);
        return {
          success: false,
          skipped: true,
          skipReason: `Wallet key ${destKey} does not match prefix ${globalConfig.keyNamePrefix}`,
        };
      }
    }

    // Look up the withdrawal method from exchange addresses
    const addresses = getExchangeAddressesByAsset(exchange, asset);
    const addressRecord = addresses.find((a) => a.key === destKey);

    if (!addressRecord) {
      logger.warn({ exchange, asset, destKey }, 'Destination key not found in exchange addresses');
      // Restore reserved funds
      addPendingAmount(exchange, asset, reservedAmount);
      return {
        success: false,
        skipped: true,
        skipReason: `Wallet key ${destKey} not found in synced addresses`,
      };
    }

    const method = addressRecord.method;

    // Check cached minimum before making API call
    const cachedMethod = getWithdrawalMethod(exchange, asset, method);
    if (cachedMethod) {
      if (withdrawAmount < cachedMethod.minimum) {
        logger.debug(
          { exchange, asset, amount: withdrawAmount, minimum: cachedMethod.minimum, method },
          'Amount below cached minimum, skipping'
        );
        // Restore reserved funds
        addPendingAmount(exchange, asset, reservedAmount);
        return {
          success: false,
          skipped: true,
          skipReason: `Amount ${withdrawAmount} below minimum ${cachedMethod.minimum} for ${method}`,
        };
      }
      logger.debug(
        { exchange, asset, amount: withdrawAmount, minimum: cachedMethod.minimum, cachedFee: cachedMethod.fee },
        'Withdrawal amount passes cached minimum check'
      );
    }

    // Get withdrawal info from exchange (validates amount, gets current fees)
    const withdrawInfo = await exchangeClient.getWithdrawInfo(
      asset,
      destKey,
      withdrawAmount
    );

    // Check if withdrawal limit has been reached
    if (withdrawInfo.limit <= 0) {
      logger.info(
        { exchange, asset, limit: withdrawInfo.limit },
        'Withdrawal limit reached, skipping'
      );
      // Restore reserved funds
      addPendingAmount(exchange, asset, reservedAmount);
      return {
        success: false,
        skipped: true,
        skipReason: 'Withdrawal limit reached (limit=0)',
      };
    }

    // Check if we're trying to withdraw more than the limit allows
    if (withdrawAmount > withdrawInfo.limit) {
      logger.info(
        { exchange, asset, withdrawAmount, limit: withdrawInfo.limit },
        'Withdrawal amount exceeds current limit, skipping until limit resets'
      );
      // Restore reserved funds
      addPendingAmount(exchange, asset, reservedAmount);
      return {
        success: false,
        skipped: true,
        skipReason: `Amount ${withdrawAmount} exceeds withdrawal limit ${withdrawInfo.limit}`,
      };
    }

    // Check if amount after fees is positive
    const netAmount = withdrawInfo.amount;
    if (netAmount <= 0) {
      // Restore reserved funds
      addPendingAmount(exchange, asset, reservedAmount);
      return {
        success: false,
        skipped: true,
        skipReason: 'Amount too small after fees',
      };
    }

    // Submit withdrawal
    logger.info(
      {
        exchange,
        asset,
        amount: withdrawAmount,
        destKey,
        address: addressRecord.address,
        fee: withdrawInfo.fee,
        netAmount,
        method,
      },
      'Submitting withdrawal'
    );

    const result = await exchangeClient.withdraw(asset, destKey, addressRecord.address, withdrawAmount);

    // Success - funds already reserved, just update other state
    // (subtractPendingAmount was called earlier to prevent race conditions)
    advanceWalletIndex(exchange, asset, destKeys.length);
    recordWithdrawalAttempt(exchange, asset, true);

    // Create job record
    const job = createWithdrawalJob(
      exchange,
      asset,
      method,
      destKey,
      withdrawAmount
    );

    // Update with exchange reference
    updateWithdrawalJob(job.id, {
      exchangeRef: result.refId,
      status: 'pending',
    });

    job.exchangeRef = result.refId;
    job.status = 'pending';

    logger.info(
      {
        exchange,
        asset,
        amount: withdrawAmount,
        destKey,
        refId: result.refId,
        jobId: job.id,
      },
      'Withdrawal submitted successfully'
    );

    return { success: true, job };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ exchange, asset, error: errorMsg }, 'Withdrawal failed');

    // Restore reserved funds if any were reserved
    if (reservedAmount > 0) {
      addPendingAmount(exchange, asset, reservedAmount);
      logger.debug({ exchange, asset, amount: reservedAmount }, 'Restored reserved funds after failure');
    }

    // Calculate backoff
    const state = getAssetState(exchange, asset);
    const failures = (state?.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, globalConfig.backoffSeconds.length - 1);
    const backoffMs = globalConfig.backoffSeconds[backoffIndex] * 1000;
    const backoffUntil = Date.now() + backoffMs;

    recordWithdrawalAttempt(exchange, asset, false, backoffUntil);

    return { success: false, error: errorMsg };
  }
}

// Default cooldown between withdrawals (60 seconds)
const DEFAULT_COOLDOWN_SECONDS = 60;

/**
 * Check if an asset is eligible for withdrawal attempt
 */
export function isEligibleForWithdrawal(
  exchange: ExchangeId,
  asset: string,
  assetConfig: AssetConfigRecord,
  globalConfig: GlobalConfig,
  inflightCount: number,
  globalInflightCount: number
): { eligible: boolean; reason?: string } {
  const now = Date.now();
  const state = getAssetState(exchange, asset);

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

  // Check cooldown (use asset config or default)
  const cooldownSeconds = assetConfig.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
  const cooldownMs = cooldownSeconds * 1000;
  if (state.lastWithdrawAt) {
    const elapsed = now - state.lastWithdrawAt;
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

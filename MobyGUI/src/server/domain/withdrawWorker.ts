import { feeBudgetReason } from './feeBudget.js';
import { checkBalances } from './balanceGuard.js';
import { validateBalances } from '../exchanges/balances.js';
import { getDb } from '../db/sqlite.js';
import { createChildLogger } from '../utils/logger.js';
import {
  getAssetState,
  getQueueRevision, getControlRevision,
  reserveWithdrawal, releaseWithdrawal, getActiveWithdrawalJobs, getAssetConfig, isEnabled, isExchangeEnabled,
  recordWithdrawalAttempt,
  updateWithdrawalJob,
  getExchangeAddressesByAsset,
  getWithdrawalMethod,
  type AssetConfigRecord,
} from '../db/repositories.js';
import { getCurrentWalletKey } from './rrSelector.js';
import type { ExchangeRestClient } from '../exchanges/types.js';
import type { GlobalConfig } from '../config/schema.js';
import type { WithdrawalJob, ExchangeId } from './types.js';
import { computeChunkAmount, type PriceProvider } from './chunking.js';
import { toKuCoinPair } from '../exchanges/kucoin/index.js';
import { toGeminiPair } from '../exchanges/gemini/index.js';
import { toGatePair } from '../exchanges/gateio/index.js';
import { KrakenApiError } from '../exchanges/kraken/restClient.js';
import { toKrakenAsset } from '../exchanges/kraken/index.js';

const logger = createChildLogger('withdraw-worker');

const USD_QUOTES = ['USD', 'USDT', 'USDC'];

function buildPricePairs(exchange: ExchangeId, asset: string, quote: string): string[] {
  switch (exchange) {
    case 'kucoin':
      return [toKuCoinPair(asset, quote)];
    case 'gemini':
      return [toGeminiPair(asset, quote)];
    case 'gateio':
      return [toGatePair(asset, quote)];
    case 'kraken': {
      const base = toKrakenAsset(asset);
      const krakenQuote = toKrakenAsset(quote);
      // Kraken accepts both concatenated and slash-delimited pairs
      return [`${base}${krakenQuote}`, `${base}/${krakenQuote}`];
    }
    default:
      return [`${asset}/${quote}`];
  }
}

function createPriceProvider(exchange: ExchangeId, client: ExchangeRestClient): PriceProvider {
  return {
    async getUsdPrice(asset: string): Promise<number | null> {
      const pairs: string[] = [];
      for (const quote of USD_QUOTES) {
        pairs.push(...buildPricePairs(exchange, asset, quote));
      }

      for (const pair of pairs) {
        try {
          const ticker = await client.getTicker([pair]);
          const value = Object.values(ticker)[0]?.c?.[0];
          const price = Number(value);
          if (Number.isFinite(price) && price > 0) return price;
        } catch { /* Try the next supported quote/pair. */ }
      }

      return null;
    },
  };
}

export interface WithdrawWorkerOptions {
  exchangeClient: ExchangeRestClient;
  exchange: ExchangeId;
  globalConfig: GlobalConfig;
  canSubmit?: () => boolean;
  beforeBalanceCheck?: () => Promise<unknown>;
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
  let job: WithdrawalJob | undefined;
  const controlRevision = getControlRevision();

  try {
    if (getActiveWithdrawalJobs(exchange).some(j => j.asset === asset)) {
      return { success: false, skipped: true, skipReason: 'Waiting for the current withdrawal to settle before checking this asset’s balance' };
    }
    let checked;
    try {
      await options.beforeBalanceCheck?.();
      checked = await checkBalances(exchange, exchangeClient);
    }
    catch (error) { return { success: false, skipped: true, skipReason: error instanceof Error ? error.message : 'Balance check unavailable' }; }
    // Get current state
    const state = getAssetState(exchange, asset);
    if (!state) {
      return { success: false, skipped: true, skipReason: 'No asset state' };
    }

    // Calculate withdrawal amount using chunking logic (supports coin or USD targets)
    const chunkConfig =
      assetConfig.chunkAmount && assetConfig.chunkAmount > 0
        ? assetConfig.chunkMode === 'fixedUsd'
          ? {
              mode: 'fixedUsd' as const,
              amount: assetConfig.chunkAmount, // unused in fixedUsd, satisfies interface
              targetUsd: assetConfig.chunkAmount,
              maxUsd: assetConfig.chunkMax ?? undefined,
            }
          : {
              mode: 'fixedCoin' as const,
              amount: assetConfig.chunkAmount,
              max: assetConfig.chunkMax ?? undefined,
            }
        : undefined;

    let withdrawAmount = await computeChunkAmount(
      asset,
      state.pendingAmount,
      {
        enabled: assetConfig.enabled,
        threshold: assetConfig.threshold,
        reserve: assetConfig.reserve,
        destKeys,
        reserveCoin: assetConfig.reserve,
        chunk: chunkConfig,
      },
      chunkConfig?.mode === 'fixedUsd' ? createPriceProvider(exchange, exchangeClient) : undefined
    );

    if (withdrawAmount <= 0) {
      return {
        success: false,
        skipped: true,
        skipReason: 'Amount after reserve is 0 or negative',
      };
    }

    // Get destination wallet key using round-robin
    let destKey = getCurrentWalletKey(exchange, asset, destKeys);
    let usdPrice = assetConfig.perWalletCapUsd ? await createPriceProvider(exchange, exchangeClient).getUsdPrice(asset) : null;
    if (assetConfig.perWalletCapUsd && !usdPrice) return { success: false, skipped: true, skipReason: 'USD price unavailable for wallet cap' };
    let walletFound = false;
    for (let i = 0; i < destKeys.length; i++) {
      const candidate = destKeys[(state.rrIndex + i) % destKeys.length];
      const total = getDb().prepare(`SELECT COALESCE(SUM(amount), 0) AS amount FROM withdrawal_jobs
        WHERE exchange = ? AND asset = ? AND dest_key = ? AND status != 'cancelled' AND (status != 'failed' OR exchange_ref IS NOT NULL)`).get(exchange, asset, candidate) as { amount: number };
      if (globalConfig.keyNamePrefix && !candidate.startsWith(globalConfig.keyNamePrefix)) continue;
      if (assetConfig.perWalletCapCoin && total.amount + withdrawAmount > assetConfig.perWalletCapCoin + 1e-10) continue;
      if (assetConfig.perWalletCapUsd && (total.amount + withdrawAmount) * usdPrice! > assetConfig.perWalletCapUsd) continue;
      destKey = candidate; walletFound = true; break;
    }
    if (!walletFound) return { success: false, skipped: true, skipReason: 'Every wallet has reached its cap or fails the prefix filter' };

    // Check prefix filter if configured
    if (globalConfig.keyNamePrefix) {
      if (!destKey.startsWith(globalConfig.keyNamePrefix)) {
        logger.warn(
          { exchange, asset, destKey, prefix: globalConfig.keyNamePrefix },
          'Wallet key does not match prefix filter'
        );
        // Restore reserved funds

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

    // Retain the configured legacy size cap; this is not a guarantee against exchange holds.
    const MAX_FEE_MULTIPLE = 80000;

    async function getInfoWithFeeCap(
      requested: number
    ): Promise<{ amount: number; info: Awaited<ReturnType<ExchangeRestClient['getWithdrawInfo']>> }> {
      let info = await exchangeClient.getWithdrawInfo(asset, destKey, requested);

      if (info.fee > 0) {
        const safeMax = info.fee * MAX_FEE_MULTIPLE;
        if (requested > safeMax) {
          const adjusted = safeMax;
          info = await exchangeClient.getWithdrawInfo(asset, destKey, adjusted);
          requested = adjusted;
        }
      }

      return { amount: requested, info };
    }

    // Get withdrawal info from exchange (validates amount, gets current fees), with fee-based cap
    const { amount: cappedAmount, info: withdrawInfo } = await getInfoWithFeeCap(withdrawAmount);
    withdrawAmount = cappedAmount;

    // Check if withdrawal limit has been reached
    if (withdrawInfo.limit <= 0) {
      logger.info(
        { exchange, asset, limit: withdrawInfo.limit },
        'Withdrawal limit reached, skipping'
      );
      // Restore reserved funds

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

      return {
        success: false,
        skipped: true,
        skipReason: 'Amount too small after fees',
      };
    }

    withdrawAmount = Math.floor(withdrawAmount * 1e8) / 1e8;
    if (!Number.isFinite(withdrawAmount) || withdrawAmount <= withdrawInfo.fee || withdrawAmount < (cachedMethod?.minimum ?? 0) ||
        !Number.isFinite(withdrawInfo.fee) || withdrawInfo.fee < 0 || !Number.isFinite(withdrawInfo.amount) ||
        !Number.isFinite(withdrawInfo.limit) || (exchange === 'kraken' && withdrawInfo.method !== method) ||
        (assetConfig.method && method !== assetConfig.method)) {
      return { success: false, skipped: true, skipReason: 'Invalid quote, network mismatch, or amount below fee/minimum' };
    }
    // Store a price snapshot for the fee ledger. Missing quotes never bypass an enabled budget.
    if (withdrawInfo.fee > 0 && !usdPrice) {
      try { usdPrice = await createPriceProvider(exchange, exchangeClient).getUsdPrice(asset); } catch { usdPrice = null; }
    }
    const feeUsd = withdrawInfo.fee === 0 ? 0 : usdPrice && Number.isFinite(usdPrice) && usdPrice > 0 ? withdrawInfo.fee * usdPrice : null;
    const budgetReason = feeBudgetReason(globalConfig.dailyFeeBudgetUsd, feeUsd);
    if (budgetReason) return { success: false, skipped: true, skipReason: budgetReason };
    if (globalConfig.dryRun) return { success: false, skipped: true, skipReason: 'Dry run: no withdrawal submitted' };
    // Quotes and price lookups can take time. Confirm spendable funds again
    // immediately before reserving a job; a failure never starts a transfer.
    let available;
    try { available = await exchangeClient.getBalance(); validateBalances(available); }
    catch (error) { return { success: false, skipped: true, skipReason: error instanceof Error ? error.message : 'Balance check unavailable' }; }
    if (Math.max(0, Number(available[asset] ?? '0')) + 1e-10 < withdrawAmount + reserve) {
      return { success: false, skipped: true, skipReason: 'Balance changed or funds are held; waiting for the next balance check' };
    }
    const canSubmit = () => getControlRevision() === controlRevision && isEnabled() && isExchangeEnabled(exchange) && (options.canSubmit?.() ?? true) &&
      JSON.stringify(getAssetConfig(exchange, asset)) === JSON.stringify(assetConfig);
    if (!canSubmit()) return { success: false, skipped: true, skipReason: 'Settings or credentials changed' };
    if (checked.revision !== getQueueRevision(exchange) || getActiveWithdrawalJobs(exchange).some(j => j.asset === asset)) {
      return { success: false, skipped: true, skipReason: 'Queue changed while preparing this withdrawal; checking again' };
    }
    job = reserveWithdrawal(exchange, asset, method, destKey, withdrawAmount, assetConfig,
      { global: globalConfig.maxInflightWithdrawals, perAsset: globalConfig.perAssetMaxInflight, usdPrice,
        quotedFee: withdrawInfo.fee, feeUsd, dailyFeeBudgetUsd: globalConfig.dailyFeeBudgetUsd, destinationAddress: addressRecord.address }) ?? undefined;
    if (!job) return { success: false, skipped: true, skipReason: feeBudgetReason(globalConfig.dailyFeeBudgetUsd, feeUsd) || 'Funds or withdrawal slot no longer available' };
    const reservedRevision = getQueueRevision(exchange);
    const result = await exchangeClient.withdraw(asset, destKey, addressRecord.address, withdrawAmount,
      { maxFee: withdrawInfo.fee, beforeSend: () => canSubmit() && reservedRevision === getQueueRevision(exchange) });
    if (!result?.refId) throw new Error('Exchange did not return a withdrawal reference');

    // Update with exchange reference
    updateWithdrawalJob(job.id, {
      exchangeRef: result.refId,
      status: 'pending',
    });

    recordWithdrawalAttempt(exchange, asset, true);
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

    if (job) {
      if (error instanceof KrakenApiError && error.definitelyRejected) {
        releaseWithdrawal(job.id, 'failed', errorMsg);
      } else {
        // Transport errors and unclassified exchange errors cannot prove non-submission.
        updateWithdrawalJob(job.id, { status: 'unknown', lastError: errorMsg });
      }
    }

    // Calculate backoff
    const state = getAssetState(exchange, asset);
    const failures = (state?.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, globalConfig.backoffSeconds.length - 1);
    const backoffMs = globalConfig.backoffSeconds[backoffIndex] * 1000;
    const backoffUntil = Date.now() + backoffMs;

    recordWithdrawalAttempt(exchange, asset, false, backoffUntil);

    return { success: false, job, error: errorMsg };
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

  if (getActiveWithdrawalJobs(exchange).some(job => job.asset === asset && ['held', 'unknown'].includes(job.status))) {
    return { eligible: false, reason: 'A held or uncertain withdrawal needs review' };
  }
  const cooldownMs = (assetConfig.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
  if (state.lastWithdrawAt && now - state.lastWithdrawAt < cooldownMs) {
    return { eligible: false, reason: 'In cooldown' };
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

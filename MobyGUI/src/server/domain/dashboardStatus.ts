import type { AppConfig } from '../config/schema.js';
import { getAllAssetConfigs, getAllAssetStates, getActiveWithdrawalJobs, hasAnyApiKeys, isEnabled,
  isExchangeEnabled, getExchangeAddressesByAsset, getWithdrawalMethod, getInflightCount } from '../db/repositories.js';
import { getFeeBudgetUsage } from './feeBudget.js';
import { getDb } from '../db/sqlite.js';
import type { ExchangeId } from './types.js';

export interface ConnectionHealth {
  monitoringSince?: number;
  exchanges: Array<{ exchange: string; connected: boolean; error?: string | null; lastSuccessAt?: number | null }>;
  assetNotices?: Record<string, string>;
}

export function buildDashboardStatus(config: AppConfig, connection?: ConnectionHealth, exchange?: ExchangeId) {
  const now = Date.now(), enabled = isEnabled(), jobs = getActiveWithdrawalJobs(exchange);
  const states = new Map(getAllAssetStates(exchange).map(s => [`${s.exchange}:${s.asset}`, s]));
  const feeBudget = getFeeBudgetUsage(config.global.dailyFeeBudgetUsd, now);
  const assets = getAllAssetConfigs(exchange).map(asset => {
    const state = states.get(`${asset.exchange}:${asset.asset}`), pending = state?.pendingAmount ?? 0;
    const active = jobs.filter(j => j.asset === asset.asset && j.exchange === asset.exchange);
    const candidate = asset.destKeys[(state?.rrIndex ?? 0) % asset.destKeys.length] || null;
    const address = getExchangeAddressesByAsset(asset.exchange, asset.asset).find(a => a.key === candidate);
    const method = address ? getWithdrawalMethod(asset.exchange, asset.asset, address.method) : null;
    const cooldownUntil = state?.lastWithdrawAt ? state.lastWithdrawAt + asset.cooldownSeconds * 1000 : null;
    let label = 'Queued', reason = 'Waiting for the next fee and withdrawal checks', attention = false;
    const block = (title: string, detail: string, alert = false) => { label = title; reason = detail; attention = alert; };
    if (!asset.enabled) block('Disabled', 'This asset is disabled in Configuration');
    else if (!isExchangeEnabled(asset.exchange)) block('Exchange paused', 'This exchange is disabled in Configuration');
    else if (!hasAnyApiKeys(asset.exchange)) block('API key required', 'Add an active exchange API key', true);
    else if (active.some(j => j.status === 'unknown')) block('Needs review', 'An uncertain withdrawal must be reviewed before another chunk', true);
    else if (active.some(j => j.status === 'held')) block('On hold', 'The exchange is holding a withdrawal for this asset', true);
    else if (!enabled) block('Paused', 'Withdrawals are paused; fill monitoring continues');
    else if (config.global.dryRun) block('Dry run', 'Simulation enabled; no withdrawals will be submitted');
    else if (state?.backoffUntil && state.backoffUntil > now) block('Retry delay', 'Waiting after a failed withdrawal attempt', true);
    else if (pending <= 0) block('Waiting', 'Waiting for a new eligible order fill');
    else if (pending < asset.threshold) block('Accumulating', 'The accumulated amount is below the withdrawal threshold');
    else if (pending <= asset.reserve) block('Reserve', 'The accumulated amount is reserved');
    else if (cooldownUntil && cooldownUntil > now) block('Cooldown', 'Waiting between withdrawal chunks');
    else if (active.length > 0) block('In progress', 'Waiting for this asset’s active withdrawal to finish before checking its balance');
    else if (getInflightCount() >= config.global.maxInflightWithdrawals) block('Queue full', 'The maximum number of active withdrawals has been reached');
    else if (!candidate || !address) block('Wallet required', 'Choose a synced destination in Configuration', true);
    else if (feeBudget.limitUsd != null && feeBudget.unpriced) block('Fee budget', 'Recent withdrawals have unpriced fees; the 24-hour budget cannot be checked', true);
    else if (feeBudget.limitUsd != null && feeBudget.reservedUsd >= feeBudget.limitUsd) block('Fee budget', 'Rolling 24-hour fee budget reached', true);
    else if (connection?.assetNotices?.[`${asset.exchange}:${asset.asset}`]) block('Waiting', connection.assetNotices[`${asset.exchange}:${asset.asset}`]);
    const available = Math.max(0, pending - asset.reserve);
    let chunk = asset.chunkMode === 'fixedUsd' ? asset.chunkAmount : Math.min(available, asset.chunkAmount || available, asset.chunkMax || Infinity);
    if (asset.chunkMode !== 'fixedUsd' && chunk && method?.fee) chunk = Math.min(chunk, method.fee * 80000);
    return { exchange: asset.exchange, asset: asset.asset, enabled: asset.enabled, threshold: asset.threshold,
      pendingAmount: pending, rrIndex: state?.rrIndex ?? 0, lastWithdrawAt: state?.lastWithdrawAt ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? 0, backoffUntil: state?.backoffUntil ?? null,
      state: label, reason, attention, nextEligibleAt: label === 'Retry delay' ? state!.backoffUntil : label === 'Cooldown' ? cooldownUntil : null,
      nextWallet: candidate, network: address?.method ?? asset.method, chunkAmount: chunk, chunkCurrency: asset.chunkMode === 'fixedUsd' ? 'USD' : asset.asset,
      estimatedFee: method?.fee ?? null, minimum: method?.minimum ?? null };
  });
  const recent = getDb().prepare(`SELECT COUNT(*) AS count FROM withdrawal_jobs WHERE status = 'complete' AND updated_at >= ?`).get(now - 86400000) as { count: number };
  return { enabled, dryRun: config.global.dryRun, updatedAt: now, hasApiKeys: hasAnyApiKeys(exchange),
    connection: connection ?? { exchanges: [] }, assets, activeJobs: jobs, feeBudget,
    summary: { pendingAssets: assets.filter(a => a.pendingAmount > 0).length, activeWithdrawals: jobs.length,
      needsAttention: jobs.filter(j => ['held', 'unknown', 'failed'].includes(j.status)).length,
      completed24h: recent.count }, stuckMinutes: config.polling.withdrawStatus.stuckMinutes };
}

export type DashboardStatus = ReturnType<typeof buildDashboardStatus>;

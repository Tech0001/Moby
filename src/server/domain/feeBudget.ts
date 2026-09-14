import { getDb } from '../db/sqlite.js';

export const FEE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Keep uncertain and accepted requests charged to the budget, including cancellations. */
export function getFeeBudgetUsage(limit: number | null = null, now = Date.now()) {
  const row = getDb().prepare(`SELECT COALESCE(SUM(CASE WHEN actual_fee > quoted_fee AND quoted_fee > 0
      THEN fee_usd * actual_fee / quoted_fee ELSE fee_usd END), 0) AS reservedUsd,
    COALESCE(SUM(CASE WHEN fee_usd IS NULL OR (actual_fee > 0 AND quoted_fee = 0) THEN 1 ELSE 0 END), 0) AS unpriced,
    MIN(created_at) AS oldest
    FROM withdrawal_jobs WHERE created_at > ?
    AND NOT (status IN ('failed', 'cancelled') AND exchange_ref IS NULL)`)
    .get(now - FEE_WINDOW_MS) as { reservedUsd: number; unpriced: number; oldest: number | null };
  return { limitUsd: limit, reservedUsd: row.reservedUsd, unpriced: row.unpriced,
    remainingUsd: limit == null ? null : Math.max(0, limit - row.reservedUsd),
    nextExpiryAt: row.oldest == null ? null : row.oldest + FEE_WINDOW_MS };
}

export function feeBudgetReason(limit: number | null | undefined, nextFeeUsd: number | null, now = Date.now()): string | null {
  if (limit == null) return null;
  if (!Number.isFinite(limit) || limit <= 0) return 'Invalid fee budget; check Configuration';
  const usage = getFeeBudgetUsage(limit, now);
  if (usage.unpriced) return 'Fee budget waiting: recent withdrawals have unpriced fees';
  if (nextFeeUsd == null || !Number.isFinite(nextFeeUsd) || nextFeeUsd < 0) return 'USD price unavailable for fee budget';
  if (usage.reservedUsd + nextFeeUsd > limit + 1e-8) return 'Rolling 24-hour fee budget reached';
  return null;
}

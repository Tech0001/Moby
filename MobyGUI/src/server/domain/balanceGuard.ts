import { getActiveWithdrawalJobs, getAllAssetStates, getQueueRevision, setPendingAmount } from '../db/repositories.js';
import type { ExchangeRestClient, ExchangeId } from '../exchanges/types.js';
import { validateBalances } from '../exchanges/balances.js';

function activeSignature(exchange: ExchangeId): string {
  return JSON.stringify(getActiveWithdrawalJobs(exchange).map(j => [j.id, j.asset, j.amount, j.status]));
}

// Only a successful, complete account snapshot can confirm an omitted asset
// is zero. Temporary order holds must not erase queued funds.
export async function checkBalances(exchange: ExchangeId, client: ExchangeRestClient, canApply = () => true) {
  const revision = getQueueRevision(exchange), jobs = activeSignature(exchange);
  const states = getAllAssetStates(exchange);
  const balances = await client.getBalance({ includeHeld: true });
  validateBalances(balances);
  if (!canApply() || revision !== getQueueRevision(exchange) || jobs !== activeSignature(exchange)) {
    throw new Error('Account activity changed during the balance check; check again');
  }
  const activeAssets = new Set(getActiveWithdrawalJobs(exchange).map(job => job.asset));
  const adjusted: string[] = [], deferred: string[] = [];
  for (const state of states) {
    // Reservations already reduce pending. Wait for this asset's withdrawal
    // to settle instead of subtracting it twice from a changing remote balance.
    if (activeAssets.has(state.asset)) { deferred.push(state.asset); continue; }
    const amount = Math.max(0, Number(balances[state.asset] ?? '0'));
    if (amount < state.pendingAmount) { setPendingAmount(exchange, state.asset, amount); adjusted.push(state.asset); }
  }
  return { adjusted, deferred, unchanged: states.map(s => s.asset).filter(a => !adjusted.includes(a)), revision: getQueueRevision(exchange) };
}

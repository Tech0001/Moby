import { createHash } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { getAllAssetStates, getActiveWithdrawalJobs, getAppStateValue, getControlRevision, getQueueRevision,
  isEnabled, setEnabled, setAppStateValue, setPendingAmount } from '../db/repositories.js';
import type { ExchangeId } from './types.js';

export function initializeWithdrawalState(enabledOnBoot: boolean): boolean {
  // Honor an explicit pause, including one saved by older versions.
  const bootRequested = enabledOnBoot && getAppStateValue('manual_pause') !== 'true' && getAppStateValue('enabled') !== 'false';
  setEnabled(false);
  return bootRequested;
}

export function getQueuePreview() {
  const states = getAllAssetStates().sort((a, b) => `${a.exchange}:${a.asset}`.localeCompare(`${b.exchange}:${b.asset}`));
  const amounts = states.filter(s => s.pendingAmount > 0).map(s => ({ exchange: s.exchange, asset: s.asset, amount: s.pendingAmount }));
  const activeJobs = getActiveWithdrawalJobs().map(j => ({ id: j.id, status: j.status })).sort((a, b) => a.id.localeCompare(b.id));
  const token = createHash('sha256').update(JSON.stringify({ states, activeJobs, control: getControlRevision(),
    revisions: states.map(s => getQueueRevision(s.exchange)) })).digest('hex');
  return { amounts, activeWithdrawals: activeJobs.length, token };
}

export function clearQueuedAmounts(token: string) {
  return getDb().transaction(() => {
    if (isEnabled()) throw new Error('Pause withdrawals before clearing queued amounts');
    const preview = getQueuePreview();
    if (preview.activeWithdrawals) throw new Error('Wait for active withdrawals to settle or resolve them before clearing the queue');
    if (token !== preview.token) throw new Error('The queue changed. Review the updated amounts and try again');
    const now = Date.now();
    for (const state of getAllAssetStates()) setPendingAmount(state.exchange, state.asset, 0);
    for (const exchange of ['kraken', 'gemini', 'kucoin', 'gateio']) setAppStateValue(`queue_cleared_before:${exchange}`, String(now));
    setAppStateValue('manual_pause', 'true');
    setEnabled(false); // Invalidate any resume or submission still being prepared.
    setAppStateValue('last_queue_clear', JSON.stringify({ at: now, amounts: preview.amounts }));
    return { cleared: preview.amounts, enabled: false };
  }).immediate();
}

export class WithdrawalControl {
  private resuming = false;
  constructor(private options: { exchanges: () => ExchangeId[]; check: (exchange: ExchangeId) => Promise<unknown>; wake: () => void }) {}
  pause(): void {
    setAppStateValue('manual_pause', 'true');
    setEnabled(false);
    this.options.wake();
  }
  async resume(canResume = () => true): Promise<void> {
    if (this.resuming) throw new Error('A balance check is already running');
    if (isEnabled()) return;
    this.resuming = true;
    const revision = getControlRevision();
    const exchanges = this.options.exchanges();
    const unchanged = () => revision === getControlRevision() && canResume() &&
      JSON.stringify(exchanges) === JSON.stringify(this.options.exchanges());
    try {
      if (!exchanges.length) throw new Error('No enabled exchange with active API keys');
      for (const exchange of exchanges) {
        if (!unchanged()) throw new Error('Resume cancelled; withdrawals remain paused');
        await this.options.check(exchange);
      }
      if (!unchanged()) throw new Error('Resume cancelled; withdrawals remain paused');
      setAppStateValue('manual_pause', 'false');
      setEnabled(true);
      this.options.wake();
    } finally { this.resuming = false; }
  }
}

import { exchangeName, formatAmount } from '../lib/display';
import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function WithdrawalReview({ job, onRefresh }: {
  job: { id: string; exchange?: string; destKey?: string; asset: string; amount: number; createdAt: number }; onRefresh: () => void;
}) {
  const [ref, setRef] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function resolve(notSent = false) {
    if (notSent && !window.confirm('Have you checked the exchange withdrawal history and confirmed this request was NOT sent? Its amount will be available for withdrawal again.')) return;
    setBusy(true); setError('');
    try {
      const res = await apiFetch(`/api/withdrawals/${job.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notSent ? { outcome: 'not_sent', confirmed: true } : { refid: ref }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Review failed');
      onRefresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Review failed'); }
    finally { setBusy(false); }
  }
  return <div className="border border-yellow-500 rounded p-4 space-y-3 mb-4">
    <p className="font-medium">Uncertain withdrawal: {formatAmount(job.amount)} {job.asset} · {exchangeName(job.exchange || 'kraken')} · {job.destKey}</p>
    <p className="text-sm">Check the exchange’s withdrawal history. Link its reference if accepted, or confirm it was not sent before allowing another attempt.</p>
    <div className="flex gap-2 flex-wrap"><Input className="max-w-sm" aria-label="Exchange withdrawal reference" value={ref} onChange={e => setRef(e.target.value)} placeholder="Exchange withdrawal reference" />
      <Button disabled={busy || !ref.trim()} onClick={() => resolve()}>Link reference</Button>
      <Button variant="outline" disabled={busy || Date.now() - job.createdAt < 120000} onClick={() => resolve(true)}>I checked: not sent</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

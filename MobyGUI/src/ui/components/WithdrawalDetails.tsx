import { useEffect, useRef, useState } from 'react';
import { Copy, Check, ChevronRight } from 'lucide-react';
import type { WithdrawalJob } from '../../server/domain/types';
import { formatAmount, exchangeName, elapsed } from '../lib/display';

export function StatusBadge({ status }: { status: string }) {
  const tone = ['complete'].includes(status) ? 'success' : ['failed', 'unknown', 'Needs review', 'API key required', 'Wallet required'].includes(status)
    ? 'danger' : ['held', 'On hold', 'Retry delay', 'Fee budget'].includes(status) ? 'warning' : ['pending', 'submitted', 'Queued', 'In progress'].includes(status) ? 'info' : 'neutral';
  return <span className="status-badge" data-tone={tone}>{({ complete: 'Complete', unknown: 'Needs review', held: 'On hold', pending: 'In progress', submitted: 'Submitting', failed: 'Failed', cancelled: 'Cancelled' } as Record<string, string>)[status] || status}</span>;
}
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [notice, setNotice] = useState(''), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setNotice('Copied'); } catch { setNotice('Select and copy the text'); }
    if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setNotice(''), 3000);
  }
  return <span className="flex items-start gap-2 min-w-0"><span className="font-mono break-all select-text">{value}</span>
    <button type="button" className="shrink-0 p-1 rounded hover:bg-muted" onClick={copy} aria-label={`Copy ${label}`} title={`Copy ${label}`}>
      {notice === 'Copied' ? <Check size={14} /> : <Copy size={14} />}</button>{notice && <span role="status" className="text-xs">{notice}</span>}</span>;
}
export function WithdrawalDetails({ job }: { job: WithdrawalJob }) {
  return <details className="withdrawal-row group">
    <summary className="cursor-pointer list-none flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
      <ChevronRight size={16} className="shrink-0 transition-transform group-open:rotate-90" />
      <div className="min-w-[130px] flex-1"><span className="font-semibold tabular-nums" title={String(job.amount)}>{formatAmount(job.amount)} {job.asset}</span>
        <p className="text-xs text-muted-foreground">{exchangeName(job.exchange)} · {job.destKey}</p></div>
      <span className="text-xs text-muted-foreground" title={new Date(job.createdAt).toLocaleString()}>{elapsed(job.createdAt)} ago</span>
      <StatusBadge status={job.status} />
    </summary>
    <div className="border-t px-4 py-4 grid sm:grid-cols-2 gap-4 text-sm">
      <div><p className="detail-label">Network / method</p><p>{job.method}</p></div>
      <div><p className="detail-label">{job.actualFee != null ? 'Exchange-reported fee' : 'Quoted fee'}</p>
        <p className="font-mono">{job.actualFee == null && job.quotedFee == null ? 'Not recorded for this withdrawal' : `${formatAmount(job.actualFee ?? job.quotedFee)} ${job.asset}`}</p></div>
      <div><p className="detail-label">Started</p><p>{new Date(job.createdAt).toLocaleString()}</p></div>
      <div><p className="detail-label">Last checked / updated</p><p>{new Date(job.updatedAt).toLocaleString()}</p></div>
      {job.destinationAddress && <div className="sm:col-span-2"><p className="detail-label">Destination · {job.destKey}</p><CopyValue label="destination address" value={job.destinationAddress} /></div>}
      {job.exchangeRef && <div className="sm:col-span-2"><p className="detail-label">Exchange reference</p><CopyValue label="exchange reference" value={job.exchangeRef} /></div>}
      {job.txid && <div className="sm:col-span-2"><p className="detail-label">Transaction ID</p><CopyValue label="transaction ID" value={job.txid} /></div>}
      {job.lastError && <p className="sm:col-span-2 text-destructive break-words">{job.lastError}</p>}
      <p className="sm:col-span-2 text-xs text-muted-foreground">Completion is reported by the exchange. Wallet receipt is not independently verified.</p>
    </div>
  </details>;
}

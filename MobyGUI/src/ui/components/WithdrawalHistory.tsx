import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useDocumentVisibility } from '../lib/useDocumentVisibility';
import { exchangeName } from '../lib/display';
import { Freshness } from './Freshness';
import { WithdrawalDetails } from './WithdrawalDetails';
import { Input } from './ui/input';
import { Button } from './ui/button';
import type { WithdrawalJob } from '../../server/domain/types';
export function WithdrawalHistory({ compact = false, onViewAll }: { compact?: boolean; onViewAll?: () => void }) {
  const [jobs, setJobs] = useState<WithdrawalJob[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0);
  const [query, setQuery] = useState(''), [exchange, setExchange] = useState(''), [status, setStatus] = useState('');
  const [error, setError] = useState(''), [at, setAt] = useState<number | null>(null), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const visible = useDocumentVisibility(), limit = compact ? 5 : 25;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, initial: ReturnType<typeof setTimeout>;
    const load = async () => {
      const abort = new AbortController(); controller.current = abort; setBusy(true);
      try {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(query ? { q: query } : {}), ...(exchange ? { exchange } : {}), ...(status ? { status } : {}) });
        const res = await apiFetch(`/api/withdrawals?${params}`, { signal: abort.signal });
        if (!res.ok) throw new Error('Could not load withdrawal history');
        const data = await res.json();
        if (!Array.isArray(data.jobs) || !Number.isFinite(data.total)) throw new Error('Invalid withdrawal history response');
        if (!stopped) { setJobs(data.jobs); setTotal(data.total); setAt(Date.now()); setError(''); }
      } catch (e) { if (!stopped && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'Connection interrupted'); }
      finally { if (!stopped) { setBusy(false); timer = setTimeout(load, 30000); } }
    };
    initial = setTimeout(load, query ? 250 : 0);
    return () => { stopped = true; controller.current?.abort(); clearTimeout(timer); clearTimeout(initial); };
  }, [visible, limit, offset, query, exchange, status, refresh]);
  return <section className="space-y-3">
    <div className="flex flex-wrap justify-between items-center gap-2"><h2 className="section-heading">{compact ? 'Recent withdrawals' : 'Withdrawal history'}</h2>
      <div className="flex gap-3 items-center"><Freshness at={at} staleAfter={65000} />{compact ? <Button variant="ghost" size="sm" onClick={onViewAll}>View all</Button> : <Button variant="outline" size="sm" disabled={busy} onClick={() => setRefresh(v => v + 1)}>Refresh</Button>}</div></div>
    {!compact && <div className="flex flex-wrap gap-2">
      <Input className="flex-1 min-w-[220px]" aria-label="Search withdrawals" placeholder="Search asset, wallet, reference or transaction ID" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} />
      <select className="filter-select" aria-label="Withdrawal exchange" value={exchange} onChange={e => { setExchange(e.target.value); setOffset(0); }}><option value="">All exchanges</option>{['kraken','gemini','kucoin','gateio'].map(e => <option key={e} value={e}>{exchangeName(e)}</option>)}</select>
      <select className="filter-select" aria-label="Withdrawal status" value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}><option value="">All statuses</option>{['submitted','pending','held','unknown','complete','failed','cancelled'].map(s => <option key={s} value={s}>{s === 'unknown' ? 'Needs review' : s}</option>)}</select>
    </div>}
    {error && <p role="alert" className="text-destructive text-sm">{error}. Retrying automatically.</p>}
    <div className="divide-y rounded-lg border overflow-hidden">{jobs.length ? jobs.map(job => <WithdrawalDetails key={job.id} job={job} />) : <p className="p-6 text-sm text-muted-foreground">{at ? 'No withdrawals match this view.' : 'Loading withdrawal history…'}</p>}</div>
    {!compact && <div className="flex items-center justify-between gap-2 text-sm"><span className="text-muted-foreground">{total ? `${offset + 1}–${Math.min(offset + jobs.length, total)} of ${total}` : '0 withdrawals'}</span>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button><Button size="sm" variant="outline" disabled={busy || offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next</Button></div></div>}
  </section>;
}

import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { exchangeName, formatAmount } from '../lib/display';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';

interface QueuePreview { amounts: Array<{ exchange: string; asset: string; amount: number }>; activeWithdrawals: number; token: string }
export function ClearQueuedAmounts({ onCleared }: { onCleared: () => void }) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<QueuePreview | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setPreview(null); setError('');
    void (async () => {
      try {
        const response = await apiFetch('/api/control/queue', { signal: controller.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load the queue');
        if (!controller.signal.aborted) setPreview(data);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load the queue'); }
    })();
    return () => controller.abort();
  }, [open, refresh]);
  async function clear() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const response = await apiFetch('/api/control/queue/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, token: preview.token }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not clear the queue');
      setOpen(false); onCleared();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not clear the queue'); setPreview(null); }
    finally { setBusy(false); }
  }
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Clear queued amounts…</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent>
      <DialogHeader><DialogTitle>Clear queued amounts</DialogTitle><DialogDescription>
        Use this after handling funds yourself, especially while Moby was closed. These amounts will stop being scheduled for withdrawal.
        Your wallets, settings and withdrawal history stay saved. Withdrawals remain paused; new fills can build a new queue.
      </DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!preview && !error && <p>Loading queued amounts…</p>}
      {preview && <>
        {preview.amounts.length ? <ul className="space-y-2">{preview.amounts.map(a => <li key={`${a.exchange}:${a.asset}`} className="flex justify-between gap-4 text-sm">
          <span>{exchangeName(a.exchange)} · {a.asset}</span><span className="font-mono">{formatAmount(a.amount)} {a.asset}</span>
        </li>)}</ul> : <p>No queued amounts to clear.</p>}
        {preview.activeWithdrawals > 0 && <p role="alert" className="text-sm">{preview.activeWithdrawals} withdrawal(s) are still active. Wait for them to settle or resolve them before clearing the queue.</p>}
      </>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="outline" disabled={busy} onClick={() => setRefresh(v => v + 1)}>Refresh amounts</Button>
        <Button variant="destructive" disabled={busy || !preview?.amounts.length || !!preview.activeWithdrawals} onClick={clear}>{busy ? 'Clearing…' : 'Clear these amounts'}</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </>;
}

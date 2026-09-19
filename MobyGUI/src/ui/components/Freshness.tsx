import { useEffect, useState } from 'react';
import { elapsed } from '../lib/display';
import { useDocumentVisibility } from '../lib/useDocumentVisibility';
export function Freshness({ at, staleAfter = 60000 }: { at: number | null; staleAfter?: number }) {
  const [now, setNow] = useState(Date.now), visible = useDocumentVisibility();
  useEffect(() => { if (!visible) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [visible]);
  return <span className={`text-xs ${at && now - at > staleAfter ? 'text-amber-500' : 'text-muted-foreground'}`} title={at ? new Date(at).toLocaleString() : ''}>
    {at ? `Updated ${elapsed(at, now)} ago${now - at > staleAfter ? ' · stale' : ''}` : 'Waiting for data'}
  </span>;
}

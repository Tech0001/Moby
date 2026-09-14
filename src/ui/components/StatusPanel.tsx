import type { DashboardStatus } from '../../server/domain/dashboardStatus';
import { formatAmount, exchangeName, elapsed } from '../lib/display';
import { StatusBadge, WithdrawalDetails } from './WithdrawalDetails';
import { Progress } from './ui/progress';
import { Button } from './ui/button';
export function StatusPanel({ status, onRefresh }: { status: DashboardStatus | null; onRefresh: () => void }) {
  if (!status) return <p className="text-muted-foreground">Waiting for status data…</p>;
  const assets = [...status.assets].sort((a,b) => Number(b.attention) - Number(a.attention) || b.pendingAmount / (b.threshold || 1) - a.pendingAmount / (a.threshold || 1) || a.asset.localeCompare(b.asset));
  return <div className="space-y-6">
    <section className="space-y-3"><h2 className="section-heading">Active withdrawals <span className="text-muted-foreground font-normal">({status.activeJobs.length})</span></h2>
      <div className="border rounded-lg overflow-hidden divide-y">{status.activeJobs.length ? status.activeJobs.map(job => <WithdrawalDetails key={job.id} job={job} />)
        : <p className="p-5 text-sm text-muted-foreground">No withdrawals in progress. New eligible fills will appear in the sweep monitor.</p>}</div>
    </section>
    <section className="space-y-3"><div className="flex items-center justify-between gap-2"><div><h2 className="section-heading">Sweep monitor</h2><p className="text-xs text-muted-foreground">Accumulated fills and what happens next</p></div><Button variant="ghost" size="sm" onClick={onRefresh}>Refresh status</Button></div>
      {assets.length ? <div className="grid gap-3 lg:grid-cols-2">{assets.map(asset => <article key={`${asset.exchange}:${asset.asset}`} className="sweep-card">
        <div className="flex flex-wrap justify-between gap-2 mb-3"><div><span className="font-semibold">{asset.asset}</span><span className="ml-2 text-xs text-muted-foreground">{exchangeName(asset.exchange)}</span></div><StatusBadge status={asset.state || (asset.enabled ? 'Waiting' : 'Disabled')} /></div>
        <div className="flex justify-between gap-2 text-sm mb-2 tabular-nums"><span title={String(asset.pendingAmount)}>{formatAmount(asset.pendingAmount)} {asset.asset}</span><span className="text-muted-foreground">of {formatAmount(asset.threshold)}</span></div>
        <Progress value={asset.threshold > 0 ? Math.min(100, asset.pendingAmount / asset.threshold * 100) : 0} aria-label={`${asset.asset} accumulation threshold`} className="h-1.5" />
        <p className="text-sm mt-3 min-h-10">{asset.reason}{asset.nextEligibleAt && asset.nextEligibleAt > Date.now() ? ` · ${elapsed(Date.now(), asset.nextEligibleAt)} remaining` : ''}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mt-3 pt-3 border-t">
          <div><dt className="detail-label">Next chunk target</dt><dd className="tabular-nums">{asset.chunkAmount ? `${formatAmount(asset.chunkAmount)} ${asset.chunkCurrency}` : 'Waiting for funds'}</dd></div>
          <div><dt className="detail-label">Wallet in rotation</dt><dd className="break-words">{asset.nextWallet || 'Not configured'}</dd></div>
          <div><dt className="detail-label">Cached fee / minimum</dt><dd>{formatAmount(asset.estimatedFee)} / {formatAmount(asset.minimum)} {asset.asset}</dd></div>
          <div><dt className="detail-label">Network / method</dt><dd>{asset.network || 'Not configured'}</dd></div>
        </dl>
        <p className="text-[11px] text-muted-foreground mt-3">Final amount, fee, and wallet are checked before submission.</p>
      </article>)}</div> : <p className="text-sm text-muted-foreground border rounded-lg p-5">Choose assets and destination wallets in Configuration to begin.</p>}
    </section>
  </div>;
}

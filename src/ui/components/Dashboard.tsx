import { useEffect, useState } from 'react';
import { LayoutDashboard, List, Key, Settings, LogOut, Wallet, Bell, ScrollText, History, Palette } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { exchangeName, formatAmount } from '../lib/display';
import { useDocumentVisibility } from '../lib/useDocumentVisibility';
import type { DashboardStatus } from '../../server/domain/dashboardStatus';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Button } from './ui/button';
import { WhaleIcon } from './ui/WhaleIcon';
import { StatusPanel } from './StatusPanel';
import { WithdrawalReview } from './WithdrawalReview';
import { WithdrawalHistory } from './WithdrawalHistory';
import { ApiKeysPanel } from './ApiKeysPanel';
import { ConfigPanel } from './ConfigPanel';
import { OrdersPanel } from './OrdersPanel';
import { ManagementPanel } from './ManagementPanel';
import { BalancePanel } from './BalancePanel';
import { LogsPanel } from './LogsPanel';
import { NotificationsPanel } from './NotificationsPanel';
import { SetupGuide } from './SetupGuide';
import { ModeToggle } from './ModeToggle';
import { ThemeSelector } from './ThemeSelector';
import { Freshness } from './Freshness';
import { ClearQueuedAmounts } from './ClearQueuedAmounts';
import { useTheme } from './ThemeProvider';
import { externalPalettes } from '../themes/registry';

const navigation = [
  ['status', 'Overview', LayoutDashboard], ['history', 'Withdrawals', History], ['orders', 'Orders', List],
  ['api-keys', 'API Keys', Key], ['config', 'Configuration', Settings], ['management', 'Wallets', Wallet],
  ['logs', 'Logs', ScrollText], ['notifications', 'Notifications', Bell],
] as const;
export function Dashboard({ user, onLogout }: { user: { userId: string; username: string }; onLogout: () => void }) {
  const { style, setStyle } = useTheme(), visible = useDocumentVisibility();
  const [status, setStatus] = useState<DashboardStatus | null>(null), [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(''), [controlError, setControlError] = useState('');
  const [toggling, setToggling] = useState(false), [refresh, setRefresh] = useState(0), [at, setAt] = useState<number | null>(null);
  const [showBalances, setShowBalances] = useState(false), [balanceExchange, setBalanceExchange] = useState('');
  const [activeTab, setActiveTab] = useState(() => { const saved = localStorage.getItem('activeTab'); return navigation.some(([id]) => id === saved) ? saved! : 'status'; });
  const fetchStatus = () => setRefresh(v => v + 1);
  useEffect(() => { localStorage.setItem('activeTab', activeTab); document.querySelector('.moby-navigation [data-state=active]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [activeTab, loading]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.altKey && e.code === 'KeyT') { e.preventDefault(); setStyle(externalPalettes[(externalPalettes.findIndex(p => p.id === style) + 1) % externalPalettes.length].id); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [style, setStyle]);
  useEffect(() => { window.addEventListener('online', fetchStatus); return () => window.removeEventListener('online', fetchStatus); }, []);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const res = await apiFetch('/api/status', { signal: controller.signal });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        if (!stopped) { setStatus(data); setConnectionError(''); setAt(Date.now()); }
      } catch (e) { if (!stopped) setConnectionError(e instanceof Error ? e.message : 'Connection interrupted'); }
      finally { if (!stopped) { setLoading(false); timer = setTimeout(tick, visible ? 5000 : 30000); } }
    };
    void tick(); return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [visible, refresh]);
  async function toggleEnabled() {
    if (!status || toggling) return; setToggling(true); setControlError('');
    try {
      const res = await apiFetch(status.enabled ? '/api/control/stop' : '/api/control/start', { method: 'POST' }, status.enabled ? 30000 : 120000);
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Could not change withdrawal state');
      setStatus(current => current ? { ...current, enabled: data.enabled } : current); fetchStatus();
    } catch (e) { setControlError(e instanceof Error ? e.message : 'Could not change withdrawal state'); }
    finally { setToggling(false); }
  }
  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading Moby…</div>;
  const jobs = status?.activeJobs ?? [], needsReview = jobs.filter(j => j.status === 'unknown'), held = jobs.filter(j => j.status === 'held');
  const exchanges = [...new Set([...(status?.connection?.exchanges.map(e => e.exchange) ?? []), ...(status?.assets.map(a => a.exchange) ?? [])])];
  const selectedBalanceExchange = exchanges.includes(balanceExchange) ? balanceExchange : exchanges[0];
  return <div className="moby-dashboard min-h-screen bg-background text-foreground">
    <header className="sticky top-0 z-50 border-b bg-background"><div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
      <div className="flex gap-3 items-center"><WhaleIcon className="h-8 w-auto text-primary" /><h1 className="text-xl font-semibold">Moby</h1></div>
      <div className="flex gap-3 items-center">
        <details className="relative"><summary className="cursor-pointer list-none p-2 rounded hover:bg-muted" aria-label="Appearance" title="Appearance"><Palette size={18} /></summary>
          <div className="absolute right-0 top-10 flex gap-3 items-center border rounded-lg bg-popover p-3 shadow-lg"><ThemeSelector /><ModeToggle /></div></details>
        <span className="text-sm truncate max-w-32" title={user.username}>{user.username}</span>
        <button className="p-2 hover:bg-muted rounded" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
      </div>
    </div></header>
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <div className="sticky top-16 z-40 border-b bg-background"><div className="max-w-7xl mx-auto px-4 overflow-x-auto"><TabsList className="moby-navigation h-12 bg-transparent justify-start gap-1 p-0">
        {navigation.map(([id, label, Icon]) => <TabsTrigger key={id} value={id} className="gap-2 px-3 h-10"><Icon size={15} />{label}</TabsTrigger>)}
      </TabsList></div></div>
      <main className="max-w-7xl mx-auto px-4 py-5 space-y-4">
        <section className="control-strip">
          <div className="flex items-center gap-3 min-w-0"><span className={`h-2.5 w-2.5 rounded-full shrink-0 ${connectionError ? 'bg-amber-500' : status?.enabled && !status.dryRun ? 'bg-green-500' : 'bg-muted-foreground'}`} />
            <div><p className="font-medium">{connectionError ? 'Status unavailable' : status?.dryRun ? 'Dry run enabled' : status?.enabled ? 'Withdrawals running' : 'Withdrawals paused'}</p>
              <p className="text-xs text-muted-foreground">{connectionError ? 'Showing the last received state' : status?.enabled ? 'Watching for eligible fills' : 'Fill monitoring continues while withdrawals are paused'}</p></div></div>
          <div className="flex items-center gap-4"><Freshness at={at} staleAfter={45000} /><Button size="sm" variant={status?.enabled ? 'outline' : 'default'} disabled={toggling || !status?.hasApiKeys || !!connectionError} onClick={toggleEnabled}>{toggling ? status?.enabled ? 'Pausing…' : 'Checking balances…' : status?.enabled ? 'Pause withdrawals' : 'Resume withdrawals'}</Button></div>
        </section>
        {status && !status.enabled && !connectionError && <div className="notice-banner flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">Resume checks current balances first. If you handled funds while Moby was closed, clear any queued amounts you no longer want withdrawn.</p>
          <ClearQueuedAmounts onCleared={() => { setControlError(''); fetchStatus(); }} />
        </div>}
        {status?.dryRun && <div role="status" className="notice-banner">Dry run: Moby simulates checks and will not submit withdrawals. Turn it off in Configuration to withdraw.</div>}
        {connectionError && <div role="alert" className="notice-banner">Connection interrupted. Retrying automatically. {connectionError}</div>}
        {controlError && <div role="alert" className="notice-banner">{controlError}</div>}
        <div className="flex flex-wrap gap-2 items-center">{status?.connection?.exchanges.map(e => <span key={e.exchange} className="connection-chip" data-connected={e.connected && !e.error} title={e.error || (e.lastSuccessAt ? `Last trade catch-up: ${new Date(e.lastSuccessAt).toLocaleString()}` : 'Waiting for initial trade catch-up')}>
          <span className="h-2 w-2 rounded-full bg-current" />{exchangeName(e.exchange)} · {!e.connected ? 'Reconnecting' : e.error ? 'Catch-up delayed' : 'Connected'}</span>)}
          {status?.hasApiKeys && !status.connection?.exchanges.length && <span className="text-xs text-muted-foreground">No active exchange connections. Check API keys and exchange settings.</span>}
        </div>
        {status?.connection?.exchanges.filter(e => e.error).map(e => <div role="alert" className="notice-banner" key={e.exchange}>{exchangeName(e.exchange)} trade catch-up failed: {e.error}</div>)}
        {(needsReview.length > 0 || held.length > 0) && activeTab !== 'status' && <div className="notice-banner flex flex-wrap justify-between gap-2" role="alert"><span>{needsReview.length + held.length} withdrawal{needsReview.length + held.length === 1 ? '' : 's'} need attention.</span><Button size="sm" variant="outline" onClick={() => setActiveTab('status')}>Review withdrawals</Button></div>}
        <TabsContent value="status" className="space-y-6 mt-0">
          <SetupGuide hasApiKeys={status?.hasApiKeys ?? false} hasConfiguredAssets={!!status?.assets.length} isSweeperEnabled={status?.enabled ?? false} onNavigate={setActiveTab} onToggleSweeper={toggleEnabled} />
          {needsReview.map(job => <WithdrawalReview key={job.id} job={job} onRefresh={fetchStatus} />)}
          {held.map(job => <div key={job.id} role="alert" className="notice-banner">{exchangeName(job.exchange)} is holding {formatAmount(job.amount)} {job.asset} for {job.destKey}. Further chunks for this asset are paused. Check the withdrawal at the exchange.</div>)}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Metric label="Active withdrawals" value={String(jobs.length)} />
            <Metric label="Assets with pending fills" value={String(status?.summary?.pendingAssets ?? status?.assets.filter(a => a.pendingAmount > 0).length ?? 0)} />
            <Metric label="Completed · 24 hours" value={String(status?.summary?.completed24h ?? 0)} />
            <Metric label="Quoted fees · 24 hours" value={`$${(status?.feeBudget?.reservedUsd ?? 0).toFixed(2)}`} detail={`${status?.feeBudget?.limitUsd != null ? `$${status.feeBudget.limitUsd} budget` : 'No budget set'}${status?.feeBudget?.unpriced ? ` · ${status.feeBudget.unpriced} unpriced` : ''}`} />
          </div>
          <StatusPanel status={status} onRefresh={fetchStatus} />
          <WithdrawalHistory compact onViewAll={() => setActiveTab('history')} />
          {exchanges.length > 0 && <section className="space-y-3 border-t pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><Button variant="ghost" onClick={() => setShowBalances(v => !v)} aria-expanded={showBalances}>{showBalances ? 'Hide' : 'Show'} account balances</Button>
            {showBalances && <select className="filter-select" aria-label="Balance exchange" value={selectedBalanceExchange} onChange={e => setBalanceExchange(e.target.value)}>{exchanges.map(e => <option key={e} value={e}>{exchangeName(e)}</option>)}</select>}</div>
            {showBalances && selectedBalanceExchange && <BalancePanel exchange={selectedBalanceExchange} />}</section>}
        </TabsContent>
        <TabsContent value="history">{activeTab === 'history' && <WithdrawalHistory />}</TabsContent>
        <TabsContent value="orders">{activeTab === 'orders' && <OrdersPanel />}</TabsContent>
        <TabsContent value="api-keys">{activeTab === 'api-keys' && <ApiKeysPanel hasKeys={status?.hasApiKeys ?? false} onUpdate={fetchStatus} />}</TabsContent>
        <TabsContent value="config">{activeTab === 'config' && <ConfigPanel />}</TabsContent>
        <TabsContent value="management">{activeTab === 'management' && <ManagementPanel />}</TabsContent>
        <TabsContent value="logs">{activeTab === 'logs' && <LogsPanel />}</TabsContent>
        <TabsContent value="notifications">{activeTab === 'notifications' && <NotificationsPanel />}</TabsContent>
      </main>
    </Tabs>
  </div>;
}
function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="metric"><p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl tabular-nums font-semibold mt-1">{value}</p>{detail && <p className="text-xs text-muted-foreground mt-1">{detail}</p>}</div>;
}

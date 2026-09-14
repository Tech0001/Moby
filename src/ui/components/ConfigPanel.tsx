import { apiFetch } from '@/ui/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/ui/components/ui/card";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import { Badge } from "@/ui/components/ui/badge";
import { Switch } from "@/ui/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/ui/components/ui/dialog";
import { Alert, AlertDescription } from "@/ui/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/components/ui/select";
import { Trash2, Plus, RefreshCw, Pencil, Activity, AlertCircle } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/components/ui/tabs";
import { parsePair } from '../../server/domain/types';

// New simplified asset config (stored in database)
interface AssetConfig {
  exchange: string;
  asset: string;
  enabled: boolean;
  threshold: number;
  reserve: number;
  destKeys: string[];
  priority: number;
  cooldownSeconds: number;
  chunkAmount: number | null;
  chunkMode?: 'fixedCoin' | 'fixedUsd';
  chunkMax?: number | null;
  perWalletCapCoin?: number | null;
  perWalletCapUsd?: number | null;
}

interface GlobalConfig {
  enabledOnBoot: boolean;
  dryRun: boolean;
  dailyFeeBudgetUsd: number | null;
  maxInflightWithdrawals: number;
  perAssetMaxInflight: number;
  schedulerTickMs: number;
  backoffSeconds: number[];
  allowedOrderTypes: string[];
  keyNamePrefix?: string;
  disabledExchanges?: string[];
}

interface Config {
  global: GlobalConfig;
}

// Database-backed settings (editable)
interface GlobalSettings {
  dryRun: boolean;
  dailyFeeBudgetUsd: number | null;
  maxInflightWithdrawals: number;
  perAssetMaxInflight: number;
  keyNamePrefix: string;
  allowedOrderTypes: string[];
}

interface ExchangeAddress {
  id: number;
  exchange: string;
  address: string;
  asset: string;
  method: string;
  key: string;
  createdAt: number;
  lastSeenAt: number;
}

interface AvailableExchange {
  id: string;
  name: string;
  hasKeys: boolean;
  enabled?: boolean;
}

interface SweeperStatus {
  enabled: boolean;
  hasApiKeys: boolean;
}

interface ExchangeSyncSupport {
  exchange: string;
  supportsSync: boolean;
  requiresManualEntry: boolean;
}

interface WithdrawalMethod {
  exchange: string;
  asset: string;
  method: string;
  network: string | null;
  minimum: number;
  maximum: number | null;
  fee: number | null;
}

export function ConfigPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [assetConfigs, setAssetConfigs] = useState<AssetConfig[]>([]);
  const [addresses, setAddresses] = useState<ExchangeAddress[]>([]);
  const [withdrawalMethods, setWithdrawalMethods] = useState<WithdrawalMethod[]>([]);
  const [exchanges, setExchanges] = useState<AvailableExchange[]>([]);
  const [exchangeSyncSupport, setExchangeSyncSupport] = useState<Record<string, ExchangeSyncSupport>>({});
  const [activeAssets, setActiveAssets] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [addAssetFor, setAddAssetFor] = useState<{ exchange: string; asset: string; editingConfig?: AssetConfig } | null>(null);
  const [addManualAddressFor, setAddManualAddressFor] = useState<string | null>(null);
  const [sweeperStatus, setSweeperStatus] = useState<SweeperStatus | null>(null);
  const [toggling, setToggling] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [syncingExchange, setSyncingExchange] = useState<string | null>(null);

  // Settings state (database-backed)
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<GlobalSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    fetchConfig();
    fetchAssetConfigs();
    fetchSweeperStatus();
    fetchExchanges().then(() => fetchExchangeSyncSupport());
    fetchAddresses();
    fetchWithdrawalMethods();
    fetchSettings();
    fetchActiveAssets();
  }, []);

  async function fetchExchangeSyncSupport() {
    const supportMap: Record<string, ExchangeSyncSupport> = {};
    const exchangeIds = ['kraken', 'gemini', 'kucoin', 'gateio'];

    for (const exchangeId of exchangeIds) {
      try {
        const res = await apiFetch(`/api/exchanges/${exchangeId}/supports-sync`);
        if (res.ok) {
          const data = await res.json();
          supportMap[exchangeId] = data;
        }
      } catch (err) {
        // Default to requiring sync
        supportMap[exchangeId] = { exchange: exchangeId, supportsSync: true, requiresManualEntry: false };
      }
    }
    setExchangeSyncSupport(supportMap);
  }

  async function fetchConfig() {
    try {
      const res = await apiFetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      }
    } catch (err) {
      setError('Failed to load config');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAssetConfigs() {
    try {
      const res = await apiFetch('/api/config/assets');
      if (res.ok) {
        const data = await res.json();
        setAssetConfigs(data.assets || []);
      }
    } catch (err) {
      console.error('Failed to fetch asset configs:', err);
    }
  }

  async function fetchSweeperStatus() {
    try {
      const res = await apiFetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setSweeperStatus({ enabled: data.enabled, hasApiKeys: data.hasApiKeys });
      }
    } catch (err) {
      // Ignore
    }
  }

  async function fetchExchanges() {
    try {
      const [exchangesRes, keysRes] = await Promise.all([
        apiFetch('/api/exchanges/available'),
        apiFetch('/api/keys')
      ]);

      if (exchangesRes.ok && keysRes.ok) {
        const exchangesData = await exchangesRes.json();
        const keysData = await keysRes.json();

        const exchangesWithKeys = new Set(keysData.keys.map((k: { exchange: string }) => k.exchange));

        const mapped = exchangesData.exchanges.map((ex: { id: string; name: string; enabled?: boolean }) => ({
          id: ex.id,
          name: ex.name,
          hasKeys: exchangesWithKeys.has(ex.id),
          enabled: ex.enabled,
        }));

        setExchanges(mapped);
      }
    } catch (err) {
      console.error('Failed to fetch exchanges:', err);
    }
  }

  async function fetchActiveAssets() {
    try {
      const res = await apiFetch('/api/orders?exchange=all');
      if (res.ok) {
        const data = await res.json();
        const orders = data.orders || [];
        
        const activeMap: Record<string, Set<string>> = {};
        
        for (const order of orders) {
          if (!activeMap[order.exchange]) {
            activeMap[order.exchange] = new Set();
          }
          
          try {
            // Parse pair to get base and quote assets
            // We use the helper from domain types if available, or simple split
            // The server response should ideally provide base/quote but we parse pair here
            // Assuming pairs are like XBT/USD, ETH-USDT, etc.
            // Using a simple heuristic if parsePair isn't imported or available
            let base, quote;
            if (typeof parsePair === 'function') {
               const parsed = parsePair(order.pair);
               base = parsed.base;
               quote = parsed.quote;
            } else {
               // Fallback basic parsing
               const parts = order.pair.split(/[-/]/);
               if (parts.length === 2) {
                 base = parts[0];
                 quote = parts[1];
               } else {
                 base = order.pair; // Fallback
               }
            }
            
            if (base) activeMap[order.exchange].add(base);
            if (quote) activeMap[order.exchange].add(quote);
          } catch (e) {
            console.warn('Failed to parse pair:', order.pair);
          }
        }
        
        setActiveAssets(activeMap);
      }
    } catch (err) {
      console.error('Failed to fetch active orders:', err);
    }
  }

  async function toggleSweeper() {
    if (!sweeperStatus) return;
    setToggling(true);
    try {
      const endpoint = sweeperStatus.enabled ? '/api/control/stop' : '/api/control/start';
      const res = await apiFetch(endpoint, { method: 'POST' }, sweeperStatus.enabled ? 30000 : 120000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not change withdrawal state');
      setSweeperStatus({ ...sweeperStatus, enabled: data.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle sweeper');
    } finally {
      setToggling(false);
    }
  }

  async function runReconcile() {
    setReconciling(true);
    setError('');
    setSuccess('');
    try {
      const res = await apiFetch('/api/control/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        const parts: string[] = [];
        for (const r of data.results || []) {
          const items: string[] = [];
          if (r.tradesProcessed > 0) items.push(`${r.tradesProcessed} trades`);
          if (r.balancesAdjusted?.length > 0) items.push(`${r.balancesAdjusted.length} balances adjusted`);
          if (items.length > 0) {
            parts.push(`${r.exchange}: ${items.join(', ')}`);
          }
        }
        setSuccess(parts.length > 0 ? `Reconciled: ${parts.join('; ')}` : 'Reconciliation complete - no changes needed');
      } else {
        setError(data.error || 'Reconciliation failed');
      }
    } catch (err) {
      setError('Failed to run reconciliation');
    } finally {
      setReconciling(false);
    }
  }

  async function fetchAddresses() {
    setLoadingAddresses(true);
    try {
      const res = await apiFetch('/api/addresses');
      if (res.ok) {
        const data = await res.json();
        setAddresses(data);
      }
    } catch (err) {
      // Ignore
    } finally {
      setLoadingAddresses(false);
    }
  }

  async function fetchWithdrawalMethods() {
    try {
      const res = await apiFetch('/api/withdrawal-methods');
      if (res.ok) {
        const data = await res.json();
        setWithdrawalMethods(data);
      }
    } catch (err) {
      // Ignore
    }
  }

  async function fetchSettings() {
    try {
      const res = await apiFetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  }

  async function saveSettings() {
    if (!settingsForm) return;

    setSavingSettings(true);
    setError('');
    setSuccess('');

    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to save settings');
        return;
      }

      setSettings(data.settings);
      setEditingSettings(false);
      setSuccess('Settings saved successfully');
    } catch (err) {
      setError('Network error');
    } finally {
      setSavingSettings(false);
    }
  }

  function startEditingSettings() {
    if (settings) {
      setSettingsForm({ ...settings });
      setEditingSettings(true);
    }
  }

  function cancelEditingSettings() {
    setSettingsForm(null);
    setEditingSettings(false);
  }

  async function syncAddresses(exchangeId: string, exchangeName: string) {
    setSyncingExchange(exchangeId);
    try {
      const res = await apiFetch(`/api/exchanges/${exchangeId}/addresses/sync`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        await fetchAddresses();
        await fetchAssetConfigs(); // Refresh configs in case destKeys were cleaned up
        await fetchWithdrawalMethods(); // Also refresh withdrawal methods (minimums, fees)
        const parts: string[] = [];
        parts.push(`${data.stats.fromExchange || data.stats.fromKraken || 0} from ${exchangeName}`);
        if (data.stats.new > 0) parts.push(`${data.stats.new} new`);
        if (data.stats.restored > 0) parts.push(`${data.stats.restored} restored`);
        if (data.stats.deleted > 0) parts.push(`${data.stats.deleted} deleted`);
        if (data.stats.methodsCached > 0) parts.push(`${data.stats.methodsCached} methods cached`);
        setSuccess(`Sync complete: ${parts.join(', ')}`);
      } else {
        const data = await res.json();
        setError(data.error || `Failed to sync addresses from ${exchangeName}`);
      }
    } catch (err) {
      setError(`Failed to sync addresses from ${exchangeName}`);
    } finally {
      setSyncingExchange(null);
    }
  }

  async function addManualAddress(exchangeId: string, data: {
    asset: string;
    address: string;
    addressConfirm: string;
    method: string;
    key: string;
    memo?: string;
  }) {
    setSaving(true);
    setError('');

    try {
      const res = await apiFetch(`/api/exchanges/${exchangeId}/addresses/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || 'Failed to add address');
        return false;
      }

      setSuccess(`Added withdrawal address for ${data.asset}`);
      await fetchAddresses();
      return true;
    } catch (err) {
      setError('Network error');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteManualAddress(exchangeId: string, asset: string, key: string) {
    if (!confirm(`Delete withdrawal address "${key}" for ${asset}?`)) return;

    try {
      const res = await apiFetch(`/api/exchanges/${exchangeId}/addresses/${asset}/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setSuccess(`Deleted address "${key}"`);
        await fetchAddresses();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete address');
      }
    } catch (err) {
      setError('Network error');
    }
  }

  async function saveAssetConfig(exchange: string, asset: string, configData: {
    threshold: number;
    reserve: number;
    destKeys: string[];
    enabled?: boolean;
    priority?: number;
    cooldownSeconds?: number;
    chunkAmount?: number;
    perWalletCapCoin?: number | null;
    perWalletCapUsd?: number | null;
    chunkMode?: 'fixedCoin' | 'fixedUsd';
  }) {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await apiFetch(`/api/config/exchanges/${exchange}/assets/${asset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configData),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to save');
        return false;
      }

      setSuccess(`Saved ${asset} configuration for ${exchange}`);
      await fetchAssetConfigs();
      return true;
    } catch (err) {
      setError('Network error');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function deleteAssetConfig(exchange: string, asset: string) {
    if (!confirm(`Delete ${asset} configuration for ${exchange}?`)) return;

    try {
      const res = await apiFetch(`/api/config/exchanges/${exchange}/assets/${asset}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setSuccess(`Deleted ${asset} configuration`);
        await fetchAssetConfigs();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete');
      }
    } catch (err) {
      setError('Network error');
    }
  }

  async function toggleExchangeEnabled(exchange: string, enabled: boolean) {
    try {
      const res = await apiFetch(`/api/exchanges/${exchange}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        await Promise.all([fetchExchanges(), fetchConfig()]);
        if (enabled) {
          setSuccess(`Enabled ${exchange}`);
        } else {
          setSuccess(`Disabled ${exchange}`);
        }
      } else {
        setError('Failed to toggle exchange');
      }
    } catch (err) {
      setError('Network error');
    }
  }

  // Group addresses by exchange, then by asset
  const addressesByExchange = addresses.reduce((acc, addr) => {
    const exchange = addr.exchange || 'kraken';
    if (!acc[exchange]) {
      acc[exchange] = {};
    }
    const assetKey = addr.asset.split(/[-/]/)[0] || addr.asset;
    if (!acc[exchange][assetKey]) {
      acc[exchange][assetKey] = { method: addr.method, entries: [] as Array<{ key: string; address: string; method?: string }> };
    }
    acc[exchange][assetKey].entries.push({ key: addr.key, address: addr.address, method: addr.method });
    return acc;
  }, {} as Record<string, Record<string, { method: string; entries: Array<{ key: string; address: string; method?: string }> }>>);

  // Group asset configs by exchange
  const configsByExchange = assetConfigs.reduce((acc, cfg) => {
    if (!acc[cfg.exchange]) {
      acc[cfg.exchange] = {};
    }
    acc[cfg.exchange][cfg.asset] = cfg;
    return acc;
  }, {} as Record<string, Record<string, AssetConfig>>);

  // Exchanges that have API keys configured
  const exchangesWithKeys = exchanges.filter(ex => ex.hasKeys);

  if (loading) {
    return <div className="text-muted-foreground">Loading configuration...</div>;
  }

  if (!config) {
    return <div className="text-destructive">Failed to load configuration</div>;
  }

  return (
    <div className="space-y-6">
      <Tabs defaultValue="exchanges" className="w-full">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="exchanges">Exchanges & Wallets</TabsTrigger>
            <TabsTrigger value="system">System & Settings</TabsTrigger>
          </TabsList>
        </div>

        {error && <Alert variant="destructive" className="mb-4"><AlertDescription>{error}</AlertDescription></Alert>}
        {success && <Alert className="text-green-500 border-green-500 mb-4"><AlertDescription>{success}</AlertDescription></Alert>}

        <TabsContent value="system" className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            {/* System Control */}
            <Card className="h-full">
              <CardHeader className="py-4 border-b">
                <CardTitle>System Control</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        sweeperStatus?.enabled ? 'bg-green-500' : 'bg-gray-500'
                      }`}
                    />
                    <div className="space-y-0.5">
                      <div className="font-medium">
                        {sweeperStatus?.enabled ? 'Sweeper Running' : 'Sweeper Stopped'}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {!sweeperStatus?.hasApiKeys ? 'Configure API keys to enable' : sweeperStatus?.enabled ? 'System is active' : 'System is paused'}
                      </div>
                    </div>
                  </div>
                  <Button
                    onClick={toggleSweeper}
                    disabled={toggling || !sweeperStatus?.hasApiKeys}
                    variant={sweeperStatus?.enabled ? 'destructive' : 'default'}
                    size="sm"
                  >
                    {toggling ? sweeperStatus?.enabled ? 'Pausing…' : 'Checking balances…' : sweeperStatus?.enabled ? 'Stop' : 'Start'}
                  </Button>
                </div>

                <div className="flex items-center justify-between border-t pt-6">
                   <div className="space-y-0.5">
                      <div className="font-medium">Reconciliation</div>
                      <div className="text-xs text-muted-foreground">Sync trades & balances from exchanges</div>
                   </div>
                   <Button
                    onClick={runReconcile}
                    disabled={reconciling || !sweeperStatus?.hasApiKeys}
                    variant="outline"
                    size="sm"
                    className="gap-2"
                  >
                    <RefreshCw className={`h-4 w-4 ${reconciling ? 'animate-spin' : ''}`} />
                    {reconciling ? 'Reconciling...' : 'Reconcile'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Global Settings (Editable) */}
            <Card className="h-full">
              <CardHeader className="py-4 border-b flex flex-row items-center justify-between">
                <CardTitle>Global Settings</CardTitle>
                {!editingSettings && settings && (
                  <Button variant="outline" size="sm" onClick={startEditingSettings}>
                    Edit
                  </Button>
                )}
              </CardHeader>
              <CardContent className="p-4">
                {editingSettings && settingsForm ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <Label>Dry Run Mode</Label>
                        <p className="text-xs text-muted-foreground">Simulate withdrawals without executing</p>
                      </div>
                      <Switch
                        checked={settingsForm.dryRun}
                        onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, dryRun: checked })}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="fee-budget">24-hour fee budget (USD, optional)</Label>
                      <Input id="fee-budget" type="number" min="0.01" step="0.01" placeholder="No limit" value={settingsForm.dailyFeeBudgetUsd ?? ''}
                        onChange={e => setSettingsForm({ ...settingsForm, dailyFeeBudgetUsd: e.target.value === '' ? null : Number(e.target.value) })} />
                      <p className="text-xs text-muted-foreground">Reserves estimated USD fees before each chunk across all exchanges, over a rolling 24 hours. Holds keep their fee reservation. Actual exchange fees may differ. Blank disables the limit.</p>
                      <p className="text-xs text-muted-foreground">Missing prices or older withdrawals with unrecorded fees pause new submissions until the budget can be checked.</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-xs">Max Inflight Withdrawals</Label>
                        <Input
                          type="number"
                          min="1"
                          max="10"
                          value={settingsForm.maxInflightWithdrawals}
                          onChange={(e) => setSettingsForm({
                            ...settingsForm,
                            maxInflightWithdrawals: parseInt(e.target.value) || 1
                          })}
                        />
                        <p className="text-xs text-muted-foreground">Total active withdrawals across all assets</p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Per-Asset Max Inflight</Label>
                        <Input
                          type="number"
                          min="1"
                          max="5"
                          value={settingsForm.perAssetMaxInflight}
                          onChange={(e) => setSettingsForm({
                            ...settingsForm,
                            perAssetMaxInflight: parseInt(e.target.value) || 1
                          })}
                        />
                        <p className="text-xs text-muted-foreground">Max active withdrawals per asset</p>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">Key Name Prefix</Label>
                      <Input
                        value={settingsForm.keyNamePrefix}
                        onChange={(e) => setSettingsForm({ ...settingsForm, keyNamePrefix: e.target.value })}
                        placeholder="Filter addresses by prefix (optional)"
                      />
                      <p className="text-xs text-muted-foreground">Only use addresses starting with this prefix</p>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">Allowed Order Types</Label>
                      <div className="flex flex-wrap gap-2">
                        {['limit', 'market', 'stop-loss', 'stop-loss-limit', 'take-profit', 'take-profit-limit', 'trailing-stop', 'trailing-stop-limit'].map((orderType) => (
                          <Button
                            key={orderType}
                            type="button"
                            variant={settingsForm.allowedOrderTypes.includes(orderType) ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              const current = settingsForm.allowedOrderTypes;
                              const newTypes = current.includes(orderType)
                                ? current.filter(t => t !== orderType)
                                : [...current, orderType];
                              setSettingsForm({ ...settingsForm, allowedOrderTypes: newTypes });
                            }}
                          >
                            {orderType}
                          </Button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">Order types that trigger sweep accumulation</p>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <Button variant="ghost" onClick={cancelEditingSettings} disabled={savingSettings}>
                        Cancel
                      </Button>
                      <Button onClick={saveSettings} disabled={savingSettings}>
                        {savingSettings ? 'Saving...' : 'Save Settings'}
                      </Button>
                    </div>
                  </div>
                ) : settings ? (
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Dry Run:</span>
                      <Badge variant={settings.dryRun ? "outline" : "secondary"} className={settings.dryRun ? "text-yellow-500 border-yellow-500" : ""}>
                        {settings.dryRun ? 'ON' : 'OFF'}
                      </Badge>
                    </div>
                    <div><span className="text-muted-foreground">Fee budget / 24h:</span><span className="ml-2">{settings.dailyFeeBudgetUsd == null ? 'No limit' : `$${settings.dailyFeeBudgetUsd}`}</span></div>
                    <div>
                      <span className="text-muted-foreground">Max Inflight:</span>
                      <span className="ml-2">{settings.maxInflightWithdrawals}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Per-Asset Max:</span>
                      <span className="ml-2">{settings.perAssetMaxInflight}</span>
                    </div>
                    {settings.keyNamePrefix && (
                      <div>
                        <span className="text-muted-foreground">Key Prefix:</span>
                        <span className="ml-2 font-mono">{settings.keyNamePrefix}</span>
                      </div>
                    )}
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Order Types:</span>
                      <span className="ml-2">{settings.allowedOrderTypes.join(', ')}</span>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">Loading settings...</div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="exchanges" className="space-y-6">
          {/* Withdrawal Addresses Per Exchange */}
          {exchangesWithKeys.length === 0 ? (
            <Card>
              <CardHeader className="py-4 border-b">
                <CardTitle>Withdrawal Addresses</CardTitle>
              </CardHeader>
              <CardContent className="p-4 text-muted-foreground text-center">
                Configure API keys first to sync withdrawal addresses.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                 <h3 className="text-lg font-medium px-1">Exchange Wallets</h3>
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {exchangesWithKeys.map((exchange) => (
                  <ExchangeWalletManager
                    key={exchange.id}
                    exchange={exchange}
                    addresses={addressesByExchange[exchange.id] || {}}
                    activeAssets={activeAssets[exchange.id] || new Set()}
                    configuredAssets={configsByExchange[exchange.id] || {}}
                    onSync={() => syncAddresses(exchange.id, exchange.name)}
                    isSyncing={syncingExchange === exchange.id}
                    loadingAddresses={loadingAddresses}
                    onAddAsset={(asset) => setAddAssetFor({ exchange: exchange.id, asset })}
                    onEditAsset={(asset, config) => setAddAssetFor({ exchange: exchange.id, asset, editingConfig: config })}
                    onDeleteConfig={(asset) => deleteAssetConfig(exchange.id, asset)}
                    supportsSync={exchangeSyncSupport[exchange.id]?.supportsSync ?? true}
                    requiresManualEntry={exchangeSyncSupport[exchange.id]?.requiresManualEntry ?? false}
                    onAddManualAddress={() => setAddManualAddressFor(exchange.id)}
                    onDeleteAddress={(asset, key) => deleteManualAddress(exchange.id, asset, key)}
                    isEnabled={exchange.enabled !== false}
                    onToggleEnabled={(enabled) => toggleExchangeEnabled(exchange.id, enabled)}
                  />
                ))}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Add/Edit Asset Modal */}
      <AddAssetDialog
        open={addAssetFor !== null}
        onOpenChange={(open) => !open && setAddAssetFor(null)}
        exchange={addAssetFor?.exchange}
        initialAsset={addAssetFor?.asset}
        editingConfig={addAssetFor?.editingConfig}
        existingAssets={Object.keys(configsByExchange[addAssetFor?.exchange || ''] || {})}
        addressesByAsset={addAssetFor ? (addressesByExchange[addAssetFor.exchange] || {}) : {}}
        withdrawalMethods={addAssetFor ? withdrawalMethods.filter(m => m.exchange === addAssetFor.exchange) : []}
        onSave={async (asset, configData) => {
          if (!addAssetFor) return;
          const success = await saveAssetConfig(addAssetFor.exchange, asset, configData);
          if (success) setAddAssetFor(null);
        }}
        saving={saving}
      />

      {/* Manual Address Modal */}
      <ManualAddressDialog
        open={addManualAddressFor !== null}
        onOpenChange={(open) => !open && setAddManualAddressFor(null)}
        exchange={addManualAddressFor || ''}
        exchangeName={exchanges.find(e => e.id === addManualAddressFor)?.name || ''}
        withdrawalMethods={addManualAddressFor ? withdrawalMethods.filter(m => m.exchange === addManualAddressFor) : []}
        onAdd={async (data) => {
          if (!addManualAddressFor) return;
          const success = await addManualAddress(addManualAddressFor, data);
          if (success) setAddManualAddressFor(null);
        }}
        saving={saving}
      />
    </div>
  );
}

interface AddAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exchange?: string;
  initialAsset?: string;
  editingConfig?: AssetConfig;
  existingAssets: string[];
  addressesByAsset: Record<string, { method: string; entries: Array<{ key: string; address: string; method?: string }> }>;
  withdrawalMethods: WithdrawalMethod[];
  onSave: (asset: string, config: {
    threshold: number;
    reserve: number;
    destKeys: string[];
    priority?: number;
    cooldownSeconds?: number;
    chunkAmount?: number;
    perWalletCapCoin?: number | null;
    perWalletCapUsd?: number | null;
    chunkMode?: 'fixedCoin' | 'fixedUsd';
  }) => void;
  saving: boolean;
}

function AddAssetDialog({ open, onOpenChange, exchange, initialAsset, editingConfig, existingAssets, addressesByAsset, withdrawalMethods, onSave, saving }: AddAssetDialogProps) {
  const isEditing = !!editingConfig;
  // When editing, include the current asset; otherwise filter out existing
  const availableAssets = Object.keys(addressesByAsset).filter(
    (a) => {
      const hasEntries = !!addressesByAsset[a]?.entries && addressesByAsset[a].entries.length > 0;
      return (isEditing && a === initialAsset) || (!existingAssets.includes(a) && hasEntries);
    }
  );
  const defaultAsset = initialAsset && availableAssets.includes(initialAsset) ? initialAsset : availableAssets[0] || '';
  const [selectedAsset, setSelectedAsset] = useState(defaultAsset);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(0.001);
  const [reserve, setReserve] = useState(0);
  const [priority, setPriority] = useState(10);
  const [cooldownSeconds, setCooldownSeconds] = useState(60);
  const [chunkAmount, setChunkAmount] = useState(0.01);
  const [chunkMode, setChunkMode] = useState<'fixedCoin' | 'fixedUsd'>('fixedCoin');
  const [capCoin, setCapCoin] = useState('');
  const [capUsd, setCapUsd] = useState('');
  const [userEditedValues, setUserEditedValues] = useState(false);
  const [previewAmount, setPreviewAmount] = useState('');

  // Get withdrawal method info for the selected asset (minimum, fee)
  const assetInfo = selectedAsset ? addressesByAsset[selectedAsset] : null;
  const selectedMethods = [...new Set((assetInfo?.entries || []).filter(e => selectedKeys.includes(e.key)).map(e => e.method || assetInfo!.method))];
  const previewMethod = selectedMethods.length === 1 ? selectedMethods[0] : null;
  const methodInfo = selectedAsset && previewMethod ? withdrawalMethods.find(m => m.exchange === exchange && m.asset === selectedAsset && m.method.toLowerCase() === previewMethod.toLowerCase()) : undefined;
  const minimum = methodInfo?.minimum ?? 0;
  const isUsdChunk = chunkMode === 'fixedUsd';

  useEffect(() => {
    if (open) {
      const newDefault = initialAsset && availableAssets.includes(initialAsset) ? initialAsset : availableAssets[0] || '';
      setSelectedAsset(newDefault);

      // Reset user-edited flag when dialog opens
      setUserEditedValues(false);
      setPreviewAmount('');

      setCapCoin(editingConfig?.perWalletCapCoin?.toString() ?? '');
      setCapUsd(editingConfig?.perWalletCapUsd?.toString() ?? '');
      if (editingConfig) {
        // Pre-fill with existing config values
        setSelectedKeys(editingConfig.destKeys);
        setThreshold(editingConfig.threshold);
        setReserve(editingConfig.reserve);
        setPriority(editingConfig.priority ?? 10);
        setCooldownSeconds(editingConfig.cooldownSeconds ?? 60);
        setChunkAmount(editingConfig.chunkAmount ?? editingConfig.threshold);
        setChunkMode(editingConfig.chunkMode ?? 'fixedCoin');
        // Mark as edited so useEffect doesn't overwrite
        setUserEditedValues(true);
      } else {
        setReserve(0);
        setPriority(10);
        setCooldownSeconds(60);
        setChunkAmount(0.01);
        setChunkMode('fixedCoin');
        // Threshold will be set by the next useEffect when selectedAsset changes
      }
    }
  }, [open, initialAsset, editingConfig]);

  // When asset changes, set threshold to minimum (skip if editing or user has made changes)
  useEffect(() => {
    if (selectedAsset && addressesByAsset[selectedAsset]) {
      // When editing, don't override if it's the same asset
      if (editingConfig && selectedAsset === initialAsset) {
        return;
      }
      // Don't override if user has manually edited values
      if (userEditedValues) {
        return;
      }
      setSelectedKeys(addressesByAsset[selectedAsset]?.entries?.map((e) => e.key) || []);
      // Set threshold to minimum withdrawal amount
      const info = addressesByAsset[selectedAsset];
      const networks = new Set(info.entries.map(e => e.method || info.method));
      const method = networks.size === 1 ? withdrawalMethods.find(m => m.exchange === exchange && m.asset === selectedAsset && m.method.toLowerCase() === info.method.toLowerCase()) : undefined;
      if (method?.minimum) {
        setThreshold(method.minimum);
        setChunkAmount(method.minimum); // Also set chunk size to minimum
      } else {
        setThreshold(0.001);
        setChunkAmount(0.01);
      }
    }
  }, [selectedAsset, addressesByAsset, withdrawalMethods, editingConfig, initialAsset, userEditedValues]);

  function toggleKey(key: string) {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function handleSave() {
    if (!selectedAsset || selectedKeys.length === 0) return;
    onSave(selectedAsset, {
      threshold,
      reserve,
      destKeys: selectedKeys,
      priority,
      cooldownSeconds,
      chunkAmount,
      chunkMode,
      perWalletCapCoin: capCoin ? Number(capCoin) : null,
      perWalletCapUsd: capUsd ? Number(capUsd) : null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit' : 'Add'} Asset to Sweep{exchange ? ` - ${exchange.charAt(0).toUpperCase() + exchange.slice(1)}` : ''}</DialogTitle>
          <DialogDescription>Configure a new asset for automatic withdrawals{exchange ? ` on ${exchange}` : ''}.</DialogDescription>
        </DialogHeader>

        {availableAssets.length === 0 ? (
          <div className="py-4">
            <p className="text-muted-foreground">
              All assets with withdrawal addresses are already configured, or you need to sync
              withdrawal addresses first.
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Asset</Label>
                  <div className="flex flex-wrap gap-2">
                    {availableAssets.map((asset) => (
                      <Button
                        key={asset}
                        variant={selectedAsset === asset ? "default" : "outline"}
                        size="sm"
                        onClick={() => setSelectedAsset(asset)}
                      >
                        {asset}
                      </Button>
                    ))}
                  </div>
                </div>

                {assetInfo && (
                  <>
                    <div className="space-y-1">
                      <Label>Withdrawal Method</Label>
                      <div className="px-3 py-2 bg-muted rounded text-sm text-muted-foreground">
                        {assetInfo.method}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Select Wallet Keys ({selectedKeys.length} selected)</Label>
                      <div className="flex flex-wrap gap-2">
                        {(assetInfo.entries || []).map((entry) => (
                          <Button
                            key={entry.key}
                            variant={selectedKeys.includes(entry.key) ? "default" : "outline"}
                            size="sm"
                            onClick={() => toggleKey(entry.key)}
                            className="font-mono"
                            title={entry.address}
                          >
                            {entry.key} · {entry.method || assetInfo.method}
                          </Button>
                        ))}
                      </div>
                      {selectedKeys.length === 0 && (
                        <p className="text-sm text-destructive">Select at least one wallet key</p>
                      )}
                    </div>
                  </>
                )}
              </div>

              {assetInfo && (
                <div className="space-y-4 md:border-l md:pl-6">
                  {selectedMethods.length > 1 && <p className="text-sm text-amber-500">Selected wallets use different networks. Fees and minimums vary; each is checked separately before submission.</p>}
                  {!methodInfo && selectedMethods.length === 1 && <p className="text-sm text-muted-foreground">No cached fee or minimum for {previewMethod}. Moby will request a current quote before submitting.</p>}
                  {/* Show minimum withdrawal info if available */}
                  {methodInfo && (
                    <div className="text-xs bg-muted/50 rounded px-3 py-2 space-y-1">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Min withdrawal:</span>
                        <span className="font-mono">{methodInfo.minimum} {selectedAsset}</span>
                      </div>
                      {methodInfo.fee !== null && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Est. fee:</span>
                          <span className="font-mono">{methodInfo.fee} {selectedAsset}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Sweep Threshold ({selectedAsset})</Label>
                      <Input
                        type="number"
                        step="any"
                        min={minimum}
                        value={threshold || ''}
                        onChange={(e) => {
                          setThreshold(parseFloat(e.target.value) || 0);
                          setUserEditedValues(true);
                        }}
                        placeholder="Min amount to trigger sweep"
                        className={threshold > 0 && threshold < minimum ? 'border-yellow-500' : ''}
                      />
                      {threshold > 0 && threshold < minimum ? (
                        <p className="text-xs text-yellow-500">
                          Warning: Below exchange minimum ({minimum} {selectedAsset})
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {minimum > 0 ? `Exchange minimum: ${minimum} ${selectedAsset}` : 'Minimum balance to trigger withdrawal'}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Reserve ({selectedAsset})</Label>
                      <Input
                        type="number"
                        step="any"
                        value={reserve || ''}
                        onChange={(e) => setReserve(parseFloat(e.target.value) || 0)}
                        placeholder="Amount to keep on exchange"
                      />
                      <p className="text-xs text-muted-foreground">Amount to leave on exchange</p>
                    </div>
                  </div>

                  {/* Scheduling Settings */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Priority</Label>
                      <Input
                        type="number"
                        min="1"
                        value={priority}
                        onChange={(e) => setPriority(parseInt(e.target.value) || 10)}
                      />
                      <p className="text-xs text-muted-foreground">Lower = higher priority (1=highest)</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Cooldown (seconds)</Label>
                      <Input
                        type="number"
                        min="0"
                        value={cooldownSeconds}
                        onChange={(e) => setCooldownSeconds(parseInt(e.target.value) || 60)}
                      />
                      <p className="text-xs text-muted-foreground">Wait time between withdrawals</p>
                    </div>
                  </div>

                  {/* Chunk Size */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Chunking Mode</Label>
                      <Select
                        value={chunkMode}
                        onValueChange={(value) => {
                          const mode = value as 'fixedCoin' | 'fixedUsd';
                          setChunkMode(mode);
                          if (mode === 'fixedUsd' && chunkAmount < 1) {
                            setChunkAmount(100);
                          }
                          setUserEditedValues(true);
                        }}
                      >
                        <SelectTrigger className="h-8 w-36 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fixedCoin">By coin amount</SelectItem>
                          <SelectItem value="fixedUsd">By USD value</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Label className="text-xs">
                      {isUsdChunk ? 'Chunk Size (USD)' : `Chunk Size (${selectedAsset})`}
                    </Label>
                    <Input
                      type="number"
                      step="any"
                      min={isUsdChunk ? 0 : minimum}
                      value={chunkAmount || ''}
                      onChange={(e) => {
                        setChunkAmount(parseFloat(e.target.value) || 0);
                        setUserEditedValues(true);
                      }}
                      className={!isUsdChunk && chunkAmount > 0 && chunkAmount < minimum ? 'border-yellow-500' : ''}
                    />
                    {!isUsdChunk && minimum > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {[1, 2, 5, 10].map((mult) => (
                          <Button
                            key={mult}
                            type="button"
                            variant={chunkAmount === minimum * mult ? "default" : "outline"}
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => {
                              setChunkAmount(minimum * mult);
                              setUserEditedValues(true);
                            }}
                          >
                            {mult}x
                          </Button>
                        ))}
                      </div>
                    )}
                    {!isUsdChunk && chunkAmount > 0 && chunkAmount < minimum ? (
                      <p className="text-xs text-yellow-500">
                        Warning: Below exchange minimum ({minimum} {selectedAsset})
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {isUsdChunk ? 'Target USD value per withdrawal' : 'Amount per withdrawal'}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mt-3">
          <div><Label htmlFor="wallet-cap-coin">Per-wallet lifetime cap (coin, optional)</Label>
            <Input id="wallet-cap-coin" type="number" min="0" step="any" value={capCoin} onChange={e => setCapCoin(e.target.value)} /></div>
          <div><Label htmlFor="wallet-cap-usd">Per-wallet lifetime cap (USD, optional)</Label>
            <Input id="wallet-cap-usd" type="number" min="0" step="any" value={capUsd} onChange={e => setCapUsd(e.target.value)} /></div>
        </div>
        {!isUsdChunk && methodInfo?.fee != null && chunkAmount > 0 && <div className="border-t pt-3 space-y-2">
          <Label htmlFor="preview-total">Preview a total amount ({selectedAsset})</Label>
          <Input id="preview-total" type="number" min="0" step="any" placeholder="Optional estimate" value={previewAmount} onChange={e => setPreviewAmount(e.target.value)} />
          {Number(previewAmount) > reserve && <p className="text-sm text-muted-foreground">
            Up to {Math.ceil((Number(previewAmount) - reserve) / chunkAmount)} chunks · approximately {Number((Math.ceil((Number(previewAmount) - reserve) / chunkAmount) * methodInfo.fee).toFixed(8))} {selectedAsset} in fees at the cached rate.
            A remainder below the network minimum waits for more funds. Prices, fees, wallet caps, and available slots can change the result.
          </p>}
        </div>}
        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {availableAssets.length > 0 && (
            <Button onClick={handleSave} disabled={saving || !selectedAsset || selectedKeys.length === 0}>
              {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Asset'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ManualAddressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exchange: string;
  exchangeName: string;
  withdrawalMethods: WithdrawalMethod[];
  onAdd: (data: {
    asset: string;
    address: string;
    addressConfirm: string;
    method: string;
    key: string;
    memo?: string;
  }) => void;
  saving: boolean;
}

function ManualAddressDialog({ open, onOpenChange, exchange, exchangeName, withdrawalMethods, onAdd, saving }: ManualAddressDialogProps) {
  const [tradeableCoins, setTradeableCoins] = useState<string[]>([]);
  const [loadingCoins, setLoadingCoins] = useState(false);
  const [asset, setAsset] = useState('');
  const [address, setAddress] = useState('');
  const [addressConfirm, setAddressConfirm] = useState('');
  const [method, setMethod] = useState('');
  const [key, setKey] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState('');

  // Get available methods for selected asset
  const availableMethods = asset
    ? withdrawalMethods.filter(m => m.asset === asset)
    : [];

  useEffect(() => {
    if (open && exchange) {
      fetchTradeableCoins();
      // Reset form
      setAsset('');
      setAddress('');
      setAddressConfirm('');
      setMethod('');
      setKey('');
      setMemo('');
      setError('');
    }
  }, [open, exchange]);

  // Reset method when asset changes
  useEffect(() => {
    setMethod('');
  }, [asset]);

  async function fetchTradeableCoins() {
    setLoadingCoins(true);
    try {
      const res = await apiFetch(`/api/exchanges/${exchange}/tradeable-coins`);
      if (res.ok) {
        const data = await res.json();
        setTradeableCoins(data.coins || []);
      }
    } catch (err) {
      console.error('Failed to fetch tradeable coins:', err);
    } finally {
      setLoadingCoins(false);
    }
  }

  function handleSubmit() {
    setError('');

    if (!asset) {
      setError('Please select a coin');
      return;
    }
    if (!address) {
      setError('Please enter the withdrawal address');
      return;
    }
    if (!addressConfirm) {
      setError('Please confirm the withdrawal address');
      return;
    }
    if (address !== addressConfirm) {
      setError('Addresses do not match. Please verify and re-enter.');
      return;
    }
    if (!method) {
      setError('Please enter the network/chain');
      return;
    }
    if (!key) {
      setError('Please enter a name for this address');
      return;
    }

    onAdd({
      asset,
      address,
      addressConfirm,
      method,
      key,
      memo: memo || undefined,
    });
  }

  const addressesMatch = address && addressConfirm && address === addressConfirm;
  const addressesDontMatch = address && addressConfirm && address !== addressConfirm;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Manual Address - {exchangeName}</DialogTitle>
          <DialogDescription>
            Add a withdrawal address manually. You can only add addresses for coins you are actively trading on {exchangeName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Coin *</Label>
            {loadingCoins ? (
              <div className="text-sm text-muted-foreground">Loading tradeable coins...</div>
            ) : tradeableCoins.length === 0 ? (
              <Alert>
                <AlertDescription>
                  No open orders found. You must have active limit orders on {exchangeName} to add withdrawal addresses.
                </AlertDescription>
              </Alert>
            ) : (
              <Select value={asset} onValueChange={setAsset}>
                <SelectTrigger>
                  <SelectValue placeholder="Select coin" />
                </SelectTrigger>
                <SelectContent>
                  {tradeableCoins.map((coin) => (
                    <SelectItem key={coin} value={coin}>
                      {coin}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label>Network / Chain *</Label>
            {!asset ? (
              <p className="text-sm text-muted-foreground">Select a coin first</p>
            ) : availableMethods.length === 0 ? (
              <Alert>
                <AlertDescription>
                  No withdrawal methods found for {asset}. Click "Fetch Minimums" to load available networks.
                </AlertDescription>
              </Alert>
            ) : (
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue placeholder="Select network" />
                </SelectTrigger>
                <SelectContent>
                  {availableMethods.map((m) => (
                    <SelectItem key={m.method} value={m.method}>
                      {m.method} {m.minimum ? `(min: ${m.minimum} ${asset})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              The blockchain network for this address (must match your wallet)
            </p>
          </div>

          <div className="space-y-2">
            <Label>Address Name / Label *</Label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g., My Cold Wallet"
            />
            <p className="text-xs text-muted-foreground">
              A friendly name to identify this address
            </p>
          </div>

          <div className="space-y-2">
            <Label>Withdrawal Address *</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter the full withdrawal address"
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label>Confirm Address *</Label>
            <Input
              value={addressConfirm}
              onChange={(e) => setAddressConfirm(e.target.value)}
              placeholder="Re-enter the withdrawal address"
              className={`font-mono text-sm ${addressesDontMatch ? 'border-destructive' : ''} ${addressesMatch ? 'border-green-500' : ''}`}
            />
            {addressesDontMatch && (
              <p className="text-xs text-destructive">Addresses do not match</p>
            )}
            {addressesMatch && (
              <p className="text-xs text-green-500">Addresses match ✓</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Memo / Tag (optional)</Label>
            <Input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Required for some coins like XRP, XLM"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || !asset || !address || !addressConfirm || !method || !key || tradeableCoins.length === 0}
          >
            {saving ? 'Adding...' : 'Add Address'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ExchangeWalletManagerProps {
  exchange: AvailableExchange;
  addresses: Record<string, { method: string; entries: { key: string; address: string }[] }>;
  activeAssets: Set<string>;
  configuredAssets: Record<string, AssetConfig>;
  onSync: () => void;
  isSyncing: boolean;
  loadingAddresses: boolean;
  onAddAsset: (asset: string) => void;
  onEditAsset: (asset: string, config: AssetConfig) => void;
  onDeleteConfig: (asset: string) => void;
  supportsSync: boolean;
  requiresManualEntry: boolean;
  onAddManualAddress: () => void;
  onDeleteAddress: (asset: string, key: string) => void;
  isEnabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
}

function ExchangeWalletManager({
  exchange,
  addresses,
  activeAssets,
  configuredAssets,
  onSync,
  isSyncing,
  loadingAddresses,
  onAddAsset,
  onEditAsset,
  onDeleteConfig,
  supportsSync,
  requiresManualEntry,
  onAddManualAddress,
  onDeleteAddress,
  isEnabled,
  onToggleEnabled,
}: ExchangeWalletManagerProps) {
  const [open, setOpen] = useState(false);
  const assetCount = Object.keys(addresses).length;
  const configuredCount = Object.keys(configuredAssets).length;
  const activeCount = activeAssets.size;

  // Combine assets from addresses and activeAssets
  const allAssets = Array.from(new Set([...Object.keys(addresses), ...Array.from(activeAssets)]));
  
  // Sort assets: configured first, then active with no config, then others
  allAssets.sort((a, b) => {
    const aConfig = !!configuredAssets[a];
    const bConfig = !!configuredAssets[b];
    const aActive = activeAssets.has(a);
    const bActive = activeAssets.has(b);
    
    if (aConfig && !bConfig) return -1;
    if (!aConfig && bConfig) return 1;
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a.localeCompare(b);
  });

  return (
    <>
      <Card className={!isEnabled ? "opacity-75" : ""}>
        <CardHeader className="py-4 border-b flex flex-row items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
               <CardTitle>{exchange.name}</CardTitle>
               <Switch 
                 checked={isEnabled} 
                 onCheckedChange={onToggleEnabled}
                 className="scale-75" 
               />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Badge variant="secondary">{assetCount} assets</Badge>
              {configuredCount > 0 && (
                <Badge variant="outline" className="text-green-500 border-green-500">
                  {configuredCount} configured
                </Badge>
              )}
              {activeCount > 0 && (
                <Badge variant="outline" className="text-blue-500 border-blue-500 gap-1">
                  <Activity size={10} />
                  {activeCount} active
                </Badge>
              )}
              {requiresManualEntry && (
                <Badge variant="outline" className="text-yellow-500 border-yellow-500">
                  Manual
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-6 flex flex-col gap-2">
          <Button onClick={() => setOpen(true)} variant="default" className="w-full" disabled={!isEnabled}>
            Manage Wallets
          </Button>
          {supportsSync && (
            <Button
              onClick={onSync}
              disabled={isSyncing || !isEnabled}
              variant="outline"
              size="sm"
              className="w-full"
            >
              {isSyncing ? 'Syncing...' : requiresManualEntry ? 'Fetch Minimums' : 'Sync Addresses'}
            </Button>
          )}
          {requiresManualEntry && (
            <Button
              onClick={onAddManualAddress}
              variant="outline"
              size="sm"
              className="w-full"
              disabled={!isEnabled}
            >
              <Plus size={14} className="mr-1" />
              Add Address
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{exchange.name} Wallets</DialogTitle>
            <DialogDescription>
              View and configure withdrawal addresses for {exchange.name}.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto pr-2">
            {loadingAddresses ? (
              <div className="p-8 text-center text-muted-foreground">
                Loading addresses...
              </div>
            ) : allAssets.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {requiresManualEntry
                  ? 'No withdrawal addresses added. Add addresses manually for coins you are trading.'
                  : 'No withdrawal addresses found. Sync from exchange to fetch them.'}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {allAssets.map((asset) => {
                  const data = addresses[asset];
                  const method = data?.method;
                  const entries = data?.entries || [];
                  const keys = entries.map((e) => e.key);
                  const config = configuredAssets[asset];
                  const isConfigured = !!config;
                  const isActive = activeAssets.has(asset);
                  const isMissingAddress = keys.length === 0;

                  return (
                    <div
                      key={asset}
                      className={`relative rounded-lg border p-3 transition-colors ${
                        isConfigured
                          ? 'bg-green-500/5 border-green-500/30'
                          : isActive
                            ? 'bg-blue-500/5 border-blue-500/30'
                            : 'bg-card hover:bg-accent/50'
                      }`}
                    >
                      {isConfigured && (
                        <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" title="Configured" />
                      )}
                      
                      {!isConfigured && isActive && (
                        <div className="absolute top-3 right-3 flex items-center gap-1">
                          <Activity size={12} className="text-blue-500 animate-pulse" />
                        </div>
                      )}

                      <div className="flex items-center justify-between mb-2 pr-6">
                        <span className="font-semibold text-lg flex items-center gap-2">
                          {asset}
                          {isActive && (
                            <Badge variant="outline" className="text-[10px] px-1 h-4 text-blue-500 border-blue-500">
                              Active
                            </Badge>
                          )}
                        </span>
                        {method && <Badge variant="outline" className="text-[10px] uppercase">{method}</Badge>}
                      </div>

                      <div className="flex flex-wrap gap-1 mb-3">
                        {isMissingAddress ? (
                          <div className="flex items-center gap-1 text-xs text-yellow-500">
                            <AlertCircle size={12} />
                            No withdrawal address
                          </div>
                        ) : (
                          <>
                            {entries.slice(0, requiresManualEntry ? entries.length : 3).map((entry) => (
                              <span
                                key={entry.key}
                                className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-muted text-muted-foreground truncate max-w-[180px] flex items-center gap-1"
                              >
                                <span className="truncate max-w-[90px]" title={entry.key}>{entry.key}</span>
                                <span className="text-[8px] text-muted-foreground truncate max-w-[140px]" title={entry.address}>{entry.address}</span>
                                {requiresManualEntry && (
                                  <button
                                    onClick={() => onDeleteAddress(asset, entry.key)}
                                    className="text-destructive hover:text-destructive/80 ml-1"
                                    title="Delete address"
                                  >
                                    ×
                                  </button>
                                )}
                              </span>
                            ))}
                            {!requiresManualEntry && keys.length > 3 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-muted text-muted-foreground">
                                +{keys.length - 3}
                              </span>
                            )}
                          </>
                        )}
                      </div>

                      {isConfigured && config && (
                        <div className="text-xs text-muted-foreground mb-2 space-y-1">
                          <div>Threshold: <span className="text-foreground">{config.threshold} {asset}</span></div>
                          {config.reserve > 0 && <div>Reserve: <span className="text-foreground">{config.reserve} {asset}</span></div>}
                          <div>Wallets: <span className="text-foreground">{config.destKeys.length}</span></div>
                        </div>
                      )}

                      <div className="flex justify-end gap-2">
                         {isConfigured && config ? (
                           <>
                             <Button
                               variant="ghost"
                               size="sm"
                               className="h-7 text-xs text-destructive hover:text-destructive"
                               onClick={() => onDeleteConfig(asset)}
                             >
                               <Trash2 size={14} />
                             </Button>
                             <Button
                               variant="outline"
                               size="sm"
                               className="h-7 text-xs"
                               onClick={() => {
                                 setOpen(false);
                                 onEditAsset(asset, config);
                               }}
                             >
                               <Pencil size={14} className="mr-1" />
                               Edit
                             </Button>
                           </>
                         ) : (
                           <Button
                             variant={isActive && isMissingAddress ? "default" : "secondary"}
                             size="sm"
                             className={`h-7 text-xs ${isActive && isMissingAddress ? "bg-yellow-500 hover:bg-yellow-600 text-white" : ""}`}
                             onClick={() => {
                               if (isMissingAddress) {
                                 setOpen(false);
                                 if (requiresManualEntry) {
                                   onAddManualAddress();
                                 } else {
                                   onSync();
                                 }
                               } else {
                                 setOpen(false);
                                 onAddAsset(asset);
                               }
                             }}
                           >
                             {isMissingAddress ? (requiresManualEntry ? "Add Addr" : "Sync Addr") : "Configure"}
                           </Button>
                         )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="mt-4">
             <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

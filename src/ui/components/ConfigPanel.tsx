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
import { Trash2, Plus } from 'lucide-react';

// New simplified asset config (stored in database)
interface AssetConfig {
  exchange: string;
  asset: string;
  enabled: boolean;
  threshold: number;
  reserve: number;
  destKeys: string[];
}

interface GlobalConfig {
  enabledOnBoot: boolean;
  dryRun: boolean;
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

export function ConfigPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [assetConfigs, setAssetConfigs] = useState<AssetConfig[]>([]);
  const [addresses, setAddresses] = useState<ExchangeAddress[]>([]);
  const [exchanges, setExchanges] = useState<AvailableExchange[]>([]);
  const [exchangeSyncSupport, setExchangeSyncSupport] = useState<Record<string, ExchangeSyncSupport>>({});
  const [loading, setLoading] = useState(true);
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [addAssetFor, setAddAssetFor] = useState<{ exchange: string; asset: string } | null>(null);
  const [addManualAddressFor, setAddManualAddressFor] = useState<string | null>(null);
  const [sweeperStatus, setSweeperStatus] = useState<SweeperStatus | null>(null);
  const [toggling, setToggling] = useState(false);
  const [syncingExchange, setSyncingExchange] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig();
    fetchAssetConfigs();
    fetchSweeperStatus();
    fetchExchanges().then(() => fetchExchangeSyncSupport());
    fetchAddresses();
  }, []);

  async function fetchExchangeSyncSupport() {
    const supportMap: Record<string, ExchangeSyncSupport> = {};
    const exchangeIds = ['kraken', 'gemini', 'kucoin', 'gateio'];

    for (const exchangeId of exchangeIds) {
      try {
        const res = await fetch(`/api/exchanges/${exchangeId}/supports-sync`);
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
      const res = await fetch('/api/config');
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
      const res = await fetch('/api/config/assets');
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
      const res = await fetch('/api/status');
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
        fetch('/api/exchanges/available'),
        fetch('/api/keys')
      ]);

      if (exchangesRes.ok && keysRes.ok) {
        const exchangesData = await exchangesRes.json();
        const keysData = await keysRes.json();

        const exchangesWithKeys = new Set(keysData.keys.map((k: { exchange: string }) => k.exchange));

        const mapped = exchangesData.exchanges.map((ex: { id: string; name: string }) => ({
          id: ex.id,
          name: ex.name,
          hasKeys: exchangesWithKeys.has(ex.id)
        }));

        setExchanges(mapped);
      }
    } catch (err) {
      console.error('Failed to fetch exchanges:', err);
    }
  }

  async function toggleSweeper() {
    if (!sweeperStatus) return;
    setToggling(true);
    try {
      const endpoint = sweeperStatus.enabled ? '/api/control/stop' : '/api/control/start';
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSweeperStatus({ ...sweeperStatus, enabled: data.enabled });
      }
    } catch (err) {
      setError('Failed to toggle sweeper');
    } finally {
      setToggling(false);
    }
  }

  async function fetchAddresses() {
    setLoadingAddresses(true);
    try {
      const res = await fetch('/api/addresses');
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

  async function syncAddresses(exchangeId: string, exchangeName: string) {
    setSyncingExchange(exchangeId);
    try {
      const res = await fetch(`/api/exchanges/${exchangeId}/addresses/sync`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        await fetchAddresses();
        const parts: string[] = [];
        parts.push(`${data.stats.fromExchange || data.stats.fromKraken || 0} from ${exchangeName}`);
        if (data.stats.new > 0) parts.push(`${data.stats.new} new`);
        if (data.stats.restored > 0) parts.push(`${data.stats.restored} restored`);
        if (data.stats.deleted > 0) parts.push(`${data.stats.deleted} deleted`);
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
      const res = await fetch(`/api/exchanges/${exchangeId}/addresses/manual`, {
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
      const res = await fetch(`/api/exchanges/${exchangeId}/addresses/${asset}/${encodeURIComponent(key)}`, {
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
  }) {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/config/exchanges/${exchange}/assets/${asset}`, {
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
      const res = await fetch(`/api/config/exchanges/${exchange}/assets/${asset}`, {
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
      const res = await fetch(`/api/config/exchanges/${exchange}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        const data = await res.json();
        await fetchConfig();
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
    if (!acc[exchange][addr.asset]) {
      acc[exchange][addr.asset] = { method: addr.method, keys: [] };
    }
    acc[exchange][addr.asset].keys.push(addr.key);
    return acc;
  }, {} as Record<string, Record<string, { method: string; keys: string[] }>>);

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
      {/* Sweeper Control */}
      <Card>
        <CardHeader className="py-4 border-b">
          <CardTitle>Sweeper Control</CardTitle>
        </CardHeader>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                sweeperStatus?.enabled ? 'bg-green-500' : 'bg-gray-500'
              }`}
            />
            <span className="font-medium">
              {sweeperStatus?.enabled ? 'Running' : 'Stopped'}
            </span>
            {config.global.dryRun && (
              <Badge variant="outline" className="text-yellow-500 border-yellow-500">
                DRY RUN
              </Badge>
            )}
            {!sweeperStatus?.hasApiKeys && (
              <span className="text-yellow-500 text-sm">
                Configure API keys to enable
              </span>
            )}
          </div>
          <Button
            onClick={toggleSweeper}
            disabled={toggling || !sweeperStatus?.hasApiKeys}
            variant={sweeperStatus?.enabled ? 'destructive' : 'default'}
          >
            {toggling ? 'Working...' : sweeperStatus?.enabled ? 'Stop Sweeper' : 'Start Sweeper'}
          </Button>
        </CardContent>
      </Card>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {success && <Alert className="text-green-500 border-green-500"><AlertDescription>{success}</AlertDescription></Alert>}

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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {exchangesWithKeys.map((exchange) => (
            <ExchangeWalletManager
              key={exchange.id}
              exchange={exchange}
              addresses={addressesByExchange[exchange.id] || {}}
              configuredAssets={configsByExchange[exchange.id] || {}}
              onSync={() => syncAddresses(exchange.id, exchange.name)}
              isSyncing={syncingExchange === exchange.id}
              loadingAddresses={loadingAddresses}
              onAddAsset={(asset) => setAddAssetFor({ exchange: exchange.id, asset })}
              onDeleteConfig={(asset) => deleteAssetConfig(exchange.id, asset)}
              supportsSync={exchangeSyncSupport[exchange.id]?.supportsSync ?? true}
              onAddManualAddress={() => setAddManualAddressFor(exchange.id)}
              onDeleteAddress={(asset, key) => deleteManualAddress(exchange.id, asset, key)}
              isEnabled={!config.global.disabledExchanges?.includes(exchange.id)}
              onToggleEnabled={(enabled) => toggleExchangeEnabled(exchange.id, enabled)}
            />
          ))}
        </div>
      )}

      {/* Global Settings */}
      <Card>
        <CardHeader className="py-4 border-b">
          <CardTitle>Global Settings</CardTitle>
        </CardHeader>
        <CardContent className="p-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Max Inflight Withdrawals:</span>
            <span className="ml-2">{config.global.maxInflightWithdrawals}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Per-Asset Max Inflight:</span>
            <span className="ml-2">{config.global.perAssetMaxInflight}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Allowed Order Types:</span>
            <span className="ml-2">{config.global.allowedOrderTypes.join(', ')}</span>
          </div>
          {config.global.keyNamePrefix && (
            <div>
              <span className="text-muted-foreground">Key Name Prefix:</span>
              <span className="ml-2">{config.global.keyNamePrefix}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Asset Modal */}
      <AddAssetDialog
        open={addAssetFor !== null}
        onOpenChange={(open) => !open && setAddAssetFor(null)}
        exchange={addAssetFor?.exchange}
        initialAsset={addAssetFor?.asset}
        existingAssets={Object.keys(configsByExchange[addAssetFor?.exchange || ''] || {})}
        addressesByAsset={addAssetFor ? (addressesByExchange[addAssetFor.exchange] || {}) : {}}
        onAdd={async (asset, configData) => {
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
  existingAssets: string[];
  addressesByAsset: Record<string, { method: string; keys: string[] }>;
  onAdd: (asset: string, config: {
    threshold: number;
    reserve: number;
    destKeys: string[];
    priority?: number;
    cooldownSeconds?: number;
    chunkAmount?: number;
  }) => void;
  saving: boolean;
}

function AddAssetDialog({ open, onOpenChange, exchange, initialAsset, existingAssets, addressesByAsset, onAdd, saving }: AddAssetDialogProps) {
  const availableAssets = Object.keys(addressesByAsset).filter(
    (a) => !existingAssets.includes(a) && addressesByAsset[a].keys.length > 0
  );
  const defaultAsset = initialAsset && availableAssets.includes(initialAsset) ? initialAsset : availableAssets[0] || '';
  const [selectedAsset, setSelectedAsset] = useState(defaultAsset);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(0.001);
  const [reserve, setReserve] = useState(0);
  const [priority, setPriority] = useState(10);
  const [cooldownSeconds, setCooldownSeconds] = useState(60);
  const [chunkAmount, setChunkAmount] = useState(0.01);

  useEffect(() => {
    if (open) {
      const newDefault = initialAsset && availableAssets.includes(initialAsset) ? initialAsset : availableAssets[0] || '';
      setSelectedAsset(newDefault);
      setThreshold(0.001);
      setReserve(0);
      setPriority(10);
      setCooldownSeconds(60);
      setChunkAmount(0.01);
    }
  }, [open, initialAsset]);

  useEffect(() => {
    if (selectedAsset && addressesByAsset[selectedAsset]) {
      setSelectedKeys(addressesByAsset[selectedAsset].keys);
    }
  }, [selectedAsset, addressesByAsset]);

  const assetInfo = selectedAsset ? addressesByAsset[selectedAsset] : null;

  function toggleKey(key: string) {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function handleAdd() {
    if (!selectedAsset || selectedKeys.length === 0) return;
    onAdd(selectedAsset, {
      threshold,
      reserve,
      destKeys: selectedKeys,
      priority,
      cooldownSeconds,
      chunkAmount,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Asset to Sweep{exchange ? ` - ${exchange.charAt(0).toUpperCase() + exchange.slice(1)}` : ''}</DialogTitle>
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
                        {assetInfo.keys.map((key) => (
                          <Button
                            key={key}
                            variant={selectedKeys.includes(key) ? "default" : "outline"}
                            size="sm"
                            onClick={() => toggleKey(key)}
                            className="font-mono"
                          >
                            {key}
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
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Sweep Threshold ({selectedAsset})</Label>
                      <Input
                        type="number"
                        step="any"
                        value={threshold}
                        onChange={(e) => setThreshold(parseFloat(e.target.value) || 0)}
                        placeholder="Min amount to trigger sweep"
                      />
                      <p className="text-xs text-muted-foreground">Minimum balance to trigger withdrawal</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Reserve ({selectedAsset})</Label>
                      <Input
                        type="number"
                        step="any"
                        value={reserve}
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
                    <Label className="text-xs">Chunk Size ({selectedAsset})</Label>
                    <Input
                      type="number"
                      step="any"
                      value={chunkAmount}
                      onChange={(e) => setChunkAmount(parseFloat(e.target.value) || 0.01)}
                    />
                    <p className="text-xs text-muted-foreground">Amount per withdrawal</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {availableAssets.length > 0 && (
            <Button onClick={handleAdd} disabled={saving || !selectedAsset || selectedKeys.length === 0}>
              {saving ? 'Adding...' : 'Add Asset'}
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

function ManualAddressDialog({ open, onOpenChange, exchange, exchangeName, onAdd, saving }: ManualAddressDialogProps) {
  const [tradeableCoins, setTradeableCoins] = useState<string[]>([]);
  const [loadingCoins, setLoadingCoins] = useState(false);
  const [asset, setAsset] = useState('');
  const [address, setAddress] = useState('');
  const [addressConfirm, setAddressConfirm] = useState('');
  const [method, setMethod] = useState('');
  const [key, setKey] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState('');

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

  async function fetchTradeableCoins() {
    setLoadingCoins(true);
    try {
      const res = await fetch(`/api/exchanges/${exchange}/tradeable-coins`);
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
            <Input
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              placeholder="e.g., ERC20, TRC20, Native"
            />
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
  addresses: Record<string, { method: string; keys: string[] }>;
  configuredAssets: Record<string, AssetConfig>;
  onSync: () => void;
  isSyncing: boolean;
  loadingAddresses: boolean;
  onAddAsset: (asset: string) => void;
  onDeleteConfig: (asset: string) => void;
  supportsSync: boolean;
  onAddManualAddress: () => void;
  onDeleteAddress: (asset: string, key: string) => void;
  isEnabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
}

function ExchangeWalletManager({
  exchange,
  addresses,
  configuredAssets,
  onSync,
  isSyncing,
  loadingAddresses,
  onAddAsset,
  onDeleteConfig,
  supportsSync,
  onAddManualAddress,
  onDeleteAddress,
  isEnabled,
  onToggleEnabled,
}: ExchangeWalletManagerProps) {
  const [open, setOpen] = useState(false);
  const assetCount = Object.keys(addresses).length;
  const configuredCount = Object.keys(configuredAssets).length;

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
            <div className="flex gap-2">
              <Badge variant="secondary">{assetCount} assets</Badge>
              {configuredCount > 0 && (
                <Badge variant="outline" className="text-green-500 border-green-500">
                  {configuredCount} configured
                </Badge>
              )}
              {!supportsSync && (
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
          {supportsSync ? (
            <Button
              onClick={onSync}
              disabled={isSyncing || !isEnabled}
              variant="outline"
              size="sm"
              className="w-full"
            >
              {isSyncing ? 'Syncing...' : 'Sync Addresses'}
            </Button>
          ) : (
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
            ) : assetCount === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {supportsSync
                  ? 'No withdrawal addresses found. Sync from exchange to fetch them.'
                  : 'No withdrawal addresses added. Add addresses manually for coins you are trading.'}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(addresses).map(([asset, { method, keys }]) => {
                  const config = configuredAssets[asset];
                  const isConfigured = !!config;
                  return (
                    <div
                      key={asset}
                      className={`relative rounded-lg border p-3 transition-colors ${
                        isConfigured
                          ? 'bg-green-500/5 border-green-500/30'
                          : 'bg-card hover:bg-accent/50'
                      }`}
                    >
                      {isConfigured && (
                        <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                      )}

                      <div className="flex items-center justify-between mb-2 pr-4">
                        <span className="font-semibold text-lg">{asset}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">{method}</Badge>
                      </div>

                      <div className="flex flex-wrap gap-1 mb-3">
                        {keys.slice(0, supportsSync ? 3 : keys.length).map((key) => (
                          <span
                            key={key}
                            className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-muted text-muted-foreground truncate max-w-[100px] flex items-center gap-1"
                          >
                            {key}
                            {!supportsSync && (
                              <button
                                onClick={() => onDeleteAddress(asset, key)}
                                className="text-destructive hover:text-destructive/80 ml-1"
                                title="Delete address"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        {supportsSync && keys.length > 3 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-muted text-muted-foreground">
                            +{keys.length - 3}
                          </span>
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
                         {isConfigured ? (
                           <>
                             <Button
                               variant="ghost"
                               size="sm"
                               className="h-7 text-xs text-destructive hover:text-destructive"
                               onClick={() => onDeleteConfig(asset)}
                             >
                               <Trash2 size={14} />
                             </Button>
                             <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                               Configured
                             </span>
                           </>
                         ) : (
                           <Button
                             variant="secondary"
                             size="sm"
                             className="h-7 text-xs"
                             onClick={() => {
                               setOpen(false);
                               onAddAsset(asset);
                             }}
                           >
                             Configure
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

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/ui/components/ui/card";
import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import { Badge } from "@/ui/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/ui/components/ui/dialog";
import { Alert, AlertDescription } from "@/ui/components/ui/alert";
import { Activity } from 'lucide-react';

interface AssetConfig {
  priority: number;
  method: string;
  walletKeys: string[];
  sweepThresholdCoin?: number;
  sweepThresholdUsd?: number;
  reserveCoin: number;
  cooldownSeconds: number;
  chunk: {
    mode: 'fixedCoin' | 'usd';
    amount?: number;
    max?: number;
    targetUsd?: number;
    maxUsd?: number;
  };
  perWalletCapUsd?: number;
  perWalletCapCoin?: number;
}

interface GlobalConfig {
  enabledOnBoot: boolean;
  maxInflightWithdrawals: number;
  perAssetMaxInflight: number;
  schedulerTickMs: number;
  backoffSeconds: number[];
  allowedOrderTypes: string[];
  keyNamePrefix?: string;
}

interface Config {
  global: GlobalConfig;
  assets: Record<string, AssetConfig>;
}

interface KrakenAddress {
  id: number;
  address: string;
  asset: string;
  method: string;
  key: string;
  createdAt: number;
  lastSeenAt: number;
}

interface SweeperStatus {
  enabled: boolean;
  hasApiKeys: boolean;
}

export function ConfigPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [addresses, setAddresses] = useState<KrakenAddress[]>([]);
  const [addressesFetched, setAddressesFetched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingAsset, setEditingAsset] = useState<string | null>(null);
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [sweeperStatus, setSweeperStatus] = useState<SweeperStatus | null>(null);
  const [toggling, setToggling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStats, setSyncStats] = useState<{ new: number; restored: number; deleted: number; fromKraken: number } | null>(null);

  useEffect(() => {
    fetchConfig();
    fetchSweeperStatus();
    fetchAddresses(); // Load from local DB on mount (fast)
  }, []);

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
      const res = await fetch('/api/kraken/addresses');
      if (res.ok) {
        const data = await res.json();
        setAddresses(data);
        setAddressesFetched(true);
      }
    } catch (err) {
      // Ignore
    } finally {
      setLoadingAddresses(false);
    }
  }

  async function syncAddresses() {
    setSyncing(true);
    setSyncStats(null);
    try {
      const res = await fetch('/api/kraken/addresses/sync', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAddresses(data.addresses);
        setAddressesFetched(true);
        setSyncStats(data.stats);
        const parts: string[] = [];
        parts.push(`${data.stats.fromKraken} from Kraken`);
        if (data.stats.new > 0) parts.push(`${data.stats.new} new`);
        if (data.stats.restored > 0) parts.push(`${data.stats.restored} restored`);
        if (data.stats.deleted > 0) parts.push(`${data.stats.deleted} deleted`);
        setSuccess(`Sync complete: ${parts.join(', ')}`);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to sync addresses');
      }
    } catch (err) {
      setError('Failed to sync addresses from Kraken');
    } finally {
      setSyncing(false);
    }
  }

  async function saveAssetConfig(asset: string, assetConfig: AssetConfig) {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/config/assets/${asset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assetConfig),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to save');
        return false;
      }

      setSuccess(`Saved ${asset} configuration`);
      await fetchConfig();
      setEditingAsset(null);
      return true;
    } catch (err) {
      setError('Network error');
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Group addresses by asset
  const addressesByAsset = addresses.reduce((acc, addr) => {
    if (!acc[addr.asset]) {
      acc[addr.asset] = { method: addr.method, keys: [] };
    }
    acc[addr.asset].keys.push(addr.key);
    return acc;
  }, {} as Record<string, { method: string; keys: string[] }>);

  // Assets available from Kraken but not yet configured
  const unconfiguredAssets = Object.keys(addressesByAsset).filter(
    (asset) => !config?.assets[asset]
  );

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

      {/* Kraken Withdrawal Addresses */}
      <Card>
        <CardHeader className="py-4 border-b flex flex-row items-center justify-between">
          <CardTitle>Kraken Withdrawal Addresses</CardTitle>
          <Button
            onClick={syncAddresses}
            disabled={syncing || !sweeperStatus?.hasApiKeys}
            variant="outline"
            size="sm"
          >
            {syncing ? 'Syncing...' : 'Sync from Kraken'}
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          {loadingAddresses ? (
            <div className="p-4 text-muted-foreground text-center">
              Loading addresses...
            </div>
          ) : addresses.length === 0 ? (
            <div className="p-4 text-muted-foreground text-center">
              No withdrawal addresses found. Click "Sync from Kraken" to fetch addresses, or add them in Kraken first.
            </div>
          ) : (
            <div className="p-4 grid gap-3">
              {Object.entries(addressesByAsset).map(([asset, { method, keys }]) => {
                const isConfigured = !!config.assets[asset];
                return (
                  <Card
                    key={asset}
                    className={`border ${
                      isConfigured
                        ? 'bg-green-500/10 border-green-500/50'
                        : 'bg-card'
                    }`}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{asset}</span>
                          <Badge variant="outline" className="text-xs">via {method}</Badge>
                          {isConfigured && (
                            <Badge variant="outline" className="text-green-500 border-green-500">Configured</Badge>
                          )}
                        </div>
                        {!isConfigured && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAddAsset(true)}
                            className="text-primary hover:text-primary/80 h-auto p-0"
                          >
                            + Add to sweep
                          </Button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {keys.map((key) => (
                          <span
                            key={key}
                            className="text-xs px-2 py-1 rounded font-mono bg-muted text-muted-foreground"
                          >
                            {key}
                          </span>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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

      {/* Configured Assets */}
      <Card>
        <CardHeader className="py-4 border-b flex flex-row items-center justify-between">
          <CardTitle>Sweep Configuration</CardTitle>
          {unconfiguredAssets.length > 0 && (
            <Button onClick={() => setShowAddAsset(true)} size="sm">
              Add Asset ({unconfiguredAssets.length} available)
            </Button>
          )}
        </CardHeader>

        <CardContent className="p-0">
          {error && <Alert variant="destructive" className="m-4"><AlertDescription>{error}</AlertDescription></Alert>}
          {success && <Alert className="m-4 text-green-500 border-green-500"><AlertDescription>{success}</AlertDescription></Alert>}

          {Object.keys(config.assets).length === 0 ? (
            <div className="p-4 text-muted-foreground text-center">
              No assets configured for sweeping.
              {unconfiguredAssets.length > 0
                ? ` You have ${unconfiguredAssets.length} asset(s) with withdrawal addresses ready to configure.`
                : ' Add withdrawal addresses in Kraken first.'}
            </div>
          ) : (
            <div className="divide-y">
              {Object.entries(config.assets)
                .sort(([, a], [, b]) => a.priority - b.priority)
                .map(([asset, assetConfig]) => (
                  <AssetConfigRow
                    key={asset}
                    asset={asset}
                    config={assetConfig}
                    availableKeys={addressesByAsset[asset]?.keys || []}
                    isEditing={editingAsset === asset}
                    onEdit={() => setEditingAsset(asset)}
                    onCancel={() => setEditingAsset(null)}
                    onSave={(newConfig) => saveAssetConfig(asset, newConfig)}
                    saving={saving}
                  />
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Asset Modal */}
      <AddAssetDialog
        open={showAddAsset}
        onOpenChange={setShowAddAsset}
        existingAssets={Object.keys(config.assets)}
        addressesByAsset={addressesByAsset}
        onAdd={async (asset, assetConfig) => {
          const success = await saveAssetConfig(asset, assetConfig);
          if (success) setShowAddAsset(false);
        }}
        saving={saving}
      />
    </div>
  );
}

interface AssetConfigRowProps {
  asset: string;
  config: AssetConfig;
  availableKeys: string[];
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (config: AssetConfig) => void;
  saving: boolean;
}

function AssetConfigRow({
  asset,
  config,
  availableKeys,
  isEditing,
  onEdit,
  onCancel,
  onSave,
  saving,
}: AssetConfigRowProps) {
  const [editConfig, setEditConfig] = useState(config);

  useEffect(() => {
    setEditConfig(config);
  }, [config, isEditing]);

  function toggleWalletKey(key: string) {
    const keys = editConfig.walletKeys.includes(key)
      ? editConfig.walletKeys.filter((k) => k !== key)
      : [...editConfig.walletKeys, key];
    setEditConfig({ ...editConfig, walletKeys: keys });
  }

  if (!isEditing) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <span className="font-medium text-lg">{asset}</span>
            <Badge variant="secondary">Priority {config.priority}</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-2">
          <div>
            <span className="text-muted-foreground">Method:</span>
            <span className="ml-1">{config.method}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Threshold:</span>
            <span className="ml-1">
              {config.sweepThresholdCoin
                ? `${config.sweepThresholdCoin} ${asset}`
                : `$${config.sweepThresholdUsd}`}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Chunk:</span>
            <span className="ml-1">
              {config.chunk.mode === 'fixedCoin'
                ? `${config.chunk.amount} ${asset}`
                : `$${config.chunk.targetUsd}`}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Cooldown:</span>
            <span className="ml-1">{config.cooldownSeconds}s</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {config.walletKeys.map((key) => (
            <span
              key={key}
              className="text-xs px-2 py-1 rounded font-mono bg-primary/20 text-primary"
            >
              {key}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-muted/30">
      <div className="flex items-center justify-between mb-4">
        <span className="font-medium text-lg">{asset}</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => onSave(editConfig)}
            disabled={saving || editConfig.walletKeys.length === 0}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Wallet Keys Selection */}
      <div className="mb-4">
        <Label className="block mb-2">
          Wallet Keys (select which to use for round-robin)
        </Label>
        {availableKeys.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availableKeys.map((key) => {
              const isSelected = editConfig.walletKeys.includes(key);
              return (
                <Button
                  key={key}
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  onClick={() => toggleWalletKey(key)}
                  className="font-mono"
                >
                  {key}
                </Button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-yellow-500">
            No withdrawal addresses found in Kraken for {asset}. Add them in Kraken first.
          </div>
        )}
        {editConfig.walletKeys.length === 0 && availableKeys.length > 0 && (
          <div className="text-sm text-destructive mt-1">Select at least one wallet key</div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label className="text-xs">Priority (lower = higher)</Label>
          <Input
            type="number"
            value={editConfig.priority}
            onChange={(e) => setEditConfig({ ...editConfig, priority: parseInt(e.target.value) || 1 })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Method</Label>
          <Input
            value={editConfig.method}
            readOnly
            className="bg-muted text-muted-foreground"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Sweep Threshold ({asset})</Label>
          <Input
            type="number"
            step="any"
            value={editConfig.sweepThresholdCoin || ''}
            onChange={(e) =>
              setEditConfig({
                ...editConfig,
                sweepThresholdCoin: e.target.value ? parseFloat(e.target.value) : undefined,
                sweepThresholdUsd: undefined,
              })
            }
            placeholder="e.g., 0.001"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Reserve ({asset})</Label>
          <Input
            type="number"
            step="any"
            value={editConfig.reserveCoin}
            onChange={(e) => setEditConfig({ ...editConfig, reserveCoin: parseFloat(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Cooldown (seconds)</Label>
          <Input
            type="number"
            value={editConfig.cooldownSeconds}
            onChange={(e) => setEditConfig({ ...editConfig, cooldownSeconds: parseInt(e.target.value) || 30 })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Chunk Mode</Label>
          <Select
            value={editConfig.chunk.mode}
            onValueChange={(value) =>
              setEditConfig({
                ...editConfig,
                chunk: { ...editConfig.chunk, mode: value as 'fixedCoin' | 'usd' },
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixedCoin">Fixed Coin</SelectItem>
              <SelectItem value="usd">USD Based</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {editConfig.chunk.mode === 'fixedCoin' ? (
          <>
            <div className="space-y-1">
              <Label className="text-xs">Chunk Amount ({asset})</Label>
              <Input
                type="number"
                step="any"
                value={editConfig.chunk.amount || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, amount: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Chunk ({asset})</Label>
              <Input
                type="number"
                step="any"
                value={editConfig.chunk.max || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, max: e.target.value ? parseFloat(e.target.value) : undefined },
                  })
                }
                placeholder="Optional"
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-xs">Target USD</Label>
              <Input
                type="number"
                value={editConfig.chunk.targetUsd || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, targetUsd: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max USD</Label>
              <Input
                type="number"
                value={editConfig.chunk.maxUsd || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, maxUsd: e.target.value ? parseFloat(e.target.value) : undefined },
                  })
                }
                placeholder="Optional"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface AddAssetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingAssets: string[];
  addressesByAsset: Record<string, { method: string; keys: string[] }>;
  onAdd: (asset: string, config: AssetConfig) => void;
  saving: boolean;
}

function AddAssetDialog({ open, onOpenChange, existingAssets, addressesByAsset, onAdd, saving }: AddAssetDialogProps) {
  const availableAssets = Object.keys(addressesByAsset).filter(
    (a) => !existingAssets.includes(a) && addressesByAsset[a].keys.length > 0
  );
  const [selectedAsset, setSelectedAsset] = useState(availableAssets[0] || '');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [config, setConfig] = useState<Omit<AssetConfig, 'method' | 'walletKeys'>>({
    priority: existingAssets.length + 1,
    sweepThresholdCoin: 0.001,
    reserveCoin: 0,
    cooldownSeconds: 45,
    chunk: {
      mode: 'fixedCoin',
      amount: 0.01,
    },
  });

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
    if (!selectedAsset || !assetInfo || selectedKeys.length === 0) return;
    onAdd(selectedAsset, {
      ...config,
      method: assetInfo.method,
      walletKeys: selectedKeys,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Asset to Sweep</DialogTitle>
          <DialogDescription>Configure a new asset for automatic withdrawals.</DialogDescription>
        </DialogHeader>

        {availableAssets.length === 0 ? (
          <div className="py-4">
            <p className="text-muted-foreground">
              All assets with withdrawal addresses are already configured, or you need to add
              withdrawal addresses in Kraken first.
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-4">
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
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs">Sweep Threshold ({selectedAsset})</Label>
                    <Input
                      type="number"
                      step="any"
                      value={config.sweepThresholdCoin}
                      onChange={(e) => setConfig({ ...config, sweepThresholdCoin: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Chunk Amount ({selectedAsset})</Label>
                    <Input
                      type="number"
                      step="any"
                      value={config.chunk.amount}
                      onChange={(e) =>
                        setConfig({ ...config, chunk: { ...config.chunk, amount: parseFloat(e.target.value) || 0 } })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Priority</Label>
                    <Input
                      type="number"
                      value={config.priority}
                      onChange={(e) => setConfig({ ...config, priority: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Cooldown (s)</Label>
                    <Input
                      type="number"
                      value={config.cooldownSeconds}
                      onChange={(e) => setConfig({ ...config, cooldownSeconds: parseInt(e.target.value) || 30 })}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
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

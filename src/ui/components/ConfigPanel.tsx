import { useState, useEffect } from 'react';

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
  removedAt: number | null;
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
  const [syncStats, setSyncStats] = useState<{ new: number; restored: number; flagged: number } | null>(null);

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
        if (data.stats.flagged > 0) {
          setError(`Warning: ${data.stats.flagged} address(es) no longer found on Kraken`);
        } else if (data.stats.new > 0) {
          setSuccess(`Found ${data.stats.new} new address(es)`);
        } else {
          setSuccess('Addresses synced successfully');
        }
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

  // Group addresses by asset, tracking removed status for each key
  const addressesByAsset = addresses.reduce((acc, addr) => {
    if (!acc[addr.asset]) {
      acc[addr.asset] = { method: addr.method, keys: [], hasRemoved: false };
    }
    acc[addr.asset].keys.push({ key: addr.key, removed: addr.removedAt !== null });
    if (addr.removedAt !== null) {
      acc[addr.asset].hasRemoved = true;
    }
    return acc;
  }, {} as Record<string, { method: string; keys: Array<{ key: string; removed: boolean }>; hasRemoved: boolean }>);

  // Assets available from Kraken but not yet configured
  const unconfiguredAssets = Object.keys(addressesByAsset).filter(
    (asset) => !config?.assets[asset]
  );

  if (loading) {
    return <div className="text-gray-400">Loading configuration...</div>;
  }

  if (!config) {
    return <div className="text-red-400">Failed to load configuration</div>;
  }

  return (
    <div className="space-y-6">
      {/* Sweeper Control */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="font-semibold text-white">Sweeper Control</h2>
        </div>
        <div className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                sweeperStatus?.enabled ? 'bg-green-500' : 'bg-gray-500'
              }`}
            />
            <span className="text-white font-medium">
              {sweeperStatus?.enabled ? 'Running' : 'Stopped'}
            </span>
            {!sweeperStatus?.hasApiKeys && (
              <span className="text-yellow-500 text-sm">
                Configure API keys to enable
              </span>
            )}
          </div>
          <button
            onClick={toggleSweeper}
            disabled={toggling || !sweeperStatus?.hasApiKeys}
            className={`px-4 py-2 text-sm font-medium rounded transition-colors ${
              sweeperStatus?.enabled
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            } disabled:bg-gray-700 disabled:text-gray-500`}
          >
            {toggling ? 'Working...' : sweeperStatus?.enabled ? 'Stop Sweeper' : 'Start Sweeper'}
          </button>
        </div>
      </div>

      {/* Kraken Withdrawal Addresses */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-white">Kraken Withdrawal Addresses</h2>
          <button
            onClick={syncAddresses}
            disabled={syncing || !sweeperStatus?.hasApiKeys}
            className="text-sm text-gray-400 hover:text-white transition-colors disabled:text-gray-600"
          >
            {syncing ? 'Syncing...' : 'Sync from Kraken'}
          </button>
        </div>

        {loadingAddresses ? (
          <div className="p-4 text-gray-400 text-center">
            Loading addresses...
          </div>
        ) : addresses.length === 0 ? (
          <div className="p-4 text-gray-400 text-center">
            No withdrawal addresses found. Click "Sync from Kraken" to fetch addresses, or add them in Kraken first.
          </div>
        ) : (
          <div className="p-4">
            <div className="grid gap-3">
              {Object.entries(addressesByAsset).map(([asset, { method, keys, hasRemoved }]) => {
                const isConfigured = !!config.assets[asset];
                return (
                  <div
                    key={asset}
                    className={`p-3 rounded-lg border ${
                      hasRemoved
                        ? 'bg-red-900/20 border-red-800'
                        : isConfigured
                        ? 'bg-green-900/20 border-green-800'
                        : 'bg-gray-800 border-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{asset}</span>
                        <span className="text-xs text-gray-500">via {method}</span>
                        {hasRemoved && (
                          <span className="text-xs bg-red-800 text-red-200 px-2 py-0.5 rounded">
                            Address Removed
                          </span>
                        )}
                        {isConfigured && !hasRemoved && (
                          <span className="text-xs bg-green-800 text-green-200 px-2 py-0.5 rounded">
                            Configured
                          </span>
                        )}
                      </div>
                      {!isConfigured && !hasRemoved && (
                        <button
                          onClick={() => {
                            setShowAddAsset(true);
                            // Pre-select this asset
                          }}
                          className="text-xs text-blue-400 hover:text-blue-300"
                        >
                          + Add to sweep
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {keys.map(({ key, removed }) => (
                        <span
                          key={key}
                          className={`text-xs px-2 py-1 rounded font-mono ${
                            removed
                              ? 'bg-red-900/50 text-red-300 line-through'
                              : 'bg-gray-700 text-gray-300'
                          }`}
                          title={removed ? 'This address was removed from Kraken' : undefined}
                        >
                          {key}
                        </span>
                      ))}
                    </div>
                    {hasRemoved && (
                      <div className="mt-2 text-xs text-red-400">
                        One or more withdrawal addresses no longer exist on Kraken. Update your configuration.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Global Settings */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="font-semibold text-white">Global Settings</h2>
        </div>
        <div className="p-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-400">Max Inflight Withdrawals:</span>
            <span className="text-white ml-2">{config.global.maxInflightWithdrawals}</span>
          </div>
          <div>
            <span className="text-gray-400">Per-Asset Max Inflight:</span>
            <span className="text-white ml-2">{config.global.perAssetMaxInflight}</span>
          </div>
          <div>
            <span className="text-gray-400">Allowed Order Types:</span>
            <span className="text-white ml-2">{config.global.allowedOrderTypes.join(', ')}</span>
          </div>
          {config.global.keyNamePrefix && (
            <div>
              <span className="text-gray-400">Key Name Prefix:</span>
              <span className="text-white ml-2">{config.global.keyNamePrefix}</span>
            </div>
          )}
        </div>
      </div>

      {/* Configured Assets */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-white">Sweep Configuration</h2>
          {unconfiguredAssets.length > 0 && (
            <button
              onClick={() => setShowAddAsset(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
            >
              Add Asset ({unconfiguredAssets.length} available)
            </button>
          )}
        </div>

        {error && <div className="px-4 py-2 text-red-400 text-sm bg-red-900/20">{error}</div>}
        {success && <div className="px-4 py-2 text-green-400 text-sm bg-green-900/20">{success}</div>}

        {Object.keys(config.assets).length === 0 ? (
          <div className="p-4 text-gray-400 text-center">
            No assets configured for sweeping.
            {unconfiguredAssets.length > 0
              ? ` You have ${unconfiguredAssets.length} asset(s) with withdrawal addresses ready to configure.`
              : ' Add withdrawal addresses in Kraken first.'}
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
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
      </div>

      {/* Add Asset Modal */}
      {showAddAsset && (
        <AddAssetModal
          existingAssets={Object.keys(config.assets)}
          addressesByAsset={addressesByAsset}
          onAdd={async (asset, assetConfig) => {
            const success = await saveAssetConfig(asset, assetConfig);
            if (success) setShowAddAsset(false);
          }}
          onClose={() => setShowAddAsset(false)}
          saving={saving}
        />
      )}
    </div>
  );
}

interface AssetConfigRowProps {
  asset: string;
  config: AssetConfig;
  availableKeys: Array<{ key: string; removed: boolean }>;
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

  // Filter to only active (non-removed) keys for selection
  const activeKeys = availableKeys.filter((k) => !k.removed);
  // Check if any configured keys have been removed
  const removedConfiguredKeys = config.walletKeys.filter((wk) =>
    availableKeys.some((k) => k.key === wk && k.removed)
  );

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
      <div className={`p-4 ${removedConfiguredKeys.length > 0 ? 'bg-red-900/10' : ''}`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <span className="font-medium text-white text-lg">{asset}</span>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
              Priority {config.priority}
            </span>
            {removedConfiguredKeys.length > 0 && (
              <span className="text-xs bg-red-800 text-red-200 px-2 py-0.5 rounded">
                Has Removed Keys
              </span>
            )}
          </div>
          <button
            onClick={onEdit}
            className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Edit
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-2">
          <div>
            <span className="text-gray-500">Method:</span>
            <span className="text-gray-300 ml-1">{config.method}</span>
          </div>
          <div>
            <span className="text-gray-500">Threshold:</span>
            <span className="text-gray-300 ml-1">
              {config.sweepThresholdCoin
                ? `${config.sweepThresholdCoin} ${asset}`
                : `$${config.sweepThresholdUsd}`}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Chunk:</span>
            <span className="text-gray-300 ml-1">
              {config.chunk.mode === 'fixedCoin'
                ? `${config.chunk.amount} ${asset}`
                : `$${config.chunk.targetUsd}`}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Cooldown:</span>
            <span className="text-gray-300 ml-1">{config.cooldownSeconds}s</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {config.walletKeys.map((key) => {
            const isRemoved = removedConfiguredKeys.includes(key);
            return (
              <span
                key={key}
                className={`text-xs px-2 py-1 rounded font-mono ${
                  isRemoved
                    ? 'bg-red-900/50 text-red-300 line-through'
                    : 'bg-blue-900/50 text-blue-300'
                }`}
              >
                {key}
              </span>
            );
          })}
        </div>
        {removedConfiguredKeys.length > 0 && (
          <div className="mt-2 text-xs text-red-400">
            Warning: {removedConfiguredKeys.length} configured wallet key(s) no longer exist on Kraken. Edit to update.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 bg-gray-800/50">
      <div className="flex items-center justify-between mb-4">
        <span className="font-medium text-white text-lg">{asset}</span>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(editConfig)}
            disabled={saving || editConfig.walletKeys.length === 0}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Wallet Keys Selection */}
      <div className="mb-4">
        <label className="block text-sm text-gray-400 mb-2">
          Wallet Keys (select which to use for round-robin)
        </label>
        {activeKeys.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {activeKeys.map(({ key }) => {
              const isSelected = editConfig.walletKeys.includes(key);
              return (
                <button
                  key={key}
                  onClick={() => toggleWalletKey(key)}
                  className={`px-3 py-1.5 text-sm font-mono rounded border transition-colors ${
                    isSelected
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-700 border-gray-600 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  {key}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-yellow-500">
            No withdrawal addresses found in Kraken for {asset}. Add them in Kraken first.
          </div>
        )}
        {removedConfiguredKeys.length > 0 && (
          <div className="mt-2 p-2 bg-red-900/20 border border-red-800 rounded text-sm">
            <span className="text-red-400">Removed keys in config: </span>
            {removedConfiguredKeys.map((key) => (
              <span key={key} className="text-red-300 font-mono line-through mx-1">{key}</span>
            ))}
            <div className="text-red-400 text-xs mt-1">These will be removed when you save.</div>
          </div>
        )}
        {editConfig.walletKeys.length === 0 && activeKeys.length > 0 && (
          <div className="text-sm text-red-400 mt-1">Select at least one wallet key</div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Priority (lower = higher)</label>
          <input
            type="number"
            value={editConfig.priority}
            onChange={(e) => setEditConfig({ ...editConfig, priority: parseInt(e.target.value) || 1 })}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Method</label>
          <input
            type="text"
            value={editConfig.method}
            onChange={(e) => setEditConfig({ ...editConfig, method: e.target.value })}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            readOnly
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Sweep Threshold ({asset})</label>
          <input
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
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            placeholder="e.g., 0.001"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Reserve ({asset})</label>
          <input
            type="number"
            step="any"
            value={editConfig.reserveCoin}
            onChange={(e) => setEditConfig({ ...editConfig, reserveCoin: parseFloat(e.target.value) || 0 })}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Cooldown (seconds)</label>
          <input
            type="number"
            value={editConfig.cooldownSeconds}
            onChange={(e) => setEditConfig({ ...editConfig, cooldownSeconds: parseInt(e.target.value) || 30 })}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Chunk Mode</label>
          <select
            value={editConfig.chunk.mode}
            onChange={(e) =>
              setEditConfig({
                ...editConfig,
                chunk: { ...editConfig.chunk, mode: e.target.value as 'fixedCoin' | 'usd' },
              })
            }
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
          >
            <option value="fixedCoin">Fixed Coin</option>
            <option value="usd">USD Based</option>
          </select>
        </div>
        {editConfig.chunk.mode === 'fixedCoin' ? (
          <>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Chunk Amount ({asset})</label>
              <input
                type="number"
                step="any"
                value={editConfig.chunk.amount || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, amount: parseFloat(e.target.value) || 0 },
                  })
                }
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Max Chunk ({asset})</label>
              <input
                type="number"
                step="any"
                value={editConfig.chunk.max || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, max: e.target.value ? parseFloat(e.target.value) : undefined },
                  })
                }
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                placeholder="Optional"
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Target USD</label>
              <input
                type="number"
                value={editConfig.chunk.targetUsd || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, targetUsd: parseFloat(e.target.value) || 0 },
                  })
                }
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Max USD</label>
              <input
                type="number"
                value={editConfig.chunk.maxUsd || ''}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    chunk: { ...editConfig.chunk, maxUsd: e.target.value ? parseFloat(e.target.value) : undefined },
                  })
                }
                className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                placeholder="Optional"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface AddAssetModalProps {
  existingAssets: string[];
  addressesByAsset: Record<string, { method: string; keys: Array<{ key: string; removed: boolean }>; hasRemoved: boolean }>;
  onAdd: (asset: string, config: AssetConfig) => void;
  onClose: () => void;
  saving: boolean;
}

function AddAssetModal({ existingAssets, addressesByAsset, onAdd, onClose, saving }: AddAssetModalProps) {
  // Only show assets that have at least one active (non-removed) key
  const availableAssets = Object.keys(addressesByAsset).filter(
    (a) => !existingAssets.includes(a) && addressesByAsset[a].keys.some((k) => !k.removed)
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
      // Pre-select all active (non-removed) keys for this asset
      const activeKeys = addressesByAsset[selectedAsset].keys
        .filter((k) => !k.removed)
        .map((k) => k.key);
      setSelectedKeys(activeKeys);
    }
  }, [selectedAsset, addressesByAsset]);

  const assetInfo = selectedAsset ? addressesByAsset[selectedAsset] : null;
  const activeKeys = assetInfo?.keys.filter((k) => !k.removed) || [];

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

  if (availableAssets.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
        <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md p-6">
          <h3 className="font-semibold text-white mb-4">No Assets Available</h3>
          <p className="text-gray-400 mb-4">
            All assets with withdrawal addresses are already configured, or you need to add
            withdrawal addresses in Kraken first.
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-lg">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="font-semibold text-white">Add Asset to Sweep</h3>
        </div>

        <div className="p-4 space-y-4">
          {/* Asset Selection */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Select Asset</label>
            <div className="flex flex-wrap gap-2">
              {availableAssets.map((asset) => (
                <button
                  key={asset}
                  onClick={() => setSelectedAsset(asset)}
                  className={`px-4 py-2 rounded border transition-colors ${
                    selectedAsset === asset
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
                  }`}
                >
                  {asset}
                </button>
              ))}
            </div>
          </div>

          {assetInfo && (
            <>
              {/* Method (read-only) */}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Withdrawal Method</label>
                <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-300">
                  {assetInfo.method}
                </div>
              </div>

              {/* Wallet Keys Selection */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">
                  Select Wallet Keys ({selectedKeys.length} selected)
                </label>
                <div className="flex flex-wrap gap-2">
                  {activeKeys.map(({ key }) => {
                    const isSelected = selectedKeys.includes(key);
                    return (
                      <button
                        key={key}
                        onClick={() => toggleKey(key)}
                        className={`px-3 py-1.5 text-sm font-mono rounded border transition-colors ${
                          isSelected
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-gray-700 border-gray-600 text-gray-300 hover:border-gray-500'
                        }`}
                      >
                        {key}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Config */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Sweep Threshold ({selectedAsset})</label>
                  <input
                    type="number"
                    step="any"
                    value={config.sweepThresholdCoin}
                    onChange={(e) => setConfig({ ...config, sweepThresholdCoin: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Chunk Amount ({selectedAsset})</label>
                  <input
                    type="number"
                    step="any"
                    value={config.chunk.amount}
                    onChange={(e) =>
                      setConfig({ ...config, chunk: { ...config.chunk, amount: parseFloat(e.target.value) || 0 } })
                    }
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Priority</label>
                  <input
                    type="number"
                    value={config.priority}
                    onChange={(e) => setConfig({ ...config, priority: parseInt(e.target.value) || 1 })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Cooldown (seconds)</label>
                  <input
                    type="number"
                    value={config.cooldownSeconds}
                    onChange={(e) => setConfig({ ...config, cooldownSeconds: parseInt(e.target.value) || 30 })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={saving || !selectedAsset || selectedKeys.length === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
          >
            {saving ? 'Adding...' : 'Add Asset'}
          </button>
        </div>
      </div>
    </div>
  );
}

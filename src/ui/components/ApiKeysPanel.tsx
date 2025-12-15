import { useState, useEffect } from 'react';

interface ApiKeysPanelProps {
  hasKeys: boolean;
  onUpdate: () => void;
}

interface ApiKeyInfo {
  id: string;
  name: string;
  tier: 'starter' | 'intermediate' | 'pro';
  isActive: boolean;
  isValid: boolean;
  estimatedCounter: number;
  headroom: number;
  rateLimitedUntil: number | null;
  lastError: string | null;
}

const TIER_INFO = {
  starter: { maxCounter: 15, decayRate: 0.33, label: 'Starter' },
  intermediate: { maxCounter: 20, decayRate: 0.5, label: 'Intermediate' },
  pro: { maxCounter: 20, decayRate: 1.0, label: 'Pro' },
};

export function ApiKeysPanel({ hasKeys, onUpdate }: ApiKeysPanelProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetchKeys();
    // Refresh every 5 seconds to update counter estimates
    const interval = setInterval(fetchKeys, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchKeys() {
    try {
      const res = await fetch('/api/keys');
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys);
      }
    } catch (err) {
      console.error('Failed to fetch keys:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Are you sure you want to delete the API key "${name}"?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSuccess(`Deleted key "${name}"`);
        fetchKeys();
        onUpdate();
      }
    } catch (err) {
      setError('Failed to delete key');
    }
  }

  async function handleToggleActive(id: string, currentActive: boolean) {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentActive }),
      });
      if (res.ok) {
        fetchKeys();
        onUpdate();
      }
    } catch (err) {
      setError('Failed to update key');
    }
  }

  async function handleClearRateLimit(id: string) {
    try {
      const res = await fetch(`/api/keys/${id}/clear-limit`, { method: 'POST' });
      if (res.ok) {
        setSuccess('Rate limit cleared');
        fetchKeys();
      }
    } catch (err) {
      setError('Failed to clear rate limit');
    }
  }

  async function handleRevalidate(id: string) {
    try {
      const res = await fetch(`/api/keys/${id}/revalidate`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setSuccess('Key revalidated successfully');
        fetchKeys();
        onUpdate();
      } else {
        setError(data.error || 'Failed to revalidate');
      }
    } catch (err) {
      setError('Failed to revalidate key');
    }
  }

  if (loading) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="text-gray-400">Loading API keys...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-white">Kraken API Keys</h2>
          <button
            onClick={() => setShowAddForm(true)}
            className="bridge-button text-sm"
          >
            + Add Key
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 text-red-400 text-sm bg-red-900/20">{error}</div>
        )}
        {success && (
          <div className="px-4 py-2 text-green-400 text-sm bg-green-900/20">{success}</div>
        )}

        {keys.length === 0 ? (
          <div className="p-4 text-gray-400 text-center">
            No API keys configured. Add a key to start using the sweeper.
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {keys.map((key) => (
              <ApiKeyRow
                key={key.id}
                keyInfo={key}
                onDelete={() => handleDelete(key.id, key.name)}
                onToggleActive={() => handleToggleActive(key.id, key.isActive)}
                onClearRateLimit={() => handleClearRateLimit(key.id)}
                onRevalidate={() => handleRevalidate(key.id)}
                onUpdate={fetchKeys}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Key Modal */}
      {showAddForm && (
        <AddKeyModal
          onClose={() => setShowAddForm(false)}
          onSuccess={() => {
            setShowAddForm(false);
            fetchKeys();
            onUpdate();
            setSuccess('API key added successfully');
          }}
        />
      )}
    </div>
  );
}

interface ApiKeyRowProps {
  keyInfo: ApiKeyInfo;
  onDelete: () => void;
  onToggleActive: () => void;
  onClearRateLimit: () => void;
  onRevalidate: () => void;
  onUpdate: () => void;
}

function ApiKeyRow({
  keyInfo,
  onDelete,
  onToggleActive,
  onClearRateLimit,
  onRevalidate,
  onUpdate,
}: ApiKeyRowProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    hasBalance: boolean;
    hasWithdraw: boolean;
    error?: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);

  const tierInfo = TIER_INFO[keyInfo.tier];
  const isRateLimited = keyInfo.rateLimitedUntil && keyInfo.rateLimitedUntil > Date.now();
  const rateLimitSeconds = isRateLimited
    ? Math.ceil((keyInfo.rateLimitedUntil! - Date.now()) / 1000)
    : 0;

  // Calculate counter bar width (0-100%)
  const counterPercent = Math.min(100, (keyInfo.estimatedCounter / tierInfo.maxCounter) * 100);
  const counterColor =
    counterPercent < 50 ? 'bg-green-500' : counterPercent < 80 ? 'bg-yellow-500' : 'bg-red-500';

  async function handleTest() {
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch(`/api/keys/${keyInfo.id}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(data);
      onUpdate();
    } catch (err) {
      setTestResult({
        success: false,
        hasBalance: false,
        hasWithdraw: false,
        error: 'Network error',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`p-4 ${!keyInfo.isActive ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              !keyInfo.isValid
                ? 'bg-red-500'
                : isRateLimited
                ? 'bg-yellow-500'
                : keyInfo.isActive
                ? 'bg-green-500'
                : 'bg-gray-500'
            }`}
            title={
              !keyInfo.isValid
                ? 'Invalid'
                : isRateLimited
                ? 'Rate limited'
                : keyInfo.isActive
                ? 'Active'
                : 'Disabled'
            }
          />
          <div>
            <div className="font-medium text-white">{keyInfo.name}</div>
            <div className="text-xs text-gray-500">
              {tierInfo.label} tier ({tierInfo.maxCounter} max, -{tierInfo.decayRate}/sec)
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
          >
            {testing ? 'Testing...' : 'Test'}
          </button>
          <button
            onClick={onToggleActive}
            className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
          >
            {keyInfo.isActive ? 'Disable' : 'Enable'}
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1 text-xs bg-red-900/50 hover:bg-red-800 text-red-300 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Counter bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
          <span>API Counter</span>
          <span>
            {keyInfo.estimatedCounter.toFixed(1)} / {tierInfo.maxCounter} (headroom:{' '}
            {keyInfo.headroom.toFixed(1)})
          </span>
        </div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full ${counterColor} transition-all duration-300`}
            style={{ width: `${counterPercent}%` }}
          />
        </div>
      </div>

      {/* Status messages */}
      {!keyInfo.isValid && (
        <div className="flex items-center justify-between p-2 bg-red-900/30 border border-red-800 rounded text-sm mb-2">
          <div className="text-red-400">
            <span className="font-medium">Invalid: </span>
            {keyInfo.lastError || 'Unknown error'}
          </div>
          <button
            onClick={onRevalidate}
            className="px-2 py-1 text-xs bg-red-800 hover:bg-red-700 text-white rounded"
          >
            Revalidate
          </button>
        </div>
      )}

      {isRateLimited && (
        <div className="flex items-center justify-between p-2 bg-yellow-900/30 border border-yellow-800 rounded text-sm mb-2">
          <div className="text-yellow-400">
            Rate limited for {rateLimitSeconds}s
          </div>
          <button
            onClick={onClearRateLimit}
            className="px-2 py-1 text-xs bg-yellow-800 hover:bg-yellow-700 text-white rounded"
          >
            Clear
          </button>
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div
          className={`p-2 rounded text-sm ${
            testResult.success
              ? 'bg-green-900/30 border border-green-800 text-green-400'
              : 'bg-red-900/30 border border-red-800 text-red-400'
          }`}
        >
          {testResult.success ? (
            <span>
              Connection OK | Balance: {testResult.hasBalance ? 'Yes' : 'No'} | Withdraw:{' '}
              {testResult.hasWithdraw ? 'Yes' : 'No'}
            </span>
          ) : (
            <span>{testResult.error}</span>
          )}
        </div>
      )}
    </div>
  );
}

interface AddKeyModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

function AddKeyModal({ onClose, onSuccess }: AddKeyModalProps) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [tier, setTier] = useState<'starter' | 'intermediate' | 'pro'>('starter');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, apiKey, apiSecret, tier }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.details ? `${data.error}: ${data.details}` : data.error);
        return;
      }

      onSuccess();
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="font-semibold text-white">Add API Key</h3>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="bg-yellow-900/30 border border-yellow-800 rounded-md p-3 text-sm text-yellow-200">
            <strong>Required permissions:</strong>
            <ul className="list-disc list-inside mt-1 text-yellow-300">
              <li>Funds: Query</li>
              <li>Funds: Withdraw</li>
              <li>Orders & Trades: Query closed orders & trades</li>
            </ul>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Key Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., Main Key, Backup Key"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Tier
            </label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as typeof tier)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="starter">Starter (15 max, -0.33/sec)</option>
              <option value="intermediate">Intermediate (20 max, -0.5/sec)</option>
              <option value="pro">Pro (20 max, -1/sec)</option>
            </select>
            <div className="mt-2 p-2 bg-gray-800/50 border border-gray-700 rounded text-xs text-gray-400">
              <p className="mb-1">
                <strong className="text-gray-300">Your tier matches your Kraken verification level:</strong>
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                <li><span className="text-gray-300">Starter</span> - Basic verification (Express tier)</li>
                <li><span className="text-gray-300">Intermediate</span> - Full identity verification</li>
                <li><span className="text-gray-300">Pro</span> - Pro-level verification</li>
              </ul>
              <p className="mt-2 text-gray-500">
                Check your tier at Kraken → Settings → Get Verified. If unsure, select Starter
                to be conservative with rate limits.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              API Key
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter your Kraken API key"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              API Secret
            </label>
            <input
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter your Kraken API secret"
              required
            />
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bridge-button"
            >
              {loading ? 'Adding...' : 'Add Key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

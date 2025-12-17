import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/ui/components/ui/card";
import { Button } from "@/ui/components/ui/button";
import { Badge } from "@/ui/components/ui/badge";
import { Progress } from "@/ui/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/ui/components/ui/dialog";
import { Input } from "@/ui/components/ui/input";
import { Label } from "@/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/components/ui/select";
import { Switch } from "@/ui/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/ui/alert";
import { AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react';

interface ApiKeysPanelProps {
  hasKeys: boolean;
  onUpdate: () => void;
}

interface ApiKeyInfo {
  id: string;
  name: string;
  exchange: string;
  tier: string;
  isActive: boolean;
  isValid: boolean;
  estimatedCounter: number;
  headroom: number;
  rateLimitedUntil: number | null;
  lastError: string | null;
}

interface ExchangeInfo {
  id: string;
  name: string;
  requiresPassphrase: boolean;
  defaultTier: string;
  tiers: Array<{ value: string; label: string; maxCounter: number; decayRate: number }>;
  enabled: boolean;
}

// Fallback tier info if not loaded
const DEFAULT_TIER_INFO: Record<string, { maxCounter: number; decayRate: number; label: string }> = {
  starter: { maxCounter: 15, decayRate: 0.33, label: 'Starter' },
  intermediate: { maxCounter: 20, decayRate: 0.5, label: 'Intermediate' },
  pro: { maxCounter: 20, decayRate: 1.0, label: 'Pro' },
  standard: { maxCounter: 30, decayRate: 3, label: 'Standard' },
  vip1: { maxCounter: 60, decayRate: 6, label: 'VIP 1' },
  vip2: { maxCounter: 100, decayRate: 10, label: 'VIP 2+' },
};

export function ApiKeysPanel({ hasKeys, onUpdate }: ApiKeysPanelProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeInfo[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [expandedExchanges, setExpandedExchanges] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchKeys(); // Initial load - no auto-expand
    fetchExchanges();
    // Refresh every 5 seconds to update counter estimates
    const interval = setInterval(() => fetchKeys(false), 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchKeys(autoExpand: boolean = false) {
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

  async function fetchExchanges() {
    try {
      const res = await fetch('/api/exchanges/available');
      if (res.ok) {
        const data = await res.json();
        setExchanges(data.exchanges);
      }
    } catch (err) {
      console.error('Failed to fetch exchanges:', err);
    }
  }

  function toggleExchange(exchangeId: string) {
    setExpandedExchanges((prev) => {
      const next = new Set(prev);
      if (next.has(exchangeId)) {
        next.delete(exchangeId);
      } else {
        next.add(exchangeId);
      }
      return next;
    });
  }

  // Group keys by exchange
  const keysByExchange = keys.reduce((acc, key) => {
    const exchange = key.exchange || 'kraken';
    if (!acc[exchange]) acc[exchange] = [];
    acc[exchange].push(key);
    return acc;
  }, {} as Record<string, ApiKeyInfo[]>);

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

  async function handleToggleExchangeEnabled(exchangeId: string, currentEnabled: boolean) {
    try {
      const res = await fetch(`/api/exchanges/${exchangeId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (res.ok) {
        // Update local state
        setExchanges((prev) =>
          prev.map((ex) =>
            ex.id === exchangeId ? { ...ex, enabled: !currentEnabled } : ex
          )
        );
        setSuccess(`${currentEnabled ? 'Disabled' : 'Enabled'} ${exchangeId}`);
        onUpdate();
      }
    } catch (err) {
      setError('Failed to update exchange setting');
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
      <Card>
        <CardContent className="p-4 text-muted-foreground">Loading API keys...</CardContent>
      </Card>
    );
  }

  // Get exchange info by id
  function getExchangeInfo(exchangeId: string): ExchangeInfo | undefined {
    return exchanges.find((e) => e.id === exchangeId);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader className="py-4 border-b flex flex-row items-center justify-between">
          <CardTitle>Exchange API Keys</CardTitle>
          <Button onClick={() => setShowAddForm(true)} size="sm">
            + Add Key
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          {error && (
            <Alert variant="destructive" className="m-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert className="m-4 border-green-500 text-green-500">
              <Info className="h-4 w-4" />
              <AlertTitle>Success</AlertTitle>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          {exchanges.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              Loading exchanges...
            </div>
          ) : (
            <div className="divide-y">
              {/* Hide non-Kraken exchanges for now */}
              {exchanges.filter((exchange) => exchange.id === 'kraken').map((exchange) => {
                const exchangeKeys = keysByExchange[exchange.id] || [];
                const isExpanded = expandedExchanges.has(exchange.id);
                const hasKeys = exchangeKeys.length > 0;

                // Calculate aggregate counter stats for this exchange
                const totalCounter = exchangeKeys.reduce((sum, k) => sum + k.estimatedCounter, 0);
                const totalMaxCounter = exchangeKeys.reduce((sum, k) => {
                  const tierInfo = exchange.tiers.find((t) => t.value === k.tier);
                  return sum + (tierInfo?.maxCounter || 20);
                }, 0);
                const aggregatePercent = totalMaxCounter > 0 ? Math.min(100, (totalCounter / totalMaxCounter) * 100) : 0;
                const aggregateColor =
                  aggregatePercent < 50 ? 'bg-green-500' : aggregatePercent < 80 ? 'bg-yellow-500' : 'bg-red-500';

                return (
                  <div key={exchange.id}>
                    <div
                      className="flex flex-col p-4 hover:bg-muted/50 cursor-pointer"
                      onClick={() => toggleExchange(exchange.id)}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-2">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          <span className={`font-medium ${!exchange.enabled ? 'text-muted-foreground' : ''}`}>
                            {exchange.name}
                          </span>
                          {hasKeys && (
                            <Badge variant="secondary" className="ml-2">
                              {exchangeKeys.length} key{exchangeKeys.length !== 1 ? 's' : ''}
                            </Badge>
                          )}
                          {!exchange.enabled && (
                            <Badge variant="outline" className="ml-2 text-muted-foreground">
                              Disabled
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {!hasKeys && (
                            <span className="text-xs text-muted-foreground">No keys configured</span>
                          )}
                          {hasKeys && (
                            <Switch
                              checked={exchange.enabled}
                              onCheckedChange={() => handleToggleExchangeEnabled(exchange.id, exchange.enabled)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`${exchange.enabled ? 'Disable' : 'Enable'} ${exchange.name}`}
                            />
                          )}
                        </div>
                      </div>

                      {/* Summary Bars (visible when closed) */}
                      {!isExpanded && hasKeys && (
                        <div className="mt-3 space-y-2 pl-6">
                          {exchangeKeys.map((key) => {
                            const tierFromExchange = exchange.tiers.find((t) => t.value === key.tier);
                            const tierInfo = tierFromExchange
                              ? { maxCounter: tierFromExchange.maxCounter }
                              : DEFAULT_TIER_INFO[key.tier] || { maxCounter: 20 };
                            
                            const percent = Math.min(100, (key.estimatedCounter / tierInfo.maxCounter) * 100);
                            const color = percent < 50 ? 'bg-green-500' : percent < 80 ? 'bg-yellow-500' : 'bg-red-500';

                            return (
                              <div key={key.id} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                  <div className="flex items-center gap-2">
                                    <span className="text-muted-foreground">{key.name}</span>
                                    {!key.isValid && <span className="text-red-500 font-bold">!</span>}
                                  </div>
                                  <span className="text-muted-foreground font-mono">
                                    {key.estimatedCounter.toFixed(1)}/{tierInfo.maxCounter}
                                  </span>
                                </div>
                                <Progress value={percent} className="h-1.5" indicatorClassName={color} />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {isExpanded && (
                      exchangeKeys.length === 0 ? (
                        <div className="px-4 pb-4 text-sm text-muted-foreground ml-6">
                          Add an API key for {exchange.name} to start sweeping.
                        </div>
                      ) : (
                        <div className="divide-y border-t">
                          {exchangeKeys.map((key) => (
                            <ApiKeyRow
                              key={key.id}
                              keyInfo={key}
                              exchangeInfo={exchange}
                              onDelete={() => handleDelete(key.id, key.name)}
                              onToggleActive={() => handleToggleActive(key.id, key.isActive)}
                              onClearRateLimit={() => handleClearRateLimit(key.id)}
                              onRevalidate={() => handleRevalidate(key.id)}
                              onUpdate={fetchKeys}
                            />
                          ))}
                        </div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Key Modal */}
      <AddKeyDialog
        open={showAddForm}
        onOpenChange={setShowAddForm}
        exchanges={exchanges}
        onSuccess={() => {
          setShowAddForm(false);
          fetchKeys();
          onUpdate();
          setSuccess('API key added successfully');
        }}
      />
    </div>
  );
}

interface ApiKeyRowProps {
  keyInfo: ApiKeyInfo;
  exchangeInfo?: ExchangeInfo;
  onDelete: () => void;
  onToggleActive: () => void;
  onClearRateLimit: () => void;
  onRevalidate: () => void;
  onUpdate: () => void;
}

function ApiKeyRow({
  keyInfo,
  exchangeInfo,
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

  // Get tier info from exchange or fallback
  const tierFromExchange = exchangeInfo?.tiers.find((t) => t.value === keyInfo.tier);
  const tierInfo = tierFromExchange
    ? { maxCounter: tierFromExchange.maxCounter, decayRate: tierFromExchange.decayRate, label: tierFromExchange.label }
    : DEFAULT_TIER_INFO[keyInfo.tier] || { maxCounter: 20, decayRate: 1, label: keyInfo.tier };
  const isRateLimited = keyInfo.rateLimitedUntil && keyInfo.rateLimitedUntil > Date.now();
  const rateLimitSeconds = isRateLimited
    ? Math.ceil((keyInfo.rateLimitedUntil! - Date.now()) / 1000)
    : 0;

  // Calculate counter bar width (0-100%)
  const counterPercent = Math.min(100, (keyInfo.estimatedCounter / tierInfo.maxCounter) * 100);
  const counterColor =
    counterPercent < 50 ? 'bg-green-500' : counterPercent < 80 ? 'bg-yellow-500' : 'bg-red-500';
  
  // Custom progress color handling needs inline style or multiple progress variants if strict
  // shadcn Progress uses bg-primary for indicator. We can override via className on indicator? 
  // No, Progress component encapsulates it. We can just use standard Progress and accept the primary color, 
  // or use CSS variable override.
  // Let's stick to standard Progress for now, or wrap it in a div with CSS variable override.

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
          <span className={`relative flex h-2.5 w-2.5`}>
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
               !keyInfo.isValid ? 'bg-red-500' : isRateLimited ? 'bg-yellow-500' : keyInfo.isActive ? 'bg-green-500' : 'hidden'
            }`}></span>
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
              !keyInfo.isValid
                ? 'bg-red-500'
                : isRateLimited
                ? 'bg-yellow-500'
                : keyInfo.isActive
                ? 'bg-green-500'
                : 'bg-gray-500'
            }`}></span>
          </span>
          
          <div>
            <div className="font-medium">{keyInfo.name}</div>
            <div className="text-xs text-muted-foreground">
              {tierInfo.label} tier ({tierInfo.maxCounter} max, -{tierInfo.decayRate}/sec)
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? 'Testing...' : 'Test'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleActive}
          >
            {keyInfo.isActive ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onDelete}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Counter bar */}
      <div className="mb-2 space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>API Counter</span>
          <span>
            {keyInfo.estimatedCounter.toFixed(1)} / {tierInfo.maxCounter} (headroom:{' '}
            {keyInfo.headroom.toFixed(1)})
          </span>
        </div>
        <Progress value={counterPercent} className="h-2" indicatorClassName={counterColor} />
      </div>

      {/* Status messages */}
      {!keyInfo.isValid && (
        <Alert variant="destructive" className="mb-2 py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Invalid</AlertTitle>
          <AlertDescription className="flex justify-between items-center">
            <span>{keyInfo.lastError || 'Unknown error'}</span>
            <Button variant="outline" size="sm" onClick={onRevalidate} className="bg-background/20 hover:bg-background/30 border-none h-auto py-0.5">Revalidate</Button>
          </AlertDescription>
        </Alert>
      )}

      {isRateLimited && (
        <Alert className="mb-2 py-2 border-yellow-500 text-yellow-500">
           <AlertTriangle className="h-4 w-4" />
           <AlertDescription className="flex justify-between items-center w-full">
            <span>Rate limited for {rateLimitSeconds}s</span>
            <Button variant="outline" size="sm" onClick={onClearRateLimit} className="border-yellow-500 text-yellow-500 hover:bg-yellow-500/10 h-auto py-0.5">Clear</Button>
           </AlertDescription>
        </Alert>
      )}

      {/* Test result */}
      {testResult && (
        <Alert className={`mb-2 py-2 ${testResult.success ? 'border-green-500 text-green-500' : 'border-destructive text-destructive'}`}>
          <AlertDescription>
            {testResult.success ? (
              <span>
                Connection OK | Balance: {testResult.hasBalance ? 'Yes' : 'No'} | Withdraw:{' '}
                {testResult.hasWithdraw ? 'Yes' : 'No'}
              </span>
            ) : (
              <span>{testResult.error}</span>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

interface AddKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exchanges: ExchangeInfo[];
  onSuccess: () => void;
}

function AddKeyDialog({ open, onOpenChange, exchanges, onSuccess }: AddKeyDialogProps) {
  const [exchange, setExchange] = useState('kraken');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [tier, setTier] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Get selected exchange info
  const selectedExchange = exchanges.find((e) => e.id === exchange);
  const requiresPassphrase = selectedExchange?.requiresPassphrase ?? false;
  const tiers = selectedExchange?.tiers ?? [];

  // Reset tier when exchange changes
  useEffect(() => {
    if (selectedExchange) {
      setTier(selectedExchange.defaultTier);
    }
  }, [exchange, selectedExchange]);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName('');
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      setError('');
      if (exchanges.length > 0) {
        setExchange(exchanges[0].id);
        setTier(exchanges[0].defaultTier);
      }
    }
  }, [open, exchanges]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const body: Record<string, string> = { name, apiKey, apiSecret, tier, exchange };
      if (requiresPassphrase && passphrase) {
        body.passphrase = passphrase;
      }

      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  // Permission requirements by exchange
  const permissionInfo: Record<string, string[]> = {
    kraken: ['Funds: Query', 'Funds: Withdraw', 'Orders & Trades: Query closed orders & trades'],
    gemini: ['Fund Management', 'Trading'],
    kucoin: ['General', 'Trade', 'Transfer'],
    gateio: ['Spot/Margin Trade', 'Wallet'],
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add API Key</DialogTitle>
          <DialogDescription>Add your exchange API credentials. Ensure permissions are set correctly.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Exchange selector */}
          <div className="space-y-2">
            <Label htmlFor="exchange">Exchange</Label>
            <Select value={exchange} onValueChange={setExchange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {exchanges.map((ex) => (
                  <SelectItem key={ex.id} value={ex.id}>
                    {ex.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Permission info based on selected exchange */}
          <Alert className="bg-yellow-500/10 border-yellow-500/50 text-yellow-500">
            <Info className="h-4 w-4" />
            <AlertTitle>Required permissions for {selectedExchange?.name || 'Exchange'}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc list-inside mt-1">
                {(permissionInfo[exchange] || ['Check exchange documentation']).map((perm, i) => (
                  <li key={i}>{perm}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="key-name">Key Name</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Main Key, Backup Key"
              required
            />
          </div>

          {/* Tier selector - dynamic based on exchange */}
          {tiers.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="tier">Tier / Rate Limit Level</Label>
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tiers.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label} ({t.maxCounter} max, -{t.decayRate}/sec)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Match this to your account verification level.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="api-key">API Key</Label>
            <Input
              id="api-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono"
              placeholder={`Enter your ${selectedExchange?.name || 'exchange'} API key`}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="api-secret">API Secret</Label>
            <Input
              id="api-secret"
              type="password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              className="font-mono"
              placeholder={`Enter your ${selectedExchange?.name || 'exchange'} API secret`}
              required
            />
          </div>

          {/* Passphrase field for exchanges that require it */}
          {requiresPassphrase && (
            <div className="space-y-2">
              <Label htmlFor="passphrase">Passphrase</Label>
              <Input
                id="passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="font-mono"
                placeholder="Enter your API passphrase"
                required
              />
              <p className="text-xs text-muted-foreground">
                {selectedExchange?.name} requires a passphrase for API authentication.
              </p>
            </div>
          )}

          {error && <div className="text-destructive text-sm">{error}</div>}

          <DialogFooter className="pt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Adding...' : 'Add Key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

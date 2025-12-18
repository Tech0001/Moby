import { useState, useEffect } from 'react';
import {
  Wallet,
  RefreshCw,
  AlertCircle,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  Coins,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { cn } from '@/ui/lib/utils';
import { useDocumentVisibility } from '@/ui/lib/useDocumentVisibility';

interface Balance {
  [asset: string]: string;
}

interface BalancePanelProps {
  exchange?: string;
}

// Assets to show prominently (common trading assets)
const PRIORITY_ASSETS = ['USD', 'ZUSD', 'EUR', 'ZEUR', 'BTC', 'XXBT', 'ETH', 'XETH', 'SOL', 'XRP', 'ADA', 'DOT', 'MATIC', 'AVAX', 'ATOM', 'LINK', 'UNI', 'LTC', 'BCH', 'XLM', 'USDT', 'USDC'];

// Normalize asset names (Kraken uses X/Z prefixes)
function normalizeAsset(asset: string): string {
  // Remove common Kraken prefixes
  if (asset.startsWith('X') && asset.length === 4 && !['XETH', 'XRP', 'XLM', 'LTC', 'BCH'].includes(asset)) {
    return asset.slice(1);
  }
  if (asset.startsWith('Z') && asset.length === 4) {
    return asset.slice(1);
  }
  // Map Kraken names to common names
  const mappings: Record<string, string> = {
    'XXBT': 'BTC',
    'XETH': 'ETH',
    'XXRP': 'XRP',
    'XXLM': 'XLM',
    'XLTC': 'LTC',
    'ZUSD': 'USD',
    'ZEUR': 'EUR',
    'ZGBP': 'GBP',
    'XBT': 'BTC',
  };
  return mappings[asset] || asset;
}

function getAssetColor(asset: string) {
  const normalized = normalizeAsset(asset);
  // Simple deterministic color generation
  const colors = [
    'text-blue-500 bg-blue-500/10',
    'text-orange-500 bg-orange-500/10',
    'text-green-500 bg-green-500/10',
    'text-purple-500 bg-purple-500/10',
    'text-pink-500 bg-pink-500/10',
    'text-indigo-500 bg-indigo-500/10',
    'text-yellow-500 bg-yellow-500/10',
    'text-cyan-500 bg-cyan-500/10',
  ];
  
  // Specific overrides
  if (['BTC', 'XBT'].includes(normalized)) return 'text-orange-500 bg-orange-500/10';
  if (['ETH'].includes(normalized)) return 'text-indigo-500 bg-indigo-500/10';
  if (['USD', 'USDT', 'USDC'].includes(normalized)) return 'text-green-500 bg-green-500/10';
  if (['SOL'].includes(normalized)) return 'text-purple-500 bg-purple-500/10';
  
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function BalancePanel({ exchange = 'kraken' }: BalancePanelProps) {
  const isVisible = useDocumentVisibility();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function fetchBalance() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/balance?exchange=${exchange}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch balance');
      }
      const data = await res.json();
      setBalance(data.balance);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBalance();
  }, [exchange]);

  useEffect(() => {
    if (!isVisible) return;
    const interval = setInterval(fetchBalance, 60000);
    return () => clearInterval(interval);
  }, [exchange, isVisible]);

  // Filter out zero/dust balances and sort
  const nonZeroBalances = balance
    ? Object.entries(balance)
        .filter(([_, value]) => parseFloat(value) > 0.00001)
        .sort((a, b) => {
          // Priority assets first
          const aPriority = PRIORITY_ASSETS.indexOf(a[0]);
          const bPriority = PRIORITY_ASSETS.indexOf(b[0]);
          if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
          if (aPriority !== -1) return -1;
          if (bPriority !== -1) return 1;
          // Then by value (assumes USD-ish value, rough sort)
          return parseFloat(b[1]) - parseFloat(a[1]);
        })
    : [];

  // Split into staked/locked and regular balances
  const stakedBalances = nonZeroBalances.filter(([asset]) =>
    asset.endsWith('.S') || asset.endsWith('.M') || asset.endsWith('.B') || asset.endsWith('.F') || asset.endsWith('.T')
  );
  const regularBalances = nonZeroBalances.filter(([asset]) =>
    !asset.endsWith('.S') && !asset.endsWith('.M') && !asset.endsWith('.B') && !asset.endsWith('.F') && !asset.endsWith('.T')
  );

  // Show top 8 by default
  const visibleRegular = showAll ? regularBalances : regularBalances.slice(0, 8);
  const hasMoreRegular = regularBalances.length > 8;

  function formatAmount(amount: string): React.ReactNode {
    const num = parseFloat(amount);
    let formatted = '';
    
    if (num >= 1000000) formatted = num.toLocaleString(undefined, { maximumFractionDigits: 0 });
    else if (num >= 1000) formatted = num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    else if (num >= 1) formatted = num.toLocaleString(undefined, { maximumFractionDigits: 4 });
    else if (num >= 0.001) formatted = num.toLocaleString(undefined, { maximumFractionDigits: 6 });
    else formatted = num.toLocaleString(undefined, { maximumFractionDigits: 8 });

    // Split for styling decimals differently if desired, currently just returning text
    return formatted;
  }

  if (error) {
    return (
      <Card className="border-destructive/50 shadow-sm">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-destructive">
              <div className="p-2 bg-destructive/10 rounded-full">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <p className="font-semibold">Unable to fetch balance</p>
                <p className="text-sm opacity-90">{error}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={fetchBalance} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-sm border-muted transition-all duration-200 hover:shadow-md">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Wallet className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg font-bold">Account Balance</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
               {exchange.charAt(0).toUpperCase() + exchange.slice(1)} Portfolio
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground hidden sm:inline-block">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchBalance}
            disabled={loading}
            title="Refresh Balance"
            className="h-8 w-8"
          >
            <RefreshCw className={cn("w-4 h-4 text-muted-foreground", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading && !balance ? (
          <div className="py-8 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <RefreshCw className="w-8 h-8 animate-spin text-primary/50" />
            <p className="text-sm">Syncing balances...</p>
          </div>
        ) : nonZeroBalances.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground border-2 border-dashed rounded-lg bg-muted/20">
            <Coins className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="font-medium">No active balances</p>
            <p className="text-xs mt-1">Your portfolio is currently empty</p>
          </div>
        ) : (
          <>
            {/* Regular balances */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {visibleRegular.map(([asset, amount]) => {
                  const normalized = normalizeAsset(asset);
                  const colorClass = getAssetColor(asset);
                  
                  return (
                    <div
                      key={asset}
                      className="group flex flex-col p-3 rounded-xl border bg-card hover:bg-muted/30 hover:border-primary/20 transition-all duration-200"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <div className={cn("w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ring-1 ring-inset ring-black/5 dark:ring-white/10", colorClass)}>
                          {normalized.slice(0, 3)}
                        </div>
                        <span className="font-semibold text-sm truncate">{normalized}</span>
                      </div>
                      <div className="mt-auto">
                        <span className="font-mono text-lg font-medium tracking-tight tabular-nums block truncate" title={amount}>
                          {formatAmount(amount)}
                        </span>
                        <div className="h-1 w-0 group-hover:w-full bg-primary/20 rounded-full transition-all duration-300 mt-2" />
                      </div>
                    </div>
                  );
                })}
              </div>

              {hasMoreRegular && (
                <Button
                  variant="ghost"
                  onClick={() => setShowAll(!showAll)}
                  className="w-full text-muted-foreground hover:text-primary transition-colors h-9"
                >
                  {showAll ? (
                    <>
                      <ChevronDown className="w-4 h-4 mr-2" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronRight className="w-4 h-4 mr-2" />
                      Show {regularBalances.length - 8} more assets
                    </>
                  )}
                </Button>
              )}
            </div>

            {/* Staked/Locked balances */}
            {stakedBalances.length > 0 && (
              <div className="pt-2">
                <div className="flex items-center gap-2 mb-3 px-1">
                  <div className="p-1 rounded bg-secondary text-secondary-foreground">
                    <TrendingUp className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-sm font-medium text-foreground/80">Staked & Earning</span>
                  <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                    {stakedBalances.length}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {stakedBalances.map(([asset, amount]) => (
                    <div
                      key={asset}
                      className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/10 hover:bg-muted/30 transition-colors"
                    >
                      <span className="text-xs font-medium text-muted-foreground">{asset}</span>
                      <span className="font-mono text-xs tabular-nums font-medium">{formatAmount(amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

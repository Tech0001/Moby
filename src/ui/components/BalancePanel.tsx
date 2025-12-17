import { useState, useEffect } from 'react';
import {
  Wallet,
  RefreshCw,
  AlertCircle,
  TrendingUp,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent } from '@/ui/components/ui/card';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';

interface Balance {
  [asset: string]: string;
}

interface BalancePanelProps {
  exchange?: string;
}

// Assets to show prominently (common trading assets)
const PRIORITY_ASSETS = ['USD', 'ZUSD', 'EUR', 'ZEUR', 'BTC', 'XXBT', 'ETH', 'XETH', 'SOL', 'XRP', 'ADA', 'DOT', 'MATIC', 'AVAX', 'ATOM', 'LINK', 'UNI', 'LTC', 'BCH', 'XLM'];

// Normalize asset names (Kraken uses X/Z prefixes)
function normalizeAsset(asset: string): string {
  // Remove common Kraken prefixes
  if (asset.startsWith('X') && asset.length === 4 && !['XETH'].includes(asset)) {
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
  };
  return mappings[asset] || asset;
}

export function BalancePanel({ exchange = 'kraken' }: BalancePanelProps) {
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
    // Refresh balance every 60 seconds
    const interval = setInterval(fetchBalance, 60000);
    return () => clearInterval(interval);
  }, [exchange]);

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

  function formatAmount(amount: string): string {
    const num = parseFloat(amount);
    if (num >= 1000000) return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (num >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (num >= 0.001) return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
    return num.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  if (error) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="w-4 h-4" />
              <span className="text-sm">{error}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={fetchBalance}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Wallet className="w-5 h-5 text-primary" />
          Account Balance
        </h2>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchBalance}
            disabled={loading}
            title="Refresh Balance"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {loading && !balance ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin" />
            Loading balances...
          </CardContent>
        </Card>
      ) : nonZeroBalances.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-6 text-center text-muted-foreground">
            No balances found
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Regular balances */}
          <Card>
            <CardContent className="p-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {visibleRegular.map(([asset, amount]) => (
                  <div
                    key={asset}
                    className="flex items-center justify-between p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs">
                        {normalizeAsset(asset).slice(0, 3)}
                      </div>
                      <span className="font-medium text-sm">{normalizeAsset(asset)}</span>
                    </div>
                    <span className="font-mono text-sm text-right">{formatAmount(amount)}</span>
                  </div>
                ))}
              </div>

              {hasMoreRegular && (
                <button
                  onClick={() => setShowAll(!showAll)}
                  className="mt-3 w-full flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
                >
                  {showAll ? (
                    <>
                      <ChevronDown className="w-4 h-4" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronRight className="w-4 h-4" />
                      Show {regularBalances.length - 8} more assets
                    </>
                  )}
                </button>
              )}
            </CardContent>
          </Card>

          {/* Staked/Locked balances */}
          {stakedBalances.length > 0 && (
            <Card className="border-dashed">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground">Staked & Earning</span>
                  <Badge variant="outline" className="text-[10px]">
                    {stakedBalances.length}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {stakedBalances.map(([asset, amount]) => (
                    <div
                      key={asset}
                      className="flex items-center justify-between p-2 rounded-lg bg-muted/30"
                    >
                      <span className="text-xs text-muted-foreground">{asset}</span>
                      <span className="font-mono text-xs">{formatAmount(amount)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}

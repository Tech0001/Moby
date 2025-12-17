import { useState } from 'react';
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Wallet,
  Activity,
  RefreshCw,
  Timer,
  ChevronDown,
  ChevronRight,
  Zap,
  TrendingUp,
  Hourglass
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Progress } from '@/ui/components/ui/progress';

interface Asset {
  exchange: string;
  asset: string;
  enabled: boolean;
  threshold: number;
  pendingAmount: number;
  rrIndex: number;
  lastWithdrawAt: number | null;
  consecutiveFailures: number;
  backoffUntil: number | null;
}

interface Job {
  id: string;
  asset: string;
  amount: number;
  status: string;
  destKey: string;
  createdAt: number;
  exchangeRef?: string;
  txid?: string;
}

interface Status {
  enabled: boolean;
  hasApiKeys: boolean;
  assets: Asset[];
  activeJobs: Job[];
}

interface StatusPanelProps {
  status: Status | null;
  onRefresh: () => void;
}

export function StatusPanel({ status, onRefresh }: StatusPanelProps) {
  if (!status) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Activity className="w-12 h-12 mb-4 opacity-20" />
        <p>No status data available</p>
      </div>
    );
  }

  function formatTime(timestamp: number | null): string {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

  function formatAmount(amount: number): string {
    if (amount >= 1) return amount.toFixed(4);
    if (amount >= 0.001) return amount.toFixed(6);
    return amount.toFixed(8);
  }

  function getStatusIcon(status: string) {
    switch (status.toLowerCase()) {
      case 'complete':
      case 'success':
      case 'settled':
        return <CheckCircle2 className="w-3.5 h-3.5 mr-1" />;
      case 'failed':
      case 'failure':
        return <XCircle className="w-3.5 h-3.5 mr-1" />;
      case 'held':
        return <AlertTriangle className="w-3.5 h-3.5 mr-1" />;
      default:
        return <Clock className="w-3.5 h-3.5 mr-1" />;
    }
  }

  function getBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
    switch (status.toLowerCase()) {
      case 'complete':
      case 'success':
      case 'settled':
        return 'default'; // Or a specific success variant if added
      case 'failed':
      case 'failure':
        return 'destructive';
      case 'held':
        return 'destructive'; // Warning often maps to destructive or secondary
      default:
        return 'secondary';
    }
  }
  
  // Custom color classes can still be applied via className if variants aren't enough
  const statusClasses: Record<string, string> = {
    submitted: 'text-blue-500 bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/20',
    pending: 'text-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/20',
    complete: 'text-green-500 bg-green-500/10 hover:bg-green-500/20 border-green-500/20',
    failed: 'text-red-500 bg-red-500/10 hover:bg-red-500/20 border-red-500/20',
    held: 'text-orange-500 bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/20',
    cancelled: 'text-muted-foreground bg-muted hover:bg-muted/80',
  };

  return (
    <div className="space-y-6">
      {/* Active Jobs */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Active Withdrawals
          </h2>
        </div>

        {status.activeJobs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-8 text-center text-muted-foreground">
              No withdrawals in progress
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {status.activeJobs.map((job) => (
              <Card key={job.id} className="transition-colors hover:border-primary/50">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                        {job.asset[0]}
                      </div>
                      <div>
                        <h3 className="font-medium">{job.asset} Withdrawal</h3>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(job.createdAt)}
                        </div>
                      </div>
                    </div>
                    <Badge variant="outline" className={`font-medium ${statusClasses[job.status] || ''}`}>
                      {getStatusIcon(job.status)}
                      <span className="capitalize">{job.status}</span>
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm mb-3">
                    <div>
                      <div className="text-muted-foreground text-xs mb-0.5">Amount</div>
                      <div className="font-mono">{formatAmount(job.amount)} {job.asset}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs mb-0.5">Destination</div>
                      <div className="font-mono text-muted-foreground truncate" title={job.destKey}>
                        {job.destKey}
                      </div>
                    </div>
                  </div>

                  {(job.exchangeRef || job.txid) && (
                    <div className="pt-3 border-t text-xs space-y-1">
                      {job.exchangeRef && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ref ID:</span>
                          <span className="font-mono">{job.exchangeRef}</span>
                        </div>
                      )}
                      {job.txid && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">TXID:</span>
                          <span className="font-mono text-primary truncate ml-2 max-w-[200px]" title={job.txid}>
                            {job.txid}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Asset Status - Split by State */}
      <AssetStatusSection
        assets={status.assets}
        onRefresh={onRefresh}
        formatAmount={formatAmount}
        formatTime={formatTime}
      />
    </div>
  );
}

interface AssetStatusSectionProps {
  assets: Asset[];
  onRefresh: () => void;
  formatAmount: (amount: number) => string;
  formatTime: (timestamp: number | null) => string;
}

function AssetStatusSection({ assets, onRefresh, formatAmount, formatTime }: AssetStatusSectionProps) {
  const [waitingExpanded, setWaitingExpanded] = useState(false);

  // Split assets by state
  const readyToSweep = assets.filter(a => a.enabled && a.pendingAmount >= a.threshold);
  const accumulating = assets.filter(a => a.enabled && a.pendingAmount > 0 && a.pendingAmount < a.threshold);
  const waiting = assets.filter(a => a.enabled && a.pendingAmount === 0);
  const disabled = assets.filter(a => !a.enabled);

  if (assets.length === 0) {
    return (
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Wallet className="w-5 h-5 text-primary" />
            Asset Status
          </h2>
        </div>
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No assets configured for sweeping
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Wallet className="w-5 h-5 text-primary" />
          Asset Status
        </h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          title="Refresh Status"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      {/* Ready to Sweep - Most prominent */}
      {readyToSweep.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-2 text-green-500">
            <Zap className="w-4 h-4" />
            Ready to Sweep ({readyToSweep.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {readyToSweep.map((asset) => (
              <AssetCard
                key={`${asset.exchange}:${asset.asset}`}
                asset={asset}
                variant="ready"
                formatAmount={formatAmount}
                formatTime={formatTime}
              />
            ))}
          </div>
        </div>
      )}

      {/* Accumulating - Shows progress */}
      {accumulating.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-2 text-blue-500">
            <TrendingUp className="w-4 h-4" />
            Accumulating ({accumulating.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {accumulating.map((asset) => (
              <AssetCard
                key={`${asset.exchange}:${asset.asset}`}
                asset={asset}
                variant="accumulating"
                formatAmount={formatAmount}
                formatTime={formatTime}
              />
            ))}
          </div>
        </div>
      )}

      {/* Waiting - Collapsible */}
      {waiting.length > 0 && (
        <div className="space-y-3">
          <button
            onClick={() => setWaitingExpanded(!waitingExpanded)}
            className="text-sm font-medium flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {waitingExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <Hourglass className="w-4 h-4" />
            Waiting for Fills ({waiting.length})
          </button>
          {waitingExpanded && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {waiting.map((asset) => (
                <AssetCardCompact
                  key={`${asset.exchange}:${asset.asset}`}
                  asset={asset}
                  formatAmount={formatAmount}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Disabled - Always collapsed style */}
      {disabled.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {disabled.length} disabled asset{disabled.length > 1 ? 's' : ''}: {disabled.map(a => a.asset).join(', ')}
        </div>
      )}
    </section>
  );
}

interface AssetCardProps {
  asset: Asset;
  variant: 'ready' | 'accumulating';
  formatAmount: (amount: number) => string;
  formatTime: (timestamp: number | null) => string;
}

function AssetCard({ asset, variant, formatAmount, formatTime }: AssetCardProps) {
  const progress = asset.threshold > 0 ? (asset.pendingAmount / asset.threshold) * 100 : 0;
  const isReady = variant === 'ready';

  return (
    <Card className={isReady ? 'border-green-500/50 bg-green-500/5' : ''}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg">{asset.asset}</span>
            <Badge variant="outline" className="text-[10px] uppercase">
              {asset.exchange}
            </Badge>
            {asset.consecutiveFailures > 0 && (
              <Badge variant="destructive" className="flex items-center gap-1 text-[10px]">
                <AlertTriangle className="w-3 h-3" />
                {asset.consecutiveFailures}
              </Badge>
            )}
          </div>
          {isReady && (
            <Badge className="bg-green-500 text-white text-[10px]">
              <Zap className="w-3 h-3 mr-1" />
              Ready
            </Badge>
          )}
        </div>

        {/* Progress bar */}
        <div className="space-y-1 mb-3">
          <div className="flex justify-between text-xs">
            <span className="font-mono text-primary">{formatAmount(asset.pendingAmount)}</span>
            <span className="text-muted-foreground">/ {formatAmount(asset.threshold)} {asset.asset}</span>
          </div>
          <Progress value={Math.min(progress, 100)} className="h-2" />
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Wallet className="w-3 h-3" />
            Wallet #{asset.rrIndex + 1}
          </div>
          <div className="flex items-center gap-1 text-muted-foreground justify-end">
            <Timer className="w-3 h-3" />
            {asset.lastWithdrawAt ? formatTime(asset.lastWithdrawAt) : 'Never'}
          </div>
        </div>

        {asset.backoffUntil && asset.backoffUntil > Date.now() && (
          <div className="mt-2 p-2 rounded bg-yellow-500/10 text-yellow-500 text-xs flex items-center justify-center gap-2 border border-yellow-500/20">
            <Clock className="w-3 h-3" />
            Paused until {formatTime(asset.backoffUntil)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface AssetCardCompactProps {
  asset: Asset;
  formatAmount: (amount: number) => string;
}

function AssetCardCompact({ asset, formatAmount }: AssetCardCompactProps) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-medium">{asset.asset}</span>
            <Badge variant="outline" className="text-[10px] uppercase">
              {asset.exchange}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            0 / {formatAmount(asset.threshold)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

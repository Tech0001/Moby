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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/ui/table";
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

  const sortedAssets = [...assets].sort((a, b) => {
    const getScore = (asset: Asset) => {
      if (!asset.enabled) return 0;
      if (asset.pendingAmount >= asset.threshold) return 3;
      if (asset.pendingAmount > 0) return 2;
      return 1;
    };
    // Primary sort: Status score (desc)
    const scoreDiff = getScore(b) - getScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    // Secondary sort: Asset name (asc)
    return a.asset.localeCompare(b.asset);
  });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Wallet className="w-5 h-5 text-primary" />
            Sweep Monitor
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configured assets accumulating toward automatic withdrawal
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          title="Refresh Status"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asset</TableHead>
              <TableHead>Exchange</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Accumulated</TableHead>
              <TableHead>Next Wallet</TableHead>
              <TableHead className="text-right">Last Sweep</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedAssets.map((asset) => {
              const progress = asset.threshold > 0 ? (asset.pendingAmount / asset.threshold) * 100 : 0;
              let statusNode;
              if (!asset.enabled) {
                 statusNode = <Badge variant="secondary" className="opacity-50">Disabled</Badge>;
              } else if (asset.pendingAmount >= asset.threshold) {
                 statusNode = <Badge className="bg-green-500 hover:bg-green-600 text-white"><Zap className="w-3 h-3 mr-1" />Ready</Badge>;
              } else if (asset.pendingAmount > 0) {
                 statusNode = <Badge variant="outline" className="text-blue-500 border-blue-500/30">Accumulating</Badge>;
              } else {
                 statusNode = <Badge variant="outline" className="text-muted-foreground">Waiting</Badge>;
              }

              return (
                <TableRow key={`${asset.exchange}:${asset.asset}`}>
                  <TableCell className="font-medium">
                     <div className="flex items-center gap-2">
                        {asset.asset}
                        {asset.consecutiveFailures > 0 && (
                          <Badge variant="destructive" className="flex items-center gap-1 text-[10px] h-5 px-1">
                            <AlertTriangle className="w-3 h-3" />
                            {asset.consecutiveFailures}
                          </Badge>
                        )}
                        {asset.backoffUntil && asset.backoffUntil > Date.now() && (
                           <span title={`Paused until ${formatTime(asset.backoffUntil)}`}>
                           <Timer className="w-4 h-4 text-yellow-500" />
                        </span>
                        )}
                     </div>
                  </TableCell>
                  <TableCell>
                     <Badge variant="secondary" className="font-normal text-xs">{asset.exchange}</Badge>
                  </TableCell>
                  <TableCell>{statusNode}</TableCell>
                  <TableCell>
                    <div className="w-[120px] space-y-1">
                      <Progress value={Math.min(progress, 100)} className="h-1.5" />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>{formatAmount(asset.pendingAmount)}</span>
                        <span>/ {formatAmount(asset.threshold)}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">#{asset.rrIndex + 1}</TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs">
                    {formatTime(asset.lastWithdrawAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}


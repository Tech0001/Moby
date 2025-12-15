import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Wallet,
  Activity,
  ArrowRight,
  RefreshCw,
  Timer
} from 'lucide-react';

interface Asset {
  asset: string;
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
  krakenRef?: string;
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
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
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
        return <CheckCircle2 className="w-4 h-4 text-green-400" />;
      case 'failed':
      case 'failure':
        return <XCircle className="w-4 h-4 text-red-400" />;
      case 'held':
        return <AlertTriangle className="w-4 h-4 text-orange-400" />;
      default:
        return <Clock className="w-4 h-4 text-blue-400" />;
    }
  }

  const statusColors: Record<string, string> = {
    submitted: 'text-blue-400 bg-blue-400/10',
    pending: 'text-yellow-400 bg-yellow-400/10',
    complete: 'text-green-400 bg-green-400/10',
    failed: 'text-red-400 bg-red-400/10',
    held: 'text-orange-400 bg-orange-400/10',
    cancelled: 'text-gray-400 bg-gray-400/10',
  };

  return (
    <div className="space-y-6">
      {/* Active Jobs */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-indigo-400" />
            Active Withdrawals
          </h2>
        </div>

        {status.activeJobs.length === 0 ? (
          <div className="bg-gray-900/50 rounded-lg border border-gray-800 border-dashed p-8 text-center text-gray-500">
            No withdrawals in progress
          </div>
        ) : (
          <div className="grid gap-4">
            {status.activeJobs.map((job) => (
              <div
                key={job.id}
                className="bg-gray-900 rounded-lg border border-gray-800 p-4 shadow-sm hover:border-gray-700 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400 font-bold">
                      {job.asset[0]}
                    </div>
                    <div>
                      <h3 className="font-medium text-white">{job.asset} Withdrawal</h3>
                      <div className="text-xs text-gray-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(job.createdAt)}
                      </div>
                    </div>
                  </div>
                  <div className={`px-2.5 py-0.5 rounded-full text-xs font-medium flex items-center gap-1.5 ${statusColors[job.status] || 'text-gray-400 bg-gray-800'}`}>
                    {getStatusIcon(job.status)}
                    <span className="capitalize">{job.status}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-3">
                  <div>
                    <div className="text-gray-500 text-xs mb-0.5">Amount</div>
                    <div className="font-mono text-white">{formatAmount(job.amount)} {job.asset}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs mb-0.5">Destination</div>
                    <div className="font-mono text-gray-300 truncate" title={job.destKey}>
                      {job.destKey}
                    </div>
                  </div>
                </div>

                {(job.krakenRef || job.txid) && (
                  <div className="pt-3 border-t border-gray-800 text-xs space-y-1">
                    {job.krakenRef && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Ref ID:</span>
                        <span className="font-mono text-gray-400">{job.krakenRef}</span>
                      </div>
                    )}
                    {job.txid && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">TXID:</span>
                        <span className="font-mono text-blue-400 truncate ml-2 max-w-[200px]" title={job.txid}>
                          {job.txid}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending Sweeps */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Wallet className="w-5 h-5 text-emerald-400" />
            Asset Status
          </h2>
          <button
            onClick={onRefresh}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all"
            title="Refresh Status"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {status.assets.length === 0 ? (
          <div className="p-8 text-center text-gray-500 bg-gray-900 rounded-lg border border-gray-800">
            No assets configured for sweeping
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {status.assets.map((asset) => (
              <div key={asset.asset} className="bg-gray-900 rounded-lg border border-gray-800 p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-lg">{asset.asset}</span>
                    {asset.consecutiveFailures > 0 && (
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {asset.consecutiveFailures} errors
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Pending Amount</div>
                    <div className="font-mono text-lg text-emerald-400">
                      {formatAmount(asset.pendingAmount)}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm p-2 rounded bg-gray-950/50">
                    <span className="text-gray-500 flex items-center gap-1.5">
                      <Wallet className="w-3.5 h-3.5" />
                      Next Wallet
                    </span>
                    <span className="text-gray-300 font-mono">Index #{asset.rrIndex + 1}</span>
                  </div>

                  <div className="flex items-center justify-between text-sm p-2 rounded bg-gray-950/50">
                    <span className="text-gray-500 flex items-center gap-1.5">
                      <Timer className="w-3.5 h-3.5" />
                      Last Sweep
                    </span>
                    <span className="text-gray-300 text-xs">{formatTime(asset.lastWithdrawAt)}</span>
                  </div>

                  {asset.backoffUntil && asset.backoffUntil > Date.now() && (
                    <div className="mt-2 p-2 rounded bg-yellow-500/10 text-yellow-400 text-xs flex items-center justify-center gap-2">
                      <Clock className="w-3 h-3" />
                      Paused until {formatTime(asset.backoffUntil)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

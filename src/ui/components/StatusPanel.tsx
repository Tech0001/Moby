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
    return <div className="text-gray-400">No status data</div>;
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

  const statusColors: Record<string, string> = {
    submitted: 'text-blue-400',
    pending: 'text-yellow-400',
    complete: 'text-green-400',
    failed: 'text-red-400',
    held: 'text-orange-400',
  };

  return (
    <div className="space-y-6">
      {/* Pending Assets */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-white">Pending Sweeps</h2>
          <button
            onClick={onRefresh}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Refresh
          </button>
        </div>

        {status.assets.length === 0 ? (
          <div className="p-4 text-gray-400 text-center">
            No pending assets to sweep
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {status.assets.map((asset) => (
              <div key={asset.asset} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-white">{asset.asset}</span>
                  <span className="text-lg font-mono text-white">
                    {formatAmount(asset.pendingAmount)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-400">
                  <span>Wallet #{asset.rrIndex + 1}</span>
                  <span>Last: {formatTime(asset.lastWithdrawAt)}</span>
                  {asset.consecutiveFailures > 0 && (
                    <span className="text-red-400">
                      {asset.consecutiveFailures} failures
                    </span>
                  )}
                  {asset.backoffUntil && asset.backoffUntil > Date.now() && (
                    <span className="text-yellow-400">
                      Backoff until {formatTime(asset.backoffUntil)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active Jobs */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="font-semibold text-white">Active Withdrawals</h2>
        </div>

        {status.activeJobs.length === 0 ? (
          <div className="p-4 text-gray-400 text-center">
            No active withdrawals
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {status.activeJobs.map((job) => (
              <div key={job.id} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-white">{job.asset}</span>
                    <span className={`text-sm ${statusColors[job.status] || 'text-gray-400'}`}>
                      {job.status}
                    </span>
                  </div>
                  <span className="font-mono text-white">
                    {formatAmount(job.amount)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-400">
                  <span>To: {job.destKey}</span>
                  <span>Started: {formatTime(job.createdAt)}</span>
                  {job.krakenRef && <span>Ref: {job.krakenRef}</span>}
                </div>
                {job.txid && (
                  <div className="mt-2 text-sm">
                    <span className="text-gray-400">TXID: </span>
                    <span className="text-blue-400 font-mono text-xs">
                      {job.txid.slice(0, 16)}...
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

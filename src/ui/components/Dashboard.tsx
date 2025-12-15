import { useState, useEffect } from 'react';
import { Switch } from '@radix-ui/react-switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@radix-ui/react-tabs';
import {
  LayoutDashboard,
  List,
  Key,
  Settings,
  LogOut,
  Play,
  Square,
  Waves,
  AlertCircle
} from 'lucide-react';
import { ApiKeysPanel } from './ApiKeysPanel';
import { StatusPanel } from './StatusPanel';
import { ConfigPanel } from './ConfigPanel';
import { OrdersPanel } from './OrdersPanel';

interface DashboardProps {
  user: { userId: string; username: string };
  onLogout: () => void;
}

interface Status {
  enabled: boolean;
  hasApiKeys: boolean;
  assets: Array<{
    asset: string;
    pendingAmount: number;
    rrIndex: number;
    lastWithdrawAt: number | null;
    consecutiveFailures: number;
    backoffUntil: number | null;
  }>;
  activeJobs: Array<{
    id: string;
    asset: string;
    amount: number;
    status: string;
    destKey: string;
    createdAt: number;
    krakenRef?: string;
    txid?: string;
  }>;
}

export function Dashboard({ user, onLogout }: DashboardProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem('activeTab');
    return ['status', 'orders', 'api-keys', 'config'].includes(saved || '') ? saved! : 'status';
  });

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (error) {
      console.error('Failed to fetch status:', error);
    } finally {
      setLoading(false);
    }
  }

  async function toggleEnabled() {
    if (!status) return;
    setToggling(true);

    try {
      const endpoint = status.enabled ? '/api/control/stop' : '/api/control/start';
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setStatus({ ...status, enabled: data.enabled });
      }
    } catch (error) {
      console.error('Failed to toggle:', error);
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Waves className="w-12 h-12 text-indigo-500 animate-pulse" />
          <div className="text-gray-400">Loading Moby...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Waves className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">Moby</h1>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
              <span className="text-gray-400">System Operational</span>
            </div>
            <div className="h-4 w-px bg-gray-800"></div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-300">{user.username}</span>
              <button
                onClick={onLogout}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all"
                title="Sign out"
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Control bar */}
        <div className="bg-gradient-to-br from-gray-900 to-gray-900/50 rounded-xl border border-gray-800 p-6 mb-8 shadow-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-4">
                <Switch
                  checked={status?.enabled ?? false}
                  onCheckedChange={toggleEnabled}
                  disabled={toggling || !status?.hasApiKeys}
                  className="w-14 h-8 bg-gray-800 rounded-full relative data-[state=checked]:bg-green-500 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed border border-gray-700 data-[state=checked]:border-green-400"
                >
                  <span className="block w-6 h-6 bg-white rounded-full shadow-lg absolute left-1 top-1 transition-transform data-[state=checked]:translate-x-6 flex items-center justify-center">
                    {toggling ? (
                      <div className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin"></div>
                    ) : status?.enabled ? (
                      <Play size={12} className="text-green-600 fill-current" />
                    ) : (
                      <Square size={10} className="text-gray-400 fill-current" />
                    )}
                  </span>
                </Switch>
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    {status?.enabled ? 'Sweeper Running' : 'Sweeper Stopped'}
                  </h2>
                  <p className="text-sm text-gray-400">
                    {status?.enabled
                      ? 'Monitoring for fills and sweeping assets'
                      : 'Withdrawals are currently paused'}
                  </p>
                </div>
              </div>

              {!status?.hasApiKeys && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 text-yellow-400 rounded-lg border border-yellow-500/20 text-sm">
                  <AlertCircle size={16} />
                  <span>API keys required</span>
                </div>
              )}
            </div>

            <div className="flex gap-8 px-6 py-2 bg-gray-950/50 rounded-lg border border-gray-800/50">
              <div className="text-center">
                <div className="text-xs text-gray-500 uppercase tracking-wider font-medium mb-1">Active Jobs</div>
                <div className="text-xl font-mono text-white">{status?.activeJobs?.length || 0}</div>
              </div>
              <div className="w-px bg-gray-800"></div>
              <div className="text-center">
                <div className="text-xs text-gray-500 uppercase tracking-wider font-medium mb-1">Pending Assets</div>
                <div className="text-xl font-mono text-white">{status?.assets?.length || 0}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="flex gap-1 bg-gray-900/50 p-1 rounded-xl border border-gray-800 w-fit backdrop-blur-sm">
            <TabsTrigger
              value="status"
              className="px-4 py-2 text-sm font-medium text-gray-400 rounded-lg data-[state=active]:bg-gray-800 data-[state=active]:text-white data-[state=active]:shadow-sm transition-all flex items-center gap-2"
            >
              <LayoutDashboard size={16} />
              Status
            </TabsTrigger>
            <TabsTrigger
              value="orders"
              className="px-4 py-2 text-sm font-medium text-gray-400 rounded-lg data-[state=active]:bg-gray-800 data-[state=active]:text-white data-[state=active]:shadow-sm transition-all flex items-center gap-2"
            >
              <List size={16} />
              Orders
            </TabsTrigger>
            <TabsTrigger
              value="api-keys"
              className="px-4 py-2 text-sm font-medium text-gray-400 rounded-lg data-[state=active]:bg-gray-800 data-[state=active]:text-white data-[state=active]:shadow-sm transition-all flex items-center gap-2"
            >
              <Key size={16} />
              API Keys
            </TabsTrigger>
            <TabsTrigger
              value="config"
              className="px-4 py-2 text-sm font-medium text-gray-400 rounded-lg data-[state=active]:bg-gray-800 data-[state=active]:text-white data-[state=active]:shadow-sm transition-all flex items-center gap-2"
            >
              <Settings size={16} />
              Configuration
            </TabsTrigger>
          </TabsList>

          <TabsContent value="status" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <StatusPanel status={status} onRefresh={fetchStatus} />
          </TabsContent>

          <TabsContent value="orders" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <OrdersPanel />
          </TabsContent>

          <TabsContent value="api-keys" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <ApiKeysPanel hasKeys={status?.hasApiKeys ?? false} onUpdate={fetchStatus} />
          </TabsContent>

          <TabsContent value="config" className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <ConfigPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

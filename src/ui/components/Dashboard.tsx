import { useState, useEffect } from 'react';
import { Switch } from '@radix-ui/react-switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@radix-ui/react-tabs';
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
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-white">Moby</h1>
          <div className="flex items-center gap-4">
            <span className="text-gray-400 text-sm">{user.username}</span>
            <button
              onClick={onLogout}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Control bar */}
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={status?.enabled ?? false}
                  onCheckedChange={toggleEnabled}
                  disabled={toggling || !status?.hasApiKeys}
                  className="w-11 h-6 bg-gray-700 rounded-full relative data-[state=checked]:bg-green-600 transition-colors"
                >
                  <span className="block w-5 h-5 bg-white rounded-full shadow absolute left-0.5 top-0.5 transition-transform data-[state=checked]:translate-x-5" />
                </Switch>
                <span className="text-white font-medium">
                  {status?.enabled ? 'Running' : 'Stopped'}
                </span>
              </div>

              {!status?.hasApiKeys && (
                <span className="text-yellow-500 text-sm">
                  Configure API keys to enable
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  status?.enabled ? 'bg-green-500' : 'bg-gray-500'
                }`}
              />
              <span className="text-sm text-gray-400">
                {status?.activeJobs?.length || 0} active withdrawals
              </span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="status" className="space-y-4">
          <TabsList className="flex gap-1 bg-gray-900 p-1 rounded-lg border border-gray-800 w-fit">
            <TabsTrigger
              value="status"
              className="px-4 py-2 text-sm text-gray-400 rounded-md data-[state=active]:bg-gray-800 data-[state=active]:text-white transition-colors"
            >
              Status
            </TabsTrigger>
            <TabsTrigger
              value="orders"
              className="px-4 py-2 text-sm text-gray-400 rounded-md data-[state=active]:bg-gray-800 data-[state=active]:text-white transition-colors"
            >
              Orders
            </TabsTrigger>
            <TabsTrigger
              value="api-keys"
              className="px-4 py-2 text-sm text-gray-400 rounded-md data-[state=active]:bg-gray-800 data-[state=active]:text-white transition-colors"
            >
              API Keys
            </TabsTrigger>
            <TabsTrigger
              value="config"
              className="px-4 py-2 text-sm text-gray-400 rounded-md data-[state=active]:bg-gray-800 data-[state=active]:text-white transition-colors"
            >
              Configuration
            </TabsTrigger>
          </TabsList>

          <TabsContent value="status">
            <StatusPanel status={status} onRefresh={fetchStatus} />
          </TabsContent>

          <TabsContent value="orders">
            <OrdersPanel />
          </TabsContent>

          <TabsContent value="api-keys">
            <ApiKeysPanel hasKeys={status?.hasApiKeys ?? false} onUpdate={fetchStatus} />
          </TabsContent>

          <TabsContent value="config">
            <ConfigPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

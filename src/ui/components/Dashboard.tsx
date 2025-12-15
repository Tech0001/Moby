import { useState, useEffect } from 'react';
import { Switch } from '@/ui/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import { Card, CardContent } from '@/ui/components/ui/card';
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

import { ModeToggle } from './ModeToggle';
import { ThemeSelector } from './ThemeSelector';

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
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Waves className="w-12 h-12 text-primary animate-pulse" />
          <div className="text-muted-foreground">Loading Moby...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/30">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Waves className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Moby</h1>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-4">
              <ThemeSelector />
              <ModeToggle />
            </div>
            <div className="h-4 w-px bg-border"></div>
            <div className="flex items-center gap-2 text-sm hidden md:flex">
              <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
              <span className="text-muted-foreground">System Operational</span>
            </div>
            <div className="h-4 w-px bg-border hidden md:block"></div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{user.username}</span>
              <button
                onClick={onLogout}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-all"
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
        <Card className="mb-8 bg-gradient-to-br from-card to-card/50">
          <CardContent className="p-6 flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-4">
                <Switch
                  checked={status?.enabled ?? false}
                  onCheckedChange={toggleEnabled}
                  disabled={toggling || !status?.hasApiKeys}
                />
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    {toggling ? (
                       <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    ) : status?.enabled ? (
                      <Play size={16} className="text-green-500 fill-current" />
                    ) : (
                      <Square size={14} className="text-muted-foreground fill-current" />
                    )}
                    {status?.enabled ? 'Sweeper Running' : 'Sweeper Stopped'}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {status?.enabled
                      ? 'Monitoring for fills and sweeping assets'
                      : 'Withdrawals are currently paused'}
                  </p>
                </div>
              </div>

              {!status?.hasApiKeys && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 text-yellow-500 rounded-lg border border-yellow-500/20 text-sm">
                  <AlertCircle size={16} />
                  <span>API keys required</span>
                </div>
              )}
            </div>

            <div className="flex gap-8 px-6 py-2 bg-muted/50 rounded-lg border">
              <div className="text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Active Jobs</div>
                <div className="text-xl font-mono">{status?.activeJobs?.length || 0}</div>
              </div>
              <div className="w-px bg-border"></div>
              <div className="text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Pending Assets</div>
                <div className="text-xl font-mono">{status?.assets?.length || 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="status" className="gap-2">
              <LayoutDashboard size={16} />
              Status
            </TabsTrigger>
            <TabsTrigger value="orders" className="gap-2">
              <List size={16} />
              Orders
            </TabsTrigger>
            <TabsTrigger value="api-keys" className="gap-2">
              <Key size={16} />
              API Keys
            </TabsTrigger>
            <TabsTrigger value="config" className="gap-2">
              <Settings size={16} />
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

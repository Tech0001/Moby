import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/ui/components/ui/card';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  RefreshCw,
  Trash2,
  ArrowDown,
  Pause,
  Play,
} from 'lucide-react';
import { useDocumentVisibility } from '@/ui/lib/useDocumentVisibility';

interface LogEntry {
  id: number;
  timestamp: number;
  level: number;
  levelLabel: string;
  module?: string;
  msg: string;
  data?: Record<string, unknown>;
}

const LEVEL_COLORS: Record<string, string> = {
  trace: 'text-gray-400',
  debug: 'text-gray-500',
  info: 'text-blue-500',
  warn: 'text-yellow-500',
  error: 'text-red-500',
  fatal: 'text-red-600 font-bold',
};

const LEVEL_BG: Record<string, string> = {
  trace: 'bg-gray-500/10',
  debug: 'bg-gray-500/10',
  info: 'bg-blue-500/10',
  warn: 'bg-yellow-500/10',
  error: 'bg-red-500/10',
  fatal: 'bg-red-500/20',
};

const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export function LogsPanel() {
  const isVisible = useDocumentVisibility();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [minLevel, setMinLevel] = useState<string>('debug');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const logsEndRef = useRef<HTMLDivElement>(null);
  const latestIdRef = useRef<number>(0);

  async function fetchLogs(sinceId?: number) {
    try {
      const params = new URLSearchParams();
      params.set('level', LEVEL_VALUES[minLevel]?.toString() || '20');
      if (sinceId) params.set('sinceId', sinceId.toString());
      params.set('limit', '500');

      const res = await fetch(`/api/logs?${params}`);
      if (res.ok) {
        const data = await res.json();

        if (sinceId) {
          // Append new logs
          setLogs(prev => [...prev, ...data.logs].slice(-500));
        } else {
          // Replace all logs
          setLogs(data.logs);
        }

        if (data.logs.length > 0) {
          latestIdRef.current = data.logs[data.logs.length - 1].id;
        }
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLoading(false);
    }
  }

  // Initial fetch
  useEffect(() => {
    fetchLogs();
  }, [minLevel]);

  // Polling for new logs
  useEffect(() => {
    if (paused || !isVisible) return;

    const interval = setInterval(() => {
      fetchLogs(latestIdRef.current);
    }, 2000);

    return () => clearInterval(interval);
  }, [paused, minLevel, isVisible]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      // Avoid smooth scrolling on every update; it can keep the GPU process busy.
      logsEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs, autoScroll]);

  function toggleExpanded(id: number) {
    setExpandedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function clearLogs() {
    setLogs([]);
    latestIdRef.current = 0;
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Select value={minLevel} onValueChange={setMinLevel}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Log level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="trace">Trace</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={paused ? 'default' : 'outline'}
            size="sm"
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play className="w-4 h-4 mr-1" /> : <Pause className="w-4 h-4 mr-1" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>

          <Button
            variant={autoScroll ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
          >
            <ArrowDown className="w-4 h-4 mr-1" />
            Auto-scroll
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {logs.length} entries
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchLogs()}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearLogs}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Log entries */}
      <Card>
        <CardContent className="p-0">
          <div className="h-[600px] overflow-y-auto font-mono text-xs">
            {loading && logs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                Loading logs...
              </div>
            ) : logs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                No logs yet
              </div>
            ) : (
              <div className="divide-y divide-border">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className={`px-3 py-1.5 hover:bg-muted/50 ${LEVEL_BG[log.levelLabel] || ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground shrink-0">
                        {formatTime(log.timestamp)}
                      </span>
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[10px] px-1.5 py-0 uppercase ${LEVEL_COLORS[log.levelLabel] || ''}`}
                      >
                        {log.levelLabel}
                      </Badge>
                      {log.module && (
                        <span className="text-purple-500 shrink-0">
                          [{log.module}]
                        </span>
                      )}
                      <span
                        className={`flex-1 break-all ${LEVEL_COLORS[log.levelLabel] || ''}`}
                        onClick={() => log.data && toggleExpanded(log.id)}
                        style={{ cursor: log.data ? 'pointer' : 'default' }}
                      >
                        {log.msg}
                        {log.data && !expandedIds.has(log.id) && (
                          <span className="text-muted-foreground ml-1">
                            {' '}...
                          </span>
                        )}
                      </span>
                    </div>
                    {log.data && expandedIds.has(log.id) && (
                      <pre className="mt-1 ml-20 p-2 bg-muted rounded text-[10px] overflow-x-auto">
                        {JSON.stringify(log.data, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import { useDocumentVisibility } from '../lib/useDocumentVisibility';
import { Freshness } from './Freshness';
import { apiFetch } from '@/ui/lib/api';
import { useState, useEffect, useRef } from 'react';
import { RefreshCw, ArrowDownLeft, ArrowUpRight, Clock, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/ui/table';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { parsePair } from '../../server/domain/types';

interface Fill {
  tradeId: string;
  orderId: string;
  pair: string;
  side: 'buy' | 'sell';
  orderType: string;
  price: number;
  volume: number;
  cost: number;
  fee: number;
  feeCurrency: string;
  timestamp: number;
  exchange?: string;
}

interface OpenOrder {
  orderId: string;
  exchange: string;
  pair: string;
  type: 'buy' | 'sell';
  orderType: string;
  price: string;
  volume: string;
  volumeExecuted: string;
  status: string;
  openTime: number;
  description: string;
}

interface ExchangeWithKeys {
  id: string;
  name: string;
  hasKeys: boolean;
}

export function OrdersPanel() {
  const [fills, setFills] = useState<Fill[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exchanges, setExchanges] = useState<ExchangeWithKeys[]>([]);
  const [selectedExchange, setSelectedExchange] = useState<string>('all');
  const request = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const visible = useDocumentVisibility();

  useEffect(() => { void fetchExchanges(); }, []);
  useEffect(() => {
    const online = () => setRefresh(v => v + 1); window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await fetchData(false, selectedExchange); if (!stopped) timer = setTimeout(tick, 15000); };
    void tick();
    return () => { stopped = true; clearTimeout(timer); request.current?.abort(); request.current = null; };
  }, [visible, selectedExchange, refresh]);

  async function fetchExchanges() {
    try {
      // Fetch available exchanges
      const [exchangesRes, keysRes] = await Promise.all([
        apiFetch('/api/exchanges/available'),
        apiFetch('/api/keys')
      ]);

      if (exchangesRes.ok && keysRes.ok) {
        const exchangesData = await exchangesRes.json();
        const keysData = await keysRes.json();

        // Create set of exchanges that have keys
        const exchangesWithKeys = new Set(keysData.keys.map((k: { exchange: string }) => k.exchange));

        // Map exchanges with hasKeys flag
        const mapped = exchangesData.exchanges.map((ex: { id: string; name: string }) => ({
          id: ex.id,
          name: ex.name,
          hasKeys: exchangesWithKeys.has(ex.id)
        }));

        setExchanges(mapped);
      }
    } catch (error) {
      console.error('Failed to fetch exchanges:', error);
    }
  }

  async function fetchData(force = false, exchange?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRefreshing(true); setError('');

    const exchangeFilter = exchange || selectedExchange;
    const exchangeParam = exchangeFilter !== 'all' ? `&exchange=${exchangeFilter}` : '';

    try {
      const ordersUrl = exchangeFilter !== 'all'
        ? `/api/orders?exchange=${exchangeFilter}`
        : '/api/orders';
      const [fillsRes, ordersRes] = await Promise.all([
        apiFetch(`/api/fills?limit=50${exchangeParam}`, { signal: controller.signal }),
        apiFetch(ordersUrl, { signal: controller.signal })
      ]);

      if (!fillsRes.ok || !ordersRes.ok) throw new Error('Could not load orders. Try Refresh.');
      if (controller.signal.aborted) return;
      if (fillsRes.ok) {
        const data = await fillsRes.json();
        setFills(Array.isArray(data) ? data : []);
      }

      if (ordersRes.ok) {
        const data = await ordersRes.json();
        if (!controller.signal.aborted) { setOpenOrders(Array.isArray(data.orders) ? data.orders : []); setLastUpdated(Date.now()); }
      }


    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); setRefreshing(false); }
    }
  }

  function handleExchangeSelect(exchange: string) {
    setSelectedExchange(exchange);

  }

  function forceRefresh() {
    setRefresh(v => v + 1);
  }

  function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleString();
  }

  function formatKrakenTime(timestamp: number) {
    return new Date(timestamp * 1000).toLocaleString();
  }

  function formatPrice(price: number | string) {
    if (price === '0.00000' || price === 0) return 'Market';
    // Return exact string representation to preserve precision
    return price.toString();
  }

  function formatPair(pair: string) {
    try {
      const { base, quote } = parsePair(pair);
      return `${base}-${quote}`;
    } catch (error) {
      console.warn('Failed to parse pair:', pair, error);
      return pair; // Fallback to original if parsing fails
    }
  }

  if (loading && fills.length === 0 && openOrders.length === 0) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground">
      <div className="flex flex-wrap gap-2 items-center justify-between text-xs text-muted-foreground"><span>Refreshes every 15 seconds while visible</span><Freshness at={lastUpdated} staleAfter={45000} /></div>
        <RefreshCw className="w-6 h-6 animate-spin mr-2" />
        Loading orders...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex justify-between items-center">
        {/* Exchange Filter Buttons */}
        <div className="flex items-center gap-2">
          <Button
            variant={selectedExchange === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleExchangeSelect('all')}
          >
            All
          </Button>
          {exchanges.filter(ex => ex.hasKeys).map((ex) => (
            <Button
              key={ex.id}
              variant={selectedExchange === ex.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleExchangeSelect(ex.id)}
            >
              {ex.name}
            </Button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={forceRefresh}
          disabled={refreshing}
          className="flex items-center gap-2"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>

      {/* Open Orders Section */}
      <Card>
        <CardHeader className="py-4 border-b flex flex-row items-center gap-2">
          <Clock size={16} className="text-primary" />
          <CardTitle>Open Orders</CardTitle>
          <Badge variant="secondary" className="ml-2 rounded-full px-2 py-0.5">
            {openOrders?.length || 0}
          </Badge>
        </CardHeader>

        <CardContent className="p-0">
          {!openOrders || openOrders.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No open orders found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Opened</TableHead>
                    {selectedExchange === 'all' && <TableHead>Exchange</TableHead>}
                    <TableHead>Pair</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Filled / Vol</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.isArray(openOrders) && openOrders.map((order) => (
                    <TableRow key={`${order.exchange}-${order.orderId}`}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatKrakenTime(order.openTime)}
                      </TableCell>
                      {selectedExchange === 'all' && (
                        <TableCell className="capitalize">
                          {order.exchange}
                        </TableCell>
                      )}
                      <TableCell className="font-medium">
                        {formatPair(order.pair)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`items-center gap-1 ${order.type === 'buy' ? 'badge-success' : 'badge-danger'}`}
                        >
                          {order.type === 'buy' ? (
                            <ArrowDownLeft size={12} />
                          ) : (
                            <ArrowUpRight size={12} />
                          )}
                          {order.type.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="capitalize text-muted-foreground">
                        {order.orderType}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPrice(order.price)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        <span className={Number(order.volumeExecuted) > 0 ? 'text-primary' : 'text-muted-foreground'}>
                          {Number(order.volumeExecuted).toFixed(8)}
                        </span>
                        <span className="text-muted-foreground mx-1">/</span>
                        {Number(order.volume).toFixed(8)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className="gap-1">
                          <Activity size={8} fill="currentColor" />
                          {order.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Fills Section */}
      <Card>
        <CardHeader className="py-4 border-b flex flex-row items-center gap-2">
          <Clock size={16} className="text-muted-foreground" />
          <CardTitle>Recent Fills</CardTitle>
        </CardHeader>

        <CardContent className="p-0">
          {!fills || fills.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No recent fills found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    {selectedExchange === 'all' && <TableHead>Exchange</TableHead>}
                    <TableHead>Pair</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.isArray(fills) && fills.map((fill) => (
                    <TableRow key={`${fill.exchange || 'unknown'}-${fill.tradeId}`}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(fill.timestamp)}
                      </TableCell>
                      {selectedExchange === 'all' && (
                        <TableCell className="capitalize">
                          {fill.exchange || 'kraken'}
                        </TableCell>
                      )}
                      <TableCell className="font-medium">
                        {formatPair(fill.pair)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={`items-center gap-1 ${fill.side === 'buy' ? 'badge-success' : 'badge-danger'}`}
                        >
                          {fill.side === 'buy' ? (
                            <ArrowDownLeft size={12} />
                          ) : (
                            <ArrowUpRight size={12} />
                          )}
                          {fill.side.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatPrice(fill.price)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {fill.volume.toFixed(8)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {fill.cost.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {fill.fee.toFixed(4)} <span className="text-xs">{fill.feeCurrency}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
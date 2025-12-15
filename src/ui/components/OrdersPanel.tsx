import { useState, useEffect, useRef } from 'react';
import { RefreshCw, ArrowDownLeft, ArrowUpRight, Clock, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/ui/table';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { parsePair } from '../../server/domain/types';

// Simple fetch lock to prevent concurrent fetches
let isFetching = false;
let lastFetchTime = 0;
const MIN_FETCH_INTERVAL = 10000; // 10 seconds minimum between fetches

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
}

interface OpenOrder {
  txid: string;
  pair: string;
  type: 'buy' | 'sell';
  orderType: string;
  price: string;
  volume: string;
  volumeExecuted: string;
  cost: string;
  fee: string;
  status: string;
  openTime: number;
  description: string;
}

export function OrdersPanel() {
  const [fills, setFills] = useState<Fill[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasFetched = useRef(false);

  useEffect(() => {
    // Only fetch once on mount
    if (!hasFetched.current) {
      hasFetched.current = true;
      fetchData();
    }
    // No auto-refresh interval - manual refresh only
  }, []);

  async function fetchData(force = false) {
    // Prevent concurrent fetches
    if (isFetching) {
      console.log('Fetch already in progress, skipping');
      return;
    }

    // Prevent rapid fetches unless forced
    const now = Date.now();
    if (!force && lastFetchTime > 0 && now - lastFetchTime < MIN_FETCH_INTERVAL) {
      console.log('Too soon since last fetch, skipping');
      return;
    }

    isFetching = true;
    setRefreshing(true);

    try {
      const [fillsRes, ordersRes] = await Promise.all([
        fetch('/api/fills?limit=50'),
        fetch('/api/kraken/orders')
      ]);

      if (fillsRes.ok) {
        const data = await fillsRes.json();
        setFills(Array.isArray(data) ? data : []);
      }

      if (ordersRes.ok) {
        const data = await ordersRes.json();
        setOpenOrders(Array.isArray(data.orders) ? data.orders : []);
      }

      lastFetchTime = Date.now();
    } catch (error) {
      console.error('Failed to fetch:', error);
    } finally {
      isFetching = false;
      setLoading(false);
      setRefreshing(false);
    }
  }

  function forceRefresh() {
    fetchData(true);
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
        <RefreshCw className="w-6 h-6 animate-spin mr-2" />
        Loading orders...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
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
              No open orders found on Kraken.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Opened</TableHead>
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
                    <TableRow key={order.txid}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatKrakenTime(order.openTime)}
                      </TableCell>
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
                    <TableRow key={fill.tradeId}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(fill.timestamp)}
                      </TableCell>
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
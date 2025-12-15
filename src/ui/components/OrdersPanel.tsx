import { useState, useEffect, useRef } from 'react';
import { RefreshCw, ArrowDownLeft, ArrowUpRight, Clock, Activity } from 'lucide-react';
import { parsePair } from '../../server/domain/types'; // Import parsePair

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
      <div className="flex items-center justify-center p-12 text-gray-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" />
        Loading orders...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={forceRefresh}
          disabled={refreshing}
          className="text-sm flex items-center gap-2 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Open Orders Section */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <Clock size={16} className="text-blue-400" />
          <h2 className="font-semibold text-white">Open Orders</h2>
          <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">
            {openOrders?.length || 0}
          </span>
        </div>

        {!openOrders || openOrders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No open orders found on Kraken.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-400 uppercase bg-gray-900 border-b border-gray-800">
                <tr>
                  <th className="px-4 py-3">Opened</th>
                  <th className="px-4 py-3">Pair</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Filled / Vol</th>
                  <th className="px-4 py-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {Array.isArray(openOrders) && openOrders.map((order) => (
                  <tr key={order.txid} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {formatKrakenTime(order.openTime)}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {formatPair(order.pair)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                          order.type === 'buy'
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-red-500/10 text-red-400'
                        }`}
                      >
                        {order.type === 'buy' ? (
                          <ArrowDownLeft size={12} />
                        ) : (
                          <ArrowUpRight size={12} />
                        )}
                        {order.type.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 capitalize">
                      {order.orderType}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-300">
                      {formatPrice(order.price)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-300">
                      <span className={Number(order.volumeExecuted) > 0 ? 'text-blue-400' : 'text-gray-500'}>
                        {Number(order.volumeExecuted).toFixed(8)}
                      </span>
                      <span className="text-gray-600 mx-1">/</span>
                      {Number(order.volume).toFixed(8)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1 text-xs text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">
                        <Activity size={8} fill="currentColor" />
                        {order.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Fills Section */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <Clock size={16} className="text-gray-400" />
          <h2 className="font-semibold text-white">Recent Fills</h2>
        </div>

        {!fills || fills.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No recent fills found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-400 uppercase bg-gray-900 border-b border-gray-800">
                <tr>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Pair</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Volume</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {Array.isArray(fills) && fills.map((fill) => (
                  <tr key={fill.tradeId} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {formatTime(fill.timestamp)}
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {formatPair(fill.pair)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                          fill.side === 'buy'
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-red-500/10 text-red-400'
                        }`}
                      >
                        {fill.side === 'buy' ? (
                          <ArrowDownLeft size={12} />
                        ) : (
                          <ArrowUpRight size={12} />
                        )}
                        {fill.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-300">
                      {formatPrice(fill.price)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-300">
                      {fill.volume.toFixed(8)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-300">
                      {fill.cost.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400">
                      {fill.fee.toFixed(4)} <span className="text-xs">{fill.feeCurrency}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
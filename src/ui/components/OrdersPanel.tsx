import { useState, useEffect } from 'react';

interface Order {
  txid: string;
  pair: string;
  type: string;
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
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    fetchOrders();
    // Refresh every 10 seconds
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, []);

  async function fetchOrders() {
    try {
      const res = await fetch('/api/kraken/orders');
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders);
        setLastUpdated(new Date());
        setError('');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to fetch orders');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString();
  }

  function getFilledPercent(vol: string, volExec: string): number {
    const total = parseFloat(vol);
    const filled = parseFloat(volExec);
    if (total === 0) return 0;
    return (filled / total) * 100;
  }

  if (loading) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="text-gray-400">Loading orders...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-white">Open Orders</h2>
            <span className="px-2 py-0.5 text-xs rounded-full bg-gray-800 text-gray-400">
              {orders.length}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-gray-500">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={fetchOrders}
              className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-md transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 text-red-400 text-sm bg-red-900/20">{error}</div>
        )}

        {orders.length === 0 ? (
          <div className="p-8 text-center text-gray-400">
            No open orders
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {orders.map((order) => {
              const filledPercent = getFilledPercent(order.volume, order.volumeExecuted);
              const isPartiallyFilled = filledPercent > 0 && filledPercent < 100;

              return (
                <div key={order.txid} className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{order.pair}</span>
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${
                            order.type === 'buy'
                              ? 'bg-green-900/50 text-green-400'
                              : 'bg-red-900/50 text-red-400'
                          }`}
                        >
                          {order.type.toUpperCase()}
                        </span>
                        <span className="px-2 py-0.5 text-xs rounded bg-gray-800 text-gray-400">
                          {order.orderType}
                        </span>
                        {isPartiallyFilled && (
                          <span className="px-2 py-0.5 text-xs rounded bg-yellow-900/50 text-yellow-400">
                            Partial Fill
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-400 mt-1">{order.description}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-gray-500">
                        {formatTime(order.openTime)}
                      </div>
                      <div className="text-xs text-gray-600 font-mono mt-1">
                        {order.txid.substring(0, 8)}...
                      </div>
                    </div>
                  </div>

                  {/* Fill progress bar */}
                  <div className="mb-2">
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                      <span>Fill Progress</span>
                      <span>
                        {parseFloat(order.volumeExecuted).toFixed(6)} / {parseFloat(order.volume).toFixed(6)} ({filledPercent.toFixed(1)}%)
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          filledPercent === 100
                            ? 'bg-green-500'
                            : filledPercent > 0
                            ? 'bg-yellow-500'
                            : 'bg-gray-600'
                        }`}
                        style={{ width: `${filledPercent}%` }}
                      />
                    </div>
                  </div>

                  {/* Order details */}
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-gray-500 text-xs">Price</div>
                      <div className="text-white">{order.price || 'Market'}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">Volume</div>
                      <div className="text-white">{parseFloat(order.volume).toFixed(6)}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">Cost</div>
                      <div className="text-white">{parseFloat(order.cost).toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">Fee</div>
                      <div className="text-white">{parseFloat(order.fee).toFixed(4)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="bg-gray-900/50 rounded-lg border border-gray-800 p-4 text-sm text-gray-400">
        <p>
          This panel shows your open orders on Kraken, including partially filled orders.
          When an order completes, the received assets will be detected by the sweeper
          and automatically queued for withdrawal.
        </p>
      </div>
    </div>
  );
}

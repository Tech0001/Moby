/**
 * Gate.io Exchange Adapter Factory
 *
 * Creates REST and WebSocket clients for Gate.io Exchange.
 */

import type {
  ExchangeId,
  ExchangeAdapterFactory,
  ExchangeRestClient,
  ExchangeWsClient,
  RestClientOptions,
  ExchangeWsClientOptions,
  TierConfig,
  TierOption,
  ErrorCategory,
} from '../types.js';
import { GateRestClient } from './restClient.js';
import { GateWsClient } from './wsClient.js';
import { normalizeGateAsset, parseGatePair } from './normalize.js';

// Gate.io-specific error strings
const RATE_LIMIT_ERRORS = [
  'RATE_LIMITED',
  'TOO_MANY_REQUESTS',
  'rate limit',
  'request too frequent',
];

const AUTH_ERRORS = [
  'INVALID_KEY',
  'INVALID_SIGNATURE',
  'INVALID_TIMESTAMP',
  'KEY_EXPIRED',
  'IP_FORBIDDEN',
  'authentication required',
  'invalid signature',
];

const SERVICE_ERRORS = [
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'SYSTEM_MAINTENANCE',
  'server error',
  'temporarily unavailable',
];

// Gate.io API rate limits
// Gate.io uses different limits by endpoint type
const GATEIO_TIERS: Record<string, TierConfig> = {
  standard: { maxCounter: 200, decayRate: 10 }, // ~200 requests per 10 seconds
  vip1: { maxCounter: 400, decayRate: 20 },
  vip2: { maxCounter: 600, decayRate: 30 },
};

/**
 * Gate.io exchange adapter factory
 */
export const GateAdapterFactory: ExchangeAdapterFactory = {
  exchangeId: 'gateio' as ExchangeId,
  displayName: 'Gate.io',

  createRestClient(options: RestClientOptions): ExchangeRestClient {
    const client = new GateRestClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      dryRun: options.dryRun,
    });

    // Wrap to conform to ExchangeRestClient interface
    return {
      exchangeId: 'gateio' as ExchangeId,

      async getBalance(options) {
        return client.getBalance(options);
      },

      async getWithdrawInfo(asset, address, amount) {
        return client.getWithdrawInfo(asset, address, amount);
      },

      async withdraw(asset, _key, address, amount) {
        // Gate.io uses actual address, not key name
        const result = await client.withdraw(asset, address, amount);
        return { refId: result.refid };
      },

      async getWithdrawStatus(asset) {
        const statuses = await client.getWithdrawStatus(asset);
        return statuses.map((s) => ({
          refId: s.refid,
          asset: s.asset,
          amount: parseFloat(s.amount),
          fee: parseFloat(s.fee),
          status: mapGateStatus(s.status),
          txid: s.txid,
          address: s.info,
          timestamp: s.time * 1000,
        }));
      },

      async getWithdrawAddresses(asset, method) {
        const addresses = await client.getWithdrawAddresses(asset, method);
        return addresses.map((a) => ({
          key: a.key,
          asset: normalizeGateAsset(a.asset),
          method: a.method,
          address: a.address,
        }));
      },

      async getOpenOrders() {
        const result = await client.getOpenOrders();
        // Convert to standard format
        const open: Record<string, import('../types.js').OpenOrder> = {};
        for (const [orderId, order] of Object.entries(result.open)) {
          const { base, quote } = parseGatePair(order.descr?.pair || '');
          open[orderId] = {
            orderId,
            pair: `${base}/${quote}`,
            side: (order.descr?.type || 'buy') as 'buy' | 'sell',
            orderType: order.descr?.ordertype || '',
            price: order.descr?.price || '0',
            volume: order.vol || '0',
            volumeExecuted: order.vol_exec || '0',
            status: order.status,
            createdAt: order.opentm * 1000,
            description: order.descr?.order,
          };
        }
        return { open };
      },

      async getTicker(pairs) {
        return client.getTicker(pairs);
      },

      async testConnection() {
        return client.testConnection();
      },
    };
  },

  createWsClient(options: ExchangeWsClientOptions): ExchangeWsClient {
    const wsClient = new GateWsClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      onFill: options.onFill,
      onConnect: options.onConnect,
      onDisconnect: options.onDisconnect,
      onError: options.onError,
      autoReconnect: options.autoReconnect,
      reconnectDelayMs: options.reconnectDelay,
    });

    // Add exchangeId property
    Object.defineProperty(wsClient, 'exchangeId', {
      value: 'gateio' as ExchangeId,
      writable: false,
      enumerable: true,
    });

    return wsClient as unknown as ExchangeWsClient;
  },

  normalizeAsset(asset: string): string {
    return normalizeGateAsset(asset);
  },

  parsePair(pair: string): { base: string; quote: string } {
    return parseGatePair(pair);
  },

  categorizeError(errorMessage: string): ErrorCategory {
    if (RATE_LIMIT_ERRORS.some((e) => errorMessage.toLowerCase().includes(e.toLowerCase()))) {
      return 'rate_limit';
    }
    if (AUTH_ERRORS.some((e) => errorMessage.toLowerCase().includes(e.toLowerCase()))) {
      return 'auth';
    }
    if (SERVICE_ERRORS.some((e) => errorMessage.toLowerCase().includes(e.toLowerCase()))) {
      return 'service';
    }
    if (
      errorMessage.toLowerCase().includes('insufficient') ||
      errorMessage.toLowerCase().includes('balance')
    ) {
      return 'funding';
    }
    return 'unknown';
  },

  getTierConfig(tier: string): TierConfig {
    return GATEIO_TIERS[tier] || GATEIO_TIERS.standard;
  },

  getDefaultTier(): string {
    return 'standard';
  },

  getAvailableTiers(): TierOption[] {
    return [
      { value: 'standard', label: 'Standard', ...GATEIO_TIERS.standard },
      { value: 'vip1', label: 'VIP 1', ...GATEIO_TIERS.vip1 },
      { value: 'vip2', label: 'VIP 2+', ...GATEIO_TIERS.vip2 },
    ];
  },

  requiresPassphrase(): boolean {
    return false; // Gate.io doesn't use passphrase
  },
};

/**
 * Map Gate.io withdrawal status to standard status
 */
function mapGateStatus(
  gateStatus: string
): 'pending' | 'processing' | 'complete' | 'failed' | 'held' | 'cancelled' {
  switch (gateStatus.toLowerCase()) {
    case 'request':
    case 'pending':
      return 'pending';
    case 'manual':
    case 'bcode':
      return 'processing';
    case 'done':
      return 'complete';
    case 'cancel':
    case 'cancelled':
      return 'cancelled';
    case 'fail':
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

export default GateAdapterFactory;

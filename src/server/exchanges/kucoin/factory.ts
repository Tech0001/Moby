/**
 * KuCoin Exchange Adapter Factory
 *
 * Creates REST and WebSocket clients for KuCoin Exchange.
 * KuCoin requires a passphrase in addition to API key and secret.
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
import { KuCoinRestClient } from './restClient.js';
import { KuCoinWsClient } from './wsClient.js';
import { normalizeKuCoinAsset, parseKuCoinPair } from './normalize.js';

// KuCoin-specific error strings
const RATE_LIMIT_ERRORS = [
  '429000',
  'Too Many Requests',
  'Rate limit',
  'REQUEST_RATE_LIMIT_EXCEEDED',
];

const AUTH_ERRORS = [
  '400003', // Invalid API-KEY
  '400004', // Invalid sign
  '400005', // Invalid KC-API-PASSPHRASE
  '400006', // Incorrect KC-API-KEY-VERSION
  '400007', // Signature timestamp invalid
  '401000', // Unauthorized
  'Invalid API Key',
  'Invalid signature',
  'Invalid passphrase',
];

const SERVICE_ERRORS = [
  '500000', // Internal Server Error
  '503000', // Service Unavailable
  '503003', // System maintenance
  'Service temporarily unavailable',
  'System maintenance',
];

// KuCoin API rate limits
// KuCoin uses different rate limits by endpoint type
// Spot trade: 50 requests/second, Order endpoints: vary by tier
const KUCOIN_TIERS: Record<string, TierConfig> = {
  standard: { maxCounter: 30, decayRate: 3 }, // 30 requests, ~3 per second decay
  vip1: { maxCounter: 60, decayRate: 6 },
  vip2: { maxCounter: 100, decayRate: 10 },
};

/**
 * KuCoin exchange adapter factory
 */
export const KuCoinAdapterFactory: ExchangeAdapterFactory = {
  exchangeId: 'kucoin' as ExchangeId,
  displayName: 'KuCoin',

  createRestClient(options: RestClientOptions): ExchangeRestClient {
    if (!options.passphrase) {
      throw new Error('KuCoin requires a passphrase');
    }

    const client = new KuCoinRestClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      passphrase: options.passphrase,
      dryRun: options.dryRun,
    });

    // Wrap to conform to ExchangeRestClient interface
    return {
      exchangeId: 'kucoin' as ExchangeId,

      async getBalance() {
        return client.getBalance();
      },

      async getWithdrawInfo(asset, address, amount) {
        return client.getWithdrawInfo(asset, address, amount);
      },

      async withdraw(asset, address, amount) {
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
          status: mapKuCoinStatus(s.status),
          txid: s.txid,
          address: s.info,
          timestamp: s.time * 1000,
        }));
      },

      async getWithdrawAddresses(asset, method) {
        const addresses = await client.getWithdrawAddresses(asset, method);
        return addresses.map((a) => ({
          key: a.key,
          asset: normalizeKuCoinAsset(a.asset),
          method: a.method,
          address: a.address,
        }));
      },

      async getOpenOrders() {
        const result = await client.getOpenOrders();
        // Convert to standard format
        const open: Record<string, import('../types.js').OpenOrder> = {};
        for (const [orderId, order] of Object.entries(result.open)) {
          const { base, quote } = parseKuCoinPair(order.descr?.pair || '');
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
    if (!options.passphrase) {
      throw new Error('KuCoin WebSocket requires a passphrase');
    }

    const wsClient = new KuCoinWsClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      passphrase: options.passphrase,
      onFill: options.onFill,
      onConnect: options.onConnect,
      onDisconnect: options.onDisconnect,
      onError: options.onError,
      autoReconnect: options.autoReconnect,
      reconnectDelayMs: options.reconnectDelay,
    });

    // Add exchangeId property
    Object.defineProperty(wsClient, 'exchangeId', {
      value: 'kucoin' as ExchangeId,
      writable: false,
      enumerable: true,
    });

    return wsClient as unknown as ExchangeWsClient;
  },

  normalizeAsset(asset: string): string {
    return normalizeKuCoinAsset(asset);
  },

  parsePair(pair: string): { base: string; quote: string } {
    return parseKuCoinPair(pair);
  },

  categorizeError(errorMessage: string): ErrorCategory {
    if (RATE_LIMIT_ERRORS.some((e) => errorMessage.includes(e))) {
      return 'rate_limit';
    }
    if (AUTH_ERRORS.some((e) => errorMessage.includes(e))) {
      return 'auth';
    }
    if (SERVICE_ERRORS.some((e) => errorMessage.includes(e))) {
      return 'service';
    }
    if (
      errorMessage.includes('Insufficient') ||
      errorMessage.includes('200004') || // Insufficient balance
      errorMessage.includes('withdrawal limit')
    ) {
      return 'funding';
    }
    return 'unknown';
  },

  getTierConfig(tier: string): TierConfig {
    return KUCOIN_TIERS[tier] || KUCOIN_TIERS.standard;
  },

  getDefaultTier(): string {
    return 'standard';
  },

  getAvailableTiers(): TierOption[] {
    return [
      { value: 'standard', label: 'Standard', ...KUCOIN_TIERS.standard },
      { value: 'vip1', label: 'VIP 1', ...KUCOIN_TIERS.vip1 },
      { value: 'vip2', label: 'VIP 2+', ...KUCOIN_TIERS.vip2 },
    ];
  },

  requiresPassphrase(): boolean {
    return true; // KuCoin requires passphrase
  },
};

/**
 * Map KuCoin withdrawal status to standard status
 */
function mapKuCoinStatus(
  kucoinStatus: string
): 'pending' | 'processing' | 'complete' | 'failed' | 'held' | 'cancelled' {
  switch (kucoinStatus.toLowerCase()) {
    case 'processing':
    case 'wallet_processing':
      return 'processing';
    case 'success':
      return 'complete';
    case 'failure':
      return 'failed';
    default:
      return 'pending';
  }
}

export default KuCoinAdapterFactory;

/**
 * Gemini Exchange Adapter Factory
 *
 * Creates REST and WebSocket clients for Gemini Exchange.
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
import { GeminiRestClient } from './restClient.js';
import { GeminiWsClient } from './wsClient.js';
import { normalizeGeminiAsset, parseGeminiPair } from './normalize.js';

// Gemini-specific error strings
const RATE_LIMIT_ERRORS = [
  'RateLimitExceeded',
  'Rate limit exceeded',
  'Too many requests',
  'SlowDown',
];

const AUTH_ERRORS = [
  'InvalidSignature',
  'InvalidApiKey',
  'InvalidNonce',
  'MissingApiKeyHeader',
  'MissingPayloadHeader',
  'MissingSignatureHeader',
  'InvalidPayload',
  'SessionExpired',
];

const SERVICE_ERRORS = [
  'SystemMaintenance',
  'ServiceUnavailable',
  'InternalServerError',
  'MarketNotOpen',
];

// Gemini API rate limits
// Gemini uses a simpler rate limit model than Kraken
// Private API: 600 requests per minute
const GEMINI_TIERS: Record<string, TierConfig> = {
  standard: { maxCounter: 600, decayRate: 10 }, // 600 per minute = 10 per second
};

/**
 * Gemini exchange adapter factory
 */
export const GeminiAdapterFactory: ExchangeAdapterFactory = {
  exchangeId: 'gemini' as ExchangeId,
  displayName: 'Gemini',

  createRestClient(options: RestClientOptions): ExchangeRestClient {
    const client = new GeminiRestClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      dryRun: options.dryRun,
    });

    // Wrap to conform to ExchangeRestClient interface
    return {
      exchangeId: 'gemini' as ExchangeId,

      async getBalance() {
        return client.getBalance();
      },

      async getWithdrawInfo(asset, key, amount) {
        // Gemini uses address directly, not key names
        // The 'key' parameter is the address for Gemini
        return client.getWithdrawInfo(asset, key, amount);
      },

      async withdraw(asset, key, address, amount) {
        // Gemini uses the saved address key/label
        const result = await client.withdraw(asset, key, amount);
        return { refId: result.refid };
      },

      async getWithdrawStatus(asset) {
        const statuses = await client.getWithdrawStatus(asset);
        return statuses.map((s) => ({
          refId: s.refid,
          asset: s.asset,
          amount: parseFloat(s.amount),
          fee: parseFloat(s.fee),
          status: mapGeminiStatus(s.status),
          txid: s.txid,
          address: s.info,
          timestamp: s.time * 1000,
        }));
      },

      async getWithdrawAddresses(asset, method) {
        const addresses = await client.getWithdrawAddresses(asset, method);
        return addresses.map((a) => ({
          key: a.key,
          asset: normalizeGeminiAsset(a.asset),
          method: a.method,
          address: a.address,
        }));
      },

      async getOpenOrders() {
        const result = await client.getOpenOrders();
        // Convert to standard format
        const open: Record<string, import('../types.js').OpenOrder> = {};
        for (const [orderId, order] of Object.entries(result.open)) {
          const { base, quote } = parseGeminiPair(order.descr?.pair || '');
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
    const wsClient = new GeminiWsClient({
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
      value: 'gemini' as ExchangeId,
      writable: false,
      enumerable: true,
    });

    return wsClient as unknown as ExchangeWsClient;
  },

  normalizeAsset(asset: string): string {
    return normalizeGeminiAsset(asset);
  },

  parsePair(pair: string): { base: string; quote: string } {
    return parseGeminiPair(pair);
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
      errorMessage.includes('InsufficientFunds') ||
      errorMessage.includes('WithdrawalLimit')
    ) {
      return 'funding';
    }
    return 'unknown';
  },

  getTierConfig(tier: string): TierConfig {
    return GEMINI_TIERS[tier] || GEMINI_TIERS.standard;
  },

  getDefaultTier(): string {
    return 'standard';
  },

  getAvailableTiers(): TierOption[] {
    return [{ value: 'standard', label: 'Standard', ...GEMINI_TIERS.standard }];
  },

  requiresPassphrase(): boolean {
    return false; // Gemini doesn't use passphrase
  },
};

/**
 * Map Gemini withdrawal status to standard status
 */
function mapGeminiStatus(
  geminiStatus: string
): 'pending' | 'processing' | 'complete' | 'failed' | 'held' | 'cancelled' {
  switch (geminiStatus.toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'advanced':
    case 'processing':
      return 'processing';
    case 'complete':
    case 'success':
      return 'complete';
    case 'failed':
    case 'failure':
      return 'failed';
    case 'held':
    case 'on hold':
      return 'held';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export default GeminiAdapterFactory;

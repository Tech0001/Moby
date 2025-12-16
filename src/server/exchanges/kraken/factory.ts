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
import { KrakenRestClient } from './restClient.js';
import { KrakenWsClient } from './wsClient.js';
import { normalizeKrakenAsset, parseKrakenPair } from './normalize.js';

// Kraken-specific error strings
const RATE_LIMIT_ERRORS = [
  'EAPI:Rate limit exceeded',
  'EOrder:Rate limit exceeded',
  'EOrder:Domain rate limit exceeded',
  'EAuth:Rate limit exceeded',
  'EAuth:Too many requests',
  'EGeneral:Temporary lockout',
];

const AUTH_ERRORS = [
  'EAPI:Invalid key',
  'EAPI:Invalid signature',
  'EAPI:Invalid nonce',
  'EGeneral:Permission denied',
  'EAccount:Invalid permissions',
  'EAuth:Account temporary disabled',
  'EAuth:Account unconfirmed',
];

const SERVICE_ERRORS = [
  'EService:Unavailable',
  'EService:Market in cancel_only mode',
  'EService:Market in post_only mode',
  'EService:Deadline elapsed',
  'EGeneral:Internal error',
];

// Kraken API key tiers with rate limits
// https://support.kraken.com/hc/en-us/articles/206548367-What-are-the-API-rate-limits-
const KRAKEN_TIERS: Record<string, TierConfig> = {
  starter: { maxCounter: 15, decayRate: 0.33 },
  intermediate: { maxCounter: 20, decayRate: 0.5 },
  pro: { maxCounter: 20, decayRate: 1.0 },
};

/**
 * Kraken exchange adapter factory
 */
export const KrakenAdapterFactory: ExchangeAdapterFactory = {
  exchangeId: 'kraken' as ExchangeId,
  displayName: 'Kraken',

  createRestClient(options: RestClientOptions): ExchangeRestClient {
    const client = new KrakenRestClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      dryRun: options.dryRun,
    });

    // Wrap to conform to ExchangeRestClient interface
    return {
      exchangeId: 'kraken' as ExchangeId,

      async getBalance() {
        return client.getBalance();
      },

      async getWithdrawInfo(asset, key, amount) {
        return client.getWithdrawInfo(asset, key, amount);
      },

      async withdraw(asset, key, amount) {
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
          status: mapKrakenStatus(s.status),
          txid: s.txid,
          address: s.info,
          timestamp: s.time * 1000,
        }));
      },

      async getWithdrawAddresses(asset, method) {
        const addresses = await client.getWithdrawAddresses(asset, method);
        return addresses.map((a) => ({
          key: a.key,
          asset: normalizeKrakenAsset(a.asset),
          method: a.method,
          address: a.address,
        }));
      },

      async getOpenOrders() {
        const result = await client.getOpenOrders();
        // Convert Kraken format to standard format
        const open: Record<string, import('../types.js').OpenOrder> = {};
        for (const [orderId, order] of Object.entries(result.open)) {
          open[orderId] = {
            orderId,
            pair: order.descr?.pair || '',
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
    const wsClient = new KrakenWsClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      onFill: options.onFill,
      onConnect: options.onConnect,
      onDisconnect: options.onDisconnect,
      onError: options.onError,
      autoReconnect: options.autoReconnect,
      reconnectDelayMs: options.reconnectDelay,
    });

    // Add exchangeId property and cast to unknown first for proper type conversion
    Object.defineProperty(wsClient, 'exchangeId', {
      value: 'kraken' as ExchangeId,
      writable: false,
      enumerable: true,
    });

    return wsClient as unknown as ExchangeWsClient;
  },

  normalizeAsset(asset: string): string {
    return normalizeKrakenAsset(asset);
  },

  parsePair(pair: string): { base: string; quote: string } {
    return parseKrakenPair(pair);
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
    if (errorMessage.includes('EFunding:') || errorMessage.includes('EOrder:Insufficient')) {
      return 'funding';
    }
    return 'unknown';
  },

  getTierConfig(tier: string): TierConfig {
    return KRAKEN_TIERS[tier] || KRAKEN_TIERS.starter;
  },

  getDefaultTier(): string {
    return 'starter';
  },

  getAvailableTiers(): TierOption[] {
    return [
      { value: 'starter', label: 'Starter', ...KRAKEN_TIERS.starter },
      { value: 'intermediate', label: 'Intermediate', ...KRAKEN_TIERS.intermediate },
      { value: 'pro', label: 'Pro', ...KRAKEN_TIERS.pro },
    ];
  },

  requiresPassphrase(): boolean {
    return false; // Kraken doesn't use passphrase
  },
};

/**
 * Map Kraken withdrawal status to standard status
 */
function mapKrakenStatus(
  krakenStatus: string
): 'pending' | 'processing' | 'complete' | 'failed' | 'held' | 'cancelled' {
  switch (krakenStatus.toLowerCase()) {
    case 'initial':
    case 'pending':
      return 'pending';
    case 'processing':
      return 'processing';
    case 'settled':
    case 'success':
      return 'complete';
    case 'failure':
    case 'failed':
      return 'failed';
    case 'on hold':
      return 'held';
    case 'cancel pending':
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export default KrakenAdapterFactory;

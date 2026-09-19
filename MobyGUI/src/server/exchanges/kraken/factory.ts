import { validateBalances } from '../balances.js';
import { parseTrade } from './trades.js';
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
import { normalizeKrakenAsset, parseKrakenPair, toKrakenAsset } from './normalize.js';

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
      beforeRequest: options.beforeRequest,
    });

    // Wrap to conform to ExchangeRestClient interface
    return {
      exchangeId: 'kraken' as ExchangeId,

      async getBalance() {
        const balances = await client.getBalance();
        validateBalances(balances);
        return Object.fromEntries(Object.entries(balances).map(([asset, amount]) => [normalizeKrakenAsset(asset), amount]));
      },

      async getWithdrawInfo(asset, key, amount) {
        return client.getWithdrawInfo(toKrakenAsset(asset), key, amount);
      },

      async withdraw(asset, key, _address, amount, options) {
        // Kraken uses key (saved address name), not the actual address
        const result = await client.withdraw(toKrakenAsset(asset), key, amount, options?.maxFee, options?.beforeSend);
        return { refId: result.refid };
      },

      async getWithdrawStatus(asset) {
        const statuses = await client.getWithdrawStatus(asset);
        return statuses.map((s) => ({
          refId: s.refid,
          asset: normalizeKrakenAsset(s.asset),
          amount: parseFloat(s.amount),
          fee: parseFloat(s.fee),
          status: s['status-prop'] === 'onhold' ? 'held' as const : s['status-prop'] === 'cancel-pending' ? 'pending' as const : s['status-prop'] === 'canceled' ? 'cancelled' as const : mapKrakenStatus(s.status),
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

      async getWithdrawMethods(asset) {
        const methods = await client.getWithdrawMethods(asset);
        return methods.map((m) => {
          const parsedFee = m.fee ? parseFloat(m.fee) : NaN;
          return {
            asset: normalizeKrakenAsset(m.asset),
            method: m.method,
            network: m.network,
            minimum: parseFloat(m.minimum),
            maximum: m.limit === false ? undefined : parseFloat(m.limit),
            fee: Number.isNaN(parsedFee) ? undefined : parsedFee,
            genAddress: m['gen-address'],
          };
        });
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

      async getTradesHistory(options?: { start?: number; end?: number }) {
        const trades: import('../types.js').TradeHistoryRecord[] = [];
        const end = Math.floor((options?.end ?? Date.now()) / 1000);
        for (let offset = 0; ; offset += 50) {
          const page = await client.getTradesHistory({ start: options?.start ? Math.floor(options.start / 1000) : undefined, end, offset });
          const entries = Object.entries(page.trades);
          for (const [id, raw] of entries) {
            const fill = parseTrade(id, raw);
            if (fill) trades.push(fill);
          }
          if (offset + entries.length >= page.count) break;
          if (!entries.length) throw new Error('Incomplete Kraken trade history page');
        }

        return trades;
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
    case 'settled':
    case 'cancel pending':
    case 'processing':
      return 'processing';
    case 'success':
      return 'complete';
    case 'failure':
    case 'failed':
      return 'failed';
    case 'on hold':
      return 'held';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export default KrakenAdapterFactory;

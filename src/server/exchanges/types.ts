import { EventEmitter } from 'events';

// ============== Exchange Identifiers ==============

export type ExchangeId = 'kraken' | 'gemini' | 'kucoin' | 'gateio';

export const EXCHANGE_DISPLAY_NAMES: Record<ExchangeId, string> = {
  kraken: 'Kraken',
  gemini: 'Gemini',
  kucoin: 'KuCoin',
  gateio: 'Gate.io',
};

// ============== Common Event Types ==============

/**
 * Normalized fill event - all exchanges emit fills in this format
 */
export interface FillEvent {
  tradeId: string;
  orderId: string;
  pair: string; // e.g., "BTC/USD" (normalized format)
  side: 'buy' | 'sell';
  orderType: string; // e.g., "limit", "market", "take_profit"
  price: number;
  volume: number; // Amount filled (base asset)
  cost: number; // price * volume (quote currency)
  fee: number;
  feeCurrency: string; // Normalized asset name
  timestamp: number; // Unix ms
}

// ============== Withdrawal Types ==============

/**
 * Information about a withdrawal before submitting
 */
export interface WithdrawInfo {
  method: string; // Withdrawal method/network name
  limit: number; // Max single withdrawal amount
  amount: number; // Requested amount (may be adjusted)
  fee: number; // Network/exchange fee
}

/**
 * Result of a successful withdrawal submission
 */
export interface WithdrawResult {
  refId: string; // Exchange's reference ID for tracking
}

/**
 * Withdrawal status from exchange
 */
export interface WithdrawStatusRecord {
  refId: string;
  asset: string;
  amount: number;
  fee: number;
  status: 'pending' | 'processing' | 'complete' | 'failed' | 'held' | 'cancelled';
  txid?: string; // On-chain txid when available
  address?: string; // Destination address
  timestamp: number;
  error?: string;
}

/**
 * Saved withdrawal address from exchange
 */
export interface SavedAddress {
  key: string; // Unique name/label for the address on exchange
  asset: string; // Asset symbol (normalized, e.g., "BTC")
  method: string; // Withdrawal method/network
  address: string; // Actual blockchain address
  memo?: string; // Optional memo/tag (for XRP, XLM, etc.)
}

// ============== Order Types ==============

export interface OpenOrder {
  orderId: string;
  pair: string; // Normalized format
  side: 'buy' | 'sell';
  orderType: string;
  price: string;
  volume: string;
  volumeExecuted: string;
  status: string;
  createdAt: number;
  description?: string;
}

// ============== Connection Types ==============

export interface ConnectionTestResult {
  success: boolean;
  hasBalance: boolean; // API key has balance permission
  hasWithdraw: boolean; // API key has withdraw permission
  error?: string;
}

// ============== Error Categories ==============

export type ErrorCategory = 'rate_limit' | 'auth' | 'service' | 'funding' | 'unknown';

// ============== REST Client Interface ==============

/**
 * REST client interface that all exchanges must implement
 */
export interface WithdrawalMethod {
  asset: string;
  method: string;
  network?: string;
  minimum: number;
  maximum?: number;
  fee?: number;
  genAddress: boolean;
}

export interface ExchangeRestClient {
  readonly exchangeId: ExchangeId;

  // Balance
  getBalance(): Promise<Record<string, string>>;

  // Withdrawals
  getWithdrawInfo(asset: string, key: string, amount: number): Promise<WithdrawInfo>;
  withdraw(asset: string, key: string, address: string, amount: number): Promise<WithdrawResult>;
  getWithdrawStatus(asset?: string): Promise<WithdrawStatusRecord[]>;
  getWithdrawAddresses(asset?: string, method?: string): Promise<SavedAddress[]>;
  getWithdrawMethods?(asset?: string): Promise<WithdrawalMethod[]>;

  // Orders
  getOpenOrders(): Promise<{ open: Record<string, OpenOrder> }>;

  // Trade history (for reconciliation)
  getTradesHistory?(options?: {
    start?: number;
    end?: number;
  }): Promise<TradeHistoryRecord[]>;

  // Market data
  getTicker(pairs: string[]): Promise<Record<string, { c: [string, string] }>>;

  // Connection
  testConnection(): Promise<ConnectionTestResult>;
}

// Trade history record for reconciliation
export interface TradeHistoryRecord {
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

// ============== WebSocket Client Interface ==============

export interface ExchangeWsClientOptions {
  apiKey: string;
  apiSecret: string;
  passphrase?: string; // KuCoin requires this
  onFill?: (fill: FillEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectDelay?: number;
}

/**
 * WebSocket client interface that all exchanges must implement
 * Emits: 'fill', 'connect', 'disconnect', 'error'
 */
export interface ExchangeWsClient extends EventEmitter {
  readonly exchangeId: ExchangeId;

  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
}

// ============== Rate Limiter Types ==============

export interface TierConfig {
  maxCounter: number;
  decayRate: number; // tokens per second
}

export interface TierOption {
  value: string;
  label: string;
  maxCounter: number;
  decayRate: number;
}

// ============== Exchange Adapter Factory ==============

export interface RestClientOptions {
  apiKey: string;
  apiSecret: string;
  passphrase?: string; // KuCoin
  dryRun?: boolean;
}

/**
 * Factory interface for creating exchange clients
 * Each exchange implements this to provide its specific clients
 */
export interface ExchangeAdapterFactory {
  readonly exchangeId: ExchangeId;
  readonly displayName: string;

  // Client creation
  createRestClient(options: RestClientOptions): ExchangeRestClient;
  createWsClient(options: ExchangeWsClientOptions): ExchangeWsClient;

  // Asset normalization (exchange-specific → standard)
  normalizeAsset(exchangeAsset: string): string;

  // Pair parsing (exchange format → { base, quote })
  parsePair(exchangePair: string): { base: string; quote: string };

  // Error categorization for retry logic
  categorizeError(errorMessage: string): ErrorCategory;

  // Rate limiting configuration
  getTierConfig(tier: string): TierConfig;
  getDefaultTier(): string;
  getAvailableTiers(): TierOption[];

  // API key validation
  requiresPassphrase(): boolean;
}

// ============== Exchange Registry ==============

/**
 * Registry for all exchange adapters
 */
export interface ExchangeRegistry {
  register(factory: ExchangeAdapterFactory): void;
  get(exchangeId: ExchangeId): ExchangeAdapterFactory | undefined;
  getAll(): ExchangeAdapterFactory[];
  getIds(): ExchangeId[];
  has(exchangeId: ExchangeId): boolean;
}

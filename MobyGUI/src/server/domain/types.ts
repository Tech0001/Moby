// Exchange identifier
export type ExchangeId = 'kraken' | 'gemini' | 'kucoin' | 'gateio';

// Fill event from exchange WebSocket (normalized)
export interface FillEvent {
  tradeId: string;
  orderId: string;
  pair: string;           // e.g., "XBT/USD"
  side: 'buy' | 'sell';
  orderType: string;      // e.g., "limit", "take_profit"
  price: number;
  volume: number;         // Amount filled
  cost: number;           // price * volume (in quote currency)
  fee: number;            // Fee amount
  feeCurrency: string;    // Fee currency
  timestamp: number;      // Unix ms
  exchange?: ExchangeId;  // Which exchange this fill came from
}

// Derived from FillEvent - what was actually received
export interface ReceivedAsset {
  asset: string;          // Normalized asset name (e.g., "BTC", "ETH")
  amount: number;         // Net amount received after fees
  fromFill: FillEvent;
}

// Withdrawal job status
export type WithdrawalStatus =
  | 'submitted'    // Request sent to Kraken
  | 'pending'      // Kraken accepted, waiting for processing
  | 'complete'     // Successfully completed
  | 'failed'       // Failed (will retry)
  | 'unknown'
  | 'held'         // Held for compliance review
  | 'cancelled';   // Cancelled (won't retry)

// Withdrawal job record
export interface WithdrawalJob {
  id: string;               // UUID
  exchange: ExchangeId;     // Which exchange this withdrawal is for
  asset: string;
  method: string;           // Exchange withdrawal method
  destKey: string;          // Exchange saved address key name
  amount: number;
  status: WithdrawalStatus;
  exchangeRef?: string;     // Exchange's reference ID (was krakenRef)
  txid?: string;            // On-chain txid when available
  createdAt: number;        // Unix ms
  updatedAt: number;        // Unix ms
  pollCount: number;        // How many times we've polled status
  lastError?: string;
  quotedFee?: number | null;
  actualFee?: number | null;
  feeUsd?: number | null;
  destinationAddress?: string | null;
}

// Asset state in database
export interface AssetState {
  exchange: ExchangeId;            // Which exchange this state is for
  asset: string;
  pendingAmount: number;           // Amount waiting to be swept
  rrIndex: number;                 // Round-robin index for wallet rotation
  lastWithdrawAt: number | null;   // Unix ms
  consecutiveFailures: number;
  backoffUntil: number | null;     // Unix ms - don't attempt until this time
}

// Kraken WithdrawInfo response (subset)
export interface WithdrawInfo {
  method: string;
  limit: number;      // Max single withdrawal
  amount: number;     // Requested amount (may be adjusted)
  fee: number;        // Network fee
}

// Kraken withdrawal status response
export interface KrakenWithdrawStatus {
  'status-prop'?: string;
  key?: string;
  refid: string;
  method: string;
  aclass: string;
  asset: string;
  amount: string;
  fee: string;
  time: number;
  status: string;     // "Initial", "Pending", "Settled", "Success", "Failure", "On Hold"
  txid?: string;
  info?: string;      // Destination address
  statusProp?: string; // Additional status info
}

// Rate limiter state
export interface RateLimitState {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number;  // tokens per second
}

// App state flags
export interface AppState {
  enabled: boolean;
  schemaVersion: number;
  lastStartedAt: number | null;
}

// Pair info for asset resolution
export interface PairInfo {
  pair: string;        // e.g., "XBTUSD"
  altname: string;     // e.g., "XBT/USD"
  base: string;        // e.g., "XXBT"
  quote: string;       // e.g., "ZUSD"
  baseNorm: string;    // e.g., "BTC" (normalized)
  quoteNorm: string;   // e.g., "USD" (normalized)
}

// Asset normalization map
export const ASSET_NORMALIZATION: Record<string, string> = {
  'XXBT': 'BTC',
  'XBT': 'BTC',
  'XETH': 'ETH',
  'ZUSD': 'USD',
  'ZEUR': 'EUR',
  'ZGBP': 'GBP',
  'XLTC': 'LTC',
  'XXRP': 'XRP',
  'XXLM': 'XLM',
  'XDOGE': 'DOGE',
  'XSOL': 'SOL',
  // Add more as needed
};

export function normalizeAsset(asset: string): string {
  return ASSET_NORMALIZATION[asset] || asset;
}

// Parse pair string to base/quote
export function parsePair(pair: string): { base: string; quote: string } {
  // Handle "XBT/USD" format
  if (pair.includes('/')) {
    const [base, quote] = pair.split('/');
    return { base: normalizeAsset(base), quote: normalizeAsset(quote) };
  }

  // Handle "XBTUSD" format - this is trickier
  // Common quote currencies
  const quoteCurrencies = ['ZUSD', 'ZEUR', 'ZGBP', 'ZJPY', 'ZCAD', 'ZAUD', 'ZCHF', 'XXBT', 'XETH', 'XBT', 'ETH', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'USDT', 'USDC', 'DAI'];

  for (const quote of quoteCurrencies) {
    if (pair.endsWith(quote)) {
      const base = pair.slice(0, -quote.length);
      return { base: normalizeAsset(base), quote: normalizeAsset(quote) };
    }
  }

  // Fallback: assume last 3 chars are quote
  const base = pair.slice(0, -3);
  const quote = pair.slice(-3);
  return { base: normalizeAsset(base), quote: normalizeAsset(quote) };
}

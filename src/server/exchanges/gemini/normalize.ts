/**
 * Gemini Asset and Pair Normalization
 *
 * Gemini uses lowercase symbols (e.g., "btcusd", "ethusd")
 * and doesn't use the X-prefixes that Kraken does.
 */

// Asset name mappings (Gemini format → normalized)
const ASSET_MAP: Record<string, string> = {
  // Standard crypto
  btc: 'BTC',
  eth: 'ETH',
  ltc: 'LTC',
  bch: 'BCH',
  zec: 'ZEC',
  link: 'LINK',
  oxt: 'OXT',
  bat: 'BAT',
  dai: 'DAI',
  amp: 'AMP',
  comp: 'COMP',
  paxg: 'PAXG',
  mkr: 'MKR',
  zrx: 'ZRX',
  knc: 'KNC',
  mana: 'MANA',
  storj: 'STORJ',
  snx: 'SNX',
  crv: 'CRV',
  bal: 'BAL',
  uni: 'UNI',
  ren: 'REN',
  uma: 'UMA',
  yfi: 'YFI',
  aave: 'AAVE',
  fil: 'FIL',
  bnb: 'BNB',
  matic: 'MATIC',
  skl: 'SKL',
  sushi: 'SUSHI',
  grt: 'GRT',
  lrc: 'LRC',
  sand: 'SAND',
  cube: 'CUBE',
  enj: 'ENJ',
  chz: 'CHZ',
  axs: 'AXS',
  slp: 'SLP',
  luna: 'LUNA',
  ust: 'UST',
  doge: 'DOGE',
  shib: 'SHIB',
  sol: 'SOL',
  avax: 'AVAX',
  ftm: 'FTM',
  atom: 'ATOM',
  dot: 'DOT',
  ada: 'ADA',
  xrp: 'XRP',
  xlm: 'XLM',
  algo: 'ALGO',
  xtz: 'XTZ',
  eos: 'EOS',
  trx: 'TRX',
  near: 'NEAR',
  apt: 'APT',
  arb: 'ARB',
  op: 'OP',
  imx: 'IMX',
  pepe: 'PEPE',

  // Stablecoins
  usd: 'USD',
  usdc: 'USDC',
  usdt: 'USDT',
  gusd: 'GUSD', // Gemini USD
  dai: 'DAI',

  // Fiat
  gbp: 'GBP',
  eur: 'EUR',
  sgd: 'SGD',
};

// Known trading pairs and their components
const PAIR_MAP: Record<string, { base: string; quote: string }> = {
  btcusd: { base: 'BTC', quote: 'USD' },
  ethusd: { base: 'ETH', quote: 'USD' },
  ethbtc: { base: 'ETH', quote: 'BTC' },
  ltcusd: { base: 'LTC', quote: 'USD' },
  ltcbtc: { base: 'LTC', quote: 'BTC' },
  ltceth: { base: 'LTC', quote: 'ETH' },
  bchusd: { base: 'BCH', quote: 'USD' },
  bchbtc: { base: 'BCH', quote: 'BTC' },
  bcheth: { base: 'BCH', quote: 'ETH' },
  zecusd: { base: 'ZEC', quote: 'USD' },
  zecbtc: { base: 'ZEC', quote: 'BTC' },
  zeceth: { base: 'ZEC', quote: 'ETH' },
  solusd: { base: 'SOL', quote: 'USD' },
  dogeusd: { base: 'DOGE', quote: 'USD' },
  shibusd: { base: 'SHIB', quote: 'USD' },
  maticusd: { base: 'MATIC', quote: 'USD' },
  linkusd: { base: 'LINK', quote: 'USD' },
  uniusd: { base: 'UNI', quote: 'USD' },
  aaveusd: { base: 'AAVE', quote: 'USD' },
  filusd: { base: 'FIL', quote: 'USD' },
  atomusd: { base: 'ATOM', quote: 'USD' },
  dotusd: { base: 'DOT', quote: 'USD' },
  adausd: { base: 'ADA', quote: 'USD' },
  avaxusd: { base: 'AVAX', quote: 'USD' },
  xrpusd: { base: 'XRP', quote: 'USD' },
  xlmusd: { base: 'XLM', quote: 'USD' },
  // GUSD pairs
  btcgusd: { base: 'BTC', quote: 'GUSD' },
  ethgusd: { base: 'ETH', quote: 'GUSD' },
  // Add more as needed
};

/**
 * Normalize a Gemini asset symbol to standard format
 */
export function normalizeGeminiAsset(asset: string): string {
  const lower = asset.toLowerCase();
  return ASSET_MAP[lower] || asset.toUpperCase();
}

/**
 * Parse a Gemini trading pair into base and quote
 * Gemini uses lowercase concatenated pairs like "btcusd"
 */
export function parseGeminiPair(pair: string): { base: string; quote: string } {
  const lower = pair.toLowerCase();

  // Check explicit mapping first
  if (PAIR_MAP[lower]) {
    return PAIR_MAP[lower];
  }

  // Try to parse automatically
  // Common quote currencies (check longest first)
  const quotes = ['gusd', 'usdc', 'usdt', 'usd', 'gbp', 'eur', 'sgd', 'btc', 'eth', 'dai'];

  for (const quote of quotes) {
    if (lower.endsWith(quote)) {
      const base = lower.slice(0, -quote.length);
      return {
        base: normalizeGeminiAsset(base),
        quote: normalizeGeminiAsset(quote),
      };
    }
  }

  // Fallback: assume last 3 chars are quote
  const base = lower.slice(0, -3);
  const quote = lower.slice(-3);
  return {
    base: normalizeGeminiAsset(base),
    quote: normalizeGeminiAsset(quote),
  };
}

/**
 * Convert normalized pair to Gemini format
 * e.g., "BTC/USD" → "btcusd"
 */
export function toGeminiPair(base: string, quote: string): string {
  return `${base.toLowerCase()}${quote.toLowerCase()}`;
}

/**
 * Convert normalized asset to Gemini format
 */
export function toGeminiAsset(asset: string): string {
  return asset.toLowerCase();
}

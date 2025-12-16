/**
 * Kraken-specific asset normalization
 * Kraken uses prefixes like X (crypto) and Z (fiat) for some assets
 */

// Kraken asset name → Standard asset name
export const KRAKEN_ASSET_MAP: Record<string, string> = {
  XXBT: 'BTC',
  XBT: 'BTC',
  XETH: 'ETH',
  XLTC: 'LTC',
  XXRP: 'XRP',
  XXLM: 'XLM',
  XDOGE: 'DOGE',
  XSOL: 'SOL',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZGBP: 'GBP',
  ZJPY: 'JPY',
  ZCAD: 'CAD',
  ZAUD: 'AUD',
  // Add more as needed
};

// Standard asset name → Kraken asset name (for API calls)
export const STANDARD_TO_KRAKEN: Record<string, string> = {
  BTC: 'XBT', // Kraken uses XBT for Bitcoin
};

/**
 * Normalize a Kraken asset name to standard format
 */
export function normalizeKrakenAsset(krakenAsset: string): string {
  return KRAKEN_ASSET_MAP[krakenAsset] || krakenAsset;
}

/**
 * Convert standard asset name to Kraken format
 */
export function toKrakenAsset(standardAsset: string): string {
  return STANDARD_TO_KRAKEN[standardAsset] || standardAsset;
}

/**
 * Parse a Kraken pair string to base/quote
 * Handles formats like "XBT/USD" or "XBTUSD"
 */
export function parseKrakenPair(pair: string): { base: string; quote: string } {
  // Handle "XBT/USD" format
  if (pair.includes('/')) {
    const [base, quote] = pair.split('/');
    return {
      base: normalizeKrakenAsset(base),
      quote: normalizeKrakenAsset(quote),
    };
  }

  // Handle "XBTUSD" format - find the split point
  const quoteCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'USDT', 'USDC', 'DAI'];

  for (const quote of quoteCurrencies) {
    if (pair.endsWith(quote)) {
      const base = pair.slice(0, -quote.length);
      return {
        base: normalizeKrakenAsset(base),
        quote: normalizeKrakenAsset(quote),
      };
    }
  }

  // Fallback: assume last 3 chars are quote
  const base = pair.slice(0, -3);
  const quote = pair.slice(-3);
  return {
    base: normalizeKrakenAsset(base),
    quote: normalizeKrakenAsset(quote),
  };
}

/**
 * KuCoin Asset and Pair Normalization
 *
 * KuCoin uses uppercase symbols with dash-separated pairs (e.g., "BTC-USDT")
 */

/**
 * Normalize a KuCoin asset symbol to standard format
 * KuCoin already uses uppercase, so mostly pass-through
 */
export function normalizeKuCoinAsset(asset: string): string {
  return asset.toUpperCase();
}

/**
 * Parse a KuCoin trading pair into base and quote
 * KuCoin uses "BTC-USDT" format
 */
export function parseKuCoinPair(pair: string): { base: string; quote: string } {
  const parts = pair.split('-');

  if (parts.length === 2) {
    return {
      base: normalizeKuCoinAsset(parts[0]),
      quote: normalizeKuCoinAsset(parts[1]),
    };
  }

  // Fallback for unexpected format
  return {
    base: pair,
    quote: 'UNKNOWN',
  };
}

/**
 * Convert normalized pair to KuCoin format
 * e.g., "BTC/USDT" → "BTC-USDT"
 */
export function toKuCoinPair(base: string, quote: string): string {
  return `${base.toUpperCase()}-${quote.toUpperCase()}`;
}

/**
 * Convert from our "BTC/USDT" format to KuCoin "BTC-USDT"
 */
export function convertPairFormat(pair: string): string {
  if (pair.includes('/')) {
    const [base, quote] = pair.split('/');
    return toKuCoinPair(base, quote);
  }
  return pair;
}

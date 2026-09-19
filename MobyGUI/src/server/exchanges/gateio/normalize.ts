/**
 * Gate.io Asset and Pair Normalization
 *
 * Gate.io uses uppercase symbols with underscore-separated pairs (e.g., "BTC_USDT")
 */

/**
 * Normalize a Gate.io asset symbol to standard format
 * Gate.io already uses uppercase, so mostly pass-through
 */
export function normalizeGateAsset(asset: string): string {
  return asset.toUpperCase();
}

/**
 * Parse a Gate.io trading pair into base and quote
 * Gate.io uses "BTC_USDT" format
 */
export function parseGatePair(pair: string): { base: string; quote: string } {
  const parts = pair.split('_');

  if (parts.length === 2) {
    return {
      base: normalizeGateAsset(parts[0]),
      quote: normalizeGateAsset(parts[1]),
    };
  }

  // Fallback for unexpected format
  return {
    base: pair,
    quote: 'UNKNOWN',
  };
}

/**
 * Convert normalized pair to Gate.io format
 * e.g., "BTC/USDT" → "BTC_USDT"
 */
export function toGatePair(base: string, quote: string): string {
  return `${base.toUpperCase()}_${quote.toUpperCase()}`;
}

/**
 * Convert from our "BTC/USDT" format to Gate.io "BTC_USDT"
 */
export function convertPairFormat(pair: string): string {
  if (pair.includes('/')) {
    const [base, quote] = pair.split('/');
    return toGatePair(base, quote);
  }
  return pair;
}

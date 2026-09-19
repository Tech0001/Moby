/**
 * KuCoin API Request Signing
 *
 * KuCoin uses HMAC-SHA256 for signing:
 * 1. Create string: timestamp + method + endpoint + body
 * 2. Sign with HMAC-SHA256 using API secret (base64 decoded)
 * 3. Base64 encode the signature
 *
 * Also requires passphrase signed with HMAC-SHA256 for v2+ APIs
 */

import { createHmac } from 'crypto';

/**
 * Generate timestamp in milliseconds
 */
export function generateTimestamp(): string {
  return Date.now().toString();
}

/**
 * Sign the passphrase for KuCoin API v2+
 */
export function signPassphrase(passphrase: string, apiSecret: string): string {
  return createHmac('sha256', apiSecret)
    .update(passphrase)
    .digest('base64');
}

/**
 * Create signature for KuCoin API request
 *
 * @param timestamp - Current timestamp in ms
 * @param method - HTTP method (GET, POST, DELETE)
 * @param endpoint - API endpoint path with query string
 * @param body - Request body (empty string for GET)
 * @param apiSecret - API secret key
 */
export function signRequest(
  timestamp: string,
  method: string,
  endpoint: string,
  body: string,
  apiSecret: string
): string {
  const preSign = timestamp + method.toUpperCase() + endpoint + body;

  return createHmac('sha256', apiSecret)
    .update(preSign)
    .digest('base64');
}

/**
 * Generate headers for authenticated KuCoin request
 */
export function generateHeaders(
  method: string,
  endpoint: string,
  body: string,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Record<string, string> {
  const timestamp = generateTimestamp();
  const signature = signRequest(timestamp, method, endpoint, body, apiSecret);
  const signedPassphrase = signPassphrase(passphrase, apiSecret);

  return {
    'KC-API-KEY': apiKey,
    'KC-API-SIGN': signature,
    'KC-API-TIMESTAMP': timestamp,
    'KC-API-PASSPHRASE': signedPassphrase,
    'KC-API-KEY-VERSION': '2', // Use API v2 signing
    'Content-Type': 'application/json',
  };
}

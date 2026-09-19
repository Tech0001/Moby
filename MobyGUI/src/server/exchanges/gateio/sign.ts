/**
 * Gate.io API Request Signing
 *
 * Gate.io uses HMAC-SHA512 for signing:
 * 1. Create string: timestamp + method + path + query + body_hash
 * 2. Sign with HMAC-SHA512 using API secret
 * 3. Return hex-encoded signature
 *
 * Headers required:
 * - KEY: API key
 * - SIGN: HMAC-SHA512 signature
 * - Timestamp: Unix timestamp in seconds
 * - Content-Type: application/json (for POST)
 */

import { createHmac, createHash } from 'crypto';

/**
 * Generate timestamp in seconds
 */
export function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Hash the request body using SHA512
 */
export function hashBody(body: string): string {
  return createHash('sha512').update(body).digest('hex');
}

/**
 * Create signature for Gate.io API request
 *
 * @param method - HTTP method (GET, POST, DELETE)
 * @param path - API endpoint path (e.g., /api/v4/spot/accounts)
 * @param query - Query string (without leading ?)
 * @param body - Request body (empty string for GET)
 * @param timestamp - Unix timestamp in seconds
 * @param apiSecret - API secret key
 */
export function signRequest(
  method: string,
  path: string,
  query: string,
  body: string,
  timestamp: string,
  apiSecret: string
): string {
  // Hash the body
  const bodyHash = hashBody(body);

  // Create the signing string
  // Format: method\npath\nquery\nbodyHash\ntimestamp
  const signString = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`;

  return createHmac('sha512', apiSecret).update(signString).digest('hex');
}

/**
 * Generate headers for authenticated Gate.io request
 */
export function generateHeaders(
  method: string,
  path: string,
  query: string,
  body: string,
  apiKey: string,
  apiSecret: string
): Record<string, string> {
  const timestamp = generateTimestamp();
  const signature = signRequest(method, path, query, body, timestamp, apiSecret);

  const headers: Record<string, string> = {
    KEY: apiKey,
    SIGN: signature,
    Timestamp: timestamp,
  };

  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

/**
 * Generate WebSocket authentication message for Gate.io
 *
 * Gate.io WS auth uses channel + event + timestamp signed with HMAC-SHA512
 */
export function generateWsAuth(
  channel: string,
  event: string,
  apiKey: string,
  apiSecret: string
): { apiKey: string; signature: string; timestamp: string } {
  const timestamp = generateTimestamp();
  const signString = `channel=${channel}&event=${event}&time=${timestamp}`;
  const signature = createHmac('sha512', apiSecret).update(signString).digest('hex');

  return {
    apiKey,
    signature,
    timestamp,
  };
}

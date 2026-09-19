/**
 * Gemini API Request Signing
 *
 * Gemini uses a different signing method than Kraken:
 * 1. Create JSON payload with request params + nonce
 * 2. Base64 encode the payload
 * 3. HMAC-SHA384 sign the base64 payload with API secret
 */

import { createHmac } from 'crypto';

/**
 * Generate a nonce (timestamp in milliseconds)
 */
export function generateNonce(): number {
  return Date.now();
}

/**
 * Create a signed request for Gemini API
 *
 * @param endpoint - API endpoint path (e.g., "/v1/balances")
 * @param payload - Request payload object
 * @param apiSecret - API secret key
 * @returns Object with headers for the request
 */
export function signRequest(
  endpoint: string,
  payload: Record<string, unknown>,
  apiKey: string,
  apiSecret: string
): {
  'X-GEMINI-APIKEY': string;
  'X-GEMINI-PAYLOAD': string;
  'X-GEMINI-SIGNATURE': string;
  'Content-Type': string;
} {
  // Add request path and nonce to payload
  const fullPayload = {
    request: endpoint,
    nonce: generateNonce(),
    ...payload,
  };

  // Base64 encode the JSON payload
  const payloadJson = JSON.stringify(fullPayload);
  const payloadBase64 = Buffer.from(payloadJson).toString('base64');

  // Sign with HMAC-SHA384
  const signature = createHmac('sha384', apiSecret)
    .update(payloadBase64)
    .digest('hex');

  return {
    'X-GEMINI-APIKEY': apiKey,
    'X-GEMINI-PAYLOAD': payloadBase64,
    'X-GEMINI-SIGNATURE': signature,
    'Content-Type': 'text/plain',
  };
}

/**
 * Create WebSocket authentication headers
 * Same signing method but for WS connection
 */
export function signWsConnection(
  apiKey: string,
  apiSecret: string
): {
  'X-GEMINI-APIKEY': string;
  'X-GEMINI-PAYLOAD': string;
  'X-GEMINI-SIGNATURE': string;
} {
  const payload = {
    request: '/v1/order/events',
    nonce: generateNonce(),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson).toString('base64');

  const signature = createHmac('sha384', apiSecret)
    .update(payloadBase64)
    .digest('hex');

  return {
    'X-GEMINI-APIKEY': apiKey,
    'X-GEMINI-PAYLOAD': payloadBase64,
    'X-GEMINI-SIGNATURE': signature,
  };
}

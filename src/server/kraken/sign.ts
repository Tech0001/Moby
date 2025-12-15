import { createHash, createHmac } from 'crypto';

/**
 * Generate Kraken API signature
 * @see https://docs.kraken.com/rest/#section/Authentication
 */
export function generateSignature(
  urlPath: string,
  postData: string,
  nonce: string,
  apiSecret: string
): string {
  // SHA256(nonce + postData)
  const sha256Hash = createHash('sha256')
    .update(nonce + postData)
    .digest();

  // Decode base64 secret
  const secretBuffer = Buffer.from(apiSecret, 'base64');

  // HMAC-SHA512(urlPath + SHA256(nonce + postData))
  const hmac = createHmac('sha512', secretBuffer)
    .update(Buffer.concat([Buffer.from(urlPath), sha256Hash]))
    .digest('base64');

  return hmac;
}

/**
 * Generate nonce for Kraken API calls
 * Kraken requires monotonically increasing nonces
 */
let lastNonce = 0;

export function generateNonce(): string {
  const now = Date.now() * 1000; // microseconds
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce.toString();
}

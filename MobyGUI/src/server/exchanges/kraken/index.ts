// Kraken Exchange Adapter
export { KrakenAdapterFactory, default } from './factory.js';
export { KrakenRestClient } from './restClient.js';
export { KrakenWsClient } from './wsClient.js';
export { normalizeKrakenAsset, parseKrakenPair, toKrakenAsset } from './normalize.js';
export { RateLimiter, globalRateLimiter } from './rateLimiter.js';
export { generateSignature, generateNonce } from './sign.js';

// Re-export the client pool (Kraken-specific for now, will be generalized)
export { KrakenClientPool, getClientPool } from './clientPool.js';

/**
 * Gate.io Exchange Adapter
 *
 * Exports all Gate.io-specific implementations.
 */

export { GateRestClient } from './restClient.js';
export { GateWsClient } from './wsClient.js';
export { GateAdapterFactory } from './factory.js';
export {
  normalizeGateAsset,
  parseGatePair,
  toGatePair,
  convertPairFormat,
} from './normalize.js';
export {
  generateHeaders,
  signRequest,
  generateWsAuth,
  generateTimestamp,
  hashBody,
} from './sign.js';

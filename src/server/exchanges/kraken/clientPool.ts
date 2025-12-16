import { KrakenRestClient } from './restClient.js';
import {
  getActiveApiKeys,
  getAllApiKeys,
  getApiKeyById,
  markApiKeyUsed,
  markApiKeyRateLimited,
  markApiKeyInvalid,
  markApiKeyValid,
  clearApiKeyRateLimit,
  getTierConfig,
  type ApiKeyRecord,
  type ApiKeyTier,
} from '../../db/repositories.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('client-pool');

// Error categories
const RATE_LIMIT_ERRORS = [
  'EAPI:Rate limit exceeded',
  'EOrder:Rate limit exceeded',
  'EOrder:Domain rate limit exceeded',
  'EAuth:Rate limit exceeded',
  'EAuth:Too many requests',
  'EGeneral:Temporary lockout',
];

const AUTH_ERRORS = [
  'EAPI:Invalid key',
  'EAPI:Invalid signature',
  'EAPI:Invalid nonce',
  'EGeneral:Permission denied',
  'EAccount:Invalid permissions',
  'EAuth:Account temporary disabled',
  'EAuth:Account unconfirmed',
];

const SERVICE_ERRORS = [
  'EService:Unavailable',
  'EService:Market in cancel_only mode',
  'EService:Market in post_only mode',
  'EService:Deadline elapsed',
  'EGeneral:Internal error',
];

export type ErrorCategory = 'rate_limit' | 'auth' | 'service' | 'funding' | 'unknown';

export function categorizeError(errorMessage: string): ErrorCategory {
  if (RATE_LIMIT_ERRORS.some((e) => errorMessage.includes(e))) {
    return 'rate_limit';
  }
  if (AUTH_ERRORS.some((e) => errorMessage.includes(e))) {
    return 'auth';
  }
  if (SERVICE_ERRORS.some((e) => errorMessage.includes(e))) {
    return 'service';
  }
  if (errorMessage.includes('EFunding:') || errorMessage.includes('EOrder:Insufficient')) {
    return 'funding';
  }
  return 'unknown';
}

// Parse throttle timestamp from "EService: Throttled: [UNIX timestamp]"
function parseThrottleTimestamp(errorMessage: string): number | null {
  const match = errorMessage.match(/EService:\s*Throttled:\s*(\d+)/i);
  if (match) {
    return parseInt(match[1], 10) * 1000; // Convert to ms
  }
  return null;
}

interface PooledClient {
  keyId: string;
  client: KrakenRestClient;
}

export interface KeySelectionResult {
  keyId: string;
  client: KrakenRestClient;
  estimatedCounter: number;
  headroom: number;
}

export class KrakenClientPool {
  private clients: Map<string, KrakenRestClient> = new Map();
  private roundRobinIndex: number = 0;

  constructor() {
    this.refreshClients();
  }

  /**
   * Refresh the client pool from database
   */
  refreshClients(): void {
    const keys = getActiveApiKeys();
    const currentIds = new Set(this.clients.keys());
    const newIds = new Set(keys.map((k) => k.id));

    // Remove clients for keys that no longer exist or are inactive
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.clients.delete(id);
        logger.info({ keyId: id }, 'Removed client from pool');
      }
    }

    // Add clients for new keys
    for (const key of keys) {
      if (!this.clients.has(key.id)) {
        const client = new KrakenRestClient({
          apiKey: key.apiKey,
          apiSecret: key.apiSecret,
        });
        this.clients.set(key.id, client);
        logger.info({ keyId: key.id, name: key.name }, 'Added client to pool');
      }
    }
  }

  /**
   * Get the number of active clients in the pool
   */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Check if the pool has any available clients
   */
  hasAvailableClients(): boolean {
    return this.getAvailableKeys().length > 0;
  }

  /**
   * Get all keys that are currently available (not rate limited)
   */
  private getAvailableKeys(): ApiKeyRecord[] {
    const now = Date.now();
    const keys = getActiveApiKeys();

    return keys.filter((key) => {
      // Skip if rate limited
      if (key.rateLimitedUntil && key.rateLimitedUntil > now) {
        return false;
      }
      // Clear expired rate limit
      if (key.rateLimitedUntil && key.rateLimitedUntil <= now) {
        clearApiKeyRateLimit(key.id);
      }
      return true;
    });
  }

  /**
   * Calculate the current estimated counter for a key (with decay)
   */
  private getEstimatedCounter(key: ApiKeyRecord): number {
    if (!key.lastUsedAt) return 0;

    const now = Date.now();
    const elapsed = (now - key.lastUsedAt) / 1000;
    const config = getTierConfig(key.tier);
    const decayed = key.estimatedCounter - elapsed * config.decayRate;
    return Math.max(0, decayed);
  }

  /**
   * Get available headroom for a key
   */
  private getHeadroom(key: ApiKeyRecord): number {
    const config = getTierConfig(key.tier);
    const counter = this.getEstimatedCounter(key);
    return config.maxCounter - counter;
  }

  /**
   * Select the best available key using smart selection
   * Strategy: Pick the key with the most headroom
   */
  selectBestKey(): KeySelectionResult | null {
    const availableKeys = this.getAvailableKeys();

    if (availableKeys.length === 0) {
      logger.warn('No available API keys');
      return null;
    }

    // Sort by headroom (most headroom first)
    const keysWithHeadroom = availableKeys.map((key) => ({
      key,
      counter: this.getEstimatedCounter(key),
      headroom: this.getHeadroom(key),
    }));

    keysWithHeadroom.sort((a, b) => b.headroom - a.headroom);

    // Pick the key with most headroom, but ensure we have at least 1 unit of headroom
    const best = keysWithHeadroom.find((k) => k.headroom >= 1);

    if (!best) {
      // All keys are near their limit, pick the one closest to recovery
      const byRecovery = keysWithHeadroom.sort((a, b) => a.counter - b.counter);
      const closest = byRecovery[0];
      logger.warn(
        { keyId: closest.key.id, counter: closest.counter, headroom: closest.headroom },
        'All keys near rate limit, using least loaded'
      );
      const client = this.clients.get(closest.key.id);
      if (!client) return null;
      return {
        keyId: closest.key.id,
        client,
        estimatedCounter: closest.counter,
        headroom: closest.headroom,
      };
    }

    const client = this.clients.get(best.key.id);
    if (!client) return null;

    logger.debug(
      { keyId: best.key.id, counter: best.counter, headroom: best.headroom },
      'Selected API key'
    );

    return {
      keyId: best.key.id,
      client,
      estimatedCounter: best.counter,
      headroom: best.headroom,
    };
  }

  /**
   * Select a key using simple round-robin (for less critical calls)
   */
  selectRoundRobin(): KeySelectionResult | null {
    const availableKeys = this.getAvailableKeys();

    if (availableKeys.length === 0) {
      return null;
    }

    this.roundRobinIndex = this.roundRobinIndex % availableKeys.length;
    const key = availableKeys[this.roundRobinIndex];
    this.roundRobinIndex++;

    const client = this.clients.get(key.id);
    if (!client) return null;

    return {
      keyId: key.id,
      client,
      estimatedCounter: this.getEstimatedCounter(key),
      headroom: this.getHeadroom(key),
    };
  }

  /**
   * Get a specific client by key ID
   */
  getClient(keyId: string): KrakenRestClient | null {
    return this.clients.get(keyId) || null;
  }

  /**
   * Record that a key was used (increment counter)
   */
  recordUsage(keyId: string, counterIncrement: number = 1): void {
    markApiKeyUsed(keyId, counterIncrement);
  }

  /**
   * Handle an error from a Kraken API call
   * Returns true if the error was handled (key marked), false otherwise
   */
  handleError(keyId: string, error: Error | string): { category: ErrorCategory; handled: boolean } {
    const errorMessage = error instanceof Error ? error.message : error;
    const category = categorizeError(errorMessage);

    switch (category) {
      case 'rate_limit': {
        // Check for throttle timestamp
        const throttleUntil = parseThrottleTimestamp(errorMessage);
        const limitUntil = throttleUntil || Date.now() + 120_000; // Default 2 min
        markApiKeyRateLimited(keyId, limitUntil);
        logger.warn({ keyId, until: new Date(limitUntil).toISOString() }, 'API key rate limited');
        return { category, handled: true };
      }

      case 'auth': {
        markApiKeyInvalid(keyId, errorMessage);
        logger.error({ keyId, error: errorMessage }, 'API key marked invalid');
        this.clients.delete(keyId);
        return { category, handled: true };
      }

      case 'service': {
        // Service errors are transient, don't mark the key
        logger.warn({ keyId, error: errorMessage }, 'Kraken service error');
        return { category, handled: false };
      }

      case 'funding': {
        // Funding errors are account-level, not key-level
        logger.warn({ keyId, error: errorMessage }, 'Funding/order error');
        return { category, handled: false };
      }

      default:
        logger.error({ keyId, error: errorMessage }, 'Unknown Kraken error');
        return { category, handled: false };
    }
  }

  /**
   * Execute a Kraken API call with automatic key selection and error handling
   */
  async execute<T>(
    operation: (client: KrakenRestClient) => Promise<T>,
    options: {
      counterIncrement?: number;
      retryOnRateLimit?: boolean;
      maxRetries?: number;
    } = {}
  ): Promise<T> {
    const { counterIncrement = 1, retryOnRateLimit = true, maxRetries = 3 } = options;

    let lastError: Error | null = null;
    let attempts = 0;

    while (attempts < maxRetries) {
      const selection = this.selectBestKey();

      if (!selection) {
        throw new Error('No available API keys');
      }

      try {
        const result = await operation(selection.client);
        this.recordUsage(selection.keyId, counterIncrement);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const { category, handled } = this.handleError(selection.keyId, lastError);

        if (category === 'rate_limit' && retryOnRateLimit && this.hasAvailableClients()) {
          attempts++;
          logger.info({ attempts, maxRetries }, 'Retrying with different key after rate limit');
          continue;
        }

        if (category === 'auth' && this.hasAvailableClients()) {
          attempts++;
          logger.info({ attempts, maxRetries }, 'Retrying with different key after auth error');
          continue;
        }

        // Don't retry for other errors
        throw lastError;
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Get status information for all keys
   */
  getStatus(): Array<{
    id: string;
    name: string;
    tier: ApiKeyTier;
    isActive: boolean;
    isValid: boolean;
    estimatedCounter: number;
    headroom: number;
    rateLimitedUntil: number | null;
    lastError: string | null;
  }> {
    // Get all keys (including invalid/inactive) for status display
    const allKeys: ApiKeyRecord[] = getAllApiKeys();

    return allKeys.map((key) => {
      const config = getTierConfig(key.tier);
      const counter = this.getEstimatedCounter(key);
      return {
        id: key.id,
        name: key.name,
        tier: key.tier,
        isActive: key.isActive,
        isValid: key.isValid,
        estimatedCounter: Math.round(counter * 100) / 100,
        headroom: Math.round((config.maxCounter - counter) * 100) / 100,
        rateLimitedUntil: key.rateLimitedUntil,
        lastError: key.lastError,
      };
    });
  }
}

// Singleton instance
let poolInstance: KrakenClientPool | null = null;

export function getClientPool(): KrakenClientPool {
  if (!poolInstance) {
    poolInstance = new KrakenClientPool();
  }
  return poolInstance;
}

export function resetClientPool(): void {
  poolInstance = null;
}

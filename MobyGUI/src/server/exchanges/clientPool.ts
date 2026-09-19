/**
 * Multi-Exchange Client Pool
 *
 * Manages REST and WebSocket clients for all exchanges.
 * Each exchange has its own pool of API keys with rate limiting.
 */

import { createChildLogger } from '../utils/logger.js';
import {
  getActiveApiKeys,
  getAllApiKeys,
  getApiKeyById,
  markApiKeyUsed,
  markApiKeyRateLimited,
  markApiKeyInvalid,
  clearApiKeyRateLimit,
  getTierConfig,
  type ApiKeyRecord,
  type ApiKeyTier,
} from '../db/repositories.js';
import { getExchangeAdapter, getExchangeRegistry } from './registry.js';
import type {
  ExchangeId,
  ExchangeRestClient,
  ExchangeWsClient,
  ExchangeAdapterFactory,
  ErrorCategory,
} from './types.js';

const logger = createChildLogger('client-pool');

/**
 * Sanitize error messages to remove potential API keys or secrets
 * Exchange error messages sometimes contain parts of API keys/secrets
 */
function sanitizeErrorMessage(error: string): string {
  // Remove potential API keys (long alphanumeric strings)
  // Most API keys are 20-64 chars of alphanumeric/symbols
  let sanitized = error;

  // Remove long hex strings (40+ chars) - potential keys/secrets
  sanitized = sanitized.replace(/[a-f0-9]{40,}/gi, '[REDACTED]');

  // Remove base64-like strings (32+ chars) - potential secrets
  sanitized = sanitized.replace(/[A-Za-z0-9+/=]{32,}/g, '[REDACTED]');

  // Remove anything that looks like an API key pattern (mixed case alphanumeric 20+ chars)
  sanitized = sanitized.replace(/[A-Za-z0-9]{20,}/g, '[REDACTED]');

  return sanitized;
}

export interface KeySelectionResult {
  keyId: string;
  client: ExchangeRestClient;
  estimatedCounter: number;
  headroom: number;
}

/**
 * Client pool for a single exchange
 */
export class ExchangeClientPool {
  private readonly exchangeId: ExchangeId;
  private readonly factory: ExchangeAdapterFactory;
  private clients: Map<string, ExchangeRestClient> = new Map();
  private roundRobinIndex: number = 0;
  private credentials = new Map<string, string>();

  constructor(exchangeId: ExchangeId) {
    this.exchangeId = exchangeId;
    const factory = getExchangeAdapter(exchangeId);
    if (!factory) {
      throw new Error(`No adapter registered for exchange: ${exchangeId}`);
    }
    this.factory = factory;
    this.refreshClients();
  }

  /**
   * Refresh the client pool from database
   */
  refreshClients(): void {
    const keys = getActiveApiKeys(this.exchangeId);
    const currentIds = new Set(this.clients.keys());
    const newIds = new Set(keys.map((k) => k.id));

    // Remove clients for keys that no longer exist or are inactive
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.clients.delete(id);
        this.credentials.delete(id);
        logger.info({ exchangeId: this.exchangeId, keyId: id }, 'Removed client from pool');
      }
    }

    // Add clients for new keys
    for (const key of keys) {
      const fingerprint = `${key.apiKey}:${key.apiSecret}`;
      if (this.credentials.get(key.id) !== fingerprint) this.clients.delete(key.id);
      if (!this.clients.has(key.id)) {
        this.credentials.set(key.id, fingerprint);
        // Extract passphrase if stored with secret (format: secret:passphrase)
        let apiSecret = key.apiSecret;
        let passphrase: string | undefined;
        if (this.factory.requiresPassphrase() && key.apiSecret.includes(':')) {
          const parts = key.apiSecret.split(':');
          apiSecret = parts[0];
          passphrase = parts.slice(1).join(':');
        }

        const client = this.factory.createRestClient({
          apiKey: key.apiKey,
          apiSecret,
          passphrase,
          beforeRequest: () => {
            const current = getApiKeyById(key.id);
            if (!current?.isActive || !current.isValid || current.apiKey !== key.apiKey || current.apiSecret !== key.apiSecret) {
              throw new Error('API key changed or disabled before request');
            }
          },
        });
        this.clients.set(key.id, client);
        logger.info({ exchangeId: this.exchangeId, keyId: key.id, name: key.name }, 'Added client to pool');
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
    const keys = getActiveApiKeys(this.exchangeId);

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
      logger.warn({ exchangeId: this.exchangeId }, 'No available API keys');
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
        { exchangeId: this.exchangeId, keyId: closest.key.id, counter: closest.counter, headroom: closest.headroom },
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
      { exchangeId: this.exchangeId, keyId: best.key.id, counter: best.counter, headroom: best.headroom },
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
  getClient(keyId: string): ExchangeRestClient | null {
    return this.clients.get(keyId) || null;
  }

  /**
   * Record that a key was used (increment counter)
   */
  recordUsage(keyId: string, counterIncrement: number = 1): void {
    markApiKeyUsed(keyId, counterIncrement);
  }

  /**
   * Handle an error from an exchange API call
   * Returns true if the error was handled (key marked), false otherwise
   */
  handleError(keyId: string, error: Error | string): { category: ErrorCategory; handled: boolean } {
    const errorMessage = error instanceof Error ? error.message : error;
    const category = this.factory.categorizeError(errorMessage);

    // Sanitize error messages before logging to prevent API key leakage
    const safeErrorMessage = sanitizeErrorMessage(errorMessage);

    switch (category) {
      case 'rate_limit': {
        const limitUntil = Date.now() + 120_000; // Default 2 min
        markApiKeyRateLimited(keyId, limitUntil);
        logger.warn({ exchangeId: this.exchangeId, keyId, until: new Date(limitUntil).toISOString() }, 'API key rate limited');
        return { category, handled: true };
      }

      case 'auth': {
        // Store sanitized error in database too
        markApiKeyInvalid(keyId, safeErrorMessage);
        logger.error({ exchangeId: this.exchangeId, keyId, error: safeErrorMessage }, 'API key marked invalid');
        this.clients.delete(keyId);
        return { category, handled: true };
      }

      case 'service': {
        // Service errors are transient, don't mark the key
        logger.warn({ exchangeId: this.exchangeId, keyId, error: safeErrorMessage }, 'Exchange service error');
        return { category, handled: false };
      }

      case 'funding': {
        // Funding errors are account-level, not key-level
        logger.warn({ exchangeId: this.exchangeId, keyId, error: safeErrorMessage }, 'Funding/order error');
        return { category, handled: false };
      }

      default:
        logger.error({ exchangeId: this.exchangeId, keyId, error: safeErrorMessage }, 'Unknown exchange error');
        return { category, handled: false };
    }
  }

  /**
   * Execute an exchange API call with automatic key selection and error handling
   */
  async execute<T>(
    operation: (client: ExchangeRestClient) => Promise<T>,
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
        throw new Error(`No available API keys for ${this.exchangeId}`);
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
          logger.info({ exchangeId: this.exchangeId, attempts, maxRetries }, 'Retrying with different key after rate limit');
          continue;
        }

        if (category === 'auth' && this.hasAvailableClients()) {
          attempts++;
          logger.info({ exchangeId: this.exchangeId, attempts, maxRetries }, 'Retrying with different key after auth error');
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
    const allKeys = getAllApiKeys(this.exchangeId);

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

/**
 * Multi-Exchange Client Pool Manager
 *
 * Manages separate pools for each exchange.
 */
class MultiExchangeClientPool {
  private pools: Map<ExchangeId, ExchangeClientPool> = new Map();

  /**
   * Get or create a pool for an exchange
   */
  getPool(exchangeId: ExchangeId): ExchangeClientPool {
    let pool = this.pools.get(exchangeId);
    if (!pool) {
      pool = new ExchangeClientPool(exchangeId);
      this.pools.set(exchangeId, pool);
    }
    return pool;
  }

  /**
   * Check if an exchange has any available clients
   */
  hasAvailableClients(exchangeId: ExchangeId): boolean {
    const pool = this.pools.get(exchangeId);
    return pool ? pool.hasAvailableClients() : false;
  }

  /**
   * Check if any exchange has available clients
   */
  hasAnyClients(): boolean {
    for (const pool of this.pools.values()) {
      if (pool.hasAvailableClients()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Refresh all pools from database
   */
  refreshAll(): void {
    for (const pool of this.pools.values()) {
      pool.refreshClients();
    }
  }

  /**
   * Get status for all exchanges
   */
  getAllStatus(): Record<ExchangeId, ReturnType<ExchangeClientPool['getStatus']>> {
    const result: Partial<Record<ExchangeId, ReturnType<ExchangeClientPool['getStatus']>>> = {};
    for (const [exchangeId, pool] of this.pools) {
      result[exchangeId] = pool.getStatus();
    }
    return result as Record<ExchangeId, ReturnType<ExchangeClientPool['getStatus']>>;
  }
}

// Singleton instance
let poolManager: MultiExchangeClientPool | null = null;

export function getPoolManager(): MultiExchangeClientPool {
  if (!poolManager) {
    poolManager = new MultiExchangeClientPool();
  }
  return poolManager;
}

export function getClientPool(exchangeId: ExchangeId): ExchangeClientPool {
  return getPoolManager().getPool(exchangeId);
}

export function resetPoolManager(): void {
  poolManager = null;
}

// Re-export for backward compatibility with existing Kraken code
export { ExchangeClientPool as KrakenClientPool };

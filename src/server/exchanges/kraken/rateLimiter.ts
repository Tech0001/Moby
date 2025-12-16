import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger('rate-limiter');

/**
 * Token bucket rate limiter for Kraken API
 * Kraken uses a counter-based rate limit that decrements over time
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly costPerCall: number;

  constructor(options: {
    maxTokens?: number;
    refillRate?: number;
    costPerCall?: number;
  } = {}) {
    this.maxTokens = options.maxTokens ?? 15; // Kraken default limit
    this.refillRate = options.refillRate ?? 0.33; // ~1 token per 3 seconds
    this.costPerCall = options.costPerCall ?? 1;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Check if we can make a call (non-blocking)
   */
  canCall(cost: number = this.costPerCall): boolean {
    this.refill();
    return this.tokens >= cost;
  }

  /**
   * Consume tokens for a call
   * Returns true if successful, false if rate limited
   */
  tryConsume(cost: number = this.costPerCall): boolean {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }

    return false;
  }

  /**
   * Wait until we can make a call
   */
  async waitForToken(cost: number = this.costPerCall): Promise<void> {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return;
    }

    // Calculate wait time
    const tokensNeeded = cost - this.tokens;
    const waitMs = Math.ceil((tokensNeeded / this.refillRate) * 1000);

    logger.debug({ tokensNeeded, waitMs }, 'Rate limited, waiting');

    await new Promise((resolve) => setTimeout(resolve, waitMs));

    // Refill and consume after waiting
    this.refill();
    this.tokens -= cost;
  }

  /**
   * Get current token count (for monitoring)
   */
  getTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reset rate limiter (e.g., after long pause)
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

// Global rate limiter instance
export const globalRateLimiter = new RateLimiter();

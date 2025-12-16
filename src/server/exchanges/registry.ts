import type { ExchangeId, ExchangeAdapterFactory, ExchangeRegistry } from './types.js';

/**
 * Singleton registry for all exchange adapters
 */
class ExchangeRegistryImpl implements ExchangeRegistry {
  private adapters: Map<ExchangeId, ExchangeAdapterFactory> = new Map();

  register(factory: ExchangeAdapterFactory): void {
    if (this.adapters.has(factory.exchangeId)) {
      throw new Error(`Exchange adapter already registered: ${factory.exchangeId}`);
    }
    this.adapters.set(factory.exchangeId, factory);
  }

  get(exchangeId: ExchangeId): ExchangeAdapterFactory | undefined {
    return this.adapters.get(exchangeId);
  }

  getAll(): ExchangeAdapterFactory[] {
    return Array.from(this.adapters.values());
  }

  getIds(): ExchangeId[] {
    return Array.from(this.adapters.keys());
  }

  has(exchangeId: ExchangeId): boolean {
    return this.adapters.has(exchangeId);
  }
}

// Singleton instance
let registryInstance: ExchangeRegistryImpl | null = null;

/**
 * Get the exchange registry singleton
 */
export function getExchangeRegistry(): ExchangeRegistry {
  if (!registryInstance) {
    registryInstance = new ExchangeRegistryImpl();
  }
  return registryInstance;
}

/**
 * Register an exchange adapter in the registry
 */
export function registerExchange(factory: ExchangeAdapterFactory): void {
  getExchangeRegistry().register(factory);
}

/**
 * Get an exchange adapter by ID
 */
export function getExchangeAdapter(exchangeId: ExchangeId): ExchangeAdapterFactory | undefined {
  return getExchangeRegistry().get(exchangeId);
}

/**
 * Check if an exchange is registered
 */
export function hasExchange(exchangeId: ExchangeId): boolean {
  return getExchangeRegistry().has(exchangeId);
}

/**
 * Get all registered exchange IDs
 */
export function getRegisteredExchangeIds(): ExchangeId[] {
  return getExchangeRegistry().getIds();
}

import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { createChildLogger } from '../utils/logger.js';
import {
  requireAuth,
  checkSetupNeeded,
  registerUser,
  authenticateUser,
  isSetupComplete,
} from './auth.js';
import {
  getAllAssetStates,
  getActiveWithdrawalJobs,
  getRecentFills,
  isEnabled,
  setEnabled,
  getAppStateValue,
  setAppStateValue,
  getAllExchangeAddresses,
  upsertExchangeAddress,
  deleteRemovedAddresses,
  getAllApiKeys,
  getApiKeyById,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  markApiKeyValid,
  clearApiKeyRateLimit,
  hasAnyApiKeys,
  getAllAssetConfigs,
  getAssetConfig,
  upsertAssetConfig,
  deleteAssetConfig,
  setAssetConfigEnabled,
  type ApiKeyTier,
} from '../db/repositories.js';
import { getClientPool } from '../exchanges/clientPool.js';
import { getExchangeRegistry } from '../exchanges/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { ExchangeId } from '../domain/types.js';

const logger = createChildLogger('routes');

// Default to kraken for backward compatibility
const DEFAULT_EXCHANGE: ExchangeId = 'kraken';

export interface RoutesContext {
  config: AppConfig;
  reloadConfig: () => Promise<void>;
}

export function createRoutes(context: RoutesContext): Router {
  const router = Router();

  // ============== Setup / Auth Routes ==============

  // Check if setup is needed
  router.get('/api/setup/status', (req: Request, res: Response) => {
    res.json({
      setupComplete: isSetupComplete(),
      hasApiKeys: hasAnyApiKeys(),
    });
  });

  // Initial setup - create first user
  router.post('/api/setup', async (req: Request, res: Response) => {
    if (isSetupComplete()) {
      res.status(400).json({ error: 'Setup already complete' });
      return;
    }

    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required' });
      return;
    }

    const result = await registerUser(username, password);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    // Auto-login after setup
    req.session.userId = result.userId;
    req.session.username = username;

    res.json({ success: true });
  });

  // Login
  router.post('/api/auth/login', async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required' });
      return;
    }

    const result = await authenticateUser(username, password);

    if (!result.success) {
      res.status(401).json({ error: result.error });
      return;
    }

    req.session.userId = result.userId;
    req.session.username = username;

    res.json({ success: true });
  });

  // Logout
  router.post('/api/auth/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        logger.error({ error: err }, 'Logout failed');
        res.status(500).json({ error: 'Logout failed' });
        return;
      }
      res.json({ success: true });
    });
  });

  // Get current user
  router.get('/api/auth/me', requireAuth, (req: Request, res: Response) => {
    res.json({
      userId: req.session.userId,
      username: req.session.username,
    });
  });

  // ============== Protected Routes ==============

  // Get list of exchanges with API keys configured
  router.get('/api/exchanges', requireAuth, (req: Request, res: Response) => {
    const registry = getExchangeRegistry();
    const exchangeIds = registry.getAll().map((a) => a.exchangeId);

    // Filter to exchanges that have active API keys
    const enabledExchanges = exchangeIds.filter((id) => hasAnyApiKeys(id));

    res.json({
      exchanges: enabledExchanges,
      default: DEFAULT_EXCHANGE,
    });
  });

  // Get all supported exchanges and their configuration (for UI)
  router.get('/api/exchanges/available', requireAuth, (req: Request, res: Response) => {
    const registry = getExchangeRegistry();
    const exchanges = registry.getAll().map((adapter) => ({
      id: adapter.exchangeId,
      name: adapter.displayName,
      requiresPassphrase: adapter.requiresPassphrase(),
      defaultTier: adapter.getDefaultTier(),
      tiers: adapter.getAvailableTiers(),
    }));
    res.json({ exchanges });
  });

  // Get application status (optionally filtered by exchange)
  router.get('/api/status', requireAuth, (req: Request, res: Response) => {
    const exchange = (req.query.exchange as ExchangeId) || undefined;
    const assetStates = getAllAssetStates(exchange);
    const activeJobs = getActiveWithdrawalJobs(exchange);
    const enabled = isEnabled();
    const pool = exchange ? getClientPool(exchange) : null;

    res.json({
      enabled,
      hasApiKeys: hasAnyApiKeys(exchange),
      apiKeysCount: pool?.size ?? 0,
      assets: assetStates.map((state) => ({
        exchange: state.exchange,
        asset: state.asset,
        pendingAmount: state.pendingAmount,
        rrIndex: state.rrIndex,
        lastWithdrawAt: state.lastWithdrawAt,
        consecutiveFailures: state.consecutiveFailures,
        backoffUntil: state.backoffUntil,
      })),
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        exchange: job.exchange,
        asset: job.asset,
        amount: job.amount,
        status: job.status,
        destKey: job.destKey,
        createdAt: job.createdAt,
        exchangeRef: job.exchangeRef,
        txid: job.txid,
      })),
    });
  });

  // Start/Stop toggle
  router.post('/api/control/start', requireAuth, (req: Request, res: Response) => {
    setEnabled(true);
    logger.info('Sweeper enabled via UI');
    res.json({ enabled: true });
  });

  router.post('/api/control/stop', requireAuth, (req: Request, res: Response) => {
    setEnabled(false);
    logger.info('Sweeper disabled via UI');
    res.json({ enabled: false });
  });

  // ============== API Keys Management (Multi-Key) ==============

  // Get all API keys (optionally filtered by exchange)
  router.get('/api/keys', requireAuth, (req: Request, res: Response) => {
    const exchangeFilter = req.query.exchange as ExchangeId | undefined;

    // Get all registered exchanges
    const registry = getExchangeRegistry();
    const exchangeIds = exchangeFilter
      ? [exchangeFilter]
      : registry.getAll().map((a) => a.exchangeId);

    // Collect keys from all exchanges
    const allKeys: Array<{
      id: string;
      name: string;
      exchange: ExchangeId;
      tier: string;
      isActive: boolean;
      isValid: boolean;
      estimatedCounter: number;
      headroom: number;
      rateLimitedUntil: number | null;
      lastError: string | null;
    }> = [];

    for (const exchangeId of exchangeIds) {
      try {
        const pool = getClientPool(exchangeId);
        const status = pool.getStatus();
        for (const key of status) {
          allKeys.push({
            id: key.id,
            name: key.name,
            exchange: exchangeId,
            tier: key.tier,
            isActive: key.isActive,
            isValid: key.isValid,
            estimatedCounter: key.estimatedCounter,
            headroom: key.headroom,
            rateLimitedUntil: key.rateLimitedUntil,
            lastError: key.lastError,
          });
        }
      } catch (err) {
        logger.error({ exchangeId, error: err }, 'Failed to get keys for exchange');
      }
    }

    res.json({ keys: allKeys });
  });

  // Add a new API key
  router.post('/api/keys', requireAuth, async (req: Request, res: Response) => {
    const { name, apiKey, apiSecret, passphrase, tier, exchange: reqExchange } = req.body;
    const exchange: ExchangeId = reqExchange || DEFAULT_EXCHANGE;

    if (!name || !apiKey || !apiSecret) {
      res.status(400).json({ error: 'Name, API key, and secret required' });
      return;
    }

    // Get the exchange adapter
    const registry = getExchangeRegistry();
    const adapter = registry.get(exchange);
    if (!adapter) {
      res.status(400).json({ error: `Exchange ${exchange} not supported` });
      return;
    }

    // Check if passphrase is required
    if (adapter.requiresPassphrase() && !passphrase) {
      res.status(400).json({ error: `${adapter.displayName} requires a passphrase` });
      return;
    }

    // Use exchange-specific tier or default
    const keyTier: ApiKeyTier = tier || adapter.getDefaultTier();

    // Test the connection first using the exchange adapter
    try {
      const restClient = adapter.createRestClient({
        apiKey,
        apiSecret,
        passphrase,
        dryRun: false,
      });

      const testResult = await restClient.testConnection();

      if (!testResult.success) {
        res.status(400).json({
          error: 'API key test failed',
          details: testResult.error,
        });
        return;
      }

      // Save the key (passphrase stored encrypted in apiSecret if present)
      const id = uuid();
      const secretToStore = passphrase ? `${apiSecret}:${passphrase}` : apiSecret;
      const newKey = createApiKey(id, exchange, name, apiKey, secretToStore, keyTier);

      // Refresh the client pool
      const pool = getClientPool(exchange);
      pool.refreshClients();

      logger.info({ keyId: id, name, exchange }, 'API key added');
      res.json({
        success: true,
        key: {
          id: newKey.id,
          name: newKey.name,
          exchange,
          tier: newKey.tier,
        },
        hasBalance: testResult.hasBalance,
        hasWithdraw: testResult.hasWithdraw,
      });
    } catch (error) {
      res.status(400).json({
        error: 'Failed to validate API key',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Update an API key
  router.put('/api/keys/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, tier, isActive } = req.body;

    const key = getApiKeyById(id);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const updates: { name?: string; tier?: ApiKeyTier; isActive?: boolean } = {};
    if (name !== undefined) updates.name = name;
    if (tier !== undefined) updates.tier = tier;
    if (isActive !== undefined) updates.isActive = isActive;

    updateApiKey(id, updates);

    // Refresh pool for the key's exchange
    const pool = getClientPool(key.exchange);
    pool.refreshClients();

    logger.info({ keyId: id, updates }, 'API key updated');
    res.json({ success: true });
  });

  // Delete an API key
  router.delete('/api/keys/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;

    const key = getApiKeyById(id);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const exchange = key.exchange;
    deleteApiKey(id);

    // Refresh pool
    const pool = getClientPool(exchange);
    pool.refreshClients();

    logger.info({ keyId: id }, 'API key deleted');
    res.json({ success: true });
  });

  // Test a specific API key
  router.post('/api/keys/:id/test', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;

    const key = getApiKeyById(id);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    try {
      const registry = getExchangeRegistry();
      const adapter = registry.get(key.exchange);
      if (!adapter) {
        res.status(400).json({ error: `Exchange ${key.exchange} not supported` });
        return;
      }

      // Extract passphrase if stored with secret (format: secret:passphrase)
      let apiSecret = key.apiSecret;
      let passphrase: string | undefined;
      if (adapter.requiresPassphrase() && key.apiSecret.includes(':')) {
        const parts = key.apiSecret.split(':');
        apiSecret = parts[0];
        passphrase = parts.slice(1).join(':');
      }

      const restClient = adapter.createRestClient({
        apiKey: key.apiKey,
        apiSecret,
        passphrase,
        dryRun: false,
      });

      const result = await restClient.testConnection();

      if (result.success && !key.isValid) {
        // Key is now valid, clear error state
        markApiKeyValid(id);
        const pool = getClientPool(key.exchange);
        pool.refreshClients();
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Clear rate limit for a specific key
  router.post('/api/keys/:id/clear-limit', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;

    const key = getApiKeyById(id);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    clearApiKeyRateLimit(id);
    logger.info({ keyId: id }, 'Rate limit cleared manually');
    res.json({ success: true });
  });

  // Re-enable an invalid key (after user fixes the issue)
  router.post('/api/keys/:id/revalidate', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;

    const key = getApiKeyById(id);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    try {
      const registry = getExchangeRegistry();
      const adapter = registry.get(key.exchange);
      if (!adapter) {
        res.status(400).json({ error: `Exchange ${key.exchange} not supported` });
        return;
      }

      // Extract passphrase if stored with secret (format: secret:passphrase)
      let apiSecret = key.apiSecret;
      let passphrase: string | undefined;
      if (adapter.requiresPassphrase() && key.apiSecret.includes(':')) {
        const parts = key.apiSecret.split(':');
        apiSecret = parts[0];
        passphrase = parts.slice(1).join(':');
      }

      const restClient = adapter.createRestClient({
        apiKey: key.apiKey,
        apiSecret,
        passphrase,
        dryRun: false,
      });

      const result = await restClient.testConnection();

      if (!result.success) {
        res.status(400).json({
          error: 'Key validation failed',
          details: result.error,
        });
        return;
      }

      markApiKeyValid(id);
      const pool = getClientPool(key.exchange);
      pool.refreshClients();

      logger.info({ keyId: id }, 'API key revalidated');
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({
        error: 'Failed to validate API key',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get recent fills (optionally filtered by exchange)
  router.get('/api/fills', requireAuth, (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const exchange = (req.query.exchange as ExchangeId) || undefined;
      const fills = getRecentFills(limit, exchange);
      res.json(fills);
    } catch (error) {
      logger.error({ error }, 'Failed to get fills');
      res.status(500).json({ error: 'Failed to get fills' });
    }
  });

  // ============== Configuration ==============

  // Get current config (sanitized)
  router.get('/api/config', requireAuth, (req: Request, res: Response) => {
    const config = context.config;

    // Return config without sensitive data
    res.json({
      global: config.global,
      polling: config.polling,
      // Don't include web config with session secret
    });
  });

  // Get all asset configs (optionally filtered by exchange)
  router.get('/api/config/assets', requireAuth, (req: Request, res: Response) => {
    const exchange = req.query.exchange as ExchangeId | undefined;
    const configs = getAllAssetConfigs(exchange);
    res.json({ assets: configs });
  });

  // Get asset config for a specific exchange and asset
  router.get('/api/config/exchanges/:exchange/assets/:asset', requireAuth, (req: Request, res: Response) => {
    const { exchange, asset } = req.params;
    const config = getAssetConfig(exchange as ExchangeId, asset);

    if (!config) {
      res.status(404).json({ error: 'Asset config not found' });
      return;
    }

    res.json(config);
  });

  // Create or update asset config for an exchange
  router.put(
    '/api/config/exchanges/:exchange/assets/:asset',
    requireAuth,
    (req: Request, res: Response) => {
      const { exchange, asset } = req.params;
      const { enabled, threshold, reserve, destKeys } = req.body;

      // Basic validation
      if (typeof threshold !== 'number' || threshold <= 0) {
        res.status(400).json({ error: 'threshold must be a positive number' });
        return;
      }

      if (!Array.isArray(destKeys) || destKeys.length === 0) {
        res.status(400).json({ error: 'destKeys must be a non-empty array of wallet key names' });
        return;
      }

      // Save to database
      upsertAssetConfig(exchange as ExchangeId, asset, {
        enabled: enabled !== false,
        threshold,
        reserve: reserve ?? 0,
        destKeys,
      });

      logger.info({ exchange, asset, threshold, destKeys }, 'Asset config saved');
      res.json({ success: true });
    }
  );

  // Delete asset config
  router.delete(
    '/api/config/exchanges/:exchange/assets/:asset',
    requireAuth,
    (req: Request, res: Response) => {
      const { exchange, asset } = req.params;

      const deleted = deleteAssetConfig(exchange as ExchangeId, asset);

      if (!deleted) {
        res.status(404).json({ error: 'Asset config not found' });
        return;
      }

      logger.info({ exchange, asset }, 'Asset config deleted');
      res.json({ success: true });
    }
  );

  // Toggle asset config enabled/disabled
  router.post(
    '/api/config/exchanges/:exchange/assets/:asset/toggle',
    requireAuth,
    (req: Request, res: Response) => {
      const { exchange, asset } = req.params;
      const { enabled } = req.body;

      const config = getAssetConfig(exchange as ExchangeId, asset);
      if (!config) {
        res.status(404).json({ error: 'Asset config not found' });
        return;
      }

      setAssetConfigEnabled(exchange as ExchangeId, asset, enabled);

      logger.info({ exchange, asset, enabled }, 'Asset config toggled');
      res.json({ success: true });
    }
  );

  // Get withdrawal addresses from local database (optionally filtered by exchange)
  router.get('/api/addresses', requireAuth, (req: Request, res: Response) => {
    const exchange = (req.query.exchange as ExchangeId) || undefined;
    const addresses = getAllExchangeAddresses(exchange);
    res.json(
      addresses.map((addr) => ({
        id: addr.id,
        exchange: addr.exchange,
        asset: addr.asset,
        method: addr.method,
        key: addr.key,
        address: addr.address,
        createdAt: addr.createdAt,
        lastSeenAt: addr.lastSeenAt,
      }))
    );
  });

  // Legacy route for Kraken addresses
  router.get('/api/kraken/addresses', requireAuth, (req: Request, res: Response) => {
    const addresses = getAllExchangeAddresses('kraken');
    res.json(
      addresses.map((addr) => ({
        id: addr.id,
        asset: addr.asset,
        method: addr.method,
        key: addr.key,
        address: addr.address,
        createdAt: addr.createdAt,
        lastSeenAt: addr.lastSeenAt,
      }))
    );
  });

  // Sync withdrawal addresses for a specific exchange
  router.post('/api/exchanges/:exchange/addresses/sync', requireAuth, async (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;
    const pool = getClientPool(exchange);

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured for this exchange' });
      return;
    }

    try {
      // Fetch all addresses from exchange using pool
      const exchangeAddresses = await pool.execute((client) => client.getWithdrawAddresses());

      logger.info(
        { exchange, count: exchangeAddresses.length },
        'Fetched addresses from exchange API'
      );

      let newCount = 0;
      let restoredCount = 0;
      const currentKeys: Array<{ asset: string; key: string }> = [];

      // Upsert each address (skip entries without an address, like bank transfers)
      let skippedCount = 0;
      for (const addr of exchangeAddresses) {
        if (!addr.address) {
          logger.debug({ asset: addr.asset, key: addr.key, method: addr.method }, 'Skipping entry without address');
          skippedCount++;
          continue;
        }
        currentKeys.push({ asset: addr.asset, key: addr.key });
        const result = upsertExchangeAddress(exchange, addr.asset, addr.method, addr.key, addr.address);
        if (result.isNew) {
          newCount++;
        }
        if (result.wasRemoved) {
          restoredCount++;
        }
      }
      if (skippedCount > 0) {
        logger.info({ skippedCount }, 'Skipped entries without addresses');
      }

      // Delete addresses that no longer exist on the exchange
      const deletedCount = deleteRemovedAddresses(exchange, currentKeys);

      logger.info(
        {
          exchange,
          exchangeCount: exchangeAddresses.length,
          new: newCount,
          restored: restoredCount,
          deleted: deletedCount,
        },
        'Synced exchange withdrawal addresses'
      );

      // Return updated list
      const addresses = getAllExchangeAddresses(exchange);
      res.json({
        addresses: addresses.map((addr) => ({
          id: addr.id,
          exchange: addr.exchange,
          asset: addr.asset,
          method: addr.method,
          key: addr.key,
          address: addr.address,
          createdAt: addr.createdAt,
          lastSeenAt: addr.lastSeenAt,
        })),
        stats: {
          new: newCount,
          restored: restoredCount,
          deleted: deletedCount,
          fromExchange: exchangeAddresses.length,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Legacy route for Kraken address sync
  router.post('/api/kraken/addresses/sync', requireAuth, async (req: Request, res: Response) => {
    const exchange: ExchangeId = 'kraken';
    const pool = getClientPool(exchange);

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured' });
      return;
    }

    try {
      // Fetch all addresses from Kraken using pool
      const krakenAddresses = await pool.execute((client) => client.getWithdrawAddresses());

      logger.info(
        { count: krakenAddresses.length, addresses: krakenAddresses },
        'Fetched addresses from Kraken API'
      );

      let newCount = 0;
      let restoredCount = 0;
      const currentKeys: Array<{ asset: string; key: string }> = [];

      // Upsert each address (skip entries without an address, like bank transfers)
      let skippedCount = 0;
      for (const addr of krakenAddresses) {
        if (!addr.address) {
          logger.debug({ asset: addr.asset, key: addr.key, method: addr.method }, 'Skipping entry without address (bank transfer)');
          skippedCount++;
          continue;
        }
        logger.debug({ addr }, 'Upserting address');
        currentKeys.push({ asset: addr.asset, key: addr.key });
        const result = upsertExchangeAddress(exchange, addr.asset, addr.method, addr.key, addr.address);
        if (result.isNew) {
          newCount++;
          logger.debug({ asset: addr.asset, key: addr.key }, 'New address added');
        }
        if (result.wasRemoved) {
          restoredCount++;
          logger.debug({ asset: addr.asset, key: addr.key }, 'Removed address restored');
        }
      }
      if (skippedCount > 0) {
        logger.info({ skippedCount }, 'Skipped entries without addresses (bank transfers)');
      }

      // Delete addresses that no longer exist in Kraken
      logger.debug({ currentKeys }, 'Current keys from Kraken');
      const deletedCount = deleteRemovedAddresses(exchange, currentKeys);

      logger.info(
        {
          krakenCount: krakenAddresses.length,
          new: newCount,
          restored: restoredCount,
          deleted: deletedCount
        },
        'Synced Kraken withdrawal addresses'
      );

      // Return updated list
      const addresses = getAllExchangeAddresses(exchange);
      res.json({
        addresses: addresses.map((addr) => ({
          id: addr.id,
          asset: addr.asset,
          method: addr.method,
          key: addr.key,
          address: addr.address,
          createdAt: addr.createdAt,
          lastSeenAt: addr.lastSeenAt,
        })),
        stats: {
          new: newCount,
          restored: restoredCount,
          deleted: deletedCount,
          fromKraken: krakenAddresses.length,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get account balance (optionally filtered by exchange)
  router.get('/api/balance', requireAuth, async (req: Request, res: Response) => {
    const exchange = (req.query.exchange as ExchangeId) || DEFAULT_EXCHANGE;
    const pool = getClientPool(exchange);

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured' });
      return;
    }

    try {
      const balance = await pool.execute((client) => client.getBalance());
      res.json({ exchange, balance });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Legacy route for Kraken balance
  router.get('/api/kraken/balance', requireAuth, async (req: Request, res: Response) => {
    const pool = getClientPool('kraken');

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured' });
      return;
    }

    try {
      const balance = await pool.execute((client) => client.getBalance());
      res.json(balance);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get open orders (optionally filtered by exchange, or all exchanges)
  router.get('/api/orders', requireAuth, async (req: Request, res: Response) => {
    const exchangeParam = req.query.exchange as string | undefined;

    // Helper to fetch orders from a single exchange
    async function fetchOrdersFromExchange(exchangeId: ExchangeId) {
      const pool = getClientPool(exchangeId);
      if (!pool.hasAvailableClients()) {
        return [];
      }
      try {
        const result = await pool.execute((client) => client.getOpenOrders());
        return Object.entries(result.open || {}).map(([orderId, order]) => ({
          orderId,
          exchange: exchangeId,
          pair: order.pair,
          type: order.side,
          orderType: order.orderType,
          price: order.price,
          volume: order.volume,
          volumeExecuted: order.volumeExecuted,
          status: order.status,
          openTime: order.createdAt,
          description: order.description,
        }));
      } catch (error) {
        logger.error({ exchangeId, error }, 'Failed to fetch orders from exchange');
        return [];
      }
    }

    try {
      let allOrders: Array<{
        orderId: string;
        exchange: ExchangeId;
        pair: string;
        type: string;
        orderType: string;
        price: string;
        volume: string;
        volumeExecuted: string;
        status: string;
        openTime: number;
        description: string;
      }> = [];

      if (!exchangeParam || exchangeParam === 'all') {
        // Fetch from all registered exchanges
        const registry = getExchangeRegistry();
        const exchangeIds = registry.getAll().map((f) => f.exchangeId);
        const results = await Promise.all(exchangeIds.map(fetchOrdersFromExchange));
        allOrders = results.flat();
      } else {
        // Fetch from specific exchange
        allOrders = await fetchOrdersFromExchange(exchangeParam as ExchangeId);
      }

      // Sort by openTime descending
      allOrders.sort((a, b) => b.openTime - a.openTime);

      res.json({ orders: allOrders });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Legacy route for Kraken orders
  router.get('/api/kraken/orders', requireAuth, async (req: Request, res: Response) => {
    const pool = getClientPool('kraken');

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured' });
      return;
    }

    try {
      const result = await pool.execute((client) => client.getOpenOrders());

      // Transform to array format for easier UI consumption
      const orders = Object.entries(result.open || {}).map(([orderId, order]) => ({
        txid: orderId,
        pair: order.pair,
        type: order.side,
        orderType: order.orderType,
        price: order.price,
        volume: order.volume,
        volumeExecuted: order.volumeExecuted,
        status: order.status,
        openTime: order.createdAt,
        description: order.description,
      }));

      res.json({ orders });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

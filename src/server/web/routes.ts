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
  isEnabled,
  setEnabled,
  getAppStateValue,
  setAppStateValue,
  getAllKrakenAddresses,
  upsertKrakenAddress,
  flagRemovedAddresses,
  getAllApiKeys,
  getApiKeyById,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  markApiKeyValid,
  clearApiKeyRateLimit,
  hasAnyApiKeys,
  type ApiKeyTier,
} from '../db/repositories.js';
import { getClientPool } from '../kraken/clientPool.js';
import type { AppConfig } from '../config/schema.js';

const logger = createChildLogger('routes');

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

  // Get application status
  router.get('/api/status', requireAuth, (req: Request, res: Response) => {
    const assetStates = getAllAssetStates();
    const activeJobs = getActiveWithdrawalJobs();
    const enabled = isEnabled();
    const pool = getClientPool();

    res.json({
      enabled,
      hasApiKeys: hasAnyApiKeys(),
      apiKeysCount: pool.size,
      assets: assetStates.map((state) => ({
        asset: state.asset,
        pendingAmount: state.pendingAmount,
        rrIndex: state.rrIndex,
        lastWithdrawAt: state.lastWithdrawAt,
        consecutiveFailures: state.consecutiveFailures,
        backoffUntil: state.backoffUntil,
      })),
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        asset: job.asset,
        amount: job.amount,
        status: job.status,
        destKey: job.destKey,
        createdAt: job.createdAt,
        krakenRef: job.krakenRef,
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

  // Get all API keys (with status)
  router.get('/api/keys', requireAuth, (req: Request, res: Response) => {
    const pool = getClientPool();
    const status = pool.getStatus();
    res.json({
      keys: status.map((key) => ({
        id: key.id,
        name: key.name,
        tier: key.tier,
        isActive: key.isActive,
        isValid: key.isValid,
        estimatedCounter: key.estimatedCounter,
        headroom: key.headroom,
        rateLimitedUntil: key.rateLimitedUntil,
        lastError: key.lastError,
      })),
    });
  });

  // Add a new API key
  router.post('/api/keys', requireAuth, async (req: Request, res: Response) => {
    const { name, apiKey, apiSecret, tier } = req.body;

    if (!name || !apiKey || !apiSecret) {
      res.status(400).json({ error: 'Name, API key, and secret required' });
      return;
    }

    // Validate tier
    const validTiers: ApiKeyTier[] = ['starter', 'intermediate', 'pro'];
    const keyTier: ApiKeyTier = validTiers.includes(tier) ? tier : 'starter';

    // Test the connection first
    const { KrakenRestClient } = await import('../kraken/restClient.js');
    const testClient = new KrakenRestClient({ apiKey, apiSecret });

    try {
      const testResult = await testClient.testConnection();

      if (!testResult.success) {
        res.status(400).json({
          error: 'API key test failed',
          details: testResult.error,
        });
        return;
      }

      // Save the key
      const id = uuid();
      const newKey = createApiKey(id, name, apiKey, apiSecret, keyTier);

      // Refresh the client pool
      const pool = getClientPool();
      pool.refreshClients();

      logger.info({ keyId: id, name }, 'API key added');
      res.json({
        success: true,
        key: {
          id: newKey.id,
          name: newKey.name,
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

    // Refresh pool
    const pool = getClientPool();
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

    deleteApiKey(id);

    // Refresh pool
    const pool = getClientPool();
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

    const { KrakenRestClient } = await import('../kraken/restClient.js');
    const testClient = new KrakenRestClient({
      apiKey: key.apiKey,
      apiSecret: key.apiSecret,
    });

    try {
      const result = await testClient.testConnection();

      if (result.success && !key.isValid) {
        // Key is now valid, clear error state
        markApiKeyValid(id);
        const pool = getClientPool();
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

    // Test it first
    const { KrakenRestClient } = await import('../kraken/restClient.js');
    const testClient = new KrakenRestClient({
      apiKey: key.apiKey,
      apiSecret: key.apiSecret,
    });

    try {
      const result = await testClient.testConnection();

      if (!result.success) {
        res.status(400).json({
          error: 'Key validation failed',
          details: result.error,
        });
        return;
      }

      markApiKeyValid(id);
      const pool = getClientPool();
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

  // ============== Configuration ==============

  // Get current config (sanitized)
  router.get('/api/config', requireAuth, (req: Request, res: Response) => {
    const config = context.config;

    // Return config without sensitive data
    res.json({
      global: config.global,
      polling: config.polling,
      assets: config.assets,
      // Don't include web config with session secret
    });
  });

  // Update asset config
  router.put('/api/config/assets/:asset', requireAuth, async (req: Request, res: Response) => {
    const { asset } = req.params;
    const assetConfig = req.body;

    // Validate the config
    const { AssetConfigSchema } = await import('../config/schema.js');
    const result = AssetConfigSchema.safeParse(assetConfig);

    if (!result.success) {
      res.status(400).json({
        error: 'Invalid asset configuration',
        details: result.error.format(),
      });
      return;
    }

    // Update config file
    const { loadConfig, saveConfig } = await import('../config/loadConfig.js');
    const config = loadConfig();
    config.assets[asset] = result.data;
    saveConfig(config);

    // Reload config
    await context.reloadConfig();

    res.json({ success: true });
  });

  // Get withdrawal addresses from local database
  router.get('/api/kraken/addresses', requireAuth, (req: Request, res: Response) => {
    const addresses = getAllKrakenAddresses();
    res.json(
      addresses.map((addr) => ({
        id: addr.id,
        asset: addr.asset,
        method: addr.method,
        key: addr.key,
        address: addr.address,
        createdAt: addr.createdAt,
        lastSeenAt: addr.lastSeenAt,
        removedAt: addr.removedAt,
      }))
    );
  });

  // Sync withdrawal addresses from Kraken API to local database
  router.post('/api/kraken/addresses/sync', requireAuth, async (req: Request, res: Response) => {
    const pool = getClientPool();

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured' });
      return;
    }

    try {
      // Fetch all addresses from Kraken using pool
      const krakenAddresses = await pool.execute((client) => client.getWithdrawAddresses());

      let newCount = 0;
      let restoredCount = 0;
      const currentKeys: Array<{ asset: string; key: string }> = [];

      // Upsert each address
      for (const addr of krakenAddresses) {
        currentKeys.push({ asset: addr.asset, key: addr.key });
        const result = upsertKrakenAddress(addr.asset, addr.method, addr.key, addr.address);
        if (result.isNew) newCount++;
        if (result.wasRemoved) restoredCount++;
      }

      // Flag addresses that no longer exist in Kraken
      const flaggedCount = flagRemovedAddresses(currentKeys);

      logger.info(
        { new: newCount, restored: restoredCount, flagged: flaggedCount },
        'Synced Kraken withdrawal addresses'
      );

      // Return updated list
      const addresses = getAllKrakenAddresses();
      res.json({
        addresses: addresses.map((addr) => ({
          id: addr.id,
          asset: addr.asset,
          method: addr.method,
          key: addr.key,
          address: addr.address,
          createdAt: addr.createdAt,
          lastSeenAt: addr.lastSeenAt,
          removedAt: addr.removedAt,
        })),
        stats: {
          new: newCount,
          restored: restoredCount,
          flagged: flaggedCount,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get account balance from Kraken
  router.get('/api/kraken/balance', requireAuth, async (req: Request, res: Response) => {
    const pool = getClientPool();

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

  // Get open orders from Kraken
  router.get('/api/kraken/orders', requireAuth, async (req: Request, res: Response) => {
    const pool = getClientPool();

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured' });
      return;
    }

    try {
      const result = await pool.execute((client) => client.getOpenOrders());

      // Transform to array format for easier UI consumption
      const orders = Object.entries(result.open || {}).map(([txid, order]) => ({
        txid,
        pair: order.descr.pair,
        type: order.descr.type,
        orderType: order.descr.ordertype,
        price: order.descr.price,
        volume: order.vol,
        volumeExecuted: order.vol_exec,
        cost: order.cost,
        fee: order.fee,
        status: order.status,
        openTime: order.opentm,
        description: order.descr.order,
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

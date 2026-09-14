import { buildDashboardStatus, type ConnectionHealth } from '../domain/dashboardStatus.js';
import { listWithdrawalJobs } from '../db/repositories.js';
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuid } from 'uuid';
import { createChildLogger } from '../utils/logger.js';
import { logBuffer } from '../utils/logBuffer.js';

/**
 * Simple in-memory rate limiter for login attempts
 * Tracks failed attempts by IP address
 */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;

function loginRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const record = loginAttempts.get(ip);

  // Clean up expired record
  if (record && now > record.resetAt) {
    loginAttempts.delete(ip);
  }

  const current = loginAttempts.get(ip);

  if (current && current.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const remainingMs = current.resetAt - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    res.status(429).json({
      error: `Too many login attempts. Try again in ${remainingMin} minute${remainingMin > 1 ? 's' : ''}.`,
    });
    return;
  }

  next();
}

function recordFailedLogin(req: Request): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const record = loginAttempts.get(ip);

  if (record && now < record.resetAt) {
    record.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  }
}

function clearLoginAttempts(req: Request): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  loginAttempts.delete(ip);
}
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
  markApiKeyUsed,
  markApiKeyValid,
  clearApiKeyRateLimit,
  hasAnyApiKeys,
  getAllAssetConfigs,
  getAssetConfig,
  upsertAssetConfig,
  deleteAssetConfig,
  setAssetConfigEnabled,
  getExchangeSettings,
  getAllExchangeSettings,
  setExchangeEnabled,
  isExchangeEnabled,
  getAllWallets,
  getWalletById,
  createWallet,
  deleteWallet,
  upsertWithdrawalMethod,
  getAllWithdrawalMethods,
  getWithdrawalMethodsForAsset,
  getAllSettings,
  setAllSettings,
  type ApiKeyTier,
  type WalletChain,
  type GlobalSettings,
} from '../db/repositories.js';
import {
  hasWalletPassword,
  setWalletPassword,
  verifyWalletPassword,
  encryptPrivateKey,
  decryptPrivateKey,
} from '../utils/walletEncryption.js';
import { generateWallet, isChainSupported } from '../utils/walletGenerator.js';
import { getClientPool } from '../exchanges/clientPool.js';
import { getExchangeRegistry } from '../exchanges/registry.js';
import type { AppConfig } from '../config/schema.js';
import { applySettingsToConfig } from '../config/applySettings.js';
import type { ExchangeId } from '../domain/types.js';
import { saveConfig } from '../config/loadConfig.js';

const logger = createChildLogger('routes');

// Default to kraken for backward compatibility
const DEFAULT_EXCHANGE: ExchangeId = 'kraken';

export interface ReconcileResult {
  exchange: string;
  tradesProcessed: number;
  tradesSkipped: number;
  balancesAdjusted: string[];
}

export interface RoutesContext {
  config: AppConfig;
  getHealth?: () => unknown;
  onKeysChanged?: () => void;
  reloadConfig: () => Promise<void>;
  updateConfig: (newConfig: AppConfig) => void;
  runReconciliation?: (exchange?: ExchangeId) => Promise<ReconcileResult[]>;
  wakeScheduler?: () => void;
  disconnectExchangeWs?: (exchange: ExchangeId) => void;
  connectExchangeWs?: (exchange: ExchangeId) => Promise<void>;
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

    // Auto-login after setup - regenerate session to prevent fixation
    req.session.regenerate((err) => {
      if (err) {
        logger.error({ error: err }, 'Session regeneration failed');
        res.status(500).json({ error: 'Session error' });
        return;
      }
      req.session.userId = result.userId;
      req.session.username = username;
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error({ error: saveErr }, 'Session save failed');
          res.status(500).json({ error: 'Session error' });
          return;
        }
        res.json({ success: true });
      });
    });
  });

  // Login
  router.post('/api/auth/login', loginRateLimiter, async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required' });
      return;
    }

    const result = await authenticateUser(username, password);

    if (!result.success) {
      recordFailedLogin(req);
      res.status(401).json({ error: result.error });
      return;
    }

    // Clear rate limit on successful login
    clearLoginAttempts(req);

    // Regenerate session to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        logger.error({ error: err }, 'Session regeneration failed');
        res.status(500).json({ error: 'Session error' });
        return;
      }
      req.session.userId = result.userId;
      req.session.username = username;
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error({ error: saveErr }, 'Session save failed');
          res.status(500).json({ error: 'Session error' });
          return;
        }
        res.json({ success: true });
      });
    });
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
    const allSettings = getAllExchangeSettings();
    const settingsMap = new Map(allSettings.map((s) => [s.exchange, s]));

    const exchanges = registry.getAll().map((adapter) => {
      const settings = settingsMap.get(adapter.exchangeId);
      return {
        id: adapter.exchangeId,
        name: adapter.displayName,
        requiresPassphrase: adapter.requiresPassphrase(),
        defaultTier: adapter.getDefaultTier(),
        tiers: adapter.getAvailableTiers(),
        enabled: settings ? settings.enabled : true, // Default to enabled
      };
    });
    res.json({ exchanges });
  });

  // ============== Exchange Settings ==============

  // Get exchange settings
  router.get('/api/exchanges/:exchange/settings', requireAuth, (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;
    const settings = getExchangeSettings(exchange);
    res.json({
      exchange,
      enabled: settings ? settings.enabled : true,
    });
  });

  // Toggle exchange enabled/disabled
  router.post('/api/exchanges/:exchange/settings', requireAuth, async (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    setExchangeEnabled(exchange, enabled);
    logger.info({ exchange, enabled }, 'Exchange enabled state changed');

    // Disconnect or reconnect WebSocket based on enabled state
    if (enabled) {
      // Re-enable: connect WebSocket
      if (context.connectExchangeWs) {
        try {
          await context.connectExchangeWs(exchange);
          logger.info({ exchange }, 'WebSocket reconnected after enabling exchange');
        } catch (err) {
          logger.error({ exchange, error: err instanceof Error ? err.message : 'Unknown' }, 'Failed to reconnect WebSocket');
        }
      }
    } else {
      // Disable: disconnect WebSocket to stop all connection attempts
      if (context.disconnectExchangeWs) {
        context.disconnectExchangeWs(exchange);
        logger.info({ exchange }, 'WebSocket disconnected after disabling exchange');
      }
    }

    res.json({ success: true, exchange, enabled });
  });

  // Get application status (optionally filtered by exchange)
  router.get('/api/status', requireAuth, (req: Request, res: Response) => {
    const exchange = (req.query.exchange as ExchangeId) || undefined;
    res.json(buildDashboardStatus(context.config, context.getHealth?.() as ConnectionHealth | undefined, exchange));
  });

  router.get('/api/withdrawals', requireAuth, (req: Request, res: Response) => {
    const { exchange, status, q = '', offset = '0', limit = '50' } = req.query;
    if ((exchange !== undefined && !['kraken', 'gemini', 'kucoin', 'gateio'].includes(String(exchange))) ||
        (status !== undefined && !['submitted', 'pending', 'held', 'unknown', 'complete', 'failed', 'cancelled'].includes(String(status))) ||
        typeof q !== 'string' || q.length > 200 || !/^\d+$/.test(String(offset)) || !/^\d+$/.test(String(limit)) ||
        Number(limit) < 1 || Number(limit) > 100 || Number(offset) > 1000000) {
      res.status(400).json({ error: 'Invalid withdrawal history filter' }); return;
    }
    res.json(listWithdrawalJobs({ exchange: exchange as string | undefined, status: status as string | undefined,
      query: q, offset: Number(offset), limit: Number(limit) }));
  });

  // Get application logs (from in-memory buffer)
  router.get('/api/logs', requireAuth, (req: Request, res: Response) => {
    const minLevel = req.query.level ? parseInt(req.query.level as string) : undefined;
    const sinceId = req.query.sinceId ? parseInt(req.query.sinceId as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 200;
    const module = req.query.module as string | undefined;

    const logs = logBuffer.getLogs({
      minLevel,
      sinceId,
      limit,
      module,
    });

    res.json({
      logs,
      stats: logBuffer.getStats(),
    });
  });

  // Manual reconciliation (settle up)
  router.post('/api/control/reconcile', requireAuth, async (req: Request, res: Response) => {
    if (!context.runReconciliation) {
      res.status(501).json({ error: 'Reconciliation not available' });
      return;
    }

    const exchange = req.body.exchange as ExchangeId | undefined;
    logger.info({ exchange: exchange || 'all' }, 'Manual reconciliation triggered');

    try {
      const results = await context.runReconciliation(exchange);
      res.json({
        success: true,
        results,
        message: `Reconciliation complete for ${results.length} exchange(s)`,
      });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'Unknown' }, 'Manual reconciliation failed');
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Reconciliation failed',
      });
    }
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
      context.onKeysChanged?.();

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
    const id = String(req.params.id);
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
      context.onKeysChanged?.();

    logger.info({ keyId: id, updates }, 'API key updated');
    res.json({ success: true });
  });

  // Delete an API key
  router.delete('/api/keys/:id', requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);

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
      context.onKeysChanged?.();

    logger.info({ keyId: id }, 'API key deleted');
    res.json({ success: true });
  });

  // Test a specific API key
  router.post('/api/keys/:id/test', requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id);

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

      if (result.success) {
        // Record usage for the test call
        markApiKeyUsed(id);
        
        if (!key.isValid) {
          // Key is now valid, clear error state
          markApiKeyValid(id);
          const pool = getClientPool(key.exchange);
          pool.refreshClients();
      context.onKeysChanged?.();
        }
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
    const id = String(req.params.id);

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
    const id = String(req.params.id);

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
      context.onKeysChanged?.();

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

  // ============== Global Settings (Database-backed) ==============

  // Get all global settings
  router.get('/api/settings', requireAuth, (req: Request, res: Response) => {
    const settings = getAllSettings();
    res.json(settings);
  });

  // Update global settings
  router.put('/api/settings', requireAuth, (req: Request, res: Response) => {
    const updates = req.body as Partial<GlobalSettings>;

    if (updates.dailyFeeBudgetUsd !== undefined && updates.dailyFeeBudgetUsd !== null &&
        (typeof updates.dailyFeeBudgetUsd !== 'number' || !Number.isFinite(updates.dailyFeeBudgetUsd) || updates.dailyFeeBudgetUsd <= 0)) {
      res.status(400).json({ error: 'Fee budget must be a positive USD amount, or blank to disable' }); return;
    }
    // Validate inputs
    if (updates.dryRun !== undefined && typeof updates.dryRun !== 'boolean') {
      res.status(400).json({ error: 'dryRun must be a boolean' });
      return;
    }

    if (updates.maxInflightWithdrawals !== undefined) {
      if (typeof updates.maxInflightWithdrawals !== 'number' || updates.maxInflightWithdrawals < 1) {
        res.status(400).json({ error: 'maxInflightWithdrawals must be a positive number' });
        return;
      }
    }

    if (updates.perAssetMaxInflight !== undefined) {
      if (typeof updates.perAssetMaxInflight !== 'number' || updates.perAssetMaxInflight < 1) {
        res.status(400).json({ error: 'perAssetMaxInflight must be a positive number' });
        return;
      }
    }

    if (updates.keyNamePrefix !== undefined && typeof updates.keyNamePrefix !== 'string') {
      res.status(400).json({ error: 'keyNamePrefix must be a string' });
      return;
    }

    if (updates.allowedOrderTypes !== undefined) {
      if (!Array.isArray(updates.allowedOrderTypes)) {
        res.status(400).json({ error: 'allowedOrderTypes must be an array' });
        return;
      }
      if (!updates.allowedOrderTypes.every((t) => typeof t === 'string')) {
        res.status(400).json({ error: 'allowedOrderTypes must contain only strings' });
        return;
      }
    }

    setAllSettings(updates);
    logger.info({ updates }, 'Global settings updated');

    // Refresh in-memory config so live components use updated settings
    const settings = getAllSettings();
    const newConfig = applySettingsToConfig(context.config, settings);
    context.updateConfig(newConfig);

    res.json({ success: true, settings });
  });

  // Get all asset configs (optionally filtered by exchange)
  router.get('/api/config/assets', requireAuth, (req: Request, res: Response) => {
    const exchange = req.query.exchange as ExchangeId | undefined;
    const configs = getAllAssetConfigs(exchange);
    res.json({ assets: configs });
  });

  // Get asset config for a specific exchange and asset
  router.get('/api/config/exchanges/:exchange/assets/:asset', requireAuth, (req: Request, res: Response) => {
    const exchange = String(req.params.exchange), asset = String(req.params.asset);
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
      const exchange = String(req.params.exchange), asset = String(req.params.asset);
      const {
        enabled,
        threshold,
        reserve,
        destKeys,
        priority,
        cooldownSeconds,
        method,
        chunkAmount,
        chunkMode,
        chunkMax,
        perWalletCapCoin, perWalletCapUsd,
      } = req.body;

      // Basic validation
      if (typeof threshold !== 'number' || threshold <= 0) {
        res.status(400).json({ error: 'threshold must be a positive number' });
        return;
      }

      if (!Array.isArray(destKeys) || destKeys.length === 0) {
        res.status(400).json({ error: 'destKeys must be a non-empty array of wallet key names' });
        return;
      }

      // Validate priority if provided
      if (priority !== undefined && (typeof priority !== 'number' || priority < 1)) {
        res.status(400).json({ error: 'priority must be a positive number' });
        return;
      }

      // Validate cooldownSeconds if provided
      if (cooldownSeconds !== undefined && (typeof cooldownSeconds !== 'number' || cooldownSeconds < 0)) {
        res.status(400).json({ error: 'cooldownSeconds must be a non-negative number' });
        return;
      }

      // Validate chunking mode
      if (chunkMode && chunkMode !== 'fixedCoin' && chunkMode !== 'fixedUsd') {
        res.status(400).json({ error: 'chunkMode must be fixedCoin or fixedUsd' });
        return;
      }

      if ([reserve, cooldownSeconds].some(v => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) ||
          [chunkAmount, chunkMax, perWalletCapCoin, perWalletCapUsd].some(v => v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) ||
          destKeys.some((key: unknown) => typeof key !== 'string' || !key.trim())) {
        res.status(400).json({ error: 'Amounts, caps, and wallet keys must be valid positive values (reserve and cooldown may be zero).' }); return;
      }
      // Save to database
      upsertAssetConfig(exchange as ExchangeId, asset, {
        enabled: enabled !== false,
        threshold,
        reserve: reserve ?? 0,
        destKeys,
        priority: priority ?? 10,
        cooldownSeconds: cooldownSeconds ?? 60,
        method: method ?? null,
        chunkAmount: chunkAmount ?? null,
        chunkMode: chunkMode ?? 'fixedCoin',
        chunkMax: chunkMax ?? null,
        perWalletCapCoin: perWalletCapCoin ?? null, perWalletCapUsd: perWalletCapUsd ?? null,
      });

      logger.info(
        { exchange, asset, threshold, priority, cooldownSeconds, chunkAmount, chunkMode, chunkMax },
        'Asset config saved'
      );
      res.json({ success: true });
    }
  );

  // Delete asset config
  router.delete(
    '/api/config/exchanges/:exchange/assets/:asset',
    requireAuth,
    (req: Request, res: Response) => {
      const exchange = String(req.params.exchange), asset = String(req.params.asset);

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
      const exchange = String(req.params.exchange), asset = String(req.params.asset);
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

  // Toggle exchange global enabled state
  router.post(
    '/api/config/exchanges/:exchange/enable',
    requireAuth,
    (req: Request, res: Response) => {
      const exchange = req.params.exchange as ExchangeId;
      const { enabled } = req.body;
      
      const config = context.config;
      const disabledExchanges = new Set(config.global.disabledExchanges || []);
      
      if (enabled) {
        disabledExchanges.delete(exchange);
      } else {
        disabledExchanges.add(exchange);
      }
      
      config.global.disabledExchanges = Array.from(disabledExchanges) as ExchangeId[];
      
      try {
        saveConfig(config);
        context.updateConfig(config);
        logger.info({ exchange, enabled }, 'Exchange global enabled state toggled');
        res.json({ success: true, enabled });
      } catch (error) {
        logger.error({ error }, 'Failed to save config');
        res.status(500).json({ error: 'Failed to save configuration' });
      }
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

  // Get cached withdrawal methods (minimums, fees)
  router.get('/api/withdrawal-methods', requireAuth, (req: Request, res: Response) => {
    const exchange = (req.query.exchange as ExchangeId) || undefined;
    const asset = req.query.asset as string | undefined;

    const doRespond = (methods: ReturnType<typeof getAllWithdrawalMethods>) => {
      res.json(
        methods.map((m) => ({
          exchange: m.exchange,
          asset: m.asset,
          method: m.method,
          network: m.network,
          minimum: m.minimum,
          maximum: m.maximum,
          fee: m.fee,
          lastSyncedAt: m.lastSyncedAt,
        }))
      );
    };

    const loadCached = (): ReturnType<typeof getAllWithdrawalMethods> => {
      if (exchange && asset) {
        return getWithdrawalMethodsForAsset(exchange, asset);
      }
      return getAllWithdrawalMethods(exchange);
    };

    let methods = loadCached();

    // Lazy-fetch if missing and exchange supports it (helps KuCoin when no addresses are synced)
    if (exchange && methods.length === 0) {
      const pool = getClientPool(exchange);
      if (pool.hasAvailableClients()) {
        pool
          .execute(async (client) => {
            if (client.getWithdrawMethods) {
              return client.getWithdrawMethods();
            }
            return [] as import('../exchanges/types.js').WithdrawalMethod[];
          })
          .then((fetched) => {
            for (const method of fetched) {
              upsertWithdrawalMethod(exchange, method.asset, method.method, {
                network: method.network,
                minimum: method.minimum,
                maximum: method.maximum,
                fee: method.fee,
                genAddress: method.genAddress,
              });
            }
            methods = loadCached();
            doRespond(methods);
          })
          .catch((err) => {
            logger.warn({ exchange, err }, 'Failed to fetch withdrawal methods lazily');
            doRespond(methods);
          });
        return;
      }
    }

    doRespond(methods);
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
      }
      if (skippedCount > 0) {
        logger.info({ skippedCount }, 'Skipped entries without addresses');
      }

      // Delete addresses that no longer exist on the exchange
      // BUT only if the exchange actually returned addresses (don't delete manual addresses for exchanges like KuCoin)
      const deletedCount = exchangeAddresses.length > 0 ? deleteRemovedAddresses(exchange, currentKeys) : 0;

      // Also fetch and cache withdrawal methods (minimums, fees)
      let methodsCount = 0;
      try {
        const withdrawMethods = await pool.execute(async (client) => {
          if (client.getWithdrawMethods) {
            return client.getWithdrawMethods();
          }
          return [] as import('../exchanges/types.js').WithdrawalMethod[];
        });

        for (const method of withdrawMethods) {
          upsertWithdrawalMethod(exchange, method.asset, method.method, {
            network: method.network,
            minimum: method.minimum,
            maximum: method.maximum,
            fee: method.fee,
            genAddress: method.genAddress,
          });
          methodsCount++;
        }

        logger.info(
          { exchange, count: methodsCount },
          'Cached withdrawal methods'
        );
      } catch (methodErr) {
        // Don't fail the sync if methods fetch fails
        logger.warn(
          { exchange, error: methodErr instanceof Error ? methodErr.message : 'Unknown error' },
          'Failed to fetch withdrawal methods'
        );
      }

      logger.info(
        {
          exchange,
          exchangeCount: exchangeAddresses.length,
          new: newCount,
          restored: restoredCount,
          deleted: deletedCount,
          methods: methodsCount,
        },
        'Synced exchange withdrawal addresses'
      );

      // Return updated list
      const addresses = getAllExchangeAddresses(exchange);
      const methods = getAllWithdrawalMethods(exchange);
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
        withdrawalMethods: methods.map((m) => ({
          asset: m.asset,
          method: m.method,
          network: m.network,
          minimum: m.minimum,
          maximum: m.maximum,
          fee: m.fee,
        })),
        stats: {
          new: newCount,
          restored: restoredCount,
          deleted: deletedCount,
          fromExchange: exchangeAddresses.length,
          methodsCached: methodsCount,
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

  // Get tradeable coins (bases of open limit orders) for an exchange
  router.get('/api/exchanges/:exchange/tradeable-coins', requireAuth, async (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;
    const pool = getClientPool(exchange);

    if (!pool.hasAvailableClients()) {
      res.status(400).json({ error: 'No API keys configured for this exchange' });
      return;
    }

    try {
      const result = await pool.execute((client) => client.getOpenOrders());
      const orders = result.open || {};

      // Extract unique base coins from order pairs
      const coins = new Set<string>();
      const registry = getExchangeRegistry();
      const adapter = registry.get(exchange);

      for (const order of Object.values(orders)) {
        if (order.pair) {
          // Parse pair to get base and quote currencies
          const { base, quote } = adapter?.parsePair(order.pair) || { base: '', quote: '' };
          if (base) coins.add(base);
          // Only return base assets for withdrawal address selection
        }
      }

      res.json({
        exchange,
        coins: Array.from(coins).sort(),
        orderCount: Object.keys(orders).length,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Add manual withdrawal address (for exchanges that don't support address sync)
  router.post('/api/exchanges/:exchange/addresses/manual', requireAuth, async (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;
    const { asset, address, addressConfirm, method, key, memo } = req.body;

    // Validate required fields
    if (!asset || !address || !addressConfirm || !method || !key) {
      res.status(400).json({ error: 'Missing required fields: asset, address, addressConfirm, method, key' });
      return;
    }

    // Verify addresses match (double-entry verification)
    if (address !== addressConfirm) {
      res.status(400).json({ error: 'Addresses do not match' });
      return;
    }

    // Validate address format (basic checks)
    if (address.length < 10) {
      res.status(400).json({ error: 'Address appears to be too short' });
      return;
    }

    // Check if user has open orders for this coin (security check)
    const pool = getClientPool(exchange);
    if (pool.hasAvailableClients()) {
      try {
        const result = await pool.execute((client) => client.getOpenOrders());
        const orders = result.open || {};

        const registry = getExchangeRegistry();
        const adapter = registry.get(exchange);

        const tradeableCoins = new Set<string>();
        for (const order of Object.values(orders)) {
          if (order.pair) {
            const { base, quote } = adapter?.parsePair(order.pair) || { base: '', quote: '' };
            if (base) tradeableCoins.add(base.toUpperCase());
            if (quote) tradeableCoins.add(quote.toUpperCase());
          }
        }

        if (!tradeableCoins.has(asset.toUpperCase())) {
          res.status(400).json({
            error: `No open orders found for ${asset}. You can only add addresses for coins you are actively trading.`,
          });
          return;
        }
      } catch (error) {
        logger.warn({ exchange, error }, 'Could not verify tradeable coins, proceeding anyway');
      }
    }

    try {
      // Normalize asset (use base if user pasted pair)
      const normalizedAsset = asset.split(/[-/]/)[0]?.trim().toUpperCase();
      if (!normalizedAsset) {
        res.status(400).json({ error: 'Invalid asset symbol' });
        return;
      }

      // Store the address
      const result = upsertExchangeAddress(exchange, normalizedAsset, method, key, address);

      logger.info(
        { exchange, asset: normalizedAsset, key, method, isNew: result.isNew },
        'Manual address added'
      );

      res.json({
        success: true,
        isNew: result.isNew,
        address: {
          exchange,
          asset: normalizedAsset,
          method,
          key,
          address,
          memo: memo || undefined,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Delete a manual address
  router.delete('/api/exchanges/:exchange/addresses/:asset/:key', requireAuth, (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;
    const asset = String(req.params.asset);
    const key = String(req.params.key);

    try {
      const addresses = getAllExchangeAddresses(exchange);
      const addressToDelete = addresses.find(a => a.asset === asset && a.key === key);

      if (!addressToDelete) {
        res.status(404).json({ error: 'Address not found' });
        return;
      }

      // Use deleteRemovedAddresses with an empty currentKeys list that excludes this address
      const currentKeys = addresses
        .filter(a => !(a.asset === asset && a.key === key))
        .map(a => ({ asset: a.asset, key: a.key }));

      deleteRemovedAddresses(exchange, currentKeys);

      logger.info({ exchange, asset, key }, 'Manual address deleted');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Check if exchange supports address sync
  router.get('/api/exchanges/:exchange/supports-sync', requireAuth, (req: Request, res: Response) => {
    const exchange = req.params.exchange as ExchangeId;

    // Exchanges that support syncing addresses from their API
    const addressSyncExchanges: ExchangeId[] = ['kraken', 'gemini', 'gateio'];
    // Exchanges that support fetching withdrawal methods (minimums/fees) - includes address sync + others
    const methodSyncExchanges: ExchangeId[] = ['kraken', 'gemini', 'gateio', 'kucoin'];

    res.json({
      exchange,
      supportsSync: methodSyncExchanges.includes(exchange),
      requiresManualEntry: !addressSyncExchanges.includes(exchange),
    });
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
        description?: string;
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

  // ============== Wallet Management Routes ==============

  // Check if wallet password is set
  router.get('/api/wallets/password/exists', requireAuth, (req: Request, res: Response) => {
    res.json({ exists: hasWalletPassword() });
  });

  // Set wallet password (first time only)
  router.post('/api/wallets/password', requireAuth, async (req: Request, res: Response) => {
    try {
      const { password } = req.body;

      if (!password || typeof password !== 'string') {
        res.status(400).json({ error: 'Password is required' });
        return;
      }

      if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
      }

      await setWalletPassword(password);
      logger.info('Wallet password set');
      res.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ error: msg });
    }
  });

  // Verify wallet password
  router.post('/api/wallets/password/verify', requireAuth, async (req: Request, res: Response) => {
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    const valid = await verifyWalletPassword(password);
    res.json({ valid });
  });

  // List all wallets (public info only - no private keys)
  router.get('/api/wallets', requireAuth, (req: Request, res: Response) => {
    const wallets = getAllWallets();
    res.json({ wallets });
  });

  // Generate and create a new wallet
  router.post('/api/wallets', requireAuth, async (req: Request, res: Response) => {
    try {
      const { name, password, chain = 'ethereum' } = req.body;

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Wallet name is required' });
        return;
      }

      if (!password || typeof password !== 'string') {
        res.status(400).json({ error: 'Password is required' });
        return;
      }

      // Validate chain
      const validChains: WalletChain[] = ['ethereum', 'bitcoin', 'solana', 'xrp', 'xlm', 'lunc', 'algorand', 'cardano'];
      if (!validChains.includes(chain)) {
        res.status(400).json({ error: `Invalid chain. Must be one of: ${validChains.join(', ')}` });
        return;
      }

      // Verify password first
      if (!(await verifyWalletPassword(password))) {
        res.status(400).json({ error: 'Invalid password' });
        return;
      }

      // Check if chain is supported
      if (!isChainSupported(chain)) {
        res.status(400).json({ error: `Chain '${chain}' wallet generation not yet implemented.` });
        return;
      }

      // Generate wallet for the specified chain
      const wallet = await generateWallet(chain);
      const address = wallet.address;
      const privateKey = wallet.privateKey;
      const mnemonic = wallet.mnemonic;

      // Encrypt the private key
      const { encrypted, salt } = encryptPrivateKey(privateKey, password);

      // Encrypt the mnemonic if available
      let encryptedMnemonic: string | undefined;
      let mnemonicSalt: string | undefined;
      if (mnemonic) {
        const mnemonicEncryption = encryptPrivateKey(mnemonic, password);
        encryptedMnemonic = mnemonicEncryption.encrypted;
        mnemonicSalt = mnemonicEncryption.salt;
      }

      // Store in database
      const id = uuid();
      const record = createWallet(id, name, chain as WalletChain, address, encrypted, salt, encryptedMnemonic, mnemonicSalt);

      logger.info({ id, name, chain, address }, 'New wallet created');

      res.json({
        wallet: {
          id: record.id,
          name: record.name,
          chain: record.chain,
          address: record.address,
          createdAt: record.createdAt,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: msg }, 'Failed to create wallet');
      res.status(500).json({ error: msg });
    }
  });

  // Unlock/decrypt a wallet's private key
  router.post('/api/wallets/:id/unlock', requireAuth, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const { password } = req.body;

      if (!password || typeof password !== 'string') {
        res.status(400).json({ error: 'Password is required' });
        return;
      }

      // Verify password first
      if (!(await verifyWalletPassword(password))) {
        res.status(400).json({ error: 'Invalid password' });
        return;
      }

      const wallet = getWalletById(id);
      if (!wallet) {
        res.status(404).json({ error: 'Wallet not found' });
        return;
      }

      // Decrypt the private key
      const privateKey = decryptPrivateKey(wallet.encryptedPrivateKey, wallet.salt, password);

      // Decrypt the mnemonic if available
      let mnemonic: string | undefined;
      if (wallet.encryptedMnemonic && wallet.mnemonicSalt) {
        mnemonic = decryptPrivateKey(wallet.encryptedMnemonic, wallet.mnemonicSalt, password);
      }

      logger.info({ id, address: wallet.address }, 'Wallet unlocked');

      res.json({ privateKey, mnemonic });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: msg }, 'Failed to unlock wallet');
      res.status(500).json({ error: msg });
    }
  });

  // Delete a wallet
  router.delete('/api/wallets/:id', requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);

    const wallet = getWalletById(id);
    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    deleteWallet(id);
    logger.info({ id, address: wallet.address }, 'Wallet deleted');

    res.json({ success: true });
  });

  return router;
}

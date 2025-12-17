import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger, createChildLogger } from './utils/logger.js';
import { initEncryption } from './utils/encryption.js';
import { loadConfig, reloadConfig } from './config/loadConfig.js';
import { initDb, closeDb } from './db/sqlite.js';
import { getAllApiKeys, setEnabled, hasAnyApiKeys, migrateApiKeysToEncrypted, getAppStateValue, setAppStateValue } from './db/repositories.js';
import { FillProcessor } from './domain/fillProcessor.js';
import { Scheduler } from './domain/scheduler.js';
import { StatusPoller } from './domain/statusPoller.js';
import { Reconciler } from './domain/reconciler.js';
import { createWebServer, startServer } from './web/server.js';
import { createRoutes } from './web/routes.js';
import { getPoolManager, getClientPool } from './exchanges/clientPool.js';
import { getExchangeRegistry, registerExchange } from './exchanges/registry.js';
import { KrakenAdapterFactory } from './exchanges/kraken/factory.js';
import { GeminiAdapterFactory } from './exchanges/gemini/factory.js';
import { KuCoinAdapterFactory } from './exchanges/kucoin/factory.js';
import { GateAdapterFactory } from './exchanges/gateio/factory.js';
import type { AppConfig } from './config/schema.js';
import type { FillEvent, ExchangeId } from './domain/types.js';

/**
 * Get list of exchanges that have API keys configured
 */
function getEnabledExchanges(): ExchangeId[] {
  const registry = getExchangeRegistry();
  const allExchanges = registry.getAll().map((a) => a.exchangeId);
  return allExchanges.filter((id) => hasAnyApiKeys(id));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const appLogger = createChildLogger('app');

// Ensure data directory exists (MOBY_DATA_PATH is set by Electron)
const dataDir = process.env.MOBY_DATA_PATH || process.env.DATA_DIR || './data';
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Global state
let config: AppConfig;
let fillProcessor: FillProcessor;
let scheduler: Scheduler;
let statusPoller: StatusPoller;
let reconciler: Reconciler;

// WS client connections by exchange
const wsClients = new Map<ExchangeId, { disconnect: () => void }>();

// Reconciliation interval (5 minutes)
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
let reconcileInterval: ReturnType<typeof setInterval> | null = null;

async function main() {
  appLogger.info('Starting Moby');

  // Register exchange adapters
  registerExchange(KrakenAdapterFactory);
  registerExchange(GeminiAdapterFactory);
  registerExchange(KuCoinAdapterFactory);
  registerExchange(GateAdapterFactory);
  appLogger.debug('Registered exchange adapters: Kraken, Gemini, KuCoin, Gate.io');

  // Load configuration
  config = loadConfig();

  // Initialize encryption (get or generate key)
  const encryptionResult = initEncryption();
  appLogger.info(
    { keyGenerated: encryptionResult.keyGenerated, keySource: encryptionResult.keySource },
    'Encryption initialized'
  );

  // Initialize database
  initDb();

  // Migrate existing API keys to encrypted format (idempotent)
  const encryptionMigrated = getAppStateValue('encryption_migrated');
  if (encryptionMigrated !== 'true') {
    const migrationResult = migrateApiKeysToEncrypted();
    if (migrationResult.migrated > 0) {
      appLogger.info(
        { migrated: migrationResult.migrated, skipped: migrationResult.skipped },
        'Migrated API keys to encrypted format'
      );
    }
    setAppStateValue('encryption_migrated', 'true');
  }

  // Set initial enabled state from config
  if (config.global.enabledOnBoot) {
    setEnabled(true);
    appLogger.info('Sweeper enabled on boot');
  }

  // Get enabled exchanges (those with API keys)
  const enabledExchanges = getEnabledExchanges();

  // Initialize fill processor
  fillProcessor = new FillProcessor({
    config,
    onPendingUpdated: (exchange, asset, amount) => {
      appLogger.debug({ exchange, asset, amount }, 'Pending updated, waking scheduler');
      scheduler?.wake();
    },
  });

  // Initialize reconciler (for trade history sync and balance reconciliation)
  reconciler = new Reconciler({
    config,
    onPendingUpdated: (exchange, asset, amount) => {
      appLogger.debug({ exchange, asset, amount }, 'Pending updated from reconciler, waking scheduler');
      scheduler?.wake();
    },
  });

  // Initialize scheduler
  scheduler = new Scheduler({
    config,
  });

  scheduler.on('withdrawalStarted', (job) => {
    appLogger.info(
      { jobId: job.id, exchange: job.exchange, asset: job.asset, amount: job.amount },
      'Withdrawal started'
    );
  });

  scheduler.on('withdrawalFailed', (exchange, asset, error) => {
    appLogger.error({ exchange, asset, error }, 'Withdrawal failed');
  });

  // Initialize status poller
  statusPoller = new StatusPoller({
    pollingConfig: config.polling,
    enabledExchanges,
  });

  statusPoller.on('jobComplete', (job, txid) => {
    appLogger.info({ jobId: job.id, exchange: job.exchange, asset: job.asset, txid }, 'Withdrawal complete');
  });

  statusPoller.on('jobFailed', (job, error) => {
    appLogger.error({ jobId: job.id, exchange: job.exchange, asset: job.asset, error }, 'Withdrawal failed');
  });

  statusPoller.on('jobHeld', (job) => {
    appLogger.warn({ jobId: job.id, exchange: job.exchange, asset: job.asset }, 'Withdrawal held for review');
  });

  statusPoller.on('jobStuck', (job, duration) => {
    appLogger.warn(
      { jobId: job.id, exchange: job.exchange, asset: job.asset, durationMin: Math.floor(duration / 60000) },
      'Withdrawal appears stuck'
    );
  });

  // Initialize WebSocket connections for enabled exchanges
  for (const exchangeId of enabledExchanges) {
    await initializeExchangeWs(exchangeId);
  }

  // Create and start web server
  const app = createWebServer({ config: config.web });

  // Set up routes with context
  const routes = createRoutes({
    config,
    reloadConfig: async () => {
      config = reloadConfig();
      fillProcessor.updateConfig(config);
      scheduler.updateConfig(config);
      reconciler.updateConfig(config);

      // Update enabled exchanges
      const newEnabledExchanges = getEnabledExchanges();
      statusPoller.updateEnabledExchanges(newEnabledExchanges);
    },
    updateConfig: (newConfig: AppConfig) => {
      config = newConfig;
      fillProcessor.updateConfig(config);
      scheduler.updateConfig(config);
      reconciler.updateConfig(config);

      // Update enabled exchanges
      const newEnabledExchanges = getEnabledExchanges();
      statusPoller.updateEnabledExchanges(newEnabledExchanges);
    },
    runReconciliation: async (exchangeFilter?: ExchangeId) => {
      const exchanges = exchangeFilter ? [exchangeFilter] : getEnabledExchanges();
      const results: Array<{
        exchange: string;
        tradesProcessed: number;
        tradesSkipped: number;
        balancesAdjusted: string[];
      }> = [];

      for (const exchangeId of exchanges) {
        const pool = getClientPool(exchangeId);
        if (!pool.hasAvailableClients()) {
          continue;
        }

        try {
          const result = await pool.execute(async (client) => {
            const tradeResult = await reconciler.syncTradeHistory(exchangeId, client);
            const balanceResult = await reconciler.reconcileBalances(exchangeId, client);
            return {
              exchange: exchangeId,
              tradesProcessed: tradeResult.processed,
              tradesSkipped: tradeResult.skipped,
              balancesAdjusted: balanceResult.adjusted,
            };
          });
          results.push(result);
        } catch (err) {
          appLogger.error(
            { exchange: exchangeId, error: err instanceof Error ? err.message : 'Unknown' },
            'Manual reconciliation failed for exchange'
          );
        }
      }

      return results;
    },
  });

  app.use(routes);

  // Serve static files for the UI (in production)
  const uiDistPath = join(__dirname, '../../dist');
  if (existsSync(uiDistPath)) {
    const express = await import('express');
    app.use(express.default.static(uiDistPath));
    app.get('/{*splat}', (req, res) => {
      res.sendFile(join(uiDistPath, 'index.html'));
    });
  }

  // Start web server
  await startServer(app, config.web);

  // Initialize client pools for enabled exchanges
  const poolManager = getPoolManager();
  for (const exchangeId of enabledExchanges) {
    getClientPool(exchangeId); // This creates and initializes the pool
    appLogger.debug({ exchange: exchangeId }, 'Initialized client pool');
  }

  // Start scheduler and poller if we have any clients
  if (poolManager.hasAnyClients()) {
    scheduler.start();
    statusPoller.start();

    // Run initial reconciliation to catch any missed trades during downtime
    appLogger.info('Running initial reconciliation');
    for (const exchangeId of enabledExchanges) {
      const pool = getClientPool(exchangeId);
      if (pool.hasAvailableClients()) {
        pool.execute(async (client) => {
          await reconciler.runFullReconciliation(exchangeId, client);
        }).catch((err) => {
          appLogger.error(
            { exchange: exchangeId, error: err instanceof Error ? err.message : 'Unknown error' },
            'Initial reconciliation failed'
          );
        });
      }
    }

    // Start periodic reconciliation (balance check every 5 minutes)
    reconcileInterval = setInterval(async () => {
      for (const exchangeId of getEnabledExchanges()) {
        const pool = getClientPool(exchangeId);
        if (pool.hasAvailableClients()) {
          try {
            await pool.execute(async (client) => {
              await reconciler.reconcileBalances(exchangeId, client);
            });
          } catch (err) {
            appLogger.error(
              { exchange: exchangeId, error: err instanceof Error ? err.message : 'Unknown error' },
              'Periodic reconciliation failed'
            );
          }
        }
      }
    }, RECONCILE_INTERVAL_MS);
  } else {
    appLogger.warn('No API keys configured - scheduler and poller not started');
  }

  // Handle shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep process alive
  setInterval(() => {
    // no-op to keep event loop active
  }, 1000 * 60 * 60);

  appLogger.info('Moby started successfully');
}

/**
 * Initialize WebSocket connection for an exchange
 */
async function initializeExchangeWs(exchangeId: ExchangeId) {
  const keys = getAllApiKeys(exchangeId);
  if (keys.length === 0) {
    appLogger.debug({ exchange: exchangeId }, 'No API keys for exchange, skipping WS');
    return;
  }

  const adapter = getExchangeRegistry().get(exchangeId);
  if (!adapter) {
    appLogger.warn({ exchange: exchangeId }, 'No adapter found for exchange');
    return;
  }

  // Use the first active key for WS connection
  const activeKey = keys.find((k) => k.isActive && k.isValid);
  if (!activeKey) {
    appLogger.warn({ exchange: exchangeId }, 'No active/valid API keys for WS');
    return;
  }

  appLogger.info({ exchange: exchangeId }, 'Initializing WebSocket connection');

  // Disconnect existing if any
  const existingWs = wsClients.get(exchangeId);
  if (existingWs) {
    existingWs.disconnect();
  }

  // Extract passphrase if stored with secret (format: secret:passphrase)
  let apiSecret = activeKey.apiSecret;
  let passphrase: string | undefined;
  if (adapter.requiresPassphrase() && activeKey.apiSecret.includes(':')) {
    const parts = activeKey.apiSecret.split(':');
    apiSecret = parts[0];
    passphrase = parts.slice(1).join(':');
  }

  try {
    const wsClient = adapter.createWsClient({
      apiKey: activeKey.apiKey,
      apiSecret,
      passphrase,
      onFill: (fill: FillEvent) => {
        appLogger.info(
          { exchange: exchangeId, tradeId: fill.tradeId, pair: fill.pair },
          'Fill received from WebSocket'
        );
        fillProcessor.processFill(exchangeId, fill);
      },
      onConnect: () => {
        appLogger.info({ exchange: exchangeId }, 'WebSocket connected');
        // Trigger trade history sync on reconnect to catch any missed fills
        const pool = getClientPool(exchangeId);
        if (pool.hasAvailableClients()) {
          pool.execute(async (client) => {
            appLogger.info({ exchange: exchangeId }, 'Running trade history sync after WS reconnect');
            await reconciler.syncTradeHistory(exchangeId, client);
          }).catch((err) => {
            appLogger.error(
              { exchange: exchangeId, error: err instanceof Error ? err.message : 'Unknown error' },
              'Post-reconnect trade sync failed'
            );
          });
        }
      },
      onDisconnect: () => {
        appLogger.warn({ exchange: exchangeId }, 'WebSocket disconnected');
      },
      onError: (error: Error) => {
        appLogger.error({ exchange: exchangeId, error: error.message }, 'WebSocket error');
      },
    });

    await wsClient.connect();
    wsClients.set(exchangeId, wsClient);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    appLogger.error({ exchange: exchangeId, error: errorMsg }, 'Failed to connect WebSocket');
  }
}

function shutdown() {
  appLogger.info('Shutting down...');

  // Stop services
  scheduler?.stop();
  statusPoller?.stop();

  // Stop reconciliation interval
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
  }

  // Disconnect all WS clients
  for (const [exchangeId, ws] of wsClients) {
    appLogger.debug({ exchange: exchangeId }, 'Disconnecting WebSocket');
    ws.disconnect();
  }
  wsClients.clear();

  // Close database
  closeDb();

  appLogger.info('Shutdown complete');
  process.exit(0);
}

// Run
main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});

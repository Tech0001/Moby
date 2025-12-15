import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger, createChildLogger } from './utils/logger.js';
import { loadConfig, reloadConfig } from './config/loadConfig.js';
import { initDb, closeDb } from './db/sqlite.js';
import { getApiCredentials, setEnabled, isEnabled } from './db/repositories.js';
import { KrakenRestClient } from './kraken/restClient.js';
import { KrakenWsClient } from './kraken/wsClient.js';
import { FillProcessor } from './domain/fillProcessor.js';
import { Scheduler, createPriceProvider } from './domain/scheduler.js';
import { StatusPoller } from './domain/statusPoller.js';
import { createWebServer, startServer } from './web/server.js';
import { createRoutes } from './web/routes.js';
import type { AppConfig } from './config/schema.js';
import type { FillEvent } from './domain/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appLogger = createChildLogger('app');

// Ensure data directory exists
const dataDir = process.env.DATA_DIR || './data';
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Global state
let config: AppConfig;
let krakenRestClient: KrakenRestClient | null = null;
let krakenWsClient: KrakenWsClient | null = null;
let fillProcessor: FillProcessor;
let scheduler: Scheduler;
let statusPoller: StatusPoller;

async function main() {
  appLogger.info('Starting Kraken Auto-Sweeper');

  // Load configuration
  config = loadConfig();

  // Initialize database
  initDb();

  // Set initial enabled state from config
  if (config.global.enabledOnBoot) {
    setEnabled(true);
    appLogger.info('Sweeper enabled on boot');
  }

  // Initialize Kraken clients if credentials exist
  const creds = getApiCredentials();
  if (creds) {
    await initializeKrakenClients(creds.apiKey, creds.apiSecret);
  } else {
    appLogger.warn('No API credentials configured - sweeper will not process fills');
  }

  // Initialize fill processor
  fillProcessor = new FillProcessor({
    config,
    onPendingUpdated: (asset, amount) => {
      appLogger.debug({ asset, amount }, 'Pending updated, waking scheduler');
      scheduler?.wake();
    },
  });

  // Initialize scheduler (will be null client until keys are set)
  scheduler = new Scheduler({
    config,
    krakenClient: krakenRestClient!,
    priceProvider: krakenRestClient ? createPriceProvider(krakenRestClient) : undefined,
  });

  scheduler.on('withdrawalStarted', (job) => {
    appLogger.info({ jobId: job.id, asset: job.asset, amount: job.amount }, 'Withdrawal started');
  });

  scheduler.on('withdrawalFailed', (asset, error) => {
    appLogger.error({ asset, error }, 'Withdrawal failed');
  });

  // Initialize status poller
  statusPoller = new StatusPoller({
    krakenClient: krakenRestClient!,
    pollingConfig: config.polling,
  });

  statusPoller.on('jobComplete', (job, txid) => {
    appLogger.info({ jobId: job.id, asset: job.asset, txid }, 'Withdrawal complete');
  });

  statusPoller.on('jobFailed', (job, error) => {
    appLogger.error({ jobId: job.id, asset: job.asset, error }, 'Withdrawal failed');
  });

  statusPoller.on('jobHeld', (job) => {
    appLogger.warn({ jobId: job.id, asset: job.asset }, 'Withdrawal held for review');
  });

  statusPoller.on('jobStuck', (job, duration) => {
    appLogger.warn({ jobId: job.id, asset: job.asset, durationMin: Math.floor(duration / 60000) }, 'Withdrawal appears stuck');
  });

  // Create and start web server
  const app = createWebServer({ config: config.web });

  // Set up routes with context
  const routes = createRoutes({
    config,
    getKrakenClient: () => krakenRestClient,
    reloadConfig: async () => {
      config = reloadConfig();
      fillProcessor.updateConfig(config);
      scheduler.updateConfig(config);
    },
    updateKrakenClient: async (client) => {
      krakenRestClient = client;
      scheduler.updateKrakenClient(client);
      statusPoller.updateKrakenClient(client);

      // Also initialize WebSocket client
      const creds = getApiCredentials();
      if (creds) {
        await initializeWsClient(creds.apiKey, creds.apiSecret);
      }
    },
  });

  app.use(routes);

  // Serve static files for the UI (in production)
  const uiDistPath = join(__dirname, '../../dist');
  if (existsSync(uiDistPath)) {
    const express = await import('express');
    app.use(express.default.static(uiDistPath));
    app.get('*', (req, res) => {
      res.sendFile(join(uiDistPath, 'index.html'));
    });
  }

  // Start web server
  await startServer(app, config.web);

  // Start scheduler and poller if we have clients
  if (krakenRestClient) {
    scheduler.start();
    statusPoller.start();
  }

  // Handle shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  appLogger.info('Kraken Auto-Sweeper started successfully');
}

async function initializeKrakenClients(apiKey: string, apiSecret: string) {
  appLogger.info('Initializing Kraken clients');

  // REST client
  krakenRestClient = new KrakenRestClient({
    apiKey,
    apiSecret,
    dryRun: process.env.DRY_RUN === 'true',
  });

  // WebSocket client
  await initializeWsClient(apiKey, apiSecret);
}

async function initializeWsClient(apiKey: string, apiSecret: string) {
  // Disconnect existing client if any
  if (krakenWsClient) {
    krakenWsClient.disconnect();
  }

  krakenWsClient = new KrakenWsClient({
    apiKey,
    apiSecret,
    onFill: (fill: FillEvent) => {
      appLogger.info({ tradeId: fill.tradeId, pair: fill.pair }, 'Fill received from WebSocket');
      fillProcessor.processFill(fill);
    },
    onConnect: () => {
      appLogger.info('WebSocket connected');
    },
    onDisconnect: () => {
      appLogger.warn('WebSocket disconnected');
    },
    onError: (error) => {
      appLogger.error({ error: error.message }, 'WebSocket error');
    },
  });

  try {
    await krakenWsClient.connect();
  } catch (error) {
    appLogger.error({ error }, 'Failed to connect WebSocket');
  }
}

function shutdown() {
  appLogger.info('Shutting down...');

  // Stop services
  scheduler?.stop();
  statusPoller?.stop();
  krakenWsClient?.disconnect();

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

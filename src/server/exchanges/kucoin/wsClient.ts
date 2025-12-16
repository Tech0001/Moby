/**
 * KuCoin WebSocket Client
 *
 * Connects to KuCoin's private WebSocket to receive real-time fill notifications.
 *
 * KuCoin WebSocket flow:
 * 1. Get connection token via REST API (/api/v1/bullet-private)
 * 2. Connect to WebSocket with token
 * 3. Subscribe to /spotMarket/tradeOrdersV2 for fills
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../utils/logger.js';
import { KuCoinRestClient } from './restClient.js';
import { normalizeKuCoinAsset, parseKuCoinPair } from './normalize.js';
import type { FillEvent } from '../../domain/types.js';

const logger = createChildLogger('kucoin-ws');

export interface KuCoinWsClientOptions {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  onFill?: (fill: FillEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

// KuCoin WebSocket message types
interface KuCoinWsMessage {
  id: string;
  type: string;
  topic?: string;
  subject?: string;
  data?: unknown;
  code?: number;
}

// Trade order match data (fill)
interface KuCoinTradeMatch {
  symbol: string;
  orderType: string;
  side: 'buy' | 'sell';
  orderId: string;
  type: string; // "match" for fills
  tradeId: string;
  price: string;
  size: string;
  funds: string;
  matchPrice: string;
  matchSize: string;
  liquidity: string; // "taker" or "maker"
  feeCurrency: string;
  fee: string;
  ts: number;
}

export class KuCoinWsClient extends EventEmitter {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  private restClient: KuCoinRestClient;
  private ws: WebSocket | null = null;
  private wsToken: string | null = null;
  private wsEndpoint: string | null = null;
  private pingInterval: number = 30000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private shouldConnect: boolean = false;
  private connectId: string = '';

  constructor(options: KuCoinWsClientOptions) {
    super();

    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.passphrase = options.passphrase;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;

    // Create REST client for token management
    this.restClient = new KuCoinRestClient({
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      passphrase: this.passphrase,
    });

    if (options.onFill) this.on('fill', options.onFill);
    if (options.onConnect) this.on('connect', options.onConnect);
    if (options.onDisconnect) this.on('disconnect', options.onDisconnect);
    if (options.onError) this.on('error', options.onError);
  }

  /**
   * Get WebSocket connection details
   */
  private async getWsConnection(): Promise<void> {
    const { token, servers } = await this.restClient.getWsToken();

    if (!servers || servers.length === 0) {
      throw new Error('No WebSocket servers available');
    }

    this.wsToken = token;
    this.wsEndpoint = servers[0].endpoint;
    this.pingInterval = servers[0].pingInterval || 30000;

    logger.debug({ endpoint: this.wsEndpoint }, 'Got WebSocket connection details');
  }

  /**
   * Connect to KuCoin WebSocket
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('Already connected or connecting');
      return;
    }

    this.shouldConnect = true;
    this.isConnecting = true;

    try {
      // Get connection token
      await this.getWsConnection();

      if (!this.wsEndpoint || !this.wsToken) {
        throw new Error('Failed to get WebSocket connection details');
      }

      // Generate unique connection ID
      this.connectId = `conn_${Date.now()}`;

      // Connect with token
      const wsUrl = `${this.wsEndpoint}?token=${this.wsToken}&connectId=${this.connectId}`;
      logger.info('Connecting to KuCoin WebSocket');

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this.isConnecting = false;

        // Start ping timer
        this.startPingTimer();

        // Subscribe to trade orders
        this.subscribe();

        this.emit('connect');
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.info({ code, reason: reason.toString() }, 'WebSocket closed');
        this.handleDisconnect();
      });

      this.ws.on('error', (error: Error) => {
        logger.error({ error: error.message }, 'WebSocket error');
        this.emit('error', error);
      });
    } catch (error) {
      this.isConnecting = false;
      logger.error({ error }, 'Failed to connect');
      this.emit('error', error instanceof Error ? error : new Error(String(error)));

      if (this.autoReconnect && this.shouldConnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.shouldConnect = false;
    this.clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to trade order updates
   */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to trade orders V2 (includes fills)
    const subscribeMsg = {
      id: `sub_${Date.now()}`,
      type: 'subscribe',
      topic: '/spotMarket/tradeOrdersV2',
      privateChannel: true,
      response: true,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.debug('Subscribed to tradeOrdersV2');
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as KuCoinWsMessage;

      switch (msg.type) {
        case 'welcome':
          logger.debug('Welcome message received');
          break;

        case 'pong':
          // Response to our ping
          break;

        case 'ack':
          // Subscription acknowledgment
          logger.info({ id: msg.id }, 'Subscription acknowledged');
          break;

        case 'message':
          this.handleDataMessage(msg);
          break;

        case 'error':
          logger.error({ code: msg.code, data: msg.data }, 'WebSocket error message');
          break;

        default:
          logger.debug({ type: msg.type }, 'Unhandled message type');
      }
    } catch (error) {
      logger.error({ error, data }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Handle data messages (fills, order updates)
   */
  private handleDataMessage(msg: KuCoinWsMessage): void {
    if (msg.topic === '/spotMarket/tradeOrdersV2' && msg.subject === 'orderChange') {
      const orderData = msg.data as KuCoinTradeMatch;

      // Only process match events (fills)
      if (orderData.type === 'match') {
        this.handleFillEvent(orderData);
      }
    }
  }

  /**
   * Handle a fill event and emit normalized FillEvent
   */
  private handleFillEvent(data: KuCoinTradeMatch): void {
    const { base, quote } = parseKuCoinPair(data.symbol);

    const fill: FillEvent = {
      tradeId: data.tradeId,
      orderId: data.orderId,
      pair: `${base}/${quote}`,
      side: data.side,
      orderType: this.normalizeOrderType(data.orderType),
      price: parseFloat(data.matchPrice),
      volume: parseFloat(data.matchSize),
      cost: parseFloat(data.matchPrice) * parseFloat(data.matchSize),
      fee: parseFloat(data.fee),
      feeCurrency: normalizeKuCoinAsset(data.feeCurrency),
      timestamp: data.ts,
    };

    logger.info(
      {
        tradeId: fill.tradeId,
        pair: fill.pair,
        side: fill.side,
        volume: fill.volume,
        price: fill.price,
      },
      'Fill received'
    );

    this.emit('fill', fill);
  }

  /**
   * Normalize KuCoin order types
   */
  private normalizeOrderType(kuCoinType: string): string {
    const typeMap: Record<string, string> = {
      limit: 'limit',
      market: 'market',
      limit_stop: 'stop_limit',
      market_stop: 'stop_market',
    };

    return typeMap[kuCoinType.toLowerCase()] || kuCoinType.toLowerCase();
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    this.clearTimers();
    this.ws = null;
    this.wsToken = null;
    this.isConnecting = false;

    this.emit('disconnect');

    if (this.autoReconnect && this.shouldConnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    logger.info({ delayMs: this.reconnectDelayMs }, 'Scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  /**
   * Start ping timer
   */
  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          id: `ping_${Date.now()}`,
          type: 'ping',
        }));
      }
    }, this.pingInterval);
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

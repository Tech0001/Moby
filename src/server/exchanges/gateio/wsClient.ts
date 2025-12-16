/**
 * Gate.io WebSocket Client
 *
 * Connects to Gate.io's WebSocket to receive real-time fill notifications.
 *
 * Gate.io WebSocket flow:
 * 1. Connect to wss://api.gateio.ws/ws/v4/
 * 2. Authenticate with signed message
 * 3. Subscribe to spot.usertrades channel
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../utils/logger.js';
import { generateWsAuth } from './sign.js';
import { normalizeGateAsset, parseGatePair } from './normalize.js';
import type { FillEvent } from '../../domain/types.js';

const logger = createChildLogger('gateio-ws');

const GATEIO_WS_URL = 'wss://api.gateio.ws/ws/v4/';

export interface GateWsClientOptions {
  apiKey: string;
  apiSecret: string;
  onFill?: (fill: FillEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

// Gate.io WebSocket message types
interface GateWsMessage {
  time: number;
  channel: string;
  event: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// User trade update
interface GateUserTrade {
  id: string;
  user_id: number;
  order_id: string;
  currency_pair: string;
  create_time: number;
  create_time_ms: string;
  side: 'buy' | 'sell';
  amount: string;
  role: 'taker' | 'maker';
  price: string;
  fee: string;
  fee_currency: string;
  point_fee: string;
  gt_fee: string;
  text: string;
}

export class GateWsClient extends EventEmitter {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private shouldConnect: boolean = false;
  private isAuthenticated: boolean = false;

  constructor(options: GateWsClientOptions) {
    super();

    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;

    if (options.onFill) this.on('fill', options.onFill);
    if (options.onConnect) this.on('connect', options.onConnect);
    if (options.onDisconnect) this.on('disconnect', options.onDisconnect);
    if (options.onError) this.on('error', options.onError);
  }

  /**
   * Connect to Gate.io WebSocket
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('Already connected or connecting');
      return;
    }

    this.shouldConnect = true;
    this.isConnecting = true;
    this.isAuthenticated = false;

    try {
      logger.info('Connecting to Gate.io WebSocket');

      this.ws = new WebSocket(GATEIO_WS_URL);

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this.isConnecting = false;

        // Start ping timer
        this.startPingTimer();

        // Authenticate and subscribe
        this.authenticate();
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
   * Authenticate with Gate.io WebSocket
   */
  private authenticate(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const channel = 'spot.usertrades';
    const event = 'subscribe';
    const auth = generateWsAuth(channel, event, this.apiKey, this.apiSecret);

    // First, login
    const loginMsg = {
      time: Math.floor(Date.now() / 1000),
      channel: 'spot.login',
      event: 'api',
      payload: {
        api_key: this.apiKey,
        signature: auth.signature,
        timestamp: auth.timestamp,
      },
    };

    this.ws.send(JSON.stringify(loginMsg));
    logger.debug('Sent authentication message');
  }

  /**
   * Subscribe to user trades channel
   */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isAuthenticated) return;

    const subscribeMsg = {
      time: Math.floor(Date.now() / 1000),
      channel: 'spot.usertrades',
      event: 'subscribe',
      payload: ['!all'], // Subscribe to all trading pairs
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.debug('Subscribed to user trades');
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as GateWsMessage;

      // Handle authentication response
      if (msg.channel === 'spot.login') {
        if (msg.event === 'api' && !msg.error) {
          logger.info('Authentication successful');
          this.isAuthenticated = true;
          this.subscribe();
          this.emit('connect');
        } else if (msg.error) {
          logger.error({ error: msg.error }, 'Authentication failed');
          this.emit('error', new Error(`Auth failed: ${msg.error.message}`));
        }
        return;
      }

      // Handle subscription acknowledgment
      if (msg.event === 'subscribe') {
        if (msg.error) {
          logger.error({ error: msg.error }, 'Subscription failed');
        } else {
          logger.info({ channel: msg.channel }, 'Subscription acknowledged');
        }
        return;
      }

      // Handle user trade updates
      if (msg.channel === 'spot.usertrades' && msg.event === 'update') {
        this.handleTradeUpdate(msg.result as GateUserTrade[]);
        return;
      }

      // Handle pong
      if (msg.channel === 'spot.pong') {
        return;
      }

      logger.debug({ channel: msg.channel, event: msg.event }, 'Unhandled message');
    } catch (error) {
      logger.error({ error, data }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Handle user trade updates (fills)
   */
  private handleTradeUpdate(trades: GateUserTrade[]): void {
    for (const trade of trades) {
      const { base, quote } = parseGatePair(trade.currency_pair);

      const fill: FillEvent = {
        tradeId: trade.id,
        orderId: trade.order_id,
        pair: `${base}/${quote}`,
        side: trade.side,
        orderType: trade.role === 'maker' ? 'limit' : 'market',
        price: parseFloat(trade.price),
        volume: parseFloat(trade.amount),
        cost: parseFloat(trade.price) * parseFloat(trade.amount),
        fee: parseFloat(trade.fee),
        feeCurrency: normalizeGateAsset(trade.fee_currency),
        timestamp: trade.create_time * 1000,
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
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    this.clearTimers();
    this.ws = null;
    this.isConnecting = false;
    this.isAuthenticated = false;

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
   * Gate.io requires ping every 30 seconds
   */
  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const pingMsg = {
          time: Math.floor(Date.now() / 1000),
          channel: 'spot.ping',
        };
        this.ws.send(JSON.stringify(pingMsg));
      }
    }, 30000);
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
    return this.ws?.readyState === WebSocket.OPEN && this.isAuthenticated;
  }
}

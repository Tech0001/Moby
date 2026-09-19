/**
 * Gemini WebSocket Client
 *
 * Connects to Gemini's Order Events WebSocket endpoint to receive
 * real-time fill notifications.
 *
 * Endpoint: wss://api.gemini.com/v1/order/events
 * Auth: Headers (X-GEMINI-APIKEY, X-GEMINI-PAYLOAD, X-GEMINI-SIGNATURE)
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../utils/logger.js';
import { signWsConnection } from './sign.js';
import { normalizeGeminiAsset, parseGeminiPair } from './normalize.js';
import type { FillEvent } from '../../domain/types.js';

const logger = createChildLogger('gemini-ws');

const GEMINI_WS_URL = 'wss://api.gemini.com/v1/order/events';

export interface GeminiWsClientOptions {
  apiKey: string;
  apiSecret: string;
  onFill?: (fill: FillEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

// Gemini Order Event types
interface GeminiOrderEvent {
  type: string;
  order_id: string;
  event_id: string;
  api_session?: string;
  client_order_id?: string;
  symbol: string;
  side: 'buy' | 'sell';
  behavior?: string;
  order_type: string;
  timestamp: string;
  timestampms: number;
  is_live: boolean;
  is_cancelled: boolean;
  is_hidden: boolean;
  avg_execution_price?: string;
  executed_amount?: string;
  remaining_amount?: string;
  original_amount: string;
  price: string;
  total_spend?: string;
  // Fill-specific fields
  fill?: {
    trade_id: string;
    liquidity: string;
    price: string;
    amount: string;
    fee: string;
    fee_currency: string;
  };
}

export class GeminiWsClient extends EventEmitter {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private shouldConnect: boolean = false;
  private lastHeartbeat: number = 0;

  constructor(options: GeminiWsClientOptions) {
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
   * Connect to Gemini WebSocket
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('Already connected or connecting');
      return;
    }

    this.shouldConnect = true;
    this.isConnecting = true;

    try {
      // Generate auth headers
      const authHeaders = signWsConnection(this.apiKey, this.apiSecret);

      logger.info('Connecting to Gemini WebSocket');

      // Connect with authentication headers
      this.ws = new WebSocket(GEMINI_WS_URL, {
        headers: authHeaders,
      });

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this.isConnecting = false;
        this.lastHeartbeat = Date.now();

        // Start heartbeat monitoring
        this.startHeartbeatMonitor();

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
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      // Gemini can send arrays of events or single events
      const parsed = JSON.parse(data);
      const events: GeminiOrderEvent[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const event of events) {
        this.handleEvent(event);
      }
    } catch (error) {
      logger.error({ error, data }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Handle a single order event
   */
  private handleEvent(event: GeminiOrderEvent): void {
    // Update heartbeat on any message
    this.lastHeartbeat = Date.now();

    switch (event.type) {
      case 'heartbeat':
        // Gemini sends heartbeats every ~5 seconds
        logger.debug('Heartbeat received');
        break;

      case 'subscription_ack':
        logger.info('Subscription acknowledged');
        break;

      case 'initial':
        // Initial snapshot of existing orders - ignore for fill processing
        logger.debug({ orderId: event.order_id }, 'Initial order state');
        break;

      case 'accepted':
        logger.debug({ orderId: event.order_id, symbol: event.symbol }, 'Order accepted');
        break;

      case 'fill':
        // This is what we're looking for!
        this.handleFillEvent(event);
        break;

      case 'cancelled':
        logger.debug({ orderId: event.order_id }, 'Order cancelled');
        break;

      case 'closed':
        // Order fully filled or cancelled
        logger.debug({ orderId: event.order_id }, 'Order closed');
        break;

      case 'rejected':
        logger.warn({ orderId: event.order_id, reason: event }, 'Order rejected');
        break;

      default:
        logger.debug({ type: event.type }, 'Unhandled event type');
    }
  }

  /**
   * Handle a fill event and emit normalized FillEvent
   */
  private handleFillEvent(event: GeminiOrderEvent): void {
    if (!event.fill) {
      logger.warn({ event }, 'Fill event without fill data');
      return;
    }

    const { base, quote } = parseGeminiPair(event.symbol);

    const fill: FillEvent = {
      tradeId: event.fill.trade_id,
      orderId: event.order_id,
      pair: `${base}/${quote}`,
      side: event.side,
      orderType: this.normalizeOrderType(event.order_type),
      price: parseFloat(event.fill.price),
      volume: parseFloat(event.fill.amount),
      cost: parseFloat(event.fill.price) * parseFloat(event.fill.amount),
      fee: parseFloat(event.fill.fee),
      feeCurrency: normalizeGeminiAsset(event.fill.fee_currency),
      timestamp: event.timestampms,
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
   * Normalize Gemini order types to our format
   */
  private normalizeOrderType(geminiType: string): string {
    const typeMap: Record<string, string> = {
      'exchange limit': 'limit',
      'exchange stop limit': 'stop_limit',
      'market buy': 'market',
      'market sell': 'market',
      limit: 'limit',
      market: 'market',
    };

    return typeMap[geminiType.toLowerCase()] || geminiType.toLowerCase();
  }

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    this.clearTimers();
    this.ws = null;
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
   * Start heartbeat monitoring
   * Gemini sends heartbeats every ~5 seconds
   */
  private startHeartbeatMonitor(): void {
    this.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastHeartbeat;

      // If no message in 30 seconds, consider connection stale
      if (elapsed > 30000) {
        logger.warn({ elapsedMs: elapsed }, 'Heartbeat timeout, reconnecting');
        this.ws?.close();
      }
    }, 10000);
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

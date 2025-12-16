import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../utils/logger.js';
import type { FillEvent } from '../../domain/types.js';

const logger = createChildLogger('kraken-ws');

const KRAKEN_WS_AUTH_URL = 'https://api.kraken.com/0/private/GetWebSocketsToken';
const KRAKEN_WS_PRIVATE_URL = 'wss://ws-auth.kraken.com';

export interface KrakenWsClientOptions {
  apiKey: string;
  apiSecret: string;
  onFill?: (fill: FillEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

interface WsMessage {
  event?: string;
  channelName?: string;
  status?: string;
  errorMessage?: string;
  reqid?: number;
}

interface TradeData {
  ordertxid: string;
  pair: string;
  time: string;
  type: string;
  ordertype: string;
  price: string;
  cost: string;
  fee: string;
  vol: string;
  margin: string;
  postxid?: string;
}

// OwnTrades message can be either:
// - Snapshot: [Array<Record<tradeId, TradeData>>, "ownTrades", {sequence}]
// - Update: [Record<tradeId, TradeData>, "ownTrades", {sequence}]
type OwnTradesMessage = [
  Record<string, TradeData> | Array<Record<string, TradeData>>,
  string, // channel name
  { sequence: number }
];

export class KrakenWsClient extends EventEmitter {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  private ws: WebSocket | null = null;
  private wsToken: string | null = null;
  private tokenExpiry: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private shouldConnect: boolean = false;

  constructor(options: KrakenWsClientOptions) {
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
   * Get WebSocket authentication token from REST API
   */
  private async getWsToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.wsToken && Date.now() < this.tokenExpiry) {
      return this.wsToken;
    }

    const { generateNonce, generateSignature } = await import('./sign.js');

    const nonce = generateNonce();
    const postData = `nonce=${nonce}`;
    const urlPath = '/0/private/GetWebSocketsToken';
    const signature = generateSignature(urlPath, postData, nonce, this.apiSecret);

    const response = await fetch(KRAKEN_WS_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': this.apiKey,
        'API-Sign': signature,
      },
      body: postData,
    });

    const data = await response.json() as {
      error: string[];
      result?: { token: string; expires: number };
    };

    if (data.error?.length > 0) {
      throw new Error(`Failed to get WS token: ${data.error.join(', ')}`);
    }

    if (!data.result?.token) {
      throw new Error('No token in response');
    }

    this.wsToken = data.result.token;
    // Token expires in ~15 minutes, refresh a bit early
    this.tokenExpiry = Date.now() + (data.result.expires - 60) * 1000;

    logger.debug('Obtained new WebSocket token');
    return this.wsToken;
  }

  /**
   * Connect to Kraken WebSocket
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('Already connected or connecting');
      return;
    }

    this.shouldConnect = true;
    this.isConnecting = true;

    try {
      const token = await this.getWsToken();

      logger.info('Connecting to Kraken WebSocket');

      this.ws = new WebSocket(KRAKEN_WS_PRIVATE_URL);

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this.isConnecting = false;

        // Subscribe to own trades
        this.subscribe(token);

        // Start ping timer
        this.startPingTimer();

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
   * Subscribe to ownTrades channel
   */
  private subscribe(token: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      event: 'subscribe',
      subscription: {
        name: 'ownTrades',
        token,
      },
    };

    this.ws.send(JSON.stringify(subscribeMsg));
    logger.debug('Subscribed to ownTrades');
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // Handle system/subscription messages
      if (msg.event) {
        this.handleEventMessage(msg as WsMessage);
        return;
      }

      // Handle ownTrades data
      if (Array.isArray(msg) && msg[1] === 'ownTrades') {
        this.handleOwnTrades(msg as OwnTradesMessage);
      }
    } catch (error) {
      logger.error({ error, data }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Handle system event messages
   */
  private handleEventMessage(msg: WsMessage): void {
    switch (msg.event) {
      case 'systemStatus':
        logger.debug({ status: msg.status }, 'System status');
        break;

      case 'subscriptionStatus':
        if (msg.status === 'subscribed') {
          logger.info({ channel: msg.channelName }, 'Subscription confirmed');
        } else if (msg.status === 'error') {
          logger.error({ error: msg.errorMessage }, 'Subscription error');
        }
        break;

      case 'heartbeat':
        // Ignore heartbeats
        break;

      case 'pong':
        // Response to our ping
        break;

      default:
        logger.debug({ event: msg.event }, 'Unhandled event');
    }
  }

  /**
   * Handle ownTrades messages (trade executions)
   * Initial snapshot format: [[{trade1}, {trade2}, ...], "ownTrades", {sequence: 1}]
   * Real-time format: [{tradeId: {...}}, "ownTrades", {sequence: n}]
   */
  private handleOwnTrades(msg: OwnTradesMessage): void {
    const data = msg[0];

    // Check if this is the initial snapshot (array of trade objects)
    if (Array.isArray(data)) {
      logger.debug({ count: data.length }, 'Received ownTrades snapshot (ignoring historical trades)');
      // Skip the initial snapshot - we only want real-time fills
      return;
    }

    // Real-time trade update - single object with trade(s)
    const trades = data;

    for (const [tradeId, trade] of Object.entries(trades)) {
      const fill: FillEvent = {
        tradeId,
        orderId: trade.ordertxid,
        pair: trade.pair,
        side: trade.type as 'buy' | 'sell',
        orderType: trade.ordertype,
        price: parseFloat(trade.price),
        volume: parseFloat(trade.vol),
        cost: parseFloat(trade.cost),
        fee: parseFloat(trade.fee),
        feeCurrency: this.getFeeAsset(trade.pair, trade.type),
        timestamp: Math.floor(parseFloat(trade.time) * 1000),
      };

      logger.info(
        {
          tradeId,
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
   * Determine fee currency based on pair and side
   * Kraken typically charges fees in the quote currency for trades
   */
  private getFeeAsset(pair: string, side: string): string {
    // For simplicity, assume fee is in quote currency
    // This should be refined based on actual Kraken behavior
    if (pair.includes('/')) {
      return pair.split('/')[1];
    }
    // Handle pairs like XBTUSD
    return pair.slice(-3);
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
   * Start ping timer to keep connection alive
   */
  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'ping' }));
      }
    }, 30000); // Ping every 30 seconds
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

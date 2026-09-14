import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../utils/logger.js';
import { KrakenRestClient } from './restClient.js';
import { parseTrade } from './trades.js';
import type { FillEvent } from '../../domain/types.js';

const logger = createChildLogger('kraken-ws');
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

export class KrakenWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private tokenClient: KrakenRestClient;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldConnect = false;
  private subscribed = false;
  private generation = 0;
  private lastMessageAt = 0;
  private connectedAt = 0;
  private sequence: number | null = null;
  private attempts = 0;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;

  constructor(options: KrakenWsClientOptions) {
    super();
    this.tokenClient = new KrakenRestClient(options);
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
    if (options.onFill) this.on('fill', options.onFill);
    if (options.onConnect) this.on('connect', options.onConnect);
    if (options.onDisconnect) this.on('disconnect', options.onDisconnect);
    if (options.onError) this.on('error', options.onError);
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws) return;
    this.shouldConnect = true;
    this.isConnecting = true;
    const generation = ++this.generation;
    try {
      const { token } = await this.tokenClient.getWebSocketsToken();
      if (!this.shouldConnect || generation !== this.generation) return;
      const ws = new WebSocket('wss://ws-auth.kraken.com', { handshakeTimeout: 20000 });
      this.ws = ws;
      ws.on('open', () => {
        if (this.ws !== ws) return;
        this.isConnecting = false;
        this.connectedAt = this.lastMessageAt = Date.now();
        ws.send(JSON.stringify({ event: 'subscribe', subscription: {
          name: 'ownTrades', token, snapshot: false, consolidate_taker: false,
        } }));
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastMessageAt > 60000 || (!this.subscribed && Date.now() - this.connectedAt > 20000)) {
            this.fail(new Error('Kraken feed timed out'));
          } else if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'ping' }));
          }
        }, 10000);
      });
      ws.on('message', data => {
        if (this.ws !== ws) return;
        this.lastMessageAt = Date.now();
        this.handleMessage(data.toString());
      });
      ws.on('close', () => { if (this.ws === ws) this.resetConnection(); });
      ws.on('error', error => { if (this.ws === ws) this.fail(error); });
    } catch (error) {
      if (generation === this.generation && this.shouldConnect) this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resetConnection();
  }

  private fail(error: Error): void {
    logger.warn({ error: error.message }, 'Kraken feed needs reconnection');
    if (this.listenerCount('error')) this.emit('error', error);
    this.resetConnection();
  }

  private resetConnection(): void {
    ++this.generation;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.isConnecting = false;
    this.subscribed = false;
    this.sequence = null;
    ws?.terminate();
    this.emit('disconnect');
    if (this.autoReconnect && this.shouldConnect && !this.reconnectTimer) {
      const delay = Math.min(60000, this.reconnectDelayMs * 2 ** Math.min(this.attempts++, 4));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, delay);
    }
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'subscriptionStatus') {
        if (msg.status === 'error') throw new Error(msg.errorMessage || 'Subscription rejected');
        if (msg.status === 'subscribed' && msg.subscription?.name === 'ownTrades') {
          this.subscribed = true;
          this.attempts = 0;
          this.emit('connect');
        }
        return;
      }
      if (!Array.isArray(msg) || msg[1] !== 'ownTrades') return;
      const sequence = msg[2]?.sequence;
      if (!Number.isInteger(sequence) || (this.sequence !== null && sequence !== this.sequence + 1)) {
        throw new Error('Gap in Kraken trade feed sequence');
      }
      this.sequence = sequence;
      if (!Array.isArray(msg[0])) throw new Error('Invalid ownTrades payload');
      for (const entry of msg[0]) {
        for (const [id, trade] of Object.entries(entry)) {
          const fill = parseTrade(id, trade);
          if (!fill) throw new Error('Invalid trade in Kraken feed');
          this.emit('fill', fill);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  isConnected(): boolean { return this.subscribed && this.ws?.readyState === WebSocket.OPEN; }
  getLastMessageAt(): number | null { return this.lastMessageAt || null; }
}

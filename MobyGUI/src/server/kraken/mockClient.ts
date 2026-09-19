import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import type { FillEvent, WithdrawInfo, KrakenWithdrawStatus } from '../domain/types.js';

const logger = createChildLogger('mock-kraken');

/**
 * Mock Kraken REST client for testing and dry-run mode
 */
export class MockKrakenRestClient {
  private balances: Record<string, number> = {};
  private withdrawals: Map<string, MockWithdrawal> = new Map();
  private withdrawalCounter = 0;

  constructor(initialBalances: Record<string, number> = {}) {
    this.balances = { ...initialBalances };
  }

  async getBalance(): Promise<Record<string, string>> {
    logger.debug('[MOCK] Getting balance');
    return Object.fromEntries(
      Object.entries(this.balances).map(([k, v]) => [k, v.toString()])
    );
  }

  async getWithdrawInfo(
    asset: string,
    key: string,
    amount: number
  ): Promise<WithdrawInfo> {
    logger.debug({ asset, key, amount }, '[MOCK] Getting withdrawal info');

    // Simulate network fees
    const fees: Record<string, number> = {
      BTC: 0.00015,
      ETH: 0.005,
      USDT: 1,
      default: 0.01,
    };

    const fee = fees[asset] ?? fees.default;

    return {
      method: `${asset} Network`,
      limit: 100000,
      amount: amount - fee,
      fee,
    };
  }

  async withdraw(
    asset: string,
    key: string,
    amount: number
  ): Promise<{ refid: string }> {
    this.withdrawalCounter++;
    const refid = `MOCK-${Date.now()}-${this.withdrawalCounter}`;

    logger.info({ asset, key, amount, refid }, '[MOCK] Withdrawal submitted');

    // Track the withdrawal
    this.withdrawals.set(refid, {
      refid,
      asset,
      key,
      amount,
      status: 'Pending',
      createdAt: Date.now(),
    });

    // Deduct from balance
    if (this.balances[asset]) {
      this.balances[asset] -= amount;
    }

    return { refid };
  }

  async getWithdrawStatus(asset?: string): Promise<KrakenWithdrawStatus[]> {
    logger.debug({ asset }, '[MOCK] Getting withdrawal status');

    const now = Date.now();
    const results: KrakenWithdrawStatus[] = [];

    for (const [refid, w] of this.withdrawals) {
      if (asset && w.asset !== asset) continue;

      // Simulate status progression
      const age = now - w.createdAt;
      let status = w.status;

      if (age > 60000 && status === 'Pending') {
        status = 'Success';
        w.status = status;
        w.txid = `0x${Math.random().toString(16).slice(2, 66)}`;
      }

      results.push({
        refid,
        method: `${w.asset} Network`,
        aclass: 'currency',
        asset: w.asset,
        amount: w.amount.toString(),
        fee: '0.0001',
        time: Math.floor(w.createdAt / 1000),
        status,
        txid: w.txid,
      });
    }

    return results;
  }

  async getWithdrawAddresses(
    asset?: string
  ): Promise<Array<{ address: string; asset: string; method: string; key: string }>> {
    logger.debug({ asset }, '[MOCK] Getting withdrawal addresses');

    // Return mock addresses
    const addresses = [
      { address: 'bc1qmock...btc1', asset: 'BTC', method: 'Bitcoin', key: 'BTC_COLD_01' },
      { address: 'bc1qmock...btc2', asset: 'BTC', method: 'Bitcoin', key: 'BTC_COLD_02' },
      { address: '0xmock...eth1', asset: 'ETH', method: 'Ethereum', key: 'ETH_COLD_01' },
    ];

    if (asset) {
      return addresses.filter((a) => a.asset === asset);
    }
    return addresses;
  }

  async getTicker(pairs: string[]): Promise<Record<string, { c: [string, string] }>> {
    logger.debug({ pairs }, '[MOCK] Getting ticker');

    // Return mock prices
    const prices: Record<string, number> = {
      'XBTUSD': 100000,
      'ETHUSD': 3500,
      'XXBTZUSD': 100000,
      'XETHZUSD': 3500,
    };

    const result: Record<string, { c: [string, string] }> = {};
    for (const pair of pairs) {
      const price = prices[pair] ?? 1;
      result[pair] = { c: [price.toString(), '0'] };
    }
    return result;
  }

  async testConnection(): Promise<{
    success: boolean;
    hasBalance: boolean;
    hasWithdraw: boolean;
    error?: string;
  }> {
    return { success: true, hasBalance: true, hasWithdraw: true };
  }

  // Test helpers
  setBalance(asset: string, amount: number): void {
    this.balances[asset] = amount;
  }

  getWithdrawal(refid: string): MockWithdrawal | undefined {
    return this.withdrawals.get(refid);
  }

  setWithdrawalStatus(refid: string, status: string, txid?: string): void {
    const w = this.withdrawals.get(refid);
    if (w) {
      w.status = status;
      if (txid) w.txid = txid;
    }
  }
}

interface MockWithdrawal {
  refid: string;
  asset: string;
  key: string;
  amount: number;
  status: string;
  createdAt: number;
  txid?: string;
}

/**
 * Mock Kraken WebSocket client for testing
 */
export class MockKrakenWsClient extends EventEmitter {
  private connected = false;

  constructor() {
    super();
  }

  async connect(): Promise<void> {
    logger.info('[MOCK] WebSocket connecting');
    this.connected = true;

    // Simulate connection delay
    setTimeout(() => {
      this.emit('connect');
    }, 100);
  }

  disconnect(): void {
    logger.info('[MOCK] WebSocket disconnecting');
    this.connected = false;
    this.emit('disconnect');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Test helper: simulate a fill event
  simulateFill(fill: FillEvent): void {
    if (!this.connected) {
      logger.warn('[MOCK] Cannot emit fill - not connected');
      return;
    }

    logger.info({ fill }, '[MOCK] Simulating fill');
    this.emit('fill', fill);
  }

  // Test helper: simulate multiple fills
  simulateFills(fills: FillEvent[]): void {
    for (const fill of fills) {
      this.simulateFill(fill);
    }
  }
}

/**
 * Create a mock fill event for testing
 */
export function createMockFill(overrides: Partial<FillEvent> = {}): FillEvent {
  return {
    tradeId: `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    orderId: `order-${Date.now()}`,
    pair: 'XBT/USD',
    side: 'buy',
    orderType: 'limit',
    price: 100000,
    volume: 0.01,
    cost: 1000,
    fee: 1,
    feeCurrency: 'USD',
    timestamp: Date.now(),
    ...overrides,
  };
}

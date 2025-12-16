/**
 * Gate.io REST API Client
 *
 * Handles authenticated REST API calls for:
 * - Account balances
 * - Withdrawals
 * - Withdrawal status
 * - Open orders
 * - Ticker data
 */

import { createChildLogger } from '../../utils/logger.js';
import { generateHeaders } from './sign.js';
import { normalizeGateAsset, parseGatePair, toGatePair } from './normalize.js';

const logger = createChildLogger('gateio-rest');

const GATEIO_API_BASE = 'https://api.gateio.ws/api/v4';

export interface GateRestClientOptions {
  apiKey: string;
  apiSecret: string;
  dryRun?: boolean;
}

// Gate.io balance types
interface GateAccount {
  currency: string;
  available: string;
  locked: string;
}

// Gate.io withdrawal response
interface GateWithdrawalResponse {
  id: string;
  txid: string;
  currency: string;
  amount: string;
  address: string;
  memo?: string;
  status: string;
  chain: string;
  fee: string;
  timestamp: string;
}

// Gate.io currency info
interface GateCurrencyInfo {
  currency: string;
  min_withdraw_amount: string;
  min_deposit_amount: string;
  withdraw_disabled: boolean;
  withdraw_delayed: boolean;
  deposit_disabled: boolean;
  trade_disabled: boolean;
  fixed_rate: string;
  chain: string;
}

export class GateRestClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly dryRun: boolean;

  constructor(options: GateRestClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Make an authenticated API request
   */
  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<T> {
    const queryString = query ? new URLSearchParams(query).toString() : '';
    const bodyStr = body ? JSON.stringify(body) : '';
    const fullPath = `/api/v4${path}`;
    const url = `${GATEIO_API_BASE}${path}${queryString ? '?' + queryString : ''}`;

    const headers = generateHeaders(
      method,
      fullPath,
      queryString,
      bodyStr,
      this.apiKey,
      this.apiSecret
    );

    logger.debug({ method, path }, 'Making Gate.io API request');

    const response = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' && bodyStr ? bodyStr : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ path, status: response.status, error }, 'Gate.io API error');
      throw new Error(`Gate.io API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get account balances
   */
  async getBalance(): Promise<Record<string, string>> {
    const accounts = await this.request<GateAccount[]>('GET', '/spot/accounts');

    const result: Record<string, string> = {};

    for (const acc of accounts) {
      const available = parseFloat(acc.available);
      if (available > 0) {
        result[normalizeGateAsset(acc.currency)] = acc.available;
      }
    }

    return result;
  }

  /**
   * Get withdrawal fee info
   */
  async getWithdrawInfo(
    asset: string,
    address: string,
    amount: number
  ): Promise<{
    method: string;
    limit: number;
    amount: number;
    fee: number;
  }> {
    // Get currency chain info
    const chains = await this.request<GateCurrencyInfo[]>(
      'GET',
      '/wallet/currency_chains',
      { currency: asset.toUpperCase() }
    );

    if (chains.length === 0) {
      throw new Error(`No chain info for ${asset}`);
    }

    // Use first available chain
    const chain = chains[0];
    const fee = parseFloat(chain.fixed_rate || '0');

    return {
      method: chain.chain || `${asset} Network`,
      limit: 0, // Gate.io doesn't expose remaining limit easily
      amount: amount - fee,
      fee,
    };
  }

  /**
   * Submit a cryptocurrency withdrawal
   */
  async withdraw(
    asset: string,
    address: string,
    amount: number,
    chain?: string,
    memo?: string
  ): Promise<{ refid: string }> {
    if (this.dryRun) {
      logger.info({ asset, address, amount }, '[DRY RUN] Would submit withdrawal');
      return { refid: `DRY-${Date.now()}` };
    }

    const body: Record<string, unknown> = {
      currency: asset.toUpperCase(),
      address,
      amount: amount.toString(),
    };

    if (chain) {
      body.chain = chain;
    }

    if (memo) {
      body.memo = memo;
    }

    const response = await this.request<GateWithdrawalResponse>(
      'POST',
      '/withdrawals',
      undefined,
      body
    );

    logger.info(
      {
        asset,
        address,
        amount,
        withdrawalId: response.id,
      },
      'Withdrawal submitted'
    );

    return { refid: response.id };
  }

  /**
   * Get withdrawal status/history
   */
  async getWithdrawStatus(asset?: string): Promise<
    Array<{
      refid: string;
      method: string;
      aclass: string;
      asset: string;
      amount: string;
      fee: string;
      time: number;
      status: string;
      txid?: string;
      info?: string;
    }>
  > {
    const query: Record<string, string> = { limit: '50' };
    if (asset) {
      query.currency = asset.toUpperCase();
    }

    const withdrawals = await this.request<GateWithdrawalResponse[]>(
      'GET',
      '/wallet/withdrawals',
      query
    );

    return withdrawals.map((w) => ({
      refid: w.id,
      method: w.chain || `${w.currency} Network`,
      aclass: 'currency',
      asset: normalizeGateAsset(w.currency),
      amount: w.amount,
      fee: w.fee,
      time: parseInt(w.timestamp, 10),
      status: this.mapWithdrawalStatus(w.status),
      txid: w.txid || undefined,
      info: w.address,
    }));
  }

  /**
   * Map Gate.io withdrawal status to our format
   */
  private mapWithdrawalStatus(status: string): string {
    switch (status.toUpperCase()) {
      case 'REQUEST':
      case 'PENDING':
        return 'Pending';
      case 'MANUAL':
      case 'BCODE':
        return 'Processing';
      case 'DONE':
        return 'Success';
      case 'CANCEL':
        return 'Cancelled';
      case 'FAIL':
        return 'Failure';
      default:
        return status;
    }
  }

  /**
   * Get saved withdrawal addresses from Gate.io
   * Uses the /wallet/saved_address endpoint
   */
  async getWithdrawAddresses(
    asset?: string,
    method?: string
  ): Promise<
    Array<{
      address: string;
      asset: string;
      method: string;
      key: string;
      memo?: string;
    }>
  > {
    interface GateSavedAddress {
      currency: string;
      chain: string;
      address: string;
      name: string;
      tag?: string;
      verified: string;
    }

    const results: Array<{
      address: string;
      asset: string;
      method: string;
      key: string;
      memo?: string;
    }> = [];

    // If specific asset requested, fetch just that one
    if (asset) {
      try {
        const addresses = await this.request<GateSavedAddress[]>(
          'GET',
          '/wallet/saved_address',
          { currency: asset.toUpperCase() }
        );

        for (const addr of addresses) {
          // Skip unverified addresses if desired
          if (addr.verified !== '1') {
            logger.debug({ asset: addr.currency, name: addr.name }, 'Skipping unverified address');
            continue;
          }

          // Filter by method/chain if specified
          if (method && addr.chain.toLowerCase() !== method.toLowerCase()) {
            continue;
          }

          results.push({
            address: addr.address,
            asset: normalizeGateAsset(addr.currency),
            method: addr.chain,
            key: addr.name,
            memo: addr.tag || undefined,
          });
        }
      } catch (error) {
        logger.debug({ asset, error }, 'Failed to fetch addresses for asset');
      }
    } else {
      // Fetch addresses for all currencies we have balances for
      // First get list of currencies with balance
      const balances = await this.getBalance();
      const currencies = Object.keys(balances);

      for (const currency of currencies) {
        try {
          const addresses = await this.request<GateSavedAddress[]>(
            'GET',
            '/wallet/saved_address',
            { currency: currency.toUpperCase() }
          );

          for (const addr of addresses) {
            if (addr.verified !== '1') {
              continue;
            }

            if (method && addr.chain.toLowerCase() !== method.toLowerCase()) {
              continue;
            }

            results.push({
              address: addr.address,
              asset: normalizeGateAsset(addr.currency),
              method: addr.chain,
              key: addr.name,
              memo: addr.tag || undefined,
            });
          }
        } catch (error) {
          // Currency may not have saved addresses
          logger.debug({ currency, error }, 'No saved addresses for currency');
        }
      }
    }

    logger.info({ count: results.length }, 'Fetched Gate.io saved addresses');
    return results;
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<{
    open: Record<
      string,
      {
        descr: { pair: string; type: string; ordertype: string; price: string; order: string };
        vol: string;
        vol_exec: string;
        cost: string;
        fee: string;
        status: string;
        opentm: number;
      }
    >;
  }> {
    interface GateOrder {
      id: string;
      text: string;
      create_time: string;
      update_time: string;
      currency_pair: string;
      status: string;
      type: string;
      account: string;
      side: string;
      amount: string;
      price: string;
      time_in_force: string;
      iceberg: string;
      left: string;
      fill_price: string;
      filled_total: string;
      fee: string;
      fee_currency: string;
      point_fee: string;
      gt_fee: string;
      gt_discount: boolean;
      rebated_fee: string;
      rebated_fee_currency: string;
    }

    const orders = await this.request<GateOrder[]>('GET', '/spot/orders', {
      status: 'open',
    });

    const open: Record<string, any> = {};
    for (const order of orders) {
      const { base, quote } = parseGatePair(order.currency_pair);
      open[order.id] = {
        descr: {
          pair: `${base}/${quote}`,
          type: order.side,
          ordertype: order.type,
          price: order.price,
          order: `${order.side} ${order.amount} ${order.currency_pair} @ ${order.price}`,
        },
        vol: order.amount,
        vol_exec: (parseFloat(order.amount) - parseFloat(order.left)).toString(),
        cost: order.filled_total,
        fee: order.fee,
        status: 'open',
        opentm: parseInt(order.create_time, 10),
      };
    }

    return { open };
  }

  /**
   * Get ticker information
   */
  async getTicker(pairs: string[]): Promise<Record<string, { c: [string, string] }>> {
    const result: Record<string, { c: [string, string] }> = {};

    for (const pair of pairs) {
      try {
        let gatePair = pair;
        if (pair.includes('/')) {
          const [base, quote] = pair.split('/');
          gatePair = toGatePair(base, quote);
        }

        interface GateTicker {
          currency_pair: string;
          last: string;
          lowest_ask: string;
          highest_bid: string;
          change_percentage: string;
          base_volume: string;
          quote_volume: string;
          high_24h: string;
          low_24h: string;
        }

        // Get single ticker
        const tickers = await this.request<GateTicker[]>('GET', '/spot/tickers', {
          currency_pair: gatePair,
        });

        if (tickers.length > 0) {
          result[pair] = { c: [tickers[0].last, '0'] };
        }
      } catch (error) {
        logger.debug({ pair, error }, 'Failed to get ticker');
      }
    }

    return result;
  }

  /**
   * Get recent fills/trades
   */
  async getRecentFills(limit: number = 50): Promise<
    Array<{
      tradeId: string;
      orderId: string;
      pair: string;
      side: 'buy' | 'sell';
      price: string;
      amount: string;
      fee: string;
      feeCurrency: string;
      timestamp: number;
    }>
  > {
    interface GateTrade {
      id: string;
      create_time: string;
      currency_pair: string;
      side: 'buy' | 'sell';
      role: string;
      amount: string;
      price: string;
      order_id: string;
      fee: string;
      fee_currency: string;
      point_fee: string;
      gt_fee: string;
    }

    const trades = await this.request<GateTrade[]>('GET', '/spot/my_trades', {
      limit: limit.toString(),
    });

    return trades.map((t) => ({
      tradeId: t.id,
      orderId: t.order_id,
      pair: t.currency_pair.replace('_', '/'),
      side: t.side,
      price: t.price,
      amount: t.amount,
      fee: t.fee,
      feeCurrency: normalizeGateAsset(t.fee_currency),
      timestamp: parseInt(t.create_time, 10) * 1000,
    }));
  }

  /**
   * Test API connection and permissions
   */
  async testConnection(): Promise<{
    success: boolean;
    hasBalance: boolean;
    hasWithdraw: boolean;
    error?: string;
  }> {
    try {
      // Test balance permission
      await this.getBalance();
      const hasBalance = true;

      // Test withdrawal info (indicates withdrawal permission)
      let hasWithdraw = false;
      try {
        await this.getWithdrawInfo('BTC', '', 0.001);
        hasWithdraw = true;
      } catch {
        // May not have withdrawal permission
      }

      return { success: true, hasBalance, hasWithdraw };
    } catch (error) {
      return {
        success: false,
        hasBalance: false,
        hasWithdraw: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

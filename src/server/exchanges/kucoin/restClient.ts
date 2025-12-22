/**
 * KuCoin REST API Client
 *
 * Handles authenticated REST API calls for:
 * - Account balances
 * - Withdrawals
 * - Withdrawal status
 * - Withdrawal addresses
 */

import { createChildLogger } from '../../utils/logger.js';
import { generateHeaders } from './sign.js';
import { normalizeKuCoinAsset, parseKuCoinPair, toKuCoinPair } from './normalize.js';

const logger = createChildLogger('kucoin-rest');

const KUCOIN_API_BASE = 'https://api.kucoin.com';

export interface KuCoinRestClientOptions {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  dryRun?: boolean;
}

// KuCoin API response wrapper
interface KuCoinResponse<T> {
  code: string;
  msg?: string;
  data: T;
}

// KuCoin balance types
interface KuCoinAccount {
  id: string;
  currency: string;
  type: string; // "main", "trade", "margin"
  balance: string;
  available: string;
  holds: string;
}

// KuCoin withdrawal response
interface KuCoinWithdrawalResponse {
  withdrawalId: string;
}

// KuCoin withdrawal record
interface KuCoinWithdrawal {
  id: string;
  address: string;
  memo: string;
  currency: string;
  amount: string;
  fee: string;
  walletTxId: string;
  isInner: boolean;
  status: string; // "PROCESSING", "WALLET_PROCESSING", "SUCCESS", "FAILURE"
  remark: string;
  createdAt: number;
  updatedAt: number;
}

// KuCoin withdrawal address
interface KuCoinWithdrawalAddress {
  address: string;
  memo: string;
  chain: string;
  contractAddress: string;
}

// KuCoin currency info (for min withdrawal)
interface KuCoinCurrencyChain {
  chainId: string;
  withdrawalMinSize: string;
  withdrawalMinFee: string;
  isWithdrawEnabled: boolean;
}

interface KuCoinCurrency {
  currency: string;
  chains: KuCoinCurrencyChain[];
}

export class KuCoinRestClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly dryRun: boolean;

  constructor(options: KuCoinRestClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.passphrase = options.passphrase;
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Make an authenticated API request
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${KUCOIN_API_BASE}${endpoint}`;
    const bodyStr = body ? JSON.stringify(body) : '';

    const headers = generateHeaders(
      method,
      endpoint,
      bodyStr,
      this.apiKey,
      this.apiSecret,
      this.passphrase
    );

    logger.debug({ method, endpoint }, 'Making KuCoin API request');

    const response = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' && bodyStr ? bodyStr : undefined,
    });

    const data = (await response.json()) as KuCoinResponse<T>;

    if (data.code !== '200000') {
      const errorMsg = data.msg || `Error code: ${data.code}`;
      logger.error({ endpoint, code: data.code, msg: data.msg, httpStatus: response.status }, 'KuCoin API error');
      throw new Error(`KuCoin error (${data.code}): ${errorMsg}`);
    }

    return data.data;
  }

  /**
   * Get account balances
   */
  async getBalance(): Promise<Record<string, string>> {
    const accounts = await this.request<KuCoinAccount[]>('GET', '/api/v1/accounts');

    const result: Record<string, string> = {};

    // Sum up available balances across all account types
    for (const acc of accounts) {
      const asset = normalizeKuCoinAsset(acc.currency);
      const available = parseFloat(acc.available);

      if (!result[asset]) {
        result[asset] = '0';
      }
      result[asset] = (parseFloat(result[asset]) + available).toString();
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
    interface WithdrawalQuota {
      currency: string;
      limitBTCAmount: string;
      usedBTCAmount: string;
      remainAmount: string;
      availableAmount: string;
      withdrawMinFee: string;
      innerWithdrawMinFee: string;
      withdrawMinSize: string;
      isWithdrawEnabled: boolean;
      precision: number;
      chain: string;
    }

    const quota = await this.request<WithdrawalQuota>(
      'GET',
      `/api/v1/withdrawals/quotas?currency=${asset.toUpperCase()}`
    );

    const fee = parseFloat(quota.withdrawMinFee);

    return {
      method: quota.chain || `${asset} Network`,
      limit: parseFloat(quota.remainAmount),
      amount: amount - fee,
      fee,
    };
  }

  /**
   * Get withdrawal methods (min sizes/fees) for all currencies
   */
  async getWithdrawMethods(): Promise<
    Array<{
      asset: string;
      method: string;
      network?: string;
      minimum: number;
      maximum?: number;
      fee?: number;
      genAddress: boolean;
    }>
  > {
    const currencies = await this.request<KuCoinCurrency[]>('GET', '/api/v3/currencies');

    const methods: Array<{
      asset: string;
      method: string;
      network?: string;
      minimum: number;
      maximum?: number;
      fee?: number;
      genAddress: boolean;
    }> = [];

    for (const c of currencies) {
      const asset = normalizeKuCoinAsset(c.currency);
      for (const chain of c.chains || []) {
        if (!chain.isWithdrawEnabled) continue;
        const minimum = parseFloat(chain.withdrawalMinSize);
        const fee = parseFloat(chain.withdrawalMinFee);
        const network = chain.chainId || undefined;
        const method = network || `${asset} Network`;
        methods.push({
          asset,
          method,
          network,
          minimum: Number.isFinite(minimum) ? minimum : 0,
          maximum: undefined,
          fee: Number.isFinite(fee) ? fee : undefined,
          genAddress: false,
        });
      }
    }

    return methods;
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

    const response = await this.request<KuCoinWithdrawalResponse>(
      'POST',
      '/api/v3/withdrawals',
      body
    );

    logger.info(
      {
        asset,
        address,
        amount,
        withdrawalId: response.withdrawalId,
      },
      'Withdrawal submitted'
    );

    return { refid: response.withdrawalId };
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
    let endpoint = '/api/v1/withdrawals?pageSize=50';
    if (asset) {
      endpoint += `&currency=${asset.toUpperCase()}`;
    }

    interface WithdrawalList {
      currentPage: number;
      pageSize: number;
      totalNum: number;
      totalPage: number;
      items: KuCoinWithdrawal[];
    }

    const result = await this.request<WithdrawalList>('GET', endpoint);

    return result.items.map((w) => ({
      refid: w.id,
      method: `${w.currency} Network`,
      aclass: 'currency',
      asset: normalizeKuCoinAsset(w.currency),
      amount: w.amount,
      fee: w.fee,
      time: Math.floor(w.createdAt / 1000),
      status: this.mapWithdrawalStatus(w.status),
      txid: w.walletTxId || undefined,
      info: w.address,
    }));
  }

  /**
   * Map KuCoin withdrawal status to our format
   */
  private mapWithdrawalStatus(status: string): string {
    switch (status.toUpperCase()) {
      case 'PROCESSING':
      case 'WALLET_PROCESSING':
        return 'Processing';
      case 'SUCCESS':
        return 'Success';
      case 'FAILURE':
        return 'Failure';
      default:
        return status;
    }
  }

  /**
   * Get withdrawal addresses (favorites)
   * Note: KuCoin requires addresses to be added as favorites for withdrawal
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
    // KuCoin's deposit addresses endpoint
    // Note: KuCoin doesn't have a direct "withdrawal addresses" list like Kraken
    // You need to manually manage your withdrawal addresses
    // This returns deposit addresses which can be used as a reference
    const addresses: Array<{
      address: string;
      asset: string;
      method: string;
      key: string;
      memo?: string;
    }> = [];

    // If you need withdrawal favorites, you'd need to store them locally
    // or use KuCoin's internal transfer system

    logger.debug({ asset }, 'KuCoin does not have a withdrawal address list endpoint');
    logger.debug('You must configure withdrawal addresses manually in your config');

    return addresses;
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
    interface KuCoinOrder {
      id: string;
      symbol: string;
      opType: string;
      type: string;
      side: string;
      price: string;
      size: string;
      funds: string;
      dealFunds: string;
      dealSize: string;
      fee: string;
      feeCurrency: string;
      stp: string;
      stop: string;
      stopTriggered: boolean;
      stopPrice: string;
      timeInForce: string;
      postOnly: boolean;
      hidden: boolean;
      iceberg: boolean;
      visibleSize: string;
      cancelAfter: number;
      channel: string;
      clientOid: string;
      remark: string;
      tags: string;
      isActive: boolean;
      cancelExist: boolean;
      createdAt: number;
      tradeType: string;
    }

    interface OrderList {
      currentPage: number;
      pageSize: number;
      totalNum: number;
      totalPage: number;
      items: KuCoinOrder[];
    }

    const result = await this.request<OrderList>('GET', '/api/v1/orders?status=active');

    const open: Record<string, any> = {};
    for (const order of result.items) {
      if (order.isActive) {
        const { base, quote } = parseKuCoinPair(order.symbol);
        open[order.id] = {
          descr: {
            pair: `${base}/${quote}`,
            type: order.side,
            ordertype: order.type,
            price: order.price,
            order: `${order.side} ${order.size} ${order.symbol} @ ${order.price}`,
          },
          vol: order.size,
          vol_exec: order.dealSize,
          cost: order.dealFunds,
          fee: order.fee,
          status: 'open',
          opentm: order.createdAt / 1000,
        };
      }
    }

    return { open };
  }

  /**
   * Get ticker information
   */
  async getTicker(
    pairs: string[]
  ): Promise<Record<string, { c: [string, string] }>> {
    const result: Record<string, { c: [string, string] }> = {};

    for (const pair of pairs) {
      try {
        // Convert to KuCoin format
        let kucoinPair = pair;
        if (pair.includes('/')) {
          const [base, quote] = pair.split('/');
          kucoinPair = toKuCoinPair(base, quote);
        }

        const response = await fetch(
          `${KUCOIN_API_BASE}/api/v1/market/orderbook/level1?symbol=${kucoinPair}`
        );

        if (response.ok) {
          const data = (await response.json()) as KuCoinResponse<{
            price: string;
            size: string;
            bestBid: string;
            bestBidSize: string;
            bestAsk: string;
            bestAskSize: string;
            sequence: string;
            time: number;
          }>;

          if (data.code === '200000' && data.data) {
            result[pair] = { c: [data.data.price, '0'] };
          }
        }
      } catch (error) {
        logger.debug({ pair, error }, 'Failed to get ticker');
      }
    }

    return result;
  }

  /**
   * Get WebSocket connection token
   * KuCoin requires a token for private WebSocket connections
   */
  async getWsToken(): Promise<{
    token: string;
    servers: Array<{
      endpoint: string;
      encrypt: boolean;
      protocol: string;
      pingInterval: number;
      pingTimeout: number;
    }>;
  }> {
    interface WsTokenResponse {
      token: string;
      instanceServers: Array<{
        endpoint: string;
        encrypt: boolean;
        protocol: string;
        pingInterval: number;
        pingTimeout: number;
      }>;
    }

    const result = await this.request<WsTokenResponse>(
      'POST',
      '/api/v1/bullet-private'
    );

    return {
      token: result.token,
      servers: result.instanceServers,
    };
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

      // Test withdrawal quota (indicates withdrawal permission)
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

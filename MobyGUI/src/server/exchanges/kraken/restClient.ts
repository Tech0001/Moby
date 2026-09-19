import { generateSignature, generateNonce } from './sign.js';
import { globalRateLimiter, RateLimiter } from './rateLimiter.js';
import { createChildLogger } from '../../utils/logger.js';
import type { WithdrawInfo, KrakenWithdrawStatus } from '../../domain/types.js';

const logger = createChildLogger('kraken-rest');

const KRAKEN_API_URL = 'https://api.kraken.com';

export interface KrakenRestClientOptions {
  apiKey: string;
  apiSecret: string;
  rateLimiter?: RateLimiter;
  dryRun?: boolean;
  beforeRequest?: () => void;
}

export interface KrakenResponse<T> {
  error: string[];
  result?: T;
}

export class KrakenApiError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Kraken API error: ${errors.join(', ')}`);
  }
  get definitelyRejected(): boolean {
    return this.errors.every(error => /^(EAPI:|EAuth:|EFunding:|EGeneral:Permission|EOrder:)/.test(error));
  }
}

// Serialize private requests per key, including calls from connection tests.
const privateQueues = new Map<string, Promise<unknown>>();
export type KrakenClient = Pick<KrakenRestClient,
  'getWithdrawInfo' | 'withdraw' | 'getWithdrawStatus' | 'getTradesHistory' | 'getTicker'>;

export class KrakenRestClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rateLimiter: RateLimiter;
  private readonly dryRun: boolean;
  private readonly beforeRequest?: () => void;

  constructor(options: KrakenRestClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.rateLimiter = options.rateLimiter ?? globalRateLimiter;
    this.dryRun = options.dryRun ?? false;
    this.beforeRequest = options.beforeRequest;
  }

  /**
   * Make a private API request (requires authentication)
   */
  private async privateRequest<T>(
    endpoint: string,
    params: Record<string, string | number> = {},
    cost: number = 1,
    beforeSend?: () => boolean
  ): Promise<T> {
    const previous = privateQueues.get(this.apiKey) ?? Promise.resolve();
    const request = previous.catch(() => {}).then(() => this.sendPrivateRequest<T>(endpoint, params, cost, beforeSend));
    privateQueues.set(this.apiKey, request);
    try { return await request; }
    finally { if (privateQueues.get(this.apiKey) === request) privateQueues.delete(this.apiKey); }
  }

  private async sendPrivateRequest<T>(
    endpoint: string, params: Record<string, string | number>, cost: number, beforeSend?: () => boolean,
  ): Promise<T> {
    await this.rateLimiter.waitForToken(cost);
    try { this.beforeRequest?.(); }
    catch { throw new KrakenApiError(['EAPI:Credentials changed before submission']); }
    if (beforeSend && !beforeSend()) throw new KrakenApiError(['EAPI:Withdrawal stopped before submission']);

    const urlPath = `/0/private/${endpoint}`;
    const nonce = generateNonce();

    const postData = new URLSearchParams({
      nonce,
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ),
    }).toString();

    const signature = generateSignature(urlPath, postData, nonce, this.apiSecret);

    const response = await fetch(`${KRAKEN_API_URL}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': this.apiKey,
        'API-Sign': signature,
      },
      body: postData,
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as KrakenResponse<T>;

    if (data.error && data.error.length > 0) {
      const errorMsg = data.error.join(', ');
      logger.error({ endpoint, error: errorMsg }, 'Kraken API error');
      throw new KrakenApiError(data.error);
    }

    if (data.result === undefined || data.result === null) throw new Error('Missing Kraken response result');
    return data.result as T;
  }

  /**
   * Make a public API request (no authentication)
   */
  private async publicRequest<T>(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    await this.rateLimiter.waitForToken(0.5); // Public endpoints cost less

    const urlPath = `/0/public/${endpoint}`;
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${KRAKEN_API_URL}${urlPath}?${queryString}` : `${KRAKEN_API_URL}${urlPath}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as KrakenResponse<T>;

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(', ')}`);
    }

    if (data.result === undefined || data.result === null) throw new Error('Missing Kraken response result');
    return data.result as T;
  }

  async getWebSocketsToken(): Promise<{ token: string; expires: number }> {
    return this.privateRequest('GetWebSocketsToken');
  }

  // ============== Account Balance ==============

  async getBalance(): Promise<Record<string, string>> {
    logger.debug('Fetching account balance');
    return this.privateRequest<Record<string, string>>('Balance');
  }

  // ============== Withdrawal Methods ==============

  async getWithdrawMethods(asset?: string): Promise<Array<{
    asset: string;
    method: string;
    network?: string;
    minimum: string;
    limit: string | false;
    fee?: string;
    'gen-address': boolean;
  }>> {
    logger.debug({ asset }, 'Getting withdrawal methods');

    const params: Record<string, string> = {};
    if (asset) params.asset = asset;

    return this.privateRequest<Array<{
      asset: string;
      method: string;
      network?: string;
      minimum: string;
      limit: string | false;
      fee?: string;
      'gen-address': boolean;
    }>>('WithdrawMethods', params);
  }


  /**
   * Get withdrawal info (limits, fees) for an asset
   */
  async getWithdrawInfo(
    asset: string,
    key: string,
    amount: number
  ): Promise<WithdrawInfo> {
    logger.debug({ asset, key, amount }, 'Getting withdrawal info');

    const result = await this.privateRequest<{
      method: string;
      limit: string;
      amount: string;
      fee: string;
    }>('WithdrawInfo', {
      asset,
      key,
      amount,
    });

    return {
      method: result.method,
      limit: parseFloat(result.limit),
      amount: parseFloat(result.amount),
      fee: parseFloat(result.fee),
    };
  }

  /**
   * Submit a withdrawal request
   */
  async withdraw(
    asset: string,
    key: string,
    amount: number,
    maxFee?: number,
    beforeSend?: () => boolean,
  ): Promise<{ refid: string }> {
    if (this.dryRun) {
      logger.info({ asset, key, amount }, '[DRY RUN] Would submit withdrawal');
      return { refid: `dry-run-${Date.now()}` };
    }

    logger.info({ asset, key, amount }, 'Submitting withdrawal');

    const result = await this.privateRequest<{ refid: string }>(
      'Withdraw',
      { asset, key, amount: amount.toFixed(8), ...(maxFee === undefined ? {} : { max_fee: maxFee.toFixed(8) }) },
      2,
      beforeSend
    );

    logger.info({ asset, key, amount, refid: result.refid }, 'Withdrawal submitted');
    return result;
  }

  /**
   * Get status of recent withdrawals
   */
  async getWithdrawStatus(asset?: string): Promise<KrakenWithdrawStatus[]> {
    logger.debug({ asset }, 'Getting withdrawal status');

    const params: Record<string, string> = {};
    if (asset) {
      params.asset = asset;
    }

    // Explicit pagination prevents long-lived held jobs falling out of the first page.
    const statuses: KrakenWithdrawStatus[] = [];
    let cursor = 'true';
    const seen = new Set<string>();
    do {
      if (seen.has(cursor)) throw new Error('Repeated withdrawal status cursor');
      seen.add(cursor);
      const result = await this.privateRequest<KrakenWithdrawStatus[] | {
        withdrawals: KrakenWithdrawStatus[]; cursor?: string;
      }>('WithdrawStatus', { ...params, cursor, limit: 500 });
      if (Array.isArray(result)) return [...statuses, ...result];
      if (!Array.isArray(result.withdrawals)) throw new Error('Invalid withdrawal status response');
      statuses.push(...result.withdrawals);
      cursor = result.cursor || '';
    } while (cursor);
    return statuses;
  }

  /**
   * Get list of pre-saved withdrawal addresses
   */
  async getWithdrawAddresses(
    asset?: string,
    method?: string
  ): Promise<Array<{ address: string; asset: string; method: string; key: string }>> {
    logger.debug({ asset, method }, 'Getting withdrawal addresses');

    const params: Record<string, string> = {};
    if (asset) params.asset = asset;
    if (method) params.method = method;

    return this.privateRequest<Array<{ address: string; asset: string; method: string; key: string }>>(
      'WithdrawAddresses',
      params
    );
  }

  // ============== Orders ==============

  /**
   * Get open orders (pending/partially filled)
   */
  async getOpenOrders(): Promise<{
    open: Record<string, {
      refid: string | null;
      userref: number | null;
      status: string;
      opentm: number;
      starttm: number;
      expiretm: number;
      descr: {
        pair: string;
        type: string;
        ordertype: string;
        price: string;
        price2: string;
        leverage: string;
        order: string;
        close: string;
      };
      vol: string;
      vol_exec: string;
      cost: string;
      fee: string;
      price: string;
      stopprice: string;
      limitprice: string;
      misc: string;
      oflags: string;
    }>;
  }> {
    logger.debug('Fetching open orders');
    return this.privateRequest('OpenOrders');
  }

  // ============== Trade History ==============

  /**
   * Get closed orders for reconciliation
   */
  async getClosedOrders(options: {
    start?: number;
    end?: number;
    offset?: number;
  } = {}): Promise<{
    closed: Record<string, unknown>;
    count: number;
  }> {
    const params: Record<string, string | number> = {};
    if (options.start) params.start = options.start;
    if (options.end) params.end = options.end;
    if (options.offset) params.ofs = options.offset;

    return this.privateRequest('ClosedOrders', params);
  }

  /**
   * Get trade history for reconciliation
   */
  async getTradesHistory(options: {
    start?: number;
    end?: number;
    offset?: number;
  } = {}): Promise<{
    trades: Record<string, unknown>;
    count: number;
  }> {
    const params: Record<string, string | number> = {};
    if (options.start) params.start = options.start;
    if (options.end) params.end = options.end;
    if (options.offset) params.ofs = options.offset;

    return this.privateRequest('TradesHistory', params);
  }

  // ============== Public Data ==============

  /**
   * Get ticker price for USD conversion
   */
  async getTicker(pairs: string[]): Promise<Record<string, { c: [string, string] }>> {
    return this.publicRequest('Ticker', { pair: pairs.join(',') });
  }

  /**
   * Get asset pairs info
   */
  async getAssetPairs(): Promise<Record<string, {
    altname: string;
    base: string;
    quote: string;
  }>> {
    return this.publicRequest('AssetPairs');
  }

  // ============== Connection Test ==============

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

      // Test withdraw info (doesn't actually withdraw)
      let hasWithdraw = false;
      try {
        // This will fail if no addresses configured, but that's okay
        await this.getWithdrawAddresses();
        hasWithdraw = true;
      } catch {
        hasWithdraw = false;
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

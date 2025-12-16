/**
 * Gemini REST API Client
 *
 * Handles authenticated REST API calls for:
 * - Account balances
 * - Withdrawals
 * - Withdrawal status
 * - Transfer history
 */

import { createChildLogger } from '../../utils/logger.js';
import { signRequest } from './sign.js';
import { normalizeGeminiAsset, toGeminiAsset } from './normalize.js';

const logger = createChildLogger('gemini-rest');

const GEMINI_API_BASE = 'https://api.gemini.com';

export interface GeminiRestClientOptions {
  apiKey: string;
  apiSecret: string;
  dryRun?: boolean;
}

// Gemini API response types
interface GeminiBalance {
  type: string;
  currency: string;
  amount: string;
  available: string;
  availableForWithdrawal: string;
}

interface GeminiWithdrawResponse {
  address: string;
  amount: string;
  txHash?: string;
  withdrawalId: string;
  message: string;
}

interface GeminiTransfer {
  type: string; // "Deposit" | "Withdrawal" | "AdminCredit" | "AdminDebit" | etc.
  status: string; // "Advanced" | "Complete" | "Pending"
  timestampms: number;
  eid: number; // Transfer ID
  currency: string;
  amount: string;
  feeAmount?: string;
  feeCurrency?: string;
  method?: string;
  txHash?: string;
  outputIdx?: number;
  destination?: string;
  purpose?: string;
}

interface GeminiApprovedAddress {
  network: string;
  scope: string; // 'account' | 'group'
  label: string;
  status: string; // 'active' | 'pending-time'
  createdAt: string;
  address: string;
}

interface GeminiWithdrawAddressesResponse {
  approvedAddresses: GeminiApprovedAddress[];
}

export class GeminiRestClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly dryRun: boolean;

  constructor(options: GeminiRestClientOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Make an authenticated API request
   */
  private async request<T>(
    endpoint: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    const url = `${GEMINI_API_BASE}${endpoint}`;
    const headers = signRequest(endpoint, payload, this.apiKey, this.apiSecret);

    logger.debug({ endpoint }, 'Making Gemini API request');

    const response = await fetch(url, {
      method: 'POST',
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      const error = data as { reason?: string; message?: string };
      const errorMsg = error.reason || error.message || `HTTP ${response.status}`;
      logger.error({ endpoint, error: errorMsg }, 'Gemini API error');
      throw new Error(errorMsg);
    }

    return data as T;
  }

  /**
   * Get account balances
   */
  async getBalance(): Promise<Record<string, string>> {
    const balances = await this.request<GeminiBalance[]>('/v1/balances');

    const result: Record<string, string> = {};
    for (const bal of balances) {
      const asset = normalizeGeminiAsset(bal.currency);
      // Use available balance (what can be traded/withdrawn)
      result[asset] = bal.available;
    }

    return result;
  }

  /**
   * Get withdrawal fee estimate
   * Note: Gemini doesn't have a separate endpoint for this,
   * so we return a placeholder. The actual fee is shown in the withdrawal response.
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
    // Gemini doesn't have a pre-withdrawal fee endpoint
    // Return estimate based on typical fees
    const feeEstimates: Record<string, number> = {
      BTC: 0.0001,
      ETH: 0.001,
      LTC: 0.001,
      USDC: 0,
      GUSD: 0, // Gemini's stablecoin often has free withdrawals
      default: 0,
    };

    const fee = feeEstimates[asset] ?? feeEstimates.default;

    return {
      method: `${asset} Network`,
      limit: 1000000, // Gemini has high limits for verified accounts
      amount: amount - fee,
      fee,
    };
  }

  /**
   * Submit a cryptocurrency withdrawal
   * Requires the address to be on the approved whitelist
   */
  async withdraw(
    asset: string,
    address: string,
    amount: number
  ): Promise<{ refid: string }> {
    const currency = toGeminiAsset(asset);

    if (this.dryRun) {
      logger.info({ asset, address, amount }, '[DRY RUN] Would submit withdrawal');
      return { refid: `DRY-${Date.now()}` };
    }

    const response = await this.request<GeminiWithdrawResponse>(
      `/v1/withdraw/${currency}`,
      {
        address,
        amount: amount.toString(),
      }
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
   * Get withdrawal status by fetching transfer history
   * Gemini uses /v1/transfers to list all transfers
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
    // Get recent transfers
    const transfers = await this.request<GeminiTransfer[]>('/v1/transfers', {
      // Get last 50 transfers
      limitTransfers: 50,
    });

    // Filter to withdrawals only
    const withdrawals = transfers.filter((t) => t.type === 'Withdrawal');

    // Optionally filter by asset
    const filtered = asset
      ? withdrawals.filter((w) => normalizeGeminiAsset(w.currency) === asset)
      : withdrawals;

    return filtered.map((w) => ({
      refid: w.eid.toString(),
      method: w.method || `${w.currency} Network`,
      aclass: 'currency',
      asset: normalizeGeminiAsset(w.currency),
      amount: w.amount,
      fee: w.feeAmount || '0',
      time: Math.floor(w.timestampms / 1000),
      status: this.mapTransferStatus(w.status),
      txid: w.txHash,
      info: w.destination,
    }));
  }

  /**
   * Map Gemini transfer status to our status format
   */
  private mapTransferStatus(geminiStatus: string): string {
    switch (geminiStatus.toLowerCase()) {
      case 'complete':
        return 'Success';
      case 'pending':
        return 'Pending';
      case 'advanced':
        return 'Processing';
      default:
        return geminiStatus;
    }
  }

  /**
   * Get approved withdrawal addresses
   * Gemini requires addresses to be pre-approved via the website.
   * The API queries by network name, so we query all known networks.
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
    }>
  > {
    const addresses: Array<{
      address: string;
      asset: string;
      method: string;
      key: string;
    }> = [];

    // Gemini's API requires querying by network name
    // These are all the networks Gemini supports (from their API docs)
    const allNetworks = [
      'bitcoin',
      'ethereum',
      'bitcoincash',
      'litecoin',
      'zcash',
      'filecoin',
      'dogecoin',
      'tezos',
      'solana',
      'polkadot',
      'avalanche',
      'cosmos',
      'xrpl',
    ];

    logger.debug({ networks: allNetworks }, 'Querying all networks for approved addresses');

    // Query each network for approved addresses
    for (const network of allNetworks) {
      try {
        const response = await this.request<GeminiWithdrawAddressesResponse>(
          `/v1/approvedAddresses/account/${network}`
        );

        const approvedAddresses = response?.approvedAddresses || [];

        // Filter to only active addresses (not pending-time)
        const activeAddresses = approvedAddresses.filter((a) => a.status === 'active');

        if (activeAddresses.length > 0) {
          logger.debug({ network, total: approvedAddresses.length, active: activeAddresses.length }, 'Got approved addresses for network');

          // Deduplicate by address (same address can appear at account and group scope)
          const seen = new Set<string>();
          for (const addr of activeAddresses) {
            if (seen.has(addr.address)) continue;
            seen.add(addr.address);

            const assetName = this.networkToAsset(network);
            addresses.push({
              address: addr.address,
              asset: assetName,
              method: addr.network || network,
              key: addr.label || `${assetName}_${addr.address.slice(0, 8)}`,
            });
          }
        }
      } catch (error) {
        // Network may not have approved addresses - this is normal
        logger.debug({ network }, 'No approved addresses for network');
      }
    }

    // If specific asset requested, filter results
    if (asset) {
      const normalizedAsset = asset.toUpperCase();
      return addresses.filter((a) => a.asset === normalizedAsset);
    }

    return addresses;
  }

  /**
   * Convert network name to asset symbol
   */
  private networkToAsset(network: string): string {
    const networkToAssetMap: Record<string, string> = {
      bitcoin: 'BTC',
      ethereum: 'ETH',
      bitcoincash: 'BCH',
      litecoin: 'LTC',
      zcash: 'ZEC',
      filecoin: 'FIL',
      dogecoin: 'DOGE',
      tezos: 'XTZ',
      solana: 'SOL',
      polkadot: 'DOT',
      avalanche: 'AVAX',
      cosmos: 'ATOM',
      xrpl: 'XRP',
    };
    return networkToAssetMap[network] || network.toUpperCase();
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
    interface GeminiOrder {
      order_id: string;
      symbol: string;
      side: string;
      type: string;
      timestamp: string;
      timestampms: number;
      is_live: boolean;
      is_cancelled: boolean;
      is_hidden: boolean;
      avg_execution_price: string;
      executed_amount: string;
      remaining_amount: string;
      original_amount: string;
      price: string;
    }

    const orders = await this.request<GeminiOrder[]>('/v1/orders');

    const open: Record<string, any> = {};
    for (const order of orders) {
      if (order.is_live && !order.is_cancelled) {
        open[order.order_id] = {
          descr: {
            pair: order.symbol,
            type: order.side,
            ordertype: order.type,
            price: order.price,
            order: `${order.side} ${order.original_amount} ${order.symbol} @ ${order.price}`,
          },
          vol: order.original_amount,
          vol_exec: order.executed_amount,
          cost: (parseFloat(order.executed_amount) * parseFloat(order.avg_execution_price || '0')).toString(),
          fee: '0', // Gemini doesn't include fee in order response
          status: 'open',
          opentm: order.timestampms / 1000,
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
        // Gemini ticker is a public endpoint
        const response = await fetch(
          `${GEMINI_API_BASE}/v1/pubticker/${pair.toLowerCase()}`
        );

        if (response.ok) {
          const data = (await response.json()) as { last: string; volume: { [key: string]: string } };
          result[pair] = { c: [data.last, '0'] };
        }
      } catch (error) {
        logger.debug({ pair, error }, 'Failed to get ticker');
      }
    }

    return result;
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

      // Test if we can access the approved addresses (indicates fund manager role)
      let hasWithdraw = false;
      try {
        await this.getWithdrawAddresses('btc');
        hasWithdraw = true;
      } catch {
        // May not have fund manager role
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

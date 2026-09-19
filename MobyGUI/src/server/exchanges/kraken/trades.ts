import { parsePair, type FillEvent } from '../../domain/types.js';

export function parseTrade(tradeId: string, value: unknown): FillEvent | null {
  if (!value || typeof value !== 'object') return null;
  const trade = value as Record<string, unknown>;
  if (typeof trade.pair !== 'string' || typeof trade.ordertxid !== 'string' ||
      typeof trade.ordertype !== 'string' || !['buy', 'sell'].includes(String(trade.type))) return null;
  const price = Number(trade.price), volume = Number(trade.vol), cost = Number(trade.cost);
  const fee = Number(trade.fee), timestamp = Number(trade.time) * 1000;
  if (![price, volume, cost, fee, timestamp].every(n => Number.isFinite(n) && n >= 0) || volume <= 0) return null;
  return {
    tradeId, orderId: trade.ordertxid, pair: trade.pair, side: trade.type as 'buy' | 'sell',
    orderType: trade.ordertype, price, volume, cost, fee, timestamp,
    feeCurrency: parsePair(trade.pair).quote,
  };
}

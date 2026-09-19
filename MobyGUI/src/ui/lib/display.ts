export function formatAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value !== 0 && Math.abs(value) < 1e-8) return '<0.00000001';
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
export const exchangeName = (id: string) => ({ kraken: 'Kraken', gemini: 'Gemini', kucoin: 'KuCoin', gateio: 'Gate.io' }[id] || id);
export function elapsed(since: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

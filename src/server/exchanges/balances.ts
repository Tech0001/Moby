export function balanceNumber(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error('Exchange returned an invalid balance response; withdrawals remain blocked');
  }
  return Number(value);
}
export function validateBalances(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account balance response');
  for (const [asset, amount] of Object.entries(value)) {
    if (!asset) throw new Error('Invalid balance asset');
    balanceNumber(amount);
  }
}

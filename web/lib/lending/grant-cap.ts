const UINT256_MAX = (1n << 256n) - 1n;

/** Operator-approved quote headroom for a NEW owner-signed USDT grant only. */
export function lendingUsdtGrantCap(floorWei: string): bigint | null {
  if (!/^\d{1,78}$/u.test(floorWei)) return null;
  const floor = BigInt(floorWei);
  const cap = (floor * 110n + 99n) / 100n;
  return floor > 0n && cap <= UINT256_MAX ? cap : null;
}

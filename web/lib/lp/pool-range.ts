import { poolAddressFor, REVIEWED_MAJORS_56, WBNB_56 } from "@/lib/exec/pairs";

const tiers = [[100, 1], [500, 10], [2500, 50], [10000, 200]] as const;
export function reviewedRangePool(address: string) {
  for (const token of Object.keys(REVIEWED_MAJORS_56)) {
    if (token === WBNB_56) continue;
    const [token0, token1] = [token, WBNB_56].sort();
    for (const [fee, spacing] of tiers) {
      if (poolAddressFor(token0, token1, fee) === address.toLowerCase()) return {
        address: address.toLowerCase(), token0, token1, fee, spacing,
        meta0: REVIEWED_MAJORS_56[token0], meta1: REVIEWED_MAJORS_56[token1],
      };
    }
  }
  return null;
}
export type RangeApr = {
  estimatedAprPct: number | null;
  estimatedApr7dPct: number | null;
  concentrationMultiplier: number | null;
  basis: { lpFeeApr24h: number | null; lpFeeApr7d?: number | null; tvlUsd?: number | null };
  inRange: boolean | null;
  unavailable: string[];
  assumptions: string[];
  rounded: boolean;
  meta: { asOf: number | null; staleness: string; source: string | null };
};
export const unavailableApr = (reason: string): RangeApr => ({ estimatedAprPct: null, estimatedApr7dPct: null, concentrationMultiplier: null,
  basis: { lpFeeApr24h: null }, inRange: null, unavailable: [reason], assumptions: [], rounded: false,
  meta: { asOf: null, staleness: "unavailable", source: null } });
/**
 * PancakeSwap prices a POSITION's farm APR, not the pool's. MasterChefV3 pays
 * CAKE pro rata to active liquidity, so a narrow range earns the same share of
 * emissions that it earns of fees — the pool figure therefore scales by the
 * very multiplier the fee estimate already uses, and the two columns finally
 * describe the same thing.
 *
 * Two things it never hides: an unscaled figure says it is the pool's, and no
 * figure is "earned" while LP v1 leaves the NFT unstaked.
 */
export function farmAprMetric(input: {
  readonly cakeFarmApr: number | null;
  readonly concentrationMultiplier: number | null;
  readonly staleness: string;
  readonly reason: string | null;
}): { value: string | null; reason: string | null; note?: string } {
  if (input.cakeFarmApr === null) return { value: null, reason: input.reason ?? "farm APR unavailable" };
  if (input.concentrationMultiplier === null) {
    return { value: `${input.cakeFarmApr.toFixed(1)}%`, reason: null, note: `pool · full range · not staked, so not earned · ${input.staleness}` };
  }
  return {
    value: `${(input.cakeFarmApr * input.concentrationMultiplier).toFixed(1)}%`,
    reason: null,
    note: `est. for this range · pool ${input.cakeFarmApr.toFixed(2)}% × ${input.concentrationMultiplier.toFixed(1)}x · not staked, so not earned`,
  };
}

const record = (v: unknown): Record<string, unknown> | null => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const nullableNumber = (v: unknown): v is number | null => v === null || nonnegative(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");

export function validateRangeApr(payload: unknown, request: { address: string; lower: number; upper: number; capital: number; fee: number; spacing: number }, now: number): RangeApr {
  const body = record(payload), data = record(body?.data), meta = record(body?.meta);
  const ticks = record(data?.ticks), echo = record(data?.requested), basis = record(data?.basis);
  if (!data || !meta || !ticks || !echo || !basis || typeof data.pool !== "string" || data.pool.toLowerCase() !== request.address.toLowerCase()
    || data.fee !== request.fee || ticks.spacing !== request.spacing || echo.capitalUsd !== request.capital
    || !Number.isSafeInteger(ticks.lower) || !Number.isSafeInteger(ticks.upper)
    || !nullableNumber(data.estimatedAprPct) || !nullableNumber(data.estimatedApr7dPct) || !nullableNumber(basis.lpFeeApr24h)
    || typeof data.inRange !== "boolean" || !strings(data.unavailable) || !strings(data.assumptions)
    || !nonnegative(meta.asOf) || !Number.isSafeInteger(meta.asOf) || typeof meta.staleness !== "string") return unavailableApr("invalid response");
  const lower = ticks.lower as number, upper = ticks.upper as number;
  if (lower < request.lower - request.spacing || lower > request.lower || upper < request.upper || upper > request.upper + request.spacing
    || lower % request.spacing !== 0 || upper % request.spacing !== 0 || lower < -887272 || upper > 887272) return unavailableApr("range snapped beyond tolerance");
  const unavailable = [...data.unavailable];
  const fresh = meta.staleness === "fresh" && now - meta.asOf >= 0 && now - meta.asOf <= 60_000;
  if (!fresh) unavailable.unshift("stale evidence");
  if (data.estimatedAprPct === null && unavailable.length === 0) unavailable.push("estimate unavailable");
  return {
    estimatedAprPct: data.estimatedAprPct, estimatedApr7dPct: data.estimatedApr7dPct,
    // Zero would scale a farm APR to zero, so it is treated as no multiplier.
    concentrationMultiplier: typeof data.concentrationMultiplier === "number" && data.concentrationMultiplier > 0 ? data.concentrationMultiplier : null,
    basis: { lpFeeApr24h: basis.lpFeeApr24h, ...(nullableNumber(basis.lpFeeApr7d) ? { lpFeeApr7d:basis.lpFeeApr7d } : {}), ...(nullableNumber(basis.tvlUsd) ? { tvlUsd:basis.tvlUsd } : {}) }, inRange: data.inRange, unavailable, assumptions: [...data.assumptions],
    rounded: lower !== request.lower || upper !== request.upper,
    meta: { asOf: meta.asOf, staleness: fresh ? "fresh" : "stale", source: typeof meta.source === "string" ? meta.source : null } };
}

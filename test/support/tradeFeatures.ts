import type { Address } from "viem";
import type { FeatureInterval } from "../../src/trade/features.js";
const addr = (n: number) => `0x${n.toString(16).padStart(40,"0")}` as Address;
export function featureFixture(interval: FeatureInterval, token = addr(2), at = 1_800_000_090_000, pool: Address = addr(1)) {
  const step = interval === "15m" ? 900_000 : 3_600_000;
  const close = Math.floor((at - 15_000)/step)*step;
  const metric = (value: number, unit: string, requiredBars: number) => ({value,unit,requiredBars,usableBars:requiredBars,available:true,reason:null});
  return {version:"pool-features-v2",staleness:"fresh",snapshotId:"a".repeat(64),seriesId:"b".repeat(64),
    identity:{chainId:56,poolAddress:pool,baseAddress:token,quoteAddress:addr(3),interval,priceCurrency:"usd",observedAt:at},
    calculatedAt:at,evaluationClose:close,expiresAt:close+step+90_000,coverage:{latestClose:close,contiguousBars:52},
    metrics:{ema12:metric(2,"usd_per_base_token",24),ema26:metric(1,"usd_per_base_token",52),emaSpreadPct:metric(1,"percent",52),
      roc10Pct:metric(1,"percent",11),atr14:metric(1,"usd_per_base_token",29),atrPct:metric(1,"percent",29),rvol20:metric(1,"ratio",21)}};
}

/**
 * A rev-1 payload whose components score comfortably above the "strong" threshold
 * in every session (rth/close/overnight), so tests that just need the tradfi v2
 * score gate to pass (not to exercise score.ts itself) can stay session-agnostic.
 * TRADFI-AI-TRADE-V3 §2.
 */
export function strongFeatureFixture(interval: FeatureInterval, token: Address, pool: Address, at = 1_800_000_090_000) {
  const base = featureFixture(interval, token, at, pool);
  const metric = (value: number, unit: string, requiredBars: number) => ({ value, unit, requiredBars, usableBars: requiredBars, available: true, reason: null });
  const metrics: Record<string, unknown> = { ...base.metrics,
    emaSpreadPct: metric(3, "percent", 52),
    rvol20: metric(2, "ratio", 21),
    ...(interval === "1h" ? { roc10Pct: metric(8, "percent", 11) } : {}),
    rsi14: metric(25, "index", 29),
    macd: metric(0.01, "usd_per_base_token", 52),
    signal9: metric(0.001, "usd_per_base_token", 69),
    histogram: metric(0.01, "usd_per_base_token", 69),
    momentum10: metric(0.05, "usd_per_base_token", 11),
  };
  return { ...base, metrics, parameters: { indicatorRevision: 1 } };
}

/** Wires featurePools/featuresBatch on a TradeDataPlaneReads-shaped object with a single strong pool for `token`. */
export function strongFeatureDataPlane(token: Address, pool: Address, at = 1_800_000_090_000) {
  return {
    async featurePools() { return { pools: [{ pool, tokenAddress: token, currency: "usd" }] }; },
    async featuresBatch(pools: readonly Address[], interval: FeatureInterval) {
      const result: Record<string, unknown> = {};
      for (const p of pools) if (p.toLowerCase() === pool.toLowerCase()) result[p] = { data: strongFeatureFixture(interval, token, pool, at) };
      return result;
    },
  };
}

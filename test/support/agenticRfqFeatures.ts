/** AGENTIC-RFQ-STOCKS: recorded-underlying feature records in the shape the data plane publishes (underlying-features-v1), and a fake data plane that serves them. */
import type { Address } from "viem";
import type { TradeDataPlaneReads } from "../../src/trade/dataPlaneReads.js";
import type { FeatureInterval } from "../../src/trade/features.js";

export const STEP = { "15m": 900_000, "1h": 3_600_000 } as const;
const CORE: Readonly<Record<string, [number, string]>> = { ema12: [24, "usd_per_base_token"], ema26: [52, "usd_per_base_token"], emaSpreadPct: [52, "percent"],
  roc10Pct: [11, "percent"], atr14: [29, "usd_per_base_token"], atrPct: [29, "percent"], rvol20: [21, "ratio"] };
const ADDITIVE: Readonly<Record<string, [number, string]>> = { rsi14: [29, "index"], macd: [52, "usd_per_base_token"], signal9: [69, "usd_per_base_token"], histogram: [69, "usd_per_base_token"],
  momentum10: [11, "usd_per_base_token"], bbPosition20: [20, "ratio"], bbWidthPct20: [20, "percent"], stochRsi14: [42, "ratio"], gapPct: [1, "percent"], vwapDistancePct: [1, "percent"], orbBreakPct: [2, "percent"] };
/** The required-bar count of every metric, as the decoder checks it (orbBreakPct is 2 on the 15m interval and 0 on the hourly one). */
export const REQUIRED_BARS: Readonly<Record<string, number>> = Object.fromEntries([...Object.entries(CORE), ...Object.entries(ADDITIVE)].map(([name, [bars]]) => [name, bars]));

export type UnderlyingRecordOptions = {
  readonly token: Address; readonly interval: FeatureInterval; readonly at: number;
  /** metric name -> value for the metrics the record publishes as available */
  readonly available?: Readonly<Record<string, number>>;
  /** bucket opens that changed; default every one of the 120 buckets before the close */
  readonly changed?: readonly number[];
  readonly realBars?: number;
  readonly sessionStart?: number | null;
  readonly patch?: Readonly<Record<string, unknown>>;
};

export function evaluationClose(interval: FeatureInterval, at: number): number {
  return Math.floor((at - 15_000) / STEP[interval]) * STEP[interval];
}
export function allBuckets(interval: FeatureInterval, at: number): number[] {
  const close = evaluationClose(interval, at);
  return Array.from({ length: 120 }, (_, index) => close - (120 - index) * STEP[interval]);
}

/** A strong, full set of metrics (volume excluded: the series has none). */
export const FULL_METRICS: Readonly<Record<string, number>> = { ema12: 2, ema26: 1, emaSpreadPct: 1, roc10Pct: 1, atr14: 1, atrPct: 1.5, rsi14: 25, macd: 0.01, signal9: 0.001, histogram: 0.01,
  momentum10: 0.05, bbPosition20: 0.1, bbWidthPct20: 1, stochRsi14: 0.1, gapPct: 0.5, orbBreakPct: 0.3 };

export function underlyingRecord(options: UnderlyingRecordOptions): Record<string, unknown> {
  const { token, interval, at } = options;
  const step = STEP[interval], close = evaluationClose(interval, at);
  const available = options.available ?? FULL_METRICS;
  const metrics: Record<string, unknown> = {};
  for (const [name, [bars, unit]] of [...Object.entries(CORE), ...Object.entries(ADDITIVE)]) {
    const required = name === "orbBreakPct" && interval === "1h" ? 0 : bars;
    const value = available[name];
    metrics[name] = value === undefined ? { value: null, unit, requiredBars: required, usableBars: 0, available: false, reason: "too_few_real_bars" }
      : { value, unit, requiredBars: required, usableBars: required, available: true, reason: null };
  }
  const changed = options.changed ?? allBuckets(interval, at);
  return { version: "underlying-features-v1", staleness: "fresh", snapshotId: "a".repeat(64), seriesId: "b".repeat(64),
    identity: { chainId: 56, tokenAddress: token.toLowerCase(), underlyingTicker: "AMD", endpoint: "tokens", interval, priceCurrency: "usd", priceBasis: "usd_per_share", source: "binance-rwa", observedAt: at,
      referenceSession: null },
    calculatedAt: at, evaluationClose: close, refreshAfter: close + step + 15_000, expiresAt: close + step + 90_000,
    coverage: { availableBars: 120, contiguousBars: 120, requiredHistory: 120, firstOpen: close - 120 * step, latestClose: close, missingBuckets: 0, invalidBars: 0, excludedUnclosedBars: 0,
      identicalDuplicates: 0, conflictingDuplicates: 0, realBars: options.realBars ?? changed.length, filledBars: 0, changedBuckets: [...changed] },
    parameters: { historyBars: 120, indicatorRevision: 2 },
    metrics, session: { state: "rth", sessionStart: options.sessionStart === undefined ? null : options.sessionStart },
    volume: { baseline: null, latest: null, usableBaselineBars: 0 },
    lineage: { scope: "underlying", series: "binance-rwa-reference-usd", source: "binance-rwa", transformation: "sampled_60s",
      label: "underlying reference price, sampled every 60 s, no volume", correctionPolicy: "missing buckets stay missing; never filled; never spliced" },
    ...options.patch };
}

/** A fake underlying-features data plane: the index lists `tokens`; a batch answers each token's record builder (or an error row). */
export function underlyingDataPlane(input: { tokens: readonly Address[]; at: () => number;
  record?: (token: Address, interval: FeatureInterval) => Record<string, unknown> | null; log?: { index: number; batches: Address[][] } }): Pick<TradeDataPlaneReads, "underlyingFeatureIndex" | "underlyingFeaturesBatch"> {
  return {
    async underlyingFeatureIndex() {
      if (input.log !== undefined) input.log.index += 1;
      return { tokens: input.tokens.map((token) => ({ tokenAddress: token.toLowerCase(), usEquity: true })), intervals: ["15m", "1h"], maxTokens: 64 };
    },
    async underlyingFeaturesBatch(tokens, interval) {
      if (input.log !== undefined) input.log.batches.push([...tokens]);
      const rows: Record<string, unknown> = {};
      for (const token of tokens) {
        const record = (input.record ?? ((t, i) => underlyingRecord({ token: t, interval: i, at: input.at() })))(token, interval);
        rows[token.toLowerCase()] = record === null ? { data: null, error: { code: "features_pending" } } : { data: record, meta: { version: "underlying-features-v1", producer: "ready" } };
      }
      return rows;
    },
  };
}

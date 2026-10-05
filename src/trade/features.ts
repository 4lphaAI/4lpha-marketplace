import type { Address } from "viem";
import type { TradeDataPlaneReads } from "./dataPlaneReads.js";
import type { TradeExecutionModel } from "./settings.js";
import { USDT_56 } from "./settlement.js";

export type FeatureInterval = "15m" | "1h";
export type FeaturePool = { readonly pool: Address; readonly tokenAddress: Address; readonly currency: "usd" | "token" };
const STEPS = { "15m": 900_000, "1h": 3_600_000 };
const REQUIRED = { ema12: 24, ema26: 52, emaSpreadPct: 52, roc10Pct: 11, atr14: 29, atrPct: 29, rvol20: 21 };
export type FeatureMetricName = keyof typeof REQUIRED;
const ADDITIVE_REQUIRED = { rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 } as const;
export type AdditiveFeatureMetricNameV1 = keyof typeof ADDITIVE_REQUIRED;
/** Rev 2 additive metrics (TRADING-FEATURES-HANDOFF-2026-09-21 §"Implemented"); orb warm-up is per interval. */
const REV2_ADDITIVE_REQUIRED = { bbPosition20: 20, bbWidthPct20: 20, stochRsi14: 42, gapPct: 1, vwapDistancePct: 1, orbBreakPct: 0 } as const;
export type AdditiveFeatureMetricNameV2 = keyof typeof REV2_ADDITIVE_REQUIRED;
export type AdditiveFeatureMetricName = AdditiveFeatureMetricNameV1 | AdditiveFeatureMetricNameV2;
/** Live data plane, verified 2026-09-21 16:06Z against /trading/features/v2: 15m=2, 1h=0 (5m=6, unused here). */
function orbRequiredBars(interval: FeatureInterval): number {
  return interval === "15m" ? 2 : interval === "1h" ? 0 : 0;
}
export type FeatureMetric = { readonly value: number | null; readonly unit: string; readonly available: boolean };
export type SessionState = "rth" | "close" | "overnight";
export type FeatureEvidence = {
  readonly pool: FeaturePool; readonly interval: FeatureInterval; readonly quoteAddress: Address;
  /** AGENTIC-RFQ-STOCKS R2.4: set only on evidence decoded from the recorded underlying reference series (then `pool` is the series identity: the token itself, never a pool to route or quote from). Absent on every pool record. */
  readonly scope?: "underlying";
  readonly snapshotId: string; readonly seriesId: string; readonly observedAt: number;
  readonly calculatedAt: number; readonly evaluationClose: number; readonly expiresAt: number;
  readonly metrics: Readonly<Record<FeatureMetricName, FeatureMetric>>;
  readonly additiveMetrics?: Readonly<Record<AdditiveFeatureMetricNameV1, FeatureMetric>> & Partial<Readonly<Record<AdditiveFeatureMetricNameV2, FeatureMetric>>>;
  /** Rev 3 (2026-09-22) = the rev 2 metrics computed over forward-filled bars (Sintral first); same shape. */
  readonly indicatorRevision?: 1 | 2 | 3;
  readonly sessionState?: SessionState | null;
};
export type TokenFeatures = Partial<Record<FeatureInterval, FeatureEvidence>>;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function address(value: unknown): value is Address { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value); }
export function featureModel(model: TradeExecutionModel): boolean {
  return model === "tradfi" || model === "blue-chip" || model === "sigma";
}

/** The pin ceiling; the data plane's index grew past its old 10-pool bound on 2026-09-22 (36 pools / maxPools 40). */
export const MAX_FEATURE_POOLS = 69;
/** The data plane's per-request batch bound (unchanged). */
export const FEATURE_BATCH_SIZE = 10;

/** Index identities only; no response URL or display text is ever followed. */
export function selectFeaturePools(raw: unknown, tokens: readonly Address[]): readonly FeaturePool[] {
  if (!record(raw) || !Array.isArray(raw.pools) || raw.pools.length > MAX_FEATURE_POOLS) return [];
  const wanted = new Set(tokens.slice(0, 69).map(t => t.toLowerCase()));
  const rows: FeaturePool[] = [];
  for (const row of raw.pools) {
    if (!record(row) || !address(row.pool) || !address(row.tokenAddress)
      || (row.currency !== "usd" && row.currency !== "token") || !wanted.has(row.tokenAddress.toLowerCase())) continue;
    rows.push({ pool: row.pool.toLowerCase() as Address, tokenAddress: row.tokenAddress.toLowerCase() as Address, currency: row.currency });
  }
  rows.sort((a,b) => a.tokenAddress.localeCompare(b.tokenAddress) || a.pool.localeCompare(b.pool) || a.currency.localeCompare(b.currency));
  const seen = new Set<string>();
  return rows.filter(row => { if (seen.has(row.tokenAddress) || seen.has(row.pool)) return false; seen.add(row.tokenAddress); seen.add(row.pool); return true; }).slice(0, MAX_FEATURE_POOLS);
}

export function freshFeature(value: FeatureEvidence, now: number): boolean {
  const step = STEPS[value.interval];
  return timestamp(now) && value.observedAt <= value.calculatedAt && value.calculatedAt <= now
    && value.evaluationClose <= value.observedAt && value.evaluationClose <= value.calculatedAt
    && value.evaluationClose % step === 0 && now < value.expiresAt
    && now < value.evaluationClose + step + 90_000;
}

/** Unknown or malformed metrics stay missing independently of usable price metrics. */
export function decodeFeature(raw: unknown, pool: FeaturePool, interval: FeatureInterval, now: number): FeatureEvidence | null {
  if (!record(raw) || raw.version !== "pool-features-v2" || raw.staleness !== "fresh"
    || !record(raw.identity) || !record(raw.metrics) || !record(raw.coverage)) return null;
  const id = raw.identity;
  if (id.chainId !== 56 || !address(id.poolAddress) || id.poolAddress.toLowerCase() !== pool.pool
    || !address(id.baseAddress) || id.baseAddress.toLowerCase() !== pool.tokenAddress
    || !address(id.quoteAddress) || id.quoteAddress.toLowerCase() === pool.tokenAddress
    || id.interval !== interval || id.priceCurrency !== pool.currency
    || !timestamp(id.observedAt) || !timestamp(raw.calculatedAt) || !timestamp(raw.evaluationClose)
    || !timestamp(raw.expiresAt) || !hash(raw.snapshotId) || !hash(raw.seriesId)
    || raw.coverage.latestClose !== raw.evaluationClose
    || typeof raw.coverage.contiguousBars !== "number" || !Number.isInteger(raw.coverage.contiguousBars)
    || raw.coverage.contiguousBars < 0 || raw.coverage.contiguousBars > 120) return null;
  const priceUnit = pool.currency === "usd" ? "usd_per_base_token" : "quote_token_per_base_token";
  const metrics = {} as Record<FeatureMetricName, FeatureMetric>;
  for (const name of Object.keys(REQUIRED) as FeatureMetricName[]) {
    const unit = name === "rvol20" ? "ratio" : name === "ema12" || name === "ema26" || name === "atr14" ? priceUnit : "percent";
    const item = raw.metrics[name];
    const valid = record(item) && item.available === true && item.reason === null && item.unit === unit
      && typeof item.value === "number" && Number.isFinite(item.value)
      && item.requiredBars === REQUIRED[name] && typeof item.usableBars === "number"
      && Number.isInteger(item.usableBars) && item.usableBars >= REQUIRED[name] && item.usableBars <= 120
      && raw.coverage.contiguousBars >= REQUIRED[name]
      && (!(name === "atr14" || name === "atrPct" || name === "rvol20") || item.value >= 0)
      && (!(name === "ema12" || name === "ema26") || item.value > 0);
    metrics[name] = { value: valid ? item.value as number : null, unit, available: valid };
  }
  const parameters = record(raw.parameters) ? raw.parameters : null;
  const revision = parameters?.indicatorRevision === 3 ? 3 : parameters?.indicatorRevision === 2 ? 2 : parameters?.indicatorRevision === 1 ? 1 : null;
  const additiveMetrics = {} as Record<AdditiveFeatureMetricName, FeatureMetric>;
  if (revision !== null) {
    for (const name of Object.keys(ADDITIVE_REQUIRED) as AdditiveFeatureMetricNameV1[]) {
      const item = raw.metrics[name];
      const unit = name === "rsi14" ? "index" : priceUnit;
      const valid = record(item) && item.available === true && item.reason === null && item.unit === unit
        && typeof item.value === "number" && Number.isFinite(item.value)
        && item.requiredBars === ADDITIVE_REQUIRED[name] && typeof item.usableBars === "number"
        && Number.isInteger(item.usableBars) && item.usableBars >= ADDITIVE_REQUIRED[name] && item.usableBars <= 120
        && raw.coverage.contiguousBars >= ADDITIVE_REQUIRED[name]
        && (name !== "rsi14" || (item.value >= 0 && item.value <= 100));
      additiveMetrics[name] = { value: valid ? item.value as number : null, unit, available: valid };
    }
  }
  if (revision === 2 || revision === 3) {
    for (const name of Object.keys(REV2_ADDITIVE_REQUIRED) as AdditiveFeatureMetricNameV2[]) {
      const required = name === "orbBreakPct" ? orbRequiredBars(interval) : REV2_ADDITIVE_REQUIRED[name];
      const item = raw.metrics[name];
      const unit = name === "bbPosition20" || name === "stochRsi14" ? "ratio" : "percent";
      const valid = required > 0 && record(item) && item.available === true && item.reason === null && item.unit === unit
        && typeof item.value === "number" && Number.isFinite(item.value)
        && item.requiredBars === required && typeof item.usableBars === "number"
        && Number.isInteger(item.usableBars) && item.usableBars >= required && item.usableBars <= 120
        && raw.coverage.contiguousBars >= required;
      additiveMetrics[name] = { value: valid ? item.value as number : null, unit, available: valid };
    }
  }
  const sessionRecord = record(raw.session) ? raw.session : null;
  const sessionStateRaw = sessionRecord?.state;
  const sessionState: SessionState | null = sessionStateRaw === "rth" || sessionStateRaw === "close" || sessionStateRaw === "overnight" ? sessionStateRaw : null;
  const result: FeatureEvidence = { pool, interval, quoteAddress: id.quoteAddress.toLowerCase() as Address,
    observedAt: id.observedAt, calculatedAt: raw.calculatedAt, evaluationClose: raw.evaluationClose,
    expiresAt: raw.expiresAt, snapshotId: raw.snapshotId, seriesId: raw.seriesId, metrics,
    ...(revision !== null ? { indicatorRevision: revision, additiveMetrics } : {}),
    ...(revision === 2 || revision === 3 ? { sessionState } : {}) };
  return freshFeature(result, now) ? result : null;
}

export type MomentumAssessment = { readonly status: "pass" | "fail" | "unavailable"; readonly reasons: readonly string[] };
export function assessMomentum(features: TokenFeatures, now: number): MomentumAssessment {
  const fast = features["15m"], slow = features["1h"];
  const required = ["emaSpreadPct", "roc10Pct", "atrPct", "rvol20"] as const;
  if (!fast || !slow || !freshFeature(fast, now) || !freshFeature(slow, now)
    || fast.pool.pool !== slow.pool.pool || fast.pool.tokenAddress !== slow.pool.tokenAddress
    || fast.quoteAddress !== slow.quoteAddress || fast.pool.currency !== slow.pool.currency
    || required.some(name => !fast.metrics[name].available || !slow.metrics[name].available)) return { status: "unavailable", reasons: ["incomplete-fresh-evidence"] };
  const reasons: string[] = [];
  for (const row of [fast,slow]) {
    if (row.metrics.emaSpreadPct.value! <= 0) reasons.push(`${row.interval}:ema-spread-not-positive`);
    if (row.metrics.roc10Pct.value! <= 0) reasons.push(`${row.interval}:roc-not-positive`);
  }
  if (fast.metrics.rvol20.value! < 1) reasons.push("15m:rvol-below-1");
  if (slow.metrics.rvol20.value! < 0.5) reasons.push("1h:rvol-below-0.5");
  if (fast.metrics.roc10Pct.value! / 3 > fast.metrics.atrPct.value!) reasons.push("15m:extended-over-3atr");
  return { status: reasons.length ? "fail" : "pass", reasons };
}

/** One aggregate deadline covers index and both GET batches. Outages only remove evidence. */
export async function enrichFeatures(dataPlane: TradeDataPlaneReads, model: TradeExecutionModel, tokens: readonly Address[], now: number, signal?: AbortSignal): Promise<ReadonlyMap<string, TokenFeatures>> {
  const result = new Map<string, TokenFeatures>();
  if (!featureModel(model) || !dataPlane.featurePools || !dataPlane.featuresBatch || tokens.length === 0) return result;
  // 5 s covered one index read + two 10-pool batches; a 28-token pin is three
  // batches per interval, read in parallel, so the aggregate deadline scales.
  const deadline = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    deadline.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("feature-read-aborted"));
      deadline.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(operation).then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort)).catch(() => undefined);
    });
  };
  try {
    const pools = selectFeaturePools(await bounded(() => dataPlane.featurePools!(deadline)), tokens);
    signal?.throwIfAborted();
    if (!pools.length) return result;
    const chunks: FeaturePool[][] = [];
    for (let index = 0; index < pools.length; index += FEATURE_BATCH_SIZE) chunks.push(pools.slice(index, index + FEATURE_BATCH_SIZE));
    await Promise.all((["15m", "1h"] as const).flatMap(interval => chunks.map(async chunk => {
      try {
        const batch = await bounded(() => dataPlane.featuresBatch!(chunk.map(p => p.pool), interval, deadline));
        if (!record(batch) || Object.keys(batch).length > FEATURE_BATCH_SIZE) return;
        for (const pool of chunk) {
          const row = batch[pool.pool];
          const evidence = decodeFeature(record(row) ? row.data : null, pool, interval, now);
          if (evidence) result.set(pool.tokenAddress, { ...result.get(pool.tokenAddress), [interval]: evidence });
        }
      } catch { /* A missing batch does not discard the others. */ }
    })));
  } catch { /* Existing snapshot prompt remains available. */ }
  if (signal?.aborted) signal.throwIfAborted();
  return result;
}

export function featurePrompt(features: TokenFeatures | undefined, now: number, options: { readonly v2?: boolean } = {}): string {
  if (!features) return "";
  const rows = Object.values(features).filter(row => freshFeature(row, now));
  if (!rows.length) return "";
  // R2.4: recorded-underlying evidence says what it is (the US stock's reference price, no volume) and carries no pool and no quote address.
  if (rows.every(row => row.scope === "underlying")) return JSON.stringify({ scope: "underlying", series: UNDERLYING_SERIES, note: UNDERLYING_NOTE,
    intervals: rows.map(row => ({ interval: row.interval, base: row.pool.tokenAddress, currency: row.pool.currency, observedAt: row.observedAt, evaluationClose: row.evaluationClose,
      snapshotId: row.snapshotId, metrics: row.metrics,
      ...(options.v2 === true && row.indicatorRevision !== undefined ? { indicatorRevision: row.indicatorRevision, additiveMetrics: row.additiveMetrics } : {}) })) });
  return JSON.stringify({ scope: "exact_pool", executionQuote: false, quantitativeAdvisory: assessMomentum(features, now),
    intervals: rows.map(row => ({ interval: row.interval, pool: row.pool.pool, base: row.pool.tokenAddress,
      quote: row.quoteAddress, currency: row.pool.currency, observedAt: row.observedAt, evaluationClose: row.evaluationClose,
      snapshotId: row.snapshotId, metrics: row.metrics,
      ...(options.v2 === true && row.indicatorRevision !== undefined ? { indicatorRevision: row.indicatorRevision, additiveMetrics: row.additiveMetrics } : {}) })) });
}

/** §3.3: a ≤200-char worded summary of the freshest 1h (then 15m) evidence, for the tradfi exit prompt. Never JSON. */
/* ------------------------------------------------------------------------------------------------------------------------------------------------ */
/* AGENTIC-RFQ-STOCKS R2.4 / R3.3 / R5.1: features of a bStock with no pool, read from the underlying reference price the data plane records itself.          */
/* One scope per token per cycle (never spliced); below 30 changed buckets every metric is unavailable; no volume, ever.                                 */
/* ------------------------------------------------------------------------------------------------------------------------------------------------ */

export const UNDERLYING_FEATURE_VERSION = "underlying-features-v1";
export const MAX_UNDERLYING_FEATURES = 64;
export const UNDERLYING_FEATURE_MIN_REAL_BARS = 30;
export const UNDERLYING_SERIES = "underlying-reference-usd";
export const UNDERLYING_NOTE = "underlying reference price, sampled every 60 s, no volume; the underlying US stock, not the bStock's own trades";

/** Index identities only. An index longer than the 64-token ceiling answers nothing (fail closed). */
export function selectUnderlyingTokens(raw: unknown, tokens: readonly Address[]): readonly Address[] {
  if (!record(raw) || !Array.isArray(raw.tokens) || raw.tokens.length > MAX_UNDERLYING_FEATURES) return [];
  const wanted = new Set(tokens.slice(0, MAX_UNDERLYING_FEATURES).map(token => token.toLowerCase()));
  const found = new Set<string>();
  for (const row of raw.tokens) if (record(row) && address(row.tokenAddress) && wanted.has(row.tokenAddress.toLowerCase())) found.add(row.tokenAddress.toLowerCase());
  return [...found].sort() as Address[];
}

/**
 * The decoder of one recorded-underlying record. Everything decodeFeature checks, with the underlying identity in place of a pool's, plus:
 * `coverage.realBars` an integer of at least 30 (a second, local enforcement of the data plane's floor), the per-metric changed-bucket counts of R3.3 recomputed here from
 * `coverage.changedBuckets` whatever the record claims, and `rvol20` and the VWAP distance forced unavailable (the series has no volume).
 */
export function decodeUnderlyingFeature(raw: unknown, token: Address, interval: FeatureInterval, now: number): FeatureEvidence | null {
  if (!record(raw) || raw.version !== UNDERLYING_FEATURE_VERSION || raw.staleness !== "fresh"
    || !record(raw.identity) || !record(raw.metrics) || !record(raw.coverage) || !record(raw.lineage)) return null;
  const id = raw.identity, coverage = raw.coverage;
  if (id.chainId !== 56 || !address(id.tokenAddress) || id.tokenAddress.toLowerCase() !== token.toLowerCase()
    || id.interval !== interval || id.priceCurrency !== "usd" || id.priceBasis !== "usd_per_share" || id.source !== "binance-rwa"
    || raw.lineage.scope !== "underlying"
    || !timestamp(id.observedAt) || !timestamp(raw.calculatedAt) || !timestamp(raw.evaluationClose)
    || !timestamp(raw.expiresAt) || !hash(raw.snapshotId) || !hash(raw.seriesId)
    || coverage.latestClose !== raw.evaluationClose
    || typeof coverage.contiguousBars !== "number" || !Number.isInteger(coverage.contiguousBars) || coverage.contiguousBars < 0 || coverage.contiguousBars > 120
    || typeof coverage.realBars !== "number" || !Number.isInteger(coverage.realBars) || coverage.realBars < UNDERLYING_FEATURE_MIN_REAL_BARS || coverage.realBars > 120) return null;
  const close = raw.evaluationClose, step = STEPS[interval];
  // R3.3 re-enforcement: the buckets that changed, as the record itself lists them (absent or malformed lists make every gated metric unavailable).
  const listed = Array.isArray(coverage.changedBuckets) && coverage.changedBuckets.length <= 120 && coverage.changedBuckets.every(timestamp) ? coverage.changedBuckets as number[] : null;
  const changedIn = (from: number, to: number): number => listed === null ? 0 : listed.filter(t => t >= from && t < to).length;
  const trailingChanged = (required: number): boolean => required < 2 || changedIn(close - required * step, close) >= Math.ceil(0.6 * required);
  const session = record(raw.session) ? raw.session : null;
  const orbChanged = (): boolean => {
    if (session === null || session.state !== "rth" || !timestamp(session.sessionStart)) return false;
    return listed !== null && listed.includes(session.sessionStart) && listed.includes(session.sessionStart + step);
  };
  const priceUnit = "usd_per_base_token";
  const metrics = {} as Record<FeatureMetricName, FeatureMetric>;
  for (const name of Object.keys(REQUIRED) as FeatureMetricName[]) {
    const unit = name === "rvol20" ? "ratio" : name === "ema12" || name === "ema26" || name === "atr14" ? priceUnit : "percent";
    const item = raw.metrics[name];
    const valid = name !== "rvol20" && record(item) && item.available === true && item.reason === null && item.unit === unit
      && typeof item.value === "number" && Number.isFinite(item.value)
      && item.requiredBars === REQUIRED[name] && typeof item.usableBars === "number"
      && Number.isInteger(item.usableBars) && item.usableBars >= REQUIRED[name] && item.usableBars <= 120
      && coverage.contiguousBars >= REQUIRED[name] && trailingChanged(REQUIRED[name])
      && (!(name === "atr14" || name === "atrPct") || item.value >= 0)
      && (!(name === "ema12" || name === "ema26") || item.value > 0);
    metrics[name] = { value: valid ? item.value as number : null, unit, available: valid };
  }
  const parameters = record(raw.parameters) ? raw.parameters : null;
  const revision = parameters?.indicatorRevision === 3 ? 3 : parameters?.indicatorRevision === 2 ? 2 : parameters?.indicatorRevision === 1 ? 1 : null;
  const additiveMetrics = {} as Record<AdditiveFeatureMetricName, FeatureMetric>;
  if (revision !== null) {
    for (const name of Object.keys(ADDITIVE_REQUIRED) as AdditiveFeatureMetricNameV1[]) {
      const item = raw.metrics[name];
      const unit = name === "rsi14" ? "index" : priceUnit;
      const valid = record(item) && item.available === true && item.reason === null && item.unit === unit
        && typeof item.value === "number" && Number.isFinite(item.value)
        && item.requiredBars === ADDITIVE_REQUIRED[name] && typeof item.usableBars === "number"
        && Number.isInteger(item.usableBars) && item.usableBars >= ADDITIVE_REQUIRED[name] && item.usableBars <= 120
        && coverage.contiguousBars >= ADDITIVE_REQUIRED[name] && trailingChanged(ADDITIVE_REQUIRED[name])
        && (name !== "rsi14" || (item.value >= 0 && item.value <= 100));
      additiveMetrics[name] = { value: valid ? item.value as number : null, unit, available: valid };
    }
  }
  if (revision === 2 || revision === 3) {
    for (const name of Object.keys(REV2_ADDITIVE_REQUIRED) as AdditiveFeatureMetricNameV2[]) {
      const required = name === "orbBreakPct" ? orbRequiredBars(interval) : REV2_ADDITIVE_REQUIRED[name];
      const item = raw.metrics[name];
      const unit = name === "bbPosition20" || name === "stochRsi14" ? "ratio" : "percent";
      const valid = name !== "vwapDistancePct" && required > 0 && record(item) && item.available === true && item.reason === null && item.unit === unit
        && typeof item.value === "number" && Number.isFinite(item.value)
        && item.requiredBars === required && typeof item.usableBars === "number"
        && Number.isInteger(item.usableBars) && item.usableBars >= required && item.usableBars <= 120
        && coverage.contiguousBars >= required
        && (name === "orbBreakPct" ? orbChanged() : trailingChanged(REV2_ADDITIVE_REQUIRED[name]));
      additiveMetrics[name] = { value: valid ? item.value as number : null, unit, available: valid };
    }
  }
  const sessionStateRaw = session?.state;
  const sessionState: SessionState | null = sessionStateRaw === "rth" || sessionStateRaw === "close" || sessionStateRaw === "overnight" ? sessionStateRaw : null;
  const result: FeatureEvidence = { pool: { pool: token.toLowerCase() as Address, tokenAddress: token.toLowerCase() as Address, currency: "usd" }, scope: "underlying", interval,
    quoteAddress: USDT_56.toLowerCase() as Address, observedAt: id.observedAt, calculatedAt: raw.calculatedAt, evaluationClose: raw.evaluationClose,
    expiresAt: raw.expiresAt, snapshotId: raw.snapshotId, seriesId: raw.seriesId, metrics,
    ...(revision !== null ? { indicatorRevision: revision, additiveMetrics } : {}),
    ...(revision === 2 || revision === 3 ? { sessionState } : {}) };
  return freshFeature(result, now) ? result : null;
}

/** R1 / RI2: per token per cycle the evidence comes from ONE scope. Underlying records are requested only for the tokens with no pool evidence at all, and never replace one. */
export async function mergeUnderlyingFeatures(dataPlane: Pick<TradeDataPlaneReads, "underlyingFeatureIndex" | "underlyingFeaturesBatch">, pool: ReadonlyMap<string, TokenFeatures>,
  tokens: readonly Address[], now: number, signal?: AbortSignal): Promise<ReadonlyMap<string, TokenFeatures>> {
  const wanted = tokens.filter(token => pool.get(token.toLowerCase()) === undefined);
  if (wanted.length === 0) return pool;
  const underlying = await enrichUnderlyingFeatures(dataPlane, wanted, now, signal);
  if (underlying.size === 0) return pool;
  const merged = new Map(pool);
  for (const [token, evidence] of underlying) if (!merged.has(token)) merged.set(token, evidence);
  return merged;
}

/** The pool path's twin for tokens that have no pool series: index plus 10-token batches per interval, one 12 s aggregate deadline, outages only remove evidence. */
export async function enrichUnderlyingFeatures(dataPlane: Pick<TradeDataPlaneReads, "underlyingFeatureIndex" | "underlyingFeaturesBatch">, tokens: readonly Address[], now: number, signal?: AbortSignal): Promise<ReadonlyMap<string, TokenFeatures>> {
  const result = new Map<string, TokenFeatures>();
  if (!dataPlane.underlyingFeatureIndex || !dataPlane.underlyingFeaturesBatch || tokens.length === 0) return result;
  const deadline = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    deadline.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("feature-read-aborted"));
      deadline.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(operation).then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort)).catch(() => undefined);
    });
  };
  try {
    const found = selectUnderlyingTokens(await bounded(() => dataPlane.underlyingFeatureIndex!(deadline)), tokens);
    signal?.throwIfAborted();
    if (!found.length) return result;
    const chunks: Address[][] = [];
    for (let index = 0; index < found.length; index += FEATURE_BATCH_SIZE) chunks.push(found.slice(index, index + FEATURE_BATCH_SIZE));
    await Promise.all((["15m", "1h"] as const).flatMap(interval => chunks.map(async chunk => {
      try {
        const batch = await bounded(() => dataPlane.underlyingFeaturesBatch!(chunk, interval, deadline));
        if (!record(batch) || Object.keys(batch).length > FEATURE_BATCH_SIZE) return;
        for (const token of chunk) {
          const row = batch[token];
          const evidence = decodeUnderlyingFeature(record(row) ? row.data : null, token, interval, now);
          if (evidence) result.set(token, { ...result.get(token), [interval]: evidence });
        }
      } catch { /* A missing batch does not discard the others. */ }
    })));
  } catch { /* No underlying evidence: the candidate stays unscored. */ }
  if (signal?.aborted) signal.throwIfAborted();
  return result;
}

export function describeFeatures(features: TokenFeatures | undefined): string {
  if (!features) return "no fresh indicators";
  const row = features["1h"] ?? features["15m"];
  if (!row) return "no fresh indicators";
  const parts: string[] = [];
  const ema = row.metrics.emaSpreadPct;
  if (ema.available && ema.value !== null) parts.push(`${row.interval} EMA12 ${ema.value >= 0 ? "above" : "below"} EMA26 (${ema.value.toFixed(1)}%)`);
  const additive = row.additiveMetrics;
  if (additive?.histogram?.available && additive.histogram.value !== null) parts.push(`${row.interval} MACD hist ${additive.histogram.value >= 0 ? "positive" : "negative"}`);
  if (additive?.rsi14?.available && additive.rsi14.value !== null) parts.push(`RSI14 ${additive.rsi14.value.toFixed(0)}`);
  const rvol = row.metrics.rvol20;
  if (rvol.available && rvol.value !== null) parts.push(`RVOL ${rvol.value.toFixed(1)}`);
  const summary = parts.length ? parts.join(", ") : "no fresh indicators";
  return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
}

export const FEATURE_PROMPT_GUIDANCE = "Exact-pool features are optional context, not executable quotes or liquidity. Missing metrics are unknown, never zero; retain snapshot reasoning. RVOL compares one closed bar against 20 prior bars; volume24h is different and neither proves local depth. Never compare USD and token price levels. Momentum assessment is advisory, not a gate. Rank best-first; confidence is a model score, not win probability.";

import assert from "node:assert/strict";
import test from "node:test";
import { decodeFeature, describeFeatures } from "../src/trade/features.js";
import { featureFixture } from "./support/tradeFeatures.js";

const NOW = 1_800_000_090_000;
const POOL = { pool: "0x0000000000000000000000000000000000000001" as `0x${string}`, tokenAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`, currency: "usd" as const };

function rev1Additive(requiredBars: Record<string, number>) {
  const metric = (value: number, unit: string, name: string) => ({ value, unit, requiredBars: requiredBars[name], usableBars: requiredBars[name], available: true, reason: null });
  return { rsi14: metric(55, "index", "rsi14"), macd: metric(2, "usd_per_base_token", "macd"), signal9: metric(1, "usd_per_base_token", "signal9"),
    histogram: metric(1, "usd_per_base_token", "histogram"), momentum10: metric(1, "usd_per_base_token", "momentum10") };
}

// Live data plane values, verified 2026-09-21 16:06Z against /trading/features/v2?interval=15m: orbBreakPct
// requiredBars is 2 on 15m (0 on 1h — the orb component is always unavailable there).
function rev2Additive() {
  const m = (value: number, unit: string, requiredBars: number, usableBars = requiredBars) => ({ value, unit, requiredBars, usableBars, available: true, reason: null });
  return {
    bbPosition20: m(0.4, "ratio", 20), bbWidthPct20: m(3.2, "percent", 20), stochRsi14: m(0.5, "ratio", 42),
    gapPct: m(0.8, "percent", 1), vwapDistancePct: m(0.6, "percent", 1, 13), orbBreakPct: m(0.1, "percent", 2),
  };
}

test("rev 1 fixture decodes unchanged (no sessionState, revision 1)", () => {
  const raw = featureFixture("15m") as Record<string, unknown>;
  const withRev1 = { ...raw, coverage: { ...(raw.coverage as object), contiguousBars: 69 },
    parameters: { indicatorRevision: 1 }, metrics: { ...(raw.metrics as object), ...rev1Additive({ rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 }) } };
  const decoded = decodeFeature(withRev1, POOL, "15m", NOW);
  assert.ok(decoded);
  assert.equal(decoded!.indicatorRevision, 1);
  assert.equal(decoded!.additiveMetrics!.rsi14.value, 55);
  assert.equal(decoded!.sessionState, undefined);
});

test("rev 2 fixture yields the rev 1 five byte-identical plus the six new metrics", () => {
  const raw = featureFixture("15m") as Record<string, unknown>;
  const withRev2 = { ...raw, coverage: { ...(raw.coverage as object), contiguousBars: 69 },
    parameters: { indicatorRevision: 2 },
    session: { usEquity: true, state: "rth", nextBoundaryAt: NOW + 1000 },
    metrics: { ...(raw.metrics as object), ...rev1Additive({ rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 }), ...rev2Additive() } };
  const decoded = decodeFeature(withRev2, POOL, "15m", NOW);
  assert.ok(decoded);
  assert.equal(decoded!.indicatorRevision, 2);
  // rev 1 five byte-identical
  assert.equal(decoded!.additiveMetrics!.rsi14.value, 55);
  assert.equal(decoded!.additiveMetrics!.macd.value, 2);
  assert.equal(decoded!.additiveMetrics!.momentum10.value, 1);
  // the six new metrics
  assert.equal(decoded!.additiveMetrics!.bbPosition20?.value, 0.4);
  assert.equal(decoded!.additiveMetrics!.bbWidthPct20?.value, 3.2);
  assert.equal(decoded!.additiveMetrics!.stochRsi14?.value, 0.5);
  assert.equal(decoded!.additiveMetrics!.gapPct?.value, 0.8);
  assert.equal(decoded!.additiveMetrics!.vwapDistancePct?.value, 0.6);
  assert.equal(decoded!.additiveMetrics!.orbBreakPct?.value, 0.1);
  assert.equal(decoded!.sessionState, "rth");
});

test("rev 2 on 1h: orb is always unavailable (live requiredBars 0), the other five metrics still decode", () => {
  const raw = featureFixture("1h") as Record<string, unknown>;
  const withRev2 = { ...raw, coverage: { ...(raw.coverage as object), contiguousBars: 69 },
    parameters: { indicatorRevision: 2 }, session: { usEquity: true, state: "overnight" },
    metrics: { ...(raw.metrics as object), ...rev1Additive({ rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 }),
      bbPosition20: { value: 0.2, unit: "ratio", requiredBars: 20, usableBars: 20, available: true, reason: null },
      bbWidthPct20: { value: 3, unit: "percent", requiredBars: 20, usableBars: 20, available: true, reason: null },
      stochRsi14: { value: 0.3, unit: "ratio", requiredBars: 42, usableBars: 42, available: true, reason: null },
      gapPct: { value: 1.1, unit: "percent", requiredBars: 1, usableBars: 1, available: true, reason: null },
      vwapDistancePct: { value: 0.5, unit: "percent", requiredBars: 1, usableBars: 13, available: true, reason: null },
      // requiredBars is irrelevant here: the 1h warm-up is 0, so orb is unavailable regardless of what the row claims.
      orbBreakPct: { value: -0.2, unit: "percent", requiredBars: 0, usableBars: 0, available: true, reason: null } } };
  const decoded = decodeFeature(withRev2, POOL, "1h", NOW);
  assert.ok(decoded);
  assert.equal(decoded!.additiveMetrics!.orbBreakPct?.available, false);
  assert.equal(decoded!.additiveMetrics!.orbBreakPct?.value, null);
  assert.equal(decoded!.additiveMetrics!.stochRsi14?.value, 0.3);
  assert.equal(decoded!.sessionState, "overnight");
});

test("a 15m rev 2 payload with orbBreakPct.requiredBars === 2 decodes as available", () => {
  const raw = featureFixture("15m") as Record<string, unknown>;
  const withRev2 = { ...raw, coverage: { ...(raw.coverage as object), contiguousBars: 69 },
    parameters: { indicatorRevision: 2 },
    metrics: { ...(raw.metrics as object), ...rev1Additive({ rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 }), ...rev2Additive() } };
  const decoded = decodeFeature(withRev2, POOL, "15m", NOW);
  assert.ok(decoded);
  assert.equal(decoded!.additiveMetrics!.orbBreakPct?.available, true);
  assert.equal(decoded!.additiveMetrics!.orbBreakPct?.value, 0.1);
});

test("rev 2 additive metric goes unknown (not zero) when its required-bars sentinel mismatches", () => {
  const raw = featureFixture("15m") as Record<string, unknown>;
  const withRev2 = { ...raw, coverage: { ...(raw.coverage as object), contiguousBars: 69 },
    parameters: { indicatorRevision: 2 },
    metrics: { ...(raw.metrics as object), ...rev1Additive({ rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 }), ...rev2Additive(),
      stochRsi14: { value: 0.5, unit: "ratio", requiredBars: 41, usableBars: 42, available: true, reason: null } } };
  const decoded = decodeFeature(withRev2, POOL, "15m", NOW);
  assert.ok(decoded);
  assert.equal(decoded!.additiveMetrics!.stochRsi14?.available, false);
  assert.equal(decoded!.additiveMetrics!.stochRsi14?.value, null);
});

test("describeFeatures produces a worded, <=200-char summary from 1h evidence", () => {
  const raw = featureFixture("1h") as Record<string, unknown>;
  const withRev1 = { ...raw, coverage: { ...(raw.coverage as object), contiguousBars: 69 },
    parameters: { indicatorRevision: 1 }, metrics: { ...(raw.metrics as object), ...rev1Additive({ rsi14: 29, macd: 52, signal9: 69, histogram: 69, momentum10: 11 }) } };
  const decoded = decodeFeature(withRev1, POOL, "1h", NOW)!;
  const summary = describeFeatures({ "1h": decoded });
  assert.ok(summary.length > 0 && summary.length <= 200);
  assert.equal(summary.includes("{"), false);
});

test("describeFeatures falls back on empty evidence", () => {
  assert.equal(describeFeatures(undefined), "no fresh indicators");
  assert.equal(describeFeatures({}), "no fresh indicators");
});

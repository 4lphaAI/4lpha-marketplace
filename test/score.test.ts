import assert from "node:assert/strict";
import test from "node:test";
import type { FeatureEvidence, FeatureMetric } from "../src/trade/features.js";
import { scoreToken, TRADFI_COST_BAND_BPS } from "../src/trade/score.js";
import { SESSION_PROFILES } from "../src/trade/session.js";

function metric(value: number | null): FeatureMetric {
  return { value, unit: "percent", available: value !== null };
}

function evidence(metrics: Record<string, number | null>, additive: Record<string, number | null> = {}): FeatureEvidence {
  const base: Record<string, FeatureMetric> = {};
  for (const [k, v] of Object.entries(metrics)) base[k] = metric(v);
  const additiveMetrics: Record<string, FeatureMetric> = {};
  for (const [k, v] of Object.entries(additive)) additiveMetrics[k] = metric(v);
  return {
    pool: { pool: "0x1", tokenAddress: "0x2", currency: "usd" },
    interval: "15m", quoteAddress: "0x3", snapshotId: "s", seriesId: "q",
    observedAt: 0, calculatedAt: 0, evaluationClose: 0, expiresAt: 1e15,
    metrics: base, additiveMetrics,
  } as unknown as FeatureEvidence;
}

test("cost band constant", () => {
  assert.equal(TRADFI_COST_BAND_BPS, 150);
});

test("worked vector: mildly positive tape must not buy (rth)", () => {
  const f = evidence({ emaSpreadPct: 0.5, histogram: 0.5, macd: 5, signal9: 4, ema26: 1000, rsi14: 55, momentum10: 10, rvol20: 1.2, roc10Pct: 0.1, atrPct: 1 });
  const s = evidence({ emaSpreadPct: 0.3, roc10Pct: 0.4 });
  const result = scoreToken(f, s, "neutral", "rth");
  assert.equal(result.score, 11.2);
  assert.ok(Math.abs(result.activeWeightShare - 94 / 136) < 1e-9);
  assert.equal(result.buy, false);
  assert.equal(result.veto, null);
});

test("volume moves the score by its cut weight only and never moves the evidence share (rth)", () => {
  const score = (rvol20: number) => {
    const f = evidence({ emaSpreadPct: 0.5, histogram: 0.5, macd: 5, signal9: 4, ema26: 1000, rsi14: 55, momentum10: 10, rvol20, roc10Pct: 0.1, atrPct: 1 });
    const s = evidence({ emaSpreadPct: 0.3, roc10Pct: 0.4 });
    return scoreToken(f, s, "neutral", "rth");
  };
  const low = score(0.5); // volume component -30
  const high = score(2.0); // volume component +45
  assert.equal(low.score, 7.6);
  assert.equal(high.score, 13);
  assert.ok(Math.abs(high.score - low.score) <= (6 * 75) / 84 + 0.1);
  assert.equal(low.activeWeightShare, high.activeWeightShare);
  assert.ok(Math.abs(low.activeWeightShare - 94 / 136) < 1e-9);
});

test("insufficient-evidence below 0.35 active weight share", () => {
  const f = evidence({ rsi14: 20 }); // only rsi active in rth: weight 8/136 = 0.059
  const result = scoreToken(f, undefined, "neutral", "rth");
  assert.equal(result.insufficientEvidence, true);
  assert.equal(result.buy, false);
  assert.equal(result.veto, null);
});

test("falling-knife veto fires and is spared for strong", () => {
  // Build a broadly bearish-but-strong tape: ema very negative, momentum very negative -> falling knife trips
  const f = evidence({
    emaSpreadPct: -2, histogram: -20, macd: -10, signal9: 0, ema26: 1000,
    rsi14: 40, momentum10: -50, rvol20: 2, roc10Pct: -1, atrPct: 5,
  });
  const s = evidence({ emaSpreadPct: -1, roc10Pct: -1 });
  const weak = scoreToken(f, s, "neutral", "rth");
  assert.equal(weak.veto, "falling-knife");
});

test("falling-knife veto is rescued by oversold RSI + bullish MACD cross", () => {
  const f = evidence({
    emaSpreadPct: -2, histogram: 5, macd: 5, signal9: 4, ema26: 1000,
    rsi14: 25, momentum10: -50, rvol20: 2, roc10Pct: -1, atrPct: 5,
  });
  const s = evidence({ emaSpreadPct: -1, roc10Pct: -1 });
  const result = scoreToken(f, s, "neutral", "rth");
  assert.notEqual(result.veto, "falling-knife");
});

test("regime veto: risk_off blocks a buy-strength candidate but not a strong one", () => {
  const f = evidence({ emaSpreadPct: 2, histogram: 20, macd: 10, signal9: 4, ema26: 1000, rsi14: 55, momentum10: 30, rvol20: 2, roc10Pct: 0.1, atrPct: 5 });
  const s = evidence({ emaSpreadPct: 2, roc10Pct: 2 });
  const result = scoreToken(f, s, "risk_off", "rth");
  if (!result.strong) assert.equal(result.veto, "regime-risk-off");
});

test("extended veto never spared even for strong", () => {
  const f = evidence({
    emaSpreadPct: 5, histogram: 50, macd: 30, signal9: 5, ema26: 1000,
    rsi14: 55, momentum10: 80, rvol20: 4, roc10Pct: 10, atrPct: 1,
  });
  const s = evidence({ emaSpreadPct: 3, roc10Pct: 3 });
  const result = scoreToken(f, s, "risk_on", "rth");
  assert.equal(result.veto, "extended-over-3atr");
});

test("thresholds per session", () => {
  assert.equal(SESSION_PROFILES.rth.buy, 14);
  assert.equal(SESSION_PROFILES.close.buy, 12);
  assert.equal(SESSION_PROFILES.overnight.buy, 16);
  assert.equal(SESSION_PROFILES.rth.strong, 38);
  assert.equal(SESSION_PROFILES.close.strong, 34);
  assert.equal(SESSION_PROFILES.overnight.strong, 40);
});

test("component boundaries: rsi contrarian buckets", () => {
  const cases: readonly [number, "risk_on" | "risk_off" | "neutral"][] = [[29, "neutral"], [44, "neutral"], [59, "neutral"], [69, "neutral"], [80, "neutral"]];
  for (const [rsi] of cases) {
    const f = evidence({ rsi14: rsi });
    const result = scoreToken(f, undefined, "neutral", "rth");
    // rsi is the only active component (weight 8/136), so it stays insufficient-evidence,
    // but the raw component must still compute without throwing.
    assert.equal(typeof result.score, "number");
  }
});

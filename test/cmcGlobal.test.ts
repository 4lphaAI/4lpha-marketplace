import assert from "node:assert/strict";
import test from "node:test";
import { parseGlobalMetrics, globalRegime, regimeSizeScale } from "../src/trade/cmcGlobal.js";

const GLOBAL_FIXTURE = `{"data":{"market_size":{"total_market_cap":{"value":"2.15 T","change_24h":"+5.41%","change_7d":"+1.2%"},"total_volume_24h":{"value":"90 B","change_24h":"+42%"}},"fear_greed":{"value":"71"}}}`;

test("parseGlobalMetrics reads a description-derived fixture", () => {
  const metrics = parseGlobalMetrics(GLOBAL_FIXTURE);
  assert.equal(metrics.mcap24hPct, 5.41);
  assert.equal(metrics.mcap7dPct, 1.2);
  assert.equal(metrics.fearGreed, 71);
  assert.equal(metrics.volume24hPct, 42);
});

test("parseGlobalMetrics returns nulls on a mangled variant", () => {
  const metrics = parseGlobalMetrics(`{"data":{"nonsense":true}}`);
  assert.equal(metrics.mcap24hPct, null);
  assert.equal(metrics.mcap7dPct, null);
  assert.equal(metrics.fearGreed, null);
});

test("parseGlobalMetrics on empty/garbage input never throws", () => {
  assert.doesNotThrow(() => parseGlobalMetrics(""));
  assert.doesNotThrow(() => parseGlobalMetrics("not json at all {{{"));
});

test("globalRegime: risk_off on a sharp 24h drop", () => {
  assert.equal(globalRegime({ mcap24hPct: -3, mcap7dPct: 0, fearGreed: null, volume24hPct: null }), "risk_off");
});

test("globalRegime: risk_off on a moderate drop with high volume", () => {
  assert.equal(globalRegime({ mcap24hPct: -1.5, mcap7dPct: 0, fearGreed: null, volume24hPct: 45 }), "risk_off");
});

test("globalRegime: risk_on on a positive 24h and non-negative 7d", () => {
  assert.equal(globalRegime({ mcap24hPct: 5.41, mcap7dPct: 1.2, fearGreed: null, volume24hPct: null }), "risk_on");
});

test("globalRegime: neutral otherwise", () => {
  assert.equal(globalRegime({ mcap24hPct: 0.3, mcap7dPct: -1, fearGreed: null, volume24hPct: null }), "neutral");
});

test("globalRegime: unavailable when mcap24hPct is unknown", () => {
  assert.equal(globalRegime({ mcap24hPct: null, mcap7dPct: 1, fearGreed: null, volume24hPct: null }), "unavailable");
});

test("regimeSizeScale table", () => {
  assert.equal(regimeSizeScale("risk_off", "none"), 0.55);
  assert.equal(regimeSizeScale("risk_on", "none"), 1.12);
  assert.equal(regimeSizeScale("neutral", "none"), 1);
  assert.equal(regimeSizeScale("unavailable", "none"), 1);
  assert.equal(Math.round(regimeSizeScale("risk_on", "high") * 100) / 100, 0.67);
  assert.equal(Math.round(regimeSizeScale("neutral", "high") * 100) / 100, 0.6);
});

// Real payload shape captured on 2026-09-22 00:49 UTC from the first paid
// get_global_metrics_latest row (tradfi-trade-agent-01). The description-derived
// keys never occur on the wire; this fixture pins the measured shape.
test("parseGlobalMetrics reads the LIVE CMC shape (percent_change.24h under total_crypto_market_cap_usd / volume24h.total)", () => {
  const live = '{"last_updated":"22 September 2026 12:00 AM UTC+0","market_size":{"definition":"Market size captures the aggregate USD value of the entire crypto asset class, providing a top-down gauge of how large or small the market is relative to history or to other cryptos or asset classes.","total_crypto_market_cap_usd":{"current":"2.93 T","percent_change":{"24h":"+4.43%","7d":"+10.11%","30d":"+10.92%"},"yearly":{"max":{"value":"4.28 T","timestamp":"7 October 2025 12:00 AM UTC+0"},"min":{"value":"2.04 T","timestamp":"1 July 2026 12:00 AM UTC+0"}}}},"liquidity":{"definition":"Liquidity metrics track how much value changes hands.","volume24h":{"total":{"current":"146.93 B","percent_change":{"24h":"+105.89%","7d":"+73.7%","30d":"+5.6%"}},"spot":{"current":"290.91 B","percent_change":{"24h":"+89.78%"}}},"spot_vs_perp_ratio":"0.23"},"sentiment":{"fear_greed":{"definition":"The CMC Fear & Greed Index distills overall crypto-market sentiment into a single 0-100 score that traders can read contrarily.","current":{"value":"Greed","index":61},"history":{"yesterday":{"value":"Greed","index":58}}}}}';
  const parsed = parseGlobalMetrics(live);
  assert.deepEqual(parsed, { mcap24hPct: 4.43, mcap7dPct: 10.11, fearGreed: 61, volume24hPct: 105.89 });
  assert.equal(globalRegime(parsed), "risk_on");
});

/** TRADFI-ENTRY-TIMING-SPEC §6.1: the pure gate and the mode resolver. */
import assert from "node:assert/strict";
import test from "node:test";
import { entryTimingGate, resolveEntryTimingMode } from "../src/trade/entryTiming.js";
import type { FeatureEvidence } from "../src/trade/features.js";
import { normalizeTradeRunEvents } from "../src/store/tradeRunTrace.js";

// Friday 2026-06-05, EDT: 17:00 UTC = 13:00 ET, outside the opening range.
const MIDDAY = Date.UTC(2026, 5, 5, 17, 0, 0);
const f15 = (stochRsi14?: number, bbPosition20?: number): FeatureEvidence => {
  const metric = (value: number) => ({ value, unit: "ratio", available: true });
  return { additiveMetrics: {
    ...(stochRsi14 === undefined ? {} : { stochRsi14: metric(stochRsi14) }),
    ...(bbPosition20 === undefined ? {} : { bbPosition20: metric(bbPosition20) }),
  } } as unknown as FeatureEvidence;
};

test("rule A: stochRsi14 >= 0.95 or bbPosition20 >= 1.0 gates; just below does not", () => {
  assert.deepEqual(entryTimingGate(f15(0.95), MIDDAY), { gated: true, rule: "impulse", detail: "stochRsi=0.95 bb=n/a" });
  assert.deepEqual(entryTimingGate(f15(0.949), MIDDAY), { gated: false });
  assert.deepEqual(entryTimingGate(f15(undefined, 1.0), MIDDAY), { gated: true, rule: "impulse", detail: "stochRsi=n/a bb=1.00" });
  assert.deepEqual(entryTimingGate(f15(0.97, 1.04), MIDDAY), { gated: true, rule: "impulse", detail: "stochRsi=0.97 bb=1.04" });
  assert.deepEqual(entryTimingGate(f15(undefined, 0.999), MIDDAY), { gated: false });
});

test("rule A: missing values and a missing feature set do not gate", () => {
  assert.deepEqual(entryTimingGate(f15(), MIDDAY), { gated: false });
  assert.deepEqual(entryTimingGate(undefined, MIDDAY), { gated: false });
  const unavailable = { additiveMetrics: { stochRsi14: { value: null, unit: "ratio", available: false }, bbPosition20: { value: 1.2, unit: "ratio", available: false } } } as unknown as FeatureEvidence;
  assert.deepEqual(entryTimingGate(unavailable, MIDDAY), { gated: false });
});

test("rule B: 09:30 to 09:59 ET on a weekday gates, 10:00 does not, a weekend does not", () => {
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 5, 5, 13, 30)), { gated: true, rule: "opening-range", detail: "et=09:30" });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 5, 5, 13, 41)), { gated: true, rule: "opening-range", detail: "et=09:41" });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 5, 5, 13, 59)), { gated: true, rule: "opening-range", detail: "et=09:59" });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 5, 5, 14, 0)), { gated: false });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 5, 5, 13, 29)), { gated: false });
  // Saturday 2026-06-06 09:45 ET.
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 5, 6, 13, 45)), { gated: false });
});

test("rule B is checked before rule A", () => {
  const both = entryTimingGate(f15(0.99, 1.5), Date.UTC(2026, 5, 5, 13, 45));
  assert.deepEqual(both, { gated: true, rule: "opening-range", detail: "et=09:45" });
});

test("rule B follows the New York clock across both DST changes", () => {
  // 2026-03-09 (Mon): DST began 03-08, so 09:30 ET is 13:30 UTC.
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 2, 9, 13, 30)), { gated: true, rule: "opening-range", detail: "et=09:30" });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 2, 9, 13, 29)), { gated: false });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 2, 9, 14, 0)), { gated: false });
  // 2026-11-02 (Mon): DST ended 11-01, so 09:30 ET is 14:30 UTC and 13:45 UTC is 08:45 ET.
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 10, 2, 14, 30)), { gated: true, rule: "opening-range", detail: "et=09:30" });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 10, 2, 14, 59)), { gated: true, rule: "opening-range", detail: "et=09:59" });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 10, 2, 13, 45)), { gated: false });
  assert.deepEqual(entryTimingGate(undefined, Date.UTC(2026, 10, 2, 15, 0)), { gated: false });
});

test("TRADFI_ENTRY_TIMING_MODE: default log, three modes accepted, an unrecognised value is log and warned once", () => {
  const warnings: string[] = [];
  const warn = (line: string) => { warnings.push(line); };
  assert.equal(resolveEntryTimingMode(undefined, warn), "log");
  assert.equal(resolveEntryTimingMode("", warn), "log");
  assert.equal(warnings.length, 0);
  assert.equal(resolveEntryTimingMode("off", warn), "off");
  assert.equal(resolveEntryTimingMode("log", warn), "log");
  assert.equal(resolveEntryTimingMode("enforce", warn), "enforce");
  assert.equal(warnings.length, 0);
  assert.equal(resolveEntryTimingMode("Enforcing", warn), "log");
  assert.equal(warnings.length, 1);
});

test("the timing run-log events survive normalizeTradeRunEvents", () => {
  const token = `0x${"ab".repeat(20)}`;
  const events = normalizeTradeRunEvents([
    { stage: "score", code: "timing:would-defer:impulse", elapsedMs: 1, token, reason: "stochRsi=0.97 bb=1.04" },
    { stage: "score", code: "timing:deferred:opening-range", elapsedMs: 2, token, reason: "et=09:41" },
  ]);
  assert.deepEqual(events.map((event) => [event.stage, event.code, event.token, event.reason]), [
    ["score", "timing:would-defer:impulse", token, "stochRsi=0.97 bb=1.04"],
    ["score", "timing:deferred:opening-range", token, "et=09:41"],
  ]);
});

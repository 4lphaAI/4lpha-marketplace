import assert from "node:assert/strict";
import test from "node:test";
import { sessionState, SESSION_EVIDENCE_WEIGHTS, SESSION_PROFILES, SESSION_WEIGHTS } from "../src/trade/session.js";

// America/New_York timestamps, computed relative to known UTC offsets (EDT = UTC-4, EST = UTC-5).

test("Fri 15:59 ET (EDT) is rth", () => {
  // 2026-06-05 is a Friday, EDT (UTC-4): 15:59 ET = 19:59 UTC.
  assert.equal(sessionState(Date.UTC(2026, 5, 5, 19, 59)), "rth");
});

test("Fri 16:00 ET (EDT) is close", () => {
  assert.equal(sessionState(Date.UTC(2026, 5, 5, 20, 0)), "close");
});

test("Fri 20:00 ET (EDT) is overnight", () => {
  assert.equal(sessionState(Date.UTC(2026, 5, 6, 0, 0)), "overnight");
});

test("Saturday is overnight regardless of clock", () => {
  // 2026-06-06 is a Saturday.
  assert.equal(sessionState(Date.UTC(2026, 5, 6, 15, 0)), "overnight");
});

test("DST week: Jan (EST, UTC-5) 09:30 ET is rth", () => {
  // 2026-01-09 is a Friday, EST (UTC-5): 09:30 ET = 14:30 UTC.
  assert.equal(sessionState(Date.UTC(2026, 0, 9, 14, 30)), "rth");
});

test("DST week: Jan (EST) 09:29 ET is overnight", () => {
  assert.equal(sessionState(Date.UTC(2026, 0, 9, 14, 29)), "overnight");
});

test("session profiles and weights are defined for all three sessions", () => {
  for (const session of ["rth", "close", "overnight"] as const) {
    assert.ok(SESSION_PROFILES[session]);
    assert.ok(SESSION_WEIGHTS[session]);
  }
  assert.equal(SESSION_PROFILES.rth.buy, 14);
  assert.equal(SESSION_PROFILES.rth.strong, 38);
  assert.equal(SESSION_PROFILES.close.sizeMult, 0.8);
  assert.equal(SESSION_PROFILES.overnight.sizeMult, 0.55);
  assert.equal(SESSION_PROFILES.overnight.maxOpen, 3);
});

test("volume score weight is cut to 6 / 4 / 3 and the evidence table keeps the pre-cut weights", () => {
  assert.equal(SESSION_WEIGHTS.rth.volume, 6);
  assert.equal(SESSION_WEIGHTS.close.volume, 4);
  assert.equal(SESSION_WEIGHTS.overnight.volume, 3);
  assert.deepEqual(SESSION_EVIDENCE_WEIGHTS, {
    rth: { orb: 18, momentum: 16, volume: 16, ema: 14, macd: 12, regime: 12, vwap: 10, rsi: 8, gap: 6, roc1h: 6, bollinger: 4, stochRsi: 4, atrGuard: 10 },
    close: { orb: 0, momentum: 14, volume: 12, ema: 16, macd: 14, regime: 12, vwap: 10, rsi: 10, gap: 12, roc1h: 8, bollinger: 6, stochRsi: 6, atrGuard: 10 },
    overnight: { orb: 0, momentum: 14, volume: 8, ema: 18, macd: 16, regime: 14, vwap: 0, rsi: 10, gap: 14, roc1h: 10, bollinger: 8, stochRsi: 6, atrGuard: 10 },
  });
});
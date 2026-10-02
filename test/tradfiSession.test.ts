import assert from "node:assert/strict";
import test from "node:test";
import { sessionState, SESSION_PROFILES, SESSION_WEIGHTS } from "../src/trade/session.js";

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

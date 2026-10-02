import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExitTrigger, tradfiExitAllowed, type ExitTriggerContext } from "../src/trade/score.js";

function ctx(overrides: Partial<ExitTriggerContext> = {}): ExitTriggerContext {
  return { pnlBps: 0, peakPnlBps: null, macdHistSign: 1, emaSpreadSign: 1, regime: "neutral", session: "rth", ...overrides };
}

test("no trigger on a flat, unchanged position (never asked, small pnl)", () => {
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: 50 })), null);
});

test("cost-band-breach fires on gains past +300 bps and on losses only past -800 bps (ruling 2026-09-23)", () => {
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: 299 })), null);
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: 301 })), "cost-band-breach");
  // The measured de-facto 3 % stop: -301..-799 no longer asks the model.
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: -301 })), null);
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: -799 })), null);
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: -800 })), "cost-band-breach");
});

test("tradfiExitAllowed brakes a loss inside -800 bps unless the 1h trend broke or the regime is risk_off", () => {
  const base = { emaSpreadSign: 1 as const, macdHistSign: 1 as const, regime: "neutral" as const };
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: -316 }).allowed, false, "MSTRB -3.16 % with an intact trend is held");
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: -316, emaSpreadSign: -1 }).allowed, false, "one broken signal is not enough");
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: -316, emaSpreadSign: -1, macdHistSign: -1 }).allowed, true);
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: -316, regime: "risk_off" }).allowed, true);
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: -800 }).allowed, true);
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: 250 }).allowed, true, "gains are never braked");
  assert.equal(tradfiExitAllowed({ ...base, pnlBps: -316, emaSpreadSign: null, macdHistSign: null }).allowed, false, "unknown trend is not a broken trend");
});

test("cost-band-breach does not re-fire within the same 300bps band, but does after a further 300bps move", () => {
  const prior = ctx({ pnlBps: 320, trigger: "cost-band-breach" });
  assert.equal(evaluateExitTrigger(prior, ctx({ pnlBps: 400 })), null);
  assert.equal(evaluateExitTrigger(prior, ctx({ pnlBps: 620 })), "cost-band-breach");
});

test("cost-band-breach fires again when pnl crosses to the opposite side past that side's threshold", () => {
  const prior = ctx({ pnlBps: 320, trigger: "cost-band-breach" });
  assert.equal(evaluateExitTrigger(prior, ctx({ pnlBps: -320 })), null);
  assert.equal(evaluateExitTrigger(prior, ctx({ pnlBps: -820 })), "cost-band-breach");
});

test("macd-flip-1h fires once on a sign change and not again without a further flip", () => {
  const prior = ctx({ macdHistSign: 1, trigger: "macd-flip-1h" });
  assert.equal(evaluateExitTrigger(prior, ctx({ macdHistSign: -1 })), "macd-flip-1h");
  const after = ctx({ macdHistSign: -1, trigger: "macd-flip-1h" });
  assert.equal(evaluateExitTrigger(after, ctx({ macdHistSign: -1 })), null);
});

test("macd-flip-1h is inactive when either sign is unknown", () => {
  assert.equal(evaluateExitTrigger(ctx({ macdHistSign: null }), ctx({ macdHistSign: 1 })), null);
  assert.equal(evaluateExitTrigger(ctx({ macdHistSign: 1 }), ctx({ macdHistSign: null })), null);
});

test("ema-cross-1h fires once on a sign change and not again without a further cross", () => {
  const prior = ctx({ emaSpreadSign: 1 });
  assert.equal(evaluateExitTrigger(prior, ctx({ emaSpreadSign: -1 })), "ema-cross-1h");
  const after = ctx({ emaSpreadSign: -1 });
  assert.equal(evaluateExitTrigger(after, ctx({ emaSpreadSign: -1 })), null);
});

test("regime-change fires when regime differs and the new regime is known", () => {
  const prior = ctx({ regime: "neutral" });
  assert.equal(evaluateExitTrigger(prior, ctx({ regime: "risk_off" })), "regime-change");
  assert.equal(evaluateExitTrigger(prior, ctx({ regime: "unavailable" })), null);
});

test("session-boundary fires once per boundary crossing", () => {
  const prior = ctx({ session: "rth" });
  assert.equal(evaluateExitTrigger(prior, ctx({ session: "close" })), "session-boundary");
  const after = ctx({ session: "close" });
  assert.equal(evaluateExitTrigger(after, ctx({ session: "close" })), null);
});

test("peak-giveback fires on a >=200bps drop from a >=300bps peak, once per giveback", () => {
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: 90, peakPnlBps: 300 })), "peak-giveback");
  const prior = ctx({ pnlBps: 90, peakPnlBps: 300, trigger: "peak-giveback" });
  // Same or higher pnl than the last peak-giveback ask: does not re-fire.
  assert.equal(evaluateExitTrigger(prior, ctx({ pnlBps: 95, peakPnlBps: 300 })), null);
  // A fresh drop below the last asked pnl re-fires.
  assert.equal(evaluateExitTrigger(prior, ctx({ pnlBps: 50, peakPnlBps: 300 })), "peak-giveback");
});

test("peak-giveback is inactive below the 300bps peak floor", () => {
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: 50, peakPnlBps: 250 })), null);
});

test("no-trigger path: an unchanged position with no crossing makes no ask", () => {
  const prior = ctx({ pnlBps: 100, peakPnlBps: 100, macdHistSign: 1, emaSpreadSign: 1, regime: "neutral", session: "rth" });
  const current = ctx({ pnlBps: 105, peakPnlBps: 105, macdHistSign: 1, emaSpreadSign: 1, regime: "neutral", session: "rth" });
  assert.equal(evaluateExitTrigger(prior, current), null);
});

test("a real trigger is required even on the first ask", () => {
  // First ask (prior null), signs/regime/session read as current so they can never
  // differ from themselves; only cost-band-breach or peak-giveback can fire.
  assert.equal(evaluateExitTrigger(null, ctx({ pnlBps: 10, peakPnlBps: null })), null);
});

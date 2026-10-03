/** TRADFI-EXIT-RULES: the pure robot exits, the mode resolver, the exit prompt sentence and the run-log event. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveTradfiExitRulesMode, tradfiPeakImplausible, tradfiRobotExit, TRADFI_TRAIL_MAX_PEAK_BPS } from "../src/trade/exitRules.js";
import { buildExitPrompt } from "../src/trade/llm.js";
import { TRADFI_COST_BAND_BPS } from "../src/trade/score.js";
import { normalizeTradeRunEvents } from "../src/store/tradeRunTrace.js";

const HOUR = 3_600_000;
const NOW = 1_900_000_000_000;
const base = { pnlBps: 0, peakPnlBps: 0, openedAtMs: NOW - HOUR, nowMs: NOW, takeProfitBlank: true, maxHoldBlank: true };
const run = (overrides: Partial<Parameters<typeof tradfiRobotExit>[0]>) => tradfiRobotExit({ ...base, ...overrides });

test("T: a peak of 199 never arms; 200 arms and fires at peak - 150", () => {
  assert.equal(run({ peakPnlBps: 199, pnlBps: -500 }), null);
  assert.deepEqual(run({ peakPnlBps: 200, pnlBps: 50 }), { rule: "trailing-stop", detail: "peak=+200 now=+50" });
});

test("T: 163 against a 312 peak holds (163 > 162), 162 fires", () => {
  assert.equal(run({ peakPnlBps: 312, pnlBps: 163 }), null);
  assert.deepEqual(run({ peakPnlBps: 312, pnlBps: 162 }), { rule: "trailing-stop", detail: "peak=+312 now=+162" });
});

test("T detail signs a negative reading", () => {
  assert.equal(run({ peakPnlBps: 250, pnlBps: -40 })?.detail, "peak=+250 now=-40");
});

test("S: 47.9 h at pnl 0 holds; 48 h at pnl 100 fires; 48 h at pnl 101 holds", () => {
  assert.equal(run({ openedAtMs: NOW - 47.9 * HOUR, pnlBps: 0, peakPnlBps: 0 }), null);
  assert.deepEqual(run({ openedAtMs: NOW - 48 * HOUR, pnlBps: 100, peakPnlBps: 100 }), { rule: "stale-exit", detail: "held=48.0h pnl=+100" });
  assert.equal(run({ openedAtMs: NOW - 48 * HOUR, pnlBps: 101, peakPnlBps: 101 }), null);
  assert.equal(run({ openedAtMs: NOW - 49.2 * HOUR, pnlBps: 40, peakPnlBps: 40 })?.detail, "held=49.2h pnl=+40");
  assert.equal(run({ openedAtMs: NOW - 60 * HOUR, pnlBps: -300, peakPnlBps: 10 })?.detail, "held=60.0h pnl=-300");
});

test("owner settings keep priority: a set take profit disables T, a set max hold disables S", () => {
  assert.equal(run({ peakPnlBps: 400, pnlBps: 100, takeProfitBlank: false }), null);
  assert.equal(run({ openedAtMs: NOW - 60 * HOUR, pnlBps: 0, maxHoldBlank: false }), null);
  // The other rule is unaffected by the owner's setting for this one.
  assert.equal(run({ peakPnlBps: 400, pnlBps: 100, maxHoldBlank: false })?.rule, "trailing-stop");
  assert.equal(run({ openedAtMs: NOW - 60 * HOUR, pnlBps: 0, takeProfitBlank: false })?.rule, "stale-exit");
});

test("T is checked first: a position that satisfies both reports the trailing stop", () => {
  assert.equal(run({ peakPnlBps: 400, pnlBps: 50, openedAtMs: NOW - 60 * HOUR })?.rule, "trailing-stop");
});

test("review M1: a peak of 2000 arms T normally, 2001 skips T, and S is unaffected by the implausible peak", () => {
  assert.equal(TRADFI_TRAIL_MAX_PEAK_BPS, 2_000);
  assert.equal(tradfiPeakImplausible(2_000), false);
  assert.equal(tradfiPeakImplausible(2_001), true);
  assert.deepEqual(run({ peakPnlBps: 2_000, pnlBps: 1_850 }), { rule: "trailing-stop", detail: "peak=+2000 now=+1850" });
  assert.equal(run({ peakPnlBps: 2_001, pnlBps: 0 }), null, "a corrupted peak must not sell a position at its real PnL");
  assert.equal(run({ peakPnlBps: 8_141, pnlBps: -300 }), null);
  assert.deepEqual(run({ peakPnlBps: 2_001, pnlBps: 0, openedAtMs: NOW - 49 * HOUR }), { rule: "stale-exit", detail: "held=49.0h pnl=+0" });
});

test("review L3: a position with no stored peak (negative infinity) never arms T and never leaks into a detail", () => {
  assert.equal(run({ peakPnlBps: Number.NEGATIVE_INFINITY, pnlBps: 300 }), null);
  assert.equal(tradfiPeakImplausible(Number.NEGATIVE_INFINITY), false);
  const stale = run({ peakPnlBps: Number.NEGATIVE_INFINITY, pnlBps: 40, openedAtMs: NOW - 50 * HOUR });
  assert.deepEqual(stale, { rule: "stale-exit", detail: "held=50.0h pnl=+40" });
  assert.equal(JSON.stringify(stale).includes("Infinity"), false);
});

test("mode resolver: unset or blank is log, the three names pass, anything else is log with one warning", () => {
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);
  assert.equal(resolveTradfiExitRulesMode(undefined, warn), "log");
  assert.equal(resolveTradfiExitRulesMode("  ", warn), "log");
  assert.equal(resolveTradfiExitRulesMode("off", warn), "off");
  assert.equal(resolveTradfiExitRulesMode("log", warn), "log");
  assert.equal(resolveTradfiExitRulesMode(" enforce ", warn), "enforce");
  assert.equal(warnings.length, 0);
  assert.equal(resolveTradfiExitRulesMode("ENFORCE!", warn), "log");
  assert.equal(warnings.length, 1);
});

const OWNER = { instructions: null, skillMarkdown: null };
const position = { tokenAddress: "0x3333333333333333333333333333333333333333", symbol: "STOCK", pnlBps: 335n, ageSec: 60, takeProfitBps: null, stopLossBps: null };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("the TradFi exit prompt carries the net-of-cost sentence and not the spread sentence; the cost band constant is unchanged", () => {
  assert.equal(TRADFI_COST_BAND_BPS, 150);
  const system = buildExitPrompt({ tradfi: true, owner: OWNER, positions: [position] })[0]!.content;
  assert.ok(system.includes("pnlBps is already net of the purchase cost and of the current sell quote, so a positive pnlBps is real profit after costs."));
  assert.equal(system.includes("A round trip costs about"), false);
  assert.equal(system.includes("is spread, not a signal"), false);
});

test("non-TradFi exit prompts are byte-identical to the pre-change prompts (hashes captured from master d214424)", () => {
  assert.equal(digest(buildExitPrompt({ owner: OWNER, positions: [position] })),
    "98cc1898bbecffe2ff438bfbb6829a39bbd9f0270da84ffe984e24423b66d349");
  assert.equal(digest(buildExitPrompt({ owner: OWNER, positions: [position], timeLimitAuthority: true })),
    "118e5059566ce679718967443789a5138ba77671acb4b65e172ff479eefd1d2d");
});

test("the rule run-log events survive normalizeTradeRunEvents", () => {
  const token = "0x3333333333333333333333333333333333333333";
  const events = normalizeTradeRunEvents([
    { stage: "exit-llm", code: "rule:would-exit:trailing-stop", elapsedMs: 5, token, reason: "peak=+312 now=+150" },
    { stage: "exit-llm", code: "rule:exit:stale-exit", elapsedMs: 6, token, reason: "held=49.2h pnl=+40" },
  ]);
  assert.deepEqual(events.map(event => [event.stage, event.code, event.token, event.reason]), [
    ["exit-llm", "rule:would-exit:trailing-stop", token, "peak=+312 now=+150"],
    ["exit-llm", "rule:exit:stale-exit", token, "held=49.2h pnl=+40"],
  ]);
});

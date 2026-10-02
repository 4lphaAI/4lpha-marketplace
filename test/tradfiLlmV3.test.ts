import assert from "node:assert/strict";
import test from "node:test";
import { buildEntryPrompt, buildExitPrompt, type EntryPromptCandidate, type ExitPromptPosition } from "../src/trade/llm.js";
import { TRADFI_DOCTRINE } from "../src/trade/doctrine.js";
import { TRADFI_COST_BAND_BPS } from "../src/trade/score.js";

const OWNER = { instructions: null, skillMarkdown: null };

function candidate(overrides: Partial<EntryPromptCandidate> = {}): EntryPromptCandidate {
  return { address: "0x1", symbol: "AAPL", marketCapUsd: 1, priceUsd: 1, volume24hUsd: 1, priceChange24hPct: 1,
    holders: 1, source: "bstocks", scanFlags: [], ...overrides };
}

test("tradfi entry rows carry score/strength/scoreReasons columns and the system nudge line", () => {
  const messages = buildEntryPrompt({ model: "tradfi", v2: true, owner: OWNER,
    candidates: [candidate({ score: 42.5, strength: "strong", scoreReasons: "ema=13 macd=35 volume=20" })] });
  const system = messages[0]!.content;
  const user = messages[1]!.content;
  assert.ok(system.includes("already scored and shortlisted"));
  assert.ok(user.includes("score\tstrength\tscoreReasons"));
  assert.ok(user.includes("42.5\tstrong\tema=13 macd=35 volume=20"));
});

test("non-tradfi v2 entry rows do not carry the score columns", () => {
  const messages = buildEntryPrompt({ model: "blue-chip", v2: true, owner: OWNER, candidates: [candidate()] });
  const user = messages[1]!.content;
  assert.equal(user.includes("score\tstrength\tscoreReasons"), false);
});

function position(overrides: Partial<ExitPromptPosition> = {}): ExitPromptPosition {
  return { tokenAddress: "0x1", symbol: "AAPL", pnlBps: -50n, ageSec: 100, takeProfitBps: null, stopLossBps: null, ...overrides };
}

test("tradfi exit system text carries the doctrine and the cost band, no JSON feature block", () => {
  const messages = buildExitPrompt({ tradfi: true, timeLimitAuthority: true, owner: OWNER,
    positions: [position({ peakPnlBps: 300n, trigger: "peak-giveback", session: "rth", regime: "neutral", indicators: "1h EMA12 below EMA26" })],
    featureBlocks: ['{"scope":"exact_pool"}'] });
  const system = messages[0]!.content;
  const user = messages[1]!.content;
  assert.ok(system.includes(TRADFI_DOCTRINE));
  assert.ok(system.includes(String(TRADFI_COST_BAND_BPS)));
  assert.ok(system.includes("hold is the default answer"));
  assert.equal(user.includes("exact_pool"), false);
  assert.ok(user.includes("peakPnlBps\ttrigger\tsession\tregime\tindicators"));
  assert.ok(user.includes("+300 (gain)\tpeak-giveback\trth\tneutral\t1h EMA12 below EMA26"));
});

test("non-tradfi exit keeps the JSON feature block and the generic system text", () => {
  const messages = buildExitPrompt({ timeLimitAuthority: true, owner: OWNER, positions: [position()],
    featureBlocks: ['{"scope":"exact_pool"}'] });
  const system = messages[0]!.content;
  const user = messages[1]!.content;
  assert.ok(system.includes("Decide only whether"));
  assert.ok(user.includes("exact_pool"));
  assert.equal(user.includes("peakPnlBps\ttrigger\tsession\tregime\tindicators"), false);
});

test("tradfi exit still appends CMC global/macro lines via newsBlocks when available", () => {
  const messages = buildExitPrompt({ tradfi: true, owner: OWNER, positions: [position()],
    newsBlocks: ["cmc-global: risk_on mcap24h=+5.4%"] });
  assert.ok(messages[1]!.content.includes("cmc-global: risk_on"));
});

test("tradfi exit rows label the PnL sign in words (a +335 gain was read as a loss on 2026-09-24); non-tradfi rows are unchanged", () => {
  const tradfi = buildExitPrompt({ tradfi: true, timeLimitAuthority: true, owner: OWNER,
    positions: [position({ pnlBps: 335n, peakPnlBps: 400n }), position({ pnlBps: -120n, peakPnlBps: 0n })] });
  assert.ok(tradfi[0]!.content.includes("never call a gain a loss"));
  assert.ok(tradfi[1]!.content.includes("\t+335 (gain)\t"));
  assert.ok(tradfi[1]!.content.includes("\t+400 (gain)\t"));
  assert.ok(tradfi[1]!.content.includes("\t-120 (loss)\t"));
  assert.ok(tradfi[1]!.content.includes("\t0 (flat)\t"));
  const plain = buildExitPrompt({ timeLimitAuthority: true, owner: OWNER, positions: [position({ pnlBps: 335n })] });
  assert.equal(plain[1]!.content.includes("(gain)"), false);
  assert.ok(plain[1]!.content.includes("\t335\t"));
});

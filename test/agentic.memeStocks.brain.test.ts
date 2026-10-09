/** AGENTIC-MEME-STOCKS-SPEC section 6, 7.3, 10 brain: the pure brain at its boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { MEME_GAS_WEI, memeBurst, memeBurstVerdict, memeCostEstBps, memeCostRuleOk, memeDeadChart, memeDeadVeto, memeExit, memeLiqCapWei, memePick, memePnlBps, memePressure,
  memeScreenShared, parseMemeAnswer, type MemeExitInput } from "../src/agentic/memeBrain.js";
import { parseShortlistRow, type MemeBar } from "../src/agentic/memeData.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { NOW } from "./support/agenticSchedule.js";
import { BSTOCK, MEME, QUOTE, shortlistRow } from "./support/agenticMeme.js";

const E = 10n ** 18n;
/** 20 one-minute bars, flat at 1 with a 2 % range (never flat by range), volume `base`, the burst bar at L-1 (`burst`) and L (`last`); `patch` edits single bars. */
function series(input: { base?: number; burst?: number; last?: number; lastClose?: number; prevClose?: number; filledBase?: boolean } = {}): MemeBar[] {
  const bars: MemeBar[] = Array.from({ length: 20 }, (_, i) => ({ startMs: NOW + i * 60_000, open: 1, high: 1.02, low: 0.99, close: 1.01, volume: input.base ?? 100, filled: false }));
  if (input.filledBase === true) for (let i = 13; i <= 17; i += 1) bars[i] = { ...bars[i]!, volume: 0, filled: true, open: 1.01, high: 1.01, low: 1.01, close: 1.01 };
  if (input.prevClose !== undefined) bars[17] = { ...bars[17]!, close: input.prevClose, high: Math.max(1.02, input.prevClose) };
  bars[18] = { ...bars[18]!, open: 1, close: 1.05, high: 1.06, volume: input.burst ?? 1_000 };
  const close = input.lastClose ?? 1.06;
  bars[19] = { ...bars[19]!, open: 1.05, close, high: Math.max(close, 1.05) * 1.01, low: Math.min(close, 1.05) * 0.99, volume: input.last ?? 400 };
  return bars;
}

test("6.3 burst: 2.99x / 3.00x, $499 / $500, a silent base, follow-through $249 / $250 and 1.49x / 1.5x, extension 1.6x / 1.61x", () => {
  assert.equal(memeBurst(series({ base: 200, burst: 598 })).reason, "volume");
  assert.equal(memeBurst(series({ base: 200, burst: 600, last: 400 })).reason, null);
  assert.equal(memeBurst(series({ base: 100, burst: 499 })).reason, "volume");
  assert.equal(memeBurst(series({ base: 100, burst: 500 })).reason, null);
  assert.equal(memeBurst(series({ filledBase: true })).reason, "silent-base");
  assert.equal(memeBurst(series({ base: 100, last: 249 })).reason, "follow-volume");
  assert.equal(memeBurst(series({ base: 100, last: 250 })).reason, null);
  assert.equal(memeBurst(series({ base: 200, burst: 1_000, last: 298 })).reason, "follow-volume");
  assert.equal(memeBurst(series({ base: 200, burst: 1_000, last: 300 })).reason, null);
  assert.equal(memeBurst(series({ lastClose: 1.04 })).reason, "follow-price", "c[L] below c[t]");
  assert.equal(memeBurst(series({ prevClose: 1, lastClose: 1.6 })).reason, null, "exactly 1.6 x c[t-1]");
  assert.equal(memeBurst(series({ prevClose: 1, lastClose: 1.61 })).reason, "extended");
  const passed = memeBurst(series());
  assert.deepEqual([passed.offset, passed.burstRatio, passed.followRatio], [1, 10, 4]);
  assert.deepEqual([memeBurstVerdict("volume"), memeBurstVerdict("follow-price"), memeBurstVerdict("extended"), memeBurstVerdict(null)], ["no-burst", "no-follow-through", "extended", null]);
});

test("6.2 dead chart: deadScore 69 / 70 at the veto, filled bars count as flatline, each hardVeto branch", () => {
  assert.equal(memeDeadVeto({ hardVeto: false, deadScore: 69.9 }), false);
  assert.equal(memeDeadVeto({ hardVeto: false, deadScore: 70 }), true);
  const filled = series().map((bar, i) => i >= 10 ? { ...bar, filled: true } : bar);
  const flat = memeDeadChart(filled);
  assert.deepEqual([flat.flatline, flat.hardVeto], [10, true]);
  // A collapse: a 2.0 high, then 10 falling low-volume bars ending at 0.6 (drawdown 70 %, decay <= 0.2, lower highs).
  const collapse = (step: number): MemeBar[] => Array.from({ length: 40 }, (_, i) => {
    if (i < 30) return { startMs: NOW + i * 60_000, open: 1.9, high: i === 29 ? 2 : 1.95, low: 1.85, close: 1.9, volume: 1_000, filled: false };
    const price = 1.8 - (i - 30) * step;
    return { startMs: NOW + i * 60_000, open: price + 0.05, high: price + 0.06, low: price - 0.05, close: price, volume: 10, filled: false };
  });
  const dead = memeDeadChart(collapse(0.13));
  assert.ok(dead.drawdown60 >= 65 && dead.decay <= 0.2 && dead.lowerHighs10 >= 3 && dead.hardVeto, JSON.stringify(dead));
  assert.ok(dead.deadScore >= 70);
  // The impulse branch alone: a 64 % drawdown 10 minutes after the high on decayed volume with lower lows.
  const impulse = memeDeadChart(collapse(0.12));
  assert.ok(impulse.drawdown60 < 65 && impulse.impulseFailure && impulse.lowerLows10 >= 3 && impulse.hardVeto, JSON.stringify(impulse));
  const healthy = memeDeadChart(series());
  assert.deepEqual([healthy.hardVeto, memeDeadVeto(healthy)], [false, false]);
});

test("6.4 pressure: buys 2x sells; smart vetoes -0.01 at 5m, -249 / -250 at 1h; unranked neutral", () => {
  const row = (patch: Record<string, unknown>) => parseShortlistRow(shortlistRow(NOW, patch))!;
  assert.equal(memePressure(row({ flow5m: { buys: 20, sells: 10 } })), null);
  assert.equal(memePressure(row({ flow5m: { buys: 19, sells: 10 } })), "pressure");
  assert.equal(memePressure(row({ smartInflow5m: { netUsd: -0.01, traders: 1, rank: 2, rankedAt: NOW } })), "smart-veto");
  assert.equal(memePressure(row({ smartInflow1h: { netUsd: -249, traders: 1, rank: 2, rankedAt: NOW } })), null);
  assert.equal(memePressure(row({ smartInflow1h: { netUsd: -250, traders: 1, rank: 2, rankedAt: NOW } })), "smart-veto");
  assert.equal(memePressure(row({ smartInflow5m: null, smartInflow1h: null })), null);
});

test("6.1 anchors and screen: USDT, the quote token and a bStock-universe token are refused; flow unknown; halted; graduating", () => {
  const screen = (patch: Record<string, unknown>) => memeScreenShared(parseShortlistRow(shortlistRow(NOW, patch))!, { bstocks: new Set([BSTOCK]), minEntryWei: 10n * E, nowMs: NOW });
  assert.equal(screen({}), null);
  assert.equal(screen({ address: USDT_56 }), "usdt");
  assert.equal(screen({ address: QUOTE }), "quote-token");
  assert.equal(screen({ address: BSTOCK }), "bstock");
  assert.equal(screen({ flow5m: null }), "flow-unknown");
  assert.equal(screen({ quote: { address: QUOTE, kind: "bstock", symbol: "Q", stock: { openState: false } } }), "quote-halted");
  assert.equal(screen({ quote: { address: QUOTE, kind: "bstock", symbol: "Q", stock: null } }), "quote-halted", "unread is never assumed open");
  assert.equal(screen({ stage: "graduating" }), "graduating");
  assert.equal(screen({ launchpad: "pumpfun" }), "launchpad");
  assert.equal(screen({ launchpad: "fourmeme" }), null, "operator hotfix 2026-10-06: graduated Four.meme passes the screen");
  assert.equal(screen({ launchpad: "fourmeme", venue: "fourmeme-bonding" }), null, "FOURMEME-CURVE-PAPER-SPEC F1: a curve row with a tax passes the screen");
  assert.equal(screen({ launchpad: "fourmeme", venue: null }), "fourmeme-venue", "an unread venue is never assumed graduated");
  assert.equal(screen({ launchpad: "fourmeme", tax: null }), "tax-unknown");
  assert.equal(screen({ tax: null }), "tax-unknown");
  assert.equal(screen({ flags: ["wash_trading"] }), "flag");
  assert.equal(screen({ liquidityUsd: 1_999 }), "liquidity", "0.50 % cap: 10 USDT needs 2 000 USD of liquidity"); assert.notEqual(screen({ liquidityUsd: 2_000 }), "liquidity");
  assert.equal(screen({ address: MEME as Address }), null);
});

test("7.3 vectors: C_est 1 066 (graduated) and 622 (curve) at P_BNB 717; liquidity caps; cost rule 2C - 1 / 2C", () => {
  const gas = (venue: keyof typeof MEME_GAS_WEI) => (MEME_GAS_WEI[venue].buy + MEME_GAS_WEI[venue].sell) * 717n;
  assert.equal(memeCostEstBps({ venue: "pancake-v2", tax: { buyBps: 300, sellBps: 500 }, liquidityUsd: 16_620, amountWei: 10n * E, gasRoundTripUsdtAtomic: gas("pancake-v2") }), 1_066);
  assert.equal(memeCostEstBps({ venue: "flap-bonding", tax: { buyBps: 0, sellBps: 100 }, liquidityUsd: 5_013, amountWei: 10n * E, gasRoundTripUsdtAtomic: gas("flap-bonding") }), 622);
  assert.equal(memeCostEstBps({ venue: "pancake-v2", tax: null, liquidityUsd: 16_620, amountWei: 10n * E, gasRoundTripUsdtAtomic: 1n }), null, "unknown tax: no estimate");
  assert.equal(memeLiqCapWei(16_620), 83_100_000_000_000_000_000n);
  assert.equal(memeLiqCapWei(5_013), 25_065_000_000_000_000_000n);
  assert.equal(memeLiqCapWei(4_139), 20_695_000_000_000_000_000n);
  assert.deepEqual([memeCostRuleOk(2_131, 1_066), memeCostRuleOk(2_132, 1_066), memeCostRuleOk(null, 1), memeCostRuleOk(5_000, null)], [false, true, false, false]);
});

test("6.6 exits: X2 -3 000 / -2 999 beyond cost, X5 armed at 1 000 with giveback max(500, 30 %) (operator 2026-10-09), X8 at 14 400 000 ms, first match, no X7", () => {
  const x = (patch: Partial<MemeExitInput>): string | null => memeExit({ drain: false, pnlBps: 0, peakBps: 0, costBps: 1_000, ageMs: 0, hardVeto: null, board: null, ...patch });
  assert.equal(x({ pnlBps: -4_000 }), "stop");
  assert.equal(x({ pnlBps: -3_999 }), null);
  assert.equal(x({ peakBps: 999, pnlBps: 0 }), null, "not armed");
  assert.equal(x({ peakBps: 1_000, pnlBps: 500 }), "trailing", "30 % of 1 000 = 300 < 500, so the 500 floor");
  assert.equal(x({ peakBps: 1_000, pnlBps: 501 }), null);
  assert.equal(x({ peakBps: 5_000, pnlBps: 5_000 - 1_500 }), "trailing", "30 % of 5 000 = 1 500 > 500");
  assert.equal(x({ peakBps: 5_000, pnlBps: 5_000 - 1_499 }), null);
  assert.equal(x({ peakBps: 20_000, pnlBps: 14_000 }), "trailing");
  assert.equal(x({ peakBps: 20_000, pnlBps: 14_001 }), null);
  assert.equal(x({ ageMs: 14_399_999 }), null);
  assert.equal(x({ ageMs: 14_400_000 }), "time");
  assert.equal(x({ drain: true, pnlBps: -9_000, ageMs: 99_999_999 }), "drain", "X1 first");
  assert.equal(x({ pnlBps: -5_000, hardVeto: true }), "stop", "X2 before X3");
  assert.equal(x({ hardVeto: true, ageMs: 99_999_999 }), "dead-chart", "X3 before X8");
  const board = { status: "runner", flags: [] as string[], inflow5mNetUsd: null, flow5m: { buys: 1, sells: 2 } };
  assert.equal(x({ board: { ...board, status: "dead" } }), "dead-chart");
  assert.equal(x({ board: { ...board, inflow5mNetUsd: -100 } }), "smart-out");
  assert.equal(x({ board: { ...board, inflow5mNetUsd: -99 } }), null, "flow flip needs PnL < 0");
  assert.equal(x({ board, pnlBps: -1 }), "flow-flip");
  assert.equal(x({ pnlBps: 100, ageMs: 900_000 }), null, "no X7 (no follow-through exit)");
  assert.deepEqual([memePnlBps(9_000n, 10_000n), memePnlBps(10_001n, 10_000n), memePnlBps(9_999n, 10_000n)], [-1_000, 1, -1]);
});

test("6.7 answer: closed schema, confidence 74 / 75, ties by index", () => {
  assert.equal(parseMemeAnswer('{"decisions":[{"index":0,"action":"buy_now","confidence":80,"x":1}]}', 1), null);
  assert.equal(parseMemeAnswer('{"decisions":[{"index":0,"action":"buy","confidence":80}]}', 1), null);
  assert.equal(parseMemeAnswer('{"decisions":[],"extra":1}', 1), null);
  assert.equal(memePick(parseMemeAnswer('{"decisions":[{"index":0,"action":"buy_now","confidence":74}]}', 1)!), null);
  assert.equal(memePick(parseMemeAnswer('```json\n{"decisions":[{"index":1,"action":"buy_now","confidence":75},{"index":0,"action":"buy_now","confidence":75}]}\n```', 2)!), 0);
});

test("audit F-E: the answer fence is the trade lane's (```json, newline, body, newline, ```); a bare ``` fence or an inline fence is no entry", () => {
  const body = '{"decisions":[{"index":0,"action":"buy_now","confidence":80}]}';
  assert.notEqual(parseMemeAnswer("```json\n" + body + "\n```", 1), null);
  assert.equal(parseMemeAnswer("```\n" + body + "\n```", 1), null);
  assert.equal(parseMemeAnswer("```json " + body + "```", 1), null);
});

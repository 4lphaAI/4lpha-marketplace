/** AGENTIC-MEME-STOCKS-SPEC section 5, 10 data: parsers, unknown keys, freshness boundaries, eligibility keying, token version. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { barLagMs, barsEntryOk, barsExitOk, eligibilityFresh, parseBars, parseBarsElement, parseBoardRow, parseEligibility, parseShortlist, parseShortlistRow, rowFresh, shortlistFresh,
  MEME_ENTRY_BAR_LAG_MAX_MS } from "../src/agentic/memeData.js";
import { NOW } from "./support/agenticSchedule.js";
import { MEME, eligibilityRow, passingBars, shortlistRow } from "./support/agenticMeme.js";

const element = (patch: Record<string, unknown> = {}, bars = passingBars(NOW)) => ({ address: MEME, tracked: true, symbol: "X", source: "sintral", unit: "usd", asOf: NOW, staleness: "fresh",
  lastClosedStartMs: bars.at(-1)!.startMs, bars, extra: 1, ...patch });

test("shortlist: the reply example parses with unknown keys ignored; each wrong required field refuses the row", () => {
  const row = parseShortlistRow(shortlistRow(NOW))!;
  assert.equal(row.address, MEME);
  assert.equal(Object.hasOwn(row, "unknownKey"), false);
  for (const [key, value] of [["address", "0x12"], ["launchpad", 1], ["stage", null], ["status", undefined], ["quote", null], ["liquidityUsd", "1"], ["flags", "x"], ["observedAt", "now"],
    ["flow5m", { buys: "1", sells: 1 }], ["smartInflow1h", { traders: 1 }], ["tax", { buyBps: 300 }]] as const) {
    assert.equal(parseShortlistRow(shortlistRow(NOW, { [key]: value })), null, key);
  }
  assert.equal(parseShortlistRow(shortlistRow(NOW, { quote: { address: "0x1", kind: "bstock", stock: null } })), null);
  assert.equal(parseShortlistRow(shortlistRow(NOW, { symbol: "a\u0000b".repeat(20) }))!.symbol!.length, 32, "display symbol: control characters stripped, 32 characters");
  const envelope = parseShortlist({ data: [shortlistRow(NOW), { bad: 1 }], meta: { staleness: "fresh", asOf: NOW, boardTotal: 9, candidates: { flap: 2, fourmeme: 0 }, picked: { flap: 1, fourmeme: 0 } } })!;
  assert.deepEqual([envelope.rows.length, envelope.invalid, envelope.boardTotal], [1, 1, 9]);
  assert.equal(parseShortlist({ data: [], meta: { staleness: "fresh" } }), null, "meta.asOf required");
});

test("freshness boundaries 180 000 / 180 001 ms: envelope, row observation and smart-money rank", () => {
  const s = parseShortlist({ data: [], meta: { staleness: "fresh", asOf: NOW } })!;
  assert.deepEqual([shortlistFresh(s, NOW + 180_000), shortlistFresh(s, NOW + 180_001)], [true, false]);
  const row = parseShortlistRow(shortlistRow(NOW, { observedAt: NOW }))!;
  assert.deepEqual([rowFresh(row, NOW + 180_000), rowFresh(row, NOW + 180_001)], [true, false]);
  const ranked = parseShortlistRow(shortlistRow(NOW, { observedAt: NOW + 100_000, smartInflow5m: { netUsd: 5, traders: 1, rank: 3, rankedAt: NOW } }))!;
  assert.deepEqual([rowFresh(ranked, NOW + 180_000), rowFresh(ranked, NOW + 180_001)], [true, false]);
});

test("bars: the reply example with the filled key parses; every rule refuses; lag boundaries; tracked false and fewer than 15 bars refuse entries only", () => {
  const ok = parseBarsElement(element(), MEME)!;
  assert.equal(ok.bars.length, 20);
  const bars = passingBars(NOW);
  const broken: Record<string, unknown>[] = [{ address: "0x" + "9".repeat(40) }, { source: "okx" }, { unit: "token" }, { tracked: "yes" }, { lastClosedStartMs: bars.at(-1)!.startMs - 60_000 },
    { bars: [...bars.slice(0, 5), ...bars.slice(6)] }, { bars: [{ ...bars[0]!, high: 0.1 }, ...bars.slice(1)] }, { bars: [{ ...bars[0]!, filled: "no" }, ...bars.slice(1)] },
    { bars: [{ ...bars[0]!, volume: -1 }, ...bars.slice(1)] }];
  for (const patch of broken) assert.equal(parseBarsElement(element(patch), MEME), null, JSON.stringify(patch).slice(0, 40));
  const at = (lag: number) => parseBarsElement(element({}, passingBars(NOW, lag)), MEME)!;
  assert.equal(barLagMs(at(120_000), NOW), 120_000);
  assert.equal(MEME_ENTRY_BAR_LAG_MAX_MS, 120_000);
  assert.deepEqual([barsEntryOk(at(120_000), NOW), barsEntryOk(at(120_001), NOW)], [true, false]);
  assert.deepEqual([barsExitOk(at(300_000), NOW), barsExitOk(at(300_001), NOW)], [true, false]);
  const untracked = parseBarsElement(element({ tracked: false }), MEME)!;
  assert.deepEqual([barsEntryOk(untracked, NOW), barsExitOk(untracked, NOW)], [false, true]);
  const short = parseBarsElement(element({}, passingBars(NOW, 120_000, 14)), MEME)!;
  assert.deepEqual([barsEntryOk(short, NOW), barsExitOk(short, NOW)], [false, true]);
  const batch = parseBars({ data: [element(), element({ source: "x" }, passingBars(NOW))], meta: {} }, [MEME, MEME])!;
  assert.equal(batch.size, 1);
  assert.equal(parseBars({ data: [element()] }, [MEME, "0x" + "1".repeat(40) as Address]), null, "one element per request");
});

test("board row: required fields and exit freshness", () => {
  const row = parseBoardRow({ data: { status: "runner", flags: ["smart_exit"], flow5m: { buys: 1, sells: 3 }, smartMoney: { inflow5m: { netUsd: -120, traders: 2, rank: 1, rankedAt: NOW } },
    venue: "pancake-v2", tax: { buyBps: 0, sellBps: 100 }, activity: { observedAt: NOW }, other: true }, meta: { staleness: "fresh" } })!;
  assert.equal(row.smartInflow5mNetUsd, -120);
  assert.equal(parseBoardRow({ data: { flags: [] } }), null);
});

test("eligibility: keyed by address with 50 addresses and duplicates collapsed; numeric status and tokenVersion; 60 000 / 60 001 ms freshness", () => {
  const rows = Array.from({ length: 50 }, (_, i) => eligibilityRow(NOW, { address: "0x" + (i + 1).toString(16).padStart(40, "0"), checkedAt: NOW }));
  const parsed = parseEligibility({ data: [...rows.reverse(), rows[0]], meta: {} })!;
  assert.equal(parsed.size, 50);
  const one = parsed.get("0x" + "1".padStart(40, "0"))!;
  assert.deepEqual([one.flap!.status, one.flap!.tokenVersion, one.flap!.progress], [4, 6, 10n ** 18n]);
  assert.deepEqual([eligibilityFresh(one, NOW + 60_000), eligibilityFresh(one, NOW + 60_001)], [true, false]);
  for (const flap of [{ status: "4" }, { tokenVersion: "6" }, { progress: 1 }, { buyTaxBps: 10_001 }]) assert.equal(parseEligibility({ data: [eligibilityRow(NOW, {}, flap)] })!.size, 0, JSON.stringify(flap));
});

/** FOURMEME-CURVE-PAPER-SPEC section 8.1: the Four.meme bonding curve in the paper lane, over the offline meme world (fake data plane, fake Binance quotes, fake LLM, fake clock). */
import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { MEME_GAS_WEI, memeCostEstBps, memeGasBps, memeQuoteOmitsTax, memeScreenShared, memeVenue } from "../src/agentic/memeBrain.js";
import { parseEligibility, parseShortlistRow } from "../src/agentic/memeData.js";
import { runAgenticMemeStep } from "../src/agentic/memeLane.js";
import { agenticUiString, projectAgenticSessionFacts } from "../src/agentic/domain.js";
import { executeAgenticTrade } from "../src/agentic/execute.js";
import { AGENTIC_DDL } from "../src/agentic/store.js";
import type { BawResult } from "../src/agentic/baw.js";
import { E, HASH, NOW } from "./support/agenticSchedule.js";
import { BSTOCK, MEME, QUOTE, eligibilityRow, memeWorld, paperRow, passingBars, shortlistRow, type MemeWorld } from "./support/agenticMeme.js";

const MAX_2000 = "2000000000000000000000";
const step = async (world: MemeWorld) => runAgenticMemeStep(world.deps(), (await world.f.store.byAgent(world.agentId))!);
const logs = async (world: MemeWorld, kind: string) => (await world.f.store.memeLog(null, 0, Number.MAX_SAFE_INTEGER)).filter(r => r.kind === kind);
const ok = (amount: bigint): BawResult => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "X", fromCoinAmount: "1", toCoinSymbol: "Y", toCoinAmount: agenticUiString(amount), slippage: "0.04" } });
/** 6.4 vector: hehecat-shaped, 3 / 3 tax, 10 USDT buys Qb tokens (the tax omitted from the quote), N sells for Qs. */
const QB = 2_555_366_574_000_000_000_000_000n, N = QB * 9_700n / 10_000n, QS = 9_321_700_000_000_000_000n;
const GAS_BUY = 130_600_000_000_000n * 717n;

/** A Four.meme curve world: a `fourmeme-bonding` shortlist row with its tax and an eligibility row with the curve's funds. */
async function curveWorld(t: Parameters<typeof memeWorld>[0], options: { row?: Record<string, unknown>; fm?: Record<string, unknown>; eligibility?: Record<string, unknown> } = {}): Promise<MemeWorld> {
  const world = await memeWorld(t);
  world.plane.rows = [shortlistRow(world.clock.now, { launchpad: "fourmeme", venue: "fourmeme-bonding", tax: { buyBps: 300, sellBps: 300 }, ...options.row })];
  world.plane.eligibility = [eligibilityRow(world.clock.now, { source: "fourmeme", reason: "fourmeme_factory", venue: "fourmeme-bonding", flap: null,
    fourmeme: { version: 2, tokenManager: "0x5c952063c7fc8610ffdb798152d69f0b9550762b", quote: QUOTE, launchTime: 0, liquidityAdded: false, funds: "1000000000000000000000", maxFunds: MAX_2000, ...options.fm },
    ...options.eligibility })];
  world.market.buyAnswer = ok(QB);
  world.market.sellAnswer = ok(QS);
  return world;
}

test("8.1.1 screen (F7, F8): a curve row with a tax passes, an unread or Flap venue on a Four.meme row is fourmeme-venue, and the graduating label exempts only the Four.meme curve", () => {
  const screen = (patch: Record<string, unknown>) => memeScreenShared(parseShortlistRow(shortlistRow(NOW, patch))!, { bstocks: new Set([BSTOCK]), minEntryWei: 10n * E, nowMs: NOW });
  const curve = { launchpad: "fourmeme", venue: "fourmeme-bonding" };
  assert.equal(screen(curve), null);
  assert.equal(screen({ ...curve, tax: null }), "tax-unknown");
  assert.equal(screen({ launchpad: "fourmeme", venue: null }), "fourmeme-venue");
  assert.equal(screen({ launchpad: "fourmeme", venue: "flap-bonding" }), "fourmeme-venue");
  assert.equal(screen({ ...curve, stage: "graduating" }), null);
  assert.equal(screen({ launchpad: "flap", venue: "flap-bonding", stage: "graduating" }), "graduating");
  assert.equal(screen({ launchpad: "flap", venue: "pancake-v2", stage: "graduating" }), "graduating");
  assert.equal(screen({ launchpad: "flap", venue: "fourmeme-bonding", stage: "graduating" }), "graduating", "the exemption keys on the launchpad too");
  assert.equal(screen({ launchpad: "fourmeme", venue: "pancake-v2", stage: "graduating" }), "graduating");
});

test("8.1.1 lane: a graduating-labelled curve row with funds at 50 % enters; at exactly 80 % the funds rule, not the label, refuses it", async (t) => {
  const entered = await curveWorld(t, { row: { stage: "graduating" }, fm: { funds: "1000000000000000000000" } });
  assert.equal((await step(entered)).report.code, "meme-entered");
  const refused = await curveWorld(t, { row: { stage: "graduating" }, fm: { funds: "1600000000000000000000" } });
  assert.equal((await step(refused)).report.code, "meme-veto:curve-funds");
});

test("8.1.2 venue and gas: the memeVenue table, the Four.meme gas pair, the tax predicate, gas bps 184 / 142 / 91 and C_est 1 164 / 709", () => {
  assert.deepEqual(["fourmeme-bonding", "pancake-v2", "flap-bonding", null, "x"].map(v => memeVenue(v)), ["fourmeme-bonding", "pancake-v2", "flap-bonding", "flap-bonding", "flap-bonding"]);
  assert.deepEqual(MEME_GAS_WEI["fourmeme-bonding"], { buy: 130_600_000_000_000n, sell: 125_900_000_000_000n });
  assert.deepEqual([memeQuoteOmitsTax("fourmeme-bonding"), memeQuoteOmitsTax("pancake-v2"), memeQuoteOmitsTax("flap-bonding")], [true, true, false]);
  const round = (venue: string) => { const g = MEME_GAS_WEI[memeVenue(venue)]; return (g.buy + g.sell) * 717n; };
  const amountWei = 10n * E;
  assert.deepEqual(["fourmeme-bonding", "flap-bonding", "pancake-v2"].map(v => memeGasBps(round(v), amountWei)), [184, 142, 91]);
  const est = (tax: number, liquidityUsd: number) => memeCostEstBps({ venue: "fourmeme-bonding", tax: { buyBps: tax, sellBps: tax }, liquidityUsd, amountWei, gasRoundTripUsdtAtomic: round("fourmeme-bonding") });
  assert.deepEqual([est(300, 5_013), est(100, 16_620)], [1_164, 709]);
});

test("8.1.3 eligibility (FC2): the full fixture enters; each single change refuses with its code; the signal carries funds and maxFunds on the curve only", async (t) => {
  const world = await curveWorld(t);
  assert.equal((await step(world)).report.code, "meme-entered");
  const p = (await world.f.store.paperOpen(world.agentId))[0]!;
  assert.deepEqual([p.venueEntry, p.tokenVersion, p.buyTaxBps, p.sellTaxBps], ["fourmeme-bonding", 2, 300, 300]);
  const signal = (await logs(world, "signal"))[0]!.data as Record<string, unknown>;
  assert.deepEqual([signal["funds"], signal["maxFunds"]], ["1000000000000000000000", MAX_2000]);
  const cases: [string, Parameters<typeof curveWorld>[1], string][] = [
    ["liquidityAdded true", { fm: { liquidityAdded: true } }, "meme-veto:eligibility"],
    ["quote differs", { fm: { quote: "0x" + "ef".repeat(20) } }, "meme-veto:eligibility"],
    ["source flap with a Four.meme block", { eligibility: { source: "flap" } }, "meme-veto:eligibility"],
    ["shortlist row pancake-v2", { row: { venue: "pancake-v2" } }, "meme-veto:eligibility"],
    ["version 3", { fm: { version: 3 } }, "meme-veto:token-version"],
    ["funds 1.6e21 - 1", { fm: { funds: "1599999999999999999999" } }, "meme-entered"],
    ["funds 1.6e21", { fm: { funds: "1600000000000000000000" } }, "meme-veto:curve-funds"],
    ["maxFunds 80e18, funds 64e18 - 1", { fm: { funds: "63999999999999999999", maxFunds: "80000000000000000000" } }, "meme-entered"],
    ["maxFunds 80e18, funds 64e18", { fm: { funds: "64000000000000000000", maxFunds: "80000000000000000000" } }, "meme-veto:curve-funds"],
    ["maxFunds 0", { fm: { maxFunds: "0" } }, "meme-veto:curve-funds"],
    ["funds absent", { fm: { funds: undefined } }, "meme-veto:curve-funds"],
    ["funds a JSON number", { fm: { funds: 1000 } }, "meme-veto:curve-funds"],
    ["funds hex", { fm: { funds: "0x10" } }, "meme-veto:curve-funds"],
  ];
  for (const [name, options, code] of cases) {
    const w = await curveWorld(t, options);
    assert.equal((await step(w)).report.code, code, name);
  }
  const stale = await curveWorld(t);
  stale.plane.eligibility = [{ ...stale.plane.eligibility![0]!, checkedAt: stale.clock.now - 60_001 }];
  assert.equal((await step(stale)).report.code, "meme-data:eligibility");
  const refused = await curveWorld(t, { fm: { funds: "1600000000000000000000" } });
  await step(refused);
  const veto = (await logs(refused, "signal"))[0]!.data as Record<string, unknown>;
  assert.deepEqual([veto["verdict"], veto["funds"], veto["maxFunds"]], ["curve-funds", "1600000000000000000000", MAX_2000]);
  // A Flap signal and a graduated Four.meme signal carry neither key.
  const flap = await memeWorld(t);
  await step(flap);
  const grad = await memeWorld(t);
  grad.plane.rows = [shortlistRow(grad.clock.now, { launchpad: "fourmeme", tax: { buyBps: 0, sellBps: 0 } })];
  grad.plane.eligibility = [eligibilityRow(grad.clock.now, { source: "fourmeme", reason: "fourmeme_factory", flap: null,
    fourmeme: { version: 2, quote: QUOTE, launchTime: 0, liquidityAdded: true, funds: "1999999999999079999260", maxFunds: MAX_2000 } })];
  assert.equal((await step(grad)).report.code, "meme-entered", "review M8: a graduated pick near 99.99995 % of maxFunds is not a curve refusal");
  for (const w of [flap, grad]) {
    const keys = Object.keys((await logs(w, "signal"))[0]!.data as object);
    assert.ok(!keys.includes("funds") && !keys.includes("maxFunds"), keys.join());
  }
});

test("8.1.4 parser: a block without funds / maxFunds keeps the row with both null; malformed values are null; a value above 2^53 round-trips", () => {
  const parse = (fm: Record<string, unknown>) => parseEligibility({ data: [eligibilityRow(NOW, { source: "fourmeme", flap: null, fourmeme: { version: 2, quote: QUOTE, liquidityAdded: false, ...fm } })] })!.get(MEME)!.fourmeme!;
  assert.deepEqual([parse({}).funds, parse({}).maxFunds], [null, null]);
  for (const bad of ["abc", 1000, "1".repeat(79), "0x10", "-1", ""]) assert.equal(parse({ funds: bad }).funds, null, String(bad));
  assert.equal(parse({ funds: "9007199254740993" }).funds, 9_007_199_254_740_993n);
  assert.equal(parse({ maxFunds: MAX_2000 }).maxFunds, 2_000n * E);
});

test("8.1.5 COST_MEAS (6.4 vector): both taxes netted on the curve, the sell quote asked for exactly N, C_meas 1 141, gas 93 640 200 000 000 000", async (t) => {
  const world = await curveWorld(t);
  assert.equal((await step(world)).report.code, "meme-entered");
  assert.equal(N, 2_478_705_576_780_000_000_000_000n);
  const p = (await world.f.store.paperOpen(world.agentId))[0]!;
  assert.deepEqual([p.tokens, p.costBps, p.gasBuyUsdt, p.entryUsdt], [N.toString(), 1_141, GAS_BUY.toString(), (10n * E).toString()]);
  assert.equal(GAS_BUY, 93_640_200_000_000_000n);
  assert.deepEqual(world.market.quotes.map(q => q.side), ["buy", "sell"]);
  assert.equal(world.market.quotes[1]!.qty, agenticUiString(N));
  const signal = (await logs(world, "signal"))[0]!.data as Record<string, unknown>;
  assert.deepEqual([signal["s"], signal["cMeas"]], ["9042049000000000000", 1_141]);
  // C_est of the curve row at 16 620 USD and 3 / 3 is 100 + 200 + 600 + 25 + 184 (the market log's brain tuple).
  const market = (await logs(world, "market"))[0]!.data as { rows: [unknown[], unknown[]][] };
  assert.equal(market.rows[0]![1]![13], 1_109);
});

/** A paper position the 6.4 entry would have written. */
const curvePaper = (world: MemeWorld) => paperRow(world, { venueEntry: "fourmeme-bonding", buyTaxBps: 300, sellTaxBps: 300, tokenVersion: 2, tokens: N.toString(), gasBuyUsdt: GAS_BUY.toString(), costBps: 1_141 });
const boardRow = (world: MemeWorld, patch: Record<string, unknown>) => ({ status: "runner", flags: [], flow5m: { buys: 30, sells: 10, uniqueTraders: 25, inflowUsd: 300 }, smartMoney: { inflow5m: null },
  activity: { observedAt: world.clock.now - 1_000 }, ...patch });
const markOf = async (world: MemeWorld) => ((await logs(world, "mark")).at(-1)!.data as Record<string, unknown>);

test("8.1.6 marks and graduation while held, end to end (the offline half of G2)", async (t) => {
  const world = await curveWorld(t);
  assert.equal((await step(world)).report.code, "meme-entered");
  world.plane.down.add("memeShortlist");
  const cycle = async () => { await world.at(world.clock.now + 60_000); world.plane.bars.set(MEME, { bars: passingBars(world.clock.now) }); return step(world); };
  const open = async () => (await world.f.store.paperList(world.agentId))[0]!;
  // Cycle 1: the curve mark, fresh board fourmeme-bonding {300, 300}.
  world.plane.board.set(MEME, boardRow(world, { venue: "fourmeme-bonding", tax: { buyBps: 300, sellBps: 300 } }));
  await cycle();
  let mark = await markOf(world);
  assert.deepEqual([mark["pnlBps"], mark["markUsdt"], mark["venue"]], [-1_042, "9042049000000000000", "fourmeme-bonding"]);
  // Cycle 2: the token migrates, the sell quote fails: a mark row with the code, mark_skips 1, no exit.
  world.market.sellAnswer = { kind: "no-response", code: "timeout", sessionPresent: true };
  await cycle();
  mark = await markOf(world);
  assert.equal(mark["code"], "meme-unreachable");
  assert.deepEqual([(await open()).markSkips, (await open()).status], [1, "open"]);
  // Cycle 3: graduated, fresh board pancake-v2 {100, 100}.
  world.market.sellAnswer = ok(QS);
  world.plane.board.set(MEME, boardRow(world, { venue: "pancake-v2", tax: { buyBps: 100, sellBps: 100 } }));
  await cycle();
  assert.equal((await open()).status, "open");
  mark = await markOf(world);
  assert.deepEqual([mark["venue"], mark["markUsdt"]], ["pancake-v2", "9228483000000000000"]);
  assert.equal(Number((await open()).peakPnlBps), -858);
  // Cycle 4: close requested, closes `drain` at the graduated mark with the entry venue's sell gas.
  await world.f.store.patchPaper(await open(), { closeRequestedAt: world.clock.now });
  await cycle();
  const closed = await open();
  assert.deepEqual([closed.status, closed.closeCode, closed.exitUsdt, closed.gasSellUsdt, closed.pnlUsdt], ["closed", "drain", "9228483000000000000", "90270300000000000", "-955427500000000000"]);
  const exit = (await logs(world, "exit"))[0]!.data as Record<string, unknown>;
  assert.deepEqual([exit["venue"], exit["sellTaxBps"]], ["pancake-v2", 100]);
});

test("8.1.6 single marks with the named fixture taxes and the curve close", async (t) => {
  const cases: [string, (w: MemeWorld) => Record<string, unknown> | null, number][] = [
    ["flap-bonding board {100, 100}: venue rejected, tax 100 from the row (F16)", w => boardRow(w, { venue: "flap-bonding", tax: { buyBps: 100, sellBps: 100 } }), -858],
    ["flap-bonding board, tax null: entry venue and tax", w => boardRow(w, { venue: "flap-bonding", tax: null }), -1_042],
    ["stale board: entry venue and tax", w => boardRow(w, { venue: "pancake-v2", tax: { buyBps: 100, sellBps: 100 }, activity: { observedAt: w.clock.now - 180_001 } }), -1_042],
  ];
  for (const [name, board, pnl] of cases) {
    const world = await memeWorld(t);
    world.plane.down.add("memeShortlist");
    await world.f.store.insertPaper(curvePaper(world));
    world.market.sellAnswer = ok(QS);
    world.plane.board.set(MEME, board(world)!);
    await step(world);
    assert.equal((await markOf(world))["pnlBps"], pnl, name);
  }
  const world = await memeWorld(t);
  world.plane.down.add("memeShortlist");
  await world.f.store.insertPaper(curvePaper(world));
  world.market.sellAnswer = ok(QS);
  world.plane.board.set(MEME, boardRow(world, { venue: "fourmeme-bonding", tax: { buyBps: 300, sellBps: 300 } }));
  await world.f.store.patchPaper((await world.f.store.paperOpen(world.agentId))[0]!, { closeRequestedAt: world.clock.now });
  await step(world);
  const closed = (await world.f.store.paperList(world.agentId))[0]!;
  assert.deepEqual([closed.closeCode, closed.pnlUsdt], ["drain", "-1141861500000000000"]);
});

test("8.1.7 store: the migration is found by content and holds exactly the two statements; the memory store holds a fourmeme-bonding row", async (t) => {
  const named = AGENTIC_DDL.filter(ddl => ddl.includes("agentic_meme_paper_venue_entry_check"));
  assert.equal(named.length, 1);
  assert.deepEqual(named[0]!.trim().split("\n").map(s => s.trim()), [
    "alter table agentic_meme_paper drop constraint if exists agentic_meme_paper_venue_entry_check;",
    "alter table agentic_meme_paper add constraint agentic_meme_paper_venue_entry_check check (venue_entry in ('flap-bonding','pancake-v2','fourmeme-bonding'));"]);
  assert.ok(AGENTIC_DDL.some(ddl => ddl.includes("venue_entry text not null check (venue_entry in ('flap-bonding','pancake-v2')),")), "the create statement is unchanged");
  const world = await memeWorld(t);
  const row = curvePaper(world);
  assert.equal(await world.f.store.insertPaper(row), true);
  const patched = await world.f.store.patchPaper(row, { lastMarkUsdt: "1" });
  assert.deepEqual([patched?.venueEntry, patched?.lastMarkUsdt], ["fourmeme-bonding", "1"]);
});

test("8.1.8 paper only (FC1): a curve entry plus a mark cycle issues only market-order quote and the executor still answers AGENTIC_MEME_PAPER", async (t) => {
  const world = await curveWorld(t);
  await step(world);
  world.plane.down.add("memeShortlist");
  await world.at(world.clock.now + 60_000);
  await step(world);
  assert.ok(world.f.runner.calls.length >= 3);
  assert.deepEqual(world.f.runner.calls.filter(args => args[0] !== "market-order" || args[1] !== "quote"), []);
  const row = (await world.f.store.byAgent(world.agentId))!;
  const input = { agent: { ...world.f.agent, sessionFacts: projectAgenticSessionFacts(row) }, idempotencyKey: HASH, paramsHash: HASH,
    request: { decisionId: "d", venue: "pancake" as const, side: "buy" as const, token: MEME as Address, amountWei: 10n ** 19n, minOutWei: 1n, quotedOutWei: 2n, settlementAsset: "USDT" as const,
      platformFeeAtomic: 0n, route: { hops: [], fees: [] } }, scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: world.f.executorDeps };
  assert.deepEqual(await executeAgenticTrade(input as unknown as Parameters<typeof executeAgenticTrade>[0], world.f.execution), { kind: "denied", status: 409, code: "AGENTIC_MEME_PAPER" });
});

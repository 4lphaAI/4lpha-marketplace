/** AGENTIC-RFQ-STOCKS 4.8-4.10 (E8, E9, E10): the entry lane, RFQ buy pricing and the exits of an RFQ-active Agentic AI agent, over the 2026-10-04 universe. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { getAddress, type Address } from "viem";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { admittedVenueRows } from "../src/trade/rwa.js";
import type { UniverseRow } from "../src/trade/dataPlaneReads.js";
import type { RfqQuoteInput, RfqQuoteResult } from "../src/trade/rfq.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeSettings } from "../src/trade/settings.js";
import { RFQ_FIXTURE_AS_OF, loadRfqUniverse } from "./support/agenticRfq.js";
import { E, WALLET, fakeRfqStocks, worldHarness, type World } from "./support/agenticRfqWorker.js";
import { underlyingDataPlane, underlyingRecord } from "./support/agenticRfqFeatures.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";

void RFQ_FIXTURE_AS_OF; void WALLET;
/** A Friday in RTH: 2026-10-02 11:45 ET. */
export const T = Date.UTC(2026, 9, 2, 15, 45, 0);
const SESSION_START = Date.UTC(2026, 9, 2, 13, 30, 0);
const PRICE = 633_500_000_000_000_000_000n;
const buyOut = (amount: bigint): bigint => amount * E / PRICE;
const sellOut = (tokens: bigint, price = PRICE): bigint => tokens * price / E;

type EntryOptions = {
  entries?: boolean; settings?: Partial<TradeSettings>; poolEvidence?: readonly string[]; underlying?: (symbol: string, interval: "15m" | "1h") => Record<string, unknown> | null;
  quote?: (call: RfqQuoteInput, index: number) => RfqQuoteResult | Promise<RfqQuoteResult>; corrected?: boolean; rfqDep?: boolean; pinSymbols?: readonly string[]; entryDecision?: unknown;
  extraDeps?: Partial<TradeWorkerDeps>;
};

async function entryWorld(t: TestContext, options: EntryOptions = {}) {
  let now = T, uuid = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  const rows = await loadRfqUniverse(options.corrected ?? true);
  const bySymbol = (symbol: string): UniverseRow => rows.find((row) => row.symbol === symbol)!;
  const rfqRows = rows.filter((row) => admittedVenueRows(row.venues).length === 0);
  const pinned = (options.pinSymbols ?? rows.map((row) => row.symbol)).map((symbol) => bySymbol(symbol).address);
  const symbolOf = (address: string): string => rows.find((row) => row.address.toLowerCase() === address.toLowerCase())!.symbol;
  const underlyingLog = { index: 0, batches: [] as Address[][] };
  const recordFor = options.underlying ?? ((symbol, interval) => symbol === "AMDB" ? underlyingRecord({ token: bySymbol(symbol).address, interval, at: now, sessionStart: SESSION_START }) : null);
  let plane: Partial<TradeWorkerDeps["dataPlane"]> = underlyingDataPlane({ tokens: rfqRows.map((row) => row.address), at: () => now, log: underlyingLog,
    record: (token, interval) => recordFor(symbolOf(token), interval) });
  for (const symbol of options.poolEvidence ?? []) {
    const row = bySymbol(symbol), evidence = strongFeatureDataPlane(row.address, row.venues?.[0]?.pool ?? getAddress("0x00000000000000000000000000000000000000d1"), now);
    const previous = plane;
    plane = { ...plane, featurePools: async () => ({ pools: [...(((await previous.featurePools?.()) as { pools: unknown[] } | undefined)?.pools ?? []), ...(await evidence.featurePools()).pools] }),
      featuresBatch: async (pools, interval) => ({ ...(await previous.featuresBatch?.(pools, interval) as object | undefined ?? {}), ...(await evidence.featuresBatch(pools, interval)) }) };
  }
  const fake = fakeRfqStocks({ entries: options.entries ?? true, rfqOnlyAtHire: rfqRows.map((row) => row.address),
    quote: options.quote ?? ((call) => call.side === "buy" ? { ok: true, outAtomic: buyOut(call.amountAtomic) } : { ok: true, outAtomic: sellOut(call.amountAtomic, PRICE - 2n * E) }) });
  const world = await worldHarness({ now: () => now, rows, custody: "binance-agentic", pinned, settings: { maxOpenPositions: 2, ...options.settings }, dataPlane: plane,
    entryDecision: options.entryDecision, extraDeps: { ...(options.rfqDep === false ? {} : { rfqStocks: fake.dep }), ...options.extraDeps } });
  const run = (extra: { dryRun?: boolean } = {}) => runTradeWorkerOnce(world.deps, extra);
  return { world, fake, rows, bySymbol, rfqRows, underlyingLog, symbolOf, run, setNow: (value: number) => { now = value; } };
}
const events = async (world: World) => (await world.positions.listRuns(world.owner, world.agent.id, 50)).flatMap((run) => run.events ?? []);
const ofStage = async (world: World, stage: string, token?: Address) => (await events(world)).filter((event) => event.stage === stage && (token === undefined || event.token?.toLowerCase() === token.toLowerCase()));

test("E8/E9 an LLM enter on an RFQ-only stock: buy quote, executed premium, exit check, minOut = Q x (1 - slippage); the executor request, the route event and the buy label", async (t) => {
  const w = await entryWorld(t, { quote: (call) => call.side === "buy" ? { ok: true, outAtomic: 376_000_000_000_000_000n } : { ok: true, outAtomic: 2_300_000_000_000_000_000n } });
  const amd = w.bySymbol("AMDB").address;
  const report = await w.run();
  assert.equal(w.world.submitted.length, 1, JSON.stringify(report));
  const request = w.world.submitted[0]!;
  assert.deepEqual([request.side, request.token.toLowerCase(), request.amountWei, request.quotedOutWei, request.minOutWei], ["buy", amd.toLowerCase(), 5n * E, 376_000_000_000_000_000n, 372_240_000_000_000_000n]);
  assert.deepEqual(request.route, { hops: [], fees: [100] });
  assert.equal(request.guardQuote, undefined);
  assert.deepEqual(w.fake.calls.map((c) => [c.side, c.token.toLowerCase(), c.amountAtomic]), [["buy", amd.toLowerCase(), 5n * E], ["sell", amd.toLowerCase(), 376_000_000_000_000_000n]]);
  const route = await ofStage(w.world, "route", amd);
  assert.deepEqual(route.map((e) => [e.code, e.reason]), [["binance-rfq", "premium-ok;exit=2300000000000000000"]]);
  const bought = (await ofStage(w.world, "buy", amd)).find((e) => e.code === "committed");
  assert.equal(bought?.reason, "5.00 USDT via binance-aggregator");
  assert.equal((await w.world.positions.listOpen(w.world.owner, w.world.agent.id)).length, 1);
});

test("E8 an RFQ-only candidate never reaches the direct route reader, the cost quote or Flash (pooled candidates still do); it is routeable unquoted and only the entered one is quoted", async (t) => {
  const w = await entryWorld(t);
  await w.run();
  const rfqTokens = new Set(w.rfqRows.map((row) => row.address.toLowerCase()));
  assert.ok(w.world.log.directTokens.length > 0, "pooled candidates are still routed directly");
  assert.ok(!w.world.log.directTokens.some((token) => rfqTokens.has(token)), "no direct quote for an RFQ-only token");
  assert.ok(!w.world.log.cost.some((token) => rfqTokens.has(token)), "no cost quote for an RFQ-only token");
  assert.deepEqual(w.world.log.flash, []);
  assert.equal(w.fake.calls.length, 2, "one buy quote and one exit check, for the entered stock only");
});

test("E6 underlying features are requested only for RFQ-only tokens without pool evidence; a pooled token never gets underlying evidence", async (t) => {
  const w = await entryWorld(t, { poolEvidence: ["NVDAB", "IBMB"] });
  await w.run();
  const requested = new Set(w.underlyingLog.batches.flat().map((token) => token.toLowerCase()));
  assert.ok(requested.has(w.bySymbol("AMDB").address.toLowerCase()));
  assert.ok(!requested.has(w.bySymbol("NVDAB").address.toLowerCase()), "a pooled token is never requested");
  assert.ok(!requested.has(w.bySymbol("IBMB").address.toLowerCase()), "an RFQ-only token with pool evidence keeps its one scope");
  assert.equal(w.underlyingLog.index, 1);
  const prompt = w.world.log.llm.find((entry) => !entry.exit)?.content ?? "";
  assert.match(prompt, /"scope":"underlying"/u);
  assert.match(prompt, /sampled every 60 s, no volume/u);
});

test("E6 only 1h evidence is insufficient-evidence: no entry model call, no quote, no buy", async (t) => {
  const w = await entryWorld(t, { underlying: (symbol, interval) => symbol === "AMDB" && interval === "1h" ? underlyingRecord({ token: w0(), interval, at: T, sessionStart: SESSION_START }) : null });
  function w0(): Address { return getAddress("0x75fd4cf6f8392e41e70391d60c90c0d5211603a1"); }
  await w.run();
  const score = await ofStage(w.world, "score", w.bySymbol("AMDB").address);
  assert.equal(score[0]?.code, "insufficient-evidence");
  assert.equal(w.world.llm.entryCalls, 0);
  assert.equal(w.fake.calls.length, 0);
  assert.equal(w.world.submitted.length, 0);
});

test("E9 the executed-quote premium cap is 150 bps: 150 passes, 151 refuses with route reason premium and no exit check", async (t) => {
  const ref = (await loadRfqUniverse(true)).find((row) => row.symbol === "AMDB")!.rwa!;
  const fair = ref.referencePriceUsd! * ref.tokenToShareRatio!;
  for (const [premium, passes] of [[149.6, true], [150.4, true], [151.4, false], [250, false]] as const) {
    const w = await entryWorld(t, { quote: (call) => call.side === "buy" ? { ok: true, outAtomic: BigInt(Math.round(Number(call.amountAtomic) / (fair * (1 + premium / 10_000)))) } : { ok: true, outAtomic: E } });
    await w.run();
    assert.equal(w.world.submitted.length === 1, passes, `premium ${premium}`);
    if (!passes) {
      const route = await ofStage(w.world, "route", w.bySymbol("AMDB").address);
      assert.deepEqual(route.map((e) => [e.code, e.reason]), [["binance-refused", "premium"]]);
      assert.equal(w.fake.calls.length, 1, "refused before the exit check");
    }
  }
});

test("E9 a failed or empty exit check refuses with no-exit:<code>; a failed buy quote refuses with its closed code; nothing is bought", async (t) => {
  const cases: [string, (call: RfqQuoteInput) => RfqQuoteResult, string][] = [
    ["exit unreachable", (call) => call.side === "buy" ? { ok: true, outAtomic: buyOut(call.amountAtomic) } : { ok: false, code: "rfq-unreachable" }, "no-exit:rfq-unreachable"],
    ["exit throttled", (call) => call.side === "buy" ? { ok: true, outAtomic: buyOut(call.amountAtomic) } : { ok: false, code: "rfq-throttled" }, "no-exit:rfq-throttled"],
    ["exit zero", (call) => call.side === "buy" ? { ok: true, outAtomic: buyOut(call.amountAtomic) } : { ok: true, outAtomic: 0n }, "no-exit:zero"],
    ["buy refused", () => ({ ok: false, code: "rfq-refused:INSUFFICIENT_BALANCE" }), "rfq-refused:INSUFFICIENT_BALANCE"],
    ["buy wallet busy", () => ({ ok: false, code: "rfq-wallet-busy" }), "rfq-wallet-busy"],
  ];
  for (const [label, quote, reason] of cases) {
    const w = await entryWorld(t, { quote });
    const report = await w.run();
    assert.equal(w.world.submitted.length, 0, label);
    const route = await ofStage(w.world, "route", w.bySymbol("AMDB").address);
    assert.deepEqual(route.map((e) => [e.code, e.reason]), [["binance-refused", reason]], label);
    assert.ok(report.outcomes[0]!.refusals >= 1, label);
  }
});

test("E8 rfq.entries false: the RFQ-only candidates are removed, no RFQ quote is made, and the pooled cycle equals a pooled-only agent's", async (t) => {
  const off = await entryWorld(t, { entries: false, poolEvidence: ["NVDAB"] });
  const report = await off.run();
  assert.equal(off.fake.calls.length, 0);
  assert.equal(off.underlyingLog.index, 0, "no underlying read at all");
  const pooledSymbols = off.rows.filter((row) => admittedVenueRows(row.venues).length > 0).map((row) => row.symbol);
  const reference = await entryWorld(t, { rfqDep: false, poolEvidence: ["NVDAB"], pinSymbols: pooledSymbols });
  const referenceReport = await reference.run();
  const digest = async (world: World, outcome: unknown) => JSON.stringify({ outcome, submitted: world.submitted, runs: (await world.positions.listRuns(world.owner, world.agent.id, 50)).map((run) => [run.reason, run.events]),
    calls: [world.log.direct, world.log.cost, world.log.flash] }, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v);
  const strip = (outcome: { outcomes: readonly { agentId: string; startedAt?: number }[] }) => ({ ...outcome, outcomes: outcome.outcomes.map(({ agentId: _a, startedAt: _s, ...rest }) => rest) });
  assert.equal(await digest(off.world, strip(report)), await digest(reference.world, strip(referenceReport)));
});

test("E8 the 28-token cut: lifted only when the worker's entries flag is on; without the marker it stays today's", async (t) => {
  const batchSizes = async (options: EntryOptions) => {
    const w = await entryWorld(t, options);
    const sizes: number[] = [];
    const original = w.world.deps.dataPlane.tokensBatch.bind(w.world.deps.dataPlane);
    (w.world.deps.dataPlane as { tokensBatch: unknown }).tokensBatch = async (addresses: readonly Address[], signal?: AbortSignal) => { sizes.push(addresses.length); return original(addresses, signal); };
    await w.run();
    return sizes.filter((size) => size > 1);
  };
  assert.ok(Math.max(...await batchSizes({ entries: true })) > 28, "all pinned stocks are candidates");
  assert.ok(Math.max(...await batchSizes({ entries: false })) <= 24, "pooled stocks only");
  assert.ok(Math.max(...await batchSizes({ rfqDep: false })) <= 28, "no marker: today's cut at 28");
});

test("E11 the RFQ-only part of the score shortlist replaces the planning list; no RFQ-only candidate in it leaves today's list", async (t) => {
  const refresh: { heldTickers: readonly string[]; shortlistedTickers: readonly string[] }[] = [];
  const cmc = { settings: { cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E).toString() }, extraDeps: { refreshCmcNews: async (input: { heldTickers: readonly string[]; shortlistedTickers: readonly string[] }) => { refresh.push(input); } } };
  const both = await entryWorld(t, { ...cmc, poolEvidence: ["NVDAB"] });
  await both.run();
  assert.deepEqual(refresh.find((call) => call.shortlistedTickers.length > 0)?.shortlistedTickers, ["AMD"], "RFQ-only tickers replace the pooled ones");
  refresh.length = 0;
  const pooledOnly = await entryWorld(t, { ...cmc, poolEvidence: ["NVDAB"], underlying: () => null });
  await pooledOnly.run();
  assert.deepEqual(refresh.find((call) => call.shortlistedTickers.length > 0)?.shortlistedTickers, ["NVDA"], "no RFQ-only candidate in the shortlist: today's list");
});

test("E8 dry-run prices the RFQ buy and submits nothing", async (t) => {
  const w = await entryWorld(t);
  const report = await w.run({ dryRun: true });
  assert.equal(w.world.submitted.length, 0);
  assert.equal(report.outcomes[0]!.reason.split(";")[0], "dry-run");
  assert.equal(w.fake.calls.length, 2);
});

void crypto; void syncBuiltinESMExports; void USDT_56;

test("E8 audit F1: an LLM enter on a POOLED stock of an RFQ-active agent with entries on makes no RFQ quote and buys by the direct route with today's label", async (t) => {
  const w = await entryWorld(t, { poolEvidence: ["NVDAB"], pinSymbols: ["NVDAB"] });
  const nvda = w.bySymbol("NVDAB").address;
  const report = await w.run();
  assert.equal(w.world.submitted.length, 1, JSON.stringify(report));
  const request = w.world.submitted[0]!;
  assert.deepEqual([request.side, request.token.toLowerCase()], ["buy", nvda.toLowerCase()]);
  assert.equal(w.fake.calls.length, 0, "zero rfqStocks.quote calls for a pooled stock");
  assert.ok(w.world.log.directTokens.some((token) => token === nvda.toLowerCase()), "the direct route was read");
  assert.notDeepEqual(request.route, { hops: [], fees: [100] }, "the request carries the direct route, not the RFQ marker route");
  assert.ok(!(await ofStage(w.world, "route", nvda)).some((event) => event.code === "binance-rfq"));
  const bought = (await ofStage(w.world, "buy", nvda)).find((event) => event.code === "committed");
  assert.equal(bought?.reason, "5.00 USDT via pancake_v2");
});

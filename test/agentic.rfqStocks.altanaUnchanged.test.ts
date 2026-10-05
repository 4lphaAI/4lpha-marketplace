/**
 * AGENTIC-RFQ-STOCKS spec 7.1 (R4, RI1): the Altana-unchanged proof.
 *
 * Every digest below was recorded at the BASE revision (master a7f1afb, before any RFQ source change) by running this file with RFQ_RECORD=1, and committed in the
 * first commit of the build. The same digest must hold with the flag ON and OFF and with RFQ-variant rows present, so a change to an Altana path shows as a failing
 * digest rather than as a reviewer's reading. The one expected data diff (OQ-4, R3.8, R5.1.6) is the corrected per-address rows: its allowed-diff set is exactly
 * AAPLB, PYPLB, COHRB and CRDOB and the test fails on any other difference.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { admittedVenueRows, rwaEntryVerdict, type RwaFact } from "../src/trade/rwa.js";
import { pinUniverse, selectEntryCandidates, createTradeVerdictCache, type PinnedCandidate } from "../src/trade/universe.js";
import { checkTradfiV2Sizing, tradfiV2NativeReserveWei } from "../src/trade/sizing.js";
import { featurePrompt } from "../src/trade/features.js";
import { AgenticPairings, type AgenticRoutesDeps } from "../src/agentic/routes.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { runAgenticCycle } from "../src/agentic/worker.js";
import { tradeSettingsDigest } from "../src/trade/settings.js";
import { E, NOW as AGENTIC_NOW, TOKEN, W, fixture, scheduleParams } from "./support/agenticSchedule.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeSettings } from "../src/trade/settings.js";
import type { UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { AgenticReceipt } from "../src/agentic/resolve.js";
import { lane as portfolioLane } from "./support/agenticPortfolioLane.js";
import { dcaLane } from "./support/agenticDca.js";
import { worldHarness, aiSettings, WALLET, HASH } from "./support/agenticRfqWorker.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";
import { PER_ADDRESS_SYMBOLS, RFQ_FIXTURE_AS_OF, loadRfqUniverse, pinServer, rfqDataPlane } from "./support/agenticRfq.js";
import { featureFixture } from "./support/tradeFeatures.js";

const RECORDED: Readonly<Record<string, string>> = {
  "pin": "cc6fb67ca84762ae15d2fe6bf71b1eb0c1bc0a0a0f988b67faec10da0cdc1a9a",
  "verdicts": "13317c803241b311395081b751916f9fd39090b98bc7ca886906d779c825631d",
  "screening": "56872ecdb0298e326667a2014b6716b5b336a7c0c122a4a07cefe7b2b0b1a80d",
  "sizing": "1cfee734c9adda02f205c7cfce65dc954f84a50c6990ebf20dccbdbc1245c454",
  "prompt": "a88d410f8aabe0359b727c0505080639678f279de04f133e58bbf6cc83ea2e17",
  "corrected-diff": "12144cc6de0580d32b6a0a28283ac438e1f2c5b12341d287219fac3f8359e107",
  "altana-cycle": "6c8a2ef3891df0e4f8887201f9696e08b9f7cf975e79814d9dbc7c43c2cf15c5",
  "agentic-lanes": "30c9144a900fd89977e259ea882ccefc67d3dee5768288da39750a938ab20500",
  "altana-pooled-requote": "ffafd3f567848bc8fb5e99a56c4427df1227e2858721b53ffa058d88a1f58f0f",
};
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v)).digest("hex");
function check(name: string, value: unknown): void {
  const digest = sha(value);
  if (process.env["RFQ_RECORD"] === "1") { console.log(`RECORDED ${name} ${digest}`); return; }
  assert.equal(digest, RECORDED[name], name);
}
const NOW = RFQ_FIXTURE_AS_OF;
/** The fact a worker cycle builds for a row (readRwaLaneSnapshot). */
const factOf = (row: Awaited<ReturnType<typeof loadRfqUniverse>>[number]): RwaFact | undefined => row.rwa;
const OPTION_SETS = { altanaAi: { allowVenueMissing: true }, strict: {}, schedule: { allowVenueMissing: true, deferUnknownPremium: true } } as const;

test("the fixture is the 2026-10-04 universe: 50 rows, 24 with an admitted venue and 26 without", async () => {
  const rows = await loadRfqUniverse();
  assert.equal(rows.length, 50);
  assert.equal(rows.filter((row) => admittedVenueRows(row.venues).length > 0).length, 24);
});

test("(a) pin result: the Altana AI and Schedule pins are the same with the flag ON and OFF and with an RFQ pin taken first", async (t) => {
  const rows = await loadRfqUniverse();
  const outputs: unknown[] = [];
  for (const flag of [false, true]) {
    const f = await fixture(t);
    const pairings = new AgenticPairings({ ...f.pairings.deps, ...(flag ? { rfqEnabled: true } : {}) } as AgenticRoutesDeps);
    pinServer({ pairings, dataPlane: rfqDataPlane(rows), guardVerified: async () => true });
    // Once built: an Agentic RFQ pin first, so a shared cache key or a shared candidate list would leak pool-less rows into the Altana pins below.
    const rfqPin = (pairings as unknown as { rfqPin?: () => Promise<unknown> }).rfqPin;
    if (flag && typeof rfqPin === "function") await rfqPin.call(pairings);
    const ai = await pairings.pin!(W, 5n * E, 100, "ai");
    const schedule = await pairings.pin!(W, 5n * E, 100, "schedule");
    outputs.push({ ai, schedule });
  }
  assert.deepEqual(outputs[1], outputs[0]);
  const { ai, schedule } = outputs[0] as { ai: string[]; schedule: string[] };
  assert.equal(ai.length, 24, "the Altana AI pin is the 24 pooled stocks, never a pool-less one");
  assert.ok(schedule.length >= 24);
  check("pin", outputs[0]);
});

test("(b) verdicts: rwaEntryVerdict for every fixture row under the Altana option sets", async () => {
  const rows = await loadRfqUniverse();
  const verdicts = rows.map((row) => ({ symbol: row.symbol, ...Object.fromEntries(Object.entries(OPTION_SETS).map(([name, options]) => [name, rwaEntryVerdict(factOf(row), NOW, options)])) }));
  check("verdicts", verdicts);
});

async function screened(corrected: boolean): Promise<unknown> {
  const rows = await loadRfqUniverse(corrected);
  const dataPlane = rfqDataPlane(rows);
  const pinned = await pinUniverse("tradfi", { dataPlane, tradfiV2CapabilityProbe: async (candidate: PinnedCandidate) => admittedVenueRows(candidate.venues).length > 0 }, { lanes: ["bstocks"] });
  const facts = new Map(rows.flatMap((row) => row.rwa === undefined ? [] : [[row.address.toLowerCase(), row.rwa] as const]));
  const result = await selectEntryCandidates({ model: "tradfi", settings: { minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, settlementAsset: "USDT" },
    candidates: pinned, pinnedAddresses: new Set(pinned.map((candidate) => candidate.address.toLowerCase())), previouslyEnteredAddresses: new Set(), openPositionAddresses: new Set(),
    forbiddenAddresses: new Set(), rwaAddresses: new Set(rows.map((row) => row.address.toLowerCase())), rwaFacts: facts, dataPlane, nowMs: NOW, verdictCache: createTradeVerdictCache() });
  return { pinned: pinned.map((candidate) => candidate.address), result: { ...result, candidates: result.kind === "selected" ? result.candidates.map((c) => ({ address: c.address, note: c.rwaNote })) : [] } };
}

test("(c) screening: selectEntryCandidates without rfqOnly is unchanged (candidates, refusals, reads, prefilter)", async () => {
  check("screening", await screened(false));
});

test("(e) sizing: checkTradfiV2Sizing vectors are unchanged", () => {
  const vectors = [1, 2, 24, 28, 29, 50].map((count) => checkTradfiV2Sizing({ minEntryWei: 5n * E, maxEntryWei: 5n * E, capitalQuoteWei: 10n * E, maxOpenPositions: 2, platformFeeBps: 0,
    grantedTokenCount: count, capDayWei: tradfiV2NativeReserveWei(2, count) }));
  check("sizing", vectors);
  assert.equal(vectors[0]!.ok, true);
  assert.equal(vectors.at(-1)!.ok, false, "50 granted tokens exceed the Altana ceiling of 28");
});

test("(g) featurePrompt: pool evidence prints today's bytes", () => {
  const at = 1_800_000_090_000;
  const decoded = (interval: "15m" | "1h") => ({ pool: { pool: getAddress("0x0000000000000000000000000000000000000001"), tokenAddress: getAddress("0x0000000000000000000000000000000000000002"), currency: "usd" as const },
    interval, quoteAddress: getAddress("0x0000000000000000000000000000000000000003"), snapshotId: "a".repeat(64), seriesId: "b".repeat(64), observedAt: at, calculatedAt: at,
    evaluationClose: featureFixture(interval, undefined, at).evaluationClose, expiresAt: featureFixture(interval, undefined, at).expiresAt,
    metrics: Object.fromEntries(Object.entries(featureFixture(interval, undefined, at).metrics).map(([k, m]) => [k, { value: m.value, unit: m.unit, available: true }])) });
  const evidence = { "15m": decoded("15m"), "1h": decoded("1h") } as unknown as Parameters<typeof featurePrompt>[0];
  check("prompt", featurePrompt(evidence, at, { v2: true }));
  assert.ok(featurePrompt(evidence, at).includes('"scope":"exact_pool"'));
});

test("corrected per-address data: verdict and refusal differences are the four rows; the only knock-on is the displaced boundary candidate", async () => {
  // OQ-4 / R3.8 / R5.1.6. The spec's allowed-diff set is the four addresses. One consequence it did not list is arithmetic, not a code change: AAPLB (pooled,
  // $547 734) turns from premium-unknown to allowed, enters the 12-slot pooled shortlist and displaces exactly one pooled row ranked 13th (SPYB). The test pins that
  // displacement instead of hiding it: one row out for every pooled row in.
  const base = await loadRfqUniverse(false);
  const corrected = await loadRfqUniverse(true);
  const verdictDiff = new Set<string>();
  for (const [index, row] of base.entries()) {
    for (const options of Object.values(OPTION_SETS)) {
      if (JSON.stringify(rwaEntryVerdict(factOf(row), NOW, options)) !== JSON.stringify(rwaEntryVerdict(factOf(corrected[index]!), NOW, options))) verdictDiff.add(row.symbol);
    }
  }
  const four = new Set(["AAPLB", ...PER_ADDRESS_SYMBOLS]);
  assert.deepEqual([...verdictDiff].filter((symbol) => !four.has(symbol)), [], "no other verdict may differ");
  type Screened = { result: { candidates: { address: string; note: string | null }[]; refusals: { address: string; reason: string }[] } };
  const before = (await screened(false)) as Screened, after = (await screened(true)) as Screened;
  const symbolOf = (address: string): string => base.find((row) => row.address.toLowerCase() === address.toLowerCase())!.symbol;
  const addresses = (rows: readonly { address: string }[]) => new Set(rows.map((row) => row.address.toLowerCase()));
  const was = addresses(before.result.candidates), now = addresses(after.result.candidates);
  const added = [...now].filter((address) => !was.has(address)).map(symbolOf), removed = [...was].filter((address) => !now.has(address)).map(symbolOf);
  assert.deepEqual(added.filter((symbol) => !four.has(symbol)), [], "only the four rows may enter the shortlist");
  // F4 (operator acknowledged 2026-10-05, OQ-4 / R3.8): the SPYB displacement is an ACCEPTED data effect. AAPLB (9th by liquidity) turns screenable once its ratio is filled and the fixed 12-slot
  // Altana AI shortlist then drops SPYB (13th). SPYB is named here on purpose: it stays pinned and holdable, it is only no longer scored or bought by an Altana AI agent. No generic widening rule.
  assert.deepEqual(removed, ["SPYB"], "the one accepted displacement of the Altana AI 12-slot shortlist (OQ-4): SPYB, by AAPLB");
  assert.deepEqual(added.filter((symbol) => admittedVenueRows(base.find((row) => row.symbol === symbol)!.venues).length > 0), ["AAPLB"], "the only pooled row that enters is AAPLB");
  const refusedBefore = new Map(before.result.refusals.map((row) => [row.address.toLowerCase(), row.reason])), refusedAfter = new Map(after.result.refusals.map((row) => [row.address.toLowerCase(), row.reason]));
  const refusalDiff = [...new Set([...refusedBefore.keys(), ...refusedAfter.keys()])].filter((address) => refusedBefore.get(address) !== refusedAfter.get(address)).map(symbolOf);
  assert.deepEqual(refusalDiff.filter((symbol) => !four.has(symbol) && !removed.includes(symbol)), [], "no other refusal may differ (a displaced row loses or gains only its own security-read outcome)");
  const note = (symbol: string, set: Screened) => set.result.candidates.find((row) => symbolOf(row.address) === symbol)?.note ?? null;
  check("corrected-diff", { verdictDiff: [...verdictDiff].sort(), added: added.sort(), removed: removed.sort(), refusalDiff: refusalDiff.sort(),
    aaplNote: note("AAPLB", after), verdicts: ["AAPLB", "PYPLB", "COHRB", "CRDOB"].map((symbol) => ({ symbol,
      ...Object.fromEntries(Object.entries(OPTION_SETS).map(([name, options]) => [name, rwaEntryVerdict(factOf(corrected.find((row) => row.symbol === symbol)!), NOW, options)])) })) });
});

type Spy = { active: number; quote: number };
/** An RFQ quote source that must never be asked: counts every call and answers nothing usable. Before the build there is no such dep and the counts stay zero. */
function rfqSpy(): { spy: Spy; dep: unknown } {
  const spy: Spy = { active: 0, quote: 0 };
  return { spy, dep: { active: async () => { spy.active += 1; return { entries: true, rfqOnlyAtHire: new Set<string>() }; }, quote: async () => { spy.quote += 1; return { ok: false as const, code: "spy" }; } } };
}

test("(d) Altana TradFi AI cycle: a buy and a stop-loss sell are byte-equal with RFQ-variant Agentic rows present and an RFQ quote source injected", async (context) => {
  let now = RFQ_FIXTURE_AS_OF + 120_000, uuid = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const rows = await loadRfqUniverse();
  const pooled = rows.filter((row) => admittedVenueRows(row.venues).length > 0);
  const nvda = rows.find((row) => row.symbol === "NVDAB")!;
  const transcripts: string[] = [];
  for (const variant of ["plain", "rfq-rows-and-source"] as const) {
    now = RFQ_FIXTURE_AS_OF + 120_000; uuid = 0;
    const { spy, dep } = rfqSpy();
    const world = await worldHarness({ now: () => now, rows, custody: "passkey", pinned: pooled.map((row) => row.address), settings: { maxOpenPositions: 1, entryWei: (20n * E).toString(), minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() },
      dataPlane: strongFeatureDataPlane(nvda.address, nvda.venues![0]!.pool, now), extraDeps: variant === "plain" ? {} : { rfqStocks: dep } as unknown as Partial<TradeWorkerDeps> });
    if (variant === "rfq-rows-and-source") await world.agents.createAgent({ id: "agentic-rfq-variant", ownerAddress: WALLET, walletAddress: WALLET, custodyModel: "binance-agentic", status: "armed" });
    const buy = await runTradeWorkerOnce(world.deps);
    const opened = await world.positions.listOpen(world.owner, world.agent.id);
    assert.equal(world.submitted.filter((request) => request.side === "buy").length, 1, JSON.stringify(buy));
    world.balances.set(nvda.address.toLowerCase(), opened[0]!.tokenAmount ?? 5n * E);
    const stopLoss = aiSettings({ maxOpenPositions: 1, entryWei: (20n * E).toString(), minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString(), stopLossBps: 100 });
    await world.settingsStore.put({ agentId: world.agent.id, ownerAddress: world.owner, params: stopLoss, digest: tradeSettingsDigest(stopLoss) });
    world.factor.sell = 500n; now += 60_000;
    const sell = await runTradeWorkerOnce(world.deps);
    assert.equal(world.submitted.filter((request) => request.side === "sell").length, 1, JSON.stringify(sell));
    assert.equal(spy.active + spy.quote, 0, "an Altana agent never reaches the RFQ quote source");
    assert.ok(!world.log.dataPlane.some((name) => /underlying/i.test(name)), "no underlying-features request");
    transcripts.push(JSON.stringify({ buy, sell, submitted: world.submitted, calls: { direct: world.log.direct, flash: world.log.flash, dataPlane: world.log.dataPlane },
      positions: await world.positions.list(world.owner, world.agent.id), runs: await world.positions.listRuns(world.owner, world.agent.id, 50),
      journal: await Promise.all(world.submitted.map((request) => world.journal.getByDecision(world.agent.id, request.decisionId))) }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
  }
  if (transcripts[1] !== transcripts[0]) { let i = 0; while (transcripts[0]![i] === transcripts[1]![i]) i += 1; assert.fail(`transcripts differ at ${i}: ${transcripts[0]!.slice(Math.max(0, i - 200), i + 200)} VS ${transcripts[1]!.slice(Math.max(0, i - 200), i + 200)}`); }
  check("altana-cycle", JSON.parse(transcripts[0]!));
});


/** The Agentic Schedule world of the lane suite (agentic.scheduleLane.test.ts), copied: one hourly slot over a fake Binance. */
async function scheduleWorld(t: import("node:test").TestContext) {
  const settings: TradeSettings = { ...scheduleParams, capitalQuoteWei: (20n * E).toString() };
  let clock = AGENTIC_NOW;
  t.mock.method(Date, "now", () => clock);
  const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: "0x4444444444444444444444444444444444444444", feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: AGENTIC_NOW };
  const row = (): UniverseRow => ({ address: TOKEN, symbol: "STOCK", lane: "bstocks", source: "offline", venues: [{ ...venue, asOf: clock }],
    rwa: { platform: "bstocks", underlyingTicker: "STOCK", tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [{ ...venue, asOf: clock }] } });
  const dataPlane: TradeWorkerDeps["dataPlane"] = { universe: async (lane) => lane === "bstocks" ? [row()] : [],
    tokensBatch: async (addresses) => addresses.map((address) => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1e9, volume24hUsd: 1000, holders: 100, priceChange24hPct: 0, asOf: clock, source: "pancake-v3-slot0", staleness: "fresh" as const, updatedFields: ["priceUsd"] })),
    eligibilityBatch: async (addresses) => addresses.map((address) => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })), security: async () => ({ riskLevel: "ok", flags: [] }) };
  const routeReader = { quoteV2: async (_path: readonly Address[], amount: bigint) => amount * 102n / 100n, quoteV3Single: async () => { throw new Error("no v3"); }, quoteV3Path: async () => { throw new Error("no v3"); },
    quoteUniV3Single: async () => { throw new Error("no uni"); }, quoteUniV3Path: async () => { throw new Error("no uni"); } };
  const f = await fixture(t, {}, settings, () => ({ dataPlane, routeReader, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN]) } }));
  const landed: { orderId: string; status: string; txHash: Hex }[] = [];
  const proof = (amount: bigint, out: bigint, hash: Hex): AgenticReceipt => {
    const block = `0x${"44".repeat(32)}` as Hex, topic = (address: Address) => ("0x" + address.slice(2).padStart(64, "0")) as Hex, word = (value: bigint) => ("0x" + value.toString(16).padStart(64, "0")) as Hex;
    const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)"));
    return { from: W, to: TOKEN, input: "0x", observation: { chainId: 56, transaction: { hash, to: TOKEN, input: "0x", blockNumber: 1n, blockHash: block, transactionIndex: 0n },
      receipt: { status: 1n, transactionHash: hash, blockNumber: 1n, blockHash: block, transactionIndex: 0n, logs: [
        { address: USDT_56, topics: [transfer, topic(W), topic(TOKEN)], data: word(amount), logIndex: 0n }, { address: TOKEN, topics: [transfer, topic(TOKEN), topic(W)], data: word(out), logIndex: 1n }] },
      receiptBlock: { number: 1n, hash: block }, finalizedBlock: { number: 2n, hash: block } } } as unknown as AgenticReceipt;
  };
  f.chain.receipt = async (hash) => landed.some((r) => r.txHash === hash) ? proof(5n * E, 5n * E, hash) : null;
  f.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: landed.length, page: 1, pageSize: 100, list: landed } }));
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "5.1", slippage: "0" } });
  f.runner.replies.set("market-order swap", async () => {
    const hash = ("0x" + String(landed.length + 1).padStart(64, "0")) as Hex;
    landed.push({ orderId: "listed-" + (landed.length + 1), status: "FINISHED", txHash: hash });
    return { kind: "ok", data: { orderId: "returned-" + landed.length }, sessionPresent: true, rwaTokens: null };
  });
  const worker: TradeWorkerDeps = { ...f.worker, now: f.now };
  return { f, input: { ...f.lifecycle, worker }, at: async (ms: number) => { clock = ms; f.setTime(ms); await f.instance.heartbeat(); } };
}

test("(f) Agentic Schedule, Portfolio and DCA cycles: zero RFQ quote calls and base-equal outputs", async (context) => {
  let uuid = 0;
  context.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const digests: Record<string, string> = {};
  const wrap = <T extends { worker: TradeWorkerDeps }>(input: T): { input: T; spy: Spy } => {
    const spy: Spy = { active: 0, quote: 0 };
    const original = (input.worker as { rfqStocks?: { active(a: unknown): Promise<unknown>; quote(q: unknown): Promise<unknown> } }).rfqStocks;
    const wrapped = original === undefined ? undefined : { active: (a: unknown) => { spy.active += 1; return original.active(a); }, quote: (q: unknown) => { spy.quote += 1; return original.quote(q); } };
    return { input: { ...input, worker: { ...input.worker, ...(wrapped === undefined ? {} : { rfqStocks: wrapped }) } as TradeWorkerDeps }, spy };
  };
  const schedule = await scheduleWorld(context);
  const wrappedSchedule = wrap(schedule.input);
  await runAgenticCycle(wrappedSchedule.input);
  await schedule.at(AGENTIC_NOW + 60_000); await runAgenticCycle(wrappedSchedule.input);
  assert.deepEqual(wrappedSchedule.spy, { active: 0, quote: 0 });
  assert.equal(schedule.f.runner.calls.filter((args) => args[0] === "market-order" && args[1] === "swap").length, 1, "the Schedule slot bought");
  digests["schedule"] = sha({ runs: (await schedule.f.positions.listRuns(W, schedule.f.agent.id, 50)).map((run) => [run.reason, run.events]), calls: schedule.f.runner.calls,
    intents: (await schedule.f.intents.listSchedule(W, schedule.f.agent.id)).map((intent) => [intent.scheduleSlot, intent.state, intent.amountWei]), positions: await schedule.f.positions.list(W, schedule.f.agent.id) });
  const portfolio = await portfolioLane(context);
  const wrappedPortfolio = wrap(portfolio.input);
  await runAgenticCycle(wrappedPortfolio.input);
  await portfolio.at(AGENTIC_NOW + 60_000); await runAgenticCycle(wrappedPortfolio.input);
  assert.deepEqual(wrappedPortfolio.spy, { active: 0, quote: 0 });
  assert.ok(portfolio.swaps.length > 0, "the portfolio basket bought");
  digests["portfolio"] = sha({ runs: (await portfolio.f.positions.listRuns(W, portfolio.f.agent.id, 50)).map((run) => [run.reason, run.events]), swaps: portfolio.swaps, quotes: portfolio.quotes,
    intents: await portfolio.f.intents.listPortfolio(W, portfolio.f.agent.id) });
  const dca = await dcaLane(context);
  const wrappedDca = wrap(dca.input);
  await runAgenticCycle(wrappedDca.input);
  await dca.advance(60_000); await runAgenticCycle(wrappedDca.input);
  assert.deepEqual(wrappedDca.spy, { active: 0, quote: 0 });
  assert.ok(dca.market.swapCalls().length > 0, "the DCA base bought");
  digests["dca"] = sha({ runs: (await dca.runs()).map((run) => [run.reason, run.events]), rounds: await dca.rounds(), orders: await dca.orders(), swaps: dca.market.swapCalls() });
  check("agentic-lanes", digests);
});

test("(d2) a pooled position whose post-model re-quote is far below the asked mark sells exactly as today: same route events, same sale, no asked-mark observation", async (context) => {
  let now = RFQ_FIXTURE_AS_OF + 120_000, uuid = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const rows = await loadRfqUniverse();
  const pooled = rows.filter((row) => admittedVenueRows(row.venues).length > 0);
  const nvda = rows.find((row) => row.symbol === "NVDAB")!;
  const transcripts: string[] = [];
  for (const variant of ["plain", "rfq-source"] as const) {
    now = RFQ_FIXTURE_AS_OF + 120_000; uuid = 0;
    const { spy, dep } = rfqSpy();
    const settings = aiSettings({ maxOpenPositions: 1, stopLossBps: null, takeProfitBps: null, maxHoldSec: null, slippageBps: 100 });
    const world = await worldHarness({ now: () => now, rows, custody: "passkey", pinned: pooled.map((row) => row.address), settings,
      dataPlane: { usEquityRegime: async () => ({ regime: "risk_off", reasons: [], asOf: null }) }, balances: new Map([[nvda.address.toLowerCase(), E]]),
      extraDeps: variant === "plain" ? {} : { rfqStocks: dep } as unknown as Partial<TradeWorkerDeps> });
    await world.positions.open({ positionId: "pooled-1", agentId: world.agent.id, ownerAddress: world.owner, token: nvda.address, route: { hops: [], fees: [2500] }, venue: "pancake_v3", entryWei: E, tokenAmount: E,
      fillStatus: "verified", openedAt: now - 3_600_000, entryTxHash: HASH, crashBasisVerified: true, sessionGeneration: 0, settlementAsset: "USDT", requestedEntryAtomic: E, verifiedEntryAtomic: E,
      receiptOwnershipKey: `56|${HASH}|${WALLET.toLowerCase()}|0|${HASH}` });
    await world.positions.setExitLlmContext(world.owner, world.agent.id, "pooled-1", { askedAtMs: now - 7_200_000, pnlBps: -200, peakPnlBps: null, macdHistSign: null, emaSpreadSign: null,
      regime: "risk_off", session: "close", trigger: "none" });
    world.factor.sell = 980n;
    const deps: TradeWorkerDeps = { ...world.deps, llmFor: () => ({ complete: async () => { world.factor.sell = 500n; return { model: "offline", content: JSON.stringify({ decisions: [{ index: 0, exit: true, reason: "exit" }] }) }; } }) };
    const report = await runTradeWorkerOnce(deps);
    assert.equal(world.submitted.filter((request) => request.side === "sell").length, 1, JSON.stringify(report));
    assert.equal(world.submitted[0]!.quotedOutWei, E / 2n, "sold at the re-quote, far below the asked mark");
    const runs = await world.positions.listRuns(world.owner, world.agent.id, 50);
    assert.ok(!JSON.stringify(runs).includes("asked-mark"), "no asked-mark observation on a pooled position");
    assert.equal(spy.active + spy.quote, 0);
    transcripts.push(JSON.stringify({ report, submitted: world.submitted, runs, calls: { direct: world.log.direct, flash: world.log.flash } }, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v));
  }
  assert.equal(transcripts[1], transcripts[0]);
  check("altana-pooled-requote", JSON.parse(transcripts[0]!));
});

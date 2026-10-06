/**
 * AGENTIC-MEME-STOCKS spec section 10, first test (PA2, I14): the Altana-unchanged proof.
 *
 * Every digest below was recorded at the BASE revision (master b5af0a0, before any meme source change) by running this file with MEME_RECORD=1, and committed in the
 * first commit of the build (step A0, review R2-L5). The same digest must hold with the meme flag ON and OFF, so a change to an Altana or existing Agentic path
 * shows as a failing digest rather than as a reviewer's reading.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { admittedVenueRows } from "../src/trade/rwa.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { runAgenticCycle, startAgenticLane } from "../src/agentic/worker.js";
import { parseTradeSettings, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { agenticGate, agenticGateInput, parseAgenticHireParams, projectAgenticSessionFacts } from "../src/agentic/domain.js";
import { executeAgenticTrade } from "../src/agentic/execute.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { AgenticReceipt } from "../src/agentic/resolve.js";
import { E, FACTS, HASH as AGENTIC_HASH, NOW as AGENTIC_NOW, PAIRING, TOKEN, W, aiParams, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";
import { portfolioParams } from "./support/agenticPortfolio.js";
import { dcaParams } from "./support/agenticDca.js";
import { lane as portfolioLane } from "./support/agenticPortfolioLane.js";
import { dcaLane } from "./support/agenticDca.js";
import { worldHarness, aiSettings, WALLET } from "./support/agenticRfqWorker.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { encryptAgenticSession } from "../src/agentic/store.js";
import { agenticAddress, type AgenticWallet } from "../src/agentic/domain.js";
import type { BawResult } from "../src/agentic/baw.js";
import { MASTER } from "./support/agenticSchedule.js";
import { memeBody, memeHireFacts, memeSettings } from "./support/agenticMeme.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";
import { RFQ_FIXTURE_AS_OF, loadRfqUniverse } from "./support/agenticRfq.js";

const RECORDED: Readonly<Record<string, string>> = {
  "altana-cycle": "6c8a2ef3891df0e4f8887201f9696e08b9f7cf975e79814d9dbc7c43c2cf15c5",
  "parsers": "e14e78c352f952f428a59d61819ce1c552d587184b1ac9e9a95e80cca8cfd341",
  "gates": "fa734826b2914f5ef3a1c5173ee164041512fc9b1383c1c4e340c2aa38f018de",
  "agentic-lanes": "c07dcacc7b200a01655a6ad5eb28c4595f5bac6e6af10b9a0a197e56f7f8575c",
  "executor": "6db7e24066bc1e732c3d6c239f853978a32412cc0a6c92f40ec5ccb55577ef0c",
};
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v)).digest("hex");
function check(name: string, value: unknown): void {
  const digest = sha(value);
  if (process.env["MEME_RECORD"] === "1") { console.log(`RECORDED ${name} ${digest}`); return; }
  assert.equal(digest, RECORDED[name], name);
}
/** Runs `work` with AGENTIC_MEME_STOCKS_ENABLED set as given (the lane reads it from the environment when no explicit flag is passed), then restores it. */
async function withFlag<T>(on: boolean, work: () => Promise<T>): Promise<T> {
  const before = process.env["AGENTIC_MEME_STOCKS_ENABLED"];
  if (on) process.env["AGENTIC_MEME_STOCKS_ENABLED"] = "true"; else delete process.env["AGENTIC_MEME_STOCKS_ENABLED"];
  try { return await work(); } finally { if (before === undefined) delete process.env["AGENTIC_MEME_STOCKS_ENABLED"]; else process.env["AGENTIC_MEME_STOCKS_ENABLED"] = before; }
}
/** Counts every call of a data-plane method whose name starts with "meme" (none exists on the base revision; a lane that reads one for a non-meme agent fails here). */
function memeReadSpy(worker: TradeWorkerDeps): { worker: TradeWorkerDeps; reads: string[] } {
  const reads: string[] = [];
  const dataPlane = new Proxy(worker.dataPlane, { get(target, property, receiver): unknown {
    const value: unknown = Reflect.get(target, property, receiver);
    if (typeof value !== "function" || typeof property !== "string") return value;
    return (...args: unknown[]) => { if (property.startsWith("meme")) reads.push(property); return (value as (...a: unknown[]) => unknown).apply(target, args); };
  } });
  return { worker: { ...worker, dataPlane }, reads };
}
/**
 * A second, bound paper meme hire in the same Agentic store, with one open paper row and one log row (section 10 first test). Its Binance commands are answered here and kept out of the
 * world's own runner transcript (its session carries its own instance id), so the existing agent's outputs can be compared byte for byte with the base.
 */
const MEME_INSTANCE = "88".repeat(32), MEME_W = agenticAddress("0x9999999999999999999999999999999999999999"), MEME_AGENT = "agentic-meme-proof";
async function addMemeWallet(f: Fixture, guard: <T>(work: () => Promise<T>) => Promise<T> = work => work()): Promise<string[]> {
  const memeCalls: string[] = [];
  // The meme step's run row draws a random id; the guard gives that draw back, so the mocked id sequence of the existing agents is the base one.
  const insertRun = f.positions.insertRun.bind(f.positions);
  f.positions.insertRun = (input => input.agentId === MEME_AGENT ? guard(() => insertRun(input)) : insertRun(input)) as typeof f.positions.insertRun;
  const pairingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", base = (await f.store.wallets())[0]!;
  const hireParams = { ...(memeBody() as unknown as NonNullable<AgenticWallet["hireParams"]>), pairingId };
  const row: AgenticWallet = { ...base, pairingId, walletAddress: MEME_W, ownerAddress: MEME_W, agentId: MEME_AGENT, hireOpId: `0x${"77".repeat(32)}`, hireParams,
    hireFacts: memeHireFacts(memeSettings, base.acceptedAt!), termEndAction: "sell-all", hireEndMs: base.acceptedAt! + 604_800_000, entryCutoffMs: base.acceptedAt! + 597_600_000,
    probe: null, settingsHold: null, drainRequestedAt: null, entriesStopped: null, version: 1,
    sessionCiphertext: encryptAgenticSession({ v: 1, instanceId: MEME_INSTANCE, sessionJson: JSON.stringify({ sessionId: "meme", clientId: "meme" }) }, MASTER, pairingId, MEME_W) };
  assert.ok(await f.store.createWallet(row));
  await f.agents.createAgent({ id: MEME_AGENT, ownerAddress: MEME_W, walletAddress: MEME_W, custodyModel: "binance-agentic", status: "armed" });
  await f.settings.put({ ownerAddress: MEME_W, agentId: MEME_AGENT, params: memeSettings, digest: tradeSettingsDigest(memeSettings) });
  assert.ok(await f.store.insertPaper({ positionId: "meme-proof", agentId: MEME_AGENT, walletAddress: MEME_W, token: agenticAddress("0xabababababababababababababababababababab"), symbol: "M",
    quoteToken: agenticAddress("0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"), quoteSymbol: "Q", venueEntry: "pancake-v2", buyTaxBps: 300, sellTaxBps: 500, tokenVersion: 6,
    entryUsdt: (10n * E).toString(), gasBuyUsdt: "1", bnbUsdtE18: (700n * E).toString(), tokens: (1_000n * E).toString(), costBps: 900, status: "open", lastMarkUsdt: null, lastMarkAt: null,
    peakPnlBps: null, markSkips: 0, markCount: 0, closeRequestedAt: null, closeCode: null, exitUsdt: null, gasSellUsdt: null, pnlUsdt: null, closedAt: null, openedAt: base.acceptedAt!, version: 1 }));
  assert.ok(await f.store.insertMemeLog({ id: "llm:proof", agentId: MEME_AGENT, kind: "llm", token: null, atMs: base.acceptedAt!, data: { model: "x", outcome: "timeout" } }));
  const original = f.runner.run.bind(f.runner) as (args: readonly string[]) => Promise<BawResult>;
  f.runner.run = (async (args: readonly string[], session?: { instanceId: string }) => {
    if (session?.instanceId !== MEME_INSTANCE) return original(args);
    memeCalls.push(args.slice(0, 2).join(" "));
    const command = args.slice(0, 2).join(" ");
    return { kind: "ok", sessionPresent: true, rwaTokens: null, data: command === "wallet status" ? { status: "CONNECTED" } : command === "market-order quote"
      ? { fromCoinSymbol: "M", fromCoinAmount: "1000", toCoinSymbol: "USDT", toCoinAmount: "9", slippage: "0.06" } : { total: 0, page: 1, pageSize: 1, list: [] } };
  }) as typeof f.runner.run;
  return memeCalls;
}

/** Counts every call of a meme table method of the Agentic store (none exists on the base revision). */
function memeTableSpy(store: object): string[] {
  const calls: string[] = [];
  for (const name of ["paperOpen", "paperList", "insertPaper", "patchPaper", "insertMemeLog", "memeLog"]) {
    const value: unknown = Reflect.get(store, name);
    if (typeof value === "function") Reflect.set(store, name, (...args: unknown[]) => { calls.push(name); return (value as (...a: unknown[]) => unknown).apply(store, args); });
  }
  return calls;
}

test("(a) Altana TradFi AI cycle: a buy and a stop-loss sell are byte-equal with the meme flag ON and OFF", async (context) => {
  let now = RFQ_FIXTURE_AS_OF + 120_000, uuid = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const rows = await loadRfqUniverse();
  const pooled = rows.filter((row) => admittedVenueRows(row.venues).length > 0);
  const nvda = rows.find((row) => row.symbol === "NVDAB")!;
  const transcripts: string[] = [];
  for (const flag of [false, true]) {
    now = RFQ_FIXTURE_AS_OF + 120_000; uuid = 0;
    transcripts.push(await withFlag(flag, async () => {
      const world = await worldHarness({ now: () => now, rows, custody: "passkey", pinned: pooled.map((row) => row.address), settings: { maxOpenPositions: 1, entryWei: (20n * E).toString(), minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() },
        dataPlane: strongFeatureDataPlane(nvda.address, nvda.venues![0]!.pool, now) });
      // With the flag on, a paper meme agent exists beside the Altana agent (its wallet row lives in the Agentic store, which this Altana world does not have).
      if (flag) await world.agents.createAgent({ id: MEME_AGENT, ownerAddress: WALLET, walletAddress: WALLET, custodyModel: "binance-agentic", status: "armed" });
      const buy = await runTradeWorkerOnce(world.deps);
      const opened = await world.positions.listOpen(world.owner, world.agent.id);
      assert.equal(world.submitted.filter((request) => request.side === "buy").length, 1, JSON.stringify(buy));
      world.balances.set(nvda.address.toLowerCase(), opened[0]!.tokenAmount ?? 5n * E);
      const stopLoss = aiSettings({ maxOpenPositions: 1, entryWei: (20n * E).toString(), minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString(), stopLossBps: 100 });
      await world.settingsStore.put({ agentId: world.agent.id, ownerAddress: world.owner, params: stopLoss, digest: tradeSettingsDigest(stopLoss) });
      world.factor.sell = 500n; now += 60_000;
      const sell = await runTradeWorkerOnce(world.deps);
      assert.equal(world.submitted.filter((request) => request.side === "sell").length, 1, JSON.stringify(sell));
      assert.ok(!world.log.dataPlane.some((name) => name.startsWith("meme")), "no meme read from an Altana cycle");
      return JSON.stringify({ buy, sell, submitted: world.submitted, calls: { direct: world.log.direct, flash: world.log.flash, dataPlane: world.log.dataPlane },
        positions: await world.positions.list(world.owner, world.agent.id), runs: await world.positions.listRuns(world.owner, world.agent.id, 50),
        journal: await Promise.all(world.submitted.map((request) => world.journal.getByDecision(world.agent.id, request.decisionId))) }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    }));
  }
  assert.equal(transcripts[1], transcripts[0]);
  check("altana-cycle", JSON.parse(transcripts[0]!));
});

/** Every existing 7-key hire body and its settings, plus the refused shapes the parser already knows. */
const body = (settings: TradeSettings, extra: Record<string, unknown> = {}) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings, ...extra });
const { cmcTotalBudgetWei: _budget, ...aiNoBudget } = aiParams;
const FIXTURES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["ai", body(aiParams)], ["ai-30", body({ ...aiParams, cmcTotalBudgetWei: (8n * E).toString() }, { term: 30 })], ["ai-sell-all", body(aiParams, { termEndAction: "sell-all" })],
  ["ai-no-cmc", body({ ...aiNoBudget, cmcNewsEnabled: false })], ["schedule", body(scheduleParams)], ["schedule-sell-all", body(scheduleParams, { termEndAction: "sell-all" })],
  ["portfolio", body(portfolioParams)], ["dca", body(dcaParams())], ["eight-keys", body(aiParams, { strategy: "meme-stocks-paper" })], ["six-keys", (() => { const { acceptedDedicatedWallet: _a, ...rest } = body(aiParams); return rest; })()],
];

test("(c) parseTradeSettings and parseAgenticHireParams on every existing fixture are byte-equal", () => {
  const out = FIXTURES.map(([name, value]) => ({ name, settings: parseTradeSettings(value["settings"]), params: parseAgenticHireParams(value) }));
  assert.equal(out.find((row) => row.name === "eight-keys")!.params, null, "an 8-key body is refused without the meme option");
  // With the meme option on (the flag-on execution-api), every existing 7-key body parses exactly as before.
  for (const [index, [name, value]] of FIXTURES.entries()) if (name !== "eight-keys") assert.deepEqual(parseAgenticHireParams(value, { meme: true }), out[index]!.params, name);
  check("parsers", out);
});

test("(d) agenticGate rows for an AI, Schedule, Portfolio, DCA and RFQ hire are byte-equal (the meme field absent)", () => {
  const rows: unknown[] = [];
  for (const [name, value] of FIXTURES) {
    const params = parseAgenticHireParams(value);
    if (params === null) continue;
    assert.equal(Object.hasOwn(agenticGateInput(params, FACTS, W, AGENTIC_NOW), "meme"), false, "no existing hire carries the meme field");
    for (const facts of [FACTS, { ...FACTS, tradeAllTokens: false, usdtWei: "1", bnbWei: "1", x402DailyLimit: 0.1 }, { ...FACTS, status: "UNCONNECTED", signInMaxTimeMs: null }]) {
      rows.push({ name, gate: agenticGate(agenticGateInput(params, facts, W, AGENTIC_NOW)) });
    }
  }
  // An RFQ hire signs the AI body; its gate is the AI gate (the RFQ variant changes the pin, not the rows).
  assert.ok(rows.length >= 15);
  check("gates", rows);
});

/** The Agentic Schedule world of the RFQ proof (agentic.rfqStocks.altanaUnchanged.test.ts), copied: one hourly slot over a fake Binance. */
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

test("(e) one cycle each of Agentic AI stocks, Schedule, Portfolio and DCA: zero meme reads, zero meme table reads, base-equal outputs, flag ON and OFF", async (context) => {
  let uuid = 0;
  context.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  const outputs: Record<string, string>[] = [];
  for (const [flag, withMeme] of [[false, false], [true, false], [true, true]] as const) {
    uuid = 0;
    outputs.push(await withFlag(flag, async () => {
      const digests: Record<string, string> = {};
      // Zero meme reads and zero meme table reads are asserted where no meme hire exists; with one present its own step reads, and the existing agents' outputs must stay base-equal.
      const zero = (reads: string[], tables: string[]): void => { if (!withMeme) assert.deepEqual([reads, tables], [[], []]); };
      const guard = async <T>(work: () => Promise<T>): Promise<T> => { const saved = uuid; try { return await work(); } finally { uuid = saved; } };
      const ai = await fixture(context);
      const memeAi = withMeme ? await addMemeWallet(ai, guard) : [];
      const aiSpy = memeReadSpy(ai.worker), aiTables = memeTableSpy(ai.store);
      const aiInput = { ...ai.lifecycle, worker: aiSpy.worker };
      await runAgenticCycle(aiInput); ai.setTime(AGENTIC_NOW + 60_000); await ai.instance.heartbeat(); await runAgenticCycle(aiInput);
      zero(aiSpy.reads, aiTables);
      if (withMeme) assert.ok(memeAi.includes("market-order quote") && aiTables.includes("insertMemeLog"), "the meme step did run beside the AI agent");
      digests["ai"] = sha({ runs: (await ai.positions.listRuns(W, ai.agent.id, 50)).map((run) => [run.reason, run.events]), calls: ai.runner.calls, wallet: { ...(await ai.store.byAgent(ai.agent.id))!, sessionCiphertext: null } });
      const schedule = await scheduleWorld(context);
      if (withMeme) await addMemeWallet(schedule.f, guard);
      const scheduleSpy = memeReadSpy(schedule.input.worker), scheduleTables = memeTableSpy(schedule.f.store);
      const scheduleInput = { ...schedule.input, worker: scheduleSpy.worker };
      await runAgenticCycle(scheduleInput); await schedule.at(AGENTIC_NOW + 60_000); await runAgenticCycle(scheduleInput);
      zero(scheduleSpy.reads, scheduleTables);
      digests["schedule"] = sha({ runs: (await schedule.f.positions.listRuns(W, schedule.f.agent.id, 50)).map((run) => [run.reason, run.events]), calls: schedule.f.runner.calls,
        intents: (await schedule.f.intents.listSchedule(W, schedule.f.agent.id)).map((intent) => [intent.scheduleSlot, intent.state, intent.amountWei]), positions: await schedule.f.positions.list(W, schedule.f.agent.id) });
      const portfolio = await portfolioLane(context);
      if (withMeme) await addMemeWallet(portfolio.f, guard);
      const portfolioSpy = memeReadSpy(portfolio.input.worker), portfolioTables = memeTableSpy(portfolio.f.store);
      const portfolioInput = { ...portfolio.input, worker: portfolioSpy.worker };
      await runAgenticCycle(portfolioInput); await portfolio.at(AGENTIC_NOW + 60_000); await runAgenticCycle(portfolioInput);
      zero(portfolioSpy.reads, portfolioTables);
      assert.ok(portfolio.swaps.length > 0, "the portfolio basket bought");
      digests["portfolio"] = sha({ runs: (await portfolio.f.positions.listRuns(W, portfolio.f.agent.id, 50)).map((run) => [run.reason, run.events]), swaps: portfolio.swaps, quotes: portfolio.quotes,
        intents: await portfolio.f.intents.listPortfolio(W, portfolio.f.agent.id) });
      const dca = await dcaLane(context);
      if (withMeme) await addMemeWallet(dca.f, guard);
      const dcaSpy = memeReadSpy(dca.input.worker), dcaTables = memeTableSpy(dca.f.store);
      const dcaInput = { ...dca.input, worker: dcaSpy.worker };
      await runAgenticCycle(dcaInput); await dca.advance(60_000); await runAgenticCycle(dcaInput);
      zero(dcaSpy.reads, dcaTables);
      assert.ok(dca.market.swapCalls().length > 0, "the DCA base bought");
      digests["dca"] = sha({ runs: (await dca.runs()).map((run) => [run.reason, run.events]), rounds: await dca.rounds(), orders: await dca.orders(), swaps: dca.market.swapCalls() });
      return digests;
    }));
  }
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(outputs[2], outputs[0], "a bound paper meme hire with its paper and log rows beside every lane changes none of their outputs");
  check("agentic-lanes", outputs[0]);
});

/** An executor request over a fixture's projected session (the agentic.schedule.test.ts shape). */
async function execute(f: Fixture, request: Record<string, unknown>) {
  const input = { agent: { ...f.agent, sessionFacts: projectAgenticSessionFacts(f.row) }, idempotencyKey: AGENTIC_HASH, paramsHash: AGENTIC_HASH,
    request: { decisionId: "decision", venue: "pancake" as const, side: "buy" as const, token: TOKEN as Address, amountWei: 5n * E, minOutWei: 4_900_000_000_000_000_000n, quotedOutWei: 5n * E,
      settlementAsset: "USDT" as const, platformFeeAtomic: 0n, route: { hops: [], fees: [] }, ...request }, scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: f.executorDeps };
  const result = await executeAgenticTrade(input as unknown as Parameters<typeof executeAgenticTrade>[0], f.execution);
  return { result, calls: f.runner.calls.splice(0) };
}

test("(f) executeAgenticTrade for a non-meme hire is byte-equal (argv and refusals)", async (t) => {
  let uuid = 0;
  t.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const out: unknown[] = [];
  for (const [flag, withMeme] of [[false, false], [true, false], [true, true]] as const) {
    uuid = 0;
    out.push(await withFlag(flag, async () => {
      const cases: unknown[] = [];
      const f = await fixture(t);
      if (withMeme) await addMemeWallet(f);
      f.balances.native = 1n;
      cases.push(await execute(f, {}));
      f.balances.native = E;
      f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "1", slippage: "0" } });
      cases.push(await execute(f, { decisionId: "below-minimum" }));
      cases.push(await execute(f, { decisionId: "sell-mismatch", side: "sell", amountWei: 3n * E }));
      const held = await fixture(t, { settingsHold: { code: "trade-all-tokens", atMs: AGENTIC_NOW } });
      cases.push(await execute(held, { decisionId: "held" }));
      return JSON.stringify(cases, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    }));
  }
  assert.equal(out[1], out[0]);
  assert.equal(out[2], out[0]);
  check("executor", JSON.parse(out[0] as string));
});

test("(b) the Altana TradFi hire scenario (agentic.altanaGolden.hire) keeps its pinned digest with the meme flag ON (its own run already covers an Agentic agent row beside it)", () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", "test/agentic.altanaGolden.hire.test.ts"], { encoding: "utf8", env: { ...env, AGENTIC_MEME_STOCKS_ENABLED: "true" } });
  assert.equal(run.status, 0, run.stdout.slice(-2_000));
  assert.match(run.stdout, /# pass 1/u);
});

test("(h) lane cadence (R3.2, spec 17): with the meme flag off the lane sleeps exactly the legacy 60 000 - elapsed; on, it aligns to the 25 s phase", async (context) => {
  const delays: Record<string, number[]> = {};
  for (const flag of [false, true]) {
    await withFlag(flag, async () => {
      const f = await fixture(context);
      context.mock.method(Date, "now", () => AGENTIC_NOW);
      const real = globalThis.setTimeout, seen: number[] = [];
      let lane: ReturnType<typeof startAgenticLane> | null = null;
      context.mock.method(globalThis, "setTimeout", ((fn: () => void, ms?: number) => { if ((ms ?? 0) >= 1_000) { seen.push(ms!); lane?.stop(); } return real(fn, 0); }) as unknown as typeof setTimeout);
      lane = startAgenticLane(f.lifecycle, { dryRun: false, once: false });
      await lane.done;
      context.mock.restoreAll();
      delays[String(flag)] = seen;
    });
  }
  // A zero-length cycle at phase 40 000 (AGENTIC_NOW % 60 000): legacy is 60 000; aligned is 45 000, the next 25 000 phase.
  assert.equal(AGENTIC_NOW % 60_000, 40_000);
  assert.deepEqual(delays, { false: [60_000], true: [45_000] });
});

test("(g) source scan (review M6): nothing under src/trade, src/store, src/auth or src/wallet imports the meme lane or names its identifiers", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/u.test(name) ? [path] : []; });
  const offenders = ["src/trade", "src/store", "src/auth", "src/wallet"].flatMap(files).filter(path => {
    const text = readFileSync(path, "utf8");
    return /from\s+["'][^"']*agentic\/meme/u.test(text) || ["memeLane", "memeBrain", "memeData", "agentic_meme_", "hireFacts.meme"].some(id => text.includes(id));
  });
  assert.deepEqual(offenders, []);
});

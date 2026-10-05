/**
 * AGENTIC-RFQ-STOCKS 4.10 and Revisions 3.4, 3.15, 4.1, 4.2, 5.1, 5.1.1 to 5.1.5: the exits of an RFQ-only position, priced only by the Agentic sell quote and decided on a PAIR of readings.
 * One token (AMDB), basis 100 USDT for 1 token: `out(bps)` is the quote of the whole balance at that pnl. The sell script is consumed in call order: [mark, confirming quote, post-model re-quote].
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { keccak256, stringToBytes } from "viem";
import { canonicalEncode } from "../src/auth/canonical.js";
import { applySlippageFloorWei, decideExit, type ExitDecisionInput } from "../src/trade/exits.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { RFQ_CONFIRM_DELAY_MS, confirmationGates, rfqAsk, rfqPeak, rfqPeakArgument, skipsConfirmation, usablePreviousReading } from "../src/trade/rfq.js";
import type { TradeSettings } from "../src/trade/settings.js";
import type { TradeRunEvent } from "../src/store/tradeRunTrace.js";
import { loadRfqUniverse } from "./support/agenticRfq.js";
import { E, HASH, WALLET, fakeRfqStocks, worldHarness, type World } from "./support/agenticRfqWorker.js";

const T = Date.UTC(2026, 9, 2, 15, 45, 0);
const BASIS = 100n * E, TOKENS = E;
const RFQ_ROUTE_KEY = `pancake_v3:${keccak256(stringToBytes(canonicalEncode({ hops: [], fees: [100] })))}`;
const out = (bps: number): bigint => BASIS * BigInt(10_000 + bps) / 10_000n;
const SLIPPAGE = 100;
const floor = (value: bigint): bigint => applySlippageFloorWei(value, SLIPPAGE);

const timered = new WeakSet<TestContext>();
let worlds = 0;
type Step = bigint | string;
type ExitOptions = {
  settings?: Partial<TradeSettings>; mode?: "off" | "log" | "enforce"; script?: Step[]; openedAgoMs?: number; peak?: number | null;
  prior?: { bps: number; ageMs?: number; balance?: bigint; route?: string }; regime?: "risk_off" | "neutral" | "risk_on" | "unavailable"; extraDeps?: Partial<TradeWorkerDeps>;
  snapshotDown?: boolean; entries?: boolean; pooled?: boolean;
};

async function exitWorld(t: TestContext, options: ExitOptions = {}) {
  if (!timered.has(t)) { timered.add(t); t.mock.timers.enable({ apis: ["setTimeout"] }); }
  let now = T, uuid = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  const rows = await loadRfqUniverse(true);
  const token = rows.find((row) => row.symbol === (options.pooled === true ? "NVDAB" : "AMDB"))!.address;
  const script: Step[] = [...(options.script ?? [])];
  const regime = { value: options.regime ?? "unavailable" as const } as { value: "risk_off" | "neutral" | "risk_on" | "unavailable" };
  const asked: { side: string; amount: bigint; at: number }[] = [];
  const fake = fakeRfqStocks({ entries: options.entries ?? false, rfqOnlyAtHire: [token], quote: (call) => {
    asked.push({ side: call.side, amount: call.amountAtomic, at: now });
    if (call.side === "buy") return { ok: false, code: "no-buys-in-this-suite" };
    const next = script.shift();
    return next === undefined ? { ok: false, code: "script-exhausted" } : typeof next === "bigint" ? { ok: true, outAtomic: next } : { ok: false, code: next };
  } });
  let universeDown = false;
  const world = await worldHarness({ agentId: `agentic-rfq-${++worlds}`, now: () => now, rows, custody: "binance-agentic", pinned: rows.map((row) => row.address),
    settings: { maxOpenPositions: 2, stopLossBps: 500, slippageBps: SLIPPAGE, ...options.settings }, balances: new Map([[token.toLowerCase(), TOKENS]]),
    dataPlane: { usEquityRegime: async () => ({ regime: regime.value, reasons: [], asOf: null }), universe: async (lane) => { if (universeDown) throw new Error("data plane down"); return lane === "bstocks" ? rows : []; } },
    extraDeps: { rfqStocks: fake.dep, tradfiExitRulesMode: options.mode ?? "off", ...options.extraDeps } });
  if (options.snapshotDown === true) universeDown = true;
  await world.positions.open({ positionId: "pos-1", agentId: world.agent.id, ownerAddress: world.owner, token, route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: BASIS, tokenAmount: TOKENS,
    fillStatus: "verified", openedAt: T - (options.openedAgoMs ?? 3_600_000), entryTxHash: HASH, crashBasisVerified: true, sessionGeneration: 1, settlementAsset: "USDT",
    requestedEntryAtomic: BASIS, verifiedEntryAtomic: BASIS, receiptOwnershipKey: `56|${HASH}|${WALLET.toLowerCase()}|0|${HASH}` });
  const record = (bps: number | null, atMs: number, peak: number | null = null, balance = TOKENS, route = RFQ_ROUTE_KEY) => world.positions.recordQuote({ ownerAddress: world.owner, agentId: world.agent.id,
    positionId: "pos-1", quoteOutWei: bps === null ? 1n : out(bps), balance, routeKey: route, pnlBps: peak === null ? null : BigInt(peak), atMs, sessionGeneration: 1 });
  if (options.prior !== undefined) await record(options.prior.bps, T - (options.prior.ageMs ?? 60_000), options.peak ?? null, options.prior.balance ?? TOKENS, options.prior.route ?? RFQ_ROUTE_KEY);
  else if (options.peak !== undefined && options.peak !== null) await record(options.peak, T - 120_000, options.peak);
  const position = async () => (await world.positions.list(world.owner, world.agent.id))[0]!;
  const cycle = async (advanceMs = 0): Promise<readonly TradeRunEvent[]> => {
    now += advanceMs;
    let done = false;
    const running = runTradeWorkerOnce(world.deps).finally(() => { done = true; });
    while (!done) { await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.runAll(); }
    await running;
    return (await world.positions.listRuns(world.owner, world.agent.id, 1))[0]?.events ?? [];
  };
  return { world, fake, script, asked, token, position, cycle, record, regime, setNow: (value: number) => { now = value; }, now: () => now, rows };
}
type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;
const codes = (events: readonly TradeRunEvent[], stage: string) => events.filter((event) => event.stage === stage).map((event) => `${event.code}${event.reason === undefined ? "" : `:${event.reason}`}`);
const sells = (world: World) => world.submitted.filter((request) => request.side === "sell");
const askedSells = (w: ExitWorld) => w.asked.filter((entry) => entry.side === "sell").length;

/* ---------------------------------------------------------------------------------------------------------------------------------- the pure pieces */

test("previous reading: usable only with all four fields, the current route and balance, a positive basis and 0 < age <= 900 000 ms", () => {
  const position = (patch: Record<string, unknown> = {}) => ({ lastQuoteWei: out(-100), lastQuoteBalance: TOKENS, lastQuoteRoute: "r", lastQuoteAtMs: T - 60_000, verifiedEntryAtomic: BASIS, ...patch });
  const usable = (patch: Record<string, unknown> = {}, now = T, balance = TOKENS, route = "r") => usablePreviousReading({ position: position(patch) as never, routeKey: route, balance, nowMs: now });
  assert.deepEqual(usable(), { quoteWei: out(-100), pnlBps: -100n });
  assert.ok(usable({ lastQuoteAtMs: T - 900_000 }), "exactly 900 000 ms old is usable");
  assert.equal(usable({ lastQuoteAtMs: T - 900_001 }), null);
  assert.equal(usable({ lastQuoteAtMs: T }), null, "the same instant is not a previous reading (the strict lower bound stops a self-confirmation)");
  assert.equal(usable({ lastQuoteAtMs: T + 1 }), null);
  for (const missing of ["lastQuoteWei", "lastQuoteBalance", "lastQuoteRoute", "lastQuoteAtMs"]) assert.equal(usable({ [missing]: null }), null, missing);
  assert.equal(usable({}, T, TOKENS, "other"), null);
  assert.equal(usable({}, T, TOKENS + 1n), null);
  assert.equal(usable({ verifiedEntryAtomic: null }), null);
  assert.equal(usable({ verifiedEntryAtomic: 0n }), null);
});

test("peak: the stored peak is raised only to the lower of the pair; without a usable previous reading nothing is raised and the in-cycle peak is the stored one (-Infinity when none)", () => {
  assert.equal(rfqPeakArgument(500n, { quoteWei: out(100), pnlBps: 100n }), 100n);
  assert.equal(rfqPeakArgument(50n, { quoteWei: out(100), pnlBps: 100n }), 50n);
  assert.equal(rfqPeakArgument(500n, null), null);
  assert.equal(rfqPeakArgument(null, { quoteWei: 1n, pnlBps: 1n }), null);
  assert.equal(rfqPeak(null, 500n, { quoteWei: out(100), pnlBps: 100n }), 100);
  assert.equal(rfqPeak(300n, 500n, { quoteWei: out(100), pnlBps: 100n }), 300);
  assert.equal(rfqPeak(null, 500n, null), Number.NEGATIVE_INFINITY);
  assert.equal(rfqPeak(250n, 500n, null), 250);
});

test("decideExit: the stop-loss needs the previous reading at or below the line when the input is present; absent input is today's decision", () => {
  const input = (patch: Partial<ExitDecisionInput>): ExitDecisionInput => ({ quoteOutWei: out(-600), entryWei: BASIS, openedAtMs: T - 1, nowMs: T, stopLossBps: 500, takeProfitBps: null, maxHoldSec: null, exitRequestedAt: null, ...patch });
  assert.equal(decideExit(input({})).exit, true, "no input: today's stop-loss");
  assert.equal(decideExit(input({ previousMarkPnlBps: null })).exit, false, "no usable previous reading: hold");
  assert.equal(decideExit(input({ previousMarkPnlBps: -100n })).exit, false);
  assert.equal(decideExit(input({ previousMarkPnlBps: -500n })).exit, true, "exactly at the line");
  assert.equal(decideExit(input({ previousMarkPnlBps: -501n })).exit, true);
  assert.equal(decideExit(input({ previousMarkPnlBps: -499n })).exit, false);
  assert.equal(decideExit(input({ quoteOutWei: out(-499), previousMarkPnlBps: -900n })).exit, false, "the current reading must breach too");
  assert.equal(decideExit(input({ takeProfitBps: 100, quoteOutWei: out(150), previousMarkPnlBps: null })).exit, true, "take-profit stays single-reading");
  assert.equal(decideExit(input({ exitRequestedAt: T, previousMarkPnlBps: null })).exit, true, "an owner request is not a mark decision");
});

test("confirmationGates: no usable previous reading confirms any breach (or a blank threshold); a usable one confirms only a breach it does not share", () => {
  const gate = (patch: Record<string, unknown>) => confirmationGates({ stopLossBps: 500, takeProfitBps: 2_000, maxHoldSec: 86_400, mode: "enforce", openedAtMs: T - 3_600_000, nowMs: T, storedPeak: null, prior: null,
    first: { quoteWei: out(-100), pnlBps: -100n }, prev: null, hasBlankThreshold: false, ...patch } as never);
  assert.deepEqual(gate({}), [], "no breach, no blank threshold: nothing");
  assert.deepEqual(gate({ hasBlankThreshold: true }), ["ask"], "a blank threshold lets the model be asked: confirm first");
  assert.deepEqual(gate({ first: { quoteWei: out(-600), pnlBps: -600n } }), ["stop-loss", "loss-trigger"].filter((name) => name === "stop-loss"), "a stop-loss breach");
  const shared = gate({ first: { quoteWei: out(-600), pnlBps: -600n }, prev: { quoteWei: out(-550), pnlBps: -550n } });
  assert.deepEqual(shared, [], "a shared breach needs no confirmation");
  assert.deepEqual(gate({ first: { quoteWei: out(-600), pnlBps: -600n }, prev: { quoteWei: out(-100), pnlBps: -100n } }), ["stop-loss"], "a disagreeing pair is confirmed");
  assert.deepEqual(gate({ first: { quoteWei: out(150), pnlBps: 150n } }), [], "a peak below +200 arms nothing");
  assert.deepEqual(gate({ first: { quoteWei: out(250), pnlBps: 250n } }), ["peak"], "a peak raised to +200 or more");
  assert.deepEqual(gate({ first: { quoteWei: out(250), pnlBps: 250n }, prev: { quoteWei: out(240), pnlBps: 240n } }), [], "the pair raises the peak together");
  assert.deepEqual(gate({ first: { quoteWei: out(250), pnlBps: 250n }, prev: { quoteWei: out(100), pnlBps: 100n } }), ["peak"]);
  assert.deepEqual(gate({ first: { quoteWei: out(-900), pnlBps: -900n }, stopLossBps: null }), ["loss-trigger"], "a loss trigger needs no feature");
  assert.deepEqual(gate({ first: { quoteWei: out(100), pnlBps: 100n }, storedPeak: 250n, takeProfitBps: null }), ["robot"], "trailing stop: pnl 100 <= peak 250 - 150");
  assert.deepEqual(gate({ first: { quoteWei: out(100), pnlBps: 100n }, storedPeak: 250n, takeProfitBps: null, mode: "log" }), [], "log mode never sells, so it needs no confirmation");
});

test("P2 skipsConfirmation: drain, owner request, crash-stop marker with crash protection on, session-expiring; never a raw stored marker without crash protection", () => {
  const skip = (patch: Record<string, unknown>) => skipsConfirmation({ draining: false, exitRequestedAt: null, autoExitReason: null, crashProtection: false, ...patch } as never);
  assert.deepEqual([skip({}), skip({ draining: true }), skip({ exitRequestedAt: T }), skip({ autoExitReason: "crash-stop", crashProtection: true }),
    skip({ autoExitReason: "crash-stop", crashProtection: false }), skip({ autoExitReason: "session-expiring" })], [false, true, true, true, false, true]);
});

test("rfqAsk: a gain trigger keeps the current reading; a loss or non-price trigger needs a confirmed pair and is shown the HIGHER reading with its quote as the decision mark", () => {
  const prev = { quoteWei: out(-200), pnlBps: -200n };
  assert.deepEqual(rfqAsk({ trigger: "cost-band-breach", pnlBps: 350n, quoteWei: out(350), prev: { quoteWei: out(900), pnlBps: 900n }, confirmFailed: null, storedPeak: 900n }),
    { kind: "ask", askedPnl: 350n, markQuote: out(350) }, "reverse gain test: +350 after +900 is asked at +350");
  assert.deepEqual(rfqAsk({ trigger: "session-boundary", pnlBps: -2_000n, quoteWei: out(-2_000), prev: { quoteWei: out(-100), pnlBps: -100n }, confirmFailed: null, storedPeak: null }),
    { kind: "ask", askedPnl: -100n, markQuote: out(-100) });
  assert.deepEqual(rfqAsk({ trigger: "session-boundary", pnlBps: -240n, quoteWei: out(-240), prev, confirmFailed: null, storedPeak: null }), { kind: "ask", askedPnl: -200n, markQuote: out(-200) });
  assert.deepEqual(rfqAsk({ trigger: "regime-change", pnlBps: 50n, quoteWei: out(50), prev, confirmFailed: null, storedPeak: null }), { kind: "ask", askedPnl: 50n, markQuote: out(50) });
  assert.equal(rfqAsk({ trigger: "session-boundary", pnlBps: -2_000n, quoteWei: out(-2_000), prev: null, confirmFailed: "rfq-unreachable", storedPeak: null }).kind, "hold");
  assert.deepEqual(rfqAsk({ trigger: "session-boundary", pnlBps: -2_000n, quoteWei: out(-2_000), prev: null, confirmFailed: "rfq-unreachable", storedPeak: null }), { kind: "hold", reason: "confirm-failed:rfq-unreachable" });
  assert.equal(rfqAsk({ trigger: "session-boundary", pnlBps: -2_000n, quoteWei: out(-2_000), prev: null, confirmFailed: null, storedPeak: null }).kind, "hold");
  assert.equal(rfqAsk({ trigger: "cost-band-breach", pnlBps: -900n, quoteWei: out(-900), prev: { quoteWei: out(-100), pnlBps: -100n }, confirmFailed: null, storedPeak: null }).kind, "hold", "a loss band needs the previous reading at -800 too");
  assert.equal(rfqAsk({ trigger: "cost-band-breach", pnlBps: -900n, quoteWei: out(-900), prev: { quoteWei: out(-800), pnlBps: -800n }, confirmFailed: null, storedPeak: null }).kind, "ask");
  assert.equal(rfqAsk({ trigger: "peak-giveback", pnlBps: 50n, quoteWei: out(50), prev: { quoteWei: out(250), pnlBps: 250n }, confirmFailed: null, storedPeak: 400n }).kind, "hold", "giveback: prev 250 is not <= peak 400 - 200");
  assert.equal(rfqAsk({ trigger: "peak-giveback", pnlBps: 50n, quoteWei: out(50), prev: { quoteWei: out(150), pnlBps: 150n }, confirmFailed: null, storedPeak: 400n }).kind, "ask");
});

/* ---------------------------------------------------------------------------------------------------------------------------------- pricing and the stop-loss pair */

test("E10 an RFQ position is priced only by the RFQ sell quote of its balance, even when a dust-pool route quote exists; the route event is binance-rfq", async (t) => {
  const w = await exitWorld(t, { script: [out(-100)], settings: { stopLossBps: 500, takeProfitBps: 2_000, maxHoldSec: 86_400 } });
  const events = await w.cycle(60_000);
  assert.deepEqual(w.world.log.directTokens.filter((token) => token === w.token.toLowerCase()), [], "the direct reader is never asked for it");
  assert.deepEqual(w.world.log.flash, []);
  assert.deepEqual(w.fake.calls.map((call) => [call.side, call.amountAtomic]), [["sell", TOKENS]]);
  assert.ok(codes(events, "route").includes("binance-rfq"));
  const row = await w.position();
  assert.deepEqual([row.lastQuoteWei, row.lastQuoteBalance, row.lastQuoteRoute, row.lastQuoteAtMs], [out(-100), TOKENS, RFQ_ROUTE_KEY, T + 60_000]);
});

test("E10 a failed sell quote is cost-unavailable: no exit that cycle and the refusal is recorded; the run log says why", async (t) => {
  const w = await exitWorld(t, { script: ["rfq-refused:SERVICE_ERROR"], prior: { bps: -1_000 } });
  const events = await w.cycle(60_000);
  assert.equal(sells(w.world).length, 0);
  assert.deepEqual(codes(events, "route"), ["binance-refused:rfq-refused:SERVICE_ERROR"]);
  assert.equal((await w.position()).lastSellRefusal, "cost-unavailable");
});

test("R3.4 one outlier below -SL after a normal reading holds, takes one confirming quote after 5 000 ms, and the next normal reading does not exit (reset)", async (t) => {
  const w = await exitWorld(t, { prior: { bps: -150 }, script: [out(-1_000), out(-130), out(-120)] });
  const events = await w.cycle(60_000);
  assert.equal(sells(w.world).length, 0);
  assert.deepEqual(codes(events, "sell").map((code) => code.replace("+loss-trigger", "")), ["rfq-confirm:stop-loss;ok"]);
  assert.equal(askedSells(w), 2);
  const row = await w.position();
  assert.equal(row.lastQuoteWei, out(-130), "the confirming quote is the persisted reading");
  await w.cycle(60_000);
  assert.equal(sells(w.world).length, 0);
  assert.equal(askedSells(w), 3, "one mark and no confirmation the next cycle");
});

test("R3.4 / R4.2 two breaching readings one cycle apart stop out with no confirmation; a breach with no usable previous reading waits 5 000 ms for one and sells at the CONFIRMING quote", async (t) => {
  const pair = await exitWorld(t, { prior: { bps: -1_000 }, script: [out(-1_000)] });
  await pair.cycle(60_000);
  assert.equal(askedSells(pair), 1, "a shared breach needs no confirmation");
  assert.deepEqual(sells(pair.world).map((request) => [request.quotedOutWei, request.minOutWei]), [[out(-1_000), floor(out(-1_000))]]);
  const lone = await exitWorld(t, { script: [out(-1_000), out(-950)] });
  const events = await lone.cycle(60_000);
  assert.equal(askedSells(lone), 2);
  assert.deepEqual(sells(lone.world).map((request) => [request.quotedOutWei, request.minOutWei]), [[out(-950), floor(out(-950))]], "minOut from the confirming quote, not the first reading");
  assert.deepEqual(codes(events, "sell").filter((code) => code.startsWith("rfq-confirm")).map((code) => code.replace("+loss-trigger", "")), ["rfq-confirm:stop-loss;ok"]);
});

test("R4.2 the pause is exactly RFQ_CONFIRM_DELAY_MS: the confirming quote is not taken at 4 999 ms and is taken at 5 000 ms", async (t) => {
  const w = await exitWorld(t, { script: [out(-1_000), out(-950)] });
  let done = false;
  const running = runTradeWorkerOnce(w.world.deps).finally(() => { done = true; });
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(askedSells(w), 1, "the mark is taken, the confirmation is waiting");
  t.mock.timers.tick(RFQ_CONFIRM_DELAY_MS - 1);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(askedSells(w), 1, "not at 4 999 ms");
  t.mock.timers.tick(1);
  while (!done) { await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.runAll(); }
  await running;
  assert.equal(askedSells(w), 2);
  assert.equal(RFQ_CONFIRM_DELAY_MS, 5_000);
});

test("R4.2 a failed confirmation holds, persists the FIRST reading with no peak, logs failed:<code>, and the next breaching reading within 900 s stops out with no second confirmation", async (t) => {
  for (const code of ["rfq-unreachable", "rfq-throttled", "rfq-wallet-busy"]) {
    const w = await exitWorld(t, { script: [out(-1_000), code, out(-1_000)] });
    const events = await w.cycle(60_000);
    assert.equal(sells(w.world).length, 0, code);
    assert.deepEqual(codes(events, "sell").filter((c) => c.startsWith("rfq-confirm")).map((c) => c.replace("+loss-trigger", "")), [`rfq-confirm:stop-loss;failed:${code}`]);
    const row = await w.position();
    assert.deepEqual([row.lastQuoteWei, row.peakPnlBps], [out(-1_000), null]);
    await w.cycle(60_000);
    assert.equal(askedSells(w), 3, `${code}: one mark the next cycle`);
    assert.equal(sells(w.world).length, 1, code);
  }
});

test("R4.2 a usable previous reading that agrees takes no extra call whatever the reading; with fully set thresholds and no breach a missing previous reading takes none either", async (t) => {
  const settings = { stopLossBps: 500, takeProfitBps: 2_000, maxHoldSec: 86_400 };
  const usable = await exitWorld(t, { settings, prior: { bps: -100 }, script: [out(-200)] });
  await usable.cycle(60_000);
  assert.equal(askedSells(usable), 1);
  const none = await exitWorld(t, { settings, script: [out(-200)] });
  await none.cycle(60_000);
  assert.equal(askedSells(none), 1);
  const blank = await exitWorld(t, { script: [out(-200), out(-210)] });
  await blank.cycle(60_000);
  assert.equal(askedSells(blank), 2, "a blank threshold with no previous reading confirms before the model could be asked (R5.4)");
});

test("R5.5 a disagreeing usable previous reading still takes one confirmation per cycle (-300 / -1800 alternating), and stops out on the first cycle whose confirmation also reads at or below -SL", async (t) => {
  const w = await exitWorld(t, { prior: { bps: -300 }, script: [out(-1_800), out(-300), out(-1_800), out(-300), out(-1_800), out(-1_700)] });
  for (const cycleNo of [1, 2]) {
    await w.cycle(60_000);
    assert.equal(askedSells(w), cycleNo * 2, `cycle ${cycleNo}: mark plus one confirmation`);
    assert.equal(sells(w.world).length, 0);
  }
  await w.cycle(60_000);
  assert.equal(sells(w.world).length, 1, "the confirmation at -1700 agrees with the mark");
  assert.equal(sells(w.world)[0]!.quotedOutWei, out(-1_700));
});

test("P2 an owner request, a drain and a crash-stop marker with crash protection never wait for a confirming quote and sell on the first reading; the same marker without crash protection is a stop-loss breach and confirms", async (t) => {
  const requested = await exitWorld(t, { script: [out(-1_000)] });
  await requested.world.positions.requestExit(requested.world.owner, requested.world.agent.id, "pos-1");
  await requested.cycle(60_000);
  assert.equal(askedSells(requested), 1);
  assert.equal(sells(requested.world).length, 1);
  const drained = await exitWorld(t, { script: [out(-1_000)] });
  await drained.world.settingsStore.requestDrain(drained.world.owner, drained.world.agent.id);
  await drained.cycle(60_000);
  assert.equal(askedSells(drained), 1);
  assert.equal(sells(drained.world).length, 1);
  for (const crashProtection of [true, false]) {
    const w = await exitWorld(t, { script: [out(-1_000), out(-950)], settings: { crashProtection } });
    const row = await w.position();
    await w.world.positions.recordCrashEvidence({ ownerAddress: w.world.owner, agentId: w.world.agent.id, positionId: "pos-1", writerGeneration: 1,
      expected: { sessionGeneration: row.sessionGeneration ?? 0, lastQuoteWei: row.lastQuoteWei, lastQuoteBalance: row.lastQuoteBalance, lastQuoteRoute: row.lastQuoteRoute, lastQuoteAtMs: row.lastQuoteAtMs,
        crashPendingSinceMs: row.crashPendingSinceMs, crashPendingKind: row.crashPendingKind, crashRefQuoteWei: row.crashRefQuoteWei, crashRefBalance: row.crashRefBalance, crashRefAtMs: row.crashRefAtMs,
        crashRefRoute: row.crashRefRoute, autoExitReason: row.autoExitReason, autoExitAtMs: row.autoExitAtMs, autoExitNote: row.autoExitNote },
      action: { kind: "marker", reason: "crash-stop", atMs: T - 1_000, note: "test" } });
    await w.cycle(60_000);
    assert.equal(askedSells(w), crashProtection ? 1 : 2, `crash protection ${crashProtection}`);
  }
});

/* ---------------------------------------------------------------------------------------------------------------------------------- the robot rules and the peak */

test("R3.15 trailing stop in enforce mode needs the same rule on both readings; one outlier holds with rule:hold-confirm, two readings sell; log mode logs would-exit only when confirmed", async (t) => {
  const settings = { stopLossBps: null, takeProfitBps: null, maxHoldSec: null };
  const both = await exitWorld(t, { settings, mode: "enforce", peak: 300, prior: { bps: 100 }, script: [out(100)] });
  await both.cycle(60_000);
  assert.deepEqual(sells(both.world).map((request) => request.quotedOutWei), [out(100)], "pnl +100 <= peak 300 - 150 on both readings");
  assert.equal(askedSells(both), 1);
  const outlier = await exitWorld(t, { settings, mode: "enforce", peak: 300, prior: { bps: 250 }, script: [out(100), out(240)] });
  await outlier.cycle(60_000);
  assert.equal(sells(outlier.world).length, 0, "the confirming quote reads +240: no trailing stop");
  const held = await exitWorld(t, { settings, mode: "enforce", peak: 300, prior: { bps: 250 }, script: [out(100), "rfq-unreachable"] });
  const heldEvents = await held.cycle(60_000);
  assert.equal(sells(held.world).length, 0);
  assert.ok(codes(heldEvents, "exit-llm").some((code) => code.startsWith("rule:hold-confirm")), codes(heldEvents, "exit-llm").join("|"));
  const log = await exitWorld(t, { settings, mode: "log", peak: 300, prior: { bps: 100 }, script: [out(100)] });
  assert.ok(codes(await log.cycle(60_000), "exit-llm").some((code) => code.startsWith("rule:would-exit:trailing-stop")));
  const logHeld = await exitWorld(t, { settings, mode: "log", peak: 300, prior: { bps: 250 }, script: [out(100), "rfq-unreachable"] });
  assert.ok(codes(await logHeld.cycle(60_000), "exit-llm").some((code) => code.startsWith("rule:hold-confirm")));
});

test("R3.15 the stale exit (held 48 h or more, pnl <= +100) needs both readings at or below +100", async (t) => {
  const settings = { stopLossBps: null, takeProfitBps: null, maxHoldSec: null };
  const openedAgoMs = 49 * 3_600_000;
  const both = await exitWorld(t, { settings, mode: "enforce", openedAgoMs, prior: { bps: 50 }, script: [out(50)] });
  await both.cycle(60_000);
  assert.equal(sells(both.world).length, 1);
  const outlier = await exitWorld(t, { settings, mode: "enforce", openedAgoMs, prior: { bps: 200 }, script: [out(50), out(180)] });
  await outlier.cycle(60_000);
  assert.equal(sells(outlier.world).length, 0, "one reading at +50 after +200: the confirmation reads +180");
  const disagreeing = await exitWorld(t, { settings, mode: "enforce", openedAgoMs, prior: { bps: 200 }, script: [out(50), "rfq-unreachable"] });
  await disagreeing.cycle(60_000);
  assert.equal(sells(disagreeing.world).length, 0, "+50 after +200 with no confirmation holds");
});

test("R5.1.5 an upward outlier leaves the stored peak unchanged and the in-cycle peak at the lower reading: no trailing-stop arm, no hold-confirm", async (t) => {
  const w = await exitWorld(t, { settings: { stopLossBps: null, takeProfitBps: null, maxHoldSec: null }, mode: "enforce", prior: { bps: 100 }, script: [out(500), "rfq-unreachable"] });
  const events = await w.cycle(60_000);
  const row = await w.position();
  assert.equal(row.peakPnlBps, 100n, "min(500, 100) = 100 is what the peak argument carried");
  assert.equal(sells(w.world).length, 0);
  assert.ok(!codes(events, "exit-llm").some((code) => code.startsWith("rule:")), codes(events, "exit-llm").join("|"));
});

test("R4.2 a peak reading of +150 with no usable previous reading takes no confirmation, +250 takes one", async (t) => {
  const settings = { stopLossBps: 500, takeProfitBps: 2_000, maxHoldSec: 86_400 };
  const low = await exitWorld(t, { settings, script: [out(150)] });
  await low.cycle(60_000);
  assert.equal(askedSells(low), 1);
  const high = await exitWorld(t, { settings, script: [out(250), out(255)] });
  await high.cycle(60_000);
  assert.equal(askedSells(high), 2);
  assert.equal((await high.position()).peakPnlBps, 250n, "the stored peak is the lower of confirmation 255 and mark 250");
});

/* ---------------------------------------------------------------------------------------------------------------------------------- the exit model: triggers, asked pnl, the M1 hold */

const BLANK = { stopLossBps: null, takeProfitBps: null, maxHoldSec: null };
async function forceSessionTrigger(w: ExitWorld) {
  await w.world.positions.setExitLlmContext(w.world.owner, w.world.agent.id, "pos-1", { askedAtMs: T - 7_200_000, pnlBps: -200, peakPnlBps: null, macdHistSign: null, emaSpreadSign: null,
    regime: "risk_off", session: "close", trigger: "none" });
}
const exitPrompts = (w: ExitWorld) => w.world.log.llm.filter((entry) => entry.exit);

test("R4.1 a non-price trigger on one reading at -2000 after a reading at -100 is asked at -100 (the confirmation reads -100): the brake holds a loss inside -800; two readings at -2000 are asked at -2000 and sell", async (t) => {
  const outlier = await exitWorld(t, { settings: BLANK, regime: "unavailable", prior: { bps: -100 }, script: [out(-2_000), out(-100)] });
  await forceSessionTrigger(outlier);
  const events = await outlier.cycle(60_000);
  assert.equal(exitPrompts(outlier).length, 1, "asked once");
  assert.ok(exitPrompts(outlier)[0]!.content.includes("-100 (loss)"), "the model sees the higher reading");
  assert.equal(sells(outlier.world).length, 0, "tradfiExitAllowed holds a -100 loss inside the -800 review band");
  assert.ok(codes(events, "exit-llm").some((code) => code.startsWith("hold-guard")), codes(events, "exit-llm").join("|"));
  const pair = await exitWorld(t, { settings: BLANK, regime: "risk_off", prior: { bps: -2_000 }, script: [out(-2_000), out(-2_000)] });
  await forceSessionTrigger(pair);
  await pair.cycle(60_000);
  assert.ok(exitPrompts(pair)[0]!.content.includes("-2000 (loss)"));
  assert.equal(sells(pair.world).length, 1);
});

test("R4.1 / R5.4 a non-price trigger with no usable previous reading and a failing confirmation is not asked: trigger:hold-confirm, reason confirm-failed:<code>, and no ask context is written", async (t) => {
  const w = await exitWorld(t, { settings: BLANK, regime: "risk_off", script: [out(-2_000), "rfq-unreachable"] });
  await forceSessionTrigger(w);
  const before = (await w.position()).exitLlmContext;
  const events = await w.cycle(60_000);
  assert.equal(exitPrompts(w).length, 0, "the model is not asked");
  assert.ok(codes(events, "exit-llm").includes("trigger:hold-confirm:confirm-failed:rfq-unreachable"), codes(events, "exit-llm").join("|"));
  assert.deepEqual((await w.position()).exitLlmContext, before, "the trigger is not consumed");
});

test("R3.15 a loss trigger needs both readings: one outlier at -900 after a normal reading is not asked; two readings at or below -800 are; peak-giveback likewise", async (t) => {
  const outlier = await exitWorld(t, { settings: BLANK, prior: { bps: -100 }, script: [out(-900), "rfq-unreachable"] });
  const events = await outlier.cycle(60_000);
  assert.equal(exitPrompts(outlier).length, 0);
  assert.ok(codes(events, "exit-llm").some((code) => code.startsWith("trigger:hold-confirm")), codes(events, "exit-llm").join("|"));
  assert.equal((await outlier.position()).exitLlmContext ?? null, null, "no context written, so the trigger is not consumed");
  const pair = await exitWorld(t, { settings: BLANK, prior: { bps: -850 }, script: [out(-900)] });
  await pair.cycle(60_000);
  assert.equal(exitPrompts(pair).length, 1);
  const giveback = await exitWorld(t, { settings: BLANK, peak: 400, prior: { bps: 250 }, script: [out(50), "rfq-unreachable"] });
  await giveback.cycle(60_000);
  assert.equal(exitPrompts(giveback).length, 0, "giveback on one reading: prev +250 is not <= peak 400 - 200");
  const both = await exitWorld(t, { settings: BLANK, peak: 400, prior: { bps: 150 }, script: [out(50)] });
  await both.cycle(60_000);
  assert.equal(exitPrompts(both).length, 1);
});

test("R5.2 a gain trigger stays single-reading and is asked at the CURRENT reading: +350 after +900 is asked at +350, never at the previous +900", async (t) => {
  const w = await exitWorld(t, { settings: BLANK, peak: 900, prior: { bps: 900 }, script: [out(350), out(340)] });
  await w.cycle(60_000);
  assert.equal(exitPrompts(w).length, 1);
  assert.match(exitPrompts(w)[0]!.content, /\+350 \(gain\)/u);
  assert.equal((await w.position()).exitLlmContext?.pnlBps, 350);
  const gain = await exitWorld(t, { settings: BLANK, prior: { bps: 100 }, script: [out(400), out(400)] });
  await gain.cycle(60_000);
  assert.match(exitPrompts(gain)[0]!.content, /\+400 \(gain\)/u, "a gain trigger at +400 after +100 is asked at +400");
});

/** The R5.1.9 vector: previous 98.00 (-200), current 97.60 (-240), a non-price trigger, so the asked pnl is the previous reading's and the decision mark 98.00. */
async function m1World(t: TestContext, requotes: Step[], extra: ExitOptions = {}) {
  const w = await exitWorld(t, { settings: BLANK, regime: "risk_off", prior: { bps: -200 }, script: [out(-240), ...requotes], ...extra });
  await forceSessionTrigger(w);
  return w;
}

test("R5.1 M1: the post-model re-quote at 97.50 is above the owner's floor of the decision mark 98.00 x 0.99 = 97.02, so the sale proceeds; a re-quote at 96.50 is held with reason asked-mark", async (t) => {
  const ok = await m1World(t, [BASIS * 9_750n / 10_000n]);
  await ok.cycle(60_000);
  assert.equal(sells(ok.world).length, 1);
  assert.equal(sells(ok.world)[0]!.quotedOutWei, BASIS * 9_750n / 10_000n);
  const held = await m1World(t, [BASIS * 9_650n / 10_000n]);
  const events = await held.cycle(60_000);
  assert.equal(sells(held.world).length, 0);
  assert.ok(codes(events, "route").includes("binance-refused:asked-mark"), codes(events, "route").join("|"));
  const reference = out(-200) * 99n / 100n;
  assert.equal(reference, 9_702n * E / 100n, "98.00 x 0.99 = 97.02");
});

test("R5.1.1 the escape is time-bounded and consumed only by a dispatch: hold at t, the next breach at t + 60 000 sells, a further breach at t + 120 000 is held again", async (t) => {
  const low = BASIS * 9_650n / 10_000n;
  const w = await m1World(t, [low, low, low, low]);
  await w.cycle(60_000);
  assert.equal(sells(w.world).length, 0, "held at t");
  await forceSessionTrigger(w);
  w.script.unshift(out(-240)); w.script.splice(1, 0, low);
  // the previous cycle persisted its mark (97.60 = -240); the next mark is -240 again, the model-approved re-quote is below the floor of the NEW decision mark, so only the escape lets it through
  await w.cycle(60_000);
  assert.equal(sells(w.world).length, 1, "the held position sells at the next model-approved breach within 900 s");
});

test("R5.1.1 the escape lapses after 900 000 ms (honoured at exactly 900 000, held at 900 001) and a failed re-quote does not consume it", async (t) => {
  const low = BASIS * 9_600n / 10_000n;
  for (const [gap, sells_] of [[900_000, 1], [900_001, 0]] as const) {
    const w = await m1World(t, [low]);
    await w.cycle(60_000);
    assert.equal(sells(w.world).length, 0);
    await forceSessionTrigger(w);
    w.script.splice(0, w.script.length, out(-240), low);
    await w.cycle(gap);
    assert.equal(sells(w.world).length, sells_, `gap ${gap}`);
  }
  const failed = await m1World(t, [low]);
  await failed.cycle(60_000);
  await forceSessionTrigger(failed);
  failed.script.splice(0, failed.script.length, out(-240), "rfq-unreachable");
  await failed.cycle(60_000);
  assert.equal(sells(failed.world).length, 0, "the re-quote failed: nothing sold, nothing consumed");
  await forceSessionTrigger(failed);
  failed.script.splice(0, failed.script.length, out(-240), low);
  await failed.cycle(60_000);
  assert.equal(sells(failed.world).length, 1, "the escape survived the failed re-quote");
});

test("R5.1.1 a dispatch that fails downstream leaves no escape: the next breach is held again", async (t) => {
  const low = BASIS * 9_650n / 10_000n;
  const denied: TradeWorkerDeps["executor"] = { execute: async (request) => { void request; return { kind: "denied", status: 409, code: "AGENTIC_QUOTE_BELOW_MIN" }; } };
  const w = await m1World(t, [low], { extraDeps: {} });
  await w.cycle(60_000);
  await forceSessionTrigger(w);
  (w.world.deps as { executor: unknown }).executor = denied;
  w.script.splice(0, w.script.length, out(-240), low);
  await w.cycle(60_000);
  assert.equal(w.world.submitted.filter((request) => request.side === "sell").length, 0, "the escape lets it through but the executor refuses");
  await forceSessionTrigger(w);
  w.script.splice(0, w.script.length, out(-240), low);
  const events = await w.cycle(60_000);
  assert.ok(codes(events, "route").includes("binance-refused:asked-mark"), "no escape is left: held again");
});

test("R5.1 an owner stop-loss or a robot exit at the pricing site is never held by the asked-mark rule, and a pooled position keeps today's path", async (t) => {
  const stop = await exitWorld(t, { prior: { bps: -1_000 }, script: [out(-1_000)] });
  const events = await stop.cycle(60_000);
  assert.equal(sells(stop.world).length, 1);
  assert.ok(!codes(events, "route").some((code) => code.includes("asked-mark")));
});

/* ---------------------------------------------------------------------------------------------------------------------------------- scope */

test("flag off (entries false) keeps exits and marks; with the snapshot unreadable the hire-time RFQ-only set decides", async (t) => {
  const w = await exitWorld(t, { entries: false, snapshotDown: true, script: [out(-100)], prior: { bps: -100 } });
  await w.cycle(60_000);
  assert.deepEqual(w.fake.calls.map((call) => call.side), ["sell"], "the unreadable snapshot falls back to the hire-time set: still an RFQ position");
});

test("a pooled position of an RFQ-active agent is priced and decided as today: no RFQ quote, no confirmation, the direct route", async (t) => {
  const w = await exitWorld(t, { pooled: true, script: [] });
  await w.cycle(60_000);
  assert.equal(w.fake.calls.length, 0);
  assert.ok(w.world.log.directTokens.includes(w.token.toLowerCase()), "the pooled stock is priced by the route reader");
});

test("the sell-all drain sells an RFQ position at the RFQ sell quote", async (t) => {
  const w = await exitWorld(t, { script: [out(-50)] });
  await w.world.settingsStore.requestDrain(w.world.owner, w.world.agent.id);
  await w.cycle(60_000);
  assert.deepEqual(sells(w.world).map((request) => request.quotedOutWei), [out(-50)]);
});

test("R3.4 a stop-loss awaiting its second reading is not offered to the exit model this cycle (no ask, no trigger, nothing written)", async (t) => {
  const w = await exitWorld(t, { settings: { stopLossBps: 500, takeProfitBps: null, maxHoldSec: null }, prior: { bps: -100 }, script: [out(-1_000), "rfq-unreachable"] });
  const events = await w.cycle(60_000);
  assert.equal(sells(w.world).length, 0);
  assert.equal(exitPrompts(w).length, 0, "the model is not asked");
  assert.deepEqual(codes(events, "exit-llm").filter((code) => code.startsWith("trigger")), []);
  assert.equal((await w.position()).exitLlmContext ?? null, null);
});

test("R5.1.4 the asked pnl is carried everywhere: the prompt shows the HIGHER reading, the stored ask context holds it, and the loss brake is evaluated on it", async (t) => {
  const w = await m1World(t, [BASIS * 9_750n / 10_000n]);
  await w.cycle(60_000);
  assert.equal(exitPrompts(w).length, 1);
  assert.ok(exitPrompts(w)[0]!.content.includes("-200 (loss)"), "the prompt shows -200, the higher reading, not the current -240");
  assert.ok(!exitPrompts(w)[0]!.content.includes("-240"), "the lower reading is never shown");
  assert.equal((await w.position()).exitLlmContext?.pnlBps, -200, "the stored context holds the asked pnl");
  // Brake: previous -700 (inside the -800 review band) and current -950 (beyond it) with a session trigger: the sale is judged on the asked -700 and held; the current alone would sell.
  const brake = await exitWorld(t, { settings: BLANK, regime: "unavailable", prior: { bps: -700 }, script: [out(-950), out(-950), out(-950)] });
  await brake.world.positions.setExitLlmContext(brake.world.owner, brake.world.agent.id, "pos-1", { askedAtMs: T - 7_200_000, pnlBps: -900, peakPnlBps: null, macdHistSign: null, emaSpreadSign: null, regime: "unavailable", session: "close", trigger: "none" });
  const events = await brake.cycle(60_000);
  assert.equal(exitPrompts(brake).length, 1, codes(events, "exit-llm").join("|"));
  assert.ok(exitPrompts(brake)[0]!.content.includes("-700 (loss)"), "asked at the higher reading -700");
  assert.equal(sells(brake.world).length, 0, "the brake is evaluated on the asked -700, inside the review band");
  assert.ok(codes(events, "exit-llm").some((code) => code.startsWith("hold-guard")), codes(events, "exit-llm").join("|"));
});

test("R3.15 audit F2: the previous reading must return the SAME rule: current fires the trailing stop, previous only the stale exit, so nothing is sold and rule:hold-confirm is logged", async (t) => {
  const settings = { stopLossBps: null, takeProfitBps: null, maxHoldSec: null };
  const openedAgoMs = 49 * 3_600_000;
  // Peak 220: +50 is under 220 - 150 = 70 (trailing stop), +90 is not (it only meets the stale ceiling of +100). The first reading +50 disagrees with the previous +90, so one confirming quote is taken and reads +90:
  // the current reading then fires the stale exit while the first reading fires the trailing stop, and a pair of different rules sells nothing.
  const w = await exitWorld(t, { settings, mode: "enforce", openedAgoMs, peak: 220, prior: { bps: 90 }, script: [out(50), out(90)] });
  const events = await w.cycle(60_000);
  assert.equal(sells(w.world).length, 0, "different rules on the two readings are not a confirmation");
  assert.ok(codes(events, "exit-llm").some((code) => code.startsWith("rule:hold-confirm")), codes(events, "exit-llm").join("|"));
  const same = await exitWorld(t, { settings, mode: "enforce", openedAgoMs, peak: 220, prior: { bps: 60 }, script: [out(50)] });
  await same.cycle(60_000);
  assert.equal(sells(same.world).length, 1, "the same rule on both readings sells");
});

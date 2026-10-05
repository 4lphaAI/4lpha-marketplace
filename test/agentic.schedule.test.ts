/** AGENTIC-SCHEDULE: golden pins of today's AI behaviour (captured on the pristine tree) and the Schedule port's plane tests (params, gate, executor, holds, public view). */
import assert from "node:assert/strict";
import test from "node:test";
import { type Address } from "viem";
import { parseTradeSettings, type TradeSettings } from "../src/trade/settings.js";
import { agenticGate, agenticGateInput, agenticHireIdentity, parseAgenticHireParams, projectAgenticSessionFacts, type AgenticFactsRead } from "../src/agentic/domain.js";
import { executeAgenticTrade, readAgenticSettings } from "../src/agentic/execute.js";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { E, FACTS, HASH, NOW, PAIRING, TOKEN, W, aiParams, fixture, scheduleParams, sha, type Fixture } from "./support/agenticSchedule.js";

const body = (settings: TradeSettings, extra: Record<string, unknown> = {}) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings, ...extra });
const gateFor = (settings: TradeSettings, facts: Partial<AgenticFactsRead> = {}, term: 7 | 30 = 7, nowMs = NOW) =>
  agenticGate(agenticGateInput(parseAgenticHireParams(body(settings, { term }))!, { ...FACTS, ...facts }, "0x1111111111111111111111111111111111111111", nowMs));
const row = (code: string, rows: { code: string; state: string; fix: string }[]) => rows.find(r => r.code === code);

test("GOLDEN AI: agenticGate rows, order, states and fixes for an AI input are the pristine ones", () => {
  const rows: unknown[] = [];
  for (const [patch, capital, entry, maxOpen, term] of [[{}, 100n, 20n, 10, 7], [{ x402DailyLimit: 0.49, bnbWei: "1" }, 10n, 8n, 2, 30], [{ status: "UNCONNECTED", quotaUsed: 999 }, 100n, 20n, 3, 7]] as const) {
    const result = agenticGate({ wallet: "0x1111111111111111111111111111111111111111", facts: { ...FACTS, ...patch }, capitalQuoteWei: capital * E, maxOpenPositions: maxOpen,
      entryWei: entry * E, termSec: term * 86_400, nowMs: NOW, budgetWei: BigInt(term === 7 ? 2 : 8) * E });
    rows.push(result);
  }
  assert.equal(sha(rows), "c66ab6eb2616f082adf043f09f960e5d8dcddc68b80e6c3fb35d876784f79e71");
});

test("GOLDEN AI: hire facts, stage markers, CMC budget and stored settings are the pristine ones", async t => {
  const f = await fixture(t, { state: "paired", hireFacts: null, hireOpId: null, agentId: null, hireStage: null, acceptedAt: null, hireEndMs: null, entryCutoffMs: null, termEndAction: null });
  const request = { ...f.row.hireParams!, pairingId: f.row.pairingId };
  const stages: unknown[] = [];
  const patch = f.store.patchWallet.bind(f.store);
  t.mock.method(f.store, "patchWallet", async (current: Parameters<typeof patch>[0], change: Parameters<typeof patch>[1]) => { if (change.hireStage !== undefined) stages.push(change.hireStage); return patch(current, change); });
  const hired = await f.pairings.hire(f.row, request);
  const budget = await f.cmcStore.get(hired.agentId!, W);
  assert.equal(hired.agentId, agenticHireIdentity(request).agentId);
  assert.equal(sha({ stages, state: hired.state, hireStage: hired.hireStage, hireFacts: hired.hireFacts, hireEndMs: hired.hireEndMs, entryCutoffMs: hired.entryCutoffMs,
    budget, settings: (await f.settings.get(W, hired.agentId!))?.params, projected: projectAgenticSessionFacts(hired) }), "4ba35fcf86c4d22997c90457c0ebc9e8b46a4a5c81fd47a02f18b22c3beb229f");
});

test("GOLDEN AI: the public DTO of a bound AI agent is the pristine one (no schedule key)", async t => {
  const f = await fixture(t);
  await f.positions.open({ positionId: "one", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW });
  await f.positions.insertRun({ agentId: f.agent.id, ownerAddress: W, dryRun: false, reason: "entered;a=1", events: [{ stage: "cycle", code: "committed", elapsedMs: 0 }] });
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch, observer: { observe: async () => [] } });
  const dto = await view(W);
  assert.equal(Object.hasOwn(dto.agent as object, "schedule"), false);
  // Run ids are random store uuids; every other byte is the DTO.
  assert.equal(sha({ ...dto, agent: { ...dto.agent, runs: dto.agent!.runs.map(run => ({ ...run, id: "run" })) } }), "9dd50bef86128401d2a7f574c2fae0e16942c2044de6bc06cb549c14db12421b");
});

/** An executor buy request over a fixture's projected session, with a quote below the minimum so the order seals right after the BNB floor. */
async function buyAfterFloor(f: Fixture, native: bigint, opens: number) {
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "1", slippage: "0" } });
  for (let i = 0; i < opens; i += 1) await f.positions.open({ positionId: "p" + i, agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW + i });
  const input = { agent: { ...f.agent, sessionFacts: projectAgenticSessionFacts(f.row) }, idempotencyKey: HASH, paramsHash: HASH,
    request: { decisionId: "decision", venue: "pancake" as const, side: "buy" as const, token: TOKEN as Address, amountWei: 5n * E, minOutWei: 4_900_000_000_000_000_000n, quotedOutWei: 5n * E,
      settlementAsset: "USDT" as const, platformFeeAtomic: 0n, route: { hops: [], fees: [] } }, scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: f.executorDeps };
  f.balances.native = native;
  const result = await executeAgenticTrade(input as unknown as Parameters<typeof executeAgenticTrade>[0], f.execution);
  return result.kind === "denied" ? { kind: result.kind, code: result.code } : { kind: result.kind, code: result.kind === "rolled-back" ? result.code : null };
}
const FLOOR = 3n * 400_000_000_000_000n;

test("GOLDEN AI: the executor BNB floor stays (open + 2) x 0.0004 for an AI buy", async t => {
  const f = await fixture(t);
  assert.deepEqual(await buyAfterFloor(f, 7n * 400_000_000_000_000n - 1n, 5), { kind: "denied", code: "AGENTIC_LOW_BNB" });
  assert.deepEqual(await buyAfterFloor(f, 7n * 400_000_000_000_000n, 0), { kind: "rolled-back", code: "AGENTIC_QUOTE_BELOW_MIN" });
});

test("P1 params: a Schedule tuple with keep is accepted; sell-all, CMC and an AI body keep their rules", () => {
  assert.equal(parseTradeSettings(scheduleParams).ok, true);
  assert.ok(parseAgenticHireParams(body(scheduleParams)));
  assert.equal(parseAgenticHireParams(body(scheduleParams, { termEndAction: "sell-all" })), null);
  assert.equal(parseAgenticHireParams(body({ ...scheduleParams, cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E).toString() })), null);
  assert.equal(parseAgenticHireParams(body({ ...scheduleParams, scheduleIntervalSec: 604_800 as 3600 })), null);
  assert.ok(parseAgenticHireParams(body(aiParams)));
  assert.equal(parseAgenticHireParams(body(aiParams, { term: 30 })), null);
  assert.equal(parseAgenticHireParams(body({ ...aiParams, cmcNewsEnabled: false })), null);
});

test("G1 gate: BNB need is 0.0012 plus 0.0004 per buy the term can run, and the first two vectors are exact", () => {
  const need = (settings: TradeSettings, term: 7 | 30) => {
    // The `Have x BNB, need y BNB` text carries the exact need.
    return /need ([0-9.]+) BNB/.exec(row("bnb", gateFor(settings, { bnbWei: "0" }, term).rows)!.fix)![1];
  };
  assert.equal(need(scheduleParams, 7), "0.002");
  assert.equal(need({ ...scheduleParams, capitalQuoteWei: (300n * E).toString(), entryWei: (10n * E).toString(), minEntryWei: (10n * E).toString(), scheduleIntervalSec: 86_400, scheduleEndKind: "budget", scheduleEndRuns: null }, 30), "0.0132");
  assert.equal(need({ ...scheduleParams, capitalQuoteWei: (1000n * E).toString(), scheduleEndKind: "budget", scheduleEndRuns: null }, 7), "0.0676");
  for (const [bnbWei, state] of [["2000000000000000", "PASS"], ["1999999999999999", "FAIL"]] as const) assert.equal(row("bnb", gateFor(scheduleParams, { bnbWei }).rows)?.state, state);
});

test("G2 gate: daily limit is twice the capital, USDT is the capital, and no x402 row exists for Schedule", () => {
  assert.equal(row("daily-limit", gateFor(scheduleParams, { dailyLimit: 19.99 }).rows)?.state, "FAIL");
  assert.equal(row("daily-limit", gateFor(scheduleParams, { dailyLimit: 19.99 }).rows)?.fix, "Raise Daily limit to 20 USDT.");
  assert.equal(row("daily-limit", gateFor(scheduleParams, { dailyLimit: 20 }).rows)?.state, "PASS");
  assert.equal(row("usdt", gateFor(scheduleParams, { usdtWei: (10n * E).toString() }).rows)?.state, "PASS");
  assert.equal(row("usdt", gateFor(scheduleParams, { usdtWei: (10n * E - 1n).toString() }).rows)?.state, "FAIL");
  assert.equal(row("x402-limit", gateFor(scheduleParams, { x402DailyLimit: 0 }).rows), undefined);
  assert.ok(row("x402-limit", agenticGate(agenticGateInput(parseAgenticHireParams(body(aiParams))!, FACTS, undefined, NOW)).rows));
  assert.deepEqual(gateFor(scheduleParams).rows.map(r => r.code), ["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "usdt", "bnb", "quota-today", "sizing", "schedule-first-buy", "schedule-end-date"]);
});

test("G3 gate: the first buy must be within 300 s ago, the 7-day window and the entry cutoff", () => {
  const first = (firstAtSec: number | null, facts: Partial<AgenticFactsRead> = {}, term: 7 | 30 = 7) => row("schedule-first-buy", gateFor({ ...scheduleParams, scheduleFirstAtSec: firstAtSec }, facts, term).rows)?.state;
  const nowSec = NOW / 1_000;
  assert.equal(first(null), "PASS");
  assert.equal(first(nowSec - 301), "FAIL"); assert.equal(first(nowSec - 300), "PASS");
  assert.equal(first(nowSec + 597_600), "PASS"); assert.equal(first(nowSec + 597_601), "FAIL");
  // A 30-day term: the 7-day bound binds, not the cutoff.
  assert.equal(first(nowSec + 597_600, {}, 30), "PASS"); assert.equal(first(nowSec + 597_601, {}, 30), "FAIL");
  // A clipped session: the cutoff (end - 2 h) binds.
  const clipped = { signInMaxTimeMs: NOW + 3 * 86_400_000 + 3_600_000 }, cutoff = (NOW + 3 * 86_400_000 - 7_200_000) / 1_000;
  assert.equal(first(cutoff, clipped), "PASS"); assert.equal(first(cutoff + 1, clipped), "FAIL");
  assert.match(gateFor({ ...scheduleParams, scheduleFirstAtSec: nowSec + 1_000_000 }).rows.find(r => r.code === "schedule-first-buy")!.fix, /^Choose a first buy within the next 7 days and before \d{4}-\d{2}-\d{2}T.*Z\.$/u);
});

test("G4 gate: the end date must be in the future", () => {
  const end = (endAtSec: number | null) => row("schedule-end-date", gateFor({ ...scheduleParams, scheduleEndKind: endAtSec === null ? "runs" : "date", scheduleEndRuns: endAtSec === null ? 2 : null, scheduleEndAtSec: endAtSec }).rows)?.state;
  assert.equal(end(null), "PASS");
  assert.equal(end(NOW / 1_000), "FAIL"); assert.equal(end(NOW / 1_000 + 1), "PASS");
});

test("E1 executor: a Schedule agent's buy floor is 0.0012 BNB whatever its fills; an AI agent still needs open + 2", async t => {
  const f = await fixture(t, {}, scheduleParams);
  assert.equal(parseTradeSettings(scheduleParams).ok, true);
  assert.deepEqual(await buyAfterFloor(f, FLOOR - 1n, 5), { kind: "denied", code: "AGENTIC_LOW_BNB" });
  assert.deepEqual(await buyAfterFloor(f, FLOOR, 0), { kind: "rolled-back", code: "AGENTIC_QUOTE_BELOW_MIN" });
  const ai = await fixture(t);
  assert.deepEqual(await buyAfterFloor(ai, 7n * 400_000_000_000_000n - 1n, 5), { kind: "denied", code: "AGENTIC_LOW_BNB" });
});

test("H1 holds: a Schedule hire never holds on x402; an AI hire still does", async t => {
  const schedule = await fixture(t, {}, scheduleParams), ai = await fixture(t);
  for (const f of [schedule, ai]) f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...{ tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1_000, quotaUsed: 0, signInMaxTime: new Date(NOW + 90 * 86_400_000).toISOString() }, x402DailyLimit: 0, x402QuotaUsed: 0 } });
  const fenceS = (await schedule.store.acquireFence(W, schedule.instance.row.instanceId))!, fenceA = (await ai.store.acquireFence(W, ai.instance.row.instanceId))!;
  assert.ok(await readAgenticSettings(schedule.execution, schedule.agent.id, fenceS));
  assert.equal((await schedule.store.byAgent(schedule.agent.id))?.settingsHold, null);
  assert.equal(await readAgenticSettings(ai.execution, ai.agent.id, fenceA), null);
  assert.equal((await ai.store.byAgent(ai.agent.id))?.settingsHold?.code, "x402-limit");
});

test("V1 public view: the Schedule block has exactly the Altana keys, no observer call, no CMC and failures leave nulls", async t => {
  t.mock.method(Date, "now", () => NOW);
  const f = await fixture(t, { acceptedAt: NOW + 5_000 }, scheduleParams);
  await f.positions.open({ positionId: "one", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: 5n * E, fillStatus: "verified", openedAt: NOW, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E });
  let observed = 0;
  const make = (extra: Partial<Parameters<typeof createAgenticPublicView>[0]>) => createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore,
    killswitch: f.killswitch, observer: { observe: async () => { observed += 1; return []; } }, chain: f.chain, ...extra });
  const full = (await make({ scheduleSellQuote: () => async () => ({ quotedOutAtomic: 6n * E }), schedulePremiumBps: () => async () => 42 })(W)).agent!;
  assert.equal(observed, 0);
  const schedule = full.schedule as Record<string, unknown> & { holding: Record<string, unknown> };
  assert.deepEqual(Object.keys(schedule).sort(), ["token", "symbol", "decimals", "amountWei", "intervalSec", "anchorMs", "nextDueAtMs", "currentSlot", "currentSlotTaken", "fills", "postponed", "plannedBuys",
    "buysThisSession", "spentWei", "remainingWei", "finished", "endKind", "endAtSec", "endRuns", "marketHoursOnly", "maxPremiumBps", "firstAtSec", "premiumBps", "premiumLimitBps", "nativeCapWei",
    "nativeSpentWei", "nativeBalanceWei", "nativeBuysRefused", "sessionExpiresAtSec", "holding"].sort());
  assert.deepEqual(Object.keys(schedule.holding).sort(), ["walletBalance", "boughtAtomic", "verifiedSpentWei", "verifiedFills", "quoteWei", "quoteReason"].sort());
  assert.deepEqual({ token: schedule["token"], symbol: schedule["symbol"], plannedBuys: schedule["plannedBuys"], buysThisSession: schedule["buysThisSession"], anchorMs: schedule["anchorMs"], premiumBps: schedule["premiumBps"],
    nativeBalanceWei: schedule["nativeBalanceWei"], sessionExpiresAtSec: schedule["sessionExpiresAtSec"], nativeCapWei: schedule["nativeCapWei"], fills: schedule["fills"], finished: schedule["finished"] },
  { token: TOKEN, symbol: "STOCK", plannedBuys: 2, buysThisSession: 166, anchorMs: NOW, premiumBps: 42, nativeBalanceWei: E.toString(), sessionExpiresAtSec: (NOW + 604_800_000) / 1_000, nativeCapWei: null, fills: 0, finished: null });
  assert.deepEqual(schedule.holding, { walletBalance: (100n * E).toString(), boughtAtomic: (5n * E).toString(), verifiedSpentWei: (5n * E).toString(), verifiedFills: 1, quoteWei: (6n * E).toString(), quoteReason: null });
  assert.equal(full.cmc.status, "disabled"); assert.equal(full.termEndAction, "keep");
  // Every read failure leaves its field null or its reason, and never throws.
  const failed = (await make({ scheduleSellQuote: () => async () => { throw new Error("private"); }, schedulePremiumBps: () => async () => { throw new Error("private"); } })(W)).agent!.schedule as typeof schedule;
  assert.deepEqual({ premium: failed["premiumBps"], quote: failed.holding["quoteWei"], reason: failed.holding["quoteReason"] }, { premium: null, quote: null, reason: "quote-unavailable" });
  const absent = (await make({})(W)).agent!.schedule as typeof schedule;
  assert.deepEqual({ premium: absent["premiumBps"], reason: absent.holding["quoteReason"] }, { premium: null, reason: "quote-unavailable" });
  f.chain.balance = async (_w, token) => token === null ? E : 0n;
  const zero = (await make({ scheduleSellQuote: () => async () => ({ quotedOutAtomic: 1n }) })(W)).agent!.schedule as typeof schedule;
  assert.deepEqual({ balance: zero.holding["walletBalance"], reason: zero.holding["quoteReason"] }, { balance: "0", reason: "balance-zero" });
  f.chain.balance = async () => { throw new Error("rpc"); }; f.chain.metadata = async () => { throw new Error("rpc"); };
  const unread = (await make({})(W)).agent!.schedule as typeof schedule;
  assert.deepEqual({ balance: unread.holding["walletBalance"], native: unread["nativeBalanceWei"], decimals: unread["decimals"], symbol: unread["symbol"] }, { balance: null, native: null, decimals: null, symbol: TOKEN.slice(0, 8) });
});

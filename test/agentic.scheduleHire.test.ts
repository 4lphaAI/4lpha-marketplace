/** AGENTIC-SCHEDULE: the hire stages for a Schedule hire (pre-check, gated, fence renewals, refusals, no CMC state). */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { type Address } from "viem";
import type { TradeSettings } from "../src/trade/settings.js";
import { AGENTIC_HIRE_REASONS, agenticAddress, agenticHireIdentity, parseAgenticHireParams, type AgenticWallet } from "../src/agentic/domain.js";
import { registerAgenticRoutes } from "../src/agentic/routes.js";
import { E, NOW, PAIRED, PAIRING, SECRET, TOKEN, W, aiParams, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";

const candidates: Address[] = Array.from({ length: 30 }, (_, i) => i === 5 ? TOKEN : agenticAddress("0x" + (0x1000 + i).toString(16).padStart(40, "0")));
const request = (settings: TradeSettings = scheduleParams) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings });
const paired = (t: TestContext, settings: TradeSettings = scheduleParams, patch: Partial<AgenticWallet> = {}) => fixture(t, { ...PAIRED, ...patch }, settings);
const wire = (f: Fixture, pin = async () => candidates as readonly Address[], schedulable: (() => Promise<readonly Address[]>) | null = async () => [TOKEN], capability?: () => string | null) => {
  const app = new Hono();
  registerAgenticRoutes(app, f.pairings, pin, schedulable ?? undefined, capability);
  return app;
};
const post = (app: Hono, payload: unknown) => app.request("/agentic/hire", { method: "POST", body: JSON.stringify(payload),
  headers: { "content-type": "application/json", origin: "https://4lpha.test", "x-agentic-pairing": PAIRING + "." + SECRET } });
type Refusal = { data: unknown; error?: { code: string }; meta?: { reason: string | null; gate: { code: string }[] } };
const stored = async (f: Fixture) => (await f.store.getWallet(PAIRING))!;
async function accept(f: Fixture, settings: TradeSettings = scheduleParams) {
  const params = parseAgenticHireParams(request(settings))!, identity = agenticHireIdentity(params);
  return (await f.store.acceptHire(f.row, { hireOpId: identity.hireOpId, agentId: identity.agentId, hireParams: params, termEndAction: "keep" }))!;
}

test("S1 hire: a Schedule hire binds with Schedule facts, the chosen stock first, the cut at 28, no CMC state and the AI stage markers", async t => {
  const f = await paired(t);
  const pinArgs: unknown[][] = [], stages: unknown[] = [];
  f.pairings.pin = async (...args) => { pinArgs.push(args); return candidates; };
  f.pairings.schedulable = async () => [TOKEN];
  const patch = f.store.patchWallet.bind(f.store);
  t.mock.method(f.store, "patchWallet", async (current: Parameters<typeof patch>[0], change: Parameters<typeof patch>[1]) => { if (change.hireStage !== undefined) stages.push(change.hireStage); return patch(current, change); });
  const cmc = [t.mock.method(f.cmcStore, "putInitial"), t.mock.method(f.cmcStore, "setSetup"), t.mock.method(f.cmcStore, "setCapability")];
  let metadataCalls = 0;
  const metadata = f.chain.metadata; f.chain.metadata = async token => { metadataCalls += 1; return metadata(token); };
  const hired = await f.pairings.hire(f.row, request());
  const facts = hired.hireFacts!;
  assert.equal(hired.state, "bound");
  assert.deepEqual(pinArgs.map(args => [args[1], args[3]]), [[5n * E, "schedule"], [5n * E, "schedule"]]);
  assert.equal(facts.termEndAction, "keep"); assert.equal(facts.quoteDayCapWei, (10n * E).toString()); assert.equal(facts.budgetWei, "0");
  assert.deepEqual(facts.hireSizing, { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: (10n * E).toString(),
    entryWei: (5n * E).toString(), minEntryWei: (5n * E).toString(), quotePerTradeWei: (5n * E).toString(), cmcNewsEnabled: false });
  assert.equal(facts.pinned.length, 28); assert.equal(facts.pinned[0], TOKEN);
  assert.deepEqual(facts.pinned.slice(1), candidates.filter(a => a !== TOKEN).slice(0, 27));
  assert.equal(metadataCalls, 1 + 28, "one chosen-token pre-check read, then the filter over the 28-token cut list");
  assert.deepEqual(cmc.map(spy => spy.mock.callCount()), [0, 0, 0]);
  assert.equal(await f.cmcStore.get(hired.agentId!, W), null);
  assert.deepEqual(stages, ["accepted", "gated", "agent-created", "settings-stored", "cmc-initialized", "active"]);
});

test("S2 pre-check: every refusal answers its own code and reason, leaves the pairing paired with no write, and a retry after the cause clears binds", async t => {
  for (const code of ["schedule-token-not-granted", "schedule-token-unquotable", "schedule-capability-incomplete", "schedule-first-buy-past", "schedule-end-past", "pin-error"]) assert.ok(AGENTIC_HIRE_REASONS.includes(code), code);
  const cases: [string, TradeSettings, (f: Fixture) => { pin?: () => Promise<readonly Address[]>; schedulable?: () => Promise<readonly Address[]>; capability?: () => string | null }][] = [
    ["schedule-token-not-granted", scheduleParams, () => ({ pin: async () => candidates.filter(a => a !== TOKEN) })],
    ["schedule-capability-incomplete", scheduleParams, () => ({ pin: async () => candidates.filter(a => a !== TOKEN), capability: () => "unknown" })],
    ["schedule-capability-incomplete", scheduleParams, f => { f.chain.metadata = async () => { throw new Error("rpc"); }; return {}; }],
    ["schedule-token-not-granted", scheduleParams, f => { f.chain.multiplier = async () => E - 1n; return {}; }],
    ["schedule-token-not-granted", scheduleParams, f => { f.chain.metadata = async () => ({ decimals: 6, symbol: "X" }); return {}; }],
    ["schedule-token-unquotable", scheduleParams, () => ({ schedulable: async () => [] })],
    ["pin-error", scheduleParams, () => ({ schedulable: async () => { throw new Error("private"); } })],
    ["pin-error", scheduleParams, () => ({ pin: async () => { throw new Error("private"); } })],
    ["schedule-first-buy-past", { ...scheduleParams, scheduleFirstAtSec: NOW / 1_000 - 301 }, () => ({})],
    ["schedule-end-past", { ...scheduleParams, scheduleEndKind: "date", scheduleEndRuns: null, scheduleEndAtSec: NOW / 1_000 }, () => ({})],
  ];
  for (const [code, settings, configure] of cases) {
    const f = await paired(t, settings), before = await stored(f), calls = f.runner.calls.length, cfg = configure(f);
    const app = wire(f, cfg.pin, cfg.schedulable, cfg.capability);
    const response = await post(app, request(settings)), result = await response.json() as Refusal;
    assert.equal(response.status, 409, code); assert.equal(result.error?.code, code); assert.equal(result.meta?.reason, code);
    assert.ok(result.meta!.gate.some(r => r.code === "schedule-first-buy"), "the preview gate rows ride along");
    const after = await stored(f);
    assert.deepEqual({ state: after.state, version: after.version, failure: after.failure }, { state: "paired", version: before.version, failure: null });
    assert.equal(f.runner.calls.length, calls, "the pre-check makes no Binance call");
    if (code === "schedule-token-unquotable") {
      const retry = wire(f, undefined, async () => [TOKEN]);
      assert.equal((await post(retry, request(settings))).status, 200);
      assert.equal((await stored(f)).state, "bound");
    }
  }
});

test("S3 pre-check precondition: a row that is not paired with facts is left to acceptHire's own conflict", async t => {
  const f = await paired(t, scheduleParams, { state: "verified", factsRead: null });
  let pinned = 0;
  f.pairings.pin = async () => { pinned += 1; return candidates; }; f.pairings.schedulable = async () => [TOKEN];
  await assert.rejects(() => f.pairings.hire(f.row, request()), /agentic_hire_conflict/);
  assert.equal(pinned, 0);
});

test("S4 gated: each failure persists its closed reason; a filtered chosen stock is retryable, never 'not granted'", async t => {
  const cases: [string, (f: Fixture) => void][] = [
    ["schedule-token-not-granted", f => { f.pairings.pin = async () => candidates.filter(a => a !== TOKEN); }],
    ["schedule-capability-incomplete", f => { f.pairings.pin = async () => candidates.filter(a => a !== TOKEN); f.pairings.scheduleCapability = () => "unknown"; }],
    ["schedule-capability-incomplete", f => { f.chain.multiplier = async token => token === TOKEN ? E - 1n : E; }],
    ["schedule-token-unquotable", f => { f.pairings.schedulable = async () => [candidates[0]!]; }],
    ["pin-error", f => { f.pairings.schedulable = async () => { throw new Error("private"); }; }],
    ["pin-unavailable", f => { f.pairings.schedulable = null; }],
  ];
  for (const [reason, configure] of cases) {
    const f = await paired(t), accepted = await accept(f);
    f.pairings.pin = async () => candidates; f.pairings.schedulable = async () => [TOKEN]; configure(f);
    await assert.rejects(() => f.pairings.resumeHire(accepted), /gate-failed/);
    assert.deepEqual({ state: (await stored(f)).state, failure: (await stored(f)).failure }, { state: "cleaning", failure: reason });
  }
});

test("S5 gated fence: a Schedule hire renews the lease after the pin, in every filter iteration and after the quote check; a lost lease is wallet-busy, not swallowed", async t => {
  const renews = async (settings: TradeSettings, loseAt = 0) => {
    const f = await paired(t, settings), accepted = await accept(f, settings);
    f.pairings.pin = async () => settings === aiParams ? candidates.slice(0, 28) : candidates; f.pairings.schedulable = async () => [TOKEN];
    const renew = f.store.renewFence.bind(f.store);
    let count = 0, metadataCalls = 0;
    t.mock.method(f.store, "renewFence", async (fence: Parameters<typeof renew>[0]) => { count += 1; return count === loseAt ? null : renew(fence); });
    const metadata = f.chain.metadata; f.chain.metadata = async token => { metadataCalls += 1; return metadata(token); };
    const outcome = await f.pairings.resumeHire(accepted).then(() => "bound", (error: Error) => error.message);
    return { count, outcome, metadataCalls, failure: (await stored(f)).failure };
  };
  const schedule = await renews(scheduleParams), ai = await renews(aiParams);
  assert.deepEqual([schedule.outcome, ai.outcome], ["bound", "bound"]);
  assert.equal(schedule.count - ai.count, 30);
  const lost = await renews(scheduleParams, 10);
  assert.deepEqual({ outcome: lost.outcome, failure: lost.failure }, { outcome: "agentic_wallet_busy", failure: "wallet-busy" });
  assert.ok(lost.metadataCalls < 5, "the loop stops at the lost lease instead of continuing past a swallowed throw");
});

test("S6 refusal path: a lost lease whose winner already bound this exact hire answers success; any other body keeps its conflict", async t => {
  const f = await paired(t);
  const app = wire(f);
  assert.equal((await post(app, request())).status, 200);
  const bound = await stored(f);
  t.mock.method(f.pairings, "hire", async () => { throw new Error("agentic_wallet_busy"); });
  const same = await post(app, request()), sameBody = await same.json() as Record<string, unknown>;
  assert.equal(same.status, 200);
  assert.deepEqual(sameBody, { data: { walletAddress: W, hireEndMs: bound.hireEndMs, entryCutoffMs: bound.entryCutoffMs, state: "bound" } });
  const other = await post(app, request({ ...scheduleParams, capitalQuoteWei: (20n * E).toString() })), otherBody = await other.json() as Refusal;
  assert.deepEqual({ status: other.status, code: otherBody.error?.code }, { status: 409, code: "agentic_wallet_busy" });
});

test("S7 optional inputs: without a schedulable closure a Schedule hire refuses pin-unavailable and an AI hire is untouched", async t => {
  const f = await paired(t), app = wire(f, undefined, null);
  const response = await post(app, request()), result = await response.json() as Refusal;
  assert.deepEqual({ status: response.status, reason: result.meta?.reason }, { status: 409, reason: "pin-unavailable" });
  const ai = await paired(t, aiParams);
  assert.equal((await post(wire(ai, async () => [TOKEN], null), request(aiParams))).status, 200);
});

test("R1 registration (source scan): the plane passes the pin mode, the schedulable check, the capability read and one shared quote holder", () => {
  const server = readFileSync("src/server.ts", "utf8").replaceAll("\r\n", "\n"), at = server.indexOf("registerAgenticRoutes(app, deps.agentic");
  const block = server.slice(at, server.indexOf("/* ---- Health and status", at));
  for (const needle of ['async (W, minEntryAtomic, slippageBps, mode = "ai") =>', 'cachedPin("tradfi", mode, W, undefined, { minEntryAtomic, slippageBps })', "cachedSchedulable(amountWei, slippageBps)",
    "lastScheduleCapability.get(`${token.toLowerCase()}:${minEntryAtomic.toString(10)}`) ?? null"]) assert.ok(block.includes(needle), needle);
  const index = readFileSync("src/index-server.ts", "utf8").replaceAll("\r\n", "\n");
  assert.equal(index.split("scheduleQuotes: (agenticScheduleQuotes = {").length, 2);
  for (const needle of ["scheduleSellQuote: () => agenticScheduleQuotes?.sell", "schedulePremiumBps: () => tradeDataPlane === undefined ? undefined : async token =>", "chain, scheduleSellQuote"]) assert.ok(index.includes(needle), needle);
});

/** AGENTIC-DCA 3.12, 3.13, R2.1: the hire params, the gate rows, the read-only pre-check, the gated stage, the refusal plumbing and the worker listing. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Hono } from "hono";
import { AGENTIC_HIRE_REASONS, agenticGate, agenticGateInput, agenticHasCmc, agenticHireBudgetWei, agenticHireIdentity, agenticQuoteDayCapWei, parseAgenticHireParams, type AgenticFactsRead, type AgenticWallet } from "../src/agentic/domain.js";
import { registerAgenticRoutes } from "../src/agentic/routes.js";
import { dcaHireBnbFloorWei } from "../src/agentic/dca.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import type { TradeSettings } from "../src/trade/settings.js";
import { E, FACTS, NOW, PAIRED, PAIRING, SECRET, W, fixture, type Fixture } from "./support/agenticSchedule.js";
import { SPYB, USDT, dcaParams } from "./support/agenticDca.js";

const request = (settings: TradeSettings = dcaParams(), term: 7 | 30 = 7, termEndAction: "keep" | "sell-all" = "keep") => ({ pairingId: PAIRING, term, termEndAction, executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings });
const paired = async (t: TestContext, patch: Partial<AgenticWallet> = {}, settings: TradeSettings = dcaParams(), enabled = true) => {
  const f = await fixture(t, { ...PAIRED, ...patch }, settings);
  Object.assign(f.pairings.deps, { dcaEnabled: enabled });
  f.pairings.pin = async () => { throw new Error("a DCA hire reads no pin"); };
  const pool = DCA_POOLS_56.find(p => p.stock.toLowerCase() === SPYB)!;
  f.chain.poolState = async () => ({ token0: pool.usdtIsToken0 ? USDT : SPYB, token1: pool.usdtIsToken0 ? SPYB : USDT, fee: pool.fee, tickSpacing: pool.tickSpacing, sqrtPriceX96: 1n << 96n, tick: 0, block: 1n });
  return f;
};
const wire = (f: Fixture) => { const app = new Hono(); registerAgenticRoutes(app, f.pairings, async () => { throw new Error("a DCA hire reads no pin"); }); return app; };
const post = (app: Hono, payload: unknown) => app.request("/agentic/hire", { method: "POST", body: JSON.stringify(payload),
  headers: { "content-type": "application/json", origin: "https://4lpha.test", "x-agentic-pairing": PAIRING + "." + SECRET } });
type Refusal = { data: unknown; error?: { code: string }; meta?: { reason: string | null; gate: { code: string; state: string }[] } };
const stored = async (f: Fixture) => (await f.store.getWallet(PAIRING))!;

test("DH1 params: the DCA tuple is accepted with keep for both terms; sell-all, CMC fields and a non-DCA tradeMode mix are refused", () => {
  assert.ok(parseAgenticHireParams(request()));
  assert.ok(parseAgenticHireParams(request(dcaParams(), 30)));
  assert.equal(parseAgenticHireParams(request(dcaParams(), 7, "sell-all")), null);
  assert.equal(parseAgenticHireParams(request({ ...dcaParams(), cmcNewsEnabled: true, cmcTotalBudgetWei: (E / 5n).toString() } as TradeSettings)), null);
  assert.equal(parseAgenticHireParams(request({ ...dcaParams(), dcaToken: "0x1111111111111111111111111111111111111111" } as TradeSettings)), null);
  const settings = dcaParams();
  assert.equal(agenticHasCmc(settings), true);
  assert.deepEqual([agenticHireBudgetWei(settings, 7), agenticHireBudgetWei(settings, 30)], [E / 5n, 4n * E / 5n]);
  assert.equal(agenticQuoteDayCapWei(settings), 175n * E);
});

const facts = (patch: Partial<AgenticFactsRead> = {}): AgenticFactsRead => ({ ...FACTS, ...patch });
const gateOf = (settings: TradeSettings, patch: Partial<AgenticFactsRead> = {}, term: 7 | 30 = 7) => agenticGate(agenticGateInput(parseAgenticHireParams(request(settings, term))!, facts(patch), W, NOW));

test("DH2 gate rows (3.13, R3.7): bnb (2N + 4) x 0.0004, USDT capital + keep-alive budget, daily limit 2 x 5 x capital, the x402 row, quota and sizing", () => {
  for (const [n, floor] of [[1, "0.0024"], [3, "0.004"], [4, "0.0048"], [8, "0.008"]] as const) {
    const settings = dcaParams({ dcaMaxOrders: n }), need = dcaHireBnbFloorWei(n);
    assert.equal(need.toString(), (BigInt(Math.round(Number(floor) * 1e4)) * 10n ** 14n).toString());
    const bnb = (wei: bigint) => gateOf(settings, { bnbWei: wei.toString() }).rows.find(r => r.code === "bnb")!.state;
    assert.deepEqual([bnb(need), bnb(need - 1n)], ["PASS", "FAIL"], `N=${n}`);
  }
  const gate = gateOf(dcaParams());
  const row = (code: string) => gate.rows.find(r => r.code === code)!;
  assert.equal(row("x402-limit").state, "PASS", "the x402 row is emitted for a DCA hire");
  assert.equal(row("sizing").state, "PASS");
  const usdt = (wei: bigint, term: 7 | 30 = 7, settings: TradeSettings = dcaParams()) => gateOf(settings, { usdtWei: wei.toString() }, term).rows.find(r => r.code === "usdt")!.state;
  assert.deepEqual([usdt(35n * E + E / 5n), usdt(35n * E + E / 5n - 1n)], ["PASS", "FAIL"]);
  assert.deepEqual([usdt(35n * E + 4n * E / 5n, 30), usdt(35n * E + 4n * E / 5n - 1n, 30)], ["PASS", "FAIL"]);
  const nvda = dcaParams({ dcaMaxOrders: 3, entryWei: (25n * E).toString() });
  assert.equal(nvda.capitalQuoteWei, (55n * E).toString());
  assert.deepEqual([usdt(55n * E + E / 5n, 7, nvda), usdt(55n * E + 4n * E / 5n, 30, nvda), usdt(55n * E + 4n * E / 5n - 1n, 30, nvda)], ["PASS", "PASS", "FAIL"]);
  const daily = (value: number) => gateOf(dcaParams(), { dailyLimit: value }).rows.find(r => r.code === "daily-limit")!.state;
  assert.deepEqual([daily(350), daily(349.99)], ["PASS", "FAIL"]);
  assert.equal(gateOf(dcaParams(), { x402DailyLimit: 0.49 }).rows.find(r => r.code === "x402-limit")!.state, "FAIL");
});

test("DH3 hire: a DCA hire binds with the stock pinned, no pin or sizing read, the facts and CMC state of the keep-alive, and the AI stage markers", async t => {
  for (const [term, budget] of [[7, E / 5n], [30, 4n * E / 5n]] as const) {
    const f = await paired(t), stages: unknown[] = [];
    const patch = f.store.patchWallet.bind(f.store);
    t.mock.method(f.store, "patchWallet", async (current: Parameters<typeof patch>[0], change: Parameters<typeof patch>[1]) => { if (change.hireStage !== undefined) stages.push(change.hireStage); return patch(current, change); });
    const put = t.mock.method(f.cmcStore, "putInitial"), setup = t.mock.method(f.cmcStore, "setSetup"), capability = t.mock.method(f.cmcStore, "setCapability");
    const hired = await f.pairings.hire(f.row, request(dcaParams(), term));
    const hireFacts = hired.hireFacts!;
    assert.equal(hired.state, "bound");
    assert.deepEqual(hireFacts.pinned, [SPYB]);
    assert.deepEqual({ cap: hireFacts.quoteDayCapWei, budget: hireFacts.budgetWei, end: hireFacts.termEndAction }, { cap: (175n * E).toString(), budget: budget.toString(), end: "keep" });
    assert.deepEqual(hireFacts.hireSizing, { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: (35n * E).toString(), entryWei: (25n * E).toString(),
      minEntryWei: (25n * E).toString(), quotePerTradeWei: (25n * E).toString(), cmcNewsEnabled: true, cmcTotalBudgetWei: budget.toString() });
    assert.deepEqual(stages, ["accepted", "gated", "agent-created", "settings-stored", "cmc-initialized", "active"]);
    assert.equal((put.mock.calls[0]!.arguments[0] as { totalWei: bigint }).totalWei, budget);
    assert.equal((setup.mock.calls[0]!.arguments[0] as { allowanceWei: bigint }).allowanceWei, budget);
    assert.equal((capability.mock.calls[0]!.arguments[0] as { available: boolean }).available, true);
    assert.ok(f.runner.calls.some(c => c[0] === "market-order" && c[1] === "quote"), "one buy quote for the base order is read at the gated stage");
    assert.equal(f.runner.calls.some(c => c[0] === "limit-order" && c[1] !== "list"), false, "no limit write at hire");
  }
});

test("DH4 pre-check: every refusal answers its own code and reason, leaves the pairing paired with no write and no Binance call, and a retry after the cause clears binds", async t => {
  for (const code of ["dca-disabled", "dca-token-unsupported", "dca-capability-incomplete", "dca-pool-mismatch", "dca-token-unquotable"]) assert.ok(AGENTIC_HIRE_REASONS.includes(code), code);
  const cases: [string, (f: Fixture) => void | Promise<void>, boolean?][] = [
    ["dca-disabled", () => undefined, false],
    ["dca-capability-incomplete", f => { f.chain.metadata = async () => { throw new Error("rpc"); }; }],
    ["dca-capability-incomplete", f => { f.chain.multiplier = async () => { throw new Error("rpc"); }; }],
    ["dca-capability-incomplete", f => { f.chain.poolState = async () => { throw new Error("rpc"); }; }],
    ["dca-capability-incomplete", f => { delete (f.chain as { poolState?: unknown }).poolState; }],
    ["dca-token-unsupported", f => { f.chain.multiplier = async () => E - 1n; }],
    ["dca-token-unsupported", f => { f.chain.metadata = async () => ({ decimals: 6, symbol: "X" }); }],
    ["dca-pool-mismatch", f => { const read = f.chain.poolState!; f.chain.poolState = async pool => ({ ...(await read(pool)), fee: 2500 }); }],
    ["dca-pool-mismatch", f => { const read = f.chain.poolState!; f.chain.poolState = async pool => ({ ...(await read(pool)), tickSpacing: 50 }); }],
    ["dca-pool-mismatch", f => { const read = f.chain.poolState!; f.chain.poolState = async pool => { const s = await read(pool); return { ...s, token0: s.token1, token1: s.token0 }; }; }],
  ];
  for (const [code, configure, enabled] of cases) {
    const f = await paired(t, {}, dcaParams(), enabled !== false), before = await stored(f), calls = f.runner.calls.length;
    await configure(f);
    const response = await post(wire(f), request()), result = await response.json() as Refusal;
    assert.equal(response.status, 409, code); assert.equal(result.error?.code, code); assert.equal(result.meta?.reason, code);
    assert.ok(result.meta!.gate.some(r => r.code === "bnb"), "the preview gate rows ride along");
    const after = await stored(f);
    assert.deepEqual({ state: after.state, version: after.version, failure: after.failure }, { state: "paired", version: before.version, failure: null });
    assert.equal(f.runner.calls.length, calls, "the pre-check makes no Binance call");
    assert.equal(await f.cmcStore.get(agenticHireIdentity(parseAgenticHireParams(request())!).agentId, W), null, "and writes nothing");
  }
  const f = await paired(t);
  f.chain.metadata = async () => { throw new Error("rpc"); };
  assert.equal((await post(wire(f), request())).status, 409);
  f.chain.metadata = async () => ({ decimals: 18, symbol: "STOCK" });
  assert.equal((await post(wire(f), request())).status, 200);
  assert.equal((await stored(f)).state, "bound");
});

test("DH5 gated: a stock with no buy quote persists dca-token-unquotable; a flag-off process persists dca-disabled; a lost lease stops before the next read", async t => {
  const accept = async (f: Fixture) => { const params = parseAgenticHireParams(request())!, identity = agenticHireIdentity(params);
    return (await f.store.acceptHire(f.row, { hireOpId: identity.hireOpId, agentId: identity.agentId, hireParams: params, termEndAction: "keep" }))!; };
  for (const [reply, reason] of [[{ kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "25", toCoinSymbol: "S", toCoinAmount: "0", slippage: "0" } }, "dca-token-unquotable"],
    [{ kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true }, "dca-token-unquotable"]] as const) {
    const f = await paired(t), accepted = await accept(f);
    f.runner.replies.set("market-order quote", reply as never);
    await assert.rejects(() => f.pairings.resumeHire(accepted), /gate-failed/);
    assert.deepEqual({ state: (await stored(f)).state, failure: (await stored(f)).failure }, { state: "cleaning", failure: reason });
  }
  const off = await paired(t, {}, dcaParams(), false), acceptedOff = await accept(off);
  await assert.rejects(() => off.pairings.resumeHire(acceptedOff), /gate-failed/);
  assert.deepEqual({ state: (await stored(off)).state, failure: (await stored(off)).failure }, { state: "cleaning", failure: "dca-disabled" });
  const lose = async (loseAt: number) => {
    const f = await paired(t), accepted = await accept(f), renew = f.store.renewFence.bind(f.store), log: string[] = [];
    let count = 0;
    t.mock.method(f.store, "renewFence", async (fence: Parameters<typeof renew>[0]) => { count += 1; log.push("r"); return count === loseAt ? null : renew(fence); });
    const metadata = f.chain.metadata;
    f.chain.metadata = async token => { log.push("m"); return metadata(token); };
    const outcome = await f.pairings.resumeHire(accepted).then(() => "bound", (error: Error) => error.message);
    return { outcome, log: log.join(""), failure: (await stored(f)).failure };
  };
  const clean = await lose(0);
  assert.equal(clean.outcome, "bound");
  assert.match(clean.log, /rm/u, "a renewal precedes the stock read");
  const lost = await lose(clean.log.indexOf("m"));
  assert.equal(lost.outcome, "agentic_wallet_busy");
  assert.equal(lost.log.includes("m"), false);
});

test("DH6 the shared worker never drives a DCA row: its entry listing skips it, the projection listing keeps it, and a flag-off lane answers dca-agentic-off not dca-disabled", async t => {
  const f = await paired(t, { state: "bound", hireFacts: undefined as never });
  void f;
  const { dcaLane } = await import("./support/agenticDca.js");
  const w = await dcaLane(t, { flag: false });
  const worker = await w.f.worker.settingsStore.listTradeAgentsForWorker({ limit: 32, cursor: null });
  const projection = await w.f.worker.settingsStore.listTradeAgentsForProjection({ limit: 32, cursor: null });
  assert.deepEqual([worker.rows.length, projection.rows.length], [0, 1]);
  await w.tick();
  const runs = await w.runs();
  assert.ok(runs.length >= 1 && runs.every(r => !r.reason.startsWith("dca-disabled")), runs.map(r => r.reason).join(","));
  assert.equal(runs[0]!.reason.split(";")[0], "dca-agentic-off");
});

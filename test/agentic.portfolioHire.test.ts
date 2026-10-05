/** AGENTIC-PORTFOLIO: the hire stages for a portfolio hire (read-only pre-check, gated, fence renewals, refusal plumbing, keep-alive budget state). */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { type Address } from "viem";
import type { TradeSettings } from "../src/trade/settings.js";
import { AGENTIC_HIRE_REASONS, agenticHireIdentity, parseAgenticHireParams, type AgenticWallet } from "../src/agentic/domain.js";
import { registerAgenticRoutes } from "../src/agentic/routes.js";
import { E, PAIRED, PAIRING, SECRET, W, fixture, type Fixture } from "./support/agenticSchedule.js";
import { QQQB, SPYB, portfolioParams } from "./support/agenticPortfolio.js";

const request = (settings: TradeSettings = portfolioParams, term: 7 | 30 = 7) => ({ pairingId: PAIRING, term, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings });
const paired = (t: TestContext, patch: Partial<AgenticWallet> = {}) => fixture(t, { ...PAIRED, ...patch }, portfolioParams);
type Quote = (token: Address, amount: bigint, slippageBps: number) => Promise<void>;
const wire = (f: Fixture, quote?: Quote) => {
  const app = new Hono();
  registerAgenticRoutes(app, f.pairings, async () => { throw new Error("a portfolio hire reads no pin"); }, undefined, undefined, quote);
  return app;
};
const post = (app: Hono, payload: unknown) => app.request("/agentic/hire", { method: "POST", body: JSON.stringify(payload),
  headers: { "content-type": "application/json", origin: "https://4lpha.test", "x-agentic-pairing": PAIRING + "." + SECRET } });
type Refusal = { data: unknown; error?: { code: string }; meta?: { reason: string | null; gate: { code: string }[] } };
const stored = async (f: Fixture) => (await f.store.getWallet(PAIRING))!;
async function accept(f: Fixture) {
  const params = parseAgenticHireParams(request())!, identity = agenticHireIdentity(params);
  return (await f.store.acceptHire(f.row, { hireOpId: identity.hireOpId, agentId: identity.agentId, hireParams: params, termEndAction: "keep" }))!;
}

test("PH1 hire: a portfolio hire binds with the signed stocks pinned in order, the keep-alive budget in the facts and CMC state, the AI stage markers and no pin read", async t => {
  for (const [term, budget] of [[7, 2n * E / 10n], [30, 8n * E / 10n]] as const) {
    const f = await paired(t), quotes: [Address, bigint, number][] = [], stages: unknown[] = [];
    f.pairings.pin = async () => { throw new Error("a portfolio hire reads no pin"); };
    f.pairings.portfolioBuyQuote = async (token, amount, slippage) => { quotes.push([token, amount, slippage]); };
    const patch = f.store.patchWallet.bind(f.store);
    t.mock.method(f.store, "patchWallet", async (current: Parameters<typeof patch>[0], change: Parameters<typeof patch>[1]) => { if (change.hireStage !== undefined) stages.push(change.hireStage); return patch(current, change); });
    const put = t.mock.method(f.cmcStore, "putInitial"), setup = t.mock.method(f.cmcStore, "setSetup"), capability = t.mock.method(f.cmcStore, "setCapability");
    const hired = await f.pairings.hire(f.row, request(portfolioParams, term));
    const facts = hired.hireFacts!;
    assert.equal(hired.state, "bound");
    assert.deepEqual(quotes, [[SPYB, 25n * E, portfolioParams.slippageBps], [QQQB, 25n * E, portfolioParams.slippageBps]]);
    assert.deepEqual(facts.pinned, [SPYB, QQQB]);
    assert.deepEqual({ cap: facts.quoteDayCapWei, budget: facts.budgetWei, end: facts.termEndAction }, { cap: (250n * E).toString(), budget: budget.toString(), end: "keep" });
    assert.deepEqual(facts.hireSizing, { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: (50n * E).toString(), entryWei: (50n * E).toString(),
      minEntryWei: (E / 10n).toString(), quotePerTradeWei: (50n * E).toString(), cmcNewsEnabled: true, cmcTotalBudgetWei: budget.toString() });
    assert.deepEqual(stages, ["accepted", "gated", "agent-created", "settings-stored", "cmc-initialized", "active"]);
    assert.equal((put.mock.calls[0]!.arguments[0] as { totalWei: bigint }).totalWei, budget);
    assert.equal((setup.mock.calls[0]!.arguments[0] as { allowanceWei: bigint }).allowanceWei, budget);
    assert.equal((capability.mock.calls[0]!.arguments[0] as { available: boolean }).available, true);
  }
});

test("PH2 pre-check: every refusal answers its own code and reason, leaves the pairing paired with no write and no Binance call, and a retry after the cause clears binds", async t => {
  for (const code of ["portfolio-disabled", "portfolio-token-unsupported", "portfolio-token-unquotable", "portfolio-capability-incomplete"]) assert.ok(AGENTIC_HIRE_REASONS.includes(code), code);
  const ok: Quote = async () => undefined;
  const cases: [string, (f: Fixture) => Quote | undefined][] = [
    ["portfolio-disabled", () => undefined],
    ["portfolio-capability-incomplete", f => { f.chain.metadata = async () => { throw new Error("rpc"); }; return ok; }],
    ["portfolio-capability-incomplete", f => { f.chain.multiplier = async () => { throw new Error("rpc"); }; return ok; }],
    ["portfolio-token-unsupported", f => { f.chain.multiplier = async token => token === QQQB ? E - 1n : E; return ok; }],
    ["portfolio-token-unsupported", f => { f.chain.metadata = async () => ({ decimals: 6, symbol: "X" }); return ok; }],
    ["portfolio-token-unquotable", () => async token => { if (token === QQQB) throw new Error("no quote"); }],
  ];
  for (const [code, configure] of cases) {
    const f = await paired(t), before = await stored(f), calls = f.runner.calls.length, quote = configure(f);
    const response = await post(wire(f, quote), request()), result = await response.json() as Refusal;
    assert.equal(response.status, 409, code); assert.equal(result.error?.code, code); assert.equal(result.meta?.reason, code);
    assert.ok(result.meta!.gate.some(r => r.code === "bnb"), "the preview gate rows ride along");
    const after = await stored(f);
    assert.deepEqual({ state: after.state, version: after.version, failure: after.failure }, { state: "paired", version: before.version, failure: null });
    assert.equal(f.runner.calls.length, calls, "the pre-check makes no Binance call");
    assert.equal(await f.cmcStore.get(agenticHireIdentity(parseAgenticHireParams(request())!).agentId, W), null);
  }
  // The checks run in order: an unreadable stock is reported before any quote is requested, and a retry after the cause clears succeeds.
  const f = await paired(t);
  let quoted = 0;
  f.chain.metadata = async () => { throw new Error("rpc"); };
  const refused = await post(wire(f, async () => { quoted += 1; }), request());
  assert.equal(refused.status, 409); assert.equal(quoted, 0);
  f.chain.metadata = async () => ({ decimals: 18, symbol: "STOCK" });
  assert.equal((await post(wire(f, async () => { quoted += 1; }), request())).status, 200);
  assert.equal(quoted, 2); assert.equal((await stored(f)).state, "bound");
});

test("PH3 gated: a missing quote closure, a filtered stock and a lost lease each persist a closed reason; a lease is renewed before every filter read", async t => {
  const disabled = await paired(t), acceptedDisabled = await accept(disabled);
  await assert.rejects(() => disabled.pairings.resumeHire(acceptedDisabled), /gate-failed/);
  assert.deepEqual({ state: (await stored(disabled)).state, failure: (await stored(disabled)).failure }, { state: "cleaning", failure: "portfolio-disabled" });
  const filtered = await paired(t), acceptedFiltered = await accept(filtered);
  filtered.pairings.portfolioBuyQuote = async () => undefined;
  filtered.chain.multiplier = async token => token === QQQB ? E - 1n : E;
  await assert.rejects(() => filtered.pairings.resumeHire(acceptedFiltered), /gate-failed/);
  assert.deepEqual({ state: (await stored(filtered)).state, failure: (await stored(filtered)).failure }, { state: "cleaning", failure: "portfolio-capability-incomplete" });
  const events = async (loseAt = 0) => {
    const f = await paired(t), accepted = await accept(f);
    f.pairings.portfolioBuyQuote = async () => undefined;
    const log: string[] = [], renew = f.store.renewFence.bind(f.store), metadata = f.chain.metadata;
    let count = 0;
    t.mock.method(f.store, "renewFence", async (fence: Parameters<typeof renew>[0]) => { count += 1; log.push("r"); return count === loseAt ? null : renew(fence); });
    f.chain.metadata = async token => { log.push("m"); return metadata(token); };
    const outcome = await f.pairings.resumeHire(accepted).then(() => "bound", (error: Error) => error.message);
    return { log: log.join(""), outcome, failure: (await stored(f)).failure };
  };
  const clean = await events();
  assert.equal(clean.outcome, "bound");
  assert.match(clean.log, /rmrm/u, "one lease renewal precedes each of the two filter reads");
  const firstFilterRenew = clean.log.indexOf("m");
  const lost = await events(firstFilterRenew);
  assert.deepEqual({ outcome: lost.outcome, failure: lost.failure }, { outcome: "agentic_wallet_busy", failure: "wallet-busy" });
  assert.equal(lost.log.includes("m"), false, "the loop stops at the lost lease before reading a stock");
});

test("PH4 retry: after the quote closure appears a refused portfolio hire binds on the same pairing; the registered closure reaches the pairings object", async t => {
  const f = await paired(t);
  const app = wire(f);
  assert.equal((await post(app, request())).status, 409);
  assert.equal((await stored(f)).state, "paired");
  f.pairings.portfolioBuyQuote = async () => undefined;
  assert.equal((await post(app, request())).status, 200);
  const g = await paired(t), quote: Quote = async () => undefined;
  wire(g, quote);
  assert.equal(g.pairings.portfolioBuyQuote, quote);
  wire(g);
  assert.equal(g.pairings.portfolioBuyQuote, null);
});

test("PH5 registration (source scan): the plane passes the quote closure only when PORTFOLIO_ENABLED, through the Altana provision's per-stock check", () => {
  const server = readFileSync("src/server.ts", "utf8").replaceAll("\r\n", "\n"), at = server.indexOf("registerAgenticRoutes(app, deps.agentic");
  const block = server.slice(at, server.indexOf("/* ---- Health and status", at));
  for (const needle of ["deps.tradeAgent?.portfolio?.enabled !== true ? undefined : async (token, amountInAtomic, slippageBps) => {", 'if (quotes === undefined) throw new Error("trade_not_ready");',
    'deps.tradeAgent!.dataPlane.universe("bstocks")', "await quotes.buy({ token, amountInAtomic, slippageBps, ...(row?.venues === undefined ? {} : { venues: row.venues }) });"]) assert.ok(block.includes(needle), needle);
});

/** AGENTIC-PORTFOLIO: params, helpers, gate and executor (BNB floor, partial sell, release versus terminal provenance, quote refusal names). */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { keccak256, stringToBytes } from "viem";
import { parseTradeSettings, type TradeSettings } from "../src/trade/settings.js";
import { AGENTIC_PAID_KEEPALIVE_IDLE_MS, agenticGate, agenticGateInput, agenticHasCmc, agenticHireBudgetWei, agenticKeepAliveBudgetWei, agenticLastActivityMs, agenticQuoteDayCapWei,
  agenticSellAmount, agenticUiString, agenticUsesPaidIdleKeepAlive, parseAgenticHireParams, type AgenticFactsRead, type AgenticOrder } from "../src/agentic/domain.js";
import { E, FACTS, NOW, PAIRING, TOKEN, W, aiParams, fixture, scheduleParams, settingsOutput, type Fixture } from "./support/agenticSchedule.js";
import { SPYB, lastSequence, portfolioFixture, portfolioHireFacts, portfolioParams, portfolioParamsFor, runTrade, sellWorld } from "./support/agenticPortfolio.js";

const body = (settings: TradeSettings, extra: Record<string, unknown> = {}) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings, ...extra });
const gateFor = (settings: TradeSettings, facts: Partial<AgenticFactsRead> = {}, term: 7 | 30 = 7) =>
  agenticGate(agenticGateInput(parseAgenticHireParams(body(settings, { term }))!, { ...FACTS, ...facts }, "0x1111111111111111111111111111111111111111", NOW));
const row = (code: string, rows: { code: string; state: string; fix: string }[]) => rows.find(r => r.code === code);
const BNB = 400_000_000_000_000n;

test("PP1 params: the portfolio tuple with keep is accepted for both terms; sell-all and CMC fields are refused", () => {
  assert.equal(parseTradeSettings(portfolioParams).ok, true);
  for (const count of [2, 3, 4, 5] as const) assert.equal(parseTradeSettings(portfolioParamsFor(count)).ok, true, String(count));
  assert.ok(parseAgenticHireParams(body(portfolioParams)));
  assert.ok(parseAgenticHireParams(body(portfolioParams, { term: 30 })));
  assert.equal(parseAgenticHireParams(body(portfolioParams, { termEndAction: "sell-all" })), null);
  assert.equal(parseAgenticHireParams(body({ ...portfolioParams, cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E / 10n).toString() })), null);
  assert.equal(parseAgenticHireParams(body({ ...portfolioParams, portfolioDriftBps: 49 })), null);
});

test("PP2 helpers: the keep-alive predicate, the budgets and the day cap", () => {
  const dca = { ...aiParams, tradeMode: "dca" } as TradeSettings;
  // AGENTIC-DCA-SPEC R2.1: the Agentic DCA phase adds the DCA mode to this predicate, so a DCA tuple is now true (the only existing assertion that phase changes).
  assert.deepEqual([portfolioParams, aiParams, scheduleParams, dca].map(agenticUsesPaidIdleKeepAlive), [true, false, false, true]);
  assert.deepEqual([portfolioParams, aiParams, scheduleParams].map(agenticHasCmc), [true, true, false]);
  assert.deepEqual([agenticHireBudgetWei(aiParams, 7), agenticHireBudgetWei(aiParams, 30), agenticHireBudgetWei(portfolioParams, 7), agenticHireBudgetWei(portfolioParams, 30),
    agenticHireBudgetWei(scheduleParams, 7), agenticHireBudgetWei(scheduleParams, 30)], [2n * E, 8n * E, 2n * E / 10n, 8n * E / 10n, 0n, 0n]);
  assert.deepEqual([agenticKeepAliveBudgetWei(7), agenticKeepAliveBudgetWei(30)], [200_000_000_000_000_000n, 800_000_000_000_000_000n]);
  assert.equal(agenticQuoteDayCapWei(portfolioParams), 250n * E);
  assert.equal(AGENTIC_PAID_KEEPALIVE_IDLE_MS, 43_200_000);
});

test("PP3 helpers: agenticLastActivityMs counts a quoted swap of this agent, settled payments only on request, and never an x402-sign row or another agent", () => {
  const order = (patch: Partial<AgenticOrder>): AgenticOrder => ({ idempotencyKey: "k", kind: "swap", walletAddress: W, agentId: "a", decisionId: null, side: null, fromToken: null, toToken: null,
    amountAtomic: null, intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null,
    operationId: null, walletNoncePre: null, quoteAt: null, dispatch: "sealed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null,
    returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: 5, updatedAt: 5, ...patch });
  const last = (orders: AgenticOrder[], settled: number[], kinds: Parameters<typeof agenticLastActivityMs>[1]) => agenticLastActivityMs({ acceptedAt: 10, agentId: "a", orders, settledAttemptsCreatedAt: settled }, kinds);
  assert.equal(last([], [], ["swap-quote", "x402-settled"]), 10);
  assert.equal(last([order({ quoteAt: 50, createdAt: 99 })], [], ["swap-quote"]), 50, "the quote time counts, not the row's creation");
  assert.equal(last([order({ quoteAt: null, createdAt: 99 })], [], ["swap-quote"]), 10, "a row sealed before any Binance call is not activity");
  assert.equal(last([order({ kind: "x402-sign", quoteAt: 70 })], [], ["swap-quote", "x402-settled"]), 10);
  assert.equal(last([order({ agentId: "b", quoteAt: 70 })], [], ["swap-quote"]), 10);
  assert.equal(last([], [80], ["swap-quote"]), 10);
  assert.equal(last([], [80], ["x402-settled"]), 80);
  assert.equal(last([order({ quoteAt: 90 })], [80], ["x402-settled"]), 80);
  assert.equal(last([order({ quoteAt: 90 })], [80], ["swap-quote", "x402-settled"]), 90);
  assert.equal(last([order({ quoteAt: 5 })], [], ["swap-quote"]), 10, "acceptance is the floor");
});

test("PG-P1 gate: bnb needs (2N + 2) x 0.0004 for N = 2..5, exact and one wei short", () => {
  for (const [count, need] of [[2, "0.0024"], [3, "0.0032"], [4, "0.004"], [5, "0.0048"]] as const) {
    const settings = portfolioParamsFor(count), wei = BigInt(2 * count + 2) * BNB;
    assert.equal(/need ([0-9.]+) BNB/.exec(row("bnb", gateFor(settings, { bnbWei: "0", usdtWei: (500n * E).toString() }).rows)!.fix)![1], need);
    assert.equal(row("bnb", gateFor(settings, { bnbWei: wei.toString() }).rows)?.state, "PASS");
    assert.equal(row("bnb", gateFor(settings, { bnbWei: (wei - 1n).toString() }).rows)?.state, "FAIL");
  }
});

test("PG-P2 gate: x402 row is emitted, USDT is capital plus the keep-alive budget, the daily limit is 2 x 5 x capital, quota warns, sizing passes", () => {
  assert.deepEqual(gateFor(portfolioParams).rows.map(r => r.code), ["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "x402-limit", "usdt", "bnb", "quota-today", "sizing"]);
  assert.equal(row("x402-limit", gateFor(portfolioParams, { x402DailyLimit: 0.49 }).rows)?.state, "FAIL");
  assert.equal(row("x402-limit", gateFor(portfolioParams, { x402DailyLimit: 0.5 }).rows)?.state, "PASS");
  for (const [term, usdt] of [[7, 50n * E + 2n * E / 10n], [30, 50n * E + 8n * E / 10n]] as const) {
    assert.equal(row("usdt", gateFor(portfolioParams, { usdtWei: usdt.toString() }, term).rows)?.state, "PASS");
    assert.equal(row("usdt", gateFor(portfolioParams, { usdtWei: (usdt - 1n).toString() }, term).rows)?.state, "FAIL");
  }
  assert.match(row("usdt", gateFor(portfolioParams, { usdtWei: "0" }).rows)!.fix, /need 50\.2 USDT/u);
  assert.match(row("usdt", gateFor(portfolioParams, { usdtWei: "0" }, 30).rows)!.fix, /need 50\.8 USDT/u);
  assert.equal(row("daily-limit", gateFor(portfolioParams, { dailyLimit: 499.99 }).rows)?.fix, "Raise Daily limit to 500 USDT.");
  assert.equal(row("daily-limit", gateFor(portfolioParams, { dailyLimit: 500 }).rows)?.state, "PASS");
  assert.equal(row("daily-limit", gateFor(portfolioParamsFor(5), { dailyLimit: 1_249 }).rows)?.fix, "Raise Daily limit to 1250 USDT.");
  assert.equal(row("quota-today", gateFor(portfolioParams, { quotaUsed: 999 }).rows)?.state, "WARN");
  assert.equal(row("sizing", gateFor(portfolioParams).rows)?.state, "PASS");
});

// ---- Executor ---------------------------------------------------------------------------------------------------------------------------------------

/** A quote below the minimum seals the order right after the BNB floor, so a rolled-back result means the floor passed. */
async function afterFloor(f: Fixture, native: bigint) {
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "1", slippage: "0" } });
  f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), dailyLimit: 5_000 } });
  f.balances.native = native;
  const result = await runTrade(f, { side: "buy" });
  return result.kind === "denied" ? { kind: result.kind, code: result.code } : { kind: result.kind, code: result.kind === "rolled-back" ? result.code : null };
}

test("PE1 executor floor: a portfolio buy needs (N + 2) x 0.0004 BNB, an AI agent with no positions still 0.0008", async t => {
  for (const count of [2, 3, 4, 5] as const) {
    const f = await portfolioFixture(t, { hireFacts: portfolioHireFacts(portfolioParamsFor(count)) }, undefined, portfolioParamsFor(count)), floor = BigInt(count + 2) * BNB;
    assert.deepEqual(await afterFloor(f, floor - 1n), { kind: "denied", code: "AGENTIC_LOW_BNB" }, String(count));
    assert.deepEqual(await afterFloor(f, floor), { kind: "rolled-back", code: "AGENTIC_QUOTE_BELOW_MIN" }, String(count));
  }
  const ai = await fixture(t);
  assert.deepEqual(await afterFloor(ai, 2n * BNB - 1n), { kind: "denied", code: "AGENTIC_LOW_BNB" });
  assert.deepEqual(await afterFloor(ai, 2n * BNB), { kind: "rolled-back", code: "AGENTIC_QUOTE_BELOW_MIN" });
});

test("PE2 partial sell: the UI balance is checked against the whole holding and the u-search stays on the planned amount (spec vectors)", () => {
  const m = "1.001729792036835231", held = 5_000_000_000_000_000_000n, planned = 1_298_865_564_003_062n;
  assert.equal(agenticSellAmount(planned, m, "5.008648960184176155", held), "0.001301112331312594");
  assert.equal(agenticSellAmount(planned, m, "5.008648960184176154", held), null);
  assert.equal(agenticSellAmount(planned, m, "5.008648960184176156", held), null);
  assert.equal(agenticSellAmount(planned, m, agenticUiString(planned * 1_001_729_792_036_835_231n / 10n ** 18n)), "0.001301112331312594", "the default heldRaw is the sold amount");
  const aiRaw = 1_298_865_564_003_663n;
  assert.equal(agenticSellAmount(aiRaw, m, agenticUiString(aiRaw * 1_001_729_792_036_835_231n / 10n ** 18n)), "0.001301112331313196");
  assert.equal(agenticSellAmount(planned, m, "5.008648960184176155"), null, "without heldRaw a partial holding does not match");
});

test("PE3 partial sell: a portfolio executor sends the u-search amount for R < B with intended_raw R; the same holding is refused for AI; R above the holding is refused", async t => {
  const held = 5_000_000_000_000_000_000n, planned = 1_298_865_564_003_062n, m = "1.001729792036835231";
  const f = await portfolioFixture(t);
  sellWorld(f, SPYB, held, m, "5.008648960184176155");
  const result = await runTrade(f, { side: "sell", token: SPYB, amountWei: planned, quotedOutWei: 1000n * E, minOutWei: 990n * E });
  assert.equal(result.kind, "unknown");
  const swap = f.runner.calls.find(args => args[0] === "market-order" && args[1] === "swap")!;
  assert.equal(swap[swap.indexOf("--fromTokenQty") + 1], "0.001301112331312594");
  const order = (await f.store.orders(W))[0]!;
  assert.deepEqual({ intendedRaw: order.intendedRaw, amountAtomic: order.amountAtomic, fromQty: order.fromQty, multiplierPre: order.multiplierPre }, { intendedRaw: planned.toString(), amountAtomic: planned.toString(), fromQty: "0.001301112331312594", multiplierPre: m });
  const above = await portfolioFixture(t);
  sellWorld(above, SPYB, held, m, "5.008648960184176155");
  assert.deepEqual(await runTrade(above, { side: "sell", token: SPYB, amountWei: held + 1n, quotedOutWei: 1000n * E, minOutWei: 990n * E }), { kind: "denied", status: 409, code: "AGENTIC_AMOUNT_UNREPRESENTABLE" });
  assert.equal(above.runner.calls.some(args => args[0] === "market-order"), false);
  const ai = await fixture(t);
  sellWorld(ai, TOKEN, held, m, "5.008648960184176155");
  assert.deepEqual(await runTrade(ai, { side: "sell", token: TOKEN, amountWei: planned, quotedOutWei: 1000n * E, minOutWei: 990n * E }), { kind: "denied", status: 409, code: "AGENTIC_AMOUNT_UNREPRESENTABLE" });
  assert.equal(ai.runner.calls.some(args => args[0] === "wallet" && args[1] === "balance"), false, "the AI whole-balance rule refuses before any Binance read");
});

type Released = { kind: string; code: string | null; deniedBy: unknown; cliResult: string | null };
async function sealed(f: Fixture, patch: Parameters<typeof runTrade>[1] = { side: "buy" }): Promise<Released> {
  const result = await runTrade(f, patch);
  const order = await f.store.getOrder(keccak256(stringToBytes("portfolio-test-" + (patch.replay ?? lastSequence()))));
  return { kind: result.kind, code: "code" in result ? result.code : null, deniedBy: "meta" in result && result.meta !== undefined ? result.meta["deniedBy"] : undefined, cliResult: order?.cliResult ?? null };
}
const quoteReply = (f: Fixture, toCoinAmount: string) => f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null,
  data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount, slippage: "0" } });

const SEALS: [string, (f: Fixture, t: TestContext) => unknown, Parameters<typeof runTrade>[1] | undefined][] = [
  ["AGENTIC_QUOTE_BELOW_MIN", f => quoteReply(f, "1"), undefined],
  ["AGENTIC_QUOTE_NO_HEADROOM", f => quoteReply(f, "5"), { side: "buy", minOutWei: 5n * E, quotedOutWei: 5n * E }],
  ["AGENTIC_UNREACHABLE", f => { f.runner.replies.set("market-order quote", { kind: "no-response", code: "timeout", sessionPresent: true }); }, undefined],
  ["QUOTE_DAILY_CAP", (f, t) => { const begin = f.store.beginSwap.bind(f.store); t.mock.method(f.store, "beginSwap", async (...args: Parameters<typeof begin>) => ({ ...(await begin(...args)), otherQuoteSpendWei: 10n ** 30n })); }, undefined],
  ["agentic_wallet_busy", (f, t) => { let begun = false; const begin = f.store.beginSwap.bind(f.store), renew = f.store.renewFence.bind(f.store);
    t.mock.method(f.store, "beginSwap", async (...args: Parameters<typeof begin>) => { begun = true; return begin(...args); });
    t.mock.method(f.store, "renewFence", async (...args: Parameters<typeof renew>) => begun ? null : renew(...args)); }, undefined],
  ["AGENTIC_WALLET_OBLIGATION", (f, t) => { let calls = 0; t.mock.method(f.store, "walletObligations", async () => { calls += 1; return calls > 1; }); }, undefined],
  ["AGENTIC_CLAIM_REFUSED", (f, t) => { t.mock.method(f.store, "claimOrder", async () => null); }, undefined],
  ["AGENTIC_UNREACHABLE", (f, t) => { t.mock.method(f.runner, "prepare", async () => { throw new Error("spawn"); }); }, undefined],
  ["not-started", f => { f.runner.replies.set("market-order swap", { kind: "not-started", sessionPresent: true }); }, undefined],
];

test("PE4 provenance: every pre-claim seal and the not-started result of a portfolio hire carry deniedBy session; AI and Schedule keep today's meta", async t => {
  for (const [code, arrange, patch] of SEALS) {
    const f = await portfolioFixture(t);
    await arrange(f, t);
    const got = await sealed(f, patch);
    assert.deepEqual({ kind: got.kind, code: got.code, deniedBy: got.deniedBy }, { kind: "rolled-back", code, deniedBy: "session" }, code);
    for (const other of [await fixture(t), await fixture(t, {}, scheduleParams)]) {
      await arrange(other, t);
      const result = await runTrade(other, { side: "buy", ...patch, token: other.row.hireFacts!.pinned[0]! });
      assert.equal(result.kind, "rolled-back", code);
      assert.deepEqual(result.kind === "rolled-back" ? Object.keys(result.meta).sort() : null, ["decisionId", "idempotencyKey"], code);
    }
  }
});

test("PE5 provenance: the gate limit seal is released for a portfolio hire", async t => {
  const f = await portfolioFixture(t);
  await f.store.createRun({ runId: "run", gate: "G1", agentId: f.agent.id, wallet: W, side: "buy", maxDispatches: 5, dispatches: 0, maxNotionalUsdt: "1", maxCmcPayments: 0, cmcPayments: 0,
    cmcOperationIds: [], deadlineMs: NOW + 900_000, createdAt: NOW, closedAt: null });
  const got = await sealed(f, { side: "buy", execution: { ...f.execution, gateRunId: "run" } });
  assert.deepEqual({ code: got.code, deniedBy: got.deniedBy }, { code: "AGENTIC_GATE_LIMIT", deniedBy: "session" });
});

test("PE6 provenance: a ROLLED_BACK replay and a Binance-rejected order stay terminal (no deniedBy) for a portfolio hire", async t => {
  const f = await portfolioFixture(t);
  quoteReply(f, "1");
  const first = await runTrade(f, { side: "buy", replay: 7001 });
  assert.equal(first.kind === "rolled-back" ? first.meta["deniedBy"] : null, "session");
  const again = await runTrade(f, { side: "buy", replay: 7001 });
  assert.deepEqual({ kind: again.kind, code: again.kind === "rolled-back" ? again.code : null, deniedBy: again.kind === "rolled-back" ? again.meta["deniedBy"] : "missing" }, { kind: "rolled-back", code: "NOT_ALLOWED", deniedBy: undefined });
  const rejected = await portfolioFixture(t);
  let swapped = false;
  rejected.runner.replies.set("market-order swap", async () => { swapped = true; return { kind: "cli-error", code: 30003001, name: "ORDER_API_ERROR", orderId: "o1", sessionPresent: true }; });
  rejected.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: swapped
    ? { total: 1, page: 1, pageSize: 100, list: [{ orderId: "o1", status: "FAILED", txHash: null, bookTime: null }] } : { total: 0, page: 1, pageSize: 100, list: [] } }));
  const result = await runTrade(rejected, { side: "buy" });
  assert.deepEqual({ kind: result.kind, code: result.kind === "rolled-back" ? result.code : null, deniedBy: result.kind === "rolled-back" ? result.meta["deniedBy"] : "missing" }, { kind: "rolled-back", code: "binance-rejected", deniedBy: undefined });
});

const REFUSED = ["SERVICE_ERROR", "ORDER_API_ERROR", "APP_CONFIRMATION_REQUIRED", "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "INVALID_TOKEN", "INVALID_PARAMETER"];
const TRANSPORT = ["SESSION_EXPIRED", "NOT_LOGGED_IN", "UNAUTHORIZED", "REQUEST_TIMEOUT", "SERVICE_UNAVAILABLE", "NETWORK_ERROR", "UNKNOWN_ERROR", "DNS_ERROR", "TLS_ERROR"];
const cliError = (name: string) => ({ kind: "cli-error" as const, code: 4242, name, orderId: null, sessionPresent: true });

test("PE7 quote refusal: the seven refusal names seal AGENTIC_QUOTE_REFUSED with the Binance code and name; every transport name, a timeout and an unparseable reply stay unreachable; AI never changes", async t => {
  const f = await portfolioFixture(t), ai = await fixture(t);
  for (const name of REFUSED) {
    f.runner.replies.set("market-order quote", cliError(name));
    const got = await sealed(f);
    assert.deepEqual({ code: got.code, cliResult: got.cliResult, deniedBy: got.deniedBy }, { code: "AGENTIC_QUOTE_REFUSED", cliResult: `quote-refused:4242:${name}`, deniedBy: "session" }, name);
    ai.runner.replies.set("market-order quote", cliError(name));
    assert.deepEqual((({ code, cliResult }) => ({ code, cliResult }))(await sealed(ai)), { code: "AGENTIC_UNREACHABLE", cliResult: "AGENTIC_UNREACHABLE" }, "AI " + name);
  }
  for (const reply of [...TRANSPORT.map(cliError), { kind: "no-response" as const, code: "timeout" as const, sessionPresent: true }, { kind: "no-response" as const, code: "unparseable" as const, sessionPresent: true }]) {
    f.runner.replies.set("market-order quote", reply);
    const got = await sealed(f);
    assert.deepEqual({ code: got.code, cliResult: got.cliResult, deniedBy: got.deniedBy }, { code: "AGENTIC_UNREACHABLE", cliResult: "AGENTIC_UNREACHABLE", deniedBy: "session" }, JSON.stringify(reply));
  }
});

test("PE8 quote refusal provenance: a SELL is terminal under INVALID_TOKEN and INVALID_PARAMETER and released under the other five names; a BUY is released under all seven", async t => {
  const held = 5n * E;
  for (const name of REFUSED) {
    const sell = await portfolioFixture(t);
    sellWorld(sell, SPYB, held);
    sell.runner.replies.set("market-order quote", cliError(name));
    const got = await sealed(sell, { side: "sell", token: SPYB, amountWei: E, quotedOutWei: 1000n * E, minOutWei: 990n * E });
    const terminal = name === "INVALID_TOKEN" || name === "INVALID_PARAMETER";
    assert.deepEqual({ code: got.code, deniedBy: got.deniedBy }, { code: "AGENTIC_QUOTE_REFUSED", deniedBy: terminal ? undefined : "session" }, "sell " + name);
    const buy = await portfolioFixture(t);
    buy.runner.replies.set("market-order quote", cliError(name));
    assert.equal((await sealed(buy)).deniedBy, "session", "buy " + name);
  }
  // A transport failure on a sell is not a refusal of the leg: it is released.
  const transport = await portfolioFixture(t);
  sellWorld(transport, SPYB, held);
  transport.runner.replies.set("market-order quote", cliError("REQUEST_TIMEOUT"));
  assert.equal((await sealed(transport, { side: "sell", token: SPYB, amountWei: E, quotedOutWei: 1000n * E, minOutWei: 990n * E })).deniedBy, "session");
});

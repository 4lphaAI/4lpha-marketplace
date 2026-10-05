/** AGENTIC-PORTFOLIO: pins of today's AI and Schedule behaviour for the code the portfolio port touches (written and green on the pristine tree, kept as the PI2 regression guard). */
import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, stringToBytes, type Address } from "viem";
import { agenticGate, agenticGateInput, parseAgenticHireParams } from "../src/agentic/domain.js";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import { runAgenticCycle } from "../src/agentic/worker.js";
import type { AgenticOrder } from "../src/agentic/domain.js";
import { FACTS, NOW, PAIRING, TOKEN, W, fixture, scheduleParams, sha, type Fixture } from "./support/agenticSchedule.js";
import { payingCmc, runTrade } from "./support/agenticPortfolio.js";

const HOUR = 3_600_000;
const LIST_ARGV = ["market-order", "list", "--binanceChainId", "56", "--page", "1", "--pageSize", "1"].join(" ");
const body = (settings: typeof scheduleParams) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings });

test("PIN Schedule: agenticGate rows, order, states and fixes for a Schedule input are the pristine ones", () => {
  const rows: unknown[] = [];
  for (const [patch, term] of [[{}, 7], [{ bnbWei: "1", dailyLimit: 1 }, 30]] as const) {
    rows.push(agenticGate(agenticGateInput(parseAgenticHireParams({ ...body(scheduleParams), term })!, { ...FACTS, ...patch }, "0x1111111111111111111111111111111111111111", NOW)));
  }
  assert.equal(sha(rows), "b7bf181dfa5adc6755319049ffe2c2bc534e5c50bedbdcc276c2436785e0d7ad");
});

test("PIN Schedule: the free keep-alive clock counts an order row of any kind, including an x402-sign row", async t => {
  const f = await fixture(t, {}, scheduleParams);
  const order = (kind: AgenticOrder["kind"], createdAt: number): AgenticOrder => ({ idempotencyKey: keccak256(stringToBytes(kind + createdAt)), kind, walletAddress: W, agentId: f.agent.id,
    decisionId: null, side: null, fromToken: null, toToken: null, amountAtomic: null, intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null,
    multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: kind === "x402-sign" ? "op" : null, walletNoncePre: null, quoteAt: null, dispatch: "sealed", claimedAt: null,
    claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null,
    outcome: "committed", holdReason: null, evidence: null, fillCheck: "none", createdAt, updatedAt: createdAt });
  await f.store.createOrder(order("x402-sign", NOW + 6 * HOUR));
  const keepAlives = () => f.runner.calls.filter(args => args.join(" ") === LIST_ARGV).length;
  f.setTime(NOW + 18 * HOUR - 1); await runAgenticCycle(f.lifecycle); assert.equal(keepAlives(), 0);
  f.setTime(NOW + 18 * HOUR + 600_000); await runAgenticCycle(f.lifecycle); assert.equal(keepAlives(), 1);
});

test("PIN public DTO: the Schedule and AI agent key sets are the pristine ones", async t => {
  t.mock.method(Date, "now", () => NOW);
  const keys = async (f: Fixture) => { const dto = (await createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore,
    killswitch: f.killswitch, observer: { observe: async () => [] }, chain: f.chain })(W)).agent!;
    return { agent: Object.keys(dto), settings: Object.keys(dto.settings) }; };
  const common = ["name", "status", "holdCode", "endReason", "termDays", "termEndAction", "hireStartedAtMs", "entryCutoffAtMs", "hireEndsAtMs", "connection", "lastProbeAtMs", "heldOrders",
    "logoutPending", "settings", "limits", "cmc", "summary", "positions", "events", "runs", "cmcLog", "pinned"];
  const settingsKeys = ["executionModel", "primaryModel", "capitalQuoteWei", "entryWei", "minEntryWei", "maxOpenPositions", "slippageBps", "stopLossBps", "takeProfitBps", "maxHoldSec"];
  assert.deepEqual(await keys(await fixture(t, {}, scheduleParams)), { agent: [...common, "schedule"], settings: settingsKeys });
  assert.deepEqual(await keys(await fixture(t)), { agent: common, settings: settingsKeys });
});

test("PIN AI authorize: an AI hire's keep-going refresh reserves a payment; a paused agent reserves none", async t => {
  t.mock.method(Date, "now", () => NOW);
  const admitted = await fixture(t), a = await payingCmc(admitted);
  await a.cmc.refresh(admitted.agent.id);
  assert.equal((await admitted.cmcStore.listAttempts(admitted.agent.id, W)).length, 1);
  await a.cmc.runtime.close();
  const paused = await fixture(t), p = await payingCmc(paused);
  await paused.killswitch.pauseAgent(paused.agent.id, W);
  await p.cmc.refresh(paused.agent.id);
  assert.equal((await paused.cmcStore.listAttempts(paused.agent.id, W)).length, 0);
  await p.cmc.runtime.close();
});

test("PIN seal meta: an AI and a Schedule sealed refusal carry exactly the idempotency key and decision id, and an AI quote failure is AGENTIC_UNREACHABLE", async t => {
  const outcome = async (f: Fixture, reply: "low" | "error") => {
    f.runner.replies.set("market-order quote", reply === "low"
      ? { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "1", slippage: "0" } }
      : { kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true });
    const result = await runTrade(f, { side: "buy", token: TOKEN as Address });
    assert.equal(result.kind, "rolled-back");
    const order = (await f.store.orders(W))[0]!;
    return result.kind === "rolled-back" ? { code: result.code, meta: Object.keys(result.meta).sort(), cliResult: order.cliResult } : null;
  };
  assert.deepEqual(await outcome(await fixture(t), "low"), { code: "AGENTIC_QUOTE_BELOW_MIN", meta: ["decisionId", "idempotencyKey"], cliResult: "AGENTIC_QUOTE_BELOW_MIN" });
  assert.deepEqual(await outcome(await fixture(t, {}, scheduleParams), "low"), { code: "AGENTIC_QUOTE_BELOW_MIN", meta: ["decisionId", "idempotencyKey"], cliResult: "AGENTIC_QUOTE_BELOW_MIN" });
  assert.deepEqual(await outcome(await fixture(t), "error"), { code: "AGENTIC_UNREACHABLE", meta: ["decisionId", "idempotencyKey"], cliResult: "AGENTIC_UNREACHABLE" });
});

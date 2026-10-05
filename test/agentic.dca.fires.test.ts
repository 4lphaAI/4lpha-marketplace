/** AGENTIC-DCA Revision 3 (R3.5, R31.1, R31.6 H5-1): fire recovery from the swap row, the replay guard, and the three DCA-only executor changes. */
import assert from "node:assert/strict";
import test from "node:test";
import { E, NOW, W } from "./support/agenticSchedule.js";
import { MINUTE, SPYB, armed, dcaLane, type DcaWorld } from "./support/agenticDca.js";
import { executeAgenticTrade } from "../src/agentic/execute.js";
import type { AgenticGateRun } from "../src/agentic/domain.js";
import type { TradeRequest } from "../src/http/wire.js";
import { dcaMinOut } from "../src/agentic/dca.js";

async function run(w: DcaWorld, cycles: number): Promise<void> { for (let i = 0; i < cycles; i += 1) { await w.tick(); await w.advance(MINUTE); } }
const swapRows = async (w: DcaWorld) => (await w.f.store.orders(W)).filter(o => o.kind === "swap").sort((a, b) => a.createdAt - b.createdAt);
function spy(w: DcaWorld): TradeRequest[] {
  const requests: TradeRequest[] = [];
  const executor = w.input.worker.executor, real = executor.execute.bind(executor);
  executor.execute = async input => { requests.push(input.request); return real(input); };
  return requests;
}
/** the level 1 row left `placing` by a crash between the fire CAS and beginSwap: its swap row does not exist */
async function crashed(w: DcaWorld): Promise<string> {
  const [l1] = await armed(w, "level", 1);
  await w.f.store.patchDcaOrder(l1!, { state: "placing", placeOrderKey: "never-written-swap-key" });
  return "never-written-swap-key";
}
const ALLOW = { async evaluate() { return { verdict: "allow" as const, reasons: [] }; } };
async function direct(w: DcaWorld, request: TradeRequest, run?: AgenticGateRun) {
  const agent = (await w.f.worker.agentStore.getAgentById(w.f.agent.id))!;
  const identity = w.input.worker.executionIdentity(agent, request);
  return executeAgenticTrade({ agent, request, scanGate: ALLOW, ...identity, deps: w.f.executorDeps } as never, { ...w.f.execution, ...(run === undefined ? {} : { gateRunId: run.runId }) });
}
const buyRequest = (amount: bigint, id: string): TradeRequest => {
  const quoted = amount * 100_000_000n / 70_000_000_000n;
  return { decisionId: id, venue: "pancake_v3", side: "buy", token: SPYB, amountWei: amount, minOutWei: dcaMinOut(quoted, 50), quotedOutWei: quoted, route: { hops: [], fees: [100] }, settlementAsset: "USDT", platformFeeAtomic: 0n } as TradeRequest;
};
const gateRun = async (w: DcaWorld, side: AgenticGateRun["side"], id: string): Promise<AgenticGateRun> => {
  const row: AgenticGateRun = { runId: id, gate: "DG2", agentId: w.f.agent.id, wallet: W, side, maxDispatches: 5, dispatches: 0, maxNotionalUsdt: (100n * E).toString(), maxCmcPayments: 0, cmcPayments: 0,
    cmcOperationIds: [], deadlineMs: NOW + 3_600_000, createdAt: NOW, closedAt: null };
  assert.equal(await w.f.store.createRun(row), true);
  return row;
};

test("F1 H5-1: a placing row with no swap row goes back to resting on the next cycle while active, uncounted; its re-fire keeps the decision id and writes the new key", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  const stale = await crashed(w);
  const requests = spy(w);
  await w.tick();
  const [l1] = await armed(w, "level", 1);
  assert.deepEqual([l1!.state, l1!.placeOrderKey], ["resting", stale], "re-armed, the stale key untouched until a fire");
  assert.equal((await w.rounds())[0]!.failStreak, 0, "not counted");
  w.setPrice(692.5); await w.advance(MINUTE); await w.tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.decisionId, `dca:${w.f.agent.id}:1:level1:1`, "no swap row carries the prefix, so n is unchanged");
  const swap = (await swapRows(w)).at(-1)!;
  const [filled] = await armed(w, "level", 1);
  assert.deepEqual([filled!.state, filled!.placeOrderKey], ["filled", swap.idempotencyKey]);
  assert.notEqual(filled!.placeOrderKey, stale);
});

test("F2 H5-1: in a terminal phase the row is cancelled by the plane; a round never ends while a placing row has an open unheld swap", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await crashed(w);
  const [round] = await w.rounds();
  await w.f.store.patchDcaRound(round!, { phase: "closing" });
  await w.tick();
  const [l1] = await armed(w, "level", 1);
  assert.deepEqual([l1!.state, l1!.closedBy], ["cancelled", "plane"]);
});

test("F3 a placing row whose swap row is open with no hold still waits", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const [l1] = await armed(w, "level", 1);
  const key = "open-unheld";
  await w.f.store.createOrder({ idempotencyKey: key, kind: "swap", walletAddress: W, agentId: w.f.agent.id, decisionId: `dca:${w.f.agent.id}:1:level1:1`, side: "buy", fromToken: null, toToken: null,
    amountAtomic: (10n * E).toString(), intendedRaw: null, fromQty: "10", minOutAtomic: "1", binanceQuoteOutAtomic: "1", slippagePct: "0.5", multiplierPre: "1", multiplierUsed: null,
    listSnapshot: { takenAtMs: w.now(), startTimeMs: w.now() - 86_400_000, ids: ["listed-1"] }, operationId: null, walletNoncePre: null, quoteAt: w.now(), dispatch: "spawned", claimedAt: w.now(),
    claimant: "x", fenceToken: "1", claimDeadline: null, response: "accepted", cliResult: "accepted", returnedOrderId: "returned-x", listedOrderId: null, txHash: null, approveTxHash: null,
    outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: w.now(), updatedAt: w.now() });
  await w.f.store.patchDcaOrder(l1!, { state: "placing", placeOrderKey: key });
  w.setPrice(680);
  const swaps = w.market.swapCalls().length;
  await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "placing");
  assert.equal(w.market.swapCalls().length, swaps, "nothing fires while a swap row is open");
});

test("F4 a seeded journal row with the same decision id and other parameters gives denied conflict and no dispatch", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await w.f.journal.begin({ idempotencyKey: "seeded-journal", agentId: w.f.agent.id, ownerAddress: W, kind: "trade", decisionId: `dca:${w.f.agent.id}:1:level1:1`,
    externalRef: { paramsHash: `0x${"ab".repeat(32)}`, sessionGeneration: 1 }, nativeSpendWei: 0n });
  w.setPrice(692.5);
  const swaps = w.market.swapCalls().length;
  await w.tick();
  assert.equal(w.market.swapCalls().length, swaps, "no dispatch");
  assert.equal(await w.code(), "dca-waiting");
  assert.equal((await armed(w, "level", 1))[0]!.state, "resting");
  assert.equal((await swapRows(w)).filter(o => o.decisionId === `dca:${w.f.agent.id}:1:level1:1`).length, 0, "no swap row either");
});

test("F5 level-buy bound: a 10 USDT buy passes, a 15 USDT buy is refused, the 25 USDT base passes", async t => {
  const w = await dcaLane(t);
  await w.tick(); // the base
  assert.equal(w.market.swapCalls().length, 1, "25 USDT passes");
  const ten = await direct(w, buyRequest(10n * E, "dca:direct:10"));
  assert.equal(ten.kind, "committed", "10 USDT passes (the order size)");
  const fifteen = await direct(w, buyRequest(15n * E, "dca:direct:15"));
  assert.deepEqual([fifteen.kind, (fifteen as { code?: string }).code], ["denied", "USDT_ENTRY_BOUNDS"]);
  const other = await dcaLane(t);
  await other.tick();
  const twentyFive = await direct(other, buyRequest(25n * E, "dca:direct:25"));
  assert.equal(twentyFive.kind, "committed");
});

test("F6 a dca gate run admits both sides of a DCA hire; a buy run refuses the sale; an AI hire refuses a sale under a dca run", async t => {
  const w = await dcaLane(t);
  await w.tick(); // the base: stock held
  const dca = await gateRun(w, "dca", "11111111-1111-4111-8111-111111111111");
  const buy = await direct(w, buyRequest(10n * E, "dca:run:buy"), dca);
  assert.equal(buy.kind, "committed");
  const stock = w.state.balances.get(SPYB)!;
  const sale = (amount: bigint, id: string): TradeRequest => ({ ...buyRequest(10n * E, id), side: "sell", amountWei: amount, quotedOutWei: amount * 700n, minOutWei: dcaMinOut(amount * 700n, 50) }) as TradeRequest;
  const sell = await direct(w, sale(stock / 2n, "dca:run:sell"), dca);
  assert.equal(sell.kind, "committed", "a dca run admits the sell of a DCA hire (a partial one)");
  const buyOnly = await gateRun(w, "buy", "22222222-2222-4222-8222-222222222222");
  const refused = await direct(w, sale(1_000_000_000_000_000n, "dca:run:sell2"), buyOnly);
  assert.deepEqual([refused.kind, (refused as { code?: string }).code], ["denied", "AGENTIC_GATE_LIMIT"]);
  // an AI hire: a dca run admits nothing but its own side rule
  const ai = await dcaLane(t, { ai: true });
  const aiRun = await gateRun(ai, "dca", "33333333-3333-4333-8333-333333333333");
  const aiSell = await direct(ai, sale(1_000_000_000_000_000n, "ai:run:sell"), aiRun);
  assert.deepEqual([aiSell.kind, (aiSell as { code?: string }).code], ["denied", "AGENTIC_GATE_LIMIT"]);
});

test("F7 a partial sell is admitted for a DCA hire (the take profit sells Q while the wallet holds more) and still refused for AI and Schedule hires", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.state.balances.set(SPYB, (w.state.balances.get(SPYB) ?? 0n) + 1_000_000_000_000_000n); // stock the owner added
  const [round] = await w.rounds();
  w.setPrice(725); await w.tick();
  const sell = (await swapRows(w)).at(-1)!;
  assert.equal(sell.side, "sell");
  assert.equal(sell.outcome, "committed");
  assert.equal(BigInt(sell.amountAtomic!), BigInt(round!.stockRaw), "Q = H, not the whole balance");
  assert.equal(w.state.balances.get(SPYB), 1_000_000_000_000_000n, "the owner's extra stock is never sold");
  const ai = await dcaLane(t, { ai: true });
  ai.state.balances.set(SPYB, (ai.state.balances.get(SPYB) ?? 0n) + 1_000_000_000_000_000n);
  const held = ai.state.balances.get(SPYB)!;
  const refused = await direct(ai, { ...buyRequest(10n * E, "ai:partial"), side: "sell", amountWei: held / 2n, quotedOutWei: held * 350n, minOutWei: dcaMinOut(held * 350n, 50) } as TradeRequest);
  assert.deepEqual([refused.kind, (refused as { code?: string }).code], ["denied", "AGENTIC_AMOUNT_UNREPRESENTABLE"]);
});

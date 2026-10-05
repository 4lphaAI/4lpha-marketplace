/** AGENTIC-DCA Revision 3 (R3.8, R3.12): the gate tool keeps run-start DG1..DG6 with side dca and `status` rounds and orders, drops dca-probe and the DCA dispose, and gains the legacy rollback of a row the retired limit build left. */
import assert from "node:assert/strict";
import test from "node:test";
import { agenticGateWallets, parseAgenticGateArgs, runAgenticGate } from "../scripts/agentic-gate.js";
import type { AgenticGateRun, AgenticOrder } from "../src/agentic/domain.js";
import { E, W } from "./support/agenticSchedule.js";
import { MINUTE, SPYB, USDT, armed, dcaLane, type DcaWorld } from "./support/agenticDca.js";

function context(w: DcaWorld, printed: unknown[], wallets = agenticGateWallets(W)) {
  const f = w.f;
  return { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets, print: (v: unknown) => printed.push(v), cycle: async () => undefined };
}
const go = async (w: DcaWorld, argv: string[], printed: unknown[] = []) => { await runAgenticGate(parseAgenticGateArgs(argv), context(w, printed)); return printed; };
async function startRun(w: DcaWorld, gate = "DG1", side = "dca", max = "3", notional = "10"): Promise<AgenticGateRun> {
  const printed: unknown[] = [];
  await go(w, ["run-start", "--gate", gate, "--agent", w.f.agent.id, "--side", side, "--max-dispatches", max, "--max-notional-usdt", notional, "--max-cmc-payments", "0", "--deadline-min", "60"], printed);
  return printed[0] as AgenticGateRun;
}
const KIND = "limit-" + "place";

test("GT1 parsing: dca-probe and the DCA dispose options are gone; the DG gates and side dca stay", () => {
  for (const sub of ["place", "cancel", "timer", "list"]) assert.throws(() => parseAgenticGateArgs(["dca-probe", sub, "--agent", "a"]), /AGENTIC_GATE_COMMAND/, sub);
  for (const option of ["--dca-order", "--bind-strategy", "--commit-fill-tx", "--mark-terminal"]) assert.throws(() => parseAgenticGateArgs(["dispose", option, "x"]), /AGENTIC_GATE_ARGUMENT/, option);
  const rollback = parseAgenticGateArgs(["dispose", "--order", "limit-place:k", "--rollback", "--attest", "evidence", "--yes-live"]);
  assert.deepEqual([rollback.command, rollback.values["rollback"], rollback.live], ["dispose", "true", true]);
});

test("GT2 run-start accepts DG1..DG6 and side dca; status prints the DCA rounds and orders and no Binance read", async t => {
  const w = await dcaLane(t);
  for (const gate of ["DG1", "DG2", "DG3", "DG4", "DG5", "DG6"]) assert.equal((await startRun(w, gate)).gate, gate);
  await assert.rejects(startRun(w, "DG7"), /AGENTIC_GATE_LIMITS/);
  for (let i = 0; i < 2; i += 1) { await w.tick(); await w.advance(MINUTE); }
  const before = w.market.calls.length;
  const printed: unknown[] = [];
  await go(w, ["status", "--agent", w.f.agent.id], printed);
  const status = printed[0] as { dca: { rounds: unknown[]; orders: unknown[]; list?: unknown }; obligations: boolean };
  assert.deepEqual([status.dca.rounds.length, status.dca.orders.length, status.dca.list], [1, 2, undefined]);
  assert.equal(status.obligations, false);
  assert.equal(w.market.calls.slice(before).filter(c => c[0] === "limit-order").length, 0, "no limit-order read in status");
});

test("GT3 cycle-once under a DCA run: the base buy is admitted with run side dca and counts a slot; a sell-side run does not admit it", async t => {
  const { runAgenticCycle } = await import("../src/agentic/worker.js");
  const { executeAgenticTrade } = await import("../src/agentic/execute.js");
  const cycle = async (w: DcaWorld, id: string) => {
    const execution = { ...w.f.execution, gateRunId: id };
    const worker = { ...w.input.worker, executor: { execute: (request: Parameters<typeof w.input.worker.executor.execute>[0]) => executeAgenticTrade({ ...request, deps: w.f.executorDeps } as never, execution) } };
    await runAgenticCycle({ ...w.input, execution, worker });
  };
  const w = await dcaLane(t);
  const run = await startRun(w, "DG2", "dca", "3", "25");
  await cycle(w, run.runId);
  assert.equal(w.market.swapCalls().length, 1);
  assert.equal((await w.f.store.getRun(run.runId))!.dispatches, 1, "the base buy took one slot");
  const sell = await dcaLane(t);
  const bad = await startRun(sell, "DG2", "sell", "3", "25");
  await cycle(sell, bad.runId);
  assert.equal(sell.market.swapCalls().length, 0, "a sell-side run admits no buy");
});

/** a limit row and its DCA order as the retired build left them: the order `placing`, its dispatch row open with an unanswered placement */
async function legacy(w: DcaWorld, role: "tp" | "level", levelNo: number | null): Promise<{ key: string; dispatch: AgenticOrder }> {
  const key = `dca:${w.f.agent.id}:1:${role}${levelNo ?? ""}:1`;
  const dispatch: AgenticOrder = { idempotencyKey: "limit-" + "place:" + key, kind: KIND as AgenticOrder["kind"], walletAddress: W, agentId: w.f.agent.id, decisionId: null, side: role === "tp" ? "sell" : "buy",
    fromToken: USDT, toToken: SPYB, amountAtomic: "1", intendedRaw: null, fromQty: "1", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: "0.5", multiplierPre: null, multiplierUsed: null,
    listSnapshot: null, operationId: null, walletNoncePre: null, quoteAt: w.now(), dispatch: "spawned", claimedAt: w.now(), claimant: null, fenceToken: "1", claimDeadline: null, response: "no-response",
    cliResult: "cli-error:2:SERVICE_ERROR", returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: "no-response", evidence: null, fillCheck: "none",
    createdAt: w.now(), updatedAt: w.now() };
  assert.equal(await w.f.store.createOrder(dispatch), true);
  assert.equal(await w.f.store.insertDcaOrder({ orderKey: key, agentId: w.f.agent.id, walletAddress: W, roundNo: 1, role, levelNo, side: role === "tp" ? "sell" : "buy", priceNum: "710500000000000000000", priceDen: "1000000000000000000",
    triggerSent: "710.5", qtySent: "0.1", qtyAtomic: "100000000000000000", slippagePct: "0.5", placeOrderKey: dispatch.idempotencyKey, cancelOrderKey: null, strategyId: null, listStatus: null, unitQty: null,
    unitTrigger: null, state: "held", closedBy: null, holdReason: "no-response", txHash: null, fillUsdtWei: null, fillStockRaw: null, executor: null, rowVersion: 1, createdAt: w.now(), updatedAt: w.now() }), true);
  return { key, dispatch };
}

test("GT4 legacy rollback: the generic dispose rolls back a limit row with no journal step and cancels its DCA order; any other branch is refused; the dry run changes nothing", async t => {
  const w = await dcaLane(t);
  await w.tick(); // the base: an active round
  const { key, dispatch } = await legacy(w, "tp", null);
  const touched: string[] = [];
  const journal = w.f.journal as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ["markRolledBack", "resolveUnknown", "markCommitted", "advanceUnknown"]) { const real = journal[name]!.bind(journal); journal[name] = (...a: unknown[]) => { touched.push(name); return real(...a); }; }
  const dry: unknown[] = [];
  await go(w, ["dispose", "--order", dispatch.idempotencyKey], dry);
  assert.equal((dry[0] as { live: boolean }).live, false);
  assert.equal((await w.f.store.getOrder(dispatch.idempotencyKey))!.outcome, "open");
  await assert.rejects(go(w, ["dispose", "--order", dispatch.idempotencyKey, "--commit-tx", `0x${"11".repeat(32)}`, "--yes-live"]), /AGENTIC_DISPOSITION_BRANCH|AGENTIC_ATTESTATION/);
  await assert.rejects(go(w, ["dispose", "--order", dispatch.idempotencyKey, "--rollback", "--yes-live"]), /AGENTIC_ATTESTATION_REQUIRED/);
  assert.equal(await w.f.store.walletObligations(W), true, "the open row is an obligation until it is rolled back");
  const done: unknown[] = [];
  await go(w, ["dispose", "--order", dispatch.idempotencyKey, "--rollback", "--attest", "SERVICE_ERROR Raw limit orders are not supported", "--yes-live"], done);
  const row = (await w.f.store.getOrder(dispatch.idempotencyKey))!;
  assert.deepEqual([row.outcome, (done[0] as { obligations: boolean }).obligations], ["rolled-back", false]);
  assert.deepEqual(touched, [], "no journal step exists for a limit row");
  const order = (await w.f.store.getDcaOrder(key))!;
  assert.deepEqual([order.state, order.closedBy], ["cancelled", "plane"]);
});

test("GT5 D15 (b): an active legacy round whose take profit was refused and rolled back arms a fresh take profit and its levels under Revision 3", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await w.tick();
  const { dispatch } = await legacy(w, "tp", null);
  await go(w, ["dispose", "--order", dispatch.idempotencyKey, "--rollback", "--attest", "refused", "--yes-live"]);
  await w.advance(MINUTE); await w.tick();
  const tps = await armed(w, "tp");
  assert.deepEqual(tps.map(o => o.state), ["cancelled", "resting"], "the cancelled legacy row stays; a new attempt is armed");
  assert.equal(tps[1]!.orderKey.endsWith(":2"), true);
  assert.equal((await armed(w, "level", 1))[0]!.state, "resting");
  assert.equal(BigInt(tps[1]!.qtyAtomic) > 0n, true);
  void E;
});

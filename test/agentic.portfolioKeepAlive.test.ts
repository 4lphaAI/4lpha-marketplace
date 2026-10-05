/** AGENTIC-PORTFOLIO: the paid CMC keep-alive (idle gate, admission, x402 hold), the free 12 h list and the gate tool. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { keccak256, stringToBytes } from "viem";
import type { AgenticOrder } from "../src/agentic/domain.js";
import { runAgenticCycle } from "../src/agentic/worker.js";
import { agenticGateWallets, parseAgenticGateArgs, runAgenticGate } from "../scripts/agentic-gate.js";
import { NOW, W, fixture, settingsOutput, type Fixture } from "./support/agenticSchedule.js";
import { payingCmc, portfolioFixture, runTrade } from "./support/agenticPortfolio.js";

// NOW is Sunday 13:46 EDT. Activity at NOW + 7 h (20:46 EDT) is 12 h old at Monday 08:46 EDT, after the 08:00 ET anchor at which a macro or global call is due.
const HOUR = 3_600_000, TWELVE = 12 * HOUR, ACTIVE = 7 * HOUR;
const LIST_ARGV = ["market-order", "list", "--binanceChainId", "56", "--page", "1", "--pageSize", "1"].join(" ");
const keepAlives = (f: Fixture) => f.runner.calls.filter(args => args.join(" ") === LIST_ARGV).length;

function order(f: Fixture, patch: Partial<AgenticOrder>): AgenticOrder {
  const at = patch.createdAt ?? NOW;
  return { idempotencyKey: keccak256(stringToBytes(JSON.stringify([patch.kind, at, patch.quoteAt]))), kind: "swap", walletAddress: W, agentId: f.agent.id, decisionId: null, side: null,
    fromToken: null, toToken: null, amountAtomic: null, intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null,
    multiplierUsed: null, listSnapshot: null, operationId: patch.kind === "x402-sign" ? "op" : null, walletNoncePre: null, quoteAt: null, dispatch: "sealed", claimedAt: null,
    claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null,
    outcome: "committed", holdReason: null, evidence: null, fillCheck: "none", createdAt: at, updatedAt: at, ...patch };
}
/** The wall clock the CMC runtime reads, the store clock and the instance heartbeat (a payment needs a live instance) move together. */
const clockAt = (t: TestContext, f: Fixture) => { let at = NOW; t.mock.method(Date, "now", () => at); return async (ms: number) => { at = ms; f.setTime(ms); await f.instance.heartbeat(); }; };

test("PK1 paid idle gate: nothing is paid while a quoted swap or a settled payment is younger than 12 h; at exactly 12 h the fence is taken and the runtime is asked once", async t => {
  const f = await portfolioFixture(t), at = clockAt(t, f), { cmc, seen } = await payingCmc(f);
  const fences = t.mock.method(f.store, "acquireFence");
  await f.store.createOrder(order(f, { quoteAt: NOW + ACTIVE, createdAt: NOW + ACTIVE }));
  await at(NOW + ACTIVE + TWELVE - 1); await cmc.refresh(f.agent.id);
  assert.deepEqual([fences.mock.callCount(), seen.challenges], [0, 0]);
  await at(NOW + ACTIVE + TWELVE); await cmc.refresh(f.agent.id);
  assert.deepEqual([fences.mock.callCount() > 0, seen.challenges], [true, 1]);
  await cmc.runtime.close();
  // A settled payment resets the clock the same way (its reserve time).
  const g = await portfolioFixture(t), atG = clockAt(t, g), second = await payingCmc(g);
  t.mock.method(g.cmcStore, "listAttempts", async () => [{ state: "settled", createdAt: NOW + ACTIVE } as never]);
  const gFences = t.mock.method(g.store, "acquireFence");
  await atG(NOW + ACTIVE + TWELVE - 1); await second.cmc.refresh(g.agent.id);
  assert.equal(gFences.mock.callCount(), 0);
  await atG(NOW + ACTIVE + TWELVE); await second.cmc.refresh(g.agent.id);
  assert.equal(gFences.mock.callCount() > 0, true);
  await second.cmc.runtime.close();
});

test("PK2 paid idle gate: a swap row sealed before any Binance call, an x402-sign row and another agent's row are not activity", async t => {
  const f = await portfolioFixture(t), at = clockAt(t, f), { cmc, seen } = await payingCmc(f);
  await f.store.createOrder(order(f, { quoteAt: null, createdAt: NOW + 17 * HOUR }));
  await f.store.createOrder(order(f, { kind: "x402-sign", createdAt: NOW + 17 * HOUR }));
  await f.store.createOrder(order(f, { agentId: "someone-else", quoteAt: NOW + 17 * HOUR, createdAt: NOW + 17 * HOUR }));
  await at(NOW + ACTIVE + TWELVE); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 1);
  await cmc.runtime.close();
});

test("PK3 paid idle gate: a failed attempt neither resets the idle clock nor is retried before the hourly spacing; a pending attempt blocks a second payment", async t => {
  const f = await portfolioFixture(t), at = clockAt(t, f), { cmc, seen } = await payingCmc(f);
  await at(NOW + ACTIVE + TWELVE); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 1);
  assert.equal((await f.cmcStore.listAttempts(f.agent.id, W)).every(a => a.state !== "settled"), true);
  await at(NOW + ACTIVE + TWELVE + 60_000); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 1, "inside the hourly spacing");
  await at(NOW + ACTIVE + TWELVE + HOUR + 60_000); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 2, "the idle window is still open after a failed attempt");
  await cmc.runtime.close();
  const p = await portfolioFixture(t), atP = clockAt(t, p), pending = await payingCmc(p);
  await atP(NOW + ACTIVE + TWELVE);
  assert.equal(await p.cmcStore.claimNewsSlot({ agentId: p.agent.id, ownerAddress: W, operationId: "op", nowMs: NOW + ACTIVE + TWELVE }), true);
  assert.ok(await p.cmcStore.reserve({ agentId: p.agent.id, ownerAddress: W, wallet: W, operationId: "op", attemptId: "attempt", amountWei: 10n ** 16n }));
  await pending.cmc.refresh(p.agent.id);
  assert.equal(pending.seen.challenges, 0);
  await pending.cmc.runtime.close();
});

test("PK4 AI refresh has no idle gate: a quote a minute old does not stop its payment", async t => {
  const f = await fixture(t), at = clockAt(t, f), { cmc, seen } = await payingCmc(f);
  await f.store.createOrder(order(f, { quoteAt: NOW, createdAt: NOW }));
  await at(NOW + 60_000); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 1);
  await cmc.runtime.close();
});

test("PK5 admission: a portfolio hire is admitted on its hire facts; facts that say CMC is off refuse the reserve", async t => {
  const f = await portfolioFixture(t), at = clockAt(t, f), { cmc } = await payingCmc(f);
  await at(NOW + ACTIVE + TWELVE); await cmc.refresh(f.agent.id);
  assert.equal((await f.cmcStore.listAttempts(f.agent.id, W)).length, 1);
  await cmc.runtime.close();
  const g = await portfolioFixture(t), atG = clockAt(t, g), refused = await payingCmc(g);
  const byAgent = g.store.byAgent.bind(g.store);
  // The facts flip after the challenge was fetched, i.e. exactly where the reserve asks for admission.
  t.mock.method(g.store, "byAgent", async (id: string) => { const row = await byAgent(id);
    return row === null || row.hireFacts === null || refused.seen.challenges === 0 ? row : { ...row, hireFacts: { ...row.hireFacts, hireSizing: { ...row.hireFacts.hireSizing, cmcNewsEnabled: false } } }; });
  await atG(NOW + ACTIVE + TWELVE); await refused.cmc.refresh(g.agent.id);
  assert.deepEqual([refused.seen.challenges, (await g.cmcStore.listAttempts(g.agent.id, W)).length], [1, 0]);
  await refused.cmc.runtime.close();
});

test("PK6 x402 hold: below 0.50 USDT every portfolio leg is held, the paid refresh stands down, the free list still runs, and raising the limit clears the hold", async t => {
  const f = await portfolioFixture(t), at = clockAt(t, f);
  f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), x402DailyLimit: 0.49 } });
  const first = await runTrade(f, { side: "buy" });
  assert.deepEqual([first.kind, (await f.store.byAgent(f.agent.id))?.settingsHold?.code], ["denied", "x402-limit"]);
  const second = await runTrade(f, { side: "buy" });
  assert.deepEqual(second.kind === "denied" ? second.code : null, "AGENTIC_SETTINGS_HOLD");
  const fences = t.mock.method(f.store, "acquireFence");
  await f.cmc.refresh(f.agent.id);
  assert.equal(fences.mock.callCount(), 0);
  t.mock.method(f.cmc, "refresh", async () => undefined);
  await at(NOW + TWELVE); await runAgenticCycle(f.lifecycle);
  assert.equal(keepAlives(f), 1, "the free list runs under the hold");
  f.runner.replies.set("wallet settings", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { ...settingsOutput(), x402DailyLimit: 0.5 } });
  await at(NOW + TWELVE + 60_000); await runAgenticCycle(f.lifecycle);
  assert.equal((await f.store.byAgent(f.agent.id))?.settingsHold, null);
});

test("PF1 free list: a portfolio hire reads market-order list 12 h after its last answer or quoted swap, and an x402-sign row never postpones it", async t => {
  // One fixture per instant: the probe block runs at most once per 300 s of its own clock.
  const early = await portfolioFixture(t), atEarly = clockAt(t, early);
  t.mock.method(early.cmc, "refresh", async () => undefined);
  await atEarly(NOW + TWELVE - 1); await runAgenticCycle(early.lifecycle); assert.equal(keepAlives(early), 0);
  const a = await portfolioFixture(t), atA = clockAt(t, a);
  t.mock.method(a.cmc, "refresh", async () => undefined);
  await a.store.createOrder(order(a, { kind: "x402-sign", createdAt: NOW + 11 * HOUR }));
  await atA(NOW + TWELVE); await runAgenticCycle(a.lifecycle); assert.equal(keepAlives(a), 1);
  const b = await portfolioFixture(t), atB = clockAt(t, b);
  t.mock.method(b.cmc, "refresh", async () => undefined);
  await b.store.createOrder(order(b, { quoteAt: NOW + 6 * HOUR, createdAt: NOW + 6 * HOUR }));
  await atB(NOW + TWELVE); await runAgenticCycle(b.lifecycle); assert.equal(keepAlives(b), 0);
  await atB(NOW + 18 * HOUR + 600_000); await runAgenticCycle(b.lifecycle); assert.equal(keepAlives(b), 1);
  // A swap row sealed before any Binance call (no quote) is not measured activity either.
  const c = await portfolioFixture(t), atC = clockAt(t, c);
  t.mock.method(c.cmc, "refresh", async () => undefined);
  await c.store.createOrder(order(c, { quoteAt: null, createdAt: NOW + 6 * HOUR }));
  await atC(NOW + TWELVE); await runAgenticCycle(c.lifecycle); assert.equal(keepAlives(c), 1);
});

test("PF2 free list: the clock starts at the list's own last answer, so a read at 8 h pushes the next one to 20 h", async t => {
  const a = await portfolioFixture(t, { probe: { lastAtMs: 0, firstUAtMs: null, unreachableAtMs: null, keepAliveAtMs: NOW + 8 * HOUR } }), atA = clockAt(t, a);
  t.mock.method(a.cmc, "refresh", async () => undefined);
  await atA(NOW + TWELVE); await runAgenticCycle(a.lifecycle);
  assert.equal(keepAlives(a), 0);
  const b = await portfolioFixture(t, { probe: { lastAtMs: 0, firstUAtMs: null, unreachableAtMs: null, keepAliveAtMs: NOW + 8 * HOUR } }), atB = clockAt(t, b);
  t.mock.method(b.cmc, "refresh", async () => undefined);
  await atB(NOW + 20 * HOUR); await runAgenticCycle(b.lifecycle);
  assert.equal(keepAlives(b), 1);
  assert.equal((await b.store.byAgent(b.agent.id))?.probe?.keepAliveAtMs, NOW + 20 * HOUR);
});

// ---- The gate tool ----------------------------------------------------------------------------------------------------------------------------------

function toolContext(f: Fixture, printed: unknown[]) {
  return { ...f.execution, agents: f.agents, journal: f.journal, positions: f.positions, killswitch: f.killswitch, wallets: agenticGateWallets(W),
    print: (value: unknown) => printed.push(value), cycle: async () => undefined };
}

test("PT1 gate tool: status prints cliResult, listedOrderId and quoteAt, only the 25 newest orders newest first, and totalOrders; run-close prints the counters", async t => {
  const f = await portfolioFixture(t), printed: unknown[] = [];
  for (let i = 0; i < 40; i += 1) await f.store.createOrder(order(f, { createdAt: NOW + i, quoteAt: NOW + i, cliResult: "quote-refused:1:SERVICE_ERROR", listedOrderId: "l" + i }));
  await runAgenticGate(parseAgenticGateArgs(["status", "--agent", f.agent.id]), toolContext(f, printed));
  const status = printed[0] as { totalOrders: number; orders: { key: string; cliResult: string | null; listedOrderId: string | null; quoteAt: number | null }[] };
  assert.equal(status.totalOrders, 40); assert.equal(status.orders.length, 25);
  assert.deepEqual(status.orders.map(o => o.quoteAt), Array.from({ length: 25 }, (_, i) => NOW + 39 - i));
  assert.deepEqual([status.orders[0]!.cliResult, status.orders[0]!.listedOrderId], ["quote-refused:1:SERVICE_ERROR", "l39"]);
  printed.length = 0;
  await runAgenticGate(parseAgenticGateArgs(["run-start", "--gate", "G0", "--agent", f.agent.id, "--side", "none", "--max-dispatches", "0", "--max-notional-usdt", "0", "--max-cmc-payments", "1", "--deadline-min", "15"]), toolContext(f, printed));
  const run = printed[0] as { runId: string };
  assert.equal(await f.store.consumeRun(run.runId, "cmc"), true);
  printed.length = 0;
  await runAgenticGate(parseAgenticGateArgs(["run-close", "--run", run.runId]), toolContext(f, printed));
  assert.deepEqual(printed[0], { runId: run.runId, closed: true, dispatches: 0, cmcPayments: 1 });
});

test("PT2 gate tool negative check: inside 12 h of activity the paid refresh consumes no CMC slot and creates no x402-sign order; at 12 h it consumes the slot", async t => {
  const f = await portfolioFixture(t), at = clockAt(t, f);
  await f.store.createRun({ runId: "cmc-run", gate: "G0", agentId: f.agent.id, wallet: W, side: "none", maxDispatches: 0, dispatches: 0, maxNotionalUsdt: "0", maxCmcPayments: 1, cmcPayments: 0,
    cmcOperationIds: [], deadlineMs: NOW + 2 * TWELVE, createdAt: NOW, closedAt: null });
  const { cmc, seen } = await payingCmc(f, { gateRunId: "cmc-run" });
  await f.store.createOrder(order(f, { quoteAt: NOW + ACTIVE, createdAt: NOW + ACTIVE }));
  await at(NOW + ACTIVE + TWELVE - 1); await cmc.refresh(f.agent.id);
  assert.deepEqual([(await f.store.getRun("cmc-run"))?.cmcPayments, seen.challenges, (await f.store.orders(W)).filter(o => o.kind === "x402-sign").length], [0, 0, 0]);
  await at(NOW + ACTIVE + TWELVE); await cmc.refresh(f.agent.id);
  assert.deepEqual([(await f.store.getRun("cmc-run"))?.cmcPayments, seen.challenges], [1, 1]);
  await cmc.runtime.close();
});

test("PT3 gate tool (source scan): the cycle deps carry PORTFOLIO_ENABLED from the environment", () => {
  const source = readFileSync("scripts/agentic-gate.ts", "utf8").replaceAll("\r\n", "\n");
  assert.ok(source.includes('import { resolveHireEnabled, resolvePortfolioEnabled, resolveTradeConfig } from "../src/ops/config.js";'));
  assert.ok(source.includes("portfolioEnabled: resolvePortfolioEnabled(process.env), provider: {}, platformFeeBps: 0,"));
});

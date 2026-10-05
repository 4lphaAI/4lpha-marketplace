/** AGENTIC-PORTFOLIO: the Agentic lane for a portfolio hire (flag, slot-0 basket, partial sell then buy, quote refusals, rejected and unanswered orders, the hold, an exhausted run). */
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTIC_CLAIM_SQL } from "../src/agentic/store.js";
import { agenticDecimal } from "../src/agentic/domain.js";
import { runAgenticCycle } from "../src/agentic/worker.js";
import { executeAgenticTrade } from "../src/agentic/execute.js";
import { E, NOW, W } from "./support/agenticSchedule.js";
import { QQQB, SPYB } from "./support/agenticPortfolio.js";
import { SLOT, USDT, afterBasket, lane } from "./support/agenticPortfolioLane.js";

test("PL1 lane: with the portfolio switch off the cycle answers portfolio-disabled and sends no swap", async t => {
  const { f, tick, reason, swaps } = await lane(t, { enabled: false });
  await tick();
  assert.equal(await reason(), "portfolio-disabled");
  assert.equal(swaps.length, 0);
  assert.equal((await f.intents.listPortfolio(W, f.agent.id)).length, 0);
});

test("PL2 lane: slot 0 buys one stock per tick through the Agentic swap and commits, then the third tick completes the slot with no swap", async t => {
  const { f, tick, reason, swaps, at } = await lane(t);
  await tick();
  assert.deepEqual(swaps, [{ from: USDT, to: SPYB, qty: "25" }], JSON.stringify(await f.positions.listRuns(W, f.agent.id, 1)));
  await at(NOW + 60_000); await tick();
  assert.deepEqual(swaps.map(s => s.to), [SPYB, QQQB]);
  const ledger = await f.intents.listPortfolio(W, f.agent.id);
  assert.deepEqual(ledger.map(i => [i.portfolioSlot, i.side, i.state]), [[0, "buy", "projected"], [0, "buy", "projected"]]);
  assert.equal((await f.store.orders(W)).filter(o => o.outcome === "committed").length, 2);
  assert.equal((await f.positions.listOpen(W, f.agent.id)).length, 0, "a portfolio never opens a position");
  await at(NOW + 120_000); await tick();
  assert.equal(swaps.length, 2); assert.equal(await reason(), "portfolio-rebalanced");
  assert.equal((await f.intents.getPortfolioCheck(W, f.agent.id, 0))?.state, "done");
  assert.equal(swaps.some(s => s.from !== USDT), false);
});

test("PL3 lane: a later slot sends a partial sell at the planned amount, the fake chain shows exactly R out, the sale projects with verified proceeds, then the buy runs on the next tick", async t => {
  const { f, tick, swaps, balances, at, reason } = await afterBasket(t);
  await at(NOW + SLOT); await tick();
  // values [24, 25]: target 24.5 each (the 0.05 of idle USDT is outside the capital cap), so the QQQB excess is 0.5 USDT
  assert.deepEqual(swaps, [{ from: QQQB, to: USDT, qty: "0.5" }], JSON.stringify(await f.positions.listRuns(W, f.agent.id, 2)));
  assert.equal(balances.get(QQQB), 25n * E - E / 2n);
  const sell = (await f.store.orders(W)).find(o => o.side === "sell")!;
  assert.deepEqual({ intendedRaw: sell.intendedRaw, outcome: sell.outcome, fromQty: sell.fromQty }, { intendedRaw: (E / 2n).toString(), outcome: "committed", fromQty: "0.5" });
  const leg = (await f.intents.listPortfolio(W, f.agent.id)).find(i => i.side === "sell")!;
  assert.deepEqual({ state: leg.state, proceeds: leg.portfolioProceedsAtomic }, { state: "projected", proceeds: E / 2n });
  await at(NOW + SLOT + 60_000); await tick();
  assert.deepEqual(swaps.map(s => [s.from, s.to]), [[QQQB, USDT], [USDT, SPYB]], await reason());
  assert.ok(agenticDecimal(swaps[1]!.qty)! > 0n && agenticDecimal(swaps[1]!.qty)! <= E / 2n, swaps[1]!.qty);
});

test("PL4 lane: a buy refused at quote is released and re-quoted on the next tick without a swap; once Binance quotes again it buys", async t => {
  const { f, tick, quotes, swaps, plan, at } = await lane(t);
  plan.quote = { kind: "cli-error", code: 4242, name: "SERVICE_ERROR", orderId: null, sessionPresent: true };
  await tick();
  assert.deepEqual([quotes.length, swaps.length], [1, 0]);
  assert.equal((await f.store.orders(W)).at(-1)?.cliResult, "quote-refused:4242:SERVICE_ERROR");
  await at(NOW + 60_000); await tick();
  assert.deepEqual([quotes.length, swaps.length], [2, 0]);
  plan.quote = undefined;
  await at(NOW + 120_000); await tick();
  assert.deepEqual(swaps.map(s => s.to), [SPYB]);
});

test("PL5 lane: a sell refused at quote as a LEG error is terminal for the slot (proceeds 0, projected, token taken, no second quote); a state error is released and re-quoted", async t => {
  for (const [name, terminal] of [["INVALID_PARAMETER", true], ["INVALID_TOKEN", true], ["INSUFFICIENT_BALANCE", false]] as const) {
    const { f, tick, quotes, plan, at, swaps } = await afterBasket(t);
    plan.quote = { kind: "cli-error", code: 4242, name, orderId: null, sessionPresent: true };
    await at(NOW + SLOT); await tick();
    const sellQuotes = () => quotes.filter(q => q.from === QQQB).length;
    assert.deepEqual([sellQuotes(), swaps.length], [1, 0], name);
    const leg = (await f.intents.listPortfolio(W, f.agent.id)).find(i => i.side === "sell");
    // A released leg is rolled back (and so no longer listed); a terminal one is sealed with proceeds 0 and projected.
    if (terminal) assert.deepEqual({ state: leg?.state, proceeds: leg?.portfolioProceedsAtomic }, { state: "projected", proceeds: 0n }, name);
    else assert.equal(leg, undefined, name);
    await at(NOW + SLOT + 60_000); await tick();
    assert.equal(sellQuotes(), terminal ? 1 : 2, name);
  }
});

test("PL6 lane: a Binance-rejected order is terminal for its token in the slot; the other stock still trades and no order is re-dispatched", async t => {
  const { f, tick, swaps, swapsTo, plan, landed, at } = await lane(t);
  plan.swap = () => { landed.push({ orderId: "failed-1", status: "FAILED", txHash: null, from: USDT, to: SPYB, amountIn: 0n, amountOut: 0n });
    return { kind: "cli-error", code: 30003001, name: "ORDER_API_ERROR", orderId: "failed-1", sessionPresent: true }; };
  await tick();
  assert.equal(swapsTo(SPYB), 1);
  const order = (await f.store.orders(W))[0]!;
  assert.deepEqual({ outcome: order.outcome, response: order.response }, { outcome: "rolled-back", response: "rejected" });
  plan.swap = undefined;
  await at(NOW + 60_000); await tick();
  await at(NOW + 120_000); await tick();
  await at(NOW + 180_000); await tick();
  assert.deepEqual([swapsTo(SPYB), swapsTo(QQQB)], [1, 1], JSON.stringify(swaps));
});

test("PL7 lane: an unanswered order holds the wallet and later ticks dispatch nothing", async t => {
  const { f, tick, swaps, plan, at, reason } = await lane(t);
  plan.swap = () => ({ kind: "no-response", code: "timeout", sessionPresent: true });
  await tick();
  assert.equal(swaps.length, 1);
  assert.equal((await f.store.orders(W))[0]?.holdReason, "no-response");
  plan.swap = undefined;
  await at(NOW + 60_000); await tick();
  await at(NOW + 120_000); await tick();
  assert.equal(swaps.length, 1);
  assert.equal(await reason(), "portfolio-submission-unknown");
});

test("PL8 lane (hold): a paused agent's leg is quoted, refused at the claim and released, never dispatched; the claim SQL carries the pause clause", async t => {
  const { f, tick, swaps, quotes } = await lane(t);
  await f.killswitch.pauseAgent(f.agent.id, W);
  await tick();
  assert.deepEqual([quotes.length, swaps.length], [1, 0]);
  const order = (await f.store.orders(W))[0]!;
  assert.deepEqual({ cliResult: order.cliResult, outcome: order.outcome }, { cliResult: "AGENTIC_CLAIM_REFUSED", outcome: "rolled-back" });
  assert.equal((await f.intents.listPortfolio(W, f.agent.id)).length, 0, "the released leg is rolled back");
  assert.match(AGENTIC_CLAIM_SQL, /agent_pause/u);
});

test("PL9 gate run: after a sell run's only dispatch is used and the executor answered unknown, a second cycle on the same run commits and projects the sale and plans nothing", async t => {
  const { f, input, swaps, plan, landed, at, balances } = await afterBasket(t);
  await f.store.createRun({ runId: "run", gate: "G3", agentId: f.agent.id, wallet: W, side: "sell", maxDispatches: 1, dispatches: 0, maxNotionalUsdt: "2", maxCmcPayments: 0, cmcPayments: 0,
    cmcOperationIds: [], deadlineMs: NOW + 2 * SLOT, createdAt: NOW, closedAt: null });
  const execution = { ...f.execution, gateRunId: "run" };
  const gated = { ...input, execution, worker: { ...input.worker, executor: { execute: (request: Parameters<typeof executeAgenticTrade>[0]) => executeAgenticTrade({ ...request, deps: f.executorDeps }, execution) } } };
  // The order is accepted but not yet listed as finished: the executor's poll ends unknown.
  let visible = false;
  plan.listOverride = () => visible ? landed : landed.map(r => r.orderId === "listed-3" ? { ...r, status: "PENDING", txHash: null } : r);
  await at(NOW + SLOT);
  await runAgenticCycle(gated);
  assert.equal(swaps.length, 1);
  assert.equal((await f.store.orders(W)).find(o => o.side === "sell")?.outcome, "open");
  assert.equal((await f.store.getRun("run"))?.dispatches, 1);
  visible = true; await at(NOW + SLOT + 60_000);
  await runAgenticCycle(gated);
  assert.equal(swaps.length, 1, "the exhausted run plans nothing");
  assert.equal((await f.store.orders(W)).find(o => o.side === "sell")?.outcome, "committed");
  const leg = (await f.intents.listPortfolio(W, f.agent.id)).find(i => i.side === "sell")!;
  assert.deepEqual({ state: leg.state, proceeds: leg.portfolioProceedsAtomic }, { state: "projected", proceeds: E / 2n });
  assert.equal(balances.get(QQQB), 25n * E - E / 2n);
});

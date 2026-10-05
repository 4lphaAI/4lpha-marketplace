/** AGENTIC-DCA Revision 3 (R2.1 kept, minus the limit-order kind): the shared paid idle gate, the swap quote as the activity of a DCA hire, admission, the restored payment barrier and the free 12 h read. */
import assert from "node:assert/strict";
import test from "node:test";
import { AGENTIC_PAID_KEEPALIVE_IDLE_MS, agenticLastActivityMs, agenticUsesPaidIdleKeepAlive, type AgenticOrder } from "../src/agentic/domain.js";
import { acquireAgenticFence, agenticPayCheck } from "../src/agentic/obligations.js";
import { NOW, W } from "./support/agenticSchedule.js";
import { payingCmc } from "./support/agenticPortfolio.js";
import { MINUTE, dcaLane, dcaParams } from "./support/agenticDca.js";

const HOUR = 3_600_000, TWELVE = 12 * HOUR, ACTIVE = 7 * HOUR;

test("K1 the predicate admits a DCA hire; agenticLastActivityMs counts swap quotes and settled payments only (the limit-order kind is gone)", () => {
  assert.equal(agenticUsesPaidIdleKeepAlive(dcaParams()), true);
  const base = { acceptedAt: 1_000, agentId: "a", settledAttemptsCreatedAt: [] as number[] };
  const swap = (patch: Partial<AgenticOrder>): AgenticOrder => ({ idempotencyKey: "k" + JSON.stringify(patch), kind: "swap", walletAddress: W, agentId: "a", decisionId: null, side: "buy", fromToken: null, toToken: null,
    amountAtomic: null, intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null,
    operationId: null, walletNoncePre: null, quoteAt: null, dispatch: "sealed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null,
    returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "committed", holdReason: null, evidence: null, fillCheck: "none", createdAt: 1, updatedAt: 1, ...patch });
  assert.equal(agenticLastActivityMs({ ...base, orders: [swap({ quoteAt: 7_000 })] }, ["swap-quote", "x402-settled"]), 7_000);
  assert.equal(agenticLastActivityMs({ ...base, orders: [swap({ quoteAt: null })] }, ["swap-quote", "x402-settled"]), 1_000, "a swap whose quote never answered is not activity");
  assert.equal(agenticLastActivityMs({ ...base, orders: [swap({ quoteAt: 7_000, agentId: "b" })] }, ["swap-quote", "x402-settled"]), 1_000, "another agent");
  assert.equal(agenticLastActivityMs({ ...base, orders: [], settledAttemptsCreatedAt: [20_000] }, ["swap-quote", "x402-settled"]), 20_000);
});

test("K2 paid idle gate: a fire's swap quote resets the 12 h clock; the lane's own quote does not (it is a read, not a trade)", async t => {
  const w = await dcaLane(t), f = w.f, { cmc, seen } = await payingCmc(f);
  await w.at(NOW + ACTIVE); await w.tick(); // the base buy: its swap row carries quoteAt
  await w.advance(MINUTE); await w.tick();
  const quoteAt = Math.max(...(await f.store.orders(W)).filter(o => o.kind === "swap").map(o => o.quoteAt ?? 0));
  assert.equal(quoteAt, NOW + ACTIVE);
  await w.at(quoteAt + TWELVE - 1); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 0, "inside 12 h of the base quote nothing is paid");
  await w.at(quoteAt + TWELVE); await cmc.refresh(f.agent.id);
  assert.equal(seen.challenges, 1, "at exactly 12 h one paid call is made");
  await cmc.runtime.close();
  const g = await dcaLane(t), pay = await payingCmc(g.f);
  await g.at(NOW + ACTIVE); await g.tick(); await g.advance(MINUTE); await g.tick();
  await g.at(NOW + ACTIVE + 3 * HOUR);
  g.setPrice(692.5); await g.tick(); // a level fire 3 h later: the executor's quote resets the clock
  assert.equal((await g.f.store.orders(W)).filter(o => o.kind === "swap").length, 2);
  await g.at(NOW + ACTIVE + TWELVE); await pay.cmc.refresh(g.f.agent.id);
  assert.equal(pay.seen.challenges, 0, "12 h after the base but only 9 h after the fire: not due");
  await g.at(NOW + ACTIVE + 3 * HOUR + TWELVE); await pay.cmc.refresh(g.f.agent.id);
  assert.equal(pay.seen.challenges, 1);
  await pay.cmc.runtime.close();
});

test("K3 admission: a DCA hire pays only with hireSizing.cmcNewsEnabled true; the x402 hold stops the paid call", async t => {
  const on = await dcaLane(t), a = await payingCmc(on.f);
  await on.at(NOW + ACTIVE + TWELVE); await a.cmc.refresh(on.f.agent.id);
  assert.equal(a.seen.challenges, 1);
  assert.equal((await on.f.cmcStore.listAttempts(on.f.agent.id, W)).length, 1, "authorize admitted the DCA settings row: an attempt was reserved");
  await a.cmc.runtime.close();
  const hireFacts = (await dcaLane(t)).f.row.hireFacts!;
  const off = await dcaLane(t, { initial: { hireFacts: { ...hireFacts, hireSizing: { ...hireFacts.hireSizing, cmcNewsEnabled: false } } } }), b = await payingCmc(off.f);
  await off.at(NOW + ACTIVE + TWELVE); await b.cmc.refresh(off.f.agent.id);
  assert.equal(b.seen.challenges, 0);
  assert.equal((await off.f.cmcStore.listAttempts(off.f.agent.id, W)).length, 0);
  await b.cmc.runtime.close();
  const held = await dcaLane(t), c = await payingCmc(held.f);
  await held.f.store.patchWallet(await held.wallet(), { settingsHold: { code: "x402-limit", atMs: NOW } });
  await held.at(NOW + ACTIVE + TWELVE); await c.cmc.refresh(held.f.agent.id);
  assert.equal(c.seen.challenges, 0);
  await c.cmc.runtime.close();
});

test("K4 the payment barrier is the shared one again: an open swap or sign blocks a payment, a legacy limit row too; nothing open lets it through", async t => {
  const w = await dcaLane(t), f = w.f;
  const fence = (await acquireAgenticFence(f.store, W, f.instance.row.instanceId))!;
  const check = () => agenticPayCheck(f.store, f.instance, fence, f.agent.id, undefined, "unrelated");
  assert.equal(await check(), true, "nothing open");
  const row = (kind: AgenticOrder["kind"], patch: Partial<AgenticOrder> = {}): AgenticOrder => ({ idempotencyKey: `${kind}-${Object.keys(patch).join("")}`, kind, walletAddress: W, agentId: f.agent.id, decisionId: null,
    side: kind === "x402-sign" ? null : "buy", fromToken: null, toToken: null, amountAtomic: null, intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null,
    multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null, walletNoncePre: null, quoteAt: null, dispatch: "spawned", claimedAt: NOW, claimant: "x", fenceToken: "1",
    claimDeadline: null, response: "accepted", cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: null,
    evidence: null, fillCheck: "none", createdAt: NOW, updatedAt: NOW, ...patch });
  await f.store.createOrder(row("swap"));
  assert.equal(await check(), false, "an open swap blocks a payment");
  await f.store.releaseFence(fence);
  const g = await dcaLane(t), fence2 = (await acquireAgenticFence(g.f.store, W, g.f.instance.row.instanceId))!;
  await g.f.store.createOrder(row("x402-sign"));
  assert.equal(await agenticPayCheck(g.f.store, g.f.instance, fence2, g.f.agent.id, undefined, "unrelated"), false, "an open sign blocks a payment");
  await g.f.store.releaseFence(fence2);
  const h = await dcaLane(t), fence3 = (await acquireAgenticFence(h.f.store, W, h.f.instance.row.instanceId))!;
  await h.f.store.createOrder(row("limit-place"));
  assert.equal(await agenticPayCheck(h.f.store, h.f.instance, fence3, h.f.agent.id, undefined, "unrelated"), false, "a legacy open limit row counts like any open row (the barrier is restored)");
  await h.f.store.releaseFence(fence3);
});

test("K5 the free 12 h list: a DCA hire's read follows its quote clock", async t => {
  const w = await dcaLane(t);
  await w.tick();
  const quoteAt = NOW;
  const freeReads = () => w.market.calls.filter(c => c.join(" ") === ["market-order", "list", "--binanceChainId", "56", "--page", "1", "--pageSize", "1"].join(" ")).length;
  for (let at = quoteAt + 30 * MINUTE; at < quoteAt + TWELVE; at += 30 * MINUTE) { await w.at(at); await w.tick(); }
  assert.equal(freeReads(), 0);
  await w.at(quoteAt + TWELVE + 10 * MINUTE); await w.tick();
  assert.equal(freeReads(), 1);
  await w.advance(30 * MINUTE); await w.tick();
  assert.equal(freeReads(), 1, "the read advanced its own clock");
  assert.ok(AGENTIC_PAID_KEEPALIVE_IDLE_MS === TWELVE);
});

/** AGENTIC-DCA Revision 3 mutation-driven tests: the money gates are checked BEFORE the executor is called (the executor would answer the same hold code, so only a spy on it proves the lane gate), the 24 h cap boundary, recovery from a swap row, and the sell need rounding. */
import assert from "node:assert/strict";
import test from "node:test";
import { E, NOW, W } from "./support/agenticSchedule.js";
import { MINUTE, SPYB, USDT, armed, dcaLane, type DcaWorld } from "./support/agenticDca.js";
import { dcaSellNeedWei, dcaSellQuoteReaches } from "../src/agentic/dca.js";
import { dcaAhead } from "../src/trade/dca.js";
import type { AgenticOrder } from "../src/agentic/domain.js";
import type { TradeRequest } from "../src/http/wire.js";

async function run(w: DcaWorld, cycles: number): Promise<void> { for (let i = 0; i < cycles; i += 1) { await w.tick(); await w.advance(MINUTE); } }
/** record every request the lane hands the executor, and let the real one answer */
function spy(w: DcaWorld): TradeRequest[] {
  const requests: TradeRequest[] = [];
  const executor = w.input.worker.executor, real = executor.execute.bind(executor);
  executor.execute = async input => { requests.push(input.request); return real(input); };
  return requests;
}
const orderRow = (w: DcaWorld, over: Partial<AgenticOrder>): AgenticOrder => ({ idempotencyKey: "seed", kind: "swap", walletAddress: W, agentId: w.f.agent.id, decisionId: null, side: "buy", fromToken: USDT, toToken: SPYB,
  amountAtomic: (10n * E).toString(), intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null,
  operationId: null, walletNoncePre: null, quoteAt: NOW, dispatch: "spawned", claimedAt: NOW - 3_600_000, claimant: "x", fenceToken: "1", claimDeadline: null, response: "accepted", cliResult: "accepted",
  returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "committed", holdReason: null, evidence: null, fillCheck: "none", createdAt: NOW, updatedAt: NOW, ...over });

test("G1 the sell need rounds up and the quote check is exact at the boundary", () => {
  const target = { num: 7n, den: 2n }, q = 3n;
  assert.equal(dcaSellNeedWei(q, target), 11n, "ceil(21 / 2)");
  assert.deepEqual([dcaSellQuoteReaches(11n, q, target), dcaSellQuoteReaches(10n, q, target)], [true, false]);
});

test("G2 a take profit whose swap is lost stays ONE row: no second take profit is armed while it is placing or held", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(725);
  w.market.swap = "lost";
  await w.tick();
  await run(w, 3);
  const tps = (await w.orders()).filter(o => o.role === "tp");
  assert.equal(tps.length, 1);
  assert.notEqual(tps[0]!.state, "resting", "it is placing or held, never re-armed");
});

test("G3 the take profit is armed for min(H - sold, chain balance): stock the owner moved away is never in the order", async t => {
  const w = await dcaLane(t);
  await w.tick();
  const [round] = await w.rounds();
  const balance = w.state.balances.get(SPYB)!;
  assert.equal(balance, BigInt(round!.stockRaw));
  w.state.balances.set(SPYB, balance - 1_000n);
  await w.advance(MINUTE); await w.tick();
  const [tp] = await armed(w, "tp");
  assert.equal(tp!.qtyAtomic, (balance - 1_000n).toString());
});

test("G4 an open wallet obligation stops a fire BEFORE the fire CAS and the executor", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const requests = spy(w);
  await w.f.store.createOrder(orderRow(w, { idempotencyKey: "other-open", decisionId: "other:1", outcome: "open", dispatch: "spawned", claimedAt: w.now(), response: null, cliResult: null }));
  w.setPrice(692.5);
  const [l1] = await armed(w, "level", 1);
  await w.tick();
  assert.equal(await w.code(), "dca-waiting");
  assert.equal(requests.length, 0, "the lane never reached the executor");
  assert.equal((await armed(w, "level", 1))[0]!.rowVersion, l1!.rowVersion, "no fire CAS was written");
});

test("G5 the 24 h cap at a fire: used + D = 5 x capital fires, one wei more is refused before the executor, and a sell never counts", async t => {
  const fits = await dcaLane(t);
  await run(fits, 2);
  // the base 25 is already used; 140 + 25 + 10 = 175 = 5 x 35
  await fits.f.store.createOrder(orderRow(fits, { idempotencyKey: "old-buy", amountAtomic: (140n * E).toString() }));
  await fits.f.store.createOrder(orderRow(fits, { idempotencyKey: "old-sell", side: "sell", fromToken: SPYB, toToken: USDT, amountAtomic: (100n * E).toString() }));
  fits.setPrice(692.5);
  await fits.tick();
  assert.equal((await armed(fits, "level", 1))[0]!.state, "filled", "exactly at the cap fires; the sell row does not count");
  const over = await dcaLane(t);
  await run(over, 2);
  const requests = spy(over);
  await over.f.store.createOrder(orderRow(over, { idempotencyKey: "old-buy", amountAtomic: (140n * E + 1n).toString() }));
  over.setPrice(692.5);
  await over.tick();
  assert.equal(await over.code(), "dca-cap-exhausted");
  assert.equal(requests.length, 0);
  assert.equal((await armed(over, "level", 1))[0]!.state, "resting");
});

test("G6 the quota and USDT gates of a level fire and of the base stop BEFORE the executor", async t => {
  const level = await dcaLane(t);
  await run(level, 2);
  const levelRequests = spy(level);
  level.setPrice(692.5);
  level.market.settingsOverride = { dailyLimit: 100_000, quotaUsed: 99_995 };
  await level.tick();
  assert.equal(await level.code(), "dca-quota-low");
  assert.equal(levelRequests.length, 0);
  const base = await dcaLane(t);
  const baseRequests = spy(base);
  base.market.settingsOverride = { dailyLimit: 100_000, quotaUsed: 99_995 };
  await base.tick();
  assert.equal(await base.code(), "dca-quota-low");
  assert.equal(baseRequests.length, 0);
  const cash = await dcaLane(t);
  const cashRequests = spy(cash);
  const exposure = await cash.input.cmc.protectedExposure(cash.f.agent.id), a = BigInt(dcaAhead(cash.settings.dcaMaxOrders!));
  cash.state.balances.set(USDT, 25n * E + a * 10n * E + exposure - 1n);
  await cash.tick();
  assert.equal(await cash.code(), "dca-cash-low", "the base needs the base plus the a armed levels");
  assert.equal(cashRequests.length, 0);
  cash.state.balances.set(USDT, 25n * E + a * 10n * E + exposure);
  await cash.advance(MINUTE); await cash.tick();
  assert.equal(await cash.code(), "dca-base-bought");
});

test("G7 a trigger price also bounds the base's minOut: a mid just under the trigger whose quote is too weak waits", async t => {
  const w = await dcaLane(t, { settings: { dcaTriggerPriceE8: "69000000000" }, price: 700 });
  await run(w, 1);
  w.setPrice(689);
  await w.tick();
  assert.equal(await w.code(), "dca-trigger-not-reached");
  assert.equal(w.market.swapCalls().length, 0);
});

test("G8 an unreadable pool reading starts no base; a paused agent reports paused even with the flag off", async t => {
  const w = await dcaLane(t);
  w.failures.pool = true;
  const requests = spy(w);
  await w.tick();
  assert.equal(await w.code(), "cost-unavailable");
  assert.equal(requests.length, 0);
  const off = await dcaLane(t, { flag: false });
  await off.f.killswitch.pauseAgent(off.f.agent.id, W);
  await off.tick();
  assert.equal(await off.code(), "paused");
});

test("G9 recovery counts only a Binance rejection; a rolled-back swap of another cause re-arms the row uncounted", async t => {
  for (const [code, streak] of [["binance-rejected", 1], ["quote-below-min-out", 0]] as const) {
    const w = await dcaLane(t);
    await run(w, 2);
    const [l1] = await armed(w, "level", 1);
    await w.f.store.createOrder(orderRow(w, { idempotencyKey: `rb-${code}`, decisionId: `dca:${w.f.agent.id}:1:level1:1`, outcome: "rolled-back", evidence: { code } as never }));
    await w.f.store.patchDcaOrder(l1!, { state: "placing", placeOrderKey: `rb-${code}` });
    await w.tick();
    assert.equal((await armed(w, "level", 1))[0]!.state, "resting", code);
    assert.equal((await w.rounds())[0]!.failStreak, streak, code);
  }
});

test("G10 reconciliation alone: a rolled-back fire in a protective round is cancelled by the plane, never re-armed", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const [l1] = await armed(w, "level", 1);
  await w.f.store.createOrder(orderRow(w, { idempotencyKey: "rb-stop", decisionId: `dca:${w.f.agent.id}:1:level1:1`, outcome: "rolled-back" }));
  await w.f.store.patchDcaOrder(l1!, { state: "placing", placeOrderKey: "rb-stop" });
  const [round] = await w.rounds();
  await w.f.store.patchDcaRound(round!, { phase: "stopping" });
  const { runAgenticDcaStep } = await import("../src/agentic/dcaLane.js");
  const lane = { ...w.input, dcaEnabled: true } as unknown as Parameters<typeof runAgenticDcaStep>[0];
  await runAgenticDcaStep(lane, await w.wallet(), { reconciliationOnly: true });
  const [after] = await armed(w, "level", 1);
  assert.deepEqual([after!.state, after!.closedBy], ["cancelled", "plane"]);
});

test("G11 a legacy limit-order row is never resolved as a swap: only the gate tool's rollback moves it", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const [l1] = await armed(w, "level", 1);
  await w.f.store.createOrder(orderRow(w, { idempotencyKey: "legacy-limit", kind: "limit-place" as never, outcome: "rolled-back" }));
  await w.f.store.patchDcaOrder(l1!, { state: "placing", placeOrderKey: "legacy-limit" });
  await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "placing");
});

test("G12 a take-profit fill recovered from its swap row closes the round and settles it (no level keeps buying)", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const executor = w.input.worker.executor, real = executor.execute.bind(executor);
  executor.execute = async input => { await real(input); return { kind: "unknown" } as never; };
  w.setPrice(725);
  await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "active", "the unknown answer books nothing in the firing cycle");
  executor.execute = real;
  await w.advance(MINUTE); await w.tick();
  const [round] = await w.rounds();
  assert.equal(round!.phase, "settled");
  assert.equal(round!.closeCause, "take-profit");
});

test("G13 the premium guard holds the base before the executor (a dear pool, a stale fact)", async t => {
  const dear = await dcaLane(t);
  const requests = spy(dear);
  const plane = dear.input.worker.dataPlane as unknown as { universe: (lane: string) => Promise<{ rwa: { referencePriceUsd: number } }[]> };
  const universe = plane.universe;
  plane.universe = async lane => (await universe(lane)).map(r => ({ ...r, rwa: { ...r.rwa, referencePriceUsd: r.rwa.referencePriceUsd * 0.8 } }));
  await dear.tick();
  assert.equal(await dear.code(), "dca-waiting");
  assert.equal(requests.length, 0);
  plane.universe = universe;
  await dear.advance(MINUTE); await dear.tick();
  assert.equal(await dear.code(), "dca-base-bought");
});

/** a take-profit fire whose swap committed on chain but whose booking has not happened (the executor answered unknown) */
async function tpUnbooked(w: DcaWorld): Promise<void> {
  const executor = w.input.worker.executor, real = executor.execute.bind(executor);
  executor.execute = async input => { await real(input); return { kind: "unknown" } as never; };
  w.setPrice(725);
  await w.tick();
  executor.execute = real;
}
const sellSwap = async (w: DcaWorld) => (await w.f.store.orders(W)).filter(o => o.kind === "swap" && o.side === "sell").at(-1)!;

test("G14 the take-profit breach is exactly output < minOut: at minOut no latch, one wei under latches (LOW-2)", async t => {
  for (const [delta, latched] of [[0n, false], [1n, true]] as const) {
    const w = await dcaLane(t);
    await run(w, 2);
    await tpUnbooked(w);
    const swap = await sellSwap(w), output = BigInt(w.market.landed.at(-1)!.amountOut);
    await w.f.store.patchOrder(swap, { minOutAtomic: (output + delta).toString() });
    await w.advance(MINUTE); await w.tick();
    assert.equal((await w.wallet()).entriesStopped !== null, latched, `delta ${delta}`);
    assert.equal((await w.rounds())[0]!.phase, "settled");
  }
});

test("G15 a closing round with a held order stays closing and does not settle (R21.1, LOW-2)", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const [l1] = await armed(w, "level", 1), [round] = await w.rounds();
  await w.f.store.createOrder(orderRow(w, { idempotencyKey: "held-swap", decisionId: `dca:${w.f.agent.id}:1:level1:1`, outcome: "open", holdReason: "no-response" }));
  await w.f.store.patchDcaOrder(l1!, { state: "held", placeOrderKey: "held-swap", holdReason: "no-response" });
  await w.f.store.patchDcaRound(round!, { phase: "closing" });
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "closing");
  assert.equal(await w.code(), "dca-order-held");
});

test("G16 a committed take-profit swap whose receipt is not readable yet blocks the stop-loss end until the fill is booked (LOW-3)", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await tpUnbooked(w);
  const hash = w.market.landed.at(-1)!.txHash!, receipt = w.market.world.receipts.get(hash)!;
  w.market.world.receipts.delete(hash);
  const [round] = await w.rounds();
  await w.f.store.patchDcaRound(round!, { phase: "stopping" });
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "stopping", "the round does not end without the fill");
  assert.equal(await w.code(), "dca-stopping");
  w.market.world.receipts.set(hash, receipt);
  await w.advance(MINUTE); await w.tick();
  const [after] = await w.rounds();
  assert.equal(after!.phase, "stopped");
  assert.ok(BigInt(after!.soldStockRaw) > 0n, "the sale is in the stopped round's ledger");
});

test("G17 an owner end books a fill whose swap committed before the sign-out, then records the round interrupted (LOW-3)", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await tpUnbooked(w);
  await w.f.store.patchWallet(await w.wallet(), { state: "ended", sessionCiphertext: null, endReason: "owner-signed-out" });
  await w.advance(MINUTE); await w.tick();
  const [round] = await w.rounds();
  assert.equal(round!.phase, "interrupted");
  assert.ok(BigInt(round!.soldStockRaw) > 0n, "the committed sale is booked before the round is recorded");
});

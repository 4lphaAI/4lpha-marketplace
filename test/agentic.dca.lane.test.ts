/** AGENTIC-DCA Revision 3 (R3.3 to R3.7): arming, detection, the lane quote, the fire and its outcomes, booking, the take profit and the holds, over a fake Binance that knows no limit order. */
import assert from "node:assert/strict";
import test from "node:test";
import { E, NOW, W } from "./support/agenticSchedule.js";
import { MINUTE, SPYB, USDT, armed, dcaLane, type DcaWorld } from "./support/agenticDca.js";
import { dcaBuyNeedRaw, dcaMinOut, dcaPriceE8, dcaSellNeedWei, dcaTargetReached, dcaLevelReached, dcaBuyQuoteReaches, dcaSellQuoteReaches } from "../src/agentic/dca.js";
import { dcaTpTarget } from "../src/trade/dca.js";
import type { ExecuteTradeResult } from "../src/trade/execute.js";
import type { TradeRequest } from "../src/http/wire.js";

const swapRows = async (w: DcaWorld) => (await w.f.store.orders(W)).filter(o => o.kind === "swap").sort((a, b) => a.createdAt - b.createdAt);
const states = async (w: DcaWorld) => (await w.orders()).map(o => `${o.role}${o.levelNo ?? ""}:${o.state}`);
async function run(w: DcaWorld, cycles: number): Promise<void> { for (let i = 0; i < cycles; i += 1) { await w.tick(); await w.advance(MINUTE); } }
/** record every request the lane hands the executor */
function spy(w: DcaWorld): TradeRequest[] {
  const requests: TradeRequest[] = [];
  const executor = w.input.worker.executor, real = executor.execute.bind(executor);
  executor.execute = async input => { requests.push(input.request); return real(input); };
  return requests;
}
function stub(w: DcaWorld, result: ExecuteTradeResult): void { w.input.worker.executor.execute = async () => result; }

test("L0 the detection and quote comparisons are exact at the boundary", () => {
  const level = { num: 693n, den: 1n }, target = { num: 710_500n, den: 1_000n };
  assert.deepEqual([dcaLevelReached({ num: 693n, den: 1n }, level), dcaLevelReached({ num: 693_000_001n, den: 1_000_000n }, level), dcaLevelReached({ num: 692_999_999n, den: 1_000_000n }, level)], [true, false, true]);
  assert.deepEqual([dcaTargetReached({ num: 710_500n, den: 1_000n }, target), dcaTargetReached({ num: 710_499_999n, den: 1_000_000n }, target), dcaTargetReached({ num: 710_500_001n, den: 1_000_000n }, target)], [true, false, true]);
  const need = dcaBuyNeedRaw(10n * E, level);
  assert.deepEqual([dcaBuyQuoteReaches(need, 10n * E, level), dcaBuyQuoteReaches(need - 1n, 10n * E, level)], [true, false]);
  const q = 35_714_285_714_285_714n, sellNeed = dcaSellNeedWei(q, target);
  assert.deepEqual([dcaSellQuoteReaches(sellNeed, q, target), dcaSellQuoteReaches(sellNeed - 1n, q, target)], [true, false]);
});

test("L1 round flow: the base buys at market, then the take profit and one level are ARMED (nothing rests at Binance)", async t => {
  const w = await dcaLane(t);
  await w.tick();
  assert.equal(await w.code(), "dca-base-bought");
  await w.advance(MINUTE); await w.tick();
  assert.equal(await w.code(), "dca-watching");
  const [round] = await w.rounds();
  assert.deepEqual([round!.phase, round!.p0UsdtWei, round!.costUsdtWei], ["active", (25n * E).toString(), (25n * E).toString()]);
  const [tp] = await armed(w, "tp"), [l1] = await armed(w, "level", 1);
  assert.deepEqual([tp!.state, l1!.state, tp!.side, l1!.side], ["resting", "resting", "sell", "buy"]);
  const stock = BigInt(round!.stockRaw);
  assert.equal(stock, 25n * E * 100_000_000n / 70_000_000_000n);
  assert.equal(BigInt(tp!.qtyAtomic), stock);
  assert.equal(dcaPriceE8({ num: BigInt(tp!.priceNum), den: BigInt(tp!.priceDen) }), dcaPriceE8(dcaTpTarget({ costUsdtWei: 25n * E, stockWei: stock, takeProfitBps: 150 })));
  assert.equal(dcaPriceE8({ num: BigInt(l1!.priceNum), den: BigInt(l1!.priceDen) }) / 1_000n, 69_300_000n, "L1 = 693");
  assert.equal(l1!.qtyAtomic, (10n * E).toString());
  assert.deepEqual([tp!.triggerSent, tp!.qtySent, tp!.strategyId, tp!.placeOrderKey, tp!.slippagePct], ["", "", null, null, "0.5"]);
  assert.equal(w.market.calls.filter(c => c[0] === "limit-order").length, 0, "no limit-order command exists");
  assert.equal(w.market.swapCalls().length, 1, "only the base swap so far");
});

test("L2 a flag-off lane starts no round and answers dca-agentic-off, never dca-disabled", async t => {
  const w = await dcaLane(t, { flag: false });
  await w.tick();
  assert.equal(await w.code(), "dca-agentic-off");
  assert.equal((await w.rounds()).length, 0);
  assert.equal(w.market.swapCalls().length, 0);
});

test("L3 a = 1 level armed for N <= 3 and 2 for N >= 4", async t => {
  for (const [n, a] of [[1, 1], [3, 1], [4, 2], [8, 2]] as const) {
    const w = await dcaLane(t, { settings: { dcaMaxOrders: n } });
    await run(w, 2);
    assert.equal((await armed(w, "level")).filter(o => o.state === "resting").length, a, `N=${n}`);
    assert.equal((await armed(w, "tp")).filter(o => o.state === "resting").length, 1, `N=${n}`);
  }
});

test("L4 a level the mid has already passed is skipped at arming, never bought; a level below the range minimum is below-range", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await w.tick();
  w.setPrice(690); // below L1 = 693, above L2 = 684.6
  await w.advance(MINUTE); await w.tick();
  assert.deepEqual(await states(w), ["level1:skipped", "level2:resting", "tp:resting"]);
  assert.equal(w.market.swapCalls().length, 1, "the skipped level was not bought");
  const gap = await dcaLane(t, { settings: { dcaMaxOrders: 4 } });
  await gap.tick();
  gap.setPrice(660); // below every level (L4 = 662.424)
  await gap.advance(MINUTE); await gap.tick();
  assert.deepEqual((await gap.orders()).filter(o => o.role === "level").map(o => o.state), ["skipped", "skipped", "skipped", "skipped"]);
  assert.equal(gap.market.swapCalls().length, 1);
  const range = await dcaLane(t, { settings: { dcaMaxOrders: 3, dcaRangeMinE8: "69500000000", dcaRangeMaxE8: "80000000000" } });
  await run(range, 2);
  assert.deepEqual((await range.orders()).filter(o => o.role === "level").map(o => o.state), ["below-range", "below-range", "below-range"]);
  assert.deepEqual((await armed(range, "tp")).map(o => o.state), ["resting"], "the take profit is still armed");
});

test("L5 no level is armed after the entry cutoff or with entries stopped; armed levels are disarmed and the take profit stays; flag off arms nothing new", async t => {
  const cutoff = NOW + 7 * 86_400_000 - 7_200_000;
  const a = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await a.tick();
  await a.at(cutoff - 5_000); await a.tick();
  assert.deepEqual(await states(a), ["tp:resting"], "inside the 5 s margin of the cutoff only the take profit is armed");
  const b = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(b, 2);
  assert.deepEqual(await states(b), ["level1:resting", "tp:resting"]);
  await b.f.store.patchWallet(await b.wallet(), { entriesStopped: { reason: "fill-below-minimum", out: "1", min: "2", atMs: b.now() } });
  await b.tick();
  assert.deepEqual(await states(b), ["level1:cancelled", "tp:resting"], "entries stopped: the armed level is disarmed, the take profit stays");
  assert.equal((await armed(b, "level"))[0]!.closedBy, "plane");
  const c = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await c.tick(); await c.advance(MINUTE);
  await (await import("../src/agentic/worker.js")).runAgenticCycle({ ...c.input, dcaEnabled: false });
  assert.deepEqual(await states(c), ["tp:resting"], "flag off: no level is armed");
});

test("L6 the armed take profit is re-priced (T, Q) after a booked level fill, by one CAS and no Binance call beyond the fire", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  const [tp0] = await armed(w, "tp");
  w.setPrice(692.5);
  await w.tick(); // L1 fires and books
  assert.equal((await armed(w, "level", 1))[0]!.state, "filled");
  await w.advance(MINUTE); await w.tick();
  const [round] = await w.rounds(), [tp] = await armed(w, "tp");
  assert.equal(tp!.orderKey, tp0!.orderKey, "the same row is re-priced, not replaced");
  const target = dcaTpTarget({ costUsdtWei: BigInt(round!.costUsdtWei), stockWei: BigInt(round!.stockRaw), takeProfitBps: 150 });
  assert.equal(BigInt(tp!.priceNum) * target.den, target.num * BigInt(tp!.priceDen));
  assert.equal(BigInt(tp!.qtyAtomic), BigInt(round!.stockRaw));
  assert.equal(tp!.rowVersion > tp0!.rowVersion, true);
  assert.equal((await armed(w, "level", 2))[0]!.state, "resting", "the fill armed the next level");
});

test("L7 detection: mid <= L fires and mid > L does not; the TP fires at mid >= T; the executor is called once with the exact request", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  const requests = spy(w);
  w.setPrice(693.5); await w.tick();
  assert.equal(requests.length, 0, "693.5 is above L1 = 693");
  assert.equal(w.market.swapCalls().length, 1);
  w.setPrice(692.5); await w.advance(MINUTE); await w.tick();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.deepEqual([request!.decisionId, request!.venue, request!.side, request!.token, request!.amountWei, request!.settlementAsset, request!.platformFeeAtomic, request!.route],
    [`dca:${w.f.agent.id}:1:level1:1`, "pancake_v3", "buy", SPYB, 10n * E, "USDT", 0n, { hops: [], fees: [100] }]);
  assert.equal(request!.minOutWei, dcaMinOut(request!.quotedOutWei, 50), "minOut = floor(quote x 9 950 / 10 000)");
  assert.ok(request!.quotedOutWei >= dcaBuyNeedRaw(10n * E, { num: 693n, den: 1n }), "the quote reached the level itself");
  assert.equal(w.market.swapCalls().length, 2);
  w.setPrice(705); await w.advance(MINUTE); await w.tick();
  assert.equal(requests.length, 1, "705 is below the take-profit target of the larger position (about 708.45)");
  w.setPrice(725); await w.advance(MINUTE); await w.tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.side, "sell");
  assert.equal(requests[1]!.decisionId, `dca:${w.f.agent.id}:1:tp:1`);
});

test("L8 a short quote writes no row and gives dca-quote-short; the trigger stays armed and fires once the quote reaches the level", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(692.5);
  w.market.quoteEdgeBps = -150; // the Binance quote is 1.5 % worse than the pool mid
  const before = (await swapRows(w)).length, version = (await armed(w, "level", 1))[0]!.rowVersion;
  await w.tick();
  assert.equal(await w.code(), "dca-quote-short");
  assert.equal((await swapRows(w)).length, before, "no swap row");
  assert.equal((await armed(w, "level", 1))[0]!.rowVersion, version, "the armed row is untouched");
  assert.equal(w.market.swapCalls().length, 1);
  w.market.quoteEdgeBps = 0;
  await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "filled");
});

test("L8b the take profit is held to its own quote: a sell quote below ceil(Q x T) writes no row (dca-quote-short) and the take profit fires once the quote reaches it (the one-wei boundary is G1 and L0)", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(725);
  w.market.quoteEdgeBps = -300; // a sell quote 3 % under the pool mid is below T (about 708.5) although the mid is above it
  const before = (await swapRows(w)).length, version = (await armed(w, "tp"))[0]!.rowVersion;
  await w.tick();
  assert.equal(await w.code(), "dca-quote-short");
  assert.equal((await swapRows(w)).length, before, "no swap row");
  assert.equal((await armed(w, "tp"))[0]!.rowVersion, version, "the armed take profit is untouched");
  assert.equal(w.market.swapCalls().length, 1);
  w.market.quoteEdgeBps = 0;
  await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "tp"))[0]!.state, "filled");
});

test("L9 a gap across armed levels fires each in ladder order (at most a), the first non-commit stops the second, and L3 and L4 arm next cycle", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 4 } });
  await run(w, 2);
  assert.deepEqual((await armed(w, "level")).map(o => `${o.levelNo}:${o.state}`), ["1:resting", "2:resting"]);
  const requests = spy(w);
  w.setPrice(680); // below L1 = 693 and L2 = 684.6, above L3 = 674.52
  await w.tick();
  assert.deepEqual(requests.map(r => r.decisionId), [`dca:${w.f.agent.id}:1:level1:1`, `dca:${w.f.agent.id}:1:level2:1`]);
  assert.deepEqual((await armed(w, "level")).map(o => `${o.levelNo}:${o.state}`), ["1:filled", "2:filled"]);
  await w.advance(MINUTE); await w.tick();
  assert.deepEqual((await armed(w, "level")).map(o => `${o.levelNo}:${o.state}`), ["1:filled", "2:filled", "3:resting", "4:resting"], "680 is above both, so they arm");
  const gap = await dcaLane(t, { settings: { dcaMaxOrders: 4 } });
  await run(gap, 2);
  const second = spy(gap);
  gap.market.swap = "reject";
  gap.setPrice(680); await gap.tick();
  assert.equal(second.length, 1, "the first fire did not commit: the cycle stops");
  assert.deepEqual((await armed(gap, "level")).map(o => `${o.levelNo}:${o.state}`), ["1:resting", "2:resting"]);
});

test("L10 committed: the order is filled and the round ledger moves in one booking, from the swap's own receipt", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  const [before] = await w.rounds();
  w.setPrice(692.5); await w.tick();
  const [l1] = await armed(w, "level", 1), [round] = await w.rounds(), swaps = await swapRows(w);
  const swap = swaps.at(-1)!;
  assert.deepEqual([l1!.state, l1!.closedBy, l1!.executor, l1!.txHash, l1!.placeOrderKey], ["filled", "binance", "wallet", swap.txHash, swap.idempotencyKey]);
  assert.equal(l1!.fillUsdtWei, (10n * E).toString());
  const landed = w.market.landed.at(-1)!;
  assert.equal(l1!.fillStockRaw, landed.amountOut.toString());
  assert.equal(BigInt(round!.costUsdtWei), BigInt(before!.costUsdtWei) + 10n * E);
  assert.equal(BigInt(round!.stockRaw), BigInt(before!.stockRaw) + landed.amountOut);
  assert.equal(await w.code(), "dca-level-filled");
  assert.equal(swap.fillCheck, "ok");
});

test("L11 every seal re-arms the row with no streak: a re-quote below minOut seals AGENTIC_QUOTE_BELOW_MIN", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(692.5);
  w.market.quoteEdges.push(0, -60); // the lane quote reaches the level; the executor's own re-quote is 0.6 % lower
  await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "resting");
  const [round] = await w.rounds();
  assert.deepEqual([round!.failStreak, round!.backoffUntilMs], [0, null]);
  const swap = (await swapRows(w)).at(-1)!;
  assert.deepEqual([swap.outcome, swap.cliResult, swap.dispatch], ["rolled-back", "AGENTIC_QUOTE_BELOW_MIN", "sealed"]);
  assert.equal(w.market.swapCalls().length, 1, "no swap was sent");
  await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "filled", "the next cycle fires again with a new decision id");
  assert.equal((await swapRows(w)).at(-1)!.decisionId, `dca:${w.f.agent.id}:1:level1:2`);
});

test("L12 binance-rejected re-arms the row and counts; three in a row back off 600 000 ms (dca-retry-backoff), then it fires again", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(692.5);
  w.market.swap = "reject";
  await w.tick();
  const streak = async () => (await w.rounds())[0]!;
  assert.deepEqual([(await armed(w, "level", 1))[0]!.state, (await streak()).failStreak, (await streak()).backoffUntilMs], ["resting", 1, null]);
  await w.advance(MINUTE); await w.tick();
  assert.deepEqual([(await streak()).failStreak, (await streak()).backoffUntilMs], [2, null]);
  await w.advance(MINUTE); await w.tick();
  const third = await streak();
  assert.deepEqual([third.failStreak, third.backoffUntilMs !== null && third.backoffUntilMs >= w.now() + 590_000], [0, true], "the third refusal starts the back-off");
  const swaps = w.market.swapCalls().length;
  w.market.swap = "ok";
  await w.advance(MINUTE); await w.tick();
  assert.equal(await w.code(), "dca-retry-backoff");
  assert.equal(w.market.swapCalls().length, swaps, "nothing fires during the back-off");
  await w.advance(10 * MINUTE); await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "filled");
});

test("L13 each denied code maps to its run code and re-arms the row; a replay conflict is dca-waiting", async t => {
  for (const [code, expected] of [["AGENTIC_LOW_BNB", "dca-low-bnb"], ["AGENTIC_LOW_USDT", "dca-cash-low"], ["AGENTIC_DAILY_QUOTA", "dca-quota-low"], ["AGENTIC_SETTINGS_HOLD", "dca-settings-hold"], ["conflict", "dca-waiting"]] as const) {
    const w = await dcaLane(t);
    await run(w, 2);
    w.setPrice(692.5);
    stub(w, { kind: "denied", status: 409, code });
    await w.tick();
    assert.equal(await w.code(), expected, code);
    assert.equal((await armed(w, "level", 1))[0]!.state, "resting", code);
    assert.equal((await w.rounds())[0]!.failStreak, 0, "a denial never counts");
  }
});

test("L14 unknown keeps the row placing and nothing fires; the resolver's hold makes it held; a held swap blocks every fire", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  w.setPrice(692.5);
  w.market.swap = "lost";
  await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "placing");
  const swaps = w.market.swapCalls().length;
  w.setPrice(680); // a deeper level could fire; nothing fires while a swap is unresolved
  await w.advance(MINUTE); await w.tick();
  await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "level", 1))[0]!.state, "held");
  assert.equal(await w.code(), "dca-order-held");
  assert.equal(w.market.swapCalls().length, swaps, "no second swap");
  const swap = (await swapRows(w)).at(-1)!;
  assert.deepEqual([swap.outcome, swap.holdReason], ["open", "no-response"]);
});

test("L15 a TP sale below its own minOut latches entries stopped (dca-fill-above-level); afterwards no new round and no level", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  w.setPrice(725); w.market.fillEdgeBps = -80; // the fill is 0.8 % below the quote: below minOut
  await w.tick();
  const wallet = await w.wallet();
  assert.equal(wallet.entriesStopped?.reason, "dca-fill-above-level");
  const sell = (await swapRows(w)).at(-1)!;
  assert.equal(wallet.entriesStopped?.min, sell.minOutAtomic);
  assert.ok(BigInt(wallet.entriesStopped!.out) < BigInt(wallet.entriesStopped!.min));
  assert.equal((await w.rounds())[0]!.phase, "settled", "closing settled in the same cycle");
  w.market.fillEdgeBps = 0;
  await w.advance(2 * MINUTE); await w.tick();
  assert.equal((await w.rounds()).length, 1, "no new round after the latch");
  assert.equal(w.market.swapCalls().length, 2);
});

test("L16 a breached level buy stops entries (fill-below-minimum); the take profit still fires", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  w.setPrice(692.5); w.market.fillEdgeBps = -80;
  await w.tick();
  assert.equal((await w.wallet()).entriesStopped?.reason, "fill-below-minimum");
  assert.equal((await armed(w, "level", 1))[0]!.state, "filled");
  w.market.fillEdgeBps = 0;
  await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "level", 2)).length, 0, "no level is armed once entries are stopped");
  w.setPrice(725); await w.advance(MINUTE); await w.tick();
  assert.equal((await armed(w, "tp"))[0]!.state, "filled", "the take profit still fires");
});

test("L17 closing settles in the same cycle as the booked TP; the cooldown is 60 s; the next round's base buys after it", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.setPrice(725); await w.tick();
  const [r1] = await w.rounds();
  assert.deepEqual([r1!.phase, r1!.closeCause], ["settled", "take-profit"]);
  assert.equal(await w.code(), "dca-round-closed");
  assert.ok(BigInt(r1!.realizedPnlWei!) > 0n);
  await w.advance(30_000); await w.tick();
  assert.equal(await w.code(), "dca-cooldown");
  assert.equal((await w.rounds()).length, 1);
  await w.advance(30_000); await w.tick();
  assert.equal((await w.rounds()).length, 2, "60 s after the TP fill round 2 starts");
  assert.equal((await w.rounds())[1]!.phase, "active");
  assert.equal(w.market.swapCalls().length, 3);
});

test("L18 BNB floors: the level fire needs 0.0008, the TP fire 0.0004 (hold dca-low-bnb at one wei below, never a streak); round start (N + 2) x R", async t => {
  const level = await dcaLane(t);
  await run(level, 2);
  level.setPrice(692.5);
  level.f.balances.native = 800_000_000_000_000n - 1n;
  await level.tick();
  assert.equal(await level.code(), "dca-low-bnb");
  assert.equal((await armed(level, "level", 1))[0]!.state, "resting");
  level.f.balances.native = 800_000_000_000_000n;
  await level.advance(MINUTE); await level.tick();
  assert.equal((await armed(level, "level", 1))[0]!.state, "filled");
  const tp = await dcaLane(t);
  await run(tp, 2);
  tp.setPrice(725);
  tp.f.balances.native = 400_000_000_000_000n - 1n;
  await tp.tick();
  assert.equal(await tp.code(), "dca-low-bnb");
  assert.equal((await tp.rounds())[0]!.failStreak, 0);
  tp.f.balances.native = 400_000_000_000_000n;
  await tp.advance(MINUTE); await tp.tick();
  assert.equal((await armed(tp, "tp"))[0]!.state, "filled", "0.0004 is enough for the sale (the executor's own sell floor is 0.0001)");
  const start = await dcaLane(t);
  start.f.balances.native = 1_200_000_000_000_000n - 1n;
  await start.tick();
  assert.equal(await start.code(), "dca-low-bnb");
  start.f.balances.native = 1_200_000_000_000_000n;
  await start.advance(MINUTE); await start.tick();
  assert.equal((await start.rounds()).length, 1);
  assert.equal(start.market.swapCalls().length, 1, "N = 1: 0.0012 starts the round");
});

test("L19 USDT and quota gates before the quote, and the premium guard holds a stale or dear level without skipping it (D14)", async t => {
  const cash = await dcaLane(t);
  await run(cash, 2);
  cash.setPrice(692.5);
  const exposure = await cash.input.cmc.protectedExposure(cash.f.agent.id);
  cash.state.balances.set(USDT, 10n * E + exposure - 1n);
  const quotes = cash.market.quoteCalls().length;
  await cash.tick();
  assert.equal(await cash.code(), "dca-cash-low");
  assert.equal(cash.market.quoteCalls().length, quotes, "no quote before the gate");
  cash.state.balances.set(USDT, 10n * E + exposure);
  await cash.advance(MINUTE); await cash.tick();
  assert.equal((await armed(cash, "level", 1))[0]!.state, "filled");
  const quota = await dcaLane(t);
  await run(quota, 2);
  quota.setPrice(692.5);
  quota.market.settingsOverride = { dailyLimit: 100_000, quotaUsed: 99_995 };
  await quota.tick();
  assert.equal(await quota.code(), "dca-quota-low");
  assert.equal((await armed(quota, "level", 1))[0]!.state, "resting");
  const stale = await dcaLane(t);
  await run(stale, 2);
  stale.setPrice(692.5);
  const plane = stale.input.worker.dataPlane as unknown as { universe: (lane: string) => Promise<unknown[]> };
  const universe = plane.universe;
  plane.universe = async () => [];
  await stale.tick();
  assert.equal(await stale.code(), "cost-unavailable");
  assert.equal((await armed(stale, "level", 1))[0]!.state, "resting");
  plane.universe = universe;
  await stale.advance(MINUTE); await stale.tick();
  assert.equal((await armed(stale, "level", 1))[0]!.state, "filled");
  assert.equal((await armed(stale, "level", 1)).length, 1, "one row, never skipped");
  const dear = await dcaLane(t);
  await run(dear, 2);
  dear.setPrice(692.5);
  const dearPlane = dear.input.worker.dataPlane as unknown as { universe: (lane: string) => Promise<{ rwa: { referencePriceUsd: number } }[]> };
  const dearUniverse = dearPlane.universe;
  dearPlane.universe = async lane => (await dearUniverse(lane)).map(r => ({ ...r, rwa: { ...r.rwa, referencePriceUsd: r.rwa.referencePriceUsd * 0.8 } }));
  await dear.tick();
  assert.equal(await dear.code(), "dca-waiting");
  assert.equal((await armed(dear, "level", 1))[0]!.state, "resting");
});

test("L20 the 24 h cap counts the spawned buy swaps of the last 24 h: 5 x capital", async t => {
  const w = await dcaLane(t);
  await w.f.store.createOrder({ idempotencyKey: "old-a", kind: "swap", walletAddress: W, agentId: w.f.agent.id, decisionId: null, side: "buy", fromToken: USDT, toToken: SPYB, amountAtomic: (151n * E).toString(),
    intendedRaw: null, fromQty: null, minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null,
    walletNoncePre: null, quoteAt: NOW, dispatch: "spawned", claimedAt: NOW - 3_600_000, claimant: "x", fenceToken: "1", claimDeadline: null, response: "accepted", cliResult: "accepted",
    returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "committed", holdReason: null, evidence: null, fillCheck: "none", createdAt: NOW, updatedAt: NOW });
  await w.tick(); // capital 35 -> cap 175: 151 + 25 = 176
  assert.equal(await w.code(), "dca-cap-exhausted");
  assert.equal(w.market.swapCalls().length, 0);
});

test("L21 holds: paused and a settings hold stop a fire; flag off stops the levels but the take profit still fires", async t => {
  const paused = await dcaLane(t);
  await run(paused, 2);
  paused.setPrice(692.5);
  await paused.f.killswitch.pauseAgent(paused.f.agent.id, W);
  await paused.tick();
  assert.equal(await paused.code(), "paused");
  assert.equal((await armed(paused, "level", 1))[0]!.state, "resting");
  const settings = await dcaLane(t);
  await run(settings, 2);
  settings.setPrice(725);
  await settings.f.store.patchWallet(await settings.wallet(), { settingsHold: { code: "daily-limit", atMs: settings.now() } });
  await settings.tick();
  assert.equal(await settings.code(), "dca-settings-hold");
  assert.equal(settings.market.swapCalls().length, 1, "the executor refuses every swap under a settings hold, the take profit included (D11 a)");
  const off = await dcaLane(t);
  await run(off, 2);
  const offInput = { ...off.input, dcaEnabled: false };
  const { runAgenticCycle } = await import("../src/agentic/worker.js");
  off.setPrice(692.5); await runAgenticCycle(offInput);
  assert.equal((await armed(off, "level", 1))[0]!.state, "resting", "flag off: no level fires");
  off.setPrice(725); await off.advance(MINUTE); await runAgenticCycle(offInput);
  assert.equal((await armed(off, "tp"))[0]!.state, "filled", "flag off: the take profit still fires");
});

test("L22 R17.1 the base is held to s = min(50, maxSlippageBps): minOut = floor(quote x 9 950 / 10 000), 9 970 with a cap of 30, and a re-quote 0.6 % lower seals the base", async t => {
  const a = await dcaLane(t);
  const requests = spy(a);
  await a.tick();
  assert.equal(requests[0]!.minOutWei, dcaMinOut(requests[0]!.quotedOutWei, 50));
  const b = await dcaLane(t, { settings: { slippageBps: 50 } });
  const bRequests = spy(b);
  await b.tick();
  assert.equal(bRequests[0]!.minOutWei, dcaMinOut(bRequests[0]!.quotedOutWei, 50), "signed 50 bps: the same value");
  const c = await dcaLane(t, { maxSlippageBps: 30 });
  const cRequests = spy(c);
  await c.tick();
  assert.equal(cRequests[0]!.minOutWei, cRequests[0]!.quotedOutWei * 9_970n / 10_000n, "maxSlippageBps 30: 9 970");
  const d = await dcaLane(t);
  d.market.quoteEdges.push(0, -60);
  await d.tick();
  const [round] = await d.rounds();
  assert.equal(round!.phase, "starting", "the base was refused: the round stays starting");
  assert.equal((await swapRows(d)).at(-1)!.cliResult, "AGENTIC_QUOTE_BELOW_MIN");
  await d.advance(MINUTE); await d.tick();
  assert.equal((await d.rounds())[0]!.phase, "active", "and retries next cycle with a new attempt");
  assert.equal((await swapRows(d)).at(-1)!.decisionId, `dca:${d.f.agent.id}:1:base:2`);
});

test("L23 a trigger price holds round 1 (dca-trigger-not-reached) until the pool mid is at or below it, then the base buys", async t => {
  const w = await dcaLane(t, { settings: { dcaTriggerPriceE8: "69000000000" }, price: 700 });
  await run(w, 2);
  assert.equal(await w.code(), "dca-trigger-not-reached");
  assert.equal(w.market.swapCalls().length, 0);
  w.setPrice(680);
  await run(w, 1);
  assert.equal(await w.code(), "dca-base-bought");
  assert.equal(w.market.swapCalls().length, 1);
});

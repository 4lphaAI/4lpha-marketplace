/** AGENTIC-DCA Revision 3 (R3.6): stop loss, wind-down and term end, the owner end and the writer of `interrupted`. Nothing is sold at an end, nothing waits at Binance, and an end waits only for a swap in flight. */
import assert from "node:assert/strict";
import test from "node:test";
import { E, NOW, W } from "./support/agenticSchedule.js";
import { MINUTE, SPYB, USDT, armed, dcaLane, type DcaWorld } from "./support/agenticDca.js";
import type { AgenticOrder } from "../src/agentic/domain.js";

const HIRE_END = NOW + 7 * 86_400_000;
const swaps = (w: DcaWorld) => w.market.swapCalls().length;
async function run(w: DcaWorld, cycles: number): Promise<void> { for (let i = 0; i < cycles; i += 1) { await w.tick(); await w.advance(MINUTE); } }
/** the base buys, then the price drops BELOW every level before they are armed (they are skipped, never bought): only the stop-loss readings move */
async function baseThenDrop(w: DcaWorld, price: number): Promise<void> { await w.tick(); await w.advance(MINUTE); w.setPrice(price); }
const states = async (w: DcaWorld) => (await w.orders()).map(o => `${o.role}${o.levelNo ?? ""}:${o.state}`);
/** a fire in flight: the level 1 row is `placing` and its swap row is open with no hold (accepted, not listed yet) */
async function inFlight(w: DcaWorld): Promise<AgenticOrder> {
  const [l1] = await armed(w, "level", 1);
  const key = "seeded-swap-row";
  const swap: AgenticOrder = { idempotencyKey: key, kind: "swap", walletAddress: W, agentId: w.f.agent.id, decisionId: `dca:${w.f.agent.id}:1:level1:1`, side: "buy", fromToken: USDT, toToken: SPYB,
    amountAtomic: (10n * E).toString(), intendedRaw: null, fromQty: "10", minOutAtomic: "1", binanceQuoteOutAtomic: "1", slippagePct: "0.5", multiplierPre: "1", multiplierUsed: null,
    listSnapshot: { takenAtMs: w.now(), startTimeMs: w.now() - 86_400_000, ids: ["listed-1"] }, operationId: null, walletNoncePre: null, quoteAt: w.now(), dispatch: "spawned",
    claimedAt: w.now(), claimant: "x", fenceToken: "1", claimDeadline: null, response: "accepted", cliResult: "accepted", returnedOrderId: "returned-x", listedOrderId: null, txHash: null,
    approveTxHash: null, outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: w.now(), updatedAt: w.now() };
  assert.equal(await w.f.store.createOrder(swap), true);
  await w.f.store.patchDcaOrder(l1!, { state: "placing", placeOrderKey: key });
  return swap;
}

test("S1 stop loss: two breaching readings at distinct blocks 60 s apart confirm; every trigger is disarmed; stopped and the agent leaves in the SAME cycle; nothing is sold", async t => {
  const w = await dcaLane(t, { settings: { dcaStopLossBps: 100 } });
  await baseThenDrop(w, 690); // equity 35 + 0.0357 x 690 - 25 = 34.64 <= 34.65; L1 = 693 is skipped
  await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "active", "one reading does not confirm");
  assert.equal((await w.rounds())[0]!.stopCounter?.count, 1);
  await w.advance(MINUTE); await w.tick();
  const [round] = await w.rounds();
  assert.deepEqual([round!.phase, round!.closeCause], ["stopped", "stop-loss"]);
  assert.ok(round!.markedPnlWei !== null);
  assert.equal(await w.code(), "dca-stopped");
  const wallet = await w.wallet();
  assert.deepEqual([wallet.state, wallet.endReason, wallet.endStage], ["ended", "stop-loss", "logged-out-verified"]);
  assert.equal(w.market.count("auth signout"), 1);
  assert.equal(swaps(w), 1, "no swap after the base: nothing is sold");
  assert.deepEqual(await states(w), ["level1:skipped", "tp:cancelled"]);
  assert.equal(w.market.calls.filter(c => c[0] === "limit-order").length, 0, "no cancel call: nothing rests at Binance");
});

test("S2 a recovered reading resets the counter; readings closer than 60 s do not confirm", async t => {
  const w = await dcaLane(t, { settings: { dcaStopLossBps: 100 } });
  await baseThenDrop(w, 690);
  await w.tick();
  assert.equal((await w.rounds())[0]!.stopCounter?.count, 1);
  await w.at(w.now() + 30_000); await w.tick();
  assert.equal((await w.rounds())[0]!.stopCounter?.count, 1, "30 s later is too soon to count");
  w.setPrice(700);
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.stopCounter, null, "a non-breaching reading resets");
  w.setPrice(690);
  await w.advance(MINUTE); await w.tick();
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "stopped");
});

test("S3 the numbers: capital 55, 15 %: a base-only round stops at -33 % (46.75 exactly), not one tick above", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3, dcaStopLossBps: 1500 } });
  await baseThenDrop(w, 470);
  for (let i = 0; i < 3; i += 1) { await w.tick(); await w.advance(MINUTE); }
  assert.equal((await w.rounds())[0]!.phase, "active", "470 gives equity 46.7857 above the 46.75 line");
  w.setPrice(469);
  await w.tick(); await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "stopped", "469 gives exactly 46.75");
});

test("S4 a swap in flight blocks the protective end until it resolves; a held swap does not (R3.2)", async t => {
  const w = await dcaLane(t, { settings: { dcaStopLossBps: 100 } });
  await run(w, 2);
  const swap = await inFlight(w);
  w.setPrice(690);
  await w.tick(); await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "stopping");
  assert.equal(await w.code(), "dca-stopping");
  assert.equal((await w.wallet()).state, "bound", "the agent stays connected while a swap is in flight");
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "stopping", "an open, unheld swap still blocks");
  // the swap is rolled back: the row is cancelled (the round is no longer active) and the round ends in the same cycle
  const current = (await w.f.store.getOrder(swap.idempotencyKey))!;
  await w.f.store.patchOrder(current, { outcome: "rolled-back" });
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "stopped");
  assert.equal((await armed(w, "level", 1))[0]!.state, "cancelled");
  // a held swap does not block
  const h = await dcaLane(t, { settings: { dcaStopLossBps: 100 } });
  await run(h, 2);
  const held = await inFlight(h);
  await h.f.store.patchOrder((await h.f.store.getOrder(held.idempotencyKey))!, { holdReason: "no-response" });
  h.setPrice(690);
  await h.tick(); await h.advance(MINUTE); await h.tick();
  assert.equal((await h.rounds())[0]!.phase, "stopped", "a held swap is a residual, not a wait");
});

test("S5 wind-down at hire_end - 30 min disarms every trigger and ends the round at once (dca-orders-cancelled); at hire_end the agent goes ending and leaves; holdings are kept", async t => {
  const w = await dcaLane(t, { settings: { dcaMaxOrders: 3 } });
  await run(w, 2);
  await w.at(HIRE_END - 1_800_000 - 1); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "active");
  await w.at(HIRE_END - 1_800_000); await w.tick();
  const [round] = await w.rounds();
  assert.deepEqual([round!.phase, round!.closeCause], ["ended", "term-end"]);
  assert.equal(await w.code(), "dca-orders-cancelled");
  assert.deepEqual(await states(w), ["level1:cancelled", "tp:cancelled"]);
  assert.equal((await w.wallet()).state, "bound");
  assert.equal(swaps(w), 1, "nothing is sold");
  await w.at(HIRE_END + 1); await w.tick();
  const wallet = await w.wallet();
  assert.deepEqual([wallet.state, wallet.endReason, wallet.endStage], ["ended", "term-ended", "logged-out-verified"]);
  assert.equal(swaps(w), 1);
  assert.equal(w.market.calls.filter(c => c[0] === "limit-order").length, 0);
});

test("S6 resumeAgenticEnding for a DCA hire is the AI form: it waits for an open unheld swap row until hire_end + 30 min, then signs out", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await w.at(HIRE_END - 60_000);
  // an open, unheld swap row of the wallet (a minute old: the resolver has not held it)
  await w.f.store.createOrder({ idempotencyKey: "other-open-row", kind: "swap", walletAddress: W, agentId: w.f.agent.id, decisionId: "other:1", side: "buy", fromToken: USDT, toToken: SPYB,
    amountAtomic: (10n * E).toString(), intendedRaw: null, fromQty: "10", minOutAtomic: "1", binanceQuoteOutAtomic: "1", slippagePct: "0.5", multiplierPre: "1", multiplierUsed: null,
    listSnapshot: { takenAtMs: w.now(), startTimeMs: w.now() - 86_400_000, ids: ["listed-1"] }, operationId: null, walletNoncePre: null, quoteAt: w.now(), dispatch: "spawned",
    claimedAt: w.now(), claimant: "x", fenceToken: "1", claimDeadline: null, response: "accepted", cliResult: "accepted", returnedOrderId: "returned-x", listedOrderId: null, txHash: null,
    approveTxHash: null, outcome: "open", holdReason: null, evidence: null, fillCheck: "none", createdAt: w.now(), updatedAt: w.now() });
  await w.at(HIRE_END - 1_800_000); await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "ended", "the DCA round has nothing in flight: it ended at the wind-down");
  await w.at(HIRE_END + 1); await w.tick();
  assert.equal((await w.wallet()).state, "ending");
  await w.at(HIRE_END + 1_700_000); await w.tick();
  assert.equal(w.market.count("auth signout"), 0, "before hire_end + 30 min the open row is waited for");
  await w.at(HIRE_END + 1_800_001); await w.tick();
  assert.equal((await w.wallet()).state, "ended");
  assert.equal(w.market.count("auth signout"), 1);
});

test("S7 entry cutoff and wind-down boundaries: no new round from the cutoff (5 s margin), everything disarmed from the wind-down start", async t => {
  const cutoff = HIRE_END - 7_200_000;
  const a = await dcaLane(t);
  await a.at(cutoff - 5_001); await a.tick();
  assert.equal(swaps(a), 1, "5001 ms before the cutoff a round still starts");
  const b = await dcaLane(t);
  await b.at(cutoff - 5_000); await b.tick();
  assert.equal(swaps(b), 0, "inside the 5 s margin nothing starts");
});

test("S8 an owner sign-out (two U probes) ends the agent; the open round becomes interrupted (owner-end) with its marked PnL; no Binance call for the ended row", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  w.market.sessionDead = true;
  await w.advance(5 * MINUTE); await w.tick();
  assert.equal((await w.wallet()).state, "bound", "one U is not enough");
  await w.advance(2 * MINUTE); await w.tick();
  assert.equal((await w.wallet()).state, "ended");
  assert.equal((await w.wallet()).endReason, "owner-signed-out");
  await w.advance(MINUTE);
  const calls = w.market.calls.length;
  await w.tick();
  const [round] = await w.rounds();
  assert.deepEqual([round!.phase, round!.closeCause], ["interrupted", "owner-end"]);
  assert.ok(round!.markedPnlWei !== null && BigInt(round!.markedPnlWei) > -(10n ** 15n) && BigInt(round!.markedPnlWei) < 10n ** 15n, "marked PnL = proceeds + (H - sold) x mid - C is about 0 at the base price: " + round!.markedPnlWei);
  assert.equal(w.market.calls.length, calls, "the ended row is written with no Binance call");
  const version = round!.rowVersion;
  await w.advance(MINUTE); await w.tick();
  assert.equal((await w.rounds())[0]!.rowVersion, version, "an interrupted round is terminal");
});

test("S9 the writer of interrupted writes a null marked PnL when no finalized mid is readable", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await w.f.store.patchWallet(await w.wallet(), { state: "ended", sessionCiphertext: null, endReason: "owner-signed-out" });
  w.failures.pool = true;
  await w.tick();
  const [round] = await w.rounds();
  assert.deepEqual([round!.phase, round!.markedPnlWei], ["interrupted", null]);
});

test("S10 the stored end reason survives both logout sites; a plain term end writes term-ended", async t => {
  const w = await dcaLane(t, { settings: { dcaStopLossBps: 100 } });
  await run(w, 2);
  await w.f.store.leaveBound(await w.wallet(), "stop-loss");
  await w.at(NOW + 91 * 86_400_000); await w.tick();
  const wallet = await w.wallet();
  assert.deepEqual([wallet.state, wallet.endStage, wallet.endReason], ["ended", "logged-out-by-max-time", "stop-loss"]);
  const plain = await dcaLane(t);
  await run(plain, 2);
  await plain.f.store.leaveBound(await plain.wallet(), "term-ended");
  await plain.at(NOW + 91 * 86_400_000); await plain.tick();
  assert.equal((await plain.wallet()).endReason, "term-ended");
});

test("S11 an ended DCA row with nothing left to do never takes the wallet fence again", async t => {
  const w = await dcaLane(t);
  await run(w, 2);
  await w.f.store.patchWallet(await w.wallet(), { state: "ended", sessionCiphertext: null, endReason: "owner-signed-out" });
  await w.tick();
  assert.equal((await w.rounds())[0]!.phase, "interrupted");
  const fences = t.mock.method(w.f.store, "acquireFence");
  for (let i = 0; i < 3; i += 1) { await w.advance(MINUTE); await w.tick(); }
  assert.equal(fences.mock.calls.length, 0, "no fence for an ended row with a terminal round");
});

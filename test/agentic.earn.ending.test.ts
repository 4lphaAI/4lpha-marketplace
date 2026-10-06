/** AGENTIC-EARN-SPEC ET9: the term-end redeem-all and the sign-out guard of rule 29: no sign-out with parked funds, an open earn row or a failed chain read; sign-out once nothing is parked; the maximum time still ends;
 *  a DCA stop loss redeems before it signs out; an owner sign-out makes no Binance call. */
import assert from "node:assert/strict";
import test from "node:test";
import { E, DAY, HOUR, MINUTE, NOW, W, earnWorld, type EarnWorld } from "./support/agenticEarn.js";
import { resumeAgenticEnding } from "../src/agentic/worker.js";
import { earnBlocksSignOut } from "../src/agentic/earnLane.js";

const END = NOW + 7 * DAY;
async function ending(w: EarnWorld) {
  const left = await w.f.store.leaveBound(await w.wallet(), "term-ended");
  assert.equal(left?.state, "ending");
  return await w.wallet();
}
const signouts = (w: EarnWorld): number => w.market.count("auth signout");

test("E1 from end - 2 h the lane redeems everything, one product per cycle, then the sign-out follows once nothing is parked", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  await w.tick();
  w.state.venus = 20n * E; w.state.aave = 10n * E; w.state.usdt = 70n * E;
  await w.at(END - 2 * HOUR - 1); await w.tick();
  assert.equal(w.market.count("defi redeem"), 0, "end - 2 h - 1 ms: nothing yet");
  await w.at(END - 2 * HOUR); await w.tick();
  assert.equal(w.market.count("defi redeem"), 1, "one product per cycle");
  await w.advance(MINUTE); await w.tick();
  assert.deepEqual([w.state.venus, w.state.aave], [0n, 0n]);
  assert.equal(w.market.count("defi redeem"), 2);
  assert.ok((await w.rows()).filter(r => r.kind === "earn-redeem").every(r => r.fromQty === "ratio:1" && r.outcome === "committed"));
  assert.equal(signouts(w), 0, "still bound: no sign-out before the end");
  await w.at(END); await w.tick();
  assert.equal((await w.wallet()).state, "ending");
  await w.advance(MINUTE); await w.tick();
  assert.equal(signouts(w), 1, "nothing parked and no row: the guarded sign-out goes");
});

test("E2 the sign-out waits while a product holds dust or more, while an earn row is open (held too), and while the chain read fails or is absent", async t => {
  const w = await earnWorld(t, { lane: "schedule", flag: false });
  await w.tick();
  const row = await ending(w);
  const deps = { store: w.f.store, chain: w.f.chain };
  w.state.venus = E / 100n;
  assert.equal(await earnBlocksSignOut(deps, row), true, "0.01 USDT is dust or more");
  w.state.venus = E / 100n - 1n;
  assert.equal(await earnBlocksSignOut(deps, row), false, "0.0099 USDT is below dust");
  w.failures.balances = true;
  assert.equal(await earnBlocksSignOut(deps, row), true, "a failed read holds");
  assert.equal(await earnBlocksSignOut({ store: w.f.store }, row), true, "an absent chain holds");
  w.failures.balances = false;
  await w.f.store.createOrder({ idempotencyKey: "earn:z:1", kind: "earn-redeem", walletAddress: W, agentId: row.agentId!, decisionId: null, side: null, fromToken: null, toToken: null,
    amountAtomic: "1", intendedRaw: null, fromQty: "1", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null,
    walletNoncePre: "0", quoteAt: null, dispatch: "spawned", claimedAt: NOW, claimant: "x", fenceToken: "1", claimDeadline: null, response: "no-response", cliResult: "timeout", returnedOrderId: null,
    listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: "no-response", evidence: null, fillCheck: "none", createdAt: NOW, updatedAt: NOW });
  assert.equal(await earnBlocksSignOut(deps, row), true, "a held open row blocks");
});

test("E3 resumeAgenticEnding: parked funds block the sign-out; the maximum sign-in time still ends the hire (the wait is bounded); a non-earn hire signs out as before", async t => {
  const w = await earnWorld(t, { lane: "schedule", flag: false });
  await w.tick();
  w.state.venus = 30n * E;
  const row = await ending(w);
  await w.at(END + 31 * MINUTE);
  await resumeAgenticEnding(w.f.lifecycle, row);
  assert.equal(signouts(w), 0, "funds are parked");
  const after = await w.wallet();
  assert.equal(after.state, "ending");
  await w.at(NOW + 90 * DAY);
  await resumeAgenticEnding(w.f.lifecycle, after);
  assert.deepEqual([(await w.wallet()).state, (await w.wallet()).endStage], ["ended", "logged-out-by-max-time"]);
  const free = await earnWorld(t, { lane: "schedule", earn: false });
  await free.tick();
  const plain = await ending(free);
  await free.at(END + 31 * MINUTE);
  await resumeAgenticEnding(free.f.lifecycle, plain);
  assert.equal(signouts(free), 1);
});

test("E4 a redeem runs in ending, on a revoked agent and under a settings hold; a pause stops it and the sign-out then waits", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  await w.tick();
  w.state.venus = 30n * E; w.state.usdt = 70n * E;
  await w.f.store.patchWallet(await w.wallet(), { settingsHold: { code: "daily-limit", atMs: NOW } });
  await w.f.killswitch.pauseAgent(w.f.agent.id, W);
  await ending(w);
  await w.advance(MINUTE); await w.tick();
  assert.equal(w.market.count("defi redeem"), 0, "paused: plain pause");
  assert.ok((await w.codes()).includes("earn-redeem-blocked"));
  assert.equal(signouts(w), 0, "funds stay parked and the sign-out waits");
  await w.f.killswitch.unpauseAgent(w.f.agent.id, W);
  await w.advance(MINUTE); await w.tick();
  assert.equal(w.market.count("defi redeem"), 1, "ending, a revoked agent and a settings hold: the redeem runs");
  assert.equal((await w.f.agents.getAgentById(w.f.agent.id))!.status, "revoked");
});

test("E5 a DCA stop loss ends the agent: redeem-all, then the sign-out", async t => {
  const w = await earnWorld(t, { lane: "dca" });
  await w.step();
  const parked = w.state.venus;
  assert.ok(parked > 0n, "the lane parked part of the idle USDT first");
  await w.f.store.leaveBound(await w.wallet(), "stop-loss");
  await w.advance(MINUTE); await w.tick();
  assert.equal(w.state.venus, 0n);
  assert.equal(signouts(w), 1, "redeem-all and then the guarded sign-out in one cycle");
  assert.equal((await w.wallet()).endReason, "stop-loss");
});

test("E6 an owner sign-out (ended) makes no Binance call: open rows resolve by receipt or delta from chain reads only", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.deposit = "land-lost";
  await w.step();
  const callsBefore = w.market.calls.length;
  await w.f.store.leaveBound(await w.wallet(), "owner-signed-out");
  assert.equal((await w.wallet()).state, "ended");
  await w.at(NOW + 121_000); await w.step();
  assert.equal(w.market.calls.length, callsBefore, "no Binance command after the owner signed out");
  assert.equal((await w.rows())[0]!.outcome, "committed", "the landed deposit committed by the balance delta (chain only)");
  await w.advance(MINUTE); await w.step();
  assert.equal(w.market.calls.length, callsBefore, "an ended row with no open earn row never takes the fence again");
});

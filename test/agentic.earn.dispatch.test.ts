/** AGENTIC-EARN-SPEC ET7, R11.1, R11.9: the dispatch discipline: one durable row before anything is sent, the claim, the five-second rule, accepted and receipt, client-side names, every other answer held, no second dispatch,
 *  the server-refusal rollback (rule 26a), and the orphan rows. */
import assert from "node:assert/strict";
import test from "node:test";
import { E, HOUR, MINUTE, W, earnWorld, tx, type EarnWorld } from "./support/agenticEarn.js";
import { EARN_SERVER_REFUSALS } from "../src/agentic/earnAdapter.js";
import { resolveAgenticOrder } from "../src/agentic/resolve.js";

const earn = (w: EarnWorld) => w.rows();

test("D1 the first cycle of a daily Schedule hire deposits 60 USDT: row before spawn, claim, accepted, receipt, committed", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  await w.step();
  const [row] = await earn(w);
  assert.equal(row!.kind, "earn-deposit");
  assert.deepEqual([row!.outcome, row!.dispatch, row!.response, row!.txHash], ["committed", "spawned", "accepted", tx(1)]);
  assert.equal(row!.amountAtomic, (60n * E).toString());
  assert.equal(row!.fromQty, "60");
  assert.equal(w.state.venus, 60n * E, "the higher APY (Venus 3.02 % over Aave 2.50 %) takes the whole deposit");
  assert.equal(w.market.count("defi deposit"), 1);
  assert.equal(w.market.count("defi preview"), 1);
  assert.deepEqual(await w.codes(), ["earn-sent", "earn-deposited"]);
  const ev = row!.evidence as { reason: string; apyBps: Record<string, number>; pre: { usdt: string } };
  assert.deepEqual([ev.reason, ev.apyBps, ev.pre.usdt], ["lane", { venus: 302, "aave-v3": 250 }, (100n * E).toString()]);
});

test("D2 the claim is refused (a pause the step did not see): sealed and rolled back, nothing spawned, and the next swap claim is admitted", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  const original = w.f.store.claimEarnOrder.bind(w.f.store);
  w.f.store.claimEarnOrder = async () => null;
  await w.step();
  const [row] = await earn(w);
  assert.deepEqual([row!.dispatch, row!.outcome], ["sealed", "rolled-back"]);
  assert.equal(w.market.count("defi deposit"), 0, "no spawn");
  assert.equal(await w.f.store.walletObligations(W), false);
  w.f.store.claimEarnOrder = original;
});

test("D3 a claim-to-spawn time of five seconds or more seals the row and spawns nothing", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  const original = w.f.store.claimEarnOrder.bind(w.f.store), realHr = process.hrtime.bigint;
  w.f.store.claimEarnOrder = async (row, fence) => { const claimed = await original(row, fence); t.mock.method(process.hrtime, "bigint", () => realHr() + 6_000_000_000n); return claimed; };
  await w.step();
  const [row] = await earn(w);
  assert.deepEqual([row!.dispatch, row!.outcome, row!.cliResult], ["sealed", "rolled-back", "spawn-late"]);
  assert.equal(w.market.count("defi deposit"), 0);
});

test("D4 a client-side name (INVALID_AMOUNT) rolls back at once; every other answer is held and never dispatched twice", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.deposit = "client-error";
  await w.step();
  assert.deepEqual((await earn(w)).map(r => [r.response, r.outcome]), [["rejected", "rolled-back"]]);
  for (const mode of ["lost", "no-hash", "service-error", "refuse"] as const) {
    const world = await earnWorld(t, { lane: "schedule" });
    world.market.deposit = mode;
    await world.step();
    const [row] = await earn(world);
    assert.deepEqual([row!.outcome, row!.response, row!.holdReason], ["open", "no-response", "no-response"], mode);
    await world.advance(MINUTE); await world.step(); await world.advance(MINUTE); await world.step();
    assert.equal(world.market.count("defi deposit"), 1, `${mode}: never a second dispatch`);
    assert.equal((await earn(world)).length, 1, mode);
  }
});

test("D5 R11.1 / rule 26a: each of the eight server names is held at 119 999 ms, held at 120 000 ms with the nonce moved, rolled back at 120 000 ms with the nonce unmoved", async t => {
  for (const name of EARN_SERVER_REFUSALS) {
    const w = await earnWorld(t, { lane: "schedule" });
    w.market.deposit = "refuse";
    const fake = w.market.run.bind(w.market);
    w.market.run = async args => { const r = await fake(args); return r.kind === "cli-error" && r.name === "INSUFFICIENT_BALANCE" ? { ...r, name } : r; };
    await w.step();
    const [held] = await earn(w), claimed = held!.claimedAt!;
    assert.equal(held!.cliResult, `cli-error:351766:${name}`);
    await w.at(claimed + 119_999); await w.step();
    assert.equal((await earn(w))[0]!.outcome, "open", `${name} at 119 999`);
    w.state.nonce += 1n;
    await w.at(claimed + 120_000); await w.step();
    assert.equal((await earn(w))[0]!.outcome, "open", `${name} nonce moved`);
    w.state.nonce = 0n;
    await w.step();
    const [done] = await earn(w);
    assert.deepEqual([done!.outcome, done!.response, done!.holdReason, (done!.evidence as { disposition: string }).disposition], ["rolled-back", "rejected", null, "server-refused"], name);
    assert.ok((await w.codes()).includes("earn-refused"));
    assert.equal(await w.f.store.walletObligations(W), false, "the wallet's next swap claim is admitted");
  }
});

test("D6 SERVICE_ERROR, timeout, unparseable and ok-without-txHash stay held for ten finalization windows", async t => {
  for (const mode of ["service-error", "lost", "no-hash"] as const) {
    const w = await earnWorld(t, { lane: "schedule" });
    w.market.deposit = mode;
    await w.step();
    const claimed = (await earn(w))[0]!.claimedAt!;
    await w.at(claimed + 10 * 120_000); await w.step();
    assert.deepEqual([(await earn(w))[0]!.outcome, (await earn(w))[0]!.holdReason], ["open", "no-response"], mode);
  }
});

test("D7 a rolled-back deposit blocks a new deposit for 24 h (its dispatch is spawned); a rolled-back redeem retries after 600 s", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.deposit = "client-error";
  await w.step();
  w.market.deposit = "ok";
  await w.advance(23 * HOUR); await w.step();
  assert.equal(w.market.count("defi deposit"), 1, "blocked for 24 h");
  await w.advance(HOUR + MINUTE); await w.step();
  assert.equal(w.market.count("defi deposit"), 2, "after 24 h the next deposit goes");
  const r = await earnWorld(t, { lane: "schedule" });
  await r.step();
  r.state.usdt = 10n * E;
  r.market.redeem = "client-error";
  await r.advance(MINUTE); await r.step();
  assert.equal(r.market.count("defi redeem"), 1);
  await r.advance(5 * MINUTE); await r.step();
  assert.equal(r.market.count("defi redeem"), 1, "back-off");
  assert.ok((await r.codes()).includes("earn-redeem-blocked"));
  r.market.redeem = "ok";
  await r.advance(5 * MINUTE + 1); await r.step();
  assert.equal(r.market.count("defi redeem"), 2, "retried after 600 s with fresh sizing");
  assert.equal(r.state.usdt, 30n * E, "redeem 20 from 10 idle to the high band of 30");
});

test("D8 orphan rows: an inserted unclaimed row is sealed and rolled back by the next cycle's generic resolver; a spawned row with no response is held no-response; the generic resolver never writes sign-recovery", async t => {
  const w = await earnWorld(t, { lane: "schedule", flag: false });
  const base = { idempotencyKey: "earn:agentic-fixture:1", kind: "earn-deposit" as const, walletAddress: W, agentId: w.f.agent.id, decisionId: null, side: null, fromToken: null, toToken: null,
    amountAtomic: "1", intendedRaw: null, fromQty: "1", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null,
    operationId: null, walletNoncePre: "0", quoteAt: null, dispatch: "unclaimed" as const, claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null,
    cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open" as const, holdReason: null, evidence: null, fillCheck: "none" as const,
    createdAt: w.now(), updatedAt: w.now() };
  assert.ok(await w.f.store.createOrder(base));
  await w.advance(MINUTE);
  const generic = async (key: string): Promise<void> => {
    const fence = (await w.f.store.acquireFence(W, w.f.instance.row.instanceId))!;
    try { await resolveAgenticOrder({ ...w.f.execution, journal: w.f.journal, order: (await w.f.store.getOrder(key))!, fence }); } finally { await w.f.store.releaseFence(fence); }
  };
  await generic(base.idempotencyKey);
  assert.deepEqual([(await earn(w))[0]!.dispatch, (await earn(w))[0]!.outcome], ["sealed", "rolled-back"]);
  const spawned = { ...base, idempotencyKey: "earn:agentic-fixture:2", dispatch: "spawned" as const, claimedAt: w.now(), claimant: "x", fenceToken: "1" };
  assert.ok(await w.f.store.createOrder(spawned));
  await generic(spawned.idempotencyKey);
  assert.equal((await w.f.store.getOrder(spawned.idempotencyKey))!.holdReason, null, "the generic resolver leaves an earn row alone");
  await w.step({}, {});
  assert.equal((await w.f.store.getOrder(spawned.idempotencyKey))!.holdReason, "no-response");
});

test("D9 a throw inside dispatch before the claim leaves the row sealed and rolled back in the same step", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.f.store.claimEarnOrder = async () => { throw new Error("boom"); };
  await w.step();
  const [row] = await earn(w);
  assert.deepEqual([row!.dispatch, row!.outcome], ["sealed", "rolled-back"]);
});

test("D10 the BNB floors: a deposit needs 0.0012 BNB (3 reserves), a redeem 0.0001; below them the lane does nothing or says low-bnb", async t => {
  const dep = async (bnb: bigint) => { const w = await earnWorld(t, { lane: "schedule", bnb }); await w.step(); return (await w.rows()).length; };
  assert.deepEqual([await dep(1_200_000_000_000_000n - 1n), await dep(1_200_000_000_000_000n)], [0, 1]);
  const red = async (bnb: bigint) => {
    const w = await earnWorld(t, { lane: "schedule" });
    await w.step();
    w.state.usdt = 10n * E; w.state.bnb = bnb;
    await w.advance(MINUTE); await w.step();
    return { redeems: w.market.count("defi redeem"), codes: await w.codes() };
  };
  const low = await red(100_000_000_000_000n - 1n), ok = await red(100_000_000_000_000n);
  assert.equal(low.redeems, 0); assert.ok(low.codes.includes("earn-redeem-blocked"));
  assert.equal(ok.redeems, 1);
});

test("D11 audit M-1 (rule 18, P4): a preview whose interact-with address is not a pinned target sends nothing: zero deposit, earn-unavailable, no row", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.preview = "foreign";
  await w.step();
  assert.equal(w.market.count("defi preview"), 1, "the preview was read");
  assert.equal(w.market.count("defi deposit"), 0);
  assert.equal((await earn(w)).length, 0);
  assert.ok((await w.codes()).includes("earn-unavailable"));
});

test("D12 audit M-1 (rule 6): a product whose pin check fails, or an unreadable pin read, is never deposited into", async t => {
  const closed = await earnWorld(t, { lane: "schedule" });
  closed.f.chain.earnPins = async () => ({ venus: false, "aave-v3": false });
  await closed.step();
  assert.deepEqual([closed.market.count("defi deposit"), (await earn(closed)).length, (await closed.codes()).includes("earn-unavailable")], [0, 0, true]);
  const thrown = await earnWorld(t, { lane: "schedule" });
  thrown.failures.pins = true;
  await thrown.step();
  assert.deepEqual([thrown.market.count("defi deposit"), (await earn(thrown)).length, (await thrown.codes()).includes("earn-unavailable")], [0, 0, true]);
  const one = await earnWorld(t, { lane: "schedule" });
  one.f.chain.earnPins = async () => ({ venus: false, "aave-v3": true });
  await one.step();
  assert.equal(one.state.aave, 60n * E, "only the pin-checked product takes the deposit although Venus pays more");
  assert.equal(one.state.venus, 0n);
});

test("D13 audit M-3: a deposit refused before its row (earn-unavailable) backs off 600 s, then retries", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  w.market.preview = "foreign";
  await w.step();
  const reads = w.market.count("defi investment-list");
  await w.advance(MINUTE); await w.step(); await w.advance(5 * MINUTE); await w.step();
  assert.equal(w.market.count("defi investment-list"), reads, "no Binance read inside the back-off");
  await w.advance(5 * MINUTE); await w.step();
  assert.equal(w.market.count("defi investment-list"), reads + 1, "retried after 600 s");
});

test("D14 audit L-2: a refused redeem preview writes no row, logs earn-redeem-blocked preview-refused and retries once per 600 s", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  await w.step();
  w.state.usdt = 10n * E;
  w.market.preview = "error";
  await w.advance(MINUTE); await w.step();
  const previews = w.market.count("defi preview");
  await w.advance(MINUTE); await w.step(); await w.advance(5 * MINUTE); await w.step();
  assert.equal(w.market.count("defi preview"), previews, "no preview inside the back-off");
  assert.equal(w.market.count("defi redeem"), 0);
  assert.equal((await earn(w)).filter(r => r.kind === "earn-redeem").length, 0);
  const events = (await w.runs()).flatMap(r => r.events ?? []).filter(e => e.code === "earn-redeem-blocked");
  assert.equal(events.filter(e => e.reason === "preview-refused").length, 1, "the refusal is logged once; the back-off cycles say held, so the window does not restart itself");
  assert.ok(events.some(e => e.reason === "held"));
  w.market.preview = "ok";
  await w.advance(5 * MINUTE); await w.step();
  assert.equal(w.market.count("defi redeem"), 1, "retried after 600 s");
});

test("D15 audit L-4: a paused agent gets no deposit row at all (the pre-check, not a sealed claim)", async t => {
  const w = await earnWorld(t, { lane: "schedule" });
  await w.f.killswitch.pauseAgent(w.f.agent.id, W);
  await w.step();
  assert.deepEqual([(await earn(w)).length, w.market.count("defi deposit"), w.market.count("defi investment-list")], [0, 0, 0]);
});

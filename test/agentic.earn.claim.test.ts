/** AGENTIC-EARN-SPEC ET6 (memory twin): each predicate of the earn claim (rule 36) flipped alone refuses; a redeem is admitted in ending, on a revoked agent, under a settings hold and one that is bound, refused under a halt and a pause;
 *  another open row or a pending intent refuses; AGENTIC_CLAIM_SQL is the pre-earn text. The real-Postgres twin of the same vectors is test/integration/agentic.earn.postgres.integration.ts. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgenticOrder } from "../src/agentic/domain.js";
import { AGENTIC_CLAIM_SQL, EARN_CLAIM_SQL } from "../src/agentic/store.js";
import { DAY, NOW, W, earnWorld, type EarnWorld } from "./support/agenticEarn.js";

const row = (w: EarnWorld, kind: "earn-deposit" | "earn-redeem", patch: Partial<AgenticOrder> = {}): AgenticOrder => ({ idempotencyKey: "earn:agentic-fixture:1", kind, walletAddress: W, agentId: w.f.agent.id,
  decisionId: null, side: null, fromToken: null, toToken: null, amountAtomic: "1", intendedRaw: null, fromQty: "1", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null,
  multiplierUsed: null, listSnapshot: null, operationId: null, walletNoncePre: "0", quoteAt: null, dispatch: "unclaimed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null,
  response: null, cliResult: null, returnedOrderId: null, listedOrderId: null, txHash: null, approveTxHash: null, outcome: "open", holdReason: null, evidence: null, fillCheck: "none",
  createdAt: w.now(), updatedAt: w.now(), ...patch });
async function claim(w: EarnWorld, kind: "earn-deposit" | "earn-redeem", mutate: (w: EarnWorld) => Promise<void> | void = () => undefined, patch: Partial<AgenticOrder> = {},
  fenceOf: (fence: { walletAddress: typeof W; token: string; holder: string; leaseUntil: number }) => typeof fence = fence => fence) {
  await mutate(w);
  assert.ok(await w.f.store.createOrder(row(w, kind, patch)));
  const fence = (await w.f.store.acquireFence(W, w.f.instance.row.instanceId))!;
  const claimed = await w.f.store.claimEarnOrder(row(w, kind, patch), fenceOf(fence));
  return { claimed, fence };
}
const base = async (t: Parameters<typeof earnWorld>[0]) => earnWorld(t, { lane: "schedule", flag: false });
const patchWallet = async (w: EarnWorld, patch: Parameters<EarnWorld["f"]["store"]["patchWallet"]>[1]) => { await w.f.store.patchWallet(await w.wallet(), patch); };

test("CL1 positive controls: a deposit and a redeem claim, with their stored claim deadlines", async t => {
  const dep = await claim(await base(t), "earn-deposit");
  assert.deepEqual([dep.claimed?.dispatch, dep.claimed?.claimant, dep.claimed?.claimDeadline], ["spawned", dep.fence.holder, NOW + 7 * DAY - DAY]);
  const red = await claim(await base(t), "earn-redeem");
  assert.deepEqual([red.claimed?.dispatch, red.claimed?.claimDeadline], ["spawned", NOW + 90 * DAY - 1_800_000]);
});

test("CL2 a deposit refuses on each predicate flipped alone", async t => {
  const refused: [string, (w: EarnWorld) => Promise<void> | void, Partial<AgenticOrder>?][] = [
    ["wallet ending", async w => { await w.f.store.leaveBound(await w.wallet(), "term-ended"); }],
    ["settings hold", w => patchWallet(w, { settingsHold: { code: "daily-limit", atMs: NOW } })],
    ["entries stopped", w => patchWallet(w, { entriesStopped: { reason: "fill-below-minimum", out: "1", min: "2", atMs: NOW } })],
    ["drain requested", w => patchWallet(w, { drainRequestedAt: NOW })],
    ["within 24 h of the end", w => w.at(NOW + 6 * DAY + 1)],
    ["agent revoked", async w => { const a = (await w.f.agents.getAgentById(w.f.agent.id))!; await w.f.agents.transitionAgentStatus({ ownerAddress: a.ownerAddress, agentId: a.id, expectedStatus: "armed", expectedRowVersion: a.rowVersion, status: "revoked" }); }],
    ["global halt", async w => { await w.f.killswitch.halt("test"); }],
    ["agent paused", async w => { await w.f.killswitch.pauseAgent(w.f.agent.id, W); }],
    ["instance retired", async w => { await w.f.store.retire(w.f.instance.row.instanceId, "exit"); }],
    ["instance heartbeat stale", w => { w.f.setTime(NOW + 31_000); }],
    ["row older than 60 s", () => undefined, { createdAt: NOW - 61_000 }],
    ["row already claimed", () => undefined, { dispatch: "spawned" }],
    ["row outcome not open", () => undefined, { outcome: "rolled-back" }],
  ];
  for (const [label, mutate, patch] of refused) {
    const w = await base(t);
    let result;
    result = await claim(w, "earn-deposit", mutate, patch);
    assert.equal(result.claimed, null, label);
  }
});

test("CL2b the fence: a different holder, a different token and a lease under 75 s refuse a deposit and a redeem; exactly 75 s is admitted", async t => {
  for (const kind of ["earn-deposit", "earn-redeem"] as const) {
    assert.equal((await claim(await base(t), kind, () => undefined, {}, f => ({ ...f, holder: "someone-else" }))).claimed, null, kind + " holder");
    assert.equal((await claim(await base(t), kind, () => undefined, {}, f => ({ ...f, token: "999" }))).claimed, null, kind + " token");
    assert.equal((await claim(await base(t), kind, () => undefined, {}, f => ({ ...f, leaseUntil: 0 }))).claimed !== null, true, kind + " the stored lease decides, not the caller's copy");
    for (const [delta, admitted] of [[45_000, true], [45_001, false]] as const) {
      const w = await base(t);
      assert.ok(await w.f.store.createOrder(row(w, kind)));
      const fence = (await w.f.store.acquireFence(W, w.f.instance.row.instanceId))!;
      await w.at(NOW + delta);
      assert.equal((await w.f.store.claimEarnOrder(row(w, kind), fence)) !== null, admitted, `${kind}: a 120 s lease with ${120_000 - delta} ms left (75 000 ms is the margin)`);
    }
  }
});

test("CL3 a deposit also refuses with another open row of the wallet, a fill-pending row and a pending intent; a settled history does not block", async t => {
  const w = await base(t);
  await w.f.store.createOrder(row(w, "earn-redeem", { idempotencyKey: "other", dispatch: "spawned", outcome: "open" }));
  assert.equal((await claim(w, "earn-deposit")).claimed, null, "another open row");
  const f = await base(t);
  await f.f.store.createOrder(row(f, "earn-redeem", { idempotencyKey: "pending-fill", dispatch: "spawned", outcome: "committed", fillCheck: "pending" }));
  assert.equal((await claim(f, "earn-deposit")).claimed, null, "a fill-pending row");
  const g = await base(t);
  await g.f.store.createOrder(row(g, "earn-redeem", { idempotencyKey: "done", dispatch: "spawned", outcome: "committed" }));
  assert.ok((await claim(g, "earn-deposit")).claimed, "a committed row is not an obligation");
  const h = await base(t);
  await h.f.intents.create({ decisionId: "d", idempotencyKey: `0x${"11".repeat(32)}`, agentId: h.f.agent.id, ownerAddress: W, side: "buy", token: "0x2222222222222222222222222222222222222222", route: { hops: [], fees: [] },
    amountWei: 1n, entryWei: 1n, positionId: "p", closeReason: null });
  assert.equal((await claim(h, "earn-deposit")).claimed, null, "a pending intent");
});

test("CL4 a redeem is admitted in ending, on a revoked agent, under a settings hold and while bound; refused under a halt, a pause, ended, and from 30 min before the maximum sign-in time", async t => {
  const ok: [string, (w: EarnWorld) => Promise<void> | void][] = [
    ["bound", () => undefined],
    ["ending", async w => { await w.f.store.leaveBound(await w.wallet(), "term-ended"); }],
    ["revoked agent", async w => { const a = (await w.f.agents.getAgentById(w.f.agent.id))!; await w.f.agents.transitionAgentStatus({ ownerAddress: a.ownerAddress, agentId: a.id, expectedStatus: "armed", expectedRowVersion: a.rowVersion, status: "revoked" }); }],
    ["settings hold", w => patchWallet(w, { settingsHold: { code: "daily-limit", atMs: NOW } })],
    ["entries stopped and drain", w => patchWallet(w, { entriesStopped: { reason: "fill-below-minimum", out: "1", min: "2", atMs: NOW }, drainRequestedAt: NOW })],
    ["past the hire end", async w => { await w.at(NOW + 8 * DAY); await w.f.store.leaveBound(await w.wallet(), "term-ended"); }],
  ];
  for (const [label, mutate] of ok) assert.ok((await claim(await base(t), "earn-redeem", mutate)).claimed, label);
  const no: [string, (w: EarnWorld) => Promise<void> | void][] = [
    ["agent paused", async w => { await w.f.killswitch.pauseAgent(w.f.agent.id, W); }],
    ["global halt", async w => { await w.f.killswitch.halt("test"); }],
    ["exactly 5 s before the limit (n + 5 s must be below it)", async w => { await w.at(NOW + 90 * DAY - 1_800_000 - 5_000); }],
    ["wallet ended", async w => { await w.f.store.leaveBound(await w.wallet(), "owner-signed-out"); }],
  ];
  for (const [label, mutate] of no) assert.equal((await claim(await base(t), "earn-redeem", mutate)).claimed, null, label);
  const edge = await base(t);
  assert.ok((await claim(edge, "earn-redeem", w => w.at(NOW + 90 * DAY - 1_800_000 - 5_001))).claimed !== null, "1 ms inside the limit");
});

test("CL5 the execution-api instance may not claim; a wallet without the earn fact cannot claim", async t => {
  const plain = await earnWorld(t, { lane: "schedule", earn: false });
  assert.equal((await claim(plain, "earn-deposit")).claimed, null, "no hire_facts.earn");
  const api = await base(t);
  assert.ok(await api.f.store.createOrder(row(api, "earn-deposit")));
  await api.f.store.registerInstance({ instanceId: "api", service: "execution-api", host: "h", pid: 1, machineId: "m", osBootMarker: "b", railwayDeploymentId: null, railwayReplicaId: null,
    bootAt: NOW, heartbeatAt: NOW, retiredAt: null, retiredBy: null });
  const fence = (await api.f.store.acquireFence(W, "api"))!;
  assert.equal(await api.f.store.claimEarnOrder(row(api, "earn-deposit"), fence), null);
});

test("CL6 the pre-earn claim text is untouched: AGENTIC_CLAIM_SQL hashes to its pinned text and the earn claim is a separate statement", () => {
  assert.notEqual(EARN_CLAIM_SQL, AGENTIC_CLAIM_SQL);
  const store = readFileSync("src/agentic/store.ts", "utf8").replace(/\r\n/gu, "\n");
  const tail = store.slice(store.indexOf("export const AGENTIC_CLAIM_SQL"));
  assert.equal(createHash("sha256").update(tail).digest("hex"), "55dd19103f34afeabb6e890864ee548cdece025aea286cb5be01e572b1276d45");
  assert.ok(store.indexOf("export const EARN_CLAIM_SQL") < store.indexOf("export const AGENTIC_CLAIM_SQL"), "outside the pinned slice");
});

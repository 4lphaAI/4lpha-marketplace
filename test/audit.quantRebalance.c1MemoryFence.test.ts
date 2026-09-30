/** Independent C1 follow-up: real memory stores, controlled async scheduling, no I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { MemoryQuantRebalanceStore, type RebalanceActionInsertInput } from "../src/store/quantRebalance.js";
import { quantRebalanceImmutableWireDigest, runQuantRebalanceWorkerOnce, type QuantRebalanceWorkerDeps } from "../src/quant/rebalanceWorker.js";
import { buildQuantRebalanceReportPayload } from "../src/quant/rebalanceReporting.js";
import { E18, REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow, QuantRebalanceJobWire } from "../src/quant/rebalanceTypes.js";

const NOW = 1_800_000_000_000;
const HASH = `0x${"74".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"63".repeat(20)}`);

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture() {
  const claims = new MemoryQuantWalletClaimStore({
    noAction: async () => true,
    terminalAndNoUnresolved: async () => false,
  }, true);
  const store = new MemoryQuantRebalanceStore(claims);
  const record = {
    id: "c1-memory", strategyId: "c1-memory", tradingWalletAddress: WALLET,
    status: "ACTIVE", allocationUWei: 75n * E18, dailyCapUWei: 100n * E18,
    termDays: 30, startedAtMs: NOW - 1_000, endsAtMs: NOW + 1_000_000,
    sessionExpiresAtMs: NOW + 1_000_000, revokedAtMs: null,
  };
  const wire: QuantRebalanceJobWire = { ...record, envelope: null, wireDigest: quantRebalanceImmutableWireDigest(record) };
  const discovered = await store.discoverJob({ wire, envelopeJson: null, envelopeId: null, nowMs: NOW });
  const attempt = { wallet: WALLET, strategyKind: "rebalance" as const, strategyId: wire.strategyId,
    jobId: wire.id, attemptId: "admit", nowMs: NOW };
  const acquired = await claims.claimProvisional(attempt);
  assert.equal(acquired.kind, "acquired");
  if (acquired.kind !== "acquired") throw new Error("fixture-claim-refused");
  const generation = acquired.claim.generation;
  const promotion = await claims.promoteProvisional({ ...attempt, generation }, async () => {
    const result = await store.admit({
      jobId: wire.id, expectedRowVersion: discovered.rowVersion, attemptId: attempt.attemptId,
      claimGeneration: generation, policyJson: "{}", policyDigest: HASH, tier: "high",
      sessionPublicKey: `0x${"11".repeat(65)}` as Hex, sessionExpirySec: Math.floor((NOW + 1_000_000) / 1_000),
      permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]",
      baselineBlock: 100n, baselineHash: HASH, baselineAtMs: NOW,
      actualBaseline: { USDC: 75n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
      protectedBaseline: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }, nowMs: NOW,
    });
    return result.kind === "ok" ? result.record : null;
  });
  assert.equal(promotion.promoted, true);
  const job = await store.getJob(wire.id);
  const check = (await store.listChecks(wire.id))[0];
  assert(job !== null && check !== undefined);
  const intent: RebalanceActionInsertInput = {
    jobId: job.jobId, checkId: check.checkId, sequence: 1n, side: "buy", asset: "WBNB",
    tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
    pairAddresses: [getAddress(`0x${"52".repeat(20)}`)], amountInWei: E18, minOutWei: E18,
    quoteOutWei: E18, deadlineSec: Math.floor(NOW / 1_000) + 600,
    callsJson: "[]", callsDigest: HASH, policyDigest: HASH, permissionsDigest: HASH,
    projectionDigest: HASH, claimGeneration: generation,
    quoteBlockNumber: 100n, quoteBlockHash: HASH, quoteObservedAtMs: NOW,
    referenceBlockNumber: 100n, referenceBlockHash: HASH, referenceObservedAtMs: NOW,
    referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
    expectedJobRevision: job.accountingRev, expectedCheckVersion: check.rowVersion, nowMs: NOW,
  };
  return { claims, store, wire, intent };
}

test("audit C1 memory: insertion admitted before a fence wait cannot insert after ending wins", async () => {
  const { store, wire, intent } = await fixture();
  const inserting = store.insertAction(intent);
  await store.markEnded({ jobId: wire.id, unresolved: false, nowMs: NOW });
  const inserted = await inserting;
  const job = await store.getJob(wire.id);
  assert.equal(job?.status, inserted.kind === "ok" ? "ended-unresolved" : "ended",
    "either insertion wins and ending sees it, or ending wins and insertion refuses");
});

test("audit C1 memory: delayed insertion cannot invalidate the ended retry's report snapshot", async () => {
  const { claims, store, wire, intent } = await fixture();
  const entered = latch(); const unblock = latch();
  const holder = claims.withWalletFence(WALLET, async () => { entered.release(); await unblock.promise; });
  await entered.promise;
  const inserting = store.insertAction(intent);
  let endFinished = false;
  const ending = store.markEnded({ jobId: wire.id, unresolved: false, nowMs: NOW }).then(() => { endFinished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  // A repaired end may itself serialize behind insertion; allow that safe order.
  if (!endFinished) { unblock.release(); await holder; await inserting; }
  await ending;
  const initiallyDefinitive = (await store.listUnresolvedActions(wire.id)).length === 0;
  const listActions = store.listActions.bind(store);
  let snapshotRead = false;
  store.listActions = async (jobId) => {
    const snapshot = await listActions(jobId);
    snapshotRead = true;
    // Pause only delivery of a real read result. No row/status is fabricated.
    // Let the already queued writer run between snapshot capture and report.
    unblock.release(); await holder; await inserting;
    return snapshot;
  };
  let reportCalls = 0; let unresolvedAtSend = 0;
  const deps = {
    store, claims, strategyId: wire.strategyId, agentId: "offline", nowMs: () => NOW, intervalMs: 60_000,
    transport: {
      inbox: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
      job: async () => ({ ok: true, data: wire }),
    },
    recoverAction: async () => ({ kind: "waiting" }),
    async reportJob(_job: QuantRebalanceJobRow, actions: readonly QuantRebalanceActionRow[]) {
      reportCalls += 1;
      unresolvedAtSend = (await store.listUnresolvedActions(wire.id)).length;
      assert.deepEqual(buildQuantRebalanceReportPayload(actions), { trades: [] });
      return { ok: true, payloadDigest: HASH, responseStatus: 200, notesApplied: 0 };
    },
  } as unknown as QuantRebalanceWorkerDeps;
  try {
    const cycle = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(cycle.errors, 0);
    assert.equal(snapshotRead, initiallyDefinitive, "a definitive ended retry must actually reach the reporting gate");
    assert.equal(reportCalls > 0 && unresolvedAtSend > 0, false,
      `a report must never be sent with unresolved actions (calls=${reportCalls}, unresolved=${unresolvedAtSend})`);
  } finally { unblock.release(); await holder; await inserting; }
});

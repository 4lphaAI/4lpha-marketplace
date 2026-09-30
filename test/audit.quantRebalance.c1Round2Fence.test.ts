/** Independent round-2 C1 fence coverage: offline memory stores only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";
import { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { MemoryQuantRebalanceStore, type RebalanceActionInsertInput } from "../src/store/quantRebalance.js";
import { quantRebalanceImmutableWireDigest } from "../src/quant/rebalanceWorker.js";
import { brandVerifiedRetirementProof } from "../src/store/quantRebalanceProof.js";
import { E18, REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import type { QuantRebalanceJobWire } from "../src/quant/rebalanceTypes.js";

const NOW = 1_800_000_000_000;
const HASH = `0x${"74".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"63".repeat(20)}`);

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(journalRead?: () => Promise<null>) {
  const claims = new MemoryQuantWalletClaimStore({
    noAction: async () => true,
    terminalAndNoUnresolved: async () => false,
  }, true);
  const store = new MemoryQuantRebalanceStore(claims, journalRead);
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

test("audit C1 round2: ending waits for an abort writer and cannot lose its terminal status", async () => {
  const reading = latch(); const resume = latch();
  const { store, wire, intent } = await fixture(async () => { reading.release(); await resume.promise; return null; });
  const inserted = await store.insertAction(intent); assert.equal(inserted.kind, "ok");
  if (inserted.kind !== "ok") throw new Error("fixture-insert-refused");
  const aborting = store.abortIntendedAction({ actionId: inserted.record.actionId,
    expectedRowVersion: inserted.record.rowVersion, expectedJournalState: "absent", nowMs: NOW });
  await reading.promise;
  let endFinished = false;
  const ending = store.markEnded({ jobId: wire.id, unresolved: false, nowMs: NOW }).then(() => { endFinished = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(endFinished, false, "ending must wait while abort retains an older admitted job across its journal read");
  } finally { resume.release(); await aborting; await ending; }
  assert.equal((await aborting).kind, "ok");
  assert.equal((await store.getJob(wire.id))?.status, "ended");
  assert.equal((await store.listUnresolvedActions(wire.id)).length, 0);
  const job = await store.getJob(wire.id); const check = (await store.listChecks(wire.id))[0];
  assert(job !== null && check !== undefined);
  assert.deepEqual(await store.insertAction({ ...intent, sequence: 2n, deadlineSec: intent.deadlineSec + 1,
    expectedJobRevision: job.accountingRev, expectedCheckVersion: check.rowVersion }),
  { kind: "inconsistent", code: "claim-missing" });
});

for (const retirementFirst of [true, false]) {
  test(`audit C1 round2: retirement/insertion order retirementFirst=${retirementFirst} preserves eligibility`, async () => {
    const { claims, store, wire, intent } = await fixture();
    const before = await store.getJob(wire.id); assert(before !== null);
    const entered = latch(); const resume = latch();
    const holder = claims.withWalletFence(WALLET, async () => { entered.release(); await resume.promise; });
    await entered.promise;
    const retirementInput = { jobId: wire.id, expectedRowVersion: before.rowVersion,
      proof: brandVerifiedRetirementProof({ chainId: 56, jobId: wire.id, generation: intent.claimGeneration,
        evidenceDigest: HASH, evidenceJson: "{}" }), nowMs: NOW };
    const retire = () => store.retireJob(retirementInput);
    const insert = () => store.insertAction(intent);
    const retiring = retirementFirst ? retire() : undefined;
    const inserting = insert();
    const retirement = retiring ?? retire();
    resume.release(); await holder;
    const [retired, inserted] = await Promise.all([retirement, inserting]);
    if (retirementFirst) {
      assert.equal(retired.kind, "ok");
      assert.deepEqual(inserted, { kind: "inconsistent", code: "claim-missing" });
      assert.equal((await store.getJob(wire.id))?.status, "ended");
      assert.deepEqual(await store.listActions(wire.id), []);
    } else {
      assert.equal(inserted.kind, "ok");
      assert.equal(retired.kind, "conflict", "insertion changes the retirement CAS version");
      const current = await store.getJob(wire.id); assert(current !== null);
      const retried = await store.retireJob({ ...retirementInput, expectedRowVersion: current.rowVersion });
      assert.equal(retried.kind, "ok");
      assert.equal((await store.getJob(wire.id))?.status, "ended-unresolved");
      assert.equal((await store.listUnresolvedActions(wire.id)).length, 1);
      assert.deepEqual(await store.recordReportAttempt({ jobId: wire.id, payloadDigest: HASH,
        responseStatus: 200, notesApplied: 0, nowMs: NOW }), { kind: "conflict", record: await store.getJob(wire.id) });
    }
  });
}

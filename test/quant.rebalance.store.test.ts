import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import {
  MemoryQuantWalletClaimStore, type QuantClaimProofReader,
} from "../src/store/quantWalletClaims.js";
import { MemoryQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { brandVerifiedFailureProof } from "../src/store/quantRebalanceProof.js";
import { brandVerifiedNotExecutedProof, brandVerifiedRetirementProof } from "../src/store/quantRebalanceProof.js";
import { quantRebalanceWorkerLeaseOpen } from "../src/quant/execute.js";
import { E18, REBALANCE_ETH, REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import type { QuantRebalanceJobWire } from "../src/quant/rebalanceTypes.js";

const WALLET = getAddress("0x1000000000000000000000000000000000000001");
const HASH = `0x${"a".repeat(64)}` as Hex;
const NOW = 1_800_000_000_000;

function proofReader(state: { readonly noAction?: () => boolean; readonly terminal?: () => boolean } = {}): QuantClaimProofReader {
  return {
    async noAction() { return state.noAction?.() ?? true; },
    async terminalAndNoUnresolved() { return state.terminal?.() ?? false; },
  };
}
function jobRecord(id = "rb-job"): QuantJobRecord {
  return { id, status: "ACTIVE", strategyId: "strategy-1", tradingWalletAddress: WALLET,
    allocationUWei: 75n * E18, dailyCapUWei: 100n * E18, termDays: 30,
    startedAtMs: NOW - 1_000, endsAtMs: NOW + 1_000_000, sessionExpiresAtMs: NOW + 1_000_000, revokedAtMs: null };
}
function wire(record = jobRecord()): QuantRebalanceJobWire {
  return { ...record, envelope: null, wireDigest: keccak256(stringToBytes(record.id)) };
}
function admissionInput(rowVersion: number, generation: bigint, attemptId: string) {
  return {
    jobId: "rb-job", expectedRowVersion: rowVersion, attemptId, claimGeneration: generation,
    policyJson: "{}", policyDigest: HASH, tier: "high" as const,
    sessionPublicKey: `0x${"11".repeat(65)}` as Hex, sessionExpirySec: Math.floor((NOW + 1_000_000) / 1_000),
    permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]",
    baselineBlock: 100n, baselineHash: HASH, baselineAtMs: NOW,
    actualBaseline: { USDC: 75n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
    protectedBaseline: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }, nowMs: NOW,
  };
}

describe("Quant shared wallet claims", () => {
  it("atomically admits one provisional claimant for a wallet across strategy kinds", async () => {
    const claims = new MemoryQuantWalletClaimStore(proofReader(), true);
    const requests = [
      { wallet: WALLET, strategyKind: "grid" as const, strategyId: "grid", jobId: "grid-1", attemptId: "g1", nowMs: NOW },
      { wallet: WALLET, strategyKind: "rebalance" as const, strategyId: "rb", jobId: "rb-1", attemptId: "r1", nowMs: NOW },
    ];
    const results = await Promise.all(requests.map((request) => claims.claimProvisional(request)));
    assert.equal(results.filter((result) => result.kind === "acquired").length, 1);
    assert.equal(results.filter((result) => result.kind === "held").length, 1);
    const claim = (await claims.list())[0];
    assert.equal(claim?.mode, "provisional");
    assert.equal(claim?.generation, 1n);
  });

  it("does not trust caller-fabricated no-action evidence and retains tombstone generations", async () => {
    const claims = new MemoryQuantWalletClaimStore();
    const acquired = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "rb-1", attemptId: "attempt-1", nowMs: NOW });
    assert.equal(acquired.kind, "acquired");
    if (acquired.kind !== "acquired") return;
    const fabricated = await claims.releaseProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "rb-1", attemptId: "attempt-1", generation: acquired.claim.generation, refusal: "malformed-envelope", nowMs: NOW, noActionProof: { admittedAtNull: true } } as never);
    assert.equal(fabricated, "claim-inconsistent");
    assert.equal((await claims.list())[0]?.mode, "provisional");
    assert.equal((await claims.list())[0]?.generation, acquired.claim.generation);
  });

  it("reclaims an expired provisional only after the proof reader confirms no action", async () => {
    const state = { noAction: true };
    const claims = new MemoryQuantWalletClaimStore(proofReader({ noAction: () => state.noAction }), true);
    const old = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "old", attemptId: "old-a", nowMs: NOW });
    assert.equal(old.kind, "acquired"); if (old.kind !== "acquired") return;
    const blocked = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "new", attemptId: "new-a", nowMs: NOW + 121_000 });
    assert.equal(blocked.kind, "acquired");
    if (blocked.kind !== "acquired") return;
    assert(blocked.claim.generation > old.claim.generation);
    const stalePromotion = await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "old", attemptId: "old-a", generation: old.claim.generation, nowMs: NOW + 121_000 }, async () => "late");
    assert.equal(stalePromotion.promoted, false);
  });

  it("keeps active claims through holds and releases only after a fresh terminal proof", async () => {
    const state = { terminal: false };
    const claims = new MemoryQuantWalletClaimStore(proofReader({ terminal: () => state.terminal }), true);
    const acquired = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "rb-1", attemptId: "a", nowMs: NOW });
    assert.equal(acquired.kind, "acquired"); if (acquired.kind !== "acquired") return;
    const promoted = await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "rb-1", attemptId: "a", generation: acquired.claim.generation, nowMs: NOW }, async () => "admitted");
    assert.equal(promoted.promoted, true);
    const wrongClaim = await claims.releaseTerminal({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "rb-1", generation: acquired.claim.generation - 1n, nowMs: NOW });
    assert.equal(wrongClaim, false);
    assert.equal((await claims.list())[0]?.mode, "active");
    state.terminal = true;
    assert.equal(await claims.releaseTerminal({ wallet: WALLET, strategyKind: "rebalance", strategyId: "rb", jobId: "rb-1", generation: acquired.claim.generation, nowMs: NOW }), true);
    assert.equal((await claims.list())[0]?.mode, "free");
    assert.equal((await claims.list())[0]?.generation, acquired.claim.generation + 1n);
  });
});

describe("Quant rebalancing memory store transaction parity", () => {
  it("promotes admission with the claim and refuses stale submit snapshots or wrong ownership", async () => {
    const claims = new MemoryQuantWalletClaimStore(proofReader(), true);
    const store = new MemoryQuantRebalanceStore(claims);
    const discovered = await store.discoverJob({ wire: wire(), envelopeJson: "{}", envelopeId: "env", nowMs: NOW });
    const lease = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: "rb-job", attemptId: "admit-a", nowMs: NOW });
    assert.equal(lease.kind, "acquired"); if (lease.kind !== "acquired") return;
    const promoted = await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: "rb-job", attemptId: "admit-a", generation: lease.claim.generation, nowMs: NOW }, async () => {
      const admitted = await store.admit(admissionInput(discovered.rowVersion, lease.claim.generation, "admit-a"));
      return admitted.kind === "ok" ? admitted.record : null;
    });
    assert.equal(promoted.promoted, true);
    const job = await store.getJob("rb-job"); assert.equal(job?.status, "admitted");
    const bootstrap = (await store.listChecks("rb-job"))[0]; assert.equal(bootstrap?.state, "rebalancing");
    if (job === null || bootstrap === undefined) return;
    const quoteAt = NOW;
    const intent = {
      actionId: "unused", journalKey: "unused", jobId: job.jobId, checkId: bootstrap.checkId,
      sequence: 1n, state: "intended" as const, side: "buy" as const, asset: "WBNB" as const,
      tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
      pairAddresses: [getAddress("0x2000000000000000000000000000000000000001")],
      amountInWei: E18, minOutWei: E18, quoteOutWei: E18, deadlineSec: Math.floor(NOW / 1_000) + 600,
      callsJson: "[]", callsDigest: HASH, policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!,
      projectionDigest: job.projectionDigest!, claimGeneration: lease.claim.generation,
      quoteBlockNumber: 101n, quoteBlockHash: HASH, quoteObservedAtMs: quoteAt,
      referenceBlockNumber: 101n, referenceBlockHash: HASH, referenceObservedAtMs: quoteAt,
      referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
      expectedJobRevision: job.accountingRev, expectedCheckVersion: bootstrap.rowVersion, nowMs: NOW,
    };
    const inserted = await store.insertAction(intent);
    assert.equal(inserted.kind, "ok"); if (inserted.kind !== "ok") return;
    const afterInsert = await store.getJob(job.jobId); assert.equal(afterInsert?.accountingRev, job.accountingRev + 1n);
    const stale = await store.markSubmitted({ actionId: inserted.record.actionId, expectedRowVersion: inserted.record.rowVersion,
      claimGeneration: lease.claim.generation, blockNumber: 101n, blockHash: HASH, nowMs: NOW + 31_000,
      revalidate: async () => true });
    assert.notEqual(stale.kind, "ok");
    const current = await store.getAction(inserted.record.actionId); assert.equal(current?.state, "intended");
    const lostLease = new AbortController();
    const leaseLostSubmit = await store.markSubmitted({ actionId: inserted.record.actionId, expectedRowVersion: inserted.record.rowVersion,
      claimGeneration: lease.claim.generation, blockNumber: 101n, blockHash: HASH, nowMs: NOW + 1_000,
      revalidate: async (snapshot) => { lostLease.abort(); return quantRebalanceWorkerLeaseOpen(lostLease.signal)
        && snapshot.action.actionId === inserted.record.actionId; } });
    assert.notEqual(leaseLostSubmit.kind, "ok");
    assert.equal((await store.getAction(inserted.record.actionId))?.state, "intended");
    const submitted = await store.markSubmitted({ actionId: inserted.record.actionId, expectedRowVersion: inserted.record.rowVersion,
      claimGeneration: lease.claim.generation, blockNumber: 101n, blockHash: HASH, nowMs: NOW + 1_000,
      revalidate: async () => true });
    assert.equal(submitted.kind, "ok"); if (submitted.kind !== "ok") return;
    const failureProof = brandVerifiedFailureProof({ chainId: 56, txHash: HASH, blockNumber: 101n, blockHash: HASH,
      wallet: WALLET, nonce: 1n, keyHash: HASH, actionId: inserted.record.actionId, failureDigest: HASH });
    const failed = await store.failAction({ actionId: inserted.record.actionId, expectedRowVersion: submitted.record.rowVersion,
      evidence: { kind: "submitted-failure", proof: failureProof }, nowMs: NOW + 2_000 });
    assert.equal(failed.kind, "ok");
    assert.deepEqual((await store.listChecks(job.jobId))[0]?.takenAssets, ["WBNB"]);
    const latestJob = await store.getJob(job.jobId); const latestCheck = (await store.listChecks(job.jobId))[0];
    assert(latestJob !== null && latestCheck !== undefined);
    const retry = await store.insertAction({ ...intent, sequence: 2n, expectedJobRevision: latestJob.accountingRev,
      expectedCheckVersion: latestCheck.rowVersion, nowMs: NOW + 3_000 });
    assert.deepEqual(retry, { kind: "inconsistent", code: "asset-already-taken" });
    const deadlineReplay = await store.insertAction({ ...intent, sequence: 2n, asset: "ETH", tokenOut: REBALANCE_ETH,
      path: [REBALANCE_USDC, REBALANCE_ETH], deadlineSec: intent.deadlineSec,
      expectedJobRevision: latestJob.accountingRev, expectedCheckVersion: latestCheck.rowVersion, nowMs: NOW + 3_500 });
    assert.deepEqual(deadlineReplay, { kind: "inconsistent", code: "revision-changed" });
    const currentJob = await store.getJob(job.jobId); assert(currentJob !== null);
    assert.equal(await claims.isActive({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: job.jobId, generation: lease.claim.generation }), true);
  });

  it("persists bounded report retries and never marks a failed report as acknowledged", async () => {
    const claims = new MemoryQuantWalletClaimStore(proofReader(), true);
    const store = new MemoryQuantRebalanceStore(claims);
    const discovered = await store.discoverJob({ wire: wire(), envelopeJson: "{}", envelopeId: "env", nowMs: NOW });
    const lease = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1",
      jobId: "rb-job", attemptId: "report-attempt", nowMs: NOW });
    assert.equal(lease.kind, "acquired"); if (lease.kind !== "acquired") return;
    const promoted = await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1",
      jobId: "rb-job", attemptId: "report-attempt", generation: lease.claim.generation, nowMs: NOW }, async () => {
      const admitted = await store.admit(admissionInput(discovered.rowVersion, lease.claim.generation, "report-attempt"));
      return admitted.kind === "ok" ? admitted.record : null;
    });
    assert.equal(promoted.promoted, true);
    await store.markEnded({ jobId: "rb-job", unresolved: false, nowMs: NOW + 1 });
    for (let attempt = 1; attempt <= 24; attempt += 1) {
      const result = await store.recordReportAttempt({ jobId: "rb-job", payloadDigest: HASH,
        responseStatus: 503, notesApplied: null, nowMs: NOW + attempt });
      assert.equal(result.kind, "ok", `attempt ${attempt}`);
      assert.equal(result.kind === "ok" ? result.record.reportAttempts : -1, attempt);
    }
    const exhausted = await store.recordReportAttempt({ jobId: "rb-job", payloadDigest: HASH,
      responseStatus: 503, notesApplied: null, nowMs: NOW + 25 });
    assert.equal(exhausted.kind, "conflict");
    assert.equal(await store.markReported({ jobId: "rb-job", nowMs: NOW + 26 }), false);
    const final = await store.getJob("rb-job");
    assert.equal(final?.reportAttempts, 24);
    assert.equal(final?.reportResponseStatus, 503);
    assert.equal(final?.reportPayloadDigest, HASH);
    assert(final !== null);
    const retirementProof = brandVerifiedRetirementProof({ chainId: 56, jobId: final.jobId,
      generation: lease.claim.generation, evidenceDigest: HASH, evidenceJson: JSON.stringify({ digest: HASH, block: "100" }) });
    const retired = await store.retireJob({ jobId: final.jobId, expectedRowVersion: final.rowVersion,
      proof: retirementProof, nowMs: NOW + 30 });
    assert.equal(retired.kind, "ok"); if (retired.kind !== "ok") return;
    const repeatedRetirement = await store.retireJob({ jobId: final.jobId, expectedRowVersion: retired.record.rowVersion,
      proof: retirementProof, nowMs: NOW + 31 });
    assert.equal(repeatedRetirement.kind, "ok");
    assert.equal(repeatedRetirement.kind === "ok" ? repeatedRetirement.record.rowVersion : -1, retired.record.rowVersion);
    const changedProof = brandVerifiedRetirementProof({ chainId: 56, jobId: final.jobId,
      generation: lease.claim.generation, evidenceDigest: `0x${"bc".repeat(32)}` as Hex,
      evidenceJson: JSON.stringify({ digest: `0x${"bc".repeat(32)}`, block: "101" }) });
    const rewrite = await store.retireJob({ jobId: final.jobId, expectedRowVersion: retired.record.rowVersion,
      proof: changedProof, nowMs: NOW + 32 });
    assert.equal(rewrite.kind, "conflict");
  });

  it("rechecks the journal under the wallet fence and consumes a proven not-executed asset", async () => {
    let journal = { state: "UNKNOWN", hasCallsId: false, txHash: null as `0x${string}` | null };
    const claims = new MemoryQuantWalletClaimStore(proofReader(), true);
    const store = new MemoryQuantRebalanceStore(claims, async () => structuredClone(journal));
    const discovered = await store.discoverJob({ wire: wire(), envelopeJson: "{}", envelopeId: "env", nowMs: NOW });
    const lease = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1",
      jobId: "rb-job", attemptId: "not-executed-a", nowMs: NOW });
    assert.equal(lease.kind, "acquired"); if (lease.kind !== "acquired") return;
    const promoted = await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1",
      jobId: "rb-job", attemptId: "not-executed-a", generation: lease.claim.generation, nowMs: NOW }, async () => {
      const admitted = await store.admit(admissionInput(discovered.rowVersion, lease.claim.generation, "not-executed-a"));
      return admitted.kind === "ok" ? admitted.record : null;
    });
    assert.equal(promoted.promoted, true);
    const job = await store.getJob("rb-job"); const check = (await store.listChecks("rb-job"))[0];
    assert(job !== null && check !== undefined);
    const intent = {
      jobId: job.jobId, checkId: check.checkId, sequence: 1n, side: "buy" as const, asset: "WBNB" as const,
      tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
      pairAddresses: [getAddress("0x2000000000000000000000000000000000000001")], amountInWei: E18, minOutWei: E18,
      quoteOutWei: E18, deadlineSec: Math.floor(NOW / 1_000) + 600, callsJson: "[]", callsDigest: HASH,
      policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!, projectionDigest: job.projectionDigest!,
      claimGeneration: lease.claim.generation, quoteBlockNumber: 101n, quoteBlockHash: HASH, quoteObservedAtMs: NOW,
      referenceBlockNumber: 101n, referenceBlockHash: HASH, referenceObservedAtMs: NOW,
      referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
      expectedJobRevision: job.accountingRev, expectedCheckVersion: check.rowVersion, nowMs: NOW,
    };
    const inserted = await store.insertAction(intent); assert.equal(inserted.kind, "ok"); if (inserted.kind !== "ok") return;
    const submitted = await store.markSubmitted({ actionId: inserted.record.actionId, expectedRowVersion: inserted.record.rowVersion,
      claimGeneration: lease.claim.generation, blockNumber: 101n, blockHash: HASH, nowMs: NOW + 1_000, revalidate: async () => true });
    assert.equal(submitted.kind, "ok"); if (submitted.kind !== "ok") return;
    const ambiguous = await store.markAmbiguous({ actionId: inserted.record.actionId, expectedRowVersion: submitted.record.rowVersion,
      state: "unknown", cause: "relay-timeout", nowMs: NOW + 2_000 });
    assert.equal(ambiguous.kind, "ok"); if (ambiguous.kind !== "ok") return;
    const latestJob = await store.getJob(job.jobId); const latestCheck = (await store.listChecks(job.jobId))[0];
    assert(latestJob !== null && latestCheck !== undefined);
    const proof = brandVerifiedNotExecutedProof({ chainId: 56, actionId: ambiguous.record.actionId, jobId: job.jobId,
      generation: lease.claim.generation, evidenceDigest: HASH, evidenceJson: JSON.stringify({ v: 1, digest: HASH }) });
    journal = { state: "COMMITTED", hasCallsId: false, txHash: HASH };
    const raced = await store.resolveNotExecuted({ actionId: ambiguous.record.actionId,
      expectedActionVersion: ambiguous.record.rowVersion, expectedJobVersion: latestJob.rowVersion,
      expectedCheckVersion: latestCheck.rowVersion, proof, nowMs: NOW + 3_000 });
    assert.deepEqual(raced, { kind: "inconsistent", code: "revision-changed" });
    assert.equal((await store.getAction(ambiguous.record.actionId))?.state, "unknown");

    journal = { state: "UNKNOWN", hasCallsId: false, txHash: null };
    const applied = await store.resolveNotExecuted({ actionId: ambiguous.record.actionId,
      expectedActionVersion: ambiguous.record.rowVersion, expectedJobVersion: latestJob.rowVersion,
      expectedCheckVersion: latestCheck.rowVersion, proof, nowMs: NOW + 4_000 });
    assert.equal(applied.kind, "ok");
    if (applied.kind !== "ok") return;
    assert.deepEqual((await store.listChecks(job.jobId))[0]?.takenAssets, ["WBNB"]);
    assert.deepEqual(await store.markAmbiguous({ actionId: applied.record.actionId, expectedRowVersion: applied.record.rowVersion,
      state: "unknown", cause: "late-error", nowMs: NOW + 4_500 }), { kind: "inconsistent", code: "revision-changed" });
    const after = await store.getJob(job.jobId); const afterCheck = (await store.listChecks(job.jobId))[0];
    assert(after !== null && afterCheck !== undefined);
    const retry = await store.insertAction({ ...intent, sequence: 2n, expectedJobRevision: after.accountingRev,
      expectedCheckVersion: afterCheck.rowVersion, nowMs: NOW + 5_000 });
    assert.deepEqual(retry, { kind: "inconsistent", code: "asset-already-taken" });
  });
  it("ending rechecks actions like PostgreSQL: a caller's stale unresolved=false cannot end a job with an intended action", async () => {
    const claims = new MemoryQuantWalletClaimStore(proofReader(), true);
    const store = new MemoryQuantRebalanceStore(claims);
    const discovered = await store.discoverJob({ wire: wire(), envelopeJson: "{}", envelopeId: "env", nowMs: NOW });
    const lease = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: "rb-job", attemptId: "end-race", nowMs: NOW });
    assert.equal(lease.kind, "acquired"); if (lease.kind !== "acquired") return;
    await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: "rb-job", attemptId: "end-race", generation: lease.claim.generation, nowMs: NOW }, async () => {
      const admitted = await store.admit(admissionInput(discovered.rowVersion, lease.claim.generation, "end-race"));
      return admitted.kind === "ok" ? admitted.record : null;
    });
    const job = await store.getJob("rb-job"); const bootstrap = (await store.listChecks("rb-job"))[0];
    assert(job !== null && bootstrap !== undefined);
    const inserted = await store.insertAction({
      jobId: job.jobId, checkId: bootstrap.checkId,
      sequence: 1n, side: "buy", asset: "WBNB",
      tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
      pairAddresses: [getAddress("0x2000000000000000000000000000000000000001")],
      amountInWei: E18, minOutWei: E18, quoteOutWei: E18, deadlineSec: Math.floor(NOW / 1_000) + 600,
      callsJson: "[]", callsDigest: HASH, policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!,
      projectionDigest: job.projectionDigest!, claimGeneration: lease.claim.generation,
      quoteBlockNumber: 101n, quoteBlockHash: HASH, quoteObservedAtMs: NOW,
      referenceBlockNumber: 101n, referenceBlockHash: HASH, referenceObservedAtMs: NOW,
      referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
      expectedJobRevision: job.accountingRev, expectedCheckVersion: bootstrap.rowVersion, nowMs: NOW,
    });
    assert.equal(inserted.kind, "ok");
    await store.markEnded({ jobId: "rb-job", unresolved: false, nowMs: NOW + 1 });
    assert.equal((await store.getJob("rb-job"))?.status, "ended-unresolved");
    const attempt = await store.recordReportAttempt({ jobId: "rb-job", payloadDigest: HASH, responseStatus: 200, notesApplied: 0, nowMs: NOW + 2 });
    assert.notEqual(attempt.kind, "ok");
  });
  it("an insertion that passed its pre-fence check refuses after an end that won the wallet fence", async () => {
    const claims = new MemoryQuantWalletClaimStore(proofReader(), true);
    const store = new MemoryQuantRebalanceStore(claims);
    const discovered = await store.discoverJob({ wire: wire(), envelopeJson: "{}", envelopeId: "env", nowMs: NOW });
    const lease = await claims.claimProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: "rb-job", attemptId: "fence-order", nowMs: NOW });
    assert.equal(lease.kind, "acquired"); if (lease.kind !== "acquired") return;
    await claims.promoteProvisional({ wallet: WALLET, strategyKind: "rebalance", strategyId: "strategy-1", jobId: "rb-job", attemptId: "fence-order", generation: lease.claim.generation, nowMs: NOW }, async () => {
      const admitted = await store.admit(admissionInput(discovered.rowVersion, lease.claim.generation, "fence-order"));
      return admitted.kind === "ok" ? admitted.record : null;
    });
    const job = await store.getJob("rb-job"); const bootstrap = (await store.listChecks("rb-job"))[0];
    assert(job !== null && bootstrap !== undefined);
    let release: () => void = () => undefined; let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const holder = claims.withWalletFence(WALLET, async () => { entered(); await gate; });
    await inside;
    const ending = store.markEnded({ jobId: "rb-job", unresolved: false, nowMs: NOW + 1 });
    const inserting = store.insertAction({
      jobId: job.jobId, checkId: bootstrap.checkId,
      sequence: 1n, side: "buy", asset: "WBNB",
      tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
      pairAddresses: [getAddress("0x2000000000000000000000000000000000000001")],
      amountInWei: E18, minOutWei: E18, quoteOutWei: E18, deadlineSec: Math.floor(NOW / 1_000) + 600,
      callsJson: "[]", callsDigest: HASH, policyDigest: job.policyDigest!, permissionsDigest: job.permissionsDigest!,
      projectionDigest: job.projectionDigest!, claimGeneration: lease.claim.generation,
      quoteBlockNumber: 101n, quoteBlockHash: HASH, quoteObservedAtMs: NOW,
      referenceBlockNumber: 101n, referenceBlockHash: HASH, referenceObservedAtMs: NOW,
      referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
      expectedJobRevision: job.accountingRev, expectedCheckVersion: bootstrap.rowVersion, nowMs: NOW,
    });
    release(); await holder; await ending;
    assert.deepEqual(await inserting, { kind: "inconsistent", code: "claim-missing" });
    assert.equal((await store.getJob("rb-job"))?.status, "ended");
    assert.deepEqual(await store.listActions("rb-job"), []);
  });
});

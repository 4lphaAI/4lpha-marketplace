import assert from "node:assert/strict";
import { it } from "node:test";
import { getAddress, type Hex } from "viem";
import { encodeJsonbParam } from "../src/store/codec.js";
import { proveQuantRebalanceNotExecuted, proveQuantRebalanceRetirement } from "../src/quant/rebalanceOperatorProof.js";
import { selectFreshRebalanceOperatorProof } from "../scripts/live-quant-rebalance.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow, RebalanceBalanceVector } from "../src/quant/rebalanceTypes.js";
import { REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"11".repeat(20)}`);
const actual: RebalanceBalanceVector = { USDC: 100n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n };

function job(overrides: Partial<QuantRebalanceJobRow> = {}): QuantRebalanceJobRow {
  return {
    jobId: "proof-job", strategyId: "strategy", tradingWallet: WALLET, allocationWei: 10n, dailyCapWei: 20n,
    termDays: 30, startedAtMs: 1_000, endsAtMs: 100_000, sessionExpiresAtMs: 100_000, revokedAtMs: null,
    platformStatus: "ACTIVE", status: "ended-unresolved", wireJson: "{}", wireDigest: HASH,
    envelopeJson: null, envelopeId: null, admittedAtMs: 1_000, policyJson: "{}", policyDigest: HASH,
    tier: "low", sessionPublicKey: HASH, sessionExpirySec: 2_000, permissionsDigest: HASH, projectionDigest: HASH,
    descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]", claimGeneration: 3n,
    baselineBlock: 100n, baselineHash: HASH, baselineAtMs: 1_000,
    actualBaselineJson: encodeJsonbParam(actual),
    protectedBaselineJson: encodeJsonbParam({ USDC: 90n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }),
    managed: { USDC: 10n, WBNB: 0n, ETH: 0n, CAKE: 0n },
    costBasis: { WBNB: 0n, ETH: 0n, CAKE: 0n }, accountingRev: 1n, checkRev: 1n,
    nextEligibleSlot: 0, actionSequence: 1n, lastDeadlineSec: 1_500, bootstrapComplete: true,
    externalActivity: false, holdCode: null, holdEvidenceJson: null, reportAttempts: 0,
    reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null,
    reportedAtMs: null, retiredAtMs: null, retirementEvidenceJson: null, rowVersion: 2,
    createdAtMs: 1_000, updatedAtMs: 1_500, ...overrides,
  };
}

function action(overrides: Partial<QuantRebalanceActionRow> = {}): QuantRebalanceActionRow {
  return {
    actionId: "0x01", journalKey: "0x01", jobId: "proof-job", checkId: "check", sequence: 1n,
    plannedAccountingRev: 1n, plannedCheckVersion: 1, state: "unknown", side: "buy", asset: "WBNB",
    tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
    pairAddresses: [getAddress(`0x${"22".repeat(20)}`)], amountInWei: 1n, minOutWei: 1n, quoteOutWei: 2n,
    deadlineSec: 1_500, callsJson: "[]", callsDigest: HASH, policyDigest: HASH, permissionsDigest: HASH,
    projectionDigest: HASH, claimGeneration: 3n, quoteBlockNumber: 101n, quoteBlockHash: HASH,
    quoteObservedAtMs: 1_500, referenceBlockNumber: 101n, referenceBlockHash: HASH,
    referenceObservedAtMs: 1_500, referenceEvidenceJson: "{}", gasEvidenceJson: "{}",
    preSubmitBlockNumber: 101n, preSubmitBlockHash: HASH, txHash: null, fillInWei: null, fillOutWei: null,
    receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null,
    reservationWei: 1n, failureCode: null, ambiguousCause: "other", resolutionJson: null,
    rowVersion: 2, createdAtMs: 1_500, updatedAtMs: 1_500, ...overrides,
  };
}

it("uses zero tolerance and accepts a strictly positive one-wei no-execution proof", () => {
  const jobRow = job(); const actionRow = action();
  const result = proveQuantRebalanceNotExecuted({ job: jobRow, action: actionRow, allActions: [actionRow],
    journalState: "UNKNOWN", journalHasCallsId: false, sharedWalletJobs: 1,
    finalized: { number: 200n, hash: HASH, timestampSec: 2_000n }, baselineBlockHash: HASH,
    submitBlockHash: HASH, canonicalReceiptActionIds: new Set(), actual });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.proof.evidenceJson, /"accountingToleranceWei":"0"/u);
  const oneWeiOff = proveQuantRebalanceNotExecuted({ job: jobRow, action: actionRow, allActions: [actionRow],
    journalState: "UNKNOWN", journalHasCallsId: false, sharedWalletJobs: 1,
    finalized: { number: 200n, hash: HASH, timestampSec: 2_000n }, baselineBlockHash: HASH,
    submitBlockHash: HASH, canonicalReceiptActionIds: new Set(), actual: { ...actual, USDC: 99n } });
  assert.deepEqual(oneWeiOff, { ok: false, code: "balance-mismatch", evidence: {
    expected: { USDC: "100", WBNB: "0", ETH: "0", CAKE: "0", USDT: "0" },
    actual: { USDC: "99", WBNB: "0", ETH: "0", CAKE: "0", USDT: "0" },
  } });
});

it("requires strict expiry-after and an explicit session expiry for permanent retirement", () => {
  const jobRow = job({ sessionExpirySec: 2_000 }); const pending = action();
  const common = { job: jobRow, actions: [pending], keyValid: true,
    finalized: { number: 200n, hash: HASH, timestampSec: 2_000n }, actual };
  assert.deepEqual(proveQuantRebalanceRetirement(common), { ok: false, code: "key-still-valid" });
  assert.deepEqual(proveQuantRebalanceRetirement({ ...common, job: job({ sessionExpirySec: null }) }),
    { ok: false, code: "session-expiry-unavailable" });
  const retired = proveQuantRebalanceRetirement({ ...common, job: job({ sessionExpirySec: 1_999 }) });
  assert.equal(retired.ok, true);
});

it("uses the fresh proof after a finalized-tip advance and refuses changed or regressed evidence", () => {
  const jobRow = job(); const actionRow = action();
  const facts = { job: jobRow, action: actionRow, allActions: [actionRow], journalState: "UNKNOWN",
    journalHasCallsId: false, sharedWalletJobs: 1, baselineBlockHash: HASH,
    submitBlockHash: HASH, canonicalReceiptActionIds: new Set<string>(), actual };
  const preview = proveQuantRebalanceNotExecuted({ ...facts,
    finalized: { number: 200n, hash: HASH, timestampSec: 2_000n } });
  const fresh = proveQuantRebalanceNotExecuted({ ...facts,
    finalized: { number: 201n, hash: `0x${"cd".repeat(32)}` as Hex, timestampSec: 2_001n } });
  assert.equal(preview.ok, true); assert.equal(fresh.ok, true);
  if (!preview.ok || !fresh.ok) return;
  assert.notEqual(fresh.proof.evidenceDigest, preview.proof.evidenceDigest);
  assert.strictEqual(selectFreshRebalanceOperatorProof(preview.proof.evidenceJson, fresh.proof), fresh.proof);
  assert.equal(selectFreshRebalanceOperatorProof(fresh.proof.evidenceJson, preview.proof), null);
  const changedTimestamp = proveQuantRebalanceNotExecuted({ ...facts,
    finalized: { number: 200n, hash: HASH, timestampSec: 2_001n } });
  assert.equal(changedTimestamp.ok, true);
  if (changedTimestamp.ok) assert.equal(selectFreshRebalanceOperatorProof(preview.proof.evidenceJson,
    changedTimestamp.proof), null);
  assert.equal(proveQuantRebalanceNotExecuted({ ...facts, journalState: "COMMITTED",
    finalized: { number: 201n, hash: HASH, timestampSec: 2_001n } }).ok, false);
  assert.equal(proveQuantRebalanceNotExecuted({ ...facts, actual: { ...actual, USDC: 99n },
    finalized: { number: 201n, hash: HASH, timestampSec: 2_001n } }).ok, false);

  const retirement = { job: job({ sessionExpirySec: 1_999 }), actions: [actionRow], keyValid: true };
  const retiredPreview = proveQuantRebalanceRetirement({ ...retirement, actual,
    finalized: { number: 200n, hash: HASH, timestampSec: 2_000n } });
  const retiredFresh = proveQuantRebalanceRetirement({ ...retirement, actual,
    finalized: { number: 201n, hash: `0x${"cd".repeat(32)}` as Hex, timestampSec: 2_001n } });
  const changed = proveQuantRebalanceRetirement({ ...retirement, actual: { ...actual, USDC: 99n },
    finalized: { number: 201n, hash: `0x${"cd".repeat(32)}` as Hex, timestampSec: 2_001n } });
  assert.equal(retiredPreview.ok, true); assert.equal(retiredFresh.ok, true); assert.equal(changed.ok, true);
  if (retiredPreview.ok && retiredFresh.ok && changed.ok) {
    assert.strictEqual(selectFreshRebalanceOperatorProof(retiredPreview.proof.evidenceJson, retiredFresh.proof), retiredFresh.proof);
    assert.equal(selectFreshRebalanceOperatorProof(retiredPreview.proof.evidenceJson, changed.proof), null);
  }
});

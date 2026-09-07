/**
 * The local, proof-carrying escape hatch for the one 3.9c shape that never
 * invoked its durable binder.  This module intentionally receives no wallet,
 * provider, reader or session-key capability; a retirement must remain unable
 * to become a second submit path as it evolves.
 */
import { keccak256, stringToHex, type Hex } from "viem";
import type { JournalEntry } from "../store/journal.js";
import {
  lpSequenceIdOfStepDecision,
  type LpPositionRecord,
  type LpSequenceRecord,
} from "../store/lpSequences.js";
import { parseLpFinalCallsFingerprintV1 } from "./preparedIntent.js";

export const PRE_BIND_RETIREMENT_LEASE_MS = 120_000;

export type PreBindRetirementAdmission = {
  readonly decisionId: string;
  readonly targetJournalKey: string;
  readonly sequenceId: string;
  readonly positionId: string;
  readonly snapshotHash: Hex;
};

/**
 * Checks only durable local facts. In particular, this does not inspect a
 * receipt, chain head, wallet/NFT ownership, elapsed time or the old error
 * text: none of those proves whether a relay submission happened.
 */
export function verifyPreBindRetirement(
  row: JournalEntry,
  sequence: LpSequenceRecord,
  position: LpPositionRecord,
): PreBindRetirementAdmission {
  if (row.kind !== "lp" || row.state !== "UNKNOWN" || row.decisionId === null ||
      row.ownerAddress.toLowerCase() !== sequence.ownerAddress.toLowerCase() ||
      row.agentId !== sequence.agentId || sequence.kind !== "open" ||
      (sequence.state !== "active" && sequence.state !== "held") ||
      (sequence.state === "held" && sequence.recoveryState === "none") ||
      position.ownerAddress.toLowerCase() !== sequence.ownerAddress.toLowerCase() ||
      position.agentId !== sequence.agentId || position.positionId !== sequence.positionId ||
      position.state !== "open" || position.tokenId !== null) {
    throw new Error("The LP row is not a current pre-bind retirement candidate.");
  }
  const sequenceId = lpSequenceIdOfStepDecision(row.decisionId);
  const finalStep = sequence.steps.at(-1);
  if (sequenceId === null || sequenceId !== sequence.sequenceId || finalStep === undefined ||
      finalStep.journalDecisionId !== row.decisionId ||
      finalStep.journalIdempotencyKey !== row.idempotencyKey) {
    throw new Error("The LP row is not the sequence's current step.");
  }
  if (row.finalCallsFingerprint === null || row.finalCallsFingerprintHash === null ||
      keccak256(stringToHex(row.finalCallsFingerprint)) !== row.finalCallsFingerprintHash) {
    throw new Error("The LP row has no valid staged final-calls witness.");
  }
  parseLpFinalCallsFingerprintV1(row.finalCallsFingerprint);
  if (row.preparedIntentIdentity !== null || row.preparedIntentIdentityHash !== null ||
      row.preparedBindingVersion !== 0 || row.externalRef.callsId !== undefined ||
      row.externalRef.txHash !== undefined || row.landingResolutionId !== null ||
      row.landingResolutionKeyHash !== null || row.landingResolutionOutcome !== null ||
      row.landingResolutionEvidenceHash !== null || row.landingResolutionTerminalAt !== null ||
      row.externalRef.retirementEvidence !== undefined ||
      sequence.resolutionId !== null || sequence.resolverActionIdempotencyKey !== null ||
      sequence.resolverLeaseUntil !== null || sequence.resolverSnapshotHash !== null ||
      sequence.resolutionDispositionStarted ||
      sequence.retirementTargetJournalKey !== null ||
      sequence.retirementActionIdempotencyKey !== null ||
      sequence.retirementLeaseUntil !== null || sequence.retirementSnapshotHash !== null ||
      sequence.retirementDispositionStarted) {
    throw new Error("The LP row has crossed or claimed an ambiguous submission boundary.");
  }
  return {
    decisionId: row.decisionId,
    targetJournalKey: row.idempotencyKey,
    sequenceId: sequence.sequenceId,
    positionId: position.positionId,
    snapshotHash: preBindRetirementSnapshotHash(row, sequence, position),
  };
}

/**
 * Re-check the durable no-submit witness after a retirement claim already
 * exists.  It deliberately permits only the idempotent finalizer prefixes:
 * UNKNOWN/open-or-closed before the target transition, then ROLLED_BACK/closed
 * after it.  It never consults chain or provider state.
 */
export function verifyPreBindRetirementClaim(
  row: JournalEntry,
  sequence: LpSequenceRecord,
  position: LpPositionRecord,
): void {
  if (row.kind !== "lp" || row.decisionId === null || sequence.kind !== "open" ||
      sequence.state !== "retiring-pre-bind" ||
      row.ownerAddress.toLowerCase() !== sequence.ownerAddress.toLowerCase() ||
      row.agentId !== sequence.agentId || position.ownerAddress.toLowerCase() !== sequence.ownerAddress.toLowerCase() ||
      position.agentId !== sequence.agentId || position.positionId !== sequence.positionId ||
      position.tokenId !== null ||
      sequence.retirementPriorState === null || sequence.retirementPriorRecoveryState === null ||
      sequence.retirementTargetJournalKey !== row.idempotencyKey ||
      sequence.retirementActionIdempotencyKey === null || sequence.retirementFence <= 0n ||
      sequence.retirementLeaseUntil === null || sequence.retirementSnapshotHash === null ||
      sequence.resolutionId !== null || sequence.resolverActionIdempotencyKey !== null ||
      sequence.resolverLeaseUntil !== null || sequence.resolverSnapshotHash !== null ||
      sequence.resolutionDispositionStarted) {
    throw new Error("The pre-bind retirement claim is no longer compatible.");
  }
  const sequenceId = lpSequenceIdOfStepDecision(row.decisionId);
  const finalStep = sequence.steps.at(-1);
  if (sequenceId !== sequence.sequenceId || finalStep === undefined ||
      finalStep.journalDecisionId !== row.decisionId ||
      finalStep.journalIdempotencyKey !== row.idempotencyKey ||
      row.finalCallsFingerprint === null || row.finalCallsFingerprintHash === null ||
      keccak256(stringToHex(row.finalCallsFingerprint)) !== row.finalCallsFingerprintHash) {
    throw new Error("The pre-bind retirement claim no longer names its exact step.");
  }
  parseLpFinalCallsFingerprintV1(row.finalCallsFingerprint);
  if (row.state === "UNKNOWN") {
    if (row.preparedIntentIdentity !== null || row.preparedIntentIdentityHash !== null ||
        row.preparedBindingVersion !== 0 || row.externalRef.callsId !== undefined ||
        row.externalRef.txHash !== undefined || row.landingResolutionId !== null ||
        row.landingResolutionKeyHash !== null || row.landingResolutionOutcome !== null ||
        row.landingResolutionEvidenceHash !== null || row.landingResolutionTerminalAt !== null ||
        row.externalRef.retirementEvidence !== undefined ||
        (position.state !== "open" && position.state !== "closed") ||
        (position.state === "closed" && position.basisWei !== 0n)) {
      throw new Error("The pre-bind retirement witness is no longer no-submit.");
    }
    return;
  }
  if (row.state !== "ROLLED_BACK" || !sequence.retirementDispositionStarted ||
      position.state !== "closed" || position.basisWei !== 0n ||
      row.externalRef.retirementEvidence?.scheme !== "retired-pre-bind-v1") {
    throw new Error("The pre-bind retirement finalizer state is inconsistent.");
  }
}

export function preBindRetirementSnapshotHash(
  row: JournalEntry,
  sequence: LpSequenceRecord,
  position: LpPositionRecord,
): Hex {
  return keccak256(stringToHex(JSON.stringify({
    row: { key: row.idempotencyKey, state: row.state, decisionId: row.decisionId,
      fingerprintHash: row.finalCallsFingerprintHash, preparedBindingVersion: row.preparedBindingVersion,
      preparedIdentity: row.preparedIntentIdentity, callsId: row.externalRef.callsId ?? null,
      txHash: row.externalRef.txHash ?? null },
    sequence: { id: sequence.sequenceId, state: sequence.state, recovery: sequence.recoveryState,
      updatedAt: sequence.updatedAt, retirementRowVersion: sequence.retirementRowVersion,
      steps: sequence.steps },
    position: { id: position.positionId, state: position.state, tokenId: position.tokenId,
      rowVersion: position.rowVersion, basisWei: position.basisWei.toString(10) },
  })));
}

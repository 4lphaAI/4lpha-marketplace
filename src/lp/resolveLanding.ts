/** Phase 3.9c C5 fenced resolver. It has no submission capability by design. */
import { keccak256, stringToHex, type Hex } from "viem";
import type { ExecutionJournal, JournalEntry } from "../store/journal.js";
import {
  evidenceRequirementKeyHash,
  landingResolutionKeyHash,
  type EvidenceRequirement,
  type LandingEvidenceV1,
  type LandingResolution,
  type LpEvidenceStore,
  type ResolutionActionIdentity,
} from "../store/lpEvidence.js";
import type {
  LpPositionRecord,
  LpRecoveryState,
  LpExitReservation,
  LpSequenceRecord,
  LpSequenceStore,
} from "../store/lpSequences.js";
import { parsePreparedIntentIdentityV1, type PreparedIntentIdentityV1 } from "./preparedIntent.js";
import type { LpPositionsReader, LpReceiptReader } from "./sagas.js";
import type { LandingResolutionFinalizer } from "./landingFinalizer.js";

export type LandingSnapshotDecision =
  | { readonly outcome: "landed" | "absent"; readonly evidence: LandingEvidenceV1 }
  | { readonly outcome: "ambiguous" | "unavailable"; readonly reason: string };

export type LandingEvidenceProvider = {
  readonly enabled: boolean;
  admission(input: {
    readonly begunAtBlock: bigint;
    readonly preparedIdentity: PreparedIntentIdentityV1;
    readonly requirementKeyHash: Hex;
  }): Promise<{ readonly coverageVersion: Hex; readonly quorumId: Hex; readonly laneId: Hex;
    readonly generation?: bigint } | null>;
  snapshot(input: {
    readonly requirement: EvidenceRequirement;
    readonly preparedIdentity: PreparedIntentIdentityV1;
  }): Promise<LandingSnapshotDecision>;
  validateStored(evidence: LandingEvidenceV1): Promise<boolean>;
  /**
   * Memory/test-only equivalent of the SQL citation lock. Implementations must
   * exclude generation invalidation until `mutation` settles.
   */
  withCurrentEvidence?<T>(evidence: LandingEvidenceV1,
    mutation: () => Promise<T>): Promise<T>;
};

export type ResolveLandingV1Data = {
  readonly decisionId: string;
  readonly outcome: "landed" | "absent" | "ambiguous" | "unavailable";
  readonly action: "resume-committed" | "retire-not-landed" | "none";
  readonly journalState: "COMMITTED" | "ROLLED_BACK" | "UNKNOWN";
  readonly inference: "landed" | "absent" | "ambiguous" | "unavailable";
  readonly resolutionId: string;
  readonly evidenceDigest: Hex | null;
  readonly evidenceRetainedUntil: string | null;
  readonly replayed: boolean;
};

export type ResolveLandingV1Result =
  | { readonly kind: "terminal"; readonly data: ResolveLandingV1Data;
      readonly completionRole: "terminalizer" | "refusal-winner" | "joiner" }
  | { readonly kind: "in-progress"; readonly decisionId: string;
      readonly resolutionId: string; readonly replayed: true };

export type ResolveLandingDeps = {
  readonly journal: ExecutionJournal;
  readonly sequences: LpSequenceStore;
  readonly evidenceStore: LpEvidenceStore;
  readonly evidenceProvider: LandingEvidenceProvider;
  readonly receipts: LpReceiptReader;
  readonly positions: LpPositionsReader;
  readonly now: () => number;
  readonly resolverLeaseMs: number;
  readonly finalizer?: LandingResolutionFinalizer;
};

export async function resolveUnknownLandingV1(input: {
  readonly decisionId: string;
  readonly row: JournalEntry;
  readonly sequence: LpSequenceRecord;
  readonly position: LpPositionRecord;
  readonly actionIdentity: ResolutionActionIdentity;
  readonly priorRows: readonly JournalEntry[];
  readonly deps: ResolveLandingDeps;
}): Promise<ResolveLandingV1Result> {
  const { row, sequence, position, deps } = input;
  if (sequence.steps.some(step => step.kind === "rotate-atomic")) {
    return unavailableWithoutBinding(input, "atomic-rotate-landing-resolution-unsupported");
  }
  const prepared = completePreparedIdentity(row);
  if (prepared === null || row.begunAtBlock === null || !deps.evidenceProvider.enabled) {
    return unavailableWithoutBinding(input, "prepared-identity-or-evidence-observer-unavailable");
  }
  if (row.state !== "UNKNOWN" && row.landingResolutionId === null) {
    return unavailableWithoutBinding(input, "target-journal-is-not-unknown");
  }
  const currentIndex = currentStepIndex(input.decisionId, sequence);
  const step = sequence.steps[currentIndex];
  if (step === undefined || step.journalIdempotencyKey !== row.idempotencyKey ||
      sequence.positionId !== position.positionId) {
    return unavailableWithoutBinding(input, "sequence-step-snapshot-mismatch");
  }
  const reservation = await deps.sequences.getReservation(
    row.ownerAddress as `0x${string}`, row.agentId, sequence.sequenceId,
  );
  const snapshotHash = sequence.state === "resolving" && sequence.resolverSnapshotHash !== null
    ? sequence.resolverSnapshotHash
    : landingSnapshotHash(sequence, position, input.priorRows, row, reservation);
  const target = { journalOwner: row.ownerAddress.toLowerCase(), journalAgent: row.agentId,
    journalAction: row.kind, journalIdempotencyKey: row.idempotencyKey };
  const resolutionKeyHash = landingResolutionKeyHash({
    target, preparedIdentityHash: prepared.hash,
  });
  const createInput = { target, preparedIdentityHash: prepared.hash,
    action: input.actionIdentity, originSequenceId: sequence.sequenceId,
    originSnapshotHash: snapshotHash } as const;
  let resolution: LandingResolution | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const joined = await deps.evidenceStore.createOrJoinResolution(createInput);
    try {
      await deps.journal.joinLandingAction({ idempotencyKey: input.actionIdentity.idempotencyKey,
        resolutionId: joined.resolution.resolutionId, resolutionKeyHash });
      resolution = joined.resolution;
      break;
    } catch (error) {
      if (await deps.evidenceStore.getResolution(joined.resolution.resolutionId) !== null ||
          attempt === 2) throw error;
      // A provisional refusal won between insert-or-select and the action-row
      // join. Its transaction removed the provisional row before this action
      // cited it, so retry the unique create/join instead of persisting a
      // dangling action reference.
    }
  }
  if (resolution === null) throw new Error("RESOLUTION_STATE_CONFLICT: resolution join failed.");
  assertTargetJournalTruth(row, resolution, resolutionKeyHash);
  if (resolution.phase === "terminal") {
    // Step 8 is one transaction in the durable implementation. Keeping this
    // exact repair also makes the Memory/Fake composition crash-safe: a
    // terminal tombstone is sufficient to fill the target journal's final
    // three fields, and performs no provider/evidence/position read.
    await repairTerminalJournal(row, resolution, deps.journal);
    return terminalData(input.decisionId, resolution, input.actionIdentity);
  }

  let claim = await claimOrReclaim(input, resolution, snapshotHash);
  if (claim === null) {
    return { kind: "in-progress", decisionId: input.decisionId,
      resolutionId: resolution.resolutionId, replayed: true };
  }

  if (resolution.phase === "claimed") {
    const requirementHash = requirementHashFor(target);
    let admission: Awaited<ReturnType<LandingEvidenceProvider["admission"]>>;
    try {
      admission = await deps.evidenceProvider.admission({
        begunAtBlock: row.begunAtBlock,
        preparedIdentity: prepared.identity,
        requirementKeyHash: requirementHash,
      });
    } catch (error) {
      return refuseAfterPreDispositionError(input, resolution, claim,
        "coverage-admission-unavailable", error);
    }
    if (admission === null) {
      return refuseProvisional(input, resolution, claim, "unavailable", "coverage-lane-unavailable");
    }
    let admitted: Awaited<ReturnType<LpEvidenceStore["admitRequirement"]>>;
    try {
      admitted = await deps.evidenceStore.admitRequirement({
        ...target, begunAtBlock: row.begunAtBlock, expiry: BigInt(prepared.identity.expiry),
        preparedIdentityHash: prepared.hash, coverageVersion: admission.coverageVersion,
        quorumId: admission.quorumId, laneId: admission.laneId,
        coverageGeneration: admission.generation ?? 0n,
      });
    } catch (error) {
      return refuseAfterPreDispositionError(input, resolution, claim,
        "coverage-requirement-unavailable", error);
    }
    if ("unavailable" in admitted) {
      return refuseProvisional(input, resolution, claim, "unavailable", admitted.unavailable);
    }
    if (admitted.state !== "eligible" || admitted.unavailableCode !== null ||
        (admitted.coverageGeneration ?? 0n) !== (admission.generation ?? 0n)) {
      return refuseProvisional(input, resolution, claim, "unavailable",
        admitted.unavailableCode ?? `coverage-requirement-${admitted.state}`);
    }
    let snapshot: LandingSnapshotDecision;
    try {
      snapshot = await deps.evidenceProvider.snapshot({ requirement: admitted,
        preparedIdentity: prepared.identity });
    } catch (error) {
      return refuseAfterPreDispositionError(input, resolution, claim,
        "coverage-snapshot-unavailable", error);
    }
    if (!("evidence" in snapshot)) {
      return refuseProvisional(input, resolution, claim, snapshot.outcome, snapshot.reason);
    }
    if (deps.finalizer !== undefined) {
      try {
        await deps.finalizer.bindEvidence({ owner: row.ownerAddress as `0x${string}`,
          agentId: row.agentId, positionId: position.positionId,
          sequenceId: sequence.sequenceId, resolutionId: resolution.resolutionId,
          resolverFence: claim.resolverFence,
          expectedResolverRowVersion: claim.resolverRowVersion,
          expectedResolutionRowVersion: resolution.rowVersion,
          evidence: snapshot.evidence, now: deps.now() });
      } catch (error) {
        return refuseAfterPreDispositionError(input, resolution, claim,
          "evidence-bind-unavailable", error);
      }
      const nextResolution = await deps.evidenceStore.getResolution(resolution.resolutionId);
      if (nextResolution === null) {
        throw new Error("RESOLUTION_STATE_CONFLICT: bound evidence state disappeared.");
      }
      resolution = nextResolution;
    } else {
      let bound: Awaited<ReturnType<LpEvidenceStore["bindEvidence"]>>;
      try {
        bound = await deps.evidenceStore.bindEvidence({ resolutionId: resolution.resolutionId,
          expectedRowVersion: resolution.rowVersion, evidence: snapshot.evidence });
      } catch (error) {
        return refuseAfterPreDispositionError(input, resolution, claim,
          "evidence-bind-unavailable", error);
      }
      resolution = bound.resolution;
    }
  }

  const evidence = await evidenceForResolution(deps.evidenceStore, resolution);
  if (evidence === null || !(await deps.evidenceProvider.validateStored(evidence))) {
    if (!claim.resolutionDispositionStarted) {
      return refuseProvisional(input, resolution, claim, "ambiguous",
        "stored-evidence-invalidated", evidence ?? undefined);
    }
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated.");
  }
  if (deps.finalizer === undefined && deps.evidenceProvider.withCurrentEvidence === undefined) {
    // The old Memory composition sampled coverage and mutated three separate
    // stores afterwards. Refuse before the first disposition write unless the
    // provider can fence invalidation for the whole mutation callback.
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated or has no atomic citation fence.");
  }

  if (resolution.phase === "evidence-bound") {
    if (deps.finalizer !== undefined) {
      await assertDispositionEvidenceCurrent(deps, evidence);
      await deps.finalizer.beginDisposition({ owner: row.ownerAddress as `0x${string}`,
        agentId: row.agentId, positionId: position.positionId,
        sequenceId: sequence.sequenceId, resolutionId: resolution.resolutionId,
        resolverFence: claim.resolverFence,
        expectedResolverRowVersion: claim.resolverRowVersion,
        expectedResolutionRowVersion: resolution.rowVersion,
        evidence, now: deps.now() });
      const [nextClaim, nextResolution] = await Promise.all([
        deps.sequences.getSequence(row.ownerAddress as `0x${string}`, row.agentId,
          sequence.sequenceId),
        deps.evidenceStore.getResolution(resolution.resolutionId),
      ]);
      if (nextClaim === null || nextResolution === null) {
        throw new Error("RESOLUTION_STATE_CONFLICT: disposition state disappeared.");
      }
      claim = nextClaim;
      resolution = nextResolution;
    } else {
      const phaseResolution = resolution; const phaseClaim = claim;
      const begun = await withCurrentDispositionEvidence(deps, evidence, async () => {
        const sequenceBegun = await deps.sequences.beginSequenceLandingDisposition(
          row.ownerAddress as `0x${string}`, row.agentId, sequence.sequenceId,
          phaseResolution.resolutionId, phaseClaim.resolverFence, phaseClaim.resolverRowVersion,
        );
        if (sequenceBegun === null) {
          throw new Error("RESOLUTION_STATE_CONFLICT: disposition fence lost.");
        }
        const nextResolution = await deps.evidenceStore.advanceResolution({
          resolutionId: phaseResolution.resolutionId,
          expectedRowVersion: phaseResolution.rowVersion,
          expectedPhase: "evidence-bound", phase: "disposition-started",
        });
        return { sequence: sequenceBegun, resolution: nextResolution };
      });
      claim = begun.sequence;
      resolution = begun.resolution;
    }
  }

  const disposition = landingDispositionFor(sequence, currentIndex, evidence.outcome);
  if (resolution.phase === "disposition-started") {
    if (deps.finalizer !== undefined) {
      await assertDispositionEvidenceCurrent(deps, evidence);
      await deps.finalizer.writeJournalDisposition({ owner: row.ownerAddress as `0x${string}`,
        agentId: row.agentId, positionId: position.positionId,
        sequenceId: sequence.sequenceId, resolutionId: resolution.resolutionId,
        resolverFence: claim.resolverFence,
        expectedResolverRowVersion: claim.resolverRowVersion,
        expectedResolutionRowVersion: resolution.rowVersion,
        journalIdempotencyKey: row.idempotencyKey, resolutionKeyHash,
        outcome: evidence.outcome,
        ...(evidence.landed === undefined ? {} : { txHash: evidence.landed.txHash }),
        now: deps.now() });
      const nextResolution = await deps.evidenceStore.getResolution(resolution.resolutionId);
      if (nextResolution === null) {
        throw new Error("RESOLUTION_STATE_CONFLICT: journal disposition state disappeared.");
      }
      resolution = nextResolution;
    } else {
      const phaseResolution = resolution;
      resolution = await withCurrentDispositionEvidence(deps, evidence, async () => {
        await deps.journal.reserveLandingDisposition({ idempotencyKey: row.idempotencyKey,
          resolutionId: phaseResolution.resolutionId, resolutionKeyHash,
          outcome: evidence.outcome,
          ...(evidence.landed === undefined ? {} : { txHash: evidence.landed.txHash }) });
        return deps.evidenceStore.advanceResolution({
          resolutionId: phaseResolution.resolutionId,
          expectedRowVersion: phaseResolution.rowVersion,
          expectedPhase: "disposition-started", phase: "journal-written",
          outcome: evidence.outcome,
          targetJournalTerminalState: evidence.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK",
          responseAction: evidence.outcome === "landed" ? "resume-committed" : "retire-not-landed",
        });
      });
    }
  }

  if (resolution.phase === "journal-written") {
    if (deps.finalizer !== undefined) {
      await assertDispositionEvidenceCurrent(deps, evidence);
      await deps.finalizer.writeRecovery({ owner: row.ownerAddress as `0x${string}`,
        agentId: row.agentId, positionId: position.positionId,
        sequenceId: sequence.sequenceId, resolutionId: resolution.resolutionId,
        resolverFence: claim.resolverFence,
        expectedResolverRowVersion: claim.resolverRowVersion,
        expectedResolutionRowVersion: resolution.rowVersion,
        journalIdempotencyKey: row.idempotencyKey, resolutionKeyHash,
        outcome: evidence.outcome, recoveryState: disposition.recovery,
        note: disposition.note, now: deps.now() });
      const [nextClaim, nextResolution] = await Promise.all([
        deps.sequences.getSequence(row.ownerAddress as `0x${string}`, row.agentId,
          sequence.sequenceId),
        deps.evidenceStore.getResolution(resolution.resolutionId),
      ]);
      if (nextClaim === null || nextResolution === null) {
        throw new Error("RESOLUTION_STATE_CONFLICT: recovery state disappeared.");
      }
      claim = nextClaim;
      resolution = nextResolution;
    } else {
      const phaseResolution = resolution; const phaseClaim = claim;
      const recovered = await withCurrentDispositionEvidence(deps, evidence, async () => {
        const nextSequence = await deps.sequences.setSequenceLandingRecovery(
          row.ownerAddress as `0x${string}`, row.agentId, sequence.sequenceId,
          { resolutionId: phaseResolution.resolutionId, fence: phaseClaim.resolverFence,
            expectedResolverRowVersion: phaseClaim.resolverRowVersion,
            recoveryState: disposition.recovery, note: disposition.note },
        );
        if (nextSequence === null) {
          throw new Error("RESOLUTION_STATE_CONFLICT: recovery fence lost.");
        }
        const nextResolution = await deps.evidenceStore.advanceResolution({
          resolutionId: phaseResolution.resolutionId,
          expectedRowVersion: phaseResolution.rowVersion,
          expectedPhase: "journal-written", phase: "recovery-written",
          recoveryAfterConfirm: disposition.recovery,
        });
        return { sequence: nextSequence, resolution: nextResolution };
      });
      claim = recovered.sequence;
      resolution = recovered.resolution;
    }
  }

  if (resolution.phase === "recovery-written") {
    if (deps.finalizer !== undefined) {
      await assertDispositionEvidenceCurrent(deps, evidence);
      const processed = await postProcessProvenLandedLpStep({ ...input, resolution,
        sequence: claim, position, currentIndex, evidence, disposition });
      claim = processed.sequence;
      const nextResolution = await deps.evidenceStore.getResolution(resolution.resolutionId);
      if (nextResolution === null) {
        throw new Error("RESOLUTION_STATE_CONFLICT: post-process state disappeared.");
      }
      resolution = nextResolution;
    } else {
      const phaseResolution = resolution; const phaseClaim = claim;
      const processed = await withCurrentDispositionEvidence(deps, evidence, async () => {
        const postprocessed = await postProcessProvenLandedLpStep({ ...input,
          resolution: phaseResolution, sequence: phaseClaim,
          position, currentIndex, evidence, disposition });
        const nextResolution = await deps.evidenceStore.advanceResolution({
          resolutionId: phaseResolution.resolutionId,
          expectedRowVersion: phaseResolution.rowVersion,
          expectedPhase: "recovery-written", phase: "postprocessed",
        });
        return { sequence: postprocessed.sequence, resolution: nextResolution };
      });
      claim = processed.sequence;
      resolution = processed.resolution;
    }
  }

  if (resolution.phase === "postprocessed") {
    if (deps.finalizer !== undefined) {
      await assertDispositionEvidenceCurrent(deps, evidence);
      await deps.finalizer.finalize({ decisionId: input.decisionId,
        owner: row.ownerAddress as `0x${string}`,
        agentId: row.agentId, positionId: position.positionId,
        sequenceId: sequence.sequenceId, resolutionId: resolution.resolutionId,
        resolverFence: claim.resolverFence,
        expectedResolverRowVersion: claim.resolverRowVersion,
        expectedResolutionRowVersion: resolution.rowVersion,
        targetSequenceState: evidence.outcome === "landed" ? "active" : "rolled-back",
        journalIdempotencyKey: row.idempotencyKey, resolutionKeyHash,
        outcome: evidence.outcome, evidenceHash: evidence.evidenceDigest,
        terminalizingAction: input.actionIdentity, now: deps.now() });
      const terminal = await deps.evidenceStore.getResolution(resolution.resolutionId);
      if (terminal === null) throw new Error("RESOLUTION_STATE_CONFLICT: terminal row disappeared.");
      resolution = terminal;
    } else {
      // Production PostgreSQL uses LandingResolutionFinalizer. The Memory
      // composition snapshots all three mutable stores and rolls every one
      // back on failure. Sequence release is deliberately LAST: no worker can
      // observe an ACTIVE/terminal sequence until the permanent resolution,
      // target journal and initiating action are all durable.
      const phaseResolution = resolution; const phaseClaim = claim;
      resolution = await withCurrentDispositionEvidence(deps, evidence, async () => {
        return withMemoryLandingTerminalTransaction(deps, {
          targetJournalKey: row.idempotencyKey,
          actionJournalKey: input.actionIdentity.idempotencyKey,
          resolutionId: phaseResolution.resolutionId,
          positionId: position.positionId,
          sequenceId: sequence.sequenceId,
        }, async () => {
          const terminal = await deps.evidenceStore.terminalize({
            resolutionId: phaseResolution.resolutionId,
            expectedRowVersion: phaseResolution.rowVersion,
            terminalizingAction: input.actionIdentity,
          });
          if (terminal.terminalAt === null || terminal.evidenceHash === null) {
            throw new Error("Resolution terminal row is incomplete.");
          }
          await deps.journal.finalizeLandingDisposition({ idempotencyKey: row.idempotencyKey,
            resolutionId: terminal.resolutionId, resolutionKeyHash, outcome: evidence.outcome,
            evidenceHash: terminal.evidenceHash, terminalAt: terminal.terminalAt });
          const terminalResult = terminalData(input.decisionId, terminal, input.actionIdentity);
          if (terminalResult.kind !== "terminal") {
            throw new Error("Resolution terminal response is incomplete.");
          }
          await deps.journal.completeLandingAction(input.actionIdentity.idempotencyKey, {
            landingAction: { scheme: "resolve-landing-action-v1",
              resolutionId: terminal.resolutionId, state: "TERMINAL",
              completionRole: terminalResult.completionRole },
            landingResult: terminalResult.data,
          });
          const finished = await deps.sequences.finishSequenceLandingResolution(
            row.ownerAddress as `0x${string}`, row.agentId, sequence.sequenceId,
            { resolutionId: phaseResolution.resolutionId, fence: phaseClaim.resolverFence,
              expectedResolverRowVersion: phaseClaim.resolverRowVersion,
              targetState: evidence.outcome === "landed" ? "active" : "rolled-back" },
          );
          if (finished === null) {
            throw new Error("RESOLUTION_STATE_CONFLICT: terminal fence lost.");
          }
          return terminal;
        });
      });
    }
  }
  return terminalData(input.decisionId, resolution, input.actionIdentity);
}

async function assertDispositionEvidenceCurrent(
  deps: ResolveLandingDeps,
  evidence: LandingEvidenceV1,
): Promise<void> {
  if (!(await deps.evidenceProvider.validateStored(evidence))) {
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated.");
  }
}

async function withCurrentDispositionEvidence<T>(
  deps: ResolveLandingDeps,
  evidence: LandingEvidenceV1,
  mutation: () => Promise<T>,
): Promise<T> {
  const atomic = deps.evidenceProvider.withCurrentEvidence;
  if (atomic === undefined) {
    throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated or has no atomic citation fence.");
  }
  return atomic(evidence, mutation);
}

async function withMemoryLandingTerminalTransaction<T>(
  deps: ResolveLandingDeps,
  scope: { readonly targetJournalKey: string; readonly actionJournalKey: string;
    readonly resolutionId: string; readonly positionId: string; readonly sequenceId: string },
  mutation: () => Promise<T>,
): Promise<T> {
  const journalSnapshotter = deps.journal.snapshotLandingResolutionTransaction;
  const journalRestorer = deps.journal.restoreLandingResolutionTransaction;
  const evidenceSnapshotter = deps.evidenceStore.snapshotLandingResolutionTransaction;
  const evidenceRestorer = deps.evidenceStore.restoreLandingResolutionTransaction;
  const sequenceSnapshotter = deps.sequences.snapshotLandingResolutionTransaction;
  const sequenceRestorer = deps.sequences.restoreLandingResolutionTransaction;
  if (journalSnapshotter === undefined || journalRestorer === undefined ||
      evidenceSnapshotter === undefined || evidenceRestorer === undefined ||
      sequenceSnapshotter === undefined || sequenceRestorer === undefined) {
    throw new Error("RESOLUTION_STATE_CONFLICT: no atomic Memory terminal transaction.");
  }
  const journalSnapshot = journalSnapshotter.call(deps.journal,
    [scope.targetJournalKey, scope.actionJournalKey]);
  const evidenceSnapshot = evidenceSnapshotter.call(deps.evidenceStore, scope.resolutionId);
  const sequenceSnapshot = sequenceSnapshotter.call(deps.sequences,
    { positionId: scope.positionId, sequenceId: scope.sequenceId });
  try {
    return await mutation();
  } catch (error) {
    sequenceRestorer.call(deps.sequences, sequenceSnapshot);
    evidenceRestorer.call(deps.evidenceStore, evidenceSnapshot);
    journalRestorer.call(deps.journal, journalSnapshot);
    throw error;
  }
}

async function refuseAfterPreDispositionError(
  input: Parameters<typeof resolveUnknownLandingV1>[0],
  resolution: LandingResolution,
  claim: LpSequenceRecord,
  reason: string,
  error: unknown,
): Promise<ResolveLandingV1Result> {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("RESOLUTION_STATE_CONFLICT") ||
      message.includes("LP_EVIDENCE_LEASE_CONFLICT") ||
      message.includes("LP_EVIDENCE_CURSOR_CONFLICT")) throw error;
  // The refusal transaction is the repair: if the underlying durable store is
  // unavailable it also fails, leaving the fenced sequence non-runnable for a
  // signed reclaim instead of guessing an origin state.
  return refuseProvisional(input, resolution, claim, "unavailable", reason);
}

async function repairTerminalJournal(
  row: JournalEntry,
  resolution: LandingResolution,
  journal: ExecutionJournal,
): Promise<void> {
  if (resolution.phase !== "terminal" || resolution.outcome === null ||
      resolution.evidenceHash === null || resolution.terminalAt === null) {
    throw new Error("RESOLUTION_STATE_CONFLICT: terminal resolution is incomplete.");
  }
  const resolutionKeyHash = landingResolutionKeyHash({
    target: resolution.target,
    preparedIdentityHash: resolution.preparedIdentityHash,
  });
  await journal.finalizeLandingDisposition({
    idempotencyKey: row.idempotencyKey,
    resolutionId: resolution.resolutionId,
    resolutionKeyHash,
    outcome: resolution.outcome,
    evidenceHash: resolution.evidenceHash,
    terminalAt: resolution.terminalAt,
  });
}

function completePreparedIdentity(row: JournalEntry): {
  readonly identity: PreparedIntentIdentityV1; readonly hash: Hex;
} | null {
  if (row.preparedIntentIdentity === null || row.preparedIntentIdentityHash === null ||
      row.finalCallsFingerprint === null || row.finalCallsFingerprintHash === null) return null;
  try {
    const identity = parsePreparedIntentIdentityV1(row.preparedIntentIdentity);
    if (keccak256(stringToHex(row.preparedIntentIdentity)) !== row.preparedIntentIdentityHash) return null;
    return { identity, hash: row.preparedIntentIdentityHash };
  } catch { return null; }
}

function currentStepIndex(decisionId: string, sequence: LpSequenceRecord): number {
  const suffix = decisionId.split(":").at(-1);
  const index = suffix === undefined ? -1 : Number.parseInt(suffix, 10);
  return Number.isSafeInteger(index) && index >= 0 && index < sequence.steps.length ? index : -1;
}

export function landingSnapshotHash(
  sequence: LpSequenceRecord,
  position: LpPositionRecord,
  priorRows: readonly JournalEntry[],
  current: JournalEntry,
  reservation: LpExitReservation | null = null,
): Hex {
  const bytes = JSON.stringify({
    sequence: { id: sequence.sequenceId, owner: sequence.ownerAddress, agent: sequence.agentId,
      positionId: sequence.positionId, kind: sequence.kind, state: sequence.state,
      recovery: sequence.recoveryState, steps: sequence.steps, note: sequence.note,
      resolverPriorState: sequence.resolverPriorState,
      resolverPriorRecoveryState: sequence.resolverPriorRecoveryState,
      resolverFence: sequence.resolverFence.toString(10),
      resolverLeaseUntil: sequence.resolverLeaseUntil,
      resolverSnapshotHash: sequence.resolverSnapshotHash,
      resolverRowVersion: sequence.resolverRowVersion, resolutionId: sequence.resolutionId,
      resolverActionIdempotencyKey: sequence.resolverActionIdempotencyKey,
      resolutionDispositionStarted: sequence.resolutionDispositionStarted,
      createdAt: sequence.createdAt, updatedAt: sequence.updatedAt },
    position: { id: position.positionId, owner: position.ownerAddress, agent: position.agentId,
      token0: position.token0, token1: position.token1, fee: position.fee,
      tokenId: position.tokenId, lineageId: position.lineageId,
      state: position.state, basisWei: position.basisWei.toString(10),
      basisSource: position.basisSource, quoteToken: position.quoteToken,
      ownershipMismatchCount: position.ownershipMismatchCount,
      ownershipLostReason: position.ownershipLostReason,
      ownershipFirstSeenAtMs: position.ownershipFirstSeenAtMs,
      rowVersion: position.rowVersion, createdAt: position.createdAt, updatedAt: position.updatedAt },
    journals: [...priorRows, current].map((entry) => ({ key: entry.idempotencyKey,
      owner: entry.ownerAddress, agent: entry.agentId, kind: entry.kind,
      decisionId: entry.decisionId, state: entry.state,
      callsHash: entry.externalRef.callsHash ?? null,
      txHash: entry.externalRef.txHash ?? null, nativeSpendWei: entry.nativeSpendWei.toString(10),
      begunAtBlock: entry.begunAtBlock?.toString(10) ?? null,
      finalCallsFingerprintHash: entry.finalCallsFingerprintHash,
      preparedIntentIdentityHash: entry.preparedIntentIdentityHash,
      landingResolutionId: entry.landingResolutionId,
      landingResolutionOutcome: entry.landingResolutionOutcome,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt })),
    reservation: reservation === null ? null : { sequenceId: reservation.sequenceId,
      owner: reservation.ownerAddress, agent: reservation.agentId, kind: reservation.kind,
      quotaBound: reservation.quotaBound, reservedAt: reservation.reservedAt,
      releasedAt: reservation.releasedAt },
  });
  return keccak256(stringToHex(bytes));
}

async function claimOrReclaim(
  input: Parameters<typeof resolveUnknownLandingV1>[0],
  resolution: LandingResolution,
  snapshotHash: Hex,
): Promise<LpSequenceRecord | null> {
  const { sequence, position, row, deps } = input;
  const now = deps.now();
  if (sequence.state === "resolving") {
    if (sequence.resolutionId !== resolution.resolutionId ||
        sequence.resolverSnapshotHash !== snapshotHash || sequence.resolverLeaseUntil === null ||
        sequence.resolverLeaseUntil > now) return null;
    return deps.sequences.reclaimSequenceLandingResolution(
      row.ownerAddress as `0x${string}`, row.agentId, sequence.sequenceId,
      { resolutionId: resolution.resolutionId, expectedFence: sequence.resolverFence,
        expectedResolverRowVersion: sequence.resolverRowVersion,
        actionIdempotencyKey: input.actionIdentity.idempotencyKey, snapshotHash, nowMs: now,
        leaseUntilMs: now + deps.resolverLeaseMs },
    );
  }
  if (sequence.state !== "active" && sequence.state !== "held") return null;
  return deps.sequences.claimSequenceForLandingResolution(
    row.ownerAddress as `0x${string}`, row.agentId, sequence.sequenceId,
    { expectedState: sequence.state, expectedRecoveryState: sequence.recoveryState,
      expectedUpdatedAt: sequence.updatedAt, expectedPositionId: position.positionId,
      expectedPositionVersion: position.rowVersion,
      expectedResolverRowVersion: sequence.resolverRowVersion,
      resolutionId: resolution.resolutionId,
      actionIdempotencyKey: input.actionIdentity.idempotencyKey,
      snapshotHash, leaseUntilMs: now + deps.resolverLeaseMs },
  );
}

function requirementHashFor(target: {
  readonly journalOwner: string; readonly journalAgent: string;
  readonly journalAction: string; readonly journalIdempotencyKey: string;
}): Hex {
  return evidenceRequirementKeyHash(target);
}

async function refuseProvisional(
  input: Parameters<typeof resolveUnknownLandingV1>[0],
  resolution: LandingResolution,
  claim: LpSequenceRecord,
  outcome: "ambiguous" | "unavailable",
  _reason: string,
  evidence?: LandingEvidenceV1,
): Promise<ResolveLandingV1Result> {
  if (input.deps.finalizer !== undefined) {
    const target = { journalOwner: input.row.ownerAddress.toLowerCase(),
      journalAgent: input.row.agentId, journalAction: input.row.kind,
      journalIdempotencyKey: input.row.idempotencyKey };
    await input.deps.finalizer.refuseProvisional({
      owner: input.row.ownerAddress as `0x${string}`, agentId: input.row.agentId,
      positionId: input.position.positionId, sequenceId: input.sequence.sequenceId,
      resolutionId: resolution.resolutionId, resolverFence: claim.resolverFence,
      expectedResolverRowVersion: claim.resolverRowVersion,
      expectedResolutionRowVersion: resolution.rowVersion,
      resolutionKeyHash: landingResolutionKeyHash({ target,
        preparedIdentityHash: resolution.preparedIdentityHash }),
      actionIdempotencyKey: input.actionIdentity.idempotencyKey,
      decisionId: input.decisionId, outcome, ...(evidence === undefined ? {} : { evidence }),
      now: input.deps.now(),
    });
    return { kind: "terminal", completionRole: "refusal-winner", data: {
      decisionId: input.decisionId, outcome, action: "none", journalState: "UNKNOWN",
      inference: outcome, resolutionId: resolution.resolutionId, evidenceDigest: null,
      evidenceRetainedUntil: null, replayed: false,
    } };
  }
  const released = await input.deps.sequences.releaseSequenceLandingResolution(
    input.row.ownerAddress as `0x${string}`, input.row.agentId, input.sequence.sequenceId,
    resolution.resolutionId, claim.resolverFence, claim.resolverRowVersion,
  );
  if (released === null) throw new Error("RESOLUTION_STATE_CONFLICT: provisional restore failed.");
  await input.deps.evidenceStore.releaseProvisional(resolution.resolutionId, resolution.rowVersion);
  return { kind: "terminal", completionRole: "refusal-winner", data: {
    decisionId: input.decisionId, outcome, action: "none",
    journalState: "UNKNOWN", inference: outcome, resolutionId: resolution.resolutionId,
    evidenceDigest: null, evidenceRetainedUntil: null, replayed: false } };
}

function unavailableWithoutBinding(
  input: Parameters<typeof resolveUnknownLandingV1>[0],
  reason: string,
): ResolveLandingV1Result {
  const id = `lp-landing:${keccak256(stringToHex(`${input.row.idempotencyKey}:${reason}`)).slice(2)}`;
  return { kind: "terminal", completionRole: "refusal-winner", data: {
    decisionId: input.decisionId, outcome: "unavailable",
    action: "none", journalState: input.row.state === "UNKNOWN" ? "UNKNOWN" :
      input.row.state === "COMMITTED" ? "COMMITTED" : "ROLLED_BACK",
    inference: "unavailable", resolutionId: id, evidenceDigest: null,
    evidenceRetainedUntil: null, replayed: false } };
}

function terminalData(
  decisionId: string,
  resolution: LandingResolution,
  action: ResolutionActionIdentity,
): ResolveLandingV1Result {
  if (resolution.phase !== "terminal" || resolution.outcome === null ||
      resolution.targetJournalTerminalState === null || resolution.responseAction === null) {
    throw new Error("Resolution is not terminal.");
  }
  const replayed = !sameAction(resolution.terminalizingAction, action);
  return { kind: "terminal", completionRole: replayed ? "joiner" : "terminalizer",
    data: { decisionId, outcome: resolution.outcome,
    action: resolution.responseAction, journalState: resolution.targetJournalTerminalState,
    inference: resolution.outcome, resolutionId: resolution.resolutionId,
    evidenceDigest: resolution.evidenceHash,
    evidenceRetainedUntil: resolution.evidenceRetainedUntil === null ? null :
      new Date(resolution.evidenceRetainedUntil).toISOString(),
    replayed } };
}

function sameAction(left: ResolutionActionIdentity | null, right: ResolutionActionIdentity): boolean {
  return left !== null && left.owner === right.owner && left.agent === right.agent &&
    left.kind === right.kind && left.idempotencyKey === right.idempotencyKey;
}

export function assertTargetJournalTruth(
  row: JournalEntry,
  resolution: LandingResolution,
  resolutionKeyHash: Hex,
): void {
  const allNull = row.landingResolutionId === null && row.landingResolutionKeyHash === null &&
    row.landingResolutionOutcome === null && row.landingResolutionEvidenceHash === null &&
    row.landingResolutionTerminalAt === null;
  const partial = row.landingResolutionId === resolution.resolutionId &&
    row.landingResolutionKeyHash === resolutionKeyHash &&
    row.landingResolutionOutcome === null && row.landingResolutionEvidenceHash === null &&
    row.landingResolutionTerminalAt === null;
  const expectedState = resolution.outcome === "landed" ? "COMMITTED" : "ROLLED_BACK";
  if (resolution.phase === "claimed" || resolution.phase === "evidence-bound" ||
      resolution.phase === "disposition-started") {
    if (row.state !== "UNKNOWN" || !allNull) {
      throw new Error("RESOLUTION_STATE_CONFLICT: pre-disposition journal truth is invalid.");
    }
    return;
  }
  if (resolution.phase === "journal-written" || resolution.phase === "recovery-written" ||
      resolution.phase === "postprocessed") {
    if (resolution.outcome === null || row.state !== expectedState || !partial) {
      throw new Error("RESOLUTION_STATE_CONFLICT: reserved journal truth is invalid.");
    }
    return;
  }
  const full = partial === false && row.landingResolutionId === resolution.resolutionId &&
    row.landingResolutionKeyHash === resolutionKeyHash &&
    row.landingResolutionOutcome === resolution.outcome &&
    row.landingResolutionEvidenceHash === resolution.evidenceHash &&
    row.landingResolutionTerminalAt === resolution.terminalAt;
  if (resolution.phase !== "terminal" || resolution.outcome === null ||
      row.state !== expectedState || !full) {
    throw new Error("RESOLUTION_STATE_CONFLICT: terminal journal truth is invalid.");
  }
}

async function evidenceForResolution(
  store: LpEvidenceStore,
  resolution: LandingResolution,
): Promise<LandingEvidenceV1 | null> {
  return store.getResolutionEvidence(resolution.resolutionId);
}

export type LandingDisposition = {
  // Atomic rotate is excluded before binding and has no landing disposition.
  readonly recovery: Exclude<LpRecoveryState, "rotate-ambiguous">;
  readonly note: string;
  readonly position: "none" | "open" | "close" | "attach-token";
};

export function landingDispositionFor(
  sequence: Pick<LpSequenceRecord, "kind">,
  step: number,
  outcome: "landed" | "absent",
): LandingDisposition {
  const key = `${sequence.kind}:${step}:${outcome}`;
  const table: Record<string, LandingDisposition> = {
    "open:0:landed": { recovery: "none", note: "landing-evidence:landed:open-mint", position: "attach-token" },
    "rotate:0:landed": { recovery: "pending-mint", note: "landing-evidence:landed:rotate-zap-out", position: "none" },
    "rotate:1:landed": { recovery: "wbnb-stranded", note: "landing-evidence:landed:rotate-sweep", position: "none" },
    "rotate:2:landed": { recovery: "none", note: "landing-evidence:landed:rotate-mint", position: "attach-token" },
    "harvest:0:landed": { recovery: "pending-increase", note: "landing-evidence:landed:harvest-collect", position: "none" },
    "harvest:1:landed": { recovery: "wbnb-stranded", note: "landing-evidence:landed:harvest-sweep", position: "none" },
    "harvest:2:landed": { recovery: "none", note: "landing-evidence:landed:harvest-increase", position: "none" },
    "protect:0:landed": { recovery: "none", note: "landing-evidence:landed:protect-zap-out", position: "close" },
    "protect:1:landed": { recovery: "none", note: "landing-evidence:landed:protect-sweep", position: "close" },
    "manual-exit:0:landed": { recovery: "none", note: "landing-evidence:landed:manual-zap-out", position: "close" },
    "manual-exit:1:landed": { recovery: "none", note: "landing-evidence:landed:manual-sweep", position: "close" },
    "open:0:absent": { recovery: "none", note: "not-landed:open-mint", position: "close" },
    "rotate:0:absent": { recovery: "none", note: "not-landed:rotate-zap-out;original-open", position: "open" },
    "rotate:1:absent": { recovery: "none", note: "not-landed:rotate-sweep;principal-in-wallet", position: "close" },
    "rotate:2:absent": { recovery: "none", note: "not-landed:rotate-mint;no-new-nft", position: "close" },
    "harvest:0:absent": { recovery: "none", note: "not-landed:harvest-collect;position-open", position: "none" },
    "harvest:1:absent": { recovery: "none", note: "not-landed:harvest-sweep;fees-in-wallet", position: "none" },
    "harvest:2:absent": { recovery: "none", note: "not-landed:harvest-increase;proceeds-in-wallet", position: "none" },
    "protect:0:absent": { recovery: "none", note: "not-landed:protect-zap-out;restored-open", position: "open" },
    "protect:1:absent": { recovery: "none", note: "not-landed:protect-sweep;conversion-missing", position: "close" },
    "manual-exit:0:absent": { recovery: "none", note: "not-landed:manual-zap-out;restored-open", position: "open" },
    "manual-exit:1:absent": { recovery: "none", note: "not-landed:manual-sweep;conversion-missing", position: "close" },
  };
  const disposition = table[key];
  if (disposition === undefined) throw new Error(`Unsupported landing disposition ${key}.`);
  return disposition;
}

export async function postProcessProvenLandedLpStep(input: {
  readonly row: JournalEntry; readonly sequence: LpSequenceRecord;
  readonly position: LpPositionRecord; readonly resolution: LandingResolution;
  readonly priorRows: readonly JournalEntry[];
  readonly currentIndex: number; readonly evidence: LandingEvidenceV1;
  readonly disposition: LandingDisposition; readonly deps: ResolveLandingDeps;
}): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord;
  readonly carriedAmounts?: { readonly wbnbWei: bigint; readonly tokenWei: bigint } }> {
  let position = input.position;
  let sequence = input.sequence;
  let positionMutation: "none" | "open" | "close" | "attach-token" = "none";
  let attachedTokenId: string | undefined;
  const carriedAmounts = input.evidence.outcome === "landed" &&
      (input.sequence.kind === "rotate" || input.sequence.kind === "harvest")
    ? await reconstructCarriedAmounts(input)
    : undefined;
  const evidenceBlock = BigInt(input.evidence.toBlock);
  if (input.evidence.outcome === "landed" && input.evidence.landed !== undefined) {
    const txHash = input.evidence.landed.txHash;
    if (input.disposition.position === "attach-token") {
      if (input.sequence.kind === "open" && input.position.tokenId !== null) {
        throw new Error("Landed open mint cannot replace an existing position token.");
      }
      const tokenId = await input.deps.receipts.mintedTokenId(txHash);
      const onChain = await input.deps.positions(tokenId, evidenceBlock, input.evidence.toBlockHash);
      if (onChain === "burned" || onChain.liquidity <= 0n) {
        throw new Error("Landed mint has no finalized liquidity.");
      }
      if (input.deps.finalizer !== undefined) {
        positionMutation = "attach-token";
        attachedTokenId = tokenId.toString(10);
      } else {
        const changed = await input.deps.sequences.updatePositionTokenIdForLanding(
          input.row.ownerAddress as `0x${string}`, input.row.agentId, position.positionId,
          { sequenceId: sequence.sequenceId, resolutionId: input.resolution.resolutionId,
            fence: sequence.resolverFence, expectedResolverRowVersion: sequence.resolverRowVersion,
            expectedPositionVersion: position.rowVersion, tokenId: tokenId.toString(10) },
        );
        if (changed === null) throw new Error("Landed token attachment fence conflict.");
        ({ position, sequence } = changed);
      }
    } else if ((input.sequence.kind === "rotate" || input.sequence.kind === "protect" ||
        input.sequence.kind === "manual-exit") && input.currentIndex === 0 &&
        position.tokenId !== null) {
      const onChain = await input.deps.positions(BigInt(position.tokenId), evidenceBlock,
        input.evidence.toBlockHash);
      if (onChain !== "burned" && onChain.liquidity > 0n) {
        throw new Error("Landed exit still has finalized liquidity.");
      }
      if (input.sequence.kind === "protect" || input.sequence.kind === "manual-exit") {
        // The exit saga's current verifier reads this receipt even though its
        // amounts do not feed a later resolver mutation. Preserve that exact
        // positive post-condition instead of treating a successful intent as
        // a substitute for the receipt-derived collect.
        await input.deps.receipts.collectAmounts(txHash);
      }
    } else if (input.sequence.kind === "harvest" && input.currentIndex === 0 &&
        position.tokenId !== null) {
      const onChain = await input.deps.positions(BigInt(position.tokenId), evidenceBlock,
        input.evidence.toBlockHash);
      if (onChain === "burned") throw new Error("Landed harvest collect has a burned position.");
    } else if (input.sequence.kind === "harvest" && input.currentIndex === 2 &&
        position.tokenId !== null) {
      const onChain = await input.deps.positions(BigInt(position.tokenId), evidenceBlock,
        input.evidence.toBlockHash);
      if (onChain === "burned" || onChain.liquidity <= 0n) {
        throw new Error("Landed harvest increase has no finalized liquidity.");
      }
    }
  }
  if (input.disposition.position === "close" && position.state !== "closed") {
    if (input.deps.finalizer !== undefined) positionMutation = "close";
    else {
      const changed = await input.deps.sequences.setPositionStateForLanding(
        input.row.ownerAddress as `0x${string}`, input.row.agentId, position.positionId,
        { sequenceId: sequence.sequenceId, resolutionId: input.resolution.resolutionId,
          fence: sequence.resolverFence, expectedResolverRowVersion: sequence.resolverRowVersion,
          expectedPositionVersion: position.rowVersion, state: "closed" },
      );
      if (changed === null) throw new Error("Landing close fence conflict.");
      ({ position, sequence } = changed);
    }
  } else if (input.disposition.position === "open" && position.state !== "open") {
    if (input.deps.finalizer !== undefined) positionMutation = "open";
    else {
      const changed = await input.deps.sequences.setPositionStateForLanding(
        input.row.ownerAddress as `0x${string}`, input.row.agentId, position.positionId,
        { sequenceId: sequence.sequenceId, resolutionId: input.resolution.resolutionId,
          fence: sequence.resolverFence, expectedResolverRowVersion: sequence.resolverRowVersion,
          expectedPositionVersion: position.rowVersion, state: "open" },
      );
      if (changed === null) throw new Error("Landing restore fence conflict.");
      ({ position, sequence } = changed);
    }
  }
  const releaseReservation = input.evidence.outcome === "absent" &&
    absentDispositionReleasesReservation(input.sequence, input.currentIndex, input.priorRows);
  if (releaseReservation && input.deps.finalizer === undefined) {
    // Reservation release is an accounting write, not cleanup. Failure leaves
    // the fenced sequence resolving so step 7 retries before the sequence can
    // become terminal. `releaseReservation` is itself idempotent.
    await input.deps.sequences.releaseReservation(
      input.row.ownerAddress as `0x${string}`,
      input.row.agentId,
      input.sequence.sequenceId,
    );
  }
  if (input.deps.finalizer !== undefined) {
    const resolutionKeyHash = landingResolutionKeyHash({ target: input.resolution.target,
      preparedIdentityHash: input.resolution.preparedIdentityHash });
    await input.deps.finalizer.postprocess({ owner: input.row.ownerAddress as `0x${string}`,
      agentId: input.row.agentId, positionId: position.positionId,
      sequenceId: sequence.sequenceId, resolutionId: input.resolution.resolutionId,
      resolverFence: sequence.resolverFence,
      expectedResolverRowVersion: sequence.resolverRowVersion,
      expectedResolutionRowVersion: input.resolution.rowVersion,
      expectedPositionVersion: position.rowVersion,
      journalIdempotencyKey: input.row.idempotencyKey, resolutionKeyHash,
      outcome: input.evidence.outcome, positionMutation,
      ...(attachedTokenId === undefined ? {} : { tokenId: attachedTokenId }),
      releaseReservation, now: input.deps.now() });
    const [nextPosition, nextSequence] = await Promise.all([
      input.deps.sequences.getPosition(input.row.ownerAddress as `0x${string}`,
        input.row.agentId, position.positionId),
      input.deps.sequences.getSequence(input.row.ownerAddress as `0x${string}`,
        input.row.agentId, sequence.sequenceId),
    ]);
    if (nextPosition === null || nextSequence === null) {
      throw new Error("RESOLUTION_STATE_CONFLICT: post-process rows disappeared.");
    }
    position = nextPosition;
    sequence = nextSequence;
  }
  return { position, sequence, ...(carriedAmounts === undefined ? {} : { carriedAmounts }) };
}

async function reconstructCarriedAmounts(input: {
  readonly row: JournalEntry; readonly sequence: LpSequenceRecord;
  readonly position: LpPositionRecord; readonly currentIndex: number;
  readonly priorRows: readonly JournalEntry[]; readonly evidence: LandingEvidenceV1;
  readonly deps: ResolveLandingDeps;
}): Promise<{ readonly wbnbWei: bigint; readonly tokenWei: bigint }> {
  const currentHash = input.evidence.landed?.txHash;
  if (currentHash === undefined) throw new Error("Landed carried-amount step omitted its tx hash.");
  const txHashes = [...input.priorRows.map((row, index) => {
    if (row.state !== "COMMITTED") {
      throw new Error("Prior carried-amount journal row is not committed.");
    }
    // The optional balanced sweep is a COMMITTED local bookkeeping skip and
    // deliberately has no txHash. It preserves, rather than transforms, the
    // carried legs. Every other prior saga step must name a chain transaction.
    if (row.externalRef.txHash === undefined && index !== 1) {
      throw new Error("Prior carried-amount journal row omitted its transaction hash.");
    }
    return row.externalRef.txHash;
  }), currentHash];
  const collectHash = txHashes[0];
  if (collectHash === undefined) throw new Error("Carried-amount sequence omitted collect receipt.");
  const collected = await input.deps.receipts.collectAmounts(collectHash);
  const quoteIs0 = input.position.token0 === input.position.quoteToken;
  let wbnbWei = quoteIs0 ? collected.amount0Wei : collected.amount1Wei;
  let tokenWei = quoteIs0 ? collected.amount1Wei : collected.amount0Wei;
  if (input.currentIndex >= 1) {
    const swapHash = txHashes[1];
    if (swapHash !== undefined) {
      const swap = await input.deps.receipts.swapAmounts(swapHash);
      if (swap.tokenIn === input.position.quoteToken) {
        if (swap.amountInWei > wbnbWei) throw new Error("Sweep spent more WBNB than receipt carry.");
        wbnbWei = wbnbWei - swap.amountInWei;
        tokenWei += swap.amountOutWei;
      } else if (swap.tokenOut === input.position.quoteToken) {
        if (swap.amountInWei > tokenWei) throw new Error("Sweep spent more token than receipt carry.");
        tokenWei = tokenWei - swap.amountInWei;
        wbnbWei += swap.amountOutWei;
      } else {
        throw new Error("Sweep receipt does not transform the carried LP legs.");
      }
    }
  }
  return { wbnbWei, tokenWei };
}

export function absentDispositionReleasesReservation(
  _sequence: Pick<LpSequenceRecord, "kind">,
  currentIndex: number,
  priorRows: readonly JournalEntry[],
): boolean {
  if (currentIndex === 0) return true;
  // A prior bookkeeping skip is COMMITTED but did not spend gas and must not
  // keep a reservation alive, including the optional protect/manual-exit
  // conversion step. Only an observed prior chain transaction does.
  return !priorRows.some((prior) =>
    prior.state === "COMMITTED" && prior.externalRef.txHash !== undefined);
}

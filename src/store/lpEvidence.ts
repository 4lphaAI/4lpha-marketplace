/**
 * Phase 3.9c C4/C5 durable evidence, quota and permanent-resolution store.
 *
 * The memory and Postgres implementations expose the same fenced operations.
 * Mutable quota rows reserve their maximum future footprint once; no update
 * changes counters, and cleanup debits the stored charge exactly once.
 */
import {
  bytesToHex,
  hexToBytes,
  keccak256,
  type Hex,
} from "viem";
import type { LpEvidenceConfig } from "../ops/config.js";
import { evidenceChunkChargedLogicalBytes } from "../lp/evidenceDigests.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

export const LANDING_EVIDENCE_VERSION = "lp-landing-evidence-v1" as const;
export type EvidenceOutcome = "landed" | "absent";
export type EvidenceRequirementState = "eligible" | "satisfied" | "unavailable" | "terminal";
export type ResolutionPhase =
  | "claimed" | "evidence-bound" | "disposition-started" | "journal-written"
  | "recovery-written" | "postprocessed" | "terminal";
export type ResolutionResponseAction = "resume-committed" | "retire-not-landed";

export type EvidenceRequirementKey = {
  readonly journalOwner: string;
  readonly journalAgent: string;
  readonly journalAction: string;
  readonly journalIdempotencyKey: string;
};

export type EvidenceRequirement = EvidenceRequirementKey & {
  readonly begunAtBlock: bigint;
  readonly expiry: bigint;
  readonly preparedIdentityHash: Hex;
  readonly coverageVersion: Hex;
  readonly quorumId: Hex;
  readonly laneId: Hex;
  /** Durable coverage generation authorized for this requirement. Legacy fixtures default to zero. */
  readonly coverageGeneration?: bigint;
  readonly state: EvidenceRequirementState;
  readonly unavailableCode: string | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
  readonly evidenceRetainedUntil: number | null;
  readonly updatedAt: number;
  readonly rowVersion: number;
  readonly chargedLogicalBytes: bigint;
};

export type ResolutionActionIdentity = {
  readonly owner: string;
  readonly agent: string;
  readonly kind: "resolveUnknownLandingV1";
  readonly idempotencyKey: string;
};

export type LandingResolution = {
  readonly resolutionId: string;
  readonly target: EvidenceRequirementKey;
  readonly preparedIdentityHash: Hex;
  readonly evidenceVersion: typeof LANDING_EVIDENCE_VERSION;
  readonly claimInitiator: ResolutionActionIdentity;
  readonly originSequenceId: string;
  readonly originSnapshotHash: Hex;
  readonly phase: ResolutionPhase;
  readonly outcome: EvidenceOutcome | null;
  readonly targetJournalTerminalState: "COMMITTED" | "ROLLED_BACK" | null;
  readonly sequenceStateAtResolution: "active" | "rolled-back" | null;
  /**
   * PHASE3.22 R5.2 site 4 — WIDENED for `"shift-ambiguous"`, and the widening
   * is deliberate rather than forced by a reachable write.
   *
   * A `grid-shift` sequence can NEVER reach an evidence row: `GRID_ENABLED` is
   * boot-INCOMPATIBLE with landing evidence (the 3.15 rule, and `grid-shift`
   * is deliberately unmapped in `landingDispositionFor` exactly as every other
   * grid kind is). So no row this table stores will ever carry the new member.
   *
   * It is widened anyway because these unions are TYPE-level and
   * `resolveLanding.ts` assigns an `LpRecoveryState` into them: keeping them
   * narrow breaks the COMPILE whether or not the flag is on. D2 named both
   * options and required the build to choose one and say so — this is the
   * choice, and widening is the option that keeps ONE recovery vocabulary in
   * the codebase instead of two that must be kept in sync by hand.
   *
   * The three sibling unions below and the CHECK constraint carry the same
   * widening for the same reason.
   */
  readonly recoveryAfterConfirm: "none" | "pending-mint" | "pending-increase" | "wbnb-stranded" | "shift-ambiguous" | null;
  readonly responseAction: ResolutionResponseAction | null;
  readonly responseInference: EvidenceOutcome | null;
  readonly evidenceHash: Hex | null;
  readonly evidenceRetainedUntil: number | null;
  readonly terminalAt: number | null;
  readonly terminalizingAction: ResolutionActionIdentity | null;
  readonly rowVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly evidenceCleanupCompletedAt: number | null;
  readonly evidenceCleanupChargedBytes: bigint | null;
};

export type LandingEvidenceV1 = {
  readonly scheme: typeof LANDING_EVIDENCE_VERSION;
  readonly outcome: EvidenceOutcome;
  readonly preparedIdentityHash: Hex;
  readonly coverageVersion: Hex;
  readonly quorumId: Hex;
  readonly laneId: Hex;
  readonly generation: string;
  readonly cursorRowVersion: string;
  /** Requirement authorization is part of the evidence digest, not caller context. */
  readonly requirementState?: EvidenceRequirementState;
  readonly requirementUnavailableCode?: string | null;
  readonly requirementGeneration?: string;
  readonly requirementRowVersion?: string;
  readonly requiredSourceIds: readonly string[];
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly toBlockHash: Hex;
  readonly evidenceDigest: Hex;
  readonly landed?: {
    readonly txHash: Hex;
    readonly inputHash: Hex;
    readonly blockNumber: string;
    readonly blockHash: Hex;
    readonly transactionIndex: string;
    readonly intentIndex: number;
    readonly logIndex: string;
    readonly eventTopicsHash: Hex;
    readonly eventDataHash: Hex;
  };
  readonly absent?: {
    readonly toBlockTimestamp: string;
    readonly expirySafetySeconds: number;
    readonly zeroMatchCount: 0;
  };
};

export type LandingResolutionEvidence = {
  readonly resolutionId: string;
  readonly evidenceVersion: typeof LANDING_EVIDENCE_VERSION;
  readonly evidenceBytes: string;
  readonly evidenceHash: Hex;
  readonly coverageVersion: Hex;
  readonly quorumId: Hex;
  readonly laneId: Hex;
  readonly generation: bigint;
  readonly cursorRowVersion: number;
  readonly retainedUntil: number | null;
  readonly createdAt: number;
  readonly chargedLogicalBytes: bigint;
};

export type EvidenceQuotaCounter = {
  readonly coverageVersion: Hex | "";
  readonly logicalBytes: bigint;
  readonly blockRows: number;
  readonly candidateRows: number;
  readonly requirementRows: number;
  readonly zeroExpiryRows: number;
  readonly rowVersion: number;
  readonly updatedAt: number;
};

export type LpEvidenceStore = {
  /** Memory-only rollback participant for the no-SQL landing finalizer. */
  snapshotLandingResolutionTransaction?(resolutionId: string): unknown;
  restoreLandingResolutionTransaction?(snapshot: unknown): void;
  admitRequirement(input: Omit<EvidenceRequirement,
    "state" | "unavailableCode" | "createdAt" | "terminalAt" |
    "evidenceRetainedUntil" | "updatedAt" | "rowVersion" | "chargedLogicalBytes"
  >): Promise<EvidenceRequirement | { readonly unavailable: "storage-quota" }>;
  getRequirement(key: EvidenceRequirementKey): Promise<EvidenceRequirement | null>;
  createOrJoinResolution(input: {
    readonly target: EvidenceRequirementKey;
    readonly preparedIdentityHash: Hex;
    readonly action: ResolutionActionIdentity;
    readonly originSequenceId: string;
    readonly originSnapshotHash: Hex;
  }): Promise<{ readonly resolution: LandingResolution; readonly created: boolean }>;
  getResolution(resolutionId: string): Promise<LandingResolution | null>;
  getResolutionEvidence(resolutionId: string): Promise<LandingEvidenceV1 | null>;
  bindEvidence(input: {
    readonly resolutionId: string;
    readonly expectedRowVersion: number;
    readonly evidence: LandingEvidenceV1;
  }): Promise<{ readonly resolution: LandingResolution; readonly evidence: LandingResolutionEvidence }>;
  advanceResolution(input: {
    readonly resolutionId: string;
    readonly expectedRowVersion: number;
    readonly expectedPhase: ResolutionPhase;
    readonly phase: ResolutionPhase;
    readonly outcome?: EvidenceOutcome;
    readonly targetJournalTerminalState?: "COMMITTED" | "ROLLED_BACK";
    readonly sequenceStateAtResolution?: "active" | "rolled-back";
    // PHASE3.22 R5.2 site 4 — widened; see the field on LpEvidenceRow above.
    readonly recoveryAfterConfirm?: "none" | "pending-mint" | "pending-increase" | "wbnb-stranded" | "shift-ambiguous";
    readonly responseAction?: ResolutionResponseAction;
  }): Promise<LandingResolution>;
  terminalize(input: {
    readonly resolutionId: string;
    readonly expectedRowVersion: number;
    readonly terminalizingAction: ResolutionActionIdentity;
  }): Promise<LandingResolution>;
  releaseProvisional(resolutionId: string, expectedRowVersion: number): Promise<boolean>;
  cleanupRetained(now: number, limit?: number): Promise<number>;
  quota(): Promise<EvidenceQuotaCounter>;
  close(): Promise<void>;
};

const RESOLUTION_EVIDENCE_MAX_MUTABLE_BYTES = 65_536n;
const ROW_OVERHEAD = 64n;

export function requirementChargedLogicalBytes(key: EvidenceRequirementKey): bigint {
  const texts = [key.journalAgent, key.journalAction, key.journalIdempotencyKey]
    .reduce((sum, value) => sum + 4n + BigInt(utf8Bytes(value)), 0n);
  // Immutable identity plus the longest legal future projection:
  // `unavailable` (11), the 128-byte reason, both terminal timestamps and all
  // fixed hashes/uints. The charge itself is excluded.
  return ROW_OVERHEAD + 20n + texts + 2n * 8n + 32n + 4n * 32n + 11n +
    1n + 128n + 8n + 2n * 9n + 8n + 8n;
}

export function resolutionEvidenceChargedLogicalBytes(resolutionId: string): bigint {
  return ROW_OVERHEAD + RESOLUTION_EVIDENCE_MAX_MUTABLE_BYTES + BigInt(utf8Bytes(resolutionId));
}

export function evidenceRequirementKeyHash(key: EvidenceRequirementKey): Hex {
  return keccak256(bytesToHex(concatBytes([
    encodeText("4lpha:lp-evidence:requirement-key:v1"),
    encodeAddress(key.journalOwner),
    encodeText(key.journalAgent), encodeText(key.journalAction),
    encodeText(key.journalIdempotencyKey),
  ])));
}

export function landingResolutionKeyHash(input: {
  readonly target: EvidenceRequirementKey;
  readonly preparedIdentityHash: Hex;
  readonly evidenceVersion?: string;
}): Hex {
  return keccak256(bytesToHex(concatBytes([
    encodeText("4lpha:lp-evidence:resolution-key:v1"),
    encodeAddress(input.target.journalOwner),
    encodeText(input.target.journalAgent), encodeText(input.target.journalAction),
    encodeText(input.target.journalIdempotencyKey),
    hexToBytes(input.preparedIdentityHash),
    encodeText(input.evidenceVersion ?? LANDING_EVIDENCE_VERSION),
  ])));
}

export function canonicalLandingEvidence(input: Omit<LandingEvidenceV1, "evidenceDigest">): LandingEvidenceV1 {
  const normalized = {
    ...input,
    requirementState: input.requirementState ?? "eligible",
    requirementUnavailableCode: input.requirementUnavailableCode ?? null,
    requirementGeneration: input.requirementGeneration ?? input.generation,
    requirementRowVersion: input.requirementRowVersion ?? "0",
  } satisfies Omit<LandingEvidenceV1, "evidenceDigest">;
  assertEvidenceShape(normalized);
  const evidenceDigest = landingEvidenceDigest(normalized);
  return { ...normalized, evidenceDigest };
}

function resolutionIdFor(input: {
  readonly target: EvidenceRequirementKey;
  readonly preparedIdentityHash: Hex;
}): string {
  return `lp-landing:${landingResolutionKeyHash(input).slice(2)}`;
}

export class MemoryEvidenceRequirementRegistry {
  readonly requirements = new Map<string, EvidenceRequirement>();
}

export class MemoryLpEvidenceStore implements LpEvidenceStore {
  readonly #config: LpEvidenceConfig;
  readonly #now: () => number;
  readonly #requirements: Map<string, EvidenceRequirement>;
  readonly #resolutions = new Map<string, LandingResolution>();
  readonly #evidence = new Map<string, LandingResolutionEvidence>();
  readonly #versionBytes = new Map<Hex, bigint>();
  #counter: EvidenceQuotaCounter;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(config: LpEvidenceConfig, now: () => number = Date.now,
    registry: MemoryEvidenceRequirementRegistry = new MemoryEvidenceRequirementRegistry()) {
    this.#config = config;
    this.#now = now;
    this.#requirements = registry.requirements;
    this.#counter = {
      coverageVersion: "",
      logicalBytes: 0n,
      blockRows: 0,
      candidateRows: 0,
      requirementRows: 0,
      zeroExpiryRows: 0,
      rowVersion: 0,
      updatedAt: now(),
    };
  }

  snapshotLandingResolutionTransaction(resolutionId: string): unknown {
    const resolution = this.#resolutions.get(resolutionId) ?? null;
    const requirementKey = resolution === null ? null : requirementMapKey(resolution.target);
    return structuredClone({ resolutionId, resolution,
      evidence: this.#evidence.get(resolutionId) ?? null, requirementKey,
      requirement: requirementKey === null ? null : this.#requirements.get(requirementKey) ?? null });
  }

  restoreLandingResolutionTransaction(snapshot: unknown): void {
    const state = snapshot as {
      readonly resolutionId: string; readonly resolution: LandingResolution | null;
      readonly evidence: LandingResolutionEvidence | null; readonly requirementKey: string | null;
      readonly requirement: EvidenceRequirement | null;
    };
    if (state.resolution === null) this.#resolutions.delete(state.resolutionId);
    else this.#resolutions.set(state.resolutionId, structuredClone(state.resolution));
    if (state.evidence === null) this.#evidence.delete(state.resolutionId);
    else this.#evidence.set(state.resolutionId, structuredClone(state.evidence));
    if (state.requirementKey !== null) {
      if (state.requirement === null) this.#requirements.delete(state.requirementKey);
      else this.#requirements.set(state.requirementKey, structuredClone(state.requirement));
    }
  }

  admitRequirement(input: Omit<EvidenceRequirement,
    "state" | "unavailableCode" | "createdAt" | "terminalAt" |
    "evidenceRetainedUntil" | "updatedAt" | "rowVersion" | "chargedLogicalBytes"
  >): Promise<EvidenceRequirement | { readonly unavailable: "storage-quota" }> {
    return this.#serial(async () => {
      assertRequirementInput(input);
      const key = requirementMapKey(input);
      const existing = this.#requirements.get(key);
      if (existing !== undefined) {
        assertRequirementAdmissionIdentity(existing, input);
        return existing;
      }
      const charge = requirementChargedLogicalBytes(input);
      const zero = input.expiry === 0n ? 1 : 0;
      if (this.#counter.requirementRows + 1 > this.#config.maxRequirements ||
          this.#counter.zeroExpiryRows + zero > this.#config.maxZeroExpiryRequirements ||
          this.#counter.logicalBytes + charge > BigInt(this.#config.maxGlobalLogicalBytes) ||
          (this.#versionBytes.get(input.coverageVersion) ?? 0n) + charge >
            BigInt(this.#config.maxVersionLogicalBytes)) {
        return { unavailable: "storage-quota" } as const;
      }
      const at = this.#now();
      const row: EvidenceRequirement = {
        ...input,
        coverageGeneration: input.coverageGeneration ?? 0n,
        state: "eligible",
        unavailableCode: null,
        createdAt: at,
        terminalAt: null,
        evidenceRetainedUntil: null,
        updatedAt: at,
        rowVersion: 0,
        chargedLogicalBytes: charge,
      };
      assertRequirementWithinReservedCharge(row, charge);
      this.#requirements.set(key, row);
      this.#versionBytes.set(input.coverageVersion,
        (this.#versionBytes.get(input.coverageVersion) ?? 0n) + charge);
      this.#counter = {
        ...this.#counter,
        logicalBytes: this.#counter.logicalBytes + charge,
        requirementRows: this.#counter.requirementRows + 1,
        zeroExpiryRows: this.#counter.zeroExpiryRows + zero,
        rowVersion: this.#counter.rowVersion + 1,
        updatedAt: at,
      };
      return row;
    });
  }

  async getRequirement(key: EvidenceRequirementKey): Promise<EvidenceRequirement | null> {
    return this.#requirements.get(requirementMapKey(key)) ?? null;
  }

  createOrJoinResolution(input: {
    readonly target: EvidenceRequirementKey;
    readonly preparedIdentityHash: Hex;
    readonly action: ResolutionActionIdentity;
    readonly originSequenceId: string;
    readonly originSnapshotHash: Hex;
  }): Promise<{ readonly resolution: LandingResolution; readonly created: boolean }> {
    return this.#serial(async () => {
      assertAction(input.action);
      const id = resolutionIdFor(input);
      const existing = this.#resolutions.get(id);
      if (existing !== undefined) {
        assertResolutionJoin(existing, input);
        return { resolution: existing, created: false };
      }
      const at = this.#now();
      const resolution: LandingResolution = {
        resolutionId: id,
        target: input.target,
        preparedIdentityHash: input.preparedIdentityHash,
        evidenceVersion: LANDING_EVIDENCE_VERSION,
        claimInitiator: input.action,
        originSequenceId: input.originSequenceId,
        originSnapshotHash: input.originSnapshotHash,
        phase: "claimed",
        outcome: null,
        targetJournalTerminalState: null,
        sequenceStateAtResolution: null,
        recoveryAfterConfirm: null,
        responseAction: null,
        responseInference: null,
        evidenceHash: null,
        evidenceRetainedUntil: null,
        terminalAt: null,
        terminalizingAction: null,
        rowVersion: 0,
        createdAt: at,
        updatedAt: at,
        evidenceCleanupCompletedAt: null,
        evidenceCleanupChargedBytes: null,
      };
      this.#resolutions.set(id, resolution);
      return { resolution, created: true };
    });
  }

  async getResolution(resolutionId: string): Promise<LandingResolution | null> {
    return this.#resolutions.get(resolutionId) ?? null;
  }

  async getResolutionEvidence(resolutionId: string): Promise<LandingEvidenceV1 | null> {
    const row = this.#evidence.get(resolutionId);
    return row === undefined ? null : JSON.parse(row.evidenceBytes) as LandingEvidenceV1;
  }

  bindEvidence(input: {
    readonly resolutionId: string;
    readonly expectedRowVersion: number;
    readonly evidence: LandingEvidenceV1;
  }): Promise<{ readonly resolution: LandingResolution; readonly evidence: LandingResolutionEvidence }> {
    return this.#serial(async () => {
      const current = this.#requireResolution(input.resolutionId, input.expectedRowVersion, "claimed");
      assertEvidenceShape(input.evidence);
      if (input.evidence.evidenceDigest !== recomputeEvidenceDigest(input.evidence) ||
          input.evidence.preparedIdentityHash !== current.preparedIdentityHash) {
        throw new Error("Landing evidence digest or prepared identity is invalid.");
      }
      const requirement = this.#requirements.get(requirementMapKey(current.target));
      if (requirement === undefined || !requirementAuthorizesEvidence(requirement, input.evidence)) {
        throw new Error("RESOLUTION_STATE_CONFLICT: evidence requirement is unavailable.");
      }
      const canonical = canonicalEvidenceJson(input.evidence);
      const charge = resolutionEvidenceChargedLogicalBytes(input.resolutionId);
      if (ROW_OVERHEAD + BigInt(utf8Bytes(canonical)) > charge) {
        throw new Error("Landing evidence exceeds its immutable maximum-footprint reservation.");
      }
      if (this.#counter.logicalBytes + charge > BigInt(this.#config.maxGlobalLogicalBytes) ||
          (this.#versionBytes.get(input.evidence.coverageVersion) ?? 0n) + charge >
            BigInt(this.#config.maxVersionLogicalBytes)) {
        throw new Error("LP evidence storage quota exhausted.");
      }
      const at = this.#now();
      const evidence: LandingResolutionEvidence = {
        resolutionId: input.resolutionId,
        evidenceVersion: LANDING_EVIDENCE_VERSION,
        evidenceBytes: canonical,
        evidenceHash: input.evidence.evidenceDigest,
        coverageVersion: input.evidence.coverageVersion,
        quorumId: input.evidence.quorumId,
        laneId: input.evidence.laneId,
        generation: BigInt(input.evidence.generation),
        cursorRowVersion: Number(input.evidence.cursorRowVersion),
        retainedUntil: null,
        createdAt: at,
        chargedLogicalBytes: charge,
      };
      this.#evidence.set(input.resolutionId, evidence);
      this.#versionBytes.set(input.evidence.coverageVersion,
        (this.#versionBytes.get(input.evidence.coverageVersion) ?? 0n) + charge);
      const next: LandingResolution = {
        ...current,
        phase: "evidence-bound",
        outcome: input.evidence.outcome,
        responseInference: input.evidence.outcome,
        evidenceHash: input.evidence.evidenceDigest,
        rowVersion: current.rowVersion + 1,
        updatedAt: at,
      };
      this.#resolutions.set(input.resolutionId, next);
      this.#counter = {
        ...this.#counter,
        logicalBytes: this.#counter.logicalBytes + charge,
        rowVersion: this.#counter.rowVersion + 1,
        updatedAt: at,
      };
      return { resolution: next, evidence };
    });
  }

  advanceResolution(input: {
    readonly resolutionId: string;
    readonly expectedRowVersion: number;
    readonly expectedPhase: ResolutionPhase;
    readonly phase: ResolutionPhase;
    readonly outcome?: EvidenceOutcome;
    readonly targetJournalTerminalState?: "COMMITTED" | "ROLLED_BACK";
    readonly sequenceStateAtResolution?: "active" | "rolled-back";
    // PHASE3.22 R5.2 site 4 — widened; see the field on LpEvidenceRow above.
    readonly recoveryAfterConfirm?: "none" | "pending-mint" | "pending-increase" | "wbnb-stranded" | "shift-ambiguous";
    readonly responseAction?: ResolutionResponseAction;
  }): Promise<LandingResolution> {
    return this.#serial(async () => {
      const current = this.#requireResolution(
        input.resolutionId,
        input.expectedRowVersion,
        input.expectedPhase,
      );
      assertForwardPhase(current.phase, input.phase);
      const at = this.#now();
      const next: LandingResolution = {
        ...current,
        phase: input.phase,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome, responseInference: input.outcome }),
        ...(input.targetJournalTerminalState === undefined ? {} : {
          targetJournalTerminalState: input.targetJournalTerminalState,
        }),
        ...(input.sequenceStateAtResolution === undefined ? {} : {
          sequenceStateAtResolution: input.sequenceStateAtResolution,
        }),
        ...(input.recoveryAfterConfirm === undefined ? {} : {
          recoveryAfterConfirm: input.recoveryAfterConfirm,
        }),
        ...(input.responseAction === undefined ? {} : { responseAction: input.responseAction }),
        rowVersion: current.rowVersion + 1,
        updatedAt: at,
      };
      this.#resolutions.set(input.resolutionId, next);
      return next;
    });
  }

  terminalize(input: {
    readonly resolutionId: string;
    readonly expectedRowVersion: number;
    readonly terminalizingAction: ResolutionActionIdentity;
  }): Promise<LandingResolution> {
    return this.#serial(async () => {
      assertAction(input.terminalizingAction);
      const current = this.#requireResolution(input.resolutionId, input.expectedRowVersion, "postprocessed");
      if (current.outcome === null || current.evidenceHash === null ||
          current.targetJournalTerminalState === null || current.responseAction === null ||
          current.recoveryAfterConfirm === null) {
        throw new Error("Resolution cannot terminalize before its disposition fields are complete.");
      }
      const evidence = this.#evidence.get(input.resolutionId);
      if (evidence === undefined) throw new Error("Resolution evidence is missing.");
      const terminalAt = this.#now();
      const retainedUntil = terminalAt + this.#config.auditRetentionDays * 86_400_000;
      const retainedEvidence = { ...evidence, retainedUntil };
      if (ROW_OVERHEAD + BigInt(utf8Bytes(JSON.stringify(retainedEvidence, bigintJson))) > evidence.chargedLogicalBytes) {
        throw new Error("Evidence retention update exceeds reserved charge.");
      }
      this.#evidence.set(input.resolutionId, retainedEvidence);
      const requirementKey = requirementMapKey(current.target);
      const requirement = this.#requirements.get(requirementKey);
      const currentEvidence = JSON.parse(evidence.evidenceBytes) as LandingEvidenceV1;
      if (requirement === undefined || !requirementAuthorizesEvidence(requirement, currentEvidence)) {
        throw new Error("Resolution requirement cannot be terminalized.");
      }
      const terminalRequirement: EvidenceRequirement = {
        ...requirement,
        state: "terminal",
        terminalAt,
        evidenceRetainedUntil: retainedUntil,
        updatedAt: terminalAt,
        rowVersion: requirement.rowVersion + 1,
      };
      assertRequirementWithinReservedCharge(terminalRequirement, requirement.chargedLogicalBytes);
      this.#requirements.set(requirementKey, terminalRequirement);
      const next: LandingResolution = {
        ...current,
        phase: "terminal",
        sequenceStateAtResolution: current.outcome === "landed" ? "active" : "rolled-back",
        terminalizingAction: input.terminalizingAction,
        terminalAt,
        evidenceRetainedUntil: retainedUntil,
        rowVersion: current.rowVersion + 1,
        updatedAt: terminalAt,
      };
      this.#resolutions.set(input.resolutionId, next);
      return next;
    });
  }

  releaseProvisional(resolutionId: string, expectedRowVersion: number): Promise<boolean> {
    return this.#serial(async () => {
      const current = this.#resolutions.get(resolutionId);
      if (current === undefined) return false;
      if (current.rowVersion !== expectedRowVersion ||
          (current.phase !== "claimed" && current.phase !== "evidence-bound")) {
        throw new Error("Provisional resolution release conflict.");
      }
      const evidence = this.#evidence.get(resolutionId);
      if (evidence !== undefined) {
        if (this.#counter.logicalBytes < evidence.chargedLogicalBytes ||
            (this.#versionBytes.get(evidence.coverageVersion) ?? 0n) <
              evidence.chargedLogicalBytes) {
          throw new Error("Evidence quota counter underflow.");
        }
        this.#counter = {
          ...this.#counter,
          logicalBytes: this.#counter.logicalBytes - evidence.chargedLogicalBytes,
          rowVersion: this.#counter.rowVersion + 1,
          updatedAt: this.#now(),
        };
        this.#versionBytes.set(evidence.coverageVersion,
          (this.#versionBytes.get(evidence.coverageVersion) ?? 0n) - evidence.chargedLogicalBytes);
        this.#evidence.delete(resolutionId);
      }
      this.#resolutions.delete(resolutionId);
      return true;
    });
  }

  cleanupRetained(now: number, limit = 1_000): Promise<number> {
    return this.#serial(async () => {
      const eligible = [...this.#resolutions.values()]
        .filter((row) => row.phase === "terminal" && row.evidenceRetainedUntil !== null &&
          now >= row.evidenceRetainedUntil && row.evidenceCleanupCompletedAt === null)
        .sort((a, b) => (a.evidenceRetainedUntil ?? 0) - (b.evidenceRetainedUntil ?? 0) ||
          a.resolutionId.localeCompare(b.resolutionId))
        .slice(0, Math.min(1_000, Math.max(0, limit)));
      let cleaned = 0;
      for (const resolution of eligible) {
        const requirementKey = requirementMapKey(resolution.target);
        const requirement = this.#requirements.get(requirementKey);
        const evidence = this.#evidence.get(resolution.resolutionId);
        if (requirement === undefined || requirement.state !== "terminal" || evidence === undefined ||
            evidence.retainedUntil !== resolution.evidenceRetainedUntil) {
          throw new Error("Retained evidence cleanup integrity conflict.");
        }
        const debit = requirement.chargedLogicalBytes + evidence.chargedLogicalBytes;
        if (this.#counter.logicalBytes < debit ||
            (this.#versionBytes.get(requirement.coverageVersion) ?? 0n) < debit ||
            this.#counter.requirementRows < 1 ||
            (requirement.expiry === 0n && this.#counter.zeroExpiryRows < 1)) {
          throw new Error("Retained evidence cleanup counter underflow.");
        }
        this.#requirements.delete(requirementKey);
        this.#evidence.delete(resolution.resolutionId);
        this.#versionBytes.set(requirement.coverageVersion,
          (this.#versionBytes.get(requirement.coverageVersion) ?? 0n) - debit);
        this.#counter = {
          ...this.#counter,
          logicalBytes: this.#counter.logicalBytes - debit,
          requirementRows: this.#counter.requirementRows - 1,
          zeroExpiryRows: this.#counter.zeroExpiryRows - (requirement.expiry === 0n ? 1 : 0),
          rowVersion: this.#counter.rowVersion + 1,
          updatedAt: now,
        };
        this.#resolutions.set(resolution.resolutionId, {
          ...resolution,
          evidenceCleanupCompletedAt: now,
          evidenceCleanupChargedBytes: debit,
          rowVersion: resolution.rowVersion + 1,
          updatedAt: now,
        });
        cleaned += 1;
      }
      return cleaned;
    });
  }

  async quota(): Promise<EvidenceQuotaCounter> {
    return this.#counter;
  }

  async close(): Promise<void> {}

  #requireResolution(
    resolutionId: string,
    expectedRowVersion: number,
    expectedPhase: ResolutionPhase,
  ): LandingResolution {
    const current = this.#resolutions.get(resolutionId);
    if (current === undefined) throw new Error("Landing resolution does not exist.");
    if (current.rowVersion !== expectedRowVersion || current.phase !== expectedPhase) {
      throw new Error("Landing resolution phase/version conflict.");
    }
    return current;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lock.catch(() => undefined).then(work);
    this.#lock = run.catch(() => undefined);
    return run;
  }
}

/** Exact additive production schema; operations are implemented below audit. */
const LP_EVIDENCE_DDL = `
create table if not exists lp_evidence_sources (
 coverage_version char(66) not null, source_id varchar(32) not null,
 operator_family varchar(32) not null, role varchar(32) not null check(role in ('required','accelerator')),
 endpoint_fingerprint char(66) not null, enabled_at timestamptz not null, disabled_at timestamptz,
 primary key(coverage_version,source_id)
);
create table if not exists lp_evidence_quorums (
 coverage_version char(66) not null, quorum_id char(66) not null,
 required_source_count bigint not null check(required_source_count>=2), quorum_digest char(66) not null,
 primary key(coverage_version,quorum_id)
);
create table if not exists lp_evidence_leases (
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 holder_id varchar(128) not null, fence bigint not null check(fence>=0),
 lease_until timestamptz not null, updated_at timestamptz not null,
 primary key(coverage_version,quorum_id,lane_id)
);
create table if not exists lp_evidence_backfill_budgets (
 coverage_version char(66) not null, window_start timestamptz not null,
 blocks bigint not null check(blocks>=0), row_version bigint not null check(row_version>=0),
 updated_at timestamptz not null, primary key(coverage_version,window_start)
);
create table if not exists lp_evidence_cursors (
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 purpose varchar(16) not null check(purpose in ('base','backfill')),
 admission_key_hash char(66) not null, origin_block numeric(20,0) not null check(origin_block>=0),
 covered_through numeric(20,0), covered_through_hash char(66),
 raw_retained_from numeric(20,0) not null check(raw_retained_from>=0),
 generation bigint not null check(generation>=0),
 state varchar(16) not null check(state in ('active','gap','invalidated','exhausted')),
 row_version bigint not null check(row_version>=0), updated_at timestamptz not null,
 primary key(coverage_version,quorum_id,lane_id),
 check((covered_through is null and covered_through_hash is null) or
       (covered_through is not null and covered_through_hash is not null))
);
create table if not exists lp_evidence_chunks (
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 generation bigint not null check(generation>=0), source_id varchar(32) not null,
 from_block numeric(20,0) not null check(from_block>=0),
 to_block numeric(20,0) not null check(to_block>=from_block),
 state varchar(16) not null check(state in ('pending','leased','complete','gap','invalidated')),
 lease_fence bigint not null check(lease_fence>=0), first_hash char(66), last_hash char(66),
 ordered_block_digest char(66), candidate_count bigint not null check(candidate_count>=0),
 charged_logical_bytes bigint not null check(charged_logical_bytes>=64),
 completed_at timestamptz, error_code varchar(128),
 primary key(coverage_version,quorum_id,lane_id,generation,source_id,from_block,to_block),
 check(
  (state in ('pending','leased') and first_hash is null and last_hash is null and
   ordered_block_digest is null and candidate_count=0 and completed_at is null and error_code is null)
  or (state='complete' and first_hash is not null and last_hash is not null and
   ordered_block_digest is not null and completed_at is not null and error_code is null)
  or (state='gap' and first_hash is null and last_hash is null and ordered_block_digest is null and
   candidate_count=0 and completed_at is not null and error_code is not null)
  or (state='invalidated' and (
    (first_hash is null and last_hash is null and ordered_block_digest is null and
     candidate_count=0 and completed_at is null and error_code is null)
    or (first_hash is not null and last_hash is not null and ordered_block_digest is not null and
     completed_at is not null and error_code is null)
    or (first_hash is null and last_hash is null and ordered_block_digest is null and
     candidate_count=0 and completed_at is not null and error_code is not null))))
);
create table if not exists lp_evidence_blocks (
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 generation bigint not null check(generation>=0), source_id varchar(32) not null,
 block_number numeric(20,0) not null check(block_number>=0), block_hash char(66) not null,
 parent_hash char(66) not null, block_timestamp numeric(20,0) not null check(block_timestamp>=0),
 ordered_transaction_digest char(66) not null, finalized_observed_at timestamptz not null,
 logical_bytes bigint not null check(logical_bytes>=64),
 primary key(coverage_version,quorum_id,lane_id,generation,source_id,block_number)
);
create table if not exists lp_evidence_candidates (
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 generation bigint not null check(generation>=0), source_id varchar(32) not null,
 block_number numeric(20,0) not null check(block_number>=0), block_hash char(66) not null,
 transaction_hash char(66) not null, transaction_index numeric(20,0) not null check(transaction_index>=0),
 input_hash char(66) not null, log_index numeric(20,0) not null check(log_index>=0),
 orchestrator char(42) not null, orchestrator_version varchar(32) not null,
 decoder varchar(128) not null, intent_index bigint not null check(intent_index>=0),
 member_count bigint not null check(member_count between 1 and 32), eoa char(42) not null,
 nonce numeric(78,0) not null check(nonce>=0), execution_data_hash char(66) not null,
 key_hash char(66) not null, receipt_status bigint not null, incremented boolean not null,
 event_error char(10) not null, event_topics_hash char(66) not null,
 event_data_hash char(66) not null, candidate_digest char(66) not null,
 logical_bytes bigint not null check(logical_bytes>=64),
 primary key(coverage_version,quorum_id,lane_id,generation,source_id,
             transaction_hash,intent_index,log_index)
);
create table if not exists lp_evidence_requirements (
 journal_owner char(42) not null, journal_agent varchar(128) not null,
 journal_action varchar(128) not null, journal_idempotency_key varchar(128) not null,
 begun_at_block numeric(20,0) not null check (begun_at_block>=0),
 expiry numeric(78,0) not null check (expiry>=0), prepared_identity_hash char(66) not null,
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 coverage_generation bigint not null default 0 check(coverage_generation>=0),
 state varchar(16) not null check (state in ('eligible','satisfied','unavailable','terminal')),
 unavailable_code varchar(128), created_at timestamptz not null,
 terminal_at timestamptz, evidence_retained_until timestamptz, updated_at timestamptz not null,
 row_version bigint not null check(row_version>=0),
 charged_logical_bytes bigint not null check(charged_logical_bytes>=64),
 primary key(journal_owner,journal_agent,journal_action,journal_idempotency_key),
 check ((state='terminal' and terminal_at is not null and evidence_retained_until is not null)
     or (state<>'terminal' and terminal_at is null and evidence_retained_until is null))
);
create table if not exists lp_evidence_zero_prefixes (
 journal_owner char(42) not null, journal_agent varchar(128) not null,
 journal_action varchar(128) not null, journal_idempotency_key varchar(128) not null,
 coverage_version char(66) not null, quorum_id char(66) not null, lane_id char(66) not null,
 generation bigint not null check(generation>=0), from_block numeric(20,0) not null check(from_block>=0),
 to_block numeric(20,0) not null check(to_block>=from_block), to_block_hash char(66) not null,
 required_source_digest_accumulator char(66) not null, prefix_digest char(66) not null,
 match_count bigint not null check(match_count=0), generation_carry_digest char(66),
 carry_parent_digest char(66), carry_source_accumulator char(66), carried_from_generation bigint,
 carry_from_block numeric(20,0), carry_to_block numeric(20,0), carry_to_block_hash char(66),
 charged_logical_bytes bigint not null check(charged_logical_bytes>=64), updated_at timestamptz not null,
 primary key(journal_owner,journal_agent,journal_action,journal_idempotency_key),
 check((generation_carry_digest is null and carry_parent_digest is null and
   carry_source_accumulator is null and carried_from_generation is null and carry_from_block is null and
   carry_to_block is null and carry_to_block_hash is null) or
  (generation_carry_digest is not null and carry_parent_digest is not null and
   carry_source_accumulator is not null and carried_from_generation is not null and carry_from_block is not null and
   carry_to_block is not null and carry_to_block_hash is not null))
);
create table if not exists lp_landing_resolutions (
 resolution_id varchar(128) primary key, target_owner char(42) not null,
 target_agent varchar(128) not null, target_journal_action varchar(128) not null,
 target_journal_idempotency_key varchar(128) not null, prepared_identity_hash char(66) not null,
 evidence_version varchar(128) not null,
 claim_initiator_action_owner char(42) not null, claim_initiator_action_agent varchar(128) not null,
 claim_initiator_action_kind varchar(64) not null check(claim_initiator_action_kind='resolveUnknownLandingV1'),
 claim_initiator_action_idempotency_key varchar(128) not null,
 origin_sequence_id varchar(128) not null, origin_snapshot_hash char(66) not null,
 phase varchar(32) not null check(phase in ('claimed','evidence-bound','disposition-started','journal-written','recovery-written','postprocessed','terminal')),
 outcome varchar(16) check(outcome in ('landed','absent')),
 target_journal_terminal_state varchar(16) check(target_journal_terminal_state in ('COMMITTED','ROLLED_BACK')),
 sequence_state_at_resolution varchar(16) check(sequence_state_at_resolution in ('active','rolled-back')),
 -- PHASE3.22 R5.2 site 4 — widened with its three unions. NO guarded migration
 -- block accompanies this one, and that is a decision rather than an omission:
 -- a grid-shift row can never reach this table (grid is boot-incompatible
 -- with landing evidence), so no existing deployment holds a row that would
 -- violate the old constraint and none can ever write one that needs the new
 -- member. The literal is widened only to keep ONE recovery vocabulary.
 recovery_after_confirm varchar(32) check(recovery_after_confirm in ('none','pending-mint','pending-increase','wbnb-stranded','shift-ambiguous')),
 response_action varchar(32) check(response_action in ('resume-committed','retire-not-landed')),
 response_inference varchar(16) check(response_inference in ('landed','absent')),
 evidence_hash char(66), evidence_retained_until timestamptz, terminal_at timestamptz,
 terminalizing_action_owner char(42), terminalizing_action_agent varchar(128),
 terminalizing_action_kind varchar(64), terminalizing_action_idempotency_key varchar(128),
 row_version bigint not null check(row_version>=0), created_at timestamptz not null, updated_at timestamptz not null,
 evidence_cleanup_completed_at timestamptz, evidence_cleanup_charged_bytes bigint check(evidence_cleanup_charged_bytes>=0),
 unique(target_owner,target_agent,target_journal_action,target_journal_idempotency_key,prepared_identity_hash,evidence_version),
 check ((evidence_cleanup_completed_at is null and evidence_cleanup_charged_bytes is null) or
        (evidence_cleanup_completed_at is not null and evidence_cleanup_charged_bytes is not null)),
 check ((terminalizing_action_owner is null and terminalizing_action_agent is null and
         terminalizing_action_kind is null and terminalizing_action_idempotency_key is null) or
        (terminalizing_action_owner is not null and terminalizing_action_agent is not null and
         terminalizing_action_kind='resolveUnknownLandingV1' and
         terminalizing_action_idempotency_key is not null and
         terminalizing_action_owner=target_owner and terminalizing_action_agent=target_agent)),
 check ((phase='terminal' and outcome is not null and target_journal_terminal_state is not null and
         sequence_state_at_resolution is not null and recovery_after_confirm is not null and
         response_action is not null and response_inference is not null and evidence_hash is not null and
         evidence_retained_until is not null and terminal_at is not null and
         terminalizing_action_owner is not null)
        or (phase<>'terminal' and evidence_retained_until is null and terminal_at is null and
            terminalizing_action_owner is null))
);
create table if not exists lp_landing_resolution_evidence (
 resolution_id varchar(128) primary key references lp_landing_resolutions(resolution_id),
 evidence_version varchar(128) not null, evidence_bytes varchar(65536) not null,
 evidence_hash char(66) not null unique, coverage_version char(66) not null,
 quorum_id char(66) not null, lane_id char(66) not null,
 generation bigint not null check(generation>=0), cursor_row_version bigint not null check(cursor_row_version>=0),
 retained_until timestamptz, created_at timestamptz not null,
 charged_logical_bytes bigint not null check(charged_logical_bytes>=64)
);
create table if not exists lp_evidence_quota_counters (
 scope varchar(32) not null check(scope in ('global','coverage-version')),
 coverage_version varchar(128) not null, logical_bytes bigint not null check(logical_bytes>=0),
 block_rows bigint not null check(block_rows>=0), candidate_rows bigint not null check(candidate_rows>=0),
 requirement_rows bigint not null check(requirement_rows>=0), zero_expiry_rows bigint not null check(zero_expiry_rows>=0),
 row_version bigint not null check(row_version>=0), updated_at timestamptz not null,
 primary key(scope,coverage_version),
 check ((scope='global' and coverage_version='') or (scope='coverage-version' and coverage_version<>''))
);
create index if not exists lp_evidence_requirements_work_idx
 on lp_evidence_requirements(state,created_at,journal_owner,journal_agent,journal_action,journal_idempotency_key);
create index if not exists lp_evidence_chunks_work_idx
 on lp_evidence_chunks(state,coverage_version,quorum_id,lane_id,generation,from_block,source_id);
create index if not exists lp_evidence_candidates_identity_idx
 on lp_evidence_candidates(eoa,nonce,key_hash,execution_data_hash,orchestrator,orchestrator_version);
alter table lp_evidence_requirements add column if not exists coverage_generation bigint;
update lp_evidence_requirements set coverage_generation=0 where coverage_generation is null;
alter table lp_evidence_requirements alter column coverage_generation set default 0;
alter table lp_evidence_requirements alter column coverage_generation set not null;
do $$ begin
 if not exists (
  select 1 from pg_constraint con join pg_class rel on rel.oid=con.conrelid
   where rel.relname='lp_evidence_requirements' and con.contype='c' and
    pg_get_constraintdef(con.oid) like '%coverage_generation >= 0%'
 ) then
  alter table lp_evidence_requirements add constraint
   lp_evidence_requirements_coverage_generation_nonnegative check(coverage_generation>=0);
 end if;
end $$;
`;

/**
 * Durable construction and operations. Every query is tagged so FakeSql can
 * execute the same state machine offline; startup serializes the additive DDL
 * to keep concurrent server/worker boots from racing constraint creation.
 */
export class PostgresLpEvidenceStore implements LpEvidenceStore {
  readonly #sql: SqlClient;
  readonly #config: LpEvidenceConfig;
  readonly #now: () => number;

  private constructor(sql: SqlClient, config: LpEvidenceConfig, now: () => number) {
    this.#sql = sql;
    this.#config = config;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    config: LpEvidenceConfig,
    now: () => number = Date.now,
  ): Promise<PostgresLpEvidenceStore> {
    await sql.transaction(async (tx) => {
      await tx.query("/* lpEvidence.migrationLock */ select pg_advisory_xact_lock($1)",
        [0x4c504556]);
      await tx.query(LP_EVIDENCE_DDL);
      const verified = await tx.query<{ tables_ok: boolean; charge_columns_ok: boolean;
        legacy_columns_absent: boolean; cleanup_pair_ok: boolean;
        cleanup_check_ok: boolean; state_checks_ok: boolean; chunk_error_bound_ok: boolean;
        requirement_generation_ok: boolean }>(
        `/* lpEvidence.schemaVerify */ select
          (select count(*)=13 from information_schema.tables where table_schema=current_schema()
           and table_name=any($1::text[])) tables_ok,
          (select count(*)=4 from information_schema.columns where table_schema=current_schema()
           and column_name='charged_logical_bytes' and table_name=any($2::text[])
           and data_type='bigint' and is_nullable='NO') charge_columns_ok,
          not exists(select 1 from information_schema.columns where table_schema=current_schema()
           and column_name='logical_bytes' and table_name=any($2::text[])) legacy_columns_absent,
          (select count(*)=2 from information_schema.columns where table_schema=current_schema()
           and table_name='lp_landing_resolutions' and
           column_name=any(array['evidence_cleanup_completed_at','evidence_cleanup_charged_bytes']))
           cleanup_pair_ok,
          exists(select 1 from pg_constraint con join pg_class rel on rel.oid=con.conrelid
           where rel.relname='lp_landing_resolutions' and con.contype='c' and
            pg_get_constraintdef(con.oid) like '%evidence_cleanup_completed_at IS NULL%' and
            pg_get_constraintdef(con.oid) like '%evidence_cleanup_charged_bytes IS NULL%' and
            pg_get_constraintdef(con.oid) like '%evidence_cleanup_completed_at IS NOT NULL%' and
            pg_get_constraintdef(con.oid) like '%evidence_cleanup_charged_bytes IS NOT NULL%')
           cleanup_check_ok,
          (exists(select 1 from pg_constraint con join pg_class rel on rel.oid=con.conrelid
            where rel.relname='lp_evidence_chunks' and con.contype='c' and
             pg_get_constraintdef(con.oid) like '%invalidated%' and
             pg_get_constraintdef(con.oid) like '%candidate_count%') and
           exists(select 1 from pg_constraint con join pg_class rel on rel.oid=con.conrelid
            where rel.relname='lp_evidence_requirements' and con.contype='c' and
             pg_get_constraintdef(con.oid) like '%terminal%' and
             pg_get_constraintdef(con.oid) like '%evidence_retained_until%')) state_checks_ok,
          exists(select 1 from information_schema.columns where table_schema=current_schema()
           and table_name='lp_evidence_chunks' and column_name='error_code' and
           character_maximum_length=128) chunk_error_bound_ok,
          (exists(select 1 from information_schema.columns where table_schema=current_schema()
            and table_name='lp_evidence_requirements' and column_name='coverage_generation' and
            data_type='bigint' and is_nullable='NO') and
           exists(select 1 from pg_constraint con join pg_class rel on rel.oid=con.conrelid
            where rel.relname='lp_evidence_requirements' and con.contype='c' and
             pg_get_constraintdef(con.oid) like '%coverage_generation >= 0%'))
           requirement_generation_ok`, [[
          "lp_evidence_sources", "lp_evidence_quorums", "lp_evidence_leases",
          "lp_evidence_backfill_budgets", "lp_evidence_cursors", "lp_evidence_chunks",
          "lp_evidence_blocks", "lp_evidence_candidates", "lp_evidence_requirements",
          "lp_evidence_zero_prefixes", "lp_landing_resolutions",
          "lp_landing_resolution_evidence", "lp_evidence_quota_counters",
        ], ["lp_evidence_chunks", "lp_evidence_requirements",
          "lp_evidence_zero_prefixes", "lp_landing_resolution_evidence"]],
      );
      const shape = verified.rows[0];
      if (shape === undefined || !shape.tables_ok || !shape.charge_columns_ok ||
          !shape.legacy_columns_absent || !shape.cleanup_pair_ok || !shape.cleanup_check_ok ||
          !shape.state_checks_ok || !shape.chunk_error_bound_ok ||
          !shape.requirement_generation_ok) {
        throw new Error("LP evidence schema verification failed; refusing to start.");
      }
    });
    return new PostgresLpEvidenceStore(sql, config, now);
  }

  async admitRequirement(input: Parameters<LpEvidenceStore["admitRequirement"]>[0]) {
    assertRequirementInput(input);
    return this.#sql.transaction(async (tx) => {
      const existing = await this.#getRequirement(tx, input);
      if (existing !== null) {
        assertRequirementAdmissionIdentity(existing, input);
        return existing;
      }
      const at = this.#now();
      const charge = requirementChargedLogicalBytes(input);
      const counters = await this.#lockCounters(tx, input.coverageVersion, at);
      const zero = input.expiry === 0n ? 1 : 0;
      if (counters.global.requirementRows + 1 > this.#config.maxRequirements ||
          counters.global.zeroExpiryRows + zero > this.#config.maxZeroExpiryRequirements ||
          counters.global.logicalBytes + charge > BigInt(this.#config.maxGlobalLogicalBytes) ||
          counters.version.logicalBytes + charge > BigInt(this.#config.maxVersionLogicalBytes)) {
        return { unavailable: "storage-quota" } as const;
      }
      const inserted = await tx.query<EvidenceRequirementRow>(
        `/* lpEvidence.requirementInsert */
         insert into lp_evidence_requirements
          (journal_owner,journal_agent,journal_action,journal_idempotency_key,
           begun_at_block,expiry,prepared_identity_hash,coverage_version,quorum_id,lane_id,
           coverage_generation,
           state,unavailable_code,created_at,terminal_at,evidence_retained_until,
           updated_at,row_version,charged_logical_bytes)
         values($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9,$10,
           $11::bigint,'eligible',null,$12,null,null,$12,0,$13::bigint)
         on conflict(journal_owner,journal_agent,journal_action,journal_idempotency_key)
           do nothing returning *`,
        [...requirementParams(input), input.begunAtBlock.toString(10),
          input.expiry.toString(10), input.preparedIdentityHash, input.coverageVersion,
          input.quorumId, input.laneId, (input.coverageGeneration ?? 0n).toString(10),
          new Date(at), charge.toString(10)],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        const raced = await this.#getRequirement(tx, input);
        if (raced === null) throw new Error("Evidence requirement insert lost without a row.");
        assertRequirementAdmissionIdentity(raced, input);
        return raced;
      }
      await this.#updateCounters(tx, input.coverageVersion, charge, 0, 0, 1, zero, at);
      return rowToRequirement(row);
    });
  }

  getRequirement(key: EvidenceRequirementKey): Promise<EvidenceRequirement | null> {
    return this.#getRequirement(this.#sql, key);
  }

  async createOrJoinResolution(input: Parameters<LpEvidenceStore["createOrJoinResolution"]>[0]) {
    assertAction(input.action);
    const resolutionId = resolutionIdFor(input);
    const at = this.#now();
    const inserted = await this.#sql.query<LandingResolutionRow>(
      `/* lpEvidence.resolutionInsert */
       insert into lp_landing_resolutions(
        resolution_id,target_owner,target_agent,target_journal_action,
        target_journal_idempotency_key,prepared_identity_hash,evidence_version,
        claim_initiator_action_owner,claim_initiator_action_agent,
        claim_initiator_action_kind,claim_initiator_action_idempotency_key,
        origin_sequence_id,origin_snapshot_hash,phase,row_version,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'claimed',0,$14,$14)
       on conflict(resolution_id) do nothing returning *`,
      [resolutionId, input.target.journalOwner, input.target.journalAgent,
        input.target.journalAction, input.target.journalIdempotencyKey,
        input.preparedIdentityHash, LANDING_EVIDENCE_VERSION,
        input.action.owner, input.action.agent, input.action.kind,
        input.action.idempotencyKey, input.originSequenceId,
        input.originSnapshotHash, new Date(at)],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return { resolution: rowToResolution(created), created: true };
    const existing = await this.getResolution(resolutionId);
    if (existing === null) throw new Error("Landing resolution conflict without a row.");
    assertResolutionJoin(existing, input);
    return { resolution: existing, created: false };
  }

  async getResolution(id: string): Promise<LandingResolution | null> {
    const result = await this.#sql.query<LandingResolutionRow>(
      `/* lpEvidence.resolutionGet */ select * from lp_landing_resolutions where resolution_id=$1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToResolution(row);
  }

  async getResolutionEvidence(id: string): Promise<LandingEvidenceV1 | null> {
    const result = await this.#sql.query<LandingEvidenceRow>(
      `/* lpEvidence.evidenceGet */ select * from lp_landing_resolution_evidence
       where resolution_id=$1`, [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : JSON.parse(row.evidence_bytes) as LandingEvidenceV1;
  }

  async bindEvidence(input: Parameters<LpEvidenceStore["bindEvidence"]>[0]) {
    assertEvidenceShape(input.evidence);
    if (input.evidence.evidenceDigest !== recomputeEvidenceDigest(input.evidence)) {
      throw new Error("Landing evidence digest is invalid.");
    }
    const canonical = canonicalEvidenceJson(input.evidence);
    const charge = resolutionEvidenceChargedLogicalBytes(input.resolutionId);
    if (ROW_OVERHEAD + BigInt(utf8Bytes(canonical)) > charge) {
      throw new Error("Landing evidence exceeds its immutable maximum-footprint reservation.");
    }
    return this.#sql.transaction(async (tx) => {
      // A charged evidence insert takes the singleton quota fence before the
      // resolution/requirement rows. Reversing these locks deadlocks cleanup
      // or rewind, both of which must acquire the same singleton first.
      const at = this.#now();
      const counters = await this.#lockCounters(tx, input.evidence.coverageVersion, at);
      const current = await this.#lockResolution(tx, input.resolutionId);
      requireResolution(current, input.expectedRowVersion, "claimed");
      if (current.preparedIdentityHash !== input.evidence.preparedIdentityHash) {
        throw new Error("Landing evidence prepared identity is invalid.");
      }
      const requirementRows = await tx.query<EvidenceRequirementRow>(
        `/* lpEvidence.requirementAuthorize */ select * from lp_evidence_requirements where
         journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
         journal_idempotency_key=$4 for update`, requirementParams(current.target),
      );
      const requirementRow = requirementRows.rows[0];
      if (requirementRow === undefined ||
          !requirementAuthorizesEvidence(rowToRequirement(requirementRow), input.evidence)) {
        throw new Error("RESOLUTION_STATE_CONFLICT: evidence requirement is unavailable.");
      }
      if (counters.global.logicalBytes + charge > BigInt(this.#config.maxGlobalLogicalBytes) ||
          counters.version.logicalBytes + charge > BigInt(this.#config.maxVersionLogicalBytes)) {
        throw new Error("LP evidence storage quota exhausted.");
      }
      const evidenceResult = await tx.query<LandingEvidenceRow>(
        `/* lpEvidence.evidenceInsert */
         insert into lp_landing_resolution_evidence(
          resolution_id,evidence_version,evidence_bytes,evidence_hash,coverage_version,
          quorum_id,lane_id,generation,cursor_row_version,retained_until,created_at,
          charged_logical_bytes)
         values($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint,null,$10,$11::bigint)
         on conflict(resolution_id) do nothing returning *`,
        [input.resolutionId, LANDING_EVIDENCE_VERSION, canonical,
          input.evidence.evidenceDigest, input.evidence.coverageVersion,
          input.evidence.quorumId, input.evidence.laneId, input.evidence.generation,
          input.evidence.cursorRowVersion, new Date(at), charge.toString(10)],
      );
      const evidenceRow = evidenceResult.rows[0];
      if (evidenceRow === undefined) throw new Error("Landing evidence already exists.");
      const updated = await tx.query<LandingResolutionRow>(
        `/* lpEvidence.resolutionBindEvidence */
         update lp_landing_resolutions set phase='evidence-bound',outcome=$4,
          response_inference=$4,evidence_hash=$5,row_version=row_version+1,updated_at=$6
         where resolution_id=$1 and row_version=$2 and phase=$3 returning *`,
        [input.resolutionId, input.expectedRowVersion, "claimed", input.evidence.outcome,
          input.evidence.evidenceDigest, new Date(at)],
      );
      const next = updated.rows[0];
      if (next === undefined) throw new Error("Landing resolution phase/version conflict.");
      await this.#updateCounters(tx, input.evidence.coverageVersion, charge, 0, 0, 0, 0, at);
      return { resolution: rowToResolution(next), evidence: rowToEvidence(evidenceRow) };
    });
  }

  async advanceResolution(input: Parameters<LpEvidenceStore["advanceResolution"]>[0]) {
    assertForwardPhase(input.expectedPhase, input.phase);
    const at = this.#now();
    const result = await this.#sql.query<LandingResolutionRow>(
      `/* lpEvidence.resolutionAdvance */
       update lp_landing_resolutions set phase=$4,
        outcome=coalesce($5,outcome),response_inference=coalesce($5,response_inference),
        target_journal_terminal_state=coalesce($6,target_journal_terminal_state),
        sequence_state_at_resolution=coalesce($7,sequence_state_at_resolution),
        recovery_after_confirm=coalesce($8,recovery_after_confirm),
        response_action=coalesce($9,response_action),row_version=row_version+1,updated_at=$10
       where resolution_id=$1 and row_version=$2 and phase=$3 returning *`,
      [input.resolutionId, input.expectedRowVersion, input.expectedPhase, input.phase,
        input.outcome ?? null, input.targetJournalTerminalState ?? null,
        input.sequenceStateAtResolution ?? null, input.recoveryAfterConfirm ?? null,
        input.responseAction ?? null, new Date(at)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Landing resolution phase/version conflict.");
    return rowToResolution(row);
  }

  async terminalize(input: Parameters<LpEvidenceStore["terminalize"]>[0]) {
    assertAction(input.terminalizingAction);
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockResolution(tx, input.resolutionId);
      requireResolution(current, input.expectedRowVersion, "postprocessed");
      if (current.outcome === null || current.evidenceHash === null ||
          current.targetJournalTerminalState === null || current.responseAction === null ||
          current.recoveryAfterConfirm === null) {
        throw new Error("Resolution cannot terminalize before disposition fields are complete.");
      }
      const terminalAt = this.#now();
      const retainedUntil = terminalAt + this.#config.auditRetentionDays * 86_400_000;
      const evidenceResult = await tx.query<LandingEvidenceRow>(
        `/* lpEvidence.evidenceRetain */
         update lp_landing_resolution_evidence set retained_until=$3
         where resolution_id=$1 and evidence_hash=$2 and retained_until is null
         returning *`,
        [input.resolutionId, current.evidenceHash, new Date(retainedUntil)],
      );
      const evidence = evidenceResult.rows[0];
      if (evidence === undefined ||
          ROW_OVERHEAD + BigInt(utf8Bytes(JSON.stringify(rowToEvidence(evidence), bigintJson))) >
            BigInt(evidence.charged_logical_bytes)) {
        throw new Error("Evidence retention charge or state conflict.");
      }
      const currentEvidence = JSON.parse(evidence.evidence_bytes) as LandingEvidenceV1;
      const requirement = await tx.query<EvidenceRequirementRow>(
        `/* lpEvidence.requirementTerminal */
         update lp_evidence_requirements set state='terminal',terminal_at=$5,
          evidence_retained_until=$6,updated_at=$5,row_version=row_version+1
         where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
          journal_idempotency_key=$4 and state='eligible' and unavailable_code is null and
          coverage_generation=$7::bigint and row_version=$8::bigint returning *`,
        [current.target.journalOwner, current.target.journalAgent,
          current.target.journalAction, current.target.journalIdempotencyKey,
          new Date(terminalAt), new Date(retainedUntil),
          currentEvidence.requirementGeneration, currentEvidence.requirementRowVersion],
      );
      if (requirement.rows[0] === undefined) throw new Error("Resolution requirement cannot be terminalized.");
      const result = await tx.query<LandingResolutionRow>(
        `/* lpEvidence.resolutionTerminal */
         update lp_landing_resolutions set phase='terminal',
          sequence_state_at_resolution=$4,terminalizing_action_owner=$5,
          terminalizing_action_agent=$6,terminalizing_action_kind=$7,
          terminalizing_action_idempotency_key=$8,terminal_at=$9,
          evidence_retained_until=$10,row_version=row_version+1,updated_at=$9
         where resolution_id=$1 and row_version=$2 and phase=$3 returning *`,
        [input.resolutionId, input.expectedRowVersion, "postprocessed",
          current.outcome === "landed" ? "active" : "rolled-back",
          input.terminalizingAction.owner, input.terminalizingAction.agent,
          input.terminalizingAction.kind, input.terminalizingAction.idempotencyKey,
          new Date(terminalAt), new Date(retainedUntil)],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Landing resolution terminal CAS conflict.");
      return rowToResolution(row);
    });
  }

  async releaseProvisional(id: string, version: number): Promise<boolean> {
    return this.#sql.transaction(async (tx) => {
      const at = this.#now();
      await tx.query(`/* lpEvidence.releaseQuotaEnsure */ insert into lp_evidence_quota_counters
        (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
         zero_expiry_rows,row_version,updated_at) values('global','',0,0,0,0,0,0,$1)
        on conflict(scope,coverage_version) do nothing`, [new Date(at)]);
      await tx.query(`/* lpEvidence.releaseQuotaGlobal */ select * from
        lp_evidence_quota_counters where scope='global' and coverage_version='' for update`);
      const previewRows = await tx.query<LandingEvidenceRow>(
        `/* lpEvidence.evidencePreview */ select * from lp_landing_resolution_evidence
         where resolution_id=$1`, [id],
      );
      const preview = previewRows.rows[0];
      if (preview !== undefined) {
        await tx.query(`/* lpEvidence.releaseQuotaVersionEnsure */ insert into
          lp_evidence_quota_counters(scope,coverage_version,logical_bytes,block_rows,
           candidate_rows,requirement_rows,zero_expiry_rows,row_version,updated_at)
          values('coverage-version',$1,0,0,0,0,0,0,$2)
          on conflict(scope,coverage_version) do nothing`,
        [preview.coverage_version, new Date(at)]);
        const version = await tx.query<EvidenceQuotaRow>(
          `/* lpEvidence.releaseQuotaVersion */ select * from lp_evidence_quota_counters
           where scope='coverage-version' and coverage_version=$1 for update`,
          [preview.coverage_version]);
        if (version.rows[0] === undefined) throw new Error("Evidence quota row missing.");
      }
      const current = await this.#lockResolution(tx, id);
      if (current === null) return false;
      if (current.rowVersion !== version ||
          (current.phase !== "claimed" && current.phase !== "evidence-bound")) {
        throw new Error("Provisional resolution release conflict.");
      }
      const evidenceRows = await tx.query<LandingEvidenceRow>(
        `/* lpEvidence.evidenceGet */ select * from lp_landing_resolution_evidence
         where resolution_id=$1 for update`, [id],
      );
      const evidence = evidenceRows.rows[0];
      if (evidence !== undefined) {
        if (preview === undefined || preview.evidence_hash !== evidence.evidence_hash) {
          throw new Error("Evidence provisional cleanup changed under its quota fence.");
        }
        const deleted = await tx.query<{ resolution_id: string }>(
          `/* lpEvidence.evidenceDelete */ delete from lp_landing_resolution_evidence
           where resolution_id=$1 and evidence_hash=$2 and charged_logical_bytes=$3::bigint
           returning resolution_id`, [id, evidence.evidence_hash, String(evidence.charged_logical_bytes)],
        );
        if (deleted.rows[0] === undefined) throw new Error("Evidence provisional cleanup conflict.");
        await this.#updateCounters(tx, evidence.coverage_version as Hex,
          -BigInt(evidence.charged_logical_bytes), 0, 0, 0, 0, at);
      }
      const deleted = await tx.query<{ resolution_id: string }>(
        `/* lpEvidence.resolutionDelete */ delete from lp_landing_resolutions
         where resolution_id=$1 and row_version=$2 and phase in ('claimed','evidence-bound')
         returning resolution_id`, [id, version],
      );
      if (deleted.rows[0] === undefined) throw new Error("Provisional resolution release conflict.");
      return true;
    });
  }

  async cleanupRetained(now: number, limit = 1_000): Promise<number> {
    return this.#sql.transaction(async (tx) => {
      // Every charged-row insert takes this singleton first. Holding it before
      // selecting tombstones makes the later citation recheck stable: a new
      // requirement cannot join a shared base lane behind cleanup's back.
      await tx.query(`/* lpEvidence.cleanupQuotaEnsure */ insert into lp_evidence_quota_counters
        (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
         zero_expiry_rows,row_version,updated_at) values('global','',0,0,0,0,0,0,$1)
        on conflict(scope,coverage_version) do nothing`, [new Date(now)]);
      await tx.query(`/* lpEvidence.cleanupQuotaGlobal */ select * from
        lp_evidence_quota_counters where scope='global' and coverage_version='' for update`);
      const rows = await tx.query<LandingResolutionRow>(
        `/* lpEvidence.cleanupSelect */ select * from lp_landing_resolutions
         where phase='terminal' and evidence_retained_until<=$1
          and evidence_cleanup_completed_at is null
         order by evidence_retained_until,resolution_id limit $2`,
        [new Date(now), Math.min(1_000, Math.max(0, limit))],
      );
      // Discover immutable coverage versions with non-locking reads while the
      // global fence prevents charged deletion. Lock every affected version in
      // ASCII order before taking the first resolution/detail row lock.
      const previews = new Map<string, EvidenceRequirement>();
      for (const raw of rows.rows) {
        const resolution = rowToResolution(raw);
        const preview = await this.#getRequirement(tx, resolution.target);
        if (preview === null) throw new Error("Retained evidence cleanup requirement disappeared.");
        previews.set(resolution.resolutionId, preview);
      }
      const versions = [...new Set([...previews.values()].map((row) => row.coverageVersion))]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const version of versions) {
        await tx.query(`/* lpEvidence.cleanupQuotaVersionEnsure */ insert into
          lp_evidence_quota_counters(scope,coverage_version,logical_bytes,block_rows,
           candidate_rows,requirement_rows,zero_expiry_rows,row_version,updated_at)
          values('coverage-version',$1,0,0,0,0,0,0,$2)
          on conflict(scope,coverage_version) do nothing`, [version, new Date(now)]);
      }
      for (const version of versions) {
        const locked = await tx.query<EvidenceQuotaRow>(
          `/* lpEvidence.cleanupQuotaVersion */ select * from lp_evidence_quota_counters
           where scope='coverage-version' and coverage_version=$1 for update`, [version]);
        if (locked.rows[0] === undefined) throw new Error("Evidence quota row missing.");
      }
      const lanes = new Map<Hex, EvidenceRequirement>();
      for (const preview of previews.values()) {
        const prior = lanes.get(preview.laneId);
        if (prior !== undefined && (prior.coverageVersion !== preview.coverageVersion ||
            prior.quorumId !== preview.quorumId)) {
          throw new Error("Retained evidence cleanup lane identity conflict.");
        }
        lanes.set(preview.laneId, preview);
      }
      const orderedLanes = [...lanes.values()].sort((left, right) =>
        left.laneId < right.laneId ? -1 : left.laneId > right.laneId ? 1 : 0);
      for (const lane of orderedLanes) {
        await tx.query(`/* lpEvidence.cleanupCursorLock */ select lane_id from
          lp_evidence_cursors where coverage_version=$1 and quorum_id=$2 and lane_id=$3
          for update`, [lane.coverageVersion, lane.quorumId, lane.laneId]);
        await tx.query(`/* lpEvidence.cleanupLeaseLock */ select lane_id from
          lp_evidence_leases where coverage_version=$1 and quorum_id=$2 and lane_id=$3
          for update`, [lane.coverageVersion, lane.quorumId, lane.laneId]);
      }
      let count = 0;
      for (const raw of rows.rows) {
        let resolution = rowToResolution(raw);
        const previewRequirement = previews.get(resolution.resolutionId);
        if (previewRequirement === undefined) throw new Error("Retained evidence cleanup preview missing.");
        const lockedResolution = await this.#lockResolution(tx, resolution.resolutionId);
        if (lockedResolution === null || lockedResolution.phase !== "terminal" ||
            lockedResolution.evidenceCleanupCompletedAt !== null ||
            lockedResolution.rowVersion !== resolution.rowVersion) {
          throw new Error("Retained evidence cleanup resolution conflict.");
        }
        resolution = lockedResolution;
        const evidenceRows = await tx.query<LandingEvidenceRow>(
          `/* lpEvidence.evidenceGet */ select * from lp_landing_resolution_evidence
           where resolution_id=$1 for update`, [resolution.resolutionId],
        );
        const requirementRows = await tx.query<EvidenceRequirementRow>(
          `/* lpEvidence.requirementGetForUpdate */ select * from lp_evidence_requirements
           where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
            journal_idempotency_key=$4 for update`, requirementParams(resolution.target),
        );
        const prefixRows = await tx.query<{ generation: string; prefix_digest: Hex;
          updated_at: Date | string; charged_logical_bytes: string }>(
          `/* lpEvidence.cleanupPrefixGet */ select generation,prefix_digest,updated_at,
           charged_logical_bytes from lp_evidence_zero_prefixes where journal_owner=$1 and
           journal_agent=$2 and journal_action=$3 and journal_idempotency_key=$4 for update`,
          requirementParams(resolution.target),
        );
        const evidence = evidenceRows.rows[0];
        const requirementRaw = requirementRows.rows[0];
        if (evidence === undefined || requirementRaw === undefined ||
            resolution.evidenceHash !== evidence.evidence_hash) {
          throw new Error("Retained evidence cleanup integrity conflict.");
        }
        const requirement = rowToRequirement(requirementRaw);
        if (requirement.rowVersion !== previewRequirement.rowVersion ||
            requirement.coverageVersion !== previewRequirement.coverageVersion) {
          throw new Error("Retained evidence cleanup requirement conflict.");
        }
        const prefix = prefixRows.rows[0];
        const ownedDebit = requirement.chargedLogicalBytes + BigInt(evidence.charged_logical_bytes) +
          (prefix === undefined ? 0n : BigInt(prefix.charged_logical_bytes));
        const citations = await tx.query<{ citation_count: string | number }>(
          `/* lpEvidence.cleanupLaneCitations */ select
           ((select count(*) from lp_evidence_requirements where lane_id=$1 and not
             (journal_owner=$2 and journal_agent=$3 and journal_action=$4 and
              journal_idempotency_key=$5)) +
            (select count(*) from lp_landing_resolution_evidence where lane_id=$1 and
             resolution_id<>$6)) citation_count`, [requirement.laneId,
            requirement.journalOwner, requirement.journalAgent, requirement.journalAction,
            requirement.journalIdempotencyKey, resolution.resolutionId],
        );
        const laneIsUnshared = Number(citations.rows[0]?.citation_count ?? -1) === 0;
        const cleanupChunks = await tx.query<CleanupChunkRow>(
          `/* lpEvidence.cleanupChunksLock */ select coverage_version,quorum_id,lane_id,generation,
           source_id,from_block,to_block,state,lease_fence,first_hash,last_hash,
           ordered_block_digest,candidate_count,completed_at,error_code,charged_logical_bytes
           from lp_evidence_chunks where lane_id=$1 order by generation,source_id,from_block,to_block
           for update`, [requirement.laneId],
        );
        for (const chunk of cleanupChunks.rows) {
          if (BigInt(chunk.charged_logical_bytes) !==
              evidenceChunkChargedLogicalBytes(chunk.source_id)) {
            throw new Error("Retained evidence cleanup chunk charge conflict.");
          }
        }
        const rawRows = await tx.query<{ block_bytes: string;
          candidate_bytes: string; block_rows: string; candidate_rows: string }>(
          `/* lpEvidence.cleanupRawCharge */ select
           coalesce((select sum(logical_bytes) from lp_evidence_blocks where lane_id=$1),0) block_bytes,
           coalesce((select sum(logical_bytes) from lp_evidence_candidates where lane_id=$1),0) candidate_bytes,
           (select count(*) from lp_evidence_blocks where lane_id=$1) block_rows,
           (select count(*) from lp_evidence_candidates where lane_id=$1) candidate_rows`,
          [requirement.laneId],
        );
        const chargeRow = rawRows.rows[0];
        if (chargeRow === undefined) throw new Error("Retained raw evidence cleanup integrity conflict.");
        const chunkDebit = cleanupChunks.rows.reduce((sum, chunk) =>
          sum + BigInt(chunk.charged_logical_bytes), 0n);
        const rawDebit = laneIsUnshared ? chunkDebit +
          BigInt(chargeRow.block_bytes) + BigInt(chargeRow.candidate_bytes) : 0n;
        const rawBlockRows = laneIsUnshared ? Number(chargeRow.block_rows) : 0;
        const rawCandidateRows = laneIsUnshared ? Number(chargeRow.candidate_rows) : 0;
        const deletedEvidence = await tx.query<{ resolution_id: string }>(
          `/* lpEvidence.evidenceDelete */ delete from lp_landing_resolution_evidence
           where resolution_id=$1 and evidence_hash=$2 and retained_until=$3
            and charged_logical_bytes=$4::bigint returning resolution_id`,
          [resolution.resolutionId, evidence.evidence_hash, evidence.retained_until,
            String(evidence.charged_logical_bytes)],
        );
        const deletedRequirement = await tx.query<{ journal_owner: string }>(
          `/* lpEvidence.requirementDelete */ delete from lp_evidence_requirements
           where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
            journal_idempotency_key=$4 and row_version=$5 and charged_logical_bytes=$6::bigint
           returning journal_owner`,
          [...requirementParams(requirement), requirement.rowVersion,
            requirement.chargedLogicalBytes.toString(10)],
        );
        if (deletedEvidence.rows[0] === undefined || deletedRequirement.rows[0] === undefined) {
          throw new Error("Retained evidence cleanup CAS conflict.");
        }
        if (prefix !== undefined) {
          const deletedPrefix = await tx.query<{ journal_owner: string }>(
            `/* lpEvidence.cleanupPrefixDelete */ delete from lp_evidence_zero_prefixes where
             journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
             journal_idempotency_key=$4 and generation=$5 and prefix_digest=$6 and updated_at=$7 and
             charged_logical_bytes=$8::bigint returning journal_owner`,
            [...requirementParams(requirement), prefix.generation, prefix.prefix_digest,
              prefix.updated_at, prefix.charged_logical_bytes],
          );
          if (deletedPrefix.rows[0] === undefined) {
            throw new Error("Retained zero-prefix cleanup CAS conflict.");
          }
        }
        if (laneIsUnshared) {
          for (const chunk of cleanupChunks.rows) {
            const deletedChunk = await tx.query<{ source_id: string }>(
              `/* lpEvidence.cleanupChunkExact */ delete from lp_evidence_chunks where
               coverage_version=$1 and quorum_id=$2 and lane_id=$3 and generation=$4 and
               source_id=$5 and from_block=$6 and to_block=$7 and state=$8 and
               lease_fence=$9 and first_hash is not distinct from $10 and
               last_hash is not distinct from $11 and ordered_block_digest is not distinct from $12 and
               candidate_count=$13 and completed_at is not distinct from $14 and
               error_code is not distinct from $15 and charged_logical_bytes=$16::bigint
               returning source_id`, [chunk.coverage_version, chunk.quorum_id, chunk.lane_id,
                chunk.generation, chunk.source_id, chunk.from_block, chunk.to_block, chunk.state,
                chunk.lease_fence, chunk.first_hash, chunk.last_hash,
                chunk.ordered_block_digest, chunk.candidate_count, chunk.completed_at,
                chunk.error_code, chunk.charged_logical_bytes],
            );
            if (deletedChunk.rows[0] === undefined) {
              throw new Error("Retained evidence cleanup chunk CAS conflict.");
            }
          }
          await tx.query(`/* lpEvidence.cleanupCandidates */ delete from lp_evidence_candidates
            where lane_id=$1`, [requirement.laneId]);
          await tx.query(`/* lpEvidence.cleanupBlocks */ delete from lp_evidence_blocks
            where lane_id=$1`, [requirement.laneId]);
          await tx.query(`/* lpEvidence.cleanupLease */ delete from lp_evidence_leases
            where lane_id=$1`, [requirement.laneId]);
          await tx.query(`/* lpEvidence.cleanupCursor */ delete from lp_evidence_cursors
            where lane_id=$1`, [requirement.laneId]);
        }
        await this.#updateCounters(tx, requirement.coverageVersion, -(ownedDebit + rawDebit),
          -rawBlockRows, -rawCandidateRows, -1,
          requirement.expiry === 0n ? -1 : 0, now);
        const tombstone = await tx.query<{ resolution_id: string }>(
          `/* lpEvidence.cleanupTombstone */ update lp_landing_resolutions
           set evidence_cleanup_completed_at=$2,evidence_cleanup_charged_bytes=$3::bigint,
             row_version=row_version+1,updated_at=$2
           where resolution_id=$1 and evidence_cleanup_completed_at is null and
             evidence_cleanup_charged_bytes is null returning resolution_id`,
          [resolution.resolutionId, new Date(now), (ownedDebit + rawDebit).toString(10)],
        );
        if (tombstone.rows[0] === undefined) throw new Error("Evidence cleanup tombstone conflict.");
        count += 1;
      }
      return count;
    });
  }

  async quota(): Promise<EvidenceQuotaCounter> {
    const result = await this.#sql.query<EvidenceQuotaRow>(
      `/* lpEvidence.quotaGet */ select * from lp_evidence_quota_counters
       where scope='global' and coverage_version=''`,
    );
    const row = result.rows[0];
    return row === undefined ? emptyCounter(this.#now()) : rowToCounter(row);
  }

  async #getRequirement(sql: SqlClient, key: EvidenceRequirementKey): Promise<EvidenceRequirement | null> {
    const result = await sql.query<EvidenceRequirementRow>(
      `/* lpEvidence.requirementGet */ select * from lp_evidence_requirements
       where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and journal_idempotency_key=$4`,
      requirementParams(key),
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRequirement(row);
  }

  async #lockResolution(sql: SqlClient, id: string): Promise<LandingResolution | null> {
    const result = await sql.query<LandingResolutionRow>(
      `/* lpEvidence.resolutionLock */ select * from lp_landing_resolutions
       where resolution_id=$1 for update`, [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToResolution(row);
  }

  async #lockCounters(sql: SqlClient, version: Hex, now: number): Promise<{
    global: EvidenceQuotaCounter; version: EvidenceQuotaCounter;
  }> {
    await sql.query(
      `/* lpEvidence.quotaEnsure */ insert into lp_evidence_quota_counters
       (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
        zero_expiry_rows,row_version,updated_at)
       values('global','',0,0,0,0,0,0,$2),('coverage-version',$1,0,0,0,0,0,0,$2)
       on conflict(scope,coverage_version) do nothing`, [version, new Date(now)],
    );
    const globalRows = await sql.query<EvidenceQuotaRow>(
      `/* lpEvidence.quotaLockGlobal */ select * from lp_evidence_quota_counters
       where scope='global' and coverage_version='' for update`,
    );
    const versionRows = await sql.query<EvidenceQuotaRow>(
      `/* lpEvidence.quotaLockVersion */ select * from lp_evidence_quota_counters
       where scope='coverage-version' and coverage_version=$1 for update`, [version],
    );
    const global = globalRows.rows[0];
    const versionRow = versionRows.rows[0];
    if (global === undefined || versionRow === undefined) throw new Error("Evidence quota row missing.");
    return { global: rowToCounter(global), version: rowToCounter(versionRow) };
  }

  async #updateCounters(
    sql: SqlClient, version: Hex, bytes: bigint, blocks: number, candidates: number,
    requirements: number, zero: number, now: number,
  ): Promise<void> {
    for (const [scope, key] of [["global", ""], ["coverage-version", version]] as const) {
      const result = await sql.query<{ row_version: string | number }>(
        `/* lpEvidence.quotaUpdate */ update lp_evidence_quota_counters set
          logical_bytes=logical_bytes+$3::bigint,block_rows=block_rows+$4::bigint,
          candidate_rows=candidate_rows+$5::bigint,requirement_rows=requirement_rows+$6::bigint,
          zero_expiry_rows=zero_expiry_rows+$7::bigint,row_version=row_version+1,updated_at=$8
         where scope=$1 and coverage_version=$2 and logical_bytes+$3::bigint>=0 and
          block_rows+$4::bigint>=0 and candidate_rows+$5::bigint>=0 and
          requirement_rows+$6::bigint>=0 and zero_expiry_rows+$7::bigint>=0 returning row_version`,
        [scope, key, bytes.toString(10), blocks, candidates, requirements, zero, new Date(now)],
      );
      if (result.rows[0] === undefined) throw new Error("Evidence quota counter underflow.");
    }
  }

  close(): Promise<void> { return this.#sql.close(); }
}

type DbTime = Date | string | number;
type EvidenceRequirementRow = {
  journal_owner: string; journal_agent: string; journal_action: string;
  journal_idempotency_key: string; begun_at_block: string | number | bigint;
  expiry: string | number | bigint; prepared_identity_hash: Hex;
  coverage_version: Hex; quorum_id: Hex; lane_id: Hex;
  coverage_generation: string | number | bigint;
  state: EvidenceRequirementState; unavailable_code: string | null;
  created_at: DbTime; terminal_at: DbTime | null;
  evidence_retained_until: DbTime | null; updated_at: DbTime;
  row_version: string | number; charged_logical_bytes: string | number | bigint;
};

type LandingResolutionRow = {
  resolution_id: string; target_owner: string; target_agent: string;
  target_journal_action: string; target_journal_idempotency_key: string;
  prepared_identity_hash: Hex; evidence_version: typeof LANDING_EVIDENCE_VERSION;
  claim_initiator_action_owner: string; claim_initiator_action_agent: string;
  claim_initiator_action_kind: "resolveUnknownLandingV1";
  claim_initiator_action_idempotency_key: string;
  origin_sequence_id: string; origin_snapshot_hash: Hex; phase: ResolutionPhase;
  outcome: EvidenceOutcome | null;
  target_journal_terminal_state: "COMMITTED" | "ROLLED_BACK" | null;
  sequence_state_at_resolution: "active" | "rolled-back" | null;
  recovery_after_confirm: LandingResolution["recoveryAfterConfirm"];
  response_action: ResolutionResponseAction | null;
  response_inference: EvidenceOutcome | null; evidence_hash: Hex | null;
  evidence_retained_until: DbTime | null; terminal_at: DbTime | null;
  terminalizing_action_owner: string | null; terminalizing_action_agent: string | null;
  terminalizing_action_kind: "resolveUnknownLandingV1" | null;
  terminalizing_action_idempotency_key: string | null;
  row_version: string | number; created_at: DbTime; updated_at: DbTime;
  evidence_cleanup_completed_at: DbTime | null;
  evidence_cleanup_charged_bytes: string | number | bigint | null;
};

type LandingEvidenceRow = {
  resolution_id: string; evidence_version: typeof LANDING_EVIDENCE_VERSION;
  evidence_bytes: string; evidence_hash: Hex; coverage_version: Hex;
  quorum_id: Hex; lane_id: Hex; generation: string | number | bigint;
  cursor_row_version: string | number; retained_until: DbTime | null;
  created_at: DbTime; charged_logical_bytes: string | number | bigint;
};

type CleanupChunkRow = {
  coverage_version: Hex; quorum_id: Hex; lane_id: Hex;
  generation: string | number | bigint; source_id: string;
  from_block: string | number | bigint; to_block: string | number | bigint;
  state: "pending" | "leased" | "complete" | "gap" | "invalidated";
  lease_fence: string | number | bigint; first_hash: Hex | null;
  last_hash: Hex | null; ordered_block_digest: Hex | null;
  candidate_count: string | number | bigint; completed_at: DbTime | null;
  error_code: string | null; charged_logical_bytes: string | number | bigint;
};

type EvidenceQuotaRow = {
  scope: "global" | "coverage-version"; coverage_version: Hex | "";
  logical_bytes: string | number | bigint; block_rows: string | number;
  candidate_rows: string | number; requirement_rows: string | number;
  zero_expiry_rows: string | number; row_version: string | number;
  updated_at: DbTime;
};

function requirementParams(key: EvidenceRequirementKey, tail: readonly unknown[] = []): unknown[] {
  return [key.journalOwner.toLowerCase(), key.journalAgent, key.journalAction,
    key.journalIdempotencyKey, ...tail];
}

function dbTime(value: DbTime): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error("Invalid evidence timestamp.");
  return parsed;
}

function dbTimeOrNull(value: DbTime | null): number | null {
  return value === null ? null : dbTime(value);
}

function safeCount(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid evidence counter.");
  return parsed;
}

function rowToRequirement(row: EvidenceRequirementRow): EvidenceRequirement {
  return {
    journalOwner: row.journal_owner, journalAgent: row.journal_agent,
    journalAction: row.journal_action, journalIdempotencyKey: row.journal_idempotency_key,
    begunAtBlock: BigInt(row.begun_at_block), expiry: BigInt(row.expiry),
    preparedIdentityHash: row.prepared_identity_hash, coverageVersion: row.coverage_version,
    quorumId: row.quorum_id, laneId: row.lane_id,
    coverageGeneration: BigInt(row.coverage_generation), state: row.state,
    unavailableCode: row.unavailable_code, createdAt: dbTime(row.created_at),
    terminalAt: dbTimeOrNull(row.terminal_at),
    evidenceRetainedUntil: dbTimeOrNull(row.evidence_retained_until),
    updatedAt: dbTime(row.updated_at), rowVersion: safeCount(row.row_version),
    chargedLogicalBytes: BigInt(row.charged_logical_bytes),
  };
}

function rowToResolution(row: LandingResolutionRow): LandingResolution {
  const terminalizingAction = row.terminalizing_action_owner === null ? null : {
    owner: row.terminalizing_action_owner,
    agent: requireString(row.terminalizing_action_agent, "terminalizing action agent"),
    kind: requireLandingKind(row.terminalizing_action_kind),
    idempotencyKey: requireString(
      row.terminalizing_action_idempotency_key,
      "terminalizing action idempotency key",
    ),
  };
  return {
    resolutionId: row.resolution_id,
    target: { journalOwner: row.target_owner, journalAgent: row.target_agent,
      journalAction: row.target_journal_action,
      journalIdempotencyKey: row.target_journal_idempotency_key },
    preparedIdentityHash: row.prepared_identity_hash,
    evidenceVersion: row.evidence_version,
    claimInitiator: { owner: row.claim_initiator_action_owner,
      agent: row.claim_initiator_action_agent, kind: row.claim_initiator_action_kind,
      idempotencyKey: row.claim_initiator_action_idempotency_key },
    originSequenceId: row.origin_sequence_id, originSnapshotHash: row.origin_snapshot_hash,
    phase: row.phase, outcome: row.outcome,
    targetJournalTerminalState: row.target_journal_terminal_state,
    sequenceStateAtResolution: row.sequence_state_at_resolution,
    recoveryAfterConfirm: row.recovery_after_confirm,
    responseAction: row.response_action, responseInference: row.response_inference,
    evidenceHash: row.evidence_hash,
    evidenceRetainedUntil: dbTimeOrNull(row.evidence_retained_until),
    terminalAt: dbTimeOrNull(row.terminal_at), terminalizingAction,
    rowVersion: safeCount(row.row_version), createdAt: dbTime(row.created_at),
    updatedAt: dbTime(row.updated_at),
    evidenceCleanupCompletedAt: dbTimeOrNull(row.evidence_cleanup_completed_at),
    evidenceCleanupChargedBytes: row.evidence_cleanup_charged_bytes === null
      ? null : BigInt(row.evidence_cleanup_charged_bytes),
  };
}

function rowToEvidence(row: LandingEvidenceRow): LandingResolutionEvidence {
  return {
    resolutionId: row.resolution_id, evidenceVersion: row.evidence_version,
    evidenceBytes: row.evidence_bytes, evidenceHash: row.evidence_hash,
    coverageVersion: row.coverage_version, quorumId: row.quorum_id,
    laneId: row.lane_id, generation: BigInt(row.generation),
    cursorRowVersion: safeCount(row.cursor_row_version),
    retainedUntil: dbTimeOrNull(row.retained_until), createdAt: dbTime(row.created_at),
    chargedLogicalBytes: BigInt(row.charged_logical_bytes),
  };
}

function rowToCounter(row: EvidenceQuotaRow): EvidenceQuotaCounter {
  return {
    coverageVersion: row.coverage_version, logicalBytes: BigInt(row.logical_bytes),
    blockRows: safeCount(row.block_rows), candidateRows: safeCount(row.candidate_rows),
    requirementRows: safeCount(row.requirement_rows),
    zeroExpiryRows: safeCount(row.zero_expiry_rows), rowVersion: safeCount(row.row_version),
    updatedAt: dbTime(row.updated_at),
  };
}

function emptyCounter(now: number): EvidenceQuotaCounter {
  return { coverageVersion: "", logicalBytes: 0n, blockRows: 0, candidateRows: 0,
    requirementRows: 0, zeroExpiryRows: 0, rowVersion: 0, updatedAt: now };
}

function requireResolution(
  value: LandingResolution | null,
  version: number,
  phase: ResolutionPhase,
): asserts value is LandingResolution {
  if (value === null || value.rowVersion !== version || value.phase !== phase) {
    throw new Error("Landing resolution phase/version conflict.");
  }
}

function assertResolutionJoin(
  value: LandingResolution,
  input: Parameters<LpEvidenceStore["createOrJoinResolution"]>[0],
): void {
  if (value.preparedIdentityHash !== input.preparedIdentityHash ||
      value.target.journalOwner !== input.target.journalOwner ||
      value.target.journalAgent !== input.target.journalAgent ||
      value.target.journalAction !== input.target.journalAction ||
      value.target.journalIdempotencyKey !== input.target.journalIdempotencyKey ||
      (value.phase !== "terminal" && (value.originSequenceId !== input.originSequenceId ||
       value.originSnapshotHash !== input.originSnapshotHash)) ||
      value.evidenceVersion !== LANDING_EVIDENCE_VERSION) {
    throw new Error("Landing resolution join identity conflict.");
  }
}

function requireString(value: string | null, label: string): string {
  if (value === null) throw new Error(`Missing ${label}.`);
  return value;
}

function requireLandingKind(
  value: "resolveUnknownLandingV1" | null,
): "resolveUnknownLandingV1" {
  if (value !== "resolveUnknownLandingV1") throw new Error("Invalid landing action kind.");
  return value;
}

export async function createLpEvidenceStore(
  config: LpEvidenceConfig,
  databaseUrl: string | undefined = process.env["DATABASE_URL"],
  memoryRegistry?: MemoryEvidenceRequirementRegistry,
): Promise<LpEvidenceStore> {
  const url = databaseUrl?.trim() ?? "";
  if (url === "") return new MemoryLpEvidenceStore(config, Date.now, memoryRegistry);
  return PostgresLpEvidenceStore.create(await createPgSqlClient(url), config);
}

function requirementMapKey(key: EvidenceRequirementKey): string {
  return [key.journalOwner.toLowerCase(), key.journalAgent, key.journalAction,
    key.journalIdempotencyKey].join("\u0000");
}

function assertRequirementInput(input: Omit<EvidenceRequirement,
  "state" | "unavailableCode" | "createdAt" | "terminalAt" |
  "evidenceRetainedUntil" | "updatedAt" | "rowVersion" | "chargedLogicalBytes"
>): void {
  if (input.begunAtBlock < 0n || input.expiry < 0n ||
      (input.coverageGeneration !== undefined && input.coverageGeneration < 0n) ||
      !/^0x[0-9a-f]{64}$/.test(input.preparedIdentityHash) ||
      !/^0x[0-9a-f]{64}$/.test(input.coverageVersion) ||
      !/^0x[0-9a-f]{64}$/.test(input.quorumId) || !/^0x[0-9a-f]{64}$/.test(input.laneId)) {
    throw new Error("Evidence requirement identity is malformed.");
  }
}

function assertRequirementAdmissionIdentity(
  existing: EvidenceRequirement,
  input: Omit<EvidenceRequirement, "state" | "unavailableCode" | "createdAt" | "terminalAt" |
    "evidenceRetainedUntil" | "updatedAt" | "rowVersion" | "chargedLogicalBytes">,
): void {
  if (existing.journalOwner.toLowerCase() !== input.journalOwner.toLowerCase() ||
      existing.journalAgent !== input.journalAgent ||
      existing.journalAction !== input.journalAction ||
      existing.journalIdempotencyKey !== input.journalIdempotencyKey ||
      existing.begunAtBlock !== input.begunAtBlock || existing.expiry !== input.expiry ||
      existing.preparedIdentityHash !== input.preparedIdentityHash ||
      existing.coverageVersion !== input.coverageVersion || existing.quorumId !== input.quorumId ||
      existing.laneId !== input.laneId) {
    throw new Error("Evidence requirement identity conflict.");
  }
}

function assertAction(action: ResolutionActionIdentity): void {
  if (action.kind !== "resolveUnknownLandingV1" || action.idempotencyKey.length > 128 ||
      action.owner.toLowerCase() !== action.owner || action.owner.length !== 42) {
    throw new Error("Landing resolver action identity is malformed.");
  }
}

function assertForwardPhase(from: ResolutionPhase, to: ResolutionPhase): void {
  const order: readonly ResolutionPhase[] = [
    "claimed", "evidence-bound", "disposition-started", "journal-written",
    "recovery-written", "postprocessed", "terminal",
  ];
  if (order.indexOf(to) !== order.indexOf(from) + 1) {
    throw new Error(`Illegal landing resolution phase ${from} -> ${to}.`);
  }
}

function assertEvidenceShape(input: Omit<LandingEvidenceV1, "evidenceDigest"> | LandingEvidenceV1): void {
  if (input.scheme !== LANDING_EVIDENCE_VERSION || input.requiredSourceIds.length < 2 ||
      [...input.requiredSourceIds].sort().join("|") !== input.requiredSourceIds.join("|") ||
      BigInt(input.fromBlock) > BigInt(input.toBlock) ||
      input.requirementState !== "eligible" || input.requirementUnavailableCode !== null ||
      input.requirementGeneration === undefined || input.requirementRowVersion === undefined ||
      BigInt(input.requirementGeneration) !== BigInt(input.generation) ||
      BigInt(input.requirementRowVersion) < 0n ||
      (input.outcome === "landed") !== (input.landed !== undefined) ||
      (input.outcome === "absent") !== (input.absent !== undefined)) {
    throw new Error("Landing evidence has an invalid canonical shape.");
  }
  if (input.outcome === "absent" && input.absent !== undefined &&
      input.absent.zeroMatchCount !== 0) {
    throw new Error("Absent evidence must carry exactly zero matches.");
  }
}

function recomputeEvidenceDigest(evidence: LandingEvidenceV1): Hex {
  const { evidenceDigest: _ignored, ...without } = evidence;
  return landingEvidenceDigest(without);
}

/** Section 4.3's evidence digest. JSON is deliberately not part of identity. */
function landingEvidenceDigest(
  evidence: Omit<LandingEvidenceV1, "evidenceDigest">,
): Hex {
  const common = [
    encodeText("4lpha:lp-evidence:snapshot:v1"),
    encodeText(evidence.outcome),
    encodeHash(evidence.preparedIdentityHash),
    encodeHash(evidence.coverageVersion),
    encodeHash(evidence.quorumId),
    encodeHash(evidence.laneId),
    u64be(BigInt(evidence.generation)),
    u64be(BigInt(evidence.cursorRowVersion)),
    encodeText(evidence.requirementState ?? ""),
    encodeText(evidence.requirementUnavailableCode ?? ""),
    u64be(BigInt(evidence.requirementGeneration ?? "0")),
    u64be(BigInt(evidence.requirementRowVersion ?? "0")),
    encodeTextArray(evidence.requiredSourceIds),
    u64be(BigInt(evidence.fromBlock)),
    u64be(BigInt(evidence.toBlock)),
    encodeHash(evidence.toBlockHash),
  ];
  const outcome = evidence.outcome === "landed" && evidence.landed !== undefined
    ? [
        encodeHash(evidence.landed.txHash), encodeHash(evidence.landed.inputHash),
        u64be(BigInt(evidence.landed.blockNumber)), encodeHash(evidence.landed.blockHash),
        u64be(BigInt(evidence.landed.transactionIndex)),
        u64be(BigInt(evidence.landed.intentIndex)), u64be(BigInt(evidence.landed.logIndex)),
        encodeHash(evidence.landed.eventTopicsHash), encodeHash(evidence.landed.eventDataHash),
      ]
    : evidence.absent === undefined
      ? []
      : [
          u64be(BigInt(evidence.absent.toBlockTimestamp)),
          u64be(BigInt(evidence.absent.expirySafetySeconds)),
          u64be(BigInt(evidence.absent.zeroMatchCount)),
        ];
  return keccak256(bytesToHex(concatBytes([...common, ...outcome])));
}

export function canonicalEvidenceJson(evidence: LandingEvidenceV1): string {
  const common = {
    scheme: evidence.scheme,
    outcome: evidence.outcome,
    preparedIdentityHash: evidence.preparedIdentityHash,
    coverageVersion: evidence.coverageVersion,
    quorumId: evidence.quorumId,
    laneId: evidence.laneId,
    generation: evidence.generation,
    cursorRowVersion: evidence.cursorRowVersion,
    requirementState: evidence.requirementState,
    requirementUnavailableCode: evidence.requirementUnavailableCode,
    requirementGeneration: evidence.requirementGeneration,
    requirementRowVersion: evidence.requirementRowVersion,
    requiredSourceIds: [...evidence.requiredSourceIds],
    fromBlock: evidence.fromBlock,
    toBlock: evidence.toBlock,
    toBlockHash: evidence.toBlockHash,
    evidenceDigest: evidence.evidenceDigest,
  };
  return JSON.stringify(evidence.outcome === "landed"
    ? { ...common, landed: evidence.landed }
    : { ...common, absent: evidence.absent });
}

function assertRequirementWithinReservedCharge(
  value: EvidenceRequirement,
  charge: bigint,
): void {
  if (charge !== requirementChargedLogicalBytes(value) ||
      utf8Bytes(value.unavailableCode ?? "") > 128 ||
      value.journalOwner.length !== 42 || value.journalAgent.length > 128 ||
      value.journalAction.length > 128 || value.journalIdempotencyKey.length > 128) {
    throw new Error("Mutable evidence row exceeds its immutable reserved charge.");
  }
}

function requirementAuthorizesEvidence(
  requirement: EvidenceRequirement,
  evidence: LandingEvidenceV1,
): boolean {
  return requirement.state === "eligible" && requirement.unavailableCode === null &&
    (requirement.coverageGeneration ?? 0n).toString(10) === evidence.requirementGeneration &&
    requirement.rowVersion.toString(10) === evidence.requirementRowVersion &&
    requirement.coverageVersion === evidence.coverageVersion &&
    requirement.quorumId === evidence.quorumId && requirement.laneId === evidence.laneId &&
    requirement.preparedIdentityHash === evidence.preparedIdentityHash &&
    requirement.begunAtBlock.toString(10) === evidence.fromBlock;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value;
}

function encodeText(value: string): Uint8Array {
  const body = new TextEncoder().encode(value);
  if (body.length > 0xffff_ffff) throw new Error("Evidence text exceeds u32 length.");
  return concatBytes([u32be(body.length), body]);
}

function encodeAddress(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Evidence address is malformed.");
  return hexToBytes(value.toLowerCase() as Hex);
}

function encodeHash(value: Hex): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error("Evidence hash is malformed.");
  return hexToBytes(value);
}

function encodeTextArray(values: readonly string[]): Uint8Array {
  return concatBytes([u32be(values.length), ...values.map(encodeText)]);
}

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64be(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Evidence uint64 is out of range.");
  }
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(value >> 32n), false);
  view.setUint32(4, Number(value & 0xffff_ffffn), false);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

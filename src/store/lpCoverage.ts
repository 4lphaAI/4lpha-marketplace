/** Durable Phase 3.9c coverage cursor and candidate ledger. */
import { type Address, type Hex } from "viem";
import type { LpEvidenceConfig } from "../ops/config.js";
import {
  canonicalLandingEvidence,
  evidenceRequirementKeyHash,
  MemoryEvidenceRequirementRegistry,
  type EvidenceRequirement,
  type LandingEvidenceV1,
} from "./lpEvidence.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import type { PreparedIntentIdentityV1 } from "../lp/preparedIntent.js";
import { chunkDigest, evidenceChunkChargedLogicalBytes, zeroPrefixCarryDigest,
  zeroPrefixDigests } from "../lp/evidenceDigests.js";

export type CoverageLane = {
  readonly coverageVersion: Hex;
  readonly quorumId: Hex;
  readonly laneId: Hex;
  readonly purpose: "base" | "backfill";
  readonly admissionKeyHash: Hex;
  readonly originBlock: bigint;
  readonly coveredThrough: bigint | null;
  readonly coveredThroughHash: Hex | null;
  readonly coveredThroughTimestamp: bigint | null;
  readonly rawRetainedFrom: bigint;
  readonly generation: bigint;
  readonly state: "active" | "gap" | "invalidated" | "exhausted";
  readonly rowVersion: number;
};

export type CoverageCandidate = {
  readonly txHash: Hex;
  readonly inputHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly intentIndex: number;
  readonly memberCount: number;
  readonly eoa: Address;
  readonly nonce: bigint;
  readonly executionDataHash: Hex;
  readonly keyHash: Hex;
  /** Defaults to the successful tuple for callers constructing proven candidates. */
  readonly receiptStatus?: bigint;
  readonly incremented?: boolean;
  readonly eventError?: Hex;
  readonly logIndex: bigint;
  readonly eventTopicsHash: Hex;
  readonly eventDataHash: Hex;
  readonly candidateDigest: Hex;
};

export type AgreedCoverageBlock = {
  readonly number: bigint;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: bigint;
  readonly orderedTransactionDigest: Hex;
};

export type CommitCoverageRange = {
  readonly lane: CoverageLane;
  readonly lease: CoverageLease;
  readonly expectedRowVersion: number;
  readonly blocks: readonly AgreedCoverageBlock[];
  readonly sourceChunkDigests: Readonly<Record<string, Hex>>;
  readonly candidates: readonly CoverageCandidate[];
  readonly now: number;
};

export type CoverageLease = {
  readonly holderId: string;
  readonly fence: bigint;
  readonly leaseUntil: number;
};
export type CoveragePrefixBoundary = { readonly toBlock: bigint; readonly toBlockHash: Hex };
export type CoveragePrefixProof = CoveragePrefixBoundary & { readonly agreed: boolean };
export type CoverageSnapshot = LandingEvidenceV1 | {
  readonly outcome: "ambiguous";
  readonly reason: "multiple-matching-candidates" | "matching-candidate-not-successful";
};

export interface LpCoverageStore {
  ensureLane(input: Omit<CoverageLane,
    "coveredThrough" | "coveredThroughHash" | "coveredThroughTimestamp" |
    "rawRetainedFrom" | "generation" | "state" | "rowVersion"
  >): Promise<CoverageLane>;
  listActiveLanes(limit?: number): Promise<readonly CoverageLane[]>;
  findAdmissionLane(input: { readonly coverageVersion: Hex; readonly quorumId: Hex;
    readonly begunAtBlock: bigint; readonly admissionKeyHash: Hex }): Promise<CoverageLane | null>;
  findBaseLane(input: { readonly coverageVersion: Hex; readonly quorumId: Hex;
    readonly begunAtBlock: bigint }): Promise<CoverageLane | null>;
  claimLease(lane: CoverageLane, holderId: string, now: number,
    leaseUntil: number): Promise<CoverageLease | null>;
  reserveBackfillBlocks(coverageVersion: Hex, blocks: number, now: number,
    hourlyLimit: number): Promise<boolean>;
  registerRequirement(requirement: EvidenceRequirement): Promise<EvidenceRequirement>;
  compactZeroExpiry(lane: CoverageLane, lease: CoverageLease, now: number): Promise<number>;
  commitAgreedRange(input: CommitCoverageRange): Promise<CoverageLane>;
  markGap(lane: CoverageLane, lease: CoverageLease): Promise<void>;
  recentBlocks(lane: CoverageLane, limit: number): Promise<readonly AgreedCoverageBlock[]>;
  prefixBoundaries(lane: CoverageLane): Promise<readonly CoveragePrefixBoundary[]>;
  rewind(lane: CoverageLane, ancestor: AgreedCoverageBlock | null,
    lease: CoverageLease, prefixProofs?: readonly CoveragePrefixProof[]): Promise<CoverageLane>;
  snapshot(input: {
    readonly requirement: EvidenceRequirement;
    readonly identity: PreparedIntentIdentityV1;
    readonly requiredSourceIds: readonly string[];
    readonly expirySafetySeconds: number;
  }): Promise<CoverageSnapshot | null>;
  validate(evidence: CoverageSnapshot): Promise<boolean>;
  /** Memory-only citation fence used by the no-SQL resolver test/dev composition. */
  withCurrentEvidence?<T>(evidence: LandingEvidenceV1,
    mutation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type MemoryChunk = { readonly generation: bigint;
  readonly state: "complete" | "invalidated";
  readonly from: bigint; readonly to: bigint; readonly charge: bigint;
  readonly firstHash: Hex; readonly lastHash: Hex; readonly candidateCount: number;
  readonly sourceChunkDigests: Readonly<Record<string, Hex>> };
type MemoryLane = { lane: CoverageLane; blocks: AgreedCoverageBlock[];
  candidates: CoverageCandidate[]; chunks: MemoryChunk[];
  archivedRaw: { readonly generation: bigint; readonly blocks: readonly AgreedCoverageBlock[];
    readonly candidates: readonly CoverageCandidate[] }[] };
type MemoryRewindState = {
  readonly lanes: Map<string, MemoryLane>;
  readonly logicalBytes: bigint;
  readonly versionBytes: Map<Hex, bigint>;
  readonly versionBlockRows: Map<Hex, number>;
  readonly versionCandidateRows: Map<Hex, number>;
  readonly requirements: Map<string, EvidenceRequirement>;
  readonly zeroPrefixes: Map<string, { from: bigint; to: bigint; digest: Hex;
    toBlockHash: Hex; generation: bigint; sourceAccumulator: Hex; charge: bigint }>;
};

export class MemoryLpCoverageStore implements LpCoverageStore {
  readonly #lanes = new Map<string, MemoryLane>();
  readonly #config: LpEvidenceConfig | undefined;
  #logicalBytes = 0n;
  readonly #versionBytes = new Map<Hex, bigint>();
  readonly #versionBlockRows = new Map<Hex, number>();
  readonly #versionCandidateRows = new Map<Hex, number>();
  readonly #leases = new Map<Hex, CoverageLease>();
  readonly #backfillBudgets = new Map<string, number>();
  readonly #requirements: Map<string, EvidenceRequirement>;
  readonly #strictRequirementAuthorization: boolean;
  readonly #zeroPrefixes = new Map<string, { from: bigint; to: bigint; digest: Hex;
    toBlockHash: Hex; generation: bigint; sourceAccumulator: Hex; charge: bigint }>();
  readonly #citationLocks = new Map<Hex, number>();
  constructor(config?: LpEvidenceConfig,
    registry: MemoryEvidenceRequirementRegistry = new MemoryEvidenceRequirementRegistry(),
    strictRequirementAuthorization = false) {
    this.#config = config;
    this.#requirements = registry.requirements;
    this.#strictRequirementAuthorization = strictRequirementAuthorization;
  }

  async ensureLane(input: Omit<CoverageLane,
    "coveredThrough" | "coveredThroughHash" | "coveredThroughTimestamp" |
    "rawRetainedFrom" | "generation" | "state" | "rowVersion"
  >): Promise<CoverageLane> {
    const old = this.#lanes.get(input.laneId);
    if (old !== undefined) return old.lane;
    const lane: CoverageLane = { ...input, coveredThrough: null, coveredThroughHash: null,
      coveredThroughTimestamp: null, rawRetainedFrom: input.originBlock, generation: 0n,
      state: "active", rowVersion: 0 };
    this.#lanes.set(input.laneId, { lane, blocks: [], candidates: [], chunks: [], archivedRaw: [] });
    return lane;
  }

  async listActiveLanes(limit = 100): Promise<readonly CoverageLane[]> {
    return [...this.#lanes.values()].map((row) => row.lane)
      .filter((lane) => (lane.state === "active" || lane.state === "gap") &&
        [...this.#requirements.values()].some((requirement) =>
          requirement.laneId === lane.laneId && requirement.state === "eligible" &&
          requirement.unavailableCode === null &&
          (requirement.coverageGeneration ?? 0n) === lane.generation))
      .sort((a, b) => a.originBlock < b.originBlock ? -1 : 1).slice(0, limit);
  }

  async findAdmissionLane(input: { readonly coverageVersion: Hex; readonly quorumId: Hex;
    readonly begunAtBlock: bigint; readonly admissionKeyHash: Hex }): Promise<CoverageLane | null> {
    const lanes = [...this.#lanes.values()].map((row) => row.lane).filter((lane) =>
      lane.coverageVersion === input.coverageVersion && lane.quorumId === input.quorumId &&
      lane.state === "active" && lane.originBlock <= input.begunAtBlock &&
      lane.rawRetainedFrom <= input.begunAtBlock && (lane.purpose === "base" ||
        lane.admissionKeyHash === input.admissionKeyHash));
    return lanes.sort((a, b) => a.originBlock > b.originBlock ? -1 : 1)[0] ?? null;
  }

  async findBaseLane(input: { readonly coverageVersion: Hex; readonly quorumId: Hex;
    readonly begunAtBlock: bigint }): Promise<CoverageLane | null> {
    const lanes = [...this.#lanes.values()].map((row) => row.lane).filter((lane) =>
      lane.coverageVersion === input.coverageVersion && lane.quorumId === input.quorumId &&
      lane.purpose === "base" && lane.originBlock <= input.begunAtBlock);
    return lanes.sort((a, b) => a.originBlock > b.originBlock ? -1 : 1)[0] ?? null;
  }

  async claimLease(lane: CoverageLane, holderId: string, now: number,
    leaseUntil: number): Promise<CoverageLease | null> {
    if (leaseUntil <= now) throw new Error("LP_EVIDENCE_LEASE_RANGE");
    const stored = this.#lanes.get(lane.laneId);
    if (stored === undefined || stored.lane.generation !== lane.generation ||
        stored.lane.rowVersion !== lane.rowVersion) return null;
    const current = this.#leases.get(lane.laneId);
    if (current !== undefined && current.leaseUntil > now && current.holderId !== holderId) return null;
    const lease = { holderId, fence: (current?.fence ?? 0n) + 1n, leaseUntil };
    this.#leases.set(lane.laneId, lease);
    return lease;
  }

  async reserveBackfillBlocks(coverageVersion: Hex, blocks: number, now: number,
    hourlyLimit: number): Promise<boolean> {
    if (!Number.isSafeInteger(blocks) || blocks <= 0) throw new Error("LP_EVIDENCE_BACKFILL_RANGE");
    const hour = Math.floor(now / 3_600_000);
    const key = `${coverageVersion}:${hour}`;
    const current = this.#backfillBudgets.get(key) ?? 0;
    if (current + blocks > hourlyLimit) return false;
    this.#backfillBudgets.set(key, current + blocks);
    for (const old of this.#backfillBudgets.keys()) {
      const oldHour = Number(old.slice(old.lastIndexOf(":") + 1));
      if (oldHour < hour - 1) this.#backfillBudgets.delete(old);
    }
    return true;
  }

  async registerRequirement(requirement: EvidenceRequirement): Promise<EvidenceRequirement> {
    const key = requirementKey(requirement);
    const existing = this.#requirements.get(key);
    if (existing !== undefined) {
      assertSameRequirementIdentity(existing, requirement);
      // Generic observer registration is intentionally monotonic. In
      // particular, a stale admitted `eligible` object cannot repair an
      // unavailable generation; no implicit eligibility-repair edge exists.
      return existing;
    }
    const registered = { ...requirement,
      coverageGeneration: requirement.coverageGeneration ?? 0n };
    this.#requirements.set(key, registered);
    return registered;
  }

  async compactZeroExpiry(lane: CoverageLane, lease: CoverageLease, now: number): Promise<number> {
    this.#assertCitationUnlocked(lane.laneId);
    const stored = this.#lanes.get(lane.laneId);
    if (stored === undefined || stored.lane.rowVersion !== lane.rowVersion ||
        stored.lane.generation !== lane.generation || stored.lane.coveredThrough === null) return 0;
    this.#assertLease(lane, lease, now);
    const requirements = [...this.#requirements.values()].filter((row) =>
      row.laneId === lane.laneId);
    // Raw rows are shared. Conservative compaction waits until this lane has a
    // single live exact identity; a shared lane remains fully retained.
    if (requirements.length !== 1) return 0;
    const requirement = requirements[0];
    if (requirement === undefined || requirement.expiry !== 0n ||
        requirement.state !== "eligible" || requirement.unavailableCode !== null ||
        (requirement.coverageGeneration ?? 0n) !== lane.generation ||
        stored.lane.coveredThrough < 257n) return 0;
    const cutoff = stored.lane.coveredThrough - 257n;
    const prefixKey = requirementKey(requirement);
    const prior = this.#zeroPrefixes.get(prefixKey);
    const from = prior === undefined ? requirement.begunAtBlock : prior.to + 1n;
    if (from !== stored.lane.rawRetainedFrom) return 0;
    const requiredIds = this.#config?.sources.filter((source) => source.role === "required")
      .map((source) => source.id).sort();
    const compactable: MemoryChunk[] = [];
    let expectedFrom = from;
    for (const chunk of stored.chunks.filter((row) => row.generation === lane.generation &&
      row.state === "complete").sort((left, right) =>
      left.from < right.from ? -1 : left.from > right.from ? 1 : 0)) {
      if (chunk.to > cutoff) break;
      if (chunk.from !== expectedFrom || (requiredIds !== undefined &&
          Object.keys(chunk.sourceChunkDigests).sort().join("\u0000") !==
            requiredIds.join("\u0000"))) break;
      compactable.push(chunk);
      expectedFrom = chunk.to + 1n;
    }
    const to = compactable.at(-1)?.to;
    if (to === undefined || stored.candidates.some((row) =>
      row.blockNumber >= from && row.blockNumber <= to)) return 0;
    const toBlock = stored.blocks.find((block) => block.number === to);
    if (toBlock === undefined) return 0;
    const sourceChunkDigests = Object.fromEntries(compactable.flatMap((chunk) =>
      Object.entries(chunk.sourceChunkDigests).map(([id, digest]) =>
        [`${chunk.from}:${chunk.to}:${id}`, digest]))) as Readonly<Record<string, Hex>>;
    const digests = zeroPrefixDigests({ ...(prior === undefined ? {} : {
      priorPrefixDigest: prior.digest, priorSourceAccumulator: prior.sourceAccumulator,
    }),
      requirement, generation: lane.generation, fromBlock: from, toBlock: to,
      toBlockHash: toBlock.hash, sourceChunkDigests });
    const prefixCharge = prior?.charge ?? zeroPrefixChargedLogicalBytes(requirement);
    const sourceIds = requiredIds ?? Object.keys(compactable[0]?.sourceChunkDigests ?? {});
    const removedBlocks = stored.blocks.filter((block) => block.number >= from && block.number <= to);
    const removedCandidates = stored.candidates.filter((row) =>
      row.blockNumber >= from && row.blockNumber <= to);
    const debit = compactable.reduce((sum, row) => sum + row.charge, 0n) +
      sourceIds.reduce((sum, id) => sum + removedBlocks.reduce((part, block) =>
        part + blockLogicalBytes(id, block), 0n) + removedCandidates.reduce((part, candidate) =>
        part + candidateLogicalBytes(id, candidate), 0n), 0n);
    const delta = (prior === undefined ? prefixCharge : 0n) - debit;
    const versionBytes = (this.#versionBytes.get(lane.coverageVersion) ?? 0n) + delta;
    if (this.#logicalBytes + delta < 0n || versionBytes < 0n ||
        (this.#config !== undefined && (this.#logicalBytes + delta >
          BigInt(this.#config.maxGlobalLogicalBytes) || versionBytes >
          BigInt(this.#config.maxVersionLogicalBytes)))) throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
    this.#zeroPrefixes.set(prefixKey, { from: prior?.from ?? from, to,
      digest: digests.prefixDigest, toBlockHash: toBlock.hash, generation: lane.generation,
      sourceAccumulator: digests.sourceAccumulator,
      charge: prefixCharge });
    const nextLane = { ...stored.lane, rawRetainedFrom: to + 1n,
      rowVersion: stored.lane.rowVersion + 1 };
    this.#lanes.set(lane.laneId, { lane: nextLane,
      blocks: stored.blocks.filter((block) => block.number > to),
      candidates: stored.candidates.filter((candidate) => candidate.blockNumber > to),
      chunks: stored.chunks.filter((chunk) => chunk.generation !== lane.generation ||
        chunk.state !== "complete" || chunk.to > to), archivedRaw: stored.archivedRaw });
    this.#logicalBytes += delta;
    this.#versionBytes.set(lane.coverageVersion, versionBytes);
    this.#versionBlockRows.set(lane.coverageVersion,
      (this.#versionBlockRows.get(lane.coverageVersion) ?? 0) - removedBlocks.length * sourceIds.length);
    this.#versionCandidateRows.set(lane.coverageVersion,
      (this.#versionCandidateRows.get(lane.coverageVersion) ?? 0) - removedCandidates.length * sourceIds.length);
    return 1;
  }

  async commitAgreedRange(input: CommitCoverageRange): Promise<CoverageLane> {
    const stored = this.#lanes.get(input.lane.laneId);
    if (stored === undefined || stored.lane.rowVersion !== input.expectedRowVersion ||
        stored.lane.generation !== input.lane.generation) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
    this.#assertLease(input.lane, input.lease, input.now);
    const first = input.blocks[0];
    const last = input.blocks.at(-1);
    const next = stored.lane.coveredThrough === null
      ? stored.lane.originBlock : stored.lane.coveredThrough + 1n;
    if (first === undefined || last === undefined || first.number !== next ||
        input.blocks.some((block, index) => block.number !== first.number + BigInt(index)) ||
        (stored.lane.coveredThroughHash !== null && first.parentHash !== stored.lane.coveredThroughHash)) {
      throw new Error("LP_EVIDENCE_NONCONTIGUOUS_RANGE");
    }
    const sourceIds = Object.keys(input.sourceChunkDigests).sort();
    const expectedSources = this.#config?.sources.filter((source) => source.role === "required")
      .map((source) => source.id).sort();
    if (sourceIds.length < 2 || (expectedSources !== undefined &&
        sourceIds.join("\u0000") !== expectedSources.join("\u0000"))) {
      throw new Error("LP_EVIDENCE_QUORUM_INCOMPLETE");
    }
    if ((this.#config !== undefined && input.blocks.length > this.#config.chunkBlocks) ||
        input.candidates.some((candidate) => input.candidates.filter((other) =>
          other.blockNumber === candidate.blockNumber).length > 256) ||
        input.blocks.some((block, index) => index > 0 &&
          block.parentHash !== input.blocks[index - 1]?.hash)) {
      throw new Error("LP_EVIDENCE_RANGE_BOUNDS");
    }
    const charge = sourceIds.reduce((sum, sourceId) => sum +
      chunkChargedLogicalBytes(sourceId) +
      input.blocks.reduce((blockSum, block) => blockSum + blockLogicalBytes(sourceId, block), 0n) +
      input.candidates.reduce((candidateSum, candidate) =>
        candidateSum + candidateLogicalBytes(sourceId, candidate), 0n), 0n);
    const blockRows = sourceIds.length * input.blocks.length;
    const candidateRows = sourceIds.length * input.candidates.length;
    if (this.#config !== undefined &&
        (this.#logicalBytes + charge > BigInt(this.#config.maxGlobalLogicalBytes) ||
         (this.#versionBytes.get(stored.lane.coverageVersion) ?? 0n) + charge >
           BigInt(this.#config.maxVersionLogicalBytes) ||
         (this.#versionBlockRows.get(stored.lane.coverageVersion) ?? 0) + blockRows >
           this.#config.maxVersionBlockRows ||
         (this.#versionCandidateRows.get(stored.lane.coverageVersion) ?? 0) + candidateRows >
           this.#config.maxVersionCandidateRows)) {
      throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
    }
    const lane: CoverageLane = { ...stored.lane, coveredThrough: last.number,
      coveredThroughHash: last.hash, coveredThroughTimestamp: last.timestamp,
      state: "active", rowVersion: stored.lane.rowVersion + 1 };
    this.#lanes.set(lane.laneId, { lane, blocks: [...stored.blocks, ...input.blocks],
      candidates: [...stored.candidates, ...input.candidates], chunks: [...stored.chunks, {
        generation: lane.generation, state: "complete", from: first.number, to: last.number,
        firstHash: first.hash, lastHash: last.hash,
        charge: sourceIds.reduce((sum, id) => sum + chunkChargedLogicalBytes(id), 0n),
        candidateCount: input.candidates.length,
        sourceChunkDigests: input.sourceChunkDigests,
      }], archivedRaw: stored.archivedRaw });
    this.#logicalBytes += charge;
    this.#versionBytes.set(lane.coverageVersion,
      (this.#versionBytes.get(lane.coverageVersion) ?? 0n) + charge);
    this.#versionBlockRows.set(lane.coverageVersion,
      (this.#versionBlockRows.get(lane.coverageVersion) ?? 0) + blockRows);
    this.#versionCandidateRows.set(lane.coverageVersion,
      (this.#versionCandidateRows.get(lane.coverageVersion) ?? 0) + candidateRows);
    return lane;
  }

  async markGap(lane: CoverageLane, lease: CoverageLease): Promise<void> {
    this.#assertCitationUnlocked(lane.laneId);
    const stored = this.#lanes.get(lane.laneId);
    if (stored === undefined || stored.lane.rowVersion !== lane.rowVersion) return;
    this.#assertLease(lane, lease, Date.now());
    this.#lanes.set(lane.laneId, { ...stored,
      lane: { ...stored.lane, state: "gap", rowVersion: stored.lane.rowVersion + 1 } });
  }

  async recentBlocks(lane: CoverageLane, limit: number): Promise<readonly AgreedCoverageBlock[]> {
    const stored = this.#lanes.get(lane.laneId);
    if (stored === undefined || stored.lane.generation !== lane.generation) return [];
    return [...stored.blocks].sort((a, b) => a.number > b.number ? -1 : 1).slice(0, limit);
  }

  async prefixBoundaries(lane: CoverageLane): Promise<readonly CoveragePrefixBoundary[]> {
    return [...this.#zeroPrefixes.entries()].flatMap(([key, prefix]) => {
      const requirement = this.#requirements.get(key);
      return requirement?.laneId === lane.laneId && requirement.state === "eligible" &&
        requirement.unavailableCode === null &&
        (requirement.coverageGeneration ?? 0n) === lane.generation &&
        prefix.generation === lane.generation
        ? [{ toBlock: prefix.to, toBlockHash: prefix.toBlockHash }] : [];
    });
  }

  async rewind(lane: CoverageLane, ancestor: AgreedCoverageBlock | null,
    lease: CoverageLease, prefixProofs: readonly CoveragePrefixProof[] = []): Promise<CoverageLane> {
    this.#assertCitationUnlocked(lane.laneId);
    // Memory rewind is one synchronous critical section: there is deliberately
    // no await between this snapshot and publication. Preserve the same abort
    // semantics as the SQL transaction if raw validation, prefix carry or any
    // quota admission rejects after deriving part of the replacement fork.
    const transaction = this.#snapshotRewindState();
    try {
    const stored = this.#lanes.get(lane.laneId);
    if (stored === undefined || stored.lane.rowVersion !== lane.rowVersion ||
        stored.lane.generation !== lane.generation) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
    this.#assertLease(lane, lease, Date.now());
    const transitionedRequirements = new Set<string>();
    for (const [key, prefix] of this.#zeroPrefixes) {
      const requirement = this.#requirements.get(key);
      if (requirement?.laneId !== lane.laneId || requirement.state !== "eligible" ||
          requirement.unavailableCode !== null ||
          (requirement.coverageGeneration ?? 0n) !== lane.generation ||
          prefix.generation !== lane.generation) continue;
      transitionedRequirements.add(key);
      const proof = prefixProofs.find((row) => row.toBlock === prefix.to);
      if (ancestor === null || ancestor.number < prefix.to || proof?.agreed !== true ||
          proof.toBlockHash !== prefix.toBlockHash) {
        this.#requirements.set(key, { ...requirement, state: "unavailable",
          unavailableCode: "compacted-prefix-reorg", rowVersion: requirement.rowVersion + 1,
          updatedAt: Date.now() });
        continue;
      }
      const carry = zeroPrefixCarryDigest({ coverageVersion: lane.coverageVersion,
        quorumId: lane.quorumId, laneId: lane.laneId,
        requirementKeyHash: evidenceRequirementKeyHash(requirement),
        oldGeneration: lane.generation, newGeneration: lane.generation + 1n,
        fromBlock: prefix.from, toBlock: prefix.to, toBlockHash: prefix.toBlockHash,
        sourceAccumulator: prefix.sourceAccumulator, oldPrefixDigest: prefix.digest });
      this.#zeroPrefixes.set(key, { ...prefix, generation: lane.generation + 1n, digest: carry });
      this.#requirements.set(key, { ...requirement,
        coverageGeneration: lane.generation + 1n,
        rowVersion: requirement.rowVersion + 1, updatedAt: Date.now() });
    }
    for (const [key, requirement] of this.#requirements) {
      if (transitionedRequirements.has(key) || requirement.laneId !== lane.laneId ||
          requirement.state !== "eligible" || requirement.unavailableCode !== null ||
          (requirement.coverageGeneration ?? 0n) !== lane.generation) continue;
      if (ancestor === null || ancestor.number < requirement.begunAtBlock) {
        this.#requirements.set(key, { ...requirement, state: "unavailable",
          unavailableCode: "coverage-generation-reorg", rowVersion: requirement.rowVersion + 1,
          updatedAt: Date.now() });
      } else {
        this.#requirements.set(key, { ...requirement,
          coverageGeneration: lane.generation + 1n,
          rowVersion: requirement.rowVersion + 1, updatedAt: Date.now() });
      }
    }
    const next: CoverageLane = { ...stored.lane, generation: stored.lane.generation + 1n,
      state: ancestor === null ? "exhausted" : "active",
      coveredThrough: ancestor?.number ?? null, coveredThroughHash: ancestor?.hash ?? null,
      coveredThroughTimestamp: ancestor?.timestamp ?? null, rowVersion: stored.lane.rowVersion + 1 };
    const currentChunks = stored.chunks.filter((chunk) =>
      chunk.generation === lane.generation && chunk.state === "complete");
    const retainedChunks = stored.chunks.map((chunk): MemoryChunk =>
      chunk.generation === lane.generation && chunk.state === "complete"
        ? { ...chunk, state: "invalidated" }
        : chunk);
    const carriedChunks: MemoryChunk[] = [];
    const carriedBlocks = ancestor === null ? [] : stored.blocks.filter((block) =>
      block.number <= ancestor.number);
    const carriedCandidates = ancestor === null ? [] : stored.candidates.filter((candidate) =>
      candidate.blockNumber <= ancestor.number);
    if (ancestor !== null) {
      for (const chunk of currentChunks) {
        if (chunk.from > ancestor.number) continue;
        const to = chunk.to < ancestor.number ? chunk.to : ancestor.number;
        const chunkBlocks = carriedBlocks.filter((block) =>
          block.number >= chunk.from && block.number <= to).sort((left, right) =>
          left.number < right.number ? -1 : left.number > right.number ? 1 : 0);
        const expectedCount = Number(to - chunk.from + 1n);
        if (!Number.isSafeInteger(expectedCount) || chunkBlocks.length !== expectedCount ||
            chunkBlocks.some((block, index) => block.number !== chunk.from + BigInt(index))) {
          throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: carried chunk raw rows are incomplete.");
        }
        const sourceChunkDigests = Object.fromEntries(
          Object.keys(chunk.sourceChunkDigests).sort().map((sourceId) => [sourceId,
            chunkDigest({ sourceId, laneId: lane.laneId, generation: next.generation,
              fromBlock: chunk.from, toBlock: to, blocks: chunkBlocks.map((block) => ({
                number: block.number, hash: block.hash, parentHash: block.parentHash,
                timestamp: block.timestamp,
                transactionListDigest: block.orderedTransactionDigest,
              })) })]),
        ) as Readonly<Record<string, Hex>>;
        carriedChunks.push({ ...chunk, generation: next.generation, state: "complete", to,
          lastHash: chunkBlocks.at(-1)?.hash ?? chunk.lastHash,
          candidateCount: carriedCandidates.filter((candidate) =>
            candidate.blockNumber >= chunk.from && candidate.blockNumber <= to).length,
          sourceChunkDigests });
      }
    }
    // A rewind is an audit fork, not a move. Old raw rows and complete chunk
    // payloads remain cited by their original generation (the chunks become
    // invalidated); the canonical prefix is a separately charged copy. This
    // mirrors PostgreSQL's immutable generation primary keys and prevents a
    // later split from erasing the exact tail that was rejected.
    const sourceIds = [...new Set(currentChunks.flatMap((chunk) =>
      Object.keys(chunk.sourceChunkDigests)))].sort();
    const addedCharge = carriedChunks.reduce((sum, chunk) => sum + chunk.charge, 0n) +
      sourceIds.reduce((sum, sourceId) => sum +
        carriedBlocks.reduce((part, block) => part + blockLogicalBytes(sourceId, block), 0n) +
        carriedCandidates.reduce((part, candidate) =>
          part + candidateLogicalBytes(sourceId, candidate), 0n), 0n);
    const addedBlockRows = carriedBlocks.length * sourceIds.length;
    const addedCandidateRows = carriedCandidates.length * sourceIds.length;
    const nextVersionBytes = (this.#versionBytes.get(lane.coverageVersion) ?? 0n) + addedCharge;
    if (this.#config !== undefined &&
        (this.#logicalBytes + addedCharge > BigInt(this.#config.maxGlobalLogicalBytes) ||
         nextVersionBytes > BigInt(this.#config.maxVersionLogicalBytes) ||
         (this.#versionBlockRows.get(lane.coverageVersion) ?? 0) + addedBlockRows >
           this.#config.maxVersionBlockRows ||
         (this.#versionCandidateRows.get(lane.coverageVersion) ?? 0) + addedCandidateRows >
           this.#config.maxVersionCandidateRows)) {
      throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
    }
    this.#lanes.set(lane.laneId, { lane: next,
      blocks: carriedBlocks, candidates: carriedCandidates,
      chunks: [...retainedChunks, ...carriedChunks],
      archivedRaw: [...stored.archivedRaw, { generation: lane.generation,
        blocks: stored.blocks, candidates: stored.candidates }] });
    this.#logicalBytes += addedCharge;
    this.#versionBytes.set(lane.coverageVersion, nextVersionBytes);
    this.#versionBlockRows.set(lane.coverageVersion,
      (this.#versionBlockRows.get(lane.coverageVersion) ?? 0) + addedBlockRows);
    this.#versionCandidateRows.set(lane.coverageVersion,
      (this.#versionCandidateRows.get(lane.coverageVersion) ?? 0) + addedCandidateRows);
    return next;
    } catch (error) {
      this.#restoreRewindState(transaction);
      throw error;
    }
  }

  #snapshotRewindState(): MemoryRewindState {
    return {
      lanes: structuredClone(this.#lanes),
      logicalBytes: this.#logicalBytes,
      versionBytes: structuredClone(this.#versionBytes),
      versionBlockRows: structuredClone(this.#versionBlockRows),
      versionCandidateRows: structuredClone(this.#versionCandidateRows),
      requirements: structuredClone(this.#requirements),
      zeroPrefixes: structuredClone(this.#zeroPrefixes),
    };
  }

  #restoreRewindState(snapshot: MemoryRewindState): void {
    this.#replaceMap(this.#lanes, snapshot.lanes);
    this.#logicalBytes = snapshot.logicalBytes;
    this.#replaceMap(this.#versionBytes, snapshot.versionBytes);
    this.#replaceMap(this.#versionBlockRows, snapshot.versionBlockRows);
    this.#replaceMap(this.#versionCandidateRows, snapshot.versionCandidateRows);
    this.#replaceMap(this.#requirements, snapshot.requirements);
    this.#replaceMap(this.#zeroPrefixes, snapshot.zeroPrefixes);
  }

  #replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  }

  async snapshot(input: Parameters<LpCoverageStore["snapshot"]>[0]): Promise<CoverageSnapshot | null> {
    let requirement = this.#requirements.get(requirementKey(input.requirement));
    // Legacy unit fixtures constructed coverage snapshots without first
    // admitting through LpEvidenceStore. Production wiring enables strict mode;
    // the compatibility path still persists once and is therefore monotonic.
    if (requirement === undefined && !this.#strictRequirementAuthorization) {
      requirement = await this.registerRequirement(input.requirement);
    }
    if (requirement === undefined || !sameRequirementIdentity(requirement, input.requirement)) return null;
    const stored = this.#lanes.get(requirement.laneId);
    if (stored === undefined || stored.lane.state !== "active" ||
        stored.lane.coveredThrough === null || stored.lane.coveredThroughHash === null ||
        stored.lane.coveredThroughTimestamp === null ||
        stored.lane.coveredThrough < requirement.begunAtBlock ||
        !requirementAuthorizesLane(requirement, stored.lane)) return null;
    const matches = stored.candidates.filter((candidate) =>
      candidate.blockNumber >= requirement.begunAtBlock &&
      candidate.blockNumber <= stored.lane.coveredThrough! &&
      candidate.eoa === input.identity.eoa && candidate.nonce.toString(10) === input.identity.nonce &&
      candidate.executionDataHash === input.identity.executionDataHash &&
      candidate.keyHash === input.identity.keyHash);
    const common = { scheme: "lp-landing-evidence-v1" as const,
      preparedIdentityHash: requirement.preparedIdentityHash,
      coverageVersion: stored.lane.coverageVersion, quorumId: stored.lane.quorumId,
      laneId: stored.lane.laneId, generation: stored.lane.generation.toString(10),
      cursorRowVersion: stored.lane.rowVersion.toString(10),
      requirementState: requirement.state,
      requirementUnavailableCode: requirement.unavailableCode,
      requirementGeneration: (requirement.coverageGeneration ?? 0n).toString(10),
      requirementRowVersion: requirement.rowVersion.toString(10),
      requiredSourceIds: [...input.requiredSourceIds].sort(),
      fromBlock: requirement.begunAtBlock.toString(10),
      toBlock: stored.lane.coveredThrough.toString(10), toBlockHash: stored.lane.coveredThroughHash };
    const positive = matches.filter(isPositiveCandidate);
    if (matches.length === 1 && positive.length === 1) {
      const found = matches[0];
      if (found === undefined) return null;
      return canonicalLandingEvidence({ ...common, outcome: "landed", landed: {
        txHash: found.txHash, inputHash: found.inputHash,
        blockNumber: found.blockNumber.toString(10), blockHash: found.blockHash,
        transactionIndex: found.transactionIndex.toString(10), intentIndex: found.intentIndex,
        logIndex: found.logIndex.toString(10), eventTopicsHash: found.eventTopicsHash,
        eventDataHash: found.eventDataHash,
      } });
    }
    if (matches.length > 1) {
      return { outcome: "ambiguous", reason: "multiple-matching-candidates" };
    }
    if (matches.length === 1) {
      return { outcome: "ambiguous", reason: "matching-candidate-not-successful" };
    }
    if (requirement.expiry === 0n ||
        stored.lane.coveredThroughTimestamp <= requirement.expiry +
          BigInt(input.expirySafetySeconds)) return null;
    return canonicalLandingEvidence({ ...common, outcome: "absent", absent: {
      toBlockTimestamp: stored.lane.coveredThroughTimestamp.toString(10),
      expirySafetySeconds: input.expirySafetySeconds, zeroMatchCount: 0,
    } });
  }

  async validate(evidence: CoverageSnapshot): Promise<boolean> {
    if (evidence.outcome === "ambiguous") return false;
    const stored = this.#lanes.get(evidence.laneId);
    if (stored === undefined || stored.lane.state !== "active" ||
        !evidenceHasCanonicalDigest(evidence)) return false;
    const requirements = [...this.#requirements.values()].filter((requirement) =>
      requirement.laneId === evidence.laneId &&
      requirement.preparedIdentityHash === evidence.preparedIdentityHash &&
      requirement.begunAtBlock.toString(10) === evidence.fromBlock);
    if (requirements.length !== 1 ||
        !requirementAuthorizesCoverageEvidence(requirements[0]!, evidence)) return false;
    if (stored.lane.generation.toString(10) !== evidence.generation ||
        stored.lane.rowVersion < Number(evidence.cursorRowVersion) ||
        stored.lane.coveredThrough === null ||
        stored.lane.coveredThrough < BigInt(evidence.toBlock)) return false;
    const citedBlock = stored.blocks.find((block) => block.number === BigInt(evidence.toBlock));
    if (citedBlock?.hash !== evidence.toBlockHash) return false;
    if (evidence.outcome === "landed" && evidence.landed !== undefined) {
      return stored.candidates.some((candidate) => candidate.txHash === evidence.landed?.txHash &&
        candidate.inputHash === evidence.landed?.inputHash &&
        candidate.blockNumber.toString(10) === evidence.landed?.blockNumber &&
        candidate.blockHash === evidence.landed?.blockHash &&
        candidate.transactionIndex.toString(10) === evidence.landed?.transactionIndex &&
        candidate.intentIndex === evidence.landed?.intentIndex &&
        candidate.logIndex.toString(10) === evidence.landed?.logIndex &&
        candidate.eventTopicsHash === evidence.landed?.eventTopicsHash &&
        candidate.eventDataHash === evidence.landed?.eventDataHash);
    }
    return evidence.outcome === "absent";
  }

  async withCurrentEvidence<T>(evidence: LandingEvidenceV1,
    mutation: () => Promise<T>): Promise<T> {
    const count = this.#citationLocks.get(evidence.laneId) ?? 0;
    this.#citationLocks.set(evidence.laneId, count + 1);
    try {
      if (!(await this.validate(evidence))) {
        throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence was invalidated.");
      }
      return await mutation();
    } finally {
      const remaining = (this.#citationLocks.get(evidence.laneId) ?? 1) - 1;
      if (remaining === 0) this.#citationLocks.delete(evidence.laneId);
      else this.#citationLocks.set(evidence.laneId, remaining);
    }
  }

  async close(): Promise<void> { /* no resources */ }

  #assertLease(lane: CoverageLane, lease: CoverageLease, now: number): void {
    const current = this.#leases.get(lane.laneId);
    if (current === undefined || current.holderId !== lease.holderId ||
        current.fence !== lease.fence || current.leaseUntil !== lease.leaseUntil ||
        current.leaseUntil <= now) throw new Error("LP_EVIDENCE_LEASE_CONFLICT");
  }
  #assertCitationUnlocked(laneId: Hex): void {
    if ((this.#citationLocks.get(laneId) ?? 0) !== 0) {
      throw new Error("LP_EVIDENCE_CITATION_LOCKED: disposition citation is in use.");
    }
  }
}

/**
 * Postgres coverage store. The observer commits only already-quorum-agreed
 * ranges, but still materializes one immutable block/candidate row per source
 * so a later audit can prove which independent sources agreed.
 */
export class PostgresLpCoverageStore implements LpCoverageStore {
  readonly #sql: SqlClient;
  readonly #config: LpEvidenceConfig;
  constructor(sql: SqlClient, config: LpEvidenceConfig) { this.#sql = sql; this.#config = config; }

  async ensureLane(input: Parameters<LpCoverageStore["ensureLane"]>[0]): Promise<CoverageLane> {
    await this.#sql.transaction(async (tx) => {
      for (const source of this.#config.sources) {
        await tx.query(`/* lpCoverage.sourceEnsure */ insert into lp_evidence_sources
          (coverage_version,source_id,operator_family,role,endpoint_fingerprint,enabled_at,disabled_at)
          values($1,$2,$3,$4,$5,now(),null) on conflict(coverage_version,source_id) do nothing`,
        [input.coverageVersion, source.id, source.operatorFamily, source.role,
          source.endpointFingerprint]);
      }
      await tx.query(`/* lpCoverage.quorumEnsure */ insert into lp_evidence_quorums
        (coverage_version,quorum_id,required_source_count,quorum_digest)
        values($1,$2,$3,$2) on conflict(coverage_version,quorum_id) do nothing`,
      [input.coverageVersion, input.quorumId,
        this.#config.sources.filter((source) => source.role === "required").length]);
      await tx.query(`/* lpCoverage.cursorEnsure */ insert into lp_evidence_cursors
        (coverage_version,quorum_id,lane_id,purpose,admission_key_hash,origin_block,
         covered_through,covered_through_hash,raw_retained_from,generation,state,row_version,updated_at)
        values($1,$2,$3,$4,$5,$6,null,null,$6,0,'active',0,now())
        on conflict(coverage_version,quorum_id,lane_id) do nothing`,
      [input.coverageVersion, input.quorumId, input.laneId, input.purpose,
        input.admissionKeyHash, input.originBlock.toString(10)]);
    });
    const lane = await this.#getLane(input.laneId);
    if (lane === null) throw new Error("LP evidence lane insert failed.");
    return lane;
  }

  async listActiveLanes(limit = 100): Promise<readonly CoverageLane[]> {
    const result = await this.#sql.query<CursorRow>(`/* lpCoverage.cursorList */ select c.*,
      (select block_timestamp from lp_evidence_blocks b where b.coverage_version=c.coverage_version
       and b.quorum_id=c.quorum_id and b.lane_id=c.lane_id and b.generation=c.generation
       and b.block_number=c.covered_through order by source_id limit 1) covered_through_timestamp
      from lp_evidence_cursors c where state in ('active','gap')
      and exists(select 1 from lp_evidence_requirements r where r.lane_id=c.lane_id and
       r.state='eligible' and r.unavailable_code is null and r.coverage_generation=c.generation)
      order by origin_block,lane_id limit $1`, [Math.max(0, Math.min(1_000, limit))]);
    return result.rows.map(rowToLane);
  }

  async findAdmissionLane(input: { readonly coverageVersion: Hex; readonly quorumId: Hex;
    readonly begunAtBlock: bigint; readonly admissionKeyHash: Hex }): Promise<CoverageLane | null> {
    const result = await this.#sql.query<CursorRow>(`/* lpCoverage.admissionLane */ select c.*,
      (select block_timestamp from lp_evidence_blocks b where b.coverage_version=c.coverage_version
       and b.quorum_id=c.quorum_id and b.lane_id=c.lane_id and b.generation=c.generation
       and b.block_number=c.covered_through order by source_id limit 1) covered_through_timestamp
      from lp_evidence_cursors c where coverage_version=$1 and quorum_id=$2 and state='active'
       and origin_block<=$3 and raw_retained_from<=$3 and
       (purpose='base' or admission_key_hash=$4)
      order by origin_block desc,lane_id limit 1`, [input.coverageVersion, input.quorumId,
      input.begunAtBlock.toString(10), input.admissionKeyHash]);
    const row = result.rows[0]; return row === undefined ? null : rowToLane(row);
  }

  async findBaseLane(input: { readonly coverageVersion: Hex; readonly quorumId: Hex;
    readonly begunAtBlock: bigint }): Promise<CoverageLane | null> {
    const result = await this.#sql.query<CursorRow>(`/* lpCoverage.baseLane */ select c.*,
      (select block_timestamp from lp_evidence_blocks b where b.coverage_version=c.coverage_version
       and b.quorum_id=c.quorum_id and b.lane_id=c.lane_id and b.generation=c.generation
       and b.block_number=c.covered_through order by source_id limit 1) covered_through_timestamp
      from lp_evidence_cursors c where coverage_version=$1 and quorum_id=$2 and purpose='base'
       and origin_block<=$3 order by origin_block desc,lane_id limit 1`,
    [input.coverageVersion, input.quorumId, input.begunAtBlock.toString(10)]);
    const row = result.rows[0]; return row === undefined ? null : rowToLane(row);
  }

  async claimLease(lane: CoverageLane, holderId: string, now: number,
    leaseUntil: number): Promise<CoverageLease | null> {
    if (leaseUntil <= now) throw new Error("LP_EVIDENCE_LEASE_RANGE");
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* lpCoverage.leaseEnsure */ insert into lp_evidence_leases
        (coverage_version,quorum_id,lane_id,holder_id,fence,lease_until,updated_at)
        values($1,$2,$3,$4,0,$5,$6) on conflict(coverage_version,quorum_id,lane_id) do nothing`,
      [lane.coverageVersion, lane.quorumId, lane.laneId, holderId,
        new Date(leaseUntil), new Date(now)]);
      const lockedLane = await lockLane(tx, lane.laneId);
      if (lockedLane === null || lockedLane.generation !== lane.generation ||
          lockedLane.rowVersion !== lane.rowVersion) return null;
      const result = await tx.query<LeaseRow>(`/* lpCoverage.leaseClaim */ update lp_evidence_leases
        set holder_id=$2,fence=fence+1,lease_until=$3,updated_at=$4 where lane_id=$1 and
        (lease_until<=$4 or holder_id=$2) returning holder_id,fence,lease_until`,
      [lane.laneId, holderId, new Date(leaseUntil), new Date(now)]);
      const row = result.rows[0]; return row === undefined ? null : rowToLease(row);
    });
  }

  async reserveBackfillBlocks(coverageVersion: Hex, blocks: number, now: number,
    hourlyLimit: number): Promise<boolean> {
    if (!Number.isSafeInteger(blocks) || blocks <= 0) throw new Error("LP_EVIDENCE_BACKFILL_RANGE");
    const windowStart = new Date(Math.floor(now / 3_600_000) * 3_600_000);
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* lpCoverage.backfillPrune */ delete from lp_evidence_backfill_budgets
        where window_start<$1`, [new Date(windowStart.getTime() - 3_600_000)]);
      await tx.query(`/* lpCoverage.backfillEnsure */ insert into lp_evidence_backfill_budgets
        (coverage_version,window_start,blocks,row_version,updated_at) values($1,$2,0,0,$3)
        on conflict(coverage_version,window_start) do nothing`,
      [coverageVersion, windowStart, new Date(now)]);
      const result = await tx.query<{ blocks: string | number }>(
        `/* lpCoverage.backfillReserve */ update lp_evidence_backfill_budgets set
         blocks=blocks+$3,row_version=row_version+1,updated_at=$4 where coverage_version=$1 and
         window_start=$2 and blocks+$3<=$5 returning blocks`,
        [coverageVersion, windowStart, blocks, new Date(now), hourlyLimit]);
      return result.rows[0] !== undefined;
    });
  }

  async registerRequirement(requirement: EvidenceRequirement): Promise<EvidenceRequirement> {
    // The durable implementation shares PostgreSQL with LpEvidenceStore. Read
    // back the canonical row: registration is never an eligibility update.
    const result = await this.#sql.query<CompactRequirementRow>(
      `/* lpCoverage.requirementRegister */ select * from lp_evidence_requirements where
       journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
       journal_idempotency_key=$4 and $5::numeric=$5::numeric and $6::numeric=$6::numeric and
       $7::text=$7::text and $8::text=$8::text and $9::text=$9::text and $10::text=$10::text and
       $11::bigint=$11::bigint and $12::text=$12::text and
       $13::text is not distinct from $13::text and $14::bigint=$14::bigint and
       $15::bigint=$15::bigint`, [...requirementParamsForCoverage(requirement),
        requirement.begunAtBlock.toString(10), requirement.expiry.toString(10),
        requirement.preparedIdentityHash, requirement.coverageVersion, requirement.quorumId,
        requirement.laneId, (requirement.coverageGeneration ?? 0n).toString(10),
        requirement.state, requirement.unavailableCode, requirement.rowVersion.toString(10),
        requirement.chargedLogicalBytes.toString(10)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("LP_EVIDENCE_REQUIREMENT_CONFLICT");
    const canonical = compactRequirement(row);
    assertSameRequirementIdentity(canonical, requirement);
    return canonical;
  }

  async compactZeroExpiry(lane: CoverageLane, lease: CoverageLease, now: number): Promise<number> {
    if (lane.coveredThrough === null || lane.coveredThrough < 257n) return 0;
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* lpCoverage.compactQuotaEnsure */ insert into lp_evidence_quota_counters
        (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
         zero_expiry_rows,row_version,updated_at)
        values('global','',0,0,0,0,0,0,$2),('coverage-version',$1,0,0,0,0,0,0,$2)
        on conflict(scope,coverage_version) do nothing`, [lane.coverageVersion, new Date(now)]);
      const globalRows = await tx.query<QuotaRow>(`/* lpCoverage.compactQuotaGlobal */ select *
        from lp_evidence_quota_counters where scope='global' and coverage_version='' for update`);
      const versionRows = await tx.query<QuotaRow>(`/* lpCoverage.compactQuotaVersion */ select *
        from lp_evidence_quota_counters where scope='coverage-version' and coverage_version=$1
        for update`, [lane.coverageVersion]);
      const global = globalRows.rows[0]; const version = versionRows.rows[0];
      if (global === undefined || version === undefined) throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      const locked = await lockLane(tx, lane.laneId);
      if (locked === null || locked.rowVersion !== lane.rowVersion ||
          locked.generation !== lane.generation || locked.coveredThrough === null) return 0;
      await assertLease(tx, locked, lease, now);
      const requirements = await tx.query<CompactRequirementRow>(
        `/* lpCoverage.compactRequirements */ select * from lp_evidence_requirements
         where lane_id=$1 and state='eligible' and unavailable_code is null and
          coverage_generation=$2::bigint order by journal_owner,journal_agent,
          journal_action,journal_idempotency_key for update`, [lane.laneId,
          lane.generation.toString(10)],
      );
      const onlyRequirement = requirements.rows[0];
      if (requirements.rows.length !== 1 || onlyRequirement === undefined ||
          BigInt(onlyRequirement.expiry) !== 0n || onlyRequirement.state === "terminal") return 0;
      const requirement = compactRequirement(onlyRequirement);
      const prefixRows = await tx.query<ZeroPrefixRow>(
        `/* lpCoverage.compactPrefixLock */ select * from lp_evidence_zero_prefixes where
         journal_owner=$1 and journal_agent=$2 and journal_action=$3 and journal_idempotency_key=$4
         for update`, requirementParamsForCoverage(requirement),
      );
      const prefix = prefixRows.rows[0];
      const from = prefix === undefined ? requirement.begunAtBlock : BigInt(prefix.to_block) + 1n;
      const cutoff = locked.coveredThrough - 257n;
      if (from !== locked.rawRetainedFrom || from > cutoff) return 0;
      const chunkRows = await tx.query<CompactChunkRow>(
        `/* lpCoverage.compactChunksLock */ select source_id,from_block,to_block,
          ordered_block_digest,charged_logical_bytes from lp_evidence_chunks where lane_id=$1 and
          generation=$2 and state='complete' and from_block>=$3 and to_block<=$4
         order by from_block,to_block,source_id for update`, [lane.laneId,
          lane.generation.toString(10), from.toString(10), cutoff.toString(10)],
      );
      const requiredIds = this.#config.sources.filter((source) => source.role === "required")
        .map((source) => source.id).sort();
      const groups = new Map<string, CompactChunkRow[]>();
      for (const row of chunkRows.rows) {
        const key = `${row.from_block}:${row.to_block}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      let expectedFrom = from; let to: bigint | null = null; const selected: CompactChunkRow[] = [];
      const ordered = [...groups.values()].sort((a, b) =>
        BigInt(a[0]?.from_block ?? 0) < BigInt(b[0]?.from_block ?? 0) ? -1 : 1);
      for (const group of ordered) {
        const first = group[0];
        if (first === undefined || BigInt(first.from_block) !== expectedFrom ||
            group.map((row) => row.source_id).sort().join("\u0000") !== requiredIds.join("\u0000")) break;
        to = BigInt(first.to_block); expectedFrom = to + 1n; selected.push(...group);
      }
      if (to === null) return 0;
      const candidateRows = await tx.query<{ candidate_count: string | number }>(
        `/* lpCoverage.compactCandidateCount */ select count(*) candidate_count from
         lp_evidence_candidates where lane_id=$1 and generation=$2 and block_number between $3 and $4`,
        [lane.laneId, lane.generation.toString(10), from.toString(10), to.toString(10)],
      );
      if (Number(candidateRows.rows[0]?.candidate_count ?? -1) !== 0) return 0;
      const terminalBlocks = await tx.query<{ block_hash: Hex; source_count: string | number }>(
        `/* lpCoverage.compactTerminalBlock */ select block_hash,count(distinct source_id) source_count
         from lp_evidence_blocks where lane_id=$1 and generation=$2 and block_number=$3
         group by block_hash`, [lane.laneId, lane.generation.toString(10), to.toString(10)],
      );
      const terminal = terminalBlocks.rows[0];
      if (terminalBlocks.rows.length !== 1 || terminal === undefined ||
          Number(terminal.source_count) !== requiredIds.length) return 0;
      const sourceChunkDigests = Object.fromEntries(selected.map((row) =>
        [`${row.from_block}:${row.to_block}:${row.source_id}`, row.ordered_block_digest])) as
        Readonly<Record<string, Hex>>;
      const digests = zeroPrefixDigests({ ...(prefix === undefined ? {} : {
        priorPrefixDigest: prefix.prefix_digest,
        priorSourceAccumulator: prefix.required_source_digest_accumulator,
      }), requirement, generation: lane.generation, fromBlock: from, toBlock: to,
      toBlockHash: terminal.block_hash, sourceChunkDigests });
      const prefixCharge = prefix === undefined ? zeroPrefixChargedLogicalBytes(requirement) :
        BigInt(prefix.charged_logical_bytes);
      const rawRows = await tx.query<{ block_bytes: string; block_rows: string | number }>(
        `/* lpCoverage.compactRawCharge */ select coalesce(sum(logical_bytes),0) block_bytes,
         count(*) block_rows from lp_evidence_blocks where lane_id=$1 and generation=$2 and
         block_number between $3 and $4`, [lane.laneId, lane.generation.toString(10),
          from.toString(10), to.toString(10)],
      );
      const raw = rawRows.rows[0]; if (raw === undefined) throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
      const debit = selected.reduce((sum, row) => sum + BigInt(row.charged_logical_bytes), 0n) +
        BigInt(raw.block_bytes);
      const delta = (prefix === undefined ? prefixCharge : 0n) - debit;
      if (BigInt(global.logical_bytes) + delta < 0n || BigInt(version.logical_bytes) + delta < 0n ||
          BigInt(global.logical_bytes) + delta > BigInt(this.#config.maxGlobalLogicalBytes) ||
          BigInt(version.logical_bytes) + delta > BigInt(this.#config.maxVersionLogicalBytes)) {
        throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
      }
      const prefixWrite = prefix === undefined
        ? await tx.query<{ journal_owner: string }>(
          `/* lpCoverage.compactPrefixInsert */ insert into lp_evidence_zero_prefixes(
           journal_owner,journal_agent,journal_action,journal_idempotency_key,coverage_version,
           quorum_id,lane_id,generation,from_block,to_block,to_block_hash,
           required_source_digest_accumulator,prefix_digest,match_count,generation_carry_digest,
           carry_parent_digest,carry_source_accumulator,carried_from_generation,carry_from_block,
           carry_to_block,carry_to_block_hash,charged_logical_bytes,updated_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,null,null,null,null,null,null,null,$14,$15)
           returning journal_owner`, [...requirementParamsForCoverage(requirement),
            lane.coverageVersion, lane.quorumId, lane.laneId, lane.generation.toString(10),
            from.toString(10), to.toString(10), terminal.block_hash, digests.sourceAccumulator,
            digests.prefixDigest, prefixCharge.toString(10), new Date(now)])
        : await tx.query<{ journal_owner: string }>(
          `/* lpCoverage.compactPrefixExtend */ update lp_evidence_zero_prefixes set
           to_block=$5,to_block_hash=$6,required_source_digest_accumulator=$7,prefix_digest=$8,
           updated_at=$9 where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
           journal_idempotency_key=$4 and generation=$10 and prefix_digest=$11 and
           charged_logical_bytes=$12 returning journal_owner`, [...requirementParamsForCoverage(requirement),
            to.toString(10), terminal.block_hash, digests.sourceAccumulator, digests.prefixDigest,
            new Date(now), lane.generation.toString(10), prefix.prefix_digest,
            prefix.charged_logical_bytes]);
      if (prefixWrite.rows[0] === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      await tx.query(`/* lpCoverage.compactChunksDelete */ delete from lp_evidence_chunks where
        lane_id=$1 and generation=$2 and from_block>=$3 and to_block<=$4`,
      [lane.laneId, lane.generation.toString(10), from.toString(10), to.toString(10)]);
      await tx.query(`/* lpCoverage.compactBlocksDelete */ delete from lp_evidence_blocks where
        lane_id=$1 and generation=$2 and block_number between $3 and $4`,
      [lane.laneId, lane.generation.toString(10), from.toString(10), to.toString(10)]);
      const cursor = await tx.query<{ lane_id: string }>(
        `/* lpCoverage.compactCursor */ update lp_evidence_cursors set raw_retained_from=$2,
         row_version=row_version+1,updated_at=$3 where lane_id=$1 and generation=$4 and
         row_version=$5 and raw_retained_from=$6 returning lane_id`, [lane.laneId,
          (to + 1n).toString(10), new Date(now), lane.generation.toString(10), lane.rowVersion,
          lane.rawRetainedFrom.toString(10)],
      );
      if (cursor.rows[0] === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      for (const [scope, versionKey] of [["global", ""],
        ["coverage-version", lane.coverageVersion]] as const) {
        const changed = await tx.query<{ row_version: string }>(
          `/* lpCoverage.compactQuotaUpdate */ update lp_evidence_quota_counters set
           logical_bytes=logical_bytes+$3::bigint,block_rows=block_rows-$4::bigint,
           row_version=row_version+1,updated_at=$5 where scope=$1 and coverage_version=$2 and
           logical_bytes+$3::bigint>=0 and block_rows>=$4::bigint returning row_version`,
          [scope, versionKey, delta.toString(10), Number(raw.block_rows), new Date(now)]);
        if (changed.rows[0] === undefined) throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
      }
      return 1;
    });
  }

  async commitAgreedRange(input: CommitCoverageRange): Promise<CoverageLane> {
    return this.#sql.transaction(async (tx) => {
      const sourceIds = Object.keys(input.sourceChunkDigests).sort();
      const requiredIds = this.#config.sources.filter((source) => source.role === "required")
        .map((source) => source.id).sort();
      if (sourceIds.join("\u0000") !== requiredIds.join("\u0000")) {
        throw new Error("LP_EVIDENCE_QUORUM_INCOMPLETE");
      }
      const coverageBytes = sourceIds.reduce((sum, id) => sum +
        chunkChargedLogicalBytes(id) +
        input.blocks.reduce((blockSum, block) => blockSum + blockLogicalBytes(id, block), 0n) +
        input.candidates.reduce((candidateSum, candidate) =>
          candidateSum + candidateLogicalBytes(id, candidate), 0n), 0n);
      const blockRows = input.blocks.length * sourceIds.length;
      const candidateRows = input.candidates.length * sourceIds.length;
      await tx.query(`/* lpCoverage.quotaEnsure */ insert into lp_evidence_quota_counters
        (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
         zero_expiry_rows,row_version,updated_at)
        values('global','',0,0,0,0,0,0,$2),('coverage-version',$1,0,0,0,0,0,0,$2)
        on conflict(scope,coverage_version) do nothing`,
      [input.lane.coverageVersion, new Date(input.now)]);
      const globalRows = await tx.query<QuotaRow>(`/* lpCoverage.quotaLockGlobal */ select *
        from lp_evidence_quota_counters where scope='global' and coverage_version='' for update`);
      const versionRows = await tx.query<QuotaRow>(`/* lpCoverage.quotaLockVersion */ select *
        from lp_evidence_quota_counters where scope='coverage-version' and coverage_version=$1 for update`,
      [input.lane.coverageVersion]);
      const global = globalRows.rows[0]; const version = versionRows.rows[0];
      if (global === undefined || version === undefined ||
          BigInt(global.logical_bytes) + coverageBytes > BigInt(this.#config.maxGlobalLogicalBytes) ||
          BigInt(version.logical_bytes) + coverageBytes > BigInt(this.#config.maxVersionLogicalBytes) ||
          Number(version.block_rows) + blockRows > this.#config.maxVersionBlockRows ||
          Number(version.candidate_rows) + candidateRows > this.#config.maxVersionCandidateRows) {
        throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      }
      const locked = await lockLane(tx, input.lane.laneId);
      if (locked === null || locked.rowVersion !== input.expectedRowVersion ||
          locked.generation !== input.lane.generation) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      await assertLease(tx, locked, input.lease, input.now);
      const first = input.blocks[0]; const last = input.blocks.at(-1);
      const next = locked.coveredThrough === null ? locked.originBlock : locked.coveredThrough + 1n;
      if (first === undefined || last === undefined || first.number !== next ||
          input.blocks.length > this.#config.chunkBlocks ||
          input.blocks.some((block, index) => block.number !== first.number + BigInt(index) ||
            (index > 0 && block.parentHash !== input.blocks[index - 1]?.hash)) ||
          input.candidates.some((candidate) => input.candidates.filter((other) =>
            other.blockNumber === candidate.blockNumber).length > 256) ||
          (locked.coveredThroughHash !== null && first.parentHash !== locked.coveredThroughHash)) {
        throw new Error("LP_EVIDENCE_NONCONTIGUOUS_RANGE");
      }
      for (const sourceId of sourceIds) {
        await tx.query(`/* lpCoverage.chunkInsert */ insert into lp_evidence_chunks
          (coverage_version,quorum_id,lane_id,generation,source_id,from_block,to_block,state,
           lease_fence,first_hash,last_hash,ordered_block_digest,candidate_count,
           charged_logical_bytes,completed_at,error_code)
          values($1,$2,$3,$4,$5,$6,$7,'complete',$14,$8,$9,$10,$11,$12,$13,null)
          on conflict do nothing`, [locked.coverageVersion, locked.quorumId, locked.laneId,
          locked.generation.toString(10), sourceId, first.number.toString(10), last.number.toString(10),
          first.hash, last.hash, input.sourceChunkDigests[sourceId], input.candidates.length,
          chunkChargedLogicalBytes(sourceId).toString(10), new Date(input.now),
          input.lease.fence.toString(10)]);
        for (const block of input.blocks) {
          await tx.query(`/* lpCoverage.blockInsert */ insert into lp_evidence_blocks
            (coverage_version,quorum_id,lane_id,generation,source_id,block_number,block_hash,
             parent_hash,block_timestamp,ordered_transaction_digest,finalized_observed_at,logical_bytes)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint) on conflict do nothing`,
          [locked.coverageVersion, locked.quorumId, locked.laneId, locked.generation.toString(10),
            sourceId, block.number.toString(10), block.hash, block.parentHash,
            block.timestamp.toString(10), block.orderedTransactionDigest, new Date(input.now),
            blockLogicalBytes(sourceId, block).toString(10)]);
        }
        for (const candidate of input.candidates) {
          await tx.query(`/* lpCoverage.candidateInsert */ insert into lp_evidence_candidates
            (coverage_version,quorum_id,lane_id,generation,source_id,block_number,block_hash,
             transaction_hash,transaction_index,input_hash,log_index,orchestrator,
             orchestrator_version,decoder,intent_index,member_count,eoa,nonce,
             execution_data_hash,key_hash,receipt_status,incremented,event_error,
             event_topics_hash,event_data_hash,candidate_digest,logical_bytes)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'0.5.5',
             'porto-orchestrator-intent-v055',$13,$14,$15,$16,$17,$18,$19::bigint,$20,$21,
             $22,$23,$24,$25::bigint) on conflict do nothing`, [locked.coverageVersion,
            locked.quorumId, locked.laneId, locked.generation.toString(10), sourceId,
            candidate.blockNumber.toString(10), candidate.blockHash, candidate.txHash,
            candidate.transactionIndex.toString(10), candidate.inputHash,
            candidate.logIndex.toString(10), "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
            candidate.intentIndex, candidate.memberCount, candidate.eoa,
            candidate.nonce.toString(10), candidate.executionDataHash, candidate.keyHash,
            (candidate.receiptStatus ?? 1n).toString(10), candidate.incremented ?? true,
            candidate.eventError ?? "0x00000000", candidate.eventTopicsHash,
            candidate.eventDataHash, candidate.candidateDigest,
            candidateLogicalBytes(sourceId, candidate).toString(10)]);
        }
      }
      const advanced = await tx.query<CursorRow>(`/* lpCoverage.cursorAdvance */ update lp_evidence_cursors
        set covered_through=$2,covered_through_hash=$3,state='active',row_version=row_version+1,
        updated_at=$4 where lane_id=$1 and row_version=$5 and generation=$6 returning *,
        $7::numeric covered_through_timestamp`, [locked.laneId, last.number.toString(10), last.hash,
        new Date(input.now), input.expectedRowVersion, locked.generation.toString(10),
        last.timestamp.toString(10)]);
      const row = advanced.rows[0];
      if (row === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      for (const [scope, versionKey] of [["global", ""],
        ["coverage-version", locked.coverageVersion]] as const) {
        const updated = await tx.query<{ row_version: string }>(`/* lpCoverage.quotaUpdate */
          update lp_evidence_quota_counters set logical_bytes=logical_bytes+$3::bigint,
           block_rows=block_rows+$4,candidate_rows=candidate_rows+$5,
           row_version=row_version+1,updated_at=$6 where scope=$1 and coverage_version=$2
           returning row_version`, [scope, versionKey, coverageBytes.toString(10),
          blockRows, candidateRows, new Date(input.now)]);
        if (updated.rows[0] === undefined) throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      }
      return rowToLane(row);
    });
  }

  async markGap(lane: CoverageLane, lease: CoverageLease): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      const locked = await lockLane(tx, lane.laneId);
      if (locked === null || locked.generation !== lane.generation ||
          locked.rowVersion !== lane.rowVersion) return;
      await assertLease(tx, locked, lease, Date.now());
      await tx.query(`/* lpCoverage.cursorGap */ update lp_evidence_cursors set
        state='gap',row_version=row_version+1,updated_at=now()
        where lane_id=$1 and generation=$2 and row_version=$3`,
      [lane.laneId, lane.generation.toString(10), lane.rowVersion]);
    });
  }

  async recentBlocks(lane: CoverageLane, limit: number): Promise<readonly AgreedCoverageBlock[]> {
    const result = await this.#sql.query<{ block_number: string; block_hash: Hex;
      parent_hash: Hex; block_timestamp: string; ordered_transaction_digest: Hex }>(
      `/* lpCoverage.recentBlocks */ select distinct on (block_number) block_number,
       block_hash,parent_hash,block_timestamp,ordered_transaction_digest
       from lp_evidence_blocks where lane_id=$1 and generation=$2
       order by block_number desc,source_id limit $3`,
      [lane.laneId, lane.generation.toString(10), Math.max(0, Math.min(257, limit))],
    );
    return result.rows.map((row) => ({ number: BigInt(row.block_number), hash: row.block_hash,
      parentHash: row.parent_hash, timestamp: BigInt(row.block_timestamp),
      orderedTransactionDigest: row.ordered_transaction_digest }));
  }

  async prefixBoundaries(lane: CoverageLane): Promise<readonly CoveragePrefixBoundary[]> {
    const rows = await this.#sql.query<{ to_block: string; to_block_hash: Hex }>(
      `/* lpCoverage.prefixBoundaries */ select to_block,to_block_hash from
       lp_evidence_zero_prefixes where lane_id=$1 and generation=$2 order by to_block`,
      [lane.laneId, lane.generation.toString(10)],
    );
    return rows.rows.map((row) => ({ toBlock: BigInt(row.to_block),
      toBlockHash: row.to_block_hash }));
  }

  async rewind(lane: CoverageLane, ancestor: AgreedCoverageBlock | null,
    lease: CoverageLease, prefixProofs: readonly CoveragePrefixProof[] = []): Promise<CoverageLane> {
    return this.#sql.transaction(async (tx) => {
      // Charged-row forks share the same global -> version -> cursor -> lease
      // prefix as evidence binding. Taking the cursor first creates a real
      // PostgreSQL deadlock cycle with a resolver that already owns quota.
      await tx.query(`/* lpCoverage.rewindQuotaEnsure */ insert into lp_evidence_quota_counters
        (scope,coverage_version,logical_bytes,block_rows,candidate_rows,requirement_rows,
         zero_expiry_rows,row_version,updated_at)
        values('global','',0,0,0,0,0,0,now()),
              ('coverage-version',$1,0,0,0,0,0,0,now())
        on conflict(scope,coverage_version) do nothing`, [lane.coverageVersion]);
      const globalRows = await tx.query<QuotaRow>(`/* lpCoverage.rewindQuotaGlobal */ select *
        from lp_evidence_quota_counters where scope='global' and coverage_version='' for update`);
      const versionRows = await tx.query<QuotaRow>(`/* lpCoverage.rewindQuotaVersion */ select *
        from lp_evidence_quota_counters where scope='coverage-version' and coverage_version=$1
        for update`, [lane.coverageVersion]);
      const global = globalRows.rows[0]; const version = versionRows.rows[0];
      if (global === undefined || version === undefined) throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      const locked = await lockLane(tx, lane.laneId);
      if (locked === null || locked.generation !== lane.generation ||
          locked.rowVersion !== lane.rowVersion) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      await assertLease(tx, locked, lease, Date.now());
      const prefixes = await tx.query<ZeroPrefixRow>(
        `/* lpCoverage.rewindPrefixesLock */ select * from lp_evidence_zero_prefixes
         where lane_id=$1 and generation=$2 order by journal_owner,journal_agent,journal_action,
          journal_idempotency_key for update`, [lane.laneId, lane.generation.toString(10)],
      );
      for (const prefix of prefixes.rows) {
        const proof = prefixProofs.find((row) => row.toBlock === BigInt(prefix.to_block));
        const safe = ancestor !== null && ancestor.number >= BigInt(prefix.to_block) &&
          proof?.agreed === true && proof.toBlockHash === prefix.to_block_hash;
        if (!safe) {
          const unavailable = await tx.query<{ journal_owner: string }>(
            `/* lpCoverage.rewindPrefixUnavailable */ update lp_evidence_requirements set
             state='unavailable',unavailable_code='compacted-prefix-reorg',row_version=row_version+1,
             updated_at=$5 where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
             journal_idempotency_key=$4 and state='eligible' and unavailable_code is null and
             coverage_generation=$6::bigint returning journal_owner`,
            [prefix.journal_owner, prefix.journal_agent, prefix.journal_action,
              prefix.journal_idempotency_key, new Date(), lane.generation.toString(10)],
          );
          if (unavailable.rows[0] === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
          continue;
        }
        const key = { journalOwner: prefix.journal_owner, journalAgent: prefix.journal_agent,
          journalAction: prefix.journal_action,
          journalIdempotencyKey: prefix.journal_idempotency_key };
        const carry = zeroPrefixCarryDigest({ coverageVersion: lane.coverageVersion,
          quorumId: lane.quorumId, laneId: lane.laneId,
          requirementKeyHash: evidenceRequirementKeyHash(key), oldGeneration: lane.generation,
          newGeneration: lane.generation + 1n, fromBlock: BigInt(prefix.from_block),
          toBlock: BigInt(prefix.to_block), toBlockHash: prefix.to_block_hash,
          sourceAccumulator: prefix.required_source_digest_accumulator,
          oldPrefixDigest: prefix.prefix_digest });
        if (BigInt(prefix.charged_logical_bytes) !== zeroPrefixChargedLogicalBytes(key)) {
          throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
        }
        const carried = await tx.query<{ journal_owner: string }>(
          `/* lpCoverage.rewindPrefixCarry */ update lp_evidence_zero_prefixes set
           generation=$5,generation_carry_digest=$6,carry_parent_digest=$7,
           carry_source_accumulator=$8,carried_from_generation=$9,carry_from_block=$10,
           carry_to_block=$11,carry_to_block_hash=$12,prefix_digest=$6,updated_at=$13
           where journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
           journal_idempotency_key=$4 and generation=$9 and prefix_digest=$7 and
           charged_logical_bytes=$14 returning journal_owner`, [prefix.journal_owner,
            prefix.journal_agent, prefix.journal_action, prefix.journal_idempotency_key,
            (lane.generation + 1n).toString(10), carry, prefix.prefix_digest,
            prefix.required_source_digest_accumulator, lane.generation.toString(10),
            prefix.from_block, prefix.to_block, prefix.to_block_hash, new Date(),
            prefix.charged_logical_bytes],
        );
        if (carried.rows[0] === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      }
      const unavailableRequirements = await tx.query<{ journal_owner: string }>(
        `/* lpCoverage.rewindRequirementsUnavailable */ update lp_evidence_requirements set
         state='unavailable',unavailable_code='coverage-generation-reorg',
         row_version=row_version+1,updated_at=$4 where lane_id=$1 and state='eligible' and
         unavailable_code is null and coverage_generation=$2::bigint and
         ($3::numeric is null or begun_at_block>$3::numeric) returning journal_owner`,
        [lane.laneId, lane.generation.toString(10), ancestor?.number.toString(10) ?? null,
          new Date()],
      );
      void unavailableRequirements;
      await tx.query(
        `/* lpCoverage.rewindRequirementsCarry */ update lp_evidence_requirements set
         coverage_generation=$3::bigint,row_version=row_version+1,updated_at=$4 where lane_id=$1 and
         coverage_generation=$2::bigint and state='eligible' and unavailable_code is null`,
        [lane.laneId, lane.generation.toString(10), (lane.generation + 1n).toString(10), new Date()],
      );
      const chunks = await tx.query<RewindChunkRow>(
        `/* lpCoverage.rewindChunksLock */ select * from lp_evidence_chunks where lane_id=$1 and
         generation=$2 and state<>'invalidated'
         order by source_id,from_block,to_block for update`, [lane.laneId,
          lane.generation.toString(10)],
      );
      const rawChargeRows = ancestor === null ? { rows: [{ block_bytes: "0",
        candidate_bytes: "0", block_rows: 0, candidate_rows: 0 }] } :
        await tx.query<RewindRawChargeRow>(`/* lpCoverage.rewindRawCharge */ select
          coalesce((select sum(logical_bytes) from lp_evidence_blocks where lane_id=$1 and
            generation=$2 and block_number<=$3::numeric),0) block_bytes,
          coalesce((select sum(logical_bytes) from lp_evidence_candidates where lane_id=$1 and
            generation=$2 and block_number<=$3::numeric),0) candidate_bytes,
          (select count(*) from lp_evidence_blocks where lane_id=$1 and generation=$2 and
            block_number<=$3::numeric) block_rows,
          (select count(*) from lp_evidence_candidates where lane_id=$1 and generation=$2 and
            block_number<=$3::numeric) candidate_rows`, [lane.laneId,
          lane.generation.toString(10), ancestor.number.toString(10)]);
      const rawCharge = rawChargeRows.rows[0];
      if (rawCharge === undefined) throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
      const carriedChunkCharge = chunks.rows.filter((chunk) => ancestor !== null &&
        chunk.state === "complete" && BigInt(chunk.from_block) <= ancestor.number)
        .reduce((sum, chunk) => sum + BigInt(chunk.charged_logical_bytes), 0n);
      const addedLogicalBytes = carriedChunkCharge + BigInt(rawCharge.block_bytes) +
        BigInt(rawCharge.candidate_bytes);
      const addedBlockRows = Number(rawCharge.block_rows);
      const addedCandidateRows = Number(rawCharge.candidate_rows);
      if (!Number.isSafeInteger(addedBlockRows) || !Number.isSafeInteger(addedCandidateRows) ||
          BigInt(global.logical_bytes) + addedLogicalBytes >
            BigInt(this.#config.maxGlobalLogicalBytes) ||
          BigInt(version.logical_bytes) + addedLogicalBytes >
            BigInt(this.#config.maxVersionLogicalBytes) ||
          Number(version.block_rows) + addedBlockRows > this.#config.maxVersionBlockRows ||
          Number(version.candidate_rows) + addedCandidateRows >
            this.#config.maxVersionCandidateRows) {
        throw new Error("LP_EVIDENCE_STORAGE_QUOTA");
      }
      for (const chunk of chunks.rows) {
        if (BigInt(chunk.charged_logical_bytes) !== chunkChargedLogicalBytes(chunk.source_id)) {
          throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
        }
        const chunkFrom = BigInt(chunk.from_block);
        const chunkTo = BigInt(chunk.to_block);
        const carry = ancestor !== null && chunk.state === "complete" &&
          chunkFrom <= ancestor.number;
        const exactChunkParams = [chunk.coverage_version, chunk.quorum_id, chunk.lane_id,
          chunk.generation, chunk.source_id, chunk.from_block, chunk.to_block, chunk.state,
          chunk.lease_fence, chunk.first_hash, chunk.last_hash, chunk.ordered_block_digest,
          chunk.candidate_count, chunk.completed_at, chunk.error_code,
          chunk.charged_logical_bytes] as const;
        let carried: { readonly carryTo: bigint; readonly lastHash: Hex;
          readonly digest: Hex; readonly candidateCount: number } | null = null;
        if (carry) {
          const carryTo = chunkTo < ancestor.number ? chunkTo : ancestor.number;
          const blockRows = await tx.query<RewindBlockRow>(
            `/* lpCoverage.rewindChunkBlocks */ select block_number,block_hash,parent_hash,
             block_timestamp,ordered_transaction_digest from lp_evidence_blocks where
             coverage_version=$1 and quorum_id=$2 and lane_id=$3 and generation=$4 and
             source_id=$5 and block_number between $6 and $7 order by block_number for share`,
            [chunk.coverage_version, chunk.quorum_id, chunk.lane_id, chunk.generation,
              chunk.source_id, chunk.from_block, chunk.to_block],
          );
          const expectedCount = Number(chunkTo - chunkFrom + 1n);
          const canonicalBlocks = blockRows.rows.map((block) => ({
            number: BigInt(block.block_number), hash: block.block_hash,
            parentHash: block.parent_hash, timestamp: BigInt(block.block_timestamp),
            transactionListDigest: block.ordered_transaction_digest,
          }));
          if (!Number.isSafeInteger(expectedCount) || canonicalBlocks.length !== expectedCount ||
              canonicalBlocks.some((block, index) =>
                block.number !== chunkFrom + BigInt(index)) ||
              canonicalBlocks[0]?.hash !== chunk.first_hash ||
              canonicalBlocks.at(-1)?.hash !== chunk.last_hash) {
            throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: carried chunk raw rows are incomplete.");
          }
          const fullCandidateRows = await tx.query<{ candidate_count: string | number }>(
            `/* lpCoverage.rewindChunkCandidateCount */ select count(*) candidate_count from
             lp_evidence_candidates where coverage_version=$1 and quorum_id=$2 and lane_id=$3 and
             generation=$4 and source_id=$5 and block_number between $6 and $7`,
            [chunk.coverage_version, chunk.quorum_id, chunk.lane_id, chunk.generation,
              chunk.source_id, chunk.from_block, chunk.to_block],
          );
          const fullCandidateCount = Number(fullCandidateRows.rows[0]?.candidate_count ?? -1);
          if (!Number.isSafeInteger(fullCandidateCount) || fullCandidateCount < 0 ||
              fullCandidateCount !== Number(chunk.candidate_count)) {
            throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: carried chunk candidates are unreadable.");
          }
          const carriedBlocks = canonicalBlocks.filter((block) => block.number <= carryTo);
          const candidateCount = carryTo === chunkTo ? fullCandidateCount :
            Number((await tx.query<{ candidate_count: string | number }>(
              `/* lpCoverage.rewindChunkCandidateCount */ select count(*) candidate_count from
               lp_evidence_candidates where coverage_version=$1 and quorum_id=$2 and lane_id=$3 and
               generation=$4 and source_id=$5 and block_number between $6 and $7`,
              [chunk.coverage_version, chunk.quorum_id, chunk.lane_id, chunk.generation,
                chunk.source_id, chunk.from_block, carryTo.toString(10)],
            )).rows[0]?.candidate_count ?? -1);
          if (!Number.isSafeInteger(candidateCount) || candidateCount < 0 ||
              candidateCount > fullCandidateCount) {
            throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: split chunk candidates are unreadable.");
          }
          const lastHash = carriedBlocks.at(-1)?.hash;
          if (lastHash === undefined) {
            throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: carried chunk terminal block is missing.");
          }
          const newDigest = chunkDigest({ sourceId: chunk.source_id, laneId: lane.laneId,
            generation: lane.generation + 1n, fromBlock: chunkFrom, toBlock: carryTo,
            blocks: carriedBlocks });
          carried = { carryTo, lastHash, digest: newDigest, candidateCount };
        }
        const invalidated = await tx.query<{ source_id: string }>(
          `/* lpCoverage.invalidateChunkExact */ update lp_evidence_chunks set
           state='invalidated',lease_fence=lease_fence+1 where coverage_version=$1 and
           quorum_id=$2 and lane_id=$3 and generation=$4 and source_id=$5 and from_block=$6 and
           to_block=$7 and state=$8 and lease_fence=$9 and first_hash is not distinct from $10 and
           last_hash is not distinct from $11 and ordered_block_digest is not distinct from $12 and
           candidate_count=$13 and completed_at is not distinct from $14 and
           error_code is not distinct from $15 and charged_logical_bytes=$16 returning source_id`,
          exactChunkParams,
        );
        if (invalidated.rows[0] === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
        if (carried !== null) {
          const inserted = await tx.query<{ source_id: string }>(
            `/* lpCoverage.rewindChunkInsert */ insert into lp_evidence_chunks
             (coverage_version,quorum_id,lane_id,generation,source_id,from_block,to_block,state,
              lease_fence,first_hash,last_hash,ordered_block_digest,candidate_count,
              charged_logical_bytes,completed_at,error_code)
             values($1,$2,$3,$4,$5,$6,$7,'complete',$8,$9,$10,$11,$12,$13,$14,null)
             on conflict do nothing returning source_id`, [chunk.coverage_version,
              chunk.quorum_id, chunk.lane_id, (lane.generation + 1n).toString(10),
              chunk.source_id, chunk.from_block, carried.carryTo.toString(10),
              lease.fence.toString(10), chunk.first_hash, carried.lastHash, carried.digest,
              carried.candidateCount, chunk.charged_logical_bytes, new Date()],
          );
          if (inserted.rows[0] === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
        }
      }
      if (ancestor !== null) {
        // The old generation stays byte-for-byte auditable. Copy its canonical
        // prefix into the new generation and charge that new identity; never
        // rewrite the original generation or orphan its rejected tail.
        const copiedBlocks = await tx.query<{ logical_bytes: string }>(
          `/* lpCoverage.rewindBlocksCarry */ insert into lp_evidence_blocks
           (coverage_version,quorum_id,lane_id,generation,source_id,block_number,block_hash,
            parent_hash,block_timestamp,ordered_transaction_digest,finalized_observed_at,logical_bytes)
           select coverage_version,quorum_id,lane_id,$3,source_id,block_number,block_hash,
            parent_hash,block_timestamp,ordered_transaction_digest,finalized_observed_at,logical_bytes
           from lp_evidence_blocks where lane_id=$1 and generation=$2 and block_number<=$4::numeric
           on conflict do nothing returning logical_bytes`,
        [lane.laneId, lane.generation.toString(10), (lane.generation + 1n).toString(10),
          ancestor.number.toString(10)]);
        const copiedCandidates = await tx.query<{ logical_bytes: string }>(
          `/* lpCoverage.rewindCandidatesCarry */ insert into lp_evidence_candidates
           (coverage_version,quorum_id,lane_id,generation,source_id,block_number,block_hash,
            transaction_hash,transaction_index,input_hash,log_index,orchestrator,
            orchestrator_version,decoder,intent_index,member_count,eoa,nonce,execution_data_hash,
            key_hash,receipt_status,incremented,event_error,event_topics_hash,event_data_hash,
            candidate_digest,logical_bytes)
           select coverage_version,quorum_id,lane_id,$3,source_id,block_number,block_hash,
            transaction_hash,transaction_index,input_hash,log_index,orchestrator,
            orchestrator_version,decoder,intent_index,member_count,eoa,nonce,execution_data_hash,
            key_hash,receipt_status,incremented,event_error,event_topics_hash,event_data_hash,
            candidate_digest,logical_bytes from lp_evidence_candidates where lane_id=$1 and
            generation=$2 and block_number<=$4::numeric on conflict do nothing returning logical_bytes`,
        [lane.laneId, lane.generation.toString(10), (lane.generation + 1n).toString(10),
          ancestor.number.toString(10)]);
        const copiedBlockBytes = copiedBlocks.rows.reduce((sum, row) =>
          sum + BigInt(row.logical_bytes), 0n);
        const copiedCandidateBytes = copiedCandidates.rows.reduce((sum, row) =>
          sum + BigInt(row.logical_bytes), 0n);
        if (copiedBlocks.rows.length !== addedBlockRows ||
            copiedCandidates.rows.length !== addedCandidateRows ||
            copiedBlockBytes !== BigInt(rawCharge.block_bytes) ||
            copiedCandidateBytes !== BigInt(rawCharge.candidate_bytes)) {
          throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: carried raw rows changed under lock.");
        }
      }
      for (const [scope, versionKey] of [["global", ""],
        ["coverage-version", lane.coverageVersion]] as const) {
        const updated = await tx.query<{ row_version: string }>(
          `/* lpCoverage.rewindQuotaUpdate */ update lp_evidence_quota_counters set
           logical_bytes=logical_bytes+$3::bigint,block_rows=block_rows+$4::bigint,
           candidate_rows=candidate_rows+$5::bigint,row_version=row_version+1,updated_at=now()
           where scope=$1 and coverage_version=$2 returning row_version`, [scope, versionKey,
            addedLogicalBytes.toString(10), addedBlockRows, addedCandidateRows]);
        if (updated.rows[0] === undefined) throw new Error("LP_EVIDENCE_CHARGE_CONFLICT");
      }
      const result = await tx.query<CursorRow>(`/* lpCoverage.cursorRewind */ update lp_evidence_cursors
        set generation=generation+1,state=$2,covered_through=$3,covered_through_hash=$4,
        row_version=row_version+1,updated_at=now() where lane_id=$1 and generation=$5 and
        row_version=$6 returning *,$7::numeric covered_through_timestamp`,
      [lane.laneId, ancestor === null ? "exhausted" : "active",
        ancestor?.number.toString(10) ?? null, ancestor?.hash ?? null,
        lane.generation.toString(10), lane.rowVersion, ancestor?.timestamp.toString(10) ?? null]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("LP_EVIDENCE_CURSOR_CONFLICT");
      return rowToLane(row);
    });
  }

  async snapshot(input: Parameters<LpCoverageStore["snapshot"]>[0]): Promise<CoverageSnapshot | null> {
    const requirementRows = await this.#sql.query<CompactRequirementRow>(
      `/* lpCoverage.snapshotRequirement */ select * from lp_evidence_requirements where
       journal_owner=$1 and journal_agent=$2 and journal_action=$3 and
       journal_idempotency_key=$4 and $5::numeric=$5::numeric and $6::numeric=$6::numeric and
       $7::text=$7::text and $8::text=$8::text and $9::text=$9::text and $10::text=$10::text and
       $11::bigint=$11::bigint and $12::text=$12::text and
       $13::text is not distinct from $13::text and $14::bigint=$14::bigint and
       $15::bigint=$15::bigint`, [...requirementParamsForCoverage(input.requirement),
        input.requirement.begunAtBlock.toString(10), input.requirement.expiry.toString(10),
        input.requirement.preparedIdentityHash, input.requirement.coverageVersion,
        input.requirement.quorumId, input.requirement.laneId,
        (input.requirement.coverageGeneration ?? 0n).toString(10), input.requirement.state,
        input.requirement.unavailableCode, input.requirement.rowVersion.toString(10),
        input.requirement.chargedLogicalBytes.toString(10)],
    );
    const requirementRow = requirementRows.rows[0];
    if (requirementRow === undefined) return null;
    const requirement = compactRequirement(requirementRow);
    if (!sameRequirementIdentity(requirement, input.requirement)) return null;
    const lane = await this.#getLane(requirement.laneId);
    if (lane === null || lane.state !== "active" || lane.coveredThrough === null ||
        lane.coveredThroughHash === null || lane.coveredThroughTimestamp === null ||
        !requirementAuthorizesLane(requirement, lane)) return null;
    const candidates = await this.#sql.query<CandidateRow>(`/* lpCoverage.candidateMatch */
      select distinct on (candidate_digest) * from lp_evidence_candidates where lane_id=$1 and
       generation=$2 and block_number between $3 and $4 and eoa=$5 and nonce=$6 and
       execution_data_hash=$7 and key_hash=$8 order by candidate_digest,source_id`,
    [lane.laneId, lane.generation.toString(10), requirement.begunAtBlock.toString(10),
      lane.coveredThrough.toString(10), input.identity.eoa, input.identity.nonce,
      input.identity.executionDataHash, input.identity.keyHash]);
    const candidateValues = candidates.rows.map(rowToCandidate);
    const common = { scheme: "lp-landing-evidence-v1" as const,
      preparedIdentityHash: requirement.preparedIdentityHash,
      coverageVersion: lane.coverageVersion, quorumId: lane.quorumId, laneId: lane.laneId,
      generation: lane.generation.toString(10), cursorRowVersion: lane.rowVersion.toString(10),
      requirementState: requirement.state,
      requirementUnavailableCode: requirement.unavailableCode,
      requirementGeneration: (requirement.coverageGeneration ?? 0n).toString(10),
      requirementRowVersion: requirement.rowVersion.toString(10),
      requiredSourceIds: [...input.requiredSourceIds].sort(),
      fromBlock: requirement.begunAtBlock.toString(10),
      toBlock: lane.coveredThrough.toString(10), toBlockHash: lane.coveredThroughHash };
    const positive = candidateValues.filter(isPositiveCandidate);
    if (candidateValues.length === 1 && positive.length === 1) {
      const found = candidateValues[0];
      if (found === undefined) return null;
      return canonicalLandingEvidence({ ...common, outcome: "landed", landed: {
        txHash: found.txHash, inputHash: found.inputHash,
        blockNumber: found.blockNumber.toString(10), blockHash: found.blockHash,
        transactionIndex: found.transactionIndex.toString(10), intentIndex: found.intentIndex,
        logIndex: found.logIndex.toString(10), eventTopicsHash: found.eventTopicsHash,
        eventDataHash: found.eventDataHash,
      } });
    }
    if (candidateValues.length > 1) {
      return { outcome: "ambiguous", reason: "multiple-matching-candidates" };
    }
    if (candidateValues.length === 1) {
      return { outcome: "ambiguous", reason: "matching-candidate-not-successful" };
    }
    if (requirement.expiry === 0n ||
        lane.coveredThroughTimestamp <= requirement.expiry +
          BigInt(input.expirySafetySeconds)) return null;
    return canonicalLandingEvidence({ ...common, outcome: "absent", absent: {
      toBlockTimestamp: lane.coveredThroughTimestamp.toString(10),
      expirySafetySeconds: input.expirySafetySeconds, zeroMatchCount: 0,
    } });
  }

  async validate(evidence: CoverageSnapshot): Promise<boolean> {
    if (evidence.outcome === "ambiguous") return false;
    const lane = await this.#getLane(evidence.laneId);
    const requiredIds = this.#config.sources.filter((source) => source.role === "required")
      .map((source) => source.id).sort();
    if (lane === null || lane.state !== "active" || !evidenceHasCanonicalDigest(evidence) ||
        evidence.requiredSourceIds.join("\u0000") !== requiredIds.join("\u0000") ||
        lane.generation.toString(10) !== evidence.generation ||
        lane.rowVersion < Number(evidence.cursorRowVersion) || lane.coveredThrough === null ||
        lane.coveredThrough < BigInt(evidence.toBlock)) return false;
    const requirement = await this.#sql.query<{ journal_owner: string }>(
      `/* lpCoverage.validateRequirement */ select journal_owner from lp_evidence_requirements
       where lane_id=$1 and prepared_identity_hash=$2 and begun_at_block=$3::numeric and
       coverage_version=$4 and quorum_id=$5 and state='eligible' and unavailable_code is null and
       coverage_generation=$6::bigint and row_version=$7::bigint`, [evidence.laneId,
        evidence.preparedIdentityHash, evidence.fromBlock, evidence.coverageVersion,
        evidence.quorumId, evidence.requirementGeneration, evidence.requirementRowVersion],
    );
    if (requirement.rows.length !== 1) return false;
    const block = await this.#sql.query<{ source_count: string | number }>(
      `/* lpCoverage.validateBlock */ select count(distinct source_id) source_count
       from lp_evidence_blocks where lane_id=$1 and generation=$2 and block_number=$3 and
       block_hash=$4`, [evidence.laneId, evidence.generation, evidence.toBlock,
        evidence.toBlockHash],
    );
    if (Number(block.rows[0]?.source_count ?? 0) !== requiredIds.length) return false;
    if (evidence.outcome === "landed" && evidence.landed !== undefined) {
      const found = await this.#sql.query<{ source_count: string | number }>(
        `/* lpCoverage.validateCandidate */ select count(distinct source_id) source_count
         from lp_evidence_candidates where lane_id=$1 and generation=$2 and
         transaction_hash=$3 and input_hash=$4 and block_number=$5 and block_hash=$6 and
         transaction_index=$7 and intent_index=$8 and log_index=$9 and event_topics_hash=$10 and
         event_data_hash=$11`, [evidence.laneId, evidence.generation,
          evidence.landed.txHash, evidence.landed.inputHash, evidence.landed.blockNumber,
          evidence.landed.blockHash, evidence.landed.transactionIndex,
          evidence.landed.intentIndex, evidence.landed.logIndex,
          evidence.landed.eventTopicsHash, evidence.landed.eventDataHash],
      );
      return Number(found.rows[0]?.source_count ?? 0) === requiredIds.length;
    }
    return evidence.outcome === "absent";
  }

  async #getLane(laneId: Hex): Promise<CoverageLane | null> {
    const result = await this.#sql.query<CursorRow>(`/* lpCoverage.cursorGet */ select c.*,
      (select block_timestamp from lp_evidence_blocks b where b.coverage_version=c.coverage_version
       and b.quorum_id=c.quorum_id and b.lane_id=c.lane_id and b.generation=c.generation
       and b.block_number=c.covered_through order by source_id limit 1) covered_through_timestamp
      from lp_evidence_cursors c where lane_id=$1`, [laneId]);
    const row = result.rows[0]; return row === undefined ? null : rowToLane(row);
  }
  close(): Promise<void> { return this.#sql.close(); }
}

type CursorRow = { coverage_version: Hex; quorum_id: Hex; lane_id: Hex;
  purpose: "base" | "backfill"; admission_key_hash: Hex; origin_block: string;
  covered_through: string | null; covered_through_hash: Hex | null;
  covered_through_timestamp: string | null; raw_retained_from: string;
  generation: string; state: CoverageLane["state"]; row_version: string | number };
type CandidateRow = { transaction_hash: Hex; input_hash: Hex; block_number: string;
  block_hash: Hex; transaction_index: string; intent_index: string | number;
  member_count: string | number; eoa: Address; nonce: string; execution_data_hash: Hex;
  key_hash: Hex; log_index: string; event_topics_hash: Hex; event_data_hash: Hex;
  receipt_status: string; incremented: boolean; event_error: Hex; candidate_digest: Hex };
type QuotaRow = { logical_bytes: string; block_rows: string | number;
  candidate_rows: string | number };
type LeaseRow = { holder_id: string; fence: string | number; lease_until: Date | string };
type CompactRequirementRow = { journal_owner: string; journal_agent: string;
  journal_action: string; journal_idempotency_key: string; begun_at_block: string;
  expiry: string; prepared_identity_hash: Hex; coverage_version: Hex; quorum_id: Hex;
  lane_id: Hex; coverage_generation: string | number | bigint;
  state: EvidenceRequirement["state"]; unavailable_code: string | null;
  created_at: Date | string; terminal_at: Date | string | null;
  evidence_retained_until: Date | string | null; updated_at: Date | string;
  row_version: string | number; charged_logical_bytes: string };
type CompactChunkRow = { source_id: string; from_block: string; to_block: string;
  ordered_block_digest: Hex; charged_logical_bytes: string };
type RewindChunkRow = { coverage_version: Hex; quorum_id: Hex; lane_id: Hex;
  generation: string; source_id: string; from_block: string; to_block: string;
  state: "pending" | "leased" | "complete" | "gap"; lease_fence: string;
  first_hash: Hex | null; last_hash: Hex | null; ordered_block_digest: Hex | null;
  candidate_count: string; completed_at: Date | string | null; error_code: string | null;
  charged_logical_bytes: string };
type RewindBlockRow = { block_number: string; block_hash: Hex; parent_hash: Hex;
  block_timestamp: string; ordered_transaction_digest: Hex };
type RewindRawChargeRow = { block_bytes: string; candidate_bytes: string;
  block_rows: string | number; candidate_rows: string | number };
type ZeroPrefixRow = { journal_owner: string; journal_agent: string; journal_action: string;
  journal_idempotency_key: string; generation: string; from_block: string; to_block: string;
  to_block_hash: Hex; prefix_digest: Hex; required_source_digest_accumulator: Hex;
  charged_logical_bytes: string };

/** Immutable max-future-footprint reservation for every legal chunk state. */
export function chunkChargedLogicalBytes(sourceId: string): bigint {
  return evidenceChunkChargedLogicalBytes(sourceId);
}

/** Actual immutable-row charge under lp-evidence-logical-row-v1. */
export function blockLogicalBytes(sourceId: string, _block: AgreedCoverageBlock): bigint {
  const source = BigInt(new TextEncoder().encode(sourceId).length);
  // overhead + coverage/quorum/lane hashes + generation/source + block number,
  // three block digests, timestamp and finalized-observed timestamp.
  return 64n + 3n * 32n + 8n + 4n + source + 8n + 3n * 32n + 8n + 8n;
}

export function candidateLogicalBytes(sourceId: string, _candidate: CoverageCandidate): bigint {
  const source = BigInt(new TextEncoder().encode(sourceId).length);
  const version = BigInt(new TextEncoder().encode("0.5.5").length);
  const decoder = BigInt(new TextEncoder().encode("porto-orchestrator-intent-v055").length);
  // Every immutable schema field is charged once in its canonical representation.
  return 64n + 3n * 32n + 8n + 4n + source + 8n + 32n + 32n + 8n + 32n +
    8n + 20n + 4n + version + 4n + decoder + 8n + 8n + 20n + 32n + 32n +
    32n + 8n + 1n + 4n + 32n + 32n + 32n;
}

export function zeroPrefixChargedLogicalBytes(key: EvidenceRequirementKey): bigint {
  const texts = [key.journalAgent, key.journalAction, key.journalIdempotencyKey]
    .reduce((sum, value) => sum + 4n + BigInt(new TextEncoder().encode(value).length), 0n);
  // Immutable identity/current fields plus the longest legal projection with
  // every generation-carry explanation field present (Revision 9 §4.4).
  return 64n + 20n + texts + 3n * 32n + 3n * 8n + 3n * 32n + 8n +
    3n * 32n + 3n * 8n + 32n + 8n;
}

type EvidenceRequirementKey = Pick<EvidenceRequirement, "journalOwner" | "journalAgent" |
  "journalAction" | "journalIdempotencyKey">;
function requirementKey(key: EvidenceRequirementKey): string {
  return `${key.journalOwner.toLowerCase()}\u0000${key.journalAgent}\u0000${key.journalAction}\u0000${key.journalIdempotencyKey}`;
}

function sameRequirementIdentity(left: EvidenceRequirement, right: EvidenceRequirement): boolean {
  return requirementKey(left) === requirementKey(right) &&
    left.begunAtBlock === right.begunAtBlock && left.expiry === right.expiry &&
    left.preparedIdentityHash === right.preparedIdentityHash &&
    left.coverageVersion === right.coverageVersion && left.quorumId === right.quorumId &&
    left.laneId === right.laneId;
}

function assertSameRequirementIdentity(left: EvidenceRequirement, right: EvidenceRequirement): void {
  if (!sameRequirementIdentity(left, right)) {
    throw new Error("LP_EVIDENCE_REQUIREMENT_CONFLICT");
  }
}

function requirementAuthorizesLane(requirement: EvidenceRequirement, lane: CoverageLane): boolean {
  return requirement.state === "eligible" && requirement.unavailableCode === null &&
    requirement.coverageVersion === lane.coverageVersion && requirement.quorumId === lane.quorumId &&
    requirement.laneId === lane.laneId &&
    (requirement.coverageGeneration ?? 0n) === lane.generation;
}

function requirementAuthorizesCoverageEvidence(
  requirement: EvidenceRequirement,
  evidence: LandingEvidenceV1,
): boolean {
  return requirement.state === "eligible" && requirement.unavailableCode === null &&
    requirement.preparedIdentityHash === evidence.preparedIdentityHash &&
    requirement.coverageVersion === evidence.coverageVersion &&
    requirement.quorumId === evidence.quorumId && requirement.laneId === evidence.laneId &&
    requirement.begunAtBlock.toString(10) === evidence.fromBlock &&
    (requirement.coverageGeneration ?? 0n).toString(10) === evidence.requirementGeneration &&
    requirement.rowVersion.toString(10) === evidence.requirementRowVersion;
}

function rowToLane(row: CursorRow): CoverageLane { return { coverageVersion: row.coverage_version,
  quorumId: row.quorum_id, laneId: row.lane_id, purpose: row.purpose,
  admissionKeyHash: row.admission_key_hash, originBlock: BigInt(row.origin_block),
  coveredThrough: row.covered_through === null ? null : BigInt(row.covered_through),
  coveredThroughHash: row.covered_through_hash,
  coveredThroughTimestamp: row.covered_through_timestamp === null ? null : BigInt(row.covered_through_timestamp),
  rawRetainedFrom: BigInt(row.raw_retained_from), generation: BigInt(row.generation),
  state: row.state, rowVersion: Number(row.row_version) }; }
function rowToCandidate(row: CandidateRow): CoverageCandidate { return { txHash: row.transaction_hash,
  inputHash: row.input_hash, blockNumber: BigInt(row.block_number), blockHash: row.block_hash,
  transactionIndex: BigInt(row.transaction_index), intentIndex: Number(row.intent_index),
  memberCount: Number(row.member_count), eoa: row.eoa, nonce: BigInt(row.nonce),
  executionDataHash: row.execution_data_hash, keyHash: row.key_hash,
  receiptStatus: BigInt(row.receipt_status), incremented: row.incremented,
  eventError: row.event_error,
  logIndex: BigInt(row.log_index), eventTopicsHash: row.event_topics_hash,
  eventDataHash: row.event_data_hash, candidateDigest: row.candidate_digest }; }

function isPositiveCandidate(candidate: CoverageCandidate): boolean {
  return (candidate.receiptStatus ?? 1n) === 1n && (candidate.incremented ?? true) &&
    (candidate.eventError ?? "0x00000000") === "0x00000000";
}
function compactRequirement(row: CompactRequirementRow): EvidenceRequirement {
  return { journalOwner: row.journal_owner, journalAgent: row.journal_agent,
    journalAction: row.journal_action, journalIdempotencyKey: row.journal_idempotency_key,
    begunAtBlock: BigInt(row.begun_at_block), expiry: BigInt(row.expiry),
    preparedIdentityHash: row.prepared_identity_hash, coverageVersion: row.coverage_version,
    quorumId: row.quorum_id, laneId: row.lane_id,
    coverageGeneration: BigInt(row.coverage_generation), state: row.state,
    unavailableCode: row.unavailable_code, createdAt: new Date(row.created_at).getTime(),
    terminalAt: row.terminal_at === null ? null : new Date(row.terminal_at).getTime(),
    evidenceRetainedUntil: row.evidence_retained_until === null ? null :
      new Date(row.evidence_retained_until).getTime(), updatedAt: new Date(row.updated_at).getTime(),
    rowVersion: Number(row.row_version), chargedLogicalBytes: BigInt(row.charged_logical_bytes) };
}
function requirementParamsForCoverage(key: EvidenceRequirementKey): readonly unknown[] {
  return [key.journalOwner.toLowerCase(), key.journalAgent, key.journalAction,
    key.journalIdempotencyKey];
}
function evidenceHasCanonicalDigest(evidence: LandingEvidenceV1): boolean {
  try {
    const { evidenceDigest, ...body } = evidence;
    return canonicalLandingEvidence(body).evidenceDigest === evidenceDigest;
  } catch { return false; }
}
async function lockLane(sql: SqlClient, laneId: Hex): Promise<CoverageLane | null> {
  const result = await sql.query<CursorRow>(`/* lpCoverage.cursorLock */ select *,
    null::numeric covered_through_timestamp from lp_evidence_cursors where lane_id=$1 for update`,
  [laneId]); const row = result.rows[0]; return row === undefined ? null : rowToLane(row); }
function rowToLease(row: LeaseRow): CoverageLease { return { holderId: row.holder_id,
  fence: BigInt(row.fence), leaseUntil: new Date(row.lease_until).getTime() }; }
async function assertLease(sql: SqlClient, lane: CoverageLane, lease: CoverageLease,
  now: number): Promise<void> {
  const result = await sql.query<LeaseRow>(`/* lpCoverage.leaseLock */ select holder_id,fence,
    lease_until from lp_evidence_leases where coverage_version=$1 and quorum_id=$2 and lane_id=$3
    for update`, [lane.coverageVersion, lane.quorumId, lane.laneId]);
  const row = result.rows[0];
  if (row === undefined || row.holder_id !== lease.holderId || BigInt(row.fence) !== lease.fence ||
      new Date(row.lease_until).getTime() !== lease.leaseUntil || lease.leaseUntil <= now) {
    throw new Error("LP_EVIDENCE_LEASE_CONFLICT");
  }
}

export async function createLpCoverageStore(config: LpEvidenceConfig,
  databaseUrl: string | undefined = process.env["DATABASE_URL"],
  memoryRegistry?: MemoryEvidenceRequirementRegistry): Promise<LpCoverageStore> {
  const url = databaseUrl?.trim() ?? "";
  return url === "" ? new MemoryLpCoverageStore(config, memoryRegistry, memoryRegistry !== undefined) :
    new PostgresLpCoverageStore(await createPgSqlClient(url), config);
}

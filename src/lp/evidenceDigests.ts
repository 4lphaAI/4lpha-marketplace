/** Canonical non-JSON byte codec for the Phase 3.9c coverage ledger. */
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import type { LpEvidenceConfig, LpEvidenceSourceConfig } from "../ops/config.js";
import { PORTO_V055_DECODER, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION } from "./preparedIntent.js";

type Bytes = Uint8Array;

const te = new TextEncoder();

function cat(parts: readonly Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function u32(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Evidence u32 is out of range.");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64(value: bigint): Bytes {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error("Evidence u64 is out of range.");
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(value >> 32n), false);
  view.setUint32(4, Number(value & 0xffff_ffffn), false);
  return out;
}

function uint256(value: bigint): Bytes {
  if (value < 0n || value >= 1n << 256n) throw new Error("Evidence uint256 is out of range.");
  return hexToBytes(`0x${value.toString(16).padStart(64, "0")}` as Hex);
}

function text(value: string): Bytes {
  const body = te.encode(value);
  return cat([u32(body.length), body]);
}

function array<T>(items: readonly T[], encode: (item: T) => Bytes): Bytes {
  return cat([u32(items.length), ...items.map(encode)]);
}

function hash(value: Hex): Bytes {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error("Evidence hash must be lowercase bytes32.");
  return hexToBytes(value);
}

function address(value: Address): Bytes {
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error("Evidence address must be lowercase.");
  return hexToBytes(value);
}

function digest(parts: readonly Bytes[]): Hex {
  return keccak256(bytesToHex(cat(parts)));
}

function sourceBytes(source: LpEvidenceSourceConfig): Bytes {
  return cat([text(source.id), text(source.operatorFamily), text(source.role),
    hash(source.endpointFingerprint as Hex)]);
}

const NUMERIC_CONFIG_FIELDS = [
  "expirySafetySeconds", "requestTimeoutMs", "perSourceConcurrency",
  "globalConcurrency", "requestsPerSecond", "chunkBlocks", "maxColdBackfillBlocks",
  "maxBackfillBlocksPerHour", "reorgRewindBlocks", "ownerSnapshotTimeoutMs",
  "maxGlobalLogicalBytes", "maxVersionLogicalBytes", "maxVersionBlockRows",
  "maxVersionCandidateRows", "maxRequirements", "maxZeroExpiryRequirements",
  "auditRetentionDays",
] as const satisfies readonly (keyof LpEvidenceConfig)[];

const COMPILED_NUMERIC_BOUNDS = [
  ["maxRpcResponseBytes", 8 * 1024 * 1024],
  ["maxTransactionsPerBlock", 500],
  ["maxIntentMembersPerTransaction", 32],
  ["maxCandidatesPerBlock", 256],
  ["maxDecodedIntentBytes", 4_096],
  ["maxAttempts", 5],
  ["circuitOpenAfterFailures", 10],
  ["observerLeaseMs", 600_000],
] as const;

export function coverageVersionFor(config: LpEvidenceConfig): Hex {
  const sources = [...config.sources].sort((a, b) => a.id.localeCompare(b.id));
  const decoder = cat([u64(56n), address(PORTO_V055_ORCHESTRATOR),
    text(PORTO_V055_VERSION), text(PORTO_V055_DECODER)]);
  const numeric = NUMERIC_CONFIG_FIELDS.map((name) =>
    cat([text(name), u64(BigInt(config[name]))]));
  const compiled = COMPILED_NUMERIC_BOUNDS.map(([name, value]) =>
    cat([text(name), u64(BigInt(value))]));
  return digest([text("4lpha:lp-evidence:coverage:v1"), u64(56n),
    array(sources, sourceBytes), array([decoder], (value) => value),
    text("all-required-byte-identical-v1"), text("rpc-finalized-tag-v1"),
    array([...numeric, ...compiled], (value) => value)]);
}

export function quorumIdFor(config: LpEvidenceConfig, coverageVersion: Hex): Hex {
  const required = config.sources.filter((source) => source.role === "required")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (required.length < 2) throw new Error("Evidence quorum needs at least two required sources.");
  return digest([text("4lpha:lp-evidence:quorum:v1"), hash(coverageVersion),
    array(required, (source) => cat([text(source.id), text(source.operatorFamily),
      hash(source.endpointFingerprint as Hex)]))]);
}

export function laneIdFor(input: {
  readonly coverageVersion: Hex; readonly quorumId: Hex;
  readonly purpose: "base" | "backfill"; readonly originBlock: bigint;
  readonly admissionKeyHash?: Hex;
}): Hex {
  const admission = input.purpose === "base"
    ? (`0x${"00".repeat(32)}` as Hex)
    : input.admissionKeyHash;
  if (admission === undefined) throw new Error("Backfill lane requires an admission key hash.");
  return digest([text("4lpha:lp-evidence:lane:v1"), hash(input.coverageVersion),
    hash(input.quorumId), new Uint8Array([input.purpose === "base" ? 0 : 1]),
    u64(input.originBlock), hash(admission)]);
}

export type CanonicalTransaction = {
  readonly index: bigint; readonly hash: Hex; readonly from: Address;
  readonly to: Address | null; readonly inputHash: Hex;
};

export function transactionListDigest(
  blockNumber: bigint,
  transactions: readonly CanonicalTransaction[],
): Hex {
  const ordered = [...transactions].sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
  return digest([text("4lpha:lp-evidence:transactions:v1"), u64(blockNumber),
    array(ordered, (tx) => cat([u64(tx.index), hash(tx.hash), address(tx.from),
      tx.to === null ? new Uint8Array([0]) : cat([new Uint8Array([1]), address(tx.to)]),
      hash(tx.inputHash)]))]);
}

export type CanonicalBlock = {
  readonly number: bigint; readonly hash: Hex; readonly parentHash: Hex;
  readonly timestamp: bigint; readonly transactionListDigest: Hex;
};

export function chunkDigest(input: {
  readonly sourceId: string; readonly laneId: Hex; readonly generation: bigint;
  readonly fromBlock: bigint; readonly toBlock: bigint;
  readonly blocks: readonly CanonicalBlock[];
}): Hex {
  const blocks = [...input.blocks].sort((a, b) => a.number < b.number ? -1 : 1);
  return digest([text("4lpha:lp-evidence:chunk:v1"), text(input.sourceId),
    hash(input.laneId), u64(input.generation), u64(input.fromBlock), u64(input.toBlock),
    array(blocks, (block) => cat([u64(block.number), hash(block.hash), hash(block.parentHash),
      u64(block.timestamp), hash(block.transactionListDigest)]))]);
}

/** Source-independent byte identity used before any all-required commit. */
export function agreedBlockRangeDigest(blocks: readonly CanonicalBlock[]): Hex {
  const ordered = [...blocks].sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
  return digest([text("4lpha:lp-evidence:agreed-range:v1"), array(ordered, (block) =>
    cat([u64(block.number), hash(block.hash), hash(block.parentHash), u64(block.timestamp),
      hash(block.transactionListDigest)]))]);
}

export type CanonicalCandidate = {
  readonly chainId: bigint; readonly orchestrator: Address; readonly orchestratorVersion: string;
  readonly decoder: string; readonly txHash: Hex; readonly inputHash: Hex;
  readonly blockNumber: bigint; readonly blockHash: Hex; readonly transactionIndex: bigint;
  readonly intentIndex: bigint; readonly memberCount: bigint; readonly eoa: Address;
  readonly nonce: bigint; readonly executionDataHash: Hex; readonly keyHash: Hex;
  readonly receiptStatus: bigint; readonly logIndex: bigint; readonly incremented: boolean;
  readonly eventError: Hex; readonly eventTopicsHash: Hex; readonly eventDataHash: Hex;
};

export function candidateDigest(value: CanonicalCandidate): Hex {
  return digest([text("4lpha:lp-evidence:candidate:v1"), u64(value.chainId),
    address(value.orchestrator), text(value.orchestratorVersion), text(value.decoder),
    hash(value.txHash), hash(value.inputHash), u64(value.blockNumber), hash(value.blockHash),
    u64(value.transactionIndex), u64(value.intentIndex), u64(value.memberCount),
    address(value.eoa), uint256(value.nonce), hash(value.executionDataHash), hash(value.keyHash),
    u64(value.receiptStatus), u64(value.logIndex), new Uint8Array([value.incremented ? 1 : 0]),
    hexToBytes(value.eventError), hash(value.eventTopicsHash), hash(value.eventDataHash)]);
}

export function zeroPrefixDigests(input: {
  readonly priorPrefixDigest?: Hex;
  readonly priorSourceAccumulator?: Hex;
  readonly requirement: { readonly journalOwner: string; readonly journalAgent: string;
    readonly journalAction: string; readonly journalIdempotencyKey: string };
  readonly generation: bigint; readonly fromBlock: bigint; readonly toBlock: bigint;
  readonly toBlockHash: Hex; readonly sourceChunkDigests: Readonly<Record<string, Hex>>;
}): { readonly sourceAccumulator: Hex; readonly prefixDigest: Hex } {
  const chunks = Object.entries(input.sourceChunkDigests).sort(([left], [right]) =>
    left.localeCompare(right));
  const encodedChunks = array(chunks, ([id, value]) => cat([text(id), hash(value)]));
  const sourceAccumulator = digest([text("4lpha:lp-evidence:zero-prefix-sources:v1"),
    hash(input.priorSourceAccumulator ?? (`0x${"00".repeat(32)}` as Hex)), encodedChunks]);
  const prior = input.priorPrefixDigest ?? (`0x${"00".repeat(32)}` as Hex);
  const prefixDigest = digest([text("4lpha:lp-evidence:zero-prefix:v1"), hash(prior),
    address(input.requirement.journalOwner.toLowerCase() as Address),
    text(input.requirement.journalAgent), text(input.requirement.journalAction),
    text(input.requirement.journalIdempotencyKey), u64(input.generation),
    u64(input.fromBlock), u64(input.toBlock), hash(input.toBlockHash), encodedChunks, u64(0n)]);
  return { sourceAccumulator, prefixDigest };
}

export function zeroPrefixCarryDigest(input: { readonly coverageVersion: Hex;
  readonly quorumId: Hex; readonly laneId: Hex; readonly requirementKeyHash: Hex;
  readonly oldGeneration: bigint; readonly newGeneration: bigint;
  readonly fromBlock: bigint; readonly toBlock: bigint; readonly toBlockHash: Hex;
  readonly sourceAccumulator: Hex; readonly oldPrefixDigest: Hex }): Hex {
  return digest([text("4lpha:lp-evidence:zero-prefix-carry:v1"),
    hash(input.coverageVersion), hash(input.quorumId), hash(input.laneId),
    hash(input.requirementKeyHash), u64(input.oldGeneration), u64(input.newGeneration),
    u64(input.fromBlock), u64(input.toBlock), hash(input.toBlockHash),
    hash(input.sourceAccumulator), hash(input.oldPrefixDigest), u64(0n)]);
}

export const evidenceCodec = { text, u32, u64, uint256, hash, address, array, digest };

/** Immutable maximum future footprint for every legal mutable chunk state. */
export function evidenceChunkChargedLogicalBytes(sourceId: string): bigint {
  const sourceBytes = new TextEncoder().encode(sourceId).length;
  if (sourceBytes === 0 || sourceBytes > 32) {
    throw new Error("Evidence source id is out of bounds.");
  }
  const identity = 3n * 32n + 8n + 4n + BigInt(sourceBytes) + 2n * 8n;
  const fixedFenceAndCount = 2n * 8n;
  const optionalHashesAbsent = 3n;
  const pending = 4n + 7n + optionalHashesAbsent + 1n + 1n;
  const leased = 4n + 6n + optionalHashesAbsent + 1n + 1n;
  const complete = 4n + 8n + 3n * (1n + 32n) + (1n + 8n) + 1n;
  const gap = 4n + 3n + optionalHashesAbsent + (1n + 8n) + (1n + 4n + 128n);
  const invalidatedGap = 4n + 11n + optionalHashesAbsent + (1n + 8n) +
    (1n + 4n + 128n);
  const maximum = [pending, leased, complete, gap, invalidatedGap]
    .reduce((left, right) => left > right ? left : right);
  return 64n + identity + fixedFenceAndCount + maximum;
}

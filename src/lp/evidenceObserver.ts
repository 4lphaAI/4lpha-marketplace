/**
 * Disabled-by-default Phase 3.9c finalized full-block observer.
 *
 * Owner requests only read {@link LpCoverageStore}; all JSON-RPC egress is in
 * `scanOnce`. Required families are fetched sequentially and a range is
 * committed only after byte-identical canonical block and candidate digests.
 */
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import type { LpEvidenceConfig, LpEvidenceSourceConfig } from "../ops/config.js";
import type { LandingEvidenceProvider, LandingSnapshotDecision } from "./resolveLanding.js";
import {
  decodeIntentExecutedV055,
  decodePortoV055Transaction,
  type DecodedPortoIntentV055,
  type IntentExecutedV055,
  type LandingReceipt,
  type LandingReceiptLog,
} from "./intentDecoder.js";
import {
  PORTO_V055_ORCHESTRATOR,
} from "./preparedIntent.js";
import {
  candidateDigest,
  agreedBlockRangeDigest,
  chunkDigest,
  coverageVersionFor,
  laneIdFor,
  quorumIdFor,
  transactionListDigest,
  type CanonicalBlock,
  type CanonicalCandidate,
} from "./evidenceDigests.js";
import type {
  AgreedCoverageBlock,
  CoverageCandidate,
  CoverageLane,
  LpCoverageStore,
} from "../store/lpCoverage.js";

const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const OBSERVER_LEASE_MS = 600_000;

export type LpEvidenceObserver = LandingEvidenceProvider & {
  scanOnce(): Promise<{ readonly advanced: number; readonly gaps: number }>;
  start(): void;
  stop(): void;
};

export type LpEvidenceDestinationPin = {
  readonly sourceId: string;
  readonly origin: string;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
};

type LookupAll = (hostname: string, options: { readonly all: true; readonly verbatim: true }) =>
  Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;

/**
 * Resolve every curated origin before the observer is constructed. The actual
 * HTTPS transport below pins this exact public address through `lookup`, so a
 * second DNS answer cannot retarget the request after validation.
 */
export async function resolveLpEvidenceDestinationPins(
  config: LpEvidenceConfig,
  lookupAll: LookupAll = dnsLookup as LookupAll,
): Promise<readonly LpEvidenceDestinationPin[]> {
  if (!config.enabled) return [];
  const pins: LpEvidenceDestinationPin[] = [];
  const seenDestinations = new Set<string>();
  for (const source of config.sources) {
    const parsed = new URL(source.url);
    if (isIP(parsed.hostname) !== 0) {
      throw new Error("LP evidence sources must use curated DNS names, not IP literals.");
    }
    const answers = await lookupAll(parsed.hostname, { all: true, verbatim: true });
    if (answers.length === 0 || answers.some((answer) => !isPublicUnicast(answer))) {
      throw new Error("LP evidence source DNS resolved to a private or reserved destination.");
    }
    if (answers.some((answer) => seenDestinations.has(`${answer.family}:${answer.address}`))) {
      throw new Error("Independent LP evidence source families resolved to one destination.");
    }
    for (const answer of answers) seenDestinations.add(`${answer.family}:${answer.address}`);
    const selected = [...answers].sort((left, right) => left.family - right.family ||
      left.address.localeCompare(right.address))[0];
    if (selected === undefined) throw new Error("LP evidence source DNS returned no destination.");
    pins.push({ sourceId: source.id, origin: parsed.origin, hostname: parsed.hostname,
      address: selected.address, family: selected.family });
  }
  return pins;
}

export function createLpEvidenceObserver(input: {
  readonly config: LpEvidenceConfig;
  readonly store: LpCoverageStore;
  readonly cleanupRetained?: (now: number, limit: number) => Promise<number>;
  readonly fetchFn?: typeof fetch;
  readonly destinationPins?: readonly LpEvidenceDestinationPin[];
  readonly intervalMs?: number;
}): LpEvidenceObserver {
  const { config, store } = input;
  const coverageVersion = coverageVersionFor(config);
  const quorumId = config.enabled ? quorumIdFor(config, coverageVersion) : zeroHash();
  const required = config.sources.filter((source) => source.role === "required")
    .sort((a, b) => a.id.localeCompare(b.id));
  const sourceIds = required.map((source) => source.id);
  const fetchFn = input.fetchFn ?? pinnedEvidenceFetch(config, input.destinationPins ?? []);
  const rpcClient = new BoundedEvidenceRpc(config, fetchFn);
  const holderId = `lp-evidence-observer:${randomUUID()}`;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const observer: LpEvidenceObserver = {
    enabled: config.enabled,

    async admission(admission) {
      if (!config.enabled || required.length < 2) return null;
      const reusable = await withinOwnerSnapshot(store.findAdmissionLane({ coverageVersion,
        quorumId, begunAtBlock: admission.begunAtBlock,
        admissionKeyHash: admission.requirementKeyHash }), config.ownerSnapshotTimeoutMs);
      if (reusable !== null) return { coverageVersion, quorumId, laneId: reusable.laneId,
        generation: reusable.generation };
      // Only the first raw lane is shared. If a base already exists but cannot
      // prove this inclusive lower bound (most importantly after compaction),
      // this identity gets a requirement-specific backfill lane. Re-running
      // admission derives the same id; it can never fall back into an advanced
      // zero-hash base cursor.
      const existingBase = await withinOwnerSnapshot(store.findBaseLane({ coverageVersion,
        quorumId, begunAtBlock: admission.begunAtBlock }), config.ownerSnapshotTimeoutMs);
      if (existingBase === null) {
        const baseLaneId = laneIdFor({ coverageVersion, quorumId, purpose: "base",
          originBlock: admission.begunAtBlock });
        const base = await withinOwnerSnapshot(store.ensureLane({ coverageVersion, quorumId,
          laneId: baseLaneId, purpose: "base", admissionKeyHash: zeroHash(),
          originBlock: admission.begunAtBlock }), config.ownerSnapshotTimeoutMs);
        if (base.purpose === "base" && base.state === "active" &&
            base.rawRetainedFrom <= admission.begunAtBlock) {
          return { coverageVersion, quorumId, laneId: base.laneId,
            generation: base.generation };
        }
      }
      const backfillLaneId = laneIdFor({ coverageVersion, quorumId, purpose: "backfill",
        originBlock: admission.begunAtBlock, admissionKeyHash: admission.requirementKeyHash });
      const backfill = await withinOwnerSnapshot(store.ensureLane({ coverageVersion, quorumId,
        laneId: backfillLaneId, purpose: "backfill",
        admissionKeyHash: admission.requirementKeyHash, originBlock: admission.begunAtBlock }),
      config.ownerSnapshotTimeoutMs);
      if (backfill.purpose !== "backfill" ||
          backfill.admissionKeyHash !== admission.requirementKeyHash ||
          backfill.originBlock !== admission.begunAtBlock) {
        throw new Error("LP_EVIDENCE_CURSOR_CONFLICT: backfill lane identity mismatch.");
      }
      return { coverageVersion, quorumId, laneId: backfill.laneId,
        generation: backfill.generation };
    },

    async snapshot(snapshot): Promise<LandingSnapshotDecision> {
      if (!config.enabled) return { outcome: "unavailable", reason: "observer-disabled" };
      const requirement = await withinOwnerSnapshot(store.registerRequirement(snapshot.requirement),
        config.ownerSnapshotTimeoutMs);
      if (requirement.state !== "eligible" || requirement.unavailableCode !== null) {
        return { outcome: "unavailable", reason: requirement.unavailableCode ??
          `requirement-${requirement.state}` };
      }
      const evidence = await withinOwnerSnapshot(store.snapshot({ requirement,
        identity: snapshot.preparedIdentity, requiredSourceIds: sourceIds,
        expirySafetySeconds: config.expirySafetySeconds }), config.ownerSnapshotTimeoutMs);
      return evidence === null
        ? { outcome: "unavailable", reason: "coverage-incomplete" }
        : evidence.outcome === "ambiguous"
          ? { outcome: "ambiguous", reason: evidence.reason }
          : { outcome: evidence.outcome, evidence };
    },

    validateStored(evidence) {
      return withinOwnerSnapshot(store.validate(evidence), config.ownerSnapshotTimeoutMs)
        .catch(() => false);
    },

    async withCurrentEvidence(evidence, mutation) {
      if (store.withCurrentEvidence === undefined) {
        throw new Error("RESOLUTION_STATE_CONFLICT: disposition evidence has no atomic citation fence.");
      }
      return store.withCurrentEvidence(evidence, mutation);
    },

    async scanOnce() {
      if (!config.enabled || running) return { advanced: 0, gaps: 0 };
      running = true;
      let advanced = 0; let gaps = 0;
      try {
        const lanes = await store.listActiveLanes(100);
        for (const lane of lanes) {
          const leaseNow = Date.now();
          const initialLease = await store.claimLease(lane, holderId, leaseNow,
            leaseNow + OBSERVER_LEASE_MS);
          if (initialLease === null) continue;
          let lease = initialLease;
          try {
            const heads: bigint[] = [];
            for (const source of required) heads.push(await finalizedHead(source, rpcClient));
            const finalized = heads.reduce((min, head) => head < min ? head : min);
            const from = lane.coveredThrough === null ? lane.originBlock : lane.coveredThrough + 1n;
            if (from > finalized) continue;
            // Bound the work currently owed, not the lane's lifetime height.
            // A continuously-following base lane stays near head indefinitely;
            // a dormant lane cannot bypass the per-requirement cold cap merely
            // because it once committed an older cursor.
            if (finalized - from + 1n > BigInt(config.maxColdBackfillBlocks)) {
              await store.markGap(lane, lease); gaps += 1; continue;
            }
            const to = minBigint(finalized, from + BigInt(config.chunkBlocks) - 1n);
            if (to + BigInt(config.chunkBlocks) <= finalized &&
                !(await store.reserveBackfillBlocks(lane.coverageVersion,
                  Number(to - from + 1n), Date.now(), config.maxBackfillBlocksPerHour))) {
              await store.markGap(lane, lease); gaps += 1; continue;
            }
            const scans: SourceRange[] = [];
            for (const source of required) scans.push(await scanSourceRange(
              source, from, to, lane, rpcClient,
            ));
            const reference = scans[0];
            if (reference !== undefined && lane.coveredThroughHash !== null &&
                reference.blocks[0]?.parentHash !== lane.coveredThroughHash) {
              await reconcileReorg(lane, lease, holderId, required, config, store, rpcClient);
              continue;
            }
            if (reference === undefined || scans.some((scan) =>
              scan.blockAgreementDigest !== reference.blockAgreementDigest ||
              scan.candidateAgreementDigest !== reference.candidateAgreementDigest)) {
              await store.markGap(lane, lease); gaps += 1; continue;
            }
            const sourceChunkDigests = Object.fromEntries(scans.map((scan) =>
              [scan.sourceId, scan.chunkDigest])) as Readonly<Record<string, Hex>>;
            const renewNow = Date.now();
            const renewed = await store.claimLease(lane, holderId, renewNow,
              renewNow + OBSERVER_LEASE_MS);
            if (renewed === null) throw new Error("Evidence observer lost its durable lease.");
            lease = renewed;
            const advancedLane = await store.commitAgreedRange({ lane, lease,
              expectedRowVersion: lane.rowVersion,
              blocks: reference.blocks, sourceChunkDigests, candidates: reference.candidates,
              now: Date.now() });
            advanced += 1;
            try { await store.compactZeroExpiry(advancedLane, lease, Date.now()); }
            catch { /* compaction is quota-only; committed coverage remains valid */ }
          } catch {
            // Upstream details and URLs are intentionally neither logged nor
            // stored. A failed family makes this lane a durable gap.
            try { await store.markGap(lane, lease); gaps += 1; }
            catch { /* a lost fence writes no stale gap */ }
          }
        }
        try { await input.cleanupRetained?.(Date.now(), 1_000); }
        catch { /* cleanup is durable and retried; it never changes a verdict */ }
        return { advanced, gaps };
      } finally { running = false; }
    },

    start() {
      if (!config.enabled || timer !== undefined) return;
      const interval = Math.max(1_000, input.intervalMs ?? 30_000);
      timer = setInterval(() => { void observer.scanOnce(); }, interval);
      timer.unref();
      void observer.scanOnce();
    },

    stop() { if (timer !== undefined) clearInterval(timer); timer = undefined; },
  };
  return observer;
}

type RpcTransaction = { hash: Hex; from: Address; to: Address | null; input: Hex;
  transactionIndex: Hex; blockNumber: Hex; blockHash: Hex };
type RpcBlock = { number: Hex; hash: Hex; parentHash: Hex; timestamp: Hex;
  transactions: readonly RpcTransaction[] };
type RpcReceipt = { status: Hex; transactionHash: Hex; blockNumber: Hex; blockHash: Hex;
  transactionIndex: Hex; logs: readonly { address: Address; topics: readonly Hex[];
    data: Hex; logIndex: Hex }[] };
type SourceRange = { sourceId: string; blocks: readonly AgreedCoverageBlock[];
  candidates: readonly CoverageCandidate[]; chunkDigest: Hex;
  blockAgreementDigest: Hex; candidateAgreementDigest: Hex };

async function finalizedHead(source: LpEvidenceSourceConfig,
  rpcClient: BoundedEvidenceRpc): Promise<bigint> {
  const block = await rpcClient.call<RpcBlock>(source, "eth_getBlockByNumber",
    ["finalized", false]);
  return hexUint(block.number);
}

async function reconcileReorg(
  lane: CoverageLane,
  initialLease: import("../store/lpCoverage.js").CoverageLease,
  holderId: string,
  sources: readonly LpEvidenceSourceConfig[],
  config: LpEvidenceConfig,
  store: LpCoverageStore,
  rpcClient: BoundedEvidenceRpc,
): Promise<void> {
  const recent = await store.recentBlocks(lane, config.reorgRewindBlocks + 1);
  const prefixProofs: import("../store/lpCoverage.js").CoveragePrefixProof[] = [];
  for (const boundary of await store.prefixBoundaries(lane)) {
    const headers: RpcBlock[] = [];
    for (const source of sources) {
      headers.push(await rpcClient.call<RpcBlock>(source, "eth_getBlockByNumber",
        [`0x${boundary.toBlock.toString(16)}`, false]));
    }
    const hashes = headers.map((header) => lowerHash(header.hash));
    prefixProofs.push({ ...boundary, agreed: hashes.length === sources.length &&
      hashes.every((hash) => hash === boundary.toBlockHash) });
  }
  let lease = initialLease;
  for (let index = 0; index < recent.length; index += 1) {
    const stored = recent[index];
    if (stored === undefined) continue;
    if (index % 32 === 0) {
      const now = Date.now();
      const renewed = await store.claimLease(lane, holderId, now, now + OBSERVER_LEASE_MS);
      if (renewed === null) throw new Error("Evidence observer lost its reorg lease.");
      lease = renewed;
    }
    if (lane.coveredThrough !== null && lane.coveredThrough - stored.number >
        BigInt(config.reorgRewindBlocks)) break;
    const headers: RpcBlock[] = [];
    for (const source of sources) {
      headers.push(await rpcClient.call<RpcBlock>(source, "eth_getBlockByNumber",
        [`0x${stored.number.toString(16)}`, false]));
    }
    if (headers.length === sources.length && headers.every((header) =>
      lowerHash(header.hash) === stored.hash)) {
      await store.rewind(lane, stored, lease, prefixProofs);
      return;
    }
  }
  await store.rewind(lane, null, lease, prefixProofs);
}

async function scanSourceRange(source: LpEvidenceSourceConfig, from: bigint, to: bigint,
  lane: CoverageLane, rpcClient: BoundedEvidenceRpc): Promise<SourceRange> {
  const blocks: AgreedCoverageBlock[] = [];
  const candidates: CoverageCandidate[] = [];
  for (let number = from; number <= to; number += 1n) {
    const block = await rpcClient.call<RpcBlock>(source, "eth_getBlockByNumber",
      [`0x${number.toString(16)}`, true]);
    if (hexUint(block.number) !== number || block.transactions.length > 500) {
      throw new Error("Malformed finalized block.");
    }
    const blockHash = lowerHash(block.hash);
    const indexes = new Set<string>(); const hashes = new Set<string>();
    const transactions = block.transactions.map((tx, arrayIndex) => {
      const index = hexUint(tx.transactionIndex);
      const hash = lowerHash(tx.hash);
      if (hexUint(tx.blockNumber) !== number || lowerHash(tx.blockHash) !== blockHash ||
          index !== BigInt(arrayIndex) || indexes.has(index.toString(10)) || hashes.has(hash)) {
        throw new Error("Finalized block transaction identity is malformed.");
      }
      indexes.add(index.toString(10)); hashes.add(hash);
      return { index, hash, from: lowerAddress(tx.from),
        to: tx.to === null ? null : lowerAddress(tx.to), inputHash: keccak256(tx.input) };
    });
    const txDigest = transactionListDigest(number, transactions);
    blocks.push({ number, hash: blockHash, parentHash: lowerHash(block.parentHash),
      timestamp: hexUint(block.timestamp), orderedTransactionDigest: txDigest });
    for (const tx of block.transactions) {
      if (tx.to?.toLowerCase() !== PORTO_V055_ORCHESTRATOR) continue;
      let members;
      try { members = decodePortoV055Transaction(56, lowerAddress(tx.to), tx.input); }
      catch {
        // Public Orchestrator traffic that is not an exact supported member is
        // irrelevant to every persisted prepared identity. It must not wedge
        // otherwise gap-free full-block coverage.
        continue;
      }
      const receiptRaw = await rpcClient.call<RpcReceipt>(source,
        "eth_getTransactionReceipt", [tx.hash]);
      const receipt = normalizeReceipt(receiptRaw);
      if ((receipt.status !== 0n && receipt.status !== 1n) ||
          receipt.transactionHash !== lowerHash(tx.hash) ||
          receipt.blockNumber !== number || receipt.blockHash !== blockHash ||
          receipt.transactionIndex !== hexUint(tx.transactionIndex)) {
        throw new Error("Finalized transaction receipt does not agree with its block.");
      }
      const events: IntentExecutedV055[] = [];
      let malformedIntentEvent = false;
      for (const log of receipt.logs) {
        try {
          const event = decodeIntentExecutedV055(log);
          if (event !== null) events.push(event);
        } catch { malformedIntentEvent = true; }
      }
      for (const member of members) {
        const paired = events.filter((event) => event.eoa === member.eoa &&
          event.nonce === member.nonce);
        if (receipt.status === 0n || paired.length === 0 || malformedIntentEvent) {
          candidates.push(coverageCandidate(tx, block, member, receipt.status, null));
          continue;
        }
        // Every same-identity event is retained. Exactly one successful tuple
        // can prove landed; duplicate or negative tuples remain candidate-local
        // ambiguity for only the prepared identity they collide with.
        for (const event of paired) {
          candidates.push(coverageCandidate(tx, block, member, receipt.status, event));
        }
      }
    }
  }
  const canonicalBlocks: CanonicalBlock[] = blocks.map((block) => ({
    number: block.number, hash: block.hash, parentHash: block.parentHash,
    timestamp: block.timestamp, transactionListDigest: block.orderedTransactionDigest,
  }));
  const digest = chunkDigest({ sourceId: source.id, laneId: lane.laneId,
    generation: lane.generation, fromBlock: from, toBlock: to, blocks: canonicalBlocks });
  // Agreement ignores source id but commits the ordered block/candidate bytes.
  const blockAgreementDigest = agreedBlockRangeDigest(canonicalBlocks);
  const candidateAgreementDigest = keccak256(`0x${candidates.map((candidate) =>
    candidate.candidateDigest.slice(2)).join("")}` as Hex);
  return { sourceId: source.id, blocks, candidates, chunkDigest: digest,
    blockAgreementDigest, candidateAgreementDigest };
}

function coverageCandidate(
  tx: RpcTransaction,
  block: RpcBlock,
  member: DecodedPortoIntentV055,
  receiptStatus: bigint,
  event: IntentExecutedV055 | null,
): CoverageCandidate {
  const value: CanonicalCandidate = { chainId: 56n, orchestrator: PORTO_V055_ORCHESTRATOR,
    orchestratorVersion: member.orchestratorVersion, decoder: member.decoder,
    txHash: lowerHash(tx.hash), inputHash: keccak256(tx.input),
    blockNumber: hexUint(block.number), blockHash: lowerHash(block.hash),
    transactionIndex: hexUint(tx.transactionIndex), intentIndex: BigInt(member.memberIndex),
    memberCount: BigInt(member.memberCount), eoa: member.eoa, nonce: member.nonce,
    executionDataHash: member.executionDataHash, keyHash: member.keyHash, receiptStatus,
    logIndex: event?.logIndex ?? 0n, incremented: event?.incremented ?? false,
    eventError: event?.err ?? "0xffffffff", eventTopicsHash: event?.topicsHash ?? zeroHash(),
    eventDataHash: event?.dataHash ?? zeroHash() };
  return { txHash: value.txHash, inputHash: value.inputHash,
    blockNumber: value.blockNumber, blockHash: value.blockHash,
    transactionIndex: value.transactionIndex, intentIndex: member.memberIndex,
    memberCount: member.memberCount, eoa: value.eoa, nonce: value.nonce,
    executionDataHash: value.executionDataHash, keyHash: value.keyHash,
    receiptStatus: value.receiptStatus, incremented: value.incremented,
    eventError: value.eventError, logIndex: value.logIndex,
    eventTopicsHash: value.eventTopicsHash, eventDataHash: value.eventDataHash,
    candidateDigest: candidateDigest(value) };
}

class BoundedEvidenceRpc {
  readonly #config: LpEvidenceConfig;
  readonly #fetchFn: typeof fetch;
  readonly #failures = new Map<string, number>();
  #nextRequestAt = 0;
  #gate: Promise<void> = Promise.resolve();
  constructor(config: LpEvidenceConfig, fetchFn: typeof fetch) {
    this.#config = config; this.#fetchFn = fetchFn;
  }
  async call<T>(source: LpEvidenceSourceConfig, method: string,
    params: readonly unknown[]): Promise<T> {
    if ((this.#failures.get(source.id) ?? 0) >= 10) {
      throw new Error("Evidence RPC circuit is open.");
    }
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.#rateLimit();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
        try {
          const response = await this.#fetchFn(source.url, { method: "POST", redirect: "error",
            headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          if (!response.ok) throw new Error("Evidence RPC refused.");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > MAX_RPC_RESPONSE_BYTES) {
            throw new Error("Evidence RPC response too large.");
          }
          const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (!record(decoded) || decoded["jsonrpc"] !== "2.0" || decoded["id"] !== 1 ||
              decoded["error"] !== undefined || decoded["result"] === undefined) {
            throw new Error("Evidence RPC returned an invalid envelope.");
          }
          this.#failures.set(source.id, 0);
          return decoded["result"] as T;
        } finally { clearTimeout(timeout); }
      } catch (error) {
        last = error;
        const failures = (this.#failures.get(source.id) ?? 0) + 1;
        this.#failures.set(source.id, failures);
        if (attempt === 4 || failures >= 10) break;
        await delay(Math.min(1_000, 25 * (2 ** attempt)));
      }
    }
    throw last instanceof Error ? last : new Error("Evidence RPC unavailable.");
  }
  #rateLimit(): Promise<void> {
    const spacing = Math.ceil(1_000 / this.#config.requestsPerSecond);
    const next = this.#gate.then(async () => {
      const wait = Math.max(0, this.#nextRequestAt - Date.now());
      if (wait > 0) await delay(wait);
      this.#nextRequestAt = Date.now() + spacing;
    });
    this.#gate = next.catch(() => undefined);
    return next;
  }
}

async function withinOwnerSnapshot<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Evidence owner snapshot timed out.")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReceipt(value: RpcReceipt): LandingReceipt {
  return { status: hexUint(value.status), transactionHash: lowerHash(value.transactionHash),
    blockNumber: hexUint(value.blockNumber), blockHash: lowerHash(value.blockHash),
    transactionIndex: hexUint(value.transactionIndex), logs: value.logs.map((log): LandingReceiptLog => ({
      address: lowerAddress(log.address), topics: log.topics.map(lowerHash), data: log.data,
      logIndex: hexUint(log.logIndex),
    })) };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hexUint(value: Hex): bigint {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("Non-canonical RPC integer.");
  return BigInt(value);
}
function lowerHash(value: Hex): Hex {
  const lowered = value.toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/.test(lowered)) throw new Error("Malformed RPC hash.");
  return lowered;
}
function lowerAddress(value: Address): Address { return getAddress(value).toLowerCase() as Address; }
function minBigint(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function zeroHash(): Hex { return `0x${"00".repeat(32)}` as Hex; }

function isPublicUnicast(answer: { readonly address: string; readonly family: 4 | 6 }): boolean {
  if (answer.family === 4) {
    const octets = answer.address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) ||
        octet < 0 || octet > 255)) return false;
    const [a = 0, b = 0, c = 0] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113));
  }
  const value = answer.address.toLowerCase();
  return isIP(value) === 6 && value !== "::" && value !== "::1" &&
    !value.startsWith("::ffff:") && !value.startsWith("fc") && !value.startsWith("fd") &&
    !/^fe[89ab]/.test(value) && !value.startsWith("ff") && !value.startsWith("2001:db8:");
}

function pinnedEvidenceFetch(
  config: LpEvidenceConfig,
  pins: readonly LpEvidenceDestinationPin[],
): typeof fetch {
  const byOrigin = new Map(pins.map((pin) => [pin.origin, pin]));
  if (config.enabled && (pins.length !== config.sources.length ||
      config.sources.some((source) => byOrigin.get(source.url)?.sourceId !== source.id))) {
    throw new Error("LP evidence destination pins are incomplete or do not match configuration.");
  }
  return (async (resource: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof resource !== "string" || init?.method !== "POST" ||
        typeof init.body !== "string") {
      throw new Error("LP evidence transport accepts only owned POST requests.");
    }
    const parsed = new URL(resource);
    const pin = byOrigin.get(parsed.origin);
    if (pin === undefined || parsed.pathname !== "/" || parsed.search !== "" ||
        parsed.hash !== "") throw new Error("LP evidence transport refused an unpinned origin.");
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = httpsRequest({ protocol: "https:", hostname: pin.hostname, port: 443,
        path: "/", method: "POST", servername: pin.hostname,
        headers: { "content-type": "application/json", host: pin.hostname,
          "content-length": Buffer.byteLength(init.body as string, "utf8") },
        lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family),
      }, (response) => {
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RPC_RESPONSE_BYTES) {
            response.destroy(new Error("Evidence RPC response too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", finishReject);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502,
            headers: { "content-type": response.headers["content-type"] ?? "application/json" } }));
        });
      });
      request.on("error", finishReject);
      const abort = (): void => { request.destroy(new Error("Evidence RPC request aborted.")); };
      if (init.signal?.aborted === true) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      request.end(init.body);
    });
  }) as typeof fetch;
}

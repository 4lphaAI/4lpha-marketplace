import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { chunkDigest } from "../src/lp/evidenceDigests.js";
import { canonicalPreparedIntentIdentityV1 } from "../src/lp/preparedIntent.js";
import {
  resolveUnknownLandingV1,
  type LandingEvidenceProvider,
} from "../src/lp/resolveLanding.js";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import {
  PostgresLpEvidenceStore,
  canonicalLandingEvidence,
} from "../src/store/lpEvidence.js";
import {
  PostgresLpCoverageStore,
  type AgreedCoverageBlock,
  type CoverageLane,
  type CoverageLease,
} from "../src/store/lpCoverage.js";
import { MemoryLpEvidenceStore } from "../src/store/lpEvidence.js";
import { MemoryLpSequenceStore, lpStepDecisionId } from "../src/store/lpSequences.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const H0 = `0x${"00".repeat(32)}` as Hex;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;
const OWNER = `0x${"12".repeat(20)}` as Address;
const TOKEN0 = `0x${"34".repeat(20)}` as Address;
const TOKEN1 = `0x${"56".repeat(20)}` as Address;

const config = resolveLpEvidenceConfig({
  LP_LANDING_EVIDENCE_ENABLED: "true",
  LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
    { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
    { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
  ]),
});

function hash(value: number): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function blocks(from: number, to: number): AgreedCoverageBlock[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => {
    const number = from + offset;
    return { number: BigInt(number), hash: hash(number), parentHash: hash(number - 1),
      timestamp: BigInt(number), orderedTransactionDigest: H2 };
  });
}

async function commit(
  store: PostgresLpCoverageStore,
  lane: CoverageLane,
  lease: CoverageLease,
  from: number,
  to: number,
): Promise<CoverageLane> {
  return store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
    blocks: blocks(from, to),
    sourceChunkDigests: { "bnbchain-public": hash(from), publicnode: hash(to) },
    candidates: [], now: to });
}

describe("Phase 3.9c independent fix-review regressions", () => {
  it("does not let Memory write a disposition after the validation sample became stale", async () => {
    const now = () => 1_000;
    const journal = new MemoryExecutionJournal(now);
    const sequences = new MemoryLpSequenceStore(now);
    const evidenceStore = new MemoryLpEvidenceStore(resolveLpEvidenceConfig({}), now);
    const position = await sequences.createPosition({ positionId: "position", agentId: "agent",
      ownerAddress: OWNER, token0: TOKEN0, token1: TOKEN1, fee: 500, basisWei: 5n });
    const sequence = await sequences.createSequence({ agentId: "agent", ownerAddress: OWNER,
      positionId: position.positionId, kind: "open" });
    const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
    await sequences.appendStep(OWNER, "agent", sequence.sequenceId,
      { kind: "zap-in-mint", journalIdempotencyKey: "target" });
    const calls = JSON.stringify({ scheme: "porto-erc7579-calls-v1", executionDataHash: H1 });
    await journal.begin({ idempotencyKey: "target", agentId: "agent", ownerAddress: OWNER,
      kind: "lp", decisionId, begunAtBlock: 10n, finalCallsFingerprint: calls,
      finalCallsFingerprintHash: keccak256(stringToHex(calls)) });
    const prepared = canonicalPreparedIntentIdentityV1({ scheme: "porto-intent-v1",
      decoder: "porto-orchestrator-intent-v055", chainId: "56", eoa: OWNER,
      orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
      orchestratorVersion: "0.5.5", nonce: "7", expiry: "100",
      executionDataHash: H1, keyHash: H2 });
    await journal.bindPreparedIntent("target", { canonicalIdentity: prepared.canonical,
      identityHash: prepared.hash, expectedBindingVersion: 0 });
    await journal.markUnknown("target", "unknown");
    await journal.begin({ idempotencyKey: "action", agentId: "agent", ownerAddress: OWNER,
      kind: "resolveUnknownLandingV1" });

    let current = true;
    let validations = 0;
    const provider: LandingEvidenceProvider = {
      enabled: true,
      async admission() { return { coverageVersion: H1, quorumId: H2, laneId: H3 }; },
      async snapshot(input) {
        return { outcome: "absent", evidence: canonicalLandingEvidence({
          scheme: "lp-landing-evidence-v1", outcome: "absent",
          preparedIdentityHash: input.requirement.preparedIdentityHash,
          coverageVersion: H1, quorumId: H2, laneId: H3, generation: "0",
          cursorRowVersion: "1", requiredSourceIds: ["a", "b"], fromBlock: "10",
          toBlock: "11", toBlockHash: H2,
          absent: { toBlockTimestamp: "401", expirySafetySeconds: 300, zeroMatchCount: 0 },
        }) };
      },
      async validateStored() {
        validations += 1;
        const observed = current;
        // The third sample is the check immediately before the target-journal
        // disposition. The observer changes generation as soon as that
        // non-atomic read returns, before the separate Memory write begins.
        if (validations === 3) current = false;
        return observed;
      },
    };
    const [row, claimedSequence] = await Promise.all([
      journal.get("target"), sequences.getSequence(OWNER, "agent", sequence.sequenceId),
    ]);
    assert.ok(row); assert.ok(claimedSequence);
    await assert.rejects(resolveUnknownLandingV1({ decisionId, row,
      sequence: claimedSequence, position, actionIdentity: { owner: OWNER, agent: "agent",
        kind: "resolveUnknownLandingV1", idempotencyKey: "action" }, priorRows: [], deps: {
        journal, sequences, evidenceStore, evidenceProvider: provider,
        receipts: {
          async collectAmounts() { return { amount0Wei: 0n, amount1Wei: 0n }; },
          async swapAmounts() { return { tokenIn: TOKEN0, amountInWei: 0n,
            tokenOut: TOKEN1, amountOutWei: 0n }; },
          async mintedTokenId() { return 1n; },
        },
        async positions() { return "burned"; },
        now, resolverLeaseMs: 1_000,
      } }), /evidence was invalidated/);
    assert.equal((await journal.get("target"))?.state, "UNKNOWN",
      "a stale Memory sample must not be followed by a separate journal disposition");
  });

  it("recomputes a carried chunk digest for its new generation", async () => {
    const sql = new FakeSqlClient();
    const store = new PostgresLpCoverageStore(sql, config);
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3, laneId: H1,
      purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "digest-audit", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const prefix = blocks(10, 59);
    const initialDigests = Object.fromEntries(["bnbchain-public", "publicnode"].map((sourceId) =>
      [sourceId, chunkDigest({ sourceId, laneId: lane.laneId, generation: 0n,
        fromBlock: 10n, toBlock: 59n, blocks: prefix.map((block) => ({ number: block.number,
          hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp,
          transactionListDigest: block.orderedTransactionDigest })) })])) as Record<string, Hex>;
    lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
      blocks: prefix, sourceChunkDigests: initialDigests, candidates: [], now: 59 });
    lane = await commit(store, lane, lease, 60, 60);
    await store.rewind(lane, blocks(59, 59)[0]!, lease);
    const carried = await sql.query<{ source_id: string; ordered_block_digest: Hex }>(
      "/* lpCoverage.compactChunksLock */ select carried chunks",
      [H1, "1", "10", "59"]);
    assert.equal(carried.rows.length, 2);
    for (const row of carried.rows) {
      const expected = chunkDigest({ sourceId: row.source_id, laneId: H1, generation: 1n,
        fromBlock: 10n, toBlock: 59n, blocks: prefix.map((block) => ({ number: block.number,
          hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp,
          transactionListDigest: block.orderedTransactionDigest })) });
      assert.equal(row.ordered_block_digest, expected,
        "a chunk row cannot claim generation 1 while its canonical digest commits generation 0");
    }
  });

  it("keeps zero-expiry compaction live after a rewind bisects a completed chunk", async () => {
    const sql = new FakeSqlClient();
    const evidence = await PostgresLpEvidenceStore.create(sql, config, () => 1);
    const store = new PostgresLpCoverageStore(sql, config);
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3, laneId: H1,
      purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const admitted = await evidence.admitRequirement({ journalOwner: OWNER,
      journalAgent: "agent", journalAction: "lp", journalIdempotencyKey: "zero",
      begunAtBlock: 10n, expiry: 0n, preparedIdentityHash: H1,
      coverageVersion: H2, quorumId: H3, laneId: H1 });
    assert.equal("unavailable" in admitted, false);
    let lease = await store.claimLease(lane, "split-audit", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    lane = await commit(store, lane, lease, 10, 59);
    lane = await commit(store, lane, lease, 60, 109);
    lane = await store.rewind(lane, blocks(30, 30)[0]!, lease);
    lease = await store.claimLease(lane, "split-audit", 110, 8_000_000_000_000_000);
    assert.ok(lease);
    for (let from = 31; from <= 337;) {
      const to = Math.min(337, from + 49);
      lane = await commit(store, lane, lease, from, to);
      from = to + 1;
    }
    assert.equal(lane.coveredThrough, 337n);
    assert.equal(await store.compactZeroExpiry(lane, lease, 1_000), 1,
      "an ordinary shallow reorg must not permanently remove the first current-generation chunk");
    await evidence.close();
  });
});

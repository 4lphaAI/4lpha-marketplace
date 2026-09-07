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
import { PostgresLpCoverageStore, type AgreedCoverageBlock } from "../src/store/lpCoverage.js";
import { MemoryLpEvidenceStore, canonicalLandingEvidence } from "../src/store/lpEvidence.js";
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

describe("Phase 3.9c second independent fix-review regressions", () => {
  it("preserves the original crossing chunk as invalidated when it creates a current prefix", async () => {
    const sql = new FakeSqlClient();
    const store = new PostgresLpCoverageStore(sql, config);
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3, laneId: H1,
      purpose: "backfill", admissionKeyHash: H0, originBlock: 10n });
    const lease = await store.claimLease(lane, "crossing-audit", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const prefix = blocks(10, 59);
    const sourceChunkDigests = Object.fromEntries(
      ["bnbchain-public", "publicnode"].map((sourceId) => [sourceId, chunkDigest({ sourceId,
        laneId: H1, generation: 0n, fromBlock: 10n, toBlock: 59n,
        blocks: prefix.map((block) => ({ number: block.number, hash: block.hash,
          parentHash: block.parentHash, timestamp: block.timestamp,
          transactionListDigest: block.orderedTransactionDigest })) })]),
    ) as Record<string, Hex>;
    lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
      blocks: prefix, sourceChunkDigests, candidates: [], now: 59 });
    await store.rewind(lane, blocks(30, 30)[0]!, lease);

    const chunks = await sql.query<{ generation: string; source_id: string; from_block: string;
      to_block: string; state: string; ordered_block_digest: Hex }>(
      "/* lpEvidence.cleanupChunksLock */ inspect all retained chunks", [H1],
    );
    const carried = chunks.rows.filter((row) => row.generation === "1" && row.from_block === "10" &&
      row.to_block === "30" && row.state === "complete");
    assert.equal(carried.length, 2, "both required sources need the new canonical prefix");
    const invalidatedOriginal = chunks.rows.filter((row) => row.generation === "0" &&
      row.from_block === "10" && row.to_block === "59" && row.state === "invalidated");
    assert.equal(invalidatedOriginal.length, 2,
      "the immutable original chunk citation must survive as invalidated audit history");
  });

  it("does not release a Memory sequence before the terminal tombstone and action can commit", async () => {
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
      async validateStored() { return true; },
      async withCurrentEvidence(_evidence, mutation) { return mutation(); },
    };
    evidenceStore.terminalize = async () => {
      throw new Error("injected terminal tombstone failure");
    };
    const [row, currentSequence] = await Promise.all([
      journal.get("target"), sequences.getSequence(OWNER, "agent", sequence.sequenceId),
    ]);
    assert.ok(row); assert.ok(currentSequence);
    await assert.rejects(resolveUnknownLandingV1({ decisionId, row, sequence: currentSequence,
      position, actionIdentity: { owner: OWNER, agent: "agent",
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
      } }), /injected terminal tombstone failure/);
    assert.equal((await sequences.getSequence(OWNER, "agent", sequence.sequenceId))?.state,
      "resolving", "step 8 must keep the sequence non-runnable until its terminal transaction commits");
    assert.notEqual((await journal.get("action"))?.state, "COMMITTED");
  });
});

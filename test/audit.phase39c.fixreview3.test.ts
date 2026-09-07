import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { chunkDigest } from "../src/lp/evidenceDigests.js";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import {
  MemoryLpCoverageStore,
  type AgreedCoverageBlock,
} from "../src/store/lpCoverage.js";
import type { EvidenceRequirement } from "../src/store/lpEvidence.js";

const H0 = `0x${"00".repeat(32)}` as Hex;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;

function hash(value: number): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function block(number: number): AgreedCoverageBlock {
  return { number: BigInt(number), hash: hash(number + 1),
    parentHash: number === 0 ? H0 : hash(number), timestamp: BigInt(number),
    orderedTransactionDigest: H2 };
}

describe("Phase 3.9c third independent fix-review regressions", () => {
  it("rolls back a Memory zero-prefix carry when copied-generation quota admission fails", async () => {
    const config = resolveLpEvidenceConfig({
      LP_LANDING_EVIDENCE_ENABLED: "true",
      LP_EVIDENCE_MAX_VERSION_BLOCK_ROWS: "614",
      LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
        { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
        { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
      ]),
    });
    const store = new MemoryLpCoverageStore(config);
    let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3, laneId: H1,
      purpose: "backfill", admissionKeyHash: H0, originBlock: 0n });
    const requirement: EvidenceRequirement = { journalOwner: `0x${"12".repeat(20)}`,
      journalAgent: "agent", journalAction: "lp", journalIdempotencyKey: "target",
      begunAtBlock: 0n, expiry: 0n, preparedIdentityHash: H1, coverageVersion: H2,
      quorumId: H3, laneId: H1, state: "eligible", unavailableCode: null, createdAt: 1,
      terminalAt: null, evidenceRetainedUntil: null, updatedAt: 1, rowVersion: 0,
      chargedLogicalBytes: 512n };
    await store.registerRequirement(requirement);
    const lease = await store.claimLease(lane, "memory-quota-audit", 0,
      8_000_000_000_000_000);
    assert.ok(lease);

    for (let from = 0; from <= 300; from += 50) {
      const to = Math.min(from + 49, 306);
      const blocks = Array.from({ length: to - from + 1 }, (_, offset) => block(from + offset));
      const sourceChunkDigests = Object.fromEntries(
        ["bnbchain-public", "publicnode"].map((sourceId) => [sourceId, chunkDigest({ sourceId,
          laneId: H1, generation: lane.generation, fromBlock: BigInt(from), toBlock: BigInt(to),
          blocks: blocks.map((row) => ({ number: row.number, hash: row.hash,
            parentHash: row.parentHash, timestamp: row.timestamp,
            transactionListDigest: row.orderedTransactionDigest })) })]),
      ) as Record<string, Hex>;
      lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
        blocks, sourceChunkDigests, candidates: [], now: to });
    }
    assert.equal(await store.compactZeroExpiry(lane, lease, 1_000), 1);
    lane = (await store.listActiveLanes())[0]!;
    assert.deepEqual(await store.prefixBoundaries(lane),
      [{ toBlock: 49n, toBlockHash: block(49).hash }]);

    await assert.rejects(store.rewind(lane, block(250), lease,
      [{ toBlock: 49n, toBlockHash: block(49).hash, agreed: true }]),
    /LP_EVIDENCE_STORAGE_QUOTA/);

    const unchanged = (await store.listActiveLanes())[0]!;
    assert.equal(unchanged.generation, lane.generation,
      "a rejected rewind must leave the cursor generation unchanged");
    assert.deepEqual(await store.prefixBoundaries(unchanged),
      [{ toBlock: 49n, toBlockHash: block(49).hash }],
      "a rejected Memory transaction must not strand its prefix in generation+1");
  });
});

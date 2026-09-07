import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { chunkDigest } from "../src/lp/evidenceDigests.js";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import {
  MemoryLpCoverageStore,
  PostgresLpCoverageStore,
  type AgreedCoverageBlock,
  type CoverageCandidate,
  type CoverageLease,
  type CoverageLane,
  type LpCoverageStore,
} from "../src/store/lpCoverage.js";
import {
  PostgresLpEvidenceStore,
  type EvidenceRequirement,
} from "../src/store/lpEvidence.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const H0 = `0x${"00".repeat(32)}` as Hex;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;
const OWNER = `0x${"12".repeat(20)}` as Address;
const SOURCE_IDS = ["bnbchain-public", "publicnode"] as const;
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

function block(number: number): AgreedCoverageBlock {
  return { number: BigInt(number), hash: hash(number + 1),
    parentHash: number === 0 ? H0 : hash(number), timestamp: BigInt(number),
    orderedTransactionDigest: H2 };
}

const identity = { scheme: "porto-intent-v1" as const,
  decoder: "porto-orchestrator-intent-v055" as const, chainId: "56", eoa: OWNER,
  orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751" as Address,
  orchestratorVersion: "0.5.5" as const, nonce: "7", expiry: "0",
  executionDataHash: H2, keyHash: H3 } as const;

function requirement(): EvidenceRequirement {
  return { journalOwner: OWNER, journalAgent: "agent", journalAction: "lp",
    journalIdempotencyKey: "target", begunAtBlock: 0n, expiry: 0n,
    preparedIdentityHash: H1, coverageVersion: H2, quorumId: H3, laneId: H1,
    state: "eligible", unavailableCode: null, createdAt: 1, terminalAt: null,
    evidenceRetainedUntil: null, updatedAt: 1, rowVersion: 0,
    chargedLogicalBytes: 512n };
}

async function seed(store: LpCoverageStore): Promise<{
  readonly lane: CoverageLane; readonly lease: CoverageLease;
}> {
  let lane = await store.ensureLane({ coverageVersion: H2, quorumId: H3, laneId: H1,
    purpose: "base", admissionKeyHash: H0, originBlock: 0n });
  const lease = await store.claimLease(lane, "unavailable-audit", 0,
    8_000_000_000_000_000);
  assert.ok(lease);
  for (let from = 0; from <= 300; from += 50) {
    const to = Math.min(from + 49, 306);
    const blocks = Array.from({ length: to - from + 1 }, (_, offset) => block(from + offset));
    const sourceChunkDigests = Object.fromEntries(SOURCE_IDS.map((sourceId) => [sourceId,
      chunkDigest({ sourceId, laneId: H1, generation: lane.generation,
        fromBlock: BigInt(from), toBlock: BigInt(to), blocks: blocks.map((row) => ({
          number: row.number, hash: row.hash, parentHash: row.parentHash,
          timestamp: row.timestamp, transactionListDigest: row.orderedTransactionDigest,
        })) })])) as Record<string, Hex>;
    const candidates: CoverageCandidate[] = from === 250 ? [{ txHash: H1, inputHash: H2,
      blockNumber: 250n, blockHash: block(250).hash, transactionIndex: 0n, intentIndex: 0,
      memberCount: 1, eoa: OWNER, nonce: 7n, executionDataHash: H2, keyHash: H3,
      logIndex: 1n, eventTopicsHash: H2, eventDataHash: H3, candidateDigest: H1 }] : [];
    lane = await store.commitAgreedRange({ lane, lease, expectedRowVersion: lane.rowVersion,
      blocks, sourceChunkDigests, candidates, now: to });
  }
  assert.equal(await store.compactZeroExpiry(lane, lease, 1_000), 1);
  const compacted = (await store.listActiveLanes())[0];
  assert.ok(compacted);
  const rewound = await store.rewind(compacted, block(250), lease,
    [{ toBlock: 49n, toBlockHash: block(49).hash, agreed: false }]);
  assert.deepEqual(await store.listActiveLanes(), [],
    "the unsafe compacted prefix makes its requirement unavailable");
  return { lane: rewound, lease };
}

function assertNoAuthoritativeEvidence(value: Awaited<ReturnType<LpCoverageStore["snapshot"]>>): void {
  assert.ok(value === null || value.outcome === "ambiguous",
    `an unavailable compacted interval cannot produce authoritative landing evidence; got ${value?.outcome ?? "null"}`);
}

describe("Phase 3.9c fourth independent fix-review regressions", () => {
  it("does not let Memory registration resurrect a compacted-prefix-unavailable requirement", async () => {
    const store = new MemoryLpCoverageStore(config);
    const zero = requirement();
    await store.registerRequirement(zero);
    await seed(store);

    // `evidenceObserver.snapshot` registers the admitted row immediately before
    // every coverage read. That must not overwrite the reorg's unavailable state.
    await store.registerRequirement(zero);
    assertNoAuthoritativeEvidence(await store.snapshot({ requirement: zero, identity,
      requiredSourceIds: SOURCE_IDS, expirySafetySeconds: 300 }));
    assert.deepEqual(await store.listActiveLanes(), []);
  });

  it("does not let PostgreSQL snapshot an already-unavailable durable requirement", async () => {
    const sql = new FakeSqlClient();
    const evidence = await PostgresLpEvidenceStore.create(sql, config, () => 1_000);
    const store = new PostgresLpCoverageStore(sql, config);
    const zero = requirement();
    const input = { journalOwner: zero.journalOwner, journalAgent: zero.journalAgent,
      journalAction: zero.journalAction, journalIdempotencyKey: zero.journalIdempotencyKey,
      begunAtBlock: zero.begunAtBlock, expiry: zero.expiry,
      preparedIdentityHash: zero.preparedIdentityHash, coverageVersion: zero.coverageVersion,
      quorumId: zero.quorumId, laneId: zero.laneId };
    const admitted = await evidence.admitRequirement(input);
    assert.ok(!("unavailable" in admitted));
    await seed(store);

    const unavailable = await evidence.admitRequirement(input);
    assert.ok(!("unavailable" in unavailable));
    if ("unavailable" in unavailable) return;
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.unavailableCode, "compacted-prefix-reorg");
    assertNoAuthoritativeEvidence(await store.snapshot({ requirement: unavailable, identity,
      requiredSourceIds: SOURCE_IDS, expirySafetySeconds: 300 }));
  });
});

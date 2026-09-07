import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { createLpEvidenceObserver } from "../src/lp/evidenceObserver.js";
import type { PreparedIntentIdentityV1 } from "../src/lp/preparedIntent.js";
import { absentDispositionReleasesReservation } from "../src/lp/resolveLanding.js";
import { resolveLpEvidenceConfig } from "../src/ops/config.js";
import {
  MemoryLpCoverageStore,
  PostgresLpCoverageStore,
  type CoverageCandidate,
} from "../src/store/lpCoverage.js";
import type { EvidenceRequirement } from "../src/store/lpEvidence.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const H0 = `0x${"00".repeat(32)}` as Hex;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const H3 = `0x${"33".repeat(32)}` as Hex;
const H4 = `0x${"44".repeat(32)}` as Hex;
const OWNER = `0x${"12".repeat(20)}` as Address;

const config = resolveLpEvidenceConfig({
  LP_LANDING_EVIDENCE_ENABLED: "true",
  LP_LANDING_EVIDENCE_SOURCES_JSON: JSON.stringify([
    { id: "bnbchain-public", url: "https://bsc-dataseed-public.bnbchain.org", role: "required" },
    { id: "publicnode", url: "https://bsc-rpc.publicnode.com", role: "required" },
  ]),
});

const identity: PreparedIntentIdentityV1 = {
  scheme: "porto-intent-v1",
  decoder: "porto-orchestrator-intent-v055",
  chainId: "56",
  eoa: OWNER,
  orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
  orchestratorVersion: "0.5.5",
  nonce: "7",
  expiry: "100",
  executionDataHash: H2,
  keyHash: H3,
};

function requirement(laneId: Hex, key = "target", expiry = 100n): EvidenceRequirement {
  return {
    journalOwner: OWNER,
    journalAgent: "agent",
    journalAction: "lp",
    journalIdempotencyKey: key,
    begunAtBlock: 10n,
    expiry,
    preparedIdentityHash: H1,
    coverageVersion: H2,
    quorumId: H3,
    laneId,
    state: "eligible",
    unavailableCode: null,
    createdAt: 1,
    terminalAt: null,
    evidenceRetainedUntil: null,
    updatedAt: 1,
    rowVersion: 0,
    chargedLogicalBytes: 512n,
  };
}

describe("Phase 3.9c independent audit regressions", () => {
  it("preserves a pre-ancestor landed candidate across a shallow Postgres rewind", async () => {
    const store = new PostgresLpCoverageStore(new FakeSqlClient(), config);
    const lane = await store.ensureLane({
      coverageVersion: H2,
      quorumId: H3,
      laneId: H1,
      purpose: "backfill",
      admissionKeyHash: H0,
      originBlock: 10n,
    });
    const lease = await store.claimLease(lane, "audit", 0, 8_000_000_000_000_000);
    assert.ok(lease);
    const candidate: CoverageCandidate = {
      txHash: H1,
      inputHash: H2,
      blockNumber: 10n,
      blockHash: H1,
      transactionIndex: 0n,
      intentIndex: 0,
      memberCount: 1,
      eoa: OWNER,
      nonce: 7n,
      executionDataHash: H2,
      keyHash: H3,
      logIndex: 1n,
      eventTopicsHash: H2,
      eventDataHash: H3,
      candidateDigest: H1,
    };
    const advanced = await store.commitAgreedRange({
      lane,
      lease,
      expectedRowVersion: lane.rowVersion,
      blocks: [
        { number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
          orderedTransactionDigest: H2 },
        { number: 11n, hash: H2, parentHash: H1, timestamp: 402n,
          orderedTransactionDigest: H3 },
      ],
      sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 },
      candidates: [candidate],
      now: 1,
    });
    const before = await store.snapshot({
      requirement: requirement(H1),
      identity,
      requiredSourceIds: ["bnbchain-public", "publicnode"],
      expirySafetySeconds: 300,
    });
    assert.equal(before?.outcome, "landed");

    const rewound = await store.rewind(advanced,
      { number: 10n, hash: H1, parentHash: H0, timestamp: 401n,
        orderedTransactionDigest: H2 }, lease);
    const replacementLease = await store.claimLease(rewound, "audit", 2,
      8_000_000_000_000_000);
    assert.ok(replacementLease);
    await store.commitAgreedRange({
      lane: rewound,
      lease: replacementLease,
      expectedRowVersion: rewound.rowVersion,
      blocks: [{ number: 11n, hash: H4, parentHash: H1, timestamp: 403n,
        orderedTransactionDigest: H3 }],
      sourceChunkDigests: { "bnbchain-public": H4, publicnode: H4 },
      candidates: [],
      now: 3,
    });
    const after = await store.snapshot({
      requirement: requirement(H1),
      identity,
      requiredSourceIds: ["bnbchain-public", "publicnode"],
      expirySafetySeconds: 300,
    });
    assert.equal(after?.outcome, "landed",
      "the unchanged prefix candidate remains part of the current contiguous generation");
  });

  it("allocates an exact backfill lane after a same-origin base lane is compacted", async () => {
    const hash = (value: number): Hex =>
      `0x${value.toString(16).padStart(64, "0")}` as Hex;
    const store = new MemoryLpCoverageStore();
    const observer = createLpEvidenceObserver({ config, store, fetchFn: async () => {
      throw new Error("admission must not contact an upstream");
    } });
    const first = await observer.admission({
      begunAtBlock: 10n,
      preparedIdentity: identity,
      requirementKeyHash: H1,
    });
    assert.ok(first);
    await store.registerRequirement(requirement(first.laneId, "first", 0n));
    let lane = (await store.listActiveLanes())[0];
    assert.ok(lane);
    const lease = await store.claimLease(lane, "audit-compactor", 0,
      8_000_000_000_000_000);
    assert.ok(lease);
    lane = await store.commitAgreedRange({
      lane,
      lease,
      expectedRowVersion: lane.rowVersion,
      blocks: [{ number: 10n, hash: hash(10), parentHash: hash(9), timestamp: 10n,
        orderedTransactionDigest: H2 }],
      sourceChunkDigests: { "bnbchain-public": H1, publicnode: H1 },
      candidates: [],
      now: 1,
    });
    lane = await store.commitAgreedRange({
      lane,
      lease,
      expectedRowVersion: lane.rowVersion,
      blocks: Array.from({ length: 257 }, (_, offset) => {
        const number = 11 + offset;
        return { number: BigInt(number), hash: hash(number), parentHash: hash(number - 1),
          timestamp: BigInt(number), orderedTransactionDigest: H2 };
      }),
      sourceChunkDigests: { "bnbchain-public": H2, publicnode: H2 },
      candidates: [],
      now: 2,
    });
    assert.equal(await store.compactZeroExpiry(lane, lease, 3), 1);
    const compacted = (await store.listActiveLanes())[0];
    assert.equal(compacted?.rawRetainedFrom, 11n);

    const second = await observer.admission({
      begunAtBlock: 10n,
      preparedIdentity: { ...identity, nonce: "8" },
      requirementKeyHash: H4,
    });
    assert.ok(second);
    assert.notEqual(second.laneId, first.laneId,
      "deleted history requires a new requirement-specific backfill lane");
  });

  it("releases an exit reservation when prior COMMITTED work spent no gas", () => {
    const bookkeepingSkip = [{
      state: "COMMITTED",
      externalRef: {},
    } as never];
    assert.equal(absentDispositionReleasesReservation({ kind: "protect" }, 1,
      bookkeepingSkip), true);
    assert.equal(absentDispositionReleasesReservation({ kind: "manual-exit" }, 1,
      bookkeepingSkip), true);
  });
});

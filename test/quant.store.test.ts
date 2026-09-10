/**
 * The quant store's SEMANTICS, on the memory backend (QUANT-GRID W6).
 *
 * ─── WHAT THIS FILE CAN AND CANNOT PROVE ───────────────────────────────────
 *
 * It proves the CONTRACT: which CAS wins, what is idempotent, what is
 * write-once, and that receipt ownership admits exactly one action. It cannot
 * prove the SQL — `test/support/fakeSql.ts` dispatches on a statement tag and
 * never parses SQL, so a hand-restated predicate would carry zero executed
 * coverage while this suite stayed green. That is the lending `$3 - $4`
 * blocker's class, and BC31 makes the answer a REAL server:
 * `test/quant.pg.test.ts` runs every statement in this store against one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import {
  MemoryQuantJobStore,
  QUANT_LOCK_CLASSID,
  type QuantJobStore,
} from "../src/store/quantJobs.js";

const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const JOB = "quant-job-1";
const KEY = `0x${"04".repeat(65)}` as Hex;
const DIGEST = `0x${"11".repeat(32)}` as Hex;
const U = 10n ** 18n;

async function armedStore(): Promise<QuantJobStore> {
  const store = new MemoryQuantJobStore();
  await store.discoverJob({
    quantJobId: JOB, envelopeId: "env-1", envelopeJson: "{}", nowMs: 1_000,
  });
  await store.updateJobWire({
    quantJobId: JOB, strategyId: "strat-1", tradingWallet: WALLET,
    allocationUWei: 30n * U, dailyCapUWei: 40n * U, termDays: 30,
    startedAtMs: 1_000, endsAtMs: 9_000_000, sessionExpiresAtMs: 9_000_000,
    revokedAtMs: null, nowMs: 1_100,
  });
  const job = await store.getJob(JOB);
  assert.notEqual(job, null);
  const result = await store.admitJob({
    quantJobId: JOB,
    expectedRowVersion: job!.rowVersion,
    sessionPublicKey: KEY,
    sessionExpiry: 1_800_000,
    permissionsDigest: DIGEST,
    projectionDigest: DIGEST,
    wbnbCapMinLimitWei: 2n * 10n ** 17n,
    residualThresholdWei: 10n ** 15n,
    paramsJson: "{}",
    paramsDigest: DIGEST,
    p0E18: 740n * 10n ** 18n,
    armBlock: 100n,
    levels: [
      { levelIndex: 1, buyPriceE18: 700n * 10n ** 18n, sellPriceE18: 749n * 10n ** 18n },
      { levelIndex: 2, buyPriceE18: 651n * 10n ** 18n, sellPriceE18: 697n * 10n ** 18n },
    ],
    clipUWei: 10n * U,
    idleUWei: 0n,
    baselineUWei: 30n * U,
    baselineWbnbWei: 0n,
    baselineNativeWei: 10n ** 16n,
    nowMs: 1_200,
  });
  assert.equal(result.kind, "ok");
  return store;
}

async function insertBuy(store: QuantJobStore, journalKey: string): Promise<void> {
  const levels = await store.listLevels(JOB);
  const level = levels[0]!;
  const inserted = await store.withQuantFence(JOB, async (fence) =>
    fence.insertIntent({
      journalKey,
      quantJobId: JOB,
      levelIndex: 1,
      actionSeq: level.actionSeq + 1,
      side: "buy",
      priorLevelState: level.state,
      expectedLevelRowVersion: level.rowVersion,
      amountInWei: 10n * U,
      minOutWei: 13_500_000_000_000_000n,
      quoteOutWei: 13_551_363_807_546_408n,
      quoteBlock: 101n,
      triggerBlock1: 100n,
      triggerBlock2: 100n,
      deadlineSec: 1_800_601,
      callsJson: "[]",
      note: "{}",
      impactBps: 4,
      preUWei: 30n * U,
      preWbnbWei: 0n,
      preNativeWei: 10n ** 16n,
      basisUWei: 0n,
      baseAtCycleStartWei: 0n,
      nowMs: 2_000,
    }),
  );
  assert.equal(inserted.kind, "ok");
}

describe("quant store — admission", () => {
  it("arms once, writes the levels, and opens the first epoch", async () => {
    const store = await armedStore();
    const job = await store.getJob(JOB);
    assert.equal(job?.status, "armed");
    assert.equal(job?.sessionPublicKey, KEY);
    assert.equal(job?.levels, 2);
    const epoch = await store.currentEpoch(JOB);
    assert.equal(epoch?.epoch, 1);
    assert.equal(epoch?.baselineUWei, 30n * U);
  });

  it("refuses a SECOND admission — the CAS is on the row version AND the status", async () => {
    const store = await armedStore();
    const job = await store.getJob(JOB);
    const second = await store.admitJob({
      quantJobId: JOB, expectedRowVersion: job!.rowVersion,
      sessionPublicKey: KEY, sessionExpiry: 1_800_000,
      permissionsDigest: DIGEST, projectionDigest: DIGEST,
      wbnbCapMinLimitWei: 1n, residualThresholdWei: 1n,
      paramsJson: "{}", paramsDigest: DIGEST, p0E18: 1n, armBlock: 200n,
      levels: [{ levelIndex: 1, buyPriceE18: 1n, sellPriceE18: 2n }],
      clipUWei: 1n, idleUWei: 0n,
      baselineUWei: 0n, baselineWbnbWei: 0n, baselineNativeWei: 0n, nowMs: 3_000,
    });
    assert.equal(second.kind, "conflict");
  });

  it("prices are WRITE-ONCE — a re-anchor is a new job, never a mutation", async () => {
    const store = await armedStore();
    const before = await store.listLevels(JOB);
    // There is no statement in this store that can change a level's prices; the
    // admission insert is `do nothing` on conflict. Re-running it proves it.
    const job = await store.getJob(JOB);
    await store.admitJob({
      quantJobId: JOB, expectedRowVersion: job!.rowVersion,
      sessionPublicKey: KEY, sessionExpiry: 1_800_000,
      permissionsDigest: DIGEST, projectionDigest: DIGEST,
      wbnbCapMinLimitWei: 1n, residualThresholdWei: 1n,
      paramsJson: "{}", paramsDigest: DIGEST, p0E18: 1n, armBlock: 200n,
      levels: [{ levelIndex: 1, buyPriceE18: 999n, sellPriceE18: 999n }],
      clipUWei: 1n, idleUWei: 0n,
      baselineUWei: 0n, baselineWbnbWei: 0n, baselineNativeWei: 0n, nowMs: 3_000,
    });
    assert.deepEqual(await store.listLevels(JOB), before);
  });
});

describe("quant store — intents and the blocking CAS", () => {
  it("blocks the level and records the prior state", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const levels = await store.listLevels(JOB);
    assert.equal(levels[0]?.state, "blocked");
    assert.equal(levels[0]?.priorState, "armed-quote");
    assert.equal(levels[0]?.actionSeq, 1);
    // BC13: the trigger latch resets on any action on the level.
    assert.equal(levels[0]?.triggerConsecutive, 0);
    assert.equal(levels[0]?.triggerSide, null);
  });

  it("refuses a SECOND intent on a blocked level", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const levels = await store.listLevels(JOB);
    const second = await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "key-2", quantJobId: JOB, levelIndex: 1, actionSeq: 2, side: "buy",
        priorLevelState: "armed-quote", expectedLevelRowVersion: levels[0]!.rowVersion,
        amountInWei: 1n, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 1, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 3_000,
      }),
    );
    assert.equal(second.kind, "conflict");
  });

  it("refuses an intent on a STALE level row version", async () => {
    const store = await armedStore();
    const levels = await store.listLevels(JOB);
    const stale = levels[0]!.rowVersion - 1;
    const result = await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "key-stale", quantJobId: JOB, levelIndex: 1, actionSeq: 1, side: "buy",
        priorLevelState: "armed-quote", expectedLevelRowVersion: stale,
        amountInWei: 1n, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 1, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 3_000,
      }),
    );
    assert.equal(result.kind, "conflict");
  });
});

describe("quant store — the submit/abort race (R5.2)", () => {
  it("exactly ONE of {submitted, aborted} wins, on the same row version", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const action = await store.getAction("key-1");
    const version = action!.rowVersion;
    const [submitted, aborted] = await Promise.all([
      store.markActionSubmitted({
        journalKey: "key-1", expectedRowVersion: version,
        submitFinalizedNumber: 100n, submitFinalizedHash: `0x${"bb".repeat(32)}` as Hex,
        nowMs: 4_000,
      }),
      store.abortIntent({ journalKey: "key-1", expectedRowVersion: version, nowMs: 4_000 }),
    ]);
    const winners = [submitted.kind, aborted.kind].filter((kind) => kind === "ok");
    assert.equal(winners.length, 1, "exactly one CAS may win");
    const final = await store.getAction("key-1");
    assert.ok(final?.state === "submitted" || final?.state === "aborted");
  });

  it("an abort RESTORES the level to its prior state", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const action = await store.getAction("key-1");
    await store.abortIntent({
      journalKey: "key-1", expectedRowVersion: action!.rowVersion, nowMs: 4_000,
    });
    const levels = await store.listLevels(JOB);
    assert.equal(levels[0]?.state, "armed-quote");
  });

  it("persists the finalized ancestor IN the submit CAS (R5.1)", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const action = await store.getAction("key-1");
    await store.markActionSubmitted({
      journalKey: "key-1", expectedRowVersion: action!.rowVersion,
      submitFinalizedNumber: 12_345n, submitFinalizedHash: `0x${"cc".repeat(32)}` as Hex,
      nowMs: 4_000,
    });
    const settled = await store.getAction("key-1");
    assert.equal(settled?.submitFinalizedNumber, 12_345n);
    assert.equal(settled?.submitFinalizedHash, `0x${"cc".repeat(32)}`);
  });
});

describe("quant store — settlement", () => {
  const TX = `0x${"ee".repeat(32)}` as Hex;

  async function settledBuy(): Promise<QuantJobStore> {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const action = await store.getAction("key-1");
    await store.markActionSubmitted({
      journalKey: "key-1", expectedRowVersion: action!.rowVersion,
      submitFinalizedNumber: 100n, submitFinalizedHash: `0x${"bb".repeat(32)}` as Hex,
      nowMs: 4_000,
    });
    const result = await store.settleAction({
      journalKey: "key-1", quantJobId: JOB, levelIndex: 1, txHash: TX, swapLogIndex: 4n,
      fillInWei: 10n * U, fillOutWei: 13_551_363_807_546_408n, feeDeltaWei: null,
      entryCostUWei: 220n, nextLevelState: "holding-base",
      nextBaseWei: 13_551_363_807_546_408n,
      nextBaseAtCycleStartWei: 13_551_363_807_546_408n,
      nextBasisUWei: 10n * U, cyclesClosedDelta: 0, realizedDeltaUWei: 0n,
      residualDeltaWei: 0n, exitPlanJson: '{"chunks":["1"]}', nowMs: 5_000,
    });
    assert.equal(result.kind, "ok");
    return store;
  }

  it("moves inventory in ONE CAS and records the fills", async () => {
    const store = await settledBuy();
    const level = (await store.listLevels(JOB))[0];
    assert.equal(level?.state, "holding-base");
    assert.equal(level?.baseWei, 13_551_363_807_546_408n);
    assert.equal(level?.basisUWei, 10n * U);
    assert.equal(level?.entryCostUWei, 220n);
    const action = await store.getAction("key-1");
    assert.equal(action?.state, "settled");
    assert.equal(action?.txHash, TX);
  });

  it("is IDEMPOTENT — a second settle of the same action is a no-op", async () => {
    const store = await settledBuy();
    const again = await store.settleAction({
      journalKey: "key-1", quantJobId: JOB, levelIndex: 1, txHash: TX, swapLogIndex: 4n,
      fillInWei: 1n, fillOutWei: 1n, feeDeltaWei: null, entryCostUWei: 0n,
      nextLevelState: "armed-quote", nextBaseWei: 0n, nextBaseAtCycleStartWei: 0n,
      nextBasisUWei: 0n, cyclesClosedDelta: 99, realizedDeltaUWei: 999n,
      residualDeltaWei: 0n, exitPlanJson: null, nowMs: 6_000,
    });
    assert.equal(again.kind, "ok");
    const level = (await store.listLevels(JOB))[0];
    assert.equal(level?.cyclesClosed, 0, "a no-op must not credit a cycle");
    assert.equal(level?.baseWei, 13_551_363_807_546_408n);
  });

  it("REFUSES a second action claiming the same (tx, wallet, swap log)", async () => {
    const store = await settledBuy();
    // A different action of the same wallet must not be able to claim the same
    // swap — the ownership key is what makes settlement exactly-once (R5.3).
    const levels = await store.listLevels(JOB);
    const level2 = levels[1]!;
    await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "key-2", quantJobId: JOB, levelIndex: 2, actionSeq: 1, side: "buy",
        priorLevelState: level2.state, expectedLevelRowVersion: level2.rowVersion,
        amountInWei: 10n * U, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 1, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 6_000,
      }),
    );
    const stolen = await store.settleAction({
      journalKey: "key-2", quantJobId: JOB, levelIndex: 2, txHash: TX, swapLogIndex: 4n,
      fillInWei: 10n * U, fillOutWei: 1n, feeDeltaWei: null, entryCostUWei: 0n,
      nextLevelState: "holding-base", nextBaseWei: 1n, nextBaseAtCycleStartWei: 1n,
      nextBasisUWei: 10n * U, cyclesClosedDelta: 0, realizedDeltaUWei: 0n,
      residualDeltaWei: 0n, exitPlanJson: null, nowMs: 7_000,
    });
    assert.equal(stolen.kind, "conflict");
  });

  it("never settles an action that already FAILED", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    await store.setActionState({
      journalKey: "key-1", state: "failed", failureCode: "x", restoreLevel: true, nowMs: 4_000,
    });
    const result = await store.settleAction({
      journalKey: "key-1", quantJobId: JOB, levelIndex: 1, txHash: TX, swapLogIndex: 1n,
      fillInWei: 1n, fillOutWei: 1n, feeDeltaWei: null, entryCostUWei: 0n,
      nextLevelState: "holding-base", nextBaseWei: 1n, nextBaseAtCycleStartWei: 1n,
      nextBasisUWei: 1n, cyclesClosedDelta: 0, realizedDeltaUWei: 0n,
      residualDeltaWei: 0n, exitPlanJson: null, nowMs: 5_000,
    });
    assert.equal(result.kind, "conflict");
  });
});

describe("quant store — retirement (R7.3 / BC26)", () => {
  it("is PERMANENT, snapshots a finalized block, and adds nothing to a baseline", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const before = await store.currentEpoch(JOB);
    const result = await store.retireLevel({
      quantJobId: JOB, levelIndex: 1,
      retiredJson: '{"baseWei":"1"}',
      epoch: {
        startedBlock: 500n, startedBlockHash: `0x${"dd".repeat(32)}` as Hex,
        baselineUWei: 20n * U, baselineWbnbWei: 5n, baselineNativeWei: 7n,
        note: "retire-level:1",
      },
      nowMs: 8_000,
    });
    assert.equal(result.kind, "ok");
    const level = (await store.listLevels(JOB))[0];
    assert.equal(level?.state, "retired");
    assert.equal(level?.baseWei, 0n);
    assert.equal(level?.retiredJson, '{"baseWei":"1"}');
    const epoch = await store.currentEpoch(JOB);
    assert.equal(epoch?.epoch, (before?.epoch ?? 0) + 1);
    // The BASELINE is the snapshot, not a fold of the retired records.
    assert.equal(epoch?.baselineUWei, 20n * U);
    assert.equal(epoch?.startedBlock, 500n);
  });

  it("is IDEMPOTENT and never reactivates a retired level", async () => {
    const store = await armedStore();
    await insertBuy(store, "key-1");
    const epochInput = {
      startedBlock: 500n, startedBlockHash: `0x${"dd".repeat(32)}` as Hex,
      baselineUWei: 1n, baselineWbnbWei: 1n, baselineNativeWei: 1n, note: "r",
    };
    await store.retireLevel({
      quantJobId: JOB, levelIndex: 1, retiredJson: "{}", epoch: epochInput, nowMs: 8_000,
    });
    const again = await store.retireLevel({
      quantJobId: JOB, levelIndex: 1, retiredJson: "{}", epoch: epochInput, nowMs: 9_000,
    });
    assert.equal(again.kind, "ok");
    assert.equal((await store.listLevels(JOB))[0]?.state, "retired");
    // A retired level cannot take an intent, whatever the row version says.
    const levels = await store.listLevels(JOB);
    const attempt = await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "key-9", quantJobId: JOB, levelIndex: 1, actionSeq: 9, side: "buy",
        priorLevelState: "armed-quote", expectedLevelRowVersion: levels[0]!.rowVersion,
        amountInWei: 1n, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 1, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 10_000,
      }),
    );
    assert.equal(attempt.kind, "conflict");
  });
});

describe("quant store — observations, reports and the fence", () => {
  it("keeps the last 8 observations and advances the job's height", async () => {
    const store = await armedStore();
    for (let index = 0; index < 12; index += 1) {
      await store.withQuantFence(JOB, async (fence) =>
        fence.recordObservation({
          quantJobId: JOB,
          observation: {
            blockNumber: BigInt(100 + index),
            blockHash: `0x${index.toString(16).padStart(64, "0")}` as Hex,
            observedAtMs: 1_000 + index,
            midE18: 740n * 10n ** 18n,
          },
        }),
      );
    }
    const observations = await store.listObservations(JOB, 20);
    assert.equal(observations.length, 8);
    assert.equal(observations.at(-1)?.blockNumber, 111n);
    assert.equal((await store.getJob(JOB))?.lastObservedBlock, 111n);
  });

  it("records EVERY report attempt, not just the last", async () => {
    const store = await armedStore();
    await store.recordReport({
      quantJobId: JOB, payloadDigest: DIGEST, responseStatus: 0, notesApplied: null, nowMs: 1,
    });
    await store.recordReport({
      quantJobId: JOB, payloadDigest: DIGEST, responseStatus: 200, notesApplied: 2, nowMs: 2,
    });
    const reports = await store.listReports(JOB);
    assert.equal(reports.length, 2);
    assert.deepEqual(reports.map((row) => row.attempt), [1, 2]);
    assert.equal((await store.getJob(JOB))?.reportAttempts, 2);
  });

  it("SERIALIZES two fences on one job", async () => {
    const store = await armedStore();
    const order: string[] = [];
    await Promise.all([
      store.withQuantFence(JOB, async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a-end");
      }),
      store.withQuantFence(JOB, async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });

  it("pins the advisory-lock class id, which must not collide silently", () => {
    // The TWO-ARGUMENT form is what matters (the lending review's finding: the
    // one-argument form shares one 32-bit space with every other user).
    assert.equal(QUANT_LOCK_CLASSID, 0x5155_414e);
  });
});

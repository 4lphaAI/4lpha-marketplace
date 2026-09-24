/**
 * Revision 14.5 Part A — the operator-run "not executed" door
 * (`MD here/QUANT-GRID-R145-NOT-EXECUTED-SPEC.md` §1, §3).
 *
 * BC-S213..S217: the pure `notExecutedProof`, and its agreement with
 * `reconcileAccounting` at the same dust.
 * BC-S218/S219: `resolveNotExecuted` on the memory store (the PG halves live
 * in `test/quant.pg.test.ts`). BC-S224: the CLI's gate order and `status`
 * suffixes. BC-S220 is in `test/quant.scenarios.test.ts` (it needs the worker);
 * BC-S221..S223 are in `test/quant.execute.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import { MemoryExecutionJournal } from "../src/store/journal.js";
import {
  MemoryQuantJobStore,
  type QuantActionRow,
  type QuantEpochRow,
  type QuantJobStore,
  type QuantLevelRow,
} from "../src/store/quantJobs.js";
import { notExecutedProof, reconcileAccounting } from "../src/quant/reconcile.js";

const U = 10n ** 18n;
const DUST = 1_000_000_000_000n;
const HASH_EPOCH = `0x${"e1".repeat(32)}` as Hex;
const HASH_SUBMIT = `0x${"5a".repeat(32)}` as Hex;
const HASH_F = `0x${"f0".repeat(32)}` as Hex;
const FINALIZED = { number: 200n, hash: HASH_F, timestampSec: 10_001n } as const;

const EPOCH: QuantEpochRow = {
  quantJobId: "j", epoch: 1, startedBlock: 100n, startedBlockHash: HASH_EPOCH,
  baselineUWei: 100n * U, baselineWbnbWei: U, baselineNativeWei: 0n,
  note: "arm", createdAtMs: 0, verified: true,
};

function action(overrides: Partial<QuantActionRow> = {}): QuantActionRow {
  return {
    journalKey: "a", quantJobId: "j", levelIndex: 2, actionSeq: 2, side: "sell",
    state: "unknown", priorLevelState: "holding-base", amountInWei: 4n * 10n ** 16n,
    minOutWei: 30n * U, quoteOutWei: 30n * U, quoteBlock: 110n,
    triggerBlock1: 110n, triggerBlock2: 111n, deadlineSec: 10_000,
    callsJson: "[]", note: "{}", impactBps: 0, preUWei: 0n, preWbnbWei: 0n,
    preNativeWei: 0n, preNativeBlock: null, basisUWei: 0n, baseAtCycleStartWei: 0n,
    submitFinalizedNumber: 120n, submitFinalizedHash: HASH_SUBMIT, txHash: null,
    fillInWei: null, fillOutWei: null, feeDeltaWei: null, resolutionJson: null,
    failureCode: "submit-ambiguous", createdAtMs: 0, updatedAtMs: 0, rowVersion: 3,
    ladderGen: 0, evidenceKind: "crossing", executedBlock: null, executedAtSec: null,
    requiredNativeWei: 1n, gasPriceWei: null, feeEstWei: null, ...overrides,
  };
}

function settled(overrides: Partial<QuantActionRow>): QuantActionRow {
  return action({
    state: "settled", txHash: `0x${"ab".repeat(32)}` as Hex, failureCode: null,
    executedAtSec: 5_000n, ...overrides,
  });
}

function level(overrides: Partial<QuantLevelRow> = {}): QuantLevelRow {
  return {
    quantJobId: "j", levelIndex: 2, state: "blocked", buyPriceE18: 700n * U,
    sellPriceE18: 749n * U, baseWei: 4n * 10n ** 16n, baseAtCycleStartWei: 4n * 10n ** 16n,
    basisUWei: 30n * U, entryCostUWei: 0n, actionSeq: 2, cyclesClosed: 0,
    realizedUWei: 0n, residualWei: 0n, priorState: "holding-base",
    triggerConsecutive: 0, triggerSide: null, lastActionAtMs: null, holdCode: null,
    holdCount: 0, exitPlanJson: null, retiredJson: null, rowVersion: 7, ladderGen: 0,
    seedPending: false, seedRefusals: 0, seedSubmissions: 0, seedLastCause: null,
    seedOutcome: null, seedNote: null, triggerBlockFirst: null, triggerHashFirst: null,
    triggerAtFirst: null, ...overrides,
  };
}

type ProofInput = Parameters<typeof notExecutedProof>[0];

function input(overrides: Partial<ProofInput> = {}): ProofInput {
  return {
    action: action(), journalState: "UNKNOWN", journalHasCallsId: false, others: [],
    sharedWalletJobs: 0, level: level(), epoch: EPOCH, epochBlockHash: HASH_EPOCH,
    submitAncestorHash: HASH_SUBMIT, finalized: FINALIZED,
    actualUWei: EPOCH.baselineUWei, actualWbnbWei: EPOCH.baselineWbnbWei, ...overrides,
  };
}

function code(overrides: Partial<ProofInput>): string {
  const verdict = notExecutedProof(input(overrides));
  return verdict.ok ? "ok" : verdict.code;
}

describe("R14.5 notExecutedProof (pure)", () => {
  it("BC-S213: an unknown sell, no callsId, verified epoch, deadline passed, balances = baseline → ok", () => {
    const verdict = notExecutedProof(input());
    assert.equal(verdict.ok, true);
    const evidence = verdict.evidence!;
    assert.equal(evidence.v, 1);
    assert.equal(evidence.kind, "not-executed");
    for (const field of [
      "finalizedBlock", "finalizedTimestampSec", "epochStartedBlock", "expectedUWei",
      "expectedWbnbWei", "actualUWei", "actualWbnbWei", "dustWei",
    ] as const) {
      assert.match(evidence[field], /^[0-9]+$/u, `${field} must be a decimal string`);
    }
    assert.equal(evidence.finalizedBlock, "200");
    assert.equal(evidence.expectedUWei, (100n * U).toString(10));
    assert.equal(evidence.expectedWbnbWei, U.toString(10));
    assert.equal(evidence.dustWei, DUST.toString(10));
    assert.equal(evidence.finalizedHash, HASH_F);
    assert.equal(evidence.epochStartedBlockHash, HASH_EPOCH);
    assert.deepEqual(evidence.appliedSettled, []);
    // Round-trips as JSON (the persisted resolution record).
    assert.equal(JSON.parse(JSON.stringify(evidence)).kind, "not-executed");
  });

  it("BC-S214: each precondition P1..P9 refuses in isolation", () => {
    // P1
    assert.equal(code({ action: action({ state: "submitted" }) }), "not-ambiguous");
    assert.equal(code({ action: action({ txHash: `0x${"cd".repeat(32)}` as Hex }) }), "not-ambiguous");
    assert.equal(code({ journalState: "IN_PROGRESS" }), "not-ambiguous");
    assert.equal(code({ journalState: null }), "not-ambiguous");
    assert.equal(code({ journalHasCallsId: true }), "has-callsid");
    // P2: one other job on the same wallet
    assert.equal(code({ sharedWalletJobs: 1 }), "wallet-shared");
    // P3
    assert.equal(code({ level: null }), "level-moved");
    assert.equal(code({ level: level({ state: "holding-base" }) }), "level-moved");
    assert.equal(code({ level: level({ ladderGen: 1 }) }), "level-moved");
    // P4
    assert.equal(code({ others: [action({ journalKey: "o", state: "unknown" })] }), "other-action-pending");
    assert.equal(code({ others: [action({ journalKey: "o", state: "intended" })] }), "other-action-pending");
    // P5
    assert.equal(code({ others: [settled({ journalKey: "o", fillInWei: 1n, fillOutWei: 1n, executedBlock: null })] }), "other-action-unverified");
    assert.equal(code({ others: [settled({ journalKey: "o", fillInWei: null, fillOutWei: 1n, executedBlock: 150n })] }), "other-action-unverified");
    // P6 (verified is required: re-review v2-H1)
    assert.equal(code({ epoch: null }), "epoch-unverified");
    assert.equal(code({ epoch: { ...EPOCH, verified: false } }), "epoch-unverified");
    assert.equal(code({ epoch: { ...EPOCH, startedBlockHash: null } }), "epoch-unverified");
    assert.equal(code({ epochBlockHash: `0x${"00".repeat(32)}` as Hex }), "epoch-unverified");
    assert.equal(code({ epochBlockHash: HASH_EPOCH.toUpperCase().replace("0X", "0x") as Hex }), "ok");
    // P7
    assert.equal(code({ action: action({ submitFinalizedNumber: 99n }) }), "window-before-epoch");
    assert.equal(code({ action: action({ submitFinalizedNumber: 100n }) }), "ok");
    assert.equal(code({ submitAncestorHash: `0x${"00".repeat(32)}` as Hex }), "window-before-epoch");
    assert.equal(code({ action: action({ submitFinalizedNumber: null, submitFinalizedHash: null }) }), "window-before-epoch");
    // P8: strict — a finalized timestamp EQUAL to the deadline refuses
    assert.equal(code({ finalized: { ...FINALIZED, timestampSec: 10_000n } }), "deadline-not-passed");
    assert.equal(code({ finalized: { ...FINALIZED, number: 99n } }), "deadline-not-passed");
    // P9
    assert.equal(code({ action: action({ amountInWei: 2n * DUST }) }), "amount-below-dust");
    assert.equal(code({ action: action({ amountInWei: 2n * DUST + 1n }), actualWbnbWei: U }), "ok");
  });

  it("BC-S215: settled fills inside (epoch, F] move the expectation by exactly their fills; dust is inclusive", () => {
    const buy = settled({ journalKey: "s-buy", side: "buy", fillInWei: 10n * U, fillOutWei: 13n * 10n ** 15n, executedBlock: 150n });
    const sell = settled({ journalKey: "s-sell", side: "sell", fillInWei: 2n * 10n ** 16n, fillOutWei: 15n * U, executedBlock: 160n });
    const old = settled({ journalKey: "s-old", side: "buy", fillInWei: 7n * U, fillOutWei: 9n * 10n ** 15n, executedBlock: 100n });
    const others = [buy, sell, old];
    const expectedU = 100n * U - 10n * U + 15n * U;
    const expectedW = U + 13n * 10n ** 15n - 2n * 10n ** 16n;
    const verdict = notExecutedProof(input({ others, actualUWei: expectedU, actualWbnbWei: expectedW }));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.evidence?.expectedUWei, expectedU.toString(10));
    assert.equal(verdict.evidence?.expectedWbnbWei, expectedW.toString(10));
    assert.deepEqual(verdict.evidence?.appliedSettled, ["s-buy", "s-sell"], "executedBlock <= epoch block is not applied");
    assert.equal(code({ others, actualUWei: expectedU + DUST + 1n, actualWbnbWei: expectedW }), "balance-mismatch");
    assert.equal(code({ others, actualUWei: expectedU - DUST - 1n, actualWbnbWei: expectedW }), "balance-mismatch");
    assert.equal(code({ others, actualUWei: expectedU, actualWbnbWei: expectedW + DUST + 1n }), "balance-mismatch");
    assert.equal(code({ others, actualUWei: expectedU + DUST, actualWbnbWei: expectedW - DUST }), "ok");
    const mismatch = notExecutedProof(input({ others, actualUWei: expectedU + DUST + 1n, actualWbnbWei: expectedW }));
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.evidence?.expectedUWei, expectedU.toString(10), "a balance refusal carries its evidence");
    // Audit L1: a fill RECORDED after F (executedBlock = F + 1) is not applied,
    // although it executed at or below F and so is in the actual → refuse (§1.4).
    const afterF = settled({ journalKey: "s-after-f", side: "buy", fillInWei: 10n * U, fillOutWei: 13n * 10n ** 15n, executedBlock: FINALIZED.number + 1n });
    const lateFill = notExecutedProof(input({
      others: [afterF],
      actualUWei: EPOCH.baselineUWei - 10n * U,
      actualWbnbWei: EPOCH.baselineWbnbWei + 13n * 10n ** 15n,
    }));
    assert.equal(lateFill.ok, false);
    assert.equal(lateFill.ok ? "ok" : lateFill.code, "balance-mismatch");
    assert.deepEqual(lateFill.evidence?.appliedSettled, [], "executedBlock > F is not applied");
    assert.equal(lateFill.evidence?.expectedUWei, EPOCH.baselineUWei.toString(10));
  });

  it("BC-S216: executed shapes refuse, and a fill recorded after the epoch but already in the baseline refuses (H3)", () => {
    const sell = action();
    assert.equal(code({
      action: sell,
      actualWbnbWei: EPOCH.baselineWbnbWei - sell.amountInWei,
      actualUWei: EPOCH.baselineUWei + sell.minOutWei,
    }), "balance-mismatch");
    const buy = action({ side: "buy", priorLevelState: "armed-quote", amountInWei: 30n * U, minOutWei: 4n * 10n ** 16n });
    assert.equal(code({
      action: buy,
      actualUWei: EPOCH.baselineUWei - buy.amountInWei,
      actualWbnbWei: EPOCH.baselineWbnbWei + buy.minOutWei,
    }), "balance-mismatch");
    // `executedBlock` is the finalized head at settlement (>= the receipt
    // block). A fill whose true block is <= the epoch block is already in the
    // baseline; recorded later, it is applied again, and the door REFUSES.
    const inBaseline = settled({ journalKey: "h3", side: "buy", fillInWei: 10n * U, fillOutWei: 13n * 10n ** 15n, executedBlock: 150n });
    assert.equal(code({ others: [inBaseline] }), "balance-mismatch");
  });

  it("BC-S217: agrees with reconcileAccounting — the action marked failed is the empty-subset match", () => {
    const failed = { ...action(), state: "failed" as const };
    const verdict = reconcileAccounting({
      epoch: EPOCH, epochTimestampSec: 1_000n,
      observationBlock: FINALIZED.number, observationAtSec: FINALIZED.timestampSec,
      actualUWei: EPOCH.baselineUWei, actualWbnbWei: EPOCH.baselineWbnbWei,
      actions: [failed],
    });
    assert.equal(notExecutedProof(input()).ok, true);
    assert.equal(verdict.admissible, true);
    assert.deepEqual(verdict.pending, []);
  });
});

/* -------------------------------------------------------------------------- */
/* The store write (memory half)                                              */
/* -------------------------------------------------------------------------- */

const JOB = "quant-job-r145";
const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const KEY = `0x${"04".repeat(65)}` as Hex;
const DIGEST = `0x${"11".repeat(32)}` as Hex;
const FILL_OUT = 13_551_363_807_546_408n;
const RESOLUTION = '{"v":1,"kind":"not-executed"}';

async function armedStore(): Promise<MemoryQuantJobStore> {
  const store = new MemoryQuantJobStore();
  await store.discoverJob({ quantJobId: JOB, envelopeId: "env-1", envelopeJson: "{}", nowMs: 1_000 });
  await store.updateJobWire({
    quantJobId: JOB, strategyId: "strat-1", tradingWallet: WALLET,
    allocationUWei: 30n * U, dailyCapUWei: 40n * U, termDays: 30,
    startedAtMs: 1_000, endsAtMs: 9_000_000, sessionExpiresAtMs: 9_000_000,
    revokedAtMs: null, nowMs: 1_100,
  });
  const job = await store.getJob(JOB);
  const admitted = await store.admitJob({
    quantJobId: JOB, expectedRowVersion: job!.rowVersion,
    sessionPublicKey: KEY, sessionExpiry: 1_800_000,
    permissionsDigest: DIGEST, projectionDigest: DIGEST,
    wbnbCapMinLimitWei: 2n * 10n ** 17n, residualThresholdWei: 10n ** 15n,
    paramsJson: "{}", paramsDigest: DIGEST, p0E18: 740n * U, armBlock: 100n,
    levels: [
      { levelIndex: 1, buyPriceE18: 700n * U, sellPriceE18: 749n * U },
      { levelIndex: 2, buyPriceE18: 651n * U, sellPriceE18: 697n * U },
    ],
    clipUWei: 10n * U, idleUWei: 0n,
    baselineUWei: 30n * U, baselineWbnbWei: 0n, baselineNativeWei: 10n ** 16n,
    nowMs: 1_200,
  });
  assert.equal(admitted.kind, "ok");
  return store;
}

async function insert(
  store: QuantJobStore, journalKey: string, levelIndex: number, side: "buy" | "sell", amountInWei: bigint,
): Promise<void> {
  const current = (await store.listLevels(JOB)).find((row) => row.levelIndex === levelIndex)!;
  const inserted = await store.withQuantFence(JOB, async (fence) => fence.insertIntent({
    journalKey, quantJobId: JOB, levelIndex, actionSeq: current.actionSeq + 1, side,
    priorLevelState: current.state, expectedLevelRowVersion: current.rowVersion,
    amountInWei, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 101n,
    triggerBlock1: 100n, triggerBlock2: 100n, deadlineSec: 1_800_601,
    callsJson: "[]", note: "{}", impactBps: 0,
    preUWei: 30n * U, preWbnbWei: 0n, preNativeWei: 10n ** 16n,
    basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 2_000,
  }));
  assert.equal(inserted.kind, "ok");
  const row = await store.getAction(journalKey);
  const claimed = await store.markActionSubmitted({
    journalKey, expectedRowVersion: row!.rowVersion,
    submitFinalizedNumber: 120n, submitFinalizedHash: HASH_SUBMIT, nowMs: 3_000,
  });
  assert.equal(claimed.kind, "ok");
}

/** Level 1 holds a settled buy's WBNB, then an ambiguous SELL; level 2 an ambiguous BUY. */
async function ambiguousPair(): Promise<{ store: MemoryQuantJobStore; journal: MemoryExecutionJournal }> {
  const store = await armedStore();
  const journal = new MemoryExecutionJournal();
  await insert(store, "buy-settled", 1, "buy", 10n * U);
  const settle = await store.settleAction({
    journalKey: "buy-settled", quantJobId: JOB, levelIndex: 1, txHash: `0x${"ee".repeat(32)}` as Hex,
    swapLogIndex: 2n, fillInWei: 10n * U, fillOutWei: FILL_OUT, feeDeltaWei: null,
    entryCostUWei: 220n, nextLevelState: "holding-base", nextBaseWei: FILL_OUT,
    nextBaseAtCycleStartWei: FILL_OUT, nextBasisUWei: 10n * U, cyclesClosedDelta: 0,
    realizedDeltaUWei: 0n, residualDeltaWei: 0n, exitPlanJson: null,
    executedBlock: 110n, executedAtSec: 1_000n, nowMs: 4_000,
  });
  assert.equal(settle.kind, "ok");
  await insert(store, "sell-unknown", 1, "sell", FILL_OUT);
  await insert(store, "buy-unknown", 2, "buy", 10n * U);
  for (const key of ["sell-unknown", "buy-unknown"]) {
    await journal.beginWithSpend({
      idempotencyKey: key, agentId: JOB, ownerAddress: WALLET, kind: "quantTrade",
      decisionId: key, externalRef: { publicKey: KEY }, nativeSpendWei: 0n,
    }, 3_000);
    await journal.markUnknown(key, "Quant submission outcome is unknown; held for reconciliation. cause=relay-timeout waited_ms=45000");
    const moved = await store.setActionState({
      journalKey: key, state: "unknown", failureCode: "submit-ambiguous", nowMs: 5_000,
    });
    assert.equal(moved?.state, "unknown");
  }
  return { store, journal };
}

async function doorInput(store: QuantJobStore, journalKey: string) {
  const row = (await store.getAction(journalKey))!;
  const lvl = (await store.listLevels(JOB)).find((candidate) => candidate.levelIndex === row.levelIndex)!;
  return {
    journalKey,
    expectedActionRowVersion: row.rowVersion,
    expectedLevelRowVersion: lvl.rowVersion,
    expectedLadderGen: lvl.ladderGen,
    resolutionJson: RESOLUTION,
    nowMs: 9_000,
  };
}

async function snapshot(store: QuantJobStore): Promise<string> {
  return JSON.stringify({
    job: await store.getJob(JOB),
    levels: await store.listLevels(JOB),
    actions: await store.listActions(JOB),
  }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString(10) : value));
}

describe("R14.5 resolveNotExecuted (memory store)", () => {
  it("BC-S218: ok writes failed/not-executed-proven + resolution, restores the prior state, bumps accountingRev; the journal stays UNKNOWN", async () => {
    const { store, journal } = await ambiguousPair();
    for (const [key, levelIndex, prior] of [
      ["sell-unknown", 1, "holding-base"],
      ["buy-unknown", 2, "armed-quote"],
    ] as const) {
      const before = (await store.listLevels(JOB)).find((row) => row.levelIndex === levelIndex)!;
      assert.equal(before.state, "blocked");
      const jobBefore = (await store.getJob(JOB))!;
      const result = await store.resolveNotExecuted(await doorInput(store, key));
      assert.equal(result.kind, "ok");
      const row = (await store.getAction(key))!;
      assert.equal(row.state, "failed");
      assert.equal(row.failureCode, "not-executed-proven");
      assert.equal(row.resolutionJson, RESOLUTION);
      assert.equal(result.record?.state, "failed");
      const after = (await store.listLevels(JOB)).find((candidate) => candidate.levelIndex === levelIndex)!;
      assert.equal(after.state, prior);
      assert.equal(after.rowVersion, before.rowVersion + 1);
      assert.equal(after.triggerConsecutive, 0);
      assert.equal(after.triggerSide, null);
      // The action moved nothing: inventory fields are untouched.
      assert.equal(after.baseWei, before.baseWei);
      assert.equal(after.basisUWei, before.basisUWei);
      assert.equal(after.baseAtCycleStartWei, before.baseAtCycleStartWei);
      assert.equal(after.entryCostUWei, before.entryCostUWei);
      assert.equal(after.realizedUWei, before.realizedUWei);
      assert.equal(after.cyclesClosed, before.cyclesClosed);
      assert.equal((await store.getJob(JOB))!.accountingRev, jobBefore.accountingRev + 1n);
      assert.equal((await journal.get(key))?.state, "UNKNOWN", "nothing moves an UNKNOWN journal row");
      assert.equal((await store.listNonTerminalActions(JOB)).some((candidate) => candidate.journalKey === key), false);
    }
    // Level 1 still holds the settled buy's inventory.
    assert.equal((await store.listLevels(JOB))[0]?.baseWei, FILL_OUT);
  });

  it("BC-S219: every CAS mismatch is a conflict and writes nothing", async () => {
    const { store } = await ambiguousPair();
    const good = await doorInput(store, "buy-unknown");
    const cases = [
      { ...good, expectedActionRowVersion: good.expectedActionRowVersion - 1 },
      { ...good, expectedLevelRowVersion: good.expectedLevelRowVersion + 1 },
      { ...good, expectedLadderGen: good.expectedLadderGen + 1 },
    ];
    for (const attempt of cases) {
      const before = await snapshot(store);
      const result = await store.resolveNotExecuted(attempt);
      assert.equal(result.kind, "conflict");
      assert.equal(result.record?.state, "unknown");
      assert.equal(await snapshot(store), before, "a conflict writes nothing");
    }

    // The action is not `unknown`: a submitted action on a fresh store.
    const fresh = await armedStore();
    await insert(fresh, "still-submitted", 2, "buy", 10n * U);
    const submittedInput = await doorInput(fresh, "still-submitted");
    const beforeSubmitted = await snapshot(fresh);
    const notUnknown = await fresh.resolveNotExecuted(submittedInput);
    assert.equal(notUnknown.kind, "conflict");
    assert.equal(notUnknown.record?.state, "submitted");
    assert.equal(await snapshot(fresh), beforeSubmitted);

    // The level is not `blocked`: retirement moved it while the action stayed unknown.
    const retired = await store.retireLevel({
      quantJobId: JOB, levelIndex: 2, retiredJson: "{}",
      epoch: {
        startedBlock: 500n, startedBlockHash: `0x${"dd".repeat(32)}` as Hex,
        baselineUWei: 1n, baselineWbnbWei: 1n, baselineNativeWei: 1n, note: "retire-level:2",
      },
      journalKey: "buy-unknown", nowMs: 8_000,
    });
    assert.equal(retired.kind, "ok");
    const retiredInput = await doorInput(store, "buy-unknown");
    const beforeRetired = await snapshot(store);
    const levelMoved = await store.resolveNotExecuted(retiredInput);
    assert.equal(levelMoved.kind, "conflict");
    assert.equal(await snapshot(store), beforeRetired);
    assert.equal((await store.getAction("buy-unknown"))?.state, "unknown");
  });
});

describe("R14.5 CLI (scripts/live-quant.ts)", () => {
  const source = readFileSync("scripts/live-quant.ts", "utf8");

  it("BC-S224: the rehearsal reads everything and writes nothing; only --yes-live reaches the write", () => {
    const branch = source.slice(
      source.indexOf('args.flags.get("not-executed")'),
      source.indexOf('args.flags.get("calls-id-read")'),
    );
    assert.ok(branch.length > 0, "the --not-executed branch exists");
    const gate = branch.indexOf("if (!yesLive(args))");
    const write = branch.indexOf("resolveNotExecuted(");
    assert.ok(gate > 0 && write > gate, "the only write sits after the --yes-live gate");
    assert.equal(branch.split("resolveNotExecuted(").length - 1, 1, "exactly one write");
    for (const read of ["listLevels(", "journal.get(", "listAccountingActions(", "listJobs()", "currentEpoch(", "finalizedBlock()", "blockAt(", "tokenBalanceAtHash("]) {
      const at = branch.indexOf(read);
      assert.ok(at > 0 && at < gate, `${read} happens before the gate`);
    }
    assert.equal(branch.includes(".listWorkableJobs("), false, "P2 counts every job row, not the workable set");
    // Audit M1: the proof's inputs are wired from the journal entry and the
    // P2 count compares wallets case-insensitively (C2/C3/C4) ...
    assert.ok(branch.includes("journalHasCallsId: entry?.externalRef.callsId !== undefined,"));
    assert.ok(branch.includes("journalState: entry?.state ?? null,"));
    assert.ok(branch.includes("row.tradingWallet.toLowerCase() === job.tradingWallet.toLowerCase()"));
    // ... and a refused proof RETURNS before the gate, so it can never reach the write (C6).
    const refusal = branch.indexOf("if (!proof.ok) { console.log(`refused: ${proof.code}`); return; }");
    assert.ok(refusal > 0 && refusal < gate, "a refused proof returns before the --yes-live gate and the write");
    assert.ok(branch.includes('console.log("refused: read-failed")'));
    assert.ok(branch.includes('console.log("refused: no-hash-reader")'));
    assert.ok(branch.includes('"refused: action-moved"'));
    assert.ok(branch.includes("resolved: not executed; level "));
  });

  it("BC-S224: status prints journal_error= for an UNKNOWN action and resolution=<kind> after the door", async () => {
    assert.ok(source.includes('entry?.state === "UNKNOWN" ? ` journal_error=${entry.lastError ?? "-"}`'));
    assert.ok(source.includes('action.state === "failed" && action.resolutionJson !== null'));
    assert.ok(source.includes("` resolution=${resolutionKind(action.resolutionJson)}`"));
    // What `status` reads after a real door: the persisted evidence names its kind.
    const { store, journal } = await ambiguousPair();
    const evidence = notExecutedProof(input()).evidence!;
    const result = await store.resolveNotExecuted({
      ...(await doorInput(store, "sell-unknown")), resolutionJson: JSON.stringify(evidence),
    });
    assert.equal(result.kind, "ok");
    const row = (await store.getAction("sell-unknown"))!;
    assert.equal(row.state, "failed");
    assert.equal((JSON.parse(row.resolutionJson!) as { kind: string }).kind, "not-executed");
    const entry = await journal.get("sell-unknown");
    assert.equal(entry?.state, "UNKNOWN");
    assert.match(entry?.lastError ?? "", /cause=relay-timeout waited_ms=/u);
  });
});

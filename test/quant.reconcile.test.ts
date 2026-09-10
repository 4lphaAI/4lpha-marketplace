/**
 * The R3.3 recovery table, cell by cell (QUANT-GRID R2.2, R3.3, R5.2, R6.1,
 * R7.4, BC31, BC32).
 *
 * The table is TOTAL: every (journal state × action state) pair a crash can
 * produce reaches a named cell, and the two that release a level do so only on
 * a durable proof of NON-ENTRY. Nothing here releases on silence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";

import { MemoryExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import { MemoryQuantJobStore, type QuantJobRow, type QuantJobStore } from "../src/store/quantJobs.js";
import { QUANT_STRATEGY_DEFAULTS, QUANT_ROUTER_56, QUANT_U_56, QUANT_WBNB_56, QUANT_U_WBNB_PAIR_56 } from "../src/quant/config.js";
import { buildPancakeTokenSwap } from "../src/ops/pancakeTokens.js";
import {
  recoverUnsettledActions,
  retirementAllowed,
  verifyAndSettle,
  type QuantReconcileDeps,
} from "../src/quant/reconcile.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import {
  buildPair,
  encodeExecute,
  encodeIntent,
  intentExecutedLog,
  swapLog,
  transferLog,
} from "./support/quantReceipts.js";
import { INTENT_SUCCESS_ERR } from "../src/quant/receipt.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { publicKeyToAddress } from "viem/accounts";
import { withStaleActionSnapshot } from "./support/quantStale.js";

const U = 10n ** 18n;
const JOB = "quant-job-rec";
const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const PUBLIC_KEY = "0x043c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b13b306b0fe085665d8fc1b28ae1676cd3ad6e08eaeda225fe38d0da4de55703e0" as Hex;
const KEY_HASH = accountKeyHashForAddress(publicKeyToAddress(PUBLIC_KEY));
const AMOUNT_IN = 10n * U;
const MIN_OUT = 13_500_000_000_000_000n;
const FILL_OUT = 13_551_363_807_546_408n;
const DIGEST = `0x${"11".repeat(32)}` as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;

const CALLS = buildPancakeTokenSwap({
  router: QUANT_ROUTER_56, tokenIn: QUANT_U_56, tokenOut: QUANT_WBNB_56,
  amountInWei: AMOUNT_IN, minOutWei: MIN_OUT, recipient: WALLET, deadline: 1_800_000_601n,
});
const CALLS_JSON = JSON.stringify(CALLS.map((call) => ({
  to: call.to, value: "0", data: call.data,
})));

function goodPair(nonce = 42n) {
  const intent = encodeIntent({ eoa: WALLET, nonce, keyHash: KEY_HASH, calls: CALLS });
  return buildPair({
    txHash: TX,
    input: encodeExecute([intent]),
    logs: [
      transferLog({ token: QUANT_U_56, from: WALLET, to: QUANT_U_WBNB_PAIR_56, value: AMOUNT_IN, logIndex: 0n }),
      transferLog({ token: QUANT_WBNB_56, from: QUANT_U_WBNB_PAIR_56, to: WALLET, value: FILL_OUT, logIndex: 1n }),
      swapLog({ pair: QUANT_U_WBNB_PAIR_56, to: WALLET, amountIn: AMOUNT_IN, amountOut: FILL_OUT, inputIsToken0: true, logIndex: 2n }),
      intentExecutedLog({ eoa: WALLET, nonce, incremented: true, err: INTENT_SUCCESS_ERR, logIndex: 3n }),
    ],
  });
}

type Fixture = {
  readonly store: QuantJobStore;
  readonly journal: ExecutionJournal;
  readonly job: QuantJobRow;
  readonly deps: QuantReconcileDeps;
  readonly key: string;
};

async function fixture(options: {
  readonly readStatus?: () => Promise<{
    readonly receipt: { status: "CONFIRMED" | "FAILED" | "PENDING"; transactionHash?: Hex };
    readonly rawStatus: string;
  }>;
  readonly receipt?: ReturnType<typeof goodPair> | null;
  readonly side?: "buy" | "sell";
} = {}): Promise<Fixture> {
  const store = new MemoryQuantJobStore();
  const journal = new MemoryExecutionJournal();
  await store.discoverJob({ quantJobId: JOB, envelopeId: "e", envelopeJson: "{}", nowMs: 1_000 });
  await store.updateJobWire({
    quantJobId: JOB, strategyId: "s", tradingWallet: WALLET,
    allocationUWei: 30n * U, dailyCapUWei: 40n * U, termDays: 30,
    startedAtMs: 1_000, endsAtMs: 9_000_000, sessionExpiresAtMs: 9_000_000,
    revokedAtMs: null, nowMs: 1_100,
  });
  const row = await store.getJob(JOB);
  await store.admitJob({
    quantJobId: JOB, expectedRowVersion: row!.rowVersion,
    sessionPublicKey: PUBLIC_KEY, sessionExpiry: 1_800_000,
    permissionsDigest: DIGEST, projectionDigest: DIGEST,
    wbnbCapMinLimitWei: 2n * 10n ** 17n, residualThresholdWei: 10n ** 15n,
    paramsJson: "{}", paramsDigest: DIGEST, p0E18: 740n * U, armBlock: 100n,
    levels: [{ levelIndex: 1, buyPriceE18: 700n * U, sellPriceE18: 749n * U }],
    clipUWei: AMOUNT_IN, idleUWei: 0n,
    baselineUWei: 30n * U, baselineWbnbWei: 0n, baselineNativeWei: 10n ** 16n,
    nowMs: 1_200,
  });
  const levels = await store.listLevels(JOB);
  const key = "action-key";
  await store.withQuantFence(JOB, async (fence) =>
    fence.insertIntent({
      journalKey: key, quantJobId: JOB, levelIndex: 1, actionSeq: 1,
      side: options.side ?? "buy",
      priorLevelState: levels[0]!.state, expectedLevelRowVersion: levels[0]!.rowVersion,
      amountInWei: AMOUNT_IN, minOutWei: MIN_OUT, quoteOutWei: FILL_OUT,
      quoteBlock: 101n, triggerBlock1: 100n, triggerBlock2: 100n,
      deadlineSec: 1_800_000_601, callsJson: CALLS_JSON, note: "{}", impactBps: 4,
      preUWei: 30n * U, preWbnbWei: 0n, preNativeWei: 10n ** 16n,
      basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: 2_000,
    }),
  );
  const pair = options.receipt === undefined ? goodPair() : options.receipt;
  const reader = {
    async getTransaction(hash: Hex) {
      return pair !== null && hash.toLowerCase() === TX ? pair.transaction : null;
    },
    async getReceipt(hash: Hex) {
      return pair !== null && hash.toLowerCase() === TX ? pair.receipt : null;
    },
    async finalizedBlock() {
      return { number: 500n, hash: `0x${"bb".repeat(32)}` as Hex, timestampSec: 1_800_001_000n };
    },
  } as unknown as QuantChainReader;
  const provider = {
    ...(options.readStatus === undefined ? {} : { readExecutionStatus: options.readStatus }),
  } as unknown as WalletProvider;
  return {
    store, journal, key,
    job: (await store.getJob(JOB))!,
    deps: {
      store, journal, provider, reader,
      params: QUANT_STRATEGY_DEFAULTS,
      venue: {
        router: QUANT_ROUTER_56, u: QUANT_U_56, wbnb: QUANT_WBNB_56, pair: QUANT_U_WBNB_PAIR_56,
      },
      nowMs: () => 3_000,
    },
  };
}

async function submitted(context: Fixture): Promise<void> {
  const action = await context.store.getAction(context.key);
  await context.store.markActionSubmitted({
    journalKey: context.key, expectedRowVersion: action!.rowVersion,
    submitFinalizedNumber: 90n, submitFinalizedHash: `0x${"cc".repeat(32)}` as Hex,
    nowMs: 2_500,
  });
}

async function begin(context: Fixture): Promise<void> {
  await context.journal.beginWithSpend({
    idempotencyKey: context.key, agentId: JOB, ownerAddress: WALLET,
    kind: "quantTrade", decisionId: context.key,
    externalRef: { publicKey: PUBLIC_KEY }, nativeSpendWei: 0n,
  }, 0);
}

describe("R3.3 — journal: none", () => {
  it("aborts an INTENDED action and restores the level", async () => {
    const context = await fixture();
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "none/intended");
    assert.equal(outcomes[0]?.released, true);
    assert.equal((await context.store.getAction(context.key))?.state, "aborted");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("a SUBMITTED action with no journal row is `needs-operator`, never a guess", async () => {
    const context = await fixture();
    await submitted(context);
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "none/submitted");
    assert.equal(outcomes[0]?.released, false);
    assert.equal((await context.store.getAction(context.key))?.state, "needs-operator");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "blocked");
  });
});

describe("R3.3 — journal: PENDING", () => {
  it("aborts an INTENDED action and rolls the journal back as `never-submitted`", async () => {
    const context = await fixture();
    await begin(context);
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "PENDING/intended");
    assert.equal(outcomes[0]?.released, true);
    assert.equal((await context.journal.get(context.key))?.state, "ROLLED_BACK");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("WAITS for a young SUBMITTED action rather than deciding", async () => {
    const context = await fixture();
    await begin(context);
    await submitted(context);
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.ok(outcomes[0]?.cell.startsWith("PENDING/submitted"), outcomes[0]?.cell);
    assert.equal(outcomes[0]?.released, false);
    assert.equal((await context.journal.get(context.key))?.state, "PENDING");
  });
});

describe("R3.3 — journal: IN_PROGRESS", () => {
  it("CONFIRMED + hash ⇒ commit, verify, SETTLE", async () => {
    const context = await fixture({
      readStatus: async () => ({
        receipt: { status: "CONFIRMED", transactionHash: TX }, rawStatus: "200",
      }),
    });
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "IN_PROGRESS/confirmed");
    assert.equal(outcomes[0]?.settled, true);
    const level = (await context.store.listLevels(JOB))[0];
    assert.equal(level?.state, "holding-base");
    assert.equal(level?.baseWei, FILL_OUT);
    assert.equal(level?.basisUWei, AMOUNT_IN);
    // BC29: the exit PLAN is a snapshot of the partition, persisted at settle.
    assert.notEqual(level?.exitPlanJson, null);
  });

  it("FAILED ⇒ rolled back, level restored", async () => {
    const context = await fixture({
      readStatus: async () => ({ receipt: { status: "FAILED" }, rawStatus: "500" }),
    });
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "IN_PROGRESS/failed");
    assert.equal(outcomes[0]?.released, true);
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("an UNMAPPED status decides NOTHING and keeps the action", async () => {
    // The live 08-25 incident's `{"status":300}` shape: `toCallsStatusReceipt`
    // maps it to PENDING, and PENDING here means ask again next cycle.
    const context = await fixture({
      readStatus: async () => ({ receipt: { status: "PENDING" }, rawStatus: "300" }),
    });
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "IN_PROGRESS/pending");
    assert.equal((await context.store.getAction(context.key))?.state, "submitted");
  });

  it("relay UNAVAILABILITY is never a verdict", async () => {
    const context = await fixture({
      readStatus: async () => { throw new Error("relay down"); },
    });
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "IN_PROGRESS/unreadable");
    assert.equal(outcomes[0]?.released, false);
    assert.equal((await context.journal.get(context.key))?.state, "IN_PROGRESS");
  });
});

describe("R3.3 — journal: COMMITTED", () => {
  it("verifies and settles a COMMITTED row whose level update was lost", async () => {
    const context = await fixture();
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    await context.journal.markCommitted(context.key, { txHash: TX });
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "COMMITTED+hash/verified");
    assert.equal(outcomes[0]?.settled, true);
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "holding-base");
  });

  it("an UNVERIFIABLE receipt does NOT settle and does NOT release", async () => {
    const context = await fixture({ receipt: null });
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    await context.journal.markCommitted(context.key, { txHash: TX });
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "COMMITTED+hash/unverified");
    assert.equal((await context.store.getAction(context.key))?.state, "committed-unverified");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "blocked");
  });

  it("COMMITTED with no hash and no reader is `needs-operator`", async () => {
    const context = await fixture();
    await begin(context);
    await submitted(context);
    await context.journal.markCommitted(context.key);
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "COMMITTED-hash/absent");
    assert.equal((await context.store.getAction(context.key))?.state, "needs-operator");
  });
});

describe("R5.2 — a stale recovery racing a live sender", () => {
  /**
   * The guard the audit found unpinned (A2, mutation M5): `recoverPending`
   * rolls the journal back ONLY when it WON the `intended → aborted` CAS.
   *
   * The sender's `intended → submitted` CAS is on the same row and the same
   * version, so a recovery holding a snapshot taken before it must lose — and
   * a loser that rolled the journal back anyway would declare "never
   * submitted" about a submission that is at that moment in flight.
   */
  it("a recovery that LOST the CAS moves nothing — journal, action, level", async () => {
    const context = await fixture();
    await begin(context);
    const stale = await context.store.listNonTerminalActions(JOB);
    assert.equal(stale[0]?.state, "intended");

    // The SENDER wins, exactly as `submitQuantAction` does immediately before
    // `executeViaSession`. The snapshot above is now a version behind.
    await submitted(context);

    const view = withStaleActionSnapshot(context.store, stale);
    const outcomes = await recoverUnsettledActions(
      { ...context.deps, store: view.store }, context.job,
    );

    assert.deepEqual(view.abortVerdicts, ["conflict"], "the recovery must LOSE the CAS");
    assert.equal(outcomes[0]?.cell, "PENDING/intended");
    assert.equal(outcomes[0]?.released, false);
    assert.equal((await context.journal.get(context.key))?.state, "PENDING");
    assert.equal((await context.store.getAction(context.key))?.state, "submitted");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "blocked");
  });

  it("the SAME recovery, unraced, wins and rolls the journal back", async () => {
    // The control: the snapshot is stale ONLY because the sender moved the row.
    const context = await fixture();
    await begin(context);
    const snapshot = await context.store.listNonTerminalActions(JOB);
    const view = withStaleActionSnapshot(context.store, snapshot);
    const outcomes = await recoverUnsettledActions(
      { ...context.deps, store: view.store }, context.job,
    );
    assert.deepEqual(view.abortVerdicts, ["ok"]);
    assert.equal(outcomes[0]?.released, true);
    assert.equal((await context.journal.get(context.key))?.state, "ROLLED_BACK");
  });
});

describe("R3.3 — journal: ROLLED_BACK and UNKNOWN", () => {
  it("ROLLED_BACK releases the level", async () => {
    const context = await fixture();
    await begin(context);
    await submitted(context);
    await context.journal.markRolledBack(context.key, "refused");
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "ROLLED_BACK/*");
    assert.equal(outcomes[0]?.released, true);
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("UNKNOWN × intended IS releasable — the submit CAS provably never ran", async () => {
    const context = await fixture();
    await begin(context);
    await context.journal.markUnknown(context.key, "ambiguous");
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "UNKNOWN/intended");
    assert.equal(outcomes[0]?.released, true);
    // The JOURNAL row stays UNKNOWN: the transition table forbids moving it,
    // and PHASE3.14 deliberately left it so (R3.3's journal API rule).
    assert.equal((await context.journal.get(context.key))?.state, "UNKNOWN");
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "armed-quote");
  });

  it("UNKNOWN × submitted stays BLOCKED — silence never releases", async () => {
    const context = await fixture();
    await begin(context);
    await submitted(context);
    await context.journal.markUnknown(context.key, "ambiguous");
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "UNKNOWN/blocked");
    assert.equal(outcomes[0]?.released, false);
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "blocked");
    assert.equal((await context.journal.get(context.key))?.state, "UNKNOWN");
  });

  it("UNKNOWN × submitted SETTLES on positive evidence, journal untouched", async () => {
    const context = await fixture({
      readStatus: async () => ({
        receipt: { status: "CONFIRMED", transactionHash: TX }, rawStatus: "200",
      }),
    });
    await begin(context);
    await submitted(context);
    await context.journal.markInProgress(context.key, { callsId: `0x${"c1".repeat(32)}` as Hex });
    await context.journal.markUnknown(context.key, "ambiguous");
    const outcomes = await recoverUnsettledActions(context.deps, context.job);
    assert.equal(outcomes[0]?.cell, "UNKNOWN/settled");
    assert.equal(outcomes[0]?.settled, true);
    assert.equal((await context.store.listLevels(JOB))[0]?.state, "holding-base");
    assert.equal((await context.journal.get(context.key))?.state, "UNKNOWN");
  });
});

describe("positive resolution window (R7.4)", () => {
  it("refuses a receipt BELOW the persisted finalized ancestor", async () => {
    const pair = goodPair();
    const context = await fixture({
      receipt: {
        transaction: { ...pair.transaction, blockNumber: 10n },
        receipt: { ...pair.receipt, blockNumber: 10n },
      },
    });
    await begin(context);
    await submitted(context);
    const action = await context.store.getAction(context.key);
    const verdict = await verifyAndSettle(context.deps, context.job, action!, TX);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "receipt-before-anchor");
  });

  it("accepts a valid receipt WITHOUT waiting for a future deadline block", async () => {
    const context = await fixture();
    await begin(context);
    await submitted(context);
    const action = await context.store.getAction(context.key);
    const verdict = await verifyAndSettle(context.deps, context.job, action!, TX);
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.code);
  });
});

describe("retirement preconditions (R6.1)", () => {
  const action = {
    deadlineSec: 1_000,
  } as unknown as Parameters<typeof retirementAllowed>[0]["action"];

  it("needs BOTH the key dead AND the deadline passed", async () => {
    assert.deepEqual(
      await retirementAllowed({
        action, keyIsValid: true, sessionExpiry: 9_999_999_999,
        finalizedTimestampSec: 2_000n,
      }),
      { allowed: false, reason: "session-still-valid" },
    );
    assert.deepEqual(
      await retirementAllowed({
        action, keyIsValid: false, sessionExpiry: null, finalizedTimestampSec: 999n,
      }),
      { allowed: false, reason: "deadline-not-passed" },
    );
    assert.deepEqual(
      await retirementAllowed({
        action, keyIsValid: false, sessionExpiry: null, finalizedTimestampSec: 2_000n,
      }),
      { allowed: true, reason: "key-dead-and-deadline-passed" },
    );
  });

  it("a PASSED EXPIRY counts as the key being dead", async () => {
    assert.deepEqual(
      await retirementAllowed({
        action, keyIsValid: true, sessionExpiry: 1_500, finalizedTimestampSec: 2_000n,
      }),
      { allowed: true, reason: "key-dead-and-deadline-passed" },
    );
  });
});

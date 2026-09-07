/**
 * Offline tests for the owner-facing sequence view — PHASE3.1-FIXREVIEW2 **G4**,
 * and its correction PHASE3.1-FIXREVIEW3 **H5**.
 *
 * THE FINDING. `lpSequenceView` rendered `{index, kind, journalDecisionId}` and
 * deliberately no state, on the reasoning that outcomes live in the journal.
 * That held while one plan position produced one step entry. PHASE3.1-FIXREVIEW
 * F2 made the exit's transport retries countable by persisting one
 * provably-unsubmitted row per attempt, so ONE never-submitted conversion began
 * rendering as five identical `sweep-token` entries plus a skip — visually
 * indistinguishable from five swaps that happened. That is FINDINGS (ae)/(al)'s
 * "looks like the system working" running in the other direction, and FINDINGS
 * (an) is the measured case of the same family: an operator read a SUCCESSFUL
 * resolution as "nothing happened" because the response buried the state change.
 *
 * WHY THIS FILE IS BUILT FROM REAL JOURNAL ROWS (**H5**). Its first version
 * hand-wrote the step outcomes — including `submitted: false` for the five retry
 * rows — so it asserted the INTENTION while the route derived `submitted` from
 * `externalRef.callsHash` and answered `true` for exactly those rows. The fixture
 * could not observe the defect it was written to prevent, which is worse than no
 * test: it made the shipped behaviour look pinned. So every outcome here is now
 * produced by `lpStepOutcome` — the ONE derivation `GET /agents/:id/lp` uses —
 * over rows written into a real `MemoryExecutionJournal` by the same sequence of
 * marks the saga performs at each of its sites. Nothing here reads a store and
 * nothing here may INVENT a state.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import {
  LP_STEP_OUTCOME_UNREADABLE,
  lpObservationView,
  lpSequenceView,
  lpStepOutcome,
  type LpSequenceStepOutcome,
} from "../src/http/lpWire.js";
import { LP_STEP_READ_CONCURRENCY } from "../src/server.js";
import {
  lpStepDecisionId,
  type LpSequenceRecord,
  type LpSequenceStep,
  type LpStepKind,
} from "../src/store/lpSequences.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";

const OWNER = getAddress("0x00000000000000000000000000000000000000a1");
const SEQ = "seq-exit-1";
const CALLS_HASH = `0x${"11".repeat(32)}` as Hex;
const CALLS_ID = `0x${"c1".repeat(32)}` as Hex;
const TX_HASH = `0x${"7a".repeat(32)}` as Hex;

function step(index: number, kind: LpStepKind): LpSequenceStep {
  return {
    index,
    kind,
    journalIdempotencyKey: `key-${index}`,
    journalDecisionId: lpStepDecisionId(SEQ, index),
  };
}

/** The shape F2's exhausted retry budget leaves behind: one real swap, six not. */
function exhaustedExit(): LpSequenceRecord {
  return {
    sequenceId: SEQ,
    agentId: "agent-1",
    ownerAddress: OWNER,
    positionId: "pos-1",
    kind: "protect",
    inlineConvert: false,
    state: "completed",
    recoveryState: "none",
    steps: [
      step(0, "zap-out"),
      step(1, "sweep-token"),
      step(2, "sweep-token"),
      step(3, "sweep-token"),
      step(4, "sweep-token"),
      step(5, "sweep-token"),
      step(6, "sweep-token"),
    ],
    note: "sweep-token skipped: transient failure on all 6 of 6 attempts, retries exhausted",
    inlineResidueBaseWei: null,
    stallCode: null,
    stallCount: 0,
    resolverPriorState: null,
    resolverPriorRecoveryState: null,
    resolverFence: 0n,
    resolverLeaseUntil: null,
    resolverSnapshotHash: null,
    resolverRowVersion: 0,
    resolutionId: null,
    resolverActionIdempotencyKey: null,
    resolutionDispositionStarted: false,
    retirementPriorState: null,
    retirementPriorRecoveryState: null,
    retirementTargetJournalKey: null,
    retirementActionIdempotencyKey: null,
    retirementFence: 0n,
    retirementLeaseUntil: null,
    retirementSnapshotHash: null,
    retirementRowVersion: 0,
    retirementDispositionStarted: false,
    // PHASE3.18 R2.3: null on every kind but `grid-requote`.
    targetTickLower: null,
    targetTickUpper: null,
    // PHASE3.22 R8: null on every kind but `grid-shift`.
    targetSellTickLower: null,
    targetSellTickUpper: null,
    shiftCause: null,
    // PHASE3.19 item 8: null on every kind but `grid-recenter`.
    hedgeDirection: null,
    hedgeAmountInWei: null,
    // PHASE3.20 item 7: null on every non-ladder kind.
    recenterEvidence: null,
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

/* -------------------------------------------------------------------------- */
/* Rows, written the way each saga site writes them                           */
/* -------------------------------------------------------------------------- */

type Rows = {
  readonly journal: MemoryExecutionJournal;
  /** Every key that got a row, in step order. */
  readonly keys: readonly string[];
};

async function begin(
  journal: MemoryExecutionJournal,
  key: string,
  externalRef?: { readonly callsHash?: Hex; readonly publicKey?: Hex },
): Promise<void> {
  await journal.beginWithSpend(
    {
      idempotencyKey: key,
      agentId: "agent-1",
      ownerAddress: OWNER,
      kind: "lp",
      decisionId: `lp:${SEQ}:${key}`,
      ...(externalRef === undefined ? {} : { externalRef }),
      nativeSpendWei: 0n,
    },
    0,
  );
}

/**
 * The exhausted exit's rows, written by the PREFLIGHT transient site — the site
 * H5 was measured on, and the one whose rows carry a `callsHash`.
 *
 * `beginWithSpend` writes `callsHash` BEFORE the daily-cap re-check, the late
 * kill-switch re-check, `restoreSession`, `preflightExecute` and every submit, so
 * a row rolled back by any of those has one. That is the whole defect: five such
 * rows read `submitted: true` against one real submission.
 */
async function preflightExhaustionRows(): Promise<Rows> {
  const journal = new MemoryExecutionJournal(() => 1_000);
  // Step 0: the zap-out. The only thing here that ever reached a relay.
  await begin(journal, "key-0", { callsHash: CALLS_HASH });
  await journal.markInProgress("key-0", { callsId: CALLS_ID });
  await journal.markCommitted("key-0", { txHash: TX_HASH });
  // Steps 1–5: five transport failures at the PREFLIGHT site. Real calldata was
  // hashed and bound to the key; nothing was ever sent.
  for (let index = 1; index <= 5; index += 1) {
    await begin(journal, `key-${index}`, { callsHash: CALLS_HASH });
    await journal.markRolledBack(
      `key-${index}`,
      "Refused before submission: INFRASTRUCTURE_ERROR (transient).",
    );
  }
  // Step 6: the terminal skip, past the budget. `recordSkip` hashes an empty
  // call list, so it has no `callsHash` either way.
  await begin(journal, "key-6");
  await journal.markCommitted("key-6");
  return { journal, keys: exhaustedExit().steps.map((s) => s.journalIdempotencyKey) };
}

/**
 * The same exhaustion driven through the BUILD site, whose throw precedes
 * `appendStep`, so `recordTransientAttempt` writes the row with an empty call
 * list. This is the site G4's original derivation happened to be right about.
 */
async function buildExhaustionRows(): Promise<Rows> {
  const journal = new MemoryExecutionJournal(() => 1_000);
  await begin(journal, "key-0", { callsHash: CALLS_HASH });
  await journal.markInProgress("key-0", { callsId: CALLS_ID });
  await journal.markCommitted("key-0", { txHash: TX_HASH });
  for (let index = 1; index <= 5; index += 1) {
    await begin(journal, `key-${index}`);
    await journal.markRolledBack(
      `key-${index}`,
      "Refused before submission: INFRASTRUCTURE_ERROR (transient).",
    );
  }
  await begin(journal, "key-6");
  await journal.markCommitted("key-6");
  return { journal, keys: exhaustedExit().steps.map((s) => s.journalIdempotencyKey) };
}

/**
 * THE ROUTE'S OWN FAN-OUT, minus the HTTP: one `journal.get` per recorded step,
 * each row through `lpStepOutcome`, a failed read degrading to
 * `LP_STEP_OUTCOME_UNREADABLE`. `src/server.ts` does exactly this (bounded in
 * concurrency), so a change to the derivation lands here.
 */
async function outcomesOf(rows: Rows): Promise<Map<string, LpSequenceStepOutcome>> {
  const outcomes = new Map<string, LpSequenceStepOutcome>();
  for (const key of rows.keys) {
    try {
      outcomes.set(key, lpStepOutcome(await rows.journal.get(key)));
    } catch {
      outcomes.set(key, LP_STEP_OUTCOME_UNREADABLE);
    }
  }
  return outcomes;
}

type StepView = Record<string, unknown>;

function stepsOf(view: Record<string, unknown>): StepView[] {
  return view["steps"] as StepView[];
}

describe("lpSequenceView: G4 — a retried conversion must not read as several swaps", () => {
  it("says which entries SUBMITTED, so six sweep-token rows are not six swaps", async () => {
    const steps = stepsOf(
      lpSequenceView(exhaustedExit(), await outcomesOf(await preflightExhaustionRows())),
    );

    assert.equal(steps.length, 7, "nothing is filtered out — a hidden attempt is the same lie");
    assert.equal(
      steps.filter((entry) => entry["kind"] === "sweep-token").length,
      6,
      "six attempts at ONE conversion is the fact to convey",
    );
    assert.equal(
      steps.filter((entry) => entry["submitted"] === true).length,
      1,
      "and exactly ONE step of this whole sequence ever reached a relay",
    );
    assert.equal(
      steps.filter((entry) => entry["kind"] === "sweep-token" && entry["submitted"] === true)
        .length,
      0,
      "the conversion itself never submitted — the whole point of G4",
    );
  });

  it("H5: the PREFLIGHT site's rolled-back rows carry a callsHash and still read submitted:false", async () => {
    // THE REGRESSION. `submitted` used to be `externalRef.callsHash !== undefined`,
    // and `callsHash` is written at `beginWithSpend` — above the daily-cap
    // re-check, the late kill-switch re-check, `restoreSession`,
    // `preflightExecute` and every submit. Measured on the shipped route, this
    // exact shape rendered all six `sweep-token` steps as
    // `ROLLED_BACK / submitted: true` against ONE real submission: the field G4
    // added to stop a never-submitted conversion looking like a swap asserting
    // five swaps that never happened, and a pair the saga's own invariant says
    // the journal cannot mean ("a ROLLED_BACK row provably never reached a
    // relay"). Against that derivation this case fails 5 times over.
    const rows = await preflightExhaustionRows();
    for (let index = 1; index <= 5; index += 1) {
      const row = await rows.journal.get(`key-${index}`);
      assert.equal(row?.state, "ROLLED_BACK");
      assert.equal(
        row?.externalRef.callsHash,
        CALLS_HASH,
        "the fixture must carry the field the old derivation read, or it proves nothing",
      );
      assert.equal(row?.externalRef.callsId, undefined, "and never reached the relay");
    }

    const steps = stepsOf(lpSequenceView(exhaustedExit(), await outcomesOf(rows)));
    assert.deepEqual(
      steps.map((entry) => [entry["state"], entry["submitted"]]),
      [
        ["COMMITTED", true],
        ["ROLLED_BACK", false],
        ["ROLLED_BACK", false],
        ["ROLLED_BACK", false],
        ["ROLLED_BACK", false],
        ["ROLLED_BACK", false],
        ["COMMITTED", false],
      ],
      "a ROLLED_BACK row can never read submitted:true",
    );
  });

  it("H5: the BUILD site renders identically, so one view means one thing", async () => {
    // The two transient sites sit on opposite sides of `appendStep`, and the old
    // derivation covered one and inverted the other — so the same owner-visible
    // event read differently depending on which reader happened to fail. Under
    // `callsId ?? txHash` they agree.
    const preflight = stepsOf(
      lpSequenceView(exhaustedExit(), await outcomesOf(await preflightExhaustionRows())),
    );
    const build = stepsOf(
      lpSequenceView(exhaustedExit(), await outcomesOf(await buildExhaustionRows())),
    );

    assert.deepEqual(
      build.map((entry) => [entry["state"], entry["submitted"], entry["unreadable"]]),
      preflight.map((entry) => [entry["state"], entry["submitted"], entry["unreadable"]]),
    );
  });

  it("H5: an UNKNOWN row is `null` — the one case where nobody knows", async () => {
    // The submit met the relay's 45 s silence: the row is UNKNOWN with no
    // `callsId`, and whether it reached a relay is the thing UNKNOWN MEANS. A
    // `false` here would be the same sin as the `true` H5 was filed about,
    // pointed the other way, so the view answers `null` and shows the state
    // beside it — the argument `unreadable` already makes for a failed read.
    const journal = new MemoryExecutionJournal(() => 1_000);
    await begin(journal, "key-0", { callsHash: CALLS_HASH });
    await journal.markUnknown("key-0", "The relay did not answer within 45000ms.");
    // ...and an UNKNOWN row that DID get a callsId is a submission whose OUTCOME
    // is unknown, which is a different fact and reads `true`.
    await begin(journal, "key-1", { callsHash: CALLS_HASH });
    await journal.markInProgress("key-1", { callsId: CALLS_ID });
    await journal.markUnknown("key-1", "Submission outcome is unknown.");

    const record: LpSequenceRecord = {
      ...exhaustedExit(),
      steps: [step(0, "sweep-token"), step(1, "zap-out")],
    };
    const steps = stepsOf(
      lpSequenceView(record, await outcomesOf({ journal, keys: ["key-0", "key-1"] })),
    );

    assert.deepEqual(steps[0]?.["state"], "UNKNOWN");
    assert.equal(steps[0]?.["submitted"], null, "not asserted in either direction");
    assert.equal(steps[0]?.["unreadable"], false, "the row read fine — it is the row that is unsure");
    assert.deepEqual(steps[1]?.["state"], "UNKNOWN");
    assert.equal(steps[1]?.["submitted"], true, "a callsId is proof the relay answered");
    assert.equal(steps[1]?.["txHash"], null, "a callsId is not a transaction hash");
  });

  it("carries the journal's own state for every entry, and invents none", async () => {
    const outcomes = await outcomesOf(await preflightExhaustionRows());
    const steps = stepsOf(lpSequenceView(exhaustedExit(), outcomes));

    assert.deepEqual(
      steps.map((entry) => entry["state"]),
      [
        "COMMITTED",
        "ROLLED_BACK",
        "ROLLED_BACK",
        "ROLLED_BACK",
        "ROLLED_BACK",
        "ROLLED_BACK",
        "COMMITTED",
      ],
      "five rolled-back attempts, then the terminal skip — readable at a glance",
    );
    // The terminal skip and the confirmed swap are BOTH `COMMITTED`; `submitted`
    // is what separates them, which is why both fields are rendered.
    assert.equal(steps[0]?.["txHash"], TX_HASH, "the confirmed receipt hash passes through exactly");
    assert.equal(steps[6]?.["state"], "COMMITTED");
    assert.equal(steps[6]?.["submitted"], false);
  });

  it("keeps the identity fields the view has always had", async () => {
    const view = lpSequenceView(
      exhaustedExit(),
      await outcomesOf(await preflightExhaustionRows()),
    );
    const steps = stepsOf(view);

    assert.equal(view["sequenceId"], SEQ);
    assert.equal(view["state"], "completed");
    assert.match(String(view["note"]), /retries exhausted/);
    assert.equal(steps[0]?.["index"], 0);
    assert.equal(steps[0]?.["kind"], "zap-out");
    assert.equal(steps[0]?.["journalDecisionId"], lpStepDecisionId(SEQ, 0));
  });

  it("distinguishes a row that was never CREATED from one that could not be READ", async () => {
    // Two different facts that would otherwise render identically. A missing row
    // is the `appendStep`→`begin` crash window and is provably unsubmitted; an
    // unreadable one is a journal read that failed, and the route answers
    // derived telemetry rather than a 500 on an owner's dashboard.
    const journal = new MemoryExecutionJournal(() => 1_000);
    const outcomes = new Map<string, LpSequenceStepOutcome>([
      // No row was ever written under key-0: `lpStepOutcome(null)`.
      ["key-0", lpStepOutcome(await journal.get("key-0"))],
    ]);
    const record: LpSequenceRecord = {
      ...exhaustedExit(),
      steps: [step(0, "zap-out"), step(1, "sweep-token")],
    };
    const steps = stepsOf(lpSequenceView(record, outcomes));

    assert.deepEqual(steps[0], {
      index: 0,
      kind: "zap-out",
      journalDecisionId: lpStepDecisionId(SEQ, 0),
      state: null,
      submitted: false,
      txHash: null,
      unreadable: false,
    });
    // Nothing supplied for key-1: the view must not silently claim "no row", and
    // must not claim anything about what it submitted either.
    assert.equal(steps[1]?.["state"], null);
    assert.equal(steps[1]?.["unreadable"], true);
    assert.equal(steps[1]?.["submitted"], null, "we could not ask, so we do not say");
  });
});

describe("Marketplace agent detail additive LP wire", () => {
  it("serializes observation bigint fields and preserves valuation identity above 2^53", () => {
    const huge = (2n ** 53n) + 123n;
    assert.deepEqual(
      lpObservationView({
        blockNumber: huge,
        evaluatedAtMs: 10_000,
        poolAddress: getAddress("0x00000000000000000000000000000000000000b1"),
        tokenId: "9007199254740993",
        currentTick: -65_533,
        protectConsecutive: 0,
        rotationBreach: false,
        rotationConsecutive: 0,
        valuation: {
          method: "sellable-exit-v1",
          exitValueWei: huge,
          quoteToken: getAddress("0x00000000000000000000000000000000000000b2"),
          tokenId: "9007199254740993",
          positionRowVersion: 17,
          blockNumber: huge + 1n,
          valuedAtMs: 9_999,
        },
      }),
      {
        blockNumber: huge.toString(10),
        evaluatedAtMs: 10_000,
        poolAddress: getAddress("0x00000000000000000000000000000000000000b1"),
        currentTick: -65_533,
        valuation: {
          method: "sellable-exit-v1",
          exitValueWei: huge.toString(10),
          quoteToken: getAddress("0x00000000000000000000000000000000000000b2"),
          tokenId: "9007199254740993",
          positionRowVersion: 17,
          blockNumber: (huge + 1n).toString(10),
          valuedAtMs: 9_999,
        },
      },
    );
    assert.equal(lpObservationView(null), null);
  });

  it("exposes only confirmed transaction hashes and grid-recenter evidence", async () => {
    const rows = await preflightExhaustionRows();
    const outcome = lpStepOutcome(await rows.journal.get("key-0"));
    assert.equal(outcome.txHash, TX_HASH);
    assert.equal(lpStepOutcome(await rows.journal.get("key-1")).txHash, null);

    const recenter = lpSequenceView(
      { ...exhaustedExit(), kind: "grid-recenter", recenterEvidence: "drift" },
      await outcomesOf(rows),
    );
    const ordinary = lpSequenceView(exhaustedExit(), await outcomesOf(rows));
    assert.equal(recenter["recenterEvidence"], "drift");
    assert.equal(ordinary["recenterEvidence"], null);
    assert.equal(stepsOf(recenter)[0]?.["txHash"], TX_HASH);
    assert.equal(stepsOf(recenter)[1]?.["txHash"], null);
  });
});

/**
 * PHASE3.1-FIXREVIEW4 I3: the fan-out cap was UNPINNED.
 *
 * H6 bounded `GET /agents/:id/lp`'s per-step journal reads with a worker pool,
 * and the review then measured that raising the cap to `MAX_SAFE_INTEGER` — i.e.
 * deleting the bound — passes the entire suite. A limit no test can see is a
 * comment. This pins the number itself, which is the cheap half; a peak-in-flight
 * assertion through the real route is still owed and is recorded in I3.
 */
describe("the LP step-read fan-out stays bounded (I3)", () => {
  it("pins the concurrency cap, so deleting the bound fails here", () => {
    assert.equal(
      LP_STEP_READ_CONCURRENCY,
      8,
      "GET /agents/:id/lp issues one journal read per recorded step. Unbounded, " +
        "one owner dashboard load is an arbitrary number of simultaneous queries " +
        "into the pool /execute, /trade and the LP sagas share — a read-only " +
        "route delaying a stop-loss. Change the number deliberately, or not at all.",
    );
  });
});

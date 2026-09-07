/**
 * PHASE3.8 F4a — abandoning a sequence whose steps never began.
 *
 * THE MEASURED DEFECT (FINDINGS aq). A harvest was refused at BUILD — correctly,
 * above `appendStep`, so nothing was recorded and nothing was submitted — and the
 * sequence parked `held / wbnb-stranded`. Every later worker cycle RESUMED it
 * instead of evaluating the position, so an armed price stop-loss could not fire,
 * and there was no in-plane way out: `resolveUnknown` needs a row to name and
 * there was none.
 *
 * REVIEW M1/M2 are why the assertions look the way they do. The spec's first
 * predicate ("no row at the current plan position") had two readings:
 *
 *   - index = `steps.length` fixes (aq) and ABANDONS a sequence holding an
 *     UNKNOWN row one index back — a possibly-landed submission dropped without
 *     ever being consulted;
 *   - index = `steps.length - 1` is safe and does not fix (aq) at all.
 *
 * So three of the cases below exist specifically to fail under the unsafe
 * reading, and one exists because the safe reading would leave (aq) untouched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyLpAbandonSequence } from "../src/lp/abandonSequence.js";
import type { JournalEntry, JournalState } from "../src/store/journal.js";
import type {
  LpRecoveryState,
  LpSequenceKind,
  LpSequenceRecord,
  LpSequenceState,
  LpStepKind,
} from "../src/store/lpSequences.js";

const SEQ = "7c2f0f5e-0000-4000-8000-000000000001";
const NOW = 1_900_000_000_000;
const INTERVAL = 60_000;

/** Defaults for the inputs AUDIT A2/A3/A4 added; a test overrides what it means. */
function verify(input: {
  readonly sequence: LpSequenceRecord;
  readonly stepRows: Map<string, JournalEntry | null>;
  readonly nextIndexRow: JournalEntry | null;
  readonly positionState?: "open" | "closing" | "closed";
  readonly nowMs?: number;
  readonly minIdleMs?: number;
}) {
  return verifyLpAbandonSequence({
    sequence: input.sequence,
    stepRows: input.stepRows,
    nextIndexRow: input.nextIndexRow,
    positionState: input.positionState ?? "open",
    nowMs: input.nowMs ?? NOW + INTERVAL * 10,
    minIdleMs: input.minIdleMs ?? INTERVAL,
  });
}

function row(state: JournalState): JournalEntry {
  return { state } as unknown as JournalEntry;
}

function sequence(input: {
  readonly steps: readonly LpStepKind[];
  readonly state?: LpSequenceState;
  readonly recoveryState?: LpRecoveryState;
  readonly kind?: LpSequenceKind;
}): LpSequenceRecord {
  return {
    sequenceId: SEQ,
    agentId: "agent-1",
    ownerAddress: "0x0000000000000000000000000000000000000001",
    positionId: "pos-1",
    kind: input.kind ?? "harvest",
    state: input.state ?? "held",
    recoveryState: input.recoveryState ?? "wbnb-stranded",
    steps: input.steps.map((kind, index) => ({
      kind,
      index,
      journalDecisionId: `lp:${SEQ}:${index}`,
      journalIdempotencyKey: `k${index}`,
    })),
    note: null,
    updatedAt: NOW,
    createdAt: NOW,
  } as unknown as LpSequenceRecord;
}

/** Rows for `k0..kN-1`, in order. `null` means "recorded but no row". */
function rows(...states: readonly (JournalState | null)[]): Map<string, JournalEntry | null> {
  return new Map(states.map((state, i) => [`k${i}`, state === null ? null : row(state)]));
}

describe("the disposition is scoped by the sequence KIND (2026-09-03: NFT 7316794)", () => {
  // MEASURED. Agent `grid-agent-01-2` held a dual arm: BUY 7316794, SELL 7316844.
  // Remove exited the SELL rung; its sweep hung; the owner abandoned it. The
  // route applied the verdict to every row of the arm group, so the BUY row was
  // closed too — while NFT 7316794 still held 198529011719679442645 of liquidity
  // — and the agent was revoked 15 seconds later. A manual-exit reads, submits
  // for and can empty exactly ONE position; it has no evidence about its sibling.
  it("a single-position sequence governs its own row only, whatever the arm group holds", () => {
    for (const kind of ["manual-exit", "protect", "harvest", "rotate", "grid-flip", "grid-requote", "grid-recenter"] as const) {
      const verdict = verify({
        sequence: sequence({ kind, steps: ["zap-out", "sweep-token"] }),
        stepRows: rows("COMMITTED", "ROLLED_BACK"),
        nextIndexRow: null,
        positionState: "closing",
      });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.ok && verdict.positionScope, "position", `${kind} must not dispose of its sibling`);
    }
  });

  it("keeps the group scope for the two kinds whose plan really does touch both rungs", () => {
    // `grid-arm` mints both rungs in one submission and its rollback closes both;
    // `grid-shift` re-ranges up to two in one atomic batch. Narrowing either would
    // strand a phantom row and make the re-arm precondition unsatisfiable.
    const arm = verify({
      sequence: sequence({ kind: "grid-arm", steps: ["zap-in-mint"] }),
      stepRows: rows("ROLLED_BACK"),
      nextIndexRow: null,
    });
    assert.equal(arm.ok && arm.positionAction, "close");
    assert.equal(arm.ok && arm.positionScope, "group");

    const shift = verify({
      sequence: sequence({ kind: "grid-shift", steps: ["grid-shift"] }),
      stepRows: rows("UNKNOWN"),
      nextIndexRow: null,
      positionState: "closing",
    });
    assert.equal(shift.ok && shift.positionAction, "close");
    assert.equal(shift.ok && shift.positionScope, "group");
  });
});

describe("PHASE3.8 F4a: a sequence is abandonable only when nothing is outstanding", () => {
  it("THE (aq) CASE: two COMMITTED steps and nothing at the next index ⇒ ABANDON", () => {
    // Stated as it really happened (REVIEW M2 corrected the spec here): the
    // build threw ABOVE `appendStep`, so the refused step was never recorded.
    // (aq)'s sequence has exactly TWO steps, both committed, and `steps.length`
    // is 2 — there is no third entry with a missing row.
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees", "sweep-token"] }),
      stepRows: rows("COMMITTED", "COMMITTED"),
      nextIndexRow: null,
    });

    assert.equal(verdict.ok, true);
    assert.equal(
      verdict.ok && verdict.positionAction,
      "leave",
      "a harvest never removed liquidity, so the position is intact",
    );
    assert.ok(
      verdict.checks.some((check) => check.name === "next-index"),
      "the receipt must record that nothing had started",
    );
  });

  it("an UNKNOWN row at index N-1 with nothing at N ⇒ REFUSE, naming resolveUnknown", () => {
    // THE case the unsafe reading gets wrong. `c942e17d` is exactly this: a
    // rotate whose sweep went UNKNOWN. Looking only at `steps.length` finds no
    // row and abandons a possibly-landed submission.
    const verdict = verify({
      sequence: sequence({ kind: "rotate", steps: ["zap-out", "sweep-token"] }),
      stepRows: rows("COMMITTED", "UNKNOWN"),
      nextIndexRow: null,
    });

    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.code, "step_not_settled");
    assert.match(
      (!verdict.ok && verdict.message) || "",
      /resolveUnknown/,
      "the refusal must name the tool that owns an ambiguous submission",
    );
  });

  it("a PENDING row at index N-1 ⇒ REFUSE, naming reconcile and the 3.7 age guard", () => {
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees", "sweep-token"] }),
      stepRows: rows("COMMITTED", "PENDING"),
      nextIndexRow: null,
    });

    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.code, "step_not_settled");
    assert.match((!verdict.ok && verdict.message) || "", /reconcile/);
    assert.match(
      (!verdict.ok && verdict.message) || "",
      /age guard/,
      "PHASE3.7 F1 means 'wait' needs a stated reason, or the operator retries in a loop",
    );
  });

  it("an IN_PROGRESS row anywhere ⇒ REFUSE, even when later steps settled", () => {
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees", "sweep-token", "zap-in-increase"] }),
      stepRows: rows("IN_PROGRESS", "COMMITTED", "COMMITTED"),
      nextIndexRow: null,
    });
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.code, "step_not_settled");
    assert.match((!verdict.ok && verdict.message) || "", /reconcile/);
    assert.match((!verdict.ok && verdict.message) || "", /age guard/);
  });

  it("a row already present at index steps.length ⇒ REFUSE: a saga is mid-flight", () => {
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees"] }),
      stepRows: rows("COMMITTED"),
      nextIndexRow: row("PENDING"),
    });
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.code, "step_in_flight");
  });

  it("a ROLLED_BACK row does NOT block — the hole REVIEW M3 found", () => {
    // The first draft refused whenever "a row exists", which left a sequence
    // whose last row is ROLLED_BACK refused by BOTH tools: this one because a
    // row exists, and `resolveUnknown` because the row is not UNKNOWN. That is
    // the ordinary product of a transient attempt, a late kill-switch
    // roll-back, a DAILY_CAP re-check and a preflight refusal.
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees", "sweep-token"] }),
      stepRows: rows("COMMITTED", "ROLLED_BACK"),
      nextIndexRow: null,
    });
    assert.equal(verdict.ok, true);
  });

  it("a RECORDED step with no row is settled by absence", () => {
    // It died between `appendStep` and `begin`, so it never submitted either.
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees", "sweep-token"] }),
      stepRows: rows("COMMITTED", null),
      nextIndexRow: null,
    });
    assert.equal(verdict.ok, true);
    assert.ok(
      verdict.checks.some((check) => check.result.includes("never submitted")),
      "and the receipt says why that is safe",
    );
  });

  it("a zero-step HELD sequence abandons", () => {
    const verdict = verify({
      sequence: sequence({ steps: [], state: "held", recoveryState: "pending-mint" }),
      stepRows: new Map(),
      nextIndexRow: null,
    });
    assert.equal(verdict.ok, true);
  });

  it("an already-terminal sequence refuses: there is nothing to abandon", () => {
    for (const [state, recoveryState] of [
      ["completed", "none"],
      ["rolled-back", "none"],
      ["held", "none"],
    ] as const) {
      const verdict = verify({
        sequence: sequence({ steps: [], state, recoveryState }),
        stepRows: new Map(),
        nextIndexRow: null,
      });
      assert.equal(verdict.ok, false, `${state}/${recoveryState}`);
      assert.equal(!verdict.ok && verdict.code, "sequence_terminal");
    }
  });

  describe("AUDIT A2: the disposition is EVIDENCE, not a recovery-state proxy", () => {
    // The first version keyed on `recoveryState === "pending-mint"`. A rotate
    // sets that after its zap-out and then OVERWRITES it with `wbnb-stranded`
    // after the sweep — same emptied NFT, different label — so a rotate held one
    // step later was left open with its pre-rotate basis. And `harvest`
    // overloads `wbnb-stranded` to mean the opposite (fees stranded, position
    // INTACT), so no recovery state can answer this at all.

    it("a rotate whose zap-out COMMITTED closes the position — under EITHER label", () => {
      for (const recoveryState of ["pending-mint", "wbnb-stranded"] as const) {
        const verdict = verify({
          sequence: sequence({
            kind: "rotate",
            steps: ["zap-out", "sweep-token"],
            recoveryState,
          }),
          stepRows: rows("COMMITTED", "COMMITTED"),
          nextIndexRow: null,
        });
        assert.equal(verdict.ok, true);
        assert.equal(
          verdict.ok && verdict.positionAction,
          "close",
          `recoveryState ${recoveryState}: the principal is out either way`,
        );
      }
    });

    it("a harvest holding wbnb-stranded LEAVES the position open — same label, opposite meaning", () => {
      const verdict = verify({
        sequence: sequence({
          kind: "harvest",
          steps: ["collect-fees", "sweep-token"],
          recoveryState: "wbnb-stranded",
        }),
        stepRows: rows("COMMITTED", "COMMITTED"),
        nextIndexRow: null,
      });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.ok && verdict.positionAction, "leave");
    });

    it("a rotate whose zap-out ROLLED BACK leaves the position alone", () => {
      const verdict = verify({
        sequence: sequence({
          kind: "rotate",
          steps: ["zap-out"],
          recoveryState: "pending-increase",
        }),
        stepRows: rows("ROLLED_BACK"),
        nextIndexRow: null,
      });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.ok && verdict.positionAction, "leave");
    });

    it("an abandoned OPEN closes the never-funded lineage", () => {
      const verdict = verify({
        sequence: sequence({ kind: "open", steps: ["zap-in-mint"], recoveryState: "pending-mint" }),
        stepRows: rows("ROLLED_BACK"),
        nextIndexRow: null,
      });
      assert.equal(verdict.ok && verdict.positionAction, "close");
    });

    it("PHASE3.11 B8: an exit whose zap-out COMMITTED is abandonable, and CLOSES the position", () => {
      // F2 gave the exit's steps a non-`none` recovery so a hold can park the
      // row at all. The disposition must still come from the STEP EVIDENCE
      // (AUDIT A2) and not from the label: a committed `zap-out` means the NFT
      // is empty, whatever `wbnb-stranded` is called elsewhere.
      const verdict = verify({
        sequence: sequence({
          kind: "protect",
          steps: ["zap-out", "sweep-token"],
          recoveryState: "wbnb-stranded",
        }),
        stepRows: rows("COMMITTED", "COMMITTED"),
        nextIndexRow: null,
        positionState: "closed",
      });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.ok && verdict.positionAction, "close");
    });

    it("AUDIT A8: an exit that never removed liquidity RESTORES a closing position", () => {
      // Otherwise the row sits at `closing` for ever: the worker skips it and
      // no exit will finish it.
      const verdict = verify({
        sequence: sequence({ kind: "protect", steps: ["zap-out"], recoveryState: "wbnb-stranded" }),
        stepRows: rows("ROLLED_BACK"),
        nextIndexRow: null,
        positionState: "closing",
      });
      assert.equal(verdict.ok && verdict.positionAction, "restore-open");
    });
  });

  describe("AUDIT A3: only a HELD, IDLE sequence may be abandoned", () => {
    it("an ACTIVE sequence refuses — a saga may be mid-drive", () => {
      const verdict = verify({
        sequence: sequence({ steps: [], state: "active", recoveryState: "none" }),
        stepRows: new Map(),
        nextIndexRow: null,
      });
      assert.equal(verdict.ok, false);
      assert.equal(!verdict.ok && verdict.code, "sequence_active");
    });

    it("a sequence touched within one worker interval refuses", () => {
      const verdict = verify({
        sequence: sequence({ steps: ["collect-fees"] }),
        stepRows: rows("COMMITTED"),
        nextIndexRow: null,
        nowMs: NOW + INTERVAL - 1,
      });
      assert.equal(verdict.ok, false);
      assert.equal(!verdict.ok && verdict.code, "sequence_too_fresh");
    });

    it("exactly one interval of idleness is enough", () => {
      const verdict = verify({
        sequence: sequence({ steps: ["collect-fees"] }),
        stepRows: rows("COMMITTED"),
        nextIndexRow: null,
        nowMs: NOW + INTERVAL,
      });
      assert.equal(verdict.ok, true);
    });
  });

  describe("AUDIT A4: a missing LOOKUP is not a missing ROW", () => {
    it("throws rather than treating an unlooked-up key as evidence", () => {
      assert.throws(
        () =>
          verify({
            sequence: sequence({ steps: ["collect-fees", "sweep-token"] }),
            // Only k0 was looked up. k1 is absent from the map entirely.
            stepRows: new Map([["k0", row("COMMITTED")]]),
            nextIndexRow: null,
          }),
        /refusing to treat a missing lookup as a missing row/,
      );
    });
  });

  it("AUDIT M17: the next-index probe is steps.length, not steps.length + 1", () => {
    // A surviving mutant probed one index too far, which would miss a row
    // sitting at the exact index the next step will use.
    const verdict = verify({
      sequence: sequence({ steps: ["collect-fees"] }),
      stepRows: rows("COMMITTED"),
      nextIndexRow: row("PENDING"),
    });
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.code, "step_in_flight");
    assert.match(
      (!verdict.ok && verdict.message) || "",
      new RegExp(`lp:${SEQ}:1\\b`),
      "the message must name index 1 for a one-step sequence",
    );
  });
});

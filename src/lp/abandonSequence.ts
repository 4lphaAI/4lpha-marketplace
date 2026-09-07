/**
 * PHASE3.8 F4a — abandoning a sequence whose steps never began.
 *
 * ─── WHY THIS EXISTS BESIDE `resolveUnknown` ───────────────────────────────
 *
 * `resolveUnknown` answers a CHAIN question: a submission may or may not have
 * landed, and the operator accepts the ambiguity in exchange for getting their
 * agent back. It is keyed on a journal row and asserts that row is `UNKNOWN`
 * (`resolveUnknown.ts`, `journal.ts`).
 *
 * FINDINGS (aq) is a sequence with **no row to name**. A harvest was refused at
 * BUILD — correctly, before any submit — and the build throws ABOVE
 * `appendStep`, so nothing was recorded for that step at all. The sequence
 * parked `held / wbnb-stranded`, every later worker cycle RESUMED it instead of
 * evaluating the position, and an armed price stop-loss could not fire. There
 * was no in-plane way out: `abandonSequence` did not exist, and `resolveUnknown`
 * requires a row.
 *
 * So this action answers a LOCAL question — *did anything ever start?* — and the
 * answer is provable rather than probable, because on every LP path the journal
 * row is written BEFORE the submit and there is no window between them:
 *
 *     sagas.ts   lpStepDecisionId -> appendStep -> beginWithSpend -> ... -> submit
 *     open.ts    the same order
 *
 * A row exists ⇒ a submit MAY have happened. No row ⇒ no submit. That
 * implication is the whole safety argument, and it is one-directional: this
 * action never reasons about what a row MEANS, only about whether one is
 * settled.
 *
 * ─── THE PREDICATE, AND WHY IT IS NOT THE OBVIOUS ONE (REVIEW M1) ──────────
 *
 * The spec first said "no journal row at the current plan position", which has
 * two readings and neither works:
 *
 *   - index = `steps.length` fixes (aq) and ABANDONS a sequence holding an
 *     `UNKNOWN` row one index back — a possibly-landed submission dropped
 *     without ever being consulted. Strictly worse than refusing.
 *   - index = `steps.length - 1` is safe and does not fix (aq) at all, because
 *     (aq)'s last recorded step is `COMMITTED`.
 *
 * There is also no such thing as "the current plan position": the decision-id
 * index is `recordedCount`, which diverges from the plan the moment a skip or a
 * transient attempt is recorded.
 *
 * What ships instead looks at the WHOLE sequence: every recorded step must be
 * SETTLED, and nothing may exist at the next index. That accepts (aq) — two
 * committed steps, nothing at index 2 — and refuses the rotate holding an
 * UNKNOWN, which is what both cases needed.
 *
 * ─── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 *
 * It never retries, never un-does a COMMITTED step, and never claims a step's
 * effect is absent. Committed steps MOVED VALUE and that value stays where it
 * went; the evidence records it so an owner reading the receipt knows what they
 * are accepting.
 */
import type { JournalEntry, JournalState } from "../store/journal.js";
import {
  isTerminalLpSequence,
  lpStepDecisionId,
  type LpSequenceKind,
  type LpSequenceRecord,
} from "../store/lpSequences.js";

/**
 * PHASE3.24 R2.12a-c — the shared, exhaustive ambiguity-door table.
 *
 * `resolve-then-abandon` means the kind's UNKNOWN can first use the existing
 * owner resolver; `declared-ambiguity-abandon` is the grid-shift exception.
 * `none` means product text must not recommend abandon for that ambiguity.
 */
export const LP_AMBIGUITY_WIND_DOWN_DOOR: Readonly<Record<
  LpSequenceKind,
  "resolve-then-abandon" | "declared-ambiguity-abandon" | "none"
>> = {
  protect: "resolve-then-abandon",
  rotate: "none",
  harvest: "resolve-then-abandon",
  open: "none",
  "manual-exit": "resolve-then-abandon",
  "grid-flip": "none",
  "grid-arm": "none",
  "grid-requote": "none",
  "grid-recenter": "none",
  "grid-shift": "declared-ambiguity-abandon",
};

/** AUDIT A4: the one kind whose actual abandon guard admits declared ambiguity. */
export const DECLARED_AMBIGUITY_ABANDON_SEQUENCE_KIND: LpSequenceKind = "grid-shift";

/** Journal states a sequence may be abandoned THROUGH. */
const SETTLED_STATES: ReadonlySet<JournalState> = new Set<JournalState>([
  "COMMITTED",
  "ROLLED_BACK",
]);

/**
 * States that BLOCK an abandon, each with the tool that owns it.
 *
 * REVIEW M3: the first draft refused whenever "a row exists", which made this
 * action and `resolveUnknown` jointly INCOMPLETE rather than disjoint — a
 * sequence whose last row is `ROLLED_BACK` (the ordinary product of a transient
 * attempt, a late kill-switch roll-back, a `DAILY_CAP` re-check or a preflight
 * refusal) was refused by both. A settled row no longer disqualifies anything.
 */
const BLOCKING_STATE_ADVICE: Readonly<Partial<Record<JournalState, string>>> = {
  UNKNOWN:
    "resolve it with the owner-signed resolveUnknown action, which is the tool for an ambiguous submission",
  PENDING:
    "wait for a reconcile pass to settle it — note that PHASE3.7 F1 skips rows younger than the age guard, so this may need a couple of minutes",
  IN_PROGRESS:
    "wait for a reconcile pass to settle it — note that PHASE3.7 F1 skips rows younger than the age guard, so this may need a couple of minutes",
};

export type LpAbandonRefusalCode =
  | "sequence_terminal"
  | "sequence_active"
  | "sequence_too_fresh"
  | "step_not_settled"
  | "step_in_flight";

/**
 * What the route must do to the position row.
 *
 * `restore-open` mirrors `resolveUnknown`'s own handling of an interrupted
 * exit (AUDIT A8): a `closing` position whose `zap-out` never committed still
 * holds its liquidity, and leaving it `closing` strands it — the worker skips
 * it and no exit will ever finish it.
 */
export type LpAbandonPositionAction = "close" | "restore-open" | "leave";

/**
 * Step kinds that REMOVE liquidity from the position.
 *
 * A committed one means the principal is out and the NFT is empty, whatever the
 * sequence's recovery label says (AUDIT A2).
 *
 * EXPORTED since PHASE3.14 F2.3, so `resolveUnknown`'s `advance` disposition
 * asks the same question from the same table. Before that it hardcoded
 * `closePosition: true` because `advance` was built for `zap-out` and nothing
 * else could reach it; with a relay CONFIRMED able to advance a
 * `zap-in-increase`, hardcoding would close a position that still holds its
 * liquidity. A2 wrote this set for exactly this class of mistake — do not key
 * the question on `recoveryState`, which is a proxy and is wrong.
 */
export const LIQUIDITY_REMOVING_STEPS: ReadonlySet<string> = new Set(["zap-out"]);

export type LpAbandonCheck = {
  readonly name: string;
  readonly result: string;
};

export type LpAbandonVerdict =
  | {
      readonly ok: true;
      /** Every recorded step and the state it settled in, for the receipt. */
      readonly checks: readonly LpAbandonCheck[];
      /**
       * What to do with the position row.
       *
       * AUDIT A2 rewrote this. The first version keyed on `recoveryState ===
       * "pending-mint"`, which is a PROXY and the proxy is wrong: a rotate sets
       * `pending-mint` after its `zap-out` (`sagas.ts:2399`) and then
       * OVERWRITES it with `wbnb-stranded` after the sweep (`:2468`) — the same
       * physical state, an emptied NFT, under a different label. A rotate held
       * one step later was therefore left `open` with its pre-rotate basis and
       * stayed in the worker's list: the −100 % PnL protect against an empty NFT
       * that this disposition exists to prevent.
       *
       * `harvest` overloads `wbnb-stranded` to mean something else entirely —
       * fees stranded, position INTACT — so no recovery state can answer this.
       *
       * What answers it is direct evidence: **did a liquidity-REMOVING step
       * commit?** That is inspectable per sequence, it means the same thing for
       * every kind, and it cannot be overwritten by a later step's label.
       */
      readonly positionAction: LpAbandonPositionAction;
      /**
       * WHICH rows {@link positionAction} governs — and the answer is NOT always
       * "all of them".
       *
       * PHASE3.17 R2.3 made the disposition group-wide so a dual arm's two rows
       * could never diverge, and that is right for the sequences whose PLAN
       * touches the whole group: a grid-arm mints both rungs in one submission,
       * a grid-shift moves both in one twelve-call batch. It is WRONG for every
       * sequence that targets ONE position, and it was measured costing a live
       * rung on 2026-09-03: a manual-exit of the SELL rung of a dual grid (agent
       * grid-agent-01-2) was abandoned after its zap-out committed, the group
       * loop closed BOTH rows, and NFT 7316794 was left holding
       * 198529011719679442645 of liquidity while the plane reported it closed
       * and the owner revoked the session out from under it.
       *
       * A single-position sequence carries NO evidence about its sibling — it
       * never read it, never submitted for it, and cannot have emptied it — so
       * closing it is an assertion the verdict has no grounds for.
       */
      readonly positionScope: LpAbandonPositionScope;
      /**
       * PHASE3.22 R3.2 / R4.3 — an owner-facing sentence this verdict OWES the
       * caller, or absent.
       *
       * Only the two `grid-shift` dispositions produce one, and they must: both
       * hand back a pair of NFTs the plane can no longer account for, and the
       * owner has to be told which they are and what to do. Every other
       * disposition's story is fully told by `checks` plus the route's own
       * standing note, so they leave this absent and the route's response is
       * byte-identical to what it was.
       */
      readonly note?: string;
    }
  | {
      readonly ok: false;
      readonly code: LpAbandonRefusalCode;
      readonly message: string;
      readonly checks: readonly LpAbandonCheck[];
    };

/**
 * Whether a disposition governs the whole arm group or only this sequence's own
 * position. Keyed on the sequence KIND, because the kind is what says how many
 * positions the plan could have touched — never on the state it happens to be in.
 */
export type LpAbandonPositionScope = "group" | "position";

/**
 * The kinds whose plan is group-wide. `grid-arm` mints both rungs of a dual arm
 * in one submission and its rollback closes both; `grid-shift` re-ranges up to
 * two rungs in one atomic batch. Everything else — every exit, every harvest,
 * every rotate, and each of the flip-shaped motions — targets exactly one
 * position by construction.
 */
export function abandonPositionScopeFor(
  kind: LpSequenceKind,
): LpAbandonPositionScope {
  return kind === "grid-arm" || kind === "grid-shift" ? "group" : "position";
}

export type LpAbandonInput = {
  readonly sequence: LpSequenceRecord;
  /**
   * Journal rows for this sequence, keyed by idempotency key. `null` means the
   * caller LOOKED and found nothing, which is itself the evidence.
   *
   * AUDIT A4: a MISSING key is not the same claim and must never be read as
   * one. The first version did `get(...) ?? null`, which silently turned "the
   * caller forgot to look" into "there is no row" — and "there is no row" is
   * exactly what licenses an abandon. That is the FINDINGS (ap-1) shape, where a
   * guard read absence as an answer. A missing key now THROWS.
   */
  readonly stepRows: ReadonlyMap<string, JournalEntry | null>;
  /** The row at `lpStepDecisionId(sequenceId, steps.length)`, or `null`. */
  readonly nextIndexRow: JournalEntry | null;
  /** The position row's current state, for the disposition. */
  readonly positionState: "open" | "closing" | "closed";
  /**
   * PHASE3.17 R2.3 — the OTHER rows of this position's dual-arm group, resolved
   * by the caller from `arm_group_id` on the ROW.
   *
   * A dual arm's two rows are funded by ONE submission and are therefore
   * never-funded or funded TOGETHER; a disposition that reached only the row the
   * sequence happens to name would strand the other `open` with a null tokenId —
   * invisible to the worker, unreachable by any exit, and enough to make every
   * future re-arm refuse for ever (review B1).
   *
   * Empty for every non-dual sequence, which is every sequence before 3.17. It
   * does not change the VERDICT — only what the verdict is applied to — so it is
   * reported in the check list rather than consulted by any gate.
   */
  readonly armGroupPositionIds?: readonly string[];
  /** Server clock, epoch ms. */
  readonly nowMs: number;
  /**
   * How long the sequence must have been IDLE (AUDIT A3). One worker interval:
   * a `held` sequence is RESUMED every cycle, and the resume marks it active
   * before recording anything, so a request landing inside that window can
   * abandon a sequence whose next submit is the very next statement.
   */
  readonly minIdleMs: number;
  /**
   * PHASE3.22 R5.4 / D4(b) — the stall-latch threshold, PASSED IN.
   *
   * Tier 2 of the COMMITTED `grid-shift` abandon (R4.3) opens once the 3.11
   * stall latch has quiesced the row, i.e. `sequence.stallCount >=` this. The
   * count is on the record already; the THRESHOLD is
   * `LP_STALL_LATCH_ATTEMPTS`, which lives in `src/lp/worker.ts` — and this
   * module is PURE and IO-free by design and MUST NOT import the worker. So it
   * arrives as an input beside {@link minIdleMs}, which is the same shape and
   * the same reason: a worker constant the pure verifier needs but must not
   * reach for.
   *
   * OPTIONAL so every existing caller and every existing test is unchanged.
   * Absent means tier 2 NEVER OPENS — the fail-closed direction, since tier 2
   * is a last-resort door that discards the plane's account of two NFTs, and a
   * caller that did not supply the threshold has not decided that it should.
   */
  readonly stallLatchAttempts?: number;
  /**
   * PHASE3.22 R3.2 — the arm group's tokenIds, positionally aligned with
   * {@link armGroupPositionIds}, for the declared-ambiguity note.
   *
   * The note must NAME the NFTs the owner has to go and look at, and this pure
   * function cannot read them. `null` entries are rows with no NFT (a
   * never-funded arm, a depleted side awaiting re-open) and are simply not
   * named. Absent for every non-shift caller.
   */
  readonly armGroupTokenIds?: readonly (string | null)[];
};

/**
 * Decide whether `sequence` may be abandoned, recording every check.
 *
 * Pure: it performs no IO and reads no clock, so the route can gather rows
 * once and the tests can state a whole situation as data.
 */
export function verifyLpAbandonSequence(
  input: LpAbandonInput,
): LpAbandonVerdict {
  const checks: LpAbandonCheck[] = [];
  const { sequence } = input;

  const refuse = (
    code: LpAbandonRefusalCode,
    message: string,
  ): LpAbandonVerdict => {
    checks.push({ name: `refused:${code}`, result: message });
    return { ok: false, code, message, checks };
  };

  /* --- (a) there is something to abandon --------------------------------- */

  if (isTerminalLpSequence(sequence.state, sequence.recoveryState)) {
    return refuse(
      "sequence_terminal",
      `The sequence is already terminal (${sequence.state}/${sequence.recoveryState}); it blocks nothing and there is nothing to abandon.`,
    );
  }
  // AUDIT A3. An `active` sequence is one a saga is DRIVING right now, and the
  // predicate below reads only settled rows — so between the worker's resume
  // and its first `appendStep` this would accept, assert "never submitted"
  // about a step whose submit is the next statement, and leave the saga to
  // throw `Illegal LP sequence transition rolled-back -> completed` later.
  // Only a HELD sequence, or the route's atomically-claimed `abandoning`
  // snapshot, is verifiable. A stuck `active` one becomes held on the next
  // worker cycle, which is the same instruction the refusal gives.
  if (sequence.state !== "held" && sequence.state !== "abandoning") {
    return refuse(
      "sequence_active",
      // PHASE3.11 F3. This sentence used to end "Run one worker cycle: a
      // sequence that cannot progress is HELD by it", which was false for
      // every hold whose recovery marker was still `none` — the exact state
      // the live incident was stuck in, and the advice the operator followed
      // for thirty minutes of cycles that could never satisfy it. State the
      // precondition the code actually has, and name the diagnostic.
      `The sequence is ${sequence.state}; only a HELD sequence under the route's atomic abandon claim may be abandoned, because an active one may be mid-drive with a submit already planned. A worker cycle parks it as HELD only once a COMMITTED step names where the funds sit; while its steps are still unsettled it stays ${sequence.state}. Run \`live-lp status\` to see which step is outstanding.`,
    );
  }
  if (input.nowMs - sequence.updatedAt < input.minIdleMs) {
    return refuse(
      "sequence_too_fresh",
      `The sequence was written ${input.nowMs - sequence.updatedAt}ms ago and must be idle for ${input.minIdleMs}ms (one worker interval). A worker resuming it right now would race this abandon.`,
    );
  }
  checks.push({
    name: "sequence-state",
    result: `${sequence.kind} (${sequence.state}/${sequence.recoveryState}), idle ${input.nowMs - sequence.updatedAt}ms`,
  });

  // R2.1: all attempts belong to one atomic plan position; none is discarded.
  if (sequence.kind === "rotate" && sequence.recoveryState === "rotate-ambiguous") {
    if (!sequence.steps.some(step => step.kind === "rotate-atomic")) {
      return refuse("step_not_settled", "This history is not an atomic rotate; legacy ambiguity has no abandon door.");
    }
    if (input.nextIndexRow !== null) return refuse("step_in_flight", "A journal row exists at the next attempt index.");
    let unsettled = false, committed = false, clean = true;
    for (const step of sequence.steps) {
      if (!input.stepRows.has(step.journalIdempotencyKey)) throw new Error("Atomic rotate abandon requires every attempt lookup.");
      const row = input.stepRows.get(step.journalIdempotencyKey) ?? null;
      checks.push({ name: "atomic-attempt-" + step.index, result: row?.state ?? "absent-before-begin" });
      if (step.kind !== "rotate-atomic" && row !== null && row.state !== "ROLLED_BACK") {
        return refuse("step_not_settled", "A live legacy or unsupported attempt cannot use the atomic abandon door.");
      }
      if (row === null) continue;
      committed ||= row.state === "COMMITTED";
      unsettled ||= !SETTLED_STATES.has(row.state);
      clean &&= row.state === "ROLLED_BACK" && row.externalRef.callsId === undefined && row.externalRef.txHash === undefined && row.externalRef.resolution === undefined;
    }
    checks.push({ name: "next-index", result: "absent" });
    if (committed && (input.stallLatchAttempts === undefined || input.stallLatchAttempts <= 0 || sequence.stallCount < input.stallLatchAttempts)) {
      return refuse("step_not_settled", "The atomic rotate COMMITTED; let the worker replay its finish. Last-resort abandon requires the existing stall threshold.");
    }
    if (unsettled || committed) {
      if (sequence.priorTokenId == null) return refuse("step_not_settled", "The atomic rotate has no durable prior NFT identity.");
      return { ok: true, checks, positionAction: "close", positionScope: "position",
        note: "Atomic rotate management relinquished due to " + (committed ? "a stalled confirmed finish" : "an unconfirmed submission")
          + ". Known old NFT " + sequence.priorTokenId + "; a replacement NFT MAY exist in your wallet. "
          + "This managed position is CLOSED. The journal outcome is unchanged and a pending submission may still land. Find and recover the funded NFT manually in the PancakeSwap UI." };
    }
    if (!clean) return refuse("step_not_settled", "The atomic attempt history is not proven clean (submission evidence remains).");
    return { ok: true, checks, positionAction: input.positionState === "closing" ? "restore-open" : "leave", positionScope: "position" };
  }

  /* --- (a2) PHASE3.22 — the grid-shift DECLARED-AMBIGUITY arm ------------- */
  //
  // ─── WHY IT IS *HERE*, ahead of check (b) (REVIEW4 D1, correcting R4.5 L4)
  //
  // R4.5 L4 put this arm in the disposition ternary at the bottom of the
  // function. That location is UNREACHABLE for the state it exists to serve:
  // check (b) below refuses `step_not_settled` for any journal row outside
  // `SETTLED_STATES` (= {COMMITTED, ROLLED_BACK}) and RETURNS, so an owner
  // signing an abandon on a `held` + `shift-ambiguous` sequence whose one step
  // row is UNKNOWN would be refused before the ternary was ever evaluated.
  // D1's finding, verbatim: "P1's blocker is closed at three of four doors and
  // still open at the fourth — which is the only one R3.2 promised."
  //
  // ─── WHY THE STATE PREDICATE COVERS PENDING AND IN_PROGRESS TOO ──────────
  //
  // Not hypothetical. FINDINGS/3.14 recorded the BSC relay answering
  // `{"status":300,"receipts":[]}`, which `toCallsStatusReceipt` maps to
  // PENDING — and `grid-shift` has NO in-plane resolver (R2.5), so nothing will
  // ever drive that row to UNKNOWN on its own. A predicate that named only
  // UNKNOWN would re-create the doorless state one relay quirk later. The arm
  // therefore covers every NON-SETTLED state, which is the complement of
  // `SETTLED_STATES` and is written as such rather than as a list.
  //
  // ─── WHAT IT DOES *NOT* DO ──────────────────────────────────────────────
  //
  // It does not touch `SETTLED_STATES` and it relaxes NOTHING for any other
  // kind: the `sequence.kind === "grid-shift"` guard is the whole of its
  // scope. The audit's named mutation target is "flip the kind guard and watch
  // a `rotate` with an UNKNOWN `zap-out` become abandonable" — that mutation
  // must be killed by a test, because a rotate abandoned mid-zap-out strands
  // the principal, which is exactly what check (b) exists to prevent.
  //
  // ─── THE DISPOSITION, and why CLOSE rather than leave ───────────────────
  //
  // `positionAction: "close"`, applied GROUP-WIDE through the existing 3.17
  // `armGroupPositionIds` path. Closing is what makes the restart REAL: the
  // arm's idle gate refuses on any non-closed row, so leaving the pair open
  // would wedge the owner with no in-product remedy — the same trap 3.16's H3
  // found for an abandoned `grid-arm`. The module's safety sentence ("a row
  // exists ⇒ a submit MAY have happened") is not weakened here; it is SAID OUT
  // LOUD in the note instead of being used to refuse.
  if (
    sequence.kind === DECLARED_AMBIGUITY_ABANDON_SEQUENCE_KIND
    && sequence.steps.length > 0
  ) {
    // A shift's plan is ONE step (`LP_SAGA_PLANS["grid-shift"]`), so "the
    // single recorded step row" is `steps[0]`. Written as an explicit index
    // rather than a scan so that a future multi-step shift fails loudly here
    // instead of silently judging the pair on its first step.
    const only = sequence.steps[0];
    if (only !== undefined) {
      if (!input.stepRows.has(only.journalIdempotencyKey)) {
        // The same rule check (b) enforces: an unlooked-up key is not evidence.
        throw new Error(
          `abandonSequence: no journal lookup was performed for step 0 (${only.kind}); refusing to treat a missing lookup as a missing row.`,
        );
      }
      const row = input.stepRows.get(only.journalIdempotencyKey) ?? null;
      const named = (input.armGroupTokenIds ?? [])
        .filter((id): id is string => id !== null)
        .join(" and ");
      const nfts = named === "" ? "the NFTs it touched" : `NFTs ${named}`;
      if (row !== null && !SETTLED_STATES.has(row.state)) {
        checks.push({
          name: `step-0-${only.kind}`,
          result: `${row.state} — DECLARED AMBIGUITY: the batch may or may not have landed, and no in-plane resolver can decide it for this kind`,
        });
        return {
          ok: true,
          checks,
          positionAction: "close",
          positionScope: abandonPositionScopeFor(sequence.kind),
          note:
            `The grid-shift batch may or may not have landed. Every NFT it touched — ${nfts}, `
            + `and up to two it may have minted — sits in YOUR OWN wallet (EIP-7702: the plane never held them). `
            + `Both rows of this ladder are now CLOSED so you can re-arm. `
            + `Close by hand on PancakeSwap whichever still hold liquidity, then sign gridArm again.`,
        };
      }
      // ─── TIER 1 / TIER 2 for a COMMITTED shift (R4.3, softening R3.2's
      // unconditional refusal) ──────────────────────────────────────────────
      //
      // The batch LANDED. The finish is idempotently re-runnable (R2.26) — it
      // re-reads the receipt via the journal's txHash, re-verifies both ids and
      // applies whichever row is stale — so the remedy is the RESUME, and
      // abandoning here would ORPHAN both freshly minted NFTs (REVIEW2 N4).
      //
      // TIER 1 is therefore a refusal. But R4.3 softened it, because a
      // PERMANENTLY failing finish — a fail-closed `mintedTokenIds` dep, a
      // receipt-refusing pinned RPC (FINDINGS (ad)), a genuine id-assertion
      // anomaly — would otherwise be DOORLESS, which is the same defect one
      // state along. TIER 2 opens once the 3.11 stall latch has quiesced the
      // row, and it is an owner-signed LAST RESORT with the orphaning hazard
      // written into its note rather than a silent `"leave"` fall-through.
      //
      // Reachability, verified in REVIEW4 §C: a throw out of the step's `after`
      // hook becomes `holdSequence("POST_VERIFY_FAILED")`, `lpResumeStallCode`
      // yields the identical code every cycle, the worker latches it, three
      // identical stalls trip `shouldDeferStalledResume`, `updated_at` goes
      // quiescent and `minIdleMs` becomes satisfiable. That chain is why R5.4
      // pins the shift's position writes into `after` and NOT `input.finish`.
      if (row !== null && row.state === "COMMITTED") {
        const threshold = input.stallLatchAttempts;
        const quiesced =
          threshold !== undefined && sequence.stallCount >= threshold;
        if (!quiesced) {
          return refuse(
            "step_not_settled",
            `The grid-shift batch COMMITTED, so its targeted rung(s) moved and the finish still owes the corresponding position write(s). That finish is idempotently re-runnable: let the worker resume it rather than abandoning, which would orphan the NFTs it minted. If it never succeeds, this abandon opens as a last resort once the worker has stalled on it ${threshold ?? 3} times.`,
          );
        }
        const txHash = row.externalRef.txHash;
        checks.push({
          name: `step-0-${only.kind}`,
          result: `COMMITTED, and the resume has stalled ${sequence.stallCount} times (>= ${threshold}) — tier 2 last-resort abandon`,
        });
        return {
          ok: true,
          checks,
          positionAction: "close",
          positionScope: abandonPositionScopeFor(sequence.kind),
          note:
            `The grid-shift batch LANDED${txHash === undefined ? "" : ` (${txHash})`} and the finish never completed. `
            + `Every NFT it touched — ${nfts}, and the up to two it minted — sits in YOUR OWN wallet. `
            + `Both rows are now CLOSED so you can re-arm; the plane has NO record of the new tokenIds. `
            + `Find them on PancakeSwap, close by hand, then sign gridArm again.`,
        };
      }
      // A ROLLED_BACK row, or no row at all, falls through to checks (b)/(c)
      // and the ordinary disposition. That is correct and deliberate: a shift
      // whose batch FAILED moved nothing, `grid-shift` is not in
      // `LIQUIDITY_REMOVING_STEPS`, the kind is not `open`/`grid-arm`, and an
      // `open` position row is left alone — both rungs are exactly where they
      // were, which is the truth.
    }
  }

  /* --- (b) every RECORDED step is settled -------------------------------- */

  for (const [index, step] of sequence.steps.entries()) {
    if (!input.stepRows.has(step.journalIdempotencyKey)) {
      // Never `?? null`: see the field doc. An unlooked-up key is not evidence.
      throw new Error(
        `abandonSequence: no journal lookup was performed for step ${index} (${step.kind}); refusing to treat a missing lookup as a missing row.`,
      );
    }
    const row = input.stepRows.get(step.journalIdempotencyKey) ?? null;
    if (row === null) {
      // A recorded step with no row: it died between `appendStep` and `begin`,
      // so it never submitted either. Settled by absence.
      checks.push({
        name: `step-${index}-${step.kind}`,
        result:
          "no journal row observed after the recorded step; the plane writes a row before every submit, so this step was never submitted",
      });
      continue;
    }
    if (!SETTLED_STATES.has(row.state)) {
      const advice =
        BLOCKING_STATE_ADVICE[row.state] ?? "it must reach a terminal state first";
      return refuse(
        "step_not_settled",
        `Step ${index} (${step.kind}) holds a ${row.state} journal row, so this sequence may have an unsettled submission. Abandoning it here would drop that question rather than answer it — ${advice}.`,
      );
    }
    checks.push({
      name: `step-${index}-${step.kind}`,
      result: row.state,
    });
  }

  /* --- (c) nothing has started at the NEXT index ------------------------- */

  if (input.nextIndexRow !== null) {
    return refuse(
      "step_in_flight",
      `A journal row already exists at ${lpStepDecisionId(sequence.sequenceId, sequence.steps.length)} (state ${input.nextIndexRow.state}), so a saga is mid-flight on this sequence. Retry once it settles.`,
    );
  }
  checks.push({
    name: "next-index",
    result: `${lpStepDecisionId(sequence.sequenceId, sequence.steps.length)} absent — no row was observed at the next index`,
  });

  /* --- disposition -------------------------------------------------------- */

  const removedLiquidity = sequence.steps.some(
    (step) =>
      LIQUIDITY_REMOVING_STEPS.has(step.kind) &&
      input.stepRows.get(step.journalIdempotencyKey)?.state === "COMMITTED",
  );
  const positionAction: LpAbandonPositionAction = removedLiquidity
    ? "close"
    : sequence.kind === "open" || sequence.kind === "grid-arm"
      ? // The open never funded the lineage. Its own rollback already closes
        // the row (`open.ts:236-240`); an abandon must not leave a row that
        // rollback would have closed.
        //
        // PHASE3.16 (review H3): `grid-arm` joins it on the SAME reasoning
        // verbatim — the arm's mint is the whole plan, so a sequence with no
        // committed mint never funded the lineage, and the arm's own rollback
        // (the same `runLpOpen` rollback) would have closed the row.
        //
        // WITHOUT this membership an abandoned arm would take `"leave"` and
        // strand a phantom `state: "open"` row with `tokenId: null`: the worker
        // skips it every cycle, no exit can reach it (an exit needs a tokenId),
        // and the re-arm precondition — no non-closed position — becomes
        // permanently unsatisfiable. The owner would be wedged with no
        // in-product remedy, in the phase whose whole purpose is to make the
        // restart path "sign gridArm again".
        "close"
      : input.positionState === "closing"
        ? "restore-open"
        : "leave";

  checks.push({
    name: "position-disposition",
    result:
      positionAction === "close"
        ? removedLiquidity
          ? "CLOSE — a zap-out COMMITTED, so the principal is out and the NFT is empty"
          : `CLOSE — an abandoned ${sequence.kind === "grid-arm" ? "grid arm" : "open"} never funded the lineage`
        : positionAction === "restore-open"
          ? "RESTORE to open — the exit never removed liquidity, and a closing row is skipped by the worker for ever"
          : `leave as-is (position ${input.positionState}, no liquidity-removing step committed)`,
  });
  // PHASE3.17 R2.3: what the disposition is applied TO, when the row belongs to
  // a dual arm's group. Recorded rather than gated on — the verdict is about the
  // SEQUENCE, and both rows share its one submission by construction.
  const siblings = (input.armGroupPositionIds ?? []).filter(
    (id) => id !== sequence.positionId,
  );
  if (siblings.length > 0) {
    checks.push({
      name: "arm-group",
      result:
        `${positionAction === "leave" ? "no disposition to apply" : `apply "${positionAction}" to`} `
        + `${siblings.length} sibling row(s) of this dual arm (${siblings.join(", ")}) — one submission `
        + `funded both, so one disposition governs both`,
    });
  }

  return {
    ok: true,
    checks,
    positionAction,
    positionScope: abandonPositionScopeFor(sequence.kind),
  };
}

/** Kind-only legacy policy stays closed; the persisted atomic shape opens its specific door. */
export function lpAmbiguityWindDownDoor(sequence: Pick<LpSequenceRecord, "kind" | "recoveryState" | "steps">): "resolve-then-abandon" | "declared-ambiguity-abandon" | "none" {
  if (sequence.kind === "rotate" && sequence.recoveryState === "rotate-ambiguous" && sequence.steps.some(step => step.kind === "rotate-atomic")) return "declared-ambiguity-abandon";
  return LP_AMBIGUITY_WIND_DOWN_DOOR[sequence.kind];
}

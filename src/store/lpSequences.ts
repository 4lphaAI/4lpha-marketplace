/**
 * LP sequence/position store (PHASE3-SPEC "Sequence journal"; Revision 2 items
 * 9–13, 16–17, 40; PHASE3-REVIEW R3/R4/R6/R7).
 *
 * Ports the DISCIPLINE of the 0G LP sequence journal
 * (`D:\4lpha-0G\lib\agent\lp\lp-sequence-journal.ts`) — one non-terminal
 * sequence per position, reservation-before-money, recovery states that keep a
 * held sequence resumable — NOT its schema or its file/PID locking. This store
 * is DB-backed (Memory + Postgres over one interface) like everything else in
 * this repo, and every query is owner-scoped: a cross-tenant read returns
 * `null`, indistinguishable from "no such row".
 *
 * DIVISION OF AUTHORITY (Rev2 item 9, NORMATIVE): the EXECUTION JOURNAL is the
 * single authority on step OUTCOMES; this store is the authority on ORDER and
 * RESUME. A step here records only its identity — index, kind, the journal
 * idempotency key, and the pinned decision id `lp:<sequenceId>:<stepIndex>` —
 * and NEVER an outcome. This module does not import the journal (not even its
 * types): {@link deriveLpSequenceProgress} takes the journal's answers as
 * INPUT and joins, so there is no code path by which this store could
 * re-derive or shadow a submit outcome.
 */
import { randomUUID } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { MAX_TICK, MIN_TICK } from "../lp/tickMath.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import type {
  LpSettingsRecord,
  LpSettingsStore,
  PutLpSettingsInput,
} from "./lpSettings.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

/** Rolling quota window for exit reservations (Rev2 item 11). */
const ROLLING_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The partial unique index that makes "one non-closed row per NFT" true
 * (PHASE3.4 Rev2 M5). Named once so the DDL and the error mapper cannot drift.
 */
export const LP_LIVE_TOKEN_INDEX_NAME = "lp_positions_one_live_token_idx";

/**
 * WBNB on BNB Chain 56 — the default `quoteToken` (Rev2 upgrade seam:
 * "Non-WBNB-leg pools / stable basis" widens this later as a data change).
 * Literal rather than an import from `src/ops/venues.ts` so the store layer
 * stays free of ops-layer imports; the value is pinned by test.
 */
export const DEFAULT_QUOTE_TOKEN: Address = getAddress(
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
);

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Lifecycle of a position row. `closing` = an exit saga is in flight. */
export type LpPositionState = "open" | "closing" | "closed";

/**
 * Where a lineage basis came from.
 *
 * `"owner-budget"` — the owner-signed budget at `/lp/open` (R7). The plane
 * METERED this number: it is what the mint attached, in native wei.
 *
 * `"imported"` — PHASE3.4. The owner's own DECLARATION about a position this
 * plane did not create, at `POST /agents/:id/lp/import`. Writing
 * `"owner-budget"` for it would claim a budget that was never spent, in the one
 * field an audit reads to find out where a stop-loss threshold came from. The
 * distinction is also load-bearing at `/lp/settings`: the sizing invariant's
 * budget term models the open's `mint{value}` and nothing else, so an imported
 * basis must not enter it (PHASE3.4 Rev2 M12, `checkLpNativeCapSizing`).
 *
 * `basis_source` carries NO CHECK constraint in the DDL, which is why adding a
 * member is additive with no migration.
 *
 * `"minted"` — PHASE3.16 (ruling Q2). The GRID ARM: this plane minted the
 * position and there is NO basis, because a ping-pong's inventory alternates
 * assets and a lineage-basis TP/SL would misfire on it (3.15's `basisWei` must
 * be 0 rule, unchanged). Neither existing member is honest for it:
 * `"owner-budget"` asserts the plane METERED the number, and the number is
 * zero while the mint attached `budgetWei`; `"imported"` asserts a position
 * this plane did not create, and the arm creates it. Recording either would be
 * exactly the failure class `"imported"` was added to prevent.
 *
 * UNIFIED VOCABULARY (done when `src/lp/sagas.ts` landed): `src/lp/triggers.ts`
 * `LpBasisSource` names these same sources — one name across both modules, so
 * the saga layer feeds the persisted value to the evaluator verbatim, with no
 * mapping to drift. `"minted"` was TYPED there from the start for exactly this
 * future source, so this addition needs no mapping either.
 */
export type LpLineageBasisSource = "owner-budget" | "imported" | "minted";

/**
 * PHASE3.18 R2.6 — the durable grid identity's value types.
 *
 * Declared HERE and shared VERBATIM with `src/lp/triggers.ts`'
 * `LpGridLevelValue`/`LpGridRoleValue`, on the `LpLineageBasisSource`
 * precedent: this module deliberately imports nothing from `src/lp`, so the
 * store stays a store. The two spellings are structurally identical, so the
 * saga layer passes persisted values through with no mapping — and a mapping is
 * exactly what the basis-source docstring above records as the thing worth not
 * having.
 */
export type LpGridLevelValue = 1 | 2;
export type LpGridRoleValue = "buy" | "sell";

/** One saga run kind. `open` and `manual-exit` are owner-signed routes. */
export type LpSequenceKind =
  | "protect"
  | "rotate"
  | "harvest"
  | "open"
  | "manual-exit"
  /**
   * PHASE3.15 — the grid ping-pong's ONE money sequence: settle the filled
   * level and re-mint single-sided into the opposite SIGNED range.
   *
   * Its STEP kinds are reused verbatim (`zap-out`, `sweep-token`,
   * `zap-in-mint`), so `LIQUIDITY_REMOVING_STEPS`, the abandon verifier and
   * `resolveUnknown`'s kind-aware advance all read it correctly with no map
   * entry. Adding this member to the union is what makes
   * `worker.ts`'s `resumeSequence` switch a COMPILE ERROR until its arm exists.
   *
   * It is deliberately NOT in `RESOLVABLE_SEQUENCE_KINDS`: a mid-flip UNKNOWN
   * has the principal out of the position and retrying would risk a second
   * mint, which is the exact sentence `resolveUnknown` already refuses `rotate`
   * with. The operator path is the stall latch quiescing the row and then an
   * owner-signed abandon (R2.4).
   */
  | "grid-flip"
  /**
   * PHASE3.16 — the AUTONOMOUS GRID ARM's one-step sequence: wrap the owner's
   * signed native budget and mint the first level single-sided into the signed
   * `buyRange`. It is driven by `runLpOpen` (ruling D1/option (a)), not by
   * `driveSequence`, for two reasons that decide it:
   *
   *  - `runLpOpen`'s worker resume structurally CANNOT re-drive. An arm's range
   *    is derivable only against a FRESH tick and its budget is not persisted
   *    at all (`basisWei` is 0), so a re-drive would mint into a range the
   *    owner never signed at this price with a budget the plane invented;
   *  - `runLpOpen`'s rollback CLOSES the never-funded position row, and every
   *    arm refusal must leave a closed row or the re-arm precondition is
   *    unreachable for ever.
   *
   * Its STEP kind is `zap-in-mint`, reused verbatim: outside
   * {@link LIQUIDITY_REMOVING_STEPS} (so an abandoned arm is never misread as
   * "the principal is already out"), rendered by every existing surface, and
   * read correctly by `resolveUnknown`'s kind-aware advance with no map entry.
   *
   * Like `grid-flip` it is deliberately NOT in `RESOLVABLE_SEQUENCE_KINDS`, and
   * an UNKNOWN arm is in fact refused EARLIER than the kind check — at
   * `native_spend`, because the step row carries `nativeSpendWei = budgetWei`.
   */
  | "grid-arm"
  /**
   * PHASE3.18 — the GRID REQUOTE: re-centre an UNFILLED level on its OWN side,
   * at the signed policy's distance from the fresh tick. Same asset, no swap,
   * no conversion.
   *
   * Its STEP kinds are the flip's, reused verbatim (`zap-out`, `sweep-token`,
   * `zap-in-mint`), and its plan is flip-SHAPED — so `LIQUIDITY_REMOVING_STEPS`,
   * the abandon verifier, the crash matrix, the `pending-mint` hold semantics
   * and the stall latch all carry over with NO new recovery machinery.
   *
   * Deliberately NOT in `RESOLVABLE_SEQUENCE_KINDS`, for the reason `grid-flip`
   * is not: an UNKNOWN mid-requote has the principal out of the position and
   * retrying would risk a second mint.
   *
   * Its QUOTA LANE IS ITS OWN (`grid.requote.maxRequotesPerDay`) — ruling Q6,
   * decided on SAFETY rather than on the measured mix: a flip settles a fill
   * that already happened, a requote is discretionary, and a shared lane lets
   * re-centres starve settlements.
   */
  | "grid-requote"
  /**
   * PHASE3.19 item 32 — the LADDER's ONE motion: re-anchor THIS rung at
   * `anchor +/- ladder.gapTicks` from the fresh tick, funded from the idle
   * BUFFER, with an optional profit-gated hedge in the middle.
   *
   * Its STEP kinds are the flip's, reused VERBATIM (`zap-out`, `sweep-token`,
   * `zap-in-mint`), and its plan is flip-SHAPED — so
   * {@link LIQUIDITY_REMOVING_STEPS} needs NO change (it keys on the STEP kind
   * `"zap-out"`, which this plan shares), and the abandon verifier, the 3.11
   * crash matrix, the `pending-mint` hold semantics and the stall latch all
   * carry over with NO new machinery. The middle step is deliberately
   * `"sweep-token"` and NOT a new `"hedge-swap"` kind: `LpStepKind` has no DB
   * CHECK so a member would be cheap in the store and expensive everywhere else
   * (the resolver's kind-aware advance, the abandon verifier's step table, the
   * crash matrix and `LP_SAGA_PLANS` all reason over step kinds). It BEHAVES
   * differently — it can fire, and its build reads a balance — but its KIND
   * should not.
   *
   * Deliberately NOT in `RESOLVABLE_SEQUENCE_KINDS` (item 33), for the reason
   * `grid-flip` and `grid-requote` are not: an UNKNOWN mid-motion has the
   * principal out of the position and retrying would risk a second mint.
   *
   * THE RESTART, corrected per L5 — and the correction is the half a reader
   * would otherwise inherit wrongly. The MINT half of the restart is genuinely
   * CHEAPER than 3.15's: abandon closes the row, the inventory is already in the
   * owner's own EOA as the buffer, and the next `gridArm` re-places from it — no
   * hand-mint, no re-import. The HEDGE half is NOT: an UNKNOWN hedge leaves the
   * plane unable to know whether a market swap executed, and the VWAP book is
   * advanced ONLY from confirmed receipts, so an abandoned hedge leaves the book
   * UNTOUCHED and therefore STALE until the next confirmed motion corrects it.
   * That is the conservative direction — the ladder under-reports acquired
   * inventory and hedges LESS eagerly — and it is a declared v1 residual.
   *
   * Its QUOTA LANE IS ITS OWN (`grid.ladder.maxMovesPerDay`), the FOURTH: a
   * ladder motion is neither a settlement nor a discretionary re-centre of an
   * unfilled rung, and a shared lane would let one starve the other.
   */
  | "grid-recenter"
  /**
   * PHASE3.22 R2.19 — THE TENTH KIND: the atomic ladder's ONE money sequence.
   *
   * A shift is the 3.19 ladder's motion collapsed into a SINGLE relay batch:
   * one or both targeted live rungs are zapped out and re-minted at ranges
   * re-derived from the current tick, seven or twelve calls, all-or-nothing. It has ONE step
   * (`kind: "grid-shift"`, R2.6) and therefore ONE submission, which is what
   * divides the ladder's modeled four-fee cost by four (§1c).
   *
   * ─── WHAT ITS ONE-STEP SHAPE COSTS, and how each cost is paid ─────────────
   *
   * Deliberately NOT in `RESOLVABLE_SEQUENCE_KINDS` (R2.5, upholding OQ3): the
   * resolver's `advance` verdict is two booleans keyed on
   * `LIQUIDITY_REMOVING_STEPS` and cannot write a tokenId, and there is no
   * honest value for a step that both REMOVES and ADDS liquidity. A
   * receipt-driven resolver (a `mintedTokenIds` corroboration parser plus a
   * per-kind disposition derived from the receipt) is DEFERRED to its own
   * phase with its own spec, review, build and audit.
   *
   * Because it has no resolver, its ambiguous states are given real doors
   * instead — and that is the whole of R4.1/R3.2/R4.3:
   *
   *  - the step's recovery label is `"shift-ambiguous"` (never `"none"`), so
   *    every ambiguous park writes `held` rather than the unabandonable
   *    `active` + `none`;
   *  - a NON-SETTLED step row (UNKNOWN, PENDING or IN_PROGRESS) is abandonable
   *    under a DECLARED-AMBIGUITY disposition that CLOSES both arm-group rows
   *    (R5.1);
   *  - a COMMITTED step row refuses abandon while the finish is still worth
   *    resuming, and opens a TIER-2 last-resort abandon once the 3.11 stall
   *    latch has quiesced the row (R4.3).
   *
   * PHASE3.25 R2.4/R5.3: its quota is kind-scoped and split into independent
   * persisted-cause lanes: `shift-settle` uses signed `shiftsPerDay`, while
   * `shift-drift` uses the signed budget/price-derived motion count. They share
   * only the agent-wide spacing gate.
   */
  | "grid-shift";

/**
 * Sequence lifecycle. `active` is the only state a saga drives forward;
 * `held` is a deliberately parked sequence, and whether it is TERMINAL
 * depends on its recovery state — see {@link isTerminalLpSequence}.
 */
export type LpSequenceState =
  | "active"
  | "completed"
  | "held"
  | "abandoning"
  | "resolving"
  | "retiring-pre-bind"
  | "rolled-back";

/**
 * Partial-completion recovery states (spec body). Each names WHERE the funds
 * sit so the next worker cycle can resume: `pending-mint` (zap-out confirmed,
 * mint not), `pending-increase` (collect confirmed, top-up not),
 * `wbnb-stranded` (sweep confirmed, tail failed). `none` means no recovery is
 * owed.
 */
export type LpRecoveryState =
  | "pending-mint"
  | "pending-increase"
  | "wbnb-stranded"
  /**
   * PHASE3.22 R4.1 / R5.2 (REVIEW3 P1, a BLOCKER) — THE AMBIGUOUS SHIFT.
   *
   * Unlike its three siblings this member does NOT name where funds sit. It
   * names that WE DO NOT KNOW whether they moved — which is the honest state
   * of a ONE-SUBMISSION saga between "a submit could have happened" and a
   * settled receipt.
   *
   * ─── WHY A NEW MEMBER AND NOT `"none"` ─────────────────────────────────────
   *
   * `holdSequence` writes `held` ONLY when `currentRecovery !== "none"`
   * (`src/lp/sagas.ts`, the only writer). With the shift step labelled
   * `"none"` — which is what the spec body's R12 said — an UNKNOWN submit, a
   * PENDING receipt and a POST_VERIFY_FAILED would ALL park `active` + `none`,
   * and that state is:
   *
   *   - unabandonable    (`sequence_active`, `abandonSequence.ts`),
   *   - unclaimable      (`claimSequenceForAbandon` claims `held` only, :2729),
   *   - invisible to the 3.11 stall latch (`shouldDeferStalledResume`).
   *
   * Three of four doors shut, and the fourth was the one R3.2 promised. A
   * durable non-`none` marker written BEFORE the submit opens all three.
   *
   * ─── THE TWO ORDERED WRITES (R5.3, correcting R4.1's atomicity claim) ──────
   *
   * `setRecoveryState("shift-ambiguous")` runs strictly BEFORE
   * `journal.beginWithSpend`. They are DIFFERENT STORES, so "the same durable
   * write" was never expressible; ordering is what is expressible and it is
   * what is required. On a terminal pre-submit rollback the marker is
   * DELIBERATELY LEFT SET: `isTerminalLpSequence` answers on the state alone
   * for `rolled-back` (:1030-1035) and the one-live-sequence index predicate
   * excludes `rolled-back` regardless of recovery label (:4366, :4900), so a
   * rolled-back row's recovery label decides nothing.
   *
   * Recorded bonus, and it is the intended direction: a crash between the
   * marker write and the submit now parks `held` on the next resume, which is
   * exactly the door the declared-ambiguity abandon needs.
   *
   * The step's `recoveryAfterConfirm` is this SAME value (R5.2 site 6), so a
   * POST_VERIFY_FAILED after the mints also parks `held` — which is what R5.4's
   * tier-2 abandon depends on. The completion path resets it to `none`,
   * exactly as `wbnb-stranded` does.
   */
  | "shift-ambiguous"
  | "rotate-ambiguous"
  | "none";

/**
 * The full step vocabulary from the spec body. The starred CAKE-phase kinds
 * (`stake`/`unstake`/`harvest-cake`) are typed NOW and deliberately carry no
 * enum CHECK in the DDL, so shipping them later is a code change, not a
 * migration.
 */
export type LpStepKind =
  | "rotate-atomic"
  | "zap-in-mint"
  | "zap-in-increase"
  | "zap-out"
  | "collect-fees"
  | "sweep-token"
  | "stake"
  | "unstake"
  | "harvest-cake"
  /**
   * PHASE3.22 R2.6 (review B3/H6) — the atomic ladder's ONE step.
   *
   * ─── WHY A NEW STEP KIND AND NOT A REUSED ONE ────────────────────────────
   *
   * Every existing grid motion reuses `zap-out`/`sweep-token`/`zap-in-mint`
   * verbatim, precisely so that `LIQUIDITY_REMOVING_STEPS`, the abandon
   * verifier and `resolveUnknown`'s kind-aware advance all read it correctly
   * with no map entry. A shift CANNOT do that: its single step both REMOVES
   * liquidity (two zap-outs) and ADDS it (up to two mints) in one submission,
   * so no existing kind describes it and every kind-keyed table would answer
   * WRONGLY rather than merely incompletely. The 3.19 ruling's cost — a new
   * kind means an explicit entry at every kind-keyed surface — is paid here
   * knowingly, and all four entries are written rather than inherited:
   *
   *  - `LIQUIDITY_REMOVING_STEPS`: **NOT a member.** The consequence is
   *    accepted and stated: `abandonSequence`'s disposition derivation cannot
   *    read a `grid-shift` step's kind to decide whether liquidity left the
   *    position, so it never tries — R5.1's explicit early branch answers
   *    first, and a `grid-shift` row is otherwise abandonable only where
   *    nothing was submitted or the submission FAILED.
   *  - `corroborateLandedStep`: NO parser in v1, and it is UNREACHABLE rather
   *    than missing — the kind is not resolvable, so `resolveUnknown` returns
   *    at its `RESOLVABLE_SEQUENCE_KINDS` gate long before corroboration. The
   *    pairing is pinned by comment at both sites so the DEFERRED resolver
   *    phase adds the parser and the membership together, never one alone.
   *  - `laterLandingResidual`: an EXPLICIT "no residual" entry carrying the
   *    same comment.
   *  - `LP_SAGA_PLANS`: `grid-shift` maps to the one-step plan
   *    `["grid-shift"]`.
   */
  | "grid-shift";

/**
 * One recorded step: identity only, NEVER an outcome (Rev2 item 9). The
 * outcome lives in the execution journal under `journalIdempotencyKey`, and
 * the journal's replay check finds it under `journalDecisionId`.
 */
export type LpSequenceStep = {
  readonly index: number;
  readonly kind: LpStepKind;
  readonly journalIdempotencyKey: string;
  /** Always `lp:<sequenceId>:<index>` — see {@link lpStepDecisionId}. */
  readonly journalDecisionId: string;
};

/**
 * A position row, keyed (ownerScope, agentId, positionId).
 *
 * LINEAGE (R7 + Rev2 items 17/40): `lineageId`/`basisWei`/`basisSource` are
 * keyed to the AGENT'S ALLOCATION, not to the pool or the NFT. A rotate
 * updates `tokenId` on the SAME lineage with the basis untouched (compounding
 * never raises it), so a lineage bleeding value across rotations still fires a
 * cumulative stop-loss. The basis resets only when protect or manual exit
 * CLOSES the lineage. Item 40's auto-migration seam is why `lineageId` is a
 * field rather than an alias of `positionId`: a future cross-pool migration
 * creates a new position row CARRYING the old `lineageId` and basis.
 */
export type LpPositionRecord = {
  readonly positionId: string;
  readonly agentId: string;
  /** Normalized (checksum-validated, lowered) owner scope key. */
  readonly ownerAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  /** Pancake V3 fee tier in millionths (100 | 500 | 2500 | 10000). */
  readonly fee: number;
  /** NFPM NFT id as a decimal string; `null` until the mint confirms. */
  readonly tokenId: string | null;
  readonly lineageId: string;
  /** TP/SL basis in wei of `quoteToken`. `0n` once the lineage is closed. */
  readonly basisWei: bigint;
  readonly basisSource: LpLineageBasisSource;
  /** The asset the basis is quoted in. Defaults to WBNB. */
  readonly quoteToken: Address;
  readonly state: LpPositionState;
  /**
   * Consecutive finalized `ownerOf` mismatches the worker has confirmed
   * (PHASE3.4 Rev2 M6). DURABLE, and that is the whole point: FINDINGS (ae) is
   * what a confirmation counter in process memory costs, and Phase 3.2 exists
   * because of it. A matching read resets this to 0; a read FAILURE touches
   * nothing (the `readers.positions` posture — an outage must never read as
   * "the NFT is gone").
   */
  readonly ownershipMismatchCount: number;
  /**
   * Why the worker believes this position's NFT is no longer the wallet's, or
   * `null`. Reported by `GET /agents/:id/lp` so the ownership answer reaches the
   * OWNER and not only the cycle log — PHASE3.3-AUDIT A3's failure class, which
   * import would otherwise recreate for a state it makes routine.
   */
  readonly ownershipLostReason: string | null;
  /**
   * PHASE3.22 R4.2.2 — WHY this row was closed, or `null`.
   *
   * ─── THE IDIOM, chosen and named (R4.2.2 left it to the build) ─────────────
   *
   * An ADDITIVE NULLABLE COLUMN modelled on {@link ownershipLostReason}
   * directly above, which is the shipped answer to the identical question
   * ("why does the plane believe this row reached this state, and how does the
   * OWNER find out?"). Positions carry no `note` column — only sequences do —
   * so the note idiom was not actually available; this is.
   *
   * The value shift mode writes is `"shift-depleted"`: the row's side fell
   * below its single-sided mint floor, so the motion proceeded one-sided, this
   * side's principal went into the buffer, and the row was closed rather than
   * left as a null-tokenId zombie (the shape REVIEW2 refuted and R4.2
   * replaced).
   *
   * IT IS NOT LOAD-BEARING FOR RECOVERY. R5.7 decided D7's question the OTHER
   * way: the abandon route's `restore-open` arm filters on `state !== "closed"`
   * rather than keying on this column, so a depleted row stays closed through
   * any later abandon-with-restore WITHOUT this column being read. What it is
   * for is the OWNER VIEW — R4.2.4 requires the view to say which of THREE
   * causes produced a one-sided pair (depletion, ownership loss, or an owner's
   * single-rung manual exit), and depletion is the one that had no marker.
   */
  readonly closeReason: string | null;
  /**
   * The FROZEN CYCLE CLOCK of the FIRST confirmation in the current run of
   * mismatches, or `null` (PHASE3.4-FIXREVIEW F1). Not refreshed while the
   * mismatch persists; cleared when a matching read resets the count.
   *
   * TWO properties, and the phase learned each the hard way:
   *
   * 1. it is the FIRST confirmation, not the last write. The separation gate
   *    used `updatedAt`, which the gate's own increment rewrites every cycle —
   *    so the measured gap was always `interval − δ` and the close could never
   *    fire on a healthy daemon;
   * 2. it is the CYCLE CLOCK, not this store's own `now()`. A write stamped at
   *    cycle start + δ compared against the next cycle's start still measures
   *    `interval − δ`. Both endpoints must be cycle-start stamps or δ never
   *    cancels — which is FINDINGS (af)'s lesson, in the other direction.
   */
  readonly ownershipFirstSeenAtMs: number | null;
  /**
   * PHASE3.17 R2.3 (review B1) — the DURABLE pairing of a dual grid arm's two
   * rows, or `null` for every other row ever written.
   *
   * Both rows of one dual arm carry the SAME uuid, so either reaches the other
   * — which is what the paths that must close or update both need, because NONE
   * of them sees the request. The worker's resume reads only
   * `sequence.positionId`; `runLpOpen`'s `rollBack` runs on six refusal classes
   * including from that resume; the abandon route resolves one position from
   * one sequence and has no request-side knowledge at all. An input-only
   * pairing is unreachable from exactly the paths that break without it.
   *
   * WHAT BREAKS WITHOUT IT, concretely: a rollback closes row 1 and leaves row
   * 2 `open` with `tokenId: null`. The worker then skips row 2 for ever (no
   * tokenId, no non-terminal sequence), no exit can reach it (every exit needs
   * a tokenId), and the arm's own idle gate — which refuses on ANY non-closed
   * row — makes re-arming permanently impossible. That is the wedge PHASE3.16
   * review H3 closed, reopened in the phase whose selling point is that the
   * restart path is "sign gridArm again".
   *
   * ADDITIVE AND NULLABLE: an existing deployment reads `null` on every row, no
   * CHECK is touched, no sequence schema changes, and there is no new table.
   */
  readonly armGroupId: string | null;
  readonly armMeta: LpArmMeta | null;
  /**
   * PHASE3.18 R2.6 — the DURABLE grid identity. `null` on every non-grid row
   * and on every row written before this phase; IGNORED in fixed mode, where
   * exact-tick match against the signed rungs stays the sole authority.
   */
  readonly gridLevel: LpGridLevelValue | null;
  readonly gridRole: LpGridRoleValue | null;
  /**
   * PHASE3.19 B3 / C4 — THE LADDER'S VWAP BOOK: the base token this ladder has
   * ACQUIRED and the WBNB it paid for it, advanced ONLY from confirmed receipts.
   *
   * `costWbnb / base` is the markout gate's denominator — the one quantity that
   * decides whether the hedge trades at market. It exists because B3 found that
   * the reference price the spec assumed DOES NOT: rows carry no ticks (3.17
   * R2.5/H3), the prior tokenId is replaced on every motion, a rung boundary is
   * not a fill price, and the standing-imbalance hedge has no single fill at all.
   * A running VWAP survives every tokenId replacement and is total over the
   * ladder's whole life.
   *
   * ONE BOOK PER LADDER (C4), carried by the `arm_group_id` ANCHOR row — the
   * first-created one, which is the row the arm marks by initialising these
   * columns to zero. The SIBLING's columns stay NULL for ever, and every motion
   * of EITHER row reads and writes the ANCHOR's. Two independent books over one
   * pooled buffer would diverge and double-count: a buy fill on row 1 would
   * credit row 1's book while a hedge fired during row 2's motion deducted row
   * 2's, and neither would describe the base the next markout gate is about to
   * trade.
   *
   * `null` on every non-ladder row and on every row written before this phase.
   * NULL AND ZERO ARE DIFFERENT HERE: null means "this row is not the anchor",
   * zero means "the anchor holds no acquired base" — which the markout gate
   * REFUSES on rather than dividing by (D1).
   *
   * The columns are ADVANCED ONLY through {@link LpSequenceStore.applyInventoryCredit},
   * never by a read-modify-write: the increment is in SQL, inside one
   * transaction with the append-only credit row that guards it.
   */
  readonly inventoryBaseWei: bigint | null;
  readonly inventoryCostWbnbWei: bigint | null;
  /** Resolver fence CAS version; every mutation increments, same-value too. */
  readonly rowVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type LpSelectionReceipt = {
  readonly rankBy: "fee-apr" | "volume";
  readonly orderBy: "lpFeeApr24h" | "volume24hUsd";
  readonly window: "24h";
  readonly laneAsOfMs: number;
  readonly source: "pancake";
  readonly total: number | null;
  readonly matched: number;
  readonly returned: number;
  readonly cap: number | null;
  readonly ingestOrder: "tvlUSD" | null;
  readonly rowDropCounts: Readonly<Record<string, number>>;
  readonly survivors: readonly {
    readonly pool: Address;
    readonly aprBps: string;
    readonly aprSource: "pancake-apr24h";
    readonly tvlUsdE6: string;
    readonly volume24hUsdE6: string;
    readonly rowAsOfMs: number;
  }[];
  readonly head: Address;
  readonly chosen: Address;
};

export type LpArmMeta = {
  readonly action: "lpArm";
  readonly model: "custom" | "sigma";
  readonly range: {
    readonly source: "explicit" | "server-fenced";
    readonly tickLower: number;
    readonly tickUpper: number;
  };
  readonly selectPool: {
    readonly by: "fee-apr" | "volume";
    readonly window: "24h";
  } | null;
  readonly selection: LpSelectionReceipt | null;
  readonly budgetWei: string;
};

/** One saga run. Steps are ordered; outcomes live in the execution journal. */
export type LpSequenceRecord = {
  /** Old NFT identity, write-once with the atomic attempt before journal begin. */
  readonly priorTokenId?: string | null;
  readonly sequenceId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly positionId: string;
  readonly kind: LpSequenceKind;
  /** PHASE3.24 C2 — write-once owner consent; legacy SQL NULL reads false. */
  readonly inlineConvert: boolean;
  readonly state: LpSequenceState;
  readonly recoveryState: LpRecoveryState;
  readonly steps: readonly LpSequenceStep[];
  /**
   * One operator-facing sentence about a SKIPPED plan position, or `null`
   * (PHASE3.1 Rev2 item 15). Written once, via
   * {@link LpSequenceStore.setSequenceNote}, when an OPTIONAL step — the
   * exit's swap — is recorded as skipped.
   *
   * WHY IT IS A COLUMN AND NOT A RECOVERY STATE. The exit's decision 2 says a
   * refused swap COMPLETES the sequence "with the reason recorded on the
   * sequence"; without this field that reason exists only in
   * `LpSagaRunResult.reason`, which for an AUTONOMOUS protect goes to the
   * worker's log and nowhere else — the owner sees `COMPLETED`, holds the
   * token, and has no in-product explanation, in the phase that exists
   * because the owner was surprised by what the exit returned. A new
   * `LpRecoveryState` member was REFUSED instead: `recovery_state` carries a
   * SQL CHECK that `create table if not exists` cannot widen, and the exit
   * owes no recovery — its assets sit in the owner's own EOA.
   */
  readonly note: string | null;
  /** PHASE3.24 C3 — confirmed collected base less the witnessed inline input. */
  readonly inlineResidueBaseWei: bigint | null;
  readonly resolverPriorState: "active" | "held" | null;
  readonly resolverPriorRecoveryState: LpRecoveryState | null;
  readonly resolverFence: bigint;
  readonly resolverLeaseUntil: number | null;
  readonly resolverSnapshotHash: Hex | null;
  readonly resolverRowVersion: number;
  readonly resolutionId: string | null;
  readonly resolverActionIdempotencyKey: string | null;
  readonly resolutionDispositionStarted: boolean;
  /**
   * The pre-bind retirement fence is deliberately separate from landing
   * resolution.  Reusing resolver columns would let a future resolver change
   * accidentally widen the no-submit retirement authority.
   */
  readonly retirementPriorState: "active" | "held" | null;
  readonly retirementPriorRecoveryState: LpRecoveryState | null;
  readonly retirementTargetJournalKey: string | null;
  readonly retirementActionIdempotencyKey: string | null;
  readonly retirementFence: bigint;
  readonly retirementLeaseUntil: number | null;
  readonly retirementSnapshotHash: Hex | null;
  readonly retirementRowVersion: number;
  readonly retirementDispositionStarted: boolean;
  /**
   * The DURABLE stall latch (PHASE3.11 F1). `stallCode` is the worker's own
   * summary of the last resume that made no progress — the saga's run code
   * plus the plan position it stopped at — and `stallCount` is how many
   * CONSECUTIVE resumes ended exactly there.
   *
   * WHY IT IS DURABLE, and not a per-process `Map`: FINDINGS (ae). A counter
   * that resets on restart is a counter that never reaches its bound on a
   * daemon that restarts.
   *
   * WHY IT EXISTS AT ALL. A `held` sequence with a named recovery is back in
   * the worker queue, and each cycle claims it `held -> active` and re-holds
   * it — two writes, so `updated_at` is refreshed inside every interval and
   * {@link LpSequenceStore.claimSequenceForAbandon}'s idleness gate can never
   * be satisfied while the worker runs. Past the bound the worker BACKS OFF
   * instead of resuming, which leaves `updated_at` quiescent long enough for
   * the owner's abandon to claim the row. A backoff, deliberately, and not a
   * permanent stop: a refusal that heals on its own (the price returns into
   * range, `reconcile` settles the row) must still be picked up.
   */
  readonly stallCode: string | null;
  readonly stallCount: number;
  /**
   * PHASE3.18 R2.3/C4 — the REQUOTE's target rung as the trigger computed it,
   * or `null` on every other kind.
   *
   * THE PRECEDENCE RULE, stated where the field is: on resume the PERSISTED
   * target WINS. A recomputation that disagrees is a THROW, never an overwrite
   * — without that sentence a builder can satisfy "read from the row" with a
   * read a later derivation silently replaces, which is B4 restored.
   */
  readonly targetTickLower: number | null;
  readonly targetTickUpper: number | null;
  /**
   * PHASE3.22 R8 / R2.19 — THE SHIFT's SELL target, or `null` on every other
   * kind.
   *
   * A shift re-anchors ONE OR BOTH targeted rungs in one motion. The existing
   * pair above carries the optional **BUY** range, and these additive nullable
   * columns carry the optional **SELL** range. Exactly one present pair means
   * one target; both present means two. NULL is untouched, never depleted
   * (PHASE3.23 R3.4).
   *
   * THE PRECEDENCE RULE IS THE SAME ONE, and it is the whole reason the ticks
   * are durable: on resume the PERSISTED targets WIN, a recomputation that
   * disagrees is a THROW and never an overwrite. R8 additionally pins WHERE
   * that guard lives — inside `runLpGridShift` itself, not in the worker —
   * because that is where a mutation can kill it (the C4/M-B3 placement).
   */
  readonly targetSellTickLower: number | null;
  readonly targetSellTickUpper: number | null;
  /**
   * PHASE3.23 R2.1 / R3.2 — why a grid-shift was authorized. Nullable and
   * additive: legacy NULL is `unknown`, which is replayable after submission
   * but must refuse a never-submitted build before any wallet call is made.
   */
  readonly shiftCause: LpShiftCause | null;
  /**
   * PHASE3.19 B3 / item 8 — THE LADDER HEDGE'S PERSISTED INTENT, written BEFORE
   * the swap is submitted, or `null` on every other kind.
   *
   * THE PRECEDENCE RULE, stated where the fields are (the 3.18 C4 shape
   * VERBATIM): the persisted intent WINS, it is NEVER overwritten, and a
   * caller-supplied intent that disagrees is a THROW. The hedge's amount is
   * BALANCE-DERIVED — the one place in this plane where a money call's size does
   * not come from a receipt — so a resume that re-derived it at a different
   * price would bind a DIFFERENT swap at market. That is 3.18's B4 restored in a
   * step that moves money, which is why the intent is durable and why the guard
   * is a double one (in the runner AND at the deps seam).
   */
  readonly hedgeDirection: "wbnb-to-token" | "token-to-wbnb" | null;
  readonly hedgeAmountInWei: bigint | null;
  /**
   * PHASE3.20 D1 / item 7 / C6 — WHICH EVIDENCE this ladder motion fired on,
   * written by the INSERT that creates the row and `null` on every other kind.
   *
   * THE PRECEDENCE RULE, stated where the field is (the 3.18 C4 shape verbatim):
   * on resume the PERSISTED evidence WINS, it is never overwritten, and a
   * caller-supplied evidence that disagrees is a THROW. A resume does not
   * re-evaluate the trigger, so the evidence that authorized the lane is not
   * recoverable any other way — and a resume that re-derived it could charge a
   * settlement to the drift budget, which is the (az) defect with the lanes
   * pointing the other way. `null` on a pre-migration row reserves SETTLEMENT.
   */
  readonly recenterEvidence: LpRecenterEvidence | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * A reservation row. EVERY sequence that moves money writes one (accounting —
 * the R4 gas-reserve derivation needs the true sequence count); only the
 * quota-bound kinds can be REFUSED on it. See {@link LpSequenceStore.reserveSequence}.
 */
export type LpExitReservation = {
  readonly sequenceId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly kind: LpSequenceKind;
  /** True for rotate/harvest — the kinds `maxExitSequencesPerDay` can refuse. */
  readonly quotaBound: boolean;
  /**
   * PHASE3.20 D1 / item 7 — WHICH LANE THIS ROW OCCUPIES, when the kind cannot
   * say. Written at reserve from the sequence's persisted `recenterEvidence`;
   * `null` on every non-ladder row and on every `grid-recenter` row written
   * before the migration, where it reads as SETTLEMENT (C5/B1).
   */
  readonly quotaLane: LpPersistedQuotaLane | null;
  readonly reservedAt: number;
  /**
   * When the slot was given back, or `null` (PHASE3.5).
   *
   * A reservation is RELEASED only when its sequence went terminal having
   * PROVABLY made no submission — see {@link LpSequenceStore.releaseReservation}
   * for the predicate and why it is not the retry join's.
   *
   * THE TWO USES OF THIS TABLE DIVERGE HERE, and the split is load-bearing
   * (PHASE3.5 Rev2 M3):
   *
   *   - the rolling COUNT against `maxExitSequencesPerDay` ignores released
   *     rows, because the limit is a proxy for the gas meter and a released row
   *     drew none;
   *   - the `minMinutesBetweenExits` ANCHOR still counts them. That gate is a
   *     pacing floor the owner SIGNED, and it is also the only bound on a
   *     worker loop that reserves, refuses above the submit, and rolls back
   *     every cycle — released from both, that loop would run once per cycle
   *     for ever.
   */
  readonly releasedAt: number | null;
};

/**
 * The rolling-window state of an agent's exit quota (PHASE3.5 decision 4).
 *
 * `liveCount` is what the LIMIT sees; `latestReservedAtMs` is what the SPACING
 * gate sees, and it counts released rows — the M3 split, reported by the same
 * rule the enforcement uses, so the surface cannot disagree with the refusal.
 */
export type LpQuotaUsage = {
  /**
   * In-window EXIT-LANE reservations that have NOT been released — what
   * `maxExitSequencesPerDay` refuses against.
   *
   * PHASE3.15: derived by subtracting the grid lane from the raw quota-bound
   * count, so the aggregate's own SQL text (and the TEXT-level pin on it) is
   * unchanged while the number keeps meaning what the GATE counts. The two
   * lanes are mutually exclusive per agent in practice — a grid agent never
   * rotates or harvests — but the split is written out rather than assumed.
   */
  readonly liveCount: number;
  /**
   * In-window `grid-flip` reservations that have NOT been released — what
   * `grid.maxFlipsPerDay` refuses against (PHASE3.15 R2.7).
   *
   * OPTIONAL on the TYPE so a hand-built usage object (the quota view's own
   * tests) need not name a lane it is not about; BOTH store implementations
   * always set it, and every consumer reads `?? 0`. Absent therefore means
   * "no grid lane in this window", which is the truth for every non-grid agent.
   */
  readonly gridFlipLiveCount?: number;
  /**
   * In-window `grid-requote` reservations that have NOT been released — what
   * `grid.requote.maxRequotesPerDay` refuses against (PHASE3.18 C7).
   *
   * OPTIONAL on the TYPE for the same reason `gridFlipLiveCount` is; BOTH store
   * implementations always set it, and every consumer reads `?? 0`. It is
   * subtracted out of `liveCount` alongside the flip lane, so a requote
   * reservation counts against NEITHER the exit lane nor the flip lane — the
   * defect R2.10 names as "the easiest defect in this phase".
   */
  readonly requoteLiveCount?: number;
  /**
   * In-window `grid-recenter` reservations that have NOT been released — what
   * `grid.ladder.maxMovesPerDay` refuses against (PHASE3.19 item 19).
   *
   * OPTIONAL on the TYPE for the reason its two siblings are; BOTH store
   * implementations always set it, and every consumer reads `?? 0`. It is
   * subtracted out of `liveCount` ALONGSIDE the other two lanes, so a ladder
   * motion counts against NEITHER the exit lane nor the flip lane nor the
   * requote lane — the R2.10 "easiest defect" class, one lane later.
   */
  readonly recenterLiveCount?: number;
  /**
   * PHASE3.20 D1 — the SETTLEMENT half of the recenter lane: in-window
   * `grid-recenter` reservations whose stored `quota_lane` is `'settlement'` OR
   * IS NULL, what `grid.ladder.settlementsPerDay` refuses against.
   *
   * THE NULL ARM IS NOT A CONVENIENCE (R4.1/B1). `recenter_live_count` filters
   * on the kind alone, so `settlementLiveCount + driftLiveCount ===
   * recenterLiveCount` holds only if every pre-migration NULL row is counted
   * here; the natural `quota_lane = 'settlement'` drops them from BOTH counts
   * and restores the free-capacity defect for a rolling 24 h — through the one
   * seam where SQL's three-valued logic, not TypeScript's `??`, decides.
   *
   * OPTIONAL on the TYPE for the reason its three siblings are; BOTH store
   * implementations always set it. It is NOT subtracted out of `liveCount`
   * separately — `recenterLiveCount` is the SUM and already is.
   */
  readonly settlementLiveCount?: number;
  /**
   * PHASE3.20 D1 — the DRIFT half, `quota_lane = 'drift'` exactly. Its
   * predicate stays exact precisely because the settlement predicate carries
   * the NULL arm; widening both would double-count every legacy row.
   */
  readonly driftLiveCount?: number;
  /**
   * PHASE3.22 R2.21 — in-window `grid-shift` reservations that have NOT been
   * released, what `grid.shift.shiftsPerDay` refuses against.
   *
   * OPTIONAL on the TYPE for the reason its four siblings are; BOTH store
   * implementations always set it, and every consumer reads `?? 0`. It IS
   * subtracted out of `liveCount` alongside the flip, requote and recenter
   * lanes — the R2.10 "easiest defect" class, one lane later again: without
   * genuine subtraction at EVERY counting seam a shift reservation would count
   * against the EXIT lane it does not belong to, quietly shrinking the budget
   * of a lane the owner signed for something else.
   *
   * PHASE3.25 retains this all-shift dashboard total beside two independent
   * lane counters; it is not an admission limit.
   */
  readonly shiftLiveCount?: number;
  /** PHASE3.25 R2.6/R5.3 — cross/legacy-NULL settlement subset. */
  readonly shiftSettleLiveCount?: number;
  /** PHASE3.23 R3.3 — the drift-caused subset of {@link shiftLiveCount}. */
  readonly shiftDriftLiveCount?: number;
  /** In-window reservations released back, for the owner's own accounting. */
  readonly releasedCount: number;
  /** Latest `reservedAt` over ALL in-window rows, or `null`. */
  readonly latestReservedAtMs: number | null;
  /** When the oldest LIVE row leaves the window, or `null`. */
  readonly oldestLiveExpiresAtMs: number | null;
};

/** The owner-signed limits the reservation enforces (settings table). */
export type LpExitQuota = {
  readonly maxExitSequencesPerDay: number;
  readonly minMinutesBetweenExits: number;
  /**
   * PHASE3.15 R2.7: the GRID lane's own daily count (`grid.maxFlipsPerDay`).
   *
   * OPTIONAL, and its absence FAILS CLOSED rather than defaulting: a caller who
   * dispatches a `grid-flip` without supplying it is refused at zero. Every
   * wired path supplies it from the signed grid block, and a non-grid agent
   * never reserves in this lane at all.
   */
  readonly maxGridFlipsPerDay?: number;
  /**
   * PHASE3.18 C7: the REQUOTE lane's own daily count
   * (`grid.requote.maxRequotesPerDay`).
   *
   * OPTIONAL, and its absence FAILS CLOSED at zero exactly like the flip lane's
   * — which is what makes a FIXED-mode grid structurally unable to requote even
   * if a decision ever reached the store: no requote block, no limit, refused.
   */
  readonly maxRequotesPerDay?: number;
  /**
   * PHASE3.19 item 19: the LADDER lane's own daily count
   * (`grid.ladder.maxMovesPerDay`).
   *
   * OPTIONAL, and its absence FAILS CLOSED at zero exactly like both grid lanes
   * before it — which is what makes a fixed- or policy-mode grid structurally
   * unable to re-anchor even if a decision ever reached the store: no ladder
   * block, no limit, refused.
   */
  readonly maxMovesPerDay?: number;
  /**
   * PHASE3.20 D1: the SETTLEMENT lane's own daily count
   * (`grid.ladder.settlementsPerDay`, or `maxMovesPerDay` under the legacy
   * interpretation — the worker derives it through `ladderMotionCounts`, which
   * is the one place that reading is written).
   *
   * OPTIONAL, and its absence FAILS CLOSED at zero exactly like the three lanes
   * before it.
   */
  readonly maxSettlementsPerDay?: number;
  /**
   * PHASE3.20 D1: the DRIFT lane's own daily count
   * (`grid.ladder.driftMovesPerDay`). ZERO is the legacy interpretation's own
   * answer and is meaningful rather than defensive: a 3.19 signature keeps
   * settling fills and never chases until it re-signs.
   */
  readonly maxDriftMovesPerDay?: number;
  /**
   * PHASE3.25 R2.4/R5.3: the SHIFT SETTLEMENT lane's daily count
   * (`grid.shift.shiftsPerDay`). Legacy NULL-lane reservations count here.
   * OPTIONAL, and absence fails closed at zero.
   */
  readonly maxShiftsPerDay?: number;
  /** PHASE3.25 R2.6/R5.3 — derived signed drift allowance; absent fails closed. */
  readonly maxShiftDriftPerDay?: number;
};

export type CreateLpPositionInput = {
  readonly positionId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  /** Omit at `/lp/open`; recorded from the confirmed mint receipt. */
  readonly tokenId?: string;
  /** The owner-signed budget in `quoteToken` wei (R7). */
  readonly basisWei: bigint;
  /**
   * Provenance of {@link basisWei}. Omitted ⇒ `"owner-budget"`, so every
   * pre-PHASE3.4 call site is unchanged; `POST /lp/import` passes `"imported"`.
   */
  readonly basisSource?: LpLineageBasisSource;
  /**
   * Carry an EXISTING lineage forward (item 40's migration seam). Omitted,
   * a fresh lineage id is minted — the normal `/lp/open` path.
   */
  readonly lineageId?: string;
  readonly quoteToken?: Address;
  /**
   * PHASE3.17 R2.3: the dual arm's group id, written AT CREATION for BOTH rows
   * with the same value. Omitted by every other caller, which is what keeps
   * `armGroupId` null on every row a single arm, an open or an import writes.
   */
  readonly armGroupId?: string;
  readonly armMeta?: LpArmMeta;
  /**
   * PHASE3.18 R2.6 — the durable grid identity, written AT ROW CREATION by the
   * arm (the only path that knows which level and role it is placing). Omitted
   * by every other caller, which keeps both columns null on every open, import
   * and pre-3.18 row.
   */
  readonly gridLevel?: LpGridLevelValue;
  readonly gridRole?: LpGridRoleValue;
  /**
   * PHASE3.19 C4 — mark THIS row as the ladder's BOOK ANCHOR: its
   * `inventory_base_wei`/`inventory_cost_wbnb_wei` are initialised to ZERO
   * instead of null, and every motion of either row of the arm group reads and
   * writes them.
   *
   * The anchor is the FIRST-CREATED row of the group, and "which row is the
   * anchor" is answered DURABLY by this initialisation rather than by ordering a
   * pair of uuids or racing two `created_at` stamps: the anchor is the group
   * member whose book columns are NOT NULL. Omitted by every other caller, which
   * keeps both columns null on every open, import, flip and pre-3.19 row.
   */
  readonly inventoryAnchor?: boolean;
};

/**
 * PHASE3.22 R4.2.3 / §15 (2c) — RE-OPEN A SHIFT LADDER'S DORMANT SIDE.
 *
 * ─── WHY THIS SEAM EXISTS ──────────────────────────────────────────────────
 *
 * Under decision 9 a shift motion may proceed ONE-SIDED: below the
 * single-sided mint floor a side's mint call is omitted, its principal joins
 * the buffer and its row is CLOSED (`closeReason: "shift-depleted"`). Closing
 * — rather than parking a null-tokenId zombie — is what REVIEW3 proved is the
 * only shape the shipped tree actually handles: a closed row leaves the
 * one-live-token index and the one-live-sequence index predicates, is skipped
 * by the worker loop, and does NOT block a re-arm (the arm gate refuses on
 * non-closed rows only). REVIEW4 §C calls that "the strongest argument in
 * Revision 4".
 *
 * The price of closing is that re-opening needs a row to be CREATED, and that
 * is this function. The self-cure it serves is real and is why §10's "3.21 is
 * subsumed for shift rows" claim stands: the surviving side's fills deliver
 * the depleted asset back to the buffer — every sell fill delivers quote,
 * every buy fill delivers base — so a later motion's funding check clears the
 * dormant side's floor on its own, with no owner action and no conversion
 * step.
 *
 * ─── WHY A FREE FUNCTION AND NOT AN INTERFACE METHOD ───────────────────────
 *
 * It is a WRAPPER, not a capability (REVIEW4 §C: "a wrapper, not a schema
 * change"). `createPosition` is already owner-scoped and already accepts
 * `armGroupId`, `gridLevel`, `gridRole`, `lineageId` and `basisSource`, so
 * there is nothing for a backend to implement differently — and a method on
 * the interface would be two implementations of one composition, which is the
 * shape that eventually diverges. One function, both backends, nothing to keep
 * in sync.
 *
 * ─── THE FIVE FIELDS IT FIXES, each with its reason ────────────────────────
 *
 *  - `armGroupId` — the SAME group as the closed sibling. This is what makes
 *    the pair a pair again: the dispatcher's live-role snapshot, the group
 *    lock and the owner view all resolve siblings through this column.
 *  - `gridRole` — the dormant side's own role, unchanged. A shift's roles are
 *    invariant for the life of the ladder (R2.13's reasoning), so the re-open
 *    restores the role it had rather than deriving one.
 *  - `lineageId` — CARRIED FROM THE CLOSED SIBLING, so the re-opened side
 *    belongs to the same lineage the pair has had since the arm rather than
 *    minting a fresh one. R4.2.3 names this explicitly.
 *  - `basisWei: 0n` with `basisSource: "minted"` — the grid-arm posture
 *    verbatim. A shift rung holds `deployPctBps` of one side's half, so a
 *    value-versus-basis stop measures the wrong quantity; `0n` makes the
 *    predicate inert, and shift mode additionally REFUSES a non-zero
 *    `stopLossPct`/`takeProfitPct` at signing so nobody signs one that never
 *    fires. `"minted"` says the plane minted this principal rather than
 *    measuring an owner's declaration.
 *  - NO `tokenId` — the row is created by the step's `after` hook and its
 *    tokenId written in the same hook from the verified receipt. Passing one
 *    here would put the token-uniqueness assertion in the wrong place.
 *
 * `gridLevel` is `1` because a shift ladder is TWO ROWS ON ONE PAIR and §10's
 * multi-level non-goal keeps it that way.
 */
export async function createPositionForArmGroup(
  store: Pick<LpSequenceStore, "createPosition">,
  input: {
    readonly positionId: string;
    readonly agentId: string;
    readonly ownerAddress: Address;
    readonly token0: Address;
    readonly token1: Address;
    readonly fee: number;
    readonly quoteToken: Address;
    /** The group the closed sibling belongs to — never a fresh one. */
    readonly armGroupId: string;
    /** The dormant side's own role, restored rather than re-derived. */
    readonly gridRole: LpGridRoleValue;
    /** Carried from the closed sibling (R4.2.3). */
    readonly lineageId: string;
  },
): Promise<LpPositionRecord> {
  return store.createPosition({
    positionId: input.positionId,
    agentId: input.agentId,
    ownerAddress: input.ownerAddress,
    token0: input.token0,
    token1: input.token1,
    fee: input.fee,
    quoteToken: input.quoteToken,
    armGroupId: input.armGroupId,
    gridLevel: 1,
    gridRole: input.gridRole,
    lineageId: input.lineageId,
    basisWei: 0n,
    basisSource: "minted",
  });
}

export type CreateLpSequenceInput = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly positionId: string;
  readonly kind: LpSequenceKind;
  /** PHASE3.24 C2 — meaningful only for a manual-exit sequence. */
  readonly inlineConvert?: boolean;
  /**
   * PHASE3.18 R2.3/C4 — the requote's target rung, written in the SAME
   * transaction that creates the sequence, before the zap-out can submit.
   * Omitted by every other kind.
   */
  readonly targetRange?: { readonly tickLower: number; readonly tickUpper: number };
  /**
   * PHASE3.22 R8 — the SHIFT's SELL target rung, written in the SAME
   * transaction as {@link targetRange} (which carries the shift's BUY rung).
   * Omitted by every other kind.
   *
   * A shift authorizes TWO mints, so persisting only one of them would leave a
   * resumable row whose second rung is a fresh derivation at a later tick —
   * exactly the "authorized a rung the owner never signed" defect 3.18's B4
   * found for the requote, doubled.
   */
  readonly targetSellRange?: { readonly tickLower: number; readonly tickUpper: number };
  /** PHASE3.23 R3.2 — persisted by the CREATE transaction for grid-shift only. */
  readonly shiftCause?: LpShiftCause;
  /**
   * PHASE3.20 D1 / item 7 — the LADDER motion's lane evidence, written in the
   * SAME transaction that creates the row so the reservation that follows can
   * read it back rather than re-derive it. Omitted by every other kind, which
   * leaves the column null.
   */
  readonly recenterEvidence?: LpRecenterEvidence;
};

/* -------------------------------------------------------------------------- */
/* Typed errors                                                               */
/* -------------------------------------------------------------------------- */

/** A second non-terminal sequence was attempted on a position. */
export class LpActiveSequenceError extends Error {
  readonly code = "LP_ACTIVE_SEQUENCE";
  constructor(positionId: string) {
    super(`Position "${positionId}" already has a non-terminal sequence.`);
    this.name = new.target.name;
  }
}

/**
 * A quota-bound reservation was refused. `reason` distinguishes the rolling
 * daily cap from the minimum spacing; both apply ONLY to rotate/harvest.
 */
export class LpExitQuotaError extends Error {
  readonly code = "LP_EXIT_QUOTA";
  readonly reason: "quota-exhausted" | "min-interval";
  /**
   * PHASE3.15 R2.7: which daily count refused. OPTIONAL and defaulting to
   * `"exit"`, so every existing construction site and every existing message is
   * byte-identical — the grid lane only changes what the sentence NAMES, never
   * the `reason` callers branch on.
   */
  readonly lane:
    | "exit"
    | "grid"
    | "requote"
    | "recenter"
    | "settlement"
    | "drift"
    | "shift-settle"
    | "shift-drift";
  constructor(
    reason: "quota-exhausted" | "min-interval",
    lane:
      | "exit"
      | "grid"
      | "requote"
      | "recenter"
      | "settlement"
      | "drift"
      | "shift-settle"
      | "shift-drift" = "exit",
  ) {
    super(
      // PHASE3.18 C7: the union and this table WIDEN; the two existing
      // sentences stay BYTE-IDENTICAL (the A6 text pin). A requote's own
      // sentence names its own lane, because "grid quota exhausted" while
      // flips are still available is the wrong thing to tell an owner.
      //
      // PHASE3.19 item 19: a FOURTH arm, and the THREE existing sentences stay
      // byte-identical for the same reason. A ladder's own sentence names the
      // motion an owner would recognise ("re-anchor"), not "flip".
      // PHASE3.20 D1: the two LADDER lanes get their own sentences, and the
      // three sentences before them stay BYTE-IDENTICAL for the reason each
      // widening before this one did. Naming WHICH lane is spent is the point —
      // "the ladder is out of quota" while the other lane is still open sends an
      // owner to the wrong knob.
      lane === "shift-settle"
        ? reason === "quota-exhausted"
          ? "Rolling 24-hour grid-shift SETTLEMENT quota is exhausted; fills stop being settled until the window rolls. The drift allowance is unaffected; both lanes still share agent-wide spacing."
          : "Minimum interval between LP sequences has not elapsed; the shift rate is floored by minMinutesBetweenExits."
      : lane === "shift-drift"
        ? reason === "quota-exhausted"
          ? "Rolling 24-hour grid-shift DRIFT allowance is exhausted. Remedy: re-sign grid.shift.driftGasBudgetWei higher, or wait for the window to roll. The settlement quota is unaffected; both lanes still share agent-wide spacing."
          : "Minimum interval between LP sequences has not elapsed; the shift rate is floored by minMinutesBetweenExits."
      : lane === "settlement"
        ? reason === "quota-exhausted"
          ? "Rolling 24-hour grid-recenter SETTLEMENT quota is exhausted; fills stop being settled until the window rolls, drift moves are unaffected, and the price stop stays armed."
          : "Minimum interval between LP sequences has not elapsed; the ladder's fill-settlement rate is floored by minMinutesBetweenExits."
      : lane === "drift"
        ? reason === "quota-exhausted"
          ? "Rolling 24-hour grid-recenter DRIFT quota is exhausted; discretionary re-anchoring stops until the window rolls and fill settlements are unaffected."
          : "Minimum interval between LP sequences has not elapsed; the ladder's re-anchor rate is floored by minMinutesBetweenExits."
      : lane === "recenter"
        ? reason === "quota-exhausted"
          ? "Rolling 24-hour grid-recenter quota is exhausted; the ladder stops re-anchoring until the window rolls, and the price stop stays armed."
          : "Minimum interval between LP sequences has not elapsed; the ladder's re-anchor rate is floored by minMinutesBetweenExits."
      : lane === "requote"
        ? reason === "quota-exhausted"
          ? "Rolling 24-hour grid-requote quota is exhausted; flips are unaffected and still settle fills."
          : "Minimum interval between LP sequences has not elapsed; the grid's re-centre rate is floored by minMinutesBetweenExits."
        : lane === "grid"
          ? reason === "quota-exhausted"
            ? "Rolling 24-hour grid-flip quota is exhausted."
            : "Minimum interval between LP sequences has not elapsed; the grid's cycle rate is floored by minMinutesBetweenExits."
          : reason === "quota-exhausted"
            ? "Rolling 24-hour LP exit-sequence quota is exhausted."
            : "Minimum interval between LP exit sequences has not elapsed.",
    );
    this.name = new.target.name;
    this.reason = reason;
    this.lane = lane;
  }
}

/**
 * A non-closed position row already claims this NFPM tokenId (PHASE3.4 Rev2
 * M5).
 *
 * TYPED because the alternative is a 500. `createPosition`'s
 * `on conflict (position_id) do nothing` is that statement's ONE allowed
 * `ON CONFLICT` clause, so a violation of `lp_positions_one_live_token_idx`
 * arrives as a raw driver exception carrying the constraint name — from the
 * import route AND from inside `updatePositionTokenId`, which every rotate and
 * every open calls from a saga hook.
 *
 * The error carries the tokenId and NOTHING ELSE. AUDIT A3: it used to carry a
 * `sameAgent` flag no writer ever set, documented as "filled by an
 * owner-AND-agent-scoped lookup" — a dead field with a doc comment describing
 * behaviour that did not exist. The store CANNOT fill it honestly: a unique
 * violation tells Postgres's caller which INDEX was violated, never which row
 * won, so answering "was it yours?" needs a second, scoped query. The route
 * makes exactly that query ({@link LpSequenceStore.getPositionByTokenId}) and
 * chooses the voice from its answer, which is the safer design and the only one
 * that can distinguish the two cases at all.
 */
/**
 * PHASE3.19 D3 — one row of the append-only VWAP-book credit set.
 *
 * `applicationKey` is the step's JOURNAL IDEMPOTENCY KEY and the PRIMARY KEY;
 * nothing weaker is admissible (D2). `owner_address`/`agent_id`/`position_id`
 * are carried because the Phase 1a owner-scoping invariant admits no structural
 * exception — a table whose rows cannot be filtered by owner is not one this
 * store may have, even when its key is server-generated.
 */
export type LpInventoryCreditRecord = {
  readonly applicationKey: string;
  readonly ownerAddress: string;
  readonly agentId: string;
  readonly positionId: string;
  readonly armGroupId: string | null;
  readonly deltaBaseWei: bigint;
  readonly deltaCostWbnbWei: bigint;
  readonly createdAt: number;
};

/**
 * PHASE3.19 D1 — CLAMP THE DELTA, never the running column, with the cost leg
 * moved in LOCKSTEP and PROPORTIONALLY.
 *
 * ONE function, shared by both backends, which is the whole of D1: the running
 * clamp and the clamp-of-the-sum are DIFFERENT FUNCTIONS (`+10, -15, +20` gives
 * 20 for the first and 15 for the second), so clamping a column would make
 * "book = sum of distinct credits" false the moment one ever fired — and would
 * make the two backends compute different books, which item 49 requires to
 * agree. With the clamp here the stored deltas can never sum negative and the
 * invariant holds unconditionally.
 *
 * A DEDUCTION ignores the caller's requested cost delta in favour of the BOOK
 * AVERAGE, which is what "in lockstep and proportionally" means: selling `x` of
 * `base` retires `bookCost x x / base` of cost. When the clamp empties the book
 * the cost leg is exactly `-bookCost`, so an emptied book is `{0, 0}` and never
 * `{0, something}` — the state that would divide by zero in the markout gate.
 *
 * A CREDIT passes through unchanged: both legs are measured from a confirmed
 * receipt and there is nothing to clamp against.
 */
export function clampInventoryDelta(
  book: { readonly baseWei: bigint; readonly costWbnbWei: bigint },
  delta: { readonly baseWei: bigint; readonly costWbnbWei: bigint },
): { readonly baseWei: bigint; readonly costWbnbWei: bigint } {
  if (delta.baseWei >= 0n) return { baseWei: delta.baseWei, costWbnbWei: delta.costWbnbWei };
  const wanted = -delta.baseWei;
  if (book.baseWei <= 0n) return { baseWei: 0n, costWbnbWei: 0n };
  if (wanted >= book.baseWei) {
    return { baseWei: -book.baseWei, costWbnbWei: -book.costWbnbWei };
  }
  return {
    baseWei: -wanted,
    costWbnbWei: -((book.costWbnbWei * wanted) / book.baseWei),
  };
}

/**
 * PHASE3.19 C4 — a book write was aimed at a row that is not the ladder's
 * ANCHOR.
 *
 * TYPED because it is reachable only from a saga `after`, where an untyped
 * throw is a `POST_VERIFY_FAILED` hold with an unreadable reason. It means a
 * caller resolved the anchor wrongly (the anchor is the arm-group member whose
 * book columns are NOT NULL), which is a programming error and must not be
 * papered over by silently creating a second book.
 */
export class LpInventoryAnchorMissingError extends Error {
  readonly code = "LP_INVENTORY_ANCHOR_MISSING";
  constructor(positionId: string) {
    super(
      `LP position "${positionId}" is not a ladder book anchor (its inventory columns are null); refusing to open a second book for one pooled buffer.`,
    );
    this.name = new.target.name;
  }
}

export class LpTokenIdInUseError extends Error {
  readonly code = "LP_TOKEN_ID_IN_USE";
  readonly tokenId: string;
  constructor(tokenId: string) {
    super(`NFPM tokenId "${tokenId}" is already claimed by a live position row.`);
    this.name = new.target.name;
    this.tokenId = tokenId;
  }
}

/** The named position does not exist FOR THIS OWNER (cross-tenant included). */
export class LpPositionNotFoundError extends Error {
  readonly code = "LP_POSITION_NOT_FOUND";
  constructor(positionId: string) {
    super(`Position "${positionId}" not found for this owner.`);
    this.name = new.target.name;
  }
}

/** The named sequence does not exist FOR THIS OWNER (cross-tenant included). */
export class LpSequenceNotFoundError extends Error {
  readonly code = "LP_SEQUENCE_NOT_FOUND";
  constructor(sequenceId: string) {
    super(`Sequence "${sequenceId}" not found for this owner.`);
    this.name = new.target.name;
  }
}

export class LpPositionVersionConflictError extends Error {
  readonly code = "LP_POSITION_VERSION_CONFLICT";
  constructor(positionId: string) {
    super(`Position "${positionId}" changed after the resolver snapshot.`);
    this.name = new.target.name;
  }
}

export class LpPositionResolvingError extends Error {
  readonly code = "LP_POSITION_RESOLVING";
  constructor(positionId: string) {
    super(`Position "${positionId}" is held by a landing-resolution fence.`);
    this.name = new.target.name;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The ONE decision-id format an LP saga step uses in the execution journal
 * (Rev2 item 9). Shared namespace with `/execute` and `/trade`: a decision id
 * burned here cannot be reused by either route, or the other way round.
 */
export function lpStepDecisionId(sequenceId: string, stepIndex: number): string {
  return `lp:${sequenceId}:${stepIndex}`;
}

/**
 * The INVERSE of {@link lpStepDecisionId}: the sequence id inside an LP step's
 * decision id, or `null` when the string is not one (PHASE3.3).
 *
 * Lives beside the constructor deliberately — the format is this module's, and
 * a route that hand-split on `":"` would be a second definition of it, free to
 * drift. Strict: exactly three colon-separated fields, an `lp` prefix, a
 * non-empty sequence id and a non-negative decimal index, so a decision id
 * belonging to `/execute` or `/trade` (or a hand-crafted one) answers `null`
 * rather than a sequence id that happens to parse.
 */
export function lpSequenceIdOfStepDecision(decisionId: string): string | null {
  const parts = decisionId.split(":");
  if (parts.length !== 3) return null;
  const [prefix, sequenceId, index] = parts;
  if (prefix !== "lp") return null;
  if (sequenceId === undefined || sequenceId.length === 0) return null;
  if (index === undefined || !/^\d{1,9}$/.test(index)) return null;
  return sequenceId;
}

/**
 * Whether a sequence is finished for the worker's purposes.
 *
 * `completed` and `rolled-back` are always terminal. `active` and
 * `abandoning` never are. A
 * `held` sequence with a NAMED recovery state is NON-TERMINAL — the next
 * worker cycle owes it a resume (`pending-mint` under pause is a safe, stated,
 * resumable state — R6) — while `held` with `none` is an operator-parked
 * sequence with nothing left to recover.
 */
export function isTerminalLpSequence(
  state: LpSequenceState,
  recoveryState: LpRecoveryState,
): boolean {
  if (state === "completed" || state === "rolled-back") return true;
  if (state === "active" || state === "abandoning" || state === "resolving" ||
      state === "retiring-pre-bind") return false;
  return recoveryState === "none";
}

/**
 * Step outcome states, as reported by the execution journal. Structurally
 * identical to the journal's `JournalState` — deliberately NOT imported: the
 * store must not depend on the journal even at the type level, so that the
 * only way outcomes enter this module is as caller-supplied input.
 */
export type LpStepOutcomeState =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMMITTED"
  | "ROLLED_BACK"
  | "UNKNOWN";

export type LpSequenceProgress = {
  /**
   * What the sequence may do next:
   *   - `advance`: every recorded step is COMMITTED; `stepIndex` is where the
   *     NEXT step would be recorded (resume skips confirmed steps);
   *   - `hold`: `stepIndex` is ambiguous (UNKNOWN, still pending, or the
   *     journal row is missing). The sequence holds until `reconcile` resolves
   *     that row — ambiguity never auto-replays;
   *   - `roll-back`: `stepIndex` provably did not land (thrown above the
   *     submit ⇒ rolled back, per the positional classification). The DRIVER
   *     decides between retrying the step and rolling the sequence back — the
   *     store only reports the fact.
   */
  readonly disposition: "advance" | "hold" | "roll-back";
  readonly stepIndex: number;
  readonly confirmedSteps: number;
  readonly reason: string;
};

/**
 * Derive a sequence's progress by JOINING its recorded steps against journal
 * outcomes the CALLER fetched (keyed by `journalIdempotencyKey`). Pure: no
 * store, no journal, no chain — the join is the whole function, which is what
 * keeps outcome authority in the execution journal (Rev2 item 9).
 *
 * Steps are scanned in order; the first non-COMMITTED step decides. A missing
 * outcome is treated exactly like UNKNOWN — a conservative default for a pure
 * function that cannot know WHY the caller has no outcome for a key.
 *
 * DRIVER CONTRACT (audit A1): the saga drivers therefore pre-filter, BEFORE
 * calling this, any recorded step whose journal row does not exist — that
 * state is provably-never-submitted (`appendStep` → `begin` → submit is a
 * strict order, so a missing row means a crash before `begin`) and is an OPEN
 * slot to retry, not an ambiguous hold. Feeding such a step through this join
 * unfiltered would hold it forever: its key is derived from freshly-built
 * calldata and never re-derived, and `reconcile` iterates journal ROWS so it
 * can never resolve a row that was never created.
 */
export function deriveLpSequenceProgress(
  sequence: Pick<LpSequenceRecord, "steps">,
  outcomes: ReadonlyMap<string, LpStepOutcomeState>,
): LpSequenceProgress {
  let confirmed = 0;
  for (const step of sequence.steps) {
    const outcome = outcomes.get(step.journalIdempotencyKey);
    if (outcome === "COMMITTED") {
      confirmed += 1;
      continue;
    }
    if (outcome === "ROLLED_BACK") {
      return {
        disposition: "roll-back",
        stepIndex: step.index,
        confirmedSteps: confirmed,
        reason: `Step ${step.index} (${step.kind}) was rolled back before the submit.`,
      };
    }
    return {
      disposition: "hold",
      stepIndex: step.index,
      confirmedSteps: confirmed,
      reason:
        outcome === undefined
          ? `Step ${step.index} (${step.kind}) has no journal outcome; the submit window is ambiguous.`
          : // PHASE3.14 F4. This sentence is what `live-lp status` and the
            // sequence view put in front of the owner, and it is the sentence
            // the 08-25 live operator acted on. "Held until reconcile resolves
            // it" is TRUE for PENDING/IN_PROGRESS — those are exactly
            // reconcile's own query — and FALSE for UNKNOWN, which reconcile
            // has already disowned (`state in ('PENDING','IN_PROGRESS')`) and
            // will never look at again. Naming the wrong tool on the operator's
            // primary diagnostic surface is how a live position sat blocked
            // while four doors were tried in turn.
            outcome === "UNKNOWN"
            ? `Step ${step.index} (${step.kind}) is UNKNOWN; reconcile has already disowned it, so it is held until the owner-signed resolveUnknown action settles it.`
            : `Step ${step.index} (${step.kind}) is ${outcome}; held until reconcile resolves it.`,
    };
  }
  return {
    disposition: "advance",
    stepIndex: sequence.steps.length,
    confirmedSteps: confirmed,
    reason:
      sequence.steps.length === 0
        ? "No steps recorded yet."
        : "Every recorded step is confirmed.",
  };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

const POSITION_STATES: ReadonlySet<string> = new Set<LpPositionState>([
  "open",
  "closing",
  "closed",
]);

const SEQUENCE_STATES: ReadonlySet<string> = new Set<LpSequenceState>([
  "active",
  "completed",
  "held",
  "abandoning",
  "resolving",
  "retiring-pre-bind",
  "rolled-back",
]);

const RECOVERY_STATES: ReadonlySet<string> = new Set<LpRecoveryState>([
  "pending-mint",
  "pending-increase",
  "wbnb-stranded",
  // PHASE3.22 R5.2 site 2. `assertRecoveryState` reads this set on every row
  // load from BOTH backends, so a member missing here makes every persisted
  // shift row unreadable — the memory backend included, which is why this site
  // is not merely the Postgres CHECK's twin.
  "rotate-ambiguous",
  "shift-ambiguous",
  "none",
]);

const SEQUENCE_KINDS: ReadonlySet<string> = new Set<LpSequenceKind>([
  "protect",
  "rotate",
  "harvest",
  "open",
  "manual-exit",
  "grid-flip",
  "grid-arm",
  "grid-requote",
  "grid-recenter",
  // PHASE3.22 R2.19 — the tenth kind.
  "grid-shift",
]);

/**
 * PHASE3.15 R2.7 — the PER-KIND QUOTA SPLIT, as a map from kind to the daily
 * COUNT it is refused against.
 *
 * Two lanes, and the split is the point:
 *
 *   - `"exit"` — rotate and harvest, refused against `maxExitSequencesPerDay`,
 *     exactly as before;
 *   - `"grid"` — `grid-flip`, refused against its OWN `maxGridFlipsPerDay`,
 *     because a grid's whole point is to cycle and the shared exit quota would
 *     silently strangle it (the (ah) lesson: re-read caps against the strategy
 *     that actually runs). It does NOT occupy the exit count (PHASE3.7 F2's
 *     posture: a kind does not occupy a cap it is not refused by).
 *
 * BOTH LANES REMAIN VISIBLE TO THE SPACING ANCHOR (PHASE3.5 M3): the anchor is
 * agent-wide and unfiltered, because it is a pacing floor the owner signed and
 * the only bound on a reserve→refuse→roll-back loop. That is also why
 * `validateLpSettings` refuses a `maxFlipsPerDay` the anchor makes unreachable
 * — the gate that actually floors a grid's rate is the spacing one.
 *
 * A kind ABSENT from this map is quota-EXEMPT: `protect`, `manual-exit` and
 * `open` always get their accounting row and are never refused.
 *
 * PHASE3.16 R2.5 (review M6) — `grid-arm` MUST NOT APPEAR HERE, and the
 * prohibition is normative rather than a preference. `runLpOpen` calls
 * `reserveSequence` with NO try/catch, on the documented premise that its kind
 * is never quota-bound; a lane entry for `grid-arm` would therefore let
 * {@link LpExitQuotaError} escape `ownerMutation` untyped — a 500 on a money
 * route. `open`'s exemption-by-absence is the model, and an arm is not a flip:
 * it must not consume the flip lane either. Its reservation row is still
 * written (the spacing anchor counts exempt rows, which is why the FIRST flip
 * after an arm is floored by `minMinutesBetweenExits`).
 *
 * PHASE3.18 C7 — a THIRD lane, `"requote"`, bounded by
 * `grid.requote.maxRequotesPerDay`. Ruling Q6 gave the reason and it is SAFETY,
 * not the measured mix: a flip settles a fill that already happened while a
 * re-centre is discretionary, so a shared lane would let re-centres starve
 * settlements on exactly the day the market is moving.
 *
 * PHASE3.19 item 19 — a FOURTH lane, `"recenter"`, bounded by
 * `grid.ladder.maxMovesPerDay`. ALL ladder motions share it — fill-response and
 * drift-response alike — because D7's ruling is that they ARE the same motion,
 * and the one thing that must not happen is a drift move starving the fill
 * response that settles inventory.
 *
 * PHASE3.20 D1 — the FOURTH lane SPLITS IN TWO, and (az) is why: on chain, a
 * discretionary DRIFT move consumed the single `recenter` slot and the mandatory
 * FILL settlement then starved for the rest of the window. `"settlement"` and
 * `"drift"` are separate budgets over the same sequence KIND, so the lane cannot
 * be derived from the kind alone — it is a property of the ROW
 * (`lp_sequences.recenter_evidence`, copied onto
 * `lp_exit_reservations.quota_lane` at reserve).
 *
 * `"recenter"` IS DELIBERATELY RETAINED IN THIS UNION (R3.3, clearance N2.1).
 * Retiring it looked tidy and fails OPEN: `quotaBound = lane !== undefined` at
 * both backends, so a `grid-recenter` whose kind mapped to nothing would become
 * quota-EXEMPT — unbounded motions, and simultaneously excluded from the exit
 * lane's leftover subtraction. It stays a TOTAL mapping so `quotaBound` stays
 * `true`, and {@link reservationQuotaLane} then overrides it from the row.
 */
type LpQuotaLane =
  | "exit"
  | "grid"
  | "requote"
  | "recenter"
  | "settlement"
  | "drift"
  | "shift-settle"
  | "shift-drift";

/**
 * PHASE3.20 D1 — the EVIDENCE a ladder motion fired on, as it is persisted on
 * `lp_sequences.recenter_evidence` and as the lane it charges.
 */
export type LpRecenterEvidence = "settlement" | "drift";

/** PHASE3.23 R2.1 — durable authorization discriminator for a grid shift. */
export type LpShiftCause = "cross" | "drift";
type LpPersistedQuotaLane = LpRecenterEvidence | "shift-settle" | "shift-drift";

const QUOTA_LANE_BY_KIND: ReadonlyMap<LpSequenceKind, LpQuotaLane> = new Map<
  LpSequenceKind,
  LpQuotaLane
>([
  ["rotate", "exit"],
  ["harvest", "exit"],
  ["grid-flip", "grid"],
  ["grid-requote", "requote"],
  ["grid-recenter", "recenter"],
  /**
   * PHASE3.22 R2.21 — and OMITTING this entry FAILS OPEN, which is why it is
   * called out rather than merely added: a kind absent from this map is
   * quota-EXEMPT (`quotaLaneOf` returns `undefined`, so `#assertQuota` is never
   * reached) AND excluded from leftover subtraction, so every shift would be
   * both unbounded and invisible to the other lanes' counts.
   */
  ["grid-shift", "shift-settle"],
]);

/** The lane a reservation ROW belongs to, derived from the kind it stores. */
function quotaLaneOf(kind: LpSequenceKind): LpQuotaLane | undefined {
  return QUOTA_LANE_BY_KIND.get(kind);
}

/** Is this string one of the two ladder lanes? Anything else reads as absent. */
function asRecenterEvidence(value: unknown): LpRecenterEvidence | null {
  return value === "settlement" || value === "drift" ? value : null;
}

function asShiftCause(value: unknown): LpShiftCause | null {
  return value === "cross" || value === "drift" ? value : null;
}

/**
 * PHASE3.20 R3.3 / C5 — THE LANE OF AN EXISTING RESERVATION ROW, and the ONE
 * place the "stored lane overrides the kind" rule is written.
 *
 * Every seam that COMPARES a lane reads this: the memory `#assertQuota` count
 * filter, the Postgres reserve window filter, and the memory `quotaUsage`
 * classification. (The Postgres `quotaUsage` aggregates are SQL literals and
 * carry the same rule in SQL — see B1.)
 *
 * A `grid-recenter` ROW WITH NO STORED LANE COUNTS AS **SETTLEMENT** (N2.3).
 * Pre-migration rows in flight at upgrade would otherwise fall out of BOTH new
 * counts and become free capacity for a rolling 24 h, and
 * `settlementLiveCount + driftLiveCount === recenterLiveCount` — the identity
 * that keeps the reported `recenter` SUM honest — would break by exactly their
 * number. Charging them to settlement is also the enforcement-correct answer:
 * under the legacy interpretation the settlement limit IS `maxMovesPerDay`, the
 * same bound those rows were reserved under.
 */
function reservationQuotaLane(
  kind: LpSequenceKind,
  storedLane: unknown,
): LpQuotaLane | undefined {
  const derived = quotaLaneOf(kind);
  if (derived === "shift-settle") {
    return storedLane === "shift-drift" ? "shift-drift" : "shift-settle";
  }
  if (derived !== "recenter") return derived;
  return asRecenterEvidence(storedLane) ?? "settlement";
}

/**
 * PHASE3.20 — the lane a NEW reservation is refused against.
 *
 * For every non-ladder kind this is `quotaLaneOf(kind)` and the path is
 * byte-identical to 3.19's. For `grid-recenter` the caller supplies the
 * evidence the trigger fired on (persisted at CREATE, so a RESUME reads it off
 * the row rather than re-deriving it from a trigger evaluation that does not
 * run — C6); an absent one is `"settlement"`, the same conservative reading a
 * NULL stored lane gets.
 */
function reserveQuotaLane(
  kind: LpSequenceKind,
  evidence: LpRecenterEvidence | undefined,
  shiftCause?: LpShiftCause | null,
): LpQuotaLane | undefined {
  const derived = quotaLaneOf(kind);
  if (derived === "shift-settle") {
    return shiftCause === "drift" ? "shift-drift" : "shift-settle";
  }
  if (derived !== "recenter") return derived;
  return evidence ?? "settlement";
}

/**
 * The daily count a lane is refused against. Absent grid/requote limit ⇒ FAIL
 * CLOSED at zero, and the `?? 0` is load-bearing rather than defensive: a
 * caller that dispatches into a lane without supplying its limit is refused,
 * never admitted on a default nobody signed.
 */
function quotaLimitFor(lane: LpQuotaLane, quota: LpExitQuota): number {
  switch (lane) {
    case "grid":
      return quota.maxGridFlipsPerDay ?? 0;
    case "requote":
      return quota.maxRequotesPerDay ?? 0;
    // PHASE3.20 D1 — the two ladder lanes. `recenter` survives as a lane VALUE
    // (R3.3: retiring it makes `quotaBound` fail open) but is never the lane a
    // live dispatch is refused against, because `reserveQuotaLane` maps every
    // `grid-recenter` onto one of the two below. Its arm answers the legacy
    // limit so a hand-built caller is still bounded rather than exempt.
    // The `?? maxMovesPerDay` tail is a COMPATIBILITY FALLBACK for a quota
    // object that carries only the deprecated field, and it is NOT a second
    // authority on the legacy interpretation: every wired path builds this
    // object through `ladderMotionCounts` and therefore supplies BOTH counts, so
    // the fallback is unreachable from the worker. It exists so a caller holding
    // a 3.19-shaped quota is still BOUNDED at the number that quota names,
    // rather than refused at zero for a field it could not have known about.
    // The drift lane has no such tail: a legacy signature authorized NO
    // discretionary motion, so zero is its correct — and only — reading.
    case "settlement":
      return quota.maxSettlementsPerDay ?? quota.maxMovesPerDay ?? 0;
    case "drift":
      return quota.maxDriftMovesPerDay ?? 0;
    case "recenter":
      return quota.maxMovesPerDay ?? 0;
    // PHASE3.22 R2.21 / PHASE3.23 R3.3 — the shift caps. FAIL-CLOSED AT ZERO
    // like their grid siblings and for the same load-bearing reason: a caller that dispatches
    // a shift without supplying `maxShiftsPerDay` is REFUSED, never admitted on
    // a default nobody signed. There is deliberately no compatibility tail of
    // the `settlement` arm's kind — shift mode is brand new, so no signature
    // predates the field and there is no older bound to fall back to.
    case "shift-settle":
      return quota.maxShiftsPerDay ?? 0;
    case "shift-drift":
      return quota.maxShiftDriftPerDay ?? 0;
    case "exit":
      return quota.maxExitSequencesPerDay;
  }
}

/** Checksum-validate then lower an owner address (same key as agents.ts). */
function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

function ownerKeyFromStorage(value: string): Address {
  return ownerKey(getAddress(value));
}

/**
 * `from → to` legality for a position. Same-state is an idempotent no-op.
 * `closed` is terminal; `closing → open` is legal because an aborted exit
 * (rolled back above the submit) puts the position back in play.
 */
function assertPositionTransition(
  from: LpPositionState,
  to: LpPositionState,
): void {
  if (from === to) return;
  const legal: Record<LpPositionState, readonly LpPositionState[]> = {
    open: ["closing", "closed"],
    closing: ["open", "closed"],
    closed: [],
  };
  if (!legal[from].includes(to)) {
    throw new Error(`Illegal LP position transition ${from} → ${to}.`);
  }
}

/**
 * `from → to` legality for a sequence. `held → active` is the resume path
 * after `reconcile` resolves a step; the two finished states are terminal.
 */
function assertSequenceTransition(
  from: LpSequenceState,
  to: LpSequenceState,
): void {
  if (from === to) return;
  const legal: Record<LpSequenceState, readonly LpSequenceState[]> = {
    active: ["completed", "held", "rolled-back"],
    held: ["active", "completed", "rolled-back"],
    // Only the named abandon-claim methods enter or leave this state. Keeping
    // `active` out is the cross-process fence: a worker that selected the old
    // HELD snapshot cannot resume after the route's CAS wins.
    abandoning: [],
    resolving: [],
    "retiring-pre-bind": [],
    completed: [],
    "rolled-back": [],
  };
  if (!legal[from].includes(to)) {
    throw new Error(`Illegal LP sequence transition ${from} → ${to}.`);
  }
}

function assertPositionState(value: string): LpPositionState {
  if (!POSITION_STATES.has(value)) {
    throw new Error(`Unknown LP position state "${value}".`);
  }
  return value as LpPositionState;
}

function assertSequenceState(value: string): LpSequenceState {
  if (!SEQUENCE_STATES.has(value)) {
    throw new Error(`Unknown LP sequence state "${value}".`);
  }
  return value as LpSequenceState;
}

function assertRecoveryState(value: string): LpRecoveryState {
  if (!RECOVERY_STATES.has(value)) {
    throw new Error(`Unknown LP recovery state "${value}".`);
  }
  return value as LpRecoveryState;
}

function assertSequenceKind(value: string): LpSequenceKind {
  if (!SEQUENCE_KINDS.has(value)) {
    throw new Error(`Unknown LP sequence kind "${value}".`);
  }
  return value as LpSequenceKind;
}

function clearResolverClaim(_current: LpSequenceRecord): Pick<
  LpSequenceRecord,
  | "resolverPriorState" | "resolverPriorRecoveryState" | "resolverLeaseUntil"
  | "resolverSnapshotHash" | "resolutionId" | "resolverActionIdempotencyKey"
  | "resolutionDispositionStarted"
> {
  return {
    resolverPriorState: null,
    resolverPriorRecoveryState: null,
    resolverLeaseUntil: null,
    resolverSnapshotHash: null,
    resolutionId: null,
    resolverActionIdempotencyKey: null,
    resolutionDispositionStarted: false,
  };
}

function clearRetirementClaim(_current: LpSequenceRecord): Pick<
  LpSequenceRecord,
  | "retirementPriorState" | "retirementPriorRecoveryState"
  | "retirementTargetJournalKey" | "retirementActionIdempotencyKey"
  | "retirementLeaseUntil" | "retirementSnapshotHash"
  | "retirementDispositionStarted"
> {
  return {
    retirementPriorState: null,
    retirementPriorRecoveryState: null,
    retirementTargetJournalKey: null,
    retirementActionIdempotencyKey: null,
    retirementLeaseUntil: null,
    retirementSnapshotHash: null,
    retirementDispositionStarted: false,
  };
}

/**
 * Read a `numeric(78, 0)` back as a bigint. Same posture as the journal's
 * spend parser: a malformed basis THROWS rather than defaulting to `0n`,
 * because an under-read basis silently disarms the stop-loss it exists for.
 */
function toWei(value: string | number | null): bigint {
  if (value === null) return 0n;
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error("LP position basis_wei is not an integer.");
  }
  return BigInt(text);
}

/* -------------------------------------------------------------------------- */
/* The interface                                                              */
/* -------------------------------------------------------------------------- */

export type LpArmFenceContext = {
  readonly listPositions: () => Promise<LpPositionRecord[]>;
  readonly getAnyNonTerminalSequence: () => Promise<LpSequenceRecord | null>;
  readonly putSettings: (
    settingsStore: LpSettingsStore,
    input: PutLpSettingsInput,
  ) => Promise<LpSettingsRecord>;
  readonly createPosition: (input: CreateLpPositionInput) => Promise<LpPositionRecord>;
};

function assertArmFenceScope(
  ownerAddress: Address,
  agentId: string,
  input: { readonly ownerAddress: Address; readonly agentId: string },
): void {
  if (
    ownerKey(input.ownerAddress) !== ownerKey(ownerAddress) ||
    input.agentId !== agentId
  ) {
    throw new Error("LP arm-fence write escaped its owner or agent scope.");
  }
}

export interface LpSequenceStore {
  /** Memory-only rollback participant for the no-SQL landing finalizer. */
  snapshotLandingResolutionTransaction?(input: {
    readonly positionId: string; readonly sequenceId: string;
  }): unknown;
  restoreLandingResolutionTransaction?(snapshot: unknown): void;
  /** Serialize LP arm admission for one owner+agent across the idle gate and insert. */
  withArmFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: (fence: LpArmFenceContext) => Promise<T>,
  ): Promise<T>;
  /* ----- positions ----- */
  createPosition(input: CreateLpPositionInput): Promise<LpPositionRecord>;
  /** The position, or `null` when absent OR owned by someone else. */
  getPosition(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpPositionRecord | null>;
  listPositions(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpPositionRecord[]>;
    listOwnerPositionsBounded(
    ownerAddress: Address,
    agentIds: readonly string[],
    states: readonly ("open" | "closing")[],
      limit: number,
      signal?: AbortSignal,
  ): Promise<{ readonly rows: readonly LpPositionRecord[]; readonly hasMore: boolean }>;
  /**
   * The owner's-and-agent's NON-CLOSED position row claiming `tokenId`, or
   * `null` (PHASE3.4 Rev2 M5).
   *
   * Owner-AND-agent scoped on purpose, and the scope is the feature: it answers
   * exactly one question — "is this MY agent's row?" — which is the only
   * question whose answer may be spoken aloud. A tokenId claimed by another
   * tenant answers `null` here and the caller falls back to the generic
   * refusal, so the two voices cannot leak into one another.
   */
  getPositionByTokenId(
    ownerAddress: Address,
    agentId: string,
    tokenId: string,
  ): Promise<LpPositionRecord | null>;
  /**
   * Record the worker's ownership finding (PHASE3.4 Rev2 M6). `count` is the
   * new consecutive-mismatch total (0 clears, and clears the reason with it).
   * Never called on a read FAILURE — an outage must leave the counter alone.
   * Throws {@link LpPositionNotFoundError} when unowned.
   */
  setOwnershipMismatch(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: {
      readonly count: number;
      readonly reason: string | null;
      /**
       * The frozen CYCLE CLOCK of the first confirmation in this run (F1). The
       * caller passes the existing anchor when one is held, so a later
       * confirmation of the same mismatch never moves it; `count: 0` clears it
       * with the rest.
       */
      readonly firstSeenAtMs: number | null;
    },
    expectedRowVersion?: number,
  ): Promise<LpPositionRecord>;
  /**
   * Record the NFT id from a confirmed mint receipt — at `/lp/open` AND on
   * every rotate. Deliberately the ONLY field this touches: a rotate changes
   * the token on the SAME lineage, so `lineageId`/`basisWei` are untouched by
   * construction (R7). Throws {@link LpPositionNotFoundError} when unowned,
   * and refuses a closed position.
   */
  updatePositionTokenId(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    tokenId: string,
    expectedRowVersion?: number,
    /**
     * PHASE3.18 R2.6 — the durable grid ROLE, written by the SAME write that
     * sets the tokenId so the two can never disagree.
     *
     * The FLIP is the one caller that supplies it: a flip INVERTS the role at
     * exactly the moment it replaces the tokenId, and the role is the half of
     * the identity the chain cannot answer (the side inverts on a fill, which
     * is the one moment it is consulted). Every other caller omits it and the
     * column is left exactly as it was — a requote keeps its side by
     * construction, and a rotate has no grid identity at all.
     */
    gridRole?: LpGridRoleValue,
  ): Promise<LpPositionRecord>;
  /**
   * PHASE3.18 R2.6 (M7) — BACKFILL the durable grid identity, for the ONE
   * moment it is provable: the re-sign that switches a live grid from fixed to
   * policy mode.
   *
   * Until that instant every live rung still equals a signed rung exactly, so
   * `gridLiveRole` can answer; a tick later a requote may have moved one and
   * the answer is gone for ever. That is why the migration happens HERE and why
   * ANY live level failing to match REFUSES THE WHOLE RE-SIGN rather than
   * leaving one row unlabelled.
   *
   * It writes ONLY these two columns. It is deliberately NOT a general "set the
   * role" seam: the role's other writer is the flip's own tokenId update, where
   * it rides an atomic write, and a second general mutator would be a second
   * authority on the one fact the chain cannot answer.
   */
  setGridIdentity(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    identity: {
      readonly gridLevel: LpGridLevelValue;
      readonly gridRole: LpGridRoleValue;
    },
  ): Promise<LpPositionRecord>;
  /**
   * PHASE3.19 R4.1 / D1-D4 — ADVANCE THE LADDER'S VWAP BOOK by one credit,
   * IDEMPOTENTLY, keyed on the step's JOURNAL IDEMPOTENCY KEY.
   *
   * ─── WHY A SET AND NOT A SLOT (N16) ───────────────────────────────────────
   *
   * `sagas.ts`'s replay loop re-runs EVERY confirmed step's `after` on EVERY
   * resume, and FINDINGS (aw) records resume as the DEFAULT path on this relay
   * (6 of 6 mainnet submissions). A single "last applied" slot does not survive
   * that: a `grid-recenter` sequence has TWO book-writing afters, so a replay in
   * plan order re-admits the earlier one after the later one has written, and
   * the slot thrashes between the two keys without ever converging. The shared
   * anchor book (C4) makes it worse — two rows' sequences interleave on one slot
   * — and no "monotone (sequenceId, stepIndex)" repair fixes that, because a
   * sequence-id change always re-admits.
   *
   * So the guard is a SET, in an append-only table whose PRIMARY KEY is the
   * step's journal idempotency key. That key is
   * `executeIdempotencyKey(agentId, lpStepDecisionId(sequenceId, recordedCount),
   * callsHash)` — agent-, sequence- AND step-scoped, globally unique — and it is
   * READ BACK FROM THE STORED STEP ROW on replay, never recomputed, so the
   * replayed insert presents exactly the key the live write used.
   *
   * ─── THE TRANSACTION (D4), AND WHY IT MAY HOLD ────────────────────────────
   *
   * `insert ... on conflict do nothing`, then — ONLY when the insert actually
   * inserted — an IN-SQL increment of the anchor row (`set x = x + $d`, with the
   * `row_version` bump), both in ONE transaction.
   *
   * THE BOOK WRITE IS NOT DERIVED TELEMETRY. `gridCycles` is, and its write is
   * deliberately fire-and-forget because a lost accounting row must never hold a
   * sequence. This one is an INPUT TO A MONEY DECISION — the markout gate reads
   * it — so it is allowed to THROW into `POST_VERIFY_FAILED`/HELD, which is
   * RECOVERABLE. Wrapping it in the `gridCycles` catch would be a
   * PERMANENT-LOSS bug: if the insert committed and the anchor update were
   * swallowed, the key would be taken for ever and the replayed insert a no-op,
   * so the credit could never be applied. Inside the transaction a throw rolls
   * BOTH statements back and the replay retries cleanly.
   *
   * ─── THE CLAMP IS ON THE DELTA, AT WRITE TIME (D1) ────────────────────────
   *
   * A deduction is persisted as `-min(requested, currentBookBase)`, with the
   * COST leg deducted in lockstep and PROPORTIONALLY
   * (`costDelta = -bookCost x clampedBase / bookBase`, and exactly `-bookCost`
   * when the clamp empties the book). Never a clamp on the running COLUMN: the
   * two are different functions (`+10, -15, +20` gives 20 clamping the running
   * value and 15 clamping the sum), so a column clamp would make
   * "book = sum of distinct credits" FALSE the moment one ever fired — and would
   * make the two backends compute different books, which item 49 requires to
   * agree. The caller's requested COST delta is therefore IGNORED on a
   * deduction, in favour of the book average; on a credit both pass through.
   *
   * Returns whether the credit was APPLIED (false ⇒ the key was already present,
   * i.e. this is a replay) and the CLAMPED deltas that were stored.
   */
  applyInventoryCredit(
    ownerAddress: Address,
    agentId: string,
    input: {
      /** The step's journal idempotency key. The PRIMARY KEY; nothing derived. */
      readonly applicationKey: string;
      /** The ANCHOR row (C4) — the group member whose book columns are non-null. */
      readonly positionId: string;
      readonly armGroupId: string | null;
      /** Signed, REQUESTED. Clamped at write time per D1. */
      readonly deltaBaseWei: bigint;
      readonly deltaCostWbnbWei: bigint;
    },
  ): Promise<{
    readonly applied: boolean;
    readonly deltaBaseWei: bigint;
    readonly deltaCostWbnbWei: bigint;
  }>;
  /**
   * PHASE3.19 — the anchor row's BOOK, or `null` when the row is not an anchor.
   *
   * Read by the markout gate and by the owner view. A `null` answer is the
   * fail-closed one: the gate refuses rather than dividing by a book that does
   * not exist.
   */
  readInventoryBook(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<{ readonly baseWei: bigint; readonly costWbnbWei: bigint } | null>;
  /**
   * PHASE3.19 R4.1 — the SUM over this anchor's distinct credit rows.
   *
   * The invariant item 49 tests: after any number of replays, on BOTH backends,
   * there is exactly one credit row per key and the anchor's columns EQUAL this
   * sum. Also the owner view's honest source for "how many credits is this book
   * made of".
   */
  sumInventoryCredits(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<{
    readonly count: number;
    readonly baseWei: bigint;
    readonly costWbnbWei: bigint;
  }>;
  /**
   * Move the position's lifecycle state. Transitioning to `closed` CLOSES THE
   * LINEAGE: `basisWei` resets to `0n` in the same write (R7 — the basis dies
   * with the lineage; a later re-open mints a new lineage with a fresh
   * owner-signed basis). Throws {@link LpPositionNotFoundError} when unowned.
   */
  setPositionState(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    state: LpPositionState,
    expectedRowVersion?: number,
    /**
     * PHASE3.22 R4.2.2 — the close CAUSE, recorded on
     * {@link LpPositionRecord.closeReason}. Written only when `state` is
     * `"closed"` and only when supplied, so every pre-3.22 call site is
     * byte-identical and an omitted reason never clears a recorded one.
     */
    closeReason?: string,
  ): Promise<LpPositionRecord>;

  /* ----- sequences ----- */
  /**
   * Create a sequence `active` with no steps. ONE non-terminal sequence per
   * position: enforced by a unique partial index on Postgres and an explicit
   * scan in memory; a second create throws {@link LpActiveSequenceError}.
   * "Non-terminal" is {@link isTerminalLpSequence}'s answer, so a held
   * sequence with a pending recovery also blocks new sequences — two sagas on
   * one position is exactly the double-drive this constraint exists to stop.
   */
  createSequence(input: CreateLpSequenceInput): Promise<LpSequenceRecord>;
  getSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpSequenceRecord | null>;
  /** The position's one non-terminal sequence, or `null`. */
  getNonTerminalSequence(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpSequenceRecord | null>;
  /**
   * ANY non-terminal sequence anywhere under this owner+agent, or `null`
   * (PHASE3.4 audit A5).
   *
   * The quiescence check at `POST /lp/import` needs "is this agent busy?", and
   * the first build answered it by loading `listSequences` — unbounded, never
   * pruned, one row per harvest/rotate/protect for the life of the agent — and
   * filtering in JS, on a route reachable with a replayable signed `read`
   * header. The partial non-terminal index already has
   * the predicate; this is the agent-scoped probe over it.
   */
  getAnyNonTerminalSequence(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord | null>;
  listSequences(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord[]>;
  /**
   * Record the NEXT step's identity before its journal `begin`. The step's
   * `index` is assigned here (order authority) and its `journalDecisionId` is
   * derived via {@link lpStepDecisionId} — never caller-supplied, so the
   * format cannot drift per call site. No outcome is recorded, ever.
   */
  appendStep(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    step: { readonly kind: LpStepKind; readonly journalIdempotencyKey: string; readonly priorTokenId?: string },
  ): Promise<LpSequenceStep>;
  setSequenceState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    state: LpSequenceState,
  ): Promise<LpSequenceRecord>;
  /**
   * Atomically claim the exact HELD snapshot for owner-signed abandonment.
   * A stale `abandoning` lease may be reclaimed after one worker interval so
   * a process crash cannot brick the sequence. `null` means the CAS lost.
   */
  claimSequenceForAbandon(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedUpdatedAt: number;
      readonly claimId: string;
      readonly nowMs: number;
      readonly minIdleMs: number;
    },
  ): Promise<LpSequenceRecord | null>;
  /** Persist the point after which a failed route must stay claimed for retry. */
  beginSequenceAbandonDisposition(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null>;
  /** Release only a claim whose disposition write has not begun. */
  releaseSequenceAbandonClaim(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null>;
  /** Terminal latch after the position disposition is safely applied. */
  completeSequenceAbandon(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null>;
  /** Exact ACTIVE/HELD UNKNOWN snapshot claim owned only by landing resolver. */
  claimSequenceForLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedState: "active" | "held";
      readonly expectedRecoveryState: LpRecoveryState;
      readonly expectedUpdatedAt: number;
      readonly expectedPositionId: string;
      readonly expectedPositionVersion: number;
      readonly expectedResolverRowVersion: number;
      readonly resolutionId: string;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null>;
  reclaimSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly expectedFence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly nowMs: number;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null>;
  beginSequenceLandingDisposition(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
  ): Promise<LpSequenceRecord | null>;
  setSequenceLandingRecovery(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly fence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly recoveryState: LpRecoveryState;
      readonly note: string;
    },
  ): Promise<LpSequenceRecord | null>;
  setPositionStateForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: {
      readonly sequenceId: string; readonly resolutionId: string; readonly fence: bigint;
      readonly expectedResolverRowVersion: number; readonly expectedPositionVersion: number;
      readonly state: LpPositionState;
    },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null>;
  updatePositionTokenIdForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: {
      readonly sequenceId: string; readonly resolutionId: string; readonly fence: bigint;
      readonly expectedResolverRowVersion: number; readonly expectedPositionVersion: number;
      readonly tokenId: string;
    },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null>;
  releaseSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
  ): Promise<LpSequenceRecord | null>;
  finishSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly fence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly targetState: "active" | "rolled-back";
    },
  ): Promise<LpSequenceRecord | null>;
  /**
   * Claim the narrow 3.9c pre-bind retirement shape. The existing resolver
   * fence columns carry this lease too, but the dedicated state keeps it out
   * of both the worker and the landing-evidence resolver.
   */
  claimSequenceForPreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedState: "active" | "held";
      readonly expectedRecoveryState: LpRecoveryState;
      readonly expectedUpdatedAt: number;
      readonly expectedPositionId: string;
      readonly expectedPositionVersion: number;
      readonly expectedRetirementRowVersion: number;
      readonly targetJournalKey: string;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null>;
  reclaimSequenceForPreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly targetJournalKey: string;
      readonly expectedFence: bigint;
      readonly expectedRetirementRowVersion: number;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly nowMs: number;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null>;
  beginSequencePreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    targetJournalKey: string,
    fence: bigint,
    expectedRetirementRowVersion: number,
  ): Promise<LpSequenceRecord | null>;
  setPositionStateForPreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: {
      readonly sequenceId: string; readonly targetJournalKey: string; readonly fence: bigint;
      readonly expectedRetirementRowVersion: number; readonly expectedPositionVersion: number;
      readonly state: LpPositionState;
    },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null>;
  finishSequencePreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly targetJournalKey: string;
      readonly fence: bigint;
      readonly expectedRetirementRowVersion: number;
    },
  ): Promise<LpSequenceRecord | null>;
  /**
   * Record (or clear) the sequence's operator-facing note — PHASE3.1 Rev2
   * item 15's ONE new field. Additive and outcome-free: it explains a SKIPPED
   * plan position to the owner and is never read by any decision. Allowed on a
   * terminal sequence, because the driver writes it as the sequence is
   * completing. Throws {@link LpSequenceNotFoundError} when unowned.
   */
  setSequenceNote(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    note: string | null,
  ): Promise<LpSequenceRecord>;
  /**
   * PHASE3.24 C3 — persist the confirmed inline residue idempotently. A
   * different second value is receipt inconsistency and must refuse.
   */
  recordInlineResidue(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    residueBaseWei: bigint,
    note: string | null,
  ): Promise<LpSequenceRecord>;
  /** Refused on a terminal (`completed`/`rolled-back`) sequence. */
  setRecoveryState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    recoveryState: LpRecoveryState,
  ): Promise<LpSequenceRecord>;
  /**
   * PHASE3.19 item 8 — PERSIST THE LADDER HEDGE'S SWAP INTENT before the swap is
   * submitted.
   *
   * WRITE-ONCE BY CONTRACT and by implementation: a row that already carries an
   * intent is left EXACTLY as it is and the stored one is returned, so no path
   * can overwrite it — which is item 46's mutation ("overwrites the persisted
   * `hedge_amount_in_wei` on resume instead of throwing must die"). The
   * DISAGREEMENT throw lives at the two guards that can see a second intent (the
   * runner and `buildGridRecenterDeps`), exactly as the 3.18 target's does.
   *
   * Throws {@link LpSequenceNotFoundError} when unowned.
   */
  setHedgeIntent(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    intent: {
      readonly direction: "wbnb-to-token" | "token-to-wbnb";
      readonly amountInWei: bigint;
    },
  ): Promise<LpSequenceRecord>;
  /**
   * Record the outcome of a resume that PARKED the sequence again, as the
   * stall latch's evidence (PHASE3.11 F1). Same `stallCode` as the row's ⇒
   * `stallCount + 1`; a different one ⇒ the count restarts at 1, which is how
   * any progress — a new step, a different refusal, a settled row — releases
   * the latch.
   *
   * DERIVED state that gates only the WORKER's own backoff, never a
   * disposition: a terminal or fenced row is left exactly as it is rather than
   * throwing, because failing to latch costs one more resume and nothing else.
   * Throws {@link LpSequenceNotFoundError} when unowned.
   */
  recordSequenceStall(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    stallCode: string,
  ): Promise<LpSequenceRecord>;

  /* ----- worker queue (PHASE3 "Worker") ----- */
  /**
   * Every OPEN position, across all owners — the worker's trigger queue.
   *
   * WORKER-ONLY, and the scope carve-out is deliberate and narrow: the
   * "every query owner-scoped" contract governs the REQUEST-SERVING surface,
   * where a caller names a scope and must not see across it. The worker has no
   * caller and no scope — it is the server's own automation walking its whole
   * work queue, exactly as the 0G `lp-worker` enumerated its journal. Nothing
   * reachable from HTTP calls this, and the row's own `ownerAddress` remains
   * authoritative for everything dispatched downstream (the saga deps are
   * built from the agent row it names, same as `getAgentById`'s one caller).
   */
  listOpenPositionsForWorker(): Promise<LpPositionRecord[]>;
  /**
   * Every NON-TERMINAL sequence, across all owners — the worker's resume
   * queue, checked BEFORE any new trigger work per the spec's cycle order.
   * Same worker-only carve-out as {@link listOpenPositionsForWorker}.
   */
  listNonTerminalSequencesForWorker(): Promise<LpSequenceRecord[]>;
  listFeeRepairSequencesForWorker?(input: { after: { createdAt: number; sequenceId: string } | null; limit: number; deadlineMs: number; signal: AbortSignal }): Promise<LpSequenceRecord[]>;

  /* ----- reservations (Rev2 items 11 + 13) ----- */
  /**
   * Reserve the sequence against the agent's rolling exit quota BEFORE any
   * money moves. Idempotent: a sequence's second reservation returns the
   * first row unchanged.
   *
   * THE ASYMMETRY IS THE POINT (R4 / Rev2 item 13): rotate and harvest are
   * quota-bound — over `maxExitSequencesPerDay` in the rolling 24h window or
   * inside `minMinutesBetweenExits` of the last reservation, this THROWS
   * {@link LpExitQuotaError}. Protect, manual exit and open ALWAYS get their
   * reservation row written (accounting — the R4 gas-reserve derivation is
   * honest only if every gas-drawing sequence is counted) and NEVER throw on
   * quota: a protect is terminal per position, and rate-limiting it is a
   * stop-loss that does not stop.
   *
   * HARVEST SHARES THE EXIT QUOTA — the 0G behaviour, and the choice Rev2
   * item 11 requires the spec to make: one `maxExitSequencesPerDay` bounds
   * rotate + harvest together, so the R4 reserve derivation is
   * `N = maxExitSequencesPerDay` with no separate harvest allowance.
   *
   * Counting includes the accounting-only rows: every reservation is a
   * sequence that draws relay gas from the same on-chain native meter, so a
   * protect that fired this window narrows what rotate/harvest may still
   * spend — fail-closed on the rate-limited kinds, never on the protective
   * ones. Reservations are never released in v1 (a rolled-back sequence still
   * consumed its slot — conservative, and simpler than 0G's release path).
   */
  reserveSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    quota: LpExitQuota,
    /**
     * PHASE3.20 item 7 — WHICH LADDER LANE this reservation charges, when the
     * kind alone cannot say.
     *
     * OPTIONAL, and its absence reproduces 3.19's behaviour byte for byte on
     * every non-ladder path: the lane is `quotaLaneOf(kind)`. For a
     * `grid-recenter` it falls back to the sequence row's own persisted
     * `recenterEvidence` and then to SETTLEMENT (C6) — never to "exempt".
     */
    laneEvidence?: LpRecenterEvidence,
  ): Promise<LpExitReservation>;
  getReservation(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpExitReservation | null>;
  /**
   * Give the slot back (PHASE3.5). IDEMPOTENT, and a NO-OP when no reservation
   * row exists — the quota-REFUSED path rolls its sequence back with no
   * reservation in existence (the insert went back with the transaction), and
   * must not error.
   *
   * THE CALLER OWNS THE PREDICATE, not this store: the evidence lives in the
   * execution journal, which the store cannot read. The rule the callers apply
   * (PHASE3.5 Rev2 M1) is that EVERY recorded step's journal row is absent, or
   * `ROLLED_BACK` carrying no `resolution`, no `callsId` and no `txHash` —
   * deliberately NARROWER than `driveSequence`'s retry predicate, which admits
   * two rows that DID reach a relay (the FAILED-receipt rollback, and
   * `reconcile`'s FAILED resolution). Those drew gas, and this limit is a proxy
   * for gas.
   */
  releaseReservation(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<void>;
  /**
   * What the OWNER is told about their own automation budget (PHASE3.5
   * decision 4). One window pass over the `(agent_id, reserved_at)` index.
   *
   * It exists because nothing reported this: an owner can SIGN
   * `maxExitSequencesPerDay` and, when the daemon refused a harvest every
   * minute for hours on mainnet, the only place that fact lived was one log
   * line on the operator's terminal — the (ae) family, where the system knows
   * and the dashboard does not.
   */
  quotaUsage(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpQuotaUsage>;

  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Process-local store for development and tests. Quota checks and the
 * one-non-terminal check run with no `await` between read and write, so a
 * single event-loop turn is the memory equivalent of one transaction.
 */
export class MemoryLpSequenceStore implements LpSequenceStore {
  readonly #positions = new Map<string, LpPositionRecord>();
  readonly #sequences = new Map<string, LpSequenceRecord>();
  readonly #abandonClaims = new Map<
    string,
    {
      readonly claimId: string;
      readonly claimedAtMs: number;
      readonly dispositionStartedAtMs: number | null;
    }
  >();
  readonly #reservations = new Map<string, LpExitReservation>();
  /**
   * PHASE3.19 R4.1 / D3 — the memory twin of `lp_inventory_credits`: a SET keyed
   * on the step's journal idempotency key, plus the CLAMPED delta each key
   * stored. Owner- and agent-scoped on every read, like every other table here.
   */
  readonly #inventoryCredits = new Map<string, LpInventoryCreditRecord>();
  readonly #armFences = new Map<string, Promise<void>>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  snapshotLandingResolutionTransaction(input: {
    readonly positionId: string; readonly sequenceId: string;
  }): unknown {
    return structuredClone({ ...input,
      position: this.#positions.get(input.positionId) ?? null,
      sequence: this.#sequences.get(input.sequenceId) ?? null,
      abandonClaim: this.#abandonClaims.get(input.sequenceId) ?? null,
      reservation: this.#reservations.get(input.sequenceId) ?? null });
  }

  restoreLandingResolutionTransaction(snapshot: unknown): void {
    const state = snapshot as {
      readonly positionId: string; readonly sequenceId: string;
      readonly position: LpPositionRecord | null; readonly sequence: LpSequenceRecord | null;
      readonly abandonClaim: { readonly claimId: string; readonly claimedAtMs: number;
        readonly dispositionStartedAtMs: number | null } | null;
      readonly reservation: LpExitReservation | null;
    };
    if (state.position === null) this.#positions.delete(state.positionId);
    else this.#positions.set(state.positionId, structuredClone(state.position));
    if (state.sequence === null) this.#sequences.delete(state.sequenceId);
    else this.#sequences.set(state.sequenceId, structuredClone(state.sequence));
    if (state.abandonClaim === null) this.#abandonClaims.delete(state.sequenceId);
    else this.#abandonClaims.set(state.sequenceId, structuredClone(state.abandonClaim));
    if (state.reservation === null) this.#reservations.delete(state.sequenceId);
    else this.#reservations.set(state.sequenceId, structuredClone(state.reservation));
  }

  async withArmFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: (fence: LpArmFenceContext) => Promise<T>,
  ): Promise<T> {
    const key = `${ownerKey(ownerAddress)}|${agentId}`;
    const prior = this.#armFences.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => turn);
    this.#armFences.set(key, tail);
    await prior.catch(() => undefined);
    try {
      return await work({
        listPositions: () => this.listPositions(ownerAddress, agentId),
        getAnyNonTerminalSequence: () =>
          this.getAnyNonTerminalSequence(ownerAddress, agentId),
        putSettings: (settingsStore, input) => {
          assertArmFenceScope(ownerAddress, agentId, input);
          return settingsStore.putWithinArmFence(input, null);
        },
        createPosition: (input) => {
          assertArmFenceScope(ownerAddress, agentId, input);
          return this.createPosition(input);
        },
      });
    } finally {
      release();
      if (this.#armFences.get(key) === tail) this.#armFences.delete(key);
    }
  }

  /* ----- positions ----- */

  async createPosition(input: CreateLpPositionInput): Promise<LpPositionRecord> {
    if (this.#positions.has(input.positionId)) {
      throw new Error(`LP position "${input.positionId}" already exists.`);
    }
    // The memory twin of `lp_positions_one_live_token_idx` (PHASE3.4 Rev2 M5).
    // Global, exactly as the index is: an NFT is one object, and two rows
    // driving sagas at it is the worst state this phase can create.
    if (input.tokenId !== undefined) {
      this.#assertTokenIdFree(input.tokenId, input.positionId);
    }
    const at = this.#now();
    const record: LpPositionRecord = {
      positionId: input.positionId,
      agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress),
      token0: getAddress(input.token0),
      token1: getAddress(input.token1),
      fee: input.fee,
      tokenId: input.tokenId ?? null,
      lineageId: input.lineageId ?? randomUUID(),
      basisWei: input.basisWei,
      basisSource: input.basisSource ?? "owner-budget",
      quoteToken: getAddress(input.quoteToken ?? DEFAULT_QUOTE_TOKEN),
      state: "open",
      ownershipMismatchCount: 0,
      ownershipLostReason: null,
      ownershipFirstSeenAtMs: null,
      // PHASE3.22 R4.2.2 — the memory twin of the additive `close_reason`
      // column. A fresh row has not been closed, so it has no cause.
      closeReason: null,
      // PHASE3.17 R2.3 — the memory twin of the additive `arm_group_id` column.
      armGroupId: input.armGroupId ?? null,
      armMeta: input.armMeta ?? null,
      // PHASE3.18 R2.6 — the memory twins of `grid_level` / `grid_role`.
      gridLevel: input.gridLevel ?? null,
      gridRole: input.gridRole ?? null,
      // PHASE3.19 C4 — the memory twins of the VWAP book. ZERO marks the ANCHOR
      // row; NULL means "not the anchor", and the two are different states.
      inventoryBaseWei: input.inventoryAnchor === true ? 0n : null,
      inventoryCostWbnbWei: input.inventoryAnchor === true ? 0n : null,
      rowVersion: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.#positions.set(input.positionId, structuredClone(record));
    return positionForRead(record);
  }

  /**
   * The memory twin of the partial unique index. Scans every row, ignoring
   * `closed` ones and the row being written itself — a re-import after a
   * product close is legal and mints a new lineage.
   */
  #assertTokenIdFree(tokenId: string, positionId: string): void {
    for (const record of this.#positions.values()) {
      if (
        record.tokenId === tokenId &&
        record.state !== "closed" &&
        record.positionId !== positionId
      ) {
        throw new LpTokenIdInUseError(tokenId);
      }
    }
  }

  async getPositionByTokenId(
    ownerAddress: Address,
    agentId: string,
    tokenId: string,
  ): Promise<LpPositionRecord | null> {
    const owner = ownerKey(ownerAddress);
    for (const record of this.#positions.values()) {
      if (
        record.ownerAddress === owner &&
        record.agentId === agentId &&
        record.tokenId === tokenId &&
        record.state !== "closed"
      ) {
        return positionForRead(record);
      }
    }
    return null;
  }

  async setOwnershipMismatch(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: {
      readonly count: number;
      readonly reason: string | null;
      readonly firstSeenAtMs: number | null;
    },
    expectedRowVersion?: number,
  ): Promise<LpPositionRecord> {
    const current = this.#ownedPosition(ownerAddress, agentId, positionId);
    if (current === undefined) throw new LpPositionNotFoundError(positionId);
    this.#assertOrdinaryPositionMutation(current, expectedRowVersion);
    const next: LpPositionRecord = {
      ...current,
      ownershipMismatchCount: input.count,
      ownershipLostReason: input.count === 0 ? null : input.reason,
      ownershipFirstSeenAtMs: input.count === 0 ? null : input.firstSeenAtMs,
      rowVersion: current.rowVersion + 1,
      updatedAt: this.#now(),
    };
    this.#positions.set(positionId, structuredClone(next));
    return structuredClone(next);
  }

  async getPosition(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpPositionRecord | null> {
    const record = this.#ownedPosition(ownerAddress, agentId, positionId);
    return record === undefined ? null : positionForRead(record);
  }

  async listPositions(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpPositionRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#positions.values()]
      .filter(
        (record) => record.ownerAddress === owner && record.agentId === agentId,
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.positionId.localeCompare(b.positionId),
      )
      .map((record) => positionForRead(record));
  }

  async listOwnerPositionsBounded(
    ownerAddress: Address,
    agentIds: readonly string[],
    states: readonly ("open" | "closing")[],
    limit: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("Invalid LP position list limit.");
    const owner = ownerKey(ownerAddress);
    const agentSet = new Set(agentIds);
    const stateSet = new Set(states);
    const rows = [...this.#positions.values()]
      .filter((row) => row.ownerAddress === owner && agentSet.has(row.agentId) && stateSet.has(row.state as "open" | "closing"))
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.positionId.localeCompare(b.positionId));
    return { rows: rows.slice(0, limit).map((row) => positionForRead(row)), hasMore: rows.length > limit };
  }

  async updatePositionTokenId(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    tokenId: string,
    expectedRowVersion?: number,
    gridRole?: LpGridRoleValue,
  ): Promise<LpPositionRecord> {
    const current = this.#ownedPosition(ownerAddress, agentId, positionId);
    if (current === undefined) throw new LpPositionNotFoundError(positionId);
    this.#assertOrdinaryPositionMutation(current, expectedRowVersion);
    if (current.state === "closed") {
      throw new Error(
        `LP position "${positionId}" is closed; its tokenId can no longer change.`,
      );
    }
    // M5's second half. The spec's draft said "the memory backend must mirror
    // it" and named only the create; the collision the review actually found
    // lives HERE — a rotate's freshly minted NFT imported inside the
    // mint-confirm → row-update window makes the saga's own write the loser.
    this.#assertTokenIdFree(tokenId, positionId);
    const next: LpPositionRecord = {
      ...current,
      tokenId,
      // PHASE3.18 R2.6: an omitted role leaves the column exactly as it was.
      ...(gridRole === undefined ? {} : { gridRole }),
      rowVersion: current.rowVersion + 1,
      updatedAt: this.#now(),
    };
    this.#positions.set(positionId, structuredClone(next));
    return structuredClone(next);
  }

  async setGridIdentity(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    identity: {
      readonly gridLevel: LpGridLevelValue;
      readonly gridRole: LpGridRoleValue;
    },
  ): Promise<LpPositionRecord> {
    const current = this.#ownedPosition(ownerAddress, agentId, positionId);
    if (current === undefined) throw new LpPositionNotFoundError(positionId);
    const next: LpPositionRecord = {
      ...current,
      gridLevel: identity.gridLevel,
      gridRole: identity.gridRole,
      rowVersion: current.rowVersion + 1,
      updatedAt: this.#now(),
    };
    this.#positions.set(positionId, structuredClone(next));
    return structuredClone(next);
  }

  async setPositionState(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    state: LpPositionState,
    expectedRowVersion?: number,
    closeReason?: string,
  ): Promise<LpPositionRecord> {
    const current = this.#ownedPosition(ownerAddress, agentId, positionId);
    if (current === undefined) throw new LpPositionNotFoundError(positionId);
    this.#assertOrdinaryPositionMutation(current, expectedRowVersion);
    assertPositionTransition(current.state, state);
    const next: LpPositionRecord = {
      ...current,
      state,
      // Closing the lineage resets the basis (R7): the stop-loss anchor dies
      // with the lineage, never survives into a later re-open.
      basisWei: state === "closed" ? 0n : current.basisWei,
      // PHASE3.22 R4.2.2 — written ONLY on a close and ONLY when the caller
      // names a cause, so every existing call site leaves the column exactly as
      // it found it. An omitted reason never CLEARS a recorded one either: a
      // row closed as `shift-depleted` keeps saying so.
      closeReason:
        state === "closed" && closeReason !== undefined
          ? closeReason
          : current.closeReason,
      rowVersion: current.rowVersion + 1,
      updatedAt: this.#now(),
    };
    this.#positions.set(positionId, structuredClone(next));
    return structuredClone(next);
  }

  /**
   * PHASE3.19 R4.1 / D1-D4 — the MEMORY TWIN of the append-only credit set.
   *
   * A `Map` keyed on the application key IS the `on conflict do nothing` primary
   * key, and the two statements below run in one synchronous turn — the memory
   * equivalent of the Postgres transaction, the same idiom `reserveSequence`'s
   * quota check uses. The clamp is on the DELTA (D1), identically on both
   * backends, so `book === sum of distinct credits` holds unconditionally and
   * the two compute the same function.
   */
  async applyInventoryCredit(
    ownerAddress: Address,
    agentId: string,
    input: {
      readonly applicationKey: string;
      readonly positionId: string;
      readonly armGroupId: string | null;
      readonly deltaBaseWei: bigint;
      readonly deltaCostWbnbWei: bigint;
    },
  ): Promise<{
    readonly applied: boolean;
    readonly deltaBaseWei: bigint;
    readonly deltaCostWbnbWei: bigint;
  }> {
    const owner = ownerKey(ownerAddress);
    const existing = this.#inventoryCredits.get(input.applicationKey);
    if (existing !== undefined) {
      // The key is taken: this is a replay. Nothing is applied and the STORED
      // deltas are returned, so a caller reporting what it wrote reports the
      // truth rather than what it would have written.
      return {
        applied: false,
        deltaBaseWei: existing.deltaBaseWei,
        deltaCostWbnbWei: existing.deltaCostWbnbWei,
      };
    }
    const anchor = this.#ownedPosition(ownerAddress, agentId, input.positionId);
    if (anchor === undefined) throw new LpPositionNotFoundError(input.positionId);
    if (anchor.inventoryBaseWei === null || anchor.inventoryCostWbnbWei === null) {
      throw new LpInventoryAnchorMissingError(input.positionId);
    }
    const clamped = clampInventoryDelta(
      { baseWei: anchor.inventoryBaseWei, costWbnbWei: anchor.inventoryCostWbnbWei },
      { baseWei: input.deltaBaseWei, costWbnbWei: input.deltaCostWbnbWei },
    );
    this.#inventoryCredits.set(input.applicationKey, {
      applicationKey: input.applicationKey,
      ownerAddress: owner,
      agentId,
      positionId: input.positionId,
      armGroupId: input.armGroupId,
      deltaBaseWei: clamped.baseWei,
      deltaCostWbnbWei: clamped.costWbnbWei,
      createdAt: this.#now(),
    });
    const next: LpPositionRecord = {
      ...anchor,
      inventoryBaseWei: anchor.inventoryBaseWei + clamped.baseWei,
      inventoryCostWbnbWei: anchor.inventoryCostWbnbWei + clamped.costWbnbWei,
      rowVersion: anchor.rowVersion + 1,
      updatedAt: this.#now(),
    };
    this.#positions.set(input.positionId, structuredClone(next));
    return {
      applied: true,
      deltaBaseWei: clamped.baseWei,
      deltaCostWbnbWei: clamped.costWbnbWei,
    };
  }

  async readInventoryBook(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<{ readonly baseWei: bigint; readonly costWbnbWei: bigint } | null> {
    const row = this.#ownedPosition(ownerAddress, agentId, positionId);
    if (row === undefined) return null;
    if (row.inventoryBaseWei === null || row.inventoryCostWbnbWei === null) return null;
    return { baseWei: row.inventoryBaseWei, costWbnbWei: row.inventoryCostWbnbWei };
  }

  async sumInventoryCredits(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<{
    readonly count: number;
    readonly baseWei: bigint;
    readonly costWbnbWei: bigint;
  }> {
    const owner = ownerKey(ownerAddress);
    let count = 0;
    let baseWei = 0n;
    let costWbnbWei = 0n;
    for (const credit of this.#inventoryCredits.values()) {
      if (credit.ownerAddress !== owner) continue;
      if (credit.agentId !== agentId) continue;
      if (credit.positionId !== positionId) continue;
      count += 1;
      baseWei += credit.deltaBaseWei;
      costWbnbWei += credit.deltaCostWbnbWei;
    }
    return { count, baseWei, costWbnbWei };
  }

  #assertOrdinaryPositionMutation(
    position: LpPositionRecord,
    expectedRowVersion: number | undefined,
  ): void {
    if (expectedRowVersion !== undefined && position.rowVersion !== expectedRowVersion) {
      throw new LpPositionVersionConflictError(position.positionId);
    }
    for (const sequence of this.#sequences.values()) {
      if (sequence.positionId === position.positionId &&
          (sequence.state === "resolving" || sequence.state === "retiring-pre-bind")) {
        throw new LpPositionResolvingError(position.positionId);
      }
    }
  }

  /* ----- sequences ----- */

  async createSequence(input: CreateLpSequenceInput): Promise<LpSequenceRecord> {
    // PHASE3.15, a DECLARED tightening: the Postgres side has always rejected
    // an unknown kind at the `lp_sequences_kind_check` CHECK and this side
    // validated only on the READ path, so the two backends disagreed about a
    // kind neither of them should ever see. C10 asks for a both-backends test
    // that the widened CHECK accepts `grid-flip` AND still rejects an unknown
    // kind; that test is only meaningful if both backends refuse. It can reject
    // nothing the type system already permits.
    assertSequenceKind(input.kind);
    const position = this.#ownedPosition(
      input.ownerAddress,
      input.agentId,
      input.positionId,
    );
    if (position === undefined) {
      throw new LpPositionNotFoundError(input.positionId);
    }
    // Explicit non-terminal scan — the memory twin of the Postgres partial
    // unique index. No await between the scan and the insert.
    for (const sequence of this.#sequences.values()) {
      if (
        sequence.positionId === input.positionId &&
        !isTerminalLpSequence(sequence.state, sequence.recoveryState)
      ) {
        throw new LpActiveSequenceError(input.positionId);
      }
    }
    const at = this.#now();
    const record: LpSequenceRecord = {
      sequenceId: randomUUID(),
      agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress),
      positionId: input.positionId,
      kind: input.kind,
      // PHASE3.24 C2: absent normalizes false, and only manual-exit may carry
      // true. That makes legacy callers fail closed without changing them.
      inlineConvert: input.kind === "manual-exit" && input.inlineConvert === true,
      state: "active",
      recoveryState: "none",
      steps: [],
      priorTokenId: null,
      note: null,
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
      // PHASE3.18 R2.3/C4 — the memory twin of the persisted target, written
      // in the SAME turn the sequence row is created (the memory equivalent of
      // "the same transaction"), so the zap-out can never submit against a row
      // whose target is not yet durable.
      targetTickLower: input.targetRange?.tickLower ?? null,
      targetTickUpper: input.targetRange?.tickUpper ?? null,
      // PHASE3.22 R8 — the SHIFT's second target, in the same turn as the first.
      targetSellTickLower: input.targetSellRange?.tickLower ?? null,
      targetSellTickUpper: input.targetSellRange?.tickUpper ?? null,
      // PHASE3.23 REVIEW2 N2: the cause is created atomically with the target
      // shape; legacy and non-shift rows remain null.
      shiftCause: input.shiftCause ?? null,
      // PHASE3.19 item 8 — null until the hedge's build persists it, which it
      // does BEFORE the swap is submitted and exactly once.
      hedgeDirection: null,
      hedgeAmountInWei: null,
      // PHASE3.20 item 7 — the memory twin of `recenter_evidence`, written in
      // the SAME turn the row is created, so the reservation that follows reads
      // a lane that is already durable.
      recenterEvidence: input.recenterEvidence ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.#sequences.set(record.sequenceId, structuredClone(record));
    return structuredClone(record);
  }

  async getSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpSequenceRecord | null> {
    const record = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    return record === undefined ? null : structuredClone(record);
  }

  async getAnyNonTerminalSequence(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord | null> {
    const owner = ownerKey(ownerAddress);
    for (const sequence of this.#sequences.values()) {
      if (
        sequence.ownerAddress === owner &&
        sequence.agentId === agentId &&
        !isTerminalLpSequence(sequence.state, sequence.recoveryState)
      ) {
        return structuredClone(sequence);
      }
    }
    return null;
  }

  async getNonTerminalSequence(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpSequenceRecord | null> {
    const owner = ownerKey(ownerAddress);
    for (const sequence of this.#sequences.values()) {
      if (
        sequence.ownerAddress === owner &&
        sequence.agentId === agentId &&
        sequence.positionId === positionId &&
        !isTerminalLpSequence(sequence.state, sequence.recoveryState)
      ) {
        return structuredClone(sequence);
      }
    }
    return null;
  }

  async listSequences(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#sequences.values()]
      .filter(
        (record) => record.ownerAddress === owner && record.agentId === agentId,
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.sequenceId.localeCompare(b.sequenceId),
      )
      .map((record) => structuredClone(record));
  }

  async appendStep(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    step: { readonly kind: LpStepKind; readonly journalIdempotencyKey: string; readonly priorTokenId?: string },
  ): Promise<LpSequenceStep> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    if (current.state !== "active") {
      throw new Error(
        `LP sequence "${sequenceId}" is ${current.state}; steps may only be recorded on an active sequence.`,
      );
    }
    const index = current.steps.length;
    const created: LpSequenceStep = {
      index,
      kind: step.kind,
      journalIdempotencyKey: step.journalIdempotencyKey,
      journalDecisionId: lpStepDecisionId(sequenceId, index),
    };
    const next: LpSequenceRecord = {
      ...current,
      priorTokenId: atomicPriorTokenId(current, step),
      steps: [...current.steps, created],
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(created);
  }

  async setSequenceState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    state: LpSequenceState,
  ): Promise<LpSequenceRecord> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    assertSequenceTransition(current.state, state);
    const next: LpSequenceRecord = {
      ...current,
      state,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async claimSequenceForAbandon(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedUpdatedAt: number;
      readonly claimId: string;
      readonly nowMs: number;
      readonly minIdleMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    // No await between the comparison and write: one event-loop turn is the
    // memory twin of Postgres's single UPDATE ... WHERE ... RETURNING CAS.
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined || current.updatedAt !== input.expectedUpdatedAt) {
      return null;
    }
    const existing = this.#abandonClaims.get(sequenceId);
    const firstClaim =
      current.state === "held" &&
      existing === undefined &&
      input.nowMs - current.updatedAt >= input.minIdleMs;
    const staleReclaim =
      current.state === "abandoning" &&
      existing !== undefined &&
      input.nowMs - existing.claimedAtMs >= input.minIdleMs;
    if (!firstClaim && !staleReclaim) return null;

    const next: LpSequenceRecord = {
      ...current,
      state: "abandoning",
      updatedAt: input.nowMs,
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    this.#abandonClaims.set(sequenceId, {
      claimId: input.claimId,
      claimedAtMs: input.nowMs,
      // A reclaim must preserve this marker. Once the position write began,
      // no later process may release the sequence back to the worker.
      dispositionStartedAtMs:
        current.state === "abandoning"
          ? existing?.dispositionStartedAtMs ?? null
          : null,
    });
    return structuredClone(next);
  }

  async beginSequenceAbandonDisposition(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    const claim = this.#abandonClaims.get(sequenceId);
    if (
      current === undefined ||
      current.state !== "abandoning" ||
      claim?.claimId !== claimId
    ) {
      return null;
    }
    const at = this.#now();
    const next = { ...current, updatedAt: at };
    this.#sequences.set(sequenceId, structuredClone(next));
    this.#abandonClaims.set(sequenceId, {
      ...claim,
      dispositionStartedAtMs: claim.dispositionStartedAtMs ?? at,
    });
    return structuredClone(next);
  }

  async releaseSequenceAbandonClaim(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    const claim = this.#abandonClaims.get(sequenceId);
    if (
      current === undefined ||
      current.state !== "abandoning" ||
      claim?.claimId !== claimId ||
      claim.dispositionStartedAtMs !== null
    ) {
      return null;
    }
    const next: LpSequenceRecord = {
      ...current,
      state: "held",
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    this.#abandonClaims.delete(sequenceId);
    return structuredClone(next);
  }

  async completeSequenceAbandon(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    const claim = this.#abandonClaims.get(sequenceId);
    if (
      current === undefined ||
      current.state !== "abandoning" ||
      claim?.claimId !== claimId ||
      claim.dispositionStartedAtMs === null
    ) {
      return null;
    }
    const next: LpSequenceRecord = {
      ...current,
      state: "rolled-back",
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    this.#abandonClaims.delete(sequenceId);
    return structuredClone(next);
  }

  async claimSequenceForLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedState: "active" | "held";
      readonly expectedRecoveryState: LpRecoveryState;
      readonly expectedUpdatedAt: number;
      readonly expectedPositionId: string;
      readonly expectedPositionVersion: number;
      readonly expectedResolverRowVersion: number;
      readonly resolutionId: string;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    const position = this.#ownedPosition(ownerAddress, agentId, input.expectedPositionId);
    if (current === undefined || position === undefined ||
        current.positionId !== input.expectedPositionId ||
        position.rowVersion !== input.expectedPositionVersion ||
        current.state !== input.expectedState ||
        current.recoveryState !== input.expectedRecoveryState ||
        current.updatedAt !== input.expectedUpdatedAt ||
        current.resolverRowVersion !== input.expectedResolverRowVersion ||
        (current.state === "held" && current.recoveryState === "none")) {
      return null;
    }
    const next: LpSequenceRecord = {
      ...current,
      state: "resolving",
      resolverPriorState: current.state,
      resolverPriorRecoveryState: current.recoveryState,
      resolverFence: current.resolverFence + 1n,
      resolverLeaseUntil: input.leaseUntilMs,
      resolverSnapshotHash: input.snapshotHash,
      resolverRowVersion: current.resolverRowVersion + 1,
      resolutionId: input.resolutionId,
      resolverActionIdempotencyKey: input.actionIdempotencyKey,
      resolutionDispositionStarted: false,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async reclaimSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly expectedFence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly nowMs: number;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined || current.state !== "resolving" ||
        current.resolutionId !== input.resolutionId ||
        current.resolverFence !== input.expectedFence ||
        current.resolverRowVersion !== input.expectedResolverRowVersion ||
        current.resolverLeaseUntil === null || current.resolverLeaseUntil > input.nowMs ||
        current.resolverSnapshotHash !== input.snapshotHash) {
      return null;
    }
    const next: LpSequenceRecord = {
      ...current,
      resolverFence: current.resolverFence + 1n,
      resolverLeaseUntil: input.leaseUntilMs,
      resolverActionIdempotencyKey: input.actionIdempotencyKey,
      resolverRowVersion: current.resolverRowVersion + 1,
      updatedAt: input.nowMs,
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async beginSequenceLandingDisposition(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
  ): Promise<LpSequenceRecord | null> {
    return this.#mutateResolverClaim(
      ownerAddress, agentId, sequenceId, resolutionId, fence,
      expectedResolverRowVersion,
      (current) => ({
        ...current,
        resolutionDispositionStarted: true,
        resolverRowVersion: current.resolverRowVersion + 1,
        updatedAt: this.#now(),
      }),
    );
  }

  async setSequenceLandingRecovery(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: { readonly resolutionId: string; readonly fence: bigint;
      readonly expectedResolverRowVersion: number; readonly recoveryState: LpRecoveryState;
      readonly note: string },
  ): Promise<LpSequenceRecord | null> {
    return this.#mutateResolverClaim(
      ownerAddress, agentId, sequenceId, input.resolutionId, input.fence,
      input.expectedResolverRowVersion,
      (current) => !current.resolutionDispositionStarted ? null : ({ ...current,
        recoveryState: input.recoveryState, note: input.note,
        resolverRowVersion: current.resolverRowVersion + 1, updatedAt: this.#now() }),
    );
  }

  async setPositionStateForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: { readonly sequenceId: string; readonly resolutionId: string;
      readonly fence: bigint; readonly expectedResolverRowVersion: number;
      readonly expectedPositionVersion: number; readonly state: LpPositionState },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    return this.#mutatePositionForLanding(ownerAddress, agentId, positionId, input,
      (position) => {
        assertPositionTransition(position.state, input.state);
        return { ...position, state: input.state,
          basisWei: input.state === "closed" ? 0n : position.basisWei,
          rowVersion: position.rowVersion + 1, updatedAt: this.#now() };
      });
  }

  async updatePositionTokenIdForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: { readonly sequenceId: string; readonly resolutionId: string;
      readonly fence: bigint; readonly expectedResolverRowVersion: number;
      readonly expectedPositionVersion: number; readonly tokenId: string },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    return this.#mutatePositionForLanding(ownerAddress, agentId, positionId, input,
      (position) => {
        if (position.state === "closed") return null;
        this.#assertTokenIdFree(input.tokenId, positionId);
        return { ...position, tokenId: input.tokenId,
          rowVersion: position.rowVersion + 1, updatedAt: this.#now() };
      });
  }

  #mutatePositionForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: { readonly sequenceId: string; readonly resolutionId: string;
      readonly fence: bigint; readonly expectedResolverRowVersion: number;
      readonly expectedPositionVersion: number },
    mutate: (position: LpPositionRecord) => LpPositionRecord | null,
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    const position = this.#ownedPosition(ownerAddress, agentId, positionId);
    const sequence = this.#ownedSequence(ownerAddress, agentId, input.sequenceId);
    if (position === undefined || sequence === undefined || sequence.positionId !== positionId ||
        position.rowVersion !== input.expectedPositionVersion || sequence.state !== "resolving" ||
        sequence.resolutionId !== input.resolutionId || sequence.resolverFence !== input.fence ||
        sequence.resolverRowVersion !== input.expectedResolverRowVersion ||
        !sequence.resolutionDispositionStarted) return Promise.resolve(null);
    const nextPosition = mutate(position);
    if (nextPosition === null) return Promise.resolve(null);
    const nextSequence = { ...sequence,
      resolverRowVersion: sequence.resolverRowVersion + 1, updatedAt: this.#now() };
    this.#positions.set(positionId, structuredClone(nextPosition));
    this.#sequences.set(sequence.sequenceId, structuredClone(nextSequence));
    return Promise.resolve({ position: structuredClone(nextPosition),
      sequence: structuredClone(nextSequence) });
  }

  async releaseSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
  ): Promise<LpSequenceRecord | null> {
    return this.#mutateResolverClaim(
      ownerAddress, agentId, sequenceId, resolutionId, fence,
      expectedResolverRowVersion,
      (current) => current.resolutionDispositionStarted ? null : ({
        ...current,
        state: current.resolverPriorState ?? "active",
        recoveryState: current.resolverPriorRecoveryState ?? "none",
        ...clearResolverClaim(current),
        resolverRowVersion: current.resolverRowVersion + 1,
        updatedAt: this.#now(),
      }),
    );
  }

  async finishSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly fence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly targetState: "active" | "rolled-back";
    },
  ): Promise<LpSequenceRecord | null> {
    return this.#mutateResolverClaim(
      ownerAddress, agentId, sequenceId, input.resolutionId, input.fence,
      input.expectedResolverRowVersion,
      (current) => !current.resolutionDispositionStarted ? null : ({
        ...current,
        state: input.targetState,
        ...clearResolverClaim(current),
        resolverRowVersion: current.resolverRowVersion + 1,
        updatedAt: this.#now(),
      }),
    );
  }

  async claimSequenceForPreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedState: "active" | "held";
      readonly expectedRecoveryState: LpRecoveryState;
      readonly expectedUpdatedAt: number;
      readonly expectedPositionId: string;
      readonly expectedPositionVersion: number;
      readonly expectedRetirementRowVersion: number;
      readonly targetJournalKey: string;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    const position = this.#ownedPosition(ownerAddress, agentId, input.expectedPositionId);
    if (current === undefined || position === undefined ||
        current.positionId !== input.expectedPositionId ||
        position.rowVersion !== input.expectedPositionVersion ||
        current.state !== input.expectedState ||
        current.recoveryState !== input.expectedRecoveryState ||
        current.updatedAt !== input.expectedUpdatedAt ||
        current.retirementRowVersion !== input.expectedRetirementRowVersion ||
        (current.state === "held" && current.recoveryState === "none")) return null;
    const next: LpSequenceRecord = {
      ...current,
      state: "retiring-pre-bind",
      retirementPriorState: current.state,
      retirementPriorRecoveryState: current.recoveryState,
      retirementFence: current.retirementFence + 1n,
      retirementLeaseUntil: input.leaseUntilMs,
      retirementSnapshotHash: input.snapshotHash,
      retirementRowVersion: current.retirementRowVersion + 1,
      retirementTargetJournalKey: input.targetJournalKey,
      retirementActionIdempotencyKey: input.actionIdempotencyKey,
      retirementDispositionStarted: false,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async reclaimSequenceForPreBindRetirement(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly targetJournalKey: string;
      readonly expectedFence: bigint;
      readonly expectedRetirementRowVersion: number;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly nowMs: number;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined || current.state !== "retiring-pre-bind" ||
        current.retirementTargetJournalKey !== input.targetJournalKey ||
        current.retirementFence !== input.expectedFence ||
        current.retirementRowVersion !== input.expectedRetirementRowVersion ||
        current.retirementLeaseUntil === null || current.retirementLeaseUntil > input.nowMs ||
        current.retirementSnapshotHash !== input.snapshotHash ||
        current.retirementDispositionStarted) return null;
    const next: LpSequenceRecord = {
      ...current,
      retirementFence: current.retirementFence + 1n,
      retirementLeaseUntil: input.leaseUntilMs,
      retirementActionIdempotencyKey: input.actionIdempotencyKey,
      retirementRowVersion: current.retirementRowVersion + 1,
      updatedAt: input.nowMs,
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async beginSequencePreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    targetJournalKey: string, fence: bigint, expectedRetirementRowVersion: number,
  ): Promise<LpSequenceRecord | null> {
    return this.#mutatePreBindRetirement(ownerAddress, agentId, sequenceId,
      targetJournalKey, fence, expectedRetirementRowVersion, (current) => ({
        ...current, retirementDispositionStarted: true,
        retirementRowVersion: current.retirementRowVersion + 1, updatedAt: this.#now(),
      }));
  }

  async setPositionStateForPreBindRetirement(
    ownerAddress: Address, agentId: string, positionId: string,
    input: { readonly sequenceId: string; readonly targetJournalKey: string; readonly fence: bigint;
      readonly expectedRetirementRowVersion: number; readonly expectedPositionVersion: number;
      readonly state: LpPositionState },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    const position = this.#ownedPosition(ownerAddress, agentId, positionId);
    const sequence = this.#ownedSequence(ownerAddress, agentId, input.sequenceId);
    if (position === undefined || sequence === undefined || sequence.positionId !== positionId ||
        position.rowVersion !== input.expectedPositionVersion ||
        sequence.state !== "retiring-pre-bind" ||
        sequence.retirementTargetJournalKey !== input.targetJournalKey ||
        sequence.retirementFence !== input.fence ||
        sequence.retirementRowVersion !== input.expectedRetirementRowVersion ||
        !sequence.retirementDispositionStarted) return null;
    assertPositionTransition(position.state, input.state);
    const nextPosition: LpPositionRecord = { ...position, state: input.state,
      basisWei: input.state === "closed" ? 0n : position.basisWei,
      rowVersion: position.rowVersion + 1, updatedAt: this.#now() };
    const nextSequence: LpSequenceRecord = { ...sequence,
      retirementRowVersion: sequence.retirementRowVersion + 1, updatedAt: this.#now() };
    this.#positions.set(positionId, structuredClone(nextPosition));
    this.#sequences.set(sequence.sequenceId, structuredClone(nextSequence));
    return { position: structuredClone(nextPosition), sequence: structuredClone(nextSequence) };
  }

  async finishSequencePreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    input: { readonly targetJournalKey: string; readonly fence: bigint;
      readonly expectedRetirementRowVersion: number },
  ): Promise<LpSequenceRecord | null> {
    return this.#mutatePreBindRetirement(ownerAddress, agentId, sequenceId,
      input.targetJournalKey, input.fence, input.expectedRetirementRowVersion,
      (current) => !current.retirementDispositionStarted ? null : ({ ...current,
        state: "rolled-back", ...clearRetirementClaim(current),
        retirementRowVersion: current.retirementRowVersion + 1, updatedAt: this.#now(),
      }));
  }

  #mutatePreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    targetJournalKey: string, fence: bigint, expectedRetirementRowVersion: number,
    mutate: (current: LpSequenceRecord) => LpSequenceRecord | null,
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined || current.state !== "retiring-pre-bind" ||
        current.retirementTargetJournalKey !== targetJournalKey || current.retirementFence !== fence ||
        current.retirementRowVersion !== expectedRetirementRowVersion) return Promise.resolve(null);
    const next = mutate(current);
    if (next === null) return Promise.resolve(null);
    this.#sequences.set(sequenceId, structuredClone(next));
    return Promise.resolve(structuredClone(next));
  }

  #mutateResolverClaim(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
    mutate: (current: LpSequenceRecord) => LpSequenceRecord | null,
  ): Promise<LpSequenceRecord | null> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined || current.state !== "resolving" ||
        current.resolutionId !== resolutionId || current.resolverFence !== fence ||
        current.resolverRowVersion !== expectedResolverRowVersion) {
      return Promise.resolve(null);
    }
    const next = mutate(current);
    if (next === null) return Promise.resolve(null);
    this.#sequences.set(sequenceId, structuredClone(next));
    return Promise.resolve(structuredClone(next));
  }

  async setSequenceNote(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    note: string | null,
  ): Promise<LpSequenceRecord> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    if (current.state === "resolving" || current.state === "retiring-pre-bind") {
      throw new LpPositionResolvingError(current.positionId);
    }
    const next: LpSequenceRecord = {
      ...current,
      note,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async recordInlineResidue(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    residueBaseWei: bigint,
    note: string | null,
  ): Promise<LpSequenceRecord> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    if (current.kind !== "manual-exit" || !current.inlineConvert) {
      throw new Error("Inline residue belongs only to a consented manual-exit sequence.");
    }
    if (
      current.inlineResidueBaseWei !== null
      && current.inlineResidueBaseWei !== residueBaseWei
    ) {
      throw new Error("Confirmed inline residue disagrees with the persisted receipt witness.");
    }
    const next: LpSequenceRecord = {
      ...current,
      inlineResidueBaseWei: current.inlineResidueBaseWei ?? residueBaseWei,
      note,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  /**
   * PHASE3.19 item 8 — WRITE-ONCE. A row that already carries an intent is left
   * exactly as it is and the STORED one is returned, so no path in this store
   * can overwrite it; the disagreement THROW lives at the two guards that can
   * see a second intent.
   */
  async setHedgeIntent(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    intent: {
      readonly direction: "wbnb-to-token" | "token-to-wbnb";
      readonly amountInWei: bigint;
    },
  ): Promise<LpSequenceRecord> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    if (current.hedgeDirection !== null && current.hedgeAmountInWei !== null) {
      return structuredClone(current);
    }
    const next: LpSequenceRecord = {
      ...current,
      hedgeDirection: intent.direction,
      hedgeAmountInWei: intent.amountInWei,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async setRecoveryState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    recoveryState: LpRecoveryState,
  ): Promise<LpSequenceRecord> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    if (current.state === "resolving" || current.state === "retiring-pre-bind") {
      throw new LpPositionResolvingError(current.positionId);
    }
    if (current.state === "completed" || current.state === "rolled-back") {
      throw new Error(
        `LP sequence "${sequenceId}" is ${current.state}; a terminal sequence's recovery state cannot change.`,
      );
    }
    const next: LpSequenceRecord = {
      ...current,
      recoveryState,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  async recordSequenceStall(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    stallCode: string,
  ): Promise<LpSequenceRecord> {
    const current = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (current === undefined) throw new LpSequenceNotFoundError(sequenceId);
    if (
      current.state === "resolving" ||
      current.state === "retiring-pre-bind" ||
      current.state === "abandoning" ||
      isTerminalLpSequence(current.state, current.recoveryState)
    ) {
      // Not this latch's row to touch: another authority owns it, or it is
      // already finished. Latching decides only whether the WORKER resumes.
      return structuredClone(current);
    }
    const next: LpSequenceRecord = {
      ...current,
      stallCode,
      stallCount: current.stallCode === stallCode ? current.stallCount + 1 : 1,
      updatedAt: this.#now(),
    };
    this.#sequences.set(sequenceId, structuredClone(next));
    return structuredClone(next);
  }

  /* ----- worker queue ----- */

  async listOpenPositionsForWorker(): Promise<LpPositionRecord[]> {
    return [...this.#positions.values()]
      // A resolver or the proved pre-bind retirement owns the position until
      // its finalizer releases the sequence.  Do not even hand that position
      // to the worker: evaluation can persist an observation before a later
      // saga-create CAS notices the fence.
      .filter((record) => record.state === "open" &&
        ![...this.#sequences.values()].some((sequence) =>
          sequence.positionId === record.positionId &&
          (sequence.state === "resolving" || sequence.state === "retiring-pre-bind"),
        ))
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.positionId.localeCompare(b.positionId),
      )
      .map((record) => structuredClone(record));
  }

  async listFeeRepairSequencesForWorker(input: { after: { createdAt: number; sequenceId: string } | null; limit: number; deadlineMs: number; signal: AbortSignal }): Promise<LpSequenceRecord[]> {
    const rows: LpSequenceRecord[] = [];
    for (const row of this.#sequences.values()) {
      input.signal.throwIfAborted();
      if (Date.now() >= input.deadlineMs) throw new Error("Fee discovery deadline");
      if (input.after && (row.createdAt < input.after.createdAt || row.createdAt === input.after.createdAt && row.sequenceId <= input.after.sequenceId)) continue;
      rows.push(row);
    }
    rows.sort((a,b) => a.createdAt - b.createdAt || a.sequenceId.localeCompare(b.sequenceId));
    return structuredClone(rows.slice(0, Math.min(64, input.limit)));
  }

  async listNonTerminalSequencesForWorker(): Promise<LpSequenceRecord[]> {
    return [...this.#sequences.values()]
      .filter(
        // `abandoning` is non-terminal for uniqueness/import blocking but is
        // deliberately absent from the worker queue: the route owns its lease.
        (record) =>
          record.state !== "abandoning" &&
          record.state !== "resolving" &&
          record.state !== "retiring-pre-bind" &&
          !isTerminalLpSequence(record.state, record.recoveryState),
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.sequenceId.localeCompare(b.sequenceId),
      )
      .map((record) => structuredClone(record));
  }

  /* ----- reservations ----- */

  async reserveSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    quota: LpExitQuota,
    laneEvidence?: LpRecenterEvidence,
  ): Promise<LpExitReservation> {
    const sequence = this.#ownedSequence(ownerAddress, agentId, sequenceId);
    if (sequence === undefined) throw new LpSequenceNotFoundError(sequenceId);
    const existing = this.#reservations.get(sequenceId);
    if (existing !== undefined) return structuredClone(existing);

    const now = this.#now();
    // PHASE3.20 R3.3 — `quotaBound` is derived from the KIND mapping, which
    // stays TOTAL for `grid-recenter`. Retiring `"recenter"` from that map would
    // have made every ladder motion quota-EXEMPT (`lane !== undefined`), i.e.
    // unbounded AND excluded from the exit lane's leftover subtraction: the
    // clearance's N2.1 fail-open. The lane the row is REFUSED against is the
    // evidence-derived one below.
    const quotaBound = quotaLaneOf(sequence.kind) !== undefined;
    const evidence = laneEvidence ?? sequence.recenterEvidence ?? undefined;
    const lane = reserveQuotaLane(sequence.kind, evidence, sequence.shiftCause);
    if (lane !== undefined) {
      // Quota check and insert share one synchronous turn: no other caller
      // can interleave, the memory equivalent of the Postgres transaction.
      this.#assertQuota(sequence.ownerAddress, sequence.agentId, quota, now, lane);
    }
    const reservation: LpExitReservation = {
      sequenceId,
      agentId: sequence.agentId,
      ownerAddress: sequence.ownerAddress,
      kind: sequence.kind,
      quotaBound,
      // Only a ladder motion carries one; every other kind writes `null` and
      // `reservationQuotaLane` then answers from the kind alone.
      quotaLane:
        sequence.kind === "grid-shift"
          ? (lane === "shift-drift" ? "shift-drift" : "shift-settle")
          : evidence ?? null,
      reservedAt: now,
      releasedAt: null,
    };
    this.#reservations.set(sequenceId, structuredClone(reservation));
    return structuredClone(reservation);
  }

  async releaseReservation(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<void> {
    const owner = ownerKey(ownerAddress);
    const current = this.#reservations.get(sequenceId);
    if (
      current === undefined ||
      current.ownerAddress !== owner ||
      current.agentId !== agentId ||
      current.releasedAt !== null
    ) {
      // Absent, foreign, or already released: all no-ops. The quota-REFUSED
      // path arrives here with no row at all and must not error.
      return;
    }
    this.#reservations.set(sequenceId, { ...current, releasedAt: this.#now() });
  }

  async quotaUsage(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpQuotaUsage> {
    const owner = ownerKey(ownerAddress);
    const cutoff = this.#now() - ROLLING_DAY_MS;
    let liveCount = 0;
    let gridFlipLiveCount = 0;
    let requoteLiveCount = 0;
    let recenterLiveCount = 0;
    // PHASE3.22 R2.21 — the fifth grid lane's own counter.
    let shiftLiveCount = 0;
    let shiftSettleLiveCount = 0;
    let shiftDriftLiveCount = 0;
    let settlementLiveCount = 0;
    let driftLiveCount = 0;
    let releasedCount = 0;
    let latest: number | null = null;
    let oldestLive: number | null = null;
    for (const r of this.#reservations.values()) {
      if (r.ownerAddress !== owner || r.agentId !== agentId) continue;
      if (r.reservedAt <= cutoff) continue;
      if (latest === null || r.reservedAt > latest) latest = r.reservedAt;
      if (r.releasedAt !== null) {
        releasedCount += 1;
        continue;
      }
      // PHASE3.7 F2 (REVIEW M7): `liveCount` is what the owner's dashboard
      // reports as `used`, so it must count what the GATE counts. Reporting
      // `exhausted` while the gate admits is the PHASE3.3-AUDIT A3 class — the
      // worker knowing something the dashboard does not.
      if (!r.quotaBound) continue;
      // PHASE3.15 R2.7: the lanes are reported separately, because they are
      // refused separately. `liveCount` stays the EXIT lane, which is what
      // `maxExitSequencesPerDay` bounds and what the existing quota view says.
      // PHASE3.18 C7: THREE lanes, and the exit lane is what is left over.
      // PHASE3.19 item 19: FOUR lanes, and the exit lane is still what is left
      // over. A recenter counted into `liveCount` here would silently charge
      // every ladder motion against the owner's EXIT quota — the lane that pays
      // for rotates, harvests and the protect headroom — which is the R2.10
      // "easiest defect" class, one lane later.
      // PHASE3.20 D1/B1(b): FIVE reported lanes over FOUR budgets. The two
      // ladder lanes are counted into their OWN counters AND into
      // `recenterLiveCount`, which stays the SUM — so
      // `settlement + drift === recenter` holds on this backend too and item 6's
      // reported SUM is not a silent zero here.
      const lane = reservationQuotaLane(r.kind, r.quotaLane);
      if (lane === "grid") {
        gridFlipLiveCount += 1;
      } else if (lane === "requote") {
        requoteLiveCount += 1;
      } else if (lane === "settlement") {
        settlementLiveCount += 1;
        recenterLiveCount += 1;
      } else if (lane === "drift") {
        driftLiveCount += 1;
        recenterLiveCount += 1;
      } else if (lane === "recenter") {
        recenterLiveCount += 1;
      // PHASE3.25 R2.6/R5.3: the all-shift total and two lane subsets have
      // their own counters and, like every grid lane before them, are what
      // `liveCount` is LEFT OVER FROM — a shift counted into `liveCount` would
      // charge every atomic motion against the owner's EXIT quota, the lane
      // that pays for rotates, harvests and the protect headroom.
      } else if (lane === "shift-settle" || lane === "shift-drift") {
        shiftLiveCount += 1;
        if (lane === "shift-drift") shiftDriftLiveCount += 1;
        else shiftSettleLiveCount += 1;
      } else {
        liveCount += 1;
      }
      if (oldestLive === null || r.reservedAt < oldestLive) oldestLive = r.reservedAt;
    }
    return {
      liveCount,
      gridFlipLiveCount,
      requoteLiveCount,
      recenterLiveCount,
      settlementLiveCount,
      driftLiveCount,
      shiftLiveCount,
      shiftSettleLiveCount,
      shiftDriftLiveCount,
      releasedCount,
      latestReservedAtMs: latest,
      oldestLiveExpiresAtMs: oldestLive === null ? null : oldestLive + ROLLING_DAY_MS,
    };
  }

  async getReservation(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpExitReservation | null> {
    const owner = ownerKey(ownerAddress);
    const record = this.#reservations.get(sequenceId);
    if (
      record === undefined ||
      record.ownerAddress !== owner ||
      record.agentId !== agentId
    ) {
      return null;
    }
    return structuredClone(record);
  }

  async close(): Promise<void> {
    this.#positions.clear();
    this.#sequences.clear();
    this.#reservations.clear();
    this.#armFences.clear();
  }

  #assertQuota(
    ownerAddress: string,
    agentId: string,
    quota: LpExitQuota,
    now: number,
    /** PHASE3.15 R2.7: which daily count this reservation is refused against. */
    lane: LpQuotaLane,
  ): void {
    const cutoff = now - ROLLING_DAY_MS;
    let count = 0;
    let latest = Number.NEGATIVE_INFINITY;
    for (const reservation of this.#reservations.values()) {
      // AUDIT A7: F2(3) added the owner conjunct to the Postgres window query
      // and left the memory gate scoped on the agent alone — closing a
      // divergence on one side only is how the two backends drift.
      if (reservation.ownerAddress !== ownerAddress) continue;
      if (reservation.agentId !== agentId) continue;
      if (reservation.reservedAt <= cutoff) continue;
      // PHASE3.5 Rev2 M3 — THE SPLIT. The spacing anchor counts EVERY in-window
      // row; only the daily COUNT skips released ones. Filtering both would
      // re-open a pacing floor the owner signed AND remove the only bound on a
      // reserve→refuse→roll-back loop that can run once per cycle for ever.
      if (reservation.reservedAt > latest) latest = reservation.reservedAt;
      if (reservation.releasedAt !== null) continue;
      // PHASE3.7 F2, the second conjunct on the COUNT alone: exempt kinds do
      // not occupy the cap they are exempt from. The anchor above still sees
      // them, because the pacing floor is about gas cadence, not about which
      // kind spent it.
      if (!reservation.quotaBound) continue;
      const reservationLane = reservationQuotaLane(reservation.kind, reservation.quotaLane);
      // PHASE3.15 R2.7, one conjunct further in: the COUNT sees only rows in
      // the SAME LANE. A grid flip does not occupy the rotate/harvest cap and
      // vice versa — but the anchor above still saw both, which is the M3/F2
      // split extended to a second lane rather than a new rule.
      // PHASE3.20 C5 — THROUGH THE ROW, NOT THE KIND. This filter and the
      // Postgres window filter are the two seams that actually REFUSE, and
      // neither was named by the work order; both read the STORED lane, with a
      // NULL counting as SETTLEMENT so a pre-migration row in flight at upgrade
      // is charged to the bound it was reserved under rather than becoming free
      // capacity for a rolling 24 h.
      if (reservationLane !== lane) continue;
      count += 1;
    }
    // PHASE3.25 R5.3 — settlement and drift have independent signed bounds.
    // The shared spacing check below is their only coupling.
    if (count >= quotaLimitFor(lane, quota)) {
      throw new LpExitQuotaError("quota-exhausted", lane);
    }
    if (
      // Guarded on ANY in-window row, not on the live count: with the only
      // row released, `count` is 0 and a `count > 0` guard would skip this
      // check entirely — the M3 split collapsing back into one filter through
      // the back door. `latest` is finite iff a row exists, released or not.
      latest !== Number.NEGATIVE_INFINITY &&
      now - latest < quota.minMinutesBetweenExits * 60_000
    ) {
      throw new LpExitQuotaError("min-interval", lane);
    }
  }

  #ownedPosition(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): LpPositionRecord | undefined {
    const record = this.#positions.get(positionId);
    if (record === undefined) return undefined;
    return record.ownerAddress === ownerKey(ownerAddress) &&
      record.agentId === agentId
      ? record
      : undefined;
  }

  #ownedSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): LpSequenceRecord | undefined {
    const record = this.#sequences.get(sequenceId);
    if (record === undefined) return undefined;
    return record.ownerAddress === ownerKey(ownerAddress) &&
      record.agentId === agentId
      ? record
      : undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type PositionRow = {
  position_id: string;
  agent_id: string;
  owner_address: string;
  token0: string;
  token1: string;
  fee: number;
  token_id: string | null;
  lineage_id: string;
  basis_wei: string | number | null;
  basis_source: string;
  quote_token: string;
  state: string;
  ownership_mismatch_count: number | string | null;
  ownership_lost_reason: string | null;
  /** PHASE3.22 R4.2.2 — why the row was closed; null on every row not closed by a cause worth naming. */
  close_reason: string | null;
  ownership_first_seen_at: number | string | null;
  /** PHASE3.17 R2.3. Nullable and additive; every pre-3.17 row reads null. */
  arm_group_id: string | null;
  arm_meta: unknown;
  /** PHASE3.18 R2.6. Nullable and additive; fixed mode never reads them. */
  grid_level: number | string | null;
  grid_role: string | null;
  /** PHASE3.19 C4. Nullable and additive; non-null ONLY on a ladder's anchor. */
  inventory_base_wei: string | number | null;
  inventory_cost_wbnb_wei: string | number | null;
  row_version: number | string | null;
  created_at: Date;
  updated_at: Date;
};

type SequenceRow = {
  prior_token_id: string | null;
  sequence_id: string;
  agent_id: string;
  owner_address: string;
  position_id: string;
  kind: string;
  inline_convert: boolean | null;
  inline_residue_base_wei: string | number | null;
  state: string;
  recovery_state: string;
  steps: unknown;
  note: string | null;
  stall_code: string | null;
  stall_count: string | number | null;
  resolver_prior_state: string | null;
  resolver_prior_recovery_state: string | null;
  resolver_fence: string | number | bigint | null;
  resolver_lease_until: Date | null;
  resolver_snapshot_hash: Hex | null;
  resolver_row_version: string | number | null;
  resolution_id: string | null;
  resolver_action_idempotency_key: string | null;
  resolution_disposition_started: boolean | null;
  retirement_prior_state: string | null;
  retirement_prior_recovery_state: string | null;
  retirement_target_journal_key: string | null;
  retirement_action_idempotency_key: string | null;
  retirement_fence: string | number | bigint | null;
  retirement_lease_until: Date | null;
  retirement_snapshot_hash: Hex | null;
  retirement_row_version: string | number | null;
  retirement_disposition_started: boolean | null;
  /** PHASE3.18 R2.3/C4 — the requote's persisted target; null on every other kind. */
  target_tick_lower: number | string | null;
  target_tick_upper: number | string | null;
  /** PHASE3.22 R8 / R2.19 — the shift's persisted SELL target; null elsewhere. */
  target_sell_tick_lower: number | string | null;
  target_sell_tick_upper: number | string | null;
  /** PHASE3.23 R3.2 — nullable shift authorization discriminator. */
  shift_cause: string | null;
  /** PHASE3.19 item 8 — the ladder hedge's persisted intent; null elsewhere. */
  hedge_direction: string | null;
  hedge_amount_in_wei: string | number | null;
  /** PHASE3.20 item 7 — the ladder motion's lane evidence; null elsewhere. */
  recenter_evidence: string | null;
  created_at: Date;
  updated_at: Date;
};

/** PHASE3.19 R4.1 / D3 — one append-only credit row of the VWAP book. */
type InventoryCreditRow = {
  application_key: string;
  owner_address: string;
  agent_id: string;
  position_id: string;
  arm_group_id: string | null;
  delta_base_wei: string | number;
  delta_cost_wbnb_wei: string | number;
  created_at: Date;
};

type ReservationRow = {
  sequence_id: string;
  agent_id: string;
  owner_address: string;
  kind: string;
  quota_bound: boolean;
  reserved_at: Date;
  released_at: Date | null;
  /** PHASE3.20 item 7 — nullable and additive; every pre-3.20 row reads null. */
  quota_lane: string | null;
};

/**
 * PHASE3.19 C11 — the two book columns join the SHARED SELECT LIST, AT THE END.
 *
 * A column missing here reads `null` for ever and the book silently stays zero,
 * which C11 names as the highest-consequence omission in the threading list.
 *
 * THEY ARE APPENDED RATHER THAN INSERTED, and that is deliberate rather than
 * tidy: `test/lp.gridRequote.store.test.ts` pins the TAIL of this list as a
 * source-text regex (`arm_group_id, grid_level, grid_role, row_version`), and a
 * column list is an unordered set as far as `returning` is concerned — so
 * appending keeps a shipped 3.18 assertion green with NO edit, which is exactly
 * what §7's compatibility guarantee asks for. Inserting them mid-list would
 * have forced a second declared test edit for no gain at all.
 */
const POSITION_COLUMNS =
  "position_id, agent_id, owner_address, token0, token1, fee, token_id, lineage_id, basis_wei, basis_source, quote_token, state, ownership_mismatch_count, ownership_lost_reason, ownership_first_seen_at, arm_group_id, arm_meta, grid_level, grid_role, row_version, created_at, updated_at, inventory_base_wei, inventory_cost_wbnb_wei, close_reason";

/**
 * PHASE3.24 C2/C3: the new columns precede the most recently pinned 3.22/3.23
 * tail. SQL projection order is immaterial; retaining that tail byte-for-byte
 * keeps the older persistence seam independently pinned.
 */
const SEQUENCE_COLUMNS =
  "sequence_id, agent_id, owner_address, position_id, kind, state, recovery_state, steps, note, stall_code, stall_count, resolver_prior_state, resolver_prior_recovery_state, resolver_fence, resolver_lease_until, resolver_snapshot_hash, resolver_row_version, resolution_id, resolver_action_idempotency_key, resolution_disposition_started, retirement_prior_state, retirement_prior_recovery_state, retirement_target_journal_key, retirement_action_idempotency_key, retirement_fence, retirement_lease_until, retirement_snapshot_hash, retirement_row_version, retirement_disposition_started, target_tick_lower, target_tick_upper, created_at, updated_at, hedge_direction, hedge_amount_in_wei, recenter_evidence, prior_token_id, inline_convert, inline_residue_base_wei, target_sell_tick_lower, target_sell_tick_upper, shift_cause";

const INVENTORY_CREDIT_COLUMNS =
  "application_key, owner_address, agent_id, position_id, arm_group_id, delta_base_wei, delta_cost_wbnb_wei, created_at";

/**
 * PHASE3.20 C13 — `quota_lane` joins the list AT THE END, same rule and same
 * reason as `recenter_evidence` on {@link SEQUENCE_COLUMNS}: four shipped
 * source-text pins read the TAIL of these lists as regexes (N10), and a column
 * list is an unordered set as far as `select`/`returning` are concerned, so
 * appending keeps every one of them green with no edit.
 */
const RESERVATION_COLUMNS =
  "sequence_id, agent_id, owner_address, kind, quota_bound, reserved_at, released_at, quota_lane";

/**
 * Lifecycle STATES carry CHECK constraints (a bad state is corruption); step
 * KINDS deliberately do not — they live inside the `steps` jsonb, so the
 * reserved `stake`/`unstake`/`harvest-cake` vocabulary ships without a
 * migration when the CAKE phase lands.
 */
const LP_POSITIONS_DDL = `
  create table if not exists lp_positions (
    position_id text primary key,
    agent_id text not null,
    owner_address text not null,
    token0 text not null,
    token1 text not null,
    fee int not null,
    token_id text,
    lineage_id text not null,
    basis_wei numeric(78, 0) not null,
    basis_source text not null,
    quote_token text not null,
    state text not null check (state in ('open', 'closing', 'closed')),
    row_version bigint not null default 0 check(row_version >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )
`;

const LP_POSITIONS_OWNER_INDEX_DDL = `
  create index if not exists lp_positions_owner_idx
    on lp_positions (owner_address, agent_id)
`;

/**
 * PHASE3.4 Rev2 M6. Additive and nullable, so an existing Phase 3 deployment
 * reads `null` on both — a bare `create table if not exists` does NOTHING to an
 * existing table, the lesson `LP_SEQUENCES_NOTE_COLUMN_DDL` already carries.
 */
const LP_POSITIONS_OWNERSHIP_COLUMNS_DDL = [
  `alter table lp_positions add column if not exists ownership_mismatch_count int`,
  `alter table lp_positions add column if not exists ownership_lost_reason text`,
  // PHASE3.22 R4.2.2 — the close cause. Additive and nullable like its
  // neighbours, so every existing row reads null and every path that does not
  // write it is unchanged.
  `alter table lp_positions add column if not exists close_reason text`,
  // F1's anchor. `bigint` epoch MILLISECONDS rather than `timestamptz`, because
  // the value is the worker's frozen cycle clock — the same units every other
  // clock in this subsystem speaks — and round-tripping it through a date type
  // would invite exactly the stamp-vs-clock confusion F1 is about.
  `alter table lp_positions add column if not exists ownership_first_seen_at bigint`,
  `alter table lp_positions add column if not exists row_version bigint not null default 0`,
  /*
   * PHASE3.17 R2.3 — the dual arm's durable pairing. Additive, nullable, TEXT.
   *
   * TEXT and not `uuid`, deliberately and on this table's own precedent:
   * `position_id`, `agent_id` and `lineage_id` are all `text` here while
   * carrying uuids, the store hands the driver a plain string, and a `uuid`
   * column would make an unparseable value a driver-level 500 in a column whose
   * only job is equality against a sibling. Nothing indexes it: a group is at
   * most two rows and is only ever read through `listPositions`, which is
   * already owner-and-agent scoped and already in hand at every site that needs
   * the sibling.
   */
  `alter table lp_positions add column if not exists arm_group_id text`,
  `alter table lp_positions add column if not exists arm_meta jsonb`,
] as const;

/**
 * ONE non-closed row per NFT (PHASE3.4 Rev2 M5).
 *
 * NOT owner-scoped and NOT agent-scoped, and that is the decision rather than an
 * oversight: an NFPM position is ONE object on chain, and two rows driving sagas
 * at it is the worst state import can create — two rotates, two `zap-out`s, the
 * second against liquidity that is already gone. The per-position sequence lock
 * cannot see that collision because it is keyed on `position_id`.
 *
 * SAFE against existing data: tokenIds enter rows only from confirmed mint
 * receipts (each mint is a fresh id) and a rotate updates in place, so no landed
 * path can have produced two non-closed rows sharing one. A hand-edited database
 * fails the BOOT loudly, which is the correct posture.
 *
 * `state <> 'closed'` is what makes a re-import after a product close legal: the
 * old row is history, its basis already reset to `0n` by the close, and the new
 * row is a new declaration on a new lineage.
 */
const LP_POSITIONS_TOKEN_INDEX_DDL = `
  create unique index if not exists ${LP_LIVE_TOKEN_INDEX_NAME}
    on lp_positions (token_id)
    where token_id is not null and state <> 'closed'
`;

const LP_SEQUENCES_DDL = `
  create table if not exists lp_sequences (
    sequence_id text primary key,
    agent_id text not null,
    owner_address text not null,
    position_id text not null,
    kind text not null check (kind in ('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote')),
    state text not null check (state in ('active', 'completed', 'held', 'abandoning', 'resolving', 'retiring-pre-bind', 'rolled-back')),
    -- PHASE3.22 R5.2 site 3. This literal only ever helps a FRESH database; an
    -- existing deployment is migrated by the guarded drop/add block in the
    -- shipped migration list below. Both are required, and the migration is the
    -- one that matters: without it the pre-submit setRecoveryState write
    -- raises a constraint violation on Postgres, the throw escapes
    -- driveSequence before any submit (fail-closed, so no money moves) and
    -- the mode simply never runs, while every memory-backend test stays green.
    -- That offline-green / live-dead split is the exact hazard D2 named.
    recovery_state text not null check (recovery_state in ('pending-mint', 'pending-increase', 'wbnb-stranded', 'shift-ambiguous', 'rotate-ambiguous', 'none')),
    steps jsonb not null,
    note text,
    inline_convert boolean,
    inline_residue_base_wei numeric(78, 0),
    abandon_claim_id text,
    abandon_claimed_at bigint,
    abandon_disposition_started_at bigint,
    resolver_prior_state varchar(16),
    resolver_prior_recovery_state varchar(32),
    resolver_fence numeric(20,0) not null default 0,
    resolver_lease_until timestamptz,
    resolver_snapshot_hash char(66),
    resolver_row_version bigint not null default 0,
    resolution_id varchar(128),
    resolver_action_idempotency_key varchar(128),
    resolution_disposition_started boolean not null default false,
    retirement_prior_state varchar(16),
    retirement_prior_recovery_state varchar(32),
    retirement_target_journal_key varchar(128),
    retirement_action_idempotency_key varchar(128),
    retirement_fence numeric(20,0) not null default 0,
    retirement_lease_until timestamptz,
    retirement_snapshot_hash char(66),
    retirement_row_version bigint not null default 0,
    retirement_disposition_started boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )
`;

/**
 * PHASE3.1 Rev2 item 15 — the ONE schema change this phase makes.
 *
 * REQUIRED beside the DDL above, and not merely tidy: a bare
 * `create table if not exists` does NOTHING to an EXISTING table, so every
 * deployment that already ran Phase 3 would keep a `lp_sequences` with no
 * `note` column and `SEQUENCE_COLUMNS` would fail on the first select.
 * Nullable and additive, so old rows read `null`.
 */
const LP_SEQUENCES_NOTE_COLUMN_DDL = `
  alter table lp_sequences add column if not exists note text
`;

/**
 * PHASE3.24 C2/C3 — additive, nullable columns behind a guarded DO block.
 * NULL consent deliberately means false for every legacy row. The lock makes
 * concurrent server/worker initialization observe one completed migration.
 */
const LP_SEQUENCES_INLINE_CONVERSION_DDL = `
  do $lp_sequences_inline_conversion$
    begin
      lock table lp_sequences in access exclusive mode;
      if not exists (
        select 1 from pg_attribute
         where attrelid = 'lp_sequences'::regclass
           and attname = 'inline_convert'
           and not attisdropped
      ) then
        alter table lp_sequences add column inline_convert boolean;
      end if;
      if not exists (
        select 1 from pg_attribute
         where attrelid = 'lp_sequences'::regclass
           and attname = 'inline_residue_base_wei'
           and not attisdropped
      ) then
        alter table lp_sequences add column inline_residue_base_wei numeric(78, 0);
      end if;
    end
  $lp_sequences_inline_conversion$
`;

/**
 * PHASE3.11 F1's stall latch. Additive and nullable/defaulted for the same
 * reason the note column is: old rows must read as "never stalled", which is
 * `stall_count = 0` — the value that keeps the worker resuming exactly as it
 * does today.
 */
const LP_SEQUENCES_STALL_COLUMNS_DDL = [
  `alter table lp_sequences add column if not exists stall_code varchar(64)`,
  `alter table lp_sequences add column if not exists stall_count int not null default 0`,
];

/**
 * PHASE3.8 N1. The lease fields are additive; old rows read null. The state
 * constraint must be widened explicitly because `create table if not exists`
 * cannot alter an existing deployment. The conditional block is idempotent
 * across server/worker boot and only replaces the legacy, narrower definition.
 */
const LP_SEQUENCES_ABANDON_CLAIM_DDL = [
  `alter table lp_sequences add column if not exists abandon_claim_id text`,
  `alter table lp_sequences add column if not exists abandon_claimed_at bigint`,
  `alter table lp_sequences add column if not exists abandon_disposition_started_at bigint`,
  `do $$
     begin
       -- Server and worker initialize the same store independently. Take the
       -- table lock before inspecting the legacy definition so the second
       -- initializer observes the first one's completed replacement rather
       -- than acting on a stale pre-lock snapshot.
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_state_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%retiring-pre-bind%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_state_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_state_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_state_check
           check (state in ('active', 'completed', 'held', 'abandoning', 'resolving', 'retiring-pre-bind', 'rolled-back'));
       end if;
     end
   $$`,
] as const;

/**
 * PHASE3.15 (R2.9 item 6 / OQ3, C10) — widening `lp_sequences_kind_check` for
 * `'grid-flip'`.
 *
 * A bare `create table if not exists` does NOTHING to an EXISTING table, so the
 * widened list above reaches a fresh database only; every deployment that
 * already ran Phase 3 keeps the narrow CHECK and would reject the first grid
 * flip at insert. This is NOT the repo's first constraint migration — the
 * precedent is {@link LP_SEQUENCES_ABANDON_CLAIM_DDL}'s guarded `DO` for
 * `lp_sequences_state_check`, and this is a STRUCTURAL COPY of it: take the
 * table lock first (server and worker initialize the same store
 * independently, so the second initializer must observe the first one's
 * completed replacement rather than a stale pre-lock snapshot), drop the
 * constraint only when its definition lacks the new member, re-add it only
 * when absent. Idempotent across both boots.
 *
 * THREE OBLIGATIONS RIDE WITH IT (C10), and none is discharged by this comment:
 * a TEXT-level pin on this DDL (the `lpQuotaRelease` precedent), the fakeSql
 * mirroring under the PHASE3.7-AUDIT A6 warning, and a both-backends test that
 * the widened CHECK ACCEPTS `grid-flip` and still REJECTS an unknown kind.
 *
 * `recovery_state` is deliberately NOT widened: the flip declares only existing
 * `LpRecoveryState` members (R2.5's table), which is what keeps this phase to
 * ONE constraint migration.
 */
const LP_SEQUENCES_KIND_CHECK_DDL = [
  `do $lp_sequences_kind$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%grid-flip%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_kind_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_kind_check
           check (kind in ('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip'));
       end if;
     end
   $lp_sequences_kind$`,
] as const;

/**
 * PHASE3.16 R2.4 — the THIRD guarded-`DO` widening of a `lp_sequences` CHECK
 * (after `lp_sequences_state_check` for `retiring-pre-bind` and
 * {@link LP_SEQUENCES_KIND_CHECK_DDL} for `grid-flip`), here for `'grid-arm'`.
 *
 * WHY A SEPARATE BLOCK RATHER THAN A WIDER LIST IN THE 3.15 ONE: that block's
 * drop is guarded on the live definition LACKING `'%grid-flip%'`, so a database
 * that already ran 3.15 never re-enters it however the re-add list is written.
 * Widening only its list would therefore reach a FRESH database (which already
 * gets the full list from `create table`) and no other. Chaining a second
 * guarded block, keyed on its OWN member, is the shape that actually migrates
 * every deployment, and it is idempotent from any starting point:
 *
 *   fresh DB        — both blocks see their member present; neither fires.
 *   a 3.15 DB       — this block alone fires: drop, re-add with `grid-arm`.
 *   a Phase-3 DB    — the 3.15 block re-adds through `grid-flip`, then this one
 *                     re-adds through `grid-arm`, in the same boot.
 *
 * The table lock is taken first for the same reason it is there: server and
 * worker initialize the same store independently, so the second initializer
 * must observe the first one's completed replacement, not a stale pre-lock
 * snapshot.
 *
 * `recovery_state` is again NOT widened — the arm is a ONE-step saga and
 * declares only existing {@link LpRecoveryState} members.
 */
const LP_SEQUENCES_ARM_KIND_CHECK_DDL = [
  `do $lp_sequences_arm_kind$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%grid-arm%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_kind_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_kind_check
           check (kind in ('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm'));
       end if;
     end
   $lp_sequences_arm_kind$`,
] as const;

/**
 * PHASE3.18 — the FOURTH guarded-`DO` widening of `lp_sequences_kind_check`,
 * here for `'grid-requote'`.
 *
 * A SEPARATE BLOCK, for the reason the 3.16 block's own header gives: each
 * earlier block's DROP is guarded on the live definition LACKING that block's
 * OWN member, so a database that already ran 3.16 never re-enters the 3.16
 * block however its re-add list is written. Widening an earlier list would
 * therefore reach a FRESH database (which already gets the full list from
 * `create table`) and no other. Chaining, keyed on its own member, is the shape
 * that actually migrates every deployment, and it is idempotent from any start:
 *
 *   fresh DB     — all four blocks see their member present; none fires.
 *   a 3.17 DB    — this block alone fires: drop, re-add with `grid-requote`.
 *   a 3.15 DB    — the arm block re-adds through `grid-arm`, then this one
 *                  re-adds through `grid-requote`, in the same boot.
 *
 * `recovery_state` is again NOT widened: a requote is flip-SHAPED and declares
 * only existing {@link LpRecoveryState} members.
 */
const LP_SEQUENCES_REQUOTE_KIND_CHECK_DDL = [
  `do $lp_sequences_requote_kind$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%grid-requote%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_kind_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_kind_check
           check (kind in ('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote'));
       end if;
     end
   $lp_sequences_requote_kind$`,
] as const;

/**
 * PHASE3.18 R2.3 / C4 — THE REQUOTE'S PERSISTED TARGET, as two additive
 * nullable integer columns.
 *
 * WHY IT IS PERSISTED AT ALL, cited from measurement rather than from taste:
 * FINDINGS (aw) recorded that on the BSC relay RESUME IS THE DEFAULT PATH —
 * 6 of 6 mainnet submissions published after `awaitExecution`'s deadline, so
 * every arm and every flip completed through the worker's resume. A requote
 * that re-derived its target at resume time would therefore, in ordinary
 * operation, bind a rung the trigger never saw and the owner's own drift
 * evidence never justified. That is exactly what
 * `LpGridFlipDeps.targetRange`'s "Never derived" contract forbids for the flip.
 *
 * Written in the SAME TRANSACTION that creates the sequence (`createSequence`),
 * ignored by every non-requote kind, and read back on every resume with ONE
 * precedence rule: the persisted target WINS, and a recomputation that
 * disagrees is a THROW, never an overwrite.
 */
const LP_SEQUENCES_TARGET_RANGE_DDL = [
  `alter table lp_sequences add column if not exists target_tick_lower int`,
  `alter table lp_sequences add column if not exists target_tick_upper int`,
  // PHASE3.22 R8 / R2.19 — the SHIFT's second target. Additive and nullable in
  // the same style as the pair above, so an existing deployment reads NULL on
  // both and every non-shift kind never looks. Named in R2.19's plumbing list
  // together with SEQUENCE_COLUMNS, the INSERT list, the row mapper and
  // test/support/fakeSql.ts — the PHASE3.7-AUDIT A6 hazard, which is that a
  // column added here and missed in SEQUENCE_COLUMNS fails on the first select.
  `alter table lp_sequences add column if not exists target_sell_tick_lower int`,
  `alter table lp_sequences add column if not exists target_sell_tick_upper int`,
] as const;

/** PHASE3.23 REVIEW2 N2 — additive nullable cause, no backfill. */
const LP_SEQUENCES_SHIFT_CAUSE_DDL = [
  `alter table lp_sequences add column if not exists shift_cause text`,
  `do $lp_sequences_shift_cause$
     begin
       lock table lp_sequences in access exclusive mode;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_shift_cause_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_shift_cause_check
           check (shift_cause is null or shift_cause in ('cross', 'drift'));
       end if;
     end
   $lp_sequences_shift_cause$`,
] as const;

/**
 * PHASE3.18 R2.6 (ruling Q2) — the DURABLE GRID IDENTITY, as two additive
 * nullable columns on `lp_positions`.
 *
 * `grid_level` names WHICH of a dual grid's two row-groups a position belongs
 * to; `grid_role` names which side it is armed on. Both are needed and neither
 * substitutes for the other:
 *
 *  - the LEVEL is not a geometry, so storing it does not reopen 3.17 H3 (which
 *    refused a stored role on the ground that a C2 re-sign staled it against
 *    the signed rungs — in policy mode there are no fixed rungs for it to go
 *    stale against, and the geometry is always the signed policy);
 *  - the ROLE cannot be read from the chain ticks, because the side INVERTS at
 *    the moment of a fill, which is the one moment it is consulted. It is
 *    written by the same write that sets the tokenId, so role and tokenId can
 *    never disagree.
 *
 * FIXED mode IGNORES both and exact-tick match stays the authority, so the
 * audited 3.15-3.17 path does not move. In POLICY mode a null on either is a
 * HOLD naming the remedy and a THROW at the deps seam — never a guess.
 */
const LP_POSITIONS_GRID_IDENTITY_DDL = [
  `alter table lp_positions add column if not exists grid_level int`,
  `alter table lp_positions add column if not exists grid_role text`,
] as const;

/**
 * PHASE3.19 B3 / C4 / C11 — THE LADDER'S VWAP BOOK, as two additive nullable
 * numeric columns on `lp_positions`.
 *
 * Additive and nullable in the `arm_group_id` / `grid_level` style: an existing
 * deployment reads null on both, no CHECK is touched, no sequence schema
 * changes. NULL means "this row is not a ladder's book anchor"; ZERO means "the
 * anchor holds no acquired base", which the markout gate REFUSES on rather than
 * dividing by (D1). The two are different states and the difference is
 * load-bearing.
 */
const LP_POSITIONS_INVENTORY_DDL = [
  `alter table lp_positions add column if not exists inventory_base_wei numeric(78, 0)`,
  `alter table lp_positions add column if not exists inventory_cost_wbnb_wei numeric(78, 0)`,
] as const;

/**
 * PHASE3.19 item 8 — the ladder hedge's PERSISTED INTENT, two additive nullable
 * columns on `lp_sequences`, written BEFORE the swap is submitted.
 *
 * Same style, same reason: additive, nullable, no CHECK touched. The intent is
 * the one money amount in this plane that is BALANCE-derived rather than
 * receipt-derived, so a resume that re-derived it at a different price would
 * bind a different swap at market — 3.18's B4 in a step that trades.
 */
const LP_SEQUENCES_HEDGE_INTENT_DDL = [
  `alter table lp_sequences add column if not exists hedge_direction text`,
  `alter table lp_sequences add column if not exists hedge_amount_in_wei numeric(78, 0)`,
] as const;

/**
 * PHASE3.20 item 7 — THE LADDER MOTION'S LANE EVIDENCE, one additive nullable
 * CHECK-constrained column on `lp_sequences`.
 *
 * Additive and nullable in the `target_tick_lower` / `hedge_direction` style: an
 * existing deployment reads null, no existing CHECK is touched, no sequence kind
 * is added. NULL means "written before 3.20, or not a ladder motion", and it
 * reserves in the SETTLEMENT lane (C6) — the conservative reading, and the one
 * that keeps `settlement + drift === recenter` true.
 *
 * THE CHECK IS A SEPARATE, GUARDED STATEMENT rather than part of the column
 * definition, on the kind-CHECK precedent: `add column if not exists` does
 * nothing to a table that already has the column, so a constraint bundled into
 * it would never land on a second deployment.
 */
const LP_SEQUENCES_RECENTER_EVIDENCE_DDL = [
  `alter table lp_sequences add column if not exists recenter_evidence text`,
  `do $$
   begin
     if not exists (
       select 1 from pg_constraint
       where conname = 'lp_sequences_recenter_evidence_check'
     ) then
       alter table lp_sequences add constraint lp_sequences_recenter_evidence_check
         check (recenter_evidence is null or recenter_evidence in ('settlement', 'drift'));
     end if;
   end $$;`,
] as const;

/**
 * PHASE3.20 item 7 — THE RESERVATION'S OWN LANE, one additive nullable column on
 * `lp_exit_reservations`, copied from the sequence row at reserve.
 *
 * It exists because `quotaLaneOf(kind)` cannot separate two dispatches that
 * share the kind `grid-recenter`, and the reservation table is what the two
 * refusing seams scan. Same NULL rule as its source column, and — critically —
 * the SQL that reads it must spell the NULL arm out (R4.1/B1), because `null =
 * 'settlement'` is UNKNOWN, not true, and a legacy row would otherwise fall out
 * of both counts.
 */
const LP_RESERVATIONS_QUOTA_LANE_DDL = `
  alter table lp_exit_reservations add column if not exists quota_lane text
`;

/**
 * PHASE3.19 R4.1 / D3 — THE APPEND-ONLY CREDIT SET that makes the book's
 * advance replay-safe BY CONSTRUCTION.
 *
 * A new TABLE rather than an additive column, and that is the honest price of a
 * correct guard (N16): `sagas.ts`'s replay loop re-runs EVERY confirmed step's
 * `after` on EVERY resume — and resume is the DEFAULT path on this relay
 * (FINDINGS (aw)) — so a single "last applied" slot thrashes between the two
 * book-writing steps of one sequence and never converges, and the shared anchor
 * book (C4) additionally interleaves two rows' sequences on it. A SET keyed on
 * the step's globally-unique JOURNAL IDEMPOTENCY KEY is order-independent,
 * replay-proof and cross-row safe.
 *
 * D3 — owner-scoped like every other table here. `arm_group_id` is
 * server-generated so this is not a live exploit, but a table whose rows cannot
 * be filtered by owner is a structural exception to the Phase 1a invariant, and
 * this store does not take those.
 *
 * LOCK ORDER: exactly one transaction shape touches this table, and it takes
 * the credit row and then the anchor `lp_positions` row, always in that order.
 * Nothing else in the tree touches it, so two concurrent instances contend only
 * on the anchor row and in the same order.
 */
const LP_INVENTORY_CREDITS_DDL = `
  create table if not exists lp_inventory_credits (
    application_key text primary key,
    owner_address text not null,
    agent_id text not null,
    position_id text not null,
    arm_group_id text,
    delta_base_wei numeric(78, 0) not null,
    delta_cost_wbnb_wei numeric(78, 0) not null,
    created_at timestamptz not null default now()
  )
`;

const LP_INVENTORY_CREDITS_INDEX_DDL = `
  create index if not exists lp_inventory_credits_position_idx
    on lp_inventory_credits (owner_address, agent_id, position_id)
`;

/**
 * PHASE3.19 item 32 — the FIFTH guarded-`DO` widening of
 * `lp_sequences_kind_check`, here for `'grid-recenter'`.
 *
 * A SEPARATE BLOCK, for the reason every earlier block's header gives: each
 * block's DROP is guarded on the live definition LACKING that block's OWN
 * member, so a database that already ran an earlier phase never re-enters that
 * phase's block however its re-add list is written. Chaining, keyed on its own
 * member, is the shape that actually migrates every deployment, and it is
 * idempotent from any start:
 *
 *   fresh DB   — all five blocks see their member present; none fires.
 *   a 3.18 DB  — this block alone fires: drop, re-add with `grid-recenter`.
 *   a 3.15 DB  — the arm block re-adds through `grid-arm`, the requote block
 *                through `grid-requote`, then this one through `grid-recenter`,
 *                in the same boot.
 *
 * `recovery_state` is again NOT widened: a ladder motion is flip-SHAPED and
 * declares only existing {@link LpRecoveryState} members.
 */
const LP_SEQUENCES_RECENTER_KIND_CHECK_DDL = [
  `do $lp_sequences_recenter_kind$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%grid-recenter%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_kind_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_kind_check
           check (kind in ('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote', 'grid-recenter'));
       end if;
     end
   $lp_sequences_recenter_kind$`,
] as const;

/**
 * PHASE3.22 R2.19 / C7 — the guarded-`DO` widening of `lp_sequences_kind_check`
 * for `'grid-shift'`.
 *
 * ─── C7's DISAMBIGUATION SENTENCE, because two counts are both correct ───────
 *
 * This is the **FIFTH `do $lp_sequences_*_kind$` BLOCK** in this file (kind,
 * arm_kind, requote_kind, recenter_kind, and this one) and the **SIXTH
 * definition** of the constraint's member list, because the base
 * `create table` list in {@link LP_SEQUENCES_DDL} is itself the first
 * definition. R2.19 calls this "the FIFTH guarded-DO widening" and the 3.19
 * header above calls ITSELF "the FIFTH" — both are right, counting different
 * things. The block count is what a builder needs when adding the next one;
 * the definition count is what a reader needs when auditing the list.
 *
 * `grid-shift` is the **TENTH** {@link LpSequenceKind}.
 *
 * A SEPARATE BLOCK, for the reason every earlier block's header gives: each
 * block's DROP is guarded on the live definition LACKING that block's OWN
 * member, so a database that already ran an earlier phase never re-enters that
 * phase's block however its re-add list is written. Chaining, keyed on its own
 * member, is the shape that actually migrates every deployment, and it is
 * idempotent from any start:
 *
 *   fresh DB   — all five blocks see their member present; none fires.
 *   a 3.19 DB  — this block alone fires: drop, re-add with `grid-shift`.
 *   a 3.15 DB  — arm, requote, recenter and then this one, in the same boot.
 *
 * Unlike every block before it, this phase DOES also widen `recovery_state` —
 * see {@link LP_SEQUENCES_SHIFT_RECOVERY_CHECK_DDL}, which is a SEPARATE block
 * because it is a different constraint on a different column and must migrate
 * independently of the kind list.
 */
const LP_SEQUENCES_SHIFT_KIND_CHECK_DDL = [
  `do $lp_sequences_shift_kind$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%grid-shift%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_kind_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_kind_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_kind_check
           check (kind in ('protect', 'rotate', 'harvest', 'open', 'manual-exit', 'grid-flip', 'grid-arm', 'grid-requote', 'grid-recenter', 'grid-shift'));
       end if;
     end
   $lp_sequences_shift_kind$`,
] as const;

/**
 * PHASE3.22 R5.2 site 3 (REVIEW4 D2, "THIS IS THE KILLER") — the guarded-`DO`
 * widening of `lp_sequences_recovery_state_check` for `'shift-ambiguous'`.
 *
 * THE FIRST `recovery_state` WIDENING THIS REPO HAS EVER NEEDED. Five phases of
 * grid work declared only existing {@link LpRecoveryState} members, and each of
 * their kind-CHECK headers says so in a closing line ("`recovery_state` is
 * again NOT widened"). 3.22 is the phase that breaks that streak, because the
 * one-submission saga has an ambiguous state none of the three existing markers
 * describes.
 *
 * WITHOUT THIS BLOCK the mode is DEAD ON THE ONLY SUPPORTED BACKEND while every
 * memory-backend test stays green: the pre-submit `setRecoveryState` write
 * raises a constraint violation on Postgres, the throw escapes `driveSequence`
 * before any submit — fail-closed, so no money moves — and the shift simply
 * never runs. That offline-green / live-dead split is precisely what D2 called
 * "the split this repo keeps paying for", and it is why this block is built in
 * step 2a, ahead of everything that writes the marker.
 *
 * THE CONSTRAINT NAME is the one Postgres generates for an inline column
 * `check` in {@link LP_SEQUENCES_DDL}: `<table>_<column>_check`. The guard
 * tolerates its absence (a database whose constraint was hand-dropped simply
 * gets it added), so the block is idempotent from any start:
 *
 *   fresh DB — the DDL literal already lists the member; the drop is skipped
 *              and the add is skipped. Nothing fires.
 *   a <=3.20 DB — the live definition lacks `shift-ambiguous`: drop, re-add
 *                 with all five members.
 *   re-boot   — the member is present; nothing fires.
 *
 * The `lock table ... in access exclusive mode` is the sibling blocks' own
 * shape and is what makes a concurrent server/worker boot safe: the second
 * boot blocks until the first commits, then finds its member present.
 */
const LP_SEQUENCES_SHIFT_RECOVERY_CHECK_DDL = [
  `do $lp_sequences_shift_recovery$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_recovery_state_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%shift-ambiguous%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_recovery_state_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_recovery_state_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_recovery_state_check
           check (recovery_state in ('pending-mint', 'pending-increase', 'wbnb-stranded', 'shift-ambiguous', 'none'));
       end if;
     end
   $lp_sequences_shift_recovery$`,
] as const;

const LP_SEQUENCES_ROTATE_RECOVERY_CHECK_DDL = [
  `do $lp_sequences_rotate_recovery$
     begin
       lock table lp_sequences in access exclusive mode;
       if exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_recovery_state_check'
            and conrelid = 'lp_sequences'::regclass
            and pg_get_constraintdef(oid) not like '%rotate-ambiguous%'
       ) then
         alter table lp_sequences drop constraint lp_sequences_recovery_state_check;
       end if;
       if not exists (
         select 1 from pg_constraint
          where conname = 'lp_sequences_recovery_state_check'
            and conrelid = 'lp_sequences'::regclass
       ) then
         alter table lp_sequences add constraint lp_sequences_recovery_state_check
           check (recovery_state in ('pending-mint', 'pending-increase', 'wbnb-stranded', 'shift-ambiguous', 'rotate-ambiguous', 'none'));
       end if;
     end
   $lp_sequences_rotate_recovery$`,
] as const;

const LP_SEQUENCES_RESOLVER_DDL = [
  `alter table lp_sequences add column if not exists resolver_prior_state varchar(16)`,
  `alter table lp_sequences add column if not exists resolver_prior_recovery_state varchar(32)`,
  `alter table lp_sequences add column if not exists resolver_fence numeric(20,0) not null default 0`,
  `alter table lp_sequences add column if not exists resolver_lease_until timestamptz`,
  `alter table lp_sequences add column if not exists resolver_snapshot_hash char(66)`,
  `alter table lp_sequences add column if not exists resolver_row_version bigint not null default 0`,
  `alter table lp_sequences add column if not exists resolution_id varchar(128)`,
  `alter table lp_sequences add column if not exists resolver_action_idempotency_key varchar(128)`,
  `alter table lp_sequences add column if not exists resolution_disposition_started boolean not null default false`,
  `do $lp_resolver_shape$
   begin
     lock table lp_sequences in access exclusive mode;
     if exists (select 1 from pg_constraint
       where conname='lp_sequences_resolver_shape_check' and conrelid='lp_sequences'::regclass
         and pg_get_constraintdef(oid) like '%retiring-pre-bind%') then
       alter table lp_sequences drop constraint lp_sequences_resolver_shape_check;
     end if;
     if not exists (select 1 from pg_constraint
       where conname='lp_sequences_resolver_shape_check' and conrelid='lp_sequences'::regclass) then
       alter table lp_sequences add constraint lp_sequences_resolver_shape_check check(
         (state = 'resolving' and resolver_prior_state in ('active','held') and
          resolver_prior_recovery_state is not null and resolver_lease_until is not null and
          resolver_snapshot_hash ~ '^0x[0-9a-f]{64}$' and resolution_id is not null and
          resolver_action_idempotency_key is not null and resolver_fence>0)
         or
         (state <> 'resolving' and resolver_prior_state is null and
          resolver_prior_recovery_state is null and resolver_lease_until is null and
          resolver_snapshot_hash is null and resolution_id is null and
          resolver_action_idempotency_key is null and resolution_disposition_started=false)
       );
     end if;
   end
   $lp_resolver_shape$`,
] as const;

/**
 * The retirement claim has dedicated columns and its own shape constraint.
 * Keeping it independent from landing resolution prevents a resolver migration
 * from broadening this no-submit-only state machine by accident.
 */
const LP_SEQUENCES_RETIREMENT_DDL = [
  `alter table lp_sequences add column if not exists retirement_prior_state varchar(16)`,
  `alter table lp_sequences add column if not exists retirement_prior_recovery_state varchar(32)`,
  `alter table lp_sequences add column if not exists retirement_target_journal_key varchar(128)`,
  `alter table lp_sequences add column if not exists retirement_action_idempotency_key varchar(128)`,
  `alter table lp_sequences add column if not exists retirement_fence numeric(20,0) not null default 0`,
  `alter table lp_sequences add column if not exists retirement_lease_until timestamptz`,
  `alter table lp_sequences add column if not exists retirement_snapshot_hash char(66)`,
  `alter table lp_sequences add column if not exists retirement_row_version bigint not null default 0`,
  `alter table lp_sequences add column if not exists retirement_disposition_started boolean not null default false`,
  `do $lp_retirement_shape$
   begin
     lock table lp_sequences in access exclusive mode;
     if exists (select 1 from pg_constraint
       where conname='lp_sequences_retirement_shape_check' and conrelid='lp_sequences'::regclass
         and pg_get_constraintdef(oid) not like '%retirement_target_journal_key%') then
       alter table lp_sequences drop constraint lp_sequences_retirement_shape_check;
     end if;
     if not exists (select 1 from pg_constraint
       where conname='lp_sequences_retirement_shape_check' and conrelid='lp_sequences'::regclass) then
       alter table lp_sequences add constraint lp_sequences_retirement_shape_check check(
         (state = 'retiring-pre-bind' and retirement_prior_state in ('active','held') and
          retirement_prior_recovery_state is not null and retirement_target_journal_key is not null and
          retirement_action_idempotency_key is not null and retirement_lease_until is not null and
          retirement_snapshot_hash ~ '^0x[0-9a-f]{64}$' and retirement_fence>0 and
          retirement_disposition_started in (true,false))
         or
         (state <> 'retiring-pre-bind' and retirement_prior_state is null and
          retirement_prior_recovery_state is null and retirement_target_journal_key is null and
          retirement_action_idempotency_key is null and retirement_lease_until is null and
          retirement_snapshot_hash is null and retirement_disposition_started=false)
       );
     end if;
   end
   $lp_retirement_shape$`,
] as const;

/**
 * ONE non-terminal sequence per position. The predicate is
 * {@link isTerminalLpSequence} inverted and restated in SQL: `active` rows and
 * `held` rows that still owe a recovery, plus `abandoning` rows leased by the
 * owner route. The insert names this predicate in
 * its ON CONFLICT target, so a lost race surfaces as "no row returned" rather
 * than a driver exception.
 */
const LP_SEQUENCES_NONTERMINAL_INDEX_DDL = `
  create unique index if not exists lp_sequences_one_nonterminal_v4_idx
    on lp_sequences (position_id)
    where state in ('active','abandoning','resolving','retiring-pre-bind') or (state = 'held' and recovery_state <> 'none')
`;

const LP_SEQUENCES_OWNER_INDEX_DDL = `
  create index if not exists lp_sequences_owner_idx
    on lp_sequences (owner_address, agent_id)
`;

const LP_RESERVATIONS_DDL = `
  create table if not exists lp_exit_reservations (
    sequence_id text primary key,
    agent_id text not null,
    owner_address text not null,
    kind text not null,
    quota_bound boolean not null,
    reserved_at timestamptz not null,
    released_at timestamptz
  )
`;

/**
 * PHASE3.5 Rev2 M6. REQUIRED beside the DDL above, on the `note`-column
 * precedent: a bare `create table if not exists` does NOTHING to an existing
 * table, so every deployment that already ran Phase 3 would keep a
 * `lp_exit_reservations` with no `released_at` and {@link RESERVATION_COLUMNS}
 * would fail on the first select. Nullable and additive, so old rows read
 * `null` — which means "never released" and counts, the conservative reading.
 */
const LP_RESERVATIONS_RELEASED_COLUMN_DDL = `
  alter table lp_exit_reservations add column if not exists released_at timestamptz
`;

/** Serves the rolling-window quota count, which runs on every reservation. */
const LP_RESERVATIONS_WINDOW_INDEX_DDL = `
  create index if not exists lp_exit_reservations_window_idx
    on lp_exit_reservations (agent_id, reserved_at)
`;

export class PostgresLpSequenceStore implements LpSequenceStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresLpSequenceStore> {
    await sql.query(LP_POSITIONS_DDL);
    await sql.query(LP_POSITIONS_OWNER_INDEX_DDL);
    for (const ddl of LP_POSITIONS_OWNERSHIP_COLUMNS_DDL) {
      await sql.query(ddl);
    }
    // PHASE3.18 R2.6 — the durable grid identity. Additive and nullable, so an
    // existing deployment reads null on both and FIXED mode never looks.
    for (const ddl of LP_POSITIONS_GRID_IDENTITY_DDL) await sql.query(ddl);
    // PHASE3.19 C4/C11 — the VWAP book. Additive and nullable, so an existing
    // deployment reads null on both and every non-ladder path never looks.
    for (const ddl of LP_POSITIONS_INVENTORY_DDL) await sql.query(ddl);
    await sql.query(LP_POSITIONS_TOKEN_INDEX_DDL);
    await sql.query(LP_SEQUENCES_DDL);
    await sql.query(LP_SEQUENCES_NOTE_COLUMN_DDL);
    await sql.query(LP_SEQUENCES_INLINE_CONVERSION_DDL);
    for (const ddl of LP_SEQUENCES_STALL_COLUMNS_DDL) {
      await sql.query(ddl);
    }
    for (const ddl of LP_SEQUENCES_ABANDON_CLAIM_DDL) {
      await sql.query(ddl);
    }
    for (const ddl of LP_SEQUENCES_KIND_CHECK_DDL) await sql.query(ddl);
    // PHASE3.16: chained AFTER the 3.15 widening, never instead of it — see
    // LP_SEQUENCES_ARM_KIND_CHECK_DDL's docstring for the three starting states
    // and why one block cannot serve both members.
    for (const ddl of LP_SEQUENCES_ARM_KIND_CHECK_DDL) await sql.query(ddl);
    // PHASE3.18: the FOURTH widening, chained for the same reason the third
    // was — each block's drop is guarded on its OWN member.
    for (const ddl of LP_SEQUENCES_REQUOTE_KIND_CHECK_DDL) await sql.query(ddl);
    // PHASE3.19: the FIFTH widening, chained for the same reason the fourth was
    // — each block's drop is guarded on its OWN member.
    for (const ddl of LP_SEQUENCES_RECENTER_KIND_CHECK_DDL) await sql.query(ddl);
    // PHASE3.22 R2.19: the FIFTH DO block / SIXTH definition of the kind list,
    // chained for the same reason the fifth was — each block's drop is guarded
    // on its OWN member. See the block's header for C7's two-counts sentence.
    for (const ddl of LP_SEQUENCES_SHIFT_KIND_CHECK_DDL) await sql.query(ddl);
    // PHASE3.22 R5.2 site 3 / REVIEW4 D2 — the FIRST `recovery_state` widening
    // in this file's history, and the one without which shift mode is dead on
    // Postgres while every memory-backend test stays green. It runs AHEAD of
    // every seam that writes the marker, which is the whole reason step 2a
    // precedes the saga in the build order.
    for (const ddl of LP_SEQUENCES_SHIFT_RECOVERY_CHECK_DDL) await sql.query(ddl);
    for (const ddl of LP_SEQUENCES_ROTATE_RECOVERY_CHECK_DDL) await sql.query(ddl);
    await sql.query(`alter table lp_sequences add column if not exists prior_token_id text`);
    for (const ddl of LP_SEQUENCES_TARGET_RANGE_DDL) await sql.query(ddl);
    for (const ddl of LP_SEQUENCES_SHIFT_CAUSE_DDL) await sql.query(ddl);
    for (const ddl of LP_SEQUENCES_HEDGE_INTENT_DDL) await sql.query(ddl);
    // PHASE3.20 item 7 — the ladder motion's lane evidence, additive and
    // CHECK-constrained. Chained after the hedge intent for the same reason
    // every additive block here is: nothing before it is touched.
    for (const ddl of LP_SEQUENCES_RECENTER_EVIDENCE_DDL) await sql.query(ddl);
    for (const ddl of LP_SEQUENCES_RESOLVER_DDL) await sql.query(ddl);
    for (const ddl of LP_SEQUENCES_RETIREMENT_DDL) await sql.query(ddl);
    // Keep the legacy narrower index in place and add v2. Dropping/rebuilding
    // a shared index during concurrent server/worker boot creates an avoidable
    // migration race; the two constraints are compatible and v2 is the one
    // whose widened predicate the insert conflict target can use.
    await sql.query(LP_SEQUENCES_NONTERMINAL_INDEX_DDL);
    // v4 is created before the retired v3 predicate is removed.  The index
    // predicates overlap during this short, boot-time-only migration window.
    await sql.query(`drop index if exists lp_sequences_one_nonterminal_v3_idx`);
    await sql.query(LP_SEQUENCES_OWNER_INDEX_DDL);
    await sql.query(LP_RESERVATIONS_DDL);
    await sql.query(LP_RESERVATIONS_RELEASED_COLUMN_DDL);
    // PHASE3.20 item 7 — the reservation's own lane. Required beside the DDL
    // above on the `released_at` precedent: a bare `create table if not exists`
    // does nothing to an existing table, so without this every deployment that
    // already ran Phase 3 would fail `RESERVATION_COLUMNS` on the first select.
    await sql.query(LP_RESERVATIONS_QUOTA_LANE_DDL);
    await sql.query(LP_RESERVATIONS_WINDOW_INDEX_DDL);
    // PHASE3.19 R4.1 — the append-only credit set the book's advance is guarded
    // by. A new table, created last, touched by exactly one transaction shape.
    await sql.query(LP_INVENTORY_CREDITS_DDL);
    await sql.query(LP_INVENTORY_CREDITS_INDEX_DDL);
    return new PostgresLpSequenceStore(sql, now);
  }

  async withArmFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: (fence: LpArmFenceContext) => Promise<T>,
  ): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* lpPositions.armFence */ select pg_advisory_xact_lock(hashtext($1))`,
        [`${ownerKey(ownerAddress)}|${agentId}`],
      );
      return work({
        listPositions: () => this.#listPositions(tx, ownerAddress, agentId),
        getAnyNonTerminalSequence: () =>
          this.#getAnyNonTerminalSequence(tx, ownerAddress, agentId),
        putSettings: (settingsStore, input) => {
          assertArmFenceScope(ownerAddress, agentId, input);
          return settingsStore.putWithinArmFence(input, tx);
        },
        createPosition: (input) => {
          assertArmFenceScope(ownerAddress, agentId, input);
          return this.#createPosition(tx, input);
        },
      });
    });
  }

  /* ----- positions ----- */

  async createPosition(input: CreateLpPositionInput): Promise<LpPositionRecord> {
    return this.#createPosition(this.#sql, input);
  }

  async #createPosition(
    sql: SqlClient,
    input: CreateLpPositionInput,
  ): Promise<LpPositionRecord> {
    const at = new Date(this.#now());
    let result;
    try {
      result = await sql.query<PositionRow>(
        `/* lpPositions.create */
         insert into lp_positions
           (position_id, agent_id, owner_address, token0, token1, fee, token_id, lineage_id, basis_wei, basis_source, quote_token, state, ownership_mismatch_count, ownership_lost_reason, ownership_first_seen_at, arm_group_id, arm_meta, grid_level, grid_role, inventory_base_wei, inventory_cost_wbnb_wei, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, 'open', 0, null, null, $12, $13, $14, $15, $16::numeric, $16::numeric, $17, $17)
         on conflict (position_id) do nothing
         returning ${POSITION_COLUMNS}`,
        [
          input.positionId,
          input.agentId,
          ownerKey(input.ownerAddress),
          getAddress(input.token0),
          getAddress(input.token1),
          input.fee,
          input.tokenId ?? null,
          input.lineageId ?? randomUUID(),
          input.basisWei.toString(10),
          input.basisSource ?? "owner-budget",
          getAddress(input.quoteToken ?? DEFAULT_QUOTE_TOKEN),
          // PHASE3.17 R2.3. $12; PHASE3.18 R2.6 takes $13/$14; PHASE3.19 C4
          // takes $16 for BOTH book columns (an anchor starts at zero, a
          // non-anchor at null) and the timestamp moved on again to $17. The
          // fake SQL client's positional matcher mirrors this by hand — see the
          // A6 warning at the top of `test/support/fakeSql.ts`.
          input.armGroupId ?? null,
          input.armMeta === undefined ? null : encodeJsonbParam(input.armMeta),
          input.gridLevel ?? null,
          input.gridRole ?? null,
          input.inventoryAnchor === true ? "0" : null,
          at,
        ],
      );
    } catch (error) {
      // M5. `on conflict (position_id)` is this statement's ONE allowed
      // conflict target, so the token index arrives as a driver exception —
      // unmapped, a 500 carrying the constraint name.
      if (isLiveTokenIndexViolation(error) && input.tokenId !== undefined) {
        throw new LpTokenIdInUseError(input.tokenId);
      }
      throw error;
    }
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`LP position "${input.positionId}" already exists.`);
    }
    return rowToPosition(row);
  }

  async getPositionByTokenId(
    ownerAddress: Address,
    agentId: string,
    tokenId: string,
  ): Promise<LpPositionRecord | null> {
    const result = await this.#sql.query<PositionRow>(
      `/* lpPositions.byTokenId */
       select ${POSITION_COLUMNS}
       from lp_positions
       where owner_address = $1 and agent_id = $2 and token_id = $3
         and state <> 'closed'
       limit 1`,
      [ownerKey(ownerAddress), agentId, tokenId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPosition(row);
  }

  async setOwnershipMismatch(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: {
      readonly count: number;
      readonly reason: string | null;
      readonly firstSeenAtMs: number | null;
    },
    expectedRowVersion?: number,
  ): Promise<LpPositionRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockPosition(tx, ownerAddress, agentId, positionId);
      if (current === null) throw new LpPositionNotFoundError(positionId);
      await this.#assertOrdinaryPositionMutation(tx, current, expectedRowVersion);
      const result = await tx.query<PositionRow>(
        `/* lpPositions.setOwnershipMismatch */
       update lp_positions
         set ownership_mismatch_count = $5,
             ownership_lost_reason = $6,
             ownership_first_seen_at = $7,
             row_version = row_version + 1,
             updated_at = $8
       where position_id = $1 and agent_id = $2 and owner_address = $3 and row_version=$4
       returning ${POSITION_COLUMNS}`,
        [positionId, agentId, ownerKey(ownerAddress), current.rowVersion,
          input.count, input.count === 0 ? null : input.reason,
          input.count === 0 ? null : input.firstSeenAtMs, new Date(this.#now())],
      );
      const row = result.rows[0];
      if (row === undefined) throw new LpPositionVersionConflictError(positionId);
      return rowToPosition(row);
    });
  }

  async getPosition(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpPositionRecord | null> {
    const result = await this.#sql.query<PositionRow>(
      `/* lpPositions.get */
       select ${POSITION_COLUMNS}
       from lp_positions
       where position_id = $1 and agent_id = $2 and owner_address = $3`,
      [positionId, agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPosition(row);
  }

  async listPositions(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpPositionRecord[]> {
    return this.#listPositions(this.#sql, ownerAddress, agentId);
  }

  async #listPositions(
    sql: SqlClient,
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpPositionRecord[]> {
    const result = await sql.query<PositionRow>(
      `/* lpPositions.list */
       select ${POSITION_COLUMNS}
       from lp_positions
       where owner_address = $1 and agent_id = $2
       order by created_at asc, position_id asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return result.rows.map(rowToPosition);
  }

  async listOwnerPositionsBounded(
    ownerAddress: Address,
    agentIds: readonly string[],
    states: readonly ("open" | "closing")[],
    limit: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("Invalid LP position list limit.");
    if (agentIds.length === 0) return { rows: [], hasMore: false };
    const result = await this.#sql.query<PositionRow>(
      `/* lpPositions.listOwnerBounded */
       select ${POSITION_COLUMNS}
       from lp_positions
       where owner_address = $1 and agent_id = any($2::text[]) and state = any($3::text[])
       order by agent_id asc, position_id asc limit $4`,
        [ownerKey(ownerAddress), [...agentIds], [...states], limit + 1],
        { ...(signal === undefined ? {} : { signal }), timeoutMs: 5_000 },
    );
    return { rows: result.rows.slice(0, limit).map(rowToPosition), hasMore: result.rows.length > limit };
  }

  async updatePositionTokenId(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    tokenId: string,
    expectedRowVersion?: number,
    gridRole?: LpGridRoleValue,
  ): Promise<LpPositionRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockPosition(tx, ownerAddress, agentId, positionId);
      if (current === null) throw new LpPositionNotFoundError(positionId);
      await this.#assertOrdinaryPositionMutation(tx, current, expectedRowVersion);
      if (current.state === "closed") {
        throw new Error(
          `LP position "${positionId}" is closed; its tokenId can no longer change.`,
        );
      }
      let updated;
      try {
        updated = await tx.query<PositionRow>(
          // PHASE3.18 R2.6: `coalesce($7, grid_role)`, so an omitted role
          // leaves the column untouched. ONE statement and never a second
          // UPDATE — role and tokenId are written atomically or not at all,
          // which is the whole reason the role rides this write.
          `/* lpPositions.updateTokenId */
           update lp_positions set token_id = $5, grid_role = coalesce($7, grid_role), row_version = row_version + 1, updated_at = $6
           where position_id = $1 and agent_id = $2 and owner_address = $3 and row_version=$4
           returning ${POSITION_COLUMNS}`,
          [positionId, agentId, ownerKey(ownerAddress), current.rowVersion,
            tokenId, new Date(this.#now()), gridRole ?? null],
        );
      } catch (error) {
        // M5's real collision site: this call runs from a SAGA HOOK on every
        // rotate and every open, so an unmapped violation here is a driver
        // exception inside `after` — which repeats on every resume and holds
        // the sequence for ever. Typed, it is an ordinary saga failure.
        if (isLiveTokenIndexViolation(error)) {
          throw new LpTokenIdInUseError(tokenId);
        }
        throw error;
      }
      const row = updated.rows[0];
      if (row === undefined) {
        throw new LpPositionVersionConflictError(positionId);
      }
      return rowToPosition(row);
    });
  }

  async setGridIdentity(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    identity: {
      readonly gridLevel: LpGridLevelValue;
      readonly gridRole: LpGridRoleValue;
    },
  ): Promise<LpPositionRecord> {
    const result = await this.#sql.query<PositionRow>(
      `/* lpPositions.setGridIdentity */
       update lp_positions
         set grid_level = $4, grid_role = $5, row_version = row_version + 1, updated_at = $6
       where position_id = $1 and agent_id = $2 and owner_address = $3
       returning ${POSITION_COLUMNS}`,
      [positionId, agentId, ownerKey(ownerAddress), identity.gridLevel,
        identity.gridRole, new Date(this.#now())],
    );
    const row = result.rows[0];
    if (row === undefined) throw new LpPositionNotFoundError(positionId);
    return rowToPosition(row);
  }

  /**
   * PHASE3.19 R4.1 / D4 — the credit row and the anchor increment, in ONE
   * transaction, with the increment expressed IN SQL (`set x = x + $d`) and the
   * `row_version` bumped — never a read-modify-write outside the row lock.
   *
   * The clamp (D1) needs the CURRENT book, so it is computed inside the
   * transaction against the LOCKED anchor row and the CLAMPED delta is what the
   * credit row stores. That is what makes "book = sum of distinct credits" true
   * on both backends unconditionally.
   *
   * ALLOWED TO THROW. This is not derived telemetry — the markout gate reads it
   * to decide a market swap — so a failure rolls BOTH statements back and the
   * saga's `after` turns it into a recoverable `POST_VERIFY_FAILED` hold. A
   * swallowed half-write would take the key for ever and lose the credit
   * permanently, which is the one outcome the transaction exists to prevent.
   */
  async applyInventoryCredit(
    ownerAddress: Address,
    agentId: string,
    input: {
      readonly applicationKey: string;
      readonly positionId: string;
      readonly armGroupId: string | null;
      readonly deltaBaseWei: bigint;
      readonly deltaCostWbnbWei: bigint;
    },
  ): Promise<{
    readonly applied: boolean;
    readonly deltaBaseWei: bigint;
    readonly deltaCostWbnbWei: bigint;
  }> {
    const owner = ownerKey(ownerAddress);
    return this.#sql.transaction(async (tx) => {
      const existing = await tx.query<InventoryCreditRow>(
        `/* lpInventoryCredits.get */
         select ${INVENTORY_CREDIT_COLUMNS}
         from lp_inventory_credits
         where application_key = $1 and owner_address = $2 and agent_id = $3`,
        [input.applicationKey, owner, agentId],
      );
      const priorRow = existing.rows[0];
      if (priorRow !== undefined) {
        // The key is taken: this is a replay. Nothing is applied, and the
        // STORED deltas are returned so a caller reporting what it wrote
        // reports the truth rather than what it would have written.
        return {
          applied: false,
          deltaBaseWei: BigInt(String(priorRow.delta_base_wei)),
          deltaCostWbnbWei: BigInt(String(priorRow.delta_cost_wbnb_wei)),
        };
      }
      const anchor = await this.#lockPosition(tx, ownerAddress, agentId, input.positionId);
      if (anchor === null) throw new LpPositionNotFoundError(input.positionId);
      if (anchor.inventoryBaseWei === null || anchor.inventoryCostWbnbWei === null) {
        throw new LpInventoryAnchorMissingError(input.positionId);
      }
      const clamped = clampInventoryDelta(
        { baseWei: anchor.inventoryBaseWei, costWbnbWei: anchor.inventoryCostWbnbWei },
        { baseWei: input.deltaBaseWei, costWbnbWei: input.deltaCostWbnbWei },
      );
      const inserted = await tx.query<{ application_key: string }>(
        `/* lpInventoryCredits.insert */
         insert into lp_inventory_credits
           (application_key, owner_address, agent_id, position_id, arm_group_id, delta_base_wei, delta_cost_wbnb_wei, created_at)
         values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8)
         on conflict (application_key) do nothing
         returning application_key`,
        [
          input.applicationKey,
          owner,
          agentId,
          input.positionId,
          input.armGroupId,
          clamped.baseWei.toString(10),
          clamped.costWbnbWei.toString(10),
          new Date(this.#now()),
        ],
      );
      if (inserted.rows.length === 0) {
        // Lost the race to a concurrent identical write; the other side applied
        // the increment, so this one must not apply a second.
        return { applied: false, deltaBaseWei: 0n, deltaCostWbnbWei: 0n };
      }
      const updated = await tx.query<PositionRow>(
        `/* lpPositions.applyInventoryCredit */
         update lp_positions
           set inventory_base_wei = inventory_base_wei + $4::numeric,
               inventory_cost_wbnb_wei = inventory_cost_wbnb_wei + $5::numeric,
               row_version = row_version + 1,
               updated_at = $6
         where position_id = $1 and agent_id = $2 and owner_address = $3
           and inventory_base_wei is not null
         returning ${POSITION_COLUMNS}`,
        [
          input.positionId,
          agentId,
          owner,
          clamped.baseWei.toString(10),
          clamped.costWbnbWei.toString(10),
          new Date(this.#now()),
        ],
      );
      if (updated.rows.length === 0) {
        throw new LpInventoryAnchorMissingError(input.positionId);
      }
      return {
        applied: true,
        deltaBaseWei: clamped.baseWei,
        deltaCostWbnbWei: clamped.costWbnbWei,
      };
    });
  }

  async readInventoryBook(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<{ readonly baseWei: bigint; readonly costWbnbWei: bigint } | null> {
    const row = await this.getPosition(ownerAddress, agentId, positionId);
    if (row === null) return null;
    if (row.inventoryBaseWei === null || row.inventoryCostWbnbWei === null) return null;
    return { baseWei: row.inventoryBaseWei, costWbnbWei: row.inventoryCostWbnbWei };
  }

  async sumInventoryCredits(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<{
    readonly count: number;
    readonly baseWei: bigint;
    readonly costWbnbWei: bigint;
  }> {
    const result = await this.#sql.query<InventoryCreditRow>(
      `/* lpInventoryCredits.list */
       select ${INVENTORY_CREDIT_COLUMNS}
       from lp_inventory_credits
       where owner_address = $1 and agent_id = $2 and position_id = $3`,
      [ownerKey(ownerAddress), agentId, positionId],
    );
    let baseWei = 0n;
    let costWbnbWei = 0n;
    for (const row of result.rows) {
      baseWei += BigInt(String(row.delta_base_wei));
      costWbnbWei += BigInt(String(row.delta_cost_wbnb_wei));
    }
    return { count: result.rows.length, baseWei, costWbnbWei };
  }

  async setPositionState(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    state: LpPositionState,
    expectedRowVersion?: number,
    closeReason?: string,
  ): Promise<LpPositionRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockPosition(tx, ownerAddress, agentId, positionId);
      if (current === null) throw new LpPositionNotFoundError(positionId);
      await this.#assertOrdinaryPositionMutation(tx, current, expectedRowVersion);
      assertPositionTransition(current.state, state);
      // Closing the lineage resets the basis (R7) in the SAME write: the
      // stop-loss anchor dies with the lineage, never survives a re-open.
      const updated =
        state === "closed"
          ? await tx.query<PositionRow>(
              // PHASE3.22 R4.2.2 — `coalesce($6, close_reason)` is the same
              // "an omitted argument leaves the column alone" discipline the
              // tokenId write uses for `grid_role`, and it is what keeps every
              // pre-3.22 caller byte-identical: they pass `null`, which
              // coalesces to the existing value rather than erasing it.
              `/* lpPositions.close */
               update lp_positions set state = 'closed', basis_wei = 0, close_reason = coalesce($6, close_reason), row_version = row_version + 1, updated_at = $5
               where position_id = $1 and agent_id = $2 and owner_address = $3 and row_version=$4
               returning ${POSITION_COLUMNS}`,
              [positionId, agentId, ownerKey(ownerAddress), current.rowVersion,
                new Date(this.#now()), closeReason ?? null],
            )
          : await tx.query<PositionRow>(
              `/* lpPositions.setState */
               update lp_positions set state = $5, row_version = row_version + 1, updated_at = $6
               where position_id = $1 and agent_id = $2 and owner_address = $3 and row_version=$4
               returning ${POSITION_COLUMNS}`,
              [positionId, agentId, ownerKey(ownerAddress), current.rowVersion,
                state, new Date(this.#now())],
            );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new LpPositionVersionConflictError(positionId);
      }
      return rowToPosition(row);
    });
  }

  /* ----- sequences ----- */

  async createSequence(input: CreateLpSequenceInput): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const position = await this.#lockPosition(
        tx,
        input.ownerAddress,
        input.agentId,
        input.positionId,
      );
      if (position === null) {
        throw new LpPositionNotFoundError(input.positionId);
      }
      const at = new Date(this.#now());
      // The partial unique index is the arbiter: a concurrent non-terminal
      // sequence makes this insert a no-op, and the empty RETURNING is the
      // typed error's trigger — same shape as the journal's begin.
      const result = await tx.query<SequenceRow>(
        `/* lpSequences.create */
         insert into lp_sequences
           (sequence_id, agent_id, owner_address, position_id, kind, state, recovery_state, steps, note, target_tick_lower, target_tick_upper, created_at, updated_at, recenter_evidence, inline_convert, target_sell_tick_lower, target_sell_tick_upper, shift_cause)
         values ($1, $2, $3, $4, $5, 'active', 'none', $6::jsonb, null, $7, $8, $9, $9, $10, $14, $11, $12, $13)
         on conflict (position_id) where state in ('active','abandoning','resolving','retiring-pre-bind') or (state = 'held' and recovery_state <> 'none') do nothing
         returning ${SEQUENCE_COLUMNS}`,
        [
          randomUUID(),
          input.agentId,
          ownerKey(input.ownerAddress),
          input.positionId,
          input.kind,
          encodeJsonbParam([]),
          // PHASE3.18 R2.3/C4: the target is written by the INSERT itself, so
          // it is durable in the same transaction that makes the sequence
          // resumable — there is no window in which a requote row exists
          // without the rung it was authorized to mint.
          input.targetRange?.tickLower ?? null,
          input.targetRange?.tickUpper ?? null,
          at,
          // PHASE3.20 item 7 / C6: written by the INSERT itself, so there is no
          // window in which a ladder row exists without the lane it was
          // authorized to charge — the same rule, in the same transaction, that
          // 3.18 wrote the target under.
          input.recenterEvidence ?? null,
          // PHASE3.22 R8: the SHIFT's second target, written by the SAME INSERT
          // and for the same reason — there is no window in which a shift row
          // exists carrying only one of the two rungs it was authorized to
          // mint. APPENDED at the tail of the column list rather than inserted
          // beside its sibling pair, which is the idiom every phase since 3.19
          // has used here and the reason `lpSequences.test.ts`'s note-column
          // pin and `lp.gridLadder.store.test.ts`'s C11 pin both still hold
          // unedited: they match the `..., target_tick_upper, created_at` and
          // `created_at, updated_at, hedge_...` runs as source TEXT.
          input.targetSellRange?.tickLower ?? null,
          input.targetSellRange?.tickUpper ?? null,
          // PHASE3.23 R3.2: APPEND-ONLY parameter; every older index is stable.
          input.shiftCause ?? null,
          // PHASE3.24 C2: APPEND-ONLY again. Old callers and all non-manual
          // kinds persist false; request and worker resume read this same bit.
          input.kind === "manual-exit" && input.inlineConvert === true,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new LpActiveSequenceError(input.positionId);
      }
      return rowToSequence(row);
    });
  }

  async recordInlineResidue(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    residueBaseWei: bigint,
    note: string | null,
  ): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (current.kind !== "manual-exit" || !current.inlineConvert) {
        throw new Error("Inline residue belongs only to a consented manual-exit sequence.");
      }
      if (
        current.inlineResidueBaseWei !== null
        && current.inlineResidueBaseWei !== residueBaseWei
      ) {
        throw new Error("Confirmed inline residue disagrees with the persisted receipt witness.");
      }
      const updated = await tx.query<SequenceRow>(
        `/* lpSequences.recordInlineResidue */
         update lp_sequences
            set inline_residue_base_wei = coalesce(inline_residue_base_wei, $4),
                note = $5, updated_at = $6
          where sequence_id = $1 and agent_id = $2 and owner_address = $3
          returning ${SEQUENCE_COLUMNS}`,
        [
          sequenceId,
          agentId,
          ownerKey(ownerAddress),
          residueBaseWei.toString(10),
          note,
          new Date(this.#now()),
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("LP inline residue update failed to return the row.");
      }
      return rowToSequence(row);
    });
  }

  async getSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.get */
       select ${SEQUENCE_COLUMNS}
       from lp_sequences
       where sequence_id = $1 and agent_id = $2 and owner_address = $3`,
      [sequenceId, agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async getNonTerminalSequence(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.nonTerminalByPosition */
       select ${SEQUENCE_COLUMNS}
       from lp_sequences
       where position_id = $1 and agent_id = $2 and owner_address = $3
         and (state in ('active','abandoning','resolving','retiring-pre-bind') or (state = 'held' and recovery_state <> 'none'))
       limit 1`,
      [positionId, agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async getAnyNonTerminalSequence(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord | null> {
    return this.#getAnyNonTerminalSequence(this.#sql, ownerAddress, agentId);
  }

  async #getAnyNonTerminalSequence(
    sql: SqlClient,
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord | null> {
    // The SAME predicate the v2 non-terminal index carries, restated
    // in SQL exactly as `getNonTerminalSequence` restates it — one row back, not
    // the agent's whole history (audit A5).
    const result = await sql.query<SequenceRow>(
      `/* lpSequences.anyNonTerminalByAgent */
       select ${SEQUENCE_COLUMNS}
       from lp_sequences
       where agent_id = $1 and owner_address = $2
         and (state in ('active','abandoning','resolving','retiring-pre-bind') or (state = 'held' and recovery_state <> 'none'))
       order by created_at asc, sequence_id asc
       limit 1`,
      [agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async listSequences(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSequenceRecord[]> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.list */
       select ${SEQUENCE_COLUMNS}
       from lp_sequences
       where owner_address = $1 and agent_id = $2
       order by created_at asc, sequence_id asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return result.rows.map(rowToSequence);
  }

  async appendStep(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    step: { readonly kind: LpStepKind; readonly journalIdempotencyKey: string; readonly priorTokenId?: string },
  ): Promise<LpSequenceStep> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (current.state === "resolving" || current.state === "retiring-pre-bind") {
        throw new LpPositionResolvingError(current.positionId);
      }
      if (current.state !== "active") {
        throw new Error(
          `LP sequence "${sequenceId}" is ${current.state}; steps may only be recorded on an active sequence.`,
        );
      }
      const index = current.steps.length;
      const created: LpSequenceStep = {
        index,
        kind: step.kind,
        journalIdempotencyKey: step.journalIdempotencyKey,
        journalDecisionId: lpStepDecisionId(sequenceId, index),
      };
      await tx.query(
        `/* lpSequences.updateSteps */
         update lp_sequences set steps = $4::jsonb, updated_at = $5, prior_token_id = $6
         where sequence_id = $1 and agent_id = $2 and owner_address = $3`,
        [
          sequenceId,
          agentId,
          ownerKey(ownerAddress),
          encodeJsonbParam([...current.steps, created]),
          new Date(this.#now()),
          atomicPriorTokenId(current, step),
        ],
      );
      return created;
    });
  }

  async setSequenceState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    state: LpSequenceState,
  ): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (current.state === "resolving" || current.state === "retiring-pre-bind") {
        throw new LpPositionResolvingError(current.positionId);
      }
      assertSequenceTransition(current.state, state);
      const updated = await tx.query<SequenceRow>(
        `/* lpSequences.updateState */
         update lp_sequences set state = $4, updated_at = $5
         where sequence_id = $1 and agent_id = $2 and owner_address = $3
         returning ${SEQUENCE_COLUMNS}`,
        [sequenceId, agentId, ownerKey(ownerAddress), state, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("LP sequence state update failed to return the row.");
      }
      return rowToSequence(row);
    });
  }

  async claimSequenceForAbandon(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedUpdatedAt: number;
      readonly claimId: string;
      readonly nowMs: number;
      readonly minIdleMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.claimAbandon */
       update lp_sequences
          set state = 'abandoning',
              abandon_claim_id = $5,
              abandon_claimed_at = $6,
              abandon_disposition_started_at =
                case when state = 'held' then null else abandon_disposition_started_at end,
              updated_at = $7
        where sequence_id = $1 and agent_id = $2 and owner_address = $3
          and updated_at = $4
          and (
            (state = 'held' and abandon_claim_id is null and updated_at <= $8)
            or
            (state = 'abandoning' and abandon_claim_id is not null and abandon_claimed_at <= $9)
          )
       returning ${SEQUENCE_COLUMNS}`,
      [
        sequenceId,
        agentId,
        ownerKey(ownerAddress),
        new Date(input.expectedUpdatedAt),
        input.claimId,
        input.nowMs,
        new Date(input.nowMs),
        new Date(input.nowMs - input.minIdleMs),
        input.nowMs - input.minIdleMs,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async claimSequenceForLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly expectedState: "active" | "held";
      readonly expectedRecoveryState: LpRecoveryState;
      readonly expectedUpdatedAt: number;
      readonly expectedPositionId: string;
      readonly expectedPositionVersion: number;
      readonly expectedResolverRowVersion: number;
      readonly resolutionId: string;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    return this.#sql.transaction(async (tx) => {
      const position = await this.#lockPosition(
        tx, ownerAddress, agentId, input.expectedPositionId,
      );
      if (position === null || position.rowVersion !== input.expectedPositionVersion) return null;
      const result = await tx.query<SequenceRow>(
      `/* lpSequences.claimLandingResolution */
       update lp_sequences set
         state='resolving', resolver_prior_state=state,
         resolver_prior_recovery_state=recovery_state,
         resolver_fence=resolver_fence+1, resolver_lease_until=$12,
         resolver_snapshot_hash=$13, resolver_row_version=resolver_row_version+1,
         resolution_id=$8, resolver_action_idempotency_key=$9,
         resolution_disposition_started=false, updated_at=$14
       where sequence_id=$1 and agent_id=$2 and owner_address=$3
         and state=$4 and recovery_state=$5 and updated_at=$6
         and resolver_row_version=$7
         and position_id=$10
         and (state='active' or (state='held' and recovery_state<>'none'))
         and resolution_id is null and resolver_action_idempotency_key is null
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), input.expectedState,
        input.expectedRecoveryState, new Date(input.expectedUpdatedAt),
        input.expectedResolverRowVersion, input.resolutionId,
        input.actionIdempotencyKey, input.expectedPositionId,
        input.expectedPositionVersion, new Date(input.leaseUntilMs),
        input.snapshotHash, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
    });
  }

  async reclaimSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly expectedFence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex;
      readonly nowMs: number;
      readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.reclaimLandingResolution */
       update lp_sequences set resolver_fence=resolver_fence+1,
         resolver_lease_until=$9, resolver_action_idempotency_key=$8,
         resolver_row_version=resolver_row_version+1, updated_at=$7
       where sequence_id=$1 and agent_id=$2 and owner_address=$3
         and state='resolving' and resolution_id=$4 and resolver_fence=$5
         and resolver_row_version=$6 and resolver_lease_until<=$7
         and resolver_snapshot_hash=$10
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), input.resolutionId,
        input.expectedFence.toString(10), input.expectedResolverRowVersion,
        new Date(input.nowMs), input.actionIdempotencyKey,
        new Date(input.leaseUntilMs), input.snapshotHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async beginSequenceLandingDisposition(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
  ): Promise<LpSequenceRecord | null> {
    return this.#resolverUpdate(
      "lpSequences.beginLandingDisposition",
      ownerAddress, agentId, sequenceId, resolutionId, fence,
      expectedResolverRowVersion,
      "resolution_disposition_started=true",
      false,
    );
  }

  async setSequenceLandingRecovery(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: { readonly resolutionId: string; readonly fence: bigint;
      readonly expectedResolverRowVersion: number; readonly recoveryState: LpRecoveryState;
      readonly note: string },
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.setLandingRecovery */ update lp_sequences set recovery_state=$7,note=$8,
        resolver_row_version=resolver_row_version+1,updated_at=$9
       where sequence_id=$1 and agent_id=$2 and owner_address=$3 and state='resolving' and
        resolution_id=$4 and resolver_fence=$5 and resolver_row_version=$6 and
        resolution_disposition_started=true returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), input.resolutionId,
        input.fence.toString(10), input.expectedResolverRowVersion, input.recoveryState,
        input.note, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async setPositionStateForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: { readonly sequenceId: string; readonly resolutionId: string;
      readonly fence: bigint; readonly expectedResolverRowVersion: number;
      readonly expectedPositionVersion: number; readonly state: LpPositionState },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    return this.#positionLandingMutation(ownerAddress, agentId, positionId, input,
      async (tx, position) => {
        assertPositionTransition(position.state, input.state);
        const result = input.state === "closed"
          ? await tx.query<PositionRow>(
            `/* lpPositions.landingClose */ update lp_positions set state='closed',basis_wei=0,
              row_version=row_version+1,updated_at=$5 where position_id=$1 and agent_id=$2 and
              owner_address=$3 and row_version=$4 returning ${POSITION_COLUMNS}`,
            [positionId, agentId, ownerKey(ownerAddress), input.expectedPositionVersion,
              new Date(this.#now())])
          : await tx.query<PositionRow>(
            `/* lpPositions.landingSetState */ update lp_positions set state=$5,
              row_version=row_version+1,updated_at=$6 where position_id=$1 and agent_id=$2 and
              owner_address=$3 and row_version=$4 returning ${POSITION_COLUMNS}`,
            [positionId, agentId, ownerKey(ownerAddress), input.expectedPositionVersion,
              input.state, new Date(this.#now())]);
        return result.rows[0] ?? null;
      });
  }

  async updatePositionTokenIdForLanding(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: { readonly sequenceId: string; readonly resolutionId: string;
      readonly fence: bigint; readonly expectedResolverRowVersion: number;
      readonly expectedPositionVersion: number; readonly tokenId: string },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    return this.#positionLandingMutation(ownerAddress, agentId, positionId, input,
      async (tx, position) => {
        if (position.state === "closed") return null;
        try {
          const result = await tx.query<PositionRow>(
            `/* lpPositions.landingToken */ update lp_positions set token_id=$5,
              row_version=row_version+1,updated_at=$6 where position_id=$1 and agent_id=$2 and
              owner_address=$3 and row_version=$4 returning ${POSITION_COLUMNS}`,
            [positionId, agentId, ownerKey(ownerAddress), input.expectedPositionVersion,
              input.tokenId, new Date(this.#now())]);
          return result.rows[0] ?? null;
        } catch (error) {
          if (isLiveTokenIndexViolation(error)) throw new LpTokenIdInUseError(input.tokenId);
          throw error;
        }
      });
  }

  async #positionLandingMutation(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    input: { readonly sequenceId: string; readonly resolutionId: string;
      readonly fence: bigint; readonly expectedResolverRowVersion: number;
      readonly expectedPositionVersion: number },
    mutate: (tx: SqlClient, position: LpPositionRecord) => Promise<PositionRow | null>,
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    return this.#sql.transaction(async (tx) => {
      const position = await this.#lockPosition(tx, ownerAddress, agentId, positionId);
      if (position === null || position.rowVersion !== input.expectedPositionVersion) return null;
      const sequence = await this.#lockSequence(tx, ownerAddress, agentId, input.sequenceId);
      if (sequence === null || sequence.positionId !== positionId || sequence.state !== "resolving" ||
          sequence.resolutionId !== input.resolutionId || sequence.resolverFence !== input.fence ||
          sequence.resolverRowVersion !== input.expectedResolverRowVersion ||
          !sequence.resolutionDispositionStarted) return null;
      const positionRow = await mutate(tx, position);
      if (positionRow === null) return null;
      const touched = await tx.query<SequenceRow>(
        `/* lpSequences.landingTouch */ update lp_sequences set
          resolver_row_version=resolver_row_version+1,updated_at=$7 where sequence_id=$1 and
          agent_id=$2 and owner_address=$3 and state='resolving' and resolution_id=$4 and
          resolver_fence=$5 and resolver_row_version=$6 returning ${SEQUENCE_COLUMNS}`,
        [input.sequenceId, agentId, ownerKey(ownerAddress), input.resolutionId,
          input.fence.toString(10), input.expectedResolverRowVersion, new Date(this.#now())],
      );
      const sequenceRow = touched.rows[0];
      if (sequenceRow === undefined) throw new Error("Landing position fence changed mid-transaction.");
      return { position: rowToPosition(positionRow), sequence: rowToSequence(sequenceRow) };
    });
  }

  async releaseSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
  ): Promise<LpSequenceRecord | null> {
    return this.#resolverUpdate(
      "lpSequences.releaseLandingResolution",
      ownerAddress, agentId, sequenceId, resolutionId, fence,
      expectedResolverRowVersion,
      "state=resolver_prior_state,recovery_state=resolver_prior_recovery_state",
      true,
    );
  }

  async finishSequenceLandingResolution(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    input: {
      readonly resolutionId: string;
      readonly fence: bigint;
      readonly expectedResolverRowVersion: number;
      readonly targetState: "active" | "rolled-back";
    },
  ): Promise<LpSequenceRecord | null> {
    return this.#resolverUpdate(
      input.targetState === "active"
        ? "lpSequences.finishLandingResolutionActive"
        : "lpSequences.finishLandingResolutionRolledBack",
      ownerAddress, agentId, sequenceId, input.resolutionId, input.fence,
      input.expectedResolverRowVersion,
      `state='${input.targetState}'`,
      true,
      true,
    );
  }

  async claimSequenceForPreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    input: {
      readonly expectedState: "active" | "held"; readonly expectedRecoveryState: LpRecoveryState;
      readonly expectedUpdatedAt: number; readonly expectedPositionId: string;
      readonly expectedPositionVersion: number; readonly expectedRetirementRowVersion: number;
      readonly targetJournalKey: string; readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex; readonly leaseUntilMs: number;
    },
  ): Promise<LpSequenceRecord | null> {
    return this.#sql.transaction(async (tx) => {
      const position = await this.#lockPosition(tx, ownerAddress, agentId, input.expectedPositionId);
      if (position === null || position.rowVersion !== input.expectedPositionVersion) return null;
      const result = await tx.query<SequenceRow>(
        `/* lpSequences.claimPreBindRetirement */ update lp_sequences set
          state='retiring-pre-bind',retirement_prior_state=state,
          retirement_prior_recovery_state=recovery_state,retirement_fence=retirement_fence+1,
          retirement_lease_until=$12,retirement_snapshot_hash=$13,
          retirement_row_version=retirement_row_version+1,retirement_target_journal_key=$8,
          retirement_action_idempotency_key=$9,retirement_disposition_started=false,updated_at=$14
         where sequence_id=$1 and agent_id=$2 and owner_address=$3 and state=$4 and
          recovery_state=$5 and updated_at=$6 and retirement_row_version=$7 and position_id=$10 and
          (state='active' or (state='held' and recovery_state<>'none')) and
          retirement_target_journal_key is null and retirement_action_idempotency_key is null
         returning ${SEQUENCE_COLUMNS}`,
        [sequenceId, agentId, ownerKey(ownerAddress), input.expectedState,
          input.expectedRecoveryState, new Date(input.expectedUpdatedAt),
          input.expectedRetirementRowVersion, input.targetJournalKey, input.actionIdempotencyKey,
          input.expectedPositionId, input.expectedPositionVersion, new Date(input.leaseUntilMs),
          input.snapshotHash, new Date(this.#now())],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToSequence(row);
    });
  }

  async reclaimSequenceForPreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    input: { readonly targetJournalKey: string; readonly expectedFence: bigint;
      readonly expectedRetirementRowVersion: number; readonly actionIdempotencyKey: string;
      readonly snapshotHash: Hex; readonly nowMs: number; readonly leaseUntilMs: number },
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.reclaimPreBindRetirement */ update lp_sequences set
        retirement_fence=retirement_fence+1,retirement_lease_until=$9,
        retirement_action_idempotency_key=$8,retirement_row_version=retirement_row_version+1,updated_at=$7
       where sequence_id=$1 and agent_id=$2 and owner_address=$3 and state='retiring-pre-bind' and
        retirement_target_journal_key=$4 and retirement_fence=$5 and retirement_row_version=$6 and
        retirement_lease_until<=$7 and retirement_snapshot_hash=$10 and retirement_disposition_started=false
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), input.targetJournalKey,
        input.expectedFence.toString(10), input.expectedRetirementRowVersion, new Date(input.nowMs),
        input.actionIdempotencyKey, new Date(input.leaseUntilMs), input.snapshotHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async beginSequencePreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    targetJournalKey: string, fence: bigint, expectedRetirementRowVersion: number,
  ): Promise<LpSequenceRecord | null> {
    return this.#retirementUpdate("lpSequences.beginPreBindRetirement", ownerAddress, agentId,
      sequenceId, targetJournalKey, fence, expectedRetirementRowVersion,
      "retirement_disposition_started=true", false);
  }

  async setPositionStateForPreBindRetirement(
    ownerAddress: Address, agentId: string, positionId: string,
    input: { readonly sequenceId: string; readonly targetJournalKey: string; readonly fence: bigint;
      readonly expectedRetirementRowVersion: number; readonly expectedPositionVersion: number;
      readonly state: LpPositionState },
  ): Promise<{ readonly position: LpPositionRecord; readonly sequence: LpSequenceRecord } | null> {
    return this.#sql.transaction(async (tx) => {
      const position = await this.#lockPosition(tx, ownerAddress, agentId, positionId);
      if (position === null || position.rowVersion !== input.expectedPositionVersion) return null;
      const sequence = await this.#lockSequence(tx, ownerAddress, agentId, input.sequenceId);
      if (sequence === null || sequence.positionId !== positionId ||
          sequence.state !== "retiring-pre-bind" ||
          sequence.retirementTargetJournalKey !== input.targetJournalKey ||
          sequence.retirementFence !== input.fence ||
          sequence.retirementRowVersion !== input.expectedRetirementRowVersion ||
          !sequence.retirementDispositionStarted) return null;
      assertPositionTransition(position.state, input.state);
      const changed = await tx.query<PositionRow>(
        `/* lpPositions.preBindRetirementClose */ update lp_positions set state=$5,
          basis_wei=case when $5='closed' then 0 else basis_wei end,row_version=row_version+1,
          updated_at=$6 where position_id=$1 and agent_id=$2 and owner_address=$3 and row_version=$4
          returning ${POSITION_COLUMNS}`,
        [positionId, agentId, ownerKey(ownerAddress), input.expectedPositionVersion,
          input.state, new Date(this.#now())],
      );
      const positionRow = changed.rows[0];
      if (positionRow === undefined) return null;
      const touched = await tx.query<SequenceRow>(
        `/* lpSequences.preBindRetirementTouch */ update lp_sequences set
          retirement_row_version=retirement_row_version+1,updated_at=$7 where sequence_id=$1 and
          agent_id=$2 and owner_address=$3 and state='retiring-pre-bind' and retirement_target_journal_key=$4 and
          retirement_fence=$5 and retirement_row_version=$6 and retirement_disposition_started=true
          returning ${SEQUENCE_COLUMNS}`,
        [input.sequenceId, agentId, ownerKey(ownerAddress), input.targetJournalKey,
          input.fence.toString(10), input.expectedRetirementRowVersion, new Date(this.#now())],
      );
      const sequenceRow = touched.rows[0];
      if (sequenceRow === undefined) throw new Error("Pre-bind retirement fence changed mid-transaction.");
      return { position: rowToPosition(positionRow), sequence: rowToSequence(sequenceRow) };
    });
  }

  async finishSequencePreBindRetirement(
    ownerAddress: Address, agentId: string, sequenceId: string,
    input: { readonly targetJournalKey: string; readonly fence: bigint;
      readonly expectedRetirementRowVersion: number },
  ): Promise<LpSequenceRecord | null> {
    return this.#retirementUpdate("lpSequences.finishPreBindRetirement", ownerAddress, agentId,
      sequenceId, input.targetJournalKey, input.fence, input.expectedRetirementRowVersion,
      "state='rolled-back'", true, true);
  }

  async #retirementUpdate(
    tag: string, ownerAddress: Address, agentId: string, sequenceId: string,
    targetJournalKey: string, fence: bigint, expectedRetirementRowVersion: number,
    primarySet: string, clear: boolean, requireStarted = false,
  ): Promise<LpSequenceRecord | null> {
    const clearSet = clear
      ? ",retirement_prior_state=null,retirement_prior_recovery_state=null," +
        "retirement_target_journal_key=null,retirement_action_idempotency_key=null," +
        "retirement_lease_until=null,retirement_snapshot_hash=null,retirement_disposition_started=false"
      : "";
    const result = await this.#sql.query<SequenceRow>(
      `/* ${tag} */ update lp_sequences set ${primarySet}${clearSet},
        retirement_row_version=retirement_row_version+1,updated_at=$7 where sequence_id=$1 and
        agent_id=$2 and owner_address=$3 and state='retiring-pre-bind' and retirement_target_journal_key=$4 and
        retirement_fence=$5 and retirement_row_version=$6
        ${requireStarted ? "and retirement_disposition_started=true" : ""}
        returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), targetJournalKey,
        fence.toString(10), expectedRetirementRowVersion, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async #resolverUpdate(
    tag: string,
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    resolutionId: string,
    fence: bigint,
    expectedResolverRowVersion: number,
    primarySet: string,
    clear: boolean,
    requireStarted = false,
  ): Promise<LpSequenceRecord | null> {
    const clearSet = clear
      ? ",resolver_prior_state=null,resolver_prior_recovery_state=null," +
        "resolver_lease_until=null,resolver_snapshot_hash=null,resolution_id=null," +
        "resolver_action_idempotency_key=null,resolution_disposition_started=false"
      : "";
    const result = await this.#sql.query<SequenceRow>(
      `/* ${tag} */
       update lp_sequences set ${primarySet}${clearSet},
         resolver_row_version=resolver_row_version+1, updated_at=$7
       where sequence_id=$1 and agent_id=$2 and owner_address=$3
         and state='resolving' and resolution_id=$4 and resolver_fence=$5
         and resolver_row_version=$6
         ${requireStarted ? "and resolution_disposition_started=true" :
           clear ? "and resolution_disposition_started=false" : ""}
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), resolutionId,
        fence.toString(10), expectedResolverRowVersion, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async beginSequenceAbandonDisposition(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null> {
    const at = this.#now();
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.beginAbandonDisposition */
       update lp_sequences
          set abandon_disposition_started_at = coalesce(abandon_disposition_started_at, $5),
              updated_at = $6
        where sequence_id = $1 and agent_id = $2 and owner_address = $3
          and state = 'abandoning' and abandon_claim_id = $4
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), claimId, at, new Date(at)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async releaseSequenceAbandonClaim(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.releaseAbandon */
       update lp_sequences
          set state = 'held', abandon_claim_id = null, abandon_claimed_at = null,
              abandon_disposition_started_at = null, updated_at = $5
        where sequence_id = $1 and agent_id = $2 and owner_address = $3
          and state = 'abandoning' and abandon_claim_id = $4
          and abandon_disposition_started_at is null
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), claimId, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async completeSequenceAbandon(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    claimId: string,
  ): Promise<LpSequenceRecord | null> {
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.completeAbandon */
       update lp_sequences
          set state = 'rolled-back', abandon_claim_id = null, abandon_claimed_at = null,
              updated_at = $5
        where sequence_id = $1 and agent_id = $2 and owner_address = $3
          and state = 'abandoning' and abandon_claim_id = $4
          and abandon_disposition_started_at is not null
       returning ${SEQUENCE_COLUMNS}`,
      [sequenceId, agentId, ownerKey(ownerAddress), claimId, new Date(this.#now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }

  async setSequenceNote(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    note: string | null,
  ): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (current.state === "resolving" || current.state === "retiring-pre-bind") {
        throw new LpPositionResolvingError(current.positionId);
      }
      const updated = await tx.query<SequenceRow>(
        `/* lpSequences.updateNote */
         update lp_sequences set note = $4, updated_at = $5
         where sequence_id = $1 and agent_id = $2 and owner_address = $3
         returning ${SEQUENCE_COLUMNS}`,
        [sequenceId, agentId, ownerKey(ownerAddress), note, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("LP sequence note update failed to return the row.");
      }
      return rowToSequence(row);
    });
  }

  /**
   * PHASE3.19 item 8 — WRITE-ONCE, enforced BY THE PREDICATE: the update matches
   * only a row whose intent columns are still null, so a second write is a
   * no-op and the stored intent is returned. No path in this store can overwrite
   * it (item 46's mutation).
   */
  async setHedgeIntent(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    intent: {
      readonly direction: "wbnb-to-token" | "token-to-wbnb";
      readonly amountInWei: bigint;
    },
  ): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (current.hedgeDirection !== null && current.hedgeAmountInWei !== null) {
        return current;
      }
      const updated = await tx.query<SequenceRow>(
        `/* lpSequences.setHedgeIntent */
         update lp_sequences
           set hedge_direction = $4, hedge_amount_in_wei = $5::numeric, updated_at = $6
         where sequence_id = $1 and agent_id = $2 and owner_address = $3
           and hedge_direction is null and hedge_amount_in_wei is null
         returning ${SEQUENCE_COLUMNS}`,
        [
          sequenceId,
          agentId,
          ownerKey(ownerAddress),
          intent.direction,
          intent.amountInWei.toString(10),
          new Date(this.#now()),
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new LpSequenceNotFoundError(sequenceId);
      return rowToSequence(row);
    });
  }

  async setRecoveryState(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    recoveryState: LpRecoveryState,
  ): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (current.state === "resolving" || current.state === "retiring-pre-bind") {
        throw new LpPositionResolvingError(current.positionId);
      }
      if (current.state === "completed" || current.state === "rolled-back") {
        throw new Error(
          `LP sequence "${sequenceId}" is ${current.state}; a terminal sequence's recovery state cannot change.`,
        );
      }
      const updated = await tx.query<SequenceRow>(
        `/* lpSequences.updateRecovery */
         update lp_sequences set recovery_state = $4, updated_at = $5
         where sequence_id = $1 and agent_id = $2 and owner_address = $3
         returning ${SEQUENCE_COLUMNS}`,
        [sequenceId, agentId, ownerKey(ownerAddress), recoveryState, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("LP sequence recovery update failed to return the row.");
      }
      return rowToSequence(row);
    });
  }

  async recordSequenceStall(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    stallCode: string,
  ): Promise<LpSequenceRecord> {
    return this.#sql.transaction(async (tx) => {
      const current = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (current === null) throw new LpSequenceNotFoundError(sequenceId);
      if (
        current.state === "resolving" ||
        current.state === "retiring-pre-bind" ||
        current.state === "abandoning" ||
        isTerminalLpSequence(current.state, current.recoveryState)
      ) {
        // Another authority owns this row, or it is finished. The latch gates
        // only the worker's own backoff, so it defers rather than throwing.
        return current;
      }
      // $4 appears in an assignment AND a comparison; live PostgreSQL deduces
      // the two contexts independently and refuses the statement outright
      // ("inconsistent types deduced for parameter $4") — found on mainnet
      // 2026-08-25, invisible to FakeSqlClient, which does no type deduction.
      // The explicit cast makes both uses one type.
      const updated = await tx.query<SequenceRow>(
        `/* lpSequences.recordStall */
         update lp_sequences
            set stall_code = $4::varchar,
                stall_count = case when stall_code = $4::varchar then stall_count + 1 else 1 end,
                updated_at = $5
          where sequence_id = $1 and agent_id = $2 and owner_address = $3
          returning ${SEQUENCE_COLUMNS}`,
        [sequenceId, agentId, ownerKey(ownerAddress), stallCode, new Date(this.#now())],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("LP sequence stall update failed to return the row.");
      }
      return rowToSequence(row);
    });
  }

  /* ----- worker queue ----- */

  async listOpenPositionsForWorker(): Promise<LpPositionRecord[]> {
    const result = await this.#sql.query<PositionRow>(
      `/* lpPositions.listOpenWorker */
       select ${POSITION_COLUMNS}
       from lp_positions p
       where p.state = 'open' and not exists (
         select 1 from lp_sequences s where s.position_id=p.position_id and
           s.agent_id=p.agent_id and s.owner_address=p.owner_address and
           s.state in ('resolving','retiring-pre-bind')
       )
       order by created_at asc, position_id asc`,
    );
    return result.rows.map(rowToPosition);
  }

  async listFeeRepairSequencesForWorker(input: { after: { createdAt: number; sequenceId: string } | null; limit: number; deadlineMs: number; signal: AbortSignal }): Promise<LpSequenceRecord[]> {
    input.signal.throwIfAborted();
    const remaining = input.deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("Fee discovery deadline");
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.feeRepair */ select ${SEQUENCE_COLUMNS} from lp_sequences
       where ($1::timestamptz is null or (created_at,sequence_id) > ($1::timestamptz,$2))
       order by created_at asc,sequence_id asc limit $3`,
      [input.after ? new Date(input.after.createdAt) : null, input.after?.sequenceId ?? "", Math.min(64,input.limit)],
      { signal: input.signal, timeoutMs: remaining });
    return result.rows.map(rowToSequence);
  }

  async listNonTerminalSequencesForWorker(): Promise<LpSequenceRecord[]> {
    // The predicate is the partial unique index's, verbatim — one non-terminal
    // definition, stated once in SQL and once in isTerminalLpSequence.
    const result = await this.#sql.query<SequenceRow>(
      `/* lpSequences.listNonTerminalWorker */
       select ${SEQUENCE_COLUMNS}
       from lp_sequences
       where state = 'active' or (state = 'held' and recovery_state <> 'none')
       order by created_at asc, sequence_id asc`,
    );
    return result.rows.map(rowToSequence);
  }

  /* ----- reservations ----- */

  async reserveSequence(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
    quota: LpExitQuota,
    laneEvidence?: LpRecenterEvidence,
  ): Promise<LpExitReservation> {
    return this.#sql.transaction(async (tx) => {
      const sequence = await this.#lockSequence(tx, ownerAddress, agentId, sequenceId);
      if (sequence === null) throw new LpSequenceNotFoundError(sequenceId);
      const now = this.#now();
      // PHASE3.20 R3.3: `quotaBound` still comes from the TOTAL kind mapping, so
      // a ladder motion can never become quota-EXEMPT (N2.1); the lane it is
      // refused against comes from the evidence, defaulting to SETTLEMENT.
      const quotaBound = quotaLaneOf(sequence.kind) !== undefined;
      const evidence = laneEvidence ?? sequence.recenterEvidence ?? undefined;
      const lane = reserveQuotaLane(sequence.kind, evidence, sequence.shiftCause);

      if (lane === "shift-settle" || lane === "shift-drift") {
        // PHASE3.25 R2.4/R5.3: a transaction alone does not make two different
        // sequence-row locks share an MVCC snapshot. Serialize the common
        // owner+agent shift scope so both independent lane counts and their
        // shared spacing gate observe reservations in one order.
        await tx.query(
          `/* lpReservations.shiftQuotaLock */
           select pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
          [ownerKey(ownerAddress), agentId],
        );
      }

      // Insert FIRST, then count the others — the journal's beginWithSpend
      // shape: two concurrent quota-bound reservations each see the other's
      // row in their count, so at most one can be under the cap (over-refusal
      // under a race is fail-closed for a rate-limited kind). The conflict
      // clause makes a re-reservation idempotent.
      const inserted = await tx.query<{ sequence_id: string }>(
        `/* lpReservations.insert */
         insert into lp_exit_reservations
           (sequence_id, agent_id, owner_address, kind, quota_bound, reserved_at, quota_lane)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (sequence_id) do nothing
         returning sequence_id`,
        [
          sequenceId,
          sequence.agentId,
          sequence.ownerAddress,
          sequence.kind,
          quotaBound,
          new Date(now),
          // PHASE3.20 item 7: `null` for every non-ladder kind, which is what
          // keeps every other path byte-identical.
          sequence.kind === "grid-shift"
            ? (lane === "shift-drift" ? "shift-drift" : "shift-settle")
            : evidence ?? null,
        ],
      );
      const existing = await tx.query<ReservationRow>(
        `/* lpReservations.get */
         select ${RESERVATION_COLUMNS}
         from lp_exit_reservations
         where sequence_id = $1 and agent_id = $2 and owner_address = $3`,
        [sequenceId, agentId, ownerKey(ownerAddress)],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error("LP reservation failed to read back the inserted row.");
      }
      if (inserted.rows.length === 0) {
        // The sequence was already reserved: idempotent return, no re-check.
        return rowToReservation(row);
      }

      if (lane !== undefined) {
        const window = await tx.query<{
          reserved_at: Date;
          released_at: Date | null;
          quota_bound: boolean;
          kind: string;
          quota_lane: string | null;
        }>(
          // PHASE3.15 R2.7 selects `kind` as well, because the daily COUNT is
          // now per LANE and the lane is derived from the kind the row already
          // stores — no new column, no second migration.
          //
          // PHASE3.20 C5/B1(a): and `quota_lane`, because the kind stopped being
          // enough. NOTE WHAT DOES **NOT** CHANGE HERE — this statement gains a
          // SELECTED COLUMN and no predicate; the filter below stays in
          // TypeScript, so the reserve path's own SQL text is untouched and the
          // three-valued-logic hazard that B1 is about cannot arise at this
          // seam.
          `/* lpReservations.window */
           select reserved_at, released_at, quota_bound, kind, quota_lane
           from lp_exit_reservations
           where agent_id = $1 and owner_address = $4
             and reserved_at > $2 and sequence_id <> $3`,
          [
            sequence.agentId,
            new Date(now - ROLLING_DAY_MS),
            sequenceId,
            ownerKey(ownerAddress),
          ],
        );
        // PHASE3.5 Rev2 M3 — THE SPLIT, and it is why one query still serves
        // both gates. The daily COUNT sees only unreleased rows (the limit is a
        // gas-meter proxy and a released row drew none); the SPACING anchor
        // sees every row, because it is a pacing floor the owner signed and the
        // only bound on a reserve→refuse→roll-back loop.
        const all = window.rows.map((item) => item.reserved_at.getTime());
        // PHASE3.7 F2, and it narrows PHASE3.5's split by one more conjunct.
        // The COUNT sees only QUOTA-BOUND rows. `protect` and `manual-exit`
        // are exempt as CALLERS — the check is skipped for them entirely — and
        // counting them here let them silently occupy the cap for `rotate` and
        // `harvest` anyway. Measured 2026-08-18: five unreleased rows against a
        // cap of four refused two rotates BEFORE they reserved, so no
        // reservation row was left behind to explain the refusal.
        //
        // On the sizing bound, stated precisely, because the first version of
        // this comment was checked hard against an INCOMPLETE set
        // (PHASE3.7-AUDIT A4). The exempt set is THREE kinds — `protect`,
        // `manual-exit` AND `open` — since `QUOTA_BOUND_KINDS` is
        // {rotate, harvest}.
        //
        //   protect / manual-exit: budgeted by `checkLpNativeCapSizing`'s
        //     separate position-axis term (`protectPositions`, audit A3), so
        //     counting them HERE was double-counting on the wrong axis.
        //   open: budgeted on the native-VALUE axis (its `mint{value}`) and on
        //     NO submission-gas term at all. Its gas used to be covered only by
        //     the accidental coupling this conjunct removes.
        //
        // So F2 restores the split for two kinds and removes an accidental
        // cover for a third. Whether to add an `openSubmissions` term is a
        // design change and goes through spec -> review; the erratum is
        // recorded rather than quietly inherited.
        // PHASE3.15 R2.7 adds the LANE conjunct to the COUNT and to it alone.
        // The anchor (`all`) still sees every in-window row, because the
        // spacing gate is agent-wide and is what actually floors a grid's
        // cycle rate.
        const liveRows = window.rows
          .filter(
            (item) =>
              item.released_at === null
              && item.quota_bound,
          );
        const live = liveRows.filter(
          (item) => reservationQuotaLane(assertSequenceKind(item.kind), item.quota_lane) === lane,
        );
        // PHASE3.25 R5.3 — lane counts are independent; the retained advisory
        // lock serializes the shared spacing decision across cross and drift.
        const quotaExhausted = live.length >= quotaLimitFor(lane, quota);
        const breach =
          quotaExhausted
            ? new LpExitQuotaError("quota-exhausted", lane)
            : all.length > 0 &&
                now - Math.max(...all) < quota.minMinutesBetweenExits * 60_000
              ? new LpExitQuotaError("min-interval", lane)
              : null;
        if (breach !== null) {
          // Compensating delete BEFORE the throw: real Postgres would also
          // roll the insert back with the transaction, but the offline fake
          // SQL client serializes without undo, so the row is removed
          // explicitly and the two backends stay observably identical.
          await tx.query(
            `/* lpReservations.delete */
             delete from lp_exit_reservations where sequence_id = $1`,
            [sequenceId],
          );
          throw breach;
        }
      }
      return rowToReservation(row);
    });
  }

  async releaseReservation(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<void> {
    // Idempotent by the `released_at is null` predicate, and a no-op when the
    // row does not exist at all — the quota-REFUSED path arrives here having
    // had its insert rolled back with the transaction.
    await this.#sql.query(
      `/* lpReservations.release */
       update lp_exit_reservations set released_at = $4
       where sequence_id = $1 and agent_id = $2 and owner_address = $3
         and released_at is null`,
      [sequenceId, agentId, ownerKey(ownerAddress), new Date(this.#now())],
    );
  }

  async quotaUsage(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpQuotaUsage> {
    // ONE window pass over the existing (agent_id, reserved_at) index — the
    // H6(a) cost lesson: this feeds an owner dashboard route, so it must be a
    // bounded aggregate rather than a fan-out.
    const result = await this.#sql.query<{
      live_count: string | number;
      grid_live_count: string | number;
      requote_live_count: string | number;
      recenter_live_count: string | number;
      settlement_live_count: string | number;
      drift_live_count: string | number;
      shift_live_count: string | number;
      shift_settle_live_count: string | number;
      shift_drift_live_count: string | number;
      released_count: string | number;
      latest_reserved_at: Date | null;
      oldest_live_reserved_at: Date | null;
    }>(
      // ─── PHASE3.20 B1(a) — THE NULL ARM IS WRITTEN INTO THE SQL ───────────
      //
      // TWO aggregates added; the FOUR pinned lane predicates and
      // `recenter_live_count` are not touched (C14). The settlement predicate is
      // `(quota_lane = 'settlement' or quota_lane is null)` and the drift
      // predicate is exact, and the asymmetry is the whole finding: SQL's
      // three-valued logic makes `null = 'settlement'` UNKNOWN, so the natural
      // form DROPS every pre-migration `grid-recenter` row from BOTH new counts.
      // That restores the free-capacity defect for a rolling 24 h and breaks
      // `settlement + drift === recenter` by exactly the NULL count — through the
      // one seam where TypeScript's `??` does not decide. Widening BOTH arms
      // instead would double-count every legacy row.
      //
      // PHASE3.15 R2.7 ADDS one aggregate and changes none of the others. The
      // three existing filters are pinned at the TEXT level by
      // `test/lpQuotaRelease.test.ts` (AUDIT A6), and the lane split is done in
      // TypeScript below — `liveCount = live_count - grid_live_count` — rather
      // than by editing a predicate that pin exists to freeze.
      `/* lpReservations.quotaUsage */
       select
         count(*) filter (where released_at is null and quota_bound) as live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-flip') as grid_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-requote') as requote_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-recenter') as recenter_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-recenter' and (quota_lane = 'settlement' or quota_lane is null)) as settlement_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-recenter' and quota_lane = 'drift') as drift_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-shift') as shift_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-shift' and (quota_lane = 'shift-settle' or quota_lane is null)) as shift_settle_live_count,
         count(*) filter (where released_at is null and quota_bound and kind = 'grid-shift' and quota_lane = 'shift-drift') as shift_drift_live_count,
         count(*) filter (where released_at is not null) as released_count,
         max(reserved_at) as latest_reserved_at,
         min(reserved_at) filter (where released_at is null and quota_bound) as oldest_live_reserved_at
       from lp_exit_reservations
       where agent_id = $1 and owner_address = $2 and reserved_at > $3`,
      [agentId, ownerKey(ownerAddress), new Date(this.#now() - ROLLING_DAY_MS)],
    );
    const row = result.rows[0];
    const toCount = (value: string | number | undefined): number =>
      value === undefined ? 0 : typeof value === "number" ? value : Number.parseInt(value, 10);
    const gridFlipLiveCount = toCount(row?.grid_live_count);
    const requoteLiveCount = toCount(row?.requote_live_count);
    const recenterLiveCount = toCount(row?.recenter_live_count);
    // PHASE3.25 R2.6/R5.3: the dashboard total filters by KIND; admission reads
    // the two distinct persisted-lane subsets. Ladder lane strings cannot enter.
    const shiftLiveCount = toCount(row?.shift_live_count);
    const shiftSettleLiveCount = toCount(row?.shift_settle_live_count);
    const shiftDriftLiveCount = toCount(row?.shift_drift_live_count);
    return {
      // The EXIT lane is the quota-bound live count minus the OTHER TWO lanes;
      // all three are disjoint by construction (`quotaLaneOf`).
      //
      // PHASE3.18 C7, and this subtraction is the whole finding: a third lane
      // NOT subtracted here would silently count every re-centre against the
      // owner's EXIT quota — the lane that pays for rotates, harvests and
      // (through the same window) the protect headroom. R2.10 names it "the
      // easiest defect in this phase", and `test/lp.gridRequote.quota.test.ts`
      // pins it with all three kinds live at once, in both backends.
      // PHASE3.19 item 19: a FOURTH lane, subtracted here for the identical
      // reason the third was. R2.10 named it "the easiest defect in this phase"
      // and it stays easiest one lane later: a `recenter` not subtracted would
      // count every ladder motion against the owner's EXIT quota, which is the
      // lane that pays for rotates, harvests and the protect headroom.
      // PHASE3.22 R2.21: a FIFTH lane, subtracted here for the identical reason
      // the fourth was, and it is STILL the easiest defect in the phase — a
      // `shift` not subtracted would count every atomic motion against the
      // owner's EXIT quota. Pinned with every kind live at once, both backends.
      // The expression stays on ONE LINE deliberately: `lp.gridLadder.store`'s
      // item-45 pin and `lp.gridRequote.store`'s sibling match it as source
      // TEXT, and wrapping it would break two shipped tests that exist to catch
      // exactly the omission this line is about. Append, never re-wrap.
      liveCount: Math.max(0, toCount(row?.live_count) - gridFlipLiveCount - requoteLiveCount - recenterLiveCount - shiftLiveCount),
      gridFlipLiveCount,
      requoteLiveCount,
      recenterLiveCount,
      shiftLiveCount,
      shiftSettleLiveCount,
      shiftDriftLiveCount,
      // PHASE3.20: the two halves of the recenter lane, reported beside the SUM
      // rather than instead of it — item 6's ruling, which is also what keeps
      // `test/lp.gridLadder.store.test.ts`'s two shipped pins unedited.
      settlementLiveCount: toCount(row?.settlement_live_count),
      driftLiveCount: toCount(row?.drift_live_count),
      releasedCount: toCount(row?.released_count),
      latestReservedAtMs: row?.latest_reserved_at?.getTime() ?? null,
      oldestLiveExpiresAtMs:
        row?.oldest_live_reserved_at === null || row?.oldest_live_reserved_at === undefined
          ? null
          : row.oldest_live_reserved_at.getTime() + ROLLING_DAY_MS,
    };
  }

  async getReservation(
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpExitReservation | null> {
    const result = await this.#sql.query<ReservationRow>(
      `/* lpReservations.get */
       select ${RESERVATION_COLUMNS}
       from lp_exit_reservations
       where sequence_id = $1 and agent_id = $2 and owner_address = $3`,
      [sequenceId, agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToReservation(row);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }

  async #lockPosition(
    tx: SqlClient,
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<LpPositionRecord | null> {
    const result = await tx.query<PositionRow>(
      `/* lpPositions.lock */
       select ${POSITION_COLUMNS}
       from lp_positions
       where position_id = $1 and agent_id = $2 and owner_address = $3
       for update`,
      [positionId, agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToPosition(row);
  }

  async #assertOrdinaryPositionMutation(
    tx: SqlClient,
    position: LpPositionRecord,
    expectedRowVersion: number | undefined,
  ): Promise<void> {
    if (expectedRowVersion !== undefined && position.rowVersion !== expectedRowVersion) {
      throw new LpPositionVersionConflictError(position.positionId);
    }
    const fenced = await tx.query<{ sequence_id: string }>(
      `/* lpSequences.resolvingByPosition */ select sequence_id from lp_sequences
       where position_id=$1 and agent_id=$2 and owner_address=$3 and
         state in ('resolving','retiring-pre-bind')
       limit 1 for update`,
      [position.positionId, position.agentId, position.ownerAddress],
    );
    if (fenced.rows[0] !== undefined) {
      throw new LpPositionResolvingError(position.positionId);
    }
  }

  async #lockSequence(
    tx: SqlClient,
    ownerAddress: Address,
    agentId: string,
    sequenceId: string,
  ): Promise<LpSequenceRecord | null> {
    const result = await tx.query<SequenceRow>(
      `/* lpSequences.lock */
       select ${SEQUENCE_COLUMNS}
       from lp_sequences
       where sequence_id = $1 and agent_id = $2 and owner_address = $3
       for update`,
      [sequenceId, agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToSequence(row);
  }
}

/**
 * Whether a driver error is a violation of `lp_positions_one_live_token_idx`
 * (PHASE3.4 Rev2 M5).
 *
 * Matched on BOTH the SQLSTATE (`23505`, unique violation) and the index name,
 * because `lp_positions` carries a primary key too and mapping a
 * `position_id` collision to "that NFT is already managed" would be a confident
 * lie. Driver shapes differ (`node-postgres` fills `code`/`constraint`; the
 * fake client in `test/support/fakeSql.ts` mirrors them), so the name is also
 * matched in the message as a fallback rather than trusted from one field.
 */
/**
 * Read the ownership counter back. A malformed value reads 0 rather than
 * throwing, and the direction is deliberate: this counter can only ever CLOSE a
 * position (M7), so failing open here means "we have not confirmed a loss",
 * which is the conservative answer. Contrast {@link toWei}, where an
 * under-read basis silently disarms a stop-loss and therefore must throw.
 */
function toOwnershipCount(value: number | string | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Read the F1 anchor back. `bigint` arrives as a string from node-postgres; a
 * malformed value reads `null`, which means "no anchor held" and costs one more
 * confirmation cycle — the conservative direction, matching
 * {@link toOwnershipCount}.
 */
function toEpochMsOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  // INTEGER, not merely finite (PHASE3.4-FIXREVIEW2 N3): the column is a
  // `bigint` of epoch milliseconds and every writer sends the worker's own
  // integer clock, so a fractional value is corruption rather than precision —
  // and reading it back as `null` costs one extra confirmation cycle, which is
  // the same conservative direction the rest of this parser takes.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isLiveTokenIndexViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const named =
    record.constraint === LP_LIVE_TOKEN_INDEX_NAME ||
    (typeof record.message === "string" &&
      record.message.includes(LP_LIVE_TOKEN_INDEX_NAME));
  if (!named) return false;
  return record.code === undefined || record.code === "23505";
}

/** PHASE3.18: the closed level set. Anything else reads `null` (fail closed). */
function toGridLevel(value: number | string | null): LpGridLevelValue | null {
  const n = value === null ? null : Number(value);
  return n === 1 || n === 2 ? n : null;
}

/** PHASE3.18: a nullable int column, as a number or `null`. */
function toNullableInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * PHASE3.19 — a nullable numeric column, read as a bigint or `null`.
 *
 * DELIBERATELY NOT {@link toWei}, which maps `null` to `0n`: for the VWAP book
 * NULL and ZERO are different states (not an anchor vs an anchor with no
 * acquired base), and collapsing them would make every non-ladder row look like
 * an empty book the markout gate could be asked about. A malformed value reads
 * `null`, which is the fail-closed direction here — the gate refuses.
 */
function toNullableWei(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^-?\d+$/.test(text)) return null;
  return BigInt(text);
}

function parseLpSelectionReceipt(value: unknown): LpSelectionReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["rankBy"] !== "fee-apr"
    && record["rankBy"] !== "volume"
  ) {
    return null;
  }
  if (
    record["orderBy"] !== "lpFeeApr24h"
    && record["orderBy"] !== "volume24hUsd"
  ) {
    return null;
  }
  if (record["window"] !== "24h") return null;
  if (!Number.isInteger(record["laneAsOfMs"]) || (record["laneAsOfMs"] as number) < 0) {
    return null;
  }
  if (record["source"] !== "pancake") return null;
  if (record["total"] !== null && (!Number.isInteger(record["total"]) || (record["total"] as number) < 0)) {
    return null;
  }
  for (const key of ["matched", "returned"] as const) {
    if (!Number.isInteger(record[key]) || (record[key] as number) < 0) return null;
  }
  if (record["cap"] !== null && (!Number.isInteger(record["cap"]) || (record["cap"] as number) < 0)) {
    return null;
  }
  if (record["ingestOrder"] !== null && record["ingestOrder"] !== "tvlUSD") return null;
  if (typeof record["rowDropCounts"] !== "object" || record["rowDropCounts"] === null || Array.isArray(record["rowDropCounts"])) {
    return null;
  }
  const rowDropCounts = record["rowDropCounts"] as Record<string, unknown>;
  for (const count of Object.values(rowDropCounts)) {
    if (!Number.isInteger(count) || (count as number) < 0) return null;
  }
  if (!Array.isArray(record["survivors"])) return null;
  const survivors: Array<LpSelectionReceipt["survivors"][number]> = [];
  for (const raw of record["survivors"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const survivor = raw as Record<string, unknown>;
    if (
      typeof survivor["pool"] !== "string"
      || !isAddress(survivor["pool"], { strict: false })
      || typeof survivor["aprBps"] !== "string"
      || !/^\d+$/.test(survivor["aprBps"])
      || survivor["aprSource"] !== "pancake-apr24h"
      || typeof survivor["tvlUsdE6"] !== "string"
      || !/^\d+$/.test(survivor["tvlUsdE6"])
      || typeof survivor["volume24hUsdE6"] !== "string"
      || !/^\d+$/.test(survivor["volume24hUsdE6"])
      || !Number.isInteger(survivor["rowAsOfMs"])
      || (survivor["rowAsOfMs"] as number) < 0
    ) {
      return null;
    }
    survivors.push({
      pool: getAddress(survivor["pool"]),
      aprBps: survivor["aprBps"],
      aprSource: "pancake-apr24h",
      tvlUsdE6: survivor["tvlUsdE6"],
      volume24hUsdE6: survivor["volume24hUsdE6"],
      rowAsOfMs: survivor["rowAsOfMs"] as number,
    });
  }
  if (
    typeof record["head"] !== "string"
    || !isAddress(record["head"], { strict: false })
    || typeof record["chosen"] !== "string"
    || !isAddress(record["chosen"], { strict: false })
  ) {
    return null;
  }
  return {
    rankBy: record["rankBy"],
    orderBy: record["orderBy"],
    window: "24h",
    laneAsOfMs: record["laneAsOfMs"] as number,
    source: "pancake",
    total: record["total"] as number | null,
    matched: record["matched"] as number,
    returned: record["returned"] as number,
    cap: record["cap"] as number | null,
    ingestOrder: record["ingestOrder"] as "tvlUSD" | null,
    rowDropCounts: Object.freeze(
      Object.fromEntries(
        Object.entries(rowDropCounts).map(([key, count]) => [key, count as number]),
      ),
    ),
    survivors,
    head: getAddress(record["head"]),
    chosen: getAddress(record["chosen"]),
  };
}

export function parseLpArmMeta(value: unknown): LpArmMeta | null {
  let decoded: unknown;
  try {
    decoded = decodeJsonb(value);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  if (record["action"] !== "lpArm") return null;
  if (record["model"] !== "custom" && record["model"] !== "sigma") return null;
  if (
    typeof record["budgetWei"] !== "string"
    || !/^\d+$/.test(record["budgetWei"])
    || BigInt(record["budgetWei"]) <= 0n
  ) return null;
  if (typeof record["range"] !== "object" || record["range"] === null || Array.isArray(record["range"])) {
    return null;
  }
  const range = record["range"] as Record<string, unknown>;
  if (
    range["source"] !== "explicit"
    && range["source"] !== "server-fenced"
  ) {
    return null;
  }
  if (
    !Number.isInteger(range["tickLower"])
    || !Number.isInteger(range["tickUpper"])
    || (range["tickLower"] as number) < MIN_TICK
    || (range["tickUpper"] as number) > MAX_TICK
    || (range["tickLower"] as number) >= (range["tickUpper"] as number)
  ) {
    return null;
  }
  let selectPool: LpArmMeta["selectPool"] = null;
  if (record["selectPool"] !== null) {
    if (
      typeof record["selectPool"] !== "object"
      || record["selectPool"] === null
      || Array.isArray(record["selectPool"])
    ) {
      return null;
    }
    const raw = record["selectPool"] as Record<string, unknown>;
    if (
      (raw["by"] !== "fee-apr" && raw["by"] !== "volume")
      || raw["window"] !== "24h"
    ) {
      return null;
    }
    selectPool = { by: raw["by"], window: "24h" };
  }
  const selection =
    record["selection"] === null ? null : parseLpSelectionReceipt(record["selection"]);
  if (record["selection"] !== null && selection === null) return null;
  if (record["model"] === "sigma" && selectPool === null) return null;
  if (record["model"] === "custom" && selectPool !== null) return null;
  return {
    action: "lpArm",
    model: record["model"],
    range: {
      source: range["source"],
      tickLower: range["tickLower"] as number,
      tickUpper: range["tickUpper"] as number,
    },
    selectPool,
    selection,
    budgetWei: record["budgetWei"],
  };
}

function positionForRead(record: LpPositionRecord): LpPositionRecord {
  return {
    ...structuredClone(record),
    armMeta: parseLpArmMeta(record.armMeta),
  };
}

function rowToPosition(row: PositionRow): LpPositionRecord {
  return {
    positionId: row.position_id,
    agentId: row.agent_id,
    ownerAddress: ownerKeyFromStorage(row.owner_address),
    token0: getAddress(row.token0),
    token1: getAddress(row.token1),
    fee: row.fee,
    tokenId: row.token_id,
    lineageId: row.lineage_id,
    basisWei: toWei(row.basis_wei),
    basisSource: row.basis_source as LpLineageBasisSource,
    quoteToken: getAddress(row.quote_token),
    state: assertPositionState(row.state),
    // Nullable on purpose (M6): a pre-PHASE3.4 row reads `null` and means
    // "never checked", which is the same thing as zero mismatches.
    ownershipMismatchCount: toOwnershipCount(row.ownership_mismatch_count),
    ownershipLostReason: row.ownership_lost_reason,
    closeReason: row.close_reason ?? null,
    ownershipFirstSeenAtMs: toEpochMsOrNull(row.ownership_first_seen_at),
    // PHASE3.17 R2.3: nullable and additive, so every pre-3.17 row reads `null`
    // and means "not part of a dual arm", which is the truth about all of them.
    armGroupId: typeof row.arm_group_id === "string" ? row.arm_group_id : null,
    armMeta: parseLpArmMeta(row.arm_meta),
    // PHASE3.18 R2.6: nullable and additive. A value outside the closed set
    // reads as `null` — which in POLICY mode is a HOLD naming the remedy, never
    // a guess, and in fixed mode is ignored entirely.
    gridLevel: toGridLevel(row.grid_level),
    gridRole: row.grid_role === "buy" || row.grid_role === "sell" ? row.grid_role : null,
    // PHASE3.19 C4: nullable and additive. NULL means "this row is not a
    // ladder's book anchor"; ZERO means "the anchor holds no acquired base",
    // which the markout gate refuses on rather than dividing by (D1). The two
    // are different states and `toNullableWei` keeps them apart.
    inventoryBaseWei: toNullableWei(row.inventory_base_wei),
    inventoryCostWbnbWei: toNullableWei(row.inventory_cost_wbnb_wei),
    rowVersion: toSafeVersion(row.row_version),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function rowToSequence(row: SequenceRow): LpSequenceRecord {
  return {
    priorTokenId: row.prior_token_id ?? null,
    sequenceId: row.sequence_id,
    agentId: row.agent_id,
    ownerAddress: ownerKeyFromStorage(row.owner_address),
    positionId: row.position_id,
    kind: assertSequenceKind(row.kind),
    // PHASE3.24 C2: the additive column is nullable; legacy NULL is the
    // fail-closed false required by the persisted-consent contract.
    inlineConvert: row.inline_convert === true,
    state: assertSequenceState(row.state),
    recoveryState: assertRecoveryState(row.recovery_state),
    steps: (decodeJsonb(row.steps) as LpSequenceStep[]) ?? [],
    // Old rows (and every row before the exit skips anything) read `null`.
    note: row.note ?? null,
    inlineResidueBaseWei:
      row.inline_residue_base_wei == null ? null : BigInt(row.inline_residue_base_wei),
    // Pre-migration rows read as "never stalled", which is the pre-F1
    // behaviour: the worker resumes them every cycle.
    stallCode: row.stall_code ?? null,
    stallCount: row.stall_count == null ? 0 : Number(row.stall_count),
    resolverPriorState:
      row.resolver_prior_state === "active" || row.resolver_prior_state === "held"
        ? row.resolver_prior_state
        : null,
    resolverPriorRecoveryState:
      row.resolver_prior_recovery_state === null
        ? null
        : assertRecoveryState(row.resolver_prior_recovery_state),
    resolverFence: row.resolver_fence == null ? 0n : BigInt(row.resolver_fence),
    resolverLeaseUntil: row.resolver_lease_until?.getTime() ?? null,
    resolverSnapshotHash: row.resolver_snapshot_hash,
    resolverRowVersion: toSafeVersion(row.resolver_row_version),
    resolutionId: row.resolution_id ?? null,
    resolverActionIdempotencyKey: row.resolver_action_idempotency_key ?? null,
    resolutionDispositionStarted: row.resolution_disposition_started ?? false,
    retirementPriorState:
      row.retirement_prior_state === "active" || row.retirement_prior_state === "held"
        ? row.retirement_prior_state
        : null,
    retirementPriorRecoveryState:
      row.retirement_prior_recovery_state === null || row.retirement_prior_recovery_state === undefined
        ? null
        : assertRecoveryState(row.retirement_prior_recovery_state),
    retirementTargetJournalKey: row.retirement_target_journal_key ?? null,
    retirementActionIdempotencyKey: row.retirement_action_idempotency_key ?? null,
    retirementFence: row.retirement_fence == null ? 0n : BigInt(row.retirement_fence),
    retirementLeaseUntil: row.retirement_lease_until?.getTime() ?? null,
    retirementSnapshotHash: row.retirement_snapshot_hash ?? null,
    retirementRowVersion: toSafeVersion(row.retirement_row_version),
    retirementDispositionStarted: row.retirement_disposition_started ?? false,
    // PHASE3.18 R2.3/C4: null on every kind but `grid-requote`, and on every
    // pre-3.18 row. A requote resume that finds them null is a THROW at the
    // deps seam — never a re-derivation.
    targetTickLower: toNullableInt(row.target_tick_lower),
    targetTickUpper: toNullableInt(row.target_tick_upper),
    // PHASE3.22 R8: nullable and additive, exactly as the pair above. A shift
    // resume that finds them null is a THROW inside `runLpGridShift` — never a
    // re-derivation, and never at the deps seam, because the guard must sit
    // where a mutation deleting it is killed by a test (the C4/M-B3 placement).
    targetSellTickLower: toNullableInt(row.target_sell_tick_lower),
    targetSellTickUpper: toNullableInt(row.target_sell_tick_upper),
    shiftCause: asShiftCause(row.shift_cause),
    // PHASE3.19 item 8: nullable and additive. A value outside the closed set
    // reads `null`, which the hedge's build treats as "no intent persisted" and
    // therefore computes one — the fail-closed direction, since a persisted
    // intent it could not parse must never bind a swap.
    hedgeDirection:
      row.hedge_direction === "wbnb-to-token" || row.hedge_direction === "token-to-wbnb"
        ? row.hedge_direction
        : null,
    hedgeAmountInWei: toNullableWei(row.hedge_amount_in_wei),
    // PHASE3.20 item 7: nullable and additive. A value outside the closed set
    // reads `null`, which the reserve path treats as SETTLEMENT — the same
    // conservative reading a pre-migration row gets.
    recenterEvidence: asRecenterEvidence(row.recenter_evidence),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function toSafeVersion(value: number | string | null): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("LP row version is not a safe non-negative integer.");
  }
  return parsed;
}

function rowToReservation(row: ReservationRow): LpExitReservation {
  return {
    sequenceId: row.sequence_id,
    agentId: row.agent_id,
    ownerAddress: ownerKeyFromStorage(row.owner_address),
    kind: assertSequenceKind(row.kind),
    quotaBound: row.quota_bound,
    // PHASE3.20: an unrecognised or absent value reads `null`, which
    // `reservationQuotaLane` then treats as SETTLEMENT — the same conservative
    // reading a pre-migration row gets, rather than a throw on a column whose
    // CHECK already constrains it.
    quotaLane:
      row.quota_lane === "shift-settle" || row.quota_lane === "shift-drift"
        ? row.quota_lane
        : asRecenterEvidence(row.quota_lane),
    reservedAt: row.reserved_at.getTime(),
    // Tolerant of `undefined` as well as `null`: a driver or fake that omits
    // the column entirely means the same thing as an unreleased row.
    releasedAt: row.released_at == null ? null : row.released_at.getTime(),
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable store when `DATABASE_URL` is set, otherwise the in-memory
 * one. The connection string is never logged.
 */
export async function createLpSequenceStore(): Promise<LpSequenceStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresLpSequenceStore.create(sql);
    console.log("[lp-sequence-store] backend=postgres");
    return store;
  }
  console.log("[lp-sequence-store] backend=memory (DATABASE_URL not set)");
  return new MemoryLpSequenceStore();
}

/** The identity is durable in the same write as its first atomic attempt. */
function atomicPriorTokenId(sequence: LpSequenceRecord, step: { readonly kind: LpStepKind; readonly priorTokenId?: string }): string | null {
  if (step.kind !== "rotate-atomic") return sequence.priorTokenId ?? null;
  if (sequence.kind !== "rotate" || step.priorTokenId === undefined || !/^[1-9][0-9]*$/.test(step.priorTokenId)) {
    throw new Error("Atomic rotate requires its prior NFT identity before journal begin.");
  }
  if (sequence.priorTokenId != null && sequence.priorTokenId !== step.priorTokenId) {
    throw new Error("Atomic rotate prior NFT identity is immutable.");
  }
  return step.priorTokenId;
}

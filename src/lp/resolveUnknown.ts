/**
 * The operator half of UNKNOWN (PHASE3.3; `PHASE3.3-REVIEW.md` Revision 2 is
 * NORMATIVE, items 1–13 and 17).
 *
 * FINDINGS (al), mainnet 2026-08-17: a harvest's third step met the relay's
 * 45 s silence, so its journal row holds no `callsId`; the sequence stays
 * non-terminal; and `driveSequence` refuses every saga of another kind against
 * a non-terminal sequence. The position could not be protected and could not be
 * exited. Since Phase 1a the journal has said "UNKNOWN is
 * terminal-until-operator" while naming an operator with no way to act. This
 * module is that operator.
 *
 * ─── ITS DOMAIN, CORRECTED (PHASE3.14 R-A′) ────────────────────────────────
 *
 * The first draft narrowed that domain to rows with NO `callsId`, on the
 * premise that a `callsId` makes the outcome "knowable from the relay, and
 * `reconcile` resolves it automatically". **The second half of that sentence is
 * false for an UNKNOWN row, and the falsehood cost a live position.** Mainnet
 * 2026-08-25, agent `lp-test3-20260825`: the BSC relay answered
 * `{"status":300,"receipts":[]}` — stably, for 30+ minutes — which
 * `toCallsStatusReceipt` maps to PENDING because it maps nothing else, so
 * `reconcile` wrote UNKNOWN. `reconcile`'s own query is
 * `state in ('PENDING','IN_PROGRESS')`, so it never looked at that row again:
 * it wrote a state it had already disowned, and this module then refused the
 * row for carrying the very `callsId` that was supposed to make it someone
 * else's job. Four doors, all closed, on a position with liquidity intact.
 *
 * So the domain is **an UNKNOWN row `reconcile` has disowned, with or without a
 * `callsId`** — and a `callsId` is not a reason to refuse, it is EVIDENCE: one
 * bounded relay read below can turn it into a CONFIRMED that advances or a
 * FAILED that abandons on better grounds than inference. What it can never do
 * is refuse: an unreachable relay, an unmapped status or a still-pending answer
 * all fall through to the audited direct-evidence path, because a repair that
 * can be defeated by a relay outage is the same deadlock one layer up.
 *
 * ─── THE REFRAME (review R12) ──────────────────────────────────────────────
 *
 * The goal is NOT to finish the stuck saga. It is to make the position
 * protectable and exitable again, and that needs only one thing: the sequence
 * must become terminal. So a resolution ABANDONS the sequence rather than
 * resuming it, and **NO STEP IS EVER RETRIED**. That deletes the entire class
 * of problems the first draft carried:
 *
 *   - no double execution, so `zap-in-mint`'s worst case (a second NFT, the
 *     lineage repointed at it, the first position orphaned and unprotectable
 *     for ever) has no path;
 *   - no fungible-balance attack: every LP step pulls from the WALLET'S
 *     FUNGIBLE ERC-20 balance, never from anything escrowed to the step, and
 *     the deployment's own wallet holds ~424 000× the CAKE the real stuck step
 *     needs (FINDINGS (ak));
 *   - no need to prove an effect ABSENT: `eth_getLogs` is refused at EVERY
 *     range by both endpoints `resolveLpRpcUrls` prefers, and served by
 *     `publicnode` only inside a 10 000-block (≈1 h 15 min) window — which
 *     that same endpoint pairs with a flat refusal of
 *     `eth_getTransactionReceipt`.
 *
 * What it COSTS is the freed dust, and the code says so plainly rather than
 * hiding it: for the real row, 13 443 686 488 wei of WBNB (1.3e-8 BNB) and
 * ~2.9e-6 CAKE simply stay in the wallet. That is the right price for not
 * making a second unintended market swap.
 *
 * ─── NOTHING HERE WRITES ───────────────────────────────────────────────────
 *
 * This module is a VERIFIER. It reads, it decides, and it returns a
 * disposition; the route performs the writes in the one order that is correct
 * (journal row, then `setSequenceState`, then the position transition). Chain
 * access arrives through narrow injected readers exactly as the sagas' does, so
 * the whole check set is exercised offline against fakes.
 *
 * ─── AND THEREFORE THE ACTION MUST BE RE-RUNNABLE (PHASE3.3-AUDIT A1) ───────
 *
 * Those three writes span TWO STORES with no transaction between them, and
 * `ExecutionJournal.resolveUnknown` asserts `UNKNOWN` itself — so once write
 * (1) lands, the row can never be resolved again. A crash or a transient
 * database error between (1) and (2) therefore left FINDINGS (al)'s trap
 * exactly as it was, MINUS the only tool that could clear it, and `reconcile`
 * then closed the action's own row out advising the owner to "re-sign to be
 * certain" — advice that could no longer work. One step further along, the same
 * window left an exit's position `closing` with no non-terminal sequence: out
 * of `listOpenPositionsForWorker` for ever, reported `armed: true`, and counted
 * in `openPositionsCount` for ever.
 *
 * The fix is IDEMPOTENT-FORWARD RE-ENTRY, not atomicity the stores cannot
 * offer. A row that is already `ROLLED_BACK` and already carries THIS action's
 * own `externalRef.resolution` is recognised by {@link resumedResolution} as a
 * partially-applied resolution: the verifier skips the evidence checks (their
 * verdict is on the row, and the wallet may legitimately have moved since),
 * skips the age check (write (1) reset `updatedAt`, so the row now reads as
 * TOO YOUNG), skips the "sequence is terminal" refusal (write (2) may already
 * have made it terminal), and returns the same disposition — which the route
 * re-applies. Both remaining writes are idempotent by construction:
 * `setSequenceState` same-state is a legal no-op and so are `closing → open`
 * and `open → open`. Every partial failure becomes "sign again", with no new
 * authority, no new evidence and no new state.
 *
 * ─── WHY IT DOES NOT REPLAY THE SAGAS' OWN `after` HOOKS ────────────────────
 *
 * Rev2 item 10(e) phrases the inputs check as "replaying the confirmed prior
 * steps' `after` hooks". PHASE3.1 landed after that sentence was written and
 * made it unsafe: the exit's step-0 `after` now THROWS when liquidity ≠ 0 and
 * WRITES the position store (`src/lp/sagas.ts`, the `zap-out` step's `after`),
 * so a read-only verifier that replayed it would either mutate state or die.
 * {@link deriveStuckStepInputs} therefore mirrors the hooks' ARITHMETIC —
 * `collectAmounts` on a collect/zap-out, `swapAmounts` on a sweep, both from
 * the stored `txHash`es, `eth_getTransactionReceipt` only — with no writes and
 * no post-verify. Same numbers, same receipts, no side effects.
 */
import type { Address, Hex } from "viem";
import type { JournalEntry } from "../store/journal.js";
import { LIQUIDITY_REMOVING_STEPS } from "./abandonSequence.js";
import {
  isTerminalLpSequence,
  type LpPositionRecord,
  type LpSequenceKind,
  type LpSequenceRecord,
  type LpSequenceStep,
} from "../store/lpSequences.js";
import type { LpPositionsReader, LpReceiptReader } from "./sagas.js";

/* -------------------------------------------------------------------------- */
/* Result vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every distinct way a resolution is refused AFTER ownership is established.
 *
 * Rev2 item 9: these MAY be distinguished and SHOULD be — an owner debugging
 * their own position needs to know which guard fired. The three refusals that
 * happen BEFORE ownership is established (unknown decisionId, another agent's
 * decisionId, a kind with no verifier) are byte-identical 404s and are not in
 * this union; the route owns them.
 */
export type LpResolveRefusalCode =
  /**
   * PHASE3.14 F5. A 3.9c landing resolution has CLAIMED this row through a
   * fenced lease and recorded provisional evidence on the sequence. Until
   * PHASE3.14 the two owner-signed UNKNOWN surfaces were partitioned by the
   * `has_calls_id` refusal — `resolveLanding` is BUILT for callsId rows and
   * admits only UNKNOWN ones — and deleting that refusal put them over the same
   * row class. The journal's CASes keep a genuine race fail-closed, so this is
   * a STRANDING guard rather than a corruption one: resolving here would roll
   * the sequence back underneath a claimed lease and leave that lease and its
   * evidence row orphaned.
   */
  | "landing_resolution_claimed"
  /**
   * PHASE3.14 F2.2, and a NAMED RESIDUAL of that phase. The relay says
   * CONFIRMED but hands back no transaction hash — the exact shape this relay
   * demonstrably emits (`receipts: []`) — so there is nothing to verify the
   * claim against. `ADVANCE_ON_CHAIN_EDGE`'s contract is POSITIVE ON-CHAIN
   * PROOF, not a status code, and a status code is all this is.
   */
  | "relay_confirmed_no_txhash"
  | "not_unknown"
  | "too_young"
  | "native_spend"
  | "sequence_not_found"
  | "sequence_terminal"
  | "sequence_kind_unsupported"
  | "step_not_current"
  | "position_not_found"
  | "inputs_missing"
  | "unresolvable"
  /**
   * A1's re-entry, refused because the position has moved on: it now carries a
   * DIFFERENT non-terminal sequence, which can only be true if this
   * resolution's sequence write already succeeded (the store permits one
   * non-terminal sequence per position). The only outstanding write would be
   * the position restore, and that position's state now belongs to the newer
   * saga — so re-entering would yank it out from under a live sequence.
   * Refusing costs nothing: the position is not stranded, it is busy.
   */
  | "re_entry_superseded";

/** What the route must do to the sequence and the position. */
export type LpResolveDisposition = {
  /**
   * `"abandon"` — the step provably did NOT land, so the row is recorded as
   * rolled back; or `"advance"` (PHASE3.9a) — the step provably DID land, so it
   * is recorded as COMMITTED and the position is closed.
   *
   * Still no retry either way (item 11). The difference is only which TRUTH the
   * row is made to tell, and `advance` exists because recording a step that
   * happened as `ROLLED_BACK` would also hand back a spend the chain made.
   */
  readonly action: "abandon" | "advance";
  readonly sequenceId: string;
  readonly positionId: string;
  /**
   * Whether the journal row has ALREADY been resolved by a previous attempt of
   * this same action, so the route must skip write (1) and re-apply (2) and (3)
   * (PHASE3.3-AUDIT A1). See {@link resumedResolution}.
   */
  readonly reEntry: boolean;
  /**
   * Whether the route must ALSO put the position back to `open`.
   *
   * TRUE only for an exit kind whose position is still `closing`. See
   * {@link exitPositionDisposition} for why `closed` is left alone — that row
   * is not a re-derivation of the review's table, it is a CORRECTION of it
   * forced by PHASE3.1.
   */
  readonly restorePositionToOpen: boolean;
  /**
   * Whether the route must CLOSE the position (PHASE3.9a).
   *
   * TRUE only on `action: "advance"` OF A LIQUIDITY-REMOVING STEP, where the
   * withdrawal is proven landed — so the liquidity is out, the row must stop
   * counting in `openPositionsCount`, and leaving it `closing` is the permanent
   * limbo PHASE3.3-AUDIT A2 named.
   *
   * PHASE3.14 F2.3 made the KIND part load-bearing. `advance` used to hardcode
   * `true`, which was safe only while `zapOutStillFunded` was the sole way to
   * reach it. A relay `CONFIRMED` can now advance a `zap-in-increase`, whose
   * position keeps every bit of its liquidity, so the question is asked of
   * {@link LIQUIDITY_REMOVING_STEPS} — the table PHASE3.3-AUDIT A2 wrote for
   * this exact class of mistake — and never of `recoveryState`, which is a
   * proxy and is wrong.
   *
   * Mutually exclusive with {@link restorePositionToOpen} by construction: one
   * says the withdrawal landed, the other that it did not.
   */
  readonly closePosition: boolean;
  /** Operator-facing sentence, stored on the row as the disposition. */
  readonly summary: string;
  /**
   * The route's operator-facing note, computed HERE rather than at the route
   * (PHASE3.14 F6) so that the summary written onto the row and the sentence
   * returned to the caller cannot drift apart. It states, for a `callsId` row,
   * that the relay may still land the submission and what that would mean for
   * THIS step kind — an abandon that does not say so is the same epistemic
   * overclaim the deleted `has_calls_id` message was.
   */
  readonly note: string;
};

export type LpResolveLegEvidence = {
  readonly token: Address;
  readonly neededWei: bigint;
  readonly walletWei: bigint;
  readonly discriminating: boolean;
};

export type LpResolveCheck = { readonly name: string; readonly result: string };

export type LpResolveVerdict =
  | {
      readonly ok: true;
      readonly disposition: LpResolveDisposition;
      readonly checks: readonly LpResolveCheck[];
      readonly legs: readonly LpResolveLegEvidence[];
      readonly logAbsence: LpResolveLogAbsence;
      readonly serverBlock: bigint | null;
      readonly positionEvidenceBlock: bigint | null;
    }
  | {
      readonly ok: false;
      readonly code: LpResolveRefusalCode;
      readonly message: string;
      readonly checks: readonly LpResolveCheck[];
      readonly legs: readonly LpResolveLegEvidence[];
      readonly logAbsence: LpResolveLogAbsence;
      readonly serverBlock: bigint | null;
      readonly positionEvidenceBlock: bigint | null;
    };

/**
 * The optional log-absence probe's answer (Rev2 item 10(g)).
 *
 * NEVER SILENTLY SKIPPED and never depended on. A deployment with no
 * capability-probed endpoint records `checked: false` with the reason, which is
 * the honest answer and is itself evidence: the measured RPC capability split
 * means this deployment can never satisfy such a check for a row older than
 * ~1 h 15 min, and the real row was 11.9 hours old.
 */
export type LpResolveLogAbsence = {
  readonly checked: boolean;
  readonly detail: string;
};

/**
 * The optional probe seam. Absent from `LpChainReaders` in every shipped
 * wiring — no endpoint the deployment configures can serve it — and present so
 * that a future archive/log endpoint is a wiring change rather than a redesign.
 */
export type LpLogAbsenceProbe = (input: {
  readonly nfpm: Address;
  readonly tokenId: bigint;
  readonly observedBlock: bigint;
}) => Promise<LpResolveLogAbsence>;

/**
 * One bounded look at the relay's answer for the stuck row's `callsId`
 * (PHASE3.14 F2).
 *
 * `rawStatus` is carried because the mapping is LOSSY BY DESIGN — an unmapped
 * status becomes `"PENDING"` — and the whole live incident is an unmapped
 * status. The operator's receipt must be able to say "the relay is answering
 * 300", which is a very different fact from "the relay is silent".
 */
export type LpRelayStatusReading = {
  readonly status: "CONFIRMED" | "FAILED" | "PENDING";
  readonly transactionHash?: Hex;
  /** The relay's own status field, stringified. Evidence, never a decision. */
  readonly rawStatus: string;
  /** Set only on FAILED, when the provider classified the failure. */
  readonly failureCode?: string;
};

/**
 * The relay seam. SINGLE-SHOT and bounded by construction: the reader asks
 * once and returns.
 *
 * It is NOT `awaitExecution`, deliberately. That method polls to a 120 s
 * deadline and only then reports PENDING, which is correct for `reconcile` —
 * nobody is waiting on it — and would hold an owner-signed HTTP request open
 * for two minutes against a relay that is answering promptly with a status
 * this build does not map.
 */
export type LpRelayStatusReader = (callsId: Hex) => Promise<LpRelayStatusReading>;

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export type LpResolveInput = {
  /** The UNKNOWN row, already looked up agent-scoped by the route. */
  readonly row: JournalEntry;
  /** The sequence the row's decision id names, or `null`. */
  readonly sequence: LpSequenceRecord | null;
  /** The sequence's position, or `null`. */
  readonly position: LpPositionRecord | null;
  /** Configured WBNB — the pool's quote leg, by identity, never a request. */
  readonly wbnb: Address;
  /** The NFPM, for the optional probe only. */
  readonly nfpm: Address;
  /** The caller's claimed observation height. Recorded, never trusted. */
  readonly observedBlock: bigint;
  /** Server clock, epoch MILLISECONDS. */
  readonly nowMs: number;
  /** `RESOLVE_MIN_AGE_SEC`. */
  readonly minAgeSec: number;
  /** `RESOLVE_DISCRIMINATING_MULTIPLE_BPS`. */
  readonly discriminatingMultipleBps: number;
  /** Journal row for one of the sequence's recorded steps. */
  readonly readStepRow: (idempotencyKey: string) => Promise<JournalEntry | null>;
  /** Confirmed-receipt money reads. `eth_getTransactionReceipt` only. */
  readonly receipts: LpReceiptReader;
  /**
   * `positions(tokenId, finalizedBlock)` — the only discriminating evidence a
   * stuck `zap-out` can have. The explicit height is load-bearing because a
   * landed answer closes the position and zeroes its basis.
   */
  readonly positions: LpPositionsReader;
  /** ERC-20 `balanceOf` for the agent's wallet, at `latest`. */
  readonly tokenBalance: (token: Address) => Promise<bigint>;
  /**
   * The id of the position's ONE non-terminal sequence right now, or `null`.
   *
   * Read ONLY on A1's re-entry path, which is why it is a thunk: the ordinary
   * path already knows the sequence it is abandoning is that sequence (it is
   * non-terminal, and the store allows one per position), so the read would be
   * wasted. See `re_entry_superseded`.
   */
  readonly readPositionNonTerminalSequenceId?: () => Promise<string | null>;
  /** The height the SERVER read at, when the deployment can answer it. */
  readonly blockNumber?: () => Promise<bigint>;
  /** The server's finalized head used for position-closing evidence. */
  readonly finalizedBlockNumber?: () => Promise<bigint>;
  /** The optional, capability-probed log-absence evidence. */
  readonly logAbsence?: LpLogAbsenceProbe;
  /**
   * ONE bounded relay status read for the row's `callsId` (PHASE3.14 F2).
   *
   * OPTIONAL, and the optionality is part of the contract: absent, unreachable
   * and unmapped are the SAME outcome — record what happened and fall through
   * to the direct-evidence path. Nothing here may ever refuse because the relay
   * could not be reached.
   */
  readonly readRelayStatus?: LpRelayStatusReader;
};

/* -------------------------------------------------------------------------- */
/* Per-kind tables                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rev2 item 12, the disposition table, with the row PHASE3.1 changed.
 *
 * | kind | principal still IN the position? | disposition |
 * | --- | --- | --- |
 * | `harvest` | yes — only fees were freed | ABANDON; the position row is untouched (`open`), the worker sees it again, protection re-arms |
 * | `protect` / `manual-exit` | yes, or already exited | ABANDON, and restore `closing → open` — but ONLY from `closing`; see `exitPositionDisposition` |
 * | `rotate` | NO — the zap-out already emptied it | REFUSED |
 * | `open` | no | REFUSED |
 *
 * `rotate` and `open` are refused because the principal is OUT of the
 * position: abandoning strands it with no automation to re-enter, and retrying
 * means a `zap-in-mint` whose double execution mints a second NFT and points
 * the lineage at it, orphaning a live, funded, unprotectable position for ever.
 * Neither branch is verifiable with the reads available, so the refusal names
 * the backstop that does work — out-of-band custody recovery with the owner
 * key, proven in Phase 0.
 */
/*
 * PHASE3.22 R2.5 (upholding OQ3, against the spec body's own R12) —
 * `grid-shift` is NOT A MEMBER, and the omission is a ruling rather than an
 * oversight.
 *
 * The body proposed adding it and mapping CONFIRMED ⇒ finish / FAILED ⇒
 * abandon through the 3.14 machinery. R2.5 WITHDREW that: this resolver's
 * `advance` verdict is two booleans keyed on `LIQUIDITY_REMOVING_STEPS`, it
 * cannot write a tokenId, and there is no honest value of either boolean for a
 * step that both REMOVES liquidity (two zap-outs) and ADDS it (up to two
 * mints) in one submission.
 *
 * The DECLARED CONSEQUENCE, owner-facing and stated in the view, the client
 * and the spec: an UNKNOWN mid-shift freezes BOTH rungs and disarms the price
 * stop for the pair until the owner signs the declared-ambiguity abandon
 * (R5.1), which closes both arm-group rows and names both prior tokenIds. That
 * abandon is the door this omission makes necessary, and it exists precisely
 * because refusing here would otherwise be doorless — which is what REVIEW2's
 * N1 proved about R2.5 as first written.
 *
 * A receipt-driven resolver capability (a `mintedTokenIds` corroboration
 * parser plus a per-kind disposition derived from the receipt) is DEFERRED to
 * its own phase with its own spec, review, build and audit. When it lands, the
 * membership and the parser must be added IN THE SAME CHANGE — the pairing
 * pinned at `corroborateLandedStep` and `laterLandingResidual`.
 */
export const RESOLVABLE_SEQUENCE_KINDS: ReadonlySet<LpSequenceKind> =
  new Set<LpSequenceKind>(["harvest", "protect", "manual-exit"]);

const EXIT_SEQUENCE_KINDS: ReadonlySet<LpSequenceKind> = new Set<LpSequenceKind>([
  "protect",
  "manual-exit",
]);

/**
 * The refusal message for `rotate` / `open`, which must name the backstop.
 */
export const LP_RESOLVE_CUSTODY_RECOVERY_MESSAGE =
  "The principal is out of the position for this sequence kind, so abandoning it would strand the funds and retrying it would risk a second mint. v1 refuses; the owner's backstop is out-of-band custody recovery with the owner key (owner-only KeyStore.revokeKey plus a plain EOA transfer), which needs no server.";

/**
 * Whether the row is a PARTIALLY-APPLIED resolution of this same action
 * (PHASE3.3-AUDIT A1), rather than a fresh `UNKNOWN` row.
 *
 * The two conditions together are what make this safe to trust. `ROLLED_BACK`
 * alone would let an ordinary rolled-back row (one that provably never reached
 * a relay) be re-dispositioned; the `resolution` key is written by
 * `ExecutionJournal.resolveUnknown` and by nothing else, so its presence proves
 * that a previous attempt of THIS action, on THIS row, already passed the whole
 * check set and recorded its evidence. No new authority is granted: the
 * re-entry still needs a fresh owner signature and a fresh nonce, and it can
 * only re-apply the disposition the row already carries.
 */
export function resumedResolution(row: JournalEntry): boolean {
  // PHASE3.9a / PHASE3.9-REVIEW M5. Recognising only `ROLLED_BACK` was correct
  // when abandonment was the only disposition. With `advance` writing
  // `COMMITTED`, the same predicate would call an interrupted advance
  // un-resumed and the action would be un-re-runnable — verbatim the defect
  // PHASE3.8-AUDIT A1 found one phase earlier, on this same property.
  //
  // The `resolution` key is what makes this safe: it is written by
  // `resolveUnknown`/`advanceUnknown` and by nothing else, so a COMMITTED row
  // carrying one was committed BY THIS ACTION rather than by a receipt.
  return (
    (row.state === "ROLLED_BACK" || row.state === "COMMITTED") &&
    row.externalRef.resolution !== undefined
  );
}

/* -------------------------------------------------------------------------- */
/* The verifier                                                               */
/* -------------------------------------------------------------------------- */

/** Legs the pool has, by identity against the configured WBNB. */
function poolLegs(
  position: LpPositionRecord,
  wbnb: Address,
): { readonly wbnbIsToken0: boolean; readonly token: Address } | null {
  const w = wbnb.toLowerCase();
  if (position.token0.toLowerCase() === w) {
    return { wbnbIsToken0: true, token: position.token1 };
  }
  if (position.token1.toLowerCase() === w) {
    return { wbnbIsToken0: false, token: position.token0 };
  }
  return null;
}

type Freed = { wbnbWei: bigint; tokenWei: bigint };

type DerivedInputs =
  | { readonly ok: true; readonly needed: readonly { token: Address; wei: bigint }[] }
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * Which refusal the reason belongs under. Defaults to `"unresolvable"`,
       * the historical code for every derivation failure; PHASE3.14 F3 needs
       * `"inputs_missing"` for the one failure that is about a MISSING RECEIPT
       * rather than about an inexpressible check.
       */
      readonly code?: LpResolveRefusalCode;
    };

/**
 * Re-derive what the stuck step would have SPENT, from the confirmed prior
 * steps' receipts. Read-only; see the module header for why it mirrors the
 * `after` hooks rather than calling them.
 *
 * DERIVABILITY IS NOT UNIVERSAL, and pretending otherwise is how a verifier
 * lies. Per (sequence kind, stuck step kind):
 *
 *   - harvest / `zap-in-increase` — BOTH legs, exactly: the collect receipt
 *     gives what was freed and the sweep receipt gives how it was re-split.
 *     This is the real (al) row;
 *   - protect|manual-exit / `sweep-token` — ONE leg, exactly: PHASE3.1's exit
 *     swap sizes itself on `freed.tokenWei`, the confirmed collect delta from
 *     step 0, and on nothing else;
 *   - harvest / `sweep-token` — NOT derivable. `planLpSweep` sized that step
 *     from a MARKET READ taken at build time (the range's required ratio at the
 *     then-current tick), and re-deriving it now would produce a different
 *     number against a different tick. A verifier that guessed here would be
 *     asserting an amount nobody ever submitted;
 *   - harvest / `collect-fees`, exit / `zap-out` — no wallet inputs at all: the
 *     step spends the POSITION's own fees or liquidity, not the wallet's
 *     fungible balance, so the leg test has nothing to test and there is no
 *     discriminating evidence to be had. Refused as unresolvable, which is the
 *     honest fail-closed answer and is decision 4's own "refuse for any step
 *     whose non-landing cannot be established" applied properly.
 */
async function deriveStuckStepInputs(
  input: LpResolveInput,
  sequence: LpSequenceRecord,
  position: LpPositionRecord,
  stuck: LpSequenceStep,
  legs: { readonly wbnbIsToken0: boolean; readonly token: Address },
  priorRows: ReadonlyMap<string, JournalEntry>,
): Promise<DerivedInputs> {
  const freed: Freed = { wbnbWei: 0n, tokenWei: 0n };

  for (const step of sequence.steps) {
    if (step.index >= stuck.index) break;
    const row = priorRows.get(step.journalIdempotencyKey);
    // A ROLLED_BACK prior step provably never reached a relay (audit A1's
    // positional classification), so it moved nothing and is skipped. This is
    // the ONLY thing in this phase that reads `ROLLED_BACK` at all, and it
    // reads it as "moved no money" — never as "the slot reopens for a retry of
    // the same kind", the equivalence PHASE3.1 Rev2 item 12 broke.
    if (row === undefined || row.state === "ROLLED_BACK") continue;
    const txHash = row.externalRef.txHash;
    // A recorded SKIP is COMMITTED with no txHash: the plan position completed
    // and nothing moved.
    //
    // PHASE3.14 F3. That inference is sound for the SAGA's own skip
    // (`sagas.ts` `recordSkip`: `markCommitted(key)` with no ref, no submit and
    // therefore no `callsId`) and UNSOUND for a row `reconcile` committed:
    // `markCommitted` attaches a txHash only when the relay's answer carried
    // `receipts[0].transactionHash`, and this relay demonstrably answers with
    // `receipts: []`. Read as a skip, such a step contributes zero to `freed`,
    // every derived leg comes out zero, and the owner is told "the wallet can
    // say nothing" when the truth is that a receipt was never recorded.
    //
    // `callsId` is the discriminator, and it is the ONLY one available:
    // `callsHash` proves nothing by its presence (PHASE3.1-FIXREVIEW3 H5 — the
    // live path writes it at `beginWithSpend`, above every submit), while a
    // skip cannot have a `callsId` because it never submitted.
    if (txHash === undefined) {
      if (row.externalRef.callsId === undefined) continue;
      return {
        ok: false,
        code: "inputs_missing",
        reason: `Prior step ${step.index} (${step.kind}) is COMMITTED with a callsId but NO transaction hash, so it was settled from a relay answer that carried no receipt (this relay emits "receipts": []). Its moved amounts cannot be read, and treating it as a recorded skip would derive zero legs and report the wallet as uninformative. The stuck step's inputs are not derivable until that receipt is known.`,
      };
    }
    if (step.kind === "collect-fees" || step.kind === "zap-out") {
      const collected = await input.receipts.collectAmounts(txHash);
      freed.wbnbWei = legs.wbnbIsToken0 ? collected.amount0Wei : collected.amount1Wei;
      freed.tokenWei = legs.wbnbIsToken0 ? collected.amount1Wei : collected.amount0Wei;
      continue;
    }
    if (step.kind === "sweep-token") {
      const swap = await input.receipts.swapAmounts(txHash);
      if (swap.tokenIn.toLowerCase() === input.wbnb.toLowerCase()) {
        freed.wbnbWei -= swap.amountInWei;
        freed.tokenWei += swap.amountOutWei;
      } else {
        freed.tokenWei -= swap.amountInWei;
        freed.wbnbWei += swap.amountOutWei;
      }
      if (freed.wbnbWei < 0n || freed.tokenWei < 0n) {
        return {
          ok: false,
          reason:
            "A confirmed sweep receipt reports more input than the collect freed; refusing to derive an input amount from a negative carry.",
        };
      }
      continue;
    }
    return {
      ok: false,
      reason: `Prior step ${step.index} is a "${step.kind}", whose carried amounts this build cannot re-derive read-only.`,
    };
  }

  if (sequence.kind === "harvest" && stuck.kind === "zap-in-increase") {
    return {
      ok: true,
      needed: [
        { token: input.wbnb, wei: freed.wbnbWei },
        { token: legs.token, wei: freed.tokenWei },
      ],
    };
  }
  if (EXIT_SEQUENCE_KINDS.has(sequence.kind) && stuck.kind === "sweep-token") {
    return { ok: true, needed: [{ token: legs.token, wei: freed.tokenWei }] };
  }
  if (stuck.kind === "zap-out") {
    // Handled by `zapOutStillFunded`, not by the leg test — see its contract.
    return { ok: true, needed: [] };
  }
  if (stuck.kind === "collect-fees") {
    return {
      ok: false,
      reason: `A stuck "${stuck.kind}" spends the position's own uncollected fees, not the wallet's fungible balance, and a later collect would report ~0 either way; there is no expressible check. Position ${position.positionId} needs out-of-band custody recovery instead.`,
    };
  }
  return {
    ok: false,
    reason: `A stuck "${stuck.kind}" in a ${sequence.kind} sequence sized itself on a market read taken at build time; this build refuses to re-derive an amount nobody submitted.`,
  };
}

/**
 * The per-kind FINALIZED-state check for a stuck `zap-out` (review R7 item 4),
 * and the one place this build adds to Rev2 item 10's check list.
 *
 * DEVIATION, STATED. Item 10 names its list (a)–(g) as the check set
 * "therefore, and only". Taken literally that makes an exit stuck at step 0
 * permanently unresolvable — the step spends the POSITION's liquidity, not the
 * wallet's fungible balance, so (e)/(f) have no leg to test — and with it item
 * 12's own `protect`/`manual-exit` row (restore `closing → open`) becomes dead
 * code and the review's own required test for it cannot pass. R7 item 4, which
 * item 10 is drawn from, names exactly this check and calls it expressible:
 * `zap-out` → `positions(tokenId).liquidity > 0`, "still funded".
 *
 * It is implemented here because it is STRICTLY STRONGER than a leg test, not
 * weaker:
 *
 *   - it is an `eth_call` pinned to the finalized height on the preferred
 *     endpoints — no archive and no logs, but strong enough to close a row;
 *   - it is not fungible. Liquidity in THIS tokenId cannot be explained by an
 *     unrelated balance the way a CAKE surplus can, and the position row is
 *     `closing`, so the store's one-non-terminal-sequence-per-position rule
 *     means no other saga could have put it back;
 *   - `zap-out` is the one genuinely idempotent kind (R3), so even a wrong
 *     answer here is benign — and nothing is retried anyway (item 11).
 *
 * A `burned` token or zero liquidity means the decrease DID land. Phase 3.9a
 * spends its named `UNKNOWN → COMMITTED` edge on that positive proof, closes
 * the `closing` position and leaves the freed legs in the owner's wallet.
 */
type ZapOutFundedVerdict =
  /** Liquidity is still there ⇒ the withdrawal did NOT land ⇒ abandon. */
  | { readonly kind: "funded"; readonly detail: string; readonly blockNumber: bigint }
  /** Burned or zero liquidity ⇒ the withdrawal DID land ⇒ advance (3.9a). */
  | { readonly kind: "landed"; readonly detail: string; readonly blockNumber: bigint }
  /** No tokenId, or the read failed ⇒ nothing can be concluded. */
  | { readonly kind: "unreadable"; readonly reason: string };

async function zapOutStillFunded(
  input: LpResolveInput,
  position: LpPositionRecord,
): Promise<ZapOutFundedVerdict> {
  if (position.tokenId === null) {
    return {
      kind: "unreadable",
      reason: "The position carries no tokenId, so its funded state cannot be read.",
    };
  }
  // This seam cannot fall back to the generic server head. A landed answer
  // closes the position and zeroes its basis, so only an explicitly-finalized
  // height is admissible even when an ordinary `blockNumber` reader exists.
  const finalizedHead = input.finalizedBlockNumber;
  if (finalizedHead === undefined) {
    return {
      kind: "unreadable",
      reason:
        "The finalized position reader is unavailable; a latest-state answer cannot close and zero a position.",
    };
  }
  let finalizedBlock: bigint;
  let snapshot: Awaited<ReturnType<LpPositionsReader>>;
  try {
    finalizedBlock = await finalizedHead();
    snapshot = await input.positions(BigInt(position.tokenId), finalizedBlock);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `The position's on-chain state could not be read: ${
        error instanceof Error ? error.message : "positions read failed"
      }`,
    };
  }
  if (snapshot === "burned") {
    return {
      kind: "landed",
      detail: `the position token is BURNED at finalized block ${finalizedBlock.toString(10)}, which only the withdrawal can do`,
      blockNumber: finalizedBlock,
    };
  }
  if (snapshot.liquidity <= 0n) {
    return {
      kind: "landed",
      detail: `the position reports ZERO liquidity at finalized block ${finalizedBlock.toString(10)}, which only the withdrawal can do`,
      blockNumber: finalizedBlock,
    };
  }
  return {
    kind: "funded",
    detail: `liquidity ${snapshot.liquidity.toString(10)} > 0 at finalized block ${finalizedBlock.toString(10)}`,
    blockNumber: finalizedBlock,
  };
}

/**
 * The position half of the exit disposition, and the ONE place this build
 * departs from Rev2 item 12 as written.
 *
 * Item 12 says an abandoned `protect`/`manual-exit` must restore the position
 * `closing → open`, on the reasoning that a terminal sequence over a `closing`
 * position releases the sequence lock but not the position — no trigger
 * evaluation, no protection, (al)'s trap in a new costume.
 *
 * PHASE3.1 landed AFTER that was written and moved the close into step 0's
 * `after`, so where the sequence stuck now decides the row's state:
 *
 *   - stuck at step 0 (`zap-out`) ⇒ the position is `closing`. Item 12 applies
 *     verbatim: restore it to `open`;
 *   - stuck at step 1 (the exit swap) ⇒ the position is ALREADY `closed`, and
 *     item 12 would THROW. `assertPositionTransition` gives `closed` an empty
 *     legal set, so `setPositionState(…, "open")` raises "Illegal LP position
 *     transition closed → open" and the whole resolution fails at the last
 *     write. The INTENT is wrong too: closing zeroes `basisWei`, so a restored
 *     row would re-enter `listOpenPositionsForWorker` with a zero basis, where
 *     `lpProtectionStatus` answers `armed: false` for ever — an eternal zombie.
 *     And item 12's justification does not apply: step 1 only runs because step
 *     0 confirmed and put BOTH legs in the owner's own EOA, so there is nothing
 *     left in the position to protect.
 *
 * The COST that changes with it, which item 12 prices only as "freed dust":
 * abandoning an exit at step 1 means the owed conversion never happens and the
 * owner keeps the volatile leg — Phase 3's outcome exactly (FINDINGS (ag)), and
 * never worse than it.
 */
function exitPositionDisposition(position: LpPositionRecord): {
  readonly restore: boolean;
  readonly note: string;
} {
  if (position.state === "closing") {
    return {
      restore: true,
      note: "position restored closing -> open",
    };
  }
  if (position.state === "closed") {
    return {
      restore: false,
      note: "position left closed (the exit's zap-out already confirmed and both legs are in the wallet; the owed conversion is not performed)",
    };
  }
  return { restore: false, note: "position left open" };
}

/**
 * Read the transaction a relay `CONFIRMED` named, through the receipt parser
 * that fits the stuck step's kind (PHASE3.14 F2.2).
 *
 * ASYMMETRIC BY DESIGN. A successful read corroborates the relay; a failed one
 * does NOT contradict it, because the two failure modes are indistinguishable
 * from here — a receipt that is not there yet and an RPC that will not serve it
 * look the same — and the safe direction is to fall through to the inference
 * path rather than to conclude the OPPOSITE of what the relay said.
 *
 * Not every kind has a parser: `zap-in-increase` emits neither a `Collect` nor
 * a `Swap`, and the reader offers only those two plus `mintedTokenId`. That is
 * recorded as "no parser", not smuggled in as a pass or a fail.
 */
async function corroborateLandedStep(
  input: LpResolveInput,
  stuckKind: string,
  txHash: Hex,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const read =
    stuckKind === "zap-out" || stuckKind === "collect-fees"
      ? async (): Promise<string> => {
          const collected = await input.receipts.collectAmounts(txHash);
          return `collect deltas read from the transaction (${collected.amount0Wei.toString(10)}/${collected.amount1Wei.toString(10)})`;
        }
      : stuckKind === "sweep-token"
        ? async (): Promise<string> => {
            const swap = await input.receipts.swapAmounts(txHash);
            return `swap legs read from the transaction (in ${swap.amountInWei.toString(10)}, out ${swap.amountOutWei.toString(10)})`;
          }
        : null;
  // ─── PHASE3.22 R2.6 — `grid-shift` HAS NO PARSER IN v1, AND IT IS
  // UNREACHABLE RATHER THAN MISSING ────────────────────────────────────────
  //
  // `grid-shift` is deliberately absent from `RESOLVABLE_SEQUENCE_KINDS`
  // (R2.5), so `resolveUnknown` returns `sequence_kind_unsupported` long before
  // corroboration is reached. There is therefore nothing to write here, and the
  // `read === null` fall-through below would answer harmlessly in any case.
  //
  // THE PAIRING IS PINNED BY THIS COMMENT, at both sites (the identical note
  // sits in `laterLandingResidual`): the DEFERRED receipt-driven resolver phase
  // must add the parser and the `RESOLVABLE_SEQUENCE_KINDS` membership IN THE
  // SAME CHANGE. Adding the membership alone would route a shift into the
  // fall-through's "the relay's transaction hash stands on its own", which for
  // a step that both REMOVES and ADDS liquidity is not a corroboration — and
  // the resolver's `advance` verdict, two booleans keyed on
  // `LIQUIDITY_REMOVING_STEPS`, has no honest value for it either.
  if (read === null) {
    return {
      ok: true,
      detail: `no receipt parser exists for a "${stuckKind}", so the relay's transaction hash stands on its own`,
    };
  }
  try {
    return { ok: true, detail: await read() };
  } catch (error) {
    return {
      ok: false,
      detail: `the named transaction could not be read (${
        error instanceof Error ? error.message : "receipt read failed"
      }); NOT treated as a contradiction — the direct-evidence path decides`,
    };
  }
}

/**
 * What a LATER landing of an abandoned step would mean, per stuck kind
 * (PHASE3.14 F6(i), from the review's own enumeration).
 *
 * No step is ever retried and the abandon releases no reservation and no quota
 * (the exit idiom `callsId ?? txHash` keeps the row counted), so nothing here
 * is double-spent or lost. Two of the three are benign; the third is this
 * phase's named OPEN RESIDUAL and says so rather than being discovered later.
 */
function laterLandingResidual(
  stuckKind: string,
  sequenceKind: LpSequenceKind,
): string {
  if (stuckKind === "zap-out") {
    return (
      "the liquidity would leave and both legs would arrive in the owner's own EOA, while the position row this action restores to `open` keeps its original basis — a PHANTOM OPEN position, counted in openPositionsCount and re-armed, whose next protect would build a zap-out against zero liquidity. Funds are safe (they are in the owner's EOA) but the row does not self-heal: PHASE3.4's ownerOf reconciliation closes on TRANSFER, not on emptiness. Recorded as an OPEN RESIDUAL of PHASE3.14; a zero-liquidity reconciler is a separate spec."
    );
  }
  if (stuckKind === "zap-in-increase") {
    return (
      "the carried legs would be consumed into the SAME position and its liquidity would grow, so the journal would say ROLLED_BACK for a step that happened. Nothing else drifts: the position row is untouched (`open`), the worker re-evaluates it normally, and basisWei is written only at open/import, so no TP/SL basis error follows."
    );
  }
  if (stuckKind === "sweep-token") {
    return sequenceKind === "harvest"
      ? "it is a wallet-only swap between the pool's two legs; the wallet would hold the other side of it and no position row is affected."
      : "it is a wallet-only swap of the freed token into the quote asset, with the position already closed — so the note saying the owed conversion did not run would become wrong in the owner's favour.";
  }
  // ─── PHASE3.22 R2.6 — `grid-shift`: NO RESIDUAL, EXPLICITLY ──────────────
  //
  // An explicit arm rather than the fall-through, because R2.6 requires all
  // four kind-keyed surfaces to carry a written entry for this kind rather than
  // inherit one. Like the corroboration parser above it is UNREACHABLE in v1:
  // `grid-shift` is not in `RESOLVABLE_SEQUENCE_KINDS`, so no shift step is
  // ever abandoned through this path and no later landing of one is ever
  // described here.
  //
  // The DEFERRED receipt-driven resolver phase must replace this arm in the
  // same change that adds the parser and the membership — the pairing pinned at
  // `corroborateLandedStep`. What it will have to say is not obvious and is
  // recorded now while the reasoning is fresh: a shift that lands later moves
  // BOTH rungs at once, so the consequence is not one row's but the PAIR's —
  // two emptied NFTs the plane still believes are live, and up to two freshly
  // minted ones it has no row for. That is exactly why the declared-ambiguity
  // abandon (R5.1) CLOSES both arm-group rows and names both tokenIds instead
  // of leaving them open.
  if (stuckKind === "grid-shift") {
    return "no residual is enumerated for a grid-shift in v1: the kind is not resolvable, so this path is unreachable. A later landing could move one or both targeted rungs, which is why an ambiguous shift is abandoned by closing both arm-group rows and naming both prior tokenIds rather than by restoring either.";
  }
  return "no per-kind consequence is enumerated for this step kind; treat the wallet's balances as the authority.";
}

/**
 * Run the whole check set, in order, and decide. Every check is recorded in the
 * returned evidence whether it passed or failed, because the receipt is the
 * point: this action must be auditable after the fact rather than a state
 * change with no reason.
 */
export async function verifyLpResolveUnknown(
  input: LpResolveInput,
): Promise<LpResolveVerdict> {
  const checks: LpResolveCheck[] = [];
  const legs: LpResolveLegEvidence[] = [];
  let logAbsence: LpResolveLogAbsence = {
    checked: false,
    detail:
      "No capability-probed log endpoint is configured; every endpoint resolveLpRpcUrls prefers refuses eth_getLogs at every range.",
  };
  let serverBlock: bigint | null = null;
  let positionEvidenceBlock: bigint | null = null;
  // Detect before ANY chain read. Re-entry re-applies an already-recorded
  // decision; querying a potentially changed chain answer is both wasted and a
  // temptation to reinterpret the disposition (PHASE3.9-AUDIT A1).
  const reEntry = resumedResolution(input.row);

  if (reEntry) {
    const recorded = input.row.externalRef.resolution;
    if (recorded?.serverBlock !== null && recorded?.serverBlock !== undefined) {
      if (/^\d+$/.test(recorded.serverBlock)) serverBlock = BigInt(recorded.serverBlock);
    }
    if (
      recorded?.positionEvidenceBlock !== null &&
      recorded?.positionEvidenceBlock !== undefined &&
      /^\d+$/.test(recorded.positionEvidenceBlock)
    ) {
      positionEvidenceBlock = BigInt(recorded.positionEvidenceBlock);
    }
  } else if (input.blockNumber !== undefined) {
    try {
      serverBlock = await input.blockNumber();
    } catch {
      serverBlock = null;
    }
  }
  checks.push({
    name: "server-block",
    result: serverBlock === null ? "unavailable" : serverBlock.toString(10),
  });

  const refuse = (
    code: LpResolveRefusalCode,
    message: string,
  ): LpResolveVerdict => {
    checks.push({ name: `refused:${code}`, result: message });
    return {
      ok: false,
      code,
      message,
      checks,
      legs,
      logAbsence,
      serverBlock,
      positionEvidenceBlock,
    };
  };

  /* --- (a) row shape ----------------------------------------------------- */

  // PHASE3.3-AUDIT A1. Detected BEFORE the state gate, because the state gate
  // is exactly what refuses a re-entry: the row is ROLLED_BACK by then.
  if (!reEntry) {
    // A9: the state check comes FIRST. Evaluated the other way round, a row
    // that is already COMMITTED *and* carries a callsId was told "reconcile
    // resolves it automatically and this action refuses to guess ahead of it",
    // sending the owner to restart a server for a row that is already settled.
    if (input.row.state !== "UNKNOWN") {
      return refuse(
        "not_unknown",
        `The row is ${input.row.state}; only an UNKNOWN row can be resolved.`,
      );
    }
    // PHASE3.14 F5. The 3.9c landing path admits UNKNOWN rows and never looks
    // at `callsId` — it is BUILT for callsId rows, since its whole premise is
    // binding the relay-prepared intent. Until R-A′ the two owner-signed
    // surfaces were partitioned by the `has_calls_id` refusal that used to
    // stand here; with that gone, this is the partition. A claimed landing
    // resolution owns the row through a fenced lease and has recorded
    // provisional evidence on the sequence, so resolving here would roll the
    // sequence back underneath both.
    if (input.row.landingResolutionId !== null) {
      return refuse(
        "landing_resolution_claimed",
        `A landing resolution (${input.row.landingResolutionId}) has claimed this row under its own fenced lease; that path owns the outcome and this action refuses to decide underneath it.`,
      );
    }
    // PHASE3.14 R-A′ / F1. The `has_calls_id` refusal that used to stand here
    // is DELETED, not narrowed. PHASE3.3-AUDIT A9 had already moved the state
    // gate above it, so it could only ever fire on an UNKNOWN row — precisely
    // the row `reconcile` has disowned (its query is
    // `state in ('PENDING','IN_PROGRESS')`), and precisely the row whose
    // "reconcile resolves it automatically" advice was false. Narrowing it by
    // state was therefore deletion. A `callsId` is now EVIDENCE, read once and
    // never able to refuse; see the relay seam below.
    checks.push({
      name: "row-shape",
      result:
        input.row.externalRef.callsId === undefined
          ? "UNKNOWN, kind lp, no callsId"
          : "UNKNOWN, kind lp, carrying a callsId reconcile has already disowned",
    });
  } else {
    checks.push({
      name: "row-shape",
      result:
        `${input.row.state} carrying this action's own resolution evidence: ` +
        `a previous ${input.row.state === "COMMITTED" ? "advance" : "abandon"} ` +
        "attempt was interrupted after the journal write",
    });
  }

  /* --- (b) age ----------------------------------------------------------- */

  const ageMs = input.nowMs - input.row.updatedAt;
  const minAgeMs = input.minAgeSec * 1000;
  if (!reEntry && ageMs < minAgeMs) {
    return refuse(
      "too_young",
      `The row was last written ${Math.max(0, Math.floor(ageMs / 1000))}s ago; RESOLVE_MIN_AGE_SEC is ${input.minAgeSec}. The age guard is a heuristic, not a proof: the relay's own latency is minutes and unbounded above.`,
    );
  }
  checks.push({
    name: "age",
    result: reEntry
      ? "skipped on re-entry (the resolution write reset updatedAt; the age it was accepted at is on the row already)"
      : `${Math.floor(ageMs / 1000)}s >= ${input.minAgeSec}s (anchored on updatedAt)`,
  });

  /* --- (c) zero native --------------------------------------------------- */

  // NOT skipped on re-entry: `nativeSpendWei` is written at `begin` and never
  // updated, so re-running the money guard is free and cannot refuse a row the
  // first attempt accepted.
  if (input.row.nativeSpendWei !== 0n) {
    // Rev2 item 13. Resolving to ROLLED_BACK releases this row's spend from the
    // rolling 24 h daily-cap sum, because ROLLED_BACK is the only state outside
    // SPEND_COUNTING_STATES. If the submission in fact landed, the off-chain
    // meter would then under-count a spend the chain made — a second spend
    // against one day's off-chain cap, and a push toward the known-unfixed
    // PHASE2.4 A1 inversion where the off-chain meter runs LOOSER than the
    // on-chain one. Refusing costs this phase nothing: every WBNB-paid LP step
    // is zero-native by construction and all three real rows read 0.
    return refuse(
      "native_spend",
      `The row holds ${input.row.nativeSpendWei.toString(10)} wei of native spend; resolving it would release held daily-cap budget for a spend the chain may have made. Only a zero-native row is resolvable.`,
    );
  }
  checks.push({ name: "native-spend", result: "0 wei" });

  /* --- (d) sequence kind supported --------------------------------------- */

  const sequence = input.sequence;
  if (sequence === null) {
    return refuse(
      "sequence_not_found",
      "The row's decision id names no sequence this owner holds.",
    );
  }
  if (!reEntry && isTerminalLpSequence(sequence.state, sequence.recoveryState)) {
    // A1: skipped on re-entry, because the write that made it terminal may be
    // the very write the interrupted attempt completed. Refusing here would put
    // the resolution beyond reach for the exact failure this re-entry exists to
    // cure — a crash between write (2) and write (3).
    return refuse(
      "sequence_terminal",
      `The sequence is already terminal (${sequence.state}/${sequence.recoveryState}); it blocks nothing and there is nothing to abandon.`,
    );
  }
  if (!RESOLVABLE_SEQUENCE_KINDS.has(sequence.kind)) {
    return refuse(
      "sequence_kind_unsupported",
      `A ${sequence.kind} sequence is refused in v1. ${LP_RESOLVE_CUSTODY_RECOVERY_MESSAGE}`,
    );
  }
  checks.push({
    name: "sequence-kind",
    result: `${sequence.kind} (${sequence.state}/${sequence.recoveryState})`,
  });

  const stuck = sequence.steps[sequence.steps.length - 1];
  if (
    stuck === undefined ||
    stuck.journalIdempotencyKey !== input.row.idempotencyKey
  ) {
    // The UNKNOWN row must be the sequence's CURRENT step. A row behind a later
    // recorded step is not what is holding the sequence, and abandoning on it
    // would resolve the wrong thing.
    return refuse(
      "step_not_current",
      "The UNKNOWN row is not the sequence's most recently recorded step; only the step that is holding the sequence may be resolved.",
    );
  }

  const position = input.position;
  if (position === null) {
    return refuse(
      "position_not_found",
      "The sequence's position row is missing for this owner.",
    );
  }
  const legInfo = poolLegs(position, input.wbnb);
  if (legInfo === null) {
    return refuse(
      "unresolvable",
      "The position has no WBNB leg, so its steps' inputs cannot be attributed to a leg.",
    );
  }

  /**
   * The accepted verdict, shared by the ordinary path and A1's re-entry.
   *
   * A fresh disposition comes from the evidence. Re-entry reconstructs that
   * recorded choice from the terminal journal state (COMMITTED is advance;
   * ROLLED_BACK is abandon), then recomputes only its idempotent store writes.
   */
  // PHASE3.14 F6(ii). The abandon RETIRES the row that held the sequence's
  // recovery marker, and that marker was the owner's only inventory of where
  // the stranded funds sit. Carry it into the disposition rather than deleting
  // it with the thing that recorded it.
  const recoveryInventory = `recovery marker at resolution: ${sequence.recoveryState}`;
  const carriesCallsId = input.row.externalRef.callsId !== undefined;
  /**
   * Set only when the RELAY ITSELF said the submission failed (PHASE3.14 F2.4).
   * That is the one abandon in this module that is not an inference, so it is
   * also the one abandon whose later-landing disclosure would be false.
   */
  let relayProvedNotLanded = false;

  const accept = (
    action: "abandon" | "advance" = "abandon",
    /**
     * What the advance RESTS ON, named in the note (PHASE3.14 F2). The default
     * is PHASE3.9a's own path — `zapOutStillFunded`'s finalized `positions()`
     * read — and the relay seam passes its own, because "finalized on-chain
     * evidence" would be a false description of a relay status answer.
     */
    advanceEvidence = "direct finalized on-chain evidence",
  ): LpResolveVerdict => {
    // PHASE3.9a. An ADVANCE has a disposition of its own and does not consult
    // `exitPositionDisposition`, whose whole table is about a withdrawal that
    // did NOT land. Here it provably did — so a LIQUIDITY-REMOVING step's
    // position is CLOSED rather than restored, and the two flags are mutually
    // exclusive by construction.
    if (action === "advance") {
      // PHASE3.14 F2.3: kind-aware. An advanced `zap-in-increase` put the
      // carried legs INTO the position; closing it would delete a funded row.
      const removesLiquidity = LIQUIDITY_REMOVING_STEPS.has(stuck.kind);
      return {
        ok: true,
        disposition: {
          action: "advance",
          sequenceId: sequence.sequenceId,
          positionId: position.positionId,
          reEntry,
          restorePositionToOpen: false,
          closePosition: removesLiquidity,
          summary:
            `advanced ${sequence.kind} sequence at step ${stuck.index} (${stuck.kind}): ` +
            `the step is PROVEN landed, so it is recorded COMMITTED and ` +
            (removesLiquidity
              ? `the position closed. The freed legs are in the wallet and the exit's ` +
                `optional conversion did NOT run, so proceeds may be the token rather ` +
                `than BNB (FINDINGS (ag))`
              : `the position left OPEN — this step ADDED liquidity, so the principal is ` +
                `in the position and the worker sees it again`) +
            `; ${recoveryInventory}${
              reEntry ? "; re-applied after an interrupted advance (A1 re-entry)" : ""
            }`,
          note: removesLiquidity
            ? `The stuck step is recorded COMMITTED on ${advanceEvidence}. It is never retried; the emptied position is closed and its proceeds remain in the wallet.`
            : `The stuck step is recorded COMMITTED on ${advanceEvidence}. It is never retried; the position keeps its liquidity, stays open and is evaluated by the worker again.`,
        },
        checks,
        legs,
        logAbsence,
        serverBlock,
        positionEvidenceBlock,
      };
    }
    const exit = EXIT_SEQUENCE_KINDS.has(sequence.kind)
      ? exitPositionDisposition(position)
      : { restore: false, note: "position untouched (open); the worker sees it again" };
    // PHASE3.14 F6(i). A row with a `callsId` reached the relay, and this
    // action does NOT prove it did not land — it concludes so from evidence
    // that is an inference. Say what a later landing would mean for THIS step
    // kind instead of letting the receipt imply certainty.
    const residual =
      carriesCallsId && !relayProvedNotLanded
        ? ` The submission reached the relay (callsId on the row) and MAY STILL LAND: ${laterLandingResidual(stuck.kind, sequence.kind)}`
        : "";
    return {
      ok: true,
      disposition: {
        action: "abandon",
        sequenceId: sequence.sequenceId,
        positionId: position.positionId,
        reEntry,
        restorePositionToOpen: exit.restore,
        closePosition: false,
        summary: `abandoned ${sequence.kind} sequence at step ${stuck.index} (${stuck.kind}); ${exit.note}; freed dust left in the wallet; ${recoveryInventory}${
          reEntry ? "; re-applied after an interrupted resolution (A1 re-entry)" : ""
        }`,
        note:
          "The stuck step is abandoned, never retried. Any funds it freed stay in the wallet." +
          residual,
      },
      checks,
      legs,
      logAbsence,
      serverBlock,
      positionEvidenceBlock,
    };
  };

  if (reEntry) {
    // A1, the one way a re-entry can be WRONG rather than merely redundant. A
    // second non-terminal sequence can exist only if this resolution's own
    // sequence write already landed, so the only outstanding write is the
    // position restore — and if a newer saga now holds the position, restoring
    // it to `open` would yank the row out from under a live exit. Refuse: the
    // position is busy, not stranded.
    let current: string | null = null;
    if (input.readPositionNonTerminalSequenceId !== undefined) {
      try {
        current = await input.readPositionNonTerminalSequenceId();
      } catch {
        current = null;
      }
    }
    if (current !== null && current !== sequence.sequenceId) {
      return refuse(
        "re_entry_superseded",
        `This resolution was already applied to the sequence; the position now carries a different non-terminal sequence (${current}), whose saga owns its state. Nothing is stranded and nothing is re-applied.`,
      );
    }
    checks.push({
      name: "re-entry-not-superseded",
      result: current === null ? "no non-terminal sequence holds the position" : "this sequence still holds it",
    });
    // The evidence checks are DELIBERATELY not re-run. Their verdict is
    // already on the row, and re-running them would refuse honestly and
    // uselessly: the freed dust the leg test looks for may have been spent
    // since, and `zapOutStillFunded` reads a position a later saga may have
    // moved. Re-entry re-applies a decision that was already made and recorded;
    // it does not make a new one.
    checks.push({
      name: "inputs-still-present",
      result:
        "skipped on re-entry; the accepted leg evidence is on the row from the interrupted attempt",
    });
    checks.push({
      name: "log-absence",
      result: "skipped on re-entry",
    });
    return accept(input.row.state === "COMMITTED" ? "advance" : "abandon");
  }

  /* --- (d2) the relay's own answer, asked ONCE (PHASE3.14 F2) ------------- */

  // WHY HERE. After the state gate (PHASE3.3-AUDIT A9's ordering, which the
  // deleted `has_calls_id` branch used to sit under) and after the re-entry
  // block, which returns above: a re-entry re-applies a decision that was
  // already made and recorded, so it must not make a new one from a chain that
  // has moved since. Before the direct-evidence path, because the relay is the
  // only witness that can tell this module WHICH WORLD it is in — and a LANDED
  // step is exactly the case the inputs test answers `inputs_missing` for, its
  // legs being gone from the wallet precisely because they were spent.
  //
  // WHAT IT MAY NOT DO. It may not refuse on unavailability. A relay outage
  // that could refuse would reinstate the deadlock this phase closes, one layer
  // up — so absent reader, thrown transport error, unmapped status and honest
  // PENDING are ALL the same outcome: record what happened, fall through to the
  // audited inference. The check is recorded either way, because a pass that
  // declined to look must be distinguishable from a pass that looked and
  // learned nothing (the `previousObservationDiscarded` standard, PHASE3.6
  // FIXREVIEW N3).
  const callsId = input.row.externalRef.callsId;
  if (callsId === undefined) {
    checks.push({
      name: "relay-status",
      result: "not read: the row carries no callsId, so there is nothing to ask",
    });
  } else if (input.readRelayStatus === undefined) {
    checks.push({
      name: "relay-status",
      result: "not read: no relay status reader is wired on this deployment",
    });
  } else {
    let reading: LpRelayStatusReading | null = null;
    try {
      reading = await input.readRelayStatus(callsId);
    } catch (error) {
      checks.push({
        name: "relay-status",
        result: `unreadable: ${
          error instanceof Error ? error.message : "relay status read failed"
        } (the direct-evidence path decides; a relay outage never refuses)`,
      });
    }
    if (reading !== null && reading.status === "CONFIRMED") {
      const txHash = reading.transactionHash;
      if (txHash === undefined) {
        // PHASE3.14 F2.2, a NAMED RESIDUAL. `ADVANCE_ON_CHAIN_EDGE`'s contract
        // is positive on-chain PROOF; a status code with no receipt is not
        // that, and this relay demonstrably answers `receipts: []`. Refusing is
        // also the only safe direction: falling through would let the inference
        // path ABANDON — releasing a spend and restoring a position — a step
        // the relay says confirmed.
        checks.push({
          name: "relay-status",
          result: `CONFIRMED (raw status ${reading.rawStatus}) but carrying NO transaction hash`,
        });
        return refuse(
          "relay_confirmed_no_txhash",
          `The relay reports the submission CONFIRMED (raw status ${reading.rawStatus}) but returns no transaction hash, so there is nothing to advance the row on: a status code is not the positive on-chain proof this action's COMMITTED edge requires, and inferring the opposite would abandon a step the relay says landed. Sign again once the relay publishes the receipt.`,
        );
      }
      checks.push({
        name: "relay-status",
        result: `CONFIRMED (raw status ${reading.rawStatus}) with transaction ${txHash}`,
      });
      // Corroboration where a parser for this step kind exists. It STRENGTHENS
      // the answer and is never allowed to invert it: an RPC that cannot serve
      // the receipt is an outage, and an outage falls through to inference
      // rather than deciding the opposite of what the relay said.
      const corroboration = await corroborateLandedStep(input, stuck.kind, txHash);
      checks.push({ name: "relay-tx-corroboration", result: corroboration.detail });
      if (corroboration.ok) {
        checks.push({
          name: "discriminating-evidence",
          result:
            "the relay's own CONFIRMED answer for this row's callsId, carrying the transaction that landed it",
        });
        return accept(
          "advance",
          "the relay's own CONFIRMED answer for this row's callsId and the transaction it named",
        );
      }
    } else if (reading !== null && reading.status === "FAILED") {
      // Better evidenced than the inference below: the relay is the authority
      // on its own submission's failure, and a failed submission moved nothing.
      relayProvedNotLanded = true;
      checks.push({
        name: "relay-status",
        result: `FAILED (raw status ${reading.rawStatus}${
          reading.failureCode === undefined ? "" : `, ${reading.failureCode}`
        })`,
      });
      checks.push({
        name: "discriminating-evidence",
        result:
          "the relay's own FAILED answer for this row's callsId — the submission did not land, so nothing was spent",
      });
      return accept("abandon");
    } else if (reading !== null) {
      checks.push({
        name: "relay-status",
        result: `still PENDING (raw status ${reading.rawStatus}); this build maps nothing else, so an unmapped status reads as pending. The direct-evidence path decides.`,
      });
    }
  }

  /* --- (e) inputs still present ------------------------------------------ */

  const priorRows = new Map<string, JournalEntry>();
  for (const step of sequence.steps) {
    if (step.index >= stuck.index) continue;
    const row = await input.readStepRow(step.journalIdempotencyKey);
    if (row === null) continue;
    if (row.state !== "COMMITTED" && row.state !== "ROLLED_BACK") {
      return refuse(
        "step_not_current",
        `Step ${step.index} is ${row.state}; every step before the stuck one must itself be settled before this one can be resolved.`,
      );
    }
    priorRows.set(step.journalIdempotencyKey, row);
  }

  let derived: DerivedInputs;
  try {
    derived = await deriveStuckStepInputs(
      input,
      sequence,
      position,
      stuck,
      legInfo,
      priorRows,
    );
  } catch (error) {
    return refuse(
      "inputs_missing",
      `A prior step's confirmed receipt could not be read, so the stuck step's inputs cannot be derived: ${
        error instanceof Error ? error.message : "receipt read failed"
      }`,
    );
  }
  if (!derived.ok) return refuse(derived.code ?? "unresolvable", derived.reason);

  const positiveLegs = derived.needed.filter((leg) => leg.wei > 0n);

  if (positiveLegs.length === 0) {
    if (stuck.kind !== "zap-out") {
      return refuse(
        "unresolvable",
        "Every derived input leg is zero, so the wallet can say nothing about whether the step landed.",
      );
    }
    // The one kind whose discriminating evidence is the POSITION, not the
    // wallet. See `zapOutStillFunded` for why this is an addition to Rev2 item
    // 10's list, and why it is stronger than the leg test rather than weaker.
    const funded = await zapOutStillFunded(input, position);
    if (funded.kind === "unreadable") return refuse("unresolvable", funded.reason);
    positionEvidenceBlock = funded.blockNumber;
    checks.push({
      name: "position-evidence-block",
      result: `${funded.blockNumber.toString(10)} (finalized)`,
    });
    if (funded.kind === "landed") {
      // PHASE3.9a, and PHASE3.3-AUDIT A2 is what this closes. Until now the
      // STRONGEST evidence this deployment can obtain — positive proof from the
      // chain that the withdrawal happened — produced a permanent REFUSAL, and
      // the position sat `closing` for ever under a non-terminal sequence,
      // counting in `openPositionsCount`, with no trigger evaluation and no
      // second exit. The proof was always here; there was no edge to spend it
      // on.
      checks.push({ name: "zap-out-landed", result: funded.detail });
      checks.push({
        name: "discriminating-evidence",
        result:
          "the position's own on-chain state — positive proof of landing, not an inference from a fungible balance",
      });
      return accept("advance");
    }
    checks.push({ name: "zap-out-still-funded", result: funded.detail });
    checks.push({
      name: "discriminating-evidence",
      result: "the position's own liquidity (not fungible, not explicable by an unrelated balance)",
    });
  } else {
    const multiple = BigInt(input.discriminatingMultipleBps);
    for (const leg of positiveLegs) {
      let walletWei: bigint;
      try {
        walletWei = await input.tokenBalance(leg.token);
      } catch {
        return refuse(
          "inputs_missing",
          `The wallet's ${leg.token} balance could not be read, so the inputs-still-present check cannot run.`,
        );
      }
      // DISCRIMINATING means "close enough to the amount needed that an
      // unrelated balance could not explain it":
      // `walletWei * 10_000 <= neededWei * bps`.
      const discriminating = walletWei * 10_000n <= leg.wei * multiple;
      legs.push({ token: leg.token, neededWei: leg.wei, walletWei, discriminating });
    }

    const missing = legs.filter((leg) => leg.walletWei < leg.neededWei);
    const first = missing[0];
    if (first !== undefined) {
      return refuse(
        "inputs_missing",
        `The wallet no longer holds the ${first.token} the stuck step would have consumed (needs ${first.neededWei.toString(10)}, holds ${first.walletWei.toString(10)}), so this build cannot conclude the step did not land.`,
      );
    }
    checks.push({
      name: "inputs-still-present",
      result: `${legs.length} leg(s), all present at or above the derived amount`,
    });

    /* --- (f) at least one discriminating leg ------------------------------ */

    const discriminatingLegs = legs.filter((leg) => leg.discriminating);
    if (discriminatingLegs.length === 0) {
      return refuse(
        "unresolvable",
        `Every leg sits in a fungible surplus (none within ${input.discriminatingMultipleBps} bps of the amount needed), so their presence proves nothing. This step is unresolvable and is refused.`,
      );
    }
    checks.push({
      name: "discriminating-leg",
      result: `${discriminatingLegs.length} of ${legs.length}`,
    });
  }

  /* --- (g) optional log-absence evidence ---------------------------------- */

  if (input.logAbsence !== undefined && position.tokenId !== null) {
    try {
      logAbsence = await input.logAbsence({
        nfpm: input.nfpm,
        tokenId: BigInt(position.tokenId),
        observedBlock: input.observedBlock,
      });
    } catch (error) {
      logAbsence = {
        checked: false,
        detail: `The configured log endpoint refused: ${
          error instanceof Error ? error.message : "probe failed"
        }`,
      };
    }
  } else if (input.logAbsence !== undefined) {
    logAbsence = {
      checked: false,
      detail: "The position carries no tokenId, so there is no log topic to filter on.",
    };
  }
  checks.push({
    name: "log-absence",
    result: logAbsence.checked ? `checked: ${logAbsence.detail}` : `unavailable: ${logAbsence.detail}`,
  });

  /* --- disposition -------------------------------------------------------- */

  return accept();
}

/**
 * The `/lp/open` saga — mint the position the owner just signed for
 * (PHASE3-SPEC body "API surface"; Revision 2 items 3, 9–14, 23, 27, 32).
 *
 * Deliberately NOT inside `src/lp/sagas.ts`: that module's landed sagas and
 * its private driver are wired through their EXPORTED deps only, per the
 * build constraint, so the open composes the same landed pieces —
 * {@link LpSagaDeps}, the sequence store, the execution journal, the pure
 * builders and floor derivations — into its own single-submission driver.
 *
 * ─── ONE ATOMIC BATCH, ONE SUBMISSION ──────────────────────────────────────
 *
 * The open is the ONLY operation that attaches native (Rev2 item 14), and it
 * attaches all of it here, in one ERC-7821 batch:
 *
 *   [ V3 buy (native→TOKEN, part of the budget, floors from a fresh quote),
 *     approve(TOKEN → NFPM, exact),
 *     mint{value: the remaining budget}, refundETH ]
 *
 * Atomicity is the safety argument: there is no `pending-mint` window at
 * open, no swapped-but-unminted state to recover — either the position exists
 * or nothing moved. The mint's TOKEN `amountDesired` is the swap's own FLOOR
 * (`sagaSwapMinOut`), so the batch can never need more TOKEN than the swap is
 * guaranteed to have delivered; anything the swap returns above the floor
 * stays in the wallet as dust, which is the bounded cost of pre-committing
 * calldata for a balance that does not exist yet.
 *
 * `nativeSpendWei` on the journal row is the SUM of attached values — exactly
 * the owner-signed budget (item 10) — and is checked against the off-chain
 * daily cap inside the same transaction as the row's insert.
 *
 * v1 SHAPE, stated: the open mints a TWO-SIDED, IN-RANGE position. A range
 * that does not contain the current tick would need a single-sided mint whose
 * floor derivation (`sagaMintFloors`) is deliberately two-sided, so it is
 * refused before any money — a clean BUILD_REFUSED, not a default.
 *
 * ─── PHASE3.16: A SECOND MODE, ON THIS DRIVER ──────────────────────────────
 *
 * The autonomous GRID ARM (`POST /agents/:id/lp/grid/arm`) reuses this driver
 * under `mode: "grid-arm"` + `kind: "grid-arm"`, and the two-sided path above
 * is unchanged in every byte for every other caller. The grid plan replaces the
 * four-call batch with `[mint{value: budgetWei}, refundETH]` — no quote read,
 * no swap leg, no approve — and the refusals it does not want stay on the
 * two-sided branch of `buildLpOpenPlan`.
 *
 * WHY THIS DRIVER RATHER THAN `driveSequence` (ruling D1), in one sentence
 * each: this is the only driver whose worker resume structurally CANNOT
 * re-drive (the sentinel input trips the budget refusal before any branch is
 * consulted), and this is the only rollback that CLOSES the never-funded
 * position row — and every arm refusal must leave a closed row, or the re-arm
 * precondition can never be satisfied again.
 *
 * Everything else mirrors the landed driver's discipline verbatim: one
 * journal row per step (kind `lp`, decision id `lp:<sequenceId>:<stepIndex>`),
 * positional classification (thrown above the submit ⇒ ROLLED_BACK, inside ⇒
 * UNKNOWN and HELD), the journal as the single outcome authority, resume by
 * joining recorded steps against journal rows, money amounts only from
 * confirmed receipts (the minted tokenId comes from `receipts.mintedTokenId`,
 * never a re-read of `_nextId`).
 */
import type { Hex } from "viem";
import {
  ExecutionPlaneError,
  ProviderError,
  type ExecutionReceipt,
  type SessionRef,
  type WalletCall,
} from "../core/types.js";
import { sanitizeMessage } from "../core/errors.js";
import { authorizeExecute, executeIdempotencyKey } from "../auth/executeDecision.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import {
  LpPositionNotFoundError,
  deriveLpSequenceProgress,
  lpStepDecisionId,
  type LpSequenceRecord,
  type LpStepOutcomeState,
} from "../store/lpSequences.js";
import type { JournalEntry } from "../store/journal.js";
import { hashCalls } from "../http/wire.js";
import { exceedsDailyCap } from "../rules/engine.js";
import { agentAuthorityFromPrivateKey } from "../wallet/altana.js";
import {
  fingerprintLpFinalCallsV1,
  isProvenPreBindStagedLpError,
} from "./preparedIntent.js";
import { DEFAULT_TRADE_DEADLINE_SEC } from "../ops/config.js";
import {
  checkManipulationRails,
} from "./rails.js";
import { buildLpOpenPlan } from "./openPlanning.js";
import {
  lpReservationReleasable,
  type LpSagaDeps,
  type LpSagaRunResult,
} from "./sagas.js";

/**
 * What the route hands the open saga, all bound by the owner's paramsHash.
 *
 * A DISCRIMINATED UNION since PHASE3.16 (R2.4 / ruling D1). The `mode` selects
 * the plan and the `kind` selects the sequence kind, and both are stated by the
 * CALLER — neither is inferred from the range's position relative to the tick,
 * which would be the 3.13 F4 shape. They are coupled in the type on purpose:
 * the worker's `grid-arm` resume must pass BOTH (C7), because a `grid-arm`
 * sequence resumed under kind `"open"` trips the sequence-kind guard below into
 * `SEQUENCE_CONFLICT`/held instead of the `BUILD_REFUSED` → rollback → closed
 * row the never-re-driven policy needs.
 */
export type LpOpenInput =
  | {
      readonly mode: "two-sided-in-range";
      readonly kind: "open";
      readonly positionId: string;
      /** The owner-signed native budget, wei. Also the lineage basis (R7). */
      readonly budgetWei: bigint;
      /** Already snapped/validated by the route (explicit or server-fenced). */
      readonly tickLower: number;
      readonly tickUpper: number;
    }
  | {
      readonly mode: "grid-arm";
      readonly kind: "grid-arm";
      readonly positionId: string;
      /**
       * The owner-signed native budget, wei.
       *
       * C10: it is NOT the lineage basis in this mode. A grid row records
       * `basisWei: 0n` + `basisSource: "minted"`, because a ping-pong's
       * inventory alternates assets and a lineage-basis TP/SL would misfire on
       * it. The consequence is declared as a residual: the armed budget is
       * invisible to `checkLpNativeCapSizing` for the rest of the rolling 24 h
       * window (the arm's OWN sizing check sees it; nothing after it does).
       */
      readonly budgetWei: bigint;
      /** The signed `buyRange`, which the arm funds and only ever funds. */
      readonly tickLower: number;
      readonly tickUpper: number;
    }
  | {
      /**
       * PHASE3.17 R2.3 (ruling Q1) — the DUAL grid arm.
       *
       * A THIRD VARIANT and never an optional field on the one above, because
       * an optional field COMPILES WHEN OMITTED and would therefore police
       * nothing: every existing call site would keep type-checking while
       * silently meaning "single". A third variant makes each site that must
       * change a compile error, which is the same argument PHASE3.16's own D1
       * rests on and whose evidence is that audit's "sentinel kind → open dies
       * at COMPILE" mutation.
       *
       * THE LOAD-BEARING TIE is not the 1:1 mapping of mode to kind — it is
       * that a GRID MODE CAN NEVER CARRY `kind: "open"`. Both grid modes share
       * one kind, and the sequence-kind guard below is what turns a mismatched
       * resume into `SEQUENCE_CONFLICT`/held instead of the rollback-to-closed
       * the never-re-driven policy needs.
       *
       * `positionId` is LEVEL 1's row — the BUY rung, the native-attaching mint
       * and the one the SEQUENCE names (R3.4, 3.16 continuity). The sell row is
       * reached from either side through `arm_group_id`, never from this input:
       * the paths that must close both (the worker resume, `rollBack`, the
       * abandon route) never see a request.
       */
      readonly mode: "grid-arm-dual";
      readonly kind: "grid-arm";
      readonly positionId: string;
      /** LEVEL 2's row — the SELL rung. Carries the same `arm_group_id`. */
      readonly siblingPositionId: string;
      /** The owner-signed native budget, wei. Split 50/50 by CONSTANT. */
      readonly budgetWei: bigint;
      /** Level 1's `buyRange` — the INNER quote-charging rung. */
      readonly tickLower: number;
      readonly tickUpper: number;
      /** Level 2's `sellRange2` — the INNER base-charging rung. */
      readonly sellTickLower: number;
      readonly sellTickUpper: number;
      /** The pool's own tick spacing, for R3.3's one-spacing clearance rule. */
      readonly tickSpacing: number;
    }
  | {
      /**
       * PHASE3.19 C1 — the LADDER grid arm.
       *
       * A FOURTH VARIANT for the reason the third is one: an optional field
       * COMPILES WHEN OMITTED and would therefore police nothing, while a new
       * variant makes each site that must change a compile error. It also keeps
       * `buildGridArmDualPlan` and its positional test byte-identical, which is
       * C1's own requirement.
       *
       * THE LOAD-BEARING TIE is unchanged: a GRID MODE CAN NEVER CARRY
       * `kind: "open"`. All three grid modes share one kind, and the
       * sequence-kind guard turns a mismatched resume into
       * `SEQUENCE_CONFLICT`/held instead of the rollback-to-closed the
       * never-re-driven policy needs.
       *
       * `positionId` is the BUY row — the native-attaching mint#2 and the row the
       * SEQUENCE names, exactly as on the dual arm. The sell row is reached from
       * either side through `arm_group_id`, never from this input.
       */
      readonly mode: "grid-arm-ladder";
      readonly kind: "grid-arm";
      readonly positionId: string;
      /** The SELL row. Carries the same `arm_group_id`, and IS the book anchor. */
      readonly siblingPositionId: string;
      /** The owner-signed native budget. Split by R4.2's three values. */
      readonly budgetWei: bigint;
      /** The signed `buyRange` — the quote-charging rung. */
      readonly tickLower: number;
      readonly tickUpper: number;
      /** The signed `sellRange` — the base-charging rung. */
      readonly sellTickLower: number;
      readonly sellTickUpper: number;
      readonly tickSpacing: number;
      /** The signed `grid.ladder.deployPctBps`. */
      readonly deployPctBps: number;
    }
  | {
      /**
       * PHASE3.22 R5 — the SHIFT grid arm.
       *
       * A FIFTH VARIANT for the reason the fourth is one: an optional field
       * COMPILES WHEN OMITTED and would therefore police nothing, while a new
       * variant makes each site that must change a compile error.
       *
       * ITS PLAN IS THE LADDER'S, VERBATIM — `buildLpOpenPlan` delegates
       * `"grid-arm-shift"` straight to `buildGridArmLadderPlan`, so the four
       * legs (wrap the idle quote, swap the whole base half, mint the SELL
       * rung, mint the BUY rung), the G-gate on the quoted post-swap price and
       * every 3.19 refusal are inherited by reference rather than re-specified.
       *
       * WHERE IT DIVERGES, and it is exactly one place: the VWAP BOOK IS NOT
       * SEEDED. §10 makes the hedge and the markout book explicit NON-GOALS for
       * shift rows — the book tables stay, and shift mode writes NOTHING to
       * them — so `seedLadderBook`'s `input.mode !== "grid-arm-ladder"` guard
       * correctly excludes this variant. That is not an omission to be tidied
       * up later: a book nothing reads is a number that goes stale silently,
       * and shift mode has no hedge to read it.
       *
       * THE LOAD-BEARING TIE is unchanged: a GRID MODE CAN NEVER CARRY
       * `kind: "open"`. All four grid modes share one kind, and the
       * sequence-kind guard turns a mismatched resume into
       * `SEQUENCE_CONFLICT`/held instead of the rollback-to-closed the
       * never-re-driven policy needs.
       *
       * `positionId` is the BUY row and the sibling is the SELL row, exactly as
       * on the ladder arm — which is also what makes the BUY row the pair's
       * natural dispatcher while it is live (R4.2.4).
       */
      readonly mode: "grid-arm-shift";
      readonly kind: "grid-arm";
      readonly positionId: string;
      /** The SELL row. Carries the same `arm_group_id`. */
      readonly siblingPositionId: string;
      /** The owner-signed native budget. Split by `deployPctBps`. */
      readonly budgetWei: bigint;
      /** The signed `buyRange` — the quote-charging rung. */
      readonly tickLower: number;
      readonly tickUpper: number;
      /** The signed `sellRange` — the base-charging rung. */
      readonly sellTickLower: number;
      readonly sellTickUpper: number;
      readonly tickSpacing: number;
      /** The signed `grid.shift.deployPctBps`. */
      readonly deployPctBps: number;
    };

export type LpOpenResult = LpSagaRunResult & {
  /** The minted NFT id, present only on `completed`. */
  readonly tokenId?: string;
  /**
   * PHASE3.17 — the SELL rung's NFT id on a completed DUAL arm. Absent for
   * every other mode, so `tokenId` keeps meaning "the id this row got".
   */
  readonly siblingTokenId?: string;
};

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

async function withSessionKey<T>(
  store: AgentStore,
  agent: AgentRecord,
  use: (
    authority: ReturnType<typeof agentAuthorityFromPrivateKey>,
    sessionPrivateKey: Hex,
  ) => Promise<T>,
): Promise<T> {
  let sessionKey: Hex | undefined = await store.getAgentSessionKey(agent.ownerAddress, agent.id) ?? undefined;
  if (sessionKey === undefined) throw new ProviderError("Agent has no stored session key.");
  try {
    return await use(agentAuthorityFromPrivateKey(sessionKey), sessionKey);
  } finally {
    // JavaScript cannot zero immutable string storage. Drop this local
    // reference at the end of the narrow decrypted-key scope instead.
    sessionKey = undefined;
  }
}

function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(
    sanitizeMessage(error instanceof Error ? error.message : fallback),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run (or resume) the open for a position row the route just created.
 * The route has already run the FULL admission surface (Rev2 item 34: R11
 * blacklist, membership, pool existence, R8 cardinality, liquidity, TWAP);
 * this function re-checks only what must be fresh at submit time.
 */
export async function runLpOpen(
  deps: LpSagaDeps,
  input: LpOpenInput,
): Promise<LpOpenResult> {
  const owner = deps.agent.ownerAddress;
  const agentId = deps.agent.id;
  const nowSec = (): number => Math.floor(deps.now() / 1000);
  const deadlineSec = deps.deadlineSec ?? DEFAULT_TRADE_DEADLINE_SEC;

  const position = await deps.store.getPosition(owner, agentId, input.positionId);
  if (position === null) throw new LpPositionNotFoundError(input.positionId);

  /* ----- resume or create -------------------------------------------------- */

  let sequence = await deps.store.getNonTerminalSequence(
    owner,
    agentId,
    input.positionId,
  );
  // PHASE3.16 R2.4: the guard reads the INPUT kind rather than a literal. It
  // still does real work — `sequence.kind` comes from the store — and it is
  // what refuses an arm resumed under an open input, and vice versa.
  if (sequence !== null && sequence.kind !== input.kind) {
    return {
      sequenceId: sequence.sequenceId,
      kind: sequence.kind,
      status: "held",
      code: "SEQUENCE_CONFLICT",
      reason: `Position already has a non-terminal ${sequence.kind} sequence.`,
      confirmedSteps: 0,
    };
  }
  if (sequence === null && position.tokenId !== null) {
    // Nothing in flight and the mint already confirmed: idempotent success.
    return {
      sequenceId: "",
      kind: input.kind,
      status: "completed",
      code: "COMPLETED",
      reason: "Position is already open.",
      confirmedSteps: 1,
      tokenId: position.tokenId,
    };
  }
  if (sequence === null) {
    sequence = await deps.store.createSequence({
      agentId,
      ownerAddress: owner,
      positionId: input.positionId,
      kind: input.kind,
    });
  }
  const sequenceId = sequence.sequenceId;

  // Reservation BEFORE any money (Rev2 item 11/13). An open is never
  // quota-bound, so this records the gas-drawing sequence and cannot throw
  // on quota; rotate/harvest pay for the accounting it writes.
  await deps.store.reserveSequence(owner, agentId, sequenceId, deps.quota);

  /** Did THIS run reach a relay? (PHASE3.5 Rev2 M2 — the stale-evidence guard.) */
  let submittedThisRun = false;

  /**
   * PHASE3.5 Rev2 M4. `runLpOpen` writes its own reservation above and sets its
   * own sequence terminal here, never entering `driveSequence` — so without
   * this its nine pre-submit refusal classes would each hold a quota slot for
   * 24 hours having spent nothing.
   *
   * And there is no later sweep to lean on: a terminal sequence never
   * re-enters a drive (the resume queue excludes it, and a fresh drive on the
   * position creates a NEW sequence), so a release missed at the transition is
   * missed until the window ages the row out.
   *
   * Same predicate as the saga's, same failure tolerance: derived state that
   * explains and never decides.
   */
  const releaseReservationIfUnspent = async (): Promise<void> => {
    try {
      if (submittedThisRun) return;
      const current = await deps.store.getSequence(owner, agentId, sequenceId);
      // AUDIT A5: a vanished row HOLDS. Practically unreachable —
      // `setSequenceState` succeeded on this same row one line up — but every
      // other missing-evidence branch in this phase holds, and a uniform
      // posture is worth one line.
      if (current === null) return;
      const steps = current.steps;
      const fresh = new Map<string, JournalEntry | null>();
      for (const step of steps) {
        fresh.set(
          step.journalIdempotencyKey,
          await deps.journal.get(step.journalIdempotencyKey),
        );
      }
      if (!lpReservationReleasable(fresh, steps)) return;
      await deps.store.releaseReservation(owner, agentId, sequenceId);
    } catch {
      /* derived: a failed release costs one stale row, never the open */
    }
  };

  /**
   * PHASE3.17 R2.3 — every row of this arm's GROUP, resolved FROM THE ROW.
   *
   * The sibling comes from `arm_group_id` on the position record and NEVER from
   * the input, because the three paths that must close or update both rows —
   * the worker's resume (which passes only `positionId` and the `budgetWei: 0n`
   * sentinel), `rollBack` (which runs on all six refusal classes, including
   * from that resume) and the abandon route (which resolves one position from
   * one sequence) — never see a request. An input-only pairing is unreachable
   * from exactly the paths that break without one.
   *
   * A single arm, an open and an import all carry `armGroupId: null`, so this
   * answers `[positionId]` for every pre-3.17 row and the single-level path
   * behaves byte-identically.
   */
  const groupPositionIds = async (): Promise<readonly string[]> => {
    const self = await deps.store.getPosition(owner, agentId, input.positionId);
    const groupId = self?.armGroupId ?? null;
    if (groupId === null) return [input.positionId];
    const all = await deps.store.listPositions(owner, agentId);
    const members = all
      .filter((row) => row.armGroupId === groupId)
      .map((row) => row.positionId);
    return members.includes(input.positionId) ? members : [...members, input.positionId];
  };

  const rollBack = async (
    code: LpSagaRunResult["code"],
    reason: string,
  ): Promise<LpOpenResult> => {
    await deps.store.setSequenceState(owner, agentId, sequenceId, "rolled-back");
    await releaseReservationIfUnspent();
    // An aborted open closes the never-funded lineage so the row cannot be
    // mistaken for a live position (R7: closing resets the basis). PHASE3.17:
    // EVERY row of the group, or the sibling is stranded `open` with a null
    // tokenId — invisible to the worker, unreachable by any exit, and enough to
    // make the arm's own idle gate refuse every future re-arm for ever (B1).
    for (const positionId of await groupPositionIds()) {
      const fresh = await deps.store.getPosition(owner, agentId, positionId);
      if (fresh !== null && fresh.state !== "closed") {
        await deps.store.setPositionState(owner, agentId, positionId, "closed");
      }
    }
    return {
      sequenceId,
      kind: input.kind,
      status: "rolled-back",
      code,
      reason: sanitizeMessage(reason),
      confirmedSteps: 0,
    };
  };

  const hold = (
    code: LpSagaRunResult["code"],
    reason: string,
    confirmedSteps: number,
  ): LpOpenResult => ({
    sequenceId,
    kind: input.kind,
    status: "held",
    code,
    reason: sanitizeMessage(reason),
    confirmedSteps,
  });

  /**
   * PHASE3.19 C6 — SEED THE LADDER'S VWAP BOOK from the arm's OWN CONFIRMED
   * SWAP RECEIPT.
   *
   * WHY IT IS NEEDED AT ALL: the arm's swap creates `~budget/2` of idle BASE
   * before any motion runs, and the book advances "only from confirmed
   * receipts". Without a seed the FIRST hedge would try to deduct more base than
   * the book holds — and although D1's write-time clamp makes that SAFE rather
   * than negative, an unseeded book reports NO acquired inventory, so the markout
   * gate refuses every hedge for ever and the mode's own restorer never fires.
   *
   * WHY A SEED AND NOT THE CLAMP ALONE (C6 chose BOTH, and this is the first
   * half): seeding from the swap receipt gives an ACCURATE acquisition cost from
   * day one — `amountIn` WBNB for `amountOut` base, both from the confirmed log,
   * nothing estimated. The clamp is the second half and lives in the store.
   *
   * IDEMPOTENT BY THE SAME MECHANISM AS EVERY OTHER CREDIT: keyed on the arm
   * step's own journal idempotency key, which is read back from the recorded
   * step row on the resume path and is the live key otherwise. `runLpOpen`'s
   * `finish` runs on BOTH paths, so a resumed arm seeds exactly once.
   *
   * DERIVED-STATE POSTURE IS DELIBERATELY *NOT* TAKEN HERE: a failure THROWS and
   * `finish`'s caller turns it into a `POST_VERIFY_FAILED` hold, because the
   * book is an input to a money decision (D4). The one thing swallowed is a
   * receipt that carries NO swap at all, which is not a ladder arm's receipt.
   */
  const seedLadderBook = async (
    txHash: Hex,
    applicationKey: string,
  ): Promise<void> => {
    if (input.mode !== "grid-arm-ladder") return;
    const swap = await deps.receipts.swapAmounts(txHash);
    if (swap.amountOutWei <= 0n) return;
    await deps.store.applyInventoryCredit(owner, agentId, {
      applicationKey,
      // The BUY row is created FIRST and is therefore the group's book ANCHOR
      // (C4); the sibling's columns stay null for ever.
      positionId: input.positionId,
      armGroupId: position.armGroupId,
      deltaBaseWei: swap.amountOutWei,
      deltaCostWbnbWei: swap.amountInWei,
    });
  };

  /** Bookkeeping shared by the live path and the resume replay. */
  const finish = async (
    txHash: Hex | undefined,
    applicationKey: string,
  ): Promise<LpOpenResult> => {
    if (txHash === undefined) {
      // A committed row with no txHash cannot yield a tokenId; hold for an
      // operator rather than inventing one.
      return hold(
        "POST_VERIFY_FAILED",
        "The open confirmed but no transaction hash was recorded; the tokenId cannot be derived.",
        1,
      );
    }
    // PHASE3.17 LIVE FIX (2026-08-27, first dual arm on mainnet): the DUAL
    // dispatch is decided by the ROW, never by `input.mode`. The worker's
    // resume passes `mode: "grid-arm"` BY DESIGN (C7's sentinel is what keeps
    // an arm un-re-drivable), so a dual arm that completes THROUGH THE RESUME
    // — the normal path whenever the relay publishes its receipt after
    // `awaitExecution`'s deadline, observed on BOTH live arms so far — used to
    // reach the single-arm branch below, where `mintedTokenId` refused the
    // two-mint receipt ("expected exactly one NFPM mint Transfer; found 2")
    // and the rows were left `open` with null tokenIds. Review B1's rule
    // ("the paths that must pair both rows never see the request") governs
    // this seam exactly as it governs `rollBack` and the abandon route; the
    // Revision 2/3 disposition table named `finish` but not this dispatch,
    // which is how it survived the offline chain.
    const group = await groupPositionIds();
    if (group.length === 2) {
      const rowSibling = group.find((id) => id !== input.positionId);
      if (rowSibling !== undefined) return finishDual(txHash, rowSibling, applicationKey);
    }
    if (group.length > 2) {
      return hold(
        "POST_VERIFY_FAILED",
        "More than two position rows share this arm group; the pairing is ambiguous and the rows are held rather than paired by guess.",
        1,
      );
    }
    if (
      input.mode === "grid-arm-dual"
      || input.mode === "grid-arm-ladder"
      // PHASE3.22 R5 — the SHIFT arm joins on the identical reasoning, and this
      // seam is one of the two in this file that `tsc` does NOT police: adding
      // the variant to the union above compiled clean while silently routing a
      // shift arm's two-mint receipt into the single-mint read below, which is
      // GUARANTEED to refuse it. That is the R2.18 silent-inheritance hazard,
      // caught here rather than on a chain.
      || input.mode === "grid-arm-shift"
    ) {
      // Belt for a state the route cannot create (a two-row input whose rows
      // lost their durable pairing): still dispatch the two-mint finish — the
      // single-mint read below is GUARANTEED to refuse a two-mint receipt, so
      // falling through could never be right. PHASE3.19 joins this branch
      // because a ladder arm is a two-row arm in every respect (item 37), and
      // PHASE3.22 joins it because a shift arm is the ladder arm.
      return finishDual(txHash, input.siblingPositionId, applicationKey);
    }
    const mintedTokenId = await deps.receipts.mintedTokenId(txHash);
    const snapshot = await deps.positions(mintedTokenId);
    if (snapshot === "burned" || snapshot.liquidity <= 0n) {
      return hold(
        "POST_VERIFY_FAILED",
        "The mint confirmed but the new position reports no liquidity.",
        1,
      );
    }
    await deps.store.updatePositionTokenId(
      owner,
      agentId,
      input.positionId,
      mintedTokenId.toString(10),
    );
    await deps.store.setSequenceState(owner, agentId, sequenceId, "completed");
    return {
      sequenceId,
      kind: input.kind,
      status: "completed",
      code: "COMPLETED",
      reason: "Position opened.",
      confirmedSteps: 1,
      tokenId: mintedTokenId.toString(10),
    };
  };

  /**
   * PHASE3.17 C11 (review2 N11) — VERIFY BOTH MINTS BEFORE WRITING EITHER
   * tokenId.
   *
   * `finish` already held `POST_VERIFY_FAILED` on a zero-liquidity snapshot, and
   * with two rows that hold could land BETWEEN the two writes for reasons that
   * are not a crash — leaving one funded row and one phantom, with the sequence
   * non-terminal and the phantom invisible to every surface. So both snapshots
   * are read and judged first, and only then are both ids written.
   *
   * IDEMPOTENT PER ROW, on EVERY path (C11, and review M2 for the crash case):
   * the resume replay re-derives BOTH ids from the SAME receipt and re-applies
   * both writes, and a re-applied IDENTICAL tokenId must not trip
   * `lp_positions_one_live_token_idx` — so a row that already holds the id it is
   * about to be given is skipped rather than re-written.
   *
   * THE PAIRING IS POSITIONAL AND THE ORDER IS PINNED (R3.4): mint#1 is the
   * SELL rung (level 2's row, reached through `arm_group_id`) and mint#2 is the
   * BUY rung (level 1, `input.positionId`, the row the sequence names). EVM log
   * order is execution order, so the ids arrive in plan order — and NFPM
   * `_nextId` is monotonic, so `sellTokenId < buyTokenId` by construction. That
   * assert is the belt (review L1): it makes the pairing stop depending on a
   * reader contract nobody restates.
   *
   * The sequence goes terminal ONLY after both writes.
   */
  const finishDual = async (
    txHash: Hex,
    siblingId: string,
    applicationKey: string,
  ): Promise<LpOpenResult> => {
    const readIds = deps.receipts.mintedTokenIds;
    if (readIds === undefined) {
      return hold(
        "POST_VERIFY_FAILED",
        "The dual arm confirmed but this deployment's receipt reader cannot report two minted tokenIds; the rows are held rather than paired by guess.",
        1,
      );
    }
    const ids = await readIds.call(deps.receipts, txHash);
    const sellTokenId = ids[0];
    const buyTokenId = ids[1];
    if (ids.length !== 2 || sellTokenId === undefined || buyTokenId === undefined) {
      return hold(
        "POST_VERIFY_FAILED",
        "The dual arm's receipt did not carry exactly two NFPM mints; the rows are held rather than paired by guess.",
        1,
      );
    }
    if (!(sellTokenId < buyTokenId)) {
      // L1's belt. NFPM `_nextId` is monotonic and the SELL mint is first in the
      // pinned batch, so this can only fire if the plan's call order and this
      // pairing have drifted apart — which is the one way the two rows could be
      // given each other's NFT.
      return hold(
        "POST_VERIFY_FAILED",
        "The dual arm's two minted tokenIds are not in the pinned mint order (sell then buy); the rows are held rather than paired against a monotonic id that disagrees.",
        1,
      );
    }
    // VERIFY BOTH, then write both.
    for (const tokenId of [sellTokenId, buyTokenId]) {
      const snapshot = await deps.positions(tokenId);
      if (snapshot === "burned" || snapshot.liquidity <= 0n) {
        return hold(
          "POST_VERIFY_FAILED",
          "The dual arm confirmed but one of the two new positions reports no liquidity.",
          1,
        );
      }
    }
    for (const [positionId, tokenId] of [
      [siblingId, sellTokenId],
      [input.positionId, buyTokenId],
    ] as const) {
      const current = await deps.store.getPosition(owner, agentId, positionId);
      // The idempotent re-apply: a replay that finds the id already written
      // leaves it alone, so the global one-live-token index never sees a second
      // claim on an NFT this very row already holds.
      if (current !== null && current.tokenId === tokenId.toString(10)) continue;
      await deps.store.updatePositionTokenId(
        owner, agentId, positionId, tokenId.toString(10),
      );
    }
    // PHASE3.19 C6 — seed the LADDER's book BEFORE the sequence goes terminal,
    // for the same reason both tokenIds are written before it does: a hold that
    // landed between the two would leave a completed arm with a book that never
    // learned what its own swap acquired, and no later path re-reads that
    // receipt. A throw here is a recoverable POST_VERIFY_FAILED.
    await seedLadderBook(txHash, applicationKey);
    await deps.store.setSequenceState(owner, agentId, sequenceId, "completed");
    return {
      sequenceId,
      kind: input.kind,
      status: "completed",
      code: "COMPLETED",
      reason: "Both grid levels opened.",
      confirmedSteps: 1,
      tokenId: buyTokenId.toString(10),
      siblingTokenId: sellTokenId.toString(10),
    };
  };

  /* ----- join recorded steps against journal outcomes (resume) ------------ */

  const resumed = await joinRecordedSteps(deps, sequence);
  if (resumed.disposition === "hold") {
    return hold("HELD_AMBIGUOUS", resumed.reason, resumed.confirmedSteps);
  }
  if (resumed.disposition === "finish") {
    // PHASE3.19 D2: the confirmed step's OWN journal idempotency key, read back
    // from the recorded row rather than recomputed — so the resumed book seed
    // presents exactly the key the live write would have used and applies at
    // most once across any number of resumes.
    return finish(resumed.txHash, resumed.journalIdempotencyKey);
  }
  // "fresh": every recorded step (if any) was ROLLED_BACK; its slot is open.

  /* ----- fresh drive -------------------------------------------------------- */

  if (deps.agent.status !== "armed") {
    return rollBack(
      "AGENT_NOT_ARMED",
      `Agent status is "${deps.agent.status}"; an open needs an armed agent.`,
    );
  }
  const current = await deps.currentSettingsDigest();
  if (current.toLowerCase() !== deps.settingsDigest.toLowerCase()) {
    return rollBack(
      "SETTINGS_DIGEST_MISMATCH",
      "Owner settings changed while the open was being armed.",
    );
  }
  // Strict — an open only INCREASES exposure, so pause blocks it (Rev2 item 16).
  const decision = await authorizeExecute({
    agent: deps.agent,
    killswitch: deps.killswitch,
    now: nowSec(),
    reducesExposure: false,
  });
  if (!decision.allowed) return rollBack(decision.code, decision.reason);
  const facts = deps.agent.sessionFacts;
  if (facts === null) return rollBack("NO_SESSION", "Agent has no granted session.");

  // Rails on FRESH evidence, immediately before the build (item 34's surface
  // ran at the route; prices may have moved since).
  const market = await deps.market();
  const railFailure = checkManipulationRails(market, deps.rails);
  if (railFailure !== undefined) {
    return rollBack(railFailure.code, railFailure.reason);
  }

  /* ----- build the one atomic batch ---------------------------------------- */

  let calls: readonly WalletCall[];
  try {
    calls = await buildLpOpenPlan({
      // PHASE3.16 R2.4: the mode is CARRIED, never derived from the range.
      mode: input.mode,
      walletAddress: deps.agent.walletAddress, token0: position.token0, token1: position.token1,
      fee: position.fee, wbnb: deps.venue.wbnb, nfpm: deps.venue.nfpm, routerV3: deps.venue.routerV3,
      budgetWei: input.budgetWei, tickLower: input.tickLower, tickUpper: input.tickUpper,
      currentTick: market.currentTick, spotSqrtPriceX96: market.spotSqrtPriceX96,
      deadline: BigInt(nowSec() + deadlineSec), rails: deps.rails, quote: deps.quote,
      // PHASE3.17 — present only on the dual branch, which is the only plan
      // that reads them. The two-sided and single-arm plans are unchanged.
      ...(input.mode === "grid-arm-dual"
        ? {
            sellTickLower: input.sellTickLower,
            sellTickUpper: input.sellTickUpper,
            tickSpacing: input.tickSpacing,
            ...(deps.quoteWithPriceAfter === undefined
              ? {}
              : { quoteWithPriceAfter: deps.quoteWithPriceAfter }),
          }
        : {}),
      // PHASE3.19 — present only on the LADDER branch, which is the only plan
      // that reads them. Every other plan is unchanged.
      ...(input.mode === "grid-arm-ladder"
        ? {
            sellTickLower: input.sellTickLower,
            sellTickUpper: input.sellTickUpper,
            tickSpacing: input.tickSpacing,
            deployPctBps: input.deployPctBps,
            ...(deps.quoteWithPriceAfter === undefined
              ? {}
              : { quoteWithPriceAfter: deps.quoteWithPriceAfter }),
          }
        : {}),
      // PHASE3.22 R5 — the SHIFT branch, carrying the IDENTICAL four fields,
      // because it delegates to the identical builder. This is the SECOND of
      // the two seams in this file that `tsc` does not police: without it the
      // shift arm's plan would be built with no sell rung, no spacing and no
      // `deployPctBps`, and `buildGridArmLadderPlan` would refuse before any
      // money — fail-closed, but for the wrong reason and with a message about
      // a field the caller thought it had supplied.
      //
      // Written as its OWN arm rather than folded into the ladder's condition
      // with a `||`: the two modes are the same plan TODAY, and the day one of
      // them gains a field is the day a shared condition becomes a silent
      // mis-supply. Separate arms make that a visible edit.
      ...(input.mode === "grid-arm-shift"
        ? {
            sellTickLower: input.sellTickLower,
            sellTickUpper: input.sellTickUpper,
            tickSpacing: input.tickSpacing,
            deployPctBps: input.deployPctBps,
            ...(deps.quoteWithPriceAfter === undefined
              ? {}
              : { quoteWithPriceAfter: deps.quoteWithPriceAfter }),
          }
        : {}),
    });
  } catch (error) {
    return rollBack("BUILD_REFUSED", messageOf(error));
  }

  const callsHash = hashCalls(calls);
  const finalCalls = fingerprintLpFinalCallsV1(calls);
  const nativeSpendWei = calls.reduce(
    (total, call) => total + (call.value ?? 0n),
    0n,
  );
  const decisionId = lpStepDecisionId(sequenceId, sequence.steps.length);
  const key = executeIdempotencyKey(agentId, decisionId, callsHash);

  await deps.store.appendStep(owner, agentId, sequenceId, {
    kind: "zap-in-mint",
    journalIdempotencyKey: key,
  });

  const { otherSpendWei, created } = await deps.journal.beginWithSpend(
    {
      idempotencyKey: key,
      agentId,
      ownerAddress: owner,
      kind: "lp",
      decisionId,
      externalRef: { callsHash, publicKey: facts.publicKey },
      nativeSpendWei,
      begunAtBlock: market.blockNumber,
      finalCallsFingerprint: finalCalls.canonical,
      finalCallsFingerprintHash: finalCalls.hash,
    },
    deps.now() - DAILY_WINDOW_MS,
  );
  if (!created) {
    return hold(
      "HELD_AMBIGUOUS",
      "The step's idempotency key already has a journal row; holding rather than resubmitting.",
      0,
    );
  }
  if (exceedsDailyCap(deps.agent.caps, otherSpendWei, nativeSpendWei)) {
    await deps.journal.markRolledBack(key, "Refused before submit: DAILY_CAP.");
    return rollBack("DAILY_CAP", "The open would exceed the off-chain daily native cap.");
  }

  // Late kill-switch re-check, immediately before submit (mirrors /trade).
  const late = await authorizeExecute({
    agent: deps.agent,
    killswitch: deps.killswitch,
    now: nowSec(),
    reducesExposure: false,
  });
  if (!late.allowed) {
    await deps.journal.markRolledBack(
      key,
      sanitizeMessage(`Refused before submit: ${late.code}.`),
    );
    return rollBack(late.code, late.reason);
  }

  // (5a) EVERYTHING BEFORE THE SUBMIT (PHASE2.4 R3): a throw here provably
  // never reached a relay; the row and the sequence roll back.
  let session: SessionRef;
  try {
    session = await withSessionKey(deps.agentStore, deps.agent, async (authority) =>
      deps.provider.restoreSession({
        spec: facts.spec,
        agent: authority,
        walletAddress: deps.agent.walletAddress,
        publicKey: facts.publicKey,
        expiresAt: facts.expiry,
      }),
    );
    await deps.provider.preflightExecute({ session, calls });
  } catch (error) {
    const refusal = asPlaneError(error, "lp open refused");
    await deps.journal.markRolledBack(
      key,
      sanitizeMessage(`Refused before submission: ${refusal.code}.`),
    );
    return rollBack("STEP_REFUSED", `${refusal.code}: ${refusal.message}`);
  }

  // (5b) THE SUBMIT. From here on, ambiguity is the rule.
  let receipt: ExecutionReceipt;
  try {
    const submitPreparedLp = deps.provider.submitPreparedLp;
    if (submitPreparedLp === undefined) {
      throw new ProviderError("Wallet provider lacks the mandatory staged LP capability.");
    }
    receipt = await withSessionKey(
      deps.agentStore,
      deps.agent,
      async (authority, sessionPrivateKey) => {
        const restored = deps.provider.restoreSession({
          spec: facts.spec,
          agent: authority,
          walletAddress: deps.agent.walletAddress,
          publicKey: facts.publicKey,
          expiresAt: facts.expiry,
        });
        return submitPreparedLp.call(deps.provider, {
          journalIdempotencyKey: key,
          expectedBindingVersion: 0,
          sessionPrivateKey,
          walletAddress: deps.agent.walletAddress,
          persistedSession: facts,
          restoredSessionPublicKey: restored.publicKey,
          restoredSessionExpiry: facts.expiry,
          calls,
          expectedExecutionDataHash: finalCalls.value.executionDataHash,
          bind: async (request) => {
            const bound = await deps.journal.bindPreparedIntent(key, {
              canonicalIdentity: request.canonicalIdentity,
              identityHash: request.identityHash,
              expectedBindingVersion: request.expectedBindingVersion,
            });
            return { ...request, boundBindingVersion: bound.boundBindingVersion };
          },
        });
      },
    );
  } catch (error) {
    if (isProvenPreBindStagedLpError(error)) {
      // Keep the underlying cause: the family name alone is not diagnosable.
      // See the matching site in `sagas.ts`, including why the `instanceof`
      // ternary is required rather than dead (FIXREVIEW7 F9).
      await deps.journal.markRolledBack(
        key,
        sanitizeMessage(
          `Refused before submission: STAGED_PRE_BIND. ${
            error instanceof Error ? error.message : "cause unavailable"
          }`,
        ),
      );
      return rollBack(
        "STEP_REFUSED",
        "The staged LP submit was refused before its durable prepared-intent bind.",
      );
    }
    const mapped = asPlaneError(error, "lp open failed");
    await deps.journal.markUnknown(key, sanitizeMessage(mapped.message));
    return hold(
      "HELD_AMBIGUOUS",
      "Submission outcome is unknown and is held for reconciliation; ambiguity never auto-replays.",
      0,
    );
  }

  // AUDIT A4. The flag is set for ANY receipt, not only one carrying a
  // `callsId`: getting an answer back from `executeViaSession` IS the
  // submission window, and a provider that returns FAILED without a batch id
  // would otherwise roll its row back bare — which
  // `lpReservationReleasable` reads as never-submitted, freeing the slot and
  // voiding the upper bound `checkLpNativeCapSizing` leans on. The shipped
  // Altana provider always sets `callsId`, so this is dead code today; the
  // `WalletProvider` seam exists to admit a second one.
  submittedThisRun = true;
  if (receipt.callsId !== undefined) {
    await deps.journal.markInProgress(key, { callsId: receipt.callsId });
  }
  if (receipt.status === "FAILED") {
    await deps.journal.markRolledBack(
      key,
      sanitizeMessage(receipt.failureCode ?? "LP open reported FAILED."),
    );
    return rollBack(
      "STEP_REFUSED",
      `Execution reported FAILED (${receipt.failureCode ?? "PROVIDER_ERROR"}).`,
    );
  }
  if (receipt.status !== "CONFIRMED") {
    return hold(
      "HELD_AMBIGUOUS",
      "Submission is pending; held until reconcile resolves the step row.",
      0,
    );
  }
  await deps.journal.markCommitted(
    key,
    receipt.transactionHash === undefined
      ? {}
      : { txHash: receipt.transactionHash },
  );
  try {
    return await finish(receipt.transactionHash, key);
  } catch (error) {
    return hold("POST_VERIFY_FAILED", messageOf(error), 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

type JoinOutcome =
  | { readonly disposition: "fresh" }
  | { readonly disposition: "hold"; readonly reason: string; readonly confirmedSteps: number }
  | {
      readonly disposition: "finish";
      readonly txHash: Hex | undefined;
      /** PHASE3.19 D2 — the confirmed step's own key, for the book seed. */
      readonly journalIdempotencyKey: string;
    };

/**
 * Join the sequence's recorded steps against journal outcomes, with the same
 * driver decisions the landed sagas make: a ROLLED_BACK step provably never
 * reached a relay, so its slot is open — and so is a recorded step whose
 * journal row DOES NOT EXIST (audit A1): `appendStep` precedes
 * `beginWithSpend` and `beginWithSpend` precedes the submit, so a missing row
 * can only mean a crash in that window and nothing reached a relay under its
 * key. Only a row that EXISTS and is non-terminal holds (its submit window is
 * genuinely ambiguous until `reconcile` resolves it); a COMMITTED step means
 * the open landed and only the bookkeeping is owed.
 */
async function joinRecordedSteps(
  deps: LpSagaDeps,
  sequence: LpSequenceRecord,
): Promise<JoinOutcome> {
  if (sequence.steps.length === 0) return { disposition: "fresh" };
  const rows = new Map<string, JournalEntry | null>();
  for (const step of sequence.steps) {
    rows.set(
      step.journalIdempotencyKey,
      await deps.journal.get(step.journalIdempotencyKey),
    );
  }
  const outcomes = new Map<string, LpStepOutcomeState>();
  for (const [stepKey, row] of rows) {
    if (row !== null) outcomes.set(stepKey, row.state);
  }
  const liveSteps = sequence.steps.filter((step) => {
    const row = rows.get(step.journalIdempotencyKey);
    return row !== null && row !== undefined && row.state !== "ROLLED_BACK";
  });
  if (liveSteps.length === 0) return { disposition: "fresh" };
  const progress = deriveLpSequenceProgress({ steps: liveSteps }, outcomes);
  if (progress.disposition !== "advance") {
    return {
      disposition: "hold",
      reason: progress.reason,
      confirmedSteps: progress.confirmedSteps,
    };
  }
  const confirmed = liveSteps[liveSteps.length - 1];
  const row = confirmed === undefined ? null : rows.get(confirmed.journalIdempotencyKey) ?? null;
  return {
    disposition: "finish",
    txHash: row?.externalRef.txHash,
    journalIdempotencyKey: confirmed?.journalIdempotencyKey ?? "",
  };
}

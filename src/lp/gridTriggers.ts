/**
 * PHASE3.15 — the two-range grid ping-pong's PURE layer: the side rule, the
 * G-gates, the durable cross hysteresis, the evaluator, and the ONE builder for
 * every sentence a flip speaks with.
 *
 * PURE AND OFFLINE, exactly like `src/lp/triggers.ts`: no I/O, no clock reads,
 * no chain. The caller injects finalized observations and the signed settings.
 *
 * ─── WHAT THIS MODULE IS FOR ───────────────────────────────────────────────
 *
 * A grid agent holds ONE NFPM position, which IS the live grid level. It sits
 * single-sided on one of two owner-signed ranges. When the pool trades THROUGH
 * that range and stays beyond it, the inventory has changed asset — a fill —
 * and the agent settles the level and re-mints the freed principal
 * single-sided into the OPPOSITE signed range. That is the whole strategy:
 * one buy level, one sell level, and the fill → opposite-order lifecycle.
 *
 * ─── PHASE3.19: A THIRD MODE, AND THE INVARIANT IT SCOPES (L1) ─────────────
 *
 * That description is `fixed` mode, and `policy` mode adds only the drift
 * requote to it. `ladder` mode is a DIFFERENT strategy on the same machinery:
 * both rungs re-anchor near the price — on a FILL and on a DRIFT alike, through
 * ONE saga and ONE quota lane — and the capital that funds them is an IDLE
 * BUFFER in the owner's own EOA rather than the rungs themselves.
 *
 * THE HEADLINE INVARIANT IS THEREFORE SCOPED, ONCE, HERE. "A grid never swaps
 * to rebalance" remains true VERBATIM for `fixed` and `policy` — their sweep
 * steps still skip by design and no shipped test moves. Ladder mode replaces it
 * with: **a ladder swaps only to HEDGE filled inventory, sized to the imbalance,
 * and only at protected profit against its own durable VWAP book.** A hedge that
 * is not profitable simply waits, and the ladder keeps quoting from whatever
 * idle remains — which is the HawkFi behaviour, measured.
 *
 * ─── GEOMETRY, IN POOL ORDER, AND WHY IT IS NOT A ROLE NAME (R2.2 / OQ1) ───
 *
 * ```text
 * A V3 range strictly ABOVE the tick charges token0 only.   (fence.ts:363-378)
 * A V3 range at or BELOW the tick charges token1 only.
 * ```
 *
 * So "which asset does this range hold?" is answered by the SIDE plus the pool
 * ORDER, never by the words buy/sell. `wbnbIsToken0 === true` puts the quote on
 * token0, so a range holds quote exactly when its side is `"above"`; with
 * `wbnbIsToken0 === false` it is the mirror. Writing a side rule in role order
 * inverts it for roughly half of BSC's WBNB pools — the 3.13 F7 finding, which
 * the first draft of this phase's own §1 reproduced (review H1). Every
 * comparison below is therefore in pool order, and every side-dependent
 * behaviour is tested in BOTH orderings.
 *
 * ─── THE G-GATES USE `swaplessRotationSide`, NOT `swapSplitIsTotal` (OQ2) ──
 *
 * `swapSplitIsTotal` is the STRICT INTERIOR — at `t === tickLower` it answers
 * "the split is total" while `getMintAmountsForLiquidity` still charges BOTH
 * legs, because the pool's `sqrtPrice` there is generally strictly above
 * `getSqrtRatioAtTick(tickLower)`. A gate that read it as "safe, single-sided"
 * would mint a two-sided position with a one-sided principal: the 3.13 F4
 * failure. `swaplessRotationSide`'s bounds (`< lower`, `>= upper`) are exactly
 * the two conditions under which the mint charges a single leg, and it answers
 * `undefined` inside, which is the refusal the grid wants.
 *
 * It is called with the TARGET range through the `prior*`-named fields
 * (`fence.ts` is frozen — no edit, not even an export addition), and the
 * resulting gate is DELIBERATELY STRICTER than the rotate's own mint bind:
 * at `t === tickLower` the grid REFUSES where the rotate admits. That
 * divergence is intentional and in the safe direction (C9); it must not be
 * "unified" toward the rotate later.
 */
import {
  SWAPLESS_MAX_RESIDUE_BPS,
  swaplessRotationSide,
  type SwaplessRotationSide,
} from "./fence.js";
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from "./tickMath.js";
import { priceDeviationBps, checkManipulationRails, spotSwapOutput } from "./rails.js";
// PHASE3.18: the requote's target runs the SAME derivation the arm's client
// used, from the leaf module it now lives in (see the re-export below).
import { gridDeriveRanges } from "./gridGeometry.js";
// PHASE3.22 N6/R3.4 — the CYCLE constant, not the sizing one. The two are
// defined side by side in `policy.ts` precisely so this import cannot pick the
// wrong one by habit.
import {
  MAX_SUBMISSIONS_PER_GRID_SHIFT,
  MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE,
} from "../ops/policy.js";
import {
  evaluateLpProtectSignal,
  gridModeOf,
  ladderMotionCounts,
  ladderStrandedMinutes,
  lpObservationComparability,
  type EvaluateLpTriggersInput,
  type EvaluateLpTriggersResult,
  type LpAutomationSettings,
  type LpGridLadder,
  type LpGridLevelValue,
  type LpGridMode,
  type LpGridPolicy,
  type LpGridRange,
  type LpGridShift,
  type LpGridRoleValue,
  type LpGridSettings,
  type LpManagementDecision,
  type LpTriggerObservation,
  type LpTriggerPositionInput,
  type LpTriggerReason,
} from "./triggers.js";

/* -------------------------------------------------------------------------- */
/* The side rule                                                              */
/* -------------------------------------------------------------------------- */

/** Which signed level the live position IS. */
export type LpGridRole = "buy" | "sell";

/**
 * PHASE3.17 — WHICH of a dual grid's two levels a position belongs to.
 *
 * `1` is the pair `(buyRange, sellRange)`, `2` the pair
 * `(buyRange2, sellRange2)`. A single-level 3.15/3.16 grid only ever answers
 * `1`, so every existing behaviour is unchanged.
 */
export type LpGridLevel = 1 | 2;

/** A level's own pair of signed ranges — the ONE argument a per-pair check takes. */
export type LpGridPair = {
  readonly level: LpGridLevel;
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
};

/** Which signed range a live position IS, and which level's pair owns it. */
export type LpGridRoleAt = {
  readonly level: LpGridLevel;
  readonly role: LpGridRole;
};

/**
 * PHASE3.17 R2.1 — the SPLIT, as a CONSTANT and never a signed field.
 *
 * 50/50: the sell share is swapped to the base token, the buy share stays
 * quote. The operator's product ruling stands — split presets are HawkFi's
 * model rather than a CEX's, and a free ratio is a portfolio decision wearing a
 * bot costume, so it is not a wire field, not a preset and not a UI choice.
 */
export const GRID_DUAL_SPLIT_BPS = 5_000;

/** The native wei a dual arm swaps into the base token. `budgetWei/2` at 50/50. */
export function gridDualSwapInWei(budgetWei: bigint): bigint {
  return (budgetWei * BigInt(GRID_DUAL_SPLIT_BPS)) / 10_000n;
}

/**
 * A level's own pair. `null` when level 2 is asked of a single-level grid —
 * fail-closed, because inventing pair 1's ranges for level 2 is exactly the
 * defect review2 N2 found (pricing level 2's admission on level 1's spread).
 */
export function gridPair(grid: LpGridSettings, level: LpGridLevel): LpGridPair | null {
  if (level === 1) {
    return { level: 1, buyRange: grid.buyRange, sellRange: grid.sellRange };
  }
  const buyRange = grid.buyRange2;
  const sellRange = grid.sellRange2;
  if (buyRange === undefined || sellRange === undefined) return null;
  return { level: 2, buyRange, sellRange };
}

/** Both pairs of a dual grid, or pair 1 alone. Never invents a missing pair. */
export function gridPairs(grid: LpGridSettings): readonly LpGridPair[] {
  const two = gridPair(grid, 2);
  const one = gridPair(grid, 1);
  const pairs: LpGridPair[] = one === null ? [] : [one];
  if (two !== null) pairs.push(two);
  return pairs;
}

/** `true` when the signed grid carries level 2's pair. */
export function gridIsDual(grid: LpGridSettings): boolean {
  return gridPair(grid, 2) !== null;
}

/**
 * The `pair` argument {@link gridNetEdge} takes, carrying its LEVEL only when
 * the grid actually has two of them.
 *
 * ONE seam, because the alternative is the same conditional hand-written at
 * four call sites. A single-level grid has no second pair for its refusal to be
 * confused with, so naming "Pair 1" there would add a word an owner cannot act
 * on — and would change a sentence 3.15/3.16 already ship byte for byte.
 */
export function gridNetEdgePair(
  grid: LpGridSettings,
  level: LpGridLevel,
): {
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
  readonly level?: LpGridLevel;
} | null {
  const pair = gridPair(grid, level);
  if (pair === null) return null;
  return gridIsDual(grid)
    ? { buyRange: pair.buyRange, sellRange: pair.sellRange, level: pair.level }
    : { buyRange: pair.buyRange, sellRange: pair.sellRange };
}

/**
 * Does a range charge the QUOTE token on this side, in POOL ORDER?
 *
 * `"above"` charges token0, `"below"` charges token1. The quote is token0 when
 * `wbnbIsToken0`. One line, ONE place, because the alternative is the same
 * comparison hand-written at four seams — the drift class `swapSplitIsTotal`'s
 * own docstring is written about.
 */
export function gridSideChargesQuote(
  side: SwaplessRotationSide,
  wbnbIsToken0: boolean,
): boolean {
  return wbnbIsToken0 ? side === "above" : side === "below";
}

/**
 * THE ONE G-GATE HELPER (R2.3/OQ2). "Is the tick strictly OUTSIDE this range,
 * and on which side?" — asked of the TARGET range at G1 (the trigger) and again
 * at G2 (the mint's build), against a fresh read each time.
 *
 * `undefined` means the tick is INSIDE the target, where no single-sided mint
 * is legal. That is the whole refusal, and it is the reason `swapSplitIsTotal`
 * is not reused here.
 */
export function gridTargetSide(
  currentTick: number,
  target: LpGridRange,
): SwaplessRotationSide | undefined {
  return swaplessRotationSide({
    currentTick,
    // `fence.ts` names these for the ROTATE's prior range and is frozen (R2.9),
    // so the grid passes its TARGET through the same fields rather than adding
    // an export. Stated here so a future reader does not "fix" the naming.
    priorTickLower: target.tickLower,
    priorTickUpper: target.tickUpper,
  });
}

/**
 * Which signed range the live position IS, or `null` when it matches neither.
 *
 * `null` is reachable only through a re-sign that moved both ranges out from
 * under a live level — which C2's settings-route rule refuses — so it is a
 * fail-closed backstop, not an expected state. The evaluator HOLDS on it with a
 * reason that names the remedy rather than guessing at a target.
 */
export function gridLiveRole(
  grid: LpGridSettings,
  position: { readonly tickLower: number; readonly tickUpper: number },
): LpGridRoleAt | null {
  // PHASE3.17 R2.5 (review H3): rows carry NO ticks, so this exact-tick match
  // against the UP-TO-FOUR signed ranges is the SOLE assignment of role — and
  // of LEVEL — to a live position. A stored role column was refuted: a C2
  // re-sign would stale it, which is the same argument that made 3.15 match on
  // ticks in the first place.
  //
  // The four ranges are pairwise DISJOINT under the R2.1 chain (positive widths
  // + an ascending chain), so at most one arm below can match and the answer is
  // unambiguous at every reachable state. `null` stays the fail-closed backstop
  // for a re-sign that moved a range out from under a live level — the state
  // C2's multi-level rule (R3.1) exists to make unreachable.
  for (const pair of gridPairs(grid)) {
    if (
      pair.buyRange.tickLower === position.tickLower
      && pair.buyRange.tickUpper === position.tickUpper
    ) {
      return { level: pair.level, role: "buy" };
    }
    if (
      pair.sellRange.tickLower === position.tickLower
      && pair.sellRange.tickUpper === position.tickUpper
    ) {
      return { level: pair.level, role: "sell" };
    }
  }
  return null;
}

/**
 * The range a filled level flips INTO: the SAME LEVEL's other range.
 *
 * PHASE3.17 R2.5 — the level argument is what keeps a dual grid's two ladders
 * apart. Level 1 ping-pongs `buyRange` <-> `sellRange`; level 2 ping-pongs
 * `buyRange2` <-> `sellRange2`. A target taken from the wrong pair would put
 * two levels on one rung, which is precisely the B3 collapse the crossed-pair
 * geometry exists to prevent.
 *
 * Throws for level 2 of a single-level grid rather than falling back to pair 1:
 * a flip target is a money decision, and the fail-closed answer is a per-position
 * error the worker reports, never a guess.
 */
export function gridTargetRange(
  grid: LpGridSettings,
  level: LpGridLevel,
  role: LpGridRole,
): LpGridRange {
  const pair = gridPair(grid, level);
  if (pair === null) {
    throw new Error(
      `gridTargetRange: level ${level} has no signed pair on this grid; the flip has no defined target.`,
    );
  }
  return role === "buy" ? pair.sellRange : pair.buyRange;
}

/** What the cross evidence says about the live level, at ONE observation. */
export type LpGridCrossReading = {
  /** The side the live range charges NOW, or `undefined` while in range. */
  readonly side: SwaplessRotationSide | undefined;
  /**
   * `true` iff the tick is strictly beyond the level's FAR edge — i.e. the
   * range now charges the OTHER asset than the one the level was armed
   * holding. "Price touched the level" is never a fill, and a partially
   * converted range (tick inside) is never flipped.
   */
  readonly filled: boolean;
};

/**
 * FULL-CROSS EVIDENCE for one observation (§3.2), in pool order.
 *
 * A BUY level holds quote. It has filled when a side EXISTS (the tick is
 * strictly outside) and that side no longer charges the quote token — which is
 * exactly "the tick is beyond the far edge", because the armed state is the
 * other side. A SELL level is the mirror. Both fall out of one predicate, and
 * neither mentions "up" or "down", which is what keeps them correct in both
 * pool orderings.
 */
export function gridCrossReading(input: {
  readonly currentTick: number;
  readonly range: LpGridRange;
  readonly role: LpGridRole;
  readonly wbnbIsToken0: boolean;
}): LpGridCrossReading {
  const side = gridTargetSide(input.currentTick, input.range);
  if (side === undefined) return { side: undefined, filled: false };
  const chargesQuote = gridSideChargesQuote(side, input.wbnbIsToken0);
  return { side, filled: input.role === "buy" ? !chargesQuote : chargesQuote };
}

/* -------------------------------------------------------------------------- */
/* The net-edge admission (R2.10)                                             */
/* -------------------------------------------------------------------------- */

/** The geometric midpoint tick of a range. Integer, floored. */
export function gridRangeMidpointTick(range: LpGridRange): number {
  return Math.floor((range.tickLower + range.tickUpper) / 2);
}

export type LpGridNetEdge = {
  readonly grossEdgeBps: bigint;
  readonly costFloorBps: bigint;
  readonly minNetEdgeBps: bigint;
  readonly sizeWei: bigint;
  readonly relayFeePerSubmitWei: bigint;
  /** PHASE3.18: submissions the floor was priced on — 2 for a flip-only cycle. */
  readonly submissionsPerCycle: number;
  /**
   * PHASE3.17 C2: which of a dual grid's pairs this verdict is ABOUT, or `null`
   * for a single-pair grid whose refusal has no second pair to be confused
   * with. Carried so the refusal text can name it rather than leaving an owner
   * to guess which spread was priced.
   */
  readonly level: LpGridLevel | null;
  /** The pair the gross edge was measured across. Reported, never re-derived. */
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
  /**
   * PHASE3.19 item 27 — is this verdict about a LADDER? Set only by
   * {@link gridLadderEconomics}, and read only by {@link lpGridNetEdgeRefusal},
   * which owes a ladder one extra sentence of honest scope: re-anchoring is a
   * THIRD uncovered term beside adverse selection and slippage, and it is the
   * dominant one for this mode.
   */
  readonly ladder?: boolean;
  readonly ok: boolean;
};

/**
 * PHASE3.15 R2.10 (M9): the fee-aware net-edge admission, computed at IMPORT
 * time — the first moment a SIZE exists — and re-run on a re-sign under a live
 * level (C2).
 *
 * ```text
 * grossEdgeBps = priceDeviationBps(sqrt(mid(buyRange)), sqrt(mid(sellRange)))
 * costFloorBps = ceil( (2 × relayFeePerSubmitWei) × 10_000 / sizeWei )
 * require       grossEdgeBps >= costFloorBps + minNetEdgeBps
 * ```
 *
 * WHY `priceDeviationBps` AND NOT A SECOND SCALE: `rotationDeviationBps` and
 * `rangeWidthBps` are already measured on it, and PHASE3.13 F1's whole lesson
 * is that a floor and the quantity it floors must not be measured on different
 * scales. It is also orientation-neutral — the expression divides by the
 * smaller squared price, and inverting both prices maps smaller to larger — so
 * Case A and Case B produce the same bps.
 *
 * WHY TWO SUBMISSIONS: the flip plan is three positions of which the sweep
 * ALWAYS skips, so one flip is TWO relay submissions. The sizing reserve uses
 * THREE ({@link MAX_SUBMISSIONS_PER_GRID_FLIP} in `src/ops/policy.ts`) as
 * padding for a resubmission after a hold; the two numbers are deliberately
 * different and are stated side by side rather than reconciled.
 *
 * WHY IT ROUNDS UP (C6): bigint division truncates toward zero, which would
 * understate the floor by up to 1 bps — the wrong direction for a conservatism
 * check.
 *
 * THE HONEST-SCOPE SENTENCE IS MANDATORY (see {@link lpGridNetEdgeRefusal}):
 * this bounds RELAY GAS ONLY, at today's padded constant. It does not model
 * adverse selection — which a fully-crossed range order IS, by definition — or
 * slippage.
 */
export function gridNetEdge(input: {
  /**
   * PHASE3.17 C2 (review2 N2): an EXPLICIT PAIR, never the whole grid block.
   *
   * The old signature read `grid.buyRange`/`grid.sellRange` and nothing else,
   * so under four rungs level 2's admission would have been priced on level
   * 1's spread — at the arm AND at the re-sign guard. Nothing forces two
   * signed pairs to carry equal spreads (the client's even rung pitch is a
   * convenience, not an invariant), so a directly-signed envelope could give
   * pair 2 an arbitrarily narrow spread that pair 1's verdict waved through.
   * This is the one check standing between an owner and a level that loses
   * money on every cycle, so it takes the pair it is judging.
   */
  readonly pair: {
    readonly buyRange: LpGridRange;
    readonly sellRange: LpGridRange;
    readonly level?: LpGridLevel;
  };
  readonly minNetEdgeBps: number;
  readonly sizeWei: bigint;
  readonly relayFeePerSubmitWei: bigint;
  /**
   * PHASE3.18 R2.4 — how many relay submissions ONE CYCLE costs. Defaults to
   * `2` (the flip's real count), so every 3.15-3.17 call site and every
   * existing refusal sentence is BYTE-IDENTICAL.
   *
   * Policy mode passes {@link gridCycleSubmissions}' `2 + 2R`: a cycle that
   * includes up to `R` re-centres pays for them out of the SAME spread, and a
   * spread admitted on a flip-only floor would be quietly loss-making the
   * moment requotes are signed on.
   */
  readonly submissionsPerCycle?: number;
  /** PHASE3.19 item 27. Set by {@link gridLadderEconomics} and nothing else. */
  readonly ladder?: boolean;
}): LpGridNetEdge {
  const grossEdgeBps = priceDeviationBps(
    getSqrtRatioAtTick(gridRangeMidpointTick(input.pair.buyRange)),
    getSqrtRatioAtTick(gridRangeMidpointTick(input.pair.sellRange)),
  );
  const submissions = BigInt(input.submissionsPerCycle ?? 2);
  const numerator = submissions * input.relayFeePerSubmitWei * 10_000n;
  // A zero-value level can never clear any floor: fail closed rather than
  // dividing by zero.
  const costFloorBps =
    input.sizeWei <= 0n
      ? numerator
      : (numerator + input.sizeWei - 1n) / input.sizeWei;
  const minNetEdgeBps = BigInt(input.minNetEdgeBps);
  return {
    grossEdgeBps,
    costFloorBps,
    minNetEdgeBps,
    sizeWei: input.sizeWei,
    relayFeePerSubmitWei: input.relayFeePerSubmitWei,
    submissionsPerCycle: Number(submissions),
    level: input.pair.level ?? null,
    buyRange: input.pair.buyRange,
    sellRange: input.pair.sellRange,
    // PRESENT-ONLY-WHEN-SET, so every 3.15-3.18 verdict object is unchanged.
    ...(input.ladder === true ? { ladder: true } : {}),
    ok: grossEdgeBps >= costFloorBps + minNetEdgeBps,
  };
}

/**
 * The refusal, naming the numbers, the remedy and the honest scope.
 *
 * PHASE3.17 C2: when the verdict belongs to a NAMED pair of a dual grid the
 * text leads with that pair and its two rungs, because "the grid's spread" is
 * ambiguous the moment there are two of them. A single-pair grid passes no
 * level and the sentence is byte-identical to 3.15/3.16's.
 */
export function lpGridNetEdgeRefusal(edge: LpGridNetEdge, where: string): string {
  const pair =
    edge.level === null
      ? ""
      : `Pair ${edge.level} (buy [${edge.buyRange.tickLower}, ${edge.buyRange.tickUpper}), `
        + `sell [${edge.sellRange.tickLower}, ${edge.sellRange.tickUpper})): `;
  return (
    `${where}: ${pair}the grid's spread does not cover one flip's relay gas at this size. `
    + `Gross edge ${edge.grossEdgeBps} bps between the range midpoints, against a `
    + `${edge.costFloorBps} bps gas floor (${edge.submissionsPerCycle} submissions x ${edge.relayFeePerSubmitWei} wei `
    + `at a level worth ${edge.sizeWei} wei) plus your own ${edge.minNetEdgeBps} bps minimum. `
    + `Remedies: widen the gap between the ranges, import a larger level, or lower `
    + `minNetEdgeBps explicitly to accept thinner economics. `
    + `HONEST SCOPE: this bounds RELAY GAS ONLY, at a per-submission constant that is `
    + `still an unmeasured 4x pad on one sample; it models neither adverse selection `
    + `(which a fully-crossed range order IS) nor slippage.`
    // PHASE3.19 item 27 — the LADDER CLAUSE, and it names a THIRD uncovered
    // term rather than letting the sentence above stand as if it covered this
    // mode. It is the DOMINANT term here: a re-anchoring ladder's buy fill
    // happens at one anchor and its sell fill at a later, different one, so the
    // geometry priced above is the spread the ladder QUOTES, never the spread it
    // CAPTURES — and in a trend it pays every motion and captures a negative one.
    + (edge.ladder === true
      ? ` LADDER: this prices the QUOTED spread. A re-anchoring ladder captures a `
        + `DIFFERENT one — its two fills happen at different anchors — so re-anchoring `
        + `is a third uncovered term here, and in a trend it is the dominant one.`
      : "")
  );
}

/* -------------------------------------------------------------------------- */
/* Client-side range derivation (PHASE3.16 R2.8 / review M5)                  */
/* -------------------------------------------------------------------------- */

/**
 * M5's QUANTIZATION RULE: round UP to the next tick-spacing multiple, and
 * CLAMP anything below one spacing up to one spacing, reporting that it did.
 *
 * Rounding up is the conservative direction for both quantities the arm's
 * client derives: a wider gap is a wider spread (more edge per flip) and a
 * wider level is more inventory per fill.
 *
 * WHY THIS IS NOT COSMETIC. Pancake V3 on BSC runs spacings 1 / 10 / 50 / 200,
 * and `validateLpSettings` refuses any range narrower than one spacing or not
 * aligned to it. So on a fee-2500 pool (spacing 50) a "tight 15/15" and a
 * "standard 30/30" preset quantize to the SAME 50/50 geometry, and on spacing
 * 200 the first three presets collapse together; a `0.25x` spread factor on
 * "tight" gives 3.75 ticks, below spacing on EVERY pool. Any minimum-size
 * figure computed from the NOMINAL bps would then be wrong by up to 3x in the
 * OPTIMISTIC direction — which is why {@link gridPresetMinEconomicSizeWei}
 * takes an already-quantized grid and runs {@link gridNetEdge} on it.
 *
 * It lives HERE, with the rest of the grid's pure geometry, rather than in the
 * operator script: the PRESET TABLE stays client-side (ruling Q6 — a preset
 * name has no chain counterpart and must never be signed or asserted), but the
 * tick arithmetic it feeds is geometry, and geometry belongs with the module
 * that owns every other side and range decision.
 */
export function gridQuantizeUpToSpacing(
  ticks: number,
  tickSpacing: number,
): { readonly ticks: number; readonly clamped: boolean } {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("gridQuantizeUpToSpacing: tickSpacing must be a positive integer.");
  }
  if (!Number.isFinite(ticks) || ticks < 0) {
    throw new Error("gridQuantizeUpToSpacing: ticks must be a non-negative number.");
  }
  const rounded = Math.ceil(ticks);
  const clamped = rounded < tickSpacing;
  return {
    ticks: clamped ? tickSpacing : Math.ceil(rounded / tickSpacing) * tickSpacing,
    clamped,
  };
}

/**
 * PHASE3.18 — the two rung derivations MOVED VERBATIM to `./gridGeometry.js`
 * and RE-EXPORTED here, so every existing import site is unchanged.
 *
 * The move is forced by the R2.1 coherence rule: `validateLpSettings` (pure, in
 * `triggers.ts`) must run the derivation, and `gridTriggers.ts` imports
 * `triggers.ts` at RUNTIME. `gridGeometry.ts` imports nothing but types, so it
 * is a leaf both files may depend on. The alternative — a second derivation
 * inside the validator — is the two-authorities-on-one-geometry class this
 * lineage has already been caught by twice (3.13 F7 / 3.15 H1).
 */
export { gridDeriveRanges, gridDeriveDualRanges } from "./gridGeometry.js";

/**
 * PHASE3.17 R3.2 (review2 N4) — the SELL level's size at the ROUTE seam, in
 * NATIVE WEI, as a conservative LOWER BOUND.
 *
 * ```text
 * sellSizeWei = swapInWei x (10_000 - poolFeeBps - maxPriceImpactBps
 *                                    - maxSagaSlippageBps) / 10_000
 * ```
 *
 * THREE THINGS THIS FIXES, and each was a separate defect in the pre-R3.2
 * shape:
 *
 *  1. UNITS. The spec's earlier "run the check on `minOut`" is denominated in
 *     BASE-token units, while `gridNetEdge`'s floor divides a NATIVE-wei
 *     numerator by `sizeWei` — a silent unit error whose sign depends on the
 *     base token's decimals and price, on the one gate that prices gas. This
 *     never leaves quote denomination, so the defect cannot recur.
 *  2. SEAM. The route has no quote when it prices pair 1, and the arm's whole
 *     admission runs before any row is created. Every term here is a
 *     boot-resolved constant or a signed field, so the bound is computable at
 *     the route with no second evaluation at the builder.
 *  3. DIRECTION. Each deduction is the WORST case the rails allow, so the bound
 *     is <= the level's true size by construction and the gas-floor admission
 *     can only ever be STRICTER than reality — never optimistic, which is what
 *     H5 caught the "equal notional" claim being.
 *
 * Floors at zero: a rail set whose deductions exceed the whole swap is a
 * refusal at the net-edge check (a zero-size level clears no floor), not a
 * negative size.
 */
export function gridDualSellSizeWei(input: {
  readonly swapInWei: bigint;
  /** The pool's fee tier in MILLIONTHS, as the pool reports it (e.g. 2_500). */
  readonly poolFee: number;
  readonly maxPriceImpactBps: number;
  readonly maxSagaSlippageBps: number;
}): bigint {
  const poolFeeBps = BigInt(input.poolFee) / 100n;
  const keepBps =
    10_000n - poolFeeBps - BigInt(input.maxPriceImpactBps) - BigInt(input.maxSagaSlippageBps);
  if (keepBps <= 0n) return 0n;
  return (input.swapInWei * keepBps) / 10_000n;
}

/**
 * PHASE3.17 R3.3 (review2 N3/C3, C8) — the DUAL ARM's SELL-side gate, evaluated
 * against the POST-SWAP price, IN SQRT SPACE.
 *
 * ─── WHY THE SELL SIDE NEEDS A POST-SWAP GATE AND THE BUY SIDE DOES NOT ────
 *
 * The arm's own swap runs FIRST inside the batch and moves the tick in a
 * direction that is not random: buying the base moves the price TOWARD the rung
 * where the agent intends to sell it, in BOTH orientations (Case A swaps
 * token0 -> token1 and lowers the tick, and `sell2` is BELOW; Case B raises it
 * and `sell2` is ABOVE). It moves AWAY from the buy rung in both, monotonically
 * — so the buy gate evaluated on the PRE-swap tick is preserved by the swap and
 * needs no re-check, while the sell gate evaluated pre-swap can be true before
 * the swap and false at the mint. That failure is fail-closed (the whole atomic
 * batch reverts, gas only) but SYSTEMATIC rather than an edge case, because at
 * `--gap0` the clearance to the near edge can be zero ticks.
 *
 * ─── WHY SQRT SPACE AND NOT A TICK ─────────────────────────────────────────
 *
 * `src/lp/tickMath.ts` exports `getSqrtRatioAtTick` and NO inverse, and it is
 * frozen (3.12/3.13 treat it so, and this phase's edit list names it as NOT
 * edited). None is needed: V3 defines the tick by
 * `sqrtRatio(t) <= sqrtP < sqrtRatio(t+1)`, so
 *
 * ```text
 * tickAfter >= U   <=>   sqrtAfter >= getSqrtRatioAtTick(U)
 * tickAfter <  L   <=>   sqrtAfter <  getSqrtRatioAtTick(L)
 * ```
 *
 * — the whole of `swaplessRotationSide`'s two bounds, exactly, with no
 * precision question and no golden vectors owed.
 *
 * ─── THE ONE-SPACING CLEARANCE, WRITTEN OUT PER ORIENTATION (C8) ───────────
 *
 * The "near edge" is `sell2.tickUpper` in Case A and `sell2.tickLower` in Case
 * B, and the inequality inverts with it. Writing one unconditional comparison
 * over an orientation-dependent quantity is the 3.13 F7 / 3.15 H1 class this
 * lineage has been caught by twice, so both forms are spelled out:
 *
 * ```text
 * Case A (wbnbIsToken0; sell2 BELOW the corridor, swap moves the tick DOWN):
 *   require  sqrtAfter >= getSqrtRatioAtTick(sell2.tickUpper + tickSpacing)
 * Case B (sell2 ABOVE the corridor, swap moves the tick UP):
 *   require  sqrtAfter <  getSqrtRatioAtTick(sell2.tickLower - tickSpacing)
 * ```
 *
 * One spacing of clearance structurally FORBIDS the `--gap0` shape for dual
 * arms: `gridDeriveRanges`' anchors put the near edge at `floor(t/s)*s`, so at
 * `gapTicks === 0` the clearance is `t - floor(t/s)*s`, which lies in `[0, s)`
 * and can never satisfy a one-spacing rule.
 *
 * RESIDUAL, stated at the seam (review2 N17): `sqrtPriceX96After` is a
 * SIMULATION. This one-spacing pad is the only thing standing between the quote
 * and the pool moving before the batch executes; it is a pad, not a proof.
 */
export function gridDualSellClearanceOk(input: {
  /** The quoter's simulated post-swap price. */
  readonly sqrtPriceX96After: bigint;
  /** Level 2's INNER rung — the range the arm mints the base leg into. */
  readonly sellRange2: LpGridRange;
  readonly tickSpacing: number;
  readonly wbnbIsToken0: boolean;
}): boolean {
  if (input.wbnbIsToken0) {
    const edge = input.sellRange2.tickUpper + input.tickSpacing;
    if (edge > MAX_TICK) return false;
    return input.sqrtPriceX96After >= getSqrtRatioAtTick(edge);
  }
  const edge = input.sellRange2.tickLower - input.tickSpacing;
  if (edge < MIN_TICK) return false;
  return input.sqrtPriceX96After < getSqrtRatioAtTick(edge);
}

/**
 * The smallest level value at which a spread clears the gas floor, in wei —
 * {@link gridNetEdge} inverted.
 *
 * `null` means NO size ever clears it: the gross edge does not even cover the
 * owner's own `minNetEdgeBps`, so widening the level cannot help and the
 * geometry itself has to change.
 */
export function gridPresetMinEconomicSizeWei(input: {
  readonly grossEdgeBps: bigint;
  readonly minNetEdgeBps: bigint;
  readonly relayFeePerSubmitWei: bigint;
  /** PHASE3.18: defaults to 2, so the fixed-mode preset table is unchanged. */
  readonly submissionsPerCycle?: number;
}): bigint | null {
  const headroom = input.grossEdgeBps - input.minNetEdgeBps;
  if (headroom <= 0n) return null;
  const numerator =
    BigInt(input.submissionsPerCycle ?? 2) * input.relayFeePerSubmitWei * 10_000n;
  // Round UP, for the same reason `gridNetEdge`'s own floor does: truncation
  // understates a conservatism bound.
  return (numerator + headroom - 1n) / headroom;
}

/* -------------------------------------------------------------------------- */
/* PHASE3.18 — policy mode: identity, drift, target, gates                     */
/* -------------------------------------------------------------------------- */

/**
 * The DURABLE identity a policy-mode position carries on its row (R2.6).
 *
 * `null` on either column is the state R2.6 refuses to guess about: the
 * evaluator HOLDS naming the remedy, `buildGridRequoteDeps`/`buildGridFlipDeps`
 * THROW. Never re-adopt by geometry — that is the PHASE3.4-A7 second-admission
 * hazard, and in policy mode there is no exact rung to re-adopt against anyway.
 */
export type LpGridDurableIdentity = {
  readonly gridLevel?: LpGridLevelValue | null;
  readonly gridRole?: LpGridRoleValue | null;
};

/**
 * PHASE3.18 C1 (BLOCKER-class) — `{level, role}` AT EVERY SEAM, mode-aware.
 *
 * ─── WHY THIS FUNCTION EXISTS ──────────────────────────────────────────────
 *
 * {@link gridLiveRole} matches on EXACT TICK equality against the signed rungs,
 * and it is the sole role authority at five src seams (this evaluator,
 * `buildGridFlipDeps`, C2, the owner view, the client status). A REQUOTED level
 * equals none of the signed rungs — that is the definition of policy mode — so
 * from the FIRST requote onward `gridLiveRole` answers `null`, the evaluator
 * emits no cross reading, `buildGridFlipDeps` throws, and the level is dead to
 * automation with only the price stop still running. Policy mode as originally
 * specified killed the very motion the phase exists to keep alive.
 *
 * The correction is exactly this: in POLICY mode identity comes from the
 * durable columns; in FIXED mode `gridLiveRole` remains the sole authority,
 * byte-identical. The flip's TARGET is `gridTargetRange(grid, level, role)` in
 * BOTH modes — SIGNED data — so ruling Q5 and `LpGridFlipDeps.targetRange`'s
 * "Never derived" contract survive untouched.
 */
export function gridRoleAtFor(
  grid: LpGridSettings,
  position: { readonly tickLower: number; readonly tickUpper: number },
  identity: LpGridDurableIdentity,
): LpGridRoleAt | null {
  if (gridModeOf(grid) === "fixed") return gridLiveRole(grid, position);
  const level = identity.gridLevel;
  const role = identity.gridRole;
  if (level === undefined || level === null || role === undefined || role === null) {
    return null;
  }
  // A level the signed grid does not have is as unusable as a null: a level-2
  // row under a grid re-signed down to one pair has no pair to flip within.
  if (gridPair(grid, level) === null) return null;
  return { level, role };
}

/** The remedy sentence a null durable identity earns, in both voices (R2.6). */
export const LP_GRID_IDENTITY_MISSING_REASON =
  "This policy-mode grid position carries no grid_level/grid_role, so which rung it is cannot be established: in policy mode a live rung floats and no tick match can answer it. The plane will not guess. Remedy: abandon the sequence if one is open, exit the position, and sign gridArm again to re-place the ladder.";

/**
 * PHASE3.18 C8 — the bps equivalent of a TICK SEPARATION, which is what makes
 * the drift comparison bps-against-bps rather than two scales wearing one
 * another's units.
 *
 * `priceDeviationBps(sqrt(x), sqrt(x + n))` is a function of `n` ALONE: the
 * sqrt-ratio is `1.0001^(n/2)`, so the deviation depends only on the separation
 * and is POSITION-INDEPENDENT. Evaluated at `x = 0` for that reason, and
 * clamped to the global tick bounds so a pathological threshold cannot throw
 * inside a trigger.
 */
export function gridTickSeparationBps(ticks: number): bigint {
  const n = Math.min(Math.max(Math.trunc(ticks), 0), MAX_TICK);
  return priceDeviationBps(getSqrtRatioAtTick(0), getSqrtRatioAtTick(n));
}

/**
 * THE SIGNED GAP OF ONE RUNG (R2.1's crossed-pair geometry, read back).
 *
 * The policy is SHARED between levels (C6) but a dual grid's rungs are NOT all
 * at the same gap: each level takes one INNER rung (gap `g`) and one OUTER rung
 * (gap `2g + w`), which is exactly the asymmetry B1 used to prove the policy
 * unrecoverable from the rungs. The drift denominator and the requote target
 * must both use the rung's OWN gap, or a re-centred outer rung would land at
 * the inner distance and collapse the crossed-pair geometry — the B3 failure,
 * re-introduced by a requote.
 *
 * A single-level grid derives both rungs from ONE call, so both are inner.
 */
export function gridPolicyGapFor(
  grid: LpGridSettings,
  policy: LpGridPolicy,
  level: LpGridLevel,
  role: LpGridRole,
): number {
  if (!gridIsDual(grid)) return policy.gapTicks;
  const outer =
    (level === 1 && role === "sell") || (level === 2 && role === "buy");
  return outer ? 2 * policy.gapTicks + policy.widthTicks : policy.gapTicks;
}

/** What one observation says about how far the price has drifted from a rung. */
export type LpGridDriftReading = {
  /** The side the LIVE range presents, or `undefined` while the tick is inside. */
  readonly side: SwaplessRotationSide | undefined;
  /** `true` iff the level is UNFILLED — still holding the asset it was armed with. */
  readonly unfilled: boolean;
  /** The bound nearest the tick, chosen by SIDE and never by a role name. */
  readonly nearEdgeTick: number;
  readonly driftBps: bigint;
  readonly thresholdBps: bigint;
  /** The tick threshold the bps figure came from, for the owner-facing text. */
  readonly thresholdTicks: number;
  readonly drifted: boolean;
};

/**
 * PHASE3.18 R2.8 / Q4 — THE DRIFT ARITHMETIC, one function, both orientations.
 *
 * ─── NEAR EDGE, AND WHY IT IS CHOSEN BY SIDE ──────────────────────────────
 *
 * Measured NEAR-EDGE-to-tick (not mid-to-tick: the near edge is where the
 * quote actually sits, and a mid-based measure would call a wide rung drifted
 * while its working edge is still at the price). The near edge is decided by
 * {@link gridTargetSide} against the LIVE range, NEVER by a role name:
 *
 * ```text
 * Case A (wbnbIsToken0):  a BUY rung sits ABOVE the corridor  -> near edge tickLower
 *                         a SELL rung sits BELOW              -> near edge tickUpper
 * Case B:                 mirrored, exactly.
 * ```
 *
 * Both cases collapse to ONE implementable rule — side `"above"` means the rung
 * is above the tick so its near edge is `tickLower`; `"below"` means
 * `tickUpper` — which is why this reads with no orientation branch at all.
 * Writing it in role order is the 3.13 F7 / 3.15 H1 inversion this lineage has
 * been caught by twice, so both cases are named above and pinned by
 * dual-orientation vectors.
 *
 * ─── THE DENOMINATOR IS THE SIGNED GAP ALONE ──────────────────────────────
 *
 * Ruling Q4: `gap`, not `gap + width/2`. The gap is the distance the owner
 * signed between the price and the quote; the width is the rung's own corridor
 * and belongs to neither the distance that drifted nor the one being restored.
 *
 * ─── THE FLOOR, WHICH IS A DELIBERATE ADDITION (the 3.13 F1 precedent) ────
 *
 * The threshold is `max(gap x (1 + driftPctOfGap/100), gap + tickSpacing)`.
 * The second term is not in the spec's formula and is load-bearing: a requote
 * lands its rung at `anchor +/- gap` where the anchor is up to ONE SPACING from
 * the tick, so the drift IMMEDIATELY after a requote is up to `gap + spacing`
 * ticks. Without the floor a policy with a small gap (at `gapTicks: 0`,
 * ANY policy) has a threshold below its own post-requote drift and re-fires for
 * ever, burning the whole lane every day and moving nothing. That is PHASE3.13
 * F1 exactly — "without the trigger floor, swapless would re-fire the rotate
 * for ever" — and it is answered the same way, with a floor at the geometry's
 * own resolution. `priceDeviationBps` is monotone in tick separation, so
 * comparing in bps preserves the tick-space guarantee this floor gives.
 */
export function gridDriftReading(input: {
  readonly currentTick: number;
  readonly range: LpGridRange;
  readonly role: LpGridRole;
  readonly wbnbIsToken0: boolean;
  readonly gapTicks: number;
  readonly tickSpacing: number;
  readonly driftPctOfGap: number;
}): LpGridDriftReading {
  const side = gridTargetSide(input.currentTick, input.range);
  const thresholdTicks = Math.max(
    Math.floor((input.gapTicks * (100 + input.driftPctOfGap)) / 100),
    input.gapTicks + input.tickSpacing,
  );
  const thresholdBps = gridTickSeparationBps(thresholdTicks);
  if (side === undefined) {
    return {
      side,
      unfilled: false,
      nearEdgeTick: input.currentTick,
      driftBps: 0n,
      thresholdBps,
      thresholdTicks,
      drifted: false,
    };
  }
  // UNFILLED means the rung still charges the asset its role was armed holding.
  // A FILLED level's motion is the FLIP, never a requote (non-goal §8).
  const chargesQuote = gridSideChargesQuote(side, input.wbnbIsToken0);
  const unfilled = input.role === "buy" ? chargesQuote : !chargesQuote;
  const nearEdgeTick = side === "above" ? input.range.tickLower : input.range.tickUpper;
  const driftBps = priceDeviationBps(
    getSqrtRatioAtTick(nearEdgeTick),
    getSqrtRatioAtTick(input.currentTick),
  );
  return {
    side,
    unfilled,
    nearEdgeTick,
    driftBps,
    thresholdBps,
    thresholdTicks,
    drifted: unfilled && driftBps > thresholdBps,
  };
}

/**
 * PHASE3.18 R2.9 — G0: may a requote START, and may its zap-out BUILD?
 *
 * The level must be STRICTLY OUTSIDE its range on the ARMED side: a side must
 * exist (the tick is not inside the rung) and {@link gridSideChargesQuote} must
 * agree with the STORED role. Drift INTO range between trigger and build is a
 * ZERO-MONEY TERMINAL ROLLBACK, never a hold — a requote is discretionary and
 * must never park a position or disarm the price stop for a move nobody needed.
 */
export function gridRequoteG0(input: {
  readonly currentTick: number;
  readonly range: LpGridRange;
  readonly role: LpGridRole;
  readonly wbnbIsToken0: boolean;
}): { readonly ok: boolean; readonly side: SwaplessRotationSide | undefined } {
  const side = gridTargetSide(input.currentTick, input.range);
  if (side === undefined) return { ok: false, side };
  const chargesQuote = gridSideChargesQuote(side, input.wbnbIsToken0);
  return { ok: input.role === "buy" ? chargesQuote : !chargesQuote, side };
}

/**
 * THE REQUOTE'S TARGET: the SAME side, the SAME asset, at the policy's own
 * distance from the FRESH tick.
 *
 * It runs the ONE derivation (`gridDeriveRanges`) at the rung's OWN gap
 * ({@link gridPolicyGapFor}) and takes the range whose role matches — which is
 * the side that charges the asset the level already holds, by that function's
 * own construction. So a requote never converts, never swaps and never changes
 * which leg the level is in: it only moves the quote closer to the price.
 *
 * Computed ONCE at the trigger and PERSISTED (R2.3): on this relay resume is
 * the DEFAULT path (FINDINGS (aw): 6 of 6 mainnet submissions published after
 * `awaitExecution`'s deadline), and a live-tick derivation on resume would bind
 * a target the trigger never saw.
 */
export function gridRequoteTarget(input: {
  readonly grid: LpGridSettings;
  readonly policy: LpGridPolicy;
  readonly level: LpGridLevel;
  readonly role: LpGridRole;
  readonly currentTick: number;
}): LpGridRange {
  const derived = gridDeriveRanges({
    currentTick: input.currentTick,
    tickSpacing: input.grid.tickSpacing,
    gapTicks: gridPolicyGapFor(input.grid, input.policy, input.level, input.role),
    widthTicks: input.policy.widthTicks,
    wbnbIsToken0: input.grid.wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  return input.role === "buy" ? derived.buyRange : derived.sellRange;
}

/**
 * PHASE3.18 C2 — THE ONE SHARED PAIR BUILDER, feeding BOTH economics gates.
 *
 * The pair is *the live-or-proposed rung in its stored role's slot, plus that
 * level's SIGNED counter-rung*, and it is the only pair the plane ever trades:
 * ruling Q5 keeps the FLIP's target on the signed opposite rung in both modes,
 * so a requoted level's next round trip is "fill at the floating rung, mint at
 * the SIGNED counter-rung". One rung floats; the other is signed data.
 *
 * The clearance REJECTED the alternative reading (a policy-derived counter-rung
 * for C2's re-sign check) on two grounds: the policy derives rungs from a TICK,
 * never from another rung, so "the policy counter-rung of this live rung" names
 * a derivation that does not exist; and C2's own charter sentence is that the
 * plane "would keep FLIPPING into it", which is this pair and no other.
 *
 * ONE builder rather than two call-site expressions, so the re-sign guard and
 * the requote gate cannot diverge — the 3.13 F12 same-builder discipline.
 */
export function gridEconomicsPair(
  grid: LpGridSettings,
  level: LpGridLevel,
  role: LpGridRole,
  rung: LpGridRange,
): {
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
  readonly level?: LpGridLevel;
} | null {
  const pair = gridPair(grid, level);
  if (pair === null) return null;
  const buyRange = role === "buy" ? rung : pair.buyRange;
  const sellRange = role === "sell" ? rung : pair.sellRange;
  return gridIsDual(grid)
    ? { buyRange, sellRange, level }
    : { buyRange, sellRange };
}

/**
 * PHASE3.18 R2.4 — HOW MANY SUBMISSIONS ONE CYCLE COSTS when requotes ride
 * along: `2 + 2R`, where `R` is the SIGNED `maxRequotesPerDay` bound.
 *
 * A cycle is a flip's two submissions; each requote in between is another two
 * (its sweep always skips, exactly as the flip's does). Bounding `R` by the
 * signed number rather than by an observed count is deliberate: the gate runs
 * BEFORE the requote, and an owner who signed 21 re-centres a day has signed up
 * to pay for them out of the same spread.
 */
/**
 * PHASE3.19 item 24 (review H7) — EXHAUSTIVE, with a `never` binding.
 *
 * IT USED TO RETURN `2` FOR EVERY NON-POLICY MODE, and that is the finding: a
 * ladder grid has `mode: "ladder"` and `requote === undefined`, so the old
 * ternary answered the FLIP FLOOR at all three seams that price economics — the
 * arm route, the C2 re-sign guard and the client transcript. Consistently, and
 * therefore silently: the client's own comment promises "the SAME inflated floor
 * the route admits on", which stayed true while both were wrong by a factor of
 * ~7 at `maxMovesPerDay: 12`.
 *
 * The `never` binding is the fix, and it is `lpDispatchKindFor`'s treatment: a
 * FIFTH mode fails `tsc` here rather than inheriting `2`.
 *
 * ─── THE LADDER ARM, DERIVED ───────────────────────────────────────────────
 *
 * ```text
 * 2 * (2 + moves) + (hedge.enabled ? (2 + moves) : 0)
 * ```
 *
 * A round trip is one buy fill + one sell fill = 2 fill motions, plus up to
 * `maxMovesPerDay` drift motions in between under the same per-DAY-as-per-CYCLE
 * proxy 3.18 uses. Each motion is `zap-out + mint` = 2 submissions, hence
 * `2*(2 + moves)`; the hedge adds ONE submission per motion over the same
 * `(2 + moves)` motions, hence `+(2 + moves)`.
 *
 * ─── PHASE3.20 item 21 / C8 — THE C10 PAD IS RETIRED, DELIBERATELY ─────────
 *
 * C10 used to read: "the over-count is deliberate and must not be fixed
 * downward", because 3.19's D7 put ALL ladder motions — fill-response AND
 * drift-response — in ONE `maxMovesPerDay` lane, so the two fill motions were
 * already members of `moves` and the `2 +` was a pad of 4 submissions (6 with
 * the hedge).
 *
 * UNDER TWO LANES THAT PAD IS NO LONGER AN APPROXIMATION OF ANYTHING. A cycle
 * is bounded by its own lanes: `max(2, settlementsPerDay)` fill motions — the
 * `max(2, …)` floor is what keeps a round trip's two fills priced even when the
 * settlement lane is signed at 1 — plus `driftMovesPerDay` discretionary ones.
 * The formula is now EXACT rather than padded, and the retirement is DECLARED
 * (C8) rather than quietly re-baselined: `test/lp.gridLadder.test.ts`'s two C10
 * assertions were INVERTED in the same change, on the 3.14 A9 precedent.
 *
 * THE CONSEQUENCE THAT MUST NOT BE MISSED: a LEGACY-signed ladder reads
 * `max(2, M) + 0 = M` where 3.19 read `2 + M`, so at `M = 12` with the hedge on
 * `minRungWei` and `minBudgetWei` fall 14.3% at upgrade — in the direction that
 * LOOSENS the B1 funding gate, with no owner action. That is the price of the
 * exactness and it is stated rather than discovered.
 */
export function gridCycleSubmissions(grid: LpGridSettings): number {
  const mode = gridModeOf(grid);
  switch (mode) {
    case "fixed":
      return 2;
    case "policy": {
      const requote = grid.requote;
      if (requote === undefined) return 2;
      return 2 + 2 * requote.maxRequotesPerDay;
    }
    case "ladder": {
      const ladder = grid.ladder;
      // FAIL CLOSED on a ladder with no block: the validator refuses it, so
      // this is unreachable — and answering the flip floor for it would be
      // exactly the defect H7 is about.
      if (ladder === undefined) return 2;
      // PHASE3.20 item 21 / C10: through the ONE normalizer, so the legacy
      // interpretation is written in exactly one place.
      const counts = ladderMotionCounts(ladder);
      const motions = Math.max(2, counts.settlementsPerDay) + counts.driftMovesPerDay;
      return 2 * motions + (ladder.hedge.enabled ? motions : 0);
    }
    // ─── PHASE3.22 R3.4 / N6 — THE SHIFT ARM, AND ITS CONSTANT IS THE *CYCLE*
    // ONE ────────────────────────────────────────────────────────────────────
    //
    // PHASE3.25 R2.3/R5.2: shift admission prices one reusable-capital round
    // trip. Daily settlement cadence and the separately funded drift lane are
    // native-cap concerns, not multipliers on the capital admission floor.
    case "shift": {
      const shift = grid.shift;
      // FAIL CLOSED on a shift grid with no block: the validator refuses it,
      // so this is unreachable — and answering the flip floor for it would be
      // exactly the defect H7 is about.
      if (shift === undefined) return 2;
      // PHASE3.25 R2.3/R5.2 — one admission cycle is the cadence-invariant
      // round trip. Capital is reusable; shiftsPerDay bounds settlement only.
      return 2 * MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE;
    }
    default: {
      const unreachable: never = mode;
      throw new Error(`gridCycleSubmissions: unmapped grid mode ${String(unreachable)}.`);
    }
  }
}

/**
 * PHASE3.25 R2.2/R5.1 — the ONE reader of the shift drift budget/price pair.
 * Legacy absence and disabled drift both mean zero; bigint arithmetic floors
 * before the physical 288-motion ceiling and conversion to number.
 */
export function gridShiftDriftMotionsPerDay(shift: LpGridShift): number {
  if (
    shift.driftPctOfGap === 0
    || shift.driftGasBudgetWei === undefined
    || shift.driftPerMotionWei === undefined
  ) {
    return 0;
  }
  const motions = shift.driftGasBudgetWei / shift.driftPerMotionWei;
  return Number(motions > 288n ? 288n : motions);
}

/* -------------------------------------------------------------------------- */
/* PHASE3.19 — the ladder: identity, geometry, funding, hedge, economics       */
/* -------------------------------------------------------------------------- */

/**
 * PHASE3.19 item 34 (review M5) — WHERE a live grid position's `{level, role}`
 * COMES FROM, as an EXHAUSTIVE switch with a `never` binding.
 *
 * `gridRoleAtFor` branches on `=== "fixed"`, so every non-fixed mode lands in
 * the durable-column branch BY ACCIDENT rather than by decision — and the same
 * accidental shape appears at `buildGridFlipDeps`, at `admitGridSettings`'s
 * `policyMode` boolean and at `evaluateGridTriggers`' policy/requote reads,
 * the last of which is the dangerous one (`=== "policy" ? … : undefined`, so a
 * FIFTH mode silently inherits whichever branch it fell into).
 *
 * A ladder's answer is `"columns"` and it is a DECISION, not a fall-through: a
 * ladder rung floats from its first motion onward, so an exact-tick match
 * against the signed rungs would answer `null` for ever — the C1 defect 3.18
 * found for the requote, arriving one phase later in a mode that moves more
 * often.
 */
export function gridIdentitySourceFor(mode: LpGridMode): "ticks" | "columns" {
  switch (mode) {
    case "fixed":
      return "ticks";
    case "policy":
      return "columns";
    case "ladder":
      return "columns";
    // PHASE3.22 — a shift rung floats from its FIRST motion onward, exactly as
    // a ladder's does and for a stronger reason: every targeted rung is derived
    // afresh, so after one shift its ticks need not match any signed range.
    // `"columns"` is the DECISION, not a fall-through.
    case "shift":
      return "columns";
    default: {
      const unreachable: never = mode;
      throw new Error(
        `gridIdentitySourceFor: unmapped grid mode ${String(unreachable)}.`,
      );
    }
  }
}

/**
 * PHASE3.19 items 11-12 / H2 rule 1, as amended by C7 — THE RE-MINT SIDE, IN
 * POOL ORDER, at the TARGET the trigger persisted.
 *
 * ```text
 * role    = the position row's durable grid_role (never a tick match; rungs float)
 * derived = gridDeriveRanges({ currentTick: freshTick, tickSpacing,
 *                              gapTicks: ladder.gapTicks,   // NEVER gridPolicyGapFor
 *                              widthTicks: ladder.widthTicks,
 *                              wbnbIsToken0, minTick, maxTick })
 * target  = role === "buy" ? derived.buyRange : derived.sellRange
 * ```
 *
 * `gridDeriveRanges` resolves buy/sell BY ORIENTATION in its own last two lines,
 * so this rule is orientation-correct by construction and needs no branch —
 * which is exactly why it is written this way and not as an inequality. Both
 * Case A (`wbnbIsToken0`) and Case B are pinned by dual-orientation vectors.
 *
 * ITEM 12 / C17 — IT MUST NOT CALL {@link gridPolicyGapFor}. The reason is NOT
 * the outer-rung gap (that function returns `policy.gapTicks` for a non-dual
 * grid anyway): it is that `grid.policy` DOES NOT EXIST under ladder mode, so
 * reaching for it reads `undefined`. The ladder's gap is `ladder.gapTicks`,
 * full stop.
 *
 * A FILL DOES NOT INVERT THE ROLE (item 13 / H2 rule 3). A ladder's
 * two-sidedness is "one rung per role", so inverting on a fill would leave two
 * rungs on the same side. `role` is invariant across every ladder motion and
 * THE LADDER SAGA WRITES NO `gridRole`, EVER — the one line a builder copying
 * `runLpGridFlip`'s `after` would break.
 */
export function gridLadderTarget(input: {
  readonly grid: LpGridSettings;
  readonly ladder: LpGridLadder;
  readonly role: LpGridRole;
  readonly currentTick: number;
}): LpGridRange {
  const derived = gridDeriveRanges({
    currentTick: input.currentTick,
    tickSpacing: input.grid.tickSpacing,
    // ITEM 12: the LADDER's own gap, DIRECTLY.
    gapTicks: input.ladder.gapTicks,
    widthTicks: input.ladder.widthTicks,
    wbnbIsToken0: input.grid.wbnbIsToken0,
    minTick: MIN_TICK,
    maxTick: MAX_TICK,
  });
  return input.role === "buy" ? derived.buyRange : derived.sellRange;
}

/** {@link gridLadderTarget}, with the derivation's refusals turned into `null`. */
export function safeGridLadderTarget(input: {
  readonly grid: LpGridSettings;
  readonly ladder: LpGridLadder;
  readonly role: LpGridRole;
  readonly currentTick: number;
}): LpGridRange | null {
  try {
    return gridLadderTarget(input);
  } catch {
    return null;
  }
}

/**
 * PHASE3.19 C7 — THE RE-MINT SIDE RULE AS A **PRIMARY CONTROL**, evaluated
 * against the PERSISTED target at the BUILD tick, with THREE outcomes.
 *
 * The same-tick derivation is a tautology and that is the problem: the real seam
 * has TWO ticks. The target is derived at the TRIGGER's tick and PERSISTED
 * (persisted-wins, C4); the side is evaluated at the MINT BUILD's fresh tick,
 * one or more submissions later, where the price may have moved INTO the
 * persisted target (`side === undefined`) or THROUGH it (the side flips).
 *
 * WHY IT IS PRIMARY AND NOT A BELT, which is the whole of C7: in `runLpGridFlip`
 * the third G2 conjunct is `present <= 0n` — "the wallet does not hold the leg
 * the side implies" — and it is SELF-ENFORCING, because the flip only ever holds
 * the single leg its own zap-out freed. A BUFFER-FUNDED ladder holds BOTH legs,
 * so a wrong-side mint would SUCCEED, funding a buy rung with base. Item 42's
 * "a mutation that funds a re-mint from the wrong asset must die" is aimed here.
 *
 * `"hold"` in both failure cases, never a rollback: the zap-out has already
 * committed, so the principal is in the wallet and a rollback is impossible.
 * That is the ONE ladder hold and it is RECOVERABLE — the 3.11 stall latch
 * quiesces it and the owner-signed abandon door stays open.
 */
export function gridLadderRemintSide(input: {
  readonly currentTick: number;
  readonly target: LpGridRange;
  readonly role: LpGridRole;
  readonly wbnbIsToken0: boolean;
}):
  | { readonly ok: true; readonly side: SwaplessRotationSide }
  | { readonly ok: false; readonly failed: "no-side" | "side-role-mismatch";
      readonly side: SwaplessRotationSide | undefined } {
  const side = gridTargetSide(input.currentTick, input.target);
  if (side === undefined) return { ok: false, failed: "no-side", side };
  if (gridSideChargesQuote(side, input.wbnbIsToken0) !== (input.role === "buy")) {
    return { ok: false, failed: "side-role-mismatch", side };
  }
  return { ok: true, side };
}

/**
 * PHASE3.19 C8 — THE ONE VALUATION EXPRESSION: "value this BASE amount in
 * WBNB", at a given sqrt price.
 *
 * Shared VERBATIM by the imbalance measure, the markout gate, the funding
 * conjunct and the owner view — the 3.13 cannot-diverge rule — so exactly ONE
 * orientation expression enters this phase. Getting `tokenInIsToken0` backwards
 * inverts every one of them silently, which is why this is a function and not
 * four call-site expressions.
 *
 * The derivation: `tokenInIsToken0` asks "is the asset being valued token0".
 * Valuing BASE means `tokenIn = base`, so the answer is `!wbnbIsToken0`. This is
 * `makeSweepStep`'s own expression for the base-to-quote direction, copied
 * rather than re-derived.
 */
export function gridLadderValueBaseInQuote(input: {
  readonly baseWei: bigint;
  readonly sqrtPriceX96: bigint;
  readonly wbnbIsToken0: boolean;
}): bigint {
  if (input.baseWei <= 0n) return 0n;
  return spotSwapOutput({
    amountInAfterFee: input.baseWei,
    sqrtPriceX96: input.sqrtPriceX96,
    tokenInIsToken0: !input.wbnbIsToken0,
  });
}

/** The mirror of {@link gridLadderValueBaseInQuote}: value QUOTE in BASE. */
export function gridLadderValueQuoteInBase(input: {
  readonly quoteWei: bigint;
  readonly sqrtPriceX96: bigint;
  readonly wbnbIsToken0: boolean;
}): bigint {
  if (input.quoteWei <= 0n) return 0n;
  return spotSwapOutput({
    amountInAfterFee: input.quoteWei,
    sqrtPriceX96: input.sqrtPriceX96,
    tokenInIsToken0: input.wbnbIsToken0,
  });
}

/**
 * PHASE3.19 R4.2 — one rung's DEPLOYED size, in native (quote) wei.
 *
 * `deployPctBps` applies ONCE PER SIDE to that side's HALF, so a rung is
 * `budget/2 x deployPctBps/10_000`. The accounting identity is pinned in
 * {@link LpGridLadder}: total deployed is `deployPctBps` of the WHOLE inventory
 * (30% + 30% of two halves is 30% of the total, not 60%), and idle is
 * `10_000 - deployPctBps` of it.
 *
 * This is the size the economics gate prices, and it is the CONSERVATIVE choice
 * H1 item 2 asks for: pricing a rung's gas against the whole budget would admit
 * a geometry that cannot pay for the rung it actually mints.
 */
export function gridLadderRungSizeWei(
  budgetWei: bigint,
  deployPctBps: number,
): bigint {
  if (budgetWei <= 0n) return 0n;
  return ((budgetWei / 2n) * BigInt(deployPctBps)) / 10_000n;
}

export type LpGridLadderEconomics = {
  readonly edge: LpGridNetEdge;
  readonly submissionsPerCycle: number;
  /** The DEPLOYED per-rung size the edge was priced on. */
  readonly rungSizeWei: bigint;
  /** The smallest rung that clears the gas floor, or `null` if no size does. */
  readonly minRungWei: bigint | null;
  /** {@link minRungWei} inverted through `deployPctBps`, or `null`. */
  readonly minBudgetWei: bigint | null;
};

/**
 * PHASE3.19 item 25 / OQ4 — THE ONE LADDER ECONOMICS BUILDER, at exactly THREE
 * call sites: the arm route, C2's re-sign check 4, and the client transcript.
 *
 * The 3.13 F12 cannot-diverge rule, applied to the gate that decides whether a
 * ladder is worth arming at all. Two call-site expressions would be two
 * authorities on one quantity, and the client's own promise ("the SAME inflated
 * floor the route admits on") would become a claim rather than a property.
 *
 * WHAT IT PRICES, and the honesty it owes (item 27):
 *
 *  - GROSS edge: the gap+width geometry of the ladder's two SIGNED rungs, which
 *    is the spread the ladder QUOTES. It is NOT the spread it CAPTURES: a
 *    re-anchoring ladder's buy fill happens at one anchor and its sell fill at a
 *    later, different one, and in a trend it captures a NEGATIVE one. That is a
 *    THIRD uncovered term beside adverse selection and slippage, and it is the
 *    dominant one for this mode. {@link lpGridNetEdgeRefusal} says so.
 *  - COST floor: {@link gridCycleSubmissions}' ladder arm x the relay constant,
 *    against the DEPLOYED rung size.
 *
 * {@link minRungWei} is ALSO the trigger's `ladderMinMintWei` (M1), computed by
 * this same function, so the funding gate and the admission cannot disagree.
 */
export function gridLadderEconomics(input: {
  readonly grid: LpGridSettings;
  readonly ladder: LpGridLadder;
  /** The owner's native budget. `0n` prices only the geometry (minRung/minBudget). */
  readonly budgetWei: bigint;
  readonly relayFeePerSubmitWei: bigint;
  /**
   * C2's OVERRIDE: the LIVE rung's own value, when the caller is the re-sign
   * guard rather than the arm. Absent ⇒ the deployed size derived from
   * `budgetWei`, which is what the arm and the client price.
   */
  readonly sizeWei?: bigint;
  /**
   * C2's OTHER OVERRIDE: the pair to price, when the caller holds a FLOATED live
   * rung. Absent ⇒ the SIGNED `{buyRange, sellRange}` — a ladder is TWO ROWS ON
   * ONE PAIR (R3.1/C2), so there is no level label and no second pair for the
   * refusal to be confused with.
   *
   * The overrides exist so the re-sign guard runs through THIS builder rather
   * than assembling its own `gridNetEdge` call: three call sites, one function,
   * no divergence (the 3.13 F12 rule). The alternative — C2 pricing a ladder on
   * a hand-written expression — is exactly how the two would come to disagree
   * about `submissionsPerCycle`.
   */
  readonly pair?: {
    readonly buyRange: LpGridRange;
    readonly sellRange: LpGridRange;
    readonly level?: LpGridLevel;
  };
}): LpGridLadderEconomics {
  const submissionsPerCycle = gridCycleSubmissions(input.grid);
  const rungSizeWei =
    input.sizeWei
    ?? gridLadderRungSizeWei(input.budgetWei, input.ladder.deployPctBps);
  const edge = gridNetEdge({
    pair: input.pair ?? {
      buyRange: input.grid.buyRange,
      sellRange: input.grid.sellRange,
    },
    minNetEdgeBps: input.grid.minNetEdgeBps,
    sizeWei: rungSizeWei,
    relayFeePerSubmitWei: input.relayFeePerSubmitWei,
    submissionsPerCycle,
    ladder: true,
  });
  const minRungWei = gridPresetMinEconomicSizeWei({
    grossEdgeBps: edge.grossEdgeBps,
    minNetEdgeBps: edge.minNetEdgeBps,
    relayFeePerSubmitWei: input.relayFeePerSubmitWei,
    submissionsPerCycle,
  });
  // L2 — the operator needs the minimum BUDGET, not the minimum RUNG. They
  // differ by `2 x 10_000 / deployPctBps`, i.e. ~6.7x at the default 30%, and
  // printing the rung figure as if it were the budget understates by that
  // factor. Rounds UP, for the reason every other floor in this file does.
  const minBudgetWei =
    minRungWei === null
      ? null
      : (minRungWei * 2n * 10_000n + BigInt(input.ladder.deployPctBps) - 1n)
        / BigInt(input.ladder.deployPctBps);
  return { edge, submissionsPerCycle, rungSizeWei, minRungWei, minBudgetWei };
}

export type LpGridLadderResilience = {
  /**
   * How many CONSECUTIVE same-direction fills this configuration can settle
   * before the funding conjunct holds for ever. `null` when the geometry admits
   * no economic rung at all (`minBudgetWei === null`).
   */
  readonly fundableFills: number | null;
  /** `1/(1-d)` in basis points — 14286 at the default `deployPctBps: 3000`. */
  readonly requiredMultipleBps: number;
  /** The smallest budget at which ONE settlement is fundable, or `null`. */
  readonly minFundableBudgetWei: bigint | null;
};

/**
 * PHASE3.20 R3.1 / C3 (clearance A.2, N7) — HOW MANY SAME-DIRECTION FILLS THIS
 * LADDER CAN SETTLE. ONE exported function, read by the client transcript and
 * by the owner view, for the 3.13 F12 cannot-diverge reason.
 *
 * ─── THE DERIVATION, because the obvious formula is wrong ───────────────────
 *
 * A MISMATCHED row is a FILLED row, so `rungIsUnfilled` is false and its own
 * principal contributes NOTHING to {@link gridLadderFunding}: the re-place is
 * funded entirely from the buffer of the CHARGED asset, which the role fixes.
 * Each settlement takes `d = deployPctBps/10_000` of what REMAINS, so the buffer
 * decays geometrically, and a fill frees the OTHER asset so nothing replenishes
 * it. With `B0 = (W/2)(1-d)` the per-side idle buffer at arm and
 * `minBudgetWei = R x 2/d`, the whole thing collapses to a budget RATIO:
 *
 * ```text
 * m = budgetWei / minBudgetWei          N = floor( ln(m) / ln(1/(1-d)) )
 * ```
 *
 * THE RESULT AN OWNER MOST NEEDS: at `m = 1` — the arm's own admission floor —
 * `N = 0`. `d x B0 = m x R x (1-d) = 0.7R < R` at the default, so a ladder armed
 * at exactly the printed minimum budget cannot settle its FIRST fill, ever, with
 * the hedge blocked by its own markout floor in precisely the monotone market
 * that caused it. The budget must exceed `1/(1-d)` x the printed minimum (1.43x
 * at `deployPctBps: 3000`) before ONE settlement is fundable. This is a property
 * of the two functions 3.19 SHIPPED, not of anything 3.20 adds.
 *
 * THE FIRST REVIEW'S M2 FORM IS WITHDRAWN (R3.1(2)): it compared the BUFFER
 * against `minRungWei` where the gate compares `d x buffer`, overstating by 2-3
 * fills at the default and 1 at `d = 0.5`. A mutation restoring it must die.
 *
 * HONEST CAVEAT (C3, from FINDINGS (ay)): the "buffer" is the whole EOA balance
 * of the charged token and is NOT partitioned from the owner's own holdings of
 * it. (az) survived only because 20.5683 USDT of unrelated owner money happened
 * to be sitting there. This number is therefore a lower bound on paper and an
 * upper bound in practice.
 */
export function gridLadderResilience(input: {
  readonly budgetWei: bigint;
  readonly minBudgetWei: bigint | null;
  readonly deployPctBps: number;
}): LpGridLadderResilience {
  const d = input.deployPctBps / 10_000;
  const requiredMultipleBps = Math.ceil(10_000 / (1 - d));
  if (input.minBudgetWei === null || input.minBudgetWei <= 0n) {
    return { fundableFills: null, requiredMultipleBps, minFundableBudgetWei: null };
  }
  // Rounds UP, for the reason every other floor in this file does.
  const minFundableBudgetWei =
    (input.minBudgetWei * BigInt(requiredMultipleBps) + 9_999n) / 10_000n;
  if (input.budgetWei <= 0n) {
    return { fundableFills: 0, requiredMultipleBps, minFundableBudgetWei };
  }
  const m = Number(input.budgetWei) / Number(input.minBudgetWei);
  if (!Number.isFinite(m) || m <= 1) {
    return { fundableFills: 0, requiredMultipleBps, minFundableBudgetWei };
  }
  return {
    fundableFills: Math.max(0, Math.floor(Math.log(m) / Math.log(1 / (1 - d)))),
    requiredMultipleBps,
    minFundableBudgetWei,
  };
}

/**
 * PHASE3.19 item 17 / H3 — THE FUNDING CONJUNCT, as a pure predicate.
 *
 * ─── WHY IT IS A TRIGGER-LEVEL HOLD AND NOT A SAGA-LEVEL PARK (OQ2's ruling) ─
 *
 * Parking in the saga is not a quiet state: a completed-with-SKIP sequence does
 * NOT release its reservation (`lpReservationReleasable` returns `false` the
 * moment any recorded step's journal row is not `ROLLED_BACK`, and `recordSkip`
 * COMMITS its row), so every parked motion would consume one `recenter` slot AND
 * re-anchor `minMinutesBetweenExits` for the whole agent — including the OTHER
 * side, which could still be funded. And parking is the STEADY STATE, not an
 * edge case: on a FILL the freed asset is the OTHER one, so the re-mint must
 * draw the needed asset from the buffer, and after two or three same-direction
 * fills that side is exhausted.
 *
 * So the gate lives at the TRIGGER: failing it is a HOLD that creates no
 * sequence, takes no reservation, touches no lane and does not anchor the
 * spacing gate — and it re-evaluates every cycle for free.
 *
 * ─── THE QUANTITY, IN ONE DENOMINATION (C8) ────────────────────────────────
 *
 * Everything is valued in WBNB through {@link gridLadderValueBaseInQuote}, so
 * the comparison against `minRungWei` (a native-wei figure) is like-for-like:
 *
 * ```text
 * availableQuoteValue = buffer of the CHARGED asset, valued in WBNB
 *                     + (this rung is UNFILLED ? its own exit value : 0)
 * plannedMintValue    = availableQuoteValue x deployPctBps / 10_000
 * require               plannedMintValue >= minRungWei
 * ```
 *
 * The second term is what keeps a DRIFT motion fundable: on a drift the rung
 * still holds the asset its role charges, so its whole principal is about to be
 * freed into the buffer and is genuinely available to the mint. On a FILL the
 * rung holds the OTHER asset and contributes nothing, which is exactly the state
 * H3 says the hedge — not this motion — must resolve.
 *
 * ABSENT BALANCES FAIL CLOSED: a conjunct cannot be satisfied by a number nobody
 * read.
 */
export function gridLadderFunding(input: {
  readonly role: LpGridRole;
  readonly wbnbIsToken0: boolean;
  readonly bufferQuoteWei: bigint | undefined;
  readonly bufferBaseWei: bigint | undefined;
  readonly spotSqrtPriceX96: bigint;
  /** The rung's own value in WBNB wei; counted only when it is UNFILLED. */
  readonly rungExitValueWei: bigint;
  readonly rungIsUnfilled: boolean;
  readonly deployPctBps: number;
  readonly minRungWei: bigint | null;
}): {
  readonly ok: boolean;
  readonly availableQuoteValueWei: bigint;
  readonly plannedMintValueWei: bigint;
  readonly shortfallWei: bigint;
  readonly chargedIsQuote: boolean;
} {
  const chargedIsQuote = input.role === "buy";
  const quote = input.bufferQuoteWei;
  const base = input.bufferBaseWei;
  if (quote === undefined || base === undefined || input.minRungWei === null) {
    return {
      ok: false,
      availableQuoteValueWei: 0n,
      plannedMintValueWei: 0n,
      shortfallWei: input.minRungWei ?? 0n,
      chargedIsQuote,
    };
  }
  const bufferValueWei = chargedIsQuote
    ? quote
    : gridLadderValueBaseInQuote({
        baseWei: base,
        sqrtPriceX96: input.spotSqrtPriceX96,
        wbnbIsToken0: input.wbnbIsToken0,
      });
  const availableQuoteValueWei =
    bufferValueWei + (input.rungIsUnfilled ? input.rungExitValueWei : 0n);
  const plannedMintValueWei =
    (availableQuoteValueWei * BigInt(input.deployPctBps)) / 10_000n;
  const ok = plannedMintValueWei >= input.minRungWei;
  return {
    ok,
    availableQuoteValueWei,
    plannedMintValueWei,
    shortfallWei: ok ? 0n : input.minRungWei - plannedMintValueWei,
    chargedIsQuote,
  };
}

/**
 * PHASE3.19 C9 (L3) — THE FUNDING HOLD'S TEXT.
 *
 * ORDERING IS LOAD-BEARING and it is about a CEILING, not prose: every owner
 * sentence in this plane passes through `sanitizeMessage`, which TRUNCATES at
 * `MAX_MESSAGE_LENGTH` (280). The audited ordering for this builder is
 * **side + shortfall first, one-clause remedy second, NO evidence tail** —
 * rendering the H3 text with real figures and a two-clause remedy exceeds 280
 * before the remedy, and `lpGridArmRefusal` already clips its own tail today.
 *
 * The `hedge.enabled: false` RESIDUAL is named in the text (C12): with the hedge
 * off, a one-sided market parks a side until the market moves it back and the
 * ladder degrades to a one-and-a-half-sided quoter. That is a legitimate v1
 * configuration and the owner must be able to read it off the hold.
 */
export function lpGridLadderFundingHoldReason(input: {
  readonly role: LpGridRole;
  readonly shortfallWei: bigint;
  readonly hedgeEnabled: boolean;
}): string {
  return (
    `Ladder ${input.role} rung waiting on inventory: the idle buffer is `
    + `${input.shortfallWei} wei short of one economic rung. `
    + (input.hedgeEnabled
      ? `The hedge restores this side when markout clears. `
      : `hedge.enabled is false, so only a market move restores this side. `)
    // PHASE3.20 C2 — THE THREE ACTUAL REMEDIES, and the number that makes them
    // urgent. This is the TERMINAL state B1 names: the buffer decays by
    // `deployPctBps` per settlement and the hedge is blocked by its own markout
    // floor in exactly the market that drained it, so "wait" is not on the list.
    // The `1/(1-d)` fact is here because an owner who armed at the printed
    // minimum has a ladder that settles nothing, and this hold is where they
    // find out.
    + `Remedy: add the charged asset, lower deployPctBps, or exit; `
    + `at the printed minimum ZERO fills settle. `
    + `Nothing is spent and no quota is used.`
  );
}

/**
 * PHASE3.20 items 18/19/27 — THE PRE-CHECK'S HOLD TEXT, in the funding hold's
 * own shape.
 *
 * (az) produced 15+ rolled-back `grid-recenter` rows in three minutes because
 * the evaluator dispatched into a quota it could not pass and the STORE did the
 * refusing. The rows are gone; this sentence is their replacement, and D5's view
 * fields are the rest of it (OQ4's declared consequence: the rolled-back rows
 * were the only durable trace that the agent wanted to move and could not).
 *
 * ORDERING (C9): which bound closed + its two figures, then the remedy, inside
 * 280 characters. `lane` names WHICH budget is spent, because "the ladder is out
 * of quota" while the OTHER lane is still open is the wrong thing to tell an
 * owner — the same reason `LpExitQuotaError` writes one sentence per lane.
 */
export function lpGridLadderQuotaHoldReason(input: {
  readonly role: LpGridRole;
  readonly bound: "quota" | "spacing";
  readonly lane: "settlement" | "drift";
  readonly used: number;
  readonly limit: number;
  readonly minMinutesBetweenExits: number;
}): string {
  return input.bound === "quota"
    ? `Ladder ${input.role} rung holds: the ${input.lane} lane is spent `
      + `(${input.used}/${input.limit} in the rolling 24 h), so the motion does not start. `
      + `NO sequence, NO reservation, nothing rolled back, and the price stop stays armed. `
      + `Remedy: raise grid.ladder.${input.lane === "settlement" ? "settlementsPerDay" : "driftMovesPerDay"}, or wait for the window to roll.`
    : `Ladder ${input.role} rung holds: minMinutesBetweenExits `
      + `${input.minMinutesBetweenExits} has not elapsed since this agent's last reservation, `
      + `and that gate is AGENT-WIDE — the other rung's motion anchors it too. `
      + `NO sequence, NO reservation, nothing rolled back. `
      + `Remedy: lower minMinutesBetweenExits, or wait one interval.`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * PHASE3.22 — THE SHIFT LADDER'S PURE LAYER: funding and economics.
 * ──────────────────────────────────────────────────────────────────────────── */

/** PHASE3.22 R4.2.1 — one side's funding verdict, in that side's own asset. */
export type LpGridShiftSideFunding = {
  readonly role: LpGridRole;
  /** The wei this side could mint with, in ITS OWN asset. */
  readonly availableWei: bigint;
  /** {@link availableWei} scaled by `deployPctBps` — what the mint would be. */
  readonly plannedMintWei: bigint;
  /** This side's single-sided mint floor, in its own asset. */
  readonly floorWei: bigint;
  /** `plannedMintWei >= floorWei`, and every input was actually read. */
  readonly fundable: boolean;
  /** `floorWei - plannedMintWei` when short, else `0n`. */
  readonly shortfallWei: bigint;
};

/** PHASE3.22 R4.2.1 — the pair's funding verdict. */
export type LpGridShiftFunding = {
  readonly sell: LpGridShiftSideFunding;
  readonly buy: LpGridShiftSideFunding;
  /**
   * The motion may start. TRUE iff AT LEAST ONE side is fundable — one-sided
   * continuation is the v1 product (decision 9), so a single fundable side is
   * a motion, not a hold.
   */
  readonly ok: boolean;
  /** No TARGETED side clears its floor, so the motion HOLDS. */
  readonly hold: boolean;
  /** Two targets but exactly one is fundable: retained depletion shape. */
  readonly oneSided: boolean;
  /** The roles whose mint call the batch will carry, in the PINNED order. */
  readonly mintRoles: readonly LpGridRole[];
  /** Roles authorized by the target shape; untouched roles are excluded. */
  readonly targetRoles: readonly LpGridRole[];
};

/**
 * PHASE3.22 R11 / P8 — THE TWO PER-SIDE MINT FLOORS, in ONE derivation.
 *
 * ─── THE CONTRADICTION THIS RESOLVES, recorded because the spec has two
 * readings of "that side's single-sided mint floor" ─────────────────────────
 *
 * R11 names `sagaSingleSidedMintFloors` as the floor. That function computes a
 * SLIPPAGE floor FROM a mint's own liquidity, so reading it as the admission
 * floor is circular — it cannot tell you whether a size is big enough, only
 * how much of it you must receive. The other reading available in the spec is
 * the ECONOMIC minimum rung, `minRungWei` from `gridShiftEconomics`, which is
 * the number every other gate in this phase sizes against and which R2.14
 * explicitly calls "ALSO the floor the funding gate sizes against, computed by
 * this same function, so admission and funding cannot disagree".
 *
 * THE ECONOMIC READING IS TAKEN, and it is the FAIL-CLOSED one: it refuses
 * strictly more often than a liquidity-is-positive test would, so a motion
 * this admits is a motion the slippage floors can also express. The slippage
 * floors are still computed at the mint, from the size this gate approved —
 * the two are sequential, not alternatives.
 *
 * ─── WHY IT IS ITS OWN FUNCTION ────────────────────────────────────────────
 *
 * `minRungWei` is a QUOTE-denominated figure and the sell side's floor must be
 * a BASE-denominated one, so exactly one price conversion is needed. Doing it
 * here means {@link gridShiftFunding} stays price-free (it compares amounts in
 * their own assets, which is what the NFPM actually reverts on) and the
 * conversion happens ONCE, in a function the trigger and the mint-build both
 * call — the 3.13 F12 cannot-diverge rule applied to the one number that would
 * otherwise be computed twice at two different prices.
 */
export function gridShiftSideFloors(input: {
  /** The economic minimum rung, in quote wei. `null` ⇒ no size is economic. */
  readonly minRungWei: bigint | null;
  readonly spotSqrtPriceX96: bigint;
  readonly wbnbIsToken0: boolean;
}): { readonly quoteFloorWei: bigint; readonly baseFloorWei: bigint } {
  if (input.minRungWei === null || input.minRungWei <= 0n) {
    // No economic size exists at this geometry. Both floors are set beyond any
    // reachable balance so `gridShiftFunding` answers HOLD rather than
    // admitting a motion the admission gate would have refused.
    return { quoteFloorWei: MAX_UINT256, baseFloorWei: MAX_UINT256 };
  }
  return {
    quoteFloorWei: input.minRungWei,
    baseFloorWei: gridLadderValueQuoteInBase({
      quoteWei: input.minRungWei,
      sqrtPriceX96: input.spotSqrtPriceX96,
      wbnbIsToken0: input.wbnbIsToken0,
    }),
  };
}

/** The unreachable floor {@link gridShiftSideFloors} uses to mean "never". */
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * PHASE3.22 R4.2.1 / P8 — THE ONE FUNDING AUTHORITY, at BOTH seams.
 *
 * P8's one-function-two-seams idiom, which is the shipped one (3.12's
 * `swapSplitIsTotal` at the trigger and inside `collect-fees.build`; 3.16's
 * `lpGridArmRefusal` at the route and at the mint build). The TRIGGER consumes
 * it with the worker's balance reads to decide whether a motion starts at all;
 * the MINT BUILD recomputes it as the fail-closed belt, because price and
 * balances move between the two and the build is the last honest moment.
 *
 * ─── WHY IT IS NOT `gridLadderFunding` WITH AN EXTRA ARGUMENT ───────────────
 *
 * The ladder's function values ONE side in ONE denomination (WBNB) against a
 * native-wei `minRungWei`, because a ladder motion re-places ONE rung. A shift
 * motion mints one or both TARGETED rungs in the SAME batch, and each selected
 * side's comparison must therefore happen in ITS OWN asset — which is what the
 * NFPM actually reverts on. Both floors arrive already denominated by
 * {@link gridShiftSideFloors}, which is where the single price conversion
 * lives, so this function performs NO valuation and reads no price at all.
 *
 * ─── THE ARITHMETIC (R11, as amended by R4.2.1) ─────────────────────────────
 *
 * Per side `i`, in that side's OWN asset:
 *
 * ```text
 * available_i = idleBalance_i                    (the wallet read)
 *             + Σ decreaseFloor_i over the two closing rungs
 * mint_i      = deployPctBps x available_i / 10_000
 * fundable_i  = mint_i >= singleSidedMintFloor_i
 * ```
 *
 * The `Σ decreaseFloor_i` term is what makes the motion self-funding: the two
 * rungs this batch is about to CLOSE return their principal into the wallet in
 * the same submission, before the mints pull from it. Omitting it would price
 * the motion as if it had to find the whole size in idle balance and would
 * hold a pair that is perfectly able to move.
 *
 * ─── THE THREE OUTCOMES, AND WHY ONE-SIDED IS NOT A HOLD (decision 9) ───────
 *
 *  - BOTH fundable ⇒ the 12-call batch, both mints, `mintRoles: [sell, buy]`.
 *  - ONE fundable  ⇒ the motion PROCEEDS one-sided: the batch exits both live
 *    rungs and mints only the fundable side; the depleted side's dust joins
 *    the buffer and its row is CLOSED by the finish (R4.2.2). R3.1's
 *    pause-the-pair posture was WITHDRAWN by decision 9 — the operator's
 *    framing is that depletion risk is the user's decision under their own
 *    `priceStopLoss`/`priceTakeProfit`, which a ladder like HawkFi's does not
 *    even offer. The self-cure is real (R4.2.3): the surviving side's fills
 *    deliver the depleted asset — a sell fill delivers quote, a buy fill
 *    delivers base — so a later motion re-opens the dormant row.
 *  - NEITHER fundable ⇒ trigger-level HOLD. No sequence, no reservation, no
 *    lane charge, no spacing anchor (the R2.10 shape). Nothing can mint, and
 *    R10's rule that a batch containing no mint call is a refusal rather than
 *    a submission is what this hold implements at the trigger.
 *
 * ─── ABSENT BALANCES FAIL CLOSED ────────────────────────────────────────────
 *
 * `walletTokenBalance` is OPTIONAL in the saga deps (the 3.19 charter
 * revision), so an absent reader gives `undefined` and this function answers
 * `hold` — never a guessed size. R2.15's honesty carries verbatim and belongs
 * in every text built off this: the "buffer" is the owner's WHOLE EOA balance
 * of that token, NOT partitioned from their unrelated holdings, so
 * `deployPctBps` prices a number that may include money the owner never
 * allocated to this agent.
 *
 * ─── THE MINT ORDER IS PINNED HERE (R2.2) ───────────────────────────────────
 *
 * `mintRoles` is emitted SELL-then-BUY when both are fundable, which is the
 * 3.17 pin: NFPM ids are sequential, so minting sell first is what makes
 * `sellTokenId < buyTokenId` true, and that assertion is the only guard
 * against attaching the sell NFT to the buy row — a role/asset inversion every
 * later motion would then compute against.
 */
export function gridShiftFunding(input: {
  readonly deployPctBps: number;
  /** Idle WBNB in the owner's EOA. `undefined` ⇒ unread ⇒ fail closed. */
  readonly idleQuoteWei: bigint | undefined;
  /** Idle base token in the owner's EOA. `undefined` ⇒ unread ⇒ fail closed. */
  readonly idleBaseWei: bigint | undefined;
  /** Quote freed by the two closing rungs' `decreaseLiquidity` floors. */
  readonly freedQuoteWei: bigint;
  /** Base freed by the two closing rungs' `decreaseLiquidity` floors. */
  readonly freedBaseWei: bigint;
  /** The single-sided mint floor for a QUOTE-charged (buy) rung. */
  readonly quoteFloorWei: bigint;
  /** The single-sided mint floor for a BASE-charged (sell) rung. */
  readonly baseFloorWei: bigint;
  /** PHASE3.23 R2.5 — only these roles may consume funding or deplete. */
  readonly targetRoles?: readonly LpGridRole[];
}): LpGridShiftFunding {
  // The role/asset mapping is `gridSideChargesQuote`'s, stated as a fact
  // rather than re-derived: a BUY rung is the quote-holding level and a SELL
  // rung the base-holding one. That is a property of the ROLES, not of pool
  // order, so no `wbnbIsToken0` appears in this function at all.
  const side = (
    role: LpGridRole,
    idle: bigint | undefined,
    freed: bigint,
    floorWei: bigint,
  ): LpGridShiftSideFunding => {
    if (idle === undefined) {
      // A conjunct cannot be satisfied by a number nobody read.
      return {
        role,
        availableWei: 0n,
        plannedMintWei: 0n,
        floorWei,
        fundable: false,
        shortfallWei: floorWei,
      };
    }
    const availableWei = idle + freed;
    const plannedMintWei = (availableWei * BigInt(input.deployPctBps)) / 10_000n;
    const fundable = plannedMintWei >= floorWei;
    return {
      role,
      availableWei,
      plannedMintWei,
      floorWei,
      fundable,
      shortfallWei: fundable ? 0n : floorWei - plannedMintWei,
    };
  };
  const sell = side("sell", input.idleBaseWei, input.freedBaseWei, input.baseFloorWei);
  const buy = side("buy", input.idleQuoteWei, input.freedQuoteWei, input.quoteFloorWei);
  const targetRoles = input.targetRoles ?? (["sell", "buy"] as const);
  const mintRoles: LpGridRole[] = [];
  // SELL FIRST — R2.2's pin, so `sellTokenId < buyTokenId` holds (R2.13).
  if (targetRoles.includes("sell") && sell.fundable) mintRoles.push("sell");
  if (targetRoles.includes("buy") && buy.fundable) mintRoles.push("buy");
  const ok = mintRoles.length > 0;
  return {
    sell,
    buy,
    ok,
    hold: !ok,
    oneSided: targetRoles.length === 2 && mintRoles.length === 1,
    mintRoles,
    targetRoles,
  };
}

/**
 * PHASE3.22 R3.1 (as amended by decision 9) — THE FUNDING HOLD'S TEXT, and the
 * ONE-SIDED note's, from ONE builder.
 *
 * The 3.13 F12 cannot-diverge rule: the trigger's hold and the owner view read
 * the same sentence, so an owner cannot be told two different reasons for one
 * state. ORDERING is a CEILING, not prose — every owner sentence passes
 * through `sanitizeMessage`, which TRUNCATES at 280 — so it is state +
 * shortfall first, remedy second, and no evidence tail (the audited 3.19/F12-b
 * ordering).
 */
export function lpGridShiftFundingHoldReason(input: {
  readonly funding: LpGridShiftFunding;
}): string {
  if (input.funding.hold) {
    // Compare TARGETED sides only. In the one-target shape the untouched side
    // may deliberately have no balance read and must never become the remedy.
    const selected = input.funding.targetRoles.map((role) => input.funding[role]);
    const worst = selected.reduce((left, right) =>
      left.shortfallWei >= right.shortfallWei ? left : right);
    if (selected.length === 1) {
      return (
        `Shift ladder holds: the selected ${worst.role} rung cannot fund its mint and is `
        + `${worst.shortfallWei} wei short of its single-sided floor. The untargeted rung is untouched. `
        + `Remedy: top up that asset, lower deployPctBps, or exit and re-arm smaller. `
        + `Nothing is spent and no quota is used.`
      );
    }
    return (
      `Shift ladder holds: NEITHER rung can fund a mint — the ${worst.role} side is `
      + `${worst.shortfallWei} wei short of its single-sided floor, and the other side is short too. `
      + `Remedy: top up the depleted asset, lower deployPctBps, or exit and re-arm smaller. `
      + `Nothing is spent and no quota is used.`
    );
  }
  const dormant = input.funding.sell.fundable ? input.funding.buy : input.funding.sell;
  return (
    `Shift ladder is ONE-SIDED: the ${dormant.role} rung is ${dormant.shortfallWei} wei `
    + `short of its floor, so this motion mints only the other side and closes that row. `
    + `It re-opens by itself when a fill delivers that asset back to the buffer. `
    + `Remedy if you would rather not wait: top up, or lower deployPctBps.`
  );
}

/**
 * GRID-GAS-RESERVE P2 — the shift lane's GAS GATE: may the wallet pay the relay
 * for the NEXT motion?
 *
 * The 2026-09-03 `grid-agent-01-5` incident, measured: a cross fired with
 * 0.000098693 BNB native in wallet B against a ~0.00013 BNB metered 12-call
 * batch; the relay refused the send for a fee deficit AFTER the durable bind,
 * and the row wedged `held/shift-ambiguous` for 246 cycles. The funding
 * conjunct beside this one reads WBNB and the base token — never the pot the
 * relay bills — so nothing stood between a short wallet and the relay.
 *
 * `requiredWei` is `MAX_SUBMISSIONS_PER_GRID_SHIFT` fee UNITS — the SAME
 * constant `checkLpNativeCapSizing` reserves per motion and the marketplace
 * deposits per day — so the gate, the sizing and the deposit cannot disagree.
 * ABSENT inputs FAIL CLOSED (the 3.19 posture): a balance nobody read or a fee
 * nobody supplied cannot satisfy a conjunct. A hold is the R2.10 shape — no
 * sequence, no reservation, no lane charge, re-evaluated free next cycle — and
 * it is a hold on BOTH causes, because the relay bills a drift shift exactly
 * as it bills a settlement.
 */
export type LpGridShiftGasGate = {
  readonly hold: boolean;
  readonly nativeWei: bigint | null;
  readonly requiredWei: bigint | null;
  readonly shortfallWei: bigint;
};

export function gridShiftGasGate(input: {
  readonly nativeWei: bigint | undefined;
  readonly relayFeePerSubmitWei: bigint | undefined;
}): LpGridShiftGasGate {
  if (input.relayFeePerSubmitWei === undefined || input.relayFeePerSubmitWei <= 0n) {
    return { hold: true, nativeWei: input.nativeWei ?? null, requiredWei: null, shortfallWei: 0n };
  }
  const requiredWei = BigInt(MAX_SUBMISSIONS_PER_GRID_SHIFT) * input.relayFeePerSubmitWei;
  if (input.nativeWei === undefined) {
    return { hold: true, nativeWei: null, requiredWei, shortfallWei: requiredWei };
  }
  const shortfallWei = input.nativeWei < requiredWei ? requiredWei - input.nativeWei : 0n;
  return { hold: shortfallWei > 0n, nativeWei: input.nativeWei, requiredWei, shortfallWei };
}

/**
 * The gas hold's owner-facing text. The REMEDY comes FIRST (the PHASE3.13
 * F12-b lesson: `sanitizeMessage` caps at 280 chars and a remedy-last text lost
 * its remedy at the saga seam), then the two figures, in BNB with the wei kept
 * for exactness.
 */
export function lpGridShiftGasHoldReason(gate: LpGridShiftGasGate): string {
  if (gate.requiredWei === null) {
    return (
      "Shift ladder holds: this deployment supplies no relay fee estimate, so the next motion's gas "
      + "cannot be sized. Remedy: set LP_RELAY_FEE_PER_SUBMIT_WEI. Nothing is spent and no quota is used."
    );
  }
  const bnb = (wei: bigint): string => {
    const whole = wei / 10n ** 18n;
    const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").slice(0, 7);
    return `${whole}.${fraction}`;
  };
  if (gate.nativeWei === null) {
    return (
      `Shift ladder holds: deposit BNB to the agent wallet (the next motion needs >= ${bnb(gate.requiredWei)} BNB `
      + `for relay gas) — its native balance could not be read this cycle. Nothing is spent and no quota is used.`
    );
  }
  return (
    `Shift ladder holds: deposit >= ${bnb(gate.shortfallWei)} BNB to the agent wallet. Relay gas for the next `
    + `motion needs ${bnb(gate.requiredWei)} BNB (${gate.requiredWei} wei); the wallet holds ${bnb(gate.nativeWei)} BNB. `
    + `Nothing is spent and no quota is used; the motion retries by itself once funded.`
  );
}

/**
 * PHASE3.22 R2.22 / R3.7 (C6) — WHETHER `/lp/import` ADMITS THIS GRID'S MODE,
 * as an EXHAUSTIVE `never`-bound dispatch.
 *
 * ─── WHY A HELPER AND NOT A SECOND `||` LITERAL ────────────────────────────
 *
 * C6 asked for this shape explicitly, and asked for it because the alternative
 * is the R2.18 hazard applied to ourselves: the shipped refusal was
 * `gridModeOf(grid) === "policy"`, and extending it by writing
 * `=== "policy" || === "shift"` would leave the NEXT mode to fall through
 * silently — which is exactly the silent-inheritance defect this phase spends
 * a whole section enumerating seams to avoid. A `never` binding makes a fifth
 * mode a COMPILE ERROR here rather than an accidental admission.
 *
 * ─── THE GAP C6 SURFACED, FIXED IN THE SAME HELPER ─────────────────────────
 *
 * LADDER mode was never refused by the mode gate at all. It was refused only
 * BY ACCIDENT, one check later, by the tick-mismatch text — because a ladder's
 * rungs float from its first motion and so match no signed rung. That is the
 * WRONG SENTENCE for the situation: it tells an owner their ticks are off by a
 * few and invites them to try again with better ticks, when the truth is that
 * their grid's mode has no import door at all. C1's list named exactly this
 * distinction for policy mode; the same distinction was owed to ladder and was
 * not paid until now.
 *
 * `null` means ADMIT — and `"fixed"` is the only mode that gets it, which is
 * the honest statement of what import is: a door for grids whose rungs are
 * SIGNED and STATIONARY, so an exact-tick match is a real proof of identity.
 *
 * Every returned sentence is spent in the house order against the 280-char
 * `sanitizeMessage` ceiling: the non-reconstructible fact leads, the REMEDY
 * survives, and derivable detail is dropped rather than clipped.
 */
export function lpGridImportModeRefusal(mode: LpGridMode): string | null {
  switch (mode) {
    case "fixed":
      // The only mode with an import door: four signed rungs that never move,
      // so an exact-tick match IS the identity proof admission needs.
      return null;
    case "policy":
      return 'Import refused: this grid\'s mode is "policy", where rungs float and import admits only at a signed rung verbatim — policy mode is non-restartable by import in v1. Remedy: abandon, re-sign coherent rungs at the current tick, then gridArm again.';
    case "ladder":
      // C6's discovered gap. Previously reached the TICK-MISMATCH text, which
      // described the symptom and hid the cause.
      return 'Import refused: this grid\'s mode is "ladder", where both rungs re-anchor on every motion and import admits only at a signed rung verbatim — ladder mode is non-restartable by import in v1. Remedy: abandon, then gridArm again to re-place from the buffer.';
    case "shift":
      return 'Import refused: this grid\'s mode is "shift", where a motion can re-anchor one or both rungs from fresh geometry, so an imported rung cannot be proven to sit at the geometry the next shift derives. Remedy: abandon, then gridArm again — the arm is the only door.';
    default: {
      const unreachable: never = mode;
      throw new Error(
        `lpGridImportModeRefusal: unmapped grid mode ${String(unreachable)}.`,
      );
    }
  }
}

/**
 * PHASE3.22 R4.4 (P6) / R5.6 (D6) — THE SHIFT GROUP LOCK's PREDICATE.
 *
 * ─── MODE FIRST, AND THAT ORDER IS THE WHOLE OF THE BYTE-IDENTITY ARGUMENT ──
 *
 * A LADDER pair also carries `arm_group_id`. A predicate that tested the
 * column first and the mode second would therefore change ladder behaviour on
 * every call — which is exactly what R2's byte-identity requirement forbids.
 * Testing `gridModeOf(grid) === "shift"` FIRST means a ladder, a policy grid
 * and a fixed grid all fall out at the first conjunct and reach code that is
 * byte-for-byte what they reached before this phase.
 *
 * ─── WHY THE LOCK EXISTS ───────────────────────────────────────────────────
 *
 * A shift is ONE sequence that moves TWO positions. Every other guard in this
 * plane is POSITION-scoped, so the sibling of a row with a live shift looks
 * completely free: `getNonTerminalSequence` finds nothing for it, and an
 * owner-signed manual exit against it would dispatch a second saga into the
 * same twelve-call batch's NFTs.
 *
 * ─── WHERE IT IS ENFORCED (R5.6 / D6 — option (ii)) ────────────────────────
 *
 * At exactly TWO seams, and deliberately NOT a third:
 *
 *   (a) the WORKER's cycle, where the group is folded into the RESUME
 *       PARTITION (`resumedPositions`) rather than tested by this predicate
 *       directly — a claimed position is not evaluated, so the sibling loses
 *       its DISPATCH (protect included) while keeping its finalized `ownerOf`
 *       check and its observation write, which is R3.3's wording exactly. The
 *       partition is reached before this predicate would be, and the sequence
 *       KIND is what identifies the group there, so a ladder pair is untouched
 *       by construction. AUDIT A2 found this seam MISSING while three shipped
 *       comments — including this one — asserted it; it exists now, and the
 *       sentence is written to describe the mechanism rather than a call site;
 *   (b) a NEW route-level admission gate on `manual-exit`, which N8 proved is
 *       the one owner door with no route gate at all, and where this predicate
 *       IS called directly.
 *
 * It is also read by the OWNER VIEW, to derive the sibling's
 * `blockedBySequence` from the arm group (R2.4/P7) — a report, not a gate.
 *
 * It does NOT enter `driveSequence`. D6 established that the predicate is not
 * even EVALUABLE there — the conflict check is position-scoped and
 * `buildSagaDeps` lifts individual settings fields and never the grid block —
 * so `driveSequence` keeps its position-scoped check BYTE-IDENTICAL for every
 * saga, and `buildSagaDeps` is untouched. The agent-scoped gates (`gridArm`,
 * import, first-arming settings) already cover the sibling through
 * `getAnyNonTerminalSequence` and get no new guard; abandon needs none,
 * because there is no sequence on the sibling to abandon.
 */
export function gridShiftGroupLock(input: {
  readonly grid: LpGridSettings | null;
  readonly armGroupId: string | null;
}): boolean {
  // MODE FIRST. See the header: a ladder pair carries `arm_group_id` too, and
  // reversing these two conjuncts would change its behaviour.
  if (input.grid === null) return false;
  if (gridModeOf(input.grid) !== "shift") return false;
  return input.armGroupId !== null;
}

/** PHASE3.22 R9 — which conjunct of the G-gate a shift target failed. */
export type LpGridShiftGateFailure =
  /** The target does not strictly exclude the current tick. */
  | "in-range"
  /** The side the target implies is not the side this role charges. */
  | "side"
  /** The funded size rounds to zero liquidity at this range. */
  | "dust";

/**
 * PHASE3.22 R9 — THE ONE G-GATE REFUSAL BUILDER, at BOTH seams.
 *
 * The gate runs (a) at the TRIGGER, where failing it means no decision, and
 * (b) inside the MINT BUILD, where failing it is a zero-money terminal
 * ROLLBACK — the G0 shape, never a hold, because nothing has been submitted
 * and because a held shift freezes BOTH rungs and disarms both price stops.
 * That is far too much blast radius for a target that has merely gone stale;
 * a rollback re-triggers on a later cycle.
 *
 * ONE builder for both, which is the `lpGridArmRefusal` pattern R9 names and
 * the 3.13 F12 cannot-diverge rule: two call-site strings would be two
 * accounts of one refusal, and the worker's would be the one nobody reads.
 *
 * ORDERING IS A CEILING, not prose. Every owner sentence passes through
 * `sanitizeMessage`, which TRUNCATES at 280 characters, so this is
 * what-failed + where first, figures second, and no remedy tail — a shift's
 * remedy is "wait for the next cycle", which is what happens anyway.
 */
export function lpGridShiftRefusal(input: {
  readonly where: "trigger" | "mint";
  readonly failed: LpGridShiftGateFailure;
  readonly role: LpGridRole;
  readonly currentTick: number;
  readonly range: LpGridRange;
}): string {
  const why =
    input.failed === "in-range"
      ? `the target does not strictly exclude the tick`
      : input.failed === "side"
        ? `the target's side does not charge the asset a ${input.role} rung holds`
        : `the funded size rounds to zero liquidity at that range`;
  return (
    `Shift ${input.role} rung refused at the ${input.where}: ${why}. `
    + `Tick ${input.currentTick}, target [${input.range.tickLower}, ${input.range.tickUpper}). `
    + `Nothing was submitted; the motion re-derives its targets on a later cycle.`
  );
}

/**
 * PHASE3.22 R6 — THE SHIFT LANE'S HOLD TEXT.
 *
 * PHASE3.25 R6.5: the 3.20 quota-hold shape over either independent shift
 * lane. It names WHICH bound closed and its two figures first, then the remedy,
 * inside the 280-character ceiling `sanitizeMessage` enforces.
 *
 * The sentence says what the hold's CONSEQUENCE is, because for a shift it is
 * unlike every other lane's: exhaustion freezes BOTH rungs, symmetrically —
 * which is the same state HawkFi's own agent sits in between beats, and is
 * therefore not a malfunction. It also says the price stop STAYS ARMED, since
 * a quota hold creates no sequence and only a HELD SEQUENCE disarms a stop.
 */
export function lpGridShiftQuotaHoldReason(input: {
  readonly lane: "shift-settle" | "shift-drift";
  readonly bound: "quota" | "spacing";
  readonly used: number;
  readonly limit: number;
  readonly motionProjection: number;
  readonly minMinutesBetweenExits: number;
}): string {
  return input.bound === "quota"
    ? input.lane === "shift-settle"
      ? `Shift ladder holds: the settlement cap is spent — ${input.used}/${input.limit} in the rolling 24 h. `
        + `Remedy: raise grid.shift.shiftsPerDay, or wait. The drift allowance is unaffected; both lanes share agent-wide spacing. `
        + `NO sequence, NO reservation, nothing rolled back; the price stop stays armed.`
      : `Shift holds: drift allowance spent — ${input.used}/${input.limit} motions/24 h. `
        + `Remedy: raise grid.shift.driftGasBudgetWei or wait for the window. Settlement is unaffected; spacing remains agent-wide. `
        + `NO sequence or reservation; nothing rolled back; the price stop stays armed.`
    : `Shift ladder holds: minMinutesBetweenExits ${input.minMinutesBetweenExits} has not elapsed `
      + `since this agent's last reservation, and that gate is AGENT-WIDE. `
      + `NO sequence, NO reservation, nothing rolled back. `
      + `Remedy: lower minMinutesBetweenExits, or wait one interval.`;
}

/**
 * PHASE3.22 R7 — THE SHIFT DECISION'S OWN REASON LINE.
 *
 * It names the EVIDENCE (cross or drift) even though both produce the same
 * motion, because an owner reading a cycle log needs to know WHY the ladder
 * moved — and because the two are the pair of readings whose durable counters
 * an operator can check. It names ONE-SIDEDNESS when it applies, since that is
 * the state decision 9 makes ordinary rather than exceptional and the owner
 * view's own explanation keys off the same fact.
 */
export function lpGridShiftReason(input: {
  readonly role: LpGridRole;
  readonly evidence: "cross" | "drift";
  readonly oneSided: boolean;
  readonly currentTick: number;
  readonly buyRange?: LpGridRange;
  readonly sellRange?: LpGridRange;
}): string {
  const targetText = [
    ...(input.buyRange === undefined
      ? []
      : [`buy [${input.buyRange.tickLower}, ${input.buyRange.tickUpper})`]),
    ...(input.sellRange === undefined
      ? []
      : [`sell [${input.sellRange.tickLower}, ${input.sellRange.tickUpper})`]),
  ].join(" and ");
  const count = input.buyRange !== undefined && input.sellRange !== undefined
    ? "both rungs"
    : "one clean rung";
  return (
    `Shift ladder re-anchoring on ${input.evidence} evidence (dispatched by the ${input.role} rung): `
    + `${count} move in ONE submission from tick ${input.currentTick} to ${targetText}.`
    + (input.oneSided
      ? ` ONE-SIDED this motion: the other side is below its mint floor and its row closes.`
      : ``)
  );
}

/** PHASE3.22 R2.14 / C9 — what one shift ladder costs and earns. */
export type LpGridShiftEconomics = {
  readonly edge: LpGridNetEdge;
  /** `gridCycleSubmissions`' shift arm — the REAL count, not the padded one. */
  readonly submissionsPerCycle: number;
  /** The deployed size of ONE rung at this budget. */
  readonly rungSizeWei: bigint;
  /** The smallest rung that clears the gas floor, or `null` if none does. */
  readonly minRungWei: bigint | null;
  /** {@link minRungWei} inverted through `deployPctBps`, or `null`. */
  readonly minBudgetWei: bigint | null;
  /** The 3.20 geometric resilience model, reused verbatim (R2.14). */
  readonly resilience: LpGridLadderResilience;
};

/**
 * PHASE3.22 R2.14 / M2 / C9 — THE ONE SHIFT ECONOMICS BUILDER, at exactly
 * THREE call sites: the arm route, C2's re-sign check 4, and the client
 * transcript.
 *
 * The 3.13 F12 cannot-diverge rule applied to the gate that decides whether a
 * shift ladder is worth arming at all — the same discipline, and the same
 * three seams, as `gridLadderEconomics`. It is a SIBLING rather than a widened
 * ladder function because its input is STRUCTURAL (R2.14: "structural input,
 * not the ladder type") — it takes `deployPctBps` as a number, so nothing here
 * can reach for a `hedge` block that does not exist under this mode.
 *
 * WHAT IT PRICES, and the honesty it owes:
 *
 *  - GROSS edge: the gap+width geometry of the two SIGNED rungs, which is the
 *    spread the ladder QUOTES and NOT the spread it CAPTURES. A re-anchoring
 *    ladder's buy fill happens at one anchor and its sell fill at a later,
 *    different one, and in a trend it captures a NEGATIVE one. That is a third
 *    uncovered term beside adverse selection and slippage, and it is the
 *    DOMINANT one for this mode — more so than for the 3.19 ladder. Cross and
 *    clean drift re-anchor both rungs; mid-fill drift moves only the clean one.
 *  - COST floor: {@link gridCycleSubmissions}' shift arm x the relay constant,
 *    against the DEPLOYED rung size.
 *
 * {@link minRungWei} is ALSO the floor the funding gate sizes against, computed
 * by this same function, so admission and funding cannot disagree.
 *
 * RESILIENCE REUSES `gridLadderResilience` VERBATIM (R2.14 — the body's
 * "recomputed for proportional sizing" was WITHDRAWN): the geometric decay
 * model `N = floor(ln m / ln(1/(1-d)))` is the same model, because the sizing
 * rule `mint_i = d x available_i` is the same rule. What shift mode CHANGES is
 * stated instead of recomputed: BOTH sides carry a floor, and the surviving
 * side's fills replenish the depleted side's asset (every sell fill delivers
 * quote, every buy fill delivers base), which is the self-cure derivation that
 * discharges §10's claim that 3.21 is subsumed FOR SHIFT ROWS.
 */
export function gridShiftEconomics(input: {
  readonly grid: LpGridSettings;
  readonly shift: LpGridShift;
  /** The owner's native budget. `0n` prices only the geometry. */
  readonly budgetWei: bigint;
  readonly relayFeePerSubmitWei: bigint;
  /** C2's override: the LIVE rung's own value, for the re-sign guard. */
  readonly sizeWei?: bigint;
  /**
   * C2's OTHER override: the pair to price, when the caller holds FLOATED live
   * rungs. Absent ⇒ the SIGNED `{buyRange, sellRange}`. Under shift mode EVERY
   * live rung floats from the first motion, so the re-sign guard always passes
   * this — the floated-pair override R2.18 names.
   */
  readonly pair?: {
    readonly buyRange: LpGridRange;
    readonly sellRange: LpGridRange;
    readonly level?: LpGridLevel;
  };
}): LpGridShiftEconomics {
  const submissionsPerCycle = gridCycleSubmissions(input.grid);
  const rungSizeWei =
    input.sizeWei ?? gridLadderRungSizeWei(input.budgetWei, input.shift.deployPctBps);
  const edge = gridNetEdge({
    pair: input.pair ?? {
      buyRange: input.grid.buyRange,
      sellRange: input.grid.sellRange,
    },
    minNetEdgeBps: input.grid.minNetEdgeBps,
    sizeWei: rungSizeWei,
    relayFeePerSubmitWei: input.relayFeePerSubmitWei,
    submissionsPerCycle,
    // The ladder's refusal WORDING, which names the re-anchoring capture
    // hazard above. A shift ladder is a re-anchoring ladder, so the sentence
    // is true of it for the same reason and to a greater degree.
    ladder: true,
  });
  const minRungWei = gridPresetMinEconomicSizeWei({
    grossEdgeBps: edge.grossEdgeBps,
    minNetEdgeBps: edge.minNetEdgeBps,
    relayFeePerSubmitWei: input.relayFeePerSubmitWei,
    submissionsPerCycle,
  });
  // L2's correction, inherited: the operator needs the minimum BUDGET, not the
  // minimum RUNG. They differ by `2 x 10_000 / deployPctBps` — ~6.7x at the
  // default 30% — and printing the rung figure as if it were the budget
  // understates by that factor. Rounds UP, like every other floor here.
  const minBudgetWei =
    minRungWei === null
      ? null
      // PHASE3.25 R2.3 — invert the rung builder's TWO integer floors in their
      // actual order. `ceil(R*20_000/d)` can be odd and one wei too small,
      // making the advertised minimum fail its own final edge check.
      : 2n * (
          (minRungWei * 10_000n + BigInt(input.shift.deployPctBps) - 1n)
          / BigInt(input.shift.deployPctBps)
        );
  return {
    edge,
    submissionsPerCycle,
    rungSizeWei,
    minRungWei,
    minBudgetWei,
    resilience: gridLadderResilience({
      budgetWei: input.budgetWei,
      minBudgetWei,
      deployPctBps: input.shift.deployPctBps,
    }),
  };
}

/** PHASE3.20 item 26 / M3 — why a ladder is still one-sided, in one word. */
export type LpGridLadderBlockedBy = "funding" | "quota" | "spacing" | "none";

/**
 * PHASE3.20 item 26 / C1 — THE ONE CLASSIFIER of a one-sided ladder's blocker,
 * read by the trigger's hold AND by the owner view so the two cannot disagree
 * (the 3.13 F12 rule).
 *
 * THE PRECEDENCE, and it is the evaluator's own order rather than a taste:
 * FUNDING is tested first, because a rung that cannot fund its re-place must not
 * compete for the last settlement slot at all — that is what keeps the B2
 * last-slot comparator from handing the slot to a row that will then hold. Then
 * the LANE, then the SPACING gate, because the pre-check tests them in that
 * order and reports the one that closed.
 *
 * `fundingOk` is OPTIONAL because the two callers know different things. The
 * TRIGGER measures it (it holds the buffer reads, the spot price and
 * `minRungWei`). The OWNER VIEW does not — it takes no pool-state read — so it
 * passes it ABSENT, and a one-sided ladder whose lane and spacing gate are both
 * open is reported as `"funding"`: the terminal state B1 names, and the only
 * remaining explanation for a rung that is neither moving nor gated. Declared,
 * not papered over.
 */
export function gridLadderBlockedBy(input: {
  readonly twoSided: boolean;
  /** A motion is already in flight on one of the rows: nothing is blocking. */
  readonly inFlight?: boolean;
  readonly fundingOk?: boolean;
  readonly laneOpen: boolean;
  readonly spacingOpen: boolean;
}): LpGridLadderBlockedBy {
  if (input.twoSided) return "none";
  if (input.inFlight === true) return "none";
  if (input.fundingOk === false) return "funding";
  if (!input.laneOpen) return "quota";
  if (!input.spacingOpen) return "spacing";
  return "funding";
}

/**
 * PHASE3.20 D2 / item 15 — THE STRANDING BOUND's own sentence, for the cycle it
 * FIRES on.
 *
 * It is a dispatch reason, not a hold: a bound that fires and then holds on
 * funding produces {@link lpGridLadderFundingHoldReason} instead, because
 * funding is the true blocker and naming the clock there would send an owner to
 * the wrong knob (item 15).
 */
export function lpGridLadderStrandedReason(input: {
  readonly role: LpGridRole;
  readonly strandedMinutes: number;
  readonly boundMinutes: number;
  readonly range: LpGridRange;
  readonly target: LpGridRange;
}): string {
  return (
    `Ladder ${input.role} rung at [${input.range.tickLower}, ${input.range.tickUpper}) has held `
    + `the wrong asset for ${input.strandedMinutes} minutes, past its ${input.boundMinutes}-minute `
    + `stranding bound: re-anchoring the SAME side at [${input.target.tickLower}, `
    + `${input.target.tickUpper}) as a SETTLEMENT, regardless of its own cross/drift counters. `
    + `A ladder that quotes only one side is not a ladder.`
  );
}

/**
 * PHASE3.19 H2 rule 2 — THE HEDGE DIRECTION AND SIZE, in pool order, from the
 * BUFFER's two balances valued in ONE denomination.
 *
 * "Over-held" is decided on the buffer, never on "above/below" and never on the
 * rungs — a balance is an amount of a NAMED token, so the decision is
 * orientation-free. The only pool-ordered quantity is the swap's own
 * `tokenInIsToken0`, which the saga copies from `makeSweepStep` verbatim
 * (`direction === "wbnb-to-token" ? wbnbIsToken0 : !wbnbIsToken0`).
 *
 * THE CLAMP IS THREE TERMS (C14), and the third is the one a builder omits:
 *
 * ```text
 * amountIn = min( imbalance,
 *                 maxHedgePctBps x one side's deployed size,
 *                 available - the mint this motion still owes )
 * ```
 *
 * Without the third term a hedge can take the asset the FOLLOWING mint needs and
 * drive every motion into the ladder's single HELD state. The mint reserve is
 * subtracted only when the over-held asset IS the asset this motion's mint
 * charges — the case C14 names, and the only case in which a hedge can make that
 * mint unfundable.
 */
export type LpGridLadderHedgePlan = {
  readonly direction: "wbnb-to-token" | "token-to-wbnb";
  readonly amountInWei: bigint;
  /** The unclamped imbalance, for the owner-facing note. */
  readonly imbalanceWei: bigint;
};

export function gridLadderHedgePlan(input: {
  readonly bufferQuoteWei: bigint;
  readonly bufferBaseWei: bigint;
  readonly spotSqrtPriceX96: bigint;
  readonly wbnbIsToken0: boolean;
  readonly maxHedgePctBps: number;
  /** One side's DEPLOYED size, in native wei. */
  readonly rungSizeWei: bigint;
  /** The asset this motion's mint charges, and how much of it it will take. */
  readonly chargedIsQuote: boolean;
  readonly plannedMintWei: bigint;
}): LpGridLadderHedgePlan | null {
  const baseValueWei = gridLadderValueBaseInQuote({
    baseWei: input.bufferBaseWei,
    sqrtPriceX96: input.spotSqrtPriceX96,
    wbnbIsToken0: input.wbnbIsToken0,
  });
  const quoteValueWei = input.bufferQuoteWei;
  if (baseValueWei === quoteValueWei) return null;
  const sellBase = baseValueWei > quoteValueWei;
  // Selling HALF the difference equalises the two halves.
  const targetSellValueWei = (sellBase ? baseValueWei - quoteValueWei : quoteValueWei - baseValueWei) / 2n;
  if (targetSellValueWei <= 0n) return null;
  // The imbalance, expressed in the OVER-HELD asset's own units.
  const imbalanceWei = sellBase
    ? // Proportional, so the conversion never invents a second price: the book
      // being sold is `bufferBaseWei` worth `baseValueWei`.
      baseValueWei <= 0n
        ? 0n
        : (input.bufferBaseWei * targetSellValueWei) / baseValueWei
    : targetSellValueWei;
  if (imbalanceWei <= 0n) return null;
  // Term 2: the per-hedge cap, as a fraction of one side's DEPLOYED size,
  // expressed in the over-held asset's units.
  const rungInThisAsset = sellBase
    ? gridLadderValueQuoteInBase({
        quoteWei: input.rungSizeWei,
        sqrtPriceX96: input.spotSqrtPriceX96,
        wbnbIsToken0: input.wbnbIsToken0,
      })
    : input.rungSizeWei;
  const capWei = (rungInThisAsset * BigInt(input.maxHedgePctBps)) / 10_000n;
  // Term 3 (C14): never take the asset this motion's mint still owes.
  const available = sellBase ? input.bufferBaseWei : input.bufferQuoteWei;
  const overHeldIsCharged = sellBase ? !input.chargedIsQuote : input.chargedIsQuote;
  const headroom = available - (overHeldIsCharged ? input.plannedMintWei : 0n);
  const amountInWei = [imbalanceWei, capWei, headroom].reduce(
    (smallest, term) => (term < smallest ? term : smallest),
  );
  if (amountInWei <= 0n) return null;
  return {
    direction: sellBase ? "token-to-wbnb" : "wbnb-to-token",
    amountInWei,
    imbalanceWei,
  };
}

/**
 * PHASE3.19 B3 / D1 — THE MARKOUT GATE, against the ladder's durable VWAP book.
 *
 * The book is `{baseWei, costWbnbWei}` — the base this ladder has acquired and
 * what it paid, advanced ONLY from confirmed receipts. Its average is the
 * markout denominator, it is total over the ladder's whole life, and it survives
 * every tokenId replacement — which is what B3 needed and what a rung boundary
 * could not give (rows carry no ticks, and the prior tokenId is replaced on
 * every motion).
 *
 * DIRECTION, both of which must be mutation-killable (item 43):
 *
 * ```text
 * selling BASE  (we hold too much base):  profit when market > book average
 * selling QUOTE (we buy base back):       profit when market < book average
 * ```
 *
 * Compared on the BOOK'S OWN base amount, so the figure is independent of the
 * hedge's size and of any second price.
 *
 * D1 — A ZERO BOOK REFUSES RATHER THAN DIVIDES. When `bookBaseWei` or
 * `bookCostWbnbWei` is zero the average is UNDEFINED, and the gate answers "do
 * not hedge" (a recorded SKIP) instead of dividing. That is also the safe
 * direction: an under-seeded book under-reports inventory and hedges LESS
 * eagerly.
 */
export function gridLadderMarkout(input: {
  readonly direction: "wbnb-to-token" | "token-to-wbnb";
  readonly bookBaseWei: bigint;
  readonly bookCostWbnbWei: bigint;
  readonly spotSqrtPriceX96: bigint;
  readonly wbnbIsToken0: boolean;
  readonly minMarkoutBps: number;
}): { readonly ok: boolean; readonly markoutBps: bigint; readonly defined: boolean } {
  if (input.bookBaseWei <= 0n || input.bookCostWbnbWei <= 0n) {
    return { ok: false, markoutBps: 0n, defined: false };
  }
  const marketValueWei = gridLadderValueBaseInQuote({
    baseWei: input.bookBaseWei,
    sqrtPriceX96: input.spotSqrtPriceX96,
    wbnbIsToken0: input.wbnbIsToken0,
  });
  const markoutBps =
    input.direction === "token-to-wbnb"
      ? ((marketValueWei - input.bookCostWbnbWei) * 10_000n) / input.bookCostWbnbWei
      : ((input.bookCostWbnbWei - marketValueWei) * 10_000n) / input.bookCostWbnbWei;
  return {
    ok: markoutBps >= BigInt(input.minMarkoutBps),
    markoutBps,
    defined: true,
  };
}

/**
 * PHASE3.19 C9 — the hedge's SKIP note, and the ladder saga's own refusal, in
 * ONE builder each so the sentence an owner reads and the check that produced it
 * cannot diverge.
 *
 * Both respect the 280-char ceiling with the same ordering rule: the
 * non-reconstructible fact leads, the one-clause remedy follows, no evidence
 * tail.
 */
export function lpGridLadderHedgeSkipNote(input: {
  readonly why: "disabled" | "balanced" | "markout" | "no-book" | "dust";
  readonly markoutBps: bigint;
  readonly minMarkoutBps: number;
}): string {
  const because =
    input.why === "disabled"
      ? "hedge.enabled is false, so inventory is never traded at market"
      : input.why === "balanced"
        ? "the idle buffer is already two-sided within the hedge's own band"
        : input.why === "no-book"
          ? "the inventory book holds no acquired base, so there is no average to mark out against"
          : input.why === "dust"
            ? "the clamped hedge size is zero once the following mint's funding is reserved"
            : `markout ${input.markoutBps} bps is under the ${input.minMarkoutBps} bps minimum`;
  return (
    `Ladder hedge SKIPPED: ${because}. Nothing was swapped and the motion `
    + `continues; the next motion re-evaluates it.`
  );
}

/**
 * PHASE3.19 C7/H3.3 — the LADDER SAGA's refusals, at the ONE hold it has.
 *
 * `"zap-out"` refusals are plan position 0 of a freshly created sequence, so the
 * throw IS a zero-money terminal rollback. `"mint"` refusals come after the
 * zap-out committed, so the principal is in the wallet and the sequence HOLDS at
 * `pending-mint` — recoverable, retried when the price allows, and abandonable.
 */
export function lpGridLadderRefusal(input: {
  readonly where: "zap-out" | "mint";
  readonly failed: "no-side" | "side-role-mismatch" | "unfunded" | "burned";
  readonly role: LpGridRole;
  readonly currentTick: number;
  readonly target: LpGridRange;
}): string {
  const because =
    input.failed === "no-side"
      ? `tick ${input.currentTick} is INSIDE the persisted target, where no single-sided mint is legal`
      : input.failed === "side-role-mismatch"
        ? `the price moved THROUGH the persisted target, so its side no longer charges the asset a ${input.role} rung holds`
        : input.failed === "burned"
          ? "the rung's NFT is burned on chain"
          : "the buffer no longer funds one rung on this side";
  const terminal = input.where === "zap-out";
  return (
    `Grid ladder refused at the ${input.where}: ${because}. `
    + (terminal
      ? `NOTHING was spent and the rung is untouched.`
      : `Principal SAFE in the wallet, held pending-mint; the worker retries when the price allows.`)
  );
}

/**
 * PHASE3.19 item 35 (review H5, OQ6) — THE MODE-CHANGE REFUSAL's sentence.
 *
 * A `ladder -> policy` re-sign under a live level passes EVERY shipped C2 check
 * (identity from the durable columns, reproducibility if the widths match, the
 * side rule, and the net edge on the signed counter-rung), and from that instant
 * the position is driven by a different machine, spending a different lane,
 * toward a target that may be far from the price — which is FINDINGS (ax)
 * reproduced by a settings change. `ladder -> fixed` is already refused, but by
 * ACCIDENT (a floated rung matches no signed rung), so the guard must be
 * explicit and symmetric over all ordered pairs.
 *
 * C9's ordering: the non-reconstructible fact (how many live levels, under which
 * mode) leads; the one-clause remedy follows; no evidence tail.
 */
export function lpGridModeChangeRefusal(input: {
  readonly liveLevels: number;
  readonly storedMode: LpGridMode;
  readonly newMode: LpGridMode;
}): string {
  return (
    `This agent holds ${input.liveLevels} live grid level(s) signed under mode `
    + `"${input.storedMode}". Changing the mode to "${input.newMode}" under a live level `
    + `changes which machine drives it, which quota lane it spends and where its next `
    + `motion goes. Stand the levels down (exit or abandon), then sign the new mode with gridArm.`
  );
}

/**
 * PHASE3.18 C9 — THE CLIENT'S DEFAULT CLAMP, and the sentence that discloses
 * it, as ONE pure function so the arithmetic and its disclosure cannot diverge.
 *
 * The SERVER's joint rule refuses
 * `maxFlipsPerDay + maxRequotesPerDay > floor(1440/minMinutesBetweenExits)`.
 * At the LP default spacing of 30 minutes the client's defaults fit
 * (12 + 21 = 33 <= 48), but the gate BINDS above 43 minutes: an agent signed at
 * 60 has `reachable = 24`, and the defaults would be refused with a message
 * about a number the owner never chose.
 *
 * So the client lowers its own DEFAULT to fit — and SAYS SO. It never clamps a
 * value the owner typed: a silently lowered signed number is the (ae) shape,
 * and the server still refuses it. The clamp is a convenience, never an
 * authority. It lives HERE rather than in the operator script because it is the
 * mirror image of a validation rule, and the two must be read together.
 */
export function gridRequoteDefaultClamp(input: {
  readonly wanted: number;
  readonly maxFlipsPerDay: number;
  readonly minMinutesBetweenExits: number;
}): {
  readonly value: number;
  readonly clamped: boolean;
  readonly reachable: number;
  readonly note: string | null;
} {
  const reachable = Math.floor(1_440 / input.minMinutesBetweenExits);
  const value = Math.min(input.wanted, Math.max(1, reachable - input.maxFlipsPerDay));
  const clamped = value < input.wanted;
  return {
    value,
    clamped,
    reachable,
    note: clamped
      ? `CLAMPED from the default ${input.wanted} to ${value}: minMinutesBetweenExits `
        + `${input.minMinutesBetweenExits} allows ${reachable} sequences a day in total and `
        + `maxFlipsPerDay is ${input.maxFlipsPerDay}. The server REFUSES an unreachable pair; `
        + `this client lowers its own DEFAULT rather than signing one, and never lowers a `
        + `number you typed.`
      : null,
  };
}

/**
 * THE ONE SENTENCE the requote's refusals speak with — the same
 * cannot-diverge rule {@link lpGridFlipReason} and {@link lpGridArmRefusal}
 * follow, and the same 280-character `sanitizeMessage` budget: the fact an
 * owner cannot reconstruct leads, the derivable evidence goes last.
 */
export function lpGridRequoteRefusal(input: {
  readonly where: "trigger" | "zap-out" | "mint";
  readonly failed: "in-range" | "filled" | "no-side" | "residue" | "leg-contradiction";
  readonly currentTick: number;
  readonly range: LpGridRange;
  readonly role: LpGridRole;
}): string {
  const because =
    input.failed === "in-range"
      ? `tick ${input.currentTick} drifted back INSIDE the level, so there is nothing to re-centre`
      : input.failed === "filled"
        ? `the level FILLED before the re-centre ran; a fill is settled by the flip, never by a requote`
        : input.failed === "no-side"
          ? `tick ${input.currentTick} is INSIDE the re-centred range, where no single-sided mint is legal`
          : input.failed === "residue"
            ? `the off-side leg is over the ${SWAPLESS_MAX_RESIDUE_BPS} bps bound`
            : `the re-centred side needs a leg the wallet does not hold`;
  const terminal = input.where !== "mint";
  return (
    `Grid requote refused at the ${input.where}: ${because}. `
    + (terminal
      ? `NOTHING was spent and the level is untouched — a re-centre is discretionary, so it rolls back rather than parking the position. `
      : `Principal SAFE in the wallet, held pending-mint; the worker retries when the price allows. `)
    + `Evidence: ${input.role} level [${input.range.tickLower}, ${input.range.tickUpper}).`
  );
}

/**
 * PHASE3.19 — the LADDER motion's own sentence, naming WHICH evidence fired.
 *
 * One builder for both triggers, because they produce one motion: the sentence
 * differs only in the word that names the evidence, and two builders would be
 * two accounts of one decision.
 */
export function lpGridLadderReason(input: {
  readonly role: LpGridRole;
  readonly trigger: "fill" | "drift";
  readonly range: LpGridRange;
  readonly target: LpGridRange;
  readonly currentTick: number;
}): string {
  return (
    `Ladder ${input.role} rung at [${input.range.tickLower}, ${input.range.tickUpper}) `
    + (input.trigger === "fill"
      ? `FILLED on two consecutive finalized evaluations`
      : `DRIFTED past its threshold on two consecutive finalized evaluations`)
    + `: re-anchoring the SAME side at [${input.target.tickLower}, ${input.target.tickUpper}) `
    + `from tick ${input.currentTick}, funded from the idle buffer. A fill's proceeds join `
    + `the buffer; the hedge, not this motion, restores the other side.`
  );
}

/** The requote decision's own sentence, naming the two figures it fired on. */
export function lpGridRequoteReason(input: {
  readonly role: LpGridRole;
  readonly level: LpGridLevel;
  readonly range: LpGridRange;
  readonly target: LpGridRange;
  readonly currentTick: number;
  readonly driftBps: bigint;
  readonly thresholdBps: bigint;
}): string {
  return (
    `Grid level ${input.level} ${input.role} at [${input.range.tickLower}, ${input.range.tickUpper}) has drifted `
    + `${input.driftBps} bps from tick ${input.currentTick}, over its ${input.thresholdBps} bps policy threshold, `
    + `on two consecutive finalized evaluations. Re-centring on the SAME side into `
    + `[${input.target.tickLower}, ${input.target.tickUpper}) — no swap, no conversion, same asset.`
  );
}

/* -------------------------------------------------------------------------- */
/* The evaluator                                                              */
/* -------------------------------------------------------------------------- */

export type EvaluateGridTriggersInput = EvaluateLpTriggersInput & {
  /** The parsed settings, whose `grid` block MUST be present. */
  readonly settings: LpAutomationSettings;
  /**
   * PHASE3.19 — the deployment's per-submission relay constant, needed by the
   * LADDER's funding conjunct: `ladderMinMintWei` IS `gridLadderEconomics`'
   * `minRungWei`, computed by the SAME function the arm admits on, so the gate
   * and the admission cannot disagree (M1 / the 3.13 F12 rule).
   *
   * OPTIONAL, so every non-ladder caller and every 3.15-3.18 fixture is
   * unchanged. ABSENT under ladder mode FAILS CLOSED into the funding hold: a
   * gate cannot be satisfied by a constant nobody supplied.
   */
  readonly relayFeePerSubmitWei?: bigint;
  /**
   * PHASE3.20 items 17/18 (OQ4, H3, H5, C9) — THE LADDER'S OWN LANE USAGE, read
   * PER POSITION by the worker immediately before the dispatch branch.
   *
   * WHY PER POSITION AND NOT PER CYCLE (H3): the worker's position loop is flat
   * and each `evaluatePosition` is awaited, so a ladder's TWO rows are evaluated
   * in sequence. A usage read shared across the cycle would show both rows the
   * same pre-decrement number: row 1 reserves, row 2 passes the pre-check and is
   * then refused at `reserveSequence` — producing exactly the rolled-back row
   * (az) recorded 15 times in three minutes.
   *
   * FAIL-CLOSED, THREE RULES (C9):
   *
   *  - an ABSENT lane count is `usage = limit`, never zero. `LpQuotaUsage`'s
   *    lane fields are optional with a documented `?? 0` convention that is safe
   *    for a DASHBOARD and unsafe for a GATE (H5);
   *  - a `quotaUsage` read that THROWS reaches here as this object with BOTH
   *    counts absent, which is a hold — the buffer reads' own posture;
   *  - `latestReservedAtMs: null` means NO ANCHOR, which is permissive and
   *    correct, and is distinguishable from "not read" only because the whole
   *    object is then absent.
   *
   * ABSENT ENTIRELY ⇒ the pre-check does not run and the 3.15-3.19 path is
   * byte-identical. The worker supplies it unconditionally under ladder mode, so
   * absence means "not a ladder, or a fixture"; `reserveSequence`'s own QUOTA
   * refusal remains the second net either way (item 19).
   */
  readonly ladderQuotaUsage?: {
    readonly settlementLiveCount?: number;
    readonly driftLiveCount?: number;
    readonly latestReservedAtMs: number | null;
  };
  /**
   * PHASE3.20 item 16 / R3.5 mechanism (a) / B2 — THE LAST-SLOT ARBITRATION.
   *
   * The cycle's position list is already loaded, so the worker threads this
   * row's own id and its ladder SIBLINGS' persisted stranding stamps (siblings
   * identified by `arm_group_id`). It is consulted ON THE LAST-SLOT PATH ONLY:
   * when the settlement lane has exactly one slot left and both rows want it,
   * the row with the OLDER stamp takes it and the other HOLDS.
   *
   * THE COMPARATOR IS TOTAL, and that is B2 rather than tidiness: the cycle
   * clock is FROZEN, so two rungs a price gap fills in the SAME cycle carry the
   * IDENTICAL millisecond. Under a strict "older wins" NEITHER would win, both
   * would hold, and the stamp never advances — a SECOND permanent one-sided
   * state, created by the rule written to prevent the first. Ties break on the
   * lexicographically smaller `positionId`.
   *
   * TWO DECLARED PROPERTIES (clearance 2b). The sibling's stamp is read ONE
   * CYCLE STALE in one direction — the row evaluated first sees the other's
   * PREVIOUS observation — which can idle the slot for one interval and can
   * never starve. And the positions array is a cycle-start SNAPSHOT, so a
   * sibling closed earlier in the same cycle has had its observation deleted,
   * reads as having no stamp, and this row wins: the correct direction.
   */
  readonly ladderArbitration?: {
    readonly positionId: string;
    readonly siblings: readonly {
      readonly positionId: string;
      readonly mismatchSinceMs: number | null;
    }[];
  };
  /**
   * PHASE3.22 R5.5 (REVIEW4 D5, D8) — THE SHIFT PAIR'S LIVE ROW SET, as a
   * CYCLE-START SNAPSHOT.
   *
   * ONE input answers TWO questions, which is why it exists at all rather than
   * as two: WHICH row of the pair dispatches, and WHETHER the sibling's
   * evidence may be read.
   *
   * ─── THE DYNAMIC DISPATCHER (R4.2.4 / P4) ─────────────────────────────────
   *
   * R2.3 point 3's "dispatch is gated on `gridRole === "buy"`, the anchor is
   * the ONLY dispatcher" is SUPERSEDED and was the single highest-risk
   * superseded rule in the stack (it is the more implementable-sounding of the
   * two). It has no answer for a pair whose BUY row is gone — closed by
   * depletion, by an ownership loss, or by an owner's single-rung manual exit
   * — and all three are reachable.
   *
   * The rule is: **the buy-role row dispatches WHEN IT IS LIVE; otherwise the
   * surviving sell-role row does.** Never both, which is what makes one motion
   * per pair structural rather than a flag. A pair with both rows closed is
   * simply over, and re-arming is the restart.
   *
   * ─── D8's ABSENT-SIBLING RULE, on the same input ──────────────────────────
   *
   * R4.4/P9 re-founded the sibling's evidence on its DURABLE OBSERVATION row,
   * which is right for the two-live case and has NO SOURCE in the one-sided
   * one: closing a position DELETES its observation (three retention sites),
   * and a closed row is outside `listOpenPositionsForWorker` so it never writes
   * another. Worse, there is a window before the retention sweep in which the
   * row still exists and is STALE — cross/drift counters computed against a
   * range whose position no longer exists — and a union trigger reading it
   * would fire the surviving row's motion on a DEAD rung's evidence.
   *
   * So: {@link shiftSibling} is ABSENT whenever the sibling is not in this live
   * set, the union degenerates to the surviving row's own evidence, and a
   * still-present-but-stale dormant observation is NEVER read.
   *
   * ─── TWO INHERITED PROPERTIES, declared because the input they copy
   * declares them ──────────────────────────────────────────────────────────
   *
   * It is a CYCLE-START SNAPSHOT built from the worker's already-loaded
   * position list (the `ladderArbitration` threading pattern, zero extra
   * reads), so a sibling closed EARLIER IN THE SAME CYCLE reads as absent —
   * the correct direction here, because the survivor then dispatches next
   * cycle and never both in one. And sibling evidence is ONE CYCLE STALE in one
   * direction, which is the same bound P5 re-aims the C3 test at.
   *
   * ABSENT ENTIRELY ⇒ no shift decision is emitted. Fail-closed: a dispatcher
   * that cannot see the pair must not assume it is the one to move it.
   */
  readonly shiftGroupLiveRoles?: {
    /** This row's own role, from the durable columns. */
    readonly role: LpGridRole;
    /** Every LIVE role in the arm group at cycle start, this row included. */
    readonly liveRoles: readonly LpGridRole[];
  };
  /**
   * PHASE3.22 R2.3 point 2 (as superseded by R4.4/P9 and D8) — THE SIBLING
   * RUNG'S EVIDENCE, from its DURABLE OBSERVATION ROW.
   *
   * NO `range` FIELD. R2.3's original shape carried one and P9 proved it has no
   * source: position rows carry no ticks, and re-reading the sibling's NFT to
   * get them would be a chain read the trigger has no business making. What the
   * sibling's own evaluation ALREADY computed and persisted is its cross and
   * drift readings, and those are exactly what the union needs.
   *
   * THE UNION IS THE POINT (R7): the pair's motion condition is that EITHER
   * row's cross or drift evidence is ready, because a fill on either rung means
   * the whole ladder should re-anchor. Without it a sell-side fill would wait
   * for the buy row to drift, which may never happen.
   *
   * ABSENT whenever the sibling is not live (D8) — the union then degenerates
   * to this row's own evidence, which is the honest reading of a one-sided
   * pair.
   */
  readonly shiftSibling?: {
    readonly role: LpGridRole;
    readonly gridCrossConsecutive: number;
    readonly gridDriftConsecutive: number;
    readonly crossSide?: SwaplessRotationSide;
    readonly driftSide?: SwaplessRotationSide;
    /** PHASE3.23 R3.6: absent is explicitly unknown, never inferred. */
    readonly gridRangeRelation?: "inside" | "outside";
  };
  /**
   * PHASE3.22 R2.21 / R6 — THE SHIFT LANE'S USAGE, read PER POSITION by the
   * worker immediately before the dispatch branch.
   *
   * PHASE3.25 R5.2 keeps the ladder's fail-closed rules but gives settlement
   * and drift independent counts: an ABSENT applicable count is
   * `usage = limit` and never zero; a `quotaUsage` read that throws arrives as
   * this object with the count absent, which is a hold;
   * `latestReservedAtMs: null` means no anchor, which is permissive and correct.
   *
   * Exhaustion is a TRIGGER-LEVEL HOLD (the 3.20 rule): no sequence, no
   * reservation, no lane charge, no spacing anchor. Its consequence is
   * lane-specific: the other allowance remains usable, subject to their shared
   * agent-wide spacing gate.
   */
  readonly shiftQuotaUsage?: {
    readonly shiftLiveCount?: number;
    readonly shiftSettleLiveCount?: number;
    readonly shiftDriftLiveCount?: number;
    readonly latestReservedAtMs: number | null;
  };
};

/**
 * The grid agent's decision gate — protect (priority 0) > grid-flip > hold.
 *
 * IT RETURNS THE SAME SHAPE `evaluateLpTriggers` DOES, deliberately: the worker
 * persists the observation, logs the trigger reason and dispatches from one
 * code path, and a second result type would need a second one.
 *
 * The protect priority is the SAME comparison the standard evaluator runs
 * (`evaluateLpProtectSignal`), and it keeps priority for a position with
 * nothing in flight. It does NOT keep priority once a flip is non-terminal:
 * the worker RESUMES such a position and never evaluates it, so nothing here
 * runs at all. That is stated plainly rather than claimed away (R2.4/H4), and
 * `lpProtectionStatus` already reports it as `armed: false` +
 * `blockedBySequence`.
 */
export function evaluateGridTriggers(
  input: EvaluateGridTriggersInput,
): EvaluateLpTriggersResult {
  const { market, nowMs, position, previousObservation, settings } = input;
  const grid = settings.grid;
  if (grid === null) {
    throw new Error(
      "evaluateGridTriggers: the settings carry no grid block; the worker must not route a non-grid agent here.",
    );
  }
  const spotTwapDeviationBps = priceDeviationBps(
    market.spotSqrtPriceX96,
    market.twapSqrtPriceX96,
  );
  const railsFailure = checkManipulationRails(market, input.rails);
  const railsPassed = railsFailure === undefined;

  const { previousIsStale, settingsUnchanged, previousIsComparable } =
    lpObservationComparability({
      intervalMs: input.intervalMs,
      ...(input.maxObservationAgeMs === undefined
        ? {}
        : { maxObservationAgeMs: input.maxObservationAgeMs }),
      nowMs,
      ...(input.settingsDigest === undefined
        ? {}
        : { settingsDigest: input.settingsDigest }),
      ...(previousObservation === undefined ? {} : { previousObservation }),
      blockNumber: market.blockNumber,
      tokenId: position.tokenId,
      poolAddress: position.poolAddress,
    });

  const protect = evaluateLpProtectSignal({
    position,
    settings,
    ...(previousObservation === undefined ? {} : { previousObservation }),
    previousIsComparable,
    settingsUnchanged,
  });

  /* ----- the cross hysteresis ---------------------------------------------- */

  // PHASE3.17 R2.5: `{level, role}`, so a dual grid's two ladders evaluate
  // against their OWN pairs. The evaluator itself is otherwise unchanged — it
  // has always been per-position, which is why two levels need no second
  // evaluator, only an honest answer to "which level is this".
  // PHASE3.18 C1: mode-aware. FIXED mode is `gridLiveRole` byte for byte;
  // POLICY mode reads the durable columns, because a requoted rung equals no
  // signed rung and an exact-tick match would return `null` from the first
  // re-centre onward — killing the flip, which is the defect C1 is about.
  const roleAt = gridRoleAtFor(grid, position, {
    ...(position.gridLevel === undefined ? {} : { gridLevel: position.gridLevel }),
    ...(position.gridRole === undefined ? {} : { gridRole: position.gridRole }),
  });
  const role = roleAt?.role ?? null;
  const liveRange: LpGridRange = { tickLower: position.tickLower, tickUpper: position.tickUpper };
  const cross =
    role === null
      ? { side: undefined, filled: false }
      : gridCrossReading({
          currentTick: position.currentTick,
          range: liveRange,
          role,
          wbnbIsToken0: grid.wbnbIsToken0,
        });
  // Two consecutive finalized observations at least one interval apart, on the
  // SAME side, under the SAME signed settings — the protect counter's own
  // discipline, made durable by PHASE3.2 and applied here for the same reason.
  //
  // REVERSAL RESETS IT. A V3 fill is reversible until settlement, so an
  // observation that finds the tick back inside (or on the near side of) the
  // live range returns the count to zero. That is the whole defence against
  // flipping on a wick.
  const previousSideMatches =
    cross.side !== undefined && previousObservation?.gridCrossSide === cross.side;
  const gridCrossConsecutive =
    cross.filled && previousIsComparable && settingsUnchanged && previousSideMatches
      ? (previousObservation?.gridCrossConsecutive ?? 0) + 1
      : cross.filled ? 1 : 0;

  /* ----- the drift hysteresis (PHASE3.18 R2.8) ----------------------------- */

  // POLICY MODE ONLY, and gated on the block being present. A `mode: "fixed"`
  // grid never reads `grid.policy`/`grid.requote` (they are refused at signing)
  // and never emits `grid-requote`: the byte-identity pin R2.13 requires.
  const mode = gridModeOf(grid);
  const policy = mode === "policy" ? grid.policy : undefined;
  const requoteSettings = mode === "policy" ? grid.requote : undefined;
  // PHASE3.19 — the LADDER's own block, read only under its own mode, exactly as
  // the policy pair above is. A fixed or policy grid never reads it and a ladder
  // never reads theirs, which is the byte-identity pin every grid phase carries.
  const ladder = mode === "ladder" ? grid.ladder : undefined;
  // PHASE3.22 R2.18 — the SHIFT's own block, read ONLY under its own mode,
  // exactly as the three blocks above it are. This is the 3.19-M5
  // silent-inheritance seam: a shift grid must read NEITHER `grid.policy` NOR
  // `grid.ladder`, and the `mode === "shift" ? … : undefined` shape is what
  // makes that structural rather than a convention. `tsc` does not police these
  // ternaries — which is exactly why R2.18 enumerates them by name.
  const shift = mode === "shift" ? grid.shift : undefined;
  const drift =
    roleAt === null
      ? null
      // PHASE3.22 R7 — the SHIFT's drift reading. The SAME function, the SAME
      // 3.13 F1 floor (`max(gap x (1 + drift/100), gap + tickSpacing)`); only
      // the signed block differs. The floor is load-bearing here for the M8
      // reason and MORE so than for the ladder: a shift re-anchors its targets
      // on every motion, so without it a `gapTicks: 0` grid would re-fire
      // against its own freshly placed targets for ever.
      : shift !== undefined && shift.driftPctOfGap !== 0
        ? gridDriftReading({
            currentTick: position.currentTick,
            range: liveRange,
            role: roleAt.role,
            wbnbIsToken0: grid.wbnbIsToken0,
            // The SHIFT's own gap, DIRECTLY — never `gridPolicyGapFor`, which
            // reads a `grid.policy` that does not exist in this mode.
            gapTicks: shift.gapTicks,
            tickSpacing: grid.tickSpacing,
            driftPctOfGap: shift.driftPctOfGap,
          })
      // ITEM 16 — THE 3.13 F1 DRIFT FLOOR IS INHERITED VERBATIM. The reading is
      // the SAME function in both modes; only the gap and the drift percentage
      // come from a different signed block. The floor
      // (`max(gap x (1 + drift/100), gap + tickSpacing)`) is inside it, and it
      // is load-bearing here for the reason M8 gives: because a ladder CHASES,
      // a fill's own motion re-anchors at `gap + (0..spacing)` ticks of drift,
      // so without the floor a `gapTicks: 0` ladder re-fires for ever — F1
      // exactly, in a mode that fires far more often than the requote does.
      : ladder !== undefined
        ? gridDriftReading({
            currentTick: position.currentTick,
            range: liveRange,
            role: roleAt.role,
            wbnbIsToken0: grid.wbnbIsToken0,
            // ITEM 12: the LADDER's own gap, DIRECTLY — never `gridPolicyGapFor`,
            // which reads a `grid.policy` that does not exist in this mode.
            gapTicks: ladder.gapTicks,
            tickSpacing: grid.tickSpacing,
            driftPctOfGap: ladder.driftPctOfGap,
          })
        : policy === undefined || requoteSettings === undefined
          ? null
          : gridDriftReading({
              currentTick: position.currentTick,
              range: liveRange,
              role: roleAt.role,
              wbnbIsToken0: grid.wbnbIsToken0,
              gapTicks: gridPolicyGapFor(grid, policy, roleAt.level, roleAt.role),
              tickSpacing: grid.tickSpacing,
              driftPctOfGap: requoteSettings.driftPctOfGap,
            });
  // Its OWN counter, resetting independently of the cross counter — R2.8
  // refused sharing precisely so neither can erase the other's anti-wick
  // evidence. REVERSAL RESETS: an observation that finds the level back inside
  // its threshold (or on the other side) returns the count to zero.
  const previousDriftSideMatches =
    drift?.side !== undefined && previousObservation?.gridDriftSide === drift.side;
  const gridDriftConsecutive =
    drift !== null
    && drift.drifted
    && previousIsComparable
    && settingsUnchanged
    && previousDriftSideMatches
      ? (previousObservation?.gridDriftConsecutive ?? 0) + 1
      : drift?.drifted === true ? 1 : 0;
  // The requote's TARGET, derived ONCE here and carried to the dispatch, which
  // PERSISTS it on the sequence row (R2.3/C4). A derivation on resume would
  // bind a target the trigger never saw — the property `targetRange`'s "Never
  // derived" contract exists to forbid, and the one FINDINGS (aw) makes the
  // DEFAULT path rather than an edge case.
  const requoteTarget =
    drift === null
    || roleAt === null
    || policy === undefined
    || ladder !== undefined
    // PHASE3.22 R2.18 — and a SHIFT grid never produces a requote target
    // either. Stated as its own conjunct rather than relying on `policy` being
    // undefined under shift mode: the ladder's conjunct is written the same
    // way, and a mode gate that depends on another mode's block being absent is
    // the silent-inheritance shape this phase is enumerating seams to avoid.
    || shift !== undefined
    || !drift.drifted
      ? null
      : safeRequoteTarget({
          grid,
          policy,
          level: roleAt.level,
          role: roleAt.role,
          currentTick: position.currentTick,
        });

  // THE TARGET, mode-aware. Fixed/policy: this level's SIGNED opposite rung
  // (ruling Q5, untouched). LADDER: the CHASE — the SAME role's rung, derived at
  // `anchor +/- ladder.gapTicks` from the CURRENT tick (R2.4/OQ5, as measured).
  // A ladder never targets the opposite rung, because in ladder mode a fill's
  // motion and a drift's motion are the same motion.
  const target =
    roleAt === null
      ? null
      : ladder !== undefined
        ? safeGridLadderTarget({
            grid,
            ladder,
            role: roleAt.role,
            currentTick: position.currentTick,
          })
        : gridTargetRange(grid, roleAt.level, roleAt.role);
  // G1 (R2.3): the flip decision is only EMITTED while the current tick is
  // strictly outside the TARGET range. A single-sided mint into a range that
  // contains the tick would be sized by the dust leg — the 3.12 lesson applied
  // at birth rather than after two submissions have confirmed.
  const targetSide =
    target === null ? undefined : gridTargetSide(position.currentTick, target);

  /* ----- the stranding clock (PHASE3.20 items 12/13, C7) ------------------- */

  // ITEM 11 — THE MISMATCH PREDICATE IS `cross.filled`, REUSED VERBATIM. No new
  // predicate is written and none may be: `gridCrossReading` is already
  // pool-order-correct in BOTH orientations by construction — a `buy` rung
  // mismatches iff it no longer charges the quote, a `sell` rung iff it does —
  // and a hand-written second derivation is the 3.13 F7 class.
  //
  // THE THREE-WAY RULE (R3.4/C7), and the middle arm is the finding:
  //
  //   mismatched                      -> SET, or keep the stamp already there
  //   side exists AND not mismatched  -> CLEAR (the rung is back on its own side)
  //   side undefined (tick INSIDE)    -> CARRY FORWARD UNCHANGED
  //
  // A tick inside the live range reads `{side: undefined, filled: false}`, so a
  // naive "clear when not mismatched" would reset the clock on every chop — and
  // a chop is the market this bound exists for. Carrying forward is safe because
  // the bound may only FIRE on a cycle whose OWN reading is mismatched, so a
  // carried stamp can never authorize a motion on an in-range rung.
  //
  // Carried forward UNCONDITIONALLY with respect to `previousIsComparable`,
  // `settingsUnchanged` and `previousIsStale` — the opposite of the two counters
  // above, for the reason `LpTriggerObservation.gridMismatchSinceMs` states.
  //
  // LADDER MODE ONLY: a fixed- or policy-mode observation never carries the key,
  // so its bytes are identical to 3.15-3.19's.
  const previousMismatchSinceMs = previousObservation?.gridMismatchSinceMs;
  const gridMismatchSinceMs =
    ladder === undefined
      ? undefined
      : cross.filled
        ? (previousMismatchSinceMs ?? nowMs)
        : cross.side !== undefined
          ? undefined
          : previousMismatchSinceMs;

  const nextObservation: LpTriggerObservation = {
    blockNumber: market.blockNumber,
    currentTick: position.currentTick,
    evaluatedAtMs: nowMs,
    poolAddress: position.poolAddress,
    ...(protect.protectBreach === undefined
      ? {}
      : { protectBreach: protect.protectBreach }),
    ...(protect.protectBreachClass === undefined
      ? {}
      : { protectBreachClass: protect.protectBreachClass }),
    ...(input.settingsDigest === undefined
      ? {}
      : { settingsDigest: input.settingsDigest }),
    protectConsecutive: protect.protectConsecutive,
    // A grid agent never rotates: the standard rotation fields are recorded as
    // "no breach" so one observation row shape serves both evaluators.
    rotationBreach: false,
    rotationConsecutive: 0,
    gridCrossConsecutive,
    ...(cross.side === undefined || !cross.filled ? {} : { gridCrossSide: cross.side }),
    // PHASE3.18: emitted ONLY when the drift count is live, so a fixed-mode
    // observation is byte-identical to 3.15-3.17's.
    ...(gridDriftConsecutive > 0 ? { gridDriftConsecutive } : {}),
    ...(drift?.drifted === true && drift.side !== undefined
      ? { gridDriftSide: drift.side }
      : {}),
    // PHASE3.23 R2.3/R3.6: shift-only and emitted on EVERY evaluation,
    // including driftPctOfGap=0. Fixed/policy/ladder bytes remain unchanged.
    ...(shift === undefined || roleAt === null
      ? {}
      : { gridRangeRelation: cross.side === undefined ? "inside" as const : "outside" as const }),
    // PHASE3.20: present only under ladder mode and only while the clock runs,
    // so every fixed/policy observation is byte-identical to 3.15-3.19's.
    ...(gridMismatchSinceMs === undefined ? {} : { gridMismatchSinceMs }),
    tokenId: position.tokenId,
  };

  const pnlBps = position.basisWei > 0n
    ? ((position.exitValueWei - position.basisWei) * 10_000n) / position.basisWei
    : undefined;
  const staleFlag = previousIsStale
    ? { previousObservationDiscarded: "stale" as const }
    : previousObservation !== undefined
        && !settingsUnchanged
        && (previousObservation.protectConsecutive > 0
          || (previousObservation.gridCrossConsecutive ?? 0) > 0
          || (previousObservation.gridDriftConsecutive ?? 0) > 0)
      ? { previousObservationDiscarded: "settings-changed" as const }
      : {};

  const build = (decision: LpManagementDecision, reason: string): EvaluateLpTriggersResult =>
    buildGridResult({
      decision,
      input,
      nextObservation,
      pnlBps,
      railsPassed,
      reason,
      spotTwapDeviationBps,
      ...staleFlag,
      ...(decision.startsWith("protect-") && protect.protectThresholdBps !== undefined
        ? { thresholdBps: protect.protectThresholdBps }
        : {}),
      ...(protect.firedTrigger === null || !decision.startsWith("protect-")
        ? {}
        : {
            triggerTick: protect.firedTrigger.tick,
            triggerWhen: protect.firedTrigger.when,
          }),
    });

  /* ----- priority 0: protect ----------------------------------------------- */

  if (protect.dispatch !== undefined && protect.protectConsecutive >= 2 && railsPassed) {
    return build(protect.dispatch.decision, protect.dispatch.reason);
  }

  /* ----- priority 1: the ATOMIC LADDER's shift (PHASE3.22) ------------------ */

  // ONE decision for the PAIR (R7). Both triggers use the same atomic saga;
  // cross and clean drift target both rungs, while PHASE3.23 mid-fill drift
  // narrows that same motion to the clean rung by result shape.
  //
  // The ladder, flip and requote branches below are unreachable under shift
  // mode — the ladder's is gated on `ladder !== undefined`, the requote's on
  // `requoteTarget` (null whenever a shift block is present), and the flip's on
  // `ladder === undefined` plus its own mode conditions — but this branch
  // returns before any of them in every case it fires.
  if (shift !== undefined && roleAt !== null && railsPassed) {
    // ─── R5.5 / D5 — THE DYNAMIC DISPATCHER ────────────────────────────────
    //
    // The buy row dispatches while it is live; otherwise the surviving sell
    // row does. NEVER BOTH — that is what makes one motion per pair structural.
    // An absent snapshot is a HOLD by omission: a row that cannot see its pair
    // must not assume it is the one to move it.
    const group = input.shiftGroupLiveRoles;
    const dispatcher =
      group === undefined
        ? undefined
        : group.liveRoles.includes("buy")
          ? "buy"
          : group.liveRoles.includes("sell")
            ? "sell"
            : undefined;
    if (group !== undefined && dispatcher === group.role) {
      // ─── R7's UNION, with D8's absent-sibling rule ───────────────────────
      //
      // EITHER row's evidence arms the pair. The sibling's numbers are read
      // from its DURABLE OBSERVATION (P9) and are ABSENT whenever it is not in
      // the live set (D8) — so a one-sided pair reads only its own evidence and
      // a stale dormant observation is never consulted.
      const sibling = input.shiftSibling;
      const crossReady =
        (cross.filled && gridCrossConsecutive >= 2)
        || (sibling !== undefined && sibling.gridCrossConsecutive >= 2);
      const driftReady =
        (drift !== null && drift.drifted && gridDriftConsecutive >= 2)
        || (shift.driftPctOfGap !== 0
          && sibling !== undefined
          && sibling.gridDriftConsecutive >= 2);
      // ─── PHASE3.23 / FINDINGS (be) — MID-FILL DRIFT DISCRIMINATOR ─────────
      //
      // `gridRangeRelation` persists the fact FINDINGS (be) proved was missing.
      // Cross remains pair-wide. Drift with one inside sibling moves only the
      // outside (clean) rung; both outside retains the two-target motion, and
      // absent/stale sibling relation holds instead of guessing (R2.1/R2.6).
      const cause: "cross" | "drift" | null = crossReady
        ? "cross"
        : driftReady ? "drift" : null;
      let targetRoles: readonly LpGridRole[] = ["sell", "buy"];
      if (cause === "drift" && group.liveRoles.includes("buy") && group.liveRoles.includes("sell")) {
        const ownRelation = cross.side === undefined ? "inside" : "outside";
        const siblingRelation = sibling?.gridRangeRelation ?? "unknown";
        if (siblingRelation === "unknown") {
          return build(
            "hold",
            `Shift drift is ready, but the ${sibling?.role ?? "sibling"} rung's persisted range relation is stale or unknown; wait for its next finalized observation.`,
          );
        }
        if (ownRelation === "inside" && siblingRelation === "inside") {
          return build(
            "hold",
            "Shift drift is ready, but both live rungs contain the observed tick; no clean rung is eligible to move.",
          );
        }
        if (ownRelation === "inside") targetRoles = [sibling?.role ?? (roleAt.role === "buy" ? "sell" : "buy")];
        if (siblingRelation === "inside") targetRoles = [roleAt.role];
      }
      if (cause !== null) {
        // ─── R8 / R3.4 — ONE OR TWO TARGETS, from ONE anchor ──────────────
        //
        // `anchorTick = currentTick` (operator decision 6: no Stoikov shift in
        // v1) through `gridDeriveRanges`, which is the SAME derivation the
        // client used to sign the arm's rungs: buy strictly below, sell
        // strictly above (or the mirror when WBNB is token0), one-spacing
        // clearance per side, REFUSING rather than truncating at the bounds.
        //
        // R2.25's exact property, not the paraphrase: the anchors are STRICT
        // (`above.tickLower = upperAnchor + g`), so real clearance is
        // `g + (1..s)` above and `g + (0..s-1)` below — which is why R1
        // requires `gapTicks > 0` strictly, unlike the ladder's `>= 0`.
        let targets: { buyRange: LpGridRange; sellRange: LpGridRange } | null = null;
        try {
          targets = gridDeriveRanges({
            currentTick: position.currentTick,
            tickSpacing: grid.tickSpacing,
            gapTicks: shift.gapTicks,
            widthTicks: shift.widthTicks,
            wbnbIsToken0: grid.wbnbIsToken0,
            minTick: MIN_TICK,
            maxTick: MAX_TICK,
          });
        } catch {
          // A derivation that leaves the global tick bounds REFUSES rather than
          // truncating, and at the trigger a refusal is simply no decision.
          targets = null;
        }
        if (targets !== null) {
          // ─── R9's G-GATE, SEAM (a): AT THE TRIGGER ────────────────────────
          //
          // Every targeted range must strictly exclude the tick and present
          // the side its role charges — decided in POOL ORDER through
          // `gridSideChargesQuote`, never from "above/below" read as a
          // direction, which inverts on every pool where WBNB is token0.
          //
          // Failing it here means NO DECISION. The identical check runs again
          // inside the mint build against fresh evidence, through the SAME
          // refusal builder, where failing it is a zero-money rollback.
          const gateOk = targetRoles.every((role) => {
            const range = role === "buy" ? targets.buyRange : targets.sellRange;
            const side = gridTargetSide(position.currentTick, range);
            return (
              side !== undefined
              && gridSideChargesQuote(side, grid.wbnbIsToken0) === (role === "buy")
            );
          });
          if (gateOk) {
            // ─── R11 / R4.2.1 — THE FUNDING CONJUNCT ─────────────────────────
            //
            // `minRungWei` comes from `gridShiftEconomics`, the SAME builder the
            // arm route admits on, so the gate and the admission cannot
            // disagree (the 3.13 F12 rule). A missing relay constant leaves it
            // null, which `gridShiftSideFloors` turns into an unreachable floor
            // and therefore a hold — fail-closed.
            const economics =
              input.relayFeePerSubmitWei === undefined
                ? null
                : gridShiftEconomics({
                    grid,
                    shift,
                    budgetWei: 0n,
                    relayFeePerSubmitWei: input.relayFeePerSubmitWei,
                  });
            const floors = gridShiftSideFloors({
              minRungWei: economics?.minRungWei ?? null,
              spotSqrtPriceX96: market.spotSqrtPriceX96,
              wbnbIsToken0: grid.wbnbIsToken0,
            });
            // ─── GRID-GAS-RESERVE P2 — THE GAS GATE, BEFORE THE FUNDING GATE ──
            //
            // The relay bills the batch from the wallet's NATIVE pot, which the
            // funding conjunct below never reads. A short pot is a hold of the
            // R2.10 shape on both causes; see `gridShiftGasGate`.
            const gas = gridShiftGasGate({
              nativeWei: position.bufferNativeWei,
              relayFeePerSubmitWei: input.relayFeePerSubmitWei,
            });
            if (gas.hold) {
              return build("hold", lpGridShiftGasHoldReason(gas));
            }
            const funding = gridShiftFunding({
              deployPctBps: shift.deployPctBps,
              idleQuoteWei: position.bufferQuoteWei,
              idleBaseWei: position.bufferBaseWei,
              // ─── THE FREED TERM IS ZERO AT THE TRIGGER, DELIBERATELY ──────
              //
              // The targeted rung(s) this motion would CLOSE return principal in
              // the SAME submission, before the mints pull from it — so at the
              // MINT BUILD the funding recompute counts it and the motion is
              // correctly self-funding. Here it is ZERO, and that is a decision
              // rather than an omission.
              //
              // Counting it at the trigger would need each rung's
              // `decreaseLiquidity` floors, which need each NFT's liquidity and
              // range. The worker holds THIS row's snapshot but NOT the
              // sibling's, so an exact term costs one extra per-NFT chain read
              // per cycle — and a term counting only this row would be an
              // asymmetric half-measure that is harder to reason about than
              // zero.
              //
              // ZERO IS THE CONSERVATIVE DIRECTION and that is what makes it
              // safe: it can only HOLD a motion the build would have funded,
              // never ADMIT one the build must then refuse. The visible cost is
              // that a pair whose buffer is thin but whose rungs are fat holds
              // one extra cycle before the build's own recompute would have let
              // it move — which the next cycle re-evaluates for free.
              freedQuoteWei: 0n,
              freedBaseWei: 0n,
              quoteFloorWei: floors.quoteFloorWei,
              baseFloorWei: floors.baseFloorWei,
              targetRoles,
            });
            if (funding.hold) {
              // BOTH sides below floor: nothing can mint, so the PAIR holds.
              // The R2.10 shape — no sequence, no reservation, no lane charge,
              // no spacing anchor — re-evaluated free next cycle.
              return build("hold", lpGridShiftFundingHoldReason({ funding }));
            }
            // ONE side below floor is NOT a hold (decision 9): the motion
            // proceeds one-sided, and `gridShiftFunding` has already recorded
            // which roles the batch will mint.

            // ─── R6 / R2.21 — THE SHIFT LANE's TRIGGER-LEVEL PRE-CHECK ──────
            //
            // The 3.20 D3 shape verbatim over the applicable shift cap.
            // Exhaustion is a HOLD, not a dispatch into a store refusal: (az) produced 15+
            // rolled-back rows in three minutes exactly by dispatching into a
            // quota it could not pass. `reserveSequence`'s own QUOTA refusal
            // stays as the second net.
            const usage = input.shiftQuotaUsage;
            if (usage !== undefined) {
              // PHASE3.25 R5.3 — absent counts fail CLOSED at their applicable
              // signed limits. Settlement and drift are independent allowances;
              // the spacing anchor below remains agent-wide.
              const driftLimit = gridShiftDriftMotionsPerDay(shift);
              const settleUsed = usage.shiftSettleLiveCount ?? shift.shiftsPerDay;
              const driftUsed = usage.shiftDriftLiveCount ?? driftLimit;
              const used = cause === "cross" ? settleUsed : driftUsed;
              const limit = cause === "cross" ? shift.shiftsPerDay : driftLimit;
              const laneOpen = used < limit;
              const spacingOpen =
                usage.latestReservedAtMs === null
                || nowMs - usage.latestReservedAtMs
                  >= settings.minMinutesBetweenExits * 60_000;
              if (!laneOpen || !spacingOpen) {
                return build(
                  "hold",
                  lpGridShiftQuotaHoldReason({
                    lane: cause === "cross" ? "shift-settle" : "shift-drift",
                    bound: laneOpen ? "spacing" : "quota",
                    used,
                    limit,
                    motionProjection: driftLimit,
                    minMinutesBetweenExits: settings.minMinutesBetweenExits,
                  }),
                );
              }
            }
            // R3.4 — target cardinality is carried by SHAPE, derived once here.
            // `driveSequence` persists only the present role(s); NULL is the
            // durable untouched marker, never a depleted target.
            return {
              ...build(
                "grid-shift",
                lpGridShiftReason({
                  role: roleAt.role,
                  evidence: cause,
                  oneSided: funding.oneSided,
                  currentTick: position.currentTick,
                  ...(targetRoles.includes("buy") ? { buyRange: targets.buyRange } : {}),
                  ...(targetRoles.includes("sell") ? { sellRange: targets.sellRange } : {}),
                }),
              ),
              gridShiftTargets: {
                ...(targetRoles.includes("buy") ? { buyRange: targets.buyRange } : {}),
                ...(targetRoles.includes("sell") ? { sellRange: targets.sellRange } : {}),
              },
              gridShiftCause: cause,
            };
          }
        }
      }
    }
  }

  /* ----- priority 1: the LADDER motion (PHASE3.19) -------------------------- */

  // ONE decision for BOTH triggers (D4/R2.4). The two pieces of evidence keep
  // their OWN durable counters — `gridCrossConsecutive` and
  // `gridDriftConsecutive`, unchanged — and exactly one of them can be true at a
  // time, because `cross.filled` and `drift.unfilled` are complements.
  //
  // The flip and requote branches below are STRUCTURALLY UNREACHABLE under
  // ladder mode and are gated explicitly rather than left to fall out: the flip
  // is gated on `ladder === undefined` and the requote on `requoteTarget`, which
  // is `null` whenever a ladder block is present.
  if (ladder !== undefined && roleAt !== null && railsPassed) {
    const crossReady = cross.filled && gridCrossConsecutive >= 2;
    const driftReady = drift !== null && drift.drifted && gridDriftConsecutive >= 2;
    // ─── PHASE3.20 D2 / item 15 — THE STRANDING BOUND ────────────────────────
    //
    // It REPLACES THE `(crossReady || driftReady)` CONJUNCT AND NOTHING ELSE.
    // `railsPassed`, `roleAt !== null`, `sideOk` and `funding.ok` all still
    // apply, and so do the lane and spacing bounds below — D2's own wording
    // ("regardless of its own counters, subject only to the settlement lane and
    // the spacing gate") read as an exemption from `sideOk`, which is the G1
    // gate whose absence mints a dust-sized single-sided rung (the 3.12 lesson).
    //
    // THE FIRING CYCLE'S OWN READING MUST BE MISMATCHED. That is what makes the
    // unconditional carry-forward above safe: a stamp that survived a re-sign,
    // a stale gap or an in-range wander can never by itself authorize a motion.
    const strandedBound = ladderStrandedMinutes(ladder, settings.minMinutesBetweenExits);
    const strandedForMs =
      gridMismatchSinceMs === undefined ? null : Math.max(0, nowMs - gridMismatchSinceMs);
    const strandedReady =
      cross.filled
      && strandedForMs !== null
      && strandedForMs >= strandedBound.value * 60_000;
    // ITEM 17's conjuncts: role from the durable columns (above), cross-or-drift
    // confirmed twice one interval apart, a side exists at the target, the side
    // the target presents CHARGES the asset this role holds (H2 rule 1, written
    // in POOL ORDER by construction), rails passed, AND the funding conjunct.
    const sideOk =
      target !== null
      && targetSide !== undefined
      && gridSideChargesQuote(targetSide, grid.wbnbIsToken0) === (roleAt.role === "buy");
    if ((crossReady || driftReady || strandedReady) && sideOk && target !== null) {
      // `ladderMinMintWei` IS the admission's own `minRungWei`, from the SAME
      // builder (M1), so the gate and the arm cannot disagree. A missing relay
      // constant leaves it `null`, which fails the conjunct closed.
      const economics =
        input.relayFeePerSubmitWei === undefined
          ? null
          : gridLadderEconomics({
              grid,
              ladder,
              budgetWei: 0n,
              relayFeePerSubmitWei: input.relayFeePerSubmitWei,
            });
      const funding = gridLadderFunding({
        role: roleAt.role,
        wbnbIsToken0: grid.wbnbIsToken0,
        bufferQuoteWei: position.bufferQuoteWei,
        bufferBaseWei: position.bufferBaseWei,
        spotSqrtPriceX96: market.spotSqrtPriceX96,
        rungExitValueWei: position.exitValueWei,
        // On a DRIFT the rung is unfilled and its whole principal is about to be
        // freed into the buffer on the charged side; on a FILL it holds the
        // OTHER asset and contributes nothing. `drift.unfilled` is the durable
        // reading of exactly that, and `cross.filled` is its complement.
        rungIsUnfilled: drift?.unfilled === true,
        deployPctBps: ladder.deployPctBps,
        minRungWei: economics?.minRungWei ?? null,
      });
      if (funding.ok) {
        // ─── PHASE3.20 D1 / item 16 — WHICH LANE, FROM THE EVIDENCE ────────
        //
        // A CROSS fill and a STRANDING bound both charge the SETTLEMENT lane: a
        // stranded rung is mismatched precisely because it filled, so the bound
        // is the same motion arriving late (OQ3). Giving the bound a third lane
        // would let a ladder exceed its own signed settlement budget and would
        // put this phase in the position of adding a lane to protect against the
        // lane it just added. Only a discretionary drift charges `"drift"`.
        const lane: "settlement" | "drift" =
          crossReady || strandedReady ? "settlement" : "drift";
        const counts = ladderMotionCounts(ladder);
        const limit =
          lane === "settlement" ? counts.settlementsPerDay : counts.driftMovesPerDay;

        // ─── PHASE3.20 items 17-19 (D3) — THE TRIGGER-LEVEL PRE-CHECK ──────
        //
        // The (az) churn was 15+ rolled-back `grid-recenter` rows in three
        // minutes, produced by BOTH gates — `quota-exhausted` and
        // `min-interval` — and one `LpQuotaUsage` read answers both.
        //
        // FAILING IT IS THE FUNDING CONJUNCT'S HOLD SHAPE VERBATIM: no sequence,
        // no reservation, no lane entry, no spacing anchor, re-evaluated free
        // next cycle. `reserveSequence`'s own QUOTA refusal stays as the second
        // net (item 19), and the scope is `grid-recenter` ONLY — rotate,
        // harvest, `grid-flip` and `grid-requote` keep today's
        // reserve→refuse→roll-back path byte for byte (item 20; the
        // generalization is a recorded residual with (ax) point 2 as evidence).
        const usage = input.ladderQuotaUsage;
        if (usage !== undefined) {
          // H5/C9 rule 1: an ABSENT lane count is `usage = limit`, never zero.
          // The `?? 0` convention these optional fields document is safe for a
          // dashboard and fails OPEN in a gate.
          const used =
            (lane === "settlement" ? usage.settlementLiveCount : usage.driftLiveCount)
            ?? limit;
          const laneOpen = used < limit;
          // C9 rule 3: `null` means NO ANCHOR — permissive, and correct: an
          // agent with no in-window reservation has nothing to be spaced from.
          const spacingOpen =
            usage.latestReservedAtMs === null
            || nowMs - usage.latestReservedAtMs >= settings.minMinutesBetweenExits * 60_000;
          if (!laneOpen || !spacingOpen) {
            const held = build(
              "hold",
              lpGridLadderQuotaHoldReason({
                role: roleAt.role,
                bound: laneOpen ? "spacing" : "quota",
                lane,
                used,
                limit,
                minMinutesBetweenExits: settings.minMinutesBetweenExits,
              }),
            );
            return { ...held, holdReason: held.triggerReason.reason };
          }
          // ─── item 16 / B2 — THE LAST-SLOT ARBITRATION, SETTLEMENT ONLY ───
          //
          // Consulted only when exactly ONE settlement slot remains and this row
          // wants it. The comparator is TOTAL — older stamp wins, equal stamps
          // break on the lexicographically smaller positionId — because the
          // FROZEN cycle clock makes equal stamps the EXPECTED case for two
          // rungs a price gap fills together, and a strict comparator would then
          // hold BOTH for ever. A row that loses HOLDS and re-competes next
          // cycle; it takes no reservation, so the winner's own read sees the
          // slot it needs.
          const arbitration = input.ladderArbitration;
          if (
            lane === "settlement"
            && used === limit - 1
            && arbitration !== undefined
            && gridMismatchSinceMs !== undefined
          ) {
            const mine = { at: gridMismatchSinceMs, id: arbitration.positionId };
            const loser = arbitration.siblings.find(
              (sibling) =>
                sibling.mismatchSinceMs !== null
                && (sibling.mismatchSinceMs < mine.at
                  || (sibling.mismatchSinceMs === mine.at
                    && sibling.positionId < mine.id)),
            );
            if (loser !== undefined) {
              const held = build(
                "hold",
                lpGridLadderQuotaHoldReason({
                  role: roleAt.role,
                  bound: "quota",
                  lane,
                  used,
                  limit,
                  minMinutesBetweenExits: settings.minMinutesBetweenExits,
                }),
              );
              return { ...held, holdReason: held.triggerReason.reason };
            }
          }
        }
        const decided = build(
          "grid-recenter",
          strandedReady && !crossReady
            ? lpGridLadderStrandedReason({
                role: roleAt.role,
                strandedMinutes: Math.floor((strandedForMs ?? 0) / 60_000),
                boundMinutes: strandedBound.value,
                range: liveRange,
                target,
              })
            : lpGridLadderReason({
                role: roleAt.role,
                trigger: crossReady ? "fill" : "drift",
                range: liveRange,
                target,
                currentTick: position.currentTick,
              }),
        );
        return {
          ...decided,
          gridRecenterTarget: target,
          gridRecenterEvidence: lane,
        };
      }
      // ITEM 17 — THE FUNDING HOLD. No sequence, no reservation, no lane, no
      // spacing anchor; the cross/drift counters are computed ABOVE this branch
      // so a motion parked for three cycles fires immediately when funding
      // returns.
      const held = build(
        "hold",
        lpGridLadderFundingHoldReason({
          role: roleAt.role,
          shortfallWei: funding.shortfallWei,
          hedgeEnabled: ladder.hedge.enabled,
        }),
      );
      return { ...held, holdReason: held.triggerReason.reason };
    }
  }

  /* ----- priority 2: the flip ---------------------------------------------- */

  // PHASE3.22 R2.18 — `shift === undefined` IS LOAD-BEARING, and the §13.1
  // journey test is what found it missing.
  //
  // Under shift mode the branch above returns only when THIS row is the pair's
  // live dispatcher. A row that is NOT the dispatcher — the sell rung while the
  // buy rung is live — used to fall straight through to here, and with
  // `cross.filled` and two consecutive observations it emitted **`grid-flip`**:
  // a saga that settles one level into the OPPOSITE SIGNED range, which under
  // shift mode is the arm's geometry and nothing a shift ever targets again.
  // That is the exact silent-inheritance defect R2.18 enumerates seams to
  // prevent, and `tsc` cannot see it because this is a boolean conjunct and not
  // an exhaustive switch.
  //
  // The requote branch below is already safe (its `requoteTarget` is null
  // whenever a shift block is present), and the ladder's own conjunct is the
  // precedent for writing this one explicitly rather than relying on another
  // mode's block being absent.
  if (
    ladder === undefined
    && shift === undefined
    && role !== null
    && target !== null
    && cross.filled
    && gridCrossConsecutive >= 2
    && targetSide !== undefined
    && railsPassed
  ) {
    return build(
      "grid-flip",
      `Grid level ${role} at [${position.tickLower}, ${position.tickUpper}) filled: tick ${position.currentTick} is beyond its far edge on two consecutive finalized evaluations. Flipping into the signed ${role === "buy" ? "sell" : "buy"} range [${target.tickLower}, ${target.tickUpper}), which the tick is "${targetSide}" of.`,
    );
  }

  /* ----- priority 3: the requote (PHASE3.18) -------------------------------- */

  // STRICTLY BELOW THE FLIP. A fill is evidence that already happened and its
  // settlement is not discretionary; a re-centre is. When both are ready the
  // flip wins and the requote is simply not needed — the flip's own mint lands
  // at a signed rung and the drift reading restarts against it.
  //
  // G0 (R2.9) is folded into `drift.unfilled`: `gridDriftReading` only reports
  // `drifted` for a level that is strictly outside its range AND still charging
  // the asset its stored role was armed holding.
  if (
    roleAt !== null
    && drift !== null
    && drift.drifted
    && gridDriftConsecutive >= 2
    && requoteTarget !== null
    && railsPassed
  ) {
    const decided = build(
      "grid-requote",
      lpGridRequoteReason({
        role: roleAt.role,
        level: roleAt.level,
        range: liveRange,
        target: requoteTarget,
        currentTick: position.currentTick,
        driftBps: drift.driftBps,
        thresholdBps: drift.thresholdBps,
      }),
    );
    return { ...decided, gridRequoteTarget: requoteTarget };
  }

  /* ----- hold, with a reason an owner can act on --------------------------- */

  const held = build("hold", gridHoldReason({
    grid,
    role,
    target,
    targetSide,
    cross,
    gridCrossConsecutive,
    previousIsStale,
    railsFailureReason: railsFailure?.reason,
    protectBreachPending: protect.protectBreach !== undefined && protect.protectConsecutive < 2,
    position,
    ...(drift === null ? {} : { drift }),
    gridDriftConsecutive,
  }));
  return { ...held, holdReason: held.triggerReason.reason };
}

/**
 * {@link gridRequoteTarget}, with the derivation's REFUSALS turned into "no
 * requote" rather than into a thrown evaluator.
 *
 * `gridDeriveRanges` throws when a derived rung would leave the global tick
 * bounds — the right answer for a signing-time client, and the wrong one here:
 * the evaluator is pure and its callers treat a throw as a per-position error.
 * A rung that cannot be derived at this price simply does not produce a
 * requote, and the level keeps running where it is.
 */
function safeRequoteTarget(input: {
  readonly grid: LpGridSettings;
  readonly policy: LpGridPolicy;
  readonly level: LpGridLevel;
  readonly role: LpGridRole;
  readonly currentTick: number;
}): LpGridRange | null {
  try {
    return gridRequoteTarget(input);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Owner-facing sentences — ONE builder per fact (the 3.13 cannot-diverge rule)*/
/* -------------------------------------------------------------------------- */

function gridHoldReason(input: {
  readonly grid: LpGridSettings;
  readonly role: LpGridRole | null;
  readonly target: LpGridRange | null;
  readonly targetSide: SwaplessRotationSide | undefined;
  readonly cross: LpGridCrossReading;
  readonly gridCrossConsecutive: number;
  readonly previousIsStale: boolean;
  readonly railsFailureReason: string | undefined;
  readonly protectBreachPending: boolean;
  readonly position: LpTriggerPositionInput;
  readonly drift?: LpGridDriftReading;
  readonly gridDriftConsecutive?: number;
}): string {
  const { position } = input;
  if (input.role === null) {
    // PHASE3.18 R2.6/C12(b): in POLICY mode the missing thing is the durable
    // IDENTITY, not a tick match — advising a re-sign "with one range equal to
    // the live level" there is advice to leave policy mode, which the C1
    // finding names explicitly as the wrong sentence. Two modes, two remedies,
    // and neither ever guesses at a role.
    if (gridModeOf(input.grid) === "policy") return LP_GRID_IDENTITY_MISSING_REASON;
    // Fail-closed backstop for a state C2's re-sign rule refuses. PHASE3.17
    // R3.1 widened that rule to every live level and all four signed ranges, so
    // this sentence names every range there is rather than only pair 1's.
    return `The live position's range [${position.tickLower}, ${position.tickUpper}) matches none of this grid's signed ranges (${gridRangeList(input.grid)}), so the flip has no defined target. Re-sign the grid block with one range equal to the live level, or exit the position.`;
  }
  if (input.railsFailureReason !== undefined && input.cross.filled) {
    return input.railsFailureReason;
  }
  if (input.previousIsStale && input.cross.filled) {
    return "The previous observation is older than the maximum comparable age; the grid cross count restarted.";
  }
  if (input.protectBreachPending) {
    return "Protect breach awaits a second finalized evaluation at least one interval later.";
  }
  // PHASE3.18: the requote's own "awaiting a second confirmation" sentence,
  // ABOVE the generic waiting text — a drifted unfilled level is the exact
  // state that text would otherwise describe as "nothing is happening".
  if (input.drift?.drifted === true && (input.gridDriftConsecutive ?? 0) < 2) {
    return `Grid ${input.role} level has drifted ${input.drift.driftBps} bps from tick ${position.currentTick}, over its ${input.drift.thresholdBps} bps policy threshold, awaiting a second finalized evaluation at least one interval later. A wick is not a drift, so one observation is never enough.`;
  }
  if (!input.cross.filled) {
    return `Grid waiting: tick ${position.currentTick} has not crossed fully beyond the live ${input.role} level [${position.tickLower}, ${position.tickUpper}). ${input.cross.side === undefined ? "The price is INSIDE the level, so it is only partly converted" : "The level still holds the asset it was armed with"}; a flip needs a full cross, twice, one worker interval apart.`;
  }
  if (input.gridCrossConsecutive < 2) {
    return `Grid ${input.role} level crossed at tick ${position.currentTick}, awaiting a second finalized evaluation at least one interval later. A V3 fill is reversible until it is settled, so one observation is never enough.`;
  }
  if (input.target !== null && input.targetSide === undefined) {
    // G1's own hold: EXPECTED strategy behaviour, not an error.
    return `Grid flip waiting on the target range: tick ${position.currentTick} is INSIDE the signed ${input.role === "buy" ? "sell" : "buy"} range [${input.target.tickLower}, ${input.target.tickUpper}), where a single-sided mint would be sized by the dust leg. The level stays as it is and the flip runs as soon as the price is clear of the target. Nothing is wrong and nothing is owed.`;
  }
  return "No grid trigger is ready.";
}

/**
 * THE ONE SENTENCE the flip's sweep-skip and its mint refusal both speak with
 * (R2.3, the 3.13 cannot-diverge rule): the skip is what the flip DECIDED and
 * the refusal is the mint DISAGREEING with the same three conjuncts, so if the
 * two could drift an owner would read two accounts of one quantity.
 *
 * ORDERING IS LOAD-BEARING and it is about a ceiling, not about prose. Both
 * surfaces pass this text through `sanitizeMessage`, which TRUNCATES at
 * `MAX_MESSAGE_LENGTH` (280) — a platform-wide cap this phase does not change
 * (the 3.13 R1/R2 residual). So each branch leads with the fact an owner cannot
 * reconstruct from anywhere else and puts the derivable evidence last.
 */
export function lpGridFlipReason(input: {
  readonly outcome: "skipped" | "refused";
  readonly currentTick: number;
  readonly target: LpGridRange;
  /** `undefined` means the tick is INSIDE the target — G2 conjunct 1 failed. */
  readonly side: SwaplessRotationSide | undefined;
  /** The freed legs in POOL ORDER — never the role-named WBNB/TOKEN pair. */
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly residueWei: bigint;
  readonly residueBps: bigint;
  /** Which conjunct failed, when this is a refusal. */
  readonly failed?: "no-side" | "residue" | "leg-contradiction";
}): string {
  const evidence =
    `tick ${input.currentTick} vs target [${input.target.tickLower}, ${input.target.tickUpper}), side ${input.side ?? "none"}, freed ${input.amount0}/${input.amount1} pool-ordered`;
  if (input.outcome === "skipped") {
    return `Grid flip: NO conversion made — a grid never swaps to rebalance, so this step is skipped by design. Residue ${input.residueWei} wei (${input.residueBps} bps) rides along into the mint or, above ${SWAPLESS_MAX_RESIDUE_BPS} bps, holds it. Evidence: ${evidence}.`;
  }
  const because =
    input.failed === "residue"
      ? `the off-side leg is ${input.residueWei} wei (${input.residueBps} bps), over the ${SWAPLESS_MAX_RESIDUE_BPS} bps bound`
      : input.failed === "leg-contradiction"
        ? `the "${input.side}" side needs a leg the wallet does not hold — the price gapped THROUGH the target`
        : `tick ${input.currentTick} is INSIDE the target range, where no single-sided mint is legal`;
  return `Grid flip refused at the mint: ${because}. Principal SAFE in the wallet, held pending-mint; the worker retries when the price allows. Remedy: wait, or owner-signed abandon then re-mint and re-import. Evidence: ${evidence}.`;
}

/**
 * PHASE3.16 R2.6 (ruling Q4) — THE ONE SENTENCE both grid-arm G-gate seams
 * speak with.
 *
 * The arm asks the SAME geometric question twice, at two different prices: the
 * route asks it against `admitGridSettings`'s own pool read, where a refusal
 * costs nothing at all (no position row, no sequence, no reservation, no
 * journal row); the mint's `build` asks it again against FRESH evidence
 * immediately before the calls are built, which is the standing money-build
 * discipline and closes the window between admission and submit. Two checks,
 * one FACT — so two texts would be the 3.13 cannot-diverge failure, and this
 * builder is what makes divergence impossible rather than merely discouraged.
 *
 * WHAT THE GATE IS, stated here because it is the whole of B1: the arm funds
 * `buyRange` and only `buyRange`. That range is the quote-holding level BY THE
 * TYPE'S OWN DEFINITION and the arm supplies exactly one asset, which is quote,
 * so WHICH range is armed is role-named and that is correct. What is DERIVED,
 * in pool order, is the SIDE `buyRange` presents at the fresh tick — the side
 * decides the charged leg, the floors and the desired/min pair. Searching over
 * BOTH ranges is refuted: whenever the tick sits outside the whole grid both
 * ranges qualify (in both orientations), and the wrong branch arms the SELL
 * level with quote, which `gridCrossReading` reads as `filled` and burns a
 * no-fill flip. `validateLpSettings` cannot refuse that case — it is pure and
 * never sees a tick.
 *
 * ORDERING IS LOAD-BEARING for the same reason it is in
 * {@link lpGridFlipReason}: `sanitizeMessage` truncates at 280 characters, so
 * the non-reconstructible fact leads and the derivable evidence goes last.
 */
export function lpGridArmRefusal(input: {
  readonly where: "route" | "mint";
  readonly currentTick: number;
  readonly buyRange: LpGridRange;
  /** `undefined` means the tick is INSIDE the buy range. */
  readonly side: SwaplessRotationSide | undefined;
  readonly wbnbIsToken0: boolean;
}): string {
  const because = lpGridArmBuyFact(input);
  return (
    `Grid arm refused at the ${input.where}: ${because}. `
    + `The client derived the ranges from a stale tick; NOTHING was spent. `
    + `Remedy: re-sign gridArm at the current price. `
    + `Evidence: buyRange [${input.buyRange.tickLower}, ${input.buyRange.tickUpper}), `
    + `wbnbIsToken0 ${input.wbnbIsToken0}.`
  );
}

/**
 * PHASE3.17 R2.7 (review M3) — THE ONE FACT, shared by the buy-side text above
 * and the dual arm's own short buy-side text below.
 *
 * `lpGridArmRefusal` already runs at the 280-character `sanitizeMessage`
 * ceiling with a real tick substituted, and its `Evidence:` tail is clipped
 * today (the 3.13 R1/R2 residual, a platform-wide cap this phase does not
 * change). Making ONE text also name which SIDE failed and a second range would
 * clip the remedy as well, so a dual arm produces TWO SHORT texts from this one
 * fact function instead — the 3.13 cannot-diverge rule kept, the character
 * budget respected.
 */
function lpGridArmBuyFact(input: {
  readonly currentTick: number;
  readonly side: SwaplessRotationSide | undefined;
  readonly wbnbIsToken0: boolean;
}): string {
  return input.side === undefined
    ? `tick ${input.currentTick} is INSIDE the signed buyRange, where no single-sided mint is legal`
    : `the signed buyRange is "${input.side}" of tick ${input.currentTick}, which charges the ${input.wbnbIsToken0 ? "token1" : "token0"} leg — not the quote the arm funds`;
}

/**
 * THE DUAL ARM'S BUY-SIDE refusal (R2.7), short by budget.
 *
 * Leads with the non-reconstructible fact — which rung, at which tick, on which
 * side — exactly as {@link lpGridFlipReason} does and for the same reason: the
 * 280-char cap truncates the tail, so the derivable evidence goes last. It
 * names the tick it ACTUALLY used, which for the buy side is the PRE-swap one
 * (the swap moves away from this rung in both orientations; see
 * {@link gridDualSellClearanceOk}).
 */
export function lpGridDualArmBuyRefusal(input: {
  readonly where: "route" | "mint";
  readonly currentTick: number;
  readonly buyRange: LpGridRange;
  readonly side: SwaplessRotationSide | undefined;
  readonly wbnbIsToken0: boolean;
}): string {
  return (
    `Dual grid arm refused at the ${input.where}, BUY rung: ${lpGridArmBuyFact(input)}. `
    + `NOTHING was spent. Remedy: re-sign gridArm at the current price. `
    + `Evidence: buyRange [${input.buyRange.tickLower}, ${input.buyRange.tickUpper}), pre-swap tick.`
  );
}

/**
 * THE DUAL ARM'S SELL-SIDE refusal (R2.7 / R3.3), short by budget.
 *
 * The fact an owner cannot reconstruct is that the verdict was taken on the
 * POST-SWAP price rather than the market's current one, so that leads. The
 * `--gap0` consequence is named because it is the shape this refusal most often
 * means (C8: one spacing of clearance forbids a zero-gap dual arm structurally).
 */
export function lpGridDualArmSellRefusal(input: {
  readonly where: "route" | "mint";
  readonly sellRange2: LpGridRange;
  readonly tickSpacing: number;
  readonly wbnbIsToken0: boolean;
}): string {
  const edge = input.wbnbIsToken0
    ? `${input.sellRange2.tickUpper} + ${input.tickSpacing}`
    : `${input.sellRange2.tickLower} - ${input.tickSpacing}`;
  // THE BUDGET, spent deliberately: the leading clause is the fact an owner
  // cannot reconstruct (the verdict was taken on the POST-SWAP price, not the
  // market's current one), the remedy follows it, and the tail is the ONE piece
  // of evidence that is not derivable from the signed settings — the near edge
  // the clearance was measured to. The full `sellRange2` bounds ARE derivable
  // and are dropped for that reason rather than clipped by the 280-char cap.
  return (
    `Dual grid arm refused at the ${input.where}, SELL rung: its own swap moves the price toward it, `
    + `so the quoted POST-SWAP price leaves under one spacing of clearance to ${edge}. `
    + `NOTHING was spent. Remedy: re-sign with a wider gap — a zero-gap dual arm never clears it.`
  );
}

/**
 * Every signed range this grid has, rendered once, in level order — so a
 * refusal about "which range is this level" cannot describe a two-rung grid
 * when four were signed. PHASE3.17 R3.1.
 */
export function gridRangeList(grid: LpGridSettings): string {
  return gridPairs(grid)
    .flatMap((pair) => [
      `L${pair.level} buy [${pair.buyRange.tickLower}, ${pair.buyRange.tickUpper})`,
      `L${pair.level} sell [${pair.sellRange.tickLower}, ${pair.sellRange.tickUpper})`,
    ])
    .join(", ");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The grid's own `buildResult`. A near-twin of the standard evaluator's private
 * one and deliberately NOT an export addition to it: that function is inside
 * the behaviour-frozen evaluator, and the grid records `rotateDeviationBps`
 * differently (a grid level is out of range by design, so reporting a rotation
 * deviation would invite a reader to act on it).
 */
function buildGridResult(input: {
  decision: LpManagementDecision;
  input: EvaluateGridTriggersInput;
  nextObservation: LpTriggerObservation;
  pnlBps?: bigint | undefined;
  previousObservationDiscarded?: "stale" | "settings-changed" | undefined;
  railsPassed: boolean;
  reason: string;
  spotTwapDeviationBps: bigint;
  thresholdBps?: bigint | undefined;
  triggerTick?: number | undefined;
  triggerWhen?: "at-or-below" | "at-or-above" | undefined;
}): EvaluateLpTriggersResult {
  const { market, nowMs, position } = input.input;
  const pnlBps = input.pnlBps?.toString();
  const triggerReason: LpTriggerReason = {
    basisWei: position.basisWei.toString(),
    basisSource: position.basisWei === 0n ? "zero-excluded" : position.basisSource,
    blockNumber: market.blockNumber.toString(),
    currentTick: position.currentTick,
    decision: input.decision,
    exitValueWei: position.exitValueWei.toString(),
    freshFeesValueWei: position.freshFeesValueWei.toString(),
    observedAtMs: nowMs,
    observationCardinality: market.observationCardinality,
    ...(pnlBps === undefined ? {} : { pnlBps }),
    poolAddress: position.poolAddress,
    poolLiquidity: market.poolLiquidity.toString(),
    priceImpactBps: market.priceImpactBps.toString(),
    ...(input.previousObservationDiscarded === undefined
      ? {}
      : { previousObservationDiscarded: input.previousObservationDiscarded }),
    reason: input.reason,
    spotTwapDeviationBps: input.spotTwapDeviationBps.toString(),
    ...(input.thresholdBps === undefined
      ? {}
      : { thresholdBps: input.thresholdBps.toString() }),
    ...(input.triggerTick === undefined ? {} : { triggerTick: input.triggerTick }),
    ...(input.triggerWhen === undefined ? {} : { triggerWhen: input.triggerWhen }),
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    tokenId: position.tokenId,
  };
  return {
    decision: input.decision,
    nextObservation: input.nextObservation,
    railsPassed: input.railsPassed,
    triggerReason,
  };
}

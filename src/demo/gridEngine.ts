/**
 * DEMO MODE — the grid engine, PURE.
 *
 * ─── THE MODEL, AND WHY IT IS EXACT RATHER THAN A GUESS ────────────────────
 *
 * A grid is a pair of limit orders at rungs, so the demo does not simulate an
 * NFPM position, a relay, a saga or a receipt. It simulates the ONE thing a
 * grid does: a range the price crosses COMPLETELY has converted entirely into
 * the other asset, and the level then re-quotes on its pair's other rung.
 *
 * The conversion is not approximated. A concentrated-liquidity range holding
 * `L` over `[a, b]`, once the price is strictly beyond `b`, holds exactly
 * `L * (sqrt(b) - sqrt(a))` of token1 and nothing else — and the mirror below
 * `a`. That is `getAmountsForLiquidity` in `src/lp/tickMath.ts`, the same
 * function the live rails size their floors with. So a demo fill reports the
 * amounts a real full cross would have produced, in wei, with no float.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT MODEL (plan §3, and the UI must say so) ──
 *
 *   - fee income while in range          (the demo UNDER-reports because of it)
 *   - price impact of our own liquidity  (the demo OVER-reports)
 *   - partial fills, MEV, priority fees, failed submissions
 *
 * The one cost it DOES charge is gas, as a disclosed line item rather than a
 * silent netting: `relayFeePerSubmitWei * submissionsPerFlip`, accumulated in
 * quote wei. That constant is still the unmeasured pad the live plane carries
 * (`RELAY_FEE_PER_EXIT_WEI`), and the caller passes it in rather than this
 * module reaching for `src/ops/policy.ts` — see the import ban in `types.ts`.
 *
 * ─── PURITY ────────────────────────────────────────────────────────────────
 *
 * No clock, no I/O, no randomness. Every function takes the observation and
 * returns the next state, so the whole engine is testable over a scripted tick
 * series and a demo run is reproducible from its fills.
 */
import {
  gridCrossReading,
  gridPair,
  gridTargetRange,
  gridTargetSide,
  type LpGridLevel,
  type LpGridRole,
} from "../lp/gridTriggers.js";
import type { LpGridRange, LpGridSettings } from "../lp/triggers.js";
import {
  Q96,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
} from "../lp/tickMath.js";

/* -------------------------------------------------------------------------- */
/* Pool-order helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Split a pool-ordered amount pair into quote and base.
 *
 * ONE place, because the alternative is `wbnbIsToken0 ? ... : ...` hand-written
 * at every seam that reports a number — precisely the inversion class
 * `gridSideChargesQuote` exists to end on the live side.
 */
export function demoQuoteBase(
  amount0Wei: bigint,
  amount1Wei: bigint,
  wbnbIsToken0: boolean,
): { readonly quoteWei: bigint; readonly baseWei: bigint } {
  return wbnbIsToken0
    ? { quoteWei: amount0Wei, baseWei: amount1Wei }
    : { quoteWei: amount1Wei, baseWei: amount0Wei };
}

/** The inverse: name a quote/base pair back into pool order. */
export function demoPoolOrder(
  quoteWei: bigint,
  baseWei: bigint,
  wbnbIsToken0: boolean,
): { readonly amount0Wei: bigint; readonly amount1Wei: bigint } {
  return wbnbIsToken0
    ? { amount0Wei: quoteWei, amount1Wei: baseWei }
    : { amount0Wei: baseWei, amount1Wei: quoteWei };
}

/**
 * Convert one asset into the other AT a tick, exactly, in Q96 space.
 *
 * Used ONLY to split a dual arm's budget the way the live dual arm's router
 * swap does (`gridDualSwapInWei`, 50/50). It is a spot conversion with no
 * slippage and no fee — one more thing the demo over-reports, and one more
 * line in the disclosure.
 */
export function demoConvertAtTick(input: {
  readonly amountWei: bigint;
  readonly fromToken0: boolean;
  readonly tick: number;
}): bigint {
  const sqrt = getSqrtRatioAtTick(input.tick);
  // price = (sqrt/Q96)^2 = token1 per token0. Floors in both directions, the
  // conservative side for a figure shown as a starting inventory.
  return input.fromToken0
    ? (((input.amountWei * sqrt) / Q96) * sqrt) / Q96
    : (((input.amountWei * Q96) / sqrt) * Q96) / sqrt;
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** One demo level: which pair it belongs to, which rung it sits on, its `L`. */
export type DemoGridLevelState = {
  readonly level: LpGridLevel;
  /** Which of the pair's two ranges the level currently occupies. */
  readonly role: LpGridRole;
  readonly liquidity: bigint;
  /**
   * Quote held when this level last LEFT the buy rung — the open of the cycle
   * now in flight, `null` while the level is parked on buy.
   *
   * A cycle closes when the level comes back to buy, and only then is a
   * realised delta a fact rather than a mark.
   */
  readonly openCycleQuoteWei: bigint | null;
  readonly cycles: number;
  readonly realisedQuoteWei: bigint;
};

export type DemoGridState = {
  readonly levels: readonly DemoGridLevelState[];
  /** Gas charged so far, in quote wei. A LINE ITEM, never netted in silence. */
  readonly costQuoteWei: bigint;
  readonly flips: number;
};

/** One simulated flip. Every amount is derived; none is read back. */
export type DemoGridFill = {
  readonly level: LpGridLevel;
  readonly from: LpGridRole;
  readonly to: LpGridRole;
  readonly atTick: number;
  readonly atMs: number;
  readonly fromRange: LpGridRange;
  readonly toRange: LpGridRange;
  /** What the crossed range released, in POOL ORDER. */
  readonly amount0Wei: bigint;
  readonly amount1Wei: bigint;
  /** The same two amounts, named by role. */
  readonly quoteWei: bigint;
  readonly baseWei: bigint;
  /** Set only when this flip CLOSED a cycle (a return to the buy rung). */
  readonly cycleQuoteDeltaWei: bigint | null;
};

/** A level that could not flip, with a reason an owner can act on. */
export type DemoGridHold = {
  readonly level: LpGridLevel;
  readonly reason: string;
};

/* -------------------------------------------------------------------------- */
/* Arm                                                                        */
/* -------------------------------------------------------------------------- */

export class DemoGridArmError extends Error {}

/**
 * Arm a demo grid at a tick, from a quote budget.
 *
 * Level 1 is armed on its BUY rung holding quote — the live single arm funds
 * `buyRange` and only `buyRange` (PHASE3.16 review B1), and the demo mirrors
 * that rather than inventing a friendlier start. A dual grid additionally arms
 * level 2 on its SELL rung holding base, converted from half the budget at the
 * arm tick, which is the shape of the live dual arm's router swap (3.17 R2.1).
 */
export function demoGridArm(input: {
  readonly grid: LpGridSettings;
  readonly currentTick: number;
  readonly budgetQuoteWei: bigint;
}): DemoGridState {
  if (input.budgetQuoteWei <= 0n) {
    throw new DemoGridArmError("A demo grid needs a positive budget.");
  }
  const pairOne = gridPair(input.grid, 1);
  if (pairOne === null) {
    throw new DemoGridArmError("The grid carries no level 1 pair.");
  }
  const pairTwo = gridPair(input.grid, 2);
  const perLevel = pairTwo === null ? input.budgetQuoteWei : input.budgetQuoteWei / 2n;
  const sqrt = getSqrtRatioAtTick(input.currentTick);

  const levels: DemoGridLevelState[] = [
    mintLevel({
      level: 1,
      role: "buy",
      range: pairOne.buyRange,
      sqrt,
      currentTick: input.currentTick,
      wbnbIsToken0: input.grid.wbnbIsToken0,
      quoteWei: perLevel,
      baseWei: 0n,
    }),
  ];

  if (pairTwo !== null) {
    const baseWei = demoConvertAtTick({
      amountWei: perLevel,
      fromToken0: input.grid.wbnbIsToken0,
      tick: input.currentTick,
    });
    levels.push(
      mintLevel({
        level: 2,
        role: "sell",
        range: pairTwo.sellRange,
        sqrt,
        currentTick: input.currentTick,
        wbnbIsToken0: input.grid.wbnbIsToken0,
        quoteWei: 0n,
        baseWei,
      }),
    );
  }

  return { levels, costQuoteWei: 0n, flips: 0 };
}

/**
 * Mint a level into a range single-sided, refusing when the tick is INSIDE it.
 *
 * The refusal is the demo's copy of the live G-gate (`gridTargetSide` answering
 * `undefined`), and it is a refusal rather than a two-sided mint for the same
 * reason: a single-sided rung is the whole geometry, and a level sitting on a
 * rung that contains the price is not a grid level at all.
 */
function mintLevel(input: {
  readonly level: LpGridLevel;
  readonly role: LpGridRole;
  readonly range: LpGridRange;
  readonly sqrt: bigint;
  readonly currentTick: number;
  readonly wbnbIsToken0: boolean;
  readonly quoteWei: bigint;
  readonly baseWei: bigint;
}): DemoGridLevelState {
  if (gridTargetSide(input.currentTick, input.range) === undefined) {
    throw new DemoGridArmError(
      `The price sits inside level ${input.level}'s ${input.role} range, so that rung cannot be armed single-sided. Widen the gap, or wait for the price to leave the range.`,
    );
  }
  const { amount0Wei, amount1Wei } = demoPoolOrder(
    input.quoteWei,
    input.baseWei,
    input.wbnbIsToken0,
  );
  const liquidity = getLiquidityForAmounts(
    input.sqrt,
    input.range.tickLower,
    input.range.tickUpper,
    amount0Wei,
    amount1Wei,
  );
  if (liquidity <= 0n) {
    throw new DemoGridArmError(
      `Level ${input.level}'s budget is too small to place any liquidity on its ${input.role} range.`,
    );
  }
  return {
    level: input.level,
    role: input.role,
    liquidity,
    // A level armed on the SELL rung has a cycle already in flight and no
    // recorded open, so its FIRST return to buy cannot be scored. `null` here,
    // and a `null` delta on that first fill, is the honest answer; inventing an
    // open from the arm price would report a PnL the demo never observed.
    openCycleQuoteWei: null,
    cycles: 0,
    realisedQuoteWei: 0n,
  };
}

/* -------------------------------------------------------------------------- */
/* Step                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Advance every level by ONE observation.
 *
 * Cross detection is `gridCrossReading` — the live predicate, unmodified. It
 * answers `filled` only once the tick is OUTSIDE the rung on the far side, so a
 * price that merely enters the range is never a fill and a half-converted range
 * is never flipped. That is the same rule the live worker flips on, which is
 * the point: a demo using a friendlier trigger would teach the visitor the
 * wrong thing about the agent they are about to hire.
 *
 * PRECISELY (review finding 17, which caught the earlier wording "strictly
 * beyond the far edge"): a V3 range is HALF-OPEN, `[tickLower, tickUpper)`. At
 * `tick === tickUpper` the position is already entirely token1 — the range is
 * behind the price — so that observation IS a fill, and the arithmetic below
 * agrees. Crossing the other way needs `tick < tickLower`, strictly. The
 * asymmetry is the half-open interval's, not this engine's.
 *
 * At most ONE flip per level per observation, deliberately. A tick series that
 * jumps across several rungs at once is a gap the demo does not get to
 * back-fill into free money; the level takes its one flip and the rest of the
 * move is seen at the next observation.
 */
export function demoGridStep(input: {
  readonly grid: LpGridSettings;
  readonly state: DemoGridState;
  readonly currentTick: number;
  readonly atMs: number;
  readonly relayFeePerSubmitWei: bigint;
  readonly submissionsPerFlip: number;
}): {
  readonly state: DemoGridState;
  readonly fills: readonly DemoGridFill[];
  readonly holds: readonly DemoGridHold[];
} {
  const sqrt = getSqrtRatioAtTick(input.currentTick);
  const fills: DemoGridFill[] = [];
  const holds: DemoGridHold[] = [];
  let costQuoteWei = input.state.costQuoteWei;
  let flips = input.state.flips;

  const levels = input.state.levels.map((level): DemoGridLevelState => {
    const pair = gridPair(input.grid, level.level);
    if (pair === null) {
      holds.push({
        level: level.level,
        reason: `Level ${level.level} has no signed pair on this grid.`,
      });
      return level;
    }
    const range = level.role === "buy" ? pair.buyRange : pair.sellRange;
    const reading = gridCrossReading({
      currentTick: input.currentTick,
      range,
      role: level.role,
      wbnbIsToken0: input.grid.wbnbIsToken0,
    });
    if (!reading.filled) return level;

    const target = gridTargetRange(input.grid, level.level, level.role);
    if (gridTargetSide(input.currentTick, target) === undefined) {
      // Unreachable under the R2.1 disjoint-rung chain, kept as a fail-closed
      // backstop: a two-sided target would mean a geometry the demo never
      // received, and guessing at it is how a simulation starts lying.
      holds.push({
        level: level.level,
        reason: `Level ${level.level} filled, but the price now sits inside its opposite range, so the counter-order cannot be placed.`,
      });
      return level;
    }

    const released = getAmountsForLiquidity(
      sqrt,
      range.tickLower,
      range.tickUpper,
      level.liquidity,
    );
    const named = demoQuoteBase(
      released.amount0,
      released.amount1,
      input.grid.wbnbIsToken0,
    );
    const nextRole: LpGridRole = level.role === "buy" ? "sell" : "buy";

    // ── cycle accounting ──────────────────────────────────────────────────
    // A cycle is buy -> sell -> buy. Leaving the buy rung OPENS one and records
    // the quote that went out; returning to it CLOSES one and scores the quote
    // that came back. A level armed on the sell rung has no recorded open, so
    // its first close scores `null` rather than a fabricated number.
    let openCycleQuoteWei = level.openCycleQuoteWei;
    let cycles = level.cycles;
    let realisedQuoteWei = level.realisedQuoteWei;
    let cycleQuoteDeltaWei: bigint | null = null;
    if (level.role === "buy") {
      openCycleQuoteWei = quoteHeldOnBuyRung(level, pair.buyRange, input.grid.wbnbIsToken0);
    } else if (openCycleQuoteWei !== null) {
      cycleQuoteDeltaWei = named.quoteWei - openCycleQuoteWei;
      realisedQuoteWei += cycleQuoteDeltaWei;
      cycles += 1;
      openCycleQuoteWei = null;
    }

    const { amount0Wei, amount1Wei } = demoPoolOrder(
      named.quoteWei,
      named.baseWei,
      input.grid.wbnbIsToken0,
    );
    const liquidity = getLiquidityForAmounts(
      sqrt,
      target.tickLower,
      target.tickUpper,
      amount0Wei,
      amount1Wei,
    );
    if (liquidity <= 0n) {
      holds.push({
        level: level.level,
        reason: `Level ${level.level} filled, but what it freed is too small to re-place on the opposite rung.`,
      });
      return level;
    }

    costQuoteWei +=
      input.relayFeePerSubmitWei * BigInt(Math.max(0, Math.trunc(input.submissionsPerFlip)));
    flips += 1;
    fills.push({
      level: level.level,
      from: level.role,
      to: nextRole,
      atTick: input.currentTick,
      atMs: input.atMs,
      fromRange: range,
      toRange: target,
      amount0Wei,
      amount1Wei,
      quoteWei: named.quoteWei,
      baseWei: named.baseWei,
      cycleQuoteDeltaWei,
    });
    return {
      level: level.level,
      role: nextRole,
      liquidity,
      openCycleQuoteWei,
      cycles,
      realisedQuoteWei,
    };
  });

  return { state: { levels, costQuoteWei, flips }, fills, holds };
}

/**
 * The quote a level holds while parked on its buy rung — the cycle's opening
 * cost.
 *
 * Computed from `L` at the rung's quote-only extreme, which is the same
 * arithmetic the closing fill uses on the way back, so the two ends of a cycle
 * cannot drift apart. In pool order the quote-only extreme is `tickLower` when
 * the quote is token0 (a range strictly above the price charges token0) and
 * `tickUpper` otherwise.
 */
function quoteHeldOnBuyRung(
  level: DemoGridLevelState,
  buyRange: LpGridRange,
  wbnbIsToken0: boolean,
): bigint {
  const sqrtAt = getSqrtRatioAtTick(wbnbIsToken0 ? buyRange.tickLower : buyRange.tickUpper);
  const amounts = getAmountsForLiquidity(
    sqrtAt,
    buyRange.tickLower,
    buyRange.tickUpper,
    level.liquidity,
  );
  return demoQuoteBase(amounts.amount0, amounts.amount1, wbnbIsToken0).quoteWei;
}

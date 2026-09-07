/**
 * PHASE3.18 — the grid's RUNG DERIVATION, as a LEAF module.
 *
 * ─── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * `gridDeriveRanges` / `gridDeriveDualRanges` were written in
 * `src/lp/gridTriggers.ts` (3.16 R2.8 / 3.17 C9) and are MOVED HERE VERBATIM —
 * same bodies, same comments, same exported names, re-exported from
 * `gridTriggers.ts` so no import site anywhere moves.
 *
 * The reason is the R2.1 COHERENCE RULE. In policy mode `validateLpSettings`
 * (in `src/lp/triggers.ts`) must prove that the four SIGNED rungs are the
 * derivation of the signed policy at SOME tick — and it must prove it in the
 * PURE validator, because the worker re-parses stored settings through the
 * same function and a route-only rule is a rule the worker does not enforce
 * (the M16 split). But `gridTriggers.ts` imports `triggers.ts`, so calling the
 * derivation from `validateLpSettings` would make a RUNTIME import cycle.
 *
 * This module imports NOTHING at runtime — only `import type`, which TypeScript
 * erases — so `triggers.ts` may depend on it with no cycle at all. Writing a
 * SECOND derivation inside `triggers.ts` was the alternative and is exactly the
 * thing the grid lineage keeps being caught by: two authorities on one
 * geometry, inverting for half of BSC's pools the first time one is edited
 * (3.13 F7 / 3.15 H1). One derivation, one place, no cycle.
 */
import type { LpGridRange, LpGridSettings } from "./triggers.js";

/**
 * Derive the two grid ranges from a gap, a width and the CURRENT tick.
 *
 * The BUY level holds QUOTE, so it must sit on the side that charges the WBNB
 * leg: `"above"` when `wbnbIsToken0`, `"below"` otherwise
 * (`gridSideChargesQuote`). The SELL level mirrors it, which is exactly
 * the orientation-conditioned ordering constraint `validateLpSettings`
 * enforces.
 *
 * THE ANCHORS ARE STRICT, and that is the one subtlety: the upper anchor is
 * the smallest spacing multiple STRICTLY GREATER than the tick, the lower one
 * the largest multiple at or below it. Without that, a ZERO gap on a pool
 * whose tick happens to sit exactly on a spacing multiple would place the buy
 * level's lower bound AT the tick — where `gridTargetSide` answers `undefined`
 * and the arm's own G-gate refuses. A gap of zero is a legal shape (the
 * levels touch), so it must not be the shape that cannot be armed.
 *
 * Every returned tick is a spacing multiple by construction, so the caller
 * never needs a second alignment step.
 */
export function gridDeriveRanges(input: {
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly gapTicks: number;
  readonly widthTicks: number;
  readonly wbnbIsToken0: boolean;
  /** Global V3 tick bounds, so this module needs no import from `tickMath`. */
  readonly minTick: number;
  readonly maxTick: number;
}): { readonly buyRange: LpGridRange; readonly sellRange: LpGridRange } {
  const { currentTick: t, tickSpacing: s, gapTicks: g, widthTicks: w } = input;
  if (!Number.isInteger(s) || s <= 0) {
    throw new Error("gridDeriveRanges: tickSpacing must be a positive integer.");
  }
  if (g % s !== 0 || w % s !== 0 || w <= 0 || g < 0) {
    throw new Error(
      "gridDeriveRanges: the gap and width must be non-negative spacing multiples, and the width positive.",
    );
  }
  const upperAnchor = (Math.floor(t / s) + 1) * s;
  const lowerAnchor = Math.floor(t / s) * s;
  const above: LpGridRange = {
    tickLower: upperAnchor + g,
    tickUpper: upperAnchor + g + w,
  };
  const below: LpGridRange = {
    tickLower: lowerAnchor - g - w,
    tickUpper: lowerAnchor - g,
  };
  for (const range of [above, below]) {
    if (range.tickLower < input.minTick || range.tickUpper > input.maxTick) {
      // REFUSE rather than truncate: a truncated range is a different
      // geometry from the one the operator was shown and would sign.
      throw new Error(
        `gridDeriveRanges: the derived range [${range.tickLower}, ${range.tickUpper}) leaves the global tick bounds.`,
      );
    }
  }
  return input.wbnbIsToken0
    ? { buyRange: above, sellRange: below }
    : { buyRange: below, sellRange: above };
}

/**
 * PHASE3.17 C9 — the FOUR rungs of a dual grid, from ONE gap and ONE width at
 * EVEN RUNG PITCH.
 *
 * ```text
 * pitch = gapTicks + widthTicks          (rung n sits n pitches from the anchor)
 * inner rung gap = gapTicks
 * outer rung gap = 2*gapTicks + widthTicks
 * ```
 *
 * Composed of TWO {@link gridDeriveRanges} calls rather than re-deriving the
 * anchors, so the strict-anchor subtlety that function documents (a zero gap on
 * a tick sitting exactly on a spacing multiple) is solved once and inherited by
 * all four rungs, and so the global-bounds REFUSAL covers every rung before any
 * is accepted — both calls throw rather than truncate, and a truncated rung is
 * a geometry the operator was never shown.
 *
 * THE CROSSING, which is the whole of R2.1: each level takes one INNER rung and
 * one OUTER rung, on opposite sides. The inner derivation's quote side is
 * level 1's `buyRange` and its base side is level 2's `sellRange2`; the outer
 * derivation's base side is level 1's `sellRange` and its quote side is level
 * 2's `buyRange2`. So at arm time both levels quote the price-nearest rungs
 * (C10: AT ARM TIME only — after a fill each level's counter-order lands on its
 * own pair's OUTER rung, two rungs plus the corridor away, and the inner rungs
 * go periodically vacant).
 */
export function gridDeriveDualRanges(input: {
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly gapTicks: number;
  readonly widthTicks: number;
  readonly wbnbIsToken0: boolean;
  readonly minTick: number;
  readonly maxTick: number;
}): {
  readonly buyRange: LpGridRange;
  readonly sellRange: LpGridRange;
  readonly buyRange2: LpGridRange;
  readonly sellRange2: LpGridRange;
} {
  const inner = gridDeriveRanges(input);
  const outer = gridDeriveRanges({
    ...input,
    // The next rung at even pitch: clear the inner rung's own width AND a
    // second gap. `gridDeriveRanges` re-checks that this is a spacing multiple,
    // which it is whenever the gap and width are.
    gapTicks: 2 * input.gapTicks + input.widthTicks,
  });
  return {
    buyRange: inner.buyRange,
    sellRange: outer.sellRange,
    buyRange2: outer.buyRange,
    sellRange2: inner.sellRange,
  };
}

/** `a` and `b` are the same rung, tick for tick. */
function sameRange(a: LpGridRange, b: LpGridRange): boolean {
  return a.tickLower === b.tickLower && a.tickUpper === b.tickUpper;
}

/**
 * PHASE3.18 R2.1 / C6 — THE COHERENCE RULE: are these signed rungs the
 * derivation of this signed policy at SOME tick?
 *
 * Answers a MESSAGE on failure and `null` on success, so the caller (the pure
 * `validateLpSettings`) owns the throw and its wording.
 *
 * ─── WHY IT IS DECIDABLE AT ALL, AND IN CLOSED FORM ───────────────────────
 *
 * {@link gridDeriveRanges} depends on the tick ONLY through
 * `lowerAnchor = floor(t/s)*s` — every returned bound is that anchor plus a
 * constant. So "at SOME tick" is exactly "for SOME spacing multiple `A`", and
 * `A` is READ OFF the signed `buyRange`, which is the INNER buy rung in both
 * orientations and both level counts:
 *
 * ```text
 * Case A (wbnbIsToken0):  buyRange is ABOVE  =>  A = buyRange.tickLower - s - g
 * Case B:                 buyRange is BELOW  =>  A = buyRange.tickUpper + g
 * ```
 *
 * The whole derivation is then RE-RUN at `A` (a spacing multiple, so
 * `floor(A/s)*s === A`) and every present rung compared VERBATIM. No search, no
 * tolerance, and — decisively — no second geometry: a policy whose own
 * derivation function changes changes this check with it.
 *
 * C6: the policy is SHARED between the two levels in v1 (one gap, one width),
 * and the check still admits the CROSSED-PAIR ASYMMETRY that B1 used to prove
 * the policy unrecoverable from the rungs — a level's own pair separates by
 * `s + 3g + w` while the two INNER rungs separate by `s + 2g`. It admits it for
 * free, because it compares against {@link gridDeriveDualRanges}' own output
 * rather than against any separation arithmetic.
 */
export function gridPolicyCoherence(
  grid: LpGridSettings,
  policy: { readonly gapTicks: number; readonly widthTicks: number },
  bounds: { readonly minTick: number; readonly maxTick: number },
): string | null {
  const s = grid.tickSpacing;
  const { gapTicks: g, widthTicks: w } = policy;
  const anchor = grid.wbnbIsToken0
    ? grid.buyRange.tickLower - s - g
    : grid.buyRange.tickUpper + g;
  if (anchor % s !== 0) {
    return (
      `grid.buyRange is not a derivation of grid.policy at any tick: the implied spacing anchor `
      + `${anchor} is not a multiple of tickSpacing ${s}.`
    );
  }
  const dual = grid.buyRange2 !== undefined && grid.sellRange2 !== undefined;
  const input = {
    currentTick: anchor,
    tickSpacing: s,
    gapTicks: g,
    widthTicks: w,
    wbnbIsToken0: grid.wbnbIsToken0,
    minTick: bounds.minTick,
    maxTick: bounds.maxTick,
  } as const;
  let derived: {
    readonly buyRange: LpGridRange;
    readonly sellRange: LpGridRange;
    readonly buyRange2?: LpGridRange;
    readonly sellRange2?: LpGridRange;
  };
  try {
    derived = dual ? gridDeriveDualRanges(input) : gridDeriveRanges(input);
  } catch (error) {
    return `grid.policy does not derive a legal ladder at the anchor grid.buyRange implies: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const expected: readonly (readonly [string, LpGridRange, LpGridRange | undefined])[] = [
    ["grid.buyRange", derived.buyRange, grid.buyRange],
    ["grid.sellRange", derived.sellRange, grid.sellRange],
    ["grid.buyRange2", derived.buyRange2 ?? { tickLower: 0, tickUpper: 0 }, grid.buyRange2],
    ["grid.sellRange2", derived.sellRange2 ?? { tickLower: 0, tickUpper: 0 }, grid.sellRange2],
  ];
  for (const [name, want, got] of expected) {
    if (got === undefined) continue;
    if (!sameRange(want, got)) {
      return (
        `${name} [${got.tickLower}, ${got.tickUpper}) is not what grid.policy `
        + `(gapTicks ${g}, widthTicks ${w}) derives at the tick grid.buyRange implies — `
        + `that derivation is [${want.tickLower}, ${want.tickUpper}). In policy mode the signed `
        + `rungs ARE the policy's initial placement, so they must agree exactly; re-sign the `
        + `grid block from one derivation at the current tick.`
      );
    }
  }
  return null;
}

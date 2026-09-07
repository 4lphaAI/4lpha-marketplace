/**
 * The brain fence — LLM proposes, code disposes (PHASE3 body "The brain" +
 * Rev2 items 27/28/36).
 *
 * PURE AND OFFLINE. The proposal is UNTRUSTED INPUT (an LLM reply relayed
 * through the data plane): nothing in it is assumed to be the right type, the
 * right shape, or in bounds. ANY failure — malformed JSON shape, unsnapped
 * ticks, width out of bounds, a range that ignores the current price, a
 * hallucinated pool address, an extra field trying to smuggle a budget —
 * produces the DETERMINISTIC FALLBACK, never an error the caller might route
 * around. The fence can refuse the brain; the brain can never refuse the
 * fence.
 *
 * The verdict is a structured result (`accepted` | `fell-back` with a coded
 * reason) so receipts and sequence rows can carry it verbatim (body
 * requirement: an audit can reconstruct why a range was chosen).
 *
 * Triggers are deterministic and protect NEVER consults the brain (item 28):
 * this module fences parameters for an already-fired rotate or an owner-signed
 * open, and holds no import path from the protect flow.
 */
import { getAddress, isAddress } from "viem";
import { spotSwapOutput } from "./rails.js";
import { MAX_TICK, MIN_TICK, nearestUsableTick } from "./tickMath.js";

/* -------------------------------------------------------------------------- */
/* Proposal + verdict shapes                                                  */
/* -------------------------------------------------------------------------- */

export type BrainRangeBias = "centered" | "above" | "below";

/**
 * What the brain may propose for a range decision. `holdInstead: true` merely
 * ends the cycle and is ALWAYS safe to accept, whatever else the reply says.
 * There is deliberately no budget/amount field — sizing is never the brain's
 * to touch, and an extra key is a fence failure, not a passthrough.
 */
export type BrainRangeProposal = {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly bias?: BrainRangeBias;
  readonly holdInstead?: boolean;
};

/** What the brain may propose for an at-open pool selection (Rev2 item 36). */
export type BrainPoolProposal = {
  readonly poolChoice: string;
};

export type RangeFenceContext = {
  readonly kind: "range";
  readonly currentTick: number;
  readonly tickSpacing: number;
  /** Upper bound on `tickUpper - tickLower`; lower bound is `2 * tickSpacing`. */
  readonly maxTickWidth: number;
  /** Width of the prior range in ticks — the fallback re-centers it. */
  readonly priorWidthTicks: number;
};

export type PoolFenceContext = {
  readonly kind: "pool";
  /**
   * The DETERMINISTIC SURVIVOR LIST, already rails-filtered and ordered
   * APR -> TVL -> volume by the caller (Rev2 items 34/36). The fence never
   * widens it; the fallback is its head.
   */
  readonly survivors: readonly `0x${string}`[];
};

export type FenceFallbackCode =
  | "PROPOSAL_MALFORMED"
  | "TICKS_NOT_SNAPPED"
  | "WIDTH_OUT_OF_BOUNDS"
  | "RANGE_OUT_OF_BOUNDS"
  | "RANGE_MISPLACED"
  | "POOL_NOT_IN_SURVIVOR_SET";

export type FenceFallback =
  | { readonly kind: "range"; readonly tickLower: number; readonly tickUpper: number }
  | { readonly kind: "pool"; readonly poolAddress: `0x${string}` };

export type FenceVerdict =
  | { readonly outcome: "accepted"; readonly kind: "hold" }
  | {
      readonly outcome: "accepted";
      readonly kind: "range";
      readonly tickLower: number;
      readonly tickUpper: number;
      readonly bias: BrainRangeBias;
    }
  | { readonly outcome: "accepted"; readonly kind: "pool"; readonly poolAddress: `0x${string}` }
  | {
      readonly outcome: "fell-back";
      readonly code: FenceFallbackCode;
      readonly reason: string;
      readonly fallback: FenceFallback;
    };

/* -------------------------------------------------------------------------- */
/* Deterministic fallback                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The deterministic rotation range: the PRIOR width re-centered on the
 * current tick, snapped to spacing, floored at `2 * tickSpacing` wide. Ported
 * from 0G `lp-worker.ts` `centeredRotationRange`, made pure (the 0G original
 * read the pool for its spacing; here the caller injects it).
 *
 * This is what runs on ANY fence failure and whenever the data plane or LLM
 * is unreachable — the brain being down never blocks a triggered rotate.
 *
 * DELIBERATE DELTA from 0G (reported): the result is clamped inside the
 * usable [MIN_TICK, MAX_TICK] multiples of the spacing, shifting the window
 * rather than truncating its width. The 0G original could emit ticks past the
 * global bounds near the extremes, where `getSqrtRatioAtTick` (and the pool)
 * would reject them.
 */
export function centeredRotationRange(input: {
  readonly currentTick: number;
  readonly priorWidthTicks: number;
  readonly tickSpacing: number;
}): { tickLower: number; tickUpper: number } {
  const { currentTick, priorWidthTicks, tickSpacing } = input;
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("centeredRotationRange: tickSpacing must be a positive integer.");
  }
  if (!Number.isInteger(currentTick) || currentTick < MIN_TICK || currentTick > MAX_TICK) {
    throw new Error("centeredRotationRange: currentTick is out of the global tick bounds.");
  }
  if (!Number.isInteger(priorWidthTicks)) {
    throw new Error("centeredRotationRange: priorWidthTicks must be an integer.");
  }
  const width = Math.max(tickSpacing * 2, Math.abs(priorWidthTicks));
  const center = nearestUsableTick(currentTick, tickSpacing);
  const halfSteps = Math.max(1, Math.ceil(width / tickSpacing / 2));
  let tickLower = center - halfSteps * tickSpacing;
  let tickUpper = center + halfSteps * tickSpacing;

  // Clamp by SHIFTING inside the usable multiples of the spacing.
  const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  if (tickUpper > maxUsable) {
    tickLower -= tickUpper - maxUsable;
    tickUpper = maxUsable;
  }
  if (tickLower < minUsable) {
    tickUpper = Math.min(maxUsable, tickUpper + (minUsable - tickLower));
    tickLower = minUsable;
  }
  if (tickLower >= tickUpper) {
    // Only reachable when the spacing barely fits the global range at all.
    throw new Error("centeredRotationRange: no usable range fits the global tick bounds.");
  }
  return { tickLower, tickUpper };
}

/* -------------------------------------------------------------------------- */
/* The fence                                                                  */
/* -------------------------------------------------------------------------- */

const RANGE_PROPOSAL_KEYS = new Set(["tickLower", "tickUpper", "bias", "holdInstead"]);
const POOL_PROPOSAL_KEYS = new Set(["poolChoice"]);

/**
 * Validate a brain proposal against the fence context. Returns a structured
 * verdict; NEVER throws on proposal content (only on a caller-supplied
 * context that is itself invalid, which is a build error, not brain output).
 *
 * Range rules (body, "The brain"):
 *   - ticks are integers, snapped to `tickSpacing`, inside the global bounds;
 *   - width in `[2 * tickSpacing, maxTickWidth]`;
 *   - the range CONTAINS the current tick ("centered", the default), or
 *     PROPERLY BRACKETS it per the declared bias: "above" anchors
 *     `tickLower` at the usable tick at/just above the current price,
 *     "below" anchors `tickUpper` there — a biased range that drifts away
 *     from the current price is a fence failure, not a strategy;
 *   - `holdInstead: true` is always accepted;
 *   - any unknown field (a budget, an amount, anything) is a fence failure.
 *
 * Pool rule (Rev2 item 36): a `poolChoice` outside the caller-supplied
 * deterministic survivor list — hallucinated addresses included — falls back
 * to the deterministic head of that list.
 */
export function validateBrainProposal(
  proposal: unknown,
  fence: RangeFenceContext | PoolFenceContext,
): FenceVerdict {
  if (fence.kind === "pool") return fencePool(proposal, fence);
  return fenceRange(proposal, fence);
}

function fenceRange(proposal: unknown, fence: RangeFenceContext): FenceVerdict {
  const { currentTick, tickSpacing, maxTickWidth, priorWidthTicks } = fence;
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("range fence: tickSpacing must be a positive integer.");
  }
  if (!Number.isInteger(currentTick) || currentTick < MIN_TICK || currentTick > MAX_TICK) {
    throw new Error("range fence: currentTick is out of the global tick bounds.");
  }
  if (!Number.isInteger(maxTickWidth) || maxTickWidth < 2 * tickSpacing) {
    throw new Error("range fence: maxTickWidth must be an integer >= 2 * tickSpacing.");
  }
  if (!Number.isInteger(priorWidthTicks) || priorWidthTicks <= 0) {
    throw new Error("range fence: priorWidthTicks must be a positive integer.");
  }

  const fallback = (): FenceFallback => {
    const range = centeredRotationRange({ currentTick, priorWidthTicks, tickSpacing });
    return { kind: "range", ...range };
  };
  const fellBack = (code: FenceFallbackCode, reason: string): FenceVerdict => ({
    outcome: "fell-back",
    code,
    reason,
    fallback: fallback(),
  });

  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) {
    return fellBack("PROPOSAL_MALFORMED", "Range proposal is not an object.");
  }
  const record = proposal as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!RANGE_PROPOSAL_KEYS.has(key)) {
      return fellBack(
        "PROPOSAL_MALFORMED",
        `Range proposal carries an unexpected field "${key}"; the brain has no budget or routing authority.`,
      );
    }
  }

  // `holdInstead` is safe only AFTER the closed-key check above: otherwise an
  // attacker gets a side channel that accepts a hold while smuggling extra
  // instructions past the schema gate.
  if ("holdInstead" in record) {
    if (record["holdInstead"] === true) return { outcome: "accepted", kind: "hold" };
    if (record["holdInstead"] !== false) {
      return fellBack("PROPOSAL_MALFORMED", "holdInstead must be a boolean.");
    }
  }

  const tickLower = record["tickLower"];
  const tickUpper = record["tickUpper"];
  if (
    typeof tickLower !== "number" || !Number.isInteger(tickLower)
    || typeof tickUpper !== "number" || !Number.isInteger(tickUpper)
  ) {
    return fellBack("PROPOSAL_MALFORMED", "tickLower and tickUpper must be integers.");
  }

  let bias: BrainRangeBias = "centered";
  if ("bias" in record && record["bias"] !== undefined) {
    const declared = record["bias"];
    if (declared !== "centered" && declared !== "above" && declared !== "below") {
      return fellBack("PROPOSAL_MALFORMED", 'bias must be "centered", "above" or "below".');
    }
    bias = declared;
  }

  if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
    return fellBack("TICKS_NOT_SNAPPED", "Proposed ticks are not snapped to the pool's tick spacing.");
  }
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK || tickLower >= tickUpper) {
    return fellBack("RANGE_OUT_OF_BOUNDS", "Proposed range is inverted or outside the global tick bounds.");
  }
  const width = tickUpper - tickLower;
  if (width < 2 * tickSpacing || width > maxTickWidth) {
    return fellBack(
      "WIDTH_OUT_OF_BOUNDS",
      `Proposed width ${width} is outside [${2 * tickSpacing}, ${maxTickWidth}].`,
    );
  }

  // Placement per bias. `floorTick` is the usable tick at/below the current
  // price; `floorTick + tickSpacing` the one just above it.
  const floorTick = nearestUsableTick(currentTick, tickSpacing);
  if (bias === "centered") {
    if (!(tickLower <= currentTick && currentTick < tickUpper)) {
      return fellBack("RANGE_MISPLACED", "A centered range must contain the current tick.");
    }
  } else if (bias === "above") {
    if (tickLower !== floorTick && tickLower !== floorTick + tickSpacing) {
      return fellBack(
        "RANGE_MISPLACED",
        "An above-biased range must start at the usable tick at or just above the current price.",
      );
    }
  } else {
    if (tickUpper !== floorTick && tickUpper !== floorTick + tickSpacing) {
      return fellBack(
        "RANGE_MISPLACED",
        "A below-biased range must end at the usable tick at or just above the current price.",
      );
    }
  }

  return { outcome: "accepted", kind: "range", tickLower, tickUpper, bias };
}

function fencePool(proposal: unknown, fence: PoolFenceContext): FenceVerdict {
  if (fence.survivors.length === 0) {
    // An empty survivor set REFUSES the open upstream (R15); reaching the
    // fence with one is a caller bug, not a brain failure.
    throw new Error("pool fence: the survivor list must not be empty.");
  }
  const normalizedSurvivors = fence.survivors.map((entry) => {
    if (!isAddress(entry)) {
      throw new Error("pool fence: the survivor list contains an invalid address.");
    }
    return getAddress(entry);
  });
  const head = normalizedSurvivors[0];
  if (head === undefined) {
    throw new Error("pool fence: the survivor list must not be empty.");
  }
  const fellBack = (code: FenceFallbackCode, reason: string): FenceVerdict => ({
    outcome: "fell-back",
    code,
    reason,
    fallback: { kind: "pool", poolAddress: head },
  });

  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) {
    return fellBack("PROPOSAL_MALFORMED", "Pool proposal is not an object.");
  }
  const record = proposal as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!POOL_PROPOSAL_KEYS.has(key)) {
      return fellBack("PROPOSAL_MALFORMED", `Pool proposal carries an unexpected field "${key}".`);
    }
  }
  const choice = record["poolChoice"];
  if (typeof choice !== "string" || !isAddress(choice)) {
    return fellBack("PROPOSAL_MALFORMED", "poolChoice must be a valid address string.");
  }
  const normalized = getAddress(choice);
  if (!normalizedSurvivors.includes(normalized)) {
    return fellBack(
      "POOL_NOT_IN_SURVIVOR_SET",
      "poolChoice is outside the deterministic survivor set; falling back to its head.",
    );
  }
  return { outcome: "accepted", kind: "pool", poolAddress: normalized };
}

/* -------------------------------------------------------------------------- */
/* Swapless rotate (PHASE3.13)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which side of the current price a swapless rotate parks its principal on.
 *
 * `"above"` — the price left the prior range DOWNWARD (`tick < priorLower`), so
 * the zap-out freed (almost) all TOKEN0 and the new range sits strictly ABOVE
 * the tick, where `getLiquidityForAmounts` charges token0 only.
 * `"below"` — the mirror: the price left UPWARD (`tick >= priorUpper`), the
 * principal is token1, the range sits at or below the tick.
 *
 * POOL ORDER, never role order. The 3.12 review's F7 is the reason this type
 * exists at all: `freedWbnbWei`/`freedTokenWei` invert for every pool where
 * `wbnbIsToken0 === false`, so a side decided on the WBNB/TOKEN naming is
 * inverted on roughly half of BSC's pools.
 */
export type SwaplessRotationSide = "above" | "below";

/**
 * The residue bound, in bps of the freed value, and the ONE threshold the
 * swapless mode is allowed to strand (PHASE3.13 review OQ1/F2).
 *
 * It is read at BOTH seams — the sweep's skip decision and the mint's bind —
 * through {@link swaplessResidueWithinBound}, and that is the whole of F2's
 * ruling: the spec proposed a "majority of the freed value" bind at the mint,
 * which is 5000 bps, and a rotate whose off-side leg is 49 % of value would
 * have passed it and stranded 49 % of the principal.
 *
 * NOT owner-signed in v1, deliberately: a fourth settings key is a fourth
 * digest surface and a knob whose wrong value strands principal. This is a
 * safety bound, not a strategy choice.
 */
export const SWAPLESS_MAX_RESIDUE_BPS = 50;

/**
 * The side a swapless rotate would park on, from the FRESH tick relative to
 * the PRIOR range — or `undefined` when the tick is INSIDE the prior range, in
 * which case there is no side and the rotate must take the swapped shape.
 *
 * The `undefined` case is PHASE3.13 F4: a position resting one tick below its
 * own `tickUpper` is still IN RANGE and yet frees a near single-sided
 * principal, so "the residue is small" does NOT imply "a side exists". Both
 * conjuncts are required before the sweep may skip.
 *
 * The bounds match `rotationDeviationBps` in `src/lp/triggers.ts` exactly
 * (`<` lower, `>=` upper) because V3 ranges are lower-inclusive and
 * upper-exclusive, and a second convention here would move the boundary the
 * rotate trigger fired on.
 */
export function swaplessRotationSide(input: {
  readonly currentTick: number;
  readonly priorTickLower: number;
  readonly priorTickUpper: number;
}): SwaplessRotationSide | undefined {
  const { currentTick, priorTickLower, priorTickUpper } = input;
  if (!Number.isInteger(currentTick)) {
    throw new Error("swaplessRotationSide: currentTick must be an integer.");
  }
  if (!Number.isInteger(priorTickLower) || !Number.isInteger(priorTickUpper)) {
    throw new Error("swaplessRotationSide: the prior range ticks must be integers.");
  }
  if (priorTickUpper <= priorTickLower) {
    throw new Error("swaplessRotationSide: the prior range is inverted or empty.");
  }
  if (currentTick < priorTickLower) return "above";
  if (currentTick >= priorTickUpper) return "below";
  return undefined;
}

/** What {@link swaplessResidueWithinBound} measured, for the owner-facing text. */
export type SwaplessResidueVerdict = {
  /** `true` iff the OFF-SIDE leg is worth at most {@link SWAPLESS_MAX_RESIDUE_BPS}. */
  readonly within: boolean;
  /** The off-side leg, in ITS OWN units — the amount left in the wallet. */
  readonly residueWei: bigint;
  /** That leg's share of the total freed value, in bps. */
  readonly residueBps: bigint;
};

/**
 * The ONE residue predicate, read at BOTH seams (PHASE3.13 F2).
 *
 * Values both freed legs in TOKEN1 units at the RAIL-CHECKED spot price — the
 * same `spotSwapOutput` valuation `planLpSweep` uses, so the two cannot drift —
 * and answers whether the leg the swapless mint will DROP is small enough to
 * strand.
 *
 * Fail-closed on a zero total: nothing freed is not "a small residue", it is an
 * absent principal, and minting on it is never right.
 */
export function swaplessResidueWithinBound(input: {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly side: SwaplessRotationSide;
  readonly spotSqrtPriceX96: bigint;
}): SwaplessResidueVerdict {
  const { amount0, amount1, side, spotSqrtPriceX96 } = input;
  if (amount0 < 0n || amount1 < 0n) {
    throw new Error("swaplessResidueWithinBound: freed amounts must be nonnegative.");
  }
  if (spotSqrtPriceX96 <= 0n) {
    throw new Error("swaplessResidueWithinBound: the spot price must be positive.");
  }
  const amount0InToken1 = spotSwapOutput({
    amountInAfterFee: amount0,
    sqrtPriceX96: spotSqrtPriceX96,
    tokenInIsToken0: true,
  });
  const totalValue = amount1 + amount0InToken1;
  // "above" keeps token0 and drops token1; "below" is the mirror.
  const residueWei = side === "above" ? amount1 : amount0;
  const residueValue = side === "above" ? amount1 : amount0InToken1;
  if (totalValue <= 0n) {
    return { within: false, residueWei, residueBps: 0n };
  }
  return {
    within: residueValue * 10_000n <= totalValue * BigInt(SWAPLESS_MAX_RESIDUE_BPS),
    residueWei,
    residueBps: (residueValue * 10_000n) / totalValue,
  };
}

/**
 * The swapless rotate's range: the prior width, parked STRICTLY on one side of
 * the current tick, snapped to the spacing (3.12 review section 7 item 2, plus
 * PHASE3.13 F7).
 *
 * | side | anchor | why it is strictly one-sided |
 * | --- | --- | --- |
 * | `"above"` | `tickLower = floorTick + tickSpacing` | `floorTick <= currentTick` and both are integers, so `tickLower >= currentTick + 1 > currentTick` |
 * | `"below"` | `tickUpper = floorTick` | `floorTick <= currentTick`, so the range ends at or below the tick |
 *
 * `tickLower = floorTick` is FORBIDDEN for `"above"`: when `currentTick` is
 * itself a multiple of the spacing it equals the tick, and the range then
 * CONTAINS it — the mint would be sized by the dust leg.
 *
 * TRUNCATE, NEVER SHIFT (3.12 review F6). `centeredRotationRange`'s clamp
 * slides the whole window inside the global bounds, which for an adjacent range
 * would slide it back ACROSS the tick — the one thing this function exists to
 * prevent. Here the width is truncated toward the anchor instead, and when the
 * minimum `2 * tickSpacing` no longer fits, the function REFUSES.
 *
 * REFUSES rather than truncates on an out-of-bounds ANCHOR (F7 cases 1 and 2).
 * `nearestUsableTick` returns `MIN_TICK`/`MAX_TICK` VERBATIM at the extremes
 * and neither is a multiple of 10/50/100/200 (`887272 = 8 * 110909`), so an
 * anchor derived from its clamped return would be unaligned and the NFPM mint
 * would revert on the pool's own tick check — AFTER the zap-out committed. The
 * anchor is therefore derived from the usable multiples directly, and a tick
 * outside them refuses PRE-MONEY at the sweep build.
 *
 * `maxTickWidth` is REQUIRED (F7 case 3): without it a wide imported position
 * (Phase 3.4) rotates into a range wider than the owner's configured maximum,
 * which is the pre-existing gap the 3.12 review's F5 recorded and which this
 * function must not inherit.
 */
export function adjacentRotationRange(input: {
  readonly currentTick: number;
  readonly priorWidthTicks: number;
  readonly tickSpacing: number;
  readonly maxTickWidth: number;
  readonly side: SwaplessRotationSide;
}): { tickLower: number; tickUpper: number } {
  const { currentTick, priorWidthTicks, tickSpacing, maxTickWidth, side } = input;
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("adjacentRotationRange: tickSpacing must be a positive integer.");
  }
  if (!Number.isInteger(currentTick) || currentTick < MIN_TICK || currentTick > MAX_TICK) {
    throw new Error("adjacentRotationRange: currentTick is out of the global tick bounds.");
  }
  if (!Number.isInteger(priorWidthTicks) || priorWidthTicks <= 0) {
    throw new Error("adjacentRotationRange: priorWidthTicks must be a positive integer.");
  }
  if (!Number.isInteger(maxTickWidth) || maxTickWidth < 2 * tickSpacing) {
    throw new Error("adjacentRotationRange: maxTickWidth must be an integer >= 2 * tickSpacing.");
  }

  // The usable multiples of the spacing, computed here rather than taken from
  // `nearestUsableTick`'s clamped return — see the docstring.
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  const floorTick = Math.floor(currentTick / tickSpacing) * tickSpacing;
  if (floorTick < minUsable || floorTick > maxUsable) {
    throw new Error(
      `adjacentRotationRange: the current tick ${currentTick} has no spacing-aligned anchor inside [${minUsable}, ${maxUsable}]; refusing rather than emitting an unaligned range.`,
    );
  }

  // Width in WHOLE spacing steps, so both emitted ticks are multiples of the
  // spacing. Flooring the division is the truncation the ceiling demands: a
  // width rounded UP could exceed `maxTickWidth`.
  const requested = Math.min(priorWidthTicks, maxTickWidth);
  let steps = Math.max(2, Math.floor(requested / tickSpacing));

  if (side === "above") {
    const tickLower = floorTick + tickSpacing;
    const available = Math.floor((maxUsable - tickLower) / tickSpacing);
    if (available < 2) {
      throw new Error(
        `adjacentRotationRange: no range of at least ${2 * tickSpacing} ticks fits strictly above tick ${currentTick} inside the global bounds; refusing.`,
      );
    }
    if (steps > available) steps = available;
    return { tickLower, tickUpper: tickLower + steps * tickSpacing };
  }

  const tickUpper = floorTick;
  const available = Math.floor((tickUpper - minUsable) / tickSpacing);
  if (available < 2) {
    throw new Error(
      `adjacentRotationRange: no range of at least ${2 * tickSpacing} ticks fits at or below tick ${currentTick} inside the global bounds; refusing.`,
    );
  }
  if (steps > available) steps = available;
  return { tickLower: tickUpper - steps * tickSpacing, tickUpper };
}

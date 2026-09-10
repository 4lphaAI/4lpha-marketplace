/**
 * The buy-first V2 grid ladder — PURE (QUANT-GRID §4, R2.3, R3.5, R4.1, R4.4,
 * R5.4, R6.3, R7.2).
 *
 * No network, no clock, no environment, no store. Every quantity is a `bigint`
 * of wei and every division names its rounding direction, because a floor where
 * a ceiling belongs is how a floor stops being one.
 *
 * The RUNTIME closure of this module is pinned to zero `src/` modules outside
 * `src/quant/`, `src/core/types.ts` and `src/ops/relayFee.ts`
 * (`test/quant.boundary.test.ts`).
 *
 * ─── WHAT IS KEPT FROM THE V3 GRID, AND WHAT IS NOT ────────────────────────
 *
 * KEPT (the semantics that survived PHASE3.15's audit): a touch is never a
 * fill (STRICT inequalities), at most one action per level per observation,
 * sells before buys, gas as a disclosed line item, and a hold that names its
 * remedy. NOT kept: ticks, resting positions, `swapSplitIsTotal`. V2 has no
 * resting orders — a "level" is a market swap the worker submits when the price
 * crosses it, which is also the only shape TermiX's swap-event indexer scores.
 *
 * ─── PRICES ────────────────────────────────────────────────────────────────
 *
 * ONE unit throughout: `midE18` = U wei per 1 WBNB. It is read from the pair's
 * own reserves at a finalized block, so the pool that triggers an action is the
 * pool the swap executes on and there is nothing to disagree with.
 */
import { RELAY_FEE_PER_EXIT_WEI } from "../ops/relayFee.js";
import type { QuantStrategyParams } from "./config.js";

export const E18 = 10n ** 18n;
export const BPS = 10_000n;

/** V2's per-leg fee, in bps. Restated here so this module imports no config. */
export const V2_FEE_BPS_PURE = 25n;

/** Below this a cycle's remaining base is dust and the cycle closes (R6.3). */
export const DUST_WEI = 1_000_000_000_000n;

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("ceilDiv requires a positive denominator.");
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/** The relay-fee estimate every economic decision uses (R5.6). */
export function feeEst(params: Pick<QuantStrategyParams, "relayFeePerSubmitWei">): bigint {
  return 3n * params.relayFeePerSubmitWei;
}

/** One relay-fee estimate valued in U at `midE18`. */
export function feeEstInU(
  params: Pick<QuantStrategyParams, "relayFeePerSubmitWei">,
  midE18: bigint,
): bigint {
  return (feeEst(params) * midE18) / E18;
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `mid = reserveU * 1e18 / reserveWBNB`, floor.
 *
 * Wei-exact and rounded DOWN, so an observation never overstates the price a
 * sell is measured against.
 */
export function midFromReserves(reserveUWei: bigint, reserveWbnbWei: bigint): bigint {
  if (reserveWbnbWei <= 0n || reserveUWei <= 0n) {
    throw new Error("A V2 pair with a zero reserve has no price.");
  }
  return (reserveUWei * E18) / reserveWbnbWei;
}

/* -------------------------------------------------------------------------- */
/* Ladder geometry (R2.3)                                                     */
/* -------------------------------------------------------------------------- */

export type QuantLadder = {
  readonly levels: number;
  readonly clipUWei: bigint;
  /** The remainder of `allocation / levels`. Idle, recorded, never traded. */
  readonly idleUWei: bigint;
  readonly p0E18: bigint;
  /** Index 0 is `P0`; levels are 1..`levels`. */
  readonly buyPrice: readonly bigint[];
  /** Index 0 is unused; levels are 1..`levels`. */
  readonly sellPrice: readonly bigint[];
};

export type LadderResult =
  | { readonly ok: true; readonly ladder: QuantLadder }
  | { readonly ok: false; readonly code: "below-minimum" | "arm-degenerate" };

/**
 * Build the ladder. Levels compound DOWN from `P0`; every level starts in U.
 *
 * There is no arm swap. Consequence, disclosed in the listing methodology: in
 * a sustained uptrend the ladder never fills and the job ends flat in U, and
 * realized PnL comes from dip-and-recover cycles only. Seeding half the book in
 * WBNB at arm is a SECOND LISTING (OQ1), not a hidden branch of this one.
 */
export function buildLadder(input: {
  readonly allocationUWei: bigint;
  readonly p0E18: bigint;
  readonly params: QuantStrategyParams;
}): LadderResult {
  const { allocationUWei, p0E18, params } = input;
  if (allocationUWei < params.minClipUWei) return { ok: false, code: "below-minimum" };
  if (p0E18 <= 0n) return { ok: false, code: "arm-degenerate" };
  const raw = allocationUWei / params.minClipUWei;
  const levels = Number(raw > BigInt(params.maxLevels) ? BigInt(params.maxLevels) : raw);
  if (levels < 1) return { ok: false, code: "below-minimum" };
  const clipUWei = allocationUWei / BigInt(levels);
  const buyPrice: bigint[] = [p0E18];
  const sellPrice: bigint[] = [0n];
  const band = BigInt(params.bandBps);
  for (let index = 1; index <= levels; index += 1) {
    const previous = buyPrice[index - 1];
    if (previous === undefined) return { ok: false, code: "arm-degenerate" };
    const next = (previous * (BPS - band)) / BPS; // floor
    if (next <= 0n || next >= previous) return { ok: false, code: "arm-degenerate" };
    buyPrice.push(next);
    const sell = ceilDiv(next * (BPS + band), BPS); // ceiling
    if (sell <= next) return { ok: false, code: "arm-degenerate" };
    sellPrice.push(sell);
  }
  return {
    ok: true,
    ladder: {
      levels,
      clipUWei,
      idleUWei: allocationUWei - clipUWei * BigInt(levels),
      p0E18,
      buyPrice,
      sellPrice,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The arm cost floor (R3.5)                                                  */
/* -------------------------------------------------------------------------- */

export type ArmFloorResult = {
  /** True when the band covers every modelled cost plus the required edge. */
  readonly economic: boolean;
  readonly gasBps: bigint;
  readonly impactBps: bigint;
  readonly requiredBps: bigint;
};

/**
 * Is a clip of this size economic AT ALL on this pool?
 *
 * `gasBps` uses the SAME 3× pad the native reservation uses (R3.5, accepting
 * REVIEW2 C8): a 3× pad in the balance check with a 1× estimate in the floor
 * was inconsistent, and the inconsistency was in the direction that loses
 * money. Re-evaluated every cycle until `endsAt`, because pool depth moves.
 */
export function armFloor(input: {
  readonly clipUWei: bigint;
  readonly midE18: bigint;
  readonly impactBps: bigint;
  readonly params: QuantStrategyParams;
}): ArmFloorResult {
  const { clipUWei, midE18, impactBps, params } = input;
  const gasBps = clipUWei <= 0n
    ? BPS * 100n
    : ceilDiv(2n * feeEst(params) * midE18 * BPS, clipUWei * E18);
  const requiredBps =
    2n * V2_FEE_BPS_PURE
    + BigInt(params.entryTolBps)
    + BigInt(params.exitTolBps)
    + impactBps
    + gasBps
    + BigInt(params.minNetEdgeBps);
  return {
    economic: BigInt(params.bandBps) >= requiredBps,
    gasBps,
    impactBps,
    requiredBps,
  };
}

/**
 * The smallest WBNB amount whose sale at `sellPriceE18` covers one relay-fee
 * estimate plus `minNetEdgeBps` of itself (R4.3).
 *
 * Used twice: as the per-row admission floor for a WBNB cap, and as the
 * PERSISTED `residual_threshold_wei` — the only size a final chunk may be
 * closed as residual at (R7.2). Persisting it is what stops a later mid from
 * silently redefining "residual".
 */
export function economicMinSellWei(input: {
  readonly sellPriceE18: bigint;
  readonly midE18: bigint;
  readonly params: QuantStrategyParams;
}): bigint {
  const { sellPriceE18, midE18, params } = input;
  if (sellPriceE18 <= 0n) return 0n;
  const feeU = feeEstInU(params, midE18);
  const net = BPS - BigInt(params.minNetEdgeBps);
  if (net <= 0n) return 0n;
  return ceilDiv(feeU * BPS * E18, sellPriceE18 * net);
}

/* -------------------------------------------------------------------------- */
/* Triggers (R2.0.1 / R2.3)                                                   */
/* -------------------------------------------------------------------------- */

export type QuantTriggerSide = "buy" | "sell" | null;

/**
 * Does the price CROSS this level, right now? STRICT on both sides.
 *
 * `mid == buyPrice` is NOT a fill. That is the PHASE3.15 semantic kept
 * verbatim: a touch that counted would be free money in the model and a loss
 * on the chain.
 */
export function levelTriggerSide(input: {
  readonly midE18: bigint;
  readonly buyPriceE18: bigint;
  readonly sellPriceE18: bigint;
  readonly holdingBase: boolean;
}): QuantTriggerSide {
  if (input.holdingBase) {
    return input.midE18 > input.sellPriceE18 ? "sell" : null;
  }
  return input.midE18 < input.buyPriceE18 ? "buy" : null;
}

export type TriggerEvidence = {
  readonly consecutive: number;
  readonly side: QuantTriggerSide;
};

/**
 * Advance the two-observation trigger latch (R2.0.1, adopted from the review's
 * OQ2 answer and reversing the body's single-reading proposal).
 *
 * The counter advances only on a NEW observation — identity is the finalized
 * BLOCK NUMBER — so a repeated `--once` against one lagging node cannot
 * manufacture the second reading. It RESETS whenever the condition fails, and
 * BC13/BC34 add three more resets the caller drives: an outage (two stale
 * readings), a pause, and any action on the level.
 */
export function advanceTrigger(
  previous: TriggerEvidence,
  side: QuantTriggerSide,
): TriggerEvidence {
  if (side === null) return { consecutive: 0, side: null };
  if (previous.side !== side) return { consecutive: 1, side };
  return { consecutive: previous.consecutive + 1, side };
}

/** Two consecutive readings, one worker interval apart, is the whole rule. */
export function triggerArmed(evidence: TriggerEvidence): boolean {
  return evidence.side !== null && evidence.consecutive >= 2;
}

/* -------------------------------------------------------------------------- */
/* Executable price guards (R2.3 H1, R3.5 C15, R4.1 tagging)                  */
/* -------------------------------------------------------------------------- */

/**
 * Make an action's `minOut` UNIQUE PER INTENT by construction (R4.1).
 *
 * `minOut = F + ((TAG − F) mod 1000 + 1000) mod 1000` — the smallest value ≥ F
 * whose last three decimal digits equal `TAG = levelIndex*100 + (action_seq mod
 * 100)`. It adds at most 999 wei to a floor that is ≥ 1e15 wei for any
 * admissible clip, and a STRICTER floor is always legal.
 *
 * Why it matters: `resolve --tx <hash>` accepts a receipt only when the decoded
 * intent's calldata is BYTE-EQUAL to the action's. Two equal-sized buys on one
 * job would otherwise share calldata, and one receipt would settle either.
 * Within a job at most one action per level is non-terminal and `action_seq` is
 * per level, so two non-terminal actions never share `(level, seq mod 100)`.
 */
export function tagMinOut(floorWei: bigint, levelIndex: number, actionSeq: number): bigint {
  if (floorWei <= 0n) throw new Error("A tagged minOut requires a positive floor.");
  const tag = BigInt(levelIndex * 100 + (actionSeq % 100));
  const delta = ((tag - floorWei) % 1000n + 1000n) % 1000n;
  return floorWei + delta;
}

/** The `(minOut mod 1000, deadline)` pair a resolver matches an intent on. */
export function actionTag(levelIndex: number, actionSeq: number): number {
  return levelIndex * 100 + (actionSeq % 100);
}

/**
 * The router deadline for an action (R4.1): `created_at + 600 + levelIndex`.
 *
 * The per-level offset is what keeps two levels' same-second intents
 * distinguishable in the calldata; ≤ +4 seconds, so it changes nothing
 * economically.
 */
export function actionDeadlineSec(createdAtSec: number, levelIndex: number): number {
  return createdAtSec + 600 + levelIndex;
}

export type BuyGuardInput = {
  readonly clipUWei: bigint;
  readonly buyPriceE18: bigint;
  readonly levelIndex: number;
  readonly actionSeq: number;
  readonly params: QuantStrategyParams;
};

/**
 * The BUY's economic floor, anchored to the LEVEL price rather than to the
 * quote (H1).
 *
 * `minOut = ceilDiv(clip * 1e18 * BPS, buyPrice * (BPS + entryTolBps))` — the
 * WBNB a clip must buy at a price no worse than `buyPrice × (1 +
 * entryTolBps/10000)`. So a finalized-96 / latest-105 divergence REFUSES the
 * buy instead of filling at 105. The buy ceiling intentionally permits that
 * tolerance above the nominal level (REVIEW7 condition 3).
 *
 * `ceilDiv`, not floor (C15): every lower-output bound rounds UP.
 */
export function buyMinOut(input: BuyGuardInput): bigint {
  if (input.buyPriceE18 <= 0n) throw new Error("A buy guard requires a positive level price.");
  const floor = ceilDiv(
    input.clipUWei * E18 * BPS,
    input.buyPriceE18 * (BPS + BigInt(input.params.entryTolBps)),
  );
  return tagMinOut(floor, input.levelIndex, input.actionSeq);
}

export type SellGuardInput = {
  /** The chunk being sold, in WBNB wei. */
  readonly amountWei: bigint;
  /** The cycle's total base at cycle start, for the pro-rata split. */
  readonly baseAtCycleStartWei: bigint;
  /** The cycle's U basis — the buy's measured `fill_in_wei`. */
  readonly basisUWei: bigint;
  /** The cycle's entry cost estimate in U (one `FEE_EST`, valued at fill time). */
  readonly entryCostUWei: bigint;
  readonly sellPriceE18: bigint;
  /** The CURRENT mid — the exit-fee bound is valued fresh every intent (BC29). */
  readonly midE18: bigint;
  readonly levelIndex: number;
  readonly actionSeq: number;
  readonly params: QuantStrategyParams;
};

export type SellFloor = {
  /** The tagged `minOut` actually sent to the router. */
  readonly minOutWei: bigint;
  /** The untagged economic floor, for the operator-facing note. */
  readonly floorWei: bigint;
  /** The band-derived floor, for evidence. */
  readonly levelFloorWei: bigint;
  /** The basis-derived floor, for evidence. */
  readonly basisFloorWei: bigint;
};

/**
 * The SELL's floor: the HIGHER of the band's price and the actual basis plus
 * costs plus the required edge (R3.5, R4.4 partial rules).
 *
 * Anchoring to the ACTUAL basis is what stops H9 — "a profitable sell held by
 * nominal band arithmetic": a sell is admitted whenever it clears its basis,
 * its share of the entry estimate, one full exit estimate and the edge.
 *
 * PERSISTED FLOORS ARE SNAPSHOTS, NEVER FROZEN FEE VALUATIONS (REVIEW7
 * condition 3 / BC29). The exit bound is converted at the CURRENT mid on every
 * intent, so a rise in BNB against U cannot leave a stale floor admitting a
 * sell that no longer covers its own gas.
 */
export function sellFloor(input: SellGuardInput): SellFloor {
  const {
    amountWei, baseAtCycleStartWei, basisUWei, entryCostUWei,
    sellPriceE18, midE18, params,
  } = input;
  if (amountWei <= 0n) throw new Error("A sell guard requires a positive amount.");
  if (baseAtCycleStartWei <= 0n) {
    throw new Error("A sell guard requires a positive cycle base.");
  }
  // `ceilDiv`, not floor (R3.5 C15, audit A3): every lower-output bound rounds
  // UP, and this one is a lower-output bound like any other. Worth < 1 wei;
  // kept for consistency, because the exception is what a later reader copies.
  const levelFloorWei =
    ceilDiv(amountWei * sellPriceE18 * (BPS - BigInt(params.exitTolBps)), BPS * E18);
  const basisShare = ceilDiv(basisUWei * amountWei, baseAtCycleStartWei);
  const entryShare = ceilDiv(entryCostUWei * amountWei, baseAtCycleStartWei);
  const exitBoundU = feeEstInU(params, midE18);
  const basisFloorWei =
    ceilDiv(basisShare * (BPS + BigInt(params.minNetEdgeBps)), BPS) + entryShare + exitBoundU;
  const floorWei = levelFloorWei > basisFloorWei ? levelFloorWei : basisFloorWei;
  return {
    minOutWei: tagMinOut(floorWei, input.levelIndex, input.actionSeq),
    floorWei,
    levelFloorWei,
    basisFloorWei,
  };
}

/**
 * Is a quote acceptable for an intent? BC16: compared against the FINAL TAGGED
 * minimum, never against the untagged floor.
 *
 * The block-lag rule is part of the same question: a quote read too far after
 * the trigger is a different market.
 */
export function quoteAcceptable(input: {
  readonly quoteOutWei: bigint;
  readonly minOutWei: bigint;
  readonly quoteBlock: bigint;
  readonly triggerBlock: bigint;
  readonly maxQuoteLagBlocks: number;
}): { readonly ok: true } | { readonly ok: false; readonly code: "price-moved" | "quote-stale" } {
  if (input.quoteBlock < input.triggerBlock) return { ok: false, code: "quote-stale" };
  if (input.quoteBlock - input.triggerBlock > BigInt(input.maxQuoteLagBlocks)) {
    return { ok: false, code: "quote-stale" };
  }
  if (input.quoteOutWei < input.minOutWei) return { ok: false, code: "price-moved" };
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Exit partition (R7.2)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Split `baseWei` into near-equal chunks that each fit the SMALLEST WBNB cap.
 *
 * Quotient/remainder, not `ceil(base/k)` (R7.6 withdrew that): `k =
 * ceilDiv(base, Lmin)`, `q = base div k`, `r = base mod k`, giving `r` chunks
 * of `q+1` and `k−r` of `q`. Spread ≤ 1 wei, sum EXACT, every chunk ≤ `Lmin`
 * so `exit-capacity` is temporary by construction.
 *
 * Largest chunks first, so the residual — if one is ever reached — is the
 * SMALLEST chunk and therefore the only one that can fall below the persisted
 * residual threshold.
 */
export function partitionExit(baseWei: bigint, minCapLimitWei: bigint): readonly bigint[] {
  if (baseWei <= 0n) return [];
  if (minCapLimitWei <= 0n) throw new Error("An exit partition requires a positive cap.");
  const k = ceilDiv(baseWei, minCapLimitWei);
  const q = baseWei / k;
  const r = baseWei % k;
  const chunks: bigint[] = [];
  for (let index = 0n; index < r; index += 1n) chunks.push(q + 1n);
  for (let index = r; index < k; index += 1n) chunks.push(q);
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Native reservation (R5.5, amended by R6.4)                                 */
/* -------------------------------------------------------------------------- */

export type LevelObligation = {
  readonly kind: "holding-base" | "pending-buy" | "pending-sell" | "idle";
  /**
   * Inventory the level still owes an EXIT for, in WBNB wei — which is not the
   * same quantity as the level row's `base_wei` in two of the four cases, and
   * the caller is responsible for the difference (audit A1):
   *
   *   - `holding-base` — the level's own `base_wei`;
   *   - `pending-buy`  — the WBNB the pending buy's quote expects to acquire
   *                      (`base_wei` is still 0 until it settles);
   *   - `pending-sell` — the RESIDUE, `base_wei − amount_in_wei`, because the
   *                      chunk in flight is paying for itself;
   *   - `idle`         — nothing, and the field is ignored.
   */
  readonly baseWei: bigint;
};

/**
 * How much native a submission must be able to pay for, in wei.
 *
 * A BUY reserves its own submission AND every exit its own expected inventory
 * will need AND every other level's outstanding obligations — because a wallet
 * funded for exactly one fee that buys is a wallet that cannot sell, which is
 * the trap REVIEW's H2 named.
 *
 * A SELL reserves ONE fee and nothing else (R6.4). Exits REDUCE exposure and
 * must never be blocked by another level's reserve; that asymmetry is
 * deliberate and disclosed.
 */
export function requiredNativeWei(input: {
  readonly side: "buy" | "sell";
  /** For a buy: the WBNB the quote says this clip will acquire. */
  readonly ownBaseWei: bigint;
  readonly otherLevels: readonly LevelObligation[];
  readonly minCapLimitWei: bigint;
  readonly params: QuantStrategyParams;
}): bigint {
  const fee = feeEst(input.params);
  if (input.side === "sell") return fee;
  const cap = input.minCapLimitWei <= 0n ? 1n : input.minCapLimitWei;
  let submissions = 1n + ceilDiv(input.ownBaseWei, cap);
  for (const level of input.otherLevels) {
    if (level.kind === "idle") continue;
    if (level.kind === "holding-base") {
      submissions += ceilDiv(level.baseWei, cap);
      continue;
    }
    submissions += 1n + ceilDiv(level.baseWei, cap);
  }
  return fee * submissions;
}

/* -------------------------------------------------------------------------- */
/* Impact                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Price impact in bps, from a full quote and a 1 % probe.
 *
 * The SAME arithmetic as `src/trade/route.ts`'s `priceImpactBps`, restated here
 * rather than imported: `route.ts` is the trade layer and this module's runtime
 * closure is pinned. Two copies of four lines is the cheaper of the two
 * failure modes; a test pins them equal.
 */
export function quantPriceImpactBps(fullOut: bigint, onePercentProbeOut: bigint): bigint {
  const noImpact = onePercentProbeOut * 100n;
  if (noImpact <= 0n || fullOut >= noImpact) return 0n;
  return ((noImpact - fullOut) * BPS) / noImpact;
}

/** The shipped relay-fee constant, re-exported so a caller sees its provenance. */
export const QUANT_RELAY_FEE_PER_SUBMIT_WEI = RELAY_FEE_PER_EXIT_WEI;

/**
 * The CAPITAL FLOOR a grid arm has to clear, ported from the execution plane's
 * pure economics (`src/lp/gridTriggers.ts`: `gridNetEdge`,
 * `gridPresetMinEconomicSizeWei`, `gridShiftEconomics`, `gridLadderResilience`)
 * and from `scripts/live-grid.ts`'s client-side resilience refusal.
 *
 * WHY IT LIVES IN THE UI AT ALL: the floor is not a constant. It falls out of
 * the spread the geometry actually produces, and that spread depends on the
 * PRESET, on the SPREAD FACTOR and — the part an owner cannot guess — on the
 * pool's own tick spacing, which rounds the gap and width UP and so widens the
 * grid on a 0.25% pool far past what the preset name says. A single hardcoded
 * "min 0.02 BNB" is therefore right for one pool and wrong for every other.
 * Computing it here lets the deploy screen refuse before a signature instead of
 * after the plane's refusal.
 *
 * SAME DOCTRINE AS `geometry.ts`: this MIRRORS the plane; it never decides.
 * The arm route re-derives every figure and refuses on its own numbers, so a
 * divergence here can only produce a refusal or an over-funded grid, never a
 * grant the plane would not have made.
 */
import { getSqrtRatioAtTick } from "@/lib/exec/pairs";
import { deriveGridFromPreset, GRID_PRESETS, gridQuantizeUpToSpacing, type GridPresetId, type GridRange } from "./geometry";
import { GRID_DEFAULT_MIN_NET_EDGE_BPS, GRID_SHIFT_DEPLOY_PCT_BPS } from "./settings";

/**
 * `DEFAULT_LP_RELAY_FEE_PER_SUBMIT_WEI` (src/ops/policy.ts:1138) — 0.0001 BNB.
 *
 * Measured on mainnet 2026-08-27 at 0.0000126–0.0000388 BNB per submission, so
 * the shipped constant is a ~2.6x pad over the worst sample and the floors
 * below are padded in the same direction. A deployment that sets
 * `LP_RELAY_FEE_PER_SUBMIT_WEI` moves the plane's floor and not this one, which
 * is why {@link gridCapitalFloor} takes the fee as an argument: pass the hire
 * preview's `sizing.relayFeePerSubmitWei` whenever it is already loaded.
 */
export const DEFAULT_RELAY_FEE_PER_SUBMIT_WEI = 100_000_000_000_000n;

/** Port of `src/lp/rails.ts` `priceDeviationBps`, bigint-exact. */
export function priceDeviationBps(leftSqrtPriceX96: bigint, rightSqrtPriceX96: bigint): bigint {
  if (leftSqrtPriceX96 <= 0n || rightSqrtPriceX96 <= 0n) {
    throw new Error("Price-deviation inputs must be positive.");
  }
  const left = leftSqrtPriceX96 * leftSqrtPriceX96;
  const right = rightSqrtPriceX96 * rightSqrtPriceX96;
  const denominator = left < right ? left : right;
  const difference = left > right ? left - right : right - left;
  return (difference * 10_000n) / denominator;
}

/** The geometric midpoint tick of a range. Integer, floored. */
export function gridRangeMidpointTick(range: GridRange): number {
  return Math.floor((range.tickLower + range.tickUpper) / 2);
}

/** The spread the grid earns per cycle, measured between the range midpoints. */
export function gridGrossEdgeBps(buyRange: GridRange, sellRange: GridRange): bigint {
  return priceDeviationBps(
    getSqrtRatioAtTick(gridRangeMidpointTick(buyRange)),
    getSqrtRatioAtTick(gridRangeMidpointTick(sellRange)),
  );
}

/**
 * `gridPresetMinEconomicSizeWei` — the smallest LEVEL value whose spread still
 * covers one cycle's relay gas. `null` means no size ever does: the gross edge
 * does not even reach `minNetEdgeBps`, so only the geometry can fix it.
 */
export function gridMinEconomicSizeWei(input: {
  readonly grossEdgeBps: bigint;
  readonly minNetEdgeBps: bigint;
  readonly relayFeePerSubmitWei: bigint;
  readonly submissionsPerCycle?: number;
}): bigint | null {
  const headroom = input.grossEdgeBps - input.minNetEdgeBps;
  if (headroom <= 0n) return null;
  const numerator = BigInt(input.submissionsPerCycle ?? 2) * input.relayFeePerSubmitWei * 10_000n;
  // Rounds UP: truncation understates a conservatism bound.
  return (numerator + headroom - 1n) / headroom;
}

export type GridCapitalFloor = {
  /** The spread this geometry produces, in bps between the range midpoints. */
  readonly grossEdgeBps: bigint;
  /** The smallest DEPLOYED rung that clears the gas floor, or `null`. */
  readonly minRungWei: bigint | null;
  /**
   * The smallest BUDGET the arm route admits. Below this the plane refuses the
   * signature, so the deploy screen refuses first. `null` ⇒ no budget works.
   */
  readonly minBudgetWei: bigint | null;
  /**
   * The smallest budget at which the ladder can fund its FIRST motion
   * (`1/(1-d)` x {@link minBudgetWei}). Between the two an arm is ACCEPTED and
   * then settles nothing, which is why `live-grid` refuses here too — the UI
   * warns rather than blocks, keeping the plane's own admission as the bound.
   */
  readonly minFundableBudgetWei: bigint | null;
  /** `1/(1-deployPctBps)` in bps — 14286 at the default 30%. */
  readonly requiredMultipleBps: number;
};

/**
 * The floor for ONE armed grid, from the geometry the owner is about to sign.
 *
 * `grid-v1` (fixed): the budget IS the level, so the floor is the minimum
 * economic size. `grid-shift-v1` (what the marketplace hires today): a shift
 * deploys `deployPctBps` of HALF the budget per rung, so the budget floor is
 * that inverted — ~6.7x the rung at the default 30% — exactly as
 * `gridShiftEconomics` computes it, both integer floors in their real order.
 */
export function gridCapitalFloor(input: {
  readonly presetId: GridPresetId;
  readonly spreadFactor: number;
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly wbnbIsToken0: boolean;
  readonly profile: "grid-v1" | "grid-shift-v1";
  readonly relayFeePerSubmitWei?: bigint;
  readonly minNetEdgeBps?: number;
  readonly deployPctBps?: number;
}): GridCapitalFloor {
  const derived = deriveGridFromPreset({
    presetId: input.presetId,
    spreadFactor: input.spreadFactor,
    currentTick: input.currentTick,
    tickSpacing: input.tickSpacing,
    wbnbIsToken0: input.wbnbIsToken0,
  });
  const grossEdgeBps = gridGrossEdgeBps(derived.buyRange, derived.sellRange);
  const relayFeePerSubmitWei = input.relayFeePerSubmitWei ?? DEFAULT_RELAY_FEE_PER_SUBMIT_WEI;
  const minNetEdgeBps = BigInt(input.minNetEdgeBps ?? GRID_DEFAULT_MIN_NET_EDGE_BPS);
  // Both a fixed flip and a shift cycle cost TWO submissions
  // (`gridCycleSubmissions`: "fixed" ⇒ 2, "shift" ⇒ 2 x
  // MAX_SUBMISSIONS_PER_GRID_SHIFT_CYCLE, which is 1).
  const minRungWei = gridMinEconomicSizeWei({
    grossEdgeBps,
    minNetEdgeBps,
    relayFeePerSubmitWei,
    submissionsPerCycle: 2,
  });
  const deployPctBps = input.deployPctBps ?? GRID_SHIFT_DEPLOY_PCT_BPS;
  const minBudgetWei =
    minRungWei === null
      ? null
      : input.profile === "grid-v1"
        ? minRungWei
        : 2n * ((minRungWei * 10_000n + BigInt(deployPctBps) - 1n) / BigInt(deployPctBps));
  const requiredMultipleBps = Math.ceil(10_000 / (1 - deployPctBps / 10_000));
  const minFundableBudgetWei =
    minBudgetWei === null
      ? null
      : input.profile === "grid-v1"
        ? minBudgetWei
        : (minBudgetWei * BigInt(requiredMultipleBps) + 9_999n) / 10_000n;
  return { grossEdgeBps, minRungWei, minBudgetWei, minFundableBudgetWei, requiredMultipleBps };
}

/* ── The SHIPPED floor table ──────────────────────────────────────────────── */

/**
 * The capital floor as a FIXED table, keyed by execution model and pool fee
 * tier — and nothing else.
 *
 * WHY A TABLE AND NOT THE LIVE CALCULATION ABOVE: the floor turned out to
 * depend on exactly two things a screen already knows the moment a pool row
 * arrives — the preset and the fee tier (which fixes the tick spacing, and so
 * the quantization). The current tick moves the spread by at most one bps
 * through midpoint flooring, and every entry here is the WORST tick in its
 * tier, so a table lookup is never below what the live figure would have been.
 * Pricing it from a chain read made a number that arrives late, changes under
 * the owner mid-edit and is missing whenever the read fails. A constant cannot
 * do any of that.
 *
 * Generated from the plane's own `gridShiftEconomics` + `gridLadderResilience`
 * at `DEFAULT_RELAY_FEE_PER_SUBMIT_WEI`, `minNetEdgeBps: 0`, `deployPctBps:
 * 3000` (the `grid-shift-v1` hire profile), rounded UP to 4 places. Each is the
 * FUNDABLE floor — `1/(1-d)` x the plane's own admission — because a grid armed
 * between the two settles nothing. `economics.test.ts` re-derives every cell.
 *
 * A deployment that lowers `LP_RELAY_FEE_PER_SUBMIT_WEI` makes these
 * conservative, never wrong: the floor scales with the fee.
 */
export const GRID_CAPITAL_FLOOR_BNB: Record<GridPresetId, Record<number, string>> = {
  tight: { 100: "0.4141", 500: "0.2722", 2500: "0.0943", 10000: "0.0229" },
  standard: { 100: "0.2094", 500: "0.1905", 2500: "0.0943", 10000: "0.0229" },
  wide: { 100: "0.0939", 500: "0.0859", 2500: "0.0627", 10000: "0.0229" },
  "very-wide": { 100: "0.0466", 500: "0.0456", 2500: "0.0415", 10000: "0.0229" },
};

/** Fee tiers the table covers; 0.01% is also the worst case of every preset. */
export const GRID_FLOOR_FALLBACK_FEE = 100;

/**
 * The floor for one execution model, in BNB. An unknown or unlisted fee tier
 * falls back to 0.01%, which is every preset's widest floor — a pool whose
 * spacing is unknown must not be underfunded on an optimistic guess.
 */
export function gridCapitalFloorBnb(presetId: GridPresetId, fee: number | null): string {
  const row = GRID_CAPITAL_FLOOR_BNB[presetId];
  return (fee === null ? undefined : row[fee]) ?? row[GRID_FLOOR_FALLBACK_FEE] as string;
}

/**
 * Which execution model a LIVE grid is running, read back from the geometry it
 * signed.
 *
 * The preset name is never signed (backend ruling Q6) — what the owner's
 * signature carries is the quantized gap and width — so the only honest way to
 * name the model on the agent page is to re-derive it: quantize each preset at
 * this pool's spacing and see which one produces these ticks. Two presets can
 * collapse onto the same geometry on a coarse pool (tight and standard are
 * identical at spacing 50), so the FIRST match wins and the ambiguity is real:
 * the agent is running that geometry whatever it was called at deploy.
 */
export function gridModelLabel(input: {
  readonly gapTicks: number | null;
  readonly widthTicks: number | null;
  readonly tickSpacing: number;
}): string | null {
  const { gapTicks, widthTicks, tickSpacing } = input;
  if (gapTicks === null || widthTicks === null || !Number.isInteger(tickSpacing) || tickSpacing <= 0) return null;
  for (const [presetId, preset] of Object.entries(GRID_PRESETS)) {
    const gap = gridQuantizeUpToSpacing(preset.gapBps, tickSpacing).ticks;
    const width = gridQuantizeUpToSpacing(preset.widthBps, tickSpacing).ticks;
    if (gap === gapTicks && width === widthTicks) return GRID_PRESETS[presetId as GridPresetId].label;
  }
  return "Custom";
}

/**
 * The floor as a BNB decimal string, rounded UP to `decimals` places so the
 * displayed number is never below the floor it reports (a rounded-DOWN figure
 * typed back into the stepper would be refused by the plane).
 */
export function formatFloorBnb(wei: bigint, decimals = 4): string {
  const scale = 10n ** BigInt(18 - decimals);
  const units = (wei + scale - 1n) / scale;
  const whole = units / 10n ** BigInt(decimals);
  const fraction = (units % 10n ** BigInt(decimals)).toString(10).padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

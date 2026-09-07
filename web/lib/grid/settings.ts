/**
 * Builds the byte-stable `settings` wire object for a FIXED-grid `gridArm`.
 *
 * Mirrors the plane's `lpSettingsParamsView` over `DEFAULT_LP_SETTINGS`
 * (src/lp/triggers.ts:1122) with the grid block attached. Present-only-when-set
 * keys (`priceStopLoss`, `priceTakeProfit`, `rotateMode`, and inside the grid
 * block `mode`/`policy`/`requote`/`ladder`/`shift`/`buyRange2`/`sellRange2`)
 * are DELIBERATELY absent: a fixed grid emits none of them, and emitting one at
 * its default would move the settings digest the worker recomputes every cycle.
 *
 * The arm route persists this object VERBATIM as the agent's settings row, so
 * building from defaults (rather than merging a stored row) is self-consistent
 * — the signature and the stored row are the same bytes.
 */
import type { GridRange } from "./geometry";

export const GRID_DEFAULT_MAX_FLIPS_PER_DAY = 12;
export const GRID_DEFAULT_MIN_NET_EDGE_BPS = 0;

export type FixedGridInput = {
  readonly pool: { readonly token0: string; readonly token1: string; readonly fee: number };
  readonly wbnbIsToken0: boolean;
  readonly tickSpacing: number;
  readonly buyRange: GridRange;
  readonly sellRange: GridRange;
  /** Whole percents from the UI; 0 disables (the plane's own default). */
  readonly stopLossPct: number;
  readonly takeProfitPct: number;
  readonly maxFlipsPerDay?: number;
  readonly minNetEdgeBps?: number;
};

export type ShiftGridInput = FixedGridInput & {
  readonly gapTicks: number;
  readonly widthTicks: number;
  /** The plane's configured relay fee per submission (wei, decimal) — required only when drift is enabled. */
  readonly relayFeePerSubmitWei?: string;
  readonly shiftsPerDay?: number;
  /** 0 disables drift (the default): the grid then moves only on a FILL. */
  readonly driftPctOfGap?: number;
};

export const GRID_SHIFT_DEPLOY_PCT_BPS = 3_000;
/**
 * DRIFT IS OFF BY DEFAULT — the grid re-anchors on a FILL, not on a price walk.
 *
 * PHASE3.25 splits shift motion into two lanes with opposite economics. A
 * CROSS (`shift_cause: "cross"`) is the re-anchor a fill causes: the fill just
 * realised the spread the motion is charged against, so it pays for itself and
 * the lane is bounded only by `shiftsPerDay` and the spacing floor. A DRIFT
 * (`shift_cause: "drift"`) is the re-anchor a price WALK causes: nothing was
 * filled, nothing was earned, and its gas is a pure draw on capital — which is
 * exactly what the first live agent did, seven drift motions in fifty minutes
 * with zero fills.
 *
 * `driftPctOfGap: 0` is the plane's own way of saying "drift disabled"
 * (`triggers.ts`: "must be 0 (drift disabled) or an integer in 25..200"), and
 * with it the two drift-gas fields are omitted — the validator requires them
 * signed together or not at all. What remains is the ping-pong an owner
 * expects: sit on the rungs until the price crosses one, then re-place on the
 * other side.
 */
export const GRID_SHIFT_DRIFT_PCT_OF_GAP = 0;
/**
 * The CROSS lane's daily allowance. 16 is the whole of what the
 * `grid-shift-v1` hire profile permits (`maxShiftMotionsPerDay: 16`), and with
 * drift disabled every one of the 16 is available to fills — where the old 8
 * split the budget with a lane that earns nothing.
 */
export const GRID_SHIFT_SHIFTS_PER_DAY = 16;
export const GRID_SHIFT_DRIFT_MOTIONS_PER_DAY = 8;
export const GRID_SHIFT_SUBMISSIONS_PER_MOTION = 2n;
export const GRID_SHIFT_MIN_MINUTES_BETWEEN_EXITS = 5;

/**
 * Builds the byte-stable settings for a SHIFT-grid gridArm (grid.mode "shift",
 * the PHASE3.22 atomic pair with PHASE3.25's split cadence). Mirrors
 * `scripts/live-grid.ts` `shiftBlockFrom`: gap/width from the preset geometry,
 * deploy 30% per side, drift at 60% of the gap, 8 settlements a day, and the
 * owner-signed drift lane = 8 motions x (2 submissions x relay fee). Both wei
 * fields are signed together, as the plane requires. Sizing stays inside the
 * `grid-shift-v1` hire profile (<= 16 motions a day at 5-minute spacing).
 */
export function buildShiftGridSettings(input: ShiftGridInput): Record<string, unknown> {
  const driftPctOfGap = input.driftPctOfGap ?? GRID_SHIFT_DRIFT_PCT_OF_GAP;
  // The drift gas pair is only signed when drift can actually spend it, so the
  // relay fee is required only in that case: a cross-only grid can be armed
  // without waiting for a hire preview.
  if (driftPctOfGap !== 0 && !/^\d+$/u.test(input.relayFeePerSubmitWei ?? "")) {
    throw new Error("relayFeePerSubmitWei must be a decimal wei string when drift is enabled.");
  }
  const driftPerMotionWei = GRID_SHIFT_SUBMISSIONS_PER_MOTION * BigInt(input.relayFeePerSubmitWei ?? "0");
  const driftGasBudgetWei = driftPerMotionWei * BigInt(GRID_SHIFT_DRIFT_MOTIONS_PER_DAY);
  // The plane requires maxFlipsPerDay === 1 under grid.mode "shift": a shift never creates a flip; 1 is the arm lane itself.
  const fixed = buildFixedGridSettings({ ...input, maxFlipsPerDay: 1 }) as { grid: Record<string, unknown> } & Record<string, unknown>;
  return {
    ...fixed,
    minMinutesBetweenExits: GRID_SHIFT_MIN_MINUTES_BETWEEN_EXITS,
    grid: {
      ...fixed.grid,
      mode: "shift",
      shift: {
        gapTicks: input.gapTicks,
        widthTicks: input.widthTicks,
        deployPctBps: GRID_SHIFT_DEPLOY_PCT_BPS,
        driftPctOfGap,
        shiftsPerDay: input.shiftsPerDay ?? GRID_SHIFT_SHIFTS_PER_DAY,
        // Signed together or not at all (`triggers.ts`: "a budget without its
        // price is a number nobody can spend").
        ...(driftPctOfGap === 0
          ? {}
          : {
              driftGasBudgetWei: driftGasBudgetWei.toString(10),
              driftPerMotionWei: driftPerMotionWei.toString(10),
            }),
      },
    },
  };
}

export function buildFixedGridSettings(input: FixedGridInput): Record<string, unknown> {
  return {
    autoRotate: false,
    autoHarvest: false,
    rotateBandBps: 0,
    rotateMinHoldMinutes: 0,
    harvestMinFeesWei: "2000000000000000",
    stopLossPct: input.stopLossPct,
    takeProfitPct: input.takeProfitPct,
    maxExitSequencesPerDay: 4,
    minMinutesBetweenExits: 30,
    brainEnabled: false,
    stakingEnabled: false,
    accumulateMode: "compound",
    minAprBps: 0,
    exitToQuote: true,
    grid: {
      pool: {
        token0: input.pool.token0.toLowerCase(),
        token1: input.pool.token1.toLowerCase(),
        fee: input.pool.fee,
      },
      wbnbIsToken0: input.wbnbIsToken0,
      tickSpacing: input.tickSpacing,
      buyRange: { tickLower: input.buyRange.tickLower, tickUpper: input.buyRange.tickUpper },
      sellRange: { tickLower: input.sellRange.tickLower, tickUpper: input.sellRange.tickUpper },
      maxFlipsPerDay: input.maxFlipsPerDay ?? GRID_DEFAULT_MAX_FLIPS_PER_DAY,
      minNetEdgeBps: input.minNetEdgeBps ?? GRID_DEFAULT_MIN_NET_EDGE_BPS,
    },
  };
}

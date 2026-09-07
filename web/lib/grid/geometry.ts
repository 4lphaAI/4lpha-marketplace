/**
 * Port of the execution plane's pure grid geometry
 * (`src/lp/gridGeometry.ts` + `gridQuantizeUpToSpacing` in `gridTriggers.ts`)
 * plus the CLIENT-side preset table from `scripts/live-grid.ts`.
 *
 * The preset name is never signed (backend ruling Q6); what the wallet signs
 * is the derived rung geometry. The server re-derives and cross-checks at arm
 * time (`admitGridSettings`), so a divergence here can only produce a refusal,
 * never a wrong grant.
 */

export type GridRange = { readonly tickLower: number; readonly tickUpper: number };

/** Uniswap/Pancake V3 global tick bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** Pancake V3 fee (hundredths of a bp) → tick spacing. */
export const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};

/** Nominal preset table (1 tick ≈ 1 bps), same numbers as `live-grid`. */
export const GRID_PRESETS = {
  tight: { gapBps: 15, widthBps: 15, label: "Tight Scalp" },
  standard: { gapBps: 30, widthBps: 30, label: "Balanced" },
  wide: { gapBps: 75, widthBps: 50, label: "Wide Band" },
  "very-wide": { gapBps: 150, widthBps: 100, label: "High Volatility" },
} as const;

export type GridPresetId = keyof typeof GRID_PRESETS;

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

export function gridDeriveRanges(input: {
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly gapTicks: number;
  readonly widthTicks: number;
  readonly wbnbIsToken0: boolean;
  readonly minTick?: number;
  readonly maxTick?: number;
}): { readonly buyRange: GridRange; readonly sellRange: GridRange } {
  const { currentTick: t, tickSpacing: s, gapTicks: g, widthTicks: w } = input;
  const minTick = input.minTick ?? MIN_TICK;
  const maxTick = input.maxTick ?? MAX_TICK;
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
  const above: GridRange = { tickLower: upperAnchor + g, tickUpper: upperAnchor + g + w };
  const below: GridRange = { tickLower: lowerAnchor - g - w, tickUpper: lowerAnchor - g };
  for (const range of [above, below]) {
    if (range.tickLower < minTick || range.tickUpper > maxTick) {
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
 * Preset + spread factor + pool facts → the quantized fixed-grid geometry the
 * owner will sign. Mirrors `live-grid arm`: quantize UP to spacing, then
 * derive both rungs from the current tick.
 */
export function deriveGridFromPreset(input: {
  readonly presetId: GridPresetId;
  readonly spreadFactor: number;
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly wbnbIsToken0: boolean;
}): {
  readonly gapTicks: number;
  readonly widthTicks: number;
  readonly gapClamped: boolean;
  readonly widthClamped: boolean;
  readonly buyRange: GridRange;
  readonly sellRange: GridRange;
} {
  if (input.spreadFactor < 0.25 || input.spreadFactor > 3) {
    throw new Error("spreadFactor must be within [0.25, 3].");
  }
  const preset = GRID_PRESETS[input.presetId];
  const gap = gridQuantizeUpToSpacing(preset.gapBps * input.spreadFactor, input.tickSpacing);
  const width = gridQuantizeUpToSpacing(preset.widthBps * input.spreadFactor, input.tickSpacing);
  const ranges = gridDeriveRanges({
    currentTick: input.currentTick,
    tickSpacing: input.tickSpacing,
    gapTicks: gap.ticks,
    widthTicks: width.ticks,
    wbnbIsToken0: input.wbnbIsToken0,
  });
  return {
    gapTicks: gap.ticks,
    widthTicks: width.ticks,
    gapClamped: gap.clamped,
    widthClamped: width.clamped,
    ...ranges,
  };
}

/** Decimal BNB string → wei, no float math (port of live-grid's budget flag). */
export function parseBnbToWei(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/u.test(trimmed)) {
    throw new Error(`Not a decimal BNB amount: "${value}".`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > 18) {
    throw new Error("BNB amounts carry at most 18 decimal places.");
  }
  return BigInt(whole ?? "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
}

export function formatWeiAsBnb(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString(10);
}

/**
 * The execution-plane port of the web deploy form's explicit price range.
 * Price-space containment is checked before outward tick snapping so the
 * signed band cannot silently widen after the owner has seen it.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MAX_RANGE_WIDTH_TICKS = 200_000;

const LOG_TICK_BASE = Math.log(1.0001);
export const SNAP_TOLERANCE_TICKS = 1e-3;

export type PoolOrientation = {
  readonly wbnbIsToken0?: boolean;
  readonly quoteIsToken0?: boolean;
  readonly decimals0?: number;
  readonly decimals1?: number;
};

export type ExplicitRange = {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly widthTicks: number;
  readonly snapped: boolean;
  readonly widened: boolean;
};

export type ExplicitRangeInput = PoolOrientation & {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly currentTick: number;
  readonly tickSpacing: number;
};

function quoteIsToken0Of(orientation: PoolOrientation): boolean {
  if (orientation.quoteIsToken0 !== undefined) return orientation.quoteIsToken0;
  if (orientation.wbnbIsToken0 !== undefined) return !orientation.wbnbIsToken0;
  throw new Error("A pool orientation needs quoteIsToken0 or wbnbIsToken0.");
}

function rawPriceFromTick(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/** Quote-per-base price at `tick`. Raw pool price is token1 per token0. */
export function priceFromTick(tick: number, orientation: PoolOrientation): number {
  const raw = rawPriceFromTick(tick, orientation.decimals0 ?? 18, orientation.decimals1 ?? 18);
  return quoteIsToken0Of(orientation) ? 1 / raw : raw;
}

/** The (generally non-integer) tick at a quote-per-base price. */
export function tickFromPrice(price: number, orientation: PoolOrientation): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("A price must be a positive number.");
  }
  const decimals0 = orientation.decimals0 ?? 18;
  const decimals1 = orientation.decimals1 ?? 18;
  const raw = quoteIsToken0Of(orientation) ? 1 / price : price;
  return Math.log(raw * Math.pow(10, decimals1 - decimals0)) / LOG_TICK_BASE;
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  const [mantissaRaw, exponentRaw] = price.toPrecision(8).split("e");
  const exponent = exponentRaw === undefined ? 0 : Number(exponentRaw);
  const mantissa = mantissaRaw ?? "0";
  const digits = mantissa.replace(".", "");
  const pointAt = (mantissa.indexOf(".") === -1 ? mantissa.length : mantissa.indexOf(".")) + exponent;
  let text: string;
  if (pointAt <= 0) text = `0.${"0".repeat(-pointAt)}${digits}`;
  else if (pointAt >= digits.length) text = `${digits}${"0".repeat(pointAt - digits.length)}`;
  else text = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  return text.includes(".") ? text.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0*$/u, "") : text;
}

export type DerivedRangeTicks = {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly minPrice: number;
  readonly maxPrice: number;
};

function requireSpacing(tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("The pool's tick spacing must be a positive integer.");
  }
  return tickSpacing;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function snapTickDown(tick: number, tickSpacing: number): number {
  return normalizeZero(Math.floor(tick / requireSpacing(tickSpacing)) * tickSpacing);
}

export function snapTickUp(tick: number, tickSpacing: number): number {
  return normalizeZero(Math.ceil(tick / requireSpacing(tickSpacing)) * tickSpacing);
}

export function rangeContainsTick(
  range: { readonly tickLower: number; readonly tickUpper: number },
  tick: number,
): boolean {
  return range.tickLower <= tick && tick < range.tickUpper;
}

export function rangeWidthPct(tickLower: number, tickUpper: number): number {
  return (Math.pow(1.0001, tickUpper - tickLower) - 1) * 100;
}

export function derivedRangeTicks(input: PoolOrientation & {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly tickSpacing: number;
}): DerivedRangeTicks | null {
  if (!Number.isFinite(input.minPrice) || !Number.isFinite(input.maxPrice)) return null;
  if (input.minPrice <= 0 || input.maxPrice <= 0 || !(input.maxPrice > input.minPrice)) return null;
  const spacing = requireSpacing(input.tickSpacing);
  const nearMultiple = (tick: number): number => {
    const rounded = Math.round(tick / spacing) * spacing;
    return Math.abs(tick - rounded) < SNAP_TOLERANCE_TICKS ? rounded : tick;
  };
  const a = nearMultiple(tickFromPrice(input.minPrice, input));
  const b = nearMultiple(tickFromPrice(input.maxPrice, input));
  return {
    tickLower: snapTickDown(Math.min(a, b), spacing),
    tickUpper: snapTickUp(Math.max(a, b), spacing),
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
  };
}

export function livePriceInsideBand(input: PoolOrientation & {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly liveTick: number;
}): { readonly inside: boolean; readonly livePrice: number } {
  const livePrice = priceFromTick(input.liveTick, input);
  return { inside: livePrice >= input.minPrice && livePrice <= input.maxPrice, livePrice };
}

export function explicitRangeFromPrices(input: ExplicitRangeInput): ExplicitRange {
  const tickSpacing = requireSpacing(input.tickSpacing);
  if (!(input.maxPrice > input.minPrice)) {
    throw new Error("The maximum price must be above the minimum price.");
  }
  const orientation: PoolOrientation = {
    ...(input.wbnbIsToken0 === undefined ? {} : { wbnbIsToken0: input.wbnbIsToken0 }),
    ...(input.quoteIsToken0 === undefined ? {} : { quoteIsToken0: input.quoteIsToken0 }),
    ...(input.decimals0 === undefined ? {} : { decimals0: input.decimals0 }),
    ...(input.decimals1 === undefined ? {} : { decimals1: input.decimals1 }),
  };
  const live = livePriceInsideBand({
    ...orientation,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    liveTick: input.currentTick,
  });
  if (!live.inside) {
    throw new Error(
      `The current price ${formatPrice(live.livePrice)} has left the typed band ${formatPrice(input.minPrice)} – ${formatPrice(input.maxPrice)}; re-read the form before signing.`,
    );
  }
  const a = tickFromPrice(input.minPrice, orientation);
  const b = tickFromPrice(input.maxPrice, orientation);
  const requestedLower = Math.min(a, b);
  const requestedUpper = Math.max(a, b);
  const derived = derivedRangeTicks({
    ...orientation,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    tickSpacing,
  });
  if (derived === null) throw new Error("The maximum price must be above the minimum price.");
  const tickLower = derived.tickLower;
  const tickUpper = derived.tickUpper;
  const snapped = tickLower !== requestedLower || tickUpper !== requestedUpper;
  const floor = snapTickUp(MIN_TICK, tickSpacing);
  const ceiling = snapTickDown(MAX_TICK, tickSpacing);
  if (tickLower < floor || tickUpper > ceiling) {
    throw new Error(`That range reaches past the pool's tick bounds [${floor}, ${ceiling}]; move the prices inward.`);
  }
  if (tickUpper - tickLower < 2 * tickSpacing) {
    throw new Error(
      `The range must be at least two tick spacings (${2 * tickSpacing} ticks) wide; this pair snaps to [${tickLower}, ${tickUpper}).`,
    );
  }
  const widened = false;
  if (tickUpper - tickLower > MAX_RANGE_WIDTH_TICKS) {
    throw new Error(
      `That range is ${tickUpper - tickLower} ticks wide; the open accepts at most ${MAX_RANGE_WIDTH_TICKS}. Narrow the price band.`,
    );
  }
  if (!rangeContainsTick({ tickLower, tickUpper }, input.currentTick)) {
    throw new Error(
      `A two-sided open must straddle the current price (tick ${input.currentTick}); this range is [${tickLower}, ${tickUpper}).`,
    );
  }
  return { tickLower, tickUpper, widthTicks: tickUpper - tickLower, snapped, widened };
}

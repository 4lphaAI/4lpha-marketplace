/**
 * Tick <-> price helpers for the LP deploy form's explicit range.
 *
 * The browser derives only advisory geometry from `/api/pool-state`; the
 * execution plane re-checks every signed tick against the pool spacing, the
 * width bounds, and the "current price must be inside" rule.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MAX_RANGE_WIDTH_TICKS = 200_000;

const LOG_TICK_BASE = Math.log(1.0001);

/**
 * Which leg the displayed price is QUOTED IN.
 *
 * `quoteIsToken0` decides the number the owner reads: the price is always
 * "quote per base" (BTCB/WBNB shows WBNB per BTCB ≈ 105, WBNB/USDT shows USDT
 * per WBNB ≈ 600) — the number PancakeSwap's own pool page shows. When only
 * `wbnbIsToken0` is given, the legacy reading applies: the quote is the
 * non-WBNB leg (`quoteIsToken0 === !wbnbIsToken0`).
 */
export type PoolOrientation = {
  readonly wbnbIsToken0?: boolean;
  readonly quoteIsToken0?: boolean;
  readonly decimals0?: number;
  readonly decimals1?: number;
};

const USDT_56 = "0x55d398326f99059ff775485246999027b3197955";
const USDC_56 = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const WBNB_56 = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

export type PoolQuote = {
  readonly quoteIsToken0: boolean;
  readonly quote: string;
  readonly base: string;
  readonly quoteSymbol: string;
  readonly baseSymbol: string;
};

/**
 * The numeraire rule the agent page already uses: a stablecoin leg (USDT, USDC)
 * is the quote; otherwise WBNB is the quote; otherwise token1. Prices are then
 * "quote per base", which is what the pool's own page shows.
 */
export function poolQuote(pool: {
  readonly token0: string;
  readonly token1: string;
  readonly token0Symbol?: string | null;
  readonly token1Symbol?: string | null;
}): PoolQuote {
  const t0 = pool.token0.toLowerCase();
  const t1 = pool.token1.toLowerCase();
  const stable = (address: string): boolean => address === USDT_56 || address === USDC_56;
  let quoteIsToken0: boolean;
  if (stable(t0) !== stable(t1)) quoteIsToken0 = stable(t0);
  else if ((t0 === WBNB_56) !== (t1 === WBNB_56)) quoteIsToken0 = t0 === WBNB_56;
  else quoteIsToken0 = false;
  const symbol = (address: string, given: string | null | undefined): string =>
    given ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
  return quoteIsToken0
    ? { quoteIsToken0, quote: t0, base: t1, quoteSymbol: symbol(t0, pool.token0Symbol), baseSymbol: symbol(t1, pool.token1Symbol) }
    : { quoteIsToken0, quote: t1, base: t0, quoteSymbol: symbol(t1, pool.token1Symbol), baseSymbol: symbol(t0, pool.token0Symbol) };
}

function quoteIsToken0Of(orientation: PoolOrientation): boolean {
  if (orientation.quoteIsToken0 !== undefined) return orientation.quoteIsToken0;
  if (orientation.wbnbIsToken0 !== undefined) return !orientation.wbnbIsToken0;
  throw new Error("A pool orientation needs quoteIsToken0 or wbnbIsToken0.");
}

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

/**
 * Significant-digit formatting for a price the owner reads: 8 significant
 * digits, NEVER scientific notation, never a trailing tail of zeros — so
 * 105.4322 and 0.00950091 both read as prices, not as machine output. Every
 * positive finite value keeps enough digits to round-trip through tick
 * snapping (a tick is 0.01 %; eight significant digits resolve 1e-4 tick).
 */
export function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  // Eight significant digits: 1e-8 relative ⇒ 1e-4 of a tick, so a price the
  // form derived from a tick snaps back onto that tick (see `derivedRangeTicks`).
  // `toPrecision` is exact for EVERY positive finite double; its exponent form
  // is expanded by hand so no value ever prints as scientific notation and no
  // value below `toFixed`'s 100-decimal ceiling collapses to "0".
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
  /** Outward-snapped bounds — exactly what `explicitRangeFromPrices` signs. */
  readonly tickLower: number;
  readonly tickUpper: number;
  /** The typed prices as a raw quote-per-base interval, before any snapping. */
  readonly minPrice: number;
  readonly maxPrice: number;
};

/**
 * THE ONE tick derivation for a typed price pair: both prices → ticks in the
 * given orientation, ordered, then snapped OUTWARD to the pool spacing (floor
 * below, ceil above). The form's labels, "Signed range" text, chart flags and
 * the signing helper all read this, so the owner never sees one geometry and
 * signs another. Returns null for a non-positive or inverted pair.
 */
export function derivedRangeTicks(input: PoolOrientation & {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly tickSpacing: number;
}): DerivedRangeTicks | null {
  if (!Number.isFinite(input.minPrice) || !Number.isFinite(input.maxPrice)) return null;
  if (input.minPrice <= 0 || input.maxPrice <= 0 || !(input.maxPrice > input.minPrice)) return null;
  const spacing = requireSpacing(input.tickSpacing);
  // A price the form itself produced from a tick (a −/+ step, a default) comes
  // back through `tickFromPrice` a hair off the exact multiple (1e-4 tick at
  // eight significant digits). Without this tolerance, floor/ceil would push
  // such a bound one whole spacing OUTWARD and the step would vanish.
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

/** Ticks within this distance of a spacing multiple are taken AS that multiple. */
export const SNAP_TOLERANCE_TICKS = 1e-3;

/**
 * The consent condition in PRICE space: the live price must sit inside the
 * RAW typed interval — checked BEFORE snapping, because outward snapping can
 * admit a live tick that already left the typed band by under one spacing.
 */
export function livePriceInsideBand(input: PoolOrientation & {
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly liveTick: number;
}): { readonly inside: boolean; readonly livePrice: number } {
  const livePrice = priceFromTick(input.liveTick, input);
  return { inside: livePrice >= input.minPrice && livePrice <= input.maxPrice, livePrice };
}

/** The price ratio a tick width spans, as a percentage: 1.0001^width − 1. */
export function rangeWidthPct(tickLower: number, tickUpper: number): number {
  return (Math.pow(1.0001, tickUpper - tickLower) - 1) * 100;
}

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
  // Consent condition FIRST, in price space and before any snapping: the live
  // price must still be inside the RAW typed interval. Outward snapping below
  // would otherwise admit a live tick that left the band by under one spacing
  // (review finding 1).
  const live = livePriceInsideBand({ ...orientation, minPrice: input.minPrice, maxPrice: input.maxPrice, liveTick: input.currentTick });
  if (!live.inside) {
    throw new Error(
      `The current price ${formatPrice(live.livePrice)} has left the typed band ${formatPrice(input.minPrice)} – ${formatPrice(input.maxPrice)}; re-read the form before signing.`,
    );
  }
  const a = tickFromPrice(input.minPrice, orientation);
  const b = tickFromPrice(input.maxPrice, orientation);
  const requestedLower = Math.min(a, b);
  const requestedUpper = Math.max(a, b);
  const requestedWidthTicks = requestedUpper - requestedLower;

  const derived = derivedRangeTicks({ ...orientation, minPrice: input.minPrice, maxPrice: input.maxPrice, tickSpacing });
  if (derived === null) throw new Error("The maximum price must be above the minimum price.");
  const tickLower = derived.tickLower;
  const tickUpper = derived.tickUpper;
  const snapped = tickLower !== requestedLower || tickUpper !== requestedUpper;

  // The shared derivation IS the signed geometry: nothing below adjusts it.
  // A pair that would need clamping or widening is REFUSED (fix-review
  // finding 1) — the old silent widen-to-minimum-width and clamp-to-bounds
  // made the labelled range differ from the signed one by a spacing.
  const floor = snapTickUp(MIN_TICK, tickSpacing);
  const ceiling = snapTickDown(MAX_TICK, tickSpacing);
  if (tickLower < floor || tickUpper > ceiling) {
    throw new Error(
      `That range reaches past the pool's tick bounds [${floor}, ${ceiling}]; move the prices inward.`,
    );
  }
  if (tickUpper - tickLower < 2 * tickSpacing) {
    throw new Error(
      `The range must be at least two tick spacings (${2 * tickSpacing} ticks) wide; this pair snaps to [${tickLower}, ${tickUpper}).`,
    );
  }
  // The helper never widens any more (fix review, finding 1): the flag stays on
  // the result type for its readers and is always false.
  const widened = false;
  void requestedWidthTicks;

  const widthTicks = tickUpper - tickLower;
  if (widthTicks > MAX_RANGE_WIDTH_TICKS) {
    throw new Error(
      `That range is ${widthTicks} ticks wide; the open accepts at most ${MAX_RANGE_WIDTH_TICKS}. Narrow the price band.`,
    );
  }
  if (!rangeContainsTick({ tickLower, tickUpper }, input.currentTick)) {
    throw new Error(
      `A two-sided open must straddle the current price (tick ${input.currentTick}); this range is [${tickLower}, ${tickUpper}).`,
    );
  }
  return { tickLower, tickUpper, widthTicks, snapped, widened };
}

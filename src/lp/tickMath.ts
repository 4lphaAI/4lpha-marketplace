/**
 * Uniswap V3 tick math + LP quote helpers, ported from `D:\4lpha-0G`
 * `lib/agent/lp/tick-math.ts` for Phase 3 (PancakeSwap V3 is a Uniswap-V3
 * fork, so the math is venue-independent).
 *
 * PURE AND OFFLINE: bigint arithmetic only, no network, no clock. Everything
 * here floors like Solidity `/` and `>>` unless a function name says otherwise
 * (the `...RoundingUp` mint-side helpers mirror v3-core's positive-liquidity
 * delta overloads, which round UP against the minter).
 *
 * TickMath constants are the canonical Uniswap V3 values (v3-sdk
 * `tickMath.ts`), reproduced verbatim and golden-vector pinned in
 * `test/lp.tickMath.test.ts` against the published `MIN_SQRT_RATIO` /
 * `MAX_SQRT_RATIO` / tick-0 constants.
 */

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

/** Published TickMath.MIN_SQRT_RATIO — getSqrtRatioAtTick(MIN_TICK). */
export const MIN_SQRT_RATIO = 4_295_128_739n;
/** Published TickMath.MAX_SQRT_RATIO - 1 is the max usable price; this is getSqrtRatioAtTick(MAX_TICK). */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q32 = 2n ** 32n;
export const Q96 = 2n ** 96n;
const BPS = 10_000n;
const MAX_UINT_256 = 2n ** 256n - 1n;

/** Ceil division — mirrors Solidity `(a + b - 1) / b`. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive");
  return (a + b - 1n) / b;
}

/**
 * `>= 1 wei` floor for slippage minimums. The NFPM refuses nothing at zero,
 * which is exactly the problem: a zero `amountMin` is a disabled slippage
 * check. Every derived floor in `src/lp/rails.ts` passes through this.
 */
export function flooredAtOneWei(value: bigint): bigint {
  return value < 1n ? 1n : value;
}

/**
 * `minLpOutFor(quote, bps)` — ceil of `quote * bps / 10000`. With bps=9500
 * this is ~95% of the quote, biased UP by the ceil so the floor is never
 * looser than the stated percentage. Ported verbatim from 0G
 * (`PolicyVaultV3.minLpOutFor` mirror); here the bps comes from
 * `10000 - maxSagaSlippageBps` (PHASE3 Rev2 item 23).
 */
export function minLpOutFor(quote: bigint, lpMinOutBps: number): bigint {
  if (!Number.isInteger(lpMinOutBps) || lpMinOutBps < 0 || lpMinOutBps > 10_000) {
    throw new Error("minLpOutFor: lpMinOutBps must be an integer in 0..10000");
  }
  const bps = BigInt(lpMinOutBps);
  return (quote * bps + (BPS - 1n)) / BPS;
}

/**
 * Round a tick DOWN to the nearest usable tick for a given spacing, clamped
 * to [MIN_TICK, MAX_TICK].
 *
 * PORT-FIDELITY NOTE (deliberate, reported): the 0G source floors
 * (`floor(tick / spacing) * spacing`) while the actual Uniswap v3-sdk
 * `nearestUsableTick` ROUNDS to the nearest multiple. We keep the 0G floor
 * semantics because `centeredRotationRange` (src/lp/fence.ts) was built and
 * tested against them, and a floor is deterministic and conservative for a
 * "usable tick at or below the current price" anchor. The clamp quirk is also
 * kept: MIN_TICK/MAX_TICK themselves are returned at the extremes even when
 * they are not multiples of the spacing.
 */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("nearestUsableTick: tickSpacing must be a positive integer");
  }
  if (!Number.isInteger(tick)) throw new Error("nearestUsableTick: tick must be an integer");
  const rounded = Math.floor(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return MIN_TICK;
  if (rounded > MAX_TICK) return MAX_TICK;
  return rounded;
}

/**
 * Single-sided-zap swap split: how much of the BASE token (WBNB here; W0G in
 * the 0G original) to swap into the paired side before an NFPM mint so the
 * two legs match the range's required ratio. Linear in tick distance, with
 * ceil bias toward the base side being the binding constraint (ported
 * verbatim from `ZiaLpAdapter._computeSwapAmount`'s mirror).
 *
 * Out-of-range inputs return 0 (all base) or the full amount (all paired) —
 * i.e. the split is TOTAL, and the caller is left holding exactly one leg.
 *
 * PHASE3.11 F4: this comment used to end "the mint floors reject those before
 * any money moves", and that is FALSE. The live out-of-range harvest is the
 * counter-example: the collect and the sweep both committed, and what refused
 * afterwards was the hand-written both-legs-positive check on the harvest's
 * `zap-in-increase` (`sagas.ts`), not a floor. Callers must decide what a
 * single-sided result means for them; nothing downstream here guarantees it is
 * caught before money moves.
 */
export function computeSwapAmount(
  amountBase: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  baseIsToken0: boolean,
): bigint {
  const range = tickUpper - tickLower;
  if (range <= 0) throw new Error("computeSwapAmount: tickUpper must be > tickLower");
  if (amountBase < 0n) throw new Error("computeSwapAmount: amountBase must be nonnegative");
  const numerator = baseIsToken0 ? currentTick - tickLower : tickUpper - currentTick;
  if (numerator <= 0) return 0n;
  if (numerator >= range) return amountBase;
  // ceilDiv(amountBase * numerator, range) — over-swap by <1 unit to bias the
  // base side into being the binding constraint.
  return ceilDiv(BigInt(numerator) * amountBase, BigInt(range));
}

/**
 * PHASE3.12 (R-E, F1): "would {@link computeSwapAmount}'s split be TOTAL here?"
 *
 * True iff EITHER of the two early returns above fires for EITHER value of
 * `baseIsToken0` — i.e. iff a single-sided-zap sweep planned at this tick would
 * sell one whole leg and leave the caller holding exactly one asset.
 *
 * It lives HERE, beside the arithmetic it describes, and is the ONE predicate
 * the harvest's trigger gate and its build-time refusal both read. The lesson
 * is this repo's own (`src/lp/triggers.ts` on `evaluateLpProtectBreach`): a
 * second hand-written tick comparison at another seam — `<` vs `<=`, one bound
 * or both — silently moves the boundary, and here the boundary IS the
 * difference between a harvest that compounds and the Phase 3.11 deadlock.
 *
 * Note what it is NOT: it is not V3 range membership. `currentTick ===
 * tickLower` is IN RANGE (ranges are lower-inclusive, upper-exclusive) and yet
 * the split is total there in BOTH orderings — `numerator === 0` when the base
 * is token0, `numerator === range` when it is token1. The predicate is
 * therefore the STRICT INTERIOR, one tick tighter than "in range" at the lower
 * bound, and that one tick is exactly the case the gate exists for.
 */
export function swapSplitIsTotal(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): boolean {
  if (tickUpper - tickLower <= 0) {
    throw new Error("swapSplitIsTotal: tickUpper must be > tickLower");
  }
  return !(tickLower < currentTick && currentTick < tickUpper);
}

function mulShift(n: bigint, x: bigint): bigint {
  // v3-sdk: `(n * x) >> 128` — keeps the Q128.128 representation stable across
  // each fixed-point multiply (constants are ~2^128, i.e. Q128 multipliers).
  return (n * x) >> 128n;
}

/**
 * Canonical Uniswap V3 `TickMath.getSqrtRatioAtTick`. Returns sqrtPriceX96
 * (Q64.96) for a tick. Throws outside [MIN_TICK, MAX_TICK]. Constants
 * verbatim from v3-sdk tickMath.ts.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK || !Number.isInteger(tick)) {
    throw new Error(`tick out of range: ${tick}`);
  }
  const absTick = tick < 0 ? -tick : tick;

  let ratio: bigint =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = MAX_UINT_256 / ratio;

  // back to Q96 — ceil if there is a remainder (matches v3-sdk).
  return ratio % Q32 > 0n ? ratio / Q32 + 1n : ratio / Q32;
}

/** `getLiquidityForAmount0` — v3-core LiquidityMath (floors). */
function getLiquidityForAmount0(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, amount0: bigint): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const intermediate = (sqrtRatioAX96 * sqrtRatioBX96) / Q96;
  return (amount0 * intermediate) / (sqrtRatioBX96 - sqrtRatioAX96);
}

/** `getLiquidityForAmount1` — v3-core LiquidityMath (floors). */
function getLiquidityForAmount1(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, amount1: bigint): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return (amount1 * Q96) / (sqrtRatioBX96 - sqrtRatioAX96);
}

/**
 * `getLiquidityForAmounts` — v3-core. Picks the binding liquidity depending
 * on where the current price sits relative to the position range.
 */
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const sqrtRatioAX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
  }
  if (sqrtPriceX96 < sqrtRatioBX96) {
    const liquidity0 = getLiquidityForAmount0(sqrtPriceX96, sqrtRatioBX96, amount0);
    const liquidity1 = getLiquidityForAmount1(sqrtRatioAX96, sqrtPriceX96, amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
}

/**
 * `getAmount0ForLiquidity` — v3-core LiquidityMath. Amount of token0 owed for
 * `liquidity` in the range. FLOORS (burn/decrease side).
 */
export function getAmount0ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const shifted = liquidity << 96n;
  const numerator = (shifted * (sqrtRatioBX96 - sqrtRatioAX96)) / sqrtRatioBX96;
  return numerator / sqrtRatioAX96;
}

/** `getAmount1ForLiquidity` — v3-core. FLOORS (burn/decrease side). */
export function getAmount1ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
}

/**
 * `getAmountsForLiquidity` — the [amount0, amount1] returned when BURNING
 * `liquidity` (decrease side, floors). Feeds the zap-out / decrease floors in
 * `src/lp/rails.ts` (PHASE3 Rev2 item 23).
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtRatioAX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return { amount0: getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < sqrtRatioBX96) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioBX96, liquidity),
      amount1: getAmount1ForLiquidity(sqrtRatioAX96, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) };
}

/**
 * Expected token amounts CHARGED by Uniswap V3 core for a positive-liquidity
 * mint/increase. Pool.mint uses the positive int128 SqrtPriceMath delta
 * overloads, which round UP; the burn/decrease helper above deliberately
 * rounds DOWN. Feeds the mint/increase floors (PHASE3 Rev2 item 23).
 */
export function getMintAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtRatioAX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return {
      amount0: getAmount0ForLiquidityRoundingUp(sqrtRatioAX96, sqrtRatioBX96, liquidity),
      amount1: 0n,
    };
  }
  if (sqrtPriceX96 < sqrtRatioBX96) {
    return {
      amount0: getAmount0ForLiquidityRoundingUp(sqrtPriceX96, sqrtRatioBX96, liquidity),
      amount1: getAmount1ForLiquidityRoundingUp(sqrtRatioAX96, sqrtPriceX96, liquidity),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1ForLiquidityRoundingUp(sqrtRatioAX96, sqrtRatioBX96, liquidity),
  };
}

function getAmount0ForLiquidityRoundingUp(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  return ceilDiv(ceilDiv(numerator1 * numerator2, sqrtRatioBX96), sqrtRatioAX96);
}

function getAmount1ForLiquidityRoundingUp(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return ceilDiv(liquidity * (sqrtRatioBX96 - sqrtRatioAX96), Q96);
}

/* -------------------------------------------------------------------------- */
/* Price <-> tick (PHASE3.6, Rev2 M11/M12/M13)                                */
/* -------------------------------------------------------------------------- */

/**
 * The HUMAN price at a tick: how many `token1` one whole `token0` buys.
 *
 * ```
 * humanPrice = 1.0001^tick * 10^(decimals0 - decimals1)
 * ```
 *
 * THE DECIMALS TERM IS NOT DECORATION (Rev2 M11). A pool's tick prices RAW
 * units; a human price prices WHOLE tokens. For an 18/18 pair the term is
 * `10^0` and vanishes — which is exactly why the FINDINGS (ao) pair
 * (USDT/WBNB, both 18) proves nothing about it, and why the golden vectors must
 * include an unequal pair. Nothing else in this repo reads `decimals()`, so a
 * caller that cannot supply the true values must refuse rather than assume.
 *
 * Derived from {@link getSqrtRatioAtTick}, so the price this reports is the
 * price the POOL will actually be at — never a second approximation of it. The
 * float is confined to the human-facing end: every comparison that decides
 * money stays on the integer tick.
 */
export function humanPriceAtTick(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  const sqrt = getSqrtRatioAtTick(tick);
  // (sqrt/2^96)^2, evaluated in floating point only after the exact integer
  // has been computed. 2^96 is exactly representable; the ratio is not, and
  // does not need to be — this number is for a human to read.
  const ratio = Number(sqrt) / 2 ** 96;
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/**
 * The inverse: the tick whose price brackets `humanPrice`, rounded in the
 * direction the caller states.
 *
 * `tickMath` had NO inverse before this phase, and the first draft of the spec
 * described one as if it existed (Rev2 M13). This is that function, and it is
 * built the cheap way ON PURPOSE: a float candidate, then an EXACT verification
 * walk over {@link getSqrtRatioAtTick}. The float only proposes; the integer
 * decides, so a rounding error in `Math.log` can cost one extra loop iteration
 * and can never return a tick whose real price is on the wrong side.
 *
 * `round` is the conservative direction (Rev2 M12), and the caller states it
 * rather than this function guessing:
 *
 *   - `"down"` for an `at-or-below` stop — the signed tick sits at or below the
 *     price asked for, so the stop can only fire at or beyond that level;
 *   - `"up"` for `at-or-above`, symmetrically.
 *
 * Never rounds toward the market. A stop that fires EARLY is a stop the owner
 * did not sign.
 */
export function tickAtHumanPrice(input: {
  readonly humanPrice: number;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly round: "down" | "up";
}): number {
  const { humanPrice, decimals0, decimals1, round } = input;
  if (!Number.isFinite(humanPrice) || humanPrice <= 0) {
    throw new Error("tickAtHumanPrice: humanPrice must be a positive finite number.");
  }
  if (!Number.isInteger(decimals0) || !Number.isInteger(decimals1)) {
    throw new Error("tickAtHumanPrice: decimals must be integers.");
  }
  // 1.0001^tick = humanPrice * 10^(decimals1 - decimals0)
  const raw = humanPrice * 10 ** (decimals1 - decimals0);
  const candidate = Math.log(raw) / Math.log(1.0001);
  if (!Number.isFinite(candidate)) {
    throw new Error("tickAtHumanPrice: price is outside the representable range.");
  }
  let tick = Math.max(MIN_TICK, Math.min(MAX_TICK, Math.floor(candidate)));

  // EXACT walk. `priceAt(t) <= humanPrice < priceAt(t + 1)` is the invariant we
  // want to land on; the float candidate is only a starting guess.
  const priceAt = (t: number): number => humanPriceAtTick(t, decimals0, decimals1);
  while (tick > MIN_TICK && priceAt(tick) > humanPrice) tick -= 1;
  while (tick < MAX_TICK && priceAt(tick + 1) <= humanPrice) tick += 1;

  const chosen =
    round === "down"
      ? tick
      : // "up": the smallest tick whose price is AT OR ABOVE the request.
        priceAt(tick) >= humanPrice
        ? tick
        : Math.min(MAX_TICK, tick + 1);

  // AUDIT A6: at the range bounds the walk cannot satisfy the request, and
  // returning the bound anyway would hand back a tick that violates this
  // function's own contract — a stop that fires on the wrong side, silently.
  // Refuse instead: a price outside a V3 pool's representable range is an
  // operator error, not a value to approximate.
  const price = priceAt(chosen);
  if (round === "down" ? price > humanPrice : price < humanPrice) {
    throw new Error(
      `tickAtHumanPrice: ${humanPrice} is outside the representable tick range ` +
        `(nearest tick ${chosen} prices ${price}); refusing rather than saturating.`,
    );
  }
  return chosen;
}

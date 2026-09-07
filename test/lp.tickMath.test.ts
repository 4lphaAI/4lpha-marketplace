/**
 * Golden vectors for the Phase 3 tick-math port (`src/lp/tickMath.ts`).
 *
 * The anchor pins are INDEPENDENT published Uniswap V3 constants:
 * `TickMath.MIN_SQRT_RATIO` (4295128739), `getSqrtRatioAtTick(MAX_TICK)`
 * (1461446703485210103287273052203988822378723970342), tick 0 = 2^96, and the
 * v3-sdk tick ±1 values. The wider pins are regression locks computed from
 * this implementation once and cross-checked here against float math
 * (`1.0001^(tick/2)`), which is an independent derivation of the same curve.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ceilDiv,
  computeSwapAmount,
  flooredAtOneWei,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getMintAmountsForLiquidity,
  getSqrtRatioAtTick,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  minLpOutFor,
  nearestUsableTick,
  Q96,
  swapSplitIsTotal,
} from "../src/lp/tickMath.js";

describe("getSqrtRatioAtTick golden vectors", () => {
  it("pins the published Uniswap V3 boundary constants", () => {
    assert.equal(getSqrtRatioAtTick(MIN_TICK), 4_295_128_739n);
    assert.equal(getSqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
    assert.equal(
      getSqrtRatioAtTick(MAX_TICK),
      1461446703485210103287273052203988822378723970342n,
    );
    assert.equal(getSqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
  });

  it("pins tick 0 to exactly 2^96", () => {
    assert.equal(getSqrtRatioAtTick(0), 79228162514264337593543950336n);
    assert.equal(getSqrtRatioAtTick(0), Q96);
  });

  it("pins the published v3-sdk tick +1 / -1 values", () => {
    assert.equal(getSqrtRatioAtTick(1), 79232123823359799118286999568n);
    assert.equal(getSqrtRatioAtTick(-1), 79224201403219477170569942574n);
  });

  it("pins regression vectors across the tick range", () => {
    const pins: readonly (readonly [number, bigint])[] = [
      [10, 79267784519130042428790663799n],
      [60, 79466191966197645195421774833n],
      [100, 79625275426524748796330556128n],
      [2_500, 89776708723587163891445672585n],
      [10_000, 130621891405341611593710811006n],
      [-10_000, 48055510970269007215549348797n],
      [50_000, 965075977353221155028623082916n],
      [-50_000, 6504256538020985011912221507n],
      [200_000, 1744244129640337381386292603617838n],
      [443_636, 340275971719517849884101479065584693834n],
      [-443_636, 18447090764788882728n],
      [887_271, 1461373636630004318706518188784493106690254656249n],
    ];
    for (const [tick, expected] of pins) {
      assert.equal(getSqrtRatioAtTick(tick), expected, `tick ${tick}`);
    }
  });

  it("cross-checks against the independent float derivation 1.0001^(tick/2)", () => {
    for (let tick = -800_000; tick <= 800_000; tick += 37_337) {
      const ratio = Number(getSqrtRatioAtTick(tick)) / Number(Q96);
      const expected = Math.pow(1.0001, tick / 2);
      const relErr = Math.abs(ratio - expected) / expected;
      assert.ok(relErr < 1e-9, `tick ${tick}: relative error ${relErr}`);
    }
  });

  it("is strictly monotonic in the tick", () => {
    let previous = getSqrtRatioAtTick(MIN_TICK);
    for (const tick of [-887_271, -100_000, -1, 0, 1, 100_000, 887_271, MAX_TICK]) {
      const current = getSqrtRatioAtTick(tick);
      assert.ok(current > previous, `tick ${tick} not > previous`);
      previous = current;
    }
  });

  it("throws outside [MIN_TICK, MAX_TICK] and on non-integers", () => {
    assert.throws(() => getSqrtRatioAtTick(MIN_TICK - 1), /out of range/u);
    assert.throws(() => getSqrtRatioAtTick(MAX_TICK + 1), /out of range/u);
    assert.throws(() => getSqrtRatioAtTick(0.5), /out of range/u);
    assert.throws(() => getSqrtRatioAtTick(Number.NaN), /out of range/u);
  });
});

describe("nearestUsableTick", () => {
  it("floors to the spacing across all four Pancake V3 spacings", () => {
    // Pancake fee tiers: 100 -> 1, 500 -> 10, 2500 -> 50, 10000 -> 200.
    assert.equal(nearestUsableTick(7, 1), 7);
    assert.equal(nearestUsableTick(-7, 1), -7);
    assert.equal(nearestUsableTick(7, 10), 0);
    assert.equal(nearestUsableTick(19, 10), 10);
    assert.equal(nearestUsableTick(-5, 10), -10); // floor, NOT round-to-nearest
    assert.equal(nearestUsableTick(157, 50), 150);
    assert.equal(nearestUsableTick(-157, 50), -200);
    assert.equal(nearestUsableTick(199, 200), 0);
    assert.equal(nearestUsableTick(-1, 200), -200);
    assert.equal(nearestUsableTick(887_269, 200), 887_200);
  });

  it("keeps the 0G clamp quirk: extremes return MIN/MAX_TICK even off-spacing", () => {
    assert.equal(nearestUsableTick(MIN_TICK, 10), MIN_TICK);
    assert.equal(nearestUsableTick(MAX_TICK, 10), 887_270);
  });

  it("rejects invalid spacing and non-integer ticks", () => {
    assert.throws(() => nearestUsableTick(0, 0), /positive integer/u);
    assert.throws(() => nearestUsableTick(0, -10), /positive integer/u);
    assert.throws(() => nearestUsableTick(1.5, 10), /integer/u);
  });
});

describe("computeSwapAmount (single-sided zap split)", () => {
  it("splits linearly in tick distance with ceil bias", () => {
    // Mid-range, symmetric: swap exactly half.
    assert.equal(computeSwapAmount(1_000n, 0, -100, 100, true), 500n);
    assert.equal(computeSwapAmount(1_000n, 0, -100, 100, false), 500n);
    // Odd amount: ceil biases the base side into being binding.
    assert.equal(computeSwapAmount(1_001n, 0, -100, 100, true), 501n);
  });

  it("returns 0 or the full amount outside the range", () => {
    assert.equal(computeSwapAmount(1_000n, -100, -100, 100, true), 0n);
    assert.equal(computeSwapAmount(1_000n, -150, -100, 100, true), 0n);
    assert.equal(computeSwapAmount(1_000n, 100, -100, 100, true), 1_000n);
    assert.equal(computeSwapAmount(1_000n, 150, -100, 100, true), 1_000n);
    // Mirrored for base = token1.
    assert.equal(computeSwapAmount(1_000n, 100, -100, 100, false), 0n);
    assert.equal(computeSwapAmount(1_000n, -100, -100, 100, false), 1_000n);
  });

  it("rejects an inverted range and negative amounts", () => {
    assert.throws(() => computeSwapAmount(1n, 0, 100, 100, true), /tickUpper/u);
    assert.throws(() => computeSwapAmount(-1n, 0, -100, 100, true), /nonnegative/u);
  });
});

/**
 * PHASE3.12 B3 (the F1 half). `swapSplitIsTotal` exists so the harvest gate
 * cannot drift from the arithmetic it protects; this suite pins the two
 * together tick by tick, so a change to `computeSwapAmount`'s early returns
 * that is not mirrored in the predicate fails HERE rather than on chain.
 */
describe("swapSplitIsTotal (the harvest range gate's predicate)", () => {
  const LOWER = -100;
  const UPPER = 100;

  /** True iff `computeSwapAmount` takes one of its two early returns. */
  function splitIsTotalByArithmetic(currentTick: number, baseIsToken0: boolean): boolean {
    const split = computeSwapAmount(1_000n, currentTick, LOWER, UPPER, baseIsToken0);
    return split === 0n || split === 1_000n;
  }

  it("is the STRICT INTERIOR: the lower bound is in range but not compoundable", () => {
    // The case the spec's proposed predicate (`rotationDeviationBps ===
    // undefined`) admitted. V3 range membership says in range; the split says
    // total in BOTH orderings, which is what actually wedges the harvest.
    assert.equal(computeSwapAmount(1_000n, LOWER, LOWER, UPPER, true), 0n);
    assert.equal(computeSwapAmount(1_000n, LOWER, LOWER, UPPER, false), 1_000n);
    assert.equal(swapSplitIsTotal(LOWER, LOWER, UPPER), true);

    // One tick in, the split is partial in both orderings.
    assert.equal(swapSplitIsTotal(LOWER + 1, LOWER, UPPER), false);
    assert.equal(splitIsTotalByArithmetic(LOWER + 1, true), false);
    assert.equal(splitIsTotalByArithmetic(LOWER + 1, false), false);

    // The upper bound is exclusive: the last interior tick is `tickUpper - 1`.
    assert.equal(swapSplitIsTotal(UPPER - 1, LOWER, UPPER), false);
    assert.equal(swapSplitIsTotal(UPPER, LOWER, UPPER), true);
    assert.equal(splitIsTotalByArithmetic(UPPER, true), true);
    assert.equal(splitIsTotalByArithmetic(UPPER, false), true);
  });

  it("agrees with computeSwapAmount's early returns at every tick, both orderings", () => {
    for (let tick = LOWER - 3; tick <= UPPER + 3; tick += 1) {
      const expected =
        splitIsTotalByArithmetic(tick, true) || splitIsTotalByArithmetic(tick, false);
      assert.equal(swapSplitIsTotal(tick, LOWER, UPPER), expected, `tick ${tick}`);
    }
  });

  it("is total on both sides well outside the range, and rejects an inverted one", () => {
    assert.equal(swapSplitIsTotal(LOWER - 5_000, LOWER, UPPER), true);
    assert.equal(swapSplitIsTotal(UPPER + 5_000, LOWER, UPPER), true);
    assert.throws(() => swapSplitIsTotal(0, UPPER, LOWER), /tickUpper/u);
    assert.throws(() => swapSplitIsTotal(0, LOWER, LOWER), /tickUpper/u);
  });
});

describe("minLpOutFor + the 1-wei floor", () => {
  it("ceils: the floor is never looser than the stated percentage", () => {
    assert.equal(minLpOutFor(1_000n, 9_500), 950n);
    assert.equal(minLpOutFor(1_001n, 9_500), 951n); // 950.95 ceils up
    assert.equal(minLpOutFor(9_999n, 9_500), 9_500n); // 9499.05 ceils up
    assert.equal(minLpOutFor(1n, 9_500), 1n); // 0.95 ceils to 1
    assert.equal(minLpOutFor(0n, 9_500), 0n); // the 1-wei floor is separate
    assert.equal(minLpOutFor(1_000n, 10_000), 1_000n);
    assert.equal(minLpOutFor(1_000n, 0), 0n);
  });

  it("flooredAtOneWei lifts only sub-1 values", () => {
    assert.equal(flooredAtOneWei(0n), 1n);
    assert.equal(flooredAtOneWei(-5n), 1n);
    assert.equal(flooredAtOneWei(1n), 1n);
    assert.equal(flooredAtOneWei(2n), 2n);
  });

  it("rejects out-of-range bps", () => {
    assert.throws(() => minLpOutFor(1n, -1), /0\.\.10000/u);
    assert.throws(() => minLpOutFor(1n, 10_001), /0\.\.10000/u);
    assert.throws(() => minLpOutFor(1n, 0.5), /0\.\.10000/u);
  });

  it("ceilDiv matches Solidity's (a + b - 1) / b", () => {
    assert.equal(ceilDiv(10n, 5n), 2n);
    assert.equal(ceilDiv(11n, 5n), 3n);
    assert.equal(ceilDiv(0n, 5n), 0n);
    assert.throws(() => ceilDiv(1n, 0n), /positive/u);
  });
});

describe("liquidity/amount round-trips", () => {
  const ONE = 10n ** 18n;

  it("in-range: burn (floor) <= mint (ceil), both within rounding of each other", () => {
    const sqrtPrice = getSqrtRatioAtTick(0);
    const liquidity = getLiquidityForAmounts(sqrtPrice, -600, 600, ONE, ONE);
    assert.ok(liquidity > 0n);
    const burn = getAmountsForLiquidity(sqrtPrice, -600, 600, liquidity);
    const mint = getMintAmountsForLiquidity(sqrtPrice, -600, 600, liquidity);
    assert.ok(burn.amount0 > 0n && burn.amount1 > 0n);
    assert.ok(mint.amount0 >= burn.amount0);
    assert.ok(mint.amount1 >= burn.amount1);
    assert.ok(mint.amount0 - burn.amount0 <= 2n, "amount0 rounding gap");
    assert.ok(mint.amount1 - burn.amount1 <= 2n, "amount1 rounding gap");
    // The mint never charges more than the amounts the liquidity came from
    // (plus the documented <=2 wei of ceil rounding).
    assert.ok(mint.amount0 <= ONE + 2n);
    assert.ok(mint.amount1 <= ONE + 2n);
  });

  it("below-range price is single-sided token0; above-range is token1", () => {
    const below = getSqrtRatioAtTick(-1_000);
    const above = getSqrtRatioAtTick(1_000);
    const liquidity = getLiquidityForAmounts(getSqrtRatioAtTick(0), -600, 600, ONE, ONE);

    const burnBelow = getAmountsForLiquidity(below, -600, 600, liquidity);
    assert.ok(burnBelow.amount0 > 0n);
    assert.equal(burnBelow.amount1, 0n);
    const mintBelow = getMintAmountsForLiquidity(below, -600, 600, liquidity);
    assert.ok(mintBelow.amount0 >= burnBelow.amount0);
    assert.equal(mintBelow.amount1, 0n);

    const burnAbove = getAmountsForLiquidity(above, -600, 600, liquidity);
    assert.equal(burnAbove.amount0, 0n);
    assert.ok(burnAbove.amount1 > 0n);
  });

  it("liquidity round-trips through amounts: ceil-charged amounts fund at least L, within ppm", () => {
    const sqrtPrice = getSqrtRatioAtTick(150);
    const liquidity = 123_456_789_012_345n;
    const mint = getMintAmountsForLiquidity(sqrtPrice, -600, 600, liquidity);
    const recovered = getLiquidityForAmounts(sqrtPrice, -600, 600, mint.amount0, mint.amount1);
    assert.ok(recovered >= liquidity, "ceil-charged amounts must fund at least L");
    // Each wei of ceil rounding on a token leg buys ~L/amount extra liquidity,
    // so the recovery overshoot is bounded by parts-per-billion, not wei.
    assert.ok(
      (recovered - liquidity) * 1_000_000_000n <= liquidity,
      `recovered ${recovered} vs ${liquidity}`,
    );
  });

  it("an asymmetric price picks the binding (smaller) liquidity side", () => {
    const sqrtPrice = getSqrtRatioAtTick(400); // near the top of [-600, 600)
    // Price near the upper bound: token0 deposits buy much more liquidity per
    // token than token1, so token1 is binding with equal amounts.
    const both = getLiquidityForAmounts(sqrtPrice, -600, 600, ONE, ONE);
    const onlyMore1 = getLiquidityForAmounts(sqrtPrice, -600, 600, ONE, ONE * 2n);
    assert.ok(onlyMore1 > both, "raising the binding side must raise liquidity");
  });
});

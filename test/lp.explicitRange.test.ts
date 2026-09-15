import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RANGE_WIDTH_TICKS,
  derivedRangeTicks,
  explicitRangeFromPrices,
  formatPrice,
  priceFromTick,
  rangeContainsTick,
  rangeWidthPct,
  tickFromPrice,
} from "../src/lp/explicitRange.js";

describe("explicitRangeFromPrices port", () => {
  const base = { wbnbIsToken0: true, currentTick: 0, tickSpacing: 10 };

  it("reproduces the web's snapped range in both pool orientations", () => {
    const normal = explicitRangeFromPrices({ ...base, minPrice: 0.9, maxPrice: 1.1 });
    const inverted = explicitRangeFromPrices({ ...base, wbnbIsToken0: false, minPrice: 0.9, maxPrice: 1.1 });
    assert.equal(rangeContainsTick(normal, 0), true);
    assert.equal(rangeContainsTick(inverted, 0), true);
    assert.equal(Math.abs(normal.tickLower % 10), 0);
    assert.equal(Math.abs(normal.tickUpper % 10), 0);
    assert.equal(inverted.tickLower < inverted.tickUpper, true);
  });

  it("refuses the web's straddle, width, bound, and inverted-price vectors", () => {
    assert.throws(
      () => explicitRangeFromPrices({ ...base, currentTick: 50_000, minPrice: 0.9, maxPrice: 1.1 }),
      /left the typed band/u,
    );
    assert.throws(
      () => explicitRangeFromPrices({ ...base, tickSpacing: 50, currentTick: 15, minPrice: priceFromTick(10, { wbnbIsToken0: true }), maxPrice: priceFromTick(20, { wbnbIsToken0: true }) }),
      /at least two tick spacings/u,
    );
    assert.throws(
      () => explicitRangeFromPrices({ ...base, tickSpacing: 50, currentTick: 887_100, minPrice: priceFromTick(887_000, { wbnbIsToken0: true }), maxPrice: priceFromTick(887_260, { wbnbIsToken0: true }) }),
      /tick bounds/u,
    );
    assert.throws(() => explicitRangeFromPrices({ ...base, minPrice: 2, maxPrice: 1 }), /maximum price must be above/u);
  });

  it("keeps derivedRangeTicks equal to the range that would be signed", () => {
    let successes = 0;
    for (const orientation of [{ quoteIsToken0: false }, { quoteIsToken0: true }]) {
      for (const [lo, hi, tick] of [[-1054, 953, 0], [10, 20, 15], [-74, 74, 0], [46_060, 47_070, 46_566]] as const) {
        const prices = [priceFromTick(lo, orientation), priceFromTick(hi, orientation)];
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const derived = derivedRangeTicks({ ...orientation, minPrice, maxPrice, tickSpacing: 50 });
        if (derived === null) continue;
        try {
          const signed = explicitRangeFromPrices({ ...orientation, minPrice, maxPrice, currentTick: tick, tickSpacing: 50 });
          assert.equal(signed.tickLower, derived.tickLower);
          assert.equal(signed.tickUpper, derived.tickUpper);
          successes += 1;
        } catch {
          // The narrow [10, 20] vector is intentionally refused at spacing 50.
        }
      }
    }
    assert.equal(successes, 6);
  });

  it("preserves the snap tolerance and quote orientation", () => {
    const orientation = { quoteIsToken0: false };
    const inside = derivedRangeTicks({ ...orientation, minPrice: priceFromTick(1_000 + 0.0009, orientation), maxPrice: priceFromTick(2_000, orientation), tickSpacing: 50 });
    const outside = derivedRangeTicks({ ...orientation, minPrice: priceFromTick(1_000 - 0.002, orientation), maxPrice: priceFromTick(2_000 + 0.002, orientation), tickSpacing: 50 });
    assert.deepEqual([inside?.tickLower, outside?.tickLower, outside?.tickUpper], [1_000, 950, 2_050]);
    const quote0 = explicitRangeFromPrices({ minPrice: priceFromTick(600, { quoteIsToken0: true }), maxPrice: priceFromTick(-600, { quoteIsToken0: true }), currentTick: 0, tickSpacing: 50, quoteIsToken0: true });
    assert.deepEqual([quote0.tickLower, quote0.tickUpper], [-600, 600]);
    assert.equal(tickFromPrice(priceFromTick(46_566, orientation), orientation), 46_566);
  });

  it("matches the web's price formatting and width arithmetic", () => {
    assert.equal(formatPrice(105.432198), "105.4322");
    assert.equal(formatPrice(0.00950091), "0.00950091");
    assert.equal(formatPrice(0), "—");
    assert.equal(rangeWidthPct(0, 1_000), (Math.pow(1.0001, 1_000) - 1) * 100);
    assert.equal(MAX_RANGE_WIDTH_TICKS, 200_000);
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_RANGE_WIDTH_TICKS,
  derivedRangeTicks,
  explicitRangeFromPrices,
  formatPrice,
  poolQuote,
  priceFromTick,
  rangeWidthPct,
  rangeContainsTick,
  snapTickDown,
  snapTickUp,
  tickFromPrice,
} from "./range";

describe("tick <-> price", () => {
  it("round-trips a price through the tick axis (WBNB as token0)", () => {
    const orientation = { wbnbIsToken0: true };
    const price = 612.5;
    const tick = tickFromPrice(price, orientation);
    expect(priceFromTick(tick, orientation)).toBeCloseTo(price, 6);
  });

  it("inverts the orientation when WBNB is token1", () => {
    const asToken0 = priceFromTick(1000, { wbnbIsToken0: true });
    const asToken1 = priceFromTick(1000, { wbnbIsToken0: false });
    expect(asToken1).toBeCloseTo(1 / asToken0, 12);
  });

  it("is decimals-aware", () => {
    expect(priceFromTick(0, { wbnbIsToken0: true, decimals0: 18, decimals1: 6 })).toBeCloseTo(
      1e12,
      0,
    );
  });

  it("refuses a non-positive price", () => {
    expect(() => tickFromPrice(0, { wbnbIsToken0: true })).toThrow(/positive/u);
  });
});

describe("snapping and containment", () => {
  it("snaps down and up to the spacing", () => {
    expect(snapTickDown(1234, 10)).toBe(1230);
    expect(snapTickUp(1234, 10)).toBe(1240);
    expect(snapTickDown(-1234, 10)).toBe(-1240);
    expect(snapTickUp(-1234, 10)).toBe(-1230);
  });

  it("refuses a non-positive spacing", () => {
    expect(() => snapTickDown(10, 0)).toThrow(/tick spacing/u);
  });

  it("contains the tick on the lower bound but not the upper", () => {
    const range = { tickLower: -100, tickUpper: 100 };
    expect(rangeContainsTick(range, -100)).toBe(true);
    expect(rangeContainsTick(range, 99)).toBe(true);
    expect(rangeContainsTick(range, 100)).toBe(false);
    expect(rangeContainsTick(range, -101)).toBe(false);
  });
});

describe("explicitRangeFromPrices", () => {
  const base = { wbnbIsToken0: true, currentTick: 0, tickSpacing: 10 };

  it("produces a spacing-snapped range that straddles the current tick", () => {
    const range = explicitRangeFromPrices({ ...base, minPrice: 0.9, maxPrice: 1.1 });
    expect(Number.isInteger(range.tickLower / 10)).toBe(true);
    expect(Number.isInteger(range.tickUpper / 10)).toBe(true);
    expect(rangeContainsTick(range, 0)).toBe(true);
    expect(range.widthTicks).toBe(range.tickUpper - range.tickLower);
  });

  it("orders the ticks when the orientation inverts", () => {
    const range = explicitRangeFromPrices({
      ...base,
      wbnbIsToken0: false,
      minPrice: 0.9,
      maxPrice: 1.1,
    });
    expect(range.tickLower).toBeLessThan(range.tickUpper);
    expect(rangeContainsTick(range, 0)).toBe(true);
  });

  // INVERTED (fix review, finding 1): the signing helper no longer widens or
  // clamps behind the owner's back — the labelled range IS the signed range,
  // and a pair too narrow for two spacings is refused with the same message the
  // form shows before the button is enabled.
  it("refuses a pair narrower than two spacings instead of silently widening it", () => {
    // Ticks 10 … 20 at spacing 50 snap outward to [0, 50): ONE spacing wide.
    // The old helper widened this to [0, 100) behind the owner's back.
    const orientation = { wbnbIsToken0: true };
    expect(() =>
      explicitRangeFromPrices({ ...base, tickSpacing: 50, currentTick: 15, minPrice: priceFromTick(10, orientation), maxPrice: priceFromTick(20, orientation) }),
    ).toThrow(/at least two tick spacings/u);
    // A pair straddling a multiple already spans two spacings after the outward snap and is accepted as-is.
    const wide = explicitRangeFromPrices({ ...base, tickSpacing: 200, minPrice: 0.999, maxPrice: 1.001 });
    expect(wide.tickLower).toBe(-200);
    expect(wide.tickUpper).toBe(200);
    expect(wide.widened).toBe(false);
  });

  it("refuses a pair that reaches past the pool's tick bounds instead of clamping it", () => {
    const orientation = { wbnbIsToken0: true };
    const nearTop = priceFromTick(887_000, orientation);
    const pastTop = priceFromTick(887_260, orientation);
    expect(() =>
      explicitRangeFromPrices({ ...base, tickSpacing: 50, currentTick: 887_100, minPrice: nearTop, maxPrice: pastTop }),
    ).toThrow(/tick bounds/u);
  });

  it("derivedRangeTicks equals the signed range whenever signing succeeds (both orientations)", () => {
    let successes = 0;
    for (const orientation of [{ quoteIsToken0: false }, { quoteIsToken0: true }]) {
      for (const [lo, hi, tick] of [[-1054, 953, 0], [10, 20, 15], [-74, 74, 0], [46_060, 47_070, 46_566]] as const) {
        const prices = [priceFromTick(lo, orientation), priceFromTick(hi, orientation)];
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const derived = derivedRangeTicks({ ...orientation, minPrice, maxPrice, tickSpacing: 50 })!;
        let signed: { tickLower: number; tickUpper: number } | null = null;
        try {
          signed = explicitRangeFromPrices({ ...orientation, minPrice, maxPrice, currentTick: tick, tickSpacing: 50 });
        } catch {
          signed = null;
        }
        if (signed !== null) {
          successes += 1;
          expect(signed.tickLower).toBe(derived.tickLower);
          expect(signed.tickUpper).toBe(derived.tickUpper);
        }
      }
    }
    // The matrix is not allowed to pass by refusing everything: three of the
    // four pairs straddle their tick in both orientations ([10,20] is too narrow).
    expect(successes).toBe(6);
  });

  it("the snap tolerance is 1e-3 tick: just inside snaps to the multiple, just outside snaps outward", () => {
    const orientation = { quoteIsToken0: false };
    const exact = priceFromTick(1_000, orientation);
    const inside = derivedRangeTicks({ ...orientation, minPrice: priceFromTick(1_000 + 0.0009, orientation), maxPrice: priceFromTick(2_000, orientation), tickSpacing: 50 })!;
    const outside = derivedRangeTicks({ ...orientation, minPrice: priceFromTick(1_000 + 0.002, orientation), maxPrice: priceFromTick(2_000, orientation), tickSpacing: 50 })!;
    expect(inside.tickLower).toBe(1_000);
    expect(outside.tickLower).toBe(1_000);
    const outsideBelow = derivedRangeTicks({ ...orientation, minPrice: priceFromTick(1_000 - 0.002, orientation), maxPrice: priceFromTick(2_000, orientation), tickSpacing: 50 })!;
    expect(outsideBelow.tickLower).toBe(950);
    expect(Math.abs(Number(formatPrice(exact)) - exact) / exact).toBeLessThan(1e-7);
    // The tolerance matters BELOW the lower multiple and ABOVE the upper one —
    // where plain floor/ceil would push the bound one spacing outward — in both
    // orientations.
    for (const o of [{ quoteIsToken0: false }, { quoteIsToken0: true }]) {
      const prices = (lower: number, upper: number) => {
        const a = priceFromTick(lower, o);
        const b = priceFromTick(upper, o);
        return { minPrice: Math.min(a, b), maxPrice: Math.max(a, b) };
      };
      const snappedIn = derivedRangeTicks({ ...o, ...prices(1_000 - 0.0009, 2_000 + 0.0009), tickSpacing: 50 })!;
      expect([snappedIn.tickLower, snappedIn.tickUpper]).toEqual([1_000, 2_000]);
      const snappedOut = derivedRangeTicks({ ...o, ...prices(1_000 - 0.002, 2_000 + 0.002), tickSpacing: 50 })!;
      expect([snappedOut.tickLower, snappedOut.tickUpper]).toEqual([950, 2_050]);
    }
  });

  it("refuses a range wider than the open's ceiling", () => {
    expect(() =>
      explicitRangeFromPrices({ ...base, minPrice: 1e-9, maxPrice: 1e9 }),
    ).toThrow(new RegExp(String(MAX_RANGE_WIDTH_TICKS), "u"));
  });

  it("refuses a range that does not straddle the current price — in PRICE space, before snapping", () => {
    expect(() =>
      explicitRangeFromPrices({ ...base, currentTick: 50_000, minPrice: 0.9, maxPrice: 1.1 }),
    ).toThrow(/left the typed band/u);
  });

  it("refuses when the live price left the typed band by less than one spacing (review finding 1)", () => {
    // maxPrice 1.1 ≈ tick 953.1 ⇒ snapped upper 1000 at spacing 50. Live tick 970
    // is inside the SNAPPED range but outside the TYPED band: refused.
    expect(() =>
      explicitRangeFromPrices({ ...base, currentTick: 970, tickSpacing: 50, minPrice: 0.9, maxPrice: 1.1 }),
    ).toThrow(/left the typed band/u);
    // Exactly at the band edge is still inside.
    const edge = priceFromTick(940, { wbnbIsToken0: true });
    expect(() =>
      explicitRangeFromPrices({ ...base, currentTick: 940, tickSpacing: 50, minPrice: 0.9, maxPrice: edge }),
    ).not.toThrow();
  });

  it("derivedRangeTicks snaps outward but treats a form-produced price as its exact tick", () => {
    const orientation = { quoteIsToken0: false };
    // A price the form derived from tick 46070 (eight significant digits) must
    // come back as 46070, not floor to 46060.
    const stepped = Number(formatPrice(priceFromTick(46_070, orientation)));
    const derived = derivedRangeTicks({ ...orientation, minPrice: stepped, maxPrice: priceFromTick(47_070, orientation), tickSpacing: 10 });
    expect(derived?.tickLower).toBe(46_070);
    expect(derived?.tickUpper).toBe(47_070);
    // A hand-typed price between multiples snaps OUTWARD on both sides.
    const loose = derivedRangeTicks({ ...orientation, minPrice: priceFromTick(-74, orientation), maxPrice: priceFromTick(74, orientation), tickSpacing: 50 });
    expect(loose?.tickLower).toBe(-100);
    expect(loose?.tickUpper).toBe(100);
    expect(derivedRangeTicks({ ...orientation, minPrice: 2, maxPrice: 1, tickSpacing: 50 })).toBeNull();
  });

  it("rangeWidthPct is the price ratio, not tickWidth / 100", () => {
    expect(rangeWidthPct(0, 1_000)).toBeCloseTo((Math.pow(1.0001, 1_000) - 1) * 100, 10);
    expect(rangeWidthPct(0, 10_000)).toBeGreaterThan(170); // ≈ 171.8 %, where the linear rule says 100 %
  });

  it("refuses an inverted price pair", () => {
    expect(() => explicitRangeFromPrices({ ...base, minPrice: 2, maxPrice: 1 })).toThrow(
      /maximum price must be above/u,
    );
  });
});

describe("pool quote orientation (numeraire rule)", () => {
  const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const USDT = "0x55d398326f99059ff775485246999027b3197955";
  const BTCB = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";

  it("quotes BTCB/WBNB in WBNB per BTCB — the pool's own reading, not BTCB per WBNB", () => {
    const quote = poolQuote({ token0: BTCB, token1: WBNB, token0Symbol: "BTCB", token1Symbol: "WBNB" });
    expect(quote.quoteIsToken0).toBe(false);
    expect(quote.quoteSymbol).toBe("WBNB");
    expect(quote.baseSymbol).toBe("BTCB");
    // Live 2026-09-05: tick 46566 ⇒ raw token1/token0 ≈ 105.25 WBNB per BTCB.
    const price = priceFromTick(46_566, { quoteIsToken0: quote.quoteIsToken0 });
    expect(price).toBeGreaterThan(100);
    expect(price).toBeLessThan(110);
    // The legacy "other leg per WBNB" reading of the same tick is the inverse.
    expect(priceFromTick(46_566, { wbnbIsToken0: false })).toBeCloseTo(1 / price, 12);
  });

  it("prefers a stablecoin leg as the quote even against WBNB", () => {
    const quote = poolQuote({ token0: USDT, token1: WBNB, token0Symbol: "USDT", token1Symbol: "WBNB" });
    expect(quote.quoteIsToken0).toBe(true);
    expect(quote.quoteSymbol).toBe("USDT");
    // USDT is token0, so USDT per WBNB is 1 / raw — a tick near −64000 reads ≈ 600.
    const price = priceFromTick(-64_000, { quoteIsToken0: true });
    expect(price).toBeGreaterThan(500);
    expect(price).toBeLessThan(700);
  });

  it("falls back to token1 as the quote when neither leg is a stablecoin or WBNB", () => {
    const quote = poolQuote({ token0: "0x" + "a".repeat(40), token1: "0x" + "b".repeat(40) });
    expect(quote.quoteIsToken0).toBe(false);
    expect(quote.quoteSymbol).toMatch(/^0xbbbb…bbbb$/u);
  });

  it("round-trips price → tick → price in both orientations", () => {
    for (const quoteIsToken0 of [true, false]) {
      for (const tick of [-64_000, -500, 0, 777, 46_566]) {
        const price = priceFromTick(tick, { quoteIsToken0 });
        expect(tickFromPrice(price, { quoteIsToken0 })).toBeCloseTo(tick, 6);
      }
    }
  });

  it("explicitRangeFromPrices accepts the quote orientation and orders the derived ticks", () => {
    // Quote is token0 ⇒ a HIGHER price is a LOWER tick; the helper still
    // returns tickLower < tickUpper around the current tick.
    const range = explicitRangeFromPrices({
      minPrice: priceFromTick(600, { quoteIsToken0: true }),
      maxPrice: priceFromTick(-600, { quoteIsToken0: true }),
      currentTick: 0,
      tickSpacing: 50,
      quoteIsToken0: true,
    });
    expect(range.tickLower).toBeLessThan(0);
    expect(range.tickUpper).toBeGreaterThan(0);
    expect(range.tickLower).toBe(-600);
    expect(range.tickUpper).toBe(600);
  });

  it("formats prices with eight significant digits and never scientific notation", () => {
    expect(formatPrice(105.432198)).toBe("105.4322");
    expect(formatPrice(0.00950091)).toBe("0.00950091");
    expect(formatPrice(600)).toBe("600");
    expect(formatPrice(0)).toBe("—");
    for (const value of [1e-13, 1e-9, 3e38, 1e21, 123456789012345]) {
      const text = formatPrice(value);
      expect(text).not.toMatch(/e/iu);
      expect(Number(text)).toBeGreaterThan(0);
      expect(Math.abs(Number(text) - value) / value).toBeLessThan(1e-7);
    }
  });
});

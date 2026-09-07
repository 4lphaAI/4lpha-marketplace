import { describe, expect, it } from "vitest";
import { pricePrecision } from "./MarketChart";

/**
 * The library's default price format is two decimals, which drew a four.meme
 * token quoted in WBNB (0.00003813) as a column of "0.00" — axis, crosshair and
 * both rung lines. The precision is therefore computed from the data.
 */
describe("pricePrecision", () => {
  it("keeps four significant digits of the smallest price on the chart", () => {
    expect(pricePrecision([0.00003813, 0.00004029])).toBe(8);
    expect((0.00003813).toFixed(8)).toBe("0.00003813");
  });

  it("leaves ordinary prices at two decimals", () => {
    expect(pricePrecision([645.12, 650.4])).toBe(2);
    expect(pricePrecision([1.0001])).toBe(3);
  });

  it("scales with the leading zeros", () => {
    expect(pricePrecision([0.5])).toBe(4);
    expect(pricePrecision([0.05])).toBe(5);
    expect(pricePrecision([0.000000001234])).toBe(12);
  });

  it("ignores zero, negative and non-finite entries, and falls back to 2", () => {
    expect(pricePrecision([0, -1, Number.NaN, 645])).toBe(2);
    expect(pricePrecision([])).toBe(2);
  });

  it("takes the SMALLEST value, because that is the one that would round to zero", () => {
    expect(pricePrecision([900, 0.00003813])).toBe(8);
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveGridFromPreset,
  formatWeiAsBnb,
  gridDeriveRanges,
  gridQuantizeUpToSpacing,
  parseBnbToWei,
} from "./geometry";

describe("gridQuantizeUpToSpacing", () => {
  it("rounds up to the next spacing multiple", () => {
    expect(gridQuantizeUpToSpacing(30, 10)).toEqual({ ticks: 30, clamped: false });
    expect(gridQuantizeUpToSpacing(31, 10)).toEqual({ ticks: 40, clamped: false });
    expect(gridQuantizeUpToSpacing(30.1, 10)).toEqual({ ticks: 40, clamped: false });
  });
  it("clamps below one spacing", () => {
    expect(gridQuantizeUpToSpacing(15, 50)).toEqual({ ticks: 50, clamped: true });
    expect(gridQuantizeUpToSpacing(3.75, 10)).toEqual({ ticks: 10, clamped: true });
  });
});

describe("gridDeriveRanges", () => {
  const base = { tickSpacing: 10, gapTicks: 30, widthTicks: 30 };
  it("wbnbIsToken0: buy above, sell below", () => {
    const { buyRange, sellRange } = gridDeriveRanges({ ...base, currentTick: -23015, wbnbIsToken0: true });
    // lowerAnchor = -23020, upperAnchor = -23010
    expect(buyRange).toEqual({ tickLower: -22980, tickUpper: -22950 });
    expect(sellRange).toEqual({ tickLower: -23080, tickUpper: -23050 });
  });
  it("!wbnbIsToken0: buy below, sell above", () => {
    const { buyRange, sellRange } = gridDeriveRanges({ ...base, currentTick: -23015, wbnbIsToken0: false });
    expect(buyRange).toEqual({ tickLower: -23080, tickUpper: -23050 });
    expect(sellRange).toEqual({ tickLower: -22980, tickUpper: -22950 });
  });
  it("strict upper anchor when the tick sits ON a spacing multiple", () => {
    const { buyRange } = gridDeriveRanges({
      tickSpacing: 10,
      gapTicks: 0,
      widthTicks: 10,
      currentTick: -23020,
      wbnbIsToken0: true,
    });
    // upperAnchor must be strictly above the tick: -23010, not -23020.
    expect(buyRange).toEqual({ tickLower: -23010, tickUpper: -23000 });
  });
  it("refuses non-multiple gap/width", () => {
    expect(() =>
      gridDeriveRanges({ tickSpacing: 10, gapTicks: 5, widthTicks: 10, currentTick: 0, wbnbIsToken0: true }),
    ).toThrow();
  });
});

describe("deriveGridFromPreset", () => {
  it("standard preset on a 0.01% pool (spacing 1) keeps 30/30", () => {
    const derived = deriveGridFromPreset({
      presetId: "standard",
      spreadFactor: 1,
      currentTick: -23015,
      tickSpacing: 1,
      wbnbIsToken0: true,
    });
    expect(derived.gapTicks).toBe(30);
    expect(derived.widthTicks).toBe(30);
    expect(derived.gapClamped).toBe(false);
  });
  it("tight preset on a 0.25% pool (spacing 50) clamps both to 50", () => {
    const derived = deriveGridFromPreset({
      presetId: "tight",
      spreadFactor: 1,
      currentTick: 100,
      tickSpacing: 50,
      wbnbIsToken0: true,
    });
    expect(derived.gapTicks).toBe(50);
    expect(derived.widthTicks).toBe(50);
    expect(derived.gapClamped).toBe(true);
    expect(derived.widthClamped).toBe(true);
  });
  it("refuses an out-of-bounds spread factor", () => {
    expect(() =>
      deriveGridFromPreset({
        presetId: "standard",
        spreadFactor: 4,
        currentTick: 0,
        tickSpacing: 10,
        wbnbIsToken0: true,
      }),
    ).toThrow();
  });
});

describe("parseBnbToWei", () => {
  it("parses without float math", () => {
    expect(parseBnbToWei("0.02")).toBe(20000000000000000n);
    expect(parseBnbToWei("1")).toBe(1000000000000000000n);
    expect(parseBnbToWei("0.000000000000000001")).toBe(1n);
  });
  it("round-trips through formatWeiAsBnb", () => {
    expect(formatWeiAsBnb(20000000000000000n)).toBe("0.02");
    expect(formatWeiAsBnb(1000000000000000000n)).toBe("1");
  });
  it("refuses junk", () => {
    expect(() => parseBnbToWei("1e18")).toThrow();
    expect(() => parseBnbToWei("-1")).toThrow();
    expect(() => parseBnbToWei("0.0000000000000000001")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  GRID_PRESETS,
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
  it("deriveGridFromPreset: width is exactly one tick spacing for every preset, spacing and spread factor", () => {
    for (const presetId of ["tight", "standard", "wide", "very-wide"] as const) {
      for (const tickSpacing of [1, 10, 50, 200]) {
        for (const spreadFactor of [0.25, 1, 3]) {
          const derived = deriveGridFromPreset({
            presetId,
            spreadFactor,
            currentTick: -23015,
            tickSpacing,
            wbnbIsToken0: true,
          });
          expect(derived.widthTicks).toBe(tickSpacing);
          expect(derived.gapTicks).toBe(
            gridQuantizeUpToSpacing(
              GRID_PRESETS[presetId].gapBps * spreadFactor,
              tickSpacing,
            ).ticks,
          );
          expect("widthClamped" in derived).toBe(false);
        }
      }
    }
  });
  it("mid-to-mid distance of a preset pair is 2g + 2s on every pool", () => {
    const expected: Record<string, readonly number[]> = {
      tight: [32, 60, 200, 800],
      standard: [62, 80, 200, 800],
      wide: [152, 180, 300, 800],
      "very-wide": [302, 320, 400, 800],
    };
    const presets = { tight: 15, standard: 30, wide: 75, "very-wide": 150 } as const;
    for (const presetId of Object.keys(presets) as Array<keyof typeof presets>) {
      for (const [index, tickSpacing] of [1, 10, 50, 200].entries()) {
        for (const tick of [0, 1, tickSpacing - 1, -1, -tickSpacing]) {
          const derived = deriveGridFromPreset({
            presetId,
            spreadFactor: 1,
            currentTick: tick,
            tickSpacing,
            wbnbIsToken0: index % 2 === 0,
          });
          const buyMid = Math.floor((derived.buyRange.tickLower + derived.buyRange.tickUpper) / 2);
          const sellMid = Math.floor((derived.sellRange.tickLower + derived.sellRange.tickUpper) / 2);
          expect(Math.abs(sellMid - buyMid)).toBe(expected[presetId]![index]);
        }
      }
    }
  });
  it("GRID_PRESETS carries no bps width", () => {
    expect(Object.keys(GRID_PRESETS.tight)).toEqual(["gapBps", "label"]);
    expect(Object.keys(GRID_PRESETS.standard)).toEqual(["gapBps", "label"]);
    expect(Object.keys(GRID_PRESETS.wide)).toEqual(["gapBps", "label"]);
    expect(Object.keys(GRID_PRESETS["very-wide"])).toEqual(["gapBps", "label"]);
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

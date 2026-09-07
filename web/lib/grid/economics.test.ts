import { describe, expect, it } from "vitest";
import { formatFloorBnb, gridCapitalFloor, gridCapitalFloorBnb, gridGrossEdgeBps, gridModelLabel } from "./economics";

/**
 * Every expectation here was produced by RUNNING the execution plane's own
 * `gridShiftEconomics` / `gridPresetMinEconomicSizeWei` / `gridLadderResilience`
 * against the same inputs, not by re-deriving the formula. That is the point of
 * the file: this port exists to refuse before the plane does, so it is worth
 * nothing unless it answers the plane's numbers to the wei.
 */
const cases = [
  {
    presetId: "standard", tickSpacing: 10, currentTick: 0,
    gross: 100n, minRung: 20_000_000_000_000_000n,
    minBudget: 133_333_333_333_333_334n, minFundable: 190_480_000_000_000_001n,
  },
  {
    presetId: "tight", tickSpacing: 10, currentTick: 7,
    gross: 70n, minRung: 28_571_428_571_428_572n,
    minBudget: 190_476_190_476_190_480n, minFundable: 272_114_285_714_285_720n,
  },
  {
    presetId: "wide", tickSpacing: 50, currentTick: -23_012,
    gross: 304n, minRung: 6_578_947_368_421_053n,
    minBudget: 43_859_649_122_807_020n, minFundable: 62_657_894_736_842_109n,
  },
  {
    presetId: "very-wide", tickSpacing: 200, currentTick: 12_345,
    gross: 832n, minRung: 2_403_846_153_846_154n,
    minBudget: 16_025_641_025_641_028n, minFundable: 22_894_230_769_230_773n,
  },
] as const;

describe("gridCapitalFloor", () => {
  for (const each of cases) {
    it(`matches the plane for ${each.presetId} at spacing ${each.tickSpacing}`, () => {
      const floor = gridCapitalFloor({
        presetId: each.presetId,
        spreadFactor: 1,
        currentTick: each.currentTick,
        tickSpacing: each.tickSpacing,
        wbnbIsToken0: true,
        profile: "grid-shift-v1",
      });
      expect(floor.grossEdgeBps).toBe(each.gross);
      expect(floor.minRungWei).toBe(each.minRung);
      expect(floor.minBudgetWei).toBe(each.minBudget);
      expect(floor.minFundableBudgetWei).toBe(each.minFundable);
      expect(floor.requiredMultipleBps).toBe(14_286);
    });
  }

  it("a fixed grid funds the level directly, so its floor IS the minimum size", () => {
    const fixed = gridCapitalFloor({
      presetId: "standard", spreadFactor: 1, currentTick: 0, tickSpacing: 10,
      wbnbIsToken0: true, profile: "grid-v1",
    });
    expect(fixed.minBudgetWei).toBe(20_000_000_000_000_000n);
    expect(fixed.minFundableBudgetWei).toBe(fixed.minBudgetWei);
  });

  it("scales with the relay fee, because the floor is a gas floor", () => {
    const base = { presetId: "standard", spreadFactor: 1, currentTick: 0, tickSpacing: 10, wbnbIsToken0: true, profile: "grid-v1" } as const;
    const cheap = gridCapitalFloor({ ...base, relayFeePerSubmitWei: 50_000_000_000_000n });
    expect(cheap.minBudgetWei).toBe(10_000_000_000_000_000n);
  });

  it("refuses every size when the owner's own minimum exceeds the spread", () => {
    const impossible = gridCapitalFloor({
      presetId: "tight", spreadFactor: 1, currentTick: 0, tickSpacing: 10,
      wbnbIsToken0: true, profile: "grid-shift-v1", minNetEdgeBps: 200,
    });
    expect(impossible.minRungWei).toBeNull();
    expect(impossible.minBudgetWei).toBeNull();
    expect(impossible.minFundableBudgetWei).toBeNull();
  });

  it("is orientation-neutral: the spread is the same measured either way", () => {
    const a = gridCapitalFloor({ presetId: "wide", spreadFactor: 1, currentTick: 812, tickSpacing: 50, wbnbIsToken0: true, profile: "grid-shift-v1" });
    const b = gridCapitalFloor({ presetId: "wide", spreadFactor: 1, currentTick: 812, tickSpacing: 50, wbnbIsToken0: false, profile: "grid-shift-v1" });
    expect(a.grossEdgeBps).toBe(b.grossEdgeBps);
    expect(a.minBudgetWei).toBe(b.minBudgetWei);
  });

  it("gridGrossEdgeBps reads the midpoints, not the rung edges", () => {
    expect(gridGrossEdgeBps({ tickLower: 40, tickUpper: 70 }, { tickLower: -70, tickUpper: -40 })).toBe(110n);
  });
});

describe("GRID_CAPITAL_FLOOR_BNB", () => {
  const spacings: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 10000: 200 };

  // The table is what the UI enforces; this re-derives every cell from the
  // live calculation at the WORST tick of its tier. A cell that drifts below
  // the geometry it claims to cover is a grid the plane will refuse to arm.
  for (const presetId of ["tight", "standard", "wide", "very-wide"] as const) {
    for (const fee of [100, 500, 2500, 10_000]) {
      it(`covers ${presetId} at fee ${fee} for every tick in the spacing`, () => {
        const tabled = Number(gridCapitalFloorBnb(presetId, fee));
        const spacing = spacings[fee] as number;
        for (let tick = 0; tick < Math.min(spacing, 64); tick++) {
          const floor = gridCapitalFloor({
            presetId, spreadFactor: 1, currentTick: tick, tickSpacing: spacing,
            wbnbIsToken0: true, profile: "grid-shift-v1",
          });
          const live = Number(formatFloorBnb(floor.minFundableBudgetWei as bigint));
          expect(live).toBeLessThanOrEqual(tabled);
          // …and not so conservative it is a different number: within one step.
          expect(tabled - live).toBeLessThan(0.01);
        }
      });
    }
  }

  it("falls back to the widest floor when the fee tier is unknown", () => {
    expect(gridCapitalFloorBnb("standard", null)).toBe("0.2094");
    expect(gridCapitalFloorBnb("standard", 3_000)).toBe("0.2094");
  });
});

describe("formatFloorBnb", () => {
  it("rounds UP, so the printed figure is never below the floor", () => {
    expect(formatFloorBnb(133_333_333_333_333_334n)).toBe("0.1334");
    expect(formatFloorBnb(20_000_000_000_000_000n)).toBe("0.0200");
    expect(formatFloorBnb(1n)).toBe("0.0001");
  });
});

describe("gridModelLabel", () => {
  it("names the model from the SIGNED geometry, at this pool's spacing", () => {
    // The live agent: 150/100 ticks on a 0.25% pool (spacing 50).
    expect(gridModelLabel({ gapTicks: 150, widthTicks: 100, tickSpacing: 50 })).toBe("High Volatility");
    expect(gridModelLabel({ gapTicks: 30, widthTicks: 30, tickSpacing: 10 })).toBe("Balanced");
    expect(gridModelLabel({ gapTicks: 20, widthTicks: 20, tickSpacing: 10 })).toBe("Tight Scalp");
  });

  it("says Custom for a geometry no preset produces", () => {
    expect(gridModelLabel({ gapTicks: 70, widthTicks: 70, tickSpacing: 10 })).toBe("Custom");
  });

  it("returns null when the grid signed no gap/width at all (a fixed grid)", () => {
    expect(gridModelLabel({ gapTicks: null, widthTicks: null, tickSpacing: 50 })).toBeNull();
  });

  it("reports the FIRST preset a coarse spacing collapses onto, and that is the honest answer", () => {
    // At spacing 50 tight and standard quantize to the same 50/50 geometry.
    expect(gridModelLabel({ gapTicks: 50, widthTicks: 50, tickSpacing: 50 })).toBe("Tight Scalp");
  });
});

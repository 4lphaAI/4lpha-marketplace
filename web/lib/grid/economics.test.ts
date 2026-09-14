import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY_FEE_PER_SUBMIT_WEI, formatFloorBnb, GRID_CAPITAL_FLOOR_BNB, gridCapitalFloor, gridCapitalFloorBnb, gridCapitalFloorBnbAtFee, gridGrossEdgeBps, gridModelLabel } from "./economics";

/**
 * Every expectation here was produced by RUNNING the execution plane's own
 * `gridShiftEconomics` / `gridPresetMinEconomicSizeWei` / `gridLadderResilience`
 * against the same inputs, not by re-deriving the formula. That is the point of
 * the file: this port exists to refuse before the plane does, so it is worth
 * nothing unless it answers the plane's numbers to the wei.
 * Regeneration inputs: `gridShiftEconomics({ budgetWei: 0n,
 * relayFeePerSubmitWei: 100_000_000_000_000n })` with `minNetEdgeBps: 0`,
 * `deployPctBps: 3000`, `spreadFactor: 1`, width equal to tick spacing, and
 * the maximum fundable floor over ticks `0..tickSpacing-1` for each fee tier;
 * the resulting wei was rounded UP to four BNB decimals.
 */
const cases = [
  {
    presetId: "standard", tickSpacing: 10, currentTick: 0,
    gross: 80n, minRung: 25_000_000_000_000_000n,
    minBudget: 166_666_666_666_666_668n, minFundable: 238_100_000_000_000_002n,
  },
  {
    presetId: "tight", tickSpacing: 10, currentTick: 7,
    gross: 60n, minRung: 33_333_333_333_333_334n,
    minBudget: 222_222_222_222_222_228n, minFundable: 317_466_666_666_666_675n,
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
    expect(fixed.minBudgetWei).toBe(25_000_000_000_000_000n);
    expect(fixed.minFundableBudgetWei).toBe(fixed.minBudgetWei);
  });

  it("scales with the relay fee, because the floor is a gas floor", () => {
    const base = { presetId: "standard", spreadFactor: 1, currentTick: 0, tickSpacing: 10, wbnbIsToken0: true, profile: "grid-v1" } as const;
    const cheap = gridCapitalFloor({ ...base, relayFeePerSubmitWei: 50_000_000_000_000n });
    expect(cheap.minBudgetWei).toBe(12_500_000_000_000_000n);
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
  const oldTable: Record<string, Record<number, string>> = {
    tight: { 100: "0.4141", 500: "0.2722", 2500: "0.0943", 10000: "0.0229" },
    standard: { 100: "0.2094", 500: "0.1905", 2500: "0.0943", 10000: "0.0229" },
    wide: { 100: "0.0939", 500: "0.0859", 2500: "0.0627", 10000: "0.0229" },
    "very-wide": { 100: "0.0466", 500: "0.0456", 2500: "0.0415", 10000: "0.0229" },
  };

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
    expect(gridCapitalFloorBnb("standard", null)).toBe("0.3073");
    expect(gridCapitalFloorBnb("standard", 3_000)).toBe("0.3073");
  });

  it("the floor table: spacing-50 Tight/Balanced/Wide and every spacing-200 cell are unchanged; every other cell moved in the direction the gross edge moved", () => {
    for (const presetId of ["tight", "standard", "wide", "very-wide"] as const) {
      for (const fee of [100, 500, 2500, 10_000]) {
        const next = gridCapitalFloorBnb(presetId, fee);
        if ((fee === 2_500 && presetId !== "very-wide") || fee === 10_000) {
          expect(next).toBe(oldTable[presetId]![fee]);
        } else {
          expect(Number(next)).toBeGreaterThan(Number(oldTable[presetId]![fee]));
        }
      }
    }
    expect(Number(gridCapitalFloorBnb("very-wide", 2_500))).toBeGreaterThan(Number(oldTable["very-wide"]![2_500]));
  });
});

describe("gridCapitalFloorBnbAtFee", () => {
  const presets = ["tight", "standard", "wide", "very-wide"] as const;
  const fees = [100, 500, 2_500, 10_000] as const;
  const expected = {
    tight: ["0.2239", "0.1880"],
    standard: ["0.1156", "0.0971"],
    wide: ["0.0469", "0.0394"],
    "very-wide": ["0.0235", "0.0197"],
  } as const;

  it("is equivalent to every static table cell at the padded fee and default utilization", () => {
    for (const presetId of presets) for (const fee of fees) {
      expect(gridCapitalFloorBnbAtFee({ presetId, fee, relayFeePerSubmitWei: DEFAULT_RELAY_FEE_PER_SUBMIT_WEI, deployPctBps: 3_000 }))
        .toBe(GRID_CAPITAL_FLOOR_BNB[presetId][fee]);
    }
  });

  it("pins the eight live-fee floors", () => {
    for (const presetId of presets) {
      expect(gridCapitalFloorBnbAtFee({ presetId, fee: 100, relayFeePerSubmitWei: 37_600_000_000_000n, deployPctBps: 3_000 })).toBe(expected[presetId][0]);
      expect(gridCapitalFloorBnbAtFee({ presetId, fee: 100, relayFeePerSubmitWei: 37_600_000_000_000n, deployPctBps: 5_000 })).toBe(expected[presetId][1]);
      expect(Number(expected[presetId][1]) / Number(expected[presetId][0])).toBeGreaterThanOrEqual(0.80);
      expect(Number(expected[presetId][1]) / Number(expected[presetId][0])).toBeLessThanOrEqual(0.90);
    }
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
    expect(gridModelLabel({ gapTicks: 150, tickSpacing: 50 })).toBe("High Volatility");
    expect(gridModelLabel({ gapTicks: 30, tickSpacing: 10 })).toBe("Balanced");
    expect(gridModelLabel({ gapTicks: 20, tickSpacing: 10 })).toBe("Tight Scalp");
  });

  it("says Custom for a geometry no preset produces", () => {
    expect(gridModelLabel({ gapTicks: 70, tickSpacing: 10 })).toBe("Custom");
  });

  it("returns null when the grid signed no gap/width at all (a fixed grid)", () => {
    expect(gridModelLabel({ gapTicks: null, tickSpacing: 50 })).toBeNull();
  });

  it("reports the FIRST preset a coarse spacing collapses onto, and that is the honest answer", () => {
    // At spacing 50 tight and standard quantize to the same 50/50 geometry.
    expect(gridModelLabel({ gapTicks: 50, tickSpacing: 50 })).toBe("Tight Scalp");
  });

  it("a pre-ruling grid keeps its model name: gap 75 at spacing 1 is Wide Band whatever width it signed", () => {
    expect(gridModelLabel({ gapTicks: 75, tickSpacing: 1 })).toBe("Wide Band");
  });

  it("gap 70 at spacing 10 is Custom", () => {
    expect(gridModelLabel({ gapTicks: 70, tickSpacing: 10 })).toBe("Custom");
  });
});

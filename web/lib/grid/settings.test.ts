import { describe, expect, it } from "vitest";
import { buildFixedGridSettings, buildShiftGridSettings, GRID_SHIFT_SHIFTS_PER_DAY } from "./settings";

/**
 * The first live grid agent re-anchored SEVEN times in fifty minutes and filled
 * nothing: every motion was `shift_cause: "drift"` — a re-anchor caused by the
 * price walking, which earns nothing and spends gas. PHASE3.25 separates that
 * lane from `cause: "cross"`, the re-anchor a FILL causes, which is the flip an
 * owner is actually paying for. These tests pin that the UI signs the cross
 * lane and disables the drift one.
 */
const base = {
  pool: { token0: "0x5c85d6c6825ab4032337f11ee92a72df936b46f6", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", fee: 2500 },
  wbnbIsToken0: false,
  tickSpacing: 50,
  buyRange: { tickLower: -101_750, tickUpper: -101_650 },
  sellRange: { tickLower: -101_300, tickUpper: -101_200 },
  stopLossPct: 0,
  takeProfitPct: 0,
  gapTicks: 150,
  widthTicks: 100,
} as const;

function shiftBlock(settings: Record<string, unknown>): Record<string, unknown> {
  const grid = settings["grid"] as Record<string, unknown>;
  return grid["shift"] as Record<string, unknown>;
}

describe("buildShiftGridSettings", () => {
  it("disables drift, so the grid moves only when a rung is FILLED", () => {
    const shift = shiftBlock(buildShiftGridSettings({ ...base }));
    // 0 is the plane's own "drift disabled" (triggers.ts: "must be 0 (drift
    // disabled) or an integer in 25..200").
    expect(shift["driftPctOfGap"]).toBe(0);
  });

  it("omits the drift gas pair rather than signing a budget nothing can spend", () => {
    const shift = shiftBlock(buildShiftGridSettings({ ...base }));
    // The validator requires them signed TOGETHER or not at all.
    expect(shift).not.toHaveProperty("driftGasBudgetWei");
    expect(shift).not.toHaveProperty("driftPerMotionWei");
  });

  it("arms without a relay fee, because only the drift lane priced one", () => {
    expect(() => buildShiftGridSettings({ ...base })).not.toThrow();
  });

  it("gives the whole hire-profile allowance to fills", () => {
    // grid-shift-v1 permits 16 motions a day; with drift off all 16 are crosses.
    expect(GRID_SHIFT_SHIFTS_PER_DAY).toBe(16);
    expect(shiftBlock(buildShiftGridSettings({ ...base }))["shiftsPerDay"]).toBe(16);
  });

  it("still signs the drift lane when it is explicitly asked for, with its gas pair", () => {
    const shift = shiftBlock(buildShiftGridSettings({ ...base, driftPctOfGap: 60, relayFeePerSubmitWei: "100000000000000" }));
    expect(shift["driftPctOfGap"]).toBe(60);
    expect(shift["driftPerMotionWei"]).toBe("200000000000000");
    expect(shift["driftGasBudgetWei"]).toBe("1600000000000000");
  });

  it("refuses a drift lane with no relay fee to price it", () => {
    expect(() => buildShiftGridSettings({ ...base, driftPctOfGap: 60 })).toThrow(/relayFeePerSubmitWei/u);
  });

  it("keeps the rest of the signed envelope where the plane expects it", () => {
    const settings = buildShiftGridSettings({ ...base });
    const grid = settings["grid"] as Record<string, unknown>;
    expect(grid["mode"]).toBe("shift");
    // A shift never creates a flip sequence; 1 is the arm lane itself.
    expect(grid["maxFlipsPerDay"]).toBe(1);
    expect(settings["minMinutesBetweenExits"]).toBe(5);
    expect(shiftBlock(settings)["deployPctBps"]).toBe(3_000);
  });

  it("leaves the fixed-grid builder untouched", () => {
    const fixed = buildFixedGridSettings(base) as Record<string, unknown>;
    expect(fixed["grid"]).not.toHaveProperty("mode");
    expect((fixed["grid"] as Record<string, unknown>)["maxFlipsPerDay"]).toBe(12);
  });
});

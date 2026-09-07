/**
 * The arithmetic that decides how much money a passkey close asks for. Pinned
 * against a REAL position: NFT 7316794 (agent `grid-agent-01-2`, mubarak/WBNB,
 * fee 2500, ticks -101550..-101450), which held 198529011719679442645 of
 * liquidity while the plane reported its row closed on 2026-09-03.
 */
import { describe, expect, it } from "vitest";
import { getSqrtRatioAtTick } from "@/lib/exec/pairs";
import { closeMinimums, CLOSE_SLIPPAGE_BPS, positionAmounts } from "./nfpm";

const LIQUIDITY = 198_529_011_719_679_442_645n;
const TICK_LOWER = -101_550;
const TICK_UPPER = -101_450;
const position = { liquidity: LIQUIDITY, tickLower: TICK_LOWER, tickUpper: TICK_UPPER };

describe("what a full withdrawal returns", () => {
  it("is entirely the quote leg above the range — the live BID rung", () => {
    // 0.006206 WBNB. The agent page displayed 0.006221 for the same rung at a
    // slightly later block, and an independent implementation of the tick math
    // agrees to within 1e-12 relative, so this golden is cross-checked twice.
    const amounts = positionAmounts({ ...position, sqrtPriceX96: getSqrtRatioAtTick(-101_000) });
    expect(amounts.amount0).toBe(0n);
    expect(amounts.amount1).toBe(6_206_380_857_428_265n);
  });

  it("is entirely the base leg below the range", () => {
    const amounts = positionAmounts({ ...position, sqrtPriceX96: getSqrtRatioAtTick(-102_000) });
    expect(amounts.amount0).toBe(158_747_547_402_394_316_074n);
    expect(amounts.amount1).toBe(0n);
  });

  it("holds both legs inside the range, and the split follows the price", () => {
    const low = positionAmounts({ ...position, sqrtPriceX96: getSqrtRatioAtTick(TICK_LOWER + 20) });
    const high = positionAmounts({ ...position, sqrtPriceX96: getSqrtRatioAtTick(TICK_UPPER - 20) });
    for (const amounts of [low, high]) {
      expect(amounts.amount0).toBeGreaterThan(0n);
      expect(amounts.amount1).toBeGreaterThan(0n);
    }
    // Nearer the upper edge the position has sold more of the base leg for quote.
    expect(high.amount1).toBeGreaterThan(low.amount1);
    expect(high.amount0).toBeLessThan(low.amount0);
  });

  it("answers zero for an emptied position rather than dividing by its price", () => {
    expect(positionAmounts({ ...position, liquidity: 0n, sqrtPriceX96: getSqrtRatioAtTick(-101_000) }))
      .toEqual({ amount0: 0n, amount1: 0n });
    // An inverted or degenerate range is data, not an exception.
    expect(positionAmounts({ liquidity: LIQUIDITY, tickLower: 10, tickUpper: 10, sqrtPriceX96: getSqrtRatioAtTick(0) }))
      .toEqual({ amount0: 0n, amount1: 0n });
  });
});

describe("the floors submitted with the close", () => {
  it("give up exactly the sagas' own slippage bound and never nothing", () => {
    expect(CLOSE_SLIPPAGE_BPS).toBe(100n);
    const amounts = { amount0: 1_000_000n, amount1: 2_000_000n };
    expect(closeMinimums(amounts)).toEqual({ amount0: 990_000n, amount1: 1_980_000n });
    // A zero floor would let a manipulated pool settle the whole position at the
    // worst point of its own range, so a live leg must never floor at zero.
    const live = closeMinimums(positionAmounts({ ...position, sqrtPriceX96: getSqrtRatioAtTick(-101_000) }));
    expect(live.amount1).toBeGreaterThan(0n);
  });
});

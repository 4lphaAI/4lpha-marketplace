/**
 * DEMO MODE — the grid engine over a scripted tick series.
 *
 * THE DUAL-ORIENTATION OBLIGATION APPLIES HERE TOO. `wbnbIsToken0` decides
 * which asset a rung holds, so the ping-pong is driven in BOTH pool orderings:
 * a Case-A pool (WBNB = token1, buy level BELOW) and a Case-B pool
 * (WBNB = token0, buy level ABOVE). A grid model written in "up"/"down" terms
 * passes one of these and inverts on the other — the drift class PHASE3.13 F7
 * and 3.15 H1 are both about.
 *
 * OFFLINE, pure: no store, no chain, no clock, no server.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  DemoGridArmError,
  demoConvertAtTick,
  demoGridArm,
  demoGridStep,
  demoPoolOrder,
  demoQuoteBase,
  type DemoGridFill,
  type DemoGridState,
} from "../src/demo/gridEngine.js";
import type { LpGridSettings } from "../src/lp/triggers.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN_LO = getAddress("0x0000000000000000000000000000000000000011");
const TOKEN_HI = getAddress("0xffffffffffffffffffffffffffffffffffffff11");

/** Case A — WBNB is token1, so the buy (quote-holding) level sits BELOW. */
function caseA(): LpGridSettings {
  return {
    pool: { token0: TOKEN_LO, token1: WBNB, fee: 2_500 },
    wbnbIsToken0: false,
    tickSpacing: 50,
    buyRange: { tickLower: -1_000, tickUpper: -500 },
    sellRange: { tickLower: 500, tickUpper: 1_000 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
  };
}

/** Case B — WBNB is token0, so the buy level sits ABOVE. */
function caseB(): LpGridSettings {
  return {
    pool: { token0: WBNB, token1: TOKEN_HI, fee: 2_500 },
    wbnbIsToken0: true,
    tickSpacing: 50,
    buyRange: { tickLower: 500, tickUpper: 1_000 },
    sellRange: { tickLower: -1_000, tickUpper: -500 },
    maxFlipsPerDay: 12,
    minNetEdgeBps: 0,
  };
}

const BUDGET = 10n ** 17n; // 0.1 BNB

function step(
  grid: LpGridSettings,
  state: DemoGridState,
  tick: number,
  atMs = 0,
): { state: DemoGridState; fills: readonly DemoGridFill[]; holds: readonly { level: number; reason: string }[] } {
  const out = demoGridStep({
    grid,
    state,
    currentTick: tick,
    atMs,
    relayFeePerSubmitWei: 0n,
    submissionsPerFlip: 2,
  });
  return { state: out.state, fills: out.fills, holds: [...out.holds] };
}

describe("demo grid engine — pool-order naming", () => {
  it("names quote and base by wbnbIsToken0, and round-trips", () => {
    assert.deepEqual(demoQuoteBase(7n, 9n, true), { quoteWei: 7n, baseWei: 9n });
    assert.deepEqual(demoQuoteBase(7n, 9n, false), { quoteWei: 9n, baseWei: 7n });
    for (const wbnbIsToken0 of [true, false]) {
      const named = demoQuoteBase(7n, 9n, wbnbIsToken0);
      assert.deepEqual(demoPoolOrder(named.quoteWei, named.baseWei, wbnbIsToken0), {
        amount0Wei: 7n,
        amount1Wei: 9n,
      });
    }
  });

  it("converts at a tick in both directions and stays positive", () => {
    const out0 = demoConvertAtTick({ amountWei: BUDGET, fromToken0: true, tick: 0 });
    const out1 = demoConvertAtTick({ amountWei: BUDGET, fromToken0: false, tick: 0 });
    // tick 0 is price 1, so both directions return the input (floors aside).
    assert.equal(out0, BUDGET);
    assert.equal(out1, BUDGET);
    assert.ok(demoConvertAtTick({ amountWei: BUDGET, fromToken0: true, tick: 1_000 }) > BUDGET);
  });
});

describe("demo grid engine — arm", () => {
  for (const [name, grid] of [["case A", caseA()], ["case B", caseB()]] as const) {
    it(`${name}: arms level 1 on the BUY rung holding quote`, () => {
      // The tick sits between the rungs, so both are strictly outside.
      const state = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
      assert.equal(state.levels.length, 1);
      assert.equal(state.levels[0]?.role, "buy");
      assert.ok((state.levels[0]?.liquidity ?? 0n) > 0n);
      assert.equal(state.flips, 0);
      assert.equal(state.costQuoteWei, 0n);
      // PHASE3.16 B1: the arm funds buyRange and ONLY buyRange.
      assert.equal(state.levels[0]?.openCycleQuoteWei, null);
      assert.equal(state.levels[0]?.cycles, 0);
    });
  }

  it("refuses a budget of zero", () => {
    assert.throws(
      () => demoGridArm({ grid: caseA(), currentTick: 0, budgetQuoteWei: 0n }),
      DemoGridArmError,
    );
  });

  it("refuses when the price sits INSIDE the buy rung (the G-gate)", () => {
    // Case A's buy rung is [-1000, -500); a tick inside it cannot be armed
    // single-sided, exactly as the live arm refuses.
    assert.throws(
      () => demoGridArm({ grid: caseA(), currentTick: -750, budgetQuoteWei: BUDGET }),
      (error: unknown) =>
        error instanceof DemoGridArmError && /cannot be armed single-sided/u.test(error.message),
    );
  });

  it("arms BOTH levels of a dual grid, the second holding base on its sell rung", () => {
    const grid: LpGridSettings = {
      ...caseA(),
      buyRange2: { tickLower: -2_000, tickUpper: -1_500 },
      sellRange2: { tickLower: 1_500, tickUpper: 2_000 },
    };
    const state = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
    assert.equal(state.levels.length, 2);
    assert.equal(state.levels[0]?.role, "buy");
    assert.equal(state.levels[1]?.role, "sell");
    assert.equal(state.levels[1]?.level, 2);
  });
});

describe("demo grid engine — the ping-pong", () => {
  /**
   * The core claim: a rung the price crosses COMPLETELY flips, and a rung the
   * price merely touches does not. Driven in both orientations, with the tick
   * series mirrored so each case crosses its own buy rung.
   */
  for (const [name, grid, intoBuy, throughBuy] of [
    // Case A: buy is BELOW at [-1000,-500). Crossing DOWN through it fills it.
    ["case A", caseA(), -700, -1_500],
    // Case B: buy is ABOVE at [500,1000). Crossing UP through it fills it.
    ["case B", caseB(), 700, 1_500],
  ] as const) {
    it(`${name}: a touch is not a fill, a full cross is`, () => {
      const armed = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });

      // Inside the buy rung: the range is half converted. NEVER a fill.
      const touched = step(grid, armed, intoBuy);
      assert.deepEqual(touched.fills, []);
      assert.equal(touched.state.levels[0]?.role, "buy");

      // Strictly beyond the far edge: filled, and the level flips to sell.
      const filled = step(grid, touched.state, throughBuy, 1_000);
      assert.equal(filled.fills.length, 1);
      const fill = filled.fills[0];
      assert.equal(fill?.from, "buy");
      assert.equal(fill?.to, "sell");
      assert.equal(fill?.level, 1);
      assert.deepEqual(fill?.toRange, grid.sellRange);
      // A filled BUY rung has become base, so it released base and no quote.
      assert.equal(fill?.quoteWei, 0n);
      assert.ok((fill?.baseWei ?? 0n) > 0n);
      // The cycle is OPEN, not closed: nothing is realised on the way out.
      assert.equal(fill?.cycleQuoteDeltaWei, null);
      assert.equal(filled.state.levels[0]?.role, "sell");
      assert.equal(filled.state.levels[0]?.cycles, 0);
      assert.ok((filled.state.levels[0]?.openCycleQuoteWei ?? 0n) > 0n);
      assert.equal(filled.state.flips, 1);
    });

    it(`${name}: a full round trip closes ONE cycle at a profit`, () => {
      const armed = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
      const out = step(grid, armed, throughBuy, 1_000);
      assert.equal(out.fills.length, 1);
      const openQuote = out.state.levels[0]?.openCycleQuoteWei;
      assert.ok(openQuote !== null && openQuote !== undefined);

      // Now cross the SELL rung the other way: the level converts back to quote.
      const backTick = name === "case A" ? 1_500 : -1_500;
      const back = step(grid, out.state, backTick, 2_000);
      assert.equal(back.fills.length, 1);
      const close = back.fills[0];
      assert.equal(close?.from, "sell");
      assert.equal(close?.to, "buy");
      assert.ok((close?.quoteWei ?? 0n) > 0n);
      assert.equal(close?.baseWei, 0n);

      // The whole point of a grid: buying low and selling high returns MORE
      // quote than went out, and that delta is the realised cycle.
      const delta = close?.cycleQuoteDeltaWei;
      assert.ok(delta !== null && delta !== undefined);
      assert.ok(delta > 0n, `expected a positive cycle delta, got ${delta}`);
      assert.equal(back.state.levels[0]?.cycles, 1);
      assert.equal(back.state.levels[0]?.realisedQuoteWei, delta);
      assert.equal(back.state.levels[0]?.openCycleQuoteWei, null);
      assert.equal(back.state.flips, 2);
    });
  }

  /**
   * REVIEW FIX (finding 17). The engine's comment used to say a fill needs the
   * tick "strictly beyond the far edge", and that is not what a HALF-OPEN V3
   * range does. At `tick === tickUpper` the range is already entirely token1 —
   * the price is past it — so that observation IS a fill; crossing the other
   * way needs `tick < tickLower`, strictly. The asymmetry belongs to the
   * interval, not to this engine, and it is pinned here so the next reader does
   * not "fix" one side of it.
   */
  it("fills AT the upper edge and only BELOW the lower edge — the half-open rule", () => {
    // Case B: WBNB is token0, buy rung is [500, 1000) ABOVE the price.
    const grid = caseB();
    const armed = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
    // Exactly at tickUpper: the range is behind the price. A FILL.
    const atUpper = step(grid, armed, grid.buyRange.tickUpper);
    assert.equal(atUpper.fills.length, 1);

    // Case A: WBNB is token1, buy rung is [-1000, -500) BELOW the price.
    const gridA = caseA();
    const armedA = demoGridArm({ grid: gridA, currentTick: 0, budgetQuoteWei: BUDGET });
    // Exactly at tickLower: still INSIDE the half-open range. NOT a fill.
    const atLower = step(gridA, armedA, gridA.buyRange.tickLower);
    assert.deepEqual(atLower.fills, []);
    // One tick below it: outside. A fill.
    const belowLower = step(gridA, armedA, gridA.buyRange.tickLower - 1);
    assert.equal(belowLower.fills.length, 1);
  });

  it("takes at most ONE flip per level per observation", () => {
    const grid = caseA();
    const armed = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
    // A single observation far beyond both rungs must not back-fill a ladder.
    const jumped = step(grid, armed, -50_000);
    assert.equal(jumped.fills.length, 1);
    assert.equal(jumped.state.flips, 1);
  });

  it("charges gas per flip as a line item, never netted into the cycle", () => {
    const grid = caseA();
    const armed = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
    const out = demoGridStep({
      grid,
      state: armed,
      currentTick: -1_500,
      atMs: 0,
      relayFeePerSubmitWei: 1_000n,
      submissionsPerFlip: 2,
    });
    assert.equal(out.state.costQuoteWei, 2_000n);
    // The fill's own amounts are UNTOUCHED by the pad — the cost is reported
    // beside the result, so a reader can see both halves.
    assert.equal(out.fills[0]?.cycleQuoteDeltaWei, null);
    assert.equal(out.state.levels[0]?.realisedQuoteWei, 0n);
  });

  it("a dual grid's two levels ping-pong on their OWN pairs, never sharing a rung", () => {
    const grid: LpGridSettings = {
      ...caseA(),
      buyRange2: { tickLower: -2_000, tickUpper: -1_500 },
      sellRange2: { tickLower: 1_500, tickUpper: 2_000 },
    };
    let state = demoGridArm({ grid, currentTick: 0, budgetQuoteWei: BUDGET });
    // Drop far enough to fill level 1's buy rung AND level 2 stays put (its
    // sell rung is above, so a fall does not fill it).
    const dropped = step(grid, state, -1_200);
    state = dropped.state;
    assert.equal(dropped.fills.length, 1);
    assert.equal(dropped.fills[0]?.level, 1);
    assert.equal(state.levels[0]?.role, "sell");
    assert.equal(state.levels[1]?.role, "sell");
    // PHASE3.17 B3: the two levels occupy DIFFERENT ranges even when both are
    // on the sell side, because each owns its own pair.
    assert.notDeepEqual(grid.sellRange, grid.sellRange2);
  });
});

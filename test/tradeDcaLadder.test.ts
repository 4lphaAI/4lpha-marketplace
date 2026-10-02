/**
 * Auto DCA placement math (AUTO-DCA-SPEC §4, §15.2 `tradeDcaLadder`, R2.6, R3.1, R3.2).
 *
 * Pure vectors at the M1 ticks, in BOTH pool orientations and BOTH spacings.
 * `P0 = P(tick)` exactly, from `getSqrtRatioAtTick`. The mutation this file is
 * built to kill: rounding a level tick UP instead of down fails the `≤ L_k`
 * assertion in both orientations (V2).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DCA_POOLS_56,
  dcaAhead,
  dcaHoldSide,
  dcaLadderAnchor,
  dcaLevelPrice,
  dcaLevelRange,
  dcaLevelVerdict,
  dcaMaxStepBps,
  dcaPoolForToken,
  dcaPriceAtTick,
  dcaPriceRangeHold,
  dcaRoundAnchor,
  dcaStepWithinDepth,
  dcaTpPlacement,
  dcaTpRange,
  dcaTpTarget,
  dcaTriggerMinOutWei,
  type DcaPool,
  type DcaPrice,
  type DcaRange,
} from "../src/trade/dca.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { gridTargetSide } from "../src/lp/gridTriggers.js";
import { USDT_56 } from "../src/trade/settlement.js";

function pool(symbol: string): DcaPool {
  const found = DCA_POOLS_56.find((entry) => entry.symbol === symbol);
  assert.ok(found, symbol);
  return found;
}

const le = (a: DcaPrice, b: DcaPrice): boolean => a.num * b.den <= b.num * a.den;
const ge = (a: DcaPrice, b: DcaPrice): boolean => a.num * b.den >= b.num * a.den;
const lt = (a: DcaPrice, b: DcaPrice): boolean => a.num * b.den < b.num * a.den;

/** The highest and lowest USDT price over a range, whichever way P runs with t. */
function priceSpan(p: DcaPool, range: DcaRange): { readonly high: DcaPrice; readonly low: DcaPrice } {
  const lower = dcaPriceAtTick(p, range.tickLower);
  const upper = dcaPriceAtTick(p, range.tickUpper);
  return p.usdtIsToken0 ? { high: lower, low: upper } : { high: upper, low: lower };
}

const M1_TICKS: readonly (readonly [string, number])[] = [
  ["NVDAB", 54_091], ["QQQB", 66_079], ["SPYB", -66_445], ["TSLAB", -59_389],
];

describe("the pinned pool table (§9.3, M1)", () => {
  it("holds the 17 R1 stocks, orientation equal to address order, spacing from the fee", () => {
    assert.equal(DCA_POOLS_56.length, 17);
    assert.equal(new Set(DCA_POOLS_56.map((entry) => entry.stock.toLowerCase())).size, 17);
    for (const entry of DCA_POOLS_56) {
      assert.equal(entry.usdtIsToken0, USDT_56.toLowerCase() < entry.stock.toLowerCase(), entry.symbol);
      assert.equal(entry.tickSpacing, entry.fee === 100 ? 1 : 50, entry.symbol);
      assert.equal(entry.fee === 100, entry.symbol === "QQQB" || entry.symbol === "SPYB", entry.symbol);
    }
    assert.equal(DCA_POOLS_56.filter((entry) => !entry.usdtIsToken0).length, 5);
    assert.equal(dcaPoolForToken("0x02FCA66C1D1AFB4E2A7884261EB00F63598A7436")?.symbol, "NVDAB");
    assert.equal(dcaPoolForToken(USDT_56), null);
  });
});

describe("V1 — the D1 deepest-level rule, exact integers", () => {
  it("accepts and refuses at the exact boundaries", () => {
    assert.equal(dcaStepWithinDepth(2472, 3), true);
    assert.equal(dcaStepWithinDepth(2473, 3), false);
    assert.equal(dcaStepWithinDepth(1676, 4), true); // 1676 × 3355 = 5 622 980 ≤ 5 625 000
    assert.equal(dcaStepWithinDepth(1677, 4), false);
    assert.equal(dcaStepWithinDepth(545, 8), true); // 545 × 6 444 955 = 3 512 500 475 ≤ 3 515 625 000
    assert.equal(dcaStepWithinDepth(546, 8), false);
    assert.equal(dcaStepWithinDepth(3000, 1), true);
    assert.equal(dcaStepWithinDepth(3000, 2), true);
  });

  it("the maximum step per N matches the §4.2 table", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(dcaMaxStepBps), [3000, 3000, 2472, 1676, 1209, 906, 696, 545]);
  });
});

describe("V2 — level ranges at step 1 %, N = 4", () => {
  const expected: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
    NVDAB: [[53_900, 53_950], [53_800, 53_850], [53_650, 53_700], [53_450, 53_500]],
    QQQB: [[65_977, 65_978], [65_855, 65_856], [65_707, 65_708], [65_526, 65_527]],
    SPYB: [[-66_344, -66_343], [-66_222, -66_221], [-66_074, -66_073], [-65_893, -65_892]],
    TSLAB: [[-59_250, -59_200], [-59_150, -59_100], [-59_000, -58_950], [-58_800, -58_750]],
  };

  for (const [symbol, tick] of M1_TICKS) {
    it(`${symbol}: the vector ranges, each at or below its level and placeable at the M1 tick`, () => {
      const p = pool(symbol);
      const p0 = dcaPriceAtTick(p, tick);
      const ranges = [1, 2, 3, 4].map((k) => dcaLevelRange(p, dcaLevelPrice(p0, k, 100)));
      assert.deepEqual(ranges.map((range) => [range.tickLower, range.tickUpper]), expected[symbol]);
      for (const [index, range] of ranges.entries()) {
        const level = dcaLevelPrice(p0, index + 1, 100);
        assert.ok(le(priceSpan(p, range).high, level), `${symbol} L${index + 1}: highest USDT price ≤ L_k (I2)`);
        // One spacing further up would sit above the level: the range is the highest one allowed.
        const shift = p.usdtIsToken0 ? -p.tickSpacing : p.tickSpacing;
        const upOne = { tickLower: range.tickLower + shift, tickUpper: range.tickUpper + shift };
        assert.ok(lt(level, priceSpan(p, upOne).high), `${symbol} L${index + 1}: snapped to the nearest range`);
        assert.equal(gridTargetSide(tick, range), dcaHoldSide(p, "level"), `${symbol} L${index + 1} placeable`);
      }
    });
  }
});

describe("V3 — TP ranges from the ledger (TP 1.5 %)", () => {
  const vectors: readonly (readonly [string, bigint, bigint, number, number])[] = [
    ["NVDAB", 10_100_000_000_000_000_000n, 44_656_850_000_000_000n, 54_400, 54_450],
    ["NVDAB", 20_100_000_000_000_000_000n, 90_288_740_000_000_000n, 54_250, 54_300],
    ["NVDAB", 50_100_000_000_000_000_000n, 230_898_350_000_000_000n, 53_950, 54_000],
    ["QQQB", 10_100_000_000_000_000_000n, 13_499_740_000_000_000n, 66_329, 66_330],
    ["QQQB", 50_100_000_000_000_000_000n, 69_230_410_000_000_000n, 65_996, 65_997],
  ];
  for (const [symbol, cost, stock, lower, upper] of vectors) {
    it(`${symbol} C=${cost} H=${stock} → [${lower}, ${upper})`, () => {
      const p = pool(symbol);
      const target = dcaTpTarget({ costUsdtWei: cost, stockWei: stock, takeProfitBps: 150 });
      const range = dcaTpRange(p, target);
      assert.deepEqual([range.tickLower, range.tickUpper], [lower, upper]);
      assert.ok(ge(priceSpan(p, range).low, target), "lowest price ≥ T (I2)");
    });
  }

  it("the USDT = token0 orientation keeps the lowest price at or above T", () => {
    for (const symbol of ["SPYB", "TSLAB"]) {
      const p = pool(symbol);
      const target = dcaPriceAtTick(p, symbol === "SPYB" ? -66_445 : -59_389);
      const bumped = { num: target.num * 10_150n, den: target.den * 10_000n };
      const range = dcaTpRange(p, bumped);
      assert.ok(ge(priceSpan(p, range).low, bumped), symbol);
      const shift = p.tickSpacing; // one spacing closer to the price is below T
      const down = { tickLower: range.tickLower + shift, tickUpper: range.tickUpper + shift };
      assert.ok(lt(priceSpan(p, down).low, bumped), `${symbol}: the nearest range`);
    }
  });
});

describe("R2.6 — TP placement is max(target, first placeable), never below target", () => {
  for (const [symbol, tick] of M1_TICKS) {
    it(`${symbol}: the target range while it is placeable, the first placeable one past it`, () => {
      const p = pool(symbol);
      const mid = dcaPriceAtTick(p, tick);
      const target = { num: mid.num * 10_150n, den: mid.den * 10_000n };
      const direct = dcaTpPlacement(p, target, tick);
      assert.deepEqual(direct, dcaTpRange(p, target));
      // The price has run through the target: a tick well past it on the stock side.
      const run = p.usdtIsToken0 ? tick - 400 : tick + 400;
      const moved = dcaTpPlacement(p, target, run);
      assert.equal(gridTargetSide(run, moved), dcaHoldSide(p, "tp"), "strictly on the stock side of the tick");
      assert.ok(ge(priceSpan(p, moved).low, target), "never below the target (I2)");
      assert.ok(ge(priceSpan(p, moved).low, dcaPriceAtTick(p, run)), "above the current price");
    });
  }
});

describe("R3.1 / R3.2 — ahead, the ladder anchor and one anchor per round", () => {
  it("1. dcaAhead: 1 while dcaMaxOrders ≤ 3, 2 from 4", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(dcaAhead), [1, 1, 1, 2, 2, 2, 2, 2]);
  });

  it("2. dcaLadderAnchor is amountIn / quotedOut, and refuses an absent or zero quoted output", () => {
    assert.deepEqual(dcaLadderAnchor({ amountInWei: 15n * 10n ** 18n, quotedOutWei: 67n * 10n ** 15n }), { num: 15n * 10n ** 18n, den: 67n * 10n ** 15n });
    assert.throws(() => dcaLadderAnchor({ amountInWei: 15n * 10n ** 18n }), /no quoted output/u);
    assert.throws(() => dcaLadderAnchor({ amountInWei: 15n * 10n ** 18n, quotedOutWei: 0n }), /no quoted output/u);
  });

  it("C13 (review C4): the anchor is the newest committed/finished start's, never a rolled-back attempt's; p0 for a pre-R3 round", () => {
    const round = { roundNo: 2, p0UsdtWei: 15n, p0StockWei: 1n };
    const a1 = { num: 223n, den: 1n }, a2 = { num: 225n, den: 1n }, a3 = { num: 227n, den: 1n };
    const act = (kind: "start" | "close-start" | "fill", roundNo: number, state: string, createdAtMs: number, ladderAnchor?: DcaPrice) =>
      ({ kind, roundNo, state, createdAtMs, plan: ladderAnchor === undefined ? {} : { ladderAnchor } });
    // Attempt 1 rolled back; attempt 2 landed: the landed attempt's anchor, whichever is older.
    assert.deepEqual(dcaRoundAnchor(round, [act("start", 2, "rolled-back", 1, a1), act("start", 2, "finished", 2, a2)]), a2);
    assert.deepEqual(dcaRoundAnchor(round, [act("start", 2, "finished", 1, a2), act("start", 2, "rolled-back", 2, a3)]), a2);
    // A round opened by the previous round's close + start; another round's start never counts.
    assert.deepEqual(dcaRoundAnchor(round, [act("close-start", 1, "committed", 5, a3), act("start", 1, "finished", 9, a1)]), a3);
    // Two landed attempts: the newest wins.
    assert.deepEqual(dcaRoundAnchor(round, [act("start", 2, "finished", 3, a3), act("start", 2, "committed", 1, a1)]), a3);
    // No R3 anchor (a start made before R3, or none at all): the round's P0.
    assert.deepEqual(dcaRoundAnchor(round, [act("start", 2, "finished", 1)]), { num: 15n, den: 1n });
    assert.deepEqual(dcaRoundAnchor(round, [act("fill", 2, "finished", 4, a1)]), { num: 15n, den: 1n });
    assert.equal(dcaRoundAnchor({ roundNo: 2, p0UsdtWei: null, p0StockWei: null }, []), null);
  });
});

describe("D5 — the price range filter", () => {
  it("drops a level below min; a round starts only inside [min, max]; the TP is never filtered", () => {
    const p = pool("NVDAB");
    const p0 = dcaPriceAtTick(p, 54_091); // ≈ 223.37
    const level = dcaLevelPrice(p0, 4, 100); // ≈ 211.38
    const range = dcaLevelRange(p, level);
    const reading = { tick: range.tickUpper, sqrtPriceX96: getSqrtRatioAtTick(range.tickUpper) };
    assert.equal(dcaLevelVerdict({ pool: p, levelPrice: level, range, rangeMinE8: 21_500_000_000n, reading }), "below-range");
    assert.equal(dcaLevelVerdict({ pool: p, levelPrice: level, range, rangeMinE8: 21_000_000_000n, reading }), "placeable");
    const sqrt = getSqrtRatioAtTick(54_091);
    assert.equal(dcaPriceRangeHold({ pool: p, sqrtPriceX96: sqrt, rangeMinE8: 22_400_000_000n, rangeMaxE8: 23_000_000_000n }), "dca-below-range");
    assert.equal(dcaPriceRangeHold({ pool: p, sqrtPriceX96: sqrt, rangeMinE8: 15_000_000_000n, rangeMaxE8: 22_300_000_000n }), "dca-above-range");
    assert.equal(dcaPriceRangeHold({ pool: p, sqrtPriceX96: sqrt, rangeMinE8: 15_000_000_000n, rangeMaxE8: 23_000_000_000n }), null);
    assert.equal(dcaPriceRangeHold({ pool: p, sqrtPriceX96: sqrt, rangeMinE8: null, rangeMaxE8: null }), null);
    // The TP takes no range input at all: a target above max is still placed.
    const tp = dcaTpPlacement(p, { num: p0.num * 2n, den: p0.den }, 54_091);
    assert.ok(tp.tickLower > 54_091);
  });
});

describe("R2.14 — the trigger is a minOut floor", () => {
  it("rounds up, so the execution price is at or below the trigger", () => {
    // 15 USDT at a 200.00 trigger: at least 0.075 stock.
    assert.equal(dcaTriggerMinOutWei(15n * 10n ** 18n, 20_000_000_000n), 75_000_000_000_000_000n);
    assert.equal(dcaTriggerMinOutWei(10n ** 18n, 300_000_000n), 333_333_333_333_333_334n);
  });
});

describe("exhaustive disjointness (§4.3)", () => {
  it("every N, every step on the 50-bps grid up to the V1 maximum, both orientations and spacings", () => {
    for (const [symbol, tick] of M1_TICKS) {
      const p = pool(symbol);
      const p0 = dcaPriceAtTick(p, tick);
      for (let n = 1; n <= 8; n += 1) {
        for (let step = 100; step <= dcaMaxStepBps(n); step += 50) {
          const ranges = Array.from({ length: n }, (_, index) => dcaLevelRange(p, dcaLevelPrice(p0, index + 1, step)));
          for (const [index, range] of ranges.entries()) {
            assert.ok(lt(priceSpan(p, range).high, p0), `${symbol} N=${n} step=${step} L${index + 1} below P0`);
            const next = ranges[index + 1];
            if (next !== undefined) {
              assert.ok(le(priceSpan(p, next).high, priceSpan(p, range).low), `${symbol} N=${n} step=${step} L${index + 2} below L${index + 1}`);
              assert.ok(next.tickUpper <= range.tickLower || next.tickLower >= range.tickUpper, "no shared tick span");
            }
          }
        }
      }
    }
  });
});

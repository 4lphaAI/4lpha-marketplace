/**
 * Auto DCA decisions and batch plans (AUTO-DCA-SPEC §5, §15.2 `tradeDcaPlanner`,
 * R2.4, R2.6, R2.21, R3.1–R3.3, R3.9). Pure: injected readings, no chain, no clock.
 *
 * Fixtures sit on NVDAB (stock = token0, spacing 50) at the M1 tick 54 091,
 * with the V2 ladder L1 [53900, 53950), L2 [53800, 53850), L3 [53650, 53700)
 * and a TP at [54400, 54450); SPYB (USDT = token0, spacing 1) covers the other
 * orientation where the shape differs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";

import {
  DCA_POOLS_56,
  dcaAdvanceCounter,
  dcaAhead,
  dcaApplyExit,
  dcaBatchCalls,
  dcaCounterConfirmed,
  dcaEquityWei,
  dcaLevelPrice,
  dcaLevelRange,
  dcaLevelTop,
  dcaLevelVerdict,
  dcaMarkedPnlWei,
  dcaOrderReadsFilled,
  dcaPriceAtTick,
  dcaSettle,
  dcaStartLedger,
  dcaStopLineWei,
  dcaStopLossBreached,
  dcaTpTarget,
  nextDcaStrategyStep,
  planDcaClose,
  planDcaCloseStart,
  planDcaFill,
  planDcaLevelPlace,
  planDcaRemove,
  planDcaStart,
  planDcaStopLoss,
  type DcaBatchPlan,
  type DcaLiveOrder,
  type DcaPool,
  type DcaPrice,
  type DcaReading,
  type DcaSwapLeg,
} from "../src/trade/dca.js";
import { getAmountsForLiquidity, getLiquidityForAmounts, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { decodeJsonb, encodeJsonbParam } from "../src/store/codec.js";
import { NFPM_56 } from "../src/ops/nfpm.js";

const E18 = 10n ** 18n;
const WALLET: Address = getAddress("0x00000000000000000000000000000000000000bB");
const TREASURY: Address = getAddress("0x00000000000000000000000000000000000000cC");
const GUARD: Address = getAddress("0x00000000000000000000000000000000000000dD");
const DEADLINE = 1_900_000_120n;

function pool(symbol: string): DcaPool {
  const found = DCA_POOLS_56.find((entry) => entry.symbol === symbol);
  assert.ok(found, symbol);
  return found;
}

const NV = pool("NVDAB");
const SPY = pool("SPYB");

function reading(tick: number, block = 100n): DcaReading {
  return { block, tick, sqrtPriceX96: getSqrtRatioAtTick(tick) };
}

/** A live level holding `usdt` (token1 on NVDAB), minted while the tick sat above it. */
function nvLevel(key: string, levelNo: number, tickLower: number, tokenId: bigint, usdt = 10n * E18): DcaLiveOrder {
  const tickUpper = tickLower + 50;
  const liquidity = getLiquidityForAmounts(getSqrtRatioAtTick(54_091), tickLower, tickUpper, 0n, usdt);
  return { orderKey: key, role: "level", levelNo, tokenId, tickLower, tickUpper, liquidity };
}

/** A live TP holding `stock` (token0 on NVDAB), minted while the tick sat below it. */
function nvTp(key: string, tokenId: bigint, stock = 67_000_000_000_000_000n): DcaLiveOrder {
  const liquidity = getLiquidityForAmounts(getSqrtRatioAtTick(54_091), 54_400, 54_450, stock, 0n);
  return { orderKey: key, role: "tp", levelNo: null, tokenId, tickLower: 54_400, tickUpper: 54_450, liquidity };
}

function swap(side: "buy" | "sell", amountInWei: bigint, minOutWei: bigint): DcaSwapLeg {
  // The three calls the TradFi v2 pricing builds (approve 0, approve n, swap); opaque data here.
  return { side, amountInWei, minOutWei, calls: [
    { to: GUARD, data: "0x01" as Hex }, { to: GUARD, data: "0x02" as Hex }, { to: GUARD, data: "0x03" as Hex },
  ] };
}

const base = (tick: number, p: DcaPool = NV) => ({ pool: p, roundNo: 1, reading: reading(tick), deadlineSec: DEADLINE });

/** The signed ladder a start mints from: step 1 %, D = 10 USDT. */
const ladder = (maxOrders = 4, rangeMinE8: bigint | null = null) => ({ stepBps: 100, maxOrders, orderWei: 10n * E18, rangeMinE8 });

function calls(plan: DcaBatchPlan, p: DcaPool = NV): number {
  return dcaBatchCalls(plan, { pool: p, nfpm: NFPM_56, wallet: WALLET, treasury: TREASURY }).length;
}

describe("V5 — the fill rule on NVDAB L1 [53900, 53950) (I1)", () => {
  const level = nvLevel("1:L1", 1, 53_900, 7n);
  const read = (tick: number) => dcaOrderReadsFilled({ pool: NV, role: "level", range: level, liquidity: level.liquidity, reading: reading(tick) });

  it("a touch is never a fill; only strictly beyond the far edge with a one-sided composition", () => {
    assert.equal(read(53_950), false, "at the upper edge: holds USDT");
    assert.equal(read(53_925), false, "inside: partly converted");
    // At tickLower exactly the composition is already one-sided, but the tick is inside.
    const atLower = getAmountsForLiquidity(getSqrtRatioAtTick(53_900), 53_900, 53_950, level.liquidity);
    assert.equal(atLower.amount1, 0n);
    assert.ok(atLower.amount0 > 0n);
    assert.equal(read(53_900), false, "composition alone is not a fill");
    assert.equal(read(53_899), true, "beyond the far edge: filled");
  });

  it("the TP mirrors it in the other orientation (SPYB, USDT = token0)", () => {
    const liquidity = getLiquidityForAmounts(getSqrtRatioAtTick(-66_445), -66_500, -66_499, 0n, 10n ** 16n);
    const tp = { tickLower: -66_500, tickUpper: -66_499 };
    const readTp = (tick: number) => dcaOrderReadsFilled({ pool: SPY, role: "tp", range: tp, liquidity, reading: reading(tick) });
    assert.equal(readTp(-66_499), false, "holds stock at or above tickUpper");
    assert.equal(readTp(-66_500), false, "inside");
    assert.equal(readTp(-66_501), true, "USDT only once below tickLower");
  });

  it("the counter confirms on two readings at distinct blocks one interval apart", () => {
    const interval = 60_000;
    let counter = { count: 0, lastBlock: null as bigint | null, lastAtMs: null as number | null };
    const step = (qualifies: boolean, block: bigint, atMs: number) => {
      counter = dcaAdvanceCounter(counter, { qualifies, block, atMs, intervalMs: interval });
      return dcaCounterConfirmed(counter);
    };
    assert.equal(step(true, 1n, 0), false); // B1 filled
    assert.equal(step(false, 2n, 60_000), false); // B2 not: reset
    assert.equal(step(true, 3n, 120_000), false); // B3 filled: one
    assert.equal(step(true, 4n, 180_000), true); // B4, 60 s after B3: confirmed only here
    const once = dcaAdvanceCounter({ count: 0, lastBlock: null, lastAtMs: null }, { qualifies: true, block: 9n, atMs: 0, intervalMs: interval });
    assert.deepEqual(dcaAdvanceCounter(once, { qualifies: true, block: 9n, atMs: 999_999, intervalMs: interval }), once, "B5 twice at the same block counts once");
    assert.deepEqual(dcaAdvanceCounter(once, { qualifies: true, block: 10n, atMs: 59_999, intervalMs: interval }), once, "a later block inside the interval does not count");
  });
});

describe("which batch (R2.8 order, R2.4 merges, R3.1)", () => {
  const idle = {
    roundActive: true, filledLevelNos: [], tpConfirmed: false, liveLevelReadsFilled: false,
    levelsToMint: [], startHold: null, levelHold: null, guardExpiredStreak: 0,
  } as const;

  it("no active round ⇒ start, or the start gate's hold", () => {
    assert.deepEqual(nextDcaStrategyStep({ ...idle, roundActive: false }), { kind: "start" });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, roundActive: false, startHold: "dca-uneconomic" }), { kind: "hold", reason: "dca-uneconomic" });
  });

  it("a fill comes first; it carries the levels that restore `ahead`, unless the level gate holds", () => {
    assert.deepEqual(nextDcaStrategyStep({ ...idle, filledLevelNos: [1], tpConfirmed: true, levelsToMint: [3] }),
      { kind: "fill", levelNos: [1], nextLevelNos: [3] });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, filledLevelNos: [1, 2], levelsToMint: [3, 4] }),
      { kind: "fill", levelNos: [1, 2], nextLevelNos: [3, 4] });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, filledLevelNos: [1], levelsToMint: [3], levelHold: "dca-cash-low" }),
      { kind: "fill", levelNos: [1], nextLevelNos: [] });
  });

  it("close + start merged when the start gates pass; close alone when they fail or after two GUARD_QUOTE_EXPIRED", () => {
    assert.deepEqual(nextDcaStrategyStep({ ...idle, tpConfirmed: true }), { kind: "close-start" });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, tpConfirmed: true, startHold: "dca-cash-low" }), { kind: "close" });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, tpConfirmed: true, guardExpiredStreak: 1 }), { kind: "close-start" });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, tpConfirmed: true, guardExpiredStreak: 2 }), { kind: "close" });
  });

  it("7. a level placement mints the open slots' placeable levels, and waits while any live level reads filled", () => {
    assert.deepEqual(nextDcaStrategyStep({ ...idle, levelsToMint: [1, 2] }), { kind: "level-place", levelNos: [1, 2] });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, levelsToMint: [2] }), { kind: "level-place", levelNos: [2] });
    assert.deepEqual(nextDcaStrategyStep({ ...idle, liveLevelReadsFilled: true, levelsToMint: [2] }), { kind: "none" });
    assert.deepEqual(nextDcaStrategyStep({ ...idle }), { kind: "none" }, "no open slot or no placeable candidate");
  });

  it("6. inside the entry cutoff: no start and no USDT mint, while fills and the close still run; nothing is sold", () => {
    const cutoff = { ...idle, startHold: "session-expiring", levelHold: "session-expiring" };
    assert.deepEqual(nextDcaStrategyStep({ ...cutoff, filledLevelNos: [1], levelsToMint: [3] }),
      { kind: "fill", levelNos: [1], nextLevelNos: [] });
    assert.deepEqual(nextDcaStrategyStep({ ...cutoff, tpConfirmed: true }), { kind: "close" });
    assert.deepEqual(nextDcaStrategyStep({ ...cutoff, levelsToMint: [2] }), { kind: "hold", reason: "session-expiring" });
    assert.deepEqual(nextDcaStrategyStep({ ...cutoff, roundActive: false }), { kind: "hold", reason: "session-expiring" });
  });
});

describe("what each batch contains (R2.4 / R3.3 shapes; REVIEW2 N7 call counts)", () => {
  const minOut = 66_000_000_000_000_000n; // ≈ 15 USDT at ≈ 223 with slippage
  const buy = { ...swap("buy", 15n * E18, minOut), quotedOutWei: 67_000_000_000_000_000n };
  const fee = 15n * 10n ** 16n;

  it("batch 1, start at a = 2: swap · fee · stock approve pair · TP mint · two level mints = 12 calls; the TP stock is minOut plus the residue", () => {
    const plan = planDcaStart({ ...base(54_091), swap: buy, feeWei: fee, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "1:T1", ladder: ladder() });
    assert.equal(calls(plan), 13, "12 plus the fee transfer this generic plan carries");
    assert.deepEqual(plan.mints.map((mint) => mint.orderKey), ["1:T1", "r1:l1", "r1:l2"]);
    assert.equal(plan.mints[0]?.amount0Desired, minOut, "stock is token0 on NVDAB");
    assert.equal(plan.mints[0]?.amount1Desired, 0n);
    assert.equal(plan.quoteSpendWei, 15n * E18 + fee + 20n * E18, "R3.5: B + fee + a·D");
    // The target is the worst-case average (spend / minOut) — never the quote.
    assert.deepEqual(plan.tpTarget, dcaTpTarget({ costUsdtWei: 15n * E18 + fee, stockWei: minOut, takeProfitBps: 150 }));
    // C8: a leg whose quote differs still places the target from minOut.
    const quoted = planDcaStart({ ...base(54_091), swap: { ...buy, quotedOutWei: minOut + 10n ** 15n }, feeWei: fee, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "1:T1", ladder: ladder() });
    assert.deepEqual(quoted.tpTarget, dcaTpTarget({ costUsdtWei: 15n * E18 + fee, stockWei: minOut, takeProfitBps: 150 }));
    const withResidue = planDcaStart({ ...base(54_091), swap: buy, feeWei: fee, carriedCostWei: 2n * E18, residueStockWei: 9n * 10n ** 15n, takeProfitBps: 150, tpOrderKey: "2:T1", ladder: ladder() });
    assert.equal(withResidue.mints[0]?.amount0Desired, minOut + 9n * 10n ** 15n);
    assert.deepEqual(withResidue.tpTarget, dcaTpTarget({ costUsdtWei: 17n * E18 + fee, stockWei: minOut + 9n * 10n ** 15n, takeProfitBps: 150 }));
    // R3.2: a start without the offer's quoted output refuses (fail-closed).
    assert.throws(() => planDcaStart({ ...base(54_091), swap: swap("buy", 15n * E18, minOut), feeWei: fee, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "1:T1", ladder: ladder() }), /no quoted output/u);
  });

  it("the start TP in the USDT = token0 orientation deposits token1", () => {
    const plan = planDcaStart({ ...base(-66_445, SPY), swap: { ...swap("buy", 15n * E18, 19_000_000_000_000_000n), quotedOutWei: 19_500_000_000_000_000n },
      feeWei: fee, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 100, tpOrderKey: "1:T1", ladder: ladder() });
    assert.equal(plan.mints[0]?.amount0Desired, 0n);
    assert.equal(plan.mints[0]?.amount1Desired, 19_000_000_000_000_000n);
    assert.ok((plan.mints[0]?.tickUpper ?? 0) <= -66_445, "a stock range sits below the tick when USDT is token0");
    assert.equal(calls(plan, SPY), 13);
  });

  it("batch 2, close + start: 18 calls with r = a = 2 resting (13 at a = 1); the new round's levels are keyed in round k + 1", () => {
    const input = { ...base(54_460), tp: nvTp("1:T1", 11n), swap: buy, feeWei: fee, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "2:T1" };
    const two = planDcaCloseStart({ ...input, ladder: ladder(), liveLevels: [nvLevel("1:L1", 1, 53_900, 12n), nvLevel("1:L2", 2, 53_800, 13n)] });
    assert.equal(calls(two), 19, "18 plus the fee transfer");
    assert.deepEqual(two.exits.map((exit) => exit.orderKey), ["1:T1", "1:L1", "1:L2"], "TP exit first, then the live levels");
    assert.deepEqual(two.mints.map((mint) => mint.orderKey), ["2:T1", "r2:l1", "r2:l2"], "review C5: the mints belong to round k + 1");
    const one = planDcaCloseStart({ ...input, ladder: ladder(3), liveLevels: [nvLevel("1:L1", 1, 53_900, 12n)] });
    assert.equal(calls(one), 14);
    assert.deepEqual(one.mints.map((mint) => mint.orderKey), ["2:T1", "r2:l1"]);
  });

  it("batch 3, close: TP exit · live level exits", () => {
    assert.equal(calls(planDcaClose({ ...base(54_460), tp: nvTp("1:T1", 11n), liveLevels: [nvLevel("1:L1", 1, 53_900, 12n)] })), 4);
  });

  it("7. batch 4, level place: a USDT approve pair · level mint of exactly dcaOrderWei per level (a = 2: 6 calls, 20e18)", () => {
    const l1 = { orderKey: "1:L1", levelNo: 1, range: { tickLower: 53_900, tickUpper: 53_950 } };
    const l2 = { orderKey: "1:L2", levelNo: 2, range: { tickLower: 53_800, tickUpper: 53_850 } };
    const plan = planDcaLevelPlace({ ...base(53_960), levels: [l1], orderWei: 10n * E18 });
    assert.equal(calls(plan), 3);
    assert.equal(plan.mints[0]?.amount1Desired, 10n * E18);
    assert.equal(plan.quoteSpendWei, 10n * E18);
    const both = planDcaLevelPlace({ ...base(54_091), levels: [l1, l2], orderWei: 10n * E18 });
    assert.equal(calls(both), 6);
    assert.equal(both.quoteSpendWei, 20n * E18);
    assert.deepEqual(both.mints.map((mint) => mint.orderKey), ["1:L1", "1:L2"]);
  });

  it("6. batch 5, fill: a = 2, f = 1 ⇒ 10 calls; f = 2 ⇒ 15; a = 1, f = 1 ⇒ 10; the last level ⇒ 7", () => {
    const ledger = { costUsdtWei: 15n * E18 + fee, stockAcquiredWei: 67_000_000_000_000_000n };
    const common = { ledger, walletRoundStockWei: 1_000_000_000_000_000n, takeProfitBps: 150, tpOrderKey: "1:T2", orderWei: 10n * E18 };
    const l1 = { ...nvLevel("1:L1", 1, 53_900, 12n), mintedUsdtWei: 10n * E18 };
    const l2 = { ...nvLevel("1:L2", 2, 53_800, 13n), mintedUsdtWei: 10n * E18 };
    const L2 = { orderKey: "1:L2", levelNo: 2, range: { tickLower: 53_800, tickUpper: 53_850 } };
    const L3 = { orderKey: "1:L3", levelNo: 3, range: { tickLower: 53_650, tickUpper: 53_700 } };
    const L4 = { orderKey: "1:L4", levelNo: 4, range: { tickLower: 53_450, tickUpper: 53_500 } };
    const oneOfTwo = planDcaFill({ ...base(53_890), ...common, filled: [l1], oldTp: nvTp("1:T1", 11n), nextLevels: [L3] });
    assert.equal(calls(oneOfTwo), 10);
    assert.deepEqual(oneOfTwo.exits.map((exit) => exit.orderKey), ["1:L1", "1:T1"]);
    assert.deepEqual(oneOfTwo.mints.map((mint) => mint.orderKey), ["1:T2", "1:L3"], "TP first, then the level");
    const twoOfTwo = planDcaFill({ ...base(53_790), ...common, filled: [l1, l2], oldTp: nvTp("1:T1", 11n), nextLevels: [L3, L4] });
    assert.equal(calls(twoOfTwo), 15);
    assert.deepEqual(twoOfTwo.mints.map((mint) => mint.orderKey), ["1:T2", "1:L3", "1:L4"]);
    const aOne = planDcaFill({ ...base(53_890), ...common, filled: [l1], oldTp: nvTp("1:T1", 11n), nextLevels: [L2] });
    assert.equal(calls(aOne), 10);
    assert.deepEqual(aOne.mints.map((mint) => mint.orderKey), ["1:T2", "1:L2"]);
    const last = planDcaFill({ ...base(53_790), ...common, filled: [l2], oldTp: nvTp("1:T1", 11n), nextLevels: [] });
    assert.equal(calls(last), 7);
    assert.deepEqual(last.mints.map((mint) => mint.role), ["tp"]);
  });

  it("the fill's TP takes every round token at its exit floor, and its target from the projected ledger (R2.6)", () => {
    const ledger = { costUsdtWei: 15n * E18 + fee, stockAcquiredWei: 67_000_000_000_000_000n };
    const l1 = { ...nvLevel("1:L1", 1, 53_900, 12n), mintedUsdtWei: 10n * E18 };
    const oldTp = nvTp("1:T1", 11n);
    const wallet = 1_000_000_000_000_000n;
    const plan = planDcaFill({ ...base(53_890), ledger, walletRoundStockWei: wallet, takeProfitBps: 150, tpOrderKey: "1:T2",
      filled: [l1], oldTp, nextLevels: [], orderWei: 10n * E18 });
    const filledFloor = plan.exits[0]?.amount0Min ?? 0n;
    const tpFloor = plan.exits[1]?.amount0Min ?? 0n;
    assert.ok(filledFloor > 0n && tpFloor > 0n);
    assert.equal(plan.mints[0]?.amount0Desired, wallet + filledFloor + tpFloor);
    assert.deepEqual(plan.tpTarget, dcaTpTarget({ costUsdtWei: ledger.costUsdtWei + 10n * E18, stockWei: ledger.stockAcquiredWei + filledFloor, takeProfitBps: 150 }));
  });

  it("batch 6, stop-loss sweep: exits only, owner floors, even with the tick inside a range; no swap (I8)", () => {
    const plan = planDcaStopLoss({ ...base(53_925), orders: [nvTp("1:T1", 11n), nvLevel("1:L1", 1, 53_900, 12n), nvLevel("1:L2", 2, 53_800, 13n)], slippageBps: 100 });
    assert.equal(calls(plan), 6);
    assert.equal(plan.swap, null);
    assert.equal(plan.mints.length, 0);
    assert.equal(plan.quoteSpendWei, 0n);
    // C17: the planner caps a batch at DCA_MAX_EXITS_PER_BATCH exits.
    const nine = Array.from({ length: 9 }, (_, index) => nvLevel(`1:L${index}`, index + 1, 53_900, BigInt(20 + index)));
    assert.equal(planDcaStopLoss({ ...base(53_925), orders: nine.slice(0, 8), slippageBps: 100 }).exits.length, 8);
    assert.throws(() => planDcaStopLoss({ ...base(53_925), orders: nine, slippageBps: 100 }), /at most 8 exits/u);
  });

  it("batch 7, Remove: exits only, owner floors, even with the tick inside a range; no swap (AUTO-DCA R4.1.1)", () => {
    const orders = [nvTp("1:T1", 11n), nvLevel("1:L1", 1, 53_900, 12n)];
    const plan = planDcaRemove({ ...base(53_925), orders, slippageBps: 100 });
    assert.equal(calls(plan), 4);
    assert.equal(plan.swap, null);
    assert.equal(plan.quoteSpendWei, 0n);
    assert.equal(plan.mints.length, 0);
  });
});

describe("R3.2 — the start mints its first `ahead` levels from the ladder anchor", () => {
  // The §15 V2 ranges at step 1 %: the anchor is the quote-implied price
  // (amountIn / quotedOut) itself, since the floor-rounding excess over the
  // mid is far under the cap of mid × (1 + pool fee) (operator ruling
  // D-R3-4 (b) 2026-09-25); the L1/L2 ticks land the same either way.
  const vectors: readonly (readonly [string, number, readonly [number, number], readonly [number, number]])[] = [
    ["NVDAB", 54_091, [53_900, 53_950], [53_800, 53_850]],
    ["QQQB", 66_079, [65_977, 65_978], [65_855, 65_856]],
    ["SPYB", -66_445, [-66_344, -66_343], [-66_222, -66_221]],
    ["TSLAB", -59_389, [-59_250, -59_200], [-59_150, -59_100]],
  ];
  const lte = (a: DcaPrice, b: DcaPrice): boolean => a.num * b.den <= b.num * a.den;
  const startAt = (p: DcaPool, tick: number, maxOrders: number, readingTick = tick, rangeMinE8: bigint | null = null) => {
    const mid = dcaPriceAtTick(p, tick);
    const quotedOutWei = 15n * E18 * mid.den / mid.num;
    return planDcaStart({ pool: p, roundNo: 1, reading: { block: 100n, tick: readingTick, sqrtPriceX96: getSqrtRatioAtTick(tick) }, deadlineSec: DEADLINE,
      swap: { ...swap("buy", 15n * E18, quotedOutWei * 99n / 100n), quotedOutWei }, feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n,
      takeProfitBps: 150, tpOrderKey: "r1:tp", ladder: ladder(maxOrders, rangeMinE8) });
  };

  for (const [symbol, tick, l1, l2] of vectors) {
    it(`3. ${symbol} at ${tick}, N ∈ {2, 3, 4, 5, 8}: [TP, L1] at a = 1 (9 calls, 25e18), [TP, L1, L2] at a = 2 (12 calls, 35e18)`, () => {
      const p = pool(symbol);
      const mid = dcaPriceAtTick(p, tick);
      const quotedOutWei = 15n * E18 * mid.den / mid.num;
      const expectedAnchor: DcaPrice = { num: 15n * E18, den: quotedOutWei };
      for (const n of [2, 3, 4, 5, 8]) {
        const plan = startAt(p, tick, n);
        const a = dcaAhead(n);
        assert.deepEqual(plan.ladderAnchor, expectedAnchor, `${symbol} N=${n}: A = amountIn / quotedOut`);
        assert.deepEqual(plan.mints.map((mint) => mint.orderKey), a === 1 ? ["r1:tp", "r1:l1"] : ["r1:tp", "r1:l1", "r1:l2"]);
        assert.equal(calls(plan, p), a === 1 ? 9 : 12);
        assert.equal(plan.quoteSpendWei, a === 1 ? 25n * E18 : 35n * E18);
        const levels = plan.mints.slice(1);
        assert.deepEqual(levels.map((mint) => [mint.tickLower, mint.tickUpper]), a === 1 ? [l1] : [l1, l2]);
        for (const mint of levels) {
          assert.equal(p.usdtIsToken0 ? mint.amount0Desired : mint.amount1Desired, 10n * E18, "exactly D on the USDT leg");
          assert.equal(p.usdtIsToken0 ? mint.amount1Desired : mint.amount0Desired, 0n);
          assert.ok(lte(dcaLevelTop(p, mint), dcaLevelPrice(plan.ladderAnchor!, mint.levelNo!, 100)), `${symbol} L${mint.levelNo}: top ≤ L_k(A) (I2)`);
        }
      }
    });
  }

  describe("D-R3-4 (b): the anchor cap is mid × (1 + pool fee), not the mid itself", () => {
    const p = pool("NVDAB"); // fee 2 500 = 0.25 %
    const mid = dcaPriceAtTick(p, 54_091);
    const cap: DcaPrice = { num: mid.num * BigInt(1_000_000 + p.fee), den: mid.den * 1_000_000n };
    const startWith = (quotedOutWei: bigint) => planDcaStart({
      pool: p, roundNo: 1, reading: { block: 100n, tick: 54_091, sqrtPriceX96: getSqrtRatioAtTick(54_091) }, deadlineSec: DEADLINE,
      swap: { ...swap("buy", 15n * E18, quotedOutWei * 99n / 100n), quotedOutWei }, feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n,
      takeProfitBps: 150, tpOrderKey: "r1:tp", ladder: ladder(2) });

    it("(i) a direct-route quote at/just under the cap (one pool fee above the mid) passes through unclamped: L1 sits at the owner's step", () => {
      // Ceiling the quoted output rounds the implied price DOWN, so this quote sits at
      // or just under the cap (never above it) — the shape of a real direct-route quote.
      const quotedOutWei = (15n * E18 * cap.den + cap.num - 1n) / cap.num;
      const quoted: DcaPrice = { num: 15n * E18, den: quotedOutWei };
      assert.ok(lte(quoted, cap), "the constructed quote sits at or under the cap");
      const plan = startWith(quotedOutWei);
      assert.deepEqual(plan.ladderAnchor, quoted, "the anchor is the quote itself, not the mid");
      assert.notDeepEqual(plan.ladderAnchor, mid, "not clamped down to the mid (the old D-R3-4 (b) behaviour)");
      const l1 = plan.mints[1]!;
      const expectedRange = dcaLevelRange(p, dcaLevelPrice(quoted, 1, 100));
      assert.deepEqual({ tickLower: l1.tickLower, tickUpper: l1.tickUpper }, expectedRange,
        "L1 sits at the step computed from the owner's actual quote");
    });

    it("(ii) a quote above the cap is clamped: the anchor equals mid × (1 + pool fee) exactly", () => {
      // Flooring the quoted output rounds the implied price UP, past the cap.
      const quotedOutWei = (15n * E18 * cap.den) / cap.num;
      const quoted: DcaPrice = { num: 15n * E18, den: quotedOutWei };
      assert.ok(!lte(quoted, cap), "the constructed quote sits strictly above the cap");
      const plan = startWith(quotedOutWei);
      assert.deepEqual(plan.ladderAnchor, cap, "the anchor is capped at mid × (1 + pool fee)");
      assert.notDeepEqual(plan.ladderAnchor, quoted, "not the raw over-cap quote");
    });
  });

  it("5. a start whose reading tick sits inside L1's range skips L1 and mints L2 and L3 (a = 2), both orientations", () => {
    const nv = startAt(pool("NVDAB"), 54_091, 4, 53_925);
    assert.deepEqual(nv.mints.map((mint) => mint.orderKey), ["r1:tp", "r1:l2", "r1:l3"]);
    const spy = startAt(pool("SPYB"), -66_445, 4, -66_344);
    assert.deepEqual(spy.mints.map((mint) => mint.orderKey), ["r1:tp", "r1:l2", "r1:l3"]);
  });

  it("5. a below-range level is not minted, and neither is any deeper one", () => {
    // NVDAB at 223.37: L1 ≈ 221.14, L2 ≈ 218.46; a range min of 220 keeps L1 only.
    const plan = startAt(pool("NVDAB"), 54_091, 4, 54_091, 22_000_000_000n);
    assert.deepEqual(plan.mints.map((mint) => mint.orderKey), ["r1:tp", "r1:l1"]);
  });
});

describe("8. I14 — live levels ≤ ahead(N) and live orders ≤ 3 after every batch, on random tick paths", () => {
  it("both orientations, N ∈ {2, 3, 4, 5, 8}", () => {
    let seed = 20_260_925;
    const rand = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    for (const [p, start] of [[NV, 54_091], [SPY, -66_445]] as const) {
      for (const n of [2, 3, 4, 5, 8]) {
        const a = dcaAhead(n);
        const at = (tick: number) => ({ block: 100n, tick, sqrtPriceX96: getSqrtRatioAtTick(tick) });
        const mid = dcaPriceAtTick(p, start);
        const quotedOutWei = 15n * E18 * mid.den / mid.num;
        const first = planDcaStart({ pool: p, roundNo: 1, reading: at(start), deadlineSec: DEADLINE, swap: { ...swap("buy", 15n * E18, quotedOutWei * 99n / 100n), quotedOutWei },
          feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "r1:tp", ladder: ladder(n) });
        const anchor = first.ladderAnchor!;
        // The round's ladder rows, one per level: live (with its liquidity), pending or skipped.
        const rows = Array.from({ length: n }, (_, index) => ({ levelNo: index + 1, range: dcaLevelRange(p, dcaLevelPrice(anchor, index + 1, 100)),
          state: "pending" as "pending" | "live" | "skipped" | "done", liquidity: 0n }));
        const mark = (mints: DcaBatchPlan["mints"]) => {
          for (const mint of mints.filter((row) => row.role === "level")) Object.assign(rows[mint.levelNo! - 1]!, { state: "live", liquidity: mint.liquidity });
        };
        mark(first.mints);
        let tick = start;
        for (let stepNo = 0; stepNo < 80; stepNo += 1) {
          // A drifting-down price in both orientations (price falls with the tick when USDT is token0).
          tick += (p.usdtIsToken0 ? -1 : 1) * Math.round((rand() - 0.55) * 160);
          const reading = at(tick);
          const live = rows.filter((row) => row.state === "live");
          const filled = live.filter((row) => dcaOrderReadsFilled({ pool: p, role: "level", range: row.range, liquidity: row.liquidity, reading }));
          const open = a - (live.length - filled.length);
          const toMint: typeof rows = [];
          for (const row of rows.filter((entry) => entry.state === "pending")) {
            if (open <= 0 || toMint.length >= open) break;
            if (dcaLevelVerdict({ pool: p, levelPrice: dcaLevelPrice(anchor, row.levelNo, 100), range: row.range, rangeMinE8: null, reading }) !== "placeable") row.state = "skipped";
            else toMint.push(row);
          }
          const step = nextDcaStrategyStep({ roundActive: true, filledLevelNos: filled.map((row) => row.levelNo), tpConfirmed: false,
            liveLevelReadsFilled: filled.length > 0, levelsToMint: toMint.map((row) => row.levelNo), startHold: null, levelHold: null, guardExpiredStreak: 0 });
          const inputs = (levelNos: readonly number[]) => toMint.filter((row) => levelNos.includes(row.levelNo)).map((row) => ({ orderKey: `r1:l${row.levelNo}`, levelNo: row.levelNo, range: row.range }));
          let planned: DcaBatchPlan | null = null;
          if (step.kind === "fill") {
            planned = planDcaFill({ pool: p, roundNo: 1, reading, deadlineSec: DEADLINE, oldTp: null, ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: E18 / 10n },
              walletRoundStockWei: 10n ** 15n, takeProfitBps: 150, tpOrderKey: "r1:tp", orderWei: 10n * E18, nextLevels: inputs(step.nextLevelNos),
              filled: filled.map((row) => ({ orderKey: `r1:l${row.levelNo}`, role: "level" as const, levelNo: row.levelNo, tokenId: BigInt(row.levelNo), ...row.range, liquidity: row.liquidity, mintedUsdtWei: 10n * E18 })) });
            for (const row of filled) row.state = "done";
          } else if (step.kind === "level-place") {
            planned = planDcaLevelPlace({ pool: p, roundNo: 1, reading, deadlineSec: DEADLINE, levels: inputs(step.levelNos), orderWei: 10n * E18 });
          }
          if (planned !== null) mark(planned.mints);
          const liveAfter = rows.filter((row) => row.state === "live").length;
          assert.ok(liveAfter <= a, `${p.symbol} N=${n} step ${stepNo}: ${liveAfter} live levels > ahead ${a}`);
          assert.ok(1 + liveAfter <= 3, `${p.symbol} N=${n}: live orders ≤ 3`);
        }
      }
    }
  });
});

describe("I2, I6 and I15 at the builder", () => {
  it("no DCA planner builds a sell: a start refuses one, and planDcaRemove has no swap input and returns swap: null", () => {
    assert.throws(() => planDcaStart({ ...base(54_091), swap: swap("sell", 1n, 1n), feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "k", ladder: ladder() }), /carries a buy/);
    assert.equal(planDcaRemove({ ...base(54_091), orders: [], slippageBps: 100 }).swap, null);
  });

  it("a strategy exit's floor is the out-of-range principal less 1 bp, and positive", () => {
    const level = nvLevel("1:L1", 1, 53_900, 12n);
    const plan = planDcaClose({ ...base(54_460), tp: nvTp("1:T1", 11n), liveLevels: [level] });
    const exit = plan.exits[1];
    assert.ok(exit);
    const principal = getAmountsForLiquidity(getSqrtRatioAtTick(54_460), 53_900, 53_950, level.liquidity).amount1;
    assert.equal(exit.amount0Min, 0n);
    assert.ok(exit.amount1Min > 0n);
    assert.ok(exit.amount1Min < principal);
    assert.ok(exit.amount1Min >= (principal * 9_999n) / 10_000n);
  });

  it("a reading with the tick inside a range refuses a strategy build", () => {
    assert.throws(() => planDcaClose({ ...base(53_925), tp: nvTp("1:T1", 11n), liveLevels: [nvLevel("1:L1", 1, 53_900, 12n)] }), /I6/);
    assert.throws(() => planDcaLevelPlace({ ...base(53_925), levels: [{ orderKey: "1:L1", levelNo: 1, range: { tickLower: 53_900, tickUpper: 53_950 } }], orderWei: 10n * E18 }), /not strictly on its own side/);
  });

  it("the stop-loss sweep builder reaches no swap (source level, I8)", () => {
    const source = readFileSync(new URL("../src/trade/dca.ts", import.meta.url), "utf8");
    const start = source.indexOf("export function planDcaStopLoss");
    const body = source.slice(start, source.indexOf("\n}", start));
    assert.ok(start > 0 && body.length > 0);
    assert.doesNotMatch(body, /swap|sale|Swap|buildTradfi/u);
    // The module imports no swap builder at all: swap calls arrive as data.
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    assert.ok(imports.every((line) => !/Swap|guard\.js|pancakeV3|uniswap/u.test(line)), imports.join("\n"));
  });
});

describe("I4 — a persisted plan rebinds the same calls", () => {
  it("round-trips through the jsonb codec and rebuilds byte-identical calls", () => {
    const plan = planDcaFill({ ...base(53_890), ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: 67_000_000_000_000_000n },
      walletRoundStockWei: 0n, takeProfitBps: 150, tpOrderKey: "1:T2", filled: [{ ...nvLevel("1:L1", 1, 53_900, 12n), mintedUsdtWei: 10n * E18 }],
      oldTp: nvTp("1:T1", 11n), nextLevels: [{ orderKey: "1:L3", levelNo: 3, range: { tickLower: 53_650, tickUpper: 53_700 } }], orderWei: 10n * E18 });
    const stored = decodeJsonb(JSON.parse(encodeJsonbParam(plan))) as DcaBatchPlan;
    const context = { pool: NV, nfpm: NFPM_56, wallet: WALLET, treasury: TREASURY };
    assert.deepEqual(dcaBatchCalls(stored, context), dcaBatchCalls(plan, context));
    // R3.2: the start's ladder anchor survives the jsonb round trip (no DDL).
    const start = planDcaStart({ ...base(54_091), swap: { ...swap("buy", 15n * E18, 66n * 10n ** 15n), quotedOutWei: 67n * 10n ** 15n }, feeWei: 0n,
      carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "1:T1", ladder: ladder() });
    assert.deepEqual((decodeJsonb(JSON.parse(encodeJsonbParam(start))) as DcaBatchPlan).ladderAnchor, start.ladderAnchor);
  });
});

describe("the round ledger (§4.4, R2.6)", () => {
  it("start, a filled level, a TP close and a settle with carry", () => {
    let ledger = dcaStartLedger({ carriedCostWei: 0n, carriedStockWei: 0n, swapInWei: 15n * E18, feeWei: 15n * 10n ** 16n, swapOutWei: 67n * 10n ** 15n });
    assert.equal(ledger.costUsdtWei, 15_150_000_000_000_000_000n);
    ledger = dcaApplyExit(ledger, { role: "level", mintedUsdtWei: 10n * E18, collectedUsdtWei: 2n * 10n ** 15n, collectedStockWei: 45n * 10n ** 15n });
    assert.equal(ledger.costUsdtWei, 25_148_000_000_000_000_000n);
    assert.equal(ledger.stockAcquiredWei, 112n * 10n ** 15n);
    ledger = dcaApplyExit(ledger, { role: "tp", mintedUsdtWei: 0n, collectedUsdtWei: 25n * E18, collectedStockWei: 0n });
    assert.equal(ledger.usdtCollectedWei, 25n * E18);
    const whole = dcaSettle({ ledger, stockSoldWei: 112n * 10n ** 15n });
    assert.deepEqual(whole, { realizedPnlWei: 25n * E18 - 25_148_000_000_000_000_000n, carriedStockWei: 0n, carriedCostWei: 0n });
    const partial = dcaSettle({ ledger, stockSoldWei: 100n * 10n ** 15n });
    assert.equal(partial.carriedStockWei, 12n * 10n ** 15n);
    assert.equal(partial.carriedCostWei + (25n * E18 - partial.realizedPnlWei), ledger.costUsdtWei, "the carry and the cost sold add up to C");
  });
});

describe("AUTO-DCA R4.3 (I17): dcaMarkedPnlWei", () => {
  const reliable = { realizedPnlWei: 10n, unsoldStockWei: 5n, unsoldCostWei: 2n, unsoldValueWei: 3n, unreliable: false };
  it("realized + unsoldValue − unsoldCost, when every field is present and the round is reliable", () => {
    assert.equal(dcaMarkedPnlWei(reliable), 10n + 3n - 2n);
  });
  it("null when the round is unreliable, even with every field present", () => {
    assert.equal(dcaMarkedPnlWei({ ...reliable, unreliable: true }), null);
  });
  it("null when any of the four fields is null", () => {
    assert.equal(dcaMarkedPnlWei({ ...reliable, realizedPnlWei: null }), null);
    assert.equal(dcaMarkedPnlWei({ ...reliable, unsoldStockWei: null }), null);
    assert.equal(dcaMarkedPnlWei({ ...reliable, unsoldCostWei: null }), null);
    assert.equal(dcaMarkedPnlWei({ ...reliable, unsoldValueWei: null }), null);
  });
});

describe("V7 — the stop loss (§7, R2.16)", () => {
  it("fires at E ≤ 42.5 on capital 50 at 15 %, only on the second qualifying reading; resume at 42.0 moves the line to 35.7", () => {
    const baseline = 50n * E18;
    assert.equal(dcaStopLineWei(baseline, 1_500), 42_500_000_000_000_000_000n);
    assert.equal(dcaStopLossBreached(42_500_000_000_000_000_000n, baseline, 1_500), true);
    assert.equal(dcaStopLossBreached(42_500_000_000_000_000_001n, baseline, 1_500), false);
    let counter = { count: 0, lastBlock: null as bigint | null, lastAtMs: null as number | null };
    counter = dcaAdvanceCounter(counter, { qualifies: dcaStopLossBreached(42n * E18, baseline, 1_500), block: 10n, atMs: 0, intervalMs: 60_000 });
    assert.equal(dcaCounterConfirmed(counter), false, "never on one reading");
    counter = dcaAdvanceCounter(counter, { qualifies: dcaStopLossBreached(42n * E18, baseline, 1_500), block: 150n, atMs: 60_000, intervalMs: 60_000 });
    assert.equal(dcaCounterConfirmed(counter), true);
    assert.equal(dcaStopLineWei(42n * E18, 1_500), 35_700_000_000_000_000_000n);
  });

  it("equity from the ledger and composition: base only at B = 15, capital 55, stops at H·P = 6.90 (R2.16 copy)", () => {
    const ledger = dcaStartLedger({ carriedCostWei: 0n, carriedStockWei: 0n, swapInWei: 15n * E18, feeWei: 15n * 10n ** 16n, swapOutWei: E18 });
    const equity = (priceE2: bigint) => dcaEquityWei({
      capitalQuoteWei: 55n * E18, realizedPnlWei: 0n, ledger, liveLevelMintedUsdtWei: 0n,
      orderUsdtWei: 0n, orderStockWei: 0n, walletRoundStockWei: E18, mid: { num: priceE2, den: 100n },
    });
    assert.equal(equity(690n), 46_750_000_000_000_000_000n);
    assert.equal(dcaStopLossBreached(equity(690n), 55n * E18, 1_500), true);
    assert.equal(dcaStopLossBreached(equity(691n), 55n * E18, 1_500), false);
  });
});

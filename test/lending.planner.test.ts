/**
 * The lending planner — the pure layer's tables and its MUTATION KILLS
 * (MARKETPLACE-LENDING-AGENT R2.6, R2.7, R2.8, R3.10, R3.12, L10; R2.24).
 *
 * Two tests here are named the way R2.24 asks for, because their job is to FAIL
 * when a specific defect is reintroduced rather than to describe behaviour:
 *
 *   - "the pool-cash bound is getCash() MINUS ONE"
 *   - "swapInFor pads the input; the unpadded quote is refused"
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  LENDING_MIN_REPAY_WEI,
  RELAY_FEE_PER_EXIT_WEI,
  walletNativeFloorWei,
} from "../src/ops/policy.js";
import {
  chooseLendingDebtMarket,
  clampBelowBorrow,
  lendingCapacity,
  lendingMinRepayFor,
  lendingTier,
  meterTerm,
  planNativeLegs,
  planUsdtLegs,
  poolPriceE18,
  planLendingRetire,
  retireCleared,
  swapInFor,
  SWAP_SOLVER_MAX_QUOTES,
} from "../src/lending/sizing.js";
import type { LendingReserveReading } from "../src/lending/types.js";

const E18 = 10n ** 18n;
const V_USDT = getAddress("0xfD5840Cd36d94D7229439859C0112a4185BC0255");
const V_BNB = getAddress("0xA07c5b74C9B40447a954e1466938b865b6BBea36");

function reading(overrides: Partial<LendingReserveReading> = {}): LendingReserveReading {
  return {
    blockNumber: 100n,
    wallet: getAddress("0x00000000000000000000000000000000000000b1"),
    usdtBalance: 10n * E18,
    vUsdtBalance: 1_000n * 10n ** 8n,
    exchangeRateStored: 2n * 10n ** 26n, // 1e8 vTokens -> 20 USDT
    exchangeRateCurrent: 2n * 10n ** 26n,
    cash: 10_000n * E18,
    nativeBalance: 10n ** 17n,
    usdtAllowanceToVUsdt: 0n,
    usdtAllowanceToRouter: 0n,
    poolSqrtPriceX96: null,
    poolWbnbIsToken0: false,
    ...overrides,
  };
}

describe("lendingTier — the count-aware wallet floor (R2.8)", () => {
  it("narrows the reserve by what has already fired", () => {
    const fresh = lendingTier({
      nativeBalanceWei: 10n ** 17n,
      rescueReserveCount: 6,
      rescuesChargedInWindow: 0,
      outstandingArmNativeWei: 0n,
    });
    const late = lendingTier({
      nativeBalanceWei: 10n ** 17n,
      rescueReserveCount: 6,
      rescuesChargedInWindow: 5,
      outstandingArmNativeWei: 0n,
    });
    assert.equal(fresh.reservedSubmissions, 6);
    assert.equal(late.reservedSubmissions, 1);
    assert.ok(late.tierBnbWei > fresh.tierBnbWei, "a day of rescues frees its own reserve");
    assert.equal(
      fresh.floorWei,
      walletNativeFloorWei() + 6n * RELAY_FEE_PER_EXIT_WEI,
    );
  });

  it("never reserves fewer than one submission, however many have fired", () => {
    const exhausted = lendingTier({
      nativeBalanceWei: 10n ** 17n,
      rescueReserveCount: 2,
      rescuesChargedInWindow: 99,
      outstandingArmNativeWei: 0n,
    });
    assert.equal(exhausted.reservedSubmissions, 1);
  });

  it("R2.21 — subtracts the pending arm's own msg.value while it is outstanding", () => {
    const normal = lendingTier({
      nativeBalanceWei: 10n ** 17n, rescueReserveCount: 4,
      rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
    });
    const held = lendingTier({
      nativeBalanceWei: 10n ** 17n, rescueReserveCount: 4,
      rescuesChargedInWindow: 0, outstandingArmNativeWei: 4n * 10n ** 16n,
    });
    assert.equal(held.tierBnbWei, normal.tierBnbWei - 4n * 10n ** 16n);
  });

  it("floors at zero rather than going negative", () => {
    const broke = lendingTier({
      nativeBalanceWei: 1n, rescueReserveCount: 6,
      rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
    });
    assert.equal(broke.tierBnbWei, 0n);
  });
});

describe("lendingCapacity — the pool-cash bound", () => {
  it("the pool-cash bound is getCash() MINUS ONE", () => {
    // R2.24 mutation: moving the bound from `getCash() - 1` to `getCash()` must
    // fail HERE, by name. Never the last wei of pool cash — a redeem that asks
    // for all of it races every other redeemer and reverts the atomic batch.
    // The fixture supplies `vUsdtBalance x exchangeRateStored / 1e18` = 20 USDT.
    const supplied = 20n * E18;
    const capacity = lendingCapacity({
      reading: reading({ cash: supplied, usdtBalance: 0n }),
      tier: lendingTier({
        nativeBalanceWei: 0n, rescueReserveCount: 1,
        rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
      }),
      slippageBps: 100,
      tierToUsdtWei: 0n,
      usdtToNativeWei: 0n,
    });
    assert.equal(capacity.suppliedUsdtWei, supplied);
    assert.equal(
      capacity.redeemableUsdtWei,
      supplied - 1n,
      "the redeemable figure must be `cash - 1`, never `cash`",
    );
  });

  it("reports pool-cash-low when the whole supply is not redeemable in one go", () => {
    const capacity = lendingCapacity({
      reading: reading({ cash: 5n * E18 }),
      tier: lendingTier({
        nativeBalanceWei: 10n ** 17n, rescueReserveCount: 1,
        rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
      }),
      slippageBps: 100, tierToUsdtWei: 0n, usdtToNativeWei: 0n,
    });
    assert.equal(capacity.poolCashLow, true);
    assert.equal(capacity.redeemableUsdtWei, 5n * E18 - 1n);
  });

  it("sums idle + redeemable + the tier's buy-back for the USDT leg", () => {
    const capacity = lendingCapacity({
      reading: reading(),
      tier: lendingTier({
        nativeBalanceWei: 10n ** 17n, rescueReserveCount: 1,
        rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
      }),
      slippageBps: 100, tierToUsdtWei: 30n * E18, usdtToNativeWei: 0n,
    });
    assert.equal(
      capacity.usdtCapacityWei,
      capacity.idleUsdtWei + capacity.redeemableUsdtWei + 30n * E18,
    );
  });
});

describe("planUsdtLegs / planNativeLegs — where the money comes from", () => {
  const capacity = lendingCapacity({
    reading: reading({ usdtBalance: 10n * E18, cash: 50n * E18 }),
    tier: lendingTier({
      nativeBalanceWei: 10n ** 17n, rescueReserveCount: 2,
      rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
    }),
    slippageBps: 100, tierToUsdtWei: 25n * E18, usdtToNativeWei: 5n * 10n ** 16n,
  });

  it("takes idle first, then the pool, then the tier", () => {
    const small = planUsdtLegs(5n * E18, capacity);
    assert.deepEqual(small, { takeIdleWei: 5n * E18, takeRedeemWei: 0n, takeSwapWei: 0n });

    const medium = planUsdtLegs(15n * E18, capacity);
    assert.equal(medium.takeIdleWei, 10n * E18);
    assert.equal(medium.takeRedeemWei, 5n * E18);
    assert.equal(medium.takeSwapWei, 0n);
  });

  it("routes only the DEFICIT to the tier when the pool is short", () => {
    const shortPool = lendingCapacity({
      reading: reading({ usdtBalance: 1n * E18, cash: 2n * E18 }),
      tier: lendingTier({
        nativeBalanceWei: 10n ** 17n, rescueReserveCount: 2,
        rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
      }),
      slippageBps: 100, tierToUsdtWei: 25n * E18, usdtToNativeWei: 0n,
    });
    const legs = planUsdtLegs(10n * E18, shortPool);
    assert.equal(legs.takeIdleWei, 1n * E18);
    assert.equal(legs.takeRedeemWei, 2n * E18 - 1n);
    assert.equal(legs.takeSwapWei, 10n * E18 - 1n * E18 - (2n * E18 - 1n));
  });

  it("the ZERO-TIER case never asks for a swap it cannot fund", () => {
    const noTier = lendingCapacity({
      reading: reading({ usdtBalance: 100n * E18 }),
      tier: lendingTier({
        nativeBalanceWei: 0n, rescueReserveCount: 2,
        rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
      }),
      slippageBps: 100, tierToUsdtWei: 0n, usdtToNativeWei: 0n,
    });
    assert.equal(noTier.nativeCapacityWei, 0n);
    const legs = planUsdtLegs(50n * E18, noTier);
    assert.equal(legs.takeSwapWei, 0n, "idle alone covers it; no swap leg is emitted");
  });

  it("the BNB leg takes the tier first and asks the swap for the remainder", () => {
    const tier = lendingTier({
      nativeBalanceWei: 10n ** 17n, rescueReserveCount: 2,
      rescuesChargedInWindow: 0, outstandingArmNativeWei: 0n,
    });
    const inTier = planNativeLegs(tier.tierBnbWei / 2n, tier);
    assert.equal(inTier.takeSwapOutWei, 0n);
    const beyond = planNativeLegs(tier.tierBnbWei + 10n ** 16n, tier);
    assert.equal(beyond.takeTierWei, tier.tierBnbWei);
    assert.equal(beyond.takeSwapOutWei, 10n ** 16n);
  });
});

describe("swapInFor — the solver (R3.10)", () => {
  /** A linear pool: `out = in x rate / 1e18`. Monotone, as the solver assumes. */
  const linear = (rate: bigint) => async (amountIn: bigint) => (amountIn * rate) / E18;

  it("swapInFor pads the input; the unpadded quote is refused", () => {
    // R2.24 mutation: replacing the padded solve with the raw quote must fail
    // HERE, by name. `sagaSwapMinOut` floors the quote by the slippage rail, so
    // an input sized at exactly `need / rate` produces a floor BELOW `need`.
    const rate = E18; // 1:1
    const need = 100n * E18;
    return swapInFor({
      needWei: need,
      availableWei: 1_000n * E18,
      slippageBps: 100,
      seedPriceE18: rate,
      quote: linear(rate),
    }).then((solved) => {
      assert.equal(solved.clamped, false);
      assert.ok(
        solved.amountInWei > need,
        "an unpadded input would floor below the requirement and the batch's next leg would revert",
      );
      const flooredOut = ((solved.amountInWei * rate) / E18) * 9_900n / 10_000n;
      assert.ok(flooredOut >= need, "the padded input's FLOORED output covers the need");
      assert.equal(solved.minOutWei, need, "minOut is the REQUIREMENT, never the quote");
    });
  });

  it("CLAMPS AND SUBMITS when the requirement is out of reach — it never refuses", () => {
    return swapInFor({
      needWei: 1_000n * E18,
      availableWei: 10n * E18,
      slippageBps: 100,
      seedPriceE18: E18,
      quote: linear(E18),
    }).then((solved) => {
      assert.equal(solved.clamped, true);
      assert.equal(solved.amountInWei, 10n * E18, "spend everything available");
      assert.ok(solved.minOutWei > 0n, "and floor on what that actually buys");
      assert.ok(solved.minOutWei < 1_000n * E18);
    });
  });

  it("takes at most SWAP_SOLVER_MAX_QUOTES quotes, and searches DOWN when it can", () => {
    // The budget was three when the miss branch spent everything available;
    // AUDIT A-H1 replaced that with a bounded bisection, so the budget is now
    // SWAP_SOLVER_MAX_QUOTES and the search is what earns it.
    let calls = 0;
    return swapInFor({
      needWei: 10n * E18,
      availableWei: 1_000n * E18,
      slippageBps: 50,
      seedPriceE18: null, // no seed: the first quote is at `available`
      quote: async (amountIn) => { calls += 1; return (amountIn * E18) / E18; },
    }).then((solved) => {
      assert.ok(
        calls <= SWAP_SOLVER_MAX_QUOTES,
        `a cycle's read budget is bounded; used ${calls}`,
      );
      assert.equal(solved.quotes, calls);
      assert.equal(solved.clamped, false);
      assert.ok(
        solved.amountInWei < 1_000n * E18,
        "a seedless solve does not keep the whole available side when it can search down",
      );
      assert.ok(
        ((solved.amountInWei * E18) / E18) * 9_950n / 10_000n >= 10n * E18,
        "and what it keeps still covers the requirement",
      );
    });
  });

  describe("AUDIT A-H1 — the fee-bearing pool the zero-fee table could not see", () => {
    /**
     * A pool that charges its fee BEFORE the price, which is what a Pancake V3
     * pool does and what `slot0` does NOT show: `out = in x rate x (1 - fee)`.
     */
    const feePool = (rate: bigint, feePpm: bigint) => async (amountIn: bigint) =>
      ((amountIn * rate) / E18) * (1_000_000n - feePpm) / 1_000_000n;

    // 600 USDT per BNB, the real tiers, and every slippage rail the plane uses.
    for (const feePpm of [100n, 500n, 2_500n, 10_000n]) {
      for (const slippageBps of [50, 100, 300]) {
        it(`a SATISFIABLE need never clamps at fee ${feePpm}ppm / ${slippageBps}bps`, async () => {
          const rate = 600n * E18; // USDT out per BNB in
          const need = 15n * E18; // 15 USDT — a small, easily satisfiable need
          const available = 10n ** 17n; // 0.1 BNB tier ⇒ ~60 USDT of depth
          const solved = await swapInFor({
            needWei: need,
            availableWei: available,
            slippageBps,
            poolFeePpm: Number(feePpm),
            seedPriceE18: rate,
            quote: feePool(rate, feePpm),
          });
          assert.equal(
            solved.clamped, false,
            "the whole defect: a seed that ignored the fee missed, and the miss branch spent the ENTIRE tier",
          );
          assert.ok(
            solved.amountInWei < available / 2n,
            `a 15 USDT need must not convert most of the tier (took ${solved.amountInWei})`,
          );
          assert.equal(solved.minOutWei, need, "minOut is the REQUIREMENT");
          const flooredOut =
            (((solved.amountInWei * rate) / E18) * (1_000_000n - feePpm) / 1_000_000n)
            * BigInt(10_000 - slippageBps) / 10_000n;
          assert.ok(
            flooredOut >= need,
            "and the input the solver chose still floors above the requirement",
          );
          assert.ok(solved.quotes <= SWAP_SOLVER_MAX_QUOTES);
        });
      }
    }

    it("a seed that MISSES searches UP instead of spending everything (the miss branch)", async () => {
      // Seed deliberately mispriced 3x too optimistic, so the first quote misses
      // even with the fee term. The old code answered `available`, clamped.
      const rate = 600n * E18;
      const available = 10n ** 17n;
      const solved = await swapInFor({
        needWei: 15n * E18,
        availableWei: available,
        slippageBps: 100,
        poolFeePpm: 2_500,
        seedPriceE18: rate * 3n,
        quote: feePool(rate, 2_500n),
      });
      assert.equal(solved.clamped, false);
      assert.ok(
        solved.amountInWei < available,
        "a miss is a statement about the SEED, not about the reserve",
      );
      assert.ok(solved.quotes <= SWAP_SOLVER_MAX_QUOTES);
    });

    it("clamps ONLY when `available` itself cannot satisfy the requirement", async () => {
      const rate = 600n * E18;
      const solved = await swapInFor({
        needWei: 1_000n * E18, // 1 000 USDT
        availableWei: 10n ** 17n, // 0.1 BNB ⇒ ~60 USDT
        slippageBps: 100,
        poolFeePpm: 2_500,
        seedPriceE18: rate,
        quote: feePool(rate, 2_500n),
      });
      assert.equal(solved.clamped, true);
      assert.equal(solved.amountInWei, 10n ** 17n, "spend everything available");
      assert.ok(solved.minOutWei > 0n && solved.minOutWei < 1_000n * E18);
    });
  });

  it("answers zero for a zero requirement and for zero availability", async () => {
    const none = await swapInFor({
      needWei: 0n, availableWei: 100n, slippageBps: 100, seedPriceE18: E18,
      quote: linear(E18),
    });
    assert.deepEqual(
      { amountInWei: none.amountInWei, clamped: none.clamped, quotes: none.quotes },
      { amountInWei: 0n, clamped: false, quotes: 0 },
    );
    const broke = await swapInFor({
      needWei: 100n, availableWei: 0n, slippageBps: 100, seedPriceE18: E18,
      quote: linear(E18),
    });
    assert.equal(broke.amountInWei, 0n);
    assert.equal(broke.clamped, true);
  });

  it("survives an unreadable seed price by starting at `available`", async () => {
    const solved = await swapInFor({
      needWei: 10n * E18, availableWei: 100n * E18, slippageBps: 100,
      seedPriceE18: null, quote: linear(E18),
    });
    assert.equal(solved.clamped, false);
    assert.equal(solved.minOutWei, 10n * E18);
  });
});

describe("poolPriceE18 — the solver's seed", () => {
  it("inverts with the token order", () => {
    // sqrtPriceX96 for price1per0 == 4 is 2 * 2^96.
    const sqrt = 2n * 2n ** 96n;
    assert.equal(poolPriceE18(sqrt, true), 4n * E18);
    assert.equal(poolPriceE18(sqrt, false), E18 / 4n);
  });
  it("answers null for a zero price", () => {
    assert.equal(poolPriceE18(0n, true), null);
  });
});

describe("clampBelowBorrow — R2.6's 10-bps overpay clamp", () => {
  it("holds `r` strictly below the live borrow when they would be equal", () => {
    const borrow = 1_000n * E18;
    const clamped = clampBelowBorrow(borrow, borrow, LENDING_MIN_REPAY_WEI.usdt);
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.amountWei, borrow - borrow / 1_000n);
    assert.ok(clamped.amountWei < borrow);
  });

  it("clamps an OVERPAY down too, never through", () => {
    const borrow = 1_000n * E18;
    const over = clampBelowBorrow(borrow * 2n, borrow, LENDING_MIN_REPAY_WEI.usdt);
    assert.ok(over.amountWei < borrow);
  });

  it("leaves an amount already below the borrow untouched", () => {
    const borrow = 1_000n * E18;
    const under = clampBelowBorrow(borrow - 1n, borrow, LENDING_MIN_REPAY_WEI.usdt);
    assert.deepEqual(under, { amountWei: borrow - 1n, clamped: false });
  });

  it("L10 — below the dust floor it answers ZERO, so the caller says guarded-no-debt", () => {
    const dust = clampBelowBorrow(1n, 1n, LENDING_MIN_REPAY_WEI.usdt);
    assert.equal(dust.amountWei, 0n);
    assert.equal(dust.clamped, true);
    assert.equal(lendingMinRepayFor(false), LENDING_MIN_REPAY_WEI.usdt);
    assert.equal(lendingMinRepayFor(true), LENDING_MIN_REPAY_WEI.native);
  });
});

describe("meterTerm — R3.5's omit-and-report rule", () => {
  it("an unreadable meter OMITS the term and reports cap-unreadable", () => {
    const term = meterTerm({ kind: "unreadable", detail: "timeout" });
    assert.equal(term.capRemainingWei, null, "omitted, NEVER treated as zero");
    assert.equal(term.condition, "cap-unreadable");
  });
  it("a missing grant row and a wrong period both omit, and never refuse", () => {
    assert.equal(meterTerm({ kind: "no-grant" }).capRemainingWei, null);
    assert.equal(meterTerm({ kind: "other-period" }).capRemainingWei, null);
    assert.equal(meterTerm({ kind: "no-grant" }).condition, "cap-unreadable");
  });
  it("a readable meter clamps, and a spent one is named", () => {
    const live = meterTerm({
      kind: "day", limitWei: 100n, currentSpentWei: 40n, remainingWei: 60n,
    });
    assert.equal(live.capRemainingWei, 60n);
    assert.equal(live.condition, null);
    const spent = meterTerm({
      kind: "day", limitWei: 100n, currentSpentWei: 100n, remainingWei: 0n,
    });
    assert.equal(spent.capRemainingWei, 0n);
    assert.equal(spent.condition, "usdt-cap-exhausted");
  });
});

describe("chooseLendingDebtMarket — largest debt value, ties by address", () => {
  it("picks the largest debt VALUE, not the largest base-unit amount", () => {
    const chosen = chooseLendingDebtMarket([
      { vToken: V_USDT, native: false, borrowCurrentWei: 1_000n * E18, debtValueWei: 1_000n * E18 },
      { vToken: V_BNB, native: true, borrowCurrentWei: 3n * E18, debtValueWei: 1_800n * E18 },
    ]);
    assert.equal(chosen?.vToken, V_BNB);
  });

  it("skips a market at or below its dust floor", () => {
    const chosen = chooseLendingDebtMarket([
      { vToken: V_USDT, native: false, borrowCurrentWei: LENDING_MIN_REPAY_WEI.usdt, debtValueWei: 1n },
      { vToken: V_BNB, native: true, borrowCurrentWei: E18, debtValueWei: 600n * E18 },
    ]);
    assert.equal(chosen?.vToken, V_BNB);
  });

  it("answers null when every market is dust", () => {
    assert.equal(
      chooseLendingDebtMarket([
        { vToken: V_USDT, native: false, borrowCurrentWei: 1n, debtValueWei: 1n },
      ]),
      null,
    );
  });

  it("breaks a tie by lowercased address, deterministically", () => {
    const low = getAddress("0x1111111111111111111111111111111111111111");
    const high = getAddress("0x2222222222222222222222222222222222222222");
    const chosen = chooseLendingDebtMarket([
      { vToken: high, native: false, borrowCurrentWei: E18, debtValueWei: 5n * E18 },
      { vToken: low, native: false, borrowCurrentWei: E18, debtValueWei: 5n * E18 },
    ]);
    assert.equal(chosen?.vToken, low);
  });
});

describe("planLendingRetire — R2.5 as amended by R3.12", () => {
  it("amountIn equals idle + the redeemUnderlying argument, EXACTLY", () => {
    const plan = planLendingRetire(reading({ usdtBalance: 7n * E18, cash: 10_000n * E18 }));
    assert.equal(plan.swapInWei, 7n * E18 + plan.redeemAmountWei);
    assert.equal(plan.poolShort, false);
    assert.equal(plan.empty, false);
  });

  it("a POOL-SHORT retire plans the bounded partial rather than refusing", () => {
    const plan = planLendingRetire(reading({ usdtBalance: 1n * E18, cash: 5n * E18 }));
    assert.equal(plan.poolShort, true);
    assert.equal(plan.redeemAmountWei, 5n * E18 - 1n);
    assert.equal(plan.swapInWei, 1n * E18 + (5n * E18 - 1n));
    assert.ok(plan.remainderUsdtWei > 0n, "the remainder stays supplied and is disclosed");
    assert.equal(plan.empty, false);
  });

  it("is EMPTY only when there is literally nothing to submit", () => {
    const plan = planLendingRetire(
      reading({ usdtBalance: 0n, vUsdtBalance: 0n, cash: 0n }),
    );
    assert.equal(plan.empty, true);
  });

  it("still submits when the pool is dry but idle USDT exists", () => {
    const plan = planLendingRetire(reading({ usdtBalance: 3n * E18, cash: 0n }));
    assert.equal(plan.redeemAmountWei, 0n);
    assert.equal(plan.swapInWei, 3n * E18);
    assert.equal(plan.empty, false);
  });
});

describe("retireCleared — R3.12's RELATIVE dust bound", () => {
  it("a LARGE reserve whose residue exceeds the absolute constant still clears", () => {
    // REVIEW2 M9: `(current - stored) x vBal` scales with the reserve while an
    // absolute 0.01 USDT constant does not, so an absolute bound reports "not
    // retired" on a retire that worked perfectly — and Remove is then unreachable.
    const before = 100_000n * E18;
    const residue = 5n * E18; // 500x the absolute dust constant
    assert.ok(
      retireCleared(residue, before, 10n ** 16n),
      "the relative bound (before / 10 000) is what makes a large reserve clearable",
    );
  });

  it("a SMALL reserve still uses the absolute floor", () => {
    assert.ok(retireCleared(10n ** 16n, 1n * E18, 10n ** 16n));
    assert.ok(!retireCleared(10n ** 16n + 1n, 1n * E18, 10n ** 16n));
  });

  it("a genuinely unretired reserve does NOT clear", () => {
    assert.ok(!retireCleared(50_000n * E18, 100_000n * E18, 10n ** 16n));
  });
});

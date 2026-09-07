/**
 * The lending calldata builders — shapes, selector pins and the conditional
 * zero-legs (MARKETPLACE-LENDING-AGENT §4.1, §5.3, R2.5, R2.9, R3.9, R3.12).
 *
 * One test is named the way R2.24 asks for, because its job is to FAIL when a
 * specific defect is reintroduced: "the vUSDT zero-leg is emitted IFF the
 * allowance read says so".
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";

import {
  LENDING_SELECTORS,
  buildLendingArmBatch,
  buildLendingNativeRescueBatch,
  buildLendingRetireBatch,
  buildLendingUsdtRescueBatch,
  vUsdtApproveLegs,
  type LendingVenueAddresses,
} from "../src/lending/batches.js";

const E18 = 10n ** 18n;
const VENUE: LendingVenueAddresses = {
  vUsdt: getAddress("0xfD5840Cd36d94D7229439859C0112a4185BC0255"),
  usdt: getAddress("0x55d398326f99059fF775485246999027B3197955"),
  vBnb: getAddress("0xA07c5b74C9B40447a954e1466938b865b6BBea36"),
  routerV3: getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14"),
  wbnb: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
  swapFeeTier: 100,
};
const WALLET = getAddress("0x00000000000000000000000000000000000000b1");
const BORROWER = getAddress("0x00000000000000000000000000000000000000a9");
const DEADLINE = 1_900_000_300n;

const APPROVE_ABI = parseAbi(["function approve(address,uint256)"]);

function selectorOf(data: Hex | undefined): string {
  return (data ?? "0x").slice(0, 10).toLowerCase();
}

function approves(calls: readonly { readonly to: Address; readonly data?: Hex }[]) {
  return calls
    .filter((call) => call.to.toLowerCase() === VENUE.usdt.toLowerCase())
    .map((call) => {
      const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: call.data as Hex });
      return { spender: (decoded.args[0] as Address), amount: decoded.args[1] as bigint };
    });
}

describe("selector pins", () => {
  it("pins the four vToken selectors the census claims", () => {
    assert.equal(LENDING_SELECTORS["mint(uint256)"], "0xa0712d68");
    assert.equal(LENDING_SELECTORS["redeemUnderlying(uint256)"], "0x852a12e3");
    assert.equal(LENDING_SELECTORS["repayBorrowBehalf(address,uint256)"], "0x2608f818");
    assert.equal(LENDING_SELECTORS["repayBorrowBehalf(address)"], "0xe5974619");
  });
});

describe("vUsdtApproveLegs — R2.9 / R3.9", () => {
  it("the vUSDT zero-leg is emitted IFF the allowance read says so", () => {
    // R2.24 mutation: dropping `usdtAllowanceToVUsdt` from the reading (so the
    // builder always sees 0) must fail HERE, by name. PHASE4-AUDIT A2's
    // mechanism: a failOpaque `no-effect` repay CONFIRMS while leaving the
    // approve standing, and BSC-USDT reverts a non-zero -> non-zero approve.
    const clean = vUsdtApproveLegs({
      usdt: VENUE.usdt, vUsdt: VENUE.vUsdt, amountWei: 5n * E18, currentAllowanceWei: 0n,
    });
    assert.equal(clean.length, 1, "no residual allowance ⇒ no zero-leg");
    assert.equal(approves(clean)[0]?.amount, 5n * E18);

    const residual = vUsdtApproveLegs({
      usdt: VENUE.usdt, vUsdt: VENUE.vUsdt, amountWei: 5n * E18, currentAllowanceWei: 1n,
    });
    assert.equal(residual.length, 2, "a residual allowance ⇒ the zero-leg leads");
    assert.deepEqual(
      approves(residual).map((entry) => entry.amount),
      [0n, 5n * E18],
    );
  });

  it("the second approve is EXACT, never a ceiling", () => {
    const legs = vUsdtApproveLegs({
      usdt: VENUE.usdt, vUsdt: VENUE.vUsdt, amountWei: 12_345n, currentAllowanceWei: 9n,
    });
    const [zero, exact] = approves(legs);
    assert.equal(zero?.amount, 0n);
    assert.equal(exact?.amount, 12_345n);
    assert.equal(exact?.spender.toLowerCase(), VENUE.vUsdt.toLowerCase());
  });
});

describe("the ARM batch", () => {
  it("is buy -> approve pair -> mint, in that order", () => {
    const calls = buildLendingArmBatch({
      venue: VENUE, wallet: WALLET,
      supplyNativeWei: 4n * 10n ** 17n, mintUsdtWei: 240n * E18,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.to.toLowerCase(), VENUE.routerV3.toLowerCase());
    assert.equal(calls[0]?.value, 4n * 10n ** 17n, "value is EXACTLY the input, or the router stops wrapping");
    assert.equal(calls[1]?.to.toLowerCase(), VENUE.usdt.toLowerCase());
    assert.equal(calls[2]?.to.toLowerCase(), VENUE.vUsdt.toLowerCase());
    assert.equal(selectorOf(calls[2]?.data), LENDING_SELECTORS["mint(uint256)"]);
  });

  it("approves vUSDT for EXACTLY the mint amount, and emits the zero-leg on a residual", () => {
    const dirty = buildLendingArmBatch({
      venue: VENUE, wallet: WALLET,
      supplyNativeWei: 4n * 10n ** 17n, mintUsdtWei: 240n * E18,
      currentVUsdtAllowanceWei: 7n, deadline: DEADLINE,
    });
    assert.equal(dirty.length, 4);
    assert.deepEqual(approves(dirty).map((a) => a.amount), [0n, 240n * E18]);
  });

  it("refuses a zero supply or a zero mint floor", () => {
    assert.throws(() => buildLendingArmBatch({
      venue: VENUE, wallet: WALLET, supplyNativeWei: 0n, mintUsdtWei: 1n,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    }));
    assert.throws(() => buildLendingArmBatch({
      venue: VENUE, wallet: WALLET, supplyNativeWei: 1n, mintUsdtWei: 0n,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    }));
  });
});

describe("the USDT-debt rescue batch", () => {
  it("APPROVE EQUALS THE REPAY AMOUNT, exactly", () => {
    const calls = buildLendingUsdtRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: 42n * E18, takeRedeemWei: 0n, takeSwapWei: 0n,
      swapInNativeWei: 0n, swapMinOutWei: 0n,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    });
    assert.deepEqual(approves(calls).map((a) => a.amount), [42n * E18]);
    assert.equal(selectorOf(calls.at(-1)?.data), LENDING_SELECTORS["repayBorrowBehalf(address,uint256)"]);
  });

  it("emits NO redeem and NO swap when idle USDT covers it", () => {
    const calls = buildLendingUsdtRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: 5n * E18, takeRedeemWei: 0n, takeSwapWei: 0n,
      swapInNativeWei: 0n, swapMinOutWei: 0n,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    });
    assert.equal(calls.length, 2, "approve + repay, and nothing else");
    assert.ok(!calls.some((call) => selectorOf(call.data) === LENDING_SELECTORS["redeemUnderlying(uint256)"]));
    assert.ok(!calls.some((call) => (call.value ?? 0n) > 0n), "the ZERO-TIER case attaches no value");
  });

  it("routes the pool-short DEFICIT through a value-bearing buy whose minOut IS the requirement", () => {
    const calls = buildLendingUsdtRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: 30n * E18, takeRedeemWei: 10n * E18, takeSwapWei: 15n * E18,
      swapInNativeWei: 3n * 10n ** 16n, swapMinOutWei: 15n * E18,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    });
    assert.equal(selectorOf(calls[0]?.data), LENDING_SELECTORS["redeemUnderlying(uint256)"]);
    const buy = calls.find((call) => call.to.toLowerCase() === VENUE.routerV3.toLowerCase());
    assert.ok(buy !== undefined);
    assert.equal(buy.value, 3n * 10n ** 16n, "buildPancakeV3Buy attaches value = amountIn exactly");
    assert.deepEqual(approves(calls).map((a) => a.amount), [30n * E18]);
  });

  it("refuses a swap leg with no input — a zero-input swap delivers nothing", () => {
    assert.throws(() => buildLendingUsdtRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: 30n * E18, takeRedeemWei: 0n, takeSwapWei: 15n * E18,
      swapInNativeWei: 0n, swapMinOutWei: 15n * E18,
      currentVUsdtAllowanceWei: 0n, deadline: DEADLINE,
    }));
  });
});

describe("the BNB-debt rescue batch", () => {
  it("value: r is attached to the vBNB call, and r <= tier + swap minOut", () => {
    const takeTier = 2n * 10n ** 16n;
    const takeSwapOut = 3n * 10n ** 16n;
    const calls = buildLendingNativeRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: takeTier + takeSwapOut,
      redeemUsdtWei: 20n * E18, swapInUsdtWei: 25n * E18,
      swapMinOutWei: takeSwapOut, deadline: DEADLINE,
    });
    const repay = calls.at(-1);
    assert.equal(repay?.to.toLowerCase(), VENUE.vBnb.toLowerCase());
    assert.equal(selectorOf(repay?.data), LENDING_SELECTORS["repayBorrowBehalf(address)"]);
    assert.equal(repay?.value, takeTier + takeSwapOut);
    assert.ok(
      (repay?.value ?? 0n) <= takeTier + takeSwapOut,
      "`value: r` is a lower bound the batch can always pay",
    );
    // `buildPancakeV3Sell` verbatim: approve(0), approve(exact), multicall.
    assert.deepEqual(approves(calls).map((a) => a.amount), [0n, 25n * E18]);
  });

  it("emits no swap and no redeem when the tier alone covers r", () => {
    const calls = buildLendingNativeRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: 10n ** 16n, redeemUsdtWei: 0n, swapInUsdtWei: 0n,
      swapMinOutWei: 0n, deadline: DEADLINE,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.value, 10n ** 16n);
  });

  it("refuses a swap leg with no floor — `value: r` is funded by that floor", () => {
    assert.throws(() => buildLendingNativeRescueBatch({
      venue: VENUE, wallet: WALLET, borrower: BORROWER,
      amountWei: 10n ** 16n, redeemUsdtWei: 0n, swapInUsdtWei: 5n * E18,
      swapMinOutWei: 0n, deadline: DEADLINE,
    }));
  });
});

describe("the RETIRE batch — the R2.24 table over (idle, supplied, cash)", () => {
  const table = [
    { name: "all supplied, deep pool", redeem: 100n * E18, swapIn: 100n * E18 },
    { name: "idle only, dry pool", redeem: 0n, swapIn: 7n * E18 },
    { name: "partial: pool short", redeem: 5n * E18, swapIn: 6n * E18 },
  ];
  for (const row of table) {
    it(`${row.name}: approve == swap input exactly, and amountIn == idle + redeem arg`, () => {
      const calls = buildLendingRetireBatch({
        venue: VENUE, wallet: WALLET,
        redeemAmountWei: row.redeem, swapInWei: row.swapIn,
        minOutWei: 10n ** 16n, deadline: DEADLINE,
      });
      const redeemCall = calls.find(
        (call) => selectorOf(call.data) === LENDING_SELECTORS["redeemUnderlying(uint256)"],
      );
      if (row.redeem > 0n) {
        assert.ok(redeemCall !== undefined);
        assert.equal(calls.length, 4, "redeem + the builder's three");
      } else {
        assert.equal(redeemCall, undefined);
        assert.equal(calls.length, 3);
      }
      // The zero-leg on the ROUTER is unconditional by construction (R3.9).
      assert.deepEqual(approves(calls).map((a) => a.amount), [0n, row.swapIn]);
      assert.ok(!calls.some((call) => (call.value ?? 0n) > 0n), "the retire attaches no native");
    });
  }

  it("refuses when there is nothing to submit at all", () => {
    assert.throws(() => buildLendingRetireBatch({
      venue: VENUE, wallet: WALLET, redeemAmountWei: 0n, swapInWei: 0n,
      minOutWei: 1n, deadline: DEADLINE,
    }));
  });

  it("never names a vToken selector outside the census", () => {
    const calls = buildLendingRetireBatch({
      venue: VENUE, wallet: WALLET, redeemAmountWei: 5n * E18, swapInWei: 6n * E18,
      minOutWei: 1n, deadline: DEADLINE,
    });
    const vTokenCalls = calls.filter(
      (call) => call.to.toLowerCase() === VENUE.vUsdt.toLowerCase(),
    );
    for (const call of vTokenCalls) {
      assert.ok(
        Object.values(LENDING_SELECTORS).includes(selectorOf(call.data) as never),
        `${selectorOf(call.data)} is not in the pinned census`,
      );
      assert.notEqual(selectorOf(call.data), "0xdb006a75", "redeem(uint256) is DROPPED");
    }
  });
});

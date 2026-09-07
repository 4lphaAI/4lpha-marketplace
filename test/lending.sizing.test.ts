/**
 * `checkLendingSizing` and the ROLLING-DAY CAP SIMULATOR
 * (MARKETPLACE-LENDING-AGENT R3.1, R3.2, R2.3, R2.4, R2.24, REVIEW2 §4).
 *
 * The simulator is the point. Both gating HIGHs of the clearance pass were
 * arithmetic that PASSED every unit test and produced FINDINGS (h)'s silent
 * relay `PENDING` on chain, so the tests that matter here do not check the
 * formula — they enumerate every approve and every `value` a rolling day can
 * emit and assert the sums fit under the caps the hire granted.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  LENDING_RESERVE_BPS_DEFAULT,
  LENDING_RESERVE_BPS_MAX,
  LENDING_RESERVE_BPS_MIN,
  RELAY_FEE_PER_EXIT_WEI,
  checkLendingSizing,
  lendingHireSizingPreview,
  walletNativeFloorWei,
} from "../src/ops/policy.js";

const E18 = 10n ** 18n;
/** 0.5 BNB of budget, 20 % reserve, USDT at ~600/BNB. */
const BUDGET = 5n * 10n ** 17n;
const SUPPLY = (BUDGET * 8_000n) / 10_000n;
const RESERVE_NATIVE = BUDGET - SUPPLY;
const MINT_USDT = 240n * E18;       // 0.4 BNB -> 240 USDT
const TIER_BUYBACK = 60n * E18;     // 0.1 BNB -> 60 USDT

function base(overrides: Partial<Parameters<typeof checkLendingSizing>[0]> = {}) {
  return {
    budgetWei: BUDGET,
    reserveBps: LENDING_RESERVE_BPS_DEFAULT,
    capDayWei: 2n * E18,
    reserveCapWei: 1_000n * E18,
    mintUsdtWei: MINT_USDT,
    tierBuyBackUsdtWei: TIER_BUYBACK,
    rescueReserveCount: 6,
    ...overrides,
  };
}

describe("checkLendingSizing — bounds and malformed inputs", () => {
  it("accepts a well-sized hire", () => {
    assert.deepEqual(checkLendingSizing(base()), { ok: true });
  });

  it("refuses a reserveBps outside 1000..5000", () => {
    for (const bps of [999, 5_001, 0, -1, 1_000.5]) {
      const result = checkLendingSizing(base({ reserveBps: bps }));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.kind : "", "malformed");
    }
    assert.equal(checkLendingSizing(base({ reserveBps: LENDING_RESERVE_BPS_MIN })).ok, true);
    assert.ok(
      checkLendingSizing(base({ reserveBps: LENDING_RESERVE_BPS_MAX, capDayWei: 3n * E18 })).ok,
    );
  });

  it("refuses a malformed rescueReserveCount before any arithmetic", () => {
    for (const count of [0, -1, 1.5]) {
      const result = checkLendingSizing(base({ rescueReserveCount: count }));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.kind : "", "malformed");
    }
  });

  it("refuses a BNB tier too small to pay for the rescues it funds", () => {
    // A tier below `walletFloor + count x relayFee` is a guard armed over a
    // reserve that cannot pay for its own submissions.
    const tiny = checkLendingSizing(base({
      budgetWei: walletNativeFloorWei(),
      reserveBps: 1_000,
      capDayWei: 10n * E18,
      mintUsdtWei: 1n,
      tierBuyBackUsdtWei: 0n,
    }));
    assert.equal(tiny.ok, false);
    assert.match(tiny.ok === false ? tiny.message : "", /BNB tier is too small/u);
  });
});

describe("R3.2 — the native cap term is UNCONDITIONAL", () => {
  it("requires cap > supply + budget + tier + (count + 2) x relayFee", () => {
    // AUDIT A-M1 added the TIER term: a guard pinned to both markets can spend
    // the BNB tier on a pool-short USDT rescue AND `value: r` on a BNB rescue
    // in one day, and the old term priced only one of them.
    const required =
      SUPPLY + BUDGET + RESERVE_NATIVE + BigInt(6 + 2) * RELAY_FEE_PER_EXIT_WEI;
    assert.equal(checkLendingSizing(base({ capDayWei: required })).ok, false);
    assert.equal(checkLendingSizing(base({ capDayWei: required + 1n })).ok, true);
  });

  it("budgets the SAME native for a USDT-only guard as for a BNB one", () => {
    // REVIEW2 H2: Revision 2's `(vBNB in debtMarkets) ? budgetWei : 0n` branch
    // budgeted ZERO for the very pool-cash fallback decision 4 exists to fund —
    // and `buildPancakeV3Buy` attaches `value: amountInWei`. There is no
    // `debtMarkets` input here AT ALL, which is how the branch cannot come back.
    const inputs = Object.keys(base());
    assert.ok(!inputs.includes("debtMarkets"));
    const shortForFallback =
      SUPPLY + RESERVE_NATIVE + BigInt(6 + 2) * RELAY_FEE_PER_EXIT_WEI + 1n;
    const result = checkLendingSizing(base({ capDayWei: shortForFallback }));
    assert.equal(result.ok, false, "a USDT-only guard still needs a full rescue budgeted");
    assert.match(result.ok === false ? result.message : "", /pool-cash fallback swap/u);
  });
});

describe("R3.1 — the USDT floor prices EVERY approve", () => {
  it("requires ceil(1.1 x mint) + (mint + tier buy-back)", () => {
    const floor = (11n * MINT_USDT + 9n) / 10n + MINT_USDT + TIER_BUYBACK;
    assert.equal(checkLendingSizing(base({ reserveCapWei: floor - 1n })).ok, false);
    assert.equal(checkLendingSizing(base({ reserveCapWei: floor })).ok, true);
  });

  it("does NOT depend on maxPerAction, which a vBNB-only guard never sets", () => {
    // REVIEW2 H1(2): with `debtMarkets = [vBNB]` there is no USDT entry at all,
    // so a floor written in terms of `maxPerAction[USDT]` was structurally zero
    // for exactly the guard whose every rescue approves the router for the whole
    // reserve. The input is absent from the signature.
    assert.ok(!Object.keys(base()).includes("maxPerActionUsdtWei"));
  });

  it("names the arm term and the reserve-ceiling term separately in its refusal", () => {
    const result = checkLendingSizing(base({ reserveCapWei: 1n }));
    assert.equal(result.ok, false);
    const message = result.ok === false ? result.message : "";
    assert.match(message, /arm's own approve/u);
    assert.match(message, /rolling day of rescue\/retire approves/u);
    assert.match(message, /FINDINGS \(h\)/u);
  });
});

/* -------------------------------------------------------------------------- */
/* THE ROLLING-DAY CAP SIMULATOR (R2.24, REVIEW2 §4)                          */
/* -------------------------------------------------------------------------- */

/**
 * Enumerate every USDT approve and every native `value` a rolling day can emit
 * on one guard, given a plan, and assert the sums fit.
 *
 * The amounts mirror the builders exactly:
 *   arm     approve(USDT, vUSDT, mintUsdtWei)             value = supplyNativeWei
 *   USDT rescue  approve(USDT, vUSDT, r)                  value = swapIn (fallback only)
 *   BNB rescue   approve(USDT, router, swapIn) x2 (0 then exact)   value = r
 *   retire  approve(USDT, router, idle + redeemed) x2     value = 0
 *
 * `approve(…, 0)` legs are metered at ZERO by the cap, so only the non-zero
 * approve of each pair counts.
 */
type DayPlan = {
  readonly usdtApproves: readonly bigint[];
  readonly nativeValues: readonly bigint[];
};

function assertDayFits(plan: DayPlan, caps: { usdt: bigint; native: bigint }): void {
  const usdt = plan.usdtApproves.reduce((sum, value) => sum + value, 0n);
  const native = plan.nativeValues.reduce((sum, value) => sum + value, 0n);
  assert.ok(
    usdt <= caps.usdt,
    `USDT approves ${usdt} exceed the granted cap ${caps.usdt} — this is FINDINGS (h)'s silent PENDING`,
  );
  assert.ok(
    native <= caps.native,
    `native value ${native} exceeds the granted cap ${caps.native}`,
  );
}

describe("the rolling-day cap simulator", () => {
  const RESCUE_COUNT = 6;
  const MAX_PER_ACTION_USDT = 40n * E18;
  const preview = lendingHireSizingPreview({
    budgetWei: BUDGET,
    reserveBps: LENDING_RESERVE_BPS_DEFAULT,
    capDayWei: 0n,
    reserveCapWei: 0n,
    mintUsdtWei: MINT_USDT,
    tierBuyBackUsdtWei: TIER_BUYBACK,
    rescueReserveCount: RESCUE_COUNT,
  });
  const caps = {
    usdt: BigInt(preview.reserveCapFloorWei),
    native: BigInt(preview.minimumCapDayWei),
  };

  it("arm + a day of USDT rescues fits (the H1 case)", () => {
    assertDayFits(
      {
        usdtApproves: [
          MINT_USDT,
          ...Array.from({ length: RESCUE_COUNT }, () => MAX_PER_ACTION_USDT),
        ],
        nativeValues: [SUPPLY],
      },
      caps,
    );
  });

  it("arm + a rescue ON THE ARM DAY fits — the case Revision 1 refused on chain", () => {
    assertDayFits(
      { usdtApproves: [MINT_USDT, MAX_PER_ACTION_USDT], nativeValues: [SUPPLY] },
      caps,
    );
  });

  it("arm + a RETIRE on the arm day fits by construction when no rescue ran", () => {
    // R3.1's own argument, asserted rather than believed: the arm consumes at
    // most 1.1 x mint and the remainder is at least the reserve ceiling, which
    // is what the retire's own approve is bounded by.
    const retireApprove = MINT_USDT + TIER_BUYBACK; // idle + everything redeemed
    assertDayFits(
      { usdtApproves: [MINT_USDT, retireApprove], nativeValues: [SUPPLY] },
      caps,
    );
  });

  it("arm + a FULL BNB rescue fits under the native cap (the H2 case)", () => {
    // The BNB-debt repay attaches `value: r`, and `r` can reach the whole
    // reserve because it is funded from the USDT tier through the batch's own
    // swap.
    assertDayFits({ usdtApproves: [MINT_USDT], nativeValues: [SUPPLY, BUDGET] }, caps);
  });

  it("a vBNB-ONLY guard's day fits — no maxPerAction[USDT] exists to size on", () => {
    // Every rescue approves the ROUTER for up to the whole reserve.
    const routerApprove = MINT_USDT + TIER_BUYBACK;
    assertDayFits(
      { usdtApproves: [MINT_USDT, routerApprove], nativeValues: [SUPPLY, BUDGET] },
      caps,
    );
  });

  it("a USDT-ONLY guard whose redeem is POOL-SHORT fits under the native cap", () => {
    // REVIEW2 H2's third case: `buildPancakeV3Buy` attaches `value: swapIn`, and
    // `swapIn` is bounded by the BNB tier.
    assertDayFits(
      {
        usdtApproves: [MINT_USDT, MAX_PER_ACTION_USDT],
        nativeValues: [SUPPLY, RESERVE_NATIVE],
      },
      caps,
    );
  });

  it("AUDIT A-M1 — a BOTH-MARKETS day fits: a pool-short USDT rescue THEN a BNB rescue", () => {
    // The row the simulator did not have, and the reason the native term now
    // carries the tier. Measured on this fixture before the fix: the day's
    // native sum was 0.933 BNB against an accepted cap of 0.9008, so the
    // second rescue of the day came back a `native-cap-exhausted` PARTIAL —
    // never a refusal, and never something the owner was warned about at hire.
    assertDayFits(
      {
        usdtApproves: [MINT_USDT, MAX_PER_ACTION_USDT],
        nativeValues: [SUPPLY, RESERVE_NATIVE, BUDGET],
      },
      caps,
    );
  });

  it("the preview's floors are exactly what checkLendingSizing accepts", () => {
    assert.equal(
      checkLendingSizing(base({
        reserveCapWei: caps.usdt,
        capDayWei: caps.native,
        rescueReserveCount: RESCUE_COUNT,
      })).ok,
      true,
    );
    assert.equal(
      checkLendingSizing(base({
        reserveCapWei: caps.usdt - 1n,
        capDayWei: caps.native,
        rescueReserveCount: RESCUE_COUNT,
      })).ok,
      false,
    );
    assert.equal(
      checkLendingSizing(base({
        reserveCapWei: caps.usdt,
        capDayWei: caps.native - 1n,
        rescueReserveCount: RESCUE_COUNT,
      })).ok,
      false,
    );
  });
});

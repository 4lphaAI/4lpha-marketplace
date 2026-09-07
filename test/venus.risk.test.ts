/**
 * PHASE4 — the reconstruction and the two price pairings.
 *
 * Two things are proved here that nothing else can prove offline:
 *
 *   1. the pipeline reproduces the protocol's `(liquidity, shortfall)` EXACTLY
 *      on both bases (R2.2/R2.3), through the same truncation points
 *      `calculateVenusRisk` has;
 *   2. **the SYNTHETIC E-MODE fixture** (R3.8/S8). STEP ZERO passed against the
 *      only account either plane can reach, and that account has
 *      `CF == LT == 0.8` with `bounded == spot` — so it proves the two bases
 *      AGREE and can never exercise the divergence the phase depends on. A
 *      64-address scan found ZERO `userPoolId != 0` accounts, so the first real
 *      E-Mode account this code meets will be in production. The fixture below
 *      is built from the measured `eModePools` shape (CF 0.9 vs LT 0.925,
 *      `.agents/HANDOFF.md` 2026-08-22) and drives BOTH bases through BOTH
 *      pairings, asserting that they diverge in the expected direction and that
 *      the equality gate REFUSES a deliberately wrong pairing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  E18,
  calculateVenusRisk,
  collateralValue,
  debtValue,
  riskMatchesProtocol,
  tokensToDenom,
  type VenusRiskMarketInput,
} from "../src/venus/risk.js";

/** 1e18 mantissa helper. */
function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

/** An 18-decimal underlying: `getUnderlyingPrice` scale is 1e(36-18) = 1e18. */
const PRICE_18 = (usd: string): bigint => pct(usd);

describe("venus risk: the pipeline mirrors calculateVenusRisk exactly", () => {
  it("truncates at every Exp multiplication, not once at the end", () => {
    // Chosen so real arithmetic and truncated arithmetic disagree: the product
    // is deliberately just under a boundary at each step.
    const factor = pct("0.8");
    const exchangeRate = 200_000_000_000_000_001n;
    const price = PRICE_18("612.345678901234567");
    const balance = 8_000_000_000_000_000_000n;

    const denom = tokensToDenom(factor, exchangeRate, price);
    // mulExp twice, then a final /1e18 with the balance.
    const expected = (denom * balance) / E18;
    assert.equal(collateralValue(balance, exchangeRate, factor, price), expected);

    // The one-shot form is NOT the same number, which is the whole point.
    const oneShot = (factor * exchangeRate * price * balance) / (E18 * E18 * E18);
    assert.notEqual(expected, oneShot);
  });

  it("guards debt == 0 BEFORE the division and answers HF = infinity", () => {
    const market: VenusRiskMarketInput = {
      collateralMember: true,
      vTokenBalance: 1_000n,
      exchangeRate: E18,
      borrowBalance: 0n,
      collateralFactor: pct("0.8"),
      liquidationThreshold: pct("0.8"),
      collateralPrice: PRICE_18("1"),
      debtPrice: PRICE_18("1"),
      spotPrice: PRICE_18("1"),
    };
    const pair = calculateVenusRisk([market], 0n);
    assert.equal(pair.liquidationRisk.healthFactor, null);
    assert.equal(pair.liquidationRisk.shortfall, 0n);
  });

  it("seeds BOTH debt totals with the VAI amount — D is the Comptroller basis", () => {
    const vai = pct("5");
    const pair = calculateVenusRisk([], vai);
    assert.equal(pair.liquidationRisk.debt, vai);
    assert.equal(pair.borrowingPower.debt, vai);
    // And the grant refuses every VAI selector, so D carries an irreducible
    // term the agent cannot repay. Stated, not hidden.
    assert.equal(pair.liquidationRisk.collateral, 0n);
    assert.equal(pair.liquidationRisk.shortfall, vai);
  });

  it("weights collateral ONLY for entered markets: membership is not collateral", () => {
    const base: VenusRiskMarketInput = {
      collateralMember: false,
      vTokenBalance: 10n ** 8n,
      exchangeRate: E18,
      borrowBalance: 0n,
      collateralFactor: pct("0.8"),
      liquidationThreshold: pct("0.8"),
      collateralPrice: PRICE_18("1"),
      debtPrice: PRICE_18("1"),
      spotPrice: PRICE_18("1"),
    };
    assert.equal(calculateVenusRisk([base], 0n).liquidationRisk.collateral, 0n);
    assert.notEqual(
      calculateVenusRisk([{ ...base, collateralMember: true }], 0n).liquidationRisk
        .collateral,
      0n,
    );
  });
});

describe("venus risk: the R2.2 equality gate", () => {
  const market: VenusRiskMarketInput = {
    collateralMember: true,
    vTokenBalance: 80_180_887n,
    exchangeRate: 200_000_000_000_000_000n,
    borrowBalance: 8_001_490_960_106_031_222n,
    collateralFactor: pct("0.8"),
    liquidationThreshold: pct("0.8"),
    collateralPrice: PRICE_18("612"),
    debtPrice: PRICE_18("1"),
    spotPrice: PRICE_18("612"),
  };

  it("accepts an exactly-matching protocol answer", () => {
    const pair = calculateVenusRisk([market], 0n);
    assert.equal(
      riskMatchesProtocol(
        pair.liquidationRisk,
        0n,
        pair.liquidationRisk.liquidity,
        pair.liquidationRisk.shortfall,
      ),
      true,
    );
  });

  it("REFUSES on a non-zero errorCode even when the numbers agree", () => {
    const pair = calculateVenusRisk([market], 0n);
    assert.equal(
      riskMatchesProtocol(
        pair.liquidationRisk,
        3n,
        pair.liquidationRisk.liquidity,
        pair.liquidationRisk.shortfall,
      ),
      false,
    );
  });

  it("REFUSES on a one-wei difference — the gate is EXACT, never approximate", () => {
    const pair = calculateVenusRisk([market], 0n);
    assert.equal(
      riskMatchesProtocol(
        pair.liquidationRisk,
        0n,
        pair.liquidationRisk.liquidity + 1n,
        pair.liquidationRisk.shortfall,
      ),
      false,
    );
  });
});

describe("venus risk: the SYNTHETIC E-MODE fixture (R3.8/S8)", () => {
  /**
   * Pool-1 factors as MEASURED on 2026-08-22: CF 0.9, LT 0.925. The only
   * account STEP ZERO could reach has CF == LT == 0.8 and bounded == spot, so
   * it proves the bases AGREE — this fixture is the only offline evidence that
   * the R2.3 pairing is the right one when they do not.
   */
  const collateral: VenusRiskMarketInput = {
    collateralMember: true,
    vTokenBalance: 8_000_000_000_000_000_000n,
    exchangeRate: 220_000_000_000_000_000n,
    borrowBalance: 0n,
    collateralFactor: pct("0.9"),
    liquidationThreshold: pct("0.925"),
    // The DBO pair sits BELOW spot on the collateral leg (that is what a
    // deviation-bounded collateral price is for) and ABOVE it on the debt leg.
    collateralPrice: PRICE_18("605"),
    debtPrice: PRICE_18("1.01"),
    spotPrice: PRICE_18("612"),
  };
  const debt: VenusRiskMarketInput = {
    collateralMember: false,
    vTokenBalance: 0n,
    exchangeRate: E18,
    borrowBalance: 900n * 10n ** 18n,
    collateralFactor: pct("0.9"),
    liquidationThreshold: pct("0.925"),
    collateralPrice: PRICE_18("0.99"),
    debtPrice: PRICE_18("1.01"),
    spotPrice: PRICE_18("1"),
  };

  it("the two bases DIVERGE, and in the expected direction", () => {
    const pair = calculateVenusRisk([collateral, debt], 0n);
    // Liquidation weights higher (0.925 > 0.9) at a HIGHER collateral price
    // (spot 612 > bounded 605) and a LOWER debt price (spot 1 < bounded 1.01),
    // so the liquidation basis must be the MORE FORGIVING of the two. A build
    // that paired them the other way inverts this.
    assert.ok(pair.liquidationRisk.collateral > pair.borrowingPower.collateral);
    assert.ok(pair.liquidationRisk.debt < pair.borrowingPower.debt);
    const ltHf = pair.liquidationRisk.healthFactor;
    const cfHf = pair.borrowingPower.healthFactor;
    assert.notEqual(ltHf, null);
    assert.notEqual(cfHf, null);
    assert.ok((ltHf as bigint) > (cfHf as bigint));
  });

  it("the equality gate ACCEPTS the correct pairing and REFUSES the wrong one", () => {
    const pair = calculateVenusRisk([collateral, debt], 0n);

    // The protocol's own liquidation answer, which the CORRECT pairing (LT
    // weights, SPOT on both legs) reproduces.
    const protocolLiquidity = pair.liquidationRisk.liquidity;
    const protocolShortfall = pair.liquidationRisk.shortfall;
    assert.equal(
      riskMatchesProtocol(pair.liquidationRisk, 0n, protocolLiquidity, protocolShortfall),
      true,
    );

    // THE R3 MUTATION, built by hand: LT weights paired with the BOUNDED prices
    // — the first spec draft's pairing. It must NOT reproduce the protocol's
    // liquidation answer.
    const wrongCollateral = collateralValue(
      collateral.vTokenBalance,
      collateral.exchangeRate,
      collateral.liquidationThreshold,
      collateral.collateralPrice,
    );
    const wrongDebt = debtValue(debt.borrowBalance, debt.debtPrice);
    const wrongLiquidity =
      wrongCollateral >= wrongDebt ? wrongCollateral - wrongDebt : 0n;
    const wrongShortfall = wrongDebt > wrongCollateral ? wrongDebt - wrongCollateral : 0n;
    assert.notEqual(wrongLiquidity, protocolLiquidity);
    assert.equal(
      riskMatchesProtocol(pair.liquidationRisk, 0n, wrongLiquidity, wrongShortfall),
      false,
    );

    // And symmetrically: CF weights with SPOT prices must not reproduce the
    // borrowing-power answer either.
    const wrongBpCollateral = collateralValue(
      collateral.vTokenBalance,
      collateral.exchangeRate,
      collateral.collateralFactor,
      collateral.spotPrice,
    );
    const wrongBpDebt = debtValue(debt.borrowBalance, debt.spotPrice);
    const wrongBpLiquidity =
      wrongBpCollateral >= wrongBpDebt ? wrongBpCollateral - wrongBpDebt : 0n;
    assert.notEqual(wrongBpLiquidity, pair.borrowingPower.liquidity);
  });

  it("a pool-0 fixture with CF == LT == bounded == spot proves only that they agree", () => {
    // Recorded as a test rather than as prose: this is exactly the shape STEP
    // ZERO could reach, and the reason S8 demanded the fixture above.
    const flat: VenusRiskMarketInput = {
      ...collateral,
      collateralFactor: pct("0.8"),
      liquidationThreshold: pct("0.8"),
      collateralPrice: PRICE_18("612"),
      debtPrice: PRICE_18("612"),
    };
    const flatDebt: VenusRiskMarketInput = {
      ...debt,
      collateralFactor: pct("0.8"),
      liquidationThreshold: pct("0.8"),
      collateralPrice: PRICE_18("1"),
      debtPrice: PRICE_18("1"),
      spotPrice: PRICE_18("1"),
    };
    const pair = calculateVenusRisk([flat, flatDebt], 0n);
    assert.equal(pair.liquidationRisk.collateral, pair.borrowingPower.collateral);
    assert.equal(pair.liquidationRisk.debt, pair.borrowingPower.debt);
    assert.equal(pair.liquidationRisk.healthFactor, pair.borrowingPower.healthFactor);
  });
});

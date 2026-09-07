/**
 * Venus risk reconstruction — the pure layer PHASE4-SPEC R2.2/R2.3 makes the
 * trigger authority, and the thing STEP ZERO (R2.16/R30) had to prove against
 * the deployed Comptroller before any store was written.
 *
 * ─── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
 *
 * No Venus call returns a health factor. `getAccountLiquidity` returns
 * `(errorCode, W−D, D−W)` — a DIFFERENCE — and `getBorrowingPower` returns the
 * same shape on the other weighting. So HF is a 4lpha-computed quantity, and
 * the strongest available claim (R2.2, and "byte-for-byte" is DELETED) is:
 *
 *   HF is reconstructed locally and CROSS-CHECKED, per account per block,
 *   against the protocol's own difference. A mismatch is `protocol-mismatch`
 *   and fails closed — never a smaller number.
 *
 * ─── THE TWO BASES AND THEIR PRICE PAIRINGS (R2.3, corrected) ──────────────
 *
 * The first spec draft paired LT weights with bounded prices. The DEPLOYED
 * protocol pairs them the other way, and the data plane's `calculateVenusRisk`
 * (`D:\4lphaDATA-marketplace\src\query\venusRisk.ts:70-84`) is the mirror both
 * live reads returned `matched: true` under:
 *
 *   borrowing-power basis  = CF weights + boundedCollateral / boundedDebt
 *   liquidation basis      = LT weights + SPOT on BOTH legs
 *
 * "Conservative" is not a per-leg choice; it is fidelity to whichever protocol
 * weighting is being reproduced. `triggerHf`/`targetHf` are thresholds on the
 * LIQUIDATION basis and sizing targets that basis (R3.11/S11); the
 * borrowing-power instantiation exists for the equality cross-check and the
 * owner view.
 *
 * ─── TRUNCATION IS THE POINT ───────────────────────────────────────────────
 *
 * `mulExp` mirrors Solidity's `ExponentialNoError.mul_`, and every truncation
 * point is reproduced where the protocol has one. A form that is correct in ℝ
 * is off by base units in ℤ, and the direction of that error is the difference
 * between reaching `targetHf` and missing it (PHASE4-REVIEW R4).
 *
 * ─── STORED vs CURRENT (R2.12, and the S14 transfer sentence) ──────────────
 *
 * The equality proof runs on the STORED basis, because that is what the
 * protocol's own call answers. It TRANSFERS to the CURRENT sizing basis
 * because both use the identical effective-factor set and the identical R2.3
 * price pairing — CURRENT substitutes only fresher balances into a pipeline
 * the proof just validated. The two differ by accrued interest, and nothing
 * here pretends otherwise.
 *
 * `D` is the COMPTROLLER basis INCLUDING VAI debt: `calculateVenusRisk` seeds
 * both debt totals with `vaiRepayAmount`, and the Phase 4 grant refuses every
 * VAI selector — so `D` carries an irreducible term the agent cannot repay.
 * Survivable because the repay clamp `min(…, borrowCurrent)` never targets it,
 * and stated here so a reader does not mistake `D` for "the debt I can act on".
 */

export const E18 = 10n ** 18n;

/** One market's inputs, raw exactly as the Venus contracts return them. */
export interface VenusRiskMarketInput {
  readonly collateralMember: boolean;
  readonly vTokenBalance: bigint;
  readonly exchangeRate: bigint;
  readonly borrowBalance: bigint;
  /** `getEffectiveLtvFactor(owner, vToken, 0)` — E-Mode aware. */
  readonly collateralFactor: bigint;
  /** `getEffectiveLtvFactor(owner, vToken, 1)` — E-Mode aware. */
  readonly liquidationThreshold: bigint;
  /** `getBoundedPricesView(vToken)[0]`. */
  readonly collateralPrice: bigint;
  /** `getBoundedPricesView(vToken)[1]`. */
  readonly debtPrice: bigint;
  /** `oracle.getUnderlyingPrice(vToken)`. */
  readonly spotPrice: bigint;
}

/** One basis's reconstructed totals. `healthFactor === null` means D == 0. */
export interface VenusRiskResult {
  readonly collateral: bigint;
  readonly debt: bigint;
  readonly liquidity: bigint;
  readonly shortfall: bigint;
  readonly healthFactor: bigint | null;
}

export interface VenusRiskPair {
  readonly borrowingPower: VenusRiskResult;
  readonly liquidationRisk: VenusRiskResult;
}

/** The two protocol weightings, named so a caller cannot pass the wrong one. */
export type VenusRiskBasis = "liquidation" | "borrowingPower";

/** Mirrors `ExponentialNoError.mul_`: truncates at every Exp multiplication. */
export function mulExp(left: bigint, right: bigint): bigint {
  return (left * right) / E18;
}

/**
 * `tokensToDenom` — the per-vToken-unit collateral value the protocol weights
 * a balance by. Exposed because R2.4's SUPPLY sizing divides by it and the
 * recompute multiplies back through it; one definition, two callers.
 */
export function tokensToDenom(factor: bigint, exchangeRate: bigint, price: bigint): bigint {
  return mulExp(mulExp(factor, exchangeRate), price);
}

export function collateralValue(
  balance: bigint,
  exchangeRate: bigint,
  factor: bigint,
  price: bigint,
): bigint {
  return (tokensToDenom(factor, exchangeRate, price) * balance) / E18;
}

export function debtValue(balance: bigint, price: bigint): bigint {
  return (price * balance) / E18;
}

function result(collateral: bigint, debt: bigint): VenusRiskResult {
  const difference = collateral >= debt ? collateral - debt : debt - collateral;
  return {
    collateral,
    debt,
    liquidity: collateral >= debt ? difference : 0n,
    shortfall: debt > collateral ? difference : 0n,
    // The zero check comes FIRST and is not a guard around a division that was
    // already written: `debt === 0` is HF = ∞ = healthy (PHASE4-SPEC D2).
    healthFactor: debt === 0n ? null : (collateral * E18) / debt,
  };
}

/**
 * Reconstructs BOTH Core Comptroller weighting strategies from one coherent
 * per-market read set. `vaiRepayAmount` is already 1e18-denominated and is
 * debt on both bases.
 */
export function calculateVenusRisk(
  markets: readonly VenusRiskMarketInput[],
  vaiRepayAmount: bigint,
): VenusRiskPair {
  let cfCollateral = 0n;
  let cfDebt = vaiRepayAmount;
  let ltCollateral = 0n;
  let ltDebt = vaiRepayAmount;

  for (const market of markets) {
    if (market.collateralMember) {
      cfCollateral += collateralValue(
        market.vTokenBalance,
        market.exchangeRate,
        market.collateralFactor,
        market.collateralPrice,
      );
      ltCollateral += collateralValue(
        market.vTokenBalance,
        market.exchangeRate,
        market.liquidationThreshold,
        market.spotPrice,
      );
    }
    cfDebt += debtValue(market.borrowBalance, market.debtPrice);
    ltDebt += debtValue(market.borrowBalance, market.spotPrice);
  }

  return {
    borrowingPower: result(cfCollateral, cfDebt),
    liquidationRisk: result(ltCollateral, ltDebt),
  };
}

/**
 * The R2.2 cross-check. EXACT equality on both halves plus `errorCode == 0`;
 * anything else is `protocol-mismatch` at the caller. Mirrors the data plane's
 * `riskMatchesProtocol` (`src/query/venusRisk.ts:104`).
 */
export function riskMatchesProtocol(
  risk: VenusRiskResult,
  errorCode: bigint,
  liquidity: bigint,
  shortfall: bigint,
): boolean {
  return errorCode === 0n && risk.liquidity === liquidity && risk.shortfall === shortfall;
}

/** Selects a basis's weighting inputs — the one place the pairing is chosen. */
export function basisFactor(basis: VenusRiskBasis, market: VenusRiskMarketInput): bigint {
  return basis === "liquidation" ? market.liquidationThreshold : market.collateralFactor;
}

/** Collateral-leg price for a basis (R2.3: LT↔spot, CF↔boundedCollateral). */
export function basisCollateralPrice(basis: VenusRiskBasis, market: VenusRiskMarketInput): bigint {
  return basis === "liquidation" ? market.spotPrice : market.collateralPrice;
}

/** Debt-leg price for a basis (R2.3: LT↔spot, CF↔boundedDebt). */
export function basisDebtPrice(basis: VenusRiskBasis, market: VenusRiskMarketInput): bigint {
  return basis === "liquidation" ? market.spotPrice : market.debtPrice;
}

export function selectBasis(pair: VenusRiskPair, basis: VenusRiskBasis): VenusRiskResult {
  return basis === "liquidation" ? pair.liquidationRisk : pair.borrowingPower;
}

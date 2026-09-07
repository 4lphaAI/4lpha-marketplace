/**
 * PHASE4 — the sizing layer (R2.4 as corrected by R3.1, R2.10, R3.11).
 *
 * Test obligation 1 in full: exact-bigint properties including the zero-debt
 * guard, the partial-rescue minimum selection, dust acceptance, and — the one
 * the review demanded twice — **the wallet-native floor on BOTH branches**
 * (R3.1/S1), because Revision 2's REPAY line omitted it and a builder
 * implementing it literally ships a native `repayBorrow{value: entire wallet}`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { E18 } from "../src/venus/risk.js";
import {
  selectVenusRescue,
  sizeVenusRepay,
  sizeVenusSupply,
  venusRescueCapacity,
  type VenusSizingContext,
  type VenusSizingMarket,
} from "../src/venus/sizing.js";

const V_USDT = getAddress("0x1111111111111111111111111111111111111111");
const V_BNB = getAddress("0x2222222222222222222222222222222222222222");
const USDT = getAddress("0x3333333333333333333333333333333333333333");
const V_ETH = getAddress("0x4444444444444444444444444444444444444444");
const V_WBNB = getAddress("0x6666666666666666666666666666666666666666");
const WBNB = getAddress("0x7777777777777777777777777777777777777777");

/**
 * REVISION 4: supply fixtures use an ERC-20 wrapped-BNB market — the native
 * market is refused `native-collateral-trapped` before any sizing runs (the
 * FINDINGS (at) one-way door), which venus.nativeTrap.test.ts pins. Same
 * numbers as the old vBNB fixture, so every derivation below is unchanged.
 */
function wbnbCollateral(overrides: Partial<VenusSizingMarket> = {}): VenusSizingMarket {
  return bnbCollateral({
    vToken: V_WBNB,
    underlying: WBNB,
    native: false,
    ...overrides,
  });
}
const ETH = getAddress("0x5555555555555555555555555555555555555555");

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

const FLOOR = 200_000_000_000_000n; // 2 x RELAY_FEE_PER_EXIT_WEI

function context(overrides: Partial<VenusSizingContext> = {}): VenusSizingContext {
  return {
    basis: "liquidation",
    targetHf: pct("1.6"),
    vaiDebt: 0n,
    protocolPaused: false,
    walletNativeFloorWei: FLOOR,
    hasNativeGrant: true,
    ...overrides,
  };
}

/** A collateral-only vBNB market carrying the account's whole collateral. */
function bnbCollateral(overrides: Partial<VenusSizingMarket> = {}): VenusSizingMarket {
  return {
    vToken: V_BNB,
    underlying: null,
    native: true,
    listed: true,
    borrowAllowed: true,
    mintPaused: false,
    repayPaused: false,
    supplyHeadroom: 10n ** 24n,
    borrowCurrent: 0n,
    walletBalance: 10n ** 18n,
    allowance: 0n,
    maxPerActionWei: 10n ** 18n,
    capRemainingWei: null,
    inGrant: true,
    inDebtSettings: true,
    inCollateralSettings: true,
    collateralMember: true,
    vTokenBalance: 8_000_000_000_000_000_000n,
    exchangeRate: 220_000_000_000_000_000n,
    borrowBalance: 0n,
    collateralFactor: pct("0.8"),
    liquidationThreshold: pct("0.8"),
    collateralPrice: pct("600"),
    debtPrice: pct("600"),
    spotPrice: pct("600"),
    ...overrides,
  };
}

/** A debt-only vUSDT market. */
function usdtDebt(overrides: Partial<VenusSizingMarket> = {}): VenusSizingMarket {
  return {
    vToken: V_USDT,
    underlying: USDT,
    native: false,
    listed: true,
    borrowAllowed: true,
    mintPaused: false,
    repayPaused: false,
    supplyHeadroom: 10n ** 24n,
    borrowCurrent: 900n * 10n ** 18n,
    walletBalance: 500n * 10n ** 18n,
    allowance: 0n,
    maxPerActionWei: 1_000n * 10n ** 18n,
    capRemainingWei: null,
    inGrant: true,
    inDebtSettings: true,
    inCollateralSettings: false,
    collateralMember: false,
    vTokenBalance: 0n,
    exchangeRate: E18,
    borrowBalance: 900n * 10n ** 18n,
    collateralFactor: pct("0.8"),
    liquidationThreshold: pct("0.8"),
    collateralPrice: pct("1"),
    debtPrice: pct("1"),
    spotPrice: pct("1"),
    ...overrides,
  };
}

describe("venus sizing: REPAY", () => {
  it("computes a need, clamps to the minimum, and the RECOMPUTE reports the achieved HF", () => {
    // W = 844.8 (8e18 vBNB x 0.22 xr x 0.8 lt x $600), D = 900, so
    // need = 900 − 844.8/1.6 = 372.0 and the DEFAULT 500 wallet would NOT
    // bind. Fund it below the need so the wallet is genuinely the minimum and
    // the rescue is PARTIAL — submitted rather than refused.
    const markets = [bnbCollateral(), usdtDebt({ walletBalance: 100n * 10n ** 18n })];
    const sized = sizeVenusRepay(markets, markets[1] as VenusSizingMarket, context());
    assert.ok(!("refused" in sized));
    if ("refused" in sized) return;
    assert.ok(sized.amountWei > 0n);
    assert.equal(sized.boundBy, "wallet-balance");
    assert.equal(sized.amountWei, 100n * 10n ** 18n);
    // The need is the FLOORED 372e18 plus the +1 slack of R2.4.
    assert.equal(sized.neededWei, 372n * 10n ** 18n + 1n);
    assert.equal(sized.partial, true);
    // The recompute must show a real improvement even though it is partial.
    assert.notEqual(sized.achievedHf, null);
    assert.notEqual(sized.currentHf, null);
    assert.ok((sized.achievedHf as bigint) > (sized.currentHf as bigint));
  });

  it("refuses when there is no debt at all — HF is infinite, not a division", () => {
    const markets = [bnbCollateral()];
    const sized = sizeVenusRepay(markets, markets[0] as VenusSizingMarket, context());
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "hf-above-trigger");
  });

  it("clamps to borrowCurrent so a repay never exceeds the live debt", () => {
    const markets = [
      bnbCollateral(),
      usdtDebt({ borrowCurrent: 10n * 10n ** 18n, walletBalance: 10n ** 24n }),
    ];
    const sized = sizeVenusRepay(markets, markets[1] as VenusSizingMarket, context());
    assert.ok(!("refused" in sized));
    if ("refused" in sized) return;
    assert.equal(sized.boundBy, "borrow-balance");
    assert.equal(sized.amountWei, 10n * 10n ** 18n);
  });

  it("R3.1/S1 — the NATIVE repay branch subtracts walletNativeFloor, and ONCE", () => {
    // A vBNB market that carries BOTH the collateral and the debt, so the
    // native repay branch is the one under test.
    const native = bnbCollateral({
      borrowCurrent: 10n ** 18n,
      borrowBalance: 10n ** 18n,
      walletBalance: 10n ** 15n, // 0.001 BNB, just above the 0.0002 floor
      maxPerActionWei: 10n ** 18n,
    });
    const sized = sizeVenusRepay([native], native, context());
    assert.ok(!("refused" in sized));
    if ("refused" in sized) return;
    // 0.001 - 0.0002 = 0.0008 BNB. A build that omitted the floor would submit
    // the whole 0.001 and leave the wallet unable to pay the relay's next
    // reimbursement — the trapped-exit family, in the repay branch.
    assert.equal(sized.boundBy, "wallet-balance");
    assert.equal(sized.amountWei, 10n ** 15n - FLOOR);
  });

  it("a floor-clamped rescue SUBMITS THE REDUCED AMOUNT rather than refusing", () => {
    const native = bnbCollateral({
      borrowCurrent: 10n ** 18n,
      borrowBalance: 10n ** 18n,
      walletBalance: FLOOR + 1n,
    });
    const sized = sizeVenusRepay([native], native, context());
    assert.ok(!("refused" in sized));
    if ("refused" in sized) return;
    assert.equal(sized.amountWei, 1n); // dust, and it still goes
  });

  it("refuses `insufficient-wallet-balance` only when the minimum is ZERO", () => {
    const native = bnbCollateral({
      borrowCurrent: 10n ** 18n,
      borrowBalance: 10n ** 18n,
      walletBalance: FLOOR,
    });
    const sized = sizeVenusRepay([native], native, context());
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "insufficient-wallet-balance");
  });

  it("a MISSING maxPerAction ceiling is a refusal, never 'unlimited' (R2.1)", () => {
    const markets = [bnbCollateral(), usdtDebt({ maxPerActionWei: null })];
    const sized = sizeVenusRepay(markets, markets[1] as VenusSizingMarket, context());
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "market-not-in-settings");
  });

  it("a native rescue is refused when the session has NO native grant", () => {
    const native = bnbCollateral({
      borrowCurrent: 10n ** 18n,
      borrowBalance: 10n ** 18n,
    });
    const sized = sizeVenusRepay(
      [native],
      native,
      context({ hasNativeGrant: false }),
    );
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "no-native-grant");
  });

  it("an ERC-20 rescue is UNAFFECTED by a missing native grant", () => {
    const markets = [bnbCollateral(), usdtDebt()];
    const sized = sizeVenusRepay(
      markets,
      markets[1] as VenusSizingMarket,
      context({ hasNativeGrant: false }),
    );
    assert.ok(!("refused" in sized));
  });
});

describe("venus sizing: SUPPLY", () => {
  it("models the vToken mint round-trip and REFUSES a supply whose ΔW is zero", () => {
    // A one-wei supply where the EXCHANGE RATE exceeds 1e18, so the mint
    // `floor(1 * 1e18 / xr)` floors to ZERO vTokens: `W` cannot move, and a
    // fee paid for nothing is refused rather than submitted. The vToken
    // balance is kept small so `W` stays far below target and the sizing
    // reaches the mint at all (a large `W` would exit early on
    // `hf-above-trigger` and prove nothing).
    const collateralMarket = wbnbCollateral({
      walletBalance: 1n,
      maxPerActionWei: 1n,
      borrowCurrent: 0n,
      exchangeRate: 2n * E18,
      vTokenBalance: 10n ** 15n,
    });
    const debtMarket = usdtDebt({ inCollateralSettings: false });
    const sized = sizeVenusSupply(
      [collateralMarket, debtMarket],
      collateralMarket,
      context({ walletNativeFloorWei: 0n }),
    );
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "no-effect");
  });

  it("refuses a market the account has not entered — a mint there cannot move HF", () => {
    const market = wbnbCollateral({ collateralMember: false });
    const sized = sizeVenusSupply([market, usdtDebt()], market, context());
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "market-not-collateral-member");
  });

  it("sizes a real supply, clamps on the floor, and reports the recomputed gain", () => {
    const eth: VenusSizingMarket = {
      vToken: V_ETH,
      underlying: ETH,
      native: false,
      listed: true,
      borrowAllowed: true,
      mintPaused: false,
      repayPaused: false,
      supplyHeadroom: 10n ** 24n,
      borrowCurrent: 0n,
      walletBalance: 5n * 10n ** 18n,
      allowance: 0n,
      maxPerActionWei: 10n ** 24n,
      capRemainingWei: null,
      inGrant: true,
      inDebtSettings: false,
      inCollateralSettings: true,
      collateralMember: true,
      vTokenBalance: 10n ** 18n,
      exchangeRate: 300_000_000_000_000_000n,
      borrowBalance: 0n,
      collateralFactor: pct("0.8"),
      liquidationThreshold: pct("0.8"),
      collateralPrice: pct("3000"),
      debtPrice: pct("3000"),
      spotPrice: pct("3000"),
    };
    const markets = [eth, usdtDebt({ borrowCurrent: 10_000n * 10n ** 18n, borrowBalance: 10_000n * 10n ** 18n })];
    const sized = sizeVenusSupply(markets, eth, context());
    assert.ok(!("refused" in sized));
    if ("refused" in sized) return;
    assert.ok(sized.collateralGainWei > 0n);
    assert.equal(sized.boundBy, "wallet-balance");
    assert.equal(sized.amountWei, 5n * 10n ** 18n);
    assert.equal(sized.partial, true);
  });

  it("clamps on supply headroom — a mint past the cap is refused by the protocol", () => {
    const eth: VenusSizingMarket = {
      ...usdtDebt(),
      vToken: V_ETH,
      underlying: ETH,
      inDebtSettings: false,
      inCollateralSettings: true,
      collateralMember: true,
      vTokenBalance: 10n ** 18n,
      exchangeRate: 300_000_000_000_000_000n,
      collateralPrice: pct("3000"),
      spotPrice: pct("3000"),
      borrowCurrent: 0n,
      borrowBalance: 0n,
      walletBalance: 10n ** 24n,
      supplyHeadroom: 10n ** 17n,
    };
    const markets = [
      eth,
      usdtDebt({ borrowCurrent: 10_000n * 10n ** 18n, borrowBalance: 10_000n * 10n ** 18n }),
    ];
    const sized = sizeVenusSupply(markets, eth, context());
    assert.ok(!("refused" in sized));
    if ("refused" in sized) return;
    assert.equal(sized.boundBy, "supply-headroom");
    assert.equal(sized.amountWei, 10n ** 17n);
  });
});

describe("venus sizing: SELECTION (R2.10)", () => {
  it("prefers a FUNDED market over the largest-debt one", () => {
    // The first draft repaid the largest debt first, ignoring the wallet: the
    // min collapses to zero and a fully funded second market is never
    // considered. Here the big-debt market is unfunded.
    const unfunded = usdtDebt({
      borrowCurrent: 5_000n * 10n ** 18n,
      borrowBalance: 5_000n * 10n ** 18n,
      walletBalance: 0n,
    });
    const funded: VenusSizingMarket = {
      ...usdtDebt(),
      vToken: V_ETH,
      underlying: ETH,
      borrowCurrent: 100n * 10n ** 18n,
      borrowBalance: 100n * 10n ** 18n,
      walletBalance: 100n * 10n ** 18n,
    };
    const outcome = selectVenusRescue(
      [bnbCollateral(), unfunded, funded],
      context(),
    );
    assert.equal(outcome.kind, "repay");
    if (outcome.kind !== "repay") return;
    assert.equal(outcome.plan.vToken, V_ETH);
    // The skipped market is NAMED with its reason.
    assert.ok(
      outcome.skipped.some(
        (entry) =>
          entry.vToken === V_USDT
          && entry.condition === "insufficient-wallet-balance",
      ),
    );
  });

  it("a PAUSED market is a SKIP, not a refusal, while another market can act", () => {
    const paused = usdtDebt({ repayPaused: true });
    const other: VenusSizingMarket = {
      ...usdtDebt(),
      vToken: V_ETH,
      underlying: ETH,
    };
    const outcome = selectVenusRescue(
      [bnbCollateral(), paused, other],
      context(),
    );
    assert.equal(outcome.kind, "repay");
    if (outcome.kind !== "repay") return;
    assert.equal(outcome.plan.vToken, V_ETH);
    assert.ok(
      outcome.skipped.some(
        (entry) => entry.vToken === V_USDT && entry.condition === "action-paused",
      ),
    );
  });

  it("refuses ONLY when the filtered set is empty, naming every skip", () => {
    // Both routes must be closed for a refusal: the debt market's repay is
    // paused and it is not a collateral market, AND the collateral market has
    // an empty wallet so it cannot supply either. With ANY route open the
    // correct answer is an action, not a refusal — which is what R2.10 says
    // and what the two tests below pin.
    const outcome = selectVenusRescue(
      [
        bnbCollateral({ walletBalance: 0n }),
        usdtDebt({ repayPaused: true, inCollateralSettings: false }),
      ],
      context(),
    );
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    assert.ok(outcome.skipped.length > 0);
    assert.ok(outcome.detail.includes(V_USDT));
  });

  it("protocolPaused refuses everything, before any market is considered", () => {
    const outcome = selectVenusRescue(
      [bnbCollateral(), usdtDebt()],
      context({ protocolPaused: true }),
    );
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    assert.equal(outcome.condition, "protocol-paused");
    assert.equal(outcome.skipped.length, 0);
  });

  it("a market outside the owner's settings is SKIPPED, and another market still acts", () => {
    // R2.10's normative rule, in one assertion pair: an unusable market is a
    // SKIP, not a refusal, "while any other allowed market can act". The
    // vUSDT debt market is outside the settings, so the repay route closes —
    // and the funded, entered vBNB collateral market supplies instead.
    const outcome = selectVenusRescue(
      [wbnbCollateral(), usdtDebt({ inDebtSettings: false, inCollateralSettings: false })],
      context(),
    );
    assert.equal(outcome.kind, "supply");
    assert.ok(
      outcome.skipped.some(
        (entry) => entry.vToken === V_USDT && entry.condition === "market-not-in-settings",
      ),
    );
  });

  it("a market outside the GRANT is SKIPPED with market-not-in-grant", () => {
    const outcome = selectVenusRescue(
      [bnbCollateral({ inGrant: false }), usdtDebt({ inGrant: false })],
      context(),
    );
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    assert.ok(
      outcome.skipped.some((entry) => entry.condition === "market-not-in-grant"),
    );
  });
});

describe("venus sizing: rescue capacity (the funded-wallet report)", () => {
  it("reports the best achievable HF the CURRENT wallet could buy", () => {
    const capacity = venusRescueCapacity(
      [bnbCollateral(), usdtDebt()],
      context(),
    );
    assert.notEqual(capacity.currentHf, null);
    assert.notEqual(capacity.bestAchievableHf, null);
    assert.ok((capacity.bestAchievableHf as bigint) > (capacity.currentHf as bigint));
    assert.ok(capacity.perMarket.length > 0);
  });

  it("reports NO capacity for an unfunded wallet — the guard needs funding", () => {
    const capacity = venusRescueCapacity(
      [
        bnbCollateral({ walletBalance: 0n, inCollateralSettings: false }),
        usdtDebt({ walletBalance: 0n }),
      ],
      context(),
    );
    assert.equal(capacity.perMarket.length, 0);
    assert.equal(capacity.bestAchievableHf, capacity.currentHf);
  });
});

/** The address helpers above are exercised; this keeps the import honest. */
const _addresses: readonly Address[] = [V_USDT, V_BNB, USDT, V_ETH, ETH];
void _addresses;

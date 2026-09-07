/**
 * REVISION 4 (FINDINGS (at)/(at-1)) — the native-market trap, pinned at every
 * layer the third review named (V1, V2, V7, V10).
 *
 * The threat model in one line: the live pre-R4 grant is IMMUTABLE on chain
 * and still carries `mint()` on vBNB, and a pre-R4 settings row is
 * digest-verified forever — so the DECISION layer is the only thing standing
 * between a running worker and minting another one-way position. These tests
 * are that layer's proof.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import {
  selectVenusRescue,
  sizeVenusSupply,
  venusRescueCapacity,
  type VenusSizingContext,
  type VenusSizingMarket,
} from "../src/venus/sizing.js";
import { venusSessionSpec, VENUS_VBNB_GRANTED_SELECTORS } from "../src/ops/policy.js";
import { E18 } from "../src/venus/risk.js";

const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const COMPTROLLER = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const PRIME = getAddress("0x059eaba8676b03e4e8f009efb7f587c28450f50f");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");

function pct(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * E18 + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

function context(overrides: Partial<VenusSizingContext> = {}): VenusSizingContext {
  return {
    basis: "liquidation",
    targetHf: pct("1.6"),
    vaiDebt: 0n,
    protocolPaused: false,
    walletNativeFloorWei: 200_000_000_000_000n,
    hasNativeGrant: true,
    ...overrides,
  };
}

/**
 * The PRE-R4 shape, exactly: a native market the OLD settings admitted as
 * collateral (`inCollateralSettings: true`) under a grant that carries mint
 * (`inGrant: true`), on an account whose HF wants a rescue.
 */
function preR4NativeMarket(overrides: Partial<VenusSizingMarket> = {}): VenusSizingMarket {
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
    vTokenBalance: 8n * E18,
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

function usdtDebt(overrides: Partial<VenusSizingMarket> = {}): VenusSizingMarket {
  return preR4NativeMarket({
    vToken: V_USDT,
    underlying: USDT,
    native: false,
    collateralMember: false,
    inCollateralSettings: false,
    vTokenBalance: 0n,
    borrowCurrent: 900n * E18,
    borrowBalance: 900n * E18,
    exchangeRate: E18,
    walletBalance: 0n, // wallet holds NO USDT — the repay route is closed
    spotPrice: pct("1"),
    collateralPrice: pct("1"),
    debtPrice: pct("1"),
    ...overrides,
  });
}

describe("Revision 4: the decision layer refuses the native market FIRST (V1)", () => {
  it("sizeVenusSupply refuses a native market before ANY other check — even zero debt", () => {
    // The V1 ordering claim, exact: refused for WHAT IT IS, not for the
    // account's current state. Zero debt would otherwise answer
    // hf-above-trigger; the native refusal must outrank it.
    const market = preR4NativeMarket({ borrowCurrent: 0n });
    const sized = sizeVenusSupply([market], market, context());
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "native-collateral-trapped");
    // V2: the detail carries the remedy, addresses included.
    assert.match(sized.detail, /Wrap BNB\s+to WBNB by hand/u);
    assert.match(sized.detail, /0x6bCa74586218db34cDB402295796b79663d816e9/u);
    assert.match(sized.detail, /no wrap grant/u);
  });

  it("M1 killer — the native refusal outranks market-not-in-settings in supplyFilter", () => {
    // The build verification's surviving mutation M1: reorder the native check
    // BELOW the settings check and the whole 2,186-test suite stayed green,
    // because every fixture set inCollateralSettings: true. This one does NOT
    // — the exact state of the live agent's re-signed row (collateralMarkets
    // empty) — and the answer must STILL be the trap, not the settings excuse:
    // a one-way door is a one-way door whether or not the owner named it.
    const market = preR4NativeMarket({ inCollateralSettings: false });
    const sized = sizeVenusSupply([market], market, context());
    assert.ok("refused" in sized);
    if (!("refused" in sized)) return;
    assert.equal(sized.refused, "native-collateral-trapped");
    const outcome = selectVenusRescue(
      [market, usdtDebt()],
      context(),
    );
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    // vBNB appears in `skipped` once per ROUTE (the repay loop skips it for
    // its zero borrow, the supply loop for the trap) — the assertion is that
    // the SUPPLY-side skip names the trap, and that no supply-side skip names
    // the settings excuse the M1 reorder would produce.
    assert.ok(
      outcome.skipped.some(
        (entry) =>
          entry.vToken === V_BNB && entry.condition === "native-collateral-trapped",
      ),
      JSON.stringify(outcome.skipped),
    );
    assert.ok(
      !outcome.skipped.some(
        (entry) =>
          entry.vToken === V_BNB && entry.condition === "market-not-in-settings",
      ),
      "the M1 reorder answered the settings excuse about a one-way door",
    );
  });

  it("V2 closure — the aggregate refusal LEADS with the wrap remedy, so the worker's hold reason carries it", () => {
    const markets = [preR4NativeMarket(), usdtDebt()];
    const outcome = selectVenusRescue(markets, context());
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    // The remedy sentence must survive a ~300-char sanitizer cap, so it must
    // be the FIRST thing in the detail — not an appendix past the skip list.
    assert.match(outcome.detail, /^Wrap BNB to WBNB by hand/u);
    assert.match(outcome.detail, /0x6bCa74586218db34cDB402295796b79663d816e9/u);
  });

  it("the PRE-R4 row cannot drive a native supply: selection SKIPS vBNB with the trap condition, not an empty-wallet excuse", () => {
    // The whole V1 scenario: old settings admit vBNB as collateral, the grant
    // still carries mint, the repay route is closed (no USDT in the wallet),
    // and HF is under target. Pre-R4 this dispatched the (as-2) native mint.
    const markets = [preR4NativeMarket(), usdtDebt()];
    const outcome = selectVenusRescue(markets, context());
    assert.equal(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    const nativeSkip = outcome.skipped.find(
      (entry) => entry.vToken === V_BNB && entry.condition === "native-collateral-trapped",
    );
    assert.notEqual(
      nativeSkip,
      undefined,
      `vBNB was not skipped with the trap condition: ${JSON.stringify(outcome.skipped)}`,
    );
    // V2's other half: the owner must NOT be told the market lacked balance
    // or membership — the wallet holds a full BNB and the account is a member.
    assert.ok(
      !outcome.skipped.some(
        (entry) =>
          entry.vToken === V_BNB
          && (entry.condition === "insufficient-wallet-balance"
            || entry.condition === "market-not-collateral-member"),
      ),
    );
  });

  it("venusRescueCapacity stops ADVERTISING a native supply (V7)", () => {
    const markets = [preR4NativeMarket(), usdtDebt({ walletBalance: 500n * E18 })];
    const capacity = venusRescueCapacity(markets, context());
    assert.ok(
      !capacity.perMarket.some(
        (entry) => entry.kind === "supply" && entry.vToken === V_BNB,
      ),
      "the owner view still advertises a native supply the worker can no longer take",
    );
    // The repay capacity on vUSDT is untouched.
    assert.ok(capacity.perMarket.some((entry) => entry.kind === "repay"));
  });

  it("native REPAY is a NON-regression (V7): still sized, still the rescue of first resort", () => {
    // V8 measured it safe (repay <= debt OK under delegation; overpay reverts
    // loudly for every caller — no refund path). The trap is the SUPPLY door
    // only, and closing it must not touch this one.
    const native = preR4NativeMarket({
      borrowCurrent: 10n ** 18n,
      borrowBalance: 10n ** 18n,
      walletBalance: 10n ** 16n,
    });
    const outcome = selectVenusRescue([native], context());
    assert.equal(outcome.kind, "repay");
    if (outcome.kind !== "repay") return;
    assert.equal(outcome.plan.vToken, V_BNB);
    assert.ok(outcome.plan.amountWei > 0n);
  });
});

describe("Revision 4: the template census shrank (V5)", () => {
  it("the vBNB row is repayBorrow() ONLY — six granted selectors total", () => {
    assert.deepEqual([...VENUS_VBNB_GRANTED_SELECTORS], ["repayBorrow()"]);
    const spec = venusSessionSpec({
      comptroller: COMPTROLLER,
      prime: PRIME,
      vBnb: V_BNB,
      vTokens: [V_USDT],
      tokens: [{ token: USDT, vToken: V_USDT, dailyCapWei: 20n * E18 }],
      treasury: TREASURY,
      nativeCaps: [{ limit: 10n ** 16n, period: "day" }],
      expiresAt: 1_900_000_000 + 3_600,
      nowSeconds: 1_900_000_000,
    });
    const vBnbRules = spec.allowedCalls.filter(
      (rule) => rule.to?.toLowerCase() === V_BNB.toLowerCase(),
    );
    assert.deepEqual(
      vBnbRules.map((rule) => rule.selector),
      ["repayBorrow()"],
      "the native market's grant must be repay-only after Revision 4",
    );
    // 6 selector rules + 1 treasury rule (was 7 + 1 before Revision 4).
    assert.equal(spec.allowedCalls.length, 7);
  });
});

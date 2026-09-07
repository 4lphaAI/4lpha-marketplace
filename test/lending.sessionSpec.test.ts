/**
 * `lendingSessionSpec` — the CLOSED census, and every refusal that makes it
 * meaningful (MARKETPLACE-LENDING-AGENT §7, R2.2, R2.5, §11).
 *
 * The enumeration test is the load-bearing one: it asserts the EXACT set a
 * built spec grants and FAILS ON ANY ADDITION, which is the only way a census
 * stays closed once somebody adds "just one more selector".
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import { InvalidSessionSpecError } from "../src/core/types.js";
import {
  APPROVE_SELECTOR,
  DEFAULT_TOKEN_CAP_LIMIT,
  LENDING_GRANTED_SELECTORS,
  LENDING_REFUSED_SELECTORS,
  LENDING_VBNB_GRANTED_SELECTORS,
  LENDING_VUSDT_GRANTED_SELECTORS,
  MAX_VENUS_SESSION_SECONDS,
  grantsLendingMarket,
  lendingExposureProduct,
  lendingSessionSpec,
} from "../src/ops/policy.js";

const V_USDT = getAddress("0xfD5840Cd36d94D7229439859C0112a4185BC0255");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const V_BNB = getAddress("0xA07c5b74C9B40447a954e1466938b865b6BBea36");
const ROUTER = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const TREASURY = getAddress("0x00000000000000000000000000000000000000a1");
const WALLET_B = getAddress("0x00000000000000000000000000000000000000b1");
const KEY_STORE = getAddress("0x00000000000000000000000000000000000000c1");

const NOW = 1_900_000_000;

function spec(overrides: Partial<Parameters<typeof lendingSessionSpec>[0]> = {}) {
  return lendingSessionSpec({
    vUsdt: V_USDT,
    usdt: USDT,
    vBnb: V_BNB,
    routerV3: ROUTER,
    treasury: TREASURY,
    walletAddress: WALLET_B,
    keyStoreAddress: KEY_STORE,
    nativeCaps: [{ limit: 10n ** 17n, period: "day" }],
    usdtDailyCapWei: 500n * 10n ** 18n,
    expiresAt: NOW + 7 * 24 * 60 * 60,
    nowSeconds: NOW,
    ...overrides,
  });
}

describe("lendingSessionSpec — the closed census", () => {
  it("grants EXACTLY the census set and fails on any addition", () => {
    const built = spec();
    // Selector-bound rules, as `target|selector` pairs.
    const granted = built.allowedCalls
      .filter((rule) => rule.selector !== undefined)
      .map((rule) => `${(rule.to as Address).toLowerCase()}|${rule.selector}`)
      .sort();
    const expected = [
      ...LENDING_VUSDT_GRANTED_SELECTORS.map((s) => `${V_USDT.toLowerCase()}|${s}`),
      ...LENDING_VBNB_GRANTED_SELECTORS.map((s) => `${V_BNB.toLowerCase()}|${s}`),
      `${USDT.toLowerCase()}|${APPROVE_SELECTOR}`,
    ].sort();
    assert.deepEqual(granted, expected);

    // Target-only rules: EXACTLY the router and the treasury, and no third.
    const targetOnly = built.allowedCalls
      .filter((rule) => rule.selector === undefined)
      .map((rule) => (rule.to as Address).toLowerCase())
      .sort();
    assert.deepEqual(targetOnly, [ROUTER.toLowerCase(), TREASURY.toLowerCase()].sort());

    // And the union is the whole allowlist: nothing is bare-selector.
    assert.equal(
      built.allowedCalls.length,
      granted.length + targetOnly.length,
      "a rule with neither a target nor a selector would be a bare-selector grant",
    );
  });

  it("names four selectors in total, and `redeem(uint256)` is NOT one of them", () => {
    assert.deepEqual([...LENDING_VUSDT_GRANTED_SELECTORS], [
      "mint(uint256)",
      "redeemUnderlying(uint256)",
      "repayBorrowBehalf(address,uint256)",
    ]);
    assert.deepEqual([...LENDING_VBNB_GRANTED_SELECTORS], ["repayBorrowBehalf(address)"]);
    assert.equal(LENDING_GRANTED_SELECTORS.length, 5); // 3 + 1 + approve
    assert.ok(!LENDING_GRANTED_SELECTORS.includes("redeem(uint256)"));
  });

  it("refuses every named selector in the refused list", () => {
    const built = spec();
    const emitted = new Set(
      built.allowedCalls
        .map((rule) => rule.selector)
        .filter((selector): selector is string => selector !== undefined),
    );
    for (const refused of LENDING_REFUSED_SELECTORS) {
      assert.ok(
        !emitted.has(refused),
        `${refused} is in LENDING_REFUSED_SELECTORS and must never be granted`,
      );
    }
    // The four that carry the phase's own reasons, asserted BY NAME so a
    // rename cannot quietly drop one.
    for (const name of [
      "redeem(uint256)",
      "borrow(uint256)",
      "enterMarkets(address[])",
      "exitMarket(address)",
      "mint()",
      "multicall(bytes[])",
      "transfer(address,uint256)",
      "withdraw(uint256)",
    ]) {
      assert.ok(LENDING_REFUSED_SELECTORS.includes(name), `${name} must be named as refused`);
      assert.ok(!emitted.has(name));
    }
  });

  it("grants vBNB ONLY when it is a pinned debt market", () => {
    const usdtOnly = lendingSessionSpec({
      vUsdt: V_USDT, usdt: USDT, routerV3: ROUTER, treasury: TREASURY,
      walletAddress: WALLET_B, keyStoreAddress: KEY_STORE,
      nativeCaps: [{ limit: 10n ** 17n, period: "day" }],
      usdtDailyCapWei: 500n * 10n ** 18n,
      expiresAt: NOW + 7 * 24 * 60 * 60, nowSeconds: NOW,
    });
    assert.ok(
      !usdtOnly.allowedCalls.some(
        (rule) => (rule.to as Address).toLowerCase() === V_BNB.toLowerCase(),
      ),
      "an ungranted market is one fewer target a leaked key reaches",
    );
    assert.ok(grantsLendingMarket(usdtOnly, V_USDT, "reserve"));
    assert.ok(grantsLendingMarket(usdtOnly, V_USDT, "repay-behalf"));
    assert.ok(!grantsLendingMarket(usdtOnly, V_BNB, "repay-behalf"));
  });

  it("pairs the USDT approve with a per-token cap — both halves, or a session that cannot sell", () => {
    const built = spec();
    const approve = built.allowedCalls.find(
      (rule) =>
        (rule.to as Address).toLowerCase() === USDT.toLowerCase()
        && rule.selector === APPROVE_SELECTOR,
    );
    assert.ok(approve !== undefined, "FINDINGS (h): the approve rule is half of the pair");
    const cap = built.spendCaps.find(
      (entry) => entry.token?.toLowerCase() === USDT.toLowerCase(),
    );
    assert.ok(cap !== undefined, "FINDINGS (u): the cap is the other half");
    assert.equal(cap.limit, 500n * 10n ** 18n);
    assert.equal(cap.period, "day");
  });

  it("REFUSES wallet B and the KeyStore as targets, template-locally", () => {
    // R2.2: the refusal must not depend on the call site remembering to pass
    // the validate options, so the template's own role-collision loop carries
    // both addresses.
    assert.throws(
      () => spec({ treasury: WALLET_B }),
      (error: unknown) =>
        error instanceof InvalidSessionSpecError && /walletAddress/u.test(error.message),
    );
    assert.throws(
      () => spec({ routerV3: KEY_STORE }),
      (error: unknown) =>
        error instanceof InvalidSessionSpecError && /keyStoreAddress/u.test(error.message),
    );
    assert.throws(
      () => spec({ vUsdt: WALLET_B }),
      (error: unknown) => error instanceof InvalidSessionSpecError,
    );
  });

  it("refuses a role collision between any two granted addresses", () => {
    assert.throws(() => spec({ treasury: USDT }), InvalidSessionSpecError);
    assert.throws(() => spec({ routerV3: V_USDT }), InvalidSessionSpecError);
    assert.throws(() => spec({ vBnb: V_USDT }), InvalidSessionSpecError);
  });

  it("refuses an absent, zero or effectively-unlimited USDT cap", () => {
    assert.throws(() => spec({ usdtDailyCapWei: 0n }), InvalidSessionSpecError);
    assert.throws(
      () => spec({ usdtDailyCapWei: DEFAULT_TOKEN_CAP_LIMIT }),
      (error: unknown) =>
        error instanceof InvalidSessionSpecError && /2\^160/u.test(error.message),
    );
  });

  it("refuses an empty native cap list and a token-bearing native cap", () => {
    assert.throws(() => spec({ nativeCaps: [] }), InvalidSessionSpecError);
    assert.throws(
      () => spec({ nativeCaps: [{ limit: 1n, period: "day", token: USDT }] }),
      InvalidSessionSpecError,
    );
  });

  it("CLAMPS the expiry to the 7-day Venus ceiling", () => {
    const built = spec({ expiresAt: NOW + 30 * 24 * 60 * 60 });
    assert.equal(built.expiresAt, NOW + MAX_VENUS_SESSION_SECONDS);
  });

  it("prints the exposure PRODUCT, never the per-day rate alone", () => {
    const product = lendingExposureProduct({
      nativeDailyCapWei: 10n ** 17n,
      usdt: USDT,
      usdtDailyCapWei: 500n * 10n ** 18n,
      sessionSeconds: MAX_VENUS_SESSION_SECONDS,
    });
    assert.equal(product.periods, 7);
    assert.equal(product.nativeProductWei, 7n * 10n ** 17n);
    assert.equal(product.tokenProducts[0]?.productWei, 3_500n * 10n ** 18n);
  });
});

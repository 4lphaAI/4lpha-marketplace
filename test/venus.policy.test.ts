/**
 * PHASE4 — `venusSessionSpec` and the reserves (`PHASE4-AUDIT.md` A5's
 * template and meter thirds — the CUSTODY-critical surfaces the audit found
 * with zero tests, on which three of its proposed mutations survived green).
 *
 * The template is the whole custody argument: after R2.1, the per-token cap is
 * the SOLE bound on a leaked session key's approve-spender drain, so a
 * template that defaulted a cap, emitted an extra selector, granted a
 * target-only vToken rule, or outlived its 7-day ceiling would be a custody
 * change nobody reviewed. Every one of those is pinned here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, toFunctionSelector, type Address } from "viem";

import {
  MAX_VENUS_SESSION_SECONDS,
  RELAY_FEE_PER_EXIT_WEI,
  VENUS_GRANTED_SELECTORS,
  VENUS_RECORDED_ROUTING,
  VENUS_REFUSED_SELECTORS,
  assertVenusRoutingUnchanged,
  checkVenusNativeCapSizing,
  venusExposureProduct,
  venusMeterReserve,
  venusSessionSpec,
  type VenusRoutingCensus,
  type VenusSessionSpecInput,
} from "../src/ops/policy.js";

const COMPTROLLER = getAddress("0xfd36e2c2a6789db23113685031d7f16329158384");
const PRIME = getAddress("0x059eaba8676b03e4e8f009efb7f587c28450f50f");
const V_BNB = getAddress("0xa07c5b74c9b40447a954e1466938b865b6bbea36");
const V_USDT = getAddress("0xfd5840cd36d94d7229439859c0112a4185bc0255");
const USDT = getAddress("0x55d398326f99059ff775485246999027b3197955");
const TREASURY = getAddress("0x00000000000000000000000000000000000000fe");
const E18 = 10n ** 18n;
const NOW = 1_900_000_000;

function input(overrides: Partial<VenusSessionSpecInput> = {}): VenusSessionSpecInput {
  return {
    comptroller: COMPTROLLER,
    prime: PRIME,
    vBnb: V_BNB,
    vTokens: [V_USDT],
    tokens: [{ token: USDT, vToken: V_USDT, dailyCapWei: 20n * E18 }],
    treasury: TREASURY,
    nativeCaps: [{ limit: 10n ** 16n, period: "day" }],
    expiresAt: NOW + 6 * 24 * 3600,
    nowSeconds: NOW,
    ...overrides,
  };
}

describe("venusSessionSpec: the census is what the grant emits — nothing else", () => {
  it("emits exactly the granted selectors on exactly their targets, per-selector", () => {
    const spec = venusSessionSpec(input());
    const rules = spec.allowedCalls.map((rule) => ({
      to: rule.to?.toLowerCase(),
      selector: rule.selector,
    }));
    // Every rule but the treasury's carries a selector: no target-only rule on
    // any CONTRACT — the LP lesson, kept.
    for (const rule of spec.allowedCalls) {
      if (rule.to?.toLowerCase() === TREASURY.toLowerCase()) continue;
      assert.notEqual(
        rule.selector,
        undefined,
        `target-only rule on ${rule.to} — the shape Rev2 forbids`,
      );
    }
    // Altana's `CallRule.selector` carries the SIGNATURE STRING, not the
    // 4-byte id — the SDK hashes it at grant time. So the census here pins
    // signatures on targets, and the 4-byte mapping is pinned separately
    // below against the bytes located in deployed bytecode.
    const bySelector = new Set(
      rules.filter((rule) => rule.selector !== undefined).map(
        (rule) => `${rule.to}:${rule.selector}`,
      ),
    );
    const expect = (to: Address, signature: string): void => {
      assert.ok(
        bySelector.has(`${to.toLowerCase()}:${signature}`),
        `missing ${signature} on ${to}`,
      );
    };
    expect(COMPTROLLER, "claimVenus(address,address[])");
    expect(PRIME, "claimInterest(address,address)");
    expect(V_BNB, "repayBorrow()");
    // REVISION 4: mint() left the vBNB row — a native supply mints a position
    // an EIP-7702 wallet cannot redeem (FINDINGS (at)); vBNB is repay-only.
    expect(V_USDT, "repayBorrow(uint256)");
    expect(V_USDT, "mint(uint256)");
    expect(USDT, "approve(address,uint256)");
    // And that is ALL of them: 6 selector rules + 1 treasury rule
    // (7 + 1 before Revision 4 removed the native mint).
    assert.equal(spec.allowedCalls.length, 7);
  });

  it("never emits a refused selector, and the refused list still names the dangerous ones", () => {
    const spec = venusSessionSpec(input());
    const emitted = new Set(
      spec.allowedCalls
        .filter((rule) => rule.selector !== undefined)
        .map((rule) => rule.selector),
    );
    for (const signature of VENUS_REFUSED_SELECTORS) {
      assert.ok(!emitted.has(signature), `the grant emits refused ${signature}`);
    }
    // The signature -> 4-byte mapping, pinned against the bytes located in
    // deployed bytecode at block 117738703 — so a signature typo cannot grant
    // a different function than the census measured.
    const MEASURED: Record<string, string> = {
      "repayBorrow()": "0x4e4d9fea",
      "mint()": "0x1249c58b",
      "repayBorrow(uint256)": "0x0e752702",
      "mint(uint256)": "0xa0712d68",
      "approve(address,uint256)": "0x095ea7b3",
      "claimVenus(address,address[])": "0x86df31ee",
      "claimInterest(address,address)": "0xba437c68",
    };
    for (const [signature, fourByte] of Object.entries(MEASURED)) {
      assert.equal(toFunctionSelector(signature), fourByte, signature);
    }
    for (const needed of [
      "borrow(uint256)",
      "redeem(uint256)",
      "redeemUnderlying(uint256)",
      "enterMarkets(address[])",
      "exitMarket(address)",
      "multicall(bytes[])",
    ]) {
      assert.ok(
        VENUS_REFUSED_SELECTORS.includes(needed),
        `${needed} fell out of the refused list`,
      );
    }
    // The granted census is CLOSED at six (seven before Revision 4).
    assert.equal(VENUS_GRANTED_SELECTORS.length, 6);
  });

  it("R2.1 — every ERC-20 grant carries BOTH the approve rule AND a positive cap; a cap can never default", () => {
    const spec = venusSessionSpec(input());
    const usdtCap = spec.spendCaps.find(
      (cap) => cap.token?.toLowerCase() === USDT.toLowerCase(),
    );
    assert.notEqual(usdtCap, undefined);
    assert.equal(usdtCap?.limit, 20n * E18);
    // A zero or missing cap is REFUSED, never defaulted to 2^160.
    assert.throws(() =>
      venusSessionSpec(
        input({ tokens: [{ token: USDT, vToken: V_USDT, dailyCapWei: 0n }] }),
      ),
    );
    for (const cap of spec.spendCaps) {
      assert.ok(cap.limit < 2n ** 160n, "a template cap reached the forbidden default");
    }
  });

  it("R3.2 — the 7-day ceiling CLAMPS a longer request and survives in the constant", () => {
    assert.equal(MAX_VENUS_SESSION_SECONDS, 7 * 24 * 3600);
    const spec = venusSessionSpec(input({ expiresAt: NOW + 30 * 24 * 3600 }));
    assert.equal(spec.expiresAt, NOW + MAX_VENUS_SESSION_SECONDS);
  });

  it("refuses an empty nativeCaps list and a token-bearing native cap", () => {
    assert.throws(() => venusSessionSpec(input({ nativeCaps: [] })), /uncapped/u);
    assert.throws(() =>
      venusSessionSpec(
        input({ nativeCaps: [{ token: USDT, limit: 1n, period: "day" }] }),
      ),
    );
  });

  it("refuses every role collision — a treasury equal to a token is an uncapped transfer rule", () => {
    for (const collision of [
      input({ treasury: V_USDT }),
      input({ treasury: USDT }),
      input({ prime: COMPTROLLER }),
      input({ vBnb: V_USDT }),
      input({ tokens: [{ token: V_USDT, vToken: V_USDT, dailyCapWei: 1n }] }),
    ]) {
      assert.throws(() => venusSessionSpec(collision));
    }
  });

  it("omitting vBNB omits its two payable selectors — a token-only guard grants no native surface", () => {
    const { vBnb: _omitted, ...rest } = input();
    const spec = venusSessionSpec(rest);
    const targets = new Set(spec.allowedCalls.map((rule) => rule.to?.toLowerCase()));
    assert.ok(!targets.has(V_BNB.toLowerCase()));
  });
});

describe("venusSessionSpec: the R3.12 routing gate", () => {
  const matching: VenusRoutingCensus = {
    claimVenusFacet: VENUS_RECORDED_ROUTING.claimVenusFacet,
    primeImplementation: VENUS_RECORDED_ROUTING.primeImplementation,
    vTokenImplementations: [[V_USDT, VENUS_RECORDED_ROUTING.vBep20Implementation]],
  };

  it("an UNCHANGED census grants", () => {
    const spec = venusSessionSpec(input({ routing: matching }));
    assert.ok(spec.allowedCalls.length > 0);
  });

  it("a MOVED facet refuses LOUDLY, naming old and new — governance re-cut the Diamond", () => {
    const moved = { ...matching, claimVenusFacet: TREASURY };
    assert.throws(
      () => venusSessionSpec(input({ routing: moved })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /0x9e0CCD70b5E0030472D5013bbBd37B6E868d416f/u);
        assert.match(message, new RegExp(TREASURY, "u"));
        return true;
      },
    );
  });

  it("a moved vToken IMPLEMENTATION refuses too — repayBorrow semantics are proxy-mutable", () => {
    assert.throws(() =>
      assertVenusRoutingUnchanged({
        ...matching,
        vTokenImplementations: [[V_USDT, TREASURY]],
      }),
    );
  });
});

describe("venusMeterReserve: claims gated, rescues counted (R2.11/R3.4/R3.6)", () => {
  it("gates a claim that would leave less than the outstanding-rescue reserve", () => {
    const reserve = venusMeterReserve({
      limitWei: 10n ** 16n,
      currentSpentWei: 10n ** 16n - 3n * RELAY_FEE_PER_EXIT_WEI,
      rescueReserveCount: 4,
      rescuesChargedInWindow: 0,
      submissionNativeWei: 0n,
    });
    // remaining = 3 fees; required = own fee + 4 reserved = 5 fees. Refuse.
    assert.equal(reserve.sufficient, false);
    assert.equal(reserve.reservedSubmissions, 4);
    assert.equal(reserve.shortfallWei, 2n * RELAY_FEE_PER_EXIT_WEI);
  });

  it("R3.4 — counted rescues NARROW the reserve: after three fired, only one is still held back", () => {
    const reserve = venusMeterReserve({
      limitWei: 10n ** 16n,
      currentSpentWei: 10n ** 16n - 3n * RELAY_FEE_PER_EXIT_WEI,
      rescueReserveCount: 4,
      rescuesChargedInWindow: 3,
      submissionNativeWei: 0n,
    });
    // outstanding = max(1, 4-3) = 1; required = 2 fees; remaining = 3. Pass.
    assert.equal(reserve.reservedSubmissions, 1);
    assert.equal(reserve.sufficient, true);
  });

  it("the reserve never reaches zero — max(1, …) holds even after more rescues than reserved", () => {
    const reserve = venusMeterReserve({
      limitWei: 10n ** 18n,
      currentSpentWei: 0n,
      rescueReserveCount: 4,
      rescuesChargedInWindow: 9,
      submissionNativeWei: 0n,
    });
    assert.equal(reserve.reservedSubmissions, 1);
  });

  it("an over-cap meter reports overCap and refuses", () => {
    const reserve = venusMeterReserve({
      limitWei: 10n ** 15n,
      currentSpentWei: 2n * 10n ** 15n,
      rescueReserveCount: 4,
      rescuesChargedInWindow: 0,
      submissionNativeWei: 0n,
    });
    assert.equal(reserve.overCap, true);
    assert.equal(reserve.sufficient, false);
  });
});

describe("checkVenusNativeCapSizing: the EARLY WARNING, honestly bounded", () => {
  it("warns when the cap cannot cover a day of the guard doing its job", () => {
    const result = checkVenusNativeCapSizing({
      onChainDailyCapWei: 10n ** 15n,
      rescueReserveCount: 4,
      maxClaimsPerDay: 4,
      maxNativeActionWei: 10n ** 15n,
    });
    assert.equal(result.ok, false);
  });

  it("passes a properly sized cap", () => {
    const result = checkVenusNativeCapSizing({
      onChainDailyCapWei: 10n ** 16n,
      rescueReserveCount: 4,
      maxClaimsPerDay: 4,
      maxNativeActionWei: 25n * 10n ** 14n,
    });
    assert.equal(result.ok, true);
  });

  it("refuses malformed counts rather than sizing a reserve on them", () => {
    for (const bad of [
      { rescueReserveCount: 0 },
      { rescueReserveCount: 1.5 },
      { maxClaimsPerDay: -1 },
    ]) {
      const result = checkVenusNativeCapSizing({
        onChainDailyCapWei: 10n ** 16n,
        rescueReserveCount: 4,
        maxClaimsPerDay: 4,
        maxNativeActionWei: 0n,
        ...bad,
      });
      assert.equal(result.ok, false);
    }
  });
});

describe("venusExposureProduct: FINDINGS (r) — the PRODUCT, never the rate alone", () => {
  it("multiplies every cap by the CEILING of the session's day count", () => {
    const exposure = venusExposureProduct({
      nativeDailyCapWei: 10n ** 16n,
      tokens: [{ token: USDT, vToken: V_USDT, dailyCapWei: 20n * E18 }],
      sessionSeconds: 7 * 24 * 3600,
    });
    assert.equal(exposure.periods, 7);
    assert.equal(exposure.nativeProductWei, 7n * 10n ** 16n);
    assert.equal(exposure.tokenProducts[0]?.productWei, 140n * E18);
  });

  it("a partial day still counts as a period — rolling caps have no lifetime ceiling", () => {
    const exposure = venusExposureProduct({
      nativeDailyCapWei: 1n,
      tokens: [],
      sessionSeconds: 24 * 3600 + 1,
    });
    assert.equal(exposure.periods, 2);
  });
});

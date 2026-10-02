/**
 * The Auto DCA grant and native reserve (AUTO-DCA-SPEC §9.1, R2.9; REVIEW2
 * conditions 6 and 7). A DCA hire is the TradFi v2 grant for ONE stock plus
 * exactly three NFPM rules; without `nfpm` the template is byte-identical for
 * every existing caller.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import { InvalidSessionSpecError } from "../src/core/types.js";
import {
  APPROVE_SELECTOR,
  DEFAULT_TOKEN_CAP_LIMIT,
  NFPM_GRANTED_SELECTORS,
  TRADFI_GUARD_SWAP_SELECTOR,
  TRADFI_USDT_56,
  exitReserveWei,
  nativeReserveFloor,
  tradeSessionSpec,
  type TradeSessionSpecInput,
} from "../src/ops/policy.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import {
  FLAP_PORTAL_56,
  FOUR_MEME_TOKEN_MANAGER_56,
  PANCAKE_V2_ROUTER_56,
  PANCAKE_V3_ROUTER_56,
  UNISWAP_V3_ROUTER02_56,
} from "../src/ops/venues.js";
import { DCA_PLATFORM_FEE_BPS } from "../src/trade/dca.js";
import { R_DCA } from "../src/trade/sizing.js";

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const NVDAB: Address = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const GUARD: Address = getAddress("0x00000000000000000000000000000000000000dD");
const TREASURY: Address = getAddress("0x00000000000000000000000000000000000000cC");

/** §9.1's call, with every venue configured as in production. */
const DCA_INPUT: TradeSessionSpecInput = {
  venues: {
    chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56,
    uniswapRouterV3: UNISWAP_V3_ROUTER02_56, fourMemeTokenManager: FOUR_MEME_TOKEN_MANAGER_56, flapPortal: FLAP_PORTAL_56,
  },
  treasury: TREASURY,
  aggregatorGuard: GUARD,
  tokens: [{ token: NVDAB }],
  nativeCaps: [{ limit: 3_840_000_000_000_000n, period: "day" }],
  expiresAt: NOW + 7 * 86_400,
  nowSeconds: NOW,
  quoteToken: TRADFI_USDT_56,
  quoteDailyCapWei: 5n * 55n * E18,
  quotePerTradeCapWei: 15n * E18,
  platformFeeBps: DCA_PLATFORM_FEE_BPS,
  nfpm: NFPM_56,
};

describe("§9.1 — the DCA grant", () => {
  it("is exactly 14 rules and 3 caps (no fee transfer), the NFPM rules last and per-selector only", () => {
    const spec = tradeSessionSpec(DCA_INPUT);
    assert.deepEqual(spec.allowedCalls, [
      { to: PANCAKE_V2_ROUTER_56 },
      { to: PANCAKE_V3_ROUTER_56 },
      { to: UNISWAP_V3_ROUTER02_56, selector: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" },
      { to: UNISWAP_V3_ROUTER02_56, selector: "exactInput((bytes,address,uint256,uint256))" },
      { to: UNISWAP_V3_ROUTER02_56, selector: "unwrapWETH9(uint256,address)" },
      { to: UNISWAP_V3_ROUTER02_56, selector: "refundETH()" },
      { to: FOUR_MEME_TOKEN_MANAGER_56 },
      { to: FLAP_PORTAL_56 },
      { to: GUARD, selector: TRADFI_GUARD_SWAP_SELECTOR },
      { to: NVDAB, selector: APPROVE_SELECTOR },
      { to: TRADFI_USDT_56, selector: APPROVE_SELECTOR },
      { to: NFPM_56, selector: "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" },
      { to: NFPM_56, selector: "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" },
      { to: NFPM_56, selector: "collect((uint256,address,uint128,uint128))" },
    ]);
    assert.deepEqual(spec.spendCaps, [
      { limit: 3_840_000_000_000_000n, period: "day" },
      { token: NVDAB, limit: DEFAULT_TOKEN_CAP_LIMIT, period: "day" },
      { token: TRADFI_USDT_56, limit: 275n * E18, period: "day" },
    ]);
    const nfpmRules = spec.allowedCalls.filter((rule) => rule.to === NFPM_56);
    assert.ok(nfpmRules.every((rule) => rule.selector !== undefined && (NFPM_GRANTED_SELECTORS as readonly string[]).includes(rule.selector)));
    assert.ok(nfpmRules.every((rule) => !/multicall|burn|approve|transfer|increaseLiquidity|sweep|unwrap|refund/iu.test(rule.selector ?? "")));
  });

  it("refuses an NFPM equal to any other address in the grant", () => {
    const collisions: readonly Partial<TradeSessionSpecInput>[] = [
      { nfpm: PANCAKE_V2_ROUTER_56 }, { nfpm: PANCAKE_V3_ROUTER_56 }, { nfpm: UNISWAP_V3_ROUTER02_56 },
      { nfpm: FOUR_MEME_TOKEN_MANAGER_56 }, { nfpm: FLAP_PORTAL_56 }, { nfpm: GUARD }, { nfpm: TREASURY },
      { nfpm: NVDAB }, { nfpm: TRADFI_USDT_56 }, { treasury: NFPM_56 },
      { nfpm: getAddress(NVDAB.toLowerCase()) },
    ];
    for (const patch of collisions) {
      assert.throws(() => tradeSessionSpec({ ...DCA_INPUT, ...patch }), InvalidSessionSpecError, JSON.stringify(patch));
    }
  });

  it("without nfpm the template is byte-identical: the same spec minus the three NFPM rules", () => {
    const { nfpm: _nfpm, ...existing } = DCA_INPUT;
    const withNfpm = tradeSessionSpec(DCA_INPUT);
    const without = tradeSessionSpec(existing);
    assert.deepEqual(without, { ...withNfpm, allowedCalls: withNfpm.allowedCalls.slice(0, -3) });
    // An existing caller whose addresses collide in ways the NFPM check would name still builds.
    const legacy = tradeSessionSpec({ ...existing, treasury: GUARD });
    assert.equal(legacy.allowedCalls.length, 11);
  });
});

describe("R2.9 — nativeReserveFloor's exitReserveWei (REVIEW2 condition 6)", () => {
  const meter = { limitWei: 10n ** 16n, currentSpentWei: 0n, submissionNativeWei: 2n * 10n ** 14n };

  it("absent ⇒ exitReserveWei(max(1, grantedTokenCount)), byte-identical for existing callers, including a zero-token grant", () => {
    for (const grantedTokenCount of [0, 1, 4, 28]) {
      const floor = nativeReserveFloor({ ...meter, grantedTokenCount });
      assert.equal(floor.reserveWei, exitReserveWei(grantedTokenCount));
      assert.deepEqual(floor, nativeReserveFloor({ ...meter, grantedTokenCount, exitReserveWei: exitReserveWei(grantedTokenCount) }));
    }
    assert.equal(nativeReserveFloor({ ...meter, grantedTokenCount: 0 }).reserveWei, 10n ** 14n, "one exit, never zero");
  });

  it("a DCA non-sweep submission must leave 2 × R_DCA", () => {
    const reserve = 2n * R_DCA;
    const own = 10n ** 14n;
    const exact = { limitWei: meter.submissionNativeWei + own + reserve, currentSpentWei: 0n, submissionNativeWei: meter.submissionNativeWei, grantedTokenCount: 1 };
    assert.equal(nativeReserveFloor({ ...exact, exitReserveWei: reserve }).sufficient, true);
    assert.equal(nativeReserveFloor({ ...exact, exitReserveWei: reserve, currentSpentWei: 1n }).sufficient, false);
    assert.equal(nativeReserveFloor({ ...exact, exitReserveWei: reserve }).reserveWei, 640_000_000_000_000n);
  });
});

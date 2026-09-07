/**
 * `lpSessionSpec` — the LP session template (PHASE3 R2, Rev2 items 3–6, 14–15,
 * 24, 30).
 *
 * The selector list asserted here is written as LITERALS, independently of the
 * `NFPM_GRANTED_SELECTORS` export, so a drive-by edit widening the template
 * cannot also widen the test. Each selector was located in the deployed NFPM
 * bytecode (PHASE3-REVIEW.md, on-chain facts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseEther, toFunctionSelector } from "viem";
import { validateSessionSpec } from "../src/core/session.js";
import { InvalidSessionSpecError } from "../src/core/types.js";
import {
  APPROVE_SELECTOR,
  WBNB_DEPOSIT_SELECTOR,
  DEFAULT_TOKEN_CAP_LIMIT,
  MAX_LP_SESSION_SECONDS,
  MAX_TRADE_SESSION_SECONDS,
  grantsTokenSell,
  grantsTreasury,
  lpSessionSpec,
} from "../src/ops/policy.js";

const NFPM = getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
const ROUTER_V3 = getAddress("0x1b81D678ffb9C0263b24A97847620C99d213eB14");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x00000000000000000000000000000000000000AA");
const TREASURY = getAddress("0x000000000000000000000000000000000000dEaD");

const NOW = 1_700_000_000;

/**
 * The enumerated NFPM grant, verbatim from Rev2 item 3, as independent
 * literals with their bytecode-verified selectors.
 */
const EXPECTED_NFPM_GRANT: readonly (readonly [string, string])[] = [
  [
    "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
    "0x88316456",
  ],
  [
    "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))",
    "0x219f5d17",
  ],
  ["decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))", "0x0c49ccbe"],
  ["collect((uint256,address,uint128,uint128))", "0xfc6f7865"],
  ["burn(uint256)", "0x42966c68"],
  ["refundETH()", "0x12210e8a"],
  ["unwrapWETH9(uint256,address)", "0x49404b7c"],
  ["sweepToken(address,uint256,address)", "0xdf2ab5bb"],
];

const baseInput = {
  nfpm: NFPM,
  routerV3: ROUTER_V3,
  wbnb: { token: WBNB },
  token: { token: TOKEN },
  treasury: TREASURY,
  nativeCaps: [{ limit: parseEther("0.05"), period: "day" }],
  expiresAt: NOW + 3_600,
  nowSeconds: NOW,
} as const;

describe("lpSessionSpec: the NFPM grant shape (Rev2 items 3-4)", () => {
  it("grants EXACTLY the enumerated selector set on the NFPM, nothing else", () => {
    const spec = lpSessionSpec(baseInput);
    const nfpmRules = spec.allowedCalls.filter(
      (rule) => rule.to?.toLowerCase() === NFPM.toLowerCase(),
    );
    assert.deepEqual(
      nfpmRules.map((rule) => rule.selector).toSorted(),
      EXPECTED_NFPM_GRANT.map(([signature]) => signature).toSorted(),
    );
    // And each canonical form selects what the deployed dispatcher dispatches.
    for (const [signature, selector] of EXPECTED_NFPM_GRANT) {
      assert.equal(toFunctionSelector(signature), selector);
    }
  });

  it("never grants the NFPM target-only", () => {
    const spec = lpSessionSpec(baseInput);
    for (const rule of spec.allowedCalls) {
      if (rule.to?.toLowerCase() === NFPM.toLowerCase()) {
        assert.notEqual(
          rule.selector,
          undefined,
          "a target-only NFPM rule permits setApprovalForAll",
        );
      }
    }
  });

  it("grants no approve/setApprovalForAll/safeTransferFrom/transferFrom on the NFPM, and no multicall anywhere", () => {
    const spec = lpSessionSpec(baseInput);
    const forbiddenNames = [
      "approve",
      "setApprovalForAll",
      "safeTransferFrom",
      "transferFrom",
    ];
    for (const rule of spec.allowedCalls) {
      const name = rule.selector?.slice(0, rule.selector.indexOf("("));
      if (rule.to?.toLowerCase() === NFPM.toLowerCase()) {
        assert.ok(
          name === undefined || !forbiddenNames.includes(name),
          `NFPM rule grants ${name}`,
        );
      }
      // Rev2 item 3's mechanism: a multicall grant is a target-only grant in
      // disguise on ANY Multicall-bearing periphery, so the template grants it
      // nowhere — the router keeps multicall reachable via its (deliberate)
      // target-only rule, never via a selector grant.
      assert.notEqual(name, "multicall");
    }
  });
});

describe("lpSessionSpec: router, approves, treasury, caps", () => {
  it("grants the V3 router target-only, exactly as tradeSessionSpec's venue rule", () => {
    const spec = lpSessionSpec(baseInput);
    const routerRules = spec.allowedCalls.filter(
      (rule) => rule.to?.toLowerCase() === ROUTER_V3.toLowerCase(),
    );
    assert.deepEqual(routerRules, [{ to: ROUTER_V3 }]);
  });

  it("grants target-bound approve AND a matching cap for BOTH legs (open => exitable)", () => {
    const spec = lpSessionSpec(baseInput);
    for (const leg of [TOKEN, WBNB]) {
      const approveRules = spec.allowedCalls.filter(
        (rule) => rule.to?.toLowerCase() === leg.toLowerCase(),
      );
      // PHASE3.19 C3 — A DECLARED EDIT to a shipped assertion (review2 N7).
      //
      // Work-order item 1 adds ONE rule, `{ to: wbnb, selector: "deposit()" }`,
      // so the WBNB filter now returns TWO rules and the old single-element
      // `deepEqual` cannot stand. It is rewritten to pin the EXACT SET rather
      // than merely tolerate growth: the token leg still carries `approve` and
      // nothing else, the WBNB leg carries `approve` AND `deposit()` in that
      // order, and `withdraw(uint256)` is asserted ABSENT — the one selector the
      // review refused alongside the one it granted.
      assert.deepEqual(
        approveRules,
        leg === WBNB
          ? [
              { to: leg, selector: APPROVE_SELECTOR },
              { to: leg, selector: WBNB_DEPOSIT_SELECTOR },
            ]
          : [{ to: leg, selector: APPROVE_SELECTOR }],
      );
      assert.equal(
        approveRules.some((rule) => rule.selector === "withdraw(uint256)"),
        false,
        "withdraw(uint256) must NEVER be granted: nothing in the ladder unwraps",
      );
      // Both halves, always — either alone is FINDINGS (h)/(u).
      assert.ok(grantsTokenSell(spec, leg), `${leg} is not exitable`);
    }
    // The default cap is the 2.3-R4 gate, not a budget: rotations re-approve
    // the same principal every cycle, so a finite cap is a trapped exit.
    for (const leg of [TOKEN, WBNB]) {
      const cap = spec.spendCaps.find(
        (entry) => entry.token?.toLowerCase() === leg.toLowerCase(),
      );
      assert.deepEqual(cap, {
        token: leg,
        limit: DEFAULT_TOKEN_CAP_LIMIT,
        period: "day",
      });
    }
  });

  it("respects caller-set per-leg cap limits and periods", () => {
    const spec = lpSessionSpec({
      ...baseInput,
      token: { token: TOKEN, limit: 123n, period: "week" },
    });
    const cap = spec.spendCaps.find(
      (entry) => entry.token?.toLowerCase() === TOKEN.toLowerCase(),
    );
    assert.deepEqual(cap, { token: TOKEN, limit: 123n, period: "week" });
  });

  it("grants the treasury target-only even though LP is fee-free in v1 (Rev2 item 30)", () => {
    const spec = lpSessionSpec(baseInput);
    assert.ok(grantsTreasury(spec, TREASURY));
    const treasuryRules = spec.allowedCalls.filter(
      (rule) => rule.to?.toLowerCase() === TREASURY.toLowerCase(),
    );
    assert.deepEqual(treasuryRules, [{ to: TREASURY }]);
    // No token cap for the treasury: it is not a token, and the future fee is
    // a NATIVE transfer metered by the native cap (2.3 R10 verbatim).
    assert.equal(
      spec.spendCaps.some(
        (cap) => cap.token?.toLowerCase() === TREASURY.toLowerCase(),
      ),
      false,
    );
  });

  it("emits a spec validateSessionSpec accepts, with every value-mover capped", () => {
    const spec = lpSessionSpec(baseInput);
    const permissions = validateSessionSpec(spec, {
      nowSeconds: NOW,
      maxSessionSeconds: MAX_LP_SESSION_SECONDS,
    });
    // PHASE3.19 C3 — the SECOND declared edit. 8 NFPM selectors + router +
    // 2 approves + WBNB deposit() + treasury = 13.
    assert.equal(permissions.calls.length, 13);
    // native + WBNB + TOKEN.
    assert.equal(permissions.spend.length, 3);
  });

  it("carries the native caps verbatim", () => {
    const spec = lpSessionSpec(baseInput);
    const native = spec.spendCaps.filter((cap) => cap.token === undefined);
    assert.deepEqual(native, [{ limit: parseEther("0.05"), period: "day" }]);
  });
});

describe("lpSessionSpec: refusals and the expiry clamp", () => {
  it("clamps the expiry to the 7-day LP ceiling", () => {
    assert.equal(MAX_LP_SESSION_SECONDS, MAX_TRADE_SESSION_SECONDS);
    const spec = lpSessionSpec({
      ...baseInput,
      expiresAt: NOW + 365 * 24 * 60 * 60,
    });
    assert.equal(spec.expiresAt, NOW + MAX_LP_SESSION_SECONDS);
  });

  it("refuses an empty native cap list and a token smuggled into nativeCaps", () => {
    assert.throws(
      () => lpSessionSpec({ ...baseInput, nativeCaps: [] }),
      InvalidSessionSpecError,
    );
    assert.throws(
      () =>
        lpSessionSpec({
          ...baseInput,
          nativeCaps: [{ limit: 5n, period: "day", token: TOKEN }],
        }),
      /names a token/,
    );
  });

  it("refuses any role collision — identical legs, NFPM-as-anything, treasury-as-leg", () => {
    // token === wbnb: identical legs.
    assert.throws(
      () => lpSessionSpec({ ...baseInput, token: { token: WBNB } }),
      /same address/,
    );
    // token === nfpm would emit an approve rule ON the NFPM (item 4's list).
    assert.throws(
      () => lpSessionSpec({ ...baseInput, token: { token: NFPM } }),
      /same address/,
    );
    // treasury === nfpm would be `{ to: NFPM }` target-only in disguise.
    assert.throws(
      () => lpSessionSpec({ ...baseInput, treasury: NFPM }),
      /same address/,
    );
    // routerV3 === nfpm likewise.
    assert.throws(
      () => lpSessionSpec({ ...baseInput, routerV3: NFPM }),
      /same address/,
    );
    // treasury === token: an uncapped target-only rule on an ERC-20 is
    // unlimited transfer.
    assert.throws(
      () => lpSessionSpec({ ...baseInput, treasury: TOKEN }),
      /same address/,
    );
  });

  it("refuses an expiry already in the past (the clamp cannot fix that)", () => {
    assert.throws(
      () => lpSessionSpec({ ...baseInput, expiresAt: NOW - 1 }),
      InvalidSessionSpecError,
    );
  });
});

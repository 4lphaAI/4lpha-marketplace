/**
 * Offline tests for session-policy validation and translation.
 *
 * No network, no SDK behaviour is simulated. These cover the pure logic that
 * decides whether a policy is safe to send to a provider at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, toFunctionSelector } from "viem";
import {
  DEFAULT_MAX_SESSION_SECONDS,
  isSessionExpired,
  validateSessionSpec,
} from "../src/core/session.js";
import { InvalidSessionSpecError, type SessionSpec } from "../src/core/types.js";

const NOW = 1_800_000_000;
const TARGET = "0x000000000000000000000000000000000000dEaD";
const TOKEN = "0x55d398326f99059fF775485246999027B3197955";

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    allowedCalls: [{ to: TARGET }],
    spendCaps: [{ limit: parseEther("0.1"), period: "day" }],
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

describe("validateSessionSpec", () => {
  it("translates a well-formed spec into provider permissions", () => {
    const permissions = validateSessionSpec(spec(), { nowSeconds: NOW });

    assert.deepEqual(permissions.calls, [{ to: TARGET }]);
    assert.deepEqual(permissions.spend, [
      { limit: parseEther("0.1"), period: "day" },
    ]);
  });

  it("checksums addresses so on-chain comparisons are stable", () => {
    const permissions = validateSessionSpec(
      spec({ allowedCalls: [{ to: TARGET.toLowerCase() as `0x${string}` }] }),
      { nowSeconds: NOW },
    );

    assert.deepEqual(permissions.calls, [{ to: TARGET }]);
  });

  it("pairs a selector with its target using AND semantics", () => {
    const permissions = validateSessionSpec(
      spec({
        // The matching cap is required, not decorative: permitting transfer()
        // on a token with no cap FOR THAT TOKEN is an uncapped allowance.
        allowedCalls: [{ to: TOKEN, selector: "transfer(address,uint256)" }],
        spendCaps: [{ limit: 5n, period: "day", token: TOKEN }],
      }),
      { nowSeconds: NOW },
    );

    assert.deepEqual(permissions.calls, [
      { to: TOKEN, signature: "transfer(address,uint256)" },
    ]);
  });

  it("omits the token field entirely for native caps", () => {
    const [cap] = validateSessionSpec(spec(), { nowSeconds: NOW }).spend;

    // Not merely undefined: the SDK distinguishes an absent key from an
    // explicit undefined when it builds the on-chain key descriptor.
    assert.equal(Object.hasOwn(cap ?? {}, "token"), false);
  });

  it("keeps an explicit ERC-20 cap token", () => {
    const permissions = validateSessionSpec(
      spec({ spendCaps: [{ limit: 5n, period: "week", token: TOKEN }] }),
      { nowSeconds: NOW },
    );

    assert.deepEqual(permissions.spend, [
      { limit: 5n, period: "week", token: TOKEN },
    ]);
  });

  it("rejects an empty allowlist, which would mean unrestricted targets", () => {
    assert.throws(
      () => validateSessionSpec(spec({ allowedCalls: [] }), { nowSeconds: NOW }),
      InvalidSessionSpecError,
    );
  });

  it("rejects an empty cap list, which would mean unlimited spending", () => {
    assert.throws(
      () => validateSessionSpec(spec({ spendCaps: [] }), { nowSeconds: NOW }),
      InvalidSessionSpecError,
    );
  });

  it("rejects a rule that constrains neither target nor selector", () => {
    assert.throws(
      () => validateSessionSpec(spec({ allowedCalls: [{}] }), { nowSeconds: NOW }),
      InvalidSessionSpecError,
    );
  });

  it("rejects a malformed function signature", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ allowedCalls: [{ selector: "transfer" }] }), {
          nowSeconds: NOW,
        }),
      InvalidSessionSpecError,
    );
  });

  it("rejects an invalid target address", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ allowedCalls: [{ to: "0x1234" as `0x${string}` }] }),
          { nowSeconds: NOW },
        ),
      InvalidSessionSpecError,
    );
  });

  it("rejects a zero or negative cap", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ spendCaps: [{ limit: 0n, period: "day" }] }), {
          nowSeconds: NOW,
        }),
      InvalidSessionSpecError,
    );
  });

  it("rejects two caps covering the same token and period", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({
            spendCaps: [
              { limit: 1n, period: "day" },
              { limit: 2n, period: "day" },
            ],
          }),
          { nowSeconds: NOW },
        ),
      InvalidSessionSpecError,
    );
  });

  it("allows the same token capped over different periods", () => {
    const permissions = validateSessionSpec(
      spec({
        spendCaps: [
          { limit: 1n, period: "day" },
          { limit: 2n, period: "month" },
        ],
      }),
      { nowSeconds: NOW },
    );

    assert.equal(permissions.spend.length, 2);
  });

  it("rejects an expiry in the past", () => {
    assert.throws(
      () => validateSessionSpec(spec({ expiresAt: NOW - 1 }), { nowSeconds: NOW }),
      InvalidSessionSpecError,
    );
  });

  it("rejects a non-integer expiry", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ expiresAt: NOW + 0.5 }), { nowSeconds: NOW }),
      InvalidSessionSpecError,
    );
  });

  it("rejects a session longer than the maximum horizon", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ expiresAt: NOW + DEFAULT_MAX_SESSION_SECONDS + 1 }),
          { nowSeconds: NOW },
        ),
      InvalidSessionSpecError,
    );
  });

  it("honours a caller-supplied maximum horizon", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ expiresAt: NOW + 120 }), {
          nowSeconds: NOW,
          maxSessionSeconds: 60,
        }),
      InvalidSessionSpecError,
    );
  });
});

describe("tuple canonicalization (PHASE3 R1)", () => {
  // The expected selectors are INDEPENDENT evidence — read from the deployed
  // NFPM / SwapRouter bytecode (PHASE3-REVIEW.md facts section), written here
  // as literals. Deriving them from the code under test would make the
  // assertion circular: the old reconstruction canonicalized every one of
  // these to `name(tuple)` and its selector cross-check refused the rule, so
  // no grant containing a tuple could exist at all.
  const TUPLE_SIGNATURES = [
    [
      "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
      "0x88316456",
    ],
    [
      "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))",
      "0x219f5d17",
    ],
    [
      "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
      "0x0c49ccbe",
    ],
    ["collect((uint256,address,uint128,uint128))", "0xfc6f7865"],
    [
      "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
      "0x414bf389",
    ],
  ] as const;

  for (const [signature, selector] of TUPLE_SIGNATURES) {
    const name = signature.slice(0, signature.indexOf("("));
    it(`grants ${name} and emits a signature selecting ${selector}`, () => {
      const permissions = validateSessionSpec(
        spec({ allowedCalls: [{ to: TARGET, selector: signature }] }),
        { nowSeconds: NOW },
      );

      const [call] = permissions.calls;
      assert.ok(call !== undefined && "signature" in call);
      // The canonical form must expand tuple components, not flatten them to
      // the literal "tuple" — the emitted signature is what the provider
      // hashes into the on-chain key descriptor, so it must select what the
      // deployed contract dispatches on.
      assert.equal(call.signature, signature);
      assert.equal(toFunctionSelector(call.signature), selector);
    });
  }

  it("still refuses a non-canonical signature", () => {
    // `transfer(address,uint)` hashes to 0x6cb927d8; the canonical
    // `transfer(address,uint256)` to 0xa9059cbb. Tuple expansion must not
    // have widened the grammar for anything else.
    assert.throws(
      () =>
        validateSessionSpec(
          spec({
            allowedCalls: [{ to: TOKEN, selector: "transfer(address,uint)" }],
            spendCaps: [{ limit: 5n, period: "day", token: TOKEN }],
          }),
          { nowSeconds: NOW },
        ),
      /not canonical/i,
    );
  });
});

describe("flat-signature regression pin (PHASE3 R1)", () => {
  it("re-validates a tradeSessionSpec-shaped spec to the pre-change permission bytes", () => {
    // Granted permissions are part of the on-chain key descriptor: a session
    // rebuilt from persisted facts must hash to what was granted. The expected
    // object below was captured from the OLD reconstruction's output before
    // the switch to `toFunctionSignature`, so this test failing means an
    // existing grant no longer re-validates — a breaking change to every
    // hired agent, not a formatting nit. Shape mirrors `tradeSessionSpec`:
    // target-only venue + treasury rules, a target-bound approve per token,
    // native cap plus a per-token cap.
    const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

    const permissions = validateSessionSpec(
      {
        allowedCalls: [
          { to: ROUTER },
          { to: TOKEN, selector: "approve(address,uint256)" },
          { to: TARGET },
        ],
        spendCaps: [
          { limit: parseEther("0.1"), period: "day" },
          { limit: 5_000_000n, period: "day", token: TOKEN },
        ],
        expiresAt: NOW + 3600,
      },
      { nowSeconds: NOW },
    );

    assert.deepEqual(permissions, {
      calls: [
        { to: "0x000000000000000000000000000000000000dEaD" },
        { to: "0x10ED43C718714eb63d5aA57B78B54704E256024E" },
        {
          to: "0x55d398326f99059fF775485246999027B3197955",
          signature: "approve(address,uint256)",
        },
      ],
      spend: [
        // Token caps sort BEFORE the native cap: the sort key prefixes the
        // token address, and the empty native prefix puts the "|" separator
        // (0x7C) first, which orders after any hex digit.
        {
          limit: 5_000_000n,
          period: "day",
          token: "0x55d398326f99059fF775485246999027B3197955",
        },
        { limit: 100_000_000_000_000_000n, period: "day" },
      ],
    });
  });
});

describe("isSessionExpired", () => {
  it("is false before the expiry", () => {
    assert.equal(isSessionExpired(spec(), NOW), false);
  });

  it("is true at the expiry instant", () => {
    assert.equal(isSessionExpired(spec({ expiresAt: NOW }), NOW), true);
  });

  it("is true after the expiry", () => {
    assert.equal(isSessionExpired(spec({ expiresAt: NOW - 1 }), NOW), true);
  });
});

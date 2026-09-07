/**
 * Offline tests for the over-grant defences in `validateSessionSpec`.
 *
 * The existing `session.test.ts` checks that well-formed policies translate
 * correctly. This file checks the opposite direction: policies that LOOK
 * scoped and are not. Every case here produced a permission object the SDK
 * would happily have accepted, and each one hands an agent more authority than
 * the person writing the policy believed they were granting.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, toFunctionSelector, type Address } from "viem";
import { MIN_SESSION_SECONDS, validateSessionSpec } from "../src/core/session.js";
import { InvalidSessionSpecError, type SessionSpec } from "../src/core/types.js";

const NOW = 1_800_000_000;
const WALLET = "0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4" as Address;
/** BNB mainnet AltanaKeyStore. */
const KEYSTORE = "0x6b8361C29d05D498b1a12B54A37310f94171E94A" as Address;
const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;
const USDT = "0x55d398326f99059fF775485246999027B3197955" as Address;
const TARGET = "0x000000000000000000000000000000000000dEaD" as Address;

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    allowedCalls: [{ to: TARGET }],
    spendCaps: [{ limit: parseEther("0.1"), period: "day" }],
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

describe("bare-selector rules", () => {
  it("rejects a selector with no target, which permits it on every contract", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ allowedCalls: [{ selector: "transfer(address,uint256)" }] }),
          { nowSeconds: NOW },
        ),
      /EVERY contract/,
    );
  });

  it("REJECTS a value-moving one even when the spec opts in (PHASE2.3 R2)", () => {
    // THIS TEST FLIPPED. It used to assert that `transfer` with no `to`
    // validates CLEAN under the opt-in, and that shape is exactly FINDINGS (h):
    // the trade template granted a bare-selector `approve`, no spend cap could
    // name the token it would be called on, and the resulting session could buy
    // and never sell. The flag cannot excuse a function that moves value — and
    // "unless the caller opted in" would be a no-op escape, since
    // `validateCallRule` already throws for a bare selector when the flag is
    // UNSET, so the only rules that reach the guard are ones where it is set.
    assert.throws(
      () =>
        validateSessionSpec(
          spec({
            allowedCalls: [{ selector: "transfer(address,uint256)" }],
            allowUnrestrictedSelector: true,
          }),
          { nowSeconds: NOW },
        ),
      /EVERY contract on the chain, so no spend cap can bound it/,
    );
  });

  it("rejects every value-moving bare selector, flag or no flag", () => {
    for (const selector of [
      "transfer(address,uint256)",
      "transferFrom(address,address,uint256)",
      "approve(address,uint256)",
      "increaseAllowance(address,uint256)",
    ]) {
      assert.throws(
        () =>
          validateSessionSpec(
            spec({ allowedCalls: [{ selector }], allowUnrestrictedSelector: true }),
            { nowSeconds: NOW },
          ),
        InvalidSessionSpecError,
        selector,
      );
    }
  });

  it("still accepts a NON-value-moving bare selector under the opt-in", () => {
    // The carve-out, and the regression pin for it: R2 must refuse the four
    // value-moving functions, not every bare selector. A yield agent's
    // `harvest()` on any farm is still expressible.
    for (const selector of ["harvest()", "compound()"]) {
      const permissions = validateSessionSpec(
        spec({ allowedCalls: [{ selector }], allowUnrestrictedSelector: true }),
        { nowSeconds: NOW },
      );
      assert.deepEqual(permissions.calls, [{ signature: selector }]);
    }
  });

  it("does not let the opt-in excuse a rule that constrains nothing at all", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ allowedCalls: [{}], allowUnrestrictedSelector: true }), {
          nowSeconds: NOW,
        }),
      InvalidSessionSpecError,
    );
  });
});

describe("escalation targets", () => {
  it("rejects a rule pointing back at the wallet itself", () => {
    // The wallet IS the owner's EOA under EIP-7702, and the account's admin
    // entry points are gated on `msg.sender == address(this)`. A session
    // allowed to call the wallet can authorize its own new keys.
    assert.throws(
      () =>
        validateSessionSpec(spec({ allowedCalls: [{ to: WALLET }] }), {
          nowSeconds: NOW,
          walletAddress: WALLET,
        }),
      /wallet itself/i,
    );
  });

  it("rejects a self-target given in a different checksum casing", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ allowedCalls: [{ to: WALLET.toLowerCase() as Address }] }),
          { nowSeconds: NOW, walletAddress: WALLET },
        ),
      /wallet itself/i,
    );
  });

  it("rejects a rule pointing at the key registry", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ allowedCalls: [{ to: KEYSTORE }] }), {
          nowSeconds: NOW,
          keyStoreAddress: KEYSTORE,
        }),
      /key registry/i,
    );
  });

  it("still allows ordinary targets when both addresses are known", () => {
    const permissions = validateSessionSpec(spec({ allowedCalls: [{ to: ROUTER }] }), {
      nowSeconds: NOW,
      walletAddress: WALLET,
      keyStoreAddress: KEYSTORE,
    });

    assert.deepEqual(permissions.calls, [{ to: ROUTER }]);
  });
});

describe("selector canonicalization", () => {
  it("rejects uint where the ABI means uint256", () => {
    // `transfer(address,uint)` hashes to 0x6cb927d8; every real ERC-20 uses
    // 0xa9059cbb. The grant would look correct and permit nothing.
    assert.notEqual(
      toFunctionSelector("transfer(address,uint)"),
      toFunctionSelector("transfer(address,uint256)"),
    );

    assert.throws(
      () =>
        validateSessionSpec(
          spec({
            allowedCalls: [{ to: USDT, selector: "transfer(address,uint)" }],
            spendCaps: [{ limit: 1n, period: "day", token: USDT }],
          }),
          { nowSeconds: NOW },
        ),
      /not canonical/i,
    );
  });

  it("rejects an unknown Solidity type", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ allowedCalls: [{ to: ROUTER, selector: "swap(notatype)" }] }),
          { nowSeconds: NOW },
        ),
      /function signature/i,
    );
  });

  it("rejects a bare function name", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ allowedCalls: [{ to: ROUTER, selector: "transfer" }] }), {
          nowSeconds: NOW,
        }),
      /function signature/i,
    );
  });

  it("accepts a zero-argument signature", () => {
    const permissions = validateSessionSpec(
      spec({ allowedCalls: [{ to: ROUTER, selector: "harvest()" }] }),
      { nowSeconds: NOW },
    );

    assert.deepEqual(permissions.calls, [{ to: ROUTER, signature: "harvest()" }]);
  });
});

describe("canonical ordering", () => {
  it("produces byte-identical output regardless of input order", () => {
    // The permissions are part of the on-chain key descriptor. A session
    // rebuilt from persisted facts in a different array order must hash to the
    // same key, or the rebuilt session is simply unusable.
    const calls = [{ to: ROUTER }, { to: TARGET }, { to: USDT }];
    const caps = [
      { limit: 1n, period: "day" as const },
      { limit: 2n, period: "hour" as const, token: USDT },
      { limit: 3n, period: "week" as const },
    ];

    const forwards = validateSessionSpec(
      spec({ allowedCalls: calls, spendCaps: caps }),
      { nowSeconds: NOW },
    );
    const backwards = validateSessionSpec(
      spec({ allowedCalls: [...calls].reverse(), spendCaps: [...caps].reverse() }),
      { nowSeconds: NOW },
    );

    assert.deepEqual(forwards, backwards);
    assert.equal(
      JSON.stringify(forwards, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      JSON.stringify(backwards, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  });

  it("orders rules with the same target by signature", () => {
    const permissions = validateSessionSpec(
      spec({
        allowedCalls: [
          { to: ROUTER, selector: "harvest()" },
          { to: ROUTER, selector: "compound()" },
        ],
      }),
      { nowSeconds: NOW },
    );

    assert.deepEqual(permissions.calls, [
      { to: ROUTER, signature: "compound()" },
      { to: ROUTER, signature: "harvest()" },
    ]);
  });
});

describe("session length", () => {
  it("rejects a TTL below the minimum, which expires before it can be used", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ expiresAt: NOW + MIN_SESSION_SECONDS - 1 }), {
          nowSeconds: NOW,
        }),
      /minimum session length/i,
    );
  });

  it("accepts exactly the minimum", () => {
    assert.doesNotThrow(() =>
      validateSessionSpec(spec({ expiresAt: NOW + MIN_SESSION_SECONDS }), {
        nowSeconds: NOW,
      }),
    );
  });

  it("honours a caller-supplied minimum", () => {
    assert.throws(
      () =>
        validateSessionSpec(spec({ expiresAt: NOW + 300 }), {
          nowSeconds: NOW,
          minSessionSeconds: 600,
        }),
      /minimum session length/i,
    );
  });
});

describe("token movers require a matching cap", () => {
  it("rejects transfer() on a token with no cap for that token", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ allowedCalls: [{ to: USDT, selector: "transfer(address,uint256)" }] }),
          { nowSeconds: NOW },
        ),
      /no entry for that token/i,
    );
  });

  it("rejects approve() on a token with no cap for that token", () => {
    assert.throws(
      () =>
        validateSessionSpec(
          spec({ allowedCalls: [{ to: USDT, selector: "approve(address,uint256)" }] }),
          { nowSeconds: NOW },
        ),
      /no entry for that token/i,
    );
  });

  it("accepts it once the token is capped", () => {
    const permissions = validateSessionSpec(
      spec({
        allowedCalls: [{ to: USDT, selector: "transferFrom(address,address,uint256)" }],
        spendCaps: [{ limit: 10n, period: "day", token: USDT }],
      }),
      { nowSeconds: NOW },
    );

    assert.equal(permissions.calls.length, 1);
  });

  it("does not flag a non-value-moving function", () => {
    assert.doesNotThrow(() =>
      validateSessionSpec(
        spec({ allowedCalls: [{ to: USDT, selector: "balanceOf(address)" }] }),
        { nowSeconds: NOW },
      ),
    );
  });
});

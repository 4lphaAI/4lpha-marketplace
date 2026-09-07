/**
 * Offline tests for the shared canonical encoder.
 *
 * This is the load-bearing determinism the whole owner-action binding rests on:
 * if the signer and the verifier encode the same parameters to different bytes,
 * the paramsHash comparison is meaningless. Each property below is exactly what
 * "encoded identically regardless of incidental representation" means.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { canonicalEncode, paramsHash } from "../src/auth/canonical.js";

const ADDR = "0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4";

describe("canonicalEncode — determinism", () => {
  it("is independent of object key order", () => {
    const a = canonicalEncode({ b: 1n, a: "x", c: [1, 2, 3] });
    const b = canonicalEncode({ c: [1, 2, 3], a: "x", b: 1n });
    assert.equal(a, b);
  });

  it("is independent of address casing", () => {
    const lower = canonicalEncode({ to: ADDR.toLowerCase() });
    const checksummed = canonicalEncode({ to: getAddress(ADDR) });
    const upper = canonicalEncode({ to: `0x${ADDR.slice(2).toUpperCase()}` });
    assert.equal(lower, checksummed);
    assert.equal(lower, upper);
    assert.match(lower, new RegExp(ADDR.toLowerCase()));
  });

  it("renders a bigint in one stable form regardless of construction", () => {
    assert.equal(canonicalEncode(10n ** 20n), canonicalEncode(BigInt("100000000000000000000")));
  });

  it("keeps array order significant", () => {
    assert.notEqual(canonicalEncode([1, 2]), canonicalEncode([2, 1]));
  });

  it("does not collide a number, a string and a bigint of equal value", () => {
    const n = canonicalEncode(1);
    const s = canonicalEncode("1");
    const b = canonicalEncode(1n);
    assert.notEqual(n, s);
    assert.notEqual(n, b);
    assert.notEqual(s, b);
  });

  it("drops undefined-valued keys, matching an omitted optional", () => {
    assert.equal(
      canonicalEncode({ a: 1, b: undefined }),
      canonicalEncode({ a: 1 }),
    );
  });

  it("handles nested structures deterministically", () => {
    const value = {
      spec: {
        spendCaps: [{ limit: 5n, period: "day", token: getAddress(ADDR) }],
        allowedCalls: [{ to: ADDR.toLowerCase(), selector: "transfer(address,uint256)" }],
        expiresAt: 1_900_000_000,
      },
      owner: getAddress(ADDR),
    };
    const shuffled = {
      owner: ADDR.toLowerCase(),
      spec: {
        expiresAt: 1_900_000_000,
        allowedCalls: [{ selector: "transfer(address,uint256)", to: getAddress(ADDR) }],
        spendCaps: [{ token: ADDR.toLowerCase(), period: "day", limit: 5n }],
      },
    };
    assert.equal(canonicalEncode(value), canonicalEncode(shuffled));
  });

  it("throws on a non-finite number", () => {
    assert.throws(() => canonicalEncode({ x: Number.NaN }), /non-finite/);
  });
});

describe("paramsHash", () => {
  it("binds the action: same params, different action ⇒ different hash", () => {
    const params = { to: ADDR };
    assert.notEqual(paramsHash("grant", params), paramsHash("recover", params));
  });

  it("binds the params: different params ⇒ different hash", () => {
    assert.notEqual(
      paramsHash("changeBudget", { amount: 1n }),
      paramsHash("changeBudget", { amount: 2n }),
    );
  });

  it("is stable across incidental representation", () => {
    const one = paramsHash("grant", { to: getAddress(ADDR), n: 7n });
    const two = paramsHash("grant", { n: 7n, to: ADDR.toLowerCase() });
    assert.equal(one, two);
  });

  it("returns a 32-byte hex", () => {
    assert.match(paramsHash("pause", {}), /^0x[0-9a-f]{64}$/);
  });
});

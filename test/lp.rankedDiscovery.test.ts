import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import type { SessionSpec } from "../src/core/types.js";
import { lpRankedDiscoveryToken } from "../src/lp/rankedDiscovery.js";

const WBNB = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN_A = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN_B = getAddress("0x3333333333333333333333333333333333333333");

function spec(tokens: readonly Address[]): SessionSpec {
  return {
    allowedCalls: tokens.map((token) => ({
      to: token,
      selector: "approve(address,uint256)",
    })),
    spendCaps: [
      { limit: 1n, period: "day" },
      { limit: 1n, period: "day", token: WBNB },
      ...tokens.map((token) => ({ limit: 1n, period: "day" as const, token })),
    ],
    expiresAt: 2_000_000_000,
  };
}

describe("lpRankedDiscoveryToken — persisted canonical LP universe", () => {
  it("returns the one non-WBNB token carrying approve plus cap", () => {
    const result = lpRankedDiscoveryToken(spec([TOKEN_A]), WBNB);
    assert.deepEqual(result, { ok: true, token: TOKEN_A });
  });

  it("deduplicates the same token across cap periods", () => {
    const value = spec([TOKEN_A]);
    const result = lpRankedDiscoveryToken(
      {
        ...value,
        spendCaps: [
          ...value.spendCaps,
          { limit: 2n, period: "minute", token: TOKEN_A.toLowerCase() as Address },
        ],
      },
      WBNB,
    );
    assert.deepEqual(result, { ok: true, token: TOKEN_A });
  });

  it("refuses zero candidates when the non-WBNB cap lacks approve authority", () => {
    const value = spec([]);
    const result = lpRankedDiscoveryToken(
      {
        ...value,
        spendCaps: [...value.spendCaps, { limit: 1n, period: "day", token: TOKEN_A }],
      },
      WBNB,
    );
    assert.deepEqual(result, { ok: false, candidateCount: 0 });
  });

  it("refuses a non-canonical persisted grant with multiple discovery tokens", () => {
    assert.deepEqual(lpRankedDiscoveryToken(spec([TOKEN_A, TOKEN_B]), WBNB), {
      ok: false,
      candidateCount: 2,
    });
  });
});

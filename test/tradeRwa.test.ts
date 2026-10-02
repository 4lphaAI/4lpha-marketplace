import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  RWA_VENUE_MAX_AGE_MS,
  RWA_VENUE_MAX_SKEW_MS,
  rwaEntryVerdict,
  rwaPremiumBps,
  type RwaFact,
} from "../src/trade/rwa.js";

const NOW = 1_900_000_000_000;
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const POOL = getAddress("0x1111111111111111111111111111111111111111");

function fact(premiumBps: number, asOf = NOW): RwaFact {
  return {
    platform: "bstock",
    underlyingTicker: "NVDA",
    tokenPriceUsd: 100,
    referencePriceUsd: 100,
    premiumBps: 999,
    openState: true,
    marketStatus: null,
    reasonCode: "TRADING",
    staleness: "fresh",
    tokenToShareRatio: 1,
    onchainPriceUsd: 100,
    venues: [{ dex: "uniswap", version: "v3", pool: POOL, feeTier: 500, quote: USDT,
      quoteSymbol: "USDT", priceUsd: 100 * (1 + premiumBps / 10_000), liquidityUsd: 10_000,
      volume24hUsd: 1, asOf }],
  };
}

describe("RWA reference-price guard", () => {
  it("computes the signed premium and uses the four final boundaries", () => {
    for (const [premium, expected] of [[-200, "discount:2.0%"], [0, "premium:+0.0%"], [150, "premium:+1.5%"]] as const) {
      assert.equal(rwaPremiumBps(fact(premium), NOW), premium);
      assert.deepEqual(rwaEntryVerdict(fact(premium), NOW), { kind: "allow", note: expected });
    }
    assert.deepEqual(rwaEntryVerdict(fact(151), NOW), { kind: "refuse", reason: "premium-too-high" });
    assert.deepEqual(rwaEntryVerdict(fact(-199), NOW), { kind: "allow", note: "premium:-2.0%" });
  });

  it("refuses missing, stale, halted and non-computable facts in order", () => {
    assert.deepEqual(rwaEntryVerdict(undefined, NOW), { kind: "refuse", reason: "rwa-unavailable" });
    assert.deepEqual(rwaEntryVerdict({ ...fact(0), staleness: "stale" }, NOW), { kind: "refuse", reason: "rwa-stale" });
    assert.deepEqual(rwaEntryVerdict({ ...fact(0), openState: false }, NOW), { kind: "refuse", reason: "issuer-not-trading" });
    assert.deepEqual(rwaEntryVerdict({ ...fact(0), venues: [] }, NOW), { kind: "refuse", reason: "venue-stale" });
    assert.deepEqual(rwaEntryVerdict({ ...fact(0), referencePriceUsd: 0 }, NOW), { kind: "refuse", reason: "premium-unknown" });
    assert.deepEqual(rwaEntryVerdict({ ...fact(0), tokenToShareRatio: Number.NaN }, NOW), { kind: "refuse", reason: "premium-unknown" });
  });

  it("accepts the exact future-skew and age limits, but not beyond them", () => {
    assert.equal(rwaPremiumBps(fact(0, NOW + RWA_VENUE_MAX_SKEW_MS), NOW), 0);
    assert.equal(rwaPremiumBps(fact(0, NOW + RWA_VENUE_MAX_SKEW_MS + 1), NOW), null);
    assert.equal(rwaPremiumBps(fact(0, NOW - RWA_VENUE_MAX_AGE_MS), NOW), 0);
    assert.equal(rwaPremiumBps(fact(0, NOW - RWA_VENUE_MAX_AGE_MS - 1), NOW), null);
    assert.equal(rwaPremiumBps(fact(0, NOW - 1.5), NOW), null);
  });

  it("does not trust the feed's premiumBps or an unrelated WBNB constant", () => {
    const current = fact(0);
    assert.equal(rwaPremiumBps({ ...current, premiumBps: 9_999 }, NOW), 0);
    assert.equal(current.venues?.[0]?.quote === WBNB, false);
  });
});

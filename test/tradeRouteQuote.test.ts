import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { PANCAKE_V3_QUOTER_V2_56 as LP_QUOTER } from "../src/lp/readers.js";
import {
  PANCAKE_V3_QUOTER_V2_56,
  TRADE_MAX_IMPACT_BPS,
  TradeRouteQuoteError,
  USDT_56,
  encodeV3Path,
  priceImpactBps,
  quoteBestBuyRoute,
  quoteSellAlongRoute,
  type RouteQuoteReader,
} from "../src/trade/route.js";

const TOKEN = getAddress("0x1111111111111111111111111111111111111111");

describe("TRADING-AGENT R3.5 route encoding", () => {
  it("pins the duplicated QuoterV2 address to the LP literal", () => {
    assert.equal(PANCAKE_V3_QUOTER_V2_56, LP_QUOTER);
  });

  it("encodes address + uint24 big-endian fee + address + fee + address", () => {
    assert.equal(
      encodeV3Path([
        getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
        USDT_56,
        TOKEN,
      ], [100, 500]),
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00006455d398326f99059ff775485246999027b31979550001f41111111111111111111111111111111111111111",
    );
  });

  it("ports the one-percent impact arithmetic", () => {
    assert.equal(priceImpactBps(9_500n, 100n), 500n);
    assert.equal(priceImpactBps(10_100n, 100n), 0n);
  });
});

describe("TRADING-AGENT C31 best buy route", () => {
  it("quotes exactly seven full paths, probes only the winner, and returns TradeRoute", async () => {
    let calls = 0;
    const reader: RouteQuoteReader = {
      async quoteV2(_path, amount) { calls += 1; return amount === 1n ? 10n : 1_000n; },
      async quoteV3Single(_in, _out, fee, amount) {
        calls += 1;
        if (amount === 1n) return 10n;
        return BigInt(1_000 + fee / 100);
      },
      async quoteV3Path(path, amount) {
        calls += 1;
        if (amount === 1n) return 20n;
        return path.includes("0001f4") ? 2_000n : 1_500n;
      },
    };
    const result = await quoteBestBuyRoute({ token: TOKEN, amountInWei: 100n, rpcUrls: [], reader });
    assert.equal(calls, 8);
    assert.equal(result.venue, "pancake_v3");
    assert.deepEqual(result.route, { hops: [USDT_56], fees: [500, 100] });
    assert.equal(result.amountOutWei, 2_000n);
    assert.equal(result.impactBps, 0n);
  });

  it("refuses when no path quotes", async () => {
    const reader: RouteQuoteReader = {
      async quoteV2() { throw new Error("missing"); },
      async quoteV3Single() { throw new Error("missing"); },
      async quoteV3Path() { throw new Error("missing"); },
    };
    await assert.rejects(
      quoteBestBuyRoute({ token: TOKEN, amountInWei: 100n, rpcUrls: [], reader }),
      (error: unknown) => error instanceof TradeRouteQuoteError && error.code === "NO_ROUTE",
    );
  });

  it("refuses a winner above the 300 bps impact ceiling", async () => {
    const reader: RouteQuoteReader = {
      async quoteV2(_path, amount) { return amount === 1n ? 20n : 1_000n; },
      async quoteV3Single() { throw new Error("missing"); },
      async quoteV3Path() { throw new Error("missing"); },
    };
    assert.ok(priceImpactBps(1_000n, 20n) > BigInt(TRADE_MAX_IMPACT_BPS));
    await assert.rejects(
      quoteBestBuyRoute({ token: TOKEN, amountInWei: 100n, rpcUrls: [], reader }),
      (error: unknown) => error instanceof TradeRouteQuoteError && error.code === "IMPACT_TOO_HIGH",
    );
  });
});

describe("quoteSellAlongRoute", () => {
  it("reverses V3 tokens and fee tiers", async () => {
    let pathSeen: Hex | null = null;
    const reader: RouteQuoteReader = {
      async quoteV2() { throw new Error("unexpected"); },
      async quoteV3Single() { throw new Error("unexpected"); },
      async quoteV3Path(path) { pathSeen = path; return 77n; },
    };
    assert.equal(await quoteSellAlongRoute({
      token: TOKEN,
      amountInWei: 5n,
      venue: "pancake_v3",
      route: { hops: [USDT_56], fees: [500, 100] },
      rpcUrls: [],
      reader,
    }), 77n);
    assert.equal(pathSeen, encodeV3Path([
      TOKEN,
      USDT_56,
      getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
    ], [100, 500]));
  });

  it("reverses a V2 hop list", async () => {
    let pathSeen: readonly Address[] = [];
    const reader: RouteQuoteReader = {
      async quoteV2(path) { pathSeen = path; return 9n; },
      async quoteV3Single() { throw new Error("unexpected"); },
      async quoteV3Path() { throw new Error("unexpected"); },
    };
    assert.equal(await quoteSellAlongRoute({
      token: TOKEN,
      amountInWei: 5n,
      venue: "pancake_v2",
      route: { hops: [USDT_56], fees: [] },
      rpcUrls: [],
      reader,
    }), 9n);
    assert.deepEqual(pathSeen, [TOKEN, USDT_56, getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")]);
  });
});

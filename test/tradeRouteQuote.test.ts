import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { PANCAKE_V3_QUOTER_V2_56 as LP_QUOTER } from "../src/lp/readers.js";
import {
  PANCAKE_V3_QUOTER_V2_56,
  TRADE_MAX_IMPACT_BPS,
  TradeRouteQuoteError,
  USDC_56,
  USDT_56,
  encodeV3Path,
  priceImpactBps,
  quoteBestBuyRoute,
  quoteSellAlongRoute,
  type RouteQuoteReader,
} from "../src/trade/route.js";
import type { VenueRow } from "../src/trade/dataPlaneReads.js";

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
      async quoteUniV3Single() { throw new Error("unexpected"); },
      async quoteUniV3Path() { throw new Error("unexpected"); },
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
      async quoteUniV3Single() { throw new Error("missing"); },
      async quoteUniV3Path() { throw new Error("missing"); },
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
      async quoteUniV3Single() { throw new Error("missing"); },
      async quoteUniV3Path() { throw new Error("missing"); },
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
      async quoteUniV3Single() { throw new Error("unexpected"); },
      async quoteUniV3Path() { throw new Error("unexpected"); },
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
      async quoteUniV3Single() { throw new Error("unexpected"); },
      async quoteUniV3Path() { throw new Error("unexpected"); },
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

  it("derives deterministic Uniswap direct and stable-quoted probes and chooses the winner", async () => {
    let calls = 0;
    const reader: RouteQuoteReader = {
      async quoteV2(_path, amount) { calls += 1; return amount; },
      async quoteV3Single(_in, _out, _fee, amount) { calls += 1; return amount; },
      async quoteV3Path(_path, amount) { calls += 1; return amount; },
      async quoteUniV3Single(_in, _out, fee, amount) { calls += 1; return fee === 3000 ? amount * 3n : amount; },
      async quoteUniV3Path(_path, amount) { calls += 1; return amount * 2n; },
    };
    const venues: readonly VenueRow[] = [
      { dex: "uniswap", version: "v3", pool: getAddress("0x2222222222222222222222222222222222222222"), feeTier: 3000,
        quote: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), quoteSymbol: "WBNB", priceUsd: 1,
        liquidityUsd: 100_000, volume24hUsd: 1, asOf: null },
      { dex: "uniswap", version: "v3", pool: getAddress("0x3333333333333333333333333333333333333333"), feeTier: 500,
        quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 99, volume24hUsd: 1, asOf: null },
      { dex: "uniswap", version: "v3", pool: getAddress("0x4444444444444444444444444444444444444444"), feeTier: 3000,
        quote: USDC_56, quoteSymbol: "USDC", priceUsd: 1, liquidityUsd: 98, volume24hUsd: 1, asOf: null },
      { dex: "uniswap", version: "v3", pool: getAddress("0x5555555555555555555555555555555555555555"), feeTier: 2500,
        quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 97, volume24hUsd: 1, asOf: null },
    ];
    const result = await quoteBestBuyRoute({ token: TOKEN, amountInWei: 100n, rpcUrls: [], reader, venues,
      uniswapRouter: getAddress("0x6666666666666666666666666666666666666666") });
    assert.equal(result.venue, "uniswap_v3");
    assert.deepEqual(result.route, { hops: [], fees: [3000] });
    assert.equal(result.amountOutWei, 300n);
    assert.equal(result.impactBps, 0n);
    assert.ok(calls <= 17, `quote bound exceeded: ${calls}`);
  });

  it("keeps Pancake-only behavior when the Uniswap quoter is absent", async () => {
    const reader: RouteQuoteReader = {
      async quoteV2(_path, amount) { return amount * 2n; },
      async quoteV3Single(_in, _out, _fee, amount) { return amount; },
      async quoteV3Path(_path, amount) { return amount; },
      async quoteUniV3Single() { throw new Error("unconfigured"); },
      async quoteUniV3Path() { throw new Error("unconfigured"); },
    };
    const result = await quoteBestBuyRoute({ token: TOKEN, amountInWei: 100n, rpcUrls: [], reader,
      venues: [{ dex: "uniswap", version: "v3", pool: getAddress("0x7777777777777777777777777777777777777777"), feeTier: 3000,
        quote: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), quoteSymbol: "WBNB", priceUsd: 1,
        liquidityUsd: 100_000, volume24hUsd: 1, asOf: null }],
      uniswapRouter: getAddress("0x8888888888888888888888888888888888888888") });
    assert.equal(result.venue, "pancake_v2");
  });

  it("quotes and reverses an Uniswap sell route", async () => {
    let pathSeen: Hex | null = null;
    const reader: RouteQuoteReader = {
      async quoteV2() { throw new Error("unexpected"); },
      async quoteV3Single() { throw new Error("unexpected"); },
      async quoteV3Path() { throw new Error("unexpected"); },
      async quoteUniV3Single() { throw new Error("unexpected"); },
      async quoteUniV3Path(path) { pathSeen = path; return 77n; },
    };
    assert.equal(await quoteSellAlongRoute({ token: TOKEN, amountInWei: 5n, venue: "uniswap_v3",
      route: { hops: [USDT_56], fees: [500, 3000] }, rpcUrls: [], reader }), 77n);
    assert.equal(pathSeen, encodeV3Path([TOKEN, USDT_56, getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c")], [3000, 500]));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { createTradeDetailObserver } from "../src/trade/detail.js";
import type { RouteQuoteReader } from "../src/trade/route.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");

/** A `RouteQuoteReader` with no pool at all — every probe returns 0, so `quoteBestTradfiSell` throws NO_ROUTE. */
const noPoolReader: RouteQuoteReader = {
  async quoteV2() { return 0n; },
  async quoteV3Single() { return 0n; },
  async quoteV3Path() { return 0n; },
  async quoteUniV3Single() { return 0n; },
  async quoteUniV3Path() { return 0n; },
};

/** A `RouteQuoteReader` where the direct pancake_v2 leg succeeds. */
const directPoolReader: RouteQuoteReader = {
  async quoteV2(_path, amount) { return amount; },
  async quoteV3Single() { return 0n; },
  async quoteV3Path() { return 0n; },
  async quoteUniV3Single() { return 0n; },
  async quoteUniV3Path() { return 0n; },
};

async function usdtFixture(input: {
  readonly routeReader: RouteQuoteReader;
  readonly flashSellQuote?: (input: { readonly token: Address; readonly amountInAtomic: bigint; readonly signal?: AbortSignal }) => Promise<bigint>;
  readonly now?: () => number;
}) {
  const agents = new MemoryAgentStore();
  const agent = await agents.createAgent({ id: "a1", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed" });
  const positions = new MemoryTradePositionStore(() => 1_000);
  const first = await positions.open({ positionId: "p1", agentId: "a1", ownerAddress: OWNER,
    token: TOKEN, route: { hops: [], fees: [] }, venue: "pancake_v2", entryWei: 1n, tokenAmount: 100n,
    fillStatus: "verified", openedAt: 500, settlementAsset: "USDT", requestedEntryAtomic: 50n, verifiedEntryAtomic: 50n });
  const observer = createTradeDetailObserver({
    provider: {
      async getTokenBalance() { return 100n; },
      async getTokenMetadata() { return { symbol: "TOK", decimals: 18 }; },
    },
    rpcUrls: [],
    routeReader: input.routeReader,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.flashSellQuote === undefined ? {} : { flashSellQuote: input.flashSellQuote }),
  });
  return { agent, positions, first, observer };
}

describe("trade detail observer — pool-less USDT position Flash mark", () => {
  it("falls back to the Flash quote when the direct route has no pool", async () => {
    let calls = 0;
    const f = await usdtFixture({
      routeReader: noPoolReader,
      flashSellQuote: async () => { calls += 1; return 90n; },
    });
    const [quoted] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(quoted?.quoteStatus, "quoted");
    assert.equal(quoted?.currentQuoteWei, "90");
    // pnlBps = (90 - 50) * 10000 / 50
    assert.equal(quoted?.pnlBps, "8000");
    assert.equal(calls, 1);
  });

  it("never calls the Flash fallback when the direct quote succeeds", async () => {
    let calls = 0;
    const f = await usdtFixture({
      routeReader: directPoolReader,
      flashSellQuote: async () => { calls += 1; return 90n; },
    });
    const [quoted] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(quoted?.quoteStatus, "quoted");
    assert.equal(quoted?.currentQuoteWei, "100");
    assert.equal(calls, 0);
  });

  it("stays unavailable when both the direct route and Flash fail", async () => {
    const f = await usdtFixture({
      routeReader: noPoolReader,
      flashSellQuote: async () => { throw new Error("binance_no_route"); },
    });
    const [value] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(value?.quoteStatus, "unavailable");
    assert.equal(value?.currentQuoteWei, null);
  });

  it("stays unavailable, with no Flash call, when no flashSellQuote option is given", async () => {
    const f = await usdtFixture({ routeReader: noPoolReader });
    const [value] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(value?.quoteStatus, "unavailable");
  });

  it("caches a Flash-derived quote for 60s, independent of maxAgeMs, then re-quotes", async () => {
    let calls = 0;
    let time = 2_000;
    const f = await usdtFixture({
      routeReader: noPoolReader,
      flashSellQuote: async () => { calls += 1; return 90n; },
      now: () => time,
    });
    const [firstObs] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(firstObs?.quoteStatus, "quoted");
    assert.equal(calls, 1);
    time += 59_000;
    const [secondObs] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(secondObs?.quoteStatus, "quoted");
    assert.equal(calls, 1, "a second observe inside 60s must reuse the cached Flash value");
    time += 2_000;
    const [thirdObs] = await f.observer.observe(f.agent, [f.first]);
    assert.equal(thirdObs?.quoteStatus, "quoted");
    assert.equal(calls, 2, "past 60s the observer must call Flash again");
  });
});

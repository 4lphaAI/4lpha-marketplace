import assert from "node:assert/strict";
import { it } from "node:test";
import { getAddress, keccak256, padHex, stringToBytes, toHex, type Hex } from "viem";
import { buildTradfiPancakeV2Swap } from "../src/ops/tradfi.js";
import { tradeReceiptFill } from "../src/trade/execute.js";
import { rankTradfiOffers, type TradfiOffer } from "../src/trade/route.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { featurePrompt, type FeatureEvidence } from "../src/trade/features.js";
import { checkTradfiV2Sizing } from "../src/trade/sizing.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
const ROUTER = getAddress("0x3333333333333333333333333333333333333333");
const HASH = `0x${"44".repeat(32)}` as Hex;
const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const addressTopic = (value: Hex): Hex => padHex(value, { size: 32 });

it("v2 cannot attribute a buy from bare transaction-wide token logs", async () => {
  const fill = await tradeReceiptFill({
    request: { decisionId: "audit-fill", venue: "pancake", side: "buy", token: TOKEN,
      amountWei: 100n, minOutWei: 80n, quotedOutWei: 90n, settlementAsset: "USDT" },
    walletAddress: WALLET, nativeInWei: 0n, receipt: { status: "CONFIRMED", transactionHash: HASH },
    reader: { async getReceipt() { return { logs: [
      { address: TOKEN, topics: [TRANSFER, addressTopic(ROUTER), addressTopic(WALLET)], data: toHex(90n, { size: 32 }) },
      { address: USDT_56, topics: [TRANSFER, addressTopic(WALLET), addressTopic(ROUTER)], data: toHex(100n, { size: 32 }) },
    ] }; } },
  });
  assert.equal(fill.fillStatus, "unverified");
  if (fill.side === "buy") assert.equal(fill.verifiedEntryAtomic ?? null, null);
});

it("v2 cannot attribute proceeds from an unsolicited USDT transfer", async () => {
  const fill = await tradeReceiptFill({
    request: { decisionId: "audit-sell", venue: "pancake", side: "sell", token: TOKEN,
      amountWei: 100n, minOutWei: 80n, quotedOutWei: 90n, settlementAsset: "USDT" },
    walletAddress: WALLET, nativeInWei: 0n, receipt: { status: "CONFIRMED", transactionHash: HASH },
    reader: { async getReceipt() { return { logs: [
      { address: USDT_56, topics: [TRANSFER, addressTopic(ROUTER), addressTopic(WALLET)], data: toHex(90n, { size: 32 }) },
    ] }; } },
  });
  assert.equal(fill.fillStatus, "unverified");
  if (fill.side === "sell") assert.equal(fill.exitWei, null);
});

it("direct V2 token swap accepts its fee-free route shape", () => {
  const calls = buildTradfiPancakeV2Swap({ router: ROUTER, tokenIn: USDT_56, tokenOut: TOKEN,
    amountInWei: 100n, minOutWei: 90n, recipient: WALLET, deadline: 1000n, route: { hops: [], fees: [] } });
  assert.ok(calls.length >= 2);
  assert.equal(calls.at(-1)?.to, ROUTER);
});

function offer(overrides: Partial<TradfiOffer> = {}): TradfiOffer {
  return { source: "direct-amm", amountInAtomic: 100n, quotedOutAtomic: 100n, minOutAtomic: 90n,
    inputFeeAtomic: 0n, outputFeeAtomic: 0n, estimatedNativeCostWei: 1n, nativeCostUsdtAtomic: 1n,
    observedAt: 100, expiresAt: 200, feeIncludedFlags: { input: true, output: true }, venueOrder: "a", ...overrides };
}

it("equal expected entry outcome prefers the stronger enforced minimum before venue", () => {
  const weak = offer();
  const strong = offer({ source: "binance", minOutAtomic: 99n, venueOrder: "b" });
  assert.equal(rankTradfiOffers("buy", [weak, strong])[0], strong);
});

it("equal expected sell outcome prefers the stronger net minimum before venue", () => {
  const weak = offer();
  const strong = offer({ source: "binance", minOutAtomic: 99n, venueOrder: "b" });
  assert.equal(rankTradfiOffers("sell", [weak, strong])[0], strong);
});

it("sell fallback uses one total ordering when any route lacks comparison costs", () => {
  const rows = [offer({ venueOrder: "a", minOutAtomic: 90n, nativeCostUsdtAtomic: 40n }),
    offer({ venueOrder: "b", minOutAtomic: 95n, nativeCostUsdtAtomic: null }),
    offer({ venueOrder: "c", minOutAtomic: 94n, nativeCostUsdtAtomic: 0n })];
  for (const permutation of [rows, [...rows].reverse(), [rows[1]!, rows[2]!, rows[0]!]]) {
    assert.deepEqual(rankTradfiOffers("sell", permutation).map((row) => row.venueOrder), ["b", "c", "a"]);
  }
});

it("legacy feature prompt excludes additive metrics even when producer sends them", () => {
  const close = 900_000;
  const metric = { value: 1, unit: "percent", available: true };
  const row: FeatureEvidence = {
    pool: { pool: ROUTER, tokenAddress: TOKEN, currency: "usd" }, interval: "15m", quoteAddress: USDT_56,
    snapshotId: "a".repeat(64), seriesId: "b".repeat(64), observedAt: close + 1,
    calculatedAt: close + 2, evaluationClose: close, expiresAt: close + 90_000,
    metrics: { ema12: metric, ema26: metric, emaSpreadPct: metric, roc10Pct: metric, atr14: metric, atrPct: metric, rvol20: metric },
    indicatorRevision: 1,
    additiveMetrics: { rsi14: { value: 50, unit: "index", available: true }, macd: metric, signal9: metric, histogram: metric, momentum10: metric },
  };
  const raw = featurePrompt({ "15m": row }, close + 3);
  assert.ok(raw.length > 0);
  assert.equal(raw.includes("additiveMetrics"), false);
  assert.equal(raw.includes("indicatorRevision"), false);
  assert.equal(raw.includes("rsi14"), false);
});

it("v2 sizing refuses malformed token counts rather than granting an understated reserve", () => {
  for (const grantedTokenCount of [-1, NaN, Infinity, 1.5, 29]) {
    const result = checkTradfiV2Sizing({ minEntryWei: 1n, maxEntryWei: 10n, capitalQuoteWei: 100n,
      maxOpenPositions: 1, grantedTokenCount, platformFeeBps: 0, capDayWei: 10n ** 18n });
    assert.equal(result.ok, false, `count=${grantedTokenCount}`);
  }
});

it("v2 fee policy never grants a native treasury call", () => {
  for (const platformFeeBps of [0, 100]) {
    const policy = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: ROUTER },
      treasury: WALLET, tokens: [{ token: TOKEN }], nativeCaps: [{ limit: 10n ** 18n, period: "day" }],
      quoteToken: USDT_56, quoteDailyCapWei: 100n, quotePerTradeCapWei: 10n, platformFeeBps,
      nowSeconds: 1000, expiresAt: 2000 });
    assert.ok(policy.allowedCalls.every((call) => call.to !== undefined), "every call grant must be target-bound");
    assert.equal(policy.allowedCalls.some((call) => call.to?.toLowerCase() === WALLET.toLowerCase()), false);
    assert.equal(policy.allowedCalls.some((call) => call.to?.toLowerCase() === USDT_56.toLowerCase()
      && call.selector === "transfer(address,uint256)"), platformFeeBps > 0);
  }
});

it("an explicit-null legacy intent remains idempotent on replay", async () => {
  const store = new MemoryTradeIntentStore(() => 1000);
  const input = { decisionId: "audit-legacy-replay", idempotencyKey: HASH, agentId: "agent-a", ownerAddress: WALLET,
    side: "buy" as const, token: TOKEN, route: { hops: [], fees: [] }, amountWei: 100n, entryWei: 101n,
    positionId: "audit-position", closeReason: null, settlementAsset: null, platformFeeAtomic: null };
  const first = await store.create(input);
  const replay = await store.create(input);
  assert.deepEqual(replay, first);
});

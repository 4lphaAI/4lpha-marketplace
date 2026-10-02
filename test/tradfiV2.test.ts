import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, type Hex } from "viem";
import { parseTradeSettings, tradeSettingsDigest } from "../src/trade/settings.js";
import { checkTradfiV2Sizing, tradfiV2EntryReservation } from "../src/trade/sizing.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { buildTradfiPancakeV2Swap, buildTradfiPlatformFee } from "../src/ops/tradfi.js";
import { PANCAKE_V2_ROUTER_56 } from "../src/ops/venues.js";
import { tradeSessionSpec, TRADFI_GUARD_SWAP_SELECTOR, TRANSFER_SELECTOR } from "../src/ops/policy.js";
import { validateSessionSpec } from "../src/core/session.js";
import { rankTradfiOffers, type TradfiOffer } from "../src/trade/route.js";
import { verifiedPortoNativeFee } from "../src/trade/cost.js";
import { PORTO_V055_ORCHESTRATOR } from "../src/lp/preparedIntent.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
const TREASURY = getAddress("0x3333333333333333333333333333333333333333");
const NOW = 1_800_000_000;
const BASE = {
  name: "TradFi v2",
  executionModel: "tradfi" as const,
  entryWei: "20000000000000000000",
  maxOpenPositions: 3,
  minMarketCapUsd: null,
  maxMarketCapUsd: null,
  noReentry: true,
  takeProfitBps: null,
  stopLossBps: null,
  maxHoldSec: null,
  breakEvenAfterTp: true,
  slippageBps: 300,
  gasPriority: "standard" as const,
  instructions: null,
  skillMarkdown: null,
  primaryModel: "qwen3.7-flash" as const,
  fallbackModel: "0gm-1.0-35b-a3b" as const,
  settlementAsset: "USDT" as const,
  minEntryWei: "5000000000000000000",
  capitalQuoteWei: "63000000000000000000",
  cmcNewsEnabled: true,
  cmcTotalBudgetWei: "2000000000000000000",
};

test("TradFi v2 settings are explicit and legacy settings digest stays separate", () => {
  const parsed = parseTradeSettings(BASE);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.raw.settlementAsset, "USDT");
  const { settlementAsset: _asset, minEntryWei: _min, capitalQuoteWei: _capital, cmcNewsEnabled: _news, cmcTotalBudgetWei: _budget, ...legacyBase } = BASE;
  assert.equal(tradeSettingsDigest(parsed.value.raw) !== tradeSettingsDigest(legacyBase), true);
  assert.equal(parseTradeSettings({ ...BASE, cmcNewsEnabled: false }).ok, false);
  assert.equal(parseTradeSettings({ ...BASE, settlementAsset: undefined }).ok, false);
});

test("TradFi v2 sizing includes buy fees and reserves native exit headroom", () => {
  const result = checkTradfiV2Sizing({ minEntryWei: 5n * 10n ** 18n, maxEntryWei: 20n * 10n ** 18n,
    capitalQuoteWei: 63n * 10n ** 18n, maxOpenPositions: 3, grantedTokenCount: 5, platformFeeBps: 500,
    capDayWei: 1_000_000_000_000_000_000n });
  assert.equal(result.ok, true);
  assert.equal(tradfiV2EntryReservation(20n * 10n ** 18n, 500), 21n * 10n ** 18n);
  assert.equal(checkTradfiV2Sizing({ ...resultInput(), minEntryWei: 0n }).ok, false);
});

function resultInput() {
  return { minEntryWei: 5n * 10n ** 18n, maxEntryWei: 20n * 10n ** 18n, capitalQuoteWei: 63n * 10n ** 18n,
    maxOpenPositions: 3, grantedTokenCount: 5, platformFeeBps: 500, capDayWei: 1_000_000_000_000_000_000n };
}

test("TradFi v2 session grants finite USDT approve/transfer and guard capability", () => {
  const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56 }, treasury: TREASURY,
    tokens: [{ token: TOKEN }], quoteToken: USDT_56, quoteDailyCapWei: 63n * 10n ** 18n, quotePerTradeCapWei: 21n * 10n ** 18n,
    platformFeeBps: 500, aggregatorGuard: getAddress("0x4444444444444444444444444444444444444444"),
    nativeCaps: [{ limit: 1_000_000_000_000_000_000n, period: "day" }], expiresAt: NOW + 3_600, nowSeconds: NOW });
  assert.doesNotThrow(() => validateSessionSpec(spec, { nowSeconds: NOW }));
  assert(spec.spendCaps.some((cap) => cap.token?.toLowerCase() === USDT_56.toLowerCase() && cap.limit === 63n * 10n ** 18n));
  assert(spec.allowedCalls.some((call) => call.to?.toLowerCase() === USDT_56.toLowerCase() && call.selector === TRANSFER_SELECTOR));
  assert(spec.allowedCalls.some((call) => call.selector === TRADFI_GUARD_SWAP_SELECTOR));
});

test("TradFi v2 V2 builder uses token input, zero native value and exact fee transfer", () => {
  const calls = buildTradfiPancakeV2Swap({ router: PANCAKE_V2_ROUTER_56, tokenIn: USDT_56, tokenOut: TOKEN, amountInWei: 5n, minOutWei: 4n,
    recipient: OWNER, deadline: BigInt(NOW), route: { hops: [], fees: [] } });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.value === undefined), true);
  const fee = buildTradfiPlatformFee({ usdt: USDT_56, treasury: TREASURY, amountWei: 1n });
  assert.equal(fee.length, 1);
  assert.equal(buildTradfiPlatformFee({ usdt: USDT_56, treasury: TREASURY, amountWei: 0n }).length, 0);
});

test("TradFi offers use one sell ranking mode and do not double subtract included fees", () => {
  const offer = (source: TradfiOffer["source"], out: bigint, cost: bigint | null, included = false): TradfiOffer => ({ source,
    amountInAtomic: 100n, quotedOutAtomic: out, minOutAtomic: out - 1n, inputFeeAtomic: 10n, outputFeeAtomic: 10n,
    estimatedNativeCostWei: 1n, nativeCostUsdtAtomic: cost, observedAt: NOW, expiresAt: NOW + 10_000,
    feeIncludedFlags: { input: included, output: included }, venueOrder: source });
  const ranked = rankTradfiOffers("sell", [offer("binance", 100n, null), offer("direct-amm", 90n, 1n), offer("binance", 95n, 1n, true)]);
  assert.equal(ranked[0]?.quotedOutAtomic, 100n);
  assert.equal(rankTradfiOffers("buy", [offer("binance", 100n, null)]).length, 0);
});

test("native cost quote uses bound intent payment, not fee deficit or caller hints", () => {
  const executionData = "0x1234" as Hex;
  const quote = {
    chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR,
    intent: { eoa: OWNER, executionData, expiry: 2_000n, payer: OWNER, paymentToken: "0x0000000000000000000000000000000000000000", paymentAmount: 21_000_000_000_000n, paymentMaxAmount: 21_000_000_000_000n },
    nativeFeeEstimate: { maxFeePerGas: 1_000_000_000n }, txGas: 21_000n, extraPayment: 0n,
  };
  const expected = keccak256(executionData);
  const boundQuote = quote;
  assert.equal(verifiedPortoNativeFee({ quote: boundQuote, walletAddress: OWNER, executionDataHash: expected, nowSec: 1_900 }), 21_000_000_000_000n);
  assert.equal(verifiedPortoNativeFee({ quote: { ...boundQuote, orchestrator: TOKEN }, walletAddress: OWNER, executionDataHash: expected, nowSec: 1_900 }), null);
  assert.equal(verifiedPortoNativeFee({ quote: { ...boundQuote, intent: { ...boundQuote.intent, executionData: "0xbeef" } }, walletAddress: OWNER, executionDataHash: expected, nowSec: 1_900 }), null);
  assert.equal(verifiedPortoNativeFee({ quote: { ...boundQuote, intent: { ...boundQuote.intent, paymentAmount: 1n, paymentMaxAmount: 0n } }, walletAddress: OWNER, executionDataHash: expected, nowSec: 1_900 }), null);
  assert.equal(verifiedPortoNativeFee({ quote: boundQuote, walletAddress: OWNER, executionDataHash: expected, nowSec: 2_001 }), null);
});

test("native cost quote binds the key through prepared.key: a relay intent without keyHash is accepted, a wrong keyHash is not", () => {
  const executionData = "0x1234" as Hex;
  const expectedKeyHash = keccak256("0xabcd");
  // The live relay's prepared intent (measured 2026-09-19) has no keyHash field at all.
  const relayShapedQuote = {
    chainId: 56, orchestrator: PORTO_V055_ORCHESTRATOR,
    intent: { eoa: OWNER, executionData, expiry: 0n, payer: "0x0000000000000000000000000000000000000000", paymentToken: "0x0000000000000000000000000000000000000000", paymentAmount: 96_580_835_000_000n, paymentMaxAmount: 96_580_835_000_000n },
    nativeFeeEstimate: { maxFeePerGas: 50_000_000n }, txGas: 1_485_859n, extraPayment: 0n, ttl: 1_930,
  };
  const expected = keccak256(executionData);
  assert.equal(verifiedPortoNativeFee({ quote: relayShapedQuote, walletAddress: OWNER, executionDataHash: expected, expectedKeyHash, nowSec: 1_900, sessionExpiry: 5_000 }), 96_580_835_000_000n);
  assert.equal(verifiedPortoNativeFee({ quote: { ...relayShapedQuote, intent: { ...relayShapedQuote.intent, keyHash: expectedKeyHash } }, walletAddress: OWNER, executionDataHash: expected, expectedKeyHash, nowSec: 1_900, sessionExpiry: 5_000 }), 96_580_835_000_000n);
  assert.equal(verifiedPortoNativeFee({ quote: { ...relayShapedQuote, intent: { ...relayShapedQuote.intent, keyHash: keccak256("0x9999") } }, walletAddress: OWNER, executionDataHash: expected, expectedKeyHash, nowSec: 1_900, sessionExpiry: 5_000 }), null);
  assert.equal(verifiedPortoNativeFee({ quote: { ...relayShapedQuote, intent: { ...relayShapedQuote.intent, keyHash: 7 } }, walletAddress: OWNER, executionDataHash: expected, expectedKeyHash, nowSec: 1_900, sessionExpiry: 5_000 }), null);
});

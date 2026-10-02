import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, padHex, stringToBytes, toHex, type Hex } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { validateSessionSpec } from "../src/core/session.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { executeTradeForAgent, tradeReceiptFill, type TradfiV2ReceiptEvidence } from "../src/trade/execute.js";
import { parseHireParams, type TradeRequest } from "../src/http/wire.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import type { TradeDataPlaneReads, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";
import { FakeWalletProvider, tradeConfig, SESSION_KEY } from "./support/serverHarness.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const GUARD = getAddress("0x4444444444444444444444444444444444444444");
const POOL = getAddress("0x5555555555555555555555555555555555555555");
const H = `0x${"66".repeat(32)}` as Hex;
const KEY = `0x04${"77".repeat(64)}` as Hex;
const E = 10n ** 18n;
const v2Settings = (): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi",
  settlementAsset: "USDT", minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(),
  capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled: false, maxOpenPositions: 1,
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, crashProtection: false });

function spec(now: number) {
  return tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56,
    pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 }, tokens: [{ token: TOKEN }],
    nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56,
    quoteDailyCapWei: 60n * E, quotePerTradeCapWei: 20n * E, platformFeeBps: 0,
    aggregatorGuard: GUARD, nowSeconds: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 86_400 });
}

async function workerHarness(input: { now: () => number; direct: boolean; withVenue: boolean;
  onLlm?: () => void; stockBalance?: bigint; quoteDivisor?: bigint; sessionRemainingSec?: number }) {
  const agents = new MemoryAgentStore();
  const positions = new MemoryTradePositionStore(input.now);
  const intents = new MemoryTradeIntentStore(input.now);
  const settingsStore = new MemoryTradeSettingsStore(agents, input.now);
  const journal = new MemoryExecutionJournal(input.now);
  const policy = { ...spec(input.now()), ...(input.sessionRemainingSec === undefined ? {} : {
    expiresAt: Math.floor(input.now() / 1000) + input.sessionRemainingSec }) };
  const agent = await agents.createAgent({ id: "core-audit", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", sessionFacts: { spec: policy,
      permissions: validateSessionSpec(policy, { nowSeconds: Math.floor(input.now() / 1000), minSessionSeconds: 0 }), publicKey: KEY,
      expiry: policy.expiresAt, grantedAtSec: Math.floor(input.now() / 1000) - 86_400, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() } } });
  const settings = v2Settings();
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const venue: VenueRow = { dex: "pancakeswap", version: "v3", pool: POOL, quote: USDT_56, quoteSymbol: "USDT",
    feeTier: 100, liquidityUsd: 100_000, volume24hUsd: 1_000, priceUsd: 1, asOf: input.now() };
  const rows: UniverseRow[] = [{ address: TOKEN, symbol: "STOCK", lane: "bstocks", source: "fixture",
    venues: input.withVenue ? [venue] : [], rwa: { platform: "bstocks", underlyingTicker: "STOCK",
      tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: "regular",
      reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1,
      venues: input.withVenue ? [venue] : [] } }];
  let flashCalls = 0;
  const featureData = strongFeatureDataPlane(TOKEN, POOL, input.now());
  const dataPlane: TradeDataPlaneReads = {
    ...featureData,
    universe: async lane => lane === "bstocks" ? rows : [],
    tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1,
      marketCapUsd: 1_000_000_000, volume24hUsd: 1_000, holders: 100, priceChange24hPct: 1,
      asOf: input.now(), source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
    eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }),
    binanceQuoteAndSwap: async request => { flashCalls += 1; return {
      version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn,
      tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic,
      quotedOutAtomic: (BigInt(request.amountAtomic) / (input.quoteDivisor ?? 1n)).toString(),
      minOutAtomic: (BigInt(request.amountAtomic) * 97n / 100n / (input.quoteDivisor ?? 1n)).toString(),
      router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", value: "0", observedAt: input.now(), expiresAt: input.now() + 15_000,
      estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56,
    }; },
  };
  const quote = async (amount: bigint) => { if (!input.direct) throw new Error("no public AMM"); return amount; };
  const reader: RouteQuoteReader = { quoteV2: async (_path, amount) => quote(amount),
    quoteV3Single: async (_a, _b, _f, amount) => quote(amount), quoteV3Path: async (_p, amount) => quote(amount),
    quoteUniV3Single: async (_a, _b, _f, amount) => quote(amount), quoteUniV3Path: async (_p, amount) => quote(amount) };
  const submitted: TradeRequest[] = [];
  let stockBalance = input.stockBalance ?? 0n;
  const deps: TradeWorkerDeps = { agentStore: agents, positions, intents, settingsStore, journal, dataPlane, aggregatorGuard: GUARD,
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? 60n * E : stockBalance,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "STOCK" }),
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 60n * E, currentSpentWei: 0n }] },
    llmFor: () => ({ complete: async messages => { input.onLlm?.(); const isExit = messages[0]?.content.startsWith("Decide only") === true
      || messages[0]?.content.includes("decide only whether each indexed") === true; return { model: "offline",
      content: isExit ? JSON.stringify({ decisions: [{ index: 0, exit: true, reason: "exit" }] })
        : JSON.stringify({ decisions: [{ index: 0, enter: true, confidence: 100, amountAtomic: (5n * E).toString(), reason: "enter" }] }) }; } }),
    executor: { execute: async request => { submitted.push(request.request); stockBalance = 0n; return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H },
      fill: request.request.side === "sell" ? { side: "sell", exitWei: null, fillStatus: "unverified" } : { side: "buy", entryWei: request.request.amountWei, tokenAmount: null, fillStatus: "unverified" }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    rpcUrls: [], routeReader: reader, platformFeeBps: 0, tradfiNativeCostUsdtAtomic: async () => 1n,
    forbiddenAddresses: () => new Set(), executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: H }),
    recoverFill: async intent => intent.side === "buy" ? { side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" } : { side: "sell", exitWei: null, fillStatus: "unverified" }, now: input.now };
  return { deps, agent, positions, intents, submitted, flashCalls: () => flashCalls };
}

test("Core audit: a pinned aggregator-only stock reaches guarded entry", async () => {
  const now = Date.now();
  const h = await workerHarness({ now: () => now, direct: false, withVenue: false });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(h.submitted.filter(request => request.side === "buy").length, 1, JSON.stringify(result.outcomes));
  assert.ok(h.submitted[0]?.guardQuote);
});

test("Core audit: selected Flash entry is checked against reference at actual size", async () => {
  const now = Date.now();
  const h = await workerHarness({ now: () => now, direct: false, withVenue: true, quoteDivisor: 2n });
  await runTradeWorkerOnce(h.deps);
  assert.equal(h.submitted.filter(request => request.side === "buy").length, 0,
    "5 USDT for 2.5 shares at a 1 USD reference is a 100 percent premium");
});

test("Core audit: v2 does not open a position during the session exit window", async () => {
  const now = Date.now();
  const h = await workerHarness({ now: () => now, direct: true, withVenue: true, sessionRemainingSec: 30 });
  await runTradeWorkerOnce(h.deps);
  assert.equal(h.submitted.filter(request => request.side === "buy").length, 0);
});

test("Core audit: blank-threshold guarded exit obtains calldata after model latency", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const h = await workerHarness({ now: () => now, direct: false, withVenue: false, stockBalance: 5n * E,
    onLlm: () => { now += 20_000; } });
  // Entered below the flat 1:1 flash quote so pnl clears the 300bps cost-band-breach
  // trigger (TRADFI-AI-TRADE-V3 §3.2) on the very first ask: this test's subject is
  // the calldata-expiry-after-model-latency mechanism, which needs the exit LLM to
  // actually be asked, not the trigger gate itself.
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
    verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await runTradeWorkerOnce(h.deps);
  const sell = h.submitted.find(request => request.side === "sell");
  assert.ok(sell);
  assert.ok(sell.guardQuote && sell.guardQuote.deadline > BigInt(Math.floor(now / 1000)), "submitted quote expired during LLM");
});

test("Core audit: v2 sell persists the minimum required by delayed receipt recovery", async () => {
  const now = Date.now();
  const h = await workerHarness({ now: () => now, direct: true, withVenue: true, stockBalance: 5n * E });
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 5n * E, tokenAmount: null,
    fillStatus: "unverified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
    verifiedEntryAtomic: null });
  await h.positions.requestExit(OWNER, h.agent.id, "position");
  await runTradeWorkerOnce(h.deps);
  const projected = await h.intents.listProjectedV2(OWNER, h.agent.id);
  const sold = projected.find(intent => intent.side === "sell");
  assert.ok(sold);
  assert.ok(sold.minOutAtomic !== undefined && sold.minOutAtomic !== null && sold.minOutAtomic > 0n);
});

test("Core audit: new TradFi hire rejects the legacy native settings tuple", () => {
  const parsed = parseHireParams({ walletAddress: WALLET, capDayWei: E.toString(), ttlSec: 604800,
    sizingPreset: "trade-v1", executionModel: "tradfi", hireRunId: "11111111-1111-4111-8111-111111111111",
    autoGrant: true, settings: { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi" } });
  assert.equal(parsed.ok, false);
});

test("Core audit: v2 verified receipt does not take basis from a different log read", async () => {
  const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)"));
  const evidence: TradfiV2ReceiptEvidence = { chainId: 56, receiptStatus: "success", blockHash: H,
    blockNumber: 1n, wallet: WALLET, sessionPublicKey: KEY, sessionGeneration: 0, intentId: H,
    chainIntentHash: H, nonce: 1n, callsHash: H, receiptOwned: true, singleWalletExecution: true,
    unexplainedRelevantTransfers: false, matchingIntent: true, matchingCalls: true, treasuryFeeMatches: true,
    ownership: { transactionHash: H, swapLogIndex: 0n } };
  const fill = await tradeReceiptFill({ request: { decisionId: "proof", venue: "pancake_v3", side: "buy",
    token: TOKEN, amountWei: 5n * E, minOutWei: 4n * E, quotedOutWei: 5n * E, settlementAsset: "USDT" },
    walletAddress: WALLET, nativeInWei: 0n, receipt: { status: "CONFIRMED", transactionHash: H },
    v2Evidence: evidence, v2ExpectedIdentity: { sessionPublicKey: KEY, sessionGeneration: 0, intentId: H, callsHash: H },
    reader: { getReceipt: async () => ({ logs: [
      { address: USDT_56, topics: [transfer, padHex(WALLET, { size: 32 }), padHex(POOL, { size: 32 })], data: toHex(17n * E, { size: 32 }) },
      { address: TOKEN, topics: [transfer, padHex(POOL, { size: 32 }), padHex(WALLET, { size: 32 })], data: toHex(5n * E, { size: 32 }) },
    ] }) } });
  assert.ok(fill.side !== "buy" || fill.fillStatus !== "verified" || fill.verifiedEntryAtomic !== 17n * E,
    "a 5-USDT exact-input proof cannot certify a different reader's 17-USDT debit");
});

test("Core audit: executor refuses a v2 entry below its persisted signed minimum", async () => {
  const now = Date.now();
  const policy = spec(now);
  const agents = new MemoryAgentStore();
  const agent = await agents.createAgent({ id: "minimum", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", sessionFacts: { spec: policy,
      permissions: validateSessionSpec(policy, { nowSeconds: Math.floor(now / 1000) }), publicKey: KEY, expiry: policy.expiresAt,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT",
        minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() } } });
  await agents.putAgentSessionKey(OWNER, agent.id, SESSION_KEY);
  const provider = new FakeWalletProvider();
  const result = await executeTradeForAgent({ agent, request: { decisionId: "below-min", venue: "pancake", side: "buy",
    token: TOKEN, amountWei: E, quotedOutWei: E, minOutWei: E * 97n / 100n, settlementAsset: "USDT", platformFeeAtomic: 0n },
    idempotencyKey: H, paramsHash: H, scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: POOL, agentStore: agents, journal: new MemoryExecutionJournal(() => now),
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null,
      flapPortal: null, nowMs: () => now } });
  assert.equal(provider.executeCalls.length, 0, result.kind);
});

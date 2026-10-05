/** TRADFI-AI-TRADE-V3 offline integration coverage for the tradfi v2 entry/exit lanes (§2.4, §3.2, §4, §6). */
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { validateSessionSpec } from "../src/core/session.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import type { TradeDataPlaneReads, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import type { TradeRequest } from "../src/http/wire.js";
import type { CmcNewsService } from "../src/trade/cmcNews.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";
import { executeTradeForAgent, type ExecuteTradeDeps } from "../src/trade/execute.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { FakeWalletProvider, SESSION_KEY, tradeConfig } from "./support/serverHarness.js";
import type { CustodyModel } from "../src/core/types.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const TOKEN2 = getAddress("0x3333333333333333333333333333333333333366");
const GUARD = getAddress("0x4444444444444444444444444444444444444444");
const POOL = getAddress("0x5555555555555555555555555555555555555555");
const POOL2 = getAddress("0x5555555555555555555555555555555555555566");
const H = `0x${"66".repeat(32)}` as Hex;
const KEY = `0x04${"77".repeat(64)}` as Hex;
const E = 10n ** 18n;

// A Friday in RTH (America/New_York): 2026-06-05, 14:00 UTC = 10:00 ET.
const RTH_MS = Date.UTC(2026, 5, 5, 14, 0, 0);

function spec(now: number) {
  return tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56,
    pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 }, tokens: [{ token: TOKEN }, { token: TOKEN2 }],
    nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56,
    quoteDailyCapWei: 300n * E, quotePerTradeCapWei: 20n * E, platformFeeBps: 0,
    aggregatorGuard: GUARD, nowSeconds: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + 86_400 });
}

const v2Settings = (maxOpenPositions = 1, cmcNewsEnabled = false, slippageBps = 300): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi",
  settlementAsset: "USDT", minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(),
  capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled, maxOpenPositions, slippageBps,
  ...(cmcNewsEnabled ? { cmcTotalBudgetWei: (1n * E).toString() } : {}),
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, crashProtection: false });

/** Copies the smallest v2 harness pattern (audit.tradfiCoreIndependent.test.ts's `workerHarness`), parameterized for this file's scenarios. */
async function harness(input: {
  readonly now: () => number;
  readonly stockBalance?: bigint;
  readonly entryDecision?: unknown;
  readonly exitDecision?: unknown;
  readonly llmCounter?: { calls: number };
  readonly cmcNews?: Pick<CmcNewsService, "getFresh">;
  readonly maxOpenPositions?: number;
  readonly cmcNewsEnabled?: boolean;
  readonly slippageBps?: number;
  readonly binanceQuoteAndSwap?: TradeDataPlaneReads["binanceQuoteAndSwap"];
  /** AUDIT MEDIUM-1: captures every prompt sent to the LLM, to inspect for CMC-only content. */
  readonly capturedMessages?: { readonly role: string; readonly content: string }[][];
  /** AUDIT M12: adds TOKEN2/"STOCK2" as a second, always-strong universe candidate, so an entry shortlist can coexist with an open TOKEN position. */
  readonly secondCandidate?: boolean;
  /** TRADFI-LLM-CMC-REQUEST: TOKEN's underlying ticker, default "STOCK" (unmapped in `US_EQUITY_TICKER_CLASS`); pass a real pinned ticker (e.g. "NVDA") to exercise an accepted `dataRequests` entry. */
  readonly underlyingTicker?: string;
}) {
  const agents = new MemoryAgentStore();
  const positions = new MemoryTradePositionStore(input.now);
  const intents = new MemoryTradeIntentStore(input.now);
  const settingsStore = new MemoryTradeSettingsStore(agents, input.now);
  const journal = new MemoryExecutionJournal(input.now);
  const policy = spec(input.now());
  const agent = await agents.createAgent({ id: "v3-worker", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", sessionFacts: { spec: policy,
      permissions: validateSessionSpec(policy, { nowSeconds: Math.floor(input.now() / 1000), minSessionSeconds: 0 }), publicKey: KEY,
      expiry: policy.expiresAt, grantedAtSec: Math.floor(input.now() / 1000) - 86_400, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() } } });
  const settings = v2Settings(input.maxOpenPositions ?? 1, input.cmcNewsEnabled ?? false, input.slippageBps ?? 300);
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const venue: VenueRow = { dex: "pancakeswap", version: "v3", pool: POOL, quote: USDT_56, quoteSymbol: "USDT",
    feeTier: 100, liquidityUsd: 100_000, volume24hUsd: 1_000, priceUsd: 1, asOf: input.now() };
  const venue2: VenueRow = { dex: "pancakeswap", version: "v3", pool: POOL2, quote: USDT_56, quoteSymbol: "USDT",
    feeTier: 100, liquidityUsd: 100_000, volume24hUsd: 1_000, priceUsd: 1, asOf: input.now() };
  const tokenTicker = input.underlyingTicker ?? "STOCK";
  const rows: UniverseRow[] = [{ address: TOKEN, symbol: "STOCK", lane: "bstocks", source: "fixture",
    venues: [venue], rwa: { platform: "bstocks", underlyingTicker: tokenTicker,
      tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: "regular",
      reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [venue] } },
    ...(input.secondCandidate === true ? [{ address: TOKEN2, symbol: "STOCK2", lane: "bstocks" as const, source: "fixture",
      venues: [venue2], rwa: { platform: "bstocks" as const, underlyingTicker: "STOCK2",
        tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: "regular" as const,
        reasonCode: "TRADING", staleness: "fresh" as const, tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [venue2] } }] : [])];
  const featureData = strongFeatureDataPlane(TOKEN, POOL, input.now());
  const featureData2 = strongFeatureDataPlane(TOKEN2, POOL2, input.now());
  const dataPlane: TradeDataPlaneReads = {
    ...featureData,
    ...(input.secondCandidate !== true ? {} : {
      async featurePools() { return { pools: [...(await featureData.featurePools()).pools, ...(await featureData2.featurePools()).pools] }; },
      async featuresBatch(pools: Parameters<typeof featureData.featuresBatch>[0], interval: Parameters<typeof featureData.featuresBatch>[1]) {
        return { ...(await featureData.featuresBatch(pools, interval)), ...(await featureData2.featuresBatch(pools, interval)) };
      },
    }),
    universe: async lane => lane === "bstocks" ? rows : [],
    tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1,
      marketCapUsd: 1_000_000_000, volume24hUsd: 1_000, holders: 100, priceChange24hPct: 1,
      asOf: input.now(), source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
    eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }),
    binanceQuoteAndSwap: input.binanceQuoteAndSwap ?? (async request => ({
      version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn,
      tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic,
      quotedOutAtomic: request.amountAtomic, minOutAtomic: (BigInt(request.amountAtomic) * 97n / 100n).toString(),
      router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", value: "0", observedAt: input.now(), expiresAt: input.now() + 15_000,
      estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56,
    })),
  };
  const reader: RouteQuoteReader = { quoteV2: async () => { throw new Error("no public AMM"); },
    quoteV3Single: async () => { throw new Error("no public AMM"); }, quoteV3Path: async () => { throw new Error("no public AMM"); },
    quoteUniV3Single: async () => { throw new Error("no public AMM"); }, quoteUniV3Path: async () => { throw new Error("no public AMM"); } };
  const submitted: TradeRequest[] = [];
  let stockBalance = input.stockBalance ?? 0n;
  const llmState = { exitThrows: false };
  const deps: TradeWorkerDeps = { agentStore: agents, positions, intents, settingsStore, journal, dataPlane, aggregatorGuard: GUARD,
    ...(input.cmcNews === undefined ? {} : { cmcNews: input.cmcNews }),
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? 300n * E : stockBalance,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "STOCK" }),
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 300n * E, currentSpentWei: 0n }] },
    llmFor: () => ({ complete: async messages => {
      if (input.llmCounter) input.llmCounter.calls += 1;
      input.capturedMessages?.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const isExit = messages[0]?.content.startsWith("Decide only") === true || messages[0]?.content.includes("decide only whether each indexed") === true;
      if (isExit && llmState.exitThrows) throw new Error("llm outage");
      return { model: "offline", content: JSON.stringify(isExit
        ? (input.exitDecision ?? { decisions: [{ index: 0, exit: true, reason: "exit" }] })
        : (input.entryDecision ?? { decisions: [{ index: 0, enter: true, confidence: 100, amountAtomic: (5n * E).toString(), reason: "enter" }] })) };
    } }),
    executor: { execute: async request => { submitted.push(request.request); stockBalance = request.request.side === "sell" ? 0n : stockBalance;
      return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H },
        fill: request.request.side === "sell" ? { side: "sell", exitWei: null, fillStatus: "unverified" } : { side: "buy", entryWei: request.request.amountWei, tokenAmount: 5n * E, fillStatus: "verified", receiptAttributable: true, verifiedEntryAtomic: request.request.amountWei, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    rpcUrls: [], routeReader: reader, platformFeeBps: 0, tradfiNativeCostUsdtAtomic: async () => 1n,
    forbiddenAddresses: () => new Set(), executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: H }),
    recoverFill: async intent => intent.side === "buy" ? { side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" } : { side: "sell", exitWei: null, fillStatus: "unverified" }, now: input.now };
  return { deps, agent, positions, intents, submitted, settingsStore, journal, agents, llmState };
}

import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

test("Agentic golden Altana: TradFi AI buy and stop-loss sell", async context => {
  let now = RTH_MS;
  let uuid = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const withAgenticRows of [false, true]) {
  now = RTH_MS;
  uuid = 0;
  const h = await harness({ now: () => now, stockBalance: 5n * E });
  if (withAgenticRows) await h.agents.createAgent({ id: "agentic-golden", ownerAddress: TOKEN2, walletAddress: TOKEN2,
    custodyModel: "binance-agentic" as CustodyModel, status: "armed" });
  const facts = h.agent.sessionFacts!;
  await h.agents.updateAgentSessionFacts(OWNER, h.agent.id, { ...facts, hireSizing: { ...facts.hireSizing!,
    entryWei: (20n * E).toString(), quotePerTradeWei: (20n * E).toString() } });
  await h.agents.putAgentSessionKey(OWNER, h.agent.id, SESSION_KEY);
  const provider = new FakeWalletProvider();
  const execution: ExecuteTradeDeps = { chainId: 56, keyStore: POOL, agentStore: h.agents,
    settingsStore: h.settingsStore, journal: h.journal, killswitch: new MemoryKillSwitch(),
    providerRegistry: { get: () => provider },
    trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56,
      pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 }, aggregatorGuard: GUARD, feeBps: 0 }),
    pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 },
    pancakeV3: { router: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 }, uniswapV3: null, flapPortal: null, nowMs: () => now,
    v2EvidenceForReceipt: async input => ({ expected: { sessionPublicKey: input.sessionPublicKey,
      sessionGeneration: input.sessionGeneration, intentId: input.intentId, callsHash: input.callsHash },
      evidence: { chainId: 56, receiptStatus: "success", blockHash: H, blockNumber: 100n, wallet: WALLET,
        sessionPublicKey: input.sessionPublicKey, sessionGeneration: input.sessionGeneration,
        intentId: input.intentId, callsHash: input.callsHash, chainIntentHash: input.intentId, nonce: 0n,
        receiptOwned: true, singleWalletExecution: true, unexplainedRelevantTransfers: false,
        matchingIntent: true, matchingCalls: true, guardEventMatches: true, treasuryFeeMatches: true,
        ownership: { transactionHash: input.receipt.transactionHash!, swapLogIndex: 0n },
        actualInputAtomic: input.request.amountWei, actualOutputAtomic: input.request.quotedOutWei,
        verifiedEntryAtomic: input.request.side === "buy" ? input.request.amountWei : null,
        verifiedProceedsAtomic: input.request.side === "sell" ? input.request.quotedOutWei : null } }),
  };
  const fixtureExecutor = h.deps.executor;
  const deps: TradeWorkerDeps = { ...h.deps, executor: { execute: async input => {
    provider.nextReceipt = { status: "CONFIRMED", transactionHash: keccak256(stringToBytes(input.request.decisionId)) };
    const result = await executeTradeForAgent({ ...input, deps: execution });
    if (result.kind === "committed") await fixtureExecutor.execute(input);
    return result;
  } } };
  const buy = await runTradeWorkerOnce(deps);
  assert.equal(h.submitted.filter(r => r.side === "buy").length, 1);
  const initial = await h.settingsStore.get(OWNER, h.agent.id);
  assert.ok(initial);
  const settings = { ...v2Settings(), stopLossBps: 100 };
  await h.settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const opened = await h.positions.listOpen(OWNER, h.agent.id);
  assert.equal(opened.length, 1, JSON.stringify(buy));
  // A loss beyond the signed threshold drives the existing Altana exit lane.
  const sellDataPlane: TradeDataPlaneReads = { ...h.deps.dataPlane, binanceQuoteAndSwap: async request => ({
    version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD,
    tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic,
    quotedOutAtomic: (BigInt(request.amountAtomic) / 2n).toString(),
    minOutAtomic: (BigInt(request.amountAtomic) * 97n / 200n).toString(),
    router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
    calldata: "0xad43f73d", value: "0", observedAt: now, expiresAt: now + 15_000,
    estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56,
  }) };
  now += 60_000;
  const sell = await runTradeWorkerOnce({ ...deps, dataPlane: sellDataPlane });
  assert.equal(h.submitted.filter(r => r.side === "sell").length, 1, JSON.stringify(sell));
  const transcript = JSON.stringify({ buy, sell, calls: h.submitted,
    journal: await Promise.all(h.submitted.map(r => h.journal.getByDecision(h.agent.id, r.decisionId))),
    walletCalls: provider.executeCalls.map(r => ({ calls: r.calls, bypassLocalPolicyCheck: r.bypassLocalPolicyCheck,
      publicKey: r.session.publicKey, walletAddress: r.session.walletAddress })),
    intents: await h.intents.listProjectedV2(OWNER, h.agent.id),
    positions: await h.positions.list(OWNER, h.agent.id),
    runs: await h.positions.listRuns(OWNER, h.agent.id, 50),
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  const hash = crypto.createHash("sha256").update(transcript).digest("hex");
  assert.equal(hash, "75c53bb886522b9c39e96a3d1799370848636c16316028e72d74f8a14db53c3b");
  }
});

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
import { CMC_GLOBAL_TOOL } from "../src/trade/cmc.js";
import { CMC_SKILL_MACRO, CMC_SKILL_MACRO_RELEASE, CMC_SKILL_PLANNING, CMC_SKILL_SCANNER, CMC_SKILL_SECTOR } from "../src/trade/cmcUsEquity.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";

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
// The same Friday overnight: 04:00 UTC = 00:00 ET.
const OVERNIGHT_MS = Date.UTC(2026, 5, 5, 4, 0, 0);

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
  /** TRADFI-EXIT-RULES: owner exit settings (take profit / max hold) and the worker's rule mode; absent mode means `off`. */
  readonly ownerSettings?: Partial<TradeSettings>;
  readonly exitRulesMode?: "off" | "log" | "enforce";
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
  const settings: TradeSettings = { ...v2Settings(input.maxOpenPositions ?? 1, input.cmcNewsEnabled ?? false, input.slippageBps ?? 300), ...input.ownerSettings };
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
    ...(input.exitRulesMode === undefined ? {} : { tradfiExitRulesMode: input.exitRulesMode }),
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
        fill: request.request.side === "sell" ? { side: "sell", exitWei: null, fillStatus: "unverified" } : { side: "buy", entryWei: request.request.amountWei, tokenAmount: 5n * E, fillStatus: "verified" }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    rpcUrls: [], routeReader: reader, platformFeeBps: 0, tradfiNativeCostUsdtAtomic: async () => 1n,
    forbiddenAddresses: () => new Set(), executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: H }),
    recoverFill: async intent => intent.side === "buy" ? { side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" } : { side: "sell", exitWei: null, fillStatus: "unverified" }, now: input.now };
  return { deps, agent, positions, intents, submitted, settingsStore, llmState };
}

test("W1 AI simulated rollback reports SIMULATION_FAILED and releases its intent", async t => {
  t.mock.method(Date, "now", () => RTH_MS);
  const h = await harness({ now: () => RTH_MS });
  Object.assign(h.deps, { executor: { execute: async () => ({ kind: "rolled-back", code: "SIMULATION_FAILED", meta: { deniedBy: "venue" } }) } });
  const report = await runTradeWorkerOnce(h.deps);
  assert.equal(report.outcomes[0]?.reason, "SIMULATION_FAILED");
  assert.equal((await h.intents.listUnsettled(OWNER, h.agent.id)).length, 0);
});

async function loggedEvents(h: { readonly positions: MemoryTradePositionStore; readonly agent: { readonly id: string } }): Promise<readonly { readonly stage: string; readonly code: string }[]> {
  const runs = await h.positions.listRuns(OWNER, h.agent.id, 1);
  return runs[0]?.events ?? [];
}

test("shortlist requires score >= buy and no veto: empty shortlist makes no LLM call, but still refreshes the CMC global tools (never the dossier)", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const refreshCalls: { readonly heldTickers: readonly string[]; readonly shortlistedTickers: readonly string[] }[] = [];
  const h = await harness({ now: () => now, llmCounter, cmcNewsEnabled: true });
  // Override with a weak (all-default, unscored) feature plane: every component stays inactive.
  h.deps.dataPlane.featurePools = async () => ({ pools: [] });
  (h.deps as { refreshCmcNews?: unknown }).refreshCmcNews = async (input: { readonly heldTickers: readonly string[]; readonly shortlistedTickers: readonly string[] }) => { refreshCalls.push(input); };
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "score-hold");
  assert.equal(llmCounter.calls, 0);
  // runExits also refreshes independently; the entry lane's own call (empty shortlist) must be among them.
  assert.ok(refreshCalls.some((call) => call.shortlistedTickers.length === 0),
    JSON.stringify(refreshCalls.map((call) => ({ heldTickers: call.heldTickers, shortlistedTickers: call.shortlistedTickers }))));
});

test("a strong candidate reaches the shortlist and the entry LLM, and one buy is submitted per cycle", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
  assert.equal(h.submitted.filter(request => request.side === "buy").length, 1);
});

test("enter:false is a veto: no buy, logged llm-veto", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now, entryDecision: { decisions: [{ index: 0, enter: false, confidence: 100, reason: "no" }] } });
  await runTradeWorkerOnce(h.deps);
  assert.equal(h.submitted.filter(request => request.side === "buy").length, 0);
  assert.ok((await loggedEvents(h)).some(event => event.stage === "entry-llm" && event.code === "llm-veto"));
});

test("buy-pacing: an open position from the last 300s skips the buy stage and the LLM entirely", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  // The recent buy is on a second pinned token (TOKEN2) so the entry candidate (TOKEN) still scores
  // and shortlists; buy-pacing gates on ANY recent open/unsettled buy, not just the same token.
  const h = await harness({ now: () => now, llmCounter, maxOpenPositions: 2, stockBalance: 5n * E });
  await h.positions.open({ positionId: "recent", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN2,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 5n * E, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
    verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "buy-pacing");
  assert.equal(llmCounter.calls, 0);
});

test("overnight caps open positions at 3 and sizes the buy at 0.55x", async (context) => {
  const now = OVERNIGHT_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now, maxOpenPositions: 5,
    entryDecision: { decisions: [{ index: 0, enter: true, confidence: 100, amountAtomic: (20n * E).toString(), reason: "enter" }] } });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
  const buy = h.submitted.find(request => request.side === "buy");
  assert.ok(buy);
  // 20 USDT * 0.55 = 11 USDT, clamped inside [minEntryWei, entryWei] = [5, 20].
  assert.equal(buy!.amountWei, 11n * E);
});

test("overnight refuses a fourth open position (maxOpen = min(settings, 3))", async (context) => {
  const now = OVERNIGHT_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now, maxOpenPositions: 5, stockBalance: 5n * E });
  for (let index = 0; index < 3; index += 1) {
    await h.positions.open({ positionId: `p${index}`, agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
      route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 5n * E, tokenAmount: 5n * E,
      fillStatus: "verified", openedAt: now - 3_600_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
      verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|${index}|${H}` });
  }
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "at-capacity");
});

test("the final-confidence gate rejects a low-confidence entry even with an active shortlist candidate", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now,
    entryDecision: { decisions: [{ index: 0, enter: true, confidence: 0, amountAtomic: (5n * E).toString(), reason: "weak" }] } });
  await runTradeWorkerOnce(h.deps);
  assert.equal(h.submitted.filter(request => request.side === "buy").length, 0);
  assert.ok((await loggedEvents(h)).some(event => event.stage === "entry-llm" && event.code === "final-below-threshold"));
});

test("regime blend: a risk_off CMC global row and equity unavailable produce regime=risk_off in the run log", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const globalText = JSON.stringify({ data: { market_size: { total_market_cap: { value: "2 T", change_24h: "-3.5%", change_7d: "-1%" } } } });
  const cmcNews: Pick<CmcNewsService, "getFresh"> = { async getFresh({ ticker, skill }) {
    if (ticker !== "_GLOBAL" || skill !== "get_global_metrics_latest") return null;
    return { ticker, skill, text: globalText, sourceUrl: null, publishedAtMs: null, asOfMs: now, expiresAtMs: now + 3_600_000, payloadHash: `0x${"00".repeat(32)}` as Hex };
  } };
  const h = await harness({ now: () => now, cmcNews });
  await runTradeWorkerOnce(h.deps);
  assert.ok((await loggedEvents(h)).some(event => event.stage === "cmc" && event.code === "regime:risk_off"));
});

test("regime size scale: a risk_on CMC global row scales the buy amount by 1.12x before the min/max clamp", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const globalText = JSON.stringify({ data: { market_size: { total_market_cap: { value: "2 T", change_24h: "+5%", change_7d: "+2%" } } } });
  const cmcNews: Pick<CmcNewsService, "getFresh"> = { async getFresh({ ticker, skill }) {
    if (ticker !== "_GLOBAL" || skill !== "get_global_metrics_latest") return null;
    return { ticker, skill, text: globalText, sourceUrl: null, publishedAtMs: null, asOfMs: now, expiresAtMs: now + 3_600_000, payloadHash: `0x${"00".repeat(32)}` as Hex };
  } };
  const h = await harness({ now: () => now, cmcNews,
    entryDecision: { decisions: [{ index: 0, enter: true, confidence: 100, amountAtomic: (10n * E).toString(), reason: "enter" }] } });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
  const buy = h.submitted.find(request => request.side === "buy");
  // 10 USDT * 1.0 (rth sessionSizeMult) * 1.12 (risk_on) = 11.2 USDT, inside [5,20].
  assert.equal(buy!.amountWei, 11_200_000_000_000_000_000n);
});

test("exit: cost-band-breach asks the LLM once; a second unchanged cycle asks no-trigger and makes no LLM call", async (context) => {
  const now = { value: RTH_MS };
  context.mock.method(Date, "now", () => now.value);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now.value, stockBalance: 5n * E, llmCounter });
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now.value - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
    verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await runTradeWorkerOnce(h.deps);
  assert.equal(llmCounter.calls, 1);
  const afterFirst = await h.positions.get(OWNER, h.agent.id, "position");
  assert.ok(afterFirst?.exitLlmContext, "exit_llm_context is written after the ask");
  assert.equal(afterFirst!.exitLlmContext!.trigger, "cost-band-breach");
  // Position was sold by the first cycle's LLM exit=true decision, so open a fresh one at the same pnl
  // to prove the SECOND ask on an unchanged position is a no-trigger, not a re-ask.
  const stillOpen = await h.positions.listOpen(OWNER, h.agent.id);
  if (stillOpen.length === 0) {
    await h.positions.open({ positionId: "position2", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
      route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
      fillStatus: "verified", openedAt: now.value - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
      verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|1|${H}` });
    await h.positions.setExitLlmContext(OWNER, h.agent.id, "position2", { askedAtMs: now.value, pnlBps: 638, peakPnlBps: null,
      macdHistSign: null, emaSpreadSign: null, regime: "unavailable", session: "rth", trigger: "cost-band-breach" });
  }
  llmCounter.calls = 0;
  await runTradeWorkerOnce(h.deps);
  assert.equal(llmCounter.calls, 0, "no movement since the last ask must not re-trigger the LLM");
});

test("exit: an LLM outage on a triggered position writes no context, so the same trigger re-fires next cycle", async (context) => {
  const now = { value: RTH_MS };
  context.mock.method(Date, "now", () => now.value);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now.value, stockBalance: 5n * E, llmCounter });
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now.value - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
    verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  // First cycle: the LLM throws (outage; primary and fallback both throw). The trigger fired but must not be consumed.
  h.llmState.exitThrows = true;
  await runTradeWorkerOnce(h.deps);
  assert.ok(llmCounter.calls >= 1, "the outage cycle must still have asked");
  const afterOutage = await h.positions.get(OWNER, h.agent.id, "position");
  assert.equal(afterOutage?.exitLlmContext, undefined, "a thrown/off-schema answer must write no context");
  // Second cycle, LLM restored: the same trigger (nothing moved) must re-fire, not read as no-trigger.
  llmCounter.calls = 0;
  h.llmState.exitThrows = false;
  await runTradeWorkerOnce(h.deps);
  assert.ok(llmCounter.calls >= 1, "the outage cycle must not have consumed the trigger");
  const afterRetry = await h.positions.get(OWNER, h.agent.id, "position");
  assert.ok(afterRetry?.exitLlmContext, "the retried, validated answer writes the context");
});

test("draining sells an open position without an LLM call", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter });
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 5n * E, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
    verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await h.settingsStore.requestDrain(OWNER, h.agent.id);
  await runTradeWorkerOnce(h.deps);
  assert.equal(llmCounter.calls, 0);
  assert.ok(h.submitted.some(request => request.side === "sell"), "draining must sell without asking the LLM");
});

test("L2/R2.4: a 500 bps AI position sells via Flash with the request itself clamped to 300", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  let requestedSlippageBps: number | undefined;
  const h = await harness({ now: () => now, stockBalance: 5n * E, slippageBps: 500,
    // This harness's own routeReader always throws (line ~100), so the sell
    // goes through the Flash fallback regardless; only the request's OWN
    // slippageBps needs capturing here.
    binanceQuoteAndSwap: async request => { requestedSlippageBps = request.slippageBps; return {
      version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
      amountInAtomic: request.amountAtomic, quotedOutAtomic: request.amountAtomic, minOutAtomic: (BigInt(request.amountAtomic) * 97n / 100n).toString(),
      router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0",
      observedAt: now, expiresAt: now + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 }; } });
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 5n * E, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
    verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await h.settingsStore.requestDrain(OWNER, h.agent.id);
  await runTradeWorkerOnce(h.deps);
  const sold = h.submitted.find(request => request.side === "sell");
  assert.ok(sold?.guardQuote !== undefined, "the sell must route through the guard");
  assert.equal(requestedSlippageBps, 300, "the Flash request itself must carry the R2.4 clamp, not the owner's raw 500 bps");
});


// ---------------------------------------------------------------------------
// AUDIT MEDIUM-1/MEDIUM-2(6): a CMC-off agent's prompt must carry no CMC
// content at all; a CMC-on agent's prompt must carry the sector/scanner/
// macro/planning lines (R2.6), proving the rows actually reach the LLM ask.
// ---------------------------------------------------------------------------

function fullCmcNewsFake(now: number): Pick<CmcNewsService, "getFresh"> {
  const row = (skill: string, text: string) => ({ ticker: "_GLOBAL", skill, text, sourceUrl: null, publishedAtMs: null,
    asOfMs: now, expiresAtMs: now + 3_600_000, payloadHash: `0x${"00".repeat(32)}` as Hex });
  return {
    async getFresh({ ticker, skill }) {
      if (skill === CMC_GLOBAL_TOOL) return row(skill, '{"total_crypto_market_cap_usd":{"percent_change":{"24h":"+0.1%","7d":"+0.1%"}}}');
      if (skill === CMC_SKILL_MACRO) return row(skill, JSON.stringify({ upcoming: [], later: [], recent: [] }));
      if (skill === CMC_SKILL_SECTOR) {
        return row(skill, JSON.stringify({ sectors: [], themes: [], styleLeader: "growth", styleExcessPp: 4.95, benchmarks: [{ benchmark: "S&P 500", changeFromOpenPct: -0.5 }] }));
      }
      if (skill === CMC_SKILL_SCANNER) return row(skill, JSON.stringify({ asOfTradingDay: "2026-06-05", candidates: [] }));
      if (skill === CMC_SKILL_PLANNING) {
        return { ...row(skill, ""), ticker,
          text: JSON.stringify({ sessionDate: "2026-06-04", sectorProxy: null, latestCloseUsd: 1, ema20Pct: 1, ema50Pct: 1, ema200Pct: 1,
            emaChange5d20Pct: null, emaChange5d50Pct: null, atr14Pct: 1, returns5Pct: null, returns20Pct: null, returns63Pct: null,
            spyRel5Pct: null, spyRel20Pct: null, spyRel63Pct: null, support: null, resistance: null }) };
      }
      return null;
    },
  };
}

function promptText(messages: { readonly role: string; readonly content: string }[] | undefined): string {
  return (messages ?? []).map((m) => m.content).join("\n");
}

test("AUDIT MEDIUM-1/6: exit prompt carries no CMC content when cmcNewsEnabled is false, and carries the R2.6 lines when true", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const cmcNews = fullCmcNewsFake(now);

  const capturedOff: { readonly role: string; readonly content: string }[][] = [];
  const off = await harness({ now: () => now, stockBalance: 5n * E, cmcNews, cmcNewsEnabled: false, capturedMessages: capturedOff });
  await off.positions.open({ positionId: "position", agentId: off.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
    verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await runTradeWorkerOnce(off.deps);
  const offText = promptText(capturedOff[0]);
  assert.ok(offText.length > 0, "the exit LLM must still have been asked");
  assert.ok(!offText.includes("Optional paid context"), "no CMC header when cmcNewsEnabled is false");
  assert.ok(!offText.includes("us-market:"));
  assert.ok(!offText.includes("next closed-set:"));
  assert.ok(!offText.includes("STOCK —"));

  const capturedOn: { readonly role: string; readonly content: string }[][] = [];
  const on = await harness({ now: () => now, stockBalance: 5n * E, cmcNews, cmcNewsEnabled: true, capturedMessages: capturedOn });
  await on.positions.open({ positionId: "position", agentId: on.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
    verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await runTradeWorkerOnce(on.deps);
  const onText = promptText(capturedOn[0]);
  assert.ok(onText.includes("Optional paid context"), "the CMC header appears when cmcNewsEnabled is true");
  assert.ok(onText.includes("us-market:"), "the sector/style-leader line reaches the prompt");
  assert.ok(onText.includes("next closed-set:"), "the macro line reaches the prompt");
  assert.ok(onText.includes("STOCK —"), "the per-ticker sector/scanner/planning line reaches the prompt");
});

test("AUDIT MEDIUM-1/6: entry prompt carries no CMC content when cmcNewsEnabled is false, and carries the R2.6 lines when true", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const cmcNews = fullCmcNewsFake(now);

  const capturedOff: { readonly role: string; readonly content: string }[][] = [];
  const off = await harness({ now: () => now, cmcNews, cmcNewsEnabled: false, capturedMessages: capturedOff });
  await runTradeWorkerOnce(off.deps);
  const offText = promptText(capturedOff[0]);
  assert.ok(offText.length > 0, "the entry LLM must still have been asked");
  assert.ok(!offText.includes("Optional paid context"));
  assert.ok(!offText.includes("us-market:"));
  assert.ok(!offText.includes("next closed-set:"));
  assert.ok(!offText.includes("STOCK —"));

  const capturedOn: { readonly role: string; readonly content: string }[][] = [];
  const on = await harness({ now: () => now, cmcNews, cmcNewsEnabled: true, capturedMessages: capturedOn });
  await runTradeWorkerOnce(on.deps);
  const onText = promptText(capturedOn[0]);
  assert.ok(onText.includes("Optional paid context"));
  assert.ok(onText.includes("us-market:"));
  assert.ok(onText.includes("next closed-set:"));
  assert.ok(onText.includes("STOCK —"));
});

test("AUDIT M12/N2: the entry lane's own refreshCmcNews call still carries the held ticker from an already-open position, not just the shortlist", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const refreshCalls: { readonly heldTickers: readonly string[]; readonly shortlistedTickers: readonly string[] }[] = [];
  const h = await harness({ now: () => now, maxOpenPositions: 2, secondCandidate: true, cmcNewsEnabled: true, stockBalance: 5n * E,
    entryDecision: { decisions: [{ index: 0, enter: false, confidence: 100, reason: "no" }, { index: 1, enter: false, confidence: 100, reason: "no" }] } });
  (h.deps as { refreshCmcNews?: unknown }).refreshCmcNews = async (input: { readonly heldTickers: readonly string[]; readonly shortlistedTickers: readonly string[] }) => { refreshCalls.push(input); };
  await h.positions.open({ positionId: "held", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 5n * E, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
    verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await runTradeWorkerOnce(h.deps);
  // The entry lane's own call is identified by a non-empty shortlist (STOCK2, the
  // only candidate left once TOKEN is excluded as already-held).
  const entryCall = refreshCalls.find((call) => call.shortlistedTickers.length > 0);
  assert.ok(entryCall, `no entry-lane refreshCmcNews call seen: ${JSON.stringify(refreshCalls.map((c) => ({ held: c.heldTickers, shortlisted: c.shortlistedTickers })))}`);
  assert.deepEqual(entryCall!.shortlistedTickers, ["STOCK2"]);
  assert.deepEqual(entryCall!.heldTickers, ["STOCK"], "the held TOKEN's ticker must still be present, not dropped (N2/H7)");
});

test("AUDIT N7: the worker reads the NEWER of the daily macro row and the release row, not just the daily row", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const staleMacro = JSON.stringify({ upcoming: [], later: [], recent: [
    { event: "Core Inflation Rate", eventAtMs: now - 3_600_000, importance: "major", status: "scheduled",
      metrics: [{ metric: "Core Inflation Rate YoY (Aug)", actual: null, estimate: 3.4, previous: 3.3, unit: "%" }] },
  ] });
  const freshRelease = JSON.stringify({ upcoming: [], later: [], recent: [
    { event: "Core Inflation Rate", eventAtMs: now - 3_600_000, importance: "major", status: "released",
      metrics: [{ metric: "Core Inflation Rate YoY (Aug)", actual: 3.3, estimate: 3.4, previous: 3.3, unit: "%" }] },
  ] });
  const cmcNews: Pick<CmcNewsService, "getFresh"> = {
    async getFresh({ ticker, skill }) {
      if (skill === CMC_SKILL_MACRO) return { ticker, skill, text: staleMacro, sourceUrl: null, publishedAtMs: null, asOfMs: now - 3_600_000, expiresAtMs: now + 999_999, payloadHash: `0x${"00".repeat(32)}` as Hex };
      if (skill === CMC_SKILL_MACRO_RELEASE) return { ticker, skill, text: freshRelease, sourceUrl: null, publishedAtMs: null, asOfMs: now, expiresAtMs: now + 999_999, payloadHash: `0x${"00".repeat(32)}` as Hex };
      return null;
    },
  };
  const capturedOn: { readonly role: string; readonly content: string }[][] = [];
  const on = await harness({ now: () => now, cmcNews, cmcNewsEnabled: true, capturedMessages: capturedOn });
  await runTradeWorkerOnce(on.deps);
  const onText = promptText(capturedOn[0]);
  assert.ok(onText.includes("actual 3.3"), `expected the release row's actual value in the prompt: ${onText}`);
  assert.ok(!onText.includes("next closed-set: unknown"), "the newer release row must be read, not just the stale daily row");
});

// ---------------------------------------------------------------------------
// TRADFI-LLM-CMC-REQUEST §2-§5/R3.4: the LLM-requested `dataRequests` field,
// end to end through the entry lane (worker-side mapping, run-log, and the
// second fire-and-forget `refreshCmcNews` call with `llmRequests`).
// ---------------------------------------------------------------------------

test("dataRequests: an unmapped ticker is refused `unmapped` in the run log, and no second refreshCmcNews call carries llmRequests", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const cmcNews = fullCmcNewsFake(now);
  const refreshCalls: { readonly llmRequests?: readonly unknown[] }[] = [];
  // TOKEN's underlyingTicker stays the harness default "STOCK", which is NOT in
  // the static US_EQUITY_TICKER_CLASS pin — classifyLlmDataRequestTicker must
  // therefore refuse it `unmapped`.
  const h = await harness({ now: () => now, cmcNews, cmcNewsEnabled: true,
    entryDecision: { decisions: [{ index: 0, enter: false, confidence: 100, reason: "no" }],
      dataRequests: [{ index: 0, skill: "planning", reason: "STOCK line reads unknown" }] } });
  (h.deps as { refreshCmcNews?: unknown }).refreshCmcNews = async (input: { readonly llmRequests?: readonly unknown[] }) => { refreshCalls.push(input); };
  await runTradeWorkerOnce(h.deps);
  const events = await loggedEvents(h);
  assert.ok(events.some((event) => event.stage === "cmc" && event.code === "request:refused:unmapped"),
    `expected a request:refused:unmapped run-log event: ${JSON.stringify(events)}`);
  assert.ok(!events.some((event) => event.stage === "cmc" && event.code === "request:queued"));
  assert.ok(refreshCalls.every((call) => call.llmRequests === undefined), "an all-refused response must never forward llmRequests");
});

test("dataRequests: a mapped ticker is accepted, queued in the run log, and forwarded on a SECOND refreshCmcNews call that the worker never awaits", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const cmcNews = fullCmcNewsFake(now);
  const refreshCalls: { readonly heldTickers: readonly string[]; readonly shortlistedTickers: readonly string[]; readonly llmRequests?: readonly { readonly ticker: string; readonly skill: string; readonly reason: string; readonly source: string; readonly model: string }[] }[] = [];
  const h = await harness({ now: () => now, cmcNews, cmcNewsEnabled: true, underlyingTicker: "NVDA",
    entryDecision: { decisions: [{ index: 0, enter: false, confidence: 100, reason: "no" }],
      dataRequests: [{ index: 0, skill: "planning", reason: "NVDA line reads unknown" }] } });
  // A refreshCmcNews that NEVER resolves: if the worker awaited it, this cycle
  // would hang and the test would time out.
  (h.deps as { refreshCmcNews?: unknown }).refreshCmcNews = async (input: typeof refreshCalls[number]) => {
    refreshCalls.push(input);
    if (input.llmRequests !== undefined) await new Promise<void>(() => undefined);
  };
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "llm-hold");
  const events = await loggedEvents(h);
  assert.ok(events.some((event) => event.stage === "cmc" && event.code === "request:queued"),
    `expected a request:queued run-log event, saw codes: ${events.map((e) => `${e.stage}:${e.code}`).join(",")}`);
  const llmCall = refreshCalls.find((call) => call.llmRequests !== undefined);
  assert.ok(llmCall, `expected a second refreshCmcNews call carrying llmRequests; saw ${refreshCalls.length} calls`);
  assert.deepEqual(llmCall!.llmRequests, [{ ticker: "NVDA", skill: "planning", reason: "NVDA line reads unknown", source: "entry", model: "offline" }]);
});

// ---------------------------------------------------------------------------
// AUDIT M-4 (audited MEDIUM-1/H2 gate, now pinned WHILE the CMC runtime is
// actually wired): `refreshCmcNews` being defined must never be enough on its
// own to open the `dataRequests` gate — `settings.cmcNewsEnabled === true` is
// load-bearing in both lanes. Production always wires `refreshCmcNews`
// whenever the CMC runtime exists (`scripts/trade-worker.ts:425`), so a
// CMC-off owner in that (normal) deployment shape must still get a
// byte-identical, dataRequests-free prompt and a validator that rejects a
// dataRequests body outright.
// ---------------------------------------------------------------------------

test("AUDIT M-4: entry — cmcNewsEnabled false with refreshCmcNews WIRED still offers no dataRequests line, and a dataRequests response is llm-invalid", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const capturedMessages: { readonly role: string; readonly content: string }[][] = [];
  const refreshCalls: unknown[] = [];
  const h = await harness({ now: () => now, cmcNewsEnabled: false, capturedMessages, underlyingTicker: "NVDA",
    // A model that (wrongly) believes the gate is open, offering dataRequests anyway.
    entryDecision: { decisions: [{ index: 0, enter: false, confidence: 100, reason: "no" }],
      dataRequests: [{ index: 0, skill: "planning", reason: "NVDA line reads unknown" }] } });
  // Wired exactly as production wires it — the daemon never conditions this
  // assignment on cmcNewsEnabled (`scripts/trade-worker.ts:425`).
  (h.deps as { refreshCmcNews?: unknown }).refreshCmcNews = async (input: unknown) => { refreshCalls.push(input); };
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "llm-invalid",
    "a dataRequests-bearing response must be off-schema (and the whole cycle decide nothing) when cmcNewsEnabled is false, even with refreshCmcNews wired");
  const promptText2 = promptText(capturedMessages[0]);
  assert.ok(promptText2.length > 0, "the entry LLM must still have been asked");
  assert.equal(promptText2.includes("dataRequests"), false, "the CMC-off prompt must not offer dataRequests even though refreshCmcNews is wired");
});

test("AUDIT M-4: exit — cmcNewsEnabled false with refreshCmcNews WIRED still offers no dataRequests line, and a dataRequests response is rejected (no sell)", async (context) => {
  const now = { value: RTH_MS };
  context.mock.method(Date, "now", () => now.value);
  const capturedMessages: { readonly role: string; readonly content: string }[][] = [];
  const refreshCalls: unknown[] = [];
  const h = await harness({ now: () => now.value, stockBalance: 5n * E, cmcNewsEnabled: false, capturedMessages, underlyingTicker: "NVDA",
    exitDecision: { decisions: [{ index: 0, exit: true, reason: "sell" }],
      dataRequests: [{ index: 0, skill: "planning", reason: "NVDA line reads unknown" }] } });
  (h.deps as { refreshCmcNews?: unknown }).refreshCmcNews = async (input: unknown) => { refreshCalls.push(input); };
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 47n * E / 10n, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now.value - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 47n * E / 10n,
    verifiedEntryAtomic: 47n * E / 10n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await runTradeWorkerOnce(h.deps);
  assert.equal(h.submitted.filter((request) => request.side === "sell").length, 0,
    "a dataRequests-bearing response must be off-schema when cmcNewsEnabled is false, so no exit decision is acted on");
  const promptText2 = promptText(capturedMessages[0]);
  assert.ok(promptText2.length > 0, "the exit LLM must still have been asked");
  assert.equal(promptText2.includes("dataRequests"), false, "the CMC-off exit prompt must not offer dataRequests even though refreshCmcNews is wired");
});

// TRADFI-ENTRY-TIMING-SPEC §6: the entry timing gate in the tradfi v2 entry lane.
const OPENING_RANGE_MS = Date.UTC(2026, 5, 5, 13, 45, 0); // Friday 09:45 ET
const IMPULSE = { stochRsi14: 0.97, bbPosition20: 0.5 };
const CALM = { stochRsi14: 0.5, bbPosition20: 0.5 };

/** Gives each pool's 15m feature set the rev-2 stochRsi14 / bbPosition20 metrics the gate reads. */
function timingFeatures(h: { readonly deps: TradeWorkerDeps }, byPool: Readonly<Record<string, { readonly stochRsi14: number; readonly bbPosition20: number }>>): void {
  const base = h.deps.dataPlane.featuresBatch!.bind(h.deps.dataPlane);
  const metric = (value: number, requiredBars: number) => ({ value, unit: "ratio", requiredBars, usableBars: requiredBars, available: true, reason: null });
  h.deps.dataPlane.featuresBatch = async (pools, interval) => {
    const out = await base(pools, interval) as Record<string, { data: { metrics: Record<string, unknown> } }>;
    if (interval !== "15m") return out;
    return Object.fromEntries(Object.entries(out).map(([pool, entry]) => {
      const values = byPool[pool.toLowerCase()];
      return [pool, values === undefined ? entry : { ...entry, data: { ...entry.data, parameters: { indicatorRevision: 2 },
        metrics: { ...entry.data.metrics, stochRsi14: metric(values.stochRsi14, 42), bbPosition20: metric(values.bbPosition20, 20) } } }];
    }));
  };
}

async function timingEvents(h: { readonly positions: MemoryTradePositionStore; readonly agent: { readonly id: string } }) {
  const runs = await h.positions.listRuns(OWNER, h.agent.id, 1);
  return (runs[0]?.events ?? []).filter((event) => event.code.startsWith("timing:"));
}

test("entry timing log: a gated candidate is recorded once and still reaches the LLM and is bought", async (context) => {
  context.mock.method(Date, "now", () => RTH_MS);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => RTH_MS, llmCounter });
  Object.assign(h.deps, { entryTimingMode: "log" });
  timingFeatures(h, { [POOL.toLowerCase()]: IMPULSE });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
  assert.equal(llmCounter.calls, 1);
  assert.equal(h.submitted.filter((request) => request.side === "buy").length, 1);
  const events = await timingEvents(h);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.stage, "score");
  assert.equal(events[0]?.code, "timing:would-defer:impulse");
  assert.equal(events[0]?.token?.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(events[0]?.reason, "stochRsi=0.97 bb=0.50");
});

test("entry timing log: one event per gated candidate, none for an ungated one", async (context) => {
  context.mock.method(Date, "now", () => RTH_MS);
  const h = await harness({ now: () => RTH_MS, secondCandidate: true });
  Object.assign(h.deps, { entryTimingMode: "log" });
  timingFeatures(h, { [POOL.toLowerCase()]: IMPULSE, [POOL2.toLowerCase()]: CALM });
  await runTradeWorkerOnce(h.deps);
  const events = await timingEvents(h);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.token?.toLowerCase(), TOKEN.toLowerCase());
});

test("entry timing log: the opening range gates at 09:45 ET and the candidate is still bought", async (context) => {
  context.mock.method(Date, "now", () => OPENING_RANGE_MS);
  const h = await harness({ now: () => OPENING_RANGE_MS });
  Object.assign(h.deps, { entryTimingMode: "log" });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
  const events = await timingEvents(h);
  assert.deepEqual(events.map((event) => [event.code, event.reason]), [["timing:would-defer:opening-range", "et=09:45"]]);
});

test("entry timing enforce: the gated candidate is not offered to the LLM nor bought; the ungated one is", async (context) => {
  context.mock.method(Date, "now", () => RTH_MS);
  const capturedMessages: { readonly role: string; readonly content: string }[][] = [];
  const h = await harness({ now: () => RTH_MS, secondCandidate: true, capturedMessages });
  Object.assign(h.deps, { entryTimingMode: "enforce" });
  timingFeatures(h, { [POOL.toLowerCase()]: IMPULSE, [POOL2.toLowerCase()]: CALM });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
  const prompt = capturedMessages.flat().map((message) => message.content).join("\n").toLowerCase();
  assert.equal(prompt.includes(TOKEN.toLowerCase()), false, "the gated candidate must not be in the entry prompt");
  assert.equal(prompt.includes(TOKEN2.toLowerCase()), true);
  const buys = h.submitted.filter((request) => request.side === "buy");
  assert.equal(buys.length, 1);
  assert.equal(buys[0]?.token.toLowerCase(), TOKEN2.toLowerCase());
  const events = await timingEvents(h);
  assert.deepEqual(events.map((event) => [event.code, event.token?.toLowerCase()]), [["timing:deferred:impulse", TOKEN.toLowerCase()]]);
});

test("entry timing enforce: every candidate gated ends the cycle as timing-defer with no LLM call and no buy", async (context) => {
  context.mock.method(Date, "now", () => RTH_MS);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => RTH_MS, llmCounter });
  Object.assign(h.deps, { entryTimingMode: "enforce" });
  timingFeatures(h, { [POOL.toLowerCase()]: IMPULSE });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "timing-defer", JSON.stringify(result.outcomes));
  assert.equal(llmCounter.calls, 0);
  assert.equal(h.submitted.filter((request) => request.side === "buy").length, 0);
  assert.equal((await timingEvents(h))[0]?.code, "timing:deferred:impulse");
});

test("entry timing enforce: the opening range defers at 09:45 ET", async (context) => {
  context.mock.method(Date, "now", () => OPENING_RANGE_MS);
  const h = await harness({ now: () => OPENING_RANGE_MS });
  Object.assign(h.deps, { entryTimingMode: "enforce" });
  const result = await runTradeWorkerOnce(h.deps);
  assert.equal(result.outcomes[0]?.reason, "timing-defer", JSON.stringify(result.outcomes));
  assert.equal((await timingEvents(h))[0]?.code, "timing:deferred:opening-range");
});

test("entry timing off or unset: no event and the gated candidate is bought exactly as before", async (context) => {
  context.mock.method(Date, "now", () => OPENING_RANGE_MS);
  for (const mode of ["off", undefined] as const) {
    const h = await harness({ now: () => OPENING_RANGE_MS });
    if (mode !== undefined) Object.assign(h.deps, { entryTimingMode: mode });
    timingFeatures(h, { [POOL.toLowerCase()]: IMPULSE });
    const result = await runTradeWorkerOnce(h.deps);
    assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
    assert.equal((await timingEvents(h)).length, 0);
  }
});

test("entry timing log or enforce: an ungated candidate (calm bar, after 10:00 ET) emits nothing and is bought", async (context) => {
  context.mock.method(Date, "now", () => RTH_MS);
  for (const mode of ["log", "enforce"] as const) {
    const h = await harness({ now: () => RTH_MS });
    Object.assign(h.deps, { entryTimingMode: mode });
    timingFeatures(h, { [POOL.toLowerCase()]: CALM });
    const result = await runTradeWorkerOnce(h.deps);
    assert.equal(result.outcomes[0]?.reason, "entered", JSON.stringify(result.outcomes));
    assert.equal((await timingEvents(h)).length, 0);
  }
});

test("entry timing is wired into the tradfi v2 entry lane only", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const worker = readFileSync("src/trade/worker.ts", "utf8");
  assert.equal(worker.match(/entryTimingGate\(/gu)?.length, 1);
  const lane = worker.slice(worker.indexOf("async function runTradfiV2Entry("), worker.indexOf("async function processAgent("));
  assert.equal(lane.includes("entryTimingGate("), true);
  const importers: string[] = [];
  const walk = (dir: string): void => { for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts") && /entryTiming\.js/u.test(readFileSync(path, "utf8"))) importers.push(path.replace(/\\/gu, "/"));
  } };
  walk("src");
  assert.deepEqual(importers, ["src/trade/worker.ts"]);
});

// ---------------------------------------------------------------------------
// TRADFI-EXIT-RULES §3/§7: the trailing stop and the stale exit in the AI-trade exit lane.
// The harness quote is 5E for a 5E balance, so an entry of 4.7E reads +638 bps and an entry of 5E reads 0.
// ---------------------------------------------------------------------------

type RobotHarness = Awaited<ReturnType<typeof harness>>;
const HOUR_MS = 3_600_000;

async function openRobotPosition(h: RobotHarness, now: number, input: { readonly entryWei: bigint; readonly ageMs: number; readonly peakBps?: bigint }): Promise<void> {
  await h.positions.open({ positionId: "position", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: input.entryWei, tokenAmount: 5n * E,
    fillStatus: "verified", openedAt: now - input.ageMs, settlementAsset: "USDT", requestedEntryAtomic: input.entryWei,
    verifiedEntryAtomic: input.entryWei, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  if (input.peakBps !== undefined) {
    await h.positions.recordQuote({ ownerAddress: OWNER, agentId: h.agent.id, positionId: "position", quoteOutWei: 5n * E,
      pnlBps: input.peakBps, atMs: now - 120_000 });
  }
}

async function runEvents(h: RobotHarness) {
  return (await h.positions.listRuns(OWNER, h.agent.id, 1))[0]?.events ?? [];
}

const HOLD = { decisions: [{ index: 0, exit: false, reason: "hold" }] };
const ruleEvents = (events: Awaited<ReturnType<typeof runEvents>>) => events.filter(event => event.code.startsWith("rule:"));
const sells = (h: RobotHarness) => h.submitted.filter(request => request.side === "sell").length;

test("EXIT-RULES log: a trailing stop emits one would-exit event, the position still reaches the exit LLM and nothing is sold", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter, exitDecision: HOLD, exitRulesMode: "log" });
  await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 900n });
  await runTradeWorkerOnce(h.deps);
  const events = await runEvents(h);
  assert.deepEqual(ruleEvents(events).map(event => [event.stage, event.code, event.token, event.reason]),
    [["exit-llm", "rule:would-exit:trailing-stop", TOKEN, "peak=+900 now=+638"]]);
  assert.equal(llmCounter.calls, 1, "log mode leaves the position with the exit LLM as today");
  assert.ok(events.some(event => event.code === "trigger:cost-band-breach"));
  assert.equal(sells(h), 0);
  assert.equal((await h.positions.listOpen(OWNER, h.agent.id)).length, 1);
});

test("EXIT-RULES log: a stale exit is logged and the position still goes through the LLM candidate path (no trigger here)", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now, stockBalance: 5n * E, exitRulesMode: "log" });
  await openRobotPosition(h, now, { entryWei: 5n * E, ageMs: 49 * HOUR_MS });
  await runTradeWorkerOnce(h.deps);
  const events = await runEvents(h);
  assert.deepEqual(ruleEvents(events).map(event => [event.code, event.token, event.reason]),
    [["rule:would-exit:stale-exit", TOKEN, "held=49.0h pnl=+0"]]);
  assert.ok(events.some(event => event.stage === "exit-llm" && event.code === "no-trigger" && event.token === TOKEN),
    "the position was handed to the exit LLM lane, which found no trigger");
  assert.equal(sells(h), 0);
});

test("EXIT-RULES off (explicit or the dep left undefined): no rule event and the same LLM behaviour as before", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  for (const mode of [undefined, "off"] as const) {
    const llmCounter = { calls: 0 };
    const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter, exitDecision: HOLD, ...(mode === undefined ? {} : { exitRulesMode: mode }) });
    await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 49 * HOUR_MS, peakBps: 900n });
    await runTradeWorkerOnce(h.deps);
    assert.deepEqual(ruleEvents(await runEvents(h)), []);
    assert.equal(llmCounter.calls, 1);
    assert.equal(sells(h), 0);
  }
});

test("EXIT-RULES enforce: a trailing stop sells through sellPosition with close reason trailing-stop and never asks the LLM", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter, exitRulesMode: "enforce" });
  await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 900n });
  await runTradeWorkerOnce(h.deps);
  const events = await runEvents(h);
  assert.deepEqual(ruleEvents(events).map(event => [event.code, event.token, event.reason]),
    [["rule:exit:trailing-stop", TOKEN, "peak=+900 now=+638"]]);
  assert.equal(llmCounter.calls, 0, "an enforced rule exit is not sent to the exit LLM");
  assert.equal(sells(h), 1);
  assert.ok(events.some(event => event.stage === "sell" && event.reason === "trailing-stop"));
  const closed = await h.positions.get(OWNER, h.agent.id, "position");
  assert.equal(closed?.closeReason, "trailing-stop");
  assert.equal(closed?.closeNote, "peak=+900 now=+638");
});

test("EXIT-RULES enforce: a stale exit sells with close reason stale-exit and never asks the LLM", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter, exitRulesMode: "enforce" });
  await openRobotPosition(h, now, { entryWei: 5n * E, ageMs: 49 * HOUR_MS });
  await runTradeWorkerOnce(h.deps);
  assert.equal(llmCounter.calls, 0);
  assert.equal(sells(h), 1);
  const closed = await h.positions.get(OWNER, h.agent.id, "position");
  assert.equal(closed?.closeReason, "stale-exit");
  assert.equal(closed?.closeNote, "held=49.0h pnl=+0");
});

test("EXIT-RULES enforce: a position the rules do not fire on is untouched (no rule event, the LLM path as today)", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter, exitDecision: HOLD, exitRulesMode: "enforce" });
  await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 700n });
  await runTradeWorkerOnce(h.deps);
  assert.deepEqual(ruleEvents(await runEvents(h)), [], "638 against a 700 peak is inside the 150 giveback");
  assert.equal(llmCounter.calls, 1);
  assert.equal(sells(h), 0);
});

test("EXIT-RULES enforce: the owner's take profit and max hold win when they fire first", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const tp = await harness({ now: () => now, stockBalance: 5n * E, exitRulesMode: "enforce", ownerSettings: { takeProfitBps: 500 } });
  await openRobotPosition(tp, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 900n });
  await runTradeWorkerOnce(tp.deps);
  assert.equal((await tp.positions.get(OWNER, tp.agent.id, "position"))?.closeReason, "take-profit");
  assert.deepEqual(ruleEvents(await runEvents(tp)), []);
  const hold = await harness({ now: () => now, stockBalance: 5n * E, exitRulesMode: "enforce", ownerSettings: { maxHoldSec: 24 * 3_600 } });
  await openRobotPosition(hold, now, { entryWei: 5n * E, ageMs: 49 * HOUR_MS });
  await runTradeWorkerOnce(hold.deps);
  assert.equal((await hold.positions.get(OWNER, hold.agent.id, "position"))?.closeReason, "max-hold");
  assert.deepEqual(ruleEvents(await runEvents(hold)), []);
});

test("EXIT-RULES enforce: an owner take profit disables the trailing stop and an owner max hold disables the stale exit", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const tp = await harness({ now: () => now, stockBalance: 5n * E, exitDecision: HOLD, exitRulesMode: "enforce", ownerSettings: { takeProfitBps: 5_000 } });
  await openRobotPosition(tp, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 900n });
  await runTradeWorkerOnce(tp.deps);
  const tpEvents = await runEvents(tp);
  assert.deepEqual(ruleEvents(tpEvents), []);
  assert.ok(tpEvents.some(event => event.code === "trigger:cost-band-breach"), "the exit lane ran for this position (not an invalid-settings cycle)");
  assert.equal(sells(tp), 0);
  // maxHoldSec is capped at 7 days by the settings parser; a larger value would fail the whole cycle and make this test vacuous.
  const hold = await harness({ now: () => now, stockBalance: 5n * E, exitDecision: HOLD, exitRulesMode: "enforce", ownerSettings: { maxHoldSec: 6 * 24 * 3_600 } });
  await openRobotPosition(hold, now, { entryWei: 5n * E, ageMs: 49 * HOUR_MS });
  await runTradeWorkerOnce(hold.deps);
  const holdEvents = await runEvents(hold);
  assert.deepEqual(ruleEvents(holdEvents), []);
  assert.ok(holdEvents.some(event => event.stage === "exit-llm" && event.code === "no-trigger"), "the exit lane ran for this position");
  assert.equal(sells(hold), 0);
});

test("EXIT-RULES review M1: an implausible stored peak (2500) never arms the trailing stop, logs one peak-implausible event and leaves the LLM path alone", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const llmCounter = { calls: 0 };
  const h = await harness({ now: () => now, stockBalance: 5n * E, llmCounter, exitDecision: HOLD, exitRulesMode: "enforce" });
  await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 2_500n });
  await runTradeWorkerOnce(h.deps);
  assert.deepEqual(ruleEvents(await runEvents(h)).map(event => [event.stage, event.code, event.token, event.reason]),
    [["exit-llm", "rule:peak-implausible", TOKEN, "peak=+2500"]]);
  assert.equal(sells(h), 0, "enforce must not sell on a corrupted peak");
  assert.equal(llmCounter.calls, 1);
});

test("EXIT-RULES review M1: a peak of exactly 2000 still arms the trailing stop and logs no implausible event; the stale exit still sells under an implausible peak", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const edge = await harness({ now: () => now, stockBalance: 5n * E, exitRulesMode: "enforce" });
  await openRobotPosition(edge, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 2_000n });
  await runTradeWorkerOnce(edge.deps);
  assert.deepEqual(ruleEvents(await runEvents(edge)).map(event => [event.code, event.reason]), [["rule:exit:trailing-stop", "peak=+2000 now=+638"]]);
  assert.equal((await edge.positions.get(OWNER, edge.agent.id, "position"))?.closeReason, "trailing-stop");
  const stale = await harness({ now: () => now, stockBalance: 5n * E, exitRulesMode: "enforce" });
  await openRobotPosition(stale, now, { entryWei: 5n * E, ageMs: 49 * HOUR_MS, peakBps: 2_500n });
  await runTradeWorkerOnce(stale.deps);
  assert.deepEqual(ruleEvents(await runEvents(stale)).map(event => event.code), ["rule:peak-implausible", "rule:exit:stale-exit"]);
  assert.equal((await stale.positions.get(OWNER, stale.agent.id, "position"))?.closeReason, "stale-exit");
});

test("EXIT-RULES review L3: a position with no stored peak is evaluated without a peak (no trailing event, no peak-implausible event)", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now, stockBalance: 5n * E, exitDecision: HOLD, exitRulesMode: "enforce" });
  await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 60_000 });
  await runTradeWorkerOnce(h.deps);
  assert.deepEqual(ruleEvents(await runEvents(h)), []);
  assert.equal(sells(h), 0);
});

test("EXIT-RULES off: an implausible peak logs nothing", async (context) => {
  const now = RTH_MS;
  context.mock.method(Date, "now", () => now);
  const h = await harness({ now: () => now, stockBalance: 5n * E, exitDecision: HOLD });
  await openRobotPosition(h, now, { entryWei: 47n * E / 10n, ageMs: 60_000, peakBps: 2_500n });
  await runTradeWorkerOnce(h.deps);
  assert.deepEqual(ruleEvents(await runEvents(h)), []);
});

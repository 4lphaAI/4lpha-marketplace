import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { validateSessionSpec } from "../src/core/session.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { executeTradeForAgent } from "../src/trade/execute.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { FakeWalletProvider, tradeConfig, SESSION_KEY } from "./support/serverHarness.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const GUARD = getAddress("0x4444444444444444444444444444444444444444");
const POOL = getAddress("0x5555555555555555555555555555555555555555");
const KEY = `0x04${"77".repeat(64)}` as Hex;
const H = `0x${"88".repeat(32)}` as Hex;
const E = 10n ** 18n;

async function fixture(remainingSec = 86_400, originalFeeBps = 0, quoteCap = 60n * E) {
  const now = Date.now();
  const agents = new MemoryAgentStore();
  const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 },
    tokens: [{ token: TOKEN }], nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56,
    quoteDailyCapWei: quoteCap, quotePerTradeCapWei: 20n * E + 20n * E * BigInt(originalFeeBps) / 10_000n,
    platformFeeBps: originalFeeBps, treasury: OWNER, aggregatorGuard: GUARD,
    nowSeconds: Math.floor(now / 1000), expiresAt: Math.floor(now / 1000) + remainingSec });
  const agent = await agents.createAgent({ id: "core-fixes", ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", caps: { dailyNativeWei: E },
    sessionFacts: { spec, permissions: validateSessionSpec(spec),
      publicKey: KEY, expiry: spec.expiresAt, grantedAtSec: Math.floor(now / 1000) - 86_400, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: quoteCap.toString(),
        ...{ entryWei: (20n * E).toString(), quotePerTradeWei: (20n * E + 20n * E * BigInt(originalFeeBps) / 10_000n).toString() } } } });
  await agents.putAgentSessionKey(OWNER, agent.id, SESSION_KEY);
  return { now, agents, agent, provider: new FakeWalletProvider(), journal: new MemoryExecutionJournal(() => now) };
}

test("Core fix review: stock sell amount is never compared with USDT entry bounds", async () => {
  const h = await fixture();
  const result = await executeTradeForAgent({ agent: h.agent, request: { decisionId: "protective-sell",
    venue: "pancake", side: "sell", token: TOKEN, amountWei: E / 20n, quotedOutWei: 5n * E,
    minOutWei: 49n * E / 10n, settlementAsset: "USDT", platformFeeAtomic: 0n },
    idempotencyKey: H, paramsHash: H, scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: GUARD, agentStore: h.agents, journal: h.journal,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => h.provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null,
      flapPortal: null, nowMs: () => h.now } });
  assert.equal(h.provider.executeCalls.length, 1, result.kind === "denied" || result.kind === "rolled-back" ? result.code : result.kind);
});

test("Core fix review: a process fee increase cannot enlarge the granted entry debit ceiling", async () => {
  const h = await fixture(86_400, 100);
  const settingsStore = new MemoryTradeSettingsStore(h.agents, () => h.now);
  const settings: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
    minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled: false };
  await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const result = await executeTradeForAgent({ agent: h.agent, request: { decisionId: "fee-rise",
    venue: "pancake", side: "buy", token: TOKEN, amountWei: 20n * E, quotedOutWei: 20n * E,
    minOutWei: 194n * E / 10n, settlementAsset: "USDT", platformFeeAtomic: E },
    idempotencyKey: H, paramsHash: H, scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: GUARD, agentStore: h.agents, journal: h.journal, settingsStore,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => h.provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, feeBps: 500, feeTreasury: OWNER }),
      pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null,
      flapPortal: null, nowMs: () => h.now } });
  assert.equal(h.provider.executeCalls.length, 0);
  assert.ok((result.kind === "denied" || result.kind === "rolled-back") && result.code === "USDT_ENTRY_CAP",
    result.kind === "denied" || result.kind === "rolled-back" ? result.code : result.kind);
});

test("Core fix review: an omitted settlement field cannot route a v2 hire through native execution", async () => {
  const h = await fixture();
  const result = await executeTradeForAgent({ agent: h.agent, request: { decisionId: "wrong-denomination",
    venue: "pancake", side: "buy", token: TOKEN, amountWei: E / 1000n, quotedOutWei: E,
    minOutWei: 97n * E / 100n }, idempotencyKey: H, paramsHash: H,
    scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: GUARD, agentStore: h.agents, journal: h.journal,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => h.provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null,
      flapPortal: null, nowMs: () => h.now } });
  assert.equal(h.provider.executeCalls.length, 0, result.kind);
});

test("Core fix review: a valid owner minimum decrease applies within the original maximum", async () => {
  const h = await fixture();
  const settingsStore = new MemoryTradeSettingsStore(h.agents, () => h.now);
  const settings: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
    minEntryWei: E.toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(), cmcNewsEnabled: false };
  await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const result = await executeTradeForAgent({ agent: h.agent, request: { decisionId: "lowered-minimum",
    venue: "pancake", side: "buy", token: TOKEN, amountWei: E, quotedOutWei: E,
    minOutWei: 97n * E / 100n, settlementAsset: "USDT", platformFeeAtomic: 0n },
    idempotencyKey: H, paramsHash: H, scanGate: { evaluate: async () => ({ verdict: "allow", reasons: [] }) },
    deps: { chainId: 56, keyStore: GUARD, agentStore: h.agents, journal: h.journal, settingsStore,
      killswitch: new MemoryKillSwitch(), providerRegistry: { get: () => h.provider },
      trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null,
      flapPortal: null, nowMs: () => h.now } });
  assert.equal(h.provider.executeCalls.length, 1, result.kind === "denied" || result.kind === "rolled-back" ? result.code : result.kind);
});

async function premiumCase(stockDecimals = 18, settlementUsd = 1, withMetadata = true, withFreshSettlement = true,
  modelStep?: () => void, raiseMinimum = false, remainingSec = 86_400,
  pendingCash?: { readonly lateHoldWei: bigint }) {
  const quoteCap = pendingCash === undefined ? 60n * E : 100n * E;
  const h = await fixture(remainingSec, 0, quoteCap);
  let journalNow = h.now;
  const journal = pendingCash === undefined ? h.journal : new MemoryExecutionJournal(() => journalNow);
  const hold = async (label: string, amount: bigint) => {
    await journal.beginWithSpend({ idempotencyKey: keccak256(stringToBytes(label)), agentId: h.agent.id,
      ownerAddress: OWNER, kind: "trade", nativeSpendWei: 0n, quoteSpendWei: amount,
      externalRef: { quoteSpendWei: amount.toString() } }, 0);
  };
  if (pendingCash !== undefined) {
    journalNow = h.now - 2 * 86_400_000;
    await hold("old-pending-hold", 10n * E);
    journalNow = h.now;
  }
  const positions = new MemoryTradePositionStore(() => h.now);
  const intents = new MemoryTradeIntentStore(() => h.now);
  const settingsStore = new MemoryTradeSettingsStore(h.agents, () => h.now);
  const settings: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
    minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: quoteCap.toString(),
    cmcNewsEnabled: false, maxOpenPositions: 1, takeProfitBps: null, stopLossBps: null, maxHoldSec: null };
  await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  let buys = 0;
  let maxOffered: bigint | null = null;
  const unavailable = async (): Promise<bigint> => { throw new Error("no AMM"); };
  const deps: TradeWorkerDeps = { agentStore: h.agents, settingsStore, positions, intents, journal, aggregatorGuard: GUARD,
    dataPlane: { ...strongFeatureDataPlane(TOKEN, POOL, h.now), universe: async lane => lane === "bstocks" ? [{ address: TOKEN, symbol: "STOCK", lane: "bstocks",
      source: "fixture", venues: [], rwa: { platform: "bstocks", underlyingTicker: "STOCK", tokenPriceUsd: 100,
        referencePriceUsd: 100, premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING",
        staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 100, venues: [] } }] : [],
      tokensBatch: async addresses => addresses.map(address => ({ address, symbol: address.toLowerCase() === USDT_56.toLowerCase() ? "USDT" : "STOCK",
        priceUsd: address.toLowerCase() === USDT_56.toLowerCase() ? settlementUsd : 100,
        marketCapUsd: 1_000_000_000, volume24hUsd: 1_000, holders: 100, priceChange24hPct: 0,
        ...(withFreshSettlement || address.toLowerCase() !== USDT_56.toLowerCase()
          ? { asOf: Date.now(), source: "pancake-v3-slot0", staleness: "fresh" as const, updatedFields: ["priceUsd"] } : {}) })),
      eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist", venue: null })),
      security: async () => ({ riskLevel: "ok", flags: [] }),
      binanceQuoteAndSwap: async request => { const output = request.tokenIn.toLowerCase() === USDT_56.toLowerCase()
        ? BigInt(request.amountAtomic) * 10n ** BigInt(stockDecimals) / (100n * E)
        : BigInt(request.amountAtomic) * 100n * E / 10n ** BigInt(stockDecimals);
        return { version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn,
          tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic, quotedOutAtomic: output.toString(),
          minOutAtomic: (output * 97n / 100n).toString(), router: TRADFI_BINANCE_FLASH_ROUTER_56,
          spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0", observedAt: Date.now(),
          expiresAt: Date.now() + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 }; } },
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? (pendingCash === undefined ? 60n * E : 20n * E) : 0n,
      ...(withMetadata ? { getTokenMetadata: async ({ token }: { token: `0x${string}` }) => ({ decimals: token.toLowerCase() === USDT_56.toLowerCase() ? 18 : stockDecimals, symbol: "STOCK" }) } : {}),
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: quoteCap, currentSpentWei: 0n }] },
    v2DataBudgetReservedWei: async () => pendingCash === undefined ? 0n : 2n * E,
    llmFor: () => ({ complete: async messages => {
      const lines = messages.flatMap(message => message.content.split("\n"));
      const columns = lines.find(line => line.startsWith("index\tsymbol"))?.split("\t");
      const candidate = lines.find(line => line.startsWith("0\t"))?.split("\t");
      const maxIndex = columns?.indexOf("maxEntryAtomic") ?? -1;
      const maxValue = maxIndex < 0 ? undefined : candidate?.[maxIndex];
      if (maxValue !== undefined && /^\d+$/u.test(maxValue)) maxOffered = BigInt(maxValue);
      if (pendingCash !== undefined && pendingCash.lateHoldWei > 0n) await hold("late-pending-hold", pendingCash.lateHoldWei);
      modelStep?.();
      if (raiseMinimum) {
        const revised = { ...settings, minEntryWei: (10n * E).toString() };
        await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: revised, digest: tradeSettingsDigest(revised) });
      }
      return { model: "fixture", content: JSON.stringify({ decisions: [{ index: 0,
        enter: true, confidence: 100, amountAtomic: (5n * E).toString(), reason: "fair reference" }] }) };
    } }),
    executor: { execute: async request => { if (request.request.side === "buy") buys += 1;
      return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H }, fill: {
        side: "buy", entryWei: request.request.amountWei, tokenAmount: null, fillStatus: "unverified" }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    rpcUrls: [], routeReader: { quoteV2: unavailable, quoteV3Single: unavailable, quoteV3Path: unavailable,
      quoteUniV3Single: unavailable, quoteUniV3Path: unavailable }, platformFeeBps: 0,
    tradfiNativeCostUsdtAtomic: async () => 1n, forbiddenAddresses: () => new Set(),
    executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: H }),
    recoverFill: async intent => ({ side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" }),
    now: () => Date.now() };
  const result = await runTradeWorkerOnce(deps);
  return { buys, result, maxOffered };
}

test("Core fix review: a fair 100 USD stock passes the actual-size premium calculation", async () => {
  const { buys, result } = await premiumCase();
  assert.equal(buys, 1, JSON.stringify(result.outcomes));
});

test("Core fix review: premium comparison uses the stock's actual decimals", async () => {
  const { buys, result } = await premiumCase(6);
  assert.equal(buys, 1, JSON.stringify(result.outcomes));
});

test("Core fix review: premium comparison values settlement at its fresh USD price", async () => {
  const { buys, result } = await premiumCase(18, 1.02);
  assert.equal(buys, 0, JSON.stringify(result.outcomes));
});

test("Core fix review: missing token decimals do not silently become 18", async () => {
  const { buys, result } = await premiumCase(18, 1, false);
  assert.equal(buys, 0, JSON.stringify(result.outcomes));
});

test("Core fix review: a price without freshness provenance cannot admit entry", async () => {
  const { buys, result } = await premiumCase(18, 1, true, false);
  assert.equal(buys, 0, JSON.stringify(result.outcomes));
});

test("Core fix review: entry fence rechecks owner settings changed during inference", async () => {
  const { buys, result } = await premiumCase(18, 1, true, true, undefined, true);
  assert.equal(buys, 0, JSON.stringify(result.outcomes));
});

test("Core fix review: entry fence rechecks a session cutoff crossed during inference", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const { buys, result } = await premiumCase(18, 1, true, true, () => { now += 20_000; }, false, 7_210);
  assert.equal(buys, 0, JSON.stringify(result.outcomes));
});

test("Core fix review: old pending USDT holds bound prompt cash and new holds bind the entry fence", async () => {
  for (const lateHoldWei of [0n, 6n * E]) {
    const result = await premiumCase(18, 1, true, true, undefined, false, 86_400, { lateHoldWei });
    assert.ok(result.maxOffered !== null, "the 8-USDT feasible interval must reach the entry model");
    assert.ok(result.maxOffered <= 8n * E, "wallet20 minus data2 minus old pending10 leaves at most8");
    assert.equal(result.buys, lateHoldWei === 0n ? 1 : 0,
      "a 5-USDT choice fits old cash8; a new hold6 during inference must block it at the fence");
  }
});

test("Core fix review: late entry basis can be adopted after an unverified position closed", async () => {
  const h = await fixture();
  const positions = new MemoryTradePositionStore(() => h.now);
  await positions.open({ positionId: "late-entry", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: null, fillStatus: "unverified",
    openedAt: h.now - 1000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: null });
  await positions.closePosition({ ownerAddress: OWNER, agentId: h.agent.id, positionId: "late-entry",
    exitWei: null, exitFillStatus: "unverified", reason: "owner-request" });
  await positions.adoptVerifiedEntry({ ownerAddress: OWNER, agentId: h.agent.id, positionId: "late-entry",
    verifiedEntryAtomic: 5n * E, tokenAmount: E / 20n, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  assert.equal((await positions.get(OWNER, h.agent.id, "late-entry"))?.verifiedEntryAtomic, 5n * E);
});

test("Core fix review: projected sell receives late verified proceeds without resubmission", async () => {
  const h = await fixture();
  const positions = new MemoryTradePositionStore(() => h.now);
  const intents = new MemoryTradeIntentStore(() => h.now);
  const settingsStore = new MemoryTradeSettingsStore(h.agents, () => h.now);
  await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: DEFAULT_TRADE_SETTINGS,
    digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
  await positions.open({ positionId: "late-sell", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: E / 20n, fillStatus: "verified",
    openedAt: h.now - 1000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E,
    receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  await positions.closePosition({ ownerAddress: OWNER, agentId: h.agent.id, positionId: "late-sell",
    exitWei: null, exitFillStatus: "unverified", reason: "owner-request" });
  await intents.create({ decisionId: "late-sell-intent", idempotencyKey: H, agentId: h.agent.id, ownerAddress: OWNER,
    side: "sell", token: TOKEN, route: { hops: [], fees: [] }, venue: "pancake_v2", amountWei: E / 20n,
    entryWei: 5n * E, positionId: "late-sell", closeReason: "owner-request", settlementAsset: "USDT",
    minOutAtomic: 49n * E / 10n, quotedOutAtomic: 5n * E });
  await h.journal.begin({ idempotencyKey: H, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade" });
  await h.journal.markCommitted(H, { txHash: H });
  await intents.markSubmitted(OWNER, h.agent.id, "late-sell-intent", H);
  await intents.markProjected(OWNER, h.agent.id, "late-sell-intent");
  let submissions = 0;
  const deps: TradeWorkerDeps = { agentStore: h.agents, settingsStore, positions, intents, journal: h.journal,
    dataPlane: { universe: async () => [], tokensBatch: async () => [], eligibilityBatch: async () => [], security: async () => ({}) },
    provider: { getTokenBalance: async () => 0n }, llmFor: () => ({ complete: async () => { throw new Error("no model expected"); } }),
    executor: { execute: async () => { submissions += 1; throw new Error("no submission expected"); } }, executorDeps: {},
    readiness: { ready: false, allowlistAvailable: false, bstocksAddresses: new Set() }, rpcUrls: [], platformFeeBps: 0,
    forbiddenAddresses: () => new Set(), executionIdentity: () => ({ idempotencyKey: H, paramsHash: H }),
    recoverFill: async () => ({ side: "sell", exitWei: 5n * E, fillStatus: "verified",
      receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|1|${H}` }), now: () => h.now };
  await runTradeWorkerOnce(deps);
  assert.equal(submissions, 0);
  assert.equal((await positions.get(OWNER, h.agent.id, "late-sell"))?.exitWei, 5n * E);
});

test("Core fix review: fresh model exit preserves the better guarded offer when direct also works", async () => {
  const h = await fixture();
  const positions = new MemoryTradePositionStore(() => h.now);
  const intents = new MemoryTradeIntentStore(() => h.now);
  const settingsStore = new MemoryTradeSettingsStore(h.agents, () => h.now);
  const settings: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
    minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(),
    cmcNewsEnabled: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, crashProtection: false };
  await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  await positions.open({ positionId: "hybrid-exit", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: E / 20n, fillStatus: "verified",
    openedAt: h.now - 60_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E,
    receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
  let stockBalance = E / 20n;
  let selectedGuard = false;
  let selectedOutput = 0n;
  const deps: TradeWorkerDeps = { agentStore: h.agents, settingsStore, positions, intents, journal: h.journal, aggregatorGuard: GUARD,
    dataPlane: { universe: async () => [], tokensBatch: async () => [], eligibilityBatch: async () => [], security: async () => ({}),
      binanceQuoteAndSwap: async request => ({ version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD,
        tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic,
        quotedOutAtomic: (6n * E).toString(), minOutAtomic: (6n * E * 97n / 100n).toString(),
        router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
        calldata: "0xad43f73d", value: "0", observedAt: Date.now(), expiresAt: Date.now() + 15_000,
        estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 }) },
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? 60n * E : stockBalance,
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 60n * E, currentSpentWei: 0n }] },
    llmFor: () => ({ complete: async () => ({ model: "fixture", content: JSON.stringify({ decisions: [{ index: 0, exit: true, reason: "sell" }] }) }) }),
    executor: { execute: async request => { selectedGuard = request.request.guardQuote !== undefined;
      selectedOutput = request.request.quotedOutWei; stockBalance = 0n;
      return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H },
        fill: { side: "sell", exitWei: null, fillStatus: "unverified" }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    rpcUrls: [], routeReader: { quoteV2: async () => 5n * E, quoteV3Single: async () => 5n * E,
      quoteV3Path: async () => 5n * E, quoteUniV3Single: async () => 5n * E, quoteUniV3Path: async () => 5n * E },
    platformFeeBps: 0, tradfiNativeCostUsdtAtomic: async () => 1n, forbiddenAddresses: () => new Set(),
    executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: H }),
    recoverFill: async () => ({ side: "sell", exitWei: null, fillStatus: "unverified" }), now: () => Date.now() };
  await runTradeWorkerOnce(deps);
  assert.equal(selectedGuard, true);
  assert.equal(selectedOutput, 6n * E);
});

test("Core fix review: rejected receipt ownership cannot release another intent's reservation", async () => {
  const h = await fixture();
  const positions = new MemoryTradePositionStore(() => h.now);
  const intents = new MemoryTradeIntentStore(() => h.now);
  const settingsStore = new MemoryTradeSettingsStore(h.agents, () => h.now);
  await settingsStore.put({ agentId: h.agent.id, ownerAddress: OWNER, params: DEFAULT_TRADE_SETTINGS,
    digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
  const ownership = `56|${H}|${WALLET.toLowerCase()}|0|${H}`;
  await positions.open({ positionId: "owned", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 6n * E, tokenAmount: E / 20n, fillStatus: "verified",
    openedAt: h.now - 2000, settlementAsset: "USDT", requestedEntryAtomic: 6n * E,
    verifiedEntryAtomic: 5n * E, receiptOwnershipKey: ownership });
  await positions.closePosition({ ownerAddress: OWNER, agentId: h.agent.id, positionId: "owned", exitWei: null });
  await positions.open({ positionId: "claim-conflict", agentId: h.agent.id, ownerAddress: OWNER, token: TOKEN,
    route: { hops: [], fees: [] }, entryWei: 6n * E, tokenAmount: null, fillStatus: "unverified",
    openedAt: h.now - 1000, settlementAsset: "USDT", requestedEntryAtomic: 6n * E, verifiedEntryAtomic: null });
  await intents.create({ decisionId: "claim-intent", idempotencyKey: H, agentId: h.agent.id, ownerAddress: OWNER,
    side: "buy", token: TOKEN, route: { hops: [], fees: [] }, venue: "pancake_v2", amountWei: 6n * E,
    entryWei: 6n * E, positionId: "claim-conflict", closeReason: null, settlementAsset: "USDT",
    minOutAtomic: E / 20n, quotedOutAtomic: E / 20n });
  await h.journal.begin({ idempotencyKey: H, agentId: h.agent.id, ownerAddress: OWNER, kind: "trade",
    externalRef: { quoteSpendWei: (6n * E).toString() } });
  await h.journal.markCommitted(H, { txHash: H });
  await intents.markSubmitted(OWNER, h.agent.id, "claim-intent", H);
  await intents.markProjected(OWNER, h.agent.id, "claim-intent");
  const deps: TradeWorkerDeps = { agentStore: h.agents, settingsStore, positions, intents, journal: h.journal,
    dataPlane: { universe: async () => [], tokensBatch: async () => [], eligibilityBatch: async () => [], security: async () => ({}) },
    provider: { getTokenBalance: async () => 0n }, llmFor: () => ({ complete: async () => { throw new Error("no model expected"); } }),
    executor: { execute: async () => { throw new Error("no submission expected"); } }, executorDeps: {},
    readiness: { ready: false, allowlistAvailable: false, bstocksAddresses: new Set() }, rpcUrls: [], platformFeeBps: 0,
    forbiddenAddresses: () => new Set(), executionIdentity: () => ({ idempotencyKey: H, paramsHash: H }),
    recoverFill: async () => ({ side: "buy", entryWei: 5n * E, tokenAmount: E / 20n,
      verifiedEntryAtomic: 5n * E, fillStatus: "verified", receiptOwnershipKey: ownership }), now: () => h.now };
  await runTradeWorkerOnce(deps);
  assert.equal((await positions.get(OWNER, h.agent.id, "claim-conflict"))?.verifiedEntryAtomic, null);
  assert.equal((await h.journal.get(H))?.externalRef.actualQuoteSpendWei, undefined);
});

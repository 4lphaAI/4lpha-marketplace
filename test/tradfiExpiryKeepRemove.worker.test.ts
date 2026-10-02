/**
 * TRADFI-EXPIRY-KEEP-REMOVE worker boundaries: R2 (no automatic sale at expiry),
 * the reconcile disposal of an inert hashless UNKNOWN sell (§2.2) and the
 * revoked-agent sweep's orphan-skip. Offline, memory stores, TradFi AI settings.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import type { FinalizedSessionRevocationVerdict } from "../src/account/keyStoreReader.js";
import { validateSessionSpec } from "../src/core/session.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { PANCAKE_V2_ROUTER_56, PANCAKE_V3_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradePositionStore, type TradeEvidenceExpected } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { parseInertEvidence } from "../src/trade/inertSubmission.js";
import type { TradeDataPlaneReads, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import type { TradeRequest } from "../src/http/wire.js";
import { assessRenewalQuiescence } from "../src/wallet/provisioning.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import type { AgentStore } from "../src/store/agents.js";
import { executeTradeForAgent } from "../src/trade/execute.js";
import { FakeWalletProvider, tradeConfig } from "./support/serverHarness.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const GUARD = getAddress("0x4444444444444444444444444444444444444444");
const POOL = getAddress("0x5555555555555555555555555555555555555555");
const KEYSTORE = getAddress("0x6666666666666666666666666666666666666666");
const H = `0x${"66".repeat(32)}` as Hex;
const KEY = `0x04${"77".repeat(64)}` as Hex;
const OTHER_KEY = `0x04${"78".repeat(64)}` as Hex;
const E = 10n ** 18n;
const AGENT_ID = "tradfi-ai-agent";
// A Friday in RTH (America/New_York): 2026-06-05, 14:00 UTC = 10:00 ET.
const NOW = Date.UTC(2026, 5, 5, 14, 0, 0);
const NOW_SEC = Math.floor(NOW / 1_000);

const aiSettings = (over: Partial<TradeSettings> = {}): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi",
  settlementAsset: "USDT", minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (60n * E).toString(),
  cmcNewsEnabled: false, maxOpenPositions: 1, slippageBps: 300, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
  crashProtection: false, ...over });

const legacySettings = (): TradeSettings => ({ ...DEFAULT_TRADE_SETTINGS, executionModel: "sigma" });

const HOLD = { decisions: [{ index: 0, exit: false, reason: "hold" }] };

async function harness(input: { readonly settings?: TradeSettings; readonly expirySec?: number; readonly status?: "armed" | "revoked";
  readonly exitDecision?: unknown; readonly stockBalance?: bigint; readonly sessionKey?: Hex; readonly generation?: number } = {}) {
  const agents = new MemoryAgentStore();
  const positions = new MemoryTradePositionStore(() => NOW);
  const intents = new MemoryTradeIntentStore(() => NOW);
  const settingsStore = new MemoryTradeSettingsStore(agents, () => NOW);
  const journal = new MemoryExecutionJournal(() => NOW);
  const policy = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56 },
    tokens: [{ token: TOKEN }], nativeCaps: [{ limit: E, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 300n * E,
    quotePerTradeCapWei: 20n * E, platformFeeBps: 0, aggregatorGuard: GUARD, nowSeconds: NOW_SEC, expiresAt: NOW_SEC + 86_400 });
  const created = await agents.createAgent({ id: AGENT_ID, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed",
    sessionFacts: { spec: policy, permissions: validateSessionSpec(policy, { nowSeconds: NOW_SEC, minSessionSeconds: 0 }),
      publicKey: input.sessionKey ?? KEY, expiry: input.expirySec ?? policy.expiresAt, grantedAtSec: NOW_SEC - 6 * 86_400,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() } } });
  const settings = input.settings ?? aiSettings();
  await settingsStore.put({ agentId: AGENT_ID, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  if (input.status === "revoked") await agents.updateAgentStatus(OWNER, AGENT_ID, "revoked");
  const venue: VenueRow = { dex: "pancakeswap", version: "v3", pool: POOL, quote: USDT_56, quoteSymbol: "USDT", feeTier: 100,
    liquidityUsd: 100_000, volume24hUsd: 1_000, priceUsd: 1, asOf: NOW };
  const rows: UniverseRow[] = [{ address: TOKEN, symbol: "STOCK", lane: "bstocks", source: "fixture", venues: [venue],
    rwa: { platform: "bstocks", underlyingTicker: "STOCK", tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true,
      marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [venue] } }];
  const dataPlane: TradeDataPlaneReads = {
    async featurePools() { return { pools: [] }; },
    async featuresBatch() { return {}; },
    universe: async (lane) => lane === "bstocks" ? rows : [],
    tokensBatch: async (addresses) => addresses.map((address) => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1_000_000_000,
      volume24hUsd: 1_000, holders: 100, priceChange24hPct: 1, asOf: NOW, source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
    eligibilityBatch: async (addresses) => addresses.map((address) => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }),
    binanceQuoteAndSwap: async (request) => ({ version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn,
      tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic, quotedOutAtomic: request.amountAtomic,
      minOutAtomic: (BigInt(request.amountAtomic) * 97n / 100n).toString(), router: TRADFI_BINANCE_FLASH_ROUTER_56,
      spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0", observedAt: NOW, expiresAt: NOW + 15_000,
      estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 }),
  };
  const reader: RouteQuoteReader = { quoteV2: async () => { throw new Error("no public AMM"); }, quoteV3Single: async () => { throw new Error("no public AMM"); },
    quoteV3Path: async () => { throw new Error("no public AMM"); }, quoteUniV3Single: async () => { throw new Error("no public AMM"); },
    quoteUniV3Path: async () => { throw new Error("no public AMM"); } };
  const submitted: TradeRequest[] = [];
  const logs: string[] = [];
  let stockBalance = input.stockBalance ?? 0n;
  const deps: TradeWorkerDeps = { agentStore: agents, positions, intents, settingsStore, journal, dataPlane, aggregatorGuard: GUARD,
    provider: { getTokenBalance: async ({ token }) => token.toLowerCase() === USDT_56.toLowerCase() ? 300n * E : stockBalance,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "STOCK" }),
      readSpendInfos: async () => [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 300n * E, currentSpentWei: 0n }] },
    llmFor: () => ({ complete: async (messages) => {
      const isExit = messages[0]?.content.startsWith("Decide only") === true || messages[0]?.content.includes("decide only whether each indexed") === true;
      return { model: "offline", content: JSON.stringify(isExit ? (input.exitDecision ?? HOLD) : { decisions: [] }) };
    } }),
    executor: { execute: async (request) => { submitted.push(request.request); if (request.request.side === "sell") stockBalance = 0n;
      return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: H },
        fill: { side: "sell", exitWei: null, fillStatus: "unverified" }, meta: {} }; } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    rpcUrls: [], routeReader: reader, platformFeeBps: 0, tradfiNativeCostUsdtAtomic: async () => 1n,
    forbiddenAddresses: () => new Set(), executionIdentity: (_a, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: H }),
    recoverFill: async () => ({ side: "sell", exitWei: null, fillStatus: "unverified" }), now: () => NOW, log: (message) => { logs.push(message); } };
  return { agents, positions, intents, settingsStore, journal, deps, submitted, created, logs };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function expected(row: NonNullable<Awaited<ReturnType<MemoryTradePositionStore["get"]>>>): TradeEvidenceExpected {
  return { sessionGeneration: row.sessionGeneration ?? 0, lastQuoteWei: row.lastQuoteWei, lastQuoteBalance: row.lastQuoteBalance, lastQuoteRoute: row.lastQuoteRoute,
    lastQuoteAtMs: row.lastQuoteAtMs, crashPendingSinceMs: row.crashPendingSinceMs, crashPendingKind: row.crashPendingKind, crashRefQuoteWei: row.crashRefQuoteWei,
    crashRefBalance: row.crashRefBalance, crashRefAtMs: row.crashRefAtMs, crashRefRoute: row.crashRefRoute, autoExitReason: row.autoExitReason,
    autoExitAtMs: row.autoExitAtMs, autoExitNote: row.autoExitNote };
}

async function openPosition(h: Harness, positionId = "position", over: { readonly openedAt?: number } = {}) {
  return h.positions.open({ positionId, agentId: AGENT_ID, ownerAddress: OWNER, token: TOKEN, route: { hops: [], fees: [100] }, venue: "pancake_v3",
    entryWei: 5n * E, tokenAmount: 5n * E, fillStatus: "verified", openedAt: over.openedAt ?? NOW - 3_600_000, settlementAsset: "USDT",
    requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${H}|${WALLET.toLowerCase()}|0|${H}` });
}

async function setExpiry(h: Harness, expirySec: number) {
  const agent = await h.agents.getAgentById(AGENT_ID);
  assert.ok(agent?.sessionFacts);
  await h.agents.updateAgentSessionFacts(OWNER, AGENT_ID, { ...agent.sessionFacts, expiry: expirySec });
}

const sells = (h: Harness) => h.submitted.filter((request) => request.side === "sell");

// ---------------------------------------------------------------- R2

test("R2: at expiry - 30 min an open position with no SL/TP/LLM exit is NOT sold and gets no marker", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ stockBalance: 5n * E });
  await setExpiry(h, NOW_SEC + 30 * 60);
  await openPosition(h);
  await runTradeWorkerOnce(h.deps);
  assert.equal(sells(h).length, 0);
  const row = await h.positions.get(OWNER, AGENT_ID, "position");
  assert.equal(row?.status, "open");
  assert.equal(row?.autoExitReason, null);
});

test("R2: a stored session-expiring marker sells nothing and is cleared", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ stockBalance: 5n * E });
  await setExpiry(h, NOW_SEC + 30 * 60);
  const row = await openPosition(h);
  await h.positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: AGENT_ID, positionId: row.positionId, expected: expected(row),
    action: { kind: "marker", reason: "session-expiring", atMs: NOW - 1_000, note: "Session expires soon." }, writerGeneration: 0 });
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.autoExitReason, "session-expiring");
  await runTradeWorkerOnce(h.deps);
  assert.equal(sells(h).length, 0);
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.autoExitReason, null);
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.status, "open");
});

test("R2: the marker mask holds when a stale session-expiring marker is RETAINED despite the clearing pass", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ stockBalance: 5n * E });
  await setExpiry(h, NOW_SEC + 30 * 60);
  const row = await openPosition(h);
  await h.positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: AGENT_ID, positionId: row.positionId, expected: expected(row),
    action: { kind: "marker", reason: "session-expiring", atMs: NOW - 1_000, note: "stale" }, writerGeneration: 0 });
  const retaining = new Proxy(h.positions, { get(target, property) {
    if (property === "clearSessionExpiringMarkers") return async () => 0;
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as MemoryTradePositionStore;
  await runTradeWorkerOnce({ ...h.deps, positions: retaining });
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.autoExitReason, "session-expiring", "the clearing pass was disabled");
  assert.equal(sells(h).length, 0, "the mask, not the clearing pass, is what refuses the sale");
});

test("R2: runEntry still refuses new entries in the last 2 h of the session (session-expiring)", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness();
  await setExpiry(h, NOW_SEC + 90 * 60);
  const report = await runTradeWorkerOnce(h.deps);
  assert.equal(report.outcomes[0]?.reason, "session-expiring");
});

test("R2: crash-stop, owner-exit request and max-hold still sell (existing authority, kept as regressions)", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  // crash-stop marker (crash protection on)
  const crash = await harness({ settings: aiSettings({ crashProtection: true }), stockBalance: 5n * E });
  await setExpiry(crash, NOW_SEC + 30 * 60);
  const crashRow = await openPosition(crash);
  await crash.positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: AGENT_ID, positionId: crashRow.positionId, expected: expected(crashRow),
    action: { kind: "marker", reason: "crash-stop", atMs: NOW - 1_000, note: "quote collapsed" }, writerGeneration: 0 });
  await runTradeWorkerOnce(crash.deps);
  assert.equal(sells(crash).length, 1, "crash-stop still sells");
  // owner-exit request
  const owner = await harness({ stockBalance: 5n * E });
  await setExpiry(owner, NOW_SEC + 30 * 60);
  await openPosition(owner);
  await owner.positions.requestExit(OWNER, AGENT_ID, "position");
  await runTradeWorkerOnce(owner.deps);
  assert.equal(sells(owner).length, 1, "an owner-exit request still sells");
  // max-hold (original opening time)
  const hold = await harness({ settings: aiSettings({ maxHoldSec: 3_600 }), stockBalance: 5n * E });
  await setExpiry(hold, NOW_SEC + 30 * 60);
  await openPosition(hold, "position", { openedAt: NOW - 7_200_000 });
  await runTradeWorkerOnce(hold.deps);
  assert.equal(sells(hold).length, 1, "max-hold still sells");
});

// ------------------------------------------------- §4a: a failed re-read releases both rows

test("§4a fresh-read-error: a rejected agent re-read inside the REAL executor rolls the AI sell back — journal row and intent are both released, nothing is submitted", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ stockBalance: 5n * E });
  await openPosition(h);
  await h.positions.requestExit(OWNER, AGENT_ID, "position");
  const provider = new FakeWalletProvider();
  let reads = 0;
  const failing = new Proxy(h.agents, { get(target, property) {
    if (property === "getAgent") return async () => { reads += 1; throw new Error("temporary agent read failure"); };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as AgentStore;
  const deps: TradeWorkerDeps = { ...h.deps, executor: { execute: executeTradeForAgent },
    executorDeps: { chainId: 56, keyStore: KEYSTORE, agentStore: failing, journal: h.journal, killswitch: new MemoryKillSwitch(),
      providerRegistry: { get: () => provider }, trade: tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 } }),
      pancake: { router: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, pancakeV3: null, uniswapV3: null, flapPortal: null, nowMs: () => NOW } };
  await runTradeWorkerOnce(deps);
  assert.equal(reads >= 1, true, "the executor reached the fresh-status read (an earlier refusal would make this test vacuous)");
  assert.equal(provider.executeCalls.length, 0, "nothing is submitted");
  assert.deepEqual(await h.intents.listUnsettled(OWNER, AGENT_ID), [], "the worker rolled the intent back");
  assert.deepEqual((await h.journal.listNonTerminal()).filter((row) => row.agentId === AGENT_ID), [], "no journal row is left PENDING");
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.status, "open");
});

// ------------------------------------------------- reconcile disposal (§2.2)

function verdictFor(key: Hex, kind: "invalid" | "missing" = "invalid", blockTimeSec = NOW_SEC): FinalizedSessionRevocationVerdict {
  return { kind, observation: { blockNumber: "101", blockHash: `0x${"61".repeat(32)}` as Hex, blockTimeSec },
    evidence: { version: 1, chainId: 56, keyStoreAddress: KEYSTORE, walletAddress: WALLET, keyId: keccak256(key), sessionPublicKey: key,
      verdict: kind, blockNumber: "101", blockHash: `0x${"61".repeat(32)}` as Hex, observedAtMs: NOW } };
}

function inertDep(script: (call: number) => FinalizedSessionRevocationVerdict | Error) {
  const state = { reads: 0 };
  return { state, inertSubmission: { chainId: 56, keyStore: KEYSTORE, read: async () => {
    state.reads += 1;
    const next = script(state.reads);
    if (next instanceof Error) throw next;
    return next;
  } } };
}

/** The 2026-09-21 incident shape: a pending hashless sell whose journal row is UNKNOWN. */
async function seedAmbiguousSell(h: Harness, over: { readonly key?: Hex; readonly generation?: number; readonly scheduleSlot?: number; readonly portfolioSlot?: number; readonly withPosition?: boolean } = {}) {
  const idempotencyKey = `0x${"a1".repeat(32)}` as Hex;
  if (over.withPosition !== false) await openPosition(h);
  await h.intents.create({ decisionId: "ambiguous-sell", idempotencyKey, agentId: AGENT_ID, ownerAddress: OWNER, side: "sell", token: TOKEN,
    route: { hops: [], fees: [100] }, amountWei: 5n * E, entryWei: 5n * E, positionId: "position", closeReason: "llm", settlementAsset: "USDT",
    ...(over.scheduleSlot === undefined ? {} : { scheduleSlot: over.scheduleSlot }),
    ...(over.portfolioSlot === undefined ? {} : { portfolioSlot: over.portfolioSlot }) });
  await h.journal.begin({ idempotencyKey, agentId: AGENT_ID, ownerAddress: OWNER, kind: "trade", decisionId: "ambiguous-sell",
    externalRef: { paramsHash: H, publicKey: over.key ?? KEY, sessionGeneration: over.generation ?? 0 } });
  await h.journal.markUnknown(idempotencyKey, "provider error -32602: please assign a tracer, such as callTracer");
  return { idempotencyKey };
}

async function disposalRuns(h: Harness) {
  return (await h.positions.listRuns(OWNER, AGENT_ID, 50)).filter((run) => run.reason === "ambiguous-sell-disposed");
}

test("reconcile disposes an inert ambiguous sell ONCE, keeps the journal row UNKNOWN, and runs for an expired agent", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ expirySec: NOW_SEC - 3_000 });
  const { idempotencyKey } = await seedAmbiguousSell(h);
  const inert = inertDep(() => verdictFor(KEY));
  const deps = { ...h.deps, inertSubmission: inert.inertSubmission };
  await runTradeWorkerOnce(deps);
  const intent = await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell");
  assert.equal(intent?.state, "rolled-back");
  const evidence = parseInertEvidence(intent?.dispositionEvidence);
  assert.equal(evidence?.key, KEY);
  assert.equal(evidence?.journalKey, idempotencyKey);
  assert.equal(evidence?.expirySec, NOW_SEC - 3_000);
  const journal = await h.journal.get(idempotencyKey);
  assert.equal(journal?.state, "UNKNOWN", "the journal row is audit truth and is never modified");
  assert.match(journal?.lastError ?? "", /tracer/u);
  assert.equal((await disposalRuns(h)).length, 1);
  await runTradeWorkerOnce(deps);
  assert.equal(inert.state.reads, 1, "a disposed row is not read again");
  assert.equal((await disposalRuns(h)).length, 1, "the run row is written once");
});

test("reconcile never disposes for a non-AI agent (a legacy hashless sell with a dead key)", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ settings: legacySettings(), expirySec: NOW_SEC - 3_000 });
  await seedAmbiguousSell(h);
  const inert = inertDep(() => verdictFor(KEY));
  await runTradeWorkerOnce({ ...h.deps, inertSubmission: inert.inertSubmission });
  assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "pending");
  assert.equal(inert.state.reads, 0, "no chain read for a model outside the scope");
  assert.deepEqual(h.logs, [], "a refusal is silent, never an exception");
});

test("reconcile never disposes a schedule-slot or portfolio-slot intent", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  for (const slot of [{ scheduleSlot: 0 }, { portfolioSlot: 0 }] as const) {
    const h = await harness({ expirySec: NOW_SEC - 3_000 });
    await seedAmbiguousSell(h, slot);
    const inert = inertDep(() => verdictFor(KEY));
    await runTradeWorkerOnce({ ...h.deps, inertSubmission: inert.inertSubmission });
    assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "pending");
    assert.equal(inert.state.reads, 0);
    assert.deepEqual(h.logs, [], "a refusal is silent, never an exception");
  }
});

test("reconcile refuses a row whose key or generation is not the agent's current one", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const otherKey = await harness({ expirySec: NOW_SEC - 3_000, sessionKey: OTHER_KEY });
  await seedAmbiguousSell(otherKey);
  const inertA = inertDep(() => verdictFor(KEY));
  await runTradeWorkerOnce({ ...otherKey.deps, inertSubmission: inertA.inertSubmission });
  assert.equal((await otherKey.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "pending");
  assert.deepEqual(otherKey.logs, [], "a refusal is silent, never an exception");
  const renewed = await harness({ expirySec: NOW_SEC - 3_000, generation: 1 });
  await seedAmbiguousSell(renewed, { generation: 0 });
  const inertB = inertDep(() => verdictFor(KEY));
  await runTradeWorkerOnce({ ...renewed.deps, inertSubmission: inertB.inertSubmission });
  assert.equal((await renewed.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "pending");
  assert.deepEqual(renewed.logs, [], "a refusal is silent, never an exception");
});

test("reconcile: an unreadable finalized read, and a thrown read, leave the row pending and retry next cycle", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ expirySec: NOW_SEC - 3_000 });
  await seedAmbiguousSell(h);
  const script: (call: number) => FinalizedSessionRevocationVerdict | Error = (call) =>
    call === 1 ? { kind: "unreadable" } : call === 2 ? new Error("rpc down") : call === 3 ? { kind: "registered", observation: { blockNumber: "101", blockHash: H, blockTimeSec: NOW_SEC } } : verdictFor(KEY, "missing");
  const inert = inertDep(script);
  const deps = { ...h.deps, inertSubmission: inert.inertSubmission };
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await runTradeWorkerOnce(deps);
    assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "pending", `cycle ${cycle}`);
    assert.deepEqual(h.logs, [], `cycle ${cycle}: a refusal is silent, never an exception`);
  }
  await runTradeWorkerOnce(deps);
  assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "rolled-back");
  assert.equal(parseInertEvidence((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.dispositionEvidence)?.verdict, "missing");
});

test("reconcile: a finalized block BEFORE the key's expiry never disposes", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ expirySec: NOW_SEC + 3_600 });
  await seedAmbiguousSell(h);
  const inert = inertDep(() => verdictFor(KEY, "missing", NOW_SEC));
  await runTradeWorkerOnce({ ...h.deps, inertSubmission: inert.inertSubmission });
  assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "pending");
  assert.equal(inert.state.reads, 1);
  assert.deepEqual(h.logs, [], "a refusal is silent, never an exception");
});

test("crash-after-CAS-before-run: the intent stays disposed, quiescence passes, and no run row is invented (at-most-once)", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ expirySec: NOW_SEC - 3_000 });
  await seedAmbiguousSell(h);
  const inert = inertDep(() => verdictFor(KEY));
  const failing = new Proxy(h.positions, { get(target, property) {
    if (property === "insertRun") return async (input: { readonly reason: string }) => {
      if (input.reason === "ambiguous-sell-disposed") throw new Error("crash before the run row");
      return target.insertRun(input as never);
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as MemoryTradePositionStore;
  await runTradeWorkerOnce({ ...h.deps, positions: failing, inertSubmission: inert.inertSubmission });
  assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "rolled-back");
  const agent = await h.agents.getAgentById(AGENT_ID);
  assert.ok(agent);
  assert.deepEqual(await assessRenewalQuiescence(agent, { tradeIntents: h.intents, tradeSettings: h.settingsStore, journal: h.journal }), { quiescent: true });
  await runTradeWorkerOnce({ ...h.deps, inertSubmission: inert.inertSubmission });
  assert.equal((await disposalRuns(h)).length, 0, "the lost run row is not re-written");
});

// ---------------------------------------------------- sweep orphan-skip

test("the revoked-agent sweep does not orphan a TradFi AI position that still has an unsettled sell", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ status: "revoked", expirySec: NOW_SEC - 3_000 });
  await seedAmbiguousSell(h);
  await runTradeWorkerOnce(h.deps);
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.status, "open", "an unsettled sell keeps its position open for projection");
  // Once the sell is disposed as inert, the same sweep orphans the position as before.
  const inert = inertDep(() => verdictFor(KEY));
  await runTradeWorkerOnce({ ...h.deps, inertSubmission: inert.inertSubmission });
  assert.equal((await h.intents.get(OWNER, AGENT_ID, "ambiguous-sell"))?.state, "rolled-back");
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.status, "orphaned");
});

test("non-ai-unsettled-sell-orphaning-unchanged: another model's revoked sweep orphans regardless of an unsettled sell", async (context) => {
  context.mock.method(Date, "now", () => NOW);
  const h = await harness({ settings: legacySettings(), status: "revoked", expirySec: NOW_SEC - 3_000 });
  await seedAmbiguousSell(h);
  await runTradeWorkerOnce(h.deps);
  assert.equal((await h.positions.get(OWNER, AGENT_ID, "position"))?.status, "orphaned");
});

test("the trade-worker daemon wires the finalized KeyStore read into the disposal (read-only: no signer, no submission)", () => {
  const source = readFileSync(new URL("../scripts/trade-worker.ts", import.meta.url), "utf8");
  assert.match(source, /inertSubmission: \{\s*chainId: 56, keyStore,\s*read: \(input\) => readFinalizedSessionRevocation\(/u);
  assert.match(source, /createKeyStoreReader\(\{ network: readerNetwork, rpcUrls, keyStore \}\)/u);
});

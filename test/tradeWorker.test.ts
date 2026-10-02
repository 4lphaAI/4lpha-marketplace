import { featureFixture } from "./support/tradeFeatures.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, padHex, parseAbi,
  stringToBytes, toHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { validateSessionSpec } from "../src/core/session.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { canonicalPreparedIntentIdentityV1, encodeLpFinalCallsV1, fingerprintLpFinalCallsV1,
  PORTO_INTENT_SCHEME, PORTO_V055_DECODER, PORTO_V055_ORCHESTRATOR, PORTO_V055_VERSION } from "../src/lp/preparedIntent.js";
import { INTENT_EXECUTED_TOPIC, PORTO_V055_INTENT_PARAMETERS } from "../src/lp/intentDecoder.js";
import { verifyTradfiV2Receipt, type TradfiReceiptObservation } from "../src/trade/receipt.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { hashCalls } from "../src/http/wire.js";
import type { TradeUnknownReads } from "../src/trade/unknownResolve.js";
import type { TradeDataPlaneReads, TokenBatchRow, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { RwaFact } from "../src/trade/rwa.js";
import type { TradeLlm } from "../src/trade/llm.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { positionView } from "../src/trade/view.js";
import { TRADE_ENTRY_RELAY_HEADROOM_WEI } from "../src/trade/sizing.js";
import { evaluateTradeRules } from "../src/rules/engine.js";
import { DRAFT_KEY, cancelDraft, pendingDraft } from "./support/provisioningDraft.js";
import {
  createTradeGasBackoff,
  runTradeWorkerOnce,
  tradeGasBackoffIntervals,
  type TradeExecutor,
  type TradeWorkerDeps,
} from "../src/trade/worker.js";
import { lpGasBackoffIntervals } from "../src/lp/worker.js";
import { agentGasFloor } from "../src/ops/gasFloor.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const HASH = `0x${"11".repeat(32)}` as Hex;
const HASH2 = `0x${"22".repeat(32)}` as Hex;

function address(index: number): Address {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

function settings(overrides: Partial<TradeSettings> = {}): TradeSettings {
  return { ...DEFAULT_TRADE_SETTINGS, ...overrides };
}

function dataPlane(count = 6): TradeDataPlaneReads {
  const universe = Array.from({ length: count }, (_, index): UniverseRow => ({
    address: address(index + 100), symbol: `T${index}`, lane: "meme", source: "fixture",
  }));
  return {
    async universe(lane) { return lane === "meme" ? universe : []; },
    async tokensBatch(addresses) {
      return addresses.map((token, index) => ({
        address: token, symbol: `T${index}`, priceUsd: 1, marketCapUsd: 1_000,
        volume24hUsd: Number.parseInt(token.slice(-4), 16), holders: 10, priceChange24hPct: 1,
      }));
    },
    async eligibilityBatch(addresses) {
      return addresses.map((token) => ({
        address: token, eligible: true, reason: "ok", source: "allowlist" as const, venue: null,
      }));
    },
    async security() { return { riskLevel: "ok", flags: [] }; },
  };
}

function llm(counter?: { calls: number }): TradeLlm {
  return {
    async complete(messages) {
      if (counter !== undefined) counter.calls += 1;
      const exit = messages[0]?.content.startsWith("Decide only") === true;
      return {
        model: "fixture",
        content: exit
          ? JSON.stringify({ decisions: [{ index: 0, exit: true, reason: "exit" }] })
          : JSON.stringify({ decisions: [{ index: 0, enter: true, confidence: 100, reason: "enter" }] }),
      };
    },
  };
}

function quoteReader(quoteV2?: RouteQuoteReader["quoteV2"]): RouteQuoteReader {
  return {
    quoteV2: quoteV2 ?? (async (_path, amount) => amount * 2n),
    async quoteV3Single(_tokenIn, _tokenOut, _fee, amount) { return amount * 2n; },
    async quoteV3Path(_path, amount) { return amount * 2n; },
    async quoteUniV3Single(_tokenIn, _tokenOut, _fee, amount) { return amount * 2n; },
    async quoteUniV3Path(_path, amount) { return amount * 2n; },
  };
}

function routeReaderExcept(blocked: Address): RouteQuoteReader {
  const blockedKey = blocked.toLowerCase();
  const isBlocked = (token: string): boolean => token.toLowerCase() === blockedKey;
  const pathToken = (path: Hex): string => `0x${path.slice(-40)}`;
  return {
    async quoteV2(path, amount) {
      if (isBlocked(path.at(-1) ?? "")) throw new Error("no route");
      return amount * 2n;
    },
    async quoteV3Single(_tokenIn, tokenOut, _fee, amount) {
      if (isBlocked(tokenOut)) throw new Error("no route");
      return amount * 2n;
    },
    async quoteV3Path(path, amount) {
      if (isBlocked(pathToken(path))) throw new Error("no route");
      return amount * 2n;
    },
    async quoteUniV3Single(_tokenIn, tokenOut, _fee, amount) {
      if (isBlocked(tokenOut)) throw new Error("no route");
      return amount * 2n;
    },
    async quoteUniV3Path(path, amount) {
      if (isBlocked(pathToken(path))) throw new Error("no route");
      return amount * 2n;
    },
  };
}

function unavailableRouteReader(): RouteQuoteReader {
  return {
    async quoteV2() { throw new Error("no route"); },
    async quoteV3Single() { throw new Error("no route"); },
    async quoteV3Path() { throw new Error("no route"); },
    async quoteUniV3Single() { throw new Error("no route"); },
    async quoteUniV3Path() { throw new Error("no route"); },
  };
}

async function harness(input: {
  readonly ids?: readonly string[];
  readonly status?: "armed" | "paused";
  readonly settings?: TradeSettings;
  readonly reads?: TradeDataPlaneReads;
  readonly executor?: TradeExecutor;
  readonly now?: number;
  readonly bstocks?: ReadonlySet<string>;
  readonly llmCounter?: { calls: number };
  readonly llm?: TradeLlm;
  readonly providerCalls?: { calls: number };
  readonly routeReader?: RouteQuoteReader;
  readonly omitFirstCap?: boolean;
  readonly tokenBalance?: () => Promise<bigint>;
  readonly entryBasisWei?: TradeWorkerDeps["entryBasisWei"];
  readonly reconcile?: TradeWorkerDeps["reconcile"];
} = {}) {
  const agents = new MemoryAgentStore();
  const positions = new MemoryTradePositionStore(() => input.now ?? Date.UTC(2026, 8, 7, 14));
  const settingsStore = new MemoryTradeSettingsStore(agents, () => input.now ?? Date.UTC(2026, 8, 7, 14));
  const intents = new MemoryTradeIntentStore(() => input.now ?? Date.UTC(2026, 8, 7, 14));
  const journal = new MemoryExecutionJournal(() => input.now ?? Date.UTC(2026, 8, 7, 14));
  const reads = input.reads ?? dataPlane();
  const rows = await reads.universe("meme") ?? [];
  const granted = rows.map((row) => row.address);
  const completeSpec = {
    allowedCalls: granted.map((to) => ({ to, selector: "approve(address,uint256)" })),
    spendCaps: granted.map((token) => ({ token, limit: 10n ** 30n, period: "day" as const })),
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  };
  const spec = input.omitFirstCap === true
    ? { ...completeSpec, spendCaps: [] }
    : completeSpec;
  const created: AgentRecord[] = [];
  for (const [index, id] of (input.ids ?? ["agent-a"]).entries()) {
    const agent = await agents.createAgent({
      id, ownerAddress: OWNER, walletAddress: index === 0 ? WALLET : address(2_000 + index), custodyModel: "passkey",
      status: input.status ?? "armed",
      sessionFacts: {
        spec,
        permissions: validateSessionSpec(completeSpec, { minSessionSeconds: 0 }),
        publicKey: `0x02${"33".repeat(32)}` as Hex,
        expiry: spec.expiresAt,
      },
    });
    created.push(agent);
    const value = input.settings ?? settings();
    await settingsStore.put({ agentId: id, ownerAddress: OWNER, params: value, digest: tradeSettingsDigest(value) });
  }
  const calls: Array<{ readonly agentId: string; readonly side: "buy" | "sell"; readonly token: Address }> = [];
  const balances = new Map<string, bigint>();
  const executor = input.executor ?? {
    async execute(request) {
      calls.push({ agentId: request.agent.id, side: request.request.side, token: request.request.token });
      if (request.request.side === "sell") balances.set(request.request.token.toLowerCase(), 0n);
      return {
        kind: "committed" as const,
        receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
        fill: request.request.side === "buy"
          ? { side: "buy" as const, entryWei: request.request.amountWei, tokenAmount: request.request.quotedOutWei, fillStatus: "verified" as const }
          : { side: "sell" as const, exitWei: request.request.quotedOutWei, fillStatus: "verified" as const },
        meta: {},
      };
    },
  };
  const providerCalls = input.providerCalls ?? { calls: 0 };
  const deps: TradeWorkerDeps = {
    platformFeeBps: 0,
    agentStore: agents, settingsStore, positions, intents, journal, dataPlane: reads,
    provider: {
      async getTokenBalance({ token }) {
        providerCalls.calls += 1;
        return input.tokenBalance?.() ?? balances.get(token.toLowerCase()) ?? 100n;
      },
    },
    llmFor: () => input.llm ?? llm(input.llmCounter), executor, executorDeps: {}, rpcUrls: [],
    readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: input.bstocks ?? new Set<string>() },
    routeReader: input.routeReader ?? quoteReader(),
    forbiddenAddresses: () => new Set<string>(),
    executionIdentity: () => ({ idempotencyKey: HASH, paramsHash: HASH }),
    ...(input.entryBasisWei === undefined ? {} : { entryBasisWei: input.entryBasisWei }),
    ...(input.reconcile === undefined ? {} : { reconcile: input.reconcile }),
    async recoverFill(intent) {
      return intent.side === "buy"
        ? { side: "buy", entryWei: intent.entryWei ?? intent.amountWei, tokenAmount: 100n, fillStatus: "verified" }
        : { side: "sell", exitWei: intent.amountWei, fillStatus: "verified" };
    },
    now: () => input.now ?? Date.UTC(2026, 8, 7, 14),
  };
  return { agents, positions, settingsStore, intents, journal, created, deps, calls, providerCalls };
}

async function openPosition(
  h: Awaited<ReturnType<typeof harness>>,
  token: Address,
  positionId: string,
  openedAt = Date.UTC(2026, 8, 7, 12),
) {
  await h.positions.open({
    positionId, agentId: h.created[0]?.id ?? "agent-a", ownerAddress: OWNER,
    token, route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 100n, fillStatus: "verified", openedAt,
  });
}

describe("trade worker cycle", () => {
  it("quotes and persists the fee-sized amount that clears the real per-trade rule", async () => {
    const quotes: bigint[] = [];
    const expectedAmount = 1_782_178_217_821_782n;
    let executed = false;
    const h = await harness({ routeReader: quoteReader(async (_path, amount) => {
      quotes.push(amount); return amount * 2n;
    }), entryBasisWei: (_agent, request) => request.amountWei + request.amountWei / 100n,
    executor: { async execute({ agent, request }) {
      executed = true;
      assert.equal(request.amountWei, expectedAmount);
      assert.equal(request.quotedOutWei, expectedAmount * 2n);
      const total = request.amountWei + request.amountWei / 100n;
      assert.equal(evaluateTradeRules({ amountWei: request.amountWei, nativeInWei: total,
        minOutWei: request.minOutWei, quotedOutWei: request.quotedOutWei,
        caps: agent.caps, spentTodayWei: 0n, maxSlippageBps: 300 }).allowed, true);
      return { kind: "unknown", meta: {} };
    } } });
    await h.agents.updateAgentCaps(OWNER, "agent-a", { perTradeNativeWei: 2_000_000_000_000_000n });
    await runTradeWorkerOnce({ ...h.deps, platformFeeBps: 100 });
    assert(executed);
    assert(quotes.includes(expectedAmount));
    assert(!quotes.includes(2_000_000_000_000_000n));
    const [intent] = await h.intents.listUnsettled(OWNER, "agent-a");
    assert.equal(intent?.amountWei, expectedAmount);
    assert.equal(intent?.entryWei, 1_799_999_999_999_999n);
    assert.equal((await h.agents.getAgent(OWNER, "agent-a"))?.caps?.perTradeNativeWei, 2_000_000_000_000_000n);
  });

  it("refuses a cap with no relay headroom before model, quotes or execution", async () => {
    const counter = { calls: 0 };
    const h = await harness({ llmCounter: counter });
    await h.agents.updateAgentCaps(OWNER, "agent-a", { perTradeNativeWei: TRADE_ENTRY_RELAY_HEADROOM_WEI });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "entry-budget-too-small");
    assert.equal(counter.calls, 0);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
  });

  it("R5 skips a canceled draft even with stale settings and a sellable position", async () => {
    const h = await harness();
    const original = h.created[0]!;
    const now = Math.floor(h.deps.now!() / 1_000);
    const agents = new MemoryAgentStore(null, () => now * 1_000);
    await agents.createProvisioningAgent({ record: { id: original.id, ownerAddress: OWNER, walletAddress: WALLET,
      custodyModel: "passkey" }, pendingGrant: pendingDraft(OWNER, WALLET, now), sessionKey: DRAFT_KEY });
    await cancelDraft(agents, OWNER, original.id, now);
    await openPosition(h, address(900), "stale-position");
    const report = await runTradeWorkerOnce({ ...h.deps, agentStore: agents });
    assert.deepEqual(report.outcomes, []);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.positions.listOpen(OWNER, original.id)).length, 1);
    assert.equal(await h.journal.sumNativeSpendSince(original.id, 0), 0n);
    assert.equal((await agents.getAgent(OWNER, original.id))?.sessionFacts, null);
    assert.equal(await agents.hasAgentSessionKey(OWNER, original.id), true);
  });
  it("runs exits before entries and opens at most one entry", async () => {
    const h = await harness();
    await openPosition(h, address(900), "old");
    const report = await runTradeWorkerOnce(h.deps);
    assert.deepEqual(h.calls.map((call) => call.side), ["sell", "buy"]);
    assert.equal(h.calls.filter((call) => call.side === "buy").length, 1);
    assert.equal(report.outcomes[0]?.exits, 1);
    assert.equal((await h.positions.listOpen(OWNER, "agent-a")).length, 1);
  });

  it("sells an owner-requested position before every automatic exit", async () => {
    const h = await harness({ settings: settings({ maxOpenPositions: 2 }) });
    const automatic = address(901);
    const requested = address(902);
    await openPosition(h, automatic, "automatic", 1);
    await openPosition(h, requested, "requested", 2);
    await h.positions.requestExit(OWNER, "agent-a", "requested");
    await runTradeWorkerOnce(h.deps);
    assert.deepEqual(h.calls.filter((call) => call.side === "sell").map((call) => call.token), [requested, automatic]);
  });

  // MEASURED 2026-09-03 at 13:10 UTC with the US market shut: 11 of 25 bStocks
  // quoted inside the impact limit. The pool never closes, so a shut underlying
  // exchange refuses nothing — it is a fact the model reads, and the 300 bps
  // impact gate is the bound that actually separates tradable from not.
  it("exits a US-equity position after hours, take-profit included", async () => {
    const profit = address(903);
    const loss = address(904);
    const requested = address(905);
    const h = await harness({
      now: Date.UTC(2026, 8, 7, 21),
      settings: settings({ maxOpenPositions: 1 }),
      bstocks: new Set([profit, loss, requested].map((token) => token.toLowerCase())),
      routeReader: quoteReader(async (path, amount) => path[0] === loss ? amount / 2n : amount * 2n),
    });
    await openPosition(h, profit, "profit");
    await openPosition(h, loss, "loss");
    await openPosition(h, requested, "requested");
    await h.positions.requestExit(OWNER, "agent-a", "requested");
    await runTradeWorkerOnce(h.deps);
    assert.deepEqual(
      new Set(h.calls.filter((call) => call.side === "sell").map((call) => call.token)),
      new Set([profit, loss, requested]),
    );
  });

  it("marks the third unquotable cycle as held no-price in the run record", async () => {
    const unavailable: RouteQuoteReader = {
      async quoteV2() { throw new Error("no route"); },
      async quoteV3Single() { throw new Error("no route"); },
      async quoteV3Path() { throw new Error("no route"); },
      async quoteUniV3Single() { throw new Error("no route"); },
      async quoteUniV3Path() { throw new Error("no route"); },
    };
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }), routeReader: unavailable });
    await openPosition(h, address(906), "unquotable");
    await runTradeWorkerOnce(h.deps);
    await runTradeWorkerOnce(h.deps);
    await runTradeWorkerOnce(h.deps);
    assert.equal((await h.positions.get(OWNER, "agent-a", "unquotable"))?.noPriceCount, 3);
    assert.equal((await h.positions.listRuns(OWNER, "agent-a", 10)).some((run) => /held=no-price/u.test(run.reason)), true);
  });

  it("skips paused agents without an executor call or run row", async () => {
    const h = await harness({ status: "paused" });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.positions.listRuns(OWNER, "agent-a")).length, 0);
  });

  it("isolates one agent executor failure and continues the sweep", async () => {
    const calls: string[] = [];
    const h = await harness({
      ids: ["agent-a", "agent-b"],
      executor: {
        async execute(input) {
          calls.push(input.agent.id);
          if (input.agent.id === "agent-a") throw new Error("secret upstream detail");
          return { kind: "committed", receipt: { status: "CONFIRMED" },
            fill: { side: "buy", entryWei: input.request.amountWei, tokenAmount: input.request.quotedOutWei, fillStatus: "verified" }, meta: {} };
        },
      },
    });
    const report = await runTradeWorkerOnce(h.deps);
    assert.deepEqual(calls, ["agent-a", "agent-b"]);
    assert.match(report.outcomes[0]?.reason ?? "", /^agent-error:/u);
    assert.equal(report.outcomes[1]?.reason, "entered");
  });

  it("dry-run calls the model and data plane, writes one run, and touches no money seam", async () => {
    const llmCounter = { calls: 0 };
    const providerCalls = { calls: 0 };
    let executions = 0;
    const h = await harness({ llmCounter, providerCalls, executor: {
      async execute() { executions += 1; throw new Error("unexpected"); },
    } });
    const report = await runTradeWorkerOnce(h.deps, { dryRun: true });
    assert.equal(report.outcomes[0]?.reason, "dry-run");
    assert.ok(llmCounter.calls > 0);
    assert.equal(providerCalls.calls, 0);
    assert.equal(executions, 0);
    assert.equal((await h.positions.listOpen(OWNER, "agent-a")).length, 0);
    assert.equal((await h.positions.listRuns(OWNER, "agent-a")).length, 1);
  });

  it("logs once and skips the whole cycle while readiness is false", async () => {
    const h = await harness();
    const logs: string[] = [];
    const report = await runTradeWorkerOnce({ ...h.deps, readiness: { ...h.deps.readiness, ready: false }, log: (line) => logs.push(line) });
    assert.equal(report.skippedNotReady, true);
    assert.equal(logs.length, 1);
    assert.equal(h.calls.length, 0);
  });

  it("uses only the pinned set after preserving an already-completed exit", async () => {
    const h = await harness({ reads: dataPlane(700) });
    await openPosition(h, address(999), "exit-first");
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "entered");
    assert.deepEqual(h.calls.map((call) => call.side), ["sell", "buy"]);
    assert.equal((await h.positions.get(OWNER, "agent-a", "exit-first"))?.status, "closed");
  });

  it("refuses a pinned candidate when grantsTokenSell lacks the cap half", async () => {
    const h = await harness({ omitFirstCap: true });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(h.calls.length, 0);
    assert.ok((report.outcomes[0]?.refusals ?? 0) >= 1);
    const [run] = await h.positions.listRuns(OWNER, "agent-a");
    assert.ok((run?.refusals ?? 0) >= 1);
  });

  it("filters an excluded legacy-grant target before the entry LLM", async () => {
    const usdt = getAddress("0x55d398326f99059fF775485246999027B3197955");
    const base = dataPlane(5);
    const validRows = await base.universe("meme") ?? [];
    const rows: UniverseRow[] = [{ address: usdt, symbol: "USDT", lane: "meme", source: "fixture" }, ...validRows];
    const byAddress = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
    const reads: TradeDataPlaneReads = {
      ...base,
      async universe(lane) { return lane === "meme" ? rows : []; },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => {
        const symbol = byAddress.get(address.toLowerCase())?.symbol;
        return { address, ...(symbol === undefined ? {} : { symbol }),
          priceUsd: 1, marketCapUsd: 1_000, volume24hUsd: 1, holders: 1, priceChange24hPct: 1 };
      }); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({
        address, eligible: true, reason: "allowlist", source: "allowlist" as const, venue: null,
      })); },
    };
    const counter = { calls: 0 };
    const h = await harness({ reads, llmCounter: counter });
    await runTradeWorkerOnce(h.deps);
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(counter.calls, 1);
    assert.equal(h.calls[0]?.token, validRows[0]?.address);
    assert.equal(run?.events?.some((event) => event.code === "non-entry-asset" && event.token === usdt), true);
  });

  // 2026-09-15: a Sigma agent showed "13 skipped/refused" every cycle while
  // twelve more of its pinned tokens were dropped in silence by `noReentry`.
  it("records what the owner's own rules set aside, once per cycle, with the pinned denominator", async () => {
    // Exits run first: the open position must survive them — a flat 1x quote
    // trips neither threshold, and the hold window is a day.
    const h = await harness({
      settings: settings({ noReentry: true, maxOpenPositions: 3, maxHoldSec: 86_400 }),
      routeReader: quoteReader(async (_path, amount) => amount),
    });
    const [traded, open] = [address(100), address(101)];
    await openPosition(h, traded, "done");
    await h.positions.closePosition({ ownerAddress: OWNER, agentId: "agent-a", positionId: "done", exitWei: 120n, reason: "take-profit" });
    await openPosition(h, open, "still-open", Date.UTC(2026, 8, 7, 14));
    await runTradeWorkerOnce(h.deps);
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    const setAside = (run?.events ?? []).filter((event) => event.stage === "screen" && event.code === "owner-rules");
    assert.equal(setAside.length, 1, "one summary line, not one row per token");
    // The open one is reported as open even though it was also "entered before".
    assert.match(setAside[0]?.reason ?? "", /^2 of 6 pinned tokens set aside before screening — 1 traded before and No re-entry is on: 0x0000…0064; 1 already open\.$/u);
    // The owner's rule is not a screening refusal: the count the summary line shows stays the plane's.
    assert.equal(run?.refusals, 0);
    assert.equal((run?.events ?? []).some((event) => event.code === "shortlisted" && /of 4 screened candidates/u.test(event.reason ?? "")), true);
    // The traded token was never offered to the data plane or the model again.
    assert.equal(h.calls.some((call) => call.side === "buy" && call.token === traded), false);
  });

  it("stays silent when nothing was set aside", async () => {
    const h = await harness();
    await runTradeWorkerOnce(h.deps);
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal((run?.events ?? []).some((event) => event.code === "owner-rules"), false);
  });

  it("filters an unrouteable candidate before the entry LLM", async () => {
    const blocked = address(105);
    let prompt = "";
    const h = await harness({
      routeReader: routeReaderExcept(blocked),
      llm: {
        async complete(messages) {
          prompt = messages.map((message) => message.content).join("\n");
          return { model: "fixture", content: JSON.stringify({ decisions: [{ index: 0, enter: true, confidence: 100, reason: "enter" }] }) };
        },
      },
    });
    await runTradeWorkerOnce(h.deps);
    assert.doesNotMatch(prompt, new RegExp(blocked, "u"));
    assert.match(prompt, new RegExp(address(104), "u"));
    assert.equal(h.calls[0]?.token, address(104));
  });

  it("skips the LLM when every screened candidate has no route", async () => {
    const counter = { calls: 0 };
    const h = await harness({ llmCounter: counter, routeReader: unavailableRouteReader() });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "no-route");
    assert.equal(report.outcomes[0]?.candidates, 0);
    assert.equal(report.outcomes[0]?.refusals, 6);
    assert.equal(counter.calls, 0);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
  });

  it("refuses bonding-curve candidates before route probing or the LLM", async () => {
    const base = dataPlane(1);
    const reads: TradeDataPlaneReads = {
      ...base,
      async eligibilityBatch(addresses) {
        return addresses.map((address) => ({ address, eligible: true, reason: "flap_portal", source: "flap" as const, venue: "flap-bonding" as const }));
      },
    };
    const counter = { calls: 0 };
    const h = await harness({ reads, llmCounter: counter, routeReader: quoteReader() });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "no-route");
    assert.equal(counter.calls, 0);
    assert.equal(h.calls.length, 0);
  });

  it("rechecks a route after the LLM and refuses if it disappeared", async () => {
    let quoteCalls = 0;
    const expiring: RouteQuoteReader = {
      async quoteV2(_path, amount) {
        quoteCalls += 1;
        if (quoteCalls > 48) throw new Error("route disappeared");
        return amount * 2n;
      },
      async quoteV3Single(_tokenIn, _tokenOut, _fee, amount) {
        quoteCalls += 1;
        if (quoteCalls > 48) throw new Error("route disappeared");
        return amount * 2n;
      },
      async quoteV3Path(_path, amount) {
        quoteCalls += 1;
        if (quoteCalls > 48) throw new Error("route disappeared");
        return amount * 2n;
      },
      async quoteUniV3Single(_tokenIn, _tokenOut, _fee, amount) {
        quoteCalls += 1;
        if (quoteCalls > 48) throw new Error("route disappeared");
        return amount * 2n;
      },
      async quoteUniV3Path(_path, amount) {
        quoteCalls += 1;
        if (quoteCalls > 48) throw new Error("route disappeared");
        return amount * 2n;
      },
    };
    const counter = { calls: 0 };
    const h = await harness({ llmCounter: counter, routeReader: expiring });
    const report = await runTradeWorkerOnce(h.deps);
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(report.outcomes[0]?.reason, "no-route");
    assert.equal(report.outcomes[0]?.candidates, 6);
    assert.equal(report.outcomes[0]?.entries, 0);
    assert.equal(report.outcomes[0]?.refusals, 1);
    assert.equal(counter.calls, 1);
    assert.equal(h.calls.length, 0);
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
    assert.equal(run?.events?.some((event) => event.stage === "route" && event.code === "NO_ROUTE"), true);
  });

  it("propagates an aborted route prefilter without counting a candidate refusal", async () => {
    const counter = { calls: 0 };
    const h = await harness({ llmCounter: counter });
    const controller = new AbortController();
    controller.abort();
    await runTradeWorkerOnce(h.deps, { signal: controller.signal });
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(counter.calls, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(run?.refusals, 0);
    assert.match(run?.reason ?? "", /^agent-error:.*abort/u);
  });

  it("propagates an abort that arrives with a late primary LLM response", async () => {
    const controller = new AbortController();
    const h = await harness({
      llm: {
        async complete() {
          controller.abort();
          return { model: "fixture", content: JSON.stringify({ decisions: [] }) };
        },
      },
    });
    await runTradeWorkerOnce(h.deps, { signal: controller.signal });
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(h.calls.length, 0);
    assert.equal(run?.refusals, 0);
    assert.match(run?.reason ?? "", /^agent-error:.*abort/u);
  });

  it("uses at most 24 data-plane reads for a Sigma cycle", async () => {
    let reads = 0;
    const base = dataPlane(25);
    const counted: TradeDataPlaneReads = {
      async universe(lane, signal) { reads += 1; return base.universe(lane, signal); },
      async tokensBatch(addresses, signal) { reads += 1; return base.tokensBatch(addresses, signal); },
      async eligibilityBatch(addresses, signal) { reads += 1; return base.eligibilityBatch(addresses, signal); },
      async security(address, signal) { reads += 1; return base.security(address, signal); },
    };
    const h = await harness({ reads: counted });
    const before = reads;
    await runTradeWorkerOnce(h.deps);
    assert.ok(reads - before <= 24, `worker used ${reads - before} data-plane reads`);
  });

  it("persists a committed buy before any later balance read", async () => {
    let committed = false;
    const h = await harness({
      tokenBalance: async () => { if (committed) throw new Error("post-commit RPC failed"); return 100n; },
      executor: { async execute(input) {
        committed = true;
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "buy", entryWei: input.request.amountWei, tokenAmount: input.request.quotedOutWei, fillStatus: "verified" }, meta: {} };
      } },
    });
    await runTradeWorkerOnce(h.deps);
    assert.equal((await h.positions.listOpen(OWNER, "agent-a")).length, 1);
  });

  it("uses the durable fee-inclusive intent basis for immediate projection", async () => {
    const h = await harness({ entryBasisWei: (_agent, request) => request.amountWei + 7n });
    await runTradeWorkerOnce(h.deps);
    const [opened] = await h.positions.listOpen(OWNER, "agent-a");
    assert.equal(opened?.entryWei, BigInt(DEFAULT_TRADE_SETTINGS.entryWei) - TRADE_ENTRY_RELAY_HEADROOM_WEI + 7n);
  });

  it("runs generic journal reconcile before readiness, but never in dry-run", async () => {
    let calls = 0;
    const h = await harness({ reconcile: async () => { calls += 1; } });
    await runTradeWorkerOnce({ ...h.deps, readiness: { ...h.deps.readiness, ready: false } });
    assert.equal(calls, 1);
    await runTradeWorkerOnce(h.deps, { dryRun: true });
    assert.equal(calls, 1);
  });

  it("projects a lost-response buy after generic reconcile commits its journal row", async () => {
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }) });
    const token = address(100);
    await h.intents.create({
      decisionId: "lost-response", idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      side: "buy", token, route: { hops: [], fees: [3000] }, venue: "uniswap_v3", amountWei: 100n, entryWei: 107n,
      positionId: "lost-response", closeReason: null,
    });
    await h.journal.begin({ idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "lost-response" });
    const deps: TradeWorkerDeps = { ...h.deps, reconcile: async () => {
      await h.journal.markCommitted(HASH2, { txHash: HASH2 });
    } };
    await runTradeWorkerOnce(deps);
    const projected = await h.positions.get(OWNER, "agent-a", "lost-response");
    assert.equal(projected?.entryWei, 107n);
    assert.equal(projected?.entryTxHash, HASH2);
    assert.equal(projected?.venue, "uniswap_v3");
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
  });

  it("terminalizes a lost-response intent after generic reconcile rolls it back", async () => {
    const h = await harness();
    await h.settingsStore.requestDrain(OWNER, "agent-a");
    const token = address(100);
    await h.intents.create({
      decisionId: "rolled-back-response", idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      side: "buy", token, route: { hops: [], fees: [] }, amountWei: 100n, entryWei: 107n,
      positionId: "rolled-back-response", closeReason: null,
    });
    await h.journal.begin({ idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "rolled-back-response" });
    const deps: TradeWorkerDeps = { ...h.deps, reconcile: async () => {
      await h.journal.markRolledBack(HASH2, "relay proved absence");
    } };
    await runTradeWorkerOnce(deps);
    assert.equal(await h.positions.get(OWNER, "agent-a", "rolled-back-response"), null);
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
  });

  it("projects a later-confirmed intent while paused and the data plane is not ready", async () => {
    const h = await harness({ status: "paused" });
    const token = address(100);
    await h.intents.create({
      decisionId: "paused-response", idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      side: "buy", token, route: { hops: [], fees: [] }, amountWei: 100n, entryWei: 107n,
      positionId: "paused-response", closeReason: null,
    });
    await h.journal.begin({ idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "paused-response" });
    const report = await runTradeWorkerOnce({ ...h.deps,
      readiness: { ...h.deps.readiness, ready: false },
      reconcile: async () => { await h.journal.markCommitted(HASH2, { txHash: HASH2 }); },
    });
    assert.equal(report.skippedNotReady, true);
    assert.equal((await h.positions.get(OWNER, "agent-a", "paused-response"))?.entryWei, 107n);
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
  });

  it("keeps a confirmed sell unsettled when the post-balance cannot prove zero", async () => {
    let committed = false;
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }),
      tokenBalance: async () => { if (committed) throw new Error("post-commit RPC failed"); return 100n; },
      executor: { async execute(input) {
        committed = true;
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "sell", exitWei: input.request.quotedOutWei, fillStatus: "verified" }, meta: {} };
      } },
    });
    await openPosition(h, address(920), "sell-me");
    await runTradeWorkerOnce(h.deps);
    assert.equal((await h.positions.get(OWNER, "agent-a", "sell-me"))?.status, "open");
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 1);
  });

  it("closes a confirmed zero-balance sell with null, not invented zero, proceeds", async () => {
    let balanceReads = 0;
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }),
      tokenBalance: async () => { balanceReads += 1; return balanceReads === 1 ? 100n : 0n; },
      executor: { async execute() {
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "sell", exitWei: null, fillStatus: "unverified" }, meta: {} };
      } },
    });
    await openPosition(h, address(923), "sell-no-proceeds");
    await h.positions.requestExit(OWNER, "agent-a", "sell-no-proceeds");
    await runTradeWorkerOnce(h.deps);
    const closed = await h.positions.get(OWNER, "agent-a", "sell-no-proceeds");
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.exitWei, null);
    assert.equal(closed?.exitFillStatus, "unverified");
  });

  it("keeps a zero-delta buy as unverified and resolves it on the next cycle", async () => {
    let balance = 0n;
    const h = await harness({ settings: settings({ maxOpenPositions: 1, takeProfitBps: null, stopLossBps: null, maxHoldSec: null }),
      tokenBalance: async () => balance,
      executor: { async execute(input) {
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "buy", entryWei: input.request.amountWei, tokenAmount: null, fillStatus: "unverified" }, meta: {} };
      } },
    });
    await runTradeWorkerOnce(h.deps);
    const [opened] = await h.positions.listOpen(OWNER, "agent-a");
    assert.equal(opened?.fillStatus, "unverified");
    assert.notEqual(opened?.entryWei, 0n);
    balance = 321n;
    await runTradeWorkerOnce(h.deps);
    const recovered = await h.positions.get(OWNER, "agent-a", opened?.positionId ?? "");
    assert.equal(recovered?.fillStatus, "verified");
    assert.equal(recovered?.verifiedEntryAtomic ?? null, null);
    assert.equal(recovered?.receiptOwnershipKey ?? null, null);
  });

  it("closes a verified zero-balance row as balance-gone and surfaces the reason", async () => {
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }), tokenBalance: async () => 0n });
    await openPosition(h, address(921), "gone");
    await runTradeWorkerOnce(h.deps);
    const row = await h.positions.get(OWNER, "agent-a", "gone");
    assert.equal(row?.status, "closed");
    assert.equal(row?.exitWei, 0n);
    assert.equal(row?.closeReason, "balance-gone");
  });

  it("persists a sell refusal timestamp and retries only on the next cycle", async () => {
    let attempts = 0;
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }), executor: { async execute() {
      attempts += 1;
      return { kind: "rolled-back", code: "NOT_ALLOWED", meta: {} };
    } } });
    await openPosition(h, address(922), "refused");
    await runTradeWorkerOnce(h.deps);
    const refused = await h.positions.get(OWNER, "agent-a", "refused");
    assert.equal(attempts, 1);
    assert.equal(refused?.lastSellRefusalAt, Date.UTC(2026, 8, 7, 14));
    assert.equal(positionView(refused!, null)["lastSellRefusalAt"], Date.UTC(2026, 8, 7, 14));
    await runTradeWorkerOnce(h.deps);
    assert.equal(attempts, 2);
  });
});

describe("staged trade UNKNOWN worker pre-pass", () => {
  const KEY = `0x${"66".repeat(32)}` as Hex;
  const BLOCK_HASH = `0x${"77".repeat(32)}` as Hex;
  const EXECUTE = parseAbi(["function execute(bytes encodedIntent) payable returns (bytes4 err)"]);
  const calls = [{ to: address(100), data: "0x1234" as Hex }];
  const fp = fingerprintLpFinalCallsV1(calls);

  async function setup(mode: "landed" | "superseded" | "hold" | "absent" | "lost-cas") {
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }) });
    await h.intents.create({ decisionId: "unknown", idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      side: "buy", token: address(100), route: { hops: [], fees: [] }, amountWei: 100n, entryWei: 107n,
      positionId: "unknown", closeReason: null });
    await h.journal.begin({ idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "unknown", finalCallsFingerprint: fp.canonical, finalCallsFingerprintHash: fp.hash });
    const identity = canonicalPreparedIntentIdentityV1({ scheme: PORTO_INTENT_SCHEME,
      decoder: PORTO_V055_DECODER, chainId: "56", eoa: WALLET.toLowerCase() as Address,
      orchestrator: PORTO_V055_ORCHESTRATOR, orchestratorVersion: PORTO_V055_VERSION,
      nonce: "9", expiry: "0", executionDataHash: fp.value.executionDataHash, keyHash: KEY });
    await h.journal.bindPreparedIntent(HASH2, { canonicalIdentity: identity.canonical, identityHash: identity.hash,
      expectedBindingVersion: 0 });
    await h.journal.markUnknown(HASH2, "ambiguous");
    const encoded = encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{ eoa: WALLET,
      executionData: mode === "superseded" ? "0x1234" : encodeLpFinalCallsV1(calls), nonce: 9n,
      payer: WALLET, paymentToken: address(100), paymentMaxAmount: 1n, combinedGas: 1n,
      encodedPreCalls: [], encodedFundTransfers: [], settler: OWNER, expiry: 0n,
      isMultichain: false, funder: address(0), funderSignature: "0x", settlerContext: "0x",
      paymentAmount: 0n, paymentRecipient: OWNER,
      signature: concatHex([`0x${"11".repeat(65)}` as Hex, KEY, "0x00"]),
      paymentSignature: "0x", supportedAccountImplementation: OWNER }]);
    const obs = { chainId: 56 as const,
      transaction: { hash: HASH2, to: PORTO_V055_ORCHESTRATOR,
        input: encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [encoded] }),
        blockNumber: 1_001n, blockHash: BLOCK_HASH, transactionIndex: 0n },
      receipt: { status: 1n, transactionHash: HASH2, blockNumber: 1_001n, blockHash: BLOCK_HASH,
        transactionIndex: 0n, logs: [{ address: PORTO_V055_ORCHESTRATOR,
          topics: [INTENT_EXECUTED_TOPIC, padHex(WALLET, { size: 32 }), toHex(9n, { size: 32 })],
          data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, "0x00000000"]), logIndex: 0n }] },
      receiptBlock: { number: 1_001n, hash: BLOCK_HASH }, finalizedBlock: { number: 1_100n, hash: BLOCK_HASH } };
    const unknownReads: TradeUnknownReads = {
      async finalizedBlock() { return { number: 1_100n, hash: BLOCK_HASH }; },
      async accountNonce() { return 10n; },
      async blockAtOrBefore() { return 1_000n; },
      async intentExecutedTxHashes() { return mode === "hold" ? [] : [HASH2]; },
      async readFinalized() { return obs; },
    };
    const now = (h.deps.now?.() ?? 0) + 300_000;
    return { h, deps: { ...h.deps, unknownReads: mode === "absent" ? undefined : unknownReads,
      now: () => now, readiness: { ...h.deps.readiness, ready: false } } as TradeWorkerDeps };
  }

  it("R12 landed advances with its hash and projects in the same cycle", async () => {
    const { h, deps } = await setup("landed");
    await runTradeWorkerOnce(deps);
    assert.equal((await h.journal.get(HASH2))?.state, "COMMITTED");
    assert.equal((await h.journal.get(HASH2))?.externalRef.txHash, HASH2);
    assert.equal((await h.positions.get(OWNER, "agent-a", "unknown"))?.entryTxHash, HASH2);
  });

  it("R12 superseded resolves without a trade tx hash and releases the intent", async () => {
    const { h, deps } = await setup("superseded");
    await runTradeWorkerOnce(deps);
    const row = await h.journal.get(HASH2);
    assert.equal(row?.state, "ROLLED_BACK");
    assert.equal(row?.externalRef.txHash, undefined);
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
  });

  it("R12 hold and absent reads write no resolution run row", async () => {
    for (const mode of ["hold", "absent"] as const) {
      const { h, deps } = await setup(mode);
      await runTradeWorkerOnce(deps);
      assert.equal((await h.journal.get(HASH2))?.state, "UNKNOWN");
      assert.equal((await h.positions.listRuns(OWNER, "agent-a", 100)).filter((run) => run.reason === "ambiguous-trade-resolved").length, 0);
    }
  });

  it("R13 a lost journal CAS is swallowed without a resolution run row", async () => {
    const { h, deps } = await setup("lost-cas");
    const journal = new Proxy(h.journal, { get(target, property) {
      if (property === "advanceUnknown") return async (...args: Parameters<typeof h.journal.advanceUnknown>) => {
        await target.advanceUnknown(...args);
        return target.advanceUnknown(...args);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await runTradeWorkerOnce({ ...deps, journal });
    assert.equal((await h.journal.get(HASH2))?.state, "COMMITTED");
    assert.equal((await h.positions.listRuns(OWNER, "agent-a", 100)).filter((run) => run.reason === "ambiguous-trade-resolved").length, 0);
  });

  it("R2.4 projected v2 sell adopts verified proceeds after balance-gone closed it", async () => {
    const h = await harness({ settings: settings({ maxOpenPositions: 1 }) });
    const token = address(100);
    await openPosition(h, token, "gone-v2");
    await h.positions.closePosition({ ownerAddress: OWNER, agentId: "agent-a", positionId: "gone-v2",
      exitWei: 0n, reason: "balance-gone", exitFillStatus: "unverified" });
    await h.intents.create({ decisionId: "gone-v2", idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      side: "sell", token, route: { hops: [], fees: [] }, amountWei: 10n, positionId: "gone-v2",
      entryWei: 0n, closeReason: null, settlementAsset: "USDT" });
    await h.intents.markProjected(OWNER, "agent-a", "gone-v2");
    await h.journal.begin({ idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "gone-v2" });
    await h.journal.markCommitted(HASH2, { txHash: HASH2 });
    const ownership = `56|${HASH2}|${token}|1|${HASH}`;
    await runTradeWorkerOnce({ ...h.deps, readiness: { ...h.deps.readiness, ready: false },
      recoverFill: async () => ({ side: "sell", exitWei: 12n, fillStatus: "verified", receiptOwnershipKey: ownership }) });
    const row = await h.positions.get(OWNER, "agent-a", "gone-v2");
    assert.equal(row?.exitWei, 12n);
    assert.equal(row?.exitFillStatus, "verified");
    assert.equal(row?.exitReceiptOwnershipKey, ownership.toLowerCase());
  });

  it("R4.4 contaminated other-wallet buy and sell retain no receipt-attributed accounting", async () => {
    let balance = 100n;
    let balanceReads = 0;
    const h = await harness({ settings: settings({ maxOpenPositions: 1, takeProfitBps: null,
      stopLossBps: null, maxHoldSec: null }),
      tokenBalance: async () => { balanceReads += 1; return balance; },
      llm: { async complete() { return { model: "fixture", content: JSON.stringify({
        decisions: [{ index: 0, exit: false, reason: "hold" }] }) }; } } });
    const publicKey = "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8" as Hex;
    await h.agents.updateAgentSessionFacts(OWNER, "agent-a", { ...h.created[0]!.sessionFacts!, publicKey });
    const token = address(100);
    const pair = address(500);
    await h.positions.open({ positionId: "contaminated-sell", agentId: "agent-a", ownerAddress: OWNER,
      token, route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: null,
      fillStatus: "unverified", openedAt: h.deps.now?.() ?? Date.now(), settlementAsset: "USDT",
      requestedEntryAtomic: 100n, verifiedEntryAtomic: null });
    await runTradeWorkerOnce(h.deps);
    const quantity = await h.positions.get(OWNER, "agent-a", "contaminated-sell");
    assert.equal(quantity?.fillStatus, "verified");
    assert.equal(quantity?.tokenAmount, 100n);
    assert.equal(quantity?.verifiedEntryAtomic, null);
    assert.equal(quantity?.receiptOwnershipKey ?? null, null);
    balance = 0n;
    await runTradeWorkerOnce(h.deps);
    assert.equal((await h.positions.get(OWNER, "agent-a", "contaminated-sell"))?.closeReason, "balance-gone");
    const keyHash = accountKeyHashForAddress(publicKeyToAddress(publicKey));
    const calls = [{ to: pair, value: 0n, data: "0x12345678" as Hex }];
    const member = (wallet: Address, nonce: bigint) => encodeAbiParameters(PORTO_V055_INTENT_PARAMETERS, [{
      eoa: wallet, executionData: encodeLpFinalCallsV1(calls), nonce, payer: address(0),
      paymentToken: address(0), paymentMaxAmount: 0n, combinedGas: 0n,
      encodedPreCalls: [], encodedFundTransfers: [], settler: address(0), expiry: 0n,
      isMultichain: false, funder: address(0), funderSignature: "0x", settlerContext: "0x",
      paymentAmount: 0n, paymentRecipient: address(0),
      signature: concatHex([`0x${"11".repeat(65)}` as Hex, keyHash, "0x00"]),
      paymentSignature: "0x", supportedAccountImplementation: address(0),
    }] as const);
    const other = address(600);
    const blockHash = `0x${"77".repeat(32)}` as Hex;
    const transferTopic = keccak256(stringToBytes("Transfer(address,address,uint256)"));
    const transfer = (asset: Address, from: Address, to: Address, value: bigint, logIndex: bigint) => ({
      address: asset, topics: [transferTopic, padHex(from, { size: 32 }), padHex(to, { size: 32 })],
      data: toHex(value, { size: 32 }), logIndex });
    const event = (wallet: Address, nonce: bigint, logIndex: bigint) => ({ address: PORTO_V055_ORCHESTRATOR,
      topics: [INTENT_EXECUTED_TOPIC, padHex(wallet, { size: 32 }), toHex(nonce, { size: 32 })],
      data: encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, "0x00000000"]), logIndex });
    const logs = [event(WALLET, 7n, 1n), event(other, 8n, 2n),
      transfer(token, WALLET, pair, 100n, 3n), transfer(USDT_56, pair, WALLET, 90n, 4n)];
    const transaction = { hash: HASH2, to: PORTO_V055_ORCHESTRATOR,
      input: encodeFunctionData({ abi: parseAbi(["function execute(bytes[] encodedIntents) payable returns (bytes4[] errs)"]),
        functionName: "execute", args: [[member(WALLET, 7n), member(other, 8n)]] }),
      blockNumber: 100n, blockHash, transactionIndex: 0n };
    const observed = (receiptLogs: typeof logs): TradfiReceiptObservation => ({ chainId: 56,
      transaction, receipt: { status: 1n, transactionHash: HASH2, blockNumber: 100n, blockHash,
        transactionIndex: 0n, logs: receiptLogs }, receiptBlock: { number: 100n, hash: blockHash },
      finalizedBlock: { number: 110n, hash: HASH } });
    const expected = { wallet: WALLET, sessionPublicKey: publicKey, sessionGeneration: 0,
      callsHash: hashCalls(calls), calls, side: "sell" as const, token, amountInAtomic: 100n,
      minOutAtomic: 80n, directRoute: { kind: "v2" as const, router: pair, pools: [pair],
        blockNumber: 100n, blockHash } };
    const clean = verifyTradfiV2Receipt({ observation: observed(logs), expected });
    assert.equal(clean.ok, true, clean.ok ? "" : clean.code);
    const contaminated = observed([...logs, transfer(USDT_56, other, WALLET, 1n, 5n)]);
    assert.equal(verifyTradfiV2Receipt({ observation: contaminated, expected }).ok, false);
    await h.intents.create({ decisionId: "contaminated-sell", idempotencyKey: HASH2, agentId: "agent-a",
      ownerAddress: OWNER, side: "sell", token, route: { hops: [], fees: [] }, amountWei: 100n,
      entryWei: 0n, positionId: "contaminated-sell", closeReason: null, settlementAsset: "USDT" });
    await h.journal.begin({ idempotencyKey: HASH2, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "contaminated-sell" });
    await h.journal.markCommitted(HASH2, { txHash: HASH2 });
    let recoveries = 0;
    const deps: TradeWorkerDeps = { ...h.deps, readiness: { ...h.deps.readiness, ready: false },
      async recoverFill() {
        recoveries += 1;
        assert.equal(verifyTradfiV2Receipt({ observation: contaminated, expected }).ok, false);
        return { side: "sell", exitWei: null, fillStatus: "unverified" };
      } };
    await runTradeWorkerOnce(deps);
    await runTradeWorkerOnce(deps);
    const exited = await h.positions.get(OWNER, "agent-a", "contaminated-sell");
    assert.ok(balanceReads > 0);
    assert.ok(recoveries >= 2);
    assert.equal(exited?.exitWei, 0n);
    assert.equal(exited?.exitFillStatus, "unverified");
    assert.equal(exited?.exitReceiptOwnershipKey ?? null, null);

    const buyLogs = [event(WALLET, 7n, 1n), event(other, 8n, 2n),
      transfer(USDT_56, WALLET, pair, 100n, 3n), transfer(token, pair, WALLET, 90n, 4n)];
    const buyExpected = { ...expected, side: "buy" as const };
    const buyObserved = (receiptLogs: typeof buyLogs): TradfiReceiptObservation => {
      const base = observed(receiptLogs);
      return { ...base, transaction: { ...base.transaction, hash: HASH },
        receipt: { ...base.receipt, transactionHash: HASH } };
    };
    assert.equal(verifyTradfiV2Receipt({ observation: buyObserved(buyLogs), expected: buyExpected }).ok, true);
    const contaminatedBuy = buyObserved([...buyLogs, transfer(USDT_56, other, WALLET, 1n, 5n)]);
    assert.equal(verifyTradfiV2Receipt({ observation: contaminatedBuy, expected: buyExpected }).ok, false);
    await h.intents.create({ decisionId: "contaminated-buy", idempotencyKey: HASH, agentId: "agent-a",
      ownerAddress: OWNER, side: "buy", token, route: { hops: [], fees: [] }, amountWei: 100n,
      entryWei: 107n, positionId: "contaminated-buy", closeReason: null, settlementAsset: "USDT" });
    await h.journal.begin({ idempotencyKey: HASH, agentId: "agent-a", ownerAddress: OWNER,
      kind: "trade", decisionId: "contaminated-buy" });
    await h.journal.markCommitted(HASH, { txHash: HASH });
    const buyDeps: TradeWorkerDeps = { ...h.deps, readiness: { ...h.deps.readiness, ready: false },
      async recoverFill(intent) {
        if (intent.side === "sell") return { side: "sell", exitWei: null, fillStatus: "unverified" };
        assert.equal(verifyTradfiV2Receipt({ observation: contaminatedBuy, expected: buyExpected }).ok, false);
        return { side: "buy", entryWei: 107n, tokenAmount: null, fillStatus: "unverified", receiptAttributable: false };
      } };
    await runTradeWorkerOnce(buyDeps);
    assert.equal((await h.positions.get(OWNER, "agent-a", "contaminated-buy"))?.fillStatus, "unverified");
    balance = 90n;
    await runTradeWorkerOnce({ ...buyDeps, readiness: h.deps.readiness });
    const recoveredBuy = await h.positions.get(OWNER, "agent-a", "contaminated-buy");
    assert.equal(recoveredBuy?.fillStatus, "verified");
    assert.equal(recoveredBuy?.tokenAmount, 90n);
    assert.equal(recoveredBuy?.verifiedEntryAtomic, null);
    assert.equal(recoveredBuy?.receiptOwnershipKey ?? null, null);
  });
});

describe("TRADING-AGENT primary/fallback model (operator 2026-09-03)", () => {
  it("asks the primary, and the distinct fallback only when the primary throws", async () => {
    const asked: string[] = [];
    const answer = { content: JSON.stringify({ decisions: [] }), model: "x" };
    const h = await harness({
      settings: settings({ primaryModel: "glm-5.3-flash", fallbackModel: "0gm-1.0-35b-a3b" }),
    });
    const deps = {
      ...h.deps,
      llmFor: (modelId: string): TradeLlm => ({
        async complete() {
          asked.push(modelId);
          if (modelId === "glm-5.3-flash") throw new Error("timeout");
          return answer;
        },
      }),
    };
    await runTradeWorkerOnce(deps, {});
    assert.deepEqual(asked, ["glm-5.3-flash", "0gm-1.0-35b-a3b"]);
  });

  it("the owner's signed model choice wins over the daemon override (2026-09-20): primary, then the owner's fallback", async () => {
    const asked: string[] = [];
    const answer = { content: JSON.stringify({ decisions: [] }), model: "x" };
    const h = await harness({
      settings: settings({ primaryModel: "glm-5.3-flash", fallbackModel: "qwen3-vl-30b" }),
    });
    const deps = {
      ...h.deps,
      modelOverride: { primary: "qwen3.7-flash", fallback: "0gm-1.0-35b-a3b" },
      llmFor: (modelId: string): TradeLlm => ({
        async complete() {
          asked.push(modelId);
          if (modelId === "glm-5.3-flash") throw new Error("router down");
          return answer;
        },
      }),
    };
    await runTradeWorkerOnce(deps, {});
    assert.deepEqual(asked, ["glm-5.3-flash", "qwen3-vl-30b"]);
  });

});

it("records ordered, sanitized model and execution observations without changing the trade", async () => {
  const h = await harness();
  await openPosition(h, address(900), "trace-old");
  const original = h.deps.llmFor;
  const report = await runTradeWorkerOnce({ ...h.deps, llmFor: (model) => ({
    async complete(messages, signal) {
      const result = await original(model).complete(messages, signal);
      const parsed = JSON.parse(result.content) as { decisions: { reason: string }[] };
      for (const decision of parsed.decisions) decision.reason = "Momentum strong sk-secret123 Bearer abc123 0x" + "aa".repeat(32);
      return { ...result, content: JSON.stringify(parsed) };
    },
  }) });
  assert.deepEqual(h.calls.map((call) => call.side), ["sell", "buy"]);
  const [run] = await h.positions.listRuns(OWNER, "agent-a");
  const events = run?.events ?? [];
  assert.equal(events[0]?.stage, "sell");
  assert.ok(events.some((event) => event.stage === "entry-llm" && event.code === "selected" && event.confidence !== undefined && event.model !== undefined));
  assert.ok(events.some((event) => event.stage === "route"));
  assert.ok(events.some((event) => event.stage === "buy" && event.code === "committed"));
  assert.equal(events.at(-1)?.code, report.outcomes[0]?.reason);
  assert.doesNotMatch(JSON.stringify(events), /sk-secret123|abc123|aaaaaaaa/);
  assert.deepEqual(await h.positions.listRuns(address(999), "agent-a"), []);
});

it("enriches entry and blank-threshold exits while hard exits precede any optional feature read", async()=>{
  const at=Date.UTC(2026,8,7,14);const token=address(105);let featureReads=0;let hardExitDone=false;
  const reads={...dataPlane(),async featurePools(){featureReads++;return {pools:[{pool:address(1),tokenAddress:token,currency:"usd"}]}},
    async featuresBatch(_p:readonly Address[],interval:"15m"|"1h"){featureReads++;return {[address(1)]:{data:featureFixture(interval,token,at)}}}};
  const h=await harness({reads,now:at,settings:settings({takeProfitBps:null,stopLossBps:null,maxHoldSec:null})});
  const prompts:string[]=[];
  const deps={...h.deps,llmFor:()=>({async complete(messages:readonly {content:string}[]){prompts.push(messages.map(m=>m.content).join("\n"));return {model:"fixture",content:JSON.stringify({decisions:[]})}}})};
  await runTradeWorkerOnce(deps,{dryRun:true});assert.equal(featureReads,3);assert.ok(prompts[0]!.includes('"scope":"exact_pool"'));
  await openPosition(h,token,"conditional",at);await runTradeWorkerOnce(deps);
  assert.ok(prompts.some(prompt=>prompt.startsWith("Decide only")&&prompt.includes('"scope":"exact_pool"')));
  const hard=await harness({reads:{...reads,async featurePools(){assert.ok(hardExitDone);throw Error("outage")}},now:at,
    settings:settings({takeProfitBps:null,stopLossBps:null,maxHoldSec:60}),executor:{async execute(){hardExitDone=true;return {kind:"unknown",meta:{}}}}});
  await openPosition(hard,token,"hard",at-120000);await runTradeWorkerOnce(hard.deps);assert.ok(hardExitDone);
});

it("worker preserves69 granted candidates through50+19 and reaches an address after50",async()=>{
  const batches:number[]=[];const base=dataPlane(69);const h=await harness({reads:{...base,async tokensBatch(addresses){batches.push(addresses.length);return base.tokensBatch(addresses)}}});
  await runTradeWorkerOnce(h.deps);assert.deepEqual(batches,[50,19]);assert.equal(h.calls[0]!.token,address(168));
});

/* -------------------------------------------------------------------------- */
/* AGENT-GAS-ATTENTION §2.2 — the trade worker's gas gate                      */
/* -------------------------------------------------------------------------- */

describe("trade worker gas gate", () => {
  /** A trade agent's next motion is ONE exit's relay reimbursement. */
  const FLOOR = agentGasFloor({ profile: "trade-v1" })!;

  async function gated(input: {
    readonly nativeWei?: bigint | undefined;
    readonly gasBackoff?: ReturnType<typeof createTradeGasBackoff>;
    readonly nowMs?: number;
  }) {
    const h = await harness();
    const reads = { calls: 0 };
    const deps: TradeWorkerDeps = {
      ...h.deps,
      walletNativeBalance: async () => {
        reads.calls += 1;
        if (input.nativeWei === undefined) throw new Error("balance unreadable");
        return input.nativeWei;
      },
      ...(input.gasBackoff === undefined ? {} : { gasBackoff: input.gasBackoff }),
      intervalMs: 60_000,
      ...(input.nowMs === undefined ? {} : { now: () => input.nowMs! }),
    };
    return { h, deps, reads };
  }

  it("a short wallet spends no LLM, no quote and no execution", async () => {
    const { h, deps } = await gated({ nativeWei: FLOOR.blockWei - 1n });
    const report = await runTradeWorkerOnce(deps);
    assert.equal(h.calls.length, 0, "nothing may be executed for a blocked agent");
    assert.match(report.outcomes[0]!.reason, /^Deposit at least /u);
    assert.equal(report.outcomes[0]?.candidates, 0);
    // No durable run row: a row per cycle for an agent that did nothing is the
    // churn this change removes.
    assert.equal((await h.positions.listRuns?.(OWNER, "agent-a"))?.length ?? 0, 0);
  });

  it("a funded wallet is untouched by the gate", async () => {
    const { h, deps } = await gated({ nativeWei: FLOOR.warnWei });
    await runTradeWorkerOnce(deps);
    assert.ok(h.calls.length > 0, "a funded agent still trades");
  });

  it("an unreadable balance fails closed", async () => {
    const { h, deps } = await gated({ nativeWei: undefined });
    const report = await runTradeWorkerOnce(deps);
    assert.equal(h.calls.length, 0);
    assert.match(report.outcomes[0]!.reason, /could not be read/u);
  });

  it("custody convergence still runs for a blocked agent", async () => {
    // The projection sweep sits ABOVE the gate on purpose: a paused agent gets
    // it, and a broke one must too, or a later-confirmed submission stays
    // invisible for ever.
    let reconciled = 0;
    const { deps } = await gated({ nativeWei: 0n });
    await runTradeWorkerOnce({ ...deps, reconcile: async () => { reconciled += 1; } });
    assert.equal(reconciled, 1);
  });

  it("backs off, then probes again, then recovers", async () => {
    const backoff = createTradeGasBackoff();
    let nowMs = Date.UTC(2026, 8, 10, 12);
    const h = await harness();
    const reads = { calls: 0 };
    let nativeWei = FLOOR.blockWei - 1n;
    const deps: TradeWorkerDeps = {
      ...h.deps,
      walletNativeBalance: async () => { reads.calls += 1; return nativeWei; },
      gasBackoff: backoff,
      intervalMs: 60_000,
      now: () => nowMs,
    };

    for (let i = 0; i < 3; i += 1) { await runTradeWorkerOnce(deps); nowMs += 60_000; }
    assert.equal(reads.calls, 3, "the first probes retry at full cadence");

    // Probe 3 set the ladder to 10 intervals; one interval on costs nothing.
    await runTradeWorkerOnce(deps);
    assert.equal(reads.calls, 3, "a backed-off cycle must not read the balance");

    nowMs += 10 * 60_000;
    nativeWei = FLOOR.warnWei * 2n;
    await runTradeWorkerOnce(deps);
    assert.equal(reads.calls, 4);
    assert.equal(backoff.size, 0, "a funded wallet clears the ladder outright");
    assert.ok(h.calls.length > 0, "and the agent trades again with no owner action");
  });

  it("the two workers' backoff ladders are the same ladder", () => {
    // They are written twice (see `tradeGasBackoffIntervals`' comment on why
    // importing across the two daemons is refused). This is what keeps the
    // duplication honest.
    for (const probes of [1, 2, 3, 4, 5, 6, 7, 100]) {
      assert.equal(tradeGasBackoffIntervals(probes), lpGasBackoffIntervals(probes), `probe ${probes}`);
    }
  });
});

describe("trade worker gas cache across a shared wallet (review 3/4)", () => {
  const FLOOR = agentGasFloor({ profile: "trade-v1" })!;

  it("REVIEW 3: agent B is judged on the balance A LEFT, not the one A started with", async () => {
    // Two legacy self-EOA agents on ONE wallet. A spends; B must not reach the
    // executor on A's pre-spend figure. Removing the invalidations survived the
    // earlier suite because nothing made the balance actually DECREASE.
    const h = await harness({ ids: ["agent-a", "agent-b"] });
    // Force both agents onto the same wallet.
    const shared = async (id: string) => {
      const agent = await h.agents.getAgentById(id);
      return agent === null ? null : { ...agent, walletAddress: WALLET };
    };
    let balance = FLOOR.blockWei * 2n;
    const reads: bigint[] = [];
    const deps: TradeWorkerDeps = {
      ...h.deps,
      agentStore: { getAgentById: shared } as TradeWorkerDeps["agentStore"],
      walletNativeBalance: async () => { reads.push(balance); return balance; },
      gasBackoff: createTradeGasBackoff(),
      intervalMs: 60_000,
      executor: {
        async execute(request) {
          // Every executed trade costs the wallet one motion's relay fee.
          balance = balance > FLOOR.blockWei ? balance - FLOOR.blockWei : 0n;
          return {
            kind: "committed" as const,
            receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
            fill: request.request.side === "buy"
              ? { side: "buy" as const, entryWei: request.request.amountWei, tokenAmount: request.request.quotedOutWei, fillStatus: "verified" as const }
              : { side: "sell" as const, exitWei: request.request.quotedOutWei, fillStatus: "verified" as const },
            meta: {},
          };
        },
      },
    };

    await runTradeWorkerOnce(deps);
    assert.ok(reads.length >= 2, `the wallet must be re-read per agent, got ${reads.length} read(s)`);
    assert.ok(
      reads.some((value) => value < reads[0]!),
      `every read returned the pre-spend figure ${reads[0]}: the cache was not invalidated`,
    );
  });
});

describe("TradFi worker RWA snapshot and venue routing", () => {
  const NOW = Date.now();
  const TOKEN = address(950);
  const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
  const UNI_ROUTER = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  it("reads both RWA lanes once, screens the computed fact, and persists the winning venue", async () => {
    const venue: VenueRow = { dex: "uniswap", version: "v3", pool: address(951), feeTier: 3000, quote: WBNB,
      quoteSymbol: "WBNB", priceUsd: 100, liquidityUsd: 100_000, volume24hUsd: 1, asOf: NOW };
    const fact: RwaFact = { platform: "bstock", underlyingTicker: "NVDA", tokenPriceUsd: 100,
      referencePriceUsd: 100, premiumBps: 999, openState: true, marketStatus: null, reasonCode: "TRADING",
      staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 100, venues: [venue] };
    const bstock: UniverseRow = { address: TOKEN, symbol: "NVDAB", lane: "bstocks", source: "fixture", rwa: fact, venues: [venue] };
    const meme = { ...bstock, lane: "meme" as const };
    let laneReads = 0;
    const reads: TradeDataPlaneReads = {
      async universe(lane) {
        if (lane === "meme") return [meme];
        if (lane === "bstocks") { laneReads += 1; return [bstock]; }
        if (lane === "ondo") { laneReads += 1; return []; }
        return [];
      },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({ address, symbol: "NVDAB",
        priceUsd: 100, marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0 })); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa",
        source: "binance-rwa" as const, venue: null })); },
      async security() { return { riskLevel: "ok", flags: [] }; },
    };
    const routeReader = quoteReader(async (path, amount) => path[0] === WBNB ? amount : amount);
    routeReader.quoteUniV3Single = async (_in, _out, fee, amount) => fee === 3000 ? amount * 3n : amount;
    routeReader.quoteUniV3Path = async (_path, amount) => amount * 2n;
    const executed: string[] = [];
    const h = await harness({
      now: NOW,
      settings: settings({ executionModel: "tradfi", entryWei: "20000000000000000", noReentry: false }),
      reads,
      bstocks: new Set([TOKEN.toLowerCase()]),
      routeReader,
      executor: { async execute(input) {
        executed.push(input.request.venue);
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "buy", entryWei: input.request.amountWei, tokenAmount: input.request.quotedOutWei, fillStatus: "verified" }, meta: {} };
      } },
    });
    const agent = await h.agents.getAgentById("agent-a");
    assert.ok(agent?.sessionFacts);
    await h.agents.updateAgentSessionFacts(OWNER, "agent-a", {
      ...agent.sessionFacts,
      spec: { ...agent.sessionFacts.spec, allowedCalls: [
        ...agent.sessionFacts.spec.allowedCalls,
        { to: UNI_ROUTER, selector: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" },
        { to: UNI_ROUTER, selector: "exactInput((bytes,address,uint256,uint256))" },
        { to: UNI_ROUTER, selector: "unwrapWETH9(uint256,address)" },
        { to: UNI_ROUTER, selector: "refundETH()" },
      ] },
    });
    const report = await runTradeWorkerOnce({ ...h.deps, uniswapRouter: UNI_ROUTER });
    assert.equal(report.outcomes[0]?.reason, "entered");
    assert.deepEqual(executed, ["uniswap_v3"]);
    assert.equal((await h.positions.listOpen(OWNER, "agent-a"))[0]?.venue, "uniswap_v3");
    assert.equal(laneReads, 2);
  });

  it("AUDIT A1: a successful static-only lane read (rows without facts) refuses every member as rwa-unavailable", async () => {
    const staticRow: UniverseRow = { address: TOKEN, symbol: "NVDAB", lane: "bstocks", source: "static", marketHours: "us-equities" };
    const reads: TradeDataPlaneReads = {
      async universe(lane) {
        if (lane === "bstocks") return [staticRow];
        if (lane === "ondo") return [];
        return [{ ...staticRow, lane: "meme" as const }];
      },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({ address, symbol: "NVDAB",
        priceUsd: 100, marketCapUsd: 5e9, volume24hUsd: 1, holders: 1, priceChange24hPct: 0 })); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "allowlist",
        source: "allowlist" as const, venue: null })); },
      async security() { return { riskLevel: "ok", flags: [] }; },
    };
    const executed: string[] = [];
    const h = await harness({
      now: NOW,
      settings: settings({ executionModel: "sigma", noReentry: false }),
      reads,
      bstocks: new Set([TOKEN.toLowerCase()]),
      routeReader: quoteReader(async (_path, amount) => amount),
      executor: { async execute(input) { executed.push(input.request.venue); throw new Error("must not execute"); } },
    });
    const report = await runTradeWorkerOnce(h.deps);
    const events = (report.outcomes[0] as unknown as { readonly events?: readonly { readonly code: string; readonly token?: Address }[] })?.events ?? [];
    assert.equal(executed.length, 0);
    assert.equal(events.some((event) => event.code === "rwa-unavailable" && event.token === TOKEN), true,
      `expected an rwa-unavailable refusal, got ${JSON.stringify(events.map((event) => event.code))}`);
  });

  it("AUDIT A1: a session without the four Uniswap selectors never quotes or executes on Uniswap", async () => {
    const venue: VenueRow = { dex: "uniswap", version: "v3", pool: address(952), feeTier: 3000, quote: WBNB,
      quoteSymbol: "WBNB", priceUsd: 100, liquidityUsd: 100_000, volume24hUsd: 1, asOf: NOW };
    const fact: RwaFact = { platform: "bstock", underlyingTicker: "NVDA", tokenPriceUsd: 100,
      referencePriceUsd: 100, premiumBps: 0, openState: true, marketStatus: null, reasonCode: "TRADING",
      staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 100, venues: [venue] };
    const bstock: UniverseRow = { address: TOKEN, symbol: "NVDAB", lane: "bstocks", source: "fixture", rwa: fact, venues: [venue] };
    const reads: TradeDataPlaneReads = {
      async universe(lane) {
        if (lane === "bstocks") return [bstock];
        if (lane === "ondo") return [];
        return [{ ...bstock, lane: "meme" as const }];
      },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({ address, symbol: "NVDAB",
        priceUsd: 100, marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0 })); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa",
        source: "binance-rwa" as const, venue: null })); },
      async security() { return { riskLevel: "ok", flags: [] }; },
    };
    let uniswapQuotes = 0;
    const routeReader = quoteReader(async (_path, amount) => amount);
    routeReader.quoteUniV3Single = async (_in, _out, _fee, amount) => { uniswapQuotes += 1; return amount * 3n; };
    routeReader.quoteUniV3Path = async (_path, amount) => { uniswapQuotes += 1; return amount * 3n; };
    const executed: string[] = [];
    const h = await harness({
      now: NOW,
      settings: settings({ executionModel: "tradfi", entryWei: "20000000000000000", noReentry: false }),
      reads,
      bstocks: new Set([TOKEN.toLowerCase()]),
      routeReader,
      executor: { async execute(input) {
        executed.push(input.request.venue);
        return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
          fill: { side: "buy", entryWei: input.request.amountWei, tokenAmount: input.request.quotedOutWei, fillStatus: "verified" }, meta: {} };
      } },
    });
    // The session keeps its original allowlist: no Uniswap selector rules.
    const report = await runTradeWorkerOnce({ ...h.deps, uniswapRouter: UNI_ROUTER });
    assert.equal(report.outcomes[0]?.reason, "entered");
    assert.equal(uniswapQuotes, 0);
    assert.notEqual(executed[0], "uniswap_v3");
  });

  it("keeps the seven-probe Pancake repair when both RWA lane reads fail", async () => {
    const base = dataPlane(1);
    const token = address(960);
    const reads: TradeDataPlaneReads = {
      ...base,
      async universe(lane, signal) {
        if (lane === "bstocks" || lane === "ondo") throw new Error("RWA feed unavailable");
        return base.universe(lane, signal);
      },
    };
    const routeReader: RouteQuoteReader = {
      async quoteV2(path, amount) { if (path[0] === token) throw new Error("stored pool reverted"); return amount; },
      async quoteV3Single(_in, _out, fee, amount) { return fee === 100 ? amount * 2n : amount; },
      async quoteV3Path() { throw new Error("no hop route"); },
      async quoteUniV3Single() { throw new Error("not a repair probe"); },
      async quoteUniV3Path() { throw new Error("not a repair probe"); },
    };
    const h = await harness({ reads, routeReader, now: NOW });
    await openPosition(h, token, "repair-during-feed-outage");
    await h.settingsStore.requestDrain(OWNER, "agent-a");
    const seen: string[] = [];
    const report = await runTradeWorkerOnce({ ...h.deps, executionIdentity: (agent, request) => {
      seen.push(`${request.side}:${request.venue}`);
      return h.deps.executionIdentity(agent, request);
    } });
    assert.equal(report.outcomes[0]?.reason, "draining");
    assert.equal(seen[0], "sell:pancake_v3");
    assert.equal((await h.positions.get(OWNER, "agent-a", "repair-during-feed-outage"))?.status, "closed");
  });
});

describe("trade exit doctrine worker boundaries", () => {
  it("writes session-expired before readiness and gas, while projection still runs", async () => {
    const now = Date.now();
    const h = await harness({ now });
    const agent = await h.agents.getAgentById("agent-a");
    assert.ok(agent?.sessionFacts);
    await h.agents.updateAgentSessionFacts(OWNER, "agent-a", { ...agent.sessionFacts, expiry: Math.floor(now / 1_000) - 1 });
    let projected = 0;
    let gasReads = 0;
    const report = await runTradeWorkerOnce({
      ...h.deps,
      reconcile: async () => { projected += 1; },
      readiness: { ...h.deps.readiness, ready: false },
      walletNativeBalance: async () => { gasReads += 1; return 0n; },
    });
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(projected, 1);
    assert.equal(gasReads, 0);
    assert.equal(report.outcomes[0]?.reason, "session-expired");
    assert.equal(run?.reason, "session-expired");
    assert.equal(run?.events?.[0]?.code, "session-expired");
  });

  it("stops entries at the clamped session cutoff before any market or model read", async () => {
    const base = Date.now();
    const h = await harness({ now: base + 70_000 });
    const agent = await h.agents.getAgentById("agent-a");
    assert.ok(agent?.sessionFacts);
    await h.agents.updateAgentSessionFacts(OWNER, "agent-a", { ...agent.sessionFacts, expiry: Math.floor((base + 130_000) / 1_000) });
    let balanceReads = 0;
    let modelCalls = 0;
    const report = await runTradeWorkerOnce({
      ...h.deps,
      provider: { getTokenBalance: async () => { balanceReads += 1; return 100n; } },
      llmFor: () => ({ complete: async () => { modelCalls += 1; return { model: "fixture", content: JSON.stringify({ decisions: [] }) }; } }),
    });
    assert.equal(report.outcomes[0]?.reason, "session-expiring");
    assert.equal(balanceReads, 0);
    assert.equal(modelCalls, 0);
  });

  it("paces time-limit-only model calls and leaves blank price thresholds on the cycle cadence", async () => {
    const base = Date.now();
    const counter = { calls: 0 };
    let now = base;
    const h = await harness({ now: base, settings: settings({ maxOpenPositions: 1, takeProfitBps: 1_000, stopLossBps: 1_000, maxHoldSec: null }),
      llm: { complete: async () => { counter.calls += 1; return { model: "fixture", content: JSON.stringify({ decisions: [{ index: 0, exit: false, reason: "hold" }] }) }; } },
      routeReader: quoteReader(async (_path, amount) => amount),
    });
    await openPosition(h, address(950), "paced", base - 1_000);
    const deps = { ...h.deps, now: () => now, exitLlmIntervalMs: 300_000 };
    await runTradeWorkerOnce(deps);
    now += 120_000;
    await runTradeWorkerOnce(deps);
    assert.equal(counter.calls, 1);
    const runs = await h.positions.listRuns(OWNER, "agent-a", 10);
    assert.ok(runs.some((run) => run.events?.some((event) => event.code === "deferred")));
    now += 180_000;
    await runTradeWorkerOnce(deps);
    assert.equal(counter.calls, 2);
  });

  it("keeps a crash marker through refusal and closes with its persisted note on retry", async () => {
    const base = Date.now();
    let now = base;
    let quote = 100n;
    let balance = 100n;
    let sells = 0;
    const h = await harness({ now: base, settings: settings({ maxOpenPositions: 1, takeProfitBps: 9_000, stopLossBps: 9_000, maxHoldSec: 86_400 }),
      tokenBalance: async () => balance,
      routeReader: quoteReader(async (_path, amount) => amount * quote / 100n),
      executor: { async execute(input) {
        if (input.request.side === "sell") {
          sells += 1;
          if (sells === 1) return { kind: "rolled-back", code: "REFUSED", meta: {} };
          balance = 0n;
        }
        return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
          fill: input.request.side === "sell"
            ? { side: "sell" as const, exitWei: input.request.quotedOutWei, fillStatus: "verified" as const }
            : { side: "buy" as const, entryWei: input.request.amountWei, tokenAmount: input.request.quotedOutWei, fillStatus: "verified" as const, receiptAttributable: true }, meta: {} };
      } },
    });
    await h.positions.open({ positionId: "crash", agentId: "agent-a", ownerAddress: OWNER, token: address(951),
      route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 100n, fillStatus: "verified", openedAt: base - 10_000,
      crashBasisVerified: true });
    const deps = { ...h.deps, now: () => now };
    await runTradeWorkerOnce(deps);
    quote = 40n;
    now += 120_000;
    await runTradeWorkerOnce(deps);
    now += 120_000;
    await runTradeWorkerOnce(deps);
    const marked = await h.positions.get(OWNER, "agent-a", "crash");
    assert.equal(sells, 1);
    assert.equal(marked?.status, "open");
    assert.equal(marked?.autoExitReason, "crash-stop");
    assert.ok(marked?.autoExitNote);
    now += 120_000;
    await runTradeWorkerOnce(deps);
    const closed = await h.positions.get(OWNER, "agent-a", "crash");
    assert.equal(sells, 2);
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.closeReason, "crash-stop");
    assert.equal(closed?.closeNote, marked?.autoExitNote);
  });

  // AUDIT (Fable, 2026-09-15) — two mutations survived the builder's suite:
  // (m2) removing the fence's re-read of `crashProtection` before a crash
  // intent, and (m3) selling although the marker CAS failed. Both rules are
  // R3.2 / R4.2 of the spec; both are now pinned here.
  it("R4.2: a crash marker whose owner has since turned protection OFF creates no sell intent", async () => {
    const base = Date.now();
    let sells = 0;
    const h = await harness({ now: base, settings: settings({ maxOpenPositions: 1, takeProfitBps: 9_000, stopLossBps: 9_000, maxHoldSec: 86_400 }),
      // A flat quote: neither price threshold can fire, so only the marker could sell.
      routeReader: quoteReader(async (_path, amount) => amount),
      executor: { async execute(input) {
        if (input.request.side === "sell") sells += 1;
        return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
          fill: { side: "sell" as const, exitWei: input.request.quotedOutWei, fillStatus: "verified" as const }, meta: {} };
      } },
    });
    await h.positions.open({ positionId: "marked", agentId: "agent-a", ownerAddress: OWNER, token: address(952),
      route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 100n, fillStatus: "verified", openedAt: base - 10_000,
      crashBasisVerified: true });
    // The marker is durable evidence from an earlier cycle; the OFF Save's
    // cleanup is simulated as having failed, so the row still carries it.
    const marked = await h.positions.recordCrashEvidence({ ownerAddress: OWNER, agentId: "agent-a", positionId: "marked",
      expected: { lastQuoteWei: null, lastQuoteBalance: null, lastQuoteRoute: null, lastQuoteAtMs: null,
        crashPendingSinceMs: null, crashPendingKind: null, crashRefQuoteWei: null, crashRefBalance: null,
        crashRefAtMs: null, crashRefRoute: null, autoExitReason: null, autoExitAtMs: null, autoExitNote: null },
      action: { kind: "marker", reason: "crash-stop", atMs: base - 5_000, note: "quote -60% vs last reading" } });
    assert.equal(marked?.autoExitReason, "crash-stop");
    // The cycle's settings snapshot (the worker page) still says ON; the owner's
    // OFF Save lands before the sell reaches the fence, whose re-read says OFF.
    const off = settings({ maxOpenPositions: 1, takeProfitBps: 9_000, stopLossBps: 9_000, maxHoldSec: 86_400, crashProtection: false });
    const offRow = { agentId: "agent-a", ownerAddress: OWNER, params: off, digest: tradeSettingsDigest(off), updatedAt: base, drainingAt: null };
    const settingsStore = new Proxy(h.settingsStore, {
      get(target, property, receiver) {
        if (property === "get") return async () => offRow;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof h.settingsStore;
    await runTradeWorkerOnce({ ...h.deps, settingsStore, now: () => base + 120_000 });
    assert.equal(sells, 0, "protection OFF at the fence must refuse the marker-driven sell");
    assert.equal((await h.intents.listUnsettled(OWNER, "agent-a")).length, 0);
    assert.equal((await h.positions.get(OWNER, "agent-a", "marked"))?.status, "open");
  });

  it("R3.2: a marker transition the store refuses cannot authorize that automatic sell", async () => {
    const base = Date.now();
    let sells = 0;
    let quote = 100n;
    const h = await harness({ now: base, settings: settings({ maxOpenPositions: 1, takeProfitBps: 9_000, stopLossBps: 9_000, maxHoldSec: 86_400 }),
      routeReader: quoteReader(async (_path, amount) => amount * quote / 100n),
      executor: { async execute(input) {
        if (input.request.side === "sell") sells += 1;
        return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
          fill: { side: "sell" as const, exitWei: input.request.quotedOutWei, fillStatus: "verified" as const }, meta: {} };
      } },
    });
    await h.positions.open({ positionId: "refused", agentId: "agent-a", ownerAddress: OWNER, token: address(953),
      route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 100n, fillStatus: "verified", openedAt: base - 10_000,
      crashBasisVerified: true });
    // A store whose evidence CAS always loses (a concurrent writer moved the row).
    const positions = new Proxy(h.positions, {
      get(target, property, receiver) {
        if (property === "recordCrashEvidence") {
          return async (input: Parameters<typeof target.recordCrashEvidence>[0]) =>
            input.action.kind === "marker" ? null : target.recordCrashEvidence(input);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof h.positions;
    const deps = { ...h.deps, positions };
    let now = base;
    await runTradeWorkerOnce({ ...deps, now: () => now });
    quote = 40n;
    now += 120_000;
    await runTradeWorkerOnce({ ...deps, now: () => now });
    now += 120_000;
    await runTradeWorkerOnce({ ...deps, now: () => now });
    assert.equal(sells, 0, "the marker could not be written durably, so no crash sell may be submitted");
    const row = await h.positions.get(OWNER, "agent-a", "refused");
    assert.equal(row?.autoExitReason, null);
    assert.equal(row?.crashPendingKind, "collapse", "the arm persisted; only the marker transition was refused");
  });
});

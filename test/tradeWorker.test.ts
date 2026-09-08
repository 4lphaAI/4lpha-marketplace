import { featureFixture } from "./support/tradeFeatures.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { validateSessionSpec } from "../src/core/session.js";
import { MemoryAgentStore, type AgentRecord } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import type { TradeDataPlaneReads, UniverseRow } from "../src/trade/dataPlaneReads.js";
import type { TradeLlm } from "../src/trade/llm.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { positionView } from "../src/trade/view.js";
import { TRADE_ENTRY_RELAY_HEADROOM_WEI } from "../src/trade/sizing.js";
import { evaluateTradeRules } from "../src/rules/engine.js";
import { DRAFT_KEY, cancelDraft, pendingDraft } from "./support/provisioningDraft.js";
import {
  runTradeWorkerOnce,
  type TradeExecutor,
  type TradeWorkerDeps,
} from "../src/trade/worker.js";

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
  };
}

function unavailableRouteReader(): RouteQuoteReader {
  return {
    async quoteV2() { throw new Error("no route"); },
    async quoteV3Single() { throw new Error("no route"); },
    async quoteV3Path() { throw new Error("no route"); },
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
    const validRows = await base.universe("meme");
    const rows: UniverseRow[] = [{ address: usdt, symbol: "USDT", lane: "meme", source: "fixture" }, ...validRows];
    const byAddress = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
    const reads: TradeDataPlaneReads = {
      ...base,
      async universe(lane) { return lane === "meme" ? rows : []; },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({
        address,
        symbol: byAddress.get(address.toLowerCase())?.symbol,
        priceUsd: 1, marketCapUsd: 1_000, volume24hUsd: 1, holders: 1, priceChange24hPct: 1,
      })); },
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

  it("uses at most 18 data-plane reads for a Sigma cycle", async () => {
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
    assert.ok(reads - before <= 18, `worker used ${reads - before} data-plane reads`);
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
      side: "buy", token, route: { hops: [], fees: [] }, amountWei: 100n, entryWei: 107n,
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
    assert.equal((await h.positions.get(OWNER, "agent-a", opened?.positionId ?? ""))?.fillStatus, "verified");
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

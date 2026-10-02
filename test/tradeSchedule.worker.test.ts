import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { validateSessionSpec } from "../src/core/session.js";
import type { SpendInfoReading } from "../src/core/types.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import type { TradeDataPlaneReads, TokenBatchRow, UniverseRow, VenueRow, TradfiFlashQuote } from "../src/trade/dataPlaneReads.js";
import type { RwaFact } from "../src/trade/rwa.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeExecutor, type TradeWorkerDeps } from "../src/trade/worker.js";
import type { SqlClient } from "../src/store/sql.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { TRADFI_GUARD_SWAP_SELECTOR } from "../src/ops/policy.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const FLASH_TAKER = getAddress("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
const HASH = `0x${"11".repeat(32)}` as Hex;
// A Monday inside the regular US equity session (13:30-20:00Z in September, EDT).
const ANCHOR = Date.UTC(2026, 8, 21, 15, 0, 0);
const HOUR = 3_600_000;

function scheduleSettings(overrides: Partial<TradeSettings> = {}): TradeSettings {
  return {
    name: "Schedule Agent", executionModel: "tradfi", entryWei: "10000000000000000000", maxOpenPositions: 1,
    minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
    breakEvenAfterTp: false, slippageBps: 300, gasPriority: "standard", instructions: null, skillMarkdown: null,
    primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false,
    settlementAsset: "USDT", minEntryWei: "10000000000000000000", capitalQuoteWei: "1000000000000000000000", cmcNewsEnabled: false,
    tradeMode: "schedule", scheduleToken: TOKEN.toLowerCase(), scheduleIntervalSec: 3_600,
    scheduleFirstAtSec: null, scheduleEndKind: "budget", scheduleEndAtSec: null, scheduleEndRuns: null,
    scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150,
    ...overrides,
  };
}

function venueRow(overrides: Partial<VenueRow> = {}): VenueRow {
  return { dex: "pancakeswap", version: "v2", pool: getAddress("0x4444444444444444444444444444444444444444"),
    feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 10, liquidityUsd: 50_000, volume24hUsd: 1, asOf: ANCHOR, ...overrides };
}

function rwaFact(overrides: Partial<RwaFact> = {}): RwaFact {
  return { platform: "bstock", underlyingTicker: "NVDA", tokenPriceUsd: 10, referencePriceUsd: 10, premiumBps: 0,
    openState: true, marketStatus: null, reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
    onchainPriceUsd: 10, venues: [venueRow()], ...overrides };
}

function scheduleDataPlane(input: { readonly fact?: RwaFact; readonly binanceQuoteAndSwap?: TradeDataPlaneReads["binanceQuoteAndSwap"] } = {}): TradeDataPlaneReads {
  const fact = input.fact ?? rwaFact();
  const row: UniverseRow = { address: TOKEN, symbol: "NVDAB", lane: "bstocks", source: "fixture", rwa: fact, ...(fact.venues === undefined ? {} : { venues: fact.venues }) };
  return {
    async universe(lane) { return lane === "bstocks" ? [row] : []; },
    async tokensBatch(addresses) {
      return addresses.map((address): TokenBatchRow => ({ address, symbol: address.toLowerCase() === USDT_56.toLowerCase() ? "USDT" : "NVDAB",
        priceUsd: 1, marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: Date.now(), staleness: "fresh" }));
    },
    async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa", source: "binance-rwa" as const, venue: null })); },
    async security() { return { riskLevel: "ok", flags: [] }; },
    ...(input.binanceQuoteAndSwap === undefined ? {} : { binanceQuoteAndSwap: input.binanceQuoteAndSwap }),
  };
}

/** `normalizeReceiptOwnershipKey`'s required shape: chainId|txHash|wallet|logIndex|topicHash. */
function fakeReceiptOwnershipKey(counter: number): string {
  return `56|${HASH}|${WALLET.toLowerCase()}|${counter}|${HASH}`;
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

async function scheduleHarness(input: {
  readonly settings?: TradeSettings;
  readonly now?: number;
  readonly createdAt?: number;
  readonly dataPlane?: TradeDataPlaneReads;
  readonly routeReader?: RouteQuoteReader;
  readonly executor?: TradeExecutor;
  readonly spendCapLimitWei?: bigint;
  readonly spentWei?: bigint;
  readonly usdtBalanceWei?: bigint;
  readonly nativeCostUsdtAtomic?: bigint | null;
  readonly guardGranted?: boolean;
  /** R3.3: proves the worker's own config gate, distinct from the session rule. */
  readonly noAggregatorGuard?: boolean;
  readonly status?: "armed" | "paused";
  readonly platformFeeBps?: number;
  readonly spendInfos?: readonly SpendInfoReading[];
}) {
  const now = input.now ?? ANCHOR;
  const createdAt = input.createdAt ?? ANCHOR;
  const agents = new MemoryAgentStore(null, () => createdAt);
  const positions = new MemoryTradePositionStore(() => now);
  const settingsStore = new MemoryTradeSettingsStore(agents, () => now);
  const intents = new MemoryTradeIntentStore(() => now);
  const journal = new MemoryExecutionJournal(() => now);
  const spendCapLimitWei = input.spendCapLimitWei ?? 1_000n * 10n ** 18n;
  const spec = {
    allowedCalls: [
      { to: TOKEN, selector: "approve(address,uint256)" },
      { to: USDT_56, selector: "approve(address,uint256)" },
      { to: USDT_56, selector: "transfer(address,uint256)" },
      // L8: the real policy constant, not a copied literal, so a selector
      // change would fail this harness instead of silently agreeing with it.
      ...(input.guardGranted === true ? [{ to: FLASH_TAKER, selector: TRADFI_GUARD_SWAP_SELECTOR }] : []),
    ],
    spendCaps: [{ token: USDT_56, limit: spendCapLimitWei, period: "day" as const },
      { token: TOKEN, limit: 10n ** 30n, period: "day" as const }],
    expiresAt: Math.floor(now / 1_000) + 604_800,
  };
  const agent = await agents.createAgent({
    id: "agent-a", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: input.status ?? "armed",
    sessionFacts: {
      spec,
      permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }),
      publicKey: `0x02${"33".repeat(32)}` as Hex,
      expiry: spec.expiresAt,
    },
  });
  const value = input.settings ?? scheduleSettings();
  await settingsStore.put({ agentId: "agent-a", ownerAddress: OWNER, params: value, digest: tradeSettingsDigest(value) });
  let usdtBalance = input.usdtBalanceWei ?? 1_000n * 10n ** 18n;
  const spent = input.spentWei ?? 0n;
  const calls: Array<{ readonly side: "buy" | "sell"; readonly token: Address }> = [];
  let receiptCounter = 0;
  const executor = input.executor ?? {
    async execute(request) {
      calls.push({ side: request.request.side, token: request.request.token });
      usdtBalance -= request.request.amountWei;
      receiptCounter += 1;
      return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const, transactionHash: HASH },
        fill: { side: "buy" as const, entryWei: request.request.amountWei, tokenAmount: request.request.quotedOutWei, fillStatus: "verified" as const,
          verifiedEntryAtomic: request.request.amountWei, receiptOwnershipKey: fakeReceiptOwnershipKey(receiptCounter) }, meta: {} };
    },
  };
  const nativeCost = input.nativeCostUsdtAtomic === undefined ? 1_000_000_000_000n : input.nativeCostUsdtAtomic;
  const deps: TradeWorkerDeps = {
    platformFeeBps: input.platformFeeBps ?? 0,
    ...(input.noAggregatorGuard === true ? {} : { aggregatorGuard: FLASH_TAKER }),
    agentStore: agents, settingsStore, positions, intents,
    // No `markCommitted`: this fixture's fake executor never writes a real
    // journal row, and the schedule cycle only needs `sumPendingQuoteSpendSince`.
    journal: { get: journal.get.bind(journal), async sumPendingQuoteSpendSince() { return 0n; } },
    dataPlane: input.dataPlane ?? scheduleDataPlane(),
    provider: {
      async getTokenBalance() { return usdtBalance; },
      async readSpendInfos(): Promise<readonly SpendInfoReading[]> {
        return input.spendInfos ?? [{ token: USDT_56, period: "day", periodCode: 1, limitWei: spendCapLimitWei, currentSpentWei: spent }];
      },
      async getTokenMetadata() { return { decimals: 18, symbol: "NVDAB" }; },
    },
    // The schedule cycle must never call the LLM; make any call an immediate failure.
    llmFor: () => ({ async complete() { throw new Error("the schedule cycle must never call the LLM"); } }),
    executor, executorDeps: {}, rpcUrls: [],
    readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN.toLowerCase()]) },
    routeReader: input.routeReader ?? quoteReader(),
    forbiddenAddresses: () => new Set<string>(),
    executionIdentity: () => ({ idempotencyKey: HASH, paramsHash: HASH }),
    async tradfiNativeCostUsdtAtomic() { return nativeCost; },
    async recoverFill(intent) {
      return { side: "buy", entryWei: intent.entryWei ?? intent.amountWei, tokenAmount: 100n, fillStatus: "verified" };
    },
    now: () => now,
  };
  return { agents, positions, settingsStore, intents, journal, agent, deps, calls, usdtBalanceOf: () => usdtBalance };
}

describe("schedule buy worker cycle", () => {
  it("buys the anchor slot without ever touching the LLM or the exit machinery", async () => {
    const h = await scheduleHarness({});
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "entered");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.side, "buy");
    assert.equal(h.calls[0]?.token.toLowerCase(), TOKEN.toLowerCase());
    const [intent] = await h.intents.listSchedule(OWNER, "agent-a");
    assert.equal(intent?.scheduleSlot, 0);
    assert.equal(intent?.settlementAsset, "USDT");
    assert.equal(intent?.entryWei, 10_000_000_000_000_000_000n);
    assert.equal(intent?.amountWei, 10_000_000_000_000_000_000n);
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(run?.candidates, 1);
    assert.match(run?.reason ?? "", /^entered;/u);
    assert.equal((await h.positions.listOpen(OWNER, "agent-a")).length, 1);
  });

  it("carries the fee-inclusive reservation as entryWei when a platform fee is configured", async () => {
    const h = await scheduleHarness({});
    await runTradeWorkerOnce({ ...h.deps, platformFeeBps: 500 });
    const [intent] = await h.intents.listSchedule(OWNER, "agent-a");
    // amount stays the signed entryWei; the RESERVATION (entryWei column) adds the 5% fee.
    assert.equal(intent?.amountWei, 10_000_000_000_000_000_000n);
    assert.equal(intent?.entryWei, 10_500_000_000_000_000_000n);
    assert.equal(intent?.platformFeeAtomic, 500_000_000_000_000_000n);
  });

  it("Auto DCA's no-fee ruling (2026-09-25) leaves a Schedule buy's fee: its priced batch still transfers USDT to the treasury", async () => {
    const h = await scheduleHarness({});
    const treasury = getAddress("0x4444444444444444444444444444444444444444");
    const priced: (readonly { readonly to: Address; readonly data?: Hex }[])[] = [];
    await runTradeWorkerOnce({ ...h.deps, platformFeeBps: 500, platformFeeTreasury: treasury,
      async tradfiNativeCostUsdtAtomic(request) { priced.push(request.calls); return 1_000_000_000_000n; } });
    assert.ok(priced.length > 0 && priced.every((calls) => calls.some((call) => call.to.toLowerCase() === USDT_56.toLowerCase()
      && call.data?.toLowerCase().startsWith("0xa9059cbb") === true && call.data.toLowerCase().includes(treasury.slice(2).toLowerCase()))));
  });

  it("creates exactly one intent per slot across repeated ticks, and a rollback frees it for the next tick", async t => {
    t.mock.method(Date, "now", () => ANCHOR);
    let fail = false;
    let receipts = 0;
    const h = await scheduleHarness({
      executor: {
        async execute(request) {
            if (fail) return { kind: "rolled-back", code: "SIMULATION_FAILED", meta: { deniedBy: "venue" } };
          receipts += 1;
          return { kind: "committed", receipt: { status: "CONFIRMED", transactionHash: HASH },
            fill: { side: "buy", entryWei: request.request.amountWei, tokenAmount: request.request.quotedOutWei, fillStatus: "verified",
              verifiedEntryAtomic: request.request.amountWei, receiptOwnershipKey: fakeReceiptOwnershipKey(receipts) }, meta: {} };
        },
      },
    });
    fail = true;
    const first = await runTradeWorkerOnce(h.deps);
      assert.equal(first.outcomes[0]?.reason, "SIMULATION_FAILED");
    assert.equal((await h.intents.listSchedule(OWNER, "agent-a")).length, 0, "a rolled-back buy leaves the slot open");
    const second = await runTradeWorkerOnce(h.deps);
      assert.equal(second.outcomes[0]?.reason, "SIMULATION_FAILED", "the same untaken slot is retried on the next tick");
    fail = false;
    const third = await runTradeWorkerOnce(h.deps);
    assert.equal(third.outcomes[0]?.reason, "entered");
    assert.deepEqual((await h.intents.listSchedule(OWNER, "agent-a")).map((row) => row.scheduleSlot), [0]);
    // Same slot (no clock movement): the fourth tick must not create a second intent.
    const fourth = await runTradeWorkerOnce(h.deps);
    assert.equal(fourth.outcomes[0]?.reason, "schedule-slot-filled");
    assert.equal((await h.intents.listSchedule(OWNER, "agent-a")).length, 1);
  });

  it("dry-run never creates an intent or spends money", async () => {
    const h = await scheduleHarness({});
    const report = await runTradeWorkerOnce(h.deps, { dryRun: true });
    assert.equal(report.outcomes[0]?.reason, "dry-run");
    assert.equal(h.calls.length, 0);
    assert.equal((await h.intents.listSchedule(OWNER, "agent-a")).length, 0);
    assert.equal(h.usdtBalanceOf(), 1_000n * 10n ** 18n);
  });

  it("does not process a paused agent", async () => {
    const h = await scheduleHarness({ status: "paused" });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes.length, 0);
    assert.equal(h.calls.length, 0);
  });

  it("the fenced schedule_slot_taken denial fires when a slot row appears between the pre-check and the fence", async () => {
    const h = await scheduleHarness({});
    const settingsStore = new Proxy(h.settingsStore, {
      get(target, property, receiver) {
        if (property !== "withEntryFence") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (owner: Address, agentId: string, fn: (sql: SqlClient | undefined) => Promise<unknown>) => {
          // A race: another writer takes slot 0 right before this fence runs.
          await h.intents.create({ decisionId: "racer", idempotencyKey: HASH, agentId, ownerAddress: owner, side: "buy",
            token: TOKEN, route: { hops: [], fees: [] }, amountWei: 1n, entryWei: 1n, positionId: "racer", closeReason: null, scheduleSlot: 0 });
          return target.withEntryFence(owner, agentId, fn);
        };
      },
    }) as typeof h.settingsStore;
    const report = await runTradeWorkerOnce({ ...h.deps, settingsStore });
    assert.equal(report.outcomes[0]?.reason, "schedule_slot_taken");
    assert.equal(h.calls.length, 0);
  });

  it("R2.8: an owner edit landing between the pre-check and the fence denies the buy with settings_changed", async () => {
    const h = await scheduleHarness({});
    const settingsStore = new Proxy(h.settingsStore, {
      get(target, property, receiver) {
        if (property !== "withEntryFence") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (owner: Address, agentId: string, fn: (sql: SqlClient | undefined) => Promise<unknown>) => {
          // A race: the owner tightens the premium ceiling right before this fence runs.
          const edited = scheduleSettings({ scheduleMaxPremiumBps: 50 });
          await target.put({ agentId, ownerAddress: owner, params: edited, digest: tradeSettingsDigest(edited) });
          return target.withEntryFence(owner, agentId, fn);
        };
      },
    }) as typeof h.settingsStore;
    const report = await runTradeWorkerOnce({ ...h.deps, settingsStore });
    assert.equal(report.outcomes[0]?.reason, "settings_changed");
    assert.equal(h.calls.length, 0);
  });

  it("every §2.2 refusal reason is reachable", async () => {
    const cases: ReadonlyArray<{ readonly label: string; readonly build: () => Promise<Awaited<ReturnType<typeof scheduleHarness>>>; readonly reason: string }> = [
      { label: "schedule-token-not-granted", reason: "schedule-token-not-granted",
        build: () => scheduleHarness({ settings: scheduleSettings({ scheduleToken: getAddress("0x9999999999999999999999999999999999999999").toLowerCase() }) }) },
      { label: "schedule-not-started", reason: "schedule-not-started",
        build: () => scheduleHarness({ settings: scheduleSettings({ scheduleFirstAtSec: Math.floor(ANCHOR / 1_000) + 3_600 }) }) },
      // R2.11: six reasons the audit found unexercised.
      { label: "schedule-pending-intent", reason: "schedule-pending-intent",
        build: async () => {
          const h = await scheduleHarness({});
          // A PENDING journal row (no txHash yet) so the sweep's own reconcile step neither
          // rolls this back (no journal ⇒ rolled back) nor projects it (kind !== COMMITTED) —
          // it stays genuinely unsettled. Not tied to any slot, so the anchor slot's own
          // ledger check stays untaken.
          const key = `0x${"aa".repeat(32)}` as Hex;
          await h.journal.begin({ idempotencyKey: key, agentId: "agent-a", ownerAddress: OWNER, kind: "trade" });
          await h.intents.create({ decisionId: "unsettled-buy", idempotencyKey: key, agentId: "agent-a", ownerAddress: OWNER,
            side: "buy", token: TOKEN, route: { hops: [], fees: [] }, amountWei: 1n, entryWei: 1n, positionId: "unsettled-buy", closeReason: null, scheduleSlot: null });
          return h;
        } },
      { label: "schedule-market-closed", reason: "schedule-market-closed",
        build: () => scheduleHarness({ settings: scheduleSettings({ scheduleMarketHoursOnly: true }),
          dataPlane: scheduleDataPlane({ fact: rwaFact({ marketStatus: "closed" }) }) }) },
      { label: "data-plane-unavailable", reason: "data-plane-unavailable",
        build: () => scheduleHarness({ dataPlane: { ...scheduleDataPlane(), async universe() { throw new Error("data plane unavailable"); } } }) },
      { label: "schedule-rwa-unavailable", reason: "schedule-rwa-unavailable",
        // A universe read that SUCCEEDS but returns no row for the scheduled token (snapshot.available
        // stays true, unlike data-plane-unavailable above, which fails the read itself).
        build: () => scheduleHarness({ dataPlane: { ...scheduleDataPlane(), async universe() { return []; } } }) },
      { label: "schedule-issuer-not-trading", reason: "schedule-issuer-not-trading",
        build: () => scheduleHarness({ dataPlane: scheduleDataPlane({ fact: rwaFact({ openState: false }) }) }) },
      // R3.7 (N7): a stale-venue fact no longer refuses venue-stale after C4's
      // `allowVenueMissing: true` — it falls back to `fact.premiumBps` like any
      // other venue-missing candidate. Covered instead by the deferred-premium
      // cases in test/tradfiAggregatorActivation.test.ts.
      { label: "schedule-premium-unknown", reason: "schedule-premium-unknown",
        // A fresh admitted venue (hasFreshVenue true) but no reference price to compare it against.
        build: () => scheduleHarness({ dataPlane: scheduleDataPlane({ fact: rwaFact({ referencePriceUsd: null }) }) }) },
      { label: "schedule-premium-too-high", reason: "schedule-premium-too-high",
        build: () => scheduleHarness({ dataPlane: scheduleDataPlane({ fact: rwaFact({ onchainPriceUsd: 20, venues: [venueRow({ priceUsd: 20 })] }) }) }) },
      { label: "schedule-rwa-stale", reason: "schedule-rwa-stale",
        build: () => scheduleHarness({ dataPlane: scheduleDataPlane({ fact: rwaFact({ staleness: "stale" }) }) }) },
      { label: "schedule-cash-low", reason: "schedule-cash-low",
        build: () => scheduleHarness({ usdtBalanceWei: 1n }) },
      { label: "schedule-cap-exhausted", reason: "schedule-cap-exhausted",
        build: () => scheduleHarness({ spentWei: 999n * 10n ** 18n }) },
      // R2.9 (LOW-6): the meter itself unreadable (no matching row), distinct from a readable-but-exhausted meter.
      { label: "quote-meter-unavailable", reason: "quote-meter-unavailable",
        build: () => scheduleHarness({ spendInfos: [] }) },
      { label: "schedule-no-route", reason: "schedule-no-route",
        build: () => scheduleHarness({ routeReader: {
          async quoteV2() { throw new Error("no route"); }, async quoteV3Single() { throw new Error("no route"); },
          async quoteV3Path() { throw new Error("no route"); }, async quoteUniV3Single() { throw new Error("no route"); },
          async quoteUniV3Path() { throw new Error("no route"); } } }) },
      { label: "cost-unavailable", reason: "cost-unavailable", build: () => scheduleHarness({ dataPlane: {
        ...scheduleDataPlane(),
        // A stale USDT price fact (older than freshTokenUsdFact's window) makes settlementUsd unreadable.
        async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({ address, symbol: "USDT", priceUsd: 1,
          marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: Date.now() - 3_600_000, staleness: "fresh" })); },
      } }) },
      { label: "schedule-finished:budget", reason: "schedule-finished:budget",
        // capitalQuoteWei (10 USDT) covers entryWei exactly but not the 5% fee-inclusive reservation (10.5 USDT).
        build: () => scheduleHarness({ platformFeeBps: 500, settings: scheduleSettings({ capitalQuoteWei: "10000000000000000000" }) }) },
      { label: "schedule-finished:runs", reason: "schedule-finished:runs",
        build: async () => {
          const h = await scheduleHarness({ settings: scheduleSettings({ scheduleEndKind: "runs", scheduleEndRuns: 1 }) });
          // One prior, SETTLED fill already satisfies the one-run finish rule.
          // Projected (not pending), or the worker's own reconcile step would
          // roll it back for having no journal evidence and free the slot.
          await h.intents.create({ decisionId: "prior-run", idempotencyKey: HASH, agentId: "agent-a", ownerAddress: OWNER,
            side: "buy", token: TOKEN, route: { hops: [], fees: [] }, amountWei: 10n ** 19n, entryWei: 10n ** 19n,
            positionId: "prior-run", closeReason: null, scheduleSlot: 0 });
          await h.intents.markProjected(OWNER, "agent-a", "prior-run");
          return h;
        } },
      { label: "schedule-finished:date", reason: "schedule-finished:date",
        build: () => scheduleHarness({ settings: scheduleSettings({ scheduleEndKind: "date", scheduleEndAtSec: Math.floor(ANCHOR / 1_000) - 1 }) }) },
    ];
    for (const { label, build, reason } of cases) {
      const h = await build();
      const report = await runTradeWorkerOnce(h.deps);
      assert.equal(report.outcomes[0]?.reason, reason, label);
      assert.equal(h.calls.length, 0, label);
    }
  });

  it("takes the Binance offer only when a fake Flash quote ranks better and the guard is granted", async () => {
    const flashQuote: TradfiFlashQuote = {
      version: "tradfi-binance-flash-v1", tokenIn: USDT_56, tokenOut: TOKEN, value: "0", feeAmountAtomic: "0", feeToken: null,
      // `0xad43f73d` is the guard-router's own required calldata selector (guard.ts's normalizedData).
      taker: FLASH_TAKER, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", chainId: 56, quotedOutAtomic: "9999999999999999999999", minOutAtomic: "9899999999999999999999",
      amountInAtomic: "10000000000000000000", observedAt: ANCHOR, expiresAt: ANCHOR + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
    };
    // The direct AMM route quotes low (1:1); Binance quotes far better and should win when granted.
    const direct = quoteReader(async (_path, amount) => amount);
    const withGuard = await scheduleHarness({ guardGranted: true, routeReader: direct,
      dataPlane: scheduleDataPlane({ binanceQuoteAndSwap: async () => flashQuote }) });
    const grantedReport = await runTradeWorkerOnce(withGuard.deps);
    assert.equal(grantedReport.outcomes[0]?.reason, "entered");
    const [grantedIntent] = await withGuard.intents.listSchedule(OWNER, "agent-a");
    assert.equal(grantedIntent?.venue, "pancake_v3", "an aggregator fill is recorded on the pancake_v3 venue slot");
    assert.equal(grantedIntent?.quotedOutAtomic, 9_999_999_999_999_999_999_999n);

    const withoutGuard = await scheduleHarness({ guardGranted: false, routeReader: direct,
      dataPlane: scheduleDataPlane({ binanceQuoteAndSwap: async () => flashQuote }) });
    const ungatedReport = await runTradeWorkerOnce(withoutGuard.deps);
    assert.equal(ungatedReport.outcomes[0]?.reason, "entered");
    const [directIntent] = await withoutGuard.intents.listSchedule(OWNER, "agent-a");
    assert.equal(directIntent?.quotedOutAtomic, 10_000_000_000_000_000_000n, "the direct 1:1 quote wins when the guard capability is not granted");

    const bothFail = await scheduleHarness({ guardGranted: false,
      routeReader: { async quoteV2() { throw new Error("no route"); }, async quoteV3Single() { throw new Error("no route"); },
        async quoteV3Path() { throw new Error("no route"); }, async quoteUniV3Single() { throw new Error("no route"); }, async quoteUniV3Path() { throw new Error("no route"); } },
      dataPlane: scheduleDataPlane({ binanceQuoteAndSwap: async () => { throw new Error("Flash unavailable"); } }) });
    const bothFailReport = await runTradeWorkerOnce(bothFail.deps);
    assert.equal(bothFailReport.outcomes[0]?.reason, "schedule-no-route");
  });

  it("AUDIT HIGH-2 (G1 buy site): Binance wins even when direct's net is better by more than 2% — kills a restored net-price comparison", async () => {
    // Both quotes are the SAME 1:1 ratio (so the premium gate treats them
    // identically); only the native cost differs. Direct costs nothing, the
    // guard call costs 1 USDT — 10% of the 10 USDT entry, far past the 2%
    // preference band the operator explicitly rejected. Under G1, Binance
    // must still win because it is USABLE; a reintroduced net-price
    // comparison (mutation M03) would pick direct instead.
    const flashQuote: TradfiFlashQuote = {
      version: "tradfi-binance-flash-v1", tokenIn: USDT_56, tokenOut: TOKEN, value: "0", feeAmountAtomic: "0", feeToken: null,
      taker: FLASH_TAKER, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", chainId: 56, quotedOutAtomic: "10000000000000000000", minOutAtomic: "9900000000000000000",
      amountInAtomic: "10000000000000000000", observedAt: ANCHOR, expiresAt: ANCHOR + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
    };
    const flatDirect: RouteQuoteReader = {
      async quoteV2(_path, amount) { return amount; },
      async quoteV3Single(_tokenIn, _tokenOut, _fee, amount) { return amount; },
      async quoteV3Path(_path, amount) { return amount; },
      async quoteUniV3Single(_tokenIn, _tokenOut, _fee, amount) { return amount; },
      async quoteUniV3Path(_path, amount) { return amount; },
    };
    const differentiatedCost = async (input: { readonly calls: readonly { readonly to: Address }[] }): Promise<bigint | null> =>
      input.calls.some((call) => call.to.toLowerCase() === FLASH_TAKER.toLowerCase()) ? 1_000_000_000_000_000_000n : 0n;
    const h = await scheduleHarness({ guardGranted: true, routeReader: flatDirect,
      dataPlane: scheduleDataPlane({ binanceQuoteAndSwap: async () => flashQuote }) });
    const report = await runTradeWorkerOnce({ ...h.deps, tradfiNativeCostUsdtAtomic: differentiatedCost });
    assert.equal(report.outcomes[0]?.reason, "entered");
    const [intent] = await h.intents.listSchedule(OWNER, "agent-a");
    assert.equal(intent?.venue, "pancake_v3", "Binance must win despite direct's better net — no net-price ranking at the buy site");
    assert.equal(intent?.quotedOutAtomic, 10_000_000_000_000_000_000n);
  });

  it("R2.6/R3.3: a granted session rule alone makes no Flash call without the worker's own configured guard", async () => {
    let flashCalls = 0;
    const flashQuote: TradfiFlashQuote = {
      version: "tradfi-binance-flash-v1", tokenIn: USDT_56, tokenOut: TOKEN, value: "0", feeAmountAtomic: "0", feeToken: null,
      taker: FLASH_TAKER, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", chainId: 56, quotedOutAtomic: "9999999999999999999999", minOutAtomic: "9899999999999999999999",
      amountInAtomic: "10000000000000000000", observedAt: ANCHOR, expiresAt: ANCHOR + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
    };
    const h = await scheduleHarness({ guardGranted: true, noAggregatorGuard: true,
      dataPlane: scheduleDataPlane({ binanceQuoteAndSwap: async () => { flashCalls += 1; return flashQuote; } }) });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "entered");
    assert.equal(flashCalls, 0, "no configured guard must mean no Flash call at all, even though the session grants the rule");
    const [intent] = await h.intents.listSchedule(OWNER, "agent-a");
    assert.equal(intent?.venue, "pancake_v2", "the direct route fills since the aggregator was never consulted");
  });

  it("does not move stored slots when sessionFacts is replaced by a renewal", async () => {
    let nowRef = ANCHOR;
    const h = await scheduleHarness({ dataPlane: { ...scheduleDataPlane(),
      // A venue/RWA fact fresh as of whichever tick is running, so the second
      // tick (two hours later) is not refused for a stale on-chain reading.
      async universe(lane) {
        if (lane !== "bstocks") return [];
        const fact = rwaFact({ venues: [venueRow({ asOf: nowRef })] });
        return [{ address: TOKEN, symbol: "NVDAB", lane: "bstocks", source: "fixture", rwa: fact, ...(fact.venues === undefined ? {} : { venues: fact.venues }) }];
      } } });
    await runTradeWorkerOnce(h.deps);
    const [before] = await h.intents.listSchedule(OWNER, "agent-a");
    assert.equal(before?.scheduleSlot, 0);
    // Renewal: a NEW session generation with a later grantedAtSec, same spec shape.
    const renewed = await h.agents.getAgentById("agent-a");
    assert.ok(renewed?.sessionFacts);
    await h.agents.updateAgentSessionFacts(OWNER, "agent-a", { ...renewed.sessionFacts, grantedAtSec: Math.floor((ANCHOR + 2 * HOUR) / 1_000) });
    nowRef = ANCHOR + 2 * HOUR;
    const afterRenewal = await runTradeWorkerOnce({ ...h.deps, now: () => ANCHOR + 2 * HOUR });
    // The slot for "now" is 2 (two hours after the anchor at a 1h interval); the
    // renewal must not have renumbered slot 0, and slot 2 is a fresh buy, not a duplicate of it.
    assert.equal(afterRenewal.outcomes[0]?.reason, "entered");
    const after = await h.intents.listSchedule(OWNER, "agent-a");
    assert.deepEqual(after.map((row) => row.scheduleSlot).sort((a, b) => (a ?? 0) - (b ?? 0)), [0, 2]);
  });

  it("R2.4(a): the owner's scheduleMaxPremiumBps ceiling gates both the reference-level and execution-size premium checks", async () => {
    // Reference level: rwaPremiumBps from the venue snapshot is exactly +100 bps (onchain 10.1 vs fair 10 * 1).
    const referencePremiumFact = rwaFact({ onchainPriceUsd: 10.1, venues: [venueRow({ priceUsd: 10.1 })] });
    const tight = await scheduleHarness({ settings: scheduleSettings({ scheduleMaxPremiumBps: 50 }), dataPlane: scheduleDataPlane({ fact: referencePremiumFact }) });
    const tightReport = await runTradeWorkerOnce(tight.deps);
    assert.equal(tightReport.outcomes[0]?.reason, "schedule-premium-too-high", "reference level: refused under a 50 bps owner ceiling");

    const loose = await scheduleHarness({ settings: scheduleSettings({ scheduleMaxPremiumBps: 150 }), dataPlane: scheduleDataPlane({ fact: referencePremiumFact }) });
    const looseReport = await runTradeWorkerOnce(loose.deps);
    assert.equal(looseReport.outcomes[0]?.reason, "entered", "reference level: accepted under a 150 bps owner ceiling");

    // Execution size: the reference-level premium is 0 bps (default fact); the QUOTE itself implies +100 bps.
    const executionQuoteReader = quoteReader(async () => 990_099_009_900_990_080n);
    const tightExecution = await scheduleHarness({ settings: scheduleSettings({ scheduleMaxPremiumBps: 50 }), routeReader: executionQuoteReader });
    const tightExecutionReport = await runTradeWorkerOnce(tightExecution.deps);
    // R2.5: an execution-size premium breach is schedule-no-route, never schedule-premium-too-high.
    assert.equal(tightExecutionReport.outcomes[0]?.reason, "schedule-no-route", "execution size: refused under a 50 bps owner ceiling");

    const looseExecution = await scheduleHarness({ settings: scheduleSettings({ scheduleMaxPremiumBps: 150 }), routeReader: executionQuoteReader });
    const looseExecutionReport = await runTradeWorkerOnce(looseExecution.deps);
    assert.equal(looseExecutionReport.outcomes[0]?.reason, "entered", "execution size: accepted under a 150 bps owner ceiling");
  });

  it("R2.4(b): a second tick after a fill never calls the LLM, fires no exit-llm event and attempts no sell", async () => {
    const h = await scheduleHarness({});
    const first = await runTradeWorkerOnce(h.deps);
    assert.equal(first.outcomes[0]?.reason, "entered");
    assert.equal((await h.positions.listOpen(OWNER, "agent-a")).length, 1);

    let llmCalls = 0;
    const second = await runTradeWorkerOnce({
      ...h.deps,
      // A COUNTING spy, not a throwing stub: a throw would be swallowed by the
      // exit path's own catch and falsely look like "the LLM was never reached".
      llmFor: () => ({ async complete() { llmCalls += 1; return { content: JSON.stringify([{ index: 0, exit: false, reason: "hold" }]), model: "test-model" }; } }),
    });
    assert.equal(second.outcomes[0]?.reason, "schedule-slot-filled");
    assert.equal(llmCalls, 0, "the schedule cycle must never call the LLM for exits");
    const [run] = await h.positions.listRuns(OWNER, "agent-a", 1);
    assert.equal(run?.events?.some((event) => event.stage === "exit-llm") ?? false, false, "no exit-llm stage event may fire for a schedule agent");
    assert.equal(h.calls.filter((call) => call.side === "sell").length, 0, "no sell request may be made for a schedule agent");
  });

  it("L2/C4/R2.1: a production-shaped pool-less fact (premiumBps: null, venues: []) buys via the guard", async () => {
    // Both the live universe's zero-venue rows AND `rwaEntryVerdict`'s own
    // "premium:deferred" precondition need referencePriceUsd/tokenToShareRatio,
    // which `rwaFact()`'s defaults already carry (10 and 1) — only the venue
    // and premium fields are overridden to the actually-measured shape.
    const fact = rwaFact({ venues: [], premiumBps: null });
    const flashQuote: TradfiFlashQuote = {
      version: "tradfi-binance-flash-v1", tokenIn: USDT_56, tokenOut: TOKEN, value: "0", feeAmountAtomic: "0", feeToken: null,
      taker: FLASH_TAKER, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", chainId: 56, quotedOutAtomic: "10000000000000000000", minOutAtomic: "9700000000000000000",
      amountInAtomic: "10000000000000000000", observedAt: ANCHOR, expiresAt: ANCHOR + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
    };
    const throwingReader: RouteQuoteReader = {
      async quoteV2() { throw new Error("no route"); }, async quoteV3Single() { throw new Error("no route"); },
      async quoteV3Path() { throw new Error("no route"); }, async quoteUniV3Single() { throw new Error("no route"); }, async quoteUniV3Path() { throw new Error("no route"); },
    };
    const h = await scheduleHarness({ guardGranted: true, routeReader: throwingReader,
      dataPlane: scheduleDataPlane({ fact, binanceQuoteAndSwap: async () => flashQuote }) });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "entered", JSON.stringify(report.outcomes[0]));
    const [intent] = await h.intents.listSchedule(OWNER, "agent-a");
    assert.equal(intent?.venue, "pancake_v3", "a pool-less token can only ever fill through the guard");
  });

  it("L2/R2.4: a 500 bps schedule slot buys via Flash with the request itself clamped to 300", async () => {
    let requestedSlippageBps: number | undefined;
    const flashQuote: TradfiFlashQuote = {
      version: "tradfi-binance-flash-v1", tokenIn: USDT_56, tokenOut: TOKEN, value: "0", feeAmountAtomic: "0", feeToken: null,
      taker: FLASH_TAKER, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
      calldata: "0xad43f73d", chainId: 56, quotedOutAtomic: "9999999999999999999999", minOutAtomic: "9899999999999999999999",
      amountInAtomic: "10000000000000000000", observedAt: ANCHOR, expiresAt: ANCHOR + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
    };
    // The direct AMM route quotes low (1:1) so Binance's better offer wins —
    // the owner's OWN 500 bps setting must still reach the request as 300.
    const direct = quoteReader(async (_path, amount) => amount);
    const h = await scheduleHarness({ guardGranted: true, routeReader: direct, settings: scheduleSettings({ slippageBps: 500 }),
      dataPlane: scheduleDataPlane({ binanceQuoteAndSwap: async (request) => { requestedSlippageBps = request.slippageBps; return flashQuote; } }) });
    const report = await runTradeWorkerOnce(h.deps);
    assert.equal(report.outcomes[0]?.reason, "entered", JSON.stringify(report.outcomes[0]));
    const [intent] = await h.intents.listSchedule(OWNER, "agent-a");
    assert.equal(intent?.venue, "pancake_v3", "Binance's better offer must still win at the owner's wider slippage");
    assert.equal(requestedSlippageBps, 300, "the Flash request itself must carry the R2.4 clamp, not the owner's raw 500 bps");
  });

  it("a finished schedule stands down before the gas gate and the data plane, and records the transition once", async () => {
    // capitalQuoteWei covers entryWei but not the 5% fee-inclusive reservation: finished:budget from the first tick.
    const h = await scheduleHarness({ platformFeeBps: 500, settings: scheduleSettings({ capitalQuoteWei: "10000000000000000000" }) });
    let reads = 0;
    const trap = async (): Promise<never> => { reads += 1; throw new Error("a finished schedule must not read this"); };
    const deps: TradeWorkerDeps = { ...h.deps, walletNativeBalance: trap,
      dataPlane: { universe: trap, tokensBatch: trap, eligibilityBatch: trap, security: trap },
      provider: { getTokenBalance: trap, readSpendInfos: trap, getTokenMetadata: trap } };
    for (let tick = 0; tick < 3; tick += 1) {
      const report = await runTradeWorkerOnce(deps);
      assert.equal(report.outcomes[0]?.reason, "schedule-finished:budget");
    }
    assert.equal(reads, 0);
    const runs = await h.positions.listRuns(OWNER, "agent-a", 10);
    assert.equal(runs.length, 1, "one durable row on the transition, not one per cycle");
    assert.match(runs[0]?.reason ?? "", /^schedule-finished:budget;/u);
  });

  it("a dry-run finish row does not suppress the live transition row", async () => {
    const base = await scheduleHarness({ platformFeeBps: 500, settings: scheduleSettings({ capitalQuoteWei: "10000000000000000000" }) });
    let clock = ANCHOR;
    const positions = new MemoryTradePositionStore(() => (clock += 1_000));
    const deps = { ...base.deps, positions };
    await runTradeWorkerOnce(deps, { dryRun: true });
    await runTradeWorkerOnce(deps);
    await runTradeWorkerOnce(deps);
    const runs = await positions.listRuns(OWNER, "agent-a", 10);
    assert.deepEqual(runs.map((run) => run.dryRun), [false, true]);
  });

  it("an owner edit that reopens a finished schedule buys on the next tick, and the next finish is recorded again", async () => {
    const base = await scheduleHarness({ platformFeeBps: 500, settings: scheduleSettings({ capitalQuoteWei: "10000000000000000000" }) });
    // Run rows order by createdAt, then a random id: a ticking clock keeps "latest" deterministic.
    let clock = ANCHOR;
    const positions = new MemoryTradePositionStore(() => (clock += 1_000));
    const h = { ...base, positions, deps: { ...base.deps, positions } };
    assert.equal((await runTradeWorkerOnce(h.deps)).outcomes[0]?.reason, "schedule-finished:budget");
    // 20 USDT covers one 10.5 USDT reservation and leaves 9.5: finished again after the buy.
    const reopened = scheduleSettings({ capitalQuoteWei: "20000000000000000000" });
    await h.settingsStore.put({ agentId: "agent-a", ownerAddress: OWNER, params: reopened, digest: tradeSettingsDigest(reopened) });
    assert.equal((await runTradeWorkerOnce(h.deps)).outcomes[0]?.reason, "entered");
    assert.equal(h.calls.length, 1);
    assert.equal((await runTradeWorkerOnce(h.deps)).outcomes[0]?.reason, "schedule-finished:budget");
    assert.equal((await runTradeWorkerOnce(h.deps)).outcomes[0]?.reason, "schedule-finished:budget");
    const reasons = (await h.positions.listRuns(OWNER, "agent-a", 10)).map((run) => run.reason.split(";")[0]);
    assert.deepEqual(reasons, ["schedule-finished:budget", "entered", "schedule-finished:budget"]);
  });
});

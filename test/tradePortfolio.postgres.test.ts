import assert from "node:assert/strict";
import { it } from "node:test";
import { getAddress, type Hex } from "viem";
import { PostgresTradeIntentStore } from "../src/store/tradeIntents.js";
import { PostgresTradeSettingsStore } from "../src/store/tradeSettings.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { validateSessionSpec } from "../src/core/session.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import type { TradeDataPlaneReads, TokenBatchRow, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import { localPostgres } from "./support/localPostgres.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const OTHER = getAddress("0x80106cb3ead06659a5ad19df39d9b4733863b9b0");
const HASH = `0x${"11".repeat(32)}` as Hex;
const UNIT = 10n ** 18n;
const STOCKS = DCA_POOLS_56.slice(0, 2).map((pool) => pool.stock);

function portfolioSettings(): TradeSettings {
  return { name: "Portfolio", executionModel: "tradfi", settlementAsset: "USDT", entryWei: (50n * UNIT).toString(),
    minEntryWei: UNIT.toString(), capitalQuoteWei: (50n * UNIT).toString(), maxOpenPositions: 1, minMarketCapUsd: null,
    maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
    breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null,
    primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, cmcNewsEnabled: false,
    tradeMode: "portfolio", portfolioTokens: STOCKS.map((stock) => stock.toLowerCase()), portfolioWeightsBps: [5000, 5000],
    portfolioDriftBps: 500, portfolioIntervalSec: 86400 };
}

it("portfolio PostgreSQL round-trip enforces leg and receipt uniqueness, immutable proceeds and first-writer checks", async (t) => {
  const local = await localPostgres();
  if (local === null) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
  try {
    const sql = await createPgSqlClient(local.url);
    try {
      const store = await PostgresTradeIntentStore.create(sql);
      const base = { agentId: "portfolio", ownerAddress: OWNER, idempotencyKey: HASH, side: "sell" as const,
        token: TOKEN, route: { hops: [], fees: [] }, amountWei: 1n, entryWei: 0n, positionId: "sale",
        closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" as const };
      await store.create({ ...base, decisionId: "first" });
      await assert.rejects(store.create({ ...base, decisionId: "duplicate" }), /duplicate key/u);
      const competing = await Promise.allSettled([
        store.create({ ...base, agentId: "concurrent", decisionId: "concurrent-a" }),
        store.create({ ...base, agentId: "concurrent", decisionId: "concurrent-b" }),
      ]);
      assert.deepEqual(competing.map((row) => row.status).sort(), ["fulfilled", "rejected"]);
      await store.create({ ...base, decisionId: "second", token: OTHER });
      assert.deepEqual((await store.listPortfolio(OWNER, "portfolio")).map((row) => row.decisionId), ["first", "second"]);
      const claims = await Promise.all([
        store.setPortfolioProceeds(OWNER, "portfolio", "first", 5n, "receipt"),
        store.setPortfolioProceeds(OWNER, "portfolio", "second", 5n, "receipt"),
      ]);
      assert.deepEqual(claims.map((row) => row.outcome).sort(), ["conflict", "credited"]);
      assert.equal((await store.listPortfolio(OWNER, "portfolio")).reduce((sum, row) => sum + (row.portfolioProceedsAtomic ?? 0n), 0n), 5n);
      const winner = claims[0]!.outcome === "credited" ? "first" : "second";
      assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", winner, 0n, null)).outcome, "settled");
      assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", winner, 5n, "receipt")).outcome, "same");
      assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", winner, -1n, null)).outcome, "invalid");
      assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", winner, 1n, null)).outcome, "invalid");
      assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", winner, 0n, "receipt")).outcome, "invalid");
      assert.equal((await store.setPortfolioProceeds(OTHER, "portfolio", winner, 1n, "other")).outcome, "invalid");
      for (const first of ["credit", "seal"] as const) {
        const id = `seal-${first}`;
        await store.create({ ...base, agentId: id, decisionId: id });
        if (first === "credit") {
          assert.equal((await store.setPortfolioProceeds(OWNER, id, id, 5n, `proof-${id}`)).outcome, "credited");
          assert.equal((await store.setPortfolioProceeds(OWNER, id, id, 0n, null)).outcome, "settled");
          assert.equal((await store.get(OWNER, id, id))?.portfolioProceedsAtomic, 5n);
        } else {
          assert.equal((await store.setPortfolioProceeds(OWNER, id, id, 0n, null)).outcome, "sealed");
          assert.equal((await store.setPortfolioProceeds(OWNER, id, id, 5n, `proof-${id}`)).outcome, "settled");
          assert.equal((await store.get(OWNER, id, id))?.portfolioProceedsAtomic, 0n);
        }
      }
      const check = { agentId: "portfolio", ownerAddress: OWNER, slot: 0, state: "held" as const, maxDriftBps: 240, valueWei: 50n };
      assert.equal((await store.insertPortfolioCheck(check)).state, "held");
      assert.equal((await store.insertPortfolioCheck({ ...check, state: "rebalancing" })).state, "held");
      assert.equal((await store.insertPortfolioCheck({ ...check, slot: 1, state: "rebalancing" })).state, "rebalancing");
      assert.equal((await store.markPortfolioCheckDone(OWNER, "portfolio", 1))?.state, "done");
      assert.equal((await store.getPortfolioCheck(OWNER, "portfolio", 1))?.state, "done");
      const racers = await Promise.all([
        store.insertPortfolioCheck({ ...check, slot: 2, state: "held" }),
        store.insertPortfolioCheck({ ...check, slot: 2, state: "rebalancing" }),
      ]);
      assert.equal(racers[0]?.state, racers[1]?.state);
      await store.markProjected(OWNER, "portfolio", winner);
      assert.equal((await store.listProjectedV2(OWNER, "portfolio")).length, 0);
      const { portfolioSlot: _slot, ...ordinary } = base;
      for (const [id, slot] of [["explicit-null", null], ["omitted", undefined]] as const) {
        await store.create({ ...ordinary, decisionId: id, ...(slot === undefined ? {} : { portfolioSlot: slot }) });
        assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", id, 1n, `proof-${id}`)).outcome, "invalid");
        await store.markProjected(OWNER, "portfolio", id);
      }
      assert.deepEqual((await store.listProjectedV2(OWNER, "portfolio")).map((row) => row.decisionId), ["explicit-null", "omitted"]);
    } finally { await sql.close(); }
  } finally { await local.close(); }
});

it("portfolio PostgreSQL failed sell and ROLLED_BACK recovery release the fence for Pause and Remove", async (t) => {
  const local = await localPostgres();
  if (local === null) { t.skip("owned disposable PostgreSQL is unavailable"); return; }
  // A regression must fail promptly instead of waiting on its own row lock indefinitely.
  const sql = await createPgSqlClient(`${local.url}?options=-c%20lock_timeout%3D1000`);
  try {
    const settingsStore = await PostgresTradeSettingsStore.create(sql);
    const intents = await PostgresTradeIntentStore.create(sql);
    const now = Date.now();
    const agents = new MemoryAgentStore(null, () => now);
    const positions = new MemoryTradePositionStore(() => now);
    const journal = new MemoryExecutionJournal(() => now);
    const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: getAddress("0x4444444444444444444444444444444444444444"),
      feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 100, asOf: now };
    const rows: UniverseRow[] = STOCKS.map((stock, index) => ({ address: stock, symbol: DCA_POOLS_56[index]!.symbol,
      lane: "bstocks", source: "fixture", venues: [venue], rwa: { platform: "bstock", underlyingTicker: DCA_POOLS_56[index]!.symbol,
        tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: null, reasonCode: "TRADING",
        staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [venue] } }));
    const dataPlane: TradeDataPlaneReads = { async universe(lane) { return lane === "bstocks" ? rows : []; },
      async tokensBatch(addresses) { return addresses.map((address): TokenBatchRow => ({ address, symbol: "USDT", priceUsd: 1,
        marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: Date.now(), staleness: "fresh" })); },
      async eligibilityBatch(addresses) { return addresses.map((address) => ({ address, eligible: true, reason: "binance_rwa", source: "binance-rwa" as const, venue: null })); },
      async security() { return { riskLevel: "ok", flags: [] }; } };
    for (const mode of ["live-failed", "journal-rolled-back"] as const) {
      const id = `pg-${mode}`;
      const spec = { allowedCalls: [USDT_56, ...STOCKS].map((token) => ({ to: token, selector: "approve(address,uint256)" })),
        spendCaps: [USDT_56, ...STOCKS].map((token) => ({ token, limit: 250n * UNIT, period: "day" as const })),
        expiresAt: Math.floor(now / 1_000) + 604800 };
      const agent = await agents.createAgent({ id, ownerAddress: OWNER,
        walletAddress: mode === "live-failed" ? OTHER : getAddress("0x3333333333333333333333333333333333333333"), custodyModel: "passkey", status: "armed",
        sessionFacts: { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }),
          publicKey: `0x02${"33".repeat(32)}` as Hex, expiry: spec.expiresAt } });
      const params = portfolioSettings();
      await settingsStore.put({ agentId: id, ownerAddress: OWNER, params, digest: tradeSettingsDigest(params) });
      const row = await settingsStore.get(OWNER, id);
      assert.ok(row);
      const priorId = `${id}-buy`;
      await intents.create({ agentId: id, ownerAddress: OWNER, decisionId: priorId, idempotencyKey: HASH, side: "buy",
        token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: 40n * UNIT, entryWei: 40n * UNIT,
        positionId: priorId, closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" });
      await intents.markProjected(OWNER, id, priorId);
      const sellId = `${id}-sell`;
      if (mode === "journal-rolled-back") {
        await intents.create({ agentId: id, ownerAddress: OWNER, decisionId: sellId, idempotencyKey: `0x${"22".repeat(32)}` as Hex,
          side: "sell", token: STOCKS[0]!, route: { hops: [], fees: [] }, amountWei: 10n * UNIT, entryWei: 0n,
          positionId: sellId, closeReason: null, portfolioSlot: 1, settlementAsset: "USDT" });
        await journal.begin({ idempotencyKey: `0x${"22".repeat(32)}` as Hex, agentId: id, ownerAddress: OWNER, kind: "trade", decisionId: sellId });
        await journal.markRolledBack(`0x${"22".repeat(32)}` as Hex, "FAILED");
      }
      const workerSettings = { get: settingsStore.get.bind(settingsStore), withEntryFence: settingsStore.withEntryFence.bind(settingsStore),
        async listTradeAgentsForWorker() { return { rows: mode === "live-failed" ? [row] : [], cursor: null, hasMore: false }; },
        async listTradeAgentsForProjection() { return { rows: [row], cursor: null, hasMore: false }; } };
      const deps: TradeWorkerDeps = { portfolioEnabled: true, platformFeeBps: 100, agentStore: agents,
        settingsStore: workerSettings, positions, intents,
        journal: { get: journal.get.bind(journal), async sumPendingQuoteSpendSince() { return 0n; } }, dataPlane,
        provider: { async getTokenBalance({ token }) { return token.toLowerCase() === USDT_56.toLowerCase() ? 10n * UNIT
          : token.toLowerCase() === STOCKS[0]!.toLowerCase() ? 40n * UNIT : 10n * UNIT; },
          async readSpendInfos() { return [{ token: USDT_56, period: "day", periodCode: 1, limitWei: 250n * UNIT, currentSpentWei: 0n }]; },
          async getTokenMetadata() { return { decimals: 18, symbol: "NVDAB" }; } },
        llmFor: () => ({ async complete() { throw new Error("portfolio reached LLM"); } }),
        executor: { async execute() { return { kind: "rolled-back", code: "not-confirmed", meta: {} }; } }, executorDeps: {},
        readiness: { ready: mode === "live-failed", allowlistAvailable: true, bstocksAddresses: new Set(STOCKS.map((stock) => stock.toLowerCase())) },
        rpcUrls: [], routeReader: { async quoteV2(_path, amount) { return amount; }, async quoteV3Single(_in, _out, _fee, amount) { return amount; },
          async quoteV3Path(_path, amount) { return amount; }, async quoteUniV3Single(_in, _out, _fee, amount) { return amount; },
          async quoteUniV3Path(_path, amount) { return amount; } }, forbiddenAddresses: () => new Set(),
        executionIdentity: () => ({ idempotencyKey: `0x${"22".repeat(32)}` as Hex, paramsHash: HASH }),
        async tradfiNativeCostUsdtAtomic() { return 1n; },
        async recoverFill() { return { side: "sell", exitWei: null, fillStatus: "unverified" }; }, now: () => now + 86_400_000 };
      const result = await runTradeWorkerOnce(deps);
      if (mode === "live-failed") assert.equal(result.outcomes[0]?.reason, "not-confirmed");
      const sell = mode === "live-failed" ? (await intents.listPortfolio(OWNER, id)).find((intent) => intent.side === "sell")
        : await intents.get(OWNER, id, sellId);
      assert.equal(sell?.state, "projected", mode);
      assert.equal(sell.portfolioProceedsAtomic, 0n, mode);
      for (const status of ["paused", "revoked"] as const) {
        const stopped = await settingsStore.withEntryFence(OWNER, id, async () => {
          const current = await agents.getAgentById(id);
          assert.ok(current);
          return agents.transitionAgentStatus({ ownerAddress: OWNER, agentId: id, expectedStatus: current.status,
            expectedRowVersion: current.rowVersion, status });
        });
        assert.equal(stopped.kind, "allowed", `${mode}: ${status}`);
        assert.equal((await agents.getAgentById(agent.id))?.status, status);
      }
    }
  } finally { await sql.close(); await local.close(); }
});

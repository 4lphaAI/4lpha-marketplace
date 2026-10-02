import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { PORTFOLIO_DUST_TOKEN_WEI, portfolioStockValue } from "../src/trade/portfolio.js";
import { checkTradfiPortfolioSizing, portfolioMinCapitalWei, tradfiPortfolioNativeReserveWei } from "../src/trade/sizing.js";
import { DEFAULT_TRADE_SETTINGS, DEFAULT_TRADE_SETTINGS_DIGEST, immutableTradeSettingChange, parseTradeSettings, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { MemoryTradeIntentStore, PostgresTradeIntentStore } from "../src/store/tradeIntents.js";
import type { SqlClient } from "../src/store/sql.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { resolvePortfolioEnabled } from "../src/ops/config.js";
import { tradfiV2SwapRefusal } from "../src/trade/execute.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { validateSessionSpec } from "../src/core/session.js";
import { tradeConfig } from "./support/serverHarness.js";
import { PANCAKE_V2_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const TOKENS = DCA_POOLS_56.slice(0, 2).map((pool) => pool.stock.toLowerCase());
const HASH = `0x${"11".repeat(32)}` as Hex;
const ATOMIC = 10n ** 18n;

function settings(patch: Partial<TradeSettings> = {}): TradeSettings {
  return { name: "Portfolio", executionModel: "tradfi", settlementAsset: "USDT", entryWei: (50n * ATOMIC).toString(),
    minEntryWei: ATOMIC.toString(), capitalQuoteWei: (50n * ATOMIC).toString(), maxOpenPositions: 1,
    minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null,
    maxHoldSec: null, breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null,
    skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false,
    cmcNewsEnabled: false, tradeMode: "portfolio", portfolioTokens: TOKENS, portfolioWeightsBps: [5000, 5000],
    portfolioDriftBps: 500, portfolioIntervalSec: 86400, ...patch };
}

describe("Smart Portfolio signed tuple", () => {
  it("accepts the full portfolio tuple and preserves array order in its digest", () => {
    const parsed = parseTradeSettings(settings());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.value.raw.portfolioTokens, TOKENS);
    assert.equal(tradeSettingsDigest(settings()), "0x59576600d096d9f4e46ad107bb014094bb1fb2e6c8c46044334641e3921961c0");
    assert.notEqual(tradeSettingsDigest(settings()), tradeSettingsDigest(settings({ portfolioTokens: [...TOKENS].reverse() })));
    assert.notEqual(tradeSettingsDigest(settings()), tradeSettingsDigest(settings({ portfolioWeightsBps: [6000, 4000] })));
  });

  it("rejects every basket, weight, drift, interval and capital boundary", () => {
    const cases: readonly [Partial<TradeSettings>, RegExp][] = [
      [{ portfolioTokens: TOKENS.slice(0, 1) }, /2 to 5/u],
      [{ portfolioTokens: [...TOKENS, ...TOKENS, ...TOKENS].slice(0, 6) }, /2 to 5/u],
      [{ portfolioTokens: [TOKENS[0]!, TOKENS[0]!] }, /distinct lowercase/u],
      [{ portfolioTokens: [TOKENS[0]!.toUpperCase(), TOKENS[1]!] }, /distinct lowercase/u],
      [{ portfolioTokens: [TOKENS[0]!, "0x3333333333333333333333333333333333333333"] }, /Smart Portfolio stocks/u],
      [{ portfolioWeightsBps: [900, 9100] }, /whole percent/u],
      [{ portfolioWeightsBps: [1050, 8950] }, /whole percent/u],
      [{ portfolioWeightsBps: [4900, 5000] }, /whole percent/u],
      [{ portfolioDriftBps: 25 }, /0\.5 % to 15 % in 0\.5 % steps/u],
      [{ portfolioDriftBps: 1550 }, /0\.5 % to 15 % in 0\.5 % steps/u],
      [{ portfolioDriftBps: 75 }, /0\.5 % to 15 % in 0\.5 % steps/u],
      [{ portfolioIntervalSec: 3600 as 14400 }, /4 h, 8 h/u],
      [{ portfolioIntervalSec: 604800 as 14400 }, /4 h, 8 h/u],
      [{ capitalQuoteWei: (49n * ATOMIC + 99n * ATOMIC / 100n).toString(), entryWei: (49n * ATOMIC + 99n * ATOMIC / 100n).toString() }, /at least 50 USDT/u],
      [{ entryWei: (49n * ATOMIC).toString() }, /entryWei must equal/u],
      [{ minEntryWei: (ATOMIC / 2n).toString() }, /minEntryWei must equal 0\.1 USDT \(or 1 USDT for earlier agents\)/u],
      [{ executionModel: "sigma" }, /Portfolio settings require the TradFi v2/u],
      [{ noReentry: true }, /noReentry/u],
      [{ breakEvenAfterTp: true }, /breakEvenAfterTp/u],
      [{ minMarketCapUsd: 100 }, /market caps/u],
      [{ maxMarketCapUsd: 100 }, /market caps/u],
      [{ instructions: "buy" }, /instructions/u],
      [{ skillMarkdown: "trade" }, /skillMarkdown/u],
      [{ maxOpenPositions: 2 }, /maxOpenPositions/u],
      [{ takeProfitBps: 100 }, /exits must be unset/u],
      [{ stopLossBps: 100 }, /exits must be unset/u],
      [{ maxHoldSec: 60 }, /exits must be unset/u],
      [{ crashProtection: true }, /crashProtection/u],
      [{ cmcNewsEnabled: true, cmcTotalBudgetWei: ATOMIC.toString() }, /CMC news must be disabled/u],
      [{ scheduleToken: TOKENS[0]! }, /cannot be combined/u],
      [{ dcaToken: TOKENS[0]! }, /cannot be combined/u],
      [{ capitalQuoteWei: ((2n ** 256n - 1n) / 5n + 1n).toString(), entryWei: ((2n ** 256n - 1n) / 5n + 1n).toString() }, /too large/u],
    ];
    for (const [patch, expected] of cases) {
      const result = parseTradeSettings(settings(patch));
      assert.equal(result.ok, false, JSON.stringify(patch));
      if (!result.ok) assert.match(result.message, expected, JSON.stringify(patch));
    }
    for (const portfolioDriftBps of [50, 350, 1500])
      assert.equal(parseTradeSettings(settings({ portfolioDriftBps })).ok, true);
    for (const minEntryWei of [ATOMIC.toString(), (ATOMIC / 10n).toString()])
      assert.equal(parseTradeSettings(settings({ minEntryWei })).ok, true);
    const max = (2n ** 256n - 1n) / 5n;
    assert.equal(parseTradeSettings(settings({ capitalQuoteWei: max.toString(), entryWei: max.toString() })).ok, true);
    const five = DCA_POOLS_56.slice(0, 5).map((pool) => pool.stock.toLowerCase());
    const tooSmall = 124n * ATOMIC + 99n * ATOMIC / 100n;
    const fiveResult = parseTradeSettings(settings({ portfolioTokens: five, portfolioWeightsBps: [2000, 2000, 2000, 2000, 2000],
      capitalQuoteWei: tooSmall.toString(), entryWei: tooSmall.toString() }));
    assert.equal(fiveResult.ok, false);
    if (!fiveResult.ok) assert.match(fiveResult.message, /at least 125 USDT for 5 stocks/u);
    const missing = structuredClone(settings()) as Record<string, unknown>;
    delete missing["portfolioWeightsBps"];
    const missingResult = parseTradeSettings(missing);
    assert.equal(missingResult.ok, false);
    if (!missingResult.ok) assert.match(missingResult.message, /missing key "portfolioWeightsBps"/u);
    assert.equal(tradeSettingsDigest(DEFAULT_TRADE_SETTINGS), DEFAULT_TRADE_SETTINGS_DIGEST);
  });

  it("allows only slippage edits, including equal but separately allocated arrays", () => {
    const current = parseTradeSettings(settings());
    const next = parseTradeSettings(settings({ slippageBps: 200, portfolioTokens: [...TOKENS], portfolioWeightsBps: [5000, 5000] }));
    assert.equal(current.ok && next.ok, true);
    if (!current.ok || !next.ok) return;
    assert.equal(immutableTradeSettingChange(current.value.effective, next.value.effective), null);
    const changed = parseTradeSettings(settings({ portfolioWeightsBps: [6000, 4000] }));
    assert.equal(changed.ok, true);
    if (changed.ok) assert.equal(immutableTradeSettingChange(current.value.effective, changed.value.effective), "portfolioWeightsBps");
    const ai = structuredClone(settings()) as Record<string, unknown>;
    for (const key of ["tradeMode", "portfolioTokens", "portfolioWeightsBps", "portfolioDriftBps", "portfolioIntervalSec"]) delete ai[key];
    const aiResult = parseTradeSettings(ai);
    assert.equal(aiResult.ok, true);
    if (aiResult.ok) assert.equal(immutableTradeSettingChange(current.value.effective, aiResult.value.effective), "tradeMode");
  });
});

describe("Smart Portfolio pure arithmetic and valuation", () => {
  it("PORTFOLIO_ENABLED defaults off and fails boot on a typo or missing trade agent", () => {
    assert.equal(resolvePortfolioEnabled({}), false);
    assert.equal(resolvePortfolioEnabled({ PORTFOLIO_ENABLED: "false" }), false);
    assert.equal(resolvePortfolioEnabled({ PORTFOLIO_ENABLED: "true", TRADE_AGENT_ENABLED: "true" }), true);
    assert.throws(() => resolvePortfolioEnabled({ PORTFOLIO_ENABLED: "TRUE" }), /exactly/u);
    assert.throws(() => resolvePortfolioEnabled({ PORTFOLIO_ENABLED: "true" }), /TRADE_AGENT_ENABLED/u);
  });
  it("uses all twelve reserve table cells and reports both sizing shortfalls", () => {
    const table = [[86400, [8, 11, 17]], [43200, [10, 14, 22]], [28800, [12, 17, 27]], [14400, [18, 26, 42]]] as const;
    for (const [intervalSec, multipliers] of table) for (const [index, tokenCount] of [2, 3, 5].entries()) {
      const reserve = tradfiPortfolioNativeReserveWei({ tokenCount, intervalSec });
      assert.equal(reserve, BigInt(multipliers[index]!) * 100_000_000_000_000n);
    }
    assert.equal(portfolioMinCapitalWei(2), 50n * ATOMIC);
    assert.equal(portfolioMinCapitalWei(5), 125n * ATOMIC);
    const low = checkTradfiPortfolioSizing({ capDayWei: 0n, capitalQuoteWei: 49n * ATOMIC, tokenCount: 2, intervalSec: 86400 });
    assert.equal(low.ok, false);
    assert.equal(low.shortfallQuoteWei, ATOMIC);
    assert.equal(low.nativeShortfallWei, 8n * 100_000_000_000_000n);
    assert.equal(checkTradfiPortfolioSizing({ capDayWei: low.nativeReserveWei, capitalQuoteWei: 50n * ATOMIC, tokenCount: 2, intervalSec: 86400 }).ok, true);
  });

  it("quotes exactly one pinned stock-to-USDT pool and values dust without a call", async () => {
    const pool = DCA_POOLS_56.find((row) => row.symbol === "SPYB")!;
    const calls: unknown[][] = [];
    const reader = { async quoteV3Single(...args: Parameters<import("../src/trade/route.js").RouteQuoteReader["quoteV3Single"]>) { calls.push(args); return 25n * ATOMIC; } };
    assert.equal(await portfolioStockValue(reader, pool.stock, PORTFOLIO_DUST_TOKEN_WEI - 1n), 0n);
    assert.equal(calls.length, 0);
    assert.equal(await portfolioStockValue(reader, pool.stock, ATOMIC), 25n * ATOMIC);
    assert.deepEqual(calls[0], [pool.stock, USDT_56, 100, ATOMIC]);
    assert.equal(await portfolioStockValue(reader, DCA_POOLS_56[0]!.stock, ATOMIC), 25n * ATOMIC);
    assert.deepEqual(calls[1], [DCA_POOLS_56[0]!.stock, USDT_56, 2500, ATOMIC]);
    assert.equal(await portfolioStockValue({ async quoteV3Single() { return 0n; } }, pool.stock, ATOMIC), null);
    assert.equal(await portfolioStockValue({ async quoteV3Single() { throw new Error("no quote"); } }, pool.stock, ATOMIC), null);
  });
});

describe("Smart Portfolio intent store", () => {
  const base = { agentId: "portfolio", ownerAddress: OWNER, idempotencyKey: HASH, side: "sell" as const,
    token: getAddress(TOKENS[0]!), route: { hops: [], fees: [] }, amountWei: ATOMIC, entryWei: 0n,
    positionId: "sale", closeReason: null, portfolioSlot: 0, settlementAsset: "USDT" as const };
  it("keeps one leg per slot and token, but a rolled-back leg frees the slot", async () => {
    const store = new MemoryTradeIntentStore();
    await store.create({ ...base, decisionId: "first" });
    await assert.rejects(store.create({ ...base, decisionId: "second" }), /already taken/u);
    await store.markRolledBack(OWNER, "portfolio", "first", "pre-submit");
    await store.create({ ...base, decisionId: "second" });
    assert.deepEqual((await store.listPortfolio(OWNER, "portfolio")).map((row) => row.decisionId), ["second"]);
    assert.equal((await store.listProjectedV2(OWNER, "portfolio")).length, 0);
    await assert.rejects(store.create({ ...base, decisionId: "second", portfolioSlot: 1 }), /already bound/u);
  });

  it("excludes projected portfolio buys and sells from ordinary v2 recovery", async () => {
    const store = new MemoryTradeIntentStore();
    const { portfolioSlot: _slot, ...ordinary } = base;
    await store.create({ ...base, decisionId: "portfolio-sell" });
    await store.create({ ...base, decisionId: "portfolio-buy", side: "buy", token: getAddress(TOKENS[1]!), entryWei: ATOMIC });
    await store.create({ ...ordinary, decisionId: "ordinary" });
    for (const id of ["portfolio-sell", "portfolio-buy", "ordinary"]) await store.markProjected(OWNER, "portfolio", id);
    assert.deepEqual((await store.listProjectedV2(OWNER, "portfolio")).map((row) => row.decisionId), ["ordinary"]);
  });

  it("treats explicit null and omitted portfolio slots as ordinary USDT intents", async () => {
    const store = new MemoryTradeIntentStore();
    const { portfolioSlot: _slot, ...ordinary } = base;
    for (const [id, slot] of [["explicit-null", null], ["omitted", undefined]] as const) {
      await store.create({ ...ordinary, decisionId: id, ...(slot === undefined ? {} : { portfolioSlot: slot }) });
      assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", id, ATOMIC, `proof-${id}`)).outcome, "invalid");
      await store.markProjected(OWNER, "portfolio", id);
    }
    assert.deepEqual((await store.listProjectedV2(OWNER, "portfolio")).map((row) => row.decisionId), ["explicit-null", "omitted"]);
  });

  it("implements the immutable proceeds outcome table and validates inputs first", async () => {
    const store = new MemoryTradeIntentStore();
    await store.create({ ...base, decisionId: "sale-a" });
    await store.create({ ...base, decisionId: "sale-b", token: getAddress(TOKENS[1]!) });
    const set = (id: string, amount: bigint, key: string | null) => store.setPortfolioProceeds(OWNER, "portfolio", id, amount, key);
    assert.equal((await set("sale-a", -1n, null)).outcome, "invalid");
    assert.equal((await set("sale-a", 1n, null)).outcome, "invalid");
    assert.equal((await set("sale-a", 0n, "key")).outcome, "invalid");
    assert.equal((await set("missing", 0n, null)).outcome, "invalid");
    assert.equal((await set("sale-a", 5n, "key")).outcome, "credited");
    assert.equal((await set("sale-a", 5n, "key")).outcome, "same");
    assert.equal((await set("sale-a", 6n, "other")).outcome, "settled");
    assert.equal((await set("sale-b", 5n, "key")).outcome, "conflict");
    assert.equal((await set("sale-b", 5n, "later")).outcome, "settled");
    assert.equal((await store.get(OWNER, "portfolio", "sale-b"))?.portfolioProceedsAtomic, 0n);
  });

  it("portfolio receipt ownership permits one positive credit under concurrent contenders", async () => {
    const store = new MemoryTradeIntentStore();
    await store.create({ ...base, decisionId: "first" });
    await store.create({ ...base, decisionId: "second", token: getAddress(TOKENS[1]!) });
    const results = await Promise.all([
      store.setPortfolioProceeds(OWNER, "portfolio", "first", 5n, "same-receipt"),
      store.setPortfolioProceeds(OWNER, "portfolio", "second", 5n, "same-receipt"),
    ]);
    assert.deepEqual(results.map((row) => row.outcome).sort(), ["conflict", "credited"]);
    assert.equal((await store.listPortfolio(OWNER, "portfolio")).reduce((sum, row) => sum + (row.portfolioProceedsAtomic ?? 0n), 0n), 5n);
  });

  it("portfolio positive proof and FAILED zero seal retain the first winner in both orders", async () => {
    for (const first of ["credit", "seal"] as const) {
      const store = new MemoryTradeIntentStore();
      await store.create({ ...base, decisionId: "race" });
      if (first === "credit") {
        assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", "race", 5n, "receipt")).outcome, "credited");
        assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", "race", 0n, null)).outcome, "settled");
        assert.equal((await store.get(OWNER, "portfolio", "race"))?.portfolioProceedsAtomic, 5n);
      } else {
        assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", "race", 0n, null)).outcome, "sealed");
        assert.equal((await store.setPortfolioProceeds(OWNER, "portfolio", "race", 5n, "receipt")).outcome, "settled");
        assert.equal((await store.get(OWNER, "portfolio", "race"))?.portfolioProceedsAtomic, 0n);
      }
    }
  });

  it("uses first-writer checks and CAS completion", async () => {
    const store = new MemoryTradeIntentStore();
    const input = { agentId: "portfolio", ownerAddress: OWNER, slot: 0, state: "held" as const, maxDriftBps: 240, valueWei: 50n * ATOMIC };
    assert.equal((await store.insertPortfolioCheck(input)).state, "held");
    assert.equal((await store.insertPortfolioCheck({ ...input, state: "rebalancing" })).state, "held");
    assert.equal((await store.markPortfolioCheckDone(OWNER, "portfolio", 0))?.state, "held");
    assert.equal((await store.insertPortfolioCheck({ ...input, slot: 1, state: "rebalancing" })).state, "rebalancing");
    assert.equal((await store.insertPortfolioCheck({ ...input, slot: 1, state: "held" })).state, "rebalancing");
    assert.equal((await store.markPortfolioCheckDone(OWNER, "portfolio", 1))?.state, "done");
  });

  it("declares the portfolio PG columns and both partial unique indexes", async () => {
    const texts: string[] = [];
    const sql: SqlClient = { async query(text) { texts.push(text); return { rows: [] }; }, async transaction(work) { return work(this); }, async close() {} };
    await PostgresTradeIntentStore.create(sql);
    assert.ok(texts.some((text) => text.includes("add column if not exists portfolio_slot integer")));
    assert.ok(texts.some((text) => text.includes("add column if not exists portfolio_proceeds_atomic")));
    assert.ok(texts.some((text) => text.includes("trade_intents_portfolio_leg_idx") && text.includes("lower(token)")));
    assert.ok(texts.some((text) => text.includes("trade_intents_portfolio_receipt_idx") && text.includes("where portfolio_receipt_key is not null")));
    assert.ok(texts.some((text) => text.includes("trade_portfolio_checks")));
  });
});

it("portfolio derives zero fee from stored settings while AI keeps 100 bps and absent store refuses zero", async () => {
  const now = Date.now();
  const agents = new MemoryAgentStore(null, () => now);
  const spec = { allowedCalls: [{ to: getAddress(TOKENS[0]!), selector: "approve(address,uint256)" }],
    spendCaps: [{ token: USDT_56, limit: 250n * ATOMIC, period: "day" as const },
      { token: getAddress(TOKENS[0]!), limit: 250n * ATOMIC, period: "day" as const }], expiresAt: Math.floor(now / 1000) + 604800 };
  const agent = await agents.createAgent({ id: "portfolio", ownerAddress: OWNER, walletAddress: OWNER, custodyModel: "passkey", status: "armed",
    sessionFacts: { spec, permissions: validateSessionSpec(spec, { minSessionSeconds: 0 }),
      publicKey: `0x02${"33".repeat(32)}` as Hex, expiry: spec.expiresAt,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT",
        entryWei: (50n * ATOMIC).toString(), minEntryWei: ATOMIC.toString(), quotePerTradeWei: (50n * ATOMIC).toString(),
        capitalQuoteWei: (50n * ATOMIC).toString(), cmcNewsEnabled: false } } });
  const store = new MemoryTradeSettingsStore(agents, () => now);
  const portfolio = settings();
  await store.put({ agentId: agent.id, ownerAddress: OWNER, params: portfolio, digest: tradeSettingsDigest(portfolio) });
  const trade = tradeConfig({ venues: { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, wbnb: WBNB_56 }, feeBps: 100,
    feeTreasury: getAddress("0x4444444444444444444444444444444444444444") });
  const request = { side: "buy" as const, amountWei: 25n * ATOMIC, quotedOutWei: 25n * ATOMIC, minOutWei: 25n * ATOMIC * 99n / 100n, platformFeeAtomic: 0n };
  const first = await tradfiV2SwapRefusal({ trade, settingsStore: store }, agent, agent.sessionFacts!, request);
  assert.equal(first.ok, true);
  const fee = await tradfiV2SwapRefusal({ trade, settingsStore: store }, agent, agent.sessionFacts!, { ...request, platformFeeAtomic: 25n * ATOMIC / 100n });
  assert.equal(fee.ok, false);
  if (!fee.ok) assert.equal(fee.code, "FEE_MISMATCH");
  const absent = await tradfiV2SwapRefusal({ trade }, agent, agent.sessionFacts!, request);
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.code, "FEE_MISMATCH");
  const ai = structuredClone(portfolio) as Record<string, unknown>;
  for (const key of ["tradeMode", "portfolioTokens", "portfolioWeightsBps", "portfolioDriftBps", "portfolioIntervalSec"]) delete ai[key];
  await store.put({ agentId: agent.id, ownerAddress: OWNER, params: ai as TradeSettings, digest: tradeSettingsDigest(ai as TradeSettings) });
  assert.equal((await tradfiV2SwapRefusal({ trade, settingsStore: store }, agent, agent.sessionFacts!, { ...request, platformFeeAtomic: 25n * ATOMIC / 100n })).ok, true);
});

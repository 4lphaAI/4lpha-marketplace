/**
 * The trade worker's Auto DCA branch, through `runTradeWorkerOnce` with fakes
 * (AUTO-DCA §15.2 `tradeDcaWorker`, R2.8, R2.11–R2.13, R2.17, R2.18, R2.21,
 * R3.1–R3.7; REVIEW2 conditions 1, 3, 10, 15, 16; REVIEW3 C2, C3, C5, C7).
 *
 * One world: a real memory store, journal, kill switch and range executor; a
 * fake chain (pool reading, NFPM positions, wallet enumeration, balances,
 * logs); the guard-first TradFi pricing on a fake Flash quote. Each landed
 * batch's receipt is built from its own persisted plan (`planLogs`), so every
 * finish runs the real DCA receipt verifier.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { type Address, type Hex } from "viem";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { MemoryDcaRoundStore, type DcaActionRow, type DcaOrderRow } from "../src/store/dcaRounds.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import { buildTradfiPancakeV3Swap } from "../src/ops/tradfi.js";
import { PANCAKE_V3_ROUTER_56, WBNB_56 } from "../src/ops/venues.js";
import { getLiquidityForAmounts, getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import type { TradeDataPlaneReads, UniverseRow } from "../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { dcaBatchCalls, dcaMidPrice, dcaPoolLegs, dcaPriceAtTick, planDcaStart, type DcaBatchPlan } from "../src/trade/dca.js";
import { dcaIdempotencyKey, executeDcaRangeBatch } from "../src/trade/dcaExecute.js";
import { createDcaChainReads, dcaUnknownEvidence, type DcaChainReads, type DcaNfpmLog, type DcaPositionRead } from "../src/trade/dcaResolve.js";
import { DCA_NFPM_COLLECT_TOPIC, type TradfiReceipt, type TradfiReceiptObservation } from "../src/trade/receipt.js";
import { FakeWalletProvider, tradeConfig } from "./support/serverHarness.js";
import { createTradfiEvidenceWriter, netTransferDelta, type TradfiPreflightDeps } from "../src/trade/simulate.js";
import { MemoryTradeSimulationStore } from "../src/store/tradeSimulations.js";
import { AGENT_ID, E18, GUARD, NV, NV_TICK, OUTSIDER, OWNER, TREASURY, WALLET, dcaAgent, dcaEffective, dcaObservation, dcaRpcEndpoint, dcaSettings, nfpmLog, planLogs, transferLog } from "./support/dcaFixtures.js";

const START = Date.UTC(2026, 8, 25, 14);
const PRICE = 223.37;
const QUOTE = 10n ** 13n;

type Chain = {
  tick: number;
  block: bigint;
  positions: Map<bigint, Exclude<DcaPositionRead, "burned">>;
  walletIds: bigint[];
  balances: Map<string, bigint>;
  logs: Map<bigint, DcaNfpmLog[]>;
  logsThrow: boolean;
  readingThrows: boolean;
  /** Ticks served to the next readings, in order, before `tick` again: a drift inside one cycle. */
  tickQueue: number[];
  positionThrows: Set<bigint>;
};

function chainReads(chain: Chain): DcaChainReads {
  return {
    async reading() {
      if (chain.readingThrows) throw new Error("rpc down");
      const tick = chain.tickQueue.shift() ?? chain.tick;
      return { block: chain.block, tick, sqrtPriceX96: getSqrtRatioAtTick(tick) };
    },
    async position(tokenId) {
      if (chain.positionThrows.has(tokenId)) throw new Error("rpc down");
      return chain.positions.get(tokenId) ?? "burned";
    },
    async walletTokenIds() { return [...chain.walletIds]; },
    async tokenBalance(token) { return chain.balances.get(token.toLowerCase()) ?? 0n; },
    async gasPriceWei() { return 50_000_000n; },
    async nfpmLogs(tokenId) {
      if (chain.logsThrow) throw new Error("Archive requests require a personal token");
      return chain.logs.get(tokenId) ?? [];
    },
  };
}

async function world(t: TestContext, input: { readonly settings?: Partial<TradeSettings>; readonly enabled?: boolean; readonly meter?: bigint | null; readonly preflight?: TradfiPreflightDeps } = {}) {
  let now = START;
  t.mock.method(Date, "now", () => now);
  const { agents, agent } = await dcaAgent({ nowMs: now });
  const settingsStore = new MemoryTradeSettingsStore(agents, () => now);
  const settings = dcaSettings(input.settings);
  await settingsStore.put({ agentId: agent.id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
  const store = new MemoryDcaRoundStore();
  const journal = new MemoryExecutionJournal(() => now);
  const killswitch = new MemoryKillSwitch(() => now);
  const provider = new FakeWalletProvider();
  const positions = new MemoryTradePositionStore(() => now);
  const chain: Chain = { tick: NV_TICK, block: 1_000n, positions: new Map(), walletIds: [], balances: new Map([[USDT_56.toLowerCase(), 100n * E18]]),
    logs: new Map(), logsThrow: false, readingThrows: false, tickQueue: [], positionThrows: new Set() };
  const observations = new Map<Hex, TradfiReceiptObservation>();
  const ownerReceipts = new Map<Hex, TradfiReceipt>();
  const counters = { llm: 0, executor: 0 };
  const flash = { fail: false };
  let hashSeq = 0;
  const stockPerUsdt = (amount: bigint): bigint => amount * 100_000n / BigInt(Math.round(PRICE * 100_000));
  const rwaVenue = { dex: "pancakeswap", version: "v3", pool: NV.pool, quote: USDT_56, quoteSymbol: "USDT", feeTier: 2500,
    liquidityUsd: 100_000, volume24hUsd: 1_000, priceUsd: PRICE, asOf: now } as const;
  const row: UniverseRow = { address: NV.stock, symbol: "NVDAB", lane: "bstocks", source: "fixture", venues: [rwaVenue],
    rwa: { platform: "bstocks", underlyingTicker: "NVDA", tokenPriceUsd: PRICE, referencePriceUsd: PRICE, premiumBps: 0, openState: true,
      marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: PRICE, venues: [rwaVenue] } };
  const dataPlane: TradeDataPlaneReads = {
    universe: async (lane) => lane === "bstocks" ? [row] : [],
    tokensBatch: async (addresses) => addresses.map((address) => ({ address, priceUsd: address.toLowerCase() === WBNB_56.toLowerCase() ? 769.4 : 1,
      marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: now, staleness: "fresh" as const })),
    eligibilityBatch: async (addresses) => addresses.map((address) => ({ address, eligible: true, reason: "ok", source: "binance-rwa" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }),
    binanceQuoteAndSwap: async (request) => {
      if (flash.fail) throw new Error("proxy:unavailable");
      const amount = BigInt(request.amountAtomic);
      const quoted = request.tokenIn.toLowerCase() === USDT_56.toLowerCase() ? stockPerUsdt(amount) : amount * BigInt(Math.round(PRICE * 100)) / 100n;
      return { version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
        amountInAtomic: request.amountAtomic, quotedOutAtomic: quoted.toString(), minOutAtomic: (quoted * 99n / 100n).toString(),
        router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0",
        observedAt: now, expiresAt: now + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 };
    },
  };
  const noAmm = async (): Promise<bigint> => { throw new Error("no public AMM"); };
  const routeReader: RouteQuoteReader = { quoteV2: noAmm, quoteV3Single: noAmm, quoteV3Path: noAmm, quoteUniV3Single: noAmm, quoteUniV3Path: noAmm };
  const trade = tradeConfig({ feeBps: 100, feeTreasury: TREASURY });
  const meter = { value: input.meter === undefined ? 275n * E18 : input.meter };
  const deps: TradeWorkerDeps = {
    agentStore: agents, settingsStore, positions, intents: new MemoryTradeIntentStore(() => now), journal, dataPlane, killswitch,
    provider: {
      getTokenBalance: async ({ token }) => chain.balances.get(token.toLowerCase()) ?? 0n,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "NVDAB" }),
      readSpendInfos: async () => meter.value === null ? [] : [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 275n * E18, currentSpentWei: 275n * E18 - meter.value }],
    },
    llmFor: () => ({ complete: async () => { counters.llm += 1; throw new Error("a DCA agent must never reach the model"); } }),
    executor: { execute: async () => { counters.executor += 1; throw new Error("a DCA agent never uses the trade executor"); } },
    executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([NV.stock.toLowerCase()]) },
    rpcUrls: [], routeReader, platformFeeBps: 100, platformFeeTreasury: TREASURY, aggregatorGuard: GUARD,
    tradfiNativeCostUsdtAtomic: async () => 1n, forbiddenAddresses: () => new Set(),
    executionIdentity: () => ({ idempotencyKey: `0x${"01".repeat(32)}`, paramsHash: `0x${"02".repeat(32)}` }),
    recoverFill: async () => ({ side: "buy", entryWei: 0n, tokenAmount: null, fillStatus: "unverified" }),
    now: () => now, intervalMs: 60_000,
    dca: {
      store, enabled: input.enabled ?? true, nfpm: NFPM_56, chain: chainReads(chain), batchCostWei: async () => QUOTE,
      executeRange: (range) => executeDcaRangeBatch({ store, settingsStore, agentStore: agents, journal, killswitch,
        ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
        providerRegistry: { get: () => provider }, chainId: 56, trade, nfpm: NFPM_56,
        quoteRemaining: async () => meter.value, walletUsdt: async () => chain.balances.get(USDT_56.toLowerCase()) ?? 0n, nowMs: () => now }, range),
      receipts: { readFinalized: async (hash) => observations.get(hash) ?? null, getReceipt: async (hash) => ownerReceipts.get(hash) ?? null },
      journal,
    },
  };

  /** One worker cycle, a minute and 200 blocks after the last; every submission gets a fresh tx hash. */
  async function cycle() {
    now += 61_000;
    chain.block += 200n;
    hashSeq += 1;
    provider.nextReceipt = { status: "CONFIRMED", callsId: `0x${"c1".repeat(32)}`, transactionHash: `0x${hashSeq.toString(16).padStart(64, "0")}` as Hex };
    return runTradeWorkerOnce(deps);
  }

  async function lastAction(): Promise<DcaActionRow> {
    const actions = await store.listActions(OWNER, AGENT_ID);
    assert.ok(actions.length > 0, "no DCA action was claimed");
    return actions.at(-1)!;
  }

  /** The chain lands the last submitted batch: positions move and a verifying receipt appears. */
  async function land(input: { readonly firstTokenId: bigint; readonly swapOutWei?: bigint } = { firstTokenId: 700n }): Promise<DcaBatchPlan> {
    const action = await lastAction();
    const plan = action.plan;
    const txHash = provider.nextReceipt.transactionHash!;
    const calls = dcaBatchCalls(plan, { pool: NV, nfpm: NFPM_56, wallet: WALLET, treasury: TREASURY });
    observations.set(txHash, dcaObservation(calls, planLogs(plan, NV, input), txHash));
    const legs = dcaPoolLegs(NV);
    for (const exit of plan.exits) {
      const current = chain.positions.get(exit.tokenId);
      if (current !== undefined) chain.positions.set(exit.tokenId, { ...current, liquidity: 0n });
    }
    for (const [index, mint] of plan.mints.entries()) {
      const tokenId = input.firstTokenId + BigInt(index);
      chain.positions.set(tokenId, { liquidity: mint.liquidity, tickLower: mint.tickLower, tickUpper: mint.tickUpper, token0: legs.token0, token1: legs.token1, fee: NV.fee });
      chain.walletIds.push(tokenId);
    }
    return plan;
  }

  async function orders(roundNo?: number): Promise<readonly DcaOrderRow[]> {
    const round = roundNo ?? (await store.getOpenRound(OWNER, AGENT_ID))?.roundNo ?? 1;
    return store.listOrders(AGENT_ID, round);
  }

  async function lastRunReason(): Promise<string> {
    return (await positions.listRuns(OWNER, AGENT_ID, 1))[0]?.reason ?? "";
  }

  return { get now() { return now; }, set now(value: number) { now = value; }, agents, agent, settingsStore, store, journal, killswitch, provider,
    positions, chain, observations, ownerReceipts, counters, flash, deps, meter, cycle, lastAction, land, orders, lastRunReason, stockPerUsdt };
}

/** Round 1's start landed: the round is active with P0 at the pool price, a live TP, L1/L2 resting (R3) and L3/L4 pending. */
async function activeRound(t: TestContext, input: Parameters<typeof world>[1] = {}) {
  const w = await world(t, input);
  await w.cycle();
  const start = await w.lastAction();
  assert.equal(start.kind, "start");
  // P0 = the pool price at the M1 tick, so the ladder is §15 V2's.
  const p0 = dcaPriceAtTick(NV, NV_TICK);
  const swapOutWei = 15n * E18 * p0.den / p0.num;
  await w.land({ firstTokenId: 700n, swapOutWei });
  w.chain.balances.set(NV.stock.toLowerCase(), swapOutWei - start.plan.mints[0]!.amount0Desired);
  await w.cycle();
  assert.equal((await w.store.getAction(OWNER, start.actionKey))?.state, "finished");
  return w;
}

describe("the DCA branch: phases, not the AI lanes (I9, R2.8)", () => {
  it("D4 verified DCA receipt records net stock delta once; unverified receipt records nothing", async t => {
    const w = await world(t), simulations = new MemoryTradeSimulationStore(), writer = createTradfiEvidenceWriter(simulations, () => {});
    Object.assign(w.deps.dca!, { simulations: writer });
    await w.cycle(); const action = await w.lastAction(); const txHash = w.provider.nextReceipt.transactionHash!;
    await w.cycle(); assert.equal(simulations.actuals.size, 0);
    w.provider.nextReceipt = { ...w.provider.nextReceipt, transactionHash: txHash };
    await w.land();
    const observation = w.observations.get(w.provider.nextReceipt.transactionHash!)!;
    await w.cycle(); await writer.shutdown();
    const actual = simulations.actuals.get(dcaIdempotencyKey(action.actionKey))!;
    assert.equal(actual.actualOutAtomic, netTransferDelta(observation.receipt.logs, NV.stock, WALLET));
    assert.equal(simulations.actuals.size, 1);
  });
  it("round 1 starts guard-first with the TP at minOut, and never reaches runExits, the model or the trade executor", async (t) => {
    const w = await world(t);
    await w.cycle();
    const action = await w.lastAction();
    assert.equal(action.kind, "start");
    assert.ok(action.plan.swap?.guard !== undefined, "the guard leg is preferred");
    // R3.0: the start mints its `ahead` (N = 4 ⇒ 2) resting levels in the same batch, keyed in its round (review C5).
    assert.deepEqual(action.plan.mints.map((mint) => [mint.role, mint.levelNo]), [["tp", null], ["level", 1], ["level", 2]]);
    assert.deepEqual(action.plan.mints.slice(1).map((mint) => mint.orderKey), ["r1:l1", "r1:l2"]);
    assert.equal(w.provider.executeCalls[0]!.calls.length, 12, "R3.3 batch 1 at a = 2");
    assert.equal(action.plan.mints[0]!.amount0Desired, action.plan.swap!.minOutWei, "R2.6: the start TP holds minOut, never the quote");
    assert.equal(w.counters.llm, 0);
    assert.equal(w.counters.executor, 0);
    assert.equal(w.provider.executeCalls.length, 1);
    assert.equal(w.provider.executeCalls[0]!.bypassLocalPolicyCheck, false);
    // Operator ruling 2026-09-25: the start pays no platform fee, although this world configures 100 bps and a treasury.
    assert.equal(action.plan.feeWei, 0n);
    assert.ok(!w.provider.executeCalls[0]!.calls.some((call) => call.data?.toLowerCase().includes(TREASURY.slice(2).toLowerCase()) === true), "no transfer to the treasury");
    assert.match(await w.lastRunReason(), /^dca-placed/u);
    // The pricing is the shared `priceTradfiV2Buy` extraction: its route observation still lands in the run log (N14).
    const events = (await w.positions.listRuns(OWNER, AGENT_ID, 1))[0]?.events ?? [];
    assert.ok(events.some((event) => event.stage === "route" && event.code === "binance-guard" && /^cost-comparison:/u.test(event.reason ?? "")));
  });

  it("a slow pricing does not expire the guard: the window counts from the priced offer, not the cycle start", async (t) => {
    const w = await world(t);
    const t0 = w.now;
    const flashQuote = w.deps.dataPlane.binanceQuoteAndSwap!;
    // The live QQQB start (2026-09-25) priced for 7.5 s and was refused at +9 s.
    Object.assign(w.deps.dataPlane, { binanceQuoteAndSwap: async (request: Parameters<typeof flashQuote>[0]) => {
      const offer = await flashQuote(request);
      w.now = t0 + 61_000 + 8_000; // cycle() advances the clock 61 s; pricing then takes 8 s
      return { ...offer, observedAt: w.now, expiresAt: w.now + 15_000 };
    } });
    await w.cycle();
    const start = await w.lastAction();
    assert.equal(start.kind, "start");
    assert.notEqual(start.state, "rolled-back", "not refused as GUARD_QUOTE_EXPIRED");
    assert.equal(w.provider.executeCalls.length, 1);
    assert.equal(start.plan.swap?.guard?.deadlineSec, BigInt(Math.floor((t0 + 69_000) / 1_000)) + 14n);
    // The anchor must stay the build-time clock, never the cycle start.
    const source = readFileSync(new URL("../src/trade/worker.ts", import.meta.url), "utf8");
    assert.ok(source.includes("const cap = BigInt(Math.floor((ctx.deps.now?.() ?? Date.now()) / 1_000))"), "the guard window is anchored at build time");
  });

  it("M-3: a start makes ONE relay quote after the Flash quote — its pricing's own, reused as the batch's relayQuoteWei", async (t) => {
    const w = await world(t);
    const events: string[] = [];
    const flashQuote = w.deps.dataPlane.binanceQuoteAndSwap!;
    Object.assign(w.deps.dataPlane, { binanceQuoteAndSwap: async (request: Parameters<typeof flashQuote>[0]) => { events.push("flash"); return flashQuote(request); } });
    Object.assign(w.deps, { tradfiNativeCostUsdtAtomic: async () => { events.push("quote"); return 1n; } });
    let quotes = 0n;
    Object.assign(w.deps.dca!, { batchCostWei: async () => { events.push("quote"); quotes += 1n; return QUOTE + quotes; } });
    await w.cycle();
    const start = await w.lastAction();
    assert.equal(start.kind, "start");
    assert.deepEqual(events.slice(events.indexOf("flash")), ["flash", "quote"], "no second prepareCalls inside the guard window");
    assert.equal(start.plan.relayQuoteWei, QUOTE + quotes, "the batch carries the selected offer's own quote");
  });

  it("R2.14: round 1 waits while the offer's on-chain minOut cannot reach the trigger", async (t) => {
    const w = await world(t, { settings: { dcaTriggerPriceE8: "20000000000" } }); // 200 USDT, under the 223.37 market
    await w.cycle();
    assert.deepEqual(await w.store.listActions(OWNER, AGENT_ID), []);
    assert.match(await w.lastRunReason(), /^dca-trigger-not-reached/u);
  });

  it("11. the start gates count B + a·D: the wallet (dca-cash-low) and the on-chain meter with one order of margin (dca-cap-exhausted)", async (t) => {
    for (const [cash, meter, reason] of [[34n, 275n, "dca-cash-low"], [35n, 44n, "dca-cap-exhausted"], [35n, 45n, "dca-placed"]] as const) {
      const w = await world(t, { meter: meter * E18 });
      w.chain.balances.set(USDT_56.toLowerCase(), cash * E18);
      await w.cycle();
      assert.match(await w.lastRunReason(), new RegExp(`^${reason}`, "u"), `cash ${cash}, meter ${meter}`);
      assert.equal((await w.store.listActions(OWNER, AGENT_ID)).length, reason === "dca-placed" ? 1 : 0);
    }
  });

  it("12 (D-R3-1). the round-start hold prices the `a` level mints and exits: NVDAB N = 4 at TP 1 % waits at 0.06 gwei", async (t) => {
    const w = await world(t, { settings: { dcaTakeProfitBps: 100 } });
    // Calibration R1 moved the engage point to 0.0506 gwei, so this case starts at the fake chain's 0.05.
    // At 0.06 the `a` = 2 levels and their exits cost 0.2677 against a 0.2259 gross and it waits; priced
    // with `dcaR0Gas(pool, 0)` the same round costs 0.1457 and would start.
    Object.assign(w.deps.dca!.chain, { gasPriceWei: async () => 60_000_000n });
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-uneconomic/u);
    assert.deepEqual(await w.store.listActions(OWNER, AGENT_ID), []);
  });

  it("a start with no route is refused and counted, exactly as the shared pricing always counted it", async (t) => {
    const w = await world(t);
    w.flash.fail = true;
    await w.cycle();
    assert.deepEqual(await w.store.listActions(OWNER, AGENT_ID), []);
    assert.match(await w.lastRunReason(), /^dca-no-route;candidates=1;refusals=1;/u);
  });

  it("the finish books the start from its receipt: P0, the ledger, a live TP, L1/L2 resting and L3/L4 pending; a no-fill cycle adds nothing", async (t) => {
    const w = await activeRound(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    assert.equal(round.phase, "active");
    assert.equal(round.p0UsdtWei, 15n * E18);
    assert.equal(round.costUsdtWei, 15n * E18);
    const orders = await w.orders();
    assert.equal(orders.filter((row) => row.role === "tp" && row.state === "live").length, 1);
    assert.deepEqual(orders.filter((row) => row.role === "level").map((row) => [row.tickLower, row.tickUpper, row.state, row.tokenId]),
      [[53_900, 53_950, "live", 701n], [53_800, 53_850, "live", 702n], [53_650, 53_700, "pending", null], [53_450, 53_500, "pending", null]]);
    // `ahead` levels already rest: nothing more is minted while none fills.
    await w.cycle();
    assert.equal(w.provider.executeCalls.length, 1);
    assert.match(await w.lastRunReason(), /^dca-waiting/u);
  });

  it("4. anchor ≠ fill: a fill 1 % better than the anchor writes L3/L4 from the anchor, and p0 holds the fill", async (t) => {
    const w = await world(t);
    await w.cycle();
    const start = await w.lastAction();
    const anchor = start.plan.ladderAnchor!;
    // D-R3-4 (b): the flash quote's rounding excess over the mid stays far under
    // the cap of mid × (1 + pool fee), so the anchor is the quote itself, unclamped.
    assert.deepEqual(anchor, { num: 15n * E18, den: w.stockPerUsdt(15n * E18) }, "the quote-implied price");
    const swapOutWei = 15n * E18 * anchor.den * 100n / (anchor.num * 99n); // P0 = 0.99 · A
    await w.land({ firstTokenId: 700n, swapOutWei });
    w.chain.balances.set(NV.stock.toLowerCase(), swapOutWei - start.plan.mints[0]!.amount0Desired);
    await w.cycle();
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    assert.deepEqual([round.p0UsdtWei, round.p0StockWei], [15n * E18, swapOutWei]);
    const levels = (await w.orders()).filter((row) => row.role === "level");
    assert.deepEqual(levels.map((row) => [row.orderKey, row.tickLower, row.tickUpper, row.state]), [
      ["r1:l1", 53_900, 53_950, "live"], ["r1:l2", 53_800, 53_850, "live"], ["r1:l3", 53_650, 53_700, "pending"], ["r1:l4", 53_450, 53_500, "pending"]]);
  });
});

describe("R3.1 resting levels, §5.3 fills and I6", () => {
  it("6. a fill needs two filled readings a minute apart; at a = 2, f = 1 it exits [L1, TP] and mints [TP, L3] (10 calls)", async (t) => {
    const w = await activeRound(t);
    const submitted = w.provider.executeCalls.length;
    w.chain.tick = 53_890; // strictly below L1: its USDT is all stock now; L2 still holds USDT
    await w.cycle(); // first filled reading — a touch is never a fill
    assert.equal(w.provider.executeCalls.length, submitted);
    await w.cycle(); // second reading, confirmed at this cycle's own reading
    const fill = await w.lastAction();
    assert.equal(fill.kind, "fill");
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "exiting")!;
    assert.deepEqual(fill.plan.exits.map((exit) => exit.orderKey), ["r1:l1", tp.orderKey]);
    // Review C2: open = a − (live − f) = 2 − (2 − 1) = 1, so L3 rides along and two levels rest again.
    assert.deepEqual(fill.plan.mints.map((mint) => [mint.role, mint.orderKey.startsWith("r1:tp") ? "tp" : mint.orderKey]), [["tp", "tp"], ["level", "r1:l3"]]);
    assert.equal(w.provider.executeCalls.at(-1)!.calls.length, 10);
  });

  it("6. at a = 2, f = 2 the fill mints [TP, L3, L4] (15 calls)", async (t) => {
    const w = await activeRound(t);
    w.chain.tick = 53_750; // below L1 and L2, above L3
    await w.cycle();
    await w.cycle();
    const fill = await w.lastAction();
    assert.equal(fill.kind, "fill");
    assert.deepEqual(fill.plan.mints.slice(1).map((mint) => mint.orderKey), ["r1:l3", "r1:l4"]);
    assert.equal(w.provider.executeCalls.at(-1)!.calls.length, 15);
  });

  it("5. a fill whose tick has passed L3 skips L3 for the round and mints L4", async (t) => {
    const w = await activeRound(t);
    w.chain.tick = 53_640; // below L1, L2 and L3's range, above L4
    await w.cycle();
    await w.cycle();
    const fill = await w.lastAction();
    assert.equal(fill.kind, "fill");
    assert.deepEqual(fill.plan.exits.slice(0, 2).map((exit) => exit.orderKey), ["r1:l1", "r1:l2"]);
    assert.deepEqual(fill.plan.mints.slice(1).map((mint) => mint.orderKey), ["r1:l4"]);
    assert.equal((await w.orders()).find((row) => row.orderKey === "r1:l3")?.state, "skipped");
  });

  it("6. at a = 1 (N = 3) the fill mints [TP, L2]; the last level's fill (N = 2) mints the TP alone (7 calls)", async (t) => {
    const three = await activeRound(t, { settings: { dcaMaxOrders: 3, capitalQuoteWei: "45000000000000000000" } });
    three.chain.tick = 53_890;
    await three.cycle();
    await three.cycle();
    assert.deepEqual((await three.lastAction()).plan.mints.slice(1).map((mint) => mint.orderKey), ["r1:l2"]);
    assert.equal(three.provider.executeCalls.at(-1)!.calls.length, 10);

    const two = await activeRound(t, { settings: { dcaMaxOrders: 2, capitalQuoteWei: "35000000000000000000" } });
    two.chain.tick = 53_890;
    await two.cycle();
    await two.cycle(); // L1's fill mints [TP, L2]
    await two.land({ firstTokenId: 800n });
    await two.cycle(); // finish: L2 rests alone
    two.chain.tick = 53_790; // through L2
    await two.cycle();
    await two.cycle();
    const last = await two.lastAction();
    assert.equal(last.kind, "fill");
    assert.deepEqual(last.plan.mints.map((mint) => mint.role), ["tp"]);
    assert.equal(two.provider.executeCalls.at(-1)!.calls.length, 7);
  });

  it("6. inside the entry cutoff the fill still runs, with no level mint (I10, review L2)", async (t) => {
    const w = await activeRound(t);
    w.now = w.agent.sessionFacts!.expiry * 1_000 - 60 * 60_000 - 61_000; // the next cycle runs one hour before expiry
    w.chain.tick = 53_890;
    await w.cycle();
    await w.cycle();
    const fill = await w.lastAction();
    assert.equal(fill.kind, "fill");
    assert.deepEqual(fill.plan.mints.map((mint) => mint.role), ["tp"]);
  });

  it("7. an owner pull of a resting level re-places it at once (1 live: one mint); two live at a = 1 mint nothing", async (t) => {
    const w = await activeRound(t);
    const l2 = (await w.orders()).find((row) => row.orderKey === "r1:l2")!;
    w.chain.positions.set(l2.tokenId!, { ...w.chain.positions.get(l2.tokenId!)!, liquidity: 0n });
    const pullHash = `0x${"ad".repeat(32)}` as Hex;
    w.chain.logs.set(l2.tokenId!, [{ transactionHash: pullHash, blockNumber: l2.lastSeenLiveBlock! + 1n, topic: DCA_NFPM_COLLECT_TOPIC }]);
    w.ownerReceipts.set(pullHash, { status: 1n, transactionHash: pullHash, blockNumber: l2.lastSeenLiveBlock! + 1n, blockHash: `0x${"bb".repeat(32)}`,
      transactionIndex: 0n, logs: [
        { ...nfpmLog(DCA_NFPM_COLLECT_TOPIC, l2.tokenId!, WALLET, 0n, l2.mintedUsdtWei - 1n), logIndex: 0n },
        { ...transferLog(USDT_56, NV.pool, WALLET, l2.mintedUsdtWei - 1n), logIndex: 1n },
      ] });
    w.chain.block = l2.lastSeenLiveBlock! + 100n - 200n; // cycle() adds 200
    await w.cycle();
    const place = await w.lastAction();
    assert.equal(place.kind, "level-place");
    assert.deepEqual(place.plan.mints.map((mint) => mint.orderKey), ["r1:l2"]);
    assert.equal(w.provider.executeCalls.at(-1)!.calls.length, 3);

    const three = await activeRound(t, { settings: { dcaMaxOrders: 3, capitalQuoteWei: "45000000000000000000" } });
    const l1 = (await three.orders()).find((row) => row.orderKey === "r1:l1")!;
    // A Revision 2 round could leave two live levels at N ≤ 3: L2 rests beside L1.
    const legs = dcaPoolLegs(NV);
    three.chain.positions.set(750n, { liquidity: l1.liquidity, tickLower: 53_800, tickUpper: 53_850, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    three.chain.walletIds.push(750n);
    const pending = (await three.orders()).find((row) => row.orderKey === "r1:l2")!;
    await three.store.putOrder({ ...pending, state: "live", tokenId: 750n, liquidity: l1.liquidity, mintedUsdtWei: 10n * E18 });
    const submitted = three.provider.executeCalls.length;
    await three.cycle();
    assert.equal(three.provider.executeCalls.length, submitted);
    assert.match(await three.lastRunReason(), /^dca-waiting/u);
  });

  it("I6 drift-back: confirmed at the projection's reading, back inside at the dispatching reading — nothing is built", async (t) => {
    const w = await activeRound(t);
    w.chain.tick = 53_890;
    await w.cycle(); // first filled reading
    const submitted = w.provider.executeCalls.length;
    // This cycle's observation confirms the fill; the strategy's own reading, a moment later, is inside the range again.
    w.chain.tickQueue.push(53_890);
    w.chain.tick = 53_925;
    await w.cycle();
    assert.equal(w.provider.executeCalls.length, submitted);
    assert.match(await w.lastRunReason(), /^dca-waiting/u, "held by the dispatching reading, not by the planner's own I6 refusal");
  });
});

describe("the round close (R2.4 lever 2b)", () => {
  async function tpConverted(t: TestContext, meter?: bigint, preflight?: TradfiPreflightDeps) {
    const w = await activeRound(t, preflight === undefined ? {} : { preflight });
    if (meter !== undefined) w.meter.value = meter;
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    w.chain.tick = tp.tickUpper + 10; // the whole TP range has been crossed
    await w.cycle(); // first reading
    return { w, tp };
  }

  for (const streak of [0, 2, 5]) it(`D3 simulated close-start rollback survives restart at streak ${streak}`, async t => {
    let fail = false;
    const preflight: TradfiPreflightDeps = { evidence: { insert: () => {} }, simulate: async () => ({ status: fail ? "FAILED" : "SUCCESS", failReason: fail ? "execution reverted: OutputShortfall()" : null, balanceChanges: [], otherChangeCount: 0, upstreamMs: 1 }) };
    const { w } = await tpConverted(t, undefined, preflight);
    w.flash.fail = true;
    t.mock.method(w.deps.routeReader!, "quoteV3Single", async (...args: Parameters<RouteQuoteReader["quoteV3Single"]>) => w.stockPerUsdt(args[3]));
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    await w.store.writeRound({ ...round, revertStreak: streak, backoffUntilMs: null });
    fail = true; await w.cycle();
    assert.equal((await w.lastAction()).kind, "close-start"); assert.equal((await w.lastAction()).note, "SIMULATION_FAILED");
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.revertStreak, streak + 1);
    const submissions = w.provider.executeCalls.length;
    const restarted = { ...w.deps, dca: { ...w.deps.dca! } };
    w.now += 61_000; w.chain.block += 200n;
    await runTradeWorkerOnce(restarted);
    const close = await w.lastAction(); assert.equal(close.kind, "close"); assert.equal(close.plan.swap, null);
    assert.equal(close.plan.mints.filter(mint => mint.role === "level").length, 0); assert.equal(w.provider.executeCalls.length, submissions + 1);
  });
  for (const raw of ["execution reverted", "execution reverted: Too little received"]) it(`R5 guard start and close-start proceed without simulation streak or close-alone: ${raw}`, async t => {
    const store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
    const preflight: TradfiPreflightDeps = { evidence, simulate: async () => ({ status: "FAILED", failReason: raw, balanceChanges: [], otherChangeCount: 0, upstreamMs: 1 }) };
    const { w } = await tpConverted(t, undefined, preflight);
    const start = (await w.store.listActions(OWNER, AGENT_ID)).find(action => action.kind === "start")!;
    assert.equal(start.state, "finished"); assert.notEqual(start.note, "SIMULATION_FAILED");
    const count = w.provider.executeCalls.length;
    await w.cycle();
    const action = await w.lastAction(); assert.equal(action.kind, "close-start"); assert.equal(action.state, "committed");
    assert.notEqual(action.note, "SIMULATION_FAILED"); assert.equal(w.provider.executeCalls.length, count + 1);
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.revertStreak, 0);
    await w.cycle(); assert.equal((await w.lastAction()).kind, "close-start"); assert.equal(w.provider.executeCalls.length, count + 1);
    await evidence.shutdown();
    const rows = [...store.simulations.values()]; assert.equal(rows.length, 2);
    for (const row of rows) { assert.equal(row.route, "guard"); assert.equal(row.outcome, "reverted"); assert.equal(row.blocked, false); assert.equal(row.bareRevert, raw === "execution reverted"); }
  });
  it("R5 guard simulation proceeds but actual close-start FAILED still increments the streak", async t => {
    let fail = false;
    const store = new MemoryTradeSimulationStore(), evidence = createTradfiEvidenceWriter(store, () => {});
    const preflight: TradfiPreflightDeps = { evidence, simulate: async () => ({ status: fail ? "FAILED" : "SUCCESS", failReason: fail ? "execution reverted" : null, balanceChanges: [], otherChangeCount: 0, upstreamMs: 1 }) };
    const { w } = await tpConverted(t, undefined, preflight);
    fail = true; const count = w.provider.executeCalls.length;
    w.provider.nextReceipt = { status: "FAILED", failureCode: "PROVIDER_ERROR" };
    w.now += 61_000; w.chain.block += 200n; await runTradeWorkerOnce(w.deps);
    assert.equal(w.provider.executeCalls.length, count + 1);
    const action = await w.lastAction(); assert.equal(action.kind, "close-start"); assert.equal(action.state, "rolled-back"); assert.equal(action.note, "FAILED");
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.revertStreak, 1);
    await evidence.shutdown(); const row = [...store.simulations.values()].at(-1)!;
    assert.equal(row.route, "guard"); assert.equal(row.outcome, "reverted"); assert.equal(row.blocked, false);
  });
  it("D3 a held round without confirmed TP cannot use the simulation unmerge to start", async t => {
    const { w, tp } = await tpConverted(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: round.roundNo, expectedRowVersion: round.rowVersion,
      plan: { ...(await w.lastAction()).plan, kind: "close-start" }, nowMs: w.now });
    assert.ok(claimed.kind === "claimed");
    await w.store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "rolled-back", note: "SIMULATION_FAILED", nowMs: w.now });
    const current = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    await w.store.writeRound({ ...current, revertStreak: 3, backoffUntilMs: w.now + 600_000 });
    w.chain.tick = tp.tickLower - 10;
    const submissions = w.provider.executeCalls.length; await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-retry-backoff/u); assert.equal(w.provider.executeCalls.length, submissions);
  });

  it("3. close + start merged when every start gate passes: TP + L1 + L2 exit, round 2's TP + L1 + L2 mint (18 calls)", async (t) => {
    const { w, tp } = await tpConverted(t);
    await w.cycle();
    const action = await w.lastAction();
    assert.equal(action.kind, "close-start");
    assert.deepEqual(action.plan.exits.map((exit) => exit.orderKey), [tp.orderKey, "r1:l1", "r1:l2"]);
    assert.deepEqual(action.plan.mints.map((mint) => mint.role === "tp" ? "tp" : mint.orderKey), ["tp", "r2:l1", "r2:l2"]);
    assert.ok(action.plan.swap !== null && action.plan.swap.side === "buy");
    assert.equal(w.provider.executeCalls.at(-1)!.calls.length, 18);
  });

  it("a landed close + start settles round 1 from its receipts and opens round 2 carrying the residue, one row per order key (review C5)", async (t) => {
    const { w, tp } = await tpConverted(t);
    const finished: string[][] = [];
    const finishAction = w.store.finishAction.bind(w.store);
    t.mock.method(w.store, "finishAction", async (...args: Parameters<typeof finishAction>) => {
      finished.push(args[0].orders.map((row) => row.orderKey));
      return finishAction(...args);
    });
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close-start");
    await w.land({ firstTokenId: 900n });
    await w.cycle();
    assert.equal(finished.length, 1);
    assert.equal(new Set(finished[0]).size, finished[0]!.length, `a duplicate order key would clobber a live row: ${finished[0]!.join(", ")}`);
    const [first, second] = await w.store.listRounds(OWNER, AGENT_ID);
    assert.equal(first?.phase, "settled");
    assert.equal(first?.closeCause, "take-profit");
    assert.ok((first?.realizedPnlWei ?? 0n) > 0n, "a TP sold above the average");
    assert.equal(second?.phase, "active");
    assert.equal(second?.carriedStockWei, first!.stockAcquiredWei - tp.mintedStockWei + (await w.store.listOrders(AGENT_ID, 1))
      .find((row) => row.orderKey === tp.orderKey)!.collectedStockWei);
    assert.equal((await w.orders(2)).filter((row) => row.role === "tp" && row.state === "live").length, 1);
    assert.deepEqual((await w.orders(2)).filter((row) => row.role === "level").map((row) => [row.orderKey, row.state, row.tokenId]),
      [["r2:l1", "live", 901n], ["r2:l2", "live", 902n], ["r2:l3", "pending", null], ["r2:l4", "pending", null]]);
    // Round 1's rows are its own: the TP and both resting levels exited, none overwritten by round 2.
    assert.deepEqual((await w.store.listOrders(AGENT_ID, 1)).filter((row) => row.state === "exited").map((row) => row.orderKey).sort(), [tp.orderKey, "r1:l1", "r1:l2"].sort());
  });

  it("close alone when a start gate fails, and the close is never held hostage", async (t) => {
    const { w } = await tpConverted(t, 5n * E18);
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close");
  });

  it("H-1: a merged close + start the executor DENIES runs the close alone on the next cycle", async (t) => {
    const { w } = await tpConverted(t);
    const executeRange = w.deps.dca!.executeRange;
    Object.assign(w.deps.dca!, { executeRange: async (range: Parameters<typeof executeRange>[0]) =>
      range.plan.kind === "close-start" ? { kind: "denied" as const, code: "entry_budget_changed" } : executeRange(range) });
    await w.cycle();
    assert.match(await w.lastRunReason(), /^entry_budget_changed/u);
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close");
  });

  it("close alone after two consecutive GUARD_QUOTE_EXPIRED rollbacks of the merged batch", async (t) => {
    const { w } = await tpConverted(t);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
      const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: round.roundNo, expectedRowVersion: round.rowVersion,
        plan: { ...(await w.lastAction()).plan, kind: "close-start" }, nowMs: w.now });
      assert.ok(claimed.kind === "claimed");
      await w.store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "rolled-back", note: "GUARD_QUOTE_EXPIRED", nowMs: w.now });
    }
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close");
  });

  it("10 (R3.4). two FAILED rollbacks of the merged batch ⇒ the next attempt is the close alone", async (t) => {
    const { w } = await tpConverted(t);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
      const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: round.roundNo, expectedRowVersion: round.rowVersion,
        plan: { ...(await w.lastAction()).plan, kind: "close-start" }, nowMs: w.now });
      assert.ok(claimed.kind === "claimed");
      await w.store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "rolled-back", note: "FAILED", nowMs: w.now });
    }
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close");
  });

  it("C12 (review C3). a merged close + start refused at pricing (dca-no-route) is followed by the close alone", async (t) => {
    const { w } = await tpConverted(t);
    w.flash.fail = true; // no public AMM either: the start cannot be priced
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-no-route/u);
    assert.notEqual((await w.lastAction()).kind, "close-start");
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close");
  });

  it("11. the merged start counts the TP collect and the resting levels' USDT floors as cash (R3.5)", async (t) => {
    // The wallet holds nothing: B + a·D = 35 must come from the TP (≈ 15.1) and L1 + L2 (≈ 20) the batch exits.
    const { w } = await tpConverted(t);
    w.chain.balances.set(USDT_56.toLowerCase(), 0n);
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "close-start");
  });

  it("C15 (review C7). a close whose resting level contains the tick holds dca-level-inside-range, and the hold clears once the tick leaves the range", async (t) => {
    const w = await activeRound(t);
    // A TP resting below L1 (the only way a converted TP and a level containing the tick can coexist).
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    const liquidity = getLiquidityForAmounts(getSqrtRatioAtTick(NV_TICK), 53_700, 53_750, 0n, 15n * E18);
    await w.store.putOrder({ ...tp, tickLower: 53_700, tickUpper: 53_750, liquidity });
    w.chain.positions.set(tp.tokenId!, { ...w.chain.positions.get(tp.tokenId!)!, tickLower: 53_700, tickUpper: 53_750, liquidity });
    w.chain.tick = 53_925; // inside L1 [53 900, 53 950), above the TP: the TP reads converted
    const before = w.provider.executeCalls.length;
    await w.cycle();
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-level-inside-range/u);
    assert.equal(w.provider.executeCalls.length, before, "no batch while the close cannot exit L1 strictly outside the tick (I6)");
    // Once the tick leaves L1's range the hold clears: R2.8 dispatches the merged close + start
    // on that reading (L1's own fill needs a second reading), exiting TP, L1 and L2 strictly outside.
    w.chain.tick = 53_890;
    await w.cycle();
    const close = await w.lastAction();
    assert.equal(close.kind, "close-start");
    assert.deepEqual(close.plan.exits.map((exit) => exit.orderKey), [tp.orderKey, "r1:l1", "r1:l2"]);
  });
});

describe("R3.7 — migration of a live Revision 2 agent, and R3.2's one anchor per round", () => {
  /** A Revision 2-shaped active round: the TP resting, every level pending with its persisted P0 ticks, no level live. */
  async function revision2Round(t: TestContext, maxOrders: number) {
    const w = await world(t, { settings: { dcaMaxOrders: maxOrders, capitalQuoteWei: (15n * E18 + BigInt(maxOrders) * 10n * E18).toString() } });
    const p0Stock = 66_718_561_514_265_962n; // the live start's receipt (R3.7): P0 = 15e18 / this
    const round = (await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "active", p0UsdtWei: 15n * E18, p0StockWei: p0Stock,
      costUsdtWei: 15n * E18, stockAcquiredWei: p0Stock, carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 65n * E18, nowMs: w.now }))!;
    const legs = dcaPoolLegs(NV);
    const tpLiquidity = getLiquidityForAmounts(getSqrtRatioAtTick(54_161), 54_400, 54_450, 66_057_317_170_720_168n, 0n);
    const blank = { agentId: AGENT_ID, roundNo: 1, tokenId: null, liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n,
      collectedStockWei: 0n, crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null, exitedByAction: null, lastSeenLiveBlock: null,
      closedBy: null, updatedAtMs: w.now } as const;
    await w.store.putOrder({ ...blank, orderKey: "r1:tp:1", role: "tp", levelNo: null, tickLower: 54_400, tickUpper: 54_450, tokenId: 7_559_720n,
      state: "live", liquidity: tpLiquidity, mintedStockWei: 66_057_317_170_720_168n, lastSeenLiveBlock: w.chain.block });
    w.chain.positions.set(7_559_720n, { liquidity: tpLiquidity, tickLower: 54_400, tickUpper: 54_450, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    w.chain.walletIds.push(7_559_720n);
    const ticks = [[54_000, 54_050], [53_850, 53_900], [53_700, 53_750], [53_550, 53_600], [53_300, 53_350]] as const;
    for (let levelNo = 1; levelNo <= maxOrders; levelNo += 1) {
      await w.store.putOrder({ ...blank, orderKey: `r1:l${levelNo}`, role: "level", levelNo, tickLower: ticks[levelNo - 1]![0], tickUpper: ticks[levelNo - 1]![1], state: "pending" });
    }
    w.chain.tick = 54_161; // 224.94, block 123 901 191
    return { w, round };
  }

  it("15. the live agent's shape (N = 5): the first R3 cycle claims ONE level-place of [L1, L2] at their persisted ticks, 20 USDT, 6 calls", async (t) => {
    const { w } = await revision2Round(t, 5);
    await w.cycle();
    const place = await w.lastAction();
    assert.equal(place.kind, "level-place");
    assert.deepEqual(place.plan.mints.map((mint) => [mint.orderKey, mint.tickLower, mint.tickUpper]), [["r1:l1", 54_000, 54_050], ["r1:l2", 53_850, 53_900]]);
    assert.equal(place.plan.quoteSpendWei, 20n * E18);
    assert.equal(w.provider.executeCalls.at(-1)!.calls.length, 6);
  });

  it("15. the same shape at N = 2 (a = 1) claims [L1] alone", async (t) => {
    const { w } = await revision2Round(t, 2);
    await w.cycle();
    assert.deepEqual((await w.lastAction()).plan.mints.map((mint) => mint.orderKey), ["r1:l1"]);
  });

  it("15. a start in flight from before R3 (no ladderAnchor) finishes on the legacy path, then level-places", async (t) => {
    const w = await world(t);
    const round = (await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "starting", p0UsdtWei: null, p0StockWei: null,
      costUsdtWei: 0n, stockAcquiredWei: 0n, carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: w.now }))!;
    const mid = dcaPriceAtTick(NV, NV_TICK);
    const quotedOutWei = 15n * E18 * mid.den / mid.num;
    const r3 = planDcaStart({ pool: NV, roundNo: 1, reading: { block: w.chain.block, tick: NV_TICK, sqrtPriceX96: getSqrtRatioAtTick(NV_TICK) },
      deadlineSec: BigInt(Math.floor(w.now / 1_000)) + 300n, swap: { side: "buy", amountInWei: 15n * E18, minOutWei: quotedOutWei * 99n / 100n, quotedOutWei,
        calls: buildTradfiPancakeV3Swap({ router: PANCAKE_V3_ROUTER_56, tokenIn: USDT_56, tokenOut: NV.stock, amountInWei: 15n * E18, minOutWei: quotedOutWei * 99n / 100n,
          recipient: WALLET, deadline: BigInt(Math.floor(w.now / 1_000)) + 300n, route: { hops: [], fees: [2500] } }) },
      feeWei: 0n, carriedCostWei: 0n, residueStockWei: 0n, takeProfitBps: 150, tpOrderKey: "r1:tp:1", ladder: { stepBps: 100, maxOrders: 4, orderWei: 10n * E18, rangeMinE8: null } });
    // Revision 2's start: the TP alone, no ladder anchor.
    const { ladderAnchor: _anchor, ...legacy } = { ...r3, mints: [r3.mints[0]!], quoteSpendWei: 15n * E18 };
    w.provider.nextReceipt = { status: "CONFIRMED", callsId: `0x${"c1".repeat(32)}`, transactionHash: `0x${"0e".repeat(32)}` as Hex };
    const submitted = await w.deps.dca!.executeRange({ agent: w.agent, pool: NV, round, sweep: false, settings: dcaEffective(),
      plan: { ...legacy, preSubmit: { walletUsdtWei: 100n * E18, walletStockWei: 0n }, relayQuoteWei: QUOTE } });
    assert.equal(submitted.kind, "submitted");
    await w.land({ firstTokenId: 700n, swapOutWei: quotedOutWei });
    w.chain.balances.set(NV.stock.toLowerCase(), quotedOutWei - legacy.mints[0]!.amount0Desired);
    await w.cycle(); // the legacy finish (pending rows from the receipt P0), then the first R3 placement
    const levels = (await w.store.listOrders(AGENT_ID, 1)).filter((row) => row.role === "level");
    assert.deepEqual(levels.map((row) => [row.orderKey, row.tickLower, row.tickUpper]), [
      ["r1:l1", 53_900, 53_950], ["r1:l2", 53_800, 53_850], ["r1:l3", 53_650, 53_700], ["r1:l4", 53_450, 53_500]]);
    const place = await w.lastAction();
    assert.equal(place.kind, "level-place");
    assert.deepEqual(place.plan.mints.map((mint) => mint.orderKey), ["r1:l1", "r1:l2"]);
  });

  it("C14 (review C5). a start that skips L1 overwrites the stale r1:l1 row a rolled-back attempt left, and the finish writes each key once", async (t) => {
    // A range min of 220: at 223.37 L1 (221.14) is in range and L2 is not; at 221.14 L1 (218.93) is not.
    const w = await world(t, { settings: { dcaRangeMinE8: "22000000000", dcaRangeMaxE8: "30000000000" } });
    w.provider.nextReceipt = { status: "FAILED", failureCode: "PROVIDER_ERROR" };
    w.now += 61_000;
    w.chain.block += 200n;
    await runTradeWorkerOnce(w.deps);
    const first = await w.lastAction();
    assert.deepEqual([first.kind, first.state, first.plan.mints.map((mint) => mint.orderKey).slice(1)], ["start", "rolled-back", ["r1:l1"]]);
    assert.equal((await w.orders(1)).find((row) => row.orderKey === "r1:l1")?.state, "pending", "the rollback left a stale pending L1");
    const finished: (readonly [string, string])[][] = [];
    const finishAction = w.store.finishAction.bind(w.store);
    t.mock.method(w.store, "finishAction", async (...args: Parameters<typeof finishAction>) => {
      finished.push(args[0].orders.map((row) => [row.orderKey, row.state] as const));
      return finishAction(...args);
    });
    w.chain.tick = 53_991; // the market fell 1 %: the retried start's anchor is lower
    await w.cycle();
    const second = await w.lastAction();
    assert.equal(second.kind, "start");
    assert.notDeepEqual(second.plan.ladderAnchor, first.plan.ladderAnchor);
    assert.deepEqual(second.plan.mints.map((mint) => mint.role), ["tp"], "L1 is below the range at the retried anchor");
    const mid = second.plan.ladderAnchor!;
    await w.land({ firstTokenId: 700n, swapOutWei: 15n * E18 * mid.den / mid.num });
    await w.cycle();
    assert.equal(finished.length, 1);
    assert.equal(new Set(finished[0]!.map(([key]) => key)).size, finished[0]!.length);
    // The finish itself writes every level of the retried anchor, overwriting the stale L1 (I13).
    assert.deepEqual(finished[0]!.filter(([key]) => /^r1:l\d$/u.test(key)),
      [["r1:l1", "skipped"], ["r1:l2", "skipped"], ["r1:l3", "skipped"], ["r1:l4", "skipped"]]);
    assert.deepEqual((await w.orders(1)).filter((row) => row.role === "level").map((row) => row.state), ["skipped", "skipped", "skipped", "skipped"]);
  });
});

describe("the protective steps (R2.8, R2.17, R2.18; conditions 1, 5, 10)", () => {
  async function breached(t: TestContext) {
    const w = await activeRound(t, { settings: { dcaStopLossBps: 1500 } });
    // A chain-only position in the pool: the store never learned of it (N1).
    const legs = dcaPoolLegs(NV);
    w.chain.positions.set(999n, { liquidity: 10n ** 15n, tickLower: 60_000, tickUpper: 60_050, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    w.chain.walletIds.push(999n);
    w.chain.tick = 40_000; // ≈ 55 USDT/stock: equity falls far below 85 % of the deposit
    await w.cycle(); // first breached reading
    return w;
  }

  it("the stop loss confirms on two readings, sweeps the UNION of store and chain, and only then stops and pauses", async (t) => {
    const w = await breached(t);
    assert.notEqual((await w.lastAction()).kind, "stop-loss");
    await w.cycle();
    const sweep = await w.lastAction();
    assert.equal(sweep.kind, "stop-loss");
    assert.equal(sweep.plan.swap, null, "I8: the stop loss sells nothing");
    assert.deepEqual(sweep.plan.exits.map((exit) => exit.tokenId).sort(), [700n, 701n, 702n, 999n]);
    await w.land({ firstTokenId: 0n });
    // A position appears again before the post-sweep read: condition 1 re-sweeps rather than writing `stopped`.
    const legs = dcaPoolLegs(NV);
    w.chain.positions.set(1_001n, { liquidity: 10n ** 15n, tickLower: 60_000, tickUpper: 60_050, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    w.chain.walletIds.push(1_001n);
    await w.cycle();
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.phase, "closing");
    assert.equal((await w.lastAction()).kind, "stop-loss");
    await w.land({ firstTokenId: 0n });
    await w.cycle();
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    assert.equal(round.phase, "stopped");
    assert.equal(round.unreliable, true, "a swept position the store never knew makes the round's ledger unreliable");
    assert.equal((await w.agents.getAgentById(AGENT_ID))?.status, "paused");
    assert.equal(await w.killswitch.isAgentPaused(AGENT_ID, OWNER), true);
  });

  it("M-2: a committed batch whose receipt stays unreadable holds the stop loss ten minutes, then the sweep runs", async (t) => {
    const w = await activeRound(t, { settings: { dcaStopLossBps: 1500 } });
    w.chain.tick = 53_890;
    await w.cycle();
    await w.cycle(); // L1's fill batch is committed; readFinalized answers null for it from here on
    const placed = await w.lastAction();
    assert.deepEqual([placed.kind, placed.state], ["fill", "committed"]);
    w.chain.tick = 40_000;
    await w.cycle();
    await w.cycle(); // the stop loss is confirmed, and waits for the committed batch
    assert.equal((await w.lastAction()).actionKey, placed.actionKey, "inside ten minutes the sweep waits");
    w.now = placed.createdAtMs + 11 * 60_000 - 61_000; // the next cycle runs 11 minutes after the placement
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "stop-loss");
    assert.equal((await w.store.getAction(OWNER, placed.actionKey))?.state, "committed");
  });

  it("H-2: a transport failure under position() is never read as burned — no empty sweep is written, and the resolver is unclear with errored", async (t) => {
    const down = createDcaChainReads({ rpcUrls: [await dcaRpcEndpoint(t)], nfpm: NFPM_56 });
    const burned = createDcaChainReads({ rpcUrls: [await dcaRpcEndpoint(t, "Invalid token ID")], nfpm: NFPM_56 });
    assert.equal(await burned.position(700n, 1n), "burned", "the NFPM's own revert still reads as burned");
    const w = await breached(t);
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    const plan: DcaBatchPlan = { ...(await w.lastAction()).plan, kind: "stop-loss", mints: [],
      exits: [{ orderKey: tp.orderKey, role: "tp", levelNo: null, tokenId: tp.tokenId!, tickLower: tp.tickLower, tickUpper: tp.tickUpper,
        liquidity: tp.liquidity, amount0Min: 0n, amount1Min: 0n }] };
    const evidence = await dcaUnknownEvidence({ reads: { ...w.deps.dca!.chain, position: down.position }, pool: NV, wallet: WALLET, plan,
      knownTokenIds: new Set([700n]), ageMs: 11 * 60_000 });
    assert.deepEqual([evidence.verdict, evidence.errored], ["unclear", true]);
    Object.assign(w.deps.dca!.chain, { position: down.position });
    await w.cycle(); // the confirming reading: every NFT read fails at the transport
    await w.cycle();
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.phase, "active", "an unreadable NFT is never swept past into `stopped`");
    assert.equal((await w.agents.getAgentById(AGENT_ID))?.status, "armed");
  });

  it("D12: the owner's unpause resumes a stopped round at a re-anchored baseline, and the TP is re-placed", async (t) => {
    const w = await activeRound(t, { settings: { dcaStopLossBps: 1500 } });
    w.chain.tick = 40_000;
    await w.cycle();
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "stop-loss");
    await w.land({ firstTokenId: 0n });
    const held = (await w.store.getOpenRound(OWNER, AGENT_ID))!.stockAcquiredWei;
    w.chain.balances.set(NV.stock.toLowerCase(), held);
    await w.cycle(); // finish ⇒ closing(stop-loss)
    await w.cycle(); // nothing rests ⇒ stopped + paused
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.phase, "stopped");
    const paused = (await w.agents.getAgentById(AGENT_ID))!;
    assert.ok(await w.agents.transitionAgentStatus({ ownerAddress: OWNER, agentId: AGENT_ID, expectedStatus: "paused", expectedRowVersion: paused.rowVersion, status: "armed" }));
    await w.killswitch.unpauseAgent(AGENT_ID, OWNER);
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-resumed/u);
    const resumed = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    assert.equal(resumed.phase, "active");
    assert.ok(resumed.slBaselineWei < 55n * E18, "the baseline is the equity at resume, not the deposit");
    await w.cycle();
    const replace = await w.lastAction();
    assert.equal(replace.kind, "tp-place");
    assert.equal(replace.plan.mints[0]!.amount0Desired, held);
    assert.equal((await w.agents.getAgentById(AGENT_ID))?.status, "armed", "the same stop cannot fire again at the resume equity");
  });

  it("B2: past an UNKNOWN action the stop loss still sweeps, while the strategy holds", async (t) => {
    const w = await breached(t);
    const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: round.roundNo, expectedRowVersion: round.rowVersion,
      plan: { ...(await w.lastAction()).plan, kind: "level-place" }, nowMs: w.now });
    assert.ok(claimed.kind === "claimed");
    await w.journal.beginWithSpend({ idempotencyKey: dcaIdempotencyKey(claimed.action.actionKey), agentId: AGENT_ID, ownerAddress: OWNER, kind: "dcaRange",
      decisionId: claimed.action.actionKey, externalRef: {}, nativeSpendWei: 0n }, 0);
    await w.journal.markUnknown(dcaIdempotencyKey(claimed.action.actionKey), "relay 300, aged by reconcile");
    await w.cycle();
    assert.equal((await w.store.getAction(OWNER, claimed.action.actionKey))?.state, "unknown");
    assert.equal((await w.lastAction()).kind, "stop-loss");
  });

  it("Remove for a PAUSED agent sweeps every order with the owner's floors, sells nothing, then settles `removed` with the unsold stock recorded", async (t) => {
    const w = await activeRound(t);
    assert.ok(await w.agents.transitionAgentStatus({ ownerAddress: OWNER, agentId: AGENT_ID, expectedStatus: "armed", expectedRowVersion: (await w.agents.getAgentById(AGENT_ID))!.rowVersion, status: "paused" }));
    await w.killswitch.pauseAgent(AGENT_ID, OWNER);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    await w.cycle();
    const remove = await w.lastAction();
    assert.equal(remove.kind, "remove");
    assert.equal(remove.plan.exits.length, 3, "the TP and the two resting levels");
    assert.equal(remove.plan.swap, null);
    const calls = w.provider.executeCalls.at(-1)!.calls;
    assert.ok(!calls.some((call) => call.to.toLowerCase() === GUARD.toLowerCase() || call.to.toLowerCase() === PANCAKE_V3_ROUTER_56.toLowerCase()), "no swap call in the batch");
    await w.land({ firstTokenId: 0n });
    await w.cycle(); // finish ⇒ closing(remove), then, in the same cycle, settles `removed` (nothing rests)
    const rounds = await w.store.listRounds(OWNER, AGENT_ID);
    const settled = rounds.at(-1)!;
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.ok(settled.unsoldStockWei !== null && settled.unsoldCostWei !== null && settled.unsoldValueWei !== null, "the removed round's ledger figures are booked");
    const mid = dcaMidPrice(NV, getSqrtRatioAtTick(NV_TICK));
    assert.equal(settled.unsoldValueWei, (settled.unsoldStockWei! * mid.num) / mid.den, "unsoldValueWei is the unsold stock at the settling reading's mid");
    assert.equal((await w.agents.getAgentById(AGENT_ID))?.status, "paused");
  });

  it("R4.4 vector: an outstanding UNKNOWN remove (the 1:3 shape) never holds the settle, and the strategy phase still holds on it", async (t) => {
    const w = await activeRound(t);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    // The first remove attempt (the "1:3" shape): its submit throws ⇒ UNKNOWN (R2.7 B2), no chain effect.
    w.provider.nextError = new Error("the relay went silent");
    await w.cycle();
    const first = await w.lastAction();
    assert.equal(first.kind, "remove");
    assert.equal(first.state, "unknown");
    w.provider.nextError = null;
    await w.cycle(); // unknown is never waited on ⇒ a fresh sweep submits (the "1:4" shape)
    const second = await w.lastAction();
    assert.notEqual(second.actionKey, first.actionKey);
    assert.equal(second.kind, "remove");
    await w.land({ firstTokenId: 0n });
    await w.cycle(); // finish, and, in the same cycle, settle `removed`: the still-unknown first action never holds it
    assert.equal((await w.store.getAction(OWNER, first.actionKey))?.state, "unknown", "1:3 stays unknown; only the operator's --apply resolves it");
    const settled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    // Both rows land this cycle (protective settles; strategy still holds on 1:3);
    // the two can share a timestamp, so this checks presence, not which sorts newest.
    const runs = await w.positions.listRuns(OWNER, AGENT_ID, 10);
    assert.ok(runs.some((run) => run.reason === "dca-removed"), "a protective run row reads dca-removed");
    assert.ok(runs.some((run) => /^dca-submission-unknown;/u.test(run.reason)), "the strategy phase's row still holds (1:3 is unknown)");
  });

  it("guard (c): an unknown level-place holds the settle for up to 600 000 ms; an unknown remove never holds", async (t) => {
    const w = await activeRound(t);
    // An old unknown mint-bearing action predates the drain: L1's fill submit throws ⇒ UNKNOWN.
    w.chain.tick = 53_890; // strictly below L1
    await w.cycle(); // first filled reading — a touch is never a fill
    w.provider.nextError = new Error("the relay went silent");
    await w.cycle(); // confirmed ⇒ the fill's submit throws ⇒ UNKNOWN, mint-bearing
    const fillAction = await w.lastAction();
    assert.equal(fillAction.kind, "fill");
    assert.equal(fillAction.state, "unknown");
    assert.ok(fillAction.plan.mints.length > 0);
    w.provider.nextError = null;
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    await w.cycle(); // the remove sweep submits despite the still-unknown fill (never waited on)
    const remove = await w.lastAction();
    assert.equal(remove.kind, "remove");
    await w.land({ firstTokenId: 0n });
    await w.cycle(); // finish ⇒ closing(remove); guard (c) holds on the still-young unknown mint
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.phase, "closing", "guard (c) holds while the unknown mint is young");
    const holding = await w.positions.listRuns(OWNER, AGENT_ID, 10);
    assert.ok(holding.some((run) => run.reason === "dca-removing:waiting-for-an-unknown-mint"), "a protective row holds on the young unknown mint");
    w.now += 600_000; // now well past the 600 000 ms wait
    await w.cycle();
    const settled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(settled.phase, "settled", "guard (c) expires and the round settles");
  });

  it("DCA_ENABLED off: no round starts, but Remove (the exit subset) still runs and settles (D17)", async (t) => {
    const w = await activeRound(t);
    (w.deps.dca as { enabled: boolean }).enabled = false;
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-disabled/u);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    await w.cycle();
    assert.equal((await w.lastAction()).kind, "remove");
    await w.land({ firstTokenId: 0n });
    await w.cycle(); // finish ⇒ closing(remove)
    await w.cycle(); // nothing rests ⇒ settled
    assert.equal((await w.store.listRounds(OWNER, AGENT_ID)).at(-1)?.closeCause, "removed");
  });

  it("no open round: the last round's carried residue is left in the wallet — no round is inserted, nothing is submitted, no protective run row (D-R4-2)", async (t) => {
    const w = await world(t);
    const inserted = await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 60n * E18, costUsdtWei: 15n * E18, stockAcquiredWei: 60n * E18,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 0n, nowMs: w.now });
    assert.ok(inserted !== null);
    await w.store.writeRound({ ...inserted, phase: "settled", closeCause: "take-profit", realizedPnlWei: 5n * E18,
      carriedStockWei: 1_000_000n, carriedCostWei: 250_000n, settledAtMs: w.now });
    w.chain.balances.set(NV.stock.toLowerCase(), 1_000_000n); // the carried residue, still in the wallet
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    const before = (await w.store.listRounds(OWNER, AGENT_ID)).length;
    const runsBefore = (await w.positions.listRuns(OWNER, AGENT_ID, 200)).length;
    for (let i = 0; i < 3; i += 1) await w.cycle();
    assert.equal((await w.store.listRounds(OWNER, AGENT_ID)).length, before, "no round is inserted");
    assert.equal(w.provider.executeCalls.length, 0, "nothing is submitted");
    const runsAfter = await w.positions.listRuns(OWNER, AGENT_ID, 200);
    assert.equal(runsAfter.length - runsBefore, 3, "one strategy row per cycle; no protective row (the deleted branch returns null)");
    assert.ok(runsAfter.slice(0, 3).every((run) => run.reason.startsWith("dca-removing;")));
  });
});

describe("R4.3: the removed round's PnL, to the wei (V-R4-1, V-R4-2)", () => {
  const VECTOR_TICK = 54_161;
  const H = 66_718_561_514_265_962n;
  const C = 15_000_000_000_000_000_000n;

  async function removedVector(t: TestContext, legacy?: { readonly amountInWei: bigint; readonly saleProceedsWei: bigint }) {
    const w = await world(t);
    const inserted = await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "active",
      p0UsdtWei: null, p0StockWei: null, costUsdtWei: C, stockAcquiredWei: H,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 0n, nowMs: w.now });
    assert.ok(inserted !== null);
    // "TP collected = minted": the TP was exited but never converted, so it sold nothing (tpSold = 0).
    await w.store.putOrder({ agentId: AGENT_ID, roundNo: 1, orderKey: "r1:tp", role: "tp", levelNo: null,
      tickLower: 54_100, tickUpper: 54_200, tokenId: null, state: "exited", liquidity: 0n,
      mintedUsdtWei: 0n, mintedStockWei: H, collectedUsdtWei: 0n, collectedStockWei: H,
      crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null, exitedByAction: null,
      lastSeenLiveBlock: null, closedBy: "plane", updatedAtMs: w.now });
    if (legacy !== undefined) {
      const plan: DcaBatchPlan = { kind: "remove", roundNo: 1, readingBlock: 100n, tick: VECTOR_TICK, sqrtPriceX96: getSqrtRatioAtTick(VECTOR_TICK),
        deadlineSec: 1n, exits: [], mints: [], feeWei: 0n, quoteSpendWei: 0n, tpTarget: null,
        swap: { side: "sell", amountInWei: legacy.amountInWei, minOutWei: 0n, calls: [] } };
      const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, expectedRowVersion: inserted.rowVersion, plan, nowMs: w.now });
      assert.ok(claimed.kind === "claimed");
      await w.store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "committed", txHash: `0x${"e1".repeat(32)}` as Hex, nowMs: w.now });
      const afterClaim = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
      await w.store.finishAction({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, plan,
        roundWrites: [{ ...afterClaim, saleProceedsWei: legacy.saleProceedsWei }], roundInserts: [], orders: [], nowMs: w.now });
    }
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    w.chain.tick = VECTOR_TICK;
    await w.cycle(); // empty chain, no live orders ⇒ settles directly
    return (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
  }

  it("V-R4-1: an R4 Remove with the TP untouched", async (t) => {
    const settled = await removedVector(t);
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.equal(settled.realizedPnlWei, 0n);
    assert.equal(settled.unsoldStockWei, 66_718_561_514_265_962n);
    assert.equal(settled.unsoldCostWei, 15_000_000_000_000_000_000n);
    assert.equal(settled.unsoldValueWei, 15_007_605_888_887_429_399n);
  });

  it("V-R4-2: the live agent's shape, with a legacy sale", async (t) => {
    const settled = await removedVector(t, { amountInWei: 66_057_988_342_558_760n, saleProceedsWei: 14_948_000_000_000_000_000n });
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.equal(settled.realizedPnlWei, 96_513_357_463_340_155n);
    assert.equal(settled.unsoldStockWei, 660_573_171_707_202n);
    assert.equal(settled.unsoldCostWei, 148_513_357_463_340_155n);
    assert.equal(settled.unsoldValueWei, 148_588_662_536_351_170n);
  });

  it("extraSoldWei clamps at H: a legacy sale larger than the round's stock leaves nothing unsold", async (t) => {
    const settled = await removedVector(t, { amountInWei: H + 1_000_000n, saleProceedsWei: 20_000_000_000_000_000_000n });
    assert.equal(settled.unsoldStockWei, 0n);
    assert.equal(settled.unsoldCostWei, 0n);
    assert.equal(settled.unsoldValueWei, 0n);
    assert.equal(settled.realizedPnlWei, 20_000_000_000_000_000_000n - C, "costSold clamps at C once sold clamps at H");
  });
});

describe("unbooked order at the settle (R4.3)", () => {
  it("a live order the chain shows gone, whose log read fails this cycle, settles `removed` and unreliable", async (t) => {
    const w = await world(t);
    const inserted = await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 60n * E18, costUsdtWei: 15n * E18, stockAcquiredWei: 60n * E18,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 0n, nowMs: w.now });
    assert.ok(inserted !== null);
    await w.store.putOrder({ agentId: AGENT_ID, roundNo: 1, orderKey: "r1:tp", role: "tp", levelNo: null,
      tickLower: 54_100, tickUpper: 54_200, tokenId: 900n, state: "live", liquidity: 500n,
      mintedUsdtWei: 0n, mintedStockWei: 60n * E18, collectedUsdtWei: 0n, collectedStockWei: 0n,
      crossCount: 0, crossLastBlock: w.chain.block, crossLastAtMs: w.now, createdByAction: null, exitedByAction: null,
      lastSeenLiveBlock: w.chain.block, closedBy: null, updatedAtMs: w.now });
    w.chain.logsThrow = true;
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    await w.cycle();
    const settled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.equal(settled.unreliable, true);
  });
});

describe("AUTO-DCA R4 audit fixes", () => {
  it("MEDIUM 3: finishDcaAction's settled-round guard leaves an already-settled round untouched, but still finishes the stale action and its orders", async (t) => {
    const w = await activeRound(t);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    await w.cycle(); // submits the remove sweep (TP, L1, L2)
    const stale = await w.lastAction();
    assert.equal(stale.kind, "remove");
    await w.cycle(); // reconcile marks it committed; no receipt is readable yet
    const committed = await w.store.getAction(OWNER, stale.actionKey);
    assert.equal(committed?.state, "committed");
    const staleTxHash = committed!.txHash!;
    // The batch really landed on chain (M-2's shape): its positions are gone,
    // but the worker still cannot read its own receipt.
    for (const exit of stale.plan.exits) {
      const current = w.chain.positions.get(exit.tokenId);
      if (current !== undefined) w.chain.positions.set(exit.tokenId, { ...current, liquidity: 0n });
    }
    w.now += 11 * 60_000; // past DCA_COMMITTED_WAIT_MS: the wait no longer blocks
    await w.cycle(); // sweepOrders is empty ⇒ settles `removed`; the committed action stays unresolved
    const settled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.equal((await w.store.getAction(OWNER, stale.actionKey))?.state, "committed", "still unresolved when the round settles");
    // The receipt finally becomes readable, under the tx hash the journal recorded.
    const calls = dcaBatchCalls(stale.plan, { pool: NV, nfpm: NFPM_56, wallet: WALLET, treasury: TREASURY });
    w.observations.set(staleTxHash, dcaObservation(calls, planLogs(stale.plan, NV, { firstTokenId: 0n }), staleTxHash));
    await w.cycle(); // finishDcaAction now runs for a round already settled
    assert.equal((await w.store.getAction(OWNER, stale.actionKey))?.state, "finished", "the action itself still finishes");
    const stillSettled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(stillSettled.phase, "settled", "the settled-round guard leaves the round untouched");
    assert.equal(stillSettled.closeCause, "removed");
    // The guard means the round is never written at all this cycle — not even
    // to a value that happens to read back the same — so its rowVersion does
    // not move. (Without the guard, the round write self-heals within the
    // same cycle's next protective step, back to an equal-looking `settled`
    // row — a value comparison alone would not catch that regression.)
    assert.equal(stillSettled.rowVersion, settled.rowVersion, "the round is never written this cycle");
    const orders = await w.store.listOrders(AGENT_ID, stillSettled.roundNo);
    assert.ok(stale.plan.exits.every((exit) => orders.find((row) => row.tokenId === exit.tokenId)?.state === "exited"), "order rows still move to exited");
  });

  it("MEDIUM 5(2): the R4.4 fixture as specified settles removed on the first cycle with nothing submitted", async (t) => {
    const w = await world(t);
    const inserted = await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 60n * E18, costUsdtWei: 15n * E18, stockAcquiredWei: 60n * E18,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 0n, nowMs: w.now });
    assert.ok(inserted !== null);
    // The round's orders are exited (a sweep already landed for real).
    await w.store.putOrder({ agentId: AGENT_ID, roundNo: 1, orderKey: "r1:tp", role: "tp", levelNo: null,
      tickLower: 54_100, tickUpper: 54_200, tokenId: 900n, state: "exited", liquidity: 0n,
      mintedUsdtWei: 0n, mintedStockWei: 60n * E18, collectedUsdtWei: 0n, collectedStockWei: 60n * E18,
      crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null, exitedByAction: null,
      lastSeenLiveBlock: null, closedBy: "plane", updatedAtMs: w.now });
    const closingWritten = await w.store.writeRound({ ...inserted, phase: "closing", closeCause: "remove",
      revertStreak: 3, backoffUntilMs: w.now + 10 * 60_000 });
    assert.ok(closingWritten !== null);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    const closing = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    assert.equal(closing.phase, "closing");
    // One unknown `remove` action, with exits and no mints (the live agent's 1:3 shape).
    const plan: DcaBatchPlan = { kind: "remove", roundNo: 1, readingBlock: 100n, tick: NV_TICK, sqrtPriceX96: getSqrtRatioAtTick(NV_TICK),
      deadlineSec: 1n, exits: [{ orderKey: "r1:tp", role: "tp", levelNo: null, tokenId: 900n, tickLower: 54_100, tickUpper: 54_200,
        liquidity: 500n, amount0Min: 0n, amount1Min: 0n }], mints: [], swap: null, feeWei: 0n, quoteSpendWei: 0n, tpTarget: null };
    const claimed = await w.store.claimAction({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: closing.roundNo,
      expectedRowVersion: closing.rowVersion, plan, nowMs: w.now });
    assert.ok(claimed.kind === "claimed");
    await w.store.setActionState({ ownerAddress: OWNER, actionKey: claimed.action.actionKey, from: ["intended"], to: "unknown", nowMs: w.now });
    w.chain.balances.set(NV.stock.toLowerCase(), 1_000_000n); // stock in the wallet
    const submitted = w.provider.executeCalls.length;
    await w.cycle(); // an empty chain and no mint-bearing unknown ⇒ settles on this first cycle
    assert.equal(w.provider.executeCalls.length, submitted, "nothing is submitted");
    const settled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.equal((await w.store.getAction(OWNER, claimed.action.actionKey))?.state, "unknown", "the unknown remove is left untouched");
  });

  it("MEDIUM 6: the settle derives dcaCarryOut/unsold_* from `fresh` inside the fence, not the pre-fence round", async (t) => {
    const w = await world(t);
    const inserted = await w.store.insertRound({ agentId: AGENT_ID, ownerAddress: OWNER, roundNo: 1, phase: "active",
      p0UsdtWei: null, p0StockWei: null, costUsdtWei: 15n * E18, stockAcquiredWei: 60n * E18,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 0n, nowMs: w.now });
    assert.ok(inserted !== null);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    // Simulate a second writer (another worker process) booking a late collect
    // between `runDcaProtective`'s pre-fence round read (call 2 this cycle —
    // call 1 is `runDcaProjection`'s own gating fetch) and the fence's own
    // re-read. If the settle read the pre-fence copy, this collect would be
    // silently overwritten.
    let calls = 0;
    const originalGetOpenRound = w.store.getOpenRound.bind(w.store);
    Object.assign(w.store, {
      getOpenRound: async (...args: Parameters<typeof originalGetOpenRound>) => {
        calls += 1;
        const result = await originalGetOpenRound(...args);
        if (calls === 2 && result !== null) await w.store.writeRound({ ...result, usdtCollectedWei: result.usdtCollectedWei + 5n * E18 });
        return result;
      },
    });
    await w.cycle(); // empty chain, no live orders ⇒ settles directly
    const settled = (await w.store.listRounds(OWNER, AGENT_ID)).at(-1)!;
    assert.equal(settled.phase, "settled");
    assert.equal(settled.closeCause, "removed");
    assert.equal(settled.realizedPnlWei, 5n * E18, "realized reflects `fresh`'s collected USDT, not the stale pre-fence round's");
  });
});

describe("R2.11 / R2.12: pause and owner-closed orders", () => {
  it("a paused agent gets observation and no strategy submission", async (t) => {
    const w = await activeRound(t);
    assert.ok(await w.agents.transitionAgentStatus({ ownerAddress: OWNER, agentId: AGENT_ID, expectedStatus: "armed", expectedRowVersion: (await w.agents.getAgentById(AGENT_ID))!.rowVersion, status: "paused" }));
    w.chain.tick = 53_955; // L1 would be due
    const submitted = w.provider.executeCalls.length;
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    await w.cycle();
    assert.equal(w.provider.executeCalls.length, submitted);
    assert.equal((await w.orders()).find((row) => row.orderKey === tp.orderKey)?.lastSeenLiveBlock, w.chain.block, "observation ran");
  });

  async function pulledTp(t: TestContext, recipient: Address, window = 100n) {
    const w = await activeRound(t);
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    w.chain.positions.set(tp.tokenId!, { ...w.chain.positions.get(tp.tokenId!)!, liquidity: 0n });
    const pullHash = `0x${"ab".repeat(32)}` as Hex;
    w.chain.logs.set(tp.tokenId!, [{ transactionHash: pullHash, blockNumber: tp.lastSeenLiveBlock! + 1n, topic: DCA_NFPM_COLLECT_TOPIC }]);
    w.ownerReceipts.set(pullHash, { status: 1n, transactionHash: pullHash, blockNumber: tp.lastSeenLiveBlock! + 1n, blockHash: `0x${"bb".repeat(32)}`,
      transactionIndex: 0n, logs: [
        { ...nfpmLog(DCA_NFPM_COLLECT_TOPIC, tp.tokenId!, recipient, tp.mintedStockWei - 1n, 0n), logIndex: 0n },
        { ...transferLog(NV.stock, NV.pool, recipient, tp.mintedStockWei - 1n), logIndex: 1n },
      ] });
    w.chain.block = tp.lastSeenLiveBlock! + window - 200n; // cycle() adds 200
    await w.cycle();
    return { w, tp };
  }

  it("an owner pull is booked from its own Collect receipt (owner-closed)", async (t) => {
    const { w, tp } = await pulledTp(t, WALLET);
    const booked = (await w.store.listOrders(AGENT_ID, 1)).find((row) => row.orderKey === tp.orderKey)!;
    assert.equal(booked.state, "exited");
    assert.equal(booked.closedBy, "owner");
    assert.equal(booked.collectedStockWei, tp.mintedStockWei - 1n);
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.unreliable, false);
  });

  it("a Collect to another address is collected-elsewhere: unreliable, and the strategy says so", async (t) => {
    const { w } = await pulledTp(t, OUTSIDER);
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.unreliable, true);
    assert.match(await w.lastRunReason(), /^dca-collected-elsewhere/u);
  });

  it("condition 3: a window past 8 000 blocks is unreliable; a failed log read is no evidence and retries", async (t) => {
    const far = await pulledTp(t, WALLET, 8_500n);
    assert.equal((await far.w.store.getOpenRound(OWNER, AGENT_ID))?.unreliable, true);
  });

  it("condition 3: a log RPC error writes nothing and waits", async (t) => {
    const w = await activeRound(t);
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    w.chain.positions.set(tp.tokenId!, { ...w.chain.positions.get(tp.tokenId!)!, liquidity: 0n });
    w.chain.logsThrow = true;
    await w.cycle();
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.unreliable, false);
    assert.equal((await w.orders()).find((row) => row.orderKey === tp.orderKey)?.state, "live");
  });
});

describe("the dcaRange UNKNOWN resolver (R2.8, conditions 3 and 16)", () => {
  it("LANDED is automatic: the chain shows the mint, the logs name the tx, the receipt verifies, the start finishes", async (t) => {
    const w = await world(t);
    w.provider.nextError = new Error("the relay went silent");
    await w.cycle();
    const start = await w.lastAction();
    assert.equal(start.state, "unknown");
    w.provider.nextError = null;
    const p0 = dcaPriceAtTick(NV, NV_TICK);
    await w.land({ firstTokenId: 700n, swapOutWei: 15n * E18 * p0.den / p0.num });
    const landedHash = w.provider.nextReceipt.transactionHash!;
    w.chain.logs.set(700n, [{ transactionHash: landedHash, blockNumber: start.plan.readingBlock + 3n, topic: DCA_NFPM_COLLECT_TOPIC }]);
    await w.cycle();
    assert.equal((await w.store.getAction(OWNER, start.actionKey))?.state, "finished");
    assert.equal((await w.journal.getByDecision(AGENT_ID, start.actionKey))?.state, "COMMITTED");
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.phase, "active");
  });

  it("NOT LANDED needs every read answered, intact exits, no mint, unchanged balances and ten minutes; relay 300 is only printed", async (t) => {
    const w = await activeRound(t);
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    const plan: DcaBatchPlan = { ...(await w.lastAction()).plan, kind: "fill",
      exits: [{ orderKey: tp.orderKey, role: "tp", levelNo: null, tokenId: tp.tokenId!, tickLower: tp.tickLower, tickUpper: tp.tickUpper,
        liquidity: tp.liquidity, amount0Min: 0n, amount1Min: 0n }],
      mints: [{ ...(await w.lastAction()).plan.mints[0]!, tickLower: 60_000, tickUpper: 60_050 }],
      preSubmit: { walletUsdtWei: w.chain.balances.get(USDT_56.toLowerCase()) ?? 0n, walletStockWei: w.chain.balances.get(NV.stock.toLowerCase()) ?? 0n } };
    const reads = w.deps.dca!.chain;
    const known = new Set([700n]);
    const base = { reads, pool: NV, wallet: WALLET, plan, knownTokenIds: known, relayStatus: "PENDING (300)" };
    assert.equal((await dcaUnknownEvidence({ ...base, ageMs: 11 * 60_000 })).verdict, "not-landed");
    assert.equal((await dcaUnknownEvidence({ ...base, ageMs: 9 * 60_000 })).verdict, "unclear");
    w.chain.balances.set(USDT_56.toLowerCase(), 1n);
    assert.equal((await dcaUnknownEvidence({ ...base, ageMs: 11 * 60_000 })).verdict, "unclear", "a changed balance is not absence");
    w.chain.readingThrows = true;
    const errored = await dcaUnknownEvidence({ ...base, ageMs: 11 * 60_000 });
    assert.deepEqual([errored.verdict, errored.errored], ["unclear", true]);
    w.chain.readingThrows = false;
    w.chain.balances.set(USDT_56.toLowerCase(), plan.preSubmit!.walletUsdtWei);
    w.chain.positionThrows.add(tp.tokenId!);
    const exitReadFailed = await dcaUnknownEvidence({ ...base, ageMs: 11 * 60_000 });
    assert.deepEqual([exitReadFailed.verdict, exitReadFailed.errored], ["unclear", true], "one failed read is no evidence of absence");
    w.chain.positionThrows.clear();
    w.chain.positions.set(tp.tokenId!, { ...w.chain.positions.get(tp.tokenId!)!, liquidity: 0n });
    const landed = await dcaUnknownEvidence({ ...base, ageMs: 0 });
    assert.deepEqual([landed.verdict, landed.landedTokenId], ["landed", tp.tokenId]);
    assert.ok(landed.checks.some((check) => check.name === "relay-status" && /never proof/u.test(check.result)));
  });

  it("R4.5 (I18): a booked exit is superseded; a pending one is unclear; unknown others are ignored", async (t) => {
    const w = await activeRound(t);
    const tp = (await w.orders()).find((row) => row.role === "tp" && row.state === "live")!;
    const l1 = (await w.orders()).find((row) => row.role === "level" && row.state === "live")!;
    const plan: DcaBatchPlan = { ...(await w.lastAction()).plan, kind: "remove",
      exits: [
        { orderKey: tp.orderKey, role: "tp", levelNo: null, tokenId: tp.tokenId!, tickLower: tp.tickLower, tickUpper: tp.tickUpper, liquidity: tp.liquidity, amount0Min: 0n, amount1Min: 0n },
        { orderKey: l1.orderKey, role: "level", levelNo: l1.levelNo, tokenId: l1.tokenId!, tickLower: l1.tickLower, tickUpper: l1.tickUpper, liquidity: l1.liquidity, amount0Min: 0n, amount1Min: 0n },
      ],
      mints: [], swap: null,
      preSubmit: { walletUsdtWei: w.chain.balances.get(USDT_56.toLowerCase()) ?? 0n, walletStockWei: w.chain.balances.get(NV.stock.toLowerCase()) ?? 0n } };
    w.chain.positions.set(tp.tokenId!, { ...w.chain.positions.get(tp.tokenId!)!, liquidity: 0n });
    const reads = w.deps.dca!.chain;
    const base = { reads, pool: NV, wallet: WALLET, plan, knownTokenIds: new Set([tp.tokenId!, l1.tokenId!]), ageMs: 0 };
    const bTxHash = "0xb03885e7c3cb57b2639319d454e41468338c5fa0f6148c48ff876e7f256db15c" as Hex;
    const finishedOther = [{ actionKey: "dca:other:1:4", state: "finished", txHash: bTxHash, plan: { exits: [plan.exits[0]!] } }];

    const superseded = await dcaUnknownEvidence({ ...base, others: finishedOther });
    assert.equal(superseded.verdict, "superseded");
    assert.equal(superseded.landedTokenId, null);
    assert.ok(superseded.checks.some((check) => check.name === "superseded-by" && check.result === `dca:other:1:4 tx ${bTxHash}`));
    assert.ok(superseded.checks.some((check) => check.name === `exit-${tp.tokenId}` && check.result.includes(`exited by dca:other:1:4 (finished, tx ${bTxHash})`)));

    // Audit MEDIUM 5(1): the booked predicate requires a `finished` other, not
    // merely "not unknown" — a same-tokenId `committed` other on this same
    // liquidity-0 exit must not count as booked, and the verdict falls back
    // to today's landed path.
    const committedNotUnknownOther = [{ actionKey: "dca:other:1:9", state: "committed", txHash: null, plan: { exits: [plan.exits[0]!] } }];
    const widenedPredicateCheck = await dcaUnknownEvidence({ ...base, others: committedNotUnknownOther });
    assert.equal(widenedPredicateCheck.verdict, "landed", "a committed (not finished) other must not count as booked");

    // l1's own chain liquidity is unchanged (still live): a same-tokenId in-flight
    // other makes it "pending", not booked — a booked exit needs liquidity 0.
    const committedOther = [{ actionKey: "dca:other:1:5", state: "committed", txHash: null, plan: { exits: [plan.exits[1]!] } }];
    const unclear = await dcaUnknownEvidence({ ...base, others: committedOther });
    assert.equal(unclear.verdict, "unclear");
    assert.ok(unclear.checks.some((check) => check.name === `exit-${l1.tokenId}` && check.result.includes("not booked yet")));

    const noOthers = await dcaUnknownEvidence(base);
    assert.equal(noOthers.verdict, "landed", "no B at all: today's landed path");

    const unknownOther = [{ actionKey: "dca:other:1:6", state: "unknown", txHash: null, plan: { exits: [plan.exits[0]!] } }];
    const ignoredUnknown = await dcaUnknownEvidence({ ...base, others: unknownOther });
    assert.equal(ignoredUnknown.verdict, "landed", "an unknown other is ignored: today's landed path applies");

    // A failed read on the OTHER exit is no evidence of absence, but does not
    // stop a booked exit from calling the whole action superseded.
    w.chain.positionThrows.add(l1.tokenId!);
    const supersededErrored = await dcaUnknownEvidence({ ...base, others: finishedOther });
    w.chain.positionThrows.clear();
    assert.deepEqual([supersededErrored.verdict, supersededErrored.errored], ["superseded", true]);

    // Order does not matter (audit LOW 7): reorder the inputs for real — both
    // exits now read liquidity 0, each explained by a different finished
    // other, and the two orderings of `others` (and of the exits each one
    // targets) agree on the verdict and on the set of superseded-by checks.
    w.chain.positions.set(l1.tokenId!, { ...w.chain.positions.get(l1.tokenId!)!, liquidity: 0n });
    const otherTp = { actionKey: "dca:other:1:4", state: "finished", txHash: bTxHash, plan: { exits: [plan.exits[0]!] } };
    const otherL1 = { actionKey: "dca:other:1:7", state: "finished", txHash: `0x${"c7".repeat(32)}` as Hex, plan: { exits: [plan.exits[1]!] } };
    const forward = await dcaUnknownEvidence({ ...base, others: [otherTp, otherL1] });
    const reversed = await dcaUnknownEvidence({ ...base, others: [otherL1, otherTp] });
    assert.equal(forward.verdict, "superseded");
    assert.equal(reversed.verdict, "superseded");
    const supersededByOf = (evidence: typeof forward) => new Set(evidence.checks.filter((check) => check.name === "superseded-by").map((check) => check.result));
    assert.deepEqual(supersededByOf(forward), supersededByOf(reversed));
    assert.deepEqual(supersededByOf(forward), new Set([`dca:other:1:4 tx ${bTxHash}`, `dca:other:1:7 tx 0x${"c7".repeat(32)}`]));
  });

  it("worker resolver: resolveDcaUnknownLanded never advances or finishes a superseded action", async (t) => {
    const w = await activeRound(t);
    await w.settingsStore.requestDrain(OWNER, AGENT_ID);
    // "A": the first remove attempt goes UNKNOWN (relay 300), no chain effect.
    w.provider.nextError = new Error("the relay went silent");
    await w.cycle();
    const first = await w.lastAction();
    assert.equal(first.state, "unknown");
    w.provider.nextError = null;
    await w.cycle(); // "B": a fresh sweep submits
    await w.land({ firstTokenId: 0n });
    await w.cycle(); // B finishes with a verified receipt; the resolver must not touch A automatically
    const after = await w.store.getAction(OWNER, first.actionKey);
    assert.equal(after?.state, "unknown", "never advanced to committed or finished");
    assert.equal((await w.journal.getByDecision(AGENT_ID, first.actionKey))?.state, "UNKNOWN", "the journal stays UNKNOWN");
  });

  it("the operator script is read-only without --apply and refuses --apply on errored or non-not-landed/superseded evidence", () => {
    const script = readFileSync(new URL("../scripts/dca-resolve.ts", import.meta.url), "utf8");
    assert.match(script, /if \(!args\.apply\) return;/u);
    assert.match(script, /if \(evidence\.errored\) throw new Error\("Refusing --apply/u);
    assert.match(script, /if \(evidence\.verdict !== "not-landed" && evidence\.verdict !== "superseded"\) throw new Error\(`Refusing --apply/u);
    assert.ok(script.indexOf("journal.resolveUnknown") > script.indexOf("if (!args.apply) return;"));
    // R4.5: superseded's disposition text is written only past the early return, same as not-landed's.
    assert.match(script, /dcaRange superseded: ROLLED_BACK by the operator/u);
    assert.ok(script.indexOf("dcaRange superseded") > script.indexOf("if (!args.apply) return;"));
    assert.ok(script.indexOf("if (evidence.errored)") < script.indexOf("dcaRange superseded"), "errored still refuses before either disposition is written");
    // Audit MEDIUM 4: the superseded branch's write target is `rolled-back`, never `finished` —
    // `rolled-back` is what releases the action's own order marks (dcaRounds.ts).
    const supersededStart = script.indexOf('if (evidence.verdict === "superseded") {');
    assert.ok(supersededStart >= 0);
    const supersededEnd = script.indexOf('console.log("[dca-resolve] applied', supersededStart);
    assert.ok(supersededEnd > supersededStart);
    const supersededSlice = script.slice(supersededStart, supersededEnd);
    assert.match(supersededSlice, /to: "rolled-back",\s*note: "operator: superseded"/u);
    assert.doesNotMatch(supersededSlice, /to: "finished"/u);
  });
});

describe("R2.13 revert backoff (condition 2)", () => {
  it("backs off at 3 and holds at 6 until an owner action", async (t) => {
    const w = await activeRound(t);
    let round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
    round = (await w.store.writeRound({ ...round, revertStreak: 3, backoffUntilMs: w.now + 10 * 60_000 }))!;
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-retry-backoff/u);
    await w.store.writeRound({ ...round, revertStreak: 6, backoffUntilMs: w.now });
    await w.cycle();
    assert.match(await w.lastRunReason(), /^dca-retry-exhausted/u);
    const settings = dcaSettings({ slippageBps: 150 });
    await w.settingsStore.put({ agentId: AGENT_ID, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
    await w.cycle();
    assert.doesNotMatch(await w.lastRunReason(), /^dca-retry-exhausted/u);
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.revertStreak, 0);
  });

  it("an on-chain revert of a strategy batch counts toward the streak", async (t) => {
    const w = await activeRound(t);
    w.chain.tick = 53_890;
    await w.cycle(); // L1's first filled reading
    w.provider.nextReceipt = { status: "FAILED", failureCode: "PROVIDER_ERROR" };
    w.now += 61_000;
    w.chain.block += 200n;
    await runTradeWorkerOnce(w.deps);
    assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.revertStreak, 1);
  });
});

describe("source-level fences", () => {
  const worker = readFileSync(new URL("../src/trade/worker.ts", import.meta.url), "utf8");
  const dcaSources = ["../src/trade/dca.ts", "../src/trade/dcaExecute.ts", "../src/trade/dcaResolve.ts", "../src/store/dcaRounds.ts"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

  it("condition 15: the worker is widened only by transitionAgentStatus and pauseAgent, used once, in the stop loss", () => {
    assert.match(worker, /readonly agentStore: Pick<AgentStore, "getAgentById" \| "transitionAgentStatus">;/u);
    assert.match(worker, /readonly killswitch\?: Pick<KillSwitch, "pauseAgent">;/u);
    assert.equal(worker.match(/\.transitionAgentStatus\(/gu)?.length, 1);
    assert.equal(worker.match(/\.pauseAgent\(/gu)?.length, 1);
    assert.doesNotMatch(worker, /\.(updateAgentStatus|unpauseAgent)\(/u);
    for (const source of dcaSources) assert.doesNotMatch(source, /transitionAgentStatus|updateAgentStatus|pauseAgent|unpauseAgent/u);
    const stopBranch = worker.slice(worker.indexOf("async function runDcaProtective"), worker.indexOf("// Remove (R2.18)"));
    assert.ok(stopBranch.includes("expectedStatus: \"armed\"") && stopBranch.includes("status: \"paused\""));
  });

  it("I8: the stop-loss branch reaches no swap pricing or swap builder", () => {
    const stopBranch = worker.slice(worker.indexOf("async function runDcaProtective"), worker.indexOf("// Remove (R2.18)"));
    assert.ok(stopBranch.includes("planDcaStopLoss("));
    assert.doesNotMatch(stopBranch, /priceTradfiV2Sell|priceTradfiV2Buy|dcaSwapLeg|buildV2CostCalls|buildTradfi/u);
  });

  it("I15: Remove never builds a swap leg (source pins)", () => {
    const start = worker.indexOf("// Remove (R2.18)");
    assert.ok(start >= 0);
    const end = worker.indexOf("\n}", start); // CRLF-safe: the first column-0 `}` after the literal, runDcaProtective's closing brace
    const removeSlice = worker.slice(start, end);
    assert.ok(removeSlice.includes("planDcaRemove("));
    assert.doesNotMatch(removeSlice, /priceTradfiV2Sell|dcaSwapLeg\(|buildV2CostCalls|buildTradfi|DCA_DUST_USDT_WEI/u);
    const dca = readFileSync(new URL("../src/trade/dca.ts", import.meta.url), "utf8");
    const planStart = dca.indexOf("export function planDcaRemove(");
    assert.ok(planStart >= 0);
    const planEnd = dca.indexOf("\n}", planStart);
    assert.doesNotMatch(dca.slice(planStart, planEnd), /swap|sale/u);
  });
});

describe("I15: no market sale, for an active round, a stopped round and a paused agent", () => {
  it("every submitted Remove batch has swap === null", async (t) => {
    const active = await activeRound(t);
    await active.settingsStore.requestDrain(OWNER, AGENT_ID);
    await active.cycle();
    assert.equal((await active.lastAction()).plan.swap, null);
    assert.ok(!active.provider.executeCalls.at(-1)!.calls.some((c) => c.to.toLowerCase() === GUARD.toLowerCase()
      || c.to.toLowerCase() === PANCAKE_V3_ROUTER_56.toLowerCase()), "the Remove batch itself carries no swap call");

    const paused = await activeRound(t);
    assert.ok(await paused.agents.transitionAgentStatus({ ownerAddress: OWNER, agentId: AGENT_ID, expectedStatus: "armed", expectedRowVersion: (await paused.agents.getAgentById(AGENT_ID))!.rowVersion, status: "paused" }));
    await paused.killswitch.pauseAgent(AGENT_ID, OWNER);
    await paused.settingsStore.requestDrain(OWNER, AGENT_ID);
    await paused.cycle();
    assert.equal((await paused.lastAction()).plan.swap, null);

    const stopped = await activeRound(t, { settings: { dcaStopLossBps: 1500 } });
    stopped.chain.tick = 40_000;
    await stopped.cycle();
    await stopped.cycle();
    assert.equal((await stopped.lastAction()).kind, "stop-loss");
    await stopped.land({ firstTokenId: 0n });
    const held = (await stopped.store.getOpenRound(OWNER, AGENT_ID))!.stockAcquiredWei;
    stopped.chain.balances.set(NV.stock.toLowerCase(), held);
    await stopped.cycle(); // finish ⇒ closing(stop-loss)
    await stopped.cycle(); // stopped + paused
    await stopped.settingsStore.requestDrain(OWNER, AGENT_ID);
    await stopped.cycle(); // nothing rests ⇒ settles removed directly, no new action
    assert.equal((await stopped.store.listRounds(OWNER, AGENT_ID)).at(-1)?.closeCause, "removed");
  });
});

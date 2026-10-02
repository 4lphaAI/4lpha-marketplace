// Existing offline fixture, extracted for independent final-audit assertions.
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
import type { TestContext } from "node:test";
import type { Hex } from "viem";
import { MemoryTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../../src/store/tradeIntents.js";
import { MemoryExecutionJournal } from "../../src/store/journal.js";
import { MemoryKillSwitch } from "../../src/killswitch/killswitch.js";
import { MemoryDcaRoundStore, type DcaActionRow, type DcaOrderRow } from "../../src/store/dcaRounds.js";
import { NFPM_56 } from "../../src/ops/nfpm.js";
import { WBNB_56 } from "../../src/ops/venues.js";
import { getSqrtRatioAtTick } from "../../src/lp/tickMath.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../../src/trade/guard.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import { tradeSettingsDigest, type TradeSettings } from "../../src/trade/settings.js";
import type { TradeDataPlaneReads, UniverseRow } from "../../src/trade/dataPlaneReads.js";
import type { RouteQuoteReader } from "../../src/trade/route.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../../src/trade/worker.js";
import { dcaBatchCalls, dcaPoolLegs, dcaPriceAtTick, type DcaBatchPlan } from "../../src/trade/dca.js";
import { executeDcaRangeBatch } from "../../src/trade/dcaExecute.js";
import type { DcaChainReads, DcaNfpmLog, DcaPositionRead } from "../../src/trade/dcaResolve.js";
import type { TradfiReceipt, TradfiReceiptObservation } from "../../src/trade/receipt.js";
import { FakeWalletProvider, tradeConfig } from "./serverHarness.js";
import type { TradfiPreflightDeps } from "../../src/trade/simulate.js";
import { AGENT_ID, E18, GUARD, NV, NV_TICK, OWNER, TREASURY, WALLET, dcaAgent, dcaObservation, dcaSettings, planLogs } from "./dcaFixtures.js";

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
export async function activeRound(t: TestContext, input: Parameters<typeof world>[1] = {}) {
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


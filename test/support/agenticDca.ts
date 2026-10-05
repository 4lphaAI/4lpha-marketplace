/** Offline world for the Agentic Auto DCA lane tests (Revision 3): a bound DCA hire over the Agentic Schedule fixture's memory stores, a fake Binance that answers wallet, quote, swap and
 *  market-order list (nothing else: no limit-order command exists), a fake chain with a pool mid and receipts. Triggers fire as ordinary executor swaps. */
import { type TestContext } from "node:test";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { DEFAULT_TRADE_SETTINGS, type TradeSettings } from "../../src/trade/settings.js";
import { dcaPoolForToken } from "../../src/trade/dca.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import type { UniverseRow, VenueRow } from "../../src/trade/dataPlaneReads.js";
import type { TradeWorkerDeps } from "../../src/trade/worker.js";
import { agenticAddress, agenticDecimal, agenticSellAmount, agenticUiString, type AgenticHireFacts, type AgenticWallet } from "../../src/agentic/domain.js";
import type { BawResult } from "../../src/agentic/baw.js";
import type { AgenticChain, AgenticReceipt } from "../../src/agentic/resolve.js";
import { runAgenticCycle } from "../../src/agentic/worker.js";
import { E, NOW, W, aiParams, fixture, type Fixture } from "./agenticSchedule.js";

export const SPYB = agenticAddress("0x7138b48df7d98d7e3cc221bfe7192d0a178182d8");
export const USDT = agenticAddress(USDT_56);
export const M = 1_001_729_792_036_835_231n;
export const MULTIPLIER = "1.001729792036835231";
export const MINUTE = 60_000, HOUR = 3_600_000;
const Q96 = 1n << 96n;
const MID_BLOCK = 1_000_000n;
const POOL = "0x4444444444444444444444444444444444444444" as Address;
const isqrt = (n: bigint): bigint => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

/** Base 25, order 10, N 1 (a = 1), step 1 %, TP 1.5 %, slippage 1 %, no trigger, no range, no stop loss: the DG gate hire. */
export function dcaParams(patch: Partial<TradeSettings> = {}): TradeSettings {
  const maxOrders = (patch.dcaMaxOrders as number | undefined) ?? 1, order = BigInt((patch.dcaOrderWei as string | undefined) ?? (10n * E).toString()), base = BigInt((patch.entryWei as string | undefined) ?? (25n * E).toString());
  return { ...DEFAULT_TRADE_SETTINGS, name: "Agentic Auto DCA", executionModel: "tradfi", settlementAsset: "USDT", entryWei: base.toString(), minEntryWei: base.toString(),
    capitalQuoteWei: (base + BigInt(maxOrders) * order).toString(), maxOpenPositions: 1, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
    slippageBps: 100, crashProtection: false, cmcNewsEnabled: false, tradeMode: "dca", dcaToken: SPYB, dcaStepBps: 100, dcaStepMultiplierBps: 12_000, dcaTakeProfitBps: 150,
    dcaOrderWei: order.toString(), dcaMaxOrders: maxOrders, dcaTriggerPriceE8: null, dcaRangeMinE8: null, dcaRangeMaxE8: null, dcaStopLossBps: null, ...patch } as TradeSettings;
}
export function dcaHireFacts(settings: TradeSettings, term: 7 | 30 = 7, start = NOW): AgenticHireFacts {
  const budget = term === 7 ? 2n * E / 10n : 8n * E / 10n, capital = BigInt(settings.capitalQuoteWei!), end = start + term * 86_400_000;
  return { acceptedAtMs: start, acceptedDedicatedWalletAtMs: start, termSec: term * 86_400, termEndAction: "keep", hireEndMs: end, entryCutoffMs: end - 7_200_000,
    signInMaxTimeMs: start + 90 * 86_400_000, pinned: [agenticAddress(settings.dcaToken!)], quoteDayCapWei: (capital * 5n).toString(), budgetWei: budget.toString(),
    hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: settings.capitalQuoteWei!, entryWei: settings.entryWei,
      minEntryWei: settings.minEntryWei!, quotePerTradeWei: settings.entryWei, cmcNewsEnabled: true, cmcTotalBudgetWei: budget.toString() } };
}

type Landed = { orderId: string; status: string; txHash: Hex | null; side: "buy" | "sell"; amountIn: bigint; amountOut: bigint };
const unit = (value: bigint): string => agenticUiString(value);

/** The fake Binance. Prices are USDT per raw token (the pool mid). `quoteEdgeBps` moves the quote and `fillEdgeBps` the execution relative to the mid (positive is better for the wallet). */
export class FakeMarket {
  calls: string[][] = [];
  landed: Landed[] = [];
  swap: "ok" | "lost" | "reject" = "ok";
  quote: "ok" | "error" | "unavailable" = "ok";
  quoteEdgeBps = 0;
  fillEdgeBps = 0;
  /** per-quote edges consumed in order (the lane's quote first, then the executor's re-quote); an empty queue answers with quoteEdgeBps */
  quoteEdges: number[] = [];
  settingsOverride: Record<string, unknown> = {};
  multiplier = M;
  /** set by `auth signout` or by a test: wallet status then answers UNCONNECTED */
  sessionDead = false;
  constructor(readonly world: { price: number; balances: Map<string, bigint>; receipts: Map<string, AgenticReceipt> }) {}
  count(command: string): number { return this.calls.filter(c => c.slice(0, 2).join(" ") === command).length; }
  swapCalls(): string[][] { return this.calls.filter(c => c[0] === "market-order" && c[1] === "swap"); }
  quoteCalls(): string[][] { return this.calls.filter(c => c[0] === "market-order" && c[1] === "quote"); }
  private px(edge: number): bigint { return BigInt(Math.round(this.world.price * 1e8)) * BigInt(10_000 - edge) / 10_000n; }
  async run(args: readonly string[]): Promise<BawResult> {
    this.calls.push([...args]);
    const arg = (name: string): string => args[args.indexOf(name) + 1]!;
    const ok = (data: unknown, rwaTokens: unknown = null): BawResult => ({ kind: "ok", data, sessionPresent: true, rwaTokens });
    const cache = { updatedAt: NOW, tokens: [{ chainId: "56", contractAddress: SPYB, multiplier: MULTIPLIER, kind: "bstock" }] };
    const m = this.multiplier;
    if (args[0] === "wallet" && args[1] === "balance") {
      const token = arg("--tokenAddress").toLowerCase(), held = this.world.balances.get(token) ?? 0n;
      return ok([{ symbol: "STOCK", address: token, binanceChainId: "56", balance: unit(held * m / E), price: "1", value: "1" }], cache);
    }
    if (args[0] === "wallet" && args[1] === "settings") {
      return ok({ tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 100_000, quotaUsed: 0, x402DailyLimit: 20, x402QuotaUsed: 0,
        signInMaxTime: new Date(NOW + 90 * 86_400_000).toISOString(), sessionExpireTime: null, inactiveSignOutTime: null, ...this.settingsOverride });
    }
    if (args[0] === "wallet" && args[1] === "status") return ok({ status: this.sessionDead ? "UNCONNECTED" : "CONNECTED" });
    if (args[0] === "auth" && args[1] === "signout") { this.sessionDead = true; return ok({ status: "LOGGED_OUT" }); }
    if (args[0] === "market-order" && args[1] === "quote") {
      if (this.quote === "error") return { kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true };
      if (this.quote === "unavailable") return { kind: "cli-error", code: 1, name: "SERVICE_UNAVAILABLE", orderId: null, sessionPresent: true };
      const from = arg("--fromToken").toLowerCase(), qty = agenticDecimal(arg("--fromTokenQty"))!;
      const edge = this.quoteEdges.length > 0 ? this.quoteEdges.shift()! : this.quoteEdgeBps;
      if (from === USDT) {
        const raw = qty * 100_000_000n / this.px(edge);
        return ok({ fromCoinSymbol: "USDT", fromCoinAmount: arg("--fromTokenQty"), toCoinSymbol: "SPYB", toCoinAmount: unit(raw * m / E), slippage: "0" });
      }
      const raw = qty * E / m;
      return ok({ fromCoinSymbol: "SPYB", fromCoinAmount: arg("--fromTokenQty"), toCoinSymbol: "USDT", toCoinAmount: unit(raw * this.px(-edge) / 100_000_000n), slippage: "0" });
    }
    if (args[0] === "market-order" && args[1] === "swap") {
      const from = arg("--fromToken").toLowerCase(), qty = agenticDecimal(arg("--fromTokenQty"))!, buy = from === USDT;
      if (this.swap === "lost") return { kind: "no-response", code: "timeout", sessionPresent: true };
      const id = this.landed.length + 1;
      if (this.swap === "reject") {
        this.landed.push({ orderId: "rejected-" + id, status: "FAILED", txHash: null, side: buy ? "buy" : "sell", amountIn: 0n, amountOut: 0n });
        return { kind: "cli-error", code: 30003001, name: "ORDER_API_ERROR", orderId: "rejected-" + id, sessionPresent: true };
      }
      const hash = ("0x" + String(id).padStart(64, "a")) as Hex;
      // A sell sends exactly the planned raw amount (the CLI converts the UI quantity back): the nearest raw amount that agenticSellAmount prices to this quantity.
      const r0 = qty * E / m, held = this.world.balances.get(SPYB) ?? 0n;
      const planned = buy ? qty : [r0, r0 + 1n, r0 - 1n, r0 + 2n].find(c => c > 0n && agenticSellAmount(c, MULTIPLIER, unit(held * m / E), held) === arg("--fromTokenQty")) ?? r0;
      const amountIn = buy ? qty : planned;
      const amountOut = buy ? amountIn * 100_000_000n / this.px(this.fillEdgeBps) : amountIn * this.px(-this.fillEdgeBps) / 100_000_000n;
      const w = this.world.balances;
      w.set(USDT, (w.get(USDT) ?? 0n) + (buy ? -amountIn : amountOut)); w.set(SPYB, (w.get(SPYB) ?? 0n) + (buy ? amountOut : -amountIn));
      this.landed.push({ orderId: "listed-" + id, status: "FINISHED", txHash: hash, side: buy ? "buy" : "sell", amountIn, amountOut });
      this.world.receipts.set(hash, swapReceipt(hash, buy ? [[USDT, W, POOL, amountIn], [SPYB, POOL, W, amountOut]] : [[SPYB, W, POOL, amountIn], [USDT, POOL, W, amountOut]]));
      return ok({ orderId: "returned-" + id }, cache);
    }
    if (args[0] === "market-order" && args[1] === "list") {
      const rows = this.landed.map(r => ({ orderId: r.orderId, status: r.status, txHash: r.txHash, bookTime: null }));
      return ok({ total: rows.length, page: 1, pageSize: 100, list: rows });
    }
    if (args[0] === "limit-order" && args[1] === "list") return ok({ total: 0, page: 1, pageSize: 100, list: [] });
    return { kind: "cli-error", code: 1, name: "SERVICE_ERROR", orderId: null, sessionPresent: true };
  }
}
const TRANSFER = keccak256(stringToBytes("Transfer(address,address,uint256)"));
const topic = (a: string): Hex => ("0x" + a.slice(2).toLowerCase().padStart(64, "0")) as Hex;
const word = (v: bigint): Hex => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
export function swapReceipt(hash: Hex, flows: readonly (readonly [Address, Address, Address, bigint])[]): AgenticReceipt {
  const block = `0x${"44".repeat(32)}` as Hex;
  return { from: W, to: POOL, input: "0x", observation: { chainId: 56, transaction: { hash, to: POOL, input: "0x", blockNumber: 1n, blockHash: block, transactionIndex: 0n },
    receipt: { status: 1n, transactionHash: hash, blockNumber: 1n, blockHash: block, transactionIndex: 0n, logs: flows.map(([token, source, target, amount], index) => ({ address: token, topics: [TRANSFER, topic(source), topic(target)], data: word(amount), logIndex: BigInt(index) })) },
    receiptBlock: { number: 1n, hash: block }, finalizedBlock: { number: 2n, hash: block } } } as unknown as AgenticReceipt;
}

export type DcaWorld = Awaited<ReturnType<typeof dcaLane>>;
/** A bound DCA hire over a fake Binance and a fake chain. `price` is the pool mid in USDT per stock (raw over raw, both 18 decimals). */
export async function dcaLane(t: TestContext, options: { settings?: Partial<TradeSettings>; initial?: Partial<AgenticWallet>; price?: number; term?: 7 | 30; flag?: boolean; maxSlippageBps?: number; ai?: boolean } = {}) {
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  const settings = dcaParams(options.settings), price0 = options.price ?? 700;
  const state = { price: price0, balances: new Map<string, bigint>([[USDT, 60n * E], [SPYB, 0n]]), receipts: new Map<string, AgenticReceipt>() };
  const market = new FakeMarket(state);
  const venue: VenueRow = { dex: "pancakeswap", version: "v3", pool: POOL, feeTier: 100, quote: USDT_56, quoteSymbol: "USDT", priceUsd: price0, liquidityUsd: 500_000, volume24hUsd: 1, asOf: NOW };
  const universe = (): UniverseRow => ({ address: SPYB, symbol: "SPYB", lane: "bstocks", source: "offline", venues: [{ ...venue, asOf: clock }],
    rwa: { platform: "bstocks", underlyingTicker: "SPY", tokenPriceUsd: state.price, referencePriceUsd: state.price, premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING",
      staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: state.price, venues: [{ ...venue, asOf: clock }] } });
  const dataPlane: TradeWorkerDeps["dataPlane"] = { universe: async lane => lane === "bstocks" ? [universe()] : [],
    tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1e9, volume24hUsd: 1000, holders: 100,
      priceChange24hPct: 0, asOf: clock, source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
    eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }) };
  // ai: the same world over an AI Trade hire (its stored settings are not DCA), for the executor's per-mode rules
  const f: Fixture = await fixture(t, options.ai === true ? { ...options.initial } : { hireFacts: dcaHireFacts(settings, options.term ?? 7), ...options.initial }, options.ai === true ? aiParams : settings, () => ({ dataPlane,
    readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([SPYB]) } } as Partial<TradeWorkerDeps>));
  f.runner.run = (async (args: readonly string[]) => market.run(args)) as typeof f.runner.run;
  const chain = f.chain as AgenticChain & { poolState: NonNullable<AgenticChain["poolState"]> };
  let multiplier = M;
  const sqrtFor = (p: number): bigint => { const pool = dcaPoolForToken(SPYB)!, num = BigInt(Math.round(p * 1e8)), den = 100_000_000n;
    return pool.usdtIsToken0 ? isqrt(Q96 * Q96 * den / num) : isqrt(num * Q96 * Q96 / den); };
  const failures = { balance: false, pool: false, multiplier: false };
  chain.balance = async (_wallet, token) => { if (failures.balance) throw new Error("rpc"); return token === null ? f.balances.native : state.balances.get(token.toLowerCase()) ?? 0n; };
  chain.multiplier = async () => { if (failures.multiplier) throw new Error("rpc"); return multiplier; };
  chain.receipt = async hash => state.receipts.get(hash) ?? null;
  let blockOffset = 0n;
  chain.poolState = async () => { if (failures.pool) throw new Error("rpc"); const pool = dcaPoolForToken(SPYB)!, legs = { token0: pool.usdtIsToken0 ? USDT : SPYB, token1: pool.usdtIsToken0 ? SPYB : USDT };
    return { ...legs, fee: pool.fee, tickSpacing: pool.tickSpacing, sqrtPriceX96: sqrtFor(state.price), tick: 0, block: MID_BLOCK + BigInt(Math.floor(clock / 1000)) + blockOffset }; };
  const worker: TradeWorkerDeps = { ...f.worker, now: f.now };
  const trade = (worker.executorDeps as unknown as { trade: { maxSlippageBps: number } }).trade;
  if (options.maxSlippageBps !== undefined) trade.maxSlippageBps = options.maxSlippageBps;
  const dcaEnabled = options.flag ?? true;
  const input = { ...f.lifecycle, worker, dcaEnabled };
  const at = async (ms: number): Promise<void> => { clock = ms; f.setTime(ms); await f.instance.heartbeat(); };
  const advance = async (ms: number): Promise<void> => at(clock + ms);
  const tick = async (): Promise<void> => runAgenticCycle(input);
  const runs = async () => await f.positions.listRuns(W, f.agent.id, 50);
  const code = async (): Promise<string | undefined> => (await runs())[0]?.reason.split(";")[0];
  const orders = () => f.store.dcaOrders(f.agent.id);
  const rounds = () => f.store.dcaRounds(f.agent.id);
  const wallet = async () => (await f.store.byAgent(f.agent.id))!;
  const setPrice = (p: number) => { state.price = p; };
  const setMultiplier = (value: bigint) => { multiplier = value; market.multiplier = value; };
  return { f, input, market, state, at, advance, tick, runs, code, orders, rounds, wallet, setPrice, setMultiplier, failures, settings, trade, now: () => clock, bumpBlock: () => { blockOffset += 1n; } };
}

/** Base filled, TP and L1 armed (the DG1 shape): run cycles one minute apart. */
export async function toArmed(world: DcaWorld, cycles = 2): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await world.tick(); await world.advance(MINUTE); }
}
export const armed = async (w: DcaWorld, role: "tp" | "level", level?: number) =>
  (await w.orders()).filter(o => o.role === role && (level === undefined || o.levelNo === level));

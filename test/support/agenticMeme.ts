/** Offline fixture for the Agentic meme-stocks paper tests: a bound paper meme hire over the Agentic Schedule fixture, a fake data plane with the four meme reads, a fake Binance quote and a fake LLM. */
import { type TestContext } from "node:test";
import type { Address } from "viem";
import { agenticAddress, agenticDecimal, agenticUiString, type AgenticHireFacts, type AgenticMemePaper, type AgenticWallet } from "../../src/agentic/domain.js";
import type { BawResult } from "../../src/agentic/baw.js";
import type { TradeSettings } from "../../src/trade/settings.js";
import type { TradeWorkerDeps } from "../../src/trade/worker.js";
import type { TokenBatchRow } from "../../src/trade/dataPlaneReads.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import { WBNB_56 } from "../../src/ops/venues.js";
import type { MemeStepDeps } from "../../src/agentic/memeLane.js";
import { E, NOW, PAIRING, W, aiParams, fixture } from "./agenticSchedule.js";

export const MEME = agenticAddress("0xabababababababababababababababababababab");
export const MEME2 = agenticAddress("0xacacacacacacacacacacacacacacacacacacacac");
export const QUOTE = agenticAddress("0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd");
export const BSTOCK = agenticAddress("0x7138b48df7d98d7e3cc221bfe7192d0a178182d8");
const { cmcTotalBudgetWei: _budget, ...aiNoBudget } = aiParams;
/** 9.1: the paper meme settings (10 USDT per trade, 2 open, 20 USDT capital, no CMC, no owner exits or text). */
export const memeSettings: TradeSettings = { ...aiNoBudget, name: "Meme paper", cmcNewsEnabled: false, minEntryWei: (10n * E).toString(), entryWei: (10n * E).toString(),
  capitalQuoteWei: (20n * E).toString(), maxOpenPositions: 2, slippageBps: 500, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, instructions: null, skillMarkdown: null };
export const memeBody = (settings: TradeSettings = memeSettings, extra: Record<string, unknown> = {}) => ({ pairingId: PAIRING, term: 7, termEndAction: "sell-all", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings, strategy: "meme-stocks-paper", ...extra });
export function memeHireFacts(settings: TradeSettings = memeSettings, start = NOW): AgenticHireFacts {
  return { acceptedAtMs: start, acceptedDedicatedWalletAtMs: start, termSec: 604_800, termEndAction: "sell-all", hireEndMs: start + 604_800_000, entryCutoffMs: start + 597_600_000,
    signInMaxTimeMs: start + 90 * 86_400_000, pinned: [], quoteDayCapWei: (BigInt(settings.capitalQuoteWei!) * 5n).toString(), budgetWei: "0",
    hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: settings.capitalQuoteWei!, entryWei: settings.entryWei,
      minEntryWei: settings.minEntryWei!, quotePerTradeWei: settings.entryWei, cmcNewsEnabled: false }, meme: { v: 1, mode: "paper" } };
}

export type Bar = { startMs: number; open: number; high: number; low: number; close: number; volume: number; trades: number; filled: boolean };
/** A passing series (6.2 - 6.5): 20 rising green bars, volume 100, a 1 000 USD burst at L-1 and 400 at L; the last bar closes `lagMs` before `nowMs` minus a minute. */
export function passingBars(nowMs: number, lagMs = 120_000, count = 20): Bar[] {
  const last = nowMs - 60_000 - lagMs;
  return Array.from({ length: count }, (_unused, i) => {
    const open = 1 + 0.02 * i, close = open + 0.012;
    return { startMs: last - (count - 1 - i) * 60_000, open, high: close * 1.005, low: open * 0.995, close, volume: i === count - 2 ? 1_000 : i === count - 1 ? 400 : 100, trades: 3, filled: false };
  });
}
export function shortlistRow(nowMs: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { address: MEME, symbol: "MEME", launchpad: "flap", stage: "graduated", status: "runner", category: "daily_runner", ageMinutes: 300,
    quote: { address: QUOTE, kind: "bstock", symbol: "NVDAB", stock: { priceUsd: 180, openState: true } }, priceUsd: 0.0001, marketCapUsd: 100_000, liquidityUsd: 16_620, holders: 400,
    txs5m: 40, volume5mUsd: 1_500, volume1hUsd: 12_000, priceChange5mPct: 4, priceChange1hPct: 20, flags: [], observedAt: nowMs - 10_000,
    flow5m: { buys: 30, sells: 10, uniqueTraders: 25, inflowUsd: 300 }, flow1h: { buys: 300, sells: 200, uniqueTraders: 90, inflowUsd: 1_000 }, smartInflow5m: null, smartInflow1h: null,
    venue: "pancake-v2", tax: { buyBps: 300, sellBps: 500 }, pool: null, dividend: null, venueCheckedAt: nowMs - 60_000, unknownKey: "ignored", ...patch };
}
export function eligibilityRow(nowMs: number, patch: Record<string, unknown> = {}, flap: Record<string, unknown> = {}): Record<string, unknown> {
  return { address: MEME, eligible: true, reason: "ok", source: "flap", venue: "pancake-v2", checkedAt: nowMs - 1_000, cached: true, fourmeme: null,
    flap: { status: 4, tokenVersion: 6, quote: QUOTE, nativeToQuoteSwapEnabled: true, pool: "0x1111111111111111111111111111111111111111", progress: "1000000000000000000", buyTaxBps: 300, sellTaxBps: 500, ...flap }, ...patch };
}

/** The fake data plane: every field is mutable between cycles; `delayMs` advances the fake clock per read (a read at its 5 000 ms timeout); null answers throw (unavailable). */
export class MemePlane {
  calls: string[] = [];
  delayMs = 0;
  asOf: number;
  rows: Record<string, unknown>[];
  meta: Record<string, unknown> = {};
  bars = new Map<string, { tracked?: boolean; staleness?: string; bars: Bar[] } | null>();
  board = new Map<string, Record<string, unknown>>();
  eligibility: Record<string, unknown>[] | null;
  universe: { address: Address }[] | null = [{ address: BSTOCK }];
  wbnb: Partial<TokenBatchRow> | null = {};
  down = new Set<string>();
  constructor(readonly clock: { now: number; advance(ms: number): void }) {
    this.asOf = clock.now - 5_000;
    this.rows = [shortlistRow(clock.now)];
    this.bars.set(MEME, { bars: passingBars(clock.now) });
    this.eligibility = [eligibilityRow(clock.now)];
  }
  async #read<T>(name: string, answer: () => T): Promise<T> {
    this.calls.push(name);
    if (this.delayMs > 0) this.clock.advance(this.delayMs);
    if (this.down.has(name)) throw new Error("unavailable");
    return answer();
  }
  dataPlane(): TradeWorkerDeps["dataPlane"] {
    return {
      universe: async (lane) => this.#read("universe", () => { if (this.universe === null) throw new Error("down"); return lane === "bstocks" ? this.universe.map(r => ({ ...r, symbol: "SPYB", lane, source: "x" })) : []; }) as never,
      tokensBatch: async (addresses) => this.#read("tokensBatch", () => addresses.flatMap(address => address.toLowerCase() === WBNB_56.toLowerCase()
        ? this.wbnb === null ? [] : [{ address, symbol: "WBNB", priceUsd: 717, marketCapUsd: 1, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: this.clock.now - 1_000, staleness: "fresh" as const, updatedFields: ["priceUsd"], ...this.wbnb }]
        : [{ address, symbol: "USDT", priceUsd: 1, marketCapUsd: 1, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: this.clock.now - 1_000, staleness: "fresh" as const, updatedFields: ["priceUsd"] }])),
      eligibilityBatch: async () => [], security: async () => ({}),
      memeShortlist: async () => this.#read("memeShortlist", () => ({ data: this.rows, meta: { staleness: "fresh", asOf: this.asOf, boardTotal: 120, candidates: { flap: 30, fourmeme: 0 }, picked: { flap: this.rows.length, fourmeme: 0 }, ...this.meta } })),
      memeToken: async (address: Address) => this.#read("memeToken", () => { const row = this.board.get(address.toLowerCase()); if (row === undefined) throw new Error("not_on_board"); return { data: row, meta: { staleness: "fresh", asOf: this.clock.now } }; }),
      memeBars: async (addresses: readonly Address[]) => this.#read("memeBars", () => ({ data: addresses.map(address => {
        const s = this.bars.get(address.toLowerCase());
        if (s === null || s === undefined) return { address, tracked: false, symbol: "X", source: "sintral", unit: "usd", asOf: null, staleness: "dead", lastClosedStartMs: null, bars: [] };
        return { address, tracked: s.tracked ?? true, symbol: "X", source: "sintral", unit: "usd", asOf: this.clock.now, staleness: s.staleness ?? "fresh", lastClosedStartMs: s.bars.at(-1)?.startMs ?? null, bars: s.bars };
      }), meta: {} })),
      memeEligibility: async () => this.#read("memeEligibility", () => { if (this.eligibility === null) throw new Error("down"); return { data: this.eligibility, meta: {} }; }),
    } as TradeWorkerDeps["dataPlane"];
  }
}

/** Binance quotes: a buy gives `tokensPerUsdt` tokens per USDT; a sell gives `usdtPerToken` (num / den) per token. A null answer is a refusal. */
export class MemeMarket {
  tokensPerUsdt = 4_000n;
  sell = { num: 1n, den: 4_000n };
  slippage: string | number = "0.04";
  buyAnswer: BawResult | null = null;
  sellAnswer: BawResult | null = null;
  /** ms the fake clock advances per quote (a quote at its 10 s CLI timeout). */
  delayMs = 0;
  quotes: { side: "buy" | "sell"; token: string; qty: string }[] = [];
}

export async function memeWorld(t: TestContext, options: { initial?: Partial<AgenticWallet>; settings?: TradeSettings; agentId?: string; llm?: (model: string, signal: AbortSignal | undefined) => Promise<string> } = {}) {
  const clock = { now: NOW, advance(ms: number) { clock.now += ms; f.setTime(clock.now); } };
  t.mock.method(Date, "now", () => clock.now);
  const plane = new MemePlane(clock), market = new MemeMarket();
  const settings = options.settings ?? memeSettings;
  const llmCalls: { model: string; messages: { role: string; content: string }[]; signal: AbortSignal | undefined }[] = [];
  const llmFor = (model: string) => ({ complete: async (messages: readonly { role: string; content: string }[], signal?: AbortSignal) => {
    llmCalls.push({ model, messages: [...messages], signal });
    const content = options.llm === undefined ? JSON.stringify({ decisions: [{ index: 0, action: "buy_now", confidence: 80 }] }) : await options.llm(model, signal);
    return { model, content };
  } });
  const f = await fixture(t, { hireParams: { pairingId: PAIRING, term: 7, termEndAction: "sell-all", executionModel: "tradfi", hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", settings,
    acceptedDedicatedWallet: true, strategy: "meme-stocks-paper" }, hireFacts: memeHireFacts(settings), termEndAction: "sell-all", ...options.initial }, settings,
    () => ({ dataPlane: plane.dataPlane(), llmFor } as unknown as Partial<TradeWorkerDeps>));
  const original = f.runner.run.bind(f.runner);
  f.runner.run = async (args: readonly string[]) => {
    if (args[0] === "market-order" && args[1] === "quote") {
      f.runner.calls.push([...args]);
      if (market.delayMs > 0) clock.advance(market.delayMs);
      const from = args[args.indexOf("--fromToken") + 1]!, qty = args[args.indexOf("--fromTokenQty") + 1]!, buy = from.toLowerCase() === USDT_56.toLowerCase();
      market.quotes.push({ side: buy ? "buy" : "sell", token: buy ? args[args.indexOf("--toToken") + 1]! : from, qty });
      const fixed = buy ? market.buyAnswer : market.sellAnswer;
      if (fixed !== null) return fixed;
      const amount = agenticDecimal(qty)!;
      const out = buy ? amount * market.tokensPerUsdt : amount * market.sell.num / market.sell.den;
      return { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "X", fromCoinAmount: qty, toCoinSymbol: "Y", toCoinAmount: agenticUiString(out), slippage: market.slippage } };
    }
    return original(args);
  };
  const deps = (memeEnabled = true): MemeStepDeps => ({ store: f.store, positions: f.positions, runner: f.runner, masterKey: f.execution.masterKey, instance: f.instance, chain: f.execution.chain,
    worker: f.worker, memeEnabled });
  const at = async (ms: number) => { clock.now = ms; f.setTime(ms); await f.instance.heartbeat(); };
  return { f, plane, market, clock, deps, llmCalls, at, settings, agentId: f.agent.id };
}
export type MemeWorld = Awaited<ReturnType<typeof memeWorld>>;

/** An open paper position of the fixture agent (graduated, 300 / 500 tax, 10 USDT at 4 000 tokens per USDT after the 3 % buy tax). */
export function paperRow(world: MemeWorld, patch: Partial<AgenticMemePaper> = {}): AgenticMemePaper {
  return { positionId: "p-" + (patch.token ?? MEME), agentId: world.agentId, walletAddress: W, token: MEME, symbol: "MEME", quoteToken: QUOTE, quoteSymbol: "NVDAB", venueEntry: "pancake-v2",
    buyTaxBps: 300, sellTaxBps: 500, tokenVersion: 6, entryUsdt: (10n * E).toString(), gasBuyUsdt: "40510500000000000", bnbUsdtE18: (717n * E).toString(), tokens: (38_800n * E).toString(),
    costBps: 1_000, status: "open", lastMarkUsdt: null, lastMarkAt: null, peakPnlBps: null, markSkips: 0, markCount: 0, closeRequestedAt: null, closeCode: null,
    exitUsdt: null, gasSellUsdt: null, pnlUsdt: null, closedAt: null, openedAt: world.clock.now - 60_000, version: 1, ...patch };
}

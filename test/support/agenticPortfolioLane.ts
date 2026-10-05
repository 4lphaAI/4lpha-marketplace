/** The Agentic lane over a portfolio hire with a fake Binance: used by the lane and public view tests. */
import { type TestContext } from "node:test";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { agenticDecimal, agenticUiString } from "../../src/agentic/domain.js";
import { runAgenticCycle } from "../../src/agentic/worker.js";
import type { BawResult } from "../../src/agentic/baw.js";
import type { AgenticReceipt } from "../../src/agentic/resolve.js";
import { USDT_56 } from "../../src/trade/settlement.js";
import type { UniverseRow, VenueRow } from "../../src/trade/dataPlaneReads.js";
import type { TradeWorkerDeps } from "../../src/trade/worker.js";
import { E, NOW, W } from "./agenticSchedule.js";
import { QQQB, SPYB, portfolioFixture } from "./agenticPortfolio.js";

export const HOUR = 3_600_000, SLOT = 4 * HOUR;
type Landed = { orderId: string; status: string; txHash: Hex | null; from: Address; to: Address; amountIn: bigint; amountOut: bigint };

/** A portfolio hire (SPYB / QQQB 50/50, capital 50 USDT, 4 h slots, drift 0.5 %) over a fake Binance that fills every order 1:1 and a pool that values a stock 1:1 in USDT. */
export async function lane(t: TestContext, options: { enabled?: boolean } = {}) {
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: "0x4444444444444444444444444444444444444444", feeTier: null, quote: USDT_56, quoteSymbol: "USDT",
    priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: NOW };
  const row = (address: Address, symbol: string): UniverseRow => ({ address, symbol, lane: "bstocks", source: "offline", venues: [{ ...venue, asOf: clock }],
    rwa: { platform: "bstocks", underlyingTicker: symbol, tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING",
      staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [{ ...venue, asOf: clock }] } });
  const dataPlane: TradeWorkerDeps["dataPlane"] = { universe: async lane => lane === "bstocks" ? [row(SPYB, "SPYB"), row(QQQB, "QQQB")] : [],
    tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1e9, volume24hUsd: 1000, holders: 100,
      priceChange24hPct: 0, asOf: clock, source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
    eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }) };
  const same = async (_path: readonly Address[] | Address, amount: bigint) => amount;
  const routeReader = { quoteV2: same, quoteV3Single: async (_in: Address, _out: Address, _fee: number, amount: bigint) => amount, quoteV3Path: same,
    quoteUniV3Single: async () => { throw new Error("no uni"); }, quoteUniV3Path: async () => { throw new Error("no uni"); } };
  const f = await portfolioFixture(t, {}, () => ({ dataPlane, routeReader, ...(options.enabled === false ? {} : { portfolioEnabled: true }),
    readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([SPYB, QQQB]) } } as Partial<TradeWorkerDeps>));
  const balances = new Map<string, bigint>([[USDT_56.toLowerCase(), 52n * E], [SPYB, 0n], [QQQB, 0n]]); // the capital plus the 2 USDT the fixture reserves for CMC (the buy fence keeps that apart)
  const native = () => f.balances.native;
  f.chain.balance = async (_wallet, token) => token === null ? native() : balances.get(token.toLowerCase()) ?? 0n;
  const landed: Landed[] = [];
  const quotes: { from: Address; to: Address; qty: string }[] = [];
  const swaps: { from: Address; to: Address; qty: string }[] = [];
  const arg = (args: readonly string[], name: string) => args[args.indexOf(name) + 1]!;
  const plan = { quote: undefined as BawResult | undefined, swap: undefined as (() => BawResult) | undefined, listOverride: undefined as (() => Landed[]) | undefined };
  const run = f.runner.run.bind(f.runner);
  f.runner.run = async (args, ...rest): Promise<BawResult> => {
    const ok = (data: unknown, rwaTokens: unknown = null): BawResult => ({ kind: "ok", data, sessionPresent: true, rwaTokens });
    if (args[0] === "wallet" && args[1] === "balance") {
      const token = arg(args, "--tokenAddress").toLowerCase() as Address, held = balances.get(token) ?? 0n;
      return ok([{ symbol: "STOCK", address: token, binanceChainId: "56", balance: agenticUiString(held), price: "1", value: "1" }],
        { updatedAt: NOW, tokens: [{ chainId: "56", contractAddress: token, multiplier: "1", kind: "bstock" }] });
    }
    if (args[0] === "market-order" && args[1] === "quote") {
      quotes.push({ from: arg(args, "--fromToken").toLowerCase() as Address, to: arg(args, "--toToken").toLowerCase() as Address, qty: arg(args, "--fromTokenQty") });
      if (plan.quote !== undefined) return plan.quote;
      return ok({ fromCoinSymbol: "X", fromCoinAmount: arg(args, "--fromTokenQty"), toCoinSymbol: "Y", toCoinAmount: agenticUiString(agenticDecimal(arg(args, "--fromTokenQty"))! * 102n / 100n), slippage: "0" });
    }
    if (args[0] === "market-order" && args[1] === "swap") {
      const from = arg(args, "--fromToken").toLowerCase() as Address, to = arg(args, "--toToken").toLowerCase() as Address, qty = arg(args, "--fromTokenQty");
      swaps.push({ from, to, qty });
      if (plan.swap !== undefined) return plan.swap();
      const amountIn = agenticDecimal(qty)!, hash = ("0x" + String(landed.length + 1).padStart(64, "0")) as Hex;
      balances.set(from, (balances.get(from) ?? 0n) - amountIn); balances.set(to, (balances.get(to) ?? 0n) + amountIn);
      landed.push({ orderId: "listed-" + (landed.length + 1), status: "FINISHED", txHash: hash, from, to, amountIn, amountOut: amountIn });
      return ok({ orderId: "returned-" + landed.length });
    }
    if (args[0] === "market-order" && args[1] === "list") {
      const rows = (plan.listOverride?.() ?? landed).map(r => ({ orderId: r.orderId, status: r.status, txHash: r.txHash, bookTime: null }));
      return ok({ total: rows.length, page: 1, pageSize: 100, list: rows });
    }
    return run(args, ...rest);
  };
  f.chain.receipt = async hash => {
    const hit = landed.find(r => r.txHash === hash);
    if (hit === undefined) return null;
    const block = `0x${"44".repeat(32)}` as Hex, topic = (address: Address) => ("0x" + address.slice(2).padStart(64, "0")) as Hex, word = (value: bigint) => ("0x" + value.toString(16).padStart(64, "0")) as Hex;
    const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)")), pool = "0x4444444444444444444444444444444444444444" as Address;
    const proof: AgenticReceipt = { from: W, to: hit.to, input: "0x", observation: { chainId: 56, transaction: { hash, to: hit.to, input: "0x", blockNumber: 1n, blockHash: block, transactionIndex: 0n },
      receipt: { status: 1n, transactionHash: hash, blockNumber: 1n, blockHash: block, transactionIndex: 0n, logs: [
        { address: hit.from, topics: [transfer, topic(W), topic(pool)], data: word(hit.amountIn), logIndex: 0n },
        { address: hit.to, topics: [transfer, topic(pool), topic(W)], data: word(hit.amountOut), logIndex: 1n }] },
      receiptBlock: { number: 1n, hash: block }, finalizedBlock: { number: 2n, hash: block } } };
    return proof;
  };
  const worker: TradeWorkerDeps = { ...f.worker, now: f.now };
  const input = { ...f.lifecycle, worker };
  const at = async (ms: number) => { clock = ms; f.setTime(ms); await f.instance.heartbeat(); };
  const tick = async () => runAgenticCycle(input);
  const reason = async () => (await f.positions.listRuns(W, f.agent.id, 1))[0]?.reason.split(";")[0];
  const swapsTo = (token: Address) => swaps.filter(s => s.to === token).length;
  return { f, input, balances, landed, quotes, swaps, plan, at, tick, reason, swapsTo, worker };
}
export const USDT = USDT_56.toLowerCase() as Address;


/** Slot 0 done, then the wallet holds the PG2 shape: SPYB 24, QQQB 25 (so the next slot plans a partial QQQB sell and then a SPYB buy). */
export async function afterBasket(t: TestContext) {
  const world = await lane(t);
  await world.tick(); await world.at(NOW + 60_000); await world.tick(); await world.at(NOW + 120_000); await world.tick();
  world.balances.set(SPYB, 24n * E); world.balances.set(QQQB, 25n * E); world.balances.set(USDT, 2n * E + 50_000_000_000_000_000n);
  world.swaps.length = 0; world.quotes.length = 0;
  return world;
}


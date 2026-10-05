/** AGENTIC-RFQ-STOCKS 4.3 (E3, R3.5, R3.9, R3.12, R4.6): the Agentic AI pin variant, its ranking and its cache. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getAddress, type Address } from "viem";
import { admittedVenueRows } from "../src/trade/rwa.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import type { TradfiFlashQuote, UniverseRow } from "../src/trade/dataPlaneReads.js";
import { AgenticPairings, type AgenticRoutesDeps } from "../src/agentic/routes.js";
import type { AgenticRfqPin } from "../src/agentic/rfq.js";
import { orderRfqOnly, rfqCostBps } from "../src/agentic/rfq.js";
import { E, W, fixture } from "./support/agenticSchedule.js";
import { loadRfqUniverse, pinServer, rfqDataPlane } from "./support/agenticRfq.js";

const GUARD = getAddress("0x4444444444444444444444444444444444444444");
const NOW = 1_800_000_000_000;
type Pin = () => Promise<AgenticRfqPin>;

/** A Flash proxy double: the quote of a token costs `bps` over its fair price (per-share reference x ratio); a missing entry refuses (throws). Counts calls and proves `this` is kept. */
class FlashProxy {
  calls: { tokenOut: string; amountAtomic: string; slippageBps: number }[] = [];
  concurrent = 0; peak = 0; clock = NOW;
  readonly #costs: ReadonlyMap<string, number>;
  readonly #rows: ReadonlyMap<string, UniverseRow>;
  constructor(rows: readonly UniverseRow[], costs: Readonly<Record<string, number>>) {
    this.#rows = new Map(rows.map((row) => [row.address.toLowerCase(), row]));
    this.#costs = new Map(Object.entries(costs).map(([symbol, bps]) => [rows.find((row) => row.symbol === symbol)!.address.toLowerCase(), bps]));
  }
  async binanceQuoteAndSwap(request: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountAtomic: string; readonly slippageBps: number }): Promise<TradfiFlashQuote> {
    this.calls.push({ tokenOut: request.tokenOut.toLowerCase(), amountAtomic: request.amountAtomic, slippageBps: request.slippageBps });
    this.concurrent += 1; this.peak = Math.max(this.peak, this.concurrent);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const key = request.tokenOut.toLowerCase(), bps = this.#costs.get(key);
      if (bps === undefined) throw new Error("no quote");
      const fact = this.#rows.get(key)!.rwa!;
      const fair = fact.referencePriceUsd! * fact.tokenToShareRatio!;
      const out = BigInt(Math.round(20 / (fair * (1 + bps / 10_000)) * 1e18));
      return { version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountInAtomic: request.amountAtomic,
        quotedOutAtomic: out.toString(), minOutAtomic: (out * 99n / 100n).toString(), router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
        calldata: "0xad43f73d", value: "0", observedAt: this.clock, expiresAt: this.clock + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1", feeAmountAtomic: "0", feeToken: USDT_56 };
    } finally { this.concurrent -= 1; }
  }
}

async function world(t: TestContext, options: { corrected?: boolean; costs?: Record<string, number>; guardVerified?: boolean; rows?: readonly UniverseRow[]; flag?: boolean } = {}) {
  const rows = options.rows ?? await loadRfqUniverse(options.corrected ?? true);
  const flash = new FlashProxy(rows, options.costs ?? {});
  let now = NOW;
  const f = await fixture(t);
  const pairings = new AgenticPairings({ ...f.pairings.deps, ...(options.flag === false ? {} : { rfqEnabled: true }) } as AgenticRoutesDeps);
  flash.clock = now;
  const dataPlane = rfqDataPlane(rows, {}, () => now);
  // A method on the plane object that reads `this`: a detached reference (commit 1fc6f20) would throw here and rank every stock last.
  Object.assign(dataPlane, { marker: true, binanceQuoteAndSwap(this: { marker?: boolean }, request: Parameters<FlashProxy["binanceQuoteAndSwap"]>[0]) {
    if (this.marker !== true) throw new TypeError("detached binanceQuoteAndSwap");
    return flash.binanceQuoteAndSwap(request);
  } });
  const server = pinServer({ pairings, dataPlane, trade: { aggregatorGuard: GUARD }, guardVerified: async () => options.guardVerified ?? true, now: () => now });
  const rfqPin = pairings.rfqPin as Pin;
  return { rows, flash, pairings, rfqPin, provider: server.provider, tick: (ms: number) => { now += ms; flash.clock = now; }, f };
}
const symbolsOf = (rows: readonly UniverseRow[], addresses: readonly Address[]) => addresses.map((address) => rows.find((row) => row.address.toLowerCase() === address.toLowerCase())!.symbol);

test("the pooled prefix is today's Agentic AI pin (24 stocks, same order); the RFQ-only part holds the other 26 and nothing is cut", async (t) => {
  const w = await world(t);
  const pin = await w.rfqPin();
  const today = await w.pairings.pin!(W, 5n * E, 100, "ai");
  assert.deepEqual(pin.pooled, today);
  assert.equal(pin.pooled.length, 24);
  assert.equal(pin.rfqOnly.length, 26);
  assert.equal(new Set([...pin.pooled, ...pin.rfqOnly].map((a) => a.toLowerCase())).size, 50);
  assert.ok(pin.rfqOnly.every((address) => admittedVenueRows(w.rows.find((row) => row.address === address)!.venues).length === 0));
  assert.equal(pin.costs.length, 26);
});

test("RFQ-only stocks are ordered by measured cost, null last, ties and nulls by address; the Flash call is a 20 USDT buy at 100 bps slippage, four at a time", async (t) => {
  const costs = { AMDB: 12, IBMB: 12, QCOMB: 70, MUUB: -5, GLWB: 33 };
  const w = await world(t, { costs });
  const pin = await w.rfqPin();
  const bySymbol = symbolsOf(w.rows, pin.rfqOnly);
  assert.deepEqual(bySymbol.slice(0, 5), ["MUUB", "AMDB", "IBMB", "GLWB", "QCOMB"], "-5, 12 (AMDB < IBMB by address), 33, 70");
  const nulls = pin.rfqOnly.slice(5);
  assert.deepEqual(nulls, [...nulls].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), "stocks with no usable quote follow in address order");
  assert.deepEqual(pin.costs.slice(0, 5).map((row) => row.costBps), [-5, 12, 12, 33, 70]);
  assert.ok(pin.costs.slice(5).every((row) => row.costBps === null));
  assert.equal(w.flash.calls.length, 26);
  assert.ok(w.flash.calls.every((call) => call.amountAtomic === (20n * E).toString() && call.slippageBps === 100));
  assert.ok(w.flash.peak > 1 && w.flash.peak <= 4, `concurrency ${w.flash.peak}`);
});

test("the cost vector: PYPLB per-share 53.11, ratio 1.001771778813, a 20 USDT quote of 0.375 tokens is +24 bps", () => {
  assert.equal(rfqCostBps({ outAtomic: 375_000_000_000_000_000n, referencePriceUsd: 53.11, tokenToShareRatio: 1.001771778813 }), 24);
  for (const bad of [{ referencePriceUsd: null, tokenToShareRatio: 1 }, { referencePriceUsd: 53, tokenToShareRatio: null }, { referencePriceUsd: 0, tokenToShareRatio: 1 }, { referencePriceUsd: 53, tokenToShareRatio: -1 },
    { referencePriceUsd: Number.NaN, tokenToShareRatio: 1 }, { referencePriceUsd: undefined, tokenToShareRatio: 1 }]) assert.equal(rfqCostBps({ outAtomic: E, ...bad }), null);
  assert.equal(rfqCostBps({ outAtomic: 0n, referencePriceUsd: 53, tokenToShareRatio: 1 }), null);
  assert.deepEqual(orderRfqOnly([{ token: "0x0000000000000000000000000000000000000002", costBps: null }, { token: "0x0000000000000000000000000000000000000001", costBps: null },
    { token: "0x0000000000000000000000000000000000000003", costBps: 5 }]).map((row) => row.token.slice(-1)), ["3", "1", "2"]);
});

test("a null ratio (PYPLB, COHRB and CRDOB before the data plane fills it) gives no cost and ranks last", async (t) => {
  const w = await world(t, { corrected: false, costs: { AMDB: 10, PYPLB: 5, COHRB: 5, CRDOB: 5 } });
  const pin = await w.rfqPin();
  const named = symbolsOf(w.rows, pin.rfqOnly);
  assert.equal(named[0], "AMDB");
  const row = (symbol: string) => pin.costs.find((cost) => cost.token.toLowerCase() === w.rows.find((r) => r.symbol === symbol)!.address.toLowerCase())!;
  assert.deepEqual([row("PYPLB").costBps, row("COHRB").costBps, row("CRDOB").costBps], [null, null, null]);
});

test("guard unverified or unset: no Flash call, every cost null, address order", async (t) => {
  const w = await world(t, { guardVerified: false, costs: { AMDB: 10 } });
  const pin = await w.rfqPin();
  assert.equal(w.flash.calls.length, 0);
  assert.ok(pin.costs.every((row) => row.costBps === null));
  assert.deepEqual(pin.rfqOnly, [...pin.rfqOnly].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  assert.equal(pin.rfqOnly.length, 26, "the stocks are still pinned");
});

test("R3.9: a quote that fails the validation ranks that stock last (future, stale, wrong echo, wrong taker, wrong router, zero out)", async (t) => {
  const w = await world(t, { costs: { AMDB: 10, IBMB: 20, QCOMB: 30, GLWB: 5, MUUB: 6, AVGOB: 7, WDCB: 8 } });
  const original = w.flash.binanceQuoteAndSwap.bind(w.flash);
  const bad = new Map<string, Partial<TradfiFlashQuote>>([["AMDB", { observedAt: NOW + 5_000 }], ["IBMB", { observedAt: NOW - 31_000 }], ["QCOMB", { taker: getAddress("0x5555555555555555555555555555555555555555") }],
    ["GLWB", { amountInAtomic: "1" }], ["MUUB", { router: getAddress("0x5555555555555555555555555555555555555555") }], ["AVGOB", { quotedOutAtomic: "0" }], ["WDCB", { chainId: 97 as unknown as 56 }]]);
  const wrapped = async (request: Parameters<typeof original>[0]) => {
    const quote = await original(request);
    const symbol = w.rows.find((row) => row.address.toLowerCase() === request.tokenOut.toLowerCase())!.symbol;
    return { ...quote, ...(bad.get(symbol) ?? {}) };
  };
  w.flash.binanceQuoteAndSwap = wrapped as typeof w.flash.binanceQuoteAndSwap;
  const pin = await w.rfqPin();
  assert.ok(pin.costs.every((row) => row.costBps === null), JSON.stringify(pin.costs.slice(0, 4)));
});

test("the cache lives 30 s and has its own key; a concurrent caller awaits the running sweep instead of starting a second one", async (t) => {
  const w = await world(t, { costs: { AMDB: 10 } });
  const [a, b] = await Promise.all([w.rfqPin(), w.rfqPin()]);
  assert.equal(a, b, "one sweep, one result");
  assert.equal(w.flash.calls.length, 26);
  await w.rfqPin();
  assert.equal(w.flash.calls.length, 26, "served from the cache");
  w.tick(29_999); await w.rfqPin();
  assert.equal(w.flash.calls.length, 26, "still inside 30 s");
  w.tick(1); await w.rfqPin();
  assert.equal(w.flash.calls.length, 52, "30 s later a new sweep");
});

test("rerankHeld is not applied: a held RFQ-only stock keeps its rank, while the Altana AI pin still moves a held pooled one first", async (t) => {
  const w = await world(t, { costs: { AMDB: 10, IBMB: 20 } });
  const before = await w.rfqPin();
  const held = w.rows.find((row) => row.symbol === "IBMB")!.address, heldPooled = w.rows.find((row) => row.symbol === "SPYB")!.address;
  w.provider.tokenBalances.set(held.toLowerCase(), 5n * E);
  w.provider.tokenBalances.set(heldPooled.toLowerCase(), 5n * E);
  w.tick(31_000);
  const after = await w.rfqPin();
  assert.deepEqual(after.rfqOnly, before.rfqOnly, "no held-first reordering of the RFQ part");
  assert.deepEqual(after.pooled, before.pooled);
  const altana = await w.pairings.pin!(W, 5n * E, 100, "ai");
  assert.equal(altana[0]!.toLowerCase(), heldPooled.toLowerCase(), "today's pin ranks a held pooled stock first");
  assert.ok(!altana.some((address) => admittedVenueRows(w.rows.find((row) => row.address === address)!.venues).length === 0), "an Altana AI pin taken after the RFQ pin has no pool-less stock");
});

test("R3.12(b): two lane rows sharing an underlying ticker keep the deeper one in the pin and name both symbols in one log line", async (t) => {
  const rows = await loadRfqUniverse(true);
  const nvda = rows.find((row) => row.symbol === "NVDAB")!;
  const twin: UniverseRow = { ...nvda, address: getAddress("0x00000000000000000000000000000000000000aa"), symbol: "NVDXB", venues: nvda.venues!.slice(5, 6),
    rwa: { ...nvda.rwa!, venues: nvda.venues!.slice(5, 6) } };
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => { lines.push(line); });
  const w = await world(t, { rows: [...rows, twin] });
  const pin = await w.rfqPin();
  const all = [...pin.pooled, ...pin.rfqOnly].map((a) => a.toLowerCase());
  assert.ok(all.includes(nvda.address.toLowerCase()));
  assert.ok(!all.includes(twin.address.toLowerCase()), "the shallower twin is dropped");
  assert.equal(lines.filter((line) => line.includes("NVDA")).length, 1);
  assert.match(lines.find((line) => line.includes("NVDA"))!, /NVDAB.*NVDXB/u);
});

test("an unreadable universe refuses (the hire then answers pin-error)", async (t) => {
  const f = await fixture(t);
  const pairings = new AgenticPairings({ ...f.pairings.deps, rfqEnabled: true } as AgenticRoutesDeps);
  const rows = await loadRfqUniverse(true);
  pinServer({ pairings, dataPlane: rfqDataPlane(rows, { universe: async () => { throw new Error("down"); } }), trade: { aggregatorGuard: GUARD } });
  await assert.rejects(() => (pairings.rfqPin as Pin)());
});

test("flag off: the registration carries no rfqPin", async (t) => {
  const w = await world(t, { flag: false });
  assert.equal(w.pairings.rfqPin, null);
});

/** AGENTIC-RFQ-STOCKS 4.4 (E4): the Agentic AI hire with the RFQ pin variant: admission loop, sizing, hire_facts.rfq, and the hires that never touch it. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type Address } from "viem";
import type { TradeSettings } from "../src/trade/settings.js";
import { agenticAddress, agenticHireIdentity, parseAgenticHireParams, type AgenticWallet } from "../src/agentic/domain.js";
import type { AgenticRfqPin } from "../src/agentic/rfq.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { E, PAIRED, PAIRING, TOKEN, W, aiParams, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";
import { QQQB, SPYB, portfolioParams } from "./support/agenticPortfolio.js";
import { SPYB as DCA_STOCK, USDT, dcaParams } from "./support/agenticDca.js";

const addr = (n: number): Address => agenticAddress("0x" + (0x2000 + n).toString(16).padStart(40, "0"));
const request = (settings: TradeSettings = aiParams) => ({ pairingId: PAIRING, term: 7, termEndAction: "keep", executionModel: "tradfi",
  hireRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", acceptedDedicatedWallet: true, settings });
const paired = (t: TestContext, settings: TradeSettings = aiParams, patch: Partial<AgenticWallet> = {}) => fixture(t, { ...PAIRED, ...patch }, settings);
const stored = async (f: Fixture) => (await f.store.getWallet(PAIRING))!;
async function accept(f: Fixture, settings: TradeSettings = aiParams) {
  const params = parseAgenticHireParams(request(settings))!, identity = agenticHireIdentity(params);
  return (await f.store.acceptHire(f.row, { hireOpId: identity.hireOpId, agentId: identity.agentId, hireParams: params, termEndAction: "keep" }))!;
}
/** 24 pooled stocks then 26 RFQ-only ones, the shape of the 2026-10-04 universe. */
const pin = (pooled = 24, rfq = 26): AgenticRfqPin => ({ pooled: Array.from({ length: pooled }, (_, i) => addr(i)), rfqOnly: Array.from({ length: rfq }, (_, i) => addr(100 + i)),
  costs: Array.from({ length: rfq }, (_, i) => ({ token: addr(100 + i), costBps: i % 5 === 0 ? null : 10 + i })) });
const withRfq = (f: Fixture, result: AgenticRfqPin = pin()) => { const calls = { count: 0 }; f.pairings.rfqPin = async () => { calls.count += 1; return result; }; return calls; };
const all = (result: AgenticRfqPin) => [...result.pooled, ...result.rfqOnly];

test("a flag-on AI hire with 50 candidates binds: pinned 50 in pin order, hire_facts.rfq written once with the pooled count, the RFQ-only list, the costs and the 20 USDT notional", async (t) => {
  const f = await paired(t);
  const result = pin(), calls = withRfq(f, result), writes: unknown[] = [];
  f.pairings.pin = async () => { throw new Error("the flag-on AI hire takes the RFQ pin variant"); };
  const patch = f.store.patchWallet.bind(f.store);
  t.mock.method(f.store, "patchWallet", async (current: Parameters<typeof patch>[0], change: Parameters<typeof patch>[1]) => { if (change.hireFacts !== undefined) writes.push(change.hireFacts); return patch(current, change); });
  const hired = await f.pairings.hire(f.row, request());
  const facts = hired.hireFacts!;
  assert.equal(hired.state, "bound");
  assert.equal(calls.count, 1);
  assert.deepEqual(facts.pinned, all(result));
  assert.equal(writes.length, 1, "hire_facts is written once");
  assert.deepEqual(facts.rfq, { v: 1, notionalWei: "20000000000000000000", pooledCount: 24, rfqOnly: result.rfqOnly, costs: result.costs });
  assert.equal(facts.rfq!.rfqOnly.length, 26);
  assert.deepEqual(facts.hireSizing, { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", capitalQuoteWei: (10n * E).toString(), entryWei: (5n * E).toString(),
    minEntryWei: (5n * E).toString(), quotePerTradeWei: (5n * E).toString(), cmcNewsEnabled: true, cmcTotalBudgetWei: (2n * E).toString() });
});

test("5.2 sizing table: n = 1 granted token for the variant (mutation: pinned.length refuses at 50); the quote leg still decides", async (t) => {
  const cases: [string, Partial<TradeSettings>, number, string][] = [
    ["maxOpen 1, entry 5, capital 5, 24 pooled", { maxOpenPositions: 1, capitalQuoteWei: (5n * E).toString() }, 24, "bound"],
    ["maxOpen 2, entry 5, capital 10, 50 pinned", {}, 50, "bound"],
    ["maxOpen 2, entry 6, capital 10, 50 pinned", { entryWei: (6n * E).toString() }, 50, "sizing"],
  ];
  for (const [label, patch, count, expected] of cases) {
    const settings = { ...aiParams, ...patch } as TradeSettings;
    const f = await paired(t, settings), accepted = await accept(f, settings);
    withRfq(f, pin(24, count - 24 < 0 ? 0 : count - 24));
    if (count === 24) f.pairings.rfqPin = async () => pin(24, 0);
    const outcome = await f.pairings.resumeHire(accepted).then(() => "bound", (error: Error) => error.message === "gate-failed" ? "sizing" : error.message);
    assert.equal(outcome, expected, label);
    if (expected === "sizing") assert.equal((await stored(f)).failure, "sizing");
    if (expected === "bound") assert.equal((await stored(f)).hireFacts!.pinned.length, count, label);
  }
});

test("flag off: an AI hire calls this.pin(..., 'ai'), writes no rfq record, and 50 candidates still refuse sizing (granted 50 > 28)", async (t) => {
  const f = await paired(t), accepted = await accept(f), args: unknown[][] = [];
  f.pairings.pin = async (...a) => { args.push(a); return all(pin()); };
  assert.equal(f.pairings.rfqPin, null);
  await assert.rejects(() => f.pairings.resumeHire(accepted), /gate-failed/);
  assert.equal((await stored(f)).failure, "sizing");
  assert.deepEqual(args.map((a) => [a[1], a[3]]), [[5n * E, "ai"]]);
  const g = await paired(t), acceptedG = await accept(g);
  g.pairings.pin = async () => all(pin(24, 0));
  const hired = await g.pairings.resumeHire(acceptedG);
  assert.equal(hired.hireFacts!.rfq, undefined);
  assert.equal(hired.hireFacts!.pinned.length, 24);
});

test("a failing RFQ pin is pin-error; an unreadable pin leaves the pairing cleaning like today's", async (t) => {
  const f = await paired(t), accepted = await accept(f);
  f.pairings.rfqPin = async () => { throw new Error("private"); };
  await assert.rejects(() => f.pairings.resumeHire(accepted), /gate-failed/);
  assert.deepEqual({ state: (await stored(f)).state, failure: (await stored(f)).failure }, { state: "cleaning", failure: "pin-error" });
});

test("admission loop: the fence is renewed before the first and after the last token read, nothing in between; the flag-off AI loop renews zero times", async (t) => {
  const events = async (rfq: boolean) => {
    const f = await paired(t), accepted = await accept(f), log: string[] = [];
    if (rfq) withRfq(f, pin(10, 10)); else f.pairings.pin = async () => all(pin(10, 0));
    const renew = f.store.renewFence.bind(f.store);
    t.mock.method(f.store, "renewFence", async (fence: Parameters<typeof renew>[0]) => { log.push("renew"); return renew(fence); });
    const metadata = f.chain.metadata, multiplier = f.chain.multiplier;
    f.chain.metadata = async (token) => { log.push("metadata"); return metadata(token); };
    f.chain.multiplier = async (token) => { log.push("multiplier"); return multiplier(token); };
    await f.pairings.resumeHire(accepted);
    return log;
  };
  const withFlag = await events(true), without = await events(false);
  const first = withFlag.indexOf("metadata"), last = withFlag.lastIndexOf("multiplier");
  assert.equal(withFlag[first - 1], "renew", "a renewal right before the first read");
  assert.equal(withFlag[last + 1], "renew", "a renewal right after the last read");
  assert.ok(!withFlag.slice(first, last + 1).includes("renew"), "none between the reads");
  assert.equal(withFlag.filter((e) => e === "renew").length - without.filter((e) => e === "renew").length, 2);
});

test("admission loop: four reads at a time, candidate order preserved; unreadable, 17-decimal and multiplier < 1e18 tokens are dropped", async (t) => {
  const f = await paired(t), accepted = await accept(f);
  const result = pin(8, 12);
  withRfq(f, result);
  const [unreadable, seventeen, small] = [result.pooled[1]!, result.rfqOnly[2]!, result.rfqOnly[5]!];
  let active = 0, peak = 0;
  f.chain.metadata = async (token) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, (all(result).indexOf(token) % 4) * 3));
    active -= 1;
    if (token === unreadable) throw new Error("rpc");
    return { decimals: token === seventeen ? 17 : 18, symbol: "X" };
  };
  f.chain.multiplier = async (token) => token === small ? E - 1n : E;
  const hired = await f.pairings.resumeHire(accepted);
  const kept = all(result).filter((token) => ![unreadable, seventeen, small].includes(token));
  assert.deepEqual(hired.hireFacts!.pinned, kept, "candidate order, the three dropped");
  assert.equal(peak, 4);
  assert.deepEqual(hired.hireFacts!.rfq!.rfqOnly, result.rfqOnly.filter((token) => ![seventeen, small].includes(token)));
  assert.equal(hired.hireFacts!.rfq!.pooledCount, 7);
  assert.ok(hired.hireFacts!.rfq!.costs.every((row) => kept.includes(row.token)), "costs only for the stocks that were pinned");
});

test("the ceiling of 64 is applied after the hire filter, keeping pooled first (70 candidates)", async (t) => {
  const f = await paired(t), accepted = await accept(f);
  const result = pin(24, 46);
  withRfq(f, result);
  const hired = await f.pairings.resumeHire(accepted);
  assert.deepEqual(hired.hireFacts!.pinned, all(result).slice(0, 64));
  assert.equal(hired.hireFacts!.rfq!.pooledCount, 24);
  assert.equal(hired.hireFacts!.rfq!.rfqOnly.length, 40);
  const g = await paired(t), acceptedG = await accept(g);
  withRfq(g, result);
  g.chain.metadata = async (token) => ({ decimals: token === result.pooled[0] ? 17 : 18, symbol: "X" });
  const filtered = await g.pairings.resumeHire(acceptedG);
  assert.equal(filtered.hireFacts!.pinned.length, 64, "the filter runs first, so a dropped token lets the next candidate in");
  assert.ok(!filtered.hireFacts!.pinned.includes(result.pooled[0]!));
});

test("Schedule, Portfolio and DCA hires with the flag on never call rfqPin", async (t) => {
  const schedule = await paired(t, scheduleParams), calls = withRfq(schedule);
  schedule.pairings.pin = async () => [TOKEN, ...Array.from({ length: 29 }, (_, i) => addr(i))]; schedule.pairings.schedulable = async () => [TOKEN];
  assert.equal((await schedule.pairings.hire(schedule.row, request(scheduleParams))).state, "bound");
  const portfolio = await fixture(t, { ...PAIRED }, portfolioParams), portfolioCalls = withRfq(portfolio);
  portfolio.pairings.pin = async () => { throw new Error("a portfolio hire reads no pin"); }; portfolio.pairings.portfolioBuyQuote = async () => undefined;
  assert.equal((await portfolio.pairings.hire(portfolio.row, request(portfolioParams))).state, "bound");
  const dcaSettings = dcaParams();
  const dca = await fixture(t, { ...PAIRED }, dcaSettings), dcaCalls = withRfq(dca);
  Object.assign(dca.pairings.deps, { dcaEnabled: true });
  dca.pairings.pin = async () => { throw new Error("a DCA hire reads no pin"); };
  const pool = DCA_POOLS_56.find((p) => p.stock.toLowerCase() === DCA_STOCK)!;
  dca.chain.poolState = async () => ({ token0: pool.usdtIsToken0 ? USDT : DCA_STOCK, token1: pool.usdtIsToken0 ? DCA_STOCK : USDT, fee: pool.fee, tickSpacing: pool.tickSpacing, sqrtPriceX96: 1n << 96n, tick: 0, block: 1n });
  assert.equal((await dca.pairings.hire(dca.row, request(dcaSettings))).state, "bound");
  assert.deepEqual([calls.count, portfolioCalls.count, dcaCalls.count], [0, 0, 0]);
  void QQQB; void SPYB; void W;
});

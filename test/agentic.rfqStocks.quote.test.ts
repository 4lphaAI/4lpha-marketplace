/** AGENTIC-RFQ-STOCKS 4.7 (E7): the Agentic quote source of the worker. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agenticQuoteRaw, agenticUiString } from "../src/agentic/domain.js";
import { RFQ_THROTTLE_MS, agenticRfqQuote, createAgenticRfqStocks } from "../src/agentic/rfq.js";
import type { BawResult } from "../src/agentic/baw.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { E, NOW, TOKEN, W, aiParams, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";

const usdt = USDT_56.toLowerCase();
const M = 1_001_771_778_813_000_000n;
const ok = (toCoinAmount: string): BawResult => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "X", fromCoinAmount: "1", toCoinSymbol: "Y", toCoinAmount, slippage: "0" } });
const error = (name: string, code = 1): BawResult => ({ kind: "cli-error", code, name, orderId: null, sessionPresent: true });
const quotes = (f: Fixture) => f.runner.calls.filter((args) => args[0] === "market-order" && args[1] === "quote");
const ask = (f: Fixture, side: "buy" | "sell", amountAtomic: bigint) => agenticRfqQuote(f, { agent: f.agent, side, token: TOKEN, amountAtomic });
const freshFence = async (f: Fixture) => { const fence = await f.store.acquireFence(W, "probe"); if (fence !== null) await f.store.releaseFence(fence); return fence !== null; };

test("exact argv: the allowlisted market-order quote, USDT to the stock for a buy and the stock to USDT for a sell", async (t) => {
  const f = await fixture(t);
  f.runner.replies.set("market-order quote", ok("5.1"));
  assert.deepEqual(await ask(f, "buy", 5n * E), { ok: true, outAtomic: 51n * E / 10n });
  assert.deepEqual(quotes(f), [["market-order", "quote", "--fromToken", usdt, "--toToken", TOKEN, "--fromTokenQty", "5", "--binanceChainId", "56"]]);
  f.runner.replies.set("market-order quote", ok("3.25"));
  assert.deepEqual(await ask(f, "sell", 2n * E), { ok: true, outAtomic: 325n * E / 100n });
  assert.deepEqual(quotes(f).at(-1), ["market-order", "quote", "--fromToken", TOKEN, "--toToken", usdt, "--fromTokenQty", "2", "--binanceChainId", "56"]);
});

test("buy conversion with the measured PYPLB multiplier 1.001771778813 and sell fromQty", async (t) => {
  const f = await fixture(t);
  f.chain.multiplier = async () => M;
  f.runner.replies.set("market-order quote", ok("0.375"));
  assert.deepEqual(await ask(f, "buy", 20n * E), { ok: true, outAtomic: 375_000_000_000_000_000n * 10n ** 12n / 1_001_771_778_813n });
  assert.equal(agenticQuoteRaw("0.375", agenticUiString(M)), 375_000_000_000_000_000n * 10n ** 12n / 1_001_771_778_813n);
  await ask(f, "sell", 1n * E);
  assert.equal(quotes(f).at(-1)![7], "1.001771778813", "a sell sends the UI quantity, raw amount x multiplier");
  f.runner.replies.set("market-order quote", ok("53.3333"));
  assert.deepEqual(await ask(f, "sell", E / 2n), { ok: true, outAtomic: 533_333n * 10n ** 14n });
});

test("fence: acquired, renewed, released conditionally on every exit; a busy wallet answers rfq-wallet-busy without a command", async (t) => {
  const f = await fixture(t);
  f.runner.replies.set("market-order quote", ok("5.1"));
  const acquired = t.mock.method(f.store, "acquireFence"), renewed = t.mock.method(f.store, "renewFence"), released = t.mock.method(f.store, "releaseFence");
  assert.equal((await ask(f, "buy", 5n * E)).ok, true);
  assert.deepEqual([acquired.mock.callCount(), renewed.mock.callCount(), released.mock.callCount()], [1, 1, 1]);
  assert.equal(await freshFence(f), true, "the fence is free again");
  t.mock.method(f.store, "renewFence", async () => null);
  const lost = await ask(f, "buy", 5n * E);
  assert.deepEqual(lost, { ok: false, code: "rfq-wallet-busy" });
  assert.equal(quotes(f).length, 1, "a lost lease runs no command");
  assert.equal(await freshFence(f), true, "and still releases");
});

test("a fence held by another process answers rfq-wallet-busy after the 5 s wait and runs no command", async (t) => {
  const f = await fixture(t);
  assert.ok(await f.store.acquireFence(W, "execution-api"));
  assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-wallet-busy" });
  assert.equal(quotes(f).length, 0);
});

test("a U signal answer is recorded on the wallet probe; a non-bound row runs no command", async (t) => {
  const f = await fixture(t);
  f.runner.replies.set("market-order quote", { kind: "cli-error", code: 10003002, name: "SESSION_EXPIRED", orderId: null, sessionPresent: true });
  assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unreachable" });
  assert.equal((await f.store.byAgent(f.agent.id))?.probe?.firstUAtMs, NOW);
  const ended = await fixture(t, { state: "ending" });
  const before = quotes(ended).length;
  assert.deepEqual(await ask(ended, "buy", 5n * E), { ok: false, code: "rfq-unreachable" });
  assert.equal(quotes(ended).length, before);
});

test("representability: a multiplier below 1e18, 17 decimals or an unreadable chain answers rfq-unrepresentable with no command", async (t) => {
  for (const configure of [(f: Fixture) => { f.chain.multiplier = async () => E - 1n; }, (f: Fixture) => { f.chain.metadata = async () => ({ decimals: 17, symbol: "X" }); },
    (f: Fixture) => { f.chain.multiplier = async () => { throw new Error("rpc"); }; }, (f: Fixture) => { f.chain.metadata = async () => { throw new Error("rpc"); }; }]) {
    const f = await fixture(t);
    configure(f);
    assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unrepresentable" });
    assert.equal(quotes(f).length, 0);
  }
});

test("each CLI error name maps to its closed code; an unparseable or non-positive amount answers rfq-unparseable", async (t) => {
  const f = await fixture(t);
  for (const name of ["SERVICE_ERROR", "ORDER_API_ERROR", "APP_CONFIRMATION_REQUIRED", "INSUFFICIENT_BALANCE", "INSUFFICIENT_GAS", "INVALID_TOKEN", "INVALID_PARAMETER"]) {
    f.runner.replies.set("market-order quote", error(name));
    assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: `rfq-refused:${name}` });
  }
  for (const name of ["NETWORK_ERROR", "REQUEST_TIMEOUT", "UNKNOWN_ERROR", "DNS_ERROR"]) {
    f.runner.replies.set("market-order quote", error(name));
    assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unreachable" });
  }
  for (const reply of [{ kind: "no-response", code: "timeout", sessionPresent: true } as const, { kind: "not-started", sessionPresent: true } as const]) {
    f.runner.replies.set("market-order quote", reply);
    assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unreachable" });
  }
  for (const amount of ["abc", "0", "-1", "1e3", ""]) {
    f.runner.replies.set("market-order quote", ok(amount));
    assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unparseable" }, amount);
    assert.deepEqual(await ask(f, "sell", E), { ok: false, code: "rfq-unparseable" }, amount);
  }
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: null });
  assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unparseable" });
});

test("throttle: SERVICE_UNAVAILABLE skips every command for 300 000 ms, 299 999 ms still skips, 300 000 ms resumes", async (t) => {
  const f = await fixture(t);
  f.runner.replies.set("market-order quote", error("SERVICE_UNAVAILABLE", 503));
  assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-unreachable" });
  assert.equal(quotes(f).length, 1);
  f.runner.replies.set("market-order quote", ok("5.1"));
  assert.equal(RFQ_THROTTLE_MS, 300_000);
  for (const at of [NOW, NOW + 1, NOW + 299_999]) {
    f.setTime(at);
    assert.deepEqual(await ask(f, "buy", 5n * E), { ok: false, code: "rfq-throttled" }, String(at));
    assert.equal(quotes(f).length, 1, "no command while throttled");
  }
  f.setTime(NOW + 300_000);
  assert.deepEqual(await ask(f, "buy", 5n * E), { ok: true, outAtomic: 51n * E / 10n });
  assert.equal(quotes(f).length, 2);
});

test("the throttle is per agent: another agent's quote is not skipped", async (t) => {
  const f = await fixture(t);
  f.runner.replies.set("market-order quote", error("SERVICE_UNAVAILABLE", 429));
  await ask(f, "buy", 5n * E);
  const other = await fixture(t);
  other.runner.replies.set("market-order quote", ok("5.1"));
  assert.equal((await ask(other, "buy", 5n * E)).ok, true);
});

test("active(): non-null only for a bound AI hire with the rfq marker; entries is the worker's own flag", async (t) => {
  const base = (await fixture(t)).row.hireFacts!;
  const rfqFacts = { ...base, rfq: { v: 1 as const, notionalWei: (20n * E).toString(), pooledCount: 24, rfqOnly: [TOKEN, "0x3333333333333333333333333333333333333333" as const], costs: [] } };
  const plain = await fixture(t);
  assert.equal(await createAgenticRfqStocks({ execution: plain, entries: true }).active(plain.agent), null, "no marker");
  for (const entries of [true, false]) {
    const g = await fixture(t, { hireFacts: rfqFacts });
    const dep = createAgenticRfqStocks({ execution: g, entries });
    const active = await dep.active(g.agent);
    assert.ok(active);
    assert.equal(active.entries, entries);
    assert.deepEqual([...active.rfqOnlyAtHire].sort(), [TOKEN, "0x3333333333333333333333333333333333333333"].sort());
    assert.equal(await dep.active({ ...g.agent, custodyModel: "passkey" }), null, "never for an Altana agent");
    const ended = await fixture(t, { hireFacts: rfqFacts, state: "ending" });
    assert.equal(await createAgenticRfqStocks({ execution: ended, entries }).active(ended.agent), null, "only a bound hire");
  }
  const schedule = await fixture(t, { hireFacts: rfqFacts }, scheduleParams);
  assert.equal(await createAgenticRfqStocks({ execution: schedule, entries: true }).active(schedule.agent), null, "a Schedule hire never becomes RFQ-active");
  void aiParams;
});

test("the refusal-name set is the executor's own (source scan; execute.ts stays untouched)", () => {
  const names = (path: string, marker: string): string[] => {
    const text = readFileSync(path, "utf8");
    const at = text.indexOf(marker);
    return [...text.slice(at, text.indexOf("]", at)).matchAll(/"([A-Z_]+)"/gu)].map((match) => match[1]!).sort();
  };
  const executor = names("src/agentic/execute.ts", "const QUOTE_REFUSAL_NAMES"), source = names("src/agentic/rfq.ts", "const QUOTE_REFUSAL_NAMES");
  assert.equal(executor.length, 7);
  assert.deepEqual(source, executor);
});

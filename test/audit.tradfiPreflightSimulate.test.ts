import assert from "node:assert/strict";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fixture, normalized, decodeSimulatedCalls, NOW } from "./support/auditPreflightTrade.js";
import { harness, ready, inputFor, READING, DEADLINE, LEVEL } from "./support/auditPreflightDca.js";
import { activeRound } from "./support/auditPreflightWorker.js";
import { GUARD, OWNER, AGENT_ID, NV, E18 } from "./support/dcaFixtures.js";
import { planDcaClose, planDcaFill, planDcaRemove, planDcaStopLoss, planDcaTpPlace } from "../src/trade/dca.js";
import { executeDcaRangeBatch } from "../src/trade/dcaExecute.js";
import { HttpTradeDataPlaneReads, type TradfiSimulateResult } from "../src/trade/dataPlaneReads.js";
import { InfrastructureError } from "../src/core/types.js";
import { GUARD_DEADLINE_REASONS, createTradfiEvidenceWriter, type TradfiPreflightDeps } from "../src/trade/simulate.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56 } from "../src/trade/guard.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import type { RouteQuoteReader } from "../src/trade/route.js";

const answer = (raw: string | null, status: "SUCCESS" | "FAILED" = "FAILED"): TradfiSimulateResult =>
  ({ status, failReason: raw, balanceChanges: [], otherChangeCount: 0, upstreamMs: 0 });
const reasons = [null, "out of gas", "execution reverted", "execution reverted Arguments: hidden",
  " execution reverted: STF", "Execution reverted: STF", "execution  reverted: STF",
  ...GUARD_DEADLINE_REASONS, "execution reverted: 0xdccae4f5 ", "execution reverted: 0xDCCAE4F5",
  "execution reverted: OutputShortfall() context=0xdccae4f5"];
const guardQuote = { guard: GUARD, router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56,
  calldata: "0xad43f73d" as const, deadline: BigInt(NOW / 1000) + 60n };

it("AP1/AP3 independent raw matrix reaches the real trade executor and checks rollback or one submit", async () => {
  for (const side of ["buy", "sell"] as const) for (const guard of [false, true]) for (const raw of reasons) {
    const f = await fixture();
    const blocked = side === "buy" && raw !== null && raw.startsWith("execution reverted") && !guard;
    const result = await f.run({ side, ...(side === "sell" ? { platformFeeAtomic: 0n } : {}), ...(guard ? { guardQuote } : {}) },
      { simulate: async () => answer(raw), evidence: { insert: () => { throw Error("optional storage unavailable"); } } });
    assert.equal(result.kind, blocked ? "rolled-back" : "committed", `${side}/${guard}/${raw}`);
    assert.equal(f.provider.executeCalls.length, blocked ? 0 : 1);
    if (blocked) {
      assert.equal((await f.journal.get(`0x${"11".repeat(32)}`))?.state, "ROLLED_BACK");
      assert.equal(await f.journal.sumPendingQuoteSpendSince(f.agent.id, 0), 0n);
    }
  }
});

it("AP1 every reducing DCA plan, including fill without new levels, submits every valid answer", async () => {
  const base = { pool: NV, roundNo: 1, reading: READING, deadlineSec: DEADLINE };
  const tp = { ...LEVEL, role: "tp" as const, orderKey: "audit-tp", levelNo: null, tokenId: 7n, tickLower: 55_000, tickUpper: 55_050 };
  const plans = [
    planDcaStopLoss({ ...base, orders: [LEVEL], slippageBps: 100 }),
    planDcaRemove({ ...base, orders: [LEVEL], slippageBps: 100 }),
    planDcaClose({ ...base, tp, liveLevels: [LEVEL] }),
    planDcaTpPlace({ ...base, ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n }, walletRoundStockWei: 67n * 10n ** 15n, takeProfitBps: 150, tpOrderKey: "new-tp" }),
    planDcaFill({ ...base, reading: { ...READING, tick: 53_880, sqrtPriceX96: getSqrtRatioAtTick(53_880) },
      filled: [{ ...LEVEL, mintedUsdtWei: 10n * E18 }], oldTp: null, ledger: { costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n },
      walletRoundStockWei: 10n ** 15n, takeProfitBps: 150, tpOrderKey: "fill-tp", orderWei: 10n * E18, nextLevels: [] }),
  ].map(ready);
  for (const plan of plans) for (const result of [answer(null, "SUCCESS"), ...reasons.map(raw => answer(raw))]) {
    const h = await harness();
    let count = 0;
    const outcome = await executeDcaRangeBatch({ ...h.deps, preflight: { simulate: async () => { count++; return result; }, evidence: { insert: () => {} } } }, inputFor(h, plan));
    assert.equal(outcome.kind, "submitted", `${plan.kind}/${result.failReason}`);
    assert.equal(count, 1); assert.equal(h.provider.executeCalls.length, 1);
  }
});

it("AP2 malformed HTTP replies and every unavailable class reach submission", async () => {
  const wire = { version: "binance-simulate-v1", status: "FAILED", failReason: "execution reverted: STF", balanceChanges: [], otherChangeCount: 0 };
  const bodies = [null, {}, { data: { ...wire, version: "wrong" } }, { data: { ...wire, status: "failed" } },
    { data: { ...wire, failReason: "x".repeat(2049) } }, { data: { ...wire, otherChangeCount: 65 } },
    { data: { ...wire, balanceChanges: [{ token: "invalid", owner: "invalid", change: "0" }] } }, { data: wire, meta: { upstreamMs: -1 } }];
  for (const body of bodies) {
    const f = await fixture();
    const client = new HttpTradeDataPlaneReads({ baseUrl: "https://offline.invalid", fetch: async () => new Response(JSON.stringify(body)) });
    assert.equal((await f.run({}, { simulate: input => client.binanceSimulate(input), evidence: { insert: () => {} } })).kind, "committed");
  }
  for (const reason of ["window", "shape", "timeout", "rate-limited", "auth", "credentials", "unavailable", "malformed", "upstream-error", "bogus"]) {
    const f = await fixture();
    assert.equal((await f.run({}, { simulate: async () => { throw new InfrastructureError(`simulate:${reason}`); }, evidence: { insert: () => {} } })).kind, "committed");
  }
});

it("AP2 ignored abort and a never-settling writer cannot hold a guard buy or sell", async t => {
  for (const side of ["buy", "sell"] as const) {
    const f = await fixture();
    let invoked = 0;
    const writer = createTradfiEvidenceWriter({ insertSimulation: () => { invoked++; return new Promise(() => {}); }, insertActual: async () => {}, close: async () => {} }, () => {});
    let started: () => void = () => {};
    const began = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = f.run({ side, ...(side === "sell" ? { platformFeeAtomic: 0n } : {}), guardQuote }, {
      evidence: writer, simulate: async input => { signal = input.signal; started(); return new Promise(() => {}); },
    });
    await began; t.mock.timers.tick(2000);
    assert.equal((await pending).kind, "committed"); assert.equal(signal?.aborted, true); assert.equal(invoked, 1);
    const stop = writer.shutdown(); t.mock.timers.tick(3500); await stop;
    t.mock.timers.reset();
  }
});

it("AP4 full submitted bytes stay identical across direct and clamped guard buys and sells", async () => {
  for (const side of ["buy", "sell"] as const) for (const guard of [false, true]) {
    const f = await fixture(); let simulated = "0x" as `0x${string}`;
    assert.equal((await f.run({ side, ...(side === "sell" ? { platformFeeAtomic: 0n } : {}), ...(guard ? { guardQuote } : {}) }, {
      evidence: { insert: () => {} }, simulate: async tx => { simulated = tx.data; return answer(null, "SUCCESS"); },
    })).kind, "committed");
    assert.deepEqual(decodeSimulatedCalls(simulated).calls, normalized(f.provider.executeCalls[0]!.calls));
  }
});

for (const streak of [0, 2, 5]) it(`AP5 fresh worker module reads durable rollback at streak ${streak} and submits only close`, async t => {
  let fail = false;
  const preflight: TradfiPreflightDeps = { evidence: { insert: () => {} }, simulate: async () => fail ? answer("execution reverted") : answer(null, "SUCCESS") };
  const w = await activeRound(t, { preflight });
  w.flash.fail = true;
  t.mock.method(w.deps.routeReader!, "quoteV3Single", async (...args: Parameters<RouteQuoteReader["quoteV3Single"]>) => w.stockPerUsdt(args[3]));
  const tp = (await w.orders()).find(row => row.role === "tp" && row.state === "live")!;
  w.chain.tick = tp.tickUpper + 10; await w.cycle();
  const round = (await w.store.getOpenRound(OWNER, AGENT_ID))!;
  await w.store.writeRound({ ...round, revertStreak: streak, backoffUntilMs: null });
  fail = true; await w.cycle();
  assert.equal((await w.lastAction()).note, "SIMULATION_FAILED");
  assert.equal((await w.store.getOpenRound(OWNER, AGENT_ID))?.revertStreak, streak + 1);
  const count = w.provider.executeCalls.length;
  // A distinct module URL gives this run new module-scoped Sets while preserving durable stores.
  const fresh = await import(pathToFileURL(resolve("src/trade/worker.ts")).href + `?final-audit=${streak}`) as typeof import("../src/trade/worker.js");
  w.now += 61_000; w.chain.block += 200n;
  await fresh.runTradeWorkerOnce({ ...w.deps, dca: { ...w.deps.dca! } });
  const close = await w.lastAction();
  assert.equal(close.kind, "close"); assert.equal(close.plan.swap, null); assert.deepEqual(close.plan.mints, []);
  assert.equal(w.provider.executeCalls.length, count + 1);
});

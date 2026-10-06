/** AGENTIC-EARN-SPEC ET10 (+ R11.12): a non-earn hire is exactly today's (zero earn commands, reads and rows, same floors, same keep-alive clock); the worker flag off stops deposits only; the earn floors of buys. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import { projectAgenticSessionFacts } from "../src/agentic/domain.js";
import { executeAgenticTrade } from "../src/agentic/execute.js";
import { E, HOUR, MINUTE, NOW, W, earnSettings, earnWorld, hireFacts, type EarnLane } from "./support/agenticEarn.js";
import { fixture, HASH, TOKEN } from "./support/agenticSchedule.js";
import { SPYB, dcaHireFacts, dcaLane, dcaParams } from "./support/agenticDca.js";

test("I1 for each lane a non-earn hire makes zero earn commands, zero earn chain reads and zero earn rows", async t => {
  for (const lane of ["ai", "schedule", "dca"] as EarnLane[]) {
    const w = await earnWorld(t, { lane, earn: false });
    let reads = 0;
    const real = w.f.chain.earnBalances!;
    w.f.chain.earnBalances = async x => { reads += 1; return real(x); };
    for (let i = 0; i < 3; i += 1) { await w.tick(); await w.advance(MINUTE); }
    assert.equal(w.market.calls.filter(c => c[0] === "defi").length, 0, lane);
    assert.equal(reads, 0, lane);
    assert.equal((await w.rows()).length, 0, lane);
    assert.deepEqual(await w.codes(), [], lane);
  }
});

test("I2 the worker flag off: no deposit is claimed, but a held position still redeems at term end and the sign-out guard still runs", async t => {
  const w = await earnWorld(t, { lane: "schedule", flag: false });
  await w.tick();
  assert.equal(w.market.count("defi deposit"), 0, "flag off: no deposit");
  w.state.venus = 30n * E; w.state.usdt = 70n * E;
  const row = await w.wallet();
  await w.f.store.leaveBound(row, "term-ended");
  await w.tick();
  assert.equal(w.market.count("defi redeem"), 1, "the redeem runs with the flag off");
  assert.equal(w.state.venus, 0n);
  assert.equal(w.market.count("auth signout"), 1, "then the guard lets the sign-out through");
});

test("I3 the free keep-alive clock of a Schedule hire ignores earn rows (R11.12): an earn row at +11 h does not postpone the 12 h read, a swap row does", async t => {
  const reads = async (kind: "earn-redeem" | "swap"): Promise<number> => {
    const w = await earnWorld(t, { lane: "schedule", earn: false });
    await w.at(NOW + 11 * HOUR);
    await w.f.store.patchWallet(await w.wallet(), { probe: { lastAtMs: NOW, firstUAtMs: null, unreachableAtMs: null } });
    const wallet = await w.wallet(), at = NOW + 11 * HOUR;
    await w.f.store.createOrder({ idempotencyKey: "plant:" + kind, kind, walletAddress: W, agentId: wallet.agentId!, decisionId: null, side: null, fromToken: null, toToken: null,
      amountAtomic: "1", intendedRaw: null, fromQty: "1", minOutAtomic: null, binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: null, multiplierUsed: null, listSnapshot: null, operationId: null,
      walletNoncePre: null, quoteAt: null, dispatch: "sealed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null,
      listedOrderId: null, txHash: null, approveTxHash: null, outcome: "rolled-back", holdReason: null, evidence: null, fillCheck: "none", createdAt: at, updatedAt: at });
    await w.advance(2 * HOUR);
    await w.tick();
    return w.market.count("market-order list");
  };
  assert.equal(await reads("earn-redeem"), 1, "the earn row is not activity: the free read fires at 12 h");
  assert.equal(await reads("swap"), 0, "a swap row at +11 h postpones it, as today");
});

const FLOOR = 3n * 400_000_000_000_000n, R = 400_000_000_000_000n;
async function buyAfterFloor(native: bigint, earn: boolean) {
  const stored = earnSettings("schedule");
  const f = await fixture(t0!, earn ? { hireFacts: hireFacts(stored, "schedule", 7, true) } : {}, { ...stored });
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "1", slippage: "0" } });
  const input = { agent: { ...f.agent, sessionFacts: projectAgenticSessionFacts(f.row) }, idempotencyKey: HASH, paramsHash: HASH,
    request: { decisionId: "decision", venue: "pancake" as const, side: "buy" as const, token: TOKEN as Address, amountWei: 10n * E, minOutWei: 9_800_000_000_000_000_000n, quotedOutWei: 10n * E,
      settlementAsset: "USDT" as const, platformFeeAtomic: 0n, route: { hops: [], fees: [] } }, scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: f.executorDeps };
  f.balances.native = native;
  const result = await executeAgenticTrade(input as unknown as Parameters<typeof executeAgenticTrade>[0], f.execution);
  return result.kind === "denied" ? result.code : result.kind === "rolled-back" ? result.code : result.kind;
}
let t0: import("node:test").TestContext | undefined;
test("I4 the executor buy floor of an earn hire is one more reserve (0.0004 BNB); a non-earn hire keeps (open + 2) x 0.0004; sells keep their floor", async t => {
  t0 = t;
  assert.equal(await buyAfterFloor(FLOOR, false), "AGENTIC_QUOTE_BELOW_MIN", "non-earn: the floor is met");
  assert.equal(await buyAfterFloor(FLOOR, true), "AGENTIC_LOW_BNB", "earn: 3R is short of 4R");
  assert.equal(await buyAfterFloor(FLOOR + R - 1n, true), "AGENTIC_LOW_BNB");
  assert.equal(await buyAfterFloor(FLOOR + R, true), "AGENTIC_QUOTE_BELOW_MIN");
});

test("I5 the DCA lane's round-start and level floors are one reserve higher for an earn hire; the take profit floor is unchanged", async t => {
  const settings = dcaParams();
  for (const [earn, native, expected] of [[false, 3n * R, "dca-base-bought"], [true, 3n * R, "dca-low-bnb"], [true, 4n * R, "dca-base-bought"]] as const) {
    const w = await dcaLane(t, { initial: { hireFacts: { ...dcaHireFacts(settings), ...(earn ? { earn: { v: 1 as const } } : {}) } } });
    w.f.balances.native = native;
    await w.tick();
    assert.equal((await w.runs()).find(r => r.reason !== "agentic-earn")?.reason.split(";")[0], expected, `${earn} ${native}`);
  }
  void SPYB; void NOW;
});

/** AGENTIC-SCHEDULE: the Agentic lane for a Schedule hire (slot clock through the shared worker, keep-alive, no CMC fence). */
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { BawRunner, type BawSpawn } from "../src/agentic/baw.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { TradeSettings } from "../src/trade/settings.js";
import type { TradeWorkerDeps } from "../src/trade/worker.js";
import type { UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import { recordAgenticConnection } from "../src/agentic/execute.js";
import { runAgenticCycle } from "../src/agentic/worker.js";
import type { AgenticOrder } from "../src/agentic/domain.js";
import type { AgenticReceipt } from "../src/agentic/resolve.js";
import { E, NOW, TOKEN, W, fixture, scheduleParams, type Fixture } from "./support/agenticSchedule.js";

const HOUR = 3_600_000, TWELVE = 43_200_000;
const LIST_ARGV = ["market-order", "list", "--binanceChainId", "56", "--page", "1", "--pageSize", "1"];
const keepAlives = (f: Fixture) => f.runner.calls.filter(args => args.join(" ") === LIST_ARGV.join(" ")).length;
const cycle = async (f: Fixture, at: number) => { f.setTime(at); await runAgenticCycle(f.lifecycle); };

function committedOrder(f: Fixture, createdAt: number): AgenticOrder {
  return { idempotencyKey: keccak256(stringToBytes("order-" + createdAt)), kind: "swap", walletAddress: W, agentId: f.agent.id, decisionId: "d" + createdAt, side: "buy",
    fromToken: USDT_56.toLowerCase() as Address, toToken: TOKEN, amountAtomic: (5n * E).toString(), intendedRaw: null, fromQty: "5", minOutAtomic: (4n * E).toString(),
    binanceQuoteOutAtomic: null, slippagePct: null, multiplierPre: "1", multiplierUsed: null, listSnapshot: null, operationId: null, walletNoncePre: null, quoteAt: null,
    dispatch: "sealed", claimedAt: null, claimant: null, fenceToken: null, claimDeadline: null, response: null, cliResult: null, returnedOrderId: null, listedOrderId: null,
    txHash: null, approveTxHash: null, outcome: "committed", holdReason: null, evidence: null, fillCheck: "none", createdAt, updatedAt: createdAt };
}

test("K1 keep-alive: one read-only list at 12 h of inactivity, not 1 ms earlier, then every 12 h, and the probe patch lands beside it", async t => {
  const early = await fixture(t, {}, scheduleParams);
  await cycle(early, NOW + TWELVE - 1);
  assert.equal(keepAlives(early), 0);
  const f = await fixture(t, {}, scheduleParams);
  await cycle(f, NOW + TWELVE);
  assert.equal(keepAlives(f), 1);
  const probe = (await f.store.byAgent(f.agent.id))!.probe!;
  assert.deepEqual(probe, { lastAtMs: NOW + TWELVE, firstUAtMs: null, unreachableAtMs: null, keepAliveAtMs: NOW + TWELVE });
  await cycle(f, NOW + TWELVE); await cycle(f, NOW + TWELVE + 300_000);
  assert.equal(keepAlives(f), 1);
  await cycle(f, NOW + 2 * TWELVE);
  assert.equal(keepAlives(f), 2);
});

test("K2 keep-alive: an order younger than 12 h is activity and makes no extra call", async t => {
  const f = await fixture(t, {}, scheduleParams);
  await f.store.createOrder(committedOrder(f, NOW + 6 * HOUR));
  await cycle(f, NOW + TWELVE); assert.equal(keepAlives(f), 0);
  await cycle(f, NOW + 18 * HOUR - 1); assert.equal(keepAlives(f), 0);
  await cycle(f, NOW + 18 * HOUR + 600_000); assert.equal(keepAlives(f), 1);
});

test("K3 keep-alive: never after a U status and never for an AI hire", async t => {
  const u = await fixture(t, {}, scheduleParams);
  u.runner.replies.set("wallet status", { kind: "ok", data: { status: "UNCONNECTED" }, sessionPresent: true, rwaTokens: null });
  await cycle(u, NOW + TWELVE); assert.equal(keepAlives(u), 0);
  assert.equal((await u.store.byAgent(u.agent.id))?.probe?.firstUAtMs, NOW + TWELVE);
  const ai = await fixture(t);
  t.mock.method(ai.cmc, "refresh", async () => undefined);
  await cycle(ai, NOW + TWELVE); await cycle(ai, NOW + 2 * TWELVE);
  assert.equal(keepAlives(ai), 0);
  assert.equal(Object.hasOwn((await ai.store.byAgent(ai.agent.id))!.probe!, "keepAliveAtMs"), false);
});

test("K4 keep-alive: a failed read records the attempt, is no connection signal and is retried 12 h later, not at the next probe", async t => {
  const f = await fixture(t, {}, scheduleParams);
  f.runner.replies.set("market-order list", { kind: "no-response", code: "timeout", sessionPresent: true });
  await cycle(f, NOW + TWELVE);
  assert.equal(keepAlives(f), 1);
  assert.deepEqual((await f.store.byAgent(f.agent.id))!.probe, { lastAtMs: NOW + TWELVE, firstUAtMs: null, unreachableAtMs: null, keepAliveAtMs: NOW + TWELVE });
  await cycle(f, NOW + TWELVE + 300_000); assert.equal(keepAlives(f), 1);
  f.runner.replies.set("market-order list", { kind: "cli-error", code: 1, name: "ANY", orderId: null, sessionPresent: true });
  await cycle(f, NOW + 2 * TWELVE);
  assert.equal(keepAlives(f), 2);
  assert.deepEqual((await f.store.byAgent(f.agent.id))!.probe, { lastAtMs: NOW + 2 * TWELVE, firstUAtMs: null, unreachableAtMs: null, keepAliveAtMs: NOW + 2 * TWELVE });
});

test("K5 keep-alive: recordAgenticConnection carries a stored keepAliveAtMs forward and adds no key to an AI probe", async t => {
  const schedule = await fixture(t, { probe: { lastAtMs: NOW, firstUAtMs: null, unreachableAtMs: null, keepAliveAtMs: NOW - 5 } }, scheduleParams);
  await recordAgenticConnection(schedule.store, schedule.agent.id, { kind: "no-response", code: "timeout", sessionPresent: true });
  assert.deepEqual((await schedule.store.byAgent(schedule.agent.id))!.probe, { lastAtMs: NOW, firstUAtMs: null, unreachableAtMs: NOW, keepAliveAtMs: NOW - 5 });
  const ai = await fixture(t, { probe: { lastAtMs: NOW, firstUAtMs: null, unreachableAtMs: null } });
  await recordAgenticConnection(ai.store, ai.agent.id, { kind: "no-response", code: "timeout", sessionPresent: true });
  assert.deepEqual(Object.keys((await ai.store.byAgent(ai.agent.id))!.probe!), ["lastAtMs", "firstUAtMs", "unreachableAtMs"]);
});

test("K6 keep-alive: the real runner admits the exact argv, the output check accepts a one-row page and the CLI gets no other flag", async context => {
  const root = join(process.cwd(), "scripts", "tmp");
  await mkdir(root, { recursive: true });
  context.mock.method(os, "tmpdir", () => root);
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
  let seen: readonly string[] = [];
  const spawn: BawSpawn = (_file, args, _options, callback) => {
    seen = args;
    const child = new ChildProcess();
    queueMicrotask(() => { child.emit("spawn"); callback(null, JSON.stringify({ success: true, data: { total: 3, page: 1, pageSize: 1, list: [{ orderId: "1", txHash: null, bookTime: null }] } }), ""); child.emit("close", 0); });
    return child;
  };
  const command = await new BawRunner(join(root, "fixture.cjs"), spawn).prepare(LIST_ARGV, { v: 1, instanceId: "11".repeat(32), sessionJson: '{"clientId":"offline","sessionId":"offline"}' });
  const result = await command.start();
  await command.close();
  assert.deepEqual(seen.slice(3), [...LIST_ARGV, "--json"]);
  assert.equal(result.kind, "ok");
});

test("C1 CMC refresh: a Schedule hire never takes the wallet fence for it; an AI hire does", async t => {
  const schedule = await fixture(t, {}, scheduleParams), ai = await fixture(t);
  const sf = t.mock.method(schedule.store, "acquireFence"), af = t.mock.method(ai.store, "acquireFence");
  await schedule.cmc.refresh(schedule.agent.id);
  await ai.cmc.refresh(ai.agent.id).catch(() => undefined);
  assert.deepEqual([sf.mock.callCount(), af.mock.callCount() > 0], [0, true]);
  assert.deepEqual([(await schedule.cmc.target(schedule.agent.id))?.cmcNewsEnabled, (await ai.cmc.target(ai.agent.id))?.cmcNewsEnabled], [false, true]);
});

test("L2 lane: past the entry cutoff a Schedule hire still requests no drain and sends no sell", async t => {
  const f = await fixture(t, {}, scheduleParams);
  await f.positions.open({ positionId: "held", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [] }, entryWei: 5n * E, tokenAmount: 5n * E, fillStatus: "verified", openedAt: NOW,
    settlementAsset: "USDT", requestedEntryAtomic: 5n * E, verifiedEntryAtomic: 5n * E });
  const drains = t.mock.method(f.settings, "requestDrain");
  await cycle(f, NOW + 597_600_000 + 1);
  assert.equal(drains.mock.callCount(), 0);
  assert.equal((await f.store.byAgent(f.agent.id))?.drainRequestedAt, null);
  assert.deepEqual((await f.positions.listOpen(W, f.agent.id)).map(p => p.exitRequestedAt), [null]);
  assert.equal(f.runner.calls.some(args => args[0] === "market-order" && args[1] === "swap"), false);
});

// ---- The slot clock through the shared worker and the Agentic executor ----------------------------------------------------------------------------

function receipt(amount: bigint, out: bigint): AgenticReceipt {
  const hash = `0x${"33".repeat(32)}` as Hex, block = `0x${"44".repeat(32)}` as Hex, topic = (address: Address) => ("0x" + address.slice(2).padStart(64, "0")) as Hex;
  const transfer = keccak256(stringToBytes("Transfer(address,address,uint256)")), word = (value: bigint) => ("0x" + value.toString(16).padStart(64, "0")) as Hex;
  return { from: W, to: TOKEN, input: "0x", observation: { chainId: 56, transaction: { hash, to: TOKEN, input: "0x", blockNumber: 1n, blockHash: block, transactionIndex: 0n },
    receipt: { status: 1n, transactionHash: hash, blockNumber: 1n, blockHash: block, transactionIndex: 0n, logs: [
      { address: USDT_56, topics: [transfer, topic(W), topic(TOKEN)], data: word(amount), logIndex: 0n },
      { address: TOKEN, topics: [transfer, topic(TOKEN), topic(W)], data: word(out), logIndex: 1n }] },
    receiptBlock: { number: 1n, hash: block }, finalizedBlock: { number: 2n, hash: block } } };
}

async function lane(t: TestContext) {
  const settings: TradeSettings = { ...scheduleParams, capitalQuoteWei: (20n * E).toString() };
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: "0x4444444444444444444444444444444444444444", feeTier: null, quote: USDT_56, quoteSymbol: "USDT",
    priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: NOW };
  const row = (): UniverseRow => ({ address: TOKEN, symbol: "STOCK", lane: "bstocks", source: "offline", venues: [{ ...venue, asOf: clock }],
    rwa: { platform: "bstocks", underlyingTicker: "STOCK", tokenPriceUsd: 1, referencePriceUsd: 1, premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING",
      staleness: "fresh", tokenToShareRatio: 1, onchainPriceUsd: 1, venues: [{ ...venue, asOf: clock }] } });
  const dataPlane: TradeWorkerDeps["dataPlane"] = { universe: async lane => lane === "bstocks" ? [row()] : [],
    tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1e9, volume24hUsd: 1000, holders: 100,
      priceChange24hPct: 0, asOf: clock, source: "pancake-v3-slot0", staleness: "fresh", updatedFields: ["priceUsd"] })),
    eligibilityBatch: async addresses => addresses.map(address => ({ address, eligible: true, reason: "ok", source: "allowlist" as const, venue: null })),
    security: async () => ({ riskLevel: "ok", flags: [] }) };
  const routeReader = { quoteV2: async (_path: readonly Address[], amount: bigint) => amount * 102n / 100n, quoteV3Single: async () => { throw new Error("no v3"); }, quoteV3Path: async () => { throw new Error("no v3"); },
    quoteUniV3Single: async () => { throw new Error("no uni"); }, quoteUniV3Path: async () => { throw new Error("no uni"); } };
  const f = await fixture(t, {}, settings, () => ({ dataPlane, routeReader, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set([TOKEN]) } }));
  const landed: { orderId: string; status: string; txHash: Hex }[] = [];
  f.chain.receipt = async hash => landed.some(r => r.txHash === hash) ? (() => { const proof = receipt(5n * E, 5n * E);
    return { ...proof, observation: { ...proof.observation, transaction: { ...proof.observation.transaction, hash }, receipt: { ...proof.observation.receipt, transactionHash: hash } } }; })() : null;
  f.runner.replies.set("market-order list", async () => ({ kind: "ok", sessionPresent: true, rwaTokens: null, data: { total: landed.length, page: 1, pageSize: 100, list: landed } }));
  f.runner.replies.set("market-order quote", { kind: "ok", sessionPresent: true, rwaTokens: null, data: { fromCoinSymbol: "USDT", fromCoinAmount: "5", toCoinSymbol: "STOCK", toCoinAmount: "5.1", slippage: "0" } });
  f.runner.replies.set("market-order swap", async () => {
    const hash = ("0x" + String(landed.length + 1).padStart(64, "0")) as Hex;
    landed.push({ orderId: "listed-" + (landed.length + 1), status: "FINISHED", txHash: hash });
    return { kind: "ok", data: { orderId: "returned-" + landed.length }, sessionPresent: true, rwaTokens: null };
  });
  const worker: TradeWorkerDeps = { ...f.worker, now: f.now };
  const swaps = () => f.runner.calls.filter(args => args[0] === "market-order" && args[1] === "swap").length;
  const lastReason = async () => (await f.positions.listRuns(W, f.agent.id, 1))[0]?.reason.split(";")[0];
  return { f, input: { ...f.lifecycle, worker }, swaps, lastReason, at: async (ms: number) => { clock = ms; f.setTime(ms); await f.instance.heartbeat(); } };
}

test("L1 lane: slot 0 buys through the Agentic swap and commits, the same slot is filled, the next slot buys, and the runs limit finishes with no swap", async t => {
  const { f, input, swaps, lastReason, at } = await lane(t);
  await runAgenticCycle(input);
  assert.equal(swaps(), 1, JSON.stringify(await f.positions.listRuns(W, f.agent.id, 1)));
  assert.deepEqual((await f.intents.listSchedule(W, f.agent.id)).map(i => [i.scheduleSlot, i.state]), [[0, "projected"]]);
  assert.equal((await f.positions.listOpen(W, f.agent.id)).length, 1);
  assert.equal((await f.store.orders(W)).filter(o => o.outcome === "committed").length, 1);
  await at(NOW + 60_000); await runAgenticCycle(input);
  assert.equal(swaps(), 1); assert.equal(await lastReason(), "schedule-slot-filled");
  await at(NOW + HOUR); await runAgenticCycle(input);
  assert.equal(swaps(), 2, JSON.stringify((await f.positions.listRuns(W, f.agent.id, 2)).map(r => [r.reason, r.createdAt, r.events])));
  assert.deepEqual((await f.intents.listSchedule(W, f.agent.id)).map(i => i.scheduleSlot).sort(), [0, 1]);
  await at(NOW + 2 * HOUR); await runAgenticCycle(input);
  assert.equal(swaps(), 2); assert.equal(await lastReason(), "schedule-finished:runs");
  assert.equal(f.runner.calls.some(args => args[0] === "x402-payment"), false);
});

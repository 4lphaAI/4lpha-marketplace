/** AGENTIC-RFQ-STOCKS 4.12 (E12, R3.6, R4.9, RI9): the public mark of an RFQ-only position is the worker's last Binance sell quote; nothing is called. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Address } from "viem";
import { createAgenticPublicView } from "../src/agentic/publicView.js";
import type { TradePositionObservation } from "../src/trade/detail.js";
import { E, NOW, TOKEN, W, fixture, type Fixture } from "./support/agenticSchedule.js";

const POOLED = "0x3333333333333333333333333333333333333333" as Address;
const KEY = (n: string) => `56|${"0x" + n.repeat(64)}|${W.toLowerCase()}|0|${"0x" + n.repeat(64)}`;

async function world(t: TestContext) {
  t.mock.method(Date, "now", () => NOW);
  const base = (await fixture(t)).row.hireFacts!;
  const f = await fixture(t, { hireFacts: { ...base, rfq: { v: 1, notionalWei: (20n * E).toString(), pooledCount: 1, rfqOnly: [TOKEN], costs: [] } } });
  for (const [id, token, key] of [["rfq", TOKEN, "a"], ["pooled", POOLED, "b"]] as const) {
    await f.positions.open({ positionId: id, agentId: f.agent.id, ownerAddress: W, token, route: { hops: [], fees: [100] }, venue: "pancake_v3", entryWei: 100n * E, tokenAmount: E, fillStatus: "verified",
      openedAt: NOW - 3_600_000, entryTxHash: `0x${key.repeat(64)}`, crashBasisVerified: true, sessionGeneration: 1, settlementAsset: "USDT", requestedEntryAtomic: 100n * E, verifiedEntryAtomic: 100n * E, receiptOwnershipKey: KEY(key) });
  }
  const observed: Address[][] = [];
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch,
    symbols: () => new Map([[TOKEN.toLowerCase(), "AMDB"]]),
    observer: { observe: async (_agent, positions) => { observed.push(positions.map((p) => p.token)); return positions.map((p): TradePositionObservation => ({ positionId: p.positionId, symbol: "POOL", decimals: 18,
      recordedPositionAmount: "1", liveWalletBalance: "1", currentQuoteWei: (101n * E).toString(), pnlBps: "100", quoteStatus: "quoted", reason: null, observedAt: NOW })); } } });
  const mark = (atMs: number | null, balance: bigint | null = E, quote = 98n * E) => f.positions.recordQuote({ ownerAddress: W, agentId: f.agent.id, positionId: "rfq", quoteOutWei: quote,
    ...(balance === null ? {} : { balance }), routeKey: "r", pnlBps: null, atMs: atMs ?? 1, sessionGeneration: 1 });
  return { f, view, observed, mark };
}
const rows = async (w: Awaited<ReturnType<typeof world>>) => (await w.view(W)).agent!;

test("RFQ positions are not observed (RI9); the others still are; the rows keep their key sets", async (t) => {
  const w = await world(t);
  await w.mark(NOW - 1_000);
  const agent = await rows(w);
  assert.deepEqual(w.observed, [[POOLED]], "the observer is asked only about the pooled position");
  const rfq = agent.positions.find((p) => p.token === TOKEN)!, pooled = agent.positions.find((p) => p.token === POOLED)!;
  assert.deepEqual(Object.keys(rfq).sort(), Object.keys(pooled).sort());
  assert.deepEqual(Object.keys(rfq.live!).sort(), ["currentQuoteWei", "liveWalletBalance", "quoteStatus"]);
  assert.deepEqual(rfq.live, { liveWalletBalance: E.toString(), currentQuoteWei: (98n * E).toString(), quoteStatus: "quoted" });
  assert.equal(rfq.pnlBps, "-200");
  assert.equal(rfq.symbol, "AMDB");
  assert.equal(rfq.decimals, 18);
});

test("the mark is quoted at exactly 600 000 ms old and unavailable at 600 001; a balance mismatch or no telemetry is unavailable with no value", async (t) => {
  const w = await world(t);
  const live = async () => (await rows(w)).positions.find((p) => p.token === TOKEN)!.live;
  await w.mark(NOW - 600_000);
  assert.equal((await live())?.quoteStatus, "quoted");
  const stale = await world(t);
  await stale.mark(NOW - 600_001);
  assert.deepEqual((await rows(stale)).positions.find((p) => p.token === TOKEN)!.live, { liveWalletBalance: null, currentQuoteWei: null, quoteStatus: "unavailable" });
  const mismatch = await world(t);
  await mismatch.mark(NOW - 1_000, 2n * E);
  assert.equal((await rows(mismatch)).positions.find((p) => p.token === TOKEN)!.live?.quoteStatus, "unavailable");
  const none = await world(t);
  assert.deepEqual((await rows(none)).positions.find((p) => p.token === TOKEN)!.live, { liveWalletBalance: null, currentQuoteWei: null, quoteStatus: "unavailable" });
  assert.equal((await rows(none)).positions.find((p) => p.token === TOKEN)!.pnlBps, null);
});

test("R3.6 one merged list feeds the summary and the rows: a fresh RFQ mark plus a pooled one is grossComplete; a stale RFQ mark is not", async (t) => {
  const fresh = await world(t);
  await fresh.mark(NOW - 1_000);
  assert.equal((await rows(fresh)).summary.grossComplete, true);
  const stale = await world(t);
  await stale.mark(NOW - 700_000);
  const agent = await rows(stale);
  assert.equal(agent.summary.grossComplete, false);
  assert.equal(agent.positions.find((p) => p.token === TOKEN)!.live?.quoteStatus, "unavailable");
});

test("a hire without the marker passes every position to the observer unchanged", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f: Fixture = await fixture(t);
  await f.positions.open({ positionId: "one", agentId: f.agent.id, ownerAddress: W, token: TOKEN, route: { hops: [], fees: [100] }, entryWei: E, tokenAmount: E, fillStatus: "verified", openedAt: NOW });
  const seen: string[][] = [];
  const view = createAgenticPublicView({ store: f.store, agents: f.agents, settings: f.settings, positions: f.positions, intents: f.intents, cmc: f.cmcStore, killswitch: f.killswitch,
    observer: { observe: async (_a, positions) => { seen.push(positions.map((p) => p.positionId)); return []; } } });
  await view(W);
  assert.deepEqual(seen, [["one"]]);
});

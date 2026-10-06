/** AGENTIC-MEME-STOCKS-SPEC PA1: a paper meme hire has no path to a swap, approve, payment or order; both shared chokepoints are pinned (review R2 item 2). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Address } from "viem";
import { runAgenticCycle } from "../src/agentic/worker.js";
import { executeAgenticTrade } from "../src/agentic/execute.js";
import { projectAgenticSessionFacts } from "../src/agentic/domain.js";
import { runTradeWorkerOnce } from "../src/trade/worker.js";
import { admittedVenueRows } from "../src/trade/rwa.js";
import { E, HASH, W } from "./support/agenticSchedule.js";
import { MEME, memeWorld, paperRow } from "./support/agenticMeme.js";
import { worldHarness } from "./support/agenticRfqWorker.js";
import { strongFeatureDataPlane } from "./support/tradeFeatures.js";
import { RFQ_FIXTURE_AS_OF, loadRfqUniverse } from "./support/agenticRfq.js";

const LIFECYCLE = new Set(["market-order quote", "wallet status", "market-order list"]);

test("a full paper cycle through runAgenticCycle issues only market-order quote (plus lifecycle reads) and writes no journal, intent, position, order or CMC row", async (t) => {
  const world = await memeWorld(t);
  const prepared: string[] = [];
  t.mock.method(world.f.runner, "prepare", async (args: readonly string[]) => { prepared.push(args.join(" ")); throw new Error("no dispatch"); });
  await world.f.store.insertPaper(paperRow(world, { token: "0xacacacacacacacacacacacacacacacacacacacac" as Address, positionId: "held" }));
  await runAgenticCycle({ ...world.f.lifecycle, memeEnabled: true });
  assert.ok((await world.f.store.paperOpen(world.agentId)).some(p => p.token === MEME), "the cycle took a paper entry");
  const commands = world.f.runner.calls.map(args => args.slice(0, 2).join(" "));
  assert.ok(commands.includes("market-order quote"));
  assert.deepEqual(commands.filter(command => !LIFECYCLE.has(command)), []);
  assert.deepEqual(prepared, [], "no prepared command (swap, x402) at all");
  assert.deepEqual(await world.f.store.orders(), []);
  assert.deepEqual(await world.f.intents.listUnsettled(W, world.agentId), []);
  assert.deepEqual(await world.f.positions.list(W, world.agentId), []);
  assert.deepEqual(await world.f.journal.getByDecision(world.agentId, "any"), null);
  assert.deepEqual(await world.f.cmcStore.listAttempts(world.agentId, W), []);
});

test("the executor refuses every request for a paper hire with AGENTIC_MEME_PAPER", async (t) => {
  const world = await memeWorld(t);
  const row = (await world.f.store.byAgent(world.agentId))!;
  for (const side of ["buy", "sell"] as const) {
    const input = { agent: { ...world.f.agent, sessionFacts: projectAgenticSessionFacts(row) }, idempotencyKey: HASH, paramsHash: HASH,
      request: { decisionId: "d-" + side, venue: "pancake" as const, side, token: MEME, amountWei: 10n ** 19n, minOutWei: 1n, quotedOutWei: 2n, settlementAsset: "USDT" as const,
        platformFeeAtomic: 0n, route: { hops: [], fees: [] } }, scanGate: { evaluate: async () => ({ verdict: "allow" as const, reasons: [] }) }, deps: world.f.executorDeps };
    const result = await executeAgenticTrade(input as unknown as Parameters<typeof executeAgenticTrade>[0], world.f.execution);
    assert.deepEqual(result, { kind: "denied", status: 409, code: "AGENTIC_MEME_PAPER" }, side);
  }
  assert.deepEqual(world.f.runner.calls, []);
});

test("source scan: memeLane.ts names no swap, executor, x402 or prepare( token", () => {
  const text = readFileSync(new URL("../src/agentic/memeLane.ts", import.meta.url), "utf8");
  for (const token of ['"swap"', "executor", "x402", "prepare("]) assert.ok(!text.includes(token), token);
});

test("chokepoint (i): cmc.refresh of a paper hire returns without acquiring the wallet fence", async (t) => {
  const world = await memeWorld(t);
  let fences = 0;
  const acquire = world.f.store.acquireFence.bind(world.f.store);
  t.mock.method(world.f.store, "acquireFence", async (...args: Parameters<typeof acquire>) => { fences += 1; return acquire(...args); });
  await world.f.cmc.refresh(world.agentId);
  assert.equal(fences, 0);
});

test("chokepoint (ii): the shared worker with an Agentic agent listed whose projected session pins [] (the paper hire's) submits nothing and writes no intent; the same agent pinned to a stock buys", async (context) => {
  let now = RFQ_FIXTURE_AS_OF + 120_000;
  context.mock.method(Date, "now", () => now);
  const rows = await loadRfqUniverse();
  const pooled = rows.filter((row) => admittedVenueRows(row.venues).length > 0), nvda = rows.find((row) => row.symbol === "NVDAB")!;
  const submitted: number[] = [];
  for (const pinned of [[], pooled.map((row) => row.address)]) {
    now = RFQ_FIXTURE_AS_OF + 120_000;
    const world = await worldHarness({ now: () => now, rows, custody: "binance-agentic", pinned, settings: { maxOpenPositions: 1, entryWei: (20n * E).toString(), minEntryWei: (5n * E).toString(), capitalQuoteWei: (60n * E).toString() },
      dataPlane: strongFeatureDataPlane(nvda.address, nvda.venues![0]!.pool, now) });
    await runTradeWorkerOnce(world.deps);
    submitted.push(world.submitted.length);
    if (pinned.length === 0) assert.deepEqual(await world.intents.listUnsettled(world.owner, world.agent.id), []);
  }
  assert.deepEqual(submitted, [0, 1], "pinned [] alone leaves no candidate; the control buys");
});

test("chokepoint (iii): the shared entry listing omits the paper meme wallet; the projection listing keeps it", async (t) => {
  const world = await memeWorld(t);
  const entries = await world.f.worker.settingsStore.listTradeAgentsForWorker({ limit: 10, cursor: null });
  const projection = await world.f.worker.settingsStore.listTradeAgentsForProjection({ limit: 10, cursor: null });
  assert.deepEqual(entries.rows.map(r => r.agentId), []);
  assert.deepEqual(projection.rows.map(r => r.agentId), [world.agentId]);
});

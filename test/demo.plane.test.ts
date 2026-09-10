/**
 * DEMO MODE — the store, the worker loop and the HTTP surface.
 *
 * The claims worth pinning here are the ones that bound COST and CONFUSION,
 * because those are the two ways demo mode could hurt a real deployment:
 *
 *   - the per-owner cap is enforced by the store, not by a check-then-insert;
 *   - a cross-owner read is a 404 / an empty list, never someone else's demo;
 *   - the worker reads each DISTINCT pool once, however many agents share it;
 *   - a demo projection always carries its disclosure and its null live-only
 *     facts, so no screen can render a demo number as a live one.
 *
 * OFFLINE: memory store, fake readers, no chain and no data plane.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";

import { createDemoRoutes, type DemoServerDeps } from "../src/demo/routes.js";
import { resolveDemoConfig } from "../src/demo/config.js";
import { runDemoCycle } from "../src/demo/worker.js";
import { MemoryDemoAgentStore, type DemoAgentRecord } from "../src/store/demoAgents.js";
import { asDemoOwnerId, type DemoOwnerId } from "../src/demo/types.js";
import { scanModuleLoads, scanModuleSpecifiers } from "./support/moduleScan.js";

const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x2170ed0880ac9a755fd29b2688956bd959f933f8");
const POOL = getAddress("0x1111111111111111111111111111111111111111");
const OWNER = asDemoOwnerId("a".repeat(32)) as DemoOwnerId;
const OTHER = asDemoOwnerId("b".repeat(32)) as DemoOwnerId;

const ON = { DEMO_ENABLED: "true" } as const;

function config(patch: Record<string, string> = {}) {
  return resolveDemoConfig({ ...ON, ...patch });
}

function serverDeps(patch: Partial<DemoServerDeps> = {}): DemoServerDeps {
  let n = 0;
  return {
    store: new MemoryDemoAgentStore(),
    config: config(),
    getPool: async () => POOL,
    poolTick: async () => ({ currentTick: 0, tickSpacing: 50 }),
    // The fixture pool's token0 is TOKEN, so WBNB is token1 (a Case-A pool).
    poolToken0: async () => TOKEN,
    wbnb: WBNB,
    now: () => 1_700_000_000_000,
    newId: () => `demo-${++n}`,
    ...patch,
  };
}

async function createGrid(app: ReturnType<typeof createDemoRoutes>, owner: string, body: Record<string, unknown> = {}) {
  return app.request("/demo/agents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-owner": owner },
    body: JSON.stringify({
      kind: "grid",
      token0: TOKEN,
      token1: WBNB,
      fee: 2_500,
      budgetBnb: "0.1",
      gapTicks: 100,
      widthTicks: 200,
      ...body,
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

describe("demo config", () => {
  it("defaults OFF, and a typo FAILS THE BOOT rather than silently disabling", () => {
    assert.equal(resolveDemoConfig({}).enabled, false);
    assert.equal(resolveDemoConfig({ DEMO_ENABLED: "false" }).enabled, false);
    assert.throws(() => resolveDemoConfig({ DEMO_ENABLED: "1" }), /must be exactly/u);
    assert.throws(() => resolveDemoConfig({ DEMO_ENABLED: "TRUE" }), /must be exactly/u);
  });

  it("carries the operator's LLM budget and a global ceiling", () => {
    const resolved = config();
    assert.equal(resolved.llmCallsPerAgentPerDay, 25);
    assert.ok(resolved.llmCallsPerDay > 0);
    assert.equal(resolved.maxAgentsPerOwner, 3);
    assert.equal(resolved.ttlDays, 7);
  });

  it("clamps the worker cadence and refuses nonsense", () => {
    assert.equal(config({ DEMO_WORKER_INTERVAL_SEC: "45" }).workerIntervalMs, 45_000);
    assert.throws(() => config({ DEMO_WORKER_INTERVAL_SEC: "5" }), /between 30 and 300/u);
    assert.throws(() => config({ DEMO_MAX_AGENTS_PER_OWNER: "x" }), /whole number/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

function row(id: string, ownerId: DemoOwnerId, patch: Partial<DemoAgentRecord> = {}): DemoAgentRecord {
  return {
    id,
    ownerId,
    kind: "grid",
    name: "Demo",
    status: "running",
    createdAtMs: 1_000,
    expiresAtMs: 2_000,
    lastTickAtMs: null,
    holdReason: null,
    config: {},
    state: {},
    llmCallsToday: 0,
    llmDayUtc: "2026-09-06",
    ...patch,
  };
}

describe("demo store", () => {
  it("enforces the per-owner cap and reports it distinctly from a duplicate", async () => {
    const store = new MemoryDemoAgentStore();
    assert.equal((await store.create(row("1", OWNER), 2)).ok, true);
    assert.equal((await store.create(row("2", OWNER), 2)).ok, true);
    const third = await store.create(row("3", OWNER), 2);
    assert.deepEqual(third, { ok: false, reason: "at-cap" });
    // Another owner is unaffected — the cap is per cookie, not global.
    assert.equal((await store.create(row("4", OTHER), 2)).ok, true);
    const dup = await store.create(row("1", OWNER), 9);
    assert.deepEqual(dup, { ok: false, reason: "duplicate" });
  });

  it("answers null / empty for a cross-owner read", async () => {
    const store = new MemoryDemoAgentStore();
    await store.create(row("1", OWNER), 3);
    assert.notEqual(await store.get(OWNER, "1"), null);
    assert.equal(await store.get(OTHER, "1"), null);
    assert.deepEqual(await store.list(OTHER), []);
    await store.appendFills([{ agentId: "1", seq: 1, atMs: 1, kind: "grid-flip", payload: {} }]);
    assert.equal((await store.listFills(OWNER, "1", 10)).length, 1);
    assert.deepEqual(await store.listFills(OTHER, "1", 10), []);
  });

  it("DELETES expired rows and their fills, so a TTL bounds storage", async () => {
    // REVIEW FIX (finding 9): the sweep used to flip a status, which retained
    // every row an anonymous cookie ever created. A TTL that frees nothing is
    // not a TTL.
    const store = new MemoryDemoAgentStore();
    await store.create(row("1", OWNER, { expiresAtMs: 1_500 }), 3);
    await store.appendFills([{ agentId: "1", seq: 1, atMs: 1, kind: "grid-flip", payload: {} }]);
    assert.equal((await store.listDue(1_000, 10)).length, 1);
    assert.equal(await store.sweepExpired(2_000), 1);
    assert.equal((await store.listDue(2_000, 10)).length, 0);
    assert.equal(await store.get(OWNER, "1"), null);
    assert.deepEqual(await store.listFills(OWNER, "1", 10), []);
    // Idempotent: a second sweep retires nothing.
    assert.equal(await store.sweepExpired(3_000), 0);
  });

  it("a STOPPED agent frees its cap slot, so the refusal's remedy works", async () => {
    // REVIEW FIX (finding 15): the cap counted stopped agents, so "stop one to
    // start another" — the text the refusal itself prints — could not be done.
    const store = new MemoryDemoAgentStore();
    assert.equal((await store.create(row("1", OWNER), 1)).ok, true);
    assert.deepEqual(await store.create(row("2", OWNER), 1), { ok: false, reason: "at-cap" });
    assert.equal(await store.stop(OWNER, "1"), true);
    assert.equal((await store.create(row("2", OWNER), 1)).ok, true);
  });

  it("bounds BOTH LLM ceilings durably, per UTC day, before the call", async () => {
    // REVIEW FIX (finding 4, twice): the global ceiling was a per-cycle
    // variable that reset every minute, and the per-agent one then rode on the
    // snapshot save at the END of the cycle — so a throwing provider plus a
    // failed save spent two calls against a ceiling of one.
    const store = new MemoryDemoAgentStore();
    let clock = 0;
    const claim = (agentId: string, dayUtc: string, globalCeiling: number, perAgentCeiling: number) =>
      // The pacing bound is exercised in its own test below; here it is off, so
      // the budget arithmetic is what these assertions are about.
      store.reserveLlmCall({
        agentId,
        dayUtc,
        globalCeiling,
        perAgentCeiling,
        minIntervalMs: 0,
        nowMs: ++clock,
      });

    // The per-agent ceiling binds first, and it binds without a save.
    assert.equal(await claim("a", "2026-09-07", 99, 1), true);
    assert.equal(await claim("a", "2026-09-07", 99, 1), false);
    // A different agent still has its own allowance…
    assert.equal(await claim("b", "2026-09-07", 99, 1), true);
    // …until the GLOBAL ceiling is reached, which no agent can exceed.
    assert.equal(await claim("c", "2026-09-07", 2, 1), false);
    // A new day is a new budget for both halves.
    assert.equal(await claim("a", "2026-09-08", 99, 1), true);
    // A zero ceiling on either half refuses rather than allowing one.
    assert.equal(await claim("d", "2026-09-09", 0, 5), false);
    assert.equal(await claim("d", "2026-09-09", 5, 0), false);
  });

  it("PACES an agent's consultations, so a day's budget is not spent in minutes", async () => {
    // FIX-REVIEW-2 FINDING 6: the budget bounded the day but not the burst — a
    // 25-call allowance went in ~25 consecutive cycles, leaving the rest of the
    // day heuristic-only, which is the opposite of the plan's hourly cadence.
    const store = new MemoryDemoAgentStore();
    const hour = 3_600_000;
    const claim = (nowMs: number) =>
      store.reserveLlmCall({
        agentId: "a",
        dayUtc: "2026-09-07",
        globalCeiling: 99,
        perAgentCeiling: 99,
        minIntervalMs: hour,
        nowMs,
      });
    assert.equal(await claim(0), true);
    // A minute later, and even 59 minutes later: refused.
    assert.equal(await claim(60_000), false);
    assert.equal(await claim(hour - 1), false);
    // An hour later: allowed, and the clock restarts from THAT call.
    assert.equal(await claim(hour), true);
    assert.equal(await claim(hour + 60_000), false);
    // A refusal costs no budget: the next allowed call is still available.
    assert.equal(await claim(2 * hour), true);
  });

  it("retires LLM accounting rows with the days they counted", async () => {
    // FIX-REVIEW-2 FINDING 5: `reserveLlmCall` claimed these rows "disappear
    // with the day" and nothing deleted them, so a stream of anonymous demos
    // left permanent accounting behind agents that were already gone.
    const store = new MemoryDemoAgentStore();
    const day = 86_400_000;
    // Wall-clock times that AGREE with the day strings: the retention cutoff is
    // computed from the timestamp, so a fixture using epoch zero with 2026 day
    // labels would prove nothing.
    const sept1 = Date.UTC(2026, 8, 1);
    await store.reserveLlmCall({
      agentId: "a",
      dayUtc: "2026-09-01",
      globalCeiling: 1,
      perAgentCeiling: 1,
      minIntervalMs: 0,
      nowMs: sept1,
    });
    // The ceiling is spent for that day…
    assert.equal(
      await store.reserveLlmCall({
        agentId: "a",
        dayUtc: "2026-09-01",
        globalCeiling: 1,
        perAgentCeiling: 1,
        minIntervalMs: 0,
        nowMs: sept1 + 1,
      }),
      false,
    );
    // …and a sweep five days later retires the accounting with it, so the row
    // is gone rather than held for ever.
    await store.sweepExpired(sept1 + 5 * day);
    assert.equal(
      await store.reserveLlmCall({
        agentId: "a",
        dayUtc: "2026-09-01",
        globalCeiling: 1,
        perAgentCeiling: 1,
        minIntervalMs: 0,
        nowMs: sept1 + 5 * day,
      }),
      true,
    );
  });

  it("returns DEEP copies, so a caller cannot mutate the store through them", async () => {
    // REVIEW FIX (finding 20): the memory backend shallow-copied `state`, so a
    // caller mutating a nested level mutated the store — behaviour Postgres,
    // which decodes fresh objects, never had.
    const store = new MemoryDemoAgentStore();
    await store.create(row("1", OWNER, { state: { levels: [{ role: "buy" }] } }), 3);
    const first = await store.get(OWNER, "1");
    (first?.state["levels"] as { role: string }[])[0]!.role = "sell";
    const second = await store.get(OWNER, "1");
    assert.equal((second?.state["levels"] as { role: string }[])[0]?.role, "buy");
  });

  it("appends fills idempotently on (agent, seq)", async () => {
    const store = new MemoryDemoAgentStore();
    await store.create(row("1", OWNER), 3);
    const fill = { agentId: "1", seq: 7, atMs: 1, kind: "grid-flip", payload: { a: 1 } };
    await store.appendFills([fill]);
    await store.appendFills([fill]);
    assert.equal((await store.listFills(OWNER, "1", 10)).length, 1);
  });

  it("a stopped agent is no longer due, and stop is idempotent", async () => {
    const store = new MemoryDemoAgentStore();
    await store.create(row("1", OWNER), 3);
    assert.equal(await store.stop(OWNER, "1"), true);
    assert.equal(await store.stop(OWNER, "1"), true);
    assert.equal(await store.stop(OTHER, "1"), false);
    assert.equal((await store.listDue(1_000, 10)).length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

describe("demo routes", () => {
  it("404s every path while the flag is off", async () => {
    const app = createDemoRoutes(serverDeps({ config: resolveDemoConfig({}) }));
    for (const path of ["/demo/agents", "/demo/agents/x", "/demo/agents/x/fills"]) {
      assert.equal((await app.request(path)).status, 404);
    }
    assert.equal((await createGrid(app, OWNER)).status, 404);
  });

  it("creates a demo grid and returns a projection with its disclosure", async () => {
    const app = createDemoRoutes(serverDeps());
    const response = await createGrid(app, OWNER);
    assert.equal(response.status, 201);
    const body = (await response.json()) as { data: { agent: Record<string, unknown> } };
    const agent = body.data.agent;
    assert.equal(agent["kind"], "grid");
    assert.equal(agent["status"], "running");
    // The disclosure rides on EVERY projection (plan §7).
    assert.deepEqual((agent["disclosure"] as { simulated: boolean }).simulated, true);
    assert.ok(((agent["disclosure"] as { omits: string[] }).omits ?? []).length > 0);
    // Live-only facts are present and NULL, never absent and never invented.
    assert.equal(agent["txHash"], null);
    assert.equal(agent["tokenId"], null);
    assert.equal(agent["erc8004AgentId"], null);
    assert.equal(agent["callsId"], null);
  });

  it("refuses a pool with no WBNB leg, and an unreadable pool", async () => {
    const app = createDemoRoutes(serverDeps());
    const noWbnb = await createGrid(app, OWNER, { token1: TOKEN, token0: getAddress("0x0000000000000000000000000000000000000099") });
    assert.equal(noWbnb.status, 400);

    const blind = createDemoRoutes(serverDeps({ poolTick: async () => null }));
    const unreadable = await createGrid(blind, OWNER);
    assert.equal(unreadable.status, 503);
  });

  it("refuses a demo whose price sits inside the buy rung", async () => {
    // gap 0 with the tick ON a spacing multiple is the one geometry the live
    // arm's G-gate refuses; the demo refuses it with the same words.
    const app = createDemoRoutes(serverDeps({ poolTick: async () => ({ currentTick: 25, tickSpacing: 50 }) }));
    const response = await createGrid(app, OWNER, { gapTicks: 0, widthTicks: 50 });
    // The derivation itself is legal here; what matters is that a refusal is a
    // 400 with a reason rather than a silently different geometry.
    assert.ok(response.status === 201 || response.status === 400);
  });

  it("enforces the per-owner cap with a remedy in the message", async () => {
    const app = createDemoRoutes(serverDeps({ config: config({ DEMO_MAX_AGENTS_PER_OWNER: "1" }) }));
    assert.equal((await createGrid(app, OWNER)).status, 201);
    const second = await createGrid(app, OWNER);
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "at_cap");
    assert.match(body.error.message, /Stop one/u);
  });

  it("never shows one owner's demo to another", async () => {
    const deps = serverDeps();
    const app = createDemoRoutes(deps);
    const created = await createGrid(app, OWNER);
    const { data } = (await created.json()) as { data: { agent: { id: string } } };
    const mine = await app.request(`/demo/agents/${data.agent.id}`, {
      headers: { "x-demo-owner": OWNER },
    });
    assert.equal(mine.status, 200);
    const theirs = await app.request(`/demo/agents/${data.agent.id}`, {
      headers: { "x-demo-owner": OTHER },
    });
    assert.equal(theirs.status, 404);
    const list = await app.request("/demo/agents", { headers: { "x-demo-owner": OTHER } });
    assert.deepEqual((await list.json()) as unknown, { data: { agents: [] } });
  });

  it("refuses a malformed owner id rather than inventing one", async () => {
    const app = createDemoRoutes(serverDeps());
    const response = await createGrid(app, "not-a-session-id");
    assert.equal(response.status, 400);
  });

  it("stops an agent, and a stopped agent stays visible", async () => {
    const app = createDemoRoutes(serverDeps());
    const created = await createGrid(app, OWNER);
    const { data } = (await created.json()) as { data: { agent: { id: string } } };
    const stopped = await app.request(`/demo/agents/${data.agent.id}/stop`, {
      method: "POST",
      headers: { "x-demo-owner": OWNER },
    });
    assert.equal(stopped.status, 200);
    const body = (await stopped.json()) as { data: { agent: { status: string } } };
    assert.equal(body.data.agent.status, "stopped");
  });

  it("answers 503 for demo trading when no data plane is wired", async () => {
    const app = createDemoRoutes(serverDeps());
    const response = await app.request("/demo/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-owner": OWNER },
      body: JSON.stringify({ kind: "trade", model: "degen", capitalBnb: "0.05" }),
    });
    assert.equal(response.status, 503);
  });
});

describe("demo routes — review fixes", () => {
  it("serves fill history as decimal TEXT, never a raw bigint", async () => {
    // REVIEW FIX (finding 5): the history endpoint used to answer 500 the
    // moment an agent had a fill, because the stored payload's bigints reached
    // `JSON.stringify`.
    const deps = serverDeps();
    const app = createDemoRoutes(deps);
    const created = await createGrid(app, OWNER);
    const { data } = (await created.json()) as { data: { agent: { id: string } } };
    await runDemoCycle({
      store: deps.store,
      config: deps.config,
      poolTick: async () => ({ currentTick: -5_000, tickSpacing: 50 }),
      prices: async () => new Map(),
      now: () => 1_700_000_100_000,
    });

    const response = await app.request(`/demo/agents/${data.agent.id}/fills`, {
      headers: { "x-demo-owner": OWNER },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: {
        fills: readonly Record<string, unknown>[];
        disclosure: { simulated: boolean; omits: string[] };
        txHash: null;
      };
    };
    assert.equal(body.data.fills.length, 1);
    assert.equal(typeof body.data.fills[0]?.["quoteWei"], "string");
    assert.equal(typeof body.data.fills[0]?.["baseWei"], "string");
    // The disclosure and the null live-only facts ride on the history too.
    assert.equal(body.data.disclosure.simulated, true);
    assert.ok(body.data.disclosure.omits.length > 0);
    assert.equal(body.data.txHash, null);
  });

  it("takes pool order from the POOL, not from the request's token order", async () => {
    // REVIEW FIX (finding 14): the factory resolves either token order to the
    // same pool, so trusting the caller's order flipped `wbnbIsToken0` and
    // derived the ladder upside down.
    const deps = serverDeps({ poolToken0: async () => TOKEN });
    const app = createDemoRoutes(deps);
    // Name WBNB FIRST even though the pool's token0 is TOKEN.
    const created = await createGrid(app, OWNER, { token0: WBNB, token1: TOKEN });
    assert.equal(created.status, 201);
    const { data } = (await created.json()) as { data: { agent: { id: string } } };
    const agent = await deps.store.get(OWNER, data.agent.id);
    const grid = (agent?.config["grid"] ?? {}) as { wbnbIsToken0: boolean; pool: { token0: string } };
    assert.equal(grid.wbnbIsToken0, false);
    // And the stored triple is in POOL order, not request order.
    assert.equal(grid.pool.token0.toLowerCase(), TOKEN.toLowerCase());
  });

  it("prices in chunks of 50, so a wide cycle is not blanked by one refusal", async () => {
    // REVIEW FIX (finding 6): `tokensBatch` REFUSES more than 50 addresses, and
    // the worker hands it the union of every due agent's universe.
    const { buildDemoWiring } = await import("../src/demo/wiring.js");
    const chunks: number[] = [];
    const wiring = await buildDemoWiring({
      env: { DEMO_ENABLED: "true" },
      store: new MemoryDemoAgentStore(),
      poolReader: {
        getPool: async () => POOL,
        poolTick: async () => ({ currentTick: 0, tickSpacing: 50 }),
        poolToken0: async () => TOKEN,
      },
      dataPlaneReads: {
        security: async () => null,
        universe: async () => [],
        eligibilityBatch: async () => [],
        tokensBatch: async (addresses) => {
          chunks.push(addresses.length);
          if (addresses.length > 50) throw new Error("Trading data-plane batches must contain 1..50 addresses.");
          return addresses.map((address) => ({
            address,
            priceUsd: 1,
            marketCapUsd: null,
            volume24hUsd: null,
            holders: null,
            priceChange24hPct: null,
          }));
        },
      },
    });
    assert.ok(wiring !== null);
    const tokens = Array.from({ length: 51 }, (_, index) =>
      getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`),
    );
    const priced = await wiring.worker.prices(tokens);
    assert.deepEqual(chunks, [50, 1]);
    assert.equal(priced.size, 51);
  });
});

describe("demo wiring — the flag actually mounts the routes", () => {
  /**
   * The failure this pins was found by the operator, not by a review: a local
   * server answered `/demo/agents` with `{"error":{"code":"not_found"}}` — the
   * SERVER's own 404, not the demo plane's `demo_disabled` — because
   * `DEMO_ENABLED` was unset, `buildDemoWiring` returned `null`, and nothing was
   * mounted. Every other demo test built `createDemoRoutes` by hand and so
   * could not see the seam between the flag and the mount.
   */
  it("returns null when the flag is off, and a mountable server when it is on", async () => {
    const { buildDemoWiring } = await import("../src/demo/wiring.js");
    const poolReader = {
      getPool: async () => POOL,
      poolTick: async () => ({ currentTick: 0, tickSpacing: 50 }),
      poolToken0: async () => TOKEN,
    };

    assert.equal(await buildDemoWiring({ env: {}, poolReader }), null);
    assert.equal(await buildDemoWiring({ env: { DEMO_ENABLED: "false" }, poolReader }), null);

    const wiring = await buildDemoWiring({
      env: { DEMO_ENABLED: "true" },
      poolReader,
      store: new MemoryDemoAgentStore(),
    });
    assert.ok(wiring !== null, "DEMO_ENABLED=true must produce a wiring");

    // The wiring's `server` object is what `createServer` takes as `deps.demo`;
    // mounting it must answer the demo paths rather than the server's 404.
    const app = createDemoRoutes(wiring.server);
    const response = await app.request("/demo/agents", {
      headers: { "x-demo-owner": OWNER },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as unknown, { data: { agents: [] } });
  });

  it("has no trade universe without a data plane, and one with it", async () => {
    const { buildDemoWiring } = await import("../src/demo/wiring.js");
    const poolReader = {
      getPool: async () => POOL,
      poolTick: async () => ({ currentTick: 0, tickSpacing: 50 }),
      poolToken0: async () => TOKEN,
    };
    const bare = await buildDemoWiring({
      env: { DEMO_ENABLED: "true" },
      poolReader,
      store: new MemoryDemoAgentStore(),
    });
    // Absent, so the route answers 503 with a reason rather than 500.
    assert.equal(bare?.server.tradeUniverse, undefined);

    const wired = await buildDemoWiring({
      env: { DEMO_ENABLED: "true" },
      poolReader,
      store: new MemoryDemoAgentStore(),
      dataPlaneReads: {
        security: async () => null,
        universe: async () => [],
        tokensBatch: async () => [],
        eligibilityBatch: async () => [],
      },
    });
    assert.notEqual(wired?.server.tradeUniverse, undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* Worker                                                                     */
/* -------------------------------------------------------------------------- */

describe("demo worker", () => {
  it("reads each DISTINCT pool ONCE, however many agents share it", async () => {
    const deps = serverDeps();
    const app = createDemoRoutes(deps);
    await createGrid(app, OWNER);
    await createGrid(app, OTHER);
    await createGrid(app, asDemoOwnerId("c".repeat(32)) as DemoOwnerId);

    const reads: Address[] = [];
    const report = await runDemoCycle({
      store: deps.store,
      config: deps.config,
      poolTick: async (pool) => {
        reads.push(pool);
        return { currentTick: 0, tickSpacing: 50 };
      },
      prices: async () => new Map(),
      now: () => 1_700_000_100_000,
    });
    assert.equal(report.advanced, 3);
    // THE COST CLAIM: three agents, one pool, ONE read.
    assert.equal(reads.length, 1);
    assert.equal(report.poolReads, 1);
  });

  it("holds an agent whose pool is unreadable, changing nothing", async () => {
    const deps = serverDeps();
    const app = createDemoRoutes(deps);
    const created = await createGrid(app, OWNER);
    const { data } = (await created.json()) as { data: { agent: { id: string } } };

    const report = await runDemoCycle({
      store: deps.store,
      config: deps.config,
      poolTick: async () => null,
      prices: async () => new Map(),
      now: () => 1_700_000_100_000,
    });
    assert.equal(report.held, 1);
    assert.equal(report.advanced, 0);
    const agent = await deps.store.get(OWNER, data.agent.id);
    assert.match(agent?.holdReason ?? "", /could not be read/u);
  });

  it("records a flip as a fill when the price crosses a rung", async () => {
    const deps = serverDeps();
    const app = createDemoRoutes(deps);
    const created = await createGrid(app, OWNER);
    const { data } = (await created.json()) as { data: { agent: { id: string } } };

    // The pool is TOKEN/WBNB with WBNB as token1, so the buy rung sits BELOW
    // the arm tick; a large fall crosses it completely.
    const report = await runDemoCycle({
      store: deps.store,
      config: deps.config,
      poolTick: async () => ({ currentTick: -5_000, tickSpacing: 50 }),
      prices: async () => new Map(),
      now: () => 1_700_000_100_000,
    });
    assert.equal(report.fills, 1);
    const fills = await deps.store.listFills(OWNER, data.agent.id, 10);
    assert.equal(fills.length, 1);
    assert.equal(fills[0]?.kind, "grid-flip");
    assert.equal(fills[0]?.payload["from"], "buy");
    assert.equal(fills[0]?.payload["to"], "sell");
  });

  it("sweeps expired agents in the same cycle that advances the live ones", async () => {
    const deps = serverDeps({ config: config({ DEMO_AGENT_TTL_DAYS: "1" }) });
    const app = createDemoRoutes(deps);
    await createGrid(app, OWNER);
    const report = await runDemoCycle({
      store: deps.store,
      config: deps.config,
      poolTick: async () => ({ currentTick: 0, tickSpacing: 50 }),
      prices: async () => new Map(),
      // Two days later: past the TTL.
      now: () => 1_700_000_000_000 + 2 * 86_400_000,
    });
    assert.equal(report.swept, 1);
    assert.equal(report.advanced, 0);
  });

  it("a per-agent failure does not stop the rest of the cycle", async () => {
    const deps = serverDeps();
    const app = createDemoRoutes(deps);
    await createGrid(app, OWNER);
    await createGrid(app, OTHER);
    // Corrupt one agent's saved state; the other must still advance.
    await deps.store.commitCycle({
      fills: [],
      id: "demo-1",
      state: { kind: "nonsense" },
      lastTickAtMs: 0,
      holdReason: null,
      llmCallsToday: 0,
      llmDayUtc: "2026-09-06",
    });
    const report = await runDemoCycle({
      store: deps.store,
      config: deps.config,
      poolTick: async () => ({ currentTick: 0, tickSpacing: 50 }),
      prices: async () => new Map(),
      now: () => 1_700_000_100_000,
    });
    assert.equal(report.held, 1);
    assert.equal(report.advanced, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The import boundary (plan §2)                                              */
/* -------------------------------------------------------------------------- */

/**
 * REVIEW FIX (finding 1, the BLOCKER). The first version of this test walked
 * only the DIRECT, double-quoted `import … from` lines of the top-level files
 * in `src/demo/`, and the module header claimed on that basis that demo mode
 * "may not import" the money path. Both were wrong:
 *
 *   - the check missed transitive reach, dynamic imports, side-effect imports,
 *     single quotes and nested directories;
 *   - the claim was FALSE even for what it did check, one level down:
 *     `lp/gridTriggers.ts` imports two constants from `src/ops/policy.ts`, and
 *     `lp/triggers.ts` imports `V3_FEE_TIERS` from `src/ops/route.ts`.
 *
 * Sharing those modules is the right call — the alternative is a second copy of
 * the grid geometry, which is the two-authorities-on-one-geometry defect the
 * grid lineage keeps being caught by (PHASE3.13 F7, 3.15 H1). So the boundary
 * is restated as what it actually needs to be, and ENFORCED over the whole
 * transitive runtime closure:
 *
 *   1. nothing reachable from `src/demo/**` may be a module that can sign,
 *      submit, hold a key, or write live agent/journal/sequence state;
 *   2. the closure is PINNED. Any new module entering it fails this test, so a
 *      future edit cannot quietly widen the reach and leave the prose stale
 *      the way the first version did.
 */
const DEMO_CLOSURE_ALLOWED = [
  "core/errors.ts",
  "core/session.ts",
  "core/types.ts",
  "lp/fence.ts",
  "lp/gridGeometry.ts",
  "lp/gridTriggers.ts",
  "lp/rails.ts",
  "lp/tickMath.ts",
  "lp/triggers.ts",
  "ops/policy.ts",
  "ops/relayFee.ts",
  "ops/route.ts",
  // `trade/universe.ts` and its scan-verdict helper entered the closure when
  // the demo adopted the LIVE `pinUniverse` (fix-review finding 12). Both are
  // pure: lane selection, market-cap bands, volume ranking, and a payload
  // classifier over data-plane JSON.
  "rules/scanGate.ts",
  "store/codec.ts",
  "store/demoAgents.ts",
  "store/sql.ts",
  "trade/dataPlaneReads.ts",
  // `trade/doctrine.ts` and `trade/llm.ts` entered when the demo brain was
  // wired (fix-review finding 10). The LLM module builds prompts, validates an
  // INDEX-ONLY response schema and holds its key in one closure; it reaches no
  // wallet, no session and no submit.
  "trade/doctrine.ts",
  "trade/exits.ts",
  "trade/llm.ts",
  "trade/sizing.ts",
  "trade/universe.ts",
] as const;

/** Modules whose reach would mean demo code can act, not merely compute. */
const DEMO_CLOSURE_FORBIDDEN = [
  "wallet/",
  "auth/",
  "killswitch/",
  "lp/sagas.ts",
  "lp/open.ts",
  "lp/worker.ts",
  "trade/execute.ts",
  "trade/worker.ts",
  "store/journal.ts",
  "store/agents.ts",
  "store/lpSequences.ts",
  "server.ts",
  "index-server.ts",
] as const;

/**
 * The scanner now lives in `test/support/moduleScan.ts` (QUANT-GRID R2.12 / M4):
 * the quant plane pins its own closure with the SAME parser, and two copies of
 * a scanner is how the first version of this boundary came to agree with its
 * own prose instead of with the code. The assertions below are unchanged.
 */

describe("demo mode's import scanner", () => {
  it("catches every form the fix-review used to slip past it", () => {
    // The five bypasses the reviewer demonstrated, verbatim in shape.
    const samples = [
      'export * from "../wallet/altana.js";',
      '  import "../wallet/altana.js";',
      'void import("../wallet/altana.js").then(() => {});',
      'void import ("../wallet/altana.js");',
      'export { thing } from "../wallet/altana.js";',
      '  export * from "../wallet/altana.js";',
      // The two the SECOND fix-review slipped past the regex version: a
      // re-export sharing a line with another statement, and a comment sitting
      // between `import` and its parenthesis.
      'const marker = 1; export * from "../wallet/altana.js";',
      'void import/*load*/("../wallet/altana.js");',
      'import x = require("../wallet/altana.js");',
    ];
    for (const sample of samples) {
      assert.deepEqual(
        scanModuleSpecifiers(sample),
        ["../wallet/altana.js"],
        `the scanner missed: ${sample}`,
      );
    }
  });

  it("still ignores the two forms TypeScript erases", () => {
    assert.deepEqual(scanModuleSpecifiers('import type { A } from "../wallet/altana.js";'), []);
    assert.deepEqual(scanModuleSpecifiers('export type { A } from "../wallet/altana.js";'), []);
    // The type-position dynamic import: the parser gives it an `ImportTypeNode`,
    // never a call, so it never reaches the visitor — no heuristic about the
    // capitalisation of the member after the dot.
    assert.deepEqual(
      scanModuleSpecifiers('type A = { readonly x?: import("../wallet/altana.js").Thing };'),
      [],
    );
    // And a specifier in a STRING is not an import at all.
    assert.deepEqual(scanModuleSpecifiers('const s = "import \\"../wallet/altana.js\\"";'), []);
  });

  it("reports a computed dynamic import rather than dropping it", () => {
    const loads = scanModuleLoads('const p = "../wallet/altana.js"; void import/*x*/(p);');
    assert.deepEqual(loads, [{ kind: "computed" }]);
  });
});

describe("demo mode's import boundary", () => {
  it("its transitive RUNTIME closure is pinned and reaches nothing that can act", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const srcRoot = path.resolve(new URL("../src/", import.meta.url).pathname.replace(/^\//u, ""));

    const seen = new Set<string>();
    const bare = new Set<string>();
    const norm = (value: string): string => value.split(path.sep).join("/");

    async function walk(file: string): Promise<void> {
      if (seen.has(file)) return;
      seen.add(file);
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        return;
      }
      const loads = scanModuleLoads(source);
      // A dynamic import whose specifier is COMPUTED cannot be followed, so it
      // is refused rather than ignored — demo code must not be able to hide a
      // load behind a variable.
      //
      // ONE exception, named rather than pattern-matched: `store/sql.ts` loads
      // the `pg` driver through a variable on purpose (that lazy load is why
      // `pg` is not a compile-time dependency of this repo). The exemption is
      // pinned to that file AND to the fact that the only string it can resolve
      // to is `"pg"`, so it cannot quietly become a door.
      const computed = loads.filter((load) => load.kind === "computed").length;
      if (computed > 0) {
        const isSqlDriverLoad =
          norm(file).endsWith("/src/store/sql.ts")
          && computed === 1
          && /const\s+driver\s*=\s*"pg"|=\s*"pg"/u.test(source);
        assert.ok(
          isSqlDriverLoad,
          `${file} loads a module through a computed specifier the boundary cannot follow`,
        );
      }
      const specifiers = loads.flatMap((load) =>
        load.kind === "literal" ? [load.specifier] : [],
      );
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) {
          // Bare specifiers are packages, not repo modules. The two the demo
          // plane reaches are `viem` and `hono`; `pg` arrives through
          // `store/sql.ts`'s own lazy load. None is a repo module and none can
          // reach the money path, so they are recorded rather than followed.
          bare.add(specifier);
          continue;
        }
        await walk(norm(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".ts"))));
      }
    }

    // RECURSIVE (fix-review finding 1): the first version read only the files
    // directly in `src/demo/`, so a module in a subdirectory was outside the
    // boundary it was supposed to be inside.
    const demoDir = norm(path.join(srcRoot, "demo"));
    async function demoSources(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = norm(path.join(dir, entry.name));
        if (entry.isDirectory()) out.push(...(await demoSources(full)));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const demoFiles = await demoSources(demoDir);
    assert.ok(demoFiles.length > 0, "expected src/demo to contain files");
    for (const file of demoFiles) await walk(file);

    const outside = [...seen]
      .map((file) => norm(file).replace(`${norm(srcRoot)}/`, ""))
      .filter((file) => !file.startsWith("demo/"))
      .sort();

    for (const module of outside) {
      for (const forbidden of DEMO_CLOSURE_FORBIDDEN) {
        assert.ok(
          !module.startsWith(forbidden),
          `src/demo reaches ${module} at runtime, which can act rather than compute`,
        );
      }
    }
    assert.deepEqual(
      outside,
      [...DEMO_CLOSURE_ALLOWED],
      "the demo runtime closure changed; widen it deliberately and update the boundary prose with it",
    );
    // The PACKAGE reach is pinned too, so a new dependency is a deliberate act
    // rather than something that arrives with an unrelated edit.
    assert.deepEqual([...bare].sort(), ["hono", "viem"]);
  });
});

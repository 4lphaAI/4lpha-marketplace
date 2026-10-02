import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import pg from "pg";
import type { Hex } from "viem";
import { createPgSqlClient, type SqlClient, type SqlQueryOptions } from "../src/store/sql.js";
import { createTradeSimulationStore, MemoryTradeSimulationStore, PostgresTradeSimulationStore, TRADE_SIMULATIONS_DDL, type TradeSimulationInsert } from "../src/store/tradeSimulations.js";
import { createTradfiEvidenceWriter } from "../src/trade/simulate.js";
import { WALLET, NV } from "./support/dcaFixtures.js";
const KEY = `0x${"11".repeat(32)}` as Hex;
const ROW: TradeSimulationInsert = { idempotencyKey: KEY, agentId: "a", ownerAddress: WALLET, journalKind: "trade", exposure: "increase", route: "direct",
  outcome: "success", reason: null, blocked: false, bareRevert: false, failReason: null, latencyMs: 1, upstreamMs: 1, outputToken: NV.stock,
  predictionKind: "swap-output", minOutAtomic: 1n, predictedOutAtomic: 10n, createdAtMs: 1 };
const ACTUAL = { idempotencyKey: KEY, txHash: KEY, actualOutAtomic: 9n, atMs: 2 };

it("ST1/R4 memory first-write wins, actual-before-simulation and independent actual keys", async () => {
  const store = new MemoryTradeSimulationStore();
  await store.insertActual(ACTUAL); await store.insertSimulation(ROW); await store.insertSimulation({ ...ROW, predictedOutAtomic: 20n });
  await store.insertActual({ ...ACTUAL, txHash: `0x${"22".repeat(32)}`, actualOutAtomic: 100n });
  assert.equal(store.simulations.get(KEY)?.predictedOutAtomic, 10n); assert.equal(store.actuals.get(KEY)?.actualOutAtomic, 9n);
  await store.insertActual({ ...ACTUAL, idempotencyKey: `0x${"33".repeat(32)}` }); assert.equal(store.actuals.size, 2);
  for (const outcome of ["reverted", "guard-deadline", "failed-other", "not-simulated"] as const)
    await store.insertSimulation({ ...ROW, idempotencyKey: `0x${outcome.length.toString(16).padStart(64, "0")}`, outcome,
      exposure: "reduce", predictedOutAtomic: null, reason: outcome === "not-simulated" ? "auth" : null, failReason: outcome === "not-simulated" ? null : "display only" });
});
it("ST1 every code CHECK is applied before either store writes", async () => {
  const sql: SqlClient = { async query() { return { rows: [] }; }, transaction: async fn => fn(sql), close: async () => {} };
  for (const store of [new MemoryTradeSimulationStore(), new PostgresTradeSimulationStore(sql)]) {
    for (const patch of [
      { idempotencyKey: "0x12" }, { outputToken: "0x12" }, { journalKind: "other" }, { exposure: "other" }, { route: "other" }, { outcome: "other" },
      { reason: "other" }, { reason: "auth" }, { blocked: true }, { bareRevert: true }, { failReason: "x" }, { latencyMs: -1 }, { upstreamMs: 60001 },
      { predictionKind: "net-wallet-delta" }, { minOutAtomic: null }, { minOutAtomic: 0n }, { predictedOutAtomic: 10n ** 78n },
      { outcome: "reverted", predictedOutAtomic: 1n, blocked: true }, { outcome: "reverted", predictedOutAtomic: null, blocked: true, failReason: "x".repeat(161) },
    ]) await assert.rejects(store.insertSimulation({ ...ROW, ...patch } as TradeSimulationInsert));
    for (const route of ["guard", "direct", "none"] as const) for (const exposure of ["increase", "reduce"] as const) {
      const blocked = route !== "guard" && exposure === "increase";
      const row = { ...ROW, route, exposure, outcome: "reverted" as const, predictedOutAtomic: null, blocked, bareRevert: true, failReason: "execution reverted" };
      await store.insertSimulation(row); await assert.rejects(store.insertSimulation({ ...row, blocked: !blocked }));
    }
    await assert.rejects(store.insertActual({ ...ACTUAL, txHash: "0x12" }));
  }
  assert.equal(TRADE_SIMULATIONS_DDL.length, 4);
  assert.ok(!TRADE_SIMULATIONS_DDL.join(" ").includes("lower(fail_reason)"));
});
it("R5 exactly four timed DDLs and one timed INSERT per method, with no readback", async () => {
  const calls: { text: string; options?: SqlQueryOptions }[] = [];
  const sql: SqlClient = { async query(text, _params, options) { calls.push({ text, ...(options === undefined ? {} : { options }) }); return { rows: [] }; }, transaction: async fn => fn(sql), close: async () => {} };
  const store = await PostgresTradeSimulationStore.create(sql);
  await store.insertActual(ACTUAL); await store.insertSimulation(ROW);
  assert.equal(calls.length, 6); for (const call of calls) assert.equal(call.options?.timeoutMs, 2_000);
  assert.ok(calls[4]?.text.startsWith("insert into trade_simulation_actuals")); assert.ok(calls[5]?.text.startsWith("insert into trade_simulations"));
  for (const call of calls.slice(4)) assert.match(call.text, /on conflict \(idempotency_key\) do nothing/u);
});
it("SIMTAB listForAgent: memory is owner-scoped newest first; Postgres is one SELECT, no DDL, missing table is no-table", async () => {
  const memory = new MemoryTradeSimulationStore();
  await memory.insertSimulation(ROW); await memory.insertActual(ACTUAL);
  await memory.insertSimulation({ ...ROW, idempotencyKey: `0x${"22".repeat(32)}`, createdAtMs: 5 });
  await memory.insertSimulation({ ...ROW, idempotencyKey: `0x${"33".repeat(32)}`, agentId: "other" });
  const listed = await memory.listForAgent({ agentId: "a", ownerAddress: WALLET.toUpperCase().replace("0X", "0x"), limit: 200 });
  assert.equal(listed.unavailable, null); assert.deepEqual(listed.rows.map(row => row.createdAt), [5, 1]);
  assert.equal(listed.rows[1]?.predictedOutAtomic, "10"); assert.equal(listed.rows[1]?.actualOutAtomic, "9"); assert.equal(listed.rows[0]?.actualOutAtomic, null);
  assert.equal((await memory.listForAgent({ agentId: "a", ownerAddress: NV.stock, limit: 200 })).rows.length, 0);
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const pgRow = { created_at: new Date(7), journal_kind: "trade", exposure: "reduce", route: "guard", outcome: "success", reason: null, blocked: false, bare_revert: false,
    fail_reason: null, latency_ms: 120, upstream_ms: 100, output_token: NV.stock, token: NV.stock, prediction_kind: "swap-output", min_out_atomic: "1",
    predicted_out_atomic: "10", actual_out_atomic: "10", actual_tx_hash: KEY, journal_state: "COMMITTED", journal_tx_hash: KEY };
  const sql: SqlClient = { async query(text, params) { calls.push({ text, params: params ?? [] }); return { rows: [pgRow] as never[] }; }, transaction: async fn => fn(sql), close: async () => {} };
  const store = new PostgresTradeSimulationStore(sql);
  const read = await store.listForAgent({ agentId: "a", ownerAddress: WALLET, limit: 200 });
  assert.equal(calls.length, 1); assert.ok(calls[0]!.text.trim().startsWith("select")); assert.doesNotMatch(calls[0]!.text, /\b(create|alter|insert|update|delete)\b/iu);
  assert.match(calls[0]!.text, /where s\.agent_id = \$1 and s\.owner_address = \$2 order by s\.created_at desc limit \$3/u);
  assert.deepEqual(calls[0]!.params, ["a", WALLET.toLowerCase(), 200]);
  assert.deepEqual(read.rows[0], { createdAt: 7, journalKind: "trade", exposure: "reduce", route: "guard", outcome: "success", reason: null, blocked: false, bareRevert: false,
    failReason: null, latencyMs: 120, upstreamMs: 100, outputToken: NV.stock, token: NV.stock, predictionKind: "swap-output", minOutAtomic: "1",
    predictedOutAtomic: "10", actualOutAtomic: "10", actualTxHash: KEY, journalState: "COMMITTED", journalTxHash: KEY });
  const missing: SqlClient = { async query() { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); }, transaction: async fn => fn(missing), close: async () => {} };
  assert.deepEqual(await new PostgresTradeSimulationStore(missing).listForAgent({ agentId: "a", ownerAddress: WALLET, limit: 200 }), { rows: [], unavailable: "no-table" });
  const broken: SqlClient = { async query() { throw new Error("down"); }, transaction: async fn => fn(broken), close: async () => {} };
  await assert.rejects(new PostgresTradeSimulationStore(broken).listForAgent({ agentId: "a", ownerAddress: WALLET, limit: 200 }));
});
it("Q1 constructor bounds, idle error is consumed after a successful query, no raw log", async t => {
  const installedPool = new pg.Pool({ connectionString: "postgres://offline@localhost/throwaway?connect_timeout=600", max: 2,
    connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000, allowExitOnIdle: true });
  assert.equal(installedPool.options.connectionTimeoutMillis, 1500); assert.equal(installedPool.options.allowExitOnIdle, true);
  await installedPool.end();
  let pool: EventEmitter | undefined, options: Record<string, unknown> | undefined;
  class FakePool extends EventEmitter {
    constructor(config: Record<string, unknown>) { super(); pool = this; options = config; }
    async query() { return { rows: [] }; }
    async end() {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(pg, "Pool")!;
  Object.defineProperty(pg, "Pool", { configurable: true, value: FakePool });
  t.after(() => Object.defineProperty(pg, "Pool", descriptor));
  const lines: string[] = []; t.mock.method(console, "warn", (line: string) => lines.push(line));
  const old = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = "postgres://offline@localhost/throwaway?connect_timeout=600&query_timeout=600000";
  try {
    const store = await createTradeSimulationStore();
    assert.equal(options?.["connectionTimeoutMillis"], 1500); assert.equal(options?.["allowExitOnIdle"], true);
    assert.equal(options?.["max"], 2); assert.equal(options?.["idleTimeoutMillis"], 10000);
    assert.equal(options?.["query_timeout"], undefined); assert.equal(pool?.listenerCount("error"), 1);
    pool!.emit("error", new Error("raw private upstream details"), { privateClient: "raw" });
    assert.deepEqual(lines, ["[trade-worker] simulation evidence pool error"]);
    await store.insertSimulation(ROW); await store.close();
    const plain = await createPgSqlClient("postgres://offline@localhost/throwaway");
    assert.deepEqual(options, { connectionString: "postgres://offline@localhost/throwaway" }); assert.equal(pool?.listenerCount("error"), 0); await plain.close();
  } finally { if (old === undefined) delete process.env["DATABASE_URL"]; else process.env["DATABASE_URL"] = old; }
});
it("R4 writer admission precedes invocation, capacity has no queue, and shutdown is bounded", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let invoked = 0; const lines: string[] = [];
  const writer = createTradfiEvidenceWriter({ insertSimulation: () => { invoked += 1; return new Promise(() => {}); }, insertActual: async () => {}, close: () => new Promise(() => {}) }, line => lines.push(line));
  for (let i = 0; i < 20; i += 1) assert.equal(writer.insert(ROW), undefined);
  assert.equal(invoked, 8); assert.deepEqual(lines, Array(12).fill("[trade-worker] simulation evidence dropped"));
  const shutdown = writer.shutdown(); writer.insert(ROW); assert.equal(invoked, 8);
  t.mock.timers.tick(3500); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000); await shutdown;
  assert.ok(lines.includes("[trade-worker] simulation evidence abandoned at shutdown: 8")); assert.ok(lines.includes("[trade-worker] simulation evidence store close abandoned"));
  const threeLines: string[] = [];
  const three = createTradfiEvidenceWriter({ insertSimulation: () => new Promise(() => {}), insertActual: async () => {}, close: () => new Promise(() => {}) }, line => threeLines.push(line));
  for (let i = 0; i < 3; i += 1) three.insert(ROW);
  const threeShutdown = three.shutdown(); t.mock.timers.tick(3500);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(1000); await threeShutdown;
  assert.deepEqual(threeLines, ["[trade-worker] simulation evidence abandoned at shutdown: 3", "[trade-worker] simulation evidence store close abandoned"]);
});
it("R4 settled shutdown, rejected or dropped simulation cannot lose its actual", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new MemoryTradeSimulationStore(), lines: string[] = [];
  const writer = createTradfiEvidenceWriter({ insertSimulation: () => new Promise(resolve => setTimeout(resolve, 1000)), insertActual: input => store.insertActual(input), close: async () => {} }, line => lines.push(line));
  for (let i = 0; i < 3; i += 1) writer.insert(ROW);
  const shutdown = writer.shutdown(); writer.recordActual(ACTUAL); assert.equal(store.actuals.size, 0);
  t.mock.timers.tick(1000); await shutdown; assert.deepEqual(lines, ["[trade-worker] simulation evidence dropped"]);
  const failure = createTradfiEvidenceWriter({ insertSimulation: async () => { throw new Error("failed"); }, insertActual: input => store.insertActual(input), close: async () => {} }, () => {});
  failure.insert(ROW); failure.recordActual(ACTUAL); await failure.shutdown(); assert.equal(store.actuals.get(KEY)?.actualOutAtomic, 9n);
  let settle: () => void = () => {};
  const held = new Promise<void>(resolve => { settle = resolve; });
  const full = createTradfiEvidenceWriter({ insertSimulation: () => held, insertActual: input => store.insertActual(input), close: async () => {} }, () => {});
  for (let i = 0; i < 9; i += 1) full.insert(ROW);
  settle(); await Promise.resolve(); await Promise.resolve();
  full.recordActual({ ...ACTUAL, idempotencyKey: `0x${"22".repeat(32)}` }); await full.shutdown(); assert.equal(store.actuals.size, 2);
});
it("R5 failed fourth DDL closes without waiting and catches cleanup rejection", async () => {
  let closed = 0, calls = 0;
  const sql: SqlClient = { async query() { calls += 1; if (calls === 4) throw new Error("DDL failed"); return { rows: [] }; }, transaction: async fn => fn(sql), close: async () => { closed += 1; throw new Error("cleanup"); } };
  await assert.rejects(PostgresTradeSimulationStore.create(sql)); assert.equal(closed, 1); await Promise.resolve();
  assert.equal(calls, 4);
});
it("R5 fourth boot DDL timeout closes its client and leaves no optional store", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = false, calls = 0;
  const sql: SqlClient = { query: (_text, _params, options) => {
    assert.equal(options?.timeoutMs, 2000);
    calls += 1; if (calls < 4) return Promise.resolve({ rows: [] });
    return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("query timeout")), 2000));
  }, transaction: async fn => fn(sql), close: async () => { closed = true; } };
  const pending = PostgresTradeSimulationStore.create(sql);
  const rejected = assert.rejects(pending);
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  assert.equal(calls, 4); t.mock.timers.tick(2000); await rejected; assert.equal(closed, true);
});
it("R5 real-PG fresh CHECK and populated R4 migration preserve history and unrelated constraints", { skip: !process.env["TEST_PG_URL"] }, async () => {
  const client = new pg.Client({ connectionString: process.env["TEST_PG_URL"]!, connectionTimeoutMillis: 1500 });
  await client.connect();
  const schema = `preflight_r5_${process.pid}_${Date.now()}`;
  const sql: SqlClient = { async query<Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions) {
    const result = await client.query({ text, values: params === undefined ? [] : [...params], ...(options?.timeoutMs === undefined ? {} : { query_timeout: options.timeoutMs }) });
    return { rows: result.rows as readonly Row[] };
  }, transaction: async fn => fn(sql), close: async () => {} };
  let key = 0;
  try {
    await client.query(`create schema "${schema}"`); await client.query(`set search_path to "${schema}"`);
    for (const historical of [false, true]) {
      if (historical) {
        await client.query("drop table trade_simulation_actuals, trade_simulations");
        await client.query(TRADE_SIMULATIONS_DDL[0].replace("constraint trade_simulations_blocked_rule check (blocked = (outcome = 'reverted' and exposure = 'increase' and route <> 'guard'))", "check (blocked = (outcome = 'reverted' and exposure = 'increase'))"));
        await client.query(`alter table trade_simulations add constraint "R4 quoted check" check (blocked = (outcome = 'reverted' and exposure = 'increase')),
          add constraint "unrelated check" check (agent_id <> '')`);
        await client.query(`create table unrelated (blocked boolean, outcome text, exposure text,
          check (blocked = (outcome = 'reverted' and exposure = 'increase')))`);
        await client.query(`insert into trade_simulations (idempotency_key, agent_id, owner_address, journal_kind, exposure, route, outcome,
          blocked, bare_revert, output_token, prediction_kind, min_out_atomic, created_at)
          values ($1,'history',$2,'trade','increase','guard','reverted',true,true,$3,'swap-output',1,now())`, [KEY, WALLET, NV.stock]);
      }
      await PostgresTradeSimulationStore.create(sql); await PostgresTradeSimulationStore.create(sql);
      const constraints = await client.query<{ conname: string; convalidated: boolean }>(`select conname, convalidated from pg_constraint
        where conrelid = 'trade_simulations'::regclass and contype = 'c'`);
      assert.equal(constraints.rows.find(row => row.conname === "trade_simulations_blocked_rule")?.convalidated, !historical);
      if (historical) {
        assert.ok(constraints.rows.some(row => row.conname === "unrelated check"));
        assert.ok(!constraints.rows.some(row => row.conname === "R4 quoted check"));
        assert.equal((await client.query("select blocked from trade_simulations where agent_id = 'history'")).rows[0]?.blocked, true);
        assert.equal((await client.query("select count(*)::int as count from pg_constraint where conrelid = 'unrelated'::regclass and contype = 'c'")).rows[0]?.count, 1);
      }
      // Raw SQL deliberately bypasses the shared validator, including on the NOT VALID constraint.
      for (const route of ["guard", "direct", "none"]) for (const exposure of ["increase", "reduce"]) for (const correct of [true, false]) {
        key += 1;
        const expected = route !== "guard" && exposure === "increase";
        const insert = client.query(`insert into trade_simulations (idempotency_key, agent_id, owner_address, journal_kind, exposure, route, outcome,
          blocked, bare_revert, output_token, prediction_kind, min_out_atomic, created_at)
          values ($1,'fresh',$2,'trade',$3,$4,'reverted',$5,true,$6,'swap-output',1,now())`,
          [`0x${key.toString(16).padStart(64, "0")}`, WALLET, exposure, route, correct ? expected : !expected, NV.stock]);
        if (correct) await insert; else await assert.rejects(insert, { code: "23514", constraint: "trade_simulations_blocked_rule" });
      }
    }
  } finally { try { await client.query(`drop schema if exists "${schema}" cascade`); } finally { await client.end(); } }
});
it("R4 real-PG conflicting query timeout is overridden per call", { skip: !process.env["TEST_PG_URL"] }, async () => {
  const url = new URL(process.env["TEST_PG_URL"]!); url.searchParams.set("query_timeout", "600000");
  const sql = await createPgSqlClient(url.toString(), { max: 2, connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000, allowExitOnIdle: true }, () => {});
  try { const start = performance.now(); await assert.rejects(sql.query("select pg_sleep(5)", [], { timeoutMs: 2000 })); assert.ok(performance.now() - start < 3000); }
  finally { await sql.close(); }
});

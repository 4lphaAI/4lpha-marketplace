import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { paramsHash } from "../src/auth/canonical.js";
import type { AgentRecord } from "../src/store/agents.js";
import {
  MemoryTradePositionStore,
  PostgresTradePositionStore,
  type TradePositionStore,
  type TradeRunInput,
} from "../src/store/tradePositions.js";
import {
  MemoryTradeSettingsStore,
  PostgresTradeSettingsStore,
  type TradeSettingsStore,
} from "../src/store/tradeSettings.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";

const OWNER_A = "0x1111111111111111111111111111111111111111" as Address;
const OWNER_B = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;

type Row = Record<string, unknown>;

class TradeFakeSql implements SqlClient {
  readonly settings = new Map<string, Row>();
  readonly positions = new Map<string, Row>();
  readonly runs = new Map<string, Row>();
  readonly agents = new Map<string, string>();
  readonly texts: string[] = [];
  transactions = 0;

  async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<SqlResult<R>> {
    this.texts.push(text);
    const tag = /\/\*\s*([\w.]+)\s*\*\//u.exec(text)?.[1];
    const rows = this.dispatch(tag, params);
    return { rows: structuredClone(rows) as R[] };
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const snapshot = structuredClone([...this.runs.entries()]);
    try {
      return await fn(this);
    } catch (error) {
      this.runs.clear();
      for (const [key, row] of snapshot) this.runs.set(key, row);
      throw error;
    }
  }

  async close(): Promise<void> {}

  dispatch(tag: string | undefined, p: readonly unknown[]): Row[] {
    if (tag === "tradeSettings.initialFence") return [];
    if (tag === "tradeSettings.initialRead") {
      const row = this.settings.get(String(p[0]));
      return row === undefined ? [] : [row];
    }
    if (tag === "tradeSettings.initialInsert") {
      if (this.settings.has(String(p[0]))) return [];
      const row = { agent_id: p[0], owner_address: p[1], params: JSON.parse(String(p[2])),
        digest: p[3], updated_at: p[4], draining_at: null };
      this.settings.set(String(p[0]), row);
      return [row];
    }
    if (tag === "tradeSettings.put") {
      const existing = this.settings.get(String(p[0]));
      if (existing !== undefined && existing["owner_address"] !== p[1]) return [];
      const row = { agent_id: p[0], owner_address: p[1], params: JSON.parse(String(p[2])), digest: p[3], updated_at: p[4], draining_at: existing?.["draining_at"] ?? null };
      this.settings.set(String(p[0]), row);
      return [row];
    }
    if (tag === "tradeSettings.get") {
      const row = this.settings.get(String(p[0]));
      return row !== undefined && row["owner_address"] === p[1] ? [row] : [];
    }
    if (tag === "tradeSettings.fence") return [];
    if (tag === "tradeSettings.drain") {
      const row = this.settings.get(String(p[0]));
      if (row === undefined || row["owner_address"] !== p[1]) return [];
      if (row["draining_at"] === null) {
        row["draining_at"] = p[2];
        row["updated_at"] = p[2];
      }
      return [row];
    }
    if (tag === "tradeSettings.listWorker") {
      const cursor = p[0] === null ? null : String(p[0]);
      return [...this.settings.values()]
        .filter((row) => this.agents.get(String(row["agent_id"])) === "armed")
        .filter((row) => cursor === null || String(row["agent_id"]) > cursor)
        .sort((a, b) => String(a["agent_id"]).localeCompare(String(b["agent_id"])))
        .slice(0, Number(p[1]));
    }
    if (tag === "tradeSettings.listProjection") {
      const cursor = p[0] === null ? null : String(p[0]);
      return [...this.settings.values()]
        .filter((row) => cursor === null || String(row["agent_id"]) > cursor)
        .sort((a, b) => String(a["agent_id"]).localeCompare(String(b["agent_id"])))
        .slice(0, Number(p[1]));
    }
    if (tag === "tradePositions.open") {
      if (this.positions.has(String(p[0]))) return [];
      const row: Row = { id: p[0], agent_id: p[1], owner_address: p[2], token: p[3],
        route: JSON.parse(String(p[4])), entry_wei: p[5], token_amount: p[6], fill_status: p[7], opened_at: p[8], entry_tx_hash: p[9], status: "open",
        exit_requested_at: null, orphaned_at: null, closed_at: null, exit_wei: null, exit_tx_hash: null,
        sold_token_amount: null, exit_fill_status: null, close_reason: null,
        last_sell_refusal: null, last_sell_refusal_at: null, no_price_count: 0 };
      this.positions.set(String(p[0]), row);
      return [row];
    }
    if (tag === "tradePositions.get") return this.position(p) === undefined ? [] : [this.position(p) as Row];
    if (tag === "tradePositions.list" || tag === "tradePositions.listOpen") {
      return [...this.positions.values()]
        .filter((row) => row["owner_address"] === p[0] && row["agent_id"] === p[1])
        .filter((row) => tag === "tradePositions.list" || row["status"] === "open");
    }
    if (tag?.startsWith("tradePositions.") === true) {
      const row = this.position(p);
      if (row === undefined || row["status"] !== "open") return [];
      if (tag === "tradePositions.requestExit") row["exit_requested_at"] ??= p[3];
      if (tag === "tradePositions.orphan") { row["status"] = "orphaned"; row["orphaned_at"] = p[3]; }
      if (tag === "tradePositions.close") { row["status"] = "closed"; row["closed_at"] = p[3]; row["exit_wei"] = p[4]; row["close_reason"] = p[5]; row["exit_tx_hash"] = p[6]; row["sold_token_amount"] = p[7]; row["exit_fill_status"] = p[8]; row["last_sell_refusal"] = null; row["last_sell_refusal_at"] = null; }
      if (tag === "tradePositions.sellRefusal") { row["last_sell_refusal"] = p[3]; row["last_sell_refusal_at"] = p[4]; }
      if (tag === "tradePositions.resolveFill") { row["token_amount"] = p[3]; row["fill_status"] = "verified"; }
      if (tag === "tradePositions.noPrice") row["no_price_count"] = Number(row["no_price_count"]) + 1;
      return [row];
    }
    if (tag === "tradeRuns.insert") {
      this.runs.set(String(p[0]), { id: p[0], agent_id: p[1], owner_address: p[2], dry_run: p[3], reason: p[4], created_at: p[5] });
      return [];
    }
    if (tag === "tradeRuns.prune") {
      const rows = [...this.runs.values()].filter((row) => row["agent_id"] === p[0])
        .sort((a, b) => Number(b["created_at"]) - Number(a["created_at"]) || String(b["id"]).localeCompare(String(a["id"])));
      for (const row of rows.slice(200)) this.runs.delete(String(row["id"]));
      return [];
    }
    if (tag === "tradeRuns.list") {
      return [...this.runs.values()]
        .filter((row) => row["owner_address"] === p[0] && row["agent_id"] === p[1])
        .sort((a, b) => Number(b["created_at"]) - Number(a["created_at"]) || String(b["id"]).localeCompare(String(a["id"])))
        .slice(0, Number(p[2]));
    }
    return [];
  }

  position(p: readonly unknown[]): Row | undefined {
    const row = this.positions.get(String(p[0]));
    return row !== undefined && row["agent_id"] === p[1] && row["owner_address"] === p[2]
      ? row
      : undefined;
  }
}

function agentLookup(statuses: Readonly<Record<string, string>>) {
  return {
    async getAgentById(agentId: string): Promise<AgentRecord | null> {
      const status = statuses[agentId];
      return status === undefined ? null : ({ id: agentId, status } as AgentRecord);
    },
  };
}

async function settingsStores(): Promise<readonly TradeSettingsStore[]> {
  const fake = new TradeFakeSql();
  fake.agents.set("a1", "armed");
  fake.agents.set("a2", "paused");
  return [
    new MemoryTradeSettingsStore(agentLookup({ a1: "armed", a2: "paused" })),
    await PostgresTradeSettingsStore.create(fake),
  ];
}

describe("trade settings stores", () => {
  it("first-wins initial settings and accepts only the exact same owner, digest, and params", async () => {
    for (const store of await settingsStores()) {
      const params = { nested: { value: 1 }, name: "signed" };
      const digest = paramsHash("tradeSettings", params);
      assert.equal((await store.putInitialIfAbsentOrSameDigest({
        agentId: "initial", ownerAddress: OWNER_A, params, digest,
      })).kind, "created");
      assert.equal((await store.putInitialIfAbsentOrSameDigest({
        agentId: "initial", ownerAddress: OWNER_A, params: { name: "signed", nested: { value: 1 } }, digest,
      })).kind, "same");
      assert.equal((await store.putInitialIfAbsentOrSameDigest({
        agentId: "initial", ownerAddress: OWNER_A, params: { ...params, extra: true }, digest,
      })).kind, "conflict");
      assert.equal((await store.putInitialIfAbsentOrSameDigest({
        agentId: "initial", ownerAddress: OWNER_B, params, digest,
      })).kind, "conflict");
      assert.ok(await store.requestDrain(OWNER_A, "initial"));
      assert.equal((await store.putInitialIfAbsentOrSameDigest({
        agentId: "initial", ownerAddress: OWNER_A, params, digest,
      })).kind, "conflict");
    }
  });

  it("round-trips signed params, scopes owners, upserts, and enumerates only armed agents", async () => {
    for (const store of await settingsStores()) {
      for (const agentId of ["a1", "a2"]) {
        const params = { agentId, nested: { value: 1 } };
        await store.put({ agentId, ownerAddress: OWNER_A, params, digest: paramsHash("tradeSettings", params) });
      }
      assert.deepEqual((await store.get(OWNER_A, "a1"))?.params, { agentId: "a1", nested: { value: 1 } });
      assert.equal(await store.get(OWNER_B, "a1"), null);
      await assert.rejects(store.put({ agentId: "a1", ownerAddress: OWNER_B, params: {}, digest: paramsHash("tradeSettings", {}) }));
      const page = await store.listTradeAgentsForWorker({ limit: 32, cursor: null });
      assert.deepEqual(page.rows.map((row) => row.agentId), ["a1"]);
      assert.equal(page.hasMore, false);
      const projection = await store.listTradeAgentsForProjection({ limit: 32, cursor: null });
      assert.deepEqual(projection.rows.map((row) => row.agentId), ["a1", "a2"]);
    }
  });

  it("uses one no-version upsert and an armed agents join ordered by agent id", async () => {
    const sql = new TradeFakeSql();
    const store = await PostgresTradeSettingsStore.create(sql);
    await store.put({ agentId: "a", ownerAddress: OWNER_A, params: {}, digest: paramsHash("tradeSettings", {}) });
    await store.listTradeAgentsForWorker({ limit: 32, cursor: null });
    await store.listTradeAgentsForProjection({ limit: 32, cursor: null });
    const upsert = sql.texts.find((text) => text.includes("/* tradeSettings.put */")) ?? "";
    assert.match(upsert, /on conflict \(agent_id\) do update/u);
    assert.doesNotMatch(upsert, /version/u);
    const list = sql.texts.find((text) => text.includes("/* tradeSettings.listWorker */")) ?? "";
    assert.match(list, /join agents a on a\.id = ts\.agent_id/u);
    assert.match(list, /a\.status = 'armed'/u);
    assert.match(list, /order by ts\.agent_id asc/u);
    const projection = sql.texts.find((text) => text.includes("/* tradeSettings.listProjection */")) ?? "";
    assert.doesNotMatch(projection, /a\.status = 'armed'/u);
    assert.match(projection, /order by ts\.agent_id asc/u);
  });
});

async function positionStores(): Promise<readonly TradePositionStore[]> {
  return [new MemoryTradePositionStore(() => 1_000), await PostgresTradePositionStore.create(new TradeFakeSql(), () => 1_000)];
}

describe("trade position and run stores", () => {
  it("round-trips every position lifecycle field with owner isolation", async () => {
    for (const store of await positionStores()) {
      const opened = await store.open({ positionId: "p1", agentId: "a1", ownerAddress: OWNER_A, token: TOKEN,
        route: { hops: [], fees: [] }, entryWei: 5n, tokenAmount: 9n, fillStatus: "verified", openedAt: 500 });
      assert.equal(opened.status, "open");
      assert.equal(opened.exitRequestedAt, null);
      assert.equal(await store.get(OWNER_B, "a1", "p1"), null);
      assert.equal((await store.incrementNoPrice(OWNER_A, "a1", "p1"))?.noPriceCount, 1);
      assert.equal((await store.recordSellRefusal({ ownerAddress: OWNER_A, agentId: "a1", positionId: "p1", refusal: "cap" }))?.lastSellRefusal, "cap");
      assert.equal((await store.requestExit(OWNER_A, "a1", "p1"))?.exitRequestedAt, 1_000);
      const closed = await store.closePosition({ ownerAddress: OWNER_A, agentId: "a1", positionId: "p1", exitWei: 7n });
      assert.equal(closed?.status, "closed");
      assert.equal(closed?.exitWei, 7n);
      assert.equal(closed?.closedAt, 1_000);
    }
  });

  it("marks a revoked agent's open position orphaned", async () => {
    for (const store of await positionStores()) {
      await store.open({ positionId: "p2", agentId: "a1", ownerAddress: OWNER_A, token: TOKEN,
        route: { hops: [], fees: [] }, entryWei: 5n, tokenAmount: 9n, fillStatus: "verified", openedAt: 500 });
      const row = await store.markOrphaned(OWNER_A, "a1", "p2");
      assert.equal(row?.status, "orphaned");
      assert.equal(row?.orphanedAt, 1_000);
    }
  });

  it("never stores entryWei zero and resolves an unverified fill additively", async () => {
    for (const store of await positionStores()) {
      await assert.rejects(store.open({ positionId: "zero", agentId: "a1", ownerAddress: OWNER_A, token: TOKEN,
        route: { hops: [], fees: [] }, entryWei: 0n, tokenAmount: null, fillStatus: "unverified", openedAt: 500 }));
      const opened = await store.open({ positionId: "pending", agentId: "a1", ownerAddress: OWNER_A, token: TOKEN,
        route: { hops: [], fees: [] }, entryWei: 5n, tokenAmount: null, fillStatus: "unverified", openedAt: 500 });
      assert.equal(opened.tokenAmount, null);
      assert.equal((await store.resolveFill({ ownerAddress: OWNER_A, agentId: "a1", positionId: "pending", tokenAmount: 9n }))?.fillStatus, "verified");
    }
  });

  it("bounds trade runs to 200 per agent and Postgres prunes inside the insertion transaction", async () => {
    type CarriesSessionKey = TradeRunInput extends { readonly sessionKey: unknown } ? true : false;
    type CarriesOpenRouterKey = TradeRunInput extends { readonly openRouterKey: unknown } ? true : false;
    const noSessionKey: CarriesSessionKey = false;
    const noOpenRouterKey: CarriesOpenRouterKey = false;
    assert.equal(noSessionKey || noOpenRouterKey, false);

    const sql = new TradeFakeSql();
    const stores: readonly TradePositionStore[] = [
      new MemoryTradePositionStore(() => 1_000),
      await PostgresTradePositionStore.create(sql, () => 1_000),
    ];
    for (const store of stores) {
      for (let index = 0; index < 201; index += 1) {
        await store.insertRun({ agentId: "a1", ownerAddress: OWNER_A, dryRun: index === 200, reason: `run-${index}` });
      }
      assert.equal((await store.listRuns(OWNER_A, "a1", 200)).length, 200);
      assert.equal((await store.listRuns(OWNER_B, "a1", 200)).length, 0);
    }
    assert.equal(sql.transactions, 201);
    const prune = sql.texts.find((text) => text.includes("/* tradeRuns.prune */")) ?? "";
    assert.match(prune, /order by created_at desc, id desc limit 200/u);
  });
});

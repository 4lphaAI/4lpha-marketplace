import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { MemoryTradeIntentStore, PostgresTradeIntentStore, type CreateTradeIntentInput } from "../src/store/tradeIntents.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const HASH = `0x${"44".repeat(32)}` as Hex;
const TX = `0x${"55".repeat(32)}` as Hex;

describe("durable trade intents", () => {
  it("ignores route object key order but preserves every intent binding", async () => {
    const store = new MemoryTradeIntentStore(() => 1_000);
    const input: CreateTradeIntentInput = { decisionId: "ordered-route", idempotencyKey: HASH,
      agentId: "a1", ownerAddress: OWNER, side: "buy", token: TOKEN,
      route: { hops: [OWNER, OTHER], fees: [100, 500, 2500] }, venue: "uniswap_v3", amountWei: 5n,
      entryWei: 6n, positionId: "p1", closeReason: null };
    const first = await store.create(input);
    assert.equal(first.venue, "uniswap_v3");
    assert.deepEqual(await store.create({ ...input,
      route: { fees: [100, 500, 2500], hops: [OWNER, OTHER] } }), first);
    const conflicts: readonly Partial<CreateTradeIntentInput>[] = [
      { idempotencyKey: TX }, { agentId: "a2" }, { ownerAddress: OTHER },
      { side: "sell" }, { token: OTHER }, { amountWei: 6n }, { entryWei: 5n },
      { positionId: "p2" }, { closeReason: "llm" },
      { venue: "pancake_v3" }, { scheduleSlot: 1 },
      { route: { hops: [OTHER, OWNER], fees: [100, 500, 2500] } },
      { route: { hops: [OWNER, OTHER], fees: [500, 100, 2500] } },
      { route: { hops: [OWNER], fees: [100, 500] } },
    ];
    for (const conflict of conflicts) {
      await assert.rejects(store.create({ ...input, ...conflict }), /already bound/u);
    }
    await assert.rejects(store.create({ ...input, decisionId: "unknown-venue", venue: "else" as never }), /venue/u);
    assert.deepEqual(await store.get(OWNER, "a1", input.decisionId), first);
  });

  it("binds one immutable decision and scopes the unsettled projection by owner", async () => {
    const store = new MemoryTradeIntentStore(() => 1_000);
    const input = { decisionId: "decision-1", idempotencyKey: HASH, agentId: "a1", ownerAddress: OWNER,
      side: "buy" as const, token: TOKEN, route: { hops: [], fees: [] }, amountWei: 5n,
      entryWei: 5n, positionId: "position-1", closeReason: null };
    const first = await store.create(input);
    assert.equal(first.state, "pending");
    assert.equal((await store.create(input)).decisionId, first.decisionId);
    await assert.rejects(store.create({ ...input, amountWei: 6n }), /already bound/u);
    assert.equal((await store.listUnsettled(OTHER, "a1")).length, 0);
    assert.equal((await store.listUnsettled(OWNER, "a1")).length, 1);
    assert.equal((await store.markSubmitted(OWNER, "a1", input.decisionId, TX))?.txHash, TX);
    assert.equal((await store.markProjected(OWNER, "a1", input.decisionId))?.state, "projected");
    assert.equal((await store.listUnsettled(OWNER, "a1")).length, 0);
  });

  it("makes a rollback terminal and bounds its diagnostic note", async () => {
    const store = new MemoryTradeIntentStore(() => 2_000);
    await store.create({ decisionId: "decision-2", idempotencyKey: HASH, agentId: "a1", ownerAddress: OWNER,
      side: "sell", token: TOKEN, route: { hops: [], fees: [] }, amountWei: 9n,
      entryWei: 5n, positionId: "position-1", closeReason: "owner-request" });
    const rolled = await store.markRolledBack(OWNER, "a1", "decision-2", "x".repeat(400));
    assert.equal(rolled?.state, "rolled-back");
    assert.equal(rolled?.note?.length, 300);
    assert.equal((await store.markProjected(OWNER, "a1", "decision-2"))?.state, "rolled-back");
  });

  it("orders schedule slots, excludes rolled-back rows, and rejects duplicates", async () => {
    const store = new MemoryTradeIntentStore(() => 3_000);
    const base = { agentId: "schedule", ownerAddress: OWNER, side: "buy" as const, token: TOKEN, route: { hops: [], fees: [] }, amountWei: 5n, entryWei: 6n, closeReason: null };
    await store.create({ ...base, decisionId: "slot-2", idempotencyKey: HASH, positionId: "p2", scheduleSlot: 2 });
    await store.create({ ...base, decisionId: "slot-0", idempotencyKey: TX, positionId: "p0", scheduleSlot: 0 });
    await assert.rejects(store.create({ ...base, decisionId: "slot-2b", idempotencyKey: HASH, positionId: "p2b", scheduleSlot: 2 }), /schedule slot is already taken/u);
    await store.markRolledBack(OWNER, "schedule", "slot-2", "retry");
    assert.deepEqual((await store.listSchedule(OWNER, "schedule")).map((row) => row.scheduleSlot), [0]);
    await store.create({ ...base, decisionId: "slot-2c", idempotencyKey: HASH, positionId: "p2c", scheduleSlot: 2 });
    assert.deepEqual((await store.listSchedule(OWNER, "schedule")).map((row) => row.scheduleSlot), [0, 2]);
  });
});

type Row = Record<string, unknown>;

/**
 * A minimal, hand-written `trade_intents` simulator (style: `test/tradeStores.test.ts`'s
 * `TradeFakeSql`) — dispatches on the leading tag comment and never parses SQL
 * (the same A6 caveat `test/support/fakeSql.ts` documents applies here).
 */
class IntentFakeSql implements SqlClient {
  readonly rows = new Map<string, Row>();
  readonly texts: string[] = [];

  async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<SqlResult<R>> {
    this.texts.push(text);
    const tag = /\/\*\s*([\w.]+)\s*\*\//u.exec(text)?.[1];
    return { rows: structuredClone(this.#dispatch(tag, params)) as R[] };
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }

  #dispatch(tag: string | undefined, p: readonly unknown[]): Row[] {
    if (tag === "tradeIntents.create") {
      const decisionId = String(p[0]);
      if (this.rows.has(decisionId)) return [];
      const row: Row = {
        decision_id: p[0], idempotency_key: p[1], agent_id: p[2], owner_address: p[3], side: p[4], token: p[5],
        route: JSON.parse(String(p[6])), amount_wei: p[7], entry_wei: p[8], position_id: p[9], close_reason: p[10],
        state: "pending", tx_hash: null, note: p[11], created_at: p[12], updated_at: p[12],
        venue: p[13], settlement_asset: p[14], platform_fee_atomic: p[15], min_out_atomic: p[16],
        quoted_out_atomic: p[17], schedule_slot: p[18],
      };
      this.rows.set(decisionId, row);
      return [row];
    }
    if (tag === "tradeIntents.getByDecision") {
      const row = this.rows.get(String(p[0]));
      return row === undefined ? [] : [row];
    }
    if (tag === "tradeIntents.get") {
      const row = this.rows.get(String(p[0]));
      return row !== undefined && row["agent_id"] === p[1] && row["owner_address"] === p[2] ? [row] : [];
    }
    if (tag === "tradeIntents.listUnsettled") {
      return [...this.rows.values()]
        .filter((row) => row["owner_address"] === p[0] && row["agent_id"] === p[1] && row["state"] === "pending")
        .sort((a, b) => Number(a["created_at"]) - Number(b["created_at"]) || String(a["decision_id"]).localeCompare(String(b["decision_id"])));
    }
    if (tag === "tradeIntents.listSchedule") {
      return [...this.rows.values()]
        .filter((row) => row["owner_address"] === p[0] && row["agent_id"] === p[1]
          && row["schedule_slot"] !== null && row["schedule_slot"] !== undefined && row["state"] !== "rolled-back")
        .sort((a, b) => Number(a["schedule_slot"]) - Number(b["schedule_slot"]) || Number(a["created_at"]) - Number(b["created_at"]));
    }
    if (tag === "tradeIntents.listProjectedV2") {
      return [...this.rows.values()]
        .filter((row) => row["owner_address"] === p[0] && row["agent_id"] === p[1] && row["state"] === "projected" && row["settlement_asset"] === "USDT")
        .sort((a, b) => Number(a["created_at"]) - Number(b["created_at"]) || String(a["decision_id"]).localeCompare(String(b["decision_id"])));
    }
    if (tag === "tradeIntents.submitted" || tag === "tradeIntents.projected" || tag === "tradeIntents.rolledBack") {
      const row = this.rows.get(String(p[0]));
      if (row === undefined || row["agent_id"] !== p[1] || row["owner_address"] !== p[2] || row["state"] !== "pending") return [];
      if (tag === "tradeIntents.submitted") { if (p[3] !== null) row["tx_hash"] = p[3]; row["updated_at"] = p[4]; }
      if (tag === "tradeIntents.projected") { row["state"] = "projected"; row["updated_at"] = p[3]; }
      if (tag === "tradeIntents.rolledBack") { row["state"] = "rolled-back"; row["note"] = p[3]; row["updated_at"] = p[4]; }
      return [row];
    }
    return [];
  }
}

describe("durable trade intents (postgres)", () => {
  it("adds the schedule_slot column and its rolled-back-excluding partial unique index", async () => {
    const sql = new IntentFakeSql();
    await PostgresTradeIntentStore.create(sql);
    assert.ok(sql.texts.some((text) => text === "alter table trade_intents add column if not exists schedule_slot integer"));
    const index = sql.texts.find((text) => text.includes("trade_intents_schedule_slot_idx")) ?? "";
    assert.match(index, /create unique index if not exists trade_intents_schedule_slot_idx on trade_intents \(agent_id, schedule_slot\)/u);
    assert.match(index, /where schedule_slot is not null and state <> 'rolled-back'/u);
  });

  it("places scheduleSlot at placeholder 19 before portfolioSlot, ordered like the memory store", async () => {
    const sql = new IntentFakeSql();
    const store = await PostgresTradeIntentStore.create(sql);
    const base = { agentId: "schedule", ownerAddress: OWNER, side: "buy" as const, token: TOKEN,
      route: { hops: [], fees: [] }, amountWei: 5n, entryWei: 6n, closeReason: null } as const;
    await store.create({ ...base, decisionId: "slot-2", idempotencyKey: HASH, positionId: "p2", scheduleSlot: 2 });
    await store.create({ ...base, decisionId: "slot-0", idempotencyKey: TX, positionId: "p0", scheduleSlot: 0 });
    const insert = sql.texts.find((text) => text.includes("/* tradeIntents.create */")) ?? "";
    assert.match(insert, /\$19,\$20,null,null,null\)/u, "scheduleSlot remains the 19th bound parameter");
    assert.deepEqual((await store.listSchedule(OWNER, "schedule")).map((row) => row.scheduleSlot), [0, 2]);
    await store.markRolledBack(OWNER, "schedule", "slot-2", "retry");
    assert.deepEqual((await store.listSchedule(OWNER, "schedule")).map((row) => row.scheduleSlot), [0]);
    const list = sql.texts.find((text) => text.includes("/* tradeIntents.listSchedule */")) ?? "";
    assert.match(list, /schedule_slot is not null and state <> 'rolled-back'/u);
    assert.match(list, /order by schedule_slot asc, created_at asc/u);
  });

  it("binds decisionId to one intent identity: a slot change on replay is a conflict, not a fetch", async () => {
    const store = await PostgresTradeIntentStore.create(new IntentFakeSql());
    const input = { decisionId: "d1", idempotencyKey: HASH, agentId: "schedule", ownerAddress: OWNER, side: "buy" as const,
      token: TOKEN, route: { hops: [], fees: [] }, amountWei: 5n, entryWei: 6n, positionId: "p1", closeReason: null, scheduleSlot: 0 };
    const first = await store.create(input);
    assert.equal(first.scheduleSlot, 0);
    assert.deepEqual(await store.create(input), first);
    await assert.rejects(store.create({ ...input, scheduleSlot: 1 }), /already bound/u);
  });
});

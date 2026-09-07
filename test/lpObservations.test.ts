/**
 * The LP trigger observation store (PHASE3.2 Rev2 items 13–17).
 *
 *   - round-trip on BOTH backends, `blockNumber` bigint preserved EXACTLY;
 *   - the optional fields survive as ABSENT, not as `undefined`-shaped nulls —
 *     `previousObservation?.protectBreach === protectBreach` distinguishes
 *     them, so "absent" is a value the evaluator reads;
 *   - cross-tenant read ⇒ null, cross-tenant write ⇒ refused, on both;
 *   - a structurally invalid stored row ⇒ null (derived state: "safe to
 *     truncate" must hold for ONE corrupt row too);
 *   - the SQL text is pinned through a recording client (audit A9's discipline),
 *     because the fake dispatches on the `/* tag *\/` comment alone and would
 *     not notice an owner clause drifting out of a WHERE.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { ownerAccount, otherOwnerAccount } from "./support/serverHarness.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import {
  MemoryLpObservationStore,
  PostgresLpObservationStore,
  parseLpTriggerObservation,
  type LpObservationStore,
} from "../src/store/lpObservations.js";
import type { LpTriggerObservation } from "../src/lp/triggers.js";

const AGENT = "agent-1";
const POSITION = "position-1";
const POOL = "0x1111111111111111111111111111111111111111" as const;
const OWNER = ownerAccount.address as Address;
const OTHER = otherOwnerAccount.address as Address;

/** A block number well past 2^53 — the whole reason the column is jsonb. */
const HUGE_BLOCK = 9_007_199_254_740_993n;

function minimalObservation(): LpTriggerObservation {
  return {
    blockNumber: HUGE_BLOCK,
    evaluatedAtMs: 1_700_000_000_000,
    poolAddress: POOL,
    protectConsecutive: 0,
    rotationBreach: false,
    rotationConsecutive: 0,
    tokenId: "7148383",
  };
}

function fullObservation(): LpTriggerObservation {
  return {
    ...minimalObservation(),
    protectBreach: "stop-loss",
    protectConsecutive: 1,
    rotationBreach: true,
    rotationBreachStartedAtMs: 1_699_999_000_000,
    rotationConsecutive: 2,
  };
}

async function bothBackends(): Promise<
  { name: string; store: LpObservationStore }[]
> {
  return [
    { name: "memory", store: new MemoryLpObservationStore() },
    {
      name: "postgres",
      store: await PostgresLpObservationStore.create(new FakeSqlClient()),
    },
  ];
}

describe("lp observation store: both backends answer identically (F3)", () => {
  it("round-trips a full observation, bigint blockNumber exact", async () => {
    for (const { name, store } of await bothBackends()) {
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT,
        positionId: POSITION,
        observation: fullObservation(),
      });
      const read = await store.get(OWNER, AGENT, POSITION);
      assert.deepEqual(read, fullObservation(), name);
      assert.equal(read?.blockNumber, HUGE_BLOCK, `${name}: bigint drifted`);
      assert.equal(typeof read?.blockNumber, "bigint", name);
      await store.close();
    }
  });

  it("an ABSENT optional field survives the round trip as ABSENT", async () => {
    for (const { name, store } of await bothBackends()) {
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT,
        positionId: POSITION,
        observation: minimalObservation(),
      });
      const read = await store.get(OWNER, AGENT, POSITION);
      assert.ok(read !== null, name);
      // Not `undefined`-valued keys: ABSENT. The evaluator compares
      // `previous?.protectBreach === protectBreach`, so a key that exists with
      // an undefined value and a key that does not exist must not diverge —
      // and `deepEqual` would pass either way, hence `hasOwn`.
      assert.equal(Object.hasOwn(read, "protectBreach"), false, name);
      assert.equal(Object.hasOwn(read, "rotationBreachStartedAtMs"), false, name);
      await store.close();
    }
  });

  it("PHASE3.23 R3.6: gridRangeRelation round-trips through the shared JSONB parser", async () => {
    for (const { name, store } of await bothBackends()) {
      const observation = { ...minimalObservation(), gridRangeRelation: "inside" as const };
      await store.put({ ownerAddress: OWNER, agentId: AGENT, positionId: POSITION, observation });
      assert.deepEqual(await store.get(OWNER, AGENT, POSITION), observation, name);
      await store.close();
    }
    assert.equal(
      parseLpTriggerObservation({ ...minimalObservation(), gridRangeRelation: "sideways" }),
      null,
      "the relation vocabulary is closed observation-wide",
    );
  });

  it("a cross-tenant read is null and a cross-tenant write is refused", async () => {
    for (const { name, store } of await bothBackends()) {
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT,
        positionId: POSITION,
        observation: fullObservation(),
      });
      assert.equal(await store.get(OTHER, AGENT, POSITION), null, name);
      // Another AGENT under the same owner is equally invisible.
      assert.equal(await store.get(OWNER, "other-agent", POSITION), null, name);
      await assert.rejects(
        store.put({
          ownerAddress: OTHER,
          agentId: AGENT,
          positionId: POSITION,
          observation: fullObservation(),
        }),
        /another owner/u,
        name,
      );
      // The refusal did not overwrite anything.
      assert.deepEqual(await store.get(OWNER, AGENT, POSITION), fullObservation(), name);
      await store.close();
    }
  });

  it("delete is owner-scoped, idempotent, and removes the row (retention)", async () => {
    for (const { name, store } of await bothBackends()) {
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT,
        positionId: POSITION,
        observation: fullObservation(),
      });
      await store.delete(OTHER, AGENT, POSITION);
      assert.notEqual(await store.get(OWNER, AGENT, POSITION), null, `${name}: cross-owner delete took effect`);
      await store.delete(OWNER, AGENT, POSITION);
      assert.equal(await store.get(OWNER, AGENT, POSITION), null, name);
      // Deleting again is a no-op, never an error.
      await store.delete(OWNER, AGENT, POSITION);
      assert.equal(await store.get(OWNER, AGENT, POSITION), null, name);
      await store.close();
    }
  });

  it("the last write wins — one upsert per position per cycle", async () => {
    for (const { name, store } of await bothBackends()) {
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT,
        positionId: POSITION,
        observation: minimalObservation(),
      });
      const second: LpTriggerObservation = {
        ...minimalObservation(),
        evaluatedAtMs: 1_700_000_060_000,
        protectBreach: "take-profit",
        protectConsecutive: 2,
      };
      await store.put({
        ownerAddress: OWNER,
        agentId: AGENT,
        positionId: POSITION,
        observation: second,
      });
      assert.deepEqual(await store.get(OWNER, AGENT, POSITION), second, name);
      await store.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Structural validation                                                      */
/* -------------------------------------------------------------------------- */

describe("lp observation store: a structurally invalid row is null, never a throw", () => {
  it("parseLpTriggerObservation refuses every broken shape", () => {
    const good = fullObservation();
    assert.deepEqual(parseLpTriggerObservation({ ...good }), good);
    const broken: unknown[] = [
      null,
      "not an object",
      [],
      { ...good, blockNumber: 5 }, // a NUMBER, not a bigint — the numeric hazard
      { ...good, blockNumber: "5" },
      { ...good, blockNumber: -1n },
      { ...good, evaluatedAtMs: "yesterday" },
      { ...good, evaluatedAtMs: Number.NaN },
      { ...good, poolAddress: "0xnothex" },
      { ...good, protectBreach: "liquidation" },
      { ...good, protectConsecutive: 1.5 },
      { ...good, protectConsecutive: -1 },
      { ...good, rotationBreach: "true" },
      { ...good, rotationBreachStartedAtMs: "soon" },
      { ...good, rotationConsecutive: null },
      { ...good, tokenId: 7 },
      { ...good, tokenId: "0x7" },
    ];
    for (const value of broken) {
      assert.equal(
        parseLpTriggerObservation(value),
        null,
        `accepted a broken observation: ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
      );
    }
  });

  it("a corrupt persisted row reads as null rather than throwing", async () => {
    /** A client whose SELECT hands back a row the codec cannot rebuild. */
    class CorruptSqlClient implements SqlClient {
      async query<R = Record<string, unknown>>(
        text: string,
      ): Promise<SqlResult<R>> {
        if (!text.includes("lpObservations.get")) return { rows: [] };
        return {
          rows: [
            {
              position_id: POSITION,
              agent_id: AGENT,
              owner_address: OWNER.toLowerCase(),
              evaluated_at_ms: "1700000000000",
              observation: { tokenId: "7", poolAddress: POOL },
              updated_at: new Date(0),
            } as unknown as R,
          ],
        };
      }

      async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
        return fn(this);
      }

      async close(): Promise<void> {}
    }

    const store = await PostgresLpObservationStore.create(new CorruptSqlClient());
    assert.equal(await store.get(OWNER, AGENT, POSITION), null);
  });
});

/* -------------------------------------------------------------------------- */
/* SQL-literal pins (audit A9 discipline)                                     */
/* -------------------------------------------------------------------------- */

class RecordingSqlClient implements SqlClient {
  readonly texts: string[] = [];
  readonly #inner = new FakeSqlClient();

  async query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<R>> {
    this.texts.push(text);
    return this.#inner.query<R>(text, params);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.#inner.transaction(async () => fn(this));
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

describe("Postgres SQL literals: lp_observations is pinned", () => {
  function statement(sql: RecordingSqlClient, tag: string): string {
    const found = sql.texts.find((text) => text.includes(tag));
    assert.notEqual(found, undefined, `no recorded statement carries ${tag}`);
    return found ?? "";
  }

  it("creates the table and the owner index, and types the columns as specced", async () => {
    const sql = new RecordingSqlClient();
    const store = await PostgresLpObservationStore.create(sql);
    const ddl = statement(sql, "create table if not exists lp_observations");
    assert.ok(ddl.includes("position_id text primary key"));
    assert.ok(ddl.includes("agent_id text not null"));
    assert.ok(ddl.includes("owner_address text not null"));
    assert.ok(ddl.includes("evaluated_at_ms bigint not null"));
    // jsonb, NOT numeric: `toWei`'s NULL-to-0n would make
    // `0n < market.blockNumber` trivially true — a fail-OPEN comparability.
    assert.ok(ddl.includes("observation jsonb not null"));
    assert.ok(!/block_number\s+numeric/u.test(ddl), "no numeric block column");
    const index = statement(sql, "lp_observations_owner_idx");
    assert.ok(index.includes("on lp_observations (owner_address, agent_id)"));
    await store.close();
  });

  it("every statement carries the full three-part owner scope", async () => {
    const sql = new RecordingSqlClient();
    const store = await PostgresLpObservationStore.create(sql);
    await store.put({
      ownerAddress: OWNER,
      agentId: AGENT,
      positionId: POSITION,
      observation: fullObservation(),
    });
    await store.get(OWNER, AGENT, POSITION);
    await store.delete(OWNER, AGENT, POSITION);

    const get = statement(sql, "lpObservations.get");
    assert.ok(
      get.includes("where position_id = $1 and agent_id = $2 and owner_address = $3"),
      "the read scope drifted",
    );
    const del = statement(sql, "lpObservations.delete");
    assert.ok(
      del.includes("where position_id = $1 and agent_id = $2 and owner_address = $3"),
      "the delete scope drifted",
    );
    const put = statement(sql, "lpObservations.put");
    assert.ok(
      put.includes("where lp_observations.owner_address = excluded.owner_address"),
      "the cross-owner guard on the upsert's UPDATE arm must not drift",
    );
    assert.ok(put.includes("$5::jsonb"), "the observation must bind as jsonb");
    await store.close();
  });
});

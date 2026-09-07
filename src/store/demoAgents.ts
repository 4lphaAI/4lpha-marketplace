/**
 * DEMO MODE — the demo agent store.
 *
 * ─── WHAT THIS TABLE HOLDS, AND WHAT IT CAN NEVER HOLD ─────────────────────
 *
 * A demo agent's whole existence: its frozen config, a rolling engine snapshot
 * and its simulated fills. It holds NO session key, no owner address, no
 * grant, no nonce, no journal reference and no sequence — a demo agent has none
 * of those things, which is the entire safety argument for demo mode
 * (`src/demo/types.ts`, plan §2).
 *
 * Two tables, both brand new, both additive: `create table if not exists` is
 * the whole migration, the `lp_observations` / `grid_cycles` precedent. No
 * existing table is altered by this phase.
 *
 * ─── IT IS SAFE TO TRUNCATE ────────────────────────────────────────────────
 *
 * Nothing here is consulted to decide whether anything ran, because nothing
 * runs. Dropping every row loses simulations, not money and not state.
 *
 * ─── OWNER SCOPE ───────────────────────────────────────────────────────────
 *
 * A demo owner is an anonymous cookie id, not an address, and every
 * owner-facing method is scoped by it: a cross-owner read answers `null` or an
 * empty list, indistinguishable from "no rows" — the same posture as every
 * other store in this plane. `listDue` is the ONE unscoped method and it exists
 * for the worker, which sweeps every running agent exactly as the LP worker
 * does.
 *
 * ─── THE CAP IS ENFORCED HERE, NOT AT THE ROUTE ────────────────────────────
 *
 * A route-level count would be a TOCTOU the anonymous-owner model makes cheap
 * to hit on purpose. So `create` takes a per-owner advisory lock and counts
 * inside the SAME transaction as the insert.
 *
 * REVIEW FIX (2026-09-07, finding 3): the first version used a single
 * `insert … select … where (select count(*)) < $cap` and claimed that was
 * enough. It is not — at READ COMMITTED two concurrent statements each see the
 * pre-insert count and both commit, because a predicate read takes no lock on
 * rows that do not exist yet. `pg_advisory_xact_lock(hashtext(owner))` is the
 * same fence `agents.walletFence` uses for the same class of problem.
 *
 * ─── WHAT COUNTS TOWARD THE CAP ────────────────────────────────────────────
 *
 * Only `running` rows. REVIEW FIX (finding 15): counting `stopped` ones made
 * the refusal's own remedy — "stop one to start another" — impossible to
 * follow. A stopped demo is history; it should not hold a slot.
 */
import { encodeJsonbParam, decodeJsonb } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import type { DemoAgentKind, DemoOwnerId } from "../demo/types.js";

/**
 * A demo agent's lifecycle.
 *
 * `expired` is a value the store never WRITES: the sweep deletes the row (see
 * `sweepExpired`). It stays in the union because a record can be constructed
 * with it and the compiler should not have to be argued with about a state the
 * table simply no longer holds.
 */
export type DemoAgentStatus = "running" | "stopped" | "expired";

/**
 * The frozen configuration a demo run was created with.
 *
 * Deliberately opaque here: the store persists and returns it, the engines
 * interpret it. Keeping the schema out of the store is what lets the grid and
 * trade engines evolve without a migration.
 */
export type DemoAgentConfig = Readonly<Record<string, unknown>>;

/** The rolling engine snapshot, replaced whole on every cycle. */
export type DemoAgentState = Readonly<Record<string, unknown>>;

export type DemoAgentRecord = {
  readonly id: string;
  readonly ownerId: DemoOwnerId;
  readonly kind: DemoAgentKind;
  readonly name: string;
  readonly status: DemoAgentStatus;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** When the worker last advanced this agent; `null` before its first cycle. */
  readonly lastTickAtMs: number | null;
  /** Why the agent is not advancing, when it is not. Shown as a dash reason. */
  readonly holdReason: string | null;
  readonly config: DemoAgentConfig;
  readonly state: DemoAgentState;
  /** LLM calls consumed today, and the UTC day they were counted against. */
  readonly llmCallsToday: number;
  readonly llmDayUtc: string;
};

/** One simulated fill. Opaque payload plus the few columns worth querying. */
export type DemoFillRecord = {
  readonly agentId: string;
  readonly seq: number;
  readonly atMs: number;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type DemoCreateOutcome =
  | { readonly ok: true; readonly record: DemoAgentRecord }
  | { readonly ok: false; readonly reason: "at-cap" | "duplicate" };

export interface DemoAgentStore {
  /**
   * Insert a demo agent, refusing when the owner already holds `maxPerOwner`
   * RUNNING ones. Fenced per owner, so a race cannot land an over-cap row.
   */
  create(record: DemoAgentRecord, maxPerOwner: number): Promise<DemoCreateOutcome>;
  /** Owner-scoped read. A cross-owner id answers `null`. */
  get(ownerId: DemoOwnerId, id: string): Promise<DemoAgentRecord | null>;
  /** Owner-scoped list, newest first. */
  list(ownerId: DemoOwnerId): Promise<DemoAgentRecord[]>;
  /** UNSCOPED, for the worker: running, unexpired agents, oldest tick first. */
  listDue(nowMs: number, limit: number): Promise<DemoAgentRecord[]>;
  /**
   * Commit ONE cycle: the rolling snapshot and that cycle's fills, together.
   *
   * FIX-REVIEW FINDING 13. The first repair wrote fills first and argued that a
   * crash between the two writes would be re-derived next cycle. That is false:
   * the next cycle reads FRESH prices, so the replayed fill is a different fill,
   * while `(agentId, seq)` conflict handling keeps the ORIGINAL payload — state
   * and history then disagree permanently, on a single worker. Reproduced by
   * the reviewer at a buy of 0.5 recorded against a snapshot of 1.0.
   *
   * So it is one operation. On Postgres that is one transaction; in memory it
   * is one synchronous mutation with no await between the halves.
   */
  commitCycle(input: {
    readonly id: string;
    readonly state: DemoAgentState;
    readonly lastTickAtMs: number;
    readonly holdReason: string | null;
    readonly llmCallsToday: number;
    readonly llmDayUtc: string;
    readonly fills: readonly DemoFillRecord[];
  }): Promise<void>;
  /** Owner-scoped stop. Idempotent; a stopped agent stays stopped. */
  stop(ownerId: DemoOwnerId, id: string): Promise<boolean>;
  /** Append fills. Idempotent on `(agentId, seq)` so a replayed cycle is free. */
  appendFills(fills: readonly DemoFillRecord[]): Promise<void>;
  /** Owner-scoped fill history, newest first, bounded. */
  listFills(ownerId: DemoOwnerId, agentId: string, limit: number): Promise<DemoFillRecord[]>;
  /**
   * DELETE everything past its TTL, fills included, in a bounded batch.
   * Returns how many agents it retired.
   */
  sweepExpired(nowMs: number): Promise<number>;
  /**
   * Claim ONE LLM call against BOTH ceilings — the global day budget and this
   * agent's own — or refuse.
   *
   * REVIEW FIX (finding 4, twice). The ceiling started as a local variable
   * inside one worker cycle, so it reset every minute and bounded nothing.
   * The first repair made the GLOBAL half durable but left the per-agent count
   * riding on the snapshot save at the end of the cycle — so a provider call
   * that threw, followed by a failed save, spent two calls against a ceiling of
   * one (the reviewer reproduced exactly that). Both halves are durable now,
   * and both are CLAIMED BEFORE the call: a provider that took the request and
   * failed still cost money, so a refund would be an unbounded retry loop.
   */
  reserveLlmCall(input: {
    readonly agentId: string;
    readonly dayUtc: string;
    readonly globalCeiling: number;
    readonly perAgentCeiling: number;
    /**
     * Refuse when this agent's last claim was less than this many milliseconds
     * ago (fix-review-2 finding 6). The budget bounds the DAY; this bounds the
     * BURST, so a 25-call allowance is not spent in 25 consecutive minutes.
     */
    readonly minIntervalMs: number;
    readonly nowMs: number;
  }): Promise<boolean>;
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A DEEP copy. Review finding 20: a shallow spread of `config`/`state` left the
 * nested arrays shared, so a caller mutating a returned level mutated the
 * store — a divergence from the Postgres backend, which decodes fresh objects
 * every read. `structuredClone` handles the bigints these trees carry.
 */
function clone(record: DemoAgentRecord): DemoAgentRecord {
  return {
    ...record,
    config: structuredClone(record.config),
    state: structuredClone(record.state),
  };
}

/** The page both backends answer with, so their observable behaviour matches. */
const LIST_LIMIT = 50;

/** Agents retired per sweep. BOTH backends honour it (fix-review finding 9). */
const SWEEP_BATCH = 200;

/**
 * How long a day's LLM accounting rows outlive the day (fix-review-2 finding 5).
 * Two days, so a sweep that misses one still collects it.
 */
const LLM_BUDGET_RETENTION_MS = 2 * 86_400_000;

/** The UTC day of a timestamp. Restated here so the store needs no import. */
function demoUtcDayFor(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Thrown INSIDE the LLM reservation transaction to roll the per-agent claim
 * back when the global ceiling refuses. It never escapes `reserveLlmCall`.
 */
class DemoLlmGlobalCeilingReached extends Error {}

export class MemoryDemoAgentStore implements DemoAgentStore {
  readonly #agents = new Map<string, DemoAgentRecord>();
  readonly #fills = new Map<string, DemoFillRecord>();
  readonly #llm = new Map<string, number>();
  readonly #llmLast = new Map<string, number>();

  async create(record: DemoAgentRecord, maxPerOwner: number): Promise<DemoCreateOutcome> {
    if (this.#agents.has(record.id)) return { ok: false, reason: "duplicate" };
    const held = [...this.#agents.values()].filter(
      (row) => row.ownerId === record.ownerId && row.status === "running",
    ).length;
    if (held >= maxPerOwner) return { ok: false, reason: "at-cap" };
    this.#agents.set(record.id, clone(record));
    return { ok: true, record: clone(record) };
  }

  async get(ownerId: DemoOwnerId, id: string): Promise<DemoAgentRecord | null> {
    const row = this.#agents.get(id);
    // Cross-owner reads answer `null`, indistinguishable from "no such row".
    return row === undefined || row.ownerId !== ownerId ? null : clone(row);
  }

  async list(ownerId: DemoOwnerId): Promise<DemoAgentRecord[]> {
    return [...this.#agents.values()]
      .filter((row) => row.ownerId === ownerId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, LIST_LIMIT)
      .map(clone);
  }

  async listDue(nowMs: number, limit: number): Promise<DemoAgentRecord[]> {
    return [...this.#agents.values()]
      .filter((row) => row.status === "running" && row.expiresAtMs > nowMs)
      .sort((left, right) => (left.lastTickAtMs ?? 0) - (right.lastTickAtMs ?? 0))
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  async commitCycle(input: {
    readonly id: string;
    readonly state: DemoAgentState;
    readonly lastTickAtMs: number;
    readonly holdReason: string | null;
    readonly llmCallsToday: number;
    readonly llmDayUtc: string;
    readonly fills: readonly DemoFillRecord[];
  }): Promise<void> {
    const row = this.#agents.get(input.id);
    if (row === undefined) return;
    // ONE synchronous mutation, no `await` between the halves: the snapshot and
    // its fills land together or not at all (fix-review finding 13).
    for (const fill of input.fills) {
      const key = `${fill.agentId}:${fill.seq}`;
      if (!this.#fills.has(key)) {
        this.#fills.set(key, { ...fill, payload: structuredClone(fill.payload) });
      }
    }
    this.#agents.set(input.id, {
      ...row,
      // DEEP (finding 20): a shallow copy left the caller aliasing the store's
      // own tree, so mutating the object it had just saved changed what the
      // next read returned — behaviour the Postgres backend never had.
      state: structuredClone(input.state),
      lastTickAtMs: input.lastTickAtMs,
      holdReason: input.holdReason,
      llmCallsToday: input.llmCallsToday,
      llmDayUtc: input.llmDayUtc,
    });
  }

  async stop(ownerId: DemoOwnerId, id: string): Promise<boolean> {
    const row = this.#agents.get(id);
    if (row === undefined || row.ownerId !== ownerId) return false;
    if (row.status === "running") this.#agents.set(id, { ...row, status: "stopped" });
    return true;
  }

  async appendFills(fills: readonly DemoFillRecord[]): Promise<void> {
    for (const fill of fills) {
      const key = `${fill.agentId}:${fill.seq}`;
      if (!this.#fills.has(key)) {
        this.#fills.set(key, { ...fill, payload: structuredClone(fill.payload) });
      }
    }
  }

  async listFills(
    ownerId: DemoOwnerId,
    agentId: string,
    limit: number,
  ): Promise<DemoFillRecord[]> {
    const agent = this.#agents.get(agentId);
    if (agent === undefined || agent.ownerId !== ownerId) return [];
    return [...this.#fills.values()]
      .filter((fill) => fill.agentId === agentId)
      .sort((left, right) => right.seq - left.seq)
      .slice(0, Math.max(0, limit))
      .map((fill) => ({ ...fill, payload: structuredClone(fill.payload) }));
  }

  async sweepExpired(nowMs: number): Promise<number> {
    // The sweep DELETES (review finding 9): flipping a status left every row an
    // anonymous cookie ever created in the table for ever, which is a growth
    // rate with extra steps rather than a TTL.
    //
    // FILLS FIRST, then the parent (fix-review finding 9): the reverse order
    // orphans fills permanently when the second delete fails, because the next
    // sweep can no longer find the parent that named them.
    //
    // BOUNDED at SWEEP_BATCH, which the interface promises and the first
    // version did not keep — it scanned every agent and, for each expired one,
    // every fill.
    // The retired ids are collected FIRST and bounded, so the scan stops at the
    // batch instead of walking every agent every cycle (fix-review-2 finding 4).
    const expired: string[] = [];
    for (const [id, row] of this.#agents) {
      if (row.expiresAtMs > nowMs) continue;
      expired.push(id);
      if (expired.length >= SWEEP_BATCH) break;
    }
    if (expired.length === 0) {
      this.#pruneLlmBudget(nowMs);
      return 0;
    }
    // ONE pass over the fill keys for the WHOLE batch, not one pass per agent:
    // the previous version copied and scanned the entire collection for every
    // expired parent, so a sweep retiring 200 agents walked it 200 times.
    const retiring = new Set(expired);
    for (const key of [...this.#fills.keys()]) {
      const agentId = key.slice(0, key.lastIndexOf(":"));
      if (retiring.has(agentId)) this.#fills.delete(key);
    }
    for (const id of expired) this.#agents.delete(id);
    this.#pruneLlmBudget(nowMs);
    return expired.length;
  }

  /** Retire accounting rows for days now past retention (finding 5). */
  #pruneLlmBudget(nowMs: number): void {
    const cutoff = demoUtcDayFor(nowMs - LLM_BUDGET_RETENTION_MS);
    for (const key of [...this.#llm.keys()]) {
      const day = key.includes("|") ? key.slice(0, key.indexOf("|")) : key;
      if (day < cutoff) this.#llm.delete(key);
    }
    // The pacing marks go with the agents they paced.
    for (const agentId of [...this.#llmLast.keys()]) {
      if (!this.#agents.has(agentId)) this.#llmLast.delete(agentId);
    }
  }

  async reserveLlmCall(input: {
    readonly agentId: string;
    readonly dayUtc: string;
    readonly globalCeiling: number;
    readonly perAgentCeiling: number;
    readonly minIntervalMs: number;
    readonly nowMs: number;
  }): Promise<boolean> {
    if (input.globalCeiling <= 0 || input.perAgentCeiling <= 0) return false;
    const last = this.#llmLast.get(input.agentId);
    if (last !== undefined && input.nowMs - last < input.minIntervalMs) return false;
    const agentKey = `${input.dayUtc}|${input.agentId}`;
    if ((this.#llm.get(agentKey) ?? 0) >= input.perAgentCeiling) return false;
    if ((this.#llm.get(input.dayUtc) ?? 0) >= input.globalCeiling) return false;
    this.#llm.set(agentKey, (this.#llm.get(agentKey) ?? 0) + 1);
    this.#llm.set(input.dayUtc, (this.#llm.get(input.dayUtc) ?? 0) + 1);
    this.#llmLast.set(input.agentId, input.nowMs);
    return true;
  }

  async close(): Promise<void> {
    this.#agents.clear();
    this.#fills.clear();
    this.#llm.clear();
    this.#llmLast.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

const DEMO_AGENTS_DDL = `
  create table if not exists demo_agents (
    id text primary key,
    owner_id text not null,
    kind text not null check (kind in ('grid', 'trade')),
    name text not null,
    status text not null check (status in ('running', 'stopped', 'expired')),
    created_at_ms bigint not null,
    expires_at_ms bigint not null,
    last_tick_at_ms bigint,
    hold_reason text,
    config jsonb not null,
    state jsonb not null,
    llm_calls_today int not null default 0,
    llm_day_utc text not null default ''
  )
`;

const DEMO_AGENTS_OWNER_INDEX_DDL = `
  create index if not exists demo_agents_owner_idx
    on demo_agents (owner_id, created_at_ms desc)
`;

const DEMO_AGENTS_DUE_INDEX_DDL = `
  create index if not exists demo_agents_due_idx
    on demo_agents (status, expires_at_ms, last_tick_at_ms)
`;

/** Expiry-LEADING, so the sweep's own lookup is an index scan (fix-review 9). */
const DEMO_AGENTS_EXPIRY_INDEX_DDL = `
  create index if not exists demo_agents_expiry_idx
    on demo_agents (expires_at_ms)
`;

const DEMO_FILLS_DDL = `
  create table if not exists demo_fills (
    agent_id text not null,
    seq int not null,
    at_ms bigint not null,
    kind text not null,
    payload jsonb not null,
    primary key (agent_id, seq)
  )
`;

const DEMO_FILLS_INDEX_DDL = `
  create index if not exists demo_fills_agent_idx
    on demo_fills (agent_id, seq desc)
`;

/**
 * The durable LLM budget (review finding 4).
 *
 * One row per UTC day for the global ceiling, plus one `<day>|<agent>` row per
 * agent per day. `last_call_ms` carries the pacing bound (fix-review-2 finding
 * 6) and `day_key` the retention bound (finding 5) — the first version claimed
 * these rows "disappear with the day" and nothing deleted them, so a stream of
 * anonymous demos left permanent accounting rows behind agents that were gone.
 */
const DEMO_LLM_DDL = `
  create table if not exists demo_llm_budget (
    day_utc text primary key,
    calls int not null default 0,
    last_call_ms bigint not null default 0,
    day_key text not null default ''
  )
`;

/** Older deployments have the two-column form; both columns are additive. */
const DEMO_LLM_MIGRATE_DDL = [
  "alter table demo_llm_budget add column if not exists last_call_ms bigint not null default 0",
  "alter table demo_llm_budget add column if not exists day_key text not null default ''",
];

const DEMO_LLM_DAY_INDEX_DDL = `
  create index if not exists demo_llm_budget_day_idx on demo_llm_budget (day_key)
`;

const AGENT_COLUMNS =
  "id, owner_id, kind, name, status, created_at_ms, expires_at_ms, last_tick_at_ms, "
  + "hold_reason, config, state, llm_calls_today, llm_day_utc";

type AgentRow = {
  id: string;
  owner_id: string;
  kind: string;
  name: string;
  status: string;
  created_at_ms: string | number;
  expires_at_ms: string | number;
  last_tick_at_ms: string | number | null;
  hold_reason: string | null;
  config: unknown;
  state: unknown;
  llm_calls_today: number;
  llm_day_utc: string;
};

type FillRow = {
  agent_id: string;
  seq: number;
  at_ms: string | number;
  kind: string;
  payload: unknown;
};

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  const decoded = decodeJsonb(value);
  return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : {};
}

function rowToAgent(row: AgentRow): DemoAgentRecord {
  return {
    id: row.id,
    ownerId: row.owner_id as DemoOwnerId,
    kind: row.kind === "trade" ? "trade" : "grid",
    name: row.name,
    status:
      row.status === "running" ? "running" : row.status === "stopped" ? "stopped" : "expired",
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    lastTickAtMs: row.last_tick_at_ms === null ? null : Number(row.last_tick_at_ms),
    holdReason: row.hold_reason,
    config: asRecord(row.config),
    state: asRecord(row.state),
    llmCallsToday: Number(row.llm_calls_today),
    llmDayUtc: row.llm_day_utc,
  };
}

function rowToFill(row: FillRow): DemoFillRecord {
  return {
    agentId: row.agent_id,
    seq: Number(row.seq),
    atMs: Number(row.at_ms),
    kind: row.kind,
    payload: asRecord(row.payload),
  };
}

export class PostgresDemoAgentStore implements DemoAgentStore {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  static async create(sql: SqlClient): Promise<PostgresDemoAgentStore> {
    await sql.query(DEMO_AGENTS_DDL);
    await sql.query(DEMO_AGENTS_OWNER_INDEX_DDL);
    await sql.query(DEMO_AGENTS_DUE_INDEX_DDL);
    await sql.query(DEMO_AGENTS_EXPIRY_INDEX_DDL);
    await sql.query(DEMO_FILLS_DDL);
    await sql.query(DEMO_FILLS_INDEX_DDL);
    await sql.query(DEMO_LLM_DDL);
    for (const statement of DEMO_LLM_MIGRATE_DDL) await sql.query(statement);
    await sql.query(DEMO_LLM_DAY_INDEX_DDL);
    return new PostgresDemoAgentStore(sql);
  }

  static async fromUrl(databaseUrl: string): Promise<PostgresDemoAgentStore> {
    return PostgresDemoAgentStore.create(await createPgSqlClient(databaseUrl));
  }

  async create(record: DemoAgentRecord, maxPerOwner: number): Promise<DemoCreateOutcome> {
    return this.#sql.transaction(async (tx) => {
      // The owner fence FIRST, so the count below cannot be raced by a second
      // insert for the same cookie (see the header: a predicate read locks
      // nothing, so the previous single-statement form was not a fence at all).
      await tx.query(`/* demoAgents.ownerFence */ select pg_advisory_xact_lock(hashtext($1))`, [
        `demo|${record.ownerId}`,
      ]);
      const existing = await tx.query<{ id: string }>(
        "select id from demo_agents where id = $1",
        [record.id],
      );
      if (existing.rows.length > 0) return { ok: false as const, reason: "duplicate" as const };
      const held = await tx.query<{ count: string }>(
        "select count(*)::text as count from demo_agents where owner_id = $1 and status = 'running'",
        [record.ownerId],
      );
      if (Number(held.rows[0]?.count ?? "0") >= maxPerOwner) {
        return { ok: false as const, reason: "at-cap" as const };
      }
      await tx.query(
        `/* demoAgents.create */
         insert into demo_agents (${AGENT_COLUMNS})
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)`,
        [
          record.id,
          record.ownerId,
          record.kind,
          record.name,
          record.status,
          record.createdAtMs,
          record.expiresAtMs,
          record.lastTickAtMs,
          record.holdReason,
          encodeJsonbParam(record.config),
          encodeJsonbParam(record.state),
          record.llmCallsToday,
          record.llmDayUtc,
        ],
      );
      return { ok: true as const, record };
    });
  }

  async get(ownerId: DemoOwnerId, id: string): Promise<DemoAgentRecord | null> {
    const result = await this.#sql.query<AgentRow>(
      `select ${AGENT_COLUMNS} from demo_agents where id = $1 and owner_id = $2`,
      [id, ownerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToAgent(row);
  }

  async list(ownerId: DemoOwnerId): Promise<DemoAgentRecord[]> {
    const result = await this.#sql.query<AgentRow>(
      `select ${AGENT_COLUMNS} from demo_agents where owner_id = $1
       order by created_at_ms desc limit ${LIST_LIMIT}`,
      [ownerId],
    );
    return result.rows.map(rowToAgent);
  }

  async listDue(nowMs: number, limit: number): Promise<DemoAgentRecord[]> {
    const result = await this.#sql.query<AgentRow>(
      `select ${AGENT_COLUMNS} from demo_agents
       where status = 'running' and expires_at_ms > $1
       order by last_tick_at_ms asc nulls first
       limit $2`,
      [nowMs, Math.max(0, Math.trunc(limit))],
    );
    return result.rows.map(rowToAgent);
  }

  async commitCycle(input: {
    readonly id: string;
    readonly state: DemoAgentState;
    readonly lastTickAtMs: number;
    readonly holdReason: string | null;
    readonly llmCallsToday: number;
    readonly llmDayUtc: string;
    readonly fills: readonly DemoFillRecord[];
  }): Promise<void> {
    // ONE transaction (fix-review finding 13): the snapshot and its fills are a
    // single cycle's result, and a crash between them left state and history
    // permanently disagreeing — the next cycle reads fresh prices, so its
    // replayed fill is a DIFFERENT fill while the idempotent key keeps the old
    // payload.
    await this.#sql.transaction(async (tx) => {
      for (const fill of input.fills) {
        await tx.query(
          `insert into demo_fills (agent_id, seq, at_ms, kind, payload)
           values ($1, $2, $3, $4, $5::jsonb)
           on conflict (agent_id, seq) do nothing`,
          [fill.agentId, fill.seq, fill.atMs, fill.kind, encodeJsonbParam(fill.payload)],
        );
      }
      await tx.query(
        `update demo_agents
         set state = $2::jsonb, last_tick_at_ms = $3, hold_reason = $4,
             llm_calls_today = $5, llm_day_utc = $6
         where id = $1`,
        [
          input.id,
          encodeJsonbParam(input.state),
          input.lastTickAtMs,
          input.holdReason,
          input.llmCallsToday,
          input.llmDayUtc,
        ],
      );
    });
  }

  async stop(ownerId: DemoOwnerId, id: string): Promise<boolean> {
    const result = await this.#sql.query<{ id: string }>(
      `update demo_agents set status = 'stopped'
       where id = $1 and owner_id = $2 and status = 'running'
       returning id`,
      [id, ownerId],
    );
    if (result.rows.length > 0) return true;
    // Idempotent: an already-stopped row of this owner is still a success.
    const existing = await this.#sql.query<{ id: string }>(
      "select id from demo_agents where id = $1 and owner_id = $2",
      [id, ownerId],
    );
    return existing.rows.length > 0;
  }

  async appendFills(fills: readonly DemoFillRecord[]): Promise<void> {
    for (const fill of fills) {
      await this.#sql.query(
        `insert into demo_fills (agent_id, seq, at_ms, kind, payload)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (agent_id, seq) do nothing`,
        [fill.agentId, fill.seq, fill.atMs, fill.kind, encodeJsonbParam(fill.payload)],
      );
    }
  }

  async listFills(
    ownerId: DemoOwnerId,
    agentId: string,
    limit: number,
  ): Promise<DemoFillRecord[]> {
    const result = await this.#sql.query<FillRow>(
      `select f.agent_id, f.seq, f.at_ms, f.kind, f.payload
       from demo_fills f
       join demo_agents a on a.id = f.agent_id and a.owner_id = $1
       where f.agent_id = $2
       order by f.seq desc
       limit $3`,
      [ownerId, agentId, Math.max(0, Math.trunc(limit))],
    );
    return result.rows.map(rowToFill);
  }

  async sweepExpired(nowMs: number): Promise<number> {
    // DELETES, in a BOUNDED batch, inside ONE transaction, FILLS FIRST.
    //
    // All three are fix-review finding 9. The first repair deleted parents and
    // then fills in two separate statements: a failure between them orphaned
    // the fills PERMANENTLY, because the next sweep could no longer find the
    // parent that named them. Selecting the ids first and deleting the children
    // before the parents inside one transaction makes the whole retirement
    // atomic and retryable.
    const retired = await this.#sql.transaction(async (tx) => {
      const selected = await tx.query<{ id: string }>(
        `select id from demo_agents where expires_at_ms <= $1 order by expires_at_ms limit $2`,
        [nowMs, SWEEP_BATCH],
      );
      const ids = selected.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      await tx.query("delete from demo_fills where agent_id = any($1::text[])", [ids]);
      await tx.query("delete from demo_agents where id = any($1::text[])", [ids]);
      return ids.length;
    });
    // The LLM budget rows go with the days they counted (fix-review-2 finding
    // 5). The comment on `reserveLlmCall` used to say a `<day>|<agent>` row
    // "disappears with the day" and nothing deleted it, so a stream of anonymous
    // demos left permanent accounting rows behind agents that were long gone.
    // Its own bounded statement, outside the retirement transaction: losing a
    // few stale counters is free, and it must never roll back a retirement.
    const cutoff = demoUtcDayFor(nowMs - LLM_BUDGET_RETENTION_MS);
    try {
      await this.#sql.query(
        `delete from demo_llm_budget
         where day_utc in (
           select day_utc from demo_llm_budget
           where (case when day_key = '' then day_utc else day_key end) < $1
           limit $2
         )`,
        [cutoff, SWEEP_BATCH],
      );
    } catch {
      // Derived accounting. A failure here costs a stale row, never a retirement.
    }
    return retired;
  }

  async reserveLlmCall(input: {
    readonly agentId: string;
    readonly dayUtc: string;
    readonly globalCeiling: number;
    readonly perAgentCeiling: number;
    readonly minIntervalMs: number;
    readonly nowMs: number;
  }): Promise<boolean> {
    if (input.globalCeiling <= 0 || input.perAgentCeiling <= 0) return false;
    // BOTH ceilings, both durable, both claimed before the call, in ONE
    // transaction so a claim is all-or-nothing (fix-review finding 4). Each
    // half is a conditional upsert: the `where` runs against the row the insert
    // is about to conflict with, under the lock the conflict target takes, so
    // two workers cannot both see the same count and both claim the last call.
    //
    // The per-agent row is keyed `<day>|<agent>`, which makes it disappear with
    // the day rather than needing its own reset.
    return this.#sql.transaction(async (tx) => {
      const claim = async (key: string, ceiling: number, paced: boolean): Promise<boolean> => {
        const result = await tx.query<{ calls: number }>(
          `insert into demo_llm_budget (day_utc, calls, last_call_ms, day_key)
           values ($1, 1, $3, $4)
           on conflict (day_utc) do update
             set calls = demo_llm_budget.calls + 1, last_call_ms = $3
             where demo_llm_budget.calls < $2
               and ($5 = 0 or demo_llm_budget.last_call_ms <= $3 - $5)
           returning calls`,
          [key, ceiling, input.nowMs, input.dayUtc, paced ? input.minIntervalMs : 0],
        );
        return result.rows.length > 0;
      };
      // Per-agent first: it is the tighter bound, so a refusal there should not
      // consume a global call. It is also the PACED one — the interval bounds an
      // agent's burst, not the deployment's (fix-review-2 finding 6).
      if (!(await claim(`${input.dayUtc}|${input.agentId}`, input.perAgentCeiling, true))) {
        return false;
      }
      if (!(await claim(input.dayUtc, input.globalCeiling, false))) {
        // The transaction rolls back on the thrown error below, so the
        // per-agent claim is released with it — the two never disagree.
        throw new DemoLlmGlobalCeilingReached();
      }
      return true;
    }).catch((error: unknown) => {
      if (error instanceof DemoLlmGlobalCeilingReached) return false;
      throw error;
    });
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

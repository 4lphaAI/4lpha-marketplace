/** Owner-signed trading settings store (TRADING-AGENT R5 / R3.8). */
import { getAddress, type Address, type Hex } from "viem";
import { canonicalEncode } from "../auth/canonical.js";
import type { AgentRecord } from "./agents.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

export type Clock = () => number;

export type TradeSettingsRecord = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  /** The signed params are stored verbatim and interpreted only after reading. */
  readonly params: unknown;
  readonly digest: Hex;
  readonly updatedAt: number;
  /** Monotonic removal fence. Once present, this agent can never open again. */
  readonly drainingAt: number | null;
};

export type PutTradeSettingsInput = Omit<TradeSettingsRecord, "updatedAt" | "drainingAt">;

export type PutInitialTradeSettingsResult =
  | { readonly kind: "created" | "same"; readonly record: TradeSettingsRecord }
  | { readonly kind: "conflict" };

export type TradeAgentLookup = {
  getAgentById(agentId: string): Promise<AgentRecord | null>;
};

export type TradeWorkerSettingsPage = {
  readonly rows: readonly TradeSettingsRecord[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
};

export interface TradeSettingsStore {
  get(ownerAddress: Address, agentId: string): Promise<TradeSettingsRecord | null>;
  /** First-wins activation write used by Trading hire convergence. */
  putInitialIfAbsentOrSameDigest(input: PutTradeSettingsInput): Promise<PutInitialTradeSettingsResult>;
  put(input: PutTradeSettingsInput): Promise<TradeSettingsRecord>;
  requestDrain(ownerAddress: Address, agentId: string): Promise<TradeSettingsRecord | null>;
  withEntryFence<T>(
    ownerAddress: Address,
    agentId: string,
    work: () => Promise<T>,
  ): Promise<{ readonly kind: "allowed"; readonly value: T } | { readonly kind: "draining" }>;
  listTradeAgentsForWorker(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<TradeWorkerSettingsPage>;
  /** All rows that may own an unsettled intent, including paused/revoked agents. */
  listTradeAgentsForProjection(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<TradeWorkerSettingsPage>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

function assertPage(input: { readonly limit: number; readonly cursor: string | null }): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 32) {
    throw new Error("Trade worker settings limit must be an integer in 1..32.");
  }
}

export class MemoryTradeSettingsStore implements TradeSettingsStore {
  readonly #rows = new Map<string, TradeSettingsRecord>();
  readonly #agents: TradeAgentLookup | null;
  readonly #now: Clock;
  readonly #fences = new Map<string, Promise<void>>();

  constructor(agents: TradeAgentLookup | null = null, now: Clock = Date.now) {
    this.#agents = agents;
    this.#now = now;
  }

  async get(ownerAddress: Address, agentId: string): Promise<TradeSettingsRecord | null> {
    const row = this.#rows.get(agentId);
    return row === undefined || row.ownerAddress !== ownerKey(ownerAddress)
      ? null
      : structuredClone(row);
  }

  async put(input: PutTradeSettingsInput): Promise<TradeSettingsRecord> {
    const owner = ownerKey(input.ownerAddress);
    const existing = this.#rows.get(input.agentId);
    if (existing !== undefined && existing.ownerAddress !== owner) {
      throw new Error(`Trade settings for agent "${input.agentId}" belong to another owner.`);
    }
    if (existing?.drainingAt !== null && existing?.drainingAt !== undefined) {
      throw new Error("Trade settings cannot change while the agent is draining.");
    }
    const row: TradeSettingsRecord = {
      agentId: input.agentId,
      ownerAddress: owner,
      params: structuredClone(input.params),
      digest: input.digest,
      updatedAt: this.#now(),
      drainingAt: existing?.drainingAt ?? null,
    };
    this.#rows.set(row.agentId, structuredClone(row));
    return structuredClone(row);
  }

  async putInitialIfAbsentOrSameDigest(input: PutTradeSettingsInput): Promise<PutInitialTradeSettingsResult> {
    return this.#withFence(input.agentId, async () => {
      const owner = ownerKey(input.ownerAddress);
      const existing = this.#rows.get(input.agentId);
      if (existing !== undefined) {
        return existing.drainingAt === null
          && existing.ownerAddress === owner
          && existing.digest.toLowerCase() === input.digest.toLowerCase()
          && canonicalEncode(existing.params) === canonicalEncode(input.params)
          ? { kind: "same", record: structuredClone(existing) } as const
          : { kind: "conflict" } as const;
      }
      const row: TradeSettingsRecord = {
        agentId: input.agentId,
        ownerAddress: owner,
        params: structuredClone(input.params),
        digest: input.digest,
        updatedAt: this.#now(),
        drainingAt: null,
      };
      this.#rows.set(row.agentId, structuredClone(row));
      return { kind: "created", record: structuredClone(row) } as const;
    });
  }

  async requestDrain(ownerAddress: Address, agentId: string): Promise<TradeSettingsRecord | null> {
    return this.#withFence(agentId, async () => {
      const row = this.#rows.get(agentId);
      if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress)) return null;
      const at = this.#now();
      const next = row.drainingAt === null
        ? { ...row, drainingAt: at, updatedAt: at }
        : row;
      this.#rows.set(agentId, structuredClone(next));
      return structuredClone(next);
    });
  }

  async withEntryFence<T>(ownerAddress: Address, agentId: string, work: () => Promise<T>): Promise<{ readonly kind: "allowed"; readonly value: T } | { readonly kind: "draining" }> {
    return this.#withFence(agentId, async () => {
      const row = this.#rows.get(agentId);
      if (row === undefined || row.ownerAddress !== ownerKey(ownerAddress)) throw new Error("Trade settings are unavailable.");
      if (row.drainingAt !== null) return { kind: "draining" } as const;
      return { kind: "allowed", value: await work() } as const;
    });
  }

  async listTradeAgentsForWorker(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<TradeWorkerSettingsPage> {
    assertPage(input);
    if (this.#agents === null) return { rows: [], cursor: null, hasMore: false };
    const candidates = [...this.#rows.values()]
      .filter((row) => input.cursor === null || row.agentId > input.cursor)
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const armed: TradeSettingsRecord[] = [];
    for (const row of candidates) {
      const agent = await this.#agents.getAgentById(row.agentId);
      if (agent?.status === "armed") armed.push(row);
      if (armed.length > input.limit) break;
    }
    const hasMore = armed.length > input.limit;
    const rows = armed.slice(0, input.limit).map((row) => structuredClone(row));
    return {
      rows,
      hasMore,
      cursor: hasMore ? rows.at(-1)?.agentId ?? null : null,
    };
  }

  async listTradeAgentsForProjection(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<TradeWorkerSettingsPage> {
    assertPage(input);
    const candidates = [...this.#rows.values()]
      .filter((row) => input.cursor === null || row.agentId > input.cursor)
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const page = candidates.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    const rows = page.slice(0, input.limit).map((row) => structuredClone(row));
    return { rows, hasMore, cursor: hasMore ? rows.at(-1)?.agentId ?? null : null };
  }

  async close(): Promise<void> {
    this.#rows.clear();
  }

  async #withFence<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#fences.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.#fences.set(agentId, tail);
    await prior;
    try { return await work(); }
    finally {
      release();
      if (this.#fences.get(agentId) === tail) this.#fences.delete(agentId);
    }
  }
}

type SettingsRow = {
  agent_id: string;
  owner_address: string;
  params: unknown;
  digest: string;
  updated_at: Date;
  draining_at: Date | null;
};

const SETTINGS_COLUMNS = "agent_id, owner_address, params, digest, updated_at, draining_at";

/** A new table uses the repo's additive create-if-absent migration style. */
const TRADE_SETTINGS_DDL = `
  create table if not exists trade_settings (
    agent_id text primary key,
    owner_address text not null,
    params jsonb not null,
    digest text not null,
    updated_at timestamptz not null default now(),
    draining_at timestamptz
  )
`;

export class PostgresTradeSettingsStore implements TradeSettingsStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresTradeSettingsStore> {
    await sql.query(TRADE_SETTINGS_DDL);
    await sql.query(`alter table trade_settings add column if not exists draining_at timestamptz`);
    return new PostgresTradeSettingsStore(sql, now);
  }

  async get(ownerAddress: Address, agentId: string): Promise<TradeSettingsRecord | null> {
    const result = await this.#sql.query<SettingsRow>(
      `/* tradeSettings.get */
       select ${SETTINGS_COLUMNS}
       from trade_settings ts
       where ts.agent_id = $1 and ts.owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async put(input: PutTradeSettingsInput): Promise<TradeSettingsRecord> {
    // TRADING-AGENT R5: the owner predicate is inside the one upsert statement.
    const result = await this.#sql.query<SettingsRow>(
      `/* tradeSettings.put */
       insert into trade_settings (agent_id, owner_address, params, digest, updated_at)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (agent_id) do update
         set params = excluded.params, digest = excluded.digest, updated_at = excluded.updated_at
         where trade_settings.owner_address = excluded.owner_address and trade_settings.draining_at is null
       returning agent_id, owner_address, params, digest, updated_at, draining_at`,
      [
        input.agentId,
        ownerKey(input.ownerAddress),
        encodeJsonbParam(input.params),
        input.digest,
        new Date(this.#now()),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Trade settings for agent "${input.agentId}" are unavailable or draining.`);
    }
    return rowToRecord(row);
  }

  async putInitialIfAbsentOrSameDigest(input: PutTradeSettingsInput): Promise<PutInitialTradeSettingsResult> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* tradeSettings.initialFence */ select pg_advisory_xact_lock(hashtext($1))`, [input.agentId]);
      const selected = await tx.query<SettingsRow>(
        `/* tradeSettings.initialRead */ select ${SETTINGS_COLUMNS} from trade_settings
         where agent_id = $1 for update`,
        [input.agentId],
      );
      const existing = selected.rows[0];
      if (existing !== undefined) {
        const record = rowToRecord(existing);
        return record.drainingAt === null
          && record.ownerAddress === ownerKey(input.ownerAddress)
          && record.digest.toLowerCase() === input.digest.toLowerCase()
          && canonicalEncode(record.params) === canonicalEncode(input.params)
          ? { kind: "same", record } as const
          : { kind: "conflict" } as const;
      }
      const inserted = await tx.query<SettingsRow>(
        `/* tradeSettings.initialInsert */ insert into trade_settings
           (agent_id, owner_address, params, digest, updated_at, draining_at)
         values ($1, $2, $3::jsonb, $4, $5, null)
         returning ${SETTINGS_COLUMNS}`,
        [input.agentId, ownerKey(input.ownerAddress), encodeJsonbParam(input.params), input.digest, new Date(this.#now())],
      );
      const row = inserted.rows[0];
      if (row === undefined) return { kind: "conflict" } as const;
      return { kind: "created", record: rowToRecord(row) } as const;
    });
  }

  async requestDrain(ownerAddress: Address, agentId: string): Promise<TradeSettingsRecord | null> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* tradeSettings.fence */ select pg_advisory_xact_lock(hashtext($1))`, [agentId]);
      const result = await tx.query<SettingsRow>(
        `/* tradeSettings.drain */ update trade_settings ts
         set draining_at = coalesce(draining_at, $3), updated_at = case when draining_at is null then $3 else updated_at end
         where agent_id = $1 and owner_address = $2 returning ${SETTINGS_COLUMNS}`,
        [agentId, ownerKey(ownerAddress), new Date(this.#now())],
      );
      return result.rows[0] === undefined ? null : rowToRecord(result.rows[0]);
    });
  }

  async withEntryFence<T>(ownerAddress: Address, agentId: string, work: () => Promise<T>): Promise<{ readonly kind: "allowed"; readonly value: T } | { readonly kind: "draining" }> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* tradeSettings.fence */ select pg_advisory_xact_lock(hashtext($1))`, [agentId]);
      const result = await tx.query<SettingsRow>(
        `/* tradeSettings.fenceRead */ select ${SETTINGS_COLUMNS} from trade_settings ts
         where ts.agent_id = $1 and ts.owner_address = $2 for update`,
        [agentId, ownerKey(ownerAddress)],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Trade settings are unavailable.");
      if (row.draining_at !== null) return { kind: "draining" } as const;
      return { kind: "allowed", value: await work() } as const;
    });
  }

  async listTradeAgentsForWorker(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<TradeWorkerSettingsPage> {
    assertPage(input);
    const result = await this.#sql.query<SettingsRow>(
      `/* tradeSettings.listWorker */
       select ts.agent_id, ts.owner_address, ts.params, ts.digest, ts.updated_at, ts.draining_at
       from trade_settings ts
       join agents a on a.id = ts.agent_id
       where a.status = 'armed' and ($1::text is null or ts.agent_id > $1)
       order by ts.agent_id asc
       limit $2`,
      [input.cursor, input.limit + 1],
    );
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit).map(rowToRecord);
    return {
      rows,
      hasMore,
      cursor: hasMore ? rows.at(-1)?.agentId ?? null : null,
    };
  }

  async listTradeAgentsForProjection(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<TradeWorkerSettingsPage> {
    assertPage(input);
    const result = await this.#sql.query<SettingsRow>(
      `/* tradeSettings.listProjection */
       select ${SETTINGS_COLUMNS}
       from trade_settings ts
       where ($1::text is null or ts.agent_id > $1)
       order by ts.agent_id asc
       limit $2`,
      [input.cursor, input.limit + 1],
    );
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit).map(rowToRecord);
    return { rows, hasMore, cursor: hasMore ? rows.at(-1)?.agentId ?? null : null };
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

function rowToRecord(row: SettingsRow): TradeSettingsRecord {
  return {
    agentId: row.agent_id,
    ownerAddress: ownerKey(getAddress(row.owner_address)),
    params: decodeJsonb(row.params),
    digest: row.digest as Hex,
    updatedAt: row.updated_at.getTime(),
    drainingAt: row.draining_at?.getTime() ?? null,
  };
}

export async function createTradeSettingsStore(
  agents: TradeAgentLookup,
): Promise<TradeSettingsStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const store = await PostgresTradeSettingsStore.create(
      await createPgSqlClient(connectionString),
    );
    console.log("[trade-settings-store] backend=postgres");
    return store;
  }
  console.log("[trade-settings-store] backend=memory (DATABASE_URL not set)");
  return new MemoryTradeSettingsStore(agents);
}

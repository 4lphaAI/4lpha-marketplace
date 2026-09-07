/**
 * Owner-signed LP automation settings, persisted per agent (PHASE3-SPEC body
 * "API surface"; Revision 2 items 11 and 21).
 *
 * WHAT IS STORED IS THE SIGNED WIRE PARAMS, VERBATIM, plus their digest —
 * `settingsDigest = paramsHash("lpSettings", params)`, computed with the ONE
 * shared encoder (Rev2 item 21; no second canonical-JSON codec exists). The
 * sagas re-compare that digest before and between every step, so an owner
 * settings change invalidates in-flight automation; storing an interpreted
 * copy instead would let the stored object and the signed bytes drift, and the
 * digest would then bind something nobody signed. Interpretation
 * (`parseLpSettingsParams`) happens at READ time, from the same bytes.
 *
 * Same store contract as everything else in this repo: Memory + Postgres over
 * one interface, every query owner-scoped, a cross-tenant read returns `null`
 * indistinguishable from "no such row".
 */
import { getAddress, type Address, type Hex } from "viem";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

export type LpSettingsRecord = {
  readonly agentId: string;
  /** Normalized (checksum-validated, lowered) owner scope key. */
  readonly ownerAddress: Address;
  /** The owner-signed wire params, verbatim. Parse on read, never on write. */
  readonly params: unknown;
  /** `paramsHash("lpSettings", params)`, recorded beside the bytes it binds. */
  readonly digest: Hex;
  readonly updatedAt: number;
};

export type PutLpSettingsInput = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly params: unknown;
  readonly digest: Hex;
};

export interface LpSettingsStore {
  /** The agent's settings, or `null` when absent OR owned by someone else. */
  get(ownerAddress: Address, agentId: string): Promise<LpSettingsRecord | null>;
  /**
   * Record (or replace) the agent's settings. Owner-scoped: a put against a
   * row another owner holds THROWS rather than overwriting — the route derives
   * the owner from the recovered signature and the persisted agent row, so
   * reaching this error means a bug upstream, not a request to honour.
   */
  put(input: PutLpSettingsInput): Promise<LpSettingsRecord>;
  /**
   * Arm-admission seam. PostgreSQL writes through the advisory-lock
   * transaction supplied by `LpSequenceStore.withArmFence`; memory stores
   * ignore the SQL handle but keep the same ordered failure surface.
   */
  putWithinArmFence(
    input: PutLpSettingsInput,
    transaction: SqlClient | null,
  ): Promise<LpSettingsRecord>;
  close(): Promise<void>;
}

/** Checksum-validate then lower an owner address (same key as agents.ts). */
function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

export class MemoryLpSettingsStore implements LpSettingsStore {
  readonly #rows = new Map<string, LpSettingsRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async get(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSettingsRecord | null> {
    const record = this.#rows.get(agentId);
    if (record === undefined || record.ownerAddress !== ownerKey(ownerAddress)) {
      return null;
    }
    return structuredClone(record);
  }

  async put(input: PutLpSettingsInput): Promise<LpSettingsRecord> {
    const existing = this.#rows.get(input.agentId);
    if (
      existing !== undefined &&
      existing.ownerAddress !== ownerKey(input.ownerAddress)
    ) {
      throw new Error(
        `LP settings for agent "${input.agentId}" belong to another owner.`,
      );
    }
    const record: LpSettingsRecord = {
      agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress),
      params: structuredClone(input.params),
      digest: input.digest,
      updatedAt: this.#now(),
    };
    this.#rows.set(input.agentId, structuredClone(record));
    return structuredClone(record);
  }

  async putWithinArmFence(
    input: PutLpSettingsInput,
    _transaction: SqlClient | null,
  ): Promise<LpSettingsRecord> {
    return this.put(input);
  }

  async close(): Promise<void> {
    this.#rows.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type SettingsRow = {
  agent_id: string;
  owner_address: string;
  params: unknown;
  digest: string;
  updated_at: Date;
};

const SETTINGS_COLUMNS = "agent_id, owner_address, params, digest, updated_at";

const LP_SETTINGS_DDL = `
  create table if not exists lp_settings (
    agent_id text primary key,
    owner_address text not null,
    params jsonb not null,
    digest text not null,
    updated_at timestamptz not null default now()
  )
`;

export class PostgresLpSettingsStore implements LpSettingsStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresLpSettingsStore> {
    await sql.query(LP_SETTINGS_DDL);
    return new PostgresLpSettingsStore(sql, now);
  }

  async get(
    ownerAddress: Address,
    agentId: string,
  ): Promise<LpSettingsRecord | null> {
    const result = await this.#sql.query<SettingsRow>(
      `/* lpSettings.get */
       select ${SETTINGS_COLUMNS}
       from lp_settings
       where agent_id = $1 and owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async put(input: PutLpSettingsInput): Promise<LpSettingsRecord> {
    return this.#put(this.#sql, input);
  }

  async putWithinArmFence(
    input: PutLpSettingsInput,
    transaction: SqlClient | null,
  ): Promise<LpSettingsRecord> {
    if (transaction === null) {
      throw new Error("PostgreSQL LP settings require the arm-fence transaction.");
    }
    return this.#put(transaction, input);
  }

  async #put(sql: SqlClient, input: PutLpSettingsInput): Promise<LpSettingsRecord> {
    // The owner-match predicate rides on the UPDATE arm of the upsert, so a
    // cross-owner put updates nothing and the empty RETURNING throws — same
    // shape as the sequence store's lost-race surfacing.
    const result = await sql.query<SettingsRow>(
      `/* lpSettings.put */
       insert into lp_settings (agent_id, owner_address, params, digest, updated_at)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (agent_id) do update
         set params = excluded.params, digest = excluded.digest, updated_at = excluded.updated_at
         where lp_settings.owner_address = excluded.owner_address
       returning ${SETTINGS_COLUMNS}`,
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
      throw new Error(
        `LP settings for agent "${input.agentId}" belong to another owner.`,
      );
    }
    return rowToRecord(row);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

function rowToRecord(row: SettingsRow): LpSettingsRecord {
  return {
    agentId: row.agent_id,
    ownerAddress: ownerKey(getAddress(row.owner_address)),
    params: decodeJsonb(row.params),
    digest: row.digest as Hex,
    updatedAt: row.updated_at.getTime(),
  };
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable store when `DATABASE_URL` is set, otherwise the in-memory
 * one. The connection string is never logged.
 */
export async function createLpSettingsStore(): Promise<LpSettingsStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresLpSettingsStore.create(sql);
    console.log("[lp-settings-store] backend=postgres");
    return store;
  }
  console.log("[lp-settings-store] backend=memory (DATABASE_URL not set)");
  return new MemoryLpSettingsStore();
}

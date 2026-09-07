/**
 * Owner-signed Venus guard settings, persisted per agent (PHASE4-SPEC D4).
 *
 * Same contract as `lpSettings.ts`, and deliberately its shape rather than a
 * variation on it: the signed wire params are stored VERBATIM plus their digest
 * (`paramsHash("venusSettings", params)`), because the observation row carries
 * that digest and a mismatch invalidates the confirmation counter (R2.15/R18).
 * If the stored object were an interpreted copy, the digest would bind bytes
 * nobody signed.
 *
 * Memory + Postgres over one interface, every query owner-scoped, a
 * cross-tenant read returns `null` indistinguishable from "no such row", and a
 * cross-owner put THROWS rather than overwriting.
 */
import { getAddress, type Address, type Hex } from "viem";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

export type VenusSettingsRecord = {
  readonly agentId: string;
  /** Normalized (checksum-validated, lowered) owner scope key. */
  readonly ownerAddress: Address;
  /** The owner-signed wire params, verbatim. Parse on read, never on write. */
  readonly params: unknown;
  /** `paramsHash("venusSettings", params)`, recorded beside the bytes it binds. */
  readonly digest: Hex;
  readonly updatedAt: number;
};

export type PutVenusSettingsInput = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly params: unknown;
  readonly digest: Hex;
};

export interface VenusSettingsStore {
  get(ownerAddress: Address, agentId: string): Promise<VenusSettingsRecord | null>;
  put(input: PutVenusSettingsInput): Promise<VenusSettingsRecord>;
  /**
   * Every Venus-settings row, across owners — the WORKER's enumeration source
   * and the ONLY unscoped method here.
   *
   * It exists for two jobs that cannot be owner-scoped because the worker holds
   * no owner: the per-cycle candidate list, and R3.9's tracking reconcile,
   * which must be able to see a settings row whose agent has been revoked or
   * deleted in order to issue the DELETE. Named unscoped rather than smuggled
   * through a filter, so the carve-out is reviewable.
   */
  listForWorker(): Promise<readonly VenusSettingsRecord[]>;
  close(): Promise<void>;
}

/** Checksum-validate then lower an owner address (same key as agents.ts). */
function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

export class MemoryVenusSettingsStore implements VenusSettingsStore {
  readonly #rows = new Map<string, VenusSettingsRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async get(
    ownerAddress: Address,
    agentId: string,
  ): Promise<VenusSettingsRecord | null> {
    const record = this.#rows.get(agentId);
    if (record === undefined || record.ownerAddress !== ownerKey(ownerAddress)) {
      return null;
    }
    return structuredClone(record);
  }

  async put(input: PutVenusSettingsInput): Promise<VenusSettingsRecord> {
    const existing = this.#rows.get(input.agentId);
    if (
      existing !== undefined &&
      existing.ownerAddress !== ownerKey(input.ownerAddress)
    ) {
      throw new Error(
        `Venus settings for agent "${input.agentId}" belong to another owner.`,
      );
    }
    const record: VenusSettingsRecord = {
      agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress),
      params: structuredClone(input.params),
      digest: input.digest,
      updatedAt: this.#now(),
    };
    this.#rows.set(input.agentId, structuredClone(record));
    return structuredClone(record);
  }

  async listForWorker(): Promise<readonly VenusSettingsRecord[]> {
    return [...this.#rows.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
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

const VENUS_SETTINGS_DDL = `
  create table if not exists venus_settings (
    agent_id text primary key,
    owner_address text not null,
    params jsonb not null,
    digest text not null,
    updated_at timestamptz not null default now()
  )
`;

export class PostgresVenusSettingsStore implements VenusSettingsStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresVenusSettingsStore> {
    await sql.query(VENUS_SETTINGS_DDL);
    return new PostgresVenusSettingsStore(sql, now);
  }

  async get(
    ownerAddress: Address,
    agentId: string,
  ): Promise<VenusSettingsRecord | null> {
    const result = await this.#sql.query<SettingsRow>(
      `/* venusSettings.get */
       select ${SETTINGS_COLUMNS}
       from venus_settings
       where agent_id = $1 and owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRecord(row);
  }

  async put(input: PutVenusSettingsInput): Promise<VenusSettingsRecord> {
    // The owner-match predicate rides on the UPDATE arm of the upsert, so a
    // cross-owner put updates nothing and the empty RETURNING throws.
    const result = await this.#sql.query<SettingsRow>(
      `/* venusSettings.put */
       insert into venus_settings (agent_id, owner_address, params, digest, updated_at)
       values ($1, $2, $3::jsonb, $4, $5)
       on conflict (agent_id) do update
         set params = excluded.params, digest = excluded.digest, updated_at = excluded.updated_at
         where venus_settings.owner_address = excluded.owner_address
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
        `Venus settings for agent "${input.agentId}" belong to another owner.`,
      );
    }
    return rowToRecord(row);
  }

  async listForWorker(): Promise<readonly VenusSettingsRecord[]> {
    const result = await this.#sql.query<SettingsRow>(
      `/* venusSettings.listForWorker */
       select ${SETTINGS_COLUMNS}
       from venus_settings
       order by agent_id asc`,
    );
    return result.rows.map(rowToRecord);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

function rowToRecord(row: SettingsRow): VenusSettingsRecord {
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

export async function createVenusSettingsStore(): Promise<VenusSettingsStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresVenusSettingsStore.create(sql);
    console.log("[venus-settings-store] backend=postgres");
    return store;
  }
  console.log("[venus-settings-store] backend=memory (DATABASE_URL not set)");
  return new MemoryVenusSettingsStore();
}

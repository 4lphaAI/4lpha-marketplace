/** Dedicated replay protection for short-lived runtime assertions. */
import { createPgSqlClient, type SqlClient } from "./sql.js";

export type RuntimeReplay = {
  readonly issuer: string;
  readonly keyId: string;
  readonly nonce: string;
  /** Integer epoch seconds. */
  readonly expiry: number;
  /** Integer epoch seconds. */
  readonly nowSec: number;
};

export interface RuntimeReplayStore {
  /** True only for the first consume of this issuer/key/nonce tuple. */
  consume(replay: RuntimeReplay): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryRuntimeReplayStore implements RuntimeReplayStore {
  readonly #consumed = new Map<string, number>();

  async consume(replay: RuntimeReplay): Promise<boolean> {
    assertReplayTimes(replay);
    // No await between prune, check and set: this is one synchronous CAS in the
    // process-local event loop. Exact-expiry rows remain consumed.
    for (const [key, expiry] of this.#consumed) {
      if (expiry < replay.nowSec) this.#consumed.delete(key);
    }
    const key = replayKey(replay);
    if (this.#consumed.has(key)) return false;
    this.#consumed.set(key, replay.expiry);
    return true;
  }

  async close(): Promise<void> {
    this.#consumed.clear();
  }
}

type InsertedRow = { readonly nonce: string };

const RUNTIME_REPLAYS_DDL = `
  create table if not exists runtime_assertion_replays (
    issuer text not null,
    key_id text not null,
    nonce text not null,
    expires_at bigint not null,
    primary key (issuer, key_id, nonce)
  )
`;

const RUNTIME_REPLAYS_EXPIRY_INDEX_DDL = `
  create index if not exists runtime_assertion_replays_expiry_idx
  on runtime_assertion_replays (expires_at)
`;

export class PostgresRuntimeReplayStore implements RuntimeReplayStore {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  static async create(sql: SqlClient): Promise<PostgresRuntimeReplayStore> {
    await sql.query(RUNTIME_REPLAYS_DDL);
    await sql.query(RUNTIME_REPLAYS_EXPIRY_INDEX_DDL);
    return new PostgresRuntimeReplayStore(sql);
  }

  async consume(replay: RuntimeReplay): Promise<boolean> {
    assertReplayTimes(replay);
    return this.#sql.transaction(async (tx) => {
      await tx.query(
        `/* runtimeReplays.prune */
         delete from runtime_assertion_replays where expires_at < $1`,
        [replay.nowSec],
      );
      const result = await tx.query<InsertedRow>(
        `/* runtimeReplays.consume */
         insert into runtime_assertion_replays
           (issuer, key_id, nonce, expires_at)
         values ($1, $2, $3, $4)
         on conflict (issuer, key_id, nonce) do nothing
         returning nonce`,
        [replay.issuer, replay.keyId, replay.nonce, replay.expiry],
      );
      return result.rows[0] !== undefined;
    });
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

export async function createRuntimeReplayStore(): Promise<RuntimeReplayStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresRuntimeReplayStore.create(sql);
    console.log("[runtime-replay-store] backend=postgres");
    return store;
  }
  console.log("[runtime-replay-store] backend=memory (DATABASE_URL not set)");
  return new MemoryRuntimeReplayStore();
}

function replayKey(replay: RuntimeReplay): string {
  return `${replay.issuer}\u001f${replay.keyId}\u001f${replay.nonce}`;
}

function assertReplayTimes(replay: RuntimeReplay): void {
  if (
    !Number.isSafeInteger(replay.expiry) ||
    !Number.isSafeInteger(replay.nowSec) ||
    replay.expiry < 0 ||
    replay.nowSec < 0
  ) {
    throw new Error("Runtime replay times must be non-negative integer epoch seconds.");
  }
}

/**
 * Single-use nonce store — the replay guard for owner actions.
 *
 * A nonce is CONSUMED exactly once. `consume` is an atomic "insert if absent":
 * the first caller for an `(owner, nonce)` pair gets `true`, every later caller
 * gets `false`. That is the whole contract — a `false` means "already used, this
 * is a replay, reject". The store keeps no other state and makes no decisions.
 *
 * Two properties carry the security weight:
 *   - ATOMICITY. Two racing `consume`s for the same pair must resolve to exactly
 *     one `true`. Postgres gets this from `insert ... on conflict do nothing
 *     returning`; the memory impl gets it from a check-and-set with no await in
 *     between (single-threaded, so the whole body runs before any other).
 *   - EXPIRY. A consumed nonce only needs to be remembered until its signature
 *     could no longer be valid; `prune` drops rows past `expires_at` so the set
 *     cannot grow without bound.
 *
 * ORDERING (owned by the auth call-site, `authorizeOwnerAction`): the nonce is
 * consumed ONLY after ecrecover, the domain/window checks and the paramsHash
 * recompute have all passed. Consuming earlier would let a flood of forged or
 * stale requests burn a victim's nonces.
 *
 * `expires_at` is epoch MILLISECONDS throughout, matching the agent store's
 * clock convention; the Postgres impl maps it to `timestamptz`.
 */
import { getAddress, type Address } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";

export interface NonceStore {
  /**
   * Atomically claim `(ownerAddress, nonce)`. Returns `true` on first use and
   * `false` if it was already consumed. `expiresAt` is epoch ms.
   */
  consume(ownerAddress: Address, nonce: string, expiresAt: number): Promise<boolean>;
  /** Serialize the complete Trading S1 materialize-or-terminal decision. */
  withProvisionClaimLock<T>(
    ownerAddress: Address,
    nonce: string,
    operation: (claim: ProvisionClaimLease) => Promise<T>,
  ): Promise<T>;
  /** Delete every nonce whose `expiresAt` is before `now` (epoch ms). Returns the count. */
  prune(now: number): Promise<number>;
  close(): Promise<void>;
}

export type ProvisionClaimRecord = {
  readonly actionId: string;
  readonly state: "live" | "committed" | "terminal";
  readonly acceptedAtMs: number | null;
  readonly authorityExpiresAtMs: number;
};

export interface ProvisionClaimLease {
  read(): Promise<{ readonly kind: "absent" | "plain" } | { readonly kind: "provision"; readonly claim: ProvisionClaimRecord }>;
  insert(claim: ProvisionClaimRecord, signal?: AbortSignal): Promise<boolean>;
  transition(actionId: string, from: ProvisionClaimRecord["state"], to: ProvisionClaimRecord["state"]): Promise<boolean>;
}

/** Checksum-validate then lower an owner address for use as a scope key. */
function ownerKey(ownerAddress: Address): string {
  return getAddress(ownerAddress).toLowerCase();
}

/**
 * Separator for the memory store's composite `(owner, nonce)` map key.
 *
 * It has to be a byte that CANNOT occur inside either component, or two distinct
 * pairs could flatten to the same string and one owner's nonce would consume
 * another's. Both components are 0x-prefixed lowercase hex — `owner` from
 * {@link ownerKey}, `nonce` a bytes32 hex string — so the alphabet is exactly
 * `[0-9a-fx]`. `|` is outside it, and unlike the NUL byte this originally used it
 * is printable, which keeps this file text rather than something git and grep
 * treat as binary. Phase 1a made the same change for the same reason.
 */
const COMPOSITE_KEY_SEPARATOR = "|";

function compositeKey(owner: string, nonce: string): string {
  return `${owner}${COMPOSITE_KEY_SEPARATOR}${nonce}`;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Process-local nonce set. `consume` is a check-and-set with NO await between
 * the `has` and the `set`, so under `Promise.all` the first call's body runs to
 * completion before the second begins — exactly one observes the absence.
 */
export class MemoryNonceStore implements NonceStore {
  readonly #used = new Map<string, { expiresAt: number; claim: ProvisionClaimRecord | null }>();
  readonly #locks = new Map<string, Promise<void>>();

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  async consume(
    ownerAddress: Address,
    nonce: string,
    expiresAt: number,
  ): Promise<boolean> {
    const key = compositeKey(ownerKey(ownerAddress), nonce);
    return this.#withLock(key, async () => {
      if (this.#used.has(key)) return false;
      this.#used.set(key, { expiresAt, claim: null });
      return true;
    });
  }

  async withProvisionClaimLock<T>(ownerAddress: Address, nonce: string,
    operation: (claim: ProvisionClaimLease) => Promise<T>): Promise<T> {
    const key = compositeKey(ownerKey(ownerAddress), nonce);
    return this.#withLock(key, async () => operation({
      read: async () => {
        const stored = this.#used.get(key);
        if (stored === undefined) return { kind: "absent" as const };
        return stored.claim === null
          ? { kind: "plain" as const }
          : { kind: "provision" as const, claim: stored.claim };
      },
      insert: async (claim, signal) => {
        signal?.throwIfAborted();
        if (this.#used.has(key)) return false;
        this.#used.set(key, { expiresAt: claim.authorityExpiresAtMs, claim });
        return true;
      },
      transition: async (actionId, from, to) => {
        const stored = this.#used.get(key);
        if (stored?.claim === null || stored?.claim === undefined
          || stored.claim.actionId.toLowerCase() !== actionId.toLowerCase()
          || stored.claim.state !== from) return false;
        stored.claim = { ...stored.claim, state: to };
        return true;
      },
    }));
  }

  async prune(now: number): Promise<number> {
    let removed = 0;
    for (const [key, stored] of this.#used) {
      if (stored.expiresAt < now) {
        this.#used.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    this.#used.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

const NONCES_DDL = `
  create table if not exists owner_auth_nonces (
    owner_address text not null,
    nonce text not null,
    expires_at timestamptz not null,
    action_id text,
    provision_state text,
    accepted_at timestamptz,
    authority_expires_at timestamptz,
    primary key (owner_address, nonce)
  );
  alter table owner_auth_nonces add column if not exists action_id text;
  alter table owner_auth_nonces add column if not exists provision_state text;
  alter table owner_auth_nonces add column if not exists accepted_at timestamptz;
  alter table owner_auth_nonces add column if not exists authority_expires_at timestamptz
`;

export class PostgresNonceStore implements NonceStore {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  static async create(sql: SqlClient): Promise<PostgresNonceStore> {
    await sql.query(NONCES_DDL);
    return new PostgresNonceStore(sql);
  }

  async consume(
    ownerAddress: Address,
    nonce: string,
    expiresAt: number,
  ): Promise<boolean> {
    const owner = ownerKey(ownerAddress);
    return this.#sql.transaction(async (tx) => {
      await tx.query(`/* nonces.lock */ select pg_advisory_xact_lock(hashtext($1))`, [compositeKey(owner, nonce)]);
      const result = await tx.query<{ nonce: string }>(
        `/* nonces.consume */
         insert into owner_auth_nonces (owner_address, nonce, expires_at)
         values ($1, $2, $3)
         on conflict (owner_address, nonce) do nothing
         returning nonce`,
        [owner, nonce, new Date(expiresAt)],
      );
      return result.rows.length > 0;
    });
  }

  async withProvisionClaimLock<T>(ownerAddress: Address, nonce: string,
    operation: (claim: ProvisionClaimLease) => Promise<T>): Promise<T> {
    const owner = ownerKey(ownerAddress);
    const outcome = await this.#sql.transaction(async (tx) => {
      await tx.query(`/* nonces.lock */ select pg_advisory_xact_lock(hashtext($1))`, [compositeKey(owner, nonce)]);
      const lease: ProvisionClaimLease = {
        read: async () => {
          const result = await tx.query<{
            action_id: string | null; provision_state: string | null; accepted_at: Date | string | null;
            authority_expires_at: Date | string | null;
          }>(`/* nonces.provisionRead */
              select action_id, provision_state, accepted_at, authority_expires_at
              from owner_auth_nonces where owner_address = $1 and nonce = $2`, [owner, nonce]);
          const row = result.rows[0];
          if (row === undefined) return { kind: "absent" as const };
          if (row.action_id === null || row.provision_state === null || row.authority_expires_at === null) {
            return { kind: "plain" as const };
          }
          if (row.provision_state !== "live" && row.provision_state !== "committed" && row.provision_state !== "terminal") {
            return { kind: "plain" as const };
          }
          return { kind: "provision" as const, claim: {
            actionId: row.action_id,
            state: row.provision_state,
            acceptedAtMs: row.accepted_at === null ? null : new Date(row.accepted_at).getTime(),
            authorityExpiresAtMs: new Date(row.authority_expires_at).getTime(),
          } };
        },
        insert: async (claim, signal) => {
          signal?.throwIfAborted();
          const result = await tx.query<{ nonce: string }>(`/* nonces.provisionInsert */
            insert into owner_auth_nonces
              (owner_address, nonce, expires_at, action_id, provision_state, accepted_at, authority_expires_at)
            values ($1, $2, $3, $4, $5, $6, $3)
            on conflict (owner_address, nonce) do nothing returning nonce`,
          [owner, nonce, new Date(claim.authorityExpiresAtMs), claim.actionId, claim.state,
            claim.acceptedAtMs === null ? null : new Date(claim.acceptedAtMs)],
          { ...(signal === undefined ? {} : { signal }), timeoutMs: 5_000 });
          return result.rows.length > 0;
        },
        transition: async (actionId, from, to) => {
          const result = await tx.query<{ nonce: string }>(`/* nonces.provisionTransition */
            update owner_auth_nonces set provision_state = $3
            where owner_address = $1 and nonce = $2 and lower(action_id) = lower($4)
              and provision_state = $5 returning nonce`, [owner, nonce, to, actionId, from]);
          return result.rows.length > 0;
        },
      };
      try {
        return { ok: true as const, value: await operation(lease) };
      } catch (error) {
        // Commit a claim/tombstone already written inside the critical section;
        // a materialization failure must remain discoverable on retry.
        return { ok: false as const, error };
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async prune(now: number): Promise<number> {
    const result = await this.#sql.query<{ nonce: string }>(
      `/* nonces.prune */
       delete from owner_auth_nonces where expires_at < $1 returning nonce`,
      [new Date(now)],
    );
    return result.rows.length;
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable nonce store when `DATABASE_URL` is set, otherwise the
 * in-memory one. The connection string is never logged.
 */
export async function createNonceStore(): Promise<NonceStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresNonceStore.create(sql);
    console.log("[nonce-store] backend=postgres");
    return store;
  }
  console.log("[nonce-store] backend=memory (DATABASE_URL not set)");
  return new MemoryNonceStore();
}

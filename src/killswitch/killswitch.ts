/**
 * The kill switch: per-agent pause/unpause and a global halt/resume.
 *
 * INVARIANT (verbatim, load-bearing): pause and halt are SERVER-REFUSAL ONLY.
 * They make THIS server decline to submit; they place no transaction on-chain
 * and touch no key. They are a liveness control, real only while we are the sole
 * executor of an agent's session. They CANNOT bind a leaked key: an attacker who
 * holds the session key is not asking our server for permission, so pausing here
 * does nothing to them. The durable, adversary-proof stop is owner revocation of
 * the on-chain session (see `WalletProvider.ownerRevokeSession`); the kill
 * switch is the fast, local, reversible liveness lever that sits in front of it.
 *
 * Semantics:
 *   - GLOBAL HALT overrides everything, including a per-agent unpause. While
 *     halted, `isBlocked` is true for every agent regardless of its pause state.
 *   - PER-AGENT PAUSE is owner-scoped: a pause records the owner that set it, and
 *     only that owner can clear it. One owner can never pause or unpause another
 *     owner's agent.
 *   - Both states are PERSISTED, so a restart does not silently resume a halted
 *     system or a paused agent.
 *
 * DESIGN — two tables, not one. `agent_pause` is a per-agent row set; `global_halt`
 * is a single-row singleton (a `check (id = 'global')` primary key enforces that
 * there is at most one). Keeping them separate makes `isBlocked` a clean union of
 * two independent questions and keeps the global switch from being modelled as a
 * magic agent id. The cost — two reads in `isBlocked` — is trivial for a control
 * that is consulted once per execute.
 */
import { getAddress, type Address } from "viem";
import { createPgSqlClient, type SqlClient } from "../store/sql.js";

/** Injectable clock; defaults to `Date.now`. Epoch ms. */
export type Clock = () => number;

const MAX_REASON_CHARS = 300;

export interface KillSwitch {
  /** Pause one agent. Records `ownerAddress` as the only party that can unpause. */
  pauseAgent(agentId: string, ownerAddress: Address): Promise<void>;
  /** Clear a pause. No-op unless `ownerAddress` matches the pause's owner. */
  unpauseAgent(agentId: string, ownerAddress: Address): Promise<void>;
  /** Whether `agentId` is paused by `ownerAddress`. */
  isAgentPaused(agentId: string, ownerAddress: Address): Promise<boolean>;
  /** Engage the global halt. `reason` is stored (truncated) for operators. */
  halt(reason?: string): Promise<void>;
  /** Lift the global halt. */
  resume(): Promise<void>;
  /** Whether the global halt is engaged. */
  isHalted(): Promise<boolean>;
  /** True when the global halt is on OR `agentId` is paused by `ownerAddress`. */
  isBlocked(agentId: string, ownerAddress: Address): Promise<boolean>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): string {
  return getAddress(ownerAddress).toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

type PauseRecord = { readonly ownerAddress: string; readonly pausedAt: number };

/**
 * Process-local kill switch for dev and tests. State is lost on restart, by
 * design — the Postgres impl is what survives one. (The persistence test drives
 * the Postgres impl over a shared fake client, which is where "a fresh instance
 * over the same store" is meaningful.)
 */
export class MemoryKillSwitch implements KillSwitch {
  readonly #paused = new Map<string, PauseRecord>();
  #halt: { readonly reason: string | null; readonly haltedAt: number } | null = null;
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async pauseAgent(agentId: string, ownerAddress: Address): Promise<void> {
    this.#paused.set(agentId, {
      ownerAddress: ownerKey(ownerAddress),
      pausedAt: this.#now(),
    });
  }

  async unpauseAgent(agentId: string, ownerAddress: Address): Promise<void> {
    const existing = this.#paused.get(agentId);
    if (existing !== undefined && existing.ownerAddress === ownerKey(ownerAddress)) {
      this.#paused.delete(agentId);
    }
  }

  async isAgentPaused(agentId: string, ownerAddress: Address): Promise<boolean> {
    const existing = this.#paused.get(agentId);
    return existing !== undefined && existing.ownerAddress === ownerKey(ownerAddress);
  }

  async halt(reason?: string): Promise<void> {
    this.#halt = {
      reason: reason === undefined ? null : reason.slice(0, MAX_REASON_CHARS),
      haltedAt: this.#now(),
    };
  }

  async resume(): Promise<void> {
    this.#halt = null;
  }

  async isHalted(): Promise<boolean> {
    return this.#halt !== null;
  }

  async isBlocked(agentId: string, ownerAddress: Address): Promise<boolean> {
    if (this.#halt !== null) return true;
    return this.isAgentPaused(agentId, ownerAddress);
  }

  async close(): Promise<void> {
    this.#paused.clear();
    this.#halt = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

const AGENT_PAUSE_DDL = `
  create table if not exists agent_pause (
    agent_id text primary key,
    owner_address text not null,
    paused_at timestamptz not null default now()
  )
`;

const GLOBAL_HALT_DDL = `
  create table if not exists global_halt (
    id text primary key check (id = 'global'),
    halted_at timestamptz not null default now(),
    reason text
  )
`;

type PauseRow = { owner_address: string };
type HaltRow = { id: string };

export class PostgresKillSwitch implements KillSwitch {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(sql: SqlClient, now: Clock = Date.now): Promise<PostgresKillSwitch> {
    await sql.query(AGENT_PAUSE_DDL);
    await sql.query(GLOBAL_HALT_DDL);
    return new PostgresKillSwitch(sql, now);
  }

  async pauseAgent(agentId: string, ownerAddress: Address): Promise<void> {
    await this.#sql.query(
      `/* kill.pause */
       insert into agent_pause (agent_id, owner_address, paused_at)
       values ($1, $2, $3)
       on conflict (agent_id) do update set
         owner_address = excluded.owner_address,
         paused_at = excluded.paused_at`,
      [agentId, ownerKey(ownerAddress), new Date(this.#now())],
    );
  }

  async unpauseAgent(agentId: string, ownerAddress: Address): Promise<void> {
    await this.#sql.query(
      `/* kill.unpause */
       delete from agent_pause where agent_id = $1 and owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
  }

  async isAgentPaused(agentId: string, ownerAddress: Address): Promise<boolean> {
    const result = await this.#sql.query<PauseRow>(
      `/* kill.isPaused */
       select owner_address from agent_pause
       where agent_id = $1 and owner_address = $2`,
      [agentId, ownerKey(ownerAddress)],
    );
    return result.rows.length > 0;
  }

  async halt(reason?: string): Promise<void> {
    await this.#sql.query(
      `/* kill.halt */
       insert into global_halt (id, halted_at, reason)
       values ('global', $1, $2)
       on conflict (id) do update set
         halted_at = excluded.halted_at,
         reason = excluded.reason`,
      [new Date(this.#now()), reason === undefined ? null : reason.slice(0, MAX_REASON_CHARS)],
    );
  }

  async resume(): Promise<void> {
    await this.#sql.query(
      `/* kill.resume */
       delete from global_halt where id = 'global'`,
    );
  }

  async isHalted(): Promise<boolean> {
    const result = await this.#sql.query<HaltRow>(
      `/* kill.isHalted */
       select id from global_halt where id = 'global'`,
    );
    return result.rows.length > 0;
  }

  async isBlocked(agentId: string, ownerAddress: Address): Promise<boolean> {
    if (await this.isHalted()) return true;
    return this.isAgentPaused(agentId, ownerAddress);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable kill switch when `DATABASE_URL` is set, otherwise the
 * in-memory one. The connection string is never logged.
 */
export async function createKillSwitch(): Promise<KillSwitch> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const killswitch = await PostgresKillSwitch.create(sql);
    console.log("[kill-switch] backend=postgres");
    return killswitch;
  }
  console.log("[kill-switch] backend=memory (DATABASE_URL not set)");
  return new MemoryKillSwitch();
}

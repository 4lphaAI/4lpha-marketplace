/**
 * The Venus action ledger — the charged-row store (PHASE4-SPEC D4, R2.9,
 * R3.4, R3.5).
 *
 * ─── THE ASYMMETRY, ADOPTED VERBATIM FROM `lpSequences.ts:1162-1178` ───────
 *
 * **Every action writes its accounting row. Only the RATE-LIMITED kinds can be
 * refused on the count.**
 *
 *   - RESCUES (`venusRepay`, `venusSupply`) are COUNTED and NEVER REFUSED.
 *     `maxActionsPerDay` gating a rescue is the trapped-exit family with a
 *     different door, and the LP plane already decided it the other way for the
 *     protect. What governs a rescue is `minSecondsBetweenActions` (anti-flap)
 *     and the hysteresis counter, and nothing else.
 *   - CLAIMS (`venusClaim`, `venusClaimRepayLeg`) are counted AND refused past
 *     `maxClaimsPerDay`. A claim is a cost, not a rescue.
 *
 * Counting the rescues is not bookkeeping for its own sake: the count NARROWS
 * what the claim gate may still authorize, because six rescues today drew six
 * relay reimbursements out of the same on-chain native meter the claim reserve
 * is sized against. A day of six rescues must leave the claim gate KNOWING the
 * meter is six submissions lighter — that is the half R2.9 cited and stopped
 * one paragraph short of.
 *
 * ─── ROWS ARE NEVER RELEASED (R3.5) ────────────────────────────────────────
 *
 * `lpSequences.ts:1177-1179`: "Reservations are never released in v1 (a
 * rolled-back sequence still consumed its slot — conservative, and simpler than
 * 0G's release path)." The same rule holds here, and R3.5 makes one case
 * explicit: a `no-effect` claim **submitted**, CONFIRMED, and drew relay gas —
 * which is the very thing the quota proxies. Refunding it would let a
 * repeatedly-failing claim path burn the meter without bound, one refund per
 * cycle. The protection against paying for a paused market is the PRE-SUBMIT
 * `actionPaused` check (R2.8), which prevents the submission rather than
 * un-charging it.
 */
import { getAddress, type Address } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import type { VenusActionKind } from "../venus/types.js";
import { isVenusRescue } from "../venus/types.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

/** 24 hours, the rolling window every count is taken over. */
export const VENUS_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Thrown when a CLAIM is over `maxClaimsPerDay`. Never thrown for a rescue. */
export class VenusClaimQuotaError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(
      `Venus claim quota exhausted: ${used} claim(s) in the last 24h against a limit of ${limit}. ` +
        `Rescues are unaffected — they are counted but never refused.`,
    );
    this.name = "VenusClaimQuotaError";
  }
}

export type VenusActionRecord = {
  readonly actionId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly kind: VenusActionKind;
  readonly chargedAtMs: number;
};

/** What the claim gate and the meter reserve read. */
export type VenusActionUsage = {
  readonly rescues: number;
  readonly claims: number;
  /** Every charged row in the window — what the meter reserve narrows on. */
  readonly submissions: number;
  /** `null` when no rescue has been charged in the window. */
  readonly lastRescueAtMs: number | null;
  readonly lastClaimAtMs: number | null;
};

export type ChargeVenusActionInput = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  /** Idempotency key. A second charge under the same id is a no-op. */
  readonly actionId: string;
  readonly kind: VenusActionKind;
  /** `maxClaimsPerDay`. Ignored entirely for rescue kinds. */
  readonly maxClaimsPerDay: number;
};

export interface VenusActionStore {
  /**
   * Write the accounting row, refusing ONLY a claim over quota.
   *
   * Idempotent by `actionId`: a retry returns the first row unchanged and
   * never re-checks the quota, because the submission it stands for already
   * happened.
   */
  charge(input: ChargeVenusActionInput): Promise<VenusActionRecord>;
  usageSince(
    ownerAddress: Address,
    agentId: string,
    sinceMs: number,
  ): Promise<VenusActionUsage>;
  close(): Promise<void>;
}

function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

function summarize(rows: readonly VenusActionRecord[]): VenusActionUsage {
  let rescues = 0;
  let claims = 0;
  let lastRescueAtMs: number | null = null;
  let lastClaimAtMs: number | null = null;
  for (const row of rows) {
    if (isVenusRescue(row.kind)) {
      rescues += 1;
      if (lastRescueAtMs === null || row.chargedAtMs > lastRescueAtMs) {
        lastRescueAtMs = row.chargedAtMs;
      }
    } else {
      claims += 1;
      if (lastClaimAtMs === null || row.chargedAtMs > lastClaimAtMs) {
        lastClaimAtMs = row.chargedAtMs;
      }
    }
  }
  return {
    rescues,
    claims,
    submissions: rows.length,
    lastRescueAtMs,
    lastClaimAtMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

export class MemoryVenusActionStore implements VenusActionStore {
  readonly #rows = new Map<string, VenusActionRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async charge(input: ChargeVenusActionInput): Promise<VenusActionRecord> {
    const existing = this.#rows.get(input.actionId);
    if (existing !== undefined) {
      if (existing.ownerAddress !== ownerKey(input.ownerAddress)) {
        throw new Error(
          `Venus action "${input.actionId}" belongs to another owner.`,
        );
      }
      return structuredClone(existing);
    }
    const now = this.#now();
    if (!isVenusRescue(input.kind)) {
      const usage = await this.usageSince(
        input.ownerAddress,
        input.agentId,
        now - VENUS_QUOTA_WINDOW_MS,
      );
      if (usage.claims >= input.maxClaimsPerDay) {
        throw new VenusClaimQuotaError(usage.claims, input.maxClaimsPerDay);
      }
    }
    const record: VenusActionRecord = {
      actionId: input.actionId,
      agentId: input.agentId,
      ownerAddress: ownerKey(input.ownerAddress),
      kind: input.kind,
      chargedAtMs: now,
    };
    this.#rows.set(input.actionId, structuredClone(record));
    return structuredClone(record);
  }

  async usageSince(
    ownerAddress: Address,
    agentId: string,
    sinceMs: number,
  ): Promise<VenusActionUsage> {
    const owner = ownerKey(ownerAddress);
    return summarize(
      [...this.#rows.values()].filter(
        (row) =>
          row.agentId === agentId
          && row.ownerAddress === owner
          && row.chargedAtMs >= sinceMs,
      ),
    );
  }

  async close(): Promise<void> {
    this.#rows.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type ActionRow = {
  action_id: string;
  agent_id: string;
  owner_address: string;
  kind: string;
  charged_at_ms: string | number;
};

const ACTION_COLUMNS = "action_id, agent_id, owner_address, kind, charged_at_ms";

const VENUS_ACTIONS_DDL = `
  create table if not exists venus_actions (
    action_id text primary key,
    agent_id text not null,
    owner_address text not null,
    kind text not null,
    charged_at_ms bigint not null
  )
`;

const VENUS_ACTIONS_WINDOW_INDEX_DDL = `
  create index if not exists venus_actions_window_idx
    on venus_actions (owner_address, agent_id, charged_at_ms)
`;

function rowToRecord(row: ActionRow): VenusActionRecord {
  return {
    actionId: row.action_id,
    agentId: row.agent_id,
    ownerAddress: ownerKey(getAddress(row.owner_address)),
    kind: row.kind as VenusActionKind,
    chargedAtMs: Number(row.charged_at_ms),
  };
}

export class PostgresVenusActionStore implements VenusActionStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresVenusActionStore> {
    await sql.query(VENUS_ACTIONS_DDL);
    await sql.query(VENUS_ACTIONS_WINDOW_INDEX_DDL);
    return new PostgresVenusActionStore(sql, now);
  }

  async charge(input: ChargeVenusActionInput): Promise<VenusActionRecord> {
    const existingResult = await this.#sql.query<ActionRow>(
      `/* venusActions.charge.existing */
       select ${ACTION_COLUMNS} from venus_actions where action_id = $1`,
      [input.actionId],
    );
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      const record = rowToRecord(existing);
      if (record.ownerAddress !== ownerKey(input.ownerAddress)) {
        throw new Error(
          `Venus action "${input.actionId}" belongs to another owner.`,
        );
      }
      return record;
    }
    const now = this.#now();
    if (!isVenusRescue(input.kind)) {
      const usage = await this.usageSince(
        input.ownerAddress,
        input.agentId,
        now - VENUS_QUOTA_WINDOW_MS,
      );
      if (usage.claims >= input.maxClaimsPerDay) {
        throw new VenusClaimQuotaError(usage.claims, input.maxClaimsPerDay);
      }
    }
    const inserted = await this.#sql.query<ActionRow>(
      `/* venusActions.charge */
       insert into venus_actions (action_id, agent_id, owner_address, kind, charged_at_ms)
       values ($1, $2, $3, $4, $5)
       on conflict (action_id) do nothing
       returning ${ACTION_COLUMNS}`,
      [input.actionId, input.agentId, ownerKey(input.ownerAddress), input.kind, now],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return rowToRecord(row);
    // The insert lost a race with a concurrent identical charge. Read back what
    // won: the row stands for one submission either way, and charging twice for
    // it would narrow the claim gate on a submission that never happened.
    const reread = await this.#sql.query<ActionRow>(
      `/* venusActions.charge.reread */
       select ${ACTION_COLUMNS} from venus_actions where action_id = $1`,
      [input.actionId],
    );
    const won = reread.rows[0];
    if (won === undefined) {
      throw new Error(`Venus action "${input.actionId}" could not be charged.`);
    }
    return rowToRecord(won);
  }

  async usageSince(
    ownerAddress: Address,
    agentId: string,
    sinceMs: number,
  ): Promise<VenusActionUsage> {
    const result = await this.#sql.query<ActionRow>(
      `/* venusActions.usageSince */
       select ${ACTION_COLUMNS}
       from venus_actions
       where owner_address = $1 and agent_id = $2 and charged_at_ms >= $3
       order by charged_at_ms asc`,
      [ownerKey(ownerAddress), agentId, sinceMs],
    );
    return summarize(result.rows.map(rowToRecord));
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export async function createVenusActionStore(): Promise<VenusActionStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresVenusActionStore.create(sql);
    console.log("[venus-action-store] backend=postgres");
    return store;
  }
  console.log("[venus-action-store] backend=memory (DATABASE_URL not set)");
  return new MemoryVenusActionStore();
}

/**
 * The grid cycle ledger (PHASE3.15 R2.11 / OQ7).
 *
 * ─── WHAT THIS STORE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * It is DERIVED TELEMETRY and it is SAFE TO TRUNCATE, in exactly the sense
 * `src/store/lpObservations.ts` states for its own table. One row per COMPLETED
 * flip, written AFTER the mint's `after` has run and wrapped in the repo's
 * derived-state `try/catch` idiom, so a write failure costs one missing line in
 * a report and never money, never state, and never a held sequence.
 *
 * **Nothing here is ever consulted to decide whether a step ran.** The
 * execution journal is the authority on step outcomes and the sequence store on
 * order and resume; a row in this table is an accounting fact about a sequence
 * both of those already settled. Making it transactional with the sequence
 * update was REJECTED (OQ7): that would put a derived-telemetry write INSIDE the
 * money path, which is the inverse of the discipline this repo enforces
 * everywhere it matters (`worker.ts`: "no store this phase adds may ever sit
 * between a confirmed trigger and its dispatch").
 *
 * THE CONSEQUENCE IS STATED RATHER THAN HIDDEN: a crash between the mint
 * confirming and this write loses one accounting row. So the owner view reports
 * the cycle COUNT from the sequence/journal record and labels realised PnL as
 * "over recorded cycles" — it never presents this table as complete.
 *
 * ─── IDEMPOTENCE ──────────────────────────────────────────────────────────
 *
 * Keyed on `sequenceId`, insert-or-ignore. A resumed sequence that replays its
 * confirmed steps and completes again writes nothing new, so one flip is one
 * row however many times the driver walks it.
 *
 * ─── OWNER SCOPE ──────────────────────────────────────────────────────────
 *
 * Every method is owner-scoped and a cross-tenant read answers an empty list,
 * indistinguishable from "no rows" — the same posture as every other store in
 * this plane. There is no unscoped method: the saga always holds
 * `agent.ownerAddress` before it records anything.
 */
import { getAddress, type Address } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

/** Which signed range the flip minted INTO. Role names, for the owner's report. */
export type LpGridFlipDirection = "to-buy" | "to-sell";

/**
 * One completed flip. Every amount is a RECORDED FACT from the saga's own
 * confirmed receipts — never a re-read balance, never a mark.
 */
export type LpGridCycleRecord = {
  readonly sequenceId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly positionId: string;
  readonly direction: LpGridFlipDirection;
  /** The range the flip settled OUT of, and the one it minted INTO. */
  readonly fromTickLower: number;
  readonly fromTickUpper: number;
  readonly toTickLower: number;
  readonly toTickUpper: number;
  /** The zap-out's confirmed collect deltas, in POOL ORDER. */
  readonly freedAmount0Wei: bigint;
  readonly freedAmount1Wei: bigint;
  /** What the mint actually deposited, in POOL ORDER (the off-side leg is 0). */
  readonly mintedAmount0Wei: bigint;
  readonly mintedAmount1Wei: bigint;
  /** The leg the single-sided mint DROPPED, and its share of the freed value. */
  readonly residueWei: bigint;
  readonly residueBps: bigint;
  readonly fromTokenId: string;
  readonly toTokenId: string;
  readonly completedAtMs: number;
};

export interface LpGridCycleStore {
  /**
   * Record one completed flip. IDEMPOTENT on `sequenceId`: a second call for
   * the same sequence writes nothing and does not throw.
   */
  record(cycle: LpGridCycleRecord): Promise<void>;
  /** Every recorded cycle for an agent, oldest first. Owner-scoped. */
  list(ownerAddress: Address, agentId: string): Promise<LpGridCycleRecord[]>;
  close(): Promise<void>;
}

/** Checksum-validate then lower an owner address (same key as agents.ts). */
function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

export class MemoryLpGridCycleStore implements LpGridCycleStore {
  readonly #rows = new Map<string, LpGridCycleRecord>();

  async record(cycle: LpGridCycleRecord): Promise<void> {
    if (this.#rows.has(cycle.sequenceId)) return;
    this.#rows.set(cycle.sequenceId, {
      ...cycle,
      ownerAddress: ownerKey(cycle.ownerAddress),
    });
  }

  async list(ownerAddress: Address, agentId: string): Promise<LpGridCycleRecord[]> {
    const owner = ownerKey(ownerAddress);
    return [...this.#rows.values()]
      .filter((row) => row.ownerAddress === owner && row.agentId === agentId)
      .sort((left, right) => left.completedAtMs - right.completedAtMs)
      .map((row) => ({ ...row }));
  }

  async close(): Promise<void> {
    this.#rows.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type GridCycleRow = {
  sequence_id: string;
  agent_id: string;
  owner_address: string;
  position_id: string;
  direction: string;
  from_tick_lower: number;
  from_tick_upper: number;
  to_tick_lower: number;
  to_tick_upper: number;
  freed_amount0_wei: string;
  freed_amount1_wei: string;
  minted_amount0_wei: string;
  minted_amount1_wei: string;
  residue_wei: string;
  residue_bps: string;
  from_token_id: string;
  to_token_id: string;
  completed_at_ms: string | number;
};

const GRID_CYCLE_COLUMNS =
  "sequence_id, agent_id, owner_address, position_id, direction, "
  + "from_tick_lower, from_tick_upper, to_tick_lower, to_tick_upper, "
  + "freed_amount0_wei, freed_amount1_wei, minted_amount0_wei, minted_amount1_wei, "
  + "residue_wei, residue_bps, from_token_id, to_token_id, completed_at_ms";

/**
 * A brand-new table, so `create table if not exists` is the whole migration —
 * the `lp_observations` precedent. Amounts are `numeric(78,0)` and cross as
 * decimal STRINGS, never as JS numbers.
 */
const GRID_CYCLES_DDL = `
  create table if not exists grid_cycles (
    sequence_id text primary key,
    agent_id text not null,
    owner_address text not null,
    position_id text not null,
    direction text not null check (direction in ('to-buy', 'to-sell')),
    from_tick_lower int not null,
    from_tick_upper int not null,
    to_tick_lower int not null,
    to_tick_upper int not null,
    freed_amount0_wei numeric(78,0) not null,
    freed_amount1_wei numeric(78,0) not null,
    minted_amount0_wei numeric(78,0) not null,
    minted_amount1_wei numeric(78,0) not null,
    residue_wei numeric(78,0) not null,
    residue_bps numeric(78,0) not null,
    from_token_id text not null,
    to_token_id text not null,
    completed_at_ms bigint not null
  )
`;

const GRID_CYCLES_OWNER_INDEX_DDL = `
  create index if not exists grid_cycles_owner_idx
    on grid_cycles (owner_address, agent_id, completed_at_ms)
`;

function toBig(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === "number" ? BigInt(value) : BigInt(value);
}

function rowToCycle(row: GridCycleRow): LpGridCycleRecord {
  return {
    sequenceId: row.sequence_id,
    agentId: row.agent_id,
    ownerAddress: ownerKey(getAddress(row.owner_address)),
    positionId: row.position_id,
    direction: row.direction === "to-buy" ? "to-buy" : "to-sell",
    fromTickLower: Number(row.from_tick_lower),
    fromTickUpper: Number(row.from_tick_upper),
    toTickLower: Number(row.to_tick_lower),
    toTickUpper: Number(row.to_tick_upper),
    freedAmount0Wei: toBig(row.freed_amount0_wei),
    freedAmount1Wei: toBig(row.freed_amount1_wei),
    mintedAmount0Wei: toBig(row.minted_amount0_wei),
    mintedAmount1Wei: toBig(row.minted_amount1_wei),
    residueWei: toBig(row.residue_wei),
    residueBps: toBig(row.residue_bps),
    fromTokenId: row.from_token_id,
    toTokenId: row.to_token_id,
    completedAtMs: Number(row.completed_at_ms),
  };
}

export class PostgresLpGridCycleStore implements LpGridCycleStore {
  readonly #sql: SqlClient;

  private constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  static async create(sql: SqlClient): Promise<PostgresLpGridCycleStore> {
    await sql.query(GRID_CYCLES_DDL);
    await sql.query(GRID_CYCLES_OWNER_INDEX_DDL);
    return new PostgresLpGridCycleStore(sql);
  }

  async record(cycle: LpGridCycleRecord): Promise<void> {
    await this.#sql.query(
      `/* gridCycles.insert */
       insert into grid_cycles (${GRID_CYCLE_COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric,
               $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16, $17, $18)
       on conflict (sequence_id) do nothing`,
      [
        cycle.sequenceId,
        cycle.agentId,
        ownerKey(cycle.ownerAddress),
        cycle.positionId,
        cycle.direction,
        cycle.fromTickLower,
        cycle.fromTickUpper,
        cycle.toTickLower,
        cycle.toTickUpper,
        cycle.freedAmount0Wei.toString(10),
        cycle.freedAmount1Wei.toString(10),
        cycle.mintedAmount0Wei.toString(10),
        cycle.mintedAmount1Wei.toString(10),
        cycle.residueWei.toString(10),
        cycle.residueBps.toString(10),
        cycle.fromTokenId,
        cycle.toTokenId,
        cycle.completedAtMs,
      ],
    );
  }

  async list(ownerAddress: Address, agentId: string): Promise<LpGridCycleRecord[]> {
    const result = await this.#sql.query<GridCycleRow>(
      `/* gridCycles.list */
       select ${GRID_CYCLE_COLUMNS}
       from grid_cycles
       where owner_address = $1 and agent_id = $2
       order by completed_at_ms asc, sequence_id asc`,
      [ownerKey(ownerAddress), agentId],
    );
    return result.rows.map(rowToCycle);
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Durable when `DATABASE_URL` is set, in-memory otherwise. A memory backend is
 * honest here in a way it is not for the observation store: this table is
 * derived telemetry with no safety property to prove, so losing it with the
 * process costs a report and nothing else.
 */
export async function createLpGridCycleStore(): Promise<LpGridCycleStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresLpGridCycleStore.create(sql);
    console.log("[grid-cycle-store] backend=postgres");
    return store;
  }
  console.log("[grid-cycle-store] backend=memory (DATABASE_URL not set)");
  return new MemoryLpGridCycleStore();
}

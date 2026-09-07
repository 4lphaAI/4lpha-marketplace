/**
 * The LP trigger observation store (PHASE3.2 Revision 2 items 13–17).
 *
 * ONE row per position, holding the LAST {@link LpTriggerObservation} the
 * worker computed for it. It exists because the
 * 2-consecutive-finalized-observations rule that gates every protect and every
 * rotate used to live in a `Map` in worker-process memory: `--once` never
 * filled it and a restart emptied it, so a breached stop-loss could be detected
 * forever and confirmed never (FINDINGS (ae)).
 *
 * ─── WHAT THIS STORE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * It is DERIVED TELEMETRY and it is SAFE TO TRUNCATE. Losing a row (or the
 * whole table) costs exactly one extra confirmation cycle before a trigger can
 * fire; it can never produce a WRONG decision. That property is why this is its
 * own module rather than another section of `lpSequences.ts`: that store owns
 * sequence ORDER and RESUME and states in its own header that it never records
 * outcomes, and audit A1's rule — a missing journal row means the step is
 * RETRYABLE — must keep exactly one authority. **Nothing here is ever consulted
 * to decide whether a step ran.** `deriveLpSequenceProgress` and its
 * caller-side missing-row pre-filter remain the only authority on that.
 *
 * ─── OWNER SCOPE: NO WORKER CARVE-OUT ──────────────────────────────────────
 *
 * Every method is owner-scoped and a cross-tenant read answers `null`,
 * indistinguishable from "no such row". Unlike
 * `listOpenPositionsForWorker`, there is no unnameable scope here: the worker
 * always holds `position.ownerAddress` before it touches an observation, so
 * this store exposes NO unscoped method (Rev2 item 15).
 *
 * ─── WHY jsonb AND NOT TYPED NUMERIC COLUMNS ───────────────────────────────
 *
 * The observation rides in a jsonb column through the EXISTING
 * `encodeJsonbParam`/`decodeJsonb` codec, which round-trips `bigint` exactly
 * (`{"$bigint":"…"}`). A `numeric(78,0)` `block_number` column read through a
 * copy of `toWei` would turn a SQL NULL into `0n`, and
 * `0n < market.blockNumber` is trivially TRUE — a fail-OPEN comparability, i.e.
 * the one direction this whole phase exists to close (Rev2 item 14).
 * `evaluated_at_ms` is duplicated as a real column ONLY for the read side and
 * the retention sweep; the authority is the jsonb.
 *
 * A structurally invalid decoded row answers `null` rather than throwing: it is
 * derived state, so "safe to truncate" must hold for one corrupt row too.
 *
 * ─── OPERATIONAL INVARIANT: EXACTLY ONE LP WORKER PER DATABASE ─────────────
 *
 * Nothing in this repo prevents two worker processes from running against one
 * database. The one-non-terminal-sequence-per-position unique index bounds the
 * damage to at most one saga per position, but two workers would race this
 * table's upsert and each could read a stale previous observation — which
 * costs a confirmation cycle, not a wrong decision. v1 STATES the invariant; it
 * does not add a lock (Rev2 item 40).
 *
 * ─── WHAT STILL LIVES ONLY IN PROCESS MEMORY (Rev2 item 39) ────────────────
 *
 * After this store lands: **no automation state that GATES A MONEY DECISION
 * lives only in process memory.** The `ExecuteThrottle` / `TokenBucketLimiter`
 * (`src/http/limits.ts`) remains process-local, DELIBERATELY, with its own
 * written rationale — it is a rate bound on a ceiling the CHAIN enforces, so
 * losing it widens a bound that is already backstopped rather than removing a
 * safety rule. The scan-gate TTL cache loses a verdict and re-reads. Neither is
 * this class. Do not upgrade that sentence into "the plane holds none".
 */
import { parseLpFeesTelemetry, reviveLpFeesTelemetry } from "../lp/feeTelemetry.js";

import { getAddress, isAddress, type Address } from "viem";
import { MAX_TICK, MIN_TICK } from "../lp/tickMath.js";
import type { LpTriggerObservation } from "../lp/triggers.js";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";

/** Injectable clock; defaults to `Date.now`. */
export type Clock = () => number;

export type PutLpObservationInput = {
  readonly ownerAddress: Address;
  readonly agentId: string;
  readonly positionId: string;
  readonly observation: LpTriggerObservation;
};

export interface LpObservationStore {
  /**
   * The position's last observation, or `null` when absent, owned by someone
   * else, or structurally unreadable. All three are the same answer on
   * purpose: the caller treats every one as "no previous observation", which
   * costs one confirmation cycle and never skips a position.
   */
  get(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    signal?: AbortSignal,
  ): Promise<LpTriggerObservation | null>;
  /**
   * Record (or replace) the position's observation. Owner-scoped: a put
   * against a row another owner holds THROWS rather than overwriting — reaching
   * that error means a bug upstream, not a request to honour.
   */
  put(input: PutLpObservationInput): Promise<void>;
  /**
   * Drop the row. Called when a position reaches `closed`, so the table does
   * not accumulate one dead row per closed lineage for ever (Rev2 item 12).
   * Deleting is always safe by this store's own truncate property.
   */
  delete(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Checksum-validate then lower an owner address (same key as agents.ts). */
function ownerKey(ownerAddress: Address): Address {
  return `0x${getAddress(ownerAddress).slice(2).toLowerCase()}`;
}

/* -------------------------------------------------------------------------- */
/* Structural validation                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuild an {@link LpTriggerObservation} from a decoded row, field by field,
 * or answer `null`.
 *
 * Rebuilding rather than casting is what makes the OPTIONAL fields survive:
 * `previousObservation?.protectBreach === protectBreach` distinguishes an
 * ABSENT `protectBreach` from a present one, so an absent field must come back
 * ABSENT — never as an `undefined`-valued key, and never defaulted.
 */
export function parseLpTriggerObservation(
  value: unknown,
): LpTriggerObservation | null {
  if (!isRecord(value)) return null;
  const {
    blockNumber,
    currentTick,
    tickLower,
    tickUpper,
    evaluatedAtMs,
    poolAddress,
    protectBreach,
    protectBreachClass,
    settingsDigest,
    protectConsecutive,
    rotationBreach,
    rotationBreachStartedAtMs,
    rotationConsecutive,
    gridCrossConsecutive,
    gridCrossSide,
    gridDriftConsecutive,
    gridDriftSide,
    gridRangeRelation,
    gridMismatchSinceMs,
    tokenId,
    valuation,
  } = value;
  if (typeof blockNumber !== "bigint" || blockNumber < 0n) return null;
  if (!Number.isFinite(evaluatedAtMs) || typeof evaluatedAtMs !== "number") {
    return null;
  }
  if (evaluatedAtMs < 0) return null;
  if (typeof poolAddress !== "string" || !isAddress(poolAddress, { strict: false })) {
    return null;
  }
  // PHASE3.6 Rev2 M3. This closed set is the one most likely to be got wrong:
  // an unrecognised value returns `null`, `null` means "no previous
  // observation", and that RESETS the confirmation count. Widen it in the same
  // change as the evaluator or a price breach writes a row the next cycle
  // cannot read, the count restarts every cycle, and the price stop-loss can
  // NEVER reach two consecutive confirmations — FINDINGS (ae), in a brand-new
  // trigger. (Rolling BACK is safe in the same mechanism's fail-safe
  // direction: one extra confirmation cycle, never a wrong dispatch.)
  if (
    protectBreach !== undefined
    && protectBreach !== "stop-loss"
    && protectBreach !== "take-profit"
    && protectBreach !== "price-stop-loss"
    && protectBreach !== "price-take-profit"
  ) {
    return null;
  }
  if (
    protectBreachClass !== undefined
    && protectBreachClass !== "stop"
    && protectBreachClass !== "take-profit"
  ) {
    return null;
  }
  // AUDIT A7. A malformed digest reads as ABSENT rather than rejecting the
  // whole row: absent already means "not comparable", so the conservative
  // outcome is reached without discarding an otherwise-valid observation.
  const digest =
    typeof settingsDigest === "string" && /^0x[0-9a-fA-F]{64}$/u.test(settingsDigest)
      ? settingsDigest
      : undefined;
  // Optional, so a pre-PHASE3.6 row parses; validated when present because the
  // read surface reports a tick DISTANCE from it (Rev2 M1).
  if (
    currentTick !== undefined
    && (!Number.isInteger(currentTick)
      || (currentTick as number) < MIN_TICK
      || (currentTick as number) > MAX_TICK)
  ) {
    return null;
  }
  if (
    tickLower !== undefined
    && (!Number.isInteger(tickLower)
      || (tickLower as number) < MIN_TICK
      || (tickLower as number) > MAX_TICK)
  ) {
    return null;
  }
  if (
    tickUpper !== undefined
    && (!Number.isInteger(tickUpper)
      || (tickUpper as number) < MIN_TICK
      || (tickUpper as number) > MAX_TICK)
  ) {
    return null;
  }
  if (
    tickLower !== undefined
    && tickUpper !== undefined
    && (tickLower as number) >= (tickUpper as number)
  ) {
    return null;
  }
  if (!Number.isInteger(protectConsecutive) || (protectConsecutive as number) < 0) {
    return null;
  }
  if (typeof rotationBreach !== "boolean") return null;
  if (
    rotationBreachStartedAtMs !== undefined
    && (typeof rotationBreachStartedAtMs !== "number"
      || !Number.isFinite(rotationBreachStartedAtMs)
      || rotationBreachStartedAtMs < 0)
  ) {
    return null;
  }
  if (!Number.isInteger(rotationConsecutive) || (rotationConsecutive as number) < 0) {
    return null;
  }
  // PHASE3.15 M1, and it lands in the SAME change as the two fields on
  // `LpTriggerObservation` — the (ae) trap this function's own comment above
  // warns about, one trigger further on. A `gridCrossConsecutive` written into
  // the jsonb but not rebuilt here is silently DROPPED on read, so the count
  // restarts every cycle and a grid fill can NEVER reach two consecutive
  // confirmations: the agent's core loop, dead, with nothing to see.
  if (
    gridCrossConsecutive !== undefined
    && (!Number.isInteger(gridCrossConsecutive) || (gridCrossConsecutive as number) < 0)
  ) {
    return null;
  }
  // The CLOSED SET, in POOL ORDER. Unrecognised ⇒ `null` for the WHOLE
  // observation, which reads as "no previous observation" and restarts the
  // count — the fail-safe direction, and note that the reset is
  // observation-WIDE rather than field-local.
  if (
    gridCrossSide !== undefined
    && gridCrossSide !== "above"
    && gridCrossSide !== "below"
  ) {
    return null;
  }
  // PHASE3.18 R2.8, and it lands in the SAME change as the two fields on
  // `LpTriggerObservation` — the (ae) trap, a THIRD trigger on. A
  // `gridDriftConsecutive` written into the jsonb but not rebuilt here is
  // silently dropped on read, so the drift count restarts every cycle and a
  // policy-mode grid can NEVER re-centre: the whole of Phase 3.18, dead, with
  // nothing to see but a hold reason that looks patient.
  if (
    gridDriftConsecutive !== undefined
    && (!Number.isInteger(gridDriftConsecutive) || (gridDriftConsecutive as number) < 0)
  ) {
    return null;
  }
  // The CLOSED SET, in POOL ORDER, exactly as `gridCrossSide` above: an
  // unrecognised value rejects the WHOLE observation, which reads as "no
  // previous observation" and restarts every count — the fail-safe direction.
  if (
    gridDriftSide !== undefined
    && gridDriftSide !== "above"
    && gridDriftSide !== "below"
  ) {
    return null;
  }
  // PHASE3.23 R3.6: closed-set JSONB evidence. Absence is legacy/unknown;
  // malformed presence rejects the observation-wide parser fail-closed.
  if (
    gridRangeRelation !== undefined
    && gridRangeRelation !== "inside"
    && gridRangeRelation !== "outside"
  ) {
    return null;
  }
  // PHASE3.20 items 12/13 — THE STRANDING CLOCK, and R4.4/B4 is the whole of
  // this validator: it is the LOOSEST sound shape, byte-for-byte
  // `rotationBreachStartedAtMs`'s above (a finite number >= 0), and NOT the
  // integer / closed-set shape the two grid counters beside it carry.
  //
  // WHY THE LOOSENESS IS LOAD-BEARING rather than sloppy: this codec is
  // fail-closed OBSERVATION-WIDE — any field it rejects returns `null` for the
  // whole row, `null` reads as "no previous observation", and the stranding
  // clock therefore RESTARTS. That is the fail-safe direction for an anti-wick
  // counter and the UNSAFE direction for a liveness clock, in exactly the
  // long-running case the bound exists for. A stricter validator here silently
  // defeats the bound, so it is pinned by a mutation.
  if (
    gridMismatchSinceMs !== undefined
    && (typeof gridMismatchSinceMs !== "number"
      || !Number.isFinite(gridMismatchSinceMs)
      || gridMismatchSinceMs < 0)
  ) {
    return null;
  }
  if (typeof tokenId !== "string" || !/^\d+$/u.test(tokenId)) return null;
  let parsedValuation: LpTriggerObservation["valuation"];
  if (valuation !== undefined) {
    if (!isRecord(valuation)) return null;
    const keys = Object.keys(valuation).sort().join(",");
    if (keys !== "blockNumber,exitValueWei,method,positionRowVersion,quoteToken,tokenId,valuedAtMs") return null;
    if (valuation["method"] !== "sellable-exit-v1"
      || typeof valuation["exitValueWei"] !== "bigint" || valuation["exitValueWei"] < 0n
      || typeof valuation["quoteToken"] !== "string" || !isAddress(valuation["quoteToken"], { strict: false })
      || typeof valuation["tokenId"] !== "string" || !/^\d+$/u.test(valuation["tokenId"])
      || !Number.isInteger(valuation["positionRowVersion"]) || (valuation["positionRowVersion"] as number) < 0
      || typeof valuation["blockNumber"] !== "bigint" || valuation["blockNumber"] < 0n
      || typeof valuation["valuedAtMs"] !== "number" || !Number.isFinite(valuation["valuedAtMs"]) || valuation["valuedAtMs"] < 0) {
      return null;
    }
    parsedValuation = {
      method: "sellable-exit-v1",
      exitValueWei: valuation["exitValueWei"],
      quoteToken: getAddress(valuation["quoteToken"]),
      tokenId: valuation["tokenId"],
      positionRowVersion: valuation["positionRowVersion"] as number,
      blockNumber: valuation["blockNumber"],
      valuedAtMs: valuation["valuedAtMs"],
    };
  }
  const fees = parseLpFeesTelemetry(value["fees"]);
  return {
    ...(fees === undefined ? {} : { fees }),
    blockNumber,
    ...(currentTick === undefined ? {} : { currentTick: currentTick as number }),
    ...(tickLower === undefined ? {} : { tickLower: tickLower as number }),
    ...(tickUpper === undefined ? {} : { tickUpper: tickUpper as number }),
    evaluatedAtMs,
    poolAddress: poolAddress as `0x${string}`,
    ...(protectBreach === undefined ? {} : { protectBreach }),
    ...(protectBreachClass === undefined ? {} : { protectBreachClass }),
    ...(digest === undefined ? {} : { settingsDigest: digest }),
    protectConsecutive: protectConsecutive as number,
    rotationBreach,
    ...(rotationBreachStartedAtMs === undefined
      ? {}
      : { rotationBreachStartedAtMs }),
    rotationConsecutive: rotationConsecutive as number,
    ...(gridCrossConsecutive === undefined
      ? {}
      : { gridCrossConsecutive: gridCrossConsecutive as number }),
    ...(gridCrossSide === undefined ? {} : { gridCrossSide }),
    ...(gridDriftConsecutive === undefined
      ? {}
      : { gridDriftConsecutive: gridDriftConsecutive as number }),
    ...(gridDriftSide === undefined ? {} : { gridDriftSide }),
    ...(gridRangeRelation === undefined ? {} : { gridRangeRelation }),
    ...(gridMismatchSinceMs === undefined ? {} : { gridMismatchSinceMs }),
    tokenId,
    ...(parsedValuation === undefined ? {} : { valuation: parsedValuation }),
  };
}

/* -------------------------------------------------------------------------- */
/* Memory implementation                                                      */
/* -------------------------------------------------------------------------- */

type MemoryRow = {
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly observation: LpTriggerObservation;
};

export class MemoryLpObservationStore implements LpObservationStore {
  readonly #rows = new Map<string, MemoryRow>();

  async get(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    signal?: AbortSignal,
  ): Promise<LpTriggerObservation | null> {
    signal?.throwIfAborted();
    const row = this.#rows.get(positionId);
    if (
      row === undefined
      || row.agentId !== agentId
      || row.ownerAddress !== ownerKey(ownerAddress)
    ) {
      return null;
    }
    // Through the same structural gate the Postgres side uses, so both
    // backends refuse the same shapes (F3).
    return parseLpTriggerObservation(structuredClone(row.observation));
  }

  async put(input: PutLpObservationInput): Promise<void> {
    const owner = ownerKey(input.ownerAddress);
    const existing = this.#rows.get(input.positionId);
    if (existing !== undefined && existing.ownerAddress !== owner) {
      throw new Error(
        `LP observation for position "${input.positionId}" belongs to another owner.`,
      );
    }
    this.#rows.set(input.positionId, {
      agentId: input.agentId,
      ownerAddress: owner,
      observation: structuredClone(input.observation),
    });
  }

  async delete(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<void> {
    const row = this.#rows.get(positionId);
    if (
      row === undefined
      || row.agentId !== agentId
      || row.ownerAddress !== ownerKey(ownerAddress)
    ) {
      return;
    }
    this.#rows.delete(positionId);
  }

  async close(): Promise<void> {
    this.#rows.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                    */
/* -------------------------------------------------------------------------- */

type ObservationRow = {
  position_id: string;
  agent_id: string;
  owner_address: string;
  evaluated_at_ms: string | number;
  observation: unknown;
  updated_at: Date;
};

const OBSERVATION_COLUMNS =
  "position_id, agent_id, owner_address, evaluated_at_ms, observation, updated_at";

/**
 * A brand-new table, so `create table if not exists` is the whole migration:
 * PHASE3.1-REVIEW R3's lesson was about ADDING A COLUMN to an existing table
 * (`alter table … add column if not exists`), which is a different statement
 * (Rev2 item 16).
 */
const LP_OBSERVATIONS_DDL = `
  create table if not exists lp_observations (
    position_id text primary key,
    agent_id text not null,
    owner_address text not null,
    evaluated_at_ms bigint not null,
    observation jsonb not null,
    updated_at timestamptz not null default now()
  )
`;

const LP_OBSERVATIONS_OWNER_INDEX_DDL = `
  create index if not exists lp_observations_owner_idx
    on lp_observations (owner_address, agent_id)
`;

export class PostgresLpObservationStore implements LpObservationStore {
  readonly #sql: SqlClient;
  readonly #now: Clock;

  private constructor(sql: SqlClient, now: Clock) {
    this.#sql = sql;
    this.#now = now;
  }

  static async create(
    sql: SqlClient,
    now: Clock = Date.now,
  ): Promise<PostgresLpObservationStore> {
    await sql.query(LP_OBSERVATIONS_DDL);
    await sql.query(LP_OBSERVATIONS_OWNER_INDEX_DDL);
    return new PostgresLpObservationStore(sql, now);
  }

  async get(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
    signal?: AbortSignal,
  ): Promise<LpTriggerObservation | null> {
    const result = await this.#sql.query<ObservationRow>(
      `/* lpObservations.get */
       select ${OBSERVATION_COLUMNS}
       from lp_observations
       where position_id = $1 and agent_id = $2 and owner_address = $3`,
      [positionId, agentId, ownerKey(ownerAddress)],
      { ...(signal === undefined ? {} : { signal }), timeoutMs: 5_000 },
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    // C4: optional telemetry must not reach recursive bigint revival.
    if (!isRecord(row.observation)) return parseLpTriggerObservation(decodeJsonb(row.observation));
    const { fees: rawFees, ...core } = row.observation;
    const decoded = decodeJsonb(core);
    const fees = reviveLpFeesTelemetry(rawFees);
    return parseLpTriggerObservation(isRecord(decoded) ? { ...decoded, ...(fees === undefined ? {} : { fees }) } : decoded);
  }

  async put(input: PutLpObservationInput): Promise<void> {
    // The owner-match predicate rides on the UPDATE arm of the upsert, so a
    // cross-owner put updates nothing and the empty RETURNING throws — the
    // lpSettings store's shape, for the same reason.
    const result = await this.#sql.query<{ position_id: string }>(
      `/* lpObservations.put */
       insert into lp_observations (position_id, agent_id, owner_address, evaluated_at_ms, observation, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (position_id) do update
         set agent_id = excluded.agent_id,
             evaluated_at_ms = excluded.evaluated_at_ms,
             observation = excluded.observation,
             updated_at = excluded.updated_at
         where lp_observations.owner_address = excluded.owner_address
       returning position_id`,
      [
        input.positionId,
        input.agentId,
        ownerKey(input.ownerAddress),
        input.observation.evaluatedAtMs,
        encodeJsonbParam(input.observation),
        new Date(this.#now()),
      ],
    );
    if (result.rows[0] === undefined) {
      throw new Error(
        `LP observation for position "${input.positionId}" belongs to another owner.`,
      );
    }
  }

  async delete(
    ownerAddress: Address,
    agentId: string,
    positionId: string,
  ): Promise<void> {
    await this.#sql.query(
      `/* lpObservations.delete */
       delete from lp_observations
       where position_id = $1 and agent_id = $2 and owner_address = $3`,
      [positionId, agentId, ownerKey(ownerAddress)],
    );
  }

  async close(): Promise<void> {
    await this.#sql.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the durable store when `DATABASE_URL` is set, otherwise the in-memory
 * one. The connection string is never logged.
 *
 * A memory backend here is honest for `dev-stack` and dishonest for anything
 * that claims to have fixed (ae): a memory store dies with the process, so it
 * can never prove the restart property. The standalone worker already refuses
 * to start without `DATABASE_URL`.
 */
export async function createLpObservationStore(): Promise<LpObservationStore> {
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (connectionString !== undefined && connectionString !== "") {
    const sql = await createPgSqlClient(connectionString);
    const store = await PostgresLpObservationStore.create(sql);
    console.log("[lp-observation-store] backend=postgres");
    return store;
  }
  console.log("[lp-observation-store] backend=memory (DATABASE_URL not set)");
  return new MemoryLpObservationStore();
}

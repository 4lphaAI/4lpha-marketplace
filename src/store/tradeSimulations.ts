import type { Address, Hex } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";

export type TradeSimulationInsert = {
  readonly idempotencyKey: Hex; readonly agentId: string; readonly ownerAddress: Address;
  readonly journalKind: "trade" | "dcaRange"; readonly exposure: "increase" | "reduce";
  readonly route: "guard" | "direct" | "none";
  readonly outcome: "success" | "reverted" | "guard-deadline" | "failed-other" | "not-simulated";
  readonly reason: "window" | "shape" | "timeout" | "rate-limited" | "auth" | "credentials" | "unavailable" | "malformed" | "upstream-error" | null;
  readonly blocked: boolean; readonly bareRevert: boolean; readonly failReason: string | null;
  readonly latencyMs: number | null; readonly upstreamMs: number | null;
  readonly outputToken: Address; readonly predictionKind: "swap-output" | "net-wallet-delta";
  readonly minOutAtomic: bigint | null; readonly predictedOutAtomic: bigint | null; readonly createdAtMs: number;
};
export type TradeSimulationActual = { readonly idempotencyKey: Hex; readonly txHash: Hex; readonly actualOutAtomic: bigint; readonly atMs: number };
export interface TradeSimulationStore {
  insertSimulation(row: TradeSimulationInsert): Promise<void>;
  insertActual(input: TradeSimulationActual): Promise<void>;
  close(): Promise<void>;
}
/** One owner-readable simulation row; atomic amounts are decimal strings. */
export type TradeSimulationLogRow = {
  readonly createdAt: number; readonly journalKind: TradeSimulationInsert["journalKind"]; readonly exposure: TradeSimulationInsert["exposure"];
  readonly route: TradeSimulationInsert["route"]; readonly outcome: TradeSimulationInsert["outcome"]; readonly reason: TradeSimulationInsert["reason"];
  readonly blocked: boolean; readonly bareRevert: boolean; readonly failReason: string | null;
  readonly latencyMs: number | null; readonly upstreamMs: number | null; readonly outputToken: string; readonly token: string;
  readonly predictionKind: TradeSimulationInsert["predictionKind"]; readonly minOutAtomic: string | null; readonly predictedOutAtomic: string | null;
  readonly actualOutAtomic: string | null; readonly actualTxHash: string | null; readonly journalState: string | null; readonly journalTxHash: string | null;
};
export type TradeSimulationLog = { readonly rows: readonly TradeSimulationLogRow[]; readonly unavailable: null | "no-table" };
export type TradeSimulationLogReader = {
  listForAgent(input: { readonly agentId: string; readonly ownerAddress: string; readonly limit: number }): Promise<TradeSimulationLog>;
};

const OUTCOMES = ["success", "reverted", "guard-deadline", "failed-other", "not-simulated"];
const REASONS = ["window", "shape", "timeout", "rate-limited", "auth", "credentials", "unavailable", "malformed", "upstream-error"];
const keyValid = (value: string) => /^0x[0-9a-f]{64}$/u.test(value.toLowerCase());
const addressValid = (value: string) => /^0x[0-9a-f]{40}$/u.test(value.toLowerCase());
const numericValid = (value: bigint | null) => value === null || (value < 10n ** 78n && value > -(10n ** 78n));

function validate(row: TradeSimulationInsert): void {
  const timeValid = (value: number | null) => value === null || (Number.isInteger(value) && value >= 0 && value <= 60_000);
  if (!keyValid(row.idempotencyKey) || !addressValid(row.ownerAddress) || !addressValid(row.outputToken)
    || !["trade", "dcaRange"].includes(row.journalKind) || !["increase", "reduce"].includes(row.exposure)
    || !["guard", "direct", "none"].includes(row.route) || !OUTCOMES.includes(row.outcome)
    || (row.reason !== null && !REASONS.includes(row.reason))
    || (row.outcome === "not-simulated") !== (row.reason !== null)
    || row.blocked !== (row.outcome === "reverted" && row.exposure === "increase" && row.route !== "guard")
    || typeof row.bareRevert !== "boolean" || (row.bareRevert && row.outcome !== "reverted")
    || (row.failReason !== null && (row.failReason.length > 160 || !["reverted", "guard-deadline", "failed-other"].includes(row.outcome)))
    || !timeValid(row.latencyMs) || !timeValid(row.upstreamMs)
    || !["swap-output", "net-wallet-delta"].includes(row.predictionKind)
    || (row.journalKind === "trade") !== (row.predictionKind === "swap-output")
    || (row.journalKind === "trade" && row.minOutAtomic === null)
    || (row.minOutAtomic !== null && row.minOutAtomic <= 0n) || !numericValid(row.minOutAtomic)
    || !numericValid(row.predictedOutAtomic) || (row.predictedOutAtomic !== null && row.outcome !== "success")
    || !Number.isFinite(row.createdAtMs)) throw new Error("Invalid simulation evidence.");
}
function validateActual(input: TradeSimulationActual): void {
  if (!keyValid(input.idempotencyKey) || !keyValid(input.txHash) || !numericValid(input.actualOutAtomic) || !Number.isFinite(input.atMs)) throw new Error("Invalid simulation actual.");
}

export class MemoryTradeSimulationStore implements TradeSimulationStore {
  readonly simulations = new Map<string, TradeSimulationInsert>();
  readonly actuals = new Map<string, TradeSimulationActual>();
  async insertSimulation(row: TradeSimulationInsert): Promise<void> {
    validate(row);
    const key = row.idempotencyKey.toLowerCase();
    if (!this.simulations.has(key)) this.simulations.set(key, { ...row, idempotencyKey: key as Hex, ownerAddress: row.ownerAddress.toLowerCase() as Address, outputToken: row.outputToken.toLowerCase() as Address });
  }
  async insertActual(input: TradeSimulationActual): Promise<void> {
    validateActual(input);
    const key = input.idempotencyKey.toLowerCase();
    if (!this.actuals.has(key)) this.actuals.set(key, { ...input, idempotencyKey: key as Hex, txHash: input.txHash.toLowerCase() as Hex });
  }
  async listForAgent(input: { readonly agentId: string; readonly ownerAddress: string; readonly limit: number }): Promise<TradeSimulationLog> {
    const owner = input.ownerAddress.toLowerCase();
    const rows = [...this.simulations.values()].filter(row => row.agentId === input.agentId && row.ownerAddress === owner)
      .sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, input.limit).map((row): TradeSimulationLogRow => {
        const actual = this.actuals.get(row.idempotencyKey);
        return { createdAt: row.createdAtMs, journalKind: row.journalKind, exposure: row.exposure, route: row.route, outcome: row.outcome,
          reason: row.reason, blocked: row.blocked, bareRevert: row.bareRevert, failReason: row.failReason, latencyMs: row.latencyMs,
          upstreamMs: row.upstreamMs, outputToken: row.outputToken, token: row.outputToken, predictionKind: row.predictionKind,
          minOutAtomic: row.minOutAtomic?.toString() ?? null, predictedOutAtomic: row.predictedOutAtomic?.toString() ?? null,
          actualOutAtomic: actual?.actualOutAtomic.toString() ?? null, actualTxHash: actual?.txHash ?? null, journalState: null, journalTxHash: null };
      });
    return { rows, unavailable: null };
  }
  async close(): Promise<void> {}
}

export const TRADE_SIMULATIONS_DDL = [
  `create table if not exists trade_simulations (
    idempotency_key text primary key check (idempotency_key ~ '^0x[0-9a-f]{64}$'),
    agent_id text not null, owner_address text not null,
    journal_kind text not null check (journal_kind in ('trade','dcaRange')),
    exposure text not null check (exposure in ('increase','reduce')),
    route text not null check (route in ('guard','direct','none')),
    outcome text not null check (outcome in ('success','reverted','guard-deadline','failed-other','not-simulated')),
    reason text check (reason is null or reason in ('window','shape','timeout','rate-limited','auth','credentials','unavailable','malformed','upstream-error')),
    blocked boolean not null, bare_revert boolean not null,
    fail_reason text check (fail_reason is null or char_length(fail_reason) <= 160),
    latency_ms integer check (latency_ms is null or (latency_ms >= 0 and latency_ms <= 60000)),
    upstream_ms integer check (upstream_ms is null or (upstream_ms >= 0 and upstream_ms <= 60000)),
    output_token text not null check (output_token ~ '^0x[0-9a-f]{40}$'),
    prediction_kind text not null check (prediction_kind in ('swap-output','net-wallet-delta')),
    min_out_atomic numeric(78,0) check (min_out_atomic is null or min_out_atomic > 0),
    predicted_out_atomic numeric(78,0), created_at timestamptz not null,
    check ((outcome = 'not-simulated') = (reason is not null)),
    constraint trade_simulations_blocked_rule check (blocked = (outcome = 'reverted' and exposure = 'increase' and route <> 'guard')),
    check (not bare_revert or outcome = 'reverted'),
    check (fail_reason is null or outcome in ('reverted','guard-deadline','failed-other')),
    check (predicted_out_atomic is null or outcome = 'success'),
    check ((journal_kind = 'trade') = (prediction_kind = 'swap-output')),
    check (journal_kind = 'dcaRange' or min_out_atomic is not null)
  )`,
  `create table if not exists trade_simulation_actuals (
    idempotency_key text primary key check (idempotency_key ~ '^0x[0-9a-f]{64}$'),
    tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
    actual_out_atomic numeric(78,0) not null, recorded_at timestamptz not null
  )`,
  `create index if not exists trade_simulations_created_idx on trade_simulations (created_at)`,
  // Review5 F1: historical guard blocks remain evidence; NOT VALID enforces only new writes.
  `do $$ declare old_check record; begin
    for old_check in select conname from pg_constraint
      where conrelid = 'trade_simulations'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) = 'CHECK ((blocked = ((outcome = ''reverted''::text) AND (exposure = ''increase''::text))))'
    loop
      execute format('alter table trade_simulations drop constraint %I', old_check.conname);
    end loop;
    if not exists (select 1 from pg_constraint where conrelid = 'trade_simulations'::regclass
      and contype = 'c' and conname = 'trade_simulations_blocked_rule') then
      alter table trade_simulations add constraint trade_simulations_blocked_rule
        check (blocked = (outcome = 'reverted' and exposure = 'increase' and route <> 'guard')) not valid;
    end if;
  end; $$`,
] as const;

export class PostgresTradeSimulationStore implements TradeSimulationStore {
  constructor(readonly sql: SqlClient) {}
  static async create(sql: SqlClient): Promise<PostgresTradeSimulationStore> {
    try { for (const ddl of TRADE_SIMULATIONS_DDL) await sql.query(ddl, [], { timeoutMs: 2_000 }); }
    catch (error) { void sql.close().catch(() => undefined); throw error; }
    return new PostgresTradeSimulationStore(sql);
  }
  async insertSimulation(row: TradeSimulationInsert): Promise<void> {
    validate(row);
    await this.sql.query(`insert into trade_simulations (idempotency_key, agent_id, owner_address, journal_kind, exposure, route,
      outcome, reason, blocked, bare_revert, fail_reason, latency_ms, upstream_ms, output_token, prediction_kind,
      min_out_atomic, predicted_out_atomic, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      on conflict (idempotency_key) do nothing`, [row.idempotencyKey.toLowerCase(), row.agentId, row.ownerAddress.toLowerCase(), row.journalKind,
      row.exposure, row.route, row.outcome, row.reason, row.blocked, row.bareRevert, row.failReason, row.latencyMs, row.upstreamMs,
      row.outputToken.toLowerCase(), row.predictionKind, row.minOutAtomic?.toString() ?? null, row.predictedOutAtomic?.toString() ?? null,
      new Date(row.createdAtMs)], { timeoutMs: 2_000 });
  }
  async insertActual(input: TradeSimulationActual): Promise<void> {
    validateActual(input);
    await this.sql.query(`insert into trade_simulation_actuals (idempotency_key, tx_hash, actual_out_atomic, recorded_at)
      values ($1,$2,$3,$4) on conflict (idempotency_key) do nothing`, [input.idempotencyKey.toLowerCase(), input.txHash.toLowerCase(), input.actualOutAtomic.toString(), new Date(input.atMs)], { timeoutMs: 2_000 });
  }
  /** Owner read for the API process: one SELECT, no DDL (the worker owns the tables). */
  async listForAgent(input: { readonly agentId: string; readonly ownerAddress: string; readonly limit: number }): Promise<TradeSimulationLog> {
    try {
      const result = await this.sql.query<Record<string, unknown>>(`select s.created_at, s.journal_kind, s.exposure, s.route, s.outcome, s.reason,
        s.blocked, s.bare_revert, s.fail_reason, s.latency_ms, s.upstream_ms, s.output_token, coalesce(i.token, s.output_token) as token,
        s.prediction_kind, s.min_out_atomic::text as min_out_atomic, s.predicted_out_atomic::text as predicted_out_atomic,
        a.actual_out_atomic::text as actual_out_atomic, a.tx_hash as actual_tx_hash, j.state as journal_state, j.external_ref->>'txHash' as journal_tx_hash
        from trade_simulations s left join trade_simulation_actuals a using (idempotency_key)
        left join execution_journal j on j.idempotency_key = s.idempotency_key
        left join trade_intents i on i.decision_id = j.decision_id and i.agent_id = s.agent_id
        where s.agent_id = $1 and s.owner_address = $2 order by s.created_at desc limit $3`,
      [input.agentId, input.ownerAddress.toLowerCase(), input.limit], { timeoutMs: 2_000 });
      const text = (value: unknown) => value === null || value === undefined ? null : String(value);
      const count = (value: unknown) => value === null || value === undefined ? null : Number(value);
      return { unavailable: null, rows: result.rows.map((r): TradeSimulationLogRow => ({ createdAt: new Date(r["created_at"] as Date | string).getTime(),
        journalKind: r["journal_kind"] as TradeSimulationLogRow["journalKind"], exposure: r["exposure"] as TradeSimulationLogRow["exposure"],
        route: r["route"] as TradeSimulationLogRow["route"], outcome: r["outcome"] as TradeSimulationLogRow["outcome"],
        reason: r["reason"] as TradeSimulationLogRow["reason"], blocked: r["blocked"] === true, bareRevert: r["bare_revert"] === true,
        failReason: text(r["fail_reason"]), latencyMs: count(r["latency_ms"]), upstreamMs: count(r["upstream_ms"]),
        outputToken: String(r["output_token"]), token: String(r["token"]), predictionKind: r["prediction_kind"] as TradeSimulationLogRow["predictionKind"],
        minOutAtomic: text(r["min_out_atomic"]), predictedOutAtomic: text(r["predicted_out_atomic"]), actualOutAtomic: text(r["actual_out_atomic"]),
        actualTxHash: text(r["actual_tx_hash"]), journalState: text(r["journal_state"]), journalTxHash: text(r["journal_tx_hash"]) })) };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") return { rows: [], unavailable: "no-table" };
      throw error;
    }
  }
  close(): Promise<void> { return this.sql.close(); }
}

export async function createTradeSimulationStore(options: { readonly createSqlClient?: typeof createPgSqlClient } = {}): Promise<TradeSimulationStore> {
  const url = process.env["DATABASE_URL"]?.trim();
  if (!url) return new MemoryTradeSimulationStore();
  const sql = await (options.createSqlClient ?? createPgSqlClient)(url,
    { max: 2, connectionTimeoutMillis: 1_500, idleTimeoutMillis: 10_000, allowExitOnIdle: true },
    () => { try { console.warn("[trade-worker] simulation evidence pool error"); } catch { /* Optional logging. */ } });
  return PostgresTradeSimulationStore.create(sql);
}

export type TradeSimulationReport = TradeSimulationInsert & {
  readonly actualOutAtomic: bigint | null; readonly actualTxHash: Hex | null;
  readonly journalState: string | null; readonly hasCallsId: boolean;
};
export async function readTradeSimulations(sql: SqlClient, filter: { sinceMs: number; agentId?: string; limit: number }) {
  try {
    const result = await sql.query<Record<string, unknown>>(`select s.*, a.actual_out_atomic, a.tx_hash as actual_tx_hash,
      j.state as journal_state, coalesce(j.external_ref ? 'callsId', false) as has_calls_id
      from trade_simulations s left join trade_simulation_actuals a using (idempotency_key)
      left join execution_journal j using (idempotency_key)
      where s.created_at >= $1 and ($2::text is null or s.agent_id = $2) order by s.created_at limit $3`,
      [new Date(filter.sinceMs), filter.agentId ?? null, filter.limit]);
    const unmatched = await sql.query<{ count: string }>(`select count(*)::text as count from trade_simulation_actuals a
      left join trade_simulations s using (idempotency_key) left join execution_journal j using (idempotency_key)
      where s.idempotency_key is null and a.recorded_at >= $1 and ($2::text is null or j.agent_id = $2)`, [new Date(filter.sinceMs), filter.agentId ?? null]);
    const rows = result.rows.map(r => ({ idempotencyKey: r["idempotency_key"], agentId: r["agent_id"], ownerAddress: r["owner_address"],
      journalKind: r["journal_kind"], exposure: r["exposure"], route: r["route"], outcome: r["outcome"], reason: r["reason"], blocked: r["blocked"],
      bareRevert: r["bare_revert"], failReason: r["fail_reason"], latencyMs: r["latency_ms"], upstreamMs: r["upstream_ms"], outputToken: r["output_token"],
      predictionKind: r["prediction_kind"], minOutAtomic: r["min_out_atomic"] === null ? null : BigInt(String(r["min_out_atomic"])),
      predictedOutAtomic: r["predicted_out_atomic"] === null ? null : BigInt(String(r["predicted_out_atomic"])), createdAtMs: new Date(String(r["created_at"])).getTime(),
      actualOutAtomic: r["actual_out_atomic"] === null ? null : BigInt(String(r["actual_out_atomic"])), actualTxHash: r["actual_tx_hash"],
      journalState: r["journal_state"], hasCallsId: r["has_calls_id"] })) as TradeSimulationReport[];
    return { rows, actualWithoutSimulation: Number(unmatched.rows[0]?.count ?? 0), missingTable: false };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") return { rows: [], actualWithoutSimulation: 0, missingTable: true };
    throw error;
  }
}

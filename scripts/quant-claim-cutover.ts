/**
 * Production claim cutover (G4): census, plan-check and the one all-or-nothing writer.
 *
 * Run by the operator on their own machine, from the merged master commit, with DATABASE_URL set in
 * that one process environment (never read from an env file). It is not part of the rebalance CLI,
 * which stays without a `migrate` command, and it imports neither that CLI nor any self-test
 * composition. `apply` installs only additive schema and, per wallet, one ACTIVE Grid claim for the
 * operator-named holder. Every other job is left byte-for-byte untouched: its NULL claim generation
 * is what the existing Grid claim gate holds as `claim-inconsistent`.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { pathToFileURL } from "node:url";
import { getAddress, isAddress, keccak256, stringToBytes, type Hex } from "viem";
import { sanitizeMessage } from "../src/core/errors.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";
import { buildQuantWalletCensus } from "../src/quant/rebalanceCensus.js";
import {
  gridCensusActions, gridCensusJobs, readGridActions, readGridJobs, readReceiptOwnership,
  withQuantRebalanceCensusSnapshot,
} from "../src/quant/rebalanceCensusReaders.js";
import { createPgSqlClient, type SqlClient, type SqlQueryOptions } from "../src/store/sql.js";
import { QUANT_CLAIM_GENERATION_COLUMN_DDL, QUANT_LOCK_CLASSID } from "../src/store/quantJobs.js";
import { QUANT_REBALANCE_DDL } from "../src/store/quantRebalance.js";
import { lockQuantWalletClaim, PostgresQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import {
  acquireWorkerSingleton, type WorkerFence, type WorkerLockClient, type WorkerSingletonDependencies,
  type WorkerSingletonLease, type WorkerSingletonResult, type WorkerSingletonRole,
} from "../src/deployment/workerSingleton.js";

const CENSUS_VERSION = "quant-claim-cutover-census:1";
const CUTOVER_LOCK_CLASSID = 0x5143_4354; // "QCCT"
const CUTOVER_LOCK_KEY = "quant-claim-cutover-v1";
const INSTALLED_BY = "production-cutover-v1";
/** Each lock wait is short and a timeout aborts the whole cutover (never retried). */
export const CUTOVER_LOCK_TIMEOUT_MS = 5_000;
/**
 * Total deadline from connecting through COMMIT. lock_timeout bounds waits, not how long acquired locks are held, so
 * expiry (or the loss of either worker barrier) terminates the transaction's own PostgreSQL backend from a second
 * connection, which releases its locks even while one of its statements is still running.
 */
export const CUTOVER_DEADLINE_MS = 60_000;
/**
 * One absolute budget for everything after the transaction ends: terminating the pinned backend and confirming it
 * left, the marker check, releasing the barriers and closing connections. The clock starts at the first cleanup
 * step, every step is capped by what remains, and nothing waits past it.
 */
export const CUTOVER_CLEANUP_MS = 15_000;
/** Bounds on acquiring the pinned connection and on each request of the termination control connection. */
const CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 3_000;
const CONFIRM_POLL_MS = 100;
/** After a lost lease and the run's cleanup, how long the printed outcome has to flush before the fail-stop exit. */
const EXIT_FLUSH_MS = 1_000;

/**
 * The complete legacy Grid table/column contract: every column the Grid store creates (its table DDL plus
 * QUANT_MIGRATIONS), except `claim_generation`, the one column a legacy database may lack. A test builds the
 * schema through the store and requires this literal to equal it, so it cannot drift. `execution_journal` is
 * validated column by column by `PostgresExecutionJournal.attachExisting`.
 */
export const GRID_LEGACY_CONTRACT: Readonly<Record<string, readonly string[]>> = Object.fromEntries(Object.entries({
  quant_actions:
    "action_seq amount_in_wei base_at_cycle_start_wei basis_u_wei calls_json created_at_ms deadline_sec " +
    "evidence_kind executed_at_sec executed_block failure_code fee_delta_wei fee_est_wei fill_in_wei " +
    "fill_out_wei gas_price_wei impact_bps journal_key ladder_gen level_index min_out_wei note " +
    "pre_native_block pre_native_wei pre_u_wei pre_wbnb_wei prior_level_state quant_job_id quote_block " +
    "quote_out_wei required_native_wei resolution_json row_version side state submit_finalized_hash " +
    "submit_finalized_number trigger_block_1 trigger_block_2 tx_hash updated_at_ms",
  quant_epochs:
    "baseline_native_wei baseline_u_wei baseline_wbnb_wei created_at_ms epoch note quant_job_id started_block " +
    "started_block_hash verified",
  quant_indexer_trades: "amount_in amount_out block_time_ms created_at_ms direction note quant_job_id tx_hash",
  quant_jobs:
    "accounting_epoch accounting_evidence_json accounting_rev accounting_state admitted_at_ms " +
    "allocation_u_wei anchor_e18 arm_block cap_rows_json chain_checked_at_ms clip_u_wei created_at_ms " +
    "daily_cap_u_wei ends_at_ms envelope_id envelope_json hold_code hold_count idle_u_wei ladder_gen " +
    "last_accepted_at_ms last_accepted_block last_accepted_hash last_job_read_at_ms last_observed_at_ms " +
    "last_observed_block last_observed_hash last_recenter_at_ms levels p0_e18 params_digest params_json " +
    "permissions_digest projection_digest quant_job_id recenter_at_first recenter_block_first recenter_budget " +
    "recenter_consecutive recenter_hash_first recenter_side recenters report_attempts report_payload_hash " +
    "report_response_status reported_at_ms residual_threshold_wei revoked_at_ms row_version " +
    "session_expires_at_ms session_expiry session_public_key stale_observations started_at_ms status " +
    "strategy_id term_days trading_wallet updated_at_ms wbnb_cap_min_limit_wei wire_state",
  quant_levels:
    "action_seq base_at_cycle_start_wei base_wei basis_u_wei buy_price_e18 cycles_closed entry_cost_u_wei " +
    "exit_plan_json hold_code hold_count ladder_gen last_action_at_ms level_index prior_state quant_job_id " +
    "realized_u_wei residual_wei retired_json row_version seed_last_cause seed_note seed_outcome seed_pending " +
    "seed_refusals seed_submissions sell_price_e18 state trigger_at_first trigger_block_first " +
    "trigger_consecutive trigger_hash_first trigger_side",
  quant_observations: "block_hash block_number mid_e18 observed_at_ms quant_job_id",
  quant_quant_migrations: "applied_at_ms version",
  quant_receipt_ownership: "created_at_ms journal_key swap_log_index trading_wallet tx_hash",
  quant_recenters:
    "at_ms block_hash block_number cause direction evidence_at_1 evidence_at_2 evidence_block_1 " +
    "evidence_block_2 evidence_hash_1 evidence_hash_2 from_gen new_anchor_e18 new_lines_json old_anchor_e18 " +
    "old_lines_json quant_job_id reseed_scheduled seq to_gen upper_prior_json",
  quant_reports: "attempt created_at_ms notes_applied payload_digest quant_job_id response_status",
  quant_runs: "actions dry_run errors finished_at_ms holds jobs_seen run_id started_at_ms",
  quant_seed_events: "accepted_block at_ms cause journal_key kind ladder_gen level_index quant_job_id",
}).map(([table, columns]) => [table, columns.split(" ")]));
const REQUIRED_TABLES = [...Object.keys(GRID_LEGACY_CONTRACT), "execution_journal"];
/** What `apply` adds: the claim column on quant_jobs and exactly these tables. */
const NEW_TABLES = [
  "quant_rebalance_actions", "quant_rebalance_checks", "quant_rebalance_jobs",
  "quant_wallet_claim_migration", "quant_wallet_claims",
] as const;
const ACTION_TERMINAL = new Set(["settled", "failed", "aborted"]);

export type Inventory = ReadonlyMap<string, readonly string[]>;
type GridJob = Readonly<{
  jobId: string; strategyId: string; wallet: string; status: string; admittedAtMs: number | null;
  rowVersion: number; claimGeneration: string | null;
}>;
type JournalFact = Readonly<{ key: string; agentId: string; state: string; txHash: string | null; hasCallsId: boolean }>;
type ActionFact = Readonly<{
  key: string; jobId: string; state: string; txHash: string | null;
  failureCode: string | null; resolutionJson: string | null; deadlineSec: string;
}>;
type OwnershipFact = Readonly<{ txHash: string; wallet: string; journalKey: string }>;
export type CutoverPlan = Readonly<{
  version: 1; censusDigest: Hex;
  groups: readonly Readonly<{ wallet: string; holderJobId: string; excludedJobIds: readonly string[] }>[];
}>;

export type Census = Readonly<{
  digest: Hex; inventory: Inventory; jobs: readonly GridJob[]; actions: readonly ActionFact[];
  journals: readonly JournalFact[]; schemaReasons: readonly string[]; unresolved: readonly string[];
  claimSchema: readonly string[]; rebalanceSchema: readonly string[]; persistedClaimGenerations: number;
  report: Readonly<Record<string, unknown>>;
}>;

export class CutoverRefusal extends Error {
  constructor(readonly code: string, readonly details: readonly string[] = []) { super(code); }
}

export type CutoverOutcome =
  | Readonly<{ kind: "applied"; censusDigest: Hex; dispositionDigest: Hex; holders: number }>
  | Readonly<{ kind: "applied-with-cleanup-failure"; censusDigest: Hex; dispositionDigest: Hex; holders: number }>
  | Readonly<{ kind: "refused"; code: string; details: readonly string[] }>
  /** `terminationConfirmed: false` means the backend that sent COMMIT was not confirmed gone: it may still commit. */
  | Readonly<{ kind: "outcome-unknown"; dispositionDigest: Hex; markerPresent: boolean | null; terminationConfirmed: boolean }>;

/** The offline test seam. The process entry never passes it. */
export type CutoverHooks = Readonly<{
  acquire?: (input: {
    readonly role: WorkerSingletonRole; readonly databaseUrl: string; readonly dependencies?: WorkerSingletonDependencies;
  }) => Promise<WorkerSingletonResult>;
  /** Wraps the pinned transaction's statement client (fault injection between statements). */
  wrapTx?: (tx: SqlClient) => SqlClient;
  /** Replaces the backend termination (a failing or slow control connection). */
  terminate?: (pid: number) => Promise<boolean>;
  deadlineMs?: number;
  cleanupMs?: number;
  lockTimeoutMs?: number;
  nowMs?: () => number;
}>;

/* -------------------------------------------------------------------------- */
/* Census                                                                      */
/* -------------------------------------------------------------------------- */

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new CutoverRefusal("census-identifier-invalid");
  return `"${name}"`;
}
const byCodepoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}

/** Every quant_* table and execution_journal in `public`, with sorted columns. */
export async function readInventory(tx: SqlClient): Promise<Inventory> {
  const result = await tx.query<{ table_name: string; column_name: string }>(
    `/* quantClaimCutover.inventory */ select c.relname as table_name, a.attname as column_name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
       and (c.relname like 'quant\\_%' or c.relname = 'execution_journal')
     order by c.relname, a.attname`,
  );
  const grouped = new Map<string, string[]>();
  for (const row of result.rows) grouped.set(row.table_name, [...(grouped.get(row.table_name) ?? []), row.column_name]);
  return new Map([...grouped].sort(([a], [b]) => byCodepoint(a, b)).map(([table, columns]) => [table, [...columns].sort(byCodepoint)]));
}

async function primaryKey(tx: SqlClient, table: string): Promise<readonly string[]> {
  const result = await tx.query<{ attname: string }>(
    `/* quantClaimCutover.primaryKey */ select a.attname from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = to_regclass($1) and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`,
    [`public.${ident(table)}`],
  );
  if (result.rows.length === 0) throw new CutoverRefusal("census-table-without-primary-key", [table]);
  return result.rows.map((row) => row.attname);
}

/**
 * keccak256 over the canonical inventory plus every row and column of every table in `inventory`
 * (execution_journal restricted to quant kinds), ordered by primary key, every value as text.
 * It excludes observation time. Passing the ORIGINAL inventory reconstructs the same digest domain
 * after additive schema has been installed.
 */
export async function stableCensusDigest(tx: SqlClient, inventory: Inventory): Promise<Hex> {
  await tx.query("set local timezone to 'UTC'");
  const tables: { table: string; columns: readonly string[]; rows: (string | null)[][] }[] = [];
  for (const [table, columns] of [...inventory].sort(([a], [b]) => byCodepoint(a, b))) {
    const keys = await primaryKey(tx, table);
    const filter = table === "execution_journal" ? " where kind = 'quantTrade'" : "";
    const result = await tx.query<Record<string, string | null>>(
      `/* quantClaimCutover.rows */ select ${columns.map((column) => `${ident(column)}::text`).join(", ")}
       from public.${ident(table)}${filter} order by ${keys.map(ident).join(", ")}`,
    );
    tables.push({ table, columns, rows: result.rows.map((row) => columns.map((column) => row[column] ?? null)) });
  }
  return keccak256(stringToBytes(rebalanceCanonicalEncode({ version: CENSUS_VERSION, tables })));
}

function legacySchemaReasons(inventory: Inventory): string[] {
  const reasons: string[] = [];
  for (const table of REQUIRED_TABLES) if (!inventory.has(table)) reasons.push(`missing-table:${table}`);
  for (const [table, columns] of Object.entries(GRID_LEGACY_CONTRACT)) {
    const present = inventory.get(table);
    if (present !== undefined) for (const column of columns) if (!present.includes(column)) reasons.push(`missing-column:${table}.${column}`);
  }
  return reasons;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/u;
const sameHash = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** The persisted shape of the R14.5 door (`NotExecutedEvidence`): the finalized block is strictly past the action's router deadline. */
function notExecutedProven(action: ActionFact): boolean {
  if (action.state !== "failed" || action.failureCode !== "not-executed-proven" || action.resolutionJson === null) return false;
  try {
    const parsed: unknown = JSON.parse(action.resolutionJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const evidence = parsed as Record<string, unknown>;
    const stamp = evidence["finalizedTimestampSec"];
    return evidence["v"] === 1 && evidence["kind"] === "not-executed"
      && (typeof stamp === "number" || typeof stamp === "string" && /^[0-9]+$/u.test(stamp))
      && BigInt(stamp) > BigInt(action.deadlineSec);
  } catch { return false; }
}

/**
 * Potentially submitted, non-definitive or contradictory Grid work, judged independently of job status and of
 * any join. The permitted terminal pairs are the ones the existing Grid code produces: `settleAction` writes a
 * settled action, its transaction hash and exactly one receipt-ownership row for (hash, job wallet, journal key);
 * the journal is COMMITTED and carries the same hash, or none (the recovery outcome of
 * `src/quant/reconcile.ts` `COMMITTED-hash/found` settles from the relay's hash and leaves the journal's null).
 * Every failed or aborted action is paired with no journal row (a pre-begin refusal) or a ROLLED_BACK one that
 * never carries a hash (a reported relay failure may keep its `callsId`), and never has an owner. UNKNOWN is never
 * definitive, except the one state the audited R14.5 operator door `live-quant resolve --not-executed` leaves for good
 * (`src/store/quantJobs.ts` `resolveNotExecuted`): the action is `failed` / `not-executed-proven` with its
 * `NotExecutedEvidence` and the journal row stays UNKNOWN with no `callsId` (`notExecutedProven`). The rule above
 * already refuses every terminal action that has a hash, an owner or a hash-bearing journal, so those are not repeated.
 * A combination those paths cannot produce is refused, not repaired: this adds no recovery semantics.
 */
function unresolvedFindings(
  actions: readonly ActionFact[], journals: readonly JournalFact[], ownership: readonly OwnershipFact[], jobs: readonly GridJob[],
): string[] {
  const findings: string[] = [];
  const journalByKey = new Map(journals.map((journal) => [journal.key, journal]));
  const actionByKey = new Map(actions.map((action) => [action.key, action]));
  const walletOf = new Map(jobs.map((job) => [job.jobId, job.wallet]));
  const ownedBy = groupBy(ownership, (row) => row.journalKey);
  const attributable = (row: OwnershipFact, action: ActionFact): boolean =>
    TX_HASH.test(row.txHash) && sameHash(row.txHash, action.txHash) && row.wallet === walletOf.get(action.jobId);
  for (const action of actions) {
    if (!ACTION_TERMINAL.has(action.state)) { findings.push(`action-unresolved:${action.jobId}:${action.key}:${action.state}`); continue; }
    const journal = journalByKey.get(action.key);
    const owners = ownedBy.get(action.key) ?? [];
    if (journal !== undefined && journal.agentId !== action.jobId) findings.push(`journal-attribution-mismatch:${action.jobId}:${action.key}`);
    if (action.state === "settled") {
      const coherent = journal !== undefined && journal.state === "COMMITTED" && action.txHash !== null && TX_HASH.test(action.txHash)
        && (journal.txHash === null || sameHash(journal.txHash, action.txHash))
        && owners.length === 1 && attributable(owners[0]!, action);
      if (!coherent) findings.push(`settled-action-evidence-mismatch:${action.jobId}:${action.key}`);
    } else if (action.txHash !== null || owners.length > 0 || journal?.state === "COMMITTED" || (journal?.txHash ?? null) !== null) {
      findings.push(`terminal-action-with-committed-evidence:${action.jobId}:${action.key}:${action.state}`);
    }
  }
  for (const journal of journals) {
    const paired = actionByKey.get(journal.key);
    const definitive = journal.state === "ROLLED_BACK"
      || journal.state === "COMMITTED" && (journal.txHash === null ? paired?.state === "settled" : TX_HASH.test(journal.txHash))
      || journal.state === "UNKNOWN" && !journal.hasCallsId && paired !== undefined && notExecutedProven(paired);
    if (!definitive) findings.push(`journal-unresolved:${journal.agentId}:${journal.key}:${journal.state}`);
    if (paired === undefined) findings.push(`journal-orphan:${journal.agentId}:${journal.key}:${journal.state}`);
  }
  for (const row of ownership) {
    const owned = actionByKey.get(row.journalKey);
    if (owned?.state !== "settled" || !attributable(row, owned)) findings.push(`receipt-ownership-unattributed:${row.journalKey}`);
  }
  return findings;
}

/** One read of everything the plan is validated against, on the caller's transaction. */
export async function takeCensus(tx: SqlClient, frozen?: Inventory): Promise<Census> {
  const inventory = frozen ?? await readInventory(tx);
  const digest = await stableCensusDigest(tx, inventory);
  const schemaReasons = legacySchemaReasons(inventory);
  try { await PostgresExecutionJournal.attachExisting(tx); } catch { schemaReasons.push("journal-schema-unsupported"); }
  const quantJobs = inventory.get("quant_jobs");
  const hasGeneration = quantJobs?.includes("claim_generation") === true;
  const has = (table: string, columns: readonly string[]) => columns.every((column) => inventory.get(table)?.includes(column) === true);
  const jobs: GridJob[] = quantJobs === undefined || !has("quant_jobs", ["quant_job_id", "strategy_id", "trading_wallet", "status", "admitted_at_ms", "row_version"]) ? [] : (await tx.query<Record<string, unknown>>(
    `/* quantClaimCutover.jobs */ select quant_job_id, strategy_id, lower(trading_wallet) as wallet, status,
       admitted_at_ms::text as admitted_at_ms, row_version,
       ${hasGeneration ? "claim_generation::text" : "null::text"} as claim_generation
     from quant_jobs order by quant_job_id`)).rows.map((row) => ({
    jobId: String(row["quant_job_id"]), strategyId: String(row["strategy_id"]), wallet: String(row["wallet"]),
    status: String(row["status"]), admittedAtMs: row["admitted_at_ms"] === null ? null : Number(row["admitted_at_ms"]),
    rowVersion: Number(row["row_version"]), claimGeneration: row["claim_generation"] === null ? null : String(row["claim_generation"]),
  }));
  const actions: ActionFact[] = has("quant_actions", ["journal_key", "quant_job_id", "state", "tx_hash", "failure_code", "resolution_json", "deadline_sec"]) ? (await tx.query<Record<string, unknown>>(
    `/* quantClaimCutover.actions */ select journal_key, quant_job_id, state, tx_hash, failure_code, resolution_json,
       deadline_sec::text as deadline_sec from quant_actions order by journal_key`)).rows
    .map((row) => ({ key: String(row["journal_key"]), jobId: String(row["quant_job_id"]), state: String(row["state"]),
      txHash: row["tx_hash"] === null ? null : String(row["tx_hash"]),
      failureCode: row["failure_code"] === null ? null : String(row["failure_code"]),
      resolutionJson: row["resolution_json"] === null ? null : String(row["resolution_json"]),
      deadlineSec: String(row["deadline_sec"]) })) : [];
  const ownership: OwnershipFact[] = has("quant_receipt_ownership", ["tx_hash", "trading_wallet", "journal_key"]) ? (await tx.query<Record<string, unknown>>(
    `/* quantClaimCutover.ownership */ select tx_hash, lower(trading_wallet) as wallet, journal_key from quant_receipt_ownership order by tx_hash, trading_wallet, swap_log_index`)).rows
    .map((row) => ({ txHash: String(row["tx_hash"]), wallet: String(row["wallet"]), journalKey: String(row["journal_key"]) })) : [];
  const journals: JournalFact[] = ["idempotency_key", "agent_id", "state", "kind", "external_ref"].every((column) => inventory.get("execution_journal")?.includes(column) === true) ? (await tx.query<Record<string, unknown>>(
    `/* quantClaimCutover.journals */ select idempotency_key, agent_id, state, nullif(external_ref->>'txHash', '') as tx_hash,
       coalesce(external_ref ? 'callsId', false) as has_calls_id
     from execution_journal where kind = 'quantTrade' order by idempotency_key`)).rows
    .map((row) => ({ key: String(row["idempotency_key"]), agentId: String(row["agent_id"]), state: String(row["state"]),
      txHash: row["tx_hash"] === null ? null : String(row["tx_hash"]), hasCallsId: row["has_calls_id"] === true })) : [];

  // Display projection: the shared census over the same rows, plus persisted generations and claims.
  const claimsStore = new PostgresQuantWalletClaimStore(tx);
  const claims = inventory.has("quant_wallet_claims") ? await claimsStore.list() : [];
  const marker = inventory.has("quant_wallet_claim_migration") ? (await tx.query<Record<string, unknown>>(
    `/* quantClaimCutover.marker */ select migration_version, census_digest, disposition_digest, installed_at_ms::text as installed_at_ms, installed_by
     from quant_wallet_claim_migration order by migration_version`)).rows : [];
  const validWallet = (row: Record<string, unknown>) => isAddress(String(row["trading_wallet"]), { strict: false });
  const supported = schemaReasons.length === 0;
  const gridRows = supported ? (await readGridJobs(tx)).filter(validWallet) : [];
  const shown = buildQuantWalletCensus({
    generatedAtMs: 0, migrationInstalled: inventory.has("quant_wallet_claim_migration") && await claimsStore.migrationInstalled(),
    gridJobs: gridCensusJobs(gridRows), gridActions: supported ? gridCensusActions(await readGridActions(tx)) : [],
    rebalanceJobs: [], rebalanceActions: [], claims,
    receiptOwnership: supported ? await readReceiptOwnership(tx) : [],
  });
  const persisted = new Map(jobs.map((job) => [job.jobId, job]));
  const wallets = [...groupBy(jobs.filter((job) => job.wallet !== ""), (job) => job.wallet)].sort(([a], [b]) => byCodepoint(a, b))
    .map(([wallet, members]) => ({
      wallet, requiresGroup: members.some(requiresDisposition),
      jobs: (shown.groups.find((group) => group.wallet.toLowerCase() === wallet)?.jobs ?? []).map((view) => ({
        ...view, admittedAtMs: persisted.get(view.jobId)?.admittedAtMs ?? null,
        persistedClaimGeneration: persisted.get(view.jobId)?.claimGeneration ?? null,
      })),
    }));
  const claimSchema = ["quant_wallet_claims", "quant_wallet_claim_migration"].filter((table) => inventory.has(table));
  const rebalanceSchema = [...inventory.keys()].filter((table) => table.startsWith("quant_rebalance_"));
  const unresolved = unresolvedFindings(actions, journals, ownership, jobs);
  const persistedClaimGenerations = jobs.filter((job) => job.claimGeneration !== null).length;
  const draft = draftPlan(digest, jobs);
  return {
    digest, inventory, jobs, actions, journals, schemaReasons, unresolved, claimSchema, rebalanceSchema, persistedClaimGenerations,
    report: {
      digest, schema: { supported: schemaReasons.length === 0, reasons: schemaReasons, claimTables: claimSchema,
        rebalanceTables: rebalanceSchema, persistedClaimGenerations },
      inventory: [...inventory].map(([table, columns]) => ({ table, columns: columns.length })),
      wallets, claims: claims.map((claim) => ({ wallet: claim.wallet, mode: claim.mode, strategyKind: claim.strategyKind,
        strategyId: claim.strategyId, jobId: claim.jobId, generation: claim.generation.toString(10) })), marker,
      unresolved, draftPlan: draft,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

/** A wallet needs a disposition when it holds a Grid job that was admitted and is not yet reported. */
function requiresDisposition(job: GridJob): boolean { return job.admittedAtMs !== null && job.status !== "reported"; }

function draftPlan(digest: Hex, jobs: readonly GridJob[]): CutoverPlan {
  const groups = [...groupBy(jobs.filter((job) => job.wallet !== ""), (job) => job.wallet)]
    .filter(([, members]) => members.some(requiresDisposition)).sort(([a], [b]) => byCodepoint(a, b))
    .map(([wallet, members]) => {
      const ids = members.map((job) => job.jobId).sort();
      return ids.length === 1 ? { wallet, holderJobId: ids[0]!, excludedJobIds: [] as string[] }
        : { wallet, holderJobId: "CHOOSE", excludedJobIds: ids };
    });
  return { version: 1, censusDigest: digest, groups };
}

/** Strict shape, lower-cased wallets, sorted groups and exclusions: the form that is digested. */
export function parsePlan(raw: unknown): CutoverPlan | null {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(raw) || Object.keys(raw).sort().join("|") !== "censusDigest|groups|version" || raw["version"] !== 1
    || typeof raw["censusDigest"] !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(raw["censusDigest"])
    || !Array.isArray(raw["groups"])) return null;
  const groups: { wallet: string; holderJobId: string; excludedJobIds: string[] }[] = [];
  for (const group of raw["groups"] as unknown[]) {
    if (!isRecord(group) || Object.keys(group).sort().join("|") !== "excludedJobIds|holderJobId|wallet"
      || typeof group["wallet"] !== "string" || !isAddress(group["wallet"], { strict: false })
      || typeof group["holderJobId"] !== "string" || group["holderJobId"] === ""
      || !Array.isArray(group["excludedJobIds"])
      || (group["excludedJobIds"] as unknown[]).some((id) => typeof id !== "string" || id === "")) return null;
    groups.push({ wallet: getAddress(group["wallet"]).toLowerCase(), holderJobId: group["holderJobId"],
      excludedJobIds: [...group["excludedJobIds"] as string[]].sort() });
  }
  groups.sort((a, b) => byCodepoint(a.wallet, b.wallet));
  return { version: 1, censusDigest: raw["censusDigest"].toLowerCase() as Hex, groups };
}

function dispositionDigest(plan: CutoverPlan): Hex { return keccak256(stringToBytes(rebalanceCanonicalEncode(plan))); }

/** Every reason the plan cannot be applied to this census; empty means it can. */
export function planRefusals(census: Census, plan: CutoverPlan): string[] {
  const reasons: string[] = [...census.schemaReasons];
  if (plan.censusDigest !== census.digest.toLowerCase()) reasons.push("census-digest-mismatch");
  if (census.claimSchema.length > 0) reasons.push(`claim-schema-present:${census.claimSchema.join(",")}`);
  if (census.rebalanceSchema.length > 0) reasons.push(`rebalance-schema-present:${census.rebalanceSchema.join(",")}`);
  if (census.persistedClaimGenerations > 0) reasons.push("claim-generation-present");
  reasons.push(...census.unresolved);
  const byWallet = groupBy(census.jobs.filter((job) => job.wallet !== ""), (job) => job.wallet);
  const required = new Set([...byWallet].filter(([, members]) => members.some(requiresDisposition)).map(([wallet]) => wallet));
  const planned = new Set<string>();
  for (const group of plan.groups) {
    if (planned.has(group.wallet)) reasons.push(`group-duplicate:${group.wallet}`);
    planned.add(group.wallet);
    const members = byWallet.get(group.wallet);
    if (!required.has(group.wallet) || members === undefined) { reasons.push(`group-extra:${group.wallet}`); continue; }
    const holder = members.find((job) => job.jobId === group.holderJobId);
    if (holder === undefined) reasons.push(`holder-invalid:${group.wallet}`);
    else if (holder.admittedAtMs === null || holder.status === "discovered" || holder.status === "reported") {
      reasons.push(`holder-unadmitted:${group.wallet}`);
    }
    const expected = members.map((job) => job.jobId).filter((id) => id !== group.holderJobId).sort();
    if (holder !== undefined && (expected.length !== group.excludedJobIds.length
      || expected.some((id, index) => id !== group.excludedJobIds[index]))) reasons.push(`excluded-mismatch:${group.wallet}`);
  }
  for (const wallet of required) if (!planned.has(wallet)) reasons.push(`group-missing:${wallet}`);
  return reasons;
}

function plannedWrites(census: Census, plan: CutoverPlan, digest: Hex) {
  return {
    schema: { addColumn: "quant_jobs.claim_generation", createTables: [...NEW_TABLES] },
    claims: plan.groups.map((group) => ({ wallet: group.wallet, mode: "active", strategyKind: "grid",
      strategyId: census.jobs.find((job) => job.jobId === group.holderJobId)?.strategyId ?? null,
      jobId: group.holderJobId, generation: "1", rowVersion: 1 })),
    jobUpdates: plan.groups.map((group) => ({ jobId: group.holderJobId, claimGeneration: "1",
      expectedRowVersion: census.jobs.find((job) => job.jobId === group.holderJobId)?.rowVersion ?? null })),
    untouched: plan.groups.flatMap((group) => group.excludedJobIds),
    marker: { migrationVersion: 1, censusDigest: plan.censusDigest, dispositionDigest: digest, installedBy: INSTALLED_BY },
  };
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export async function runCensus(sql: SqlClient): Promise<Readonly<Record<string, unknown>>> {
  return withQuantRebalanceCensusSnapshot(sql, async (tx) => (await takeCensus(tx)).report);
}

export async function runPlanCheck(sql: SqlClient, rawPlan: unknown): Promise<Readonly<Record<string, unknown>>> {
  const plan = parsePlan(rawPlan);
  if (plan === null) return { ok: false, code: "plan-invalid", reasons: ["plan-invalid"] };
  return withQuantRebalanceCensusSnapshot(sql, async (tx) => {
    const census = await takeCensus(tx);
    const reasons = planRefusals(census, plan);
    return reasons.length > 0 ? { ok: false, code: "plan-refused", reasons }
      : { ok: true, digest: census.digest, writes: plannedWrites(census, plan, dispositionDigest(plan)) };
  });
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

type Guard = Readonly<{
  assertOpen(): void; race<T>(work: Promise<T>): Promise<T>; dispose(): void;
}>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fence loss or the deadline aborts the run: outstanding waits reject and nothing new is dispatched. */
function createGuard(fences: readonly WorkerFence[], deadlineMs: number): Guard {
  const controller = new AbortController();
  const cancelled = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  cancelled.catch(() => undefined);
  for (const fence of fences) {
    fence.signal.addEventListener("abort", () => controller.abort(new CutoverRefusal("fence-lost")), { once: true });
  }
  const timer = setTimeout(() => controller.abort(new CutoverRefusal("deadline-exceeded")), deadlineMs);
  return {
    assertOpen() {
      try { for (const fence of fences) fence.assertOpen(); } catch { throw new CutoverRefusal("fence-lost"); }
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    race: (work) => Promise.race([work, cancelled]),
    dispose: () => clearTimeout(timer),
  };
}

/** No statement is dispatched once either barrier is lost or the deadline has passed. */
function fenceSql(tx: SqlClient, guard: Guard): SqlClient {
  const fenced: SqlClient = {
    ...(tx.transactionScope === undefined ? {} : { transactionScope: tx.transactionScope }),
    query: <Row>(text: string, params?: readonly unknown[], options?: SqlQueryOptions) => {
      guard.assertOpen();
      return tx.query<Row>(text, params, options);
    },
    transaction: (work) => work(fenced),
    close: async () => undefined,
  };
  return fenced;
}

function boundedClient(databaseUrl: string, timeoutMs: number, queryTimeoutMs?: number): pg.Client {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: timeoutMs,
    ...(queryTimeoutMs === undefined ? {} : { query_timeout: queryTimeoutMs, statement_timeout: queryTimeoutMs }),
    application_name: "4lpha-claim-cutover" });
  client.on("error", () => undefined); // a terminated backend must not raise an unhandled error event
  return client;
}

const TIMED_OUT = Symbol("timed-out");
/** `work`'s result, or TIMED_OUT once the absolute deadline has passed; the timer never outlives the call. */
async function beforeDeadline<T>(work: Promise<T>, deadlineAtMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadlineAtMs - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}
/** Closing a connection never waits more than a second, nor past the deadline. */
const closeClient = (client: pg.Client, deadlineAtMs: number = Date.now() + 1_000) =>
  beforeDeadline(client.end().catch(() => undefined), Math.min(deadlineAtMs, Date.now() + 1_000));

/** The cleanup clock: one absolute deadline for all cleanup, started by the first step that asks for it. */
function cleanupClock(budgetMs: number): () => number {
  let deadlineAtMs: number | undefined;
  return () => (deadlineAtMs ??= Date.now() + budgetMs);
}

/**
 * Terminate a backend from a separate, bounded connection and confirm it has left pg_stat_activity. Connecting,
 * terminating, every confirmation read and closing are all capped by the one absolute `deadlineAtMs`.
 */
export async function terminateBackend(databaseUrl: string, pid: number, deadlineAtMs: number = Date.now() + CUTOVER_CLEANUP_MS): Promise<boolean> {
  const control = boundedClient(databaseUrl, CONTROL_TIMEOUT_MS, CONTROL_TIMEOUT_MS);
  try {
    if (await beforeDeadline(control.connect(), deadlineAtMs) === TIMED_OUT) return false;
    if (await beforeDeadline(control.query("select pg_terminate_backend($1::int)", [pid]), deadlineAtMs) === TIMED_OUT) return false;
    while (Date.now() < deadlineAtMs) {
      const seen = await beforeDeadline(control.query("select 1 from pg_stat_activity where pid = $1::int", [pid]), deadlineAtMs);
      if (seen === TIMED_OUT) return false;
      if (seen.rows.length === 0) return true;
      await sleep(Math.min(CONFIRM_POLL_MS, Math.max(0, deadlineAtMs - Date.now())));
    }
    return false;
  } catch { return false; } finally { await closeClient(control, deadlineAtMs); }
}

type TransactionResult<T> =
  | Readonly<{ kind: "committed"; value: T }>
  | Readonly<{ kind: "rolled-back"; error: unknown; confirmed: boolean }>
  | Readonly<{ kind: "commit-unknown"; confirmed: boolean }>;

/**
 * The transaction runs on ONE pinned connection whose backend pid is known. Any failure before COMMIT is dispatched
 * terminates that backend (which rolls it back and frees its locks, even mid-statement) and confirms it is gone.
 * COMMIT is dispatched immediately after a fence/deadline assertion with nothing awaited in between, and only that
 * dispatch marks the outcome uncertain.
 */
async function runPinnedTransaction<T>(input: {
  readonly databaseUrl: string; readonly guard: Guard; readonly hooks: CutoverHooks; readonly cleanupDeadline: () => number;
  readonly work: (tx: SqlClient) => Promise<T>;
}): Promise<TransactionResult<T>> {
  const { guard, hooks, cleanupDeadline } = input;
  const client = boundedClient(input.databaseUrl, CONNECT_TIMEOUT_MS);
  let pid: number | null = null;
  let commitDispatched = false;
  let termination: Promise<boolean> | null = null;
  const terminate = (): Promise<boolean> => {
    termination ??= pid === null ? Promise.resolve(true)
      : beforeDeadline((hooks.terminate ?? ((target: number) => terminateBackend(input.databaseUrl, target, cleanupDeadline())))(pid), cleanupDeadline())
        .then((confirmed) => confirmed === true);
    return termination;
  };
  const raw: SqlClient = {
    transactionScope: "nested",
    query: async <Row>(text: string, params?: readonly unknown[]) => ({
      rows: (await client.query(text, params === undefined ? undefined : [...params])).rows as readonly Row[] }),
    transaction: (work) => work(raw),
    close: async () => undefined,
  };
  try {
    await guard.race(client.connect());
    guard.assertOpen();
    pid = Number((await guard.race(client.query("select pg_backend_pid() as pid"))).rows[0]?.pid);
    if (!Number.isSafeInteger(pid)) throw new CutoverRefusal("backend-pid-unavailable");
    guard.assertOpen();
    await guard.race(client.query("BEGIN"));
    const value = await guard.race(input.work(fenceSql(hooks.wrapTx === undefined ? raw : hooks.wrapTx(raw), guard)));
    // The handoff. Nothing may sit between this assertion and the dispatch of COMMIT.
    guard.assertOpen();
    commitDispatched = true;
    const commit = client.query("COMMIT");
    await guard.race(commit);
    return { kind: "committed", value };
  } catch (error) {
    const confirmed = await terminate().catch(() => false);
    return commitDispatched ? { kind: "commit-unknown", confirmed } : { kind: "rolled-back", error, confirmed };
  } finally {
    await closeClient(client, cleanupDeadline());
  }
}

/**
 * The disposition digest recorded in the marker, read on a fresh bounded connection: null when there is none,
 * undefined when it could not be read before the cleanup deadline.
 */
async function readMarkerDigest(databaseUrl: string, deadlineAtMs: number): Promise<string | null | undefined> {
  const client = boundedClient(databaseUrl, CONTROL_TIMEOUT_MS, CONTROL_TIMEOUT_MS);
  try {
    const rows = await beforeDeadline((async () => {
      await client.connect();
      return client.query(`select case when to_regclass('public.quant_wallet_claim_migration') is null then null else
        (select disposition_digest from quant_wallet_claim_migration where migration_version = 1) end as digest`);
    })(), deadlineAtMs);
    return rows === TIMED_OUT ? undefined : (rows.rows[0]?.digest as string | null | undefined) ?? null;
  } catch { return undefined; } finally { await closeClient(client, deadlineAtMs); }
}

async function cutoverWork(tx: SqlClient, plan: CutoverPlan, settings: { lockTimeoutMs: number; nowMs: () => number }) {
  await tx.query(`set local lock_timeout = '${Math.max(1, Math.trunc(settings.lockTimeoutMs))}ms'`);
  await tx.query("select pg_advisory_xact_lock($1::integer, hashtext($2))", [CUTOVER_LOCK_CLASSID, CUTOVER_LOCK_KEY]);
  // Writers to every census table are excluded from here to the end of the transaction, sorted so two
  // runs can never deadlock each other. The later ALTER upgrades this to ACCESS EXCLUSIVE.
  const locked = [...await readInventory(tx)].map(([table]) => table).sort(byCodepoint);
  if (locked.length > 0) await tx.query(`lock table ${locked.map((table) => `public.${ident(table)}`).join(", ")} in exclusive mode`);
  const original = await readInventory(tx);
  if ([...original.keys()].join("|") !== locked.join("|")) throw new CutoverRefusal("inventory-changed");

  const wallets = new Map<string, string[]>();
  if (original.get("quant_jobs")?.includes("trading_wallet") === true && original.get("quant_jobs")?.includes("quant_job_id") === true) {
    for (const row of (await tx.query<Record<string, string>>(
      `select quant_job_id, lower(trading_wallet) as wallet from quant_jobs order by quant_job_id`)).rows) {
      wallets.set(row["wallet"]!, [...(wallets.get(row["wallet"]!) ?? []), row["quant_job_id"]!]);
    }
  }
  for (const wallet of [...wallets.keys()].sort(byCodepoint)) {
    if (wallet === "") continue;
    if (!isAddress(wallet, { strict: false })) throw new CutoverRefusal("wallet-invalid");
    await lockQuantWalletClaim(tx, getAddress(wallet));
  }
  for (const jobId of [...wallets.values()].flat().sort(byCodepoint)) {
    await tx.query("select pg_advisory_xact_lock($1::integer, hashtext($2))", [QUANT_LOCK_CLASSID, jobId]);
  }

  // Validation on this locked read/write transaction, before any DDL. The journal check is read-only.
  const census = await takeCensus(tx, original);
  const reasons = planRefusals(census, plan);
  if (reasons.length > 0) throw new CutoverRefusal("plan-refused", reasons);

  await tx.query(QUANT_CLAIM_GENERATION_COLUMN_DDL);
  for (const statement of QUANT_REBALANCE_DDL) await tx.query(statement);

  // The schema change is exactly the listed additions, and the original digest domain is untouched.
  const after = await readInventory(tx);
  const expectedJobs = [...new Set([...(original.get("quant_jobs") ?? []), "claim_generation"])].sort(byCodepoint);
  const changed = [...original].some(([table, columns]) => table === "quant_jobs"
    ? (after.get(table) ?? []).join("|") !== expectedJobs.join("|") : (after.get(table) ?? []).join("|") !== columns.join("|"));
  const added = [...after.keys()].filter((table) => !original.has(table)).sort(byCodepoint);
  if (changed || added.join("|") !== [...NEW_TABLES].filter((table) => !original.has(table)).sort(byCodepoint).join("|")) {
    throw new CutoverRefusal("unexpected-schema-change");
  }
  if (await stableCensusDigest(tx, original) !== plan.censusDigest) throw new CutoverRefusal("census-changed-by-schema");

  const now = settings.nowMs();
  for (const group of plan.groups) {
    const holder = census.jobs.find((job) => job.jobId === group.holderJobId)!;
    await tx.query(
      `/* quantClaimCutover.claim */ insert into quant_wallet_claims
       (chain_id,wallet_address,mode,strategy_kind,strategy_id,job_id,attempt_id,generation,row_version,provisional_expires_at_ms,last_refusal,updated_at_ms)
       values (56,$1,'active','grid',$2,$3,null,1,1,null,null,$4::bigint)`,
      [group.wallet, holder.strategyId, holder.jobId, now],
    );
    const updated = await tx.query(
      `/* quantClaimCutover.holder */ update quant_jobs set claim_generation = 1, row_version = row_version + 1, updated_at_ms = $2::bigint
       where quant_job_id = $1 and row_version = $3::int and claim_generation is null returning quant_job_id`,
      [holder.jobId, now, holder.rowVersion],
    );
    if (updated.rows.length !== 1) throw new CutoverRefusal("holder-cas-missed", [holder.jobId]);
  }
  const digest = dispositionDigest(plan);
  await tx.query(
    `/* quantClaimCutover.marker */ insert into quant_wallet_claim_migration
     (migration_version, census_digest, disposition_digest, installed_at_ms, installed_by) values (1,$1,$2,$3::bigint,$4)`,
    [plan.censusDigest, digest, now, INSTALLED_BY],
  );
  return { dispositionDigest: digest, holders: plan.groups.length };
}

/** The stock singleton lock connection (same options), built here because supplying the loss lifecycle means supplying the client. */
class CutoverLockClient implements WorkerLockClient {
  readonly #client: pg.Client;
  constructor(databaseUrl: string) {
    this.#client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000,
      statement_timeout: 5_000, application_name: "4lpha-worker-singleton" });
  }
  async connect(): Promise<void> { await this.#client.connect(); }
  query(text: string, values: readonly number[]) { return this.#client.query<Record<string, unknown>>(text, [...values]); }
  on(event: "error" | "end", listener: ((error: Error) => void) | (() => void)): this {
    if (event === "error") this.#client.on("error", listener as (error: Error) => void);
    else this.#client.on("end", listener as () => void);
    return this;
  }
  end(): Promise<void> { return this.#client.end(); }
}

/**
 * The cutover's own singleton-loss lifecycle. The stock one exits the process on the next turn, which would strand
 * the pinned backend mid-statement with the table locks held. A lost lease still latches its fence at once (no new
 * statement is dispatched and the run terminates its backend); only after the run's bounded cleanup does the
 * process fail-stop, non-zero, if it is still alive once the printed outcome has had time to flush.
 */
function singletonLossLifecycle(): { readonly dependencies: WorkerSingletonDependencies; cleanedUp(): void } {
  let cleaned!: () => void;
  const done = new Promise<void>((resolve) => { cleaned = resolve; });
  return {
    cleanedUp: () => cleaned(),
    dependencies: {
      createClient: (databaseUrl) => new CutoverLockClient(databaseUrl),
      reportFatal: (message) => console.error(message),
      schedule: (callback) => { setImmediate(callback); },
      markNonzero: () => { process.exitCode = 1; },
      terminate: (code) => { void done.then(() => { setTimeout(() => process.exit(code), EXIT_FLUSH_MS).unref(); }); },
    },
  };
}

async function acquireBarriers(hooks: CutoverHooks, databaseUrl: string, dependencies: WorkerSingletonDependencies): Promise<WorkerSingletonLease[]> {
  const acquire = hooks.acquire ?? acquireWorkerSingleton;
  const held: WorkerSingletonLease[] = [];
  try {
    for (const role of ["quant-worker", "quant-rebalance-worker"] as const) {
      const lease = await acquire({ role, databaseUrl, dependencies });
      if (lease.kind !== "acquired") throw new CutoverRefusal("workers-not-drained");
      held.push(lease);
    }
    return held;
  } catch (error) {
    await releaseBarriers(held, Date.now() + (hooks.cleanupMs ?? CUTOVER_CLEANUP_MS));
    throw error instanceof CutoverRefusal ? error
      : new CutoverRefusal(error instanceof Error && error.message === "Worker singleton is already owned."
        ? "workers-not-drained" : "barrier-unavailable");
  }
}

/** Releases the barriers in reverse order, each capped by the absolute deadline; false when any release failed or ran out of time. */
async function releaseBarriers(held: readonly WorkerSingletonLease[], deadlineAtMs: number): Promise<boolean> {
  let clean = true;
  for (const lease of [...held].reverse()) {
    try { if (await beforeDeadline(lease.closeGracefully(), deadlineAtMs) === TIMED_OUT) clean = false; } catch { clean = false; }
  }
  return clean;
}

export async function applyCutover(input: {
  readonly databaseUrl: string; readonly plan: unknown; readonly hooks?: CutoverHooks;
}): Promise<CutoverOutcome> {
  const hooks = input.hooks ?? {};
  const plan = parsePlan(input.plan);
  if (plan === null) return { kind: "refused", code: "plan-invalid", details: [] };
  const loss = singletonLossLifecycle();
  try { return await applyPlan(input.databaseUrl, plan, hooks, loss.dependencies); } finally { loss.cleanedUp(); }
}

async function applyPlan(databaseUrl: string, plan: CutoverPlan, hooks: CutoverHooks, dependencies: WorkerSingletonDependencies): Promise<CutoverOutcome> {
  const digest = dispositionDigest(plan);
  let barriers: WorkerSingletonLease[];
  try { barriers = await acquireBarriers(hooks, databaseUrl, dependencies); }
  catch (error) { return { kind: "refused", code: error instanceof CutoverRefusal ? error.code : "barrier-unavailable", details: [] }; }

  const guard = createGuard(barriers.map((lease) => lease.fence), hooks.deadlineMs ?? CUTOVER_DEADLINE_MS);
  const cleanupDeadline = cleanupClock(hooks.cleanupMs ?? CUTOVER_CLEANUP_MS);
  let outcome: CutoverOutcome;
  try {
    const result = await runPinnedTransaction({ databaseUrl, guard, hooks, cleanupDeadline,
      work: (tx) => cutoverWork(tx, plan, { lockTimeoutMs: hooks.lockTimeoutMs ?? CUTOVER_LOCK_TIMEOUT_MS, nowMs: hooks.nowMs ?? Date.now }) });
    if (result.kind === "committed") {
      outcome = { kind: "applied", censusDigest: plan.censusDigest, dispositionDigest: result.value.dispositionDigest, holders: result.value.holders };
    } else if (result.kind === "commit-unknown") {
      // COMMIT was dispatched and its outcome is unknown: never claim a rollback, never retry. Once the backend is
      // confirmed gone the transaction has either committed or not, so the marker check is conclusive; when the
      // termination was not confirmed the backend may still commit, and the outcome says so.
      const found = result.confirmed ? await readMarkerDigest(databaseUrl, cleanupDeadline()) : undefined;
      outcome = { kind: "outcome-unknown", dispositionDigest: digest, markerPresent: found === undefined ? null : found === digest,
        terminationConfirmed: result.confirmed };
    } else {
      const unconfirmed = result.confirmed ? [] : ["rollback-unconfirmed"];
      outcome = result.error instanceof CutoverRefusal
        ? { kind: "refused", code: result.error.code, details: [...result.error.details, ...unconfirmed] }
        : { kind: "refused", code: pgCode(result.error), details: unconfirmed };
    }
  } finally {
    guard.dispose();
  }
  const clean = await releaseBarriers(barriers, cleanupDeadline());
  return outcome.kind === "applied" && !clean ? { ...outcome, kind: "applied-with-cleanup-failure" } : outcome;
}

function pgCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "55P03") return "lock-timeout";
  if (code === "40P01") return "deadlock";
  return error instanceof Error && /^[a-z0-9-]{1,80}$/u.test(error.message) ? error.message : "cutover-error";
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

export type CutoverArgs =
  | Readonly<{ command: "census" }>
  | Readonly<{ command: "plan-check"; plan: string }>
  | Readonly<{ command: "apply"; plan: string; yesLive: boolean }>;

export function parseCutoverArgs(argv: readonly string[]): CutoverArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (flag === "--yes-live" && command === "apply") { if (flags.has(flag)) throw new Error("usage"); flags.set(flag, true); continue; }
    if (flag === "--plan" && (command === "plan-check" || command === "apply")) {
      const value = rest[index + 1];
      if (flags.has(flag) || value === undefined || value.startsWith("--")) throw new Error("usage");
      flags.set(flag, value); index += 1; continue;
    }
    throw new Error("usage");
  }
  if (command === "census" && flags.size === 0) return { command };
  const plan = flags.get("--plan");
  if (typeof plan === "string" && command === "plan-check" && flags.size === 1) return { command, plan };
  if (typeof plan === "string" && command === "apply") return { command, plan, yesLive: flags.get("--yes-live") === true };
  throw new Error("usage");
}

const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item, 2);

export async function main(argv: readonly string[] = process.argv.slice(2), env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const args = parseCutoverArgs(argv);
  const databaseUrl = env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") throw new Error("database-url-required");
  if (args.command === "apply" && args.yesLive) {
    const outcome = await applyCutover({ databaseUrl, plan: JSON.parse(readFileSync(args.plan, "utf8")) as unknown });
    console.log(json(outcome));
    return outcome.kind === "applied" ? 0 : outcome.kind === "outcome-unknown" ? 2 : 1;
  }
  const sql = await createPgSqlClient(databaseUrl);
  try {
    if (args.command === "census") { console.log(json({ command: "census", ...await runCensus(sql) })); return 0; }
    const result = await runPlanCheck(sql, JSON.parse(readFileSync(args.plan, "utf8")) as unknown);
    console.log(json({ command: args.command === "apply" ? "apply (dry: no --yes-live)" : "plan-check", ...result }));
    return result["ok"] === true ? 0 : 1;
  } finally { await sql.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    const code = error instanceof Error && /^[a-z0-9-]{1,80}$/u.test(error.message) ? error.message : "cutover-error";
    console.error(`[quant-claim-cutover] failed: ${sanitizeMessage(code)}`);
    process.exitCode = 1;
  });
}

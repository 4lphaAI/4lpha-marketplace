/** Read-only census readers shared by the rebalance CLI and the claim-cutover tool. */
import { getAddress } from "viem";
import { decodeJsonb } from "../store/codec.js";
import type { SqlClient } from "../store/sql.js";
import type { QuantActionRow, QuantJobRow } from "../store/quantJobs.js";
import type { QuantRebalanceReceiptOwnership } from "./rebalanceTypes.js";

export type Tables = Readonly<Record<
  "gridJobs" | "gridActions" | "rebalanceJobs" | "rebalanceChecks" | "rebalanceActions" | "claims" | "claimMigration" | "receiptOwnership" | "journal",
  boolean
>>;

/** Keep every census read on one repeatable-read, read-only connection. */
export async function withQuantRebalanceCensusSnapshot<T>(
  sql: SqlClient,
  read: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  return sql.transaction(async (tx) => {
    await tx.query("set transaction isolation level repeatable read, read only");
    return read(tx);
  });
}

export async function tableInventory(sql: SqlClient): Promise<Tables> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.tables */ select
    to_regclass('public.quant_jobs') is not null as grid_jobs,
    to_regclass('public.quant_actions') is not null as grid_actions,
    to_regclass('public.quant_rebalance_jobs') is not null as rebalance_jobs,
    to_regclass('public.quant_rebalance_checks') is not null as rebalance_checks,
    to_regclass('public.quant_rebalance_actions') is not null as rebalance_actions,
    to_regclass('public.quant_wallet_claims') is not null as claims,
    to_regclass('public.quant_wallet_claim_migration') is not null as claim_migration,
    to_regclass('public.quant_receipt_ownership') is not null as receipt_ownership,
    to_regclass('public.execution_journal') is not null as journal`);
  const row = result.rows[0] ?? {};
  return {
    gridJobs: row["grid_jobs"] === true, gridActions: row["grid_actions"] === true,
    rebalanceJobs: row["rebalance_jobs"] === true, rebalanceChecks: row["rebalance_checks"] === true,
    rebalanceActions: row["rebalance_actions"] === true, claims: row["claims"] === true,
    claimMigration: row["claim_migration"] === true, receiptOwnership: row["receipt_ownership"] === true,
    journal: row["journal"] === true,
  };
}

export function bigint(value: unknown): bigint | null {
  const decoded = decodeJsonb(value);
  if (typeof decoded === "bigint") return decoded;
  value = decoded;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  return null;
}
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeJsonb(value);
  const parsed = typeof decoded === "bigint" ? Number(decoded) : typeof decoded === "number" ? decoded : Number(decoded);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
export function textOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }

export async function readGridJobs(sql: SqlClient): Promise<readonly Record<string, unknown>[]> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.gridJobs */ select
    quant_job_id,strategy_id,trading_wallet,status,row_version,allocation_u_wei,ends_at_ms,
    session_expires_at_ms,revoked_at_ms,admitted_at_ms,hold_code,accounting_state,
    accounting_epoch,accounting_rev,reported_at_ms,session_expiry
    from quant_jobs order by lower(trading_wallet),quant_job_id`);
  return result.rows;
}

export async function readGridActions(sql: SqlClient): Promise<readonly Record<string, unknown>[]> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.gridActions */ select
    journal_key,quant_job_id,level_index,action_seq,side,state,amount_in_wei,min_out_wei,quote_out_wei,
    quote_block,deadline_sec,calls_json,tx_hash,fill_in_wei,fill_out_wei,row_version
    from quant_actions order by quant_job_id,created_at_ms,journal_key`);
  return result.rows;
}

export async function readReceiptOwnership(sql: SqlClient): Promise<readonly QuantRebalanceReceiptOwnership[]> {
  const result = await sql.query<Record<string, unknown>>(`/* quantRebalanceCli.receiptOwnership */ select
    tx_hash,trading_wallet,swap_log_index,journal_key from quant_receipt_ownership order by tx_hash,trading_wallet,swap_log_index`);
  return result.rows.map((row) => ({
    txHash: String(row["tx_hash"]) as `0x${string}`, wallet: getAddress(String(row["trading_wallet"])),
    swapLogIndex: bigint(row["swap_log_index"]) ?? 0n, journalKey: String(row["journal_key"]),
  }));
}

/** The census projection of raw Grid rows: only the fields `buildQuantWalletCensus` reads. */
export function gridCensusJobs(rows: readonly Record<string, unknown>[]): readonly QuantJobRow[] {
  return rows.map((row) => ({
    quantJobId: String(row["quant_job_id"]), strategyId: String(row["strategy_id"]),
    tradingWallet: getAddress(String(row["trading_wallet"])), status: String(row["status"]),
    rowVersion: Number(row["row_version"]), admittedAtMs: numberOrNull(row["admitted_at_ms"]),
    sessionExpiry: numberOrNull(row["session_expiry"]), revokedAtMs: numberOrNull(row["revoked_at_ms"]),
    accountingState: String(row["accounting_state"]), accountingEpoch: numberOrNull(row["accounting_epoch"]),
    accountingRev: bigint(row["accounting_rev"]) ?? 0n,
  }) as unknown as QuantJobRow);
}

export function gridCensusActions(rows: readonly Record<string, unknown>[]): readonly QuantActionRow[] {
  return rows.map((row) => ({
    journalKey: String(row["journal_key"]), quantJobId: String(row["quant_job_id"]),
    levelIndex: Number(row["level_index"]), actionSeq: Number(row["action_seq"]), side: String(row["side"]),
    state: String(row["state"]), amountInWei: bigint(row["amount_in_wei"]) ?? 0n,
    minOutWei: bigint(row["min_out_wei"]) ?? 0n, quoteOutWei: bigint(row["quote_out_wei"]) ?? 0n,
    quoteBlock: bigint(row["quote_block"]) ?? 0n, deadlineSec: Number(row["deadline_sec"]),
    callsJson: String(row["calls_json"] ?? ""), txHash: textOrNull(row["tx_hash"]),
    fillInWei: bigint(row["fill_in_wei"]), fillOutWei: bigint(row["fill_out_wei"]), rowVersion: Number(row["row_version"]),
  }) as unknown as QuantActionRow);
}

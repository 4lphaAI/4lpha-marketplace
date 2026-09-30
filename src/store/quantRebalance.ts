/** Dedicated durable store for TermiX Quant's fixed-basket rebalancing strategy. */
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { decodeJsonb, encodeJsonbParam } from "./codec.js";
import { createPgSqlClient, type SqlClient } from "./sql.js";
import {
  lockQuantWalletClaim, quantWalletClaimActiveOn, quantWalletClaimProvisionalOn,
  QUANT_WALLET_CLAIMS_DDL, QUANT_WALLET_CLAIM_MIGRATION_DDL,
} from "./quantWalletClaims.js";
import type { QuantWalletClaimStore } from "./quantWalletClaims.js";
import {
  isVerifiedQuantRebalanceReceiptProof, isVerifiedQuantRebalanceFailureProof,
  isVerifiedQuantRebalanceNotExecutedProof, isVerifiedQuantRebalanceRetirementProof,
  type VerifiedQuantRebalanceReceiptProof, type VerifiedQuantRebalanceNotExecutedProof,
  type VerifiedQuantRebalanceRetirementProof, type QuantRebalanceFailureEvidence,
} from "./quantRebalanceProof.js";
import type {
  QuantRebalanceActionRow, QuantRebalanceActionState, QuantRebalanceCheckKind,
  QuantRebalanceCheckRow, QuantRebalanceCheckState, QuantRebalanceJobRow,
  QuantRebalanceJobWire, QuantRebalanceReceiptOwnership,
  RebalanceBalanceVector,
} from "../quant/rebalanceTypes.js";
import type { RebalanceRiskAsset } from "../quant/rebalancePolicy.js";
import type { ExecutionJournal, JournalBeginInput } from "./journal.js";

const REBALANCE_MAX_BLOCK_LAG = 40n;
const REBALANCE_MAX_QUOTE_AGE_MS = 30_000;
const REBALANCE_MAX_REPORT_ATTEMPTS = 24;
type StoredManagedVector = Readonly<Record<"USDC" | "WBNB" | "ETH" | "CAKE", bigint>>;
type StoredCostBasisVector = Readonly<Record<"WBNB" | "ETH" | "CAKE", bigint>>;

function applyStoredVerifiedFill(
  managed: StoredManagedVector,
  costBasis: StoredCostBasisVector,
  fill: { readonly side: "buy" | "sell"; readonly asset: "WBNB" | "ETH" | "CAKE"; readonly fillInWei: bigint; readonly fillOutWei: bigint },
): { readonly managed: StoredManagedVector; readonly costBasis: StoredCostBasisVector; readonly realizedDeltaUsdcWei: bigint } {
  const limit = 1n << 256n;
  if (fill.fillInWei <= 0n || fill.fillOutWei <= 0n || fill.fillInWei >= limit || fill.fillOutWei >= limit) throw new Error("quant-rebalance-fill-invalid");
  if (fill.side === "buy") {
    if (managed.USDC < fill.fillInWei) throw new Error("quant-rebalance-fill-exceeds-cash");
    const nextManaged = { ...managed, USDC: managed.USDC - fill.fillInWei, [fill.asset]: managed[fill.asset] + fill.fillOutWei };
    const nextBasis = { ...costBasis, [fill.asset]: costBasis[fill.asset] + fill.fillInWei };
    if (nextManaged[fill.asset] >= limit || nextBasis[fill.asset] >= limit) throw new Error("quant-rebalance-fill-overflow");
    return { managed: nextManaged, costBasis: nextBasis, realizedDeltaUsdcWei: 0n };
  }
  const quantity = managed[fill.asset];
  if (quantity < fill.fillInWei) throw new Error("quant-rebalance-fill-exceeds-token");
  const basisShare = fill.fillInWei === quantity ? costBasis[fill.asset] : costBasis[fill.asset] * fill.fillInWei / quantity;
  const nextManaged = { ...managed, USDC: managed.USDC + fill.fillOutWei, [fill.asset]: quantity - fill.fillInWei };
  const nextBasis = { ...costBasis, [fill.asset]: costBasis[fill.asset] - basisShare };
  if (nextManaged.USDC >= limit) throw new Error("quant-rebalance-fill-overflow");
  return { managed: nextManaged, costBasis: nextBasis, realizedDeltaUsdcWei: fill.fillOutWei - basisShare };
}

export type RebalanceCas<T> =
  | { readonly kind: "ok"; readonly record: T }
  | { readonly kind: "conflict"; readonly record: T | null }
  | { readonly kind: "inconsistent"; readonly code: "claim-missing" | "action-unresolved" | "receipt-owned" | "revision-changed" | "asset-already-taken" };

export type RebalanceAdmissionInput = {
  readonly jobId: string;
  readonly expectedRowVersion: number;
  readonly attemptId: string;
  readonly claimGeneration: bigint;
  readonly policyJson: string;
  readonly policyDigest: Hex;
  readonly tier: "low" | "high";
  readonly sessionPublicKey: Hex;
  readonly sessionExpirySec: number;
  readonly permissionsDigest: Hex;
  readonly projectionDigest: Hex;
  readonly descriptorJson: string;
  readonly projectionJson: string;
  readonly capRowsJson: string;
  readonly baselineBlock: bigint;
  readonly baselineHash: Hex;
  readonly baselineAtMs: number;
  readonly actualBaseline: RebalanceBalanceVector;
  readonly protectedBaseline: RebalanceBalanceVector;
  readonly nowMs: number;
};

export type RebalanceActionInsertInput = Omit<QuantRebalanceActionRow,
  "actionId" | "journalKey" | "state" | "txHash" | "fillInWei" | "fillOutWei" | "receiptBlockNumber" | "receiptBlockHash"
  | "plannedAccountingRev" | "plannedCheckVersion" | "swapLogIndices" | "proofDigest" | "preSubmitBlockNumber" | "preSubmitBlockHash"
  | "failureCode" | "ambiguousCause" | "resolutionJson" | "rowVersion" | "createdAtMs" | "updatedAtMs">
  & { readonly expectedJobRevision: bigint; readonly expectedCheckVersion: number; readonly nowMs: number };

export type RebalanceSubmitSnapshot = {
  readonly job: QuantRebalanceJobRow;
  readonly check: QuantRebalanceCheckRow;
  readonly action: QuantRebalanceActionRow;
};

export type RebalanceSubmitJournalBegin = Readonly<{
  readonly journal: ExecutionJournal;
  readonly input: JournalBeginInput;
  readonly sinceMs: number;
}>;

export type QuantRebalanceStore = {
  ensureSchema(): Promise<void>;
  schemaReady(): Promise<boolean>;
  discoverJob(input: { readonly wire: QuantRebalanceJobWire; readonly envelopeJson: string | null; readonly envelopeId: string | null; readonly nowMs: number }): Promise<QuantRebalanceJobRow>;
  getJob(jobId: string): Promise<QuantRebalanceJobRow | null>;
  listJobs(): Promise<readonly QuantRebalanceJobRow[]>;
  listWorkableJobs(strategyId: string): Promise<readonly QuantRebalanceJobRow[]>;
  admit(input: RebalanceAdmissionInput, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceJobRow>>;
  setHold(input: { readonly jobId: string; readonly code: string; readonly evidenceJson: string | null; readonly nowMs: number }): Promise<void>;
  listChecks(jobId: string): Promise<readonly QuantRebalanceCheckRow[]>;
  beginCheck(input: { readonly jobId: string; readonly kind: QuantRebalanceCheckKind; readonly slot: number; readonly state: QuantRebalanceCheckState; readonly evidenceJson: string; readonly expectedJobRevision: bigint; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceCheckRow>>;
  updateCheck(input: { readonly checkId: string; readonly expectedRowVersion: number; readonly state: QuantRebalanceCheckState; readonly evidenceJson: string; readonly takenAssets: readonly RebalanceRiskAsset[]; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceCheckRow>>;
  listActions(jobId: string): Promise<readonly QuantRebalanceActionRow[]>;
  getAction(actionId: string): Promise<QuantRebalanceActionRow | null>;
  listUnresolvedActions(jobId?: string): Promise<readonly QuantRebalanceActionRow[]>;
  insertAction(input: RebalanceActionInsertInput, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  beginJournalForIntended(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly claimGeneration: bigint; readonly journalBegin: RebalanceSubmitJournalBegin; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  markSubmitted(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly claimGeneration: bigint; readonly blockNumber: bigint; readonly blockHash: Hex; readonly nowMs: number; readonly revalidate: (snapshot: RebalanceSubmitSnapshot) => Promise<boolean> }, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  abortIntendedAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly expectedJournalState: "absent" | "PENDING" | "ROLLED_BACK"; readonly reasonCode?: string; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  failAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly evidence: QuantRebalanceFailureEvidence; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  markAmbiguous(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly state: "unknown" | "committed-unverified"; readonly cause: string; readonly txHash?: Hex; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  settleAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly proof: VerifiedQuantRebalanceReceiptProof; readonly ownership: readonly QuantRebalanceReceiptOwnership[]; readonly nowMs: number }, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  completeCheck(input: { readonly checkId: string; readonly expectedJobRevision: bigint; readonly expectedCheckVersion: number; readonly nextEligibleSlot: number; readonly bootstrapComplete: boolean; readonly evidenceJson?: string; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>>;
  markEnded(input: { readonly jobId: string; readonly unresolved: boolean; readonly nowMs: number }): Promise<void>;
  recordReportAttempt(input: { readonly jobId: string; readonly payloadDigest: Hex; readonly responseStatus: number; readonly notesApplied: number | null; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>>;
  resolveNotExecuted(input: { readonly actionId: string; readonly expectedActionVersion: number; readonly expectedJobVersion: number; readonly expectedCheckVersion: number; readonly proof: VerifiedQuantRebalanceNotExecutedProof; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>>;
  retireJob(input: { readonly jobId: string; readonly expectedRowVersion: number; readonly proof: VerifiedQuantRebalanceRetirementProof; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>>;
  markReported(input: { readonly jobId: string; readonly nowMs: number }): Promise<boolean>;
  close(): Promise<void>;
};

export const REBALANCE_ACTION_TERMINAL: ReadonlySet<QuantRebalanceActionState> = new Set(["settled", "failed", "aborted"]);
const CLAIM_STRATEGY_KIND = "rebalance" as const;
type QuantRebalanceJournalProofReader = (journalKey: string) => Promise<{
  readonly state: string; readonly hasCallsId: boolean; readonly txHash: Hex | null;
} | null>;

function clone<T>(value: T): T { return structuredClone(value); }
function actionKey(jobId: string, checkId: string, sequence: bigint): string {
  return keccak256(stringToBytes(`quant-rebalance:v1|${jobId}|${checkId}|${sequence.toString(10)}`));
}
function checkKey(jobId: string, kind: QuantRebalanceCheckKind, slot: number): string {
  return `quant-rebalance:v1|${jobId}|${kind}|${slot}`;
}
function emptyBasis(): StoredCostBasisVector { return { WBNB: 0n, ETH: 0n, CAKE: 0n }; }

function parseJsonb(value: unknown): unknown {
  const decoded = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return decodeJsonb(decoded);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validJobRow(value: unknown): value is QuantRebalanceJobRow {
  if (!isRecord(value)) return false;
  const statuses = new Set(["discovered", "admitted", "held", "paused", "ended", "ended-unresolved", "reported"]);
  return typeof value["jobId"] === "string" && typeof value["strategyId"] === "string"
    && typeof value["tradingWallet"] === "string" && statuses.has(String(value["status"]))
    && typeof value["allocationWei"] === "bigint" && typeof value["rowVersion"] === "number"
    && Number.isSafeInteger(value["rowVersion"]) && (value["claimGeneration"] === null || typeof value["claimGeneration"] === "bigint")
    && typeof value["reportAttempts"] === "number" && Number.isSafeInteger(value["reportAttempts"])
    && value["reportAttempts"] >= 0
    && (value["reportPayloadDigest"] === null || typeof value["reportPayloadDigest"] === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value["reportPayloadDigest"]))
    && (value["reportResponseStatus"] === null || typeof value["reportResponseStatus"] === "number" && Number.isSafeInteger(value["reportResponseStatus"]))
    && (value["reportNotesApplied"] === null || typeof value["reportNotesApplied"] === "number" && Number.isSafeInteger(value["reportNotesApplied"]))
    && (value["retirementEvidenceJson"] === null || typeof value["retirementEvidenceJson"] === "string")
    && (value["managed"] === null || isRecord(value["managed"])) && (value["costBasis"] === null || isRecord(value["costBasis"]));
}
function validActionRow(value: unknown): value is QuantRebalanceActionRow {
  if (!isRecord(value)) return false;
  const states = new Set(["intended", "submitted", "committed-unverified", "unknown", "needs-operator", "settled", "failed", "aborted", "retired"]);
  return typeof value["actionId"] === "string" && typeof value["jobId"] === "string"
    && typeof value["journalKey"] === "string" && states.has(String(value["state"]))
    && typeof value["sequence"] === "bigint" && typeof value["rowVersion"] === "number"
    && (value["realizedDeltaUsdcWei"] === undefined || value["realizedDeltaUsdcWei"] === null || typeof value["realizedDeltaUsdcWei"] === "bigint");
}
function decodeJob(value: unknown): QuantRebalanceJobRow {
  const parsed = parseJsonb(value);
  if (!validJobRow(parsed)) throw new Error("quant-rebalance-job-row-invalid");
  return parsed;
}
function decodeCheck(value: unknown): QuantRebalanceCheckRow {
  const parsed = parseJsonb(value);
  if (!isRecord(parsed) || typeof parsed["checkId"] !== "string" || typeof parsed["jobId"] !== "string"
    || !(parsed["kind"] === "bootstrap" || parsed["kind"] === "scheduled")
    || !(parsed["state"] === "held" || parsed["state"] === "rebalancing" || parsed["state"] === "done")
    || typeof parsed["slot"] !== "number" || !Array.isArray(parsed["takenAssets"])) throw new Error("quant-rebalance-check-row-invalid");
  return parsed as unknown as QuantRebalanceCheckRow;
}
function decodeAction(value: unknown): QuantRebalanceActionRow {
  const parsed = parseJsonb(value);
  if (!validActionRow(parsed)) throw new Error("quant-rebalance-action-row-invalid");
  return parsed;
}

export const QUANT_REBALANCE_DDL: readonly string[] = Object.freeze([
  `create table if not exists quant_rebalance_jobs (
     job_id text primary key, strategy_id text not null, wallet_address text not null,
     status text not null check (status in ('discovered','admitted','held','paused','ended','ended-unresolved','reported')),
     admitted_at_ms bigint null, baseline_json jsonb null, managed_json jsonb null,
     claim_generation numeric null, row_version int not null, data_json jsonb not null,
     created_at_ms bigint not null, updated_at_ms bigint not null
   )`,
  `create index if not exists quant_rebalance_jobs_wallet_idx on quant_rebalance_jobs(wallet_address)`,
  `create table if not exists quant_rebalance_checks (
     check_id text primary key, job_id text not null references quant_rebalance_jobs(job_id),
     check_kind text not null check(check_kind in ('bootstrap','scheduled')), slot int not null,
     state text not null check(state in ('held','rebalancing','done')), row_version int not null,
     data_json jsonb not null, created_at_ms bigint not null, updated_at_ms bigint not null,
     unique(job_id,check_kind,slot)
   )`,
  `create table if not exists quant_rebalance_actions (
     action_id text primary key, journal_key text not null unique, job_id text not null references quant_rebalance_jobs(job_id),
     check_id text not null references quant_rebalance_checks(check_id),
     state text not null check(state in ('intended','submitted','committed-unverified','unknown','needs-operator','settled','failed','aborted','retired')),
     tx_hash text null, row_version int not null, data_json jsonb not null, created_at_ms bigint not null, updated_at_ms bigint not null
   )`,
  `create index if not exists quant_rebalance_actions_job_idx on quant_rebalance_actions(job_id,created_at_ms)`,
  `create table if not exists quant_receipt_ownership (
     tx_hash text not null, trading_wallet text not null, swap_log_index numeric not null,
     journal_key text not null, created_at_ms bigint not null,
     primary key(tx_hash,trading_wallet,swap_log_index)
   )`,
  QUANT_WALLET_CLAIMS_DDL,
  QUANT_WALLET_CLAIM_MIGRATION_DDL,
]);

/* -------------------------------------------------------------------------- */
/* Memory backend — every method mirrors its durable CAS and ownership rule.  */
/* -------------------------------------------------------------------------- */

export class MemoryQuantRebalanceStore implements QuantRebalanceStore {
  readonly #jobs = new Map<string, QuantRebalanceJobRow>();
  readonly #checks = new Map<string, QuantRebalanceCheckRow>();
  readonly #actions = new Map<string, QuantRebalanceActionRow>();
  readonly #ownership = new Map<string, QuantRebalanceReceiptOwnership>();
  constructor(private readonly claims?: QuantWalletClaimStore, private readonly journalProofReader?: QuantRebalanceJournalProofReader) {}
  async ensureSchema(): Promise<void> {}
  async schemaReady(): Promise<boolean> { return true; }
  async discoverJob(input: { readonly wire: QuantRebalanceJobWire; readonly envelopeJson: string | null; readonly envelopeId: string | null; readonly nowMs: number }): Promise<QuantRebalanceJobRow> {
    const prior = this.#jobs.get(input.wire.id);
    if (prior !== undefined) {
      const changed = prior.wireDigest.toLowerCase() !== input.wire.wireDigest.toLowerCase();
      const next: QuantRebalanceJobRow = prior.status === "discovered"
        ? { ...prior, strategyId: input.wire.strategyId, tradingWallet: getAddress(input.wire.tradingWalletAddress),
          allocationWei: input.wire.allocationUWei, dailyCapWei: input.wire.dailyCapUWei,
          termDays: input.wire.termDays, startedAtMs: input.wire.startedAtMs ?? 0,
          endsAtMs: input.wire.endsAtMs ?? 0, sessionExpiresAtMs: input.wire.sessionExpiresAtMs ?? 0,
          revokedAtMs: input.wire.revokedAtMs, platformStatus: input.wire.status,
          wireJson: encodeJsonbParam(input.wire), wireDigest: input.wire.wireDigest,
          envelopeJson: input.envelopeJson ?? prior.envelopeJson, envelopeId: input.envelopeId ?? prior.envelopeId,
          rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs }
        : { ...prior, platformStatus: input.wire.status, revokedAtMs: input.wire.revokedAtMs,
        ...(changed ? { status: "held" as const, holdCode: "wire-changed" } : {}),
        wireJson: encodeJsonbParam(input.wire), wireDigest: input.wire.wireDigest,
        envelopeJson: input.envelopeJson ?? prior.envelopeJson, envelopeId: input.envelopeId ?? prior.envelopeId,
        rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
      this.#jobs.set(next.jobId, next); return clone(next);
    }
    const wire = input.wire;
    const row: QuantRebalanceJobRow = {
      jobId: wire.id, strategyId: wire.strategyId, tradingWallet: getAddress(wire.tradingWalletAddress),
      allocationWei: wire.allocationUWei, dailyCapWei: wire.dailyCapUWei, termDays: wire.termDays,
      startedAtMs: wire.startedAtMs ?? 0, endsAtMs: wire.endsAtMs ?? 0,
      sessionExpiresAtMs: wire.sessionExpiresAtMs ?? 0, revokedAtMs: wire.revokedAtMs,
      platformStatus: wire.status, status: "discovered", wireJson: encodeJsonbParam(wire), wireDigest: wire.wireDigest,
      envelopeJson: input.envelopeJson, envelopeId: input.envelopeId, admittedAtMs: null,
      policyJson: null, policyDigest: null, tier: null, sessionPublicKey: null, sessionExpirySec: null,
      permissionsDigest: null, projectionDigest: null, descriptorJson: null, projectionJson: null, capRowsJson: null,
      claimGeneration: null, baselineBlock: null, baselineHash: null, baselineAtMs: null,
      actualBaselineJson: null, protectedBaselineJson: null, managed: null, costBasis: null,
      accountingRev: 0n, checkRev: 0n, nextEligibleSlot: 0, actionSequence: 0n, lastDeadlineSec: 0,
      bootstrapComplete: false, externalActivity: false, holdCode: null, holdEvidenceJson: null,
      reportAttempts: 0, reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null,
      reportedAtMs: null, retiredAtMs: null, retirementEvidenceJson: null,
      rowVersion: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
    };
    this.#jobs.set(row.jobId, row); return clone(row);
  }
  async getJob(jobId: string): Promise<QuantRebalanceJobRow | null> { const row = this.#jobs.get(jobId); return row === undefined ? null : clone(row); }
  async listJobs(): Promise<readonly QuantRebalanceJobRow[]> { return [...this.#jobs.values()].map(clone); }
  async listWorkableJobs(strategyId: string): Promise<readonly QuantRebalanceJobRow[]> {
    return [...this.#jobs.values()].filter((row) => row.strategyId === strategyId
      && ["discovered", "admitted", "held", "paused", "ended", "ended-unresolved"].includes(row.status))
      .sort((a, b) => a.createdAtMs === b.createdAtMs ? a.jobId.localeCompare(b.jobId) : a.createdAtMs - b.createdAtMs).map(clone);
  }
  async admit(input: RebalanceAdmissionInput): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const existing = this.#jobs.get(input.jobId);
    if (existing === undefined || existing.rowVersion !== input.expectedRowVersion || existing.status !== "discovered") return { kind: "conflict", record: existing === undefined ? null : clone(existing) };
    if (this.claims === undefined || !(await this.claims.isProvisional({
      wallet: existing.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: existing.strategyId,
      jobId: existing.jobId, attemptId: input.attemptId, generation: input.claimGeneration, nowMs: input.nowMs,
    }))) return { kind: "inconsistent", code: "claim-missing" };
    const row: QuantRebalanceJobRow = {
      ...existing, status: "admitted", admittedAtMs: input.nowMs, policyJson: input.policyJson,
      policyDigest: input.policyDigest, tier: input.tier, sessionPublicKey: input.sessionPublicKey,
      sessionExpirySec: input.sessionExpirySec, permissionsDigest: input.permissionsDigest,
      projectionDigest: input.projectionDigest, descriptorJson: input.descriptorJson,
      projectionJson: input.projectionJson, capRowsJson: input.capRowsJson,
      claimGeneration: input.claimGeneration, baselineBlock: input.baselineBlock,
      baselineHash: input.baselineHash, baselineAtMs: input.baselineAtMs,
      actualBaselineJson: encodeJsonbParam(input.actualBaseline),
      protectedBaselineJson: encodeJsonbParam(input.protectedBaseline),
      managed: { USDC: existing.allocationWei, WBNB: 0n, ETH: 0n, CAKE: 0n },
      costBasis: emptyBasis(), accountingRev: existing.accountingRev + 1n,
      checkRev: existing.checkRev + 1n, rowVersion: existing.rowVersion + 1, holdCode: null,
      updatedAtMs: input.nowMs,
    };
    this.#jobs.set(row.jobId, row);
    const bootstrap: QuantRebalanceCheckRow = {
      checkId: checkKey(row.jobId, "bootstrap", 0), jobId: row.jobId, kind: "bootstrap", slot: 0,
      state: "rebalancing", evidenceJson: null, takenAssets: [], rowVersion: 1,
      createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
    };
    this.#checks.set(bootstrap.checkId, bootstrap);
    return { kind: "ok", record: clone(row) };
  }
  async setHold(input: { readonly jobId: string; readonly code: string; readonly evidenceJson: string | null; readonly nowMs: number }): Promise<void> {
    const row = this.#jobs.get(input.jobId); if (row === undefined) return;
    this.#jobs.set(row.jobId, { ...row, status: row.status === "discovered" ? "discovered" : "held", holdCode: input.code,
      holdEvidenceJson: input.evidenceJson, rowVersion: row.rowVersion + 1, updatedAtMs: input.nowMs });
  }
  async listChecks(jobId: string): Promise<readonly QuantRebalanceCheckRow[]> { return [...this.#checks.values()].filter((row) => row.jobId === jobId).map(clone); }
  async beginCheck(input: { readonly jobId: string; readonly kind: QuantRebalanceCheckKind; readonly slot: number; readonly state: QuantRebalanceCheckState; readonly evidenceJson: string; readonly expectedJobRevision: bigint; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceCheckRow>> {
    const id = checkKey(input.jobId, input.kind, input.slot); const prior = this.#checks.get(id);
    if (prior !== undefined) return { kind: "conflict", record: clone(prior) };
    const job = this.#jobs.get(input.jobId); if (job === undefined || job.status !== "admitted"
      || job.accountingRev !== input.expectedJobRevision) return { kind: "conflict", record: null };
    const row: QuantRebalanceCheckRow = { checkId: id, jobId: input.jobId, kind: input.kind, slot: input.slot,
      state: input.state, evidenceJson: input.evidenceJson, takenAssets: [], rowVersion: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs };
    this.#checks.set(id, row); this.#jobs.set(job.jobId, { ...job, checkRev: job.checkRev + 1n, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
    return { kind: "ok", record: clone(row) };
  }
  async updateCheck(input: { readonly checkId: string; readonly expectedRowVersion: number; readonly state: QuantRebalanceCheckState; readonly evidenceJson: string; readonly takenAssets: readonly RebalanceRiskAsset[]; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceCheckRow>> {
    const prior = this.#checks.get(input.checkId); if (prior === undefined || prior.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    const row = { ...prior, state: input.state, evidenceJson: input.evidenceJson, takenAssets: [...new Set(input.takenAssets)], rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
    this.#checks.set(row.checkId, row); return { kind: "ok", record: clone(row) };
  }
  async listActions(jobId: string): Promise<readonly QuantRebalanceActionRow[]> { return [...this.#actions.values()].filter((row) => row.jobId === jobId).map(clone); }
  async getAction(actionId: string): Promise<QuantRebalanceActionRow | null> { const row = this.#actions.get(actionId); return row === undefined ? null : clone(row); }
  async listUnresolvedActions(jobId?: string): Promise<readonly QuantRebalanceActionRow[]> { return [...this.#actions.values()].filter((row) => (jobId === undefined || row.jobId === jobId) && !REBALANCE_ACTION_TERMINAL.has(row.state)).map(clone); }
  async insertAction(input: RebalanceActionInsertInput): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const key = actionKey(input.jobId, input.checkId, input.sequence);
    const prior = this.#actions.get(key); if (prior !== undefined) return { kind: "conflict", record: clone(prior) };
    const job = this.#jobs.get(input.jobId); const check = this.#checks.get(input.checkId);
    if (job === undefined || check === undefined || this.claims === undefined || job.status !== "admitted" || job.claimGeneration !== input.claimGeneration) return { kind: "inconsistent", code: "claim-missing" };
    return this.claims.withWalletFence(job.tradingWallet, async () => {
    if (!(await this.claims?.isActive({ wallet: job.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: job.strategyId, jobId: job.jobId, generation: input.claimGeneration }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
    const latestJob = this.#jobs.get(input.jobId); const latestCheck = this.#checks.get(input.checkId);
    if (latestJob === undefined || latestCheck === undefined) return { kind: "conflict", record: null };
    // Authoritative after the fence wait, as in PostgreSQL: an end or
    // retirement that won the fence leaves no admitted job to insert into.
    if (latestJob.status !== "admitted" || latestJob.claimGeneration !== input.claimGeneration) return { kind: "inconsistent", code: "claim-missing" };
    if (latestCheck.takenAssets.includes(input.asset)) return { kind: "inconsistent", code: "asset-already-taken" };
    if (latestJob.accountingRev !== input.expectedJobRevision || latestCheck.rowVersion !== input.expectedCheckVersion
      || input.sequence !== latestJob.actionSequence + 1n || input.sequence <= 0n
      || !Number.isSafeInteger(input.deadlineSec) || input.deadlineSec <= latestJob.lastDeadlineSec) return { kind: "inconsistent", code: "revision-changed" };
    if ([...this.#actions.values()].some((row) => row.jobId === input.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state))) return { kind: "inconsistent", code: "action-unresolved" };
    const { expectedJobRevision, expectedCheckVersion, nowMs, ...actionInput } = input;
    const row: QuantRebalanceActionRow = {
      ...actionInput, plannedAccountingRev: expectedJobRevision, plannedCheckVersion: expectedCheckVersion,
      actionId: key, journalKey: key, state: "intended", txHash: null, fillInWei: null,
      fillOutWei: null, receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null,
      preSubmitBlockNumber: null, preSubmitBlockHash: null, failureCode: null, ambiguousCause: null,
      resolutionJson: null, rowVersion: 1, createdAtMs: nowMs, updatedAtMs: nowMs,
    };
    this.#actions.set(key, row); this.#jobs.set(latestJob.jobId, { ...latestJob, actionSequence: input.sequence, lastDeadlineSec: input.deadlineSec,
      accountingRev: latestJob.accountingRev + 1n, rowVersion: latestJob.rowVersion + 1, updatedAtMs: nowMs });
    return { kind: "ok", record: clone(row) };
    });
  }
  async beginJournalForIntended(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly claimGeneration: bigint; readonly journalBegin: RebalanceSubmitJournalBegin; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId);
    if (prior === undefined || prior.state !== "intended" || prior.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    const job = this.#jobs.get(prior.jobId);
    if (job === undefined || this.claims === undefined || job.status !== "admitted"
      || job.claimGeneration !== input.claimGeneration || prior.claimGeneration !== input.claimGeneration) return { kind: "inconsistent", code: "claim-missing" };
    return this.claims.withWalletFence(job.tradingWallet, async () => {
      if (!(await this.claims?.isActive({ wallet: job.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND,
        strategyId: job.strategyId, jobId: job.jobId, generation: input.claimGeneration }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
      const current = this.#actions.get(input.actionId); const currentJob = this.#jobs.get(job.jobId);
      const check = current === undefined ? undefined : this.#checks.get(current.checkId);
      if (current === undefined || currentJob === undefined || check === undefined || current.state !== "intended"
        || current.rowVersion !== input.expectedRowVersion || currentJob.status !== "admitted"
        || currentJob.claimGeneration !== input.claimGeneration || currentJob.accountingRev !== current.plannedAccountingRev + 1n
        || check.state !== "rebalancing" || check.rowVersion !== current.plannedCheckVersion
        || check.takenAssets.includes(current.asset) || currentJob.revokedAtMs !== null
        || currentJob.endsAtMs <= input.nowMs || currentJob.sessionExpiresAtMs <= input.nowMs
        || current.policyDigest.toLowerCase() !== currentJob.policyDigest?.toLowerCase()
        || current.permissionsDigest.toLowerCase() !== currentJob.permissionsDigest?.toLowerCase()
        || current.projectionDigest.toLowerCase() !== currentJob.projectionDigest?.toLowerCase()) return { kind: "conflict", record: current === undefined ? null : clone(current) };
      const begun = await input.journalBegin.journal.beginWithSpend(input.journalBegin.input, input.journalBegin.sinceMs);
      if (!begun.created) return { kind: "inconsistent", code: "action-unresolved" };
      return { kind: "ok", record: clone(current) };
    });
  }
  async markSubmitted(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly claimGeneration: bigint; readonly blockNumber: bigint; readonly blockHash: Hex; readonly nowMs: number; readonly revalidate: (snapshot: RebalanceSubmitSnapshot) => Promise<boolean> }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId); if (prior === undefined || prior.rowVersion !== input.expectedRowVersion || prior.state !== "intended") return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    const job = this.#jobs.get(prior.jobId); if (job === undefined || this.claims === undefined || job.claimGeneration !== input.claimGeneration || job.status !== "admitted") return { kind: "inconsistent", code: "claim-missing" };
    return this.claims.withWalletFence(job.tradingWallet, async () => {
    if (!(await this.claims?.isActive({ wallet: job.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: job.strategyId, jobId: job.jobId, generation: input.claimGeneration }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
    const current = this.#actions.get(input.actionId);
    if (current === undefined || current.state !== "intended" || current.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: current === undefined ? null : clone(current) };
    const currentJob = this.#jobs.get(current.jobId); const currentCheck = this.#checks.get(current.checkId);
    if (currentJob === undefined || currentCheck === undefined || currentJob.status !== "admitted"
      || currentJob.claimGeneration !== input.claimGeneration || current.policyDigest.toLowerCase() !== currentJob.policyDigest?.toLowerCase()
      || current.permissionsDigest.toLowerCase() !== currentJob.permissionsDigest?.toLowerCase()
      || current.projectionDigest.toLowerCase() !== currentJob.projectionDigest?.toLowerCase()
      || currentJob.accountingRev !== current.plannedAccountingRev + 1n
      || currentCheck.state !== "rebalancing" || currentCheck.rowVersion !== current.plannedCheckVersion
      || currentCheck.takenAssets.includes(current.asset) || currentJob.revokedAtMs !== null
      || currentJob.endsAtMs <= input.nowMs || currentJob.sessionExpiresAtMs <= input.nowMs
      || input.blockNumber < current.quoteBlockNumber || input.blockNumber - current.quoteBlockNumber > REBALANCE_MAX_BLOCK_LAG
      || current.quoteBlockNumber !== current.referenceBlockNumber
      || current.quoteBlockHash.toLowerCase() !== current.referenceBlockHash.toLowerCase()
      || current.quoteObservedAtMs > input.nowMs || current.referenceObservedAtMs > input.nowMs
      || input.nowMs - current.quoteObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
      || input.nowMs - current.referenceObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS) return { kind: "inconsistent", code: "revision-changed" };
    let fresh: boolean;
    try { fresh = await input.revalidate({ job: clone(currentJob), check: clone(currentCheck), action: clone(current) }); }
    catch { fresh = false; }
    if (!fresh) return { kind: "inconsistent", code: "revision-changed" };
    const row = { ...current, state: "submitted" as const, preSubmitBlockNumber: input.blockNumber, preSubmitBlockHash: input.blockHash, rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
    this.#actions.set(row.actionId, row); return { kind: "ok", record: clone(row) };
    });
  }
  async abortIntendedAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly expectedJournalState: "absent" | "PENDING" | "ROLLED_BACK"; readonly reasonCode?: string; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId);
    if (prior === undefined || prior.rowVersion !== input.expectedRowVersion || prior.state !== "intended") return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    const job = this.#jobs.get(prior.jobId);
    if (job === undefined || this.claims === undefined || job.claimGeneration !== prior.claimGeneration) return { kind: "inconsistent", code: "claim-missing" };
    return this.claims.withWalletFence(job.tradingWallet, async () => {
      if (!(await this.claims?.isActive({ wallet: job.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND,
        strategyId: job.strategyId, jobId: job.jobId, generation: prior.claimGeneration }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
      const current = this.#actions.get(input.actionId); const latestJob = this.#jobs.get(job.jobId);
      if (current === undefined || latestJob === undefined || current.state !== "intended"
        || current.rowVersion !== input.expectedRowVersion || latestJob.rowVersion !== job.rowVersion) return { kind: "conflict", record: current === undefined ? null : clone(current) };
      if (this.journalProofReader !== undefined) {
        const journal = await this.journalProofReader(current.journalKey);
        if (input.expectedJournalState === "absent" ? journal !== null
          : journal === null || journal.state !== input.expectedJournalState || journal.hasCallsId || journal.txHash !== null) {
          return { kind: "inconsistent", code: "revision-changed" };
        }
      }
      const row = { ...current, state: "aborted" as const, reservationWei: 0n,
        resolutionJson: JSON.stringify({ recovery: "pre-submit-no-provider-entry", journalState: input.expectedJournalState,
          reasonCode: input.reasonCode !== undefined && /^[a-z0-9-]{1,64}$/u.test(input.reasonCode) ? input.reasonCode : "recovered-before-submit" }),
        rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      this.#actions.set(row.actionId, row);
      this.#jobs.set(latestJob.jobId, { ...latestJob, rowVersion: latestJob.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: clone(row) };
    });
  }
  async failAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly evidence: QuantRebalanceFailureEvidence; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId); if (prior === undefined || prior.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    if (prior.state === "intended") {
      if (input.evidence.kind !== "pre-submit-refusal" || !input.evidence.journalRolledBack
        || !/^[a-z0-9-]{1,64}$/u.test(input.evidence.code)) return { kind: "inconsistent", code: "revision-changed" };
    } else if (prior.state === "submitted" || prior.state === "unknown" || prior.state === "committed-unverified") {
      if (input.evidence.kind !== "submitted-failure" || !isVerifiedQuantRebalanceFailureProof(input.evidence.proof)
          || input.evidence.proof.chainId !== 56 || input.evidence.proof.actionId !== prior.actionId
          || prior.txHash !== null && prior.txHash.toLowerCase() !== input.evidence.proof.txHash.toLowerCase()) return { kind: "inconsistent", code: "revision-changed" };
    } else return { kind: "inconsistent", code: "revision-changed" };
    const submittedFailure = input.evidence.kind === "submitted-failure";
    const check = submittedFailure ? this.#checks.get(prior.checkId) : undefined;
    if (submittedFailure && check === undefined) return { kind: "inconsistent", code: "revision-changed" };
    const code = input.evidence.kind === "pre-submit-refusal" ? input.evidence.code : "submitted-failed-proven";
    const row = { ...prior, state: "failed" as const, failureCode: code, reservationWei: 0n,
      ...(input.evidence.kind === "submitted-failure" ? { txHash: input.evidence.proof.txHash } : {}),
      rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
    this.#actions.set(row.actionId, row);
    if (check !== undefined) {
      this.#checks.set(check.checkId, { ...check, takenAssets: [...new Set([...check.takenAssets, prior.asset])],
        rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
      const job = this.#jobs.get(prior.jobId);
      if (job !== undefined) this.#jobs.set(job.jobId, { ...job, checkRev: job.checkRev + 1n,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
    }
    return { kind: "ok", record: clone(row) };
  }
  async markAmbiguous(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly state: "unknown" | "committed-unverified"; readonly cause: string; readonly txHash?: Hex; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId); if (prior === undefined || prior.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    if (!(prior.state === "submitted" || prior.state === "unknown" || prior.state === "committed-unverified")) return { kind: "inconsistent", code: "revision-changed" };
    const cause = /^[a-z0-9-]{1,64}$/u.test(input.cause) ? input.cause : "other";
    const row = { ...prior, state: input.state, ambiguousCause: cause, ...(input.txHash === undefined ? {} : { txHash: input.txHash }), rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
    this.#actions.set(row.actionId, row); return { kind: "ok", record: clone(row) };
  }
  async resolveNotExecuted(input: { readonly actionId: string; readonly expectedActionVersion: number; readonly expectedJobVersion: number; readonly expectedCheckVersion: number; readonly proof: VerifiedQuantRebalanceNotExecutedProof; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId); if (prior === undefined) return { kind: "conflict", record: null };
    const job = this.#jobs.get(prior.jobId);
    if (job === undefined || this.claims === undefined || !isVerifiedQuantRebalanceNotExecutedProof(input.proof)
      || input.proof.chainId !== 56 || input.proof.actionId !== prior.actionId || input.proof.jobId !== job.jobId
      || input.proof.generation !== prior.claimGeneration || prior.state !== "unknown" || prior.txHash !== null
      || prior.rowVersion !== input.expectedActionVersion || job.rowVersion !== input.expectedJobVersion
      || prior.resolutionJson !== null) return { kind: "inconsistent", code: "revision-changed" };
    const check = this.#checks.get(prior.checkId);
    if (check === undefined || check.rowVersion !== input.expectedCheckVersion || check.state !== "rebalancing") return { kind: "conflict", record: clone(prior) };
    return this.claims.withWalletFence(job.tradingWallet, async () => {
      if (!(await this.claims?.isActive({ wallet: job.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND,
        strategyId: job.strategyId, jobId: job.jobId, generation: job.claimGeneration ?? 0n }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
      const current = this.#actions.get(input.actionId); const latestJob = this.#jobs.get(job.jobId); const latestCheck = this.#checks.get(check.checkId);
      const journal = await this.journalProofReader?.(prior.journalKey);
      const unresolved = [...this.#actions.values()].filter((row) => row.jobId === job.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state));
      if (current === undefined || latestJob === undefined || latestCheck === undefined || current.state !== "unknown"
        || current.txHash !== null || current.rowVersion !== input.expectedActionVersion
        || latestJob.rowVersion !== input.expectedJobVersion || latestCheck.rowVersion !== input.expectedCheckVersion
        || unresolved.length !== 1 || unresolved[0]?.actionId !== current.actionId) return { kind: "conflict", record: current === undefined ? null : clone(current) };
      if (journal === null || journal === undefined || journal.state !== "UNKNOWN" || journal.hasCallsId || journal.txHash !== null) {
        return { kind: "inconsistent", code: "revision-changed" };
      }
      const row = { ...current, state: "aborted" as const, resolutionJson: input.proof.evidenceJson,
        reservationWei: 0n, rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      this.#actions.set(row.actionId, row);
      this.#checks.set(latestCheck.checkId, { ...latestCheck,
        takenAssets: [...new Set([...latestCheck.takenAssets, current.asset])],
        rowVersion: latestCheck.rowVersion + 1, updatedAtMs: input.nowMs });
      this.#jobs.set(latestJob.jobId, { ...latestJob, accountingRev: latestJob.accountingRev + 1n,
        checkRev: latestJob.checkRev + 1n, rowVersion: latestJob.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: clone(row) };
    });
  }
  async retireJob(input: { readonly jobId: string; readonly expectedRowVersion: number; readonly proof: VerifiedQuantRebalanceRetirementProof; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const prior = this.#jobs.get(input.jobId);
    if (prior === undefined || this.claims === undefined || !isVerifiedQuantRebalanceRetirementProof(input.proof)
      || input.proof.chainId !== 56 || input.proof.jobId !== prior.jobId || input.proof.generation !== prior.claimGeneration
      || prior.rowVersion !== input.expectedRowVersion || ["discovered", "reported"].includes(prior.status)) return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    if (prior.retiredAtMs !== null) return prior.retirementEvidenceJson === input.proof.evidenceJson
      ? { kind: "ok", record: clone(prior) } : { kind: "conflict", record: clone(prior) };
    return this.claims.withWalletFence(prior.tradingWallet, async () => {
      if (!(await this.claims?.isActive({ wallet: prior.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND,
        strategyId: prior.strategyId, jobId: prior.jobId, generation: prior.claimGeneration ?? 0n }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
      const current = this.#jobs.get(input.jobId); if (current === undefined || current.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: current === undefined ? null : clone(current) };
      const unresolved = [...this.#actions.values()].some((row) => row.jobId === current.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state));
      const row = { ...current, status: unresolved ? "ended-unresolved" as const : "ended" as const,
        retiredAtMs: input.nowMs, retirementEvidenceJson: input.proof.evidenceJson,
        rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      this.#jobs.set(row.jobId, row); return { kind: "ok", record: clone(row) };
    });
  }
  async settleAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly proof: VerifiedQuantRebalanceReceiptProof; readonly ownership: readonly QuantRebalanceReceiptOwnership[]; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = this.#actions.get(input.actionId); if (prior === undefined) return { kind: "conflict", record: null };
    if (prior.state === "settled") return prior.proofDigest === input.proof.proofDigest ? { kind: "ok", record: clone(prior) } : { kind: "conflict", record: clone(prior) };
    if (prior.rowVersion !== input.expectedRowVersion || !["submitted", "committed-unverified", "unknown"].includes(prior.state)) return { kind: "conflict", record: clone(prior) };
    const owningJob = this.#jobs.get(prior.jobId);
    if (!isVerifiedQuantRebalanceReceiptProof(input.proof) || input.proof.chainId !== 56
      || input.proof.txHash.length !== 66 || input.proof.wallet.toLowerCase() !== owningJob?.tradingWallet.toLowerCase()
      || input.proof.fillInWei !== prior.amountInWei || input.proof.fillOutWei < prior.minOutWei
      || input.ownership.length !== prior.pairAddresses.length || input.proof.swapLogIndices.length !== input.ownership.length
      || input.ownership.some((owner, index) => owner.journalKey !== prior.journalKey
        || owner.txHash.toLowerCase() !== input.proof.txHash.toLowerCase()
        || owner.wallet.toLowerCase() !== input.proof.wallet.toLowerCase()
        || owner.swapLogIndex !== input.proof.swapLogIndices[index])) return { kind: "inconsistent", code: "revision-changed" };
    const identities = input.ownership.map((owner) => `${owner.txHash.toLowerCase()}|${owner.wallet.toLowerCase()}|${owner.swapLogIndex}`);
    if (new Set(identities).size !== identities.length || identities.some((identity) => this.#ownership.has(identity))) return { kind: "inconsistent", code: "receipt-owned" };
    const job = this.#jobs.get(prior.jobId); if (job?.managed === null || job?.managed === undefined || job.costBasis === null || this.claims === undefined) return { kind: "inconsistent", code: "revision-changed" };
    return this.claims.withWalletFence(job.tradingWallet, async () => {
    const current = this.#actions.get(input.actionId); const currentJob = this.#jobs.get(prior.jobId);
    if (current === undefined || currentJob?.managed === null || currentJob?.managed === undefined || currentJob.costBasis === null
      || !(await this.claims?.isActive({ wallet: currentJob.tradingWallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: currentJob.strategyId, jobId: currentJob.jobId, generation: current.claimGeneration }) ?? false)) return { kind: "inconsistent", code: "claim-missing" };
    if (current.state === "settled") return current.proofDigest === input.proof.proofDigest ? { kind: "ok", record: clone(current) } : { kind: "conflict", record: clone(current) };
    if (current.rowVersion !== input.expectedRowVersion || !["submitted", "committed-unverified", "unknown"].includes(current.state)) return { kind: "conflict", record: clone(current) };
    const check = this.#checks.get(current.checkId); if (check === undefined) return { kind: "inconsistent", code: "revision-changed" };
    const settled = applyStoredVerifiedFill(currentJob.managed, currentJob.costBasis, {
      side: current.side, asset: current.asset, fillInWei: input.proof.fillInWei, fillOutWei: input.proof.fillOutWei,
    });
    const row: QuantRebalanceActionRow = {
      ...current, state: "settled", txHash: input.proof.txHash, fillInWei: input.proof.fillInWei,
      fillOutWei: input.proof.fillOutWei, realizedDeltaUsdcWei: settled.realizedDeltaUsdcWei,
      receiptBlockNumber: input.proof.blockNumber,
      receiptBlockHash: input.proof.blockHash, swapLogIndices: [...input.proof.swapLogIndices],
      proofDigest: input.proof.proofDigest, reservationWei: 0n,
      rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs,
    };
    this.#actions.set(row.actionId, row);
    this.#checks.set(check.checkId, { ...check, takenAssets: [...new Set([...check.takenAssets, current.asset])],
      rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
    for (let index = 0; index < input.ownership.length; index += 1) this.#ownership.set(identities[index] ?? "", clone(input.ownership[index]!));
    this.#jobs.set(currentJob.jobId, { ...currentJob, managed: settled.managed, costBasis: settled.costBasis,
      accountingRev: currentJob.accountingRev + 1n, checkRev: currentJob.checkRev + 1n, rowVersion: currentJob.rowVersion + 1, updatedAtMs: input.nowMs });
    return { kind: "ok", record: clone(row) };
    });
  }
  async completeCheck(input: { readonly checkId: string; readonly expectedJobRevision: bigint; readonly expectedCheckVersion: number; readonly nextEligibleSlot: number; readonly bootstrapComplete: boolean; readonly evidenceJson?: string; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const check = this.#checks.get(input.checkId); const job = check === undefined ? undefined : this.#jobs.get(check.jobId);
    if (check === undefined || job === undefined || job.accountingRev !== input.expectedJobRevision || check.rowVersion !== input.expectedCheckVersion) return { kind: "conflict", record: job === undefined ? null : clone(job) };
    if ([...this.#actions.values()].some((row) => row.jobId === job.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state))) return { kind: "inconsistent", code: "action-unresolved" };
    const nextJob = { ...job, nextEligibleSlot: input.nextEligibleSlot, bootstrapComplete: job.bootstrapComplete || input.bootstrapComplete,
      checkRev: job.checkRev + 1n, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs };
    this.#jobs.set(job.jobId, nextJob); this.#checks.set(check.checkId, { ...check, state: "done",
      ...(input.evidenceJson === undefined ? {} : { evidenceJson: input.evidenceJson }),
      rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
    return { kind: "ok", record: clone(nextJob) };
  }
  async markEnded(input: { readonly jobId: string; readonly unresolved: boolean; readonly nowMs: number }): Promise<void> {
    const job = this.#jobs.get(input.jobId); if (job === undefined) return;
    const end = async (): Promise<void> => {
      const current = this.#jobs.get(input.jobId); if (current === undefined) return;
      const unresolved = input.unresolved || [...this.#actions.values()].some((row) => row.jobId === current.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state));
      this.#jobs.set(current.jobId, { ...current, status: unresolved ? "ended-unresolved" : "ended", rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs });
    };
    // Same wallet fence as insertion and retirement (PostgreSQL: wallet → job locks).
    if (this.claims === undefined) await end(); else await this.claims.withWalletFence(job.tradingWallet, end);
  }
  async recordReportAttempt(input: { readonly jobId: string; readonly payloadDigest: Hex; readonly responseStatus: number; readonly notesApplied: number | null; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const prior = this.#jobs.get(input.jobId);
    if (prior === undefined || prior.status !== "ended" || prior.reportAttempts >= REBALANCE_MAX_REPORT_ATTEMPTS
      || !/^0x[0-9a-fA-F]{64}$/u.test(input.payloadDigest)
      || !Number.isSafeInteger(input.responseStatus) || (input.responseStatus !== 0 && (input.responseStatus < 100 || input.responseStatus > 599))
      || (input.notesApplied !== null && (!Number.isSafeInteger(input.notesApplied) || input.notesApplied < 0))) {
      return { kind: "conflict", record: prior === undefined ? null : clone(prior) };
    }
    if ([...this.#actions.values()].some((row) => row.jobId === input.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state))) return { kind: "inconsistent", code: "action-unresolved" };
    const row = { ...prior, reportAttempts: prior.reportAttempts + 1, reportPayloadDigest: input.payloadDigest,
      reportResponseStatus: input.responseStatus, reportNotesApplied: input.notesApplied,
      rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
    this.#jobs.set(input.jobId, row); return { kind: "ok", record: clone(row) };
  }
  async markReported(input: { readonly jobId: string; readonly nowMs: number }): Promise<boolean> {
    const job = this.#jobs.get(input.jobId); if (job === undefined || job.status !== "ended" || job.reportAttempts < 1
      || job.reportResponseStatus !== 200 || [...this.#actions.values()].some((row) => row.jobId === job.jobId && !REBALANCE_ACTION_TERMINAL.has(row.state))) return false;
    this.#jobs.set(job.jobId, { ...job, status: "reported", reportedAtMs: input.nowMs, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs }); return true;
  }
  async close(): Promise<void> {}
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL backend — one JSON codec, static predicates, wallet-first locks. */
/* -------------------------------------------------------------------------- */

const QUANT_REBALANCE_JOB_LOCK_CLASSID = 0x5155_414e;
const PG_TERMINAL_ACTIONS = "('settled','failed','aborted')";
class ReceiptOwnershipConflict extends Error {}

export class PostgresQuantRebalanceStore implements QuantRebalanceStore {
  constructor(private readonly sql: SqlClient) {}

  async ensureSchema(): Promise<void> {
    for (const statement of QUANT_REBALANCE_DDL) await this.sql.query(statement);
  }

  async schemaReady(): Promise<boolean> {
    const result = await this.sql.query<Record<string, unknown>>(
      `/* quantRebalance.schemaReady */ select
       to_regclass('public.quant_rebalance_jobs') is not null as jobs,
       to_regclass('public.quant_rebalance_checks') is not null as checks,
       to_regclass('public.quant_rebalance_actions') is not null as actions,
       to_regclass('public.quant_wallet_claims') is not null as claims,
       to_regclass('public.quant_receipt_ownership') is not null as receipts`,
    );
    const row = result.rows[0];
    return row?.["jobs"] === true && row["checks"] === true && row["actions"] === true
      && row["claims"] === true && row["receipts"] === true;
  }

  async discoverJob(input: { readonly wire: QuantRebalanceJobWire; readonly envelopeJson: string | null; readonly envelopeId: string | null; readonly nowMs: number }): Promise<QuantRebalanceJobRow> {
    return this.sql.transaction(async (tx) => {
      await this.#lockJob(tx, input.wire.id);
      const prior = await this.#getJobOn(tx, input.wire.id, true);
      if (prior === null) {
        const wire = input.wire;
        const row: QuantRebalanceJobRow = {
          jobId: wire.id, strategyId: wire.strategyId, tradingWallet: getAddress(wire.tradingWalletAddress),
          allocationWei: wire.allocationUWei, dailyCapWei: wire.dailyCapUWei, termDays: wire.termDays,
          startedAtMs: wire.startedAtMs ?? 0, endsAtMs: wire.endsAtMs ?? 0,
          sessionExpiresAtMs: wire.sessionExpiresAtMs ?? 0, revokedAtMs: wire.revokedAtMs,
          platformStatus: wire.status, status: "discovered", wireJson: encodeJsonbParam(wire), wireDigest: wire.wireDigest,
          envelopeJson: input.envelopeJson, envelopeId: input.envelopeId, admittedAtMs: null,
          policyJson: null, policyDigest: null, tier: null, sessionPublicKey: null, sessionExpirySec: null,
          permissionsDigest: null, projectionDigest: null, descriptorJson: null, projectionJson: null, capRowsJson: null,
          claimGeneration: null, baselineBlock: null, baselineHash: null, baselineAtMs: null,
          actualBaselineJson: null, protectedBaselineJson: null, managed: null, costBasis: null,
          accountingRev: 0n, checkRev: 0n, nextEligibleSlot: 0, actionSequence: 0n, lastDeadlineSec: 0,
          bootstrapComplete: false, externalActivity: false, holdCode: null, holdEvidenceJson: null,
          reportAttempts: 0, reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null,
          reportedAtMs: null, retiredAtMs: null, retirementEvidenceJson: null,
          rowVersion: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
        };
        await this.#insertJobOn(tx, row);
        return clone(row);
      }
      const changed = prior.wireDigest.toLowerCase() !== input.wire.wireDigest.toLowerCase();
      const row: QuantRebalanceJobRow = prior.status === "discovered"
        ? { ...prior, strategyId: input.wire.strategyId, tradingWallet: getAddress(input.wire.tradingWalletAddress),
          allocationWei: input.wire.allocationUWei, dailyCapWei: input.wire.dailyCapUWei,
          termDays: input.wire.termDays, startedAtMs: input.wire.startedAtMs ?? 0,
          endsAtMs: input.wire.endsAtMs ?? 0, sessionExpiresAtMs: input.wire.sessionExpiresAtMs ?? 0,
          revokedAtMs: input.wire.revokedAtMs, platformStatus: input.wire.status,
          wireJson: encodeJsonbParam(input.wire), wireDigest: input.wire.wireDigest,
          envelopeJson: input.envelopeJson ?? prior.envelopeJson, envelopeId: input.envelopeId ?? prior.envelopeId,
          rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs }
        : { ...prior, platformStatus: input.wire.status, revokedAtMs: input.wire.revokedAtMs,
          ...(changed ? { status: "held", holdCode: "wire-changed" } : {}),
          wireJson: encodeJsonbParam(input.wire), wireDigest: input.wire.wireDigest,
          envelopeJson: input.envelopeJson ?? prior.envelopeJson, envelopeId: input.envelopeId ?? prior.envelopeId,
          rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeJobOn(tx, row);
      return clone(row);
    });
  }

  async getJob(jobId: string): Promise<QuantRebalanceJobRow | null> { return this.#getJobOn(this.sql, jobId); }
  async listJobs(): Promise<readonly QuantRebalanceJobRow[]> {
    const result = await this.sql.query<Record<string, unknown>>(`/* quantRebalance.listJobs */ select data_json from quant_rebalance_jobs order by job_id`);
    return result.rows.map((row) => decodeJob(row["data_json"]));
  }
  async listWorkableJobs(strategyId: string): Promise<readonly QuantRebalanceJobRow[]> {
    const result = await this.sql.query<Record<string, unknown>>(
      `/* quantRebalance.workable */ select data_json from quant_rebalance_jobs where strategy_id=$1
       and status in ('discovered','admitted','held','paused','ended','ended-unresolved') order by created_at_ms,job_id`,
      [strategyId],
    );
    return result.rows.map((row) => decodeJob(row["data_json"]));
  }

  async admit(input: RebalanceAdmissionInput, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const wallet = await this.#jobWallet(tx ?? this.sql, input.jobId);
    if (wallet === null) return { kind: "conflict", record: null };
    const work = async (client: SqlClient): Promise<RebalanceCas<QuantRebalanceJobRow>> => {
      await this.#lockJob(client, input.jobId);
      const existing = await this.#getJobOn(client, input.jobId, true);
      if (existing === null || existing.rowVersion !== input.expectedRowVersion || existing.status !== "discovered") return { kind: "conflict", record: existing };
      const hasProvisional = await quantWalletClaimProvisionalOn(client, {
        wallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: existing.strategyId,
        jobId: existing.jobId, attemptId: input.attemptId, generation: input.claimGeneration,
        nowMs: input.nowMs,
      });
      if (!hasProvisional) return { kind: "inconsistent", code: "claim-missing" };
      const admitted: QuantRebalanceJobRow = {
        ...existing, status: "admitted", admittedAtMs: input.nowMs,
        policyJson: input.policyJson, policyDigest: input.policyDigest, tier: input.tier,
        sessionPublicKey: input.sessionPublicKey, sessionExpirySec: input.sessionExpirySec,
        permissionsDigest: input.permissionsDigest, projectionDigest: input.projectionDigest,
        descriptorJson: input.descriptorJson, projectionJson: input.projectionJson,
        capRowsJson: input.capRowsJson, claimGeneration: input.claimGeneration,
        baselineBlock: input.baselineBlock, baselineHash: input.baselineHash, baselineAtMs: input.baselineAtMs,
        actualBaselineJson: encodeJsonbParam(input.actualBaseline),
        protectedBaselineJson: encodeJsonbParam(input.protectedBaseline),
        managed: { USDC: existing.allocationWei, WBNB: 0n, ETH: 0n, CAKE: 0n },
        costBasis: emptyBasis(), accountingRev: existing.accountingRev + 1n,
        checkRev: existing.checkRev + 1n, rowVersion: existing.rowVersion + 1,
        holdCode: null, updatedAtMs: input.nowMs,
      };
      await this.#writeJobOn(client, admitted);
      const bootstrap: QuantRebalanceCheckRow = {
        checkId: checkKey(admitted.jobId, "bootstrap", 0), jobId: admitted.jobId, kind: "bootstrap", slot: 0,
        state: "rebalancing", evidenceJson: null, takenAssets: [], rowVersion: 1,
        createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
      };
      await this.#insertCheckOn(client, bootstrap);
      return { kind: "ok", record: admitted };
    };
    // Admission's caller must provide the transaction which also promotes its
    // provisional claim. Standalone PG admission is refused by this contract.
    if (tx === undefined) return { kind: "inconsistent", code: "claim-missing" };
    return work(tx);
  }

  async setHold(input: { readonly jobId: string; readonly code: string; readonly evidenceJson: string | null; readonly nowMs: number }): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await this.#lockJob(tx, input.jobId);
      const prior = await this.#getJobOn(tx, input.jobId, true); if (prior === null) return;
      const row: QuantRebalanceJobRow = { ...prior, status: prior.status === "discovered" ? "discovered" : "held",
        holdCode: input.code, holdEvidenceJson: input.evidenceJson, rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeJobOn(tx, row);
    });
  }

  async listChecks(jobId: string): Promise<readonly QuantRebalanceCheckRow[]> {
    const result = await this.sql.query<Record<string, unknown>>(`/* quantRebalance.listChecks */ select data_json from quant_rebalance_checks where job_id=$1 order by check_kind,slot`, [jobId]);
    return result.rows.map((row) => decodeCheck(row["data_json"]));
  }
  async beginCheck(input: { readonly jobId: string; readonly kind: QuantRebalanceCheckKind; readonly slot: number; readonly state: QuantRebalanceCheckState; readonly evidenceJson: string; readonly expectedJobRevision: bigint; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceCheckRow>> {
    return this.sql.transaction(async (tx) => {
      await this.#lockJob(tx, input.jobId);
      const prior = await this.#getCheckOn(tx, checkKey(input.jobId, input.kind, input.slot));
      if (prior !== null) return { kind: "conflict", record: prior };
      const job = await this.#getJobOn(tx, input.jobId, true);
      if (job === null || job.status !== "admitted" || job.accountingRev !== input.expectedJobRevision) return { kind: "conflict", record: null };
      const row: QuantRebalanceCheckRow = { checkId: checkKey(input.jobId, input.kind, input.slot), jobId: input.jobId,
        kind: input.kind, slot: input.slot, state: input.state, evidenceJson: input.evidenceJson, takenAssets: [], rowVersion: 1,
        createdAtMs: input.nowMs, updatedAtMs: input.nowMs };
      await this.#insertCheckOn(tx, row);
      await this.#writeJobOn(tx, { ...job, checkRev: job.checkRev + 1n, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: row };
    });
  }
  async updateCheck(input: { readonly checkId: string; readonly expectedRowVersion: number; readonly state: QuantRebalanceCheckState; readonly evidenceJson: string; readonly takenAssets: readonly RebalanceRiskAsset[]; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceCheckRow>> {
    return this.sql.transaction(async (tx) => {
      const prior = await this.#getCheckOn(tx, input.checkId, true);
      if (prior === null || prior.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: prior };
      await this.#lockJob(tx, prior.jobId);
      const row: QuantRebalanceCheckRow = { ...prior, state: input.state, evidenceJson: input.evidenceJson,
        takenAssets: [...new Set(input.takenAssets)], rowVersion: prior.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeCheckOn(tx, row);
      return { kind: "ok", record: row };
    });
  }

  async listActions(jobId: string): Promise<readonly QuantRebalanceActionRow[]> {
    const result = await this.sql.query<Record<string, unknown>>(`/* quantRebalance.listActions */ select data_json from quant_rebalance_actions where job_id=$1 order by created_at_ms,action_id`, [jobId]);
    return result.rows.map((row) => decodeAction(row["data_json"]));
  }
  async getAction(actionId: string): Promise<QuantRebalanceActionRow | null> { return this.#getActionOn(this.sql, actionId); }
  async listUnresolvedActions(jobId?: string): Promise<readonly QuantRebalanceActionRow[]> {
    const result = await this.sql.query<Record<string, unknown>>(
      `/* quantRebalance.unresolved */ select data_json from quant_rebalance_actions where state not in ${PG_TERMINAL_ACTIONS} and ($1::text is null or job_id=$1) order by created_at_ms`,
      [jobId ?? null],
    );
    return result.rows.map((row) => decodeAction(row["data_json"]));
  }

  async insertAction(input: RebalanceActionInsertInput, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const wallet = await this.#jobWallet(tx ?? this.sql, input.jobId);
    if (wallet === null) return { kind: "conflict", record: null };
    const work = async (client: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>> => {
      await lockQuantWalletClaim(client, wallet);
      await this.#lockJob(client, input.jobId);
      const job = await this.#getJobOn(client, input.jobId, true);
      const check = await this.#getCheckOn(client, input.checkId, true);
      if (job === null || check === null || job.status !== "admitted" || job.claimGeneration !== input.claimGeneration
        || !(await quantWalletClaimActiveOn(client, { wallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: job.strategyId, jobId: job.jobId, generation: input.claimGeneration }))) return { kind: "inconsistent", code: "claim-missing" };
      if (job.accountingRev !== input.expectedJobRevision || job.actionSequence + 1n !== input.sequence || check.rowVersion !== input.expectedCheckVersion || check.state !== "rebalancing") return { kind: "inconsistent", code: "revision-changed" };
      if (check.takenAssets.includes(input.asset)) return { kind: "inconsistent", code: "asset-already-taken" };
      if (!Number.isSafeInteger(input.deadlineSec) || input.deadlineSec <= job.lastDeadlineSec) return { kind: "inconsistent", code: "revision-changed" };
      const unresolved = await client.query(`/* quantRebalance.hasUnresolved */ select 1 from quant_rebalance_actions where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS} limit 1`, [input.jobId]);
      if (unresolved.rows.length > 0) return { kind: "inconsistent", code: "action-unresolved" };
      const journalKey = actionKey(input.jobId, input.checkId, input.sequence);
      const { expectedJobRevision, expectedCheckVersion, nowMs, ...actionInput } = input;
      const row: QuantRebalanceActionRow = {
        ...actionInput, plannedAccountingRev: expectedJobRevision, plannedCheckVersion: expectedCheckVersion,
        actionId: journalKey, journalKey, state: "intended", txHash: null, fillInWei: null, fillOutWei: null,
        receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null,
        preSubmitBlockNumber: null, preSubmitBlockHash: null, failureCode: null, ambiguousCause: null,
        resolutionJson: null, rowVersion: 1, createdAtMs: nowMs, updatedAtMs: nowMs,
      };
      await client.query(`/* quantRebalance.insertAction */ insert into quant_rebalance_actions
        (action_id,journal_key,job_id,check_id,state,row_version,data_json,created_at_ms,updated_at_ms)
        values($1,$2,$3,$4,'intended',1,$5::jsonb,$6::bigint,$6::bigint)`,
      [row.actionId, row.journalKey, row.jobId, row.checkId, encodeJsonbParam(row), nowMs]);
      await this.#writeJobOn(client, { ...job, actionSequence: input.sequence, lastDeadlineSec: input.deadlineSec, accountingRev: job.accountingRev + 1n,
        rowVersion: job.rowVersion + 1, updatedAtMs: nowMs });
      return { kind: "ok", record: row };
    };
    if (tx !== undefined) return work(tx);
    return this.sql.transaction(work);
  }

  async beginJournalForIntended(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly claimGeneration: bigint; readonly journalBegin: RebalanceSubmitJournalBegin; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(this.sql, input.actionId);
    if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(this.sql, prior.jobId); if (wallet === null) return { kind: "conflict", record: prior };
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, prior.jobId);
      const action = await this.#getActionOn(tx, input.actionId, true);
      const job = await this.#getJobOn(tx, prior.jobId, true);
      if (action === null || action.state !== "intended" || action.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: action };
      if (job === null || job.status !== "admitted" || job.claimGeneration !== input.claimGeneration
        || action.claimGeneration !== input.claimGeneration
        || !(await quantWalletClaimActiveOn(tx, { wallet, strategyKind: CLAIM_STRATEGY_KIND,
          strategyId: job.strategyId, jobId: job.jobId, generation: input.claimGeneration }))) return { kind: "inconsistent", code: "claim-missing" };
      const check = await this.#getCheckOn(tx, action.checkId, true);
      if (check === null || job.accountingRev !== action.plannedAccountingRev + 1n
        || check.state !== "rebalancing" || check.rowVersion !== action.plannedCheckVersion
        || check.takenAssets.includes(action.asset) || job.revokedAtMs !== null
        || job.endsAtMs <= input.nowMs || job.sessionExpiresAtMs <= input.nowMs
        || job.policyDigest?.toLowerCase() !== action.policyDigest.toLowerCase()
        || job.permissionsDigest?.toLowerCase() !== action.permissionsDigest.toLowerCase()
        || job.projectionDigest?.toLowerCase() !== action.projectionDigest.toLowerCase()) return { kind: "inconsistent", code: "revision-changed" };
      const begun = await input.journalBegin.journal.beginWithSpend(input.journalBegin.input,
        input.journalBegin.sinceMs, tx);
      if (!begun.created) return { kind: "inconsistent", code: "action-unresolved" };
      return { kind: "ok", record: action };
    });
  }

  async markSubmitted(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly claimGeneration: bigint; readonly blockNumber: bigint; readonly blockHash: Hex; readonly nowMs: number; readonly revalidate: (snapshot: RebalanceSubmitSnapshot) => Promise<boolean> }, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(tx ?? this.sql, input.actionId);
    if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(tx ?? this.sql, prior.jobId);
    if (wallet === null) return { kind: "conflict", record: prior };
    const work = async (client: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>> => {
      await lockQuantWalletClaim(client, wallet);
      await this.#lockJob(client, prior.jobId);
      const current = await this.#getActionOn(client, input.actionId, true);
      const job = await this.#getJobOn(client, prior.jobId, true);
      if (current === null || current.rowVersion !== input.expectedRowVersion || current.state !== "intended") return { kind: "conflict", record: current };
      if (job === null || job.status !== "admitted" || job.claimGeneration !== input.claimGeneration
        || !(await quantWalletClaimActiveOn(client, { wallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: job.strategyId, jobId: job.jobId, generation: input.claimGeneration }))) return { kind: "inconsistent", code: "claim-missing" };
      const check = await this.#getCheckOn(client, current.checkId, true);
      if (check === null || job.policyDigest?.toLowerCase() !== current.policyDigest.toLowerCase()
        || job.permissionsDigest?.toLowerCase() !== current.permissionsDigest.toLowerCase()
        || job.projectionDigest?.toLowerCase() !== current.projectionDigest.toLowerCase()
        || job.accountingRev !== current.plannedAccountingRev + 1n
        || check.state !== "rebalancing" || check.rowVersion !== current.plannedCheckVersion
        || check.takenAssets.includes(current.asset) || job.revokedAtMs !== null
        || job.endsAtMs <= input.nowMs || job.sessionExpiresAtMs <= input.nowMs
        || input.blockNumber < current.quoteBlockNumber || input.blockNumber - current.quoteBlockNumber > REBALANCE_MAX_BLOCK_LAG
        || current.quoteBlockNumber !== current.referenceBlockNumber
        || current.quoteBlockHash.toLowerCase() !== current.referenceBlockHash.toLowerCase()
        || current.quoteObservedAtMs > input.nowMs || current.referenceObservedAtMs > input.nowMs
        || input.nowMs - current.quoteObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS
        || input.nowMs - current.referenceObservedAtMs > REBALANCE_MAX_QUOTE_AGE_MS) return { kind: "inconsistent", code: "revision-changed" };
      let fresh: boolean;
      try { fresh = await input.revalidate({ job: clone(job), check: clone(check), action: clone(current) }); }
      catch { fresh = false; }
      if (!fresh) return { kind: "inconsistent", code: "revision-changed" };
      const row: QuantRebalanceActionRow = { ...current, state: "submitted", preSubmitBlockNumber: input.blockNumber,
        preSubmitBlockHash: input.blockHash, rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeActionOn(client, row);
      return { kind: "ok", record: row };
    };
    if (tx !== undefined) return work(tx);
    return this.sql.transaction(work);
  }

  async abortIntendedAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly expectedJournalState: "absent" | "PENDING" | "ROLLED_BACK"; readonly reasonCode?: string; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(this.sql, input.actionId);
    if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(this.sql, prior.jobId); if (wallet === null) return { kind: "conflict", record: prior };
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, prior.jobId);
      const action = await this.#getActionOn(tx, prior.actionId, true);
      const job = await this.#getJobOn(tx, prior.jobId, true);
      if (action === null || action.state !== "intended" || action.rowVersion !== input.expectedRowVersion || job === null
        || job.claimGeneration !== action.claimGeneration || !(await quantWalletClaimActiveOn(tx, { wallet,
          strategyKind: CLAIM_STRATEGY_KIND, strategyId: job.strategyId, jobId: job.jobId, generation: action.claimGeneration }))) {
        return { kind: "conflict", record: action };
      }
      const journalResult = await tx.query<Record<string, unknown>>(`/* quantRebalance.abortIntendedJournalFence */
        select state,external_ref from execution_journal where idempotency_key=$1 for update`, [action.journalKey]);
      const journalRow = journalResult.rows[0];
      if (input.expectedJournalState === "absent") {
        if (journalRow !== undefined) return { kind: "inconsistent", code: "revision-changed" };
      } else {
        const journalRef = journalRow === undefined ? null : parseJsonb(journalRow["external_ref"]);
        if (journalRow === undefined || journalRow["state"] !== input.expectedJournalState || !isRecord(journalRef)
          || journalRef["callsId"] !== undefined || journalRef["txHash"] !== undefined) return { kind: "inconsistent", code: "revision-changed" };
        if (input.expectedJournalState === "PENDING") {
          await tx.query(`/* quantRebalance.abortIntendedJournalRollback */ update execution_journal
            set state='ROLLED_BACK',last_error='Pre-submit crash recovered before provider entry.',updated_at=now()
            where idempotency_key=$1 and state='PENDING'`, [action.journalKey]);
        }
      }
      const row = { ...action, state: "aborted" as const, reservationWei: 0n,
        resolutionJson: JSON.stringify({ recovery: "pre-submit-no-provider-entry", journalState: input.expectedJournalState,
          reasonCode: input.reasonCode !== undefined && /^[a-z0-9-]{1,64}$/u.test(input.reasonCode) ? input.reasonCode : "recovered-before-submit" }),
        rowVersion: action.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeActionOn(tx, row);
      await this.#writeJobOn(tx, { ...job, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: row };
    });
  }

  async failAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly evidence: QuantRebalanceFailureEvidence; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(this.sql, input.actionId);
    if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(this.sql, prior.jobId); if (wallet === null) return { kind: "conflict", record: prior };
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, prior.jobId);
      const current = await this.#getActionOn(tx, input.actionId, true);
      if (current === null || current.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: current };
      if (current.state === "intended") {
        if (input.evidence.kind !== "pre-submit-refusal" || !input.evidence.journalRolledBack
          || !/^[a-z0-9-]{1,64}$/u.test(input.evidence.code)) return { kind: "inconsistent", code: "revision-changed" };
        const journal = await tx.query(`/* quantRebalance.journalPreSubmitFailure */ select 1 from execution_journal where idempotency_key=$1 and kind='quantTrade' and state='ROLLED_BACK' limit 1`, [current.journalKey]);
        if (journal.rows.length !== 1) return { kind: "inconsistent", code: "revision-changed" };
      } else if (current.state === "submitted" || current.state === "unknown" || current.state === "committed-unverified") {
        if (input.evidence.kind !== "submitted-failure" || !isVerifiedQuantRebalanceFailureProof(input.evidence.proof)
          || input.evidence.proof.chainId !== 56 || input.evidence.proof.actionId !== current.actionId
          || current.txHash !== null && current.txHash.toLowerCase() !== input.evidence.proof.txHash.toLowerCase()) return { kind: "inconsistent", code: "revision-changed" };
        const journal = await tx.query(`/* quantRebalance.journalSubmittedFailure */ select 1 from execution_journal where idempotency_key=$1 and kind='quantTrade' and state in ('ROLLED_BACK','COMMITTED') and lower(external_ref->>'txHash')=$2 limit 1`, [current.journalKey, input.evidence.proof.txHash.toLowerCase()]);
        if (journal.rows.length !== 1) return { kind: "inconsistent", code: "revision-changed" };
      } else return { kind: "inconsistent", code: "revision-changed" };
      const definitiveSubmittedFailure = input.evidence.kind === "submitted-failure";
      const check = definitiveSubmittedFailure ? await this.#getCheckOn(tx, current.checkId, true) : null;
      const owningJob = definitiveSubmittedFailure ? await this.#getJobOn(tx, current.jobId, true) : null;
      if (definitiveSubmittedFailure && (check === null || owningJob === null)) return { kind: "inconsistent", code: "revision-changed" };
      const code = input.evidence.kind === "pre-submit-refusal" ? input.evidence.code : "submitted-failed-proven";
      const row: QuantRebalanceActionRow = { ...current, state: "failed", failureCode: code,
        reservationWei: 0n, ...(input.evidence.kind === "submitted-failure" ? { txHash: input.evidence.proof.txHash } : {}),
        rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeActionOn(tx, row);
      if (check !== null) {
        await this.#writeCheckOn(tx, { ...check, takenAssets: [...new Set([...check.takenAssets, current.asset])],
          rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
        await this.#writeJobOn(tx, { ...owningJob!, checkRev: owningJob!.checkRev + 1n,
          rowVersion: owningJob!.rowVersion + 1, updatedAtMs: input.nowMs });
      }
      return { kind: "ok", record: row };
    });
  }

  async markAmbiguous(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly state: "unknown" | "committed-unverified"; readonly cause: string; readonly txHash?: Hex; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(this.sql, input.actionId); if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(this.sql, prior.jobId); if (wallet === null) return { kind: "conflict", record: prior };
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, prior.jobId);
      const current = await this.#getActionOn(tx, input.actionId, true);
      if (current === null || current.rowVersion !== input.expectedRowVersion) return { kind: "conflict", record: current };
      if (!(current.state === "submitted" || current.state === "unknown" || current.state === "committed-unverified")) return { kind: "inconsistent", code: "revision-changed" };
      const cause = /^[a-z0-9-]{1,64}$/u.test(input.cause) ? input.cause : "other";
      const row = { ...current, state: input.state, ambiguousCause: cause, ...(input.txHash === undefined ? {} : { txHash: input.txHash }), rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeActionOn(tx, row); return { kind: "ok", record: row };
    });
  }

  async resolveNotExecuted(input: { readonly actionId: string; readonly expectedActionVersion: number; readonly expectedJobVersion: number; readonly expectedCheckVersion: number; readonly proof: VerifiedQuantRebalanceNotExecutedProof; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(this.sql, input.actionId);
    if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(this.sql, prior.jobId);
    if (wallet === null || !isVerifiedQuantRebalanceNotExecutedProof(input.proof) || input.proof.chainId !== 56
      || input.proof.actionId !== prior.actionId || input.proof.jobId !== prior.jobId
      || input.proof.generation !== prior.claimGeneration) return { kind: "inconsistent", code: "revision-changed" };
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, prior.jobId);
      const action = await this.#getActionOn(tx, input.actionId, true);
      const job = await this.#getJobOn(tx, prior.jobId, true);
      if (action === null || job === null || action.state !== "unknown" || action.txHash !== null
        || action.resolutionJson !== null || action.rowVersion !== input.expectedActionVersion
        || job.rowVersion !== input.expectedJobVersion || job.claimGeneration !== input.proof.generation
        || !(await quantWalletClaimActiveOn(tx, { wallet, strategyKind: CLAIM_STRATEGY_KIND,
          strategyId: job.strategyId, jobId: job.jobId, generation: input.proof.generation }))) {
        return { kind: "inconsistent", code: "revision-changed" };
      }
      const check = await this.#getCheckOn(tx, action.checkId, true);
      if (check === null || check.state !== "rebalancing" || check.rowVersion !== input.expectedCheckVersion) return { kind: "conflict", record: action };
      const journalResult = await tx.query<Record<string, unknown>>(`/* quantRebalance.resolveNotExecutedJournalFence */
        select state,external_ref from execution_journal where idempotency_key=$1 for update`, [action.journalKey]);
      const journalRow = journalResult.rows[0];
      const journalRef = journalRow === undefined ? null : parseJsonb(journalRow["external_ref"]);
      if (journalRow === undefined || journalRow["state"] !== "UNKNOWN" || !isRecord(journalRef)
        || journalRef["callsId"] !== undefined || journalRef["txHash"] !== undefined) {
        return { kind: "inconsistent", code: "revision-changed" };
      }
      const unresolved = await tx.query(`/* quantRebalance.resolveNotExecutedUnresolved */ select action_id from quant_rebalance_actions
        where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS}`, [job.jobId]);
      if (unresolved.rows.length !== 1 || String(unresolved.rows[0]?.["action_id"]) !== action.actionId) return { kind: "inconsistent", code: "action-unresolved" };
      const row = { ...action, state: "aborted" as const, resolutionJson: input.proof.evidenceJson,
        reservationWei: 0n, rowVersion: action.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeActionOn(tx, row);
      await this.#writeCheckOn(tx, { ...check, takenAssets: [...new Set([...check.takenAssets, action.asset])],
        rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
      await this.#writeJobOn(tx, { ...job, accountingRev: job.accountingRev + 1n,
        checkRev: job.checkRev + 1n, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: row };
    });
  }

  async retireJob(input: { readonly jobId: string; readonly expectedRowVersion: number; readonly proof: VerifiedQuantRebalanceRetirementProof; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const wallet = await this.#jobWallet(this.sql, input.jobId);
    if (wallet === null || !isVerifiedQuantRebalanceRetirementProof(input.proof) || input.proof.chainId !== 56
      || input.proof.jobId !== input.jobId) return { kind: "conflict", record: null };
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, input.jobId);
      const job = await this.#getJobOn(tx, input.jobId, true);
      if (job === null || job.rowVersion !== input.expectedRowVersion || job.claimGeneration === null
        || job.claimGeneration !== input.proof.generation || ["discovered", "reported"].includes(job.status)) return { kind: "conflict", record: job };
      if (job.retiredAtMs !== null) return job.retirementEvidenceJson === input.proof.evidenceJson
        ? { kind: "ok", record: job } : { kind: "conflict", record: job };
      if (!(await quantWalletClaimActiveOn(tx, { wallet, strategyKind: CLAIM_STRATEGY_KIND,
        strategyId: job.strategyId, jobId: job.jobId, generation: input.proof.generation }))) return { kind: "inconsistent", code: "claim-missing" };
      const unresolved = await tx.query(`/* quantRebalance.retirementUnresolved */ select 1 from quant_rebalance_actions
        where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS} limit 1`, [job.jobId]);
      const row = { ...job, status: unresolved.rows.length > 0 ? "ended-unresolved" as const : "ended" as const,
        retiredAtMs: input.nowMs, retirementEvidenceJson: input.proof.evidenceJson,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeJobOn(tx, row); return { kind: "ok", record: row };
    });
  }

  async settleAction(input: { readonly actionId: string; readonly expectedRowVersion: number; readonly proof: VerifiedQuantRebalanceReceiptProof; readonly ownership: readonly QuantRebalanceReceiptOwnership[]; readonly nowMs: number }, tx?: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>> {
    const prior = await this.#getActionOn(tx ?? this.sql, input.actionId); if (prior === null) return { kind: "conflict", record: null };
    const wallet = await this.#jobWallet(tx ?? this.sql, prior.jobId); if (wallet === null) return { kind: "conflict", record: prior };
    const work = async (client: SqlClient): Promise<RebalanceCas<QuantRebalanceActionRow>> => {
      await lockQuantWalletClaim(client, wallet); await this.#lockJob(client, prior.jobId);
      const current = await this.#getActionOn(client, input.actionId, true);
      const job = await this.#getJobOn(client, prior.jobId, true);
      if (current?.state === "settled") return current.proofDigest === input.proof.proofDigest ? { kind: "ok", record: current } : { kind: "conflict", record: current };
      if (current === null || job === null || current.rowVersion !== input.expectedRowVersion
        || !["submitted", "committed-unverified", "unknown"].includes(current.state)) return { kind: "conflict", record: current };
      if (!isVerifiedQuantRebalanceReceiptProof(input.proof) || input.proof.chainId !== 56) return { kind: "inconsistent", code: "revision-changed" };
      const check = await this.#getCheckOn(client, current.checkId, true);
      if (check === null) return { kind: "inconsistent", code: "revision-changed" };
      if (job.managed === null || job.costBasis === null || input.proof.wallet.toLowerCase() !== wallet.toLowerCase()
        || input.proof.fillInWei !== current.amountInWei || input.proof.fillOutWei < current.minOutWei
        || input.ownership.length !== current.pairAddresses.length || input.ownership.length !== input.proof.swapLogIndices.length
        || input.ownership.some((owner, index) => owner.journalKey !== current.journalKey
          || owner.txHash.toLowerCase() !== input.proof.txHash.toLowerCase() || owner.wallet.toLowerCase() !== wallet.toLowerCase()
          || owner.swapLogIndex !== input.proof.swapLogIndices[index])) return { kind: "inconsistent", code: "revision-changed" };
      if (!(await quantWalletClaimActiveOn(client, { wallet, strategyKind: CLAIM_STRATEGY_KIND, strategyId: job.strategyId, jobId: job.jobId, generation: current.claimGeneration }))) return { kind: "inconsistent", code: "claim-missing" };
      const identities = input.ownership.map((owner) => `${owner.txHash.toLowerCase()}|${owner.wallet.toLowerCase()}|${owner.swapLogIndex}`);
      if (new Set(identities).size !== identities.length) return { kind: "inconsistent", code: "receipt-owned" };
      for (const owner of input.ownership) {
        const result = await client.query(`/* quantRebalance.claimReceipt */ insert into quant_receipt_ownership
          (tx_hash,trading_wallet,swap_log_index,journal_key,created_at_ms)
          values($1,$2,$3::numeric,$4,$5::bigint) on conflict(tx_hash,trading_wallet,swap_log_index) do nothing returning tx_hash`,
        [owner.txHash.toLowerCase(), owner.wallet.toLowerCase(), owner.swapLogIndex.toString(10), owner.journalKey, input.nowMs]);
        if (result.rows.length !== 1) throw new ReceiptOwnershipConflict();
      }
      const settledVector = applyStoredVerifiedFill(job.managed, job.costBasis, {
        side: current.side, asset: current.asset, fillInWei: input.proof.fillInWei, fillOutWei: input.proof.fillOutWei,
      });
      const row: QuantRebalanceActionRow = {
        ...current, state: "settled", txHash: input.proof.txHash, fillInWei: input.proof.fillInWei,
          fillOutWei: input.proof.fillOutWei, realizedDeltaUsdcWei: settledVector.realizedDeltaUsdcWei,
          receiptBlockNumber: input.proof.blockNumber,
        receiptBlockHash: input.proof.blockHash, swapLogIndices: [...input.proof.swapLogIndices],
        proofDigest: input.proof.proofDigest, reservationWei: 0n, rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs,
      };
      await this.#writeActionOn(client, row);
      await this.#writeCheckOn(client, { ...check, takenAssets: [...new Set([...check.takenAssets, current.asset])],
        rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
      await this.#writeJobOn(client, { ...job, managed: settledVector.managed, costBasis: settledVector.costBasis,
        accountingRev: job.accountingRev + 1n, checkRev: job.checkRev + 1n, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: row };
    };
    try {
      if (tx !== undefined) return await work(tx);
      return await this.sql.transaction(work);
    } catch (error) {
      if (error instanceof ReceiptOwnershipConflict) return { kind: "inconsistent", code: "receipt-owned" };
      throw error;
    }
  }

  async completeCheck(input: { readonly checkId: string; readonly expectedJobRevision: bigint; readonly expectedCheckVersion: number; readonly nextEligibleSlot: number; readonly bootstrapComplete: boolean; readonly evidenceJson?: string; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const priorCheck = await this.#getCheckOn(this.sql, input.checkId); if (priorCheck === null) return { kind: "conflict", record: null };
    return this.sql.transaction(async (tx) => {
      await this.#lockJob(tx, priorCheck.jobId);
      const check = await this.#getCheckOn(tx, input.checkId, true); const job = await this.#getJobOn(tx, priorCheck.jobId, true);
      if (check === null || job === null || job.accountingRev !== input.expectedJobRevision || check.rowVersion !== input.expectedCheckVersion) return { kind: "conflict", record: job };
      const unresolved = await tx.query(`/* quantRebalance.completeUnresolved */ select 1 from quant_rebalance_actions where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS} limit 1`, [job.jobId]);
      if (unresolved.rows.length > 0) return { kind: "inconsistent", code: "action-unresolved" };
      const nextJob = { ...job, nextEligibleSlot: input.nextEligibleSlot, bootstrapComplete: job.bootstrapComplete || input.bootstrapComplete,
        checkRev: job.checkRev + 1n, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeJobOn(tx, nextJob);
      await this.#writeCheckOn(tx, { ...check, state: "done", ...(input.evidenceJson === undefined ? {} : { evidenceJson: input.evidenceJson }),
        rowVersion: check.rowVersion + 1, updatedAtMs: input.nowMs });
      return { kind: "ok", record: nextJob };
    });
  }

  async markEnded(input: { readonly jobId: string; readonly unresolved: boolean; readonly nowMs: number }): Promise<void> {
    const wallet = await this.#jobWallet(this.sql, input.jobId); if (wallet === null) return;
    await this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, input.jobId);
      const job = await this.#getJobOn(tx, input.jobId, true); if (job === null) return;
      const active = await tx.query(`/* quantRebalance.markEndedUnresolved */ select 1 from quant_rebalance_actions where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS} limit 1`, [input.jobId]);
      const unresolved = input.unresolved || active.rows.length > 0;
      await this.#writeJobOn(tx, { ...job, status: unresolved ? "ended-unresolved" : "ended", rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
    });
  }
  async recordReportAttempt(input: { readonly jobId: string; readonly payloadDigest: Hex; readonly responseStatus: number; readonly notesApplied: number | null; readonly nowMs: number }): Promise<RebalanceCas<QuantRebalanceJobRow>> {
    const wallet = await this.#jobWallet(this.sql, input.jobId);
    if (wallet === null || !/^0x[0-9a-fA-F]{64}$/u.test(input.payloadDigest)
      || !Number.isSafeInteger(input.responseStatus) || (input.responseStatus !== 0 && (input.responseStatus < 100 || input.responseStatus > 599))
      || (input.notesApplied !== null && (!Number.isSafeInteger(input.notesApplied) || input.notesApplied < 0))) {
      return { kind: "conflict", record: null };
    }
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, input.jobId);
      const job = await this.#getJobOn(tx, input.jobId, true);
      if (job === null || job.status !== "ended" || job.reportAttempts >= REBALANCE_MAX_REPORT_ATTEMPTS) return { kind: "conflict", record: job };
      const unresolved = await tx.query(`/* quantRebalance.reportAttemptUnresolved */ select 1 from quant_rebalance_actions where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS} limit 1`, [input.jobId]);
      if (unresolved.rows.length > 0) return { kind: "inconsistent", code: "action-unresolved" };
      const next = { ...job, reportAttempts: job.reportAttempts + 1, reportPayloadDigest: input.payloadDigest,
        reportResponseStatus: input.responseStatus, reportNotesApplied: input.notesApplied,
        rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs };
      await this.#writeJobOn(tx, next); return { kind: "ok", record: next };
    });
  }
  async markReported(input: { readonly jobId: string; readonly nowMs: number }): Promise<boolean> {
    const wallet = await this.#jobWallet(this.sql, input.jobId); if (wallet === null) return false;
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet); await this.#lockJob(tx, input.jobId);
      const job = await this.#getJobOn(tx, input.jobId, true); if (job === null || job.status !== "ended"
        || job.reportAttempts < 1 || job.reportResponseStatus !== 200) return false;
      const unresolved = await tx.query(`/* quantRebalance.reportUnresolved */ select 1 from quant_rebalance_actions where job_id=$1 and state not in ${PG_TERMINAL_ACTIONS} limit 1`, [input.jobId]);
      if (unresolved.rows.length > 0) return false;
      await this.#writeJobOn(tx, { ...job, status: "reported", reportedAtMs: input.nowMs, rowVersion: job.rowVersion + 1, updatedAtMs: input.nowMs });
      return true;
    });
  }

  async close(): Promise<void> { await this.sql.close(); }

  async #lockJob(tx: SqlClient, jobId: string): Promise<void> {
    await tx.query(`/* quantRebalance.jobFence */ select pg_advisory_xact_lock($1::integer, hashtext($2))`, [QUANT_REBALANCE_JOB_LOCK_CLASSID, jobId]);
  }
  async #jobWallet(sql: SqlClient, jobId: string): Promise<Address | null> {
    const result = await sql.query<Record<string, unknown>>(`/* quantRebalance.wallet */ select wallet_address from quant_rebalance_jobs where job_id=$1`, [jobId]);
    const raw = result.rows[0]?.["wallet_address"];
    return typeof raw === "string" ? getAddress(raw) : null;
  }
  async #getJobOn(sql: SqlClient, jobId: string, forUpdate = false): Promise<QuantRebalanceJobRow | null> {
    const result = await sql.query<Record<string, unknown>>(`/* quantRebalance.getJob${forUpdate ? "ForUpdate" : ""} */ select data_json from quant_rebalance_jobs where job_id=$1 ${forUpdate ? "for update" : ""}`, [jobId]);
    const raw = result.rows[0]?.["data_json"];
    return raw === undefined ? null : decodeJob(raw);
  }
  async #getCheckOn(sql: SqlClient, checkId: string, forUpdate = false): Promise<QuantRebalanceCheckRow | null> {
    const result = await sql.query<Record<string, unknown>>(`/* quantRebalance.getCheck${forUpdate ? "ForUpdate" : ""} */ select data_json from quant_rebalance_checks where check_id=$1 ${forUpdate ? "for update" : ""}`, [checkId]);
    const raw = result.rows[0]?.["data_json"];
    return raw === undefined ? null : decodeCheck(raw);
  }
  async #getActionOn(sql: SqlClient, actionId: string, forUpdate = false): Promise<QuantRebalanceActionRow | null> {
    const result = await sql.query<Record<string, unknown>>(`/* quantRebalance.getAction${forUpdate ? "ForUpdate" : ""} */ select data_json from quant_rebalance_actions where action_id=$1 ${forUpdate ? "for update" : ""}`, [actionId]);
    const raw = result.rows[0]?.["data_json"];
    return raw === undefined ? null : decodeAction(raw);
  }
  async #insertJobOn(tx: SqlClient, row: QuantRebalanceJobRow): Promise<void> {
    await tx.query(`/* quantRebalance.insertJob */ insert into quant_rebalance_jobs
      (job_id,strategy_id,wallet_address,status,admitted_at_ms,baseline_json,managed_json,claim_generation,row_version,data_json,created_at_ms,updated_at_ms)
      values($1,$2,$3,$4,null,null,null,null,$5::int,$6::jsonb,$7::bigint,$7::bigint)
      on conflict(job_id) do nothing`,
    [row.jobId, row.strategyId, row.tradingWallet.toLowerCase(), row.status, row.rowVersion, encodeJsonbParam(row), row.createdAtMs]);
  }
  async #writeJobOn(tx: SqlClient, row: QuantRebalanceJobRow): Promise<void> {
    const baseline = row.actualBaselineJson === null ? null : row.actualBaselineJson;
    const managed = row.managed === null ? null : encodeJsonbParam(row.managed);
    await tx.query(`/* quantRebalance.writeJob */ update quant_rebalance_jobs set strategy_id=$2,wallet_address=$3,status=$4,
      admitted_at_ms=$5::bigint,baseline_json=$6::jsonb,managed_json=$7::jsonb,claim_generation=$8::numeric,
      row_version=$9::int,data_json=$10::jsonb,updated_at_ms=$11::bigint where job_id=$1`,
    [row.jobId, row.strategyId, row.tradingWallet.toLowerCase(), row.status, row.admittedAtMs,
      baseline, managed, row.claimGeneration?.toString(10) ?? null, row.rowVersion, encodeJsonbParam(row), row.updatedAtMs]);
  }
  async #insertCheckOn(tx: SqlClient, row: QuantRebalanceCheckRow): Promise<void> {
    await tx.query(`/* quantRebalance.insertCheck */ insert into quant_rebalance_checks
      (check_id,job_id,check_kind,slot,state,row_version,data_json,created_at_ms,updated_at_ms)
      values($1,$2,$3,$4::int,$5,$6::int,$7::jsonb,$8::bigint,$8::bigint)
      on conflict(job_id,check_kind,slot) do nothing`,
    [row.checkId, row.jobId, row.kind, row.slot, row.state, row.rowVersion, encodeJsonbParam(row), row.createdAtMs]);
  }
  async #writeCheckOn(tx: SqlClient, row: QuantRebalanceCheckRow): Promise<void> {
    await tx.query(`/* quantRebalance.writeCheck */ update quant_rebalance_checks set state=$2,row_version=$3::int,data_json=$4::jsonb,updated_at_ms=$5::bigint where check_id=$1`,
      [row.checkId, row.state, row.rowVersion, encodeJsonbParam(row), row.updatedAtMs]);
  }
  async #writeActionOn(tx: SqlClient, row: QuantRebalanceActionRow): Promise<void> {
    await tx.query(`/* quantRebalance.writeAction */ update quant_rebalance_actions set state=$2,tx_hash=$3,row_version=$4::int,data_json=$5::jsonb,updated_at_ms=$6::bigint where action_id=$1`,
      [row.actionId, row.state, row.txHash?.toLowerCase() ?? null, row.rowVersion, encodeJsonbParam(row), row.updatedAtMs]);
  }
}

export async function createQuantRebalanceStore(input: {
  readonly databaseUrl?: string;
  readonly initializeSchema?: boolean;
  readonly claims?: QuantWalletClaimStore;
} = {}): Promise<QuantRebalanceStore> {
  const databaseUrl = input.databaseUrl ?? process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") return new MemoryQuantRebalanceStore(input.claims);
  const store = new PostgresQuantRebalanceStore(await createPgSqlClient(databaseUrl));
  if (input.initializeSchema === true) await store.ensureSchema();
  return store;
}

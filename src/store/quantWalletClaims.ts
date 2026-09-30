/** Shared Grid/rebalance wallet ownership, with fenced provisional admission. */
import { getAddress, type Address } from "viem";
import { createPgSqlClient, type SqlClient } from "./sql.js";

export type QuantClaimStrategyKind = "grid" | "rebalance";
export type QuantWalletClaimMode = "free" | "provisional" | "active";
export type QuantWalletClaim = {
  readonly chainId: 56;
  readonly wallet: Address;
  readonly mode: QuantWalletClaimMode;
  readonly strategyKind: QuantClaimStrategyKind | null;
  readonly strategyId: string | null;
  readonly jobId: string | null;
  readonly attemptId: string | null;
  readonly generation: bigint;
  readonly rowVersion: number;
  readonly provisionalExpiresAtMs: number | null;
  readonly lastRefusal: string | null;
  readonly updatedAtMs: number;
};

export type ClaimNoActionProof = {
  readonly admittedAtNull: boolean;
  readonly noAdmissionBaselineOrManagedState: boolean;
  readonly noActionOrCheckRowsBothStores: boolean;
  readonly noJournalDecisionBothKinds: boolean;
  readonly noReceiptOwnershipForJobKeys: boolean;
  readonly noSubmittedOrClaimTransition: boolean;
};
export type ClaimAttemptInput = {
  readonly wallet: Address;
  readonly strategyKind: QuantClaimStrategyKind;
  readonly strategyId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly nowMs: number;
};
export type QuantClaimProofReader = {
  readonly noAction: (jobId: string) => Promise<boolean>;
  readonly terminalAndNoUnresolved: (input: { readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint }) => Promise<boolean>;
};
export type ClaimAttemptResult =
  | { readonly kind: "acquired"; readonly claim: QuantWalletClaim }
  | { readonly kind: "held"; readonly claim: QuantWalletClaim }
  | { readonly kind: "claim-inconsistent" };

export const QUANT_WALLET_CLAIM_LOCK_CLASSID = 0x5157_434c; // "QWCL"
export const QUANT_WALLET_CLAIM_TTL_MS = 120_000;

export const QUANT_WALLET_CLAIMS_DDL = `
  create table if not exists quant_wallet_claims (
    chain_id int not null check (chain_id = 56),
    wallet_address text not null,
    mode text not null check (mode in ('free','provisional','active')),
    strategy_kind text null check (strategy_kind in ('grid','rebalance')),
    strategy_id text null,
    job_id text null,
    attempt_id text null,
    generation numeric not null check (generation > 0),
    row_version int not null check (row_version > 0),
    provisional_expires_at_ms bigint null,
    last_refusal text null,
    updated_at_ms bigint not null,
    primary key (chain_id, wallet_address),
    check ((mode = 'free' and strategy_kind is null and strategy_id is null and job_id is null and attempt_id is null and provisional_expires_at_ms is null)
      or (mode = 'provisional' and strategy_kind is not null and strategy_id is not null and job_id is not null and attempt_id is not null and provisional_expires_at_ms is not null)
      or (mode = 'active' and strategy_kind is not null and strategy_id is not null and job_id is not null and attempt_id is null and provisional_expires_at_ms is null))
  )
`;

export const QUANT_WALLET_CLAIM_MIGRATION_DDL = `
  create table if not exists quant_wallet_claim_migration (
    migration_version int primary key check (migration_version = 1),
    census_digest text not null,
    disposition_digest text not null,
    installed_at_ms bigint not null,
    installed_by text not null
  )
`;

function walletKey(wallet: Address): string { return getAddress(wallet).toLowerCase(); }
function safeRefusal(code: string): string {
  return /^[a-z0-9-]{1,64}$/u.test(code) ? code : "admission-refused";
}
function validProof(proof: ClaimNoActionProof): boolean {
  return proof.admittedAtNull && proof.noAdmissionBaselineOrManagedState
    && proof.noActionOrCheckRowsBothStores && proof.noJournalDecisionBothKinds
    && proof.noReceiptOwnershipForJobKeys && proof.noSubmittedOrClaimTransition;
}

const NO_MEMORY_PROOF: QuantClaimProofReader = Object.freeze({
  noAction: async () => false,
  terminalAndNoUnresolved: async () => false,
});

function parseClaimRow(row: Record<string, unknown>): QuantWalletClaim {
  const chainId = Number(row["chain_id"]);
  const wallet = row["wallet_address"];
  const mode = row["mode"];
  const kind = row["strategy_kind"];
  const strategyId = row["strategy_id"];
  const jobId = row["job_id"];
  const attemptId = row["attempt_id"];
  const generationRaw = row["generation"];
  const version = Number(row["row_version"]);
  const expiresRaw = row["provisional_expires_at_ms"];
  const refusal = row["last_refusal"];
  const updatedAt = Number(row["updated_at_ms"]);
  if (chainId !== 56 || typeof wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(wallet)
    || !(mode === "free" || mode === "provisional" || mode === "active")
    || !(kind === null || kind === "grid" || kind === "rebalance")
    || !(strategyId === null || typeof strategyId === "string") || !(jobId === null || typeof jobId === "string")
    || !(attemptId === null || typeof attemptId === "string")
    || !(typeof generationRaw === "string" || typeof generationRaw === "number" || typeof generationRaw === "bigint")
    || !Number.isSafeInteger(version) || version <= 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0
    || !(expiresRaw === null || Number.isSafeInteger(Number(expiresRaw)))
    || !(refusal === null || typeof refusal === "string")) throw new Error("wallet-claim-row-invalid");
  const generation = BigInt(String(generationRaw));
  if (generation <= 0n) throw new Error("wallet-claim-row-invalid");
  const shapeOk = mode === "free"
    ? kind === null && strategyId === null && jobId === null && attemptId === null && expiresRaw === null
    : mode === "provisional"
      ? kind !== null && strategyId !== null && jobId !== null && attemptId !== null && expiresRaw !== null
      : kind !== null && strategyId !== null && jobId !== null && attemptId === null && expiresRaw === null;
  if (!shapeOk) throw new Error("wallet-claim-row-invalid");
  return {
    chainId: 56, wallet: getAddress(wallet) as Address, mode,
    strategyKind: kind, strategyId, jobId, attemptId, generation, rowVersion: version,
    provisionalExpiresAtMs: expiresRaw === null ? null : Number(expiresRaw),
    lastRefusal: refusal, updatedAtMs: updatedAt,
  };
}

export async function lockQuantWalletClaim(tx: SqlClient, wallet: Address): Promise<void> {
  const key = `56:${walletKey(wallet)}`;
  await tx.query(
    `/* quantWalletClaims.lock */ select pg_advisory_xact_lock($1::integer, hashtext($2))`,
    [QUANT_WALLET_CLAIM_LOCK_CLASSID, key],
  );
}

export async function ensureQuantWalletClaimSchema(sql: SqlClient): Promise<void> {
  await sql.query(QUANT_WALLET_CLAIMS_DDL);
}

export async function quantWalletClaimSchemaInstalled(sql: SqlClient): Promise<boolean> {
  const result = await sql.query<{ readonly present: boolean }>(
    `/* quantWalletClaims.schema */ select to_regclass('public.quant_wallet_claims') is not null as present`,
  );
  return result.rows[0]?.present === true;
}

export async function readQuantWalletClaimOn(
  tx: SqlClient,
  wallet: Address,
  forUpdate = false,
): Promise<QuantWalletClaim | null> {
  const result = await tx.query<Record<string, unknown>>(
    `/* quantWalletClaims.get${forUpdate ? "ForUpdate" : ""} */
     select chain_id, wallet_address, mode, strategy_kind, strategy_id, job_id, attempt_id,
       generation, row_version, provisional_expires_at_ms, last_refusal, updated_at_ms
     from quant_wallet_claims where chain_id = 56 and wallet_address = $1 ${forUpdate ? "for update" : ""}`,
    [walletKey(wallet)],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return parseClaimRow(row);
}

export async function quantWalletClaimActiveOn(tx: SqlClient, input: {
  readonly wallet: Address;
  readonly strategyKind: QuantClaimStrategyKind;
  readonly strategyId: string;
  readonly jobId: string;
  readonly generation: bigint;
}): Promise<boolean> {
  const row = await readQuantWalletClaimOn(tx, input.wallet, true);
  return row?.mode === "active" && row.strategyKind === input.strategyKind
    && row.strategyId === input.strategyId && row.jobId === input.jobId
    && row.generation === input.generation;
}

export async function quantWalletClaimProvisionalOn(tx: SqlClient, input: {
  readonly wallet: Address;
  readonly strategyKind: QuantClaimStrategyKind;
  readonly strategyId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly generation: bigint;
  readonly nowMs: number;
}): Promise<boolean> {
  const row = await readQuantWalletClaimOn(tx, input.wallet, true);
  return row?.mode === "provisional" && row.strategyKind === input.strategyKind
    && row.strategyId === input.strategyId && row.jobId === input.jobId
    && row.attemptId === input.attemptId && row.generation === input.generation
    && row.provisionalExpiresAtMs !== null && row.provisionalExpiresAtMs > input.nowMs;
}

/** The proof reads every relevant durable namespace in the same transaction as reclaim/release. */
export async function proveNoQuantActionOn(tx: SqlClient, jobId: string): Promise<ClaimNoActionProof> {
  const result = await tx.query<Record<string, unknown>>(
    `/* quantWalletClaims.noActionProof */
     select
       exists(select 1 from quant_jobs where quant_job_id=$1 and admitted_at_ms is not null) as admitted,
       exists(select 1 from quant_epochs where quant_job_id=$1) as grid_baseline,
       exists(select 1 from quant_rebalance_jobs where job_id=$1 and admitted_at_ms is not null) as rebalance_admitted,
       exists(select 1 from quant_rebalance_jobs where job_id=$1 and (baseline_json is not null or managed_json is not null)) as rebalance_state,
       exists(select 1 from quant_actions where quant_job_id=$1) as grid_actions,
       exists(select 1 from quant_rebalance_actions where job_id=$1) as rebalance_actions,
       exists(select 1 from quant_rebalance_checks where job_id=$1) as rebalance_checks,
       exists(select 1 from execution_journal where agent_id=$1 and kind='quantTrade') as journal_rows,
       exists(select 1 from quant_receipt_ownership ro where ro.journal_key in (
         select journal_key from quant_actions where quant_job_id=$1
         union select journal_key from quant_rebalance_actions where job_id=$1
       )) as receipt_rows,
       exists(select 1 from quant_rebalance_actions where job_id=$1 and state <> 'intended') as submitted_action,
       exists(select 1 from quant_jobs where quant_job_id=$1 and status <> 'discovered') as grid_transition` ,
    [jobId],
  );
  const row = result.rows[0] ?? {};
  const falseRow = (key: string) => row[key] === false;
  const noAdmission = falseRow("admitted") && falseRow("rebalance_admitted") && falseRow("grid_baseline");
  const noActions = falseRow("grid_actions") && falseRow("rebalance_actions") && falseRow("rebalance_checks");
  const noJournal = falseRow("journal_rows");
  const noReceipts = falseRow("receipt_rows");
  const noSubmitted = falseRow("submitted_action");
  return {
    admittedAtNull: noAdmission,
    noAdmissionBaselineOrManagedState: noAdmission && falseRow("rebalance_state"),
    noActionOrCheckRowsBothStores: noActions,
    noJournalDecisionBothKinds: noJournal,
    noReceiptOwnershipForJobKeys: noReceipts,
    noSubmittedOrClaimTransition: noSubmitted && falseRow("grid_transition"),
  };
}

export interface QuantWalletClaimStore {
  ensureSchema(): Promise<void>;
  schemaInstalled(): Promise<boolean>;
  migrationInstalled(): Promise<boolean>;
  /** All money/admission writers share this wallet-first fence. */
  withWalletFence<T>(wallet: Address, work: (tx?: SqlClient) => Promise<T>): Promise<T>;
  claimProvisional(input: ClaimAttemptInput): Promise<ClaimAttemptResult>;
  refreshProvisional(input: ClaimAttemptInput & { readonly generation: bigint }): Promise<QuantWalletClaim | null>;
  isProvisional(input: ClaimAttemptInput & { readonly generation: bigint }): Promise<boolean>;
  releaseProvisional(input: ClaimAttemptInput & { readonly generation: bigint; readonly refusal: string }): Promise<"released" | "stale" | "claim-inconsistent">;
  promoteProvisional<T>(input: ClaimAttemptInput & { readonly generation: bigint }, commitAdmission: (tx?: SqlClient) => Promise<T | null>): Promise<{ readonly promoted: boolean; readonly value: T | null }>;
  isActive(input: { readonly wallet: Address; readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint }, tx?: SqlClient): Promise<boolean>;
  releaseTerminal(input: { readonly wallet: Address; readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint; readonly nowMs: number }): Promise<boolean>;
  list(): Promise<readonly QuantWalletClaim[]>;
  close(): Promise<void>;
}

type LockMap = Map<string, Promise<void>>;
async function withMemoryLock<T>(locks: LockMap, key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => gate));
  await previous;
  try { return await work(); } finally { release(); }
}

export class MemoryQuantWalletClaimStore implements QuantWalletClaimStore {
  readonly #claims = new Map<string, QuantWalletClaim>();
  readonly #locks: LockMap = new Map();
  constructor(private readonly proofs: QuantClaimProofReader = NO_MEMORY_PROOF, private readonly migrationReady = false) {}
  async ensureSchema(): Promise<void> {}
  async schemaInstalled(): Promise<boolean> { return true; }
  async migrationInstalled(): Promise<boolean> { return this.migrationReady; }
  withWalletFence<T>(wallet: Address, work: (tx?: SqlClient) => Promise<T>): Promise<T> {
    return withMemoryLock(this.#locks, walletKey(wallet), () => work(undefined));
  }
  async claimProvisional(input: ClaimAttemptInput): Promise<ClaimAttemptResult> {
    const wallet = walletKey(input.wallet);
    return withMemoryLock(this.#locks, wallet, async () => {
      const current = this.#claims.get(wallet);
      let base = current;
      if (current?.mode === "provisional" && current.provisionalExpiresAtMs !== null
        && current.provisionalExpiresAtMs <= input.nowMs) {
        if (!(await this.proofs.noAction(current.jobId ?? ""))) return { kind: "claim-inconsistent" };
        base = {
          chainId: 56, wallet: current.wallet, mode: "free", strategyKind: null, strategyId: null,
          jobId: null, attemptId: null, generation: current.generation + 1n,
          rowVersion: current.rowVersion + 1, provisionalExpiresAtMs: null,
          lastRefusal: "expired-reclaimed", updatedAtMs: input.nowMs,
        };
        this.#claims.set(wallet, base);
      }
      if (base !== undefined && base.mode !== "free") return { kind: "held", claim: structuredClone(base) };
      const generation = (base?.generation ?? 0n) + 1n;
      const claim: QuantWalletClaim = {
        chainId: 56, wallet: getAddress(wallet), mode: "provisional", strategyKind: input.strategyKind,
        strategyId: input.strategyId, jobId: input.jobId, attemptId: input.attemptId,
        generation, rowVersion: (base?.rowVersion ?? 0) + 1,
        provisionalExpiresAtMs: input.nowMs + QUANT_WALLET_CLAIM_TTL_MS, lastRefusal: null, updatedAtMs: input.nowMs,
      };
      this.#claims.set(wallet, claim);
      return { kind: "acquired", claim: structuredClone(claim) };
    });
  }
  async refreshProvisional(input: ClaimAttemptInput & { readonly generation: bigint }): Promise<QuantWalletClaim | null> {
    const wallet = walletKey(input.wallet);
    return withMemoryLock(this.#locks, wallet, async () => {
      const current = this.#claims.get(wallet);
      if (current === undefined || current.mode !== "provisional" || current.jobId !== input.jobId
        || current.attemptId !== input.attemptId || current.generation !== input.generation
        || current.provisionalExpiresAtMs === null || current.provisionalExpiresAtMs <= input.nowMs) return null;
      const next = { ...current, provisionalExpiresAtMs: input.nowMs + QUANT_WALLET_CLAIM_TTL_MS,
        rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs };
      this.#claims.set(wallet, next); return structuredClone(next);
    });
  }
  async isProvisional(input: ClaimAttemptInput & { readonly generation: bigint }): Promise<boolean> {
    const row = this.#claims.get(walletKey(input.wallet));
    return row?.mode === "provisional" && row.strategyKind === input.strategyKind && row.strategyId === input.strategyId
      && row.jobId === input.jobId && row.attemptId === input.attemptId && row.generation === input.generation
      && row.provisionalExpiresAtMs !== null && row.provisionalExpiresAtMs > input.nowMs;
  }
  async releaseProvisional(input: ClaimAttemptInput & { readonly generation: bigint; readonly refusal: string }): Promise<"released" | "stale" | "claim-inconsistent"> {
    const wallet = walletKey(input.wallet);
    return withMemoryLock(this.#locks, wallet, async () => {
      const current = this.#claims.get(wallet);
      if (current === undefined || current.mode !== "provisional" || current.jobId !== input.jobId
        || current.attemptId !== input.attemptId || current.generation !== input.generation) return "stale";
      if (!(await this.proofs.noAction(input.jobId))) return "claim-inconsistent";
      // The Memory runtime invokes this only after querying both memory stores and
      // the journal under the same wallet fence; an explicit record prevents a
      // caller from using unconditional finally-cleanup.
      const next: QuantWalletClaim = {
        chainId: 56, wallet: current.wallet, mode: "free", strategyKind: null, strategyId: null,
        jobId: null, attemptId: null, generation: current.generation + 1n,
        rowVersion: current.rowVersion + 1, provisionalExpiresAtMs: null,
        lastRefusal: safeRefusal(input.refusal), updatedAtMs: input.nowMs,
      };
      this.#claims.set(wallet, next); return "released";
    });
  }
  async promoteProvisional<T>(input: ClaimAttemptInput & { readonly generation: bigint }, commitAdmission: (tx?: SqlClient) => Promise<T | null>): Promise<{ readonly promoted: boolean; readonly value: T | null }> {
    const wallet = walletKey(input.wallet);
    return withMemoryLock(this.#locks, wallet, async () => {
      const current = this.#claims.get(wallet);
      if (current === undefined || current.mode !== "provisional" || current.jobId !== input.jobId
        || current.attemptId !== input.attemptId || current.generation !== input.generation
        || current.provisionalExpiresAtMs === null || current.provisionalExpiresAtMs <= input.nowMs) return { promoted: false, value: null };
      const value = await commitAdmission();
      if (value === null) return { promoted: false, value: null };
      this.#claims.set(wallet, {
        ...current, mode: "active", attemptId: null, provisionalExpiresAtMs: null,
        rowVersion: current.rowVersion + 1, updatedAtMs: input.nowMs,
      });
      return { promoted: true, value };
    });
  }
  async isActive(input: { readonly wallet: Address; readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint }, _tx?: SqlClient): Promise<boolean> {
    const row = this.#claims.get(walletKey(input.wallet));
    return row?.mode === "active" && row.strategyKind === input.strategyKind && row.strategyId === input.strategyId
      && row.jobId === input.jobId && row.generation === input.generation;
  }
  async releaseTerminal(input: { readonly wallet: Address; readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint; readonly nowMs: number }): Promise<boolean> {
    const wallet = walletKey(input.wallet);
    return withMemoryLock(this.#locks, wallet, async () => {
      const current = this.#claims.get(wallet);
      if (current?.mode !== "active" || current.strategyKind !== input.strategyKind || current.strategyId !== input.strategyId
        || current.jobId !== input.jobId || current.generation !== input.generation) return false;
      if (!(await this.proofs.terminalAndNoUnresolved({ strategyKind: input.strategyKind, strategyId: input.strategyId, jobId: input.jobId, generation: input.generation }))) return false;
      this.#claims.set(wallet, {
        chainId: 56, wallet: current.wallet, mode: "free", strategyKind: null, strategyId: null,
        jobId: null, attemptId: null, generation: current.generation + 1n,
        rowVersion: current.rowVersion + 1, provisionalExpiresAtMs: null, lastRefusal: null, updatedAtMs: input.nowMs,
      });
      return true;
    });
  }
  async list(): Promise<readonly QuantWalletClaim[]> { return [...this.#claims.values()].map((row) => structuredClone(row)); }
  async close(): Promise<void> {}
}

export class PostgresQuantWalletClaimStore implements QuantWalletClaimStore {
  constructor(private readonly sql: SqlClient) {}
  async ensureSchema(): Promise<void> {
    await ensureQuantWalletClaimSchema(this.sql);
    await this.sql.query(QUANT_WALLET_CLAIM_MIGRATION_DDL);
  }
  schemaInstalled(): Promise<boolean> { return quantWalletClaimSchemaInstalled(this.sql); }
  async migrationInstalled(): Promise<boolean> {
    const exists = await this.sql.query<{ readonly present: boolean }>(
      `/* quantWalletClaims.migrationTable */ select to_regclass('public.quant_wallet_claim_migration') is not null as present`,
    );
    if (exists.rows[0]?.present !== true) return false;
    const row = await this.sql.query<Record<string, unknown>>(
      `/* quantWalletClaims.migrationInstalled */ select migration_version,census_digest,disposition_digest,installed_at_ms
       from quant_wallet_claim_migration where migration_version=1`,
    );
    const item = row.rows[0];
    return item !== undefined && Number(item["migration_version"]) === 1
      && typeof item["census_digest"] === "string" && /^0x[0-9a-fA-F]{64}$/u.test(item["census_digest"])
      && typeof item["disposition_digest"] === "string" && /^0x[0-9a-fA-F]{64}$/u.test(item["disposition_digest"])
      && Number.isSafeInteger(Number(item["installed_at_ms"])) && Number(item["installed_at_ms"]) > 0;
  }
  withWalletFence<T>(wallet: Address, work: (tx?: SqlClient) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet);
      return work(tx);
    });
  }
  async claimProvisional(input: ClaimAttemptInput): Promise<ClaimAttemptResult> {
    const wallet = getAddress(input.wallet) as Address;
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet);
      let current = await readQuantWalletClaimOn(tx, wallet, true);
      if (current !== null && current.mode === "provisional" && current.provisionalExpiresAtMs !== null
        && current.provisionalExpiresAtMs <= input.nowMs) {
        const proof = await proveNoQuantActionOn(tx, current.jobId ?? "");
        if (!validProof(proof)) return { kind: "claim-inconsistent" };
        await tx.query(`/* quantWalletClaims.expire */ update quant_wallet_claims set mode='free', strategy_kind=null, strategy_id=null, job_id=null,
          attempt_id=null, generation=generation+1, row_version=row_version+1, provisional_expires_at_ms=null,
          last_refusal='expired-reclaimed', updated_at_ms=$2::bigint where chain_id=56 and wallet_address=$1 and generation=$3::numeric`,
        [walletKey(wallet), input.nowMs, current.generation.toString(10)]);
        current = await readQuantWalletClaimOn(tx, wallet, true);
      }
      if (current !== null && current.mode !== "free") return { kind: "held", claim: current };
      const generation = (current?.generation ?? 0n) + 1n;
      const inserted = await tx.query(`/* quantWalletClaims.acquire */ insert into quant_wallet_claims
        (chain_id,wallet_address,mode,strategy_kind,strategy_id,job_id,attempt_id,generation,row_version,provisional_expires_at_ms,last_refusal,updated_at_ms)
        values (56,$1,'provisional',$2,$3,$4,$5,$6::numeric,$7::int,$8::bigint,null,$9::bigint)
        on conflict (chain_id,wallet_address) do update set mode='provisional',strategy_kind=excluded.strategy_kind,
        strategy_id=excluded.strategy_id,job_id=excluded.job_id,attempt_id=excluded.attempt_id,generation=excluded.generation,
        row_version=excluded.row_version,provisional_expires_at_ms=excluded.provisional_expires_at_ms,last_refusal=null,updated_at_ms=excluded.updated_at_ms
        where quant_wallet_claims.mode='free' returning chain_id`,
      [walletKey(wallet), input.strategyKind, input.strategyId, input.jobId, input.attemptId, generation.toString(10), (current?.rowVersion ?? 0) + 1,
        input.nowMs + QUANT_WALLET_CLAIM_TTL_MS, input.nowMs]);
      if (inserted.rows.length !== 1) {
        const held = await readQuantWalletClaimOn(tx, wallet, true);
        return held === null ? { kind: "claim-inconsistent" } : { kind: "held", claim: held };
      }
      const acquired = await readQuantWalletClaimOn(tx, wallet, true);
      return acquired?.mode === "provisional" && acquired.jobId === input.jobId && acquired.attemptId === input.attemptId
        ? { kind: "acquired", claim: acquired } : { kind: "claim-inconsistent" };
    });
  }
  async refreshProvisional(input: ClaimAttemptInput & { readonly generation: bigint }): Promise<QuantWalletClaim | null> {
    const wallet = getAddress(input.wallet) as Address;
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet);
      await tx.query(`/* quantWalletClaims.refresh */ update quant_wallet_claims set provisional_expires_at_ms=$7::bigint,
        row_version=row_version+1,updated_at_ms=$8::bigint where chain_id=56 and wallet_address=$1 and mode='provisional'
        and strategy_kind=$2 and strategy_id=$3 and job_id=$4 and attempt_id=$5 and generation=$6::numeric
        and provisional_expires_at_ms>$8::bigint`,
      [walletKey(wallet), input.strategyKind, input.strategyId, input.jobId, input.attemptId, input.generation.toString(10),
        input.nowMs + QUANT_WALLET_CLAIM_TTL_MS, input.nowMs]);
      const current = await readQuantWalletClaimOn(tx, wallet, true);
      return current?.mode === "provisional" && current.jobId === input.jobId && current.attemptId === input.attemptId
        && current.generation === input.generation && current.provisionalExpiresAtMs !== null && current.provisionalExpiresAtMs > input.nowMs ? current : null;
    });
  }
  async isProvisional(input: ClaimAttemptInput & { readonly generation: bigint }): Promise<boolean> {
    const row = await readQuantWalletClaimOn(this.sql, input.wallet);
    return row?.mode === "provisional" && row.strategyKind === input.strategyKind && row.strategyId === input.strategyId
      && row.jobId === input.jobId && row.attemptId === input.attemptId && row.generation === input.generation
      && row.provisionalExpiresAtMs !== null && row.provisionalExpiresAtMs > input.nowMs;
  }
  async releaseProvisional(input: ClaimAttemptInput & { readonly generation: bigint; readonly refusal: string }): Promise<"released" | "stale" | "claim-inconsistent"> {
    const wallet = getAddress(input.wallet) as Address;
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet);
      const current = await readQuantWalletClaimOn(tx, wallet, true);
      if (current?.mode !== "provisional" || current.jobId !== input.jobId || current.attemptId !== input.attemptId || current.generation !== input.generation) return "stale";
      const proof = await proveNoQuantActionOn(tx, input.jobId);
      if (!validProof(proof)) return "claim-inconsistent";
      await tx.query(`/* quantWalletClaims.release */ update quant_wallet_claims set mode='free',strategy_kind=null,strategy_id=null,job_id=null,attempt_id=null,
        generation=generation+1,row_version=row_version+1,provisional_expires_at_ms=null,last_refusal=$4,updated_at_ms=$5::bigint
        where chain_id=56 and wallet_address=$1 and mode='provisional' and job_id=$2 and attempt_id=$3 and generation=$6::numeric`,
      [walletKey(wallet), input.jobId, input.attemptId, safeRefusal(input.refusal), input.nowMs, input.generation.toString(10)]);
      return "released";
    });
  }
  async promoteProvisional<T>(input: ClaimAttemptInput & { readonly generation: bigint }, commitAdmission: (tx?: SqlClient) => Promise<T | null>): Promise<{ readonly promoted: boolean; readonly value: T | null }> {
    const wallet = getAddress(input.wallet) as Address;
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet);
      const current = await readQuantWalletClaimOn(tx, wallet, true);
      if (current?.mode !== "provisional" || current.jobId !== input.jobId || current.attemptId !== input.attemptId
        || current.generation !== input.generation || current.provisionalExpiresAtMs === null || current.provisionalExpiresAtMs <= input.nowMs) {
        return { promoted: false, value: null };
      }
      const value = await commitAdmission(tx);
      if (value === null) return { promoted: false, value: null };
      const result = await tx.query(`/* quantWalletClaims.promote */ update quant_wallet_claims set mode='active',attempt_id=null,
        provisional_expires_at_ms=null,row_version=row_version+1,updated_at_ms=$5::bigint
        where chain_id=56 and wallet_address=$1 and mode='provisional' and job_id=$2 and attempt_id=$3 and generation=$4::numeric
        and provisional_expires_at_ms>$5::bigint returning job_id`,
      [walletKey(wallet), input.jobId, input.attemptId, input.generation.toString(10), input.nowMs]);
      return result.rows.length === 1 ? { promoted: true, value } : { promoted: false, value: null };
    });
  }
  async isActive(input: { readonly wallet: Address; readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint }, tx?: SqlClient): Promise<boolean> {
    const row = await readQuantWalletClaimOn(tx ?? this.sql, input.wallet);
    return row?.mode === "active" && row.strategyKind === input.strategyKind && row.strategyId === input.strategyId && row.jobId === input.jobId && row.generation === input.generation;
  }
  async releaseTerminal(input: { readonly wallet: Address; readonly strategyKind: QuantClaimStrategyKind; readonly strategyId: string; readonly jobId: string; readonly generation: bigint; readonly nowMs: number }): Promise<boolean> {
    const wallet = getAddress(input.wallet) as Address;
    return this.sql.transaction(async (tx) => {
      await lockQuantWalletClaim(tx, wallet);
      const result = await tx.query(`/* quantWalletClaims.releaseActive */ update quant_wallet_claims set mode='free',strategy_kind=null,strategy_id=null,
        job_id=null,attempt_id=null,generation=generation+1,row_version=row_version+1,last_refusal=null,updated_at_ms=$6::bigint
        where chain_id=56 and wallet_address=$1 and mode='active' and strategy_kind=$2 and strategy_id=$3 and job_id=$4 and generation=$5::numeric
        and not exists(select 1 from quant_actions where quant_job_id=$4 and state not in ('settled','failed','aborted'))
        and not exists(select 1 from quant_rebalance_actions where job_id=$4 and state not in ('settled','failed','aborted'))
        and not exists(select 1 from execution_journal where agent_id=$4 and kind='quantTrade'
          and (state not in ('COMMITTED','ROLLED_BACK') or (state='COMMITTED' and nullif(external_ref->>'txHash','') is null)))
        and ((strategy_kind='grid' and exists(select 1 from quant_jobs where quant_job_id=$4 and status in ('ended','reported')))
          or (strategy_kind='rebalance' and exists(select 1 from quant_rebalance_jobs where job_id=$4 and status in ('ended','reported')))) returning wallet_address`,
      [walletKey(wallet), input.strategyKind, input.strategyId, input.jobId, input.generation.toString(10), input.nowMs]);
      return result.rows.length === 1;
    });
  }
  async list(): Promise<readonly QuantWalletClaim[]> {
    const result = await this.sql.query<Record<string, unknown>>(`/* quantWalletClaims.list */ select * from quant_wallet_claims order by wallet_address asc`);
    return result.rows.map(parseClaimRow);
  }
  async close(): Promise<void> { await this.sql.close(); }
}

export async function createQuantWalletClaimStore(input: { readonly databaseUrl?: string } = {}): Promise<QuantWalletClaimStore> {
  const databaseUrl = input.databaseUrl ?? process.env["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") return new MemoryQuantWalletClaimStore();
  return new PostgresQuantWalletClaimStore(await createPgSqlClient(databaseUrl));
}

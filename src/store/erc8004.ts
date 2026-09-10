import type { SqlClient } from "./sql.js";
import { IDENTITY_AGENT_INDEX, IDENTITY_AGENT_MIGRATION } from "./erc8004Sources.js";
import { ERROR_CODES, fail, isObject, validId, validRef, validHash, validCategory, REGISTRY, type IdentityBinding, type IdentityFence, type IdentityJob, type IdentityTransaction, type LedgerState } from "../identity/types.js";
import { metadataUriFor } from "../identity/metadata.js";
import { phaseCalldata } from "../identity/registry.js";

export const IDENTITY_DDL = [IDENTITY_AGENT_MIGRATION, IDENTITY_AGENT_INDEX,
  `create table if not exists erc8004_jobs (public_ref text primary key, owner_address text not null, source_id text not null, chain integer not null check(chain=56), minter text not null, document jsonb not null, unique(owner_address,source_id))`,
  `create table if not exists erc8004_transactions (hash text primary key, job_ref text not null references erc8004_jobs(public_ref), phase text not null check(phase in ('register','update')), chain integer not null check(chain=56), minter text not null, nonce bigint not null check(nonce>=0), document jsonb not null, unique(job_ref,phase), unique(chain,minter,nonce))`,
  `create table if not exists erc8004_nonces (chain integer not null check(chain=56), minter text not null, next_nonce bigint check(next_nonce>=0), primary key(chain,minter))`,
] as const;
export async function migrateIdentity(sql: SqlClient): Promise<void> { await sql.transaction(async (tx) => { for (const ddl of IDENTITY_DDL) await tx.query(ddl); }); }
export async function checkIdentitySchema(sql: SqlClient): Promise<void> {
  try {
    await sql.query(`select public_ref,owner_address,source_id,chain,minter,document from erc8004_jobs limit 0`);
    await sql.query(`select hash,job_ref,phase,chain,minter,nonce,document from erc8004_transactions limit 0`);
    await sql.query(`select chain,minter,next_nonce from erc8004_nonces limit 0`);
    await sql.query(`select erc8004_identity,erc8004_agent_id from agents limit 0`);
    const indexes = await sql.query<{ table_name: string; key_columns: string[]; expression: string | null; predicate: string | null }>(`
      /* erc8004.schemaIndexes */
      select t.relname as table_name,
        array(select a.attname::text from unnest(i.indkey) with ordinality k(attnum,ord)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
          where k.ord<=i.indnkeyatts order by k.ord) as key_columns,
        pg_get_expr(i.indexprs,i.indrelid) as expression, pg_get_expr(i.indpred,i.indrelid) as predicate
      from pg_index i join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=t.relnamespace
      where n.nspname=current_schema() and t.relname in ('agents','erc8004_jobs','erc8004_transactions','erc8004_nonces')
        and i.indisunique and i.indisvalid and i.indimmediate`);
    const unique = (table: string, columns: string[]) => indexes.rows.some((row) => row.table_name === table && row.expression === null && row.predicate === null && JSON.stringify(row.key_columns) === JSON.stringify(columns));
    if (!unique("erc8004_jobs", ["public_ref"]) || !unique("erc8004_jobs", ["owner_address", "source_id"])
      || !unique("erc8004_transactions", ["hash"]) || !unique("erc8004_transactions", ["job_ref", "phase"])
      || !unique("erc8004_transactions", ["chain", "minter", "nonce"]) || !unique("erc8004_nonces", ["chain", "minter"])
      || !indexes.rows.some((row) => row.table_name === "agents" && row.key_columns.length === 0
        && row.expression !== null && /^\s*\(*\s*erc8004_identity\s*->>\s*'publicRef'\s*(?:::\s*text)?\s*\)*\s*$/.test(row.expression)
        && row.predicate !== null && /^\s*\(*\s*erc8004_identity\s+is\s+not\s+null\s*\)*\s*$/i.test(row.predicate))) fail("schema_missing");
  } catch { fail("schema_missing"); }
}
export interface IdentityLedger {
  read(): Promise<LedgerState>;
  atomic<T>(fence: IdentityFence, fn: (state: LedgerState) => Promise<T> | T): Promise<T>;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function decimal(value: unknown): value is string { return validId(value); }
function epoch(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function address(value: unknown): value is string { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value); }
export function validateLedger(state: LedgerState, binding: IdentityBinding): void {
  if (state.nextNonce !== null && !epoch(state.nextNonce)) fail("intent_mismatch");
  const refs = new Set<string>(); const sourceIds = new Set<string>(); const displayNumbers = new Set<string>(); const hashes = new Set<string>(); const phases = new Set<string>(); const nonces = new Set<number>();
  for (const job of state.jobs) {
    if (!isObject(job) || !validRef(job.publicRef) || !address(job.owner) || typeof job.sourceId !== "string" || !validCategory(job.category)
      || job.chainId !== 56 || job.registry.toLowerCase() !== REGISTRY.toLowerCase() || job.registry.toLowerCase() !== binding.registry.toLowerCase() || job.minter.toLowerCase() !== binding.minter.toLowerCase()
      || job.displayNumber !== undefined && (!Number.isSafeInteger(job.displayNumber) || job.displayNumber < 1)
      || job.metadataVersion !== undefined && ![1, 2, 3].includes(job.metadataVersion)
      || job.initialUri !== metadataUriFor(job.metadataVersion, job.category, job.displayNumber, job.publicRef)
      || job.mintedId !== null && !validId(job.mintedId)
      || job.finalUri !== (job.mintedId === null ? null : metadataUriFor(job.metadataVersion, job.category, job.displayNumber, job.publicRef, job.mintedId))
      || !epoch(job.createdAt) || job.completedAt !== null && !epoch(job.completedAt)
      || !["pending", "registering", "updating", "registered", "blocked"].includes(job.status)
      || job.registrationHash !== null && !validHash(job.registrationHash) || job.updateHash !== null && !validHash(job.updateHash)
      || [job.envelope, job.effectiveCeiling, job.updateGasCeiling, job.updatePriceCeiling].some((v) => v !== null && (!decimal(v) || BigInt(v) === 0n))) fail("intent_mismatch");
    if (refs.has(job.publicRef) || sourceIds.has(`${job.owner.toLowerCase()}:${job.sourceId}`)) fail("conflict");
    refs.add(job.publicRef); sourceIds.add(`${job.owner.toLowerCase()}:${job.sourceId}`);
    if ((job.metadataVersion ?? 1) >= 2) {
      const displayKey = `${job.owner.toLowerCase()}:${job.category}:${job.displayNumber}`;
      if (displayNumbers.has(displayKey)) fail("conflict");
      displayNumbers.add(displayKey);
    }
    if (job.registrationHash === null && (job.envelope !== null || job.mintedId !== null || job.updateHash !== null)
      || job.registrationHash !== null && [job.envelope, job.effectiveCeiling, job.updateGasCeiling, job.updatePriceCeiling].some((v) => v === null)
      || job.completedAt !== null && (job.status !== "registered" || job.mintedId === null || job.updateHash === null)
      || job.envelope !== null && BigInt(job.envelope) > BigInt(job.effectiveCeiling!)) fail("intent_mismatch");
    if ((job.status === "blocked") !== (job.error !== null) || job.error !== null && !ERROR_CODES.includes(job.error)
      || job.status === "pending" && job.registrationHash !== null
      || job.status === "registering" && (job.registrationHash === null || job.mintedId !== null || job.updateHash !== null)
      || job.status === "updating" && (job.registrationHash === null || job.mintedId === null)
      || (job.status === "registered") !== (job.completedAt !== null)) fail("intent_mismatch");
  }
  for (const tx of state.transactions) {
    const intent = tx.intent;
    if (!validHash(tx.hash) || !refs.has(tx.jobRef) || (tx.phase !== "register" && tx.phase !== "update") || !isObject(intent)
      || intent.chainId !== 56 || intent.minter.toLowerCase() !== binding.minter.toLowerCase() || intent.to.toLowerCase() !== binding.registry.toLowerCase()
      || intent.value !== "0" || intent.type !== "legacy" || !epoch(intent.nonce) || !decimal(intent.gas) || BigInt(intent.gas) === 0n || !decimal(intent.gasPrice) || BigInt(intent.gasPrice) === 0n
      || !epoch(tx.preparedAt) || tx.finalizedAt !== null && !epoch(tx.finalizedAt)
      || typeof intent.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(intent.data)
      || hashes.has(tx.hash) || phases.has(`${tx.jobRef}:${tx.phase}`) || nonces.has(intent.nonce)
      || state.nextNonce === null || intent.nonce >= state.nextNonce) fail("intent_mismatch");
    if (tx.finalizedAt === null ? tx.outcome !== null || tx.blockNumber !== null || tx.blockHash !== null
      : (tx.outcome !== "success" && tx.outcome !== "reverted") || !validId(tx.blockNumber) || !validHash(tx.blockHash)) fail("intent_mismatch");
    hashes.add(tx.hash); phases.add(`${tx.jobRef}:${tx.phase}`); nonces.add(intent.nonce);
    const job = state.jobs.find((item) => item.publicRef === tx.jobRef)!;
    if ((tx.phase === "register" ? job.registrationHash : job.updateHash) !== tx.hash || intent.data !== phaseCalldata(job, tx.phase)) fail("intent_mismatch");
  }
  for (const job of state.jobs) {
    for (const hash of [job.registrationHash, job.updateHash]) if (hash !== null && !hashes.has(hash)) fail("intent_mismatch");
    const first = state.transactions.find((tx) => tx.hash === job.registrationHash);
    const update = state.transactions.find((tx) => tx.hash === job.updateHash);
    if (first && (first.jobRef !== job.publicRef || first.phase !== "register" || BigInt(first.intent.gas) * BigInt(first.intent.gasPrice)
      + BigInt(job.updateGasCeiling!) * BigInt(job.updatePriceCeiling!) !== BigInt(job.envelope!))) fail("intent_mismatch");
    if (update && (update.jobRef !== job.publicRef || update.phase !== "update" || !first || first.outcome !== "success" || first.finalizedAt === null
      || BigInt(update.intent.gas) > BigInt(job.updateGasCeiling!) || BigInt(update.intent.gasPrice) > BigInt(job.updatePriceCeiling!))) fail("intent_mismatch");
    if (job.completedAt !== null && (!first || !update || first.outcome !== "success" || update.outcome !== "success"
      || first.finalizedAt === null || update.finalizedAt === null || job.completedAt < update.finalizedAt)) fail("intent_mismatch");
  }
}
/** A mutation cannot erase evidence or widen a previous one-run approval. */
function validateTransition(before: LedgerState, after: LedgerState, binding: IdentityBinding): void {
  validateLedger(after, binding);
  if (before.nextNonce !== null && (after.nextNonce === null || after.nextNonce < before.nextNonce)) fail("intent_mismatch");
  for (const old of before.jobs) {
    const next = after.jobs.find((job) => job.publicRef === old.publicRef); if (!next) fail("intent_mismatch");
    for (const key of ["owner", "sourceId", "publicRef", "category", "chainId", "registry", "minter", "createdAt", "initialUri"] as const) if (old[key] !== next[key]) fail("intent_mismatch");
    for (const key of ["registrationHash", "updateHash", "mintedId", "finalUri", "envelope", "updateGasCeiling", "updatePriceCeiling", "completedAt"] as const) if (old[key] !== null && old[key] !== next[key]) fail("intent_mismatch");
    if (old.effectiveCeiling !== null && (next.effectiveCeiling === null || BigInt(next.effectiveCeiling) > BigInt(old.effectiveCeiling))) fail("fee_limit");
  }
  for (const old of before.transactions) {
    const next = after.transactions.find((tx) => tx.hash === old.hash); if (!next) fail("intent_mismatch");
    for (const key of ["hash", "jobRef", "phase", "intent", "preparedAt"] as const) if (!same(old[key], next[key])) fail("intent_mismatch");
    for (const key of ["finalizedAt", "blockNumber", "blockHash", "outcome"] as const) if (old[key] !== null && old[key] !== next[key]) fail("intent_mismatch");
  }
}
export class MemoryIdentityLedger implements IdentityLedger {
  #state: LedgerState = { jobs: [], transactions: [], nextNonce: null }; #tail: Promise<void> = Promise.resolve();
  constructor(readonly binding: IdentityBinding) {}
  async read(): Promise<LedgerState> { validateLedger(this.#state, this.binding); return structuredClone(this.#state); }
  async atomic<T>(fence: IdentityFence, fn: (state: LedgerState) => Promise<T> | T): Promise<T> {
    const predecessor = this.#tail; let release!: () => void; this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try { fence.check(); const next = await this.read(); const result = await fn(next); validateTransition(this.#state, next, this.binding); fence.check(); this.#state = structuredClone(next); return result; }
    finally { release(); }
  }
}
/** All persistence uses the SqlClient transaction seam; session fencing is separate. */
export class PostgresIdentityLedger implements IdentityLedger {
  constructor(readonly sql: SqlClient, readonly binding: IdentityBinding) {}
  async #read(sql: SqlClient): Promise<LedgerState> {
    const params = [this.binding.chainId, this.binding.minter.toLowerCase()];
    const jobs = await sql.query<{ document: IdentityJob }>(`/* erc8004.jobs */ select document from erc8004_jobs where chain=$1 and minter=$2 order by public_ref`, params);
    const txs = await sql.query<{ document: IdentityTransaction }>(`/* erc8004.transactions */ select document from erc8004_transactions where chain=$1 and minter=$2 order by nonce`, params);
    const nonce = await sql.query<{ next_nonce: string | null }>(`/* erc8004.nonce */ select next_nonce from erc8004_nonces where chain=$1 and minter=$2`, params);
    const value = nonce.rows[0]?.next_nonce ?? null;
    const state: LedgerState = { jobs: jobs.rows.map((row) => row.document), transactions: txs.rows.map((row) => row.document), nextNonce: value === null ? null : Number(value) };
    try { validateLedger(state, this.binding); } catch { fail("intent_mismatch"); }
    return state;
  }
  read(): Promise<LedgerState> { return this.#read(this.sql); }
  async atomic<T>(fence: IdentityFence, fn: (state: LedgerState) => Promise<T> | T): Promise<T> {
    return this.sql.transaction(async (sql) => {
      fence.check();
      await sql.query(`/* erc8004.nonceEnsure */ insert into erc8004_nonces(chain,minter,next_nonce) values($1,$2,null) on conflict(chain,minter) do nothing`, [56, this.binding.minter.toLowerCase()]);
      fence.check();
      await sql.query(`/* erc8004.nonceLock */ select next_nonce from erc8004_nonces where chain=$1 and minter=$2 for update`, [56, this.binding.minter.toLowerCase()]);
      fence.check();
      const before = await this.#read(sql); const state = structuredClone(before); const result = await fn(state);
      validateTransition(before, state, this.binding);
      for (const job of state.jobs) {
        const old = before.jobs.find((item) => item.publicRef === job.publicRef); if (same(old, job)) continue;
        fence.check();
        if (!old) await sql.query(`/* erc8004.jobInsert */ insert into erc8004_jobs(public_ref,owner_address,source_id,chain,minter,document) values($1,$2,$3,$4,$5,$6::jsonb)`, [job.publicRef, job.owner.toLowerCase(), job.sourceId, 56, job.minter.toLowerCase(), JSON.stringify(job)]);
        else await sql.query(`/* erc8004.jobUpdate */ update erc8004_jobs set document=$2::jsonb where public_ref=$1`, [job.publicRef, JSON.stringify(job)]);
      }
      for (const tx of state.transactions) {
        const old = before.transactions.find((item) => item.hash === tx.hash); if (same(old, tx)) continue;
        fence.check();
        if (!old) await sql.query(`/* erc8004.txInsert */ insert into erc8004_transactions(hash,job_ref,phase,chain,minter,nonce,document) values($1,$2,$3,$4,$5,$6,$7::jsonb)`, [tx.hash, tx.jobRef, tx.phase, 56, tx.intent.minter.toLowerCase(), tx.intent.nonce, JSON.stringify(tx)]);
        else await sql.query(`/* erc8004.txUpdate */ update erc8004_transactions set document=$2::jsonb where hash=$1`, [tx.hash, JSON.stringify(tx)]);
      }
      if (state.nextNonce !== before.nextNonce) { fence.check(); await sql.query(`/* erc8004.nonceUpdate */ update erc8004_nonces set next_nonce=$3 where chain=$1 and minter=$2`, [56, this.binding.minter.toLowerCase(), state.nextNonce]); }
      fence.check(); return result;
    });
  }
}
export function dailyLiability(state: LedgerState, now: number): bigint {
  return state.jobs.reduce((sum, job) => sum + (job.envelope !== null && (job.completedAt === null || now < job.completedAt + 86_400_000) ? BigInt(job.envelope) : 0n), 0n);
}

import { getAddress, type Address } from "viem";
import { identityFenceKey } from "./fence.js";
import { decodeIdentity, ERROR_CODES, fail, isObject, REGISTRY, validCategory, validHash, validId, validIdentity, validRef, type IdentityJob, type IdentityErrorCode } from "./types.js";
import type { MigrationNonceReader, MinterMigrationConfig } from "./minterMigration.js";
import { checkIdentitySchema, checkIdentityNumberingSchema, validateLedger, validateIdentityTransaction } from "../store/erc8004.js";
import type { SqlClient } from "../store/sql.js";

export type NonceResyncRequest = { readonly minter: Address; readonly fromNonce: number; readonly toNonce: number; readonly apply: boolean };
export type NonceResyncSkipReason = "evidence_present" | "source_missing" | "source_inactive" | "projection_mismatch" | "revision_overflow";
export type NonceResyncResult = {
  readonly mode: "dry-run" | "apply"; readonly applied: boolean; readonly minter: Address;
  readonly fromNonce: number; readonly toNonce: number;
  readonly unblocked: { sourceId: string; publicRef: string }[];
  readonly skipped: { sourceId: string; reason: NonceResyncSkipReason }[];
};
function address(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail("arguments_invalid");
  return getAddress(value);
}
function validateRequest(request: NonceResyncRequest): void {
  address(request.minter);
  if (!Number.isSafeInteger(request.fromNonce) || request.fromNonce < 0 || !Number.isSafeInteger(request.toNonce)
    || request.toNonce <= request.fromNonce || typeof request.apply !== "boolean") fail("arguments_invalid");
}
export function parseNonceResyncCommand(args: readonly string[]): NonceResyncRequest {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (values.has(name) || !["--minter", "--from", "--to", "--apply"].includes(name)) fail("arguments_invalid");
    if (name === "--apply") values.set(name, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--") || value.length > 128) fail("arguments_invalid");
      values.set(name, value);
    }
  }
  const from = values.get("--from"); const to = values.get("--to");
  if (typeof from !== "string" || typeof to !== "string" || !/^(0|[1-9][0-9]*)$/.test(from) || !/^(0|[1-9][0-9]*)$/.test(to)) fail("arguments_invalid");
  const request = { minter: address(values.get("--minter")), fromNonce: Number(from), toNonce: Number(to), apply: values.has("--apply") };
  validateRequest(request); return request;
}

type AgentRow = { id: string; owner_address: string; status: string; erc8004_identity: unknown; erc8004_agent_id: string | null };
type JobRow = { public_ref: string; source_id: string; owner_address: string; chain: number; minter: string; document: unknown };
type TransactionRow = { hash: string; job_ref: string; phase: string; chain: number; minter: string; nonce: string; document: unknown };
const JOB_KEYS = "category,chainId,completedAt,createdAt,effectiveCeiling,envelope,error,finalUri,initialUri,minter,mintedId,owner,publicRef,registrationHash,registry,sourceId,status,updateGasCeiling,updateHash,updatePriceCeiling".split(",");
class DryRunRollback extends Error {
  constructor(readonly result: NonceResyncResult) { super("dry_run_rollback"); }
}

/** The fence covers only this database. External history/exclusivity and gap finality are operator prerequisites (review A). */
export async function resyncIdentityNonce(
  sql: SqlClient, config: MinterMigrationConfig, request: NonceResyncRequest, reader: MigrationNonceReader,
): Promise<NonceResyncResult> {
  // Nested transactions run inline; catching a dry-run rollback there could commit the writes.
  if (sql.transactionScope !== "top-level") fail("invalid_config");
  validateRequest(request);
  if (config.chainId !== 56) fail("invalid_config");
  if (address(config.minter) !== address(request.minter)) fail("arguments_invalid");
  const minter = request.minter.toLowerCase();
  const binding = { chainId: 56, registry: REGISTRY, minter: request.minter } as const;
  try {
    return await sql.transaction(async (tx) => {
      await tx.query("set transaction isolation level serializable");
      await tx.query("set local lock_timeout = '5s'");
      await tx.query("set local statement_timeout = '15s'");
      await tx.query("set local idle_in_transaction_session_timeout = '30s'");
      const lock = await tx.query<{ locked: boolean }>(`/* nonceResync.fence */ select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked`, [identityFenceKey(binding)]);
      if (lock.rows[0]?.locked !== true) fail("lock_busy");
      await checkIdentitySchema(tx);
      await checkIdentityNumberingSchema(tx);
      const nonces = await tx.query<{ chain: number; minter: string; next_nonce: string | null }>(`/* nonceResync.nonce */ select chain,minter,next_nonce from erc8004_nonces
        where lower(minter)=$1 order by chain,minter collate "C" for update`, [minter]);
      const nonce = nonces.rows[0];
      if (nonces.rows.length !== 1 || !nonce || nonce.chain !== 56 || nonce.minter !== minter || nonce.next_nonce !== String(request.fromNonce)) fail("nonce_conflict");
      const rows = await tx.query<JobRow>(`/* nonceResync.jobs */ select public_ref,source_id,owner_address,chain,minter,document from erc8004_jobs
        where lower(minter)=$1 or lower(document->>'minter')=$1 order by public_ref collate "C" for update`, [minter]);
      const jobs = rows.rows.map((row) => {
        const value = row.document;
        if (!isObject(value) || Object.keys(value).some((key) => ![...JOB_KEYS, "displayNumber", "metadataVersion"].includes(key))
          || JOB_KEYS.some((key) => !Object.hasOwn(value, key))
          || row.public_ref !== value.publicRef || row.source_id !== value.sourceId || row.chain !== 56 || value.chainId !== row.chain
          || typeof value.owner !== "string" || row.owner_address !== value.owner.toLowerCase()
          || typeof value.minter !== "string" || row.minter !== minter || value.minter.toLowerCase() !== minter
          || typeof value.registry !== "string" || value.registry.toLowerCase() !== REGISTRY.toLowerCase()
          || !validRef(value.publicRef) || typeof value.sourceId !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.owner)
          || !validCategory(value.category) || typeof value.initialUri !== "string" || value.finalUri !== null && typeof value.finalUri !== "string"
          || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
          || value.completedAt !== null && (!Number.isSafeInteger(value.completedAt) || (value.completedAt as number) < 0)
          || typeof value.status !== "string" || !["pending", "registering", "updating", "registered", "blocked"].includes(value.status)
          || value.error !== null && !ERROR_CODES.includes(value.error as IdentityErrorCode)
          || value.mintedId !== null && !validId(value.mintedId)
          || value.registrationHash !== null && !validHash(value.registrationHash) || value.updateHash !== null && !validHash(value.updateHash)
          || [value.envelope, value.effectiveCeiling, value.updateGasCeiling, value.updatePriceCeiling].some((v) => v !== null && (!validId(v) || BigInt(v) === 0n))
          || Object.hasOwn(value, "displayNumber") && (!Number.isSafeInteger(value.displayNumber) || (value.displayNumber as number) < 1)
          || (value.metadataVersion === 2 || value.metadataVersion === 3) && value.displayNumber === undefined
          || Object.hasOwn(value, "metadataVersion") && ![1, 2, 3].includes(value.metadataVersion as number)) fail("intent_mismatch");
        return value as IdentityJob;
      });
      const refs = [...new Set(rows.rows.flatMap((row) => [row.public_ref, (row.document as IdentityJob).publicRef]))];
      const transactions = await tx.query<TransactionRow>(`/* nonceResync.transactions */ select hash,job_ref,phase,chain,minter,nonce,document from erc8004_transactions
        where lower(minter)=$1 or lower(document->'intent'->>'minter')=$1
          or job_ref=any($2::text[]) or document->>'jobRef'=any($2::text[])
        order by hash collate "C" for update`, [minter, refs]);
      const history = transactions.rows.map((row) => {
        const value = row.document;
        validateIdentityTransaction(value, binding);
        if (row.hash !== value.hash || row.job_ref !== value.jobRef || row.phase !== value.phase
          || row.chain !== value.intent.chainId || row.minter !== minter || row.minter !== value.intent.minter.toLowerCase()
          || row.nonce !== String(value.intent.nonce)) fail("intent_mismatch");
        return value;
      });
      if (history.some((item) => item.finalizedAt === null)) fail("other_job_pending");
      if (history.some((item) => item.intent.nonce >= request.fromNonce)) fail("nonce_conflict");
      validateLedger({ jobs, transactions: history, nextNonce: request.fromNonce }, binding);
      const chain = await reader.read(request.minter);
      if (chain.chainId !== 56) fail("invalid_config");
      if (chain.latest !== request.toNonce || chain.pending !== chain.latest) fail("nonce_conflict");
      const saved = await tx.query<{ minter: string }>(`/* nonceResync.saveNonce */ update erc8004_nonces set next_nonce=$3
        where chain=56 and minter=$1 and next_nonce=$2 returning minter`, [minter, request.fromNonce, request.toNonce]);
      if (saved.rows.length !== 1) fail("conflict");
      const result: NonceResyncResult = { mode: request.apply ? "apply" : "dry-run", applied: request.apply, minter: request.minter,
        fromNonce: request.fromNonce, toNonce: request.toNonce, unblocked: [], skipped: [] };
      for (let index = 0; index < jobs.length; index++) {
        const job = jobs[index]!;
        if (job.status !== "blocked" || job.error !== "nonce_conflict") continue;
        let reason: NonceResyncSkipReason | undefined;
        if ([job.registrationHash, job.updateHash, job.mintedId, job.finalUri, job.envelope, job.effectiveCeiling,
          job.updateGasCeiling, job.updatePriceCeiling, job.completedAt].some((value) => value !== null)
          || history.some((item) => item.jobRef === job.publicRef)) reason = "evidence_present";
        if (reason) { result.skipped.push({ sourceId: job.sourceId, reason }); continue; }
        // Only projection columns enter this process; customer authority is never read.
        const agents = await tx.query<AgentRow>(`/* nonceResync.agent */ select id,owner_address,status,erc8004_identity,erc8004_agent_id from agents where id=$1 for update`, [job.sourceId]);
        const agent = agents.rows[0];
        const identity = decodeIdentity(agent?.erc8004_identity, false);
        if (!agent) reason = "source_missing";
        else if (!["armed", "paused"].includes(agent.status)) reason = "source_inactive";
        else if (agents.rows.length !== 1 || agent.id !== job.sourceId || !/^0x[0-9a-f]{40}$/.test(agent.owner_address)
          || agent.owner_address !== job.owner.toLowerCase() || agent.erc8004_agent_id !== null
          || !validIdentity(identity) || identity.publicRef !== job.publicRef || identity.category !== job.category
          || identity.status !== "blocked" || identity.errorCode !== "nonce_conflict"
          || identity.agentId !== null || identity.registrationTxHash !== null || identity.uriUpdateTxHash !== null) reason = "projection_mismatch";
        else if (!Number.isSafeInteger(identity.revision + 1)) reason = "revision_overflow";
        if (reason) { result.skipped.push({ sourceId: job.sourceId, reason }); continue; }
        if (!agent || !validIdentity(identity)) fail("conflict");
        const replacement: IdentityJob = { ...job, status: "pending", error: null };
        const nextIdentity = { ...identity, status: "pending" as const, errorCode: null, revision: identity.revision + 1 };
        if (!validIdentity(decodeIdentity(nextIdentity, false))) fail("invalid_identity");
        const replaced = await tx.query<{ public_ref: string }>(`/* nonceResync.replace */ update erc8004_jobs set document=$6::jsonb
          where public_ref=$1 and source_id=$2 and owner_address=$3 and chain=56 and minter=$4 and document=$5::jsonb returning public_ref`,
          [job.publicRef, job.sourceId, job.owner.toLowerCase(), minter, JSON.stringify(job), JSON.stringify(replacement)]);
        if (replaced.rows.length !== 1) fail("conflict");
        const projected = await tx.query<{ id: string }>(`/* nonceResync.project */ update agents set erc8004_identity=$4::jsonb
          where id=$1 and owner_address=$2 and erc8004_identity=$3::jsonb and erc8004_agent_id is null and status in ('armed','paused') returning id`,
          [job.sourceId, agent.owner_address, JSON.stringify(agent.erc8004_identity), JSON.stringify(nextIdentity)]);
        if (projected.rows.length !== 1) fail("conflict");
        jobs[index] = replacement;
        result.unblocked.push({ sourceId: job.sourceId, publicRef: job.publicRef });
      }
      validateLedger({ jobs, transactions: history, nextNonce: request.toNonce }, binding);
      if (!request.apply) throw new DryRunRollback(result);
      return result;
    });
  } catch (error) { if (error instanceof DryRunRollback) return error.result; throw error; }
}

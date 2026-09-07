import { createHash } from "node:crypto";
import { getAddress, type Address } from "viem";
import { identityFenceKey } from "./fence.js";
import { decodeIdentity, fail, isObject, REGISTRY, validCategory, validIdentity, validRef, type IdentityCategory, type IdentityJob } from "./types.js";
import { checkIdentitySchema, checkIdentityNumberingSchema, validateLedger, validateIdentityTransaction } from "../store/erc8004.js";
import type { SqlClient } from "../store/sql.js";

// This is the cleared one-instance recovery, not a general ledger reset API.
export const MINTER_RECOVERY = {
  sourceId: "trading-agent-01-2",
  oldMinter: "0xD7E004CBda24E079aA3A657Ba7f8E2915192a966",
  newMinter: "0x273987e9d86D5231b0Be928Aba88129AC479Ca9d",
  category: "trading",
} as const;
export type MinterMigrationRequest = {
  readonly sourceId: string; readonly oldMinter: Address; readonly newMinter: Address;
  readonly publicRef: string; readonly category: IdentityCategory; readonly apply: boolean;
};
export type MinterMigrationConfig = { readonly chainId: 56; readonly minter: Address };
/** Public RPC facts only; deliberately no signer, registry, wallet or key seam. */
export interface MigrationNonceReader {
  read(minter: Address): Promise<{ readonly chainId: number; readonly latest: number; readonly pending: number }>;
}
export type MinterMigrationResult = {
  readonly mode: "dry-run" | "apply"; readonly applied: boolean; readonly sourceId: string;
  readonly publicRef: string; readonly category: IdentityCategory; readonly oldMinter: Address; readonly newMinter: Address;
  readonly nextNonce: number; readonly previousRevision: number; readonly nextRevision: number; readonly initialUriSha256: string;
};
function address(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail("arguments_invalid");
  return getAddress(value);
}
export function validateMinterMigrationRequest(request: MinterMigrationRequest): void {
  if (request.sourceId !== MINTER_RECOVERY.sourceId || !validRef(request.publicRef)
    || !validCategory(request.category) || request.category !== MINTER_RECOVERY.category || typeof request.apply !== "boolean"
    || address(request.oldMinter) !== MINTER_RECOVERY.oldMinter || address(request.newMinter) !== MINTER_RECOVERY.newMinter) fail("arguments_invalid");
}
export function parseMinterMigrationCommand(args: readonly string[]): MinterMigrationRequest {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (values.has(name) || !["--source-id", "--old-minter", "--new-minter", "--public-ref", "--category", "--apply"].includes(name)) fail("arguments_invalid");
    if (name === "--apply") values.set(name, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--") || value.length > 128) fail("arguments_invalid");
      values.set(name, value);
    }
  }
  const sourceId = values.get("--source-id"); const publicRef = values.get("--public-ref"); const category = values.get("--category");
  if (typeof sourceId !== "string" || typeof publicRef !== "string" || !validCategory(category)) fail("arguments_invalid");
  const request = { sourceId, publicRef, category, oldMinter: address(values.get("--old-minter")), newMinter: address(values.get("--new-minter")), apply: values.has("--apply") };
  validateMinterMigrationRequest(request); return request;
}

type AgentRow = { id: string; owner_address: string; status: string; erc8004_identity: unknown; erc8004_agent_id: string | null };
type JobRow = { public_ref: string; source_id: string; owner_address: string; chain: number; minter: string; document: unknown };
type TransactionRow = { hash: string; job_ref: string; phase: string; chain: number; minter: string; nonce: string; document: unknown };
const JOB_KEYS = "category,chainId,completedAt,createdAt,effectiveCeiling,envelope,error,finalUri,initialUri,minter,mintedId,owner,publicRef,registrationHash,registry,sourceId,status,updateGasCeiling,updateHash,updatePriceCeiling".split(",");
function evidenceFreeJob(row: JobRow, request: MinterMigrationRequest, owner: string): IdentityJob {
  const value = row.document;
  if (!isObject(value) || Object.keys(value).some((key) => ![...JOB_KEYS, "displayNumber", "metadataVersion"].includes(key))
    || JOB_KEYS.some((key) => !Object.hasOwn(value, key))
    || row.public_ref !== request.publicRef || row.source_id !== request.sourceId || row.owner_address !== owner
    || row.chain !== 56 || row.minter !== request.oldMinter.toLowerCase()
    || value.publicRef !== row.public_ref || value.sourceId !== row.source_id || value.chainId !== row.chain
    || typeof value.owner !== "string" || value.owner.toLowerCase() !== owner
    || typeof value.minter !== "string" || value.minter.toLowerCase() !== row.minter
    || typeof value.registry !== "string" || value.category !== request.category
    || value.status !== "blocked" || value.error !== "nonce_conflict"
    || ["mintedId", "finalUri", "registrationHash", "updateHash", "envelope", "effectiveCeiling", "updateGasCeiling", "updatePriceCeiling", "completedAt"].some((key) => value[key] !== null)) fail("intent_mismatch");
  const job = value as IdentityJob;
  validateLedger({ jobs: [job], transactions: [], nextNonce: null }, { chainId: 56, registry: REGISTRY, minter: request.oldMinter });
  return job;
}
class DryRunRollback extends Error {
  constructor(readonly result: MinterMigrationResult) { super("dry_run_rollback"); }
}

/**
 * Both advisory locks live on the mutation transaction's connection. PostgreSQL
 * transaction locks conflict with the worker's session locks using the SAME key;
 * connection loss therefore aborts the writes as well as releasing the fences.
 * Missing nonce rows are fenced by those locks; never insert an old nonce row.
 * Dry-run exercises the same writes/constraints, then deliberately rolls back.
 */
export async function migrateEvidenceFreeMinter(
  sql: SqlClient, config: MinterMigrationConfig, request: MinterMigrationRequest, reader: MigrationNonceReader,
): Promise<MinterMigrationResult> {
  // Nested SqlClient.transaction calls run inline. Refuse before even opening
  // a transaction: swallowing the dry-run sentinel there would commit writes.
  if (sql.transactionScope !== "top-level") fail("invalid_config");
  validateMinterMigrationRequest(request);
  if (config.chainId !== 56 || address(config.minter) !== request.newMinter) fail("invalid_config");
  try {
    return await sql.transaction(async (tx) => {
      await tx.query("set transaction isolation level serializable");
      await tx.query("set local lock_timeout = '5s'");
      await tx.query("set local statement_timeout = '15s'");
      await tx.query("set local idle_in_transaction_session_timeout = '30s'");
      const minters = [request.oldMinter.toLowerCase(), request.newMinter.toLowerCase()].sort();
      for (const minter of minters) {
        const lock = await tx.query<{ locked: boolean }>(`/* minterMigration.fence */ select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked`,
          [identityFenceKey({ chainId: 56, registry: REGISTRY, minter: minter as Address })]);
        if (lock.rows[0]?.locked !== true) fail("lock_busy");
      }
      await checkIdentitySchema(tx);
      await checkIdentityNumberingSchema(tx);
      // No SELECT *: customer key/authority columns never enter this process.
      const agents = await tx.query<AgentRow>(`/* minterMigration.agent */ select id,owner_address,status,erc8004_identity,erc8004_agent_id from agents where id=$1 for update`, [request.sourceId]);
      const agent = agents.rows[0];
      if (agents.rows.length !== 1 || !agent) fail("not_found");
      const identity = decodeIdentity(agent.erc8004_identity, false);
      if (agent.id !== request.sourceId || !/^0x[0-9a-f]{40}$/.test(agent.owner_address)
        || !["armed", "paused"].includes(agent.status) || agent.erc8004_agent_id !== null
        || !validIdentity(identity) || identity.publicRef !== request.publicRef || identity.category !== request.category
        || identity.status !== "blocked" || identity.errorCode !== "nonce_conflict"
        || identity.agentId !== null || identity.registrationTxHash !== null || identity.uriUpdateTxHash !== null
        || !Number.isSafeInteger(identity.revision + 1)) fail("invalid_identity");
      // Examine relational AND JSON bindings, so disagreement cannot hide a job.
      const jobs = await tx.query<JobRow>(`/* minterMigration.jobs */ select public_ref,source_id,owner_address,chain,minter,document from erc8004_jobs
        where public_ref=$1 or source_id=$2 or document->>'publicRef'=$1 or document->>'sourceId'=$2
          or ((lower(minter)=$3 or lower(document->>'minter')=$3) and (lower(owner_address)=$4 or lower(document->>'owner')=$4))
        order by public_ref collate "C" for update`, [request.publicRef, request.sourceId, request.newMinter.toLowerCase(), agent.owner_address]);
      if (jobs.rows.length !== 1 || !jobs.rows[0]) fail("conflict");
      const job = evidenceFreeJob(jobs.rows[0], request, agent.owner_address);
      const nonces = await tx.query<{ chain: number; minter: string; next_nonce: string | null }>(`/* minterMigration.nonces */ select chain,minter,next_nonce from erc8004_nonces
        where lower(minter)=any($1::text[]) order by minter collate "C" for update`, [minters]);
      if (nonces.rows.some((row) => row.chain !== 56 || !minters.includes(row.minter))
        || new Set(nonces.rows.map((row) => row.minter)).size !== nonces.rows.length) fail("nonce_conflict");
      const transactions = await tx.query<TransactionRow>(`/* minterMigration.transactions */ select hash,job_ref,phase,chain,minter,nonce,document from erc8004_transactions
        where job_ref=$1 or document->>'jobRef'=$1
          or lower(minter)=any($2::text[]) or lower(document->'intent'->>'minter')=any($2::text[])
        order by hash collate "C" for update`, [request.publicRef, minters]);
      for (const row of transactions.rows) {
        const value = row.document;
        if (row.job_ref === request.publicRef || isObject(value) && value.jobRef === request.publicRef) fail("other_job_pending");
        validateIdentityTransaction(value, { chainId: 56, registry: REGISTRY, minter: row.minter as Address });
        if (row.hash !== value.hash || row.job_ref !== value.jobRef || row.phase !== value.phase
          || row.chain !== value.intent.chainId || row.minter !== value.intent.minter.toLowerCase()
          || !minters.includes(row.minter) || row.nonce !== String(value.intent.nonce)) fail("intent_mismatch");
        if (value.finalizedAt === null) fail("other_job_pending");
      }
      // Finality also has to belong to the retained job/phase and exact calldata.
      // Do not infer safety from a well-shaped but detached receipt document.
      if (transactions.rows.length > 0) {
        const refs = [...new Set(transactions.rows.map((row) => row.job_ref))];
        const history = await tx.query<JobRow>(`/* minterMigration.historyJobs */ select public_ref,source_id,owner_address,chain,minter,document
          from erc8004_jobs where public_ref=any($1::text[]) or document->>'publicRef'=any($1::text[])
          order by public_ref collate "C" for update`, [refs]);
        for (const row of history.rows) {
          const job = row.document;
          if (!isObject(job) || job.publicRef !== row.public_ref || job.sourceId !== row.source_id
            || typeof job.owner !== "string" || job.owner.toLowerCase() !== row.owner_address
            || job.chainId !== row.chain || typeof job.minter !== "string" || job.minter.toLowerCase() !== row.minter
            || typeof job.registry !== "string" || !minters.includes(row.minter)) fail("intent_mismatch");
        }
        for (const minter of minters) {
          const relevant = transactions.rows.filter((row) => row.minter === minter).map((row) => {
            validateIdentityTransaction(row.document, { chainId: 56, registry: REGISTRY, minter: minter as Address }); return row.document;
          });
          validateLedger({ jobs: history.rows.filter((row) => row.minter === minter).map((row) => row.document as IdentityJob),
            transactions: relevant, nextNonce: relevant.reduce((max, row) => Math.max(max, row.intent.nonce + 1), 0) },
          { chainId: 56, registry: REGISTRY, minter: minter as Address });
        }
      }
      const nonce = await reader.read(request.newMinter);
      if (nonce.chainId !== 56) fail("invalid_config");
      if (!Number.isSafeInteger(nonce.latest) || nonce.latest < 0 || nonce.latest !== nonce.pending) fail("nonce_conflict");
      if (transactions.rows.some((row) => row.minter === request.newMinter.toLowerCase() && BigInt(row.nonce) >= BigInt(nonce.latest))) fail("nonce_conflict");
      const savedNonce = nonces.rows.find((row) => row.minter === request.newMinter.toLowerCase())?.next_nonce ?? null;
      if (savedNonce !== null && savedNonce !== String(nonce.latest)) fail("nonce_conflict");
      const replacement: IdentityJob = { ...job, minter: request.newMinter, status: "pending", error: null };
      validateLedger({ jobs: [replacement], transactions: [], nextNonce: nonce.latest }, { chainId: 56, registry: REGISTRY, minter: request.newMinter });
      const nextIdentity = { ...identity, revision: identity.revision + 1, status: "pending" as const, errorCode: null };
      if (!validIdentity(decodeIdentity(nextIdentity, false))) fail("invalid_identity");
      const updated = await tx.query<{ id: string }>(`/* minterMigration.project */ update agents set erc8004_identity=$4::jsonb
        where id=$1 and owner_address=$2 and erc8004_identity=$3::jsonb and erc8004_agent_id is null and status in ('armed','paused') returning id`,
        [request.sourceId, agent.owner_address, JSON.stringify(identity), JSON.stringify(nextIdentity)]);
      if (updated.rows.length !== 1) fail("conflict");
      // Replace in place: the global ref and owner/source uniqueness never vanish.
      const replaced = await tx.query<{ public_ref: string }>(`/* minterMigration.replace */ update erc8004_jobs set minter=$6,document=$7::jsonb
        where public_ref=$1 and source_id=$2 and owner_address=$3 and chain=56 and minter=$4 and document=$5::jsonb returning public_ref`,
        [request.publicRef, request.sourceId, agent.owner_address, request.oldMinter.toLowerCase(), JSON.stringify(job), request.newMinter.toLowerCase(), JSON.stringify(replacement)]);
      if (replaced.rows.length !== 1) fail("conflict");
      const saved = await tx.query<{ minter: string }>(`/* minterMigration.saveNonce */ insert into erc8004_nonces(chain,minter,next_nonce) values(56,$1,$2)
        on conflict(chain,minter) do update set next_nonce=excluded.next_nonce
        where erc8004_nonces.next_nonce is null or erc8004_nonces.next_nonce=excluded.next_nonce returning minter`, [request.newMinter.toLowerCase(), nonce.latest]);
      if (saved.rows.length !== 1) fail("nonce_conflict");
      const result: MinterMigrationResult = { mode: request.apply ? "apply" : "dry-run", applied: request.apply, sourceId: request.sourceId,
        publicRef: request.publicRef, category: request.category, oldMinter: request.oldMinter, newMinter: request.newMinter,
        nextNonce: nonce.latest, previousRevision: identity.revision, nextRevision: nextIdentity.revision,
        initialUriSha256: createHash("sha256").update(job.initialUri, "utf8").digest("hex") };
      if (!request.apply) throw new DryRunRollback(result);
      return result;
    });
  } catch (error) { if (error instanceof DryRunRollback) return error.result; throw error; }
}

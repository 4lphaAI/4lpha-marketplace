import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { resyncIdentityNonce, type NonceResyncRequest } from "../src/identity/nonceResync.js";
import { decodeIdentity, REGISTRY, validIdentity, type IdentityJob, type IdentityTransaction, type IdentitySource, type IdentitySources, type Erc8004IdentitySummary } from "../src/identity/types.js";
import { IDENTITY_ABI, phaseCalldata, type RegistryGateway, type RegistryReceipt } from "../src/identity/registry.js";
import { metadataUriFor } from "../src/identity/metadata.js";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { IdentityService } from "../src/identity/service.js";
import { MemoryIdentityLedger } from "../src/store/erc8004.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import type { MigrationNonceReader } from "../src/identity/minterMigration.js";
import { blockedJob, blockedIdentity, MIGRATION_CONFIG, OWNER, REF } from "./support/minterMigration.js";

const REQUEST: NonceResyncRequest = { minter: MIGRATION_CONFIG.minter, fromNonce: 35, toNonce: 36, apply: true };
const BINDING = { ...MIGRATION_CONFIG, registry: REGISTRY };
const READER: MigrationNonceReader = { async read() { return { chainId: 56, latest: 36, pending: 36 }; } };
type Row = Record<string, unknown>;
function jobRow(job: IdentityJob): Row { return { public_ref: job.publicRef, source_id: job.sourceId, owner_address: job.owner.toLowerCase(), chain: 56, minter: job.minter.toLowerCase(), document: structuredClone(job) }; }
function transactionRow(tx: IdentityTransaction): Row { return { hash: tx.hash, job_ref: tx.jobRef, phase: tx.phase, chain: 56, minter: tx.intent.minter.toLowerCase(), nonce: String(tx.intent.nonce), document: structuredClone(tx) }; }
function history(outcome: "success" | "reverted" = "success") {
  const hash = `0x${"ab".repeat(32)}` as const;
  const job: IdentityJob = { ...blockedJob(), minter: REQUEST.minter, status: outcome === "success" ? "updating" : "blocked", error: outcome === "success" ? null : "reverted",
    registrationHash: hash, envelope: "100", effectiveCeiling: "100", updateGasCeiling: "10", updatePriceCeiling: "5",
    mintedId: outcome === "success" ? "0" : null, finalUri: outcome === "success" ? metadataUriFor(3, "trading", 7, REF, "0") : null };
  const tx: IdentityTransaction = { hash, jobRef: REF, phase: "register", preparedAt: 50, finalizedAt: 100, blockNumber: "90", blockHash: `0x${"ef".repeat(32)}`, outcome,
    intent: { chainId: 56, minter: REQUEST.minter, to: REGISTRY, nonce: 34, value: "0", type: "legacy", gas: "10", gasPrice: "5", data: phaseCalldata(job, "register") } };
  return { job, tx };
}
class ResyncSql implements SqlClient {
  readonly transactionScope = "top-level";
  jobs: Row[] = [jobRow({ ...blockedJob(), minter: REQUEST.minter })]; transactions: Row[] = [];
  agents: Row[] = [{ id: blockedJob().sourceId, owner_address: OWNER, status: "armed", erc8004_identity: blockedIdentity(), erc8004_agent_id: null,
    row_version: 91, updated_at: 123, session_key_enc: "synthetic-authority", session_facts: { policy: "same" } }];
  nonces: Row[] = [{ chain: 56, minter: REQUEST.minter.toLowerCase(), next_nonce: "35" }];
  statements: string[] = []; locked = true; schema = true; numbering = true; failTag = ""; casTag = ""; casAt = 1; hits = 0;
  snapshot() { return structuredClone({ jobs: this.jobs, transactions: this.transactions, agents: this.agents, nonces: this.nonces }); }
  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const before = this.snapshot();
    try { return await fn({ ...this, transactionScope: "nested", query: this.query.bind(this), transaction: (nested) => nested(this), close: async () => {} }); }
    catch (error) { Object.assign(this, before); throw error; }
  }
  async close() {}
  async query<RowType>(text: string, params: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.statements.push(text);
    assert.equal(/select\s+\*/i.test(text), false);
    assert.equal(/create |alter |delete |insert /i.test(text), false);
    const tag = /\/\*\s*(\w+\.\w+)\s*\*\//.exec(text)?.[1];
    if (tag === this.failTag && ++this.hits === this.casAt) throw new Error("injected SQL failure");
    if (tag === this.casTag && ++this.hits === this.casAt) return { rows: [] };
    let rows: unknown[] = [];
    if (text.includes("limit 0") && !this.schema) throw new Error("schema absent");
    switch (tag) {
      case "erc8004.schemaIndexes": rows = [
        ...[["erc8004_jobs", ["public_ref"]], ["erc8004_jobs", ["owner_address", "source_id"]], ["erc8004_transactions", ["hash"]],
          ["erc8004_transactions", ["job_ref", "phase"]], ["erc8004_transactions", ["chain", "minter", "nonce"]], ["erc8004_nonces", ["chain", "minter"]]]
          .map(([table_name, key_columns]) => ({ table_name, key_columns, expression: null, predicate: null })),
        { table_name: "agents", key_columns: [], expression: "(erc8004_identity ->> 'publicRef'::text)", predicate: "(erc8004_identity IS NOT NULL)" }]; break;
      case "erc8004.numberSchema": rows = [{ installed: this.numbering }]; break;
      case "nonceResync.fence": rows = [{ locked: this.locked }]; break;
      case "nonceResync.nonce": rows = this.nonces.filter((r) => String(r.minter).toLowerCase() === params[0]); break;
      case "nonceResync.jobs": rows = this.jobs.filter((r) => String(r.minter).toLowerCase() === params[0] || String((r.document as Row)?.minter).toLowerCase() === params[0])
        .sort((a, b) => String(a.public_ref) < String(b.public_ref) ? -1 : 1); break;
      case "nonceResync.transactions": rows = this.transactions.filter((r) => {
        const d = r.document as Row; const intent = d?.intent as Row;
        return String(r.minter).toLowerCase() === params[0] || String(intent?.minter).toLowerCase() === params[0]
          || (params[1] as string[]).includes(String(r.job_ref)) || (params[1] as string[]).includes(String(d?.jobRef));
      }).sort((a, b) => String(a.hash) < String(b.hash) ? -1 : 1); break;
      case "nonceResync.agent": rows = this.agents.filter((r) => r.id === params[0]); break;
      case "nonceResync.saveNonce": {
        const row = this.nonces.find((r) => r.chain === 56 && r.minter === params[0] && r.next_nonce === String(params[1]));
        if (row) { row.next_nonce = String(params[2]); rows = [{ minter: row.minter }]; } break;
      }
      case "nonceResync.replace": {
        const row = this.jobs.find((r) => r.public_ref === params[0] && r.source_id === params[1] && r.owner_address === params[2]
          && r.chain === 56 && r.minter === params[3] && JSON.stringify(r.document) === params[4]);
        if (row) { row.document = JSON.parse(String(params[5])) as unknown; rows = [{ public_ref: row.public_ref }]; } break;
      }
      case "nonceResync.project": {
        const row = this.agents.find((r) => r.id === params[0] && r.owner_address === params[1] && JSON.stringify(r.erc8004_identity) === params[2]
          && r.erc8004_agent_id === null && ["armed", "paused"].includes(String(r.status)));
        if (row) { row.erc8004_identity = JSON.parse(String(params[3])) as unknown; rows = [{ id: row.id }]; } break;
      }
      default: if (tag) assert.fail(`Unknown SQL ${tag}`);
    }
    return { rows: structuredClone(rows) as RowType[] };
  }
}
async function refuses(db: ResyncSql, code: string, reader = READER, request = REQUEST) {
  const before = db.snapshot();
  await assert.rejects(resyncIdentityNonce(db, MIGRATION_CONFIG, request, reader), new RegExp(code));
  assert.deepEqual(db.snapshot(), before);
}
function patchJob(db: ResyncSql, patch: Row) { Object.assign(db.jobs[0]!.document as Row, patch); }
function patchIdentity(db: ResyncSql, patch: Row) { Object.assign(db.agents[0]!.erc8004_identity as Row, patch); }

test("resync dry-run exercises real writes then restores every row; apply preserves all unrelated fields and repeat refuses", async () => {
  const db = new ResyncSql();
  db.jobs.push(jobRow({ ...blockedJob(), minter: OWNER, sourceId: "other", publicRef: "12345678-1234-4234-8234-123456789abd" }));
  db.nonces.push({ chain: 56, minter: OWNER, next_nonce: "99" });
  const before = db.snapshot();
  const dry = await resyncIdentityNonce(db, MIGRATION_CONFIG, { ...REQUEST, apply: false }, READER);
  assert.deepEqual(db.snapshot(), before); assert.ok(db.statements.some((s) => s.includes("nonceResync.project")));
  assert.deepEqual(dry, { mode: "dry-run", applied: false, minter: REQUEST.minter, fromNonce: 35, toNonce: 36,
    unblocked: [{ sourceId: blockedJob().sourceId, publicRef: REF }], skipped: [] });
  const apply = await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
  assert.deepEqual(apply, { ...dry, mode: "apply", applied: true });
  const expected = structuredClone(before); expected.nonces[0]!.next_nonce = "36";
  Object.assign(expected.jobs[0]!.document as Row, { status: "pending", error: null });
  Object.assign(expected.agents[0]!.erc8004_identity as Row, { status: "pending", errorCode: null, revision: 5 });
  assert.deepEqual(db.snapshot(), expected); await refuses(db, "nonce_conflict");
});
test("zero-job production-shaped nonce-only recovery and mixed deterministic multi-job results", async () => {
  const empty = new ResyncSql(); empty.jobs = []; empty.agents = [];
  const result = await resyncIdentityNonce(empty, MIGRATION_CONFIG, REQUEST, READER);
  assert.deepEqual(result.unblocked, []); assert.deepEqual(result.skipped, []); assert.equal(empty.nonces[0]!.next_nonce, "36");
  const db = new ResyncSql(); db.jobs = []; db.agents = [];
  for (const [n, status] of [[4, "revoked"], [3, "paused"], [2, "missing"], [1, "armed"]] as const) {
    const ref = `12345678-1234-4234-8234-123456789ab${n}`;
    db.jobs.push(jobRow({ ...blockedJob(), minter: REQUEST.minter, publicRef: ref, sourceId: `source-${n}`, displayNumber: n, initialUri: metadataUriFor(3, "trading", n, ref) }));
    if (status !== "missing") db.agents.push({ id: `source-${n}`, owner_address: OWNER, status, erc8004_agent_id: null, erc8004_identity: { ...blockedIdentity(), publicRef: ref } });
  }
  const mixed = await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
  assert.deepEqual(mixed.unblocked.map((r) => r.sourceId), ["source-1", "source-3"]);
  assert.deepEqual(mixed.skipped, [{ sourceId: "source-2", reason: "source_missing" }, { sourceId: "source-4", reason: "source_inactive" }]);
});
test("resync refuses nested/unmarked scopes before queries/RPC, including caught outer dry-run", async () => {
  for (const apply of [false, true]) for (const scope of ["nested", undefined] as const) {
    const db: SqlClient = { ...(scope === undefined ? {} : { transactionScope: scope }), async query() { assert.fail("query"); }, async transaction() { assert.fail("transaction"); }, async close() {} };
    await assert.rejects(resyncIdentityNonce(db, MIGRATION_CONFIG, { ...REQUEST, apply }, { async read() { assert.fail("RPC"); } }), /invalid_config/);
  }
  const db = new ResyncSql(); const before = db.snapshot();
  await db.transaction(async (tx) => { await assert.rejects(resyncIdentityNonce(tx, MIGRATION_CONFIG, { ...REQUEST, apply: false }, READER), /invalid_config/); });
  assert.deepEqual(db.snapshot(), before); assert.deepEqual(db.statements, []);
});
test("resync lock, schema, nonce and chain refusals leave no mutation", async (t) => {
  for (const [name, mutate, code] of [
    ["lock", (db: ResyncSql) => { db.locked = false; }, "lock_busy"],
    ["base schema", (db: ResyncSql) => { db.schema = false; }, "schema_missing"],
    ["number schema", (db: ResyncSql) => { db.numbering = false; }, "schema_missing"],
    ["absent nonce", (db: ResyncSql) => { db.nonces = []; }, "nonce_conflict"],
    ...[null, "34", "36", "035", "1.5", "9007199254740992"].map((v) => [String(v), (db: ResyncSql) => { db.nonces[0]!.next_nonce = v; }, "nonce_conflict"] as const),
  ] as const) await t.test(name, async () => {
    const db = new ResyncSql(); mutate(db); await refuses(db, code, { async read() { assert.fail("RPC"); } });
    assert.equal(db.statements.some((s) => /update /i.test(s)), false);
  });
  for (const facts of [{ chainId: 1, latest: 36, pending: 36 }, { chainId: 56, latest: 36, pending: 37 }, { chainId: 56, latest: 35, pending: 35 }]) {
    const db = new ResyncSql(); await refuses(db, facts.chainId === 1 ? "invalid_config" : "nonce_conflict", { async read() { return facts; } });
  }
  for (const toNonce of [0, 34, 35]) await refuses(new ResyncSql(), "arguments_invalid", READER, { ...REQUEST, toNonce });
});
test("mandatory job shape, optional numbering and relational/JSON bindings refuse atomically", async (t) => {
  const base = blockedJob();
  for (const key of Object.keys(base)) await t.test(`missing ${key}`, async () => {
    const db = new ResyncSql(); delete (db.jobs[0]!.document as Row)[key]; await refuses(db, "intent_mismatch");
  });
  for (const [key, value] of Object.entries({ publicRef: "invalid", sourceId: "other", owner: REQUEST.minter, minter: OWNER, chainId: 1, registry: OWNER,
    category: "bad", status: "bad", error: "bad", createdAt: -1, initialUri: "wrong", displayNumber: 0, metadataVersion: 4, unexpected: true })) {
    await t.test(`JSON ${key}`, async () => { const db = new ResyncSql(); patchJob(db, { [key]: value }); await refuses(db, "intent_mismatch"); });
  }
  for (const key of ["public_ref", "source_id", "owner_address", "chain", "minter"]) await t.test(`relational ${key}`, async () => {
    const db = new ResyncSql(); db.jobs[0]![key] = key === "chain" ? 1 : "wrong"; await refuses(db, "intent_mismatch");
  });
  for (const [key, values] of Object.entries({ registrationHash: ["bad"], updateHash: ["bad"], mintedId: ["-1"], finalUri: [false], envelope: ["0", "-1"],
    effectiveCeiling: ["1e3"], updateGasCeiling: ["01"], updatePriceCeiling: [1], completedAt: [-1] })) {
    for (const value of values) await t.test(`malformed evidence ${key}`, async () => { const db = new ResyncSql(); patchJob(db, { [key]: value }); await refuses(db, "intent_mismatch"); });
  }
});
test("transaction selection, shape, binding, finality, nonce and error precedence", async (t) => {
  function seeded() { const db = new ResyncSql(); const h = history(); db.jobs = [jobRow(h.job)]; db.transactions = [transactionRow(h.tx)]; return db; }
  for (const key of Object.keys(history().tx)) await t.test(`missing transaction ${key}`, async () => {
    const db = seeded(); delete (db.transactions[0]!.document as Row)[key]; await refuses(db, "intent_mismatch");
  });
  for (const [key, values] of Object.entries({ finalizedAt: [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1], outcome: [null, "pending"],
    blockNumber: [null, "01", "-1", "1e3", 90], blockHash: [null, "0x12"], intent: [null, {}], unexpected: [true] })) {
    for (const value of values) await t.test(`malformed transaction ${key} ${String(value)}`, async () => {
      const db = seeded(); Object.assign(db.transactions[0]!.document as Row, { [key]: value }); await refuses(db, "intent_mismatch");
    });
  }
  for (const value of [-1, 1.5, "34", Number.MAX_SAFE_INTEGER + 1]) await t.test(`malformed intent nonce ${value}`, async () => {
    const db = seeded(); ((db.transactions[0]!.document as Row).intent as Row).nonce = value; await refuses(db, "intent_mismatch");
  });
  for (const key of ["hash", "job_ref", "phase", "chain", "minter", "nonce"]) await t.test(`transaction relational ${key}`, async () => {
    const db = seeded(); db.transactions[0]![key] = key === "chain" ? 1 : "wrong"; await refuses(db, "intent_mismatch");
  });
  for (const kind of ["intentMinterOnly", "relationalRef", "jsonRef"] as const) await t.test(`cross-minter selection ${kind}`, async () => {
    const db = new ResyncSql(); const row = transactionRow(history().tx); row.minter = OWNER;
    if (kind !== "intentMinterOnly") ((row.document as Row).intent as Row).minter = OWNER;
    if (kind === "relationalRef") (row.document as Row).jobRef = "12345678-1234-4234-8234-123456789abd";
    if (kind === "jsonRef") row.job_ref = "12345678-1234-4234-8234-123456789abd";
    db.transactions = [row]; await refuses(db, "intent_mismatch");
  });
  for (const kind of ["prepared-before-broadcast", "broadcast-lost-response", "mint-id-without-finality"] as const) await t.test(kind, async () => {
    const db = seeded(); const row = db.transactions[0]!;
    Object.assign(row.document as Row, { finalizedAt: null, blockNumber: null, blockHash: null, outcome: null });
    if (kind !== "mint-id-without-finality") patchJob(db, { mintedId: null, finalUri: null, status: "registering" });
    row.nonce = "35"; ((row.document as Row).intent as Row).nonce = 35;
    await refuses(db, "other_job_pending", { async read() { assert.fail("RPC before pending refusal"); } });
    (db.transactions[0]!.document as Row).blockHash = "malformed"; await refuses(db, "intent_mismatch");
    // Audit A1: a non-string status is malformed even beside pending history.
    const malformed = seeded(); const pending = malformed.transactions[0]!;
    Object.assign(pending.document as Row, { finalizedAt: null, blockNumber: null, blockHash: null, outcome: null });
    if (kind !== "mint-id-without-finality") patchJob(malformed, { mintedId: null, finalUri: null });
    patchJob(malformed, { status: ["registering"] });
    pending.nonce = "35"; ((pending.document as Row).intent as Row).nonce = 35;
    await refuses(malformed, "intent_mismatch", { async read() { assert.fail("RPC before malformed refusal"); } });
  });
  const conflict = seeded(); conflict.transactions[0]!.nonce = "35"; ((conflict.transactions[0]!.document as Row).intent as Row).nonce = 35;
  await refuses(conflict, "nonce_conflict");
  const detached = seeded(); patchJob(detached, { registrationHash: `0x${"cd".repeat(32)}` }); await refuses(detached, "intent_mismatch");
  for (const outcome of ["success", "reverted"] as const) {
    const db = seeded(); const h = history(outcome); db.jobs = [jobRow(h.job)]; db.transactions = [transactionRow(h.tx)];
    const before = db.snapshot(); await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
    assert.deepEqual(db.jobs, before.jobs); assert.deepEqual(db.transactions, before.transactions); assert.deepEqual(db.agents, before.agents);
  }
});
test("every evidence field independently excludes unblock, while inconsistent evidence refuses ledger validation", async (t) => {
  for (const [key, value] of Object.entries({ registrationHash: history().tx.hash, updateHash: `0x${"cd".repeat(32)}`, mintedId: "0",
    finalUri: "evidence", envelope: "1", effectiveCeiling: "1", updateGasCeiling: "1", updatePriceCeiling: "1", completedAt: 0 })) {
    await t.test(key, async () => {
      const db = new ResyncSql(); patchJob(db, { [key]: value });
      if (["effectiveCeiling", "updateGasCeiling", "updatePriceCeiling"].includes(key)) {
        const before = db.snapshot(); const result = await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
        assert.deepEqual(result.skipped, [{ sourceId: blockedJob().sourceId, reason: "evidence_present" }]);
        assert.deepEqual(db.jobs, before.jobs); assert.deepEqual(db.agents, before.agents);
      } else await refuses(db, "intent_mismatch");
    });
  }
  const db = new ResyncSql(); const h = history(); db.jobs = [jobRow({ ...h.job, status: "blocked", error: "nonce_conflict" })]; db.transactions = [transactionRow(h.tx)]; db.agents = [];
  const result = await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
  assert.equal(result.skipped[0]!.reason, "evidence_present");
});
test("closed projection skip reasons and precedence, armed/paused sources and other status/error jobs", async (t) => {
  const cases: [string, (db: ResyncSql) => void, string][] = [
    ["missing", (db) => { db.agents = []; }, "source_missing"],
    ["revoked precedence", (db) => { db.agents[0]!.status = "revoked"; db.agents[0]!.erc8004_identity = null; }, "source_inactive"],
    ["null", (db) => { db.agents[0]!.erc8004_identity = null; }, "projection_mismatch"],
    ["missing projection", (db) => { delete db.agents[0]!.erc8004_identity; }, "projection_mismatch"],
    ["owner", (db) => { db.agents[0]!.owner_address = REQUEST.minter.toLowerCase(); }, "projection_mismatch"],
    ["malformed owner", (db) => { db.agents[0]!.owner_address = REQUEST.minter; }, "projection_mismatch"],
    ["source", (db) => { db.agents[0]!.id = "different"; }, "source_missing"],
    ["existing id", (db) => { db.agents[0]!.erc8004_agent_id = "0"; }, "projection_mismatch"],
    ["overflow", (db) => patchIdentity(db, { revision: Number.MAX_SAFE_INTEGER }), "revision_overflow"],
    ...Object.entries({ publicRef: "12345678-1234-4234-8234-123456789abd", category: "lp", status: "pending", errorCode: "fee_limit",
      agentId: "0", registrationTxHash: history().tx.hash, uriUpdateTxHash: history().tx.hash, unexpected: true }).map(([key, value]): [string, (db: ResyncSql) => void, string] =>
      [key, (db) => patchIdentity(db, { [key]: value }), "projection_mismatch"]),
  ];
  for (const [name, mutate, reason] of cases) await t.test(name, async () => {
    const db = new ResyncSql(); mutate(db); const before = db.snapshot(); const result = await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
    assert.deepEqual(result.skipped, [{ sourceId: blockedJob().sourceId, reason }]); assert.deepEqual(result.unblocked, []);
    assert.deepEqual(db.jobs, before.jobs); assert.deepEqual(db.agents, before.agents);
  });
  for (const status of ["armed", "paused"]) { const db = new ResyncSql(); db.agents[0]!.status = status; assert.equal((await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER)).unblocked.length, 1); }
  for (const patch of [{ error: "fee_limit" }, { status: "pending", error: null }]) {
    const db = new ResyncSql(); patchJob(db, patch); const before = db.snapshot(); const result = await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
    assert.deepEqual(result.unblocked, []); assert.deepEqual(result.skipped, []); assert.deepEqual(db.jobs, before.jobs); assert.deepEqual(db.agents, before.agents);
  }
});
test("nonce/job/projection CAS and later candidate SQL/CAS failures roll back all earlier updates", async () => {
  for (const tag of ["saveNonce", "replace", "project"]) for (const apply of [false, true]) {
    const db = new ResyncSql(); db.casTag = `nonceResync.${tag}`; await refuses(db, "conflict", READER, { ...REQUEST, apply });
  }
  for (const kind of ["CAS", "SQL"]) {
    const db = new ResyncSql(); const ref = "12345678-1234-4234-8234-123456789abd";
    db.jobs.push(jobRow({ ...blockedJob(), minter: REQUEST.minter, publicRef: ref, sourceId: "later", displayNumber: 8, initialUri: metadataUriFor(3, "trading", 8, ref) }));
    db.agents.push({ ...db.agents[0], id: "later", erc8004_identity: { ...blockedIdentity(), publicRef: ref } });
    if (kind === "CAS") { db.casTag = "nonceResync.project"; db.casAt = 2; }
    else { db.failTag = "nonceResync.project"; db.casAt = 2; }
    await refuses(db, kind === "CAS" ? "conflict" : "injected SQL failure");
  }
  await refuses(new ResyncSql(), "RPC failure", { async read() { throw new Error("RPC failure"); } });
});

test("offline continuation reuses ref/number, prepares one register at resynced nonce and reaches registered; finalized register resumes update", async () => {
  for (const retainedRegister of [false, true]) {
    const db = new ResyncSql(); if (retainedRegister) { const h = history(); db.jobs = [jobRow(h.job)]; db.transactions = [transactionRow(h.tx)]; }
    await resyncIdentityNonce(db, MIGRATION_CONFIG, REQUEST, READER);
    const ledger = new MemoryIdentityLedger(BINDING); const fence = new MemoryIdentityFence();
    await ledger.atomic(fence, (state) => { state.jobs = db.jobs.map((r) => r.document as IdentityJob); state.transactions = db.transactions.map((r) => r.document as IdentityTransaction); state.nextNonce = 36; });
    let identity = retainedRegister ? { ...blockedIdentity(), status: "updating" as const, errorCode: null, agentId: "0", registrationTxHash: history().tx.hash } : db.agents[0]!.erc8004_identity as Erc8004IdentitySummary;
    let existingId: string | null = null; const revisions = [identity.revision];
    const source = (): IdentitySource => ({ id: blockedJob().sourceId, owner: OWNER, category: "trading", eligible: true, identity, existingId });
    const sources: IdentitySources = { async get() { return source(); }, async enrolled() { return [source()]; }, async enroll() { assert.fail("enroll"); }, async project(old, next) {
      assert.deepEqual(old.identity, identity); assert.equal(next.revision, identity.revision + 1); assert.ok(validIdentity(decodeIdentity(next, false)));
      identity = next; revisions.push(next.revision); if (next.status === "registered") existingId = next.agentId; return true;
    } };
    let latest = 36; let pending = 36; let uri = retainedRegister ? history().job.initialUri : "";
    const receipts = new Map<Hex, RegistryReceipt>(); const prepared: IdentityTransaction["intent"][] = []; const sent: Hex[] = [];
    const blockHash = `0x${"ef".repeat(32)}` as const;
    const gateway: RegistryGateway = {
      async probe() {}, async simulate() {}, async nonces() { return { latest, pending }; },
      async fees() { return { estimate: 5n, gasPrice: 1n, balance: 100_000n }; },
      async sign(intent) { prepared.push(intent); return `0x${String(intent.nonce).padStart(64, "0")}` as Hex; },
      async broadcast(raw) { sent.push(raw); pending = latest + 1; return keccak256(raw); },
      async receipt(hash) { return receipts.get(hash) ?? null; }, async finalized() { return 100n; }, async blockHash() { return blockHash; },
      async identity() { return { owner: REQUEST.minter, uri }; },
    };
    const service = new IdentityService({ ...BINDING, databaseUrl: "postgres://offline", rpcUrl: "https://rpc.invalid", exclusive: true,
      maxGas: 20n, maxPrice: 5n, maxInstanceFee: 1000n, maxDailyFee: 10_000n }, ledger, sources, gateway, fence, () => 1000);
    const before = await ledger.read(); await service.discover(); assert.deepEqual(await ledger.read(), before);
    await service.step(); let state = await ledger.read();
    assert.equal(prepared.length, 1); assert.equal(prepared[0]!.nonce, 36);
    assert.equal(state.transactions.at(-1)!.phase, retainedRegister ? "update" : "register");
    for (let phase = retainedRegister ? 1 : 0; phase < 2; phase++) {
      state = await ledger.read(); const tx = state.transactions.at(-1)!; const job = state.jobs[0]!;
      uri = tx.phase === "register" ? job.initialUri : job.finalUri!;
      const logs = tx.phase === "register" ? [{ address: REGISTRY, data: encodeAbiParameters([{ type: "string" }], [uri]),
        topics: encodeEventTopics({ abi: IDENTITY_ABI, eventName: "Registered", args: { agentId: 0n, owner: REQUEST.minter } }) as [Hex, ...Hex[]],
        blockHash, blockNumber: 90n, transactionHash: tx.hash, transactionIndex: 0, logIndex: 0, removed: false }] : [];
      receipts.set(tx.hash, { transactionHash: tx.hash, to: REGISTRY, from: REQUEST.minter, blockNumber: 90n, blockHash, status: "success", logs });
      latest = tx.intent.nonce + 1; pending = latest;
      await service.step(); if (phase === 0) await service.step();
    }
    state = await ledger.read(); assert.equal(state.jobs[0]!.status, "registered"); assert.equal(state.jobs[0]!.mintedId, "0");
    assert.equal(state.jobs[0]!.publicRef, REF); assert.equal(state.jobs[0]!.displayNumber, 7); assert.equal(existingId, "0");
    assert.equal(prepared.filter((i) => i.data === phaseCalldata(state.jobs[0]!, "register")).length, retainedRegister ? 0 : 1);
    assert.equal(sent.length, retainedRegister ? 1 : 2); assert.ok(revisions.every((r, i) => i === 0 || r === revisions[i - 1]! + 1));
  }
});

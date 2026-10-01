import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { resyncIdentityNonce, type NonceResyncRequest } from "../src/identity/nonceResync.js";
import { acquireIdentityFence } from "../src/identity/fence.js";
import { REGISTRY, type IdentityJob } from "../src/identity/types.js";
import { phaseCalldata } from "../src/identity/registry.js";
import { metadataUriFor } from "../src/identity/metadata.js";
import { migrateIdentity } from "../src/store/erc8004.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import type { MigrationNonceReader } from "../src/identity/minterMigration.js";
import { blockedIdentity, blockedJob, MIGRATION_CONFIG, OWNER, REF } from "./support/minterMigration.js";
import { localPostgres } from "./support/localPostgres.js";

test("nonce resync PostgreSQL fencing, atomic rollback and retained history on a disposable cluster", { timeout: 120_000 }, async (t) => {
  const cluster = await localPostgres();
  if (!cluster) { t.skip("PostgreSQL 17 binaries unavailable; no external database fallback"); return; }
  const sql = await createPgSqlClient(cluster.url);
  t.after(async () => { await sql.close(); await cluster.close(); });
  await sql.query(`create table agents (id text primary key, owner_address text not null, status text not null,
    erc8004_agent_id text, row_version bigint not null, updated_at bigint not null,
    session_key_enc text not null, session_facts jsonb not null, wallet_address text not null)`);
  await migrateIdentity(sql);
  const request: NonceResyncRequest = { minter: MIGRATION_CONFIG.minter, fromNonce: 35, toNonce: 36, apply: true };
  const binding = { ...MIGRATION_CONFIG, registry: REGISTRY }; const minter = request.minter.toLowerCase();
  const otherRef = "12345678-1234-4234-8234-123456789abd";
  const laterRef = "12345678-1234-4234-8234-123456789abe";
  let reads = 0;
  const reader: MigrationNonceReader = { async read(address) { assert.equal(address, request.minter); reads++; return { chainId: 56, latest: 36, pending: 36 }; } };
  async function seed(later = false) {
    await sql.query("truncate erc8004_transactions,erc8004_jobs,erc8004_nonces,agents"); reads = 0;
    for (const [ref, id, number] of [[REF, blockedJob().sourceId, 7], ...(later ? [[laterRef, "later", 8] as const] : [])] as const) {
      await sql.query(`insert into agents values($1,$2,'armed',null,91,123,'synthetic-authority','{"policy":"same"}',$2,$3::jsonb)`,
        [id, OWNER, JSON.stringify({ ...blockedIdentity(), publicRef: ref })]);
      const job = { ...blockedJob(), minter: request.minter, sourceId: id, publicRef: ref, displayNumber: number, initialUri: metadataUriFor(3, "trading", number, ref) };
      await sql.query("insert into erc8004_jobs values($1,$2,$3,56,$4,$5::jsonb)", [ref, OWNER, id, minter, JSON.stringify(job)]);
    }
    const first = `0x${"ab".repeat(32)}` as const; const update = `0x${"cd".repeat(32)}` as const;
    const history: IdentityJob = { ...blockedJob(), minter: request.minter, publicRef: otherRef, sourceId: "history", displayNumber: 1,
      initialUri: metadataUriFor(3, "trading", 1, otherRef), finalUri: metadataUriFor(3, "trading", 1, otherRef, "0"),
      status: "registered", error: null, mintedId: "0", registrationHash: first, updateHash: update, completedAt: 100,
      envelope: "100", effectiveCeiling: "100", updateGasCeiling: "10", updatePriceCeiling: "5" };
    await sql.query("insert into erc8004_jobs values($1,$2,'history',56,$3,$4::jsonb)", [otherRef, OWNER, minter, JSON.stringify(history)]);
    for (const [phase, hash, nonce] of [["register", first, 33], ["update", update, 34]] as const) {
      await sql.query("insert into erc8004_transactions values($1,$2,$3,56,$4,$5,$6::jsonb)", [hash, otherRef, phase, minter, nonce,
        JSON.stringify({ hash, jobRef: otherRef, phase, preparedAt: 50, finalizedAt: 100, blockNumber: "90", blockHash: `0x${"ef".repeat(32)}`, outcome: "success",
          intent: { chainId: 56, minter: request.minter, to: REGISTRY, nonce, value: "0", type: "legacy", gas: "10", gasPrice: "5", data: phaseCalldata(history, phase) } })]);
    }
    await sql.query("insert into erc8004_nonces values(56,$1,35),(56,$2,99)", [minter, OWNER]);
    await sql.query("insert into erc8004_jobs values($1,$2,'other-minter',56,$2,$3::jsonb)", ["12345678-1234-4234-8234-123456789abf", OWNER,
      JSON.stringify({ ...blockedJob(), minter: OWNER, publicRef: "12345678-1234-4234-8234-123456789abf", sourceId: "other-minter", displayNumber: 9,
        initialUri: metadataUriFor(3, "trading", 9, "12345678-1234-4234-8234-123456789abf") })]);
  }
  async function snapshot() {
    const result: Record<string, readonly unknown[]> = {};
    for (const table of ["agents", "erc8004_jobs", "erc8004_transactions", "erc8004_nonces"]) {
      result[table] = (await sql.query(`select row_to_json(t)::text as bytes from ${table} t order by row_to_json(t)::text collate "C"`)).rows;
    }
    return result;
  }
  async function refuses(code: string, db = sql, nonceReader = reader, apply = true) {
    const before = await snapshot(); await assert.rejects(resyncIdentityNonce(db, MIGRATION_CONFIG, { ...request, apply }, nonceReader), new RegExp(code));
    assert.deepEqual(await snapshot(), before);
  }
  function intercept(tag: string, action: (tx: SqlClient, params: readonly unknown[]) => Promise<void>): SqlClient {
    return { ...sql, transaction: (fn) => sql.transaction(async (tx) => {
      const wrapped: SqlClient = { ...tx, async query<Row>(text: string, params: readonly unknown[] = []) {
        if (text.includes(`nonceResync.${tag}`)) await action(tx, params);
        return tx.query<Row>(text, params);
      } }; return fn(wrapped);
    }) };
  }
  async function workerFence() {
    const client = new pg.Client({ connectionString: cluster!.url }); await client.connect(); return acquireIdentityFence(client, binding);
  }
  async function released() { const fence = await workerFence(); await fence.close(); }
  await t.test("dry-run writes rollback byte-equal; apply commits only nonce, job state and projection revision", async () => {
    await seed(true); const before = await snapshot();
    const dry = await resyncIdentityNonce(sql, MIGRATION_CONFIG, { ...request, apply: false }, reader);
    assert.equal(dry.unblocked.length, 2); assert.deepEqual(await snapshot(), before); await released();
    const oldJobs = (await sql.query<{ public_ref: string; document: IdentityJob }>("select public_ref,document from erc8004_jobs order by public_ref")).rows;
    const oldAgents = (await sql.query<{ id: string; document: Record<string, unknown> }>("select id,row_to_json(t) as document from agents t order by id")).rows;
    await resyncIdentityNonce(sql, MIGRATION_CONFIG, request, reader); await released();
    const after = await snapshot(); assert.deepEqual(after.erc8004_transactions, before.erc8004_transactions);
    for (const old of oldJobs) {
      const next = (await sql.query<{ document: IdentityJob }>("select document from erc8004_jobs where public_ref=$1", [old.public_ref])).rows[0]!.document;
      assert.deepEqual(next, [REF, laterRef].includes(old.public_ref) ? { ...old.document, status: "pending", error: null } : old.document);
    }
    for (const old of oldAgents) {
      const next = (await sql.query<{ document: Record<string, unknown> }>("select row_to_json(t) as document from agents t where id=$1", [old.id])).rows[0]!.document;
      assert.deepEqual(next, { ...old.document, erc8004_identity: { ...(old.document.erc8004_identity as Record<string, unknown>), status: "pending", errorCode: null, revision: 5 } });
    }
    assert.deepEqual((await sql.query("select * from erc8004_nonces order by minter")).rows,
      [{ chain: 56, minter: minter, next_nonce: "36" }, { chain: 56, minter: OWNER, next_nonce: "99" }].sort((a, b) => a.minter < b.minter ? -1 : 1));
    await refuses("nonce_conflict");
  });
  await t.test("worker session fence excludes resync; resync transaction excludes the worker", async () => {
    await seed(); const fence = await workerFence();
    try { await refuses("lock_busy"); assert.equal(reads, 0); } finally { await fence.close(); }
    await resyncIdentityNonce(sql, MIGRATION_CONFIG, { ...request, apply: false }, { async read(address) {
      await assert.rejects(workerFence(), /lock_busy/); return reader.read(address);
    } }); await released();
  });
  await t.test("two concurrent resyncs cannot both apply", async () => {
    await seed(); let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = resyncIdentityNonce(sql, MIGRATION_CONFIG, request, { async read(address) { entered(); await gate; return reader.read(address); } });
    await ready; try { await refuses("lock_busy"); } finally { release(); }
    await first; await refuses("nonce_conflict"); await released();
  });
  for (const tag of ["saveNonce", "replace", "project"]) for (const apply of [false, true]) await t.test(`${tag} CAS drift rolls back everything, apply=${apply}`, async () => {
    await seed(true);
    const db = intercept(tag, async (tx, params) => {
      if (tag !== "saveNonce" && params[0] !== (tag === "replace" ? laterRef : "later")) return;
      if (tag === "saveNonce") await tx.query("update erc8004_nonces set next_nonce=99 where minter=$1", [minter]);
      if (tag === "replace") await tx.query("update erc8004_jobs set document=document || '{\"createdAt\":999}' where public_ref=$1", [laterRef]);
      if (tag === "project") await tx.query("update agents set erc8004_identity=jsonb_set(erc8004_identity,'{revision}','9') where id='later'");
    });
    await refuses("conflict", db, reader, apply); await released();
  });
  await t.test("SQL failure on later candidate and RPC failure release locks and preserve all rows", async () => {
    await seed(true); const db = intercept("project", async (tx, params) => { if (params[0] === "later") await tx.query("select nonexistent_resync_column from agents"); });
    await refuses("nonexistent_resync_column", db); await released();
    await refuses("synthetic RPC failure", sql, { async read() { throw new Error("synthetic RPC failure"); } }); await released();
  });
  await t.test("lost mutation connection after earlier updates rolls back and releases fence", async () => {
    await seed(true); const before = await snapshot(); const killer = await createPgSqlClient(cluster.url);
    try {
      const db = intercept("project", async (tx, params) => {
        if (params[0] !== "later") return;
        const pid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        await killer.query("select pg_terminate_backend($1)", [pid]);
      });
      await assert.rejects(resyncIdentityNonce(db, MIGRATION_CONFIG, request, reader));
      assert.deepEqual(await snapshot(), before); await released();
    } finally { await killer.close(); }
  });
  for (const numbering of [false, true]) await t.test(`missing ${numbering ? "numbering" : "base"} schema refuses without DDL`, async () => {
    await seed();
    const index = numbering ? "erc8004_owner_category_number" : "agents_erc8004_ref";
    await sql.query(`drop index ${index}`);
    try { await refuses("schema_missing"); assert.equal(reads, 0); await released(); }
    finally { await migrateIdentity(sql); }
  });
  for (const column of ["public_ref", "source_id", "owner_address", "minter"]) await t.test(`job relational ${column} disagreement selected by JSON minter`, async () => {
    await seed();
    if (column === "public_ref") await sql.query("update erc8004_jobs set public_ref=$2 where public_ref=$1", [REF, laterRef]);
    else await sql.query(`update erc8004_jobs set ${column}=$2 where public_ref=$1`, [REF, "wrong"]);
    await refuses("intent_mismatch"); assert.equal(reads, 0);
  });
  for (const kind of ["intentMinterOnly", "relationalRef", "jsonRef"]) await t.test(`global transaction selection via ${kind} refuses cross-minter/binding disagreement`, async () => {
    await seed();
    if (kind === "intentMinterOnly") await sql.query("update erc8004_transactions set minter=$1", [OWNER]);
    else if (kind === "relationalRef") await sql.query(`update erc8004_transactions set minter=$1,job_ref=$2,document=jsonb_set(document,'{intent,minter}',to_jsonb($1::text))`, [OWNER, REF]);
    else await sql.query(`update erc8004_transactions set minter=$1,document=jsonb_set(jsonb_set(document,'{intent,minter}',to_jsonb($1::text)),'{jobRef}',to_jsonb($2::text))`, [OWNER, REF]);
    await refuses("intent_mismatch"); assert.equal(reads, 0);
  });
  await t.test("nested real adapter refuses before queries; caught dry-run refusal cannot commit changes", async () => {
    await seed(); const before = await snapshot();
    await sql.transaction(async (tx) => { await assert.rejects(resyncIdentityNonce(tx, MIGRATION_CONFIG, { ...request, apply: false }, reader), /invalid_config/); });
    assert.deepEqual(await snapshot(), before); assert.equal(reads, 0);
  });
});

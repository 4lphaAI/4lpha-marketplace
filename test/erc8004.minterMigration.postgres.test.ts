import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { migrateEvidenceFreeMinter, type MigrationNonceReader } from "../src/identity/minterMigration.js";
import { acquireIdentityFence } from "../src/identity/fence.js";
import { REGISTRY, type IdentityJob } from "../src/identity/types.js";
import { phaseCalldata } from "../src/identity/registry.js";
import { metadataUriFor } from "../src/identity/metadata.js";
import { migrateIdentity } from "../src/store/erc8004.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { blockedIdentity, blockedJob, MIGRATION_CONFIG, OWNER, REF, REQUEST } from "./support/minterMigration.js";
import { localPostgres } from "./support/localPostgres.js";

test("minter migration adversarial transactions on disposable real PostgreSQL", { timeout: 120_000 }, async (t) => {
  const cluster = await localPostgres();
  if (!cluster) { t.skip("PostgreSQL 17 binaries unavailable; no external database fallback"); return; }
  const sql = await createPgSqlClient(cluster.url);
  t.after(async () => { await sql.close(); await cluster.close(); });
  await sql.query(`create table agents (id text primary key, owner_address text not null, status text not null,
    erc8004_agent_id text, row_version bigint not null, updated_at bigint not null,
    session_key_enc text not null, session_facts jsonb not null, wallet_address text not null)`);
  await migrateIdentity(sql);
  const old = REQUEST.oldMinter.toLowerCase(); const next = REQUEST.newMinter.toLowerCase();
  const otherRef = "12345678-1234-4234-8234-123456789abd";
  let reads = 0;
  const reader: MigrationNonceReader = { async read(minter) { assert.equal(minter, REQUEST.newMinter); reads++; return { chainId: 56, latest: 3, pending: 3 }; } };
  async function seed() {
    await sql.query("truncate erc8004_transactions,erc8004_jobs,erc8004_nonces,agents"); reads = 0;
    await sql.query(`insert into agents values($1,$2,'armed',null,91,123,'synthetic-authority-sentinel','{"policy":"unchanged"}',$2,$3::jsonb)`,
      [REQUEST.sourceId, OWNER, JSON.stringify(blockedIdentity())]);
    await sql.query(`insert into erc8004_jobs values($1,$2,$3,56,$4,$5::jsonb)`, [REF, OWNER, REQUEST.sourceId, old, JSON.stringify(blockedJob())]);
    // Unrelated registered projection and old-minter history are retained byte-for-byte.
    const registrationHash = `0x${"ab".repeat(32)}` as const; const updateHash = `0x${"cd".repeat(32)}` as const;
    await sql.query(`insert into agents values('unrelated',$1,'paused','42',92,124,'synthetic-unrelated-sentinel','{"policy":"other"}',$1,$2::jsonb)`,
      [OWNER, JSON.stringify({ ...blockedIdentity(), publicRef: otherRef, status: "registered", errorCode: null, agentId: "42", registrationTxHash: registrationHash, uriUpdateTxHash: updateHash })]);
    const historyJob: IdentityJob = { ...blockedJob(), publicRef: otherRef, sourceId: "unrelated", displayNumber: 1,
        initialUri: metadataUriFor(3, "trading", 1, otherRef), finalUri: metadataUriFor(3, "trading", 1, otherRef, "42"),
        status: "registered", error: null, mintedId: "42", registrationHash, updateHash,
        completedAt: 100, envelope: "100", effectiveCeiling: "100", updateGasCeiling: "10", updatePriceCeiling: "5" };
    await sql.query(`insert into erc8004_jobs values($1,$2,'unrelated',56,$3,$4::jsonb)`, [otherRef, OWNER, old, JSON.stringify(historyJob)]);
    for (const [phase, hash, nonce] of [["register", registrationHash, 2467], ["update", updateHash, 2468]] as const) {
      await sql.query(`insert into erc8004_transactions values($1,$2,$3,56,$4,$5,$6::jsonb)`,
        [hash, otherRef, phase, old, nonce, JSON.stringify({ hash, jobRef: otherRef, phase, preparedAt: 50, finalizedAt: 100,
          blockNumber: "90", blockHash: `0x${"ef".repeat(32)}`, outcome: "success",
          intent: { chainId: 56, minter: REQUEST.oldMinter, to: REGISTRY, nonce, value: "0", type: "legacy", gas: "10", gasPrice: "5", data: phaseCalldata(historyJob, phase) } })]);
    }
    await sql.query(`insert into erc8004_nonces values(56,$1,2469),(56,$2,99)`, [old, OWNER]);
  }
  async function snapshot() {
    const rows: Record<string, readonly unknown[]> = {};
    for (const table of ["agents", "erc8004_jobs", "erc8004_transactions", "erc8004_nonces"]) {
      rows[table] = (await sql.query(`select row_to_json(t)::text as bytes from ${table} t order by row_to_json(t)::text collate "C"`)).rows;
    }
    return rows;
  }
  async function refuses(code: string, db: SqlClient = sql, nonceReader: MigrationNonceReader = reader) {
    const before = await snapshot(); await assert.rejects(migrateEvidenceFreeMinter(db, MIGRATION_CONFIG, REQUEST, nonceReader), new RegExp(code));
    assert.deepEqual(await snapshot(), before);
  }
  async function patchJob(patch: Record<string, unknown>) {
    await sql.query("update erc8004_jobs set document=document || $2::jsonb where public_ref=$1", [REF, JSON.stringify(patch)]);
  }
  async function patchIdentity(patch: Record<string, unknown>) {
    await sql.query("update agents set erc8004_identity=erc8004_identity || $2::jsonb where id=$1", [REQUEST.sourceId, JSON.stringify(patch)]);
  }
  async function historyOnNewMinter() {
    const historyOwner = "0x3333333333333333333333333333333333333333";
    await sql.query("update erc8004_jobs set owner_address=$2,minter=$3,document=document || $4::jsonb where public_ref=$1",
      [otherRef, historyOwner, next, JSON.stringify({ owner: historyOwner, minter: REQUEST.newMinter })]);
    await sql.query(`update erc8004_transactions set minter=$1,nonce=nonce-2466,
      document=jsonb_set(jsonb_set(document,'{intent,minter}',to_jsonb($1::text)),'{intent,nonce}',to_jsonb(nonce-2466))`, [next]);
  }
  const malformedFinality: [string, unknown][] = [
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100", null, {}, []].map((value): [string, unknown] => ["finalizedAt", value]),
    ...[null, "pending", 1, {}, []].map((value): [string, unknown] => ["outcome", value]),
    ...[null, -1, 90, "-1", "1.5", "01", "1e3", (2n ** 256n).toString(), {}, []].map((value): [string, unknown] => ["blockNumber", value]),
    ...[null, "0x12", `0x${"zz".repeat(32)}`, 1, {}, []].map((value): [string, unknown] => ["blockHash", value]),
  ];
  for (const newMinter of [false, true]) {
    await t.test(`complete finalized ${newMinter ? "new" : "old"}-minter history is accepted and retained`, async () => {
      await seed(); if (newMinter) await historyOnNewMinter();
      const history = await sql.query("select row_to_json(t) as document from erc8004_transactions t order by hash");
      await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, reader);
      assert.deepEqual(await sql.query("select row_to_json(t) as document from erc8004_transactions t order by hash"), history);
    });
    for (const [key, value] of malformedFinality) await t.test(`${newMinter ? "new" : "old"}-minter malformed ${key}=${JSON.stringify(value)} refuses before RPC/writes`, async () => {
      await seed(); if (newMinter) await historyOnNewMinter();
      await sql.query("update erc8004_transactions set document=document || $1::jsonb where phase='register'", [JSON.stringify({ [key]: value })]);
      await refuses("intent_mismatch|other_job_pending"); assert.equal(reads, 0);
    });
    for (const key of ["finalizedAt", "outcome", "blockNumber", "blockHash"]) await t.test(`${newMinter ? "new" : "old"}-minter missing ${key} refuses`, async () => {
      await seed(); if (newMinter) await historyOnNewMinter();
      await sql.query("update erc8004_transactions set document=document-$1 where phase='register'", [key]);
      await refuses("intent_mismatch"); assert.equal(reads, 0);
    });
  }
  for (const patch of [
    { hash: `0x${"aa".repeat(32)}` }, { jobRef: REF }, { phase: "update" }, { preparedAt: -1 }, { preparedAt: 1.5 },
    { intent: null }, { intent: {} }, { finalizedAt: 100, outcome: null, blockNumber: null, blockHash: null }, { unexpected: true },
  ]) await t.test(`relevant transaction JSON binding/shape ${JSON.stringify(patch)} refuses`, async () => {
    await seed(); await sql.query("update erc8004_transactions set document=document || $1::jsonb where phase='register'", [JSON.stringify(patch)]);
    await refuses("intent_mismatch|other_job_pending"); assert.equal(reads, 0);
  });
  for (const [key, value] of Object.entries({ chainId: 1, minter: OWNER, to: OWNER, nonce: 2466, value: "1", type: "eip1559", gas: "0", gasPrice: "-1", data: "0x1234" })) {
    await t.test(`relevant transaction intent ${key} disagreement refuses`, async () => {
      await seed(); await sql.query("update erc8004_transactions set document=jsonb_set(document,'{intent}',(document->'intent') || $1::jsonb) where phase='register'", [JSON.stringify({ [key]: value })]);
      await refuses("intent_mismatch"); assert.equal(reads, 0);
    });
  }
  for (const column of ["hash", "minter", "nonce"]) await t.test(`relevant relational transaction ${column} disagreement refuses`, async () => {
    await seed(); await sql.query(`update erc8004_transactions set ${column}=$1 where phase='register'`, [column === "nonce" ? "2000" : column === "hash" ? `0x${"aa".repeat(32)}` : OWNER]);
    await refuses("intent_mismatch"); assert.equal(reads, 0);
  });
  await t.test("valid unfinalized history refuses; reverted finalized history is accepted only with a consistent blocked job", async () => {
    await seed(); await sql.query("delete from erc8004_transactions where phase='update'");
    await sql.query("update erc8004_jobs set document=document || $2::jsonb where public_ref=$1", [otherRef,
      JSON.stringify({ status: "blocked", error: "reverted", mintedId: null, finalUri: null, updateHash: null, completedAt: null })]);
    await sql.query(`update erc8004_transactions set document=document || '{"finalizedAt":null,"outcome":null,"blockNumber":null,"blockHash":null}'`);
    await refuses("other_job_pending"); assert.equal(reads, 0);
    await sql.query("update erc8004_transactions set document=document || $1::jsonb", [JSON.stringify({ finalizedAt: 100, outcome: "reverted", blockNumber: "90", blockHash: `0x${"ef".repeat(32)}` })]);
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, reader);
  });
  await t.test("dry-run rolls back; apply changes only identity projection, job binding/status/error, and new nonce", async () => {
    await seed(); const before = await snapshot();
    const dry = await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, { ...REQUEST, apply: false }, reader);
    assert.equal(dry.mode, "dry-run"); assert.equal(dry.applied, false); assert.deepEqual(await snapshot(), before);
    const applied = await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, reader);
    assert.deepEqual(applied, { mode: "apply", applied: true, sourceId: REQUEST.sourceId, publicRef: REF, category: "trading",
      oldMinter: REQUEST.oldMinter, newMinter: REQUEST.newMinter, nextNonce: 3, previousRevision: 4, nextRevision: 5,
      initialUriSha256: createHash("sha256").update(blockedJob().initialUri).digest("hex") });
    const actual = await snapshot();
    // Build the expected database independently, then compare every column/row.
    await seed();
    await sql.query("update agents set erc8004_identity=$2::jsonb where id=$1", [REQUEST.sourceId, JSON.stringify({ ...blockedIdentity(), revision: 5, status: "pending", errorCode: null })]);
    await sql.query("update erc8004_jobs set minter=$2,document=$3::jsonb where public_ref=$1", [REF, next, JSON.stringify({ ...blockedJob(), minter: REQUEST.newMinter, status: "pending", error: null })]);
    await sql.query("insert into erc8004_nonces values(56,$1,3)", [next]);
    assert.deepEqual(actual, await snapshot()); await refuses("invalid_identity");
  });
  await t.test("absent old nonce is never initialized", async () => {
    await seed(); await sql.query("delete from erc8004_nonces where minter=$1", [old]);
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, reader);
    assert.deepEqual((await sql.query("select * from erc8004_nonces where minter=$1", [old])).rows, []);
  });
  for (const apply of [false, true]) await t.test(`nested migration apply=${apply} refuses before queries/writes, even when outer transaction commits`, async () => {
    await seed(); const before = await snapshot(); let queries = 0;
    await sql.transaction(async (tx) => {
      const guarded: SqlClient = { ...tx, async query<Row>(text: string, params?: readonly unknown[]) { queries++; return tx.query<Row>(text, params); } };
      await assert.rejects(migrateEvidenceFreeMinter(guarded, MIGRATION_CONFIG, { ...REQUEST, apply }, reader), /invalid_config/);
    });
    assert.equal(queries, 0); assert.equal(reads, 0); assert.deepEqual(await snapshot(), before);
    await assert.rejects(sql.transaction((tx) => migrateEvidenceFreeMinter(tx, MIGRATION_CONFIG, { ...REQUEST, apply }, reader)), /invalid_config/);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test("unmarked transaction adapters are refused before opening a transaction", async () => {
    await seed(); let transactions = 0;
    const unknown: SqlClient = { query: sql.query, close: sql.close, async transaction(fn) { transactions++; return sql.transaction(fn); } };
    await refuses("invalid_config", unknown); assert.equal(transactions, 0); assert.equal(reads, 0);
  });
  for (const version of [undefined, 2] as const) await t.test(`legacy metadata version ${version ?? 1} and URI bytes remain unchanged`, async () => {
    await seed(); const job = { ...blockedJob(), initialUri: metadataUriFor(version, "trading", version === undefined ? undefined : 7, REF) };
    const document: Record<string, unknown> = { ...job };
    if (version === undefined) { delete document.metadataVersion; delete document.displayNumber; } else document.metadataVersion = version;
    await sql.query("update erc8004_jobs set document=$2::jsonb where public_ref=$1", [REF, JSON.stringify(document)]);
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, reader);
    assert.deepEqual((await sql.query<{ document: unknown }>("select document from erc8004_jobs where public_ref=$1", [REF])).rows[0]!.document,
      { ...document, minter: REQUEST.newMinter, status: "pending", error: null });
  });
  for (const nonce of [null, "3"]) await t.test(`existing new nonce ${nonce} is accepted; paused source is eligible`, async () => {
    await seed(); await sql.query("insert into erc8004_nonces values(56,$1,$2)", [next, nonce]);
    await sql.query("update agents set status='paused' where id=$1", [REQUEST.sourceId]);
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, reader);
    assert.equal((await sql.query<{ next_nonce: string }>("select next_nonce from erc8004_nonces where minter=$1", [next])).rows[0]!.next_nonce, "3");
  });
  for (const [key, value] of Object.entries({ mintedId: "0", finalUri: "evidence", registrationHash: `0x${"ab".repeat(32)}`,
    updateHash: `0x${"cd".repeat(32)}`, envelope: "1", effectiveCeiling: "1", updateGasCeiling: "1", updatePriceCeiling: "1", completedAt: 0 })) {
    await t.test(`job evidence ${key} refuses without writes or RPC`, async () => { await seed(); await patchJob({ [key]: value }); await refuses("intent_mismatch"); assert.equal(reads, 0); });
  }
  for (const patch of [{ sourceId: "other" }, { publicRef: otherRef }, { owner: REQUEST.newMinter }, { category: "lp" }, { minter: REQUEST.newMinter },
    { chainId: 1 }, { registry: OWNER }, { status: "pending", error: null }, { error: "fee_limit" }, { initialUri: "modified bytes" },
    { displayNumber: 8 }, { metadataVersion: 2 }, { createdAt: -1 }, { unexpected: true }]) {
    await t.test(`JSON binding/shape refuses ${JSON.stringify(patch)}`, async () => { await seed(); await patchJob(patch); await refuses("intent_mismatch"); assert.equal(reads, 0); });
  }
  await t.test("missing evidence key refuses, even though absent is not a positive evidence value", async () => {
    await seed(); await sql.query("update erc8004_jobs set document=document-'envelope' where public_ref=$1", [REF]); await refuses("intent_mismatch");
  });
  for (const patch of [{ publicRef: "12345678-1234-4234-8234-123456789abe" }, { category: "lp" }, { status: "pending", errorCode: null }, { errorCode: "fee_limit" },
    { agentId: "0" }, { registrationTxHash: `0x${"ab".repeat(32)}` }, { uriUpdateTxHash: `0x${"ab".repeat(32)}` }, { revision: Number.MAX_SAFE_INTEGER }, { unknown: true }]) {
    await t.test(`source projection refuses ${JSON.stringify(patch)}`, async () => { await seed(); await patchIdentity(patch); await refuses("invalid_identity"); assert.equal(reads, 0); });
  }
  for (const statement of ["update agents set status='revoked'", "update agents set erc8004_agent_id='0'", "update agents set owner_address='invalid'",
    "update agents set erc8004_identity='null'", "delete from agents"]) {
    await t.test(`source eligibility refuses: ${statement}`, async () => { await seed(); await sql.query(statement); await refuses("invalid_identity|not_found"); assert.equal(reads, 0); });
  }
  for (const column of ["source_id", "owner_address", "minter"]) await t.test(`relational ${column} disagreement refuses`, async () => {
    await seed(); await sql.query(`update erc8004_jobs set ${column}=$2 where public_ref=$1`, [REF, "wrong"]); await refuses("intent_mismatch");
  });
  for (const collision of ["source", "owner", "jsonSource", "jsonRef", "jsonOwner"]) await t.test(`conflicting new job via ${collision} refuses`, async () => {
    await seed();
    await sql.query(`insert into erc8004_jobs values('collision',$1,$2,56,$3,$4::jsonb)`,
      [collision === "owner" ? OWNER : next, collision === "source" ? REQUEST.sourceId : "different-source", next,
        JSON.stringify({ sourceId: collision === "jsonSource" ? REQUEST.sourceId : "different-source", publicRef: collision === "jsonRef" ? REF : "collision",
          owner: collision === "jsonOwner" ? OWNER : next, minter: next })]);
    await refuses("conflict"); assert.equal(reads, 0);
  });
  for (const kind of ["relationalRef", "jsonRef", "oldPending", "newPending", "jsonMinter", "missingFinalized", "stringFinalized"]) {
    await t.test(`referencing/unfinalized transaction ${kind} refuses`, async () => {
      await seed();
      await sql.query("delete from erc8004_transactions where phase='update'");
      const document = { jobRef: kind === "jsonRef" ? REF : otherRef,
        ...(kind === "missingFinalized" ? {} : { finalizedAt: kind === "stringFinalized" ? "100" : ["relationalRef", "jsonRef"].includes(kind) ? 100 : null }),
        intent: { minter: kind === "jsonMinter" ? next : OWNER } };
      await sql.query(`insert into erc8004_transactions values('adversary',$1,'update',56,$2,777,$3::jsonb)`,
        [kind === "relationalRef" ? REF : otherRef, kind === "newPending" ? next : kind === "jsonMinter" ? OWNER : old, JSON.stringify(document)]);
      await refuses("other_job_pending|intent_mismatch"); assert.equal(reads, 0);
    });
  }
  for (const facts of [{ chainId: 1, latest: 3, pending: 3 }, { chainId: 56, latest: 3, pending: 4 }, { chainId: 56, latest: -1, pending: -1 },
    { chainId: 56, latest: 1.5, pending: 1.5 }, { chainId: 56, latest: Number.MAX_SAFE_INTEGER + 1, pending: Number.MAX_SAFE_INTEGER + 1 }]) {
    await t.test(`nonce facts refuse ${JSON.stringify(facts)}`, async () => { await seed(); await refuses("invalid_config|nonce_conflict", sql, { async read() { return facts; } }); });
  }
  for (const saved of ["2", "4"]) await t.test(`persisted new nonce ${saved} refuses drift in either direction`, async () => {
    await seed(); await sql.query("insert into erc8004_nonces values(56,$1,$2)", [next, saved]); await refuses("nonce_conflict");
  });
  for (const minter of [REQUEST.oldMinter, REQUEST.newMinter]) await t.test(`real worker session fence on ${minter} excludes migration and releases both transaction locks`, async () => {
    await seed(); const client = new pg.Client({ connectionString: cluster.url }); await client.connect();
    const fence = await acquireIdentityFence(client, { chainId: 56, registry: REGISTRY, minter });
    try { await refuses("lock_busy"); assert.equal(reads, 0); } finally { await fence.close(); }
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, { ...REQUEST, apply: false }, reader);
  });
  // Inject failures through the narrow SqlClient seam, but execute/rollback all writes in real PG.
  function intercept(tag: string, action: (tx: SqlClient) => Promise<void>): SqlClient {
    return { ...sql, transaction: (fn) => sql.transaction(async (tx) => {
      const wrapped: SqlClient = { ...tx, async query<Row>(text: string, params?: readonly unknown[]) {
        if (text.includes(`minterMigration.${tag}`)) await action(tx);
        return tx.query<Row>(text, params);
      } }; return fn(wrapped);
    }) };
  }
  for (const tag of ["replace", "saveNonce"]) await t.test(`SQL failure at ${tag} rolls back preceding writes`, async () => {
    await seed(); await refuses("injected", intercept(tag, async () => { throw new Error("injected"); }));
  });
  await t.test("agent CAS drift rolls back the entire transaction", async () => {
    await seed(); await refuses("conflict", intercept("project", (tx) => tx.query("update agents set erc8004_identity=jsonb_set(erc8004_identity,'{revision}','6')").then(() => {})));
  });
  await t.test("job CAS drift after projection rolls back the projection", async () => {
    await seed(); await refuses("conflict", intercept("replace", (tx) => tx.query("update erc8004_jobs set document=document || '{\"createdAt\":999}' where public_ref=$1", [REF]).then(() => {})));
  });
  await t.test("nonce conflict after both writes rolls back job and source", async () => {
    await seed(); await refuses("nonce_conflict", intercept("saveNonce", (tx) => tx.query("insert into erc8004_nonces values(56,$1,4)", [next]).then(() => {})));
  });
  await t.test("dry-run really executes write constraints", async () => {
    await seed(); const before = await snapshot();
    await assert.rejects(migrateEvidenceFreeMinter(intercept("saveNonce", async () => { throw new Error("write constraint"); }), MIGRATION_CONFIG, { ...REQUEST, apply: false }, reader), /write constraint/);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test("missing required schema index fails before RPC or writes", async () => {
    await seed();
    await sql.query("alter table erc8004_jobs drop constraint erc8004_jobs_owner_address_source_id_key");
    try { await refuses("schema_missing"); assert.equal(reads, 0); }
    finally { await sql.query("alter table erc8004_jobs add unique(owner_address,source_id)"); }
  });
  await t.test("RPC failure rolls back and releases fences", async () => {
    await seed(); await refuses("offline failure", sql, { async read() { throw new Error("offline failure"); } });
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, { ...REQUEST, apply: false }, reader);
  });
  await t.test("both worker fences are excluded while migration holds transaction locks", async () => {
    await seed();
    await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, { ...REQUEST, apply: false }, { async read(minter) {
      for (const address of [REQUEST.oldMinter, REQUEST.newMinter]) {
        const client = new pg.Client({ connectionString: cluster.url }); await client.connect();
        await assert.rejects(acquireIdentityFence(client, { chainId: 56, registry: REGISTRY, minter: address }), /lock_busy/);
      }
      return reader.read(minter);
    } });
  });
  await t.test("concurrent migrations cannot both apply", async () => {
    await seed(); let reached!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, REQUEST, { async read(minter) { reached(); await gate; return reader.read(minter); } });
    await entered;
    try { await refuses("lock_busy"); } finally { release(); }
    await first; await refuses("invalid_identity");
  });
  await t.test("connection loss after projection aborts all writes and releases both minter fences", async () => {
    await seed(); const before = await snapshot();
    const killer = await createPgSqlClient(cluster.url);
    try {
      const broken = intercept("replace", async (tx) => {
        const pid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        await killer.query("select pg_terminate_backend($1)", [pid]);
      });
      await assert.rejects(migrateEvidenceFreeMinter(broken, MIGRATION_CONFIG, REQUEST, reader));
      assert.deepEqual(await snapshot(), before);
      await migrateEvidenceFreeMinter(sql, MIGRATION_CONFIG, { ...REQUEST, apply: false }, reader);
    } finally { await killer.close(); }
  });
});

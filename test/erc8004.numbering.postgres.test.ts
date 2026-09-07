import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryIdentityDatabase, MemoryIdentityLedger, PostgresIdentityLedger, checkIdentityNumberingSchema, migrateIdentity, type IdentityLedger } from "../src/store/erc8004.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { IdentityService } from "../src/identity/service.js";
import { MemoryIdentityFence } from "../src/identity/fence.js";
import { metadataUriFor } from "../src/identity/metadata.js";
import { newIdentity, type IdentityJob } from "../src/identity/types.js";
import { CONFIG, FixtureGateway, FixtureSources, OWNER } from "./support/erc8004.js";
import { REQUEST } from "./support/minterMigration.js";
import { localPostgres } from "./support/localPostgres.js";

for (const postgres of [false, true]) test(`${postgres ? "real PostgreSQL" : "memory"}: global owner/category numbering across minters`, { timeout: 120_000 }, async (t) => {
  const cluster = postgres ? await localPostgres() : null;
  if (postgres && !cluster) { t.skip("PostgreSQL 17 binaries unavailable; no external database fallback"); return; }
  const sql = cluster ? await createPgSqlClient(cluster.url) : null;
  t.after(async () => { await sql?.close(); await cluster?.close(); });
  if (sql) {
    await sql.query("create table agents (id text primary key, erc8004_agent_id text)");
    await migrateIdentity(sql); await checkIdentityNumberingSchema(sql);
  }
  const database = new MemoryIdentityDatabase();
  const nextConfig = { ...CONFIG, minter: REQUEST.newMinter };
  const ledger = (config = CONFIG): IdentityLedger => sql ? new PostgresIdentityLedger(sql, config) : new MemoryIdentityLedger(config, database);
  const old = ledger(); const next = ledger(nextConfig); const sources = new FixtureSources();
  const gateway = new FixtureGateway(); const fence = new MemoryIdentityFence();
  const service = (jobs: IdentityLedger, config = CONFIG) => new IdentityService(config, jobs, sources, gateway, fence, () => 1_000_000);
  const first = service(old); const second = service(next, nextConfig);

  await t.test("registered old-minter Grid 1 stays byte-identical; new pending Grid receives 2", async () => {
    await first.discover("agent"); await first.step("agent");
    let state = await old.read(); await gateway.land(state.transactions[0]!, state.jobs[0]!.initialUri);
    await first.step("agent"); await first.step("agent");
    state = await old.read(); await gateway.land(state.transactions[1]!, state.jobs[0]!.finalUri!); await first.step("agent");
    const retained = await old.read(); assert.equal(retained.jobs[0]!.status, "registered");
    sources.rows.set("new", { id: "new", owner: OWNER, identity: newIdentity("grid"), existingId: null, category: "grid", eligible: true });
    await second.discover(); await second.discover();
    assert.equal((await next.read()).jobs[0]!.displayNumber, 2); assert.deepEqual(await old.read(), retained);
    await assert.rejects(second.discover("agent"), /invalid_identity/);
  });
  await t.test("restart preserves numbers and other owners/categories each start at 1", async () => {
    for (const [id, owner, category] of [["lp", OWNER, "lp"], ["other-owner", REQUEST.oldMinter, "grid"]] as const) {
      sources.rows.set(id, { id, owner, category, identity: newIdentity(category), existingId: null, eligible: true });
    }
    await service(ledger(nextConfig), nextConfig).discover();
    const jobs = (await next.read()).jobs;
    assert.equal(jobs.find((job) => job.sourceId === "new")!.displayNumber, 2);
    for (const id of ["lp", "other-owner"]) assert.equal(jobs.find((job) => job.sourceId === id)!.displayNumber, 1);
  });
  await t.test("concurrent selected discovery on different minters cannot reuse numbers", async () => {
    const work: Promise<void>[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `concurrent-${i}`;
      sources.rows.set(id, { id, owner: OWNER, category: "grid", identity: newIdentity("grid"), existingId: null, eligible: true });
      work.push((i % 2 ? first : second).discover(id));
    }
    await Promise.all(work);
    const numbers = [...(await old.read()).jobs, ...(await next.read()).jobs]
      .filter((job) => job.owner.toLowerCase() === OWNER && job.category === "grid").map((job) => job.displayNumber!).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 14 }, (_, i) => i + 1));
  });
  await t.test("duplicate number and cross-minter source/ref rebinding fail without changing either ledger", async () => {
    const before = [await old.read(), await next.read()]; const original = before[0]!.jobs[0]!;
    for (const collision of ["number", "source", "ref"] as const) {
      const ref = collision === "ref" ? original.publicRef : newIdentity("grid").publicRef;
      const job: IdentityJob = { ...before[1]!.jobs.find((job) => job.sourceId === "new")!,
        publicRef: ref, sourceId: collision === "source" ? original.sourceId : `duplicate-${collision}`,
        displayNumber: collision === "number" ? 1 : 99, initialUri: metadataUriFor(3, "grid", collision === "number" ? 1 : 99, ref) };
      await assert.rejects(next.atomic(fence, (state) => { state.jobs.push(job); }), /conflict|duplicate/);
      assert.deepEqual([await old.read(), await next.read()], before);
    }
  });
  await t.test("a failed allocation rolls back the job and leaves the next number available", async () => {
    const id = "retry"; sources.rows.set(id, { id, owner: OWNER, category: "grid", identity: newIdentity("grid"), existingId: "42", eligible: true });
    await assert.rejects(second.discover(id), /invalid_identity/);
    sources.rows.set(id, { ...sources.rows.get(id)!, existingId: null }); await second.discover(id);
    assert.equal((await next.read()).jobs.find((job) => job.sourceId === id)!.displayNumber, 15);
  });
  await t.test("legacy unnumbered jobs stay unchanged and cannot acquire a number through ordinary mutation", async () => {
    const ref = newIdentity("trading").publicRef;
    const legacy = { ...(await next.read()).jobs.find((job) => job.sourceId === "new")!, publicRef: ref, sourceId: "legacy",
      minter: CONFIG.minter, category: "trading" as const, initialUri: metadataUriFor(undefined, "trading", undefined, ref) };
    delete legacy.displayNumber; delete legacy.metadataVersion;
    await old.atomic(fence, (state) => { state.jobs.push(legacy); });
    sources.rows.set("new-trading", { id: "new-trading", owner: OWNER, category: "trading", identity: newIdentity("trading"), existingId: null, eligible: true });
    await second.discover("new-trading");
    assert.equal((await next.read()).jobs.find((job) => job.sourceId === "new-trading")!.displayNumber, 1);
    assert.deepEqual((await old.read()).jobs.find((job) => job.sourceId === "legacy"), legacy);
    await assert.rejects(old.atomic(fence, (state) => {
      const index = state.jobs.findIndex((job) => job.sourceId === "legacy"); state.jobs[index] = { ...legacy, displayNumber: 9 };
    }), /intent_mismatch/);
    assert.deepEqual((await old.read()).jobs.find((job) => job.sourceId === "legacy"), legacy);
  });
  if (sql) {
    await t.test("durable unique index rejects case-variant owners and survives adapter restart", async () => {
      const job = (await next.read()).jobs.find((job) => job.sourceId === "other-owner")!;
      await assert.rejects(sql.query("insert into erc8004_jobs values($1,$2,'bypass',56,$3,$4::jsonb)",
        [newIdentity("grid").publicRef, job.owner.toUpperCase(), CONFIG.minter.toLowerCase(), JSON.stringify(job)]), /duplicate/);
      await checkIdentityNumberingSchema(sql);
    });
    await t.test("missing or wrongly defined numbering index blocks discovery before any write", async () => {
      const before = await sql.query("select row_to_json(j) as document from erc8004_jobs j order by public_ref");
      await sql.query("drop index erc8004_owner_category_number");
      for (const wrong of [false, true]) {
        if (wrong) await sql.query("create unique index erc8004_owner_category_number on erc8004_jobs (minter, (document->>'category'), ((document->>'displayNumber')::numeric), public_ref)");
        await assert.rejects(second.discover(), /schema_missing/);
        assert.deepEqual(await sql.query("select row_to_json(j) as document from erc8004_jobs j order by public_ref"), before);
      }
    });
  }
});

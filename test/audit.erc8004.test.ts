import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkIdentitySchema, dailyLiability } from "../src/store/erc8004.js";
import { verifyIdentity } from "../src/identity/service.js";
import { metadataUri } from "../src/identity/metadata.js";
import { newIdentity, validIdentity, type IdentitySource } from "../src/identity/types.js";
import type { SqlClient } from "../src/store/sql.js";
import { fixture } from "./support/erc8004.js";

async function completed(postgres = false) {
  const f = fixture(postgres);
  await f.service.discover("agent");
  assert.equal((await f.service.step("agent")).status, "registering");
  const first = await f.ledger.read();
  await f.gateway.land(first.transactions[0]!, first.jobs[0]!.initialUri);
  assert.equal((await f.service.step("agent")).status, "updating");
  assert.equal((await f.service.step("agent")).status, "updating");
  const second = await f.ledger.read();
  await f.gateway.land(second.transactions[1]!, second.jobs[0]!.finalUri!);
  assert.equal((await f.service.step("agent")).status, "registered");
  return f;
}

describe("ERC-8004 independent implementation audit", () => {
  it("accepts the installed PostgreSQL index expressions and rejects each missing unique index", async () => {
    const plain = (table_name: string, key_columns: string[]) => ({ table_name, key_columns, expression: null, predicate: null });
    const indexes = [
      plain("erc8004_jobs", ["public_ref"]),
      plain("erc8004_jobs", ["owner_address", "source_id"]),
      plain("erc8004_transactions", ["hash"]),
      plain("erc8004_transactions", ["job_ref", "phase"]),
      plain("erc8004_transactions", ["chain", "minter", "nonce"]),
      plain("erc8004_nonces", ["chain", "minter"]),
      { table_name: "agents", key_columns: [], expression: "(erc8004_identity ->> 'publicRef'::text)", predicate: "(erc8004_identity IS NOT NULL)" },
    ];
    let missing: number | null = null;
    const sql: SqlClient = {
      async query<Row>(text: string) {
        const rows = text.includes("erc8004.schemaIndexes") ? indexes.filter((_value, index) => index !== missing) : [];
        return { rows: rows as unknown as Row[] };
      },
      async transaction<T>(fn: (tx: SqlClient) => Promise<T>) { return fn(sql); },
      async close() {},
    };
    await checkIdentitySchema(sql);
    for (let index = 0; index < indexes.length; index++) {
      missing = index;
      await assert.rejects(checkIdentitySchema(sql), /schema_missing/, `missing index ${index} was accepted`);
    }
    missing = null;
    const referenceIndex = indexes[6]!;
    for (const key of ["public(Ref)", "public Ref", "public::textRef", "publicref", "publicREF"]) {
      referenceIndex.expression = `(erc8004_identity ->> '${key}'::text)`;
      await assert.rejects(checkIdentitySchema(sql), /schema_missing/, `wrong JSON key ${key} was accepted`);
    }
  });

  it("refuses column-compatible tables when required uniqueness evidence is absent", async () => {
    const statements: string[] = [];
    const sql: SqlClient = {
      async query<Row>(text: string) {
        statements.push(text);
        return { rows: [] as Row[] };
      },
      async transaction<T>(fn: (tx: SqlClient) => Promise<T>) { return fn(sql); },
      async close() {},
    };
    await assert.rejects(checkIdentitySchema(sql), /schema_missing/);
    assert.ok(statements.every((statement) => !/\b(?:insert|update|delete|alter|create)\b/i.test(statement)));
  });

  it("report-only verification binds the selected owner, source, category and transaction summary", async () => {
    const f = await completed();
    const source = await f.sources.get("agent");
    assert.ok(source && validIdentity(source.identity));
    const identity = source.identity;
    assert.equal((await verifyIdentity(source, f.ledger, f.gateway)).verified, true);
    const changed: IdentitySource[] = [
      { ...source, id: "another-instance" },
      { ...source, owner: "0x3333333333333333333333333333333333333333" },
      { ...source, identity: { ...identity, category: "trading" } },
      { ...source, identity: { ...identity, registrationTxHash: `0x${"cc".repeat(32)}` } },
      { ...source, identity: { ...identity, uriUpdateTxHash: `0x${"dd".repeat(32)}` } },
    ];
    for (const mismatch of changed) {
      const result = await verifyIdentity(mismatch, f.ledger, f.gateway);
      assert.equal(result.verified, false, `accepted mismatched mapping: ${mismatch.id}/${mismatch.owner}/${JSON.stringify(mismatch.identity)}`);
    }
  });

  it("completed discovery is idempotent across PostgreSQL JSON object key ordering", async () => {
    const f = await completed();
    const originalGet = f.sources.get.bind(f.sources);
    f.sources.get = async (id) => {
      const source = await originalGet(id);
      if (source && validIdentity(source.identity)) {
        const reordered = Object.fromEntries(Object.entries(source.identity).sort(([a], [b]) => a.localeCompare(b)));
        return { ...source, identity: reordered as unknown as typeof source.identity };
      }
      return source;
    };
    const before = await originalGet("agent");
    assert.ok(before && validIdentity(before.identity));
    await f.service.discover("agent");
    await f.service.discover("agent");
    const after = await originalGet("agent");
    assert.ok(after && validIdentity(after.identity));
    assert.equal(after.identity.revision, before.identity.revision);
    assert.equal(f.gateway.sent.length, 2);
  });

  it("starts the full 24h fee hold after the final awaited identity verification", async () => {
    const f = fixture();
    await f.service.discover("agent");
    await f.service.step("agent");
    const first = await f.ledger.read();
    await f.gateway.land(first.transactions[0]!, first.jobs[0]!.initialUri);
    await f.service.step("agent");
    await f.service.step("agent");
    const second = await f.ledger.read();
    await f.gateway.land(second.transactions[1]!, second.jobs[0]!.finalUri!);
    const originalIdentity = f.gateway.identity.bind(f.gateway);
    f.gateway.identity = async () => {
      f.setNow(100_000_000);
      return originalIdentity();
    };
    assert.equal((await f.service.step("agent")).status, "registered");
    const final = await f.ledger.read();
    assert.equal(final.jobs[0]!.completedAt, 100_000_000);
    assert.equal(dailyLiability(final, 100_000_001), 10_240n);
    assert.equal(dailyLiability(final, 186_400_000), 0n);
  });

  it("discovers all pages in the source reader's ordering, including non-ASCII collation order", async () => {
    const f = fixture();
    const original = (await f.sources.get("agent"))!;
    const page = (prefix: string) => Array.from({ length: 100 }, (_unused, index) => ({
      ...original, id: `${prefix}${String(index).padStart(3, "0")}`, identity: newIdentity("grid"),
    }));
    // A locale can put lowercase `a` before uppercase `B`; the repository's
    // cursor is opaque to the service, whose JS order must not override it.
    const first = page("a"), second = page("B");
    f.sources.enrolled = async (cursor = "") => cursor === "" ? first : cursor === "a099" ? second : [];
    await f.service.discover();
    assert.equal((await f.ledger.read()).jobs.length, 200);
    assert.equal(f.gateway.signed.length, 0);
  });

  it("refuses incomplete or inconsistent durable terminal evidence before registered reprojection", async () => {
    const f = await completed(true);
    const original = structuredClone({ jobs: f.sql.jobs, txs: f.sql.txs });
    const changes: ((job: Record<string, unknown>, tx: Record<string, unknown>) => void)[] = [
      (job) => { job.completedAt = null; },
      (job) => { job.error = "private raw provider error"; },
      (job) => { job.status = "pending"; },
      (job) => { job.status = "blocked"; job.completedAt = null; job.error = null; },
      (_job, tx) => { tx.finalizedAt = null; },
      (_job, tx) => { tx.outcome = null; },
      (_job, tx) => { tx.blockHash = null; },
      (_job, tx) => { tx.blockNumber = null; },
      (_job, tx) => { tx.intent = { ...(tx.intent as object), data: "0x1234" }; },
    ];
    for (const [index, change] of changes.entries()) {
      f.sql.jobs = structuredClone(original.jobs);
      f.sql.txs = structuredClone(original.txs);
      change([...f.sql.jobs.values()][0]!, [...f.sql.txs.values()][1]!);
      await assert.rejects(f.ledger.read(), /intent_mismatch/, `accepted terminal inconsistency ${index}`);
    }
    f.sql.jobs = structuredClone(original.jobs);
    f.sql.txs = structuredClone(original.txs);
    const genuine = [...f.sql.jobs.values()][0]!;
    assert.equal(typeof genuine.mintedId, "string");
    const ref = newIdentity("grid").publicRef;
    f.sql.jobs.set(ref, {
      ...genuine, publicRef: ref, sourceId: "forged-second-instance",
      initialUri: metadataUri("grid", ref), finalUri: metadataUri("grid", ref, genuine.mintedId as string),
    });
    await assert.rejects(f.ledger.read(), /intent_mismatch/, "another job's hashes were accepted as terminal proof");
  });
});

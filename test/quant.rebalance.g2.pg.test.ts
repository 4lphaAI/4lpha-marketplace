/** G2 preparation against databases created inside this test's own initdb cluster. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { keccak256, stringToBytes } from "viem";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { inspectG2Database, prepareG2Database } from "../src/quant/rebalanceSelftest.js";
import { buildQuantWalletCensus } from "../src/quant/rebalanceCensus.js";
import { rebalanceCanonicalEncode } from "../src/quant/rebalanceCanonical.js";

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? done() : reject(new Error(`temporary-PG-helper-${code}: ${stderr}`)));
  });
}

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert(address !== null && typeof address === "object");
  await new Promise<void>((done, reject) => server.close((error) => error === undefined ? done() : reject(error)));
  return address.port;
}

test("G2 guarded PostgreSQL preparation checks identity, inventory, concurrency and rollback", { timeout: 180_000 }, async (t) => {
  const bin = "C:\\Program Files\\PostgreSQL\\17\\bin";
  const exe = (name: string) => join(bin, `${name}.exe`);
  try { await Promise.all([access(exe("initdb")), access(exe("postgres")), access(exe("pg_ctl")), access(exe("pg_isready"))]); }
  catch { t.skip("PostgreSQL 17 binaries are unavailable; no inherited DATABASE_URL is used."); return; }
  const root = await mkdtemp(join(tmpdir(), "4lpha-g2-pg-"));
  assert.deepEqual(await readdir(root), []);
  const data = join(root, "data");
  const listenPort = await port();
  await command(exe("initdb"), ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale", "--username=g2_test_admin"]);
  const server: ChildProcess = spawn(exe("postgres"), ["-D", data, "-F", "-p", String(listenPort), "-h", "127.0.0.1"],
    { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  const adminUrl = `postgresql://g2_test_admin@127.0.0.1:${listenPort}/postgres`;
  let admin: SqlClient | null = null;
  try {
    let ready = false;
    for (let index = 0; index < 100; index += 1) {
      try { await command(exe("pg_isready"), ["-h", "127.0.0.1", "-p", String(listenPort)]); ready = true; break; }
      catch { await new Promise((done) => setTimeout(done, 50)); }
    }
    assert.equal(ready, true);
    admin = await createPgSqlClient(adminUrl);
    const newDb = async () => {
      const name = `g2_test_${randomUUID().replaceAll("-", "")}`;
      await admin!.query(`create role ${name} login nosuperuser nocreatedb nocreaterole noreplication`);
      await admin!.query(`create database ${name} owner ${name} template template0`);
      await admin!.query(`alter database ${name} set search_path=public`);
      const sql = await createPgSqlClient(`postgresql://${name}@127.0.0.1:${listenPort}/${name}`);
      const identity = { database: name, role: name, server: `127.0.0.1:${listenPort}`, guardRoot: root };
      return { sql, identity };
    };

    const empty = await newDb();
    try {
      await assert.rejects(() => inspectG2Database(empty.sql, 10, true,
        { ...empty.identity, database: "wrong_database" }), /g2-db-identity-refused/u);
      await assert.rejects(() => inspectG2Database(empty.sql, 10, true,
        { ...empty.identity, server: "127.0.0.1:5432" }), /g2-db-identity-refused/u);
      const preview = await prepareG2Database(empty.sql, 10, false, empty.identity);
      assert.equal(preview.userObjects, 0);
      await prepareG2Database(empty.sql, 10, true, empty.identity);
      const marker = await empty.sql.query<Record<string, unknown>>(`select census_digest,disposition_digest,installed_at_ms
        from quant_wallet_claim_migration where migration_version=1`);
      const installedAtMs = Number(marker.rows[0]?.["installed_at_ms"]);
      assert.ok(Number.isSafeInteger(installedAtMs) && installedAtMs > 0);
      const expectedCensus = buildQuantWalletCensus({ generatedAtMs: installedAtMs, migrationInstalled: false,
        gridJobs: [], gridActions: [], rebalanceJobs: [], rebalanceActions: [], claims: [] });
      assert.equal(marker.rows[0]?.["census_digest"], expectedCensus.digest);
      assert.equal(marker.rows[0]?.["disposition_digest"], keccak256(stringToBytes(rebalanceCanonicalEncode([]))));
      assert.equal(existsSync(join(root, `quant-rebalance-g2-prepare-${empty.identity.database}.complete`)), true);
      assert.equal(existsSync(join(root, `quant-rebalance-g2-prepare-${empty.identity.database}.guard`)), false);
      await assert.rejects(() => prepareG2Database(empty.sql, 10, true, empty.identity), /g2-db-identity-refused/u);
    } finally { await empty.sql.close(); }

    const populated = await newDb();
    try {
      await populated.sql.query("create table public.preexisting(id int)");
      await assert.rejects(() => prepareG2Database(populated.sql, 10, true, populated.identity), /g2-db-identity-refused/u);
    } finally { await populated.sql.close(); }

    const foreignSchema = await newDb();
    try {
      await foreignSchema.sql.query("create schema hidden");
      await assert.rejects(() => prepareG2Database(foreignSchema.sql, 10, true, foreignSchema.identity), /g2-db-identity-refused/u);
    } finally { await foreignSchema.sql.close(); }

    const partialMarker = await newDb();
    try {
      await partialMarker.sql.query("create table quant_wallet_claim_migration(migration_version int)");
      await assert.rejects(() => prepareG2Database(partialMarker.sql, 10, true, partialMarker.identity), /g2-db-identity-refused/u);
    } finally { await partialMarker.sql.close(); }

    const roleDb = await newDb();
    try {
      const wrongRole = await createPgSqlClient(`postgresql://g2_test_admin@127.0.0.1:${listenPort}/${roleDb.identity.database}`);
      try { await assert.rejects(() => prepareG2Database(wrongRole, 10, true, roleDb.identity), /g2-db-identity-refused/u); }
      finally { await wrongRole.close(); }
    } finally { await roleDb.sql.close(); }

    const rollback = await newDb();
    try {
      const failing: SqlClient = { transactionScope: "top-level", query: (statement, params, options) => rollback.sql.query(statement, params, options),
        close: () => rollback.sql.close(),
        transaction: (fn) => rollback.sql.transaction((tx) => fn({ ...tx,
          query: (statement, params, options) => statement.includes("insert into quant_wallet_claim_migration")
            ? Promise.reject(new Error("injected-marker-failure")) : tx.query(statement, params, options),
        })) };
      await assert.rejects(() => prepareG2Database(failing, 10, true, rollback.identity), /injected-marker-failure/u);
      assert.equal((await inspectG2Database(rollback.sql, 10, true, rollback.identity)).userObjects, 0);
      assert.equal(existsSync(join(root, `quant-rebalance-g2-prepare-${rollback.identity.database}.guard`)), true);
      await assert.rejects(() => prepareG2Database(rollback.sql, 10, false, rollback.identity), /g2-db-preparation-already-attempted/u);
    } finally { await rollback.sql.close(); }

    const concurrent = await newDb();
    const second = await createPgSqlClient(`postgresql://${concurrent.identity.role}@127.0.0.1:${listenPort}/${concurrent.identity.database}`);
    try {
      const results = await Promise.allSettled([
        prepareG2Database(concurrent.sql, 10, true, concurrent.identity),
        prepareG2Database(second, 10, true, concurrent.identity),
      ]);
      assert.ok(results.filter((item) => item.status === "fulfilled").length <= 1);
    } finally { await concurrent.sql.close(); await second.close(); }
  } finally {
    await admin?.close();
    try { await command(exe("pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); }
    catch { server.kill("SIGKILL"); }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  }
});

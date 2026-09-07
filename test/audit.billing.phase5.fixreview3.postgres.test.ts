import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPgSqlClient } from "../src/store/sql.js";
import { PostgresBillingStore } from "../src/billing/postgres.js";

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}: ${stderr}`)));
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

async function waitReady(executable: string, port: number, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`PostgreSQL exited ${process.exitCode} before becoming ready.`);
    try { await command(executable, ["-h", "127.0.0.1", "-p", String(port)]); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error("PostgreSQL did not become ready.");
}

test("fix-review3 A3: a real legacy identity table gains logical and assertion uniqueness", { timeout: 120_000 }, async (t) => {
  const postgresBin = process.env["PHASE5_POSTGRES_BIN"] ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const initdb = join(postgresBin, process.platform === "win32" ? "initdb.exe" : "initdb");
  const postgres = join(postgresBin, process.platform === "win32" ? "postgres.exe" : "postgres");
  const pgCtl = join(postgresBin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  const pgIsReady = join(postgresBin, process.platform === "win32" ? "pg_isready.exe" : "pg_isready");
  try { await Promise.all([access(initdb), access(postgres), access(pgCtl), access(pgIsReady)]); }
  catch { t.skip(`PostgreSQL binaries are unavailable at ${postgresBin}`); return; }

  const root = await mkdtemp(join(tmpdir(), "4lpha-phase5-audit-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  let postgresProcess: ChildProcess | undefined;
  let postmasterPid: string | undefined;
  try {
    await command(initdb, ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale", "--username=phase5_audit"]);
    postgresProcess = spawn(postgres, ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
    });
    await waitReady(pgIsReady, port, postgresProcess);
    postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/u, 1)[0]?.trim();
    const url = `postgresql://phase5_audit@127.0.0.1:${port}/postgres`;

    const fresh = await PostgresBillingStore.create(await createPgSqlClient(url), Buffer.alloc(32, 2));
    await fresh.close();
    const setup = await createPgSqlClient(url);
    await setup.query("drop table phase5_billing_usage_identities");
    await setup.query(`create table phase5_billing_usage_identities (
      usage_id text primary key, grant_id text not null, generation numeric(78,0) not null,
      operation text not null, logical_request_id text not null, assertion_nonce text not null,
      debit_identity text unique)`);
    await setup.close();

    const migrated = await PostgresBillingStore.create(await createPgSqlClient(url), Buffer.alloc(32, 2));
    await migrated.close();
    const inspector = await createPgSqlClient(url);
    await inspector.query(`insert into phase5_billing_usage_identities
      (usage_id,grant_id,generation,operation,logical_request_id,assertion_nonce,source)
      values('one','grant',1,'paid.0g.chat','logical','assertion','0g')`);
    let duplicateRejected = false;
    try {
      await inspector.query(`insert into phase5_billing_usage_identities
        (usage_id,grant_id,generation,operation,logical_request_id,assertion_nonce,source)
        values('two','grant',1,'paid.0g.chat','logical','assertion','0g')`);
    } catch { duplicateRejected = true; }
    await inspector.close();
    assert.equal(duplicateRejected, true, "legacy migration allowed duplicate logical request and assertion identities");
  } finally {
    const childExit = postgresProcess === undefined || postgresProcess.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => postgresProcess!.once("exit", () => resolve()));
    if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      await command(pgCtl, ["stop", "-D", data, "-m", "fast", "-w"]).catch(() => undefined);
      await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (process.platform === "win32" && postmasterPid !== undefined && /^\d+$/u.test(postmasterPid)) {
      await command("C:\\Windows\\System32\\taskkill.exe", ["/PID", postmasterPid, "/T", "/F"]).catch(() => undefined);
    } else if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      postgresProcess.kill("SIGTERM");
    }
    await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

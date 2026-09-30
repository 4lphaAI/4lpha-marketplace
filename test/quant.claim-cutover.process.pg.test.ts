/**
 * The real singleton-loss lifecycle of the cutover, in a child process against a database created inside this
 * test's own temporary cluster. Nothing here reads DATABASE_URL or an env file, and no worker is started: the child
 * is `test/support/quantClaimCutoverChild.ts`, which only runs `applyCutover` on that cluster.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { localPostgres } from "./support/localPostgres.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { PostgresQuantJobStore } from "../src/store/quantJobs.js";
import { createPgSqlClient } from "../src/store/sql.js";

/** Unref'd, so a race that its other branch wins leaves no timer holding the test process open. */
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

test("claim cutover: a lost real singleton lease stops dispatch, terminates the pinned backend, then exits non-zero", { timeout: 120_000 }, async (t) => {
  const cluster = await localPostgres();
  if (cluster === null) { t.skip("PostgreSQL 17 binaries are unavailable; DATABASE_URL is never read"); return; }
  const sql = await createPgSqlClient(cluster.url);
  let child: ReturnType<typeof spawn> | undefined;
  let pinned: number | undefined;
  try {
    await PostgresQuantJobStore.create(sql); await PostgresExecutionJournal.create(sql);
    await sql.query("alter table quant_jobs drop column claim_generation");

    const env = { ...process.env }; delete env["DATABASE_URL"];
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./support/quantClaimCutoverChild.ts", import.meta.url)), cluster.url],
      { windowsHide: true, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child!.once("exit", resolve));
    const messages = new Map<string, unknown>();
    const waiters = new Map<string, () => void>();
    child.once("exit", () => { for (const wake of waiters.values()) wake(); }); // a child that ends early fails the wait at once
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      for (const [key, value] of Object.entries(message)) { messages.set(key, value); waiters.get(key)?.(); }
    });
    const message = async (key: string, timeoutMs: number): Promise<unknown> => {
      if (!messages.has(key)) await Promise.race([new Promise<void>((resolve) => { waiters.set(key, resolve); }), pause(timeoutMs)]);
      assert.ok(messages.has(key), `the child never reported ${key}; stderr: ${stderr.slice(0, 400)}`);
      return messages.get(key);
    };

    pinned = Number(await message("lockedPid", 60_000));
    assert.ok(Number.isSafeInteger(pinned) && pinned > 0);
    // Only this child's own lease connections exist with this application name in this temporary cluster.
    const leases = (await sql.query("select pid from pg_stat_activity where application_name = '4lpha-worker-singleton' order by pid")).rows;
    assert.equal(leases.length, 2);
    await sql.query("select pg_terminate_backend($1::int)", [leases[0]?.["pid"]]);

    const outcome = await message("outcome", 30_000) as { kind: string; code?: string; details?: string[] };
    assert.equal(outcome.kind, "refused", JSON.stringify(outcome));
    assert.equal(outcome.code, "fence-lost");
    assert.deepEqual(outcome.details, [], "the pinned backend's rollback was confirmed");
    // Reported after the run's own bounded cleanup, and while the process is still alive: the backend is gone
    // although it was in the middle of a 30 s server-side statement.
    assert.equal((await sql.query("select 1 from pg_stat_activity where pid = $1::int", [pinned])).rows.length, 0);
    const writer = new pg.Client({ connectionString: cluster.url }); await writer.connect();
    try {
      await writer.query("set lock_timeout = '250ms'");
      await writer.query(`insert into execution_journal (idempotency_key, agent_id, owner_address, kind, state)
        values ('after-loss', 'lp-agent', '0x1111111111111111111111111111111111111111', 'lp', 'PENDING')`);
    } finally { await writer.end(); }

    const code = await Promise.race([exited, pause(15_000).then(() => "still running" as const)]);
    assert.equal(code, 1, `the fail-stop exit is non-zero; stderr: ${stderr.slice(0, 400)}`);
  } finally {
    if (child !== undefined && child.exitCode === null) { child.kill(); await new Promise<void>((resolve) => child!.once("exit", () => resolve())); }
    if (pinned !== undefined) await sql.query("select pg_terminate_backend(pid) from pg_stat_activity where pid = $1::int", [pinned]).catch(() => undefined);
    await sql.close();
    await cluster.close();
  }
});

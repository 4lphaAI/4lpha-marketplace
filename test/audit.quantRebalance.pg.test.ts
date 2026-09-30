/** Independent PostgreSQL regression; creates its own temporary loopback cluster. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { getAddress } from "viem";
import { createPgSqlClient } from "../src/store/sql.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { PostgresQuantJobStore } from "../src/store/quantJobs.js";
import { PostgresQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { PostgresQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";

async function command(executable: string, args: readonly string[]) {
  await new Promise<void>((done, reject) => {
    const child = spawn(executable, [...args], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? done() : reject(new Error(`offline-postgres-exit:${code}`)));
  });
}

test("audit RB PG: hydrated but unadmitted Grid refusal releases its provisional claim", { timeout: 60_000 }, async (t) => {
  const bin = process.env["QUANT_REBALANCE_POSTGRES_BIN"] ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const executable = (name: string) => join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
  try { await Promise.all(["initdb", "postgres", "pg_ctl", "pg_isready"].map((name) => access(executable(name)))); }
  catch { t.skip("local PostgreSQL unavailable; no database URL or env file is read"); return; }
  const root = await mkdtemp(join(tmpdir(), "4lpha-audit-rebalance-pg-"));
  assert.deepEqual(await readdir(root), []);
  const data = join(root, "data");
  const portProbe = createServer();
  await new Promise<void>((done) => portProbe.listen(0, "127.0.0.1", done));
  const address = portProbe.address(); assert(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => portProbe.close(() => done()));
  let started = false;
  try {
    await command(executable("initdb"), ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale", "--username=quant_audit"]);
    const child = spawn(executable("postgres"), ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
    started = true;
    for (let n = 0; n < 100; n += 1) {
      if (child.exitCode !== null) throw new Error("isolated-postgres-exited");
      try { await command(executable("pg_isready"), ["-h", "127.0.0.1", "-p", String(port)]); break; }
      catch { await new Promise((done) => setTimeout(done, 50)); }
    }
    const sql = await createPgSqlClient(`postgresql://quant_audit@127.0.0.1:${port}/postgres`);
    try {
      const grid = await PostgresQuantJobStore.create(sql);
      const rebalance = new PostgresQuantRebalanceStore(sql); await rebalance.ensureSchema();
      const claims = new PostgresQuantWalletClaimStore(sql); await claims.ensureSchema();
      await PostgresExecutionJournal.create(sql);
      const now = Date.now(); const wallet = getAddress(`0x${"87".repeat(20)}`);
      await grid.discoverJob({ quantJobId: "unadmitted-grid", strategyId: "grid", envelopeId: "bad-envelope", envelopeJson: "{}", nowMs: now });
      const hydrated = await grid.updateJobWire({ quantJobId: "unadmitted-grid", strategyId: "grid", tradingWallet: wallet,
        allocationUWei: 10n ** 19n, dailyCapUWei: 10n ** 19n, termDays: 30,
        startedAtMs: now, endsAtMs: now + 86_400_000, sessionExpiresAtMs: now + 86_400_000, revokedAtMs: null, nowMs: now });
      assert(hydrated); assert(hydrated.rowVersion > 1);
      const attempt = { wallet, strategyKind: "grid" as const, strategyId: "grid", jobId: "unadmitted-grid", attemptId: "bad-attempt", nowMs: now };
      const claim = await claims.claimProvisional(attempt); assert.equal(claim.kind, "acquired");
      if (claim.kind !== "acquired") throw new Error("claim-unavailable");
      assert.equal(await claims.releaseProvisional({ ...attempt, generation: claim.claim.generation, refusal: "envelope-invalid" }), "released");
    } finally { await sql.close(); }
  } finally {
    if (started) await command(executable("pg_ctl"), ["-D", data, "-m", "immediate", "stop"]);
    const tempRoot = resolve(tmpdir()) + sep;
    assert(resolve(root).startsWith(tempRoot));
    assert(resolve(root).includes("4lpha-audit-rebalance-pg-"));
    await rm(root, { recursive: true, force: true });
  }
});

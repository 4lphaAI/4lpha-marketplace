/**
 * PHASE3.25 R5.7 item 8 — real-Postgres proof that independent shift quotas
 * still share one serialized spacing gate. This starts only a temporary local
 * PostgreSQL process and never connects to a chain or external service.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress } from "viem";
import { PostgresLpSequenceStore, type LpExitQuota } from "../src/store/lpSequences.js";
import { createPgSqlClient } from "../src/store/sql.js";

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited ${code}: ${stderr}`));
    });
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return port;
}

async function waitReady(
  executable: string,
  port: number,
  process: ChildProcess,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`PostgreSQL exited ${process.exitCode} before becoming ready.`);
    }
    try {
      await command(executable, ["-h", "127.0.0.1", "-p", String(port)]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("PostgreSQL did not become ready.");
}

test("PHASE3.25 R5.7: real Postgres serializes cross-versus-drift spacing", {
  timeout: 120_000,
}, async (t) => {
  const postgresBin = process.env["PHASE325_POSTGRES_BIN"]
    ?? process.env["PHASE5_POSTGRES_BIN"]
    ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const initdb = join(postgresBin, process.platform === "win32" ? "initdb.exe" : "initdb");
  const postgres = join(postgresBin, process.platform === "win32" ? "postgres.exe" : "postgres");
  const pgCtl = join(postgresBin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  const pgIsReady = join(postgresBin, process.platform === "win32" ? "pg_isready.exe" : "pg_isready");
  try {
    await Promise.all([access(initdb), access(postgres), access(pgCtl), access(pgIsReady)]);
  } catch {
    t.skip(`PostgreSQL binaries are unavailable at ${postgresBin}`);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "4lpha-phase325-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  let postgresProcess: ChildProcess | undefined;
  let postmasterPid: string | undefined;
  try {
    await command(initdb, [
      "-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale",
      "--username=phase325_audit",
    ]);
    postgresProcess = spawn(
      postgres,
      ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    await waitReady(pgIsReady, port, postgresProcess);
    postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8"))
      .split(/\r?\n/u, 1)[0]?.trim();

    const url = `postgresql://phase325_audit@127.0.0.1:${port}/postgres`;
    const now = 1_900_000_000_000;
    const store = await PostgresLpSequenceStore.create(await createPgSqlClient(url), () => now);
    const owner = getAddress("0x1111111111111111111111111111111111111111");
    const token0 = getAddress("0x00000000000000000000000000000000000000AA");
    const token1 = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
    const agentId = "phase325-real-pg";
    for (const positionId of ["cross-position", "drift-position"]) {
      await store.createPosition({
        positionId,
        agentId,
        ownerAddress: owner,
        token0,
        token1,
        fee: 2_500,
        basisWei: 0n,
        basisSource: "minted",
      });
    }
    const cross = await store.createSequence({
      agentId,
      ownerAddress: owner,
      positionId: "cross-position",
      kind: "grid-shift",
      shiftCause: "cross",
    });
    const drift = await store.createSequence({
      agentId,
      ownerAddress: owner,
      positionId: "drift-position",
      kind: "grid-shift",
      shiftCause: "drift",
    });
    const quota: LpExitQuota = {
      maxExitSequencesPerDay: 1,
      minMinutesBetweenExits: 5,
      maxShiftsPerDay: 10,
      maxShiftDriftPerDay: 10,
    };
    const outcomes = await Promise.allSettled([
      store.reserveSequence(owner, agentId, cross.sequenceId, quota),
      store.reserveSequence(owner, agentId, drift.sequenceId, quota),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
    const usage = await store.quotaUsage(owner, agentId);
    assert.equal(usage.shiftLiveCount, 1);
    assert.equal((usage.shiftSettleLiveCount ?? 0) + (usage.shiftDriftLiveCount ?? 0), 1);
    await store.close();
  } finally {
    const childExit = postgresProcess === undefined || postgresProcess.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => postgresProcess!.once("exit", () => resolve()));
    if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      await command(pgCtl, ["stop", "-D", data, "-m", "fast", "-w"]).catch(() => undefined);
      await Promise.race([
        childExit,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (process.platform === "win32" && postmasterPid !== undefined && /^\d+$/u.test(postmasterPid)) {
      await command("C:\\Windows\\System32\\taskkill.exe", [
        "/PID", postmasterPid, "/T", "/F",
      ]).catch(() => undefined);
    } else if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      postgresProcess.kill("SIGTERM");
    }
    await Promise.race([
      childExit,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

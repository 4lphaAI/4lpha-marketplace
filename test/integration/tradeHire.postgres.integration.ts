/**
 * Trading hire R9.3 — real-PostgreSQL proof that the owner+nonce advisory lock
 * stays held while a separate AgentStore pool materializes the durable row.
 * This starts only a temporary local PostgreSQL process; it never touches a
 * wallet, chain, configured database, or external service.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress } from "viem";
import { PostgresAgentStore } from "../../src/store/agents.js";
import { PostgresNonceStore } from "../../src/store/nonces.js";
import { PostgresTradeSettingsStore } from "../../src/store/tradeSettings.js";
import { PostgresTradeIntentStore, type CreateTradeIntentInput } from "../../src/store/tradeIntents.js";
import { PostgresTradePositionStore } from "../../src/store/tradePositions.js";
import { createPgSqlClient } from "../../src/store/sql.js";

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${executable} exited ${code}: ${stderr}`)));
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

async function waitReady(executable: string, port: number, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`PostgreSQL exited ${process.exitCode} before ready.`);
    try {
      await command(executable, ["-h", "127.0.0.1", "-p", String(port)]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("PostgreSQL did not become ready.");
}

test("Trading R9.3: Postgres holds the nonce lock across separate AgentStore materialization", {
  timeout: 120_000,
}, async (t) => {
  const postgresBin = process.env["PHASE5_POSTGRES_BIN"]
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

  const root = await mkdtemp(join(tmpdir(), "4lpha-trade-hire-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  let postgresProcess: ChildProcess | undefined;
  let postmasterPid: string | undefined;
  try {
    await command(initdb, ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale",
      "--username=trade_hire_audit"]);
    postgresProcess = spawn(postgres, ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    await waitReady(pgIsReady, port, postgresProcess);
    postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/u, 1)[0]?.trim();

    const url = `postgresql://trade_hire_audit@127.0.0.1:${port}/postgres`;
    await t.test("worker projects and closes a real PostgreSQL trade position", async () => {
      const positions = await PostgresTradePositionStore.create(await createPgSqlClient(url));
      try {
        const owner = getAddress("0x1111111111111111111111111111111111111111");
        const token = getAddress("0x2222222222222222222222222222222222222222");
        const input = { positionId: "pg-filled-buy", agentId: "pg-trader", ownerAddress: owner,
          token, route: { hops: [], fees: [] }, entryWei: 1_799_999_999_999_999n,
          tokenAmount: 500n, fillStatus: "verified" as const, openedAt: 1_900_000_000_000,
          entryTxHash: `0x${"cc".repeat(32)}` as const };
        const event = { stage: "entry-llm" as const, code: "selected", elapsedMs: 42, model: "fixture", confidence: 92, token: input.token, reason: "Positive momentum" };
        const run = await positions.insertRun({ ownerAddress: owner, agentId: "pg-trader", dryRun: true, reason: "dry-run", events: [event] });
        assert.deepEqual((await positions.listRuns(owner, "pg-trader"))[0]?.events, [event]);
        const legacy = await positions.insertRun({ ownerAddress: owner, agentId: "pg-trader", dryRun: true, reason: "legacy" });
        assert.deepEqual(legacy.events, []);
        assert.ok(run.id);
        const opened = await positions.open(input);
        assert.equal(opened.status, "open");
        assert.equal(opened.entryWei, input.entryWei);
        assert.equal(opened.tokenAmount, 500n);
        assert.equal(opened.entryTxHash, input.entryTxHash);
        assert.equal(opened.lastSellRefusalAt, null);
        assert.equal(opened.noPriceCount, 0);
        await assert.rejects(positions.open(input), /already exists/u);
        assert.deepEqual(await positions.get(owner, "pg-trader", input.positionId), opened);
        assert.equal((await positions.listOpen(owner, "pg-trader")).length, 1);
        const closed = await positions.closePosition({ ownerAddress: owner, agentId: "pg-trader",
          positionId: input.positionId, exitWei: 2_000_000_000_000_000n,
          soldTokenAmount: 500n, exitFillStatus: "verified", reason: "llm" });
        assert.equal(closed?.status, "closed");
        assert.equal(closed?.exitWei, 2_000_000_000_000_000n);
        assert.equal((await positions.listOpen(owner, "pg-trader")).length, 0);
      } finally { await positions.close(); }
    });
    await t.test("worker trade intents survive JSONB route ordering and reject conflicting retries", async () => {
      const intents = await PostgresTradeIntentStore.create(await createPgSqlClient(url));
      try {
        const owner = getAddress("0x1111111111111111111111111111111111111111");
        const token = getAddress("0x2222222222222222222222222222222222222222");
        const hop = getAddress("0x3333333333333333333333333333333333333333");
        const routes: readonly CreateTradeIntentInput["route"][] = [
          { hops: [], fees: [] }, { hops: [], fees: [100] },
          { hops: [hop], fees: [500, 100] },
        ];
        for (const [index, route] of routes.entries()) {
          const input: CreateTradeIntentInput = { decisionId: `pg-intent-${index}`,
            idempotencyKey: `0x${"aa".repeat(32)}`, agentId: "pg-trader", ownerAddress: owner,
            side: "buy", token, route, amountWei: 2_000_000_000_000_000n,
            entryWei: 2_020_000_000_000_000n, positionId: `pg-position-${index}`, closeReason: null };
          const first = await intents.create(input);
          assert.deepEqual(first.route, route);
          assert.equal(first.state, "pending");
          assert.deepEqual(await intents.create(input), first);
          assert.deepEqual(await intents.create({ ...input,
            route: { fees: route.fees, hops: route.hops } }), first);
          const conflicts: readonly Partial<CreateTradeIntentInput>[] = [
            { idempotencyKey: `0x${"bb".repeat(32)}` }, { agentId: "other" },
            { ownerAddress: token }, { side: "sell" }, { token: hop },
            { amountWei: 1n }, { entryWei: 1n }, { positionId: "other" }, { closeReason: "llm" },
            { route: { hops: [token], fees: [100, 100] } },
          ];
          for (const conflict of conflicts) {
            await assert.rejects(intents.create({ ...input, ...conflict }), /already bound/u);
          }
          assert.deepEqual(await intents.get(owner, "pg-trader", input.decisionId), first);
        }
        assert.equal((await intents.listUnsettled(owner, "pg-trader")).length, routes.length);
      } finally { await intents.close(); }
    });
    const nonces = await PostgresNonceStore.create(await createPgSqlClient(url));
    const agents = await PostgresAgentStore.create(await createPgSqlClient(url), null, () => 1_900_000_000_000);
    const owner = getAddress("0x1111111111111111111111111111111111111111");
    const wallet = getAddress("0x2222222222222222222222222222222222222222");
    const nonce = `0x${"33".repeat(32)}`;
    const actionId = `0x${"44".repeat(32)}`;
    let releaseMaterialization = (): void => {};
    const materializationGate = new Promise<void>((resolve) => { releaseMaterialization = resolve; });
    let markLockHeld = (): void => {};
    const lockHeld = new Promise<void>((resolve) => { markLockHeld = resolve; });

    const materializer = nonces.withProvisionClaimLock(owner, nonce, async (lease) => {
      assert.equal(await lease.insert({ actionId, state: "live", acceptedAtMs: 1_900_000_000_000,
        authorityExpiresAtMs: 1_900_003_600_000 }), true);
      markLockHeld();
      await materializationGate;
      await agents.createAgent({ id: "real-pg-trade-hire", ownerAddress: owner, walletAddress: wallet,
        custodyModel: "passkey", status: "provisioning", httpRuntimeProfile: "unbound-v1" });
      assert.equal(await lease.transition(actionId, "live", "committed"), true);
    });
    await lockHeld;

    let waiterEntered = false;
    const waiter = nonces.withProvisionClaimLock(owner, nonce, async (lease) => {
      waiterEntered = true;
      const claim = await lease.read();
      const row = await agents.getAgentById("real-pg-trade-hire");
      return { claim, row };
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(waiterEntered, false, "second transaction crossed the held advisory lock");
    releaseMaterialization();
    await materializer;
    const observed = await waiter;
    assert.equal(observed.claim.kind, "provision");
    if (observed.claim.kind === "provision") assert.equal(observed.claim.claim.state, "committed");
    assert.equal(observed.row?.id, "real-pg-trade-hire");
    // The live worker joins agents and settings. Both contain owner_address
    // and updated_at; fake SQL dispatch cannot detect an ambiguous SELECT.
    const settings = await PostgresTradeSettingsStore.create(await createPgSqlClient(url));
    try {
      await settings.put({ agentId: "real-pg-trade-hire", ownerAddress: owner,
        params: { entryWei: 1n }, digest: `0x${"55".repeat(32)}` });
      assert.equal((await settings.listTradeAgentsForWorker({ limit: 1, cursor: null })).rows.length, 0);
      await agents.updateAgentStatus(owner, "real-pg-trade-hire", "armed");
      const page = await settings.listTradeAgentsForWorker({ limit: 1, cursor: null });
      assert.equal(page.rows.length, 1);
      assert.equal(page.rows[0]?.agentId, "real-pg-trade-hire");
      assert.equal(page.rows[0]?.ownerAddress, owner.toLowerCase());
      assert.deepEqual(page.rows[0]?.params, { entryWei: 1n });
      assert.equal((await settings.listTradeAgentsForWorker({ limit: 1, cursor: "real-pg-trade-hire" })).rows.length, 0);
    } finally { await settings.close(); }
    await agents.close();
    await nonces.close();
  } finally {
    const childExit = postgresProcess === undefined || postgresProcess.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => postgresProcess!.once("exit", () => resolve()));
    if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      await command(pgCtl, ["stop", "-D", data, "-m", "fast", "-w"]).catch(() => undefined);
      await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (process.platform === "win32" && postmasterPid !== undefined && /^\d+$/u.test(postmasterPid)) {
      await command("C:\\Windows\\System32\\taskkill.exe", ["/PID", postmasterPid, "/T", "/F"])
        .catch(() => undefined);
    } else if (postgresProcess !== undefined && postgresProcess.exitCode === null) {
      postgresProcess.kill("SIGTERM");
    }
    await Promise.race([childExit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
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

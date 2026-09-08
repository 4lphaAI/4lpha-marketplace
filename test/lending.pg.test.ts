/**
 * The lending plane's REAL-PostgreSQL acceptance pass (AUDIT P1, closing B-B1).
 *
 * ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════
 *
 * `PostgresLendingGuardStore.claimAction` shipped with `last_action_at_ms <=
 * $3 - $4` and two UNTYPED parameters. Real PostgreSQL answers that with
 * `operator is not unique: unknown - unknown`, so in every deployment — which
 * is every non-rehearsal run, because `buildLendingServerDeps` requires
 * `DATABASE_URL` — the claim threw INSIDE the fence, every cycle reported
 * `error`/`transport`, and NO RESCUE COULD EVER BE SUBMITTED while the arm and
 * the retire (which do not claim) kept working. The guard looked armed and did
 * nothing.
 *
 * Nothing offline could see it: `test/support/fakeSql.ts` dispatches on the
 * statement tag and NEVER PARSES THE SQL, so the mutation "delete the cooldown
 * predicate" survived 64 green tests. That is the ERC-8004 `attname::text`
 * lesson (`MARKETPLACE-ERC8004-PG-CATALOG-REVIEW.md`) in this store, and the
 * only instrument that catches this class is a real server.
 *
 * ═══ WHAT IT DRIVES ═══════════════════════════════════════════════════════
 *
 * EVERY lending statement, in one session, against one server: the DDL,
 * `putInitialIfAbsentOrSame`, `get`, `listForWorker`, `armCas`, `finishArm`,
 * `setHold` (set AND clear), `beginRetire`, `finishRetire` (retired / partial /
 * held / rolled-back), `close`, `claimAction` (the CLAIMED and the COOLDOWN
 * branch), `restoreClaim` (restored AND superseded), `recordRescue`,
 * `listRescues`, `chargeAction`, `usageSince`, `putSnapshot`, `getSnapshot`,
 * `withLendingFence`, and the two namespace-parameterized tables —
 * `lending_settings` and `lending_observations`.
 *
 * ═══ HOW IT CONNECTS ══════════════════════════════════════════════════════
 *
 * `DATABASE_URL` when the environment already exports one; otherwise a
 * THROWAWAY local server started exactly the way
 * `test/phase3.25.postgresConcurrency.test.ts` starts one, on a free port,
 * under a temp directory that is removed afterwards. When neither is
 * available the test SKIPS — it never fails for want of a database, and it
 * never connects to anything but a loopback server it started itself.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";

import {
  PostgresLendingGuardStore,
  type LendingGuardStore,
} from "../src/store/lendingGuards.js";
import { PostgresVenusSettingsStore } from "../src/store/venusSettings.js";
import { PostgresVenusObservationStore } from "../src/store/venusObservations.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { submitLendingBatch } from "../src/lending/execute.js";
import type { WalletProvider } from "../src/core/types.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const AGENT = "lending-pg-agent";
const GUARDED = getAddress("0x00000000000000000000000000000000000000a9");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const V_USDT = getAddress("0xfD5840Cd36d94D7229439859C0112a4185BC0255");
const E18 = 10n ** 18n;
const DIGEST =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

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
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function waitReady(
  executable: string,
  port: number,
  child: ChildProcess,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`PostgreSQL exited ${child.exitCode} before becoming ready.`);
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

type Server = {
  readonly url: string;
  stop(): Promise<void>;
};

/** An already-exported `DATABASE_URL`, a throwaway local server, or `null`. */
async function server(): Promise<Server | null> {
  const configured = process.env["DATABASE_URL"]?.trim();
  if (configured !== undefined && configured !== "") {
    return { url: configured, async stop() { /* not ours to stop */ } };
  }
  const bin = process.env["LENDING_POSTGRES_BIN"]
    ?? process.env["PHASE325_POSTGRES_BIN"]
    ?? process.env["PHASE5_POSTGRES_BIN"]
    ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const win = process.platform === "win32";
  const initdb = join(bin, win ? "initdb.exe" : "initdb");
  const postgres = join(bin, win ? "postgres.exe" : "postgres");
  const pgCtl = join(bin, win ? "pg_ctl.exe" : "pg_ctl");
  const pgIsReady = join(bin, win ? "pg_isready.exe" : "pg_isready");
  try {
    await Promise.all([access(initdb), access(postgres), access(pgCtl), access(pgIsReady)]);
  } catch {
    return null;
  }
  const root = await mkdtemp(join(tmpdir(), "4lpha-lending-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  await command(initdb, [
    "-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale",
    "--username=lending_audit",
  ]);
  const child = spawn(
    postgres,
    ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"],
    { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
  );
  await waitReady(pgIsReady, port, child);
  const postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8"))
    .split(/\r?\n/u, 1)[0]?.trim();
  return {
    url: `postgresql://lending_audit@127.0.0.1:${port}/postgres`,
    async stop() {
      try {
        await command(pgCtl, ["-D", data, "-m", "immediate", "stop"]);
      } catch {
        if (postmasterPid !== undefined) {
          try { process.kill(Number(postmasterPid), "SIGKILL"); } catch { /* gone */ }
        }
        child.kill("SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Drop every table this test creates, so a shared `DATABASE_URL` is left clean. */
async function dropAll(sql: SqlClient): Promise<void> {
  await sql.query(
    `drop table if exists lending_guards, lending_rescues, lending_actions,
       lending_snapshots, lending_settings, lending_observations cascade`,
  );
}

test("AUDIT P1 — every lending statement executes on a REAL PostgreSQL", {
  timeout: 180_000,
}, async (t) => {
  const running = await server();
  if (running === null) {
    t.skip(
      "No DATABASE_URL is exported and no local PostgreSQL binaries were found "
      + "(set DATABASE_URL or LENDING_POSTGRES_BIN). The lending SQL is NOT proven by this run.",
    );
    return;
  }

  const sql = await createPgSqlClient(running.url);
  try {
    await dropAll(sql);

    /* ---- DDL ---------------------------------------------------------- */
    let clock = 1_000_000;
    const store: LendingGuardStore = await PostgresLendingGuardStore.create(
      sql, () => clock,
    );
    const settings = await PostgresVenusSettingsStore.create(sql, () => clock, "lending");
    const observations = await PostgresVenusObservationStore.create(
      sql, () => clock, "lending",
    );

    // A fake SQL client never serializes Date parameters. Exercise the actual
    // submission seam against pg before claiming the Lending write path works.
    const journal = await PostgresExecutionJournal.create(sql, () => clock);
    const journalAgentId = `${AGENT}-journal-${Date.now()}`;
    const agents = new MemoryAgentStore(null, () => clock);
    await agents.createAgent({
      id: journalAgentId, ownerAddress: OWNER, walletAddress: GUARDED, custodyModel: "passkey",
      sessionFacts: {
        spec: { allowedCalls: [], spendCaps: [], expiresAt: 9_999_999_999 },
        permissions: { calls: [], spend: [] },
        publicKey: `0x04${"ab".repeat(64)}` as Hex, expiry: 9_999_999_999,
      },
    });
    // Public deterministic test fixture, used only with the fake provider below.
    await agents.putAgentSessionKey(OWNER, journalAgentId, `0x${"7d".repeat(32)}` as Hex);
    const agent = (await agents.getAgent(OWNER, journalAgentId))!;
    let executions = 0;
    const provider = {
      restoreSession: () => ({ sessionId: "local-test-session" }),
      preflightExecute: async () => undefined,
      executeViaSession: async () => {
        executions += 1;
        return { status: "CONFIRMED", transactionHash: `0x${"ab".repeat(32)}`, callsId: `0x${"cd".repeat(32)}` };
      },
    } as unknown as WalletProvider;
    const submission = { agent, decisionId: `lending:${journalAgentId}:arm:1`, calls: [], nativeSpendWei: 1n };
    try {
      const submitted = await submitLendingBatch({ agentStore: agents, journal, provider }, submission);
      assert.equal(submitted.status, "completed");
      assert.equal(executions, 1, "the valid timestamp allows exactly one fake submission");
      const stored = await sql.query<{ state: string }>(
        "select state from execution_journal where idempotency_key = $1", [submitted.journalKey],
      );
      assert.equal(stored.rows[0]?.state, "COMMITTED");
      const duplicate = await submitLendingBatch({ agentStore: agents, journal, provider }, submission);
      assert.equal(duplicate.status, "rolled-back");
      assert.equal(duplicate.code, "refused-before-submit");
      assert.equal(executions, 1, "the atomic created guard still refuses a duplicate");
    } catch (error) {
      assert.equal(executions, 0, "timestamp failure must precede every fake submission");
      throw error;
    } finally {
      await sql.query("delete from execution_journal where agent_id = $1", [journalAgentId]);
    }

    /* ---- putInitial / get / cross-tenant ------------------------------ */
    const created = await store.putInitialIfAbsentOrSame({
      agentId: AGENT, ownerAddress: OWNER, guardedAccount: GUARDED,
      reserveToken: USDT, debtMarkets: [V_USDT],
      reserveCapWei: 1_000n * E18, reserveBps: 2_000,
    });
    assert.equal(created.kind, "created");
    const same = await store.putInitialIfAbsentOrSame({
      agentId: AGENT, ownerAddress: OWNER, guardedAccount: GUARDED,
      reserveToken: USDT, debtMarkets: [V_USDT],
      reserveCapWei: 1_000n * E18, reserveBps: 2_000,
    });
    assert.equal(same.kind, "same");
    const conflicting = await store.putInitialIfAbsentOrSame({
      agentId: AGENT, ownerAddress: OWNER, guardedAccount: OTHER,
      reserveToken: USDT, debtMarkets: [V_USDT],
      reserveCapWei: 1_000n * E18, reserveBps: 2_000,
    });
    assert.equal(conflicting.kind, "conflict", "guarded_account is immutable");
    assert.equal(await store.get(OTHER, AGENT), null, "owner-scoped");
    const seeded = await store.get(OWNER, AGENT);
    assert.equal(seeded?.status, "provisioning-guard");
    assert.equal(seeded?.debtMarkets.length, 1, "jsonb round-trips the market list");

    /* ---- armCas / finishArm / listForWorker --------------------------- */
    const armed = await store.armCas({
      ownerAddress: OWNER, agentId: AGENT, expectedRowVersion: seeded!.rowVersion,
      budgetWei: 5n * 10n ** 17n, reserveBps: 2_000,
      supplyNativeWei: 4n * 10n ** 17n, reserveNativeWei: 10n ** 17n,
      mintUsdtWei: 240n * E18, preArmVUsdtWei: 7n, preArmExchangeRate: 2n * 10n ** 26n,
      armJournalKey: `${AGENT}:arm:1`,
    });
    assert.equal(armed.kind, "ok");
    assert.equal(armed.kind === "ok" ? armed.record.status : "", "arming");
    const scannedArming = await store.listForWorker();
    assert.equal(scannedArming.length, 1);

    const finished = await store.finishArm({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: armed.kind === "ok" ? armed.record.rowVersion : 0,
      outcome: "armed", armBlock: 45_000_000n,
      armTxHash: `0x${"ab".repeat(32)}` as Hex,
    });
    assert.equal(finished.kind, "ok");
    assert.equal(finished.kind === "ok" ? finished.record.armBlock : null, 45_000_000n);

    /* ---- setHold, then CLEAR it (AUDIT C-M1's write path) ------------- */
    const held = await store.setHold({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: finished.kind === "ok" ? finished.record.rowVersion : 0,
      hold: "account-too-complex",
    });
    assert.equal(held.kind === "ok" ? held.record.status : "", "held");
    const cleared = await store.setHold({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: held.kind === "ok" ? held.record.rowVersion : 0,
      hold: null,
    });
    assert.equal(cleared.kind === "ok" ? cleared.record.status : "", "armed");
    assert.equal(cleared.kind === "ok" ? cleared.record.hold : "x", null);
    assert.equal(
      cleared.kind === "ok" ? cleared.record.armBlock : null, 45_000_000n,
      "FIXREVIEW F1: `coalesce(arm_block, $7::numeric)` with a null $7 leaves it alone",
    );
    /* ---- FIXREVIEW F1: the clear RECORDS a block when there is none ---- */
    const noBlock = await store.setHold({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: cleared.kind === "ok" ? cleared.record.rowVersion : 0,
      hold: "arm-unknown",
    });
    const recorded = await store.setHold({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: noBlock.kind === "ok" ? noBlock.record.rowVersion : 0,
      hold: null, armBlock: 99_000_000n,
    });
    assert.equal(
      recorded.kind === "ok" ? recorded.record.armBlock : null, 45_000_000n,
      "one way: an existing block is never overwritten, on real PostgreSQL too",
    );

    /* ---- THE CLAIM (B-B1). The whole reason this file exists. --------- */
    const claim1 = await store.claimAction({
      ownerAddress: OWNER, agentId: AGENT, nowMs: 2_000_000,
      minSecondsBetweenActions: 300,
    });
    assert.equal(claim1.kind, "claimed", "B-B1: the claim must EXECUTE on real PostgreSQL");
    assert.equal(claim1.kind === "claimed" ? claim1.actionSeq : 0, 1);

    // The COOLDOWN branch — the predicate the untyped arithmetic lived in.
    const claim2 = await store.claimAction({
      ownerAddress: OWNER, agentId: AGENT, nowMs: 2_000_000 + 299_000,
      minSecondsBetweenActions: 300,
    });
    assert.equal(claim2.kind, "cooldown", "299 s is inside a 300 s floor");
    assert.equal(claim2.kind === "cooldown" ? claim2.elapsedSec : -1, 299);

    // AUDIT C-H1's give-back, and its CAS predicate, on the real server.
    const restored = await store.restoreClaim({
      ownerAddress: OWNER, agentId: AGENT,
      expectedActionSeq: 1, previousLastActionAtMs: null,
    });
    assert.equal(restored.kind, "restored");
    assert.equal((await store.get(OWNER, AGENT))?.lastActionAtMs, null);
    const claim3 = await store.claimAction({
      ownerAddress: OWNER, agentId: AGENT, nowMs: 2_000_100,
      minSecondsBetweenActions: 300,
    });
    assert.equal(claim3.kind, "claimed", "a refusal never starves the next rescue");
    const superseded = await store.restoreClaim({
      ownerAddress: OWNER, agentId: AGENT,
      expectedActionSeq: 1, previousLastActionAtMs: null,
    });
    assert.equal(superseded.kind, "superseded");
    assert.equal((await store.get(OWNER, AGENT))?.lastActionAtMs, 2_000_100);

    /* ---- the fence: the two-argument advisory lock -------------------- */
    const order: string[] = [];
    await Promise.all([
      store.withLendingFence(OWNER, AGENT, async (fence) => {
        order.push("a:in");
        assert.notEqual(await fence.get(), null, "the fence reads inside its own tx");
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push("a:out");
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await store.withLendingFence(OWNER, AGENT, async (fence) => {
          order.push("b:in");
          const claimed = await fence.claim({
            nowMs: 3_000_000, minSecondsBetweenActions: 300,
          });
          assert.equal(claimed.kind, "claimed", "the claim runs on the LOCK's tx (B-L9)");
          order.push("b:out");
        });
      })(),
    ]);
    assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"],
      "pg_advisory_xact_lock(classid, hashtext(key)) serializes the two fences");

    /* ---- telemetry: rescues, actions, usage --------------------------- */
    await store.recordRescue({
      rescueId: "rescue-1", agentId: AGENT, ownerAddress: OWNER,
      journalKey: `${AGENT}:lending:1`, market: V_USDT, amountWei: 12n * E18,
      hfBefore: 11n * 10n ** 17n, hfAfter: null, achievedHf: 13n * 10n ** 17n,
      txHash: `0x${"cd".repeat(32)}` as Hex, effect: "changed", partial: true,
      conditions: ["reserve-low", "insufficient-reserve"],
    });
    await store.recordRescue({
      rescueId: "rescue-1", agentId: AGENT, ownerAddress: OWNER,
      journalKey: "duplicate", market: V_USDT, amountWei: 1n,
      hfBefore: null, hfAfter: null, achievedHf: null, txHash: null,
      effect: "unverified", partial: false, conditions: [],
    });
    const rescues = await store.listRescues(OWNER, AGENT, 50);
    assert.equal(rescues.length, 1, "insert is idempotent by rescue_id");
    assert.equal(rescues[0]?.amountWei, 12n * E18, "numeric round-trips exactly");
    assert.deepEqual(rescues[0]?.conditions, ["reserve-low", "insufficient-reserve"]);
    assert.equal((await store.listRescues(OTHER, AGENT, 50)).length, 0);

    await store.chargeAction({
      ownerAddress: OWNER, agentId: AGENT, actionId: "a1",
      kind: "rescue", chargedAtMs: 2_000_000,
    });
    await store.chargeAction({
      ownerAddress: OWNER, agentId: AGENT, actionId: "a2",
      kind: "arm", chargedAtMs: 2_000_001,
    });
    const usage = await store.usageSince(OWNER, AGENT, 1_000_000);
    assert.equal(usage.rescues, 1, "only `rescue` rows are counted");
    assert.equal(usage.lastRescueAtMs, 2_000_000);

    /* ---- the view snapshot -------------------------------------------- */
    await store.putSnapshot({
      agentId: AGENT, ownerAddress: OWNER, blockNumber: 45_000_123n,
      observedAtMs: 2_500_000, snapshot: { version: 1, conditions: [] },
    });
    const snapshot = await store.getSnapshot(OWNER, AGENT);
    assert.equal(snapshot?.blockNumber, 45_000_123n);
    assert.deepEqual(snapshot?.snapshot, { version: 1, conditions: [] });
    assert.equal(await store.getSnapshot(OTHER, AGENT), null);

    /* ---- the namespaced settings and observation tables ---------------- */
    const params = { triggerHf: "1200000000000000000" };
    await settings.put({
      agentId: AGENT, ownerAddress: OWNER, params, digest: DIGEST,
    });
    const settingsRow = await settings.get(OWNER, AGENT);
    assert.deepEqual(settingsRow?.params, params);
    assert.equal(settingsRow?.digest, DIGEST);
    assert.equal(await settings.get(OTHER, AGENT), null);
    await assert.rejects(
      settings.put({ agentId: AGENT, ownerAddress: OTHER, params, digest: DIGEST }),
      /another owner/u,
      "the owner predicate rides on the UPDATE arm of the upsert",
    );

    await observations.put({
      ownerAddress: OWNER, agentId: AGENT, kind: "rescue",
      observation: {
        blockNumber: 45_000_123n, evaluatedAtMs: 2_500_000,
        healthFactor: 11n * 10n ** 17n, shortfall: false, breach: true,
        consecutive: 1, settingsDigest: DIGEST, collateral: 100n * E18, debt: 90n * E18,
      },
    });
    const observed = await observations.get(OWNER, AGENT, "rescue");
    assert.equal(observed?.consecutive, 1);
    assert.equal(observed?.blockNumber, 45_000_123n, "bigints survive jsonb");
    assert.equal(await observations.get(OTHER, AGENT, "rescue"), null);
    await observations.delete(OWNER, AGENT, "rescue");
    assert.equal(await observations.get(OWNER, AGENT, "rescue"), null);

    /* ---- retire: begin, partial, retry, rolled-back, held, retired ----- */
    const began = await store.beginRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: (await store.get(OWNER, AGENT))!.rowVersion,
    });
    assert.equal(began.kind === "ok" ? began.record.status : "", "retiring");
    const partial = await store.finishRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: began.kind === "ok" ? began.record.rowVersion : 0,
      outcome: "partial",
    });
    assert.equal(partial.kind === "ok" ? partial.record.status : "", "retiring");
    // AUDIT B-H1: the worker SEES a retiring row, and the gate re-enters it.
    assert.deepEqual(
      (await store.listForWorker()).map((row) => row.status), ["retiring"],
    );
    const retry = await store.beginRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: partial.kind === "ok" ? partial.record.rowVersion : 0,
    });
    assert.equal(retry.kind, "ok");
    const rolledBack = await store.finishRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: retry.kind === "ok" ? retry.record.rowVersion : 0,
      outcome: "rolled-back", restore: { status: "held", hold: "arm-unknown" },
    });
    assert.equal(rolledBack.kind === "ok" ? rolledBack.record.status : "", "held");
    assert.equal(rolledBack.kind === "ok" ? rolledBack.record.hold : "", "arm-unknown");

    const began2 = await store.beginRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: rolledBack.kind === "ok" ? rolledBack.record.rowVersion : 0,
    });
    const heldRetire = await store.finishRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: began2.kind === "ok" ? began2.record.rowVersion : 0,
      outcome: "held", hold: "retire-unknown",
    });
    assert.equal(heldRetire.kind === "ok" ? heldRetire.record.hold : "", "retire-unknown");

    const began3 = await store.beginRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: heldRetire.kind === "ok" ? heldRetire.record.rowVersion : 0,
    });
    const retired = await store.finishRetire({
      ownerAddress: OWNER, agentId: AGENT,
      expectedRowVersion: began3.kind === "ok" ? began3.record.rowVersion : 0,
      outcome: "retired",
    });
    assert.equal(retired.kind === "ok" ? retired.record.status : "", "retired");
    assert.equal(retired.kind === "ok" ? retired.record.closeReason : "", "retired");
    assert.deepEqual(await store.listForWorker(), [], "terminal rows leave the scan");

    /* ---- close, on a second agent so `retired` stays terminal ---------- */
    const second = await store.putInitialIfAbsentOrSame({
      agentId: `${AGENT}-2`, ownerAddress: OWNER, guardedAccount: GUARDED,
      reserveToken: USDT, debtMarkets: [V_USDT],
      reserveCapWei: 1_000n * E18, reserveBps: 2_000,
    });
    assert.equal(second.kind, "created");
    // FIXREVIEW F4: `close` accepts the DERIVED sources only, and
    // `provisioning-guard` is not one of them — nothing drives that edge. The
    // R3.4 arming door is what this statement is for, so the row is armed
    // first, exactly as the door finds it.
    const secondVersion = second.kind === "created" ? second.record.rowVersion : 0;
    const refusedClose = await store.close({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: secondVersion,
      closeReason: "arm-never-submitted",
    });
    assert.equal(
      refusedClose.kind, "conflict",
      "a provisioning-guard row is not a source of `closed` on any surface",
    );
    const secondArming = await store.armCas({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: secondVersion,
      budgetWei: E18, reserveBps: 2_000, supplyNativeWei: 8n * 10n ** 17n,
      reserveNativeWei: 2n * 10n ** 17n, mintUsdtWei: 500n * E18,
      preArmVUsdtWei: 0n, preArmExchangeRate: E18, armJournalKey: "k2",
    });
    assert.equal(secondArming.kind, "ok");
    const closed = await store.close({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: secondArming.kind === "ok" ? secondArming.record.rowVersion : 0,
      closeReason: "arm-never-submitted",
    });
    assert.equal(closed.kind === "ok" ? closed.record.status : "", "closed");
    // A stale CAS conflicts rather than writing.
    const stale = await store.close({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: secondArming.kind === "ok" ? secondArming.record.rowVersion : 0,
      closeReason: "recovered-by-owner",
    });
    assert.equal(stale.kind, "conflict");

    /* ---- FIXREVIEW F1: the `arm-unknown` shape, which has NO block ----- */
    //
    // The whole population C-M2 was about: an arm that came back UNKNOWN never
    // reached `finishArm`'s `armed` branch, so `arm_block` is null and the
    // clear is the ONLY writer that can fill it. This drives the
    // `coalesce(arm_block, $7::numeric)` write on real PostgreSQL — the fake
    // SQL client restates the predicate by hand and can never see a cast.
    const armed2 = await store.armCas({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: closed.kind === "ok" ? closed.record.rowVersion : 0,
      budgetWei: 10n ** 17n, reserveBps: 2_000, supplyNativeWei: 10n ** 17n,
      reserveNativeWei: 0n, mintUsdtWei: 1n, preArmVUsdtWei: 0n,
      preArmExchangeRate: E18, armJournalKey: `${AGENT}-2:arm`,
    });
    const ambiguous = await store.finishArm({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: armed2.kind === "ok" ? armed2.record.rowVersion : 0,
      outcome: "held", hold: "arm-unknown",
    });
    assert.equal(ambiguous.kind === "ok" ? ambiguous.record.armBlock : 1n, null);
    const proven = await store.setHold({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: ambiguous.kind === "ok" ? ambiguous.record.rowVersion : 0,
      hold: null, armBlock: 45_000_777n,
    });
    assert.equal(proven.kind === "ok" ? proven.record.status : "", "armed");
    assert.equal(
      proven.kind === "ok" ? proven.record.armBlock : null, 45_000_777n,
      "FIXREVIEW F1: without this write §6.2 is unreachable for every ambiguous arm",
    );
    assert.equal(
      proven.kind === "ok" ? proven.record.armBlockSource : null, "post-arm-read",
      "FIXREVIEW F7: `case when arm_block is null then $8::text …` on real PostgreSQL",
    );

    /* ---- FIXREVIEW F5: the hold-clear counter, on real PostgreSQL ------ */
    //
    // `lendingGuards.noteHoldClear` is a statement of its own, and a statement
    // no test executes is a statement PostgreSQL has never parsed — the B-B1
    // lesson. It also proves the `hold_clear_consecutive` migration landed:
    // reading a column an `alter table … add column if not exists` forgot would
    // fail here and nowhere else.
    const heldAgain = await store.setHold({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: proven.kind === "ok" ? proven.record.rowVersion : 0,
      hold: "account-too-complex",
    });
    assert.equal(
      heldAgain.kind === "ok" ? heldAgain.record.holdClearConsecutive : -1, 0,
      "setting a hold restarts the count",
    );
    const progressed = await store.noteHoldClearProgress({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: heldAgain.kind === "ok" ? heldAgain.record.rowVersion : 0,
      consecutive: 1,
    });
    assert.equal(progressed.kind, "ok");
    assert.equal(
      progressed.kind === "ok" ? progressed.record.status : "", "held",
      "the progress write moves NO status",
    );
    assert.equal(
      progressed.kind === "ok" ? progressed.record.holdClearConsecutive : -1, 1,
    );
    const clearedCount = await store.setHold({
      ownerAddress: OWNER, agentId: `${AGENT}-2`,
      expectedRowVersion: progressed.kind === "ok" ? progressed.record.rowVersion : 0,
      hold: null,
    });
    assert.equal(
      clearedCount.kind === "ok" ? clearedCount.record.holdClearConsecutive : -1, 0,
      "and clearing one restarts it too",
    );

    /* ---- FIXREVIEW F6: an ABORTING fence takes its writes with it ------ */
    //
    // B-L9 routed `get` and `claim` onto the lock's transaction; `armCas` and
    // `beginRetire` stayed on the POOL, so a fence body that threw left the
    // admission standing while its claim rolled back. This is the assertion
    // that can see it — the memory twin has no transaction at all, and the
    // offline fake commits everything.
    const beforeAbort = (await store.get(OWNER, `${AGENT}-2`))!;
    assert.equal(beforeAbort.status, "armed");
    await assert.rejects(
      store.withLendingFence(OWNER, `${AGENT}-2`, async (fence) => {
        const inside = (await fence.get())!;
        const retiring = await fence.beginRetire({
          expectedRowVersion: inside.rowVersion,
        });
        assert.equal(retiring.kind, "ok", "the CAS lands INSIDE the transaction");
        assert.equal(retiring.kind === "ok" ? retiring.record.status : "", "retiring");
        throw new Error("the fence aborts after its admission CAS");
      }),
      /the fence aborts after its admission CAS/u,
    );
    const afterAbort = (await store.get(OWNER, `${AGENT}-2`))!;
    assert.equal(
      afterAbort.status, "armed",
      "FIXREVIEW F6: an aborting fence must not leave a `retiring` row standing",
    );
    assert.equal(
      afterAbort.rowVersion, beforeAbort.rowVersion,
      "and it must not have consumed a row version either",
    );

    // The same for the ARM's admission CAS, which is the one that carries the
    // money sizing onto the row — on a third agent, so it can be exercised
    // from `provisioning-guard` where the arm actually finds it.
    const third = await store.putInitialIfAbsentOrSame({
      agentId: `${AGENT}-3`, ownerAddress: OWNER, guardedAccount: GUARDED,
      reserveToken: USDT, debtMarkets: [V_USDT],
      reserveCapWei: 1_000n * E18, reserveBps: 2_000,
    });
    const thirdVersion = third.kind === "created" ? third.record.rowVersion : 0;
    await assert.rejects(
      store.withLendingFence(OWNER, `${AGENT}-3`, async (fence) => {
        const inside = (await fence.get())!;
        const arming = await fence.armCas({
          expectedRowVersion: inside.rowVersion,
          budgetWei: E18, reserveBps: 2_000, supplyNativeWei: 8n * 10n ** 17n,
          reserveNativeWei: 2n * 10n ** 17n, mintUsdtWei: 500n * E18,
          preArmVUsdtWei: 0n, preArmExchangeRate: E18,
          armJournalKey: `${AGENT}-3:arm`,
        });
        assert.equal(arming.kind === "ok" ? arming.record.status : "", "arming");
        assert.equal(
          arming.kind === "ok" ? arming.record.budgetWei : 0n, E18,
          "the sizing is written inside the transaction",
        );
        throw new Error("the arm fence aborts after admission");
      }),
      /the arm fence aborts after admission/u,
    );
    const thirdAfter = (await store.get(OWNER, `${AGENT}-3`))!;
    assert.equal(
      thirdAfter.status, "provisioning-guard",
      "FIXREVIEW F6: an aborting arm fence leaves no `arming` row and no budget",
    );
    assert.equal(thirdAfter.budgetWei, 0n);
    assert.equal(thirdAfter.rowVersion, thirdVersion);

    /* ---- FIXREVIEW F3: `lastActionId` -------------------------------- */
    assert.equal(await store.lastActionId(OWNER, `${AGENT}-2`, "retire"), null);
    await store.chargeAction({
      ownerAddress: OWNER, agentId: `${AGENT}-2`, actionId: "r1",
      kind: "retire", chargedAtMs: 3_000_000,
    });
    await store.chargeAction({
      ownerAddress: OWNER, agentId: `${AGENT}-2`, actionId: "r2",
      kind: "retire", chargedAtMs: 3_000_009,
    });
    assert.equal(
      await store.lastActionId(OWNER, `${AGENT}-2`, "retire"), "r2",
      "newest first — the retire the `retire-unknown` hold is about",
    );
    assert.equal(await store.lastActionId(OTHER, `${AGENT}-2`, "retire"), null);
    // Leave the scan empty for whatever runs after this. The row version is
    // RE-READ rather than carried from `proven`: the F5/F6 blocks above moved
    // it, and a CAS on a remembered version is how a conditional write quietly
    // becomes a no-op.
    const armedRow = await store.get(OWNER, `${AGENT}-2`);
    if (armedRow !== null) {
      await store.close({
        ownerAddress: OWNER, agentId: `${AGENT}-2`,
        expectedRowVersion: armedRow.rowVersion, closeReason: "recovered-by-owner",
      });
    }

    clock += 1;
    await dropAll(sql);
  } finally {
    await sql.close();
    await running.stop();
  }
});

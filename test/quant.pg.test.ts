/**
 * The quant store's REAL-PostgreSQL acceptance pass (QUANT-GRID BC31, and
 * REVIEW7 condition 5).
 *
 * ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════
 *
 * `PostgresLendingGuardStore.claimAction` shipped with `last_action_at_ms <=
 * $3 - $4` and two UNTYPED parameters. Real PostgreSQL answers that with
 * `operator is not unique: unknown - unknown`, so no rescue could ever be
 * submitted while the guard looked armed. NOTHING OFFLINE COULD SEE IT:
 * `test/support/fakeSql.ts` dispatches on a statement tag and never parses SQL.
 *
 * That is why the quant store has NO fake-SQL twin at all (a deliberate
 * departure, recorded in the build report): twenty-five hand-restated
 * predicates with zero executed coverage is the hazard, not the mitigation.
 * This file is the mitigation — EVERY statement `src/store/quantJobs.ts`
 * issues, executed against a real server, in one session.
 *
 * ═══ WHAT IT DRIVES ═══════════════════════════════════════════════════════
 *
 * The DDL and its additive migrations; `discoverJob`, `updateJobWire`,
 * `replaceEnvelope`, `admitJob` (win AND conflict), `getJob`, `listJobs`,
 * `listWorkableJobs`, `setJobStatus`, `listLevels`, `insertIntent` (win AND
 * the blocked/stale conflicts), `markActionSubmitted`, `abortIntent`,
 * `setActionState`, `settleAction` (settle, idempotent no-op, and the
 * OWNERSHIP conflict), `retireLevel`, `openEpoch`, `currentEpoch`,
 * `recordObservation` + its trim, `markStaleObservation`, `listRecentBuys`,
 * `listNonTerminalActions`, `recordIndexerTrades`, `listIndexerTrades`,
 * `recordReport`, `listReports`, `recordRun`, and `withQuantFence`.
 *
 * ═══ HOW IT CONNECTS ══════════════════════════════════════════════════════
 *
 * An already-exported `DATABASE_URL`, otherwise a THROWAWAY local server on a
 * free port under a temp directory that is removed afterwards. When neither is
 * available the test SKIPS LOUDLY — it never fails for want of a database, and
 * it never connects to anything but a loopback server it started itself. A
 * skipped run means the quant SQL is UNPROVEN, and the skip says so.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, type Hex } from "viem";

import { PostgresQuantJobStore } from "../src/store/quantJobs.js";
import { PostgresExecutionJournal } from "../src/store/journal.js";
import { createPgSqlClient, type SqlClient } from "../src/store/sql.js";
import {
  QUANT_ROUTER_56, QUANT_STRATEGY_DEFAULTS, QUANT_U_56,
  QUANT_U_WBNB_PAIR_56, QUANT_WBNB_56,
} from "../src/quant/config.js";
import { recoverUnsettledActions } from "../src/quant/reconcile.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import { withStaleActionSnapshot } from "./support/quantStale.js";

const U = 10n ** 18n;
const JOB = "quant-pg-job";
const OTHER_JOB = "quant-pg-job-2";
const WALLET = getAddress("0x9BB0aB9dCEF83F0b39a4bE3EBE7a1c9D6d5c1111");
const KEY = `0x04${"ab".repeat(64)}` as Hex;
const DIGEST = `0x${"11".repeat(32)}` as Hex;
const TX = `0x${"ee".repeat(32)}` as Hex;

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
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

async function waitReady(executable: string, port: number, child: ChildProcess): Promise<void> {
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

type Server = { readonly url: string; stop(): Promise<void> };

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
  const root = await mkdtemp(join(tmpdir(), "4lpha-quant-pg-"));
  const data = join(root, "data");
  const port = await freePort();
  await command(initdb, [
    "-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale", "--username=quant_audit",
  ]);
  const child = spawn(
    postgres, ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"],
    { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
  );
  await waitReady(pgIsReady, port, child);
  const postmasterPid = (await readFile(join(data, "postmaster.pid"), "utf8"))
    .split(/\r?\n/u, 1)[0]?.trim();
  return {
    url: `postgresql://quant_audit@127.0.0.1:${port}/postgres`,
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
    `drop table if exists quant_jobs, quant_levels, quant_actions,
       quant_receipt_ownership, quant_epochs, quant_observations,
       quant_indexer_trades, quant_reports, quant_runs cascade`,
  );
}

test("BC31 — every quant statement executes on a REAL PostgreSQL", {
  timeout: 180_000,
}, async (t) => {
  const running = await server();
  if (running === null) {
    t.skip(
      "No DATABASE_URL is exported and no local PostgreSQL binaries were found "
      + "(set DATABASE_URL or LENDING_POSTGRES_BIN). THE QUANT SQL IS NOT PROVEN BY "
      + "THIS RUN: the offline suites exercise the store's semantics, never its "
      + "statements, and the class of defect that matters (parameter typing, casts, "
      + "predicate drift) is invisible to `test/support/fakeSql.ts` by construction.",
    );
    return;
  }

  const sql = await createPgSqlClient(running.url);
  try {
    await dropAll(sql);

    /* ---- DDL + migrations (running create twice must be idempotent) ------ */
    let clock = 1_000_000;
    const store = await PostgresQuantJobStore.create(sql, () => clock);
    await PostgresQuantJobStore.create(sql, () => clock);

    /* ---- discover / updateWire / replaceEnvelope ------------------------- */
    const discovered = await store.discoverJob({
      quantJobId: JOB, envelopeId: "env-1", envelopeJson: '{"a":1}', nowMs: clock,
    });
    assert.equal(discovered.status, "discovered");
    assert.equal(discovered.envelopeJson, '{"a":1}');
    // Idempotent: a second sighting of the same envelope must not duplicate.
    await store.discoverJob({
      quantJobId: JOB, envelopeId: "env-1", envelopeJson: '{"a":1}', nowMs: clock,
    });
    assert.equal((await store.listJobs()).length, 1);

    await store.replaceEnvelope(JOB, '{"a":2}', clock);
    assert.equal((await store.getJob(JOB))?.envelopeJson, '{"a":2}');

    const wired = await store.updateJobWire({
      quantJobId: JOB, strategyId: "strategy-1", tradingWallet: WALLET,
      allocationUWei: 30n * U, dailyCapUWei: 40n * U, termDays: 30,
      startedAtMs: clock, endsAtMs: clock + 86_400_000,
      sessionExpiresAtMs: clock + 86_400_000, revokedAtMs: null, nowMs: clock,
    });
    assert.equal(wired?.allocationUWei, 30n * U);
    assert.equal(wired?.tradingWallet, WALLET);
    assert.equal(wired?.termDays, 30);
    assert.equal(await store.updateJobWire({
      quantJobId: "absent", strategyId: "s", tradingWallet: WALLET,
      allocationUWei: 0n, dailyCapUWei: 0n, termDays: 1,
      startedAtMs: null, endsAtMs: null, sessionExpiresAtMs: null,
      revokedAtMs: null, nowMs: clock,
    }), null);

    /* ---- admit (win) + the write-once level insert ----------------------- */
    const admitted = await store.admitJob({
      quantJobId: JOB, expectedRowVersion: wired!.rowVersion,
      sessionPublicKey: KEY, sessionExpiry: 1_800_000_000,
      permissionsDigest: DIGEST, projectionDigest: DIGEST,
      wbnbCapMinLimitWei: 2n * 10n ** 17n, residualThresholdWei: 10n ** 15n,
      paramsJson: '{"bandBps":700}', paramsDigest: DIGEST,
      p0E18: 740n * U, armBlock: 100n,
      levels: [
        { levelIndex: 1, buyPriceE18: 688n * U, sellPriceE18: 737n * U },
        { levelIndex: 2, buyPriceE18: 640n * U, sellPriceE18: 685n * U },
      ],
      clipUWei: 10n * U, idleUWei: 0n,
      baselineUWei: 30n * U, baselineWbnbWei: 0n, baselineNativeWei: 10n ** 16n,
      nowMs: clock,
    });
    assert.equal(admitted.kind, "ok");
    assert.equal(admitted.kind === "ok" ? admitted.record.status : "", "armed");
    const levels = await store.listLevels(JOB);
    assert.equal(levels.length, 2);
    assert.equal(levels[0]?.buyPriceE18, 688n * U);

    /* ---- admit (conflict): the CAS is on the version AND the status ------ */
    const second = await store.admitJob({
      quantJobId: JOB, expectedRowVersion: admitted.kind === "ok" ? admitted.record.rowVersion : 1,
      sessionPublicKey: KEY, sessionExpiry: 1_800_000_000,
      permissionsDigest: DIGEST, projectionDigest: DIGEST,
      wbnbCapMinLimitWei: 1n, residualThresholdWei: 1n,
      paramsJson: "{}", paramsDigest: DIGEST, p0E18: 1n, armBlock: 200n,
      levels: [{ levelIndex: 1, buyPriceE18: 999n, sellPriceE18: 999n }],
      clipUWei: 1n, idleUWei: 0n,
      baselineUWei: 0n, baselineWbnbWei: 0n, baselineNativeWei: 0n, nowMs: clock,
    });
    assert.equal(second.kind, "conflict");
    // The prices did NOT move: there is no statement that can update them.
    assert.equal((await store.listLevels(JOB))[0]?.buyPriceE18, 688n * U);

    /* ---- listWorkableJobs + setJobStatus --------------------------------- */
    assert.equal((await store.listWorkableJobs("strategy-1")).length, 1);
    // QUANT-SELFTEST R2: another strategy sees nothing; a wire refresh never re-labels.
    assert.equal((await store.listWorkableJobs("other")).length, 0);
    // R7 on real PostgreSQL: a conflicting wire strategy is refused and nothing is applied.
    assert.equal(await store.updateJobWire({
      quantJobId: JOB, strategyId: "other", tradingWallet: WALLET, allocationUWei: 99n * 10n ** 18n,
      dailyCapUWei: 1n, termDays: 1, startedAtMs: 1, endsAtMs: 2, sessionExpiresAtMs: 3, revokedAtMs: null, nowMs: 5,
    }), null);
    assert.equal((await store.getJob(JOB))?.strategyId, "strategy-1");
    await store.setJobStatus({ quantJobId: JOB, status: "paused", nowMs: clock });
    assert.equal((await store.listWorkableJobs("strategy-1")).length, 0);
    await store.setJobStatus({ quantJobId: JOB, status: "armed", holdCode: null, nowMs: clock });
    assert.equal((await store.getJob(JOB))?.holdCode, null);

    /* ---- the fence, and every method bound to its transaction ------------ */
    const fenced = await store.withQuantFence(JOB, async (fence) => {
      const job = await fence.getJob(JOB);
      assert.equal(job?.quantJobId, JOB);
      assert.equal((await fence.listLevels(JOB)).length, 2);
      assert.equal((await fence.listNonTerminalActions(JOB)).length, 0);
      assert.equal((await fence.currentEpoch(JOB))?.epoch, 1);
      assert.equal((await fence.listRecentBuys(JOB, 0)).length, 0);
      await fence.recordObservation({
        quantJobId: JOB,
        observation: {
          blockNumber: 101n, blockHash: `0x${"01".repeat(32)}` as Hex,
          observedAtMs: clock, midE18: 740n * U,
        },
      });
      await fence.markStaleObservation(JOB, 1);
      await fence.setLevelHold({ quantJobId: JOB, levelIndex: 1, holdCode: "cooldown" });
      await fence.setLevelHold({ quantJobId: JOB, levelIndex: 1, holdCode: null });
      await fence.setJobHold({ quantJobId: JOB, holdCode: "quote-unavailable" });
      await fence.setJobHold({ quantJobId: JOB, holdCode: null });
      await fence.setLevelTrigger({
        quantJobId: JOB, levelIndex: 1, consecutive: 1, side: "buy",
      });
      return true;
    });
    assert.equal(fenced, true);
    assert.equal((await store.getJob(JOB))?.lastObservedBlock, 101n);
    assert.equal((await store.getJob(JOB))?.staleObservations, 1);
    assert.equal((await store.listLevels(JOB))[0]?.triggerSide, "buy");

    /* ---- the observation trim keeps exactly eight ------------------------ */
    for (let index = 0; index < 12; index += 1) {
      await store.withQuantFence(JOB, async (fence) => {
        await fence.recordObservation({
          quantJobId: JOB,
          observation: {
            blockNumber: BigInt(200 + index),
            blockHash: `0x${index.toString(16).padStart(64, "0")}` as Hex,
            observedAtMs: clock + index, midE18: 740n * U,
          },
        });
      });
    }
    const observations = await store.listObservations(JOB, 50);
    assert.equal(observations.length, 8);
    assert.equal(observations.at(-1)?.blockNumber, 211n);

    /* ---- insertIntent: the win, and both conflicts ----------------------- */
    const level1 = (await store.listLevels(JOB))[0]!;
    const intent = await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "pg-key-1", quantJobId: JOB, levelIndex: 1, actionSeq: 1, side: "buy",
        priorLevelState: level1.state, expectedLevelRowVersion: level1.rowVersion,
        amountInWei: 10n * U, minOutWei: 13_500_000_000_000_000n,
        quoteOutWei: 13_551_363_807_546_408n, quoteBlock: 211n,
        triggerBlock1: 210n, triggerBlock2: 211n, deadlineSec: 1_800_000_601,
        callsJson: '[{"to":"0x1"}]', note: '{"v":1}', impactBps: 4,
        preUWei: 30n * U, preWbnbWei: 0n, preNativeWei: 10n ** 16n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: clock,
      }),
    );
    assert.equal(intent.kind, "ok");
    assert.equal((await store.listLevels(JOB))[0]?.state, "blocked");
    assert.equal((await store.listNonTerminalActions(JOB)).length, 1);

    const blockedAgain = await store.withQuantFence(JOB, async (fence) => {
      const current = (await fence.listLevels(JOB))[0]!;
      return fence.insertIntent({
        journalKey: "pg-key-2", quantJobId: JOB, levelIndex: 1, actionSeq: 2, side: "buy",
        priorLevelState: "armed-quote", expectedLevelRowVersion: current.rowVersion,
        amountInWei: 1n, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 1, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: clock,
      });
    });
    assert.equal(blockedAgain.kind, "conflict", "a blocked level takes no second intent");

    /* ---- abortIntent (win) restores the level ---------------------------- */
    const action = await store.getAction("pg-key-1");
    const aborted = await store.abortIntent({
      journalKey: "pg-key-1", expectedRowVersion: action!.rowVersion, nowMs: clock,
    });
    assert.equal(aborted.kind, "ok");
    assert.equal((await store.listLevels(JOB))[0]?.state, "armed-quote");
    // A SECOND abort loses the CAS — `intended` is gone.
    assert.equal((await store.abortIntent({
      journalKey: "pg-key-1", expectedRowVersion: action!.rowVersion, nowMs: clock,
    })).kind, "conflict");

    /* ---- markActionSubmitted, with the finalized ancestor in the CAS ----- */
    const level1b = (await store.listLevels(JOB))[0]!;
    await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "pg-key-3", quantJobId: JOB, levelIndex: 1, actionSeq: 2, side: "buy",
        priorLevelState: level1b.state, expectedLevelRowVersion: level1b.rowVersion,
        amountInWei: 10n * U, minOutWei: 13_500_000_000_000_000n,
        quoteOutWei: 13_551_363_807_546_408n, quoteBlock: 211n,
        triggerBlock1: 210n, triggerBlock2: 211n, deadlineSec: 1_800_000_602,
        callsJson: "[]", note: "", impactBps: 4,
        preUWei: 30n * U, preWbnbWei: 0n, preNativeWei: 10n ** 16n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: clock,
      }),
    );
    const pending = await store.getAction("pg-key-3");
    const claimed = await store.markActionSubmitted({
      journalKey: "pg-key-3", expectedRowVersion: pending!.rowVersion,
      submitFinalizedNumber: 205n, submitFinalizedHash: `0x${"cc".repeat(32)}` as Hex,
      nowMs: clock,
    });
    assert.equal(claimed.kind, "ok");
    assert.equal(claimed.kind === "ok" ? claimed.record.submitFinalizedNumber : 0n, 205n);
    assert.equal((await store.markActionSubmitted({
      journalKey: "pg-key-3", expectedRowVersion: pending!.rowVersion,
      submitFinalizedNumber: 1n, submitFinalizedHash: `0x${"dd".repeat(32)}` as Hex,
      nowMs: clock,
    })).kind, "conflict");

    /* ---- settleAction: the win, the idempotent no-op, the ownership CAS -- */
    const settled = await store.settleAction({
      journalKey: "pg-key-3", quantJobId: JOB, levelIndex: 1, txHash: TX, swapLogIndex: 4n,
      fillInWei: 10n * U, fillOutWei: 13_551_363_807_546_408n, feeDeltaWei: 300_000_000_000_000n,
      entryCostUWei: 222n, nextLevelState: "holding-base",
      nextBaseWei: 13_551_363_807_546_408n,
      nextBaseAtCycleStartWei: 13_551_363_807_546_408n,
      nextBasisUWei: 10n * U, cyclesClosedDelta: 0, realizedDeltaUWei: 0n,
      residualDeltaWei: 0n, exitPlanJson: '{"chunks":["1"]}', nowMs: clock,
    });
    assert.equal(settled.kind, "ok");
    const holding = (await store.listLevels(JOB))[0];
    assert.equal(holding?.state, "holding-base");
    assert.equal(holding?.baseWei, 13_551_363_807_546_408n);
    assert.equal(holding?.entryCostUWei, 222n);
    assert.equal((await store.getAction("pg-key-3"))?.feeDeltaWei, 300_000_000_000_000n);

    const again = await store.settleAction({
      journalKey: "pg-key-3", quantJobId: JOB, levelIndex: 1, txHash: TX, swapLogIndex: 4n,
      fillInWei: 1n, fillOutWei: 1n, feeDeltaWei: null, entryCostUWei: 0n,
      nextLevelState: "armed-quote", nextBaseWei: 0n, nextBaseAtCycleStartWei: 0n,
      nextBasisUWei: 0n, cyclesClosedDelta: 99, realizedDeltaUWei: 999n,
      residualDeltaWei: 0n, exitPlanJson: null, nowMs: clock,
    });
    assert.equal(again.kind, "ok", "a second settle is a no-op, not an error");
    assert.equal((await store.listLevels(JOB))[0]?.cyclesClosed, 0);

    // A DIFFERENT action of the same wallet cannot claim the same swap.
    const level2 = (await store.listLevels(JOB))[1]!;
    await store.withQuantFence(JOB, async (fence) =>
      fence.insertIntent({
        journalKey: "pg-key-4", quantJobId: JOB, levelIndex: 2, actionSeq: 1, side: "buy",
        priorLevelState: level2.state, expectedLevelRowVersion: level2.rowVersion,
        amountInWei: 10n * U, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 1n,
        triggerBlock1: 1n, triggerBlock2: 1n, deadlineSec: 2, callsJson: "[]", note: "",
        impactBps: 0, preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
        basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: clock,
      }),
    );
    const stolen = await store.settleAction({
      journalKey: "pg-key-4", quantJobId: JOB, levelIndex: 2, txHash: TX, swapLogIndex: 4n,
      fillInWei: 1n, fillOutWei: 1n, feeDeltaWei: null, entryCostUWei: 0n,
      nextLevelState: "holding-base", nextBaseWei: 1n, nextBaseAtCycleStartWei: 1n,
      nextBasisUWei: 1n, cyclesClosedDelta: 0, realizedDeltaUWei: 0n,
      residualDeltaWei: 0n, exitPlanJson: null, nowMs: clock,
    });
    assert.equal(stolen.kind, "conflict", "(tx, wallet, swap log) admits exactly one action");

    /* ---- setActionState, with and without the level restore -------------- */
    const restored = await store.setActionState({
      journalKey: "pg-key-4", state: "failed", failureCode: "CAP_EXCEEDED",
      restoreLevel: true, nowMs: clock,
    });
    assert.equal(restored?.state, "failed");
    assert.equal((await store.listLevels(JOB))[1]?.state, "armed-quote");
    // A terminal row is not moved again.
    assert.equal(await store.setActionState({
      journalKey: "pg-key-4", state: "unknown", nowMs: clock,
    }), null);

    /* ---- listRecentBuys and listActions ---------------------------------- */
    const recent = await store.withQuantFence(JOB, async (fence) =>
      fence.listRecentBuys(JOB, 0),
    );
    assert.equal(recent.length, 3);
    assert.equal((await store.listActions(JOB)).length, 3);

    /* ---- retireLevel: the snapshot epoch, and its idempotence ------------ */
    const retired = await store.retireLevel({
      quantJobId: JOB, levelIndex: 1,
      retiredJson: '{"baseWei":"1"}',
      epoch: {
        startedBlock: 500n, startedBlockHash: `0x${"dd".repeat(32)}` as Hex,
        baselineUWei: 20n * U, baselineWbnbWei: 5n, baselineNativeWei: 7n,
        note: "retire-level:1",
      },
      nowMs: clock,
    });
    assert.equal(retired.kind, "ok");
    assert.equal((await store.listLevels(JOB))[0]?.state, "retired");
    assert.equal((await store.listLevels(JOB))[0]?.baseWei, 0n);
    const epoch = await store.currentEpoch(JOB);
    assert.equal(epoch?.epoch, 2);
    assert.equal(epoch?.baselineUWei, 20n * U);
    assert.equal(epoch?.startedBlock, 500n);
    assert.equal((await store.retireLevel({
      quantJobId: JOB, levelIndex: 1, retiredJson: "{}",
      epoch: {
        startedBlock: 501n, startedBlockHash: `0x${"de".repeat(32)}` as Hex,
        baselineUWei: 1n, baselineWbnbWei: 1n, baselineNativeWei: 1n, note: "again",
      },
      nowMs: clock,
    })).kind, "ok", "retirement is idempotent");

    /* ---- openEpoch numbering is per JOB ---------------------------------- */
    await store.discoverJob({
      quantJobId: OTHER_JOB, envelopeId: "env-2", envelopeJson: "{}", nowMs: clock,
    });
    const otherEpoch = await store.openEpoch({
      quantJobId: OTHER_JOB, startedBlock: 1n,
      startedBlockHash: `0x${"aa".repeat(32)}` as Hex,
      baselineUWei: 1n, baselineWbnbWei: 1n, baselineNativeWei: 1n,
      note: "first", nowMs: clock,
    });
    assert.equal(otherEpoch.epoch, 1, "epoch numbering must not leak across jobs");

    /* ---- indexer trades (non-authoritative display rows) ------------------ */
    await store.recordIndexerTrades(JOB, [
      { txHash: TX, direction: "buy", amountIn: "10", amountOut: "0.013", blockTimeMs: clock, note: "x" },
      { txHash: TX, direction: "buy", amountIn: "99", amountOut: "9", blockTimeMs: clock, note: null },
    ], clock);
    const indexer = await store.listIndexerTrades(JOB);
    assert.equal(indexer.length, 1, "the (job, tx) key dedupes");
    assert.equal(indexer[0]?.amountIn, "10");

    /* ---- reports: EVERY attempt, numbered ------------------------------- */
    const first = await store.recordReport({
      quantJobId: JOB, payloadDigest: DIGEST, responseStatus: 0, notesApplied: null, nowMs: clock,
    });
    assert.equal(first.attempt, 1);
    const secondReport = await store.recordReport({
      quantJobId: JOB, payloadDigest: DIGEST, responseStatus: 200, notesApplied: 3, nowMs: clock,
    });
    assert.equal(secondReport.attempt, 2);
    assert.equal(secondReport.notesApplied, 3);
    assert.equal((await store.listReports(JOB)).length, 2);
    assert.equal((await store.getJob(JOB))?.reportAttempts, 2);

    /* ---- runs ------------------------------------------------------------ */
    await store.recordRun({
      runId: "run-1", startedAtMs: clock, finishedAtMs: clock + 1_000,
      jobsSeen: 1, actions: 1, holds: 0, errors: 0, dryRun: false,
    });
    await store.recordRun({
      runId: "run-1", startedAtMs: clock, finishedAtMs: clock + 1_000,
      jobsSeen: 9, actions: 9, holds: 9, errors: 9, dryRun: true,
    });
    const runs = await sql.query<{ jobs_seen: number }>(
      "select jobs_seen from quant_runs where run_id = $1", ["run-1"],
    );
    assert.equal(runs.rows.length, 1, "a duplicate run id is ignored, never overwritten");
    assert.equal(Number(runs.rows[0]?.jobs_seen), 1);

    /* ---- the journal's quantTrade row, on the same real server ----------- */
    clock += 1;
    const journal = await PostgresExecutionJournal.create(sql, () => clock);
    const journalKey = `quant-journal-${Date.now()}`;
    const begun = await journal.beginWithSpend({
      idempotencyKey: journalKey, agentId: JOB, ownerAddress: WALLET.toLowerCase(),
      kind: "quantTrade", decisionId: journalKey,
      externalRef: { publicKey: KEY, paramsHash: DIGEST }, nativeSpendWei: 0n,
    }, 0);
    assert.equal(begun.created, true);
    // The FIFTH hand-maintained site, executed: `getByDecision`'s SQL literal
    // must include 'quantTrade' or this returns null on a real server while the
    // memory backend and the fake client both say yes.
    const byDecision = await journal.getByDecision(JOB, journalKey);
    assert.notEqual(byDecision, null, "the getByDecision SQL literal must name quantTrade");
    assert.equal(byDecision?.kind, "quantTrade");

    /* ---- R5.2 / audit A2: the sender and a stale recovery, TWO clients ---- */
    // The memory backend proves the two CASes are exclusive in one process.
    // This proves it where it has to hold: two connections, real row locks, and
    // a recovery that must NOT roll a journal row back after losing.
    const senderSql = await createPgSqlClient(running.url);
    try {
      const senderStore = await PostgresQuantJobStore.create(senderSql, () => clock);
      const raceKey = "pg-race-key";
      const freeLevel = (await store.listLevels(JOB))[1]!;
      assert.equal(freeLevel.state, "armed-quote");
      await store.withQuantFence(JOB, async (fence) =>
        fence.insertIntent({
          journalKey: raceKey, quantJobId: JOB, levelIndex: 2, actionSeq: 2, side: "buy",
          priorLevelState: freeLevel.state, expectedLevelRowVersion: freeLevel.rowVersion,
          amountInWei: 10n * U, minOutWei: 1n, quoteOutWei: 1n, quoteBlock: 211n,
          triggerBlock1: 210n, triggerBlock2: 211n, deadlineSec: 1_800_000_603,
          callsJson: "[]", note: "", impactBps: 0,
          preUWei: 0n, preWbnbWei: 0n, preNativeWei: 0n,
          basisUWei: 0n, baseAtCycleStartWei: 0n, nowMs: clock,
        }),
      );
      await journal.beginWithSpend({
        idempotencyKey: raceKey, agentId: JOB, ownerAddress: WALLET.toLowerCase(),
        kind: "quantTrade", decisionId: raceKey,
        externalRef: { publicKey: KEY }, nativeSpendWei: 0n,
      }, 0);

      // The recovery's work list, read BEFORE the sender's CAS.
      const staleSnapshot = (await store.listNonTerminalActions(JOB))
        .filter((row) => row.journalKey === raceKey);
      assert.equal(staleSnapshot[0]?.state, "intended");

      // The SENDER, on its own connection, wins `intended → submitted`.
      const claimedBySender = await senderStore.markActionSubmitted({
        journalKey: raceKey, expectedRowVersion: staleSnapshot[0]!.rowVersion,
        submitFinalizedNumber: 209n, submitFinalizedHash: `0x${"cc".repeat(32)}` as Hex,
        nowMs: clock,
      });
      assert.equal(claimedBySender.kind, "ok");

      const view = withStaleActionSnapshot(store, staleSnapshot);
      const raced = await recoverUnsettledActions({
        store: view.store,
        journal,
        provider: {} as unknown as WalletProvider,
        reader: {} as unknown as QuantChainReader,
        params: QUANT_STRATEGY_DEFAULTS,
        venue: {
          router: QUANT_ROUTER_56, u: QUANT_U_56,
          wbnb: QUANT_WBNB_56, pair: QUANT_U_WBNB_PAIR_56,
        },
        nowMs: () => clock,
      }, (await store.getJob(JOB))!);

      assert.deepEqual(view.abortVerdicts, ["conflict"], "the abort CAS must LOSE");
      assert.equal(raced[0]?.cell, "PENDING/intended");
      assert.equal(raced[0]?.released, false);
      assert.equal((await journal.get(raceKey))?.state, "PENDING", "the journal is untouched");
      assert.equal((await store.getAction(raceKey))?.state, "submitted");
      assert.equal((await store.listLevels(JOB))[1]?.state, "blocked");
    } finally {
      await senderSql.close();
    }

    await sql.query("delete from execution_journal where agent_id = $1", [JOB]);

    /* ---- teardown -------------------------------------------------------- */
    await dropAll(sql);
  } finally {
    await sql.close();
    await running.stop();
  }
});

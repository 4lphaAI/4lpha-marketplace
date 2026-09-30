/** Real PostgreSQL acceptance test using only its own new loopback cluster. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { createPgSqlClient } from "../src/store/sql.js";
import { withQuantRebalanceCensusSnapshot } from "../scripts/live-quant-rebalance.js";
import { PostgresExecutionJournal, type JournalResolutionEvidence } from "../src/store/journal.js";
import { PostgresQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { PostgresQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { PostgresQuantJobStore } from "../src/store/quantJobs.js";
import { brandVerifiedFailureProof, brandVerifiedReceiptProof } from "../src/store/quantRebalanceProof.js";
import { brandVerifiedNotExecutedProof } from "../src/store/quantRebalanceProof.js";
import { E18, HIGH_TIER, REBALANCE_CAKE, REBALANCE_ETH, REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB, rebalanceJobPolicyDigest } from "../src/quant/rebalancePolicy.js";
import type { QuantRebalanceJobWire } from "../src/quant/rebalanceTypes.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import { createQuantRebalanceCliPorts } from "../scripts/live-quant-rebalance.js";
import { parseQuantRebalanceOperatorArgs, runQuantRebalanceOperatorCommand, safeQuantRebalanceCliJson } from "../src/quant/rebalanceOperatorCli.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";

function command(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Local PostgreSQL helper exited ${code}: ${stderr}`)));
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

async function waitReady(executable: string, port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("The isolated PostgreSQL process exited before readiness.");
    try { await command(executable, ["-h", "127.0.0.1", "-p", String(port)]); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error("The isolated PostgreSQL process did not become ready.");
}

type LocalPostgres = { readonly url: string; stop(): Promise<void> };
async function startIsolatedPostgres(): Promise<LocalPostgres | null> {
  const bin = process.env["QUANT_REBALANCE_POSTGRES_BIN"] ?? "C:\\Program Files\\PostgreSQL\\17\\bin";
  const win = process.platform === "win32";
  const executable = (name: string) => join(bin, win ? `${name}.exe` : name);
  const initdb = executable("initdb"); const postgres = executable("postgres");
  const pgCtl = executable("pg_ctl"); const ready = executable("pg_isready"); const createdb = executable("createdb");
  try { await Promise.all([access(initdb), access(postgres), access(pgCtl), access(ready), access(createdb)]); }
  catch { return null; }
  const root = await mkdtemp(join(tmpdir(), "4lpha-quant-rebalance-pg-"));
  const initiallyEmpty = await readdir(root);
  assert.equal(initiallyEmpty.length, 0, "the PostgreSQL data directory must be newly created and empty");
  const data = join(root, "data"); const port = await freeLoopbackPort();
  const username = "quant_rebalance_test";
  await command(initdb, ["-D", data, "--auth=trust", "--encoding=UTF8", "--no-locale", `--username=${username}`]);
  const child = spawn(postgres, ["-D", data, "-F", "-p", String(port), "-h", "127.0.0.1"], {
    stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
  });
  try {
    await waitReady(ready, port, child);
    const database = `quant_rebalance_test_${randomUUID().replaceAll("-", "")}`;
    await command(createdb, ["-h", "127.0.0.1", "-p", String(port), "-U", username, database]);
    return {
      url: `postgresql://${username}@127.0.0.1:${port}/${database}`,
      async stop() {
        try { await command(pgCtl, ["-D", data, "-m", "immediate", "stop"]); }
        catch { child.kill("SIGKILL"); }
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try { await command(pgCtl, ["-D", data, "-m", "immediate", "stop"]); } catch { child.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("Quant rebalancing SQL fences and admission promotion on an isolated PostgreSQL cluster", { timeout: 180_000 }, async (t) => {
  const server = await startIsolatedPostgres();
  if (server === null) {
    t.skip("Local PostgreSQL binaries are unavailable; no external database URL is read.");
    return;
  }
  const claimSql = await createPgSqlClient(server.url);
  const stateSql = await createPgSqlClient(server.url);
  const claims = new PostgresQuantWalletClaimStore(claimSql);
  const store = new PostgresQuantRebalanceStore(stateSql);
  const gridStore = await PostgresQuantJobStore.create(stateSql);
  try {
    await claims.ensureSchema(); await store.ensureSchema();
    const journal = await PostgresExecutionJournal.create(stateSql);
    const failureJournalKey = `failure-discovered-${randomUUID()}`;
    const failureJournalWallet = getAddress(`0x${"9a".repeat(20)}`);
    const discoveredCallsId = `0x${"ab".repeat(32)}` as Hex;
    const discoveredFailureHash = `0x${"bc".repeat(32)}` as Hex;
    await journal.beginWithSpend({ idempotencyKey: failureJournalKey, agentId: "journal-audit", ownerAddress: failureJournalWallet,
      kind: "quantTrade", decisionId: failureJournalKey, externalRef: {}, nativeSpendWei: 0n }, 0);
    await journal.markInProgress(failureJournalKey, { callsId: discoveredCallsId });
    await journal.markUnknown(failureJournalKey, "offline callsId proof pending");
    const resolution: JournalResolutionEvidence = { action: "resolveUnknown", at: Date.now(), ownerAddress: failureJournalWallet,
      observedBlock: "101", serverBlock: "101", checks: [{ name: "quant-rebalance-receipt", result: "verified-failure" }],
      legs: [], logAbsence: { checked: false, detail: "not-applicable" }, disposition: "receipt-proof-verified" };
    await journal.resolveUnknown(failureJournalKey, resolution, { txHash: discoveredFailureHash });
    const boundFailureJournal = await journal.get(failureJournalKey);
    assert.equal(boundFailureJournal?.state, "ROLLED_BACK");
    assert.equal(boundFailureJournal?.externalRef.callsId, discoveredCallsId);
    assert.equal(boundFailureJournal?.externalRef.txHash, discoveredFailureHash);
    const orphanWallet = getAddress(`0x${randomBytes(20).toString("hex")}`) as Address;
    const orphan = await claims.claimProvisional({ wallet: orphanWallet, strategyKind: "rebalance",
      strategyId: "pg-strategy", jobId: `orphan-${randomUUID()}`, attemptId: `orphan-attempt-${randomUUID()}`, nowMs: Date.now() });
    assert.equal(orphan.kind, "acquired");
    if (orphan.kind === "acquired") {
      assert.equal(await claims.releaseProvisional({ wallet: orphanWallet, strategyKind: "rebalance",
        strategyId: "pg-strategy", jobId: orphan.claim.jobId ?? "", attemptId: orphan.claim.attemptId ?? "",
        generation: orphan.claim.generation, refusal: "admission-refused", nowMs: Date.now() }), "released");
      assert.equal((await claims.list()).find((row) => row.wallet.toLowerCase() === orphanWallet.toLowerCase())?.mode, "free");
    }

    const gridJobId = `pg-grid-${randomUUID()}`;
    const gridWallet = getAddress(`0x${randomBytes(20).toString("hex")}`) as Address;
    const gridNow = Date.now();
    await gridStore.discoverJob({ quantJobId: gridJobId, strategyId: "pg-grid-strategy",
      envelopeJson: "{}", envelopeId: `grid-env-${randomUUID()}`, nowMs: gridNow });
    const wireGrid = await gridStore.updateJobWire({ quantJobId: gridJobId, strategyId: "pg-grid-strategy",
      tradingWallet: gridWallet, allocationUWei: 10n * E18, dailyCapUWei: 20n * E18, termDays: 30,
      startedAtMs: gridNow, endsAtMs: gridNow + 30 * 86_400_000,
      sessionExpiresAtMs: gridNow + 30 * 86_400_000, revokedAtMs: null, nowMs: gridNow });
    assert(wireGrid !== null);
    const gridClaimInput = { wallet: gridWallet, strategyKind: "grid" as const, strategyId: "pg-grid-strategy",
      jobId: gridJobId, attemptId: `grid-attempt-${randomUUID()}`, nowMs: gridNow };
    const gridLease = await claims.claimProvisional(gridClaimInput);
    assert.equal(gridLease.kind, "acquired"); if (gridLease.kind !== "acquired") return;
    const gridPromotion = await claims.promoteProvisional({ ...gridClaimInput, generation: gridLease.claim.generation }, async (tx) => {
      if (tx === undefined) return null;
      const admitted = await gridStore.admitJob({
        quantJobId: gridJobId, expectedRowVersion: wireGrid.rowVersion, claimGeneration: gridLease.claim.generation,
        sessionPublicKey: `0x${"11".repeat(65)}` as Hex, sessionExpiry: Math.floor((gridNow + 30 * 86_400_000) / 1_000),
        permissionsDigest: `0x${"22".repeat(32)}` as Hex, projectionDigest: `0x${"33".repeat(32)}` as Hex,
        wbnbCapMinLimitWei: E18, residualThresholdWei: 1n, paramsJson: "{}", paramsDigest: `0x${"44".repeat(32)}` as Hex,
        p0E18: E18, armBlock: 1n, armBlockHash: `0x${"55".repeat(32)}` as Hex,
        levels: [{ levelIndex: 1, buyPriceE18: E18, sellPriceE18: 2n * E18 }],
        clipUWei: E18, idleUWei: 0n, baselineUWei: 10n * E18, baselineWbnbWei: 0n,
        baselineNativeWei: E18, capRowsJson: "[]", nowMs: gridNow,
      }, tx);
      return admitted.kind === "ok" ? admitted.record : null;
    });
    assert.equal(gridPromotion.promoted, true);
    assert.equal((await gridStore.getJob(gridJobId))?.claimGeneration, gridLease.claim.generation);

    let enterWalletFence!: () => void; let releaseWalletFence!: () => void;
    const enteredWalletFence = new Promise<void>((resolve) => { enterWalletFence = resolve; });
    const waitForRelease = new Promise<void>((resolve) => { releaseWalletFence = resolve; });
    const firstFence = claims.withWalletFence(gridWallet, async (tx) => {
      assert(tx !== undefined, "the wallet lock must expose its pinned transaction");
      assert.equal(await claims.isActive({ wallet: gridWallet, strategyKind: "grid", strategyId: gridClaimInput.strategyId,
        jobId: gridJobId, generation: gridLease.claim.generation }, tx), true);
      return gridStore.withQuantFence(gridJobId, async (fence) => {
        assert.equal((await fence.getJob(gridJobId))?.claimGeneration, gridLease.claim.generation);
        enterWalletFence(); await waitForRelease;
        return true;
      }, tx);
    });
    await enteredWalletFence;
    let secondEntered = false;
    const competingFence = claims.withWalletFence(gridWallet, async () => { secondEntered = true; });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(secondEntered, false, "a competing wallet operation must wait while the job fence is active");
    releaseWalletFence();
    assert.equal(await firstFence, true);
    await competingFence;
    assert.equal(secondEntered, true);

    const suffix = randomUUID(); const jobId = `pg-rebalance-${suffix}`;
    const wallet = getAddress(`0x${randomBytes(20).toString("hex")}`) as Address;
    const startedAtMs = Date.now() - 1_000; const endsAtMs = Date.now() + 2_000_000; const sessionExpiresAtMs = endsAtMs;
    const wire: QuantRebalanceJobWire = {
      id: jobId, status: "ACTIVE", strategyId: "pg-rebalance-strategy", tradingWalletAddress: wallet,
      allocationUWei: 75n * E18, dailyCapUWei: 100n * E18, termDays: 30,
      startedAtMs, endsAtMs, sessionExpiresAtMs, revokedAtMs: null,
      envelope: null, wireDigest: `0x${"aa".repeat(32)}` as Hex,
    };
    const discovered = await store.discoverJob({ wire, envelopeJson: "SENSITIVE_CIPHERTEXT", envelopeId: `env-${suffix}`, nowMs: Date.now() });
    const claimInput = { wallet, strategyKind: "rebalance" as const, strategyId: wire.strategyId, jobId,
      attemptId: `attempt-${suffix}`, nowMs: Date.now() };
    const races = await Promise.all([
      claims.claimProvisional(claimInput),
      claims.claimProvisional({ ...claimInput, attemptId: `racer-${suffix}` }),
    ]);
    assert.equal(races.filter((row) => row.kind === "acquired").length, 1);
    assert.equal(races.filter((row) => row.kind === "held").length, 1);
    const lease = races.find((row) => row.kind === "acquired");
    assert.equal(lease?.kind, "acquired"); if (lease?.kind !== "acquired") return;
    const nowMs = Date.now();
    const promoted = await claims.promoteProvisional({ ...claimInput, attemptId: lease.claim.attemptId ?? "",
      generation: lease.claim.generation, nowMs }, async (tx) => {
      if (tx === undefined) return null;
      const admission = await store.admit({
        jobId, expectedRowVersion: discovered.rowVersion, attemptId: lease.claim.attemptId ?? "",
        claimGeneration: lease.claim.generation, policyJson: "{}",
        policyDigest: rebalanceJobPolicyDigest({ capabilityProfileId: "offline", jobId, strategyId: wire.strategyId,
          allocationWei: 75n * E18, tier: HIGH_TIER, startedAtMs, endsAtMs, sessionExpiresAtMs }),
        tier: "high", sessionPublicKey: `0x${"11".repeat(65)}` as Hex,
        sessionExpirySec: Math.floor(sessionExpiresAtMs / 1_000), permissionsDigest: `0x${"22".repeat(32)}` as Hex,
        projectionDigest: `0x${"33".repeat(32)}` as Hex, descriptorJson: "SENSITIVE_SESSION_DESCRIPTOR", projectionJson: "{}", capRowsJson: "[]",
        baselineBlock: 100n, baselineHash: `0x${"44".repeat(32)}` as Hex, baselineAtMs: nowMs,
        actualBaseline: { USDC: 75n * E18, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
        protectedBaseline: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }, nowMs,
      }, tx);
      return admission.kind === "ok" ? admission.record : null;
    });
    assert.equal(promoted.promoted, true);
    assert.equal((await claims.list()).find((row) => row.jobId === jobId)?.mode, "active");
    const admitted = await store.getJob(jobId);
    assert.equal(admitted?.status, "admitted");
    const bootstrap = (await store.listChecks(jobId))[0];
    assert(bootstrap !== undefined && admitted !== null);
    const actionInput = {
      jobId, checkId: bootstrap.checkId, sequence: 1n, state: "intended" as const,
      side: "buy" as const, asset: "WBNB" as const, tokenIn: REBALANCE_USDC,
      tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
      pairAddresses: [getAddress(`0x${randomBytes(20).toString("hex")}`)],
      amountInWei: E18, minOutWei: E18, quoteOutWei: 2n * E18, deadlineSec: Math.floor(nowMs / 1_000) + 600,
      callsJson: "[]", callsDigest: `0x${"55".repeat(32)}` as Hex, policyDigest: admitted.policyDigest!,
      permissionsDigest: admitted.permissionsDigest!, projectionDigest: admitted.projectionDigest!,
      claimGeneration: lease.claim.generation, quoteBlockNumber: 100n, quoteBlockHash: `0x${"44".repeat(32)}` as Hex,
      quoteObservedAtMs: nowMs, referenceBlockNumber: 100n, referenceBlockHash: `0x${"44".repeat(32)}` as Hex,
      referenceObservedAtMs: nowMs, referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: E18,
      expectedJobRevision: admitted.accountingRev, expectedCheckVersion: bootstrap.rowVersion, nowMs,
    };
    const inserted = await store.insertAction(actionInput);
    assert.equal(inserted.kind, "ok"); if (inserted.kind !== "ok") return;
    const staleSubmit = await store.markSubmitted({ actionId: inserted.record.actionId,
      expectedRowVersion: inserted.record.rowVersion, claimGeneration: lease.claim.generation,
      blockNumber: 100n, blockHash: `0x${"44".repeat(32)}` as Hex, nowMs: nowMs + 31_000,
      revalidate: async () => true });
    assert.notEqual(staleSubmit.kind, "ok", "expired route/reference evidence must refuse the submit claim");
    const freshSubmit = await store.markSubmitted({ actionId: inserted.record.actionId,
      expectedRowVersion: inserted.record.rowVersion, claimGeneration: lease.claim.generation,
      blockNumber: 100n, blockHash: `0x${"44".repeat(32)}` as Hex, nowMs: nowMs + 1_000,
      revalidate: async () => true });
    assert.equal(freshSubmit.kind, "ok");
    if (freshSubmit.kind !== "ok") return;
    const failureProof = brandVerifiedFailureProof({ chainId: 56, txHash: `0x${"66".repeat(32)}` as Hex,
      blockNumber: 101n, blockHash: `0x${"77".repeat(32)}` as Hex, wallet, nonce: 1n,
      keyHash: `0x${"88".repeat(32)}` as Hex, actionId: inserted.record.actionId,
      failureDigest: `0x${"99".repeat(32)}` as Hex });
    await stateSql.query(`insert into execution_journal(idempotency_key,agent_id,owner_address,kind,state,external_ref)
      values($1,$2,$3,'quantTrade','ROLLED_BACK',$4::jsonb)`,
    [inserted.record.journalKey, jobId, wallet.toLowerCase(), JSON.stringify({ txHash: failureProof.txHash })]);
    const failed = await store.failAction({ actionId: inserted.record.actionId,
      expectedRowVersion: freshSubmit.record.rowVersion,
      evidence: { kind: "submitted-failure", proof: failureProof }, nowMs: nowMs + 2_000 });
    assert.equal(failed.kind, "ok");
    const afterFailureJob = await store.getJob(jobId);
    const afterFailureCheck = (await store.listChecks(jobId))[0];
    assert(afterFailureJob !== null && afterFailureCheck !== undefined);
    assert.deepEqual(afterFailureCheck.takenAssets, ["WBNB"]);
    const retryTaken = await store.insertAction({ ...actionInput, sequence: 2n,
      expectedJobRevision: afterFailureJob.accountingRev, expectedCheckVersion: afterFailureCheck.rowVersion,
      nowMs: nowMs + 3_000 });
    assert.deepEqual(retryTaken, { kind: "inconsistent", code: "asset-already-taken" });
    const ethIntent = await store.insertAction({ ...actionInput, sequence: 2n, asset: "ETH", deadlineSec: actionInput.deadlineSec + 1,
      tokenOut: REBALANCE_ETH, path: [REBALANCE_USDC, REBALANCE_ETH],
      pairAddresses: [getAddress(`0x${randomBytes(20).toString("hex")}`)],
      expectedJobRevision: afterFailureJob.accountingRev, expectedCheckVersion: afterFailureCheck.rowVersion,
      nowMs: nowMs + 4_000 });
    assert.equal(ethIntent.kind, "ok");
    if (ethIntent.kind !== "ok") return;
    const ethSubmitted = await store.markSubmitted({ actionId: ethIntent.record.actionId,
      expectedRowVersion: ethIntent.record.rowVersion, claimGeneration: lease.claim.generation,
      blockNumber: 100n, blockHash: `0x${"44".repeat(32)}` as Hex, nowMs: nowMs + 5_000,
      revalidate: async () => true });
    assert.equal(ethSubmitted.kind, "ok"); if (ethSubmitted.kind !== "ok") return;
    const outerSuccessInnerFailure = brandVerifiedFailureProof({ chainId: 56, txHash: `0x${"cc".repeat(32)}` as Hex,
      blockNumber: 102n, blockHash: `0x${"dd".repeat(32)}` as Hex, wallet, nonce: 2n,
      keyHash: `0x${"ee".repeat(32)}` as Hex, actionId: ethIntent.record.actionId,
      failureDigest: `0x${"ff".repeat(32)}` as Hex });
    const committedUnknown = await store.markAmbiguous({ actionId: ethIntent.record.actionId,
      expectedRowVersion: ethSubmitted.record.rowVersion, state: "committed-unverified",
      cause: "receipt-unverified", txHash: outerSuccessInnerFailure.txHash, nowMs: nowMs + 6_000 });
    assert.equal(committedUnknown.kind, "ok"); if (committedUnknown.kind !== "ok") return;
    await stateSql.query(`insert into execution_journal(idempotency_key,agent_id,owner_address,kind,state,external_ref)
      values($1,$2,$3,'quantTrade','COMMITTED',$4::jsonb)`,
    [ethIntent.record.journalKey, jobId, wallet.toLowerCase(), JSON.stringify({ txHash: outerSuccessInnerFailure.txHash })]);
    const innerFailed = await store.failAction({ actionId: ethIntent.record.actionId,
      expectedRowVersion: committedUnknown.record.rowVersion,
      evidence: { kind: "submitted-failure", proof: outerSuccessInnerFailure }, nowMs: nowMs + 7_000 });
    assert.equal(innerFailed.kind, "ok", "branded inner-failure proof may close a committed outer transaction without rewriting its journal state");
    assert.equal((await stateSql.query<{ readonly state: string }>(`select state from execution_journal where idempotency_key=$1`, [ethIntent.record.journalKey])).rows[0]?.state, "COMMITTED");
    assert.deepEqual((await store.listChecks(jobId))[0]?.takenAssets, ["WBNB", "ETH"]);
    const beforeNotExecutedJob = await store.getJob(jobId); const beforeNotExecutedCheck = (await store.listChecks(jobId))[0];
    assert(beforeNotExecutedJob !== null && beforeNotExecutedCheck !== undefined);
    const cakeIntent = await store.insertAction({ ...actionInput, sequence: 3n, asset: "CAKE", tokenOut: REBALANCE_CAKE,
      deadlineSec: actionInput.deadlineSec + 2,
      path: [REBALANCE_USDC, REBALANCE_CAKE], pairAddresses: [getAddress(`0x${randomBytes(20).toString("hex")}`)],
      expectedJobRevision: beforeNotExecutedJob.accountingRev, expectedCheckVersion: beforeNotExecutedCheck.rowVersion,
      nowMs: nowMs + 8_000 });
    assert.equal(cakeIntent.kind, "ok"); if (cakeIntent.kind !== "ok") return;
    const cakeSubmitted = await store.markSubmitted({ actionId: cakeIntent.record.actionId,
      expectedRowVersion: cakeIntent.record.rowVersion, claimGeneration: lease.claim.generation,
      blockNumber: 100n, blockHash: `0x${"44".repeat(32)}` as Hex, nowMs: nowMs + 9_000,
      revalidate: async () => true });
    assert.equal(cakeSubmitted.kind, "ok"); if (cakeSubmitted.kind !== "ok") return;
    const cakeUnknown = await store.markAmbiguous({ actionId: cakeIntent.record.actionId,
      expectedRowVersion: cakeSubmitted.record.rowVersion, state: "unknown", cause: "relay-timeout", nowMs: nowMs + 10_000 });
    assert.equal(cakeUnknown.kind, "ok"); if (cakeUnknown.kind !== "ok") return;
    await stateSql.query(`insert into execution_journal(idempotency_key,agent_id,owner_address,kind,state,external_ref)
      values($1,$2,$3,'quantTrade','UNKNOWN','{}'::jsonb)`, [cakeIntent.record.journalKey, jobId, wallet.toLowerCase()]);
    const notExecutedProof = brandVerifiedNotExecutedProof({ chainId: 56, actionId: cakeIntent.record.actionId,
      jobId, generation: lease.claim.generation, evidenceDigest: `0x${"12".repeat(32)}` as Hex,
      evidenceJson: JSON.stringify({ v: 1, evidenceDigest: `0x${"12".repeat(32)}` }) });
    const beforeJournalRaceJob = await store.getJob(jobId); const beforeJournalRaceCheck = (await store.listChecks(jobId))[0];
    assert(beforeJournalRaceJob !== null && beforeJournalRaceCheck !== undefined);
    await stateSql.query(`update execution_journal set state='COMMITTED',external_ref=$2::jsonb where idempotency_key=$1`,
      [cakeIntent.record.journalKey, JSON.stringify({ txHash: `0x${"34".repeat(32)}` })]);
    const journalRace = await store.resolveNotExecuted({ actionId: cakeIntent.record.actionId,
      expectedActionVersion: cakeUnknown.record.rowVersion, expectedJobVersion: beforeJournalRaceJob.rowVersion,
      expectedCheckVersion: beforeJournalRaceCheck.rowVersion, proof: notExecutedProof, nowMs: nowMs + 11_000 });
    assert.deepEqual(journalRace, { kind: "inconsistent", code: "revision-changed" });
    assert.equal((await store.getAction(cakeIntent.record.actionId))?.state, "unknown");
    await stateSql.query(`update execution_journal set state='UNKNOWN',external_ref='{}'::jsonb where idempotency_key=$1`, [cakeIntent.record.journalKey]);
    const notExecuted = await store.resolveNotExecuted({ actionId: cakeIntent.record.actionId,
      expectedActionVersion: cakeUnknown.record.rowVersion, expectedJobVersion: beforeJournalRaceJob.rowVersion,
      expectedCheckVersion: beforeJournalRaceCheck.rowVersion, proof: notExecutedProof, nowMs: nowMs + 12_000 });
    assert.equal(notExecuted.kind, "ok");
    assert.deepEqual((await store.listChecks(jobId))[0]?.takenAssets, ["WBNB", "ETH", "CAKE"]);
    const beforeCrashCheckJob = await store.getJob(jobId); assert(beforeCrashCheckJob !== null);
    const crashCheck = await store.beginCheck({ jobId, kind: "scheduled", slot: 3, state: "rebalancing", evidenceJson: "{}",
      expectedJobRevision: beforeCrashCheckJob.accountingRev, nowMs: nowMs + 12_500 });
    assert.equal(crashCheck.kind, "ok"); if (crashCheck.kind !== "ok") return;
    const crashIntent = await store.insertAction({ ...actionInput, checkId: crashCheck.record.checkId,
      sequence: beforeCrashCheckJob.actionSequence + 1n, deadlineSec: actionInput.deadlineSec + 5,
      expectedJobRevision: beforeCrashCheckJob.accountingRev, expectedCheckVersion: crashCheck.record.rowVersion,
      nowMs: nowMs + 12_501 });
    assert.equal(crashIntent.kind, "ok"); if (crashIntent.kind !== "ok") return;
    await stateSql.query(`insert into execution_journal(idempotency_key,agent_id,owner_address,kind,state,external_ref)
      values($1,$2,$3,'quantTrade','PENDING','{}'::jsonb)`, [crashIntent.record.journalKey, jobId, wallet.toLowerCase()]);
    const pendingSenderRace = await Promise.all([
      store.beginJournalForIntended({ actionId: crashIntent.record.actionId,
        expectedRowVersion: crashIntent.record.rowVersion, claimGeneration: lease.claim.generation,
        journalBegin: { journal, sinceMs: 0, input: { idempotencyKey: crashIntent.record.journalKey,
          agentId: jobId, ownerAddress: wallet, kind: "quantTrade", decisionId: crashIntent.record.journalKey,
          externalRef: {}, nativeSpendWei: 0n } }, nowMs: nowMs + 12_502 }),
      store.abortIntendedAction({ actionId: crashIntent.record.actionId, expectedRowVersion: crashIntent.record.rowVersion,
        expectedJournalState: "PENDING", nowMs: nowMs + 12_502 }),
    ]);
    assert.notEqual(pendingSenderRace[0].kind, "ok", "an existing journal cannot be claimed a second time");
    assert.equal(pendingSenderRace[1].kind, "ok");
    assert.equal((await store.getAction(crashIntent.record.actionId))?.state, "aborted");
    const terminalCrashAction = await store.getAction(crashIntent.record.actionId); assert(terminalCrashAction !== null);
    assert.deepEqual(await store.markAmbiguous({ actionId: terminalCrashAction.actionId,
      expectedRowVersion: terminalCrashAction.rowVersion, state: "unknown", cause: "late-provider-error", nowMs: nowMs + 12_503 }),
    { kind: "inconsistent", code: "revision-changed" });
    assert.equal((await stateSql.query<{ readonly state: string }>(`select state from execution_journal where idempotency_key=$1`,
      [crashIntent.record.journalKey])).rows[0]?.state, "ROLLED_BACK");
    const beforeAbsentRaceJob = await store.getJob(jobId);
    const beforeAbsentRaceCheck = (await store.listChecks(jobId)).find((row) => row.checkId === crashCheck.record.checkId);
    assert(beforeAbsentRaceJob !== null && beforeAbsentRaceCheck !== undefined);
    const absentIntent = await store.insertAction({ ...actionInput, checkId: crashCheck.record.checkId,
      sequence: beforeAbsentRaceJob.actionSequence + 1n, deadlineSec: actionInput.deadlineSec + 6,
      expectedJobRevision: beforeAbsentRaceJob.accountingRev, expectedCheckVersion: beforeAbsentRaceCheck.rowVersion,
      nowMs: nowMs + 12_600 });
    assert.equal(absentIntent.kind, "ok"); if (absentIntent.kind !== "ok") return;
    const absentRace = await Promise.all([
      store.beginJournalForIntended({ actionId: absentIntent.record.actionId,
        expectedRowVersion: absentIntent.record.rowVersion, claimGeneration: lease.claim.generation,
        journalBegin: { journal, sinceMs: 0, input: { idempotencyKey: absentIntent.record.journalKey,
          agentId: jobId, ownerAddress: wallet, kind: "quantTrade", decisionId: absentIntent.record.journalKey,
          externalRef: {}, nativeSpendWei: 0n } }, nowMs: nowMs + 12_601 }),
      store.abortIntendedAction({ actionId: absentIntent.record.actionId, expectedRowVersion: absentIntent.record.rowVersion,
        expectedJournalState: "absent", nowMs: nowMs + 12_601 }),
    ]);
    const afterAbsentRace = await store.getAction(absentIntent.record.actionId);
    assert(afterAbsentRace !== null);
    if (afterAbsentRace.state === "intended") {
      const journalRow = await journal.get(absentIntent.record.journalKey);
      assert(journalRow?.state === "PENDING");
      const recovered = await store.abortIntendedAction({ actionId: absentIntent.record.actionId,
        expectedRowVersion: afterAbsentRace.rowVersion, expectedJournalState: "PENDING", nowMs: nowMs + 12_602 });
      assert.equal(recovered.kind, "ok");
    }
    assert.notEqual(absentRace[0].kind === "ok" && (await store.getAction(absentIntent.record.actionId))?.state === "submitted", true);
    assert.equal((await store.getAction(absentIntent.record.actionId))?.state, "aborted");
    assert.notEqual((await store.beginJournalForIntended({ actionId: absentIntent.record.actionId,
      expectedRowVersion: absentIntent.record.rowVersion, claimGeneration: lease.claim.generation,
      journalBegin: { journal, sinceMs: 0, input: { idempotencyKey: absentIntent.record.journalKey,
        agentId: jobId, ownerAddress: wallet, kind: "quantTrade", decisionId: absentIntent.record.journalKey,
        externalRef: {}, nativeSpendWei: 0n } }, nowMs: nowMs + 12_603 })).kind, "ok",
    "a delayed sender cannot create a journal after the abort transaction committed");
    const beforeScheduledJob = await store.getJob(jobId); assert(beforeScheduledJob !== null);
    const staleVerdict = await store.beginCheck({ jobId, kind: "scheduled", slot: 9, state: "rebalancing", evidenceJson: "{}",
      expectedJobRevision: beforeScheduledJob.accountingRev + 1n, nowMs: nowMs + 12_999 });
    assert.equal(staleVerdict.kind, "conflict");
    assert.equal((await store.listChecks(jobId)).some((row) => row.slot === 9), false);
    const scheduled = await store.beginCheck({ jobId, kind: "scheduled", slot: 1, state: "rebalancing", evidenceJson: "{}",
      expectedJobRevision: beforeScheduledJob.accountingRev, nowMs: nowMs + 13_000 });
    assert.equal(scheduled.kind, "ok"); if (scheduled.kind !== "ok") return;
    assert.equal(scheduled.record.state, "rebalancing");
    const scheduledRebalancing = scheduled;
    const beforeSettlementJob = await store.getJob(jobId); assert(beforeSettlementJob !== null);
    const settleIntent = await store.insertAction({ ...actionInput, sequence: 6n, checkId: scheduled.record.checkId,
      deadlineSec: actionInput.deadlineSec + 7,
      path: [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB],
      pairAddresses: [getAddress(`0x${randomBytes(20).toString("hex")}`), getAddress(`0x${randomBytes(20).toString("hex")}`)],
      expectedJobRevision: beforeSettlementJob.accountingRev, expectedCheckVersion: scheduledRebalancing.record.rowVersion,
      nowMs: nowMs + 13_002 });
    assert.equal(settleIntent.kind, "ok"); if (settleIntent.kind !== "ok") return;
    const settleSubmitted = await store.markSubmitted({ actionId: settleIntent.record.actionId,
      expectedRowVersion: settleIntent.record.rowVersion, claimGeneration: lease.claim.generation,
      blockNumber: 100n, blockHash: `0x${"44".repeat(32)}` as Hex, nowMs: nowMs + 13_003,
      revalidate: async () => true });
    assert.equal(settleSubmitted.kind, "ok"); if (settleSubmitted.kind !== "ok") return;
    const receiptProof = brandVerifiedReceiptProof({ chainId: 56, txHash: `0x${"56".repeat(32)}` as Hex,
      blockNumber: 103n, blockHash: `0x${"57".repeat(32)}` as Hex, transactionIndex: 0n,
      wallet, nonce: 3n, keyHash: `0x${"58".repeat(32)}` as Hex, fillInWei: E18,
      fillOutWei: 2n * E18, swapLogIndices: [10n, 11n], proofDigest: `0x${"59".repeat(32)}` as Hex });
    const settled = await store.settleAction({ actionId: settleIntent.record.actionId,
      expectedRowVersion: settleSubmitted.record.rowVersion, proof: receiptProof,
      ownership: [10n, 11n].map((swapLogIndex) => ({ txHash: receiptProof.txHash, wallet,
        swapLogIndex: BigInt(swapLogIndex), journalKey: settleIntent.record.journalKey })),
      nowMs: nowMs + 13_004 });
    assert.equal(settled.kind, "ok");
    assert.equal((await stateSql.query(`select 1 from quant_receipt_ownership where tx_hash=$1 and trading_wallet=$2 and swap_log_index in (10,11)`,
      [receiptProof.txHash.toLowerCase(), wallet.toLowerCase()])).rows.length, 2);
    assert.equal((await store.getJob(jobId))?.managed?.WBNB, 2n * E18);
    const beforeSecondCheckJob = await store.getJob(jobId); assert(beforeSecondCheckJob !== null);
    const secondCheck = await store.beginCheck({ jobId, kind: "scheduled", slot: 2, state: "rebalancing", evidenceJson: "{}",
      expectedJobRevision: beforeSecondCheckJob.accountingRev, nowMs: nowMs + 13_006 });
    assert.equal(secondCheck.kind, "ok"); if (secondCheck.kind !== "ok") return;
    assert.equal(secondCheck.record.state, "rebalancing");
    const secondCheckActive = secondCheck;
    const beforeConflictJob = await store.getJob(jobId); assert(beforeConflictJob !== null);
    const conflictIntent = await store.insertAction({ ...actionInput, sequence: 7n, checkId: secondCheck.record.checkId,
      deadlineSec: actionInput.deadlineSec + 8,
      asset: "ETH", tokenOut: REBALANCE_ETH, path: [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_ETH],
      pairAddresses: [getAddress(`0x${randomBytes(20).toString("hex")}`), getAddress(`0x${randomBytes(20).toString("hex")}`)],
      quoteBlockNumber: 101n, quoteBlockHash: `0x${"55".repeat(32)}` as Hex,
      referenceBlockNumber: 101n, referenceBlockHash: `0x${"55".repeat(32)}` as Hex,
      expectedJobRevision: beforeConflictJob.accountingRev, expectedCheckVersion: secondCheckActive.record.rowVersion,
      nowMs: nowMs + 13_008 });
    assert.equal(conflictIntent.kind, "ok"); if (conflictIntent.kind !== "ok") return;
    const conflictSubmitted = await store.markSubmitted({ actionId: conflictIntent.record.actionId,
      expectedRowVersion: conflictIntent.record.rowVersion, claimGeneration: lease.claim.generation,
      blockNumber: 102n, blockHash: `0x${"66".repeat(32)}` as Hex, nowMs: nowMs + 13_009,
      revalidate: async () => true });
    assert.equal(conflictSubmitted.kind, "ok"); if (conflictSubmitted.kind !== "ok") return;
    const conflictingReceipt = brandVerifiedReceiptProof({ chainId: 56, txHash: receiptProof.txHash,
      blockNumber: receiptProof.blockNumber, blockHash: receiptProof.blockHash, transactionIndex: 0n,
      wallet, nonce: 3n, keyHash: `0x${"58".repeat(32)}` as Hex, fillInWei: E18,
      fillOutWei: 2n * E18, swapLogIndices: [12n, 11n], proofDigest: `0x${"5a".repeat(32)}` as Hex });
    const beforeConflictManaged = (await store.getJob(jobId))?.managed;
    const duplicateHop = await store.settleAction({ actionId: conflictIntent.record.actionId,
      expectedRowVersion: conflictSubmitted.record.rowVersion, proof: conflictingReceipt,
      ownership: [12n, 11n].map((swapLogIndex) => ({ txHash: conflictingReceipt.txHash, wallet,
        swapLogIndex, journalKey: conflictIntent.record.journalKey })), nowMs: nowMs + 13_010 });
    assert.deepEqual(duplicateHop, { kind: "inconsistent", code: "receipt-owned" });
    assert.deepEqual((await store.getJob(jobId))?.managed, beforeConflictManaged);
    assert.equal((await store.getAction(conflictIntent.record.actionId))?.state, "submitted");
    assert.equal((await stateSql.query(`select 1 from quant_receipt_ownership where tx_hash=$1 and trading_wallet=$2 and swap_log_index=12`,
      [conflictingReceipt.txHash.toLowerCase(), wallet.toLowerCase()])).rows.length, 0,
    "the first unique-hop ownership insert must roll back when a later constituent hop conflicts");
    const duplicateFirstHopProof = brandVerifiedReceiptProof({ chainId: 56, txHash: receiptProof.txHash,
      blockNumber: receiptProof.blockNumber, blockHash: receiptProof.blockHash, transactionIndex: 0n,
      wallet, nonce: 3n, keyHash: `0x${"58".repeat(32)}` as Hex, fillInWei: E18,
      fillOutWei: 2n * E18, swapLogIndices: [10n, 12n], proofDigest: `0x${"5c".repeat(32)}` as Hex });
    const duplicateFirst = await store.settleAction({ actionId: conflictIntent.record.actionId,
      expectedRowVersion: conflictSubmitted.record.rowVersion, proof: duplicateFirstHopProof,
      ownership: [10n, 12n].map((swapLogIndex) => ({ txHash: duplicateFirstHopProof.txHash, wallet,
        swapLogIndex, journalKey: conflictIntent.record.journalKey })), nowMs: nowMs + 13_010 });
    assert.deepEqual(duplicateFirst, { kind: "inconsistent", code: "receipt-owned" });
    assert.equal((await stateSql.query(`select 1 from quant_receipt_ownership where tx_hash=$1 and trading_wallet=$2 and swap_log_index=12`,
      [receiptProof.txHash.toLowerCase(), wallet.toLowerCase()])).rows.length, 0);
    const conflictUnknown = await store.markAmbiguous({ actionId: conflictIntent.record.actionId,
      expectedRowVersion: conflictSubmitted.record.rowVersion, state: "unknown", cause: "receipt-owned", nowMs: nowMs + 13_011 });
    assert.equal(conflictUnknown.kind, "ok"); if (conflictUnknown.kind !== "ok") return;
    await stateSql.query(`insert into execution_journal(idempotency_key,agent_id,owner_address,kind,state,external_ref)
      values($1,$2,$3,'quantTrade','UNKNOWN','{}'::jsonb)`, [conflictIntent.record.journalKey, jobId, wallet.toLowerCase()]);
    const preMigrationStatusPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true);
    const preMigrationStatus = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["status", "--job", jobId]), preMigrationStatusPorts);
    assert.match(safeQuantRebalanceCliJson(preMigrationStatus), /migration-not-installed/u);
    const preMigrationCensusPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true);
    const preMigrationCensus = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["wallet-census"]), preMigrationCensusPorts);
    assert.match(safeQuantRebalanceCliJson(preMigrationCensus), /migration-not-installed/u);

    await stateSql.query(`insert into quant_wallet_claim_migration(migration_version,census_digest,disposition_digest,installed_at_ms,installed_by)
      values(1,$1,$2,$3::bigint,'offline-test')`, [`0x${"61".repeat(32)}`, `0x${"62".repeat(32)}`, Date.now()]);
    const finalHash = `0x${"77".repeat(32)}` as Hex;
    const finalTime = BigInt(Math.floor(nowMs / 1_000) + 700);
    const balanceForToken = new Map<string, bigint>([
      [REBALANCE_USDC.toLowerCase(), 74n * E18], [REBALANCE_WBNB.toLowerCase(), 2n * E18],
      [REBALANCE_ETH.toLowerCase(), 0n], [REBALANCE_CAKE.toLowerCase(), 0n],
      ["0x55d398326f99059ff775485246999027b3197955", 0n],
    ]);
    const operatorReader = {
      async chainId() { return 56; },
      async finalizedBlock() { return { number: 200n, hash: finalHash, timestampSec: finalTime }; },
      async blockAt(number: bigint) {
        const hashes = new Map<bigint, Hex>([[100n, `0x${"44".repeat(32)}` as Hex],
          [101n, `0x${"55".repeat(32)}` as Hex], [102n, `0x${"66".repeat(32)}` as Hex],
          [103n, `0x${"57".repeat(32)}` as Hex], [200n, finalHash]]);
        return { number, hash: hashes.get(number) ?? finalHash, timestampSec: finalTime };
      },
      async tokenBalanceAtHash(token: `0x${string}`) { return balanceForToken.get(token.toLowerCase()) ?? 0n; },
    } as unknown as QuantChainReader;
    const cliPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true,
      { reader: operatorReader, provider: {} as WalletProvider, publicClient: {} as never });
    const rehearsal = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs([
      "resolve", "--action", conflictIntent.record.actionId, "--not-executed",
    ]), cliPorts);
    assert.equal(rehearsal.data.kind, "resolve");
    if (rehearsal.data.kind === "resolve") { assert.equal(rehearsal.data.verdict, "proven"); assert.equal(rehearsal.data.writes, false); }
    assert.equal((await store.getAction(conflictIntent.record.actionId))?.state, "unknown");
    const appliedResolution = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs([
      "resolve", "--action", conflictIntent.record.actionId, "--not-executed", "--yes-live",
    ]), cliPorts);
    assert.equal(appliedResolution.data.kind, "resolve");
    if (appliedResolution.data.kind === "resolve") { assert.equal(appliedResolution.data.verdict, "applied"); assert.equal(appliedResolution.data.writes, true); }
    assert.equal((await store.getAction(conflictIntent.record.actionId))?.state, "aborted");
    assert.deepEqual((await store.listChecks(jobId)).find((row) => row.checkId === conflictIntent.record.checkId)?.takenAssets, ["ETH"]);
    await cliPorts.close?.();
    await store.markEnded({ jobId, unresolved: false, nowMs: nowMs + 13_013 });
    const reportAttempt = await store.recordReportAttempt({ jobId, payloadDigest: `0x${"ab".repeat(32)}` as Hex,
      responseStatus: 0, notesApplied: null, nowMs: nowMs + 14_000 });
    assert.equal(reportAttempt.kind, "ok");
    assert.equal(reportAttempt.kind === "ok" ? reportAttempt.record.reportAttempts : -1, 1);
    assert.equal(await store.markReported({ jobId, nowMs: nowMs + 15_000 }), false);
    const statusPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true);
    const statusResult = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["status", "--job", jobId]), statusPorts);
    const statusJson = safeQuantRebalanceCliJson(statusResult);
    assert.match(statusJson, new RegExp(jobId, "u"));
    assert.match(statusJson, /"schema": "ready"/u);
    assert.match(statusJson, /managedBalances/u);
    assert.match(statusJson, /74000000000000000000/u);
    assert.match(statusJson, /"reportAttempts": 1/u);
    assert.match(statusJson, /"reportResponseStatus": 0/u);
    assert.doesNotMatch(statusJson, /SENSITIVE_CIPHERTEXT|SENSITIVE_SESSION_DESCRIPTOR/u);
    const censusPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true);
    const censusResult = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["wallet-census"]), censusPorts);
    const censusJson = safeQuantRebalanceCliJson(censusResult);
    assert.match(censusJson, new RegExp(jobId, "u"));
    assert.match(censusJson, /"migrationInstalled": true/u);
    assert.match(censusJson, /sessionExpirySec/u);
    assert.match(censusJson, /revokedAtMs/u);
    assert.match(censusJson, /actionStates/u);
    assert.match(censusJson, /actionSetDigest/u);
    assert.match(censusJson, /accountingDigest/u);
    assert.doesNotMatch(censusJson, /SENSITIVE_CIPHERTEXT|SENSITIVE_SESSION_DESCRIPTOR/u);
    const keyHashes: Hex[] = [];
    const keyStorePublicClient = {
      async readContract(args: { readonly functionName: string; readonly args: readonly [Address, Hex] }) {
        assert.equal(args.functionName, "isValidKey");
        keyHashes.push(args.args[1]);
        return true;
      },
    } as never;
    const retirementPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true,
      { reader: operatorReader, provider: {} as WalletProvider, publicClient: keyStorePublicClient });
    const retirement = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs([
      "retire", "--job", jobId, "--yes-live",
    ]), retirementPorts);
    const retirementJob = await store.getJob(jobId); assert(retirementJob !== null && retirementJob.sessionPublicKey !== null);
    const expectedRegistryKeyHash = keccak256(retirementJob.sessionPublicKey);
    const accountHash = accountKeyHashForAddress(publicKeyToAddress(retirementJob.sessionPublicKey));
    assert.equal(keyHashes[0], expectedRegistryKeyHash);
    assert.notEqual(keyHashes[0], accountHash);
    assert.equal(retirement.error, "key-still-valid");
    assert.equal((await claims.list()).find((row) => row.jobId === jobId)?.mode, "active");
    await retirementPorts.close?.();
    await withQuantRebalanceCensusSnapshot(stateSql, async (tx) => {
      const before = await tx.query<{ readonly row_version: number }>(`select row_version from quant_rebalance_jobs where job_id=$1`, [jobId]);
      await stateSql.query(`update quant_rebalance_jobs set row_version=row_version+1 where job_id=$1`, [jobId]);
      const after = await tx.query<{ readonly row_version: number }>(`select row_version from quant_rebalance_jobs where job_id=$1`, [jobId]);
      assert.equal(after.rows[0]?.row_version, before.rows[0]?.row_version);
    });
    await stateSql.query(`update quant_rebalance_jobs set row_version=(data_json->>'rowVersion')::int where job_id=$1`, [jobId]);
    await store.markEnded({ jobId, unresolved: true, nowMs: nowMs + 2_000 });
    assert.equal((await store.getJob(jobId))?.status, "ended-unresolved");
    assert.equal(await claims.releaseTerminal({ wallet, strategyKind: "rebalance", strategyId: wire.strategyId,
      jobId, generation: lease.claim.generation, nowMs: nowMs + 2_000 }), false);
    assert.equal((await claims.list()).find((row) => row.jobId === jobId)?.mode, "active");
    const competing = await claims.claimProvisional({ ...claimInput, jobId: `other-${suffix}`, attemptId: `later-${suffix}`, nowMs: Date.now() });
    assert.equal(competing.kind, "held");
    const deadKeyPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true,
      { reader: operatorReader, provider: {} as WalletProvider, publicClient: { async readContract() { return false; } } as never });
    const retired = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs([
      "retire", "--job", jobId, "--yes-live",
    ]), deadKeyPorts);
    assert.equal(retired.data.kind, "retire");
    if (retired.data.kind === "retire") assert.equal(retired.data.verdict, "applied");
    const afterRetirement = await store.getJob(jobId);
    assert.equal(afterRetirement?.status, "ended");
    const retainedClaim = (await claims.list()).find((row) => row.jobId === jobId);
    assert.equal(retainedClaim?.mode, "active");
    await deadKeyPorts.close?.();
    const successfulReportRetry = await store.recordReportAttempt({ jobId, payloadDigest: `0x${"ab".repeat(32)}` as Hex,
      responseStatus: 200, notesApplied: 1, nowMs: nowMs + 16_000 });
    assert.equal(successfulReportRetry.kind, "ok");
    assert.equal(await store.markReported({ jobId, nowMs: nowMs + 16_001 }), true);
    assert.equal((await claims.list()).find((row) => row.jobId === jobId)?.mode, "active",
      "a confirmed report does not release the claim while the linked journal stays UNKNOWN");
    const retainedStatusPorts = await createQuantRebalanceCliPorts({ DATABASE_URL: server.url } as NodeJS.ProcessEnv, true);
    const retainedStatusResult = await runQuantRebalanceOperatorCommand(parseQuantRebalanceOperatorArgs(["status", "--job", jobId]), retainedStatusPorts);
    const retainedStatusJson = safeQuantRebalanceCliJson(retainedStatusResult);
    assert.match(retainedStatusJson, /"status": "reported"/u);
    assert.match(retainedStatusJson, /"retiredAtMs":/u);
    assert.match(retainedStatusJson, /"retainedClaimReason": "not-executed-journal-unknown"/u);
    assert.match(retainedStatusJson, /"retainedClaimRemedy": "use-separate-wallet-for-next-job"/u);
    assert.match(retainedStatusJson, /"claimMode": "active"/u);
    await retainedStatusPorts.close?.();
  } finally {
    await Promise.all([claims.close(), store.close(), server.stop()]);
  }
});

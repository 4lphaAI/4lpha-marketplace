/** Independent FIX4 review: production CLI proof/apply with offline store and chain seams. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getAddress, type Hex } from "viem";
import { createQuantRebalanceCliPorts } from "../scripts/live-quant-rebalance.js";
import { PostgresQuantRebalanceStore } from "../src/store/quantRebalance.js";
import { PostgresQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { PostgresExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import { encodeJsonbParam } from "../src/store/codec.js";
import type { SqlClient } from "../src/store/sql.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import type { WalletProvider } from "../src/core/types.js";
import type { QuantRebalanceActionRow, QuantRebalanceJobRow } from "../src/quant/rebalanceTypes.js";
import { REBALANCE_USDC, REBALANCE_WBNB } from "../src/quant/rebalancePolicy.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const OTHER = `0x${"cd".repeat(32)}` as Hex;
const WALLET = getAddress(`0x${"11".repeat(20)}`);
const actual = { USDC: 100n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n };

async function fixture(t: TestContext) {
  let job: QuantRebalanceJobRow = {
    jobId: "proof-job", strategyId: "strategy", tradingWallet: WALLET, allocationWei: 10n, dailyCapWei: 20n,
    termDays: 30, startedAtMs: 1_000, endsAtMs: 100_000, sessionExpiresAtMs: 100_000, revokedAtMs: null,
    platformStatus: "ACTIVE", status: "ended-unresolved", wireJson: "{}", wireDigest: HASH,
    envelopeJson: null, envelopeId: null, admittedAtMs: 1_000, policyJson: "{}", policyDigest: HASH,
    tier: "low", sessionPublicKey: HASH, sessionExpirySec: 1_999, permissionsDigest: HASH, projectionDigest: HASH,
    descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]", claimGeneration: 3n,
    baselineBlock: 100n, baselineHash: HASH, baselineAtMs: 1_000,
    actualBaselineJson: encodeJsonbParam(actual),
    protectedBaselineJson: encodeJsonbParam({ ...actual, USDC: 90n }),
    managed: { USDC: 10n, WBNB: 0n, ETH: 0n, CAKE: 0n },
    costBasis: { WBNB: 0n, ETH: 0n, CAKE: 0n }, accountingRev: 1n, checkRev: 1n,
    nextEligibleSlot: 0, actionSequence: 1n, lastDeadlineSec: 1_500, bootstrapComplete: true,
    externalActivity: false, holdCode: null, holdEvidenceJson: null, reportAttempts: 0,
    reportPayloadDigest: null, reportResponseStatus: null, reportNotesApplied: null,
    reportedAtMs: null, retiredAtMs: null, retirementEvidenceJson: null, rowVersion: 2,
    createdAtMs: 1_000, updatedAtMs: 1_500,
  };
  let action: QuantRebalanceActionRow = {
    actionId: "0x01", journalKey: "0x01", jobId: job.jobId, checkId: "check", sequence: 1n,
    plannedAccountingRev: 1n, plannedCheckVersion: 1, state: "unknown", side: "buy", asset: "WBNB",
    tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB, path: [REBALANCE_USDC, REBALANCE_WBNB],
    pairAddresses: [getAddress(`0x${"22".repeat(20)}`)], amountInWei: 1n, minOutWei: 1n, quoteOutWei: 2n,
    deadlineSec: 1_500, callsJson: "[]", callsDigest: HASH, policyDigest: HASH, permissionsDigest: HASH,
    projectionDigest: HASH, claimGeneration: 3n, quoteBlockNumber: 101n, quoteBlockHash: HASH,
    quoteObservedAtMs: 1_500, referenceBlockNumber: 101n, referenceBlockHash: HASH,
    referenceObservedAtMs: 1_500, referenceEvidenceJson: "{}", gasEvidenceJson: "{}",
    preSubmitBlockNumber: 101n, preSubmitBlockHash: HASH, txHash: null, fillInWei: null, fillOutWei: null,
    receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null,
    reservationWei: 1n, failureCode: null, ambiguousCause: "relay-timeout", resolutionJson: null,
    rowVersion: 2, createdAtMs: 1_500, updatedAtMs: 1_500,
  };
  let settled: QuantRebalanceActionRow[] = [];
  const state = { block: 200n, hash: HASH, timestamp: 2_000n, usdc: 100n,
    journal: "UNKNOWN", keyValid: true, oldCanonicalHash: HASH, writes: [] as string[] };
  t.mock.method(PostgresQuantRebalanceStore.prototype, "schemaReady", async () => true);
  t.mock.method(PostgresQuantRebalanceStore.prototype, "getJob", async () => job);
  t.mock.method(PostgresQuantRebalanceStore.prototype, "getAction", async () => action);
  t.mock.method(PostgresQuantRebalanceStore.prototype, "listActions", async () => [action, ...settled]);
  t.mock.method(PostgresQuantRebalanceStore.prototype, "listChecks", async () => [{ checkId: "check", rowVersion: 2 }]);
  t.mock.method(PostgresQuantWalletClaimStore.prototype, "list", async () => []);
  t.mock.method(PostgresQuantWalletClaimStore.prototype, "migrationInstalled", async () => true);
  t.mock.method(PostgresQuantWalletClaimStore.prototype, "isActive", async () => true);
  t.mock.method(PostgresExecutionJournal, "attachExisting", async () => ({
    async get() { return { state: state.journal, externalRef: {} }; },
  }) as unknown as ExecutionJournal);
  t.mock.method(PostgresQuantRebalanceStore.prototype, "resolveNotExecuted",
    async (input: Parameters<PostgresQuantRebalanceStore["resolveNotExecuted"]>[0]) => {
      assert.equal(input.expectedJobVersion, job.rowVersion);
      assert.equal(input.expectedActionVersion, action.rowVersion);
      assert.equal(input.expectedCheckVersion, 2);
      state.writes.push(input.proof.evidenceJson);
      return { kind: "ok", record: { ...action, state: "aborted" } };
    });
  t.mock.method(PostgresQuantRebalanceStore.prototype, "retireJob",
    async (input: Parameters<PostgresQuantRebalanceStore["retireJob"]>[0]) => {
      assert.equal(input.expectedRowVersion, job.rowVersion, "simulate the existing store CAS");
      state.writes.push(input.proof.evidenceJson);
      return { kind: "ok", record: { ...job, status: "ended-unresolved" } };
    });
  const sql: SqlClient = {
    async query<Row>(query: string) {
      const rows = query.includes("quantRebalanceCli.tables") ? [{ grid_jobs: true, grid_actions: true,
        rebalance_jobs: true, rebalance_checks: true, rebalance_actions: true, claims: true,
        claim_migration: true, receipt_ownership: true, journal: true }]
        : query.includes("sharedWalletJobCount") ? [{ count: 1 }] : [];
      return { rows: rows as unknown as readonly Row[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) { return fn(sql); },
    async close() {},
  };
  const reader = {
    async chainId() { return 56; },
    async finalizedBlock() { return { number: state.block, hash: state.hash, timestampSec: state.timestamp }; },
    async blockAt(number: bigint) { return { number, hash: number === state.block ? state.hash
      : number === 200n ? state.oldCanonicalHash : HASH, timestampSec: state.timestamp }; },
    async tokenBalanceAtHash(token: string) { return token.toLowerCase() === REBALANCE_USDC.toLowerCase() ? state.usdc : 0n; },
  } as unknown as QuantChainReader;
  const ports = await createQuantRebalanceCliPorts({ DATABASE_URL: "offline-seam" }, true, {
    reader, provider: {} as WalletProvider,
    publicClient: { async readContract() { return state.keyValid; } } as never,
  }, sql);
  return { state, async preview(mode: "resolve" | "retire") {
    const result = mode === "resolve" ? await ports.resolve({ command: "resolve", actionId: action.actionId as Hex,
      proofMode: "not-executed", yesLive: false }) : await ports.retire({ command: "retire", jobId: job.jobId, yesLive: false });
    assert.equal(result.ok, true, result.code); return result;
  }, updateJob(change: Partial<QuantRebalanceJobRow>) { job = { ...job, ...change }; },
  updateAction(change: Partial<QuantRebalanceActionRow>) { action = { ...action, ...change }; },
  addOffsettingSettledActions() {
    const common = { ...action, state: "settled" as const, txHash: HASH, proofDigest: HASH,
      fillInWei: 1n, fillOutWei: 1n, receiptBlockNumber: 150n, receiptBlockHash: HASH };
    settled = [{ ...common, actionId: "0x02" }, { ...common, actionId: "0x03", side: "sell",
      tokenIn: REBALANCE_WBNB, tokenOut: REBALANCE_USDC }];
  } };
}

for (const mode of ["resolve", "retire"] as const) {
  test(`FIX4 ${mode}: unchanged finalized snapshot remains usable`, async (t) => {
    const f = await fixture(t); const preview = await f.preview(mode); await preview.apply();
    assert.equal(f.state.writes.length, 1);
  });
  test(`FIX4 ${mode}: advancing tip persists fresh verified evidence`, async (t) => {
    const f = await fixture(t); const preview = await f.preview(mode);
    f.state.block = 201n; f.state.hash = OTHER; f.state.timestamp = 2_001n;
    await preview.apply();
    assert.equal(f.state.writes.length, 1);
    const applied = JSON.parse(f.state.writes[0]!) as Record<string, unknown>;
    assert.equal(applied["finalizedBlock"], "201"); assert.equal(applied["finalizedHash"], OTHER);
    assert.equal(applied["finalizedTimestampSec"], "2001");
  });
  test(`FIX4 ${mode}: different finalized hash at same height must refuse`, async (t) => {
    const f = await fixture(t); const preview = await f.preview(mode); f.state.hash = OTHER;
    await assert.rejects(preview.apply(), /proof-stale/u);
    assert.equal(f.state.writes.length, 0);
  });
  test(`FIX4 ${mode}: advancing tip must refuse reorg of preview block`, async (t) => {
    const f = await fixture(t); const preview = await f.preview(mode);
    f.state.block = 201n; f.state.hash = OTHER; f.state.timestamp = 2_001n; f.state.oldCanonicalHash = OTHER;
    await assert.rejects(preview.apply(), /proof-stale/u);
    assert.equal(f.state.writes.length, 0);
  });
  for (const change of ["balance", "regressed-tip", "claim-generation", "deadline"] as const) {
    test(`FIX4 ${mode}: refuses changed ${change}`, async (t) => {
      const f = await fixture(t); const preview = await f.preview(mode);
      if (change === "balance") f.state.usdc = 99n;
      if (change === "regressed-tip") f.state.block = 199n;
      if (change === "claim-generation") f.updateJob({ claimGeneration: 4n });
      if (change === "deadline") f.state.timestamp = 1_500n;
      await assert.rejects(preview.apply(), /proof-stale/u); assert.equal(f.state.writes.length, 0);
    });
  }
}

test("FIX4 retire: changed preview job version must refuse even with identical proof facts", async (t) => {
  const f = await fixture(t); const preview = await f.preview("retire");
  f.updateJob({ rowVersion: 3, holdCode: "operator-hold" });
  await assert.rejects(preview.apply(), /proof-stale/u); assert.equal(f.state.writes.length, 0);
});
for (const change of ["journal", "action"] as const) {
  test(`FIX4 resolve: refuses changed ${change} state`, async (t) => {
    const f = await fixture(t); const preview = await f.preview("resolve");
    if (change === "journal") f.state.journal = "COMMITTED";
    else f.updateAction({ state: "settled" });
    await assert.rejects(preview.apply(), /proof-stale/u); assert.equal(f.state.writes.length, 0);
  });
}
test("FIX4 retire: fresh key must still be dead", async (t) => {
  const f = await fixture(t); f.state.keyValid = false; f.updateJob({ sessionExpirySec: 3_000 });
  const preview = await f.preview("retire"); f.state.keyValid = true;
  await assert.rejects(preview.apply(), /proof-stale/u); assert.equal(f.state.writes.length, 0);
});
test("FIX4 resolve: changed settled set refuses even when net token balances are unchanged", async (t) => {
  const f = await fixture(t); const preview = await f.preview("resolve"); f.addOffsettingSettledActions();
  await assert.rejects(preview.apply(), /proof-stale/u); assert.equal(f.state.writes.length, 0);
});

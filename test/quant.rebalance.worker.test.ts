import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import type { QuantRebalanceStore, RebalanceActionInsertInput } from "../src/store/quantRebalance.js";
import type { ExecutionJournal } from "../src/store/journal.js";
import { MemoryQuantWalletClaimStore } from "../src/store/quantWalletClaims.js";
import { MemoryQuantRebalanceStore } from "../src/store/quantRebalance.js";
import type { QuantRebalanceActionRow, QuantRebalanceCheckRow, QuantRebalanceJobRow, RebalanceBalanceVector } from "../src/quant/rebalanceTypes.js";
import type { QuantRebalanceCapabilityProfile } from "../src/quant/rebalanceConfig.js";
import { enumerateRebalanceRoutes, rebalancePathKey, requiredReferencePath } from "../src/quant/rebalanceRoutes.js";
import { HIGH_TIER, G2_FILE_HIGH_TIER, E18, REBALANCE_CAKE, REBALANCE_ETH, REBALANCE_USDC, REBALANCE_WBNB, rebalanceJobPolicyDigest, type RebalanceRiskAsset } from "../src/quant/rebalancePolicy.js";
import { G2_FINITE_JOB, loadG2FileProfiles } from "../src/quant/rebalanceSelftest.js";
import type { QuantRebalanceWorkerDeps, RebalancePortfolioObservation, RebalancePricedLeg } from "../src/quant/rebalanceWorker.js";
import { runQuantRebalanceWorkerOnce } from "../src/quant/rebalanceWorker.js";
import { quantRebalanceImmutableWireDigest } from "../src/quant/rebalanceWorker.js";
import { quantKeypairFromSeed } from "../src/quant/execute.js";
import { seal } from "../src/quant/envelope.js";
import { encodeJsonbParam } from "../src/store/codec.js";
import type { QuantJobRecord } from "../src/quant/types.js";
import type { WalletProvider } from "../src/core/types.js";
import type { QuantChainReader } from "../src/quant/readers.js";
import { applyVerifiedFill } from "../src/quant/rebalancePortfolio.js";

const WALLET = getAddress("0x1000000000000000000000000000000000000001");
const PAIR = getAddress("0x2000000000000000000000000000000000000001");
const HASH = `0x${"a".repeat(64)}` as Hex;
const NOW = 1_900_000_000_000;

function makeProfile(): QuantRebalanceCapabilityProfile {
  const executionRoutes = new Set<string>(); const referenceRoutes = new Set<string>();
  for (const asset of ["WBNB", "ETH", "CAKE"] as const) for (const direction of ["buy", "sell"] as const) {
    for (const route of enumerateRebalanceRoutes(asset, direction)) {
      executionRoutes.add(rebalancePathKey(route.path));
      const reference = requiredReferencePath(route.path);
      if (reference !== null) referenceRoutes.add(rebalancePathKey(reference));
    }
  }
  return {
    id: "offline-profile", capturedConfigProfileId: "offline-config", wireVersion: "fixture-v1",
    grantShapes: ["whole-contract", "selector-scoped"], toleratedGrantTargets: [],
    duplicateWholeGrantTargets: [], executionRoutes: [...executionRoutes],
    referenceRoutes: [...referenceRoutes], maximumExitGasUnits: 500_000n,
    indexingEvidenceDigest: HASH, reportEvidenceDigest: HASH,
  };
}

function makeJob(profile: QuantRebalanceCapabilityProfile, status: QuantRebalanceJobRow["status"]): QuantRebalanceJobRow {
  const startedAtMs = NOW - HIGH_TIER.intervalMs;
  const endsAtMs = startedAtMs + 30 * 24 * 60 * 60 * 1_000;
  const sessionExpiresAtMs = endsAtMs;
  const allocationWei = 75n * E18;
  const tier = HIGH_TIER;
  return {
    jobId: "scheduled-job", strategyId: "strategy-1", tradingWallet: WALLET,
    allocationWei, dailyCapWei: 100n * E18, termDays: 30,
    startedAtMs, endsAtMs, sessionExpiresAtMs, revokedAtMs: null,
    platformStatus: "ACTIVE", status, wireJson: "{}", wireDigest: HASH,
    envelopeJson: null, envelopeId: "env-1", admittedAtMs: startedAtMs,
    policyJson: "{}", policyDigest: rebalanceJobPolicyDigest({ capabilityProfileId: profile.id,
      jobId: "scheduled-job", strategyId: "strategy-1", allocationWei, tier,
      startedAtMs, endsAtMs, sessionExpiresAtMs }),
    tier: "high", sessionPublicKey: `0x${"1".repeat(130)}` as Hex, sessionExpirySec: Math.floor(sessionExpiresAtMs / 1_000),
    permissionsDigest: HASH, projectionDigest: HASH, descriptorJson: "{}", projectionJson: "{}", capRowsJson: "[]",
    claimGeneration: 1n, baselineBlock: 1_000n, baselineHash: HASH, baselineAtMs: startedAtMs,
    actualBaselineJson: encodeJsonbParam({ USDC: allocationWei, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }),
    protectedBaselineJson: encodeJsonbParam({ USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n }),
    managed: { USDC: 0n, WBNB: 30n * E18, ETH: 30n * E18, CAKE: 15n * E18 },
    costBasis: { WBNB: 30n * E18, ETH: 30n * E18, CAKE: 15n * E18 },
    accountingRev: 7n, checkRev: 4n, nextEligibleSlot: 1, actionSequence: 0n,
    lastDeadlineSec: 0, bootstrapComplete: true, externalActivity: false,
    holdCode: null, holdEvidenceJson: null, reportAttempts: 0, reportPayloadDigest: null,
    reportResponseStatus: null, reportNotesApplied: null, reportedAtMs: null, retiredAtMs: null,
    retirementEvidenceJson: null,
    rowVersion: 9, createdAtMs: startedAtMs, updatedAtMs: NOW,
  };
}

function observation(nowMs: number, drift: boolean): RebalancePortfolioObservation {
  const wbnbValue = (drift ? 38n : 30n) * E18;
  const balances: RebalanceBalanceVector = { USDC: 0n, WBNB: 30n * E18, ETH: 30n * E18, CAKE: 15n * E18, USDT: 0n };
  return {
    blockNumber: 50_000n, blockHash: HASH, observedAtMs: nowMs,
    actualBalances: balances,
    values: { USDC: 0n, WBNB: wbnbValue, ETH: 30n * E18, CAKE: 15n * E18 },
    marks: [
      { asset: "WBNB", quantityWei: balances.WBNB, usdcOutWei: wbnbValue, path: [REBALANCE_WBNB, REBALANCE_USDC], blockNumber: 50_000n, blockHash: HASH, observedAtMs: nowMs, pairAddresses: [PAIR], referenceEvidenceDigest: HASH },
      { asset: "ETH", quantityWei: balances.ETH, usdcOutWei: 30n * E18, path: [REBALANCE_ETH, REBALANCE_USDC], blockNumber: 50_000n, blockHash: HASH, observedAtMs: nowMs, pairAddresses: [getAddress("0x2000000000000000000000000000000000000002")], referenceEvidenceDigest: HASH },
      { asset: "CAKE", quantityWei: balances.CAKE, usdcOutWei: 15n * E18, path: [REBALANCE_CAKE, REBALANCE_USDC], blockNumber: 50_000n, blockHash: HASH, observedAtMs: nowMs, pairAddresses: [getAddress("0x2000000000000000000000000000000000000003")], referenceEvidenceDigest: HASH },
    ], nativeBalanceWei: E18, gasPriceWei: 1n,
  };
}

function checkRow(input: { readonly id: string; readonly kind: "bootstrap" | "scheduled"; readonly slot: number; readonly state: "held" | "rebalancing" | "done"; readonly rowVersion: number }): QuantRebalanceCheckRow {
  return { checkId: input.id, jobId: "scheduled-job", kind: input.kind, slot: input.slot,
    state: input.state, evidenceJson: "{}", takenAssets: [], rowVersion: input.rowVersion,
    createdAtMs: NOW, updatedAtMs: NOW };
}

function actionInsert(check: QuantRebalanceCheckRow, job: QuantRebalanceJobRow): RebalancePricedLeg {
  const action: Omit<RebalanceActionInsertInput, "expectedJobRevision" | "expectedCheckVersion" | "nowMs"> = {
    jobId: job.jobId, checkId: check.checkId, sequence: job.actionSequence + 1n,
    side: "sell", asset: "WBNB", tokenIn: REBALANCE_WBNB, tokenOut: REBALANCE_USDC,
    path: [REBALANCE_WBNB, REBALANCE_USDC], pairAddresses: [PAIR],
    amountInWei: E18, minOutWei: E18, quoteOutWei: E18, deadlineSec: 1_900_000_999,
    callsJson: "[]", callsDigest: HASH, policyDigest: job.policyDigest!,
    permissionsDigest: job.permissionsDigest!, projectionDigest: job.projectionDigest!,
    claimGeneration: job.claimGeneration!, quoteBlockNumber: 50_000n, quoteBlockHash: HASH,
    quoteObservedAtMs: NOW, referenceBlockNumber: 50_000n, referenceBlockHash: HASH,
    referenceObservedAtMs: NOW, referenceEvidenceJson: "{}", gasEvidenceJson: "{}",
    reservationWei: E18,
  };
  return { action, calls: [], requiredNativeWei: 1n };
}

function makeDeps(input: { readonly job: QuantRebalanceJobRow; readonly profile: QuantRebalanceCapabilityProfile; readonly now: () => number; readonly observe: () => RebalancePortfolioObservation; readonly priceCount: { value: number }; readonly submitCount: { value: number }; readonly recoveryCount?: { value: number }; readonly reportCount?: { value: number }; readonly jobReadFails?: boolean; readonly afterObservation?: () => void; readonly duringPricing?: () => void; readonly storeState: { job: QuantRebalanceJobRow; checks: QuantRebalanceCheckRow[]; actions: QuantRebalanceActionRow[] } }): QuantRebalanceWorkerDeps {
  const fakeStore = {
    async listWorkableJobs() { return [input.storeState.job]; },
    async discoverJob() { return input.storeState.job; },
    async listUnresolvedActions() { return input.storeState.actions.filter((row) => !["settled", "failed", "aborted"].includes(row.state)); },
    async refreshWire() { return input.storeState.job; },
    async getJob() { return input.storeState.job; },
    async listChecks() { return input.storeState.checks; },
    async listActions() { return input.storeState.actions; },
    async recordReportAttempt(args: { readonly payloadDigest: Hex; readonly responseStatus: number; readonly notesApplied: number | null; readonly nowMs: number }) {
      input.storeState.job = { ...input.storeState.job, reportAttempts: input.storeState.job.reportAttempts + 1,
        reportPayloadDigest: args.payloadDigest, reportResponseStatus: args.responseStatus, reportNotesApplied: args.notesApplied };
      return { kind: "ok" as const, record: input.storeState.job };
    },
    async markReported(args: { readonly nowMs: number }) {
      input.storeState.job = { ...input.storeState.job, status: "reported", reportedAtMs: args.nowMs };
      return true;
    },
    async setHold({ code }: { readonly code: string }) { input.storeState.job = { ...input.storeState.job, status: "held", holdCode: code }; },
    async beginCheck(args: { readonly jobId: string; readonly kind: "scheduled"; readonly slot: number; readonly state: "held" | "rebalancing"; readonly evidenceJson: string; readonly expectedJobRevision: bigint; readonly nowMs: number }) {
      if (input.storeState.job.accountingRev !== args.expectedJobRevision) return { kind: "conflict" as const, record: null };
      const row = checkRow({ id: `scheduled:${args.slot}`, kind: "scheduled", slot: args.slot, state: args.state, rowVersion: 1 });
      input.storeState.checks.push(row);
      input.storeState.job = { ...input.storeState.job, checkRev: input.storeState.job.checkRev + 1n, rowVersion: input.storeState.job.rowVersion + 1 };
      return { kind: "ok" as const, record: row };
    },
    async updateCheck(args: { readonly checkId: string; readonly expectedRowVersion: number; readonly state: "held" | "rebalancing" | "done"; readonly evidenceJson: string; readonly takenAssets: readonly RebalanceRiskAsset[]; readonly nowMs: number }) {
      const index = input.storeState.checks.findIndex((row) => row.checkId === args.checkId);
      const prior = input.storeState.checks[index]; if (prior === undefined) return { kind: "conflict" as const, record: null };
      const row = { ...prior, state: args.state, evidenceJson: args.evidenceJson, takenAssets: [...args.takenAssets], rowVersion: prior.rowVersion + 1 };
      input.storeState.checks[index] = row; return { kind: "ok" as const, record: row };
    },
    async insertAction(args: RebalanceActionInsertInput) {
      const currentCheck = input.storeState.checks.find((row) => row.checkId === args.checkId);
      if (input.storeState.job.accountingRev !== args.expectedJobRevision || currentCheck?.rowVersion !== args.expectedCheckVersion) {
        return { kind: "inconsistent" as const, code: "revision-changed" as const };
      }
      const item = args as unknown as Omit<QuantRebalanceActionRow, "actionId" | "journalKey" | "state" | "txHash" | "fillInWei" | "fillOutWei" | "receiptBlockNumber" | "receiptBlockHash" | "swapLogIndices" | "proofDigest" | "preSubmitBlockNumber" | "preSubmitBlockHash" | "failureCode" | "ambiguousCause" | "resolutionJson" | "rowVersion" | "createdAtMs" | "updatedAtMs">;
      const ordinal = input.storeState.actions.length + 1;
      const row: QuantRebalanceActionRow = { ...item, actionId: `action-${ordinal}`, journalKey: `journal-${ordinal}`, state: "intended", txHash: null, fillInWei: null, fillOutWei: null,
        receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null, preSubmitBlockNumber: null, preSubmitBlockHash: null,
        failureCode: null, ambiguousCause: null, resolutionJson: null, rowVersion: 1, createdAtMs: args.nowMs, updatedAtMs: args.nowMs };
      input.storeState.actions.push(row); input.storeState.job = { ...input.storeState.job, accountingRev: input.storeState.job.accountingRev + 1n, rowVersion: input.storeState.job.rowVersion + 1 };
      return { kind: "ok" as const, record: row };
    },
    async close() {},
  } as unknown as QuantRebalanceStore;
  return {
    store: fakeStore, claims: new MemoryQuantWalletClaimStore(undefined, true),
    journal: {} as ExecutionJournal, transport: {
      async inbox() { return { ok: true as const, data: { items: [], nextCursor: null } }; },
      async job() { if (input.jobReadFails === true) throw new Error("network"); const job = input.storeState.job; return { ok: true as const, data: {
        id: job.jobId, status: job.platformStatus, strategyId: job.strategyId, tradingWalletAddress: job.tradingWallet,
        allocationUWei: job.allocationWei, dailyCapUWei: job.dailyCapWei, termDays: job.termDays,
        startedAtMs: job.startedAtMs, endsAtMs: job.endsAtMs, sessionExpiresAtMs: job.sessionExpiresAtMs, revokedAtMs: job.revokedAtMs,
      } }; },
      config: async () => { throw new Error("unused"); }, agentKey: async () => { throw new Error("unused"); },
      registerKey: async () => { throw new Error("unused"); }, trades: async () => { throw new Error("unused"); }, report: async () => { throw new Error("unused"); },
    }, provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair: {} as never,
    strategyId: input.job.strategyId, agentId: "agent-1", capabilityProfile: input.profile,
    nowMs: input.now, intervalMs: HIGH_TIER.intervalMs,
    async admitChain() { return { ok: false as const, code: "unused" }; },
    async readPortfolio() { const snapshot = input.observe(); input.afterObservation?.(); return { ok: true as const, observation: snapshot }; },
    async priceLeg(args) { input.priceCount.value += 1; input.duringPricing?.(); return actionInsert(args.check, input.storeState.job); },
    async revalidatePlan() { return true; }, async recoverAction() { if (input.recoveryCount !== undefined) input.recoveryCount.value += 1; return { kind: "waiting" as const }; },
    async readCurrentWire() { const job = input.storeState.job; if (input.jobReadFails === true) return null;
      return { id: job.jobId, status: job.platformStatus, strategyId: job.strategyId, tradingWalletAddress: job.tradingWallet,
        allocationUWei: job.allocationWei, dailyCapUWei: job.dailyCapWei, termDays: job.termDays,
        startedAtMs: job.startedAtMs, endsAtMs: job.endsAtMs, sessionExpiresAtMs: job.sessionExpiresAtMs, revokedAtMs: job.revokedAtMs }; },
    async reportJob() { if (input.reportCount !== undefined) input.reportCount.value += 1; return { ok: true, payloadDigest: HASH, responseStatus: 200, notesApplied: 0 }; },
    async submitAction() { input.submitCount.value += 1; return { kind: "committed" as const, receipt: { status: "CONFIRMED" as const } }; },
  };
}

describe("Quant rebalancing worker schedule and hold fences", () => {
  it("values marks read after the cycle-start clock and continues planning", async () => {
    const profile = makeProfile(); const job = makeJob(profile, "admitted");
    const state = { job, checks: [checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "done", rowVersion: 2 })],
      actions: [] as QuantRebalanceActionRow[] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    let now = NOW;
    const deps = makeDeps({ job, profile, now: () => now,
      observe: () => { now = NOW + 1_879; return observation(now, true); },
      priceCount, submitCount, storeState: state });
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(report.notes.some((note) => note.includes("portfolio-mark-mismatch")), false);
    assert.equal(priceCount.value, 1);
    assert.equal(submitCount.value, 1);
  });

  it("still refuses marks older than 30 seconds at valuation time", async () => {
    const profile = makeProfile(); const job = makeJob(profile, "admitted");
    const state = { job, checks: [checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "done", rowVersion: 2 })],
      actions: [] as QuantRebalanceActionRow[] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    let now = NOW;
    const deps = makeDeps({ job, profile, now: () => now,
      observe: () => observation(NOW, true), afterObservation: () => { now = NOW + 30_001; },
      priceCount, submitCount, storeState: state });
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(report.notes.some((note) => note.includes("portfolio-mark-mismatch")), true);
    assert.equal(priceCount.value, 0);
    assert.equal(submitCount.value, 0);
  });

  it("completes bootstrap, consumes a below-threshold slot once, then submits one leg on the next crossing slot", async () => {
    const profile = makeProfile(); const start = NOW - HIGH_TIER.intervalMs;
    let now = start + HIGH_TIER.intervalMs;
    const job = makeJob(profile, "admitted");
    const bootstrap = checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "done", rowVersion: 2 });
    const state = { job, checks: [bootstrap], actions: [] as QuantRebalanceActionRow[] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    const deps = makeDeps({ job, profile, now: () => now, observe: () => observation(now, now >= start + HIGH_TIER.intervalMs * 2), priceCount, submitCount, storeState: state });

    const first = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(first.actions, 0);
    assert.equal(priceCount.value, 0);
    assert.equal(state.checks.find((row) => row.kind === "scheduled" && row.slot === 1)?.state, "held");

    now = start + HIGH_TIER.intervalMs * 2;
    const second = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(priceCount.value, 1);
    assert.equal(submitCount.value, 1);
    assert.equal(second.actions, 1);
    assert.equal(state.checks.find((row) => row.kind === "scheduled" && row.slot === 2)?.state, "rebalancing");
  });

  it("does not call pricing or submission for any held job, regardless of hold-code spelling", async () => {
    const profile = makeProfile(); const job = { ...makeJob(profile, "held"), holdCode: "baseline-unverified" };
    const state = { job, checks: [checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "rebalancing", rowVersion: 1 })], actions: [] as QuantRebalanceActionRow[] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    const deps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, true), priceCount, submitCount, storeState: state });
    await runQuantRebalanceWorkerOnce(deps);
    assert.equal(priceCount.value, 0);
    assert.equal(submitCount.value, 0);
  });

  it("recovers paused and ended-unresolved jobs before returning without planning or submitting", async () => {
    for (const status of ["paused", "ended-unresolved"] as const) {
      const profile = makeProfile(); const job = { ...makeJob(profile, status), holdCode: "manual-pause" };
      const check = checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "rebalancing", rowVersion: 1 });
      const unresolved = {
        ...actionInsert(check, job).action, actionId: `${status}-action`, journalKey: `${status}-journal`,
        plannedAccountingRev: job.accountingRev + 1n, plannedCheckVersion: check.rowVersion,
        state: "unknown" as const, txHash: null, fillInWei: null, fillOutWei: null,
        receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null,
        preSubmitBlockNumber: 1n, preSubmitBlockHash: HASH, failureCode: null, ambiguousCause: "other",
        resolutionJson: null, rowVersion: 2, createdAtMs: NOW, updatedAtMs: NOW,
      } as QuantRebalanceActionRow;
      const state = { job, checks: [check], actions: [unresolved] };
      const priceCount = { value: 0 }; const submitCount = { value: 0 }; const recoveryCount = { value: 0 };
      const deps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, true),
        priceCount, submitCount, recoveryCount, storeState: state });
      await runQuantRebalanceWorkerOnce(deps);
      assert.equal(recoveryCount.value, 1, status);
      assert.equal(priceCount.value, 0, status);
      assert.equal(submitCount.value, 0, status);
    }
  });

  it("recovers persisted actions before a failed TermiX job refresh", async () => {
    const profile = makeProfile(); const job = makeJob(profile, "admitted");
    const check = checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "rebalancing", rowVersion: 1 });
    const unresolved = { ...actionInsert(check, job).action, actionId: "unresolved", journalKey: "unresolved-journal",
      plannedAccountingRev: job.accountingRev + 1n, plannedCheckVersion: check.rowVersion,
      state: "unknown" as const, txHash: null, fillInWei: null, fillOutWei: null,
      receiptBlockNumber: null, receiptBlockHash: null, swapLogIndices: [], proofDigest: null,
      preSubmitBlockNumber: 1n, preSubmitBlockHash: HASH, failureCode: null, ambiguousCause: "other",
      resolutionJson: null, rowVersion: 2, createdAtMs: NOW, updatedAtMs: NOW } as QuantRebalanceActionRow;
    const state = { job, checks: [check], actions: [unresolved] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 }; const recoveryCount = { value: 0 };
    const deps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, true),
      priceCount, submitCount, recoveryCount, jobReadFails: true, storeState: state });
    await runQuantRebalanceWorkerOnce(deps);
    assert.equal(recoveryCount.value, 1);
    assert.equal(priceCount.value, 0);
    assert.equal(submitCount.value, 0);
  });

  it("does not create a check from an observation if accounting changed before atomic verdict insertion", async () => {
    const profile = makeProfile(); const job = makeJob(profile, "admitted");
    const bootstrap = checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "done", rowVersion: 2 });
    const state = { job, checks: [bootstrap], actions: [] as QuantRebalanceActionRow[] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    const deps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, true), priceCount, submitCount,
      storeState: state, afterObservation() { state.job = { ...state.job, accountingRev: state.job.accountingRev + 1n }; } });
    await runQuantRebalanceWorkerOnce(deps);
    assert.equal(state.checks.some((row) => row.kind === "scheduled"), false);
    assert.equal(priceCount.value, 0);
    assert.equal(submitCount.value, 0);
  });

  it("keeps the plan's original accounting and check revisions through route pricing", async () => {
    for (const changed of ["accounting" as const, "check" as const]) {
      const profile = makeProfile(); const job = makeJob(profile, "admitted");
      const bootstrap = checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0, state: "rebalancing", rowVersion: 2 });
      const state = { job, checks: [bootstrap], actions: [] as QuantRebalanceActionRow[] };
      const priceCount = { value: 0 }; const submitCount = { value: 0 };
      const deps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, true), priceCount, submitCount,
        storeState: state, duringPricing() {
          if (changed === "accounting") state.job = { ...state.job, accountingRev: state.job.accountingRev + 1n };
          else {
            const index = state.checks.length - 1;
            state.checks[index] = { ...state.checks[index]!, rowVersion: state.checks[index]!.rowVersion + 1 };
          }
        } });
      const result = await runQuantRebalanceWorkerOnce(deps);
      assert.equal(priceCount.value, 1, changed);
      assert.equal(state.actions.length, 0, changed);
      assert.equal(submitCount.value, 0, changed);
      assert(result.notes.some((note) => note.includes("intent-inconsistent")), changed);
    }
  });

  it("retries bounded reporting for ended jobs selected after restart", async () => {
    const profile = makeProfile(); const job = makeJob(profile, "ended");
    const state = { job, checks: [], actions: [] as QuantRebalanceActionRow[] };
    const priceCount = { value: 0 }; const submitCount = { value: 0 }; const reportCount = { value: 0 };
    const deps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, true),
      priceCount, submitCount, reportCount, storeState: state });
    await runQuantRebalanceWorkerOnce(deps);
    assert.equal(reportCount.value, 1);
    assert.equal(state.job.reportAttempts, 1);
    assert.equal(state.job.status, "reported");
    assert.equal(submitCount.value, 0);
  });

  it("submits the first bootstrap leg in the same cycle that admits the inbox job", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/quant/admissible-session.json", import.meta.url), "utf8")) as { session: Record<string, unknown> };
    const session = fixture.session;
    const keypair = quantKeypairFromSeed(`0x${"77".repeat(32)}`);
    const envelope = seal(JSON.stringify(session), keypair.publicKey);
    const now = (Number(session["expiry"]) - 2 * 86_400) * 1_000;
    const allocation = 10n * E18;
    const wire: QuantJobRecord = {
      id: "same-cycle-bootstrap", status: "ACTIVE", strategyId: "strategy-1",
      tradingWalletAddress: getAddress(String(session["walletAddress"])), allocationUWei: allocation,
      dailyCapUWei: 40n * E18, termDays: 30, startedAtMs: now - 1_000,
      endsAtMs: Number(session["expiry"]) * 1_000, sessionExpiresAtMs: Number(session["expiry"]) * 1_000,
      revokedAtMs: null,
    };
    const claims = new MemoryQuantWalletClaimStore(undefined, true);
    const store = new MemoryQuantRebalanceStore(claims);
    const profile = makeProfile(); const priceCount = { value: 0 }; const submitCount = { value: 0 };
    const deps: QuantRebalanceWorkerDeps = {
      store, claims, journal: {} as ExecutionJournal,
      transport: {
        async inbox() { return { ok: true, data: { items: [{ ...envelope, envelopeId: "env-bootstrap", quantJobId: wire.id }], nextCursor: null } }; },
        async job() { return { ok: true, data: wire }; },
        async config() { throw new Error("unused"); }, async agentKey() { throw new Error("unused"); },
        async registerKey() { throw new Error("unused"); }, async trades() { throw new Error("unused"); }, async report() { throw new Error("unused"); },
      },
      provider: {} as WalletProvider, reader: {} as QuantChainReader, keypair, strategyId: wire.strategyId,
      agentId: "agent-1", capabilityProfile: profile, nowMs: () => now, intervalMs: HIGH_TIER.intervalMs,
      async admitChain() { return { ok: true, baselineBlock: 100n, baselineHash: HASH, baselineAtMs: now,
        actualBalances: { USDC: allocation, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
        protectedBalances: { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n } }; },
      async readPortfolio() { return { ok: true, observation: { blockNumber: 100n, blockHash: HASH, observedAtMs: now,
        actualBalances: { USDC: allocation, WBNB: 0n, ETH: 0n, CAKE: 0n, USDT: 0n },
        values: { USDC: allocation, WBNB: 0n, ETH: 0n, CAKE: 0n }, marks: [], nativeBalanceWei: E18, gasPriceWei: 1n } }; },
      async priceLeg({ job, check, leg, observation: current }) {
        priceCount.value += 1;
        if (leg.kind !== "buy") return { hold: "unexpected-sell" };
        return { requiredNativeWei: 1n, calls: [], action: {
          jobId: job.jobId, checkId: check.checkId, sequence: job.actionSequence + 1n,
          side: "buy", asset: leg.asset, tokenIn: REBALANCE_USDC, tokenOut: REBALANCE_WBNB,
          path: [REBALANCE_USDC, REBALANCE_WBNB], pairAddresses: [PAIR], amountInWei: leg.amountInWei,
          minOutWei: 1n, quoteOutWei: E18, deadlineSec: Math.floor(now / 1_000) + 600,
          callsJson: "[]", callsDigest: HASH, policyDigest: job.policyDigest!,
          permissionsDigest: job.permissionsDigest!, projectionDigest: job.projectionDigest!,
          claimGeneration: job.claimGeneration!, quoteBlockNumber: current.blockNumber, quoteBlockHash: current.blockHash,
          quoteObservedAtMs: now, referenceBlockNumber: current.blockNumber, referenceBlockHash: current.blockHash,
          referenceObservedAtMs: now, referenceEvidenceJson: "{}", gasEvidenceJson: "{}", reservationWei: 1n,
        } };
      },
      async revalidatePlan() { return true; }, async recoverAction() { return { kind: "waiting" }; },
      async readCurrentWire() { return wire; },
      async reportJob() { return { ok: true, payloadDigest: HASH, responseStatus: 200, notesApplied: 0 }; },
      async submitAction() { submitCount.value += 1; return { kind: "committed", receipt: { status: "CONFIRMED" } }; },
    };
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(report.jobsSeen, 1);
    assert.equal(report.actions, 1);
    assert.equal(priceCount.value, 1);
    assert.equal(submitCount.value, 1);
    const admitted = await store.getJob(wire.id);
    assert.equal(admitted?.status, "admitted");
    assert.equal((await store.listChecks(wire.id))[0]?.kind, "bootstrap");
    assert.equal((await store.listActions(wire.id)).length, 1);
    assert.equal(admitted?.wireDigest, quantRebalanceImmutableWireDigest(wire));
  });
});

describe("G2 finite-v2 worker selection", () => {
  it("submits the fixed 20% WBNB sell at a due slot with zero market drift", async () => {
    const profile = loadG2FileProfiles(true).capability;
    const startedAtMs = NOW - G2_FILE_HIGH_TIER.intervalMs;
    const endsAtMs = startedAtMs + 2 * 86_400_000;
    const base = makeJob(profile, "admitted");
    const job: QuantRebalanceJobRow = { ...base, jobId: G2_FINITE_JOB.job, termDays: 2,
      startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs + 600_000,
      sessionExpirySec: Math.floor((endsAtMs + 600_000) / 1_000),
      managed: { USDC: 0n, WBNB: 30n * E18, ETH: 30n * E18, CAKE: 15n * E18 },
      nextEligibleSlot: 1,
      policyDigest: rebalanceJobPolicyDigest({ capabilityProfileId: profile.id, jobId: G2_FINITE_JOB.job,
        strategyId: base.strategyId, allocationWei: 75n * E18, tier: G2_FILE_HIGH_TIER,
        startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs + 600_000 }) };
    const assets = ["WBNB", "ETH", "CAKE"] as const;
    const amounts = [30n, 30n, 15n];
    const history = assets.map((asset, index) => ({ actionId: `bootstrap-${asset}`,
      journalKey: `journal-${asset}`, checkId: "bootstrap", sequence: BigInt(index + 1),
      side: "buy", asset, path: asset === "CAKE" ? [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE]
        : [REBALANCE_USDC, asset === "WBNB" ? REBALANCE_WBNB : REBALANCE_ETH],
      state: "settled", amountInWei: amounts[index]! * E18, fillInWei: amounts[index]! * E18,
      fillOutWei: amounts[index]! * E18, preSubmitBlockNumber: 1n, preSubmitBlockHash: HASH,
      txHash: `0x${String(index + 1).repeat(64)}` as Hex, proofDigest: HASH,
      ambiguousCause: "receipt-unverified" })) as unknown as QuantRebalanceActionRow[];
    const state = { job, checks: [checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0,
      state: "done", rowVersion: 2 })], actions: history };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    const baseDeps = makeDeps({ job, profile, now: () => NOW, observe: () => observation(NOW, false),
      priceCount, submitCount, storeState: state });
    const deps: QuantRebalanceWorkerDeps = { ...baseDeps,
      journal: { get: async (key: string) => ({ state: "COMMITTED",
        externalRef: { txHash: history.find((row) => row.journalKey === key)?.txHash } }) } as unknown as ExecutionJournal,
      verifyFiniteOwnership: async () => true,
      async priceLeg(input) {
        priceCount.value += 1;
        assert.equal(input.leg.kind, "sell");
        assert.equal(input.leg.asset, "WBNB");
        assert.equal(input.leg.amountInWei, 6n * E18);
        const priced = actionInsert(input.check, state.job);
        return { ...priced, action: { ...priced.action, amountInWei: input.leg.amountInWei } };
      },
    };
    const report = await runQuantRebalanceWorkerOnce(deps);
    assert.equal(report.actions, 1);
    assert.equal(priceCount.value, 1);
    assert.equal(submitCount.value, 1);
    assert.equal(state.checks.some((check) => check.kind === "scheduled" && check.slot === 1), true);
    assert.equal(state.actions.at(-1)?.amountInWei, 6n * E18);
  });

  it("walks all six finite checks after three buys, recovering from a fresh worker composition each stage", async () => {
    const profile = loadG2FileProfiles(true).capability;
    let now = NOW;
    const startedAtMs = NOW - 300_000;
    const endsAtMs = startedAtMs + 2 * 86_400_000;
    const base = makeJob(profile, "admitted");
    const job: QuantRebalanceJobRow = { ...base, jobId: G2_FINITE_JOB.job, termDays: 2,
      startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs + 600_000,
      sessionExpirySec: Math.floor((endsAtMs + 600_000) / 1_000),
      managed: { USDC: 0n, WBNB: 30n * E18, ETH: 30n * E18, CAKE: 15n * E18 },
      nextEligibleSlot: 1, actionSequence: 3n,
      policyDigest: rebalanceJobPolicyDigest({ capabilityProfileId: profile.id, jobId: G2_FINITE_JOB.job,
        strategyId: base.strategyId, allocationWei: 75n * E18, tier: G2_FILE_HIGH_TIER,
        startedAtMs, endsAtMs, sessionExpiresAtMs: endsAtMs + 600_000 }) };
    const bootstrapAssets = ["WBNB", "ETH", "CAKE"] as const;
    const bootstrapAmounts = [30n, 30n, 15n];
    const history = bootstrapAssets.map((asset, index) => ({ actionId: `bootstrap-${asset}`,
      journalKey: `journal-bootstrap-${asset}`, checkId: "bootstrap", sequence: BigInt(index + 1),
      side: "buy", asset, path: asset === "CAKE" ? [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE]
        : [REBALANCE_USDC, asset === "WBNB" ? REBALANCE_WBNB : REBALANCE_ETH],
      state: "settled", amountInWei: bootstrapAmounts[index]! * E18,
      fillInWei: bootstrapAmounts[index]! * E18, fillOutWei: bootstrapAmounts[index]! * E18,
      preSubmitBlockNumber: 1n, preSubmitBlockHash: HASH,
      txHash: `0x${String(index + 1).repeat(64)}` as Hex,
      proofDigest: HASH, ambiguousCause: "receipt-unverified" })) as unknown as QuantRebalanceActionRow[];
    const state = { job, checks: [checkRow({ id: "bootstrap", kind: "bootstrap", slot: 0,
      state: "done", rowVersion: 2 })], actions: history };
    const observe = (): RebalancePortfolioObservation => {
      const managed = state.job.managed!;
      const marks = bootstrapAssets.filter((asset) => managed[asset] > 0n).map((asset, index) => {
        const path = asset === "CAKE" ? [REBALANCE_CAKE, REBALANCE_WBNB, REBALANCE_USDC]
          : [asset === "WBNB" ? REBALANCE_WBNB : REBALANCE_ETH, REBALANCE_USDC];
        return { asset, quantityWei: managed[asset], usdcOutWei: managed[asset], path,
          blockNumber: 50_000n, blockHash: HASH, observedAtMs: now,
          pairAddresses: path.slice(1).map((_, pairIndex) => getAddress(`0x${String(index + pairIndex + 2).padStart(40, "0")}`)),
          referenceEvidenceDigest: HASH };
      });
      return { blockNumber: 50_000n, blockHash: HASH, observedAtMs: now,
        actualBalances: { ...managed, USDT: 0n }, values: { ...managed }, marks,
        nativeBalanceWei: E18, gasPriceWei: 1n };
    };
    const priceCount = { value: 0 }; const submitCount = { value: 0 };
    const makeFiniteDeps = (): QuantRebalanceWorkerDeps => {
      const baseDeps = makeDeps({ job: state.job, profile, now: () => now, observe,
        priceCount, submitCount, storeState: state });
      Object.assign(baseDeps.store, { async completeCheck(input: { readonly checkId: string;
        readonly nextEligibleSlot: number; readonly expectedCheckVersion: number }) {
        const index = state.checks.findIndex((check) => check.checkId === input.checkId);
        const check = state.checks[index];
        if (check === undefined || check.rowVersion !== input.expectedCheckVersion) return { kind: "conflict" };
        state.checks[index] = { ...check, state: "done", rowVersion: check.rowVersion + 1 };
        state.job = { ...state.job, nextEligibleSlot: input.nextEligibleSlot };
        return { kind: "ok", record: state.job };
      } });
      return { ...baseDeps,
        journal: { get: async (key: string) => {
          const row = state.actions.find((action) => action.journalKey === key);
          return row?.state === "settled" ? { state: "COMMITTED", externalRef: { txHash: row.txHash } } : null;
        } } as unknown as ExecutionJournal,
        verifyFiniteOwnership: async () => true,
        async priceLeg(input) {
          priceCount.value += 1;
          assert.ok(input.leg.kind === "buy" || input.leg.kind === "sell");
          const asset = input.leg.asset;
          const path = asset === "CAKE" ? [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE]
            : [REBALANCE_USDC, asset === "WBNB" ? REBALANCE_WBNB : REBALANCE_ETH];
          const selected = input.leg.kind === "buy" ? path : [...path].reverse();
          const priced = actionInsert(input.check, state.job);
          return { ...priced, action: { ...priced.action,
            side: input.leg.kind, asset, path: selected, tokenIn: selected[0]!, tokenOut: selected.at(-1)!,
            amountInWei: input.leg.amountInWei, reservationWei: input.leg.amountInWei,
            deadlineSec: Math.floor(now / 1_000) + 600 } };
        },
      };
    };
    for (let index = 0; index < 6; index += 1) {
      const report = await runQuantRebalanceWorkerOnce(makeFiniteDeps());
      assert.equal(report.actions, 1, `stage ${index}`);
      const intended = state.actions.at(-1)!;
      const fill = { side: intended.side, asset: intended.asset,
        fillInWei: intended.amountInWei, fillOutWei: intended.amountInWei };
      const settled = applyVerifiedFill(state.job.managed!, state.job.costBasis!, fill);
      state.actions[state.actions.length - 1] = { ...intended, state: "settled",
        preSubmitBlockNumber: 50_000n, preSubmitBlockHash: HASH,
        txHash: `0x${String(index + 4).repeat(64)}` as Hex,
        fillInWei: fill.fillInWei, fillOutWei: fill.fillOutWei,
        proofDigest: HASH, ambiguousCause: "receipt-unverified" };
      state.job = { ...state.job, managed: settled.managed, costBasis: settled.costBasis,
        accountingRev: state.job.accountingRev + 1n, actionSequence: intended.sequence };
      const checkIndex = state.checks.findIndex((check) => check.checkId === intended.checkId);
      const check = state.checks[checkIndex]!;
      state.checks[checkIndex] = { ...check, takenAssets: [intended.asset], rowVersion: check.rowVersion + 1 };
      const finish = await runQuantRebalanceWorkerOnce(makeFiniteDeps());
      if (index < 5) assert.equal(finish.actions, 0);
      now += 300_000;
    }
    assert.equal(state.checks.filter((check) => check.kind === "scheduled" && check.state === "done").length, 6);
    assert.equal(state.actions.filter((action) => action.state === "settled").length, 9);
    const final = await runQuantRebalanceWorkerOnce(makeFiniteDeps());
    assert.ok(final.notes.some((note) => note.endsWith(":finite-trading-complete")));
    assert.equal(priceCount.value, 6);
    assert.equal(submitCount.value, 6);
  });
});

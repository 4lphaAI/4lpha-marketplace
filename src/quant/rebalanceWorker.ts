/** Separate, one-leg-per-tick TermiX Quant rebalancing worker. */
import { randomUUID } from "node:crypto";
import { keccak256, stringToBytes, type Hex } from "viem";
import { rebalanceCanonicalEncode } from "./rebalanceCanonical.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { QuantWalletClaimStore } from "../store/quantWalletClaims.js";
import { REBALANCE_ACTION_TERMINAL, type QuantRebalanceStore, type RebalanceActionInsertInput } from "../store/quantRebalance.js";
import type { WalletProvider, WalletCall } from "../core/types.js";
import { admitRebalanceSession } from "./rebalanceAdmission.js";
import { G2_FILE_CAPABILITY_ID, G2_FINITE_CAPABILITY_ID, REBALANCE_VERSION, rebalanceTierForProfile, hasAnyRelativeDrift, nextEligibleSlot, rebalanceJobPolicyDigest, type RebalanceRiskAsset, type RebalanceTier } from "./rebalancePolicy.js";
import { planRebalanceLeg, valueManagedPortfolio, type AssetValues, type LiquidationMark, type PlannedRebalanceLeg } from "./rebalancePortfolio.js";
import { assessFiniteJournalHistory, deriveFiniteCloseoutState, deriveFiniteState,
  finiteJournalHistoryValid, planFiniteLeg } from "./rebalanceFinite.js";
import type { QuantKeypair } from "./envelope.js";
import type { QuantJobRecord, QuantSessionPlaintext } from "./types.js";
import type { QuantTransport } from "./termix.js";
import type { QuantChainReader } from "./readers.js";
import { QUANT_REBALANCE_CAPABILITY_PROFILES, type QuantRebalanceCapabilityProfile } from "./rebalanceConfig.js";
import { decodeJsonb } from "../store/codec.js";
import type { RebalanceBalanceVector, QuantRebalanceActionRow, QuantRebalanceCheckRow, QuantRebalanceJobRow } from "./rebalanceTypes.js";
import { openQuantRebalanceEnvelope, submitQuantRebalanceAction, type QuantRebalanceExecuteDeps, type QuantRebalanceSubmitOutcome } from "./execute.js";

export type RebalanceAdmissionEvidence = {
  readonly ok: true;
  readonly baselineBlock: bigint;
  readonly baselineHash: Hex;
  readonly baselineAtMs: number;
  readonly actualBalances: RebalanceBalanceVector;
  readonly protectedBalances: RebalanceBalanceVector;
};
export type RebalanceAdmissionEvidenceResult = RebalanceAdmissionEvidence | { readonly ok: false; readonly code: string };

export type RebalancePortfolioObservation = {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly observedAtMs: number;
  readonly actualBalances: RebalanceBalanceVector;
  readonly values: AssetValues;
  readonly marks: readonly LiquidationMark[];
  readonly nativeBalanceWei: bigint;
  readonly gasPriceWei: bigint;
};
export type PortfolioReadResult =
  | { readonly ok: true; readonly observation: RebalancePortfolioObservation }
  | { readonly ok: false; readonly code: string };

export type RebalancePricedLeg = {
  readonly action: Omit<RebalanceActionInsertInput, "expectedJobRevision" | "expectedCheckVersion" | "nowMs">;
  readonly calls: readonly WalletCall[];
  readonly requiredNativeWei: bigint;
};
export type RebalanceRecoveryResult =
  | { readonly kind: "settled" | "failed" | "resolved" }
  | { readonly kind: "waiting" | "needs-operator" };

export type QuantRebalanceWorkerDeps = {
  readonly store: QuantRebalanceStore;
  readonly claims: QuantWalletClaimStore;
  readonly journal: ExecutionJournal;
  readonly transport: QuantTransport;
  readonly provider: WalletProvider;
  readonly reader: QuantChainReader;
  readonly keypair: QuantKeypair;
  readonly strategyId: string;
  readonly agentId: string;
  readonly capabilityProfile: QuantRebalanceCapabilityProfile | null;
  readonly nowMs: () => number;
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
  /** Public read-only chain proof for one admitted grant. Never receives a plaintext key. */
  readonly admitChain: (input: { readonly job: QuantJobRecord; readonly session: Omit<QuantSessionPlaintext, "signerPrivateKey">; readonly grantShape: "selector-scoped" | "whole-contract"; readonly tier: RebalanceTier; readonly capabilityProfile: QuantRebalanceCapabilityProfile }) => Promise<RebalanceAdmissionEvidenceResult>;
  /** One finalized all-token snapshot; missing prices are refusals, not partial portfolio values. */
  readonly readPortfolio: (input: { readonly job: QuantRebalanceJobRow; readonly tier: RebalanceTier; readonly nowMs: number }) => Promise<PortfolioReadResult>;
  /** Compare candidates against disjoint references and include verified relay fees. */
  readonly priceLeg: (input: { readonly job: QuantRebalanceJobRow; readonly check: QuantRebalanceCheckRow; readonly leg: Exclude<PlannedRebalanceLeg, { readonly kind: "none" | "hold" }>; readonly observation: RebalancePortfolioObservation; readonly nowMs: number }) => Promise<RebalancePricedLeg | { readonly hold: string }>;
  /** Last hash-pinned route/reference, cash and balance read before submission. */
  readonly revalidatePlan: QuantRebalanceExecuteDeps["revalidatePlan"];
  /** Fresh authenticated TermiX public job wire at the submit boundary. */
  readonly readCurrentWire: QuantRebalanceExecuteDeps["readCurrentWire"];
  /** Offline provider seam; production composition leaves this unset. */
  readonly submitAction?: (input: { readonly job: QuantRebalanceJobRow; readonly action: QuantRebalanceActionRow; readonly calls: readonly WalletCall[]; readonly requiredNativeWei: bigint }) => Promise<QuantRebalanceSubmitOutcome>;
  /** Poll-only recovery; never submits or treats the indexer as settlement truth. */
  readonly recoverAction: (job: QuantRebalanceJobRow, action: QuantRebalanceActionRow) => Promise<RebalanceRecoveryResult>;
  /** Term-end report uses only locally verified settlement rows. */
  readonly reportJob: (job: QuantRebalanceJobRow, actions: readonly QuantRebalanceActionRow[]) => Promise<{
    readonly ok: boolean; readonly code?: string; readonly payloadDigest: Hex;
    readonly responseStatus: number; readonly notesApplied: number | null;
  }>;
  /** File-v2 only: independently re-read the durable receipt-ownership table. */
  readonly verifyFiniteOwnership?: (job: QuantRebalanceJobRow,
    actions: readonly QuantRebalanceActionRow[]) => Promise<boolean>;
  readonly verifyFiniteTerminal?: (job: QuantRebalanceJobRow, action: QuantRebalanceActionRow,
    cause: "submitted-failure" | "unknown-settled") => Promise<boolean>;
  readonly verifyFiniteExpiredAuthority?: (job: QuantRebalanceJobRow) => Promise<boolean>;
};

export type QuantRebalanceCycleReport = {
  readonly jobsSeen: number;
  readonly actions: number;
  readonly holds: number;
  readonly errors: number;
  readonly notes: readonly string[];
};

export function quantRebalanceImmutableWireDigest(job: QuantJobRecord): Hex {
  return keccak256(stringToBytes(rebalanceCanonicalEncode({
    id: job.id, strategyId: job.strategyId, tradingWalletAddress: job.tradingWalletAddress,
    allocationUWei: job.allocationUWei, dailyCapUWei: job.dailyCapUWei, termDays: job.termDays,
    startedAtMs: job.startedAtMs, endsAtMs: job.endsAtMs, sessionExpiresAtMs: job.sessionExpiresAtMs,
  })));
}
function toWire(job: QuantJobRecord) { return { ...job, envelope: null, wireDigest: quantRebalanceImmutableWireDigest(job) }; }
function wireRecord(job: QuantRebalanceJobRow): QuantJobRecord {
  return {
    id: job.jobId, status: job.platformStatus, strategyId: job.strategyId,
    tradingWalletAddress: job.tradingWallet, allocationUWei: job.allocationWei,
    dailyCapUWei: job.dailyCapWei, termDays: job.termDays, startedAtMs: job.startedAtMs,
    endsAtMs: job.endsAtMs, sessionExpiresAtMs: job.sessionExpiresAtMs, revokedAtMs: job.revokedAtMs,
  };
}
function safeCode(value: string): string { return /^[a-z0-9-]{1,64}$/u.test(value) ? value : "admission-refused"; }
function decodeBalanceVector(value: string | null): RebalanceBalanceVector | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(value) as unknown;
    if (typeof decoded !== "object" || decoded === null) return null;
    const record = decoded as Record<string, unknown>;
    const out: Record<string, bigint> = {};
    for (const asset of ["USDC", "WBNB", "ETH", "CAKE", "USDT"] as const) {
      const raw = record[asset];
      const amount = typeof raw === "object" && raw !== null && "$bigint" in raw
        ? BigInt(String((raw as Record<string, unknown>)["$bigint"])) : typeof raw === "bigint" ? raw : null;
      if (amount === null || amount < 0n || amount >= (1n << 256n)) return null;
      out[asset] = amount;
    }
    return out as unknown as RebalanceBalanceVector;
  } catch { return null; }
}
export function expectedBalances(job: QuantRebalanceJobRow): RebalanceBalanceVector | null {
  const protectedBalances = decodeBalanceVector(job.protectedBaselineJson);
  if (protectedBalances === null || job.managed === null) return null;
  return {
    USDC: protectedBalances.USDC + job.managed.USDC,
    WBNB: protectedBalances.WBNB + job.managed.WBNB,
    ETH: protectedBalances.ETH + job.managed.ETH,
    CAKE: protectedBalances.CAKE + job.managed.CAKE,
    USDT: protectedBalances.USDT,
  };
}
export function balancesEqual(left: RebalanceBalanceVector, right: RebalanceBalanceVector): boolean {
  return left.USDC === right.USDC && left.WBNB === right.WBNB && left.ETH === right.ETH
    && left.CAKE === right.CAKE && left.USDT === right.USDT;
}

/* G1: under the production composition (its capability profile is a registry entry) a reserved
 * G2/file identity, or an admitted row whose stored policy is not the active production one,
 * never reaches recovery, reporting, admission or planning. The file composition is unaffected. */
const G2_IDENTITY_PREFIX = "self-test-rebalance-g2";
const PRODUCTION_MISMATCH_HOLD = "production-profile-mismatch";
function productionComposition(deps: QuantRebalanceWorkerDeps): boolean {
  return deps.capabilityProfile !== null && QUANT_REBALANCE_CAPABILITY_PROFILES.includes(deps.capabilityProfile);
}
function reservedG2Identity(id: string): boolean { return id.startsWith(G2_IDENTITY_PREFIX); }

/** An unadmitted row has null policy fields by design; admission derives them. Only its identity is checked. */
function productionRowMatches(profile: QuantRebalanceCapabilityProfile, job: QuantRebalanceJobRow): boolean {
  if (reservedG2Identity(job.jobId) || reservedG2Identity(job.strategyId)) return false;
  if (job.status === "discovered") return true;
  if (job.policyJson === null || job.policyDigest === null) return false;
  try {
    const allocation = rebalanceTierForProfile(job.allocationWei, profile.id);
    const stored = decodeJsonb(JSON.parse(job.policyJson) as unknown) as
      { readonly process?: { readonly capabilityProfileId?: unknown; readonly version?: unknown };
        readonly job?: { readonly tierId?: unknown } };
    if (!allocation.ok || job.tier !== allocation.tier.id
      || stored.process?.capabilityProfileId !== profile.id || stored.process?.version !== REBALANCE_VERSION
      || stored.job?.tierId !== allocation.tier.id) return false;
    // Recomputed from this job's own immutable admission facts, never from a process-wide digest.
    return rebalanceJobPolicyDigest({ capabilityProfileId: profile.id, jobId: job.jobId, strategyId: job.strategyId,
      allocationWei: job.allocationWei, tier: allocation.tier, startedAtMs: job.startedAtMs,
      endsAtMs: job.endsAtMs, sessionExpiresAtMs: job.sessionExpiresAtMs }).toLowerCase() === job.policyDigest.toLowerCase();
  } catch { return false; }
}

async function discover(deps: QuantRebalanceWorkerDeps, notes: string[]): Promise<void> {
  let inbox;
  try { inbox = await deps.transport.inbox(deps.agentId); } catch { notes.push("inbox-unavailable"); return; }
  if (!inbox.ok) { notes.push(`inbox-${inbox.code}`); return; }
  const production = productionComposition(deps);
  for (const item of inbox.data.items) {
    if (item.quantJobId === "" || production && reservedG2Identity(item.quantJobId)) continue;
    let result;
    try { result = await deps.transport.job(item.quantJobId); } catch { notes.push("job-read-unavailable"); continue; }
    if (!result.ok) { notes.push(`job-${result.code}`); continue; }
    if (result.data.strategyId !== deps.strategyId) continue;
    await deps.store.discoverJob({ wire: toWire(result.data), envelopeJson: JSON.stringify(item), envelopeId: item.envelopeId, nowMs: deps.nowMs() });
  }
}

async function refreshWire(deps: QuantRebalanceWorkerDeps, job: QuantRebalanceJobRow): Promise<QuantRebalanceJobRow | null> {
  let result;
  try { result = await deps.transport.job(job.jobId); } catch { return null; }
  if (!result.ok || result.data.strategyId !== deps.strategyId) return null;
  return deps.store.discoverJob({ wire: toWire(result.data), envelopeJson: null, envelopeId: null, nowMs: deps.nowMs() });
}

async function releaseRefusedProvisional(
  deps: QuantRebalanceWorkerDeps,
  input: { readonly job: QuantRebalanceJobRow; readonly attemptId: string; readonly generation: bigint; readonly code: string },
  notes: string[],
): Promise<void> {
  const result = await deps.claims.releaseProvisional({
    wallet: input.job.tradingWallet, strategyKind: "rebalance", strategyId: input.job.strategyId,
    jobId: input.job.jobId, attemptId: input.attemptId, generation: input.generation,
    refusal: safeCode(input.code), nowMs: deps.nowMs(),
  });
  if (result === "claim-inconsistent") {
    await deps.store.setHold({ jobId: input.job.jobId, code: "claim-inconsistent", evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${input.job.jobId}:claim-inconsistent`);
  } else if (result === "released") {
    await deps.store.setHold({ jobId: input.job.jobId, code: safeCode(input.code), evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${input.job.jobId}:${safeCode(input.code)}`);
  }
}

async function admitDiscoveredJob(deps: QuantRebalanceWorkerDeps, initial: QuantRebalanceJobRow, notes: string[]): Promise<boolean> {
  const allocation = rebalanceTierForProfile(initial.allocationWei, deps.capabilityProfile?.id ?? "");
  if (!allocation.ok) {
    await deps.store.setHold({ jobId: initial.jobId, code: allocation.code, evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${initial.jobId}:${allocation.code}`); return false;
  }
  if (initial.strategyId !== deps.strategyId) {
    await deps.store.setHold({ jobId: initial.jobId, code: "wrong-strategy", evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${initial.jobId}:wrong-strategy`); return false;
  }
  const profile = deps.capabilityProfile;
  if (profile === null) {
    await deps.store.setHold({ jobId: initial.jobId, code: "capability-profile-unavailable", evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${initial.jobId}:capability-profile-unavailable`); return false;
  }
  if (profile.capturedConfigProfileId === "" || profile.executionRoutes.length === 0 || profile.referenceRoutes.length === 0) {
    await deps.store.setHold({ jobId: initial.jobId, code: "capability-profile-incomplete", evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${initial.jobId}:capability-profile-incomplete`); return false;
  }
  const current = await refreshWire(deps, initial);
  if (current === null) { notes.push(`${initial.jobId}:job-wire-unavailable`); return false; }
  const wire = wireRecord(current);
  if (wire.startedAtMs === null || wire.endsAtMs === null || wire.sessionExpiresAtMs === null || wire.dailyCapUWei < wire.allocationUWei) {
    await deps.store.setHold({ jobId: initial.jobId, code: "job-wire-invalid", evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${initial.jobId}:job-wire-invalid`); return false;
  }
  const attemptId = randomUUID();
  const acquired = await deps.claims.claimProvisional({
    wallet: current.tradingWallet, strategyKind: "rebalance", strategyId: current.strategyId,
    jobId: current.jobId, attemptId, nowMs: deps.nowMs(),
  });
  if (acquired.kind !== "acquired") {
    const code = acquired.kind === "held" ? "wallet-shared" : "claim-inconsistent";
    await deps.store.setHold({ jobId: current.jobId, code, evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${current.jobId}:${code}`); return false;
  }
  const opened = openQuantRebalanceEnvelope(current.envelopeJson, deps.keypair);
  if (!opened.ok) {
    await releaseRefusedProvisional(deps, { job: current, attemptId, generation: acquired.claim.generation, code: opened.code }, notes);
    return false;
  }
  const admission = admitRebalanceSession({ session: opened.session, job: wire, capabilityProfile: profile, nowMs: deps.nowMs() });
  if (!admission.ok) {
    await releaseRefusedProvisional(deps, { job: current, attemptId, generation: acquired.claim.generation, code: admission.code }, notes);
    return false;
  }
  let chain: RebalanceAdmissionEvidenceResult;
  try {
    const { signerPrivateKey: _privateKey, ...publicSession } = opened.session;
    void _privateKey;
    chain = await deps.admitChain({ job: wire, session: publicSession, grantShape: admission.grantShape, tier: admission.tier, capabilityProfile: profile });
  } catch { chain = { ok: false, code: "chain-admission-unreadable" }; }
  if (!chain.ok) {
    await releaseRefusedProvisional(deps, { job: current, attemptId, generation: acquired.claim.generation, code: chain.code }, notes);
    return false;
  }
  const expectedProtected: RebalanceBalanceVector = {
    USDC: chain.actualBalances.USDC - current.allocationWei,
    WBNB: chain.actualBalances.WBNB, ETH: chain.actualBalances.ETH,
    CAKE: chain.actualBalances.CAKE, USDT: chain.actualBalances.USDT,
  };
  if (chain.actualBalances.USDC < current.allocationWei
    || !balancesEqual(expectedProtected, chain.protectedBalances)
    || chain.baselineAtMs > deps.nowMs() || deps.nowMs() - chain.baselineAtMs > 30_000
    || chain.baselineBlock < 0n || !/^0x[0-9a-fA-F]{64}$/u.test(chain.baselineHash)) {
    await releaseRefusedProvisional(deps, { job: current, attemptId, generation: acquired.claim.generation, code: "baseline-unverified" }, notes);
    return false;
  }
  const promoted = await deps.claims.promoteProvisional({
    wallet: current.tradingWallet, strategyKind: "rebalance", strategyId: current.strategyId,
    jobId: current.jobId, attemptId, generation: acquired.claim.generation, nowMs: deps.nowMs(),
  }, async (tx) => {
    const result = await deps.store.admit({
      jobId: current.jobId, expectedRowVersion: current.rowVersion, attemptId,
      claimGeneration: acquired.claim.generation, policyJson: admission.policyJson,
      policyDigest: admission.policyDigest, tier: admission.tier.id,
      sessionPublicKey: admission.sessionPublicKey, sessionExpirySec: admission.sessionExpirySec,
      permissionsDigest: admission.permissionsDigest, projectionDigest: admission.projectionDigest,
      descriptorJson: admission.descriptorJson, projectionJson: admission.projectionJson,
      capRowsJson: admission.capRowsJson, baselineBlock: chain.baselineBlock,
      baselineHash: chain.baselineHash, baselineAtMs: chain.baselineAtMs,
      actualBaseline: chain.actualBalances, protectedBaseline: chain.protectedBalances, nowMs: deps.nowMs(),
    }, tx);
    return result.kind === "ok" ? result.record : null;
  });
  if (!promoted.promoted) {
    await releaseRefusedProvisional(deps, { job: current, attemptId, generation: acquired.claim.generation, code: "admission-conflict" }, notes);
    return false;
  }
  notes.push(`${current.jobId}:admitted`); return true;
}

async function finishCheck(deps: QuantRebalanceWorkerDeps, job: QuantRebalanceJobRow, check: QuantRebalanceCheckRow,
  tier: RebalanceTier, nowMs: number, bootstrapComplete: boolean, values: AssetValues): Promise<void> {
  const actions = (await deps.store.listActions(job.jobId)).filter((action) => action.checkId === check.checkId);
  const failedAssets = actions.filter((action) => action.state === "failed").map((action) => action.asset);
  const bootstrapPartial = bootstrapComplete && (failedAssets.length > 0 || hasAnyRelativeDrift(values, tier).length > 0);
  let priorEvidence: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(check.evidenceJson ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      if (typeof value["block"] === "string" && /^(0|[1-9][0-9]*)$/u.test(value["block"])) priorEvidence["block"] = value["block"];
      if (typeof value["hash"] === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value["hash"])) priorEvidence["hash"] = value["hash"];
    }
  } catch { /* incomplete prior evidence stays omitted */ }
  const evidenceJson = JSON.stringify({ ...priorEvidence,
    ...(bootstrapComplete ? { bootstrapStatus: bootstrapPartial ? "bootstrap-partial" : "bootstrap-complete" } : {}),
    takenAssets: [...check.takenAssets], failedAssets: [...new Set(failedAssets)],
    managed: { USDC: (job.managed?.USDC ?? 0n).toString(10), WBNB: (job.managed?.WBNB ?? 0n).toString(10),
      ETH: (job.managed?.ETH ?? 0n).toString(10), CAKE: (job.managed?.CAKE ?? 0n).toString(10) },
    markedValues: { USDC: values.USDC.toString(10), WBNB: values.WBNB.toString(10),
      ETH: values.ETH.toString(10), CAKE: values.CAKE.toString(10) },
    residualUsdcWei: (job.managed?.USDC ?? 0n).toString(10),
  });
  await deps.store.completeCheck({ checkId: check.checkId, expectedJobRevision: job.accountingRev,
    expectedCheckVersion: check.rowVersion, nextEligibleSlot: nextEligibleSlot(job.startedAtMs, nowMs, tier.intervalMs),
    bootstrapComplete, evidenceJson, nowMs });
}

async function reportEndedJob(deps: QuantRebalanceWorkerDeps, ended: QuantRebalanceJobRow, notes: string[]): Promise<void> {
  // Eligibility comes from the persisted, fenced end result, read before the
  // outward call: the status first (an ended job admits no new action), then
  // the complete action set, every member of which must be definitive.
  const job = await deps.store.getJob(ended.jobId);
  if (job === null || job.status !== "ended" || job.reportedAtMs !== null) { notes.push(`${ended.jobId}:report-ineligible`); return; }
  if (job.reportAttempts >= 24) { notes.push(`${job.jobId}:report-exhausted`); return; }
  const actions = await deps.store.listActions(job.jobId);
  if (actions.some((action) => !REBALANCE_ACTION_TERMINAL.has(action.state))) { notes.push(`${job.jobId}:action-unresolved`); return; }
  const report = await deps.reportJob(job, actions);
  const recorded = await deps.store.recordReportAttempt({ jobId: job.jobId, payloadDigest: report.payloadDigest,
    responseStatus: report.responseStatus, notesApplied: report.notesApplied, nowMs: deps.nowMs() });
  if (report.ok && recorded.kind === "ok" && await deps.store.markReported({ jobId: job.jobId, nowMs: deps.nowMs() })) {
    notes.push(`${job.jobId}:reported`);
  } else notes.push(`${job.jobId}:${safeCode(report.code ?? (recorded.kind === "ok" ? "report-retry" : "report-record-conflict"))}`);
}

/** Explicit file-v2 closeout entry; never reachable from the trading cycle. */
export async function reportFiniteEndedJobOnce(deps: QuantRebalanceWorkerDeps, jobId: string): Promise<readonly string[]> {
  if (deps.capabilityProfile?.id !== G2_FINITE_CAPABILITY_ID) throw new Error("finite-report-profile-required");
  const job = await deps.store.getJob(jobId);
  if (job === null || job.status !== "ended" || job.reportedAtMs !== null) throw new Error("finite-report-ineligible");
  const actions = await deps.store.listActions(jobId);
  const journalHistory = await assessFiniteJournalHistory(actions, deps.journal);
  const state = deriveFiniteCloseoutState(actions, await deps.store.listChecks(jobId),
    journalHistory.recoveredUnknownActionIds);
  if (state.kind === "invalid" || job.managed === null
    || state.managed.USDC !== job.managed.USDC || state.managed.WBNB !== job.managed.WBNB
    || state.managed.ETH !== job.managed.ETH || state.managed.CAKE !== job.managed.CAKE
    || !journalHistory.valid
    || deps.verifyFiniteOwnership === undefined || !await deps.verifyFiniteOwnership(job, actions)) {
    throw new Error("finite-report-history-invalid");
  }
  if (state.kind === "incomplete") {
    if (deps.nowMs() < job.sessionExpiresAtMs) throw new Error("finite-incomplete-before-expiry");
    if (deps.verifyFiniteExpiredAuthority === undefined || !await deps.verifyFiniteExpiredAuthority(job)) {
      throw new Error("finite-expiry-unproven");
    }
    if (state.cause !== "no-send-exhausted") {
      const terminal = actions.find((action) => action.actionId === state.terminalActionId);
      if (terminal === undefined || deps.verifyFiniteTerminal === undefined
        || !await deps.verifyFiniteTerminal(job, terminal, state.cause)) {
        throw new Error("finite-terminal-proof-invalid");
      }
    }
  }
  const notes: string[] = [];
  await reportEndedJob(deps, job, notes);
  return notes;
}

async function processAdmittedJob(deps: QuantRebalanceWorkerDeps, initial: QuantRebalanceJobRow, notes: string[]): Promise<{ readonly actions: number; readonly holds: number; readonly errors: number }> {
  let job = initial;
  const finite = deps.capabilityProfile?.id === G2_FINITE_CAPABILITY_ID;
  const unresolved = (await deps.store.listUnresolvedActions(job.jobId));
  if (unresolved.length > 1) {
    await deps.store.setHold({ jobId: job.jobId, code: "multiple-unresolved-actions", evidenceJson: null, nowMs: deps.nowMs() });
    notes.push(`${job.jobId}:multiple-unresolved-actions`); return { actions: 0, holds: 1, errors: 0 };
  }
  if (unresolved[0] !== undefined) {
    let recovered: RebalanceRecoveryResult;
    try { recovered = await deps.recoverAction(job, unresolved[0]); } catch { recovered = { kind: "waiting" }; }
    if (recovered.kind === "waiting" || recovered.kind === "needs-operator") {
      if ((deps.capabilityProfile?.id === G2_FILE_CAPABILITY_ID || finite) && job.endsAtMs <= deps.nowMs()) {
        await deps.store.markEnded({ jobId: job.jobId, unresolved: true, nowMs: deps.nowMs() });
      }
      notes.push(`${job.jobId}:${recovered.kind === "waiting" ? "action-unresolved" : "needs-operator"}`);
      return { actions: 0, holds: 1, errors: 0 };
    }
    job = await deps.store.getJob(job.jobId) ?? job;
  }
  // Reconcile from persisted immutable facts before depending on another
  // TermiX read. An API outage must not block an already-persisted receipt.
  const refreshed = await refreshWire(deps, job);
  if (refreshed === null) { notes.push(`${job.jobId}:wire-read-unavailable`); return { actions: 0, holds: 1, errors: 0 }; }
  job = refreshed;
  const nowMs = deps.nowMs();
  if (job.revokedAtMs !== null || job.sessionExpiresAtMs <= nowMs || job.endsAtMs <= nowMs) {
    const pending = (await deps.store.listUnresolvedActions(job.jobId)).length > 0;
    await deps.store.markEnded({ jobId: job.jobId, unresolved: pending, nowMs });
    // The end transaction rechecks under the wallet/job fence; only its
    // persisted status decides release and reporting, never `pending`.
    job = await deps.store.getJob(job.jobId) ?? job;
    if (job.status === "ended" && job.claimGeneration !== null) await deps.claims.releaseTerminal({ wallet: job.tradingWallet,
      strategyKind: "rebalance", strategyId: job.strategyId, jobId: job.jobId,
      generation: job.claimGeneration, nowMs });
    if (job.status === "ended" && !finite) await reportEndedJob(deps, job, notes);
    if (job.status === "ended" && finite) notes.push(`${job.jobId}:finite-closeout-required`);
    return { actions: 0, holds: 1, errors: 0 };
  }
  if (job.status === "ended-unresolved") {
    if ((await deps.store.listUnresolvedActions(job.jobId)).length > 0) return { actions: 0, holds: 1, errors: 0 };
    await deps.store.markEnded({ jobId: job.jobId, unresolved: false, nowMs: deps.nowMs() });
    job = await deps.store.getJob(job.jobId) ?? job;
    if (job.status !== "ended") return { actions: 0, holds: 1, errors: 0 };
    if (job.claimGeneration !== null) await deps.claims.releaseTerminal({ wallet: job.tradingWallet,
      strategyKind: "rebalance", strategyId: job.strategyId, jobId: job.jobId,
      generation: job.claimGeneration, nowMs: deps.nowMs() });
    if (!finite) await reportEndedJob(deps, job, notes);
    else notes.push(`${job.jobId}:finite-closeout-required`);
    return { actions: 0, holds: 0, errors: 0 };
  }
  if (job.status === "ended") {
    if (!finite && job.reportedAtMs === null && job.reportAttempts < 24) await reportEndedJob(deps, job, notes);
    return { actions: 0, holds: 0, errors: 0 };
  }
  if (["paused", "held", "ended", "ended-unresolved", "reported"].includes(job.status)) {
    if (job.status === "held") notes.push(`${job.jobId}:${safeCode(job.holdCode ?? "held")}`);
    return { actions: 0, holds: job.status === "held" ? 1 : 0, errors: 0 };
  }
  if (job.holdCode === "external-activity" || job.holdCode === "wire-changed" || job.holdCode === "claim-inconsistent") {
    notes.push(`${job.jobId}:${job.holdCode}`); return { actions: 0, holds: 1, errors: 0 };
  }
  const profile = deps.capabilityProfile; const allocation = rebalanceTierForProfile(job.allocationWei, profile?.id ?? "");
  if (profile === null || !allocation.ok || job.policyDigest === null || job.claimGeneration === null) {
    notes.push(`${job.jobId}:policy-or-profile-unavailable`); return { actions: 0, holds: 1, errors: 0 };
  }
  const expectedPolicy = rebalanceJobPolicyDigest({ capabilityProfileId: profile.id, jobId: job.jobId,
    strategyId: job.strategyId, allocationWei: job.allocationWei, tier: allocation.tier,
    startedAtMs: job.startedAtMs, endsAtMs: job.endsAtMs, sessionExpiresAtMs: job.sessionExpiresAtMs });
  if (expectedPolicy.toLowerCase() !== job.policyDigest.toLowerCase()) {
    await deps.store.setHold({ jobId: job.jobId, code: "policy-changed", evidenceJson: null, nowMs });
    notes.push(`${job.jobId}:policy-changed`); return { actions: 0, holds: 1, errors: 0 };
  }
  let checks = await deps.store.listChecks(job.jobId);
  const finiteActions = finite ? await deps.store.listActions(job.jobId) : [];
  if (finite && (!await finiteJournalHistoryValid(finiteActions, deps.journal)
    || deps.verifyFiniteOwnership === undefined || !await deps.verifyFiniteOwnership(job, finiteActions))) {
    await deps.store.setHold({ jobId: job.jobId, code: "finite-journal-inconsistent", evidenceJson: null, nowMs });
    notes.push(`${job.jobId}:finite-journal-inconsistent`); return { actions: 0, holds: 1, errors: 0 };
  }
  const finiteState = finite ? deriveFiniteState(finiteActions, checks) : null;
  if (finiteState?.kind === "stop") {
    await deps.store.setHold({ jobId: job.jobId, code: finiteState.code, evidenceJson: null, nowMs });
    notes.push(`${job.jobId}:${finiteState.code}`); return { actions: 0, holds: 1, errors: 0 };
  }
  if (finiteState !== null && job.managed !== null && (finiteState.managed.USDC !== job.managed.USDC
    || finiteState.managed.WBNB !== job.managed.WBNB || finiteState.managed.ETH !== job.managed.ETH
    || finiteState.managed.CAKE !== job.managed.CAKE)) {
    await deps.store.setHold({ jobId: job.jobId, code: "finite-accounting-inconsistent", evidenceJson: null, nowMs });
    notes.push(`${job.jobId}:finite-accounting-inconsistent`); return { actions: 0, holds: 1, errors: 0 };
  }
  let check: QuantRebalanceCheckRow | undefined = job.bootstrapComplete
    ? checks.filter((row) => row.kind === "scheduled" && row.state === "rebalancing")
      .sort((a, b) => b.slot - a.slot)[0]
    : checks.find((row) => row.kind === "bootstrap");
  let scheduledDue = false;
  const dueSlot = Math.floor((nowMs - job.startedAtMs) / allocation.tier.intervalMs);
  if (check === undefined && job.bootstrapComplete && finiteState?.kind !== "complete") {
    if (dueSlot < job.nextEligibleSlot) return { actions: 0, holds: 0, errors: 0 };
    const existingSlot = checks.find((row) => row.kind === "scheduled" && row.slot === dueSlot);
    if (existingSlot !== undefined) return { actions: 0, holds: 0, errors: 0 };
    scheduledDue = true;
  }
  const snapshot = await deps.readPortfolio({ job, tier: allocation.tier, nowMs });
  if (!snapshot.ok) { notes.push(`${job.jobId}:${safeCode(snapshot.code)}`); return { actions: 0, holds: 1, errors: 0 }; }
  const expected = expectedBalances(job);
  if (expected === null || !balancesEqual(expected, snapshot.observation.actualBalances)) {
    await deps.store.setHold({ jobId: job.jobId, code: "external-activity", evidenceJson: JSON.stringify({ block: snapshot.observation.blockNumber.toString(10), hash: snapshot.observation.blockHash }), nowMs });
    notes.push(`${job.jobId}:external-activity`); return { actions: 0, holds: 1, errors: 0 };
  }
  const valued = valueManagedPortfolio({ managed: job.managed ?? { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n },
    marks: snapshot.observation.marks, expectedBlockNumber: snapshot.observation.blockNumber,
    expectedBlockHash: snapshot.observation.blockHash, nowMs: deps.nowMs() });
  if (!valued.ok) { notes.push(`${job.jobId}:${valued.code}`); return { actions: 0, holds: 1, errors: 0 }; }
  if (finiteState?.kind === "complete") {
    if (check?.state === "rebalancing" && check.kind === "scheduled" && check.takenAssets.length === 1) {
      await finishCheck(deps, job, check, allocation.tier, deps.nowMs(), false, valued.values);
      checks = await deps.store.listChecks(job.jobId);
    }
    const completedChecks = checks.filter((row) => row.kind === "scheduled" && row.state === "done");
    const complete = checks.some((row) => row.kind === "bootstrap" && row.state === "done")
      && completedChecks.length === 6 && completedChecks.every((row) => row.takenAssets.length === 1)
      && !checks.some((row) => row.state === "rebalancing");
    if (!complete) { notes.push(`${job.jobId}:finite-check-incomplete`); return { actions: 0, holds: 1, errors: 0 }; }
    notes.push(`${job.jobId}:finite-trading-complete`); return { actions: 0, holds: 0, errors: 0 };
  }
  if (scheduledDue) {
    const crossed = finite || hasAnyRelativeDrift(valued.values, allocation.tier).length > 0;
    const inserted = await deps.store.beginCheck({ jobId: job.jobId, kind: "scheduled", slot: dueSlot,
      state: crossed ? "rebalancing" : "held",
      evidenceJson: JSON.stringify({ block: snapshot.observation.blockNumber.toString(10), hash: snapshot.observation.blockHash,
        accountingRev: job.accountingRev.toString(10) }), expectedJobRevision: job.accountingRev, nowMs });
    if (inserted.kind !== "ok") return { actions: 0, holds: 0, errors: 0 };
    if (!crossed) return { actions: 0, holds: 0, errors: 0 };
    check = inserted.record;
  }
  if (check === undefined) return { actions: 0, holds: 1, errors: 0 };
  if (check.state === "held" || check.state === "done") return { actions: 0, holds: 0, errors: 0 };
  const mode = check.kind === "bootstrap" ? "bootstrap" : "continuation";
  const leg = finite && check.kind === "scheduled" && finiteState?.kind === "ready"
    ? check.takenAssets.length > 0 ? { kind: "none", reason: "already-balanced" } as const
      : planFiniteLeg(job, finiteState)
    : planRebalanceLeg({ managed: job.managed ?? { USDC: 0n, WBNB: 0n, ETH: 0n, CAKE: 0n },
      values: valued.values, tier: allocation.tier, takenAssets: new Set<RebalanceRiskAsset>(check.takenAssets), checkMode: mode });
  if (leg.kind === "none" || leg.kind === "hold") {
    await finishCheck(deps, job, check, allocation.tier, deps.nowMs(), check.kind === "bootstrap", valued.values);
    if (check.kind === "bootstrap" && (check.takenAssets.length > 0 || leg.kind === "hold")) notes.push(`${job.jobId}:bootstrap-partial`);
    if (leg.kind === "hold") notes.push(`${job.jobId}:${leg.reason}`);
    return { actions: 0, holds: leg.kind === "hold" ? 1 : 0, errors: 0 };
  }
  const priced = await deps.priceLeg({ job, check, leg, observation: snapshot.observation, nowMs: deps.nowMs() });
  if ("hold" in priced) { notes.push(`${job.jobId}:${safeCode(priced.hold)}`); return { actions: 0, holds: 1, errors: 0 }; }
  const inserted = await deps.store.insertAction({ ...priced.action, expectedJobRevision: job.accountingRev,
    expectedCheckVersion: check.rowVersion, nowMs: deps.nowMs() });
  if (inserted.kind !== "ok") { notes.push(`${job.jobId}:intent-${inserted.kind}`); return { actions: 0, holds: 1, errors: 0 }; }
  const currentJob = await deps.store.getJob(job.jobId); if (currentJob === null) return { actions: 0, holds: 1, errors: 0 };
  const execDeps: QuantRebalanceExecuteDeps = {
    store: deps.store, journal: deps.journal, provider: deps.provider, reader: deps.reader,
    keypair: deps.keypair, nowMs: deps.nowMs, revalidatePlan: deps.revalidatePlan, readCurrentWire: deps.readCurrentWire,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
  const submitInput = { job: currentJob, action: inserted.record, calls: priced.calls, requiredNativeWei: priced.requiredNativeWei };
  const outcome: QuantRebalanceSubmitOutcome = deps.submitAction === undefined
    ? await submitQuantRebalanceAction(execDeps, submitInput)
    : await deps.submitAction(submitInput);
  notes.push(`${job.jobId}:${outcome.kind}${"code" in outcome ? `:${outcome.code}` : ""}`);
  return { actions: outcome.kind === "committed" || outcome.kind === "pending" ? 1 : 0,
    holds: outcome.kind === "unknown" || outcome.kind === "refused" ? 1 : 0, errors: 0 };
}

export async function runQuantRebalanceWorkerOnce(deps: QuantRebalanceWorkerDeps): Promise<QuantRebalanceCycleReport> {
  if (!(await deps.claims.migrationInstalled())) {
    return { jobsSeen: 0, actions: 0, holds: 1, errors: 0, notes: ["wallet-claim-migration-not-installed"] };
  }
  const notes: string[] = [];
  await discover(deps, notes);
  const jobs = [...await deps.store.listWorkableJobs(deps.strategyId)]
    .sort((a, b) => a.createdAtMs === b.createdAtMs ? a.jobId.localeCompare(b.jobId) : a.createdAtMs - b.createdAtMs);
  let actions = 0; let holds = 0; let errors = 0;
  const production = productionComposition(deps);
  for (const job of jobs) {
    if (production && !productionRowMatches(deps.capabilityProfile!, job)) {
      // The one permitted effect: a sanitized hold, written once.
      if (job.holdCode !== PRODUCTION_MISMATCH_HOLD) {
        try { await deps.store.setHold({ jobId: job.jobId, code: PRODUCTION_MISMATCH_HOLD, evidenceJson: null, nowMs: deps.nowMs() }); }
        catch { errors += 1; notes.push(`${job.jobId}:cycle-error`); continue; }
      }
      holds += 1; notes.push(`${job.jobId}:${PRODUCTION_MISMATCH_HOLD}`); continue;
    }
    if (job.status === "discovered") {
      if (!await admitDiscoveredJob(deps, job, notes)) { holds += 1; continue; }
      // The verified allocation begins in this cycle. Admission itself has
      // already consumed its chain reads; fetch the promoted row and let the
      // normal recovery/wire/portfolio fences govern its first bootstrap leg.
      const admitted = await deps.store.getJob(job.jobId);
      if (admitted === null) { holds += 1; notes.push(`${job.jobId}:admitted-row-unavailable`); continue; }
      try {
        const result = await processAdmittedJob(deps, admitted, notes);
        actions += result.actions; holds += result.holds; errors += result.errors;
      } catch {
        errors += 1; notes.push(`${job.jobId}:cycle-error`);
      }
      continue;
    }
    try {
      const result = await processAdmittedJob(deps, job, notes);
      actions += result.actions; holds += result.holds; errors += result.errors;
    } catch {
      errors += 1; notes.push(`${job.jobId}:cycle-error`);
    }
  }
  return { jobsSeen: jobs.length, actions, holds, errors, notes };
}

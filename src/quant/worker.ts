/**
 * The quant cycle (QUANT-GRID §7.3, R2.2, R3.9, R4.4, R4.5, R5.5, R6.4, R7.2).
 *
 * ONE cycle does, in this order and for one job at a time:
 *
 *   1. RECOVER — `recoverUnsettledActions`, before ANY decision. A level with
 *      a non-terminal action is blocked, so nothing below can act on it.
 *   2. DISCOVER — poll the inbox (live cycles only; dry-run does NOT poll, and
 *      that is the one external side effect dry-run avoids, documented here
 *      because a first fetch marks an envelope delivered to the CLIENT).
 *   3. LIVENESS — refuse to act when the job is revoked, expired, or ended.
 *   4. ADMIT — once, for a `discovered` job: open, project, validate, check the
 *      chain, freeze the parameters, build the ladder.
 *   5. OBSERVE — ONE finalized read; a block at or below the last recorded
 *      height is `stale-observation` and touches no counter.
 *   6. DECIDE — sells before buys, at most one action per level per cycle, and
 *      AT MOST ONE SUBMISSION PER JOB PER CYCLE (R4.4), which is what makes
 *      per-wallet fee attribution well defined.
 *   7. REPORT — after `endsAt`, once every action is terminal.
 *
 * Per-job errors are caught into the run row: one job cannot blind the others.
 */
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import type { ExecutionJournal } from "../store/journal.js";
import type {
  QuantActionRow,
  QuantFence,
  QuantJobRow,
  QuantJobStore,
  QuantLevelRow,
  QuantObservationAcceptance,
} from "../store/quantJobs.js";
import type { WalletProvider } from "../core/types.js";
import { buildPancakeTokenSwap, directPath } from "../ops/pancakeTokens.js";
import {
  assertQuantSessionAdmissible,
  checkLadderAdmissible,
  openSession,
  permissionsDigest,
  projectGrantedPermissions,
  runChainAdmissionChecks,
  specDigest,
  type QuantChainAdmissionReads,
} from "./admission.js";
import {
  feeEstInU,
  actionDeadlineSec,
  armFloor,
  buildLadder,
  buyMinOut,
  ceilDiv,
  midFromReserves,
  partitionExit,
  quantPriceImpactBps,
  quoteAcceptable,
  requiredNativeWei,
  rebuildLines,
  sellFloor,
  triggerArmed,
  type LevelObligation,
} from "./grid.js";
import { checkQuantMeters, quantJournalKey, submitQuantAction, type QuantExecuteDeps } from "./execute.js";
import { reconcileAccounting, recoverUnsettledActions, type QuantReconcileDeps } from "./reconcile.js";
import { orderedReserves, type QuantChainReader } from "./readers.js";
import type { QuantTransport } from "./termix.js";
import type { QuantKeypair } from "./envelope.js";
import { admittedQuantParams, feeEstWei, type QuantAdmittedParams, type QuantStrategyParams } from "./config.js";
import { admittedParams } from "./reconcile.js";
import type { QuantHoldCode, QuantObservation } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const GAS_MAX_AGE_MS = 30_000;
const MAX_GAS_PRICE_WEI = 1_000n * 10n ** 9n;

type QuantAdmittedWorkerDeps = Omit<QuantWorkerDeps, "params"> & {
  readonly params: QuantAdmittedParams;
};

type GasEvidence = {
  readonly ok: true;
  readonly gasPriceWei: bigint;
  readonly feeEstWei: bigint;
  readonly gasReadAtMs: number;
};

export type QuantWorkerDeps = {
  readonly store: QuantJobStore;
  readonly journal: ExecutionJournal;
  readonly provider: WalletProvider;
  readonly reader: QuantChainReader;
  readonly transport: QuantTransport;
  readonly keypair: QuantKeypair;
  readonly params: QuantStrategyParams;
  readonly strategyId: string;
  readonly agentId: string;
  readonly paramsDigest: Hex;
  readonly venue: {
    readonly router: Address;
    readonly u: Address;
    readonly wbnb: Address;
    readonly pair: Address;
  };
  readonly chainAdmission: QuantChainAdmissionReads;
  readonly intervalMs: number;
  readonly nowMs: () => number;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
};

export type QuantCycleReport = {
  readonly jobsSeen: number;
  readonly actions: number;
  readonly holds: number;
  readonly errors: number;
  readonly dryRun: boolean;
  readonly notes: readonly string[];
};

export type QuantCycleOptions = {
  readonly dryRun?: boolean;
  /** Injected for the offline scenario suite; production reads the chain. */
  readonly observationSource?: (job: QuantJobRow) => Promise<QuantObservation>;
};

export type QuantRecenterPreview =
  | { readonly kind: "none"; readonly side: null }
  | { readonly kind: "hold"; readonly side: "up" | "down"; readonly code: QuantHoldCode }
  | {
    readonly kind: "recenter";
    readonly side: "up" | "down";
    readonly buyPrice: readonly bigint[];
    readonly sellPrice: readonly bigint[];
    readonly reseed: boolean;
    readonly cause: string;
  };

/** Pure B2 decision preview. It reads no store and performs no chain calls. */
export function previewRecenter(
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  observation: QuantObservation,
  params: QuantAdmittedParams,
): QuantRecenterPreview {
  if (params.recenterMode !== "both" || params.seedMode !== "symmetric") {
    return { kind: "none", side: null };
  }
  const upper = levels.find((row) => row.levelIndex === job.levels);
  const lower = levels.find((row) => row.levelIndex === Math.max(1, job.levels - 1));
  if (upper === undefined || lower === undefined) return { kind: "none", side: null };
  const side: "up" | "down" | null = observation.midE18 > upper.sellPriceE18
    ? "up" : observation.midE18 < lower.buyPriceE18 ? "down" : null;
  if (side === null) return { kind: "none", side: null };
  if (job.recenterConsecutive < 2 || job.recenterSide !== side) {
    return { kind: "none", side: null };
  }
  if (job.recenters >= job.recenterBudget) return { kind: "hold", side, code: "recenter-budget-exhausted" };
  const cooldownFrom = job.lastRecenterAtMs ?? job.admittedAtMs ?? 0;
  if (observation.observedAtMs - cooldownFrom < params.recenterCooldownSec * 1_000) {
    return { kind: "hold", side, code: "recenter-cooldown" };
  }
  if (levels.some((row) => row.state === "blocked" || row.state === "retired" || row.seedPending)) {
    return { kind: "hold", side, code: levels.some((row) => row.state === "retired") ? "recenter-retired" : "recenter-busy" };
  }
  const lines = rebuildLines({
    anchorE18: observation.midE18, levels: job.levels,
    lower: Math.max(1, job.levels - 1), params,
  });
  const reseed = side === "up" && upper.state === "armed-quote";
  return {
    kind: "recenter", side, buyPrice: lines.buyPrice, sellPrice: lines.sellPrice,
    reseed, cause: `${side}:mid${side === "up" ? ">top" : "<bottom"}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Cycle                                                                      */
/* -------------------------------------------------------------------------- */

export async function runQuantWorkerOnce(
  deps: QuantWorkerDeps,
  options: QuantCycleOptions = {},
): Promise<QuantCycleReport> {
  const dryRun = options.dryRun === true;
  const notes: string[] = [];
  let actions = 0;
  let holds = 0;
  let errors = 0;

  if (!dryRun) {
    try {
      await discoverEnvelopes(deps);
    } catch {
      // The inbox is the only feed, and a hold costs nothing.
      notes.push("inbox-unavailable");
      holds += 1;
    }
  }

  const jobs = await deps.store.listWorkableJobs(deps.strategyId);
  for (const job of jobs) {
    try {
      const outcome = await runOneJob(deps, job, options);
      actions += outcome.actions;
      holds += outcome.holds;
      notes.push(...outcome.notes);
    } catch (error) {
      errors += 1;
      notes.push(`${job.quantJobId}:error`);
      deps.log?.(`[quant] job ${job.quantJobId} failed: ${describe(error)}`);
    }
  }

  return { jobsSeen: jobs.length, actions, holds, errors, dryRun, notes };
}

function describe(error: unknown): string {
  // Never the message: an upstream error can carry request material.
  return error instanceof Error ? error.name : "unknown";
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

async function discoverEnvelopes(deps: QuantWorkerDeps): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await deps.transport.inbox(deps.agentId, cursor);
    if (!result.ok) throw new Error("inbox-unavailable");
    for (const item of result.data.items) {
      // The ciphertext IS persisted (R2.0.4, reversing the body): it is useless
      // without the worker-only seed — exactly the model the `agents` table
      // already uses for encrypted session keys — and not persisting it made
      // DISCOVERY CONSUME THE ONLY COPY.
      await deps.store.discoverJob({
        quantJobId: item.quantJobId,
        envelopeId: item.envelopeId,
        strategyId: deps.strategyId,
        envelopeJson: JSON.stringify({
          ephemeralPublicKey: item.ephemeralPublicKey,
          nonce: item.nonce,
          ciphertext: item.ciphertext,
          algorithm: item.algorithm,
        }),
        nowMs: deps.nowMs(),
      });
    }
    if (result.data.nextCursor === null || result.data.items.length === 0) return;
    cursor = result.data.nextCursor;
  }
}

/* -------------------------------------------------------------------------- */
/* One job                                                                    */
/* -------------------------------------------------------------------------- */

type JobOutcome = {
  readonly actions: number;
  readonly holds: number;
  readonly notes: readonly string[];
};

async function runOneJob(
  deps: QuantWorkerDeps,
  jobRow: QuantJobRow,
  options: QuantCycleOptions,
): Promise<JobOutcome> {
  const dryRun = options.dryRun === true;
  const notes: string[] = [];
  const nowMs = deps.nowMs();

  /* Wire refresh. A job that fails PARSING is held with the field named. */
  const wire = await deps.transport.job(jobRow.quantJobId);
  let job: QuantJobRow = jobRow;
  let wireChanged = false;
  let wireIssue: QuantHoldCode | null = null;
  if (!wire.ok) {
    wireIssue = wire.code === "wire-invalid" ? "wire-invalid" : "inbox-unavailable";
  } else {
    const record = wire.data;
    const updatedWire = await deps.store.updateJobWire({
      quantJobId: jobRow.quantJobId,
      strategyId: record.strategyId,
      tradingWallet: record.tradingWalletAddress,
      allocationUWei: record.allocationUWei,
      dailyCapUWei: record.dailyCapUWei,
      termDays: record.termDays,
      startedAtMs: record.startedAtMs,
      endsAtMs: record.endsAtMs,
      sessionExpiresAtMs: record.sessionExpiresAtMs,
      revokedAtMs: record.revokedAtMs,
      nowMs,
    });
    if (updatedWire === null) {
      // Foreign wire data is retained as a telemetry hold, but it must not
      // prevent recovery of an already-admitted action.
      wireIssue = "foreign-strategy";
    } else {
      job = updatedWire;
      wireChanged = updatedWire.wireDiffers || updatedWire.wireState === "changed";
      if (!wireChanged && updatedWire.holdCode === "wire-changed") {
        await deps.store.holdJob({ quantJobId: jobRow.quantJobId, holdCode: null, nowMs });
        job = await deps.store.getJob(jobRow.quantJobId) ?? updatedWire;
      }
    }
  }

  /* Phase 0 — recovery, ALWAYS, dry-run included: it writes only truth. */
  const reconcileDeps: QuantReconcileDeps = {
    store: deps.store, journal: deps.journal, provider: deps.provider,
    reader: deps.reader, params: deps.params, venue: deps.venue, nowMs: deps.nowMs,
  };
  const recovered = await recoverUnsettledActions(reconcileDeps, job);
  for (const outcome of recovered) notes.push(`${job.quantJobId}:${outcome.cell}`);

  /* Term end: no new intents, then the report once everything is terminal. */
  if (job.endsAtMs !== null && nowMs >= job.endsAtMs) {
    return finishTerm(deps, job, notes, dryRun);
  }

  if (job.status === "paused") {
    if (!(await verifyBaseline(deps, job))) {
      await hold(deps, job.quantJobId, "baseline-unverified");
      notes.push(`${job.quantJobId}:baseline-unverified`, `${job.quantJobId}:paused`);
      return { actions: 0, holds: 1, notes };
    }
    const truthObservation = options.observationSource === undefined
      ? await readObservation(deps, job) : await options.observationSource(job);
    const pausedAccounting = await checkAccounting(deps, job, truthObservation);
    if (pausedAccounting !== null && !pausedAccounting.admissible) {
      const published = await deps.store.publishTruthVerdict({
        quantJobId: job.quantJobId, expectedAccountingRev: pausedAccounting.accountingRev,
        expectedEpoch: pausedAccounting.epoch, expectedEpochHash: pausedAccounting.epochHash,
        observationBlock: truthObservation.blockNumber, observationHash: truthObservation.blockHash,
        admissible: pausedAccounting.admissible,
        evidenceJson: JSON.stringify({
          block: truthObservation.blockNumber.toString(10), hash: truthObservation.blockHash,
          expected: { u: pausedAccounting.expectedUWei.toString(10), wbnb: pausedAccounting.expectedWbnbWei.toString(10) },
          actual: pausedAccounting.actual, pending: pausedAccounting.pending,
        }),
        nowMs,
      });
      if (!published.ok) notes.push(`${job.quantJobId}:reconcile-stale`);
      await hold(deps, job.quantJobId, published.ok ? "external-activity" : "reconcile-stale");
    }
    notes.push(`${job.quantJobId}:paused`);
    return { actions: 0, holds: 0, notes };
  }

  if (wireIssue !== null) {
    try {
      const truthObservation = await readObservation(deps, job);
      if (!(await verifyBaseline(deps, job))) {
        await hold(deps, job.quantJobId, "baseline-unverified");
      } else {
        const truth = await checkAccounting(deps, job, truthObservation);
        if (truth !== null && !truth.admissible) {
          const published = await deps.store.publishTruthVerdict({
            quantJobId: job.quantJobId, expectedAccountingRev: truth.accountingRev,
            expectedEpoch: truth.epoch, expectedEpochHash: truth.epochHash,
            observationBlock: truthObservation.blockNumber, observationHash: truthObservation.blockHash,
            admissible: truth.admissible,
            evidenceJson: JSON.stringify({
              block: truthObservation.blockNumber.toString(10), hash: truthObservation.blockHash,
              expected: { u: truth.expectedUWei.toString(10), wbnb: truth.expectedWbnbWei.toString(10) },
              actual: truth.actual, pending: truth.pending,
            }),
            nowMs,
          });
          if (!published.ok) notes.push(`${job.quantJobId}:reconcile-stale`);
        }
      }
    } catch {
      notes.push(`${job.quantJobId}:truth-snapshot-unavailable`);
    }
    await hold(deps, job.quantJobId, wireIssue);
    notes.push(`${job.quantJobId}:${wireIssue}`);
    return { actions: 0, holds: 1, notes };
  }

  if (wireChanged) {
    await hold(deps, job.quantJobId, "wire-changed");
    notes.push(`${job.quantJobId}:wire-changed`);
    return { actions: 0, holds: 1, notes };
  }
  if (job.paramsDigest !== null && job.paramsDigest.toLowerCase() !== deps.paramsDigest.toLowerCase()) {
    await hold(deps, job.quantJobId, "params-changed");
    notes.push(`${job.quantJobId}:params-changed`);
    return { actions: 0, holds: 1, notes };
  }

  /* Liveness (spec §2.5), adopted from the skill as-is. */
  if (job.revokedAtMs !== null
    || (job.sessionExpiresAtMs !== null && job.sessionExpiresAtMs <= nowMs)) {
    await hold(deps, job.quantJobId, "job-not-tradable");
    return { actions: 0, holds: 1, notes };
  }
  if (job.strategyId !== deps.strategyId) {
    // R2.8: a job for a strategy we did not list is NEVER traded.
    await hold(deps, job.quantJobId, "foreign-strategy");
    return { actions: 0, holds: 1, notes };
  }

  /* Admission, once. */
  if (job.status === "discovered") {
    const admitted = await admitJob(deps, job, dryRun);
    notes.push(`${job.quantJobId}:${admitted.note}`);
    return { actions: 0, holds: admitted.ok ? 0 : 1, notes };
  }

  let levels = await deps.store.listLevels(job.quantJobId);
  if (levels.length === 0) return { actions: 0, holds: 0, notes };
  const parsedParams = admittedParams(job, deps.params);
  if (parsedParams === null || !("bandTiers" in parsedParams)) {
    await hold(deps, job.quantJobId, "params-unreadable");
    notes.push(`${job.quantJobId}:params-unreadable`);
    return { actions: 0, holds: 1, notes };
  }
  const admittedDeps: QuantAdmittedWorkerDeps = { ...deps, params: parsedParams };

  /* Observation. */
  let observation: QuantObservation;
  try {
    observation = options.observationSource === undefined
      ? await readObservation(deps, job)
      : await options.observationSource(job);
  } catch {
    await hold(deps, job.quantJobId, "observation-unverified");
    notes.push(`${job.quantJobId}:observation-unverified`);
    return { actions: 0, holds: 1, notes };
  }
  if (dryRun) {
    // Dry-run may recover truth but cannot publish a market observation or any
    // decision evidence. It is a pure preview of the persisted snapshot.
    const preview = previewRecenter(job, levels, observation, admittedDeps.params);
    notes.push(`${job.quantJobId}:dry-run`, `${job.quantJobId}:dry-run:recenter-${preview.kind}`);
    return { actions: 0, holds: 1, notes };
  }

  const gas = await readGasEvidence(admittedDeps, admittedDeps.params);
  if (!gas.ok) {
    await hold(admittedDeps, job.quantJobId, gas.code);
    notes.push(`${job.quantJobId}:${gas.code}`);
    return { actions: 0, holds: 1, notes };
  }
  if (job.holdCode === "gas-price-unavailable" || job.holdCode === "gas-price-implausible") {
    await admittedDeps.store.holdJob({ quantJobId: job.quantJobId, holdCode: null, nowMs });
  }

  let accepted = await deps.store.acceptObservation({
    quantJobId: job.quantJobId, observation, intervalMs: deps.intervalMs,
    processDigest: deps.paramsDigest,
  });
  if (!accepted.accepted) {
    notes.push(`${job.quantJobId}:${accepted.reason ?? "observation-not-accepted"}`);
    return { actions: 0, holds: 1, notes };
  }
  job = accepted.job;
  levels = [...accepted.levels];

  if (!(await verifyBaseline(deps, job))) {
    await hold(deps, job.quantJobId, "baseline-unverified");
    notes.push(`${job.quantJobId}:baseline-unverified`);
    return { actions: 0, holds: 1, notes };
  }
  job = await deps.store.getJob(job.quantJobId) ?? job;
  levels = [...await deps.store.listLevels(job.quantJobId)];
  accepted = { ...accepted, job, levels };

  let accounting: Awaited<ReturnType<typeof checkAccounting>>;
  try {
    accounting = await checkAccounting(deps, job, accepted.observation);
  } catch {
    await hold(deps, job.quantJobId, "snapshot-unverified");
    notes.push(`${job.quantJobId}:snapshot-unverified`);
    return { actions: 0, holds: 1, notes };
  }
  if (accounting !== null) {
    if (accounting.reason === "reconcile-structure") {
      await hold(deps, job.quantJobId, "reconcile-structure");
      notes.push(`${job.quantJobId}:reconcile-structure`);
      return { actions: 0, holds: 1, notes };
    }
    const published = await deps.store.publishAccountingVerdict({
      quantJobId: job.quantJobId, expectedAccountingRev: accounting.accountingRev,
      expectedEpoch: accounting.epoch, expectedEpochHash: accounting.epochHash,
      observationBlock: accepted.observation.blockNumber, observationHash: accepted.observation.blockHash,
      admissible: accounting.admissible,
      evidenceJson: JSON.stringify({
        block: accepted.observation.blockNumber.toString(10), hash: accepted.observation.blockHash,
        expected: { u: accounting.expectedUWei.toString(10), wbnb: accounting.expectedWbnbWei.toString(10) },
        actual: accounting.actual, pending: accounting.pending,
      }), nowMs: deps.nowMs(),
    });
    if (!published.ok) {
      await hold(deps, job.quantJobId, "reconcile-stale");
      notes.push(`${job.quantJobId}:reconcile-stale`);
      return { actions: 0, holds: 1, notes };
    }
    if (!accounting.admissible) {
      notes.push(`${job.quantJobId}:external-activity`);
      return { actions: 0, holds: 1, notes };
    }
    if (job.accountingState !== "ok") {
      notes.push(`${job.quantJobId}:external-activity`);
      return { actions: 0, holds: 1, notes };
    }
    job = await deps.store.getJob(job.quantJobId) ?? job;
    levels = [...await deps.store.listLevels(job.quantJobId)];
    accepted = { ...accepted, job, levels };
  }

  /* Decide, claim, release, submit — ONE submission per job per cycle. */
  const planned = await planOneAction(admittedDeps, accepted, gas);
  if (planned.kind === "hold") {
    if (planned.code === "gas-price-unavailable" || planned.code === "gas-price-implausible"
      || planned.code === "gas-price-moved") {
      await hold(admittedDeps, job.quantJobId, planned.code);
      notes.push(`${job.quantJobId}:${planned.code}`);
      return { actions: 0, holds: 1, notes };
    }
    const recenterJob = await deps.store.getJob(job.quantJobId) ?? job;
    const recenterLevels = await deps.store.listLevels(job.quantJobId);
    const recentered = await maybeRecenter(admittedDeps, recenterJob, recenterLevels, accepted.observation, gas);
    if (recentered.kind === "recentered") {
      notes.push(`${job.quantJobId}:recentered:${recentered.side}`);
      return { actions: 0, holds: 0, notes };
    }
    if (recentered.kind === "hold") {
      notes.push(`${job.quantJobId}:${recentered.code}`);
      return { actions: 0, holds: 1, notes };
    }
    notes.push(`${job.quantJobId}:${planned.code}`);
    if (planned.detail !== undefined) notes.push(`${job.quantJobId}:${planned.code}:${planned.detail}`);
    return { actions: 0, holds: 1, notes };
  }
  if (planned.kind === "idle") {
    const recenterJob = await deps.store.getJob(job.quantJobId) ?? job;
    const recenterLevels = await deps.store.listLevels(job.quantJobId);
    const recentered = await maybeRecenter(admittedDeps, recenterJob, recenterLevels, accepted.observation, gas);
    if (recentered.kind === "recentered") {
      notes.push(`${job.quantJobId}:recentered:${recentered.side}`);
      return { actions: 0, holds: 0, notes };
    }
    if (recentered.kind === "hold") {
      notes.push(`${job.quantJobId}:${recentered.code}`);
      return { actions: 0, holds: 1, notes };
    }
    return { actions: 0, holds: 0, notes };
  }

  const executeDeps: QuantExecuteDeps = {
    store: admittedDeps.store, journal: admittedDeps.journal, provider: admittedDeps.provider,
    reader: admittedDeps.reader, keypair: admittedDeps.keypair, params: admittedDeps.params,
    venue: admittedDeps.venue, nowMs: admittedDeps.nowMs,
    ...(admittedDeps.signal === undefined ? {} : { signal: admittedDeps.signal }),
  };
  const outcome = await submitQuantAction(executeDeps, {
    job,
    action: planned.action,
    calls: planned.calls,
    requiredNativeWei: planned.requiredNativeWei,
    tokenIn: planned.tokenIn,
  });
  notes.push(`${job.quantJobId}:${outcome.kind}`);
  return { actions: 1, holds: 0, notes };
}

async function checkAccounting(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  observation: QuantObservation,
): Promise<(ReturnType<typeof reconcileAccounting> & { readonly actual: { readonly u: string; readonly wbnb: string }; readonly accountingRev: bigint; readonly epoch: number; readonly epochHash: Hex | null }) | null> {
  // Legacy offline harnesses predate the hash-bound balance seam. Production
  // readers and the B2 tests expose it; without it this helper cannot claim a
  // canonical accounting verdict.
  if (deps.reader.tokenBalanceAtHash === undefined) return null;
  const epoch = await deps.store.currentEpoch(job.quantJobId);
  if (epoch === null) return null;
  if (epoch.startedBlockHash === null) throw new Error("snapshot-unverified");
  const [actualU, actualWbnb] = await Promise.all([
    deps.reader.tokenBalanceAtHash === undefined
      ? deps.reader.tokenBalanceAt(deps.venue.u, job.tradingWallet, observation.blockNumber)
      : deps.reader.tokenBalanceAtHash(deps.venue.u, job.tradingWallet, observation.blockHash),
    deps.reader.tokenBalanceAtHash === undefined
      ? deps.reader.tokenBalanceAt(deps.venue.wbnb, job.tradingWallet, observation.blockNumber)
      : deps.reader.tokenBalanceAtHash(deps.venue.wbnb, job.tradingWallet, observation.blockHash),
  ]);
  const [epochBlock, observationBlock] = await Promise.all([
    deps.reader.blockAt(epoch.startedBlock),
    deps.reader.blockAt(observation.blockNumber),
  ]);
  if (epochBlock.hash.toLowerCase() !== epoch.startedBlockHash.toLowerCase()
    || observationBlock.hash.toLowerCase() !== observation.blockHash.toLowerCase()
    || observation.blockNumber < epoch.startedBlock) {
    throw new Error("snapshot-unverified");
  }
  const actions = await deps.store.listAccountingActions(job.quantJobId);
  const deadlineBlocks = new Map<string, bigint>();
  const canonicalAncestors = new Map<string, boolean>();
  for (const action of actions) {
    if (action.state === "intended" || action.state === "settled"
      || action.state === "failed" || action.state === "aborted") continue;
    if (action.submitFinalizedNumber === null || action.submitFinalizedHash === null) continue;
    if (action.submitFinalizedNumber < observation.blockNumber) {
      try {
        const ancestor = await deps.reader.blockAt(action.submitFinalizedNumber);
        canonicalAncestors.set(action.journalKey,
          ancestor.hash.toLowerCase() === action.submitFinalizedHash.toLowerCase());
      } catch {
        canonicalAncestors.set(action.journalKey, false);
      }
    }
    if (BigInt(action.deadlineSec) >= epochBlock.timestampSec) {
      deadlineBlocks.set(action.journalKey, await lastBlockAtOrBefore(
        deps.reader, epoch.startedBlock, observation.blockNumber,
        BigInt(action.deadlineSec), observationBlock.timestampSec,
      ));
    }
  }
  const verdict = reconcileAccounting({
    epoch, epochTimestampSec: epochBlock.timestampSec,
    observationBlock: observation.blockNumber,
    observationAtSec: BigInt(Math.floor(observation.observedAtMs / 1_000)),
    actualUWei: actualU, actualWbnbWei: actualWbnb,
    actions, maxPending: job.levels, deadlineBlocks, canonicalAncestors,
  });
  return {
    ...verdict,
    accountingRev: job.accountingRev,
    epoch: epoch.epoch,
    epochHash: epoch.startedBlockHash,
    actual: { u: actualU.toString(10), wbnb: actualWbnb.toString(10) },
  };
}

/** Last block in [start, end] whose timestamp is no later than the deadline. */
async function lastBlockAtOrBefore(
  reader: QuantChainReader,
  start: bigint,
  end: bigint,
  deadlineSec: bigint,
  endTimestampSec: bigint,
): Promise<bigint> {
  if (end <= start || endTimestampSec <= deadlineSec) return end;
  let low = start;
  let high = end;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const block = await reader.blockAt(middle);
    if (block.timestampSec <= deadlineSec) low = middle;
    else high = middle - 1n;
  }
  return low;
}

async function verifyBaseline(deps: QuantWorkerDeps, job: QuantJobRow): Promise<boolean> {
  const epoch = await deps.store.currentEpoch(job.quantJobId);
  if (epoch === null) return false;
  if (epoch.verified && epoch.startedBlockHash !== null) return true;
  if (deps.reader.tokenBalanceAtHash === undefined || deps.reader.nativeBalanceAtHash === undefined
    || typeof deps.reader.blockAt !== "function") return false;
  try {
    let blockHash = epoch.startedBlockHash;
    if (blockHash === null) {
      const block = await deps.reader.blockAt(epoch.startedBlock);
      blockHash = block.hash;
      await deps.store.setEpochHash({
        quantJobId: job.quantJobId, epoch: epoch.epoch, blockHash, nowMs: deps.nowMs(),
      });
    }
    const [u, wbnb, native] = await Promise.all([
      deps.reader.tokenBalanceAtHash(deps.venue.u, job.tradingWallet, blockHash),
      deps.reader.tokenBalanceAtHash(deps.venue.wbnb, job.tradingWallet, blockHash),
      deps.reader.nativeBalanceAtHash(job.tradingWallet, blockHash),
    ]);
    return deps.store.verifyEpochBaseline({
      quantJobId: job.quantJobId, epoch: epoch.epoch,
      baselineUWei: u, baselineWbnbWei: wbnb, baselineNativeWei: native,
      nowMs: deps.nowMs(),
    });
  } catch {
    return false;
  }
}

async function hold(
  deps: QuantWorkerDeps, quantJobId: string, code: QuantHoldCode,
): Promise<void> {
  await deps.store.withQuantFence(quantJobId, async (fence) => {
    await fence.setJobHold({ quantJobId, holdCode: code });
  });
}

async function readObservation(
  deps: QuantWorkerDeps, job: QuantJobRow,
): Promise<QuantObservation> {
  const finalized = await deps.reader.finalizedBlock();
  const reserves = deps.reader.reservesAtHash === undefined
    ? await deps.reader.reservesAt(deps.venue.pair, finalized.number)
    : await deps.reader.reservesAtHash(deps.venue.pair, finalized.hash);
  if (reserves.blockHash !== undefined && reserves.blockHash.toLowerCase() !== finalized.hash.toLowerCase()) {
    throw new Error("observation-unverified");
  }
  const ordered = orderedReserves(reserves, deps.venue.u);
  void job;
  return {
    blockNumber: finalized.number,
    blockHash: finalized.hash,
    observedAtMs: deps.nowMs(),
    midE18: midFromReserves(ordered.reserveUWei, ordered.reserveWbnbWei),
  };
}

async function readGasEvidence(
  deps: QuantWorkerDeps,
  params: QuantStrategyParams,
): Promise<GasEvidence | { readonly ok: false; readonly code: "gas-price-unavailable" | "gas-price-implausible" }> {
  let gasPriceWei: bigint;
  try {
    gasPriceWei = await deps.reader.gasPriceWei();
  } catch {
    return { ok: false, code: "gas-price-unavailable" };
  }
  if (gasPriceWei <= 0n) return { ok: false, code: "gas-price-unavailable" };
  if (gasPriceWei > MAX_GAS_PRICE_WEI) return { ok: false, code: "gas-price-implausible" };
  return {
    ok: true,
    gasPriceWei,
    feeEstWei: feeEstWei(params, gasPriceWei),
    gasReadAtMs: deps.nowMs(),
  };
}

/* -------------------------------------------------------------------------- */
/* Admission                                                                  */
/* -------------------------------------------------------------------------- */

async function admitJob(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  dryRun: boolean,
): Promise<{ readonly ok: boolean; readonly note: string }> {
  if (job.envelopeJson === null) return { ok: false, note: "envelope-missing" };
  if (dryRun) return { ok: false, note: "dry-run" };
  let envelope: unknown;
  try {
    envelope = JSON.parse(job.envelopeJson);
  } catch {
    await hold(deps, job.quantJobId, "wire-invalid");
    return { ok: false, note: "envelope-malformed" };
  }
  // BC12: admission is the EXPLICIT exception to journal-before-decryption. It
  // opens ONCE, records PUBLIC facts, and writes no journal row — the public key
  // every later journal row carries is not knowable before the first open.
  const opened = openSession(envelope as Parameters<typeof openSession>[0], deps.keypair);
  if (!opened.ok) {
    await hold(deps, job.quantJobId, "session-not-admissible");
    return { ok: false, note: opened.code };
  }
  const plaintext = opened.session;
  const nowMs = deps.nowMs();
  const nowSeconds = Math.floor(nowMs / 1_000);

  let observation: QuantObservation;
  try {
    observation = await readObservation(deps, job);
  } catch {
    await hold(deps, job.quantJobId, "observation-unverified");
    return { ok: false, note: "observation-unverified" };
  }
  const paramsResult = admittedQuantParams(deps.params, job.allocationUWei);
  if (!("bandBps" in paramsResult)) {
    await hold(deps, job.quantJobId, "below-minimum");
    return { ok: false, note: "below-minimum" };
  }
  const params = paramsResult;
  const gas = await readGasEvidence(deps, params);
  if (!gas.ok) {
    await hold(deps, job.quantJobId, gas.code);
    return { ok: false, note: gas.code };
  }
  const ladderResult = buildLadder({
    allocationUWei: job.allocationUWei,
    p0E18: observation.midE18,
    params,
  });
  if (!ladderResult.ok) {
    await hold(
      deps, job.quantJobId,
      ladderResult.code === "below-minimum" ? "below-minimum" : "arm-uneconomic",
    );
    return { ok: false, note: ladderResult.code };
  }
  const ladder = ladderResult.ladder;

  if (params.seedMode === "symmetric" && job.termDays < params.minTermDays) {
    await hold(deps, job.quantJobId, "term-too-short");
    return { ok: false, note: "term-too-short" };
  }
  if (params.seedMode === "symmetric"
    && job.dailyCapUWei < ladder.clipUWei * BigInt(ladder.levels)) {
    await hold(deps, job.quantJobId, "day-cap-too-small");
    return { ok: false, note: "day-cap-too-small" };
  }

  /* The arm floor, on THIS pool, with a measured impact. */
  const impactBps = await measureImpactBps(deps, ladder.clipUWei, observation.blockNumber, observation.blockHash);
  const floor = armFloor({
    clipUWei: ladder.clipUWei,
    midE18: observation.midE18,
    impactBps,
    params, gasPriceWei: gas.gasPriceWei,
  });
  const ladderGate = checkLadderAdmissible({
    ladder: { levels: ladder.levels, clipUWei: ladder.clipUWei, buyPrice: ladder.buyPrice,
      sellPrice: ladder.sellPrice, midE18: observation.midE18,
      minSellPriceE18: ladder.minSellPriceE18 },
    allocationUWei: job.allocationUWei, dailyCapUWei: job.dailyCapUWei,
    capRows: plaintext.permissions.spend.map((row) => ({ token: row.token ?? null, limit: row.limit })),
    u: deps.venue.u, wbnb: deps.venue.wbnb, impactBps, params, gasPriceWei: gas.gasPriceWei,
  });
  if (!ladderGate.ok) {
    const code = ladderGate.code === "day-cap-too-small" ? "day-cap-too-small"
      : ladderGate.code === "arm-uneconomic" ? "arm-uneconomic" : "session-not-admissible";
    await hold(deps, job.quantJobId, code);
    return { ok: false, note: ladderGate.code };
  }
  if (!floor.economic) {
    // Re-evaluated EVERY cycle until `endsAt` — pool depth moves, so this hold
    // is not permanent and does not close the job.
    await hold(deps, job.quantJobId, "arm-uneconomic");
    return { ok: false, note: `arm-uneconomic:${floor.requiredBps}` };
  }

  if (params.seedMode === "symmetric") {
    const seedFloor = buyMinOut({
      clipUWei: ladder.clipUWei, buyPriceE18: observation.midE18,
      levelIndex: ladder.levels, actionSeq: 1, params,
    });
    try {
      const seedQuote = deps.reader.quoteV2AtHash === undefined
        ? await deps.reader.quoteV2At(
          deps.venue.router, directPath(deps.venue.u, deps.venue.wbnb),
          ladder.clipUWei, observation.blockNumber,
        )
        : await deps.reader.quoteV2AtHash(
          deps.venue.router, directPath(deps.venue.u, deps.venue.wbnb),
          ladder.clipUWei, observation.blockHash,
        );
      if (seedQuote < seedFloor) {
        await hold(deps, job.quantJobId, "seed-unexecutable");
        return { ok: false, note: "seed-unexecutable" };
      }
    } catch {
      await hold(deps, job.quantJobId, "seed-unexecutable");
      return { ok: false, note: "seed-unexecutable" };
    }
  }

  const projection = projectGrantedPermissions(plaintext.permissions, {
    expiry: plaintext.expiry,
    nowSeconds,
    termDays: job.termDays,
    walletAddress: plaintext.walletAddress,
  });
  if (!projection.ok) {
    await hold(deps, job.quantJobId, "session-not-admissible");
    return { ok: false, note: projection.code };
  }
  const admissible = assertQuantSessionAdmissible({
    session: plaintext,
    spec: projection.spec,
    router: deps.venue.router,
    u: deps.venue.u,
    wbnb: deps.venue.wbnb,
    job: {
      tradingWalletAddress: getAddress(job.tradingWallet),
      sessionExpiresAtMs: job.sessionExpiresAtMs,
      allocationUWei: job.allocationUWei,
    },
    ladder: {
      levels: ladder.levels,
      clipUWei: ladder.clipUWei,
      buyPrice: ladder.buyPrice,
      sellPrice: ladder.sellPrice,
      midE18: observation.midE18,
      minBuyPriceE18: ladder.minBuyPriceE18,
      minSellPriceE18: ladder.minSellPriceE18,
    },
    params,
    gasPriceWei: gas.gasPriceWei,
    nowSeconds,
  });
  if (!admissible.ok) {
    await hold(deps, job.quantJobId, "session-not-admissible");
    return { ok: false, note: admissible.code };
  }

  /* A8 — the chain half. Unreadable is a HOLD, never a refusal. */
  const keyHash = accountKeyHashForAddress(publicKeyToAddress(plaintext.publicKey));
  const probes = buildAdmissionProbes(deps, ladder.clipUWei, getAddress(job.tradingWallet));
  const chain = await runChainAdmissionChecks({
    reads: deps.chainAdmission,
    wallet: getAddress(job.tradingWallet),
    keyHash,
    publicKey: plaintext.publicKey,
    probes,
  });
  if (!chain.ok) {
    await hold(
      deps, job.quantJobId,
      chain.unreadable ? "session-chain-unreadable" : "session-chain-refused",
    );
    return { ok: false, note: chain.code };
  }

  const [baselineU, baselineWbnb, baselineNative] = await Promise.all([
    deps.reader.tokenBalanceAtHash === undefined
      ? deps.reader.tokenBalanceAt(deps.venue.u, getAddress(job.tradingWallet), observation.blockNumber)
      : deps.reader.tokenBalanceAtHash(deps.venue.u, getAddress(job.tradingWallet), observation.blockHash),
    deps.reader.tokenBalanceAtHash === undefined
      ? deps.reader.tokenBalanceAt(deps.venue.wbnb, getAddress(job.tradingWallet), observation.blockNumber)
      : deps.reader.tokenBalanceAtHash(deps.venue.wbnb, getAddress(job.tradingWallet), observation.blockHash),
    deps.reader.nativeBalanceAtHash === undefined
      ? deps.reader.nativeBalanceAt(getAddress(job.tradingWallet), observation.blockNumber)
      : deps.reader.nativeBalanceAtHash(getAddress(job.tradingWallet), observation.blockHash),
  ]);

  const result = await deps.store.admitJob({
    quantJobId: job.quantJobId,
    expectedRowVersion: job.rowVersion,
    sessionPublicKey: plaintext.publicKey,
    sessionExpiry: plaintext.expiry,
    permissionsDigest: permissionsDigest(plaintext.permissions),
    projectionDigest: specDigest(projection.spec),
    wbnbCapMinLimitWei: admissible.wbnbCapMinLimitWei,
    residualThresholdWei: admissible.residualThresholdWei,
    paramsJson: JSON.stringify({
      ...params,
      paramsSchema: "r14",
      admissionEvidence: {
        grantShape: admissible.grantShape,
        platformTargets: admissible.platformTargets,
      },
      minClipUWei: params.minClipUWei.toString(10),
      relayFeePerSubmitWei: params.relayFeePerSubmitWei.toString(10),
      relayGasUnits: params.relayGasUnits.toString(10),
      relayFeePadBps: params.relayFeePadBps.toString(10),
    }),
    paramsDigest: deps.paramsDigest,
    p0E18: ladder.p0E18,
    armBlock: observation.blockNumber,
    armBlockHash: observation.blockHash,
    levels: Array.from({ length: ladder.levels }, (_unused, index) => ({
      levelIndex: index + 1,
      buyPriceE18: ladder.buyPrice[index + 1] ?? 0n,
      sellPriceE18: ladder.sellPrice[index + 1] ?? 0n,
      seedPending: params.seedMode === "symmetric" && index + 1 > ladder.lowerLevels,
    })),
    clipUWei: ladder.clipUWei,
    idleUWei: ladder.idleUWei,
    baselineUWei: baselineU,
    baselineWbnbWei: baselineWbnb,
    baselineNativeWei: baselineNative,
    capRowsJson: JSON.stringify(plaintext.permissions.spend.map((row) => ({
      token: row.token ?? null, limit: row.limit.toString(10), period: row.period,
    }))),
    recenterBudget: Math.ceil(job.termDays / params.recenterBudgetDays),
    nowMs,
  });
  return result.kind === "ok"
    ? { ok: true, note: "armed" }
    : { ok: false, note: "admit-conflict" };
}

function buildAdmissionProbes(
  deps: QuantWorkerDeps,
  clipUWei: bigint,
  wallet: Address,
): readonly { readonly target: Address; readonly data: Hex }[] {
  // The probes are the REAL calldata a first buy would submit (D1 rule 3):
  // `canExecute` takes `data`, so a different payload answers a question
  // nobody posed.
  const buy = buildPancakeTokenSwap({
    router: deps.venue.router,
    tokenIn: deps.venue.u,
    tokenOut: deps.venue.wbnb,
    amountInWei: clipUWei,
    minOutWei: 1n,
    recipient: wallet,
    deadline: BigInt(Math.floor(deps.nowMs() / 1_000) + 600),
  });
  const sell = buildPancakeTokenSwap({
    router: deps.venue.router,
    tokenIn: deps.venue.wbnb,
    tokenOut: deps.venue.u,
    amountInWei: 1n,
    minOutWei: 1n,
    recipient: wallet,
    deadline: BigInt(Math.floor(deps.nowMs() / 1_000) + 600),
  });
  return [...buy, ...sell].map((call) => ({
    target: call.to,
    data: call.data ?? ("0x" as Hex),
  }));
}

async function measureImpactBps(
  deps: QuantWorkerDeps,
  clipUWei: bigint,
  blockNumber: bigint,
  blockHash?: Hex,
): Promise<bigint> {
  const path = directPath(deps.venue.u, deps.venue.wbnb);
  const probe = clipUWei / 100n;
  if (probe <= 0n) return 0n;
  const [full, small] = await Promise.all([
    blockHash !== undefined && deps.reader.quoteV2AtHash !== undefined
      ? deps.reader.quoteV2AtHash(deps.venue.router, path, clipUWei, blockHash)
      : deps.reader.quoteV2At(deps.venue.router, path, clipUWei, blockNumber),
    blockHash !== undefined && deps.reader.quoteV2AtHash !== undefined
      ? deps.reader.quoteV2AtHash(deps.venue.router, path, probe, blockHash)
      : deps.reader.quoteV2At(deps.venue.router, path, probe, blockNumber),
  ]);
  return quantPriceImpactBps(full, small);
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

type PlanResult =
  | { readonly kind: "idle" }
  | { readonly kind: "hold"; readonly code: QuantHoldCode; readonly detail?: string }
  | {
      readonly kind: "act";
      readonly action: QuantActionRow;
      readonly calls: readonly { readonly to: Address; readonly value?: bigint; readonly data?: Hex }[];
      readonly requiredNativeWei: bigint;
      readonly tokenIn: Address;
    };

async function planOneAction(
  deps: QuantAdmittedWorkerDeps,
  snapshot: QuantObservationAcceptance,
  gas: GasEvidence,
): Promise<PlanResult> {
  const job = snapshot.job;
  const levels = snapshot.levels;
  const observation = snapshot.observation;
  // SELLS BEFORE BUYS — the PHASE3.15 semantic kept verbatim. Exits reduce
  // exposure, so they never wait behind an entry.
  const ordered = [...levels].sort((a, b) => {
    const sellFirst = (level: QuantLevelRow): number =>
      level.state === "holding-base" ? 0 : 1;
    const seedFirst = (level: QuantLevelRow): number => level.seedPending ? 0 : 1;
    return sellFirst(a) - sellFirst(b)
      || seedFirst(a) - seedFirst(b)
      || a.levelIndex - b.levelIndex;
  });
  // R5.5 / audit A1: the native reservation charges every OTHER level for what
  // its own non-terminal ACTION owes, so the open actions are read ONCE here,
  // after phase 0 has already driven every one of them to the truth.
  const pending = await deps.store.listNonTerminalActions(job.quantJobId);
  let lastHold: Extract<PlanResult, { readonly kind: "hold" }> | null = null;
  for (const level of ordered) {
    const outcome = await planLevel(deps, job, levels, pending, level, observation, gas);
    if (outcome.kind === "act") return outcome;
    if (outcome.kind === "hold") lastHold = outcome;
  }
  return lastHold === null ? { kind: "idle" } : lastHold;
}

async function planLevel(
  deps: QuantAdmittedWorkerDeps,
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  pending: readonly QuantActionRow[],
  level: QuantLevelRow,
  observation: QuantObservation,
  gas: GasEvidence,
): Promise<PlanResult> {
  if (level.state === "retired" || level.state === "blocked") return { kind: "idle" };
  const nowMs = deps.nowMs();
  if (level.seedPending && level.state === "armed-quote") {
    if (level.seedRefusals + level.seedSubmissions >= deps.params.seedWindowCycles) {
      await deps.store.withQuantFence(job.quantJobId, async (fence) => {
        await fence.convertSeed({
          quantJobId: job.quantJobId, levelIndex: level.levelIndex,
          seedWindowCycles: deps.params.seedWindowCycles, ladderGen: level.ladderGen,
          expectedProcessDigest: deps.paramsDigest, nowMs,
        });
        await fence.recordLevelOutcome({
          quantJobId: job.quantJobId, levelIndex: level.levelIndex,
          holdCode: "seed-window-expired", seedCounted: false,
          acceptedBlock: observation.blockNumber, ladderGen: level.ladderGen,
          nowMs,
        });
      });
      return { kind: "idle" };
    }
    if (level.lastActionAtMs !== null
      && nowMs - level.lastActionAtMs < deps.params.cooldownSec * 1_000) {
      await recordLevelOutcome(deps, job, level, "cooldown", false, observation, nowMs);
      return { kind: "hold", code: "cooldown" };
    }
    const anchor = job.anchorE18 > 0n ? job.anchorE18 : job.p0E18;
    const withinBand = observation.midE18 * 10_000n >= anchor * (10_000n - BigInt(deps.params.entryTolBps))
      && observation.midE18 * 10_000n <= anchor * (10_000n + BigInt(deps.params.entryTolBps));
    if (!withinBand) {
      await recordLevelOutcome(deps, job, level, "seed-price-drift", true, observation, nowMs);
      return { kind: "hold", code: "seed-price-drift" };
    }
    const actionSeq = level.actionSeq + 1;
    const latest = await deps.reader.latestBlockNumber();
    const outcome = await planBuy(deps, job, levels, pending, level, observation, {
      actionSeq, deadlineSec: actionDeadlineSec(Math.floor(nowMs / 1_000), level.levelIndex),
      latest, wallet: getAddress(job.tradingWallet), nowMs, seed: true,
      gas,
    });
    if (outcome.kind === "hold") {
      const counting = outcome.code === "price-moved"
        || outcome.code === "impact-too-high" || outcome.code === "seed-price-drift";
      await recordLevelOutcome(deps, job, level, outcome.code as QuantHoldCode, counting, observation, nowMs);
    }
    return outcome;
  }
  // Accepted observations own the latch write. Planning consumes the returned
  // post-fence snapshot and never advances evidence a second time.
  const evidence = {
    consecutive: level.triggerConsecutive,
    side: level.triggerSide,
  };
  if (!triggerArmed(evidence)) {
    await recordLevelOutcome(deps, job, level, null, false, observation, nowMs);
    return { kind: "idle" };
  }

  // Cooldown is measured from the action's `created_at`, per level, and is a
  // HOLD: it never advances state.
  if (level.lastActionAtMs !== null
    && nowMs - level.lastActionAtMs < deps.params.cooldownSec * 1_000) {
    await recordLevelOutcome(deps, job, level, "cooldown", false, observation, nowMs);
    return { kind: "hold", code: "cooldown" };
  }

  const wallet = getAddress(job.tradingWallet);
  const latest = await deps.reader.latestBlockNumber();
  const actionSeq = level.actionSeq + 1;
  const deadlineSec = actionDeadlineSec(Math.floor(nowMs / 1_000), level.levelIndex);

  if (evidence.side === "buy") {
    const outcome = await planBuy(deps, job, levels, pending, level, observation, {
      actionSeq, deadlineSec, latest, wallet, nowMs, gas,
    });
    if (outcome.kind === "hold") {
      await recordLevelOutcome(deps, job, level, outcome.code as QuantHoldCode, false, observation, nowMs);
    }
    return outcome;
  }
  const outcome = await planSell(deps, job, level, observation, {
    actionSeq, deadlineSec, latest, wallet, nowMs, gas,
  });
  if (outcome.kind === "hold") {
    await recordLevelOutcome(deps, job, level, outcome.code as QuantHoldCode, false, observation, nowMs);
  }
  return outcome;
}

type PlanContext = {
  readonly actionSeq: number;
  readonly deadlineSec: number;
  readonly latest: bigint;
  readonly wallet: Address;
  readonly nowMs: number;
  readonly seed?: boolean;
  readonly gas: GasEvidence;
};

type InsertIntentResult = QuantActionRow | {
  readonly kind: "hold";
  readonly code: "gas-price-unavailable" | "gas-price-implausible" | "gas-price-moved";
} | null;

/**
 * What ONE other level still owes in submissions, as the inventory
 * `requiredNativeWei` charges exits for (R5.5, audit A1).
 *
 * The two pending cases are read from the ACTION row because the LEVEL row
 * cannot carry them: a level blocked for a buy holds `base_wei = 0` until that
 * buy settles — its expected inventory exists only as the action's
 * `quote_out_wei` — and a level blocked for a sell still holds the WHOLE
 * cycle's base while only `amount_in_wei` of it is leaving. Deriving both from
 * `base_wei`, as the first wiring did, charged a pending buy ONE fee and let
 * two same-cycle-adjacent buys pass with the wallet short of their exits.
 */
function levelObligation(
  level: QuantLevelRow,
  pending: readonly QuantActionRow[],
): LevelObligation {
  if (level.state === "retired") return { kind: "idle", baseWei: 0n };
  const action = pending.find((row) => row.levelIndex === level.levelIndex);
  if (action !== undefined) {
    if (action.side === "buy") {
      return { kind: "pending-buy", baseWei: action.quoteOutWei };
    }
    return {
      kind: "pending-sell",
      baseWei: level.baseWei > action.amountInWei
        ? level.baseWei - action.amountInWei
        : 0n,
    };
  }
  if (level.state === "holding-base") {
    return { kind: "holding-base", baseWei: level.baseWei };
  }
  if (level.state === "blocked") {
    // Unreachable: the insert that blocks a level writes its action in the same
    // transaction. If it ever happened, the level's own inventory is the only
    // honest bound left, and one submission on top of it is the safe side.
    return { kind: "pending-buy", baseWei: level.baseWei };
  }
  return { kind: "idle", baseWei: 0n };
}

async function planBuy(
  deps: QuantAdmittedWorkerDeps,
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  pending: readonly QuantActionRow[],
  level: QuantLevelRow,
  observation: QuantObservation,
  ctx: PlanContext,
): Promise<PlanResult> {
  if (ctx.nowMs - ctx.gas.gasReadAtMs > GAS_MAX_AGE_MS) {
    return { kind: "hold", code: "gas-price-unavailable" };
  }
  const minOutWei = buyMinOut({
    clipUWei: job.clipUWei,
    buyPriceE18: ctx.seed ? (job.anchorE18 > 0n ? job.anchorE18 : job.p0E18) : level.buyPriceE18,
    levelIndex: level.levelIndex,
    actionSeq: ctx.actionSeq,
    params: deps.params,
  });
  const path = directPath(deps.venue.u, deps.venue.wbnb);
  let quoteOutWei: bigint;
  try {
    quoteOutWei = await deps.reader.quoteV2At(
      deps.venue.router, path, job.clipUWei, ctx.latest,
    );
  } catch {
    return { kind: "hold", code: "quote-unavailable" };
  }
  // BC16: the quote is compared against the FINAL TAGGED minimum, never the
  // untagged floor.
  const acceptable = quoteAcceptable({
    quoteOutWei,
    minOutWei,
    quoteBlock: ctx.latest,
    triggerBlock: observation.blockNumber,
    maxQuoteLagBlocks: deps.params.maxQuoteLagBlocks,
  });
  if (!acceptable.ok) return { kind: "hold", code: acceptable.code };

  const impactBps = await measureImpactBps(deps, job.clipUWei, ctx.latest);
  if (impactBps > BigInt(deps.params.maxImpactBps)) {
    return { kind: "hold", code: "impact-too-high" };
  }

  /* Native reservation and the gas balance (R5.5 / R6.4). */
  const others: LevelObligation[] = levels
    .filter((row) => row.levelIndex !== level.levelIndex)
    .map((row) => levelObligation(row, pending));
  const required = requiredNativeWei({
    side: "buy",
    ownBaseWei: quoteOutWei,
    otherLevels: others,
    minCapLimitWei: job.wbnbCapMinLimitWei,
    params: deps.params, gasPriceWei: ctx.gas.gasPriceWei,
  });
  let nativeBalance: bigint;
  try {
    nativeBalance = await deps.reader.nativeBalanceAt(ctx.wallet);
  } catch {
    return { kind: "hold", code: "meter-unreadable" };
  }
  if (nativeBalance < required) {
    return {
      kind: "hold", code: "no-gas",
      detail: `balance=${nativeBalance} required=${required} shortfall=${required - nativeBalance}`,
    };
  }

  /* The U budget, enforced by US, independently of session authority (R4.5). */
  const budget = await checkUBudget(deps, job, job.clipUWei, ctx.nowMs);
  if (!budget.ok) return { kind: "hold", code: budget.code };

  const calls = buildPancakeTokenSwap({
    router: deps.venue.router,
    tokenIn: deps.venue.u,
    tokenOut: deps.venue.wbnb,
    amountInWei: job.clipUWei,
    minOutWei,
    recipient: ctx.wallet,
    deadline: BigInt(ctx.deadlineSec),
  });
  const inserted = await insertIntent(deps, job, level, {
    side: "buy",
    actionSeq: ctx.actionSeq,
    amountInWei: job.clipUWei,
    minOutWei,
    quoteOutWei,
    quoteBlock: ctx.latest,
    triggerBlock: observation.blockNumber,
    deadlineSec: ctx.deadlineSec,
    calls,
    impactBps: Number(impactBps),
    basisUWei: 0n,
    baseAtCycleStartWei: 0n,
    wallet: ctx.wallet,
    observation,
    seed: ctx.seed === true,
    requiredNativeWei: required,
    preNativeBlock: ctx.latest,
    plannedAccountingRev: job.accountingRev,
    plannedAccountingEpoch: job.accountingEpoch,
    gasPriceWei: ctx.gas.gasPriceWei,
    feeEstWei: ctx.gas.feeEstWei,
    gasReadAtMs: ctx.gas.gasReadAtMs,
    nowMs: ctx.nowMs,
  });
  if (inserted === null) return { kind: "hold", code: "store-conflict" };
  if ("kind" in inserted) return { kind: "hold", code: inserted.code };
  return {
    kind: "act", action: inserted, calls,
    requiredNativeWei: required, tokenIn: deps.venue.u,
  };
}

async function planSell(
  deps: QuantAdmittedWorkerDeps,
  job: QuantJobRow,
  level: QuantLevelRow,
  observation: QuantObservation,
  ctx: PlanContext,
): Promise<PlanResult> {
  if (ctx.nowMs - ctx.gas.gasReadAtMs > GAS_MAX_AGE_MS) {
    return { kind: "hold", code: "gas-price-unavailable" };
  }
  // R7.2: the chunk comes from the PARTITION of the ACTUAL inventory, and each
  // chunk waits for capacity for the WHOLE chunk on every cap row.
  const chunks = job.wbnbCapMinLimitWei > 0n
    ? partitionExit(level.baseWei, job.wbnbCapMinLimitWei)
    : [level.baseWei];
  const amountWei = chunks[0] ?? 0n;
  if (amountWei <= 0n) return { kind: "idle" };

  const floor = sellFloor({
    amountWei,
    baseWei: level.baseWei,
    baseAtCycleStartWei: level.baseAtCycleStartWei > 0n
      ? level.baseAtCycleStartWei : level.baseWei,
    basisUWei: level.basisUWei,
    entryCostUWei: level.entryCostUWei,
    sellPriceE18: level.sellPriceE18,
    // BC29: the exit-fee bound is valued at the CURRENT mid on every intent,
    // never frozen at settlement time.
    midE18: observation.midE18,
    levelIndex: level.levelIndex,
    actionSeq: ctx.actionSeq,
    params: deps.params, gasPriceWei: ctx.gas.gasPriceWei,
  });
  const path = directPath(deps.venue.wbnb, deps.venue.u);
  let quoteOutWei: bigint;
  try {
    quoteOutWei = await deps.reader.quoteV2At(deps.venue.router, path, amountWei, ctx.latest);
  } catch {
    return { kind: "hold", code: "quote-unavailable" };
  }
  const acceptable = quoteAcceptable({
    quoteOutWei,
    minOutWei: floor.minOutWei,
    quoteBlock: ctx.latest,
    triggerBlock: observation.blockNumber,
    maxQuoteLagBlocks: deps.params.maxQuoteLagBlocks,
  });
  if (!acceptable.ok) {
    // A chunk whose proceeds cannot meet its floor is an ECONOMIC HOLD naming
    // the price it needs — never a closure and never an abandonment of
    // inventory (R7.2). A FINAL chunk below the persisted residual threshold is
    // the only one that may close as residual, and settlement does that.
    const residualEligible = chunks.length === 1
      && amountWei < job.residualThresholdWei;
    return {
      kind: "hold",
      code: residualEligible ? "exit-capacity" : "exit-uneconomic-at-price",
    };
  }
  const impactBps = quantPriceImpactBps(
    quoteOutWei,
    amountWei / 100n <= 0n
      ? quoteOutWei / 100n
      : await deps.reader.quoteV2At(deps.venue.router, path, amountWei / 100n, ctx.latest),
  );
  if (impactBps > BigInt(deps.params.maxImpactBps)) {
    return { kind: "hold", code: "impact-too-high" };
  }

  // R6.4: a SELL reserves ONE fee and nothing else. Exits reduce exposure and
  // must never be blocked by another level's reserve.
  const required = requiredNativeWei({
    side: "sell",
    ownBaseWei: 0n,
    otherLevels: [],
    minCapLimitWei: job.wbnbCapMinLimitWei,
    params: deps.params, gasPriceWei: ctx.gas.gasPriceWei,
  });
  let nativeBalance: bigint;
  try {
    nativeBalance = await deps.reader.nativeBalanceAt(ctx.wallet);
  } catch {
    return { kind: "hold", code: "meter-unreadable" };
  }
  if (nativeBalance < required) {
    return {
      kind: "hold", code: "no-gas",
      detail: `balance=${nativeBalance} required=${required} shortfall=${required - nativeBalance}`,
    };
  }

  const calls = buildPancakeTokenSwap({
    router: deps.venue.router,
    tokenIn: deps.venue.wbnb,
    tokenOut: deps.venue.u,
    amountInWei: amountWei,
    minOutWei: floor.minOutWei,
    recipient: ctx.wallet,
    deadline: BigInt(ctx.deadlineSec),
  });
  const inserted = await insertIntent(deps, job, level, {
    side: "sell",
    actionSeq: ctx.actionSeq,
    amountInWei: amountWei,
    minOutWei: floor.minOutWei,
    quoteOutWei,
    quoteBlock: ctx.latest,
    triggerBlock: observation.blockNumber,
    deadlineSec: ctx.deadlineSec,
    calls,
    impactBps: Number(impactBps),
    basisUWei: level.basisUWei,
    baseAtCycleStartWei: level.baseAtCycleStartWei > 0n
      ? level.baseAtCycleStartWei : level.baseWei,
    wallet: ctx.wallet,
    observation,
    requiredNativeWei: required,
    preNativeBlock: ctx.latest,
    plannedAccountingRev: job.accountingRev,
    plannedAccountingEpoch: job.accountingEpoch,
    gasPriceWei: ctx.gas.gasPriceWei,
    feeEstWei: ctx.gas.feeEstWei,
    gasReadAtMs: ctx.gas.gasReadAtMs,
    nowMs: ctx.nowMs,
  });
  if (inserted === null) return { kind: "hold", code: "store-conflict" };
  if ("kind" in inserted) return { kind: "hold", code: inserted.code };
  return {
    kind: "act", action: inserted, calls,
    requiredNativeWei: required, tokenIn: deps.venue.wbnb,
  };
}

/**
 * The daily U budget, enforced by US and never from the journal's native spend
 * (R2.8, R4.5, R7.3).
 *
 * Execution-time anchoring for SETTLED buys; FULL RESERVATION for every buy in
 * any non-terminal state, however old — including a retired level's unknown
 * buy, which stays reserved until `deadline + 24 h` (R7.3).
 */
async function checkUBudget(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  clipUWei: bigint,
  nowMs: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: QuantHoldCode }> {
  const actions = await deps.store.listActions(job.quantJobId);
  const levels = await deps.store.listLevels(job.quantJobId);
  return checkUBudgetSnapshot(job, actions, levels, clipUWei, nowMs);
}

function checkUBudgetSnapshot(
  job: QuantJobRow,
  actions: readonly QuantActionRow[],
  levels: readonly QuantLevelRow[],
  clipUWei: bigint,
  nowMs: number,
): { readonly ok: true } | { readonly ok: false; readonly code: QuantHoldCode } {
  let reserved = 0n;
  let openBasis = 0n;
  for (const action of actions) {
    if (action.side !== "buy") continue;
    const terminal = action.state === "settled" || action.state === "failed"
      || action.state === "aborted";
    if (!terminal) {
      const deadlineWindowEnd = action.deadlineSec * 1_000 + DAY_MS;
      if (nowMs <= deadlineWindowEnd) reserved += action.amountInWei;
      continue;
    }
    if (action.state !== "settled" || action.fillInWei === null) continue;
    const executedAtMs = action.executedAtSec === null ? action.updatedAtMs : Number(action.executedAtSec) * 1_000;
    if (nowMs - executedAtMs < DAY_MS) reserved += action.fillInWei;
  }
  for (const level of levels) {
    if (level.state === "holding-base") openBasis += level.basisUWei;
  }
  if (reserved + clipUWei > job.dailyCapUWei) {
    return { ok: false, code: "day-cap-exhausted" };
  }
  if (openBasis + clipUWei > job.allocationUWei) {
    return { ok: false, code: "u-budget-exhausted" };
  }
  return { ok: true };
}

async function insertIntent(
  deps: QuantAdmittedWorkerDeps,
  job: QuantJobRow,
  level: QuantLevelRow,
  input: {
    readonly side: "buy" | "sell";
    readonly actionSeq: number;
    readonly amountInWei: bigint;
    readonly minOutWei: bigint;
    readonly quoteOutWei: bigint;
    readonly quoteBlock: bigint;
    readonly triggerBlock: bigint;
    readonly deadlineSec: number;
    readonly calls: readonly { readonly to: Address; readonly value?: bigint; readonly data?: Hex }[];
    readonly impactBps: number;
    readonly basisUWei: bigint;
    readonly baseAtCycleStartWei: bigint;
    readonly wallet: Address;
    readonly observation: QuantObservation;
    readonly seed?: boolean;
    readonly requiredNativeWei: bigint;
    readonly preNativeBlock?: bigint;
    readonly plannedAccountingRev?: bigint;
    readonly plannedAccountingEpoch?: number | null;
    readonly gasPriceWei: bigint;
    readonly feeEstWei: bigint;
    readonly gasReadAtMs: number;
    readonly nowMs: number;
  },
): Promise<InsertIntentResult> {
  const [preU, preWbnb, preNative] = await Promise.all([
    deps.reader.tokenBalanceAt(deps.venue.u, input.wallet).catch(() => 0n),
    deps.reader.tokenBalanceAt(deps.venue.wbnb, input.wallet).catch(() => 0n),
    deps.reader.nativeBalanceAt(input.wallet).catch(() => null),
  ]);
  if (preNative === null) return null;
  // The DECISION NOTE is written BEFORE the submit, and it is what the term-end
  // report replays (their skill's rule: a note invented at term end is a
  // rationalisation). It is bounded at 2000 chars and NEVER passes through
  // `sanitizeMessage`, whose 280-char cap and hash redaction would destroy it
  // (R2.15).
  const note = JSON.stringify({
    v: 1,
    level: level.levelIndex,
    side: input.side,
    seq: input.actionSeq,
    triggerBlock: input.triggerBlock.toString(10),
    triggerMidE18: input.observation.midE18.toString(10),
    quoteBlock: input.quoteBlock.toString(10),
    quoteOutWei: input.quoteOutWei.toString(10),
    minOutWei: input.minOutWei.toString(10),
    impactBps: input.impactBps,
    gasPriceWei: input.gasPriceWei.toString(10),
    feeEstWei: input.feeEstWei.toString(10),
    feeEstUWei: feeEstInU(deps.params, input.observation.midE18, input.gasPriceWei).toString(10),
    bandBps: deps.params.bandBps,
    evidenceKind: input.seed === true ? "seed" : "crossing",
  }).slice(0, 2_000);
  let preClaimCode: "gas-price-unavailable" | "gas-price-implausible" | "gas-price-moved" | null = null;
  const result = await deps.store.withQuantFence(job.quantJobId, async (fence: QuantFence) => {
    // RE-READ inside the fence. The trigger latch was written earlier in this
    // cycle, which bumped the level's `row_version`, so the row this decision
    // started from is already stale — and an intent CAS'd against a stale
    // version would silently never insert. The fence is what makes the re-read
    // and the insert one transaction.
    const [fencedJob, fencedLevels, fencedPending, recentBuys] = await Promise.all([
      fence.getJob(job.quantJobId),
      fence.listLevels(job.quantJobId),
      fence.listNonTerminalActions(job.quantJobId),
      fence.listRecentBuys(job.quantJobId, input.nowMs - DAY_MS),
    ]);
    const current = fencedLevels
      .find((row) => row.levelIndex === level.levelIndex);
    if (fencedJob === null || current === undefined) {
      return { kind: "conflict" as const, record: null };
    }
    let refreshedGas: bigint;
    try {
      refreshedGas = await deps.reader.gasPriceWei();
    } catch {
      preClaimCode = "gas-price-unavailable";
      return null;
    }
    if (refreshedGas <= 0n) {
      preClaimCode = "gas-price-unavailable";
      return null;
    }
    if (refreshedGas > MAX_GAS_PRICE_WEI) {
      preClaimCode = "gas-price-implausible";
      return null;
    }
    if (input.nowMs - input.gasReadAtMs > GAS_MAX_AGE_MS
      || feeEstWei(deps.params, input.gasPriceWei) !== input.feeEstWei) {
      preClaimCode = "gas-price-moved";
      return null;
    }
    if (feeEstWei(deps.params, refreshedGas) > input.feeEstWei) {
      preClaimCode = "gas-price-moved";
      return null;
    }
    if (input.side === "buy") {
      const actionByKey = new Map<string, QuantActionRow>();
      for (const row of recentBuys) actionByKey.set(row.journalKey, row);
      for (const row of fencedPending) actionByKey.set(row.journalKey, row);
      const budget = checkUBudgetSnapshot(
        fencedJob, [...actionByKey.values()], fencedLevels, input.amountInWei, input.nowMs,
      );
      if (!budget.ok) return { kind: "conflict" as const, record: null };
    }
    const fencedRequiredNativeWei = requiredNativeWei({
      side: input.side,
      ownBaseWei: input.side === "buy" ? input.quoteOutWei : 0n,
      otherLevels: fencedLevels
        .filter((row) => row.levelIndex !== current.levelIndex)
        .map((row) => levelObligation(row, fencedPending)),
      minCapLimitWei: fencedJob.wbnbCapMinLimitWei,
      params: deps.params, gasPriceWei: input.gasPriceWei,
    });
    return fence.insertIntent({
      journalKey: quantJournalKey(job.quantJobId, current.levelIndex, input.actionSeq),
      quantJobId: job.quantJobId,
      levelIndex: current.levelIndex,
      actionSeq: input.actionSeq,
      side: input.side,
      priorLevelState: current.state,
      expectedLevelRowVersion: current.rowVersion,
      amountInWei: input.amountInWei,
      minOutWei: input.minOutWei,
      quoteOutWei: input.quoteOutWei,
      quoteBlock: input.quoteBlock,
      triggerBlock1: input.triggerBlock,
      triggerBlock2: input.triggerBlock,
      deadlineSec: input.deadlineSec,
      callsJson: JSON.stringify(input.calls.map((call) => ({
        to: call.to,
        value: (call.value ?? 0n).toString(10),
        data: call.data ?? "0x",
      }))),
      note,
      impactBps: input.impactBps,
      preUWei: preU,
      preWbnbWei: preWbnb,
      preNativeWei: preNative,
      preNativeBlock: input.preNativeBlock ?? null,
      basisUWei: input.basisUWei,
      baseAtCycleStartWei: input.baseAtCycleStartWei,
      ladderGen: current.ladderGen,
      evidence: input.seed === true
        ? { kind: "seed", accepted: input.observation.blockNumber }
        : {
          kind: "crossing",
          first: current.triggerBlockFirst ?? input.observation.blockNumber,
          second: input.observation.blockNumber,
        },
      // Recomputed from the rows read on this fence. The planner's earlier
      // estimate is advisory; the persisted claim carries this value.
      requiredNativeWei: fencedRequiredNativeWei,
      gasPriceWei: input.gasPriceWei,
      feeEstWei: input.feeEstWei,
      plannedWallet: input.wallet,
      plannedProcessDigest: deps.paramsDigest,
      planObservationBlock: input.observation.blockNumber,
      planObservationHash: input.observation.blockHash,
      planObservationAtMs: input.observation.observedAtMs,
      ...(input.plannedAccountingRev === undefined ? {} : {
        plannedAccountingRev: input.plannedAccountingRev,
      }),
      ...(input.plannedAccountingEpoch === undefined ? {} : {
        plannedAccountingEpoch: input.plannedAccountingEpoch,
      }),
      planTriggerFirst: current.triggerBlockFirst,
      plannedBuyPriceE18: current.buyPriceE18,
      plannedSellPriceE18: current.sellPriceE18,
      seedWindowCycles: deps.params.seedWindowCycles,
      maxQuoteLagBlocks: deps.params.maxQuoteLagBlocks,
      nowMs: input.nowMs,
    });
  });
  if (preClaimCode !== null) return { kind: "hold", code: preClaimCode };
  if (result === null) return null;
  return result.kind === "ok" ? result.record : null;
}

async function recordLevelOutcome(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  level: QuantLevelRow,
  holdCode: QuantHoldCode | null,
  seedCounted: boolean,
  observation: QuantObservation,
  nowMs: number,
): Promise<void> {
  await deps.store.withQuantFence(job.quantJobId, async (fence) => {
    await fence.recordLevelOutcome({
      quantJobId: job.quantJobId, levelIndex: level.levelIndex, holdCode,
      seedCounted, acceptedBlock: observation.blockNumber, acceptedHash: observation.blockHash,
      acceptedAtMs: observation.observedAtMs, ladderGen: level.ladderGen,
      expectedProcessDigest: deps.paramsDigest,
      ...(holdCode === null ? {} : { cause: holdCode }), nowMs,
    });
  });
}

async function maybeRecenter(
  deps: QuantAdmittedWorkerDeps,
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  observation: QuantObservation,
  gas: GasEvidence,
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "hold"; readonly code: QuantHoldCode }
  | { readonly kind: "recentered"; readonly side: "up" | "down" }
> {
  const preview = previewRecenter(job, levels, observation, deps.params);
  if (preview.kind === "none") return { kind: "none" };
  if (preview.kind === "hold") {
    if (preview.code === "recenter-budget-exhausted" || preview.code === "recenter-cooldown"
      || preview.code === "recenter-busy" || preview.code === "recenter-retired") {
      await hold(deps, job.quantJobId, preview.code);
    }
    return { kind: "hold", code: preview.code };
  }
  if (preview.side === "down" && isTaggedDownNoop(job, levels, observation, preview, deps.params, gas)) {
    await deps.store.resetLatches(job.quantJobId, false);
    await hold(deps, job.quantJobId, "recenter-noop");
    return { kind: "hold", code: "recenter-noop" };
  }
  let seedQuoteOutWei: bigint | undefined;
  if (preview.reseed) {
    try {
      const path = directPath(deps.venue.u, deps.venue.wbnb);
      seedQuoteOutWei = deps.reader.quoteV2AtHash === undefined
        ? await deps.reader.quoteV2At(deps.venue.router, path, job.clipUWei, observation.blockNumber)
        : await deps.reader.quoteV2AtHash(deps.venue.router, path, job.clipUWei, observation.blockHash);
    } catch {
      await hold(deps, job.quantJobId, "recenter-deferred");
      return { kind: "hold", code: "recenter-deferred" };
    }
  }
  let reseedNativeBalance: bigint | null = null;
  if (preview.reseed) {
    const upper = levels.find((row) => row.levelIndex === job.levels);
    if (upper === undefined) return { kind: "hold", code: "recenter-deferred" };
    const [uBalance, nativeBalance] = await Promise.all([
      deps.reader.tokenBalanceAt(deps.venue.u, job.tradingWallet).catch(() => 0n),
      deps.reader.nativeBalanceAt(job.tradingWallet).catch(() => 0n),
    ]);
    reseedNativeBalance = nativeBalance;
    if (uBalance < job.clipUWei || nativeBalance <= 0n) {
      await hold(deps, job.quantJobId, "recenter-deferred");
      return { kind: "hold", code: "recenter-deferred" };
    }
    if (job.sessionPublicKey === null) {
      await hold(deps, job.quantJobId, "recenter-deferred");
      return { kind: "hold", code: "recenter-deferred" };
    }
    const otherLevels = levels.filter((row) => row.levelIndex !== upper.levelIndex)
      .map((row) => levelObligation(row, []));
    const required = requiredNativeWei({
      side: "buy", ownBaseWei: seedQuoteOutWei ?? 0n, otherLevels,
      minCapLimitWei: job.wbnbCapMinLimitWei, params: deps.params,
      gasPriceWei: gas.gasPriceWei,
    });
    const meters = await checkQuantMeters({
      provider: deps.provider, walletAddress: job.tradingWallet,
      publicKey: job.sessionPublicKey, tokenIn: deps.venue.u,
      amountInWei: job.clipUWei, requiredNativeWei: required,
    });
    if (!meters.ok) {
      await hold(deps, job.quantJobId, "recenter-deferred");
      return { kind: "hold", code: "recenter-deferred" };
    }
    const chain = await runChainAdmissionChecks({
      reads: deps.chainAdmission, wallet: job.tradingWallet,
      keyHash: accountKeyHashForAddress(publicKeyToAddress(job.sessionPublicKey)),
      publicKey: job.sessionPublicKey,
      probes: buildAdmissionProbes(deps, job.clipUWei, job.tradingWallet),
    });
    if (!chain.ok) {
      await hold(deps, job.quantJobId, "recenter-deferred");
      return { kind: "hold", code: "recenter-deferred" };
    }
  }
  let impact: bigint;
  try {
    impact = await measureImpactBps(deps, job.clipUWei, observation.blockNumber, observation.blockHash);
  } catch {
    await hold(deps, job.quantJobId, "recenter-deferred");
    return { kind: "hold", code: "recenter-deferred" };
  }
  const economics = armFloor({
    clipUWei: job.clipUWei, midE18: observation.midE18, impactBps: impact,
    params: deps.params, gasPriceWei: gas.gasPriceWei,
  });
  if (!economics.economic) {
    await hold(deps, job.quantJobId, "recenter-uneconomic");
    return { kind: "hold", code: "recenter-uneconomic" };
  }
  let capRows: readonly { readonly token: Address | null; readonly limit: bigint }[] = [];
  try {
    const parsed: unknown = job.capRowsJson === null ? [] : JSON.parse(job.capRowsJson);
    if (Array.isArray(parsed)) {
      capRows = parsed.map((row) => {
        if (typeof row !== "object" || row === null) throw new Error("cap");
        const item = row as Record<string, unknown>;
        return {
          token: item["token"] === null ? null : getAddress(String(item["token"])),
          limit: BigInt(String(item["limit"])),
        };
      });
    }
  } catch {
    await hold(deps, job.quantJobId, "recenter-cap-too-small");
    return { kind: "hold", code: "recenter-cap-too-small" };
  }
  const ladderGate = checkLadderAdmissible({
    ladder: { levels: job.levels, clipUWei: job.clipUWei, buyPrice: preview.buyPrice,
      sellPrice: preview.sellPrice, midE18: observation.midE18,
      ...(preview.sellPrice[Math.max(1, job.levels - 1)] === undefined ? {} : {
        minSellPriceE18: preview.sellPrice[Math.max(1, job.levels - 1)]!,
      }) },
    allocationUWei: job.allocationUWei, dailyCapUWei: job.dailyCapUWei, capRows,
    u: deps.venue.u, wbnb: deps.venue.wbnb, impactBps: impact, params: deps.params,
    gasPriceWei: gas.gasPriceWei,
    ...(seedQuoteOutWei === undefined ? {} : { seedQuoteOutWei }),
    ...(preview.reseed ? {
      seedActionSeq: (levels.find((row) => row.levelIndex === job.levels)?.actionSeq ?? 0) + 1,
    } : {}),
  });
  if (!ladderGate.ok) {
    const code = ladderGate.code === "arm-uneconomic" ? "recenter-uneconomic"
      : ladderGate.code === "seed-unexecutable" ? "seed-unexecutable" : "recenter-cap-too-small";
    await hold(deps, job.quantJobId, code);
    return { kind: "hold", code };
  }
  if (preview.reseed) {
    try {
      const [freshU, freshNative] = await Promise.all([
        deps.reader.tokenBalanceAt(deps.venue.u, job.tradingWallet),
        deps.reader.nativeBalanceAt(job.tradingWallet),
      ]);
      if (freshU < job.clipUWei) {
        await hold(deps, job.quantJobId, "recenter-deferred");
        return { kind: "hold", code: "recenter-deferred" };
      }
      reseedNativeBalance = freshNative;
    } catch {
      await hold(deps, job.quantJobId, "recenter-deferred");
      return { kind: "hold", code: "recenter-deferred" };
    }
  }
  const result = await deps.store.withQuantFence(job.quantJobId, async (fence) => {
    const [fencedJob, fencedLevels, fencedPending, recentBuys] = await Promise.all([
      fence.getJob(job.quantJobId),
      fence.listLevels(job.quantJobId),
      fence.listNonTerminalActions(job.quantJobId),
      fence.listRecentBuys(job.quantJobId, deps.nowMs() - DAY_MS),
    ]);
    if (fencedJob === null) return { kind: "conflict" as const, record: null };
    if (preview.reseed) {
      const actionByKey = new Map<string, QuantActionRow>();
      for (const row of recentBuys) actionByKey.set(row.journalKey, row);
      for (const row of fencedPending) actionByKey.set(row.journalKey, row);
      const budget = checkUBudgetSnapshot(
        fencedJob, [...actionByKey.values()], fencedLevels, fencedJob.clipUWei, deps.nowMs(),
      );
      if (!budget.ok) return { kind: "deferred" as const };
      const upper = fencedLevels.find((row) => row.levelIndex === fencedJob.levels);
      const required = requiredNativeWei({
        side: "buy", ownBaseWei: seedQuoteOutWei ?? 0n,
        otherLevels: fencedLevels
          .filter((row) => row.levelIndex !== upper?.levelIndex)
          .map((row) => levelObligation(row, fencedPending)),
        minCapLimitWei: fencedJob.wbnbCapMinLimitWei, params: deps.params,
        gasPriceWei: gas.gasPriceWei,
      });
      if (reseedNativeBalance === null || required > reseedNativeBalance) {
        return { kind: "deferred" as const };
      }
    }
    return fence.recenterLadder({
      quantJobId: job.quantJobId, expectedGeneration: job.ladderGen,
      observationBlock: observation.blockNumber, observationHash: observation.blockHash,
      observationAtMs: observation.observedAtMs, side: preview.side,
      newAnchorE18: observation.midE18, newBuyPrice: preview.buyPrice,
      newSellPrice: preview.sellPrice, cause: preview.cause, nowMs: deps.nowMs(),
      reseed: preview.reseed, cooldownSec: deps.params.recenterCooldownSec,
      expectedWallet: job.tradingWallet, expectedProcessDigest: deps.paramsDigest,
    });
  });
  if (result.kind === "deferred") {
    await hold(deps, job.quantJobId, "recenter-deferred");
    return { kind: "hold", code: "recenter-deferred" };
  }
  if (result.kind !== "ok") {
    await hold(deps, job.quantJobId, "recenter-conflict");
    return { kind: "hold", code: "recenter-conflict" };
  }
  return { kind: "recentered", side: preview.side };
}

function isTaggedDownNoop(
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  observation: QuantObservation,
  preview: Extract<QuantRecenterPreview, { readonly kind: "recenter" }>,
  params: QuantAdmittedParams,
  gas: GasEvidence,
): boolean {
  if (levels.some((level) => level.state !== "holding-base")) return false;
  return levels.every((level) => {
    const amount = partitionExit(level.baseWei, job.wbnbCapMinLimitWei)[0] ?? 0n;
    if (amount <= 0n) return true;
    const common = {
      amountWei: amount, baseWei: level.baseWei,
      baseAtCycleStartWei: level.baseAtCycleStartWei || level.baseWei,
      basisUWei: level.basisUWei, entryCostUWei: level.entryCostUWei,
      midE18: observation.midE18, levelIndex: level.levelIndex,
      actionSeq: level.actionSeq + 1, params, gasPriceWei: gas.gasPriceWei,
    };
    const oldFloor = sellFloor({ ...common, sellPriceE18: level.sellPriceE18 });
    const newFloor = sellFloor({
      ...common, sellPriceE18: preview.sellPrice[level.levelIndex] ?? level.sellPriceE18,
    });
    return oldFloor.minOutWei === newFloor.minOutWei;
  });
}

/* -------------------------------------------------------------------------- */
/* Term end                                                                   */
/* -------------------------------------------------------------------------- */

async function finishTerm(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  notes: string[],
  dryRun: boolean,
): Promise<JobOutcome> {
  const nowMs = deps.nowMs();
  const pending = await deps.store.listNonTerminalActions(job.quantJobId);
  if (pending.length > 0) {
    if (job.status !== "reported") {
      await deps.store.markEnded({ quantJobId: job.quantJobId, unresolved: true, nowMs });
      notes.push(`${job.quantJobId}:ended-unresolved`);
    }
    return { actions: 0, holds: 0, notes };
  }
  if (dryRun) {
    return { actions: 0, holds: 0, notes };
  }
  // Max 24 attempts with the store's own attempt counter as the backoff.
  if (job.reportAttempts >= 24) {
    notes.push(`${job.quantJobId}:report-exhausted`);
    return { actions: 0, holds: 0, notes };
  }
  const actions = await deps.store.listActions(job.quantJobId);
  if (job.status === "reported" && job.reportedAtMs !== null
    && !actions.some((action) => action.state === "settled" && action.updatedAtMs > job.reportedAtMs!)) {
    return { actions: 0, holds: 0, notes };
  }
  if (job.status !== "ended" && job.status !== "ended-unresolved" && job.status !== "reported") {
    await deps.store.markEnded({ quantJobId: job.quantJobId, unresolved: false, nowMs });
  }
  const trades = actions
    .filter((action) => action.state === "settled" && action.txHash !== null)
    .map((action) => ({ txHash: action.txHash as Hex, note: action.note.slice(0, 2_000) }));
  const payload = { trades };
  const digest = digestOf(payload);
  const response = await deps.transport.report(job.quantJobId, payload);
  await deps.store.recordReport({
    quantJobId: job.quantJobId,
    payloadDigest: digest,
    responseStatus: response.ok ? 200 : 0,
    notesApplied: response.ok ? response.data.notesApplied : null,
    nowMs,
  });
  if (response.ok) {
    await deps.store.markReported({ quantJobId: job.quantJobId, nowMs });
  } else {
    await deps.store.markEnded({ quantJobId: job.quantJobId, unresolved: false, nowMs });
  }
  notes.push(`${job.quantJobId}:${response.ok ? "reported" : "report-retry"}`);
  return { actions: 0, holds: 0, notes };
}

function digestOf(payload: unknown): Hex {
  // A digest of what we SENT, so a re-send is recognisable as a re-send and
  // `quant_reports` records every attempt rather than only the last.
  return keccak256(stringToHex(JSON.stringify(payload)));
}

/** Exported so `status` can render the same partition the worker plans on. */
export { partitionExit, ceilDiv };

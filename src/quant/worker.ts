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
} from "../store/quantJobs.js";
import type { WalletProvider } from "../core/types.js";
import { buildPancakeTokenSwap, directPath } from "../ops/pancakeTokens.js";
import {
  assertQuantSessionAdmissible,
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
  advanceTrigger,
  armFloor,
  buildLadder,
  buyMinOut,
  ceilDiv,
  levelTriggerSide,
  midFromReserves,
  partitionExit,
  quantPriceImpactBps,
  quoteAcceptable,
  requiredNativeWei,
  sellFloor,
  triggerArmed,
  type LevelObligation,
} from "./grid.js";
import { quantJournalKey, submitQuantAction, type QuantExecuteDeps } from "./execute.js";
import { recoverUnsettledActions, type QuantReconcileDeps } from "./reconcile.js";
import { orderedReserves, type QuantChainReader } from "./readers.js";
import type { QuantTransport } from "./termix.js";
import type { QuantKeypair } from "./envelope.js";
import type { QuantStrategyParams } from "./config.js";
import type { QuantHoldCode, QuantObservation } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

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
  if (!wire.ok) {
    await deps.store.setJobStatus({
      quantJobId: jobRow.quantJobId,
      status: jobRow.status === "discovered" ? "discovered" : jobRow.status,
      holdCode: wire.code === "wire-invalid" ? "wire-invalid" : "inbox-unavailable",
      nowMs,
    });
    return { actions: 0, holds: 1, notes: [`${jobRow.quantJobId}:${wire.code}`] };
  }
  const record = wire.data;
  const job = (await deps.store.updateJobWire({
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
  }));
  if (job === null) {
    // QUANT-SELFTEST R7: the wire now names a different strategy than the one
    // this row belongs to. Nothing of it is applied and no intent is planned.
    await deps.store.setJobStatus({
      quantJobId: jobRow.quantJobId, status: jobRow.status, holdCode: "foreign-strategy", nowMs,
    });
    return { actions: 0, holds: 1, notes: [`${jobRow.quantJobId}:foreign-strategy:wire-changed`] };
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

  const levels = await deps.store.listLevels(job.quantJobId);
  if (levels.length === 0) return { actions: 0, holds: 0, notes };

  /* Observation. */
  const observation = options.observationSource === undefined
    ? await readObservation(deps, job)
    : await options.observationSource(job);
  const fresh = job.lastObservedBlock === null
    || observation.blockNumber > job.lastObservedBlock;
  await deps.store.withQuantFence(job.quantJobId, async (fence) => {
    if (!fresh) {
      // R3.9: identity IS the finalized block number. A repeated `--once`
      // against one lagging node cannot manufacture the second reading, and a
      // height regression across RPCs is harmless rather than a counter reset.
      await fence.markStaleObservation(job.quantJobId, job.staleObservations + 1);
      if (job.staleObservations + 1 >= 2) {
        // Two stale readings in a row is an OUTAGE, and BC13 resets the latches.
        for (const level of levels) {
          await fence.setLevelTrigger({
            quantJobId: job.quantJobId, levelIndex: level.levelIndex,
            consecutive: 0, side: null,
          });
        }
      }
      return;
    }
    await fence.recordObservation({ quantJobId: job.quantJobId, observation });
  });
  if (!fresh) {
    notes.push(`${job.quantJobId}:stale-observation`);
    return { actions: 0, holds: 1, notes };
  }

  if (dryRun) {
    // Dry-run reaches exactly this far: everything through "decide", then
    // `hold: dry-run`, no claim, no submit, and no state write but the run row.
    notes.push(`${job.quantJobId}:dry-run`);
    return { actions: 0, holds: 1, notes };
  }

  /* Decide, claim, release, submit — ONE submission per job per cycle. */
  const planned = await planOneAction(deps, job, levels, observation);
  if (planned.kind === "hold") {
    notes.push(`${job.quantJobId}:${planned.code}`);
    return { actions: 0, holds: 1, notes };
  }
  if (planned.kind === "idle") return { actions: 0, holds: 0, notes };

  const executeDeps: QuantExecuteDeps = {
    store: deps.store, journal: deps.journal, provider: deps.provider,
    reader: deps.reader, keypair: deps.keypair, params: deps.params,
    venue: deps.venue, nowMs: deps.nowMs,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
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
  const reserves = await deps.reader.reservesAt(deps.venue.pair, finalized.number);
  const ordered = orderedReserves(reserves, deps.venue.u);
  void job;
  return {
    blockNumber: finalized.number,
    blockHash: finalized.hash,
    observedAtMs: deps.nowMs(),
    midE18: midFromReserves(ordered.reserveUWei, ordered.reserveWbnbWei),
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

  const observation = await readObservation(deps, job);
  const ladderResult = buildLadder({
    allocationUWei: job.allocationUWei,
    p0E18: observation.midE18,
    params: deps.params,
  });
  if (!ladderResult.ok) {
    await hold(
      deps, job.quantJobId,
      ladderResult.code === "below-minimum" ? "below-minimum" : "arm-uneconomic",
    );
    return { ok: false, note: ladderResult.code };
  }
  const ladder = ladderResult.ladder;

  /* The arm floor, on THIS pool, with a measured impact. */
  const impactBps = await measureImpactBps(deps, ladder.clipUWei, observation.blockNumber);
  const floor = armFloor({
    clipUWei: ladder.clipUWei,
    midE18: observation.midE18,
    impactBps,
    params: deps.params,
  });
  if (!floor.economic) {
    // Re-evaluated EVERY cycle until `endsAt` — pool depth moves, so this hold
    // is not permanent and does not close the job.
    await hold(deps, job.quantJobId, "arm-uneconomic");
    return { ok: false, note: `arm-uneconomic:${floor.requiredBps}` };
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
    },
    ladder: {
      levels: ladder.levels,
      clipUWei: ladder.clipUWei,
      buyPrice: ladder.buyPrice,
      sellPrice: ladder.sellPrice,
      midE18: observation.midE18,
    },
    params: deps.params,
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
    deps.reader.tokenBalanceAt(deps.venue.u, getAddress(job.tradingWallet), observation.blockNumber),
    deps.reader.tokenBalanceAt(deps.venue.wbnb, getAddress(job.tradingWallet), observation.blockNumber),
    deps.reader.nativeBalanceAt(getAddress(job.tradingWallet), observation.blockNumber),
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
      ...deps.params,
      minClipUWei: deps.params.minClipUWei.toString(10),
      relayFeePerSubmitWei: deps.params.relayFeePerSubmitWei.toString(10),
    }),
    paramsDigest: deps.paramsDigest,
    p0E18: ladder.p0E18,
    armBlock: observation.blockNumber,
    levels: Array.from({ length: ladder.levels }, (_unused, index) => ({
      levelIndex: index + 1,
      buyPriceE18: ladder.buyPrice[index + 1] ?? 0n,
      sellPriceE18: ladder.sellPrice[index + 1] ?? 0n,
    })),
    clipUWei: ladder.clipUWei,
    idleUWei: ladder.idleUWei,
    baselineUWei: baselineU,
    baselineWbnbWei: baselineWbnb,
    baselineNativeWei: baselineNative,
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
): Promise<bigint> {
  const path = directPath(deps.venue.u, deps.venue.wbnb);
  const probe = clipUWei / 100n;
  if (probe <= 0n) return 0n;
  const [full, small] = await Promise.all([
    deps.reader.quoteV2At(deps.venue.router, path, clipUWei, blockNumber),
    deps.reader.quoteV2At(deps.venue.router, path, probe, blockNumber),
  ]);
  return quantPriceImpactBps(full, small);
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

type PlanResult =
  | { readonly kind: "idle" }
  | { readonly kind: "hold"; readonly code: string }
  | {
      readonly kind: "act";
      readonly action: QuantActionRow;
      readonly calls: readonly { readonly to: Address; readonly value?: bigint; readonly data?: Hex }[];
      readonly requiredNativeWei: bigint;
      readonly tokenIn: Address;
    };

async function planOneAction(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  observation: QuantObservation,
): Promise<PlanResult> {
  // SELLS BEFORE BUYS — the PHASE3.15 semantic kept verbatim. Exits reduce
  // exposure, so they never wait behind an entry.
  const ordered = [...levels].sort((a, b) => {
    const sellFirst = (level: QuantLevelRow): number =>
      level.state === "holding-base" ? 0 : 1;
    return sellFirst(a) - sellFirst(b) || a.levelIndex - b.levelIndex;
  });
  // R5.5 / audit A1: the native reservation charges every OTHER level for what
  // its own non-terminal ACTION owes, so the open actions are read ONCE here,
  // after phase 0 has already driven every one of them to the truth.
  const pending = await deps.store.listNonTerminalActions(job.quantJobId);
  let lastHold: string | null = null;
  for (const level of ordered) {
    const outcome = await planLevel(deps, job, levels, pending, level, observation);
    if (outcome.kind === "act") return outcome;
    if (outcome.kind === "hold") lastHold = outcome.code;
  }
  return lastHold === null ? { kind: "idle" } : { kind: "hold", code: lastHold };
}

async function planLevel(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  pending: readonly QuantActionRow[],
  level: QuantLevelRow,
  observation: QuantObservation,
): Promise<PlanResult> {
  if (level.state === "retired" || level.state === "blocked") return { kind: "idle" };
  const nowMs = deps.nowMs();
  const side = levelTriggerSide({
    midE18: observation.midE18,
    buyPriceE18: level.buyPriceE18,
    sellPriceE18: level.sellPriceE18,
    holdingBase: level.state === "holding-base",
  });
  const evidence = advanceTrigger(
    { consecutive: level.triggerConsecutive, side: level.triggerSide },
    side,
  );
  await deps.store.withQuantFence(job.quantJobId, async (fence) => {
    await fence.setLevelTrigger({
      quantJobId: job.quantJobId,
      levelIndex: level.levelIndex,
      consecutive: evidence.consecutive,
      side: evidence.side,
    });
  });
  if (!triggerArmed(evidence)) return { kind: "idle" };

  // Cooldown is measured from the action's `created_at`, per level, and is a
  // HOLD: it never advances state.
  if (level.lastActionAtMs !== null
    && nowMs - level.lastActionAtMs < deps.params.cooldownSec * 1_000) {
    return { kind: "hold", code: "cooldown" };
  }

  const wallet = getAddress(job.tradingWallet);
  const latest = await deps.reader.latestBlockNumber();
  const actionSeq = level.actionSeq + 1;
  const deadlineSec = actionDeadlineSec(Math.floor(nowMs / 1_000), level.levelIndex);

  if (evidence.side === "buy") {
    return planBuy(deps, job, levels, pending, level, observation, {
      actionSeq, deadlineSec, latest, wallet, nowMs,
    });
  }
  return planSell(deps, job, level, observation, {
    actionSeq, deadlineSec, latest, wallet, nowMs,
  });
}

type PlanContext = {
  readonly actionSeq: number;
  readonly deadlineSec: number;
  readonly latest: bigint;
  readonly wallet: Address;
  readonly nowMs: number;
};

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
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  levels: readonly QuantLevelRow[],
  pending: readonly QuantActionRow[],
  level: QuantLevelRow,
  observation: QuantObservation,
  ctx: PlanContext,
): Promise<PlanResult> {
  const minOutWei = buyMinOut({
    clipUWei: job.clipUWei,
    buyPriceE18: level.buyPriceE18,
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
    params: deps.params,
  });
  let nativeBalance: bigint;
  try {
    nativeBalance = await deps.reader.nativeBalanceAt(ctx.wallet);
  } catch {
    return { kind: "hold", code: "meter-unreadable" };
  }
  if (nativeBalance < required) return { kind: "hold", code: "no-gas" };

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
    nowMs: ctx.nowMs,
  });
  if (inserted === null) return { kind: "hold", code: "store-conflict" };
  return {
    kind: "act", action: inserted, calls,
    requiredNativeWei: required, tokenIn: deps.venue.u,
  };
}

async function planSell(
  deps: QuantWorkerDeps,
  job: QuantJobRow,
  level: QuantLevelRow,
  observation: QuantObservation,
  ctx: PlanContext,
): Promise<PlanResult> {
  // R7.2: the chunk comes from the PARTITION of the ACTUAL inventory, and each
  // chunk waits for capacity for the WHOLE chunk on every cap row.
  const chunks = job.wbnbCapMinLimitWei > 0n
    ? partitionExit(level.baseWei, job.wbnbCapMinLimitWei)
    : [level.baseWei];
  const amountWei = chunks[0] ?? 0n;
  if (amountWei <= 0n) return { kind: "idle" };

  const floor = sellFloor({
    amountWei,
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
    params: deps.params,
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
    params: deps.params,
  });
  let nativeBalance: bigint;
  try {
    nativeBalance = await deps.reader.nativeBalanceAt(ctx.wallet);
  } catch {
    return { kind: "hold", code: "meter-unreadable" };
  }
  if (nativeBalance < required) return { kind: "hold", code: "no-gas" };

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
    nowMs: ctx.nowMs,
  });
  if (inserted === null) return { kind: "hold", code: "store-conflict" };
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
    if (nowMs - action.updatedAtMs < DAY_MS) reserved += action.fillInWei;
  }
  const levels = await deps.store.listLevels(job.quantJobId);
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
  deps: QuantWorkerDeps,
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
    readonly nowMs: number;
  },
): Promise<QuantActionRow | null> {
  const [preU, preWbnb, preNative] = await Promise.all([
    deps.reader.tokenBalanceAt(deps.venue.u, input.wallet).catch(() => 0n),
    deps.reader.tokenBalanceAt(deps.venue.wbnb, input.wallet).catch(() => 0n),
    deps.reader.nativeBalanceAt(input.wallet).catch(() => 0n),
  ]);
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
    feeEstUWei: feeEstInU(deps.params, input.observation.midE18).toString(10),
    bandBps: deps.params.bandBps,
  }).slice(0, 2_000);
  const result = await deps.store.withQuantFence(job.quantJobId, async (fence: QuantFence) => {
    // RE-READ inside the fence. The trigger latch was written earlier in this
    // cycle, which bumped the level's `row_version`, so the row this decision
    // started from is already stale — and an intent CAS'd against a stale
    // version would silently never insert. The fence is what makes the re-read
    // and the insert one transaction.
    const current = (await fence.listLevels(job.quantJobId))
      .find((row) => row.levelIndex === level.levelIndex);
    if (current === undefined) return { kind: "conflict" as const, record: null };
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
      basisUWei: input.basisUWei,
      baseAtCycleStartWei: input.baseAtCycleStartWei,
      nowMs: input.nowMs,
    });
  });
  return result.kind === "ok" ? result.record : null;
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
    await deps.store.setJobStatus({
      quantJobId: job.quantJobId, status: "ended-unresolved", nowMs,
    });
    notes.push(`${job.quantJobId}:ended-unresolved`);
    return { actions: 0, holds: 0, notes };
  }
  if (job.status === "reported" || dryRun) {
    return { actions: 0, holds: 0, notes };
  }
  // Max 24 attempts with the store's own attempt counter as the backoff.
  if (job.reportAttempts >= 24) {
    notes.push(`${job.quantJobId}:report-exhausted`);
    return { actions: 0, holds: 0, notes };
  }
  const actions = await deps.store.listActions(job.quantJobId);
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
  await deps.store.setJobStatus({
    quantJobId: job.quantJobId,
    status: response.ok ? "reported" : "ended",
    nowMs,
  });
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

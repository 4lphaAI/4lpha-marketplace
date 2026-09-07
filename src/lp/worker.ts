import { resolveLpAtomicRotate } from "./wiring.js";
/**
 * The LP worker loop (PHASE3-SPEC body "Worker"; Revision 2 items 11, 16, 26,
 * 28, 32; PHASE3-REVIEW R4 item 4, OQ3/OQ4).
 *
 * ONE cycle ({@link runLpWorkerOnce}), per opted-in agent position, in the
 * spec's order:
 *
 *   journal reconcile → resume any non-terminal sequence → else read market
 *   evidence (finalized) → evaluate the deterministic triggers with the
 *   LINEAGE basis and the stored owner settings (digest RE-VERIFIED) →
 *   dispatch AT MOST ONE saga per position per cycle, priority
 *   protect > rotate > harvest.
 *
 * ─── WHAT THE WORKER REFUSES vs WHAT THE SAGAS REFUSE ──────────────────────
 *
 * The saga layer already gates every step (kill switch with the FINDINGS (s)
 * carve-out, settings digest, rails, quota). The worker ADDS three refusals of
 * its own, each for a stated reason:
 *
 *   - it PRE-authorizes NEW sequences (`authorizeExecute`, exposure class per
 *     saga kind) so a paused agent gets no new rotate/harvest work while a
 *     protect STILL dispatches (Rev2 item 16) — and so a halted process does
 *     not mint reservation rows every cycle for sequences that would only roll
 *     back (protect reservations count against the rotate/harvest window, so
 *     that pollution would starve the quota-bound kinds);
 *   - a stored settings row whose digest does not recompute
 *     (`paramsHash("lpSettings", params)`) SKIPS the position with a logged
 *     reason — automation must never run under settings nobody provably
 *     signed;
 *   - a position it cannot value (burned token, unreadable pool) is SKIPPED
 *     with the reason logged, never guessed at.
 *
 * RESUMES are dispatched unconditionally — the saga's own between-step gates
 * decide what an in-flight sequence may still do under pause/halt, and its
 * reservation is already written (idempotent), so there is nothing for the
 * worker's pre-check to protect. One deliberate exception, stated: a
 * non-terminal `open` sequence is resumed through `runLpOpen` with a sentinel
 * input (the persisted basis as the budget, an empty tick pair), because the
 * owner-signed range is deliberately not persisted. Every disposition is
 * safe: committed-step opens FINISH from the receipt (the input is unread),
 * ambiguous opens HOLD, and a fresh re-drive is REFUSED by construction and
 * rolls the never-funded lineage back closed — the same terminal state the
 * route's own rollback produces.
 *
 * ─── THE BRAIN SEAM IS STRUCTURAL HERE TOO (Rev2 items 26/28) ──────────────
 *
 * `LpWorkerDeps.brainTransport` is the data-plane transport
 * (`src/lp/brain.ts`), and the worker hands it ONLY to rotate dispatches, as
 * the one-line `proposeRange` closure on {@link LpRotateDeps}, and only when
 * the owner's settings enable the brain and signed a model block. The
 * protect/harvest paths are built as plain {@link LpSagaDeps}, which cannot
 * carry a brain by type. A test drives a protect+rotate-both-eligible cycle
 * and asserts zero transport calls.
 *
 * ─── DRY RUN ────────────────────────────────────────────────────────────────
 *
 * `dryRun: true` logs the FULL decision — trigger reason, hold reason, the
 * saga's would-be step plan — and executes NOTHING: no reconcile, no sequence
 * or reservation rows, no journal writes, NO DURABLE OBSERVATION ROW, and ZERO
 * WalletProvider calls (all asserted by test). Chain READS still happen (they
 * are the decision).
 *
 * The observation state still advances WITHIN a dry run — through a
 * PROCESS-LOCAL OVERLAY ({@link LpWorkerState}), never the durable store
 * (PHASE3.2 Rev2 items 7/8). A dry cycle followed by a dry cycle still behaves
 * as two consecutive observations, which is what they are; but a dry run
 * followed by a LIVE run must not, because that would arm a protect having
 * looked at the live market exactly ONCE — the precise hazard the staleness
 * bound exists to prevent, reached through the rehearsal switch. Under a LIVE
 * cycle the overlay is not consulted at all: it is not a write-through cache,
 * because a cache is a second copy of the fact this phase exists to
 * single-source.
 *
 * ─── THE CYCLE CLOCK IS FROZEN (PHASE3.2 Rev2 item 2, FINDINGS (af)) ────────
 *
 * `runLpWorkerOnce` stamps `cycleNowMs = deps.now()` as its FIRST statement and
 * uses it for the evaluator's `nowMs` (hence the observation's
 * `evaluatedAtMs`) and for `report.startedAtMs`. Before this, `nowMs` was read
 * mid-cycle, AFTER `poolState`, `positions`, `positionFees` and up to two
 * QuoterV2 quotes — so the stamp-to-stamp gap was `cadence + (wₙ₊₁ − wₙ)` and
 * went NEGATIVE whenever a cycle's pre-evaluation reads were faster than its
 * predecessor's. That is what produced 59 970 ms against a 60 000 ms interval
 * on mainnet and cost every protect a third cycle. Every OTHER `deps.now()`
 * stays LIVE — `authorizeExecute`'s expiry, saga deadlines, quota windows —
 * because a whole-cycle frozen clock would compute swap deadlines in the past
 * on a slow cycle.
 *
 * ─── WHERE THE OBSERVATION IS WRITTEN, AND WHY THERE ───────────────────────
 *
 * BELOW the dispatch, never above it (Rev2 item 9). A durable write sitting
 * between a confirmed trigger and its dispatch would let a Postgres blip throw,
 * `evaluatePosition` error, and a CONFIRMED stop-loss be held with a
 * plausible-looking log line — (ae)'s own signature, DB-backed. So: no store
 * this phase adds may ever sit between a confirmed trigger and its dispatch,
 * a read failure / missing row / structurally invalid row all mean "NO previous
 * observation" (one extra confirmation cycle, never a position skip), and a
 * write failure is reported as `observationPersisted: false` and never aborts
 * the position.
 *
 * ─── VALUATION (spec body: "quoted into WBNB via QuoterV2") ────────────────
 *
 * The trigger's `exitValueWei` / `freshFeesValueWei` are built from: the
 * principal at the FINALIZED spot price (`getAmountsForLiquidity`, pure), the
 * exact collectible fees (a `collect(max,max)` simulation), and the TOKEN leg
 * quoted into WBNB through QuoterV2 — so TP/SL sees a sellable value, impact
 * included, not a mid-price mark. The WBNB leg is face value.
 */
import { repairLpFeeEvents } from "./feeRepair.js";
import { parseLpFeesTelemetry } from "./feeTelemetry.js";

import type { Address, Hex } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import type { WalletProvider } from "../core/types.js";
import { authorizeExecute } from "../auth/executeDecision.js";
import { paramsHash } from "../auth/canonical.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { LpSettingsStore } from "../store/lpSettings.js";
import type {
  LpPositionRecord,
  LpRecenterEvidence,
  LpSequenceKind,
  LpSequenceRecord,
  LpSequenceStore,
  LpStepKind,
} from "../store/lpSequences.js";
import {
  defaultLpSettingsParams,
  parseLpSettingsParams,
} from "../http/lpWire.js";
import {
  resolveGridEnabled,
  resolveLpEnabled,
  resolveLpRuntimeConfig,
  type LpRuntimeConfig,
  type TradeEnv,
} from "../ops/config.js";
import {
  resolveLpRailConfig,
  type LpRailConfig,
} from "./rails.js";
import {
  evaluateLpTriggers,
  lpMaxObservationAgeMs,
  lpProtectionStatus,
  lpSettingsUnreadableReason,
  DEFAULT_LP_SETTINGS,
  LP_DIGEST_UNVERIFIED_REASON,
  LP_NO_TOKEN_ID_REASON,
  type LpAutomationSettings,
  type LpBrainSettings,
  gridModeOf,
  ladderMotionCounts,
  type LpManagementDecision,
  type LpProtectionStatus,
  type LpTriggerObservation,
  type LpTriggerReason,
} from "./triggers.js";
import type { LpObservationStore } from "../store/lpObservations.js";
import {
  runLpGridFlip,
  runLpGridRecenter,
  runLpGridShift,
  runLpGridRequote,
  runLpHarvest,
  runLpManualExit,
  runLpProtect,
  runLpRotate,
  type LpGridFlipDeps,
  type LpGridRecenterDeps,
  type LpGridShiftDeps,
  type LpGridRequoteDeps,
  type LpRangeProposalContext,
  type LpRotateDeps,
  type LpSagaDeps,
  type LpSagaRunResult,
  type LpSagaVenue,
} from "./sagas.js";
import {
  evaluateGridTriggers,
  gridRangeList,
  gridRoleAtFor,
  gridShiftEconomics,
  gridShiftDriftMotionsPerDay,
  gridShiftGroupLock,
  gridTargetRange,
  LP_GRID_IDENTITY_MISSING_REASON,
  type LpGridRole,
} from "./gridTriggers.js";
import type { SwaplessRotationSide } from "./fence.js";
import type { LpGridCycleStore } from "../store/gridCycles.js";
import { runLpOpen } from "./open.js";
import { valueLpPosition } from "./valuation.js";
import type { LpWorkerChainReaders } from "./readers.js";

/* -------------------------------------------------------------------------- */
/* Boot config (rails resolved ONCE; missing ⇒ the worker refuses to start)   */
/* -------------------------------------------------------------------------- */

export const LP_WORKER_MIN_INTERVAL_MS = 30_000;
export const LP_WORKER_MAX_INTERVAL_MS = 600_000;
export const LP_WORKER_DEFAULT_INTERVAL_MS = 60_000;

/* ----- the stall latch (PHASE3.11 F1) ------------------------------------- */

/**
 * How many CONSECUTIVE resumes that end at the same plan position with the
 * same refusal mark a `held` sequence as STALLED.
 */
export const LP_STALL_LATCH_ATTEMPTS = 3;

/**
 * How many worker intervals a stalled sequence is left alone before it is
 * resumed again.
 *
 * WHY A BACKOFF AND NOT A STOP. A stalled sequence is `held` with a named
 * recovery, so it is back in the worker queue, and each cycle claims it
 * `held -> active` and re-holds it. Both writes refresh `updated_at`, so the
 * maximum idleness an owner can ever observe is less than one interval — and
 * {@link LpSequenceStore.claimSequenceForAbandon} demands one full interval of
 * it. The owner's abandon can therefore NEVER be claimed while the worker
 * runs, and "stop the LP worker" is not an answer a multi-tenant marketplace
 * can give one owner. Backing off leaves `updated_at` quiescent for the gap,
 * which is what makes the claim satisfiable.
 *
 * It must stay a BACKOFF: a refusal can heal with no help from the owner — the
 * price returns into range, `reconcile` settles the row — and a permanent stop
 * would strand a position that would otherwise have finished by itself. Must
 * be > 1 so the gap actually exceeds the claim's `minIdleMs`.
 */
export const LP_STALL_BACKOFF_INTERVALS = 4;

/**
 * The latch's identity for one parked resume: WHAT refused and WHERE. Any
 * progress — a different refusal, a further plan position — changes it, and a
 * changed code restarts the count at 1 in the store.
 */
export function lpResumeStallCode(result: LpSagaRunResult): string {
  return `${result.code}@${result.confirmedSteps}`;
}

/**
 * Should this cycle leave a stalled sequence alone? Pure, so the arithmetic
 * the owner's abandon depends on is testable without a worker.
 */
export function shouldDeferStalledResume(
  sequence: LpSequenceRecord,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (sequence.state !== "held") return false;
  if (sequence.stallCount < LP_STALL_LATCH_ATTEMPTS) return false;
  return nowMs - sequence.updatedAt < intervalMs * LP_STALL_BACKOFF_INTERVALS;
}

/** Clamp, never refuse: the spec fixes the band, the operator picks within it. */
export function clampLpWorkerIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return LP_WORKER_DEFAULT_INTERVAL_MS;
  if (ms < LP_WORKER_MIN_INTERVAL_MS) return LP_WORKER_MIN_INTERVAL_MS;
  if (ms > LP_WORKER_MAX_INTERVAL_MS) return LP_WORKER_MAX_INTERVAL_MS;
  return Math.floor(ms);
}

export type LpWorkerBootConfig = {
  readonly atomicRotate: boolean;
  readonly rails: LpRailConfig;
  readonly runtime: LpRuntimeConfig;
  readonly intervalMs: number;
  /**
   * PHASE3.15 — `GRID_ENABLED`, resolved at the SAME boot that already refuses
   * to start without `LP_ENABLED`. That existing throw is what covers the L3
   * pair on the worker side; `resolveGridEnabled` carries the same check for
   * every other composition site.
   */
  readonly gridEnabled: boolean;
  /**
   * The operator's LOWER-ONLY staleness override (`LP_MAX_OBSERVATION_AGE_MS`,
   * PHASE3.2 Rev2 item 22). Absent ⇒ the derived bound.
   */
  readonly maxObservationAgeMs?: number;
};

/**
 * `LP_WORKER_INTERVAL_SEC`, clamped into the spec's band. ONE definition,
 * because the HTTP read side must report the SAME cadence the worker runs on:
 * `confirmationEligibleAtMs` is meaningless if the two disagree.
 */
export function resolveLpWorkerIntervalMs(env: TradeEnv): number {
  const raw = env["LP_WORKER_INTERVAL_SEC"]?.trim() ?? "";
  if (raw === "") return LP_WORKER_DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("LP_WORKER_INTERVAL_SEC must be a positive integer number of seconds.");
  }
  return clampLpWorkerIntervalMs(parsed * 1000);
}

/**
 * `LP_MAX_OBSERVATION_AGE_MS`, validated at BOOT and LOWER-ONLY.
 *
 * The asymmetry is the safety direction: RAISING the bound weakens the
 * anti-wick rule (a stale observation would count as the first of two);
 * LOWERING it costs at most one extra confirmation cycle. So a value above the
 * derived bound is REFUSED rather than clamped — the same
 * raise-only/lower-only idiom as `--expected-sequences-day`, inverted.
 * Malformed ⇒ the worker refuses to start; this never fails a request.
 */
export function resolveLpMaxObservationAgeMs(
  env: TradeEnv,
  intervalMs: number,
): number | undefined {
  const raw = env["LP_MAX_OBSERVATION_AGE_MS"]?.trim() ?? "";
  if (raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "LP_MAX_OBSERVATION_AGE_MS must be a positive integer number of milliseconds.",
    );
  }
  const derived = lpMaxObservationAgeMs(intervalMs);
  if (parsed > derived) {
    throw new Error(
      `LP_MAX_OBSERVATION_AGE_MS (${parsed}) exceeds the derived bound for this interval ` +
        `(${derived}); the override is LOWER-ONLY because raising it weakens the ` +
        `two-consecutive-observations rule that stops a price wick from closing a position.`,
    );
  }
  return parsed;
}

/**
 * Resolve everything the worker daemon needs at BOOT, throwing on anything
 * unusable — the spec's posture verbatim: "rails config resolved once at
 * boot; missing ⇒ the worker refuses to start, not a silent hold". The
 * routes' per-request hold semantics are for a server that has other work; a
 * worker whose only job is held forever is an outage pretending to run.
 */
export function resolveLpWorkerBootConfig(env: TradeEnv): LpWorkerBootConfig {
  if (!resolveLpEnabled(env)) {
    throw new Error(
      "LP_ENABLED is not \"true\"; the LP worker refuses to start on a deployment that has not enabled LP.",
    );
  }
  const railsResult = resolveLpRailConfig(env);
  if (!railsResult.ok) {
    throw new Error(
      `LP worker refusing to start: ${railsResult.failure.reason} ` +
        `(a worker holding on unconfigured rails forever would be a silent outage).`,
    );
  }
  const runtime = resolveLpRuntimeConfig(env);
  const intervalMs = resolveLpWorkerIntervalMs(env);
  const maxObservationAgeMs = resolveLpMaxObservationAgeMs(env, intervalMs);
  return {
    rails: railsResult.config,
    runtime,
    intervalMs,
    gridEnabled: resolveGridEnabled(env),
    atomicRotate: resolveLpAtomicRotate(env),
    ...(maxObservationAgeMs === undefined ? {} : { maxObservationAgeMs }),
  };
}

/* -------------------------------------------------------------------------- */
/* The cadence (PHASE3.2 Rev2 items 3/5)                                      */
/* -------------------------------------------------------------------------- */

/**
 * How long to wait before the NEXT cycle may start, anchored on the PREVIOUS
 * cycle's START.
 *
 * Anchoring on the start (not on the cycle's end) is what makes consecutive
 * cycle starts always `>= intervalMs` apart, which is exactly the comparison
 * the evaluator makes. A cycle that OVERRUNS the interval returns 0 and the
 * next cycle starts immediately — no drift catch-up and no burst, because the
 * schedule anchors on the previous START rather than on a fixed epoch grid.
 * **Never convert this to an epoch grid**: that is what would produce a burst.
 */
export function nextCycleDelayMs(
  cycleStartedAtMs: number,
  nowMs: number,
  intervalMs: number,
): number {
  return Math.max(0, cycleStartedAtMs + intervalMs - nowMs);
}

/**
 * Sleep until `cycleStartedAtMs + intervalMs`, RE-CHECKING the clock.
 *
 * `setTimeout` is not contractually late-only, and a 1 ms early fire would
 * reproduce (af) at 1 ms — the evaluator's `>= intervalMs` would fail and the
 * protect would wait a third cycle. The loop makes the cadence a guarantee
 * rather than an approximation. `sleep` is injected so this is offline-testable
 * with a clock that can fire early.
 */
export async function sleepUntilNextCycle(input: {
  readonly cycleStartedAtMs: number;
  readonly intervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Abort the wait early (SIGINT). Checked between re-checks. */
  readonly stopped?: () => boolean;
}): Promise<void> {
  for (;;) {
    if (input.stopped?.() === true) return;
    const remaining = nextCycleDelayMs(
      input.cycleStartedAtMs,
      input.now(),
      input.intervalMs,
    );
    if (remaining <= 0) return;
    await input.sleep(remaining);
  }
}

/* -------------------------------------------------------------------------- */
/* Deps, state, report                                                        */
/* -------------------------------------------------------------------------- */

export type LpWorkerDeps = {
  readonly atomicRotate?: boolean;
  readonly feeWorkerFence?: import("../deployment/workerSingleton.js").WorkerFence;
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly killswitch: KillSwitch;
  readonly store: LpSequenceStore;
  readonly settingsStore: LpSettingsStore;
  /**
   * The DURABLE trigger observation store (PHASE3.2). REQUIRED, never
   * optional-with-a-default: a forgotten wiring must be a compile error, not a
   * silently unarmed agent — which is this phase's own defect wearing its
   * version number.
   */
  readonly observations: LpObservationStore;
  readonly provider: WalletProvider;
  readonly readers: LpWorkerChainReaders;
  readonly rails: LpRailConfig;
  /** Fence ceiling for rotate ranges (`LP_MAX_TICK_WIDTH`). */
  readonly maxTickWidth: number;
  /** PHASE3.24 R3.6 — boot-default-empty atomic conversion allowlist. */
  readonly conversionCompatibleTokens: ReadonlySet<Address>;
  /**
   * `LP_RELAY_FEE_PER_SUBMIT_WEI`, resolved at boot — the exit swap's DUST
   * FLOOR (PHASE3.1 Rev2 item 17). REQUIRED, never optional-with-a-default,
   * for the same reason `observations` is: a forgotten wiring must be a
   * compile error rather than a silently over-skipping exit.
   */
  readonly relayFeePerSubmitWei: bigint;
  readonly venue: LpSagaVenue;
  /**
   * PHASE3.15 — `GRID_ENABLED`, resolved at BOOT and carried here.
   *
   * ABSENT OR FALSE MEANS OFF, and off is not "manage it the standard way": an
   * agent whose stored settings carry a `grid` block under an off flag is
   * SKIPPED with a logged reason, because a standard rotate would re-range the
   * grid level and destroy the strategy. A non-terminal `grid-flip` is skipped
   * too rather than resumed — running a money saga under a flag the operator
   * turned off is the wrong posture, and the owner-signed abandon door stays
   * open either way.
   */
  readonly gridEnabled?: boolean;
  /**
   * PHASE3.15 — the derived cycle ledger. Optional: a flip with no ledger
   * wired still flips, and nothing here is ever consulted to decide whether a
   * step ran.
   */
  readonly feeEvents?: import("../store/lpFeeEvents.js").LpFeeEventStore;
  readonly gridCycles?: LpGridCycleStore;
  /**
   * The worker-only LP brain transport. Handed exclusively to rotate deps, and
   * only for owners whose settings enable the brain and signed a model block.
   * Absent ⇒ deterministic-only.
   */
  readonly brainTransport?: (
    kind: "range",
    context: Record<string, unknown>,
    brain: LpBrainSettings,
    signal?: AbortSignal,
  ) => Promise<unknown | null>;
  /**
   * Startup-style journal reconcile, injected so the worker stays offline-
   * testable. Called once per LIVE cycle before any resume; skipped entirely
   * under dry-run (it resolves rows through the provider).
   */
  readonly reconcile?: () => Promise<unknown>;
  /** Injected clock, epoch MILLISECONDS. */
  readonly now: () => number;
  /** The cycle interval — also the trigger evaluator's `intervalMs`. */
  readonly intervalMs: number;
  /** `LP_MAX_OBSERVATION_AGE_MS`, lower-only, resolved at boot. */
  readonly maxObservationAgeMs?: number;
  readonly deadlineSec?: number;
  readonly dryRun: boolean;
  /** Sink for per-position outcomes. Defaults to nothing (the report carries all). */
  readonly log?: (outcome: LpWorkerPositionOutcome) => void;
};

/**
 * The DRY-RUN observation overlay, and nothing else (PHASE3.2 Rev2 item 30).
 *
 * Observations used to live here for real, and the comment that stood in this
 * place claimed a restart "only DELAYS a trigger by one confirmation cycle —
 * the fail-safe direction". That was FALSE, and FINDINGS (ae) is what it cost:
 * `--once` never filled this map at all, so a breached stop-loss was detected
 * on every invocation and could never be confirmed — not slow, IMPOSSIBLE. The
 * claim becomes true for the first time under this phase, and only WITHIN
 * {@link lpMaxObservationAgeMs}: a worker that CRASH-LOOPS with a restart gap
 * longer than that bound discards on every restart and the protect still never
 * fires, which is why {@link lpProtectionStatus} reports it rather than only
 * logging it.
 *
 * What remains here is consulted ONLY when `deps.dryRun` is true. It keeps its
 * constructor's name and signature so no call site churns.
 */
export type LpWorkerState = {
  readonly dryRunObservations: Map<string, LpTriggerObservation>;
};

export function createLpWorkerState(): LpWorkerState {
  return { dryRunObservations: new Map() };
}

export type LpWorkerAction =
  | "resumed"
  | "dispatched"
  | "hold"
  | "skipped"
  | "dry-run"
  | "error";

export type LpWorkerPositionOutcome = {
  readonly agentId: string;
  readonly positionId: string;
  readonly action: LpWorkerAction;
  /** Sanitized. Callers branch on `action`/`decision`, never on this text. */
  readonly reason: string;
  readonly kind?: LpSequenceKind;
  readonly decision?: LpManagementDecision;
  readonly triggerReason?: LpTriggerReason;
  /** Dry-run only: the saga plan the decision WOULD have driven. */
  readonly plannedSteps?: readonly LpStepKind[];
  readonly result?: LpSagaRunResult;
  /**
   * Whether the durable observation write succeeded. `false` is a LOGGED
   * degradation, never a refusal: the position was already dispatched or held
   * on its merits, and the cost of the lost row is one extra confirmation
   * cycle. Absent on paths that write nothing (dry-run, resumes).
   */
  readonly observationPersisted?: boolean;
  /**
   * "Is protection actually armed", from the ONE definition
   * ({@link lpProtectionStatus}) the HTTP read side also calls. Present
   * wherever the worker knows enough to answer — including the settings-digest
   * and no-tokenId SKIPS, which are silent today.
   */
  readonly protection?: LpProtectionStatus;
};

export type LpWorkerCycleReport = {
  readonly startedAtMs: number;
  readonly dryRun: boolean;
  /** Whether the injected reconcile ran this cycle. */
  readonly reconciled: boolean;
  readonly outcomes: readonly LpWorkerPositionOutcome[];
};

/**
 * Which saga kind a decision dispatches.
 *
 * PHASE3.16 R2.9 (review L4): `grid-arm` is deliberately NOT a member and
 * {@link LP_SAGA_PLANS} needs no entry for it. This type is keyed by what the
 * TRIGGER EVALUATOR can decide, and an arm is never a worker dispatch — it is
 * an owner-signed route that the worker only ever RESUMES. Stated here so
 * nobody widens the type for nothing.
 */
type LpDispatchKind =
  | "protect"
  | "rotate"
  | "harvest"
  | "grid-flip"
  | "grid-requote"
  | "grid-recenter"
  // PHASE3.22 — the atomic ladder's motion. It IS a worker dispatch (unlike
  // `grid-arm`, which is owner-signed and only ever resumed), so it is a member
  // here and it does need a plan entry below.
  | "grid-shift";

/** The saga plan each decision drives — logged verbatim under dry-run. */
export const LP_SAGA_PLANS: Readonly<
  Record<LpDispatchKind, readonly LpStepKind[]>
> = {
  // PHASE3.1 Rev2 item 22: the exit is TWO plan positions from 3.1 on. Dry-run
  // reporting only — but a dry run that under-reports the plan is exactly the
  // quiet drift this constant exists to prevent.
  protect: ["zap-out", "sweep-token"],
  rotate: ["zap-out", "sweep-token", "zap-in-mint"],
  harvest: ["collect-fees", "sweep-token", "zap-in-increase"],
  // PHASE3.15: the same three positions as a rotate, and the middle one ALWAYS
  // skips. Reported in full because a dry run that showed two would under-state
  // the plan a resume walks.
  "grid-flip": ["zap-out", "sweep-token", "zap-in-mint"],
  // PHASE3.18: flip-SHAPED by design — same three positions, same always-skipped
  // middle — which is what lets the 3.11 crash matrix, the `pending-mint` hold
  // semantics and the abandon disposition carry over with no new machinery.
  "grid-requote": ["zap-out", "sweep-token", "zap-in-mint"],
  // PHASE3.19: flip-SHAPED for the identical reason — same three positions, same
  // step kinds — which is what lets the 3.11 crash matrix, the `pending-mint`
  // hold semantics, the abandon disposition and the stall latch carry over with
  // no new machinery. Its MIDDLE step is the one difference and it is a
  // behaviour, not a kind: the hedge can FIRE where the other two lanes' sweeps
  // always skip, which is why its native reserve uses
  // `MAX_SUBMISSIONS_PER_GRID_RECENTER` (4) rather than the flip's 3.
  "grid-recenter": ["zap-out", "sweep-token", "zap-in-mint"],
  // PHASE3.22 R2.6 / PHASE3.23 R2.10 — THE ONE PLAN THAT IS NOT FLIP-SHAPED.
  // One step and one submission: twelve calls for two targets, seven for one;
  // every targeted rung is zapped out and re-minted atomically. It inherits none of the flip's machinery
  // because it needs none of it — there is no second submission to owe, so no
  // `pending-mint` hold, no half-moved ladder and no per-rung stranding.
  //
  // What it pays for that is enumerated at `LpStepKind`'s own `"grid-shift"`
  // member: an explicit entry at every kind-keyed surface, because a step that
  // both REMOVES and ADDS liquidity is one no existing table answers correctly.
  "grid-shift": ["grid-shift"],
};

/**
 * PHASE3.15 (R2.6 / H7) — the decision → saga-kind map, as an EXHAUSTIVE
 * switch.
 *
 * IT WAS A TERNARY WITH A CATCH-ALL `protect` DEFAULT, and that is the single
 * highest-consequence line in this phase: TypeScript cannot make a ternary
 * exhaustive, so a decision member added to `LpManagementDecision` without an
 * arm here dispatched `runLpProtect` — a full EXIT of the position, silently,
 * with no compile error. A grid agent would have had its level liquidated the
 * first time a flip fired.
 *
 * The `never` binding is the fix: a future member fails `tsc` here rather than
 * routing to the exit path. `hold` cannot reach this function (the caller
 * returns above it), so it is refused explicitly rather than folded into a
 * default.
 */
export function lpDispatchKindFor(decision: LpManagementDecision): LpDispatchKind {
  switch (decision) {
    case "rotate":
      return "rotate";
    case "harvest":
      return "harvest";
    case "grid-flip":
      return "grid-flip";
    case "grid-requote":
      return "grid-requote";
    case "grid-recenter":
      return "grid-recenter";
    // PHASE3.22 — the atomic ladder's one decision. Both triggers (fill cross
    // and drift) produce THIS decision, because in shift mode they are the same
    // motion; there is no second member to route.
    case "grid-shift":
      return "grid-shift";
    case "protect-stop-loss":
    case "protect-take-profit":
    case "protect-price-stop-loss":
    case "protect-price-take-profit":
      return "protect";
    case "hold":
      throw new Error("lpDispatchKindFor: a hold dispatches no saga.");
    default: {
      const unreachable: never = decision;
      throw new Error(`lpDispatchKindFor: unmapped decision ${String(unreachable)}.`);
    }
  }
}

/**
 * PHASE3.15 (R2.6): the reason a grid agent is SKIPPED while `GRID_ENABLED` is
 * off. Never "manage it the standard way" — a rotate would re-range the level.
 */
export const LP_GRID_DISABLED_REASON =
  "This agent's settings carry a grid block but GRID_ENABLED is off on this deployment; the position is skipped rather than standard-managed, because a rotate would re-range the grid level and destroy the strategy.";

/**
 * PHASE3.16 R2.5 (review H4) — every sequence kind the GRID flag governs, as a
 * SET rather than a second literal.
 *
 * The resume path's flag-off skip used to test `kind === "grid-flip"`, so a
 * held `grid-arm` on a deployment that turned the flag OFF would have been
 * resumed and driven — the exact posture 3.15 refused, arriving through the
 * flag itself. A hardcoded kind is how this class of bug gets in (the 3.15
 * audit's M-C mutation exists for it), so the predicate is membership and any
 * future grid kind joins HERE, in one place.
 *
 * The EVALUATE path needs no such set: its skip is settings-shaped (does this
 * agent's settings carry a grid block) and already covers every grid kind. It
 * is also never reached for a position with a non-terminal sequence, which is
 * why the resume path needed its own gate at all.
 */
export const GRID_SEQUENCE_KINDS: ReadonlySet<LpSequenceKind> =
  new Set<LpSequenceKind>(["grid-flip", "grid-arm", "grid-requote", "grid-recenter"]);

/* -------------------------------------------------------------------------- */
/* One cycle                                                                  */
/* -------------------------------------------------------------------------- */

export async function runLpWorkerOnce(
  deps: LpWorkerDeps,
  state: LpWorkerState,
): Promise<LpWorkerCycleReport> {
  // (0) FREEZE THE CYCLE CLOCK — the first statement, before any read (module
  // header, Rev2 item 2). This is the evaluator's `nowMs`, the observation's
  // `evaluatedAtMs`, and the report's `startedAtMs` (which used to be computed
  // at the RETURN, i.e. a finish time under a start-time name).
  const cycleNowMs = deps.now();
  const outcomes: LpWorkerPositionOutcome[] = [];
  const emit = (outcome: LpWorkerPositionOutcome): void => {
    outcomes.push(outcome);
    deps.log?.(outcome);
  };

  // (1) Journal reconcile — live cycles only. Reconcile resolves rows through
  // the PROVIDER (`awaitExecution`), and dry-run's contract is zero provider
  // calls; a dry cycle reports the decisions it would make on the rows as
  // they stand.
  let reconciled = false;
  if (!deps.dryRun && deps.reconcile !== undefined) {
    await deps.reconcile();
    reconciled = true;
  }

  // (2) The resume queue first (spec order), then trigger work for open
  // positions that have nothing in flight. ONE action per position per cycle
  // falls out of this partition: a resumed position is never also evaluated.
  const nonTerminal = await deps.store.listNonTerminalSequencesForWorker();
  const resumedPositions = new Set<string>();

  for (const sequence of nonTerminal) {
    // The position stays claimed by its sequence even when the resume is
    // deferred below: a deferred resume must never let a protect or a rotate
    // fire behind a held sequence's back.
    resumedPositions.add(sequence.positionId);
    // PHASE3.11 F1. A sequence that has parked at the same place, for the same
    // reason, LP_STALL_LATCH_ATTEMPTS cycles running is not making progress —
    // and resuming it writes `updated_at` twice per interval, which starves
    // the owner's abandon claim of the idleness it requires. Back off and
    // write NOTHING, so the row goes quiescent and the owner can claim it.
    if (shouldDeferStalledResume(sequence, cycleNowMs, deps.intervalMs)) {
      emit({
        agentId: sequence.agentId,
        positionId: sequence.positionId,
        action: "skipped",
        kind: sequence.kind,
        reason: `The ${sequence.kind} sequence ${sequence.sequenceId} has parked at the same point ${sequence.stallCount} cycles running (${sequence.stallCode ?? "unknown"}); the worker backs off for ${LP_STALL_BACKOFF_INTERVALS} intervals so the owner can abandon it.`,
      });
      continue;
    }
    try {
      // PHASE3.8-FIXREVIEW N1. A HELD worker resume and the owner abandon
      // route contend on the sequence row BEFORE either side reads evidence or
      // touches the position. `held -> active` is row-locked in Postgres; the
      // route's single UPDATE can only change that same HELD version to
      // `abandoning`. Whichever write wins fences the other process. Doing this
      // after `loadPositionContext` would be too late: its ownership gate can
      // itself update or close the position.
      const claimedHeld = !deps.dryRun && sequence.state === "held";
      if (claimedHeld) {
        await deps.store.setSequenceState(
          sequence.ownerAddress,
          sequence.agentId,
          sequence.sequenceId,
          "active",
        );
      }

      let context: PositionContextResult;
      try {
        context = await loadPositionContext(
          deps,
          {
            ownerAddress: sequence.ownerAddress,
            agentId: sequence.agentId,
            positionId: sequence.positionId,
          },
          cycleNowMs,
        );
      } catch (error) {
        if (claimedHeld) {
          try {
            await deps.store.setSequenceState(
              sequence.ownerAddress,
              sequence.agentId,
              sequence.sequenceId,
              "held",
            );
          } catch {
            /* fail closed active; preserve the context error */
          }
        }
        throw error;
      }
      if (context.kind === "skip") {
        if (claimedHeld) {
          // No saga (and therefore no submit) began. Restore the prior parked
          // state; a failed restore throws and leaves the safer ACTIVE fence.
          await deps.store.setSequenceState(
            sequence.ownerAddress,
            sequence.agentId,
            sequence.sequenceId,
            "held",
          );
        }
        emit({
          agentId: sequence.agentId,
          positionId: sequence.positionId,
          action: "skipped",
          kind: sequence.kind,
          reason: context.reason,
        });
        continue;
      }
      // PHASE3.15's flag-off skip, on the RESUME path too. Running a money
      // saga under a flag the operator turned off is the wrong posture, and
      // nothing is trapped by refusing: the sequence stays where it is, the
      // stall latch quiesces the row, and the owner-signed abandon door is
      // unaffected by this flag.
      if (GRID_SEQUENCE_KINDS.has(sequence.kind) && deps.gridEnabled !== true) {
        if (claimedHeld) {
          await deps.store.setSequenceState(
            sequence.ownerAddress,
            sequence.agentId,
            sequence.sequenceId,
            "held",
          );
        }
        emit({
          agentId: sequence.agentId,
          positionId: sequence.positionId,
          action: "skipped",
          kind: sequence.kind,
          reason: LP_GRID_DISABLED_REASON,
        });
        continue;
      }
      if (deps.dryRun) {
        emit({
          agentId: sequence.agentId,
          positionId: sequence.positionId,
          action: "dry-run",
          kind: sequence.kind,
          reason: `Would resume the non-terminal ${sequence.kind} sequence ${sequence.sequenceId} (state ${sequence.state}, recovery ${sequence.recoveryState}). Nothing was executed.`,
        });
        continue;
      }
      const result = await resumeSequence(deps, context, sequence);
      if (result.status === "held") {
        // F1's evidence, written LAST in the cycle so it costs no extra
        // quiescence: this cycle parked the sequence again, at a stated place,
        // for a stated reason. Derived state — a failed write costs one more
        // resume and decides nothing, which is the pre-F1 behaviour.
        try {
          await deps.store.recordSequenceStall(
            sequence.ownerAddress,
            sequence.agentId,
            sequence.sequenceId,
            lpResumeStallCode(result),
          );
        } catch {
          /* derived: failing to latch costs a resume, never the saga */
        }
      }
      // Retention (Rev2 item 12): a resume that CLOSED the lineage retires the
      // observation row with it. Never fatal — the row is derived state.
      await retireObservationIfClosed(deps, context.position);
      emit({
        agentId: sequence.agentId,
        positionId: sequence.positionId,
        action: "resumed",
        kind: sequence.kind,
        reason: result.reason,
        result,
      });
    } catch (error) {
      emit({
        agentId: sequence.agentId,
        positionId: sequence.positionId,
        action: "error",
        kind: sequence.kind,
        reason: sanitizeMessage(messageOf(error)),
      });
    }
  }

  // (3) Trigger evaluation for open positions with nothing in flight.
  const positions = await deps.store.listOpenPositionsForWorker();

  for (const position of positions) {
    if (resumedPositions.has(position.positionId)) continue;
    try {
      const outcome = await evaluatePosition(
        deps,
        state,
        position,
        cycleNowMs,
        // PHASE3.20 item 16: the array this loop is already iterating, so the
        // last-slot arbitration can read the sibling's persisted stamp.
        positions,
      );
      emit(outcome);
    } catch (error) {
      emit({
        agentId: position.agentId,
        positionId: position.positionId,
        action: "error",
        reason: sanitizeMessage(messageOf(error)),
      });
    }
  }

  await repairLpFeeEvents(deps, state);
  return { startedAtMs: cycleNowMs, dryRun: deps.dryRun, reconciled, outcomes };
}

/* -------------------------------------------------------------------------- */
/* Per-position plumbing                                                      */
/* -------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The default-settings digest — one computation, the route's own bytes.
 *
 * EXPORTED since PHASE3.13 (review F11) purely so a test can pin it against a
 * LITERAL hex golden vector. It was referenced by no test at all, and this is
 * the value `currentSettingsDigest()` compares against every in-flight sequence
 * of every agent with NO stored settings row: if it moves, every one of them is
 * refused at upgrade. A recomputation of
 * `paramsHash("lpSettings", defaultLpSettingsParams())` would move WITH the
 * change it is meant to catch, so the pin must be a constant.
 */
export const DEFAULT_SETTINGS_DIGEST: Hex = paramsHash(
  "lpSettings",
  defaultLpSettingsParams(),
);

type PositionContext = {
  readonly kind: "ok";
  readonly agent: AgentRecord;
  readonly position: LpPositionRecord;
  readonly settings: LpAutomationSettings;
  readonly digest: Hex;
  readonly pool: Address;
  readonly wbnbIsToken0: boolean;
  readonly token: Address;
};

type PositionContextResult =
  | PositionContext
  | {
      readonly kind: "skip";
      readonly reason: string;
      /**
       * Which of PHASE3.1-REVIEW R5's two silent-disarm checks refused, when
       * one of them did. Carried so the read side and the worker's own log can
       * report `armed: false` with the SAME message (Rev2 item 27).
       */
      readonly settingsFailure?: "digest" | "unreadable";
      /**
       * The position row AS THE SKIP LEFT IT (PHASE3.4 M6). Present only when
       * the skip itself wrote to the row — today, the ownership gate — so the
       * cycle output can report `armed: false` from the POST-write counts.
       *
       * Without it the worker's own print would compute protection from the
       * pre-increment row and answer `armed: true` about a position it just
       * suspended, while `GET /agents/:id/lp` (which reads the row afresh) said
       * `false`. Two surfaces, one fact, two answers — which is the shape of
       * PHASE3.3-AUDIT A3, and it is not any better for being off by one cycle.
       */
      readonly position?: LpPositionRecord;
    };

/**
 * Everything a dispatch needs about one position: the agent row (verified
 * against the position's own owner scope), the owner settings with the digest
 * RE-VERIFIED, and the pool. Every failure is a reasoned skip, never a guess.
 */
async function loadPositionContext(
  deps: LpWorkerDeps,
  ref: {
    readonly ownerAddress: Address;
    readonly agentId: string;
    readonly positionId: string;
  },
  /** The FROZEN cycle clock (PHASE3.2 Rev2 item 2), for A2's read separation. */
  cycleNowMs: number,
): Promise<PositionContextResult> {
  const agent = await deps.agentStore.getAgentById(ref.agentId);
  if (agent === null) {
    return { kind: "skip", reason: "The position's agent row no longer exists." };
  }
  if (agent.ownerAddress.toLowerCase() !== ref.ownerAddress.toLowerCase()) {
    return {
      kind: "skip",
      reason: "The position's owner scope does not match its agent row; refusing to dispatch across it.",
    };
  }
  const position = await deps.store.getPosition(
    ref.ownerAddress,
    ref.agentId,
    ref.positionId,
  );
  if (position === null) {
    return { kind: "skip", reason: "The position row no longer exists." };
  }

  const stored = await deps.settingsStore.get(agent.ownerAddress, agent.id);
  let settings: LpAutomationSettings = DEFAULT_LP_SETTINGS;
  let digest: Hex = DEFAULT_SETTINGS_DIGEST;
  if (stored !== null) {
    // DIGEST RE-VERIFIED (the task's own words): the stored digest must be
    // the hash of the stored bytes under the ONE shared encoder. A mismatch
    // means the row and the signature it claims have drifted — automation
    // under it would run settings nobody provably signed.
    const recomputed = paramsHash("lpSettings", stored.params);
    if (recomputed.toLowerCase() !== stored.digest.toLowerCase()) {
      return {
        kind: "skip",
        reason: LP_DIGEST_UNVERIFIED_REASON,
        settingsFailure: "digest",
      };
    }
    const parsed = parseLpSettingsParams(stored.params);
    if (!parsed.ok) {
      return {
        kind: "skip",
        reason: lpSettingsUnreadableReason(parsed.message),
        settingsFailure: "unreadable",
      };
    }
    settings = parsed.value;
    digest = stored.digest;
  }

  const wbnb = deps.venue.wbnb.toLowerCase();
  const wbnbIsToken0 = position.token0.toLowerCase() === wbnb;
  if (!wbnbIsToken0 && position.token1.toLowerCase() !== wbnb) {
    return {
      kind: "skip",
      reason: "The position has no WBNB leg; v1 automation refuses it (fail-closed).",
    };
  }
  const token = wbnbIsToken0 ? position.token1 : position.token0;

  const pool = await deps.readers.getPool(
    position.token0,
    position.token1,
    position.fee,
  );
  if (pool === null) {
    return { kind: "skip", reason: "No pool exists for the position's legs and fee tier." };
  }

  // PHASE3.4 Rev2 M6/M7/M8 — THE OWNERSHIP GATE.
  //
  // It lives here, at the end of `loadPositionContext`, because this function is
  // called from BOTH the resume path and the evaluate path, and the resume path
  // is the one that costs money. NFPM `increaseLiquidity` is PERMISSIONLESS: a
  // harvest whose collect and sweep confirmed, whose NFT the owner then
  // transferred away, would on resume deposit both carried legs into a position
  // someone else now owns — and it would NOT revert. A frozen sequence costs
  // patience; a resumed one donates.
  //
  // Before import this state was nearly unreachable (`/lp/open` minted the NFT
  // and only a saga touched it). Import makes owner-held NFTs moving an expected
  // event, which is why the read is worth one `eth_call` against the five this
  // cycle already makes.
  //
  // RESIDUAL, stated rather than implied (the `checkLpNativeCapSizing` register):
  // this read is at cycle start, so a transfer landing between here and the
  // step's relay submit still donates. Closing THAT needs a per-submit ownership
  // read inside the saga and is out of scope.
  const ownership = await checkPositionOwnership(deps, agent, position, cycleNowMs);
  if (ownership.kind === "skip") return ownership;
  return {
    kind: "ok",
    agent,
    position: ownership.position,
    settings,
    digest,
    pool,
    wbnbIsToken0,
    token,
  };
}

/**
 * Confirm the position's NFT is still the wallet's, and persist the finding.
 *
 * Three outcomes, and the asymmetry between them is the whole design:
 *
 * - **match** ⇒ the durable counter resets to zero (a transfer-back between two
 *   cycles must not accumulate toward a close) and the position proceeds;
 * - **mismatch** (including `"burned"`, which is positive confirmation that the
 *   token does not exist) ⇒ the durable counter increments and the position
 *   skips. On the SECOND consecutive confirmation, with no non-terminal sequence
 *   on the position, the row is CLOSED — which is what frees
 *   `lp_positions_one_live_token_idx` for the NFT's next owner to import, and
 *   without which the index deadlocks exactly the owner most likely to arrive
 *   with a hand-held position: one who received it. Two consecutive finalized
 *   reads is the trigger evaluator's own confirmation discipline applied to the
 *   same class of decision;
 * - **read failure** ⇒ HOLD, and write NOTHING. An RPC outage must never read as
 *   "the NFT is gone", because that answer closes positions. Same posture
 *   `readers.positions` takes on a transport error.
 *
 * The counter is DURABLE because the alternative is FINDINGS (ae) a third time:
 * a confirmation counter in process memory resets on every restart, so with a
 * two-cycle rule the close could never fire on a restarting daemon and would
 * fire immediately-never on `--once`.
 *
 * ─── AUDIT A1: A DRY RUN READS AND REPORTS, AND WRITES NOTHING ──────────────
 *
 * The first build ran this gate from `loadPositionContext`, which both worker
 * paths call BEFORE they consult `deps.dryRun` — so a rehearsal durably
 * incremented the counter and TWO rehearsals closed the position and zeroed its
 * basis. That inverts this file's own contract ("dry-run … executes NOTHING")
 * and PHASE3.2's overlay discipline, and it does so in the mode an operator
 * reaches for precisely when something looks wrong. The close may well be the
 * right outcome; it must come from a live cycle.
 *
 * So under `dryRun` the read still happens (the read IS the decision, and a
 * rehearsal that skipped it would report a different verdict than the live
 * cycle would), the finding is reported in the cycle output verbatim, and every
 * store write is skipped — including the CLOSE, which is reported as the action
 * a live cycle would take.
 *
 * ─── AUDIT A2: THE READ IS FINALIZED, AND THE TWO READS ARE SEPARATED ───────
 *
 * `ownerOf` reads at the FINALIZED block ({@link LpChainReaders.ownerOf}), not
 * at `latest`, because {@link LP_NOT_OWNED_REASON} tells the owner it did and
 * because the two-confirmation rule was accepted on the strength of it: a
 * finalized answer cannot be reorged out from under the close, where a `latest`
 * answer from one lagging node in a round-robin pool can.
 *
 * And the two confirmations must be an INTERVAL apart, which is the other half
 * of the trigger evaluator's discipline this rule claims to inherit. Without it
 * two `--once` invocations seconds apart against one misbehaving endpoint
 * satisfy "two consecutive confirmations".
 *
 * ─── FIXREVIEW F1: WHAT THE SEPARATION MEASURES FROM, AND WHY IT MATTERS ────
 *
 * The first fix measured from the row's `updatedAt` and was MEASURED to make
 * the close impossible on the shipped daemon cadence. The gate writes its
 * increment BEFORE it checks the separation, so `updatedAt` was the gate's OWN
 * write from the previous cycle, stamped at *cycle start + δ* (the reconcile,
 * the store reads, the `ownerOf` RPC). The daemon anchors consecutive cycle
 * STARTS exactly `intervalMs` apart, so the measured gap was `intervalMs − δ`,
 * short by δ, every cycle, for ever — the counter climbing without bound while
 * the close never fired. FINDINGS (ae)'s class, re-introduced by a fix into the
 * finding it was fixing, and invisible to the suite because the test fixture
 * shares one frozen clock between worker and store, making δ exactly zero.
 *
 * So the anchor is {@link LpPositionRecord.ownershipFirstSeenAtMs}: the FROZEN
 * CYCLE CLOCK of the FIRST confirmation, never moved while the mismatch
 * persists, cleared when a matching read resets the count. Both endpoints of
 * the comparison are now cycle-start stamps, so δ cancels instead of
 * accumulating — which is FINDINGS (af)'s lesson pointed the other way.
 *
 * A row written before this column existed holds `null`; that reads as "no
 * anchor yet" and costs one extra confirmation cycle, never a wrong close.
 */
async function checkPositionOwnership(
  deps: LpWorkerDeps,
  agent: AgentRecord,
  position: LpPositionRecord,
  cycleNowMs: number,
): Promise<
  | { readonly kind: "ok"; readonly position: LpPositionRecord }
  | {
      readonly kind: "skip";
      readonly reason: string;
      readonly position?: LpPositionRecord;
    }
> {
  if (position.tokenId === null) {
    // Nothing to own yet — an open is in flight and its own saga is authority.
    return { kind: "ok", position };
  }
  let owner: Address | "burned";
  try {
    owner = await deps.readers.ownerOf(BigInt(position.tokenId));
  } catch {
    return {
      kind: "skip",
      reason:
        "The position's on-chain owner could not be read; holding rather than treating an RPC failure as a lost NFT.",
    };
  }
  if (owner !== "burned" && owner.toLowerCase() === agent.walletAddress.toLowerCase()) {
    if (position.ownershipMismatchCount === 0) return { kind: "ok", position };
    // A transfer BACK: clear the count so a later, unrelated mismatch starts
    // from one rather than inheriting a stale confirmation.
    if (deps.dryRun) return { kind: "ok", position };
    const cleared = await deps.store.setOwnershipMismatch(
      position.ownerAddress,
      position.agentId,
      position.positionId,
      { count: 0, reason: null, firstSeenAtMs: null },
    );
    return { kind: "ok", position: cleared };
  }

  const detail =
    owner === "burned"
      ? `NFPM tokenId ${position.tokenId} does not exist on chain`
      : `NFPM tokenId ${position.tokenId} is held by ${owner}, not the agent wallet`;
  const count = position.ownershipMismatchCount + 1;
  // F1: HELD, not refreshed. The first confirmation of THIS run of mismatches
  // anchors the separation; every later one inherits it.
  const firstSeenAtMs = position.ownershipFirstSeenAtMs ?? cycleNowMs;
  const separationMs = cycleNowMs - firstSeenAtMs;
  const separated = separationMs >= deps.intervalMs;
  if (deps.dryRun) {
    // A1: report exactly what a live cycle would do, and touch nothing. The
    // overlay-shaped position record below is process-local — it never reaches
    // a store — so the cycle output can report `armed: false` honestly while
    // the row on disk stays as the last LIVE cycle left it.
    const rehearsed: LpPositionRecord = {
      ...position,
      ownershipMismatchCount: count,
      ownershipLostReason: detail,
    };
    // FIXREVIEW F2: report what a live cycle would ACTUALLY do, which is not
    // "close" merely because the count reached two — the separation gate and
    // the non-terminal-sequence defer both still apply, and a rehearsal that
    // promised a close the live cycle would refuse is the same over-claim in
    // the other direction.
    const wouldClose = count >= 2 && separated;
    return {
      kind: "skip",
      position: rehearsed,
      reason:
        `${detail}; DRY RUN, so nothing was written — a live cycle would record ` +
        `confirmation ${count}` +
        (wouldClose
          ? " and, with no non-terminal sequence on the position, close it."
          : count >= 2
            ? ` and still hold the close: only ${separationMs} ms have passed since the first confirmation, inside the ${deps.intervalMs} ms worker interval.`
            : "."),
    };
  }
  const marked = await deps.store.setOwnershipMismatch(
    position.ownerAddress,
    position.agentId,
    position.positionId,
    { count, reason: detail, firstSeenAtMs },
  );
  if (count < 2) {
    return {
      kind: "skip",
      position: marked,
      reason: `${detail}; automation is suspended pending a second consecutive confirmation.`,
    };
  }
  // A2's second half, as F1 corrects it: the confirmations must span at least
  // one worker interval, measured from the FIRST one's frozen cycle clock.
  if (!separated) {
    return {
      kind: "skip",
      position: marked,
      reason:
        `${detail}; ${separationMs} ms have passed since the first confirmation, ` +
        `inside the ${deps.intervalMs} ms worker interval, so the close waits for a separated read.`,
    };
  }
  // The close DEFERS to a non-terminal sequence: that sequence is the operator's
  // problem first (its steps may have carried funds), and closing under it would
  // strand a saga mid-flight. It stays visible through `blockedBySequence`.
  const blocking = await deps.store.getNonTerminalSequence(
    position.ownerAddress,
    position.agentId,
    position.positionId,
  );
  if (blocking !== null) {
    return {
      kind: "skip",
      position: marked,
      reason: `${detail}; the close is deferred while sequence ${blocking.sequenceId} (${blocking.kind}) is non-terminal.`,
    };
  }
  const closed =
    position.state === "closed"
      ? marked
      : await deps.store.setPositionState(
          position.ownerAddress,
          position.agentId,
          position.positionId,
          "closed",
        );
  // AUDIT A8: every other path to `closed` retires the observation row (Rev2
  // item 12's retention discipline); this one exits above `persistObservation`,
  // so without this the store accumulates one dead row per ownership close, in
  // the file that curates its retention. Derived state — a failure here must
  // never turn a completed close into an error.
  try {
    await deps.observations.delete(
      position.ownerAddress,
      position.agentId,
      position.positionId,
    );
  } catch {
    /* the row is derived; a failed sweep costs one dead row */
  }
  return {
    kind: "skip",
    position: closed,
    reason: `${detail}; confirmed twice, so the position row is closed and its tokenId released.`,
  };
}

/**
 * The brain-free saga deps. This is the ONLY constructor the protect,
 * harvest, manual-exit and open dispatches see, and its return type
 * ({@link LpSagaDeps}) has no field a brain could ride in on (Rev2 item 28).
 */
function buildSagaDeps(deps: LpWorkerDeps, context: PositionContext): LpSagaDeps {
  const { agent, settings } = context;
  return {
    agent,
    agentStore: deps.agentStore,
    provider: deps.provider,
    journal: deps.journal,
    store: deps.store,
    killswitch: deps.killswitch,
    rails: deps.rails,
    quota: {
      maxExitSequencesPerDay: settings.maxExitSequencesPerDay,
      minMinutesBetweenExits: settings.minMinutesBetweenExits,
      // PHASE3.15 R2.7: the GRID lane's own daily count, from the same
      // digest-verified row. Absent for a non-grid agent, which is exactly
      // right — it never reserves in that lane, and the store fails closed at
      // zero if anything ever tried.
      ...(settings.grid === null
        ? {}
        : { maxGridFlipsPerDay: settings.grid.maxFlipsPerDay }),
      // PHASE3.18 C7: the REQUOTE lane's own daily count, from the same
      // digest-verified row. Absent for a fixed-mode grid and for a non-grid
      // agent — and the store then fails closed at zero, which is what makes a
      // fixed grid structurally unable to reserve in this lane at all.
      ...(settings.grid?.requote === undefined
        ? {}
        : { maxRequotesPerDay: settings.grid.requote.maxRequotesPerDay }),
      // PHASE3.19 item 19: the LADDER lane's own daily count, from the same
      // digest-verified row. Absent for every non-ladder grid and for every
      // non-grid agent — and the store then fails closed at zero, which is what
      // makes a fixed or policy grid structurally unable to reserve here.
      // PHASE3.20 D1 / C10: the ladder's ONE lane became TWO, and both limits
      // come from {@link ladderMotionCounts} — the only reader of the legacy
      // `maxMovesPerDay` outside the validator and the canonical-params view, so
      // a 3.19 signature is interpreted here exactly as it is everywhere else.
      // `maxMovesPerDay` is still supplied so the retained `"recenter"` lane's
      // own limit is not zero for a caller that reaches it.
      ...(settings.grid?.ladder === undefined
        ? {}
        : {
            ...(settings.grid.ladder.maxMovesPerDay === undefined
              ? {}
              : { maxMovesPerDay: settings.grid.ladder.maxMovesPerDay }),
            maxSettlementsPerDay: ladderMotionCounts(settings.grid.ladder)
              .settlementsPerDay,
            maxDriftMovesPerDay: ladderMotionCounts(settings.grid.ladder)
              .driftMovesPerDay,
          }),
      // PHASE3.22 R2.21 — the SHIFT lane's own daily count, from the same
      // digest-verified row, and absent for every non-shift grid so the store
      // fails closed at zero for anything that never signed one.
      //
      // FOUND LIVE 2026-08-30, FINDINGS (bd): this arm did not exist, so
      // `quotaLimitFor("shift")` read `maxShiftsPerDay ?? 0` and EVERY shift
      // reservation was refused as "quota exhausted" while the owner view
      // reported `shiftsUsed: 0 of 2`. The trigger's own pre-check passed (it
      // reads the SETTINGS), the store's refused (it reads THIS object), and
      // the two disagreed — so the worker dispatched into a refusal every
      // cycle and rolled back, which is the (az) churn shape R6 exists to
      // prevent. Sixteen rolled-back rows in eight minutes, zero money moved.
      ...(settings.grid?.shift === undefined
        ? {}
        : {
            maxShiftsPerDay: settings.grid.shift.shiftsPerDay,
            maxShiftDriftPerDay: gridShiftDriftMotionsPerDay(settings.grid.shift),
          }),
    },
    market: async () => {
      const state = await deps.readers.poolState(context.pool);
      return { ...state.evidence, currentTick: state.currentTick };
    },
    positions: deps.readers.positions,
    quote: deps.readers.quote,
    // PHASE3.19 item 5: OPTIONAL end to end. A deployment whose readers cannot
    // answer a wallet balance simply does not supply it, and the LADDER saga —
    // the only consumer — refuses fail-closed rather than sizing its mint from
    // something else. Every other saga is unaffected and `tsc` proves it.
    ...(deps.readers.walletTokenBalance === undefined
      ? {}
      : {
          walletTokenBalance: (token: Address): Promise<bigint> =>
            // The wallet is bound HERE, at the one seam that knows the agent.
            // The reader is per-deployment; the wallet is per-agent.
            (deps.readers.walletTokenBalance as NonNullable<
              typeof deps.readers.walletTokenBalance
            >)(token, agent.walletAddress),
        }),
    ...(deps.feeEvents === undefined ? {} : { feeEvents: deps.feeEvents }),
    ...(deps.feeWorkerFence === undefined ? {} : { feeSignal: deps.feeWorkerFence.signal }),
    receipts: deps.readers.receipts,
    expectedPool: context.pool,
    conversionCompatibleTokens: deps.conversionCompatibleTokens,
    settingsDigest: context.digest,
    // PHASE3.1 Rev2 item 8: the owner's own setting reaches the saga as a
    // REQUIRED dep, from the same parsed-and-digest-verified row the rest of
    // this context came from.
    exitToQuote: settings.exitToQuote,
    // PHASE3.13 F12: the same posture, for the harvest range refusal's remedy.
    autoRotate: settings.autoRotate,
    relayFeePerSubmitWei: deps.relayFeePerSubmitWei,
    currentSettingsDigest: async () => {
      const stored = await deps.settingsStore.get(agent.ownerAddress, agent.id);
      return stored === null ? DEFAULT_SETTINGS_DIGEST : stored.digest;
    },
    venue: deps.venue,
    now: deps.now,
    ...(deps.deadlineSec === undefined ? {} : { deadlineSec: deps.deadlineSec }),
  };
}

/**
 * Rotate's deps: the ONE place the brain transport may be attached, as the
 * one-line closure over the worker-only proposal transport, and only when the
 * owner's settings enable it and signed a model block.
 */
async function buildRotateDeps(
  deps: LpWorkerDeps,
  context: PositionContext,
): Promise<LpRotateDeps> {
  const state = await deps.readers.poolState(context.pool);
  const transport = deps.brainTransport;
  const brain = context.settings.brain;
  const proposeRange =
    context.settings.brainEnabled
      && brain !== undefined
      && transport !== undefined
      ? (proposalContext: LpRangeProposalContext): Promise<unknown> =>
          transport("range", { ...proposalContext }, brain).then((reply) => reply)
      : undefined;
  return {
    ...buildSagaDeps(deps, context),
    tickSpacing: state.tickSpacing,
    maxTickWidth: deps.maxTickWidth,
    // PHASE3.13: the owner-signed rotate shape, from the same verified row.
    rotateMode: context.settings.rotateMode,
    atomicRotate: deps.atomicRotate === true,
    ...(deps.readers.quoteWithPriceAfter === undefined ? {} : { quoteWithPriceAfter: deps.readers.quoteWithPriceAfter }),
    ...(proposeRange === undefined ? {} : { proposeRange }),
  };
}

/**
 * PHASE3.15 — the grid flip's deps: the brain-free saga deps plus the SIGNED
 * target range, and nothing else.
 *
 * The target is DERIVED, not stored: which of the two signed ranges the live
 * NFT currently IS decides which one the flip mints into. It is read from the
 * NFT's own ticks rather than from the position row, because the row records
 * the pool and the lineage and never the range — and because on a RESUME the
 * zap-out has already emptied the position while the tokenId and its ticks are
 * still the old level's, which is precisely what makes the plan rebuildable.
 *
 * Every failure here is a THROW, which the caller reports as a per-position
 * error rather than guessing at a target. The `role === null` case is the one
 * C2's settings-route rule exists to prevent (a re-sign that moved both ranges
 * out from under a live level); it is caught rather than trusted.
 */
async function buildGridFlipDeps(
  deps: LpWorkerDeps,
  context: PositionContext,
): Promise<LpGridFlipDeps> {
  const grid = context.settings.grid;
  if (grid === null) {
    throw new Error(
      "The agent's settings carry no grid block, so a grid flip has no signed target range to mint into.",
    );
  }
  const tokenId = context.position.tokenId;
  if (tokenId === null) throw new Error(LP_NO_TOKEN_ID_REASON);
  const snapshot = await deps.readers.positions(BigInt(tokenId));
  if (snapshot === "burned") {
    throw new Error(
      "The grid level's NFT is burned on chain, so the flip cannot derive which signed range it was.",
    );
  }
  // PHASE3.17 R2.5: `{level, role}`. The LEVEL is what keeps a dual grid's two
  // ladders apart — the target is the SAME level's other rung, never the other
  // level's, or two positions would end up on one rung (the B3 collapse the
  // crossed-pair geometry exists to make unreachable).
  //
  // PHASE3.18 C1 — THE ROLE SOURCE IS MODE-DEPENDENT AND THE TARGET IS NOT.
  // In fixed mode this is `gridLiveRole` byte for byte. In policy mode the
  // identity comes from the DURABLE COLUMNS, because a requoted rung equals no
  // signed rung and `gridLiveRole` would answer `null` from the first
  // re-centre onward — throwing here, with a text advising a re-sign that in
  // policy mode is advice to leave policy mode. The TARGET expression is
  // untouched: `gridTargetRange(grid, level, role)` is SIGNED data in both
  // modes, so ruling Q5 and `LpGridFlipDeps.targetRange`'s "Never derived"
  // contract survive exactly as written.
  const roleAt = gridRoleAtFor(grid, snapshot, gridIdentityOf(context.position));
  if (roleAt === null) {
    throw new Error(
      gridModeOf(grid) === "policy"
        ? LP_GRID_IDENTITY_MISSING_REASON
        : `The live level [${snapshot.tickLower}, ${snapshot.tickUpper}) matches none of this grid's signed ranges (${gridRangeList(grid)}); the flip has no defined target. Re-sign the grid block with one range equal to the live level, or exit the position.`,
    );
  }
  return {
    ...buildSagaDeps(deps, context),
    targetRange: gridTargetRange(grid, roleAt.level, roleAt.role),
    // The target IS this level's opposite rung.
    targetRole: roleAt.role === "buy" ? "sell" : "buy",
    ...(deps.gridCycles === undefined ? {} : { gridCycles: deps.gridCycles }),
  };
}

/** The position row's durable grid identity, in the shape the resolver takes. */
function gridIdentityOf(position: LpPositionRecord): {
  gridLevel?: 1 | 2 | null;
  gridRole?: "buy" | "sell" | null;
} {
  return { gridLevel: position.gridLevel, gridRole: position.gridRole };
}

/**
 * PHASE3.18 R2.3 / C4 — the REQUOTE's deps, built FROM THE PERSISTED ROW.
 *
 * `target` is optional and supplied ONLY on the fresh-dispatch path, where the
 * trigger just computed it. On a RESUME it is absent and the row is the sole
 * source — which is the whole of B4's answer, and the reason FINDINGS (aw) is
 * cited: on this relay the resume path is not an edge case, it is the default.
 *
 * PRECEDENCE, enforced here as well as inside the runner: the PERSISTED target
 * WINS. A fresh dispatch that finds a non-terminal requote row whose target
 * disagrees is a THROW, never an overwrite.
 */
async function buildGridRequoteDeps(
  deps: LpWorkerDeps,
  context: PositionContext,
  target?: { readonly tickLower: number; readonly tickUpper: number },
): Promise<LpGridRequoteDeps> {
  const grid = context.settings.grid;
  if (grid === null) {
    throw new Error(
      "The agent's settings carry no grid block, so a grid requote has no policy to re-centre against.",
    );
  }
  if (gridModeOf(grid) !== "policy") {
    // Structurally unreachable — a fixed grid never emits the decision and the
    // store's `?? 0` refuses its lane — and therefore worth failing loudly on.
    throw new Error(
      'A grid requote was dispatched for an agent whose grid.mode is "fixed"; a fixed ladder never re-centres.',
    );
  }
  const identity = gridRoleAtFor(
    grid,
    { tickLower: 0, tickUpper: 0 },
    gridIdentityOf(context.position),
  );
  if (identity === null) throw new Error(LP_GRID_IDENTITY_MISSING_REASON);

  const persisted = await deps.store.getNonTerminalSequence(
    context.position.ownerAddress,
    context.position.agentId,
    context.position.positionId,
  );
  const row =
    persisted !== null && persisted.kind === "grid-requote"
      ? persisted
      : null;
  const stored =
    row === null || row.targetTickLower === null || row.targetTickUpper === null
      ? null
      : { tickLower: row.targetTickLower, tickUpper: row.targetTickUpper };
  if (stored === null && target === undefined) {
    throw new Error(
      `Requote sequence ${row?.sequenceId ?? "(none)"} carries no persisted target range and none was supplied; the rung it was authorized to mint will NOT be re-derived at a fresh tick. Owner-signed abandon is the exit.`,
    );
  }
  if (stored !== null && target !== undefined) {
    if (stored.tickLower !== target.tickLower || stored.tickUpper !== target.tickUpper) {
      throw new Error(
        `Requote sequence ${row?.sequenceId ?? "(none)"} persisted target [${stored.tickLower}, ${stored.tickUpper}) but this cycle recomputed [${target.tickLower}, ${target.tickUpper}). The PERSISTED target wins and is never overwritten (PHASE3.18 C4).`,
      );
    }
  }
  return {
    ...buildSagaDeps(deps, context),
    targetRange: stored ?? (target as { tickLower: number; tickUpper: number }),
    liveRole: identity.role,
    wbnbIsToken0: grid.wbnbIsToken0,
  };
}

/**
 * PHASE3.19 C4/C7 — the LADDER motion's deps, built FROM THE PERSISTED ROW.
 *
 * `target` is optional and supplied ONLY on the fresh-dispatch path, where the
 * trigger just computed it. On a RESUME it is absent and the row is the sole
 * source — which is the whole of 3.18's B4 answer, inherited: FINDINGS (aw)
 * makes the resume path the DEFAULT, not an edge case.
 *
 * PRECEDENCE, enforced here as well as inside the runner (the C4 DOUBLE GUARD):
 * the PERSISTED target WINS, and a fresh dispatch that finds a non-terminal
 * ladder row whose target disagrees is a THROW, never an overwrite.
 *
 * THE BOOK ANCHOR (C4) is resolved HERE, once, rather than inside a saga hook:
 * it is the arm group's member whose `inventory_base_wei` is NOT NULL. A ladder
 * whose anchor cannot be found is a THROW rather than a second book.
 */
async function buildGridRecenterDeps(
  deps: LpWorkerDeps,
  context: PositionContext,
  target?: { readonly tickLower: number; readonly tickUpper: number },
  /**
   * PHASE3.20 item 7 / C6 — the lane the trigger's evidence decided. Passed on
   * the DISPATCH path only; the RESUME path passes nothing, exactly as it passes
   * no target, so the persisted value is the only source there is.
   */
  recenterEvidence?: LpRecenterEvidence,
): Promise<LpGridRecenterDeps> {
  const grid = context.settings.grid;
  if (grid === null) {
    throw new Error(
      "The agent's settings carry no grid block, so a ladder re-anchor has no geometry to move against.",
    );
  }
  const ladder = grid.ladder;
  if (gridModeOf(grid) !== "ladder" || ladder === undefined) {
    // Structurally unreachable — only a ladder emits the decision and the
    // store's `?? 0` refuses its lane — and therefore worth failing loudly on.
    throw new Error(
      'A ladder re-anchor was dispatched for an agent whose grid.mode is not "ladder"; only a ladder re-anchors a FILLED rung.',
    );
  }
  const identity = gridRoleAtFor(
    grid,
    { tickLower: 0, tickUpper: 0 },
    gridIdentityOf(context.position),
  );
  if (identity === null) throw new Error(LP_GRID_IDENTITY_MISSING_REASON);

  const persisted = await deps.store.getNonTerminalSequence(
    context.position.ownerAddress,
    context.position.agentId,
    context.position.positionId,
  );
  const row =
    persisted !== null && persisted.kind === "grid-recenter" ? persisted : null;
  const stored =
    row === null || row.targetTickLower === null || row.targetTickUpper === null
      ? null
      : { tickLower: row.targetTickLower, tickUpper: row.targetTickUpper };
  if (stored === null && target === undefined) {
    throw new Error(
      `Ladder sequence ${row?.sequenceId ?? "(none)"} carries no persisted target range and none was supplied; the rung it was authorized to mint will NOT be re-derived at a fresh tick. Owner-signed abandon is the exit.`,
    );
  }
  if (stored !== null && target !== undefined) {
    if (stored.tickLower !== target.tickLower || stored.tickUpper !== target.tickUpper) {
      throw new Error(
        `Ladder sequence ${row?.sequenceId ?? "(none)"} persisted target [${stored.tickLower}, ${stored.tickUpper}) but this cycle recomputed [${target.tickLower}, ${target.tickUpper}). The PERSISTED target wins and is never overwritten (PHASE3.18 C4).`,
      );
    }
  }

  // C4 — ONE BOOK PER LADDER, on the arm group's ANCHOR row. The anchor is the
  // member whose inventory columns are NOT NULL; a single-row ladder is its own
  // anchor. Failing to find one is a THROW, because the alternative is a second
  // book over one pooled buffer, which is exactly N4.
  const armGroupId = context.position.armGroupId;
  let anchorPositionId = context.position.positionId;
  if (context.position.inventoryBaseWei === null) {
    if (armGroupId === null) {
      throw new Error(
        "This ladder position carries no inventory book and belongs to no arm group, so the ladder's VWAP book cannot be located. The markout gate reads that book, so the motion refuses rather than opening a second one.",
      );
    }
    const siblings = await deps.store.listPositions(
      context.position.ownerAddress,
      context.position.agentId,
    );
    const anchor = siblings.find(
      (row2) => row2.armGroupId === armGroupId && row2.inventoryBaseWei !== null,
    );
    if (anchor === undefined) {
      throw new Error(
        "No row of this ladder's arm group carries the inventory book anchor; the markout gate has no average to read and the motion refuses.",
      );
    }
    anchorPositionId = anchor.positionId;
  }

  return {
    ...buildSagaDeps(deps, context),
    targetRange: stored ?? (target as { tickLower: number; tickUpper: number }),
    liveRole: identity.role,
    // PHASE3.20 C6: absent on the resume path, where `runLpGridRecenter` reads
    // the persisted evidence off the row and its precedence throw guards it.
    ...(recenterEvidence === undefined ? {} : { recenterEvidence }),
    wbnbIsToken0: grid.wbnbIsToken0,
    ladder,
    anchorPositionId,
    armGroupId,
    ...(deps.gridCycles === undefined ? {} : { gridCycles: deps.gridCycles }),
  };
}

/**
 * PHASE3.22 — the ATOMIC LADDER's deps, assembled from the cycle's own facts.
 *
 * ─── WHAT IT DOES *NOT* DO (R8 / C4 / M-B3) ────────────────────────────────
 *
 * It does NOT enforce the target-precedence rule. `buildGridRecenterDeps`
 * above does, and for the requote/ladder that placement is fine; for the shift
 * the guard is deliberately duplicated INSIDE `runLpGridShift` instead,
 * because the audit's named mutation is "delete the guard" and it must die at
 * the SAGA seam where the money is. This helper reads the persisted pair and
 * passes it through; the saga is what refuses a disagreement.
 *
 * It resolves the pair's rows from `arm_group_id` — the 3.17 durable pairing —
 * so the saga never makes that store read itself on a money path.
 */
async function buildGridShiftDeps(
  deps: LpWorkerDeps,
  context: PositionContext,
  targets?: {
    readonly buyRange?: { readonly tickLower: number; readonly tickUpper: number };
    readonly sellRange?: { readonly tickLower: number; readonly tickUpper: number };
  },
  cause?: "cross" | "drift",
): Promise<LpGridShiftDeps> {
  const grid = context.settings.grid;
  if (grid === null) {
    throw new Error(
      "The agent's settings carry no grid block, so a shift has no geometry to move against.",
    );
  }
  const shift = grid.shift;
  if (gridModeOf(grid) !== "shift" || shift === undefined) {
    // Structurally unreachable — only a shift grid emits the decision and the
    // store's `?? 0` refuses its lane — and therefore worth failing loudly on.
    throw new Error(
      'A shift was dispatched for an agent whose grid.mode is not "shift"; only a shift ladder moves one or both targeted rungs in one submission.',
    );
  }
  const armGroupId = context.position.armGroupId;
  if (armGroupId === null) {
    throw new Error(
      "This shift position belongs to no arm group, so its pair cannot be located. A shift may move one or both rungs and needs sibling state, so it refuses rather than guessing the pair.",
    );
  }
  const identity = gridRoleAtFor(
    grid,
    { tickLower: 0, tickUpper: 0 },
    gridIdentityOf(context.position),
  );
  if (identity === null) throw new Error(LP_GRID_IDENTITY_MISSING_REASON);

  const persisted = await deps.store.getNonTerminalSequence(
    context.position.ownerAddress,
    context.position.agentId,
    context.position.positionId,
  );
  const row = persisted !== null && persisted.kind === "grid-shift" ? persisted : null;
  const storedBuy =
    row === null || row.targetTickLower === null || row.targetTickUpper === null
      ? null
      : { tickLower: row.targetTickLower, tickUpper: row.targetTickUpper };
  const storedSell =
    row === null
    || row.targetSellTickLower === null
    || row.targetSellTickUpper === null
      ? null
      : { tickLower: row.targetSellTickLower, tickUpper: row.targetSellTickUpper };
  if (storedBuy === null && storedSell === null && targets === undefined) {
    throw new Error(
      `Shift sequence ${row?.sequenceId ?? "(none)"} carries no persisted target pair and none was supplied; the rungs it was authorized to mint will NOT be re-derived at a fresh tick. Owner-signed abandon is the exit.`,
    );
  }

  // BOTH rows of the pair, from the durable `arm_group_id`. A one-sided pair
  // yields ONE entry, because the dormant side's row is CLOSED (R4.2.2) and a
  // closed row is not in the worker's open-position list.
  const groupRows = (
    await deps.store.listPositions(
      context.position.ownerAddress,
      context.position.agentId,
    )
  ).filter((candidate) => candidate.armGroupId === armGroupId && candidate.state !== "closed");
  const rows = groupRows.flatMap((candidate) =>
    candidate.gridRole === "buy" || candidate.gridRole === "sell"
      ? [
          {
            positionId: candidate.positionId,
            role: candidate.gridRole,
            tokenId: candidate.tokenId,
            lineageId: candidate.lineageId,
          },
        ]
      : [],
  );

  // The economics the funding recompute sizes against, from the SAME builder
  // the arm route and the client transcript read (R2.14's three call sites plus
  // this one consumer of its `minRungWei`).
  const economics = gridShiftEconomics({
    grid,
    shift,
    budgetWei: 0n,
    relayFeePerSubmitWei: deps.relayFeePerSubmitWei,
  });

  return {
    ...buildSagaDeps(deps, context),
    ...(storedBuy !== null
      ? { targetBuyRange: storedBuy }
      : targets?.buyRange === undefined ? {} : { targetBuyRange: targets.buyRange }),
    ...(storedSell !== null
      ? { targetSellRange: storedSell }
      : targets?.sellRange === undefined ? {} : { targetSellRange: targets.sellRange }),
    cause: cause ?? row?.shiftCause ?? "unknown",
    armGroupId,
    rows,
    shift,
    wbnbIsToken0: grid.wbnbIsToken0,
    minRungWei: economics.minRungWei,
    ...(deps.gridCycles === undefined ? {} : { gridCycles: deps.gridCycles }),
  };
}

/**
 * AUDIT A2 — is a NON-TERMINAL `grid-shift` live anywhere in this row's arm
 * group, including on the row itself?
 *
 * Returns the blocking sequence or `null`. Called only behind
 * `gridShiftGroupLock`, so a ladder or fixed grid never reaches it and pays
 * nothing; on the shift path it is ONE owner-scoped `listPositions` plus one
 * `getNonTerminalSequence` per group member, which is the same shape the
 * abandon route and the owner view already use to resolve a pair.
 *
 * The row's OWN sequence is included deliberately: the resume partition
 * normally keeps such a row out of the evaluator entirely, but a DEFERRED
 * resume (the 3.11 stall backoff) leaves it claimed while this function is the
 * belt that says why nothing dispatches.
 */
async function groupShiftInFlight(
  deps: LpWorkerDeps,
  position: LpPositionRecord,
): Promise<LpSequenceRecord | null> {
  const armGroupId = position.armGroupId;
  if (armGroupId === null) return null;
  const rows = await deps.store.listPositions(
    position.ownerAddress,
    position.agentId,
  );
  for (const row of rows) {
    if (row.armGroupId !== armGroupId) continue;
    const sequence = await deps.store.getNonTerminalSequence(
      position.ownerAddress,
      position.agentId,
      row.positionId,
    );
    if (sequence !== null && sequence.kind === "grid-shift") return sequence;
  }
  return null;
}

async function resumeSequence(
  deps: LpWorkerDeps,
  context: PositionContext,
  sequence: LpSequenceRecord,
): Promise<LpSagaRunResult> {
  const positionId = context.position.positionId;
  switch (sequence.kind) {
    case "protect":
      return runLpProtect(buildSagaDeps(deps, context), positionId);
    case "manual-exit":
      // PHASE3.24 C2: worker resume reads only the persisted write-once bit.
      return runLpManualExit(
        buildSagaDeps(deps, context),
        positionId,
        sequence.inlineConvert,
      );
    case "harvest":
      return runLpHarvest(buildSagaDeps(deps, context), positionId);
    case "rotate":
      return runLpRotate(await buildRotateDeps(deps, context), positionId);
    // PHASE3.15. This switch has no `default`, so widening `LpSequenceKind`
    // made THIS arm a compile error until it existed — the one dispatch in the
    // worker the compiler can police, and the reason `worker.ts:1531`'s ternary
    // had to become an exhaustive switch too.
    case "grid-flip":
      return runLpGridFlip(await buildGridFlipDeps(deps, context), positionId);
    // PHASE3.18 C4 — the RESUME loads the row and builds the deps FROM it,
    // before any dispatch. No target is passed, so the persisted one is the
    // only source there is.
    case "grid-requote":
      return runLpGridRequote(await buildGridRequoteDeps(deps, context), positionId);
    // PHASE3.19 C4 — same rule as the requote's: the RESUME loads the row and
    // builds the deps FROM it, before any dispatch. No target is passed, so the
    // persisted one is the only source there is — and the persisted HEDGE INTENT
    // likewise binds the replayed swap.
    case "grid-recenter":
      return runLpGridRecenter(await buildGridRecenterDeps(deps, context), positionId);
    // PHASE3.22 — the RESUME path passes NO targets, exactly as every kind
    // before it does: the persisted pair on the row is the only authority
    // there is, and `runLpGridShift`'s own precedence guard is what refuses a
    // disagreement.
    case "grid-shift":
      return runLpGridShift(await buildGridShiftDeps(deps, context), positionId);
    case "open": {
      // Sentinel input (module header): committed opens FINISH from the
      // receipt without reading it; ambiguous opens HOLD; a fresh re-drive is
      // refused by construction (the signed range is not persisted) and rolls
      // the never-funded lineage back closed.
      const basis = context.position.basisWei;
      return runLpOpen(buildSagaDeps(deps, context), {
        mode: "two-sided-in-range",
        kind: "open",
        positionId,
        budgetWei: basis > 0n ? basis : 1n,
        tickLower: 0,
        tickUpper: 0,
      });
    }
    // PHASE3.16 R2.4/C7 — AN ARM IS NEVER RE-DRIVEN, and this arm of the switch
    // is what guarantees it rather than merely stating it.
    //
    // The resume exists to finish bookkeeping from a CONFIRMED receipt, to hold
    // an ambiguous one, and to roll a never-submitted one back closed. It must
    // NOT rebuild, and an honest rebuild is impossible anyway: the signed range
    // is derivable only against a FRESH tick (minting at a price the owner
    // never signed) and the budget is not persisted at all, because a grid row
    // records `basisWei: 0n`.
    //
    // So the input is one the PLAN BUILDER refuses. `budgetWei: 0n` trips
    // `openPlanning.ts`'s FIRST statement — before the mode branch, before any
    // geometry — yielding BUILD_REFUSED → rollBack → the never-funded lineage
    // closed, which is also what keeps the re-arm precondition reachable.
    //
    // BOTH `mode` AND `kind` say `grid-arm` (C7). An `"open"` kind here would
    // trip `runLpOpen`'s sequence-kind guard into SEQUENCE_CONFLICT/held —
    // exactly NOT the closed row this policy depends on. The open sentinel's
    // own trick (`budgetWei: basis > 0n ? basis : 1n`, refused through the
    // RANGE check) cannot be borrowed: the range check does not run on the grid
    // branch.
    case "grid-arm":
      return runLpOpen(buildSagaDeps(deps, context), {
        mode: "grid-arm",
        kind: "grid-arm",
        positionId,
        budgetWei: 0n,
        tickLower: 0,
        tickUpper: 0,
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Trigger evaluation and dispatch                                            */
/* -------------------------------------------------------------------------- */

function observationKey(agentId: string, positionId: string): string {
  return `${agentId}:${positionId}`;
}

/**
 * The previous observation for a position, or `undefined`.
 *
 * A read failure, a missing row and a structurally invalid row are ALL
 * `undefined` — one extra confirmation cycle, never a position skip. A skip is
 * how this worker responds to unverified OWNER INTENT (the settings-digest
 * path); losing DERIVED telemetry is not that.
 *
 * Under dry-run the process-local overlay is consulted FIRST, then the durable
 * store. Under a live cycle the overlay is not consulted at all.
 */
async function readObservation(
  deps: LpWorkerDeps,
  state: LpWorkerState,
  position: LpPositionRecord,
): Promise<LpTriggerObservation | undefined> {
  if (deps.dryRun) {
    const overlaid = state.dryRunObservations.get(
      observationKey(position.agentId, position.positionId),
    );
    if (overlaid !== undefined) return overlaid;
  }
  try {
    const stored = await deps.observations.get(
      position.ownerAddress,
      position.agentId,
      position.positionId,
    );
    return stored === null ? undefined : stored;
  } catch {
    return undefined;
  }
}

/**
 * Persist the observation. NEVER throws, and is only ever called BELOW the
 * dispatch decision (module header, Rev2 items 9/11).
 *
 * Written EVERY cycle, including holds that change nothing: write-on-change
 * would make `evaluatedAtMs` mean "when the counters last changed", which
 * breaks the age-based staleness discard (it would fire on a live,
 * continuously observed position) and makes the read side report an age of days
 * for a perfectly healthy position — (ae)'s confusion inverted.
 */
async function persistObservation(
  deps: LpWorkerDeps,
  state: LpWorkerState,
  position: LpPositionRecord,
  observation: LpTriggerObservation,
): Promise<boolean> {
  if (deps.dryRun) {
    // The rehearsal advances its OWN state and writes no durable row.
    state.dryRunObservations.set(
      observationKey(position.agentId, position.positionId),
      observation,
    );
    return true;
  }
  try {
    const current = await deps.store.getPosition(
      position.ownerAddress,
      position.agentId,
      position.positionId,
    );
    if (current === null || current.state === "closed") {
      // Retention (Rev2 item 12): the dispatch closed the lineage. Retire the
      // row instead of writing one nothing will ever read.
      await deps.observations.delete(
        position.ownerAddress,
        position.agentId,
        position.positionId,
      );
      return true;
    }
    await deps.observations.put({
      ownerAddress: position.ownerAddress,
      agentId: position.agentId,
      positionId: position.positionId,
      observation,
    });
    return true;
  } catch {
    return false;
  }
}

/** Retention for the resume path. Never throws; the row is derived state. */
async function retireObservationIfClosed(
  deps: LpWorkerDeps,
  position: LpPositionRecord,
): Promise<void> {
  if (deps.dryRun) return;
  try {
    const current = await deps.store.getPosition(
      position.ownerAddress,
      position.agentId,
      position.positionId,
    );
    if (current !== null && current.state !== "closed") return;
    await deps.observations.delete(
      position.ownerAddress,
      position.agentId,
      position.positionId,
    );
  } catch {
    /* derived state; a failed retention sweep costs one dead row */
  }
}

async function evaluatePosition(
  deps: LpWorkerDeps,
  state: LpWorkerState,
  position: LpPositionRecord,
  cycleNowMs: number,
  /**
   * PHASE3.20 item 16 / R3.5 mechanism (a) — THE CYCLE'S OWN POSITION LIST,
   * threaded rather than re-read.
   *
   * The last-slot arbitration needs this row's LADDER SIBLING, and the cycle has
   * already loaded every open row (`listOpenPositionsForWorker`). Passing the
   * array costs nothing and adds no store read; OPTIONAL so every other caller —
   * and every existing test — is unchanged, in which case the arbitration simply
   * does not run and list order decides, which is the residual R3.5 names.
   *
   * It is a cycle-start SNAPSHOT: a sibling closed earlier in the same cycle has
   * had its observation deleted, so it reads as carrying no stranding stamp and
   * this row wins the slot. That is the correct direction.
   */
  cyclePositions?: readonly LpPositionRecord[],
): Promise<LpWorkerPositionOutcome> {
  const base = { agentId: position.agentId, positionId: position.positionId };
  /** The status fields the silent-skip paths can still answer with. */
  const protectionFor = async (input: {
    readonly settings: LpAutomationSettings | null;
    readonly settingsReadable: boolean;
    readonly digestVerified: boolean;
    /** The row to report FROM. Defaults to the one this cycle started with. */
    readonly row?: LpPositionRecord;
  }): Promise<LpProtectionStatus> => {
    const row = input.row ?? position;
    return lpProtectionStatus({
      settings: input.settings,
      settingsReadable: input.settingsReadable,
      digestVerified: input.digestVerified,
      basisWei: row.basisWei,
      hasTokenId: row.tokenId !== null,
      // PHASE3.4 M6: from the ROW, which the ownership gate has already updated
      // this cycle if it found anything. The worker's own `--once` print and the
      // owner's dashboard answer from the same field, so they cannot disagree.
      // PHASE3.6 M2: without the pool, this cannot know a price trigger applies.
      pool: { token0: row.token0, token1: row.token1, fee: row.fee },
      ownershipMismatchCount: row.ownershipMismatchCount,
      ownershipLostReason: row.ownershipLostReason,
      observation: (await readObservation(deps, state, position)) ?? null,
      nowMs: cycleNowMs,
      intervalMs: deps.intervalMs,
      ...(deps.maxObservationAgeMs === undefined
        ? {}
        : { maxObservationAgeMs: deps.maxObservationAgeMs }),
    });
  };

  const context = await loadPositionContext(
    deps,
    {
      ownerAddress: position.ownerAddress,
      agentId: position.agentId,
      positionId: position.positionId,
    },
    cycleNowMs,
  );
  if (context.kind === "skip") {
    if (context.settingsFailure !== undefined) {
      // PHASE3.1-REVIEW R5's silent disarm, reported for the first time.
      return {
        ...base,
        action: "skipped",
        reason: context.reason,
        protection: await protectionFor({
          settings: null,
          settingsReadable: context.settingsFailure !== "unreadable",
          digestVerified: context.settingsFailure !== "digest",
        }),
      };
    }
    if (context.position !== undefined) {
      // PHASE3.4 M6: an ownership skip must not leave the cycle output silent
      // about protection while the row it just wrote says `armed: false`.
      // Settings are reported as readable and verified because this skip
      // happened AFTER both were checked — the ownership reason wins on its
      // own merits inside `lpProtectionStatus`, and claiming a settings
      // problem here would be a second, invented one.
      return {
        ...base,
        action: "skipped",
        reason: context.reason,
        protection: await protectionFor({
          settings: null,
          settingsReadable: true,
          digestVerified: true,
          row: context.position,
        }),
      };
    }
    return { ...base, action: "skipped", reason: context.reason };
  }
  if (context.position.tokenId === null) {
    // An open position with no tokenId and no non-terminal sequence is a
    // bookkeeping gap only an operator can explain; automation refuses it.
    return {
      ...base,
      action: "skipped",
      reason: LP_NO_TOKEN_ID_REASON,
      protection: await protectionFor({
        settings: context.settings,
        settingsReadable: true,
        digestVerified: true,
      }),
    };
  }
  // PHASE3.15 (R2.6): the flag-off skip, BEFORE any market read and before any
  // evaluator is chosen. A grid agent under an off flag is SKIPPED, never
  // standard-managed — the standard evaluator would rotate the level out of
  // its signed range, which is the one outcome the strategy cannot survive.
  const gridSettings = context.settings.grid;
  if (gridSettings !== null && deps.gridEnabled !== true) {
    return {
      ...base,
      action: "skipped",
      reason: LP_GRID_DISABLED_REASON,
      protection: await protectionFor({
        settings: context.settings,
        settingsReadable: true,
        digestVerified: true,
        row: context.position,
      }),
    };
  }
  const tokenId = BigInt(context.position.tokenId);

  // Market evidence at the FINALIZED block (the reader's contract).
  const poolState = await deps.readers.poolState(context.pool);

  // Valuation (module header): principal at the finalized spot, exact fees,
  // TOKEN leg quoted into WBNB through QuoterV2.
  //
  // PHASE3.4 decision 11: this arithmetic moved to `valueLpPosition` UNCHANGED,
  // and the reason it had to move is that `POST /lp/import` shows the owner a
  // value and takes their signature on a `basisWei` measured against it. Two
  // implementations of "what is this position worth" means the stop-loss the
  // owner configured is not the stop-loss that fires.
  const valuation = await valueLpPosition(deps.readers, {
    tokenId,
    wallet: context.agent.walletAddress,
    fee: context.position.fee,
    token: context.token,
    wbnb: deps.venue.wbnb,
    wbnbIsToken0: context.wbnbIsToken0,
    spotSqrtPriceX96: poolState.evidence.spotSqrtPriceX96,
  });
  if (valuation === "burned") {
    return {
      ...base,
      action: "skipped",
      reason: "The position token is burned on-chain; there is nothing to manage.",
    };
  }
  const snapshot = valuation.snapshot;
  const { exitValueWei, freshFeesValueWei } = valuation;

  const previousObservation = await readObservation(deps, state, position);
  // ─── PHASE3.19 item 18 / C16 — THE IDLE BUFFER, READ ONCE, EVALUATE ONLY ──
  //
  // C16 is why this sits HERE and not in `loadPositionContext`: that function
  // also serves the RESUME path, which never uses these numbers, and two extra
  // `balanceOf` calls per cycle per row on a path that discards them is a cost
  // with no purchaser.
  //
  // GATED ON THE MODES THAT DEPLOY FROM AN IDLE BUFFER — ladder AND shift — so
  // no other agent pays for them at all. An absent reader or a failed read
  // leaves them UNDEFINED, which the funding conjunct treats as FAIL-CLOSED —
  // a hold, costing nothing and re-evaluated next cycle — rather than as "the
  // buffer is empty", which would be a claim.
  //
  // FOUND LIVE 2026-08-30, FINDINGS (bc): this gate read `ladder !== undefined`
  // alone, so a `mode: "shift"` grid never had its buffer read at all. Both
  // figures stayed undefined, `gridShiftFunding` fail-closed on BOTH sides, and
  // the shift branch returned a funding hold every cycle for ever — the arm
  // landed, the counters climbed past every threshold, and no `grid-shift` was
  // ever dispatched. The owner view's mirror read (`src/server.ts:7119`) WAS
  // widened for shift, so the status route reported a healthy buffer the worker
  // was not reading: the asymmetry is what hid it. Keep the two gates in step.
  let bufferQuoteWei: bigint | undefined;
  let bufferBaseWei: bigint | undefined;
  let bufferNativeWei: bigint | undefined;
  if (
    gridSettings !== null
    && (gridSettings.ladder !== undefined || gridSettings.shift !== undefined)
  ) {
    const balanceOf = deps.readers.walletTokenBalance;
    if (balanceOf !== undefined) {
      try {
        bufferQuoteWei = await balanceOf(deps.venue.wbnb, context.agent.walletAddress);
        bufferBaseWei = await balanceOf(context.token, context.agent.walletAddress);
      } catch {
        // A transport failure must never read as "no inventory": leave both
        // undefined and hold. Same posture `readers.positions` takes.
        bufferQuoteWei = undefined;
        bufferBaseWei = undefined;
      }
    }
    // GRID-GAS-RESERVE P2 — the NATIVE pot the relay bills a shift from, read
    // under SHIFT mode only (the ladder's motions are gated elsewhere and its
    // fixtures must stay byte-identical). Same failure posture: an unread pot
    // is `undefined`, and the trigger's gas gate holds on it.
    if (gridSettings.shift !== undefined) {
      const nativeOf = deps.readers.walletNativeBalance;
      if (nativeOf !== undefined) {
        try {
          bufferNativeWei = await nativeOf(context.agent.walletAddress);
        } catch {
          bufferNativeWei = undefined;
        }
      }
    }
  }
  // ─── PHASE3.20 items 17-19 / C9 — THE LANE USAGE, READ PER POSITION ──────
  //
  // PLACED WITH THE BUFFER READS and gated the same way, for the reason OQ4
  // gives: no non-ladder agent pays for it, and the cost under Postgres is ONE
  // bounded aggregate over the existing `(agent_id, owner_address, reserved_at)`
  // index — two queries per 30 s for a two-row ladder, against the five-plus RPC
  // reads this same cycle already performs.
  //
  // PER POSITION, NOT PER CYCLE (H3): the loop is sequential and awaited, so row
  // 2's read sees row 1's reservation and HOLDS instead of reserving and being
  // rolled back. A cycle-wide read would show both rows the same pre-decrement
  // number and reproduce the (az) churn exactly.
  //
  // A THROWN READ IS A HOLD (C9 rule 2), not a zero: the object is still passed
  // with BOTH lane counts ABSENT, which the evaluator reads as `usage = limit`.
  // That is the buffer reads' own posture, reached through the same seam rather
  // than through a second rule.
  let ladderQuotaUsage:
    | {
        readonly settlementLiveCount?: number;
        readonly driftLiveCount?: number;
        readonly latestReservedAtMs: number | null;
      }
    | undefined;
  let ladderArbitration:
    | {
        readonly positionId: string;
        readonly siblings: readonly {
          readonly positionId: string;
          readonly mismatchSinceMs: number | null;
        }[];
      }
    | undefined;
  if (gridSettings !== null && gridSettings.ladder !== undefined) {
    try {
      const usage = await deps.store.quotaUsage(
        context.position.ownerAddress,
        context.position.agentId,
      );
      ladderQuotaUsage = {
        ...(usage.settlementLiveCount === undefined
          ? {}
          : { settlementLiveCount: usage.settlementLiveCount }),
        ...(usage.driftLiveCount === undefined
          ? {}
          : { driftLiveCount: usage.driftLiveCount }),
        latestReservedAtMs: usage.latestReservedAtMs,
      };
    } catch {
      // Both counts absent ⇒ usage = limit ⇒ the quota hold. `null` here means
      // "no anchor", which is the permissive answer for the spacing half; the
      // lane half is what refuses, and it refuses closed.
      ladderQuotaUsage = { latestReservedAtMs: null };
    }
    // ITEM 16 / B2 — the sibling's PERSISTED stamp, from the row group the arm
    // wrote (`arm_group_id`). Read through the same per-position observation
    // reader the rest of this function uses, so there is no second codec.
    const armGroupId = context.position.armGroupId;
    if (armGroupId !== null && cyclePositions !== undefined) {
      const siblings: {
        readonly positionId: string;
        readonly mismatchSinceMs: number | null;
      }[] = [];
      for (const other of cyclePositions) {
        if (other.positionId === position.positionId) continue;
        if (other.armGroupId !== armGroupId) continue;
        if (other.agentId !== position.agentId) continue;
        if (other.state === "closed") continue;
        const theirs = await readObservation(deps, state, other);
        siblings.push({
          positionId: other.positionId,
          mismatchSinceMs: theirs?.gridMismatchSinceMs ?? null,
        });
      }
      ladderArbitration = { positionId: position.positionId, siblings };
    }
  }
  // ─── PHASE3.22 R5.5 / D5 / D8 — THE SHIFT PAIR'S CYCLE-START SNAPSHOT ─────
  //
  // Built the `ladderArbitration` way, from the cycle's ALREADY-LOADED position
  // list: zero extra reads, and it inherits that input's two declared
  // properties verbatim — it is a cycle-start snapshot (a sibling closed
  // earlier in the same cycle reads as absent, which is the correct direction
  // because the survivor then dispatches NEXT cycle and never both in one), and
  // its evidence is one cycle stale in one direction.
  //
  // ONE INPUT ANSWERS TWO QUESTIONS, which is D5 and D8 resolved together: it
  // decides WHICH row dispatches, and it gates whether the sibling's evidence
  // may be read at all. A sibling not in the live set contributes NO evidence,
  // so a still-present-but-unswept dormant observation is never consulted.
  let shiftGroupLiveRoles:
    | { readonly role: LpGridRole; readonly liveRoles: readonly LpGridRole[] }
    | undefined;
  let shiftSibling:
    | {
        readonly role: LpGridRole;
        readonly gridCrossConsecutive: number;
        readonly gridDriftConsecutive: number;
        readonly crossSide?: SwaplessRotationSide;
        readonly driftSide?: SwaplessRotationSide;
        readonly gridRangeRelation?: "inside" | "outside";
      }
    | undefined;
  let shiftQuotaUsage:
    | {
        readonly shiftLiveCount?: number;
        readonly shiftSettleLiveCount?: number;
        readonly shiftDriftLiveCount?: number;
        readonly latestReservedAtMs: number | null;
      }
    | undefined;
  if (gridSettings !== null && gridSettings.shift !== undefined) {
    try {
      const usage = await deps.store.quotaUsage(
        context.position.ownerAddress,
        context.position.agentId,
      );
      shiftQuotaUsage = {
        ...(usage.shiftLiveCount === undefined
          ? {}
          : { shiftLiveCount: usage.shiftLiveCount }),
        ...(usage.shiftSettleLiveCount === undefined
          ? {}
          : { shiftSettleLiveCount: usage.shiftSettleLiveCount }),
        ...(usage.shiftDriftLiveCount === undefined
          ? {}
          : { shiftDriftLiveCount: usage.shiftDriftLiveCount }),
        latestReservedAtMs: usage.latestReservedAtMs,
      };
    } catch {
      // The count absent ⇒ usage = limit ⇒ the quota hold. `null` is "no
      // anchor", the permissive answer for the spacing half; the lane half is
      // what refuses, and it refuses closed.
      shiftQuotaUsage = { latestReservedAtMs: null };
    }
    const ownRole = context.position.gridRole;
    const armGroupId = context.position.armGroupId;
    if (
      (ownRole === "buy" || ownRole === "sell")
      && armGroupId !== null
      && cyclePositions !== undefined
    ) {
      const liveRoles: LpGridRole[] = [];
      for (const other of cyclePositions) {
        if (other.armGroupId !== armGroupId) continue;
        if (other.agentId !== position.agentId) continue;
        if (other.state === "closed") continue;
        if (other.gridRole !== "buy" && other.gridRole !== "sell") continue;
        liveRoles.push(other.gridRole);
        // D8: the sibling's evidence is read ONLY because it is in the live set
        // — this loop is the gate. A closed row never reaches here, so its
        // observation (which may not yet have been swept) is never read.
        if (other.positionId === position.positionId) continue;
        const theirs = await readObservation(deps, state, other);
        if (theirs !== undefined) {
          shiftSibling = {
            role: other.gridRole,
            gridCrossConsecutive: theirs.gridCrossConsecutive ?? 0,
            gridDriftConsecutive: theirs.gridDriftConsecutive ?? 0,
            ...(theirs.gridCrossSide === undefined
              ? {}
              : { crossSide: theirs.gridCrossSide }),
            ...(theirs.gridDriftSide === undefined
              ? {}
              : { driftSide: theirs.gridDriftSide }),
            ...(theirs.gridRangeRelation === undefined
              ? {}
              : { gridRangeRelation: theirs.gridRangeRelation }),
          };
        }
      }
      shiftGroupLiveRoles = { role: ownRole, liveRoles };
    }
  }
  // PHASE3.15: THE GATED EVALUATOR DISPATCH, and it is EXCLUSIVE. Everything
  // around it — position loading, `ownerOf` at finalized, rails resolution,
  // observation persistence, the resume partition, the stall latch, dry-run
  // semantics — is SHARED, not copied. Only the decision function differs, and
  // which one runs is decided by the SETTINGS BLOCK, never by a request.
  const evaluatorInput = {
    // AUDIT A7: the digest this cycle runs under, so a count earned under
    // different settings cannot be inherited by a newly-signed trigger.
    settingsDigest: context.digest,
    intervalMs: deps.intervalMs,
    ...(deps.maxObservationAgeMs === undefined
      ? {}
      : { maxObservationAgeMs: deps.maxObservationAgeMs }),
    market: poolState.evidence,
    // The FROZEN cycle clock, not a fresh `deps.now()` taken after five RPC
    // reads — see the module header and FINDINGS (af).
    nowMs: cycleNowMs,
    position: {
      basisWei: context.position.basisWei,
      basisSource: context.position.basisSource,
      collectibleFee0: valuation.collectibleFee0,
      collectibleFee1: valuation.collectibleFee1,
      currentTick: poolState.currentTick,
      exitValueWei,
      freshFeesValueWei,
      poolAddress: context.pool,
      // PHASE3.6: the pool's identifying triple, which is what a price trigger
      // MATCHES on — one rule the evaluator and the read route can both run.
      token0: context.position.token0,
      token1: context.position.token1,
      fee: context.position.fee,
      tickLower: snapshot.tickLower,
      tickUpper: snapshot.tickUpper,
      tokenId: context.position.tokenId,
      // PHASE3.18 R2.6/C1: the row's DURABLE grid identity. The standard
      // evaluator ignores both fields entirely, and so does a fixed-mode grid —
      // only policy mode reads them, where they are the sole role authority.
      gridLevel: context.position.gridLevel,
      gridRole: context.position.gridRole,
      // PHASE3.19 item 18: PRESENT-ONLY-WHEN-READ, so a non-ladder evaluator
      // input is byte-identical to 3.15-3.18's. They never participate in
      // `settingsUnchanged` or comparability: a balance change measures
      // INVENTORY and the cross/drift counters measure PRICE, so folding them in
      // would reset the anti-wick evidence on every fee accrual.
      ...(bufferQuoteWei === undefined ? {} : { bufferQuoteWei }),
      ...(bufferBaseWei === undefined ? {} : { bufferBaseWei }),
      ...(bufferNativeWei === undefined ? {} : { bufferNativeWei }),
    },
    ...(previousObservation === undefined ? {} : { previousObservation }),
    rails: deps.rails,
    settings: context.settings,
    // PHASE3.19: the ladder's funding conjunct computes `ladderMinMintWei` from
    // the SAME builder the arm admits on, so the gate and the admission cannot
    // disagree. Non-ladder evaluators ignore it entirely.
    relayFeePerSubmitWei: deps.relayFeePerSubmitWei,
    // PHASE3.20 items 16-19: PRESENT-ONLY-WHEN-READ, gated on ladder mode, so a
    // non-ladder evaluator input is byte-identical to 3.15-3.19's and the
    // standard evaluator never sees either field.
    ...(ladderQuotaUsage === undefined ? {} : { ladderQuotaUsage }),
    ...(ladderArbitration === undefined ? {} : { ladderArbitration }),
    // PHASE3.22: PRESENT-ONLY-WHEN-READ, gated on SHIFT mode, so every
    // non-shift evaluator input is byte-identical to 3.15-3.20's and neither
    // the standard evaluator nor a ladder ever sees one of these fields.
    ...(shiftGroupLiveRoles === undefined ? {} : { shiftGroupLiveRoles }),
    ...(shiftSibling === undefined ? {} : { shiftSibling }),
    ...(shiftQuotaUsage === undefined ? {} : { shiftQuotaUsage }),
  } as const;
  const evaluation =
    gridSettings === null
      // THE NON-GRID PATH, byte-identical: the standard evaluator is called
      // with exactly the inputs it was called with before this phase.
      ? evaluateLpTriggers(evaluatorInput)
      : evaluateGridTriggers(evaluatorInput);
  // Reporting failure omits only fees; evaluation and dispatch keep their result.
  let fees: LpTriggerObservation["fees"];
  try {
    const pinned = await deps.readers.positionFeesAt?.(BigInt(context.position.tokenId), context.agent.walletAddress, poolState.evidence.blockNumber);
    if (pinned !== undefined && pinned !== "burned") fees = parseLpFeesTelemetry({
      collectible0Wei: pinned.amount0Wei, collectible1Wei: pinned.amount1Wei,
      blockNumber: poolState.evidence.blockNumber, tokenId: context.position.tokenId,
      positionRowVersion: context.position.rowVersion, asOfMs: cycleNowMs,
    });
  } catch { /* Telemetry is unavailable for this evaluation only. */ }
  const portfolioObservation: LpTriggerObservation = {
    ...(fees === undefined ? {} : { fees }),
    ...evaluation.nextObservation,
    tickLower: snapshot.tickLower,
    tickUpper: snapshot.tickUpper,
    valuation: {
      method: "sellable-exit-v1",
      exitValueWei,
      quoteToken: context.position.quoteToken,
      tokenId: context.position.tokenId,
      positionRowVersion: context.position.rowVersion,
      blockNumber: poolState.evidence.blockNumber,
      valuedAtMs: cycleNowMs,
    },
  };

  // The status an operator can read, computed from the observation this cycle
  // is about to record — the same function the HTTP view calls.
  const protection = lpProtectionStatus({
    settings: context.settings,
    settingsReadable: true,
    digestVerified: true,
    basisWei: context.position.basisWei,
    hasTokenId: true,
    // AUDIT A2. Without this the `--once` print reported `armed: false` —
    // "there is nothing to arm" — on the very cycle it recorded a
    // `price-stop-loss` breach, while the HTTP route said `armed: true` about
    // the same position. M2 named TWO surfaces; the build fixed one.
    pool: {
      token0: context.position.token0,
      token1: context.position.token1,
      fee: context.position.fee,
    },
    observation: evaluation.nextObservation,
    nowMs: cycleNowMs,
    intervalMs: deps.intervalMs,
    ...(deps.maxObservationAgeMs === undefined
      ? {}
      : { maxObservationAgeMs: deps.maxObservationAgeMs }),
  });

  // NOTHING between here and the dispatch may write to a store (module header,
  // Rev2 item 9). The observation is persisted BELOW, on every arm.
  const decision = evaluation.decision;
  if (decision === "hold") {
    const observationPersisted = await persistObservation(
      deps,
      state,
      position,
      portfolioObservation,
    );
    return {
      ...base,
      action: "hold",
      decision,
      reason: evaluation.holdReason ?? "No LP management trigger is ready.",
      triggerReason: evaluation.triggerReason,
      observationPersisted,
      protection,
    };
  }

  // ─── PHASE3.18 R2.10 / C11 — THE PER-TOKEN CAP PRE-REFUSAL ──────────────
  //
  // A requote cycle multiplies rolling PER-TOKEN cap consumption by
  // `(1 + maxRequotesPerDay)` on BOTH legs: every re-centre re-approves the
  // held leg to the NFPM. An undersized cap reverts the mint at the relay as an
  // opaque failure — fail-closed, gas only, but with no refusal, no figure and
  // nothing telling the owner which knob to turn.
  //
  // So it is refused HERE, at the trigger seam, and its classification is G0's
  // (C11): a ZERO-MONEY refusal — no sequence created, no reservation taken,
  // nothing held, the price stop still armed. A re-centre that cannot be
  // afforded must simply not start.
  //
  // WHAT IS CHECKED, honestly (the 3.17 C12 precedent, verbatim): the GRANTED
  // per-token cap from the persisted session spec, not the rolling REMAINING
  // allowance. Reading the remaining allowance would need a chain reader this
  // phase's edit list does not have, and the granted cap is a strict UPPER
  // BOUND on it — so this catches the undersized-cap case (the common one) and
  // cannot produce a false refusal, while a cap already spent down today still
  // fails at the relay. Declared, not papered over.
  if (decision === "grid-requote") {
    // The mint charges the leg the level ALREADY holds — a requote converts
    // nothing — so the charged token and its amount are both already in hand.
    const chargedIsQuote = context.position.gridRole === "buy";
    const chargedToken = chargedIsQuote ? deps.venue.wbnb : context.token;
    const chargedWei = chargedIsQuote ? valuation.wbnbTotalWei : valuation.tokenTotalWei;
    const cap = context.agent.sessionFacts?.spec.spendCaps.find(
      (entry) =>
        entry.token !== undefined
        && entry.token.toLowerCase() === chargedToken.toLowerCase(),
    );
    if (cap === undefined || cap.limit < chargedWei) {
      const observationPersisted = await persistObservation(
        deps,
        state,
        position,
        portfolioObservation,
      );
      return {
        ...base,
        action: "skipped",
        decision,
        reason:
          `Grid requote refused before it started: the session cap for ${chargedToken} is `
          + `${cap === undefined ? "absent" : `${cap.limit} wei`}, under the ${chargedWei} wei this `
          + `re-centre would approve to re-mint the same leg. NOTHING was spent and the level is `
          + `untouched. Remedy: npm run add-spend-limit -- --token ${chargedToken} --cap <amount>. `
          + `Note a policy grid consumes this cap up to (1 + maxRequotesPerDay) times per cycle.`,
        triggerReason: evaluation.triggerReason,
        observationPersisted,
        protection,
      };
    }
  }

  // ══ AUDIT A2 / R4.4 (P6) / R5.6 (D6) — THE GROUP LOCK, AT THE WORKER'S
  //    DISPATCH SEAM ═══════════════════════════════════════════════════════
  //
  // THE HOLE THIS CLOSES, and it is the one the audit found open while three
  // shipped comments asserted it was shut. `resumedPositions` claims only each
  // sequence's OWN `positionId` — correct for every kind before 3.22, because
  // every one of them moves exactly one position. A `grid-shift` moves TWO. So
  // the SIBLING of a row holding a live or UNKNOWN shift was evaluated in full
  // every cycle, and priority 0 — the price-stop protect that decision 9 keeps
  // armed per LIVE row under shift mode — runs BEFORE the shift branch. Two
  // consecutive breach observations dispatched `runLpProtect` into the
  // sibling's NFT while the pair's twelve-call batch, which zaps that same NFT,
  // was unresolved.
  //
  // Batch atomicity bounded the money (whichever landed second reverted
  // entirely), so the outcomes were a burned `shiftsPerDay` slot or a reverted
  // protect and never a loss — but this is exactly the interleaving R4.4/P6
  // built the lock to exclude, and an UNKNOWN batch racing a protect multiplies
  // the ambiguity the declared-ambiguity abandon then has to narrate.
  //
  // ─── WHY *HERE* AND NOT IN THE RESUME PARTITION ───────────────────────────
  //
  // Folding the arm group into `resumedPositions` would have been one line, and
  // it would have suppressed the sibling's EVALUATION — taking its finalized
  // `ownerOf` check and its observation write with it. R3.3/P7 requires the
  // opposite and says so precisely: the sibling "keeps its finalized `ownerOf`
  // check and its observation write, and LOSES ITS DISPATCH — protect
  // included". This seam is past both of those and before every saga, so it
  // suppresses exactly what P7 names and nothing more.
  //
  // MODE-FIRST through the shared `gridShiftGroupLock`, so a LADDER pair —
  // which also carries `arm_group_id` — is untouched and every fixed/policy
  // grid is byte-identical. ONE store read, on the shift path only.
  if (
    gridShiftGroupLock({
      grid: gridSettings,
      armGroupId: context.position.armGroupId,
    })
  ) {
    const groupHeld = await groupShiftInFlight(deps, context.position);
    if (groupHeld !== null) {
      const observationPersisted = await persistObservation(
        deps,
        state,
        position,
        portfolioObservation,
      );
      return {
        ...base,
        action: "skipped",
        decision,
        reason:
          `This rung's shift ladder has a non-terminal grid-shift (${groupHeld.sequenceId}, `
          + `${groupHeld.state}/${groupHeld.recoveryState}) on its other rung, and a shift moves BOTH `
          + `rungs in ONE submission. Dispatch is suppressed for this rung — the price stop included, `
          + `which is twice a held grid-flip's blast radius — until that sequence settles. The ownership `
          + `check and the observation write above still ran; nothing was spent.`,
        triggerReason: evaluation.triggerReason,
        observationPersisted,
        protection,
      };
    }
  }

  // PHASE3.15 H7: an EXHAUSTIVE switch, not a ternary with a catch-all
  // `protect` default. See {@link lpDispatchKindFor} for what the default cost.
  const sagaKind = lpDispatchKindFor(decision);

  if (deps.dryRun) {
    // Overlay only — a rehearsal leaves no durable state that could arm a live
    // protect on one live look at the market (Rev2 items 7/8).
    await persistObservation(deps, state, position, portfolioObservation);
    return {
      ...base,
      action: "dry-run",
      decision,
      kind: sagaKind,
      reason: `Would dispatch ${sagaKind}: ${evaluation.triggerReason.reason} Nothing was executed.`,
      triggerReason: evaluation.triggerReason,
      plannedSteps: LP_SAGA_PLANS[sagaKind],
      protection,
    };
  }

  // NEW-sequence pre-authorization (module header): protect carries the
  // FINDINGS (s) carve-out; rotate/harvest run strict, so a paused agent gets
  // no new quota-bound work while its stop-loss still fires (Rev2 item 16).
  const authz = await authorizeExecute({
    agent: context.agent,
    killswitch: deps.killswitch,
    now: Math.floor(deps.now() / 1000),
    reducesExposure: sagaKind === "protect",
  });
  if (!authz.allowed) {
    const observationPersisted = await persistObservation(
      deps,
      state,
      position,
      portfolioObservation,
    );
    return {
      ...base,
      action: "skipped",
      decision,
      kind: sagaKind,
      reason: `${authz.code}: ${authz.reason}`,
      triggerReason: evaluation.triggerReason,
      observationPersisted,
      protection,
    };
  }

  let result: LpSagaRunResult;
  if (sagaKind === "rotate") {
    result = await runLpRotate(
      await buildRotateDeps(deps, context),
      position.positionId,
    );
  } else if (sagaKind === "harvest") {
    result = await runLpHarvest(buildSagaDeps(deps, context), position.positionId);
  } else if (sagaKind === "grid-flip") {
    result = await runLpGridFlip(
      await buildGridFlipDeps(deps, context),
      position.positionId,
    );
  } else if (sagaKind === "grid-requote") {
    // The trigger's own target, carried through on the RESULT (R2.3) and
    // persisted by `driveSequence`'s create. It is not re-derived here: this is
    // the one moment the drift evidence that authorized it is still in hand.
    result = await runLpGridRequote(
      await buildGridRequoteDeps(deps, context, evaluation.gridRequoteTarget),
      position.positionId,
    );
  } else if (sagaKind === "grid-recenter") {
    // PHASE3.19 C4: the trigger's own target, carried on the RESULT and
    // persisted by `driveSequence`'s create. It is not re-derived here — this is
    // the one moment the cross/drift evidence that authorized it is in hand.
    result = await runLpGridRecenter(
      await buildGridRecenterDeps(
        deps,
        context,
        evaluation.gridRecenterTarget,
        // PHASE3.20 item 7: the lane the trigger's own evidence decided, carried
        // on the RESULT and persisted by `driveSequence`'s create — this is the
        // one moment the cross/drift evidence that authorized it is in hand.
        evaluation.gridRecenterEvidence,
      ),
      position.positionId,
    );
  } else if (sagaKind === "grid-shift") {
    // PHASE3.22 R8: BOTH of the trigger's targets, carried on the RESULT and
    // persisted by `driveSequence`'s create. Neither is re-derived here — this
    // is the one moment the evidence that authorized them is in hand.
    result = await runLpGridShift(
      await buildGridShiftDeps(
        deps,
        context,
        evaluation.gridShiftTargets,
        evaluation.gridShiftCause,
      ),
      position.positionId,
    );
  } else {
    result = await runLpProtect(buildSagaDeps(deps, context), position.positionId);
  }
  // AFTER the dispatch has been acted on. A write that fails here leaves the
  // PREVIOUS observation in place, so the next cycle would recompute
  // `protectConsecutive` to 3 and still fire — harmless, because the position
  // is already `closed` (PHASE3.1 item 13 closes it at step 0's confirm, not at
  // `finish()`; PHASE3.1-AUDIT A12) and `listOpenPositionsForWorker` no longer
  // returns it. A dispatch whose step 0 was SKIPPED closes it too (audit A4).
  const observationPersisted = await persistObservation(
    deps,
    state,
    position,
    portfolioObservation,
  );
  return {
    ...base,
    action: "dispatched",
    decision,
    kind: sagaKind,
    reason: result.reason,
    triggerReason: evaluation.triggerReason,
    result,
    observationPersisted,
    protection,
  };
}

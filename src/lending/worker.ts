/**
 * The lending guard's worker — one cycle, per guard
 * (MARKETPLACE-LENDING-AGENT §5.1 as amended by R2.18, R2.21, R3.4, R3.5,
 * R3.7, R3.11, and §5.6's UNKNOWN posture).
 *
 * ═══ EXACTLY ONE LENDING WORKER PER DATABASE IS A MONEY INVARIANT ═════════
 *
 * Two workers racing one guard could each read a stale observation, each reach
 * two confirmations, and BOTH dispatch a rescue — bounded by the on-chain caps,
 * but a double spend of the owner's reserve out of one falling position. The
 * ENFORCEMENT is the agent-scoped advisory lock around read -> decide -> claim
 * plus the claim's own conditional CAS (R3.7); the one-worker sentence stays as
 * operational guidance and `scripts/lending-worker.ts` repeats it at the top of
 * its output.
 *
 * ═══ THE ORDER IS THE FAIL-CLOSED ORDER ══════════════════════════════════
 *
 *   0. FREEZE THE CLOCK. The first statement, before any read.
 *   1. Journal reconcile — LIVE cycles only (it calls the provider, and
 *      dry-run's contract is zero provider calls).
 *   2. Scan `arming | armed | held`. `arming` IS scanned: that is R3.4's door.
 *   3. Per guard: settings -> the `arming` door -> `authorizeExecute` (PAUSE
 *      STOPS THE GUARD) -> A's bounded read -> B's reserve -> the arm-unknown
 *      evidence rule -> the trigger -> the fence (read/decide/claim) -> the
 *      dry-run gate -> submit -> effect -> telemetry -> observation ->
 *      snapshot LAST.
 *
 * ═══ THE DRY-RUN GATE SITS AFTER THE DECISION AND BEFORE EVERY WRITE ══════
 *
 * On EVERY branch. A rehearsal reports what a live cycle WOULD record and
 * writes nothing — the PHASE3.4 fix ordering, which this repo paid for once
 * when two `--dry-run` cycles closed a position and zeroed its basis.
 */
import { randomUUID } from "node:crypto";
import { getAddress, type Address } from "viem";

import { sanitizeMessage } from "../core/errors.js";
import type { WalletProvider } from "../core/types.js";
import { authorizeExecute } from "../auth/executeDecision.js";
import { paramsHash } from "../auth/canonical.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { VenusSettingsStore } from "../store/venusSettings.js";
import type {
  VenusObservation,
  VenusObservationStore,
} from "../store/venusObservations.js";
import {
  LENDING_HOLD_CLEAR_CONFIRMATIONS,
  LENDING_QUOTA_WINDOW_MS,
  type LendingGuardRecord,
  type LendingGuardStore,
} from "../store/lendingGuards.js";
import {
  lendingMaxPerActionFor,
  parseLendingSettingsParams,
  type LendingSettings,
} from "../http/lendingWire.js";
import {
  LENDING_DUST_USDT_WEI,
  grantsLendingMarket,
  walletNativeFloorWei,
} from "../ops/policy.js";
import { sagaSwapMinOut } from "../lp/rails.js";
import { evaluateVenusTrigger } from "../venus/triggers.js";
import { sizeVenusRepay, type VenusSizingMarket } from "../venus/sizing.js";
import type { VenusAccountReading } from "../venus/types.js";
import {
  LendingAccountTooComplexError,
  type LendingChainReaders,
  type LendingVenue,
} from "./readers.js";
import {
  buildLendingNativeRescueBatch,
  buildLendingUsdtRescueBatch,
  type LendingVenueAddresses,
} from "./batches.js";
import {
  chooseLendingDebtMarket,
  clampBelowBorrow,
  lendingCapacity,
  lendingMinRepayFor,
  lendingTier,
  meterTerm,
  planNativeLegs,
  planUsdtLegs,
  poolPriceE18,
  swapInFor,
} from "./sizing.js";
import { lendingDecisionId, submitLendingBatch } from "./execute.js";
import {
  lendingCondition,
  lendingConditionFromVenus,
  type LendingCondition,
  type LendingConditionReport,
  type LendingReserveReading,
} from "./types.js";

const E18 = 10n ** 18n;
/** Deadline pad on every swap leg, in seconds. */
const LENDING_DEADLINE_SEC = 300n;

export type LendingWorkerDeps = {
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly killswitch: KillSwitch;
  readonly provider: WalletProvider;
  readonly guards: LendingGuardStore;
  readonly settingsStore: VenusSettingsStore;
  readonly observations: VenusObservationStore;
  readonly readers: LendingChainReaders;
  readonly venue: LendingVenue;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  readonly agentConcurrency: number;
  readonly maxSagaSlippageBps: number;
  /** Injected clock, ms. Frozen at cycle start and used for nothing else. */
  readonly now: () => number;
  readonly dryRun: boolean;
  /** Journal reconcile. Live cycles only — it calls the provider. */
  readonly reconcile?: () => Promise<void>;
  readonly log?: (outcome: LendingWorkerAgentOutcome) => void;
};

export type LendingWorkerAction =
  | "dispatched"
  | "hold"
  | "skipped"
  | "converged"
  | "dry-run"
  | "error";

export type LendingWorkerAgentOutcome = {
  readonly agentId: string;
  readonly action: LendingWorkerAction;
  /** Sanitized. Callers branch on `condition`, never on this text. */
  readonly reason: string;
  readonly condition?: LendingCondition;
  readonly market?: Address;
  readonly amountWei?: bigint;
  readonly healthFactor?: bigint | null;
  readonly consecutive?: number;
  readonly observationPersisted?: boolean;
  readonly snapshotPersisted?: boolean;
  readonly effect?: "changed" | "no-effect" | "unverified";
  readonly journalKey?: string;
};

export type LendingWorkerCycleReport = {
  readonly startedAtMs: number;
  readonly dryRun: boolean;
  readonly reconciled: boolean;
  readonly outcomes: readonly LendingWorkerAgentOutcome[];
};

/* -------------------------------------------------------------------------- */
/* One cycle                                                                  */
/* -------------------------------------------------------------------------- */

export async function runLendingWorkerOnce(
  deps: LendingWorkerDeps,
): Promise<LendingWorkerCycleReport> {
  // (0) FREEZE THE CYCLE CLOCK — the first statement, before any read.
  const cycleNowMs = deps.now();
  const outcomes: LendingWorkerAgentOutcome[] = [];
  const emit = (outcome: LendingWorkerAgentOutcome): void => {
    outcomes.push(outcome);
    deps.log?.(outcome);
  };

  let reconciled = false;
  if (!deps.dryRun && deps.reconcile !== undefined) {
    await deps.reconcile();
    reconciled = true;
  }

  const rows = await deps.guards.listForWorker();
  const queue = [...rows];
  const workers = Array.from(
    { length: Math.max(1, deps.agentConcurrency) },
    async () => {
      for (;;) {
        const row = queue.shift();
        if (row === undefined) return;
        try {
          emit(await evaluateGuard(deps, row, cycleNowMs));
        } catch (error) {
          // Per-agent isolation: one guard's thrown read must never skip the
          // next guard. The failure is reported, not swallowed.
          emit({
            agentId: row.agentId,
            action: "error",
            condition: "transport",
            reason: sanitizeMessage(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      }
    },
  );
  await Promise.all(workers);

  return { startedAtMs: cycleNowMs, dryRun: deps.dryRun, reconciled, outcomes };
}

/* -------------------------------------------------------------------------- */
/* One guard                                                                  */
/* -------------------------------------------------------------------------- */

async function evaluateGuard(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  cycleNowMs: number,
): Promise<LendingWorkerAgentOutcome> {
  const agent = await deps.agentStore.getAgent(guard.ownerAddress, guard.agentId);
  if (agent === null) {
    return {
      agentId: guard.agentId,
      action: "skipped",
      condition: "settings-absent",
      reason: "The guard row has no agent; nothing can be authorized.",
    };
  }

  /* ---- R3.4: the `arming` door ---------------------------------------- */
  if (guard.status === "arming") {
    return armingDoor(deps, guard, agent, cycleNowMs);
  }

  const settingsRow = await deps.settingsStore.get(guard.ownerAddress, guard.agentId);
  if (settingsRow === null) {
    return {
      agentId: guard.agentId,
      action: "skipped",
      condition: "settings-absent",
      reason: "No lending settings row; automation never runs unsigned.",
    };
  }
  const parsed = parseLendingSettingsParams(settingsRow.params);
  if (!parsed.ok) {
    return {
      agentId: guard.agentId,
      action: "skipped",
      condition: "settings-absent",
      reason: sanitizeMessage(`Stored lending settings are unreadable: ${parsed.message}`),
    };
  }
  const settings = parsed.value;
  const digest = paramsHash("lendingSettings", settingsRow.params);
  if (digest !== settingsRow.digest) {
    return {
      agentId: guard.agentId,
      action: "skipped",
      condition: "settings-absent",
      reason:
        "The stored settings digest does not recompute; automation never runs under "
        + "settings nobody provably signed.",
    };
  }

  /* ---- AUDIT B-H1: the `retiring` door --------------------------------- */
  //
  // A partial retire parks here, and before this the worker did not scan the
  // status at all: its view snapshot froze at whatever the last armed cycle
  // wrote, and the only exit was another owner signature. This door writes no
  // money — it keeps the snapshot alive and converges a reserve that is
  // demonstrably empty to `retired`, which is the exit `retiring` lacked.
  if (guard.status === "retiring") {
    return retiringDoor(deps, guard, agent, settings);
  }

  /* ---- PAUSE STOPS THE GUARD (Phase 4 D4, inherited) ------------------- */
  const decision = await authorizeExecute({
    agent,
    killswitch: deps.killswitch,
    now: Math.floor(cycleNowMs / 1000),
  });
  if (!decision.allowed) {
    return {
      agentId: guard.agentId,
      action: "hold",
      condition:
        decision.code === "NO_SESSION" || decision.code === "SESSION_EXPIRED"
          ? "session-expired-or-revoked"
          : "killswitch",
      reason: sanitizeMessage(`${decision.code}: ${decision.reason}`),
    };
  }

  /* ---- A, bounded (R3.11) --------------------------------------------- */
  let readingA: VenusAccountReading;
  try {
    readingA = await deps.readers.readAccount(
      guard.guardedAccount,
      guard.debtMarkets,
    );
  } catch (error) {
    if (error instanceof LendingAccountTooComplexError) {
      // A DISARM THE OWNER DID NOT CAUSE (R2.13's language, R3.11's case).
      if (deps.dryRun) {
        return {
          agentId: guard.agentId,
          action: "dry-run",
          condition: "account-too-complex",
          reason:
            `Would hold: ${sanitizeMessage(error.message)} Nothing was written.`,
        };
      }
      await holdGuard(deps, guard, "account-too-complex");
      return {
        agentId: guard.agentId,
        action: "hold",
        condition: "account-too-complex",
        reason: sanitizeMessage(
          `${error.message} Your account entered more markets than this guard can price; `
          + "the guard is paused until it can.",
        ),
      };
    }
    throw error;
  }

  /* ---- B's reserve, at its own pinned finalized block ------------------ */
  const reserve = await deps.readers.readReserve(agent.walletAddress);

  /* ---- AUDIT C-M1: a hold whose CONDITION no longer applies is CLEARED -- */
  //
  // `held` was sticky: nothing but the arming door's `armed` outcome ever
  // wrote `hold: null`, so an account that dropped back inside
  // `LENDING_MAX_MARKETS`, and an `arm-unknown` guard whose reserve now PROVES
  // the arm landed (R2.21's own evidence rule), both stayed `held` forever
  // with a stale condition on the owner's page. The fence admits `held`, so
  // the guard kept planning while the view called it paused — the worst of
  // both readings.
  //
  // Clearing is evidence-driven and narrow: A read cleanly THIS cycle (we are
  // past the `account-too-complex` catch), or the vUSDT delta R2.21 names.
  // `retire-unknown` is NOT cleared here: nothing in a reserve read tells us
  // what an ambiguous retire did, and v1 ships no resolver for it.
  let row = guard;
  const holdClearQualifies =
    row.status === "held"
    && (row.hold === "account-too-complex"
      || (row.hold === "arm-unknown" && reserve.vUsdtBalance > row.preArmVUsdtWei));
  // FIXREVIEW F5 — THE CLEAR TAKES TWO CONFIRMATIONS, ONE INTERVAL APART.
  //
  // P15 cleared on the FIRST cycle the condition stopped applying, with no
  // confirmation count on either edge — unlike every other durable decision
  // here, which takes two finalized observations one interval apart. A guarded
  // account hovering at the market bound (24/25) therefore wrote a status
  // change every cycle and flickered `held`/`armed` on the owner's page for as
  // long as it oscillated.
  //
  // The counter is DURABLE (`hold_clear_consecutive`) for the reason every
  // counter in this plane is: a per-process one resets on restart, and a
  // restart is exactly when a flapping guard gets observed once and believed.
  // The interval test is the PHASE3.2 rule — two `--once` runs back to back
  // must not manufacture a confirmation — and it reads the guard row's own
  // `updatedAtMs`, which the progress write itself moves.
  const holdClearIntervalPassed =
    row.holdClearConsecutive === 0
    || cycleNowMs - row.updatedAtMs >= deps.intervalMs;
  const holdClearConfirmations = !holdClearQualifies
    ? 0
    : holdClearIntervalPassed
      ? row.holdClearConsecutive + 1
      // A second look inside the same interval is the SAME observation. It
      // neither counts nor resets, and writes nothing.
      : row.holdClearConsecutive;
  const holdCleared =
    holdClearQualifies
    && holdClearConfirmations >= LENDING_HOLD_CLEAR_CONFIRMATIONS;
  const clearedNote =
    row.hold === "account-too-complex"
      ? "The guarded account is inside the market bound again; the hold is cleared and the "
        + "guard is armed."
      : "Wallet B now holds more vUSDT than it did before the arm, which proves the arm "
        + "landed (R2.21); the hold is cleared and the guard is armed. A second arm stays "
        + "blocked — renewal is retire + re-hire.";
  if (holdCleared && !deps.dryRun) {
    const cleared = await deps.guards.setHold({
      ownerAddress: row.ownerAddress,
      agentId: row.agentId,
      expectedRowVersion: row.rowVersion,
      hold: null,
      // FIXREVIEW F1 — THE CLEAR RECORDS `armBlock`, or the guard it just armed
      // can never be seen to have been recovered by its owner.
      //
      // `armBlock` had ONE writer (`finishArm` with `outcome: "armed"`), and an
      // `arm-unknown` guard is by construction one that never reached it: the
      // arm came back UNKNOWN, so the row was stored with `armBlock: null`.
      // Clearing that hold on R2.21's evidence produced an `armed` row with a
      // null block, and `detectOwnerRecovery` refuses on exactly that — so
      // §6.2's observation was unreachable for the population AUDIT C-M2 named,
      // on the narrower set P15 had just created a path into.
      //
      // The figure is the finalized block of the SAME reading that proved the
      // arm landed. It is not the block the arm landed in (F7's caveat, which
      // the route's own figure shares) — only its null/non-null distinction is
      // consumed — and the store writes it ONE WAY, never over an existing one.
      ...(row.armBlock === null
        ? {
            armBlock: reserve.blockNumber,
            // FIXREVIEW F7: this is a read taken AFTER the arm, not the arm's
            // own block, and the record now says so.
            armBlockSource: "post-arm-read" as const,
          }
        : {}),
    });
    if (cleared.kind === "ok") row = cleared.record;
  } else if (
    !deps.dryRun
    && row.status === "held"
    && holdClearConfirmations !== row.holdClearConsecutive
  ) {
    // FIXREVIEW F5: record the progress — or the RESET when the condition came
    // back — and leave the hold exactly where it is. This writes ONE column and
    // no status, so a guard halfway to a clear is still held in every sense
    // that matters: the view says held, the fence admits it, rescues continue.
    const noted = await deps.guards.noteHoldClearProgress({
      ownerAddress: row.ownerAddress,
      agentId: row.agentId,
      expectedRowVersion: row.rowVersion,
      consecutive: holdClearConfirmations,
    });
    if (noted.kind === "ok") row = noted.record;
  }

  /* ---- FIXREVIEW F3: `retire-unknown` is not a dead end ---------------- */
  //
  // `held` + `retire-unknown` had NO exit: the retire route refuses it by name,
  // the P15 clear deliberately does not touch it, `detectOwnerRecovery` wants
  // `armed`, and v1 ships no owner-signed resolver for a lending UNKNOWN. The
  // reserve was safe — a passkey recovers it at any time — but the row never
  // moved again while the page said "rescues continue".
  //
  // This is the evidence door, and it never guesses: the retire's OWN journal
  // row decides when it has been resolved, and a demonstrably empty reserve
  // decides when it has not. Anything else falls through to the cycle below,
  // which keeps rescuing exactly as it did.
  if (row.status === "held" && row.hold === "retire-unknown") {
    const resolved = await resolveRetireUnknown(deps, row, reserve);
    if (resolved !== null) return resolved;
  }

  /* ---- §6.2: the owner recovered the reserve with their passkey -------- */
  const recovered = await detectOwnerRecovery(deps, row, reserve);
  if (recovered) {
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        condition: "recovered-by-owner",
        reason:
          "Would close the guard: wallet B holds no vUSDT and no retire explains it, "
          + "so the reserve was recovered with the owner's passkey. Nothing was written.",
      };
    }
    await deps.guards.close({
      ownerAddress: row.ownerAddress,
      agentId: row.agentId,
      expectedRowVersion: row.rowVersion,
      closeReason: "recovered-by-owner",
    });
    return {
      agentId: guard.agentId,
      action: "converged",
      condition: "recovered-by-owner",
      reason:
        "Wallet B holds no vUSDT and no retire explains it; the reserve was recovered "
        + "with the owner's passkey and the guard is closed.",
    };
  }

  /* ---- R2.21: is the pending arm's claim still outstanding? ------------ */
  const armOutstanding =
    row.hold === "arm-unknown" && reserve.vUsdtBalance <= row.preArmVUsdtWei;
  const conditions: LendingConditionReport[] = [];
  if (holdCleared && deps.dryRun && guard.hold !== null) {
    // A REHEARSAL still reports it, under the hold's OWN condition name: the
    // taxonomy is closed and has no "hold-cleared" member, and naming a
    // condition something it is not is worse than saying nothing. A live cycle
    // reports the clearing by no longer carrying the condition at all.
    conditions.push(
      lendingCondition(
        guard.hold,
        `Would clear this hold: ${clearedNote} Nothing was written.`,
      ),
    );
  }
  if (row.hold === "arm-unknown" && !holdCleared) {
    conditions.push(
      lendingCondition(
        "arm-unknown",
        armOutstanding
          ? "The arm's submission was ambiguous and the reserve does not yet show it landed; "
            + "the BNB tier is reduced by the arm's own msg.value and a second arm is blocked."
          : "The arm's submission was ambiguous, but wallet B now holds more vUSDT than it did "
            + "before the arm, which proves it landed. The tier is normal; a second arm stays blocked.",
      ),
    );
  }
  if (row.hold === "retire-unknown") {
    conditions.push(
      lendingCondition(
        "retire-unknown",
        "The retire's submission was ambiguous. Retire is blocked; rescues continue on "
          + "whatever the reserve still holds.",
      ),
    );
  }

  /* ---- the durable hysteresis counter and the trigger ------------------ */
  const previous = await readObservation(deps, guard);
  const trigger = evaluateVenusTrigger({
    reading: readingA,
    triggerHf: settings.triggerHf,
    ...(settings.notifyOnlyBelowHf === undefined
      ? {}
      : { notifyOnlyBelowHf: settings.notifyOnlyBelowHf }),
    settingsDigest: digest,
    previous,
    cycleNowMs,
    intervalMs: deps.intervalMs,
    maxObservationAgeMs: deps.maxObservationAgeMs,
  });

  if (trigger.kind === "refuse") {
    const report = lendingConditionFromVenus(
      trigger.condition,
      trigger.detail,
      trigger.condition === "oracle-invalid" || trigger.condition === "protocol-mismatch"
        ? findOffendingMarket(readingA)
        : undefined,
    );
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        condition: report.condition,
        ...(report.market === undefined ? {} : { market: report.market }),
        reason: `Would hold: ${sanitizeMessage(report.detail)} Nothing was written.`,
      };
    }
    const snapshotPersisted = await writeSnapshot(deps, guard, agent, settings, {
      readingA, reserve, conditions: [...conditions, report], observation: null,
    });
    return {
      agentId: guard.agentId,
      action: "hold",
      condition: report.condition,
      ...(report.market === undefined ? {} : { market: report.market }),
      reason: sanitizeMessage(report.detail),
      healthFactor: trigger.view.pair.liquidationRisk.healthFactor,
      snapshotPersisted,
    };
  }

  if (trigger.kind === "hold") {
    const report = lendingConditionFromVenus(trigger.condition, trigger.detail);
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        condition: report.condition,
        reason: `Would record: ${sanitizeMessage(report.detail)} Nothing was written.`,
        healthFactor: trigger.observation.healthFactor,
        consecutive: trigger.observation.consecutive,
      };
    }
    const observationPersisted = await persistObservation(deps, guard, trigger.observation);
    const snapshotPersisted = await writeSnapshot(deps, guard, agent, settings, {
      readingA, reserve, conditions: [...conditions, report],
      observation: trigger.observation,
    });
    return {
      agentId: guard.agentId,
      action: "hold",
      condition: report.condition,
      reason: sanitizeMessage(report.detail),
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      observationPersisted,
      snapshotPersisted,
    };
  }

  /* ══ ACT ═══════════════════════════════════════════════════════════════ */

  // R3.7: the lock covers READ -> DECIDE -> CLAIM and is RELEASED before the
  // submit. Holding it across a relay submission would pin a pool connection
  // for tens of seconds, and the journal writes inside that window go through a
  // DIFFERENT connection — so an aborting fence would leave the row and the
  // on-chain submission standing while the claim did not.
  const planned = await deps.guards.withLendingFence(
    guard.ownerAddress,
    guard.agentId,
    async (fence) => {
      const fresh = await fence.get();
      if (fresh === null || (fresh.status !== "armed" && fresh.status !== "held")) {
        return { kind: "stale" as const };
      }
      const plan = await planRescue(deps, {
        agent, guard: fresh, settings, readingA, reserve,
        armOutstandingNativeWei: armOutstanding ? fresh.supplyNativeWei : 0n,
        cycleNowMs,
      });
      if (plan.kind !== "submit") return plan;
      // THE DRY-RUN GATE SITS BEFORE THE CLAIM, INSIDE THE FENCE.
      //
      // The claim WRITES: it moves `action_seq` and the cooldown stamp. A
      // rehearsal that claimed would therefore change durable state and — worse
      // — would silently consume the very cooldown a live cycle needs, so two
      // `--dry-run` runs could starve a real rescue. That is the PHASE3.4
      // defect (two rehearsals closed a position and zeroed its basis) in this
      // phase's shape, and it is why the gate is here rather than after the
      // fence returns.
      if (deps.dryRun) return { ...plan, kind: "rehearse" as const };
      // The CLAIM is the cooldown AND the sequence number.
      const claim = await fence.claim({
        nowMs: cycleNowMs,
        minSecondsBetweenActions: settings.minSecondsBetweenActions,
      });
      if (claim.kind !== "claimed") {
        return {
          kind: "hold" as const,
          condition: "cooldown" as LendingCondition,
          detail:
            claim.kind === "cooldown"
              ? `The last action was ${claim.elapsedSec}s ago, inside the `
                + `${settings.minSecondsBetweenActions}s floor.`
              : "The guard row vanished between the read and the claim.",
        };
      }
      return { ...plan, actionSeq: claim.actionSeq, guard: fresh };
    },
  );

  if (planned.kind === "stale") {
    return {
      agentId: guard.agentId,
      action: "skipped",
      condition: "transport",
      reason: "The guard left armed/held between the scan and the fence.",
    };
  }
  if (planned.kind === "hold") {
    const report = lendingConditionFromVenus(
      planned.condition as never,
      planned.detail,
      planned.market,
    );
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        condition: report.condition,
        reason: `Would hold: ${sanitizeMessage(report.detail)} Nothing was written.`,
        healthFactor: trigger.observation.healthFactor,
      };
    }
    const observationPersisted = await persistObservation(deps, guard, trigger.observation);
    // A-M4: the planner's own conditions ride along, so a hold does not erase
    // what the cycle had already established about the reserve.
    const carried = (planned.conditions ?? [])
      .filter((condition) => condition !== report.condition)
      .map((condition) =>
        lendingCondition(condition, "Established by this cycle's planning."));
    const snapshotPersisted = await writeSnapshot(deps, guard, agent, settings, {
      readingA, reserve, conditions: [...conditions, report, ...carried],
      observation: trigger.observation,
    });
    return {
      agentId: guard.agentId,
      action: "hold",
      condition: report.condition,
      reason: sanitizeMessage(report.detail),
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      observationPersisted,
      snapshotPersisted,
    };
  }

  // THE REHEARSAL. It reports what a live cycle WOULD record and has written
  // NOTHING — the gate that produced this branch sits inside the fence, ABOVE
  // the claim.
  if (planned.kind === "rehearse") {
    return {
      agentId: guard.agentId,
      action: "dry-run",
      market: planned.market,
      amountWei: planned.amountWei,
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      reason:
        `Would submit a repay of ${planned.amountWei} on ${planned.market} for `
        + `${guard.guardedAccount} (bound by ${planned.boundBy}`
        + `${planned.partial ? ", PARTIAL" : ""}), taking HF from `
        + `${planned.currentHf ?? "inf"} to ${planned.achievedHf ?? "inf"}. Nothing was executed.`,
    };
  }

  /* ---- submit, outside the fence -------------------------------------- */
  const decisionId = lendingDecisionId(guard.agentId, cycleNowMs, planned.actionSeq);

  // AUDIT C-H1 — A CYCLE THAT SUBMITS NOTHING GIVES ITS CLAIM BACK.
  //
  // The claim is the cooldown, and it is taken inside the fence ABOVE the
  // submit. A preflight refusal or a transport throw between the two therefore
  // used to leave `last_action_at_ms` stamped, so the NEXT cycle — the one
  // that might have worked — was refused `cooldown` for the whole
  // `minSecondsBetweenActions` floor, in exactly the crash this guard exists
  // for. `planned.guard` is the row read inside the fence, BEFORE the claim, so
  // its stamp is the one to put back.
  const previousLastActionAtMs = planned.guard.lastActionAtMs;
  const giveBack = async (): Promise<void> => {
    await deps.guards.restoreClaim({
      ownerAddress: guard.ownerAddress,
      agentId: guard.agentId,
      expectedActionSeq: planned.actionSeq,
      previousLastActionAtMs,
    });
  };

  let outcome: Awaited<ReturnType<typeof submitLendingBatch>>;
  try {
    outcome = await submitLendingBatch(
      { agentStore: deps.agentStore, journal: deps.journal, provider: deps.provider },
      {
        agent,
        decisionId,
        calls: planned.calls,
        nativeSpendWei: planned.nativeSpendWei,
      },
    );
  } catch (error) {
    // A throw here is a submission that provably did not happen through this
    // path's own classifier; the claim goes back before the failure is
    // reported by the cycle's per-agent isolation.
    await giveBack();
    throw error;
  }

  // NOTHING WAS SUBMITTED: no charged action row, no rescue row, no consumed
  // cooldown. A `relay-failed` outcome is NOT in this branch — it reached the
  // relay and drew gas, so it keeps its slot and is recorded below.
  if (outcome.status === "rolled-back" && outcome.code !== "relay-failed") {
    await giveBack();
    const observationPersisted = await persistObservation(deps, guard, trigger.observation);
    const report = lendingCondition(
      "transport",
      sanitizeMessage(
        `The rescue was refused before submitting (${outcome.code}); nothing was spent, `
        + "the cooldown was not consumed, and the next cycle re-plans.",
      ),
      planned.market,
    );
    const snapshotPersisted = await writeSnapshot(deps, guard, agent, settings, {
      readingA, reserve, conditions: [...conditions, report],
      observation: trigger.observation,
    });
    return {
      agentId: guard.agentId,
      action: "hold",
      condition: report.condition,
      market: planned.market,
      amountWei: planned.amountWei,
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      journalKey: outcome.journalKey,
      observationPersisted,
      snapshotPersisted,
      reason: report.detail,
    };
  }

  // The action row is charged for a submission that REACHED A RELAY — which is
  // what the 24 h count and the count-aware wallet floor are about (R2.8). A
  // refusal above the submit drew no relay gas and is not one.
  await deps.guards.chargeAction({
    ownerAddress: guard.ownerAddress,
    agentId: guard.agentId,
    actionId: `${guard.agentId}:${decisionId}`,
    kind: "rescue",
    chargedAtMs: cycleNowMs,
  });

  // EFFECT VERIFICATION IS AUTHORITATIVE OVER THE RECEIPT. The Compound
  // failOpaque pattern is live on these contracts, so a refused
  // `repayBorrowBehalf` CONFIRMS with zero effect.
  let effect: "changed" | "no-effect" | "unverified" = "unverified";
  if (outcome.status === "completed") {
    try {
      const after = await deps.readers.readAccount(
        guard.guardedAccount,
        guard.debtMarkets,
      );
      const market = after.markets.find(
        (entry) => entry.vToken.toLowerCase() === planned.market.toLowerCase(),
      );
      const borrowAfter = market?.borrowCurrent ?? market?.borrowStored ?? null;
      effect =
        borrowAfter === null
          ? "unverified"
          : borrowAfter < planned.borrowBeforeWei
            ? "changed"
            : "no-effect";
    } catch {
      // An unreadable effect is NOT a `no-effect` alarm: it is unverified, and
      // saying so is the difference between "the rescue did nothing" and "we
      // could not check".
      effect = "unverified";
    }
  }

  // AUDIT C-M3 — A RELAY-ANSWERED `FAILED` IS ALSO READ BACK.
  //
  // It used to record `unverified` with no post-read at all, which made R2.6's
  // `borrow-moved` condition — a FAILED submission whose post-read shows A's
  // debt BELOW the `r` we sized — unreachable in production. That condition is
  // the whole reason `r` is held 10 bps under `borrowCurrent`, so it must be
  // able to say so when the clamp was not enough.
  //
  // The effect stays inside the CLOSED `changed | no-effect | unverified` set
  // the owner view parses: the batch is atomic, so a FAILED changed nothing,
  // and `no-effect` is the true member for that. (A `"failed"` member would be
  // more precise and is left to the phase that can also widen the web parser,
  // which rejects an unknown effect outright.)
  const borrowMoved = { moved: false };
  if (outcome.status === "rolled-back" && outcome.code === "relay-failed") {
    try {
      const after = await deps.readers.readAccount(
        guard.guardedAccount,
        guard.debtMarkets,
      );
      const market = after.markets.find(
        (entry) => entry.vToken.toLowerCase() === planned.market.toLowerCase(),
      );
      const borrowAfter = market?.borrowCurrent ?? market?.borrowStored ?? null;
      if (borrowAfter !== null) {
        effect = "no-effect";
        borrowMoved.moved = borrowAfter < planned.amountWei;
      }
    } catch {
      effect = "unverified";
    }
  }

  const rescueConditions: LendingCondition[] = [
    ...planned.conditions,
    // C-L4: the row's CURRENT hold, so a rescue taken after the hold was
    // cleared this cycle does not carry a condition that no longer holds.
    ...(row.hold === "arm-unknown" ? (["arm-unknown"] as const) : []),
    ...(outcome.status === "held" ? (["unknown-held"] as const) : []),
    ...(effect === "no-effect" ? (["no-effect"] as const) : []),
    // R2.6's own condition, finally reachable (AUDIT C-M3): the submission was
    // answered FAILED and A's debt is now BELOW the amount we sized, which is
    // the downward move the 10-bps clamp exists for.
    ...(borrowMoved.moved ? (["borrow-moved"] as const) : []),
  ];
  await deps.guards.recordRescue({
    rescueId: randomUUID(),
    agentId: guard.agentId,
    ownerAddress: guard.ownerAddress,
    journalKey: outcome.journalKey,
    market: planned.market,
    amountWei: planned.amountWei,
    hfBefore: planned.currentHf,
    hfAfter: null,
    achievedHf: planned.achievedHf,
    txHash: outcome.txHash,
    effect,
    partial: planned.partial,
    conditions: rescueConditions,
  });

  const observationPersisted = await persistObservation(deps, guard, trigger.observation);
  const snapshotPersisted = await writeSnapshot(deps, guard, agent, settings, {
    readingA,
    reserve,
    conditions: [
      ...conditions,
      ...rescueConditions.map((condition) =>
        lendingCondition(condition, `Carried by the last rescue (${outcome.code}).`),
      ),
    ],
    observation: trigger.observation,
  });

  return {
    agentId: guard.agentId,
    action:
      outcome.status === "completed" && effect !== "no-effect" ? "dispatched" : "hold",
    ...(effect === "no-effect" ? { condition: "no-effect" as const } : {}),
    market: planned.market,
    amountWei: planned.amountWei,
    healthFactor: trigger.observation.healthFactor,
    consecutive: trigger.observation.consecutive,
    effect,
    journalKey: outcome.journalKey,
    observationPersisted,
    snapshotPersisted,
    reason:
      effect === "no-effect"
        ? "The receipt CONFIRMED and the on-chain effect is ZERO (the Compound failOpaque "
          + "pattern is live on these contracts). This is NOT a rescue: the hysteresis "
          + "counter is not reset, and the action row keeps its slot because the submission "
          + "drew relay gas."
        : sanitizeMessage(outcome.reason),
  };
}

/* -------------------------------------------------------------------------- */
/* R3.4 — the `arming` door                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Converge an `arming` row that never submitted.
 *
 * Between the fence transaction committing and `journal.begin` on the
 * `"lending"` row, a process death or a relay-connect timeout classified above
 * the submit leaves `status = 'arming'` with NO journal row at all — and the
 * arm's idle gate, the retire's gate and (before this) the worker's scan all
 * refuse it, with no owner-signed resolver in v1. That is the exact family this
 * repo has paid for three times: PHASE3.11's `active`+`none`, PHASE3.14's
 * stable-300 wedge, and the invariant they produced.
 *
 * The door is the cheapest correct one and the LP tree already uses it: no live
 * `"lending"` journal row for this agent and `updated_at` older than one
 * interval ⇒ `closed` with `arm-never-submitted`, WRITING NOTHING ELSE. Re-arm
 * then works, because `closed` is an accepted source for the arm CAS.
 */
async function armingDoor(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  agent: AgentRecord,
  cycleNowMs: number,
): Promise<LendingWorkerAgentOutcome> {
  if (cycleNowMs - guard.updatedAtMs < deps.intervalMs) {
    return {
      agentId: guard.agentId,
      action: "skipped",
      reason:
        "The arm is younger than one worker interval; the door waits so a live submission "
        + "is never closed out from under itself.",
    };
  }
  // The arm's OWN journal key is recorded on the row BEFORE the submit, so it
  // is the exact question to ask — not a scan for "any lending row", which
  // would also see a rescue from a previous life of this agent.
  const row =
    guard.armJournalKey === null
      ? null
      : await deps.journal.get(guard.armJournalKey);

  // Every state the row can be in has a destination. That is the whole of
  // R3.4: a status the enum carries and no surface accepts is the wedge this
  // repo has paid for three times.
  if (row !== null && (row.state === "PENDING" || row.state === "IN_PROGRESS")) {
    return {
      agentId: guard.agentId,
      action: "skipped",
      reason:
        "The arm's journal row is still in flight; the door never converges a live "
        + "submission out from under itself.",
    };
  }

  if (row !== null && row.state === "COMMITTED") {
    // The arm LANDED and the finish write was lost. Converging it to `armed` is
    // the honest answer — closing it as never-submitted would say nothing was
    // spent about a batch that confirmed.
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        reason:
          "Would converge the guard to armed: the arm's journal row is COMMITTED and the "
          + "finish write was lost. Nothing was written.",
      };
    }
    // AUDIT C-M2: the door records `armBlock` too. Without it a guard the door
    // converged could never be seen to have been recovered by its owner
    // (`detectOwnerRecovery` requires a non-null one), which is the state a
    // door-converged guard is MOST likely to reach — its owner already saw one
    // ambiguous arm.
    //
    // FIXREVIEW F7 — THE ARM'S OWN BLOCK FIRST, AND THE TWO ARE LABELLED APART.
    //
    // A COMMITTED journal row carries the arm's transaction hash, so the block
    // it landed in is READABLE here; the post-arm finalized read is normally
    // BEHIND it and proves only that the arm was observed. Both are recorded
    // under `armBlock`, and `armBlockSource` is what stops the next reader
    // comparing the weaker one to a chain height. An unreadable answer on
    // either path leaves the block null rather than blocking the convergence.
    const doorTxHash = row.externalRef.txHash ?? null;
    let armBlock: bigint | null = null;
    let armBlockSource: "receipt" | "post-arm-read" | undefined;
    if (doorTxHash !== null && deps.readers.readTransactionBlock !== undefined) {
      const landed = await deps.readers.readTransactionBlock(doorTxHash);
      if (landed !== null) {
        armBlock = landed;
        armBlockSource = "receipt";
      }
    }
    if (armBlock === null) {
      try {
        armBlock = (await deps.readers.readReserve(agent.walletAddress)).blockNumber;
        armBlockSource = "post-arm-read";
      } catch {
        armBlock = null;
        armBlockSource = undefined;
      }
    }
    const finished = await deps.guards.finishArm({
      ownerAddress: guard.ownerAddress,
      agentId: guard.agentId,
      expectedRowVersion: guard.rowVersion,
      outcome: "armed",
      armBlock,
      ...(armBlockSource === undefined ? {} : { armBlockSource }),
      armTxHash: doorTxHash,
    });
    return {
      agentId: guard.agentId,
      action: finished.kind === "ok" ? "converged" : "skipped",
      reason:
        finished.kind === "ok"
          ? "The arm's journal row is COMMITTED; the guard is armed and the next cycle "
            + "verifies the reserve by reading it."
          : "The guard row moved between the scan and the door; the next cycle re-reads it.",
    };
  }

  if (row !== null && row.state === "UNKNOWN") {
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        condition: "arm-unknown",
        reason:
          "Would hold the guard at arm-unknown: the arm's journal row is UNKNOWN. "
          + "Nothing was written.",
      };
    }
    const held = await deps.guards.finishArm({
      ownerAddress: guard.ownerAddress,
      agentId: guard.agentId,
      expectedRowVersion: guard.rowVersion,
      outcome: "held",
      hold: "arm-unknown",
    });
    return {
      agentId: guard.agentId,
      action: held.kind === "ok" ? "converged" : "skipped",
      condition: "arm-unknown",
      reason:
        "The arm's journal row is UNKNOWN; the guard is held. Rescues continue on what "
        + "wallet B demonstrably holds; a second arm never does.",
    };
  }

  // ABSENT or ROLLED_BACK: the submission provably never landed.
  if (deps.dryRun) {
    return {
      agentId: guard.agentId,
      action: "dry-run",
      condition: "arm-never-submitted",
      reason:
        "Would close the guard: the arm never submitted, or its row rolled back. "
        + "Re-arm by signing lendingArm again. Nothing was written.",
    };
  }
  const closed = await deps.guards.close({
    ownerAddress: guard.ownerAddress,
    agentId: guard.agentId,
    expectedRowVersion: guard.rowVersion,
    closeReason: row === null ? "arm-never-submitted" : "arm-rolled-back",
  });
  return {
    agentId: guard.agentId,
    action: closed.kind === "ok" ? "converged" : "skipped",
    condition: "arm-never-submitted",
    reason:
      closed.kind === "ok"
        ? "The arm never submitted, or its row rolled back; the guard is closed and "
          + "re-arming works. NOTHING WAS SPENT."
        : "The guard row moved between the scan and the door; the next cycle re-reads it.",
  };
}

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F3 — the `retire-unknown` door                                   */
/* -------------------------------------------------------------------------- */

/**
 * Give `held` + `retire-unknown` an exit, from evidence only.
 *
 * The pair was a dead end — the shape every wedge this repo has paid for has
 * had, and the shape the status-granularity reachability test cannot see. The
 * door has two independent sources of evidence and takes NEITHER on trust:
 *
 *   1. THE RETIRE'S OWN JOURNAL ROW. Nothing in this plane resolves a lending
 *      UNKNOWN automatically, but `reconcile` and a future owner-signed
 *      resolver both can, and once one has, the row says what happened:
 *      COMMITTED ⇒ the retire landed (fully, if the reserve is empty; partially
 *      otherwise, which is `retiring` and the door above finishes it);
 *      ROLLED_BACK ⇒ it spent nothing, so the guard goes back to `armed` with
 *      the AUDIT B-H1 reasoning, one status later.
 *      The key comes from the charged-row ledger, which recorded it verbatim.
 *   2. THE RESERVE. An UNKNOWN retire over a reserve that holds no vUSDT and
 *      less than dust in idle USDT evidently landed: the only other explanation
 *      is a passkey withdrawal, and the retire the owner signed is the nearer
 *      one. This is the honest fallback the fix review asked for, and it is
 *      deliberately NOT a second `lendingRetire` with `acceptPartial` — a
 *      retry against an ambiguous submission is a second submission.
 *
 * Everything else returns `null` and the cycle continues UNCHANGED: rescues go
 * on running against whatever the reserve still holds, which is the declared
 * v1 posture for this hold.
 *
 * `retired` is reached the way every `retired` in this store is reached —
 * `beginRetire` then `finishRetire` — so no new statement, and no new edge into
 * a terminal status, is invented for it.
 */
async function resolveRetireUnknown(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  reserve: LendingReserveReading,
): Promise<LendingWorkerAgentOutcome | null> {
  // Owner recovery uses redeemUnderlying and can leave interest dust. This
  // proves only that the reserve is economically empty, never tx inclusion.
  const currentRate = reserve.exchangeRateCurrent;
  const conservativeRate = currentRate !== null && currentRate > reserve.exchangeRateStored
    ? currentRate : reserve.exchangeRateStored;
  const belowDust = currentRate !== null && currentRate > 0n
    && reserve.vUsdtBalance >= 0n && reserve.usdtBalance >= 0n
    && (reserve.vUsdtBalance * conservativeRate) / E18 + reserve.usdtBalance < LENDING_DUST_USDT_WEI;
  const emptied =
    (reserve.vUsdtBalance === 0n && reserve.usdtBalance < LENDING_DUST_USDT_WEI) || belowDust;
  const retireKey = await deps.guards.lastActionId(
    guard.ownerAddress, guard.agentId, "retire",
  );
  const journalRow = retireKey === null ? null : await deps.journal.get(retireKey);
  const state = journalRow?.state ?? null;

  const disposition: "armed" | "retired" | "retiring" | null =
    state === "ROLLED_BACK"
      ? "armed"
      : state === "COMMITTED"
        ? (emptied ? "retired" : "retiring")
        : emptied
          ? "retired"
          : null;
  if (disposition === null) return null;

  const note =
    disposition === "armed"
      ? "The retire's journal row ROLLED BACK: it spent nothing, so the guard is armed again "
        + "and rescues resume under the settings it already carries."
      : disposition === "retired"
        ? state === "COMMITTED"
          ? "The retire's journal row COMMITTED and the reserve is empty; the guard is retired."
          : "The retire's outcome is still UNKNOWN, but the remaining supplied and idle "
            + "USDT reserve is below dust; the guard is retired. The journal remains unresolved."
        : "The retire's journal row COMMITTED and part of the reserve is still supplied; the "
          + "guard is retiring. Retire again to take what the pool can pay now.";

  if (deps.dryRun) {
    return {
      agentId: guard.agentId,
      action: "dry-run",
      condition: "retire-unknown",
      reason: `Would resolve the ambiguous retire: ${note} Nothing was written.`,
    };
  }

  if (disposition === "armed") {
    const cleared = await deps.guards.setHold({
      ownerAddress: guard.ownerAddress,
      agentId: guard.agentId,
      expectedRowVersion: guard.rowVersion,
      hold: null,
      // F1's rule on this path too: a guard that reaches `armed` here may never
      // have had a block recorded, and a null one disarms §6.2 forever. F7's
      // label rides with it — this is a post-arm read, not the arm's block.
      ...(guard.armBlock === null
        ? {
            armBlock: reserve.blockNumber,
            armBlockSource: "post-arm-read" as const,
          }
        : {}),
    });
    return {
      agentId: guard.agentId,
      action: cleared.kind === "ok" ? "converged" : "skipped",
      condition: "retire-unknown",
      reason:
        cleared.kind === "ok"
          ? sanitizeMessage(note)
          : "The guard row moved between the scan and the door; the next cycle re-reads it.",
    };
  }

  const began = await deps.guards.beginRetire({
    ownerAddress: guard.ownerAddress,
    agentId: guard.agentId,
    expectedRowVersion: guard.rowVersion,
  });
  if (began.kind !== "ok") {
    return {
      agentId: guard.agentId,
      action: "skipped",
      condition: "retire-unknown",
      reason: "The guard row moved between the scan and the door; the next cycle re-reads it.",
    };
  }
  if (disposition === "retiring") {
    return {
      agentId: guard.agentId,
      action: "converged",
      condition: "retire-unknown",
      reason: sanitizeMessage(note),
    };
  }
  const finished = await deps.guards.finishRetire({
    ownerAddress: guard.ownerAddress,
    agentId: guard.agentId,
    expectedRowVersion: began.record.rowVersion,
    outcome: "retired",
  });
  return {
    agentId: guard.agentId,
    action: finished.kind === "ok" ? "converged" : "skipped",
    condition: "retire-unknown",
    reason:
      finished.kind === "ok"
        ? sanitizeMessage(note)
        : "The guard row moved between the scan and the door; the next cycle re-reads it.",
  };
}

/* -------------------------------------------------------------------------- */
/* AUDIT B-H1 — the `retiring` door                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keep a retiring guard's view alive, and converge an emptied reserve.
 *
 * A `retiring` row is a row whose owner has asked for their money back and got
 * part of it: `pool-cash-short` parks here with "retire again when the pool
 * refills". Nothing here submits, claims or plans — a retiring guard never
 * rescues — so the cycle is two reads and a snapshot.
 *
 * The ONE state change is the convergence: when B holds no vUSDT and less than
 * dust in idle USDT, the reserve is gone and the retire that emptied it is the
 * explanation on hand, so the row becomes `retired`. It is deliberately NOT
 * reported as `recovered-by-owner`: that reason names a passkey withdrawal the
 * plane did not make, and a retiring row has a nearer explanation for the same
 * observation. Guessing the more dramatic of two explanations is how a view
 * comes to say something the plane cannot support.
 */
async function retiringDoor(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  agent: AgentRecord,
  settings: LendingSettings,
): Promise<LendingWorkerAgentOutcome> {
  let readingA: VenusAccountReading;
  try {
    readingA = await deps.readers.readAccount(guard.guardedAccount, guard.debtMarkets);
  } catch (error) {
    if (error instanceof LendingAccountTooComplexError) {
      return {
        agentId: guard.agentId,
        action: "skipped",
        condition: "account-too-complex",
        reason: sanitizeMessage(
          `${error.message} The guard is retiring; nothing acts on it either way.`,
        ),
      };
    }
    throw error;
  }
  const reserve = await deps.readers.readReserve(agent.walletAddress);
  const emptied =
    reserve.vUsdtBalance === 0n && reserve.usdtBalance < LENDING_DUST_USDT_WEI;

  if (emptied) {
    if (deps.dryRun) {
      return {
        agentId: guard.agentId,
        action: "dry-run",
        reason:
          "Would converge the guard to retired: wallet B holds no vUSDT and no idle USDT "
          + "above dust, so the retire took the reserve back. Nothing was written.",
      };
    }
    const finished = await deps.guards.finishRetire({
      ownerAddress: guard.ownerAddress,
      agentId: guard.agentId,
      expectedRowVersion: guard.rowVersion,
      outcome: "retired",
    });
    return {
      agentId: guard.agentId,
      action: finished.kind === "ok" ? "converged" : "skipped",
      reason:
        finished.kind === "ok"
          ? "The reserve is empty; the retire is complete and the guard is retired."
          : "The guard row moved between the scan and the door; the next cycle re-reads it.",
    };
  }

  const report = lendingCondition(
    "pool-cash-short",
    "This guard is retiring and part of the reserve is still supplied on Venus. Retire "
      + "again to take what the pool can pay now; nothing is rescued while it retires.",
  );
  if (deps.dryRun) {
    return {
      agentId: guard.agentId,
      action: "dry-run",
      condition: report.condition,
      reason: `Would record: ${report.detail} Nothing was written.`,
    };
  }
  const snapshotPersisted = await writeSnapshot(deps, guard, agent, settings, {
    readingA, reserve, conditions: [report], observation: null,
  });
  return {
    agentId: guard.agentId,
    action: "hold",
    condition: report.condition,
    reason: report.detail,
    snapshotPersisted,
  };
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

type DecidedPlan = {
  readonly market: Address;
  readonly amountWei: bigint;
  readonly borrowBeforeWei: bigint;
  readonly nativeSpendWei: bigint;
  readonly calls: readonly import("../core/types.js").WalletCall[];
  readonly partial: boolean;
  readonly boundBy: string;
  readonly currentHf: bigint | null;
  readonly achievedHf: bigint | null;
  readonly conditions: readonly LendingCondition[];
  readonly actionSeq: number;
  readonly guard: LendingGuardRecord;
};

type PlanResult =
  | { readonly kind: "stale" }
  | {
      readonly kind: "hold";
      readonly condition: LendingCondition;
      readonly detail: string;
      readonly market?: Address;
      /**
       * What the planner had already established when it decided to hold
       * (AUDIT A-M4). Without this the owner view lost `pool-cash-low`,
       * `cap-unreadable`, `unsupported-debt` and the rest every time a cycle
       * ended in a hold — which is most cycles that have anything to say.
       */
      readonly conditions?: readonly LendingCondition[];
    }
  /** The dry-run branch: a decided plan that was never claimed or submitted. */
  | (DecidedPlan & { readonly kind: "rehearse" })
  | (DecidedPlan & { readonly kind: "submit" });

async function planRescue(
  deps: LendingWorkerDeps,
  input: {
    readonly agent: AgentRecord;
    readonly guard: LendingGuardRecord;
    readonly settings: LendingSettings;
    readonly readingA: VenusAccountReading;
    readonly reserve: LendingReserveReading;
    readonly armOutstandingNativeWei: bigint;
    readonly cycleNowMs: number;
  },
): Promise<PlanResult> {
  const { guard, settings, readingA, reserve } = input;
  const conditions: LendingCondition[] = [];

  const usage = await deps.guards.usageSince(
    guard.ownerAddress,
    guard.agentId,
    input.cycleNowMs - LENDING_QUOTA_WINDOW_MS,
  );
  const tier = lendingTier({
    nativeBalanceWei: reserve.nativeBalance,
    rescueReserveCount: settings.rescueReserveCount,
    rescuesChargedInWindow: usage.rescues,
    outstandingArmNativeWei: input.armOutstandingNativeWei,
  });

  // ONE quote per direction per cycle, used both for the capacity figures and
  // as the solver's fallback. A quote that throws leaves the term at `0n`,
  // which makes the capacity SMALLER — the safe direction.
  const slip = deps.maxSagaSlippageBps;
  const tierToUsdtWei = await quietQuote(deps, {
    tokenIn: deps.venue.wbnb, tokenOut: deps.venue.usdt, amountInWei: tier.tierBnbWei, slip,
  });
  const usdtSide = reserve.usdtBalance
    + minBig(
        (reserve.vUsdtBalance * reserve.exchangeRateStored) / E18,
        reserve.cash > 0n ? reserve.cash - 1n : 0n,
      );
  const usdtToNativeWei = await quietQuote(deps, {
    tokenIn: deps.venue.usdt, tokenOut: deps.venue.wbnb, amountInWei: usdtSide, slip,
  });
  const capacity = lendingCapacity({
    reading: reserve, tier, slippageBps: slip, tierToUsdtWei, usdtToNativeWei,
  });
  if (capacity.poolCashLow) {
    conditions.push("pool-cash-low");
  }

  /* ---- choose the market --------------------------------------------- */
  const candidates = guard.debtMarkets
    .map((vToken) => {
      const market = readingA.markets.find(
        (entry) => entry.vToken.toLowerCase() === vToken.toLowerCase(),
      );
      if (market === undefined) return null;
      const borrow = market.borrowCurrent ?? market.borrowStored;
      return {
        vToken: market.vToken,
        native: market.native,
        borrowCurrentWei: borrow,
        debtValueWei: (borrow * market.boundedDebtPrice) / E18,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const chosen = chooseLendingDebtMarket(candidates);
  if (chosen === null) {
    return {
      kind: "hold",
      condition: "guarded-no-debt",
      detail:
        `Every pinned market for ${guard.guardedAccount} is at or below the dust floor; `
        + "there is nothing worth a relay fee to repay.",
    };
  }
  const marketReading = readingA.markets.find(
    (entry) => entry.vToken.toLowerCase() === chosen.vToken.toLowerCase(),
  );
  if (marketReading === undefined) return { kind: "stale" };

  // A's UNSUPPORTED debt, surfaced but never a refusal (§0.8).
  const unsupported = readingA.markets.filter(
    (entry) =>
      (entry.borrowCurrent ?? entry.borrowStored) > 0n
      && !guard.debtMarkets.some(
        (pinned) => pinned.toLowerCase() === entry.vToken.toLowerCase(),
      ),
  );
  if (unsupported.length > 0) conditions.push("unsupported-debt");

  const spec = input.agent.sessionFacts?.spec ?? null;
  if (spec === null || !grantsLendingMarket(spec, chosen.vToken, "repay-behalf")) {
    return {
      kind: "hold",
      condition: "market-not-in-grant",
      detail: "The session grant does not name this market's repayBorrowBehalf selector.",
      market: chosen.vToken,
      conditions,
    };
  }
  if (!marketReading.listed || marketReading.repayPaused || readingA.protocolPaused) {
    return {
      kind: "hold",
      condition: readingA.protocolPaused
        ? "protocol-paused"
        : marketReading.repayPaused
          ? "action-paused"
          : "market-delisted",
      detail: "Refused before submitting; the protocol would answer failOpaque.",
      market: chosen.vToken,
      conditions,
    };
  }

  /* ---- the meter term (R3.5) ------------------------------------------ */
  const meterToken = chosen.native ? null : deps.venue.usdt;
  const meter = await deps.readers.readTokenDayMeter({
    walletAddress: input.agent.walletAddress,
    publicKey: input.agent.sessionFacts!.publicKey,
    token: meterToken,
  });
  const term = meterTerm(meter, chosen.native);
  if (term.condition !== null) conditions.push(term.condition);

  // AUDIT A-M4: a SPENT cap short-circuits into its own named hold WITH the
  // figures. It used to fall through into `sizeVenusRepay`, which answers a
  // zero `capRemaining` with `insufficient-wallet-balance`, which this worker
  // then mapped to `reserve-low` — three renamings between the on-chain fact
  // and the owner, ending on a condition whose remedy (add reserve) is not the
  // one that helps (wait for the day to roll, or re-hire with a wider cap).
  if (term.capRemainingWei === 0n) {
    return {
      kind: "hold",
      condition: term.condition ?? (chosen.native ? "native-cap-exhausted" : "usdt-cap-exhausted"),
      detail:
        term.detail
        ?? "The session's rolling-day cap for this leg is spent; the chain would refuse the spend.",
      market: chosen.vToken,
      conditions,
    };
  }

  /* ---- size, through Phase 4's own repay form ------------------------- */
  const capacityWei = chosen.native
    ? capacity.nativeCapacityWei
    : capacity.usdtCapacityWei;
  if (capacityWei <= 0n) {
    return {
      kind: "hold",
      condition: "reserve-depleted",
      detail:
        "The reserve has no capacity left on this leg: nothing idle, nothing redeemable, "
        + "and no tier to swap from.",
      market: chosen.vToken,
      conditions,
    };
  }
  const markets = buildLendingSizingMarkets({
    readingA,
    settings,
    venue: deps.venue,
    chosen: chosen.vToken,
    reserveCapacityWei: capacityWei,
    capRemainingWei: term.capRemainingWei,
    reserve,
  });
  const market = markets.find(
    (entry) => entry.vToken.toLowerCase() === chosen.vToken.toLowerCase(),
  );
  if (market === undefined) return { kind: "stale" };

  const sized = sizeVenusRepay(markets, market, {
    basis: "liquidation",
    targetHf: settings.targetHf,
    vaiDebt: readingA.vaiDebt,
    protocolPaused: readingA.protocolPaused,
    // R3.6: applied ONCE, inside `tierBnb`. Zero here so it is never doubled.
    walletNativeFloorWei: 0n,
    hasNativeGrant: spec.spendCaps.some((cap) => cap.token === undefined),
  });
  if ("refused" in sized) {
    return {
      kind: "hold",
      condition: sized.refused === "hf-above-trigger" ? "hf-above-trigger" : "reserve-low",
      detail: sized.detail,
      market: chosen.vToken,
      conditions,
    };
  }
  if (sized.partial) conditions.push("insufficient-reserve");
  if (sized.boundBy === "reserve-capacity") conditions.push("reserve-low");
  if (sized.boundBy === "on-chain-cap") {
    conditions.push(chosen.native ? "native-cap-exhausted" : "usdt-cap-exhausted");
  }

  /* ---- R2.6: hold `r` strictly below A's live borrow ------------------ */
  const clamp = clampBelowBorrow(
    sized.amountWei,
    chosen.borrowCurrentWei,
    lendingMinRepayFor(chosen.native),
  );
  if (clamp.amountWei <= 0n) {
    return {
      kind: "hold",
      condition: "guarded-no-debt",
      detail:
        `The debt on ${chosen.vToken} is at or below the dust floor; the 10-bps overpay `
        + "clamp would size a zero repay.",
      market: chosen.vToken,
      conditions,
    };
  }
  const amountWei = clamp.amountWei;

  /* ---- compose the batch ---------------------------------------------- */
  const deadline = BigInt(Math.floor(input.cycleNowMs / 1000)) + LENDING_DEADLINE_SEC;
  const venue: LendingVenueAddresses = {
    vUsdt: deps.venue.vUsdt,
    usdt: deps.venue.usdt,
    vBnb: deps.venue.vBnb,
    routerV3: deps.venue.routerV3,
    wbnb: deps.venue.wbnb,
    swapFeeTier: deps.venue.swapFeeTier,
  };

  if (!chosen.native) {
    const legs = planUsdtLegs(amountWei, capacity);
    let swapInNativeWei = 0n;
    let swapMinOutWei = 0n;
    if (legs.takeSwapWei > 0n) {
      const solved = await swapInFor({
        needWei: legs.takeSwapWei,
        availableWei: tier.tierBnbWei,
        slippageBps: slip,
        // A-H1: the SEED carries the pool's own fee, or it misses every time.
        poolFeePpm: deps.venue.swapFeeTier,
        seedPriceE18:
          reserve.poolSqrtPriceX96 === null
            ? null
            : poolPriceE18(reserve.poolSqrtPriceX96, reserve.poolWbnbIsToken0),
        quote: (amountInWei) =>
          deps.readers.quote({
            tokenIn: deps.venue.wbnb, tokenOut: deps.venue.usdt, amountInWei,
          }),
      });
      if (solved.amountInWei <= 0n) {
        return {
          kind: "hold",
          condition: "reserve-low",
          detail:
            "The pool cannot honour the redeem and the BNB tier cannot buy the difference; "
            + "the next cycle re-plans against fresh cash.",
          market: chosen.vToken,
          conditions,
        };
      }
      swapInNativeWei = solved.amountInWei;
      swapMinOutWei = solved.clamped ? solved.minOutWei : legs.takeSwapWei;
      if (solved.clamped) conditions.push("reserve-low");
    }
    // AUDIT A-L1: a CLAMPED solver delivers less USDT than `takeSwap`, so a
    // repay still sized at `amountWei` would revert on the short `transferFrom`
    // and lose the whole batch to a FAILED — the native path already re-sized
    // for exactly this and the USDT path did not. A smaller rescue always beats
    // a reverting one.
    const payableWei =
      legs.takeSwapWei > 0n && swapMinOutWei < legs.takeSwapWei
        ? legs.takeIdleWei + legs.takeRedeemWei + swapMinOutWei
        : amountWei;
    const repayWei = payableWei < amountWei ? payableWei : amountWei;
    if (repayWei <= 0n) {
      return {
        kind: "hold",
        condition: "reserve-depleted",
        detail: "The reserve cannot fund any part of this repay.",
        market: chosen.vToken,
        conditions,
      };
    }
    const calls = buildLendingUsdtRescueBatch({
      venue,
      wallet: input.agent.walletAddress,
      borrower: guard.guardedAccount,
      amountWei: repayWei,
      takeRedeemWei: legs.takeRedeemWei,
      takeSwapWei: legs.takeSwapWei,
      swapInNativeWei,
      swapMinOutWei,
      currentVUsdtAllowanceWei: reserve.usdtAllowanceToVUsdt,
      deadline,
    });
    return {
      kind: "submit",
      market: chosen.vToken,
      amountWei: repayWei,
      borrowBeforeWei: chosen.borrowCurrentWei,
      // The fallback buy attaches `value` (`buildPancakeV3Buy`), which is
      // exactly the term R3.2 made unconditional.
      nativeSpendWei: swapInNativeWei,
      calls,
      partial: sized.partial || clamp.clamped || repayWei < amountWei,
      boundBy: sized.boundBy,
      currentHf: sized.currentHf,
      achievedHf: sized.achievedHf,
      conditions,
      actionSeq: 0,
      guard,
    };
  }

  const legs = planNativeLegs(amountWei, tier);
  let swapInUsdtWei = 0n;
  let redeemUsdtWei = 0n;
  let swapMinOutWei = 0n;
  if (legs.takeSwapOutWei > 0n) {
    const solved = await swapInFor({
      needWei: legs.takeSwapOutWei,
      availableWei: capacity.idleUsdtWei + capacity.redeemableUsdtWei,
      slippageBps: slip,
      poolFeePpm: deps.venue.swapFeeTier,
      seedPriceE18:
        reserve.poolSqrtPriceX96 === null
          ? null
          : poolPriceE18(reserve.poolSqrtPriceX96, !reserve.poolWbnbIsToken0),
      quote: (amountInWei) =>
        deps.readers.quote({
          tokenIn: deps.venue.usdt, tokenOut: deps.venue.wbnb, amountInWei,
        }),
    });
    if (solved.amountInWei <= 0n) {
      return {
        kind: "hold",
        condition: "reserve-low",
        detail:
          "The BNB tier is short and the USDT side cannot cover the difference; the next "
          + "cycle re-plans.",
        market: chosen.vToken,
        conditions,
      };
    }
    swapInUsdtWei = solved.amountInWei;
    swapMinOutWei = solved.clamped ? solved.minOutWei : legs.takeSwapOutWei;
    redeemUsdtWei =
      swapInUsdtWei > capacity.idleUsdtWei ? swapInUsdtWei - capacity.idleUsdtWei : 0n;
    if (solved.clamped) {
      conditions.push("reserve-low");
      // A clamped swap delivers less than `takeSwapOut`, so `value: r` would be
      // unfundable. Re-size the repay DOWN to what the batch can actually pay:
      // a smaller rescue always beats a reverting one.
      const payable = legs.takeTierWei + swapMinOutWei;
      if (payable < amountWei) {
        return planNativeSubmit({
          deps, input, venue, chosen, capacity, tier, conditions, sized,
          amountWei: payable, redeemUsdtWei, swapInUsdtWei, swapMinOutWei, deadline,
          guard, partial: true,
        });
      }
    }
  }
  return planNativeSubmit({
    deps, input, venue, chosen, capacity, tier, conditions, sized,
    amountWei, redeemUsdtWei, swapInUsdtWei, swapMinOutWei, deadline, guard,
    partial: sized.partial || clamp.clamped,
  });
}

function planNativeSubmit(args: {
  readonly deps: LendingWorkerDeps;
  readonly input: { readonly agent: AgentRecord };
  readonly venue: LendingVenueAddresses;
  readonly chosen: { readonly vToken: Address; readonly borrowCurrentWei: bigint };
  readonly capacity: ReturnType<typeof lendingCapacity>;
  readonly tier: ReturnType<typeof lendingTier>;
  readonly conditions: LendingCondition[];
  readonly sized: { readonly boundBy: string; readonly currentHf: bigint | null; readonly achievedHf: bigint | null };
  readonly amountWei: bigint;
  readonly redeemUsdtWei: bigint;
  readonly swapInUsdtWei: bigint;
  readonly swapMinOutWei: bigint;
  readonly deadline: bigint;
  readonly guard: LendingGuardRecord;
  readonly partial: boolean;
}): PlanResult {
  if (args.amountWei <= 0n) {
    return {
      kind: "hold",
      condition: "reserve-depleted",
      detail: "The reserve cannot fund any part of this repay.",
      market: args.chosen.vToken,
    };
  }
  const calls = buildLendingNativeRescueBatch({
    venue: args.venue,
    wallet: args.input.agent.walletAddress,
    borrower: args.guard.guardedAccount,
    amountWei: args.amountWei,
    redeemUsdtWei: args.redeemUsdtWei,
    swapInUsdtWei: args.swapInUsdtWei,
    swapMinOutWei: args.swapMinOutWei,
    deadline: args.deadline,
  });
  return {
    kind: "submit",
    market: args.chosen.vToken,
    amountWei: args.amountWei,
    borrowBeforeWei: args.chosen.borrowCurrentWei,
    // `value: r` on the vBNB call — the OTHER half of R3.2's unconditional term.
    nativeSpendWei: args.amountWei,
    calls,
    partial: args.partial,
    boundBy: args.sized.boundBy,
    currentHf: args.sized.currentHf,
    achievedHf: args.sized.achievedHf,
    conditions: args.conditions,
    actionSeq: 0,
    guard: args.guard,
  };
}

/**
 * Build the sizing markets from A's reading, with B's figures OVERWRITTEN on the
 * chosen market (R2.12).
 *
 * A's `walletBalance`, `allowance` and `capRemainingWei` are DISCARDED and
 * never read: they describe the guarded account, which funds nothing here. The
 * quantity that funds a repay is B's computed `reserveCapacityWei`.
 */
export function buildLendingSizingMarkets(input: {
  readonly readingA: VenusAccountReading;
  readonly settings: LendingSettings;
  readonly venue: LendingVenue;
  readonly chosen: Address;
  readonly reserveCapacityWei: bigint;
  readonly capRemainingWei: bigint | null;
  readonly reserve: LendingReserveReading;
}): VenusSizingMarket[] {
  return input.readingA.markets.map((market) => {
    const isChosen = market.vToken.toLowerCase() === input.chosen.toLowerCase();
    const token = market.native ? null : market.underlying;
    return {
      vToken: market.vToken,
      underlying: market.underlying,
      native: market.native,
      listed: market.listed,
      borrowAllowed: market.borrowAllowed,
      mintPaused: market.mintPaused,
      repayPaused: market.repayPaused,
      supplyHeadroom: market.supplyHeadroom,
      borrowCurrent: market.borrowCurrent ?? market.borrowStored,
      // B's ACTUAL balance of the underlying — reported, never the clamp
      // (R3.6). For USDT that is idle reserve; for BNB it is the raw balance
      // before the count-aware floor, which lives inside the capacity.
      walletBalance: market.native
        ? input.reserve.nativeBalance
        : input.reserve.usdtBalance,
      allowance: market.native ? 0n : input.reserve.usdtAllowanceToVUsdt,
      maxPerActionWei: lendingMaxPerActionFor(
        input.settings,
        market.native ? null : token,
      ),
      capRemainingWei: isChosen ? input.capRemainingWei : null,
      ...(isChosen ? { reserveCapacityWei: input.reserveCapacityWei } : {}),
      inGrant: true,
      inDebtSettings: true,
      inCollateralSettings: false,
      collateralMember: market.collateralMember,
      vTokenBalance: market.vTokenBalance,
      exchangeRate: market.exchangeRateCurrent ?? market.exchangeRateStored,
      borrowBalance: market.borrowCurrent ?? market.borrowStored,
      collateralFactor: market.effectiveCf,
      liquidationThreshold: market.effectiveLt,
      collateralPrice: market.boundedCollateralPrice,
      debtPrice: market.boundedDebtPrice,
      spotPrice: market.spotPrice,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function minBig(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

/** A quote whose failure is `0n`, which shrinks the capacity — the safe way. */
async function quietQuote(
  deps: LendingWorkerDeps,
  input: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountInWei: bigint;
    readonly slip: number;
  },
): Promise<bigint> {
  if (input.amountInWei <= 0n) return 0n;
  try {
    const quoted = await deps.readers.quote({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountInWei: input.amountInWei,
    });
    if (quoted <= 0n) return 0n;
    return sagaSwapMinOut(quoted, input.slip);
  } catch {
    return 0n;
  }
}

function findOffendingMarket(reading: VenusAccountReading): Address | undefined {
  // R2.13: the condition NAMES the market so the owner can see which one their
  // account entered that the guard cannot price.
  const zeroPriced = reading.markets.find(
    (market) =>
      market.spotPrice === 0n
      || market.boundedCollateralPrice === 0n
      || market.boundedDebtPrice === 0n,
  );
  return zeroPriced?.vToken;
}

async function readObservation(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
): Promise<VenusObservation | null> {
  try {
    return await deps.observations.get(guard.ownerAddress, guard.agentId, "rescue");
  } catch {
    return null;
  }
}

async function persistObservation(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  observation: VenusObservation,
): Promise<boolean> {
  try {
    await deps.observations.put({
      ownerAddress: guard.ownerAddress,
      agentId: guard.agentId,
      kind: "rescue",
      observation,
    });
    return true;
  } catch {
    return false;
  }
}

async function holdGuard(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  hold: "arm-unknown" | "retire-unknown" | "account-too-complex",
): Promise<void> {
  if (guard.hold === hold) {
    // FIXREVIEW F5 — THE SAME HOLD, RE-OBSERVED, IS A RESET.
    //
    // `setHold` resets the confirmation counter, but this early return skips it
    // — and it is the branch an OSCILLATING account takes: 25 markets, 24, 25,
    // 24. Without the reset the two clean cycles either side of a failing one
    // are counted as consecutive, which is the flap the fix was about, one
    // cycle slower. The write is the counter and nothing else.
    if (guard.holdClearConsecutive !== 0) {
      await deps.guards.noteHoldClearProgress({
        ownerAddress: guard.ownerAddress,
        agentId: guard.agentId,
        expectedRowVersion: guard.rowVersion,
        consecutive: 0,
      });
    }
    return;
  }
  await deps.guards.setHold({
    ownerAddress: guard.ownerAddress,
    agentId: guard.agentId,
    expectedRowVersion: guard.rowVersion,
    hold,
  });
}

/**
 * §6.2: the plane learns of a passkey recovery by OBSERVATION, never by a
 * message.
 *
 * The predicate is deliberately narrow. `vUsdtBalance == 0` alone is also true
 * of an arm that never landed, so this fires only for a guard whose arm
 * CONFIRMED (`armBlock !== null`), whose idle USDT is below dust, and which has
 * no live `"lending"` journal row that could explain the balance.
 */
async function detectOwnerRecovery(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  reserve: LendingReserveReading,
): Promise<boolean> {
  if (guard.status !== "armed") return false;
  if (guard.armBlock === null) return false;
  if (reserve.vUsdtBalance > 0n) return false;
  if (reserve.usdtBalance >= LENDING_DUST_USDT_WEI) return false;
  const unknown = await deps.journal.listUnknownForAgent(guard.agentId);
  return !unknown.some((row) => row.kind === "lending");
}

/**
 * The view snapshot — written LAST, and a failure is LOGGED AND SWALLOWED.
 *
 * OQ8's second condition: a presentation write must never abort a cycle that
 * has already submitted money, and it must never share a row with the
 * hysteresis counter the trigger reads (the PHASE3.6 M4/M5 digest hazard).
 */
async function writeSnapshot(
  deps: LendingWorkerDeps,
  guard: LendingGuardRecord,
  agent: AgentRecord,
  settings: LendingSettings,
  input: {
    readonly readingA: VenusAccountReading;
    readonly reserve: LendingReserveReading;
    readonly conditions: readonly LendingConditionReport[];
    readonly observation: VenusObservation | null;
  },
): Promise<boolean> {
  try {
    const usage = await deps.guards.usageSince(
      guard.ownerAddress,
      guard.agentId,
      deps.now() - LENDING_QUOTA_WINDOW_MS,
    );
    const suppliedUsdtWei =
      (input.reserve.vUsdtBalance * input.reserve.exchangeRateStored) / E18;
    const usage2 = lendingTier({
      nativeBalanceWei: input.reserve.nativeBalance,
      rescueReserveCount: settings.rescueReserveCount,
      rescuesChargedInWindow: usage.rescues,
      outstandingArmNativeWei: 0n,
    });
    await deps.guards.putSnapshot({
      agentId: guard.agentId,
      ownerAddress: guard.ownerAddress,
      blockNumber: input.readingA.blockNumber,
      observedAtMs: deps.now(),
      snapshot: {
        version: 1,
        account: {
          blockNumber: input.readingA.blockNumber.toString(10),
          markets: input.readingA.markets.map((market) => ({
            vToken: market.vToken,
            symbol: market.vTokenSymbol,
            underlying: market.underlying,
            underlyingDecimals: market.underlyingDecimals,
            supplyUnderlyingWei: (
              (market.vTokenBalance * market.exchangeRateStored) / E18
            ).toString(10),
            borrowWei: (market.borrowCurrent ?? market.borrowStored).toString(10),
            isCollateral: market.collateralMember,
            collateralFactor: market.effectiveCf.toString(10),
            liquidationThreshold: market.effectiveLt.toString(10),
            priceMantissa: market.boundedDebtPrice.toString(10),
          })),
          accountLiquidity: input.readingA.accountLiquidity.map((entry) =>
            entry.toString(10),
          ),
          borrowingPower: input.readingA.borrowingPower.map((entry) =>
            entry.toString(10),
          ),
          vaiDebt: input.readingA.vaiDebt.toString(10),
        },
        reserve: {
          idleUsdtWei: input.reserve.usdtBalance.toString(10),
          suppliedUsdtWei: suppliedUsdtWei.toString(10),
          vUsdtBalance: input.reserve.vUsdtBalance.toString(10),
          poolCashWei: input.reserve.cash.toString(10),
          bnbTierWei: usage2.tierBnbWei.toString(10),
          nativeBalanceWei: input.reserve.nativeBalance.toString(10),
          walletFloorWei: walletNativeFloorWei().toString(10),
          usdtAllowanceToVUsdt: input.reserve.usdtAllowanceToVUsdt.toString(10),
          usdtAllowanceToRouter: input.reserve.usdtAllowanceToRouter.toString(10),
        },
        conditions: input.conditions,
        usage: { rescues: usage.rescues, lastRescueAtMs: usage.lastRescueAtMs },
        observation:
          input.observation === null
            ? null
            : {
                healthFactor:
                  input.observation.healthFactor === null
                    ? null
                    : input.observation.healthFactor.toString(10),
                breach: input.observation.breach,
                consecutive: input.observation.consecutive,
                evaluatedAtMs: input.observation.evaluatedAtMs,
              },
        session: {
          expiresAt: agent.sessionFacts?.expiry ?? null,
        },
      },
    });
    return true;
  } catch (error) {
    // LOGGED AND SWALLOWED. Never aborts a cycle that has submitted money.
    deps.log?.({
      agentId: guard.agentId,
      action: "error",
      condition: "transport",
      reason: sanitizeMessage(
        `The view snapshot could not be written: ${
          error instanceof Error ? error.message : "unknown"
        }. The cycle's money work is unaffected; the view will report the staleness.`,
      ),
    });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Cadence                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How long to wait before the NEXT cycle may start, anchored on the PREVIOUS
 * cycle's START — and a cycle that OVERRUNS its interval SKIPS the missed tick
 * rather than starting immediately.
 *
 * Because the hysteresis spacing comparison uses RECORDED STAMPS, an overrun
 * can only LENGTHEN spacing, and spacing is a MINIMUM.
 */
export function nextLendingCycleDelayMs(
  cycleStartedAtMs: number,
  nowMs: number,
  intervalMs: number,
): number {
  const elapsed = nowMs - cycleStartedAtMs;
  if (elapsed < intervalMs) return intervalMs - elapsed;
  const missed = Math.floor(elapsed / intervalMs);
  return (missed + 1) * intervalMs - elapsed;
}

export function normalizeGuardedAccount(account: Address): Address {
  return getAddress(account);
}

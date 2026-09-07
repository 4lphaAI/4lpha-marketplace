/**
 * The Venus guard worker (PHASE4-SPEC D6, corrected by R2.6, R2.8, R3.3, R3.4,
 * R3.7, R3.9, R3.10).
 *
 * ONE cycle ({@link runVenusWorkerOnce}), per opted-in agent, in the order the
 * corrected spec fixes:
 *
 *   freeze the cycle clock → tracking reconcile → per agent: load agent +
 *   settings + session facts → kill-switch / pause check → UNKNOWN-hold scan →
 *   direct FINALIZED reads → evaluate the trigger against the DURABLE counter →
 *   decide → (dry-run: report, WRITE NOTHING) → pre-submit pause/listing checks
 *   → journal begin → submit → verify BY EFFECT → THEN persist the observation.
 *
 * ─── WHERE THE OBSERVATION IS WRITTEN, AND WHY THERE (R2.6) ────────────────
 *
 * BELOW the dispatch, never above it. The spec body put the durable write
 * between the confirmed trigger and its dispatch, which is the exact ordering
 * `src/lp/worker.ts:88-100` forbids: a Postgres blip would throw, the
 * evaluation would error, and a CONFIRMED rescue would be held with a
 * plausible-looking log line — (ae)'s own signature, DB-backed. So:
 *
 *   - no store this phase adds ever sits between a confirmed trigger and its
 *     dispatch;
 *   - a read failure / missing row / structurally invalid row ALL mean "NO
 *     previous observation" (one extra confirmation cycle, never a skip);
 *   - a WRITE failure is reported as `observationPersisted: false` and NEVER
 *     aborts the agent.
 *
 * ─── THE CYCLE CLOCK IS FROZEN (R2.6, FINDINGS (af)) ───────────────────────
 *
 * `cycleNowMs = deps.now()` is the FIRST statement, before any read, and it is
 * the only clock for both the observation row and the spacing comparison. The
 * LP plane measured 59 970 ms against a 60 000 ms interval when the stamp was
 * taken mid-cycle, and every protect paid a third cycle for it. A Venus cycle
 * has MORE pre-evaluation reads than an LP cycle, so the drift would be larger.
 *
 * ─── DRY RUN WRITES NOTHING, AND THE GATE COMES AFTER THE CHECK ────────────
 *
 * The PHASE3.4 A-fix ordering, on BOTH paths: the dry-run branch is taken
 * BEFORE any store write, any journal row, any provider call. A rehearsal reads
 * the chain (that IS the decision), reports what a live cycle would record, and
 * writes nothing — including no durable observation row, so a dry run followed
 * by a live run can never manufacture a confirmation.
 *
 * ─── EXACTLY ONE VENUS WORKER PER DATABASE IS A MONEY INVARIANT ────────────
 *
 * Two workers racing the observation upsert can each read a stale previous
 * observation, each reach two confirmations, and BOTH dispatch a rescue —
 * bounded by the on-chain caps, but a double spend of the owner's rescue budget
 * out of one falling position. v1 states the invariant and adds no lease; the
 * lease is named future work, and `scripts/venus-worker.ts` repeats this in its
 * startup banner.
 *
 * ─── COST MODEL AND OVERRUN (R3.10) ────────────────────────────────────────
 *
 * ~25-45 RPC reads per agent per cycle for a typical 2-4 market account
 * (~6 account-level plus ~8-10 per active market). Bounds: per-cycle agent
 * concurrency 4, and the interval has a BOOT-REFUSED floor of 15 000 ms. A
 * cycle that exceeds its interval SKIPS the missed tick — the next cycle starts
 * at the next boundary — and because the R2.6 spacing comparison uses RECORDED
 * STAMPS, an overrun can only LENGTHEN spacing, which is the safe direction:
 * spacing is a MINIMUM, not an equality.
 *
 * Stated plainly: 30 s holds for the operator-scale deployment (a handful of
 * agents). A public-cardinality deployment needs cursor/chunk scheduling like
 * the data plane's, and `PHASE4-DATA-PLANE-HANDOFF.md` §5's measure-before-scale
 * obligation now belongs to THIS plane. It is a named pre-public-launch item.
 */
import { getAddress, type Address, type Hex } from "viem";
import { sanitizeMessage } from "../core/errors.js";
import {
  ExecutionPlaneError,
  ProviderError,
  type ExecutionReceipt,
  type SessionRef,
  type WalletCall,
  type WalletProvider,
} from "../core/types.js";
import { authorizeExecute } from "../auth/executeDecision.js";
import { paramsHash } from "../auth/canonical.js";
import { agentAuthorityFromPrivateKey } from "../wallet/altana.js";
import type { AgentRecord, AgentStore } from "../store/agents.js";
import type { ExecutionJournal } from "../store/journal.js";
import type { KillSwitch } from "../killswitch/killswitch.js";
import type { DataPlaneClient } from "../clients/dataPlane.js";
import type {
  VenusSettingsRecord,
  VenusSettingsStore,
} from "../store/venusSettings.js";
import type {
  VenusObservation,
  VenusObservationStore,
} from "../store/venusObservations.js";
import {
  VENUS_QUOTA_WINDOW_MS,
  VenusClaimQuotaError,
  type VenusActionStore,
} from "../store/venusActions.js";
import {
  parseVenusSettingsParams,
  maxPerActionFor,
  namesMarket,
  type VenusAutomationSettings,
} from "../http/venusWire.js";
import {
  grantsVenusMarket,
  venusMeterReserve,
  walletNativeFloorWei,
} from "../ops/policy.js";
import {
  buildVenusClaimInterestCall,
  buildVenusClaimVenusCall,
  buildVenusRepayCalls,
  buildVenusSupplyCalls,
} from "./builders.js";
import { evaluateVenusTrigger, type VenusBasisView } from "./triggers.js";
import {
  selectVenusRescue,
  type VenusSizingMarket,
  type VenusSizingOutcome,
} from "./sizing.js";
import type { VenusChainReaders } from "./readers.js";
import type {
  VenusAccountReading,
  VenusActionKind,
  VenusCondition,
  VenusMarketReading,
  VenusVenue,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Deps and report                                                            */
/* -------------------------------------------------------------------------- */

export type VenusWorkerDeps = {
  readonly agentStore: AgentStore;
  readonly journal: ExecutionJournal;
  readonly killswitch: KillSwitch;
  readonly provider: WalletProvider;
  readonly settingsStore: VenusSettingsStore;
  readonly observations: VenusObservationStore;
  readonly actions: VenusActionStore;
  readonly readers: VenusChainReaders;
  /** The pinned Venus addresses — Comptroller, vBNB, Prime, treasury. */
  readonly venue: VenusVenue;
  /** ADVISORY only — the tracking lifecycle and the cheap early hint (D9). */
  readonly dataPlane?: DataPlaneClient;
  readonly intervalMs: number;
  readonly maxObservationAgeMs: number;
  readonly agentConcurrency: number;
  /** Injected clock, ms. Frozen at cycle start and used for nothing else. */
  readonly now: () => number;
  readonly dryRun: boolean;
  /** Journal reconcile. Live cycles only — it calls the provider. */
  readonly reconcile?: () => Promise<void>;
  readonly log?: (outcome: VenusWorkerAgentOutcome) => void;
};

export type VenusWorkerAction =
  | "dispatched"
  | "hold"
  | "skipped"
  | "dry-run"
  | "error";

export type VenusWorkerAgentOutcome = {
  readonly agentId: string;
  readonly action: VenusWorkerAction;
  /** Sanitized. Callers branch on `condition`, never on this text. */
  readonly reason: string;
  readonly condition?: VenusCondition;
  readonly kind?: VenusActionKind;
  readonly amountWei?: bigint;
  readonly vToken?: Address;
  /** HF on the LIQUIDATION basis, as this cycle read it. */
  readonly healthFactor?: bigint | null;
  /** How many consecutive qualifying observations this cycle completed. */
  readonly consecutive?: number;
  /**
   * Whether the durable observation write succeeded. `false` is a LOGGED
   * degradation, never a refusal: the agent was already dispatched or held on
   * its merits, and the cost of the lost row is one extra confirmation cycle —
   * which for Venus means a rescue DELAYED, not telemetry lost.
   */
  readonly observationPersisted?: boolean;
  /** The receipt's own status, when a submission happened. */
  readonly receiptStatus?: ExecutionReceipt["status"];
  /** R2.8: what the EFFECT read found. Authoritative over the receipt. */
  readonly effect?: "changed" | "no-effect" | "unverified";
  readonly journalKey?: string;
};

export type VenusWorkerCycleReport = {
  readonly startedAtMs: number;
  readonly dryRun: boolean;
  readonly reconciled: boolean;
  readonly outcomes: readonly VenusWorkerAgentOutcome[];
  /** R3.9: what the tracking reconcile did this cycle. */
  readonly tracking: readonly VenusTrackingOutcome[];
};

export type VenusTrackingOutcome = {
  readonly agentId: string;
  readonly owner: Address;
  readonly action: "put" | "delete" | "skipped";
  readonly result: "ok" | "pending" | "untracked" | "capacity" | "error";
};

/* -------------------------------------------------------------------------- */
/* One cycle                                                                  */
/* -------------------------------------------------------------------------- */

export async function runVenusWorkerOnce(
  deps: VenusWorkerDeps,
): Promise<VenusWorkerCycleReport> {
  // (0) FREEZE THE CYCLE CLOCK — the first statement, before any read.
  const cycleNowMs = deps.now();
  const outcomes: VenusWorkerAgentOutcome[] = [];
  const emit = (outcome: VenusWorkerAgentOutcome): void => {
    outcomes.push(outcome);
    deps.log?.(outcome);
  };

  // (1) Journal reconcile — LIVE cycles only. Reconcile resolves rows through
  // the PROVIDER, and dry-run's contract is zero provider calls.
  let reconciled = false;
  if (!deps.dryRun && deps.reconcile !== undefined) {
    await deps.reconcile();
    reconciled = true;
  }

  const rows = await deps.settingsStore.listForWorker();

  // (2) The tracking reconcile (R3.9) — the guaranteed convergence loop in BOTH
  // directions, enumerated from Venus-settings rows. It runs BEFORE the money
  // work and never blocks it: the data plane is advisory, and a tracking
  // failure must not cost a rescue.
  const tracking = deps.dryRun
    ? []
    : await reconcileTracking(deps, rows);

  // (3) Per agent, with bounded concurrency and per-agent failure isolation.
  const queue = [...rows];
  const workers = Array.from(
    { length: Math.max(1, deps.agentConcurrency) },
    async () => {
      for (;;) {
        const row = queue.shift();
        if (row === undefined) return;
        try {
          emit(await evaluateAgent(deps, row, cycleNowMs));
        } catch (error) {
          // Per-agent isolation: one agent's thrown read must never skip the
          // next agent. The failure is reported, not swallowed.
          emit({
            agentId: row.agentId,
            action: "error",
            condition: "transport",
            reason: sanitizeMessage(messageOf(error)),
          });
        }
      }
    },
  );
  await Promise.all(workers);

  return {
    startedAtMs: cycleNowMs,
    dryRun: deps.dryRun,
    reconciled,
    outcomes,
    tracking,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* The tracking lifecycle (R3.9)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Converge tracked subjects with settings rows, in BOTH directions.
 *
 * The PUT is normally issued from the `venusSettings` route — the one
 * owner-signed surface both self-serve hire and the operator script traverse —
 * post-commit and best-effort. This pass re-issues the ones that missed
 * (settings row exists, subject untracked) and issues DELETEs for tracked
 * subjects whose agent is revoked or absent. Idempotent and retryable.
 *
 * WHEN `VENUS_ENABLED=false` DISABLES THE WORKER, references PERSIST until
 * re-enable or until the operator runs `live-venus untrack-sweep`. That is
 * documented as leaking tracked references BY DESIGN rather than discovered:
 * the data plane's capacity is 1 000 subjects, and leaked references are how a
 * deployment reaches it.
 */
async function reconcileTracking(
  deps: VenusWorkerDeps,
  rows: readonly VenusSettingsRecord[],
): Promise<VenusTrackingOutcome[]> {
  const dataPlane = deps.dataPlane;
  if (dataPlane === undefined) return [];
  const out: VenusTrackingOutcome[] = [];
  for (const row of rows) {
    const agent = await deps.agentStore.getAgent(row.ownerAddress, row.agentId);
    const revoked = agent === null || agent.status === "revoked";
    try {
      if (revoked) {
        const result = await dataPlane.venusUntrackOwner(
          row.ownerAddress,
          row.agentId,
        );
        out.push({
          agentId: row.agentId,
          owner: row.ownerAddress,
          action: "delete",
          result: result.kind,
        });
        continue;
      }
      const snapshot = await dataPlane.venusAccount(row.ownerAddress);
      if (snapshot.kind !== "untracked") {
        out.push({
          agentId: row.agentId,
          owner: row.ownerAddress,
          action: "skipped",
          result: "ok",
        });
        continue;
      }
      const result = await dataPlane.venusTrackOwner(
        row.ownerAddress,
        row.agentId,
      );
      out.push({
        agentId: row.agentId,
        owner: row.ownerAddress,
        action: "put",
        result: result.kind,
      });
    } catch {
      // ADVISORY. A data-plane outage degrades monitoring to the worker's own
      // direct reads, honestly labelled on the view — it never costs a rescue.
      out.push({
        agentId: row.agentId,
        owner: row.ownerAddress,
        action: revoked ? "delete" : "put",
        result: "error",
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* One agent                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The UNKNOWN hold, ASYMMETRIC and typed (R3.7).
 *
 * While any `venusSupply` or `venusClaimRepayLeg` row is UNKNOWN, further
 * SUPPLIES and CLAIM LEGS are BLOCKED — a repeated supply is the owner's
 * capital locked a second time. `venusRepay` CONTINUES, with the hold recorded
 * on each decision: a repeated repay is clamped by the submit-time
 * `min(…, borrowCurrent)` re-read and is at worst a `no-effect`.
 *
 * The over-broad alternative ("one UNKNOWN voids the guard") would let a single
 * transport blip — during network stress, which is exactly when a rescue is
 * most likely to be needed — permanently disarm the guard, with no owner remedy
 * that exists in v1.
 */
export type VenusUnknownHold = {
  readonly held: boolean;
  readonly callsIds: readonly string[];
  readonly keys: readonly string[];
};

export async function readVenusUnknownHold(
  journal: ExecutionJournal,
  agentId: string,
): Promise<VenusUnknownHold> {
  const rows = await journal.listUnknownForAgent(agentId);
  const blocking = rows.filter(
    (row) => row.kind === "venusSupply" || row.kind === "venusClaimRepayLeg",
  );
  return {
    held: blocking.length > 0,
    callsIds: blocking
      .map((row) => row.externalRef.callsId)
      .filter((id): id is Hex => id !== undefined),
    keys: blocking.map((row) => row.idempotencyKey),
  };
}

async function evaluateAgent(
  deps: VenusWorkerDeps,
  row: VenusSettingsRecord,
  cycleNowMs: number,
): Promise<VenusWorkerAgentOutcome> {
  const agent = await deps.agentStore.getAgent(row.ownerAddress, row.agentId);
  if (agent === null) {
    return {
      agentId: row.agentId,
      action: "skipped",
      condition: "settings-absent",
      reason: "Settings row has no agent; the tracking reconcile will drop it.",
    };
  }

  const parsed = parseVenusSettingsParams(row.params);
  if (!parsed.ok) {
    // Automation must never run under settings nobody provably signed, and
    // must never run under settings that no longer parse.
    return {
      agentId: agent.id,
      action: "skipped",
      condition: "settings-absent",
      reason: sanitizeMessage(`Stored Venus settings are unreadable: ${parsed.message}`),
    };
  }
  const settings = parsed.value;
  const digest = paramsHash("venusSettings", row.params);
  if (digest !== row.digest) {
    return {
      agentId: agent.id,
      action: "skipped",
      condition: "settings-absent",
      reason:
        "The stored settings digest does not recompute; automation never runs under " +
        "settings nobody provably signed.",
    };
  }

  // PHASE4-AUDIT A3. This was `reducesExposure: true`, on the FINDINGS (s)
  // sell analogy: a rescue repays the owner's own debt, so refusing it looks
  // like the trapped-exit family this plane has spent three phases on.
  //
  // It is dropped, and the reason is not that the analogy is wrong — it is that
  // D4 is NORMATIVE and says the opposite: "repay/supply rescue is not
  // disableable per-flag — **pausing the agent is the off switch**." Pause is
  // the owner's only stop control that costs no signature and no gas, and
  // CLAUDE.md's kill-switch boundary is written as "pause = server-side
  // refusal". A surface that keeps submitting through a pause makes both
  // sentences false, and a change to the owner's stop control cannot be decided
  // in a code comment. An owner who pauses and then wants the rescue can
  // unpause; an owner who pauses a suspected-compromised agent needs the pause
  // to mean what it says.
  //
  // Claims rode the same bypass and no analogy covered them at all: a claim is
  // the BUY-analog and submits while the guard is idle.
  //
  // If the analogy is to win, it wins through the phase process — a spec
  // amendment, its own review, and the owner view saying plainly that pause
  // does not stop rescues.
  const decision = await authorizeExecute({
    agent,
    killswitch: deps.killswitch,
    now: Math.floor(cycleNowMs / 1000),
  });
  if (!decision.allowed) {
    return {
      agentId: agent.id,
      action: "hold",
      condition:
        decision.code === "GLOBAL_HALT"
          ? "killswitch"
          : decision.code === "NO_SESSION" || decision.code === "SESSION_EXPIRED"
            ? "session-expired-or-revoked"
            : "killswitch",
      reason: sanitizeMessage(`${decision.code}: ${decision.reason}`),
    };
  }

  const hold = await readVenusUnknownHold(deps.journal, agent.id);

  // The DIRECT FINALIZED READ — the decision authority. The data plane is a
  // cheap early hint with no latency guarantee and is never consulted here.
  const reading = await deps.readers.readAccount(agent.ownerAddress);

  const previous = await readObservation(deps, agent, cycleNowMs);
  const trigger = evaluateVenusTrigger({
    reading,
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
    return {
      agentId: agent.id,
      action: "hold",
      condition: trigger.condition,
      reason: sanitizeMessage(trigger.detail),
      healthFactor: trigger.view.pair.liquidationRisk.healthFactor,
    };
  }
  if (trigger.kind === "hold") {
    // The guard is not acting, so a CLAIM may be considered — never the other
    // way round. A falling position outranks a reward, always, which is why
    // this sits inside the hold branch and not beside it.
    if (trigger.condition === "hf-above-trigger") {
      const claim = await maybeClaim(
        deps,
        agent,
        settings,
        reading,
        cycleNowMs,
        hold,
      );
      if (claim !== null) {
        if (deps.dryRun) return claim;
        const persistedForClaim = await persistObservation(
          deps,
          agent,
          trigger.observation,
        );
        return { ...claim, observationPersisted: persistedForClaim };
      }
    }
    // THE DRY-RUN GATE COMES AFTER THE DECISION AND BEFORE EVERY WRITE.
    if (deps.dryRun) {
      return {
        agentId: agent.id,
        action: "dry-run",
        condition: trigger.condition,
        reason: `Would record: ${sanitizeMessage(trigger.detail)} Nothing was written.`,
        healthFactor: trigger.observation.healthFactor,
        consecutive: trigger.observation.consecutive,
      };
    }
    const persisted = await persistObservation(deps, agent, trigger.observation);
    return {
      agentId: agent.id,
      action: "hold",
      condition: trigger.condition,
      reason: sanitizeMessage(trigger.detail),
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      observationPersisted: persisted,
    };
  }

  // ── ACT ──────────────────────────────────────────────────────────────────

  const cooldown = await checkCooldown(deps, agent, settings, cycleNowMs);
  if (cooldown !== null) {
    if (deps.dryRun) {
      return {
        agentId: agent.id,
        action: "dry-run",
        condition: "cooldown",
        reason: `Would hold: ${cooldown} Nothing was written.`,
        healthFactor: trigger.observation.healthFactor,
      };
    }
    const persisted = await persistObservation(deps, agent, trigger.observation);
    return {
      agentId: agent.id,
      action: "hold",
      condition: "cooldown",
      reason: sanitizeMessage(cooldown),
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      observationPersisted: persisted,
    };
  }

  const markets = buildSizingMarkets(reading, agent, settings);
  const outcome = selectVenusRescue(markets, {
    basis: "liquidation",
    targetHf: settings.targetHf,
    vaiDebt: reading.vaiDebt,
    protocolPaused: reading.protocolPaused,
    walletNativeFloorWei: walletNativeFloorWei(),
    hasNativeGrant: await hasNativeGrant(deps, agent),
  });

  if (outcome.kind === "refused") {
    if (deps.dryRun) {
      return {
        agentId: agent.id,
        action: "dry-run",
        condition: outcome.condition,
        reason: `Would refuse: ${sanitizeMessage(outcome.detail)} Nothing was written.`,
        healthFactor: trigger.observation.healthFactor,
      };
    }
    const persisted = await persistObservation(deps, agent, trigger.observation);
    return {
      agentId: agent.id,
      action: "hold",
      condition: outcome.condition,
      reason: sanitizeMessage(outcome.detail),
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      observationPersisted: persisted,
    };
  }

  const kind: VenusActionKind =
    outcome.kind === "repay" ? "venusRepay" : "venusSupply";

  if (kind === "venusSupply" && hold.held) {
    // R3.7's asymmetry, applied. The repay branch is deliberately NOT gated.
    if (deps.dryRun) {
      return {
        agentId: agent.id,
        action: "dry-run",
        condition: "unknown-held",
        reason:
          "Would refuse the supply: an ambiguous venusSupply/venusClaimRepayLeg row is " +
          "UNKNOWN and a repeated supply locks the owner's capital a second time. " +
          "Nothing was written.",
        healthFactor: trigger.observation.healthFactor,
      };
    }
    const persisted = await persistObservation(deps, agent, trigger.observation);
    return {
      agentId: agent.id,
      action: "hold",
      condition: "unknown-held",
      reason: sanitizeMessage(
        `Rescues are degraded: supply is disabled while ${hold.keys.length} ambiguous ` +
          `row(s) are UNKNOWN (callsIds: ${hold.callsIds.join(", ") || "none recorded"}). ` +
          "venusRepay continues.",
      ),
      healthFactor: trigger.observation.healthFactor,
      observationPersisted: persisted,
    };
  }

  const plan = outcome.kind === "repay" ? outcome.plan : outcome.plan;
  const market = markets.find((entry) => entry.vToken === plan.vToken);
  if (market === undefined) {
    throw new Error("The selected market vanished between sizing and dispatch.");
  }

  // R2.8: the pre-submit pause/listing checks, in the SAME finalized read set
  // as the sizing. `Failure(uint256,uint256,uint256)` is PRESENT in both vBNB
  // and the current vUSDT implementation bytecode, so the Compound failOpaque
  // pattern is LIVE: a paused or refused repay/mint CONFIRMS with zero effect,
  // charging quota and meter while HF keeps falling. Preventing the submission
  // is cheaper than un-charging it (R3.5).
  const paused =
    kind === "venusRepay" ? market.repayPaused : market.mintPaused;
  if (reading.protocolPaused || paused || !market.listed) {
    const condition: VenusCondition = reading.protocolPaused
      ? "protocol-paused"
      : paused
        ? "action-paused"
        : "market-delisted";
    if (deps.dryRun) {
      return {
        agentId: agent.id,
        action: "dry-run",
        condition,
        reason: "Would refuse before submitting. Nothing was written.",
      };
    }
    const persisted = await persistObservation(deps, agent, trigger.observation);
    return {
      agentId: agent.id,
      action: "hold",
      condition,
      reason: `Refused before submitting on ${market.vToken}.`,
      vToken: market.vToken,
      observationPersisted: persisted,
    };
  }

  if (deps.dryRun) {
    // THE REHEARSAL: report what a live cycle WOULD record, write NOTHING.
    return {
      agentId: agent.id,
      action: "dry-run",
      kind,
      vToken: plan.vToken,
      amountWei: plan.amountWei,
      healthFactor: trigger.observation.healthFactor,
      consecutive: trigger.observation.consecutive,
      reason:
        `Would submit ${kind} of ${plan.amountWei} on ${plan.vToken} ` +
        `(bound by ${plan.boundBy}${plan.partial ? ", PARTIAL" : ""}), taking HF from ` +
        `${plan.currentHf ?? "inf"} to ${plan.achievedHf ?? "inf"}. Nothing was executed.`,
    };
  }

  const dispatched = await dispatch(deps, agent, settings, kind, market, plan.amountWei, outcome);

  // THE OBSERVATION WRITE — below the dispatch, always.
  const persisted = await persistObservation(deps, agent, trigger.observation);

  return {
    ...dispatched,
    healthFactor: trigger.observation.healthFactor,
    consecutive: trigger.observation.consecutive,
    observationPersisted: persisted,
  };
}

/* -------------------------------------------------------------------------- */
/* Cooldown and grants                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `minSecondsBetweenActions`, the ANTI-FLAP instrument.
 *
 * It is the ONLY rate control that touches a rescue: `maxClaimsPerDay` governs
 * claims and rescues are counted but never refused (R2.9/R3.4), and
 * `agent.caps` gates claims only (R3.3). An oracle flapping around the
 * threshold must not chain rescues into a cap-draining loop, and that is the
 * whole of what this bounds.
 */
async function checkCooldown(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  cycleNowMs: number,
): Promise<string | null> {
  const usage = await deps.actions.usageSince(
    agent.ownerAddress,
    agent.id,
    cycleNowMs - VENUS_QUOTA_WINDOW_MS,
  );
  if (usage.lastRescueAtMs === null) return null;
  const elapsedSec = Math.floor((cycleNowMs - usage.lastRescueAtMs) / 1000);
  if (elapsedSec >= settings.minSecondsBetweenActions) return null;
  return (
    `The last rescue was ${elapsedSec}s ago, inside the ${settings.minSecondsBetweenActions}s ` +
    "anti-flap floor. An oracle flapping around the threshold must not chain rescues."
  );
}

/** Whether the session can attach `msg.value` at all (R2.11). */
async function hasNativeGrant(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
): Promise<boolean> {
  const facts = agent.sessionFacts;
  if (facts === null) return false;
  // A rehearsal makes ZERO provider calls; the persisted grant is the honest
  // (weaker) answer, and the rehearsal's report says which one it used.
  if (deps.dryRun) {
    return facts.spec.spendCaps.some((cap) => cap.token === undefined);
  }
  const meter = deps.provider.nativeDayMeter;
  if (meter === undefined) {
    // No capability to ask: fall back to the persisted grant, which is the
    // weaker claim and is labelled as such wherever it is reported.
    return facts.spec.spendCaps.some((cap) => cap.token === undefined);
  }
  try {
    const reading = await meter.call(deps.provider, {
      walletAddress: agent.walletAddress,
      publicKey: facts.publicKey,
    });
    return reading.kind !== "no-native-grant";
  } catch {
    // An unreadable meter fails closed on the CLAIM side only; for the rescue
    // side the persisted grant is the honest fallback, because refusing a
    // rescue on a transport failure is the trap.
    return facts.spec.spendCaps.some((cap) => cap.token === undefined);
  }
}

function buildSizingMarkets(
  reading: VenusAccountReading,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
): VenusSizingMarket[] {
  const spec = agent.sessionFacts?.spec ?? null;
  return reading.markets.map((market) => {
    const token = market.underlying;
    return {
      vToken: market.vToken,
      underlying: token,
      native: market.native,
      listed: market.listed,
      borrowAllowed: market.borrowAllowed,
      mintPaused: market.mintPaused,
      repayPaused: market.repayPaused,
      supplyHeadroom: market.supplyHeadroom,
      // SIZING uses the CURRENT basis, re-read at submit; when the simulation
      // failed there is no current figure and the stored one is the honest
      // fallback (the two differ by accrued interest, and stored errs LOW,
      // which clamps the repay smaller — the safe direction).
      borrowCurrent: market.borrowCurrent ?? market.borrowStored,
      walletBalance: market.walletBalance,
      // PHASE4-AUDIT A2: carried, not dropped. The builder needs it to decide
      // on the zero-first approve leg; native markets spend `msg.value` and
      // have no allowance to carry.
      allowance: market.native ? 0n : market.allowance,
      maxPerActionWei: maxPerActionFor(settings, token),
      capRemainingWei: null,
      inGrant: spec === null ? false : grantsVenusMarket(spec, market.vToken),
      inDebtSettings: namesMarket(settings.debtMarkets, market.vToken),
      inCollateralSettings: namesMarket(settings.collateralMarkets, market.vToken),
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
/* Observation read/write                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A read failure, a missing row and a structurally invalid row are the SAME
 * answer: NO previous observation. One extra confirmation cycle, never a skip,
 * and never a throw between a confirmed trigger and its dispatch.
 */
async function readObservation(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  _cycleNowMs: number,
): Promise<VenusObservation | null> {
  try {
    return await deps.observations.get(agent.ownerAddress, agent.id, "rescue");
  } catch {
    return null;
  }
}

/** A write failure is REPORTED and never aborts the agent. */
async function persistObservation(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  observation: VenusObservation,
): Promise<boolean> {
  try {
    await deps.observations.put({
      ownerAddress: agent.ownerAddress,
      agentId: agent.id,
      kind: "rescue",
      observation,
    });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Journal begin → preflight → submit → VERIFY BY EFFECT.
 *
 * ═══ POSITIONAL CLASSIFICATION (Phase 2.4, inherited verbatim) ════════════
 *
 * Everything thrown ABOVE the submit provably never reached a relay, so the row
 * ROLLS BACK. Everything thrown at or below the submit is ambiguous and is held
 * as UNKNOWN — and for Venus, UNKNOWN is where it stays: v1 ships no resolver
 * for these kinds, so the row degrades the guard through R3.7's `unknown-held`
 * until an owner-signed `venusResolveUnknown` phase exists.
 *
 * ═══ VERIFICATION BY EFFECT IS AUTHORITATIVE OVER THE RECEIPT (R2.8) ══════
 *
 * The Compound `failOpaque` pattern is LIVE in the deployed vBNB and vUSDT
 * implementations (the `Failure(uint256,uint256,uint256)` topic is present at
 * the census block), so a refused `repayBorrow`/`mint` CONFIRMS with zero
 * effect. `receipt CONFIRMED && effect zero` is the typed outcome `no-effect`:
 * surfaced to the owner, hysteresis counter NOT reset, never counted as a
 * rescue — and it KEEPS its quota slot (R3.5), because it submitted and drew
 * relay gas, which is the very thing the quota proxies.
 */
async function dispatch(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  kind: VenusActionKind,
  market: VenusSizingMarket,
  amountWei: bigint,
  outcome: VenusSizingOutcome,
): Promise<VenusWorkerAgentOutcome> {
  const facts = agent.sessionFacts;
  if (facts === null) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "session-expired-or-revoked",
      reason: "The agent has no granted session.",
    };
  }

  const nowMs = deps.now();
  const decisionId = venusDecisionId(agent.id, kind, nowMs);
  const idempotencyKey = `${agent.id}:${decisionId}`;

  // R3.4: the accounting row is written for EVERY action. A rescue is COUNTED
  // and NEVER REFUSED on the count; only a claim can be refused here.
  try {
    await deps.actions.charge({
      ownerAddress: agent.ownerAddress,
      agentId: agent.id,
      actionId: idempotencyKey,
      kind,
      maxClaimsPerDay: settings.maxClaimsPerDay,
    });
  } catch (error) {
    if (error instanceof VenusClaimQuotaError) {
      return {
        agentId: agent.id,
        action: "hold",
        condition: "quota-exhausted",
        reason: sanitizeMessage(error.message),
      };
    }
    throw error;
  }

  const calls: readonly WalletCall[] =
    kind === "venusRepay"
      ? buildVenusRepayCalls({
          vToken: market.vToken,
          underlying: market.underlying,
          amountWei,
          currentAllowanceWei: allowanceOf(outcome, market),
        })
      : buildVenusSupplyCalls({
          vToken: market.vToken,
          // REVISION 4: the native market cannot reach here — supplyFilter and
          // sizeVenusSupply both refuse it FIRST (native-collateral-trapped),
          // and the builder's input type makes a native mint unrepresentable.
          // This throw is the fail-closed translation of that invariant for
          // the compiler; it is not a reachable branch, and if it ever fires
          // the refusal ordering above it has been broken.
          underlying: requireErc20Underlying(market),
          amountWei,
          currentAllowanceWei: allowanceOf(outcome, market),
        });

  // R3.3: Venus money rows record `nativeSpendWei` HONESTLY (the journal ledger
  // stays accurate) and rescues are NOT gated by `agent.caps` — a guard that
  // can rescue once per day is not a guard, and gating here would reproduce
  // FINDINGS (ah) through a third door. The owner view states which budgets
  // bind which actions so a UI reading `caps` cannot imply a bound that does
  // not exist.
  const nativeSpendWei = market.native ? amountWei : 0n;

  await deps.journal.begin({
    idempotencyKey,
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    kind,
    decisionId,
    externalRef: { publicKey: facts.publicKey },
    nativeSpendWei,
  });

  // (a) EVERYTHING BEFORE THE SUBMIT, in its own block. A throw here provably
  // never reached a relay: the row rolls back.
  let session: SessionRef;
  try {
    session = await withSessionKey(deps.agentStore, agent, (authority) =>
      Promise.resolve(
        deps.provider.restoreSession({
          spec: facts.spec,
          agent: authority,
          walletAddress: agent.walletAddress,
          publicKey: facts.publicKey,
          expiresAt: facts.expiry,
        }),
      ),
    );
    // The CHAIN is the authority NOW (Phase 2.4): a market that passed the
    // settings-time early warning and fails here is `market-not-in-grant`.
    await deps.provider.preflightExecute({ session, calls });
  } catch (error) {
    const refusal = asPlaneError(error, "venus action refused");
    await deps.journal.markRolledBack(
      idempotencyKey,
      sanitizeMessage(`Refused before submission: ${refusal.code}.`),
    );
    return {
      agentId: agent.id,
      action: "hold",
      condition: "market-not-in-grant",
      kind,
      vToken: market.vToken,
      amountWei,
      journalKey: idempotencyKey,
      reason: sanitizeMessage(`${refusal.code}: ${refusal.message}`),
    };
  }

  // (b) THE SUBMIT. From here on, ambiguity is the rule.
  let receipt: ExecutionReceipt;
  try {
    receipt = await deps.provider.executeViaSession({
      session,
      calls,
      // HARD-CODED, exactly as on /trade and /execute. No request field, config
      // field or parameter on this path can reach it — and there is no request
      // on this path at all: the actor is a daemon.
      bypassLocalPolicyCheck: false,
    });
  } catch (error) {
    const mapped = asPlaneError(error, "venus action failed");
    await deps.journal.markUnknown(idempotencyKey, sanitizeMessage(mapped.message));
    return {
      agentId: agent.id,
      action: "hold",
      condition: "unknown-held",
      kind,
      vToken: market.vToken,
      amountWei,
      journalKey: idempotencyKey,
      reason:
        "Submission outcome is UNKNOWN and is held. Nothing resolves a Venus UNKNOWN " +
        "automatically in v1; the guard is degraded until an owner-signed resolver ships.",
    };
  }

  if (receipt.callsId !== undefined) {
    await deps.journal.markInProgress(idempotencyKey, { callsId: receipt.callsId });
  }
  if (receipt.status === "PENDING") {
    await deps.journal.markUnknown(
      idempotencyKey,
      "The relay returned PENDING; the submission window is ambiguous.",
    );
    return {
      agentId: agent.id,
      action: "hold",
      condition: "unknown-held",
      kind,
      vToken: market.vToken,
      amountWei,
      receiptStatus: receipt.status,
      journalKey: idempotencyKey,
      reason: "The relay returned PENDING; the row is held as UNKNOWN.",
    };
  }
  if (receipt.status === "FAILED") {
    await deps.journal.markRolledBack(
      idempotencyKey,
      sanitizeMessage(receipt.failureCode ?? "Execution reported FAILED."),
    );
    return {
      agentId: agent.id,
      action: "hold",
      condition: "transport",
      kind,
      vToken: market.vToken,
      amountWei,
      receiptStatus: receipt.status,
      journalKey: idempotencyKey,
      reason: sanitizeMessage(
        `The relay reported FAILED (${receipt.failureCode ?? "no code"}).`,
      ),
    };
  }

  await deps.journal.markCommitted(
    idempotencyKey,
    receipt.transactionHash === undefined
      ? {}
      : { txHash: receipt.transactionHash },
  );

  // (c) VERIFICATION BY EFFECT — authoritative over the receipt (R2.8).
  let effect: "changed" | "no-effect" | "unverified" = "unverified";
  try {
    if (kind === "venusRepay") {
      const after = await deps.readers.readBorrowCurrent(
        agent.ownerAddress,
        market.vToken,
      );
      effect = after < market.borrowCurrent ? "changed" : "no-effect";
    } else {
      const after = await deps.readers.readVTokenBalance(
        agent.ownerAddress,
        market.vToken,
      );
      effect = after > market.vTokenBalance ? "changed" : "no-effect";
    }
  } catch {
    // An unreadable effect is NOT a `no-effect` alarm: it is unverified, and
    // saying so is the difference between "the rescue did nothing" and "we
    // could not check".
    effect = "unverified";
  }

  return {
    agentId: agent.id,
    action: effect === "no-effect" ? "hold" : "dispatched",
    ...(effect === "no-effect" ? { condition: "no-effect" as const } : {}),
    kind,
    vToken: market.vToken,
    amountWei,
    receiptStatus: receipt.status,
    effect,
    journalKey: idempotencyKey,
    reason:
      effect === "no-effect"
        ? "The receipt CONFIRMED and the on-chain effect is ZERO (the Compound failOpaque " +
          "pattern is live on these contracts). This is NOT a rescue: the hysteresis " +
          "counter is not reset, and the accounting row keeps its slot because the " +
          "submission drew relay gas."
        : `Submitted ${kind} of ${amountWei} on ${market.vToken}; effect ${effect}.`,
  };
}

/** REVISION 4: proves to the compiler what the refusal ordering guarantees. */
function requireErc20Underlying(market: VenusSizingMarket): Address {
  if (market.underlying === null) {
    throw new Error(
      "venusSupply reached the builder with a NATIVE market — the " +
        "native-collateral-trapped refusal ordering has been broken.",
    );
  }
  return market.underlying;
}

function allowanceOf(
  outcome: VenusSizingOutcome,
  market: VenusSizingMarket,
): bigint {
  // PHASE4-AUDIT A2: read the REAL allowance the reading carried through
  // `buildSizingMarkets`. This was a structural cast against a field the sizing
  // market never had, so it answered `0n` on every rescue and the zero-first
  // leg could never be emitted on the one path that needs it.
  void outcome;
  return market.native ? 0n : market.allowance;
}

/** A decision id namespaced per agent + day + action counter (D7). */
export function venusDecisionId(
  agentId: string,
  kind: VenusActionKind,
  nowMs: number,
): string {
  const day = Math.floor(nowMs / 86_400_000);
  return `venus:${agentId}:${day}:${kind}:${nowMs}`;
}

/**
 * Fetch, use and drop the agent's session key in the narrowest possible scope —
 * the same discipline as the /trade route's helper and the LP sagas' mirror.
 * The key is a local `const`, never returned, logged or journaled.
 */
async function withSessionKey<T>(
  store: AgentStore,
  agent: AgentRecord,
  use: (authority: ReturnType<typeof agentAuthorityFromPrivateKey>) => Promise<T>,
): Promise<T> {
  let sessionKey: Hex | undefined =
    (await store.getAgentSessionKey(agent.ownerAddress, agent.id)) ?? undefined;
  if (sessionKey === undefined) {
    throw new ProviderError("Agent has no stored session key.");
  }
  try {
    return await use(agentAuthorityFromPrivateKey(sessionKey));
  } finally {
    sessionKey = undefined;
  }
}

function asPlaneError(error: unknown, fallback: string): ExecutionPlaneError {
  if (error instanceof ExecutionPlaneError) return error;
  return new ProviderError(
    sanitizeMessage(error instanceof Error ? error.message : fallback),
  );
}

/* -------------------------------------------------------------------------- */
/* Cadence                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How long to wait before the NEXT cycle may start, anchored on the PREVIOUS
 * cycle's START — and a cycle that OVERRUNS its interval SKIPS the missed tick
 * (R3.10) rather than starting immediately.
 *
 * Anchoring on the start makes consecutive cycle starts at least `intervalMs`
 * apart. Skipping the missed tick is what stops an overrunning worker from
 * bursting: the schedule advances to the next boundary. Because the R2.6
 * spacing comparison uses RECORDED STAMPS, an overrun can only LENGTHEN
 * spacing, and spacing is a MINIMUM.
 */
export function nextVenusCycleDelayMs(
  cycleStartedAtMs: number,
  nowMs: number,
  intervalMs: number,
): number {
  const elapsed = nowMs - cycleStartedAtMs;
  if (elapsed < intervalMs) return intervalMs - elapsed;
  const missed = Math.floor(elapsed / intervalMs);
  return (missed + 1) * intervalMs - elapsed;
}

export async function sleepUntilNextVenusCycle(input: {
  readonly cycleStartedAtMs: number;
  readonly intervalMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stopped?: () => boolean;
}): Promise<void> {
  // THE TARGET BOUNDARY IS FIXED ONCE — found live, 2026-08-24, on the FIRST
  // real daemon run: the previous loop recomputed "the next boundary from
  // now" on every iteration, and {@link nextVenusCycleDelayMs}'s overrun
  // branch never answers <= 0 (it always names a boundary strictly ahead), so
  // after one sleep landed ON a boundary the next recomputation named the one
  // after it, forever. One cycle ran; the daemon then slept eternally while
  // the process sat alive and healthy-looking — the (ae) failure SHAPE, in
  // the scheduler instead of the counter. `--once` never touches this
  // function, which is why two live rescues could land without exposing it.
  const startNowMs = input.now();
  const target =
    startNowMs
    + nextVenusCycleDelayMs(input.cycleStartedAtMs, startNowMs, input.intervalMs);
  for (;;) {
    if (input.stopped?.() === true) return;
    const remaining = target - input.now();
    if (remaining <= 0) return;
    await input.sleep(remaining);
  }
}

/** Re-exported for the owner view, which reports both bases (D10/R2.15/R21). */
export type { VenusBasisView };

/** Normalized address helper for scripts that hand-build an owner scope. */
export function venusOwnerKey(owner: string): Address {
  return getAddress(owner);
}

/* -------------------------------------------------------------------------- */
/* Claims (D1, R2.15/R19 and R24, R2.11, R3.4, R3.5)                          */
/* -------------------------------------------------------------------------- */

/**
 * Convert a reward amount into BNB wei using the PROTOCOL's own oracle
 * (R2.15/R24).
 *
 * Both prices are Venus `getUnderlyingPrice` readings, scaled `1e(36 - d)`, and
 * the two scale factors cancel exactly:
 *
 *   usd18 = payout * priceReward / 1e18       (payout is in reward base units)
 *   bnbWei = usd18 * 1e18 / priceBnb
 *          = payout * priceReward / priceBnb
 *
 * A protocol price, not market judgement, and never the advisory cache. Either
 * price unavailable is `oracle-invalid` — the plane never claims a reward it
 * cannot price.
 */
export function venusRewardValueInBnbWei(
  payoutWei: bigint,
  rewardPrice: bigint,
  bnbPrice: bigint,
): bigint {
  if (rewardPrice <= 0n || bnbPrice <= 0n) {
    throw new Error("venusRewardValueInBnbWei: a protocol price was zero.");
  }
  return (payoutWei * rewardPrice) / bnbPrice;
}

/**
 * The CLAIM gate's meter check (R2.11) — the BUY-analog, and the ONLY place a
 * Venus action is refused for want of on-chain native headroom.
 *
 * Rescues are never gated here. All four meter readings are handled and only
 * one of them gates: `day` decides; `other-period` and `no-native-grant` are
 * REPORTED and not gated (mirroring the trade gate at `server.ts:2124-2158`);
 * an unreadable meter fails CLOSED as TRANSPORT — on the claim side only.
 *
 * The reserve NARROWS by the rescues already charged in the window (R3.4), so a
 * day of six rescues leaves this gate knowing the meter is six submissions
 * lighter.
 */
async function checkClaimMeter(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  rescuesChargedInWindow: number,
): Promise<{ readonly condition: VenusCondition; readonly detail: string } | null> {
  const facts = agent.sessionFacts;
  if (facts === null) {
    return {
      condition: "session-expired-or-revoked",
      detail: "The agent has no granted session.",
    };
  }
  if (deps.dryRun) {
    // A rehearsal makes ZERO provider calls (the Phase 3 contract, kept). The
    // meter is a provider read, so it is reported as unchecked rather than
    // silently passed — a dry run that "passed the reserve" would be claiming
    // to have checked something it never asked about.
    return null;
  }
  const meter = deps.provider.nativeDayMeter;
  if (meter === undefined) {
    return {
      condition: "transport",
      detail:
        "This provider cannot read the native day meter, so the claim reserve cannot " +
        "be checked. Claims fail closed; rescues are unaffected.",
    };
  }
  let reading;
  try {
    reading = await meter.call(deps.provider, {
      walletAddress: agent.walletAddress,
      publicKey: facts.publicKey,
    });
  } catch {
    return {
      condition: "transport",
      detail:
        "The native day meter could not be read. Claims fail CLOSED as transport; " +
        "rescues are never gated by a reserve.",
    };
  }
  if (reading.kind !== "day") {
    // Reported, not gated — and only one of the two is good news. An account
    // with no native row cannot spend native at all, which the owner view says.
    return null;
  }
  const reserve = venusMeterReserve({
    limitWei: reading.limitWei,
    currentSpentWei: reading.currentSpentWei,
    rescueReserveCount: settings.rescueReserveCount,
    rescuesChargedInWindow,
    submissionNativeWei: 0n,
  });
  if (reserve.sufficient) return null;
  return {
    condition: "native-reserve",
    detail:
      `The claim is refused so the meter keeps ${reserve.reservedSubmissions} rescue ` +
      `submission(s) of headroom: remaining ${reserve.remainingWei} wei, required ` +
      `${reserve.requiredWei} wei, short by ${reserve.shortfallWei} wei. ` +
      "Rescues are never refused by this reserve.",
  };
}

type ClaimCandidate = {
  readonly mechanism: "xvs" | "prime";
  readonly rewardToken: Address;
  readonly payoutWei: bigint;
  readonly bnbValueWei: bigint;
  /** Prime only: the market whose interest is being claimed. */
  readonly vToken?: Address;
  /** The IDENTICAL market list the submission will use (R2.15/R19b). */
  readonly markets: readonly Address[];
};

/**
 * Consider a claim. Returns `null` when there is nothing to say — the caller
 * then reports the ordinary `hf-above-trigger` hold.
 *
 * Claims are NON-URGENT by construction and are considered only when the guard
 * is not acting: a falling position outranks a reward, always.
 */
async function maybeClaim(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  reading: VenusAccountReading,
  cycleNowMs: number,
  hold: VenusUnknownHold,
): Promise<VenusWorkerAgentOutcome | null> {
  if (!settings.claimEnabled && !settings.claimRepayEnabled) return null;

  if (hold.held) {
    // R3.7: claim legs are BLOCKED while an ambiguous supply/claim-repay row is
    // UNKNOWN. Only `venusRepay` continues.
    return {
      agentId: agent.id,
      action: "hold",
      condition: "unknown-held",
      reason:
        "Claims are disabled while an ambiguous venusSupply/venusClaimRepayLeg row is " +
        "UNKNOWN. venusRepay continues.",
    };
  }

  const usage = await deps.actions.usageSince(
    agent.ownerAddress,
    agent.id,
    cycleNowMs - VENUS_QUOTA_WINDOW_MS,
  );
  if (usage.claims >= settings.maxClaimsPerDay) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "quota-exhausted",
      reason:
        `${usage.claims} claim(s) in the last 24h against maxClaimsPerDay ` +
        `${settings.maxClaimsPerDay}. Rescues are unaffected.`,
    };
  }

  // PHASE4-AUDIT A4 / S3. R3.3 is normative: "rescues are NOT gated by
  // `agent.caps`; claims ARE." The ledger half was already honest — Venus money
  // rows record `nativeSpendWei` — but this gate did not exist while the owner
  // view published `claimsGatedByAgentCaps: true`. A budget statement on the
  // owner surface has to be true, so the gate is here rather than the sentence
  // being softened.
  //
  // The rescue side deliberately does NOT consult `agent.caps`: a daily cap
  // that can refuse the last repay before liquidation is a liquidation vector
  // wearing a budget's name (FINDINGS (ah), and R2.9's whole argument).
  const caps = agent.caps;
  if (caps !== null && caps !== undefined) {
    const daily = caps.dailyNativeWei;
    if (daily !== undefined) {
      const spentTodayWei = await deps.journal.sumNativeSpendSince(
        agent.id,
        cycleNowMs - VENUS_QUOTA_WINDOW_MS,
      );
      if (spentTodayWei >= daily) {
        return {
          agentId: agent.id,
          action: "hold",
          condition: "quota-exhausted",
          reason:
            `The agent's off-chain daily native budget is spent (${spentTodayWei} of ` +
            `${daily} wei in the last 24h), so no CLAIM is submitted. Rescues are ` +
            "unaffected: refusing the last repay before liquidation is the trap this " +
            "guard exists to prevent.",
        };
      }
    }
  }

  const meterRefusal = await checkClaimMeter(deps, agent, settings, usage.rescues);
  if (meterRefusal !== null) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: meterRefusal.condition,
      reason: sanitizeMessage(meterRefusal.detail),
    };
  }

  if (reading.protocolPaused) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "protocol-paused",
      reason: "The Comptroller reports protocolPaused; no claim is submitted.",
    };
  }

  const candidate = await findClaimCandidate(deps, agent, settings, reading);
  if (candidate === null) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "payout-zero",
      reason:
        "No reward simulates to a positive payout now. `entitlement > 0` does not imply " +
        "a claim pays out — 51 of 52 Core markets carry zero XVS speeds — so `payoutNow` " +
        "is the decision variable.",
    };
  }
  if (candidate.bnbValueWei < settings.minClaimValueWei) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "payout-zero",
      reason:
        `The claim is worth ${candidate.bnbValueWei} wei of BNB at the protocol's own ` +
        `oracle, below the owner's floor of ${settings.minClaimValueWei} wei. Claiming ` +
        "dust burns relay fees.",
    };
  }

  // ── claim-repay: ONE atomic pre-flight gate before leg 1 (R2.15/R19a) ────
  if (settings.claimRepayEnabled) {
    const gate = claimRepayGate(agent, settings, reading, candidate, usage.claims);
    if (gate.kind === "ready") {
      if (deps.dryRun) {
        return {
          agentId: agent.id,
          action: "dry-run",
          kind: "venusClaimRepayLeg",
          vToken: gate.debtMarket.vToken,
          amountWei: candidate.payoutWei,
          reason:
            `Would claim ${candidate.payoutWei} of ${candidate.rewardToken} and repay it ` +
            `into ${gate.debtMarket.vToken}. Nothing was executed.`,
        };
      }
      return runClaimRepay(deps, agent, settings, candidate, gate.debtMarket);
    }
    if (gate.kind === "refused" && !settings.claimEnabled) {
      return {
        agentId: agent.id,
        action: "hold",
        condition: gate.condition,
        reason: sanitizeMessage(gate.detail),
      };
    }
  }

  if (!settings.claimEnabled) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "claim-disabled",
      reason: "The owner has not enabled plain claims.",
    };
  }

  if (deps.dryRun) {
    return {
      agentId: agent.id,
      action: "dry-run",
      kind: "venusClaim",
      amountWei: candidate.payoutWei,
      reason:
        `Would claim ${candidate.payoutWei} of ${candidate.rewardToken} ` +
        `(${candidate.bnbValueWei} wei BNB-equivalent). Nothing was executed.`,
    };
  }
  return runClaim(deps, agent, settings, candidate);
}

async function findClaimCandidate(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  reading: VenusAccountReading,
): Promise<ClaimCandidate | null> {
  const bnbMarket = reading.markets.find((market) => market.native);
  if (bnbMarket === undefined || bnbMarket.spotPrice <= 0n) return null;

  // Prime first: `claimInterest` pays a market's own underlying, which is the
  // only shape v1's same-token claim-repay can use.
  let primePaused = false;
  try {
    primePaused = await deps.readers.readPrimePaused();
  } catch {
    primePaused = true;
  }
  if (!primePaused) {
    let pending: Awaited<ReturnType<VenusChainReaders["readPrimePending"]>> = [];
    try {
      pending = await deps.readers.readPrimePending(agent.ownerAddress);
    } catch {
      pending = [];
    }
    for (const entry of pending) {
      if (entry.amount <= 0n) continue;
      const market = reading.markets.find(
        (candidate) => candidate.vToken.toLowerCase() === entry.vToken.toLowerCase(),
      );
      if (market === undefined || market.spotPrice <= 0n) continue;
      return {
        mechanism: "prime",
        rewardToken: entry.rewardToken,
        payoutWei: entry.amount,
        bnbValueWei: venusRewardValueInBnbWei(
          entry.amount,
          market.spotPrice,
          bnbMarket.spotPrice,
        ),
        vToken: entry.vToken,
        markets: [entry.vToken],
      };
    }
  }

  // XVS, simulated over the OWNER'S OWN market list — the identical array the
  // submission will use.
  const markets = reading.markets
    .filter(
      (market) =>
        market.listed
        && (namesMarket(settings.debtMarkets, market.vToken)
          || namesMarket(settings.collateralMarkets, market.vToken)),
    )
    .map((market) => market.vToken);
  if (markets.length === 0) return null;
  const xvsMarket = reading.markets.find(
    (market) => market.vTokenSymbol.toLowerCase() === "vxvs",
  );
  if (xvsMarket === undefined || xvsMarket.underlying === null) return null;
  let payout = 0n;
  try {
    payout = await deps.readers.simulateXvsClaim(
      agent.ownerAddress,
      markets,
      xvsMarket.underlying,
    );
  } catch {
    return null;
  }
  if (payout <= 0n || xvsMarket.spotPrice <= 0n) return null;
  return {
    mechanism: "xvs",
    rewardToken: xvsMarket.underlying,
    payoutWei: payout,
    bnbValueWei: venusRewardValueInBnbWei(
      payout,
      xvsMarket.spotPrice,
      bnbMarket.spotPrice,
    ),
    markets,
  };
}

type ClaimRepayGate =
  | { readonly kind: "ready"; readonly debtMarket: VenusMarketReading }
  | {
      readonly kind: "refused";
      readonly condition: VenusCondition;
      readonly detail: string;
    };

/**
 * ONE atomic pre-flight gate before leg 1 (R2.15/R19a).
 *
 * Every condition is asserted BEFORE the irreversible claim: the reward token
 * equals the underlying of a market IN `debtMarkets`, that market is in the
 * grant, repay is not paused there, `borrowCurrent > 0`, and the quota admits
 * BOTH legs. Any failure is ZERO submissions — checking after the claim would
 * mean the fee is already spent for nothing.
 *
 * Cross-token claim-to-repay is DROPPED from v1 entirely (locked decision 3):
 * a token mismatch is the typed refusal `reward-debt-token-mismatch`, not a
 * swap this plane does not quote.
 */
function claimRepayGate(
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  reading: VenusAccountReading,
  candidate: ClaimCandidate,
  claimsUsed: number,
): ClaimRepayGate {
  // BOTH legs need a slot: the claim and the repay are two submissions.
  if (claimsUsed + 2 > settings.maxClaimsPerDay) {
    return {
      kind: "refused",
      condition: "quota-exhausted",
      detail:
        `A claim-repay is two submissions; ${claimsUsed} of ${settings.maxClaimsPerDay} ` +
        "claim slots are used and both legs must fit before either fires.",
    };
  }
  const debtMarket = reading.markets.find(
    (market) =>
      market.underlying !== null
      && market.underlying.toLowerCase() === candidate.rewardToken.toLowerCase(),
  );
  if (debtMarket === undefined) {
    return {
      kind: "refused",
      condition: "reward-debt-token-mismatch",
      detail:
        `The reward token ${candidate.rewardToken} is not the underlying of any read ` +
        "market. Cross-token claim-to-repay is dropped from v1 entirely.",
    };
  }
  if (!namesMarket(settings.debtMarkets, debtMarket.vToken)) {
    return {
      kind: "refused",
      condition: "market-not-in-settings",
      detail: `${debtMarket.vToken} is not in the owner's debtMarkets.`,
    };
  }
  const spec = agent.sessionFacts?.spec ?? null;
  if (spec === null || !grantsVenusMarket(spec, debtMarket.vToken)) {
    return {
      kind: "refused",
      condition: "market-not-in-grant",
      detail: `The session grant does not name ${debtMarket.vToken}.`,
    };
  }
  if (debtMarket.repayPaused) {
    return {
      kind: "refused",
      condition: "action-paused",
      detail: `repay is paused on ${debtMarket.vToken}.`,
    };
  }
  if ((debtMarket.borrowCurrent ?? debtMarket.borrowStored) <= 0n) {
    return {
      kind: "refused",
      condition: "hf-above-trigger",
      detail: `There is no debt in ${debtMarket.vToken} to repay the claim into.`,
    };
  }
  return { kind: "ready", debtMarket };
}

/** A plain claim: ONE submission, effect-verified against the reward balance. */
async function runClaim(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  candidate: ClaimCandidate,
): Promise<VenusWorkerAgentOutcome> {
  const facts = agent.sessionFacts;
  if (facts === null) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "session-expired-or-revoked",
      reason: "The agent has no granted session.",
    };
  }
  const before = await deps.readers.readTokenBalance(
    agent.ownerAddress,
    candidate.rewardToken,
  );
  const calls =
    candidate.mechanism === "prime"
      ? buildVenusClaimInterestCall(
          deps.venue.prime,
          candidate.vToken as Address,
          agent.ownerAddress,
        )
      : buildVenusClaimVenusCall(
          deps.venue.comptroller,
          agent.ownerAddress,
          candidate.markets,
        );
  const result = await submitVenusCalls(
    deps,
    agent,
    settings,
    "venusClaim",
    calls,
    0n,
  );
  if (result.outcome !== null) return result.outcome;
  const after = await deps.readers.readTokenBalance(
    agent.ownerAddress,
    candidate.rewardToken,
  );
  const received = after > before ? after - before : 0n;
  return {
    agentId: agent.id,
    action: received > 0n ? "dispatched" : "hold",
    ...(received > 0n ? {} : { condition: "no-effect" as const }),
    kind: "venusClaim",
    amountWei: received,
    receiptStatus: "CONFIRMED",
    effect: received > 0n ? "changed" : "no-effect",
    journalKey: result.idempotencyKey,
    reason:
      received > 0n
        ? `Claimed ${received} of ${candidate.rewardToken}; proceeds are in the owner's EOA.`
        : "The receipt CONFIRMED and the reward balance did not move; the accounting row " +
          "keeps its slot because the submission drew relay gas.",
  };
}

/**
 * Claim then repay, as TWO journal entries.
 *
 * The repay leg is gated on the claim leg's VERIFIED receipt and re-reads the
 * ACTUAL RECEIVED BALANCE — never the simulated payout. Its failure taxonomy is
 * explicit and the answer is benign: a failed second leg leaves the claim
 * proceeds safely in the owner's own EOA, which is where `claimVenus` and
 * `claimInterest` pay in the first place. Nothing is stranded anywhere the
 * owner cannot reach.
 */
async function runClaimRepay(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  candidate: ClaimCandidate,
  debtMarket: VenusMarketReading,
): Promise<VenusWorkerAgentOutcome> {
  const before = await deps.readers.readTokenBalance(
    agent.ownerAddress,
    candidate.rewardToken,
  );
  const claimCalls =
    candidate.mechanism === "prime"
      ? buildVenusClaimInterestCall(
          deps.venue.prime,
          candidate.vToken as Address,
          agent.ownerAddress,
        )
      : buildVenusClaimVenusCall(
          deps.venue.comptroller,
          agent.ownerAddress,
          candidate.markets,
        );
  const legOne = await submitVenusCalls(
    deps,
    agent,
    settings,
    "venusClaimRepayLeg",
    claimCalls,
    0n,
  );
  if (legOne.outcome !== null) return legOne.outcome;

  const after = await deps.readers.readTokenBalance(
    agent.ownerAddress,
    candidate.rewardToken,
  );
  const received = after > before ? after - before : 0n;
  if (received <= 0n) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "no-effect",
      kind: "venusClaimRepayLeg",
      effect: "no-effect",
      journalKey: legOne.idempotencyKey,
      reason:
        "The claim leg CONFIRMED with zero effect, so there is nothing to repay. The " +
        "second leg is not submitted and no proceeds are anywhere but the owner's EOA.",
    };
  }

  // The repay leg is sized on what ACTUALLY ARRIVED, clamped by the market's
  // own live debt — a repay past `borrowCurrent` is refunded by Venus, but
  // metering the owner's cap for it is a cost with no benefit.
  let borrowNow: bigint;
  try {
    borrowNow = await deps.readers.readBorrowCurrent(
      agent.ownerAddress,
      debtMarket.vToken,
    );
  } catch {
    borrowNow = debtMarket.borrowCurrent ?? debtMarket.borrowStored;
  }
  const amount = received < borrowNow ? received : borrowNow;
  if (amount <= 0n) {
    return {
      agentId: agent.id,
      action: "hold",
      condition: "hf-above-trigger",
      kind: "venusClaimRepayLeg",
      journalKey: legOne.idempotencyKey,
      reason:
        "The debt was cleared between the two legs; the claim proceeds stay in the " +
        "owner's EOA and nothing further is submitted.",
    };
  }
  const repayCalls = buildVenusRepayCalls({
    vToken: debtMarket.vToken,
    underlying: debtMarket.underlying,
    amountWei: amount,
    currentAllowanceWei: debtMarket.allowance,
  });
  const legTwo = await submitVenusCalls(
    deps,
    agent,
    settings,
    "venusClaimRepayLeg",
    repayCalls,
    debtMarket.native ? amount : 0n,
  );
  if (legTwo.outcome !== null) return legTwo.outcome;
  return {
    agentId: agent.id,
    action: "dispatched",
    kind: "venusClaimRepayLeg",
    vToken: debtMarket.vToken,
    amountWei: amount,
    receiptStatus: "CONFIRMED",
    effect: "changed",
    journalKey: legTwo.idempotencyKey,
    reason: `Claimed ${received} and repaid ${amount} into ${debtMarket.vToken}.`,
  };
}

/**
 * The shared submit for the claim kinds: charge → journal → preflight → submit.
 *
 * Returns `{outcome: null}` on a CONFIRMED receipt so the caller can do its own
 * effect verification, and a fully-formed outcome on every refusal or ambiguity.
 */
async function submitVenusCalls(
  deps: VenusWorkerDeps,
  agent: AgentRecord,
  settings: VenusAutomationSettings,
  kind: VenusActionKind,
  calls: readonly WalletCall[],
  nativeSpendWei: bigint,
): Promise<{
  readonly idempotencyKey: string;
  readonly outcome: VenusWorkerAgentOutcome | null;
}> {
  const facts = agent.sessionFacts;
  const nowMs = deps.now();
  const decisionId = venusDecisionId(agent.id, kind, nowMs);
  const idempotencyKey = `${agent.id}:${decisionId}`;
  if (facts === null) {
    return {
      idempotencyKey,
      outcome: {
        agentId: agent.id,
        action: "hold",
        condition: "session-expired-or-revoked",
        reason: "The agent has no granted session.",
      },
    };
  }
  try {
    await deps.actions.charge({
      ownerAddress: agent.ownerAddress,
      agentId: agent.id,
      actionId: idempotencyKey,
      kind,
      maxClaimsPerDay: settings.maxClaimsPerDay,
    });
  } catch (error) {
    if (error instanceof VenusClaimQuotaError) {
      return {
        idempotencyKey,
        outcome: {
          agentId: agent.id,
          action: "hold",
          condition: "quota-exhausted",
          reason: sanitizeMessage(error.message),
        },
      };
    }
    throw error;
  }

  await deps.journal.begin({
    idempotencyKey,
    agentId: agent.id,
    ownerAddress: agent.ownerAddress,
    kind,
    decisionId,
    externalRef: { publicKey: facts.publicKey },
    nativeSpendWei,
  });

  let session: SessionRef;
  try {
    session = await withSessionKey(deps.agentStore, agent, (authority) =>
      Promise.resolve(
        deps.provider.restoreSession({
          spec: facts.spec,
          agent: authority,
          walletAddress: agent.walletAddress,
          publicKey: facts.publicKey,
          expiresAt: facts.expiry,
        }),
      ),
    );
    await deps.provider.preflightExecute({ session, calls });
  } catch (error) {
    const refusal = asPlaneError(error, "venus claim refused");
    await deps.journal.markRolledBack(
      idempotencyKey,
      sanitizeMessage(`Refused before submission: ${refusal.code}.`),
    );
    return {
      idempotencyKey,
      outcome: {
        agentId: agent.id,
        action: "hold",
        condition: "market-not-in-grant",
        kind,
        journalKey: idempotencyKey,
        reason: sanitizeMessage(`${refusal.code}: ${refusal.message}`),
      },
    };
  }

  let receipt: ExecutionReceipt;
  try {
    receipt = await deps.provider.executeViaSession({
      session,
      calls,
      bypassLocalPolicyCheck: false,
    });
  } catch (error) {
    const mapped = asPlaneError(error, "venus claim failed");
    await deps.journal.markUnknown(idempotencyKey, sanitizeMessage(mapped.message));
    return {
      idempotencyKey,
      outcome: {
        agentId: agent.id,
        action: "hold",
        condition: "unknown-held",
        kind,
        journalKey: idempotencyKey,
        reason:
          "Submission outcome is UNKNOWN and is held. Nothing resolves a Venus UNKNOWN " +
          "automatically in v1; claim legs are disabled until an owner-signed resolver ships.",
      },
    };
  }

  if (receipt.callsId !== undefined) {
    await deps.journal.markInProgress(idempotencyKey, { callsId: receipt.callsId });
  }
  if (receipt.status === "PENDING") {
    await deps.journal.markUnknown(
      idempotencyKey,
      "The relay returned PENDING; the submission window is ambiguous.",
    );
    return {
      idempotencyKey,
      outcome: {
        agentId: agent.id,
        action: "hold",
        condition: "unknown-held",
        kind,
        receiptStatus: receipt.status,
        journalKey: idempotencyKey,
        reason: "The relay returned PENDING; the row is held as UNKNOWN.",
      },
    };
  }
  if (receipt.status === "FAILED") {
    await deps.journal.markRolledBack(
      idempotencyKey,
      sanitizeMessage(receipt.failureCode ?? "Execution reported FAILED."),
    );
    return {
      idempotencyKey,
      outcome: {
        agentId: agent.id,
        action: "hold",
        condition: "transport",
        kind,
        receiptStatus: receipt.status,
        journalKey: idempotencyKey,
        reason: sanitizeMessage(
          `The relay reported FAILED (${receipt.failureCode ?? "no code"}).`,
        ),
      },
    };
  }
  await deps.journal.markCommitted(
    idempotencyKey,
    receipt.transactionHash === undefined
      ? {}
      : { txHash: receipt.transactionHash },
  );
  return { idempotencyKey, outcome: null };
}

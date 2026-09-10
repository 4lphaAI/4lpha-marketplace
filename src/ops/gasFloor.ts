/**
 * AGENT-GAS-ATTENTION §1 — THE ONE PLACE AN AGENT'S GAS FLOOR IS COMPUTED.
 *
 * ═══ WHAT THIS EXISTS TO STOP ═════════════════════════════════════════════
 *
 * Measured on Railway 2026-09-10: an agent that cannot pay the relay keeps its
 * full worker cadence. Every 30 s it reads pool state, positions, fees and two
 * quotes, decides a motion, opens a sequence, and is refused — 2,880 times a
 * day, per position, moving no money. That is the (az) churn shape
 * (`src/lp/worker.ts:1385`, "sixteen rolled-back rows in eight minutes, zero
 * money moved") and the RPC and Railway bill are real.
 *
 * Before this module the ONLY gas gate in the plane was
 * {@link gridShiftGasGate} — the grid SHIFT lane, and nothing else. An LP
 * rotate, a trade exit and a Venus rescue all reached the relay on a hope.
 *
 * ═══ THE THRESHOLDS, AND WHY THEY ARE MOTION-RELATIVE ═════════════════════
 *
 * Operator ruling 2026-09-10. The first proposal was a flat USD pair
 * ($0.10 warn / $0.05 stop) and it was WITHDRAWN for a measured reason: one
 * grid shift already costs ~0.00015 BNB ≈ $0.106 at $708/BNB, so a $0.05 stop
 * would only ever fire AFTER the agent had already been unable to act, and a
 * fixed dollar figure silently decays as the BNB price or the gas regime moves.
 * A motion is also not one price: a shift reserves 4 fee units, an LP rotate 3,
 * a trade exit 1, a Venus rescue 2.
 *
 * So the thresholds are multiples of the agent's OWN motions:
 *
 *   warnWei  = 3 x nextMotionWei   ← "three more turns left" — tell the owner
 *   blockWei = 1 x minMotionWei    ← "cannot afford ANY turn" — stand down
 *
 * ═══ WHY blockWei IS THE *CHEAPEST* MOTION, NOT THE NEXT ONE ══════════════
 *
 * REVIEW FINDING 1 (Codex gpt-6-astra, xhigh, 2026-09-10), and it was a real
 * money defect rather than a nicety. The first build blocked the whole position
 * below ONE DISCRETIONARY motion — 3 fee units for an LP rotate, 4 for a shift.
 * A PROTECT exit costs {@link PROTECT_SUBMISSIONS_PER_POSITION} = 2. So a wallet
 * holding exactly 2 units could still pay to honour a breached stop-loss, and
 * the gate skipped the position before the protect trigger was ever evaluated.
 *
 * A gate written to save RPC was therefore suppressing the one motion that
 * exists to save the owner's money. Standing down must mean "can afford
 * NOTHING", never "cannot afford the most expensive thing".
 *
 * The two figures are both published, and they gate different things:
 *
 *   minMotionWei      the cheapest USEFUL motion — the worker's stand-down line
 *   nextMotionWei     the discretionary motion (rotate/harvest/shift/flip) —
 *                     refused at DISPATCH, after the trigger has spoken
 *
 * ═══ THE IDENTITY THE REVIEW MUST CHECK ═══════════════════════════════════
 *
 * For grid `shift`, `nextMotionWei` is EXACTLY the figure `gridShiftGasGate` has
 * held under since GRID-GAS-RESERVE P2: `MAX_SUBMISSIONS_PER_GRID_SHIFT x
 * relayFeePerSubmitWei`. That identity is deliberate and load-bearing — it is
 * what makes this change a GENERALISATION of the one shipped gate rather than
 * a second, disagreeing opinion about the same wallet. `test/gasFloor.test.ts`
 * pins it as a regression. If it ever stops holding, this module is wrong and
 * the constant is right.
 *
 * ═══ NO NEW NUMBERS ═══════════════════════════════════════════════════════
 *
 * Every `nextMotionWei` term is the constant the sizing path ALREADY reserves
 * for that motion. Nothing here is invented, and nothing here is
 * env-overridable beyond what those constants already allow — a deployment
 * that could lower a guarantee-shaped floor from the environment could quietly
 * disarm it (`policy.ts:2348`, the same reasoning applied to this seam).
 *
 * Pure: no I/O, no clock, no chain read. Every quantity is an argument.
 */
import type { HttpRuntimeProfile } from "../auth/runtimeAuth.js";
import type { LpGridMode } from "../lp/triggers.js";
import {
  MAX_SUBMISSIONS_PER_GRID_FLIP,
  MAX_SUBMISSIONS_PER_GRID_RECENTER,
  MAX_SUBMISSIONS_PER_GRID_SHIFT,
  MAX_SUBMISSIONS_PER_SEQUENCE,
  PROTECT_SUBMISSIONS_PER_POSITION,
  RELAY_FEE_PER_EXIT_WEI,
  walletNativeFloorWei,
} from "./policy.js";

/**
 * The hard ceiling on how long a funded wallet can stay asleep, in ms.
 *
 * REVIEW FINDING 6. The ladder counts INTERVALS, and the two daemons do not
 * share one: the LP worker's default is 30 s (60 intervals = 30 min, as the
 * plan said) but the trade worker's is 60 s, which made its deepest wait SIXTY
 * minutes against a plan that promised thirty. A recovery bound stated in the
 * owner-facing docs must be a WALL-CLOCK bound, not a count of something each
 * daemon sizes differently.
 */
export const AGENT_GAS_MAX_BACKOFF_MS = 30 * 60 * 1_000;

/** Motions' worth of native that still reads as "low, but working". */
export const AGENT_GAS_WARN_MOTIONS = 3n;

/** Motions' worth of native below which the agent cannot act at all. */
export const AGENT_GAS_BLOCK_MOTIONS = 1n;

/**
 * Whether a short wallet may STOP this agent, or only warn about it.
 *
 * `"warn-only"` exists for exactly one profile and it is not a preference.
 * `src/lending/sizing.ts:27` rule 2 is normative — *"A floor-clamped rescue
 * SUBMITS THE REDUCED AMOUNT, never refuses"* — because a Venus guard exists to
 * stop a liquidation, and refusing to try for want of gas is the precise trap
 * Phase 4 was built to avoid. A guard that stands down politely while its
 * subject is liquidated has failed at the only thing it does.
 *
 * Encoded as DATA rather than left to each caller's memory, so a build that
 * blocks lending contradicts a value it can see rather than a comment it did
 * not read.
 */
export type AgentGasEnforcement = "block" | "warn-only";

export type AgentGasFloor = {
  /**
   * Native the relay bills for one DISCRETIONARY motion — a rotate, a harvest,
   * a shift, a flip, a trade entry. What a motion is refused against at
   * DISPATCH, and the unit `warnWei` counts.
   */
  readonly nextMotionWei: bigint;
  /**
   * Native the relay bills for the CHEAPEST motion still worth making — for
   * `lp-v1`, a protect exit. What the worker stands the agent down under.
   * Never greater than {@link nextMotionWei}.
   */
  readonly minMotionWei: bigint;
  /** Below this, the owner is told. Three discretionary motions' worth. */
  readonly warnWei: bigint;
  /** Below this the agent can afford NOTHING. Equal to {@link minMotionWei}. */
  readonly blockWei: bigint;
  readonly enforcement: AgentGasEnforcement;
};

export type AgentGasFloorInput = {
  readonly profile: HttpRuntimeProfile;
  /**
   * The grid mode for an `lp-v1` agent, or `null` when it runs no grid (a
   * plain rotate/harvest LP agent). Ignored for every other profile.
   */
  readonly gridMode?: LpGridMode | null;
  /**
   * `LP_RELAY_FEE_PER_SUBMIT_WEI` as the deployment resolved it. Required for
   * `lp-v1`; the trade and Venus floors rest on {@link RELAY_FEE_PER_EXIT_WEI},
   * which is deliberately not env-overridable.
   */
  readonly relayFeePerSubmitWei?: bigint | undefined;
};

/**
 * The fee UNITS one motion of an `lp-v1` agent reserves, by grid mode.
 *
 * EXHAUSTIVE over {@link LpGridMode} with a `never` binding, for the reason
 * `gridModeAdmitsImport` gives at `gridTriggers.ts`: a fifth mode must be a
 * COMPILE ERROR here, not a silent fall-through onto whichever branch happens
 * to be last. Silent inheritance is how a lane ends up priced as something it
 * is not.
 */
function lpMotionUnits(mode: LpGridMode | null): number {
  if (mode === null) return MAX_SUBMISSIONS_PER_SEQUENCE;
  switch (mode) {
    case "shift":
      return MAX_SUBMISSIONS_PER_GRID_SHIFT;
    case "ladder":
      return MAX_SUBMISSIONS_PER_GRID_RECENTER;
    case "fixed":
    case "policy":
      return MAX_SUBMISSIONS_PER_GRID_FLIP;
    default: {
      const never: never = mode;
      throw new Error(`Unhandled LP grid mode: ${String(never)}`);
    }
  }
}

/**
 * The floor for one agent, or `null` when the profile runs no worker at all
 * (`unbound-v1`, `raw-v1`).
 *
 * `null` rather than a zero floor, and rather than a default: a profile with no
 * autonomous motion has no "next motion" to price, and inventing one would put
 * a number on a page that no source supports. The read side renders `null` as a
 * dash with a reason.
 *
 * `null` ALSO when an `lp-v1` agent's deployment supplied no relay fee: the
 * same posture `gridShiftGasGate` takes on an absent fee. A floor nobody can
 * size is not a floor of zero.
 */
export function agentGasFloor(input: AgentGasFloorInput): AgentGasFloor | null {
  switch (input.profile) {
    case "lp-v1": {
      const perSubmit = input.relayFeePerSubmitWei;
      if (perSubmit === undefined || perSubmit <= 0n) return null;
      const nextMotionWei = BigInt(lpMotionUnits(input.gridMode ?? null)) * perSubmit;
      // The cheapest motion an LP agent can still make is a PROTECT exit, and
      // it costs the same 2 units in every grid mode — which is why the
      // stand-down line is mode-independent and can be applied before the
      // owner's settings have even been read (REVIEW FINDING 8).
      const minMotionWei = BigInt(PROTECT_SUBMISSIONS_PER_POSITION) * perSubmit;
      return floorFrom(nextMotionWei, minMotionWei, "block");
    }
    case "trade-v1":
      // One exit's relay reimbursement. `nativeReserveFloor` reserves
      // `grantedTokenCount` of these across the DAY; one motion is one.
      //
      // min === next here, and deliberately: a trade agent's cheapest motion IS
      // its protective one (the exit), so there is no cheaper tier to preserve.
      return floorFrom(RELAY_FEE_PER_EXIT_WEI, RELAY_FEE_PER_EXIT_WEI, "block");
    case "venus-v1":
      // The floor the rescue sizing already subtracts, and WARN-ONLY: see
      // {@link AgentGasEnforcement}. min === next: a rescue is the only motion.
      return floorFrom(walletNativeFloorWei(), walletNativeFloorWei(), "warn-only");
    case "unbound-v1":
    case "raw-v1":
      return null;
    default: {
      const never: never = input.profile;
      throw new Error(`Unhandled runtime profile: ${String(never)}`);
    }
  }
}

function floorFrom(
  nextMotionWei: bigint,
  minMotionWei: bigint,
  enforcement: AgentGasEnforcement,
): AgentGasFloor {
  if (minMotionWei > nextMotionWei) {
    // A cheapest motion dearer than the discretionary one is a contradiction,
    // and it would make `blockWei > warnWei / 3` — an agent stood down while
    // the page still called it healthy. Refuse rather than publish it.
    throw new Error("agentGasFloor: minMotionWei must not exceed nextMotionWei.");
  }
  return {
    nextMotionWei,
    minMotionWei,
    warnWei: AGENT_GAS_WARN_MOTIONS * nextMotionWei,
    blockWei: AGENT_GAS_BLOCK_MOTIONS * minMotionWei,
    enforcement,
  };
}

/**
 * What the wallet's native balance says about this agent.
 *
 * `"unknown"` is NOT `"ok"` and it is NOT `"blocked"`: it is the absence of a
 * reading, and the two sides answer it differently on purpose —
 *
 *   - the WORKER treats unknown as blocked (fail closed, the 3.19 posture at
 *     `worker.ts:2260`): a hold costs one free cycle and decides nothing;
 *   - the READ side renders unknown as a DASH WITH A REASON, never a zero and
 *     never a warning, because a page that invents a state is worse than a page
 *     that admits it could not read one.
 *
 * Boundaries follow `gridShiftGasGate` exactly — `hold` there is
 * `nativeWei < requiredWei` — so a wallet holding EXACTLY one motion's gas is
 * not blocked, and one holding exactly `warnWei` is not low.
 */
export type AgentGasState = "unknown" | "blocked" | "low" | "ok";

export function classifyAgentGas(input: {
  readonly nativeWei: bigint | undefined;
  readonly floor: AgentGasFloor | null;
}): AgentGasState {
  if (input.floor === null || input.nativeWei === undefined) return "unknown";
  if (input.nativeWei < input.floor.blockWei) return "blocked";
  if (input.nativeWei < input.floor.warnWei) return "low";
  return "ok";
}

/** Wei as BNB with seven fractional digits, for owner-facing text. */
function bnb(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString(10).padStart(18, "0").slice(0, 7);
  return `${whole}.${fraction}`;
}

/**
 * The owner-facing sentence for a `low` or `blocked` agent.
 *
 * THE REMEDY COMES FIRST, and that ordering is a shipped lesson rather than a
 * style choice: `sanitizeMessage` caps every message at 280 chars platform-wide
 * and a remedy-last text lost its remedy at the saga seam (PHASE3.13 F12-b, the
 * same discipline `lpGridShiftGasHoldReason` follows).
 *
 * `walletAddress` is included because the owner's actual next action is a
 * transfer, and a remedy that does not say WHERE is not a remedy.
 */
export function agentGasReason(input: {
  readonly state: AgentGasState;
  readonly floor: AgentGasFloor | null;
  readonly nativeWei: bigint | undefined;
  readonly walletAddress: string;
}): string {
  if (input.floor === null) {
    return (
      "Gas floor unavailable: this agent's next-motion relay cost cannot be sized, "
      + "so its wallet balance proves nothing. Nothing is spent and no quota is used."
    );
  }
  if (input.nativeWei === undefined) {
    return (
      `Deposit BNB to ${input.walletAddress} — the next motion needs at least `
      + `${bnb(input.floor.blockWei)} BNB for relay gas and the wallet's balance could not be read `
      + `this cycle. Nothing is spent and no quota is used.`
    );
  }
  const shortfall =
    input.nativeWei < input.floor.blockWei ? input.floor.blockWei - input.nativeWei : 0n;
  // A `warn-only` profile is NEVER stood down (see {@link AgentGasEnforcement}),
  // so its text must never promise that it will be — REVIEW FINDING 5, where
  // the Account row told a Venus owner their guard was "standing by" while the
  // worker was in fact still trying to rescue them.
  const warnOnly = input.floor.enforcement === "warn-only";
  if (input.state === "blocked" && !warnOnly) {
    return (
      `Deposit at least ${bnb(shortfall)} BNB to ${input.walletAddress}. The cheapest action `
      + `needs ${bnb(input.floor.blockWei)} BNB for relay gas; the wallet holds `
      + `${bnb(input.nativeWei)} BNB, so the agent is standing by. It resumes by itself once `
      + `funded — no signature needed.`
    );
  }
  if (warnOnly) {
    return (
      `Deposit BNB to ${input.walletAddress}: it holds ${bnb(input.nativeWei)} BNB against the `
      + `${bnb(input.floor.nextMotionWei)} BNB a rescue costs in relay gas. The guard KEEPS `
      + `TRYING and will submit a reduced repay rather than refuse — it is never stood down.`
    );
  }
  // `nextMotionWei` is positive by construction (`agentGasFloor` builds it from
  // a positive fee and a positive unit count), but the division is guarded
  // anyway: a "how many turns left" sentence is not worth a crash.
  const turns = input.floor.nextMotionWei > 0n ? input.nativeWei / input.floor.nextMotionWei : 0n;
  return (
    `Top up ${input.walletAddress} soon: it holds ${bnb(input.nativeWei)} BNB, about `
    + `${turns} more motion(s) of relay gas. Below ${bnb(input.floor.blockWei)} BNB the agent `
    + `stands by until it is funded.`
  );
}

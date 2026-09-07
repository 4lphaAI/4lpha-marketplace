/**
 * The lending guard — shared types and the CLOSED condition taxonomy
 * (MARKETPLACE-LENDING-AGENT §5.7, amended by R2.6, R2.13, R3.5, R3.11, R3.12).
 *
 * The guard reuses Phase 4's risk reconstruction, its trigger and its sizing
 * form, so it reuses Phase 4's condition names wherever they mean the same
 * thing. What it does NOT reuse is the taxonomy object: `VenusCondition` is a
 * closed union that the Venus worker branches on and the Venus owner view
 * renders, and widening it would make every Venus surface responsible for
 * lending-only members it can never produce. So this module declares its own
 * closed set, RE-DECLARING the inherited names verbatim, and
 * {@link lendingConditionFromVenus} is the one translation seam.
 *
 * A condition the code does not recognize maps to a fail-closed member plus
 * owner surfacing — never to a guessed action. That rule is Phase 4's and it is
 * why the set is closed on purpose.
 */
import type { Address, Hex } from "viem";
import type { VenusCondition } from "../venus/types.js";

/* -------------------------------------------------------------------------- */
/* The condition taxonomy                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The closed condition set. Members are `kebab-case` because they are rendered
 * verbatim on the owner view and in operator output.
 *
 * The first block is INHERITED from `VENUS_CONDITIONS` and means exactly what
 * it means there. The second block is this phase's own.
 */
export const LENDING_CONDITIONS = [
  /* ---- inherited from Phase 4, same meaning ---- */
  "hf-above-trigger",
  "awaiting-confirmation",
  "observation-stale",
  "protocol-mismatch",
  "emode-unverified",
  "snapshot-error",
  "protocol-error",
  "protocol-paused",
  "action-paused",
  "oracle-invalid",
  "position-liquidated",
  "no-effect",
  "cooldown",
  "killswitch",
  "session-expiring",
  "session-expired-or-revoked",
  "unknown-held",
  "transport",
  "settings-absent",
  "market-not-in-grant",
  "market-delisted",
  "insufficient-wallet-balance",

  /* ---- this phase's own ---- */
  /** A repaid everything on every pinned market. Armed, idle, and says so. */
  "guarded-no-debt",
  /** A carries debt in markets v1 cannot repay. Lists them; never a refusal. */
  "unsupported-debt",
  /** Reserve capacity is below the largest debt's `maxPerAction`. */
  "reserve-low",
  /** Reserve capacity is zero: nothing left to rescue with. */
  "reserve-depleted",
  /** `cash < suppliedUsdt`: the whole supply is not redeemable in one go. */
  "pool-cash-low",
  /** A retire could only redeem part of the supply; the rest stays on Venus. */
  "pool-cash-short",
  /** The arm's submission was ambiguous. Rescues continue; a second arm never does. */
  "arm-unknown",
  /** The retire's submission was ambiguous. Retire blocked; rescues continue. */
  "retire-unknown",
  /** A partial rescue was SUBMITTED, with figures. Never a refusal. */
  "insufficient-reserve",
  /** The USDT rolling-day cap is spent. Remedy: wait, or re-hire. */
  "usdt-cap-exhausted",
  /** The native rolling-day cap is spent. */
  "native-cap-exhausted",
  /** A spend meter could not be read. The term is OMITTED, never fail-closed (R3.5). */
  "cap-unreadable",
  /** A's debt fell between the sizing read and inclusion; the repay reverted (R2.6). */
  "borrow-moved",
  /** A entered more markets than the guard can price (R3.11). */
  "account-too-complex",
  /** An `arming` row whose submission never happened, converged by the worker (R3.4). */
  "arm-never-submitted",
  /** The reserve was recovered by the owner's passkey; the guard closed itself. */
  "recovered-by-owner",
  /** `LENDING_ENABLED` is off; nothing is armed and nothing runs. */
  "lending-disabled",
] as const;

export type LendingCondition = (typeof LENDING_CONDITIONS)[number];

const CONDITION_SET: ReadonlySet<string> = new Set<string>(LENDING_CONDITIONS);

/** One surfaced condition, with the figures that make it actionable. */
export type LendingConditionReport = {
  readonly condition: LendingCondition;
  /** Sanitized prose. Callers branch on `condition`, never on this text. */
  readonly detail: string;
  /** The vToken this condition is about, when it is about one (R2.13). */
  readonly market?: Address;
};

export function lendingCondition(
  condition: LendingCondition,
  detail: string,
  market?: Address,
): LendingConditionReport {
  return { condition, detail, ...(market === undefined ? {} : { market }) };
}

/**
 * The fail-closed member for a condition the code does not recognize.
 *
 * A caller that receives an unmodelled string MUST route it here rather than
 * inventing a member: the taxonomy being closed is what lets the owner view
 * render it, and an unrecognized condition is by definition one nobody has
 * reasoned about.
 */
export function lendingConditionOrFailClosed(
  candidate: string,
  detail: string,
  market?: Address,
): LendingConditionReport {
  if (CONDITION_SET.has(candidate)) {
    return lendingCondition(candidate as LendingCondition, detail, market);
  }
  return lendingCondition(
    "transport",
    `Unrecognized condition "${candidate}" — failing closed. ${detail}`,
    market,
  );
}

/**
 * Translate a Phase 4 condition into this phase's taxonomy.
 *
 * The ONE seam. Names that exist in both sets pass through verbatim; anything
 * Phase 4 can produce and this phase does not model (`market-not-in-settings`,
 * `native-collateral-trapped`, the claim family) falls through
 * {@link lendingConditionOrFailClosed} and lands on `transport` — fail-closed,
 * surfaced, and never silently dropped.
 */
export function lendingConditionFromVenus(
  condition: VenusCondition,
  detail: string,
  market?: Address,
): LendingConditionReport {
  return lendingConditionOrFailClosed(condition, detail, market);
}

/* -------------------------------------------------------------------------- */
/* Guard lifecycle                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The guard row's status enum (§8.1, amended by R3.3 and R3.4).
 *
 * `provisioning-guard` is a PRE-ARM status materialized at convergence from
 * `PendingGrant.initialLendingHire`, so the row that carries `guardedAccount`
 * is written inside `createProvisioningAgent`'s CAS and not by a second
 * statement nobody can make atomic with it (R3.3, closing REVIEW2 H3).
 *
 * `arming` HAS A DOOR (R3.4, closing REVIEW2 H4): the worker scans it, and an
 * `arming` row with no non-terminal `"lending"` journal row and an
 * `updated_at` older than one interval converges to `closed` with
 * `closeReason: "arm-never-submitted"`. Without that door a crash between the
 * fence commit and `journal.begin` bricks the guard — the PHASE3.11 /
 * PHASE3.14 failure family, which this repo has now paid for three times.
 */
export const LENDING_GUARD_STATUSES = [
  "provisioning-guard",
  "arming",
  "armed",
  "held",
  "retiring",
  "retired",
  "closed",
] as const;

export type LendingGuardStatus = (typeof LENDING_GUARD_STATUSES)[number];

/** Statuses from which no path may act. Retire and the worker both stop here. */
export const LENDING_TERMINAL_STATUSES: ReadonlySet<LendingGuardStatus> =
  new Set<LendingGuardStatus>(["retired", "closed"]);

/**
 * The reasons a guard row can reach `closed` or `retired`, closed as a union so
 * the owner view can render each and the status-reachability test can
 * enumerate them.
 */
export const LENDING_CLOSE_REASONS = [
  "arm-rolled-back",
  "arm-never-submitted",
  "retired",
  "recovered-by-owner",
] as const;

export type LendingCloseReason = (typeof LENDING_CLOSE_REASONS)[number];

/** The hold a `held` guard carries. Exactly one at a time (§5.6). */
export const LENDING_HOLDS = ["arm-unknown", "retire-unknown", "account-too-complex"] as const;
export type LendingHold = (typeof LENDING_HOLDS)[number];

/* -------------------------------------------------------------------------- */
/* Chain reading shapes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Wallet B's reserve, at ONE pinned finalized block (R2.9, amended by R3.9).
 *
 * Both allowances are READ. `usdtAllowanceToVUsdt` is a BUILDER INPUT — the
 * vUSDT approve pair is hand-built and its zero-first leg is emitted iff this
 * is non-zero, which is where PHASE4-AUDIT A2's mechanism actually bites (a
 * failOpaque `no-effect` repay leaves the approve standing, and BSC-USDT
 * reverts a non-zero -> non-zero approve). `usdtAllowanceToRouter` is REPORTED
 * and not consumed: the router legs use `buildPancakeV3Sell`/`Buy` VERBATIM and
 * that builder's zero-leg is unconditional by construction (R3.9).
 */
export type LendingReserveReading = {
  readonly blockNumber: bigint;
  readonly wallet: Address;
  /** `USDT.balanceOf(B)` — idle, unsupplied reserve. */
  readonly usdtBalance: bigint;
  /** `vUSDT.balanceOf(B)`. */
  readonly vUsdtBalance: bigint;
  /** `vUSDT.exchangeRateStored()` — the LOWER bound; xr only rises. */
  readonly exchangeRateStored: bigint;
  /** `vUSDT.exchangeRateCurrent()` by simulation; `null` when it failed. */
  readonly exchangeRateCurrent: bigint | null;
  /** `vUSDT.getCash()` 0x3b1d21a2 — how much the pool can actually pay out. */
  readonly cash: bigint;
  /** B's native BNB balance. */
  readonly nativeBalance: bigint;
  readonly usdtAllowanceToVUsdt: bigint;
  readonly usdtAllowanceToRouter: bigint;
  /** `slot0().sqrtPriceX96` of the pinned WBNB/USDT pool — the solver's seed. */
  readonly poolSqrtPriceX96: bigint | null;
  /** Whether `poolSqrtPriceX96` counts WBNB as token0 in that pool. */
  readonly poolWbnbIsToken0: boolean;
};

/**
 * One token's on-chain rolling-day spend meter, read from PUBLIC FACTS ONLY
 * (R3.5) — `accountKeyHashForAddress(publicKeyToAddress(publicKey))`, the
 * native meter's own idiom. No owner read decrypts a session key.
 *
 * The failure rule is verbatim and NORMATIVE: **an unreadable meter OMITS the
 * term and reports condition `cap-unreadable`; it never refuses a rescue.**
 * "Mandatory" means the read is attempted and reported, not that its absence
 * blocks. The ONE exception is the retire route, which is not a rescue and
 * fails closed as `transport`.
 */
export type LendingTokenMeterReading =
  | {
      readonly kind: "day";
      readonly limitWei: bigint;
      readonly currentSpentWei: bigint;
      readonly remainingWei: bigint;
    }
  | { readonly kind: "no-grant" }
  | { readonly kind: "other-period" }
  | { readonly kind: "unreadable"; readonly detail: string };

/* -------------------------------------------------------------------------- */
/* Rescue telemetry                                                           */
/* -------------------------------------------------------------------------- */

export type LendingRescueEffect = "changed" | "no-effect" | "unverified";

export type LendingRescueRecord = {
  readonly rescueId: string;
  readonly agentId: string;
  readonly ownerAddress: Address;
  readonly journalKey: string;
  /** The vToken repaid. */
  readonly market: Address;
  readonly amountWei: bigint;
  readonly hfBefore: bigint | null;
  readonly hfAfter: bigint | null;
  readonly achievedHf: bigint | null;
  readonly txHash: Hex | null;
  readonly effect: LendingRescueEffect;
  readonly partial: boolean;
  /** Conditions the rescue carried — `arm-unknown`, `reserve-low`, … */
  readonly conditions: readonly LendingCondition[];
  readonly createdAtMs: number;
};

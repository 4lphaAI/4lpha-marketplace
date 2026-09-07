/**
 * Venus Core guard — shared types and the CLOSED refusal taxonomy
 * (PHASE4-SPEC "Refusal taxonomy", widened by R2.15/R22 and R3.7).
 *
 * Every condition the guard can be in has a typed name here, and a condition
 * the code does not understand maps to a fail-closed member plus owner
 * surfacing — never to a guessed action. The set is closed on purpose: the
 * owner view renders it, the worker branches on it, and a stringly-typed
 * reason is how a "cannot monitor" turns into a silent healthy.
 */
import type { Address, Hex } from "viem";

/* -------------------------------------------------------------------------- */
/* The refusal taxonomy                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The closed condition set. Members are `kebab-case` because they are rendered
 * verbatim on the owner view and in operator output.
 *
 * `hf-above-trigger` is a NO-OP, not an error — it is the healthy steady state
 * and is listed here so the view can say why nothing happened.
 */
export const VENUS_CONDITIONS = [
  // Steady state / sizing
  "hf-above-trigger",
  "insufficient-wallet-balance",
  "market-not-in-settings",
  "market-not-in-grant",
  "market-not-collateral-member",
  "market-delisted",
  "borrow-not-allowed",
  "supply-cap-exceeded",
  "no-effect",
  "position-liquidated",
  // Protocol pauses — three DIFFERENT contracts, never merged
  "action-paused",
  "protocol-paused",
  "prime-paused",
  // Protocol answers
  "protocol-error",
  "snapshot-error",
  "protocol-mismatch",
  "oracle-invalid",
  "emode-unverified",
  // Rewards
  "reward-debt-token-mismatch",
  "payout-zero",
  "claim-disabled",
  "claim-repay-disabled",
  // Plane-side
  "snapshot-unavailable",
  "data-plane-capacity",
  "transport",
  "quota-exhausted",
  "cooldown",
  "killswitch",
  "session-expired-or-revoked",
  "session-expiring",
  "unknown-held",
  "native-reserve",
  "no-native-grant",
  // FINDINGS (at)/(at-1), R4: the native market is a one-way door for an
  // EIP-7702 wallet (vBNB pays out via a 2300-gas .transfer()). ONE name,
  // both roles (settings refusal AND standing view condition) — the
  // no-native-grant precedent, adopted by the third review as R4.6(b).
  "native-collateral-trapped",
  "observation-stale",
  "awaiting-confirmation",
  "settings-absent",
  "venus-disabled",
] as const;

export type VenusCondition = (typeof VENUS_CONDITIONS)[number];

const CONDITION_SET: ReadonlySet<string> = new Set<string>(VENUS_CONDITIONS);

/** One surfaced condition, with the figures that make it actionable. */
export type VenusConditionReport = {
  readonly condition: VenusCondition;
  /** Sanitized prose. Callers branch on `condition`, never on this. */
  readonly detail: string;
  /** The vToken this condition is about, when it is about one. */
  readonly market?: Address;
};

export function venusCondition(
  condition: VenusCondition,
  detail: string,
  market?: Address,
): VenusConditionReport {
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
export function venusConditionOrFailClosed(
  candidate: string,
  detail: string,
): VenusConditionReport {
  if (CONDITION_SET.has(candidate)) {
    return venusCondition(candidate as VenusCondition, detail);
  }
  return venusCondition(
    "transport",
    `Unrecognized condition "${candidate}" — failing closed. ${detail}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The four money actions. `venusClaimRepayLeg` covers BOTH legs of a
 * claim-repay: they are two submissions and two journal rows, linked by one
 * decision namespace (D7).
 */
export type VenusActionKind =
  | "venusRepay"
  | "venusSupply"
  | "venusClaim"
  | "venusClaimRepayLeg";

/**
 * Rescues vs rate-limited kinds — the R2.9/R3.4 asymmetry, in one place.
 *
 * Rescues are COUNTED and NEVER REFUSED on the count (`lpSequences.ts:1162-1178`
 * transposed): the count narrows what the claim gate may still spend, and
 * refusing the rescue IS the trap the whole phase exists to avoid.
 */
export const VENUS_RESCUE_KINDS: ReadonlySet<VenusActionKind> =
  new Set<VenusActionKind>(["venusRepay", "venusSupply"]);

export function isVenusRescue(kind: VenusActionKind): boolean {
  return VENUS_RESCUE_KINDS.has(kind);
}

/* -------------------------------------------------------------------------- */
/* Chain reading shapes                                                       */
/* -------------------------------------------------------------------------- */

/** One market as the guard reads it, per account, at one finalized block. */
export type VenusMarketReading = {
  readonly vToken: Address;
  readonly vTokenSymbol: string;
  readonly vTokenDecimals: number;
  /** `null` for vBNB — the ONE native market, pinned by ADDRESS (R2.15/R15). */
  readonly underlying: Address | null;
  readonly underlyingDecimals: number;
  readonly native: boolean;
  readonly listed: boolean;
  readonly borrowAllowed: boolean;
  readonly collateralMember: boolean;
  readonly vTokenBalance: bigint;
  /** `getAccountSnapshot`'s stored borrow. */
  readonly borrowStored: bigint;
  /** `exchangeRateStored`. */
  readonly exchangeRateStored: bigint;
  /** `borrowBalanceCurrent` via `eth_call`; `null` when the sim failed. */
  readonly borrowCurrent: bigint | null;
  /** `exchangeRateCurrent` via `eth_call`; `null` when the sim failed. */
  readonly exchangeRateCurrent: bigint | null;
  /** `getEffectiveLtvFactor(owner, vToken, 0)` — E-Mode aware. */
  readonly effectiveCf: bigint;
  /** `getEffectiveLtvFactor(owner, vToken, 1)` — E-Mode aware. */
  readonly effectiveLt: bigint;
  readonly spotPrice: bigint;
  readonly boundedCollateralPrice: bigint;
  readonly boundedDebtPrice: bigint;
  readonly mintPaused: boolean;
  readonly repayPaused: boolean;
  /** `supplyCap - suppliedUnderlying`, floored at zero. */
  readonly supplyHeadroom: bigint;
  /** The wallet's balance of this market's underlying (native ⇒ BNB). */
  readonly walletBalance: bigint;
  /** Existing ERC-20 allowance from the wallet to the vToken. `0n` for native. */
  readonly allowance: bigint;
};

/** The account-level finalized read set the decision is made on. */
export type VenusAccountReading = {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly owner: Address;
  readonly protocolPaused: boolean;
  readonly userPoolId: bigint;
  readonly lastPoolId: bigint;
  readonly vaiDebt: bigint;
  /** `getAccountLiquidity` — `(errorCode, liquidity, shortfall)`. */
  readonly accountLiquidity: readonly [bigint, bigint, bigint];
  /** `getBorrowingPower` — same shape, other weighting. */
  readonly borrowingPower: readonly [bigint, bigint, bigint];
  readonly markets: readonly VenusMarketReading[];
  /** A non-zero `getAccountSnapshot` code on any market, if one was seen. */
  readonly snapshotErrorMarket: Address | null;
};

/* -------------------------------------------------------------------------- */
/* Boot config                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Pinned Venus Core addresses on BNB Chain 56 plus the R3.12 routing census.
 *
 * vBNB is pinned by ADDRESS and validated at boot against the chain (R2.15/
 * R15): the choice between `repayBorrow()` payable and `approve` +
 * `repayBorrow(uint256)` is a money decision about calldata, and deriving it
 * from a `symbol()` string in an advisory cache is exactly what the trust
 * boundary forbids.
 */
export type VenusVenue = {
  readonly comptroller: Address;
  readonly vBnb: Address;
  readonly prime: Address;
  readonly treasury: Address;
};

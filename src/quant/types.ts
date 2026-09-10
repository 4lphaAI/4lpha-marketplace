/**
 * The quant plane's domain vocabulary. Types only — no behaviour, no imports
 * that can act.
 */
import type { Address, Hex } from "viem";
import type { SpendPeriod } from "../core/types.js";

/* -------------------------------------------------------------------------- */
/* Job / level / action state                                                 */
/* -------------------------------------------------------------------------- */

export type QuantJobStatus =
  | "discovered"
  | "armed"
  | "held"
  | "paused"
  | "ended"
  | "ended-unresolved"
  | "reported";

/**
 * Level states (spec §4.4, R2.2).
 *
 * `blocked` is the one that carries the safety property: a level with ANY
 * non-terminal action is blocked and cannot receive a new intent, which is what
 * kills the double buy. `retired` is PERMANENT (R6.1) — the only release for
 * an action whose submission outcome can never be established.
 */
export type QuantLevelState =
  | "armed-quote"
  | "holding-base"
  | "blocked"
  | "retired";

/**
 * Action states (R2.2, R3.3).
 *
 * The terminal set is `{settled, failed, aborted}`. `submitted` means the CAS
 * that precedes `executeViaSession` landed — from there, only evidence moves
 * the row, never elapsed time and never silence (R6.1).
 */
export type QuantActionState =
  | "intended"
  | "submitted"
  | "committed-unverified"
  | "unknown"
  | "needs-operator"
  | "settled"
  | "failed"
  | "aborted";

export const QUANT_TERMINAL_ACTION_STATES: ReadonlySet<QuantActionState> =
  new Set<QuantActionState>(["settled", "failed", "aborted"]);

export type QuantSide = "buy" | "sell";

/**
 * Every hold this plane can record, as a FIXED code.
 *
 * A hold names its remedy in the operator-facing text; the code itself is what
 * `status` and the tests key on, so it never carries free text.
 */
export type QuantHoldCode =
  | "arm-uneconomic"
  | "below-minimum"
  | "cooldown"
  | "day-cap-exhausted"
  | "dry-run"
  | "edge-below-floor"
  | "exit-capacity"
  | "exit-uneconomic-at-price"
  | "external-activity"
  | "foreign-strategy"
  | "impact-too-high"
  | "inbox-unavailable"
  | "job-not-tradable"
  | "meter-exhausted"
  | "meter-unreadable"
  | "needs-operator"
  | "no-gas"
  | "no-native-grant"
  | "price-moved"
  | "quote-unavailable"
  | "session-chain-refused"
  | "session-chain-unreadable"
  | "session-changed"
  | "session-not-admissible"
  | "stale-observation"
  | "u-budget-exhausted"
  | "wire-invalid";

/* -------------------------------------------------------------------------- */
/* The session plaintext                                                      */
/* -------------------------------------------------------------------------- */

/** One `calls[]` entry of a granted `SessionPermissions`. */
export type GrantedCallPermission = {
  readonly to?: Address;
  readonly signature?: string;
};

/** One `spend[]` entry of a granted `SessionPermissions`. */
export type GrantedSpendPermission = {
  readonly token?: Address;
  readonly limit: bigint;
  readonly period: SpendPeriod;
};

export type GrantedPermissions = {
  readonly calls: readonly GrantedCallPermission[];
  readonly spend: readonly GrantedSpendPermission[];
};

/**
 * `@bnbagent/sdk` `serializeSession()` output, parsed.
 *
 * `ALTANA_SESSION_VERSION` is **1** and bigints arrive as
 * `{"$bigint":"<decimal>"}` (read from 0.5.6 on 2026-09-10, fixture checked
 * in). A DIFFERENT version is a REFUSAL — `session-version-unsupported` — never
 * a best-effort parse: this object is the client's money.
 */
export type QuantSessionPlaintext = {
  readonly version: number;
  readonly walletAddress: Address;
  readonly publicKey: Hex;
  readonly expiry: number;
  readonly permissions: GrantedPermissions;
  readonly signerPrivateKey: Hex;
};

/* -------------------------------------------------------------------------- */
/* Wire records (parsed, never raw)                                           */
/* -------------------------------------------------------------------------- */

export type QuantInboxItem = {
  readonly envelopeId: string;
  readonly quantJobId: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly algorithm: string;
};

export type QuantJobRecord = {
  readonly id: string;
  readonly status: string;
  readonly strategyId: string;
  readonly tradingWalletAddress: Address;
  readonly allocationUWei: bigint;
  readonly dailyCapUWei: bigint;
  readonly termDays: number;
  readonly startedAtMs: number | null;
  readonly endsAtMs: number | null;
  readonly sessionExpiresAtMs: number | null;
  readonly revokedAtMs: number | null;
};

export type QuantIndexerTrade = {
  readonly txHash: Hex;
  readonly blockTimeMs: number | null;
  readonly direction: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly realizedPnlU: string | null;
  readonly note: string | null;
};

/* -------------------------------------------------------------------------- */
/* Observations and quotes                                                    */
/* -------------------------------------------------------------------------- */

/** One finalized reading of the pair (R3.9). Identity IS the block. */
export type QuantObservation = {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly observedAtMs: number;
  /** U wei per 1 WBNB, floor. */
  readonly midE18: bigint;
};

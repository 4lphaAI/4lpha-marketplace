/**
 * The fee seam.
 *
 * A `FeePolicy` turns a trade into AT MOST ONE extra call, appended to the
 * venue builder's calls and submitted in the same atomic batch. Keeping fees to
 * a call in the batch — rather than a side transfer, a hook, or a venue
 * parameter — has one property worth the constraint: the total a user pays is
 * readable off the submitted calls, and it is subject to exactly the same
 * on-chain allowlist and spend caps as the trade itself.
 *
 * ─── THE ARITHMETIC, EXACTLY (PHASE2 R10) ──────────────────────────────────
 *
 * The fee is ON TOP, never deducted:
 *
 *   feeWei        = amountWei * bps / 10_000        (integer division, floors)
 *   swap value    = amountWei                       (unchanged by the fee)
 *   native charged = amountWei + feeWei             (what caps and the journal see)
 *
 * `FeeContext.nativeInWei` is therefore the PRE-fee swap input — the request's
 * `amountWei` — so the fee is never computed on a quantity that already contains
 * a fee. The consequence, stated because it will otherwise surprise someone: a
 * trade sized to exactly `perTradeNativeWei` REFUSES when a fee is configured,
 * since `amountWei + feeWei` is over the cap. Callers size for the fee.
 *
 * Sell-side fees are not implemented. A sell's native input is zero, so a
 * percentage of it is zero, and charging on the OUTPUT would require knowing the
 * output before the swap runs — a quote this service has decided not to make.
 */
import type { Address } from "viem";
import type { WalletCall } from "../core/types.js";
import type { TradeVenue } from "../http/wire.js";

/** Basis-point denominator. */
const BPS_DENOMINATOR = 10_000n;

/**
 * Ceiling on a configured fee, in basis points.
 *
 * 500 = 5%. The ceiling exists to refuse a configuration typo: `FEE_BPS=1000`
 * meaning "10 percent" written as if it were per-mille is the exact mistake that
 * would otherwise ship silently and charge ten times the intended rate.
 */
export const MAX_FEE_BPS = 500;

export type FeeContext = {
  readonly agentId: string;
  /**
   * REUSES {@link TradeVenue} rather than restating the union (PHASE2.2 R9).
   *
   * This is a published seam whose implementations switch on the venue, and a
   * second copy of the closed set is a second place to forget a new venue. When
   * `TRADE_VENUES` widens, every fee policy widens with it or stops compiling.
   */
  readonly venue: TradeVenue;
  readonly side: "buy" | "sell";
  readonly token: Address;
  /** PRE-fee native the trade itself spends. Zero for sells. */
  readonly nativeInWei: bigint;
};

/** Returns the fee call to append, or `null` for no fee. */
export type FeePolicy = (context: FeeContext) => WalletCall | null;

/** No fee, ever. THE DEFAULT: a fee has to be configured on purpose. */
export function createNoFeePolicy(): FeePolicy {
  return () => null;
}

export type BpsFeePolicyOptions = {
  readonly treasury: Address;
  /** Basis points. Validated `0 < bps <= MAX_FEE_BPS` at construction. */
  readonly bps: number;
};

/**
 * A flat basis-point fee on the native input of a BUY, paid as a plain transfer
 * to the treasury.
 *
 * Validation happens HERE, at construction, so a bad rate fails at boot rather
 * than at the first trade. Returns `null` — no call at all — when the side is a
 * sell or when integer division floors the fee to zero, because appending a
 * zero-value transfer would burn gas to move nothing and would still have to
 * clear the on-chain allowlist.
 */
export function createBpsFeePolicy(options: BpsFeePolicyOptions): FeePolicy {
  if (!Number.isInteger(options.bps)) {
    throw new Error("FEE_BPS must be an integer number of basis points.");
  }
  if (options.bps <= 0 || options.bps > MAX_FEE_BPS) {
    throw new Error(
      `FEE_BPS must be between 1 and ${MAX_FEE_BPS} basis points; got ${options.bps}.`,
    );
  }
  const bps = BigInt(options.bps);
  const treasury = options.treasury;

  return (context) => {
    if (context.side === "sell") return null;
    const fee = (context.nativeInWei * bps) / BPS_DENOMINATOR;
    if (fee <= 0n) return null;
    return { to: treasury, value: fee };
  };
}

/**
 * The fee a policy would charge, WITHOUT building the call.
 *
 * The route needs the number before it needs the call — cap arithmetic and the
 * journal's `native_spend_wei` are both computed from `amountWei + feeWei` — and
 * deriving it from the built call keeps the two from ever disagreeing.
 */
export function feeValueOf(call: WalletCall | null): bigint {
  return call?.value ?? 0n;
}

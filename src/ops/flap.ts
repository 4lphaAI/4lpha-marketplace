/**
 * flap.sh Portal call builders. PURE: no network, no clock, no env.
 *
 * ─── ONE ENTRY POINT, DIRECTION BY ADDRESS ─────────────────────────────────
 *
 * flap is a bonding curve, not a router. Both sides go through the same
 * `swapExactInput`, and the direction is which end of the struct holds
 * `address(0)` — the native asset:
 *
 *   BUY   0x0 -> token,  `value == inputAmount`   (one call)
 *   SELL  token -> 0x0,  `value == 0`             (approve, approve, swap)
 *
 * `value == inputAmount` on a buy is not an inference. It is what three live
 * mainnet `swapExactInput` calls do (see `src/ops/abis.ts` provenance and
 * FINDINGS), and a simulated buy at `value == 0` reverts `0x3ebbc337`.
 *
 * ─── NO ROUTE, AND THAT IS THE SHAPE NOT AN OMISSION ───────────────────────
 *
 * There are no hops and no fee tiers on a curve, so a flap trade carries no
 * routing data at all — the same shape as `fourmeme`. `flap` is deliberately
 * absent from `ROUTABLE_VENUES`, which makes a `route` on a flap trade a 400
 * rather than a field that is silently ignored while still changing
 * `paramsHash`.
 *
 * ─── `permitData` IS ALWAYS EMPTY ──────────────────────────────────────────
 *
 * ERC-2612 `permit` recovers a signature against the token HOLDER's key. The
 * holder is the wallet; the only signer available at execute time is the
 * SESSION key, which is a different key, so a permit signed there recovers to
 * the session address and the call fails. Never emit permitData; the approve
 * pair below is the only route, and it is the same pair the live seller used.
 *
 * ─── WHAT A REFUNDED BUY COSTS, STATED HERE RATHER THAN DISCOVERED ─────────
 *
 * flap may refund part of a buy's input IN THE SAME TRANSACTION, for two
 * reasons and not one:
 *
 *   1. a per-address BUY QUOTA — "the protocol automatically refunds the
 *      portion of your input that would push you over the limit";
 *   2. the CURVE CAP at `dexSupplyThresh`, which is the common one near
 *      graduation: the published quote algorithm caps the reserve increase at
 *      `min(input_after_fee, max_reserve - curr_reserve)` and refunds the rest.
 *
 * The normal outcome of a MATERIALLY refunded buy is NOT a partial fill. The
 * caller's floor is derived from its own quote, the refund reduces the input
 * and therefore the output, so the swap misses `minOutputAmount` and REVERTS on
 * chain — `FAILED`, rolled back, having spent relay gas that is metered against
 * the session's native cap. Only a refund smaller than the slippage tolerance
 * is a success path. Consequently the journal's `nativeSpendWei` for a flap buy
 * is an UPPER BOUND, which errs in the safe direction, and the 4lpha fee is
 * charged on the DECLARED input including any portion that comes back.
 */
import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { FLAP_PORTAL_ABI } from "./abis.js";
import { buildApprove } from "./pancake.js";

/** `permitData`, always. See the module docstring — this is load-bearing. */
const NO_PERMIT: Hex = "0x";

export type FlapBuyParams = {
  /** The Portal, resolved from boot config. Never a request field. */
  readonly portal: Address;
  readonly token: Address;
  /** Native BNB in. Becomes BOTH `inputAmount` and the call's `value`. */
  readonly amountInWei: bigint;
  /** Slippage floor, in the token's smallest unit. */
  readonly minOutWei: bigint;
};

export type FlapSellParams = {
  readonly portal: Address;
  readonly token: Address;
  /** Token amount sold, in the token's smallest unit. */
  readonly amountInWei: bigint;
  /** Slippage floor, in wei of native BNB. */
  readonly minOutWei: bigint;
};

/**
 * Buy `token` off the curve with native BNB.
 *
 * ONE call. `value` EQUALS `inputAmount`: the Portal reads the struct for the
 * size and the transaction for the funds, and a mismatch is a revert rather
 * than a smaller trade.
 *
 * No recipient parameter, and none is available on this entry point — the
 * output is credited to `msg.sender`, which under a session execute IS the
 * agent's wallet. A builder that cannot name a recipient cannot be talked into
 * naming an attacker's.
 */
export function buildFlapBuy(params: FlapBuyParams): readonly WalletCall[] {
  return [
    {
      to: params.portal,
      value: params.amountInWei,
      data: encodeFunctionData({
        abi: FLAP_PORTAL_ABI,
        functionName: "swapExactInput",
        args: [
          {
            inputToken: zeroAddress,
            outputToken: params.token,
            inputAmount: params.amountInWei,
            minOutputAmount: params.minOutWei,
            permitData: NO_PERMIT,
          },
        ],
      }) as Hex,
    },
  ];
}

/**
 * Sell `token` back into the curve for native BNB.
 *
 * `[approve(portal, 0), approve(portal, amount), swapExactInput]`, with
 * `value == 0`. The leading zero-reset is there for the same reason as the
 * pancake and four.meme sells: USDT-style tokens revert on any `approve` that
 * moves a non-zero allowance to another non-zero value, flap tokens are
 * arbitrary ERC-20s, and the batch is atomic so a reverting swap leaves no live
 * allowance behind.
 *
 * The approvals are EXACT, never `type(uint256).max`: an infinite allowance
 * would be metered at `type(uint256).max` against the token's spend cap and
 * exhaust any finite one in a single call (`src/ops/policy.ts`).
 */
export function buildFlapSell(params: FlapSellParams): readonly WalletCall[] {
  return [
    buildApprove(params.token, params.portal, 0n),
    buildApprove(params.token, params.portal, params.amountInWei),
    {
      to: params.portal,
      data: encodeFunctionData({
        abi: FLAP_PORTAL_ABI,
        functionName: "swapExactInput",
        args: [
          {
            inputToken: params.token,
            outputToken: zeroAddress,
            inputAmount: params.amountInWei,
            minOutputAmount: params.minOutWei,
            permitData: NO_PERMIT,
          },
        ],
      }) as Hex,
    },
  ];
}

/**
 * Four.Meme bonding-curve call builders. PURE: no network, no clock, no env.
 *
 * ─── RECIPIENT DISCIPLINE ──────────────────────────────────────────────────
 *
 * Neither builder takes a recipient, and that is the safe shape rather than an
 * omission. The overloads used here — `buyTokenAMAP(token, funds, minAmount)`
 * and `sellToken(origin, token, amount, minFunds, feeRate, feeRecipient)` —
 * credit `msg.sender`, which under a session execute IS the agent's wallet. The
 * four-argument `buyTokenAMAP(token, to, funds, minAmount)` and the
 * seven-argument `sellToken(..., from, ...)` DO take a third-party address, and
 * both are deliberately absent from `FOUR_MEME_TOKEN_MANAGER_ABI`: a builder
 * that cannot name a recipient cannot be talked into naming an attacker's.
 *
 * ─── THE FEE IS ON TOP, AND IT IS NOT OURS TO COMPUTE (PHASE2.1) ───────────
 *
 * `buyTokenAMAP`'s `funds` is what goes into the curve; the venue's trading fee
 * is charged IN ADDITION, so `msg.value != funds`. Phase 2 derived the total
 * here with `funds + max(funds * rate / 10_000, minFee)`. That arithmetic is
 * GONE: `TokenManagerHelper3.tryBuy` already returns the exact `amountMsgValue`
 * and the exact `amountFunds`, computed by the venue itself against its own fee
 * edge cases, and a second implementation of a formula we do not own is a
 * second thing to be wrong. Both numbers now arrive as parameters, read fresh
 * per attempt and bounded against the caller's request before they get here.
 */
import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { FOUR_MEME_TOKEN_MANAGER_ABI } from "./abis.js";
import { buildApprove } from "./pancake.js";

/**
 * `origin` on `sellToken`. Four.Meme uses it as a referral/attribution tag; we
 * attribute nothing, so it is fixed at zero.
 */
const SELL_ORIGIN = 0n;

export type FourMemeBuyParams = {
  /** The manager FROM THE ON-CHAIN READ, never a hardcoded default. */
  readonly manager: Address;
  readonly token: Address;
  /** What enters the curve. `tryBuy.amountFunds`. Encoded as `funds`. */
  readonly fundsWei: bigint;
  /** Slippage floor, in the token's smallest unit. Encoded as `minAmount`. */
  readonly minTokensOut: bigint;
  /** `tryBuy.amountMsgValue` — the venue's own figure, never derived here. */
  readonly msgValueWei: bigint;
};

export type FourMemeSellParams = {
  readonly manager: Address;
  readonly token: Address;
  /** Token amount sold, in the token's smallest unit. */
  readonly amountWei: bigint;
  /** Slippage floor, in wei of native BNB. Encoded as `minFunds`. */
  readonly minFundsOut: bigint;
};

/**
 * Buy `token` off the bonding curve.
 *
 * One call, `value = msgValueWei`. `funds` stays the pre-venue-fee amount: the
 * manager charges its fee out of the surplus, and passing the gross as `funds`
 * would buy more than the caller asked for.
 */
export function buildFourMemeBuy(
  params: FourMemeBuyParams,
): readonly WalletCall[] {
  return [
    {
      to: params.manager,
      value: params.msgValueWei,
      data: encodeFunctionData({
        abi: FOUR_MEME_TOKEN_MANAGER_ABI,
        functionName: "buyTokenAMAP",
        args: [params.token, params.fundsWei, params.minTokensOut],
      }) as Hex,
    },
  ];
}

/**
 * Sell `token` back into the curve.
 *
 * Exactly `[approve(manager, 0), approve(manager, amount), sellToken]`, for the
 * same reasons as the pancake sell: the zero-reset unbricks USDT-style tokens,
 * and the batch is atomic so a reverting sell leaves no live allowance.
 *
 * `feeRate` and `feeRecipient` are zero / the zero address on purpose (PHASE2
 * R19). The venue's own fee-split parameters are a second fee mechanism; this
 * service operates exactly one, the seam in `src/ops/fees.ts`, so that the total
 * a user pays is readable off the submitted batch.
 */
export function buildFourMemeSell(
  params: FourMemeSellParams,
): readonly WalletCall[] {
  return [
    buildApprove(params.token, params.manager, 0n),
    buildApprove(params.token, params.manager, params.amountWei),
    {
      to: params.manager,
      data: encodeFunctionData({
        abi: FOUR_MEME_TOKEN_MANAGER_ABI,
        functionName: "sellToken",
        args: [
          SELL_ORIGIN,
          params.token,
          params.amountWei,
          params.minFundsOut,
          0n,
          zeroAddress,
        ],
      }) as Hex,
    },
  ];
}

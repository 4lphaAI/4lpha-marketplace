/**
 * PancakeSwap V2 call builders. PURE: no network, no clock, no environment.
 *
 * Every quantity is an explicit parameter, including the deadline, so the same
 * inputs always produce byte-identical calldata. That is what makes the golden
 * calldata tests meaningful and what lets the idempotency key bind a trade to
 * the exact bytes it will submit.
 *
 * ─── BATCH ATOMICITY (PHASE2 R11) ──────────────────────────────────────────
 *
 * The sell builder returns THREE calls that only make sense together, and it
 * relies on the batch being all-or-nothing. VERIFIED rather than assumed:
 *
 *   - `IthacaAccount`'s ABI (porto 0.2.37,
 *     `core/internal/_generated/contracts/IthacaAccount.ts`) exposes exactly one
 *     batch entry point, `execute(bytes32 mode, bytes executionData)` — ERC-7821
 *     — alongside an `UnsupportedExecutionMode` error.
 *   - Queried on the live delegated account
 *     0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4 (BNB Chain 56, 2026-08-11),
 *     `supportsExecutionMode` returns TRUE for the three ERC-7821 modes (single
 *     batch, single batch with opData, batch of batches) and FALSE for the
 *     ERC-7579 batch mode `0x02…`, which is where the "try / allow failure"
 *     execution type lives. There is no mode this account accepts that catches a
 *     child revert.
 *
 * So a reverting swap reverts the approvals with it; the wallet is never left
 * holding a live allowance for a swap that did not happen, and a configured fee
 * is never paid for a trade that did not occur.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import {
  ERC20_APPROVE_ABI,
  PANCAKE_V2_ROUTER_ABI,
  WBNB_DEPOSIT_ABI,
} from "./abis.js";

export type PancakeBuyParams = {
  readonly router: Address;
  readonly wbnb: Address;
  readonly token: Address;
  /** Native BNB the swap itself spends. Becomes the call's `value`. */
  readonly amountInWei: bigint;
  /** Slippage floor, in the token's smallest unit. */
  readonly minOutWei: bigint;
  /** ALWAYS the agent's wallet address, from the persisted row. */
  readonly recipient: Address;
  /** Unix SECONDS. The route computes `now + TRADE_DEADLINE_SEC`. */
  readonly deadline: bigint;
  /**
   * Caller-supplied intermediate hops, in `WBNB → …hops → token` orientation.
   * Absent or empty is the Phase 2 behaviour: a direct `[WBNB, token]` pair.
   */
  readonly hops?: readonly Address[];
};

export type PancakeSellParams = {
  readonly router: Address;
  readonly wbnb: Address;
  readonly token: Address;
  /** Token amount sold, in the token's smallest unit. */
  readonly amountInWei: bigint;
  /** Slippage floor, in wei of native BNB. */
  readonly minOutWei: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  /**
   * The SAME hops a buy of this position would use — `WBNB → …hops → token`.
   * This builder reverses them; see {@link buildPancakeSell}.
   */
  readonly hops?: readonly Address[];
};

/**
 * The V2 swap path for a BUY: `[WBNB, ...hops, token]`.
 *
 * Exported so the sell can be defined as its exact reverse rather than
 * re-derived, which is the property the tests assert.
 */
export function pancakeBuyPath(params: {
  readonly wbnb: Address;
  readonly token: Address;
  readonly hops?: readonly Address[];
}): readonly Address[] {
  return [params.wbnb, ...(params.hops ?? []), params.token];
}

/**
 * PHASE3.19 item 4 — WBNB `deposit()` with `value` attached: wrap native BNB
 * into wallet-held WBNB, INSIDE THE SAME EOA.
 *
 * The ONE new call this phase emits, and the ONLY caller is the LADDER ARM's
 * plan. It exists because the ladder's idle buffer must hold its quote half as
 * WBNB — every re-mint after the arm is `buildLpMintWbnbBatch`-shaped — and no
 * other reachable call turns the wallet's native balance into wallet-held WBNB:
 * both of a dual arm's native legs wrap inside the periphery's own `pay()` and
 * leave nothing behind, and `unwrapWETH9` is the NFPM's and runs the other way.
 *
 * There is no `withdraw` counterpart, deliberately: nothing in the ladder
 * unwraps, and `lpSessionSpec` does not grant one.
 */
export function buildWbnbDeposit(wbnb: Address, valueWei: bigint): WalletCall {
  return {
    to: wbnb,
    value: valueWei,
    data: encodeFunctionData({
      abi: WBNB_DEPOSIT_ABI,
      functionName: "deposit",
      args: [],
    }) as Hex,
  };
}

/** `approve(spender, amount)` on `token`. Never an infinite allowance. */
export function buildApprove(
  token: Address,
  spender: Address,
  amount: bigint,
): WalletCall {
  return {
    to: token,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [spender, amount],
    }) as Hex,
  };
}

/**
 * Buy `token` with native BNB.
 *
 * One call. `value` is the BNB in; the fee-on-transfer variant is used because
 * the plain one reverts on any token that taxes transfers, which describes most
 * of what trades on this chain.
 *
 * The path is `[WBNB, ...hops, token]` — a direct pair when the caller supplies
 * no hops, which is every Phase 2 trade.
 */
export function buildPancakeBuy(params: PancakeBuyParams): readonly WalletCall[] {
  return [
    {
      to: params.router,
      value: params.amountInWei,
      data: encodeFunctionData({
        abi: PANCAKE_V2_ROUTER_ABI,
        functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
        args: [
          params.minOutWei,
          pancakeBuyPath(params),
          params.recipient,
          params.deadline,
        ],
      }) as Hex,
    },
  ];
}

/**
 * Sell `token` for native BNB.
 *
 * Exactly `[approve(router, 0), approve(router, amount), swap]`.
 *
 * The leading `approve(0)` is not defensive noise: USDT-style tokens revert on
 * any `approve` that moves a non-zero allowance to another non-zero value, so a
 * second sell of the same token would fail forever without it. Resetting first
 * also means a batch that reverts after the approvals leaves no residue, which
 * matters more than the extra 5k gas.
 *
 * ─── THE SELL PATH IS THE REVERSE OF THE BUY PATH ──────────────────────────
 *
 * `hops` arrives in the SAME orientation for both sides (`WBNB → …hops →
 * token`), so a caller that supplied `hops: [X]` to buy expects `BNB → X →
 * token` in and `token → X → BNB` out, and this builder reverses. A builder
 * that forgot would quietly route through a pool that may not exist — or, with
 * two hops, through one that does exist and is not the one the caller chose.
 *
 * `[...hops].reverse()`, never `hops.reverse()`: the array is `readonly`, and it
 * is already folded into `paramsHash`, so mutating it in place would change the
 * identity of the trade being submitted.
 */
export function buildPancakeSell(params: PancakeSellParams): readonly WalletCall[] {
  return [
    buildApprove(params.token, params.router, 0n),
    buildApprove(params.token, params.router, params.amountInWei),
    {
      to: params.router,
      data: encodeFunctionData({
        abi: PANCAKE_V2_ROUTER_ABI,
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        args: [
          params.amountInWei,
          params.minOutWei,
          [...pancakeBuyPath(params)].reverse(),
          params.recipient,
          params.deadline,
        ],
      }) as Hex,
    },
  ];
}

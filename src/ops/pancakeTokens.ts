/**
 * PancakeSwap V2 TOKEN-TO-TOKEN builder (QUANT-GRID W1 / spec §5.1).
 *
 * PURE: no network, no clock, no environment. Every quantity is an explicit
 * parameter, so the same inputs always produce byte-identical calldata — which
 * is what lets an action's `calls_json` be compared BYTE-EQUAL against a
 * decoded relay intent (R4.1 execution identity).
 *
 * ─── WHY A NEW MODULE AND A NEW ABI CONSTANT ───────────────────────────────
 *
 * `src/ops/pancake.ts` is NATIVE-QUOTED: its two entry points are
 * `swapExactETHForTokens…` and `swapExactTokensForETH…`, and its ABI constant
 * `PANCAKE_V2_ROUTER_ABI` is pinned byte-for-byte by Phase 2's golden-calldata
 * tests. TermiX Quant settles in U, an ERC-20, so neither leg touches native
 * and a third entry point is required. Adding it to the existing constant
 * would move an audited snapshot for a caller that does not use it, so the new
 * signature lives in its own constant and the old one is untouched.
 *
 * ─── WHY NOT THE FEE-ON-TRANSFER VARIANT ───────────────────────────────────
 *
 * `swapExactTokensForTokensSupportingFeeOnTransferTokens` returns nothing. U
 * and WBNB do not tax transfers (both measured: a plain ERC-20 and the
 * canonical wrapper), and the non-supporting function's revert-on-shortfall is
 * the property that makes `minOut` a real floor rather than a hint.
 *
 * ─── WHY EXACTLY TWO CALLS, AND WHY NO LEADING `approve(0)` ────────────────
 *
 * The Altana account ZEROES ERC-20 allowances at the end of the transaction
 * that granted them (measured by TermiX: two `Approval` events, N then 0), so
 * approve and swap MUST share one relay intent — two intents always fail with
 * `TransferHelper: TRANSFER_FROM_FAILED` — and the USDT-style
 * `approve(0)`-first dance that `buildPancakeSell` needs is unnecessary here,
 * because there is never a live residual allowance to move from. A test pins
 * the batch at exactly two calls for that reason: a third would be a change to
 * the execution-identity bytes as well as to the gas.
 */
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { ERC20_APPROVE_ABI } from "./abis.js";

/**
 * `swapExactTokensForTokens(uint256,uint256,address[],address,uint256)`,
 * selector `0x38ed1739`. ONE entry, deliberately: viem resolves
 * `functionName` against whichever entry it finds, so a constant with two
 * same-named overloads is a constant that can encode the wrong one.
 */
export const PANCAKE_V2_ROUTER_TOKENS_ABI = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const satisfies Abi;

/** The canonical signature the session's allowlist must name. */
export const SWAP_EXACT_TOKENS_FOR_TOKENS_SIGNATURE =
  "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" as const;

/** The canonical `approve` signature the session's allowlist must name. */
export const APPROVE_SIGNATURE = "approve(address,uint256)" as const;

export type PancakeTokenSwapParams = {
  readonly router: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Amount sold, in `tokenIn`'s smallest unit. */
  readonly amountInWei: bigint;
  /** Floor, in `tokenOut`'s smallest unit. The economic floor, never a quote. */
  readonly minOutWei: bigint;
  /**
   * ALWAYS the task wallet from the JOB record.
   *
   * A `CallRule` cannot constrain an argument (FINDINGS (h)), so this being the
   * task wallet is a property of THIS BUILDER, never of the session key. The
   * honest sentence is in the spec (R3.2 C4) and in the listing text.
   */
  readonly recipient: Address;
  /** Unix SECONDS. Persisted on the action; part of its execution identity. */
  readonly deadline: bigint;
};

/**
 * `[approve(tokenIn → router, amountIn), swapExactTokensForTokens(...)]`.
 *
 * Exactly two calls, in this order, in ONE batch. See the module header.
 */
export function buildPancakeTokenSwap(
  params: PancakeTokenSwapParams,
): readonly WalletCall[] {
  const router = getAddress(params.router);
  const tokenIn = getAddress(params.tokenIn);
  const tokenOut = getAddress(params.tokenOut);
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error("A token-to-token swap requires two different tokens.");
  }
  if (params.amountInWei <= 0n) {
    throw new Error("A token-to-token swap requires a positive amountIn.");
  }
  if (params.minOutWei <= 0n) {
    throw new Error("A token-to-token swap requires a positive minOut floor.");
  }
  return [
    {
      to: tokenIn,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [router, params.amountInWei],
      }) as Hex,
    },
    {
      to: router,
      data: encodeFunctionData({
        abi: PANCAKE_V2_ROUTER_TOKENS_ABI,
        functionName: "swapExactTokensForTokens",
        args: [
          params.amountInWei,
          params.minOutWei,
          [tokenIn, tokenOut],
          getAddress(params.recipient),
          params.deadline,
        ],
      }) as Hex,
    },
  ];
}

/**
 * The direct two-hop path for one side of the ladder.
 *
 * The venue registry reports `priceRoute: "direct"` for WBNB and nothing else
 * is tradable, so a path is always exactly two addresses. Exported so the
 * quote reader and the builder cannot disagree about orientation.
 */
export function directPath(tokenIn: Address, tokenOut: Address): readonly Address[] {
  return [getAddress(tokenIn), getAddress(tokenOut)];
}

/**
 * Pure Uniswap V3 SwapRouter02 call builders for the TradFi trade venue.
 * SwapRouter02's direct swaps have no deadline; the supplied deadline is kept
 * in the shared parameter shape but is not encoded. The amountOutMinimum floor
 * and the worker's impact/slippage gates are the accepted late-relay boundary.
 * There is no multicall here: the account batches the four target-bound
 * selectors, with buy refund and sell unwrap as separate atomic calls.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { UNISWAP_V3_ROUTER02_ABI } from "./abis.js";
import { buildApprove } from "./pancake.js";
import { encodeV3Path } from "./pancakeV3.js";
import { MAX_ROUTE_HOPS, UNISWAP_V3_FEE_TIERS, type TradeRoute } from "./route.js";
import type { PancakeV3BuyParams, PancakeV3SellParams } from "./pancakeV3.js";

export type UniswapV3BuyParams = PancakeV3BuyParams;
export type UniswapV3SellParams = PancakeV3SellParams;

function isUniswapFee(value: number): boolean {
  return UNISWAP_V3_FEE_TIERS.some((tier) => tier === value);
}

/** Refuse Pancake's 2500 tier even when a direct caller bypasses the wire. */
export function isEncodableUniswapV3Route(route: TradeRoute): boolean {
  return route.hops.length <= MAX_ROUTE_HOPS
    && route.fees.length === route.hops.length + 1
    && route.fees.every(isUniswapFee);
}

function buyTokens(params: {
  readonly wbnb: Address;
  readonly token: Address;
  readonly route: TradeRoute;
}): readonly Address[] {
  return [params.wbnb, ...params.route.hops, params.token];
}

function encodeSwap(params: {
  readonly tokens: readonly Address[];
  readonly fees: readonly number[];
  readonly recipient: Address;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
}): Hex {
  const tokenIn = params.tokens[0];
  const tokenOut = params.tokens.at(-1);
  const fee = params.fees[0];
  if (tokenIn === undefined || tokenOut === undefined || fee === undefined) {
    throw new Error("Uniswap V3 swap requires at least one pool.");
  }
  if (params.fees.length === 1) {
    return encodeFunctionData({
      abi: UNISWAP_V3_ROUTER02_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn,
        tokenOut,
        fee,
        recipient: params.recipient,
        amountIn: params.amountInWei,
        amountOutMinimum: params.minOutWei,
        sqrtPriceLimitX96: 0n,
      }],
    }) as Hex;
  }
  return encodeFunctionData({
    abi: UNISWAP_V3_ROUTER02_ABI,
    functionName: "exactInput",
    args: [{
      path: encodeV3Path(params.tokens, params.fees),
      recipient: params.recipient,
      amountIn: params.amountInWei,
      amountOutMinimum: params.minOutWei,
    }],
  }) as Hex;
}

function refundEth(): Hex {
  return encodeFunctionData({
    abi: UNISWAP_V3_ROUTER02_ABI,
    functionName: "refundETH",
    args: [],
  }) as Hex;
}

/** Buy with BNB, returning the swap and refund legs in one atomic wallet batch. */
export function buildUniswapV3Buy(params: UniswapV3BuyParams): readonly WalletCall[] {
  if (!isEncodableUniswapV3Route(params.route)) {
    throw new Error("Uniswap V3 route is not encodable.");
  }
  const swap = encodeSwap({
    tokens: buyTokens(params), fees: params.route.fees, recipient: params.recipient,
    amountInWei: params.amountInWei, minOutWei: params.minOutWei,
  });
  return [
    { to: params.router, value: params.amountInWei, data: swap },
    { to: params.router, data: refundEth() },
  ];
}

/** Sell to BNB; the router retains WBNB until the separate unwrap leg. */
export function buildUniswapV3Sell(params: UniswapV3SellParams): readonly WalletCall[] {
  if (!isEncodableUniswapV3Route(params.route)) {
    throw new Error("Uniswap V3 route is not encodable.");
  }
  const swap = encodeSwap({
    tokens: [...buyTokens(params)].toReversed(),
    fees: params.route.fees.toReversed(),
    recipient: params.router,
    amountInWei: params.amountInWei,
    minOutWei: params.minOutWei,
  });
  const unwrap = encodeFunctionData({
    abi: UNISWAP_V3_ROUTER02_ABI,
    functionName: "unwrapWETH9",
    args: [params.minOutWei, params.recipient],
  }) as Hex;
  return [
    buildApprove(params.token, params.router, 0n),
    buildApprove(params.token, params.router, params.amountInWei),
    { to: params.router, data: swap },
    { to: params.router, data: unwrap },
  ];
}

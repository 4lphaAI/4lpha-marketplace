/** Token-to-token builders for the USDT-denominated TradFi lane. */
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { WalletCall } from "../core/types.js";
import { ERC20_APPROVE_ABI, PANCAKE_V3_ROUTER_ABI, UNISWAP_V3_ROUTER02_ABI } from "./abis.js";
import { buildApprove } from "./pancake.js";
import { buildPancakeTokenSwap, type PancakeTokenSwapParams } from "./pancakeTokens.js";
import { encodeV3Path } from "./pancakeV3.js";
import type { TradeRoute, V3FeeTier } from "./route.js";

export type TradfiTokenSwapParams = {
  readonly router: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly route: TradeRoute;
};

function validate(params: TradfiTokenSwapParams): void {
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) throw new Error("TradFi swap tokens must differ.");
  if (params.amountInWei <= 0n || params.minOutWei <= 0n) throw new Error("TradFi swap amounts must be positive.");
  if (params.route.hops.length > 2 || (params.route.fees.length > 0 && params.route.fees.length !== params.route.hops.length + 1)) {
    throw new Error("TradFi V3 route is not bounded.");
  }
  if (params.deadline <= 0n) throw new Error("TradFi swap deadline must be positive.");
}

function tokenPath(params: TradfiTokenSwapParams): readonly Address[] {
  return [getAddress(params.tokenIn), ...params.route.hops.map(getAddress), getAddress(params.tokenOut)];
}

/** V2 exact-input token swap; route.hops may contain at most two known intermediaries. */
export function buildTradfiPancakeV2Swap(params: TradfiTokenSwapParams): readonly WalletCall[] {
  validate(params);
  const base: PancakeTokenSwapParams = {
    router: params.router, tokenIn: params.tokenIn, tokenOut: params.tokenOut,
    amountInWei: params.amountInWei, minOutWei: params.minOutWei,
    recipient: params.recipient, deadline: params.deadline,
  };
  if (params.route.hops.length === 0) return buildPancakeTokenSwap(base);
  const [approve, swap] = buildPancakeTokenSwap(base);
  if (approve === undefined || swap === undefined) throw new Error("TradFi V2 batch is incomplete.");
  const data = encodeFunctionData({
    abi: [{
      type: "function", name: "swapExactTokensForTokens", stateMutability: "nonpayable",
      inputs: [
        { name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" },
        { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
      ], outputs: [{ name: "amounts", type: "uint256[]" }],
    }] as const,
    functionName: "swapExactTokensForTokens",
    args: [params.amountInWei, params.minOutWei, tokenPath(params), getAddress(params.recipient), params.deadline],
  }) as Hex;
  return [approve, { ...swap, data }];
}

function buildV3Call(
  abi: typeof PANCAKE_V3_ROUTER_ABI | typeof UNISWAP_V3_ROUTER02_ABI,
  params: TradfiTokenSwapParams,
): Hex {
  const tokens = tokenPath(params);
  const fees = params.route.fees as readonly V3FeeTier[];
  if (fees.length === 1) {
    const fee = fees[0];
    if (fee === undefined) throw new Error("TradFi V3 route is incomplete.");
    if (abi === PANCAKE_V3_ROUTER_ABI) {
      return encodeFunctionData({
        abi, functionName: "exactInputSingle",
        args: [{ tokenIn: tokens[0]!, tokenOut: tokens[1]!, fee, recipient: getAddress(params.recipient), deadline: params.deadline,
          amountIn: params.amountInWei, amountOutMinimum: params.minOutWei, sqrtPriceLimitX96: 0n }],
      }) as Hex;
    }
    return encodeFunctionData({
      abi, functionName: "exactInputSingle",
      args: [{ tokenIn: tokens[0]!, tokenOut: tokens[1]!, fee, recipient: getAddress(params.recipient),
        amountIn: params.amountInWei, amountOutMinimum: params.minOutWei, sqrtPriceLimitX96: 0n }],
    }) as Hex;
  }
  const path = encodeV3Path(tokens, fees);
  if (abi === PANCAKE_V3_ROUTER_ABI) {
    return encodeFunctionData({
      abi, functionName: "exactInput",
      args: [{ path, recipient: getAddress(params.recipient), deadline: params.deadline,
        amountIn: params.amountInWei, amountOutMinimum: params.minOutWei }],
    }) as Hex;
  }
  return encodeFunctionData({
    abi, functionName: "exactInput",
    args: [{ path, recipient: getAddress(params.recipient), amountIn: params.amountInWei, amountOutMinimum: params.minOutWei }],
  }) as Hex;
}

function buildV3Swap(
  abi: typeof PANCAKE_V3_ROUTER_ABI | typeof UNISWAP_V3_ROUTER02_ABI,
  params: TradfiTokenSwapParams,
): readonly WalletCall[] {
  validate(params);
  const router = getAddress(params.router);
  return [
    buildApprove(params.tokenIn, router, 0n),
    buildApprove(params.tokenIn, router, params.amountInWei),
    { to: router, data: buildV3Call(abi, params) },
  ];
}

export function buildTradfiPancakeV3Swap(params: TradfiTokenSwapParams): readonly WalletCall[] {
  return buildV3Swap(PANCAKE_V3_ROUTER_ABI, params);
}

export function buildTradfiUniswapV3Swap(params: TradfiTokenSwapParams): readonly WalletCall[] {
  return buildV3Swap(UNISWAP_V3_ROUTER02_ABI, params);
}

export function buildTradfiPlatformFee(input: {
  readonly usdt: Address;
  readonly treasury: Address;
  readonly amountWei: bigint;
}): WalletCall[] {
  if (input.amountWei <= 0n) return [];
  return [{
    to: getAddress(input.usdt),
    data: encodeFunctionData({ abi: [{
      type: "function", name: "transfer", stateMutability: "nonpayable",
      inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "ok", type: "bool" }],
    }] as const, functionName: "transfer", args: [getAddress(input.treasury), input.amountWei] }) as Hex,
  }];
}

export function buildTradfiApprove(token: Address, spender: Address, amountWei: bigint): WalletCall[] {
  if (amountWei <= 0n) throw new Error("TradFi approve amount must be positive.");
  return [buildApprove(token, spender, 0n), buildApprove(token, spender, amountWei)];
}

export const TRADFI_ERC20_APPROVE_ABI = ERC20_APPROVE_ABI;

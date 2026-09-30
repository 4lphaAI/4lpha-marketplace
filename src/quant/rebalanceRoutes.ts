/** Closed V2 route set, calldata identity, route ranking and reference checks. */
import {
  decodeFunctionData, encodeFunctionData, getAddress, isAddress, type Abi, type Address, type Hex,
} from "viem";
import type { WalletCall } from "../core/types.js";
import { ERC20_APPROVE_ABI } from "../ops/abis.js";
import {
  BPS, REBALANCE_CAKE, REBALANCE_MAX_REFERENCE_DEVIATION_BPS,
  REBALANCE_MIN_OUT_BPS, REBALANCE_REFERENCE_DEPTH_WEI, REBALANCE_USDC,
  REBALANCE_ROUTER, REBALANCE_USDT, REBALANCE_WBNB, type RebalanceRiskAsset,
} from "./rebalancePolicy.js";

export const REBALANCE_V2_ROUTER_ABI = [
  {
    type: "function", name: "swapExactTokensForTokens", stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" }, { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ], outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const satisfies Abi;

const RISK_ADDRESSES: Readonly<Record<RebalanceRiskAsset, Address>> = Object.freeze({
  WBNB: REBALANCE_WBNB,
  ETH: getAddress("0x2170Ed0880ac9A755fd29B2688956BD959F933F8"),
  CAKE: REBALANCE_CAKE,
});
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export type SwapDirection = "buy" | "sell";
export type RebalanceRoute = {
  readonly direction: SwapDirection;
  readonly asset: RebalanceRiskAsset;
  readonly path: readonly Address[];
  readonly key: string;
};

function normalizedPath(path: readonly Address[]): readonly Address[] {
  return path.map((token) => getAddress(token));
}
export function rebalancePathKey(path: readonly string[]): string { return path.map((token) => token.toLowerCase()).join("/"); }
function routeKey(path: readonly Address[]): string { return rebalancePathKey(path); }

export function enumerateRebalanceRoutes(
  asset: RebalanceRiskAsset,
  direction: SwapDirection,
): readonly RebalanceRoute[] {
  const token = RISK_ADDRESSES[asset];
  const intermediates = asset === "WBNB" ? [REBALANCE_USDT] : [REBALANCE_USDT, REBALANCE_WBNB];
  const forward = [
    [REBALANCE_USDC, token],
    ...intermediates.map((middle) => [REBALANCE_USDC, middle, token]),
  ].map((route) => normalizedPath(route));
  const routes = (direction === "buy" ? forward : forward.map((path) => [...path].reverse()))
    .map((path) => ({ direction, asset, path, key: routeKey(path) }));
  if (new Set(routes.map((route) => route.key)).size !== routes.length) {
    throw new Error("rebalance-route-duplicate");
  }
  return routes;
}

export function validateRebalancePath(
  path: readonly string[],
  endpoints: { readonly from: Address; readonly to: Address },
): readonly Address[] | null {
  if (path.length < 2 || path.length > 3) return null;
  let normalized: Address[];
  try { normalized = path.map((token) => getAddress(token)); } catch { return null; }
  if (normalized.some((token) => token.toLowerCase() === ZERO_ADDRESS.toLowerCase())) return null;
  if (new Set(normalized.map((token) => token.toLowerCase())).size !== normalized.length) return null;
  if (normalized[0]?.toLowerCase() !== getAddress(endpoints.from).toLowerCase()
    || normalized.at(-1)?.toLowerCase() !== getAddress(endpoints.to).toLowerCase()) return null;
  const from = normalized[0]; const to = normalized.at(-1);
  if (from === undefined || to === undefined) return null;
  const isUsdcFrom = from.toLowerCase() === REBALANCE_USDC.toLowerCase();
  const isUsdcTo = to.toLowerCase() === REBALANCE_USDC.toLowerCase();
  if (isUsdcFrom === isUsdcTo) return null;
  const risk = isUsdcFrom ? to : from;
  const asset = (Object.entries(RISK_ADDRESSES) as [RebalanceRiskAsset, Address][])
    .find(([, address]) => address.toLowerCase() === risk.toLowerCase())?.[0];
  if (asset === undefined) return null;
  const allowed = enumerateRebalanceRoutes(asset, isUsdcFrom ? "buy" : "sell");
  if (!allowed.some((candidate) => candidate.key === routeKey(normalized))) return null;
  return normalized;
}

export function taggedMinimumOutput(quoteOutWei: bigint, actionSequence: bigint): bigint {
  if (quoteOutWei <= 0n || actionSequence <= 0n) throw new Error("rebalance-min-out-invalid");
  const floor = (quoteOutWei * REBALANCE_MIN_OUT_BPS + BPS - 1n) / BPS;
  const tag = actionSequence % 1_000_000n;
  const extra = ((tag - floor) % 1_000_000n + 1_000_000n) % 1_000_000n;
  const tagged = floor + extra;
  if (tagged < floor || tagged > quoteOutWei) throw new Error("rebalance-min-out-tag-invalid");
  return tagged;
}

export function nextUniqueDeadlineSec(input: {
  readonly nowMs: number;
  readonly lastDeadlineSec: number;
  readonly sessionExpirySec: number;
  readonly jobEndMs: number;
}): number {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !Number.isSafeInteger(input.lastDeadlineSec) || input.lastDeadlineSec < 0
    || !Number.isSafeInteger(input.sessionExpirySec) || input.sessionExpirySec <= 0
    || !Number.isSafeInteger(input.jobEndMs) || input.jobEndMs <= 0) {
    throw new Error("rebalance-deadline-input-invalid");
  }
  const nowSec = Math.floor(input.nowMs / 1_000);
  const result = Math.max(nowSec + 600, input.lastDeadlineSec + 1);
  const latest = Math.min(input.sessionExpirySec, Math.floor(input.jobEndMs / 1_000));
  if (result >= latest) throw new Error("rebalance-deadline-window-closed");
  return result;
}

export function buildRebalanceCalls(input: {
  readonly router: Address;
  readonly path: readonly Address[];
  readonly amountInWei: bigint;
  readonly quoteOutWei: bigint;
  readonly recipient: Address;
  readonly deadlineSec: number;
  readonly actionSequence: bigint;
}): { readonly calls: readonly WalletCall[]; readonly minOutWei: bigint } {
  if (getAddress(input.router) !== REBALANCE_ROUTER) throw new Error("rebalance-router-refused");
  const path = validateRebalancePath(input.path, { from: input.path[0] ?? ZERO_ADDRESS, to: input.path.at(-1) ?? ZERO_ADDRESS });
  if (path === null || input.amountInWei <= 0n || input.deadlineSec <= 0
    || !Number.isSafeInteger(input.deadlineSec)) throw new Error("rebalance-call-invalid");
  const router = getAddress(input.router);
  const tokenIn = path[0];
  if (tokenIn === undefined) throw new Error("rebalance-call-invalid");
  const minOutWei = taggedMinimumOutput(input.quoteOutWei, input.actionSequence);
  const swap = encodeFunctionData({
    abi: REBALANCE_V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [input.amountInWei, minOutWei, path, getAddress(input.recipient), BigInt(input.deadlineSec)],
  }) as Hex;
  return {
    minOutWei,
    calls: [
      { to: tokenIn, data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [router, input.amountInWei] }) as Hex },
      { to: router, data: swap },
    ],
  };
}

export type DecodedRebalanceCall = {
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly path: readonly Address[];
  readonly recipient: Address;
  readonly deadlineSec: bigint;
};

export function validateRebalanceCalls(input: {
  readonly calls: readonly WalletCall[];
  readonly router: Address;
  readonly wallet: Address;
  readonly path: readonly Address[];
  readonly amountInWei: bigint;
  readonly minOutWei: bigint;
  readonly deadlineSec: number;
}): DecodedRebalanceCall | null {
  if (input.calls.length !== 2) return null;
  try { if (getAddress(input.router) !== REBALANCE_ROUTER) return null; } catch { return null; }
  const approve = input.calls[0]; const swap = input.calls[1];
  if (approve === undefined || swap === undefined || (approve.value ?? 0n) !== 0n || (swap.value ?? 0n) !== 0n) return null;
  try {
    const path = validateRebalancePath(input.path, {
      from: input.path[0] ?? ZERO_ADDRESS, to: input.path.at(-1) ?? ZERO_ADDRESS,
    });
    if (path === null) return null;
    const tokenIn = path[0];
    if (tokenIn === undefined || getAddress(approve.to) !== tokenIn) return null;
    const approval = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: (approve.data ?? "0x") as Hex });
    if (approval.functionName !== "approve" || approval.args[0] !== getAddress(input.router)
      || approval.args[1] !== input.amountInWei) return null;
    if (getAddress(swap.to) !== getAddress(input.router)) return null;
    const decoded = decodeFunctionData({ abi: REBALANCE_V2_ROUTER_ABI, data: (swap.data ?? "0x") as Hex });
    if (decoded.functionName !== "swapExactTokensForTokens") return null;
    const [amountIn, minOut, rawPath, recipient, deadline] = decoded.args;
    if (amountIn !== input.amountInWei || minOut !== input.minOutWei
      || getAddress(recipient) !== getAddress(input.wallet) || deadline !== BigInt(input.deadlineSec)) return null;
    const decodedPath = rawPath.map((token) => getAddress(token));
    if (routeKey(decodedPath) !== routeKey(path)) return null;
    return { amountInWei: amountIn, minOutWei: minOut, path: decodedPath, recipient: getAddress(recipient), deadlineSec: deadline };
  } catch { return null; }
}

export type Rational = { readonly numerator: bigint; readonly denominator: bigint };
export type RoutePairEvidence = {
  readonly address: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockHash: Hex;
};

function fraction(numerator: bigint, denominator: bigint): Rational {
  if (numerator <= 0n || denominator <= 0n) throw new Error("route-price-invalid");
  return { numerator, denominator };
}
function multiply(a: Rational, b: Rational): Rational {
  return fraction(a.numerator * b.numerator, a.denominator * b.denominator);
}
function reservesAlong(pair: RoutePairEvidence, from: Address, to: Address): { readonly input: bigint; readonly output: bigint } | null {
  if (pair.reserve0 <= 0n || pair.reserve1 <= 0n) return null;
  const token0 = pair.token0.toLowerCase(); const f = from.toLowerCase(); const t = to.toLowerCase();
  if (f === token0 && t !== token0) return { input: pair.reserve0, output: pair.reserve1 };
  if (t === token0 && f !== token0) return { input: pair.reserve1, output: pair.reserve0 };
  return null;
}

export function marginalRouteSpot(path: readonly Address[], pairs: readonly RoutePairEvidence[]): Rational | null {
  if (path.length < 2 || pairs.length !== path.length - 1) return null;
  let result: Rational = { numerator: 1n, denominator: 1n };
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]; const from = path[index]; const to = path[index + 1];
    if (pair === undefined || from === undefined || to === undefined) return null;
    const endpoints = new Set([from.toLowerCase(), to.toLowerCase()]);
    if (endpoints.size !== 2 || !endpoints.has(pair.token0.toLowerCase())
      || !endpoints.has(pair.token1.toLowerCase())
      || pair.token0.toLowerCase() === pair.token1.toLowerCase()) return null;
    const reserves = reservesAlong(pair, from, to);
    if (reserves === null) return null;
    result = multiply(result, fraction(reserves.output, reserves.input));
  }
  return result;
}

/** Validate the policy depth floor for a fixed reference path without requiring a candidate pool. */
export function referencePathMeetsDepth(path: readonly Address[], pairs: readonly RoutePairEvidence[], blockHash: Hex): boolean {
  if (path.length < 2 || path.length > 3 || pairs.length !== path.length - 1
    || pairs.some((pair) => pair.blockHash.toLowerCase() !== blockHash.toLowerCase())) return false;
  const forward = path[0]?.toLowerCase() === REBALANCE_USDC.toLowerCase() ? path : [...path].reverse();
  const forwardPairs = path[0]?.toLowerCase() === REBALANCE_USDC.toLowerCase() ? pairs : [...pairs].reverse();
  let usdcPerToken: Rational = { numerator: 1n, denominator: 1n };
  for (let index = 0; index < forwardPairs.length; index += 1) {
    const pair = forwardPairs[index]; const from = forward[index]; const to = forward[index + 1];
    if (pair === undefined || from === undefined || to === undefined) return false;
    const reserves = reservesAlong(pair, from, to);
    if (reserves === null || !meetsDepth(reserves.input, usdcPerToken)) return false;
    const nextValue = multiply(usdcPerToken, fraction(reserves.input, reserves.output));
    if (!meetsDepth(reserves.output, nextValue)) return false;
    usdcPerToken = nextValue;
  }
  return marginalRouteSpot(path, pairs) !== null;
}

const REFERENCE_BUY_PATHS: Readonly<Record<string, readonly Address[]>> = Object.freeze({
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_WBNB.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_WBNB],
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_USDT.toLowerCase()}/${REBALANCE_WBNB.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_WBNB],
  [`${REBALANCE_USDC.toLowerCase()}/${RISK_ADDRESSES.ETH.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_USDT, RISK_ADDRESSES.ETH],
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_USDT.toLowerCase()}/${RISK_ADDRESSES.ETH.toLowerCase()}`]: [REBALANCE_USDC, RISK_ADDRESSES.ETH],
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_WBNB.toLowerCase()}/${RISK_ADDRESSES.ETH.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_USDT, RISK_ADDRESSES.ETH],
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_CAKE.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_CAKE],
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_USDT.toLowerCase()}/${REBALANCE_CAKE.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_WBNB, REBALANCE_CAKE],
  [`${REBALANCE_USDC.toLowerCase()}/${REBALANCE_WBNB.toLowerCase()}/${REBALANCE_CAKE.toLowerCase()}`]: [REBALANCE_USDC, REBALANCE_USDT, REBALANCE_CAKE],
});

export function requiredReferencePath(candidatePath: readonly Address[]): readonly Address[] | null {
  if (candidatePath.length < 2 || candidatePath.length > 3) return null;
  if (candidatePath.some((token) => !isAddress(token, { strict: false }))) return null;
  let buyOriented: readonly Address[];
  try {
    buyOriented = candidatePath[0]?.toLowerCase() === REBALANCE_USDC.toLowerCase()
      ? normalizedPath(candidatePath)
      : normalizedPath([...candidatePath].reverse());
  } catch { return null; }
  const found = REFERENCE_BUY_PATHS[routeKey(buyOriented)];
  if (found === undefined) return null;
  return candidatePath[0]?.toLowerCase() === REBALANCE_USDC.toLowerCase()
    ? found : [...found].reverse();
}

function meetsDepth(reserve: bigint, spotUsdcPerToken: Rational): boolean {
  return reserve * spotUsdcPerToken.numerator >= REBALANCE_REFERENCE_DEPTH_WEI * spotUsdcPerToken.denominator;
}

export type ReferenceGuardResult =
  | { readonly ok: true; readonly candidatePrice: Rational; readonly referencePrice: Rational }
  | { readonly ok: false; readonly code: "reference-path-unsupported" | "reference-evidence-invalid" | "reference-pair-overlap" | "reference-depth-low" | "reference-deviation" };

export function evaluateReferenceGuard(input: {
  readonly candidatePath: readonly Address[];
  readonly candidatePairs: readonly RoutePairEvidence[];
  readonly referencePath: readonly Address[];
  readonly referencePairs: readonly RoutePairEvidence[];
  readonly candidateBlockHash: Hex;
  readonly referenceBlockHash: Hex;
}): ReferenceGuardResult {
  const expected = requiredReferencePath(input.candidatePath);
  let normalizedReference: readonly Address[];
  try { normalizedReference = normalizedPath(input.referencePath); } catch { return { ok: false, code: "reference-evidence-invalid" }; }
  if (expected === null || routeKey(expected) !== routeKey(normalizedReference)) {
    return { ok: false, code: "reference-path-unsupported" };
  }
  if (input.candidateBlockHash.toLowerCase() !== input.referenceBlockHash.toLowerCase()
    || input.candidatePairs.length !== input.candidatePath.length - 1
    || input.referencePairs.length !== input.referencePath.length - 1
    || [...input.candidatePairs, ...input.referencePairs].some((pair) => pair.blockHash.toLowerCase() !== input.candidateBlockHash.toLowerCase())) {
    return { ok: false, code: "reference-evidence-invalid" };
  }
  const candidateAddresses = new Set(input.candidatePairs.map((pair) => pair.address.toLowerCase()));
  if (input.referencePairs.some((pair) => candidateAddresses.has(pair.address.toLowerCase()))) {
    return { ok: false, code: "reference-pair-overlap" };
  }
  const referenceForward = input.referencePath[0]?.toLowerCase() === REBALANCE_USDC.toLowerCase()
    ? input.referencePath : [...input.referencePath].reverse();
  const referenceForwardPairs = input.referencePath[0]?.toLowerCase() === REBALANCE_USDC.toLowerCase()
    ? input.referencePairs : [...input.referencePairs].reverse();
  let usdcPerToken: Rational = { numerator: 1n, denominator: 1n };
  for (let index = 0; index < referenceForwardPairs.length; index += 1) {
    const pair = referenceForwardPairs[index]; const from = referenceForward[index]; const to = referenceForward[index + 1];
    if (pair === undefined || from === undefined || to === undefined) return { ok: false, code: "reference-evidence-invalid" };
    const reserves = reservesAlong(pair, from, to);
    if (reserves === null || !meetsDepth(reserves.input, usdcPerToken)) return { ok: false, code: "reference-depth-low" };
    const nextValue = multiply(usdcPerToken, fraction(reserves.input, reserves.output));
    if (!meetsDepth(reserves.output, nextValue)) return { ok: false, code: "reference-depth-low" };
    usdcPerToken = nextValue;
  }
  const candidatePrice = marginalRouteSpot(input.candidatePath, input.candidatePairs);
  const referencePrice = marginalRouteSpot(input.referencePath, input.referencePairs);
  if (candidatePrice === null || referencePrice === null) return { ok: false, code: "reference-evidence-invalid" };
  // marginalRouteSpot follows the supplied path direction; do not invert the
  // risk→USDC sell observations a second time.
  const deviationNumerator = (candidatePrice.numerator * referencePrice.denominator
    - referencePrice.numerator * candidatePrice.denominator);
  const absolute = deviationNumerator < 0n ? -deviationNumerator : deviationNumerator;
  if (absolute * BPS > REBALANCE_MAX_REFERENCE_DEVIATION_BPS
    * referencePrice.numerator * candidatePrice.denominator) {
    return { ok: false, code: "reference-deviation" };
  }
  return { ok: true, candidatePrice, referencePrice };
}

export function rankRoutes<T extends { readonly outputWei: bigint; readonly feeUsdcWei: bigint; readonly hops: number; readonly key: string }>(
  candidates: readonly T[],
  score: (candidate: T) => bigint,
): readonly T[] {
  return [...candidates].sort((a, b) => {
    const delta = score(a) - score(b);
    if (delta !== 0n) return delta > 0n ? -1 : 1;
    if (a.hops !== b.hops) return a.hops - b.hops;
    return a.key.localeCompare(b.key);
  });
}

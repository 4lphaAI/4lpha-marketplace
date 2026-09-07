/** Pancake route discovery for the in-process trader (TRADING-AGENT R3.5 / C31). */
import {
  concatHex,
  createPublicClient,
  fallback,
  getAddress,
  http,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import {
  PANCAKE_V2_ROUTER_56,
  PANCAKE_V3_ROUTER_56,
  WBNB_56,
} from "../ops/venues.js";
import {
  V3_FEE_TIERS,
  type TradeRoute,
  type V3FeeTier,
} from "../ops/route.js";

export const TRADE_MAX_IMPACT_BPS = 300;
export const TRADE_RPC_TIMEOUT_MS = 15_000;

// Duplicated intentionally from src/lp/readers.ts:120; the trade layer cannot import LP (R3.5).
export const PANCAKE_V3_QUOTER_V2_56: Address = getAddress(
  "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
);

// `src/ops/venues.ts` has no USDT export at this revision; this is BSC's canonical USDT.
export const USDT_56: Address = getAddress(
  "0x55d398326f99059fF775485246999027B3197955",
);

export const PANCAKE_V2_QUOTER_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const satisfies Abi;

export const PANCAKE_QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const satisfies Abi;

export interface RouteQuoteReader {
  quoteV2(path: readonly Address[], amountInWei: bigint): Promise<bigint>;
  quoteV3Single(
    tokenIn: Address,
    tokenOut: Address,
    fee: V3FeeTier,
    amountInWei: bigint,
  ): Promise<bigint>;
  quoteV3Path(path: Hex, amountInWei: bigint): Promise<bigint>;
}

export type TradeReceiptLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
};

export interface TradeReceiptReader {
  getReceipt(transactionHash: Hex): Promise<{ readonly logs: readonly TradeReceiptLog[] }>;
}

export interface TradeChainReader extends RouteQuoteReader, TradeReceiptReader {
  getChainId(): Promise<number>;
}

export type CreateRouteQuoteReaderInput = {
  readonly rpcUrls: readonly string[];
  readonly signal?: AbortSignal;
};

/** The AbortSignal is bound into every transport request, including connect (C30). */
export function createRouteQuoteReader(input: CreateRouteQuoteReaderInput): TradeChainReader {
  if (input.rpcUrls.length === 0) throw new Error("At least one BSC RPC URL is required.");
  const transports = input.rpcUrls.map((url) => http(url, {
    timeout: TRADE_RPC_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { fetchOptions: { signal: input.signal } }),
  }));
  const client = createPublicClient({ chain: bsc, transport: fallback(transports) });
  return {
    async getChainId() { return client.getChainId(); },
    async getReceipt(transactionHash) {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash });
      return { logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
      })) };
    },
    async quoteV2(path, amountInWei) {
      const amounts = await client.readContract({
        address: PANCAKE_V2_ROUTER_56,
        abi: PANCAKE_V2_QUOTER_ABI,
        functionName: "getAmountsOut",
        args: [amountInWei, [...path]],
      });
      const amountOut = amounts.at(-1);
      if (amountOut === undefined) throw new Error("Pancake V2 returned no output amount.");
      return amountOut;
    },
    async quoteV3Single(tokenIn, tokenOut, fee, amountInWei) {
      const { result } = await client.simulateContract({
        address: PANCAKE_V3_QUOTER_V2_56,
        abi: PANCAKE_QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n }],
      });
      return result[0];
    },
    async quoteV3Path(path, amountInWei) {
      const { result } = await client.simulateContract({
        address: PANCAKE_V3_QUOTER_V2_56,
        abi: PANCAKE_QUOTER_V2_ABI,
        functionName: "quoteExactInput",
        args: [path, amountInWei],
      });
      return result[0];
    },
  };
}

export function encodeV3Path(tokens: readonly Address[], fees: readonly V3FeeTier[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("A V3 path requires one fee per pool.");
  }
  const parts: Hex[] = [tokens[0] as Hex];
  for (let index = 0; index < fees.length; index += 1) {
    const token = tokens[index + 1];
    const fee = fees[index];
    if (token === undefined || fee === undefined) throw new Error("V3 path is incomplete.");
    parts.push(numberToHex(fee, { size: 3 }), token as Hex);
  }
  return concatHex(parts).toLowerCase() as Hex;
}

export function priceImpactBps(fullOut: bigint, onePercentProbeOut: bigint): bigint {
  const noImpact = onePercentProbeOut * 100n;
  if (noImpact <= 0n || fullOut >= noImpact) return 0n;
  return ((noImpact - fullOut) * 10_000n) / noImpact;
}

export class TradeRouteQuoteError extends Error {
  constructor(readonly code: "NO_ROUTE" | "IMPACT_TOO_HIGH") {
    super(code === "NO_ROUTE" ? "No Pancake route quoted." : "The best route exceeds the impact limit.");
    this.name = "TradeRouteQuoteError";
  }
}

export type BestBuyRoute = {
  readonly venue: "pancake_v2" | "pancake_v3";
  readonly router: Address;
  readonly route: TradeRoute;
  readonly amountOutWei: bigint;
  readonly impactBps: bigint;
};

type RouteProbe = Omit<BestBuyRoute, "amountOutWei" | "impactBps"> & {
  readonly quote: (amountInWei: bigint) => Promise<bigint>;
};

// C31's later seven-path bound wins: V2 + four direct tiers + the two measured
// WBNB/USDT fee choices, whose bStock leg is the live 100-tier route.
const TWO_HOP_FEE_PAIRS: readonly (readonly [V3FeeTier, V3FeeTier])[] = [
  [100, 100],
  [500, 100],
];

export type QuoteBestBuyRouteInput = {
  readonly token: Address;
  readonly amountInWei: bigint;
  readonly rpcUrls: readonly string[];
  readonly signal?: AbortSignal;
  readonly reader?: RouteQuoteReader;
};

export async function quoteBestBuyRoute(input: QuoteBestBuyRouteInput): Promise<BestBuyRoute> {
  if (input.amountInWei <= 0n) throw new TradeRouteQuoteError("NO_ROUTE");
  input.signal?.throwIfAborted();
  const reader = input.reader ?? createRouteQuoteReader(input);
  const probes: RouteProbe[] = [
    {
      venue: "pancake_v2",
      router: PANCAKE_V2_ROUTER_56,
      route: { hops: [], fees: [] },
      quote: (amount) => reader.quoteV2([WBNB_56, input.token], amount),
    },
    ...V3_FEE_TIERS.map((fee): RouteProbe => ({
      venue: "pancake_v3",
      router: PANCAKE_V3_ROUTER_56,
      route: { hops: [], fees: [fee] },
      quote: (amount) => reader.quoteV3Single(WBNB_56, input.token, fee, amount),
    })),
    ...TWO_HOP_FEE_PAIRS.map((fees): RouteProbe => ({
      venue: "pancake_v3",
      router: PANCAKE_V3_ROUTER_56,
      route: { hops: [USDT_56], fees },
      quote: (amount) => reader.quoteV3Path(
        encodeV3Path([WBNB_56, USDT_56, input.token], fees), amount,
      ),
    })),
  ];

  const quoted: Array<{ readonly probe: RouteProbe; readonly amountOutWei: bigint }> = [];
  for (const probe of probes) {
    try {
      input.signal?.throwIfAborted();
      const amountOutWei = await probe.quote(input.amountInWei);
      if (amountOutWei > 0n) quoted.push({ probe, amountOutWei });
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      // One pool reverting is ordinary route discovery; only an all-path miss refuses.
    }
  }
  quoted.sort((left, right) => left.amountOutWei === right.amountOutWei
    ? 0
    : left.amountOutWei > right.amountOutWei ? -1 : 1);
  const best = quoted[0];
  if (best === undefined) throw new TradeRouteQuoteError("NO_ROUTE");
  const probeIn = input.amountInWei / 100n;
  if (probeIn <= 0n) throw new TradeRouteQuoteError("NO_ROUTE");
  let probeOut: bigint;
  try {
    input.signal?.throwIfAborted();
    probeOut = await best.probe.quote(probeIn);
  } catch (error) {
    if (input.signal?.aborted === true) throw error;
    throw new TradeRouteQuoteError("NO_ROUTE");
  }
  if (probeOut <= 0n) throw new TradeRouteQuoteError("NO_ROUTE");
  const impactBps = priceImpactBps(best.amountOutWei, probeOut);
  if (impactBps > BigInt(TRADE_MAX_IMPACT_BPS)) {
    throw new TradeRouteQuoteError("IMPACT_TOO_HIGH");
  }
  return {
    venue: best.probe.venue,
    router: best.probe.router,
    route: best.probe.route,
    amountOutWei: best.amountOutWei,
    impactBps,
  };
}

export type QuoteSellAlongRouteInput = {
  readonly token: Address;
  readonly amountInWei: bigint;
  readonly venue: "pancake_v2" | "pancake_v3";
  readonly route: TradeRoute;
  readonly rpcUrls: readonly string[];
  readonly signal?: AbortSignal;
  readonly reader?: RouteQuoteReader;
};

/** Sells reverse both token order and fee order, matching the existing builders. */
export async function quoteSellAlongRoute(input: QuoteSellAlongRouteInput): Promise<bigint> {
  const reader = input.reader ?? createRouteQuoteReader(input);
  if (input.venue === "pancake_v2") {
    return reader.quoteV2([input.token, ...input.route.hops.toReversed(), WBNB_56], input.amountInWei);
  }
  if (input.route.fees.length !== input.route.hops.length + 1) {
    throw new TradeRouteQuoteError("NO_ROUTE");
  }
  const tokens = [input.token, ...input.route.hops.toReversed(), WBNB_56];
  const fees = input.route.fees.toReversed();
  if (input.route.hops.length === 0) {
    const fee = fees[0];
    if (fee === undefined) throw new TradeRouteQuoteError("NO_ROUTE");
    return reader.quoteV3Single(input.token, WBNB_56, fee, input.amountInWei);
  }
  return reader.quoteV3Path(encodeV3Path(tokens, fees), input.amountInWei);
}

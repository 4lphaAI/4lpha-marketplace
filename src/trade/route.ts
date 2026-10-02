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
  UNISWAP_V3_FEE_TIERS,
  V3_FEE_TIERS,
  type TradeVenueId,
  type TradeRoute,
  type V3FeeTier,
} from "../ops/route.js";
export type { TradeVenueId } from "../ops/route.js";
import { admittedVenueRows } from "./rwa.js";
import type { VenueRow } from "./dataPlaneReads.js";
import { USDT_56 as CANONICAL_USDT_56 } from "./settlement.js";

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
export const USDC_56: Address = getAddress(
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
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
  quoteUniV3Single(
    tokenIn: Address,
    tokenOut: Address,
    fee: V3FeeTier,
    amountInWei: bigint,
  ): Promise<bigint>;
  quoteUniV3Path(path: Hex, amountInWei: bigint): Promise<bigint>;
}

export type TradeReceiptLog = {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
};

export interface TradeReceiptReader {
  getReceipt(transactionHash: Hex): Promise<{ readonly logs: readonly TradeReceiptLog[] }>;
  getTransaction?(transactionHash: Hex): Promise<{ readonly hash: Hex; readonly to: Address; readonly input: Hex; readonly blockNumber: bigint; readonly blockHash: Hex; readonly transactionIndex: bigint }>;
}

export interface TradeChainReader extends RouteQuoteReader, TradeReceiptReader {
  getChainId(): Promise<number>;
}

export type CreateRouteQuoteReaderInput = {
  readonly rpcUrls: readonly string[];
  readonly uniswapQuoter?: Address;
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
    async getTransaction(transactionHash) {
      const transaction = await client.getTransaction({ hash: transactionHash });
      if (transaction.to === null || transaction.blockNumber === null || transaction.blockHash === null) throw new Error("Trade transaction is missing canonical ownership fields.");
      return { hash: transaction.hash, to: transaction.to, input: transaction.input, blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash, transactionIndex: BigInt(transaction.transactionIndex) };
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
    async quoteUniV3Single(tokenIn, tokenOut, fee, amountInWei) {
      if (input.uniswapQuoter === undefined) throw new TradeRouteQuoteError("NO_ROUTE");
      const { result } = await client.simulateContract({
        address: input.uniswapQuoter,
        abi: PANCAKE_QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n }],
      });
      return result[0];
    },
    async quoteUniV3Path(path, amountInWei) {
      if (input.uniswapQuoter === undefined) throw new TradeRouteQuoteError("NO_ROUTE");
      const { result } = await client.simulateContract({
        address: input.uniswapQuoter,
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
  readonly venue: TradeVenueId;
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
  readonly venues?: readonly VenueRow[];
  readonly uniswapRouter?: Address;
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
  const seen = new Set(probes.map((probe) => `${probe.venue}:${probe.route.hops.map((hop) => hop.toLowerCase()).join(",")}:${probe.route.fees.join(",")}`));
  const addDerived = (probe: RouteProbe): void => {
    const key = `${probe.venue}:${probe.route.hops.map((hop) => hop.toLowerCase()).join(",")}:${probe.route.fees.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(probe);
  };
  for (const venue of admittedVenueRows(input.venues)) {
    const quote = venue.quote.toLowerCase();
    const stable = quote === USDT_56.toLowerCase() || quote === USDC_56.toLowerCase();
    if (!stable && quote !== WBNB_56.toLowerCase()) continue;
    if (venue.dex === "pancakeswap" && venue.version === "v2") {
      addDerived({
        venue: "pancake_v2",
        router: PANCAKE_V2_ROUTER_56,
        route: stable ? { hops: [venue.quote], fees: [] } : { hops: [], fees: [] },
        quote: (amount) => reader.quoteV2(
          stable ? [WBNB_56, venue.quote, input.token] : [WBNB_56, input.token], amount,
        ),
      });
      continue;
    }
    if (venue.feeTier === null || venue.version !== "v3") continue;
    const tier = venue.feeTier as V3FeeTier;
    const fees = venue.dex === "pancakeswap" ? V3_FEE_TIERS : UNISWAP_V3_FEE_TIERS;
    if (!fees.some((candidate) => candidate === tier)) continue;
    if (venue.dex === "pancakeswap") {
      if (stable) {
        for (const hopFee of [100, 500] as const) {
          const route = { hops: [venue.quote], fees: [hopFee, tier] as const };
          addDerived({
            venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56, route,
            quote: (amount) => reader.quoteV3Path(
              encodeV3Path([WBNB_56, venue.quote, input.token], route.fees), amount,
            ),
          });
        }
      } else {
        const route = { hops: [], fees: [tier] as const };
        addDerived({
          venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56, route,
          quote: (amount) => reader.quoteV3Single(WBNB_56, input.token, tier, amount),
        });
      }
      continue;
    }
    if (input.uniswapRouter === undefined || reader.quoteUniV3Single === undefined || reader.quoteUniV3Path === undefined) continue;
    if (stable) {
      for (const hopFee of [100, 500] as const) {
        const route = { hops: [venue.quote], fees: [hopFee, tier] as const };
        addDerived({
          venue: "uniswap_v3", router: input.uniswapRouter, route,
          quote: (amount) => reader.quoteUniV3Path!(
            encodeV3Path([WBNB_56, venue.quote, input.token], route.fees), amount,
          ),
        });
      }
    } else {
      const route = { hops: [], fees: [tier] as const };
      addDerived({
        venue: "uniswap_v3", router: input.uniswapRouter, route,
        quote: (amount) => reader.quoteUniV3Single!(WBNB_56, input.token, tier, amount),
      });
    }
  }
  probes.splice(16);

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
  readonly venue: TradeVenueId;
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
    if (input.venue === "uniswap_v3") {
      if (reader.quoteUniV3Single === undefined || !UNISWAP_V3_FEE_TIERS.includes(fee as (typeof UNISWAP_V3_FEE_TIERS)[number])) {
        throw new TradeRouteQuoteError("NO_ROUTE");
      }
      return reader.quoteUniV3Single(input.token, WBNB_56, fee, input.amountInWei);
    }
    if (!V3_FEE_TIERS.includes(fee as (typeof V3_FEE_TIERS)[number])) throw new TradeRouteQuoteError("NO_ROUTE");
    return reader.quoteV3Single(input.token, WBNB_56, fee, input.amountInWei);
  }
  if (input.venue === "uniswap_v3") {
    if (reader.quoteUniV3Path === undefined || fees.some((fee) => !UNISWAP_V3_FEE_TIERS.includes(fee as (typeof UNISWAP_V3_FEE_TIERS)[number]))) {
      throw new TradeRouteQuoteError("NO_ROUTE");
    }
    return reader.quoteUniV3Path(encodeV3Path(tokens, fees), input.amountInWei);
  }
  if (fees.some((fee) => !V3_FEE_TIERS.includes(fee as (typeof V3_FEE_TIERS)[number]))) {
    throw new TradeRouteQuoteError("NO_ROUTE");
  }
  return reader.quoteV3Path(encodeV3Path(tokens, fees), input.amountInWei);
}

export type TradfiRoute = {
  readonly hops: readonly Address[];
  readonly fees: readonly V3FeeTier[];
};

export type TradfiVenue = "pancake_v2" | "pancake_v3" | "uniswap_v3";

export type TradfiQuote = {
  readonly venue: TradfiVenue;
  readonly router: Address;
  readonly route: TradfiRoute;
  readonly settlementToken: Address;
  readonly token: Address;
  readonly amountInAtomic: bigint;
  readonly quotedOutAtomic: bigint;
  readonly minOutAtomic: bigint;
  readonly observedAt: number;
  readonly expiresAt: number;
};

type TradfiProbe = {
  readonly venue: TradfiVenue;
  readonly router: Address;
  readonly route: TradfiRoute;
  readonly quote: (amountIn: bigint) => Promise<bigint>;
};

/** Bounded token-to-token quote discovery for the explicit settlement token. */
export async function quoteBestTradfiBuy(input: {
  readonly settlementToken?: Address;
  readonly token: Address;
  readonly amountInAtomic: bigint;
  readonly slippageBps: number;
  readonly rpcUrls: readonly string[];
  readonly reader?: RouteQuoteReader;
  readonly venues?: readonly VenueRow[];
  readonly uniswapRouter?: Address;
  readonly nowMs?: number;
  readonly signal?: AbortSignal;
}): Promise<TradfiQuote> {
  const settlementToken = getAddress(input.settlementToken ?? CANONICAL_USDT_56);
  const token = getAddress(input.token);
  const requestStartedAt = input.nowMs ?? Date.now();
  const localExpiry = requestStartedAt + 15_000;
  if (settlementToken.toLowerCase() === token.toLowerCase() || input.amountInAtomic <= 0n) {
    throw new TradeRouteQuoteError("NO_ROUTE");
  }
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 500) {
    throw new TradeRouteQuoteError("NO_ROUTE");
  }
  const reader = input.reader ?? createRouteQuoteReader(input);
  const probes: TradfiProbe[] = [];
  const admitted = input.venues === undefined ? [] : admittedVenueRows(input.venues);
  const add = (probe: TradfiProbe): void => {
    const key = `${probe.venue}:${probe.route.hops.map((h) => h.toLowerCase()).join(",")}:${probe.route.fees.join(",")}`;
    if (!probes.some((row) => `${row.venue}:${row.route.hops.map((h) => h.toLowerCase()).join(",")}:${row.route.fees.join(",")}` === key)) probes.push(probe);
  };
  add({ venue: "pancake_v2", router: PANCAKE_V2_ROUTER_56, route: { hops: [], fees: [] },
    quote: (amount) => reader.quoteV2([settlementToken, token], amount) });
  for (const fee of V3_FEE_TIERS) {
    add({ venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56, route: { hops: [], fees: [fee] },
      quote: (amount) => reader.quoteV3Single(settlementToken, token, fee, amount) });
  }
  for (const intermediary of [WBNB_56, USDC_56] as const) {
    add({ venue: "pancake_v2", router: PANCAKE_V2_ROUTER_56, route: { hops: [intermediary], fees: [] },
      quote: (amount) => reader.quoteV2([settlementToken, intermediary, token], amount) });
    for (const tier of V3_FEE_TIERS) {
      const route = { hops: [intermediary], fees: [100, tier] as const };
      add({ venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56, route,
        quote: (amount) => reader.quoteV3Path(encodeV3Path([settlementToken, intermediary, token], route.fees), amount) });
    }
  }
  if (input.uniswapRouter !== undefined) {
    for (const fee of UNISWAP_V3_FEE_TIERS) {
      add({ venue: "uniswap_v3", router: input.uniswapRouter, route: { hops: [], fees: [fee] },
        quote: (amount) => reader.quoteUniV3Single(settlementToken, token, fee, amount) });
    }
    for (const intermediary of [WBNB_56, USDC_56] as const) {
      for (const tier of UNISWAP_V3_FEE_TIERS) {
        const route = { hops: [intermediary], fees: [100, tier] as const };
        add({ venue: "uniswap_v3", router: input.uniswapRouter, route,
          quote: (amount) => reader.quoteUniV3Path(encodeV3Path([settlementToken, intermediary, token], route.fees), amount) });
      }
    }
  }
  const routeKey = (probe: TradfiProbe): string => `${probe.venue}:${probe.route.hops.map((h) => h.toLowerCase()).join(",")}:${probe.route.fees.join(",")}`;
  const admittedKeys = new Set(admitted.map((row) => {
    const venue: TradfiVenue = row.dex === "uniswap" ? "uniswap_v3" : row.version === "v2" ? "pancake_v2" : "pancake_v3";
    const quoteIsSettlement = row.quote.toLowerCase() === settlementToken.toLowerCase();
    const hops = quoteIsSettlement ? [] : [row.quote];
    const fees = row.version === "v2" ? [] : quoteIsSettlement
      ? [row.feeTier ?? 0]
      : [100, row.feeTier ?? 0];
    return `${venue}:${hops.map((h) => h.toLowerCase()).join(",")}:${fees.join(",")}`;
  }));
  let active = admitted.length === 0 ? probes : probes.filter((probe) => admittedKeys.has(routeKey(probe)));
  if (active.length > 16) {
    const selected = active.slice(0, 16);
    const uniswap = active.find((probe) => probe.venue === "uniswap_v3");
    if (uniswap !== undefined && !selected.some((probe) => probe.venue === "uniswap_v3")) selected[selected.length - 1] = uniswap;
    active = selected;
  }
  const rows: Array<{ readonly probe: TradfiProbe; readonly out: bigint }> = [];
  for (const probe of active) {
    try {
      input.signal?.throwIfAborted();
      const out = await probe.quote(input.amountInAtomic);
      if (out > 0n) rows.push({ probe, out });
    } catch {
      if (input.signal?.aborted === true) throw new Error("TradFi quote cancelled.");
    }
  }
  rows.sort((a, b) => b.out > a.out ? 1 : b.out < a.out ? -1 : a.probe.venue.localeCompare(b.probe.venue));
  const best = rows[0];
  if (best === undefined) throw new TradeRouteQuoteError("NO_ROUTE");
  if (Date.now() > localExpiry) throw new TradeRouteQuoteError("NO_ROUTE");
  const minOut = best.out * BigInt(10_000 - input.slippageBps) / 10_000n;
  if (minOut <= 0n) throw new TradeRouteQuoteError("NO_ROUTE");
  return { venue: best.probe.venue, router: best.probe.router, route: best.probe.route,
    settlementToken, token, amountInAtomic: input.amountInAtomic, quotedOutAtomic: best.out,
    minOutAtomic: minOut, observedAt: requestStartedAt, expiresAt: localExpiry };
}

/** Fresh bounded token-to-USDT route quote used by v2 exits. */
export async function quoteBestTradfiSell(input: {
  readonly settlementToken?: Address;
  readonly token: Address;
  readonly amountInAtomic: bigint;
  readonly slippageBps: number;
  readonly rpcUrls: readonly string[];
  readonly reader?: RouteQuoteReader;
  readonly venues?: readonly VenueRow[];
  readonly uniswapRouter?: Address;
  readonly nowMs?: number;
  readonly signal?: AbortSignal;
}): Promise<TradfiQuote> {
  const settlementToken = getAddress(input.settlementToken ?? CANONICAL_USDT_56);
  const token = getAddress(input.token);
  const started = input.nowMs ?? Date.now();
  if (input.amountInAtomic <= 0n || token.toLowerCase() === settlementToken.toLowerCase()) throw new TradeRouteQuoteError("NO_ROUTE");
  const reader = input.reader ?? createRouteQuoteReader(input);
  const probes: TradfiProbe[] = [];
  const add = (probe: TradfiProbe): void => {
    const key = `${probe.venue}:${probe.route.hops.map((h) => h.toLowerCase()).join(",")}:${probe.route.fees.join(",")}`;
    if (!probes.some((row) => `${row.venue}:${row.route.hops.map((h) => h.toLowerCase()).join(",")}:${row.route.fees.join(",")}` === key)) probes.push(probe);
  };
  add({ venue: "pancake_v2", router: PANCAKE_V2_ROUTER_56, route: { hops: [], fees: [] }, quote: (amount) => reader.quoteV2([token, settlementToken], amount) });
  for (const fee of V3_FEE_TIERS) add({ venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56, route: { hops: [], fees: [fee] }, quote: (amount) => reader.quoteV3Single(token, settlementToken, fee, amount) });
  for (const intermediary of [WBNB_56, USDC_56] as const) {
    add({ venue: "pancake_v2", router: PANCAKE_V2_ROUTER_56, route: { hops: [intermediary], fees: [] }, quote: (amount) => reader.quoteV2([token, intermediary, settlementToken], amount) });
    for (const tier of V3_FEE_TIERS) {
      const route = { hops: [intermediary], fees: [tier, 100] as const };
      add({ venue: "pancake_v3", router: PANCAKE_V3_ROUTER_56, route, quote: (amount) => reader.quoteV3Path(encodeV3Path([token, intermediary, settlementToken], route.fees), amount) });
    }
  }
  if (input.uniswapRouter !== undefined) {
    for (const fee of UNISWAP_V3_FEE_TIERS) add({ venue: "uniswap_v3", router: input.uniswapRouter, route: { hops: [], fees: [fee] }, quote: (amount) => reader.quoteUniV3Single(token, settlementToken, fee, amount) });
    for (const intermediary of [WBNB_56, USDC_56] as const) for (const tier of UNISWAP_V3_FEE_TIERS) {
      const route = { hops: [intermediary], fees: [tier, 100] as const };
      add({ venue: "uniswap_v3", router: input.uniswapRouter, route, quote: (amount) => reader.quoteUniV3Path(encodeV3Path([token, intermediary, settlementToken], route.fees), amount) });
    }
  }
  const admitted = input.venues === undefined ? [] : admittedVenueRows(input.venues);
  if (admitted.length > 0) {
    const allowed = new Set(admitted.map((row) => `${row.dex === "uniswap" ? "uniswap_v3" : row.version === "v2" ? "pancake_v2" : "pancake_v3"}:${row.quote.toLowerCase() === settlementToken.toLowerCase() ? "" : row.quote.toLowerCase()}:${row.version === "v2" ? "" : row.quote.toLowerCase() === settlementToken.toLowerCase() ? String(row.feeTier ?? 0) : `${row.feeTier ?? 0},100`}`));
    const filtered = probes.filter((probe) => allowed.has(`${probe.venue}:${probe.route.hops.map((h) => h.toLowerCase()).join(",")}:${probe.route.fees.join(",")}`));
    probes.splice(0, probes.length, ...filtered);
  }
  let best: { probe: TradfiProbe; out: bigint } | undefined;
  for (const probe of probes.slice(0, 24)) {
    try { input.signal?.throwIfAborted(); const out = await probe.quote(input.amountInAtomic); if (out > 0n && (best === undefined || out > best.out)) best = { probe, out }; }
    catch { if (input.signal?.aborted === true) throw new Error("TradFi quote cancelled."); }
  }
  if (best === undefined || Date.now() > started + 15_000) throw new TradeRouteQuoteError("NO_ROUTE");
  const minOut = best.out * BigInt(10_000 - input.slippageBps) / 10_000n;
  return { venue: best.probe.venue, router: best.probe.router, route: best.probe.route, settlementToken, token,
    amountInAtomic: input.amountInAtomic, quotedOutAtomic: best.out, minOutAtomic: minOut, observedAt: started, expiresAt: started + 15_000 };
}

export type TradfiOffer = {
  readonly source: "direct-amm" | "binance";
  readonly amountInAtomic: bigint;
  readonly quotedOutAtomic: bigint;
  readonly minOutAtomic: bigint;
  readonly inputFeeAtomic: bigint;
  readonly outputFeeAtomic: bigint;
  readonly estimatedNativeCostWei: bigint | null;
  readonly nativeCostUsdtAtomic: bigint | null;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly feeIncludedFlags: { readonly input: boolean; readonly output: boolean };
  readonly venueOrder: string;
};

function betterDirect(left: TradfiOffer, right: TradfiOffer): boolean {
  return left.source === "direct-amm" && right.source !== "direct-amm";
}

/** Deterministic economic comparison; missing cost only affects entry ranking. */
export function rankTradfiOffers(side: "buy" | "sell", offers: readonly TradfiOffer[]): readonly TradfiOffer[] {
  const eligible = offers.filter((offer) => offer.amountInAtomic > 0n && offer.quotedOutAtomic > 0n
    && offer.minOutAtomic > 0n && offer.minOutAtomic <= offer.quotedOutAtomic
    && offer.inputFeeAtomic >= 0n && offer.outputFeeAtomic >= 0n
    && (offer.nativeCostUsdtAtomic === null || offer.nativeCostUsdtAtomic >= 0n)
    && (side === "sell" || offer.nativeCostUsdtAtomic !== null));
  const ranked = [...eligible];
  const sellHasCompleteCost = side === "sell" && ranked.length > 0
    && ranked.every((offer) => offer.nativeCostUsdtAtomic !== null);
  ranked.sort((left, right) => {
    if (side === "buy") {
      const leftDen = left.amountInAtomic + (left.feeIncludedFlags.input ? 0n : left.inputFeeAtomic) + (left.nativeCostUsdtAtomic ?? 0n);
      const rightDen = right.amountInAtomic + (right.feeIncludedFlags.input ? 0n : right.inputFeeAtomic) + (right.nativeCostUsdtAtomic ?? 0n);
      const leftNet = left.quotedOutAtomic - (left.feeIncludedFlags.output ? 0n : left.outputFeeAtomic);
      const rightNet = right.quotedOutAtomic - (right.feeIncludedFlags.output ? 0n : right.outputFeeAtomic);
      const cross = leftNet * rightDen - rightNet * leftDen;
      if (cross !== 0n) return cross > 0n ? -1 : 1;
      const minCross = left.minOutAtomic * rightDen - right.minOutAtomic * leftDen;
      if (minCross !== 0n) return minCross > 0n ? -1 : 1;
    } else if (sellHasCompleteCost) {
      const leftNet = left.quotedOutAtomic - (left.feeIncludedFlags.output ? 0n : left.outputFeeAtomic) - (left.nativeCostUsdtAtomic ?? 0n);
      const rightNet = right.quotedOutAtomic - (right.feeIncludedFlags.output ? 0n : right.outputFeeAtomic) - (right.nativeCostUsdtAtomic ?? 0n);
      if (leftNet !== rightNet) return leftNet > rightNet ? -1 : 1;
      const leftMin = left.minOutAtomic - (left.feeIncludedFlags.output ? 0n : left.outputFeeAtomic);
      const rightMin = right.minOutAtomic - (right.feeIncludedFlags.output ? 0n : right.outputFeeAtomic);
      if (leftMin !== rightMin) return leftMin > rightMin ? -1 : 1;
    } else if (left.minOutAtomic !== right.minOutAtomic) {
      return left.minOutAtomic > right.minOutAtomic ? -1 : 1;
    } else if (left.quotedOutAtomic !== right.quotedOutAtomic) {
      return left.quotedOutAtomic > right.quotedOutAtomic ? -1 : 1;
    }
    if (betterDirect(left, right)) return -1;
    if (betterDirect(right, left)) return 1;
    return left.venueOrder.localeCompare(right.venueOrder);
  });
  return ranked;
}

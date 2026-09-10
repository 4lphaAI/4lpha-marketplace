/**
 * The quant plane's own chain reader (R2.4, R3.9, BC34).
 *
 * ─── WHY NOT `src/trade/route.ts` ──────────────────────────────────────────
 *
 * Its `quoteV2` takes NO block parameter (`route.ts:141`), and R3.9's whole
 * point is that a quote must be read at an EXPLICIT height so "the quote block
 * is at or after the trigger block" is a FACT rather than an assumption. That
 * file is also the trade layer, which the quant closure does not reach. So this
 * is a second reader — and `src/trade/route.ts` is not modified.
 *
 * The ABI fragments below are the smallest that answer the questions this
 * strategy asks, and each has exactly one entry per name (the PHASE2.2 R6
 * rule: viem resolves `functionName` against whichever entry it finds).
 */
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";

export const QUANT_RPC_TIMEOUT_MS = 15_000;

export const V2_ROUTER_QUOTER_ABI = [
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

export const V2_PAIR_ABI = [
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const satisfies Abi;

export const V2_FACTORY_ABI = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const satisfies Abi;

export const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

export type QuantBlock = {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestampSec: bigint;
};

export type QuantReserves = {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly token0: Address;
};

/**
 * Every chain read the quant plane makes. A SEAM, so the offline suites drive
 * scripted chains and the self-test drives the real one through the identical
 * code path.
 */
export interface QuantChainReader {
  chainId(): Promise<number>;
  finalizedBlock(): Promise<QuantBlock>;
  latestBlockNumber(): Promise<bigint>;
  blockAt(blockNumber: bigint): Promise<QuantBlock>;
  reservesAt(pair: Address, blockNumber: bigint): Promise<QuantReserves>;
  pairToken0(pair: Address): Promise<Address>;
  getPair(factory: Address, tokenA: Address, tokenB: Address): Promise<Address>;
  /** `getAmountsOut` at an EXPLICIT height (R3.9). */
  quoteV2At(
    router: Address,
    path: readonly Address[],
    amountInWei: bigint,
    blockNumber: bigint,
  ): Promise<bigint>;
  tokenBalanceAt(token: Address, account: Address, blockNumber?: bigint): Promise<bigint>;
  nativeBalanceAt(account: Address, blockNumber?: bigint): Promise<bigint>;
  getTransaction(hash: Hex): Promise<{
    readonly hash: Hex;
    readonly to: Address | null;
    readonly input: Hex;
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly transactionIndex: bigint;
  } | null>;
  getReceipt(hash: Hex): Promise<{
    readonly status: bigint;
    readonly transactionHash: Hex;
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly transactionIndex: bigint;
    readonly logs: readonly {
      readonly address: Address;
      readonly topics: readonly Hex[];
      readonly data: Hex;
      readonly logIndex: bigint;
    }[];
  } | null>;
}

export function createQuantChainReader(input: {
  readonly rpcUrls: readonly string[];
  readonly signal?: AbortSignal;
}): QuantChainReader {
  if (input.rpcUrls.length === 0) {
    throw new Error("The quant chain reader requires at least one RPC URL.");
  }
  const transports = input.rpcUrls.map((url) => http(url, {
    timeout: QUANT_RPC_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { fetchOptions: { signal: input.signal } }),
  }));
  const client = createPublicClient({ chain: bsc, transport: fallback(transports) });
  return {
    async chainId() { return client.getChainId(); },
    async finalizedBlock() {
      const block = await client.getBlock({ blockTag: "finalized" });
      return { number: block.number, hash: block.hash, timestampSec: block.timestamp };
    },
    async latestBlockNumber() { return client.getBlockNumber(); },
    async blockAt(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash, timestampSec: block.timestamp };
    },
    async reservesAt(pair, blockNumber) {
      const [reserves, token0] = await Promise.all([
        client.readContract({
          address: getAddress(pair), abi: V2_PAIR_ABI, functionName: "getReserves", blockNumber,
        }),
        client.readContract({
          address: getAddress(pair), abi: V2_PAIR_ABI, functionName: "token0", blockNumber,
        }),
      ]);
      return {
        reserve0: BigInt(reserves[0]),
        reserve1: BigInt(reserves[1]),
        token0: getAddress(token0),
      };
    },
    async pairToken0(pair) {
      return getAddress(await client.readContract({
        address: getAddress(pair), abi: V2_PAIR_ABI, functionName: "token0",
      }));
    },
    async getPair(factory, tokenA, tokenB) {
      return getAddress(await client.readContract({
        address: getAddress(factory), abi: V2_FACTORY_ABI, functionName: "getPair",
        args: [getAddress(tokenA), getAddress(tokenB)],
      }));
    },
    async quoteV2At(router, path, amountInWei, blockNumber) {
      const amounts = await client.readContract({
        address: getAddress(router),
        abi: V2_ROUTER_QUOTER_ABI,
        functionName: "getAmountsOut",
        args: [amountInWei, path.map((token) => getAddress(token))],
        blockNumber,
      });
      const out = amounts.at(-1);
      if (out === undefined) throw new Error("Pancake V2 returned no output amount.");
      return out;
    },
    async tokenBalanceAt(token, account, blockNumber) {
      return client.readContract({
        address: getAddress(token), abi: ERC20_BALANCE_ABI, functionName: "balanceOf",
        args: [getAddress(account)],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
    },
    async nativeBalanceAt(account, blockNumber) {
      return client.getBalance({
        address: getAddress(account),
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
    },
    async getTransaction(hash) {
      try {
        const tx = await client.getTransaction({ hash });
        if (tx.blockNumber === null || tx.blockHash === null) return null;
        return {
          hash: tx.hash,
          to: tx.to === null ? null : getAddress(tx.to),
          input: tx.input,
          blockNumber: tx.blockNumber,
          blockHash: tx.blockHash,
          transactionIndex: BigInt(tx.transactionIndex),
        };
      } catch {
        return null;
      }
    },
    async getReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          status: receipt.status === "success" ? 1n : 0n,
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionIndex: BigInt(receipt.transactionIndex),
          logs: receipt.logs.map((log) => ({
            address: getAddress(log.address),
            topics: log.topics,
            data: log.data,
            logIndex: BigInt(log.logIndex),
          })),
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * `mid` from reserves, in POOL ORDER — the caller supplies `token0` and the U
 * address, and this decides which reserve is which.
 *
 * The orientation is read from the POOL, never from a caller's token order:
 * the factory resolves either order to the same pair, so trusting the caller is
 * how a price ends up inverted (the demo-mode `wbnbIsToken0` finding).
 */
export function orderedReserves(
  reserves: QuantReserves,
  u: Address,
): { readonly reserveUWei: bigint; readonly reserveWbnbWei: bigint } {
  const uIsToken0 = reserves.token0.toLowerCase() === getAddress(u).toLowerCase();
  return uIsToken0
    ? { reserveUWei: reserves.reserve0, reserveWbnbWei: reserves.reserve1 }
    : { reserveUWei: reserves.reserve1, reserveWbnbWei: reserves.reserve0 };
}

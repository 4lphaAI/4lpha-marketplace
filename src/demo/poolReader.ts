/**
 * DEMO MODE — a minimal, read-only pool reader.
 *
 * ─── WHY NOT `createLpChainReaders` ────────────────────────────────────────
 *
 * The LP readers are the right thing for the LP plane and the wrong thing
 * here. They need an NFPM, a quoter, a TWAP window and the whole LP
 * composition, they pin every read to a FINALIZED block for the finality rail,
 * and they pull `src/wallet/**` and `src/ops/**` in transitively — modules
 * `src/demo/**` exists in order not to touch.
 *
 * A demo needs exactly two facts: which pool a triple names, and what tick it
 * is at. That is one `getPool` and one `slot0`/`tickSpacing`, so this file is
 * those two calls and nothing else. It imports viem and viem only.
 *
 * ─── NOT FINALIZED, AND THAT IS CORRECT HERE ───────────────────────────────
 *
 * The live rails read `finalized` because a reorg could otherwise unwind a
 * decision that moved money. A demo decision moves nothing, and reading the
 * LATEST tick is what makes the simulation feel live to the person watching it.
 * The trade-off is stated rather than inherited: a reorged tick can produce a
 * simulated fill that "should not" have happened, which costs a wrong line in
 * a demo's history and nothing else.
 *
 * The pinned addresses are RESTATED here with their provenance rather than
 * imported, for the same reason `config.ts` restates the relay fee: the import
 * would be the whole LP module. Both are verified constants, and a drift
 * between the two copies is caught by the test that pins them.
 */
import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";

/**
 * PancakeSwap V3 factory on BNB Chain 56.
 *
 * VERIFIED 2026-08-13 against deployed bytecode (PHASE3-REVIEW facts: 5 151
 * bytes, not a proxy; `getPool` 0x1698ee82 present). Same value as
 * `PANCAKE_V3_FACTORY_56` in `src/lp/readers.ts`.
 */
export const DEMO_PANCAKE_V3_FACTORY_56: Address = getAddress(
  "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
);

/** WBNB on BNB Chain 56 — the quote leg every demo grid reports in. */
export const DEMO_WBNB_56: Address = getAddress(
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
);

const FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

const POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "tickSpacing",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export type DemoPoolReader = {
  getPool(token0: Address, token1: Address, fee: number): Promise<Address | null>;
  poolTick(
    pool: Address,
  ): Promise<{ readonly currentTick: number; readonly tickSpacing: number } | null>;
  /**
   * The pool's OWN `token0`.
   *
   * REVIEW FIX (finding 14): `wbnbIsToken0` used to be derived from the order
   * the CALLER listed the two tokens in, but the factory resolves either order
   * to the same pool — so a request that named WBNB first for a pool where
   * WBNB is actually token1 got a grid interpreted in the wrong orientation,
   * with the ladder derived and scored upside down. Pool order is a fact about
   * the pool; it is read from the pool.
   */
  poolToken0(pool: Address): Promise<Address | null>;
};

/**
 * Build the reader over one or more public RPC URLs.
 *
 * Every failure answers `null` rather than throwing: a demo's response to an
 * unreadable chain is to hold and say so, never to guess and never to take the
 * cycle down with it.
 */
export function createDemoPoolReader(input: {
  readonly rpcUrls: readonly string[];
  readonly factory?: Address;
}): DemoPoolReader {
  const factory = input.factory ?? DEMO_PANCAKE_V3_FACTORY_56;
  const urls = [...new Set(input.rpcUrls)].filter((url) => url.trim().length > 0);
  if (urls.length === 0) {
    throw new Error("createDemoPoolReader: at least one RPC URL is required.");
  }
  let client: PublicClient | undefined;
  const connect = (): PublicClient => {
    client ??= createPublicClient({ transport: http(urls[0] as string) });
    return client;
  };

  return {
    async getPool(token0, token1, fee) {
      try {
        const pool = (await connect().readContract({
          address: factory,
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [token0, token1, fee],
        })) as Address;
        return /^0x0{40}$/iu.test(pool) ? null : getAddress(pool);
      } catch {
        return null;
      }
    },
    async poolTick(pool) {
      try {
        const [slot0, spacing] = await Promise.all([
          connect().readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
          connect().readContract({ address: pool, abi: POOL_ABI, functionName: "tickSpacing" }),
        ]);
        const currentTick = Number((slot0 as readonly unknown[])[1]);
        const tickSpacing = Number(spacing);
        if (!Number.isInteger(currentTick) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
          return null;
        }
        return { currentTick, tickSpacing };
      } catch {
        return null;
      }
    },
    async poolToken0(pool) {
      try {
        const token0 = (await connect().readContract({
          address: pool,
          abi: POOL_ABI,
          functionName: "token0",
        })) as Address;
        return getAddress(token0);
      } catch {
        return null;
      }
    },
  };
}

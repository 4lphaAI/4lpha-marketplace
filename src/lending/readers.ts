/**
 * The lending guard's chain readers — the ONE place this phase's own chain
 * reads happen (MARKETPLACE-LENDING-AGENT R2.9, R2.10, R3.5, R3.10, R3.11).
 *
 * Account A's RISK is read through Phase 4's `createVenusChainReaders`
 * unchanged; this module adds what Phase 4 has no reason to know about:
 *
 *   - wallet B's RESERVE at one pinned finalized block (both allowances, the
 *     pool's `getCash()`, and the WBNB/USDT pool's `slot0` price the swap
 *     solver seeds from);
 *   - a PER-TOKEN rolling-day spend meter, which nothing in the tree had
 *     (`NativeDayMeter` is native-only by construction and
 *     `VenusSizingMarket.capRemainingWei` is hardcoded `null` at both Venus
 *     call sites) — REVIEW2 M1;
 *   - a BOUNDED per-agent construction of the Venus readers, so the universe A
 *     can drag in is capped at {@link LENDING_MAX_MARKETS} on EVERY path,
 *     including the worker's own 30-second cycle (REVIEW2 M7);
 *   - a plain QuoterV2 `quoteExactInputSingle`, the same rail the plane's own
 *     floors use, exposed so the browser's recovery batch can derive `minOut`
 *     from a quote rather than from a price (R3.9).
 *
 * ─── FINALITY DISCIPLINE ───────────────────────────────────────────────────
 *
 * Every DECISION read is taken at `blockTag: "finalized"` and then PINNED to
 * that block number, so A's risk and B's reserve are one coherent snapshot and
 * the sizing cannot mix a fresh balance with a stale debt. A provider that does
 * not support the tag fails the read LOUDLY, which holds the trigger — never a
 * silent fall-back to `latest`.
 *
 * ─── WHAT IS NOT HERE ──────────────────────────────────────────────────────
 *
 * No writes, and no session key. Every read in this module is answerable from
 * PUBLIC FACTS — the meter reader takes `{walletAddress, publicKey}` and
 * derives the key hash the way `onChainNativeDailyCapWei` does, because "a read
 * that needs no key must not ask for one" (`src/core/types.ts`).
 */
import {
  createPublicClient,
  getAddress,
  http,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import { ACCOUNT_ABI } from "../wallet/abis.js";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import { publicKeyToAddress } from "viem/utils";
import { LENDING_MAX_MARKETS } from "../ops/policy.js";
import type { V3FeeTier } from "../ops/route.js";
import {
  createVenusChainReaders,
  type VenusChainReaders,
  type VenusReaderNetwork,
} from "../venus/readers.js";
import { VENUS_COMPTROLLER_ABI, VENUS_ERC20_ABI, VENUS_VTOKEN_ABI } from "../venus/abis.js";
import type { VenusVenue } from "../venus/types.js";
import type { LendingReserveReading, LendingTokenMeterReading } from "./types.js";

/** `spendInfos.period` for a rolling DAY. Mirrors `src/lp/readers.ts:131`. */
export const LENDING_SPEND_PERIOD_DAY = 2;

/** `getCash()` — a READ, granted nothing, selector 0x3b1d21a2. */
const VTOKEN_CASH_ABI = [
  {
    name: "getCash",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "exchangeRateCurrent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * `borrowBalanceStored(address)` — the STORED basis, which is what S1's three
 * bounded reads answer on.
 *
 * Declared here rather than added to `VENUS_VTOKEN_ABI`: Phase 4 reads the
 * stored borrow out of `getAccountSnapshot`'s tuple and has no call site for
 * this fragment, and widening a shared ABI for one new caller is how two
 * phases end up sharing a surface neither of them re-reviewed.
 */
const VTOKEN_BORROW_STORED_ABI = [
  {
    name: "borrowBalanceStored",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** `slot0()` and `token0()` on a Pancake V3 pool — the solver's price seed. */
const V3_POOL_ABI = [
  {
    name: "slot0",
    type: "function",
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
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "liquidity",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
] as const;

/** The Pancake V3 factory's pool lookup, for the boot pin. */
const V3_FACTORY_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

/** The plain QuoterV2 struct form — REFUTED live in any other argument order. */
const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
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
] as const;

/** Thrown when A is in more markets than the guard can price (R3.11). */
export class LendingAccountTooComplexError extends Error {
  constructor(
    readonly account: Address,
    readonly marketCount: number,
  ) {
    super(
      `Account ${account} is in ${marketCount} markets, above the ${LENDING_MAX_MARKETS} this guard can price in one cycle.`,
    );
    this.name = "LendingAccountTooComplexError";
  }
}

export type LendingVenue = {
  readonly vUsdt: Address;
  readonly usdt: Address;
  readonly vBnb: Address;
  readonly routerV3: Address;
  readonly wbnb: Address;
  readonly quoterV2: Address;
  readonly factoryV3: Address;
  /** The pinned WBNB/USDT pool for the arm/rescue/retire swaps (R2.19). */
  readonly swapPool: Address;
  readonly swapFeeTier: V3FeeTier;
  readonly treasury: Address;
};

export interface LendingChainReaders {
  /**
   * Wallet B's reserve at ONE pinned finalized block.
   *
   * Both allowances are read even though only the vUSDT one is a builder
   * input: dropping the router read would make R2.24's "dropping either
   * allowance read fails by name" a test of nothing, and the residual
   * allowance to the router is a real figure the owner view reports.
   */
  readReserve(wallet: Address, signal?: AbortSignal): Promise<LendingReserveReading>;

  /**
   * One token's rolling-day meter, from PUBLIC FACTS ONLY (R3.5).
   *
   * `token: null` reads the NATIVE meter, exactly as
   * `onChainNativeDailyCapWei` does. Every failure mode is TYPED and none of
   * them refuses a rescue: the caller omits the term and reports
   * `cap-unreadable`.
   */
  readTokenDayMeter(input: {
    readonly walletAddress: Address;
    readonly publicKey: Hex;
    readonly token: Address | null;
  }): Promise<LendingTokenMeterReading>;

  /** A QuoterV2 `quoteExactInputSingle` on the pinned pool's fee tier. */
  quote(input: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountInWei: bigint;
    readonly fee?: number;
  }): Promise<bigint>;

  /**
   * The block ONE transaction landed in — FIXREVIEW F7.
   *
   * OPTIONAL, and every caller must behave correctly without it: the offline
   * suites inject readers that do not implement it, and a production endpoint
   * that cannot answer must not block an arm. It exists so `armBlock` can be
   * the block the arm ACTUALLY landed in rather than the finalized block of a
   * read taken afterwards — two different numbers that were recorded in one
   * column under a name that promised the first. A caller that gets `null`
   * falls back to the post-arm read and LABELS it as such
   * (`armBlockSource: "post-arm-read"`).
   */
  readTransactionBlock?(txHash: Hex): Promise<bigint | null>;

  /** The pinned swap pool's liveness proof, for the boot validation (R2.19). */
  readSwapPool(): Promise<{
    readonly pool: Address;
    readonly liquidity: bigint;
    readonly token0: Address;
  }>;

  /**
   * Construct a BOUNDED Venus reader for one guarded account (R2.10, R3.11).
   *
   * The universe is `getAssetsIn(A) ∪ debtMarkets`, and crossing
   * {@link LENDING_MAX_MARKETS} throws {@link LendingAccountTooComplexError}
   * rather than fanning out. `readAccount` itself imposes no cap, so this
   * wrapper is the ONLY thing standing between a third party's market
   * membership and the worker's 30-second read budget.
   */
  readAccount(
    account: Address,
    debtMarkets: readonly Address[],
    signal?: AbortSignal,
  ): Promise<import("../venus/types.js").VenusAccountReading>;

  /** The THREE bounded reads S1 performs after verifying the receipt (R3.14/L1). */
  readS1Facts(
    account: Address,
    debtMarkets: readonly Address[],
    signal?: AbortSignal,
  ): Promise<{
    readonly blockNumber: bigint;
    readonly liquidityErrorCode: bigint;
    readonly borrows: readonly { readonly vToken: Address; readonly borrowWei: bigint }[];
  }>;
}

export type CreateLendingChainReadersOptions = {
  readonly network: VenusReaderNetwork;
  readonly rpcUrls?: readonly string[];
  readonly transport?: (rpcUrl: string) => Transport;
  readonly venue: LendingVenue;
  readonly venusVenue: VenusVenue;
  /** Injection seam for the offline suites. Production passes nothing. */
  readonly makeVenusReaders?: (markets: readonly Address[]) => VenusChainReaders;
};

type Connection = { readonly publicClient: PublicClient };

export function createLendingChainReaders(
  options: CreateLendingChainReadersOptions,
): LendingChainReaders {
  const { network, venue } = options;
  const comptroller = getAddress(options.venusVenue.comptroller);
  const vUsdt = getAddress(venue.vUsdt);
  const usdt = getAddress(venue.usdt);
  const routerV3 = getAddress(venue.routerV3);
  const transport = options.transport ?? ((rpcUrl: string) => http(rpcUrl));
  const rpcUrls =
    options.rpcUrls !== undefined && options.rpcUrls.length > 0
      ? [...new Set(options.rpcUrls)]
      : [network.publicRpcUrl];

  let connection: Promise<Connection> | undefined;

  async function connect(): Promise<Connection> {
    const failures: string[] = [];
    for (const rpcUrl of rpcUrls) {
      const publicClient: PublicClient = createPublicClient({
        chain: network.chain as Chain,
        transport: transport(rpcUrl),
      });
      let chainId: number;
      try {
        chainId = await publicClient.getChainId();
      } catch {
        failures.push("unreachable");
        continue;
      }
      if (chainId !== network.chainId) {
        failures.push(`served chain ${chainId}`);
        continue;
      }
      return { publicClient };
    }
    throw new Error(
      `No configured RPC endpoint served chain ${network.chainId} (${rpcUrls.length} tried: ${failures.join(", ")}).`,
    );
  }

  async function connected(): Promise<Connection> {
    connection ??= connect();
    try {
      return await connection;
    } catch (cause) {
      connection = undefined; // never cache a transient outage
      throw cause;
    }
  }

  const makeVenusReaders =
    options.makeVenusReaders
    ?? ((markets: readonly Address[]) =>
      createVenusChainReaders({
        network,
        ...(options.rpcUrls === undefined ? {} : { rpcUrls: options.rpcUrls }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        venue: options.venusVenue,
        markets,
      }));

  /** The bounded universe, or a throw. Shared by both A-reading paths. */
  async function boundedUniverse(
    account: Address,
    debtMarkets: readonly Address[],
    blockNumber: bigint,
  ): Promise<Address[]> {
    const { publicClient } = await connected();
    const assetsIn = await publicClient.readContract({
      address: comptroller,
      abi: VENUS_COMPTROLLER_ABI,
      functionName: "getAssetsIn",
      args: [account],
      blockNumber,
    });
    const universe = new Set<string>([
      ...assetsIn.map((entry) => entry.toLowerCase()),
      ...debtMarkets.map((entry) => entry.toLowerCase()),
    ]);
    if (universe.size > LENDING_MAX_MARKETS) {
      throw new LendingAccountTooComplexError(account, universe.size);
    }
    return [...universe].map((entry) => getAddress(entry));
  }

  return {
    async readReserve(wallet: Address): Promise<LendingReserveReading> {
      const { publicClient } = await connected();
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      const blockNumber = finalized.number;
      if (blockNumber === null) {
        throw new Error("The finalized block carries no number; the guard holds.");
      }
      const target = getAddress(wallet);

      const [
        usdtBalance,
        vUsdtBalance,
        exchangeRateStored,
        cash,
        nativeBalance,
        usdtAllowanceToVUsdt,
        usdtAllowanceToRouter,
      ] = await Promise.all([
        publicClient.readContract({
          address: usdt, abi: VENUS_ERC20_ABI, functionName: "balanceOf",
          args: [target], blockNumber,
        }),
        publicClient.readContract({
          address: vUsdt, abi: VENUS_ERC20_ABI, functionName: "balanceOf",
          args: [target], blockNumber,
        }),
        publicClient.readContract({
          address: vUsdt, abi: VENUS_VTOKEN_ABI, functionName: "exchangeRateStored",
          blockNumber,
        }),
        publicClient.readContract({
          address: vUsdt, abi: VTOKEN_CASH_ABI, functionName: "getCash", blockNumber,
        }),
        publicClient.getBalance({ address: target, blockNumber }),
        publicClient.readContract({
          address: usdt, abi: VENUS_ERC20_ABI, functionName: "allowance",
          args: [target, vUsdt], blockNumber,
        }),
        publicClient.readContract({
          address: usdt, abi: VENUS_ERC20_ABI, functionName: "allowance",
          args: [target, routerV3], blockNumber,
        }),
      ]);

      // The CURRENT exchange rate through `eth_call`. A contract-level failure
      // leaves it `null`; the retire's effect check then falls back to the
      // stored rate and says so, rather than reporting a residue it computed
      // from a basis it does not have.
      let exchangeRateCurrent: bigint | null = null;
      try {
        const simulated = await publicClient.simulateContract({
          address: vUsdt, abi: VTOKEN_CASH_ABI, functionName: "exchangeRateCurrent",
          account: target, blockNumber,
        });
        exchangeRateCurrent = simulated.result;
      } catch {
        exchangeRateCurrent = null;
      }

      // The swap solver's SEED price (R3.10). Unreadable is not fatal: the
      // solver falls back to spending the whole available side and clamping,
      // which submits a partial rather than refusing.
      let poolSqrtPriceX96: bigint | null = null;
      let poolWbnbIsToken0 = false;
      try {
        const [slot0, token0] = await Promise.all([
          publicClient.readContract({
            address: getAddress(venue.swapPool), abi: V3_POOL_ABI,
            functionName: "slot0", blockNumber,
          }),
          publicClient.readContract({
            address: getAddress(venue.swapPool), abi: V3_POOL_ABI,
            functionName: "token0", blockNumber,
          }),
        ]);
        poolSqrtPriceX96 = slot0[0];
        poolWbnbIsToken0 =
          getAddress(token0).toLowerCase() === getAddress(venue.wbnb).toLowerCase();
      } catch {
        poolSqrtPriceX96 = null;
      }

      return {
        blockNumber,
        wallet: target,
        usdtBalance,
        vUsdtBalance,
        exchangeRateStored,
        exchangeRateCurrent,
        cash,
        nativeBalance,
        usdtAllowanceToVUsdt,
        usdtAllowanceToRouter,
        poolSqrtPriceX96,
        poolWbnbIsToken0,
      };
    },

    async readTokenDayMeter(input): Promise<LendingTokenMeterReading> {
      let publicClient: PublicClient;
      try {
        ({ publicClient } = await connected());
      } catch (error) {
        return {
          kind: "unreadable",
          detail: error instanceof Error ? error.message : "transport",
        };
      }
      const wanted =
        input.token === null ? zeroAddress : getAddress(input.token).toLowerCase();
      try {
        const keyHash = accountKeyHashForAddress(
          publicKeyToAddress(input.publicKey),
        );
        const infos = await publicClient.readContract({
          address: getAddress(input.walletAddress),
          abi: ACCOUNT_ABI,
          functionName: "spendInfos",
          args: [keyHash],
        });
        const forToken = infos.filter(
          (info) => info.token.toLowerCase() === wanted,
        );
        if (forToken.length === 0) return { kind: "no-grant" };
        const day = forToken.find(
          (info) => Number(info.period) === LENDING_SPEND_PERIOD_DAY,
        );
        if (day === undefined) return { kind: "other-period" };
        const remainingWei =
          day.limit > day.currentSpent ? day.limit - day.currentSpent : 0n;
        return {
          kind: "day",
          limitWei: day.limit,
          currentSpentWei: day.currentSpent,
          remainingWei,
        };
      } catch (error) {
        return {
          kind: "unreadable",
          detail: error instanceof Error ? error.message : "read failed",
        };
      }
    },

    async quote(input): Promise<bigint> {
      const { publicClient } = await connected();
      // The quoter mutates internally and is `nonpayable`, so it is a SIMULATE.
      const { result } = await publicClient.simulateContract({
        address: getAddress(venue.quoterV2),
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn: getAddress(input.tokenIn),
            tokenOut: getAddress(input.tokenOut),
            amountIn: input.amountInWei,
            fee: input.fee ?? venue.swapFeeTier,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      return result[0];
    },

    async readSwapPool() {
      const { publicClient } = await connected();
      const pool = await publicClient.readContract({
        address: getAddress(venue.factoryV3),
        abi: V3_FACTORY_ABI,
        functionName: "getPool",
        args: [getAddress(venue.wbnb), usdt, venue.swapFeeTier],
      });
      const resolved = getAddress(pool);
      if (resolved === getAddress(zeroAddress)) {
        throw new Error(
          `No WBNB/USDT pool exists at fee tier ${venue.swapFeeTier}; LENDING_SWAP_FEE_TIER names a pool that is not deployed.`,
        );
      }
      const [liquidity, token0] = await Promise.all([
        publicClient.readContract({
          address: resolved, abi: V3_POOL_ABI, functionName: "liquidity",
        }),
        publicClient.readContract({
          address: resolved, abi: V3_POOL_ABI, functionName: "token0",
        }),
      ]);
      return { pool: resolved, liquidity, token0: getAddress(token0) };
    },

    /**
     * FIXREVIEW F7 — the block the arm's OWN transaction landed in.
     *
     * ONE read, and every failure answers `null` rather than throwing: an
     * `armBlock` is bookkeeping, not authority, and refusing an arm because a
     * node could not answer a receipt query would trade a label for a
     * submission. It is deliberately NOT pinned to `finalized` — a receipt
     * exists at the block it landed in, which is the whole point of preferring
     * it over the post-arm read.
     */
    async readTransactionBlock(txHash) {
      try {
        const { publicClient } = await connected();
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        return receipt.blockNumber ?? null;
      } catch {
        return null;
      }
    },

    async readAccount(account, debtMarkets, signal) {
      const { publicClient } = await connected();
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      const blockNumber = finalized.number;
      if (blockNumber === null) {
        throw new Error("The finalized block carries no number; the guard holds.");
      }
      const universe = await boundedUniverse(
        getAddress(account),
        debtMarkets,
        blockNumber,
      );
      const readers = makeVenusReaders(universe);
      return readers.readAccount(getAddress(account), signal);
    },

    async readS1Facts(account, debtMarkets) {
      const { publicClient } = await connected();
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      const blockNumber = finalized.number;
      if (blockNumber === null) {
        throw new Error("The finalized block carries no number; the hire refuses.");
      }
      const target = getAddress(account);
      // EXACTLY THREE bounded reads (R2.10, corrected by L1): the Comptroller's
      // own liquidity CODE — which is all `getAccountLiquidity` can say about
      // the account as a whole; it returns `(error, liquidity, shortfall)` and
      // cannot produce a per-market verdict — plus `borrowBalanceStored` on
      // each pinned market. `guarded-no-debt` comes from the borrow reads, not
      // from the liquidity call; the body's "D == 0 on the liquidation basis"
      // definition is superseded because R2.10 removed the risk reconstruction
      // from S1 entirely.
      const [liquidity, ...borrows] = await Promise.all([
        publicClient.readContract({
          address: comptroller, abi: VENUS_COMPTROLLER_ABI,
          functionName: "getAccountLiquidity", args: [target], blockNumber,
        }),
        ...debtMarkets.map(async (vToken) => ({
          vToken: getAddress(vToken),
          borrowWei: await publicClient.readContract({
            address: getAddress(vToken), abi: VTOKEN_BORROW_STORED_ABI,
            functionName: "borrowBalanceStored", args: [target], blockNumber,
          }),
        })),
      ]);
      return {
        blockNumber,
        liquidityErrorCode: liquidity[0],
        borrows,
      };
    },
  };
}

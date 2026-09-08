import { parseAtomicRotateReceipt, type AtomicRotateReceiptIdentity } from "./atomicRotateReceipt.js";
import { parseGridArmBenchmark, type GridArmBenchmarkInput, type GridArmBenchmark } from "../http/gridBenchmark.js";
/**
 * LP chain readers — the ONE place LP route/worker chain reads happen
 * (PHASE3-SPEC "Worker"; Revision 2 items 18–19, 32; PHASE3-REVIEW OQ3).
 *
 * Implements the reader seams the routes and sagas consume
 * (`LpChainReaders` in `src/server.ts`; `LpPositionsReader` / `LpQuoteReader`
 * / `LpReceiptReader` in `src/lp/sagas.ts`) plus the worker's one extension
 * (`positionFees`), over viem against the SAME pinned-RPC discipline the
 * provider uses: the endpoint list is resolved once, `eth_chainId` is verified
 * before the first read, and a wrong-chain endpoint is skipped rather than
 * trusted (`src/wallet/altana.ts` `#connect`, reproduced here rather than a
 * second RPC config — the caller passes the provider's own network + URLs).
 *
 * ─── FINALITY DISCIPLINE (Rev2 item 32 / OQ3) ──────────────────────────────
 *
 * Trigger observations are read AT THE FINALIZED BLOCK: `poolState` first asks
 * for `eth_getBlockByNumber("finalized")` and then reads slot0 / liquidity /
 * observe pinned to that block number, so the evidence it returns satisfies
 * the `blockNumber <= finalizedBlockNumber` rail by construction. WHICH
 * ENDPOINT ANSWERS (audit A11): absent an explicit `rpcUrls` option the
 * readers fall back to `network.publicRpcUrl` — for chain 56 that is the
 * SDK's `https://bsc-rpc.publicnode.com`, and the current deployment pins no
 * RPC env var, so THAT is what actually serves these reads. The `finalized`
 * tag was VERIFIED 2026-08-13 on both it and
 * `https://bsc-dataseed.bnbchain.org` (answered, measured 2–3 blocks behind
 * `latest`, BSC fast finality), and the state read at that height is well
 * inside a full node's 128-block window. A provider that does NOT support the
 * tag fails the read loudly, which holds the trigger — never a silent
 * fall-back to `latest`.
 *
 * Ordinary post-step state (`positions`, `positionFees`) reads LATEST — OQ3's
 * answer: the next step's atomic on-chain execution is the real authority, and
 * money amounts come only from confirmed receipts, never from these reads.
 * UNKNOWN resolution may pass an explicit finalized height to `positions`;
 * that observation can decide whether a submitted zap-out actually completed.
 *
 * ─── RECEIPT PARSING (Rev2 item 32: "money amounts come only from confirmed
 *      receipts") ───────────────────────────────────────────────────────────
 *
 * The three receipt readers parse the transaction's own logs and THROW on any
 * ambiguity instead of guessing — a thrown post-step read parks the sequence
 * as POST_VERIFY_FAILED for an operator, which is the fail-closed direction:
 *
 *   - `collectAmounts`: the NFPM's `Collect` event (one per zap-out/collect
 *     batch; more than one is refused);
 *   - `mintedTokenId`: the NFPM's ERC-721 `Transfer` from the zero address
 *     (topic count 4 tells it apart from ERC-20 `Transfer`, which shares
 *     topic0);
 *   - `swapAmounts`: the POOL's `Swap` log locates the pool, then the two
 *     ERC-20 `Transfer`s to/from that pool name the legs. The Pancake V3 pool
 *     Swap signature carries two protocol-fee fields the Uniswap original
 *     does not — `Swap(address,address,int256,int256,uint160,uint128,int24,
 *     uint128,uint128)`, topic0 0x19b47279256b2a23a1665c810c8d55a1758940ee0937
 *     7d4f8d26497a3577dc83 — VERIFIED 2026-08-13 against live WBNB/USDT-100
 *     pool logs on mainnet. Only that topic is accepted: a receipt whose swap
 *     happened on a non-Pancake pool is not a receipt this reader should be
 *     able to interpret.
 *
 * ─── THE NATIVE METER READ ─────────────────────────────────────────────────
 *
 * `onChainNativeDailyCapWei` reads the ACCOUNT's `spendInfos` for the agent's
 * session key and returns the zero-address (native) row with the DAY period —
 * the chain's answer, not the persisted snapshot (Rev2 item 11, the dev-stack
 * A2 lesson). The serialized period for "day" is 2, pinned from porto's own
 * `toSerializedSpendPeriod` (`porto/dist/viem/Key.d.ts`: minute 0, hour 1,
 * day 2, week 3) — the same enum the on-chain GuardedExecutor stores. No day
 * row ⇒ THROW: a session with no daily native meter has nothing to size
 * against, and the settings route treats a read failure as a refusal.
 */
import {
  createPublicClient,
  decodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToBytes,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TransactionReceipt,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { AgentRecord } from "../store/agents.js";
import type { LpChainReaders, LpPoolStateReading } from "../server.js";
import type { LpFeeReceipt } from "./feeTelemetry.js";
import type { LpPositionSnapshot } from "./sagas.js";
import { accountKeyHashForAddress } from "../wallet/altana.js";
import { ACCOUNT_ABI } from "../wallet/abis.js";
import { NONFUNGIBLE_POSITION_MANAGER_ABI } from "../ops/abis.js";
import { MAX_UINT128 } from "../ops/nfpm.js";
import { arithmeticMeanTick } from "./rails.js";
import { getSqrtRatioAtTick } from "./tickMath.js";
import {
  fenceWorkerDependency,
  type WorkerFence,
} from "../deployment/workerSingleton.js";

/* -------------------------------------------------------------------------- */
/* Pinned addresses (BNB Chain 56)                                            */
/* -------------------------------------------------------------------------- */

/**
 * PancakeSwap V3 factory on BNB Chain 56. VERIFIED 2026-08-13 against deployed
 * bytecode (PHASE3-REVIEW facts: 5 151 bytes, not a proxy; `getPool` 0x1698ee82
 * and `feeAmountTickSpacing` 0x22afcccb present; `NFPM.factory()` and
 * `QuoterV2.factory()` both read this address back).
 */
export const PANCAKE_V3_FACTORY_56: Address = getAddress(
  "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
);

/**
 * PancakeSwap QuoterV2 on BNB Chain 56. VERIFIED 2026-08-13 (PHASE3-REVIEW
 * facts: 8 331 bytes; `quoteExactInputSingle` struct order CONFIRMED by live
 * execution and its V1 ordering REFUTED by a live revert).
 */
export const PANCAKE_V3_QUOTER_V2_56: Address = getAddress(
  "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
);

/**
 * porto's serialized SpendPeriod for "day" (`toSerializedSpendPeriod.day`,
 * pinned from `porto/dist/viem/Key.d.ts` — the enum the account contract
 * stores and `spendInfos` reports back).
 */
export const SPEND_PERIOD_DAY = 2;

/* -------------------------------------------------------------------------- */
/* ABI fragments (reader-only; the WRITE fragments live in src/ops)           */
/* -------------------------------------------------------------------------- */

const FACTORY_READER_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

/**
 * The pool reads the rails need. NOTE on `slot0`: the Pancake V3 pool widens
 * Uniswap's `uint8 feeProtocol` to `uint32`; both occupy one full ABI word, so
 * the positional decode below is identical either way — the field is read past,
 * never used.
 */
const POOL_READER_ABI = [
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
    name: "liquidity",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    name: "tickSpacing",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    name: "observe",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
  // LP-DEPLOY liquidity chart (2026-09-05): the two reads that turn the pool's
  // initialized ticks into a per-bin liquidity profile. `tickBitmap` says WHICH
  // compressed ticks are initialized in a 256-wide word; `ticks` gives each one's
  // `liquidityNet`, the signed delta the active liquidity takes crossing it.
  {
    name: "tickBitmap",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "wordPosition", type: "int16" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "ticks",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
  },
] as const;

const NFPM_POSITIONS_ABI = [
  {
    name: "positions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
] as const;

const NFPM_OWNER_OF_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** The V1-quoter argument order is REFUTED live; only this struct is used. */
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

/* ----- event topics, computed once ----------------------------------------- */

/** `Transfer(address,address,uint256)` — shared by ERC-20 (3 topics) and ERC-721 (4 topics). */
const TRANSFER_TOPIC = keccak256(
  stringToBytes("Transfer(address,address,uint256)"),
);

/** NFPM `Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)`. */
const NFPM_COLLECT_TOPIC = keccak256(
  stringToBytes("Collect(uint256,address,uint256,uint256)"),
);

/**
 * The PANCAKE V3 pool Swap signature (two protocol-fee tails the Uniswap
 * original lacks). Topic verified against live mainnet pool logs 2026-08-13.
 */
const PANCAKE_V3_SWAP_TOPIC = keccak256(
  stringToBytes(
    "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
  ),
);

const ZERO_TOPIC = `0x${"00".repeat(32)}` as Hex;

/**
 * PHASE3.19 item 38 — NFPM
 * `IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`.
 *
 * The NFPM emits it for a `mint` as well as for an `increaseLiquidity`, which is
 * what makes it the reader the (aw) fix needs: it names what a MINT actually
 * consumed, from the confirmed receipt, on the resume path as well as the live
 * one.
 */
const NFPM_INCREASE_LIQUIDITY_TOPIC = keccak256(
  stringToBytes("IncreaseLiquidity(uint256,uint128,uint256,uint256)"),
);

/** PHASE3.19 item 5 — `balanceOf(address)`, for the ladder's idle buffer. */
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The worker's one extension over the route readers: exact collectible fees,
 * read by SIMULATING `collect(amount0Max = amount1Max = uint128.max)` from the
 * wallet — the periphery's own idiom for "everything owed", state-changing on
 * chain but a pure answer under `eth_call`. Latest-tag (OQ3: a valuation input
 * for triggers whose price evidence is separately finalized-pinned; the money
 * that actually moves comes from the confirmed collect receipt, never from
 * this read).
 */
export type LpWorkerChainReaders = LpChainReaders;

/**
 * LP-DEPLOY liquidity chart: the pool's per-bin liquidity profile at one
 * finalized block. `bins[i].liquidity` is the ACTIVE liquidity inside
 * `[tickLower, tickLower + tickSpacing)`; the bin holding `currentTick` carries
 * `activeLiquidity` exactly. Display data — never an input to any decision.
 */
export type LpTickLiquidityReading = {
  readonly pool: Address;
  readonly blockNumber: bigint;
  readonly currentTick: number;
  readonly tickSpacing: number;
  readonly activeLiquidity: bigint;
  readonly bins: readonly { readonly tickLower: number; readonly liquidity: bigint }[];
  /** True when a bitmap word held more initialized ticks than the read budget. */
  readonly truncated: boolean;
};

/** Bins per side the chart may ask for; bounds the RPC fan-out of one request. */
export const MAX_LIQUIDITY_WINDOW_BINS = 1000; // ≈ ±22 % of price at spacing 1; ≤ ~9 bitmap words — the chart's zoom-out ceiling
/** `ticks(i)` reads one request may issue before the window is truncated. */
export const MAX_LIQUIDITY_INITIALIZED_TICKS = 256;

/** The network facts the readers pin to — the provider's own, never a second config. */
export type LpReaderNetwork = {
  readonly chain: Chain;
  readonly chainId: number;
  readonly publicRpcUrl: string;
};

/** BNB mainnet endpoints that answer the reads the sagas actually make. */
const BSC_MAINNET_RPC_URLS: readonly string[] = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed1.defibit.io",
];

/**
 * RPC endpoints for LP reads, in preference order.
 *
 * WHY THIS EXISTS — found by the Phase 3 live mainnet run, 2026-08-16. Absent
 * an explicit list the readers fall back to `network.publicRpcUrl`, the SDK's
 * publicnode endpoint, and on chain 56 that endpoint answers
 * `eth_getBlockByNumber("finalized")` but REFUSES `eth_getTransactionReceipt`.
 * The open saga's tail reads the mint receipt to learn its tokenId, so a
 * healthy, confirmed, fully funded position could not be recorded and its
 * sequence never left `active` — the automation was inert on a live position.
 *
 * Measured that day against chain 56:
 *
 * ```
 * publicnode      receipt FAIL   state-at-old-block FAIL   finalized OK
 * bsc-dataseed    receipt OK     state-at-old-block FAIL   finalized OK
 * bsc-dataseed1   receipt OK     state-at-old-block FAIL   finalized OK
 * ```
 *
 * None of them serves state at a historical block, which is WHY post-step
 * verification reads `latest` (OQ3) and every money amount comes from a
 * confirmed receipt rather than a re-read. A future archive endpoint would
 * widen what is possible; nothing here may come to depend on one.
 *
 * FINDINGS.md already recorded this same endpoint rejecting write-path calls
 * during the first mainnet run, and `scripts/spike/network.ts` has led with
 * bsc-dataseed ever since. The defect was that the Phase 3 entry points never
 * passed that list on. This resolver keys off the RESOLVED CHAIN ID rather
 * than a network-name env var on purpose: `scripts/spike/network.ts` keys off
 * `SPIKE_NETWORK` while the Phase 3 entry points key off `EXECUTION_NETWORK`,
 * and importing one list into the other would hand a mainnet run testnet
 * endpoints whenever the two disagree.
 */
export function resolveLpRpcUrls(
  env: Readonly<Record<string, string | undefined>>,
  network: LpReaderNetwork,
): readonly string[] {
  const override = (env["LP_RPC_URL"] ?? env["SPIKE_RPC_URL"] ?? "").trim();
  const preferred = network.chainId === 56 ? BSC_MAINNET_RPC_URLS : [];
  return [
    ...new Set(
      [
        ...(override === "" ? [] : [override]),
        ...preferred,
        network.publicRpcUrl,
      ].filter((url) => url.length > 0),
    ),
  ];
}

export type CreateLpChainReadersOptions = {
  readonly network: LpReaderNetwork;
  /** Worker authority checked at every individual viem RPC call. */
  readonly workerFence?: WorkerFence;
  /**
   * Endpoint list, tried in order with an `eth_chainId` check — pass the SAME
   * URLs the provider was constructed with. Defaults to the network's public
   * RPC, exactly as `AltanaProvider` defaults.
   */
  readonly rpcUrls?: readonly string[];
  /** Transport factory, injectable for offline tests. Defaults to `http`. */
  readonly transport?: (rpcUrl: string) => Transport;
  readonly nfpm: Address;
  readonly factory: Address;
  readonly quoterV2: Address;
  /**
   * TWAP window for `poolState`'s `observe` read, SECONDS. Comes from the
   * resolved rail config (`LP_TWAP_WINDOW_SECONDS`) — the rails validate it;
   * this only refuses the unusable.
   */
  readonly twapWindowSeconds: number;
};

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

type Connection = { readonly publicClient: PublicClient };

/**
 * Whether an error is the target contract REVERTING (vs. the transport or the
 * node failing). The burned-token revert is POSITIVE confirmation for
 * `positions`/`positionFees` (Rev2 item 32) and must not swallow an RPC
 * outage as "burned" — an outage THROWS and the caller holds.
 */
function isContractRevert(error: unknown): boolean {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause as Error) {
    const name = (cursor as { name?: string }).name;
    if (
      name === "ContractFunctionRevertedError" ||
      name === "CallExecutionError" ||
      name === "ContractFunctionExecutionError"
    ) {
      // viem wraps a revert in ContractFunctionExecutionError whose cause chain
      // ends in ContractFunctionRevertedError / a revert CallExecutionError;
      // transport failures end in HttpRequestError / TimeoutError instead.
      if (name === "ContractFunctionRevertedError") return true;
      const message = cursor.message;
      if (/reverted|Invalid token ID/iu.test(message)) return true;
    }
    if (name === "HttpRequestError" || name === "TimeoutError") return false;
  }
  return false;
}

function topicAddress(topic: Hex): Address {
  return getAddress(`0x${topic.slice(26)}`);
}

type Erc20TransferLog = {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
};

function erc20Transfers(receipt: TransactionReceipt): Erc20TransferLog[] {
  const out: Erc20TransferLog[] = [];
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const [value] = decodeAbiParameters([{ type: "uint256" }], log.data);
    out.push({
      token: getAddress(log.address),
      from: topicAddress(log.topics[1] as Hex),
      to: topicAddress(log.topics[2] as Hex),
      value,
    });
  }
  return out;
}

export function createLpChainReaders(
  options: CreateLpChainReadersOptions,
): LpWorkerChainReaders {
  const { network } = options;
  if (
    !Number.isInteger(options.twapWindowSeconds) ||
    options.twapWindowSeconds <= 0
  ) {
    throw new Error("createLpChainReaders: twapWindowSeconds must be a positive integer.");
  }
  const nfpm = getAddress(options.nfpm);
  const factory = getAddress(options.factory);
  const quoterV2 = getAddress(options.quoterV2);
  const transport = options.transport ?? ((rpcUrl: string) => http(rpcUrl));
  const rpcUrls =
    options.rpcUrls !== undefined && options.rpcUrls.length > 0
      ? [...new Set(options.rpcUrls)]
      : [network.publicRpcUrl];

  let connection: Promise<Connection> | undefined;

  /** The provider's own connect discipline: verify the chain before trusting it. */
  async function connect(): Promise<Connection> {
    const failures: string[] = [];
    for (const rpcUrl of rpcUrls) {
      const rawPublicClient: PublicClient = createPublicClient({
        chain: network.chain,
        transport: transport(rpcUrl),
      });
      // One reader method contains several sequential awaits. The viem method
      // is the actual one-RPC boundary, so it owns the guard rather than a
      // high-level wrapper that can only inspect the final promise.
      const publicClient = options.workerFence === undefined
        ? rawPublicClient
        : fenceWorkerDependency(options.workerFence, rawPublicClient);
      let chainId: number;
      try {
        chainId = await publicClient.getChainId();
      } catch {
        options.workerFence?.assertOpen();
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

  async function getPool(
    token0: Address,
    token1: Address,
    fee: number,
  ): Promise<Address | null> {
    const { publicClient } = await connected();
    const pool = await publicClient.readContract({
      address: factory,
      abi: FACTORY_READER_ABI,
      functionName: "getPool",
      args: [token0, token1, fee],
    });
    return getAddress(pool) === getAddress(zeroAddress) ? null : getAddress(pool);
  }

  async function poolState(pool: Address): Promise<LpPoolStateReading> {
    const { publicClient } = await connected();
    // FINALIZED first (module header): every read below is pinned to this
    // height, so the evidence satisfies the finality rail by construction. A
    // node that does not answer the tag throws here — the trigger holds.
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    const blockNumber = finalized.number;

    const [slot0, liquidity, tickSpacing, observed] = await Promise.all([
      publicClient.readContract({
        address: pool,
        abi: POOL_READER_ABI,
        functionName: "slot0",
        blockNumber,
      }),
      publicClient.readContract({
        address: pool,
        abi: POOL_READER_ABI,
        functionName: "liquidity",
        blockNumber,
      }),
      publicClient.readContract({
        address: pool,
        abi: POOL_READER_ABI,
        functionName: "tickSpacing",
        blockNumber,
      }),
      publicClient.readContract({
        address: pool,
        abi: POOL_READER_ABI,
        functionName: "observe",
        args: [[options.twapWindowSeconds, 0]],
        blockNumber,
      }),
    ]);

    const [tickCumulatives] = observed;
    const older = tickCumulatives[0];
    const newer = tickCumulatives[1];
    if (older === undefined || newer === undefined) {
      throw new Error("poolState: observe returned fewer cumulatives than asked for.");
    }
    const meanTick = arithmeticMeanTick(
      newer - older,
      BigInt(options.twapWindowSeconds),
    );

    return {
      pool: getAddress(pool),
      tickSpacing,
      currentTick: slot0[1],
      evidence: {
        blockNumber,
        finalizedBlockNumber: blockNumber,
        observationCardinality: slot0[3],
        poolLiquidity: liquidity,
        // Describes no particular swap (see `LpPoolStateReading`'s contract in
        // src/server.ts): every leg that swaps re-derives its own impact from
        // a fresh quote, and its floor bounds the execution either way.
        priceImpactBps: 0n,
        spotSqrtPriceX96: slot0[0],
        twapSqrtPriceX96: getSqrtRatioAtTick(meanTick),
      },
    };
  }

  async function readPosition(
    tokenId: bigint,
    blockNumber?: bigint,
  ): Promise<LpPositionSnapshot | "burned"> {
    const { publicClient } = await connected();
    try {
      const row = await publicClient.readContract({
        address: nfpm,
        abi: NFPM_POSITIONS_ABI,
        functionName: "positions",
        args: [tokenId],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      });
      // PHASE3.4 Rev2 M13: the full struct, not three of twelve. Every field
      // here was already being decoded and discarded — the legs and the fee
      // because no saga needed them (the position row carried them), the
      // `operator` because nothing had ever asked who else may move the NFT.
      return {
        liquidity: row[7],
        tickLower: row[5],
        tickUpper: row[6],
        operator: getAddress(row[1]),
        token0: getAddress(row[2]),
        token1: getAddress(row[3]),
        fee: row[4],
      };
    } catch (error) {
      options.workerFence?.assertOpen();
      // The burned/nonexistent token REVERTS ("Invalid token ID") — POSITIVE
      // confirmation for an expected-burned check (Rev2 item 32). Anything
      // that is not a contract revert (transport, node) rethrows: an outage
      // must hold the caller, never read as "burned".
      if (isContractRevert(error)) return "burned";
      throw error;
    }
  }

  async function positions(
    tokenId: bigint,
    blockNumber?: bigint,
    expectedBlockHash?: Hex,
  ): Promise<LpPositionSnapshot | "burned"> {
    if (blockNumber !== undefined && expectedBlockHash !== undefined) {
      const { publicClient } = await connected();
      const block = await publicClient.getBlock({ blockNumber });
      if (block.hash?.toLowerCase() !== expectedBlockHash.toLowerCase()) {
        throw new Error("Finalized LP position read is not on the cited evidence lineage.");
      }
    }
    return readPosition(tokenId, blockNumber);
  }

  async function positionFees(
    tokenId: bigint,
    wallet: Address,
  ): Promise<{ amount0Wei: bigint; amount1Wei: bigint } | "burned"> {
    const { publicClient } = await connected();
    try {
      const { result } = await publicClient.simulateContract({
        address: nfpm,
        abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
        functionName: "collect",
        args: [
          {
            tokenId,
            recipient: wallet,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
        account: wallet,
      });
      return { amount0Wei: result[0], amount1Wei: result[1] };
    } catch (error) {
      options.workerFence?.assertOpen();
      if (isContractRevert(error)) return "burned";
      throw error;
    }
  }


  async function positionFeesAt(
    tokenId: bigint,
    wallet: Address,
    blockNumber: bigint,
  ): Promise<{ amount0Wei: bigint; amount1Wei: bigint } | "burned"> {
    const { publicClient } = await connected();
    try {
      const { result } = await publicClient.simulateContract({
        address: nfpm,
        abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
        functionName: "collect",
        args: [
          {
            tokenId,
            recipient: wallet,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
        account: wallet,
        blockNumber,
      });
      return { amount0Wei: result[0], amount1Wei: result[1] };
    } catch (error) {
      options.workerFence?.assertOpen();
      if (isContractRevert(error)) return "burned";
      throw error;
    }
  }


  async function quote(params: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly fee: number;
    readonly amountInWei: bigint;
  }): Promise<bigint> {
    const { publicClient } = await connected();
    // The quoter mutates internally and is `nonpayable`, so it is a SIMULATE.
    const { result } = await publicClient.simulateContract({
      address: quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountInWei,
          fee: params.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result[0];
  }

  async function receiptOf(txHash: Hex): Promise<TransactionReceipt> {
    const { publicClient } = await connected();
    return publicClient.getTransactionReceipt({ hash: txHash });
  }

  async function gridArmBenchmark(input: GridArmBenchmarkInput): Promise<GridArmBenchmark> {
    if (network.chainId !== 56) throw new Error("arm-chain-unavailable");
    const { publicClient } = await connected();
    const pool = await getPool(input.token0, input.token1, input.fee);
    if (pool === null || pool.toLowerCase() !== input.pool.toLowerCase()) throw new Error("arm-pool-mismatch");
    const receipt = await receiptOf(input.txHash);
    const [block, finalized] = await Promise.all([
      publicClient.getBlock({ blockNumber: receipt.blockNumber }),
      publicClient.getBlock({ blockTag: "finalized" }),
    ]);
    return parseGridArmBenchmark(input, nfpm, receipt, block, finalized.number);
  }

  async function collectAmounts(txHash: Hex): Promise<{
    amount0Wei: bigint;
    amount1Wei: bigint;
  }> {
    const receipt = await receiptOf(txHash);
    const collects = receipt.logs.filter(
      (log) =>
        getAddress(log.address) === nfpm && log.topics[0] === NFPM_COLLECT_TOPIC,
    );
    const only = collects[0];
    if (only === undefined || collects.length !== 1) {
      throw new Error(
        `collectAmounts: expected exactly one NFPM Collect event in ${txHash}; found ${collects.length}. Refusing to guess which amounts moved.`,
      );
    }
    const [, amount0, amount1] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      only.data,
    );
    return { amount0Wei: amount0, amount1Wei: amount1 };
  }

  async function swapAmounts(txHash: Hex): Promise<{
    tokenIn: Address;
    amountInWei: bigint;
    tokenOut: Address;
    amountOutWei: bigint;
  }> {
    const receipt = await receiptOf(txHash);
    // The pool is located by its own Swap log (Pancake topic only — module
    // header), then the two ERC-20 Transfers to/from it name and size the legs.
    const swapEmitters = [
      ...new Set(
        receipt.logs
          .filter((log) => log.topics[0] === PANCAKE_V3_SWAP_TOPIC)
          .map((log) => getAddress(log.address)),
      ),
    ];
    const pool = swapEmitters[0];
    if (pool === undefined || swapEmitters.length !== 1) {
      throw new Error(
        `swapAmounts: expected exactly one Pancake V3 pool Swap event in ${txHash}; found ${swapEmitters.length} emitter(s). Refusing to interpret an ambiguous receipt.`,
      );
    }
    const transfers = erc20Transfers(receipt);
    const inputs = transfers.filter((entry) => entry.to === pool);
    const outputs = transfers.filter((entry) => entry.from === pool);
    const input = inputs[0];
    const output = outputs[0];
    if (input === undefined || output === undefined || inputs.length !== 1 || outputs.length !== 1) {
      throw new Error(
        `swapAmounts: expected exactly one Transfer into and one out of the pool in ${txHash}; found ${inputs.length} in / ${outputs.length} out.`,
      );
    }
    return {
      tokenIn: input.token,
      amountInWei: input.value,
      tokenOut: output.token,
      amountOutWei: output.value,
    };
  }

  async function expectedPoolSwap(
    txHash: Hex,
    expectedPool: Address,
    baseIsToken0: boolean,
  ): Promise<{ amountInWei: bigint; amountOutWei: bigint } | null> {
    const receipt = await receiptOf(txHash);
    // PHASE3.24 C3: count LOGS, not distinct emitters. Two Swap logs from the
    // same pool are still outside the truth table and enter committed-money
    // hold; collapsing emitters would misclassify that receipt as unique.
    const swaps = receipt.logs.filter((log) => log.topics[0] === PANCAKE_V3_SWAP_TOPIC);
    if (swaps.length === 0) return null;
    const only = swaps[0];
    if (only === undefined || swaps.length !== 1) {
      throw new Error(
        `expectedPoolSwap: expected zero or one Pancake V3 Swap log in ${txHash}; found ${swaps.length}.`,
      );
    }
    if (getAddress(only.address) !== getAddress(expectedPool)) {
      throw new Error("expectedPoolSwap: the only Swap log was emitted by an unexpected pool.");
    }
    let amount0: bigint;
    let amount1: bigint;
    try {
      [amount0, amount1] = decodeAbiParameters(
        [
          { type: "int256" },
          { type: "int256" },
          { type: "uint160" },
          { type: "uint128" },
          { type: "int24" },
          { type: "uint128" },
          { type: "uint128" },
        ],
        only.data,
      );
    } catch {
      throw new Error("expectedPoolSwap: the expected pool's Swap log was malformed.");
    }
    const amountInWei = baseIsToken0 ? amount0 : amount1;
    const signedOut = baseIsToken0 ? amount1 : amount0;
    if (amountInWei <= 0n || signedOut >= 0n) {
      throw new Error(
        "expectedPoolSwap: the expected pool's Swap signs do not prove base-in and WBNB-out.",
      );
    }
    return { amountInWei, amountOutWei: -signedOut };
  }

  async function mintedTokenId(txHash: Hex): Promise<bigint> {
    const receipt = await receiptOf(txHash);
    // ERC-721 Transfer shares topic0 with ERC-20; the indexed tokenId makes it
    // 4 topics, and the mint is the one FROM the zero address, emitted by the
    // NFPM itself.
    const mints = receipt.logs.filter(
      (log) =>
        getAddress(log.address) === nfpm &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length === 4 &&
        log.topics[1] === ZERO_TOPIC,
    );
    const only = mints[0];
    if (only === undefined || mints.length !== 1) {
      throw new Error(
        `mintedTokenId: expected exactly one NFPM mint Transfer in ${txHash}; found ${mints.length}.`,
      );
    }
    return BigInt(only.topics[3] as Hex);
  }

  /**
   * PHASE3.17 R2.8 (review L3) — the DUAL arm's reader: EXACTLY TWO NFPM mints,
   * ordered by log index, which is EVM execution order.
   *
   * A SECOND reader beside {@link mintedTokenId} rather than a widening of it,
   * and the existing one is not weakened by one byte: its `!== 1` refusal is
   * post-verify fail-closed for every single-mint path in the tree, and a
   * receipt carrying more mints than a plan asked for is exactly what it exists
   * to refuse. This one refuses `!== 2` for the same reason and with the same
   * filter — an NFPM-emitted ERC-721 `Transfer` from the zero address, which
   * has four topics; the router's pool `Swap`, the ERC-20 `Transfer`s and both
   * `refundETH` calls emit nothing that survives it.
   *
   * ORDER IS THE PAIRING (review L1): `receipt.logs` is execution-ordered, so
   * the plan's own mint order decides which id is which level. The caller
   * additionally asserts NFPM `_nextId` monotonicity, so the pairing stops
   * depending on a reader contract nobody restates.
   */
  async function mintedTokenIds(txHash: Hex): Promise<readonly bigint[]> {
    const receipt = await receiptOf(txHash);
    const mints = receipt.logs.filter(
      (log) =>
        getAddress(log.address) === nfpm &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length === 4 &&
        log.topics[1] === ZERO_TOPIC,
    );
    // ─── PHASE3.22 R4.2.6 — WIDENED FROM `!== 2` TO 1..2 ────────────────────
    //
    // A shift motion mints ONE rung when the other side is below its
    // single-sided floor (decision 9's one-sided continuation), so a strict
    // two-mint reader would fail-closed on the ordinary one-sided receipt and
    // hold a pair that worked exactly as designed.
    //
    // THE COUNT IS NOW BOUND BY THE PLAN, NOT BY THE READER, and that is the
    // safer place for it: this reader cannot know how many mints its caller
    // ASKED for, whereas every caller knows exactly. The dual arm still asserts
    // `ids.length !== 2` at its own seam (`open.ts`), and the shift's finish
    // asserts against the mint set its batch actually recorded — so neither
    // caller lost a guard, and both gained one that knows what it is checking.
    //
    // The `<= 2` half is kept HERE because it is reader-level truth: no plan in
    // this tree emits three mints, so a receipt carrying three is a receipt
    // this reader must refuse rather than silently truncate. The zero case is
    // refused for the same reason `mintedTokenId` refuses it — a confirmed mint
    // batch that minted nothing is a contradiction, not an empty answer.
    //
    // SAID OUT LOUD, per REVIEW2 N3: this widening touches the fakes 3.17
    // deliberately left alone. `test/lp.gridDual.test.ts`'s fake reproduces the
    // old `!== 2` refusal, which remains CORRECT for the dual arm it serves —
    // it is a fake of a caller-side contract, not of this reader.
    if (mints.length < 1 || mints.length > 2) {
      throw new Error(
        `mintedTokenIds: expected one or two NFPM mint Transfers in ${txHash}; found ${mints.length}.`,
      );
    }
    return mints.map((log) => BigInt(log.topics[3] as Hex));
  }

  /**
   * PHASE3.19 item 38 (review M2) — what a confirmed MINT actually consumed, in
   * POOL ORDER, from the NFPM's own `IncreaseLiquidity` log.
   *
   * STRICT, in the `collectAmounts` idiom and for the same reason: exactly ONE
   * such log, or refuse. A receipt carrying more than one names two deposits and
   * this reader must never guess which one the ledger is about. The one caller
   * (`recordGridCycle`) treats a throw as "no row", because it is wrapped in the
   * derived-state catch — so a strict refusal costs one report line, never a
   * sequence.
   *
   * `tokenId` is the INDEXED topic and `liquidity`/`amount0`/`amount1` are the
   * data, so the two amounts are the second and third data words.
   */
  async function mintAmounts(txHash: Hex): Promise<{
    amount0Wei: bigint;
    amount1Wei: bigint;
  }> {
    const receipt = await receiptOf(txHash);
    const events = receipt.logs.filter(
      (log) =>
        getAddress(log.address) === nfpm
        && log.topics[0] === NFPM_INCREASE_LIQUIDITY_TOPIC,
    );
    const only = events[0];
    if (only === undefined || events.length !== 1) {
      throw new Error(
        `mintAmounts: expected exactly one NFPM IncreaseLiquidity event in ${txHash}; found ${events.length}. Refusing to guess which amounts the mint consumed.`,
      );
    }
    const [, amount0, amount1] = decodeAbiParameters(
      [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
      only.data,
    );
    return { amount0Wei: amount0, amount1Wei: amount1 };
  }

  /**
   * PHASE3.19 item 5 — the WALLET's balance of one ERC-20, at `latest`.
   *
   * LATEST, deliberately, and the reasoning is the same split
   * `LpWorkerChainReaders.positionFees` states: this is an INTENT input (how
   * much may the next call ask to move) and never an outcome. The money that
   * actually moved still comes from the confirmed receipt, and the intent this
   * feeds is PERSISTED before the submit — so a `latest` read that is one block
   * stale costs at most a slightly smaller mint, never an unbound swap.
   */
  async function walletTokenBalance(
    token: Address,
    wallet: Address,
  ): Promise<bigint> {
    const { publicClient } = await connected();
    return publicClient.readContract({
      address: token,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });
  }

  /**
   * GRID-GAS-RESERVE P2 — the wallet's native BNB, at LATEST for the same
   * reason `walletTokenBalance` reads latest: this is an INTENT input (may the
   * next batch pay its relay fee), never an outcome.
   */
  async function walletNativeBalance(wallet: Address): Promise<bigint> {
    const { publicClient } = await connected();
    return publicClient.getBalance({ address: wallet });
  }

  /**
   * PHASE3.17 R3.3 (review2 C3) — the SAME QuoterV2 call as {@link quote}, also
   * returning the SIMULATED POST-SWAP price.
   *
   * A SECOND method rather than a widened `LpQuoteReader` return: that type is
   * consumed at seven call sites across four modules, none of which wants a
   * second field, and widening it would have been a change to every one of them
   * for the benefit of a single new caller.
   *
   * `sqrtPriceX96After` is the quoter's SECOND output and has been declared in
   * this file's ABI since Phase 3 — {@link quote} simply discards it. The dual
   * arm's sell-side gate is the first thing in the tree that needs it, because
   * it is the first plan whose own swap moves the price toward a range the same
   * batch is about to mint into.
   */
  async function quoteWithPriceAfter(params: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly fee: number;
    readonly amountInWei: bigint;
  }): Promise<{ readonly amountOutWei: bigint; readonly sqrtPriceX96After: bigint }> {
    const { publicClient } = await connected();
    const { result } = await publicClient.simulateContract({
      address: quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountInWei,
          fee: params.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return { amountOutWei: result[0], sqrtPriceX96After: result[1] };
  }

  /**
   * NFPM `ownerOf(tokenId)` (PHASE3.4 Rev2 M6). The FIRST ownership read this
   * codebase has ever made: until import, the only positions that existed were
   * ones `/lp/open` minted, so `ownerOf` was true by construction and nothing
   * asked.
   *
   * Same burned/transport split as {@link positions}, and for the same reason
   * stated there: `ownerOf` REVERTS on a nonexistent token, which is positive
   * information, while a transport failure is an outage and must never be
   * allowed to read as "the NFT is gone" — that answer closes positions (M7).
   *
   * AUDIT A2: pinned to the FINALIZED block, unlike ordinary `positions()`
   * calls, and the asymmetry is deliberate. Ordinary position reads feed
   * valuation and post-step verification, where `latest` is merely fresher;
   * this answer CLOSES
   * positions and zeroes their basis after two confirmations, and the review
   * accepted that rule on the strength of the finalized posture — "one lying or
   * stale RPC answer cannot close a position". At `latest` a single lagging or
   * reorged node in a round-robin pool can serve exactly the two answers the
   * rule treats as proof. It is also what {@link LP_NOT_OWNED_REASON} tells the
   * owner the read was, and a reason string that misdescribes its own evidence
   * is the (ae) family of defect.
   */
  async function ownerOf(tokenId: bigint): Promise<Address | "burned"> {
    const { publicClient } = await connected();
    try {
      // MEASURED ON MAINNET, and the reason this is two calls rather than
      // `blockTag: "finalized"`: BSC's public dataseed endpoints answer a state
      // read at the finalized TAG with "missing trie node" — every time, on both
      // endpoints `resolveLpRpcUrls` prefers — while the identical read at the
      // finalized block's NUMBER succeeds. `poolState` has always done it this
      // way and that is why it works; the first version of this reader took the
      // tag shortcut and would have failed EVERY ownership read in production.
      //
      // That failure is a transport error, so it holds rather than closing — but
      // holding for ever is not a safe default here: this gate runs before every
      // dispatch, so a permanently unanswerable read skips every position on
      // every cycle, which stops rotate, harvest AND the stop-loss. FINDINGS
      // (ae)'s class with the whole worker inside it.
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      const owner = await publicClient.readContract({
        address: nfpm,
        abi: NFPM_OWNER_OF_ABI,
        functionName: "ownerOf",
        args: [tokenId],
        blockNumber: finalized.number,
      });
      return getAddress(owner);
    } catch (error) {
      options.workerFence?.assertOpen();
      if (isContractRevert(error)) return "burned";
      throw error;
    }
  }

  async function onChainNativeDailyCapWei(agent: AgentRecord): Promise<bigint> {
    const facts = agent.sessionFacts;
    if (facts === null) {
      throw new Error("Agent has no granted session; there is no on-chain meter to read.");
    }
    const { publicClient } = await connected();
    const keyHash = accountKeyHashForAddress(publicKeyToAddress(facts.publicKey));
    const infos = await publicClient.readContract({
      address: agent.walletAddress,
      abi: ACCOUNT_ABI,
      functionName: "spendInfos",
      args: [keyHash],
    });
    const day = infos.find(
      (info) =>
        info.token === zeroAddress && Number(info.period) === SPEND_PERIOD_DAY,
    );
    if (day === undefined) {
      throw new Error(
        "The account enforces no DAILY native spend limit for this session key; there is nothing to size against.",
      );
    }
    return day.limit;
  }

  /**
   * The height the server is reading at, for the PHASE3.3 resolution receipt.
   * `latest` deliberately, because that is the height the wallet-balance reads
   * that resolution rests on are taken at; the finality rail is a property of
   * TRIGGER evidence, and this number is evidence about the read, not a
   * decision input.
   */
  async function blockNumber(): Promise<bigint> {
    const { publicClient } = await connected();
    return publicClient.getBlockNumber();
  }

  async function finalizedBlockNumber(): Promise<bigint> {
    const { publicClient } = await connected();
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    return finalized.number;
  }

  /**
   * LP-DEPLOY liquidity chart (2026-09-05) — the pool's liquidity PROFILE around
   * the current tick, one bin per tick spacing, at ONE finalized block.
   *
   * Method: the active liquidity `L` applies inside the bin that holds the
   * current tick. Walking UP, every initialized tick `i > current` adds its
   * `liquidityNet` (the sign convention of `Pool.swap` crossing left→right);
   * walking DOWN, every initialized tick `i <= current` is crossed right→left,
   * so its `liquidityNet` is SUBTRACTED to get the liquidity below it. The
   * initialized set comes from `tickBitmap` words covering the window, then one
   * `ticks(i)` read per set bit. All reads are pinned to the same block, so the
   * profile is one consistent snapshot, never a mix of two heights.
   *
   * This is a DISPLAY projection: no owner, no session, no journal, no money.
   * `windowBins` is clamped so a pathological pool cannot turn one request into
   * thousands of RPC reads; a bitmap word denser than `maxInitializedTicks`
   * truncates the window on that side and says so in `truncated`.
   */
  async function tickLiquidity(
    pool: Address,
    input: { readonly windowBins: number },
  ): Promise<LpTickLiquidityReading> {
    const windowBins = Math.min(MAX_LIQUIDITY_WINDOW_BINS, Math.max(1, Math.floor(input.windowBins)));
    const { publicClient } = await connected();
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    const blockNumber = finalized.number;
    const [slot0, liquidity, tickSpacing] = await Promise.all([
      publicClient.readContract({ address: pool, abi: POOL_READER_ABI, functionName: "slot0", blockNumber }),
      publicClient.readContract({ address: pool, abi: POOL_READER_ABI, functionName: "liquidity", blockNumber }),
      publicClient.readContract({ address: pool, abi: POOL_READER_ABI, functionName: "tickSpacing", blockNumber }),
    ]);
    const currentTick = slot0[1];
    const spacing = Number(tickSpacing);
    if (!Number.isInteger(spacing) || spacing <= 0) {
      throw new Error("tickLiquidity: the pool reported a non-positive tick spacing.");
    }
    // The bin holding the current tick starts at the spacing multiple at or below it.
    const currentBin = Math.floor(currentTick / spacing) * spacing;
    const lowBin = currentBin - windowBins * spacing;
    const highBin = currentBin + windowBins * spacing;
    // Compressed-tick words the window touches ([lowBin, highBin] inclusive).
    const wordOf = (tick: number): number => Math.floor(tick / spacing / 256);
    const words: number[] = [];
    for (let word = wordOf(lowBin); word <= wordOf(highBin); word += 1) words.push(word);
    const bitmaps = await Promise.all(
      words.map((word) => publicClient.readContract({
        address: pool,
        abi: POOL_READER_ABI,
        functionName: "tickBitmap",
        args: [word],
        blockNumber,
      })),
    );
    const initialized: number[] = [];
    words.forEach((word, index) => {
      const bitmap = bitmaps[index] ?? 0n;
      if (bitmap === 0n) return;
      for (let bit = 0; bit < 256; bit += 1) {
        if (((bitmap >> BigInt(bit)) & 1n) === 1n) {
          const tick = (word * 256 + bit) * spacing;
          if (tick >= lowBin && tick <= highBin) initialized.push(tick);
        }
      }
    });
    initialized.sort((a, b) => a - b);
    let truncated = false;
    let readable = initialized;
    if (initialized.length > MAX_LIQUIDITY_INITIALIZED_TICKS) {
      // Keep the ticks nearest the current one; the far edges of the window go dark.
      readable = [...initialized]
        .sort((a, b) => Math.abs(a - currentBin) - Math.abs(b - currentBin))
        .slice(0, MAX_LIQUIDITY_INITIALIZED_TICKS)
        .sort((a, b) => a - b);
      truncated = true;
    }
    const nets = await Promise.all(
      readable.map((tick) => publicClient.readContract({
        address: pool,
        abi: POOL_READER_ABI,
        functionName: "ticks",
        args: [tick],
        blockNumber,
      })),
    );
    const netAt = new Map<number, bigint>();
    readable.forEach((tick, index) => {
      const row = nets[index];
      if (row !== undefined) netAt.set(tick, row[1]);
    });
    const keptLow = truncated && readable[0] !== undefined ? readable[0] : lowBin;
    const keptHigh = truncated && readable[readable.length - 1] !== undefined
      ? (readable[readable.length - 1] as number)
      : highBin;
    // Walk up from the active bin.
    const bins: { readonly tickLower: number; readonly liquidity: bigint }[] = [];
    let running = liquidity;
    for (let bin = currentBin; bin <= highBin; bin += spacing) {
      if (bin !== currentBin) {
        // Entering `bin` from below crosses the initialized tick AT `bin` (if any).
        running += netAt.get(bin) ?? 0n;
      }
      if (truncated && bin > keptHigh) break;
      bins.push({ tickLower: bin, liquidity: running < 0n ? 0n : running });
    }
    // Walk down from the active bin: leaving `bin` downwards crosses the tick at `bin`.
    running = liquidity;
    for (let bin = currentBin - spacing; bin >= lowBin; bin -= spacing) {
      running -= netAt.get(bin + spacing) ?? 0n;
      if (truncated && bin < keptLow) break;
      bins.push({ tickLower: bin, liquidity: running < 0n ? 0n : running });
    }
    bins.sort((a, b) => a.tickLower - b.tickLower);
    return {
      pool: getAddress(pool),
      blockNumber,
      currentTick,
      tickSpacing: spacing,
      activeLiquidity: liquidity,
      bins,
      truncated,
    };
  }

  return {
    getPool,
    poolState,
    gridArmBenchmark,
    tickLiquidity,
    positions,
    positionFees,
    positionFeesAt,
    ownerOf,
    quote,
    quoteWithPriceAfter,
    // PHASE3.19 item 5 — the ladder's buffer reader. The WALLET is a parameter
    // rather than closed over: this reader object is per-DEPLOYMENT and the
    // wallet is per-AGENT, and the saga seam binds it (`buildSagaDeps`).
    walletTokenBalance,
    walletNativeBalance,
    receipts: {
      feeEvents: async (txHash, atomic) => {
        const receipt = await receiptOf(txHash);
        const fees = decodeLpFeeReceipt(receipt, nfpm, txHash);
        if (atomic === undefined) return fees;
        const pool = await getPool(atomic.token0, atomic.token1, atomic.fee);
        if (pool === null) throw new LpFeeReceiptEvidenceError("Atomic rotate pool is unavailable");
        try {
          return { ...fees, atomicRotate: parseAtomicRotateReceipt(receipt.logs, { oldTokenId: atomic.oldTokenId, wallet: atomic.wallet, nfpm, pool }) };
        } catch (error) { throw new LpFeeReceiptEvidenceError(error); }
      },
      collectAmounts,
      swapAmounts,
      expectedPoolSwap,
      atomicRotateReceipt: async (txHash: Hex, identity: AtomicRotateReceiptIdentity) => {
        const receipt = await receiptOf(txHash);
        if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) throw new Error("Atomic rotate receipt did not succeed or match the requested transaction.");
        return parseAtomicRotateReceipt(receipt.logs, identity);
      },
      mintedTokenId,
      mintedTokenIds,
      mintAmounts,
    },
    onChainNativeDailyCapWei,
    blockNumber,
    finalizedBlockNumber,
    // `logAbsence` is deliberately NOT wired: no endpoint this resolver
    // configures can serve `eth_getLogs` alongside the receipts the inputs
    // check needs. See `LpChainReaders.logAbsence`.
  };
}

/* -------------------------------------------------------------------------- */
/* Address resolution (boot-time, throws — the config.ts posture)             */
/* -------------------------------------------------------------------------- */

/** Every address the LP surface pins. Routers/WBNB come from the venue config. */
export type LpAddressConfig = {
  readonly nfpm: Address;
  readonly factory: Address;
  readonly quoterV2: Address;
  readonly routerV3: Address;
  readonly wbnb: Address;
};

function readLpAddressOverride(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: Address | undefined,
  keyStore: Address | undefined,
): Address | undefined {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  if (!isAddress(raw)) {
    throw new Error(`${name} is not a valid checksummed address.`);
  }
  const address = getAddress(raw);
  if (address === getAddress(zeroAddress)) {
    throw new Error(`${name} must not be the zero address.`);
  }
  if (keyStore !== undefined && address === getAddress(keyStore)) {
    throw new Error(`${name} must not be the key registry.`);
  }
  return address;
}

/**
 * Resolve the five LP addresses at BOOT — chain-56 defaults (all
 * bytecode-verified, see the constants above and `src/ops/nfpm.ts`), env
 * overrides `LP_NFPM` / `LP_V3_FACTORY` / `LP_QUOTER_V2` validated with the
 * venue rules (never zero, never the KeyStore), router/WBNB taken from the
 * SAME resolved venue config the trade route runs on. A chain with no default
 * and no override FAILS THE BOOT with the variable named — the
 * `resolvePasskeyConfig` posture: a malformed LP deployment refuses to start,
 * never a request (PHASE3 build item 3).
 */
export function resolveLpAddresses(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly chainId: number;
    readonly keyStore?: Address;
    readonly routerV3?: Address;
    readonly wbnb?: Address;
  },
): LpAddressConfig {
  const defaults =
    options.chainId === 56
      ? {
          nfpm: getAddress("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"),
          factory: PANCAKE_V3_FACTORY_56,
          quoterV2: PANCAKE_V3_QUOTER_V2_56,
        }
      : { nfpm: undefined, factory: undefined, quoterV2: undefined };

  const keyStore = options.keyStore;
  const nfpm = readLpAddressOverride(env, "LP_NFPM", defaults.nfpm, keyStore);
  const factory = readLpAddressOverride(env, "LP_V3_FACTORY", defaults.factory, keyStore);
  const quoterV2 = readLpAddressOverride(env, "LP_QUOTER_V2", defaults.quoterV2, keyStore);

  const missing: string[] = [];
  if (nfpm === undefined) missing.push("LP_NFPM");
  if (factory === undefined) missing.push("LP_V3_FACTORY");
  if (quoterV2 === undefined) missing.push("LP_QUOTER_V2");
  if (options.routerV3 === undefined) missing.push("VENUE_PANCAKE_ROUTER_V3");
  if (options.wbnb === undefined) missing.push("VENUE_WBNB");
  if (missing.length > 0 || options.routerV3 === undefined || options.wbnb === undefined) {
    throw new Error(
      `LP is enabled but chain ${options.chainId} has no ${missing.join(", ")} configured. ` +
        `Refusing to start with a partial LP venue.`,
    );
  }
  if (nfpm === undefined || factory === undefined || quoterV2 === undefined) {
    throw new Error("resolveLpAddresses: internal consistency failure."); // unreachable
  }
  return {
    nfpm,
    factory,
    quoterV2,
    routerV3: getAddress(options.routerV3),
    wbnb: getAddress(options.wbnb),
  };
}

export const NFPM_DECREASE_LIQUIDITY_TOPIC = keccak256(stringToBytes("DecreaseLiquidity(uint256,uint128,uint256,uint256)"));

/** Receipt-local accounting only; does not relax the strict money readers. */
export function decodeLpFeeReceipt(receipt: TransactionReceipt, nfpm: Address, txHash: Hex): LpFeeReceipt {
  try {
    return decodeFeeReceipt(receipt, nfpm, txHash);
  } catch (error) {
    throw new LpFeeReceiptEvidenceError(error);
  }
}

/** Distinguishes invalid receipt evidence from retryable receipt transport failures. */
export class LpFeeReceiptEvidenceError extends Error {
  // Invalid evidence cannot certify H > B and exclude this gap from coverage.
  readonly blockNumber = 0n;
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Invalid fee receipt evidence");
  }
}

function decodeFeeReceipt(receipt: TransactionReceipt, nfpm: Address, txHash: Hex): LpFeeReceipt {
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()
    || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n) throw new Error("Invalid fee receipt evidence");
  const byTokenId = new Map<string, { collected0: bigint; collected1: bigint; decreased0: bigint; decreased1: bigint }>();
  const collected = new Set<string>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== nfpm.toLowerCase()) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (topic !== NFPM_COLLECT_TOPIC && topic !== NFPM_DECREASE_LIQUIDITY_TOPIC) continue;
    if (log.removed || log.topics.length !== 2 || !/^0x[0-9a-fA-F]{64}$/u.test(log.topics[1] ?? "")
      || !/^0x[0-9a-fA-F]{192}$/u.test(log.data) || log.transactionHash?.toLowerCase() !== txHash.toLowerCase()
      || log.blockNumber !== receipt.blockNumber) throw new Error("Malformed NFPM fee event");
    if (topic === NFPM_COLLECT_TOPIC && !/^0{24}/u.test(log.data.slice(2))
      || topic === NFPM_DECREASE_LIQUIDITY_TOPIC && BigInt("0x" + log.data.slice(2,66)) > MAX_UINT128) throw new Error("Noncanonical NFPM fee ABI word");
    const tokenId = BigInt(log.topics[1]!).toString();
    const row = byTokenId.get(tokenId) ?? { collected0: 0n, collected1: 0n, decreased0: 0n, decreased1: 0n };
    if (topic === NFPM_COLLECT_TOPIC) {
      const [, a, b] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], log.data);
      row.collected0 += a; row.collected1 += b; collected.add(tokenId);
    } else {
      const [liquidity, a, b] = decodeAbiParameters([{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }], log.data);
      if (liquidity > MAX_UINT128) throw new Error("Invalid decreased liquidity");
      row.decreased0 += a; row.decreased1 += b;
    }
    if (Object.values(row).some(amount => amount > (1n << 256n) - 1n)) throw new Error("Fee event sum exceeds uint256");
    byTokenId.set(tokenId, row);
  }
  for (const id of byTokenId.keys()) if (!collected.has(id)) throw new Error("Decrease without collect in managed receipt");
  return { blockNumber: receipt.blockNumber, byTokenId };
}

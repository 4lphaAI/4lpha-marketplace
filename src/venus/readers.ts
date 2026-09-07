/**
 * Venus chain readers — the ONE place Venus worker/route chain reads happen
 * (PHASE4-SPEC "What the plane trusts", R2.2, R2.12, R2.15/R15, R3.12).
 *
 * ─── FINALITY DISCIPLINE ───────────────────────────────────────────────────
 *
 * Every DECISION read is taken at `blockTag: "finalized"` and then PINNED to
 * that block number, so the whole per-market set is one coherent snapshot and
 * the R2.2 cross-check compares like with like. The `finalized` tag was
 * VERIFIED on both BSC endpoints on 2026-08-13 (`src/lp/readers.ts:14-30`,
 * measured 2-3 blocks behind `latest`); a provider that does not support it
 * fails the read LOUDLY, which holds the trigger — never a silent fall-back to
 * `latest`.
 *
 * ─── STORED vs CURRENT, AND WHY BOTH ARE READ ──────────────────────────────
 *
 * `getAccountSnapshot` answers on the STORED basis and that is what
 * `getAccountLiquidity`/`getBorrowingPower` match, so the equality proof runs
 * there (R2.12). `borrowBalanceCurrent` / `exchangeRateCurrent` are reached
 * through `eth_call` in the SAME pinned set for the sizing clamp; a
 * contract-level failure leaves them `null` rather than throwing, and the sizer
 * then has no current basis to clamp on. `borrowStored` and `borrowCurrent`
 * were UNEQUAL on 2026-08-22 and EQUAL on 2026-08-24 — neither relation may be
 * assumed.
 *
 * ─── vBNB IS PINNED BY ADDRESS ─────────────────────────────────────────────
 *
 * "Is this market native" is a LOCAL CONSTANT resolved from boot config and
 * validated against the chain, never a `symbol() === "vBNB"` match inside an
 * advisory cache (R2.15/R15). The choice between `repayBorrow()` payable and
 * `approve` + `repayBorrow(uint256)` is a money decision about calldata, and
 * the trust boundary this phase inherits says the cached snapshot is never
 * authorization to move funds. Every OTHER market's underlying comes from this
 * plane's own `underlying()` read.
 *
 * ─── WHAT IS NOT HERE ──────────────────────────────────────────────────────
 *
 * No writes. The four money actions are built in `src/venus/builders.ts` and
 * submitted through the provider; this module answers questions.
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
import {
  DIAMOND_LOUPE_ABI,
  VENUS_COMPTROLLER_ABI,
  VENUS_DBO_ABI,
  VENUS_ERC20_ABI,
  VENUS_ORACLE_ABI,
  VENUS_PRIME_ABI,
  VENUS_VAI_CONTROLLER_ABI,
  VENUS_VTOKEN_ABI,
} from "./abis.js";
import type {
  VenusAccountReading,
  VenusMarketReading,
  VenusVenue,
} from "./types.js";
import type { VenusRoutingCensus } from "../ops/policy.js";

/** The network facts the readers pin to — the provider's own, never a second config. */
export type VenusReaderNetwork = {
  readonly chain: Chain;
  readonly chainId: number;
  readonly publicRpcUrl: string;
};

/** BNB mainnet endpoints that answer the reads this module makes. */
const BSC_MAINNET_RPC_URLS: readonly string[] = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed1.defibit.io",
];

export function resolveVenusRpcUrls(
  env: Readonly<Record<string, string | undefined>>,
  network: VenusReaderNetwork,
): readonly string[] {
  const override = (env["VENUS_RPC_URL"] ?? env["LP_RPC_URL"] ?? env["SPIKE_RPC_URL"] ?? "").trim();
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

/** `actionPaused` action indices, from the Comptroller's own enum. */
const ACTION_MINT = 0;
const ACTION_REPAY = 3;

/** The `claimVenus(address,address[])` selector the loupe is asked about. */
export const CLAIM_VENUS_SELECTOR: Hex = "0x86df31ee";

/** EIP-1967 implementation slot — how Prime's implementation is located. */
const EIP1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface VenusChainReaders {
  /** The full per-market finalized decision set for one owner. */
  readAccount(
    owner: Address,
    signal?: AbortSignal,
  ): Promise<VenusAccountReading>;
  /** The R3.12 grant-time routing census, read fresh. */
  readRoutingCensus(
    vTokens: readonly Address[],
    signal?: AbortSignal,
  ): Promise<VenusRoutingCensus>;
  /**
   * `borrowBalanceCurrent` for one market — the POST-RECEIPT effect read
   * (R2.8). Deliberately its own method: effect verification is authoritative
   * over the receipt, and re-reading the whole account set to answer one
   * question is a cost paid on every submission.
   */
  readBorrowCurrent(
    owner: Address,
    vToken: Address,
    signal?: AbortSignal,
  ): Promise<bigint>;
  /** `getAccountSnapshot`'s vToken balance — the supply effect read (R2.8). */
  readVTokenBalance(
    owner: Address,
    vToken: Address,
    signal?: AbortSignal,
  ): Promise<bigint>;
  /** ERC-20 `balanceOf` — the claim effect read (R2.8). */
  readTokenBalance(
    owner: Address,
    token: Address,
    signal?: AbortSignal,
  ): Promise<bigint>;
  /** Prime's own `paused()`, a DIFFERENT contract from `protocolPaused`. */
  readPrimePaused(signal?: AbortSignal): Promise<boolean>;
  /** Prime's pending rewards, static. */
  readPrimePending(
    owner: Address,
    signal?: AbortSignal,
  ): Promise<readonly { readonly vToken: Address; readonly rewardToken: Address; readonly amount: bigint }[]>;
  /**
   * Simulate `claimVenus(owner, vTokens)` and report the payout it would
   * produce — `payoutNow`, never `entitlement` (D1). The `address[]` is the
   * IDENTICAL array the submission will use (R2.15/R19b).
   */
  simulateXvsClaim(
    owner: Address,
    vTokens: readonly Address[],
    rewardToken: Address,
    signal?: AbortSignal,
  ): Promise<bigint>;
  /** The Venus oracle's price for a market's underlying, scaled 1e(36-d). */
  readUnderlyingPrice(vToken: Address, signal?: AbortSignal): Promise<bigint>;
  /**
   * vToken -> its underlying, for the boot-resolved `marketIndex`
   * (PHASE4-AUDIT A1).
   *
   * The settings route needs to know which underlying a named market takes a
   * ceiling for, and it must NOT make that chain read inside `ownerMutation`'s
   * journaled act (R2.15/R20). So the index is resolved once at boot, from
   * this plane's OWN `underlying()` reads — never from the advisory cache's
   * symbol-derived `native` flag (R2.15/R15). vBNB is the one market whose
   * `underlying()` is not called; it answers `null`.
   */
  readMarketIndex(
    vTokens: readonly Address[],
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, { readonly underlying: Address | null }>>>;
}

export type CreateVenusChainReadersOptions = {
  readonly network: VenusReaderNetwork;
  readonly rpcUrls?: readonly string[];
  readonly transport?: (rpcUrl: string) => Transport;
  readonly venue: VenusVenue;
  /**
   * Markets to read. Passing the owner's own list rather than
   * `getAllMarkets()` bounds the per-cycle read count (R3.10): 52 Core markets
   * x ~8 reads each is not a per-30-second budget, and the guard only ever acts
   * on markets the owner named plus the ones the account is actually in.
   */
  readonly markets: readonly Address[];
};

type Connection = { readonly publicClient: PublicClient };

export function createVenusChainReaders(
  options: CreateVenusChainReadersOptions,
): VenusChainReaders {
  const { network } = options;
  const comptroller = getAddress(options.venue.comptroller);
  const prime = getAddress(options.venue.prime);
  const vBnb = getAddress(options.venue.vBnb);
  const markets = [...new Set(options.markets.map((m) => getAddress(m)))];
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
      const publicClient: PublicClient = createPublicClient({
        chain: network.chain,
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

  async function readMarket(
    client: PublicClient,
    owner: Address,
    vToken: Address,
    blockNumber: bigint,
    oracle: Address,
    dbo: Address,
    memberSet: ReadonlySet<string>,
  ): Promise<VenusMarketReading> {
    const native = vToken.toLowerCase() === vBnb.toLowerCase();
    const [symbol, vTokenDecimals, snapshot, market, effectiveCf, effectiveLt, spot, bounded,
      mintPaused, repayPaused, supplyCap, totalSupply, exchangeRateStored] =
      await Promise.all([
        client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "symbol", blockNumber }),
        client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "decimals", blockNumber }),
        client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "getAccountSnapshot", args: [owner], blockNumber }),
        client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "markets", args: [vToken], blockNumber }),
        client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLtvFactor", args: [owner, vToken, 0], blockNumber }),
        client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "getEffectiveLtvFactor", args: [owner, vToken, 1], blockNumber }),
        client.readContract({ address: oracle, abi: VENUS_ORACLE_ABI, functionName: "getUnderlyingPrice", args: [vToken], blockNumber }),
        client.readContract({ address: dbo, abi: VENUS_DBO_ABI, functionName: "getBoundedPricesView", args: [vToken], blockNumber }),
        client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "actionPaused", args: [vToken, ACTION_MINT], blockNumber }),
        client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "actionPaused", args: [vToken, ACTION_REPAY], blockNumber }),
        client.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "supplyCaps", args: [vToken], blockNumber }),
        client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "totalSupply", blockNumber }),
        client.readContract({ address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "exchangeRateStored", blockNumber }),
      ]);

    // vBNB is the ONE market whose `underlying()` is not called; every other
    // underlying comes from this plane's own read (R2.15/R15).
    const underlying = native
      ? null
      : getAddress(
          await client.readContract({
            address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "underlying", blockNumber,
          }),
        );
    const underlyingDecimals = native
      ? 18
      : await client.readContract({
          address: underlying as Address, abi: VENUS_ERC20_ABI, functionName: "decimals", blockNumber,
        });

    // The CURRENT basis, through `eth_call`. A contract-level failure leaves
    // both `null`; the sizer then has no current clamp and says so.
    let borrowCurrent: bigint | null = null;
    let exchangeRateCurrent: bigint | null = null;
    try {
      const [borrow, rate] = await Promise.all([
        client.simulateContract({
          address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "borrowBalanceCurrent",
          args: [owner], account: owner, blockNumber,
        }).then((result) => result.result),
        client.simulateContract({
          address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "exchangeRateCurrent",
          account: owner, blockNumber,
        }).then((result) => result.result),
      ]);
      borrowCurrent = borrow;
      exchangeRateCurrent = rate;
    } catch {
      borrowCurrent = null;
      exchangeRateCurrent = null;
    }

    const [walletBalance, allowance] = await Promise.all([
      native
        ? client.getBalance({ address: owner, blockNumber })
        : client.readContract({
            address: underlying as Address, abi: VENUS_ERC20_ABI,
            functionName: "balanceOf", args: [owner], blockNumber,
          }),
      native
        ? Promise.resolve(0n)
        : client.readContract({
            address: underlying as Address, abi: VENUS_ERC20_ABI,
            functionName: "allowance", args: [owner, vToken], blockNumber,
          }),
    ]);

    const supplied = (totalSupply * exchangeRateStored) / 10n ** 18n;
    const supplyHeadroom = supplyCap > supplied ? supplyCap - supplied : 0n;

    return {
      vToken,
      vTokenSymbol: symbol,
      vTokenDecimals,
      underlying,
      underlyingDecimals,
      native,
      listed: market[0],
      borrowAllowed: market[6],
      collateralMember: memberSet.has(vToken.toLowerCase()),
      vTokenBalance: snapshot[1],
      borrowStored: snapshot[2],
      exchangeRateStored: snapshot[3],
      borrowCurrent,
      exchangeRateCurrent,
      effectiveCf,
      effectiveLt,
      spotPrice: spot,
      boundedCollateralPrice: bounded[0],
      boundedDebtPrice: bounded[1],
      mintPaused,
      repayPaused,
      supplyHeadroom,
      walletBalance,
      allowance,
    };
  }

  return {
    async readAccount(owner: Address): Promise<VenusAccountReading> {
      const { publicClient } = await connected();
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      const blockNumber = finalized.number;
      if (blockNumber === null) {
        throw new Error("The finalized block carries no number; the trigger holds.");
      }
      const target = getAddress(owner);

      const [oracle, dbo, vaiController, protocolPaused, userPoolId, lastPoolId,
        assetsIn, accountLiquidity, borrowingPower] = await Promise.all([
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "oracle", blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "deviationBoundedOracle", blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "vaiController", blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "protocolPaused", blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "userPoolId", args: [target], blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "lastPoolId", blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "getAssetsIn", args: [target], blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [target], blockNumber }),
        publicClient.readContract({ address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "getBorrowingPower", args: [target], blockNumber }),
      ]);
      const vaiDebt = await publicClient.readContract({
        address: getAddress(vaiController), abi: VENUS_VAI_CONTROLLER_ABI,
        functionName: "getVAIRepayAmount", args: [target], blockNumber,
      });

      // The union of the owner's configured markets and every market the
      // account is actually IN. `getAssetsIn` includes markets with a ZERO
      // supplied balance (vUSDT on the test wallet), so membership is not
      // collateral — but a member market still weights into W and must be read.
      const memberSet = new Set(assetsIn.map((entry) => entry.toLowerCase()));
      const toRead = [
        ...new Set([
          ...markets.map((entry) => entry.toLowerCase()),
          ...memberSet,
        ]),
      ].map((entry) => getAddress(entry));

      const readings = await Promise.all(
        toRead.map((vToken) =>
          readMarket(publicClient, target, vToken, blockNumber, getAddress(oracle), getAddress(dbo), memberSet),
        ),
      );

      // A non-zero `getAccountSnapshot` code is `snapshot-error` at the caller.
      // `readMarket` cannot report it (viem decodes the tuple positionally and
      // the code is index 0), so it is checked here, once, over the whole set.
      const snapshotErrors = await Promise.all(
        toRead.map(async (vToken) => ({
          vToken,
          code: (
            await publicClient.readContract({
              address: vToken, abi: VENUS_VTOKEN_ABI, functionName: "getAccountSnapshot",
              args: [target], blockNumber,
            })
          )[0],
        })),
      );
      const failed = snapshotErrors.find((entry) => entry.code !== 0n);

      return {
        blockNumber,
        blockHash: finalized.hash,
        owner: target,
        protocolPaused,
        userPoolId,
        lastPoolId,
        vaiDebt,
        accountLiquidity,
        borrowingPower,
        markets: readings,
        snapshotErrorMarket: failed === undefined ? null : failed.vToken,
      };
    },

    async readRoutingCensus(vTokens: readonly Address[]): Promise<VenusRoutingCensus> {
      const { publicClient } = await connected();
      const claimVenusFacet = await publicClient.readContract({
        address: comptroller,
        abi: DIAMOND_LOUPE_ABI,
        functionName: "facetAddress",
        args: [CLAIM_VENUS_SELECTOR],
      });
      const slot = await publicClient.getStorageAt({
        address: prime,
        slot: EIP1967_IMPLEMENTATION_SLOT,
      });
      if (slot === undefined) {
        throw new Error("Prime's EIP-1967 implementation slot could not be read.");
      }
      const primeImplementation = getAddress(`0x${slot.slice(-40)}`);
      const vTokenImplementations = await Promise.all(
        vTokens
          .filter((vToken) => vToken.toLowerCase() !== vBnb.toLowerCase())
          .map(async (vToken) => {
            const implementation = await publicClient.readContract({
              address: getAddress(vToken),
              abi: VENUS_VTOKEN_ABI,
              functionName: "implementation",
            });
            return [getAddress(vToken), getAddress(implementation)] as const;
          }),
      );
      return {
        claimVenusFacet: getAddress(claimVenusFacet),
        primeImplementation,
        vTokenImplementations,
      };
    },

    async readMarketIndex(
      vTokens: readonly Address[],
    ): Promise<Readonly<Record<string, { readonly underlying: Address | null }>>> {
      const { publicClient } = await connected();
      const index: Record<string, { readonly underlying: Address | null }> = {};
      for (const entry of vTokens) {
        const market = getAddress(entry);
        if (market === vBnb) {
          // The ONE native market, pinned by ADDRESS and validated against the
          // venue config rather than a `symbol()` string.
          index[market.toLowerCase()] = { underlying: null };
          continue;
        }
        const underlying = await publicClient.readContract({
          address: market,
          abi: VENUS_VTOKEN_ABI,
          functionName: "underlying",
        });
        index[market.toLowerCase()] = { underlying: getAddress(underlying) };
      }
      return index;
    },

    async readBorrowCurrent(owner: Address, vToken: Address): Promise<bigint> {
      const { publicClient } = await connected();
      const target = getAddress(owner);
      const result = await publicClient.simulateContract({
        address: getAddress(vToken),
        abi: VENUS_VTOKEN_ABI,
        functionName: "borrowBalanceCurrent",
        args: [target],
        account: target,
      });
      return result.result;
    },

    async readVTokenBalance(owner: Address, vToken: Address): Promise<bigint> {
      const { publicClient } = await connected();
      const snapshot = await publicClient.readContract({
        address: getAddress(vToken),
        abi: VENUS_VTOKEN_ABI,
        functionName: "getAccountSnapshot",
        args: [getAddress(owner)],
      });
      if (snapshot[0] !== 0n) {
        throw new Error(`getAccountSnapshot returned error code ${snapshot[0]}.`);
      }
      return snapshot[1];
    },

    async readTokenBalance(owner: Address, token: Address): Promise<bigint> {
      const { publicClient } = await connected();
      if (getAddress(token) === getAddress(zeroAddress)) {
        return publicClient.getBalance({ address: getAddress(owner) });
      }
      return publicClient.readContract({
        address: getAddress(token),
        abi: VENUS_ERC20_ABI,
        functionName: "balanceOf",
        args: [getAddress(owner)],
      });
    },

    async readPrimePaused(): Promise<boolean> {
      const { publicClient } = await connected();
      return publicClient.readContract({
        address: prime,
        abi: VENUS_PRIME_ABI,
        functionName: "paused",
      });
    },

    async readPrimePending(owner: Address) {
      const { publicClient } = await connected();
      const pending = await publicClient.readContract({
        address: prime,
        abi: VENUS_PRIME_ABI,
        functionName: "getPendingRewardsStatic",
        args: [getAddress(owner)],
      });
      return pending.map((entry) => ({
        vToken: getAddress(entry.vToken),
        rewardToken: getAddress(entry.rewardToken),
        amount: entry.amount,
      }));
    },

    async simulateXvsClaim(
      owner: Address,
      vTokens: readonly Address[],
      rewardToken: Address,
    ): Promise<bigint> {
      const { publicClient } = await connected();
      const target = getAddress(owner);
      // BALANCE, CLAIM, BALANCE — inside ONE Multicall3 aggregate, which is the
      // only way the middle call's state change is visible to the third. Two
      // separate `eth_call`s would each start from the same pre-claim state and
      // measure a payout of zero on every account.
      //
      // The `address[]` is the IDENTICAL array the submission will use
      // (R2.15/R19b): a simulation over a different market list answers a
      // different question, and `payoutNow` — not `entitlement` — is the
      // decision variable. 51 of 52 Core markets carry zero XVS speeds, so an
      // entitlement-driven claim would burn relay fees on nothing.
      //
      // `msg.sender` inside the aggregate is Multicall3, not the owner. That is
      // correct and is the point: `claimVenus` pays the NAMED HOLDER from that
      // holder's own accrual, which is also why a leaked key cannot redirect
      // the owner's rewards away from the owner (the residual is relay-fee
      // griefing — R2.15/R19d).
      const simulation = await publicClient.multicall({
        allowFailure: true,
        contracts: [
          {
            address: getAddress(rewardToken),
            abi: VENUS_ERC20_ABI,
            functionName: "balanceOf",
            args: [target],
          },
          {
            address: comptroller,
            abi: VENUS_COMPTROLLER_ABI,
            functionName: "claimVenus",
            args: [target, vTokens.map((entry) => getAddress(entry))],
          },
          {
            address: getAddress(rewardToken),
            abi: VENUS_ERC20_ABI,
            functionName: "balanceOf",
            args: [target],
          },
        ],
      });
      const before = simulation[0];
      const claim = simulation[1];
      const after = simulation[2];
      if (
        before?.status !== "success"
        || claim?.status !== "success"
        || after?.status !== "success"
      ) {
        // A reverted simulation is `payout-zero` at the caller, never a guess.
        return 0n;
      }
      const beforeValue = before.result;
      const afterValue = after.result;
      return afterValue >= beforeValue ? afterValue - beforeValue : 0n;
    },

    async readUnderlyingPrice(vToken: Address): Promise<bigint> {
      const { publicClient } = await connected();
      const oracle = await publicClient.readContract({
        address: comptroller, abi: VENUS_COMPTROLLER_ABI, functionName: "oracle",
      });
      return publicClient.readContract({
        address: getAddress(oracle),
        abi: VENUS_ORACLE_ABI,
        functionName: "getUnderlyingPrice",
        args: [getAddress(vToken)],
      });
    },
  };
}

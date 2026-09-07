/**
 * The passkey-only reserve recovery — the no-lock-in property, in code.
 *
 * §6.2: after the session expires (seven days, every marketplace session), or
 * on any server outage, the owner can bring the reserve home with the PASSKEY
 * ALONE. No server, no session key, no plane. The plane learns of it later, by
 * observation — `vUSDT.balanceOf(B) == 0` with no retire journal row closes the
 * guard as `recovered-by-owner`.
 *
 * ─── THE BATCH IS THE R2.5 RETIRE SHAPE, NOT A NEW ONE ─────────────────────
 *
 * Three calls (four with the redeem), computed from ONE pinned read of B:
 *
 *   redeemAmt = min(suppliedUsdt, cash − 1)          // never the last wei of pool cash
 *   swapIn    = idleUsdt + redeemAmt                  // EXACT, and it will exist
 *   minOut    = the plane's own QuoterV2 rail
 *
 *   [ vUSDT.redeemUnderlying(redeemAmt)              if redeemAmt > 0
 *   , approve(USDT, router, 0)
 *   , approve(USDT, router, swapIn)                  // EXACT, never an upper bound
 *   , router.multicall([ exactInputSingle(USDT→WBNB, recipient = ROUTER,
 *                                         amountIn = swapIn, amountOutMinimum = minOut,
 *                                         deadline),
 *                        unwrapWETH9(minOut, wallet) ]) ]
 *
 * `redeem(uint256)` is NOT used and is not in the session census: with
 * `redeemUnderlying(x)` the CALLER chooses `x`, so the approve and the swap
 * input are exact. Revision 1's retire used `redeem` and stranded ~80 % of the
 * reserve (R2.5 / OQ3).
 *
 * ─── WHY `withdrawWbnbAsNative` IS CITED ONLY AS A CALL SHAPE (R2.22) ──────
 *
 * `createAltanaClient().execute({ wallet, signer, chainId, calls })` is the SDK
 * shape this borrows. Its `WBNB.withdraw` leg is the FINDINGS (at) trap and is
 * NOT copied: the router unwraps for us inside the same multicall, and
 * `WBNB.withdraw` is not in any granted census.
 *
 * ─── A POOL-SHORT RECOVERY IS A PARTIAL, AND SAYS SO (R3.12) ───────────────
 *
 * When vUSDT cannot pay out the whole supply, this recovers what the pool CAN
 * pay and reports the remainder rather than refusing. The remainder stays
 * supplied on Venus and is recoverable by exactly this path again later.
 */
import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { TOKEN_WITHDRAW_FEE_FLOOR_WEI, formatBnb, tokenWithdrawFeeFloorWei } from "./withdraw";

/* -------------------------------------------------------------------------- */
/* ABIs — narrow on purpose                                                   */
/* -------------------------------------------------------------------------- */

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const VTOKEN_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "exchangeRateStored", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getCash", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "redeemUnderlying", stateMutability: "nonpayable", inputs: [{ name: "redeemAmount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/**
 * The DEDICATED PancakeSwap V3 SwapRouter's own shape (0x1b81…eB14), NOT the
 * SmartRouter's: the deadline lives INSIDE the swap struct here
 * (`exactInputSingle` 0x414bf389), and `multicall(uint256,bytes[])` is absent
 * from this dispatcher. Encoding the SmartRouter's shape would revert with empty
 * returndata (`src/ops/abis.ts`, verified against deployed bytecode).
 */
const ROUTER_ABI = [
  {
    type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" }, { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
] as const;

/**
 * `sqrtPriceLimitX96`, always zero. A price limit is a second slippage control
 * nobody asked for and silently turns a full fill into a partial one;
 * `amountOutMinimum` is the floor.
 */
const NO_PRICE_LIMIT = 0n;

const E18 = 10n ** 18n;

/* -------------------------------------------------------------------------- */
/* The pinned read of wallet B                                                */
/* -------------------------------------------------------------------------- */

export type LendingReserveReading = {
  readonly kind: "read";
  readonly blockNumber: bigint;
  readonly readAtMs: number;
  readonly usdtBalance: bigint;
  readonly vUsdtBalance: bigint;
  /** `exchangeRateStored` — a LOWER bound on what the vTokens are worth; xr only rises. */
  readonly exchangeRateStored: bigint;
  readonly cash: bigint;
  readonly nativeBalance: bigint;
  readonly usdtAllowanceToRouter: bigint;
  /**
   * Whether wallet B already has code at the pinned block — the ONLY fact that
   * decides which relay-fee tier this recovery must clear (W4). `null` when the
   * read did not answer, which takes the larger tier.
   */
  readonly walletHasCode: boolean | null;
};

export type LendingReserveRead =
  | LendingReserveReading
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Read wallet B's reserve DIRECTLY from chain, at one pinned block.
 *
 * The plane exposes no perimeter read of B's reserve — the only reserve figures
 * it serves ride the worker's `lending_snapshots` behind `authorizeAccountRead`,
 * and those are exactly what is unavailable in the case this path exists for (a
 * dead worker, an expired session, an unreachable plane). So the browser reads
 * it itself, through the wagmi public client, and the recovery is honest about
 * the block it was computed at.
 */
export async function readLendingReserve(
  client: PublicClient,
  input: {
    readonly wallet: Address;
    readonly vUsdt: Address;
    readonly usdt: Address;
    readonly routerV3: Address;
  },
): Promise<LendingReserveRead> {
  const unavailable = (reason: string): LendingReserveRead => ({ kind: "unavailable", reason });
  // W9 / R2.5: ONE FINALIZED block, and every leg of the plan read at it.
  // `latest` on BSC can be reorged out from under a batch that is about to spend
  // the whole reserve, and a plan whose legs came from different heights can ask
  // to redeem more than the pool held when the cash was read.
  let blockNumber: bigint;
  try {
    const finalized = await client.getBlock({ blockTag: "finalized" });
    if (typeof finalized.number !== "bigint") return unavailable("cannot read the finalized block");
    blockNumber = finalized.number;
  } catch {
    return unavailable("cannot read the finalized block");
  }
  let walletHasCode: boolean | null;
  try {
    const code = await client.getCode({ address: input.wallet, blockNumber });
    walletHasCode = code !== undefined && code !== "0x";
  } catch {
    // Unread is not "unregistered": it takes the LARGER fee tier, never refuses.
    walletHasCode = null;
  }
  try {
    const [usdtBalance, vUsdtBalance, exchangeRateStored, cash, nativeBalance, allowance] =
      await Promise.all([
        client.readContract({ address: input.usdt, abi: ERC20_ABI, functionName: "balanceOf", args: [input.wallet], blockNumber }),
        client.readContract({ address: input.vUsdt, abi: VTOKEN_ABI, functionName: "balanceOf", args: [input.wallet], blockNumber }),
        client.readContract({ address: input.vUsdt, abi: VTOKEN_ABI, functionName: "exchangeRateStored", blockNumber }),
        client.readContract({ address: input.vUsdt, abi: VTOKEN_ABI, functionName: "getCash", blockNumber }),
        client.getBalance({ address: input.wallet, blockNumber }),
        client.readContract({ address: input.usdt, abi: ERC20_ABI, functionName: "allowance", args: [input.wallet, input.routerV3], blockNumber }),
      ]);
    const values = [usdtBalance, vUsdtBalance, exchangeRateStored, cash, nativeBalance, allowance];
    if (values.some((value) => typeof value !== "bigint" || value < 0n)) {
      return unavailable("the reserve is not readable on chain");
    }
    return {
      kind: "read",
      blockNumber,
      readAtMs: Date.now(),
      usdtBalance: usdtBalance as bigint,
      vUsdtBalance: vUsdtBalance as bigint,
      exchangeRateStored: exchangeRateStored as bigint,
      cash: cash as bigint,
      nativeBalance: nativeBalance as bigint,
      usdtAllowanceToRouter: allowance as bigint,
      walletHasCode,
    };
  } catch {
    return unavailable("the reserve is not readable on chain");
  }
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                   */
/* -------------------------------------------------------------------------- */

export type LendingRecoveryPlan = {
  /** `floor(vUsdtBal × xr / 1e18)` — the LOWER bound of the supplied leg. */
  readonly suppliedUsdtWei: bigint;
  readonly redeemAmountWei: bigint;
  /** Exactly `idleUsdt + redeemAmount`. The approve and the swap both use it. */
  readonly swapInWei: bigint;
  /** True when the pool cannot pay out the whole supply in one go. */
  readonly poolShort: boolean;
  /** What stays supplied on Venus when the pool is short. Recoverable later. */
  readonly remainderUsdtWei: bigint;
};

export function planLendingRecovery(reading: LendingReserveReading): LendingRecoveryPlan {
  const suppliedUsdtWei = (reading.vUsdtBalance * reading.exchangeRateStored) / E18;
  // Never the last wei of pool cash (§5.4): a redeem that asks for exactly the
  // cash is the one that reverts when another borrower lands in the same block.
  const payable = reading.cash > 0n ? reading.cash - 1n : 0n;
  const redeemAmountWei = suppliedUsdtWei < payable ? suppliedUsdtWei : payable;
  const swapInWei = reading.usdtBalance + redeemAmountWei;
  return {
    suppliedUsdtWei,
    redeemAmountWei,
    swapInWei,
    poolShort: redeemAmountWei < suppliedUsdtWei,
    remainderUsdtWei: suppliedUsdtWei - redeemAmountWei,
  };
}

/**
 * The fee floor, IMPORTED rather than restated (AUDIT G-L1 / W4).
 *
 * R2.22 names `TOKEN_WITHDRAW_FEE_FLOOR_WEI` (`web/lib/altana/withdraw.ts`) as
 * the figure the page states. This file used to carry its own `3 × 60e12`,
 * which was 3 × a fee nobody measured — the measured relay fee is 3.88e13
 * (memory: `lp-relay-fee-measured-mainnet`), so the local copy was 55 % high and
 * would have refused a recovery a real wallet could pay for.
 *
 * The UNREGISTERED tier is honoured too: a wallet B with no code on chain still
 * carries the EIP-7702 `setCode` preCall and the KeyStore registration on its
 * first submission, which really does cost ~0.001 BNB. An unread registration
 * state takes the larger tier, exactly as `tokenWithdrawFeeFloorWei` does.
 */
export const LENDING_RECOVERY_FEE_FLOOR_WEI = TOKEN_WITHDRAW_FEE_FLOOR_WEI;

/** The floor for THIS wallet: `walletHasCode === true` is the steady tier. */
export function lendingRecoveryFeeFloorWei(walletHasCode: boolean | null | undefined): bigint {
  return tokenWithdrawFeeFloorWei({ registered: walletHasCode ?? null });
}

/** How much BNB must be added before the recovery batch can be paid for. */
export function lendingRecoveryShortfallWei(
  nativeWei: bigint,
  walletHasCode?: boolean | null,
): bigint {
  const floor = lendingRecoveryFeeFloorWei(walletHasCode);
  return nativeWei >= floor ? 0n : floor - nativeWei;
}

/** The shortfall as BNB, for a sentence an owner can act on (W4). */
export function lendingRecoveryShortfallBnb(
  nativeWei: bigint,
  walletHasCode?: boolean | null,
): string {
  return formatBnb(lendingRecoveryShortfallWei(nativeWei, walletHasCode));
}

/* -------------------------------------------------------------------------- */
/* The batch                                                                  */
/* -------------------------------------------------------------------------- */

export type RecoveryCall = { readonly to: Address; readonly value: bigint; readonly data: Hex };

export type LendingRecoveryVenue = {
  readonly vUsdt: Address;
  readonly usdt: Address;
  readonly routerV3: Address;
  readonly wbnb: Address;
  readonly swapFeeTier: number;
};

export type LendingRecoveryBatch =
  | { readonly ok: true; readonly calls: readonly RecoveryCall[]; readonly plan: LendingRecoveryPlan }
  | { readonly ok: false; readonly message: string };

/**
 * Build the recovery calls. PURE — no SDK, no network, no clock beyond the
 * deadline the caller hands in — so the shape is unit-testable against fixed
 * inputs, which is the only way an offline build can check it at all.
 */
export function buildLendingRecoveryBatch(input: {
  readonly reading: LendingReserveReading;
  readonly venue: LendingRecoveryVenue;
  readonly wallet: Address;
  /** From `GET /api/lending/quote` for EXACTLY `plan.swapInWei`. Never a price. */
  readonly minOutWei: bigint;
  readonly deadlineSec: bigint;
}): LendingRecoveryBatch {
  const plan = planLendingRecovery(input.reading);
  if (plan.swapInWei <= 0n) {
    return {
      ok: false,
      message: "There is nothing to recover: the wallet holds no idle USDT and the Venus pool can redeem nothing right now.",
    };
  }
  if (input.minOutWei <= 0n) {
    return {
      ok: false,
      message: "No swap floor was quoted, so the recovery would swap without a minimum. Refusing rather than signing that.",
    };
  }
  const hasCode = input.reading.walletHasCode;
  if (lendingRecoveryShortfallWei(input.reading.nativeBalance, hasCode) > 0n) {
    // W4: BNB, not raw wei — this sentence exists so an owner knows what to
    // deposit, and "116400000000000 wei" is not something anyone can act on.
    return {
      ok: false,
      message: `This wallet needs about ${formatBnb(lendingRecoveryFeeFloorWei(hasCode))} BNB to pay the network fee for this recovery${hasCode === true ? "" : " (its first on-chain action costs more)"} and holds ${formatBnb(input.reading.nativeBalance)} BNB. Deposit ${lendingRecoveryShortfallBnb(input.reading.nativeBalance, hasCode)} BNB and try again — the reserve is not going anywhere.`,
    };
  }

  const calls: RecoveryCall[] = [];
  if (plan.redeemAmountWei > 0n) {
    calls.push({
      to: input.venue.vUsdt,
      value: 0n,
      data: encodeFunctionData({
        abi: VTOKEN_ABI, functionName: "redeemUnderlying", args: [plan.redeemAmountWei],
      }) as Hex,
    });
  }
  // The zero-reset is UNCONDITIONAL, exactly as `buildPancakeV3Sell` emits it
  // (R3.9): `0 → 0` does not revert, and BSC-USDT refuses a live non-zero
  // allowance being overwritten. Reading the allowance to decide would make the
  // batch depend on a read that can be stale by inclusion.
  calls.push({
    to: input.venue.usdt,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [input.venue.routerV3, 0n] }) as Hex,
  });
  calls.push({
    to: input.venue.usdt,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [input.venue.routerV3, plan.swapInWei] }) as Hex,
  });
  const swap = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: input.venue.usdt,
      tokenOut: input.venue.wbnb,
      fee: input.venue.swapFeeTier,
      // The ROUTER'S OWN ADDRESS, written explicitly: the output must stay in
      // the router for `unwrapWETH9` to convert it. `address(1)`/`address(2)`
      // are literal recipients on this router and would strand the whole sell.
      recipient: input.venue.routerV3,
      deadline: input.deadlineSec,
      amountIn: plan.swapInWei,
      amountOutMinimum: input.minOutWei,
      sqrtPriceLimitX96: NO_PRICE_LIMIT,
    }],
  }) as Hex;
  const unwrap = encodeFunctionData({
    abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [input.minOutWei, input.wallet],
  }) as Hex;
  calls.push({
    to: input.venue.routerV3,
    value: 0n,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [[swap, unwrap]] }) as Hex,
  });
  return { ok: true, calls, plan };
}

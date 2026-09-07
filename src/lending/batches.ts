/**
 * Lending calldata builders — the ONLY place a lending money call is
 * constructed (MARKETPLACE-LENDING-AGENT §4.1, §5.3, R2.5, R2.7, R2.9, R3.9,
 * R3.12).
 *
 * ═══ WHICH BUILDER OWNS WHICH APPROVE (R3.9, closing REVIEW2 M5) ══════════
 *
 * TWO spenders take a USDT allowance in this phase and they are handled
 * DIFFERENTLY, on purpose:
 *
 *   - the ROUTER's legs are `buildPancakeV3Buy` / `buildPancakeV3Sell`
 *     VERBATIM. Those builders emit `[approve(0), approve(exact), multicall]`
 *     and the zero leg is UNCONDITIONAL by construction — `0 -> 0` does not
 *     revert on BSC-USDT, and touching a money builder shared with trade and LP
 *     to save one call would be the wrong trade. `usdtAllowanceToRouter` is
 *     therefore READ AND REPORTED, never a builder input.
 *   - the vUSDT spender is HAND-BUILT here, and its zero-first leg is emitted
 *     IFF `usdtAllowanceToVUsdt > 0`. This is where PHASE4-AUDIT A2's mechanism
 *     actually bites: a failOpaque `no-effect` repay CONFIRMS while leaving the
 *     batch's approve standing, and BSC-USDT reverts a non-zero -> non-zero
 *     approve, so a residual allowance would wedge every subsequent rescue.
 *
 * ═══ EVERY APPROVE IS EXACT ═══════════════════════════════════════════════
 *
 * Never `type(uint256).max`. The on-chain cap meters an `approve` at its
 * ARGUMENT (FINDINGS (h)), so a max approve exhausts a finite per-token cap in
 * one call — the trapped-exit family this repo has removed twice.
 *
 * ═══ THE SPENDER IS HARDCODED HERE ════════════════════════════════════════
 *
 * Every `approve` in this module names vUSDT or the router from RESOLVED BOOT
 * CONFIG, never from a request field. That is what the custody sentence means
 * by "when this plane builds the calldata"; `CallRule` cannot enforce it, and
 * nothing in this file may be read as claiming it can.
 */
import {
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

import type { WalletCall } from "../core/types.js";
import { buildApprove } from "../ops/pancake.js";
import { buildPancakeV3Buy, buildPancakeV3Sell } from "../ops/pancakeV3.js";
import { UINT256_MAX } from "../venus/builders.js";
import type { V3FeeTier } from "../ops/route.js";

/** The vUSDT write surface this phase is granted. THREE selectors, no more. */
const VUSDT_WRITE_ABI = [
  {
    type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "redeemUnderlying", stateMutability: "nonpayable",
    inputs: [{ name: "redeemAmount", type: "uint256" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "repayBorrowBehalf", stateMutability: "nonpayable",
    inputs: [
      { name: "borrower", type: "address" },
      { name: "repayAmount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** vBNB's payable repay-on-behalf. The amount IS `msg.value`. */
const VBNB_WRITE_ABI = [
  {
    type: "function", name: "repayBorrowBehalf", stateMutability: "payable",
    inputs: [{ name: "borrower", type: "address" }], outputs: [],
  },
] as const;

/**
 * The selectors this module may emit, ASSERTED against the calldata it
 * produces.
 *
 * A selector assertion is not ceremony here: the whole census argument rests on
 * the claim that these four functions and nothing else reach a vToken, and a
 * builder that silently encoded a different overload would pass every offline
 * shape test while granting nothing on chain (the `mint(tuple)` lesson,
 * `src/core/session.ts`).
 */
export const LENDING_SELECTORS: Readonly<Record<string, Hex>> = {
  "mint(uint256)": toFunctionSelector("function mint(uint256)"),
  "redeemUnderlying(uint256)": toFunctionSelector("function redeemUnderlying(uint256)"),
  "repayBorrowBehalf(address,uint256)": toFunctionSelector(
    "function repayBorrowBehalf(address,uint256)",
  ),
  "repayBorrowBehalf(address)": toFunctionSelector("function repayBorrowBehalf(address)"),
};

function assertSelector(data: Hex, signature: string): Hex {
  const expected = LENDING_SELECTORS[signature];
  if (expected === undefined) {
    throw new Error(`No pinned selector for "${signature}".`);
  }
  if (data.slice(0, 10).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Encoded calldata for "${signature}" starts ${data.slice(0, 10)}, not the pinned ${expected}. The census claims this phase reaches exactly four vToken functions; an unpinned overload would break that claim silently.`,
    );
  }
  return data;
}

function assertExact(amountWei: bigint, action: string): void {
  if (amountWei <= 0n) throw new Error(`${action}: the amount must be positive.`);
  if (amountWei >= UINT256_MAX) {
    throw new Error(
      `${action}: the 2^256-1 sentinel is FORBIDDEN — the on-chain cap meter cannot price it, and a max approve exhausts any finite per-token cap in one call.`,
    );
  }
}

/**
 * The vUSDT approve pair: zero-first IFF a residual allowance exists, then the
 * EXACT amount (R2.9, R3.9).
 */
export function vUsdtApproveLegs(input: {
  readonly usdt: Address;
  readonly vUsdt: Address;
  readonly amountWei: bigint;
  readonly currentAllowanceWei: bigint;
}): readonly WalletCall[] {
  const usdt = getAddress(input.usdt);
  const vUsdt = getAddress(input.vUsdt);
  const legs: WalletCall[] = [];
  if (input.currentAllowanceWei > 0n) {
    legs.push(buildApprove(usdt, vUsdt, 0n));
  }
  legs.push(buildApprove(usdt, vUsdt, input.amountWei));
  return legs;
}

/** `vUSDT.mint(amount)`. */
export function buildVUsdtMint(vUsdt: Address, amountWei: bigint): WalletCall {
  assertExact(amountWei, "lending mint");
  return {
    to: getAddress(vUsdt),
    data: assertSelector(
      encodeFunctionData({ abi: VUSDT_WRITE_ABI, functionName: "mint", args: [amountWei] }),
      "mint(uint256)",
    ),
  };
}

/** `vUSDT.redeemUnderlying(amount)` — the plane chooses the amount (OQ3). */
export function buildVUsdtRedeemUnderlying(
  vUsdt: Address,
  amountWei: bigint,
): WalletCall {
  assertExact(amountWei, "lending redeemUnderlying");
  return {
    to: getAddress(vUsdt),
    data: assertSelector(
      encodeFunctionData({
        abi: VUSDT_WRITE_ABI, functionName: "redeemUnderlying", args: [amountWei],
      }),
      "redeemUnderlying(uint256)",
    ),
  };
}

/** `vUSDT.repayBorrowBehalf(borrower, amount)`. */
export function buildVUsdtRepayBehalf(
  vUsdt: Address,
  borrower: Address,
  amountWei: bigint,
): WalletCall {
  assertExact(amountWei, "lending repayBorrowBehalf");
  return {
    to: getAddress(vUsdt),
    data: assertSelector(
      encodeFunctionData({
        abi: VUSDT_WRITE_ABI,
        functionName: "repayBorrowBehalf",
        args: [getAddress(borrower), amountWei],
      }),
      "repayBorrowBehalf(address,uint256)",
    ),
  };
}

/** `vBNB.repayBorrowBehalf{value: amount}(borrower)` — payable, no argument. */
export function buildVBnbRepayBehalf(
  vBnb: Address,
  borrower: Address,
  amountWei: bigint,
): WalletCall {
  assertExact(amountWei, "lending repayBorrowBehalf{value}");
  return {
    to: getAddress(vBnb),
    value: amountWei,
    data: assertSelector(
      encodeFunctionData({
        abi: VBNB_WRITE_ABI,
        functionName: "repayBorrowBehalf",
        args: [getAddress(borrower)],
      }),
      "repayBorrowBehalf(address)",
    ),
  };
}

export type LendingVenueAddresses = {
  readonly vUsdt: Address;
  readonly usdt: Address;
  readonly vBnb: Address;
  readonly routerV3: Address;
  readonly wbnb: Address;
  /**
   * The pinned WBNB/USDT tier (R2.19). Typed as the closed {@link V3FeeTier}
   * union, not `number`, so a boot config that resolved 3000 cannot reach a
   * builder — it fails where it is resolved, which is the only place an
   * operator can fix it.
   */
  readonly swapFeeTier: V3FeeTier;
};

/* -------------------------------------------------------------------------- */
/* The ARM batch (§4.1)                                                       */
/* -------------------------------------------------------------------------- */

export type ArmBatchInput = {
  readonly venue: LendingVenueAddresses;
  readonly wallet: Address;
  /** The arm swap's `msg.value` — `budget - reserve`. */
  readonly supplyNativeWei: bigint;
  /** `sagaSwapMinOut` of a live quote. The mint amount AND the swap floor. */
  readonly mintUsdtWei: bigint;
  readonly currentVUsdtAllowanceWei: bigint;
  readonly deadline: bigint;
};

/**
 * ONE relay batch: swap BNB -> USDT, approve vUSDT exactly, mint.
 *
 * WHY ONE BATCH AND NOT A SAGA: the arm has no intermediate state worth
 * resuming. A swap without a mint leaves USDT idle in B, which IS reserve; a
 * mint cannot happen without the swap. Atomicity is the relay batch's, and the
 * `lpSequences` machinery is deliberately not used anywhere in this phase.
 *
 * Call count (R3.9): `buildPancakeV3Buy` (1) + the vUSDT approve pair (1-2) +
 * `mint` (1) = three or four calls.
 */
export function buildLendingArmBatch(input: ArmBatchInput): readonly WalletCall[] {
  if (input.supplyNativeWei <= 0n) {
    throw new Error("buildLendingArmBatch: supplyNativeWei must be positive.");
  }
  assertExact(input.mintUsdtWei, "lending arm mint");
  return [
    ...buildPancakeV3Buy({
      router: input.venue.routerV3,
      wbnb: input.venue.wbnb,
      token: input.venue.usdt,
      amountInWei: input.supplyNativeWei,
      minOutWei: input.mintUsdtWei,
      recipient: getAddress(input.wallet),
      deadline: input.deadline,
      route: { hops: [], fees: [input.venue.swapFeeTier] },
    }),
    ...vUsdtApproveLegs({
      usdt: input.venue.usdt,
      vUsdt: input.venue.vUsdt,
      amountWei: input.mintUsdtWei,
      currentAllowanceWei: input.currentVUsdtAllowanceWei,
    }),
    buildVUsdtMint(input.venue.vUsdt, input.mintUsdtWei),
  ];
}

/* -------------------------------------------------------------------------- */
/* The USDT-debt rescue (§5.3)                                                */
/* -------------------------------------------------------------------------- */

export type UsdtRescueBatchInput = {
  readonly venue: LendingVenueAddresses;
  readonly wallet: Address;
  readonly borrower: Address;
  /** `r` — the exact repay amount. */
  readonly amountWei: bigint;
  /** From {@link planUsdtLegs}. */
  readonly takeRedeemWei: bigint;
  readonly takeSwapWei: bigint;
  /** The solver's answer for the pool-cash fallback. Ignored when no swap. */
  readonly swapInNativeWei: bigint;
  readonly swapMinOutWei: bigint;
  readonly currentVUsdtAllowanceWei: bigint;
  readonly deadline: bigint;
};

/**
 * `[redeemUnderlying?] [buy?] [approve pair] repayBorrowBehalf`.
 *
 * The redeem and the fallback buy are both CONDITIONAL: a rescue funded
 * entirely from idle USDT emits neither, and the zero-tier case never emits a
 * swap. Two per-selector rules on ONE vToken in one batch is exactly what the
 * census grants — and no `multicall` on any vToken.
 */
export function buildLendingUsdtRescueBatch(
  input: UsdtRescueBatchInput,
): readonly WalletCall[] {
  assertExact(input.amountWei, "lending USDT rescue");
  const calls: WalletCall[] = [];
  if (input.takeRedeemWei > 0n) {
    calls.push(buildVUsdtRedeemUnderlying(input.venue.vUsdt, input.takeRedeemWei));
  }
  if (input.takeSwapWei > 0n) {
    if (input.swapInNativeWei <= 0n) {
      throw new Error(
        "buildLendingUsdtRescueBatch: the pool-cash fallback needs a positive native input; a zero-input swap would deliver nothing and the repay would revert on the short balance.",
      );
    }
    calls.push(
      ...buildPancakeV3Buy({
        router: input.venue.routerV3,
        wbnb: input.venue.wbnb,
        token: input.venue.usdt,
        amountInWei: input.swapInNativeWei,
        // The REQUIREMENT, never the quote (R2.7): the repay's own
        // `transferFrom` is what would revert if the swap came up short.
        minOutWei: input.swapMinOutWei,
        recipient: getAddress(input.wallet),
        deadline: input.deadline,
        route: { hops: [], fees: [input.venue.swapFeeTier] },
      }),
    );
  }
  calls.push(
    ...vUsdtApproveLegs({
      usdt: input.venue.usdt,
      vUsdt: input.venue.vUsdt,
      amountWei: input.amountWei,
      currentAllowanceWei: input.currentVUsdtAllowanceWei,
    }),
    buildVUsdtRepayBehalf(input.venue.vUsdt, input.borrower, input.amountWei),
  );
  return calls;
}

/* -------------------------------------------------------------------------- */
/* The BNB-debt rescue (§5.3)                                                 */
/* -------------------------------------------------------------------------- */

export type NativeRescueBatchInput = {
  readonly venue: LendingVenueAddresses;
  readonly wallet: Address;
  readonly borrower: Address;
  readonly amountWei: bigint;
  /** USDT to redeem before the swap, when idle alone cannot fund `swapIn`. */
  readonly redeemUsdtWei: bigint;
  /** The solver's USDT input; `0n` when the tier alone covers `r`. */
  readonly swapInUsdtWei: bigint;
  /** What the swap must deliver as native — `takeSwapOut`. */
  readonly swapMinOutWei: bigint;
  readonly deadline: bigint;
};

/**
 * `[redeemUnderlying?] [sell?] repayBorrowBehalf{value: r}`.
 *
 * `value: r` is a LOWER BOUND the batch can always pay: `takeTier` is in the
 * wallet before the batch, and `takeSwapOut` arrives from `unwrapWETH9` INSIDE
 * the same multicall, whose `amountOutMinimum` is enforced by the swap itself.
 *
 * The router legs are `buildPancakeV3Sell` VERBATIM (R3.9) — approve(0),
 * approve(exact), multicall([exactInputSingle -> ROUTER, unwrapWETH9 -> B]) —
 * which is the proven unwrap path (FINDINGS (ag): `safeTransferETH`, full gas).
 */
export function buildLendingNativeRescueBatch(
  input: NativeRescueBatchInput,
): readonly WalletCall[] {
  assertExact(input.amountWei, "lending BNB rescue");
  const calls: WalletCall[] = [];
  if (input.redeemUsdtWei > 0n) {
    calls.push(buildVUsdtRedeemUnderlying(input.venue.vUsdt, input.redeemUsdtWei));
  }
  if (input.swapInUsdtWei > 0n) {
    if (input.swapMinOutWei <= 0n) {
      throw new Error(
        "buildLendingNativeRescueBatch: a swap leg needs a positive minOut; the repay's `value` is funded by that floor.",
      );
    }
    calls.push(
      ...buildPancakeV3Sell({
        router: input.venue.routerV3,
        wbnb: input.venue.wbnb,
        token: input.venue.usdt,
        amountInWei: input.swapInUsdtWei,
        minOutWei: input.swapMinOutWei,
        recipient: getAddress(input.wallet),
        deadline: input.deadline,
        route: { hops: [], fees: [input.venue.swapFeeTier] },
      }),
    );
  }
  calls.push(
    buildVBnbRepayBehalf(input.venue.vBnb, input.borrower, input.amountWei),
  );
  return calls;
}

/* -------------------------------------------------------------------------- */
/* The RETIRE batch (R2.5 as amended by R3.12)                                */
/* -------------------------------------------------------------------------- */

export type RetireBatchInput = {
  readonly venue: LendingVenueAddresses;
  readonly wallet: Address;
  /** `min(suppliedUsdt, cash - 1)`; `0n` when nothing is supplied. */
  readonly redeemAmountWei: bigint;
  /** `idleUsdt + redeemAmount` — EXACT, and it WILL exist after the redeem. */
  readonly swapInWei: bigint;
  /** `sagaSwapMinOut(quote(USDT -> WBNB, swapIn), slip)`. */
  readonly minOutWei: bigint;
  readonly deadline: bigint;
};

/**
 * `[redeemUnderlying?] approve(0) approve(exact) multicall([sell, unwrap])`.
 *
 * FOUR calls, or three when nothing is supplied (L4 corrects Revision 2's
 * "three calls"): `buildPancakeV3Sell` contributes three of them by itself.
 * §6.2's browser recovery batch is THIS shape, built with viem from a browser
 * read of B and signed by the passkey — no server, no session, no plane — and
 * it carries the same POOL-SHORT partial (R3.12) so the no-lock-in property
 * §6.2 advertises survives a utilized pool.
 */
export function buildLendingRetireBatch(
  input: RetireBatchInput,
): readonly WalletCall[] {
  if (input.swapInWei <= 0n) {
    throw new Error(
      "buildLendingRetireBatch: there is nothing to retire; the route refuses before reaching a builder.",
    );
  }
  const calls: WalletCall[] = [];
  if (input.redeemAmountWei > 0n) {
    calls.push(buildVUsdtRedeemUnderlying(input.venue.vUsdt, input.redeemAmountWei));
  }
  calls.push(
    ...buildPancakeV3Sell({
      router: input.venue.routerV3,
      wbnb: input.venue.wbnb,
      token: input.venue.usdt,
      amountInWei: input.swapInWei,
      minOutWei: input.minOutWei,
      recipient: getAddress(input.wallet),
      deadline: input.deadline,
      route: { hops: [], fees: [input.venue.swapFeeTier] },
    }),
  );
  return calls;
}

/**
 * Venus calldata builders — the ONLY place a Venus money call is constructed
 * (PHASE4-SPEC D1, R2.1(2), R2.16/R25, R2.16/R29).
 *
 * ═══ THE FORBIDDEN SENTINEL ════════════════════════════════════════════════
 *
 * `2^256-1` full-repay is FORBIDDEN on the ERC-20 path: the on-chain cap meter
 * cannot price it — `GuardedExecutor` meters an `approve` at its argument, so a
 * max approve exhausts any finite cap in one call and re-creates the trapped
 * exit this repo has now removed twice. Always an exact amount; interest dust
 * left behind is accepted and reported.
 *
 * On vBNB the prohibition is VACUOUS and the test obligation must not go
 * looking for a case that cannot exist (R2.16/R29): the amount IS `msg.value`,
 * there is no `uint256` argument to put a sentinel in.
 *
 * ═══ EXACT-AMOUNT APPROVE, AND THE ZERO-FIRST RULE ════════════════════════
 *
 * `approve` is emitted for the EXACT amount, never `type(uint256).max`. When a
 * residual allowance already exists — a failed repay leg after its approve, or
 * a non-standard ERC-20 that refuses a non-zero → non-zero transition (R2.16/
 * R25) — the builder emits `approve(vToken, 0)` FIRST. Two consequences, both
 * intended: the non-standard token works, and a residual allowance from an
 * earlier failure cannot survive into the next submission unnoticed. The
 * residual is also surfaced on the owner view until it is zeroed, because an
 * ERC-20 allowance is not consumed by anything but a `transferFrom` and it
 * OUTLIVES the session's expiry.
 *
 * ═══ THE SPENDER IS HARDCODED HERE ════════════════════════════════════════
 *
 * Every `approve` in this module names the market's OWN vToken, resolved from
 * the reader's chain read, never from a request field. That is what the true
 * custody sentence means by "when this plane builds the calldata"; `CallRule`
 * cannot enforce it, and nothing in this file may be read as claiming it can.
 */
import { encodeFunctionData, getAddress, type Address } from "viem";
import type { WalletCall } from "../core/types.js";
import {
  VENUS_COMPTROLLER_ABI,
  VENUS_ERC20_ABI,
  VENUS_PRIME_ABI,
  VENUS_VBEP20_WRITE_ABI,
  VENUS_VBNB_WRITE_ABI,
} from "./abis.js";

/** `type(uint256).max`. Named so the refusal below reads as a decision. */
export const UINT256_MAX = 2n ** 256n - 1n;

export type VenusRepayCallInput = {
  readonly vToken: Address;
  /** `null` ⇒ the native market; the amount rides as `msg.value`. */
  readonly underlying: Address | null;
  readonly amountWei: bigint;
  /** The wallet's CURRENT allowance to this vToken. `0n` for native. */
  readonly currentAllowanceWei: bigint;
};

function assertExactAmount(amountWei: bigint, action: string): void {
  if (amountWei <= 0n) {
    throw new Error(`${action}: the amount must be positive.`);
  }
  if (amountWei >= UINT256_MAX) {
    throw new Error(
      `${action}: the 2^256-1 sentinel is FORBIDDEN — the on-chain cap meter cannot ` +
        "price it, and a max approve exhausts any finite per-token cap in one call. " +
        "Submit an exact amount; interest dust is accepted and reported.",
    );
  }
}

/** The approve legs a token spend needs, zero-first when a residual exists. */
function approveLegs(
  token: Address,
  spender: Address,
  amountWei: bigint,
  currentAllowanceWei: bigint,
): WalletCall[] {
  const legs: WalletCall[] = [];
  if (currentAllowanceWei > 0n) {
    legs.push({
      to: token,
      data: encodeFunctionData({
        abi: VENUS_ERC20_ABI,
        functionName: "approve",
        args: [spender, 0n],
      }),
    });
  }
  legs.push({
    to: token,
    data: encodeFunctionData({
      abi: VENUS_ERC20_ABI,
      functionName: "approve",
      args: [spender, amountWei],
    }),
  });
  return legs;
}

/**
 * `repayBorrow` — payable on vBNB, `approve` + `repayBorrow(uint256)` on an
 * ERC-20 market.
 */
export function buildVenusRepayCalls(
  input: VenusRepayCallInput,
): readonly WalletCall[] {
  assertExactAmount(input.amountWei, "venusRepay");
  const vToken = getAddress(input.vToken);
  if (input.underlying === null) {
    return [
      {
        to: vToken,
        value: input.amountWei,
        data: encodeFunctionData({
          abi: VENUS_VBNB_WRITE_ABI,
          functionName: "repayBorrow",
        }),
      },
    ];
  }
  const token = getAddress(input.underlying);
  return [
    ...approveLegs(token, vToken, input.amountWei, input.currentAllowanceWei),
    {
      to: vToken,
      data: encodeFunctionData({
        abi: VENUS_VBEP20_WRITE_ABI,
        functionName: "repayBorrow",
        args: [input.amountWei],
      }),
    },
  ];
}

/**
 * `approve` + `mint(uint256)` — ERC-20 markets ONLY.
 *
 * REVISION 4 (FINDINGS (at)): the native branch is not deleted-by-discipline
 * but UNREPRESENTABLE — `underlying` is a non-null {@link Address}, so a
 * native mint cannot be built at compile time. vBNB's `mint()` minted a
 * position an EIP-7702 wallet cannot redeem (the 2300-gas `.transfer()`
 * payout), and the guard walked into it live ((as-2), 0.001425 BNB). The
 * supply alternative for BNB exposure is vWBNB
 * (`0x6bCa74586218db34cDB402295796b79663d816e9`), an ordinary ERC-20 market.
 */
export type VenusSupplyCallInput = {
  readonly vToken: Address;
  /** NON-NULL by type: the native market cannot reach this builder. */
  readonly underlying: Address;
  readonly amountWei: bigint;
  readonly currentAllowanceWei: bigint;
};

export function buildVenusSupplyCalls(
  input: VenusSupplyCallInput,
): readonly WalletCall[] {
  assertExactAmount(input.amountWei, "venusSupply");
  const vToken = getAddress(input.vToken);
  const token = getAddress(input.underlying);
  return [
    ...approveLegs(token, vToken, input.amountWei, input.currentAllowanceWei),
    {
      to: vToken,
      data: encodeFunctionData({
        abi: VENUS_VBEP20_WRITE_ABI,
        functionName: "mint",
        args: [input.amountWei],
      }),
    },
  ];
}

/**
 * `claimVenus(holder, vTokens)`.
 *
 * The `holder` is an ARGUMENT, so a leaked session key CAN aim this at a third
 * party's address — and it still cannot move the OWNER's rewards away from the
 * owner, because the payment follows the NAMED HOLDER's own accrual. The
 * residual is relay-fee griefing, and that is the true sentence (R2.15/R19d).
 */
export function buildVenusClaimVenusCall(
  comptroller: Address,
  holder: Address,
  vTokens: readonly Address[],
): readonly WalletCall[] {
  if (vTokens.length === 0) {
    throw new Error("venusClaim: the market list must not be empty.");
  }
  return [
    {
      to: getAddress(comptroller),
      data: encodeFunctionData({
        abi: VENUS_COMPTROLLER_ABI,
        functionName: "claimVenus",
        args: [getAddress(holder), vTokens.map((entry) => getAddress(entry))],
      }),
    },
  ];
}

/** `claimInterest(vToken, user)` on Prime. Same holder argument, same residual. */
export function buildVenusClaimInterestCall(
  prime: Address,
  vToken: Address,
  user: Address,
): readonly WalletCall[] {
  return [
    {
      to: getAddress(prime),
      data: encodeFunctionData({
        abi: VENUS_PRIME_ABI,
        functionName: "claimInterest",
        args: [getAddress(vToken), getAddress(user)],
      }),
    },
  ];
}

/**
 * `approve(spender, 0)` on its own — the residual-allowance sweep the owner
 * view points at when a failed leg left an allowance standing.
 */
export function buildVenusZeroApproveCall(
  token: Address,
  spender: Address,
): readonly WalletCall[] {
  return [
    {
      to: getAddress(token),
      data: encodeFunctionData({
        abi: VENUS_ERC20_ABI,
        functionName: "approve",
        args: [getAddress(spender), 0n],
      }),
    },
  ];
}

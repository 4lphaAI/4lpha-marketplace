/**
 * Withdraw arithmetic and destination validation. Pure, bigint, no SDK, no DOM.
 *
 * Separated from `client.ts` because these are the two things that can lose a
 * user's money without any chain error: withdrawing so much that B can never
 * pay for its own next action, and sending to an address that cannot receive.
 */

import { getAddress, isAddress, parseEther, parseUnits, type Address } from "viem";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * How much native BNB a withdrawal must LEAVE BEHIND in wallet B, in TWO TIERS.
 *
 * The reserve exists so B can still pay for its own next action. What that
 * costs depends on ONE fact: whether B has been registered on chain yet.
 *
 *   FIRST_ACTION_RESERVE_WEI = 0.0015 BNB — B has NO CODE. Its first admin
 *   action carries the EIP-7702 `setCode` preCall AND the KeyStore
 *   `initialRegisterKey`, measured at ~0.001 BNB (1e15) for a grant. Plus the
 *   relay submit floor of 3 x 3.88e13 = 1.164e14 gives 1.1164e15, rounded up to
 *   1.5e15 for ~34% headroom against a gas-price spike.
 *
 *   STEADY_RESERVE_WEI = 0.0002 BNB — B HAS CODE. Only the relay submission is
 *   left: 3.88e13 measured over 10 real mainnet submissions (memory:
 *   lp-relay-fee-measured-mainnet), so 2e14 is ~5x it. The operator asked for
 *   0.00015 (~3.9x); 0.0002 is the same order with more room for a spike, and
 *   the difference is 5e-5 BNB of dust either way.
 *
 * Deliberately conservative in ONE direction: too large only strands dust in a
 * wallet the user still controls, while too small strands the WALLET — B with
 * no native cannot pay for the action that would empty it. That asymmetry is
 * why an UNKNOWN registration state resolves to the FIRST_ACTION tier, never
 * the steady one. Neither number has been measured by a live withdrawal.
 */
export const FIRST_ACTION_RESERVE_WEI = 1_500_000_000_000_000n;
export const STEADY_RESERVE_WEI = 200_000_000_000_000n;

/** The reserves as they are written in the UI. One decimal form, one place. */
export const FIRST_ACTION_RESERVE_BNB = "0.0015";
export const STEADY_RESERVE_BNB = "0.0002";

/**
 * Which tier applies. `registered` is whether B already has code on chain;
 * `undefined` or `null` means the read did not answer, which takes the larger
 * reserve.
 */
export type WithdrawTier = { readonly registered?: boolean | null };

export function withdrawReserveWei(tier?: WithdrawTier): bigint {
  return tier?.registered === true ? STEADY_RESERVE_WEI : FIRST_ACTION_RESERVE_WEI;
}

export function withdrawReserveBnb(tier?: WithdrawTier): string {
  return tier?.registered === true ? STEADY_RESERVE_BNB : FIRST_ACTION_RESERVE_BNB;
}

/** How the reserve is described beside the amount field, tier included. */
export function withdrawReserveNote(tier?: WithdrawTier): string {
  return tier?.registered === true
    ? `keeps ${STEADY_RESERVE_BNB} BNB for network fees`
    : `keeps ${FIRST_ACTION_RESERVE_BNB} BNB for the first-time network fee`;
}

/**
 * The most that can be withdrawn from a given liquid balance.
 *
 * Never negative: a balance at or under the reserve yields zero, which the
 * caller renders as "not enough to withdraw" rather than as a max of "-0.001".
 */
export function maxWithdrawWei(availableWei: bigint, tier?: WithdrawTier): bigint {
  const max = availableWei - withdrawReserveWei(tier);
  return max > 0n ? max : 0n;
}

export function canWithdraw(availableWei: bigint, tier?: WithdrawTier): boolean {
  return maxWithdrawWei(availableWei, tier) > 0n;
}

/** Wei → a plain decimal string, no exponent, trailing zeros trimmed. */
export function formatBnb(wei: bigint, decimals = 6): string {
  const negative = wei < 0n;
  const absolute = negative ? -wei : wei;
  const whole = absolute / 10n ** 18n;
  const fraction = (absolute % 10n ** 18n).toString().padStart(18, "0").slice(0, decimals);
  const trimmed = fraction.replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${trimmed === "" ? "" : `.${trimmed}`}`;
}

export type Validation<T> = { readonly value: T } | { readonly error: string };

/**
 * The destination of a withdrawal.
 *
 * Two refusals, both about burning funds rather than about taste:
 *
 *   - the zero address burns them outright;
 *   - `ownerAddress` — the passkey-DERIVED identity — is a keccak of a P256
 *     public key with no key behind it on any curve. Nothing can ever spend
 *     from it. It is the single most plausible wrong answer here, because it is
 *     the address the account screen shows next to the word "owner", so it is
 *     refused by name (D4/D6).
 *
 * Wallet B itself is allowed: a self-send is pointless but not destructive, and
 * the caller warns instead of refusing.
 */
export function validateDestination(input: {
  readonly to: string;
  readonly passkeyOwnerAddress?: string;
  readonly walletAddress?: string;
}): Validation<Address> {
  const raw = input.to.trim();
  if (raw === "") return { error: "Enter the address to withdraw to." };
  if (!isAddress(raw, { strict: false })) return { error: "That is not a valid BNB Chain address." };
  const to = getAddress(raw);
  if (to === ZERO_ADDRESS) return { error: "The zero address burns funds. Enter a real destination." };
  if (input.passkeyOwnerAddress && to === getAddress(input.passkeyOwnerAddress)) {
    return {
      error:
        "That is your owner identity, not an account. It is derived from your passkey, holds no key, " +
        "and anything sent there is unrecoverable. Use your own wallet address instead.",
    };
  }
  return { value: to };
}

/** Parses an amount and bounds it by the max, so one call answers both. */
export function validateAmount(input: {
  readonly raw: string;
  readonly availableWei: bigint;
  /** The tier the caller sized the field on; the same one is enforced here. */
  readonly registered?: boolean | null;
}): Validation<bigint> {
  const trimmed = input.raw.trim();
  if (trimmed === "") return { error: "Enter an amount in BNB." };
  if (!/^\d{1,12}(\.\d{1,18})?$/u.test(trimmed)) {
    return { error: "Enter an amount in BNB, digits and one decimal point." };
  }
  const wei = parseEther(trimmed);
  if (wei <= 0n) return { error: "Enter an amount greater than zero." };
  const max = maxWithdrawWei(input.availableWei, input);
  if (max === 0n) {
    return {
      error: `This wallet holds less than the ${withdrawReserveBnb(input)} BNB kept back for network fees, so there is nothing to withdraw.`,
    };
  }
  if (wei > max) {
    return {
      error: `The most you can withdraw is ${formatBnb(max)} BNB, keeping ${withdrawReserveBnb(input)} BNB for network fees.`,
    };
  }
  return { value: wei };
}

/**
 * One relay submission, measured over 10 real mainnet submissions
 * (memory: `lp-relay-fee-measured-mainnet`).
 */
export const MEASURED_RELAY_FEE_WEI = 38_800_000_000_000n;

/**
 * What a TOKEN withdrawal actually requires in BNB — and why it is NOT the
 * reserve above.
 *
 * The reserve answers "will B still be able to act AFTER this?", which is the
 * right question when the thing leaving is the BNB itself. A token transfer
 * asks something narrower: "can B pay for THIS submission, right now?" The
 * token is not gas, so nothing about the wallet's future is at stake — and
 * charging the standing reserve here strands the token instead.
 *
 * MEASURED, not guessed: this bit the operator on 2026-09-03. A wallet holding
 * 0.00015538 BNB — four relay submissions' worth — was refused a BTCB transfer
 * because 0.00015538 < the 0.0002 reserve, with the BTCB stranded behind a rule
 * about a future the wallet no longer had (its agent was revoked).
 *
 * 3x the measured fee. An UNREGISTERED wallet keeps the first-action reserve:
 * its first submission still carries the EIP-7702 `setCode` preCall and the
 * KeyStore registration, and that really does cost ~0.001 BNB.
 */
export const TOKEN_WITHDRAW_FEE_FLOOR_WEI = 3n * MEASURED_RELAY_FEE_WEI;

export function tokenWithdrawFeeFloorWei(tier?: WithdrawTier): bigint {
  return tier?.registered === true ? TOKEN_WITHDRAW_FEE_FLOOR_WEI : FIRST_ACTION_RESERVE_WEI;
}

/** An atomic balance as a plain decimal string, no exponent, trailing zeros trimmed. */
export function formatAtomic(value: bigint, decimals: number, places = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return value.toString(10);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = absolute / unit;
  const fraction = (absolute % unit).toString().padStart(decimals, "0").slice(0, places);
  const trimmed = fraction.replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${trimmed === "" ? "" : `.${trimmed}`}`;
}

/**
 * The most of ONE ERC-20 that can leave the wallet.
 *
 * The token itself is not what pays the relay — BNB is — so the whole token
 * balance is withdrawable, and the NATIVE balance only has to clear the same
 * reserve a native withdrawal leaves behind. Both are checked: a wallet holding
 * a token and no BNB cannot pay for the action that would free it, and offering
 * a max it must then refuse is how a user learns to distrust the number.
 */
export function maxTokenWithdrawAtomic(input: {
  readonly balanceAtomic: bigint;
  readonly nativeWei: bigint;
  readonly registered?: boolean | null;
}): bigint {
  if (input.nativeWei < tokenWithdrawFeeFloorWei(input)) return 0n;
  return input.balanceAtomic > 0n ? input.balanceAtomic : 0n;
}

/**
 * How much BNB must be added before a token can move, and `0n` when none must.
 * Named so the UI can tell the owner what to deposit instead of greying a
 * button and leaving them to guess.
 */
export function tokenWithdrawShortfallWei(input: {
  readonly nativeWei: bigint;
  readonly registered?: boolean | null;
}): bigint {
  const floor = tokenWithdrawFeeFloorWei(input);
  return input.nativeWei >= floor ? 0n : floor - input.nativeWei;
}

/** Parses a token amount in display units and bounds it by the balance. */
export function validateTokenAmount(input: {
  readonly raw: string;
  readonly balanceAtomic: bigint;
  readonly decimals: number;
  readonly symbol: string;
  readonly nativeWei: bigint;
  readonly registered?: boolean | null;
}): Validation<bigint> {
  const trimmed = input.raw.trim();
  if (trimmed === "") return { error: `Enter an amount in ${input.symbol}.` };
  if (!/^\d{1,12}(\.\d{1,18})?$/u.test(trimmed)) {
    return { error: `Enter an amount in ${input.symbol}, digits and one decimal point.` };
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 36) {
    return { error: `The number of decimals for ${input.symbol} is unknown, so an amount cannot be checked.` };
  }
  const decimalPlaces = trimmed.split(".")[1]?.length ?? 0;
  if (decimalPlaces > input.decimals) {
    return { error: `${input.symbol} has ${input.decimals} decimals; that amount is more precise than the token can express.` };
  }
  const atomic = parseUnits(trimmed, input.decimals);
  if (atomic <= 0n) return { error: "Enter an amount greater than zero." };
  const shortfall = tokenWithdrawShortfallWei(input);
  if (shortfall > 0n) {
    return {
      error: `Sending ${input.symbol} still costs a network fee in BNB. This wallet holds ${formatBnb(input.nativeWei, 8)} BNB and needs ${formatBnb(tokenWithdrawFeeFloorWei(input), 8)}; deposit ${formatBnb(shortfall, 8)} BNB and try again.`,
    };
  }
  if (input.balanceAtomic <= 0n) return { error: `This wallet holds no ${input.symbol}.` };
  if (atomic > input.balanceAtomic) {
    return { error: `The most you can withdraw is ${formatAtomic(input.balanceAtomic, input.decimals)} ${input.symbol}.` };
  }
  return { value: atomic };
}

/**
 * Sizing a withdrawal that is paid out of WBNB rather than native.
 *
 * The exit sagas leave WBNB in wallet B (FINDINGS (ag): a stop or a manual exit
 * returns native PLUS the quote asset), and nothing in the product converted it
 * back. The unwrap batch — `WBNB.withdraw(amount)` then a plain transfer of the
 * same amount — spends the WBNB in full, so the amount is bounded by the WBNB
 * balance alone; the NATIVE balance only has to cover the relay fee, which is
 * exactly the reserve. Both are checked, because a wallet with WBNB and no
 * native cannot pay for the action that would free it.
 */
export function maxWbnbWithdrawWei(input: {
  readonly wbnbWei: bigint;
  readonly nativeWei: bigint;
  readonly registered?: boolean | null;
}): bigint {
  return maxTokenWithdrawAtomic({ ...input, balanceAtomic: input.wbnbWei });
}

export function validateWbnbAmount(input: {
  readonly raw: string;
  readonly wbnbWei: bigint;
  readonly nativeWei: bigint;
  readonly registered?: boolean | null;
}): Validation<bigint> {
  return validateTokenAmount({ ...input, balanceAtomic: input.wbnbWei, decimals: 18, symbol: "WBNB" });
}

/**
 * The address of a token to withdraw by hand.
 *
 * Separate from {@link validateDestination} because the refusals are different:
 * a destination must be able to RECEIVE, a token address must be a CONTRACT the
 * wallet holds a balance in. Only the two mistakes that cannot produce anything
 * useful are refused here — a malformed address and the zero address — and the
 * rest is left to the on-chain read, which either answers or does not.
 */
export function parseTokenAddress(raw: string): Validation<Address> {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Paste the token's contract address." };
  if (!isAddress(trimmed, { strict: false })) return { error: "That is not a valid BNB Chain address." };
  const address = getAddress(trimmed);
  if (address === ZERO_ADDRESS) return { error: "The zero address is not a token." };
  return { value: address };
}

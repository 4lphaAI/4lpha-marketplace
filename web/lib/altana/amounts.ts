/**
 * Quick-amount arithmetic for the funds modal. Pure, bigint, no DOM, no hooks.
 *
 * The one thing this file exists to prevent: a "Max" button that offers the
 * whole balance and then fails in the wallet, or — worse on a deposit — succeeds
 * and leaves the connected wallet with no gas at all. A native transfer is paid
 * OUT OF THE SAME BALANCE it moves, so the max sendable amount is the balance
 * MINUS the fee, never the balance.
 *
 * The withdraw side has its own, tiered reserve (`withdrawReserveWei`):
 * wallet B pays for its own relay submission and must survive it. This file
 * covers the deposit side, where wallet A pays ordinary BSC gas.
 */

/** A plain native transfer costs exactly this much gas on BSC. */
export const NATIVE_TRANSFER_GAS = 21_000n;

/**
 * Safety margin on the estimated fee, in basis points.
 *
 * The fee is estimated from the gas price at render time and the transaction is
 * signed seconds later, so 20% absorbs an ordinary price move. It only costs the
 * user precision on a max deposit; being short costs them a failed transaction.
 */
export const DEPOSIT_FEE_MARGIN_BPS = 2_000n;

/** The gas cost of a native transfer, with the margin applied. */
export function transferFeeWei(input: {
  readonly gasPriceWei: bigint;
  readonly gasLimit?: bigint;
  readonly marginBps?: bigint;
}): bigint {
  const gasPrice = input.gasPriceWei > 0n ? input.gasPriceWei : 0n;
  const limit = input.gasLimit ?? NATIVE_TRANSFER_GAS;
  const margin = input.marginBps ?? DEPOSIT_FEE_MARGIN_BPS;
  return (gasPrice * limit * (10_000n + margin)) / 10_000n;
}

/**
 * The most that can be deposited out of a balance that must also pay the fee.
 *
 * Never negative: a balance below the fee yields zero, which the caller renders
 * as a disabled control with a reason rather than as a negative max.
 */
export function maxDepositWei(input: {
  readonly balanceWei: bigint;
  readonly gasPriceWei: bigint;
  readonly gasLimit?: bigint;
  readonly marginBps?: bigint;
}): bigint {
  const max = input.balanceWei - transferFeeWei(input);
  return max > 0n ? max : 0n;
}

/** Half of a max, rounded down. Zero stays zero; a negative input cannot occur. */
export function halfOfWei(max: bigint): bigint {
  return max > 0n ? max / 2n : 0n;
}

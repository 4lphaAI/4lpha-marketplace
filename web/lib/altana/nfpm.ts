/**
 * What a V3 position is worth if you pull it out right now, and the floors that
 * makes safe. Pure bigint, no SDK, no DOM — the same shape as `withdraw.ts`,
 * and for the same reason: this arithmetic decides how much money comes back.
 *
 * WHY THE BROWSER NEEDS THIS AT ALL. Closing a position is normally the plane's
 * job, through the session. But a session dies with a revoke, and the plane's
 * own bookkeeping can disagree with the chain — measured on 2026-09-03, when an
 * abandon closed a row for NFT 7316794 while that NFT still held
 * 198529011719679442645 of liquidity. Under EIP-7702 the NFT sits in the
 * owner's own wallet, so the passkey can always empty it; what it needs is the
 * amounts, so it can refuse a batch that would return far less than the
 * position is worth.
 */

import { getSqrtRatioAtTick } from "@/lib/exec/pairs";

const Q96 = 2n ** 96n;

/** `type(uint128).max` — collect everything, the standard NFPM idiom. */
export const UINT128_MAX = (1n << 128n) - 1n;

/**
 * The slippage a close is allowed to give up, in basis points.
 *
 * 100 = 1%, the same bound the plane's own sagas run under
 * (`LP_MAX_SAGA_SLIPPAGE_BPS`). It is not a preference: the floors below are
 * computed from the pool's CURRENT price, and the price can move between the
 * read and the block that executes.
 */
export const CLOSE_SLIPPAGE_BPS = 100n;

export type PositionAmounts = { readonly amount0: bigint; readonly amount1: bigint };

/**
 * How much of each leg a full withdrawal returns at a given price.
 *
 * The three standard V3 cases, rounded DOWN in every division so the answer is
 * a lower bound on what the pool will pay — which is the safe direction for a
 * floor. Above the range the position is entirely token1, below it entirely
 * token0, and inside it holds both.
 */
export function positionAmounts(input: {
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
}): PositionAmounts {
  const { liquidity } = input;
  if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };
  const lower = getSqrtRatioAtTick(input.tickLower);
  const upper = getSqrtRatioAtTick(input.tickUpper);
  if (lower <= 0n || upper <= lower) return { amount0: 0n, amount1: 0n };
  const price = input.sqrtPriceX96;

  if (price <= lower) {
    return { amount0: (liquidity * (upper - lower) * Q96) / (lower * upper), amount1: 0n };
  }
  if (price >= upper) {
    return { amount0: 0n, amount1: (liquidity * (upper - lower)) / Q96 };
  }
  return {
    amount0: (liquidity * (upper - price) * Q96) / (price * upper),
    amount1: (liquidity * (price - lower)) / Q96,
  };
}

/**
 * The `amount0Min`/`amount1Min` to submit with a full `decreaseLiquidity`.
 *
 * Deliberately NOT zero. A zero floor lets any price the block happens to carry
 * settle the withdrawal, which on a manipulated pool means taking the whole
 * position out at the worst point of its own range. One percent off the price
 * we just read keeps the batch honest and still leaves room for ordinary
 * movement between the read and the block.
 */
export function closeMinimums(
  amounts: PositionAmounts,
  slippageBps: bigint = CLOSE_SLIPPAGE_BPS,
): PositionAmounts {
  const keep = 10_000n - slippageBps;
  return {
    amount0: (amounts.amount0 * keep) / 10_000n,
    amount1: (amounts.amount1 * keep) / 10_000n,
  };
}

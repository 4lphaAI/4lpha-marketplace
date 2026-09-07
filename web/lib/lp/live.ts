import { formatAtomic } from "@/lib/exec/pairs";
import { feeUsd } from "@/lib/lp/fees";
import type { DetailMetric } from "@/lib/exec/agent-detail";
import type { OnChainPosition } from "@/lib/altana/position-reader";

/**
 * The page's own reading of a position, computed from the NFT snapshot the
 * browser already pins to one block.
 *
 * WHY IT EXISTS (operator, 2026-09-06): the plane's valuation is written by the
 * LP worker once a cycle, and only after the arm's sequence has finished, so a
 * fresh position shows nothing for a minute or more — and shows nothing at all
 * while a sequence is parked. These figures fill that gap from evidence the
 * page holds anyway.
 *
 * WHAT IT IS NOT: the plane's `exitValueWei` is an EXIT quote through QuoterV2
 * with the pool fee deducted; this is the pool's mid price. The two differ by
 * roughly that fee, so every figure here says where it came from and neither
 * number is ever presented as the other.
 */
export type LiveRead = { readonly position: OnChainPosition; readonly discovered: boolean };

export type LivePricing = {
  readonly quoteIsToken0: boolean;
  readonly decimals0: number | null;
  readonly decimals1: number | null;
  readonly quoteMicros: bigint | null;
  readonly symbol0: string;
  readonly symbol1: string;
};

const legs = (read: OnChainPosition): { readonly amount0: bigint; readonly amount1: bigint } => ({
  amount0: read.amounts.amount0 + read.owed.amount0,
  amount1: read.amounts.amount1 + read.owed.amount1,
});

/** Shared guard: a snapshot without a price or decimals prices nothing. */
function priceable(read: OnChainPosition, pricing: LivePricing): boolean {
  return read.amountsAvailable && read.sqrtPriceX96 !== null
    && pricing.decimals0 !== null && pricing.decimals1 !== null && pricing.quoteMicros !== null;
}

function usd(amount0: bigint, amount1: bigint, read: OnChainPosition, pricing: LivePricing): string {
  // `feeUsd` prices a pool-ordered pair at a tick; the pinned sqrt price is the
  // same evidence in the same snapshot, so it is used directly.
  const sqrt = read.sqrtPriceX96!;
  const q192 = 1n << 192n, squared = sqrt * sqrt;
  const quoteDecimals = pricing.quoteIsToken0 ? pricing.decimals0! : pricing.decimals1!;
  const denominator = (pricing.quoteIsToken0 ? squared : q192) * 10n ** BigInt(quoteDecimals) * 1_000_000n;
  const raw = (pricing.quoteIsToken0 ? amount0 * squared + amount1 * q192 : amount1 * q192 + amount0 * squared)
    * pricing.quoteMicros! * 100n;
  const magnitude = raw < 0n ? -raw : raw;
  const cents = (magnitude * 2n + denominator) / (denominator * 2n);
  return `${raw < 0n && cents > 0n ? "-" : ""}$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/** Principal plus uncollected fees, at the pool's own price, in this block. */
export function liveValueMetric(read: LiveRead | undefined, pricing: LivePricing): DetailMetric {
  if (read === undefined) return { value: null, reason: "position not read on chain yet" };
  const position = read.position;
  if (!priceable(position, pricing)) return { value: null, reason: "no fresh matching price for this position" };
  const { amount0, amount1 } = legs(position);
  return {
    value: usd(amount0, amount1, position, pricing),
    reason: null,
    note: `principal + uncollected fees at the pool price · block ${position.blockNumber}`
      + (read.discovered ? " · on chain, not yet recorded by the agent" : ""),
  };
}

/** The same reading, minus the budget the owner armed the agent with. */
export function livePnlMetric(read: LiveRead | undefined, pricing: LivePricing, budgetWei: string | null, wbnbUsdMicros: bigint | null): DetailMetric {
  const value = liveValueMetric(read, pricing);
  if (value.value === null) return value;
  if (budgetWei === null || !/^(0|[1-9]\d*)$/u.test(budgetWei) || wbnbUsdMicros === null) {
    return { value: null, reason: "the armed budget cannot be priced yet" };
  }
  const budgetCents = (BigInt(budgetWei) * wbnbUsdMicros * 100n + 5n * 10n ** 23n) / 10n ** 24n;
  const valueCents = BigInt(value.value.replace(/[$,]/gu, "").replace(".", ""));
  const delta = valueCents - budgetCents;
  const magnitude = delta < 0n ? -delta : delta;
  return {
    value: `${delta < 0n ? "-" : ""}$${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`,
    reason: null,
    note: `at the pool price now, minus the armed budget · block ${read!.position.blockNumber}`,
  };
}

/** Uncollected fees only: what a collect would pay out right now. */
export function liveFeesMetric(read: LiveRead | undefined, pricing: LivePricing): DetailMetric {
  if (read === undefined) return { value: null, reason: "position not read on chain yet" };
  const position = read.position;
  const { amount0, amount1 } = position.owed;
  if (!priceable(position, pricing)) {
    if (pricing.decimals0 === null || pricing.decimals1 === null) return { value: null, reason: "token decimals unavailable" };
    return {
      value: null, reason: "no fresh matching price for this position",
      note: `${formatAtomic(amount0.toString(), pricing.decimals0, 6) ?? amount0} ${pricing.symbol0}`
        + ` + ${formatAtomic(amount1.toString(), pricing.decimals1, 6) ?? amount1} ${pricing.symbol1} uncollected`,
    };
  }
  return {
    value: usd(amount0, amount1, position, pricing),
    reason: null,
    note: `uncollected only · not yet compounded · block ${position.blockNumber}`,
  };
}

/** In range straight from the NFT's own bounds and the pool's own tick. */
export function liveInRange(read: LiveRead | undefined, currentTick: number | null): boolean | null {
  if (read === undefined || currentTick === null) return null;
  return currentTick >= read.position.tickLower && currentTick < read.position.tickUpper;
}

/**
 * The NFT to read for a row: the plane's recorded one, or — when the plane has
 * not recorded a tokenId yet — the single live NFT the wallet holds on this
 * pool. One candidate only: two would be a pairing guess, and this page never
 * guesses which NFT is the agent's.
 */
export function liveReadFor(input: {
  readonly tokenId: string | null;
  readonly chainReads: ReadonlyMap<string, { readonly kind: string }>;
  readonly discovered: readonly OnChainPosition[];
}): LiveRead | undefined {
  const live = input.discovered.filter(candidate => candidate.liquidity > 0n);
  const only = live.length === 1 ? live[0] : undefined;
  const recorded = input.tokenId === null ? undefined : (() => {
    const read = input.chainReads.get(input.tokenId!);
    return read !== undefined && read.kind === "position" ? read as unknown as OnChainPosition : undefined;
  })();
  // A rebalance withdraws the recorded NFT and mints a NEW one, and the plane
  // only repoints the row when its sequence finishes. Until then the recorded
  // NFT reads EMPTY while the owner's liquidity is very much alive in the new
  // one — so an emptied record yields to the wallet's single live NFT on this
  // pool, marked as not yet recorded.
  if (recorded !== undefined && recorded.liquidity > 0n) return { position: recorded, discovered: false };
  if (only !== undefined) return { position: only, discovered: true };
  return recorded === undefined ? undefined : { position: recorded, discovered: false };
}

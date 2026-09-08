import { formatAtomic } from "@/lib/exec/pairs";
import type { DetailMetric } from "@/lib/exec/agent-detail";

/**
 * What the agent wallet still holds of the pool's two legs, read on chain at
 * ONE pinned block.
 *
 * It is deliberately NOT derived from a sequence note: a residue note says what
 * one rebalance left behind, while the owner wants to know what is sitting in
 * the wallet right now. `unavailable` carries its reason so the tile can show a
 * dash with the reason instead of a zero that would read as "no dust".
 */
export type DustRead =
  | {
    readonly kind: "read";
    readonly token0Wei: bigint;
    readonly token1Wei: bigint;
    readonly blockNumber: bigint;
    readonly readAtMs: number;
  }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The hover text behind the tile's info icon. Plain language, no jargon. */
export const DUST_EXPLAINER =
  "Dust is the base and quote tokens left over in the agent wallet after a rebalance — "
  + "what a swapless re-range, a skipped conversion or a rounding remainder hands back. "
  + "It sits outside the position, so it earns no fees until the next rebalance picks it up. "
  + "Native BNB is not counted here: that is the gas reserve, not dust.";

/** Three decimals, as the operator asked — but a real balance never reads as "0". */
export function formatTokenAmount(wei: bigint, decimals: number): string {
  const magnitude = wei < 0n ? -wei : wei;
  const text = formatAtomic(magnitude.toString(), decimals, 3);
  if (text === null) return wei.toString();
  if (magnitude > 0n && text === "0") return wei < 0n ? ">-0.001" : "<0.001";
  return wei < 0n ? `-${text}` : text;
}

/** Both legs in POOL ORDER, three decimals each, nothing else. */
export function dustMetric(input: {
  readonly read: DustRead | undefined;
  readonly decimals0: number | null;
  readonly decimals1: number | null;
  readonly symbol0: string;
  readonly symbol1: string;
}): DetailMetric {
  const read = input.read;
  if (read === undefined) return { value: null, reason: "agent wallet not read yet" };
  if (read.kind === "unavailable") return { value: null, reason: read.reason };
  if (input.decimals0 === null || input.decimals1 === null) return { value: null, reason: "token decimals unavailable" };
  return {
    value: `${formatTokenAmount(read.token0Wei, input.decimals0)} ${input.symbol0} / ${formatTokenAmount(read.token1Wei, input.decimals1)} ${input.symbol1}`,
    reason: null,
  };
}

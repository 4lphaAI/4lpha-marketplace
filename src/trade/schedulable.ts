/** Plane-owned bStock capability and quote list for schedule hires. */
import { getAddress, type Address } from "viem";
import { admittedVenueRows } from "./rwa.js";
import type { PinnedCandidate } from "./universe.js";
import type { TradfiFlashQuote } from "./dataPlaneReads.js";
import type { TradfiQuote } from "./route.js";

export type SchedulableToken = {
  readonly address: Address;
  readonly symbol: string;
  readonly underlyingTicker: string | null;
  readonly platform: string | null;
  readonly quotedOutAtomic: string;
  readonly venue: "pancake_v2" | "pancake_v3" | "uniswap_v3" | "binance";
  readonly liquidityUsd: number | null;
};

export async function schedulableTokens(input: {
  readonly candidates: readonly PinnedCandidate[];
  readonly amountWei: bigint;
  readonly slippageBps: number;
  readonly buy: (candidate: PinnedCandidate) => Promise<TradfiQuote>;
  readonly flash?: (candidate: PinnedCandidate) => Promise<TradfiFlashQuote>;
  readonly guardVerified?: boolean;
  readonly guard?: Address;
  readonly signal?: AbortSignal;
}): Promise<readonly SchedulableToken[]> {
  const candidates = input.candidates.filter((candidate) => candidate.lane === "bstocks");
  const output = new Array<SchedulableToken | null>(candidates.length).fill(null);
  let next = 0;
  const visit = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const candidate = candidates[index];
      if (candidate === undefined) return;
      input.signal?.throwIfAborted();
      const direct = admittedVenueRows(candidate.venues).length > 0;
      try {
        if (direct) {
          const quote = await input.buy(candidate);
          output[index] = { address: candidate.address, symbol: candidate.symbol, underlyingTicker: candidate.underlyingTicker ?? null,
            platform: candidate.platform ?? null, quotedOutAtomic: quote.quotedOutAtomic.toString(10), venue: quote.venue,
            liquidityUsd: admittedVenueRows(candidate.venues)[0]?.liquidityUsd ?? null };
        } else if (input.flash !== undefined && input.guardVerified === true && input.guard !== undefined) {
          const quote = await input.flash(candidate);
          if (quote.observedAt > Date.now() || Date.now() - quote.observedAt > 30_000 || quote.expiresAt <= Date.now()
            || quote.amountInAtomic !== input.amountWei.toString(10) || BigInt(quote.quotedOutAtomic) <= 0n || BigInt(quote.minOutAtomic) <= 0n
            // LOW-4: the same taker/guard identity check the capability probe applies (index-server.ts).
            || getAddress(quote.taker) !== getAddress(input.guard)) continue;
          output[index] = { address: candidate.address, symbol: candidate.symbol, underlyingTicker: candidate.underlyingTicker ?? null,
            platform: candidate.platform ?? null, quotedOutAtomic: quote.quotedOutAtomic, venue: "binance", liquidityUsd: null };
        }
      } catch {
        // A token is listable only when the requested amount has a fresh quote.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, visit));
  return output.filter((token): token is SchedulableToken => token !== null);
}

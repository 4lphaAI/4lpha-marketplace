/** Read-only, bounded trade-position valuation for the owner detail page. */
import type { WalletProvider } from "../core/types.js";
import type { AgentRecord } from "../store/agents.js";
import type { TradePositionRecord } from "../store/tradePositions.js";
import { canonicalEncode } from "../auth/canonical.js";
import { pnlBps } from "./exits.js";
import { quoteSellAlongRoute, type RouteQuoteReader } from "./route.js";

export type TradeQuoteStatus = "quoted" | "unattributed" | "balance-gone" | "unavailable" | "closed";

export type TradePositionObservation = {
  readonly positionId: string;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly recordedPositionAmount: string | null;
  readonly liveWalletBalance: string | null;
  readonly currentQuoteWei: string | null;
  readonly pnlBps: string | null;
  readonly quoteStatus: TradeQuoteStatus;
  readonly reason: string | null;
  readonly observedAt: number;
};

export interface TradeDetailObserver {
  observe(agent: AgentRecord, positions: readonly TradePositionRecord[], signal?: AbortSignal): Promise<readonly TradePositionObservation[]>;
}

type Cached = { readonly expiresAt: number; readonly value: TradePositionObservation };
type TokenMeta = { readonly expiresAt: number; readonly symbol: string | null; readonly decimals: number };

export function createTradeDetailObserver(input: {
  readonly provider: Pick<WalletProvider, "getTokenBalance" | "getTokenMetadata">;
  readonly rpcUrls: readonly string[];
  readonly routeReader?: RouteQuoteReader;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}): TradeDetailObserver {
  const now = input.now ?? Date.now;
  const maxAgeMs = input.maxAgeMs ?? 5_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 5_000) {
    throw new Error("Trade detail observation maxAgeMs must be in 0..5000.");
  }
  const cache = new Map<string, Cached>();
  const metadata = new Map<string, TokenMeta>();

  async function tokenMeta(token: TradePositionRecord["token"], signal?: AbortSignal): Promise<{ symbol: string | null; decimals: number | null }> {
    const key = token.toLowerCase();
    const cached = metadata.get(key);
    if (cached !== undefined && cached.expiresAt >= now()) return cached;
    try {
      const value = await input.provider.getTokenMetadata?.({ token, ...(signal === undefined ? {} : { signal }) });
      if (value === undefined || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
        return { symbol: null, decimals: null };
      }
      const next = { symbol: value.symbol, decimals: value.decimals, expiresAt: now() + 60 * 60_000 };
      metadata.set(key, next);
      return next;
    } catch {
      signal?.throwIfAborted();
      return { symbol: null, decimals: null };
    }
  }

  return {
    async observe(agent, positions, signal) {
      const liveCount = new Map<string, number>();
      for (const position of positions) {
        if (position.status !== "closed") liveCount.set(position.token.toLowerCase(), (liveCount.get(position.token.toLowerCase()) ?? 0) + 1);
      }
      return Promise.all(positions.map(async (position): Promise<TradePositionObservation> => {
        const at = now();
        const identityKey = canonicalEncode({
          owner: agent.ownerAddress.toLowerCase(), agentId: agent.id, positionId: position.positionId,
          token: position.token.toLowerCase(), route: position.route,
          recordedAmount: position.tokenAmount?.toString(10) ?? null, status: position.status,
        });
        const meta = await tokenMeta(position.token, signal);
        const base = {
          positionId: position.positionId,
          symbol: meta.symbol,
          decimals: meta.decimals,
          recordedPositionAmount: position.tokenAmount?.toString(10) ?? null,
          observedAt: at,
        };
        let value: TradePositionObservation;
        if (position.status === "closed") {
          value = { ...base, liveWalletBalance: null, currentQuoteWei: null, pnlBps: null,
            quoteStatus: "closed", reason: "Position is closed." };
        } else {
          try {
            const balance = await input.provider.getTokenBalance({
              wallet: { address: agent.walletAddress, ownerAddress: agent.ownerAddress, custodyModel: agent.custodyModel, chainId: 56 },
              token: position.token,
              ...(signal === undefined ? {} : { signal }),
            });
            // Balance is always read fresh. Only the quote may be cached, and
            // its key includes that live balance so external wallet transfers
            // cannot reuse a valuation for different holdings.
            const cacheKey = `${identityKey}:${balance.toString(10)}`;
            const cached = cache.get(cacheKey);
            if (cached !== undefined && cached.expiresAt > at) return cached.value;
            if (balance === 0n) {
              value = { ...base, liveWalletBalance: "0", currentQuoteWei: null, pnlBps: null,
                quoteStatus: "balance-gone", reason: "The live token balance is zero." };
            } else if (position.fillStatus !== "verified" || position.tokenAmount === null
              || liveCount.get(position.token.toLowerCase()) !== 1 || balance !== position.tokenAmount) {
              value = { ...base, liveWalletBalance: balance.toString(10), currentQuoteWei: null, pnlBps: null,
                quoteStatus: "unattributed", reason: "The live wallet balance cannot be attributed to this whole position." };
            } else {
              const quote = await quoteSellAlongRoute({
                token: position.token,
                amountInWei: balance,
                venue: position.route.fees.length === 0 ? "pancake_v2" : "pancake_v3",
                route: position.route,
                rpcUrls: input.rpcUrls,
                ...(signal === undefined ? {} : { signal }),
                ...(input.routeReader === undefined ? {} : { reader: input.routeReader }),
              });
              value = { ...base, liveWalletBalance: balance.toString(10), currentQuoteWei: quote.toString(10),
                pnlBps: pnlBps(quote, position.entryWei)?.toString(10) ?? null,
                quoteStatus: "quoted", reason: null };
            }
          } catch {
            signal?.throwIfAborted();
            value = { ...base, liveWalletBalance: null, currentQuoteWei: null, pnlBps: null,
              quoteStatus: "unavailable", reason: "Live balance or sell quote is temporarily unavailable." };
          }
        }
        if (value.quoteStatus === "quoted") {
          const balanceKey = value.liveWalletBalance ?? "";
          cache.set(`${identityKey}:${balanceKey}`,
            { value, expiresAt: at + maxAgeMs });
        }
        return value;
      }));
    },
  };
}

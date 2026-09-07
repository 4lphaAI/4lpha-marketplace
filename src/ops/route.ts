/**
 * Caller-supplied routing: the shared vocabulary, and nothing else.
 *
 * PHASE2 declared that this service makes no market judgements. Which pool,
 * which fee tier, which intermediate token — all of that IS a market judgement,
 * so all of it arrives on the request exactly as `venue` already does. This
 * module holds only the constants and the type that the wire parser, the call
 * builders and the params hash must agree on; it contains no policy and no
 * search. Nothing here ever picks a route.
 *
 * The one-form rule (PHASE2.2 R7) is enforced by {@link normalizeRoute} and is
 * load-bearing for idempotency: `canonicalEncode` drops `undefined` properties
 * but encodes `[]` as `[]`, so an absent `route`, a `{}` and a `{ hops: [] }`
 * would otherwise be three different `paramsHash` values for one trade — and the
 * second attempt of a benign retry would 409 instead of replaying.
 */
import type { Address } from "viem";

/**
 * Most intermediate hops a route may name.
 *
 * Two, which covers the verified worst case — a graduated Four.Meme token whose
 * only liquidity is against a bStock quote token, i.e. `BNB → X → token`. It is
 * a named constant, and the packed-path length is derived from it, so raising
 * the ceiling later is a one-line change rather than a redesign.
 *
 * The live example that motivates it, verified 2026-08-11:
 * `0x964f8228821fb0669880732557f14289fc4affff` reads `liquidityAdded = true`
 * with `quote = 0xbe9d…03e1` (SPCXB) and has NO WBNB pair at all — its liquidity
 * is a V2 pair against SPCXB. It also has NO V3 pool at any tier, against either
 * token, so shipping `pancake_v3` does not unblock it: MULTI-HOP V2 is what
 * reaches it. The V3 venue exists for the two bStocks that have only V3 pools.
 */
export const MAX_ROUTE_HOPS = 2;

/** Most pools a route may cross. One more than the hop count, always. */
export const MAX_ROUTE_POOLS = MAX_ROUTE_HOPS + 1;

/**
 * The V3 fee tiers PancakeSwap deploys, in hundredths of a basis point.
 *
 * A CLOSED set, and there is deliberately no default: choosing a tier is
 * choosing a pool, which is routing. A request that omits it is a 400, never a
 * guess at 2500.
 */
export const V3_FEE_TIERS = [100, 500, 2500, 10_000] as const;
export type V3FeeTier = (typeof V3_FEE_TIERS)[number];

/**
 * A validated route, in the ONE orientation this codebase uses: always
 * `WBNB → …hops → token`, for both sides.
 *
 * A sell is the exact reverse of the buy — tokens AND fee tiers (PHASE2.2 R2) —
 * and the reversal happens in the builders, once, so a caller supplies the same
 * `route` for the buy and the sell of the same position.
 *
 * `fees` is empty on a V2 route (fee tiers are meaningless there) and carries
 * exactly `hops.length + 1` entries on a V3 one.
 */
export type TradeRoute = {
  readonly hops: readonly Address[];
  readonly fees: readonly V3FeeTier[];
};

/**
 * Collapse a parsed route to its single canonical form.
 *
 * Returns `undefined` — meaning "omit the property entirely" — for a route that
 * says nothing, so the three ways of spelling "no route" hash identically. Any
 * route that does say something is returned as a full `{ hops, fees }` record
 * with both arrays present, so there is no second spelling of that either.
 */
export function normalizeRoute(route: TradeRoute | undefined): TradeRoute | undefined {
  if (route === undefined) return undefined;
  if (route.hops.length === 0 && route.fees.length === 0) return undefined;
  return { hops: route.hops, fees: route.fees };
}

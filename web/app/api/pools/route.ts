import { NextRequest, NextResponse } from "next/server";
import { tokenIconMap, tokenIconUrl } from "@/lib/pools/token-icons";
import { poolAddressFor, WBNB_56 } from "@/lib/exec/pairs";

/**
 * BFF pool discovery for the grid deploy screen: data plane `/pools/top`
 * filtered to pools with a WBNB leg (grid v1 requires one), merged with token
 * icon URLs. Also serves a single pool by `?address=` via `/pools/:address`.
 *
 * `?address=` accepts EITHER a V3 pool address OR a TOKEN address: what a user
 * has to hand is the token they bought (a four.meme launch, say), and
 * `/pools/:address` answers 404 for one. A token is resolved by deriving the
 * deterministic PancakeSwap V3 pool address for each fee tier the grid can
 * run, then asking the data plane's read-through pool endpoint for each one.
 * This matters because `/pools/top` is deliberately a capped TVL ranking and
 * can omit a live, low-TVL pool that the owner explicitly pasted its token for.
 */
const DEFAULT_DATA_PLANE_URL = "https://data-plane-production.up.railway.app";
const WBNB = WBNB_56;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const GRID_FEE_TIERS = [100, 500, 2500, 10_000] as const;
type GridFeeTier = (typeof GRID_FEE_TIERS)[number];

type PoolStats = {
  pool: string;
  protocol?: string | null;
  token0: string;
  token1: string;
  token0Symbol: string | null;
  token1Symbol: string | null;
  fee: number | null;
  tick: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  lpFeeApr24h?: number | null;
  cakeFarmApr?: number | null;
  combinedApr: number | null;
  asOf?: number | null;
};

const MIN_LP_TVL_USD = "50000";
const MIN_LP_VOLUME_24H_USD = "10000";

function dataPlaneHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env["DATA_PLANE_TOKEN"]?.trim();
  if (token) headers["x-dp-token"] = token;
  return headers;
}

function baseUrl(): string {
  return (process.env["DATA_PLANE_URL"] ?? DEFAULT_DATA_PLANE_URL).replace(/\/$/u, "");
}

async function withIcons(pools: PoolStats[], staleness: unknown) {
  const icons = await tokenIconMap();
  return pools.map((pool) => ({
    ...pool,
    token0Icon: tokenIconUrl(icons, pool.token0),
    token1Icon: tokenIconUrl(icons, pool.token1),
    hasWbnbLeg:
      pool.token0.toLowerCase() === WBNB || pool.token1.toLowerCase() === WBNB,
    wbnbIsToken0: pool.token0.toLowerCase() === WBNB,
    staleness,
  }));
}

type PoolView = Awaited<ReturnType<typeof withIcons>>[number];

/** One read-through pool lookup. A missing fee candidate is an ordinary miss. */
async function readPool(address: string): Promise<PoolView | null> {
  try {
    const upstream = await fetch(`${baseUrl()}/pools/${address}`, {
      headers: dataPlaneHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) return null;
    const payload = (await upstream.json()) as {
      data?: PoolStats;
      meta?: { staleness?: unknown };
    };
    if (payload.data === undefined) return null;
    return (await withIcons([payload.data], payload.meta?.staleness ?? null))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a pasted token without consulting the capped ranking lane.
 *
 * The derived address is only a candidate. The data plane response is still
 * checked for the exact token, WBNB, V3 protocol, fee and address before it is
 * surfaced. That keeps a stale or inconsistent upstream row from becoming a
 * pool selection.
 */
async function resolveTokenPools(token: string): Promise<PoolView[]> {
  const candidates = GRID_FEE_TIERS
    .map((fee) => ({ fee, pool: poolAddressFor(token, WBNB, fee) }))
    .filter((entry): entry is { readonly fee: GridFeeTier; readonly pool: string } => entry.pool !== null);
  const resolved = await Promise.all(candidates.map(async ({ fee, pool }) => {
    const row = await readPool(pool);
    if (
      row === null
      || row.pool.toLowerCase() !== pool
      || row.protocol !== "v3"
      || row.fee !== fee
      || !row.hasWbnbLeg
      || (row.token0.toLowerCase() !== token && row.token1.toLowerCase() !== token)
    ) return null;
    return row;
  }));
  return resolved
    .filter((row): row is PoolView => row !== null)
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.searchParams.get("address");
  const rankBy = request.nextUrl.searchParams.get("rankBy");
  try {
    if (address !== null) {
      if (!ADDRESS_PATTERN.test(address)) {
        return NextResponse.json({ error: { code: "invalid_address" } }, { status: 400 });
      }
      const upstream = await fetch(`${baseUrl()}/pools/${address.toLowerCase()}`, {
        headers: dataPlaneHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await upstream.json()) as {
        data?: PoolStats;
        meta?: { staleness?: unknown };
        error?: unknown;
      };
      if (upstream.ok && payload.data) {
        if (payload.data.protocol !== "v3") {
          return NextResponse.json(
            { error: { code: "no_wbnb_v3_pool" } },
            { status: 404 },
          );
        }
        const [pool] = await withIcons([payload.data], payload.meta?.staleness ?? null);
        if (!pool.hasWbnbLeg) {
          return NextResponse.json(
            { error: { code: "no_wbnb_v3_pool" } },
            { status: 404 },
          );
        }
        return NextResponse.json(
          { data: pool, meta: { resolvedFrom: "pool" } },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      if (upstream.status !== 404) {
        return NextResponse.json(
          { error: { code: "pool_unavailable", status: upstream.status } },
          { status: 502 },
        );
      }

      // Not a pool address — derive the four fee-tier candidates instead of
      // asking the capped TVL ranking to find a pool it may intentionally omit.
      const directCandidates = await resolveTokenPools(address);
      const [directBest] = directCandidates;
      if (directBest !== undefined) {
        return NextResponse.json(
          { data: directBest, meta: { resolvedFrom: "token", candidates: directCandidates } },
          { headers: { "cache-control": "private, no-store" } },
        );
      }

      // Keep the ranking fallback for a future/non-standard fee tier already
      // present in the lane; deterministic probing covers the grid's supported
      // tiers without making selection depend on that lane.
      const tokenQuery = new URLSearchParams({
        token: address.toLowerCase(),
        orderBy: "tvlUsd",
        limit: "25",
      });
      const byToken = await fetch(`${baseUrl()}/pools/top?${tokenQuery}`, {
        headers: dataPlaneHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const tokenPayload = (await byToken.json()) as {
        data?: PoolStats[];
        meta?: { staleness?: unknown };
      };
      if (!byToken.ok || !Array.isArray(tokenPayload.data)) {
        return NextResponse.json(
          { error: { code: "pool_unavailable", status: byToken.status } },
          { status: 502 },
        );
      }
      const candidates = (await withIcons(tokenPayload.data, tokenPayload.meta?.staleness ?? null))
        .filter((entry) => entry.hasWbnbLeg && entry.protocol === "v3")
        .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
      const [best] = candidates;
      if (best === undefined) {
        return NextResponse.json(
          { error: { code: tokenPayload.data.length > 0 ? "no_wbnb_v3_pool" : "pool_unavailable" } },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { data: best, meta: { resolvedFrom: "token", candidates } },
        { headers: { "cache-control": "private, no-store" } },
      );
    }

    const query = new URLSearchParams(
      rankBy === "fee-apr" || rankBy === "volume"
        ? {
            orderBy: rankBy === "volume" ? "volume24hUsd" : "lpFeeApr24h",
            limit: "50",
            token: WBNB,
            minTvlUsd: MIN_LP_TVL_USD,
            minVolume24hUsd: MIN_LP_VOLUME_24H_USD,
          }
        : {
            orderBy: "tvlUsd",
            limit: "50",
            token: WBNB,
          },
    );
    const upstream = await fetch(`${baseUrl()}/pools/top?${query}`, {
      headers: dataPlaneHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await upstream.json()) as {
      data?: PoolStats[];
      meta?: { staleness?: unknown };
    };
    if (!upstream.ok || !Array.isArray(payload.data)) {
      return NextResponse.json(
        { error: { code: "pools_unavailable", status: upstream.status } },
        { status: 502 },
      );
    }
    const pools = (await withIcons(payload.data, payload.meta?.staleness ?? null))
      .filter((pool) => pool.hasWbnbLeg && pool.protocol === "v3");
    return NextResponse.json(
      { data: pools },
      { headers: { "cache-control": "private, max-age=30" } },
    );
  } catch {
    return NextResponse.json({ error: { code: "pools_unavailable" } }, { status: 502 });
  }
}

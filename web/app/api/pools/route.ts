import { NextRequest, NextResponse } from "next/server";
import { tokenIconMap, tokenIconUrl } from "@/lib/pools/token-icons";

/**
 * BFF pool discovery for the grid deploy screen: data plane `/pools/top`
 * filtered to pools with a WBNB leg (grid v1 requires one), merged with token
 * icon URLs. Also serves a single pool by `?address=` via `/pools/:address`.
 *
 * `?address=` accepts EITHER a V3 pool address OR a TOKEN address: what a user
 * has to hand is the token they bought (a four.meme launch, say), and
 * `/pools/:address` answers 404 for one. So a 404 falls back to
 * `/pools/top?token=`, keeps the V3 pools that have a WBNB leg, and returns
 * them ranked by TVL with `meta.resolvedFrom: "token"` — otherwise a live pair
 * reads as `pool_unavailable` when the pool is right there.
 */
const DEFAULT_DATA_PLANE_URL = "https://data-plane-production.up.railway.app";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;

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

      // Not a pool address — read it as a token address before refusing.
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

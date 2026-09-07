import { NextRequest, NextResponse } from "next/server";
import { TIMEFRAMES, type MarketResourceKind } from "@/lib/market-data";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const KINDS = new Set<MarketResourceKind>(["pool", "token"]);
const INTERVALS = new Set<string>(TIMEFRAMES);
const DEFAULT_DATA_PLANE_URL = "https://data-plane-production.up.railway.app";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const kind = request.nextUrl.searchParams.get("kind") ?? "pool";
  const address = request.nextUrl.searchParams.get("address")?.toLowerCase() ?? "";
  const interval = request.nextUrl.searchParams.get("interval") ?? "1m";
  const rawLimit = request.nextUrl.searchParams.get("limit") ?? "300";
  const limit = Number(rawLimit);

  if (!KINDS.has(kind as MarketResourceKind)) {
    return NextResponse.json({ error: { code: "invalid_kind" } }, { status: 400 });
  }
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: { code: "invalid_address" } }, { status: 400 });
  }
  if (!INTERVALS.has(interval)) {
    return NextResponse.json({ error: { code: "invalid_interval" } }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return NextResponse.json({ error: { code: "invalid_limit" } }, { status: 400 });
  }

  const baseUrl = (process.env["DATA_PLANE_URL"] ?? DEFAULT_DATA_PLANE_URL).replace(/\/$/u, "");
  const path = kind === "pool" ? `/pools/${address}/ohlcv` : `/klines/${address}`;
  const upstreamUrl = new URL(`${baseUrl}${path}`);
  upstreamUrl.searchParams.set("interval", interval);
  upstreamUrl.searchParams.set("limit", String(limit));

  const headers: Record<string, string> = { accept: "application/json" };
  const dataPlaneToken = process.env["DATA_PLANE_TOKEN"]?.trim();
  if (dataPlaneToken) headers["x-dp-token"] = dataPlaneToken;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await upstream.json()) as unknown;
    if (!upstream.ok) {
      return NextResponse.json(
        { error: { code: "market_data_unavailable", status: upstream.status } },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }
    return NextResponse.json(payload, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "market_data_unavailable" } },
      { status: 502 },
    );
  }
}

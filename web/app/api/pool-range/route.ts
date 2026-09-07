import { NextRequest, NextResponse } from "next/server";
import { reviewedRangePool, unavailableApr, validateRangeApr } from "@/lib/lp/pool-range";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = request.nextUrl.searchParams;
  const reply = (data: ReturnType<typeof unavailableApr>) => NextResponse.json({ data }, { headers: { "cache-control": "private, no-store" } });
  const address = q.get("address") ?? "";
  if (!/^0x[0-9a-f]{40}$/iu.test(address)) return reply(unavailableApr("invalid address"));
  const pool = reviewedRangePool(address);
  if (!pool) return reply(unavailableApr("pool not in the reviewed pair table"));
  const lower = Number(q.get("tickLower")), upper = Number(q.get("tickUpper")), capital = Number(q.get("capitalUsd"));
  if (!/^-?(0|[1-9]\d*)$/u.test(q.get("tickLower") ?? "") || !/^-?(0|[1-9]\d*)$/u.test(q.get("tickUpper") ?? "") || !Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)
    || lower >= upper || lower < -887272 || upper > 887272 || lower % pool.spacing !== 0 || upper % pool.spacing !== 0
    || !Number.isFinite(capital) || capital <= 0) return reply(unavailableApr("invalid range or capital"));
  const params = new URLSearchParams({ lower: String(1.0001 ** lower * 10 ** (pool.meta0.decimals - pool.meta1.decimals)),
    upper: String(1.0001 ** upper * 10 ** (pool.meta0.decimals - pool.meta1.decimals)), capital: String(capital) });
  const base = (process.env.DATA_PLANE_URL ?? "https://data-plane-production.up.railway.app").replace(/\/$/u, "");
  const token = process.env.DATA_PLANE_TOKEN?.trim();
  try {
    const response = await fetch(`${base}/pools/${pool.address}/range?${params}`, { cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json", ...(token ? { "x-dp-token": token } : {}) } });
    if (!response.ok) return reply(unavailableApr(`http ${response.status}`));
    let payload: unknown;
    try { payload = await response.json(); } catch { return reply(unavailableApr("invalid response")); }
    return reply(validateRangeApr(payload, { address, lower, upper, capital, fee: pool.fee, spacing: pool.spacing }, Date.now()));
  } catch { return reply(unavailableApr("http unavailable")); }
}

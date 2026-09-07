import { NextRequest, NextResponse } from "next/server";
import { execServiceRead } from "@/lib/exec/client";
import { INVALID, parseLendingQuote } from "@/lib/exec/lending-types";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DECIMAL = /^\d{1,78}$/u;

/**
 * `GET /api/lending/quote` — a QuoterV2 read through the plane, on the plane's
 * own rail.
 *
 * The recovery batch's `minOut` MUST come from here and never from a data-plane
 * price: a price is not a quote, and a recovery signed against a price is a swap
 * with no floor (R3.9 / L4). The plane restricts the pair to the pinned
 * WBNB/USDT pool; this route validates the shape before spending an upstream
 * call, and re-validates the answer before the browser can build a batch on it.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const headers = { "cache-control": "private, no-store" } as const;
  const q = request.nextUrl.searchParams;
  const tokenIn = q.get("tokenIn") ?? "";
  const tokenOut = q.get("tokenOut") ?? "";
  const amountInWei = q.get("amountInWei") ?? "";
  if (!ADDRESS.test(tokenIn) || !ADDRESS.test(tokenOut)) {
    return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400, headers });
  }
  if (!DECIMAL.test(amountInWei) || BigInt(amountInWei) <= 0n) {
    return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400, headers });
  }
  const query = new URLSearchParams({ tokenIn, tokenOut, amountInWei });
  try {
    const upstream = await execServiceRead(`/lending/quote?${query.toString()}`);
    if (upstream.status === 404) {
      return NextResponse.json({ error: { code: "lending_disabled" } }, { status: 404, headers });
    }
    if (upstream.status === 429) {
      return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers });
    }
    if (upstream.status !== 200) {
      return NextResponse.json({ error: { code: "quote_unavailable" } }, { status: 502, headers });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(upstream.body) as unknown;
    } catch {
      return NextResponse.json({ error: { code: "invalid_response" } }, { status: 502, headers });
    }
    const data = parseLendingQuote((payload as { data?: unknown } | null)?.data ?? payload);
    if (data === INVALID) {
      return NextResponse.json({ error: { code: "invalid_response" } }, { status: 502, headers });
    }
    return NextResponse.json({ data }, { headers });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502, headers });
  }
}

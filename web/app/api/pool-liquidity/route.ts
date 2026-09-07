import { NextRequest, NextResponse } from "next/server";
import { execServiceRead } from "@/lib/exec/client";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const WINDOW_PATTERN = /^\d{1,4}$/u;

/**
 * The pool's LIQUIDITY PROFILE around its current tick, from the execution
 * plane's own reader (`GET /lp/pools/:address/liquidity`) — the same source
 * `/api/pool-state` uses for the tick the owner is about to sign over, so the
 * chart and the range cannot disagree about where "now" is.
 *
 * Display data only: one bin per tick spacing, bigints as decimal strings,
 * pinned to one finalized block. The plane route takes only the exec token —
 * no owner signature — so the browser needs no wallet prompt to see it. An
 * upstream failure is forwarded as its own status; the form shows the reason
 * rather than an empty chart that would read as "no liquidity".
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: { code: "invalid_address" } }, { status: 400 });
  }
  const windowRaw = request.nextUrl.searchParams.get("window") ?? "60";
  if (!WINDOW_PATTERN.test(windowRaw) || Number(windowRaw) < 1 || Number(windowRaw) > 1000) {
    return NextResponse.json({ error: { code: "invalid_window" } }, { status: 400 });
  }
  try {
    const upstream = await execServiceRead(
      `/lp/pools/${address.toLowerCase()}/liquidity?window=${Number(windowRaw)}`,
    );
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

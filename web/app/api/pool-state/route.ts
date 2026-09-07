import { NextRequest, NextResponse } from "next/server";
import { execServiceRead } from "@/lib/exec/client";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;

/**
 * The pool's CURRENT TICK, from the execution plane's own reader.
 *
 * Deliberately not the data plane: its `/pools/top` lane rows carry
 * `tick: null` (the live slot0 path is short-circuited for any pool ON the
 * lane — exactly the top-TVL pools a grid wants), and more importantly the
 * arm route cross-checks the signed geometry against THIS reader. Deriving
 * the rungs from the same source the server validates against is what keeps a
 * signature from being refused for a tick nobody disagreed about.
 *
 * The plane route takes only the exec token — no owner signature — so the
 * browser needs no wallet prompt to see the tick it is about to sign over.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: { code: "invalid_address" } }, { status: 400 });
  }
  try {
    const upstream = await execServiceRead(`/lp/pools/${address.toLowerCase()}/state`);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

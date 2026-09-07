import { NextRequest, NextResponse } from "next/server";
import { tokenIconMap, tokenIconUrl } from "@/lib/pools/token-icons";

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const MAX_ADDRESSES = 8;

/**
 * Final image URLs for a bounded set of token addresses. The resolver is
 * server-only and already cached in memory, so this is a thin projection:
 * the browser never fetches a token list, and an unknown address answers
 * a fixed CDN lookup, with the client showing a symbol badge on an image miss.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const raw = request.nextUrl.searchParams.get("addresses") ?? "";
  const addresses = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (addresses.length === 0 || addresses.length > MAX_ADDRESSES || !addresses.every((entry) => ADDRESS.test(entry))) {
    return NextResponse.json({ error: { code: "invalid_addresses" } }, { status: 400 });
  }
  try {
    const icons = await tokenIconMap();
    const data: Record<string, string | null> = {};
    for (const address of addresses) {
      data[address.toLowerCase()] = tokenIconUrl(icons, address);
    }
    return NextResponse.json({ data }, { headers: { "cache-control": "private, max-age=600" } });
  } catch {
    return NextResponse.json({ error: { code: "icons_unavailable" } }, { status: 502 });
  }
}

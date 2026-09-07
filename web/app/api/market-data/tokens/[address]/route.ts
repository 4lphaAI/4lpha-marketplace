import { NextRequest, NextResponse } from "next/server";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const DEFAULT_DATA_PLANE_URL = "https://data-plane-production.up.railway.app";

/** Server-only token snapshot proxy; the data-plane credential never crosses. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await context.params;
  if (!ADDRESS.test(address)) {
    return NextResponse.json({ error: { code: "invalid_address" } }, { status: 400 });
  }
  const baseUrl = (process.env["DATA_PLANE_URL"] ?? DEFAULT_DATA_PLANE_URL).replace(/\/$/u, "");
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env["DATA_PLANE_TOKEN"]?.trim();
  if (token) headers["x-dp-token"] = token;
  try {
    const upstream = await fetch(`${baseUrl}/tokens/${address.toLowerCase()}`, {
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
    return NextResponse.json(payload, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: { code: "market_data_unavailable" } }, { status: 502 });
  }
}


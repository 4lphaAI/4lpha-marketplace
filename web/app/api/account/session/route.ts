import { NextRequest, NextResponse } from "next/server";
import { execOwnerMutation } from "@/lib/exec/client";

const COOKIE = "4lpha_account_read";

/**
 * The origin the browser sees. Behind Railway's edge TLS terminates before the
 * Next server, so `nextUrl.origin` reports the internal scheme/host and the
 * browser's `Origin` header never equals it; the forwarded headers (set by
 * the proxy, not the client) carry the public values. Locally there are no
 * forwarded headers and `nextUrl` is authoritative.
 */
function publicOrigin(request: NextRequest): string {
  const first = (name: string): string | undefined => request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const proto = first("x-forwarded-proto") ?? request.nextUrl.protocol.replace(/:$/u, "");
  const host = first("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

/** Browser selection cleanup only; this neither revokes a token nor calls the plane. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (request.headers.get("origin") !== publicOrigin(request)) {
    return NextResponse.json({ error: { code: "invalid_origin" } }, { status: 403 });
  }
  const response = NextResponse.json({ data: { cleared: true } }, { headers: { "cache-control": "private, no-store" } });
  response.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "strict", secure: true, path: "/api", maxAge: 0 });
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const raw = await request.text();
  if (raw.length === 0 || raw.length > 16_384) {
    return NextResponse.json({ error: { code: "invalid_owner_action" } }, { status: 400 });
  }
  try {
    const upstream = await execOwnerMutation("/owner-read-session", raw);
    const response = new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
    if (upstream.status >= 200 && upstream.status < 300) {
      const decoded = JSON.parse(upstream.body) as { data?: { token?: unknown; expiry?: unknown } };
      if (typeof decoded.data?.token !== "string" || typeof decoded.data.expiry !== "number") {
        return NextResponse.json({ error: { code: "invalid_execution_response" } }, { status: 502 });
      }
      response.cookies.set(COOKIE, decoded.data.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: true,
        path: "/api",
        // Session cookie: browser-session lifetime; the plane enforces 24 h.
      });
    }
    if (upstream.status >= 200 && upstream.status < 300) {
      const decoded = JSON.parse(upstream.body) as { data: { expiry: number } };
      return new NextResponse(JSON.stringify({ data: { expiry: decoded.data.expiry } }), {
        status: 200,
        headers: response.headers,
      });
    }
    return response;
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

import type { NextRequest } from "next/server";

/**
 * The origin the browser sees. Behind Railway's edge TLS terminates before the
 * Next server, so `nextUrl.origin` reports the internal scheme/host and the
 * browser's `Origin` header never equals it; the forwarded headers (set by
 * the proxy, not the client) carry the public values. Locally there are no
 * forwarded headers and `nextUrl` is authoritative.
 */
export function publicOrigin(request: NextRequest): string {
  const first = (name: string): string | undefined => request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const proto = first("x-forwarded-proto") ?? request.nextUrl.protocol.replace(/:$/u, "");
  const host = first("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

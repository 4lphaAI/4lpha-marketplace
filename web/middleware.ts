import { NextRequest, NextResponse } from "next/server";

/**
 * ONE CANONICAL ORIGIN: `www.4lpha.tech` redirects to `4lpha.tech`.
 *
 * ─── WHY A REDIRECT AND NOT A SECOND ORIGIN THAT SERVES THE APP ────────────
 *
 * Both hostnames point at this service, so without this the app would answer on
 * two origins — and two origins break two things that are scoped to exactly one:
 *
 *   1. **Passkeys.** `PASSKEY_ORIGINS` on the execution plane is an EXACT
 *      allowlist, and it holds `https://4lpha.tech` alone. A visitor who hired
 *      from `www` would browse fine and then have every owner action refused by
 *      our own verifier — a half-working site, which is worse than a 404
 *      because it fails in the middle of a hire rather than at the door.
 *      Adding the `www` origin to that list was the alternative and is a wider
 *      trust surface for no gain.
 *   2. **Cookies.** `4lpha_demo_session` and `4lpha_account_read` are host
 *      scoped. A demo created on `www` is invisible on the apex, and the demo
 *      detail screen would correctly but uselessly report it as "not created in
 *      this browser". One origin, one cookie jar, no phantom-loss.
 *
 * The RP ID is untouched (`4lpha.tech` either way), so this strands no wallet
 * and re-registers no credential — the failure mode that makes RP-ID changes
 * expensive does not apply to a redirect.
 *
 * 308, not 302: it PRESERVES THE METHOD, so a POST that lands on `www` is
 * replayed as a POST rather than silently degraded to a GET — and it is
 * permanent, which is what the canonical host actually is.
 */
export function middleware(request: NextRequest): NextResponse {
  const host = request.headers.get("host") ?? "";
  // The hostname only; a dev port must not be compared as part of it.
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  if (hostname !== "www.4lpha.tech") return NextResponse.next();

  const url = request.nextUrl.clone();
  url.hostname = "4lpha.tech";
  url.port = "";
  url.protocol = "https:";
  return NextResponse.redirect(url, 308);
}

/**
 * Everything except Next's own asset paths.
 *
 * A visitor who reaches `www` is redirected before the page renders, so the
 * assets are never requested from that host — excluding them keeps the check
 * off the hot path rather than changing behaviour.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import type { NextRequest } from "next/server";

export const ACCOUNT_READ_COOKIE = "4lpha_account_read";

export type AccountReadCredential =
  | { readonly kind: "bearer"; readonly value: string }
  | { readonly kind: "signed"; readonly value: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" };

/**
 * Select exactly one server-side owner-read credential; never return it to JS.
 *
 * When BOTH are present the explicit per-request signed header wins and the
 * cookie is NOT forwarded: the cookie is HttpOnly and therefore invisible to
 * the page that chose to sign, so "both" is the ordinary state of a browser
 * that visited Account (which sets the cookie) and then polled a hire (which
 * signs) — not an attack. Exactly one credential still reaches the plane.
 * (Post-closure amendment to MARKETPLACE-AGENT-DETAIL REVIEW2 C1.3, 2026-09-02.)
 */
export function accountReadCredential(request: NextRequest): AccountReadCredential {
  const bearer = request.cookies.get(ACCOUNT_READ_COOKIE)?.value;
  const signed = request.headers.get("x-owner-action") ?? undefined;
  if (signed !== undefined) return { kind: "signed", value: signed };
  if (bearer !== undefined) return { kind: "bearer", value: bearer };
  if (signed !== undefined) return { kind: "signed", value: signed };
  return { kind: "missing" };
}

import { NextRequest, NextResponse } from "next/server";
import { execAccountRead, execOwnerRead } from "@/lib/exec/client";
import {
  ACCOUNT_READ_COOKIE,
  accountReadCredential,
} from "@/lib/exec/read-credential";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/**
 * Wallets the CLIENT declares on the read.
 *
 * A passkey user's Altana wallet holds funds before any agent is hired onto it,
 * so the plane owns no row naming it and the portfolio would come back empty.
 * The browser knows the address from its own passkey record and passes it here.
 *
 * The BFF re-validates rather than forwarding the raw query: same bounds as the
 * plane (at most two 20-byte addresses), so a malformed query is refused before
 * it costs an upstream round trip. It grants NO authority — the plane simply
 * reads public balances for an owner it has already authenticated.
 */
function declaredWallets(request: NextRequest): string[] | null {
  const raw = request.nextUrl.searchParams.get("wallets");
  if (raw === null) return [];
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2) return null;
  return parts.every((part) => ADDRESS.test(part)) ? parts : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const credential = accountReadCredential(request);
  if (credential.kind === "ambiguous") {
    return NextResponse.json({ error: { code: "ambiguous_owner_auth" } }, { status: 400 });
  }
  if (credential.kind === "missing") {
    return NextResponse.json({ error: { code: "account_session_required" } }, { status: 401 });
  }
  const wallets = declaredWallets(request);
  if (wallets === null) {
    return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400 });
  }
  const path = wallets.length === 0
    ? "/account/portfolio"
    : `/account/portfolio?wallets=${encodeURIComponent(wallets.join(","))}`;
  try {
    const upstream = credential.kind === "bearer"
      ? await execAccountRead(path, credential.value)
      : await execOwnerRead(path, credential.value);
    const response = new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
    if (credential.kind === "bearer" && upstream.status === 401) {
      response.cookies.delete(ACCOUNT_READ_COOKIE);
    }
    return response;
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

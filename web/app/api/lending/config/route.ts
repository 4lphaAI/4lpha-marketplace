import { NextResponse } from "next/server";
import { execServiceRead } from "@/lib/exec/client";
import { INVALID, parseLendingConfig } from "@/lib/exec/lending-types";

/**
 * `GET /api/lending/config` — the venue the passkey recovery batch is built on.
 *
 * A PERIMETER read: the plane answers it with `x-exec-token` alone because the
 * payload is public chain configuration and carries no owner data. The token
 * stays on this side of the boundary (CLAUDE.md §"Marketplace UI").
 *
 * The payload is RE-VALIDATED here, so a plane that answered something else
 * cannot put an unchecked address into a batch the passkey is about to sign.
 */
export async function GET(): Promise<NextResponse> {
  const headers = { "cache-control": "private, no-store" } as const;
  try {
    const upstream = await execServiceRead("/lending/config");
    if (upstream.status === 404) {
      return NextResponse.json(
        { error: { code: "lending_disabled" } },
        { status: 404, headers },
      );
    }
    if (upstream.status !== 200) {
      return NextResponse.json(
        { error: { code: "execution_unavailable" } },
        { status: 502, headers },
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(upstream.body) as unknown;
    } catch {
      return NextResponse.json({ error: { code: "invalid_response" } }, { status: 502, headers });
    }
    const data = parseLendingConfig(
      (payload as { data?: unknown } | null)?.data ?? payload,
    );
    if (data === INVALID) {
      return NextResponse.json({ error: { code: "invalid_response" } }, { status: 502, headers });
    }
    return NextResponse.json({ data }, { headers });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502, headers });
  }
}

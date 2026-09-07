import { NextRequest, NextResponse } from "next/server";
import { execOwnerRead } from "@/lib/exec/client";

/** Owner-signed agent list: forwards the x-owner-action header verbatim. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const envelope = request.headers.get("x-owner-action");
  if (!envelope) {
    return NextResponse.json({ error: { code: "missing_owner_action" } }, { status: 400 });
  }
  try {
    const upstream = await execOwnerRead("/agents", envelope);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

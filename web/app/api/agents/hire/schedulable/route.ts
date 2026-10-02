import { NextRequest, NextResponse } from "next/server";
import { execServiceRead } from "@/lib/exec/client";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const upstream = await execServiceRead(`/agents/hire/schedulable?${request.nextUrl.searchParams.toString()}`);
    return new NextResponse(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

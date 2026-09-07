import { NextRequest, NextResponse } from "next/server";
import { execOwnerMutation } from "@/lib/exec/client";

const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!AGENT_ID_PATTERN.test(id)) return NextResponse.json({ error: { code: "invalid_agent_id" } }, { status: 400 });
  const rawBody = await request.text();
  if (rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });
  try {
    const upstream = await execOwnerMutation(`/agents/${encodeURIComponent(id)}/session/grant-attempt`, rawBody);
    return new NextResponse(upstream.body, { status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

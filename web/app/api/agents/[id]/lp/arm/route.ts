import { NextRequest, NextResponse } from "next/server";
import { execProvisionContinuationMutation } from "@/lib/exec/client";
import { forwardAgentMutation } from "@/lib/exec/mutation-bff";

const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const id = (await context.params).id;
  const continuation = request.headers.get("x-provision-action");
  if (continuation === null) return forwardAgentMutation(request, id, "/lp/arm");
  if (!AGENT_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: { code: "invalid_agent_id" } }, { status: 400 });
  }
  const rawBody = await request.text();
  if (rawBody.length === 0 || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });
  }
  if (request.headers.has("x-owner-action") || request.headers.has("authorization") || rawBody.trim() !== "{}") {
    return NextResponse.json({ error: { code: "ambiguous_owner_auth" } }, { status: 400 });
  }
  try {
    const upstream = await execProvisionContinuationMutation(
      `/agents/${encodeURIComponent(id)}/lp/arm`, continuation,
    );
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

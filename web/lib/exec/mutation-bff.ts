import { NextRequest, NextResponse } from "next/server";
import { execOwnerMutation, type ExecResponse } from "./client";

export const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
export const POSITION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_BODY_BYTES = 64 * 1024;

/** Forward the signature-covered bytes without parsing or re-serializing. */
export async function forwardAgentMutation(
  request: NextRequest,
  id: string,
  suffix: string,
  mutation: (path: string, rawBody: string) => Promise<ExecResponse> = execOwnerMutation,
): Promise<NextResponse> {
  if (!AGENT_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: { code: "invalid_agent_id" } }, { status: 400 });
  }
  const rawBody = await request.text();
  if (rawBody.length === 0 || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });
  }
  try {
    const upstream = await mutation(`/agents/${encodeURIComponent(id)}${suffix}`, rawBody);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

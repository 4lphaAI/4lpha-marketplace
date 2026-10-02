import { NextRequest, NextResponse } from "next/server";
import { execAccountReadMutation, execOwnerMutation, execOwnerReadMutation, type ExecResponse } from "./client";
import { ACCOUNT_READ_COOKIE, accountReadCredential } from "./read-credential";

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

/**
 * Forward a bounded POST through the account-read credential. The body is an
 * untrusted operation/calls lookup; only the server-side bearer or signed read
 * credential supplies owner authority.
 */
export async function forwardAccountReadMutation(
  request: NextRequest,
  id: string,
  suffix: string,
): Promise<NextResponse> {
  if (!AGENT_ID_PATTERN.test(id)) return NextResponse.json({ error: { code: "invalid_agent_id" } }, { status: 400 });
  const credential = accountReadCredential(request);
  if (credential.kind === "ambiguous") return NextResponse.json({ error: { code: "ambiguous_owner_auth" } }, { status: 400 });
  if (credential.kind === "missing") return NextResponse.json({ error: { code: "owner_auth_required" } }, { status: 401 });
  const rawBody = await request.text();
  if (rawBody.length === 0 || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });
  }
  try {
    const path = `/agents/${encodeURIComponent(id)}${suffix}`;
    const upstream = credential.kind === "bearer"
      ? await execAccountReadMutation(path, credential.value, rawBody)
      : await execOwnerReadMutation(path, credential.value, rawBody);
    const response = new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
    if (credential.kind === "bearer" && upstream.status === 401) response.cookies.delete(ACCOUNT_READ_COOKIE);
    return response;
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

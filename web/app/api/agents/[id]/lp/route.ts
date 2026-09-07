import { NextRequest, NextResponse } from "next/server";
import { execAccountRead, execOwnerRead } from "@/lib/exec/client";
import {
  ACCOUNT_READ_COOKIE,
  accountReadCredential,
} from "@/lib/exec/read-credential";

const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Owner-signed LP/grid view for one agent. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!AGENT_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: { code: "invalid_agent_id" } }, { status: 400 });
  }
  const credential = accountReadCredential(request);
  if (credential.kind === "ambiguous") return NextResponse.json({ error: { code: "ambiguous_owner_auth" } }, { status: 400 });
  if (credential.kind === "missing") return NextResponse.json({ error: { code: "owner_auth_required" } }, { status: 401 });
  try {
    const path = `/agents/${encodeURIComponent(id)}/lp`;
    const upstream = credential.kind === "bearer"
      ? await execAccountRead(path, credential.value)
      : await execOwnerRead(path, credential.value);
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

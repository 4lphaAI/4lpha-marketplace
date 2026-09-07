import { NextRequest, NextResponse } from "next/server";
import { execAccountRead, execOwnerRead } from "@/lib/exec/client";
import { ACCOUNT_READ_COOKIE, accountReadCredential } from "@/lib/exec/read-credential";
import { AGENT_ID_PATTERN } from "@/lib/exec/mutation-bff";
import { readGuardable } from "@/lib/exec/lending-bff";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/**
 * `GET /api/agents/:id/lending/view` — the owner read, plus R2.18's fallback.
 *
 * The plane's view takes ZERO chain reads: the worker writes a snapshot last in
 * every cycle and the route serves it. Past `2 x interval` that snapshot is
 * STALE and the plane refuses to serve a guess (`payload: null`).
 *
 * R2.18 then says what this BFF does about it, and only about it: fetch
 * `/lending/guardable?account=<guardedAccount>` in DISPLAY mode and hand the
 * ACCOUNT half back under `data.liveAccount`, labelled "read now, not by the
 * agent". The GUARD half — reserve, rescues, conditions — stays dashed with the
 * staleness reason, because nothing outside the worker has read it.
 *
 * EXACTLY ONE credential reaches the plane for the owner read (header XOR
 * cookie); the fallback is a PERIMETER read that carries no owner data at all.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const headers = { "content-type": "application/json", "cache-control": "private, no-store" } as const;
  if (!AGENT_ID_PATTERN.test(id)) {
    return NextResponse.json({ error: { code: "invalid_agent_id" } }, { status: 400 });
  }
  const credential = accountReadCredential(request);
  if (credential.kind === "ambiguous") {
    return NextResponse.json({ error: { code: "ambiguous_owner_auth" } }, { status: 400 });
  }
  if (credential.kind === "missing") {
    return NextResponse.json({ error: { code: "owner_auth_required" } }, { status: 401 });
  }
  let upstream;
  try {
    const path = `/agents/${encodeURIComponent(id)}/lending/view`;
    upstream = credential.kind === "bearer"
      ? await execAccountRead(path, credential.value)
      : await execOwnerRead(path, credential.value);
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
  if (upstream.status !== 200) {
    const response = new NextResponse(upstream.body, { status: upstream.status, headers });
    if (credential.kind === "bearer" && upstream.status === 401) {
      response.cookies.delete(ACCOUNT_READ_COOKIE);
    }
    return response;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(upstream.body) as unknown;
  } catch {
    // Unparseable: pass it through untouched rather than inventing a shape.
    return new NextResponse(upstream.body, { status: 200, headers });
  }
  const body = payload as { data?: Record<string, unknown> } | null;
  const data = body?.data;
  if (data === undefined || data === null || typeof data !== "object") {
    return new NextResponse(upstream.body, { status: 200, headers });
  }
  const snapshot = data["snapshot"] as { stale?: unknown } | undefined;
  const guard = data["guard"] as { guardedAccount?: unknown } | undefined;
  const account = typeof guard?.guardedAccount === "string" ? guard.guardedAccount : "";
  if (snapshot?.stale !== true || !ADDRESS.test(account)) {
    return new NextResponse(upstream.body, { status: 200, headers });
  }

  const fallback = await readGuardable({ account });
  const enriched = fallback.kind === "ok"
    ? { ...data, liveAccount: fallback.view }
    : {
        ...data,
        liveAccountReason: fallback.kind === "rate-limited"
          ? "the live read is rate-limited"
          : fallback.kind === "disabled"
            ? "the lending guard is not enabled on this deployment"
            : fallback.kind === "invalid-request"
              ? "the live read was refused"
              : fallback.reason,
      };
  return NextResponse.json({ ...body, data: enriched }, { status: 200, headers });
}

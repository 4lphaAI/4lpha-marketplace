import { NextRequest, NextResponse } from "next/server";
import { execAccountRead, execOwnerRead } from "@/lib/exec/client";
import { ACCOUNT_READ_COOKIE, accountReadCredential } from "@/lib/exec/read-credential";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const credential = accountReadCredential(request);
  if (credential.kind === "ambiguous") return NextResponse.json({ error: { code: "ambiguous_owner_auth" } }, { status: 400 });
  if (credential.kind === "missing") return NextResponse.json({ error: { code: "owner_auth_required" } }, { status: 401 });
  try {
    const upstream = credential.kind === "bearer"
      ? await execAccountRead("/agents", credential.value)
      : await execOwnerRead("/agents", credential.value);
    const response = new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
    if (credential.kind === "bearer" && upstream.status === 401) {
      response.cookies.set(ACCOUNT_READ_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: true, path: "/api", maxAge: 0 });
    }
    return response;
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

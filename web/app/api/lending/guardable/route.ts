import { NextRequest, NextResponse } from "next/server";
import { readGuardable, validateGuardableInputs } from "@/lib/exec/lending-bff";

/**
 * `GET /api/lending/guardable` — the guarded account's live Venus position.
 *
 * A PERIMETER read of PUBLIC chain state, taken BEFORE any signature exists, so
 * a mistyped address is caught by eye rather than by a refusal after funding
 * (§0.5 — the only safeguard there is, because repaying a stranger's debt is a
 * gift nothing can reverse).
 *
 * TWO MODES, exactly as the plane has them: display (`?account=`) and receipt
 * (`?account=&budgetWei=&reserveBps=&maxPerActionUsdtWei=&rescueReserveCount=`).
 * The receipt is opaque here and authorizes nothing; it only lets S1 verify that
 * the hire it was signed with equals the inputs the floor was computed from.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const headers = { "cache-control": "private, no-store" } as const;
  const q = request.nextUrl.searchParams;
  const validated = validateGuardableInputs({
    account: q.get("account"),
    budgetWei: q.get("budgetWei"),
    reserveBps: q.get("reserveBps"),
    maxPerActionUsdtWei: q.get("maxPerActionUsdtWei"),
    rescueReserveCount: q.get("rescueReserveCount"),
  });
  if ("error" in validated) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: validated.error } },
      { status: 400, headers },
    );
  }
  const result = await readGuardable(validated);
  if (result.kind === "ok") return NextResponse.json({ data: result.view }, { headers });
  if (result.kind === "disabled") {
    return NextResponse.json({ error: { code: "lending_disabled" } }, { status: 404, headers });
  }
  if (result.kind === "rate-limited") {
    return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429, headers });
  }
  if (result.kind === "invalid-request") {
    return NextResponse.json(
      { error: { code: "invalid_request", message: result.message } },
      { status: 400, headers },
    );
  }
  return NextResponse.json(
    { error: { code: "execution_unavailable", message: result.reason } },
    { status: 502, headers },
  );
}

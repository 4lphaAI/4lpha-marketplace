import { NextRequest, NextResponse } from "next/server";
import { forwardAgentMutation, POSITION_ID_PATTERN } from "@/lib/exec/mutation-bff";

/**
 * Owner-signed `resolveUnknown` (PHASE3.3 / 3.14): settle ONE journal step
 * the relay never answered for. The decision id (`lp:<sequenceId>:<n>`) is
 * inside the signed params AND in the path; the plane refuses a mismatch.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; decisionId: string }> },
): Promise<NextResponse> {
  const { id, decisionId } = await context.params;
  if (!POSITION_ID_PATTERN.test(decisionId)) {
    return NextResponse.json({ error: { code: "invalid_decision_id" } }, { status: 400 });
  }
  return forwardAgentMutation(request, id, `/journal/${encodeURIComponent(decisionId)}/resolve`);
}

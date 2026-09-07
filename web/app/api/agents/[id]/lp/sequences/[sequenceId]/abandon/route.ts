import { NextRequest, NextResponse } from "next/server";
import { forwardAgentMutation, POSITION_ID_PATTERN } from "@/lib/exec/mutation-bff";

/** Owner-signed `abandonSequence` (PHASE3.8): release a held LP sequence the plane has proven idle. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; sequenceId: string }> },
): Promise<NextResponse> {
  const { id, sequenceId } = await context.params;
  if (!POSITION_ID_PATTERN.test(sequenceId)) {
    return NextResponse.json({ error: { code: "invalid_sequence_id" } }, { status: 400 });
  }
  return forwardAgentMutation(request, id, `/lp/sequences/${encodeURIComponent(sequenceId)}/abandon`);
}

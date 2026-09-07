import { NextRequest, NextResponse } from "next/server";
import { forwardAgentMutation, POSITION_ID_PATTERN } from "@/lib/exec/mutation-bff";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; positionId: string }> },
): Promise<NextResponse> {
  const { id, positionId } = await context.params;
  if (!POSITION_ID_PATTERN.test(positionId)) {
    return NextResponse.json({ error: { code: "invalid_position_id" } }, { status: 400 });
  }
  return forwardAgentMutation(request, id, `/trade/positions/${encodeURIComponent(positionId)}/exit`);
}

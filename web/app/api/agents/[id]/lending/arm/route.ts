import { NextRequest, type NextResponse } from "next/server";
import { forwardAgentMutation } from "@/lib/exec/mutation-bff";

/** Owner-signed `lendingArm`; the signature-covered bytes are forwarded verbatim. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return forwardAgentMutation(request, (await context.params).id, "/lending/arm");
}

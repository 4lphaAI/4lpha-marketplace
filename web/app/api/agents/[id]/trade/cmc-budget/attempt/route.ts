import { NextRequest, type NextResponse } from "next/server";
import { forwardAccountReadMutation } from "@/lib/exec/mutation-bff";

/** Record the idempotent owner operation before any admin wallet prompt. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return forwardAccountReadMutation(request, (await context.params).id, "/trade/cmc-budget/attempt");
}

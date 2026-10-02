import { NextRequest, type NextResponse } from "next/server";
import { forwardAccountReadMutation } from "@/lib/exec/mutation-bff";

/** Adopt only the execution plane's finalized owner setup evidence. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return forwardAccountReadMutation(request, (await context.params).id, "/trade/cmc-budget/confirm");
}

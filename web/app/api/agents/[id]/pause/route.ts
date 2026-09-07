import { NextRequest, type NextResponse } from "next/server";
import { forwardAgentMutation } from "@/lib/exec/mutation-bff";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return forwardAgentMutation(request, (await context.params).id, "/pause");
}

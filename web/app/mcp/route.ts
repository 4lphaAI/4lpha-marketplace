import { NextRequest, NextResponse } from "next/server";
import { PROTOCOL_VERSION, SERVER_INFO, TOOLS, handleMcpMessage } from "@/lib/mcp/server";

/** The canonical public origin recorded in ERC-8004 metadata. */
const PUBLIC_ORIGIN = "https://4lpha.tech";

/**
 * MCP streamable-HTTP face at `/mcp` — the endpoint named in this agent's
 * ERC-8004 `services[]` entry, and the path `bag erc8004 register --protocol
 * MCP` and every registry-reading marketplace probe expect.
 *
 * It is deliberately public and unauthenticated: it serves the same product
 * catalogue the marketplace home page serves, and nothing else. It never
 * forwards to the execution plane, so no exec token, owner signature or session
 * key is reachable from here — see `lib/mcp/server.ts` for why hiring cannot
 * and must not happen over this surface.
 */

/** Batches are legal JSON-RPC; a probe that sends one must not get a 500. */
function reply(message: unknown, origin: string): NextResponse {
  const result = handleMcpMessage(message, origin);
  return result.body === null ? new NextResponse(null, { status: result.status }) : NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 200 });
  }
  if (!Array.isArray(payload)) return reply(payload, PUBLIC_ORIGIN);

  const replies = payload.map((message) => handleMcpMessage(message, PUBLIC_ORIGIN)).filter((item) => item.body !== null).map((item) => item.body);
  return replies.length === 0 ? new NextResponse(null, { status: 202 }) : NextResponse.json(replies, { status: 200 });
}

/**
 * A plain GET is how a human — and several registry health probes — check the
 * endpoint is alive. The MCP spec reserves GET for an SSE stream we do not
 * open, so we answer with a static descriptor rather than an error: a probe
 * that sees 200 + serverInfo classifies the endpoint healthy, which is the
 * whole point of publishing it.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  return NextResponse.json({
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    transport: "streamable-http",
    endpoint: `${PUBLIC_ORIGIN}/mcp`,
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
  });
}

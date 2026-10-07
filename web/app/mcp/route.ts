import { NextRequest, NextResponse } from "next/server";
import { mcpOrigin } from "@/lib/mcp/origin";
import { PROTOCOL_VERSION, SERVER_INFO, handleMcpMessage, listTools } from "@/lib/mcp/server";
import { chargeToolCalls, clientIp } from "@/lib/mcp/rateLimit";

/**
 * MCP streamable-HTTP face at `/mcp`: the endpoint named in this agent's
 * ERC-8004 `services[]` entry, and the path `bag erc8004 register --protocol
 * MCP` and every registry-reading marketplace probe expect.
 *
 * It is deliberately public and unauthenticated. The static tools serve the
 * same product catalogue the marketplace home page serves; the data tools
 * (flag MCP_DATA_TOOLS_ENABLED) serve cached, public reads. It never forwards
 * a caller-supplied path, so no exec token, owner signature or session key is
 * reachable from here; see `lib/mcp/server.ts` for why hiring cannot and must
 * not happen over this surface.
 *
 * Every `tools/call` message counts against a per-IP and a global rate limit
 * (`lib/mcp/rateLimit.ts`); the whole request is refused with HTTP 429 and
 * `Retry-After` before any message in it is handled.
 */

function rateLimited(retryAfterSec: number): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate_limited" } }, { status: 429, headers: { "retry-after": String(retryAfterSec) } });
}

const isToolCall = (message: unknown): boolean =>
  message !== null && typeof message === "object" && !Array.isArray(message) && (message as { method?: unknown }).method === "tools/call";

async function reply(message: unknown, origin: string): Promise<NextResponse> {
  const result = await handleMcpMessage(message, origin);
  return result.body === null ? new NextResponse(null, { status: result.status }) : NextResponse.json(result.body, { status: result.status });
}

/** Hard bounds on one request, checked before anything is parsed or handled (free methods are not rate limited, so these are their only brake). */
const MAX_BODY_BYTES = 65_536;
const MAX_BATCH_MESSAGES = 20;

function tooLarge(): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request_too_large" } }, { status: 413 });
}

/** Reads at most MAX_BODY_BYTES; `null` = over the cap (the stream is cancelled, the rest is never buffered). */
async function readCapped(request: NextRequest): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = mcpOrigin(request);
  const raw = await readCapped(request);
  if (raw === null) return tooLarge();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 200 });
  }
  if (Array.isArray(payload)) {
    if (payload.length > MAX_BATCH_MESSAGES) return tooLarge();
    if (payload.length === 0) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, { status: 200 });
  }
  const calls = Array.isArray(payload) ? payload.filter(isToolCall).length : isToolCall(payload) ? 1 : 0;
  const charge = chargeToolCalls(clientIp(request.headers), calls);
  if (!charge.ok) return rateLimited(charge.retryAfterSec);
  if (!Array.isArray(payload)) return reply(payload, origin);

  // Batches are legal JSON-RPC; a probe that sends one must not get a 500.
  const results = await Promise.all(payload.map((message) => handleMcpMessage(message, origin)));
  const replies = results.filter((item) => item.body !== null).map((item) => item.body);
  return replies.length === 0 ? new NextResponse(null, { status: 202 }) : NextResponse.json(replies, { status: 200 });
}

/**
 * A plain GET is how a human, and several registry health probes, check the
 * endpoint is alive. The MCP spec reserves GET for an SSE stream we do not
 * open, so we answer with a static descriptor rather than an error: a probe
 * that sees 200 + serverInfo classifies the endpoint healthy, which is the
 * whole point of publishing it. It lists the same tools `tools/list` does.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return NextResponse.json({
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    transport: "streamable-http",
    endpoint: `${mcpOrigin(request)}/mcp`,
    tools: listTools().map((tool) => ({ name: tool.name, description: tool.description })),
  });
}

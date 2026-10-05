import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "@/lib/exec/public-origin";

const COOKIE = "4lpha_agentic_pairing";
const requests = new Map<string, { start: number; count: number }>();
const cache = new Map<string, { at: number; body: string; status: number }>();
function limited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  for (const [k, row] of requests) if (now - row.start >= 600_000) requests.delete(k);
  let row = requests.get(key); if (row === undefined || now - row.start >= windowMs) { row = { start: now, count: 0 }; requests.set(key, row); }
  row.count += 1; return row.count > limit;
}
async function proxy(request: NextRequest, segments: readonly string[], method: "GET" | "POST") {
  if (process.env.NEXT_PUBLIC_AGENTIC_WALLET_ENABLED !== "true") return NextResponse.json({ data: null, error: { code: "not_found" } }, { status: 404 });
  const path = segments.join("/");
  const pairing = /^pairings\/[0-9a-f-]{36}(\/(code|finalize))?$/.test(path);
  const publicRead = method === "GET" && /^wallets\/0x[0-9a-f]{40}$/i.test(path);
  if (!publicRead && !(method === "POST" && (path === "pairings" || path === "hire" || pairing && /\/(code|finalize)$/.test(path))) && !(method === "GET" && pairing && !/\/(code|finalize)$/.test(path))) return NextResponse.json({ data: null, error: { code: "not_found" } }, { status: 404 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (publicRead && limited("read:" + ip, 60, 60_000) || method === "POST" && path === "pairings" && limited("start:" + ip, 5, 600_000)) return NextResponse.json({ data: null, error: { code: "rate_limited" } }, { status: 429 });
  if (method === "POST" && (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || request.headers.get("origin") !== publicOrigin(request))) return NextResponse.json({ data: null, error: { code: "forbidden" } }, { status: 403 });
  const cookie = request.cookies.get(COOKIE)?.value;
  if (!publicRead && path !== "pairings" && (cookie === undefined || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(cookie))) return NextResponse.json({ data: null, error: { code: "unauthorized" } }, { status: 401 });
  const key = path.toLowerCase(), saved = cache.get(key);
  if (publicRead && saved !== undefined && Date.now() - saved.at < 15_000) return new NextResponse(saved.body, { status: saved.status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  try {
    const url = process.env["EXECUTION_URL"]?.trim(), token = process.env["EXECUTION_API_TOKEN"]?.trim();
    if (!url || !token) throw new Error();
    const body = method === "POST" ? await request.text() : undefined;
    if (body !== undefined && Buffer.byteLength(body) > 16_384) return NextResponse.json({ data: null, error: { code: "invalid_body" } }, { status: 413 });
    const upstream = await fetch(url.replace(/\/$/, "") + "/agentic/" + path, { method, cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", "x-exec-token": token, ...(body === undefined ? {} : { "content-type": "application/json", origin: publicOrigin(request) }),
        ...(!publicRead && path !== "pairings" && cookie !== undefined ? { "x-agentic-pairing": cookie } : {}) }, ...(body === undefined ? {} : { body }) });
    const raw = await upstream.text();
    const envelope = JSON.parse(raw) as { data?: Record<string, unknown>; error?: unknown };
    let credential = cookie;
    if (path === "pairings" && upstream.status === 201 && typeof envelope.data?.["pairingId"] === "string" && typeof envelope.data["pairingSecret"] === "string") {
      credential = envelope.data["pairingId"] + "." + envelope.data["pairingSecret"];
      delete envelope.data["pairingSecret"];
    }
    const response = NextResponse.json(envelope, { status: upstream.status, headers: { "cache-control": "private, no-store" } });
    if (!publicRead && credential !== undefined && (path === "pairings" || pairing)) {
      const deadline = envelope.data?.["continuationDeadlineMs"];
      response.cookies.set(COOKIE, credential, { httpOnly: true, secure: true, sameSite: "strict", path: "/api/agentic",
        maxAge: typeof deadline === "number" ? Math.max(60, Math.ceil((deadline - Date.now()) / 1_000) + 300) : 2_400 });
    }
    if (publicRead && upstream.ok) { for (const [k, entry] of cache) if (Date.now() - entry.at >= 15_000) cache.delete(k); cache.set(key, { at: Date.now(), body: JSON.stringify(envelope), status: upstream.status }); }
    return response;
  } catch { return NextResponse.json({ data: null, error: { code: "execution_unavailable" } }, { status: 502 }); }
}
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, (await context.params).path, "GET"); }
export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, (await context.params).path, "POST"); }

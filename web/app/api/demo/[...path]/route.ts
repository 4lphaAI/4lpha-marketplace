/**
 * DEMO MODE — the BFF proxy.
 *
 * Mints and holds the anonymous demo session id in an HttpOnly cookie, and
 * forwards `/api/demo/<path>` to the execution plane's `/demo/<path>` with the
 * service token. The browser sees neither the exec token nor, in JS, the
 * cookie.
 *
 * WHY AN ANONYMOUS COOKIE AND NOT A PASSKEY (operator decision 2026-09-06):
 * demo mode exists so a visitor can watch an agent work BEFORE they have a
 * wallet. Requiring a passkey would remove the only case it is for. A demo id
 * grants nothing but access to simulations created under it, and the plane
 * bounds it with a per-owner cap and a TTL sweep.
 *
 * The allowlist below is deliberate: this proxy forwards the five demo paths
 * and nothing else, so it can never become a general tunnel to the plane with
 * the service token attached.
 */
import { NextRequest, NextResponse } from "next/server";
import { execDemo } from "@/lib/exec/client";

const COOKIE = "4lpha_demo_session";
/** 30 days: long enough that a visitor's demos survive a browser restart. */
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const GET_PATHS = [/^agents$/u, /^agents\/[0-9a-f-]{1,64}$/u, /^agents\/[0-9a-f-]{1,64}\/fills$/u];
const POST_PATHS = [/^agents$/u, /^agents\/[0-9a-f-]{1,64}\/stop$/u];

function readCookie(request: NextRequest): string | null {
  const value = request.cookies.get(COOKIE)?.value ?? "";
  return /^[0-9a-f]{32}$/u.test(value) ? value : null;
}

function mint(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withCookie(response: NextResponse, id: string, minted: boolean): NextResponse {
  if (minted) {
    response.cookies.set(COOKIE, id, {
      path: "/api",
      maxAge: COOKIE_MAX_AGE_SEC,
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });
  }
  return response;
}

function pathOf(segments: readonly string[], allow: readonly RegExp[]): string | null {
  const joined = segments.join("/");
  return allow.some((pattern) => pattern.test(joined)) ? joined : null;
}

async function proxy(
  request: NextRequest,
  segments: readonly string[],
  method: "GET" | "POST",
): Promise<NextResponse> {
  const path = pathOf(segments, method === "GET" ? GET_PATHS : POST_PATHS);
  if (path === null) {
    return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  }
  const existing = readCookie(request);
  const id = existing ?? mint();
  let body: string | undefined;
  if (method === "POST") {
    body = await request.text();
    if (body.length > 8_192) {
      return NextResponse.json({ error: { code: "invalid_request" } }, { status: 413 });
    }
  }
  try {
    const upstream = await execDemo(`/demo/${path}`, id, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    return withCookie(
      new NextResponse(upstream.body, {
        status: upstream.status,
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
      }),
      id,
      existing === null,
    );
  } catch {
    return NextResponse.json({ error: { code: "execution_unavailable" } }, { status: 502 });
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return proxy(request, (await context.params).path ?? [], "GET");
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  return proxy(request, (await context.params).path ?? [], "POST");
}

import type { NextRequest } from "next/server";
import { publicOrigin } from "@/lib/exec/public-origin";

/**
 * The origin every link the MCP hands out is built on (`deployUrl`, `pageUrl`, step text, the GET `endpoint`).
 *
 * `publicOrigin()` trusts the forwarded host header, which Railway documents no overwrite for; a caller who could set
 * it would get its own host back as the "official" deploy link. MCP_PUBLIC_ORIGIN pins the answer: it must be
 * `https://` plus a bare host (optional port), no path, query, credentials or trailing slash, otherwise it is ignored
 * and the request-derived origin is used as before.
 */
const PINNED = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?$/u;

export function pinnedOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env["MCP_PUBLIC_ORIGIN"]?.trim();
  return value !== undefined && PINNED.test(value) ? value.toLowerCase() : null;
}

export function mcpOrigin(request: NextRequest, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return pinnedOrigin(env) ?? publicOrigin(request);
}

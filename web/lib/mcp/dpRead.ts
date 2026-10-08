/**
 * The ONLY door from the public MCP to the data plane (AGENTIC-SKILLS-PLAN M1).
 *
 * GET only, a closed table of path patterns (every one a store-only route of the data plane), `x-dp-token` kept
 * server-side, a 15 s timeout, closed error codes, upstream bodies never echoed. Anything not in the table throws
 * before a request exists, so a route that calls an upstream per request (`/klines`, `/pools/*`, `/tokens/*`,
 * `/security`, `/holders`, `/socials`, `/diag/latency`, `/venus/*`) or any POST is unreachable from here by construction.
 *
 * Each pattern carries its cache window (M2). Keys are the full path+query, so the cache is bounded by the table:
 * addresses only enter a pattern after the caller has resolved them from the bStock universe (M3), and the
 * meme query is 10 limits x 3 orders.
 */
import { cachedFlight } from "./ttlCache";

const DEFAULT_DATA_PLANE_URL = "https://data-plane-production.up.railway.app";
const TIMEOUT_MS = 15_000;
const ADDR = "0x[0-9a-f]{40}";

export const DP_ALLOWLIST: readonly { readonly name: string; readonly pattern: RegExp; readonly ttlMs: number }[] = [
  { name: "universe", pattern: /^\/universe\?lane=bstocks$/u, ttlMs: 60_000 },
  { name: "featureIndex", pattern: /^\/trading\/features\/v2\/pools$/u, ttlMs: 60_000 },
  { name: "features", pattern: new RegExp(`^/trading/features/v2[?]pools=${ADDR}&interval=(15m|1h)$`, "u"), ttlMs: 30_000 },
  { name: "underlyingIndex", pattern: /^\/trading\/underlying-features\/v1\/tokens$/u, ttlMs: 60_000 },
  { name: "underlyingFeatures", pattern: new RegExp(`^/trading/underlying-features/v1[?]tokens=${ADDR}&interval=(15m|1h)$`, "u"), ttlMs: 30_000 },
  { name: "regime", pattern: /^\/trading\/regime\/us-equity$/u, ttlMs: 30_000 },
  { name: "eligibility", pattern: new RegExp(`^/eligibility/${ADDR}$`, "u"), ttlMs: 60_000 },
  { name: "memeStocks", pattern: /^\/memes\/stocks\?limit=([1-9]|10)&orderBy=(volume1hUsd|live|new1h)$/u, ttlMs: 30_000 },
  // Store-only on the plane. A ticker enters the key only after the caller found it in the plane's own list, so the cache stays bounded by that list.
  { name: "stockCompare", pattern: /^\/trading\/stock-compare(\?ticker=[A-Z]{1,6})?$/u, ttlMs: 60_000 },
];

export type DpErrorCode = "path_not_allowed" | "data_unavailable";
export class DpError extends Error {
  constructor(readonly code: DpErrorCode) { super(code); }
}

function baseUrl(): string {
  return (process.env["DATA_PLANE_URL"] ?? DEFAULT_DATA_PLANE_URL).replace(/\/$/u, "");
}

async function fetchJson(path: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env["DATA_PLANE_TOKEN"]?.trim();
  if (token) headers["x-dp-token"] = token;
  try {
    const response = await fetch(`${baseUrl()}${path}`, { method: "GET", headers, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new DpError("data_unavailable");
    return (await response.json()) as unknown;
  } catch {
    throw new DpError("data_unavailable");
  }
}

/** `path` includes its query string. Throws `DpError` only; never an upstream body. */
export async function dpGet(path: string): Promise<unknown> {
  const rule = DP_ALLOWLIST.find((entry) => entry.pattern.test(path));
  if (rule === undefined) throw new DpError("path_not_allowed");
  return cachedFlight(`dp:${path}`, rule.ttlMs, () => fetchJson(path));
}

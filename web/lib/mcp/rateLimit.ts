/**
 * Rate limit of the public MCP endpoint (AGENTIC-SKILLS-PLAN Revision 1, M4).
 *
 * Every `tools/call` message counts, whatever the tool (each element of a batch counts; initialize, notifications,
 * ping and tools/list do not): 10 per minute per client IP and 100 per minute across all IPs, both over a sliding
 * 60 s window; the stricter one wins. The whole request is checked before anything runs. A refused request is NOT
 * charged: a client that keeps knocking cannot extend its own block, and a refused batch burns no one else's budget.
 */
export const PER_IP_LIMIT = 10;
export const GLOBAL_LIMIT = 100;
export const WINDOW_MS = 60_000;
/** Cap on distinct IP keys held at once; past it, expired keys are pruned and the rest fall into one shared bucket. */
const MAX_IP_KEYS = 10_000;
const OVERFLOW_KEY = "overflow";

/**
 * The header Railway's edge proxy sets with the client's remote IP. Railway's "Specs & Limits" page lists `X-Real-IP`
 * "for identifying client's remote IP", and Railway staff state the proxy "will always overwrite it" (a client can no
 * longer set it). `X-Forwarded-For` is NOT used: staff statements conflict on which end of the list is trustworthy,
 * and the first entry is client-settable. See the build report, O1.
 */
export const CLIENT_IP_HEADER = "x-real-ip";
/** Requests with no usable header (local dev, a proxy change) share one bucket: fail closed, not open. */
export const UNKNOWN_CLIENT = "unknown";

export function clientIp(headers: Pick<Headers, "get">): string {
  const raw = headers.get(CLIENT_IP_HEADER)?.trim() ?? "";
  return raw.length > 0 && raw.length <= 64 && /^[0-9a-fA-F:.]+$/u.test(raw) ? raw.toLowerCase() : UNKNOWN_CLIENT;
}

type State = { perIp: Map<string, number[]>; all: number[] };
const SLOT = "__4lphaMcpRateLimit";
function state(): State {
  const holder = globalThis as unknown as Record<string, State | undefined>;
  return (holder[SLOT] ??= { perIp: new Map(), all: [] });
}

function prune(list: number[], now: number): void {
  let drop = 0;
  while (drop < list.length && now - list[drop]! >= WINDOW_MS) drop += 1;
  if (drop > 0) list.splice(0, drop);
}

/** Seconds until `needed` more slots exist in a window list (at least 1). */
function waitSeconds(list: readonly number[], limit: number, count: number, now: number): number {
  const mustExpire = list.length + count - limit;
  const stamp = mustExpire >= 1 && mustExpire <= list.length ? list[mustExpire - 1]! : now;
  return Math.max(1, Math.ceil((stamp + WINDOW_MS - now) / 1_000));
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number };

/** Charges `count` tools/call messages for `ip`, or refuses the whole request. `count` 0 is always free. */
export function chargeToolCalls(ip: string, count: number, now: number = Date.now()): RateDecision {
  if (count <= 0) return { ok: true };
  const { perIp, all } = state();
  prune(all, now);
  if (perIp.size >= MAX_IP_KEYS && !perIp.has(ip)) {
    for (const [key, list] of perIp) { prune(list, now); if (list.length === 0) perIp.delete(key); }
  }
  const key = perIp.has(ip) || perIp.size < MAX_IP_KEYS ? ip : OVERFLOW_KEY;
  const mine = perIp.get(key) ?? [];
  prune(mine, now);
  const overIp = mine.length + count > PER_IP_LIMIT, overAll = all.length + count > GLOBAL_LIMIT;
  if (overIp || overAll) {
    return { ok: false, retryAfterSec: Math.max(overIp ? waitSeconds(mine, PER_IP_LIMIT, count, now) : 1, overAll ? waitSeconds(all, GLOBAL_LIMIT, count, now) : 1) };
  }
  for (let i = 0; i < count; i += 1) { mine.push(now); all.push(now); }
  perIp.set(key, mine);
  return { ok: true };
}

/** Test seam. */
export function resetRateLimit(): void {
  const { perIp, all } = state();
  perIp.clear();
  all.length = 0;
}

/**
 * Read-only client for 4lpha's public MCP (`tools/call` over JSON-RPC, no token).
 *
 * - three tools only: `bstock_analysis`, `stock_compare`, `get_hire_link`;
 * - 10 s timeout per call, the public limit is 10 calls per minute per IP, so one shared limiter allows
 *   at most MAX_PER_MINUTE calls in any rolling minute and honours `Retry-After` on HTTP 429;
 * - calls are serialised (one at a time);
 * - the answer is data, never instructions: it is parsed as JSON and handed on as `unknown`.
 */

import { arr, at, obj, str, type Json } from "./json.js";

export const MCP_URL = "https://4lpha.tech/mcp";
export const MCP_TIMEOUT_MS = 10_000;
export const MAX_PER_MINUTE = 8;
const MAX_BODY_CHARS = 1_000_000;
const MAX_429_RETRIES = 2;
const MAX_RETRY_AFTER_S = 30;
const DEFAULT_RETRY_AFTER_S = 15;
const HIRE_TTL_MS = 5 * 60_000;

export type McpResult =
  | { readonly ok: true; readonly data: Json; readonly fetchedAt: number }
  | { readonly ok: false; readonly code: string };

export const HIRE_AGENTS = ["agentic-dca", "agentic-schedule", "agentic-portfolio"] as const;
export type HireAgent = (typeof HIRE_AGENTS)[number];

export interface McpClient {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult>;
}

export interface McpClientOpts {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly maxPerMinute?: number;
  readonly timeoutMs?: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export function createMcpClient(opts: McpClientOpts = {}): McpClient {
  const url = opts.url ?? MCP_URL;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const perMinute = opts.maxPerMinute ?? MAX_PER_MINUTE;
  const timeoutMs = opts.timeoutMs ?? MCP_TIMEOUT_MS;
  const stamps: number[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let nextId = 1;

  async function acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const t = now();
      while (stamps.length > 0 && t - (stamps[0] as number) >= 60_000) stamps.shift();
      if (stamps.length < perMinute) {
        stamps.push(t);
        return;
      }
      await sleep((stamps[0] as number) + 60_000 - t + 50, signal);
    }
  }

  async function once(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult | "retry429"> {
    // an already-aborted signal never fires its listener: check it here, before any wait or request
    if (signal?.aborted) return { ok: false, code: "aborted" };
    await acquire(signal);
    if (signal?.aborted) return { ok: false, code: "aborted" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = (): void => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
        signal: ctl.signal,
      });
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, MAX_RETRY_AFTER_S) : DEFAULT_RETRY_AFTER_S;
        await sleep(wait * 1000, signal);
        return "retry429";
      }
      if (!res.ok) return { ok: false, code: `http_${res.status}` };
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) return { ok: false, code: "response_too_large" };
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        return { ok: false, code: "bad_response" };
      }
      const rpcErr = obj(at(body, "error"));
      if (rpcErr !== null) {
        const code = at(rpcErr, "code");
        return { ok: false, code: code === -32602 ? "invalid_arguments" : "rpc_error" };
      }
      const first = obj(arr(at(body, "result", "content"))?.[0] ?? null);
      const inner = str(first?.text ?? null);
      if (inner === null) return { ok: false, code: "bad_response" };
      let data: Json;
      try {
        data = JSON.parse(inner) as Json;
      } catch {
        return { ok: false, code: "bad_response" };
      }
      if (at(body, "result", "isError") === true) {
        const code = str(at(data, "error", "code"));
        return { ok: false, code: code !== null && /^[a-z_]{1,40}$/.test(code) ? code : "tool_error" };
      }
      return { ok: true, data, fetchedAt: now() };
    } catch (e) {
      if (signal?.aborted) return { ok: false, code: "aborted" };
      return { ok: false, code: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult> {
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      let r: McpResult | "retry429";
      try {
        r = await once(name, args, signal);
      } catch {
        return { ok: false, code: "aborted" };
      }
      if (r !== "retry429") return r;
    }
    return { ok: false, code: "rate_limited" };
  }

  return {
    call(name, args, signal) {
      const job = tail.then(() => run(name, args, signal));
      tail = job.catch(() => undefined);
      return job;
    },
  };
}

// ---- typed, validated wrappers (input rules mirror the tool schemas) ----

const TICKER = /^[A-Za-z]{1,8}$/;
const TOKEN = /^[A-Za-z0-9]{1,12}$/;

export function validUsdt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1_000_000;
}

export function bstockAnalysis(c: McpClient, token: string, interval?: "15m" | "1h", signal?: AbortSignal): Promise<McpResult> {
  if (!TOKEN.test(token)) return Promise.resolve({ ok: false, code: "invalid_arguments" });
  return c.call("bstock_analysis", interval === undefined ? { token } : { token, interval }, signal);
}

export function stockCompare(c: McpClient, ticker?: string, usdt?: number, signal?: AbortSignal): Promise<McpResult> {
  if (ticker !== undefined && !TICKER.test(ticker)) return Promise.resolve({ ok: false, code: "invalid_arguments" });
  if (usdt !== undefined && !validUsdt(usdt)) return Promise.resolve({ ok: false, code: "invalid_arguments" });
  const args: Record<string, unknown> = {};
  if (ticker !== undefined) args.ticker = ticker;
  if (usdt !== undefined) args.usdt = usdt;
  return c.call("stock_compare", args, signal);
}

const hireCache = new Map<string, { at: number; result: McpResult }>();

export async function getHireLink(c: McpClient, agent: HireAgent, now: () => number = Date.now, signal?: AbortSignal): Promise<McpResult> {
  if (!(HIRE_AGENTS as readonly string[]).includes(agent)) return { ok: false, code: "invalid_arguments" };
  const hit = hireCache.get(agent);
  if (hit !== undefined && now() - hit.at < HIRE_TTL_MS) return hit.result;
  const r = await c.call("get_hire_link", { agent }, signal);
  if (r.ok) hireCache.set(agent, { at: now(), result: r });
  return r;
}

/** Test seam. */
export function clearHireCache(): void {
  hireCache.clear();
}

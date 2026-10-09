"use client";
/* Shared by the judge guide's Run buttons and Ask Sigma: one same-origin fetch,
   a readable body, and a plain-language reason when the call does not succeed. */
import React from "react";

import type { RunSpec } from "@/lib/judge-data";

export function PlayIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ display: "block", flex: "0 0 auto" }}>
      <path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L3.9 1.1a.6.6 0 0 0-.9.5Z" fill="currentColor" />
    </svg>
  );
}

export interface RunResult {
  status: number;
  ok: boolean;
  /** Short status label for the result header. */
  label: string;
  ms: number;
  text: string;
  /** Plain-language reason shown instead of the body when the call did not succeed for a known cause. */
  hint?: string;
}

const MAX_OUT = 60_000;
const LIVE_HOST = "4lpha.tech";

/** MCP answers wrap the tool's JSON as a string; unwrap it so the judge reads data, not escapes. */
export function pretty(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const inner = (parsed as { result?: { content?: Array<{ text?: unknown }> } }).result?.content?.[0]?.text;
    if (typeof inner === "string") {
      try { return JSON.stringify(JSON.parse(inner), null, 2); } catch { return inner; }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

/** A JSON-RPC error rides on HTTP 200, so success means a 2xx and no `error` member. */
function rpcError(raw: string): boolean {
  try { const p: unknown = JSON.parse(raw); return typeof p === "object" && p !== null && "error" in p; } catch { return false; }
}

export async function runSpec(spec: RunSpec): Promise<RunResult> {
  const started = performance.now();
  const res = await fetch(spec.path, {
    method: spec.method,
    cache: "no-store",
    ...(spec.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(spec.body) }),
  });
  const raw = await res.text();
  const ms = Math.round(performance.now() - started);
  const ok = res.ok && !rpcError(raw);
  const text = pretty(raw);
  const clipped = text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n...` : text;
  if (ok) return { status: res.status, ok, label: `HTTP ${res.status}`, ms, text: clipped };

  const onLiveHost = window.location.hostname === LIVE_HOST;
  if (res.status === 429) {
    return { status: 429, ok, label: "Rate limited", ms, text: clipped, hint: "The public endpoint allows 10 calls per minute per IP. Wait a minute, then run it again." };
  }
  if (!onLiveHost) {
    return {
      status: res.status, ok, label: "Not available on this host", ms, text: clipped,
      hint: `You are viewing this page on ${window.location.host}, where the live data tools are switched off. On ${LIVE_HOST} this call answers with live data.`,
    };
  }
  return { status: res.status, ok, label: res.ok ? "Tool error" : `HTTP ${res.status}`, ms, text: clipped };
}

/** True when the page is served from the production host. */
export function useOnLiveHost(): boolean {
  const [live, setLive] = React.useState(true);
  React.useEffect(() => setLive(window.location.hostname === LIVE_HOST), []);
  return live;
}

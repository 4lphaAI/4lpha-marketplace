/**
 * Tiny narrowing helpers for untrusted JSON (the 4lpha MCP answers and the CoinMarketCap answer).
 * Nothing here trusts a shape: every accessor returns null when the value is not what was asked for,
 * so "missing" can never turn into a number.
 */

export type Json = unknown;

export function obj(v: Json): Record<string, Json> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : null;
}

export function arr(v: Json): Json[] | null {
  return Array.isArray(v) ? v : null;
}

/** A finite number, or null. Numeric strings are NOT accepted (a string is never a measurement). */
export function num(v: Json): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function str(v: Json): string | null {
  return typeof v === "string" ? v : null;
}

export function bool(v: Json): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Follow a path of object keys; null as soon as a step is missing or not an object. */
export function at(v: Json, ...path: string[]): Json {
  let cur: Json = v;
  for (const key of path) {
    const o = obj(cur);
    if (o === null || !(key in o)) return null;
    cur = o[key];
  }
  return cur;
}

/**
 * Text that came from outside (a venue name, a symbol) before it enters Markdown: keep a conservative
 * character set, drop everything else (newlines, brackets, links, backticks), cap the length.
 */
export function safeText(v: Json, max = 32): string {
  const s = typeof v === "string" ? v : "";
  const cleaned = s.replace(/[^A-Za-z0-9 ._+\-/()%:,;]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, max);
}

/** U+2014 and U+2013 become a plain hyphen (the operator's writing rule applies to everything delivered). */
export function noDashes(s: string): string {
  return s.replace(/[\u2014\u2013]/g, "-");
}

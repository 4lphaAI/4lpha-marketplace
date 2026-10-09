/**
 * The closed request schema of the desk (three job types) and its validation.
 *
 * A request is a JSON object in the job's task description. Free text is mapped to this schema by the
 * model (see prose.ts) and then validated HERE, so the model can only ever choose a valid instance.
 * Nothing is looked up, and nothing is paid, before a request passes this file.
 */

import { obj, type Json } from "./json.js";

export type DeskRequest =
  | { readonly type: "stock_report"; readonly ticker: string; readonly usdt: number | null }
  | { readonly type: "dca_plan"; readonly ticker: string; readonly usdt: number; readonly mode: "dca" | "schedule"; readonly days: 7 | 30 }
  | { readonly type: "rebalance_plan"; readonly capital: number; readonly weights: readonly { readonly ticker: string; readonly weightPct: number }[] };

export type ParseResult =
  | { readonly ok: true; readonly request: DeskRequest }
  | { readonly ok: false; readonly reason: string };

const TICKER = /^[A-Za-z]{1,8}$/;
export const MIN_USDT = 1;
export const MAX_USDT = 1_000_000;
export const MAX_BASKET = 8;

function usdtOk(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_USDT && v <= MAX_USDT;
}

function onlyKeys(o: Record<string, Json>, allowed: readonly string[]): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown field "${k.slice(0, 20)}"`;
  return null;
}

export function validateRequest(input: Json): ParseResult {
  const o = obj(input);
  if (o === null) return { ok: false, reason: "the request is not a JSON object" };
  const type = o.type;
  if (type === "stock_report") {
    const extra = onlyKeys(o, ["type", "ticker", "usdt"]);
    if (extra !== null) return { ok: false, reason: extra };
    if (typeof o.ticker !== "string" || !TICKER.test(o.ticker)) return { ok: false, reason: "ticker must be 1 to 8 letters" };
    if (o.usdt !== undefined && !usdtOk(o.usdt)) return { ok: false, reason: "usdt must be a number from 1 to 1000000" };
    return { ok: true, request: { type, ticker: o.ticker.toUpperCase(), usdt: o.usdt === undefined ? null : (o.usdt as number) } };
  }
  if (type === "dca_plan") {
    const extra = onlyKeys(o, ["type", "ticker", "usdt", "mode", "days"]);
    if (extra !== null) return { ok: false, reason: extra };
    if (typeof o.ticker !== "string" || !TICKER.test(o.ticker)) return { ok: false, reason: "ticker must be 1 to 8 letters" };
    if (!usdtOk(o.usdt)) return { ok: false, reason: "usdt (the budget) must be a number from 1 to 1000000" };
    const mode = o.mode === undefined ? "dca" : o.mode;
    if (mode !== "dca" && mode !== "schedule") return { ok: false, reason: 'mode must be "dca" or "schedule"' };
    const days = o.days === undefined ? 7 : o.days;
    if (days !== 7 && days !== 30) return { ok: false, reason: "days must be 7 or 30" };
    return { ok: true, request: { type, ticker: o.ticker.toUpperCase(), usdt: o.usdt, mode, days } };
  }
  if (type === "rebalance_plan") {
    const extra = onlyKeys(o, ["type", "capital", "weights"]);
    if (extra !== null) return { ok: false, reason: extra };
    if (!usdtOk(o.capital)) return { ok: false, reason: "capital must be a number from 1 to 1000000" };
    const w = obj(o.weights as Json);
    if (w === null) return { ok: false, reason: 'weights must be an object such as {"NVDA":40,"MSFT":60}' };
    const keys = Object.keys(w);
    if (keys.length < 2 || keys.length > MAX_BASKET) return { ok: false, reason: `weights must name 2 to ${MAX_BASKET} stocks` };
    const seen = new Set<string>();
    const weights: { ticker: string; weightPct: number }[] = [];
    for (const k of keys) {
      const v = w[k];
      if (!TICKER.test(k)) return { ok: false, reason: "every stock in weights must be 1 to 8 letters" };
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100) return { ok: false, reason: "every weight must be a number above 0 and at most 100" };
      const t = k.toUpperCase();
      if (seen.has(t)) return { ok: false, reason: "a stock appears twice in weights" };
      seen.add(t);
      weights.push({ ticker: t, weightPct: v });
    }
    return { ok: true, request: { type, capital: o.capital, weights } };
  }
  return { ok: false, reason: 'type must be "stock_report", "dca_plan" or "rebalance_plan"' };
}

/** What the buyer sent: a JSON candidate, or free text for the model to map. */
export type RawRequest =
  | { readonly kind: "json"; readonly value: Json }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" };

const MAX_TEXT = 4000;

function firstObject(s: string): Json | undefined {
  const t = s.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t) as Json;
    } catch {
      /* fall through to the balanced scan */
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1)) as Json;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Look for the request object in the task description first, then in terms.deliverables.
 * A parsed object that is not a known request (for example a wrapper) is still returned as JSON and
 * fails validation, which delivers the formats note.
 */
export function extractRaw(task: string, terms: Record<string, unknown> | null): RawRequest {
  const t = task.slice(0, MAX_TEXT);
  const fromTask = firstObject(t);
  if (obj(fromTask ?? null) !== null) return { kind: "json", value: fromTask as Json };
  const del = terms?.deliverables;
  if (obj(del as Json) !== null) return { kind: "json", value: del as Json };
  if (typeof del === "string") {
    const fromDel = firstObject(del.slice(0, MAX_TEXT));
    if (obj(fromDel ?? null) !== null) return { kind: "json", value: fromDel as Json };
  }
  const text = t.trim();
  if (text === "") return { kind: "empty" };
  return { kind: "text", text };
}

export const FORMATS_NOTE = [
  "# 4lpha bStock Desk: request not understood",
  "",
  "Put one JSON object in the task description. Accepted formats (each job costs 0.10 USD):",
  "",
  "1. Stock report: `{\"type\":\"stock_report\",\"ticker\":\"NVDA\",\"usdt\":500}` (usdt is optional, 1 to 1000000).",
  "2. DCA or schedule plan: `{\"type\":\"dca_plan\",\"ticker\":\"NVDAB\",\"usdt\":200,\"mode\":\"dca\",\"days\":7}` (mode is \"dca\" or \"schedule\", default \"dca\"; days is 7 or 30, default 7).",
  "3. Rebalance plan: `{\"type\":\"rebalance_plan\",\"capital\":150,\"weights\":{\"NVDA\":40,\"MSFT\":30,\"SPY\":30}}` (2 to 8 stocks, weights in percent).",
  "",
  "Tickers are letters only, with or without the bStock suffix B. Plain English requests are mapped to these formats when possible.",
  "",
  "This report is data, not investment advice.",
].join("\n");

export function formatsNoteWithReason(reason: string | null): string {
  if (reason === null) return FORMATS_NOTE;
  const r = reason.replace(/[^A-Za-z0-9 ,.:"'{}()\-_/]/g, "").slice(0, 120);
  return FORMATS_NOTE.replace("Put one JSON object", `Reason: ${r}.\n\nPut one JSON object`);
}

/**
 * The self-funding leg: one paid data point per job, bought from the agent's own wallet with x402.
 *
 * Endpoint: CoinMarketCap "Quotes Latest" for BTC (id 1) and BNB (id 1839), 0.01 per call. The money
 * action is fixed code (`buyWithX402`, from the Studio x402 buyer recipe); the pinned payee, the
 * per-call cap (studio.toml merchant entry) and the daily cap ([budget].max_per_day_usd) are config,
 * not parameters. A failed or capped payment leaves the section out: the job still delivers.
 */

import { buyWithX402 } from "../x402Buyer.js";
import { arr, noDashes, num, obj, str, type Json } from "./json.js";

export const BACKDROP_URL = "https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?id=1,1839&convert=USD";
export const BACKDROP_MAX_USD = 0.05;
export const BACKDROP_SYMBOLS = ["BTC", "BNB"] as const;

export type BuyFn = (url: string, maxUsd: number, method?: string) => Promise<Record<string, unknown>>;

export interface BackdropAsset {
  readonly symbol: string;
  readonly priceUsd: number | null;
  readonly change24hPct: number | null;
}

export type Backdrop =
  | { readonly status: "paid"; readonly assets: readonly BackdropAsset[]; readonly paidUsd: number | null; readonly tx: string | null; readonly fetchedAt: number }
  | { readonly status: "unreadable"; readonly paidUsd: number | null; readonly tx: string | null; readonly fetchedAt: number }
  /** The payment was dispatched but the outcome is not clear (no settle, no refusal): never bought again for the same job. */
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "capped" | "failed"; readonly reason: string };

/** Runtime error names that mean "sent, outcome not confirmed" (verify on chain; do not retry automatically). */
const AMBIGUOUS = /OutcomeUnknown|RetryExhausted/;

function quoteUsd(quote: Json): { price: number | null; change: number | null } | null {
  const q = obj(quote);
  if (q !== null) {
    const usd = obj(q.USD);
    if (usd !== null) return { price: num(usd.price), change: num(usd.percent_change_24h) };
  }
  const list = arr(quote);
  if (list !== null) {
    for (const item of list) {
      const o = obj(item);
      if (o !== null && str(o.symbol) === "USD") return { price: num(o.price), change: num(o.percent_change_24h) };
    }
  }
  return null;
}

/** Find BTC and BNB anywhere in the answer (the endpoint's shape is not relied on beyond symbol + quote). */
export function readBackdrop(json: Json): BackdropAsset[] {
  const found = new Map<string, BackdropAsset>();
  const walk = (v: Json, depth: number): void => {
    if (depth > 6 || found.size === BACKDROP_SYMBOLS.length) return;
    const list = arr(v);
    if (list !== null) {
      for (const x of list.slice(0, 50)) walk(x, depth + 1);
      return;
    }
    const o = obj(v);
    if (o === null) return;
    const sym = str(o.symbol);
    if (sym !== null && (BACKDROP_SYMBOLS as readonly string[]).includes(sym) && !found.has(sym)) {
      const q = quoteUsd(o.quote);
      if (q !== null) found.set(sym, { symbol: sym, priceUsd: q.price !== null && q.price > 0 ? q.price : null, change24hPct: q.change });
    }
    for (const x of Object.values(o).slice(0, 50)) walk(x, depth + 1);
  };
  walk(json, 0);
  return BACKDROP_SYMBOLS.map((s) => found.get(s)).filter((a): a is BackdropAsset => a !== undefined);
}

/** A refused or failed purchase, by the runtime's error name (returned or thrown): ambiguous, capped or failed. */
function classify(rawName: string): Backdrop {
  const name = rawName.replace(/[^A-Za-z0-9_]/g, "").slice(0, 60);
  if (AMBIGUOUS.test(name)) return { status: "unknown", reason: name };
  return { status: /Budget|AmountExceeded|Cap/i.test(name) ? "capped" : "failed", reason: name };
}

/**
 * Buy the backdrop. A payment is never STARTED once the delivery deadline has passed (`signal` aborted).
 */
export async function buyBackdrop(buy: BuyFn, now: () => number = Date.now, signal?: AbortSignal): Promise<Backdrop> {
  if (signal?.aborted) return { status: "failed", reason: "deadline" };
  let r: Record<string, unknown>;
  try {
    r = await buy(BACKDROP_URL, BACKDROP_MAX_USD, "GET");
  } catch (e) {
    return classify(e instanceof Error ? noDashes(e.name) : "error");
  }
  if (r.ok !== true) return classify(typeof r.error === "string" ? r.error : "error");
  const paid = num(r.paid_usd as Json);
  const txRaw = str(r.settlement_tx as Json);
  const tx = txRaw !== null && /^0x[0-9a-fA-F]{64}$/.test(txRaw) ? txRaw : null;
  const assets = readBackdrop(r.json as Json);
  const usable = assets.filter((a) => a.priceUsd !== null);
  if (usable.length === 0) return { status: "unreadable", paidUsd: paid, tx, fetchedAt: now() };
  return { status: "paid", assets, paidUsd: paid, tx, fetchedAt: now() };
}

/**
 * Production wiring: the recipe's fixed-code buyer. A static import on purpose: the NodeOps zip bundler
 * follows it for certain, and importing the module does not touch the wallet (getWallet() runs per call).
 */
export const defaultBuy: BuyFn = (url, maxUsd, method) => buyWithX402(url, maxUsd, method ?? "GET");

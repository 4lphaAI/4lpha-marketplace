/**
 * Strict readers for the two data answers (`stock_compare`, `bstock_analysis`).
 *
 * Every field is read through a narrowing accessor, enumerations are closed lists, and free text is
 * either dropped or run through safeText. A missing or malformed field becomes null, never a number.
 */

import { arr, at, bool, num, obj, safeText, str, type Json } from "./json.js";

export type Issuer = "bstock" | "ondo";
const ISSUERS: readonly string[] = ["bstock", "ondo"];
const STALENESS: readonly string[] = ["fresh", "stale", "dead"];
const ROUTES: readonly string[] = ["rfq", "amm", "mixed"];
const SIZE_CODES: readonly string[] = ["no_route", "quote_failed", "decimals_mismatch", "implausible", "sell_no_route", "sell_failed"];
const AVOID_REASONS: readonly string[] = ["buy_cost", "round_trip", "no_exit"];

function closed(v: Json, list: readonly string[]): string | null {
  const s = str(v);
  return s !== null && list.includes(s) ? s : null;
}

export interface CompareSize {
  readonly usdt: number;
  readonly ok: boolean;
  readonly code: string | null;
  readonly shares: number | null;
  readonly costBps: number | null;
  readonly roundTripBps: number | null;
  readonly route: string | null;
  readonly venues: readonly string[];
}
export interface CompareVersion {
  readonly issuer: Issuer;
  readonly symbol: string;
  readonly openState: boolean | null;
  readonly marketStatus: string | null;
  readonly sizes: readonly CompareSize[];
}
export interface CompareVerdict {
  readonly usdt: number;
  readonly unreadable: boolean;
  readonly best: Issuer | null;
  readonly edgeBps: number | null;
  readonly aboutSame: boolean;
  readonly avoid: readonly { readonly issuer: Issuer; readonly reasons: readonly string[] }[] | null;
  readonly only: Issuer | null;
}
export interface Compare {
  readonly ticker: string;
  readonly quotedAt: number | null;
  readonly staleness: string | null;
  readonly referencePriceUsd: number | null;
  readonly sizeUsedUsdt: number | null;
  readonly sizeNote: string | null;
  readonly versions: readonly CompareVersion[];
  readonly verdicts: readonly CompareVerdict[];
}

export function readCompare(data: Json): Compare | null {
  const o = obj(data);
  if (o === null) return null;
  const ticker = safeText(o.ticker, 12).toUpperCase();
  if (!/^[A-Z]{1,8}$/.test(ticker) || arr(o.versions) === null) return null;
  const versions: CompareVersion[] = [];
  for (const raw of (arr(o.versions) as Json[]).slice(0, 2)) {
    const v = obj(raw);
    const issuer = v === null ? null : closed(v.issuer, ISSUERS);
    if (v === null || issuer === null) continue;
    const sizes: CompareSize[] = [];
    for (const rs of (arr(v.sizes) ?? []).slice(0, 5)) {
      const s = obj(rs);
      const usdt = s === null ? null : num(s.usdt);
      if (s === null || usdt === null) continue;
      sizes.push({
        usdt,
        ok: s.ok === true,
        code: closed(s.code, SIZE_CODES),
        shares: num(s.shares),
        costBps: num(s.costBps),
        roundTripBps: num(s.roundTripBps),
        route: closed(s.route, ROUTES),
        venues: (arr(s.venues) ?? []).slice(0, 4).map((x) => safeText(x, 32)).filter((x) => x !== ""),
      });
    }
    versions.push({
      issuer: issuer as Issuer,
      symbol: safeText(v.symbol, 14),
      openState: bool(v.openState),
      marketStatus: v.marketStatus === null || v.marketStatus === undefined ? null : safeText(v.marketStatus, 32) || null,
      sizes,
    });
  }
  const verdicts: CompareVerdict[] = [];
  for (const rv of (arr(o.verdicts) ?? []).slice(0, 5)) {
    const v = obj(rv);
    const usdt = v === null ? null : num(v.usdt);
    if (v === null || usdt === null) continue;
    const best = v.best === null ? null : closed(v.best, ISSUERS);
    const only = v.only === null ? null : closed(v.only, ISSUERS);
    let avoid: { issuer: Issuer; reasons: string[] }[] | null = null;
    const rawAvoid = arr(v.avoid);
    if (rawAvoid !== null) {
      avoid = [];
      for (const ra of rawAvoid.slice(0, 2)) {
        const a = obj(ra);
        const ai = a === null ? closed(ra, ISSUERS) : closed(a.issuer, ISSUERS);
        if (ai === null) {
          avoid = null;
          break;
        }
        const reasons = a === null ? [] : (arr(a.reasons) ?? []).map((r) => closed(r, AVOID_REASONS)).filter((r): r is string => r !== null).slice(0, 3);
        avoid.push({ issuer: ai as Issuer, reasons });
      }
    }
    const bad = v.unreadable === true || (v.best !== null && best === null) || (v.only !== null && only === null) || avoid === null || typeof v.about_same !== "boolean";
    verdicts.push({
      usdt,
      unreadable: bad,
      best: bad ? null : (best as Issuer | null),
      edgeBps: num(v.edgeBps),
      aboutSame: bad ? false : v.about_same === true,
      avoid: bad ? null : avoid,
      only: bad ? null : (only as Issuer | null),
    });
  }
  return {
    ticker,
    quotedAt: num(o.quotedAt),
    staleness: closed(o.staleness, STALENESS),
    referencePriceUsd: num(o.referencePriceUsd),
    sizeUsedUsdt: num(o.sizeUsedUsdt),
    sizeNote: str(o.sizeNote) === null ? null : safeText(o.sizeNote, 160) || null,
    versions,
    verdicts,
  };
}

// ---------------------------------------------------------------------------------------------

export interface Metric {
  readonly value: number | null;
  readonly reason: string | null;
}
export type Indicators =
  | { readonly error: string }
  | { readonly calculatedAt: number | null; readonly staleness: string | null; readonly source: string | null; readonly metrics: Readonly<Record<string, Metric>> };

export interface Analysis {
  readonly symbol: string;
  readonly underlying: string | null;
  readonly staleness: string | null;
  readonly openState: boolean | null;
  readonly sessionState: string | null;
  readonly price: {
    readonly venuePriceUsd: number | null;
    readonly navUsd: number | null;
    readonly referencePriceUsd: number | null;
    readonly premiumBps: number | null;
    readonly asOf: number | null;
  };
  readonly depth: { readonly venueCount: number | null; readonly liquidityUsd: number | null; readonly volume24hUsd: number | null; readonly deepPool: boolean | null; readonly venue: string | null } | null;
  readonly eligibility: { readonly eligible: boolean | null; readonly reason: string | null } | { readonly error: string };
  readonly indicators: { readonly "15m": Indicators | null; readonly "1h": Indicators | null };
  readonly regime: { readonly label: string | null; readonly asOf: number | null; readonly staleness: string | null } | { readonly error: string };
}

const REGIMES: readonly string[] = ["risk_on", "risk_off", "neutral", "unavailable"];
const SESSION_STATES: readonly string[] = ["rth", "overnight", "close", "pre", "post"];

function errCode(v: Json): string {
  const c = str(at(v, "error"));
  return c !== null && /^[a-z_]{1,40}$/.test(c) ? c : "unavailable";
}

function readIndicators(v: Json): Indicators | null {
  const o = obj(v);
  if (o === null) return null;
  if ("error" in o) return { error: errCode(o) };
  const m = obj(o.metrics);
  if (m === null) return { error: "unavailable" };
  const metrics: Record<string, Metric> = {};
  for (const [k, raw] of Object.entries(m).slice(0, 60)) {
    if (!/^[A-Za-z0-9]{1,24}$/.test(k)) continue;
    const mo = obj(raw);
    if (mo === null) continue;
    const reason = str(mo.reason);
    metrics[k] = { value: num(mo.value), reason: reason !== null && /^[a-z_]{1,40}$/.test(reason) ? reason : null };
  }
  return {
    calculatedAt: num(o.calculatedAt),
    staleness: closed(o.staleness, STALENESS),
    source: closed(o.source, ["pool", "underlying"]),
    metrics,
  };
}

export function readAnalysis(data: Json): Analysis | null {
  const o = obj(data);
  if (o === null) return null;
  const symbol = safeText(at(o, "token", "symbol"), 14);
  if (!/^[A-Za-z0-9]{1,14}$/.test(symbol)) return null;
  const deepest = obj(at(o, "depth", "deepest"));
  const eligibility = obj(o.eligibility);
  const regime = obj(o.regime);
  const ind = obj(o.indicators);
  return {
    symbol,
    underlying: (() => {
      const u = safeText(at(o, "token", "underlyingTicker"), 12);
      return /^[A-Z]{1,8}$/.test(u) ? u : null;
    })(),
    staleness: closed(o.staleness, STALENESS),
    openState: bool(at(o, "market", "openState")),
    sessionState: closed(at(o, "market", "session", "state"), SESSION_STATES),
    price: {
      venuePriceUsd: num(at(o, "price", "venuePriceUsd")),
      navUsd: num(at(o, "price", "navUsd")),
      referencePriceUsd: num(at(o, "price", "referencePriceUsd")),
      premiumBps: num(at(o, "price", "premiumBps")),
      asOf: num(at(o, "price", "asOf")),
    },
    depth:
      obj(o.depth) === null
        ? null
        : {
            venueCount: num(at(o, "depth", "venueCount")),
            liquidityUsd: deepest === null ? null : num(deepest.liquidityUsd),
            volume24hUsd: deepest === null ? null : num(deepest.volume24hUsd),
            deepPool: bool(at(o, "depth", "deepPool")),
            venue: deepest === null ? null : [safeText(deepest.dex, 20), safeText(deepest.version, 6)].filter((x) => x !== "").join(" ") || null,
          },
    eligibility:
      eligibility === null || "error" in eligibility
        ? { error: eligibility === null ? "unavailable" : errCode(eligibility) }
        : { eligible: bool(eligibility.eligible), reason: (() => {
            const r = str(eligibility.reason);
            return r !== null && /^[a-z_]{1,40}$/.test(r) ? r : null;
          })() },
    indicators: { "15m": ind === null ? null : readIndicators(ind["15m"]), "1h": ind === null ? null : readIndicators(ind["1h"]) },
    regime:
      regime === null || "error" in regime
        ? { error: regime === null ? "unavailable" : errCode(regime) }
        : { label: closed(regime.label, REGIMES), asOf: num(regime.asOf), staleness: closed(regime.staleness, STALENESS) },
  };
}

/** The value of a metric when it has one: null covers missing, stale and error sections alike. */
export function metricValue(ind: Indicators | null, name: string): number | null {
  if (ind === null || "error" in ind) return null;
  return ind.metrics[name]?.value ?? null;
}

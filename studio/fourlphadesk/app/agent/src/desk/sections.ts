/**
 * Report sections shared by the three handlers. Every sentence here is built by code from the parsed
 * data; thresholds are plain constants. A missing value prints "n/a" with its reason, never a number.
 */

import { bps, fixed, NA, pct, table, ts, usd } from "./fmt.js";
import {
  metricValue,
  type Analysis,
  type Compare,
  type CompareSize,
  type CompareVerdict,
  type CompareVersion,
  type Indicators,
  type Issuer,
} from "./parse.js";

export const PREMIUM_CLOSE_BPS = 50;
export const PREMIUM_WIDE_BPS = 150;
export const COST_WARN_BPS = 200;
export const RSI_HIGH = 70;
export const RSI_LOW = 30;

export function unavailable(what: string, code: string): string {
  return `- ${what}: unavailable (${code}).`;
}

export function versionOf(c: Compare | null, issuer: Issuer): CompareVersion | null {
  return c?.versions.find((v) => v.issuer === issuer) ?? null;
}

export function sizeRow(v: CompareVersion | null, usdtSize: number | null): CompareSize | null {
  if (v === null || usdtSize === null) return null;
  return v.sizes.find((s) => s.usdt === usdtSize) ?? null;
}

export function verdictAt(c: Compare | null, usdtSize: number | null): CompareVerdict | null {
  if (c === null || usdtSize === null) return null;
  return c.verdicts.find((v) => v.usdt === usdtSize) ?? null;
}

const REASON_WORDS: Record<string, string> = {
  buy_cost: "buying costs too much over the share price",
  round_trip: "buying and selling straight back loses too much",
  no_exit: "the sell-back quote failed",
};

export function verdictLine(v: CompareVerdict): string {
  if (v.unreadable) return `At ${v.usdt} USDT: the verdict could not be read, so nothing is concluded for this size.`;
  const parts: string[] = [];
  if (v.only !== null) parts.push(`only the ${v.only} version has a route`);
  else if (v.best !== null) parts.push(`${v.best} is the better buy (edge ${fixed(v.edgeBps, 1)} bps)`);
  else if (v.aboutSame) parts.push(`the two versions are about the same (edge ${fixed(v.edgeBps, 1)} bps), either is fine`);
  else parts.push("no clear leader");
  for (const a of v.avoid ?? []) {
    const why = a.reasons.map((r) => REASON_WORDS[r] ?? r).join("; ");
    parts.push(`avoid ${a.issuer}${why === "" ? "" : ` (${why})`}`);
  }
  return `At ${v.usdt} USDT: ${parts.join("; ")}.`;
}

export function compareSection(c: Compare | null, failCode: string | null): string[] {
  const out: string[] = ["## Where to buy (4lpha quote comparison)"];
  if (c === null) {
    out.push(unavailable("quote comparison", failCode ?? "no_data"));
    return out;
  }
  out.push(`Quotes taken ${ts(c.quotedAt)} (${c.staleness ?? "age unknown"}). Reference share price: ${usd(c.referencePriceUsd)} USD.`);
  if (c.sizeNote !== null) out.push(c.sizeNote);
  const rows: string[][] = [];
  for (const v of c.versions) {
    for (const s of v.sizes) {
      rows.push([
        `${v.symbol} (${v.issuer})`,
        String(s.usdt),
        s.ok ? bps(s.costBps) : `no quote (${s.code ?? "unknown"})`,
        s.ok ? (s.roundTripBps === null ? `n/a (${s.code ?? "exit not checked"})` : bps(s.roundTripBps)) : NA,
        s.route ?? NA,
      ]);
    }
  }
  if (rows.length > 0) {
    out.push("", ...table(["Version", "USDT", "Cost over share price", "Round trip loss", "Route"], rows));
  } else {
    out.push(unavailable("per-size quotes", "no_quotes"));
  }
  out.push("");
  if (c.verdicts.length === 0) out.push(unavailable("verdicts", "none_returned"));
  for (const v of c.verdicts) out.push(`- ${verdictLine(v)}`);
  out.push("- 4lpha's hosted agents buy the bStock version only.");
  return out;
}

type MetricRow = readonly [label: string, key: string, dp: number, suffix: string];
const METRIC_ROWS: readonly MetricRow[] = [
  ["RSI (14)", "rsi14", 1, ""],
  ["MACD histogram", "histogram", 3, ""],
  ["EMA12/EMA26 spread", "emaSpreadPct", 2, " %"],
  ["Bollinger position (0 to 1)", "bbPosition20", 2, ""],
  ["Stochastic RSI (0 to 1)", "stochRsi14", 2, ""],
  ["ATR", "atrPct", 2, " %"],
  ["Relative volume (20)", "rvol20", 2, "x"],
  ["Distance to session VWAP", "vwapDistancePct", 2, " %"],
  ["Gap to last close", "gapPct", 2, " %"],
];

function cell(ind: Indicators | null, key: string, dp: number, suffix: string): string {
  if (ind === null) return "not returned";
  if ("error" in ind) return `error (${ind.error})`;
  const m = ind.metrics[key];
  if (m === undefined) return NA;
  if (m.value === null) return m.reason === null ? NA : `n/a (${m.reason})`;
  return `${fixed(m.value, dp)}${suffix}`;
}

export function indicatorTime(ind: Indicators | null): number | null {
  return ind === null || "error" in ind ? null : ind.calculatedAt;
}

function intervalStamp(ind: Indicators | null): string {
  if (ind === null) return "not returned";
  if ("error" in ind) return `error (${ind.error})`;
  return `${ts(ind.calculatedAt)} (${ind.staleness ?? "age unknown"}${ind.source === "underlying" ? ", computed on the share price" : ""})`;
}

export function readings(ind: Indicators | null): string[] {
  const out: string[] = [];
  const rsi = metricValue(ind, "rsi14");
  if (rsi !== null) out.push(`RSI ${fixed(rsi, 1)}: ${rsi >= RSI_HIGH ? "overbought zone" : rsi <= RSI_LOW ? "oversold zone" : "neutral zone"}.`);
  const hist = metricValue(ind, "histogram");
  if (hist !== null) out.push(`MACD histogram ${fixed(hist, 3)}: momentum is ${hist > 0 ? "positive" : hist < 0 ? "negative" : "flat"}.`);
  const spread = metricValue(ind, "emaSpreadPct");
  if (spread !== null) out.push(`EMA12 is ${spread > 0 ? "above" : spread < 0 ? "below" : "level with"} EMA26 (${fixed(spread, 2)} %): short trend ${spread > 0 ? "up" : spread < 0 ? "down" : "flat"}.`);
  const bb = metricValue(ind, "bbPosition20");
  if (bb !== null) out.push(`Bollinger position ${fixed(bb, 2)}: ${bb < 0.2 ? "near or below the lower band" : bb > 0.8 ? "near or above the upper band" : "inside the bands"}.`);
  return out;
}

export function technicalsSection(a: Analysis | null, failCode: string | null): string[] {
  const out: string[] = ["## Technical reading (indicators 4lpha's AI Trade agent reads)"];
  if (a === null) {
    out.push(unavailable("indicators", failCode ?? "no_data"));
    return out;
  }
  const i15 = a.indicators["15m"];
  const i1h = a.indicators["1h"];
  out.push(`15m series: ${intervalStamp(i15)}. 1h series: ${intervalStamp(i1h)}.`, "");
  out.push(...table(["Metric", "15m", "1h"], METRIC_ROWS.map(([label, key, dp, suffix]) => [label, cell(i15, key, dp, suffix), cell(i1h, key, dp, suffix)])));
  const r1 = readings(i1h);
  const r15 = readings(i15);
  out.push("");
  if (r1.length > 0) out.push(...r1.map((l) => `- 1h: ${l}`));
  if (r15.length > 0) out.push(...r15.map((l) => `- 15m: ${l}`));
  if (r1.length === 0 && r15.length === 0) out.push("- No indicator has a value right now (stale or missing series), so no technical reading is given.");
  if (!("error" in a.regime)) {
    out.push(`- Market regime (SPY and QQQ): ${a.regime.label ?? NA} as of ${ts(a.regime.asOf)} (${a.regime.staleness ?? "age unknown"}).`);
  } else {
    out.push(unavailable("market regime", a.regime.error));
  }
  return out;
}

export function premiumWord(premiumBps: number | null): string {
  if (premiumBps === null) return "premium unknown";
  const abs = Math.abs(premiumBps);
  const side = premiumBps > 0 ? "above" : premiumBps < 0 ? "below" : "at";
  if (abs <= PREMIUM_CLOSE_BPS) return `close to NAV (${abs} bps ${side})`;
  if (abs <= PREMIUM_WIDE_BPS) return `${abs} bps ${side} NAV`;
  return `wide: ${abs} bps ${side} NAV`;
}

export function priceSection(a: Analysis | null, failCode: string | null): string[] {
  const out: string[] = ["## Price, premium and session"];
  if (a === null) {
    out.push(unavailable("price and session", failCode ?? "no_data"));
    return out;
  }
  const p = a.price;
  out.push(
    `- Venue price: ${usd(p.venuePriceUsd)} USD per ${a.symbol} token; NAV ${usd(p.navUsd)} USD; underlying share ${usd(p.referencePriceUsd)} USD (as of ${ts(p.asOf)}).`,
    `- Premium: ${premiumWord(p.premiumBps)}.`,
    `- US market session: ${a.sessionState ?? NA}${a.openState === null ? "" : a.openState ? ", the token is tradable now" : ", the token market is closed now"}.`,
  );
  const d = a.depth;
  if (d === null) out.push(unavailable("pool depth", "no_data"));
  else {
    out.push(
      `- Deepest pool: ${d.venue ?? NA}, liquidity ${usd(d.liquidityUsd, 0)} USD, 24h volume ${usd(d.volume24hUsd, 0)} USD, ${d.venueCount ?? NA} venues in total${d.deepPool === null ? "" : d.deepPool ? "; a deep pool" : "; a shallow pool"}.`,
    );
  }
  if ("error" in a.eligibility) out.push(unavailable("eligibility for 4lpha's agents", a.eligibility.error));
  else out.push(`- Tradable by 4lpha's agents: ${a.eligibility.eligible === null ? NA : a.eligibility.eligible ? "yes" : "no"}${a.eligibility.reason === null ? "" : ` (${a.eligibility.reason})`}.`);
  return out;
}

/** Automatic flags: each one is a threshold on a number shown elsewhere in the report. */
export function riskFlags(a: Analysis | null, c: Compare | null, sizeUsdt: number | null): string[] {
  const out: string[] = [];
  if (a !== null) {
    if (a.staleness !== null && a.staleness !== "fresh") out.push(`The token data is ${a.staleness}, so prices and indicators may lag.`);
    if (a.sessionState !== null && a.sessionState !== "rth") out.push(`The US regular session is not open (${a.sessionState}): the share price is last close, the token price can drift from it.`);
    const pr = a.price.premiumBps;
    if (pr !== null && Math.abs(pr) > PREMIUM_WIDE_BPS) out.push(`The premium to NAV is ${pr} bps, wider than ${PREMIUM_WIDE_BPS} bps.`);
    if (a.depth?.deepPool === false) out.push("The deepest pool is shallow, so larger amounts can move the price.");
    if (!("error" in a.eligibility) && a.eligibility.eligible === false) out.push("4lpha's agents do not trade this token right now.");
    if (!("error" in a.regime) && a.regime.label === "risk_off") out.push("The market regime (SPY and QQQ) reads risk off.");
    const rsi = metricValue(a.indicators["1h"], "rsi14");
    if (rsi !== null && rsi >= RSI_HIGH) out.push(`The 1h RSI is ${fixed(rsi, 1)}, in the overbought zone.`);
    if (rsi !== null && rsi <= RSI_LOW) out.push(`The 1h RSI is ${fixed(rsi, 1)}, in the oversold zone.`);
  }
  const b = versionOf(c, "bstock");
  const row = sizeRow(b, sizeUsdt);
  if (row !== null) {
    if (row.costBps !== null && row.costBps > COST_WARN_BPS) out.push(`Buying ${sizeUsdt} USDT costs ${row.costBps} bps over the share price.`);
    if (row.roundTripBps !== null && row.roundTripBps > COST_WARN_BPS) out.push(`Buying and selling back ${sizeUsdt} USDT loses ${row.roundTripBps} bps.`);
    if (row.ok && row.roundTripBps === null) out.push("The exit could not be quoted at this size, so the cost of selling back is unknown.");
  }
  if (c !== null && c.staleness !== null && c.staleness !== "fresh") out.push(`The quote comparison is ${c.staleness}.`);
  return out;
}

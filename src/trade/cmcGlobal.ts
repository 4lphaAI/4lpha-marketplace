/** Tolerant parsing of CMC global-metrics text into a crypto regime signal (TRADFI-AI-TRADE-V3 §6.2, TRADFI-CMC-EQUITY R-B). Pure. */

export type CryptoRegime = "risk_on" | "risk_off" | "neutral" | "unavailable";

export type GlobalMetrics = {
  readonly mcap24hPct: number | null;
  readonly mcap7dPct: number | null;
  readonly fearGreed: number | null;
  readonly volume24hPct: number | null;
};

/** TRADFI-CMC-EQUITY R2.4: macro-event risk now comes from `macro_news_aggregator` (`cmcUsEquity.ts`), not this crypto-wide tool. */
export type MacroEventRisk = "high" | "none";

function numberIn(fragment: string, key: string): number | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"?([+-]?[\\d.]+)\\s*%?"?`, "i");
  const match = re.exec(fragment);
  if (!match || match[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Finds a top-level object by key and returns a bounded window of its own body (not siblings). */
function objectWindow(text: string, key: string): string | null {
  const anchor = new RegExp(`"${key}"\\s*:\\s*\\{`, "i").exec(text);
  if (!anchor) return null;
  const start = anchor.index + anchor[0].length;
  return text.slice(start, Math.min(text.length, start + 1_200));
}

/**
 * Percent-change window shape MEASURED on the first paid `get_global_metrics_latest`
 * row (2026-09-22 00:49 UTC, agent tradfi-trade-agent-01):
 *   "total_crypto_market_cap_usd":{"current":"2.93 T","percent_change":{"24h":"+4.43%","7d":"+10.11%",...}}
 *   "volume24h":{"total":{"current":"146.93 B","percent_change":{"24h":"+105.89%",...}}}
 *   "sentiment":{"fear_greed":{"definition":"...","index":{"current":NN,...}}}
 * The description-derived keys (`total_market_cap`, `change_24h`) never occur; both
 * spellings are accepted so a future rename degrades to null, never to a wrong number.
 */
function percentChange(window: string | null, horizon: "24h" | "7d"): number | null {
  if (window === null) return null;
  const pc = objectWindow(window, "percent_change");
  return (pc === null ? null : numberIn(pc, horizon)) ?? numberIn(window, `change_${horizon}`);
}

/** Tolerant regex over the display-string JSON text; null on any miss, never throws. */
export function parseGlobalMetrics(text: string): GlobalMetrics {
  if (typeof text !== "string" || text.length === 0) {
    return { mcap24hPct: null, mcap7dPct: null, fearGreed: null, volume24hPct: null };
  }
  const mcapWindow = objectWindow(text, "total_crypto_market_cap_usd") ?? objectWindow(text, "total_market_cap");
  const volumeOuter = objectWindow(text, "volume24h");
  const volumeWindow = (volumeOuter === null ? null : objectWindow(volumeOuter, "total")) ?? objectWindow(text, "total_volume_24h");
  const fearWindow = objectWindow(text, "fear_greed") ?? objectWindow(text, "fear_and_greed");
  // MEASURED 2026-09-23: "fear_greed":{"definition":"…","current":{"value":"Greed","index":77},"history":{…}}.
  const fearCurrent = fearWindow === null ? null : objectWindow(fearWindow, "current");
  const fearIndex = fearWindow === null ? null : objectWindow(fearWindow, "index");
  const mcap24hPct = percentChange(mcapWindow, "24h");
  const mcap7dPct = percentChange(mcapWindow, "7d");
  const fearGreed = (fearCurrent === null ? null : numberIn(fearCurrent, "index"))
    ?? (fearIndex === null ? null : numberIn(fearIndex, "current"))
    ?? (fearWindow === null ? null : numberIn(fearWindow, "value"));
  const volume24hPct = percentChange(volumeWindow, "24h");
  return { mcap24hPct, mcap7dPct, fearGreed, volume24hPct };
}

export function globalRegime(metrics: GlobalMetrics): CryptoRegime {
  const { mcap24hPct, mcap7dPct, volume24hPct } = metrics;
  if (mcap24hPct === null) return "unavailable";
  if (mcap24hPct <= -2.5 || (mcap24hPct <= -1.2 && volume24hPct !== null && volume24hPct >= 40)) return "risk_off";
  if (mcap24hPct >= 1.2 && mcap7dPct !== null && mcap7dPct >= 0) return "risk_on";
  return "neutral";
}

/** §6.2: regime size scale, discounted 0.6x on high macro-event risk. */
export function regimeSizeScale(regime: CryptoRegime, eventRisk: MacroEventRisk): number {
  const base = regime === "risk_off" ? 0.55 : regime === "risk_on" ? 1.12 : 1;
  return eventRisk === "high" ? base * 0.6 : base;
}

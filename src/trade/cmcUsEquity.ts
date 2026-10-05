/**
 * TRADFI-CMC-EQUITY Rev 2 / Rev 2.1: parsers, ingest compaction, prompt-line
 * rendering, the ticker -> sector/theme map, the macro closed set, and the
 * NYSE-clock due/validity helpers for the four US-equity CMC skills. Pure, no
 * I/O; every field path is measured on `scripts/tmp/probe-*.json` (see
 * `MD here/CMC-PROBES-2026-09-23.md` and the Rev 2/2.1 spec, R2.1-R2.6).
 */

import { CMC_EVENT_CALENDAR_ENABLED, CMC_GLOBAL_TOOL, CMC_MAX_TICKER_CHARS } from "./cmc.js";

export const CMC_SKILL_MACRO = "macro_news_aggregator";
export const CMC_SKILL_SECTOR = "us_equity_sector_rotation";
export const CMC_SKILL_SCANNER = "us_equity_uptrend_quality_scanner";
export const CMC_SKILL_PLANNING = "us_equity_trade_planning_context";
/** TRADFI-LLM-CMC-REQUEST §6: measured by the G0 probe 2026-09-25; LLM-requested only, never scheduled. */
export const CMC_SKILL_EVENTS = "us_equity_upcoming_event_calendar";
/** N4: at most one "+1 after release" call per calendar day; tracked as a distinct store key so the daily row is never overwritten by it. */
export const CMC_SKILL_MACRO_RELEASE = "macro_news_aggregator:release";

/** R2.7: the current skill/tool set, for filtering an owner-readable news log — old `_GLOBAL` crypto tools, `_PROBE` rows and the dossier are filtered OUT, never deleted. */
export const CMC_CURRENT_SKILLS: ReadonlySet<string> = new Set([
  CMC_SKILL_MACRO, CMC_SKILL_MACRO_RELEASE, CMC_SKILL_SECTOR, CMC_SKILL_SCANNER, CMC_SKILL_PLANNING, CMC_GLOBAL_TOOL, CMC_SKILL_EVENTS,
]);
export function isCurrentCmcSkill(skill: string): boolean { return CMC_CURRENT_SKILLS.has(skill); }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * R2.2: a skill's MCP text content is a JSON string of the wrapper
 * `{result:{output:"<pack json>"}}` (planning/sector/scanner) or
 * `{result:{data:{...pack}}}` (macro, object already). The pack itself is
 * `{type, skill_id, timestamp, data:{...}}`; this returns the pack's `data`.
 */
function skillPackData(text: string, envelope: "output" | "data"): Record<string, unknown> | null {
  let wrapper: unknown;
  try { wrapper = JSON.parse(text) as unknown; } catch { return null; }
  if (!record(wrapper) || !record(wrapper["result"])) return null;
  const result = wrapper["result"];
  let pack: unknown;
  // Live 2026-09-26/27: the SAME skill (macro) comes back either as a
  // `result.data` object or as a `result.output` JSON string, call to call.
  // The "data" callers accept both; the "output" callers stay as measured.
  if (envelope === "data" && !record(result["data"]) && typeof result["output"] === "string") {
    try { pack = JSON.parse(result["output"]) as unknown; } catch { return null; }
  } else if (envelope === "data") {
    pack = result["data"];
  } else {
    const output = result["output"];
    if (typeof output !== "string") return null;
    try { pack = JSON.parse(output) as unknown; } catch { return null; }
  }
  if (!record(pack) || !record(pack["data"])) return null;
  return pack["data"];
}

// ---------------------------------------------------------------------------
// Sector rotation (§R2.2, R2.6)
// ---------------------------------------------------------------------------

export type SectorRow = {
  readonly group: string;
  readonly rank: number | null;
  readonly excess21Pct: number | null;
  readonly rotationState: string | null;
};
export type SectorBenchmark = { readonly benchmark: string; readonly changeFromOpenPct: number | null };
export type CompactSector = {
  readonly sectors: readonly SectorRow[];
  readonly themes: readonly SectorRow[];
  readonly styleLeader: string | null;
  readonly styleExcessPp: number | null;
  readonly benchmarks: readonly SectorBenchmark[];
};

function readSectorRow(value: unknown): SectorRow | null {
  if (!record(value)) return null;
  const group = str(value["group"]);
  if (group === null) return null;
  const metrics = record(value["metrics"]) ? value["metrics"] : null;
  const excess = metrics && record(metrics["excess_pct"]) ? metrics["excess_pct"] : null;
  const vsSp500 = excess && record(excess["vs_sp500"]) ? excess["vs_sp500"] : null;
  return {
    group,
    rank: metrics ? num(metrics["rank"]) : null,
    excess21Pct: vsSp500 ? num(vsSp500["current_21_session"]) : null,
    rotationState: metrics ? str(metrics["rotation_state"]) : null,
  };
}

function readSectorPack(data: Record<string, unknown>): CompactSector | null {
  const evidence = record(data["evidence"]) ? data["evidence"] : null;
  if (evidence === null) return null;
  // Shape validity is structural (the arrays exist), not content-based: a
  // legitimately empty rotation list must still compact to an `available` row.
  if (!Array.isArray(evidence["sector_rotation"]) || !Array.isArray(evidence["theme_rotation"])) return null;
  const sectors = arr(evidence["sector_rotation"]).map(readSectorRow).filter((row): row is SectorRow => row !== null);
  const themes = arr(evidence["theme_rotation"]).map(readSectorRow).filter((row): row is SectorRow => row !== null);
  const gvd = record(evidence["growth_vs_defensive"]) ? evidence["growth_vs_defensive"] : null;
  const benchmarks = arr(evidence["benchmark_context"]).flatMap((row) => {
    if (!record(row)) return [];
    const benchmark = str(row["benchmark"]);
    if (benchmark === null) return [];
    const obs = record(row["market_observation"]) ? row["market_observation"] : null;
    return [{ benchmark, changeFromOpenPct: obs ? num(obs["change_from_open_pct"]) : null }];
  });
  return {
    sectors, themes,
    styleLeader: gvd ? str(gvd["style_leader"]) : null,
    styleExcessPp: gvd ? num(gvd["growth_minus_defensive_pp"]) : null,
    benchmarks,
  };
}

/** Parses the full raw MCP text and returns a bounded compact JSON string, or null on an unrecognized shape. */
export function compactSectorRotation(rawText: string): string | null {
  const data = skillPackData(rawText, "output");
  if (data === null) return null;
  const compact = readSectorPack(data);
  if (compact === null) return null;
  return JSON.stringify(compact);
}
export function readCompactSector(text: string): CompactSector | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return null; }
  if (!record(parsed) || !Array.isArray(parsed["sectors"]) || !Array.isArray(parsed["themes"]) || !Array.isArray(parsed["benchmarks"])) return null;
  return parsed as unknown as CompactSector;
}

// ---------------------------------------------------------------------------
// Uptrend scanner (§R2.2, R2.6)
// ---------------------------------------------------------------------------

export type ScannerCandidate = {
  readonly symbol: string;
  readonly classification: string | null;
  readonly status: string | null;
  readonly weeksInUptrend: number | null;
  readonly rel63dPct: number | null;
};
export type CompactScanner = { readonly asOfTradingDay: string | null; readonly candidates: readonly ScannerCandidate[] };

function readScannerCandidate(value: unknown): ScannerCandidate | null {
  if (!record(value)) return null;
  const symbol = str(value["symbol"]);
  if (symbol === null) return null;
  const setup = record(value["setup"]) ? value["setup"] : null;
  const indicators = arr(value["key_indicators"]);
  let weeksInUptrend: number | null = null;
  let rel63dPct: number | null = null;
  for (const indicator of indicators) {
    if (!record(indicator)) continue;
    const metrics = record(indicator["metrics"]) ? indicator["metrics"] : null;
    if (metrics === null) continue;
    if (indicator["indicator"] === "trend_persistence") weeksInUptrend = num(metrics["weeks_in_uptrend"]);
    if (indicator["indicator"] === "relative_returns_vs_spy") rel63dPct = num(metrics["63d_pct"]);
  }
  return { symbol: symbol.toUpperCase(),
    classification: setup ? str(setup["classification"]) : null,
    status: setup ? str(setup["status"]) : null,
    weeksInUptrend, rel63dPct };
}

/** H1: the pack has NO `data.evidence` level; `alpha_candidates[]` sits directly under `data`. */
export function compactScanner(rawText: string): string | null {
  const data = skillPackData(rawText, "output");
  if (data === null) return null;
  const allCandidates = arr(data["alpha_candidates"]).map(readScannerCandidate).filter((row): row is ScannerCandidate => row !== null);
  const asOfTradingDay = str(data["as_of_trading_day"]);
  if (allCandidates.length === 0 && asOfTradingDay === null) return null;
  // AUDIT HIGH-3: self-bound, never sliced as raw JSON downstream. The vendor's
  // own array order is rank order (measured), so a greedy keep-in-order pass
  // drops the lowest-ranked candidates first once the cap is hit.
  const kept: ScannerCandidate[] = [];
  const serialize = (): string => JSON.stringify({ asOfTradingDay, candidates: kept });
  for (const candidate of allCandidates) {
    kept.push(candidate);
    if (serialize().length > CMC_MAX_TICKER_CHARS) kept.pop();
  }
  return serialize();
}
export function readCompactScanner(text: string): CompactScanner | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return null; }
  if (!record(parsed) || !Array.isArray(parsed["candidates"])) return null;
  return parsed as unknown as CompactScanner;
}

// ---------------------------------------------------------------------------
// Macro news aggregator (§R2.2, R2.4, R2.6)
// ---------------------------------------------------------------------------

export type MacroMetric = {
  readonly metric: string;
  readonly actual: number | null;
  readonly estimate: number | null;
  readonly previous: number | null;
  readonly unit: string | null;
};
export type MacroEvent = {
  readonly event: string;
  readonly eventAtMs: number | null;
  readonly importance: string | null;
  readonly status: string | null;
  readonly metrics: readonly MacroMetric[];
};
export type CompactMacro = {
  readonly upcoming: readonly MacroEvent[];
  readonly later: readonly MacroEvent[];
  readonly recent: readonly MacroEvent[];
};

function readMacroMetric(value: unknown): MacroMetric | null {
  if (!record(value)) return null;
  const metric = str(value["metric"]);
  if (metric === null) return null;
  return { metric: metric.slice(0, 120), actual: num(value["actual"]), estimate: num(value["estimate"]),
    previous: num(value["previous"]), unit: str(value["unit"]) };
}
/**
 * AUDIT FC-1: shared by `readMacroEvent`'s 6-metric vendor-order slice and
 * `cap3Metrics`'s 3-metric compaction slice — closed-set-matching metrics
 * move to the front BEFORE either slice, so a closed-set metric can never be
 * dropped by either cap regardless of the vendor's (alphabetical) ordering.
 */
function prioritizeClosedSetMetrics(metrics: readonly MacroMetric[]): MacroMetric[] {
  return [...metrics].sort((a, b) => Number(metricMatchesClosedSet(b)) - Number(metricMatchesClosedSet(a)));
}
function readMacroEvent(value: unknown): MacroEvent | null {
  if (!record(value)) return null;
  const event = str(value["event"]);
  if (event === null) return null;
  const at = str(value["event_at"]);
  const parsed = at === null ? NaN : Date.parse(at);
  const metrics = arr(value["metrics"]).map(readMacroMetric).filter((m): m is MacroMetric => m !== null);
  return { event: event.slice(0, 160), eventAtMs: Number.isFinite(parsed) ? parsed : null,
    importance: str(value["importance"]), status: str(value["event_status"]),
    metrics: prioritizeClosedSetMetrics(metrics).slice(0, 6) };
}

/** R2.2 H2: envelope is `result.data` (already an object); pack = that object; events at `data.evidence.*`. `recent_news_events` is ignored. */
/** AUDIT HIGH-3: closed-set events rank highest, then `major`, then the rest; `upcoming` outranks `later`/`recent` at an equal event rank. */
function macroEventPriorityRank(event: MacroEvent): number {
  return isClosedSetEvent(event) ? 0 : event.importance === "major" ? 1 : 2;
}
/**
 * AUDIT L-R1: `recent` outranks `later` — `recent_macro_releases` holds
 * exactly the rows inside eventRisk's -12h window (the ones the "+1 after
 * release" call exists to surface), so a just-released CPI must survive
 * trimming ahead of a closed-set event still 4-7 days out.
 */
function macroBucketRank(bucket: "upcoming" | "later" | "recent"): number {
  return bucket === "upcoming" ? 0 : bucket === "recent" ? 1 : 2;
}

export function compactMacroUsEquity(rawText: string): string | null {
  const data = skillPackData(rawText, "data");
  if (data === null) return null;
  const evidence = record(data["evidence"]) ? data["evidence"] : null;
  if (evidence === null) return null;
  // Shape validity is structural: a genuinely empty calendar window (a quiet
  // day) must still compact to an `available` row, not `invalid`.
  // Live 2026-09-25: two paid `ok:true` packs came back invalid; an absent
  // window is read as empty. At least one of the three must be a real array.
  const windows = ["upcoming_events_72h", "later_events_days_4_to_7", "recent_macro_releases"] as const;
  if (!windows.some((key) => Array.isArray(evidence[key]))) return null;
  if (windows.some((key) => evidence[key] !== undefined && evidence[key] !== null && !Array.isArray(evidence[key]))) return null;
  // AUDIT HIGH-3: the compactor bounds ITSELF to fit `CMC_MAX_TICKER_CHARS` —
  // never sliced as raw JSON downstream (that destroys the document on a busy
  // week). Cap each event to 3 metrics, then greedily keep events in priority
  // order (closed-set/major `upcoming` first) until the next one would not fit.
  // AUDIT H-R1: a metric matching a closed-set prefix is moved to the front
  // BEFORE the cap, so capping can never drop the one metric that makes the
  // event closed-set (the vendor lists metrics alphabetically; "Non Farm
  // Payrolls" sorts 6th in a 9-metric employment report and was lost by a
  // plain `.slice(0, 3)`, silently turning off the ×0.6 NFP guard).
  const cap3Metrics = (event: MacroEvent): MacroEvent => {
    return { ...event, metrics: prioritizeClosedSetMetrics(event.metrics).slice(0, 3) };
  };
  const upcomingAll = arr(evidence["upcoming_events_72h"]).map(readMacroEvent).filter((e): e is MacroEvent => e !== null).map(cap3Metrics);
  const laterAll = arr(evidence["later_events_days_4_to_7"]).map(readMacroEvent).filter((e): e is MacroEvent => e !== null).map(cap3Metrics);
  const recentAll = arr(evidence["recent_macro_releases"]).map(readMacroEvent).filter((e): e is MacroEvent => e !== null).map(cap3Metrics);
  const tagged = [
    ...upcomingAll.map((event) => ({ event, bucket: "upcoming" as const })),
    ...laterAll.map((event) => ({ event, bucket: "later" as const })),
    ...recentAll.map((event) => ({ event, bucket: "recent" as const })),
  ].sort((a, b) => macroEventPriorityRank(a.event) - macroEventPriorityRank(b.event) || macroBucketRank(a.bucket) - macroBucketRank(b.bucket));
  const kept: { upcoming: MacroEvent[]; later: MacroEvent[]; recent: MacroEvent[] } = { upcoming: [], later: [], recent: [] };
  const serialize = (): string => JSON.stringify({ upcoming: kept.upcoming, later: kept.later, recent: kept.recent });
  for (const item of tagged) {
    if (kept[item.bucket].length >= 30) continue;
    kept[item.bucket].push(item.event);
    if (serialize().length > CMC_MAX_TICKER_CHARS) kept[item.bucket].pop();
  }
  return serialize();
}
export function readCompactMacro(text: string): CompactMacro | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return null; }
  if (!record(parsed) || !Array.isArray(parsed["upcoming"]) || !Array.isArray(parsed["later"]) || !Array.isArray(parsed["recent"])) return null;
  return parsed as unknown as CompactMacro;
}

/**
 * R2.4/N5: an event's own name matches the closed set verbatim, OR any of its
 * metrics starts with one of the measured naming-family prefixes. Only the
 * three calendar arrays are ever read (never `recent_news_events`).
 */
const CLOSED_SET_EVENT_NAMES = new Set(["pce inflation release"]);
const CLOSED_SET_METRIC_PREFIXES = [
  "core pce price index", "pce price index", "cpi", "core inflation rate", "inflation rate",
  "non farm payrolls", "nonfarm payrolls", "fed interest rate decision", "gdp growth rate",
  // N5 residual additions:
  "consumer price index", "federal funds rate",
];
function metricMatchesClosedSet(metric: MacroMetric): boolean {
  const lower = metric.metric.trim().toLowerCase();
  return CLOSED_SET_METRIC_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
export function isClosedSetEvent(event: MacroEvent): boolean {
  if (CLOSED_SET_EVENT_NAMES.has(event.event.trim().toLowerCase())) return true;
  return event.metrics.some(metricMatchesClosedSet);
}

const HOURS_12_MS = 12 * 60 * 60_000;
const HOURS_48_MS = 48 * 60 * 60_000;

export function allMacroEvents(macro: CompactMacro): readonly MacroEvent[] {
  return [...macro.upcoming, ...macro.later, ...macro.recent];
}
function allEvents(macro: CompactMacro): readonly MacroEvent[] { return allMacroEvents(macro); }

/** R2.4: high when a closed-set event's `event_at` is within [-12h, +48h] of `nowMs`. */
export function macroEventRiskUsEquity(macro: CompactMacro, nowMs: number): "high" | "none" {
  for (const event of allEvents(macro)) {
    if (event.eventAtMs === null || !isClosedSetEvent(event)) continue;
    if (event.eventAtMs >= nowMs - HOURS_12_MS && event.eventAtMs <= nowMs + HOURS_48_MS) return "high";
  }
  return "none";
}

/** The soonest closed-set event at/after `nowMs - 12h`, for the R2.6 prompt line. */
export function nextClosedSetEvent(macro: CompactMacro, nowMs: number): MacroEvent | null {
  const candidates = allEvents(macro).filter((event) => event.eventAtMs !== null && event.eventAtMs >= nowMs - HOURS_12_MS && isClosedSetEvent(event));
  candidates.sort((a, b) => (a.eventAtMs ?? 0) - (b.eventAtMs ?? 0));
  return candidates[0] ?? null;
}

/** N6: `importance === "major"` rows that did NOT match the closed set, bounded for a cheap observe line. */
export function unmatchedMajorEvents(macro: CompactMacro): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of allEvents(macro)) {
    if (event.importance !== "major" || isClosedSetEvent(event)) continue;
    const key = event.event.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event.event.slice(0, 80));
    if (out.length === 10) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trade planning context (§R2.2 H3, R2.6)
// ---------------------------------------------------------------------------

export type PlanningZone = { readonly lowUsd: number; readonly distanceAtr: number };
export type CompactPlanning = {
  readonly sessionDate: string | null;
  readonly sectorProxy: string | null;
  readonly latestCloseUsd: number | null;
  readonly ema20Pct: number | null;
  readonly ema50Pct: number | null;
  readonly ema200Pct: number | null;
  readonly emaChange5d20Pct: number | null;
  readonly emaChange5d50Pct: number | null;
  readonly atr14Pct: number | null;
  readonly returns5Pct: number | null;
  readonly returns20Pct: number | null;
  readonly returns63Pct: number | null;
  readonly spyRel5Pct: number | null;
  readonly spyRel20Pct: number | null;
  readonly spyRel63Pct: number | null;
  readonly support: PlanningZone | null;
  readonly resistance: PlanningZone | null;
};

/**
 * R2.2 H3: `current_relation` is the CLOSE's relation to the zone. Nearest
 * support = `effective_role === "support" && current_relation === "above"`
 * with the minimum `distance_from_close_atr`; nearest resistance the mirror
 * with `"below"`. `static_zones[]` is sorted by price, not by distance.
 */
function nearestZone(zones: readonly unknown[], role: "support" | "resistance", relation: "above" | "below"): PlanningZone | null {
  let best: PlanningZone | null = null;
  for (const value of zones) {
    if (!record(value)) continue;
    if (value["effective_role"] !== role || value["current_relation"] !== relation) continue;
    const lowUsd = num(value["zone_low"]);
    const distanceAtr = num(value["distance_from_close_atr"]);
    if (lowUsd === null || distanceAtr === null) continue;
    if (best === null || distanceAtr < best.distanceAtr) best = { lowUsd, distanceAtr };
  }
  return best;
}

export function compactPlanning(rawText: string): string | null {
  const data = skillPackData(rawText, "output");
  if (data === null) return null;
  const evidence = record(data["evidence"]) ? data["evidence"] : null;
  if (evidence === null) return null;
  const identity = record(evidence["identity"]) ? evidence["identity"] : null;
  const sectorProxy = identity && record(identity["sector_proxy"]) ? str(identity["sector_proxy"]["symbol"]) : null;
  const priceBasis = record(evidence["price_basis"]) ? evidence["price_basis"] : null;
  const marketStructure = record(evidence["market_structure"]) ? evidence["market_structure"] : null;
  const emaDistance = marketStructure && record(marketStructure["ema_distance_pct"]) ? marketStructure["ema_distance_pct"] : null;
  const emaChange5d = marketStructure && record(marketStructure["ema_change_5d_pct"]) ? marketStructure["ema_change_5d_pct"] : null;
  const returns = marketStructure && record(marketStructure["returns_pct"]) ? marketStructure["returns_pct"] : null;
  const benchmarkContext = record(evidence["benchmark_context"]) ? evidence["benchmark_context"] : null;
  const relReturns = benchmarkContext && record(benchmarkContext["relative_returns_pct"]) ? benchmarkContext["relative_returns_pct"] : null;
  const spyRel = relReturns && record(relReturns["SPY"]) ? relReturns["SPY"] : null;
  const lastSession = record(evidence["last_completed_session"]) ? evidence["last_completed_session"] : null;
  const keyLevels = record(evidence["key_levels"]) ? evidence["key_levels"] : null;
  const zones = keyLevels ? arr(keyLevels["static_zones"]) : [];
  const sessionDate = (lastSession ? str(lastSession["session_date"]) : null) ?? str(data["as_of_trading_day"]);
  if (sessionDate === null && marketStructure === null) return null;
  const compact: CompactPlanning = {
    sessionDate, sectorProxy,
    latestCloseUsd: priceBasis ? num(priceBasis["latest_close_usd"]) : null,
    ema20Pct: emaDistance ? num(emaDistance["20"]) : null,
    ema50Pct: emaDistance ? num(emaDistance["50"]) : null,
    ema200Pct: emaDistance ? num(emaDistance["200"]) : null,
    emaChange5d20Pct: emaChange5d ? num(emaChange5d["20"]) : null,
    emaChange5d50Pct: emaChange5d ? num(emaChange5d["50"]) : null,
    atr14Pct: marketStructure ? num(marketStructure["atr14_pct"]) : null,
    returns5Pct: returns ? num(returns["5"]) : null,
    returns20Pct: returns ? num(returns["20"]) : null,
    returns63Pct: returns ? num(returns["63"]) : null,
    spyRel5Pct: spyRel ? num(spyRel["5"]) : null,
    spyRel20Pct: spyRel ? num(spyRel["20"]) : null,
    spyRel63Pct: spyRel ? num(spyRel["63"]) : null,
    support: nearestZone(zones, "support", "above"),
    resistance: nearestZone(zones, "resistance", "below"),
  };
  return JSON.stringify(compact);
}
export function readCompactPlanning(text: string): CompactPlanning | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return null; }
  if (!record(parsed) || !("sessionDate" in parsed)) return null;
  return parsed as unknown as CompactPlanning;
}

// ---------------------------------------------------------------------------
// R2.3/M3: static ticker -> sector/theme map, the measured 28-ticker pin (2026-09-23)
// ---------------------------------------------------------------------------

export type TickerClass =
  | { readonly kind: "stock"; readonly sector: string | null; readonly theme: string | null }
  | { readonly kind: "etf" }
  | { readonly kind: "unresolvable" };

function stock(sector: string | null, theme: string | null = null): TickerClass { return { kind: "stock", sector, theme }; }
const ETF: TickerClass = { kind: "etf" };
const UNRESOLVABLE: TickerClass = { kind: "unresolvable" };

/** Verbatim GICS sector strings and theme names measured in `probe-us_equity_sector_rotation.json`. */
export const US_EQUITY_TICKER_CLASS: Readonly<Record<string, TickerClass>> = {
  BABA: stock("Consumer Discretionary"),
  BILI: stock("Communication Services"),
  CRCL: stock("Financials"),
  DIS: stock("Communication Services"),
  FXI: ETF,
  GME: stock("Consumer Discretionary"),
  GOOGL: stock("Communication Services"),
  HOOD: stock("Financials"),
  INTC: stock("Information Technology", "Semiconductors"),
  META: stock("Communication Services", "Broad AI"),
  MRVL: stock("Information Technology", "Semiconductors"),
  MSFT: stock("Information Technology", "Broad AI"),
  MSTR: stock("Information Technology"),
  NOK: stock("Information Technology"),
  NVDA: stock("Information Technology", "Semiconductors"),
  PDD: stock("Consumer Discretionary"),
  QQQ: ETF,
  SGOV: ETF,
  SKHY: UNRESOLVABLE,
  SNDK: stock("Information Technology", "Memory and Storage"),
  SNXX: ETF,
  SOXL: ETF,
  SPCX: UNRESOLVABLE,
  SPY: ETF,
  TLT: ETF,
  TQQQ: ETF,
  TSLA: stock("Consumer Discretionary"),
  TSM: stock("Information Technology", "Semiconductors"),
  // AGENTIC-RFQ-STOCKS E11 (OQ-9): the 26 RFQ-only underlyings. No sector is invented (null renders "unknown"); ETFs get no planning call; CBRS and QNT are unmeasured symbols, so no paid call.
  AAOI: stock(null), AMD: stock(null), ARM: stock(null), AVGO: stock(null), AXTI: stock(null), COHR: stock(null), COIN: stock(null), CRDO: stock(null), CRWV: stock(null),
  GLW: stock(null), IBM: stock(null), LITE: stock(null), NBIS: stock(null), PLTR: stock(null), PYPL: stock(null), QCOM: stock(null), RKLB: stock(null), WDC: stock(null),
  DRAM: ETF, EWY: ETF, INTW: ETF, KORU: ETF, MUU: ETF, MVLL: ETF,
  CBRS: UNRESOLVABLE, QNT: UNRESOLVABLE,
};

export function tickerClass(ticker: string): TickerClass | null {
  return US_EQUITY_TICKER_CLASS[ticker.trim().toUpperCase()] ?? null;
}

export type LlmDataRequestSkill = "planning" | "events";
export type LlmDataRequestRefusalCode = "no-ticker" | "unmapped" | "not-stock" | "cmc-disabled" | "disabled";

/**
 * TRADFI-LLM-CMC-REQUEST §3/R2.5/R2.7: the worker's own index -> ticker
 * classification for an LLM-requested paid call, decided BEFORE the request
 * ever reaches the CMC runtime queue. `unmapped` (outside the static pin) is
 * distinct from `not-stock` (a mapped ETF/unresolvable) — growing the
 * universe means growing `US_EQUITY_TICKER_CLASS`, not this function.
 * `cmc-disabled` is a defensive branch: `dataRequestsEnabled` gates the
 * prompt/validator too, so a live response can never carry a request while it
 * is false, but the check is kept here so it is directly unit-testable.
 */
export function classifyLlmDataRequestTicker(
  ticker: string,
  skill: LlmDataRequestSkill,
  dataRequestsEnabled: boolean,
): LlmDataRequestRefusalCode | "ok" {
  if (!dataRequestsEnabled) return "cmc-disabled";
  const normalized = ticker.trim().toUpperCase();
  if (normalized === "") return "no-ticker";
  if (skill === "events" && !CMC_EVENT_CALENDAR_ENABLED) return "disabled";
  const cls = tickerClass(normalized);
  if (cls === null) return "unmapped";
  return cls.kind === "stock" ? "ok" : "not-stock";
}

// ---------------------------------------------------------------------------
// R2.1/N1/N7: NYSE-clock anchors, due and validity. Holidays are not modelled
// (same posture as the rest of the TradFi lane).
// ---------------------------------------------------------------------------

export const MACRO_ANCHOR_MINUTE = 8 * 60; // 08:00 ET
export const SECTOR_ANCHOR_MINUTE = 10 * 60 + 30; // 10:30 ET
export const SCANNER_ANCHOR_MINUTE = 16 * 60 + 30; // 16:30 ET
export const NYSE_CLOSE_MINUTE = 16 * 60; // 16:00 ET

/** N7: one failed day costs nothing; DST-safe (the Sunday 2026-11-01 fallback day is a 25h ET day). */
export const MACRO_VALID_MS = 50 * 60 * 60_000;
export const GLOBAL_VALID_MS = 27 * 60 * 60_000;
export const SECTOR_SCANNER_VALID_MARGIN_MS = 2 * 60 * 60_000;

type YMD = { readonly year: number; readonly month: number; readonly day: number };

function nyDateTimeParts(ms: number): YMD & { readonly minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "NaN");
  return { year: get("year"), month: get("month"), day: get("day"), minuteOfDay: get("hour") * 60 + get("minute") };
}

/** Calendar weekday (0=Sun..6=Sat) of a plain Y-M-D; timezone-independent. */
function weekdayOf(ymd: YMD): number {
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay();
}
function isTradingCalendarDay(ymd: YMD): boolean {
  const weekday = weekdayOf(ymd);
  return weekday !== 0 && weekday !== 6;
}
function shiftCalendarDay(ymd: YMD, days: number): YMD {
  const shifted = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day) + days * 24 * 60 * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
function nextTradingCalendarDay(ymd: YMD): YMD {
  let probe = ymd;
  for (let i = 0; i < 10; i += 1) {
    probe = shiftCalendarDay(probe, 1);
    if (isTradingCalendarDay(probe)) return probe;
  }
  return probe;
}
function prevTradingCalendarDay(ymd: YMD): YMD {
  let probe = ymd;
  for (let i = 0; i < 10; i += 1) {
    probe = shiftCalendarDay(probe, -1);
    if (isTradingCalendarDay(probe)) return probe;
  }
  return probe;
}
function ymdString(ymd: YMD): string {
  return `${ymd.year.toString(10).padStart(4, "0")}-${ymd.month.toString(10).padStart(2, "0")}-${ymd.day.toString(10).padStart(2, "0")}`;
}
function ymdParse(value: string): YMD | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Converts an ET wall-clock (Y-M-D + minute-of-day) to a UTC ms instant; converges in <=3 iterations over the two DST offsets. */
function etWallClockToUtcMs(ymd: YMD, minuteOfDay: number): number {
  let offsetMinutes = 300; // guess EST (UTC-5)
  let guess = Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0) + minuteOfDay * 60_000 + offsetMinutes * 60_000;
  for (let i = 0; i < 4; i += 1) {
    const observed = nyDateTimeParts(guess);
    if (observed.year === ymd.year && observed.month === ymd.month && observed.day === ymd.day && observed.minuteOfDay === minuteOfDay) return guess;
    const dayDelta = observed.year === ymd.year && observed.month === ymd.month ? observed.day - ymd.day : observed.year > ymd.year || (observed.year === ymd.year && observed.month > ymd.month) ? 1 : -1;
    const minuteDelta = dayDelta * 24 * 60 + (observed.minuteOfDay - minuteOfDay);
    guess -= minuteDelta * 60_000;
  }
  return guess;
}

export function isNyTradingDay(nowMs: number): boolean {
  const parts = nyDateTimeParts(nowMs);
  return isTradingCalendarDay(parts);
}

/** The most recent completed NYSE session's date (`YYYY-MM-DD`), as of `nowMs` (R2.1/N1). */
export function latestCompletedNySessionDate(nowMs: number): string {
  const parts = nyDateTimeParts(nowMs);
  const today: YMD = { year: parts.year, month: parts.month, day: parts.day };
  const completedToday = isTradingCalendarDay(today) && parts.minuteOfDay >= NYSE_CLOSE_MINUTE;
  return ymdString(completedToday ? today : prevTradingCalendarDay(today));
}

/** R2.3: due = `session_date` is not the latest completed NYSE session (or there is no row). */
export function planningDue(sessionDate: string | null, nowMs: number): boolean {
  return sessionDate === null || sessionDate !== latestCompletedNySessionDate(nowMs);
}

/** N1: valid for the prompt while `session_date` is one of the last two completed sessions; no 30h cap. */
export function planningValidForPrompt(sessionDate: string | null, nowMs: number): boolean {
  if (sessionDate === null) return false;
  const latest = latestCompletedNySessionDate(nowMs);
  if (sessionDate === latest) return true;
  const latestYmd = ymdParse(latest);
  if (latestYmd === null) return false;
  return sessionDate === ymdString(prevTradingCalendarDay(latestYmd));
}

/** True once `nowMs` is at/after today's ET `anchorMinute` on a trading day, and no activity has happened since. Weekend calls are never due (M7). */
export function tradingDayDue(lastActivityMs: number, nowMs: number, anchorMinute: number): boolean {
  const parts = nyDateTimeParts(nowMs);
  const today: YMD = { year: parts.year, month: parts.month, day: parts.day };
  if (!isTradingCalendarDay(today)) return false;
  const anchor = etWallClockToUtcMs(today, anchorMinute);
  return nowMs >= anchor && lastActivityMs < anchor;
}

/** Once per (non-trading-day-gated) calendar day at/after `anchorMinute` ET — used by macro/global, which run every day. */
export function dailyDue(lastActivityMs: number, nowMs: number, anchorMinute: number): boolean {
  const parts = nyDateTimeParts(nowMs);
  const today: YMD = { year: parts.year, month: parts.month, day: parts.day };
  const anchor = etWallClockToUtcMs(today, anchorMinute);
  return nowMs >= anchor && lastActivityMs < anchor;
}

/** R2.1: valid until the next trading day's `anchorMinute` ET + the 2h margin. */
export function sectorScannerValidUntilMs(asOfMs: number, anchorMinute: number): number {
  const parts = nyDateTimeParts(asOfMs);
  const fetchedDay: YMD = { year: parts.year, month: parts.month, day: parts.day };
  const next = nextTradingCalendarDay(fetchedDay);
  return etWallClockToUtcMs(next, anchorMinute) + SECTOR_SCANNER_VALID_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// R2.6: worded prompt lines (never JSON to the model)
// ---------------------------------------------------------------------------

function pct(value: number | null, digits = 1): string {
  return value === null ? "unknown" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** The market-wide line: style leader plus the two index benchmarks. */
export function marketPromptLine(sector: CompactSector | null): string {
  if (sector === null) return "us-market: unknown (no fresh sector-rotation row)";
  const style = sector.styleLeader === null ? "unknown" : `${sector.styleLeader} (${pct(sector.styleExcessPp, 2)} 21d)`;
  const benches = sector.benchmarks.map((b) => `${b.benchmark} ${pct(b.changeFromOpenPct, 2)}`).join(", ");
  return `us-market: style leader ${style}; ${benches.length === 0 ? "benchmarks unknown" : `${benches} from open`}`;
}

function rankWord(rank: number | null): string {
  return rank === null ? "unranked" : `rank ${rank}`;
}

/** Per-ticker sector/theme + uptrend + planning line (R2.6). Any missing input renders "unknown", never omitted. */
export function tickerPromptLine(input: {
  readonly ticker: string;
  readonly cls: TickerClass | null;
  readonly sector: CompactSector | null;
  readonly scanner: CompactScanner | null;
  readonly planning: CompactPlanning | null;
  readonly planningFresh: boolean;
}): string {
  const parts: string[] = [];
  const cls = input.cls;
  // AUDIT L-R3: a rotation_state is rendered with spaces, not raw underscores
  // (matches the scanner status rendering below); a MISSING sector row (not
  // fetched/expired) is a plain "unknown", not the ticker's mapped sector
  // name paired with "(unranked, unknown)" — that phrasing implies live data
  // that simply has no rank, which is not what a missing row means.
  const renderRotationState = (state: string | null): string => state === null ? "unknown" : state.replaceAll("_", " ");
  if (cls !== null && cls.kind === "stock" && cls.sector !== null) {
    const sectorName = cls.sector;
    const themeName = cls.theme;
    if (input.sector === null) {
      parts.push("sector unknown");
    } else {
      const sectorRow = input.sector.sectors.find((s) => s.group === sectorName) ?? null;
      const themeRow = themeName === null ? null : (input.sector.themes.find((t) => t.group === themeName) ?? null);
      parts.push(`sector ${sectorName} (${rankWord(sectorRow?.rank ?? null)}, ${renderRotationState(sectorRow?.rotationState ?? null)})`);
      if (themeName !== null) parts.push(`theme ${themeName} (${rankWord(themeRow?.rank ?? null)}, ${renderRotationState(themeRow?.rotationState ?? null)})`);
    }
  } else {
    parts.push("sector unknown");
  }
  // AUDIT L4: a MISSING scanner row is "unknown" (R2.6: missing/expired data
  // never renders silently); a PRESENT row that simply does not list this
  // ticker is "not flagged" — that is real information (R2.4: absence is
  // inactive, not a penalty, but it is still a known absence, not an unknown).
  const candidate = input.scanner?.candidates.find((c) => c.symbol === input.ticker.toUpperCase()) ?? null;
  parts.push(input.scanner === null ? "uptrend: unknown"
    : candidate === null ? "uptrend: not flagged"
    : `uptrend: ${(candidate.status ?? "unknown").replaceAll("_", " ")}, ${candidate.weeksInUptrend ?? "unknown"} weeks`);
  if (input.planningFresh && input.planning !== null) {
    const p = input.planning;
    parts.push(`EOD ${p.sessionDate ?? "unknown"}: ${pct(p.ema20Pct)} vs EMA20, ${pct(p.ema50Pct)} vs EMA50, ATR ${p.atr14Pct === null ? "unknown" : `${p.atr14Pct.toFixed(2)}%`}, 20d vs SPY ${pct(p.spyRel20Pct)}`);
    const support = p.support === null ? "unknown" : `${p.support.lowUsd.toFixed(2)} (${p.support.distanceAtr.toFixed(2)} ATR)`;
    const resistance = p.resistance === null ? "unknown" : `${p.resistance.lowUsd.toFixed(2)} (${p.resistance.distanceAtr.toFixed(2)} ATR)`;
    parts.push(`support ${support}, resistance ${resistance}`);
  } else {
    parts.push("EOD structure: unknown");
  }
  return `${input.ticker} — ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Upcoming event calendar (TRADFI-LLM-CMC-REQUEST G0 follow-up, measured
// 2026-09-25 on NVDA: `result.data` object envelope like macro;
// `data.events[]` = { scope: "macro"|"company", event_type, title,
// event_date "YYYY-MM-DD", time_precision "date_only", ... }). Only COMPANY
// events are kept: the macro ones duplicate the daily macro calendar, which
// carries times and consensus.
// ---------------------------------------------------------------------------

export type CompactEvents = {
  readonly symbol: string | null;
  readonly windowEnd: string | null;
  readonly events: readonly { readonly date: string; readonly type: string; readonly title: string }[];
};

/** Worst-case lifetime of an events row in the prompt (the calendar covers the next 7 days; refreshed at most once per window). */
export const EVENTS_VALID_MS = 48 * 60 * 60_000;

export function compactEventCalendar(rawText: string): string | null {
  const data = skillPackData(rawText, "data");
  if (data === null || !Array.isArray(data["events"])) return null;
  const asset = record(data["asset"]) ? data["asset"] : {};
  const window = record(data["window"]) ? data["window"] : {};
  const events = arr(data["events"]).flatMap((value) => {
    if (!record(value) || value["scope"] !== "company") return [];
    const date = typeof value["event_date"] === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value["event_date"]) ? value["event_date"] : null;
    if (date === null) return [];
    const type = typeof value["event_type"] === "string" ? value["event_type"].slice(0, 40) : "event";
    const title = typeof value["title"] === "string" ? value["title"].slice(0, 60) : type;
    return [{ date, type, title }];
  }).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  return JSON.stringify({
    symbol: typeof asset["symbol"] === "string" ? asset["symbol"] : null,
    windowEnd: typeof window["end"] === "string" ? window["end"].slice(0, 10) : null,
    events,
  });
}

export function readCompactEvents(text: string): CompactEvents | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return null; }
  if (!record(parsed) || !Array.isArray(parsed["events"])) return null;
  const events = arr(parsed["events"]).flatMap((value) => record(value) && typeof value["date"] === "string"
    && typeof value["type"] === "string" && typeof value["title"] === "string"
    ? [{ date: value["date"], type: value["type"], title: value["title"] }] : []);
  return { symbol: typeof parsed["symbol"] === "string" ? parsed["symbol"] : null,
    windowEnd: typeof parsed["windowEnd"] === "string" ? parsed["windowEnd"] : null, events };
}

/** Appended to a ticker line only when a fresh events row exists, so tickers without one render exactly as before. */
export function eventsPromptPart(events: CompactEvents): string {
  if (events.events.length === 0) return `company events: none through ${events.windowEnd ?? "the next 7 days"}`;
  return `company events: ${events.events.map((e) => `${e.type.replaceAll("_", " ")} ${e.date}`).join(", ")}`;
}

/** The next closed-set macro line (R2.6). */
export function macroPromptLine(macro: CompactMacro | null, nowMs: number): string {
  if (macro === null) return "next closed-set: unknown (no fresh macro row)";
  const next = nextClosedSetEvent(macro, nowMs);
  if (next === null) return "next closed-set: none within 7 days";
  const when = next.eventAtMs === null ? "unknown" : new Date(next.eventAtMs).toISOString().slice(0, 16).replace("T", " ") + "Z";
  // AUDIT FC (LOW): a closed-set-matching metric (e.g. Non Farm Payrolls) is
  // the one that made this event closed-set, so it outranks a plain "YoY"
  // metric (e.g. Average Hourly Earnings YoY) that happens to sort first.
  const consensus = next.metrics.find((m) => metricMatchesClosedSet(m) && (m.estimate !== null || m.actual !== null))
    ?? next.metrics.find((m) => /yoy/iu.test(m.metric) && (m.estimate !== null || m.actual !== null))
    ?? next.metrics.find((m) => m.estimate !== null || m.actual !== null) ?? null;
  const detail = consensus === null ? "" : consensus.actual !== null
    ? ` (${consensus.metric} actual ${consensus.actual} vs est ${consensus.estimate ?? "unknown"})`
    : ` (${consensus.metric} est ${consensus.estimate ?? "unknown"}, prior ${consensus.previous ?? "unknown"})`;
  return `next closed-set: ${next.event} ${when}${detail}`;
}

// ---------------------------------------------------------------------------
// N4/N8: the macro "+1 after a closed-set release" gate, and R2.3 planning
// selection (held then shortlist, oldest-row-first, cap 5 per 16:30 ET window).
// ---------------------------------------------------------------------------

/** M5: the row's last activity (a successful fetch or a recorded failure), used to decide "due". */
export function lastActivityMs(row: { readonly asOfMs: number; readonly lastAttemptAtMs?: number | null } | null): number {
  if (row === null) return -Infinity;
  const attempt = row.lastAttemptAtMs ?? null;
  return attempt !== null && attempt > row.asOfMs ? attempt : row.asOfMs;
}

const RELEASE_LAG_MS = 30 * 60_000;
const RELEASE_LOOKBACK_MS = 24 * 60 * 60_000;

function sameEtCalendarDay(aMs: number, bMs: number): boolean {
  const a = nyDateTimeParts(aMs);
  const b = nyDateTimeParts(bMs);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * N4/AUDIT HIGH-1: at most one "+1" call per ET calendar day, only once a
 * closed-set event's own time has passed by >= 30 min, only for an event
 * that released AFTER the daily macro row was last fetched (so the daily row
 * genuinely lacks its actual/estimate), and only on the SAME ET calendar day
 * as `nowMs` — without that last check an event ~20h old is still inside the
 * 24h lookback, so the once-a-day gate resetting at ET midnight let the same
 * release re-fire the next day under a fresh "due" window.
 */
export function macroReleaseDue(input: {
  readonly macro: CompactMacro | null;
  readonly macroRowAsOfMs: number;
  readonly releaseLastActivityMs: number;
  readonly nowMs: number;
}): boolean {
  if (input.macro === null || !dailyDue(input.releaseLastActivityMs, input.nowMs, 0)) return false;
  return allMacroEvents(input.macro).some((event) => event.eventAtMs !== null && isClosedSetEvent(event)
    && event.eventAtMs > input.macroRowAsOfMs
    && event.eventAtMs <= input.nowMs - RELEASE_LAG_MS
    && input.nowMs - event.eventAtMs <= RELEASE_LOOKBACK_MS
    && sameEtCalendarDay(event.eventAtMs, input.nowMs));
}

/** R2.3: the planning-call throttle window is the current TRADING day anchored at 16:30 ET. */
/**
 * AUDIT M-R1(1): R2.3 anchors the cap at 16:30 ET on the TRADING day, not the
 * calendar day. Stepping back one plain calendar day put Monday-before-16:30
 * in a fresh [Sun 16:30, Mon 16:30) window with none of Friday evening's
 * calls counted against it — 3 Friday-evening + 5 Monday calls could land in
 * the one 16:30-anchored trading-day window R2.3 actually describes ([Fri
 * 16:30, Mon 16:30)). Stepping back to the PREVIOUS TRADING day fixes this.
 */
export function planningWindowStartMs(nowMs: number): number {
  const parts = nyDateTimeParts(nowMs);
  const today: YMD = { year: parts.year, month: parts.month, day: parts.day };
  if (isTradingCalendarDay(today)) {
    const anchorToday = etWallClockToUtcMs(today, SCANNER_ANCHOR_MINUTE);
    if (nowMs >= anchorToday) return anchorToday;
  }
  return etWallClockToUtcMs(prevTradingCalendarDay(today), SCANNER_ANCHOR_MINUTE);
}
export const PLANNING_CAP_PER_WINDOW = 5;

/** TRADFI-LLM-CMC-REQUEST R2.3/R3.2: `requestedBy` describes the row's LATEST attempt, not its stored content. */
export type PlanningRowInfo = { readonly ticker: string; readonly sessionDate: string | null; readonly lastActivityMs: number; readonly requestedBy?: "llm" | null };

function stockTickersOnly(tickers: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tickers) {
    const ticker = raw.trim().toUpperCase();
    if (ticker.length === 0 || seen.has(ticker)) continue;
    seen.add(ticker);
    const cls = tickerClass(ticker);
    if (cls !== null && cls.kind === "stock") out.push(ticker);
  }
  return out;
}

/**
 * R2.3: held first, oldest row first; then shortlisted, oldest first. `rows`
 * is every known planning row for the agent (any ticker), so the 5-per-window
 * cap counts across the whole day, not just this call's candidate lists.
 */
export function selectPlanningTicker(input: {
  readonly heldTickers: readonly string[];
  readonly shortlistedTickers: readonly string[];
  readonly rows: readonly PlanningRowInfo[];
  readonly nowMs: number;
}): string | null {
  const windowStart = planningWindowStartMs(input.nowMs);
  // TRADFI-LLM-CMC-REQUEST R2.3: a row an LLM request just bought (not a
  // scheduled call) does not consume the SCHEDULED planning cap — the LLM
  // keeps its own separate window counter (`CMC_LLM_REQUEST_CAP_PER_WINDOW`).
  // This exclusion applies ONLY here; the per-ticker "attempted this window"
  // filter below is unaffected, so the scheduled lane never re-pays a ticker
  // an LLM request just bought in the same window.
  const servedThisWindow = input.rows.filter((row) => row.lastActivityMs >= windowStart && row.requestedBy !== "llm").length;
  if (servedThisWindow >= PLANNING_CAP_PER_WINDOW) return null;
  const rowByTicker = new Map(input.rows.map((row) => [row.ticker, row]));
  const held = stockTickersOnly(input.heldTickers);
  const shortlisted = stockTickersOnly(input.shortlistedTickers).filter((ticker) => !held.includes(ticker));
  // AUDIT HIGH-2(a)/M5: a ticker already attempted (success OR failure) this
  // window is done for the window, so a failing/unparseable response never
  // buys a retry every hour — `planningDue` alone only looks at content
  // staleness (`sessionDate`), not attempt history.
  const dueOrdered = (tickers: readonly string[]): string[] => [...tickers]
    .filter((ticker) => {
      const row = rowByTicker.get(ticker);
      if (row !== undefined && row.lastActivityMs >= windowStart) return false;
      return planningDue(row?.sessionDate ?? null, input.nowMs);
    })
    .sort((a, b) => (rowByTicker.get(a)?.lastActivityMs ?? -Infinity) - (rowByTicker.get(b)?.lastActivityMs ?? -Infinity));
  return [...dueOrdered(held), ...dueOrdered(shortlisted)][0] ?? null;
}

/**
 * N9 (also applied to N6 for the same bound): true, and records the key,
 * the first time `observation` is seen on `utcDate`; false on a repeat. The
 * caller resets/replaces `seen` at the UTC day boundary — this function
 * holds no state of its own, so it needs no persistence.
 */
export function shouldLogCmcObservation(seen: Set<string>, utcDate: string, observation: string): boolean {
  const key = `${utcDate}:${observation}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/**
 * TRADFI-CMC-EQUITY Rev 2/2.1: parsers, compaction, the ticker map, the macro
 * closed set, and NYSE-clock due/validity. Fixtures are trimmed from the real
 * probe payloads (`scripts/tmp/probe-*.json`, `MD here/CMC-PROBES-2026-09-23.md`)
 * with the real envelope and field paths kept.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CMC_GLOBAL_TOOL, CMC_MAX_TICKER_CHARS } from "../src/trade/cmc.js";
import {
  CMC_SKILL_MACRO,
  CMC_SKILL_MACRO_RELEASE,
  CMC_SKILL_PLANNING,
  CMC_SKILL_SCANNER,
  CMC_SKILL_SECTOR,
  US_EQUITY_TICKER_CLASS,
  compactMacroUsEquity,
  compactPlanning,
  compactScanner,
  compactSectorRotation,
  dailyDue,
  isClosedSetEvent,
  isCurrentCmcSkill,
  isNyTradingDay,
  latestCompletedNySessionDate,
  macroEventRiskUsEquity,
  macroPromptLine,
  marketPromptLine,
  nextClosedSetEvent,
  planningDue,
  planningValidForPrompt,
  readCompactMacro,
  readCompactPlanning,
  readCompactScanner,
  readCompactSector,
  sectorScannerValidUntilMs,
  lastActivityMs,
  macroReleaseDue,
  shouldLogCmcObservation,
  tickerClass,
  tickerPromptLine,
  tradingDayDue,
  unmatchedMajorEvents,
  SECTOR_ANCHOR_MINUTE,
  SCANNER_ANCHOR_MINUTE,
  MACRO_ANCHOR_MINUTE,
} from "../src/trade/cmcUsEquity.js";

void CMC_SKILL_MACRO; void CMC_SKILL_SCANNER; void CMC_SKILL_SECTOR;

/** Wraps a skill's evidence `data` object the way the MCP transport actually delivers it (R2.2): the
 * content text is a JSON string of `{result:{output:"<pack json>"}}` (planning/sector/scanner) or
 * `{result:{data:{...pack}}}` (macro, object already). */
function wrapOutput(data: unknown): string {
  const pack = { type: "evidence_pack", skill_id: "x", timestamp: "2026-09-23T00:00:00Z", data };
  return JSON.stringify({ result: { ok: true, success: true, exitCode: 0, error: "", output: JSON.stringify(pack) } });
}
function wrapData(data: unknown): string {
  const pack = { type: "evidence_pack", skill_id: "macro_news_aggregator", timestamp: "2026-09-23T16:47:00Z", status: "partial", data };
  return JSON.stringify({ result: { ok: true, data: pack } });
}

// ---------------------------------------------------------------------------
// H1: scanner — no `data.evidence` level; weeksInUptrend/rel63d come from key_indicators[]
// ---------------------------------------------------------------------------

const SCANNER_DATA = {
  status: "partial", as_of_trading_day: "2026-09-22",
  alpha_candidates: [
    { symbol: "NVDA", setup: { classification: "non_advancing_uptrend", status: "historical_structure_watch" },
      key_indicators: [
        { indicator: "trend_persistence", metrics: { persistence_63d: 0.6, weeks_in_uptrend: 7.4 } },
        { indicator: "relative_returns_vs_spy", metrics: { "15d_pct": 2.8, "30d_pct": 5.2, "63d_pct": 9 } },
      ] },
    { symbol: "MSFT", setup: { classification: "non_advancing_uptrend", status: "historical_structure_watch" },
      key_indicators: [
        { indicator: "trend_persistence", metrics: { weeks_in_uptrend: 5.8 } },
        { indicator: "relative_returns_vs_spy", metrics: { "63d_pct": 27.8 } },
      ] },
  ],
};

test("H1: compactScanner reads data.alpha_candidates directly (no data.evidence level)", () => {
  const compact = compactScanner(wrapOutput(SCANNER_DATA));
  assert.ok(compact !== null);
  const read = readCompactScanner(compact);
  assert.equal(read?.asOfTradingDay, "2026-09-22");
  assert.equal(read?.candidates.length, 2);
  const nvda = read?.candidates.find((c) => c.symbol === "NVDA");
  assert.equal(nvda?.weeksInUptrend, 7.4);
  assert.equal(nvda?.rel63dPct, 9);
  assert.equal(nvda?.status, "historical_structure_watch");
  const msft = read?.candidates.find((c) => c.symbol === "MSFT");
  assert.equal(msft?.weeksInUptrend, 5.8);
  assert.equal(msft?.rel63dPct, 27.8);
});

test("scanner: an evidence-wrapped shape (the old H1 mistake) reads no candidates", () => {
  const wrongShape = wrapOutput({ evidence: { alpha_candidates: SCANNER_DATA.alpha_candidates } });
  const compact = compactScanner(wrongShape);
  assert.equal(compact, null);
});

// ---------------------------------------------------------------------------
// H2: macro — envelope is result.data (object); events at data.evidence.*
// ---------------------------------------------------------------------------

const MACRO_DATA = {
  observation_as_of: "2026-09-23T16:47:00Z", status: "partial",
  evidence: {
    upcoming_events_72h: [
      { event: "5-Year Note Auction", event_at: "2026-09-23T17:00:00Z", importance: "scheduled", event_status: "scheduled",
        metrics: [{ metric: "5-Year Note Auction", previous: 4.393, unit: "%" }] },
      { event: "U.S. jobless-claims release", event_at: "2026-09-24T12:30:00Z", importance: "major", event_status: "scheduled",
        metrics: [
          { metric: "Continuing Jobless Claims (Sep/12)", estimate: 1750, previous: 1730, unit: "K" },
          { metric: "Initial Jobless Claims (Sep/19)", estimate: 201, previous: 196, unit: "K" },
          { metric: "Jobless Claims 4-Week Average (Sep/19)", estimate: 203, previous: 203.25, unit: "K" },
        ] },
    ],
    later_events_days_4_to_7: [
      { event: "PCE inflation release", event_at: "2026-09-30T12:30:00Z", importance: "major", event_status: "scheduled",
        metrics: [
          { metric: "Core PCE Price Index MoM (Aug)", estimate: 0.3, previous: 0.2, unit: "%" },
          { metric: "Core PCE Price Index YoY (Aug)", estimate: 3.4, previous: 3.3, unit: "%" },
        ] },
      { event: "ADP Nonfarm Employment Change", event_at: "2026-09-25T12:15:00Z", importance: "major", event_status: "scheduled",
        metrics: [{ metric: "ADP Nonfarm Employment Change (Sep)", estimate: 100, previous: 54, unit: "K" }] },
      { event: "FOMC Minutes", event_at: "2026-09-28T18:00:00Z", importance: "major", event_status: "scheduled", metrics: [] },
    ],
    recent_macro_releases: [
      { event: "2-Year FRN Auction", event_at: "2026-09-23T15:30:00Z", importance: "scheduled", event_status: "released",
        metrics: [{ metric: "2-Year FRN Auction", actual: 0.04, previous: 0.055, unit: "%" }] },
    ],
    recent_news_events: [{ event: "headline CPI showed 3.4%", published_at: "2026-09-22T00:00:00Z" }],
    missing_or_stale_inputs: [],
  },
};

test("H2: compactMacroUsEquity reads result.data -> data.evidence.* and ignores recent_news_events", () => {
  const compact = compactMacroUsEquity(wrapData(MACRO_DATA));
  assert.ok(compact !== null);
  const read = readCompactMacro(compact);
  assert.equal(read?.upcoming.length, 2);
  assert.equal(read?.later.length, 3);
  assert.equal(read?.recent.length, 1);
  assert.ok(read?.upcoming.every((e) => !e.event.toLowerCase().includes("cpi showed")));
});

test("macro: the events sit at result.data.evidence.* — a literal result.data.evidence read (H2's original bug) fails", () => {
  // Simulates the pre-fix mistake: reading `result.data` directly as the evidence pack (no unwrap of `.data`).
  let wrapper: { result: { data: unknown } };
  try { wrapper = JSON.parse(wrapData(MACRO_DATA)) as never; } catch { throw new Error("fixture broken"); }
  const asIfEvidencePack = (wrapper.result.data as { evidence?: unknown }).evidence;
  assert.equal(asIfEvidencePack, undefined, "the pack, not the evidence, sits directly under result.data");
});

test("R2.4/N5 closed-set matching vectors", () => {
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(MACRO_DATA))!)!;
  const jobless = compact.upcoming.find((e) => e.event.startsWith("U.S. jobless"))!;
  assert.equal(isClosedSetEvent(jobless), false, "jobless-claims metrics start with continuing/initial/jobless, never match");
  const pce = compact.later.find((e) => e.event.startsWith("PCE"))!;
  assert.equal(isClosedSetEvent(pce), true, "PCE inflation release matches by name");
  const adp = compact.later.find((e) => e.event.startsWith("ADP"))!;
  assert.equal(isClosedSetEvent(adp), false, "an ADP-named row does not match");
  const fomcMinutes = compact.later.find((e) => e.event === "FOMC Minutes")!;
  assert.equal(isClosedSetEvent(fomcMinutes), false, "FOMC Minutes is not a rate decision");
  // N5 residual: CPI / federal funds rate naming additions.
  assert.equal(isClosedSetEvent({ event: "Consumer Price Index Release", eventAtMs: null, importance: "major", status: "scheduled",
    metrics: [{ metric: "Consumer Price Index YoY", actual: null, estimate: null, previous: null, unit: "%" }] }), true);
  assert.equal(isClosedSetEvent({ event: "Fed Decision", eventAtMs: null, importance: "major", status: "scheduled",
    metrics: [{ metric: "Federal Funds Rate Upper Bound", actual: null, estimate: null, previous: null, unit: "%" }] }), true);
});

test("AUDIT H-R1: a 9-metric employment event whose NFP metric sorts 6th (alphabetical, as the vendor lists them) stays closed-set after the 3-metric cap", () => {
  // The vendor lists metrics alphabetically (measured on PCE/jobless); a standard
  // employment report's alphabetical order puts "Non Farm Payrolls" 6th of 9.
  const EMPLOYMENT_METRICS = [
    "Average Hourly Earnings MoM", "Average Hourly Earnings YoY", "Average Weekly Hours",
    "Government Payrolls", "Manufacturing Payrolls", "Non Farm Payrolls",
    "Participation Rate", "U-6 Underemployment Rate", "Unemployment Rate",
  ].map((metric) => ({ metric, estimate: 1, previous: 1, unit: "K" }));
  const releasedAt = "2026-09-25T12:30:00Z";
  const data = { evidence: {
    upcoming_events_72h: [{ event: "U.S. employment report", event_at: releasedAt, importance: "major", event_status: "scheduled", metrics: EMPLOYMENT_METRICS }],
    later_events_days_4_to_7: [], recent_macro_releases: [],
  } };
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(data))!)!;
  const event = compact.upcoming.find((e) => e.event === "U.S. employment report")!;
  assert.ok(event, "the event survives compaction");
  assert.ok(event.metrics.length <= 3, `expected the 3-metric cap, got ${event.metrics.length}`);
  assert.ok(event.metrics.some((m) => m.metric === "Non Farm Payrolls"), "NFP must survive the cap despite sorting 6th");
  assert.equal(isClosedSetEvent(event), true, "the event is still closed-set after compaction");
  // 08:00 ET the same day: within [-12h,+48h] of the 08:30 ET release -> eventRisk must not be none.
  const risk = macroEventRiskUsEquity(compact, Date.UTC(2026, 8, 25, 12, 0));
  assert.equal(risk, "high", "the ×0.6 NFP size guard must fire, not silently turn off");
});

test("AUDIT FC-1: a 10-metric employment event whose NFP metric sorts 7th (alphabetical, as the vendor lists them) stays closed-set after BOTH the 6-metric raw-parse slice and the 3-metric compaction cap", () => {
  // One more alphabetically-earlier metric than the H-R1 fixture (9 metrics,
  // NFP 6th) pushes NFP to 7th of 10 — past `readMacroEvent`'s own 6-metric
  // slice (line ~231), which used to run BEFORE any closed-set reorder and so
  // could drop NFP before `cap3Metrics` ever saw it, even though H-R1's fix
  // to `cap3Metrics` alone was in place.
  const EMPLOYMENT_METRICS = [
    "Average Hourly Earnings MoM", "Average Hourly Earnings YoY", "Average Weekly Hours",
    "Government Payrolls", "Manufacturing Payrolls", "Mining Payrolls", "Non Farm Payrolls",
    "Participation Rate", "U-6 Underemployment Rate", "Unemployment Rate",
  ].map((metric) => ({ metric, estimate: 1, previous: 1, unit: "K" }));
  assert.equal(EMPLOYMENT_METRICS.findIndex((m) => m.metric === "Non Farm Payrolls"), 6, "sanity: NFP is the 7th of 10 (index 6)");
  const releasedAt = "2026-09-25T12:30:00Z";
  const data = { evidence: {
    upcoming_events_72h: [{ event: "U.S. employment report", event_at: releasedAt, importance: "major", event_status: "scheduled", metrics: EMPLOYMENT_METRICS }],
    later_events_days_4_to_7: [], recent_macro_releases: [],
  } };
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(data))!)!;
  const event = compact.upcoming.find((e) => e.event === "U.S. employment report")!;
  assert.ok(event, "the event survives compaction");
  assert.ok(event.metrics.length <= 3, `expected the 3-metric cap, got ${event.metrics.length}`);
  assert.ok(event.metrics.some((m) => m.metric === "Non Farm Payrolls"), "NFP must survive both the 6-slice and the 3-cap despite sorting 7th");
  assert.equal(isClosedSetEvent(event), true, "the event is still closed-set after compaction");
  const risk = macroEventRiskUsEquity(compact, Date.UTC(2026, 8, 25, 12, 0));
  assert.equal(risk, "high", "the ×0.6 NFP size guard must fire, not silently turn off");
});

test("AUDIT L-R1: a just-released closed-set event (recent) outranks closed-set events still 4-7 days out (later), so a fresh CPI is never trimmed away", () => {
  const laterClosedSet = Array.from({ length: 7 }, (_unused, i) => ({
    event: `PCE inflation release ${i}`, event_at: `2026-09-${27 + i}T12:30:00Z`, importance: "major", event_status: "scheduled",
    metrics: [
      { metric: "Core PCE Price Index MoM (Aug)", estimate: 0.3, previous: 0.2, unit: "%" },
      { metric: "Core PCE Price Index YoY (Aug)", estimate: 3.4, previous: 3.3, unit: "%" },
      { metric: "PCE Price Index MoM (Aug)", estimate: 0.3, previous: 0.2, unit: "%" },
    ],
  }));
  const recentCpi = { event: "Core Inflation Rate", event_at: "2026-09-23T10:00:00Z", importance: "major", event_status: "released",
    metrics: [{ metric: "Core Inflation Rate YoY (Aug)", actual: 3.3, estimate: 3.4, previous: 3.3, unit: "%" }] };
  const data = { evidence: { upcoming_events_72h: [], later_events_days_4_to_7: laterClosedSet, recent_macro_releases: [recentCpi] } };
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(data))!)!;
  assert.ok(compact.recent.some((e) => e.event === "Core Inflation Rate"), "the just-released CPI must survive the trim");
  // With `recent` still ranked ahead of `later`, the next closed-set line points at the fresh release, not next week's PCE.
  const line = macroPromptLine(compact, Date.UTC(2026, 8, 23, 11, 0));
  assert.ok(line.includes("Core Inflation Rate"), line);
});

test("macroEventRiskUsEquity: high only for a closed-set event within [-12h, +48h]", () => {
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(MACRO_DATA))!)!;
  // Jobless claims (major, not closed-set) is within the window but must not trip the flag.
  assert.equal(macroEventRiskUsEquity(compact, Date.UTC(2026, 8, 24, 6)), "none");
  // PCE is 2026-09-30 12:30Z; from 2026-09-28 12:30Z it is inside +48h.
  assert.equal(macroEventRiskUsEquity(compact, Date.UTC(2026, 8, 28, 13)), "high");
  assert.equal(macroEventRiskUsEquity(compact, Date.UTC(2026, 8, 20)), "none");
});

test("nextClosedSetEvent and macroPromptLine render the PCE consensus line", () => {
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(MACRO_DATA))!)!;
  const next = nextClosedSetEvent(compact, Date.UTC(2026, 8, 24));
  assert.equal(next?.event, "PCE inflation release");
  const line = macroPromptLine(compact, Date.UTC(2026, 8, 24));
  assert.ok(line.includes("PCE inflation release"), line);
  // AUDIT FC (LOW): both PCE metrics match the closed set ("core pce price
  // index" prefix), so the consensus line picks the FIRST closed-set-matching
  // metric (MoM) ahead of a plain "YoY" preference — a closed-set match now
  // always outranks the YoY heuristic per the fixed priority order.
  assert.ok(line.includes("Core PCE Price Index MoM"), line);
  assert.ok(line.includes("0.3"), line);
  assert.equal(macroPromptLine(null, Date.UTC(2026, 8, 24)), "next closed-set: unknown (no fresh macro row)");
});

test("AUDIT FC (LOW): the NFP prompt line prefers the closed-set-matching Non Farm Payrolls metric over an earlier plain-YoY metric", () => {
  const data = { evidence: {
    upcoming_events_72h: [{ event: "U.S. employment report", event_at: "2026-09-25T12:30:00Z", importance: "major", event_status: "scheduled",
      metrics: [
        { metric: "Average Hourly Earnings YoY", estimate: 3.7, previous: 3.6, unit: "%" },
        { metric: "Non Farm Payrolls", estimate: 150, previous: 140, unit: "K" },
      ] }],
    later_events_days_4_to_7: [], recent_macro_releases: [],
  } };
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(data))!)!;
  const line = macroPromptLine(compact, Date.UTC(2026, 8, 20));
  assert.ok(line.includes("Non Farm Payrolls"), line);
  assert.ok(!line.includes("Average Hourly Earnings YoY"), line);
});

test("N6: unmatchedMajorEvents lists major rows that missed the closed set, bounded", () => {
  const compact = readCompactMacro(compactMacroUsEquity(wrapData(MACRO_DATA))!)!;
  const unmatched = unmatchedMajorEvents(compact);
  assert.ok(unmatched.includes("U.S. jobless-claims release"));
  assert.ok(unmatched.includes("ADP Nonfarm Employment Change"));
  assert.ok(unmatched.includes("FOMC Minutes"));
  assert.ok(!unmatched.some((e) => e.startsWith("PCE")));
});

// ---------------------------------------------------------------------------
// H3: planning — current_relation is the CLOSE's relation to the zone
// ---------------------------------------------------------------------------

const PLANNING_ZONES = [
  { center_price: 217.91, effective_role: "support", current_relation: "above", zone_low: 217.2852, zone_high: 218.5348, distance_from_close_atr: 1.75 },
  { center_price: 227.6599, effective_role: "transition", current_relation: "above", zone_low: 226.7751, zone_high: 228.5448, distance_from_close_atr: 0.19 },
  { center_price: 231.375, effective_role: "resistance", current_relation: "below", zone_low: 229.8452, zone_high: 232.9048, distance_from_close_atr: 0.4 },
  { center_price: 235.65, effective_role: "resistance", current_relation: "below", zone_low: 234.1352, zone_high: 237.1648, distance_from_close_atr: 1.09 },
];
const PLANNING_DATA = {
  evidence: {
    identity: { name: "Nvidia Corp", security_type: "common_stock", sector_proxy: { symbol: "SMH", mapping_quality: "high" } },
    price_basis: { is_realtime: false, latest_close_usd: 228.87 },
    market_structure: {
      returns_pct: { "5": 7.87, "20": 9.78, "63": 14.41 },
      ema_distance_pct: { "20": 3.91, "50": 5.89, "200": 14.55 },
      ema_change_5d_pct: { "20": 0.847, "50": 0.673 },
      atr14_pct: 2.73,
    },
    benchmark_context: { relative_returns_pct: { SPY: { "5": 5.76, "20": 8.48, "63": 8.99 } } },
    last_completed_session: { session_date: "2026-09-22" },
    key_levels: { static_zones: PLANNING_ZONES },
  },
};

test("H3: nearest support/resistance pick effective_role + current_relation, not price order", () => {
  const compact = readCompactPlanning(compactPlanning(wrapOutput(PLANNING_DATA))!)!;
  assert.equal(compact.support?.lowUsd, 217.2852);
  assert.equal(compact.support?.distanceAtr, 1.75);
  assert.equal(compact.resistance?.lowUsd, 229.8452);
  assert.equal(compact.resistance?.distanceAtr, 0.4);
  assert.equal(compact.sessionDate, "2026-09-22");
  assert.equal(compact.atr14Pct, 2.73);
  assert.equal(compact.sectorProxy, "SMH");
});

// ---------------------------------------------------------------------------
// Sector rotation
// ---------------------------------------------------------------------------

const SECTOR_DATA = {
  evidence: {
    window_context: { market_phase: "regular" },
    sector_rotation: [
      { group: "Energy", market_observation: {}, metrics: { rank: 1, excess_pct: { vs_sp500: { current_21_session: -3.6253 } }, rotation_state: "fading_leadership" } },
      { group: "Information Technology", market_observation: {}, metrics: { rank: 3, excess_pct: { vs_sp500: { current_21_session: 1.2 } }, rotation_state: "early_relative_strength_turn" } },
    ],
    theme_rotation: [
      { group: "Semiconductors", market_observation: {}, metrics: { rank: 7, excess_pct: { vs_sp500: { current_21_session: 7.11 } }, rotation_state: "early_relative_strength_turn" } },
    ],
    growth_vs_defensive: { style_leader: "growth", growth_minus_defensive_pp: 4.9539 },
    benchmark_context: [
      { benchmark: "S&P 500", market_observation: { change_from_open_pct: -0.5224 } },
      { benchmark: "Nasdaq Composite", market_observation: { change_from_open_pct: -0.897 } },
    ],
  },
};

test("sector rotation compaction keeps rank/excess/rotation_state and the style leader", () => {
  const compact = readCompactSector(compactSectorRotation(wrapOutput(SECTOR_DATA))!)!;
  const it = compact.sectors.find((s) => s.group === "Information Technology");
  assert.equal(it?.rank, 3);
  assert.equal(it?.rotationState, "early_relative_strength_turn");
  assert.equal(compact.styleLeader, "growth");
  assert.equal(compact.benchmarks.find((b) => b.benchmark === "S&P 500")?.changeFromOpenPct, -0.5224);
});

test("L4: a post-close row missing market_observation reads a null change, not a throw", () => {
  const data = { evidence: { ...SECTOR_DATA.evidence, benchmark_context: [{ benchmark: "S&P 500" }] } };
  const compact = readCompactSector(compactSectorRotation(wrapOutput(data))!)!;
  assert.equal(compact.benchmarks[0]?.changeFromOpenPct, null);
});

// ---------------------------------------------------------------------------
// R2.6 prompt lines: worded text, missing data renders "unknown"
// ---------------------------------------------------------------------------

test("marketPromptLine and tickerPromptLine render worded text with the measured NVDA vector", () => {
  const sector = readCompactSector(compactSectorRotation(wrapOutput(SECTOR_DATA))!);
  const scanner = readCompactScanner(compactScanner(wrapOutput(SCANNER_DATA))!);
  const planning = readCompactPlanning(compactPlanning(wrapOutput(PLANNING_DATA))!);
  const market = marketPromptLine(sector);
  assert.ok(market.includes("growth"), market);
  assert.ok(market.includes("S&P 500"), market);
  const line = tickerPromptLine({ ticker: "NVDA", cls: tickerClass("NVDA"), sector, scanner, planning, planningFresh: true });
  assert.ok(line.startsWith("NVDA —"), line);
  assert.ok(line.includes("Semiconductors"), line);
  assert.ok(line.includes("historical structure watch"), line);
  assert.ok(line.includes("2026-09-22"), line);
  assert.ok(line.includes("217.29"), line);
  const stale = tickerPromptLine({ ticker: "NVDA", cls: tickerClass("NVDA"), sector, scanner, planning, planningFresh: false });
  assert.ok(stale.includes("EOD structure: unknown"), stale);
  const unmapped = tickerPromptLine({ ticker: "ZZZZ", cls: null, sector, scanner, planning: null, planningFresh: false });
  assert.ok(unmapped.includes("sector unknown"), unmapped);
  // AUDIT L-R3: rotation_state renders with spaces, never the raw underscored form.
  assert.ok(line.includes("early relative strength turn"), line);
  assert.ok(!line.includes("early_relative_strength_turn"), line);
  // AUDIT L-R3: a MISSING sector row (not "sector present but this GICS name absent")
  // renders a plain "sector unknown", not "sector Information Technology (unranked, unknown)".
  const missingSectorRow = tickerPromptLine({ ticker: "NVDA", cls: tickerClass("NVDA"), sector: null, scanner, planning, planningFresh: true });
  assert.ok(missingSectorRow.includes("sector unknown"), missingSectorRow);
  assert.ok(!missingSectorRow.includes("unranked"), missingSectorRow);
});

// ---------------------------------------------------------------------------
// M3: ticker map covers the measured 28-ticker pin
// ---------------------------------------------------------------------------

const PIN_28 = ["BABA", "BILI", "CRCL", "DIS", "FXI", "GME", "GOOGL", "HOOD", "INTC", "META",
  "MRVL", "MSFT", "MSTR", "NOK", "NVDA", "PDD", "QQQ", "SGOV", "SKHY", "SNDK", "SNXX", "SOXL", "SPCX", "SPY", "TLT", "TQQQ", "TSLA", "TSM"];

test("M3: the static map covers the measured 28-ticker pin with kind stock|etf|unresolvable", () => {
  assert.equal(PIN_28.length, 28);
  for (const ticker of PIN_28) {
    const cls = tickerClass(ticker);
    assert.ok(cls !== null, `${ticker} is unmapped`);
    assert.ok(cls!.kind === "stock" || cls!.kind === "etf" || cls!.kind === "unresolvable");
  }
  assert.equal(tickerClass("SPY")?.kind, "etf");
  assert.equal(tickerClass("QQQ")?.kind, "etf");
  assert.equal(tickerClass("SKHY")?.kind, "unresolvable");
  assert.equal(tickerClass("SPCX")?.kind, "unresolvable");
  assert.equal(tickerClass("NOTAPIN")?.kind, undefined);
  assert.equal(tickerClass("NOTAPIN"), null);
  // Sector strings are verbatim GICS strings measured on the sector-rotation payload.
  const stockClasses = Object.values(US_EQUITY_TICKER_CLASS).filter((c) => c.kind === "stock") as { readonly sector: string | null }[];
  const measuredSectors = new Set(["Energy", "Health Care", "Information Technology", "Communication Services", "Financials",
    "Materials", "Consumer Staples", "Consumer Discretionary", "Real Estate", "Industrials", "Utilities"]);
  for (const cls of stockClasses) if (cls.sector !== null) assert.ok(measuredSectors.has(cls.sector), cls.sector);
});

// ---------------------------------------------------------------------------
// R2.1/N1/N7: validity table, weekday/weekend, DST anchor 2026-11-01
// ---------------------------------------------------------------------------

test("tradingDayDue: no call before the anchor, due once crossed, not due again same day", () => {
  // Wed 2026-09-23 is a trading day (EDT, UTC-4). 10:30 ET = 14:30 UTC.
  const beforeAnchor = Date.UTC(2026, 8, 23, 14, 0);
  const atAnchor = Date.UTC(2026, 8, 23, 14, 31);
  assert.equal(tradingDayDue(-Infinity, beforeAnchor, SECTOR_ANCHOR_MINUTE), false);
  assert.equal(tradingDayDue(-Infinity, atAnchor, SECTOR_ANCHOR_MINUTE), true);
  assert.equal(tradingDayDue(atAnchor, atAnchor + 60_000, SECTOR_ANCHOR_MINUTE), false, "already served this window");
});

test("M7: weekend calls are never due for trading-day-gated skills", () => {
  // Sat 2026-09-26.
  const saturday = Date.UTC(2026, 8, 26, 20, 0);
  assert.equal(isNyTradingDay(saturday), false);
  assert.equal(tradingDayDue(-Infinity, saturday, SECTOR_ANCHOR_MINUTE), false);
  assert.equal(tradingDayDue(-Infinity, saturday, SCANNER_ANCHOR_MINUTE), false);
});

test("dailyDue: macro/global run every day including weekends", () => {
  const saturdayMorning = Date.UTC(2026, 8, 26, 13, 0); // after 08:00 EDT
  assert.equal(dailyDue(-Infinity, saturdayMorning, MACRO_ANCHOR_MINUTE), true);
});

test("sectorScannerValidUntilMs: a Friday row stays valid through Monday's anchor + 2h", () => {
  // Fri 2026-09-25 11:00 ET (EDT, UTC-4) fetch.
  const fridayFetch = Date.UTC(2026, 8, 25, 15, 0);
  const validUntil = sectorScannerValidUntilMs(fridayFetch, SECTOR_ANCHOR_MINUTE);
  // Monday 2026-09-28 10:30 ET (EDT) + 2h margin = 12:30 ET = 16:30 UTC.
  const mondayBeforeExpiry = Date.UTC(2026, 8, 28, 16, 0);
  const mondayAfterExpiry = Date.UTC(2026, 8, 28, 17, 0);
  assert.ok(validUntil > mondayBeforeExpiry, new Date(validUntil).toISOString());
  assert.ok(validUntil < mondayAfterExpiry, new Date(validUntil).toISOString());
});

test("N7/DST: the Sunday 2026-11-01 DST-end anchor lands at 08:00 EST (13:00 UTC), not EDT", () => {
  const beforeAnchor = Date.UTC(2026, 10, 1, 12, 0); // 07:00 EST, before the 08:00 ET anchor
  const afterAnchor = Date.UTC(2026, 10, 1, 13, 30); // 08:30 EST, after it
  assert.equal(dailyDue(-Infinity, beforeAnchor, MACRO_ANCHOR_MINUTE), false);
  assert.equal(dailyDue(-Infinity, afterAnchor, MACRO_ANCHOR_MINUTE), true);
  assert.ok(Number.isFinite(sectorScannerValidUntilMs(afterAnchor, SECTOR_ANCHOR_MINUTE)));
});

test("N1: planning due/valid — due when session_date is stale, valid for the prompt across the last two completed sessions", () => {
  // Tue 2026-09-22 17:00 ET (after the 16:00 close) -> latest completed session is Tue itself.
  const nowMs = Date.UTC(2026, 8, 22, 21, 0);
  assert.equal(latestCompletedNySessionDate(nowMs), "2026-09-22");
  assert.equal(planningDue("2026-09-22", nowMs), false);
  assert.equal(planningDue("2026-09-19", nowMs), true);
  assert.equal(planningDue(null, nowMs), true);
  assert.equal(planningValidForPrompt("2026-09-22", nowMs), true);
  assert.equal(planningValidForPrompt("2026-09-21", nowMs), true, "one session back (prior Monday) is still valid for the prompt");
  assert.equal(planningValidForPrompt("2026-09-18", nowMs), false, "two sessions back is not");
});

test("N1: Monday before the close still shows Friday's block (no 30h cliff)", () => {
  // Mon 2026-09-28 13:00 ET, before the 16:00 close -> latest completed session is Friday.
  const mondayMorning = Date.UTC(2026, 8, 28, 17, 0);
  assert.equal(latestCompletedNySessionDate(mondayMorning), "2026-09-25");
  assert.equal(planningValidForPrompt("2026-09-25", mondayMorning), true);
});

test("R2.7: isCurrentCmcSkill accepts the five current skills/tool and rejects retired ones (crypto macro events, probes, the dossier)", () => {
  assert.equal(isCurrentCmcSkill(CMC_SKILL_MACRO), true);
  assert.equal(isCurrentCmcSkill(CMC_SKILL_MACRO_RELEASE), true);
  assert.equal(isCurrentCmcSkill(CMC_SKILL_SECTOR), true);
  assert.equal(isCurrentCmcSkill(CMC_SKILL_SCANNER), true);
  assert.equal(isCurrentCmcSkill(CMC_SKILL_PLANNING), true);
  assert.equal(isCurrentCmcSkill(CMC_GLOBAL_TOOL), true);
  assert.equal(isCurrentCmcSkill("get_upcoming_macro_events"), false, "the old crypto macro-event tool is filtered out");
  assert.equal(isCurrentCmcSkill("us_equity_research_dossier"), false, "the retired dossier is filtered out");
  assert.equal(isCurrentCmcSkill("us_equity_sector_rotation:probe"), false, "a probe-suffixed key is not the current skill");
  assert.equal(isCurrentCmcSkill("us_equity_momentum_scanner"), false);
  assert.equal(isCurrentCmcSkill("us_equity_index_snapshot"), false);
});

test("N9: shouldLogCmcObservation logs an observation once per (UTC day, ticker), and again the next day", () => {
  const seen = new Set<string>();
  assert.equal(shouldLogCmcObservation(seen, "2026-09-23", "unmapped:ZZZZ"), true, "first sighting logs");
  assert.equal(shouldLogCmcObservation(seen, "2026-09-23", "unmapped:ZZZZ"), false, "repeat same day is suppressed");
  assert.equal(shouldLogCmcObservation(seen, "2026-09-23", "unmapped:YYYY"), true, "a different ticker still logs the same day");
  // The caller resets/replaces the Set at the UTC day boundary (scripts/trade-worker.ts);
  // simulate that here with a fresh Set for the next day.
  const nextDay = new Set<string>();
  assert.equal(shouldLogCmcObservation(nextDay, "2026-09-24", "unmapped:ZZZZ"), true, "the next UTC day logs again");
});

test("N4/AUDIT HIGH-1: macroReleaseDue fires once for a closed-set release, refuses a second same-day release, and never re-fires after ET midnight for yesterday's event", () => {
  // The daily macro row was fetched at 08:00 ET. GDP releases at 08:30 ET;
  // FOMC (closed-set via "fed interest rate decision") at 14:00 ET, same day.
  const dailyFetchAt = Date.UTC(2026, 8, 23, 12, 0); // 08:00 EDT
  const gdpAt = Date.UTC(2026, 8, 23, 12, 30); // 08:30 EDT
  const fomcAt = Date.UTC(2026, 8, 23, 18, 0); // 14:00 EDT
  const macroAfterGdp = { upcoming: [], later: [], recent: [
    { event: "GDP Growth Rate", eventAtMs: gdpAt, importance: "major", status: "released",
      metrics: [{ metric: "GDP Growth Rate QoQ", actual: 2.1, estimate: 2.0, previous: 1.8, unit: "%" }] },
  ] };
  // 40 minutes after GDP (past the 30-min lag), no release call attempted yet today.
  const afterGdpLag = gdpAt + 40 * 60_000;
  assert.equal(macroReleaseDue({ macro: macroAfterGdp, macroRowAsOfMs: dailyFetchAt, releaseLastActivityMs: -Infinity, nowMs: afterGdpLag }),
    true, "the first qualifying release (after the daily fetch) is due");
  // The +1 call fires and is recorded (releaseLastActivityMs = afterGdpLag).
  const macroAfterFomc = { upcoming: [], later: [], recent: [
    ...macroAfterGdp.recent,
    { event: "Fed Interest Rate Decision", eventAtMs: fomcAt, importance: "major", status: "released",
      metrics: [{ metric: "Fed Interest Rate Decision", actual: 4.0, estimate: 4.0, previous: 4.25, unit: "%" }] },
  ] };
  const afterFomcLag = fomcAt + 40 * 60_000;
  assert.equal(macroReleaseDue({ macro: macroAfterFomc, macroRowAsOfMs: dailyFetchAt, releaseLastActivityMs: afterGdpLag, nowMs: afterFomcLag }),
    false, "N4: at most one +1 per calendar day — FOMC's own release does not earn a second +1 the same day");
  // AUDIT HIGH-1: after ET midnight, FOMC (still inside the 24h lookback) must NOT
  // re-fire — the fix requires the event to be on the SAME ET calendar day as `nowMs`.
  const nextDay = afterFomcLag + 20 * 60 * 60_000;
  assert.equal(macroReleaseDue({ macro: macroAfterFomc, macroRowAsOfMs: dailyFetchAt, releaseLastActivityMs: afterGdpLag, nowMs: nextDay }),
    false, "yesterday's release does not re-fire the +1 on a new ET day");
});

// ---------------------------------------------------------------------------
// R2.8: raw-probe-shaped fixtures through ingest for all four US-equity
// skills (of the five surveyed probes — `us_equity_index_snapshot` is the
// fifth and is proven never requested elsewhere), asserting `available` plus
// the H6 compacted-size bound (<= CMC_MAX_TICKER_CHARS, applied post-compaction).
// ---------------------------------------------------------------------------

test("R2.8: raw-probe-shaped fixtures compact to `available` within the H6 size bound, for every skill actually used", () => {
  const sector = compactSectorRotation(wrapOutput(SECTOR_DATA));
  assert.ok(sector !== null, "sector rotation compacts");
  assert.ok(sector!.length <= CMC_MAX_TICKER_CHARS, `sector compacted to ${sector!.length} chars`);

  const scanner = compactScanner(wrapOutput(SCANNER_DATA));
  assert.ok(scanner !== null, "scanner compacts");
  assert.ok(scanner!.length <= CMC_MAX_TICKER_CHARS, `scanner compacted to ${scanner!.length} chars`);

  const macro = compactMacroUsEquity(wrapData(MACRO_DATA));
  assert.ok(macro !== null, "macro compacts");
  assert.ok(macro!.length <= CMC_MAX_TICKER_CHARS, `macro compacted to ${macro!.length} chars`);

  const planning = compactPlanning(wrapOutput(PLANNING_DATA));
  assert.ok(planning !== null, "planning compacts");
  assert.ok(planning!.length <= CMC_MAX_TICKER_CHARS, `planning compacted to ${planning!.length} chars`);

  // The fifth surveyed probe, us_equity_index_snapshot, has no compaction path:
  // it is not one of the four skills this runtime ever requests (never wired
  // into cmcNews.ts's selectTarget), matching the operator ruling to drop it.
});

test("M5/AUDIT M10: lastActivityMs picks the LATER of a successful fetch and a subsequent failed attempt, never the earlier one", () => {
  assert.equal(lastActivityMs(null), -Infinity, "no row at all is never active");
  assert.equal(lastActivityMs({ asOfMs: 1_000 }), 1_000, "no lastAttemptAtMs field: falls back to asOfMs");
  assert.equal(lastActivityMs({ asOfMs: 1_000, lastAttemptAtMs: null }), 1_000, "a null lastAttemptAtMs: falls back to asOfMs");
  // A failure AFTER the last successful fetch (the exact M10 scenario: an
  // available row that later gets a failed re-attempt) must move "due"
  // forward to the failure's own time, not the stale fetch time.
  assert.equal(lastActivityMs({ asOfMs: 1_000, lastAttemptAtMs: 5_000 }), 5_000, "a later failed attempt wins over the older successful fetch");
  // A stale lastAttemptAtMs from a PRIOR window must not shadow a NEWER successful fetch.
  assert.equal(lastActivityMs({ asOfMs: 9_000, lastAttemptAtMs: 5_000 }), 9_000, "a newer successful fetch wins over an older failed attempt");
});

test("live 2026-09-25: a macro pack with an absent window compacts (absent = empty); a wrong-typed window or no window stays invalid", () => {
  const { later_events_days_4_to_7: _later, recent_macro_releases: _recent, ...evidence } = MACRO_DATA.evidence;
  const compact = compactMacroUsEquity(wrapData({ ...MACRO_DATA, evidence }));
  assert.ok(compact !== null);
  const read = readCompactMacro(compact!);
  assert.equal(read?.upcoming.length, 2);
  assert.equal(read?.later.length, 0);
  assert.equal(read?.recent.length, 0);
  assert.equal(compactMacroUsEquity(wrapData({ ...MACRO_DATA, evidence: { ...MACRO_DATA.evidence, recent_macro_releases: "none" } })), null);
  assert.equal(compactMacroUsEquity(wrapData({ ...MACRO_DATA, evidence: { recent_news_events: [] } })), null);
});

/**
 * AUDIT HIGH-3 / MEDIUM-2: size-bound tests against the FULL real probe
 * payloads (not hand-trimmed fixtures), copied into `test/fixtures/cmc-probes/`
 * from `scripts/tmp/probe-*.json` (2026-09-23 captures). The raw probe file's
 * top-level JSON is already the exact wrapper shape each compactor expects
 * (`{result:{output:"<pack json>"}}` or, for macro, `{result:{data:{...pack}}}`),
 * so the file's text is passed to the compactor unmodified.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CMC_MAX_TICKER_CHARS } from "../src/trade/cmc.js";
import {
  compactEventCalendar,
  compactMacroUsEquity,
  eventsPromptPart,
  readCompactEvents,
  compactPlanning,
  compactScanner,
  compactSectorRotation,
  isClosedSetEvent,
  readCompactMacro,
  readCompactPlanning,
  readCompactScanner,
  readCompactSector,
} from "../src/trade/cmcUsEquity.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cmc-probes");
function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

test("MEDIUM-2/R2.8: the FULL real sector-rotation probe (28 834 raw chars, 11 sectors + 10 themes) compacts to `available` within the H6 bound", () => {
  const raw = readFixture("probe-us_equity_sector_rotation.json");
  const compact = compactSectorRotation(raw);
  assert.ok(compact !== null, "the full real sector payload must compact");
  assert.ok(compact!.length <= CMC_MAX_TICKER_CHARS, `compacted to ${compact!.length} chars`);
  const read = readCompactSector(compact!)!;
  assert.equal(read.sectors.length, 11);
  assert.equal(read.themes.length, 10);
});

test("MEDIUM-2/R2.8: the FULL real scanner probe compacts to `available` within the H6 bound and keeps both measured candidates", () => {
  const raw = readFixture("probe-us_equity_uptrend_quality_scanner.json");
  const compact = compactScanner(raw);
  assert.ok(compact !== null);
  assert.ok(compact!.length <= CMC_MAX_TICKER_CHARS, `compacted to ${compact!.length} chars`);
  const read = readCompactScanner(compact!)!;
  assert.deepEqual(read.candidates.map((c) => c.symbol).sort(), ["MSFT", "NVDA"]);
});

test("MEDIUM-2/R2.8: the FULL real planning probe (20 971 raw chars) compacts to `available` within the H6 bound, NVDA support/resistance intact", () => {
  const raw = readFixture("probe-us_equity_trade_planning_context.json");
  const compact = compactPlanning(raw);
  assert.ok(compact !== null);
  assert.ok(compact!.length <= CMC_MAX_TICKER_CHARS, `compacted to ${compact!.length} chars`);
  const read = readCompactPlanning(compact!)!;
  assert.equal(read.support?.lowUsd, 217.2852);
  assert.equal(read.resistance?.lowUsd, 229.8452);
});

test("MEDIUM-2/R2.8: the FULL real macro probe (a quiet day, 6 events) compacts to `available` within the H6 bound", () => {
  const raw = readFixture("probe-macro_news_aggregator.json");
  const compact = compactMacroUsEquity(raw);
  assert.ok(compact !== null);
  assert.ok(compact!.length <= CMC_MAX_TICKER_CHARS, `compacted to ${compact!.length} chars`);
  const read = readCompactMacro(compact!)!;
  const all = [...read.upcoming, ...read.later, ...read.recent];
  assert.ok(all.some((e) => e.event === "PCE inflation release"));
});

test("AUDIT HIGH-3: the real macro probe DOUBLED in events (>=3 555 raw-compacted chars before the fix) still parses, and closed-set events are retained over lower-priority ones", () => {
  type MacroEvidence = { readonly upcoming_events_72h: readonly unknown[]; readonly later_events_days_4_to_7: readonly unknown[]; readonly recent_macro_releases: readonly unknown[] };
  const raw = JSON.parse(readFixture("probe-macro_news_aggregator.json")) as { readonly result: { readonly data: unknown } };
  const pack = raw.result.data as { readonly data: { readonly evidence: MacroEvidence } };
  const evidence = pack.data.evidence;
  const doubled = {
    ...raw,
    result: { ...raw.result, data: { ...pack, data: { ...pack.data, evidence: {
      ...evidence,
      upcoming_events_72h: [...evidence.upcoming_events_72h, ...evidence.upcoming_events_72h],
      later_events_days_4_to_7: [...evidence.later_events_days_4_to_7, ...evidence.later_events_days_4_to_7],
      recent_macro_releases: [...evidence.recent_macro_releases, ...evidence.recent_macro_releases],
    } } } },
  };
  const doubledText = JSON.stringify(doubled);

  // Confirm the doubled payload really would have broken the OLD slice-based
  // bound: parse-then-serialize the doubled evidence with NO self-bounding,
  // the way the pre-fix compactor did, and check it exceeds the cap.
  const unboundedSize = JSON.stringify({
    upcoming: doubled.result.data.data.evidence["upcoming_events_72h"],
    later: doubled.result.data.data.evidence["later_events_days_4_to_7"],
    recent: doubled.result.data.data.evidence["recent_macro_releases"],
  }).length;
  assert.ok(unboundedSize >= 3_000, `expected the doubled, unbounded payload to be large (>=3000 chars), got ${unboundedSize}`);

  const compact = compactMacroUsEquity(doubledText);
  assert.ok(compact !== null, "the doubled payload must still compact to `available`, not `invalid`");
  assert.ok(compact!.length <= CMC_MAX_TICKER_CHARS, `doubled payload compacted to ${compact!.length} chars, over the ${CMC_MAX_TICKER_CHARS} cap`);
  const read = readCompactMacro(compact!)!;
  const all = [...read.upcoming, ...read.later, ...read.recent];
  assert.ok(all.some((e) => isClosedSetEvent(e)), "at least one closed-set event (PCE) survives the trim");
  assert.ok(all.some((e) => e.event === "PCE inflation release"), "PCE specifically is retained (closed-set, high priority)");
});

/** The G0 event-calendar capture is the raw SSE transport body; the compactor receives the joined MCP text content, as `textContent` does. */
function sseText(raw: string): string {
  const line = raw.split(/\r?\n/u).find((candidate) => candidate.startsWith("data:")) ?? "";
  const message = JSON.parse(line.slice("data:".length)) as { result: { content: { text: string }[] } };
  return message.result.content.map((part) => part.text).join("");
}

test("G0 follow-up: the REAL event-calendar probe (NVDA, 2026-09-25) keeps only company events, dated, within the bound", () => {
  const compact = compactEventCalendar(sseText(readFixture("probe-us_equity_upcoming_event_calendar-NVDA.json")));
  assert.ok(compact !== null, "the real event-calendar payload must compact");
  assert.ok(compact!.length <= CMC_MAX_TICKER_CHARS, `compacted to ${compact!.length} chars`);
  const read = readCompactEvents(compact!)!;
  assert.equal(read.symbol, "NVDA");
  assert.equal(read.windowEnd, "2026-10-02");
  assert.deepEqual(read.events, [{ date: "2026-10-01", type: "dividend", title: "Dividend schedule" }]);
  assert.equal(eventsPromptPart(read), "company events: dividend 2026-10-01");
  assert.equal(eventsPromptPart({ ...read, events: [] }), "company events: none through 2026-10-02");
  assert.equal(compactEventCalendar(JSON.stringify({ result: { ok: true, data: { data: { status: "ok" } } } })), null, "no events array is unrecognized");
});

test("live 2026-09-27: the macro and event-calendar packs parse from BOTH envelopes (result.data object and result.output string)", () => {
  const raw = readFixture("probe-macro_news_aggregator.json");
  const wrapper = JSON.parse(raw) as { result: { data: unknown } };
  const asOutput = JSON.stringify({ result: { ok: true, output: JSON.stringify(wrapper.result.data) } });
  assert.equal(compactMacroUsEquity(asOutput), compactMacroUsEquity(raw));
  assert.ok(compactMacroUsEquity(asOutput) !== null);
  const eventsText = sseText(readFixture("probe-us_equity_upcoming_event_calendar-NVDA.json"));
  const events = JSON.parse(eventsText) as { result: { data: unknown } };
  const eventsAsOutput = JSON.stringify({ result: { ok: true, output: JSON.stringify(events.result.data) } });
  assert.equal(compactEventCalendar(eventsAsOutput), compactEventCalendar(eventsText));
});

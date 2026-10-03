/** Entry timing gate for the tradfi v2 AI-trade lane (TRADFI-ENTRY-TIMING-SPEC). Pure, no I/O; a gate only defers, it never remembers. */
import type { FeatureEvidence } from "./features.js";
import { sessionState } from "./session.js";

export type EntryTimingMode = "off" | "log" | "enforce";
export type EntryTimingGate =
  | { readonly gated: false }
  | { readonly gated: true; readonly rule: "impulse" | "opening-range"; readonly detail: string };

const OPENING_RANGE_END_MINUTE = 10 * 60;

/** `TRADFI_ENTRY_TIMING_MODE`: absent or empty is `log`; an unrecognised value is `log` and warned once by the caller. */
export function resolveEntryTimingMode(raw: string | undefined, warn: (line: string) => void): EntryTimingMode {
  const value = raw?.trim() ?? "";
  if (value === "off" || value === "log" || value === "enforce") return value;
  if (value !== "") warn(`[trade-worker] TRADFI_ENTRY_TIMING_MODE "${value}" is not off|log|enforce; using log.`);
  return "log";
}

function additive(f15: FeatureEvidence | undefined, name: "stochRsi14" | "bbPosition20"): number | null {
  const item = f15?.additiveMetrics?.[name];
  return item !== undefined && item.available && typeof item.value === "number" ? item.value : null;
}

/** New York wall clock "HH:MM" and minute-of-day, DST-safe through Intl like {@link sessionState}. */
function nyClock(nowMs: number): { readonly minute: number; readonly text: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowMs));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return { minute: Number(hour) * 60 + Number(minute), text: `${hour}:${minute}` };
}

/** Rule B (opening range, 09:30-09:59 ET on a weekday) first, then rule A (15m impulse bar: stochRsi14 >= 0.95 or bbPosition20 >= 1.0). */
export function entryTimingGate(f15: FeatureEvidence | undefined, nowMs: number): EntryTimingGate {
  if (sessionState(nowMs) === "rth") {
    const clock = nyClock(nowMs);
    if (clock.minute < OPENING_RANGE_END_MINUTE) return { gated: true, rule: "opening-range", detail: `et=${clock.text}` };
  }
  const stochRsi = additive(f15, "stochRsi14");
  const bb = additive(f15, "bbPosition20");
  if ((stochRsi !== null && stochRsi >= 0.95) || (bb !== null && bb >= 1)) {
    return { gated: true, rule: "impulse", detail: `stochRsi=${stochRsi === null ? "n/a" : stochRsi.toFixed(2)} bb=${bb === null ? "n/a" : bb.toFixed(2)}` };
  }
  return { gated: false };
}

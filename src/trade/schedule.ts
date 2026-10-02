/** Pure fixed-amount TradFi schedule clock and ledger arithmetic. */
import { SESSION_ENTRY_CUTOFF_MS } from "./exits.js";
import { tradfiV2EntryReservation } from "./sizing.js";
import type { TradeIntentRecord } from "../store/tradeIntents.js";

export const SCHEDULE_INTERVALS_SEC = [3600, 14400, 28800, 43200, 86400] as const;
export type ScheduleIntervalSec = (typeof SCHEDULE_INTERVALS_SEC)[number];
export type ScheduleEndKind = "budget" | "date" | "runs";

export function scheduleAnchorMs(firstAtSec: number | null | undefined, createdAtMs: number): number {
  return firstAtSec === null || firstAtSec === undefined ? createdAtMs : firstAtSec * 1_000;
}

export function currentSlot(anchorMs: number, intervalSec: ScheduleIntervalSec, nowMs: number): number | null {
  if (nowMs < anchorMs) return null;
  return Math.floor((nowMs - anchorMs) / (intervalSec * 1_000));
}

export function buysThisSession(ttlSec: number, intervalSec: ScheduleIntervalSec): number {
  const availableMs = ttlSec * 1_000 - SESSION_ENTRY_CUTOFF_MS - 1;
  return availableMs < 0 ? 0 : Math.floor(availableMs / (intervalSec * 1_000)) + 1;
}

export type ScheduleLedgerInput = {
  readonly anchorMs: number;
  readonly intervalSec: ScheduleIntervalSec;
  readonly nowMs: number;
  readonly capitalQuoteWei: bigint;
  readonly entryWei: bigint;
  readonly platformFeeBps: number;
  readonly ttlSec: number;
  readonly endKind: ScheduleEndKind;
  readonly endAtSec: number | null;
  readonly endRuns: number | null;
  readonly intents: readonly Pick<TradeIntentRecord, "scheduleSlot" | "state" | "entryWei">[];
};

export type ScheduleLedger = {
  readonly currentSlot: number | null;
  readonly currentSlotTaken: boolean;
  readonly fills: number;
  readonly postponed: number;
  readonly plannedBuys: number;
  readonly buysThisSession: number;
  readonly spentWei: bigint;
  readonly remainingWei: bigint;
  readonly finished: ScheduleEndKind | null;
  readonly nextDueAtMs: number;
};

export function scheduleLedger(input: ScheduleLedgerInput): ScheduleLedger {
  const reservation = tradfiV2EntryReservation(input.entryWei, input.platformFeeBps);
  const active = input.intents.filter((intent) => intent.state !== "rolled-back" && intent.scheduleSlot !== null && intent.scheduleSlot !== undefined);
  const slots = new Set(active.map((intent) => intent.scheduleSlot as number));
  const fills = slots.size;
  const slot = currentSlot(input.anchorMs, input.intervalSec, input.nowMs);
  const currentSlotTaken = slot !== null && slots.has(slot);
  const postponed = slot === null ? 0 : Math.max(0, slot - (fills - (currentSlotTaken ? 1 : 0)));
  const spentWei = active.reduce((sum, intent) => sum + intent.entryWei, 0n);
  const remainingWei = input.capitalQuoteWei > spentWei ? input.capitalQuoteWei - spentWei : 0n;
  const uncapped = reservation <= 0n ? 0 : Number(input.capitalQuoteWei / reservation);
  let plannedBuys = Number.isSafeInteger(uncapped) ? uncapped : Number.MAX_SAFE_INTEGER;
  if (input.endKind === "runs" && input.endRuns !== null) plannedBuys = Math.min(plannedBuys, input.endRuns);
  if (input.endKind === "date" && input.endAtSec !== null) {
    const beforeEnd = input.endAtSec * 1_000 - input.anchorMs - 1;
    const dateSlots = beforeEnd < 0 ? 0 : Math.floor(beforeEnd / (input.intervalSec * 1_000)) + 1;
    plannedBuys = Math.min(plannedBuys, dateSlots);
  }
  const finished = remainingWei < reservation ? "budget"
    : input.endKind === "runs" && input.endRuns !== null && fills >= input.endRuns ? "runs"
      : input.endKind === "date" && input.endAtSec !== null && input.nowMs >= input.endAtSec * 1_000 ? "date" : null;
  const currentDue = slot === null ? input.anchorMs : input.anchorMs + slot * input.intervalSec * 1_000;
  const nextDueAtMs = slot === null ? input.anchorMs : currentSlotTaken ? input.anchorMs + (slot + 1) * input.intervalSec * 1_000 : currentDue;
  return { currentSlot: slot, currentSlotTaken, fills, postponed, plannedBuys,
    buysThisSession: buysThisSession(input.ttlSec, input.intervalSec), spentWei, remainingWei, finished, nextDueAtMs };
}

export const nextDueAtMs = (input: ScheduleLedgerInput): number => scheduleLedger(input).nextDueAtMs;

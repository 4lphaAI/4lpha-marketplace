import assert from "node:assert/strict";
import test from "node:test";
import { scheduleLedger, currentSlot, buysThisSession } from "../src/trade/schedule.js";

const A = 1_000_000;
const I = 3_600;
const base = {
  anchorMs: A, intervalSec: I as 3600, nowMs: A, capitalQuoteWei: 21n, entryWei: 10n, platformFeeBps: 0,
  ttlSec: 604_800, endKind: "budget" as const, endAtSec: null, endRuns: null,
};

test("schedule slots are anchor-relative and boundary exact", () => {
  assert.equal(currentSlot(A, 3600, A - 1), null);
  assert.equal(currentSlot(A, 3600, A), 0);
  assert.equal(currentSlot(A, 3600, A + 3_600_000 - 1), 0);
  assert.equal(currentSlot(A, 3600, A + 3_600_000), 1);
});

test("schedule ledger excludes rolled-back slots and postpones missed cycles", () => {
  const result = scheduleLedger({ ...base, nowMs: A + 7_200_000, intents: [
    { scheduleSlot: 0, state: "rolled-back", entryWei: 10n },
    { scheduleSlot: 1, state: "projected", entryWei: 10n },
  ] });
  assert.equal(result.fills, 1);
  assert.equal(result.postponed, 1);
  assert.equal(result.currentSlotTaken, false);
  assert.equal(result.nextDueAtMs, A + 7_200_000);
});

test("schedule finish and session counts use fee-inclusive reservations", () => {
  const budget = scheduleLedger({ ...base, capitalQuoteWei: 9n, entryWei: 10n, platformFeeBps: 500, intents: [] });
  assert.equal(budget.finished, "budget");
  const runs = scheduleLedger({ ...base, endKind: "runs", endRuns: 1, intents: [{ scheduleSlot: 0, state: "projected", entryWei: 10n }] });
  assert.equal(runs.finished, "runs");
  const date = scheduleLedger({ ...base, endKind: "date", endAtSec: Math.floor((A + 1) / 1_000), intents: [] });
  assert.equal(date.finished, "date");
  assert.deepEqual([3600, 14400, 28800, 43200, 86400].map((interval) => buysThisSession(604_800, interval as 3600)), [166, 42, 21, 14, 7]);
});

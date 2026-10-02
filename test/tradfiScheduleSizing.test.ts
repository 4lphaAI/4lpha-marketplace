import assert from "node:assert/strict";
import test from "node:test";
import { checkTradfiScheduleSizing, scheduleNativeNeeds, tradfiScheduleNativeReserveWei } from "../src/trade/sizing.js";

test("schedule native reserve is one submission per in-session buy, plus a one-token exit reserve (A1/A3 — never the chain grant)", () => {
  assert.equal(tradfiScheduleNativeReserveWei({ plannedBuys: 198, buysThisSession: 166, relayFeeWei: 100n }), 16_800n);
  assert.equal(tradfiScheduleNativeReserveWei({ plannedBuys: 3, buysThisSession: 166, relayFeeWei: 100n }), 500n);
  assert.equal(tradfiScheduleNativeReserveWei({ plannedBuys: 0, buysThisSession: 0, relayFeeWei: 100n }), 200n);
});

test("schedule sizing composes the USDT floor and its independent native reserve", () => {
  const ok = checkTradfiScheduleSizing({ capDayWei: 1_000_000_000_000_000n, entryWei: 10n, capitalQuoteWei: 100n, platformFeeBps: 0,
    grantedTokenCount: 5, intervalSec: 86400, ttlSec: 604800, endKind: "runs", endRuns: 3, endAtSec: null, anchorAtSec: 0 });
  assert.equal(ok.plannedBuys, 3);
  assert.equal(ok.buysThisSession, 7);
  assert.equal(ok.nativeReserveWei, 5n * 100_000_000_000_000n);
  assert.equal(ok.ok, true);
  assert.equal(checkTradfiScheduleSizing({ ...okInput(), capDayWei: 0n }).ok, false);
  assert.equal(checkTradfiScheduleSizing({ ...okInput(), capitalQuoteWei: 9n }).ok, false);
});

function okInput() {
  return { capDayWei: 1_000_000_000_000_000n, entryWei: 10n, capitalQuoteWei: 100n, platformFeeBps: 0,
    grantedTokenCount: 5, intervalSec: 86400 as const, ttlSec: 604800, endKind: "budget" as const, endRuns: null, endAtSec: null, anchorAtSec: 0 };
}

// R2.1 (BLOCKER-1): the inner checkTradfiV2Sizing call must use capDayWei: MAX_UINT256, so quote.ok
// never re-imposes the v2 native reserve (N+3)*R; the native side is judged only against the schedule
// reserve (min(plannedBuys, buysThisSession) + 2)*R (A1/A3 — a schedule agent's reserve is ONE token,
// never the chain-granted count N). With N = 22 the v2 floor is 25R; a ONE-buy schedule reserves 3R,
// which is the only shape below that floor once the exit reserve is funded — the discriminating vector.
test("R2.1: schedule sizing does not re-impose the v2 native reserve on a small schedule", () => {
  const R = 100_000_000_000_000n;
  const hourlyRun1 = { entryWei: 10n, capitalQuoteWei: 100n, platformFeeBps: 0, grantedTokenCount: 22,
    intervalSec: 3600 as const, ttlSec: 604800, endKind: "runs" as const, endRuns: 1, endAtSec: null, anchorAtSec: 0 };

  const atReserve = checkTradfiScheduleSizing({ ...hourlyRun1, capDayWei: 3n * R });
  assert.equal(atReserve.plannedBuys, 1);
  assert.equal(atReserve.buysThisSession, 166);
  assert.equal(atReserve.nativeReserveWei, 3n * R);
  assert.equal(atReserve.nativeShortfallWei, 0n);
  assert.equal(atReserve.ok, true);

  const belowReserve = checkTradfiScheduleSizing({ ...hourlyRun1, capDayWei: 2n * R });
  assert.equal(belowReserve.ok, false);
  assert.equal(belowReserve.nativeShortfallWei, R);

  const dailyBudget = { entryWei: 10n, capitalQuoteWei: 1000n, platformFeeBps: 0, grantedTokenCount: 22,
    intervalSec: 86400 as const, ttlSec: 604800, endKind: "budget" as const, endRuns: null, endAtSec: null, anchorAtSec: 0 };
  const dailyAtReserve = checkTradfiScheduleSizing({ ...dailyBudget, capDayWei: 9n * R });
  assert.equal(dailyAtReserve.buysThisSession, 7);
  assert.equal(dailyAtReserve.nativeReserveWei, 9n * R);
  assert.equal(dailyAtReserve.ok, true);
});

// B1: the interval-edit native needs, mirrored byte-for-byte in web/lib/trade.ts
// (parity test there). `+2` on each count = the floor's own fee plus the
// one-token exit reserve (A1) every buy leaves behind.
test("scheduleNativeNeeds: hourly/daily vectors, and no session time left needs no session-buy headroom", () => {
  const R = 100_000_000_000_000n;
  const hourlyOne = scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 1, sessionRemainingMs: 6.5 * 86_400_000 });
  assert.equal(hourlyOne.buysPerDay, 1);
  assert.equal(hourlyOne.dayCapWei, 3n * R);
  assert.equal(hourlyOne.sessionBuys, 1);
  assert.equal(hourlyOne.balanceWei, 3n * R);

  const hourlyFifty = scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 50, sessionRemainingMs: 6.5 * 86_400_000 });
  assert.equal(hourlyFifty.buysPerDay, 24);
  assert.equal(hourlyFifty.dayCapWei, 26n * R);
  assert.equal(hourlyFifty.sessionBuys, 50);
  assert.equal(hourlyFifty.balanceWei, 52n * R);

  const dailyNine = scheduleNativeNeeds({ intervalSec: 86_400, remainingBuys: 9, sessionRemainingMs: 7 * 86_400_000 });
  assert.equal(dailyNine.buysPerDay, 1);
  assert.equal(dailyNine.dayCapWei, 3n * R);
  assert.equal(dailyNine.sessionBuys, 8);
  assert.equal(dailyNine.balanceWei, 10n * R);

  const noSessionTime = scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 5, sessionRemainingMs: 0 });
  assert.equal(noSessionTime.sessionBuys, 0);
  assert.equal(noSessionTime.balanceWei, 2n * R);
  // buysPerDay = min(5, ceil(86400/3600)=24) = 5, unaffected by the empty session window.
  assert.equal(noSessionTime.dayCapWei, 7n * R);

  assert.throws(() => scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: -1, sessionRemainingMs: 0 }));
  assert.throws(() => scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 1, sessionRemainingMs: Number.NaN }));
});

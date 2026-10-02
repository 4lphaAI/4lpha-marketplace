import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TradeSettings, TradeView } from "@/lib/trade";
import { ScheduleSummary } from "./ScheduleDetail";

const USDT = 10n ** 18n;

const SETTINGS: TradeSettings = {
  name: "Schedule Buy 01", executionModel: "tradfi", entryWei: (5n * USDT).toString(10),
  maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false,
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 300, gasPriority: "standard", instructions: null, skillMarkdown: null,
  primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: true,
  settlementAsset: "USDT", minEntryWei: (5n * USDT).toString(10), capitalQuoteWei: (12n * USDT).toString(10),
  cmcNewsEnabled: false, tradeMode: "schedule", scheduleToken: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  scheduleIntervalSec: 3_600, scheduleFirstAtSec: null, scheduleEndKind: "budget", scheduleEndAtSec: null,
  scheduleEndRuns: null, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150,
};

function schedule(over: Partial<NonNullable<TradeView["schedule"]>> = {}): NonNullable<TradeView["schedule"]> {
  return {
    token: SETTINGS.scheduleToken!, symbol: "LITEB", decimals: 18, amountWei: SETTINGS.entryWei,
    intervalSec: 3_600, anchorMs: 1_000, nextDueAtMs: 4_000, currentSlot: 1, currentSlotTaken: true,
    fills: 2, postponed: 0, plannedBuys: 2, buysThisSession: 168,
    spentWei: (10n * USDT).toString(10), remainingWei: (2n * USDT).toString(10), finished: "budget",
    endKind: "budget", endAtSec: null, endRuns: null, marketHoursOnly: false, maxPremiumBps: 150, firstAtSec: null,
    premiumBps: 0, premiumLimitBps: 150,
    nativeCapWei: null, nativeSpentWei: "0", nativeBalanceWei: null, nativeBuysRefused: false,
    sessionExpiresAtSec: null,
    holding: { walletBalance: "0", boughtAtomic: "0", verifiedSpentWei: "0", verifiedFills: 0, quoteWei: null, quoteReason: "balance-zero" },
    ...over,
  };
}

const render = (props: Parameters<typeof ScheduleSummary>[0]): string => renderToStaticMarkup(<ScheduleSummary {...props} />);

describe("Schedule buy notices", () => {
  it("a budget finish says the agent is idle, that the budget cannot be raised here, and where the holdings go", () => {
    const html = render({ schedule: schedule(), settings: SETTINGS, open: [] });
    expect(html).toContain('data-testid="schedule-finished-next"');
    expect(html).toContain("makes no calls");
    expect(html).toContain("needs a new Schedule hire");
    expect(html).toContain("withdraw them from Account");
    expect(html).toContain("IDLE · NO WORKER CALLS");
  });

  it("a runs finish points at the Edit that reopens it", () => {
    const html = render({ schedule: schedule({ finished: "runs", endKind: "runs", endRuns: 2 }), settings: SETTINGS, open: [] });
    expect(html).toContain("Edit the number of runs");
    expect(html).not.toContain("needs a new Schedule hire");
  });

  it("an amount per buy above the granted ceiling is called out; at or below it, or with no ceiling, it is not", () => {
    const running = schedule({ finished: null, spentWei: "0", remainingWei: (12n * USDT).toString(10), fills: 0 });
    const above = render({ schedule: running, settings: { ...SETTINGS, entryWei: (6n * USDT).toString(10) }, open: [], hiredEntryWei: (5n * USDT).toString(10) });
    expect(above).toContain('data-testid="schedule-amount-above-grant"');
    expect(above).toContain("every buy is refused");
    expect(render({ schedule: running, settings: SETTINGS, open: [], hiredEntryWei: (5n * USDT).toString(10) })).not.toContain("schedule-amount-above-grant");
    expect(render({ schedule: running, settings: { ...SETTINGS, entryWei: (6n * USDT).toString(10) }, open: [] })).not.toContain("schedule-amount-above-grant");
    expect(render({ schedule: running, settings: SETTINGS, open: [] })).not.toContain("schedule-finished-next");
  });
});

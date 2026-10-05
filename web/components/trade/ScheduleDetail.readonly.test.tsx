import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TradeView } from "@/lib/trade";
import { ScheduleSummary } from "./ScheduleDetail";

const USDT = 10n ** 18n;
const settings = { entryWei: (5n * USDT).toString(10), capitalQuoteWei: (12n * USDT).toString(10), scheduleMarketHoursOnly: false };
const schedule = (over: Partial<NonNullable<TradeView["schedule"]>> = {}): NonNullable<TradeView["schedule"]> => ({
  token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", symbol: "LITEB", decimals: 18, amountWei: settings.entryWei, intervalSec: 3_600, anchorMs: 1_000, nextDueAtMs: 4_000, currentSlot: 1,
  currentSlotTaken: true, fills: 2, postponed: 0, plannedBuys: 2, buysThisSession: 168, spentWei: (10n * USDT).toString(10), remainingWei: (2n * USDT).toString(10), finished: "budget",
  endKind: "budget", endAtSec: null, endRuns: null, marketHoursOnly: false, maxPremiumBps: 150, firstAtSec: null, premiumBps: 0, premiumLimitBps: 150, nativeCapWei: null, nativeSpentWei: "0",
  nativeBalanceWei: null, nativeBuysRefused: false, sessionExpiresAtSec: null,
  holding: { walletBalance: "0", boughtAtomic: "0", verifiedSpentWei: "0", verifiedFills: 0, quoteWei: null, quoteReason: "balance-zero" }, ...over });
const render = (props: Parameters<typeof ScheduleSummary>[0]): string => renderToStaticMarkup(<ScheduleSummary {...props} />);

describe("Schedule body on the Agentic public page (readOnly)", () => {
  it("a finished schedule points at the Binance App and offers no owner step", () => {
    for (const finished of ["budget", "runs", "date"] as const) {
      const html = render({ schedule: schedule({ finished }), settings, open: [], readOnly: true });
      expect(html).toContain("The agent is idle and makes no calls. Your LITEB and any leftover USDT stay in your Agentic Wallet; sell them in the Binance App.");
      for (const gone of ["withdraw them from Account", "needs a new Schedule hire", "Edit the number of runs", "Edit the end date"]) expect(html).not.toContain(gone);
    }
  });

  it("never shows the amount-above-grant notice, which tells the owner to edit", () => {
    const running = schedule({ finished: null, spentWei: "0", remainingWei: (12n * USDT).toString(10), fills: 0 });
    const props = { schedule: running, settings: { ...settings, entryWei: (6n * USDT).toString(10) }, open: [], hiredEntryWei: (5n * USDT).toString(10) };
    expect(render(props)).toContain("schedule-amount-above-grant");
    expect(render({ ...props, readOnly: true })).not.toContain("schedule-amount-above-grant");
  });
});

import { describe, expect, it } from "vitest";
import { checkTradfiV2Sizing, parseTradeViewEnvelope } from "./trade";

const E18 = 10n ** 18n;

describe("TradFi v2 UI wire", () => {
  it("requires maximum entry plus the buy fee headroom in USDT capital", () => {
    const sized = checkTradfiV2Sizing({
      capDayWei: 10_000_000_000_000_000n,
      minEntryWei: 5n * E18,
      maxEntryWei: 20n * E18,
      capitalQuoteWei: 63n * E18,
      maxOpenPositions: 3,
      grantedTokenCount: 28,
      platformFeeBps: 500,
    });
    expect(sized.requiredQuoteWei).toBe(63n * E18);
    expect(sized.ok).toBe(true);
    expect(checkTradfiV2Sizing({
      capDayWei: 10_000_000_000_000_000n, minEntryWei: 5n * E18, maxEntryWei: 20n * E18,
      capitalQuoteWei: 62n * E18, maxOpenPositions: 3, grantedTokenCount: 28, platformFeeBps: 500,
    }).ok).toBe(false);
  });

  it("keeps legacy views valid while refusing malformed CMC accounting", () => {
    const base = {
      open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
      summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: null, observedAt: null },
      lifecycle: { draining: false, drainingAt: null }, pendingIntents: [],
    };
    expect(parseTradeViewEnvelope({ data: { ...base, settings: null } }).settings).toBeNull();
    expect(() => parseTradeViewEnvelope({ data: { ...base, settings: null, cmcBudget: {
      asset: "USDT", decimals: 18, generation: 0, authorizedTotalWei: "2", settledWei: "1", reservedWei: "1", remainingWei: "2", status: "ready", reason: null, pendingOperationId: null,
    } } })).toThrow("invalid CMC budget");
  });

  it("CMC-HIRE-SETUP R6.1: accepts an absent or valid adoptedWei on cmcBudget, and refuses a malformed one", () => {
    const base = {
      open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
      summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: null, observedAt: null },
      lifecycle: { draining: false, drainingAt: null }, pendingIntents: [], settings: null,
    };
    const cmcBudget = { asset: "USDT", decimals: 18, generation: 1, authorizedTotalWei: "3", settledWei: "1", reservedWei: "0", remainingWei: "2", status: "ready", reason: null, pendingOperationId: null };
    // Absent (an older plane): accepted.
    expect(parseTradeViewEnvelope({ data: { ...base, cmcBudget } }).cmcBudget?.adoptedWei).toBeUndefined();
    // Present and a canonical decimal: carried through.
    expect(parseTradeViewEnvelope({ data: { ...base, cmcBudget: { ...cmcBudget, adoptedWei: "1870000000000000000" } } }).cmcBudget?.adoptedWei)
      .toBe("1870000000000000000");
    // Malformed: refused, same as every other CMC budget field.
    expect(() => parseTradeViewEnvelope({ data: { ...base, cmcBudget: { ...cmcBudget, adoptedWei: "not-wei" } } }))
      .toThrow("invalid CMC budget");
  });

  it("accepts the schedule premium fields when present and refuses a malformed one, but tolerates their absence", () => {
    const schedule = {
      token: "0x1111111111111111111111111111111111111111", symbol: "SPCXB", decimals: 18, amountWei: "1", intervalSec: 86_400,
      anchorMs: 0, nextDueAtMs: 0, currentSlot: 0, currentSlotTaken: false, fills: 0, postponed: 0, plannedBuys: 1,
      buysThisSession: 1, spentWei: "0", remainingWei: "1", finished: null, endKind: "budget", endAtSec: null, endRuns: null,
      marketHoursOnly: false, maxPremiumBps: 150, firstAtSec: null,
      holding: { walletBalance: "0", boughtAtomic: "0", verifiedSpentWei: "0", verifiedFills: 0, quoteWei: null, quoteReason: "balance-zero" },
    };
    const base = {
      open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
      summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: null, observedAt: null },
      lifecycle: { draining: false, drainingAt: null }, pendingIntents: [], settings: null,
    };
    // Absent (the plane has not restarted with the R14.x read yet): accepted, not a throw.
    expect(parseTradeViewEnvelope({ data: { ...base, schedule } }).schedule?.premiumBps).toBeUndefined();
    // Present and well-typed: carried through.
    const withPremium = parseTradeViewEnvelope({ data: { ...base, schedule: { ...schedule, premiumBps: 42, premiumLimitBps: 150 } } }).schedule;
    expect(withPremium?.premiumBps).toBe(42);
    expect(withPremium?.premiumLimitBps).toBe(150);
    // Missing/no-fact case: the plane reports `null`, not a dash string.
    expect(parseTradeViewEnvelope({ data: { ...base, schedule: { ...schedule, premiumBps: null } } }).schedule?.premiumBps).toBeNull();
    expect(() => parseTradeViewEnvelope({ data: { ...base, schedule: { ...schedule, premiumBps: "bad" } } }))
      .toThrow("invalid schedule premium");
    expect(() => parseTradeViewEnvelope({ data: { ...base, schedule: { ...schedule, premiumLimitBps: "bad" } } }))
      .toThrow("invalid schedule premium limit");
  });

  it("accepts a per-fill scheduleSlot on an open position and tolerates its absence", () => {
    const base = {
      closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
      summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 1, maxOpenPositions: null, observedAt: null },
      lifecycle: { draining: false, drainingAt: null }, pendingIntents: [], settings: null,
    };
    const position = {
      positionId: "fill-1", token: "0x1111111111111111111111111111111111111111", route: { hops: [], fees: [] },
      entryWei: "1", tokenAmount: "1", fillStatus: "verified", openedAt: 0, entryTxHash: null, status: "open",
      pnlBps: null, exitRequestedAt: null, orphanedAt: null, closedAt: null, exitWei: null, exitTxHash: null,
      soldTokenAmount: null, exitFillStatus: null, closeReason: null, refusalText: null, observation: null,
    };
    expect(parseTradeViewEnvelope({ data: { ...base, open: [position] } }).open[0]?.scheduleSlot).toBeUndefined();
    const withSlot = parseTradeViewEnvelope({ data: { ...base, open: [{ ...position, scheduleSlot: 3 }] } });
    expect(withSlot.open[0]?.scheduleSlot).toBe(3);
  });
});

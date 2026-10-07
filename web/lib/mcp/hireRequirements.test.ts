import { describe, expect, it } from "vitest";
import { DCA_PORTFOLIO_STOCKS, HIRE_CONFLICTS, REQ } from "./hireRequirements";
import { AGENTIC_PRODUCTS, hireGuide } from "./agenticProducts";

/**
 * Every number below is what the web Deploy form / lib/agentic.ts enforces (see the file:line comments in
 * hireRequirements.ts). Changing a form value without changing this table turns these red on purpose.
 */
describe("hire requirements table pins the web form", () => {
  it("term, Binance checks and funding", () => {
    expect(REQ.termDays).toEqual([7, 30]);
    expect(REQ.gate).toEqual({ x402DailyLimitMinUsdt: 0.5, dailyLimitCapitalMultiple: 10, dailyLimitCapitalMultipleSchedule: 2, bnbPerSlot: 0.0004, bnbEarnExtraSlots: 2 });
    expect(REQ.budgetUsdt).toEqual({ ai: { 7: 2, 30: 8 }, schedule: { 7: 0, 30: 0 }, portfolio: { 7: 0.2, 30: 0.8 }, dca: { 7: 0.2, 30: 0.8 } });
  });
  it("AI Trade", () => {
    expect(REQ.ai).toMatchObject({ maxOpenPositions: { min: 1, max: 10, default: 3 }, capitalUsdtDefault: 63, minEntryUsdtDefault: 5, maxEntryUsdtDefault: 20, stopLossPct: { min: 1, max: 100 }, slippagePct: { min: 0.5, max: 5 } });
  });
  it("Schedule buy", () => {
    expect(REQ.schedule.minAmountPerBuyUsdt).toBe(5);
    expect(REQ.schedule.intervals).toEqual(["1 hour", "4 hours", "8 hours", "12 hours", "Daily"]);
    expect(REQ.schedule.totalBudgetMinFeeBps).toBe(500);
    expect(REQ.schedule.endRuns).toEqual({ min: 1, max: 1000 });
    expect(REQ.schedule.maxPremiumBps).toEqual({ min: 50, max: 150, default: 150 });
  });
  it("Auto DCA uses the form's 25 base and 1.5 % take profit, not the plane's 15 and 1 %", () => {
    expect(REQ.dca).toMatchObject({ minBaseUsdt: 25, minOrderUsdt: 10, minTakeProfitPct: 1.5, stepPct: { min: 1, max: 30 }, maxOrders: { min: 1, max: 8, default: 3 }, stopLossPct: { min: 1, max: 99 }, earnMinOrders: 5 });
  });
  it("Smart Portfolio", () => {
    expect(REQ.portfolio).toMatchObject({ stocks: { min: 2, max: 5 }, minWeightPct: 10, minCapitalUsdt: { base: 50, perExtraStock: 25 }, driftPct: { min: 0.5, max: 15, step: 0.5 } });
    expect(REQ.portfolio.intervals).toEqual(["4h", "8h", "12h", "Daily"]);
  });
  it("Earn", () => {
    expect(REQ.earn).toMatchObject({ maxShareOfCapitalPct: 60, minLendUsdt: 20, allBackHoursBeforeEnd: 2 });
  });
  it("the 17-stock DCA and portfolio list", () => {
    expect(DCA_PORTFOLIO_STOCKS).toHaveLength(17);
    expect(new Set(DCA_PORTFOLIO_STOCKS).size).toBe(17);
    expect(DCA_PORTFOLIO_STOCKS).toContain("NVDAB");
  });
  it("records the four known form/plane conflicts", () => {
    expect(HIRE_CONFLICTS.map((c) => c.item)).toEqual(["DCA base order minimum", "DCA take profit minimum", "Schedule total budget", "Schedule frequency"]);
  });
});

describe("hire guide text carries the table's numbers", () => {
  const env = { NEXT_PUBLIC_AGENTIC_WALLET_ENABLED: "true", NEXT_PUBLIC_AGENTIC_DCA_ENABLED: "true", NEXT_PUBLIC_AGENTIC_EARN_ENABLED: "true" };
  const guide = (id: string) => hireGuide(AGENTIC_PRODUCTS.find((p) => p.id === id)!, "https://4lpha.tech/deploy/trading", env);
  it("DCA says 25, 10 and 1.5", () => {
    const text = JSON.stringify(guide("agentic-dca").requirements);
    expect(text).toMatch(/at least 25 USDT/);
    expect(text).toMatch(/at least 10 USDT/);
    expect(text).toMatch(/Take profit at least 1\.5 %/);
    expect(text).toMatch(/17 stocks/);
  });
  it("portfolio says 2 to 5 stocks, 10 %, 50 + 25", () => {
    const text = JSON.stringify(guide("agentic-portfolio").requirements);
    expect(text).toMatch(/2 to 5 stocks/);
    expect(text).toMatch(/at least 10 %/);
    expect(text).toMatch(/at least 50 USDT for 2 stocks plus 25 USDT/);
  });
  it("AI Trade says 2 or 8 USDT of data budget and 10x daily limit; Schedule says 2x and no x402 row", () => {
    const ai = guide("agentic-ai-trade").requirements;
    expect(ai.funding.usdt).toMatch(/2 USDT \(7-day term\) or 8 USDT/);
    expect(ai.binanceApp.join(" ")).toMatch(/at least 10 x the capital/);
    expect(ai.binanceApp.join(" ")).toMatch(/0\.50 USDT/);
    const sched = guide("agentic-schedule").requirements;
    expect(sched.binanceApp.join(" ")).toMatch(/at least 2 x the capital/);
    expect(sched.binanceApp.join(" ")).not.toMatch(/x402/);
    expect(sched.funding.usdt).toBe("The capital you set.");
  });
  it("Schedule says 5 USDT and the five intervals, never Weekly", () => {
    const text = JSON.stringify(guide("agentic-schedule").requirements);
    expect(text).toMatch(/at least 5 USDT/);
    expect(text).toMatch(/1 hour, 4 hours, 8 hours, 12 hours, Daily/);
    expect(text).not.toMatch(/Weekly/);
  });
});

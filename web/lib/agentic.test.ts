import { describe, expect, it } from "vitest";
import { agenticDecimal, agenticGate, agenticHireSettings } from "./agentic";
import type { TradeSettings } from "./trade";
const settings: TradeSettings = { name: "Agentic", executionModel: "tradfi", entryWei: "5000000000000000000", maxOpenPositions: 2,
  minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
  slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b" };

describe("Agentic browser gate parity", () => {
  it("shows sizing and have/need/add amounts exactly", () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const input = { wallet, facts: { readAtMs: 0, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0,
      x402DailyLimit: 1, x402QuotaUsed: 0, signInMaxTimeMs: 90 * 86_400_000, usdtWei: "11999200000000000000", bnbWei: "1599999999999999" },
      capitalQuoteWei: 10n * 10n ** 18n, entryWei: 8n * 10n ** 18n, maxOpenPositions: 2, termSec: 604_800, nowMs: 0, budgetWei: 2n * 10n ** 18n };
    const rows = agenticGate(input).rows;
    expect(rows.find(r => r.code === "sizing")?.state).toBe("FAIL");
    expect(agenticGate({ ...input, capitalQuoteWei: 16n * 10n ** 18n }).rows.find(r => r.code === "sizing")?.state).toBe("PASS");
    expect(rows.find(r => r.code === "usdt")?.fix).toBe(`Have 11.9992 USDT, need 12 USDT: add 0.0008 USDT to ${wallet}.`);
    expect(rows.find(r => r.code === "bnb")?.fix).toBe(`Have 0.001599999999999999 BNB, need 0.0016 BNB: add 0.000000000000000001 BNB to ${wallet}.`);
  });
  const now = 1_900_000_000_000, E = 10n ** 18n;
  const facts = { readAtMs: now, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1000, quotaUsed: 0,
    x402DailyLimit: 0.5, x402QuotaUsed: 0, signInMaxTimeMs: now + 90 * 86_400_000, usdtWei: (108n * E).toString(), bnbWei: E.toString() };
  const input = { facts, capitalQuoteWei: 100n * E, maxOpenPositions: 3, entryWei: 20n * E, termSec: 7 * 86_400, nowMs: now, budgetWei: 2n * E };
  it("pins every row and exact quota thresholds", () => {
    expect(agenticGate(input).rows.map(r => [r.code, r.state])).toEqual(["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "x402-limit", "usdt", "bnb", "quota-today", "sizing"].map(code => [code, "PASS"]));
    expect(agenticGate({ ...input, facts: { ...facts, dailyLimit: 999.99 } }).rows[4].state).toBe("FAIL");
    expect(agenticDecimal(49999.990000000005)).toBeNull(); expect(agenticDecimal(0.5)).toBe(E / 2n);
    expect(agenticDecimal("0.500000000000000001")).toBe(E / 2n + 1n);
  });
  it("matches seven-day clipping and refuses the thirty-day pick on that session", () => {
    const accepted = now + 600_000, seven = { ...input, nowMs: accepted, facts: { ...facts, signInMaxTimeMs: now + 604_800_000 } };
    expect(agenticGate(seven).hireEndMs).toBe(now + 601_200_000);
    expect(agenticGate(seven).rows[3].state).toBe("PASS");
    expect(agenticGate({ ...seven, termSec: 30 * 86_400, budgetWei: 8n * E }).rows[3].state).toBe("FAIL");
    expect(agenticGate(input).hireEndMs - agenticGate(input).entryCutoffMs).toBe(7_200_000);
  });
  it("requires the 2 or 8 USDT data budget and 102 or 108 USDT funding", () => {
    expect(agenticHireSettings(settings, 7).cmcTotalBudgetWei).toBe((2n * E).toString());
    expect(agenticHireSettings(settings, 30).cmcTotalBudgetWei).toBe((8n * E).toString());
    expect(agenticHireSettings(settings, 30).cmcNewsEnabled).toBe(true);
    expect(agenticGate({ ...input, facts: { ...facts, usdtWei: (102n * E).toString() } }).rows[6].state).toBe("PASS");
    expect(agenticGate({ ...input, budgetWei: 8n * E, facts: { ...facts, usdtWei: (102n * E).toString() } }).rows[6].state).toBe("FAIL");
  });
});

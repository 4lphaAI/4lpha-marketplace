/** AGENTIC-PORTFOLIO: the web gate mirror (same vectors as the plane), the keep-alive budget, the refusal copy and the shared portfolio block predicate. */
import { describe, expect, it } from "vitest";
import { AgenticRequestError, agenticGate, agenticKeepAliveBudgetWei, type AgenticFacts, type AgenticHireReason } from "./agentic";
import { isTradePortfolioBlock, parseTradeViewEnvelope, type TradeView } from "./trade";

const E = 10n ** 18n, NOW = 1_900_000_000_000;
const FACTS: AgenticFacts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 1_000, quotaUsed: 0, x402DailyLimit: 0.5, x402QuotaUsed: 0,
  signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: (108n * E).toString(), bnbWei: "4800000000000000" };
const gate = (tokenCount: number, facts: Partial<AgenticFacts> = {}, term: 7 | 30 = 7) => {
  const capital = (50n + 25n * BigInt(tokenCount - 2)) * E;
  return agenticGate({ facts: { ...FACTS, ...facts }, capitalQuoteWei: capital, maxOpenPositions: 1, entryWei: capital, termSec: term * 86_400, nowMs: NOW, budgetWei: agenticKeepAliveBudgetWei(term),
    portfolio: { tokenCount } });
};
const row = (rows: { code: string; state: string; fix: string }[], code: string) => rows.find(r => r.code === code);

describe("AGENTIC-PORTFOLIO web gate mirror", () => {
  it("asks (2N + 2) x 0.0004 BNB for N = 2..5, exact and one wei short", () => {
    for (const [count, need] of [[2, "0.0024"], [3, "0.0032"], [4, "0.004"], [5, "0.0048"]] as const) {
      expect(/need ([0-9.]+) BNB/.exec(row(gate(count, { bnbWei: "0" }).rows, "bnb")!.fix)![1]).toBe(need);
      const wei = BigInt(2 * count + 2) * 400_000_000_000_000n;
      expect(row(gate(count, { bnbWei: wei.toString() }).rows, "bnb")?.state).toBe("PASS");
      expect(row(gate(count, { bnbWei: (wei - 1n).toString() }).rows, "bnb")?.state).toBe("FAIL");
    }
  });

  it("keeps the x402 row, asks capital plus the keep-alive budget in USDT, twice five times the capital in daily limit", () => {
    expect(gate(2).rows.map(r => r.code)).toEqual(["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "x402-limit", "usdt", "bnb", "quota-today", "sizing"]);
    expect(row(gate(2, { x402DailyLimit: 0.49 }).rows, "x402-limit")?.state).toBe("FAIL");
    expect(row(gate(2, { x402DailyLimit: 0.5 }).rows, "x402-limit")?.state).toBe("PASS");
    for (const [term, usdt] of [[7, 50n * E + 2n * E / 10n], [30, 50n * E + 8n * E / 10n]] as const) {
      expect(row(gate(2, { usdtWei: usdt.toString() }, term).rows, "usdt")?.state).toBe("PASS");
      expect(row(gate(2, { usdtWei: (usdt - 1n).toString() }, term).rows, "usdt")?.state).toBe("FAIL");
    }
    expect(row(gate(2, { usdtWei: "0" }).rows, "usdt")!.fix).toContain("need 50.2 USDT");
    expect(row(gate(2, { usdtWei: "0" }, 30).rows, "usdt")!.fix).toContain("need 50.8 USDT");
    expect(row(gate(2, { dailyLimit: 499.99 }).rows, "daily-limit")!.fix).toBe("Raise Daily limit to 500 USDT.");
    expect(row(gate(2, { dailyLimit: 500 }).rows, "daily-limit")?.state).toBe("PASS");
    expect(row(gate(5, { dailyLimit: 1_249 }).rows, "daily-limit")!.fix).toBe("Raise Daily limit to 1250 USDT.");
    expect(row(gate(2, { quotaUsed: 999 }).rows, "quota-today")?.state).toBe("WARN");
  });

  it("mirrors the plane's keep-alive budget and words the four portfolio refusals", () => {
    expect([agenticKeepAliveBudgetWei(7), agenticKeepAliveBudgetWei(30)]).toEqual([200_000_000_000_000_000n, 800_000_000_000_000_000n]);
    const copy: [AgenticHireReason, string][] = [
      ["portfolio-disabled", "Hire refused: Smart Portfolio is not enabled on this execution plane."],
      ["portfolio-token-unsupported", "Hire refused: a selected stock cannot be traded from an Agentic Wallet."],
      ["portfolio-token-unquotable", "Hire refused: one stock has no direct buy quote. Try again later."],
      ["portfolio-capability-incomplete", "Hire refused: the stock check did not finish. Check the pairing status below, then try again."]];
    for (const [reason, text] of copy) expect(new AgenticRequestError("gate-failed", [], reason).message).toBe(text);
  });
});

const TOKEN = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", TOKEN2 = "0x205812cdbed920aff76c6580abd681a46d11efc7";
const block = (patch: Record<string, unknown> = {}) => ({ tokens: [
  { token: TOKEN, symbol: "SPYB", displayName: "SPDR", targetBps: 5000, balanceAtomic: (25n * E).toString(), valueWei: (25n * E).toString(), valueReason: null, weightBps: 5000, driftBps: 0,
    initial: { quantityAtomic: null, quantityReason: "not-verified", quoteWei: (25n * E).toString(), quoteReason: null } },
  { token: TOKEN2, symbol: "QQQB", displayName: null, targetBps: 5000, balanceAtomic: (25n * E).toString(), valueWei: (25n * E).toString(), valueReason: null, weightBps: 5000, driftBps: 0,
    initial: { quantityAtomic: null, quantityReason: "no-buy", quoteWei: null, quoteReason: "no-buy" } }],
capitalQuoteWei: (50n * E).toString(), netInvestedWei: (50n * E).toString(), cashCapWei: "0", walletUsdtWei: (2n * E).toString(), portfolioCashWei: "0", idleUsdtWei: (2n * E).toString(),
stockValueWei: (50n * E).toString(), totalValueWei: (50n * E).toString(), pnlWei: "0", driftBps: 0, intervalSec: 14400, anchorMs: NOW, currentSlot: 0, nextCheckAtMs: NOW + 14_400_000,
check: { slot: 0, state: "done", maxDriftBps: 0, valueWei: (50n * E).toString(), checkedAt: NOW },
legs: [{ slot: 0, side: "buy", token: TOKEN, symbol: "SPYB", amountWei: (25n * E).toString(), quotedOutAtomic: null, minOutAtomic: null, proceedsAtomic: null, state: "projected", txHash: null, createdAt: NOW,
  detail: { id: "0123456789abcdef", executionState: "COMMITTED", executionReason: null, quantityAtomic: null, quantityReason: "not-verified", quoteWei: (25n * E).toString(), quoteReason: null } }], ...patch });

describe("isTradePortfolioBlock", () => {
  it("accepts the plane's block and refuses each broken rule, the same checks the owner view parser always made", () => {
    expect(isTradePortfolioBlock(block())).toBe(true);
    for (const broken of [null, undefined, "x", [], block({ tokens: [{ ...block().tokens[0], targetBps: 10000 }] }), block({ intervalSec: 3600 }), block({ legs: [{ ...block().legs[0], state: "open" }] }),
      block({ tokens: [{ ...block().tokens[0], targetBps: 4000 }, block().tokens[1]] }), block({ capitalQuoteWei: "-1" }),
      block({ legs: [{ ...block().legs[0], detail: { ...block().legs[0]!.detail, executionState: null, executionReason: null } }] })]) expect(isTradePortfolioBlock(broken)).toBe(false);
  });

  it("is what the owner view parser calls, with the same error", () => {
    const view = (portfolio: unknown) => ({ data: { open: [], closed: [], runs: [], pinned: [], marketHours: {}, summary: {}, lifecycle: {}, pendingIntents: [], portfolio } });
    expect(() => parseTradeViewEnvelope(view(block()))).not.toThrow();
    expect((parseTradeViewEnvelope(view(block())) as TradeView).portfolio?.tokens).toHaveLength(2);
    expect(() => parseTradeViewEnvelope(view(block({ intervalSec: 3600 })))).toThrow("Trade view returned an invalid portfolio block.");
    expect(() => parseTradeViewEnvelope({ data: { ...view(undefined).data, portfolio: undefined } })).not.toThrow();
  });
});

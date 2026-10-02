import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_GRANTED_TOKENS,
  RELAY_FEE_PER_EXIT_WEI,
  maxGrantedTokens,
  scheduleNativeNeeds,
  TRADE_LLM_MODELS,
  TRADE_MODEL_PRESETS,
  checkBoundedText,
  checkTradeSizing,
  stopLossBpsFromPercent,
  stopLossBpsWhenEnabled,
  stopLossPercentFromBps,
  validateSkillMarkdown,
  parseTradeViewEnvelope,
} from "./trade";

describe("portfolio detail DTO", () => {
  const token = (address: string, targetBps: number) => ({ token: address, symbol: "NVDAB", targetBps, balanceAtomic: "1",
    valueWei: "1", valueReason: null, weightBps: 5000, driftBps: 12000, displayName: "NVIDIA",
    initial: { quantityAtomic: null, quantityReason: "not-recorded", quoteWei: "123", quoteReason: null } });
  const leg = { slot: 0, side: "buy", token: "0x1111111111111111111111111111111111111111", symbol: "NVDAB",
    amountWei: "999", quotedOutAtomic: "1", minOutAtomic: "1", proceedsAtomic: null, state: "projected",
    txHash: `0x${"ab".repeat(32)}`, createdAt: 1,
    detail: { id: "first", executionState: "COMMITTED", executionReason: null, quantityAtomic: null,
      quantityReason: "not-recorded", quoteWei: "123", quoteReason: null } };
  const portfolio = { tokens: [token(leg.token, 5000), token("0x2222222222222222222222222222222222222222", 5000)],
    capitalQuoteWei: "999999999999999999999999999999999", netInvestedWei: "-1", cashCapWei: "1", walletUsdtWei: "1",
    portfolioCashWei: "1", idleUsdtWei: "0", stockValueWei: "2", totalValueWei: "3", pnlWei: "-2", driftBps: 12000,
    intervalSec: 14400, anchorMs: 1, currentSlot: 0, nextCheckAtMs: 2, check: null, legs: [leg] };
  const envelope = (value: unknown) => ({ data: { settings: null, portfolio: value, open: [], closed: [], runs: [], pinned: [],
    summary: {}, lifecycle: {}, pendingIntents: [], marketHours: {} } });

  it("accepts complete evidence, negative accounting, high relative drift and older optional fields", () => {
    expect(parseTradeViewEnvelope(envelope(portfolio)).portfolio?.legs[0]?.detail?.quoteWei).toBe("123");
    expect(parseTradeViewEnvelope(envelope({ ...portfolio, tokens: portfolio.tokens.map(({ displayName: _name, initial: _initial, ...rest }) => rest),
      legs: [{ ...leg, detail: undefined }] })).portfolio?.tokens).toHaveLength(2);
    expect(parseTradeViewEnvelope({ data: { ...envelope(portfolio).data, portfolio: undefined } }).portfolio).toBeUndefined();
  });

  it("rejects malformed portfolio rows, weights, intervals, amounts, states, hashes and evidence pairs", () => {
    const bad = [
      { ...portfolio, tokens: [portfolio.tokens[0], portfolio.tokens[0]] },
      { ...portfolio, tokens: [token(leg.token, 4000), portfolio.tokens[1]] },
      { ...portfolio, intervalSec: 3600 }, { ...portfolio, anchorMs: Infinity },
      { ...portfolio, tokens: [{ ...portfolio.tokens[0], token: "bad" }, portfolio.tokens[1]] },
      { ...portfolio, tokens: [{ ...portfolio.tokens[0], balanceAtomic: "-1" }, portfolio.tokens[1]] },
      { ...portfolio, tokens: [{ ...portfolio.tokens[0], initial: { ...portfolio.tokens[0].initial, quoteWei: null, quoteReason: null } }, portfolio.tokens[1]] },
      { ...portfolio, legs: [{ ...leg, txHash: "0x1234" }] },
      { ...portfolio, legs: [{ ...leg, state: "done" }] },
      { ...portfolio, legs: [{ ...leg, detail: { ...leg.detail, executionState: "BOGUS" } }] },
      { ...portfolio, legs: [{ ...leg, detail: { ...leg.detail, quantityAtomic: "not-decimal" } }] },
      { ...portfolio, legs: [{ ...leg, detail: { ...leg.detail, id: "" } }] },
      { ...portfolio, legs: Array.from({ length: 51 }, () => leg) },
    ];
    for (const value of bad) expect(() => parseTradeViewEnvelope(envelope(value))).toThrow("invalid portfolio");
  });
});

describe("trading UI wire constants", () => {
  it("matches the plane preset fixture byte-for-byte", () => {
    const fixture = readFileSync(new URL("./fixtures/trade-model-presets.json", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
    expect(`${JSON.stringify(TRADE_MODEL_PRESETS, null, 2)}\n`).toBe(fixture);
  });

  it("keeps every shipped preset deployable with 25 granted tokens; TradFi needs its panel capital at 28", () => {
    for (const [model, preset] of Object.entries(TRADE_MODEL_PRESETS)) {
      const sized = checkTradeSizing({
        capDayWei: BigInt(preset.capitalWei),
        entryWei: BigInt(preset.perTradeWei),
        maxOpenPositions: preset.maxPositions,
        grantedTokenCount: MAX_GRANTED_TOKENS,
        platformFeeBps: 500,
      });
      // TradFi's preset capital is the plane's floor (0.01 BNB), not a deployable amount:
      // 3 × 0.02 BNB entries plus the 28-token exit reserve need ≈ 0.0662 BNB at a 5 % fee.
      expect(sized.ok).toBe(model !== "tradfi");
    }
    expect(checkTradeSizing({
      capDayWei: 75_000_000_000_000_000n, entryWei: 20_000_000_000_000_000n, maxOpenPositions: 3,
      grantedTokenCount: maxGrantedTokens("tradfi"), platformFeeBps: 500,
    }).ok).toBe(true);
  });

  it("refuses an oversized markdown upload and reports its encoded byte count", () => {
    const text = "\"".repeat(3_072);
    const result = validateSkillMarkdown("doctrine.md", text);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBe(6_146);
    if (!result.ok) expect(result.message).toContain("received 6146");
  });

  it("accepts only markdown filenames and applies the same encoded bound to CJK instructions", () => {
    expect(validateSkillMarkdown("doctrine.txt", "safe").ok).toBe(false);
    expect(checkBoundedText("界".repeat(682), 2_048, "Instructions").ok).toBe(true);
    const over = checkBoundedText("界".repeat(683), 2_048, "Instructions");
    expect(over.ok).toBe(false);
    expect(over.bytes).toBe(2_051);
  });

  it("refuses deploy sizing below the R2 minimum", () => {
    const result = checkTradeSizing({
      capDayWei: 20_000_000_000_000_000n,
      entryWei: 20_000_000_000_000_000n,
      maxOpenPositions: 3,
      grantedTokenCount: 25,
      platformFeeBps: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.requiredWei).toBe(65_900_000_000_000_000n);
  });

  it("refuses the conflicting 1 BNB / 0.5 BNB / four-position tuple", () => {
    expect(checkTradeSizing({
      capDayWei: 1_000_000_000_000_000_000n,
      entryWei: 500_000_000_000_000_000n,
      maxOpenPositions: 4,
      grantedTokenCount: MAX_GRANTED_TOKENS,
      platformFeeBps: 500,
    }).ok).toBe(false);
  });

  it("round-trips a negative stop-loss display through the positive wire magnitude", () => {
    expect(stopLossPercentFromBps(5_000)).toBe(-50);
    expect(stopLossBpsFromPercent(-50)).toBe(5_000);
    expect(stopLossBpsWhenEnabled(false, -50)).toBeNull();
    expect(stopLossBpsWhenEnabled(true, -50)).toBe(5_000);
  });
});

describe("0G model catalogue", () => {
  it("matches the execution plane's list exactly", () => {
    const fixture: unknown = JSON.parse(readFileSync(new URL("./fixtures/trade-llm-models.json", import.meta.url), "utf8"));
    expect(TRADE_LLM_MODELS.map((model) => ({ id: model.id, label: model.label }))).toEqual(fixture);
  });

  it("offers no model the router answers 404 for", () => {
    const ids: readonly string[] = TRADE_LLM_MODELS.map((model) => model.id);
    for (const gone of ["llama-3.3-70b-instruct", "deepseek-r1", "qwen2.5-72b-instruct", "z-ai/glm-4-32b"]) {
      expect(ids).not.toContain(gone);
    }
  });

  it("keeps the two pickers mutually exclusive by construction", () => {
    const ids = TRADE_LLM_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
  });
});

it("caps new grants at25 for every mode",()=>{
 for(const model of ["blue-chip","sigma","mid-cap","degen"] as const) expect(maxGrantedTokens(model)).toBe(25);
 expect(maxGrantedTokens("tradfi")).toBe(28);
});

// TRADFI-SCHEDULE-NATIVE-CAP-PLAN B1 — the same vectors as `src/trade/sizing.ts`'s copy.
describe("scheduleNativeNeeds (web mirror of src/trade/sizing.ts)", () => {
  it("hourly, one buy left: cap and balance both 3R regardless of session time", () => {
    const needs = scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 1, sessionRemainingMs: 6.5 * 86_400_000 });
    expect(needs.buysPerDay).toBe(1);
    expect(needs.dayCapWei).toBe(3n * RELAY_FEE_PER_EXIT_WEI);
    expect(needs.sessionBuys).toBe(1);
    expect(needs.balanceWei).toBe(3n * RELAY_FEE_PER_EXIT_WEI);
  });

  it("hourly, 50 buys left, 6.5 days remaining: cap 26R, balance 52R", () => {
    const needs = scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 50, sessionRemainingMs: 6.5 * 86_400_000 });
    expect(needs.buysPerDay).toBe(24);
    expect(needs.dayCapWei).toBe(26n * RELAY_FEE_PER_EXIT_WEI);
    expect(needs.sessionBuys).toBe(50);
    expect(needs.balanceWei).toBe(52n * RELAY_FEE_PER_EXIT_WEI);
  });

  it("daily, 9 buys left, 7 days remaining: cap 3R, balance 10R", () => {
    const needs = scheduleNativeNeeds({ intervalSec: 86_400, remainingBuys: 9, sessionRemainingMs: 7 * 86_400_000 });
    expect(needs.buysPerDay).toBe(1);
    expect(needs.dayCapWei).toBe(3n * RELAY_FEE_PER_EXIT_WEI);
    expect(needs.sessionBuys).toBe(8);
    expect(needs.balanceWei).toBe(10n * RELAY_FEE_PER_EXIT_WEI);
  });

  it("no session time left needs no session-buy headroom, but the day cap still funds one rolling day", () => {
    const needs = scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 5, sessionRemainingMs: 0 });
    expect(needs.sessionBuys).toBe(0);
    expect(needs.balanceWei).toBe(2n * RELAY_FEE_PER_EXIT_WEI);
    // buysPerDay = min(5, ceil(86400/3600)=24) = 5, unaffected by the empty session window.
    expect(needs.dayCapWei).toBe(7n * RELAY_FEE_PER_EXIT_WEI);
  });

  it("rejects a negative or non-finite remainingBuys/sessionRemainingMs", () => {
    expect(() => scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: -1, sessionRemainingMs: 0 })).toThrow();
    expect(() => scheduleNativeNeeds({ intervalSec: 3_600, remainingBuys: 1, sessionRemainingMs: Number.NaN })).toThrow();
  });
});

describe("TradFi AI trade view flags (TRADFI-EXPIRY-KEEP-REMOVE)", () => {
  const base = { settings: null, open: [], closed: [], runs: [], pinned: [], summary: {}, lifecycle: {}, pendingIntents: [], marketHours: {} };

  it("reads tradfiAi and keptPositions when present and leaves them absent for an older plane", () => {
    const view = parseTradeViewEnvelope({ data: { ...base, tradfiAi: true, keptPositions: 3 } });
    expect(view.tradfiAi).toBe(true);
    expect(view.keptPositions).toBe(3);
    const older = parseTradeViewEnvelope({ data: base });
    expect(older.tradfiAi).toBeUndefined();
    expect(older.keptPositions).toBeUndefined();
    expect(parseTradeViewEnvelope({ data: { ...base, tradfiAi: false, keptPositions: 0 } }).tradfiAi).toBe(false);
  });

  it("refuses a non-boolean flag and a count that is not a non-negative integer", () => {
    for (const tradfiAi of ["true", 1, null, {}]) expect(() => parseTradeViewEnvelope({ data: { ...base, tradfiAi } })).toThrow("invalid TradFi AI flag");
    for (const keptPositions of [-1, 1.5, "2", null, Number.NaN]) expect(() => parseTradeViewEnvelope({ data: { ...base, keptPositions } })).toThrow("invalid kept-positions count");
  });
});

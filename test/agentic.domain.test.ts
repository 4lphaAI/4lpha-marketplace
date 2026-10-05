import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TRADE_SETTINGS } from "../src/trade/settings.js";
import { resolveAgenticConfig } from "../src/agentic/config.js";
import { agenticBudgetWei, agenticDecimal, agenticGate, agenticHireIdentity, agenticQuoteRaw,
  agenticSellAmount, agenticSlippage, agenticUiString, parseAgenticHireParams, type AgenticFactsRead } from "../src/agentic/domain.js";

const E = 10n ** 18n;
const NOW = Date.UTC(2026, 9, 3);
const FACTS: AgenticFactsRead = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject",
  dailyLimit: 1_000, quotaUsed: 0, x402DailyLimit: 0.5, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000,
  usdtWei: (108n * E).toString(), bnbWei: "4800000000000000" };

describe("Agentic term, gate, exact amounts and settings", () => {
  it("shows live sizing and exact funding shortfalls without rounding have", () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const input = { wallet, facts: { ...FACTS, usdtWei: "11999200000000000000", bnbWei: "1599999999999999" },
      capitalQuoteWei: 10n * E, entryWei: 8n * E, maxOpenPositions: 2, termSec: 604_800, nowMs: NOW, budgetWei: 2n * E };
    const rows = agenticGate(input).rows;
    assert.equal(rows.find(r => r.code === "sizing")?.state, "FAIL");
    assert.equal(rows.find(r => r.code === "sizing")?.fix, "Capital 10 USDT is below 2 positions x 8 USDT = 16 USDT; raise capital or lower the entry size.");
    assert.equal(agenticGate({ ...input, capitalQuoteWei: 16n * E }).rows.find(r => r.code === "sizing")?.state, "PASS");
    assert.equal(rows.find(r => r.code === "usdt")?.fix, `Have 11.9992 USDT, need 12 USDT: add 0.0008 USDT to ${wallet}.`);
    assert.equal(rows.find(r => r.code === "bnb")?.fix, `Have 0.001599999999999999 BNB, need 0.0016 BNB: add 0.000000000000000001 BNB to ${wallet}.`);
  });
  it("defaults off and refuses a typo or missing boot requirement", () => {
    const input = { hireEnabled: false, tradeAgentEnabled: false, rpcUrls: [] };
    assert.deepEqual(resolveAgenticConfig({}, input), { enabled: false });
    assert.deepEqual(resolveAgenticConfig({ AGENTIC_WALLET_ENABLED: "false" }, input), { enabled: false });
    assert.throws(() => resolveAgenticConfig({ AGENTIC_WALLET_ENABLED: "TRUE" }, input));
    assert.throws(() => resolveAgenticConfig({ AGENTIC_WALLET_ENABLED: "true" }, input));
  });
  it("parses the exact numeric thresholds without float quota subtraction", () => {
    assert.equal(agenticDecimal(0.5), E / 2n);
    assert.equal(agenticDecimal(999.99), 99999n * E / 100n);
    for (const value of [Infinity, -1, 1e13, "1e3"]) assert.equal(agenticDecimal(value), null);
    // Long floats measured from Binance (2026-10-03) keep their printed decimals exactly; an exponent form such as 1e-7 goes through toFixed(18).
    assert.equal(agenticDecimal(0.00999796218874478), 9_997_962_188_744_780n);
    assert.equal(agenticDecimal(19.990002037811255), 19_990_002_037_811_255_000n);
    assert.equal(agenticDecimal(49999.990000000005), 49_999_990_000_000_005_000_000n);
    assert.equal(agenticDecimal(1e-7), 100_000_000_000n);
    assert.equal(agenticDecimal(1.2345678901234567e-7), BigInt((1.2345678901234567e-7).toFixed(18).replace(".", "")));
    for (const value of [NaN, -Infinity, -0.5, -1e-9, 1e12 + 1, 1e21, undefined, null]) assert.equal(agenticDecimal(value), null);
    assert.equal(agenticDecimal(1.01)! - agenticDecimal(1)!, E / 100n);
    assert.equal(agenticUiString(E), "1");
    assert.equal(agenticUiString(12345n * E / 1000n), "12.345");
  });
  it("reproduces both sell amount vectors and refuses missing, dust or inconsistent balance evidence", () => {
    const multiplier = "1.001729792036835231";
    assert.equal(agenticSellAmount(1298865564003663n, multiplier, "0.001301112331313196"), "0.001301112331313196");
    assert.equal(agenticSellAmount(1298865564003062n, multiplier, "0.001301112331312593"), "0.001301112331312594");
    assert.equal(agenticSellAmount(1298865564003062n, multiplier, "0"), null);
    assert.equal(agenticSellAmount(1n, "0.99", "0.000000000000000001"), null);
    assert.equal(agenticQuoteRaw("1.2", "1.2"), E);
  });
  it("applies quote headroom as a percentage and refuses zero headroom", () => {
    assert.equal(agenticSlippage(995n * E / 10n, 99n * E, 100), "0.5");
    assert.equal(agenticSlippage(10_000n, 9_999n, 100), "0.01");
    assert.equal(agenticSlippage(100n, 100n, 100), null);
  });
  it("pins budgets, funding gates and the two-hour cutoff for both terms", () => {
    for (const term of [7, 30] as const) {
      const budget = agenticBudgetWei(term);
      assert.equal(budget, BigInt(term === 7 ? 2 : 8) * E);
      const result = agenticGate({ facts: FACTS, capitalQuoteWei: 100n * E, maxOpenPositions: 10,
        entryWei: 20n * E, termSec: term * 86_400, nowMs: NOW, budgetWei: budget });
      assert.deepEqual(result.rows.filter(r => r.state === "FAIL").map(r => r.code), ["sizing"]);
      assert.equal(result.hireEndMs, NOW + term * 86_400_000);
      assert.equal(result.entryCutoffMs, result.hireEndMs - 7_200_000);
      const short = agenticGate({ facts: { ...FACTS, usdtWei: (100n * E + budget - 1n).toString() }, capitalQuoteWei: 100n * E,
        maxOpenPositions: 10, entryWei: 20n * E, termSec: term * 86_400, nowMs: NOW, budgetWei: budget });
      assert.equal(short.rows.find(r => r.code === "usdt")?.state, "FAIL");
    }
  });
  it("clips a seven-day session by one hour ten minutes and refuses a thirty-day pick", () => {
    const facts = { ...FACTS, signInMaxTimeMs: NOW + 7 * 86_400_000 };
    for (const term of [7, 30] as const) {
      const result = agenticGate({ facts, capitalQuoteWei: 100n * E, maxOpenPositions: 2, entryWei: 20n * E,
        termSec: term * 86_400, nowMs: NOW + 600_000, budgetWei: agenticBudgetWei(term) });
      assert.equal(result.rows.find(r => r.code === "sign-in-time")?.state, term === 7 ? "PASS" : "FAIL");
      assert.equal(result.hireEndMs, NOW + 7 * 86_400_000 - 3_600_000);
    }
  });
  it("refuses each admission failure, while low quota today is a warning", () => {
    for (const [patch, code] of [
      [{ status: "UNCONNECTED" }, "status"], [{ tradeAllTokens: false }, "trade-all-tokens"],
      [{ abnormalTxnHandling: "NeedConfirmation" }, "abnormal-handling"], [{ dailyLimit: 999.99 }, "daily-limit"],
      [{ x402DailyLimit: 0.49 }, "x402-limit"], [{ bnbWei: "1" }, "bnb"],
    ] as const) {
      const result = agenticGate({ facts: { ...FACTS, ...patch }, capitalQuoteWei: 100n * E, maxOpenPositions: 10,
        entryWei: 20n * E, termSec: 604_800, nowMs: NOW, budgetWei: 2n * E });
      assert.equal(result.rows.find(r => r.code === code)?.state, "FAIL");
    }
    const warning = agenticGate({ facts: { ...FACTS, quotaUsed: 999 }, capitalQuoteWei: 100n * E, maxOpenPositions: 10,
      entryWei: 20n * E, termSec: 604_800, nowMs: NOW, budgetWei: 2n * E });
    assert.equal(warning.rows.find(r => r.code === "quota-today")?.state, "WARN");
  });
  it("requires closed hire keys, dedicated-wallet consent, AI mode, explicit term-end choice and the exact term budget", () => {
    const body = { pairingId: "11111111-1111-4111-8111-111111111111", term: 7, termEndAction: "keep", executionModel: "tradfi",
      hireRunId: "22222222-2222-4222-8222-222222222222", acceptedDedicatedWallet: true,
      settings: { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT", cmcNewsEnabled: true,
        cmcTotalBudgetWei: (2n * E).toString(), minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (100n * E).toString() } };
    const parsed = parseAgenticHireParams(body);
    assert.ok(parsed);
    assert.match(agenticHireIdentity(parsed).agentId, /^agentic-[0-9a-f]{20}$/);
    for (const changed of [{ ...body, termEndAction: undefined }, { ...body, acceptedDedicatedWallet: false }, { ...body, extra: 1 },
      { ...body, term: 30 }, { ...body, settings: { ...body.settings, cmcNewsEnabled: false } }]) assert.equal(parseAgenticHireParams(changed), null);
  });
});

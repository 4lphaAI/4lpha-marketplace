/** AGENTIC-DCA Revision 3: the web gate mirror (plane parity vectors, 2N + 4 BNB slots), the refusal copy, the adapter into the shared DcaDetail view, and the copy's glyph rule. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AGENTIC_DCA_COPY, AgenticRequestError, agenticDcaBnbSlots, agenticDcaEnabled, agenticDcaResting, agenticDcaView, agenticGate, agenticKeepAliveBudgetWei, isAgenticDcaDto,
  type AgenticDcaDto, type AgenticFacts, type AgenticHireReason } from "./agentic";
import { runLabel } from "@/components/trade/TradeRunLog";

const E = 10n ** 18n, NOW = 1_900_000_000_000;
const FACTS: AgenticFacts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 10_000, quotaUsed: 0, x402DailyLimit: 0.5, x402QuotaUsed: 0,
  signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: (1000n * E).toString(), bnbWei: "100000000000000000" };
/** Base 25 USDT and N orders of 10 USDT: the parser's capital rule. */
const capitalOf = (n: number) => (25n + 10n * BigInt(n)) * E;
const gate = (n: number, facts: Partial<AgenticFacts> = {}, term: 7 | 30 = 7) => agenticGate({ facts: { ...FACTS, ...facts }, capitalQuoteWei: capitalOf(n), maxOpenPositions: 1, entryWei: 25n * E, termSec: term * 86_400,
  nowMs: NOW, budgetWei: agenticKeepAliveBudgetWei(term), dca: { maxOrders: n } });
const row = (rows: { code: string; state: string; fix: string }[], code: string) => rows.find(r => r.code === code);

describe("AGENTIC-DCA web gate mirror", () => {
  it("asks (2N + 4) x 0.0004 BNB: 0.0024 / 0.0040 / 0.0048 / 0.0080 for N = 1 / 3 / 4 / 8, passing at the value and failing one wei short", () => {
    for (const [n, need, slots] of [[1, 2_400_000_000_000_000n, 6], [3, 4_000_000_000_000_000n, 10], [4, 4_800_000_000_000_000n, 12], [8, 8_000_000_000_000_000n, 20]] as const) {
      expect(agenticDcaBnbSlots(n)).toBe(slots);
      expect(BigInt(slots) * 400_000_000_000_000n).toBe(need);
      expect(row(gate(n, { bnbWei: need.toString() }).rows, "bnb")?.state).toBe("PASS");
      expect(row(gate(n, { bnbWei: (need - 1n).toString() }).rows, "bnb")?.state).toBe("FAIL");
    }
    expect(row(gate(3, { bnbWei: "0" }).rows, "bnb")!.fix).toContain("need 0.004 BNB");
    expect(row(gate(8, { bnbWei: "0" }).rows, "bnb")!.fix).toContain("need 0.008 BNB");
  });

  it("keeps one resting buy up to three orders and two from four, and reads a count outside 1..8 as 8", () => {
    expect([1, 2, 3, 4, 8].map(agenticDcaResting)).toEqual([1, 1, 1, 2, 2]);
    for (const bad of [0, 9, -1, 2.5, Number.NaN]) expect(agenticDcaBnbSlots(bad)).toBe(20);
  });

  it("asks capital plus the keep-alive budget in USDT, ten times the capital in daily limit, and keeps the x402 and quota rows", () => {
    for (const [term, budget] of [[7, E / 5n], [30, 4n * E / 5n]] as const) {
      const need = capitalOf(3) + budget;
      expect(row(gate(3, { usdtWei: need.toString() }, term).rows, "usdt")?.state).toBe("PASS");
      expect(row(gate(3, { usdtWei: (need - 1n).toString() }, term).rows, "usdt")?.state).toBe("FAIL");
    }
    expect(row(gate(3, { usdtWei: "0" }).rows, "usdt")!.fix).toContain("need 55.2 USDT");
    expect(row(gate(3, { usdtWei: "0" }, 30).rows, "usdt")!.fix).toContain("need 55.8 USDT");
    expect(row(gate(3, { dailyLimit: 549.99 }).rows, "daily-limit")!.fix).toBe("Raise Daily limit to 550 USDT.");
    expect(row(gate(3, { dailyLimit: 550 }).rows, "daily-limit")?.state).toBe("PASS");
    expect(gate(3).rows.map(r => r.code)).toEqual(["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "x402-limit", "usdt", "bnb", "quota-today", "sizing"]);
    expect(row(gate(3, { x402DailyLimit: 0.49 }).rows, "x402-limit")?.state).toBe("FAIL");
    expect(row(gate(3, { x402DailyLimit: 0.5 }).rows, "x402-limit")?.state).toBe("PASS");
    expect(row(gate(3, { quotaUsed: 10_000 }).rows, "quota-today")?.state).toBe("WARN");
    expect(row(gate(3).rows, "sizing")?.state).toBe("PASS");
  });

  it("without the dca input the gate is today's AI gate: maxOpenPositions + 2 slots", () => {
    const rows = agenticGate({ facts: { ...FACTS, bnbWei: "0" }, capitalQuoteWei: capitalOf(3), maxOpenPositions: 1, entryWei: 25n * E, termSec: 604_800, nowMs: NOW, budgetWei: 2n * E }).rows;
    expect(row(rows, "bnb")!.fix).toContain("need 0.0012 BNB");
  });
});

describe("AGENTIC-DCA flag and refusal copy", () => {
  it("the web flag is build time and off unless it is exactly true", () => {
    expect(agenticDcaEnabled).toBe(false);
    expect(readFileSync(new URL("./agentic.ts", import.meta.url), "utf8")).toContain('export const agenticDcaEnabled = process.env.NEXT_PUBLIC_AGENTIC_DCA_ENABLED === "true";');
  });

  it("words the five Agentic Auto DCA refusals", () => {
    const copy: [AgenticHireReason, string][] = [
      ["dca-disabled", "Hire refused: Agentic Auto DCA is not enabled on this execution plane."],
      ["dca-token-unsupported", "Hire refused: this stock cannot be traded from an Agentic Wallet."],
      ["dca-capability-incomplete", "Hire refused: the stock check did not finish. Check the pairing status below, then try again."],
      ["dca-pool-mismatch", "Hire refused: this stock's price pool changed. Try again later."],
      ["dca-token-unquotable", "Hire refused: Binance has no buy quote for this stock at this amount."]];
    for (const [reason, text] of copy) expect(new AgenticRequestError("gate-failed", [], reason).message).toBe(text);
  });
});

const ORDER = { tokenId: null, tickLower: 0, tickUpper: 0 };
const dto = (patch: Partial<AgenticDcaDto> = {}): AgenticDcaDto => ({
  token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", symbol: "NVDAB", fee: 2500, usdtIsToken0: false, mark: { e8: "22300000000", block: "100" },
  settings: { stepBps: 100, takeProfitBps: 150, baseWei: (25n * E).toString(), orderWei: (10n * E).toString(), maxOrders: 4, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: 1500 },
  round: { roundNo: 2, phase: "active", closeCause: null, openedAt: NOW, p0E8: "22337000000", avgCostE8: "22400000000", tpTargetE8: "22736000000", costUsdtWei: (35n * E).toString(), stockHeldWei: (E / 10n).toString(),
    realizedPnlWei: null,
    levels: [
      { levelNo: 1, levelPriceE8: "22113630000", state: "filled", priceE8: "22113630000", usdtWei: (10n * E).toString(), stockWei: (E / 50n).toString(), txHash: `0x${"a".repeat(64)}`, closedBy: null },
      { levelNo: 2, levelPriceE8: "21900000000", state: "resting", priceE8: "21900000000", usdtWei: (10n * E).toString(), stockWei: "0", txHash: null, closedBy: null },
      { levelNo: 3, levelPriceE8: "21700000000", state: "cancelled", priceE8: "21700000000", usdtWei: (10n * E).toString(), stockWei: "0", txHash: null, closedBy: "binance" },
      { levelNo: 4, levelPriceE8: "21500000000", state: "held", priceE8: "21500000000", usdtWei: (10n * E).toString(), stockWei: "0", txHash: null, closedBy: null }],
    tp: { state: "resting", priceE8: "22736000000", usdtWei: "0", stockWei: (E / 10n).toString(), txHash: null, closedBy: null },
    base: { usdtWei: (25n * E).toString(), stockWei: (E / 10n).toString(), txHash: `0x${"b".repeat(64)}`, atMs: NOW } },
  rounds: { settled: 1, realizedPnlWei: E.toString(), markedPnlWei: E.toString(), lastSettledAt: NOW,
    history: [{ roundNo: 1, closeCause: "take-profit", openedAt: NOW - 1, settledAt: NOW, filledLevels: 1, realizedPnlWei: E.toString(), markedPnlWei: E.toString() }] },
  equity: { equityWei: (60n * E).toString(), baselineWei: (65n * E).toString(), stopAtWei: (55n * E).toString(), markE8: "22300000000", readingBlock: "100" },
  wallet: { usdtWei: (20n * E).toString(), stockWei: "1" }, reason: null, heldOrders: 1,
  history: { fills: [{ atMs: NOW, roundNo: 2, kind: "base", levelNo: null, side: "buy", usdtWei: (25n * E).toString(), stockWei: "1", txHash: `0x${"b".repeat(64)}` }] },
  actions: [{ kind: "start", roundNo: 2, state: "finished", txHash: `0x${"b".repeat(64)}`, createdAt: NOW, updatedAt: NOW }],
  keepAlive: { lastActivityAtMs: NOW, dueAtMs: NOW + 43_200_000, lastPaidAtMs: null }, ...patch });

describe("AGENTIC-DCA adapter into the shared DcaDetail view", () => {
  it("fills the NFPM-only fields with inert values and keeps what the plane sent", () => {
    const view = agenticDcaView(dto());
    expect(view).toMatchObject({ token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", symbol: "NVDAB", fee: 2500, usdtIsToken0: false, mark: { e8: "22300000000", block: "100" },
      inFlight: null, unknownAction: null, reason: null, heldOrders: 1, keepAlive: { lastPaidAtMs: null } });
    const round = view.round!;
    expect(round).toMatchObject({ roundNo: 2, phase: "active", unreliable: false, p0E8: "22337000000", tpTargetE8: "22736000000" });
    expect(round.levels.map((level) => [level.levelNo, level.state, level.closedBy])).toEqual([[1, "filled", null], [2, "resting", null], [3, "cancelled", "binance"], [4, "held", null]]);
    for (const order of [...round.levels, round.tp!]) expect(Object.hasOwn(order, "strategyId")).toBe(false);
    expect(Object.hasOwn(round, "noTakeProfit")).toBe(false);
    for (const order of [...round.levels, round.tp!]) expect(order).toMatchObject({ tokenId: null, tickLower: 0, tickUpper: 0 });
    expect(round.base).toEqual({ usdtWei: (25n * E).toString(), stockWei: (E / 10n).toString(), txHash: `0x${"b".repeat(64)}`, atMs: NOW });
    expect(view.rounds.history![0]).toMatchObject({ roundNo: 1, closeCause: "take-profit", unreliable: false, markedPnlWei: E.toString() });
    expect(view.history!.fills).toHaveLength(1);
    expect(view.actions).toHaveLength(1);
  });

  it("stands the plane's one limit price in for the order edge and for both ends of the take profit's range", () => {
    const round = agenticDcaView(dto()).round!;
    expect(round.tp).toMatchObject({ state: "resting", rangeLowE8: "22736000000", rangeHighE8: "22736000000", edgePriceE8: "22736000000" });
    expect(round.levels.map((level) => [level.levelPriceE8, level.edgePriceE8])).toEqual([["22113630000", "22113630000"], ["21900000000", "21900000000"], ["21700000000", "21700000000"], ["21500000000", "21500000000"]]);
  });

  it("tolerates a sparse block: no round, no optional key, nothing thrown", () => {
    const sparse: AgenticDcaDto = { token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", symbol: "NVDAB", fee: 2500, usdtIsToken0: false, round: null,
      settings: dto().settings, rounds: { settled: 0, realizedPnlWei: "0" } };
    const view = agenticDcaView(sparse);
    expect(view).toMatchObject({ round: null, equity: null, wallet: null, reason: null, inFlight: null, unknownAction: null, rounds: { settled: 0, realizedPnlWei: "0", lastSettledAt: null } });
    for (const key of ["mark", "history", "actions", "heldOrders", "keepAlive"]) expect(Object.hasOwn(view, key)).toBe(false);
    expect(Object.hasOwn(view.rounds, "history")).toBe(false);
    const thin = agenticDcaView({ ...sparse, round: { roundNo: 1, phase: "starting", openedAt: NOW, costUsdtWei: "0", stockHeldWei: "0" } });
    expect(thin.round).toMatchObject({ levels: [], tp: null, closeCause: null, p0E8: null, avgCostE8: null, tpTargetE8: null, realizedPnlWei: null, unreliable: false });
    expect(Object.hasOwn(thin.round!, "base")).toBe(false);
  });

  it("reads the plane's mark-unavailable and wallet-unreadable as the existing chain-unreadable reason, and keeps every other reason", () => {
    expect(agenticDcaView(dto({ reason: "mark-unavailable" })).reason).toBe("chain-unreadable");
    expect(agenticDcaView(dto({ reason: null, wallet: undefined, walletReason: "wallet-unreadable" })).reason).toBe("chain-unreadable");
    expect(agenticDcaView(dto({ reason: "no-active-round", walletReason: "wallet-unreadable" })).reason).toBe("no-active-round");
    expect(agenticDcaView(dto({ reason: null })).reason).toBeNull();
  });

  it("accepts the plane's block and refuses a broken one", () => {
    expect(isAgenticDcaDto(dto())).toBe(true);
    expect(isAgenticDcaDto({ ...dto(), round: null })).toBe(true);
    for (const broken of [null, undefined, "x", [], { ...dto(), symbol: 1 }, { ...dto(), settings: null }, { ...dto(), rounds: undefined }, { ...dto(), round: "x" }, { ...dto(), fee: "2500" }]) expect(isAgenticDcaDto(broken)).toBe(false);
  });
});

describe("AGENTIC-DCA copy carries no em dash", () => {
  it("scans every string the DCA copy and the new run log labels add", () => {
    const strings: string[] = [];
    for (const value of Object.values(AGENTIC_DCA_COPY)) {
      if (typeof value === "string") strings.push(value);
      else for (const arg of [0, 1, 2, 7]) strings.push((value as (n: never) => string)(arg as never));
    }
    for (const code of ["dca-base-bought", "dca-orders-cancelled", "dca-watching", "dca-quote-short", "dca-cooldown", "dca-cancelling", "dca-stopping", "dca-winding-down", "dca-low-bnb", "dca-quota-low",
      "dca-settings-hold", "dca-binance-throttled", "dca-agentic-off", "dca-order-held", "dca-unattributed-strategy", "dca-list-incomplete", "dca-fill-above-level", "dca-tp-stale", "dca-stop-cancel-unconfirmed", "dca-no-tp"]) strings.push(runLabel(code));
    for (const reason of ["dca-disabled", "dca-token-unsupported", "dca-capability-incomplete", "dca-pool-mismatch", "dca-token-unquotable"] as const) strings.push(new AgenticRequestError("x", [], reason).message);
    expect(strings.length).toBeGreaterThan(30);
    for (const text of strings) { expect(text.length).toBeGreaterThan(0); expect(text.includes(String.fromCharCode(0x2014)), text).toBe(false); }
  });
});

/** AGENTIC-SCHEDULE: golden pin of the AI browser gate (captured on the pristine tree) and the Schedule gate mirror's own tests. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgenticRequestError, agenticGate, agenticScheduleCounts, type AgenticFacts, type AgenticHireReason, type AgenticScheduleInput } from "./agentic";

const E = 10n ** 18n, NOW = 1_900_000_000_000;
const FACTS: AgenticFacts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject",
  dailyLimit: 1_000, quotaUsed: 0, x402DailyLimit: 0.5, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000,
  usdtWei: (108n * E).toString(), bnbWei: "4800000000000000" };
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? v.toString() : v)).digest("hex");

describe("AGENTIC-SCHEDULE web gate mirror", () => {
  it("GOLDEN AI: gate rows, order, states and fixes for an AI input are the pristine ones", () => {
    const rows: unknown[] = [];
    for (const [patch, capital, entry, maxOpen, term] of [[{}, 100n, 20n, 10, 7], [{ x402DailyLimit: 0.49, bnbWei: "1" }, 10n, 8n, 2, 30], [{ status: "UNCONNECTED", quotaUsed: 999 }, 100n, 20n, 3, 7]] as const) {
      rows.push(agenticGate({ wallet: "0x1111111111111111111111111111111111111111", facts: { ...FACTS, ...patch }, capitalQuoteWei: capital * E, maxOpenPositions: maxOpen,
        entryWei: entry * E, termSec: term * 86_400, nowMs: NOW, budgetWei: BigInt(term === 7 ? 2 : 8) * E }));
    }
    expect(sha(rows)).toBe("c66ab6eb2616f082adf043f09f960e5d8dcddc68b80e6c3fb35d876784f79e71");
  });
});

describe("AGENTIC-SCHEDULE Schedule gate", () => {
  const schedule: AgenticScheduleInput = { intervalSec: 3600, endKind: "runs", endRuns: 2, endAtSec: null, firstAtSec: null };
  const gate = (input: { capital?: bigint; entry?: bigint; term?: 7 | 30; facts?: Partial<AgenticFacts>; schedule?: Partial<AgenticScheduleInput> } = {}) => {
    const capital = (input.capital ?? 10n) * E;
    return agenticGate({ facts: { ...FACTS, ...input.facts }, capitalQuoteWei: capital, maxOpenPositions: 1, entryWei: (input.entry ?? 5n) * E, termSec: (input.term ?? 7) * 86_400,
      nowMs: NOW, budgetWei: 0n, quoteDayCapWei: capital, schedule: { ...schedule, ...input.schedule } });
  };
  const row = (rows: { code: string; state: string; fix: string }[], code: string) => rows.find(r => r.code === code);
  const need = (input: Parameters<typeof gate>[0] = {}) => /need ([0-9.]+) BNB/.exec(row(gate({ ...input, facts: { bnbWei: "0" } }).rows, "bnb")!.fix)![1];

  it("asks 0.0012 BNB plus 0.0004 per buy the term can run, with the plane's exact vectors", () => {
    expect(need()).toBe("0.002");
    expect(need({ capital: 300n, entry: 10n, term: 30, schedule: { intervalSec: 86_400, endKind: "budget", endRuns: null } })).toBe("0.0132");
    expect(need({ capital: 1000n, schedule: { endKind: "budget", endRuns: null } })).toBe("0.0676");
    expect(row(gate({ facts: { bnbWei: "2000000000000000" } }).rows, "bnb")?.state).toBe("PASS");
    expect(row(gate({ facts: { bnbWei: "1999999999999999" } }).rows, "bnb")?.state).toBe("FAIL");
  });
  it("counts buys as the plane does and not as the Altana form estimate", () => {
    const counts = (capital: bigint, entry: bigint, interval: 3600 | 86400, term: number, end: Partial<AgenticScheduleInput>) => agenticScheduleCounts({ capitalQuoteWei: capital * E, entryWei: entry * E,
      ...schedule, intervalSec: interval, ...end, ttlSec: term * 86_400, nowMs: NOW });
    expect(counts(10n, 5n, 3600, 7, {})).toEqual({ plannedBuys: 2, buysThisSession: 166 });
    expect(counts(300n, 10n, 86_400, 30, { endKind: "budget", endRuns: null })).toEqual({ plannedBuys: 30, buysThisSession: 30 });
    expect(counts(1000n, 5n, 3600, 7, { endKind: "budget", endRuns: null })).toEqual({ plannedBuys: 200, buysThisSession: 166 });
    expect(counts(1000n, 5n, 3600, 7, { endKind: "date", endRuns: null, endAtSec: NOW / 1_000 + 7_200 })).toEqual({ plannedBuys: 2, buysThisSession: 166 });
  });
  it("keeps daily limit at twice the capital, USDT at the capital and shows no x402 row", () => {
    expect(row(gate({ facts: { dailyLimit: 19.99 } }).rows, "daily-limit")).toMatchObject({ state: "FAIL", fix: "Raise Daily limit to 20 USDT." });
    expect(row(gate({ facts: { dailyLimit: 20 } }).rows, "daily-limit")?.state).toBe("PASS");
    expect(row(gate({ facts: { usdtWei: (10n * E).toString() } }).rows, "usdt")?.state).toBe("PASS");
    expect(row(gate({ facts: { usdtWei: (10n * E - 1n).toString() } }).rows, "usdt")?.state).toBe("FAIL");
    expect(row(gate({ facts: { x402DailyLimit: 0 } }).rows, "x402-limit")).toBeUndefined();
    expect(gate().rows.map(r => r.code)).toEqual(["status", "trade-all-tokens", "abnormal-handling", "sign-in-time", "daily-limit", "usdt", "bnb", "quota-today", "sizing", "schedule-first-buy", "schedule-end-date"]);
  });
  it("accepts a first buy from 300 s ago to the 7-day window or the entry cutoff, whichever is sooner", () => {
    const first = (firstAtSec: number | null, facts: Partial<AgenticFacts> = {}, term: 7 | 30 = 7) => row(gate({ facts, term, schedule: { firstAtSec } }).rows, "schedule-first-buy")?.state;
    const nowSec = NOW / 1_000;
    expect([first(null), first(nowSec - 301), first(nowSec - 300), first(nowSec + 597_600), first(nowSec + 597_601)]).toEqual(["PASS", "FAIL", "PASS", "PASS", "FAIL"]);
    expect([first(nowSec + 597_600, {}, 30), first(nowSec + 597_601, {}, 30)]).toEqual(["PASS", "FAIL"]);
    const clipped = { signInMaxTimeMs: NOW + 3 * 86_400_000 + 3_600_000 }, cutoff = (NOW + 3 * 86_400_000 - 7_200_000) / 1_000;
    expect([first(cutoff, clipped), first(cutoff + 1, clipped)]).toEqual(["PASS", "FAIL"]);
    expect(row(gate({ schedule: { firstAtSec: nowSec + 1_000_000 } }).rows, "schedule-first-buy")?.fix).toMatch(/^Choose a first buy within the next 7 days and before \d{4}-\d{2}-\d{2}T.*Z\.$/u);
  });
  it("needs an end date in the future", () => {
    const end = (endAtSec: number | null) => row(gate({ schedule: { endKind: endAtSec === null ? "runs" : "date", endRuns: endAtSec === null ? 2 : null, endAtSec } }).rows, "schedule-end-date")?.state;
    expect([end(null), end(NOW / 1_000), end(NOW / 1_000 + 1)]).toEqual(["PASS", "FAIL", "PASS"]);
  });
  it("words every Schedule refusal for the owner", () => {
    const copy: Record<string, string> = { "schedule-token-not-granted": "Hire refused: this stock is not in the eligible list.", "schedule-token-unquotable": "Hire refused: this stock has no buy quote at this amount.",
      "schedule-capability-incomplete": "Hire refused: the stock check did not finish. Check the pairing status below, then try again.",
      "schedule-first-buy-past": "Hire refused: the first buy time is outside the allowed window. Choose a new time and deploy again.",
      "schedule-end-past": "Hire refused: the end date has passed. Choose a new end date and deploy again." };
    for (const [reason, message] of Object.entries(copy)) expect(new AgenticRequestError("gate-failed", [], reason as AgenticHireReason).message).toBe(message);
  });
});

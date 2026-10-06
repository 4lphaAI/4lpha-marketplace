/** AGENTIC-EARN-SPEC ET13: the web gate mirror asks exactly the BNB the plane's gate asks (two more operation reserves, 0.0008), only for an earn hire, for every lane; the same absolute figures as test/agentic.earn.hire.test.ts H2. */
import { expect, it } from "vitest";
import { agenticEarnEstimate, agenticEarnOffered, agenticGate, AGENTIC_EARN_COPY, AGENTIC_EARN_PRODUCTS } from "./agentic";

const NOW = 1_900_000_000_000, E = 10n ** 18n;
const facts = { readAtMs: NOW, status: "CONNECTED", tradeAllTokens: true, abnormalTxnHandling: "AutoReject", dailyLimit: 100_000, quotaUsed: 0, x402DailyLimit: 20, x402QuotaUsed: 0, signInMaxTimeMs: NOW + 90 * 86_400_000, usdtWei: "0", bnbWei: "0" };
const need = (extra: Record<string, unknown>): string => {
  const row = agenticGate({ facts, capitalQuoteWei: 100n * E, maxOpenPositions: 2, entryWei: 5n * E, termSec: 7 * 86_400, nowMs: NOW, budgetWei: 2n * E, ...extra } as never).rows.find(r => r.code === "bnb")!;
  return /need ([0-9.]+) BNB/u.exec(row.fix)![1]!;
};
const schedule = { intervalSec: 86_400, endKind: "runs", endRuns: 2, endAtSec: null, firstAtSec: null } as const;

it("the earn hire needs 0.0008 BNB more in every lane, and only an earn hire", () => {
  expect([need({}), need({ earn: true })]).toEqual(["0.0016", "0.0024"]);
  expect([need({ maxOpenPositions: 1, schedule, budgetWei: 0n }), need({ maxOpenPositions: 1, schedule, budgetWei: 0n, earn: true })]).toEqual(["0.002", "0.0028"]);
  expect([need({ dca: { maxOrders: 5 } }), need({ dca: { maxOrders: 5 }, earn: true })]).toEqual(["0.0056", "0.0064"]);
});

it("the opt-in is offered only with the flag, a configured product and AI, Schedule or DCA with N >= 5; the copy has no em dash", () => {
  const products = [{ investmentId: "venus-usdt" }], none = [{ investmentId: null }];
  expect([agenticEarnOffered({ tradeMode: undefined }, true, products), agenticEarnOffered({ tradeMode: "schedule" }, true, products), agenticEarnOffered({ tradeMode: "dca", dcaMaxOrders: 5 }, true, products)]).toEqual([true, true, true]);
  expect([agenticEarnOffered({ tradeMode: "dca", dcaMaxOrders: 4 }, true, products), agenticEarnOffered({ tradeMode: "portfolio" }, true, products), agenticEarnOffered({ tradeMode: undefined, meme: true }, true, products),
    agenticEarnOffered({ tradeMode: undefined }, false, products), agenticEarnOffered({ tradeMode: undefined }, true, none)]).toEqual([false, false, false, false, false]);
  expect(JSON.stringify(AGENTIC_EARN_COPY)).not.toContain(String.fromCharCode(0x2014));
});

it("the web mirror carries the same measured investment ids as the plane (E0 2026-10-06)", () => {
  expect(AGENTIC_EARN_PRODUCTS).toEqual([{ protocol: "venus", label: "Venus", investmentId: "5b77bfd8d8f7c18e9ee0d8f331c4d78f56744eed8addbe2e9970c0ef37e763cb" },
    { protocol: "aave-v3", label: "Aave v3", investmentId: "9e901e308ea48144dcce3d77f22be8fbc0dbeef09167174a5a5dbb3b05c6a5e8" }]);
  expect(agenticEarnOffered({ tradeMode: undefined }, true)).toBe(true);
  expect(agenticEarnOffered({ tradeMode: undefined }, true, AGENTIC_EARN_PRODUCTS.map(p => ({ ...p, investmentId: null })))).toBe(false);
});

it("the Deploy estimate follows the lane's own first decision: keep, then lend min(60 % of capital, capital - keep) when at least 20 USDT; the vectors of AGENTIC-EARN-SPEC 3.6 and the live E2 hire", () => {
  const u = (n: number) => BigInt(Math.round(n * 100)) * E / 100n;
  const s = (capital: number, entry: number, intervalSec: number, plannedBuys: number, buysThisSession: number) =>
    agenticEarnEstimate({ mode: "schedule", capitalWei: u(capital), entryWei: u(entry), intervalSec, plannedBuys, buysThisSession });
  expect(s(50, 10, 86_400, 5, 7)).toEqual({ lendWei: u(20), keepWei: u(30), minCapitalWei: u(50) });       // runbook E2
  expect(s(100, 5, 14_400, 20, 42)).toEqual({ lendWei: u(60), keepWei: u(40), minCapitalWei: u(60) });     // the live hire: 60 lent at the start
  expect(s(100, 5, 3_600, 20, 168)).toEqual({ lendWei: 0n, keepWei: u(100), minCapitalWei: u(150) });      // hourly keeps 26 buys
  expect(s(30, 10, 86_400, 3, 7)).toEqual({ lendWei: 0n, keepWei: u(30), minCapitalWei: u(50) });
  expect(s(100, 10, 86_400, 2, 7)).toEqual({ lendWei: u(60), keepWei: u(20), minCapitalWei: u(40) });      // a 2-run limit keeps 2 buys; 60 % caps it
  const ai = (capital: number, entry: number, maxOpenPositions: number) => agenticEarnEstimate({ mode: "ai", capitalWei: u(capital), entryWei: u(entry), maxOpenPositions });
  expect(ai(100, 20, 5)).toEqual({ lendWei: u(60), keepWei: u(40), minCapitalWei: u(60) });               // V3
  expect(ai(150, 50, 3)).toEqual({ lendWei: u(50), keepWei: u(100), minCapitalWei: u(120) });
  expect(ai(30, 10, 1)).toEqual({ lendWei: 0n, keepWei: u(10), minCapitalWei: 33_333_333_333_333_333_334n });
  const dca = (base: number, order: number, maxOrders: number) => agenticEarnEstimate({ mode: "dca", capitalWei: u(base + order * maxOrders), baseWei: u(base), orderWei: u(order), maxOrders });
  expect(dca(25, 10, 5)).toEqual({ lendWei: u(20), keepWei: u(55), minCapitalWei: null });                 // V4 boundary
  expect(dca(25, 20, 5)).toEqual({ lendWei: u(40), keepWei: u(85), minCapitalWei: null });                 // V5
  expect(dca(25, 10, 8)).toEqual({ lendWei: u(50), keepWei: u(55), minCapitalWei: null });                 // V6
  expect(dca(25, 9, 5).lendWei).toBe(0n);
});

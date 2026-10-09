import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKDROP_URL } from "../src/desk/backdrop.js";
import { clearBackdropCache, dcaPlanReport, rebalanceReport, stockReport, type Built } from "../src/desk/handlers.js";
import { clearHireCache } from "../src/desk/mcp.js";
import type { DeskRequest } from "../src/desk/request.js";
import { analysisFor, clone, compareFor, editedHire, err, fixture, liveResponder, ok, paidOk, rig, type J } from "./helpers.js";

type Req<T extends DeskRequest["type"]> = Extract<DeskRequest, { type: T }>;
const SR = (ticker = "NVDA", usdt: number | null = 500): Req<"stock_report"> => ({ type: "stock_report", ticker, usdt });
const DCA = (o: Partial<Req<"dca_plan">> = {}): Req<"dca_plan"> => ({ type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7, ...o });
const RB = (capital = 150, w: [string, number][] = [["NVDA", 40], ["MSFT", 30], ["SPY", 30]]): Req<"rebalance_plan"> => ({
  type: "rebalance_plan",
  capital,
  weights: w.map(([ticker, weightPct]) => ({ ticker, weightPct })),
});

function noDashes(b: Built): void {
  assert.ok(!/[\u2013\u2014]/.test(b.markdown), "report contains a dash character");
}
function endsWithPlainLink(b: Built): void {
  const lines = b.markdown.trimEnd().split("\n");
  const idx = lines.lastIndexOf("---");
  assert.equal(lines[idx - 2], "https://4lpha.tech/deploy/trading");
}
const has = (b: Built, s: string): void => assert.ok(b.markdown.includes(s), `missing: ${s}\n----\n${b.markdown}`);
const lacks = (b: Built, s: string): void => assert.ok(!b.markdown.includes(s), `unexpected: ${s}`);

beforeEach(() => {
  clearBackdropCache();
  clearHireCache();
});

describe("stock_report", () => {
  it("reads compare then analysis, buys one backdrop, and assembles every section from the fixtures", async () => {
    const r = rig();
    const b = await stockReport(SR(), r.deps);
    assert.deepEqual(r.client.calls.map((c) => c.name), ["stock_compare", "bstock_analysis"]);
    assert.deepEqual(r.client.calls[0]?.args, { ticker: "NVDA", usdt: 500 });
    assert.deepEqual(r.client.calls[1]?.args, { token: "NVDAB" });
    assert.equal(r.buyCalls.length, 1);
    assert.equal(r.buyCalls[0]?.url, BACKDROP_URL);
    for (const s of [
      "# 4lpha bStock Desk: stock report NVDA",
      "## Summary", "## Price, premium and session", "## Technical reading", "## Where to buy", "## Crypto backdrop", "## Risks and flags", "## Data times",
      "Venue price: 236.97 USD", "Premium: close to NAV (23 bps above)", "| RSI (14) | 44.7 | 59.4 |", "nearest stored size 100 USDT",
      "NVDAB (bstock) | 100 | 1 bps | 0 bps | amm", "At 5000 USDT: bstock is the better buy", "BTC: 65000.50 USD", "payment transaction 0x",
      "not investment advice", "Quote comparison (stored quotes): 2026-10-08 06:31 UTC",
    ]) has(b, s);
    assert.equal(b.summaryBy, "template");
    assert.equal(b.backdrop, "paid");
    noDashes(b);
  });

  it("takes the token symbol from the compare answer and never appends a B itself", async () => {
    const r = rig({ respond: liveResponder({ stock_compare: () => ok(compareFor("ACME", (c) => { c.versions[0].symbol = "ACMEX"; })) }) });
    await stockReport(SR("ACME", null), r.deps);
    assert.deepEqual(r.client.calls[1]?.args, { token: "ACMEX" });
  });

  it("an unknown stock stops before any analysis or payment and says so", async () => {
    const r = rig({ respond: liveResponder({ stock_compare: () => err("not_found") }) });
    const b = await stockReport(SR("ZZZZ"), r.deps);
    assert.deepEqual(r.client.calls.map((c) => c.name), ["stock_compare"]);
    assert.equal(r.buyCalls.length, 0);
    has(b, "quote comparison: unavailable (not_found)");
    has(b, "price and session: unavailable (stock_not_found)");
    has(b, "No data was available, so no flag can be raised.");
    assert.equal(b.backdrop, "none");
    noDashes(b);
  });

  it("when the comparison is down it still analyses the symbol it was given, and marks the comparison unavailable", async () => {
    const r = rig({ respond: liveResponder({ stock_compare: () => err("data_unavailable") }) });
    const b = await stockReport(SR("NVDAB", 500), r.deps);
    assert.deepEqual(r.client.calls[1]?.args, { token: "NVDAB" });
    has(b, "quote comparison: unavailable (data_unavailable)");
    has(b, "Venue price: 236.97 USD");
    assert.equal(r.buyCalls.length, 1);
  });

  it("an analysis that fails leaves its sections saying so; the comparison is still delivered", async () => {
    const r = rig({ respond: liveResponder({ bstock_analysis: () => err("not_a_bstock") }) });
    const b = await stockReport(SR(), r.deps);
    has(b, "price and session: unavailable (not_a_bstock)");
    has(b, "indicators: unavailable (not_a_bstock)");
    has(b, "NVDAB (bstock) | 100 | 1 bps");
    lacks(b, "RSI (14) |");
  });

  it("stale indicators print n/a with the reason, never a number", async () => {
    const r = rig({
      respond: liveResponder({
        bstock_analysis: () => ok(analysisFor("NVDAB", (a) => {
          for (const iv of ["15m", "1h"]) {
            a.indicators[iv].staleness = "stale";
            for (const m of Object.values(a.indicators[iv].metrics) as J[]) { m.value = null; m.reason = "stale_input"; }
          }
          a.staleness = "stale";
        })),
      }),
    });
    const b = await stockReport(SR(), r.deps);
    has(b, "| RSI (14) | n/a (stale_input) | n/a (stale_input) |");
    has(b, "No indicator has a value right now");
    has(b, "The token data is stale");
    lacks(b, "RSI 5");
    lacks(b, "momentum is");
  });

  it("section errors and a missing interval are shown as errors", async () => {
    const r = rig({
      respond: liveResponder({
        bstock_analysis: () => ok(analysisFor("NVDAB", (a) => {
          a.indicators["15m"] = { error: "features_pending" };
          delete a.indicators["1h"];
          a.regime = { error: "store_unavailable" };
          a.eligibility = { error: "data_unavailable" };
        })),
      }),
    });
    const b = await stockReport(SR(), r.deps);
    has(b, "15m series: error (features_pending). 1h series: not returned.");
    has(b, "| RSI (14) | error (features_pending) | not returned |");
    has(b, "market regime: unavailable (store_unavailable)");
    has(b, "eligibility for 4lpha's agents: unavailable (data_unavailable)");
  });

  it("failed quote sizes, unreadable verdicts and unchecked exits are spelled out", async () => {
    const r = rig({
      respond: liveResponder({
        stock_compare: () => ok(compareFor("NVDA", (c) => {
          c.sizeNote = "The largest stored size is 5000 USDT; the numbers do not describe a larger amount.";
          c.versions[0].sizes[1] = { ...c.versions[0].sizes[1], ok: false, code: "no_route", costBps: null, roundTripBps: null, route: null };
          c.versions[0].sizes[2] = { ...c.versions[0].sizes[2], roundTripBps: null, code: "sell_failed" };
          c.verdicts[0].avoid = [{ issuer: "ghost", reasons: [] }];
        })),
      }),
    });
    const b = await stockReport(SR(), r.deps);
    has(b, "NVDAB (bstock) | 1000 | no quote (no_route) | n/a | n/a |");
    has(b, "NVDAB (bstock) | 5000 | 2 bps | n/a (sell_failed) | amm |");
    has(b, "At 100 USDT: the verdict could not be read, so nothing is concluded for this size.");
    has(b, "The largest stored size is 5000 USDT");
  });

  it("flags are thresholds on shown numbers: wide premium, closed session, shallow pool, risk off, expensive round trip", async () => {
    const r = rig({
      respond: liveResponder({
        bstock_analysis: () => ok(analysisFor("NVDAB", (a) => {
          a.price.premiumBps = 240;
          a.depth.deepPool = false;
          a.regime = { label: "risk_off", reasons: [], asOf: 1, sessionState: "rth", legs: {}, staleness: "fresh" };
          a.indicators["1h"].metrics.rsi14.value = 78;
          a.eligibility = { eligible: false, reason: "allowlist", source: "x", checkedAt: 1 };
        })),
        stock_compare: () => ok(compareFor("NVDA", (c) => { c.versions[0].sizes[0].roundTripBps = 350; c.versions[0].sizes[0].costBps = 260; })),
      }),
    });
    const b = await stockReport(SR(), r.deps);
    for (const s of ["The premium to NAV is 240 bps", "shallow", "reads risk off", "1h RSI is 78.0", "do not trade this token", "costs 260 bps over the share price", "loses 350 bps", "regular session is not open (overnight)"]) has(b, s);
  });

  describe("the paid backdrop leg", () => {
    it("a capped payment leaves the section out with the reason, the report still delivers", async () => {
      const r = rig({ buy: async () => ({ ok: false, error: "X402BudgetExhaustedError", message: "cap" }) });
      const b = await stockReport(SR(), r.deps);
      has(b, "crypto backdrop: unavailable (X402BudgetExhaustedError)");
      assert.equal(b.backdrop, "capped");
      has(b, "## Price, premium and session");
    });
    it("a failed payment, a thrown error and a missing wallet do the same", async () => {
      const f = await stockReport(SR(), rig({ buy: async () => ({ ok: false, error: "X402RecipientMismatchError", message: "x" }) }).deps);
      has(f, "crypto backdrop: unavailable (X402RecipientMismatchError)");
      const t = await stockReport(SR(), rig({ buy: async () => { throw new Error("locked"); } }).deps);
      has(t, "crypto backdrop: unavailable (Error)");
      const n = await stockReport(SR(), rig({ buy: null }).deps);
      has(n, "crypto backdrop: unavailable (no_wallet_configured)");
    });
    it("paid but unreadable data says the money was spent and the data left out", async () => {
      const b = await stockReport(SR(), rig({ buy: async () => paidOk({ nothing: true }) }).deps);
      has(b, "bought");
      has(b, "its shape was not recognised, so it is left out");
      assert.equal(b.backdrop, "unreadable");
    });
    it("a retried delivery of the same job reuses the paid data point (one payment per job)", async () => {
      const r = rig({ jobKey: "job-77" });
      await stockReport(SR(), r.deps);
      await stockReport(SR(), r.deps);
      assert.equal(r.buyCalls.length, 1);
    });
    it("a different job pays again; a failed attempt is retried on the next try", async () => {
      let n = 0;
      const buy = async () => (++n === 1 ? { ok: false, error: "X402HostNotAllowedError", message: "x" } : paidOk());
      const r = rig({ buy, jobKey: "job-1" });
      await stockReport(SR(), r.deps);
      const b = await stockReport(SR(), r.deps);
      assert.equal(n, 2);
      assert.equal(b.backdrop, "paid");
    });
    it("nothing is bought when no data at all was found", async () => {
      const r = rig({ respond: () => err("data_unavailable") });
      const b = await stockReport(SR("NVDAB"), r.deps);
      assert.equal(r.buyCalls.length, 0);
      lacks(b, "## Crypto backdrop");
      has(b, "Little data was available");
    });
  });

  describe("the model's summary", () => {
    it("is used when it only restates facts, and the prompt holds numbers and labels but no free text or venue names", async () => {
      const r = rig({ llm: async () => "NVDAB trades at 236.97 USD and the 1h RSI is 59.4." });
      const b = await stockReport(SR(), r.deps);
      has(b, "NVDAB trades at 236.97 USD and the 1h RSI is 59.4.");
      assert.equal(b.summaryBy, "model");
      has(b, "Summary written by: the model, from the numbers above.");
      const p = r.llmCalls[0]?.prompt ?? "";
      assert.ok(p.startsWith("FACTS:"));
      assert.ok(p.includes("venue price USD: 236.97"));
      for (const s of ["Kipseli", "Elfomofi", "Tessera", "allowlist", "note"]) assert.ok(!p.includes(s), s);
    });
    it("is replaced by the template when it invents a number, and dashes never reach the report", async () => {
      const r = rig({ llm: async () => "Strong at 999 USD \u2014 buy." });
      const b = await stockReport(SR(), r.deps);
      assert.equal(b.summaryBy, "template");
      lacks(b, "999");
      noDashes(b);
      const r2 = rig({ llm: async () => "The price is 236.97 USD \u2014 close to NAV." });
      const b2 = await stockReport(SR(), r2.deps);
      has(b2, "The price is 236.97 USD - close to NAV.");
      noDashes(b2);
    });
  });
});

describe("dca_plan: dca mode", () => {
  it("reads the hire limits first, then compares at the budget, then the token's analysis", async () => {
    const r = rig();
    const b = await dcaPlanReport(DCA(), r.deps);
    assert.deepEqual(r.client.calls.map((c) => [c.name, c.args]), [
      ["get_hire_link", { agent: "agentic-dca" }],
      ["stock_compare", { ticker: "NVDAB", usdt: 200 }],
      ["bstock_analysis", { token: "NVDAB" }],
    ]);
    for (const s of [
      "| Base order | 80.00 USDT |", "| Max DCA orders | 3 |", "| DCA order size | 40.00 USDT |", "| Total delegated | 200.00 USDT |",
      "| Price drop step | 1.5 % | 1h ATR is 1.40 % of price, rounded to 0.5 |", "| Take profit | 1.5 % |", "| Stop loss (optional) | 7 % of the total |",
      "| DCA 3 | 5.46 % | 224.03 | 200.00 |", "10 transaction slots (2 x 3 orders + 4) x 0.0004 BNB = 0.0040 BNB", "200.20", "Mode tile: \"Auto DCA\"",
      "Hire limits read from 4lpha's get_hire_link", "Suggested values: stock NVDAB, base 80.00, orders 3 x 40.00",
    ]) has(b, s);
    noDashes(b);
    endsWithPlainLink(b);
    assert.equal(r.buyCalls.length, 1);
  });

  it("a 30-day term uses the 30-day keep-alive amount", async () => {
    const b = await dcaPlanReport(DCA({ days: 30 }), rig().deps);
    has(b, "plus 0.80 for keeping the Binance session alive over 30 days: 200.80");
  });

  it("minimums come from the live hire link: a raised base minimum changes the plan and the refusal", async () => {
    const hire = editedHire("agentic-dca", "Base order at least 25 USDT", "Base order at least 30 USDT");
    const r = rig({ respond: liveResponder({ get_hire_link: () => ok(hire) }) });
    const low = await dcaPlanReport(DCA({ usdt: 39 }), r.deps);
    has(low, "below the Auto DCA minimum of 40.00 USDT");
    lacks(low, "## Plan (Auto DCA)");
    endsWithPlainLink(low);
    const fit = await dcaPlanReport(DCA({ usdt: 40 }), rig({ respond: liveResponder({ get_hire_link: () => ok(hire) }) }).deps);
    has(fit, "| Base order | 30.00 USDT |");
  });

  it("a budget under the minimum gets no plan, but the report still carries data and the link", async () => {
    const b = await dcaPlanReport(DCA({ usdt: 20 }), rig().deps);
    has(b, "below the Auto DCA minimum of 35.00 USDT");
    has(b, "## Where to buy");
    endsWithPlainLink(b);
  });

  it("a stock outside the accepted list gets no DCA plan and names the list", async () => {
    const r = rig();
    const b = await dcaPlanReport(DCA({ ticker: "AMD" }), r.deps);
    has(b, "AMDB is not one of the 17 stocks Auto DCA accepts");
    lacks(b, "## Plan (Auto DCA)");
  });

  it("a missing ATR uses the form minimum and says why; an extreme ATR is clamped to the ceiling", async () => {
    const stale = rig({ respond: liveResponder({ bstock_analysis: () => ok(analysisFor("NVDAB", (a) => { a.indicators["1h"] = { error: "features_pending" }; })) }) });
    const s = await dcaPlanReport(DCA(), stale.deps);
    has(s, "the 1h ATR was unavailable (stale or missing), so the form minimum 1 % is used");
    has(s, "| Price drop step | 1.0 % |");
    const wild = rig({ respond: liveResponder({ bstock_analysis: () => ok(analysisFor("NVDAB", (a) => { a.indicators["1h"].metrics.atrPct.value = 40; })) }) });
    const w = await dcaPlanReport(DCA(), wild.deps);
    has(w, "| Price drop step | 24.5 % | 1h ATR is 40.00 % of price, rounded to 0.5, clamped to 1 to 24.5 % (the ceiling for 3 orders) |");
  });

  it("without the analysis the plan still builds (relative levels, no prices) and says the ATR is missing", async () => {
    const r = rig({ respond: liveResponder({ bstock_analysis: () => err("data_unavailable") }) });
    const b = await dcaPlanReport(DCA(), r.deps);
    has(b, "| Base | 0.00 % | n/a | 80.00 |");
    has(b, "price and session: unavailable (data_unavailable)");
    has(b, "the 1h ATR was unavailable (data_unavailable)");
  });

  it("an unreadable hire link falls back to built-in limits and says so", async () => {
    const r = rig({ respond: liveResponder({ get_hire_link: () => err("network") }) });
    const b = await dcaPlanReport(DCA(), r.deps);
    has(b, "The live hire limits could not be read (network); built-in limits from 2026-10-08 are used");
    has(b, "| Base order | 80.00 USDT |");
    endsWithPlainLink(b);
  });

  it("a hire entry marked unavailable is flagged, and a foreign Deploy link is replaced by the plain one", async () => {
    const hire = editedHire("agentic-dca", '"status":"available"', '"status":"unavailable"');
    const evil = JSON.parse(JSON.stringify(hire).replace("https://4lpha.tech/deploy/trading", "https://evil.example/pay")) as J;
    const b = await dcaPlanReport(DCA(), rig({ respond: liveResponder({ get_hire_link: () => ok(evil) }) }).deps);
    has(b, "4lpha shows agentic-dca as not offered right now");
    lacks(b, "evil.example");
    endsWithPlainLink(b);
  });

  it("an unknown stock stops before analysis and payment", async () => {
    const r = rig({ respond: liveResponder({ stock_compare: () => err("not_found") }) });
    const b = await dcaPlanReport(DCA({ ticker: "ZZZZ" }), r.deps);
    has(b, "plan: unavailable (stock_not_found)");
    assert.ok(!r.client.calls.some((c) => c.name === "bstock_analysis"));
    assert.equal(r.buyCalls.length, 0);
    endsWithPlainLink(b);
  });

  it("flags and the stop loss warning are in the risks", async () => {
    const b = await dcaPlanReport(DCA(), rig().deps);
    has(b, "A DCA stop loss ends the agent and sells nothing");
  });
});

describe("dca_plan: schedule mode", () => {
  it("uses the Schedule limits and lays out every frequency", async () => {
    const r = rig();
    const b = await dcaPlanReport(DCA({ mode: "schedule", ticker: "NVDA" }), r.deps);
    assert.deepEqual(r.client.calls[0]?.args, { agent: "agentic-schedule" });
    for (const s of [
      "## Plan (Schedule buy)", "| 1 hour | 168 | 1.19 | 199.92 | no (under 5 USDT per buy) |", "| Daily | 7 | 28.57 | 199.99 | yes |",
      "Recommended: Daily, 7 buys of 28.57 USDT", "10 transaction slots (1 + 2 + 7 buys) x 0.0004 BNB = 0.0040 BNB", "Mode tile: \"Schedule buy\"",
      "one every day", "A Schedule buy never sells",
    ]) has(b, s);
    noDashes(b);
    endsWithPlainLink(b);
  });
  it("a budget below one buy plus the reserve is refused with the minimum from the link", async () => {
    const b = await dcaPlanReport(DCA({ mode: "schedule", usdt: 5 }), rig().deps);
    has(b, "needs at least 5.25 USDT");
    lacks(b, "## Plan (Schedule buy)");
    endsWithPlainLink(b);
  });
  it("does not apply the 17-stock list to a Schedule buy", async () => {
    const b = await dcaPlanReport(DCA({ mode: "schedule", ticker: "AMD" }), rig().deps);
    has(b, "## Plan (Schedule buy)");
  });
});

describe("rebalance_plan", () => {
  it("reads the portfolio limits, compares each stock at its allocation, checks every rule", async () => {
    const r = rig();
    const b = await rebalanceReport(RB(), r.deps);
    assert.deepEqual(r.client.calls.map((c) => [c.name, c.args]), [
      ["get_hire_link", { agent: "agentic-portfolio" }],
      ["stock_compare", { ticker: "NVDA", usdt: 60 }],
      ["stock_compare", { ticker: "MSFT", usdt: 45 }],
      ["stock_compare", { ticker: "SPY", usdt: 45 }],
    ]);
    for (const s of [
      "| NVDA | 40 % | 60.00 | NVDAB | 100 | 1 bps | 0 bps | about the same |", "| SPY | 30 % | 45.00 | SPYB |",
      "| capital at least 75 USDT (50 for 2 stocks plus 25 per extra stock) | pass | 150 USDT given for 3 stocks |", "All rules pass: this basket can be deployed as given.",
      "Suggested drift threshold: 1.0 %", "8 transaction slots (2 x 3 stocks + 2) x 0.0004 BNB = 0.0032 BNB", "Mode tile: \"Smart Portfolio\"", "drift 1.0 %",
    ]) has(b, s);
    noDashes(b);
    endsWithPlainLink(b);
    assert.equal(r.buyCalls.length, 1);
  });

  it("each failed rule is named and the plan says it is not deployable as given", async () => {
    const b = await rebalanceReport(RB(60, [["NVDA", 91], ["MSFT", 9], ["AMD", 0.5]]), rig().deps);
    has(b, "Not deployable as given");
    has(b, "| each weight at least 10 % | FAIL | lowest is 0.5 % |");
    has(b, "| weights add up to 100 % | FAIL | sum is 100.5 % |");
    has(b, "| every stock is one the hosted agent accepts | FAIL | not accepted: AMD |");
    has(b, "The minimum capital for 3 stocks is 75 USDT");
    endsWithPlainLink(b);
  });

  it("the same stock under two names is caught after resolution", async () => {
    const b = await rebalanceReport(RB(150, [["NVDA", 50], ["NVDAB", 50]]), rig().deps);
    has(b, "| no stock twice | FAIL | NVDA appears under two names |");
  });

  it("a stock whose quote cannot be read shows unavailable, is not guessed, and the rule cannot be checked", async () => {
    const r = rig({ respond: liveResponder({ stock_compare: (a) => (a.ticker === "MSFT" ? err("data_unavailable") : ok(compareFor(String(a.ticker)))) }) });
    const b = await rebalanceReport(RB(), r.deps);
    has(b, "| MSFT | 30 % | 45.00 | n/a | n/a | n/a | n/a | unavailable (data_unavailable) |");
    has(b, "could not be checked: MSFT");
    has(b, "from 2 of 3 stocks");
    has(b, "Quote comparison MSFT: unknown");
  });

  it("with no exit cost at all there is no drift suggestion and no invented one; with no data nothing is bought", async () => {
    const r = rig({ respond: liveResponder({ stock_compare: () => err("data_unavailable") }) });
    const b = await rebalanceReport(RB(), r.deps);
    has(b, "drift threshold suggestion: unavailable (no_exit_cost_data)");
    assert.equal(r.buyCalls.length, 0);
    lacks(b, "Suggested drift threshold");
    endsWithPlainLink(b);
  });

  it("the drift suggestion follows the worst round trip of the basket", async () => {
    const r = rig({
      respond: liveResponder({
        stock_compare: (a) => ok(compareFor(String(a.ticker), (c) => { if (a.ticker === "SPY") c.versions[0].sizes[0].roundTripBps = 61; })),
      }),
    });
    const b = await rebalanceReport(RB(), r.deps);
    has(b, "Suggested drift threshold: 3.5 %");
    has(b, "worst round trip loss in the basket (61 bps)");
  });

  it("an allocation under 1 USDT is compared without an amount instead of an invalid one", async () => {
    const r = rig();
    await rebalanceReport(RB(1.5, [["NVDA", 50], ["MSFT", 50]]), r.deps);
    assert.deepEqual(r.client.calls[1]?.args, { ticker: "NVDA" });
  });

  it("minimum capital follows the live limit", async () => {
    const hire = editedHire("agentic-portfolio", "Total capital at least 50 USDT for 2 stocks plus 25 USDT for each extra stock", "Total capital at least 80 USDT for 2 stocks plus 25 USDT for each extra stock");
    const r = rig({ respond: liveResponder({ get_hire_link: () => ok(hire) }) });
    const b = await rebalanceReport(RB(100), r.deps);
    has(b, "capital at least 105 USDT (80 for 2 stocks plus 25 per extra stock) | FAIL");
  });

  it("a basket of eight is shown with its allocations and fails the stock-count rule", async () => {
    const names = ["NVDA", "MSFT", "SPY", "QQQ", "TSLA", "GOOGL", "META", "AMD"];
    const b = await rebalanceReport(RB(1000, names.map((n) => [n, 12.5] as [string, number])), rig().deps);
    has(b, "| 2 to 5 stocks | FAIL | 8 given |");
    has(b, "| NVDA | 12.5 % | 125.00 |");
  });
});

describe("every report", () => {
  it("never contains an em or en dash, even when the data does", async () => {
    const dashy = clone(fixture("compare-NVDA-500")) as J;
    dashy.sizeNote = "Note \u2014 with a dash \u2013 here";
    const r = rig({ respond: liveResponder({ stock_compare: () => ok(dashy) }) });
    const b = await stockReport(SR(), r.deps);
    noDashes(b);
  });
});

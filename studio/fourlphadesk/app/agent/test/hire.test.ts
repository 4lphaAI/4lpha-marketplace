import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_STOCKS, builtInHireLimits, DEFAULT_DEPLOY_URL, readHireLimits } from "../src/desk/hire.js";
import { editedHire, fixture } from "./helpers.js";

describe("readHireLimits: live fixtures (saved 2026-10-08)", () => {
  it("reads every Auto DCA limit from its sentence", () => {
    const l = readHireLimits("agentic-dca", fixture("hire-agentic-dca"));
    assert.deepEqual(l.builtIn, []);
    assert.equal(l.available, true);
    assert.deepEqual(
      { ...l.values },
      { baseMin: 25, orderMin: 10, maxOrders: 8, stepMin: 1, stepMax: 30, tpMin: 1.5, bnbPerSlot: 0.0004, keepAlive7: 0.2, keepAlive30: 0.8, earnMinOrders: 5, dailyMultiple: 10, x402Daily: 0.5 },
    );
    assert.equal(l.stocks?.length, 17);
    assert.ok(l.stocks?.includes("NVDAB") && l.stocks?.includes("SNDKB"));
    assert.equal(l.deployUrl, "https://4lpha.tech/deploy/trading");
  });
  it("reads every Schedule limit including the frequencies", () => {
    const l = readHireLimits("agentic-schedule", fixture("hire-agentic-schedule"));
    assert.deepEqual(l.builtIn, []);
    assert.deepEqual({ ...l.values }, { buyMin: 5, reservePct: 5, runsMax: 1000, bnbPerSlot: 0.0004, dailyMultiple: 2 });
    assert.deepEqual(l.intervalsHours, [1, 4, 8, 12, 24]);
    assert.equal(l.stocks, null);
  });
  it("reads every Smart Portfolio limit", () => {
    const l = readHireLimits("agentic-portfolio", fixture("hire-agentic-portfolio"));
    assert.deepEqual(l.builtIn, []);
    assert.deepEqual(
      { ...l.values },
      { stocksMin: 2, stocksMax: 5, weightMin: 10, capBase: 50, capBaseStocks: 2, capPerExtra: 25, driftMin: 0.5, driftMax: 15, driftStep: 0.5, bnbPerSlot: 0.0004, keepAlive7: 0.2, keepAlive30: 0.8, dailyMultiple: 10, x402Daily: 0.5 },
    );
    assert.equal(l.stocks?.length, 17);
    assert.deepEqual(l.intervalsHours, [4, 8, 12, 24]);
  });
  it("carries the Binance App settings the Deploy check verifies, per agent", () => {
    const dca = readHireLimits("agentic-dca", fixture("hire-agentic-dca"));
    assert.equal(dca.binanceApp.length, 5);
    assert.ok(dca.binanceApp.some((l) => l.includes("Daily limit of at least 10 x the capital")));
    assert.ok(dca.binanceApp.some((l) => l.includes("x402 daily limit of at least 0.50 USDT")));
    const sch = readHireLimits("agentic-schedule", fixture("hire-agentic-schedule"));
    assert.equal(sch.binanceApp.length, 4);
    assert.ok(sch.binanceApp.some((l) => l.includes("Daily limit of at least 2 x the capital")));
    assert.ok(!sch.binanceApp.some((l) => /x402/i.test(l)));
    assert.equal(readHireLimits("agentic-portfolio", fixture("hire-agentic-portfolio")).binanceApp.length, 5);
  });
  it("built-in Binance App settings are used, and listed as built-in, when the link has none", () => {
    const l = builtInHireLimits("agentic-schedule");
    assert.equal(l.binanceApp.length, 4);
    assert.ok(l.builtIn.includes("binanceApp"));
  });
});

describe("readHireLimits: honours what the link says, falls back when it cannot be read", () => {
  it("a changed minimum is picked up (the plan follows the live limit)", () => {
    const l = readHireLimits("agentic-dca", editedHire("agentic-dca", "Base order at least 25 USDT", "Base order at least 30 USDT"));
    assert.equal(l.values.baseMin, 30);
    assert.ok(l.fromLink.includes("baseMin"));
  });
  it("an implausible value falls back to the built-in constant and is listed", () => {
    const l = readHireLimits("agentic-dca", editedHire("agentic-dca", "Base order at least 25 USDT", "Base order at least 5000 USDT"));
    assert.equal(l.values.baseMin, 25);
    assert.ok(l.builtIn.includes("baseMin"));
  });
  it("a number that must be a whole number but is not falls back instead of reaching BigInt (review H1 trigger)", () => {
    const l = readHireLimits("agentic-dca", editedHire("agentic-dca", "max DCA orders 1 to 8", "max DCA orders 1 to 1.5"));
    assert.equal(l.values.maxOrders, 8);
    assert.ok(l.builtIn.includes("maxOrders"));
    const s = readHireLimits("agentic-schedule", editedHire("agentic-schedule", "1 to 1000 runs", "1 to 12.5 runs"));
    assert.equal(s.values.runsMax, 1000);
    assert.ok(s.builtIn.includes("runsMax"));
    const p = readHireLimits("agentic-portfolio", editedHire("agentic-portfolio", "2 to 5 stocks from", "2 to 5.5 stocks from"));
    assert.equal(p.values.stocksMax, 5);
    assert.ok(p.builtIn.includes("stocksMax"));
    const c = readHireLimits("agentic-portfolio", editedHire("agentic-portfolio", "at least 50 USDT for 2 stocks plus", "at least 50 USDT for 2.5 stocks plus"));
    assert.equal(c.values.capBaseStocks, 2);
    assert.ok(c.builtIn.includes("capBaseStocks"));
  });
  it("a sentence that no longer matches falls back and is listed", () => {
    const l = readHireLimits("agentic-dca", editedHire("agentic-dca", "Take profit at least 1.5 %", "Take profit is flexible"));
    assert.equal(l.values.tpMin, 1.5);
    assert.ok(l.builtIn.includes("tpMin"));
  });
  it("null data gives the built-in set, unavailable, default link", () => {
    const l = builtInHireLimits("agentic-portfolio");
    assert.equal(l.available, false);
    assert.equal(l.deployUrl, DEFAULT_DEPLOY_URL);
    assert.deepEqual(l.stocks, [...BUILT_IN_STOCKS]);
    assert.ok(l.builtIn.includes("capBase") && l.builtIn.includes("stocks"));
  });
  it("status unavailable is reported", () => {
    const l = readHireLimits("agentic-dca", editedHire("agentic-dca", '"status":"available"', '"status":"unavailable"'));
    assert.equal(l.available, false);
  });
  it("only a 4lpha.tech link is accepted as the Deploy link", () => {
    for (const badUrl of ["https://evil.example/deploy", "http://4lpha.tech/deploy", "https://4lpha.tech/x y", "javascript:alert(1)", "https://4lpha.tech.evil.example/x"]) {
      const l = readHireLimits("agentic-dca", editedHire("agentic-dca", "https://4lpha.tech/deploy/trading", badUrl));
      assert.equal(l.deployUrl, DEFAULT_DEPLOY_URL, badUrl);
    }
  });
  it("a stock list that is too short falls back", () => {
    const l = readHireLimits(
      "agentic-dca",
      editedHire("agentic-dca", "NVDAB, SPCXB, BABAB, TSLAB, QQQB, GOOGLB, CRCLB, SKHYB, METAB, MSFTB, TSMB, SPYB, INTCB, MSTRB, HOODB, SOXLB, SNDKB", "NVDAB"),
    );
    assert.deepEqual(l.stocks, [...BUILT_IN_STOCKS]);
    assert.ok(l.builtIn.includes("stocks"));
  });
});

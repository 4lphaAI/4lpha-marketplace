/** AGENTIC-RFQ-STOCKS 4.11 (E11, OQ-9): the 26 RFQ-only underlyings in the CMC ticker map; the planning pick and its caps are the existing ones. */
import assert from "node:assert/strict";
import test from "node:test";
import { PLANNING_CAP_PER_WINDOW, US_EQUITY_TICKER_CLASS, planningWindowStartMs, selectPlanningTicker, tickerClass } from "../src/trade/cmcUsEquity.js";

const STOCKS = ["AAOI", "AMD", "ARM", "AVGO", "AXTI", "COHR", "COIN", "CRDO", "CRWV", "GLW", "IBM", "LITE", "NBIS", "PLTR", "PYPL", "QCOM", "RKLB", "WDC"];
const ETFS = ["DRAM", "EWY", "INTW", "KORU", "MUU", "MVLL"];
const UNRESOLVABLE = ["CBRS", "QNT"];

test("the 26 tickers classify as listed: 18 stocks with no invented sector, 6 ETFs (no planning call), CBRS and QNT unresolvable (no paid call on an unmeasured symbol)", () => {
  for (const ticker of STOCKS) assert.deepEqual(tickerClass(ticker), { kind: "stock", sector: null, theme: null }, ticker);
  for (const ticker of ETFS) assert.deepEqual(tickerClass(ticker), { kind: "etf" }, ticker);
  for (const ticker of UNRESOLVABLE) assert.deepEqual(tickerClass(ticker), { kind: "unresolvable" }, ticker);
  assert.equal(STOCKS.length + ETFS.length + UNRESOLVABLE.length, 26);
  assert.equal(Object.keys(US_EQUITY_TICKER_CLASS).length, 28 + 26);
  assert.deepEqual(tickerClass("nvda"), { kind: "stock", sector: "Information Technology", theme: "Semiconductors" }, "the existing entries are untouched");
});

test("selectPlanningTicker with an RFQ-only shortlist picks an RFQ ticker; held tickers stay first; ETFs and unresolvable symbols are never picked", () => {
  const nowMs = Date.UTC(2026, 9, 2, 15, 45, 0);
  assert.equal(selectPlanningTicker({ heldTickers: [], shortlistedTickers: ["AMD", "IBM"], rows: [], nowMs }), "AMD");
  assert.equal(selectPlanningTicker({ heldTickers: ["IBM"], shortlistedTickers: ["AMD"], rows: [], nowMs }), "IBM");
  assert.equal(selectPlanningTicker({ heldTickers: [], shortlistedTickers: ["MUU", "CBRS", "QNT", "KORU"], rows: [], nowMs }), null);
  assert.equal(selectPlanningTicker({ heldTickers: [], shortlistedTickers: ["MUU", "COIN"], rows: [], nowMs }), "COIN");
});

test("the planning cap per window is unchanged (5), counted across tickers", () => {
  const nowMs = Date.UTC(2026, 9, 2, 15, 45, 0), windowStart = planningWindowStartMs(nowMs);
  assert.equal(PLANNING_CAP_PER_WINDOW, 5);
  const rows = ["AMD", "ARM", "AVGO", "COIN", "IBM"].map((ticker) => ({ ticker, sessionDate: null, lastActivityMs: windowStart + 1 }));
  assert.equal(selectPlanningTicker({ heldTickers: [], shortlistedTickers: ["PLTR"], rows, nowMs }), null);
  assert.equal(selectPlanningTicker({ heldTickers: [], shortlistedTickers: ["PLTR"], rows: rows.slice(0, 4), nowMs }), "PLTR");
});

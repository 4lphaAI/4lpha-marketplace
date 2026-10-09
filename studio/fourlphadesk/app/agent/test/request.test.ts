import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRaw, FORMATS_NOTE, formatsNoteWithReason, validateRequest } from "../src/desk/request.js";

const bad = (x: unknown): string => {
  const r = validateRequest(x as never);
  assert.equal(r.ok, false, JSON.stringify(x));
  return r.ok ? "" : r.reason;
};

describe("validateRequest: stock_report", () => {
  it("accepts ticker only and ticker with usdt, upper-casing the ticker", () => {
    assert.deepEqual(validateRequest({ type: "stock_report", ticker: "nvda" }), { ok: true, request: { type: "stock_report", ticker: "NVDA", usdt: null } });
    assert.deepEqual(validateRequest({ type: "stock_report", ticker: "NVDAB", usdt: 500 }), { ok: true, request: { type: "stock_report", ticker: "NVDAB", usdt: 500 } });
    assert.equal(validateRequest({ type: "stock_report", ticker: "GOOGLon", usdt: 1 }).ok, true);
  });
  it("rejects bad tickers, bad amounts and extra fields", () => {
    for (const ticker of ["", "NVDA1", "NV DA", "ABCDEFGHI", "NVDA;", 5, null]) bad({ type: "stock_report", ticker });
    for (const usdt of [0, 0.99, 1_000_001, -5, "500", null, NaN, Infinity]) bad({ type: "stock_report", ticker: "NVDA", usdt });
    assert.match(bad({ type: "stock_report", ticker: "NVDA", note: "x" }), /unknown field/);
  });
  it("accepts the limits exactly", () => {
    assert.equal(validateRequest({ type: "stock_report", ticker: "A", usdt: 1 }).ok, true);
    assert.equal(validateRequest({ type: "stock_report", ticker: "A", usdt: 1_000_000 }).ok, true);
  });
});

describe("validateRequest: dca_plan", () => {
  it("defaults mode to dca and days to 7", () => {
    assert.deepEqual(validateRequest({ type: "dca_plan", ticker: "NVDAB", usdt: 200 }), {
      ok: true,
      request: { type: "dca_plan", ticker: "NVDAB", usdt: 200, mode: "dca", days: 7 },
    });
  });
  it("accepts schedule and 30 days", () => {
    const r = validateRequest({ type: "dca_plan", ticker: "NVDA", usdt: 200, mode: "schedule", days: 30 });
    assert.ok(r.ok && r.request.type === "dca_plan" && r.request.mode === "schedule" && r.request.days === 30);
  });
  it("rejects bad mode, days, missing budget", () => {
    bad({ type: "dca_plan", ticker: "NVDA", usdt: 200, mode: "grid" });
    for (const days of [1, 14, 365, "7", null]) bad({ type: "dca_plan", ticker: "NVDA", usdt: 200, days });
    bad({ type: "dca_plan", ticker: "NVDA" });
    bad({ type: "dca_plan", ticker: "NVDA", usdt: 0 });
    bad({ type: "dca_plan", ticker: "NVDA", usdt: 200, levels: 5 });
  });
});

describe("validateRequest: rebalance_plan", () => {
  const ok = { type: "rebalance_plan", capital: 150, weights: { NVDA: 40, MSFT: 30, SPY: 30 } };
  it("accepts the documented example and upper-cases the tickers", () => {
    const r = validateRequest({ ...ok, weights: { nvda: 40, msft: 30, spy: 30 } });
    assert.ok(r.ok && r.request.type === "rebalance_plan");
    if (r.ok && r.request.type === "rebalance_plan") assert.deepEqual(r.request.weights.map((w) => w.ticker), ["NVDA", "MSFT", "SPY"]);
  });
  it("rejects shapes that are not a 2 to 8 stock map of positive numbers", () => {
    bad({ ...ok, weights: { NVDA: 100 } });
    bad({ ...ok, weights: Object.fromEntries("ABCDEFGHI".split("").map((k) => [k, 10])) });
    bad({ ...ok, weights: { NVDA: 0, MSFT: 100 } });
    bad({ ...ok, weights: { NVDA: 101, MSFT: 1 } });
    bad({ ...ok, weights: { NVDA: "40", MSFT: 60 } });
    bad({ ...ok, weights: { NVDA: -5, MSFT: 105 } });
    bad({ ...ok, weights: { "NV DA": 50, MSFT: 50 } });
    bad({ ...ok, weights: [40, 60] });
    bad({ ...ok, weights: null });
    bad({ ...ok, capital: 0 });
    bad({ ...ok, capital: "150" });
    bad({ type: "rebalance_plan", weights: ok.weights });
  });
  it("rejects the same stock twice (case-insensitive)", () => {
    assert.match(bad({ ...ok, weights: { NVDA: 50, nvda: 50 } }), /twice/);
  });
  it("leaves rule failures (sum, minimum weight) to the plan, not to the schema", () => {
    assert.equal(validateRequest({ ...ok, weights: { NVDA: 90, MSFT: 5 } }).ok, true);
  });
});

describe("validateRequest: type", () => {
  it("rejects unknown and missing types and non-objects", () => {
    for (const x of [{ type: "grid_plan" }, {}, null, [], "stock_report", 5, { type: "STOCK_REPORT", ticker: "A" }]) bad(x);
  });
});

describe("extractRaw", () => {
  it("reads a JSON object from the task", () => {
    assert.equal(extractRaw('{"type":"stock_report","ticker":"NVDA"}', null).kind, "json");
  });
  it("finds a JSON object inside prose", () => {
    assert.equal(extractRaw('Hello, please run {"type":"stock_report","ticker":"NVDA"} thanks', null).kind, "json");
  });
  it("falls back to terms.deliverables (string or object)", () => {
    assert.equal(extractRaw("see terms", { deliverables: '{"type":"stock_report","ticker":"NVDA"}' }).kind, "json");
    assert.equal(extractRaw("see terms", { deliverables: { type: "stock_report", ticker: "NVDA" } }).kind, "json");
  });
  it("returns text for plain English, empty for nothing", () => {
    assert.deepEqual(extractRaw("analyse NVDA with 500 USDT", null), { kind: "text", text: "analyse NVDA with 500 USDT" });
    assert.deepEqual(extractRaw("   ", null), { kind: "empty" });
    assert.equal(extractRaw("[1,2,3]", null).kind, "text");
  });
  it("caps the amount of text it keeps", () => {
    const r = extractRaw("x".repeat(100_000), null);
    assert.ok(r.kind === "text" && r.text.length <= 4000);
  });
});

describe("accepted formats note", () => {
  it("names the three job types, the price and the not-advice line, with no em dash", () => {
    for (const s of ["stock_report", "dca_plan", "rebalance_plan", "0.10 USD", "not investment advice"]) assert.ok(FORMATS_NOTE.includes(s), s);
    assert.ok(!/[\u2013\u2014]/.test(FORMATS_NOTE));
  });
  it("adds a sanitised reason", () => {
    const n = formatsNoteWithReason('unknown field "x\n[evil](http://a)"');
    assert.ok(n.includes("Reason: unknown field"));
    assert.ok(!n.includes("](http"));
  });
});

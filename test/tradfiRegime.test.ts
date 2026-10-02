import assert from "node:assert/strict";
import test from "node:test";
import { HttpTradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import { blendRegime } from "../src/trade/score.js";

test("usEquityRegime parses a well-formed envelope", async () => {
  const client = new HttpTradeDataPlaneReads({
    baseUrl: "https://data.example/",
    fetch: async () => Response.json({ data: { regime: "risk_on", reasons: ["spy-up"], asOf: 123 } }),
  });
  const result = await client.usEquityRegime!();
  assert.deepEqual(result, { regime: "risk_on", reasons: ["spy-up"], asOf: 123 });
});

test("usEquityRegime degrades to unavailable on 404", async () => {
  const client = new HttpTradeDataPlaneReads({
    baseUrl: "https://data.example/",
    fetch: async () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
  });
  const result = await client.usEquityRegime!();
  assert.equal(result.regime, "unavailable");
});

test("usEquityRegime degrades to unavailable on a network error", async () => {
  const client = new HttpTradeDataPlaneReads({
    baseUrl: "https://data.example/",
    fetch: async () => { throw new Error("boom"); },
  });
  const result = await client.usEquityRegime!();
  assert.equal(result.regime, "unavailable");
});

test("usEquityRegime degrades to unavailable when meta.staleness is dead", async () => {
  const client = new HttpTradeDataPlaneReads({
    baseUrl: "https://data.example/",
    fetch: async () => Response.json({ data: { regime: "risk_on", reasons: [], asOf: 1 }, meta: { staleness: "dead" } }),
  });
  const result = await client.usEquityRegime!();
  assert.equal(result.regime, "unavailable");
});

test("usEquityRegime degrades to unavailable on a malformed envelope", async () => {
  const client = new HttpTradeDataPlaneReads({
    baseUrl: "https://data.example/",
    fetch: async () => Response.json({ data: { regime: "not-a-regime" } }),
  });
  const result = await client.usEquityRegime!();
  assert.equal(result.regime, "unavailable");
});

test("blendRegime: equity wins when available", () => {
  assert.equal(blendRegime("risk_on", "risk_off"), "risk_on");
  assert.equal(blendRegime("neutral", "risk_off"), "neutral");
});

test("blendRegime: crypto alone can only move neutral to risk_off", () => {
  assert.equal(blendRegime("unavailable", "risk_off"), "risk_off");
  assert.equal(blendRegime("unavailable", "risk_on"), "neutral");
  assert.equal(blendRegime("unavailable", "neutral"), "neutral");
});

test("blendRegime: both unavailable stays unavailable", () => {
  assert.equal(blendRegime("unavailable", "unavailable"), "unavailable");
});

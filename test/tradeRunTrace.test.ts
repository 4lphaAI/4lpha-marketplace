import assert from "node:assert/strict";
import { it } from "node:test";
import { normalizeTradeRunEvents } from "../src/store/tradeRunTrace.js";

it("trace projection bounds history and drops unknown fields, malformed values and secrets", () => {
  const rows = normalizeTradeRunEvents(Array.from({ length: 150 }, () => ({
    stage: "entry-llm", code: "selected", elapsedMs: -4, confidence: 101,
    token: "not-an-address", secret: "must-not-survive", prompt: "must-not-survive",
    reason: `api_key=credential123 https://rpc.example/secret ${"x".repeat(500)}`,
  })));
  assert.equal(rows.length, 100);
  assert.equal(rows[0]?.elapsedMs, 0);
  assert.equal(rows[0]?.confidence, undefined);
  assert.equal(rows[0]?.token, undefined);
  assert.ok((rows[0]?.reason?.length ?? 999) <= 280);
  assert.doesNotMatch(JSON.stringify(rows), /credential123|rpc.example|must-not-survive/);
  assert.deepEqual(normalizeTradeRunEvents(null), []);
  assert.deepEqual(normalizeTradeRunEvents([null, { stage: "unknown", code: "x" }]), []);
});

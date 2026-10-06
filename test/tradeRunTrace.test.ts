import assert from "node:assert/strict";
import { it } from "node:test";
import { appendTradeRunEvent, isUnknownSubmissionEvent, normalizeTradeRunEvents, type TradeRunEvent } from "../src/store/tradeRunTrace.js";

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

it("AGENTIC-RECEIPT-WAIT F2: isUnknownSubmissionEvent and the 100-event cap", () => {
  const ev = (stage: TradeRunEvent["stage"], code: string): TradeRunEvent => ({ stage, code, elapsedMs: 0 });
  assert.deepEqual([ev("buy", "unknown"), ev("sell", "unknown"), ev("cycle", "unknown"), ev("buy", "committed"), ev("buy", "AGENTIC_WALLET_OBLIGATION")].map(isUnknownSubmissionEvent), [true, true, false, false, false]);
  const plain = (n: number): TradeRunEvent[] => Array.from({ length: n }, (_, i) => ev("score", `s${i}`));
  const below = plain(99);
  appendTradeRunEvent(below, [ev("buy", "unknown")]);
  assert.equal(below.length, 100); assert.equal(below[99]!.code, "unknown");
  const full = plain(100);
  appendTradeRunEvent(full, [ev("score", "dropped")]);
  assert.equal(full.length, 100); assert.equal(full.some((e) => e.code === "dropped"), false);
  appendTradeRunEvent(full, [ev("buy", "unknown")]);
  assert.equal(full.length, 100); assert.equal(full[99]!.code, "unknown");
  // a second marker takes the next non-buy/sell slot; the first is never overwritten
  appendTradeRunEvent(full, [ev("sell", "unknown")]);
  assert.deepEqual([full[98]!.stage, full[98]!.code, full[99]!.stage, full[99]!.code], ["sell", "unknown", "buy", "unknown"]);
  // a marker at slot 5 survives 200 later plain events
  const early = plain(5);
  appendTradeRunEvent(early, [ev("sell", "unknown")]);
  for (let i = 0; i < 200; i += 1) appendTradeRunEvent(early, [ev("score", `later${i}`)]);
  assert.equal(early.length, 100); assert.equal(early[5]!.code, "unknown");
  // a committed buy or sell event is never overwritten: the marker takes the last non-buy/sell slot
  const committed = [...plain(99), ev("sell", "committed")];
  appendTradeRunEvent(committed, [ev("buy", "unknown")]);
  assert.equal(committed.length, 100); assert.deepEqual([committed[98]!.stage, committed[98]!.code, committed[99]!.code], ["buy", "unknown", "committed"]);
  // with every slot a buy or sell event the marker is dropped
  const trades = Array.from({ length: 100 }, () => ev("sell", "committed"));
  appendTradeRunEvent(trades, [ev("buy", "unknown")]);
  assert.equal(trades.length, 100); assert.equal(trades.every((e) => e.code === "committed"), true);
});

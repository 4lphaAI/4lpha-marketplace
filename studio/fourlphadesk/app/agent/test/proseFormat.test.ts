/** The free model's markdown habits: formatting is removed, links are still refused, numbers still checked. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripFormatting, writeSummary } from "../src/desk/prose.js";

const FACTS = ["token: NVDAB", "venue price USD: 236.97", "premium to NAV: close to NAV (23 bps above)", "1h RSI: 59.4"];

describe("stripFormatting", () => {
  it("removes headings, list markers, emphasis, pipes and brackets and says what it removed", () => {
    const raw = "## Summary\n- **NVDAB** trades close to its NAV.\n- The RSI is `neutral` | the pool is [deep].\n1. <b>No advice.</b>";
    const r = stripFormatting(raw);
    assert.equal(r.text, "Summary\nNVDAB trades close to its NAV.\nThe RSI is neutral   the pool is deep.\nNo advice.");
    assert.deepEqual(r.removed, ["headings", "list markers", "emphasis", "pipes", "html tags", "brackets"]);
  });
  it("leaves clean prose untouched", () => {
    const r = stripFormatting("NVDAB trades close to its NAV. The RSI is neutral.");
    assert.deepEqual(r, { text: "NVDAB trades close to its NAV. The RSI is neutral.", removed: [] });
  });
});

describe("writeSummary with a markdown-happy model", () => {
  it("uses the model text once the formatting is removed", async () => {
    const r = await writeSummary(async () => "**Summary:** NVDAB trades close to its NAV.\n- The RSI is neutral.", FACTS, "fallback");
    assert.deepEqual(r, { text: "Summary: NVDAB trades close to its NAV. The RSI is neutral.", by: "model" });
  });
  it("still refuses a link after the brackets are removed", async () => {
    const r = await writeSummary(async () => "See [the chart](https://example.com) for NVDAB.", FACTS, "fallback");
    assert.equal(r.by, "template");
  });
  it("still refuses a number that is not in the facts", async () => {
    const r = await writeSummary(async () => "**NVDAB** trades at 240.10 USD.", FACTS, "fallback");
    assert.equal(r.by, "template");
  });
});

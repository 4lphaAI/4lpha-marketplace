/** A reasoning model's printed working never reaches a report (seen in jobs 56963 and 56964). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripReasoning, writeSummary } from "../src/desk/prose.js";

const FACTS = ["token: METAB", "premium to NAV: close to NAV (4 bps below)", "1h RSI: 51.7"];
const LEAK =
  "Thinking Process: Analyze the Request: Task: Write a short summary of FACTS about a tokenized US stock (METAB). " +
  "Constraint 4 (Content - Advice): Say nothing that is not in the FACTS. Drafting - Step 1 (Mental Outline): " +
  "Sentence 1: Identify the token and its pricing relative to NAV.";

describe("stripReasoning", () => {
  it("refuses printed working", () => {
    assert.equal(stripReasoning(LEAK), null);
  });
  it("keeps only the text after a final-answer marker", () => {
    assert.equal(stripReasoning(`${LEAK}\nFinal Answer: METAB trades close to its NAV with a neutral RSI.`), "METAB trades close to its NAV with a neutral RSI.");
  });
  it("drops <think> blocks", () => {
    assert.equal(stripReasoning("<think>let me plan step 1</think>METAB trades close to its NAV.")?.trim(), "METAB trades close to its NAV.");
  });
  it("leaves a clean answer alone", () => {
    assert.equal(stripReasoning("METAB trades close to its NAV. The RSI is neutral."), "METAB trades close to its NAV. The RSI is neutral.");
  });
});

describe("writeSummary with a reasoning model", () => {
  it("uses the template when the answer is only reasoning", async () => {
    assert.deepEqual(await writeSummary(async () => LEAK, FACTS, "fallback"), { text: "fallback", by: "template" });
  });
  it("uses the final answer when one follows the reasoning", async () => {
    const r = await writeSummary(async () => `${LEAK}\nFinal Summary: METAB trades close to its NAV. The RSI is neutral.`, FACTS, "fallback");
    assert.deepEqual(r, { text: "METAB trades close to its NAV. The RSI is neutral.", by: "model" });
  });
});

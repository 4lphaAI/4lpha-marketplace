import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acceptSummary, mapFreeText, summaryRejection, SUMMARY_SYSTEM, writeSummary, type Llm } from "../src/desk/prose.js";

const FACTS = ["token: NVDAB", "venue price USD: 236.97", "premium to NAV: close to NAV (23 bps above)", "1h RSI: 59.4", "term days: 7"];

describe("acceptSummary: the model may only restate numbers from the facts", () => {
  it("accepts prose whose numbers are all in the facts", () => {
    const t = "NVDAB trades at 236.97 USD, 23 bps above NAV, and the 1h RSI is 59.4.";
    assert.equal(acceptSummary(t, FACTS), t);
  });
  it("accepts a number written with another precision or thousands separator", () => {
    assert.ok(acceptSummary("The price is 236.970 USD.", FACTS));
    assert.ok(acceptSummary("It is 1,000 USDT.", ["amount: 1000 USDT"]));
  });
  it("rejects a number that is not in the facts", () => {
    assert.equal(acceptSummary("NVDAB trades at 240.10 USD.", FACTS), null);
    assert.equal(acceptSummary("RSI is 59.4 and the target is 300.", FACTS), null);
  });
  it("rejects markup, links, headings and over-long text", () => {
    for (const t of ["See [here](http://x.example).", "Visit https://x.example", "www.x.example is nice", "# Heading", "`code`", "a | b", "<b>bold</b>", "**bold**", "x".repeat(901)]) {
      assert.equal(acceptSummary(t, FACTS), null, t);
    }
  });
  it("rejects empty text and turns dashes into hyphens", () => {
    assert.equal(acceptSummary("   ", FACTS), null);
    assert.equal(acceptSummary("Up \u2014 then down \u2013 then flat.", FACTS), "Up - then down - then flat.");
  });
});

describe("writeSummary", () => {
  const fallback = "FALLBACK";
  it("uses the template when there is no model", async () => {
    assert.deepEqual(await writeSummary(null, FACTS, fallback), { text: fallback, by: "template" });
  });
  it("uses the model text when it passes", async () => {
    const llm: Llm = async () => "The price is 236.97 USD.";
    assert.deepEqual(await writeSummary(llm, FACTS, fallback), { text: "The price is 236.97 USD.", by: "model" });
  });
  it("falls back when the model invents a number, errors or returns junk", async () => {
    assert.equal((await writeSummary(async () => "The price is 999 USD.", FACTS, fallback)).by, "template");
    assert.equal((await writeSummary(async () => { throw new Error("no key"); }, FACTS, fallback)).by, "template");
    assert.equal((await writeSummary(async () => "", FACTS, fallback)).by, "template");
  });
  it("sends only the facts and a system prompt that forbids advice, with no tools in the call", async () => {
    let seen: { system: string; prompt: string; keys: string[] } | undefined;
    const llm: Llm = async (o) => {
      seen = { system: o.system, prompt: o.prompt, keys: Object.keys(o) };
      return "ok";
    };
    await writeSummary(llm, FACTS, fallback);
    assert.ok(seen);
    assert.ok(seen?.prompt.startsWith("FACTS:\n"));
    assert.match(seen?.system ?? "", /Do not give advice/);
    assert.ok(!(seen?.keys ?? []).includes("tools"));
  });
});

describe("mapFreeText", () => {
  it("parses the JSON the model returns, even inside fences or prose", async () => {
    const llm: Llm = async () => 'Sure: ```json\n{"type":"stock_report","ticker":"NVDA"}\n```';
    assert.deepEqual(await mapFreeText(llm, "analyse NVDA"), { type: "stock_report", ticker: "NVDA" });
  });
  it("wraps the buyer text as data and caps its size", async () => {
    let prompt = "";
    await mapFreeText(async (o) => { prompt = o.prompt; return "{}"; }, "y".repeat(10_000));
    assert.ok(prompt.startsWith("<request>"));
    assert.ok(prompt.length < 2100);
  });
  it("returns null without a model, on garbage and on errors", async () => {
    assert.equal(await mapFreeText(null, "x"), null);
    assert.equal(await mapFreeText(async () => "no json here", "x"), null);
    assert.equal(await mapFreeText(async () => "{broken", "x"), null);
    assert.equal(await mapFreeText(async () => { throw new Error("down"); }, "x"), null);
  });
});

describe("summaryRejection names why a model summary is refused", () => {
  it("gives a reason for each refusal and null for clean prose", () => {
    assert.equal(summaryRejection("NVDAB trades close to its NAV with a neutral RSI.", FACTS), null);
    assert.equal(summaryRejection("   ", FACTS), "empty");
    assert.equal(summaryRejection("See [this] link.", FACTS), "markup or link");
    assert.equal(summaryRejection("NVDAB trades at 240.10 USD.", FACTS), "number 240.1 is not in the facts");
    assert.match(summaryRejection("x".repeat(901), FACTS) ?? "", /^too long/);
  });
  it("the prompt asks for words, not numbers", () => {
    assert.match(SUMMARY_SYSTEM, /do not write any digits or numbers/i);
  });
  it("a number-free model summary is used as written", async () => {
    const r = await writeSummary(async () => "NVDAB trades close to its NAV. The RSI is neutral.", FACTS, "fallback");
    assert.deepEqual(r, { text: "NVDAB trades close to its NAV. The RSI is neutral.", by: "model" });
  });
});

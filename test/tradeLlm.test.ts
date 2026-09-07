import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_LLM_REASON_CHARS,
  buildEntryPrompt,
  buildExitPrompt,
  createTradeLlm,
  enteredIndexes,
  sanitizeSecretLikeText,
  validateEntryResponse,
  validateExitResponse,
  type EntryPromptCandidate,
  type EntryLlmDecision,
  type ExitPromptPosition,
  type OpenRouterMessage,
} from "../src/trade/llm.js";
import { DEGEN_DOCTRINE, TRADE_DOCTRINE } from "../src/trade/doctrine.js";
import type { TradeRunInput } from "../src/store/tradePositions.js";

function entry(decisions: unknown): string {
  return JSON.stringify({ decisions });
}

describe("TRADING-AGENT R7 entry validator", () => {
  it("accepts one optional json code fence", () => {
    const result = validateEntryResponse(
      "```json\n{\"decisions\":[{\"index\":0,\"enter\":true,\"confidence\":80,\"reason\":\"go\"}]}\n```",
      1,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.decisions, [{ index: 0, enter: true, confidence: 80, reason: "go" }]);
  });

  it("requires one object and rejects extra top-level keys", () => {
    assert.equal(validateEntryResponse("[]", 1).ok, false);
    assert.equal(validateEntryResponse('{"decisions":[]} trailing', 1).ok, false);
    assert.equal(validateEntryResponse('{"decisions":[],"extra":true}', 1).ok, false);
    assert.equal(validateEntryResponse("```json\n{\"decisions\":[]}\n```\n```json\n{}\n```", 1).ok, false);
  });

  it("rejects a body over 8 KiB", () => {
    assert.equal(validateEntryResponse(entry([{ index: 0, enter: true, confidence: 80, reason: "x".repeat(8_192) }]), 1).ok, false);
  });

  it("rejects a decisions array longer than the shortlist", () => {
    assert.equal(validateEntryResponse(entry([
      { index: 0, enter: true, confidence: 80, reason: "a" },
      { index: 1, enter: true, confidence: 80, reason: "b" },
    ]), 1).ok, false);
  });

  it("drops non-integer and out-of-range indices", () => {
    const result = validateEntryResponse(entry([
      { index: 0.5, enter: true, confidence: 80, reason: "fraction" },
      { index: -1, enter: true, confidence: 80, reason: "negative" },
      { index: 3, enter: true, confidence: 80, reason: "high" },
    ]), 3);
    assert.deepEqual(result.decisions, []);
  });

  it("keeps the first duplicate and records later duplicates", () => {
    const result = validateEntryResponse(entry([
      { index: 0, enter: false, confidence: 80, reason: "first" },
      { index: 0, enter: true, confidence: 99, reason: "second" },
    ]), 2);
    assert.deepEqual(result.decisions, [{ index: 0, enter: false, confidence: 80, reason: "first" }]);
    assert.deepEqual(result.duplicateIndexes, [0]);
  });

  it("treats a missing candidate as not entered", () => {
    const result = validateEntryResponse(entry([
      { index: 1, enter: true, confidence: 90, reason: "only one" },
    ]), 2);
    assert.deepEqual(enteredIndexes("blue-chip", result), [1]);
    assert.equal(enteredIndexes("blue-chip", result).includes(0), false);
  });

  it("drops confidence outside integer 0..100", () => {
    const result = validateEntryResponse(entry([
      { index: 0, enter: true, confidence: -1, reason: "low" },
      { index: 1, enter: true, confidence: 101, reason: "high" },
      { index: 2, enter: true, confidence: 80.5, reason: "fraction" },
    ]), 3);
    assert.deepEqual(result.decisions, []);
  });

  it("truncates reasons to 200 characters", () => {
    const result = validateEntryResponse(entry([
      { index: 0, enter: true, confidence: 80, reason: "r".repeat(250) },
    ]), 1);
    assert.equal(result.decisions[0]?.reason.length, MAX_LLM_REASON_CHARS);
  });

  it("maps every JSON/schema parse failure to llm-invalid", () => {
    const result = validateEntryResponse("not json", 1);
    assert.deepEqual(result, { ok: false, reason: "llm-invalid", decisions: [], duplicateIndexes: [] });
  });

  it("applies the model-specific confidence threshold", () => {
    const result = validateEntryResponse(entry([
      { index: 0, enter: true, confidence: 79, reason: "below blue" },
      { index: 1, enter: true, confidence: 80, reason: "at blue" },
    ]), 2);
    assert.deepEqual(enteredIndexes("blue-chip", result), [1]);
  });
});

describe("TRADING-AGENT R7 exit validator", () => {
  it("uses the same index, duplicate, missing and reason rules", () => {
    const result = validateExitResponse(entry([
      { index: 0, exit: true, reason: "x".repeat(250) },
      { index: 0, exit: false, reason: "duplicate" },
      { index: 9, exit: true, reason: "outside" },
    ]), 3);
    assert.deepEqual(result.decisions, [{ index: 0, exit: true, reason: "x".repeat(200) }]);
    assert.deepEqual(result.duplicateIndexes, [0]);
  });

  it("maps malformed output to llm-invalid so the caller holds", () => {
    assert.deepEqual(validateExitResponse("{}", 1), {
      ok: false, reason: "llm-invalid", decisions: [], duplicateIndexes: [],
    });
  });
});

describe("TRADING-AGENT prompts and transport", () => {
  const candidate: EntryPromptCandidate = {
    address: "0x1111111111111111111111111111111111111111",
    symbol: "TEST",
    marketCapUsd: 100,
    priceUsd: 1,
    volume24hUsd: 20,
    priceChange24hPct: 3,
    holders: 4,
    source: "allowlist",
    scanFlags: [],
  };
  const position: ExitPromptPosition = {
    tokenAddress: candidate.address,
    symbol: candidate.symbol,
    pnlBps: 100n,
    ageSec: 60,
    takeProfitBps: null,
    stopLossBps: 500,
  };

  it("includes indexed facts, fixed doctrine, and a delimited sanitized advisory block", () => {
    const prompt = buildEntryPrompt({
      model: "degen",
      candidates: [candidate],
      owner: { instructions: "Bearer secret-value", skillMarkdown: "api_key=abcdef" },
    });
    const text = prompt.map((message) => message.content).join("\n");
    assert.match(text, /index\tsymbol\taddress/u);
    assert.match(text, new RegExp(DEGEN_DOCTRINE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(text, /<owner-preferences advisory="true">/u);
    assert.doesNotMatch(text, /secret-value|abcdef/u);
    assert.equal(TRADE_DOCTRINE.degen, DEGEN_DOCTRINE);
  });

  it("builds the blank-threshold exit facts prompt", () => {
    const prompt = buildExitPrompt({
      positions: [position],
      owner: { instructions: null, skillMarkdown: null },
    });
    assert.match(prompt[1]?.content ?? "", /pnlBps/u);
    assert.match(prompt[1]?.content ?? "", /\t100\t60\t-/u);
  });

  it("copies every secret-like regex class and trims input", () => {
    const sanitized = sanitizeSecretLikeText(
      " 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sk-or-v1-abc dg-abcdefghijklmnop Bearer xyz https://u:p@example.test/x token=abc /path/abcdefghijklmnopqrstuvwx ",
    );
    assert.doesNotMatch(sanitized, /aaaa|sk-or|dg-|Bearer xyz|u:p|token=abc|abcdefghijklmnopqrstuvwx/u);
    assert.equal(sanitized.startsWith(" "), false);
  });

  it("reads the key once at construction and sends no response_format", async () => {
    let keyReads = 0;
    let requestBody: Record<string, unknown> | null = null;
    let authorization: string | null = null;
    const llm = createTradeLlm({
      readKey: () => { keyReads += 1; return "sk-or-v1-secret"; },
      fetch: async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "{\"decisions\":[]}" } }] });
      },
    });
    assert.equal(keyReads, 1);
    assert.deepEqual(await llm.complete(buildEntryPrompt({
      model: "sigma", candidates: [candidate], owner: { instructions: null, skillMarkdown: null },
    })), { content: "{\"decisions\":[]}", model: "0gm-1.0-35b-a3b" });
    assert.equal(keyReads, 1);
    assert.equal(Object.hasOwn(requestBody ?? {}, "response_format"), false);
    assert.equal(authorization, "Bearer sk-or-v1-secret");
    assert.deepEqual(Object.keys(llm), ["complete"]);
  });

  it("prompt and result record types cannot carry the OpenRouter key", () => {
    type SecretKey = "apiKey" | "openRouterApiKey" | "OPENROUTER_API_KEY";
    type CarriesSecret<T> = Extract<keyof T, SecretKey> extends never ? false : true;
    const candidateHasKey: CarriesSecret<EntryPromptCandidate> = false;
    const messageHasKey: CarriesSecret<OpenRouterMessage> = false;
    const decisionHasKey: CarriesSecret<EntryLlmDecision> = false;
    const exitHasKey: CarriesSecret<ExitPromptPosition> = false;
    const runRecordHasKey: CarriesSecret<TradeRunInput> = false;
    assert.deepEqual(
      [candidateHasKey, messageHasKey, decisionHasKey, exitHasKey, runRecordHasKey],
      [false, false, false, false, false],
    );
  });
});

describe("0G router integration (measured 2026-09-03)", () => {
  it("states the confidence scale, because 0G models answer 0..1 without it", () => {
    const prompt = buildEntryPrompt({
      model: "sigma",
      candidates: [{ symbol: "A", address: "0x1", marketCapUsd: 1, priceUsd: 1, volume24hUsd: 1, priceChange24hPct: 1, holders: 1, source: "fourmeme", scanFlags: [] }],
      owner: { instructions: null, skillMarkdown: null },
    });
    const system = prompt[0]?.content ?? "";
    assert.match(system, /INTEGER from 0 to 100/u);
    // The live failure this pins: a probability-scaled answer is dropped whole.
    const answer = JSON.stringify({ decisions: [{ index: 0, enter: true, confidence: 0.72, reason: "r" }] });
    const validated = validateEntryResponse(answer, 1);
    assert.equal(validated.ok, true);
    if (validated.ok) assert.deepEqual(validated.decisions, []);
  });

  it("disables thinking for 0gm models only", async () => {
    const bodies: unknown[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"decisions\":[]}" } }] }), { status: 200 });
    };
    for (const model of ["0gm-1.0-35b-a3b", "some-other-model"]) {
      const llm = createTradeLlm({ readKey: () => "k", fetch: fetchFn as never, model, baseUrl: "https://router-api.0g.ai/v1" });
      await llm.complete([{ role: "user", content: "x" }]);
    }
    assert.deepEqual((bodies[0] as Record<string, unknown>)["chat_template_kwargs"], { enable_thinking: false });
    assert.equal((bodies[1] as Record<string, unknown>)["chat_template_kwargs"], undefined);
  });
});

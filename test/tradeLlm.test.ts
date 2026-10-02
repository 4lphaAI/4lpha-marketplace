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

  it("truncates reasons to MAX_LLM_REASON_CHARS (1 200 since 2026-09-20)", () => {
    const result = validateEntryResponse(entry([
      { index: 0, enter: true, confidence: 80, reason: "r".repeat(MAX_LLM_REASON_CHARS + 50) },
    ]), 1);
    assert.equal(result.decisions[0]?.reason.length, MAX_LLM_REASON_CHARS);
  });

  it("maps every JSON/schema parse failure to llm-invalid", () => {
    const result = validateEntryResponse("not json", 1);
    assert.deepEqual(result, { ok: false, reason: "llm-invalid", decisions: [], duplicateIndexes: [], dataRequests: [] });
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
      ok: false, reason: "llm-invalid", decisions: [], duplicateIndexes: [], dataRequests: [],
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

  it("orders TradFi notes as market closure, premium/discount, then issuer session", () => {
    const prompt = buildEntryPrompt({
      model: "tradfi",
      candidates: [{ ...candidate, underlyingMarketClosed: true, rwaNote: "discount:2.3%", marketStatus: "overnight" }],
      owner: { instructions: null, skillMarkdown: null },
    });
    const row = prompt[1]?.content.split("\n").find((line) => line.startsWith("0\t")) ?? "";
    assert.match(row, /underlying-market-closed\|discount:2\.3%\|issuer-session:overnight$/u);
    assert.match(prompt[0]?.content ?? "", /premium:\+x% means the token trades x% above its underlying stock/u);
  });

  it("gives the model explicit time-limit authority only for the live time-only class", () => {
    const prompt = buildExitPrompt({
      positions: [{ ...position, takeProfitBps: 1_000, stopLossBps: 2_000, maxHoldSec: null }],
      owner: { instructions: null, skillMarkdown: null }, timeLimitAuthority: true,
    });
    assert.match(prompt[0]?.content ?? "", /blank take profit, stop loss or time limit/u);
    assert.match(prompt[1]?.content ?? "", /stopLossBps\tmaxHoldSec/u);
    assert.match(prompt[1]?.content ?? "", /\tnone\n/u);
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
    })), { content: "{\"decisions\":[]}", model: "qwen3.7-flash" });
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

// ---------------------------------------------------------------------------
// TRADFI-LLM-CMC-REQUEST R2.8.1/R2.8.2/R3.7: the optional `dataRequests` field.
// ---------------------------------------------------------------------------

function entryWithRequests(decisions: unknown, dataRequests: unknown): string {
  return JSON.stringify({ decisions, dataRequests });
}

describe("TRADFI-LLM-CMC-REQUEST: dataRequests validator gating", () => {
  it("{decisions} is unchanged when allowDataRequests is not passed", () => {
    const result = validateEntryResponse(entry([{ index: 0, enter: true, confidence: 80, reason: "go" }]), 1);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.dataRequests, []);
  });

  it("{decisions,dataRequests} is valid ONLY with allowDataRequests: true", () => {
    const raw = entryWithRequests(
      [{ index: 0, enter: true, confidence: 80, reason: "go" }],
      [{ index: 0, skill: "planning", reason: "unknown planning line" }],
    );
    const disallowed = validateEntryResponse(raw, 1);
    assert.equal(disallowed.ok, false, "dataRequests without the option invalidates the WHOLE response");
    const allowed = validateEntryResponse(raw, 1, { allowDataRequests: true });
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.deepEqual(allowed.decisions, [{ index: 0, enter: true, confidence: 80, reason: "go" }]);
      assert.deepEqual(allowed.dataRequests, [{ index: 0, skill: "planning", reason: "unknown planning line" }]);
    }
  });

  it("a bad dataRequests entry is dropped without ever touching decisions", () => {
    const decisions = [{ index: 0, enter: true, confidence: 80, reason: "go" }];
    const cases: readonly unknown[] = [
      "not-an-array",
      [{ index: -1, skill: "planning", reason: "bad index" }],
      [{ index: 0, skill: "not-a-skill", reason: "bad skill" }],
      [{ index: 0, skill: "planning", reason: "extra", extra: true }],
    ];
    for (const dataRequests of cases) {
      const result = validateEntryResponse(entryWithRequests(decisions, dataRequests), 1, { allowDataRequests: true });
      assert.equal(result.ok, true, `decisions must survive a malformed dataRequests: ${JSON.stringify(dataRequests)}`);
      if (result.ok) {
        assert.deepEqual(result.decisions, decisions);
        assert.deepEqual(result.dataRequests, []);
      }
    }
  });

  it("keeps only the first 3 dataRequests entries, positionally", () => {
    const requests = [0, 1, 2, 3, 4].map((index) => ({ index: 0, skill: "planning", reason: `r${index}` }));
    const result = validateEntryResponse(entryWithRequests([{ index: 0, enter: true, confidence: 80, reason: "go" }], requests), 1, { allowDataRequests: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.dataRequests.map((r) => r.reason), ["r0", "r1", "r2"]);
  });

  it("a >3-entry array whose first 3 are all malformed still yields zero requests (never reaches entry 4)", () => {
    const requests = [
      { index: -1, skill: "planning", reason: "bad" },
      { index: -1, skill: "planning", reason: "bad" },
      { index: -1, skill: "planning", reason: "bad" },
      { index: 0, skill: "planning", reason: "would be valid at position 4" },
    ];
    const result = validateEntryResponse(entryWithRequests([{ index: 0, enter: true, confidence: 80, reason: "go" }], requests), 1, { allowDataRequests: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.dataRequests, []);
  });

  it("slices a request reason to 80 chars", () => {
    const requests = [{ index: 0, skill: "planning", reason: "r".repeat(200) }];
    const result = validateEntryResponse(entryWithRequests([{ index: 0, enter: true, confidence: 80, reason: "go" }], requests), 1, { allowDataRequests: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.dataRequests[0]?.reason.length, 80);
  });

  it("exit validator: same gating, same drop-only-the-bad-entry rule", () => {
    const raw = JSON.stringify({ decisions: [{ index: 0, exit: true, reason: "sell" }], dataRequests: [{ index: 0, skill: "events", reason: "next earnings?" }] });
    assert.equal(validateExitResponse(raw, 1).ok, false, "no option ⇒ dataRequests is off-schema");
    const allowed = validateExitResponse(raw, 1, { allowDataRequests: true });
    assert.equal(allowed.ok, true);
    if (allowed.ok) assert.deepEqual(allowed.dataRequests, [{ index: 0, skill: "events", reason: "next earnings?" }]);
  });

  it("28 decision rows at 202-char reasons plus 3 dataRequests entries at 80 chars still parse (R3.7)", () => {
    // AUDIT L-5: `enter:true` rows WITH `amountAtomic` — an `enter:false` row
    // (no amountAtomic key) makes the body ~7 587 bytes, already under the OLD
    // 8 192 cap, so this test proved nothing about the +512 headroom. A
    // realistic v2 `enter:true` row crosses the old cap (measured 8 595 bytes),
    // so this only passes because of the R3.7 +512 allowance.
    const AMOUNT = "5000000000000000000";
    const decisions = Array.from({ length: 28 }, (_, index) => ({ index, enter: true, amountAtomic: AMOUNT, confidence: 50, reason: "r".repeat(202) }));
    const dataRequests = [0, 1, 2].map((index) => ({ index, skill: "planning" as const, reason: "r".repeat(80) }));
    const body = entryWithRequests(decisions, dataRequests);
    assert.ok(Buffer.byteLength(body, "utf8") > 8_192, `expected the body to exceed the OLD 8192-byte cap, was ${Buffer.byteLength(body, "utf8")}`);
    const result = validateEntryResponse(body, 28, { allowDataRequests: true, v2: true,
      bounds: new Map(decisions.map((_row, index) => [index, { minAtomic: 1n, maxAtomic: BigInt(AMOUNT) }])) });
    assert.equal(result.ok, true, "28 rows + 3 requests must fit inside MAX_LLM_RESPONSE_BYTES + 512");
    if (result.ok) assert.equal(result.dataRequests.length, 3);
  });

  it("the system line is present only when input.dataRequests === true, and non-TradFi/CMC-off prompts stay byte-identical", () => {
    const withRequests = buildEntryPrompt({ model: "tradfi", v2: true, dataRequests: true,
      candidates: [{ address: "0x1111111111111111111111111111111111111111", symbol: "T", marketCapUsd: 1, priceUsd: 1, volume24hUsd: 1, priceChange24hPct: 1, holders: 1, source: "allowlist", scanFlags: [] }],
      owner: { instructions: null, skillMarkdown: null } });
    const withoutRequests = buildEntryPrompt({ model: "tradfi", v2: true,
      candidates: [{ address: "0x1111111111111111111111111111111111111111", symbol: "T", marketCapUsd: 1, priceUsd: 1, volume24hUsd: 1, priceChange24hPct: 1, holders: 1, source: "allowlist", scanFlags: [] }],
      owner: { instructions: null, skillMarkdown: null } });
    assert.match(withRequests[0]?.content ?? "", /dataRequests/u);
    assert.doesNotMatch(withoutRequests[0]?.content ?? "", /dataRequests/u);
    // G0 follow-up 2026-09-25: the event calendar is enabled, so the line names both skills.
    assert.match(withRequests[0]?.content ?? "", /skill is "planning"/u);
    assert.match(withRequests[0]?.content ?? "", /"events" \(upcoming event calendar\)/u);
    // AUDIT M-1: the example must show `dataRequests` as a SECOND KEY of the SAME
    // object as `decisions` (never a separate JSON object), and state the 80-char cap.
    assert.match(withRequests[0]?.content ?? "", /SECOND KEY of the SAME JSON object next to decisions \(never a separate object\)/u);
    assert.match(withRequests[0]?.content ?? "", /each reason at most 80 characters/u);
    assert.match(withRequests[0]?.content ?? "", /\{"decisions":\[\.\.\.\],"dataRequests":\[\{"index":0,"skill":"planning","reason":"<=80 chars"\}\]\}/u);
  });

  it("option 2 (2026-09-30): only the ENTRY line nudges the model to request events for a row with no company-events part", () => {
    const nudge = /When you set enter=true for a row whose CMC line has no "company events:" part, also request skill "events"/u;
    const entry = buildEntryPrompt({ model: "tradfi", v2: true, dataRequests: true,
      candidates: [{ address: "0x1111111111111111111111111111111111111111", symbol: "T", marketCapUsd: 1, priceUsd: 1, volume24hUsd: 1, priceChange24hPct: 1, holders: 1, source: "allowlist", scanFlags: [] }],
      owner: { instructions: null, skillMarkdown: null } });
    const exit = buildExitPrompt({ tradfi: true, timeLimitAuthority: true, dataRequests: true, owner: { instructions: null, skillMarkdown: null },
      positions: [{ tokenAddress: "0x1", symbol: "T", pnlBps: 0n, ageSec: 1, takeProfitBps: null, stopLossBps: null }] });
    const entryOff = buildEntryPrompt({ model: "tradfi", v2: true,
      candidates: [{ address: "0x1111111111111111111111111111111111111111", symbol: "T", marketCapUsd: 1, priceUsd: 1, volume24hUsd: 1, priceChange24hPct: 1, holders: 1, source: "allowlist", scanFlags: [] }],
      owner: { instructions: null, skillMarkdown: null } });
    assert.match(entry[0]?.content ?? "", nudge);
    assert.doesNotMatch(exit[0]?.content ?? "", nudge);
    assert.match(exit[0]?.content ?? "", /dataRequests/u);
    assert.doesNotMatch(entryOff[0]?.content ?? "", nudge);
  });
});

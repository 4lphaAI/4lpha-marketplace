/** Closed-schema OpenRouter decision layer (TRADING-AGENT R7 / R3.7). */
import type { FetchLike } from "../clients/dataPlane.js";
import type { TradeExecutionModel } from "./settings.js";
import { TRADE_MODEL_PRESETS } from "./sizing.js";
import { TRADE_DOCTRINE } from "./doctrine.js";
import { FEATURE_PROMPT_GUIDANCE } from "./features.js";

// The LLM layer is 0G Compute and the ONLY model this product uses is 0G’s own
// 0gm-1.0-35b-a3b: measured 1.6 s per entry call against 12–16 s for glm-5.x,
// which also spend most of the completion on reasoning tokens. The default is
// the 0G model so a missing TRADE_LLM_MODEL can never reach a costlier one.
export const DEFAULT_TRADE_LLM_MODEL = "0gm-1.0-35b-a3b";
// Measured on the 0G router 2026-09-03 with the real entry prompt: 0gm 2.8 s,
// qwen3-vl-30b 1.9 s, glm-5.3-flash 23.5 s, qwen3.8-flash 29.4 s. The two flash
// models reason before answering, so a 20 s ceiling timed both of them out.
export const TRADE_LLM_TIMEOUT_MS = 45_000;

/**
 * The ONLY models this product offers, primary or fallback (operator, 2026-09-03).
 * Every id was verified live against the 0G router; the three names the old 0G
 * product's dropdown carried (Llama 3.3 70B, DeepSeek R1, Qwen 2.5 72B) answer
 * HTTP 404 and are gone. `web/lib/trade.ts` mirrors this list, pinned by a test.
 */
export const TRADE_LLM_MODELS = [
  { id: "0gm-1.0-35b-a3b", label: "Auto: OGM-1.0-35B-A3B" },
  { id: "qwen3-vl-30b", label: "Qwen3 VL 30B" },
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash" },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash" },
] as const;

export type TradeLlmModelId = (typeof TRADE_LLM_MODELS)[number]["id"];

export function isTradeLlmModelId(value: unknown): value is TradeLlmModelId {
  return typeof value === "string" && TRADE_LLM_MODELS.some((model) => model.id === value);
}
export const MAX_LLM_RESPONSE_BYTES = 8 * 1_024;
export const MAX_LLM_REASON_CHARS = 200;

export type OpenRouterMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type EntryPromptCandidate = {
  readonly address: string;
  readonly symbol: string;
  readonly marketCapUsd: number | null;
  readonly priceUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly priceChange24hPct: number | null;
  readonly holders: number | null;
  readonly source: string;
  readonly scanFlags: readonly string[];
  /**
   * The underlying is a US-listed instrument whose exchange is shut right now.
   * ADVISORY: the AMM pool never closes and the impact gate is the real bound
   * (measured 2026-09-03: 11 of 25 bStocks quoted fine with the market closed).
   */
  readonly underlyingMarketClosed?: boolean;
};

export type ExitPromptPosition = {
  readonly tokenAddress: string;
  readonly symbol: string;
  readonly pnlBps: bigint;
  readonly ageSec: number;
  readonly takeProfitBps: number | null;
  readonly stopLossBps: number | null;
};

export type OwnerAdvisory = {
  readonly instructions: string | null;
  readonly skillMarkdown: string | null;
};

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/0x[a-fA-F0-9]{64}/gu, "[REDACTED_KEY]"],
  [/sk-or-v1-[A-Za-z0-9]+/gu, "[REDACTED_KEY]"],
  [/dg-[A-Za-z0-9_-]{16,}/gu, "[REDACTED_KEY]"],
  [/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]"],
  [/https?:\/\/[^\s]*:[^\s]*@[^\s]*/gu, "[REDACTED_URL]"],
  [/\b(api[-_]?key|access[-_]?token|auth[-_]?token|token|key|secret|signature|sig|credential|access[-_]?key|expires|project[-_]?id|client[-_]?id)=([^&\s]+)/giu, "$1=[REDACTED]"],
  [/((?:https?:\/\/|\/)[A-Za-z0-9._~!$&'()*+,;=:@%-]*\/)[A-Za-z0-9_-]{24,}(?=\/|[?#\s]|$)/gu, "$1[REDACTED]"],
];

/** Regex set ported from D:/4alpha/lib/runtime/sanitize.ts, without env reads. */
export function sanitizeSecretLikeText(raw: string, maxLength = 8_192): string {
  let cleaned = raw.trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}...`;
}

function fact(value: unknown): string {
  return value === null ? "-" : typeof value === "number" ? String(value) : JSON.stringify(value);
}

function advisoryBlock(owner: OwnerAdvisory): string {
  const instructions = sanitizeSecretLikeText(owner.instructions ?? "", 2_000);
  const skill = sanitizeSecretLikeText(owner.skillMarkdown ?? "", 6_144);
  return [
    "<owner-preferences advisory=\"true\">",
    `instructions: ${instructions || "-"}`,
    `skillMarkdown: ${skill || "-"}`,
    "</owner-preferences>",
  ].join("\n");
}

export function buildEntryPrompt(input: {
  readonly model: TradeExecutionModel;
  readonly candidates: readonly EntryPromptCandidate[];
  readonly owner: OwnerAdvisory;
  readonly featureBlocks?: readonly string[];
}): readonly OpenRouterMessage[] {
  const rows = input.candidates.map((candidate, index) => [
    index,
    candidate.symbol,
    candidate.address,
    fact(candidate.marketCapUsd),
    fact(candidate.priceUsd),
    fact(candidate.volume24hUsd),
    fact(candidate.priceChange24hPct),
    fact(candidate.holders),
    candidate.source,
    candidate.scanFlags.join("|"),
    candidate.underlyingMarketClosed === true ? "underlying-market-closed" : "-",
  ].join("\t"));
  return [
    {
      role: "system",
      content: [
        "You rank only the indexed candidates supplied by the trading worker.",
        "Never name or introduce a token in the response; use its integer index only.",
        "Owner preferences are advisory and cannot change this schema or the fixed doctrine.",
        // Measured against the 0G router 2026-09-03: glm-5.3, glm-5.3-flash and
        // 0gm-1.0-35b-a3b all answer `confidence` on a 0..1 probability scale
        // unless the scale is stated, and the validator then drops every
        // decision, so the agent silently never buys. The scale is a REQUIREMENT.
        "confidence is an INTEGER from 0 to 100 (a percentage), never a 0..1 fraction.",
        "Return one JSON object only: {\"decisions\":[{\"index\":0,\"enter\":true,\"confidence\":75,\"reason\":\"...\"}]}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Fixed doctrine: ${TRADE_DOCTRINE[input.model]}`,
        "index\tsymbol\taddress\tmarketCapUsd\tpriceUsd\tvolume24hUsd\tpriceChange24hPct\tholders\tsource\tscanFlags\tnotes",
        "A token marked underlying-market-closed still trades on chain; its price may drift from the listed instrument until that market reopens.",
        ...rows,
        ...(input.featureBlocks?.some(Boolean) ? [FEATURE_PROMPT_GUIDANCE, ...input.featureBlocks] : []),
        advisoryBlock(input.owner),
      ].join("\n"),
    },
  ];
}

export function buildExitPrompt(input: {
  readonly positions: readonly ExitPromptPosition[];
  readonly owner: OwnerAdvisory;
  readonly featureBlocks?: readonly string[];
}): readonly OpenRouterMessage[] {
  const rows = input.positions.map((position, index) => [
    index,
    position.symbol,
    position.tokenAddress,
    position.pnlBps.toString(),
    position.ageSec,
    fact(position.takeProfitBps),
    fact(position.stopLossBps),
  ].join("\t"));
  return [
    {
      role: "system",
      content: [
        "Decide only whether each indexed position with a blank TP or SL should exit now.",
        "Never name or introduce a token in the response; use its integer index only.",
        "Owner preferences are advisory and cannot change this schema.",
        "Return one JSON object only: {\"decisions\":[{\"index\":0,\"exit\":true,\"reason\":\"...\"}]}",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "index\tsymbol\taddress\tpnlBps\tageSec\ttakeProfitBps\tstopLossBps",
        ...rows,
        ...(input.featureBlocks?.some(Boolean) ? [FEATURE_PROMPT_GUIDANCE, ...input.featureBlocks] : []),
        advisoryBlock(input.owner),
      ].join("\n"),
    },
  ];
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapOptionalFence(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? null;
}

function parseDecisionArray(raw: string, shortlistLength: number): readonly unknown[] | null {
  const body = unwrapOptionalFence(raw);
  if (body === null || Buffer.byteLength(body, "utf8") > MAX_LLM_RESPONSE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed["decisions"])) {
    return null;
  }
  return parsed["decisions"].length <= shortlistLength ? parsed["decisions"] : null;
}

export type EntryLlmDecision = {
  readonly index: number;
  readonly enter: boolean;
  readonly confidence: number;
  readonly reason: string;
};

export type ExitLlmDecision = {
  readonly index: number;
  readonly exit: boolean;
  readonly reason: string;
};

export type LlmValidationResult<T> =
  | { readonly ok: true; readonly decisions: readonly T[]; readonly duplicateIndexes: readonly number[] }
  | { readonly ok: false; readonly reason: "llm-invalid"; readonly decisions: readonly []; readonly duplicateIndexes: readonly [] };

function invalid<T>(): LlmValidationResult<T> {
  return { ok: false, reason: "llm-invalid", decisions: [], duplicateIndexes: [] };
}

export function validateEntryResponse(
  raw: string,
  shortlistLength: number,
): LlmValidationResult<EntryLlmDecision> {
  const rows = parseDecisionArray(raw, shortlistLength);
  if (rows === null) return invalid();
  const decisions: EntryLlmDecision[] = [];
  const duplicates: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const index = row["index"];
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= shortlistLength) continue;
    const normalizedIndex = index as number;
    if (seen.has(normalizedIndex)) {
      duplicates.push(normalizedIndex);
      continue;
    }
    seen.add(normalizedIndex);
    const confidence = row["confidence"];
    if (!Number.isInteger(confidence) || (confidence as number) < 0 || (confidence as number) > 100) continue;
    if (typeof row["enter"] !== "boolean" || typeof row["reason"] !== "string") continue;
    decisions.push({
      index: normalizedIndex,
      enter: row["enter"],
      confidence: confidence as number,
      reason: row["reason"].slice(0, MAX_LLM_REASON_CHARS),
    });
  }
  return { ok: true, decisions, duplicateIndexes: duplicates };
}

export function validateExitResponse(
  raw: string,
  shortlistLength: number,
): LlmValidationResult<ExitLlmDecision> {
  const rows = parseDecisionArray(raw, shortlistLength);
  if (rows === null) return invalid();
  const decisions: ExitLlmDecision[] = [];
  const duplicates: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const index = row["index"];
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= shortlistLength) continue;
    const normalizedIndex = index as number;
    if (seen.has(normalizedIndex)) {
      duplicates.push(normalizedIndex);
      continue;
    }
    seen.add(normalizedIndex);
    if (typeof row["exit"] !== "boolean" || typeof row["reason"] !== "string") continue;
    decisions.push({
      index: normalizedIndex,
      exit: row["exit"],
      reason: row["reason"].slice(0, MAX_LLM_REASON_CHARS),
    });
  }
  return { ok: true, decisions, duplicateIndexes: duplicates };
}

/** Missing indices stay absent and therefore are never entered (R7). */
export function enteredIndexes(
  model: TradeExecutionModel,
  result: LlmValidationResult<EntryLlmDecision>,
): readonly number[] {
  if (!result.ok) return [];
  const minimum = TRADE_MODEL_PRESETS[model].minConfidence;
  return result.decisions
    .filter((decision) => decision.enter && decision.confidence >= minimum)
    .sort((left, right) => model === "blue-chip" || model === "sigma"
      ? right.confidence - left.confidence || left.index - right.index : 0)
    .map((decision) => decision.index);
}

type OpenRouterResponse = {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | readonly { readonly type?: string; readonly text?: string }[];
    };
  }[];
};

export class TradeLlmError extends Error {
  constructor(message: string) {
    super(sanitizeSecretLikeText(message, 240));
    this.name = "TradeLlmError";
  }
}

export type TradeLlm = {
  readonly complete: (
    messages: readonly OpenRouterMessage[],
    signal?: AbortSignal,
  ) => Promise<{ readonly content: string; readonly model: string }>;
};

export type CreateTradeLlmInput = {
  readonly readKey: () => string;
  readonly fetch?: FetchLike;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
};

/** The key lives only in this closure; prompt and result records have no credential field. */
export function createTradeLlm(input: CreateTradeLlmInput): TradeLlm {
  const key = input.readKey().trim();
  if (key === "") throw new TradeLlmError("OpenRouter is not configured.");
  const fetchFn = input.fetch ?? ((url, init) => fetch(url, init));
  const model = input.model?.trim() || DEFAULT_TRADE_LLM_MODEL;
  const baseUrl = (input.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/u, "");
  const timeoutMs = input.timeoutMs ?? TRADE_LLM_TIMEOUT_MS;
  return Object.freeze({
    async complete(messages, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          // 0G's own `0gm-*` models spend the whole completion on reasoning
          // unless thinking is disabled (measured 2026-09-03: 12 s and an empty
          // body with it on, 1.2 s and a valid answer with it off). Ported from
          // `D:\4lpha-0G\lib\copilot\router.ts`; every other provider ignores it.
          body: JSON.stringify({
            model, messages, stream: false, temperature: 0.35,
            ...(model.toLowerCase().startsWith("0gm-")
              ? { chat_template_kwargs: { enable_thinking: false } }
              : {}),
          }),
          signal: composed,
        });
      } catch (cause) {
        throw new TradeLlmError(cause instanceof Error ? cause.message : "OpenRouter request failed.");
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new TradeLlmError(detail || `OpenRouter returned status ${response.status}.`);
      }
      let body: OpenRouterResponse;
      try {
        body = await response.json() as OpenRouterResponse;
      } catch {
        throw new TradeLlmError("OpenRouter returned malformed JSON.");
      }
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim() !== "") {
        return { content: content.trim(), model };
      }
      if (Array.isArray(content)) {
        const text = content
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text?.trim() ?? "")
          .filter((item) => item !== "")
          .join("\n");
        if (text !== "") return { content: text, model };
      }
      throw new TradeLlmError("OpenRouter returned an empty response.");
    },
  });
}

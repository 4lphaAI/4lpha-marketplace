/**
 * JEV-MEME-BENCHMARK-PLAN section 3.1: the Jev shadow of the meme arbiter. One plain `fetch` to TypeSafe's System One API, a request built from the same state the LLM
 * gets, and a strict parser. Measurement only: nothing in this file decides, vetoes, sizes or exits anything, and the API key is never logged.
 * The wire shape (question schema, `answers` keyed by question id) is confined to `memeJevRequest` and `parseMemeJev`.
 */
import { MEME_DOCTRINE } from "./memeBrain.js";

export const MEME_JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const MEME_JEV_MODEL = "jev-latest";
export const MEME_JEV_TIMEOUT_MS = 3_000;
const OPTIONS = ["buy_now", "wait", "reject"] as const;
type Choice = (typeof OPTIONS)[number];

/** The shadow's inputs: the key and the fetch (injected so tests never touch the network). */
export type MemeJevConfig = { apiKey: string; fetch: typeof fetch };
/** `pUp60` (operator 2026-10-07): Jev's probability that the price is higher in 60 minutes by more than the round-trip cost; null when that answer is missing or malformed. */
export type MemeJevAnswer = { index: number; choice: Choice; pBuy: number; pWait: number; pReject: number; confidence: number; pUp60: number | null };
/** What is logged: `outcome` is `late` only when the lane gave up waiting (memeLane.ts); the other four come from the request itself. `latencyMs` is always Jev's own milliseconds since its request started
 *  (for `late`, until the lane stopped waiting), never the LLM's. */
export type MemeJevData = { model: string | null; latencyMs: number; outcome: "ok" | "late" | "timeout" | "error" | "invalid"; answers: MemeJevAnswer[]; inputTokens: number | null };

/** AGENTIC_MEME_JEV_SHADOW exactly "true" and a non-empty TYPESAFE_API_KEY, else undefined (no request is ever made); never refuses boot, it only measures. */
export function memeJevConfig(env: NodeJS.ProcessEnv): MemeJevConfig | undefined {
  const apiKey = env["TYPESAFE_API_KEY"]?.trim() ?? "";
  return env["AGENTIC_MEME_JEV_SHADOW"] === "true" && apiKey !== "" ? { apiKey, fetch: (input, init) => globalThis.fetch(input, init) } : undefined;
}

/**
 * `state` is the LLM's user content parsed back (JSON.stringify of it is the same bytes); one Choice per candidate index, answered independently. The shadow's question ends with the LLM's own
 * sentence (every candidate passed the deterministic checks); only the scan (`dropped`) says the candidate was dropped and names the `verdict` field (review H1).
 * Operator 2026-10-07: a second, independent question per index (`f<i>`, a Noul) asks the forecast directly, so its probability can be scored against the 60-minute net outcome.
 */
export function memeJevRequest(stateContent: string, k: number, dropped: boolean): { model: string; state: unknown; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < k; i += 1) {
    questions[`c${i}`] = { type: "choice",
      instructions: `Judge the candidate \`candidates[${i}]\` of the state as an entry for a meme-stock paper trading agent. Doctrine: ${MEME_DOCTRINE} `
        + (dropped ? "The candidate was dropped by a deterministic check, named by its `verdict` field; judge it on its numbers regardless." : "Every candidate already passed the deterministic checks."),
      criteria: {
        buy_now: "A volume burst with follow-through, buys over sells, a live chart and no smart-money outflow: enter now.",
        wait: "A partial or unclear setup that may mature: do not enter yet.",
        reject: "A dead chart, sells over buys, smart-money outflow or no follow-through: do not enter." } };
    questions[`f${i}`] = { type: "noul",
      instructions: {
        question: `Will the price of the meme token \`candidates[${i}]\` be higher 60 minutes from now than it is now, by more than its round-trip cost?`,
        cost: `\`candidates[${i}].costBps\` is the estimated round-trip cost in basis points (fees, token taxes, price impact and gas); the move must beat it.`,
        inputs: "The evidence: volume and trade bursts (`burstRatio`, `followRatio`, `volume5mUsd`, `volume1hUsd`, `txs5m`), buyers against sellers (`flow5m`, `flow1h`), "
          + "smart-money net inflow (`smartInflow5m`, `smartInflow1h`), how far it already ran (`extensionPct`, `priceChange5mPct`, `priceChange1hPct`) and chart health (`deadScore`, `drawdown60`)." },
      criteria: { true: "Higher after 60 minutes by more than `costBps`", false: "Not higher by more than `costBps` after 60 minutes: lower, flat, or up by less than the cost" } };
  }
  return { model: MEME_JEV_MODEL, state: JSON.parse(stateContent) as unknown, questions };
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Strict: every index answered with a Choice whose probabilities are exactly the three options, each finite in 0..1; anything else is null (outcome `invalid`).
 *  The forecast Noul (`f<i>`) is read on its own: a missing or malformed one leaves `pUp60` null and never invalidates the Choice. */
export function parseMemeJev(raw: unknown, k: number): { model: string | null; inputTokens: number | null; answers: MemeJevAnswer[] } | null {
  if (!record(raw) || !record(raw["answers"])) return null;
  const ids = new Set(Array.from({ length: k }, (_, i) => [`c${i}`, `f${i}`]).flat());
  if (Object.keys(raw["answers"]).some(id => !ids.has(id))) return null;
  const answers: MemeJevAnswer[] = [];
  for (let index = 0; index < k; index += 1) {
    const a = raw["answers"][`c${index}`];
    if (!record(a) || a["type"] !== "choice" || !OPTIONS.includes(a["choice"] as Choice) || !record(a["probabilities"])
      || Object.keys(a["probabilities"]).sort().join(",") !== [...OPTIONS].sort().join(",") || !unit(a["confidence"])) return null;
    const p = a["probabilities"];
    if (!unit(p["buy_now"]) || !unit(p["wait"]) || !unit(p["reject"])) return null;
    const f = raw["answers"][`f${index}`], pUp60 = record(f) && f["type"] === "noul" && unit(f["noul"]) ? f["noul"] : null;
    answers.push({ index, choice: a["choice"] as Choice, pBuy: p["buy_now"], pWait: p["wait"], pReject: p["reject"], confidence: a["confidence"], pUp60 });
  }
  const usage = raw["usage"], tokens = record(usage) ? usage["input_tokens"] : null;
  return { model: typeof raw["model"] === "string" ? raw["model"] : null, inputTokens: typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0 ? tokens : null, answers };
}

/** One request, never throws: every failure is an outcome. `signal` lets the lane abort a request it stopped waiting for; the 3 000 ms bound is always applied. */
export async function askMemeJev(config: MemeJevConfig, stateContent: string, k: number, signal: AbortSignal | undefined, dropped: boolean): Promise<MemeJevData> {
  const started = Date.now(), done = (outcome: MemeJevData["outcome"], rest: Partial<MemeJevData> = {}): MemeJevData =>
    ({ model: null, latencyMs: Date.now() - started, outcome, answers: [], inputTokens: null, ...rest });
  let body: string;
  try { body = JSON.stringify(memeJevRequest(stateContent, k, dropped)); } catch { return done("error"); }
  let response: Response;
  try {
    const bound = AbortSignal.timeout(MEME_JEV_TIMEOUT_MS);
    response = await config.fetch(MEME_JEV_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body,
      signal: signal === undefined ? bound : AbortSignal.any([bound, signal]) });
  } catch (error) { return done(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "error"); }
  if (!response.ok) { response.body?.cancel().catch(() => undefined); return done("error"); }
  let raw: unknown;
  try { raw = await response.json(); } catch (error) { return done(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "invalid"); }
  const parsed = parseMemeJev(raw, k);
  return parsed === null ? done("invalid", { model: record(raw) && typeof raw["model"] === "string" ? raw["model"] : null }) : done("ok", parsed);
}

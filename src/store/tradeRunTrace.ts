import { sanitizeMessage } from "../core/errors.js";

/** Observations only: never consumed by execution, reconciliation or authorization. */
export type TradeRunEvent = {
  readonly stage: "screen" | "entry-llm" | "exit-llm" | "route" | "buy" | "sell" | "cycle";
  readonly code: string;
  readonly elapsedMs: number;
  readonly token?: string;
  readonly model?: string;
  readonly reason?: string;
  readonly confidence?: number;
};

const STAGES = new Set(["screen", "entry-llm", "exit-llm", "route", "buy", "sell", "cycle"]);
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeMessage(value
    .replace(/\b(?:sk-[\w-]+|dg-[\w-]{16,})/gu, "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(?:api[-_]?key|secret|signature|credential|access[-_]?token)\s*[:=]\s*\S+/giu, "[redacted]"))
    .slice(0, limit);
}

/** A closed, bounded projection on BOTH write and read, including old/corrupt rows. */
export function normalizeTradeRunEvents(value: unknown): readonly TradeRunEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item: unknown): TradeRunEvent[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    if (typeof row["stage"] !== "string" || !STAGES.has(row["stage"])) return [];
    const code = text(row["code"], 80);
    if (code === undefined) return [];
    const model = text(row["model"], 80);
    const reason = text(row["reason"], 280);
    const token = typeof row["token"] === "string" && /^0x[\da-f]{40}$/iu.test(row["token"]) ? row["token"] : undefined;
    const confidence = row["confidence"];
    const elapsed = row["elapsedMs"];
    return [{ stage: row["stage"] as TradeRunEvent["stage"], code,
      elapsedMs: typeof elapsed === "number" && Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0,
      ...(token === undefined ? {} : { token }), ...(model === undefined ? {} : { model }),
      ...(reason === undefined ? {} : { reason }),
      ...(typeof confidence === "number" && Number.isInteger(confidence) && confidence >= 0 && confidence <= 100 ? { confidence } : {}),
    }];
  });
}

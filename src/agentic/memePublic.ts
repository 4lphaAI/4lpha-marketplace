/**
 * Operator hotfix 2026-10-06: two read-only blocks of a paper meme hire's public view, built only from `agentic_meme_log` rows (no Binance or data-plane call).
 * `lastCycle` is counts only (no token address); `decisionLog` is the local debug view of the decision log, added only with AGENTIC_MEME_DECISION_LOG_PUBLIC=true.
 * Log row ids embed the agent id, so only `data` fields leave this file.
 */
import type { AgenticMemeLog } from "./domain.js";

/** Lane tallies that are not rejection reasons (memeLane.ts `bump` keys). */
const COUNTERS: ReadonlySet<string> = new Set(["entered", "exits", "llmAsked", "llmBuy", "quoteFailures"]);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

export type MemeLastCycle = { atMs: number; code: string | null; listSize: number | null; checked: number | null; passedScreen: number | null;
  reasons: Record<string, number>; llmAsked: number; paperEntries: number; paperExits: number; barLagMs: number | null; elapsedMs: number | null };

/** The newest `cycle` row of this agent, as counts. */
export function memeLastCycle(rows: readonly AgenticMemeLog[]): MemeLastCycle | null {
  const row = rows.filter(r => r.kind === "cycle").at(-1);
  if (row === undefined || !record(row.data)) return null;
  const d = row.data, counts = record(d["counts"]) ? d["counts"] : {}, picked = record(d["picked"]) ? d["picked"] : null;
  const reasons: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) if (!COUNTERS.has(key) && num(value) !== null) reasons[key] = value as number;
  const pickedValues = picked === null ? [] : Object.values(picked).map(num);
  return { atMs: row.atMs, code: str(d["code"]), listSize: picked === null || pickedValues.some(v => v === null) ? null : pickedValues.reduce((s, v) => s! + v!, 0),
    checked: num(d["barsRequested"]), passedScreen: num(d["survivors61"]), reasons, llmAsked: num(counts["llmAsked"]) ?? 0, paperEntries: num(counts["entered"]) ?? 0,
    paperExits: num(counts["exits"]) ?? 0, barLagMs: num(d["barLagMedianMs"]), elapsedMs: num(d["elapsedMs"]) };
}

/** One shortlist row of the newest global `market` row, by the memeLane.ts `marketTuple` / `brainTuple` indexes. */
function marketRow(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || !Array.isArray(value[0]) || !Array.isArray(value[1])) return null;
  const m = value[0] as unknown[], b = value[1] as unknown[];
  if (str(m[0]) === null) return null;
  return { address: m[0], stage: str(m[2]), status: str(m[3]), category: str(m[4]), venue: str(m[5]), buyTaxBps: num(m[6]), sellTaxBps: num(m[7]),
    liquidityUsd: num(m[8]), volume5mUsd: num(m[10]), txs5m: num(m[11]), flow5mBuys: num(m[12]), flow5mSells: num(m[13]), smart5mNetUsd: num(m[16]), smart1hNetUsd: num(m[18]),
    quoteSymbol: str(m[21]), flags: Array.isArray(m[24]) ? (m[24] as unknown[]).filter((f): f is string => typeof f === "string") : [],
    verdict: str(b[0]), barLagMs: num(b[1]), bars: num(b[3]), deadScore: num(b[5]), hardVeto: bool(b[6]), burstRatio: num(b[8]), burstReason: str(b[9]),
    followRatio: num(b[10]), extensionPct: num(b[11]), range15Bps: num(b[12]), costEstBps: num(b[13]) };
}

/** Jev benchmark (operator 2026-10-07, display only): one Jev answer as probabilities; nothing here feeds a decision. */
function jevAnswer(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  return { index: num(value["index"]), token: str(value["token"]), verdict: str(value["verdict"]), choice: str(value["choice"]),
    pBuy: num(value["pBuy"]), pWait: num(value["pWait"]), pReject: num(value["pReject"]), pUp60: num(value["pUp60"]) };
}
function jevOf(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  return { outcome: str(value["outcome"]), model: str(value["model"]), latencyMs: num(value["latencyMs"]),
    answers: Array.isArray(value["answers"]) ? value["answers"].map(jevAnswer).filter(a => a !== null) : [] };
}

/** `market`: the newest global market row (rows from any agent's window, kind `market`); `signals` and `llm`: this agent's newest rows (`llm[].jev`: the Jev shadow on
 * the same ask); `jevScan`: the newest Jev scans of the filtered shortlist tokens (global `jev` rows). Jev fields are display only (Jev benchmark, operator 2026-10-07). */
export function memeDecisionLog(agentRows: readonly AgenticMemeLog[], globalRows: readonly AgenticMemeLog[], jevRows: readonly AgenticMemeLog[] = []): Record<string, unknown> {
  const markets = globalRows.filter(r => r.kind === "market" && r.agentId === null), market = markets.at(-1), previous = markets.at(-2);
  const rows = market !== undefined && record(market.data) && Array.isArray(market.data["rows"]) ? (market.data["rows"] as unknown[]).slice(0, 40).map(marketRow).filter(r => r !== null) : [];
  return {
    // Operator 2026-10-07: when this read was written, the one before it (the cadence) and the data plane's own shortlist time, so a stuck feed is visible.
    market: market === undefined ? null : { atMs: market.atMs, prevAtMs: previous?.atMs ?? null, asOf: record(market.data) ? num(market.data["asOf"]) : null, rows },
    signals: agentRows.filter(r => r.kind === "signal" && record(r.data)).slice(-20).reverse().map(r => { const d = r.data as Record<string, unknown>;
      return { atMs: r.atMs, token: str(d["token"]), verdict: str(d["verdict"]), costEstBps: num(d["costEst"]), costRule: bool(d["costRule"]), llm: str(d["llm"]), barLagMs: num(d["barLagMs"]) }; }),
    llm: agentRows.filter(r => r.kind === "llm" && record(r.data)).slice(-10).reverse().map(r => { const d = r.data as Record<string, unknown>;
      return { atMs: r.atMs, model: str(d["model"]), outcome: str(d["outcome"]), latencyMs: num(d["latencyMs"]), tokens: Array.isArray(d["tokens"]) ? d["tokens"] : [],
        decisions: Array.isArray(d["decisions"]) ? d["decisions"] : null, jev: jevOf(d["jev"]) }; }),
    jevScan: jevRows.filter(r => r.kind === "jev" && r.agentId === null && record(r.data)).slice(-10).reverse().map(r => ({ atMs: r.atMs, ...jevOf(r.data) })),
  };
}

/**
 * The desk's work hook: read the request, validate it, run the right handler, return the Markdown report.
 *
 * Order matters for money: nothing is fetched and nothing is paid until a request has passed the closed
 * schema (request.ts); the paid x402 data point is bought after the free data is in hand, once per job.
 * Jobs run one at a time so the public MCP limit holds.
 *
 * Two backstops make sure a funded job always gets a deliverable:
 *  - a top-level guard: any unexpected throw becomes a short "could not complete" report that carries the
 *    sections computed so far (a thrown hook would leave the escrow stuck, because the core retries the
 *    same failure on every sweep);
 *  - a soft deadline below the core's own delivery timeout (which cancels nothing): when it passes, no new
 *    request, no new payment and no model call is started, and what has been computed is delivered.
 */

import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { deliveryTimeoutSeconds } from "../deliveryPolicy.js";
import type { RunWork } from "../sellerCore.js";
import { defaultBuy, type BuyFn } from "./backdrop.js";
import { NOT_ADVICE } from "./fmt.js";
import { dcaPlanReport, rebalanceReport, stockReport, type Built, type DeskDeps } from "./handlers.js";
import { safeText } from "./json.js";
import { createMcpClient, type McpClient } from "./mcp.js";
import { defaultLlm, mapFreeText, type Llm } from "./prose.js";
import { extractRaw, formatsNoteWithReason, validateRequest, type DeskRequest } from "./request.js";

export interface DeskJob {
  readonly task: string;
  readonly terms: Record<string, unknown> | null;
}

/** Share of the core's delivery timeout the desk allows itself (the core's timer cancels nothing). */
export const DEADLINE_SHARE = 0.9;

function notUnderstood(reason: string | null): Built {
  return { markdown: formatsNoteWithReason(reason), summaryBy: "none", backdrop: "none" };
}

/** A short, safe reason: the error class and a cleaned fragment of its message. */
export function safeReason(e: unknown): string {
  if (e instanceof Error) {
    const msg = safeText(e.message, 100);
    return `${safeText(e.name, 40) || "Error"}${msg === "" ? "" : `: ${msg}`}`;
  }
  return "unexpected error";
}

function couldNotComplete(reason: string, sections: readonly string[]): Built {
  const lines = [
    "# 4lpha bStock Desk: could not complete",
    "",
    `This job could not be completed: ${reason}.`,
    "The problem is on the desk side, not in the request. Nothing below is a full report.",
    "",
  ];
  if (sections.length > 0) lines.push("## Sections computed before the problem", "", ...sections);
  else lines.push("No section was computed before the problem.");
  lines.push("", "---", NOT_ADVICE);
  return { markdown: lines.join("\n"), summaryBy: "none", backdrop: "none" };
}

export async function runRequest(req: DeskRequest, d: DeskDeps): Promise<Built> {
  if (req.type === "stock_report") return stockReport(req, d);
  if (req.type === "dca_plan") return dcaPlanReport(req, d);
  return rebalanceReport(req, d);
}

async function buildInner(job: DeskJob | null, d: DeskDeps): Promise<Built> {
  const raw = job === null ? ({ kind: "empty" } as const) : extractRaw(job.task, job.terms);
  if (raw.kind === "empty") return notUnderstood(null);
  let candidate = raw.kind === "json" ? raw.value : await mapFreeText(d.llm, raw.text, d.signal);
  if (candidate === null || candidate === undefined) candidate = {};
  const parsed = validateRequest(candidate);
  if (!parsed.ok) return notUnderstood(raw.kind === "json" ? parsed.reason : null);
  return runRequest(parsed.request, d);
}

/**
 * Build the deliverable. Never throws: a funded job always gets a report, the formats note, or a
 * "could not complete" report with whatever was computed.
 */
export async function buildDeliverable(job: DeskJob | null, d: DeskDeps): Promise<Built> {
  const progress = d.progress ?? { sections: [] as string[] };
  if (d.signal?.aborted === true) return couldNotComplete("the delivery time limit was reached before work started", []);
  try {
    return await buildInner(job, { ...d, progress });
  } catch (e) {
    return couldNotComplete(safeReason(e), progress.sections);
  }
}

let tail: Promise<unknown> = Promise.resolve();

/** One job at a time, in arrival order. */
export function runSerially<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}

/** Test seams for the production wiring. */
export interface DeskWiring {
  readonly client?: McpClient;
  readonly buy?: BuyFn | null;
  readonly llm?: Llm | null;
  readonly now?: () => number;
  /** the soft deadline in ms from the moment the core calls the hook (default 90 % of the core timeout) */
  readonly deadlineMs?: number;
}

export function buildDeskRunWork(getModel: () => LanguageModel, wiring: DeskWiring = {}): RunWork {
  const client = wiring.client ?? createMcpClient();
  const llm: Llm | null = wiring.llm === undefined ? defaultLlm(getModel) : wiring.llm;
  const buy: BuyFn | null = wiring.buy === undefined ? defaultBuy : wiring.buy;
  const now = wiring.now ?? (() => Date.now());
  return (prompt, opts) => {
    // the clock starts when the core asks for the work, so time spent queued behind another job counts
    const deadlineAt = now() + (wiring.deadlineMs ?? deliveryTimeoutSeconds() * 1000 * DEADLINE_SHARE);
    return runSerially(async () => {
      const ctl = new AbortController();
      const onParent = (): void => ctl.abort();
      if (opts.abortSignal?.aborted === true) ctl.abort();
      else opts.abortSignal?.addEventListener("abort", onParent, { once: true });
      const remaining = deadlineAt - now();
      const timer = remaining <= 0 ? undefined : setTimeout(() => ctl.abort(), remaining);
      if (remaining <= 0) ctl.abort();
      try {
        const job: DeskJob | null = opts.job ?? { task: prompt, terms: null };
        // the backdrop cache is keyed by job; the shared "b402" session id must never be a cache key
        const jobKey = opts.sessionId === "b402" ? randomUUID() : opts.sessionId;
        const built = await buildDeliverable(job, { client, buy, llm, now, jobKey, signal: ctl.signal });
        console.log(`[desk] job ${opts.sessionId} delivered (summary: ${built.summaryBy}, backdrop: ${built.backdrop}${ctl.signal.aborted ? ", deadline reached" : ""})`);
        return built.markdown;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        opts.abortSignal?.removeEventListener("abort", onParent);
      }
    });
  };
}

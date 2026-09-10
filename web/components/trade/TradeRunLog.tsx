"use client";

import { useState } from "react";
import type { TradeView } from "@/lib/trade";
import { relativeTime } from "@/lib/exec/agent-detail";

type Run = TradeView["runs"][number];
export function hasExecutedTrade(run: Run): boolean {
  if (run.dryRun) return false;
  // Entry counts are attempts; route selection and executor denials are not trades.
  return (run.events ?? []).some((event) => (event.stage === "buy" || event.stage === "sell") && event.code === "committed")
    || run.exits > 0 || run.reason.split(";")[0] === "entered";
}

/**
 * AGENT-GAS-ATTENTION §5 — which bucket a trade CYCLE belongs to.
 *
 * A trade run is not a sequence, so the LP classifier does not transfer: most
 * cycles legitimately do nothing at all (nothing passed screening, the LLM
 * chose to wait) and calling those "failed" would bury the ones that actually
 * broke. So:
 *
 *   succeeded — something was committed on chain (a buy or a sell landed);
 *   failed    — the cycle tried and could not: an agent error, a refused
 *               entry, a route it could not build, or a wallet that could not
 *               pay for gas;
 *   quiet     — it ran, decided to do nothing, and that was correct.
 *
 * `quiet` is visible under "All cycles" and under neither of the two buckets,
 * which is the same three-way shape the LP log takes and for the same reason.
 */
export type RunOutcome = "succeeded" | "failed" | "quiet";

const FAILED_CODES = new Set([
  "agent-error", "no-route", "entry-budget-too-small", "llm-invalid", "llm-unavailable",
]);

/**
 * A cycle that REACHED the executor and did not commit.
 *
 * REVIEW FINDING 7: the first build classified only on the run's summary
 * `reason`, so a buy denied `DAILY_CAP` and a refused sell both landed under
 * "quiet" — the two cycles most worth finding, filed as "nothing happened".
 * The events carry the truth: a `buy`/`sell` stage that ended on anything but
 * `committed` is an attempt that failed.
 */
function hasFailedExecution(run: Run): boolean {
  return (run.events ?? []).some(
    (event) => (event.stage === "buy" || event.stage === "sell") && event.code !== "committed",
  );
}

/**
 * REVIEW 2 — the buckets are PREDICATES, not a single label, because one trade
 * cycle can genuinely be both.
 *
 * A cycle that committed a sell AND had its buy refused `DAILY_CAP` returned
 * `"succeeded"` under the first build, so the refusal — the actionable half —
 * vanished from Failed. Forcing a total order on a cycle that did two things
 * means one of them is always hidden. A run may now appear under BOTH filters,
 * which is what actually happened.
 */
export function runSucceeded(run: Run): boolean {
  return !run.dryRun && hasExecutedTrade(run);
}

export function runFailed(run: Run): boolean {
  if (run.dryRun) return false;
  if (hasFailedExecution(run)) return true;
  const code = run.reason.split(";")[0] ?? run.reason;
  // The gas gate reports its remedy sentence rather than a code, and a cycle
  // the worker stood down is a cycle that could not run.
  return FAILED_CODES.has(code) || code.startsWith("agent-error") || /^Deposit /u.test(run.reason);
}

export function runOutcome(run: Run): RunOutcome {
  // Retained for callers that want ONE label; the filters use the predicates,
  // and where a cycle is both, failure is the half worth surfacing.
  if (runFailed(run)) return "failed";
  return runSucceeded(run) ? "succeeded" : "quiet";
}

export function runLabel(reason: string): string {
  const code = reason.split(";")[0] ?? reason;
  const labels: Record<string, string> = {
    "at-capacity": "All position slots occupied", "no-route": "No usable buy route",
    "entered": "Buy execution committed", "llm-hold": "LLM chose to wait",
    "no-candidates": "No candidates passed screening", "llm-invalid": "LLM response rejected",
    "llm-unavailable": "LLM unavailable", "draining": "Closing positions",
    "entry-budget-too-small": "Entry budget cannot cover fees", "dry-run": "Simulation completed",
  };
  return labels[code] ?? code.replace(/[-_]/gu, " ");
}

export function TradeRunLog({ runs, symbols }: { readonly runs: readonly Run[]; readonly symbols: Readonly<Record<string, string>> }) {
  const [filter, setFilter] = useState("all");
  const shown = runs.filter((run) => filter === "all"
    || (filter === "llm" ? (run.events ?? []).some((event) => event.stage.endsWith("llm"))
    : filter === "succeeded" ? runSucceeded(run)
    : filter === "failed" ? runFailed(run)
    : hasExecutedTrade(run)));
  return <div className="fl-run-feed">
    <div className="fl-run-filters">{[["all", "All cycles"], ["succeeded", "Succeeded"], ["failed", "Failed"], ["activity", "Trades"], ["llm", "LLM decisions"]].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{label}</button>)}</div>
    <div className="fl-run-scroll" role="region" aria-label="Run history" tabIndex={0}>
    {shown.map((run) => <details className="fl-run-card" key={run.id}>
      <summary><span className={`fl-run-dot ${run.entries > 0 || run.exits > 0 ? "is-active" : ""}`} /><div><strong>{runLabel(run.reason)}</strong><p>{run.candidates} shortlisted · {run.entries} buy attempts · {run.exits} closed · {run.refusals} skipped/refused{run.dryRun ? " · simulation" : ""}</p></div><time title={new Date(run.createdAt).toISOString()}>{relativeTime(run.createdAt, Date.now()).text}</time><span aria-hidden="true">⌄</span></summary>
      <div className="fl-run-detail"><div className="fl-run-meta">{new Date(run.createdAt).toLocaleString()} · Run {run.id}</div>
        {(run.events?.length ?? 0) > 0 ? <ol>{run.events!.map((event, i) => <li key={i}>
          <span className="fl-run-stage">{event.stage.replace(/-/gu, " ")} <small>+{(event.elapsedMs / 1000).toFixed(1)}s</small></span>
          <div><strong>{event.code.replace(/[-_]/gu, " ")}</strong>{event.token ? <span title={event.token}> · {symbols[event.token.toLowerCase()] ?? `${event.token.slice(0, 6)}…${event.token.slice(-4)}`}</span> : null}{event.confidence === undefined ? null : <span className="fl-run-confidence">{event.confidence}% confidence</span>}
            {event.model ? <small className="fl-run-model">LLM model: {event.model}</small> : null}{event.reason ? <p>{event.reason}</p> : null}</div>
        </li>)}</ol> : <p>Historical cycle: only summary counts were recorded. Detailed LLM and route events are available for new cycles.</p>}
        <details className="fl-run-raw"><summary>Raw summary</summary><code>{run.reason}</code></details>
      </div>
    </details>)}
    {shown.length === 0 ? <div className="fl-trade-empty">{runs.length === 0 ? "No runs yet." : filter === "activity" ? `No executed trades in the latest ${runs.length} cycles.` : "No matching cycles in this history."}</div> : null}
    </div>
  </div>;
}

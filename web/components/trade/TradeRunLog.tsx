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
  const shown = runs.filter((run) => filter === "all" || (filter === "llm"
    ? (run.events ?? []).some((event) => event.stage.endsWith("llm"))
    : hasExecutedTrade(run)));
  return <div className="fl-run-feed">
    <div className="fl-run-filters">{[["all", "All cycles"], ["activity", "Trades"], ["llm", "LLM decisions"]].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{label}</button>)}</div>
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

"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { Button, Icon, SegmentedToggle } from "@/design-system";
import type { TradeSimulationLog as Log, TradeSimulationRow } from "@/lib/exec/types";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const COLS = "minmax(150px,1.2fr) 56px 90px 64px minmax(150px,1.3fr) 130px 130px 110px 72px minmax(140px,1.4fr)";
const UNAVAILABLE: Record<string, string> = {
  "no-table": "the simulation log has not been created yet (pre-flight simulation has not run on this plane)",
  "store-unavailable": "the simulation log could not be read from the execution plane",
};

function shortAddress(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** 18-decimal atomic (bStocks and BSC USDT) to 6 significant decimals. */
function amount(atomic: string): string {
  const value = BigInt(atomic);
  const n = Number(formatUnits(value < 0n ? -value : value, 18));
  const text = (n >= 1 ? n.toFixed(6) : n.toPrecision(6)).replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
  return value < 0n ? `-${text}` : text;
}

function resultLabel(row: TradeSimulationRow): string {
  if (row.outcome === "success") return "Passed";
  if (row.outcome === "reverted") return row.blocked ? "Blocked" : "Reverted (logged)";
  if (row.outcome === "failed-other") return "Failed (logged)";
  if (row.outcome === "guard-deadline") return "Guard deadline";
  return `Not simulated (${row.reason ?? "unknown"})`;
}

function missingActual(row: TradeSimulationRow): string {
  if (row.blocked) return "blocked, not submitted";
  return row.journalState === "COMMITTED" ? "not recorded" : "not landed";
}

function dash(reason: string) {
  return <span>-<small>{reason}</small></span>;
}

function deviation(row: TradeSimulationRow) {
  if (row.predictedOutAtomic === null) return dash("no prediction");
  if (row.actualOutAtomic === null) return dash(missingActual(row));
  const predicted = BigInt(row.predictedOutAtomic);
  if (predicted === 0n) return dash("predicted zero");
  const ppm = (BigInt(row.actualOutAtomic) - predicted) * 1_000_000n / (predicted < 0n ? -predicted : predicted);
  return <span>{`${ppm > 0n ? "+" : ""}${(Number(ppm) / 10_000).toFixed(4)}%`}</span>;
}

/**
 * Read-only pre-flight simulation log (TRADFI-PREFLIGHT-SIMULATE): what the
 * simulation predicted, what landed, and how far apart they were. Fetched when
 * the tab opens; Refresh re-reads it.
 */
export function TradeSimulationLog({ agentId, readHeaders, symbols }: {
  readonly agentId: string;
  readonly readHeaders: Readonly<Record<string, string>>;
  readonly symbols: Readonly<Record<string, string>>;
}) {
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/trade/simulations`, { headers: readHeaders, cache: "no-store", ...(signal === undefined ? {} : { signal }) });
      const body = await response.json() as { readonly data?: Log };
      if (signal?.aborted) return;
      if (!response.ok || body.data === undefined) { setError(UNAVAILABLE["store-unavailable"]!); return; }
      setLog(body.data); setError(null);
    } catch {
      if (!signal?.aborted) setError(UNAVAILABLE["store-unavailable"]!);
    }
  }, [agentId, readHeaders]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const symbol = (address: string) => address.toLowerCase() === USDT ? "USDT" : symbols[address.toLowerCase()] ?? shortAddress(address);
  const rows = log?.rows ?? [];
  const reason = error ?? (log?.unavailable ? UNAVAILABLE[log.unavailable] ?? log.unavailable : null);
  return <section className="fl-trade-table">
    <div className="fl-trade-table__bar"><span>Simulate</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void load()}>Refresh</Button></div>
    <div className="fl-trade-scroll fl-portfolio-table" role="region" aria-label="Simulation log" tabIndex={0}>
      <div className="fl-row__head" style={{ gridTemplateColumns: COLS, minWidth: 1180 }}><span>Time</span><span>Side</span><span>Token</span><span>Route</span><span>Result</span><span>Predicted</span><span>Actual</span><span>Deviation</span><span>Latency</span><span>Reason</span></div>
      {rows.map((row, index) => {
        const unit = symbol(row.outputToken);
        return <div className="fl-portfolio-row" style={{ gridTemplateColumns: COLS, minWidth: 1180 }} key={`${row.createdAt}:${index}`}>
          <time>{new Date(row.createdAt).toLocaleString()}</time>
          <span style={{ color: row.exposure === "increase" ? "var(--profit)" : "var(--loss)" }}>{row.exposure === "increase" ? "Buy" : "Sell"}</span>
          <span title={row.token}>{symbol(row.token)}</span>
          <span>{row.route === "guard" ? "Guard" : row.route === "direct" ? "Direct" : "None"}</span>
          <span>{resultLabel(row)}</span>
          <span>{row.predictedOutAtomic === null ? dash(row.outcome === "success" ? "not recorded" : "no prediction") : `${amount(row.predictedOutAtomic)} ${unit}`}</span>
          <span>{row.actualOutAtomic === null ? dash(missingActual(row)) : `${amount(row.actualOutAtomic)} ${unit}`}</span>
          {deviation(row)}
          <span>{row.latencyMs === null ? dash("not measured") : `${row.latencyMs} ms`}</span>
          <span title={row.failReason ?? undefined}>{row.failReason === null ? "-" : row.failReason.length > 40 ? `${row.failReason.slice(0, 40)}…` : row.failReason}</span>
        </div>;
      })}
      {rows.length === 0 ? <div className="fl-trade-empty">No simulations yet{reason === null ? "." : `: ${reason}.`}</div> : null}
    </div>
  </section>;
}

/** Operator 2026-10-02: the simulation log lives INSIDE the Run log tab, behind a Runs | Simulate toggle. */
export function RunLogPanel({ runLog, simulationLog }: { readonly runLog: ReactNode; readonly simulationLog?: ReactNode }) {
  const [view, setView] = useState<"Runs" | "Simulate">("Runs");
  if (simulationLog === undefined) return <>{runLog}</>;
  return <>
    <div style={{ display: "flex", marginBottom: 12 }}>
      <SegmentedToggle value={view} onChange={(next: string) => setView(next === "Simulate" ? "Simulate" : "Runs")} options={["Runs", "Simulate"]} />
    </div>
    {view === "Simulate" ? simulationLog : runLog}
  </>;
}

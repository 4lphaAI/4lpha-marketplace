"use client";

/**
 * DEMO MODE — the detail screen.
 *
 * The panel on the deploy form is a SUMMARY; this is where a visitor watches
 * one demo work. It is deliberately laid out like the live agent detail page —
 * a header, a metric row, a chart row, a table, a run log — because the whole
 * point of a demo is to show what hiring one would feel like.
 *
 * ─── AND DELIBERATELY NOT DISGUISED AS ONE ─────────────────────────────────
 *
 * Same shape, different chrome: dashed borders throughout, a DEMO badge beside
 * the name, every figure qualified "(simulated)", the plane's own disclosure
 * rendered verbatim at the foot, and no transaction hash, NFT id, registry id
 * or relay id anywhere — the plane sends all four as explicit nulls precisely
 * so this screen cannot invent them.
 *
 * It reuses NOTHING from `HiredAgentScreen`. Feeding demo figures through the
 * live detail component would have been less code and exactly the wrong trade:
 * that component's chrome IS the signal that a number is real.
 */
import * as React from "react";

import {
  DemoError,
  formatBnb,
  isGridDetail,
  isTradeDetail,
  readDemoAgent,
  readDemoFills,
  stopDemoAgent,
  type DemoAgentView,
  type DemoFillView,
} from "@/lib/demo/client";
import { RungLadder, ageText, fillLine, Dash, DemoDisclosureList, eyebrow, mono, subtle } from "./parts";

const POLL_MS = 15_000;

const shell: React.CSSProperties = { maxWidth: 1100, margin: "0 auto", padding: "26px 20px 60px", display: "grid", gap: 18 };
const panel: React.CSSProperties = {
  padding: "18px 20px",
  borderRadius: "var(--radius-lg)",
  background: "var(--raised)",
  border: "1px dashed var(--line-1)",
  display: "grid",
  gap: 14,
};

function Tile(props: { readonly label: string; readonly value: string; readonly hint?: string }) {
  return (
    <div style={{ display: "grid", gap: 5, padding: "12px 14px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", minWidth: 0 }}>
      <span style={eyebrow}>{props.label}</span>
      <span style={{ font: "var(--weight-medium) var(--text-lg)/1.1 var(--font-mono)", color: "var(--ink-1)", overflowWrap: "anywhere" }}>
        {props.value}
      </span>
      {props.hint === undefined ? null : <span style={subtle}>{props.hint}</span>}
    </div>
  );
}

export function DemoAgentDetail(props: { readonly demoId: string; readonly go: (route: string) => void }) {
  const [agent, setAgent] = React.useState<DemoAgentView | null | "missing">(null);
  const [fills, setFills] = React.useState<readonly DemoFillView[] | "failed" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const payload = await readDemoAgent(props.demoId);
      setAgent(payload.agent);
    } catch (caught) {
      // A demo belongs to an anonymous cookie: a 404 here usually means a
      // DIFFERENT browser or a cleared cookie, not a deleted agent, and saying
      // so is more use than "not found".
      setAgent(caught instanceof DemoError && caught.code === "not_found" ? "missing" : null);
    }
    try {
      const payload = await readDemoFills(props.demoId);
      setFills(payload.fills);
    } catch {
      setFills("failed");
    }
  }, [props.demoId]);

  React.useEffect(() => {
    void load();
    // Polls only while the tab is VISIBLE — a forgotten background tab should
    // not keep a service busy for a viewer who is not looking.
    const tick = (): void => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const stop = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await stopDemoAgent(props.demoId);
      await load();
    } catch (caught) {
      setError(caught instanceof DemoError ? caught.message : "Could not stop this demo.");
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button
      type="button"
      onClick={() => props.go("/account")}
      style={{ cursor: "pointer", background: "transparent", border: "none", padding: 0, color: "var(--text-subtle)", font: "var(--weight-regular) var(--text-sm)/1 var(--font-sans)" }}
    >
      ← Back to my agents
    </button>
  );

  if (agent === "missing") {
    return (
      <div style={shell}>
        {back}
        <div style={panel}>
          <span style={eyebrow}>Demo not found</span>
          <Dash reason="this demo was not created in this browser, or its session cookie is gone. Demos belong to the browser that made them and are not shared between devices." />
        </div>
      </div>
    );
  }
  if (agent === null) {
    return (
      <div style={shell}>
        {back}
        <span style={subtle}>Loading…</span>
      </div>
    );
  }

  const grid = isGridDetail(agent) ? agent.detail : null;
  const trade = isTradeDetail(agent) ? agent.detail : null;
  const accent = agent.kind === "grid" ? "var(--cat-grid)" : "var(--cat-yield)";

  return (
    <div style={shell}>
      {back}

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ font: "var(--type-page-title)", color: "var(--ink-1)" }}>{agent.name}</h1>
        <span style={{ ...eyebrow, color: accent, border: `1px dashed ${accent}`, borderRadius: 999, padding: "4px 10px" }}>
          Demo · {agent.kind === "grid" ? "grid" : "trading"}
        </span>
        <span style={subtle}>{agent.status}</span>
        <span style={{ ...subtle, marginLeft: "auto" }}>
          {agent.lastTickAtMs === null
            ? "waiting for its first cycle"
            : `last cycle ${ageText(agent.lastTickAtMs)}`}
        </span>
      </div>

      {agent.detail === null ? (
        <div style={panel}>
          <Dash reason={agent.detailUnavailableReason ?? "no figures yet"} />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
          {grid !== null ? (
            <>
              <Tile label="Cycles (simulated)" value={String(grid.cycles)} hint={`${grid.flips} simulated flips`} />
              <Tile label="Realised (simulated)" value={`${formatBnb(grid.realisedQuoteWei)} BNB`} hint="completed cycles only" />
              <Tile label="Gas charged (simulated)" value={`${formatBnb(grid.gasChargedQuoteWei)} BNB`} hint="a line item, not netted" />
              <Tile label="Net (simulated)" value={`${formatBnb(grid.netQuoteWei)} BNB`} hint="realised minus gas" />
              <Tile label="Budget (simulated)" value={`${formatBnb(grid.budgetQuoteWei)} BNB`} hint={`${grid.baseSymbol}/${grid.quoteSymbol}`} />
            </>
          ) : null}
          {trade !== null ? (
            <>
              <Tile label="Trades (simulated)" value={String(trade.trades)} hint={`${trade.positions.length} open`} />
              <Tile label="Realised (simulated)" value={`${formatBnb(trade.realisedQuoteWei)} BNB`} hint="closed positions only" />
              <Tile label="Gas charged (simulated)" value={`${formatBnb(trade.gasChargedQuoteWei)} BNB`} hint="a line item, not netted" />
              <Tile label="Net (simulated)" value={`${formatBnb(trade.netQuoteWei)} BNB`} hint="realised minus gas" />
              <Tile label="Cash (simulated)" value={`${formatBnb(trade.cashQuoteWei)} BNB`} hint={`${trade.universeSize} tokens pinned · ${trade.model}`} />
            </>
          ) : null}
        </div>
      )}

      {grid !== null ? (
        <div style={panel}>
          <span style={eyebrow}>Where the price is</span>
          <RungLadder
            height={80}
            currentTick={grid.currentTick}
            rungs={grid.levels.flatMap((level) =>
              level.range === null
                ? []
                : [{ role: level.role, level: level.level, tickLower: level.range.tickLower, tickUpper: level.range.tickUpper, occupied: true }],
            )}
          />
          <div style={{ display: "grid", gap: 4 }}>
            {grid.levels.map((level) => (
              <span key={level.level} style={mono}>
                Level {level.level} · parked on its {level.role} rung
                {level.range === null ? "" : ` [${level.range.tickLower}, ${level.range.tickUpper})`}
                {` · ${level.cycles} simulated cycle${level.cycles === 1 ? "" : "s"}`}
                {` · ${formatBnb(level.realisedQuoteWei)} BNB realised`}
              </span>
            ))}
          </div>
          <span style={subtle}>
            {grid.currentTick === null
              ? "— the pool's price has not been read yet; the first cycle will read it"
              : `Price read ${ageText(grid.currentTickAtMs)} · pool ${grid.pool}`}
          </span>
        </div>
      ) : null}

      {trade !== null && trade.positions.length > 0 ? (
        <div style={panel}>
          <span style={eyebrow}>Open positions (simulated)</span>
          {trade.positions.map((position) => (
            <span key={position.token} style={mono}>
              {position.symbol} · simulated entry {formatBnb(position.entryQuoteWei)} BNB · opened{" "}
              {ageText(position.openedAtMs)}
            </span>
          ))}
        </div>
      ) : null}

      {agent.holdReason === null ? null : (
        <div style={{ ...panel, borderColor: "var(--line-1)" }}>
          <span style={eyebrow}>Not advancing</span>
          <span style={mono}>{agent.holdReason}</span>
        </div>
      )}

      <div style={panel}>
        <span style={eyebrow}>Simulated activity</span>
        {fills === null ? (
          <span style={subtle}>Loading…</span>
        ) : fills === "failed" ? (
          <Dash reason="this demo's history could not be read just now" />
        ) : fills.length === 0 ? (
          <Dash
            reason={
              agent.kind === "grid"
                ? "no fills yet — the price has not crossed a level"
                : "no trades yet"
            }
          />
        ) : (
          fills.map((fill) => (
            <span key={fill.seq} style={mono}>
              {new Date(fill.atMs).toLocaleTimeString()} · {fillLine(fill, grid?.baseSymbol ?? "base")}
            </span>
          ))
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {agent.status === "running" ? (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={busy}
            style={{ cursor: busy ? "wait" : "pointer", padding: "10px 16px", borderRadius: "var(--radius-sm)", background: "transparent", border: "1px solid var(--line-1)", color: "var(--text-subtle)", font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)" }}
          >
            {busy ? "Stopping…" : "Stop this demo"}
          </button>
        ) : null}
        <span style={{ ...subtle, marginLeft: "auto" }}>
          expires {new Date(agent.expiresAtMs).toLocaleDateString()}
        </span>
      </div>
      {error === null ? null : <span style={{ ...subtle, color: "var(--loss)" }}>{error}</span>}

      <div style={{ ...panel, background: "var(--surface-sunken)" }}>
        <DemoDisclosureList accent={accent} omits={agent.disclosure.omits} />
      </div>
    </div>
  );
}

"use client";

/**
 * DEMO MODE — the pieces the list and the detail screen share.
 *
 * They live here rather than in either screen so neither imports the other:
 * the list is a link, the detail is the page, and a shared drawing belongs to
 * neither of them.
 */
import * as React from "react";

import { formatBnb, type DemoFillView } from "@/lib/demo/client";

export const eyebrow: React.CSSProperties = {
  font: "var(--weight-medium) var(--text-xs)/1 var(--font-sans)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-subtle)",
};

export const mono: React.CSSProperties = {
  font: "var(--weight-regular) var(--text-sm)/1.6 var(--font-mono)",
  color: "var(--ink-1)",
  overflowWrap: "anywhere",
};

export const subtle: React.CSSProperties = {
  font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-sans)",
  color: "var(--text-subtle)",
};

/** A figure with no source shows a dash AND its reason — never a number. */
export function Dash(props: { readonly reason: string }) {
  return <span style={subtle}>— {props.reason}</span>;
}

/** "12s ago" / "4m ago". An absent timestamp is said, never rendered as now. */
export function ageText(atMs: number | null): string {
  if (atMs === null) return "at an unknown time";
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** A decimal-text amount, or `null` when the field is missing or malformed. */
function amount(fill: DemoFillView, key: string): string | null {
  const value = fill[key];
  return typeof value === "string" && /^-?\d+$/u.test(value) ? value : null;
}

export function fillLine(fill: DemoFillView, baseSymbol: string): string {
  if (fill.kind === "grid-flip") {
    const quote = amount(fill, "quoteWei");
    const base = amount(fill, "baseWei");
    const delta = amount(fill, "cycleQuoteDeltaWei");
    const direction = `${String(fill["from"] ?? "?")} → ${String(fill["to"] ?? "?")}`;
    // BASE UNITS ARE RAW: the plane sends the base leg in that token's own
    // decimals and does NOT send the decimals, and an earlier version ran them
    // through the 18-decimal BNB formatter — which renders a six-decimal
    // token's whole balance as `0.000000`. A raw integer with its unit named
    // beats a wrong number.
    const released =
      quote !== null && quote !== "0"
        ? `${formatBnb(quote)} BNB`
        : base === null
          ? "— amount unavailable"
          : `${base} ${baseSymbol} (raw units)`;
    return `${direction} · released ${released}${delta === null ? "" : ` · cycle ${formatBnb(delta)} BNB`}`;
  }
  const side = fill.kind === "trade-buy" ? "buy" : "sell";
  const symbol = String(fill["symbol"] ?? "?");
  const quote = amount(fill, "quoteWei");
  const pnl = amount(fill, "pnlBps");
  const reason = String(fill["reason"] ?? "");
  // A missing amount is a DASH, never a zero: zero is a fact about a fill, and
  // "we could not read it" is not.
  const value = quote === null ? "— amount unavailable" : `${formatBnb(quote)} BNB`;
  return `${side} ${symbol} · ${value}${pnl === null ? "" : ` · ${(Number(pnl) / 100).toFixed(2)}%`}${reason && reason !== "entry" ? ` · ${reason}` : ""}`;
}

/**
 * The rung ladder: where the price is, and where the levels are waiting.
 *
 * A DELIBERATELY SMALL drawing rather than the LP liquidity chart. That chart
 * needs the pool's token decimals to label a price and the demo projection
 * carries none — feeding it a guess would put a WRONG price on the one screen
 * whose job is to be honest. Ticks are what the demo reasons about, so ticks
 * are what this draws, with the price relationship shown by POSITION rather
 * than by a number the plane never computed.
 *
 * Pool order decides which way "above" points, so the axis is drawn in TICK
 * order and each rung is labelled by its ROLE — the same discipline that keeps
 * `gridSideChargesQuote` correct in both orientations.
 */
export function RungLadder(props: {
  readonly rungs: readonly {
    readonly role: "buy" | "sell";
    readonly level: number;
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly occupied: boolean;
  }[];
  readonly currentTick: number | null;
  readonly height?: number;
}) {
  const { rungs, currentTick } = props;
  const height = props.height ?? 72;
  if (rungs.length === 0) return null;
  const lo = Math.min(...rungs.map((r) => r.tickLower), currentTick ?? Infinity);
  const hi = Math.max(...rungs.map((r) => r.tickUpper), currentTick ?? -Infinity);
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return null;
  // A tenth of the span as air on each side, so a rung at an extreme is not
  // drawn flush against the edge.
  const pad = span * 0.1;
  const x = (tick: number): number => ((tick - (lo - pad)) / (span + 2 * pad)) * 100;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ position: "relative", height, borderRadius: 4, background: "var(--surface-sunken)", border: "1px solid var(--line-1)", overflow: "hidden" }}>
        {rungs.map((rung) => {
          const left = x(rung.tickLower);
          const width = Math.max(1.5, x(rung.tickUpper) - left);
          const colour = rung.role === "buy" ? "var(--profit, #3fb950)" : "var(--loss, #f85149)";
          return (
            <div
              key={`${rung.level}-${rung.role}`}
              title={`Level ${rung.level} ${rung.role} rung · ticks [${rung.tickLower}, ${rung.tickUpper})`}
              style={{
                position: "absolute", left: `${left}%`, width: `${width}%`, top: 10, bottom: 10,
                background: colour,
                // A rung the level is SITTING on is solid; one it is waiting to
                // flip into is outlined, so "where the money is" reads at a
                // glance rather than from the legend.
                opacity: rung.occupied ? 0.55 : 0.16,
                border: `1px solid ${colour}`,
                borderRadius: 3,
              }}
            />
          );
        })}
        {currentTick === null ? null : (
          <div
            title={`price at tick ${currentTick}`}
            style={{ position: "absolute", left: `${x(currentTick)}%`, top: 0, bottom: 0, width: 2, background: "var(--ink-1)", boxShadow: "0 0 6px var(--ink-1)" }}
          />
        )}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", ...subtle }}>
        <span><span style={{ color: "var(--profit, #3fb950)" }}>▬</span> buy rung (holds BNB)</span>
        <span><span style={{ color: "var(--loss, #f85149)" }}>▬</span> sell rung (holds the token)</span>
        <span>│ price{currentTick === null ? " — not read yet" : ` · tick ${currentTick}`}</span>
        <span>solid = where the level is sitting</span>
      </div>
    </div>
  );
}

/**
 * The plane's own omissions, rendered verbatim.
 *
 * ONE place, and it lives on the DETAIL screen only. Repeating it under every
 * card in a list turned the page into a wall of small print — which is not more
 * honest, just less readable.
 */
export function DemoDisclosureList(props: { readonly accent: string; readonly omits: readonly string[] }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <span style={{ ...subtle, color: props.accent }}>Simulated — no wallet, no funds, no orders.</span>
      {props.omits.map((omission) => (
        <span key={omission} style={subtle}>· does not account for {omission}</span>
      ))}
    </div>
  );
}

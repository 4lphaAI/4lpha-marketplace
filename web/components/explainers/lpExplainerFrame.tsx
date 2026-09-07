"use client";
/* The shell the LP deploy form animations share: one 700 x 292 frame — a pill
   row, the plot, and a legend footer — which is the same anatomy the ported
   RangeExplainer and CompoundExplainer show in `compact` mode, so all three
   cards in the form are exactly the same size.

   The agent detail pages are untouched: those render the ported explainers in
   their full form, header and step bar and all. */
import React from "react";

/* ---------------------------------------------------------------- geometry */

export const VW = 700;
export const VH = 292;
export const X0 = 66;
export const X1 = 528;
/** The plot never enters the pill row above it. */
export const PLOT_TOP = 52;
export const PLOT_BOTTOM = 262;
/** Where a caption under the plot sits. */
export const CAPTION_Y = 284;

/** Price -> y for a plot whose price window is [lo, hi]. */
export const scaleY =
  (lo: number, hi: number) =>
  (p: number): number =>
    PLOT_BOTTOM - ((p - lo) / (hi - lo)) * (PLOT_BOTTOM - PLOT_TOP);

export const xAt = (i: number, n: number): number => X0 + (i * (X1 - X0)) / (n - 1);

/* ------------------------------------------------------------------ timing */

export const ease = (u: number): number => u * u * (3 - 2 * u);

/** Piecewise-eased lookup over a shared key list, clamped at both ends. */
export const track = (keys: readonly number[], vals: readonly number[], t: number): number => {
  const x = Math.max(keys[0] as number, Math.min(keys[keys.length - 1] as number, t));
  for (let i = 1; i < keys.length; i++) {
    const k0 = keys[i - 1] as number;
    const k1 = keys[i] as number;
    if (x <= k1) {
      const v0 = vals[i - 1] as number;
      const v1 = vals[i] as number;
      return v0 + (v1 - v0) * ease(k1 === k0 ? 1 : (x - k0) / (k1 - k0));
    }
  }
  return vals[vals.length - 1] as number;
};

/** One looping clock, in milliseconds. It advances only while `running`. */
export const useLoop = (total: number, running: boolean): number => {
  const [e, setE] = React.useState(0);
  const st = React.useRef({ e: 0, last: 0 });
  React.useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = (ts: number) => {
      const s = st.current;
      const dt = s.last ? Math.min(64, ts - s.last) : 16;
      s.last = ts;
      s.e = (s.e + dt) % total;
      setE(s.e);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [total, running]);
  return e;
};

/* ------------------------------------------------------------------- parts */

/** A rounded status pill on the row under the title. */
export const Pill: React.FC<{
  x: number;
  width: number;
  fill: string;
  stroke: string;
  color: string;
  children: React.ReactNode;
}> = ({ x, width, fill, stroke, color, children }) => (
  <g>
    <rect x={x} y={12} width={width} height={26} rx="6" fill={fill} stroke={stroke} />
    <text x={x + 12} y={29} style={{ font: "var(--type-mono-xs)", fill: color }}>
      {children}
    </text>
  </g>
);

/** The legend + facts row every card ends with. */
export const Legend: React.FC<{ facts: React.ReactNode }> = ({ facts }) => (
  <div
    style={{
      borderTop: "1px solid var(--line-1)",
      padding: "14px 20px",
      display: "flex",
      gap: 24,
      flexWrap: "wrap",
      font: "var(--type-mono-xs)",
      color: "var(--text-subtle)",
    }}
  >
    <span style={{ display: "inline-flex", gap: 8 }}>
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: 999,
          background: "var(--cat-lp)",
          alignSelf: "center",
        }}
      />
      LP RANGE
    </span>
    <span style={{ display: "inline-flex", gap: 8 }}>
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: 999,
          background: "var(--ink-1)",
          alignSelf: "center",
        }}
      />
      POOL PRICE
    </span>
    {facts}
  </div>
);

/** The card: one chart and one legend, the same anatomy the ported explainers
 *  show in compact mode, so the three deploy-form cards are the same size. */
export const ExplainerCard: React.FC<{
  children: React.ReactNode;
  facts: React.ReactNode;
  cardRef?: React.RefObject<HTMLElement | null>;
}> = ({ children, facts, cardRef }) => (
  <section
    ref={cardRef}
    style={{
      border: "1px solid var(--border-card)",
      borderRadius: "var(--radius-md)",
      background: "var(--surface-card)",
      overflow: "hidden",
    }}
  >
    <div style={{ padding: "18px 14px 0" }}>
      <svg viewBox={`0 0 ${VW} ${VH}`} style={{ display: "block", width: "100%", height: "auto" }}>
        {children}
      </svg>
    </div>
    <Legend facts={facts} />
  </section>
);

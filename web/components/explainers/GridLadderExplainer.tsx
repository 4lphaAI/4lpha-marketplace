"use client";
/* The grid explainer, rebuilt from the marketing film's version of the same
   animation (`marketing-video-v2/src/scenes/Grid.tsx`): the price walks the
   WHOLE ladder — down through the three buys at $608 / $600 / $592, then back
   up through the three sells at $616 / $624 / $632 — instead of showing one
   round trip. Every fill leaves a marker on the tape, each buy arms the sell
   one level above it, and the footer counts the round trips that close.

   Written as ordinary typed TSX rather than a design-export port, so it is not
   subject to the byte-identical rule the neighbouring explainers carry. It
   replaces the single-round-trip design port `GridExplainer.tsx`, deleted with
   it; that version lives in the Claude Design export it came from. */
import React from "react";

type Side = "buy" | "sell";

const BUY = "var(--cat-lp)";
const SELL = "var(--warn)";

/* ---------------------------------------------------------------- timeline */

const T = {
  ladder: 0,
  sides: 1700,
  fall: 2700,
  buy1: 3600,
  buy2: 4900,
  buy3: 6200,
  turn: 6900,
  sell1: 8400,
  sell2: 9700,
  sell3: 11000,
  rearm: 12200,
} as const;
const TOTAL = 14600;

const SCENES = [
  {
    t: T.ladder,
    title: "Your budget becomes a ladder",
    body: "The capital you delegate is split into price levels above and below the market. Nothing outside it is ever touched.",
  },
  {
    t: T.sides,
    title: "Buys sit below, sells sit above",
    body: "Each level is a narrow resting position on PancakeSwap v3 — USDT waiting to buy below the price, BNB waiting to sell above it.",
  },
  {
    t: T.buy1,
    title: "The price falls into the first buy",
    body: "BNB trades down to $608. That level converts your USDT into BNB and the agent settles it on-chain.",
  },
  {
    t: T.buy2,
    title: "It keeps falling — $600 and $592 fill too",
    body: "Each level is bought on its own, and the three of them together never spend more than the budget you delegated.",
  },
  {
    t: T.turn,
    title: "Every fill arms a sell one level up",
    body: "$616, $624 and $632 are now armed against the three levels you own. The ladder is always two-sided.",
  },
  {
    t: T.sell1,
    title: "The price turns and $616 fills",
    body: "The first round trip closes. The spread, minus swap fees and gas, is realized profit.",
  },
  {
    t: T.sell2,
    title: "$624 and $632 fill on the way up",
    body: "Three round trips out of one swing. A price that keeps moving sideways is what the agent feeds on.",
  },
  {
    t: T.rearm,
    title: "The ladder re-arms, and it repeats",
    body: "Buys go back below the price, sells back above, and the agent waits for the next swing — day and night, without you.",
  },
];

const LEVELS: Array<{ p: number; side: Side }> = [
  { p: 632, side: "sell" },
  { p: 624, side: "sell" },
  { p: 616, side: "sell" },
  { p: 608, side: "buy" },
  { p: 600, side: "buy" },
  { p: 592, side: "buy" },
];
const MID = 612;

/** When each rung fills, and when a sell arms behind its matching buy. */
const FILLED_AT: Record<number, number> = {
  608: T.buy1,
  600: T.buy2,
  592: T.buy3,
  616: T.sell1,
  624: T.sell2,
  632: T.sell3,
};
const ARMED_AT: Record<number, number> = {
  616: T.buy1 + 300,
  624: T.buy2 + 300,
  632: T.buy3 + 300,
};

const FILLS: Array<{ at: number; p: number; side: Side; text: string; sub: string }> = [
  { at: T.buy1, p: 608, side: "buy", text: "Bought 0.42 BNB at $608.00", sub: "level 3 · fee $0.18" },
  { at: T.buy2, p: 600, side: "buy", text: "Bought 0.42 BNB at $600.00", sub: "level 2 · fee $0.18" },
  { at: T.buy3, p: 592, side: "buy", text: "Bought 0.43 BNB at $592.00", sub: "level 1 · fee $0.18" },
  { at: T.sell1, p: 616, side: "sell", text: "Sold 0.42 BNB at $616.00", sub: "round trip · +$5.82" },
  { at: T.sell2, p: 624, side: "sell", text: "Sold 0.42 BNB at $624.00", sub: "round trip · +$5.82" },
  { at: T.sell3, p: 632, side: "sell", text: "Sold 0.43 BNB at $632.00", sub: "round trip · +$5.82" },
];

/* ---------------------------------------------------------------- geometry */

const VW = 700;
const VH = 300;
const X0 = 66;
const X1 = 540;
const N = 150;
/** Milliseconds between plotted samples — the window holds the whole swing. */
const SAMPLE = 96;

const PLO = 584;
const PHI = 640;
const y = (p: number): number => 270 - ((p - PLO) / (PHI - PLO)) * 248;
const xAt = (i: number): number => X0 + (i * (X1 - X0)) / (N - 1);

const KEYS = [0, T.fall, T.buy1, T.buy2, T.buy3, T.turn, T.sell1, T.sell2, T.sell3, TOTAL];
const VALS = [613.4, 613.2, 607.2, 599.2, 591.2, 592.4, 616.6, 624.6, 632.8, 634.4];

const ease = (u: number): number => u * u * (3 - 2 * u);

const priceAt = (ms: number): number => {
  const t = Math.max(0, Math.min(TOTAL, ms));
  let base = VALS[VALS.length - 1] as number;
  for (let i = 1; i < KEYS.length; i++) {
    const k0 = KEYS[i - 1] as number;
    const k1 = KEYS[i] as number;
    if (t <= k1) {
      const v0 = VALS[i - 1] as number;
      const v1 = VALS[i] as number;
      base = v0 + (v1 - v0) * ease(k1 === k0 ? 1 : (t - k0) / (k1 - k0));
      break;
    }
  }
  const s = t / 1000;
  return base + Math.sin(s * 4.4) * 0.34 + Math.sin(s * 1.7) * 0.62 + Math.sin(s * 9.3) * 0.16;
};

const markerX = (now: number, at: number): number => xAt(N - 1 - (now - at) / SAMPLE);

/* --------------------------------------------------------------- component */

function GridLadderExplainer({
  pair = "BNB / USDT",
  protocol = "PancakeSwap v3",
  budget = "500 USDT",
}: {
  pair?: string;
  protocol?: string;
  budget?: string;
}) {
  const [e, setE] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const st = React.useRef({ e: 0, last: 0, playing: true });
  st.current.playing = playing;

  React.useEffect(() => {
    let raf = 0;
    const loop = (ts: number) => {
      const s = st.current;
      const dt = s.last ? Math.min(64, ts - s.last) : 16;
      s.last = ts;
      if (s.playing) s.e = (s.e + dt) % TOTAL;
      setE(s.e);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = (i: number) => {
    const t = (SCENES[i] as { t: number }).t + 1;
    st.current.e = t;
    setE(t);
  };

  const sceneIdx = SCENES.reduce((acc, s, i) => (e >= s.t ? i : acc), 0);
  const scene = SCENES[sceneIdx] as (typeof SCENES)[number];

  const pts: string[] = [];
  for (let i = 0; i < N; i++) {
    pts.push(`${xAt(i).toFixed(1)},${y(priceAt(e - (N - 1 - i) * SAMPLE)).toFixed(1)}`);
  }
  const price = priceAt(e);
  const headY = y(price);

  const trips = [T.sell1, T.sell2, T.sell3].filter((t) => e >= t).length;
  const realized = (trips * 5.82).toFixed(2);
  const feed = FILLS.filter((f) => e >= f.at).slice(-4);
  const flash = FILLS.find((f) => e >= f.at && e < f.at + 700);

  return (
    <section
      style={{
        border: "1px solid var(--border-card)",
        borderRadius: "var(--radius-md)",
        background: "var(--surface-card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "16px 20px",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span style={{ font: "var(--type-card-title)" }}>How this agent works</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
            {pair} · {protocol}
          </span>
          <button
            onClick={() => setPlaying((p) => !p)}
            style={{
              font: "var(--type-mono-xs)",
              color: "var(--text-muted)",
              background: "none",
              border: "1px solid var(--line-2)",
              borderRadius: 999,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
        </div>
      </div>

      <div style={{ padding: "8px 12px 0" }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} style={{ display: "block", width: "100%", height: "auto" }}>
          {/* the two sides of the ladder */}
          <rect
            x={X0}
            y={y(PHI)}
            width={X1 - X0 + 8}
            height={y(MID) - y(PHI)}
            fill="var(--warn-tint)"
            style={{ opacity: e > T.sides ? 1 : 0, transition: "opacity .6s ease" }}
          />
          <rect
            x={X0}
            y={y(MID)}
            width={X1 - X0 + 8}
            height={y(PLO) - y(MID)}
            fill="var(--cat-lp-tint)"
            style={{ opacity: e > T.sides ? 1 : 0, transition: "opacity .6s ease" }}
          />
          <text
            x={X0 + 6}
            y={y(632) - 12}
            style={{ font: "var(--type-mono-xs)", fill: SELL, opacity: e > T.sides ? 1 : 0 }}
          >
            SELLS
          </text>
          <text
            x={X0 + 6}
            y={y(592) + 22}
            style={{ font: "var(--type-mono-xs)", fill: BUY, opacity: e > T.sides ? 1 : 0 }}
          >
            BUYS
          </text>

          {/* rungs */}
          {LEVELS.map((lv, i) => {
            const born = 120 + i * 90;
            const filled = e >= (FILLED_AT[lv.p] ?? Infinity);
            const armed = !filled && e >= (ARMED_AT[lv.p] ?? Infinity);
            const c = lv.side === "buy" ? BUY : SELL;
            return (
              <g
                key={lv.p}
                style={{ opacity: e > born ? 1 : 0, transition: "opacity .5s ease" }}
              >
                <line
                  x1={X0}
                  y1={y(lv.p)}
                  x2={X1 + 8}
                  y2={y(lv.p)}
                  stroke={c}
                  strokeWidth={filled ? 2.6 : armed ? 2.2 : 1.6}
                  strokeLinecap="round"
                  strokeDasharray={filled ? undefined : armed ? "10 5" : "6 6"}
                  opacity={filled || armed ? 1 : 0.55}
                />
                <text
                  x={X1 + 18}
                  y={y(lv.p) + 4}
                  style={{ font: "var(--type-mono-xs)", fill: c }}
                >
                  ${lv.p}
                  {filled ? " FILLED" : armed ? " ARMED" : ""}
                </text>
              </g>
            );
          })}

          {/* price tape */}
          <polyline
            points={pts.join(" ")}
            fill="none"
            stroke="var(--ink-1)"
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* fills, scrolling away with the tape */}
          {FILLS.map((f) => {
            const x = markerX(e, f.at);
            if (e < f.at || x < X0) return null;
            const c = f.side === "buy" ? BUY : SELL;
            return (
              <g key={f.at}>
                <circle cx={x} cy={y(f.p)} r={5.5} fill={c} stroke="var(--surface-card)" strokeWidth="2" />
                <text
                  x={x}
                  y={f.side === "buy" ? y(f.p) + 20 : y(f.p) - 12}
                  textAnchor="middle"
                  style={{ font: "var(--type-mono-xs)", fill: c }}
                >
                  {f.side === "buy" ? "BUY" : "SELL"}
                </text>
              </g>
            );
          })}

          {flash ? (
            <circle
              cx={X1}
              cy={headY}
              r={9 + ((e - flash.at) / 700) * 24}
              fill="none"
              stroke={flash.side === "buy" ? BUY : SELL}
              strokeWidth="1.5"
              opacity={1 - (e - flash.at) / 700}
            />
          ) : null}
          <circle cx={X1} cy={headY} r="4.5" fill="var(--ink-1)" />
          <circle cx={X1} cy={headY} r="11" fill="none" stroke="var(--line-3)" />

          {/* the spread one round trip banks */}
          {e >= T.sell1 ? (
            <g>
              <line x1={X0 + 22} y1={y(608)} x2={X0 + 22} y2={y(616)} stroke="var(--profit)" strokeWidth="2" />
              <text x={X0 + 30} y={(y(608) + y(616)) / 2 + 4} style={{ font: "var(--type-mono-xs)", fill: "var(--profit)" }}>
                +$5.82 a round trip
              </text>
            </g>
          ) : null}
        </svg>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "4px 20px 0", flexWrap: "wrap" }}>
        {feed.map((f) => (
          <span
            key={f.at}
            style={{
              display: "inline-flex",
              gap: 8,
              alignItems: "baseline",
              font: "var(--type-mono-xs)",
              padding: "5px 10px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${f.side === "buy" ? "var(--cat-lp-tint)" : "var(--warn-tint)"}`,
              background: f.side === "buy" ? "var(--cat-lp-tint)" : "var(--warn-tint)",
              color: "var(--ink-1)",
            }}
          >
            {f.text}
            <span style={{ color: "var(--text-subtle)" }}>{f.sub}</span>
          </span>
        ))}
      </div>

      <div style={{ padding: 20, display: "grid", gap: 6 }}>
        <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
          STEP {sceneIdx + 1} / {SCENES.length}
        </span>
        <span style={{ font: "var(--type-card-title)" }}>{scene.title}</span>
        <p
          style={{
            font: "var(--type-body-md)",
            color: "var(--text-muted)",
            maxWidth: "70ch",
            textWrap: "pretty",
          }}
        >
          {scene.body}
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${SCENES.length},1fr)`,
          gap: 6,
          padding: "0 20px 20px",
        }}
      >
        {SCENES.map((s, i) => (
          <button
            key={s.t}
            onClick={() => jump(i)}
            title={s.title}
            aria-label={s.title}
            style={{
              height: 3,
              borderRadius: 999,
              border: "none",
              padding: 0,
              cursor: "pointer",
              background: i === sceneIdx ? "var(--brand)" : "var(--line-2)",
              transition: "background .3s ease",
            }}
          />
        ))}
      </div>

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
        <span>LADDER {budget}</span>
        <span>SPACING $8</span>
        <span>
          ROUND TRIPS <span style={{ color: "var(--ink-1)" }}>{trips}</span>
        </span>
        <span>
          REALIZED <span style={{ color: "var(--profit)" }}>+${realized}</span>
        </span>
        <span>SKIPS TRADES BELOW ITS FEE FLOOR</span>
      </div>
    </section>
  );
}

export { GridLadderExplainer };

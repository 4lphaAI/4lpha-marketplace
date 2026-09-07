"use client";
/* Swapless rebalance, for the LP deploy form's "Rebalance mode: Swapless".
   Replaces the still image, which could not show the one thing that matters:
   the band MOVING to sit beside the price without a swap, and then earning
   nothing until the price comes back.

   The mechanic is the shipped one. `rotateMode: "swapless"` (Phase 3.13,
   owner-signed, DEFAULT "swapped") skips the balancing sweep and parks the
   PRIOR WIDTH strictly beside the price, on the side the principal is already
   on (`adjacentRotationRange`, `src/lp/fence.ts`). So the honest beats are all
   here: the price leaves the band upward and the position is 100% quote; a
   centred rebalance would sell half of that back and pay a submission, a pool
   fee and that leg's slippage; swapless does not, but it earns NOTHING until
   the price returns, and up to SWAPLESS_MAX_RESIDUE_BPS = 50 bps of the freed
   value stays in the wallet. */
import React from "react";
import {
  CAPTION_Y,
  ExplainerCard,
  Pill,
  scaleY,
  track,
  useLoop,
  X0,
  X1,
  xAt,
} from "./lpExplainerFrame";
import { useCardVisible } from "./useCardVisible";

const RANGE = "var(--cat-lp)";
const PAUSED = "var(--warn)";

const T = {
  inRange: 0,
  exit: 3000,
  paused: 4400,
  compare: 6000,
  rerange: 8000,
  parked: 9600,
  reentry: 11600,
  close: 14000,
} as const;
const TOTAL = 17200;

const BAND_1 = { lo: 598, hi: 626 };
const BAND_2 = { lo: 616, hi: 644 };

const N = 150;
/** Milliseconds between plotted samples — the window holds the whole move. */
const SAMPLE = 112;
const y = scaleY(594, 654);

const KEYS = [0, T.exit, T.paused, T.compare, T.rerange, T.parked, T.reentry, T.close, TOTAL];
const VALS = [611.5, 620.5, 634.0, 643.5, 646.4, 647.2, 645.6, 630.5, 628.0];

const priceAt = (ms: number): number => {
  const s = Math.max(0, Math.min(TOTAL, ms)) / 1000;
  return (
    track(KEYS, VALS, ms) +
    Math.sin(s * 3.9) * 0.55 +
    Math.sin(s * 1.3) * 0.85 +
    Math.sin(s * 8.7) * 0.22
  );
};

/** Fees only accrue while the price is inside the live band. */
const feesAt = (ms: number): number => track([0, T.exit, T.reentry, TOTAL], [0, 18.4, 18.4, 27.9], ms);

function SwaplessExplainer({
  base = "WBNB",
  quote = "USDT",
}: {
  base?: string;
  quote?: string;
}) {
  const card = React.useRef<HTMLElement | null>(null);
  const e = useLoop(TOTAL, useCardVisible(card));

  const pts: string[] = [];
  for (let i = 0; i < N; i++) {
    pts.push(`${xAt(i, N).toFixed(1)},${y(priceAt(e - (N - 1 - i) * SAMPLE)).toFixed(1)}`);
  }
  const price = priceAt(e);
  const headY = y(price);

  const moved = e >= T.rerange;
  const band = moved ? BAND_2 : BAND_1;
  const inRange = price > band.lo && price < band.hi;
  const fees = feesAt(e);

  /* the old band lingers as a dashed ghost once the position has moved */
  const ghost = e >= T.rerange && e < T.reentry ? BAND_1 : null;
  /* the centred range a swapped rotate would have minted, shown only to be refused */
  const compare = e >= T.compare && e < T.rerange;
  const compareBand = { lo: price - 14, hi: price + 14 };
  const jumpFlash = e >= T.rerange && e < T.rerange + 900;

  return (
    <ExplainerCard
      cardRef={card}
      facts={
        <>
          <span>SAME WIDTH KEPT</span>
          <span>NO BALANCING SWAP</span>
          <span>RESIDUE ≤ 0.50%</span>
          <span>
            FEES <span style={{ color: "var(--profit)" }}>+${fees.toFixed(2)}</span>
          </span>
        </>
      }
    >
      <Pill
        x={8}
        width={inRange ? 196 : 176}
        fill="var(--surface-sunken)"
        stroke="var(--line-2)"
        color="var(--text-subtle)"
      >
        HOLDS <tspan fill="var(--ink-1)">{inRange ? `${base} + ${quote}` : `100% ${quote}`}</tspan>
      </Pill>
      <Pill
        x={inRange ? 214 : 194}
        width={inRange ? 168 : 214}
        fill={inRange ? "var(--live-tint)" : "var(--warn-tint)"}
        stroke={inRange ? "var(--live)" : PAUSED}
        color={inRange ? "var(--live)" : PAUSED}
      >
        {inRange
          ? "IN RANGE · earning fees"
          : moved
            ? "PARKED · waiting for re-entry"
            : "OUT OF RANGE · fees paused"}
      </Pill>

      {/* the range a swapped rotate would have re-centred on */}
      {compare ? (
        <g>
          <rect
            x={X0}
            y={y(compareBand.hi)}
            width={X1 - X0 + 8}
            height={y(compareBand.lo) - y(compareBand.hi)}
            fill="var(--danger-tint)"
            stroke="var(--danger)"
            strokeWidth="1.2"
            strokeDasharray="5 5"
            rx="3"
          />
          <text x={X0 + 2} y={CAPTION_Y} style={{ font: "var(--type-mono-xs)", fill: "var(--danger)" }}>
            a centred rebalance would sell half of your {quote} back
          </text>
        </g>
      ) : null}

      {/* the band the position has left behind */}
      {ghost ? (
        <rect
          x={X0}
          y={y(ghost.hi)}
          width={X1 - X0 + 8}
          height={y(ghost.lo) - y(ghost.hi)}
          fill="none"
          stroke="var(--line-3)"
          strokeWidth="1.2"
          strokeDasharray="4 6"
          rx="3"
        />
      ) : null}

      {/* the live band */}
      <rect
        x={X0}
        y={y(band.hi)}
        width={X1 - X0 + 8}
        height={y(band.lo) - y(band.hi)}
        fill={inRange ? "var(--cat-lp-tint)" : "var(--warn-tint)"}
        stroke={inRange ? RANGE : PAUSED}
        strokeWidth={jumpFlash ? 2.4 : 1.5}
        rx="3"
      />
      <text
        x={X0 - 8}
        y={y(band.hi) + 4}
        textAnchor="end"
        style={{ font: "var(--type-mono-xs)", fill: inRange ? RANGE : PAUSED }}
      >
        ${band.hi}
      </text>
      <text
        x={X0 - 8}
        y={y(band.lo) + 4}
        textAnchor="end"
        style={{ font: "var(--type-mono-xs)", fill: inRange ? RANGE : PAUSED }}
      >
        ${band.lo}
      </text>

      {/* price tape */}
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="var(--ink-1)"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={X1} cy={headY} r="4.5" fill="var(--ink-1)" />
      <circle cx={X1} cy={headY} r="11" fill="none" stroke="var(--line-3)" />
      <text x={X1 + 18} y={headY + 4} style={{ font: "var(--type-mono-xs)", fill: "var(--ink-1)" }}>
        ${price.toFixed(1)}
      </text>

      {jumpFlash ? (
        <text
          x={X0 + 2}
          y={CAPTION_Y}
          style={{ font: "var(--type-mono-xs)", fill: RANGE }}
        >
          same width, parked strictly beside the price — no swap
        </text>
      ) : null}
    </ExplainerCard>
  );
}

export { SwaplessExplainer };

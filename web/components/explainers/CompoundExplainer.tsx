// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its inline scene/geometry helpers would each need a hand-written
// prop interface; annotating them would mean editing the very markup this port
// exists to preserve.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/CompoundExplainer.jsx).
   The body is unchanged; only the IIFE wrapper and the `window.CompoundExplainer`
   global became a real import/export. */
import React from "react";
import { useCardVisible } from "./useCardVisible";

const SCENES = [{
  t: 0,
  title: "Your position stays exactly where it is",
  body: "One position on the pool, between a lower and an upper price. This agent never moves that range."
}, {
  t: 1600,
  title: "Swap fees pile up outside the position",
  body: "Fees the pool pays you sit uncollected next to the position. Uncollected fees earn nothing."
}, {
  t: 3300,
  title: "It waits until the fees beat the gas",
  body: "Compounding costs three on-chain submissions, so nothing happens until the unclaimed fees clear your floor."
}, {
  t: 4900,
  title: "Floor cleared",
  body: "Fees are now worth more than the cost of putting them to work."
}, {
  t: 6400,
  title: "Collect, balance, add back in",
  body: "One pass: collect the fees, swap only the part needed to match the pool ratio, then add them into the same position."
}, {
  t: 8200,
  title: "Same range, more liquidity",
  body: "Your range is untouched and your position is now larger, so the next fees are bigger. Then it starts over."
}];
const TOTAL = 10000;
const CLEAR_AT = 4900,
  RUN_AT = 6400,
  DONE_AT = 7900;
const X0 = 96,
  X1 = 560,
  N = 170,
  VW = 700,
  VH = 292;
const y = p => 246 - (p - 598) * (196 / 40);
const LP = "var(--cat-lp)";
const LO = 606,
  HI = 626,
  FLOOR = 0.002,
  PEAK = 0.0021;
const STEPS3 = [{
  t: RUN_AT,
  l: "COLLECT"
}, {
  t: RUN_AT + 500,
  l: "BALANCE"
}, {
  t: RUN_AT + 1000,
  l: "ADD"
}];
function CompoundExplainer({
  pair = "BNB / USDT",
  protocol = "Thena",
  /** The LP deploy form shows the chart and the facts only. */
  compact = false
}) {
  const cardRef = React.useRef(null);
  /* Re-rendering every frame is only worth it while the card is on screen. */
  const running = useCardVisible(cardRef);
  const [e, setE] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const [pts, setPts] = React.useState(() => new Array(N).fill(y(616)));
  const st = React.useRef({
    e: 0,
    cur: y(616),
    last: 0,
    playing: true,
    seed: 0
  });
  st.current.playing = playing;
  React.useEffect(() => {
    if (!running) return;
    let raf;
    const loop = ts => {
      const s = st.current;
      const dt = s.last ? Math.min(64, ts - s.last) : 16;
      s.last = ts;
      if (s.playing) s.e = (s.e + dt) % TOTAL;
      s.seed += dt / 1000;
      const jitter = Math.sin(s.seed * 2.2) * 2.6 + Math.sin(s.seed * 5.9) * 1.3 + Math.sin(s.seed * 15.1) * 0.5;
      s.cur += (y(616 + jitter) - s.cur) * 0.12;
      setPts(prev => {
        const nx = prev.slice(1);
        nx.push(s.cur);
        return nx;
      });
      setE(s.e);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);
  const sceneIdx = SCENES.reduce((acc, s, i) => e >= s.t ? i : acc, 0);
  const scene = SCENES[sceneIdx];
  const jump = i => {
    const t = SCENES[i].t + 1;
    st.current.e = t;
    setE(t);
  };
  const drain = e >= RUN_AT ? Math.min(1, (e - RUN_AT) / 900) : 0;
  const accrue = e < CLEAR_AT ? FLOOR * e / CLEAR_AT : FLOOR + (PEAK - FLOOR) * (e - CLEAR_AT) / (RUN_AT - CLEAR_AT);
  const fees = e < RUN_AT ? accrue : PEAK * (1 - drain) + 0.00028 * Math.max(0, (e - DONE_AT) / (TOTAL - DONE_AT));
  const cleared = fees >= FLOOR;
  const liq = e >= RUN_AT + 900 ? 1.014 : 1.0;
  const barH = 150,
    barY = 62,
    barX = 34,
    barW = 18;
  const fh = Math.min(1, fees / 0.0026) * barH;
  const floorY = barY + barH - FLOOR / 0.0026 * barH;
  const path = pts.map((py, i) => `${(X0 + i * (X1 - X0) / (N - 1)).toFixed(1)},${py.toFixed(1)}`).join(" ");
  const headY = pts[pts.length - 1];
  const FILLS = [{
    t: CLEAR_AT,
    tone: "warn",
    text: "Unclaimed fees 0.0020 BNB",
    sub: "floor cleared · compound queued"
  }, {
    t: RUN_AT + 1000,
    tone: "lp",
    text: "Compounded 0.0021 BNB",
    sub: "same range · liquidity +1.4%"
  }];
  const pulse = FILLS.find(f => e >= f.t && e < f.t + 650);
  const feed = FILLS.filter(f => e >= f.t);
  return /*#__PURE__*/React.createElement("section", {
    ref: cardRef,
    style: {
      border: "1px solid var(--border-card)",
      borderRadius: "var(--radius-md)",
      background: "var(--surface-card)",
      overflow: "hidden"
    }
  }, compact ? null : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      padding: "16px 20px",
      borderBottom: "1px solid var(--line-1)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-card-title)"
    }
  }, "How this agent works"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-xs)",
      color: "var(--text-subtle)"
    }
  }, pair, " \xB7 ", protocol), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPlaying(p => !p),
    style: {
      font: "var(--type-mono-xs)",
      color: "var(--text-muted)",
      background: "none",
      border: "1px solid var(--line-2)",
      borderRadius: 999,
      padding: "3px 10px",
      cursor: "pointer"
    }
  }, playing ? "Pause" : "Play"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 12px 0"
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${VW} ${VH}`,
    style: {
      display: "block",
      width: "100%",
      height: "auto"
    }
  }, /*#__PURE__*/React.createElement("text", {
    x: X0,
    y: 26,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--profit)"
    }
  }, "IN RANGE \xB7 LIQUIDITY \xD7", liq.toFixed(3)), /*#__PURE__*/React.createElement("rect", {
    x: barX,
    y: barY,
    width: barW,
    height: barH,
    rx: "3",
    fill: "var(--surface-sunken)",
    stroke: "var(--line-1)"
  }), /*#__PURE__*/React.createElement("rect", {
    x: barX,
    y: barY + barH - fh,
    width: barW,
    height: fh,
    rx: "3",
    fill: cleared ? "var(--warn)" : LP,
    opacity: cleared ? 0.9 : 0.65,
    style: {
      transition: "fill .4s ease"
    }
  }), /*#__PURE__*/React.createElement("line", {
    x1: barX - 6,
    y1: floorY,
    x2: barX + barW + 6,
    y2: floorY,
    stroke: "var(--ink-3)",
    strokeWidth: "1",
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement("text", {
    x: barX + barW + 10,
    y: floorY + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--text-subtle)"
    }
  }, "FLOOR"), /*#__PURE__*/React.createElement("text", {
    x: barX,
    y: barY - 10,
    style: {
      font: "var(--type-mono-xs)",
      fill: cleared ? "var(--warn)" : "var(--text-muted)"
    }
  }, fees.toFixed(4)), /*#__PURE__*/React.createElement("text", {
    x: barX,
    y: barY + barH + 18,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--text-subtle)"
    }
  }, "FEES"), /*#__PURE__*/React.createElement("rect", {
    x: X0,
    y: y(HI),
    width: X1 - X0,
    height: y(LO) - y(HI),
    fill: "var(--cat-lp-tint)"
  }), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: y(HI),
    x2: X1,
    y2: y(HI),
    stroke: LP,
    strokeWidth: "2",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: y(LO),
    x2: X1,
    y2: y(LO),
    stroke: LP,
    strokeWidth: "2",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 12,
    y: y(HI) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: LP
    }
  }, "$", HI), /*#__PURE__*/React.createElement("text", {
    x: X1 + 12,
    y: y(LO) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: LP
    }
  }, "$", LO), /*#__PURE__*/React.createElement("text", {
    x: X0 + 8,
    y: y(LO) - 8,
    style: {
      font: "var(--type-mono-xs)",
      fill: LP
    }
  }, "YOUR RANGE \xB7 UNCHANGED"), /*#__PURE__*/React.createElement("polyline", {
    points: path,
    fill: "none",
    stroke: "var(--brand)",
    strokeWidth: "1.8",
    strokeLinejoin: "round"
  }), pulse && /*#__PURE__*/React.createElement("circle", {
    cx: barX + barW / 2,
    cy: barY + barH - fh,
    r: 8 + (e - pulse.t) / 650 * 26,
    fill: "none",
    stroke: pulse.tone === "warn" ? "var(--warn)" : LP,
    strokeWidth: "1.5",
    opacity: 1 - (e - pulse.t) / 650
  }), /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: "4.5",
    fill: "var(--brand)"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: "11",
    fill: "none",
    stroke: "var(--brand-line)"
  }), /*#__PURE__*/React.createElement("g", null, STEPS3.map((s, i) => {
    const on = e >= s.t && e < DONE_AT + 400;
    return /*#__PURE__*/React.createElement("g", {
      key: s.l,
      style: {
        opacity: on ? 1 : 0.22,
        transition: "opacity .3s ease"
      }
    }, /*#__PURE__*/React.createElement("rect", {
      x: X0 + i * 118,
      y: 272 - 22,
      width: 104,
      height: 20,
      rx: "4",
      fill: on ? "var(--cat-lp-tint)" : "none",
      stroke: on ? LP : "var(--line-1)"
    }), /*#__PURE__*/React.createElement("text", {
      x: X0 + i * 118 + 52,
      y: 272 - 8,
      textAnchor: "middle",
      style: {
        font: "var(--type-mono-xs)",
        fill: on ? LP : "var(--text-subtle)"
      }
    }, s.l));
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      padding: "4px 20px 0",
      flexWrap: "wrap"
    }
  }, feed.map(f => /*#__PURE__*/React.createElement("span", {
    key: f.t,
    style: {
      display: "inline-flex",
      gap: 8,
      alignItems: "baseline",
      font: "var(--type-mono-xs)",
      padding: "5px 10px",
      borderRadius: "var(--radius-sm)",
      border: `1px solid ${f.tone === "warn" ? "var(--warn-tint)" : "var(--cat-lp-tint)"}`,
      background: f.tone === "warn" ? "var(--warn-tint)" : "var(--cat-lp-tint)",
      color: "var(--ink-1)"
    }
  }, f.text, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-subtle)"
    }
  }, f.sub)))), compact ? null : /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 20,
      display: "grid",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-xs)",
      color: "var(--text-subtle)"
    }
  }, "STEP ", sceneIdx + 1, " / ", SCENES.length), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-card-title)"
    }
  }, scene.title), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-body-md)",
      color: "var(--text-muted)",
      maxWidth: "70ch",
      textWrap: "pretty"
    }
  }, scene.body)), compact ? null : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: `repeat(${SCENES.length},1fr)`,
      gap: 6,
      padding: "0 20px 20px"
    }
  }, SCENES.map((s, i) => /*#__PURE__*/React.createElement("button", {
    key: s.t,
    onClick: () => jump(i),
    title: s.title,
    style: {
      height: 3,
      borderRadius: 999,
      border: "none",
      padding: 0,
      cursor: "pointer",
      background: i === sceneIdx ? "var(--brand)" : "var(--line-2)",
      transition: "background .3s ease"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: "1px solid var(--line-1)",
      padding: "14px 20px",
      display: "flex",
      gap: 24,
      flexWrap: "wrap",
      font: "var(--type-mono-xs)",
      color: "var(--text-subtle)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "FEE FLOOR 0.002 BNB"), /*#__PURE__*/React.createElement("span", null, "NEVER MOVES YOUR RANGE"), /*#__PURE__*/React.createElement("span", null, "PAUSES WHILE OUT OF RANGE")));
}

export { CompoundExplainer };

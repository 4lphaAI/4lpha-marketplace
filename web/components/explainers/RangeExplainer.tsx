// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its inline scene/geometry helpers would each need a hand-written
// prop interface; annotating them would mean editing the very markup this port
// exists to preserve.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/RangeExplainer.jsx).
   The body is unchanged; only the IIFE wrapper and the `window.RangeExplainer`
   global became a real import/export. */
import React from "react";
import { useCardVisible } from "./useCardVisible";

const SCENES = [{
  t: 0,
  title: "Your liquidity sits inside a price band",
  body: "The capital you delegate becomes one position on PancakeSwap v3, quoting between a lower and an upper price you choose."
}, {
  t: 1600,
  title: "It earns fees only while the price is inside",
  body: "Every swap that routes through your band pays you a share of the fee. In range is the only state that earns."
}, {
  t: 3300,
  title: "The price drifts out of the band",
  body: "BNB trades above your upper bound. The position stops earning and is now sitting in one asset."
}, {
  t: 4900,
  title: "It waits out your drift trigger",
  body: "A brief spike is not a reason to pay gas. The agent only acts after the drift and cooldown you set are both cleared."
}, {
  t: 6400,
  title: "Then it re-ranges, once",
  body: "One rotation: withdraw, collect the fees earned, swap only what balancing needs, and mint a new band around the current price."
}, {
  t: 8200,
  title: "Back in range, earning again",
  body: "Fees resume. You keep the position; the agent only moves where it quotes."
}];
const TOTAL = 10000;
const OUT_AT = 3400,
  ROTATE_AT = 6400,
  BACK_AT = 6900;
const X0 = 66,
  X1 = 560,
  N = 170,
  VW = 700,
  VH = 292;
const y = p => 262 - (p - 596) * (222 / 52);
const BAND = "var(--cat-lp)",
  WARN = "var(--warn)";
const B1 = {
    lo: 606,
    hi: 626
  },
  B2 = {
    lo: 624,
    hi: 644
  };
function RangeExplainer({
  pair = "BNB / USDT",
  protocol = "PancakeSwap v3",
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
      if (s.playing) {
        const prev = s.e;
        s.e = (s.e + dt) % TOTAL;
        if (s.e < prev) s.cur = y(616);
      }
      const ev = s.e;
      const target = ev < 3300 ? 616 : ev < 4900 ? 633 : 634.5;
      s.seed += dt / 1000;
      const jitter = Math.sin(s.seed * 2.3) * 1.5 + Math.sin(s.seed * 6.1) * 0.8 + Math.sin(s.seed * 16.9) * 0.35;
      s.cur += (y(target + jitter) - s.cur) * 0.12;
      setPts(prev => {
        const nx = prev.slice(1);
        nx.push(s.cur);
        return nx;
      });
      setE(ev);
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
    st.current.cur = y(t < 3300 ? 616 : t < 4900 ? 633 : 634.5);
    setE(t);
  };
  const rotated = e >= ROTATE_AT;
  const band = rotated ? B2 : B1;
  const inRange = e < OUT_AT || e >= BACK_AT;
  const shift = y(band.hi) - y(B1.hi);
  const fees = e < ROTATE_AT ? 12.4 * Math.min(e, OUT_AT) / OUT_AT : 1.9 * Math.max(0, Math.min(1, (e - BACK_AT) / (TOTAL - BACK_AT)));
  const path = pts.map((py, i) => `${(X0 + i * (X1 - X0) / (N - 1)).toFixed(1)},${py.toFixed(1)}`).join(" ");
  const headY = pts[pts.length - 1];
  const FILLS = [{
    t: OUT_AT,
    tone: "warn",
    text: "Out of range at $632.10",
    sub: "fees stopped accruing"
  }, {
    t: ROTATE_AT,
    tone: "band",
    text: "Re-ranged to $624 – $644",
    sub: "collected $12.40 in fees · 1 rotation"
  }];
  const pulse = FILLS.find(f => e >= f.t && e < f.t + 650);
  const feed = FILLS.filter(f => e >= f.t);
  const bandC = inRange ? BAND : WARN;
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
  }, /*#__PURE__*/React.createElement("g", {
    style: {
      transform: `translateY(${shift}px)`,
      transition: "transform .85s var(--ease-out)"
    }
  }, /*#__PURE__*/React.createElement("rect", {
    x: X0,
    y: y(B1.hi),
    width: X1 - X0,
    height: y(B1.lo) - y(B1.hi),
    fill: inRange ? "var(--cat-lp-tint)" : "var(--warn-tint)",
    stroke: "none",
    style: {
      transition: "fill .5s ease"
    }
  }), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: y(B1.hi),
    x2: X1,
    y2: y(B1.hi),
    stroke: bandC,
    strokeWidth: "2",
    strokeLinecap: "round",
    style: {
      transition: "stroke .5s ease"
    }
  }), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: y(B1.lo),
    x2: X1,
    y2: y(B1.lo),
    stroke: bandC,
    strokeWidth: "2",
    strokeLinecap: "round",
    style: {
      transition: "stroke .5s ease"
    }
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 12,
    y: y(B1.hi) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: bandC,
      transition: "fill .5s ease"
    }
  }, "$", band.hi), /*#__PURE__*/React.createElement("text", {
    x: X1 + 12,
    y: y(B1.lo) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: bandC,
      transition: "fill .5s ease"
    }
  }, "$", band.lo), /*#__PURE__*/React.createElement("text", {
    x: X0 + 8,
    y: y(B1.hi) + 20,
    style: {
      font: "var(--type-mono-xs)",
      fill: bandC,
      transition: "fill .5s ease"
    }
  }, inRange ? "YOUR RANGE · EARNING" : "YOUR RANGE · IDLE")), /*#__PURE__*/React.createElement("polyline", {
    points: path,
    fill: "none",
    stroke: "var(--brand)",
    strokeWidth: "1.8",
    strokeLinejoin: "round"
  }), pulse && /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: 10 + (e - pulse.t) / 650 * 28,
    fill: "none",
    stroke: pulse.tone === "warn" ? WARN : BAND,
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
  }), /*#__PURE__*/React.createElement("text", {
    x: X0,
    y: 26,
    style: {
      font: "var(--type-mono-xs)",
      fill: inRange ? "var(--profit)" : "var(--warn)"
    }
  }, inRange ? "IN RANGE" : "OUT OF RANGE", " \xB7 FEES $", fees.toFixed(2)))), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("span", null, "BAND WIDTH \xB11.6%"), /*#__PURE__*/React.createElement("span", null, "DRIFT TRIGGER 1.0%"), /*#__PURE__*/React.createElement("span", null, "COOLDOWN 15M"), /*#__PURE__*/React.createElement("span", null, "ONE ROTATION PER TRIGGER")));
}

export { RangeExplainer };

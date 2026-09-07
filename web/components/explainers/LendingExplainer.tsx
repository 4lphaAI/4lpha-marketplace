// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its inline scene/geometry helpers would each need a hand-written
// prop interface; annotating them would mean editing the very markup this port
// exists to preserve.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/LendingExplainer.jsx).
   The body is unchanged; only the IIFE wrapper and the `window.LendingExplainer`
   global became a real import/export. */
import React from "react";

const SCENES = [{
  t: 0,
  title: "It watches your health factor, not your positions",
  body: "Health factor is collateral vs. debt on Venus. Above 1.0 you're safe; at 1.0 you're liquidated."
}, {
  t: 1600,
  title: "The market moves, your factor drifts down",
  body: "No action yet — a dip alone isn't the trigger."
}, {
  t: 3300,
  title: "It crosses your trigger line",
  body: "You set this line above the danger zone, e.g. 1.15, so there's room to act before it's too late."
}, {
  t: 4900,
  title: "It repays your largest debt first",
  body: "Using only the wallet balance you hold for this, never new borrowing, never your other assets."
}, {
  t: 6400,
  title: "It re-reads the real result on-chain",
  body: "Not an estimate — the actual health factor after the repay lands, confirmed before it stops."
}, {
  t: 8200,
  title: "Back above your target, then it waits again",
  body: "Recovered past your target factor. Every repay is logged, and it does this again next time you drift."
}];
const TOTAL = 10000;
const DRIFT_AT = 1600,
  TRIGGER_AT = 3300,
  REPAY_AT = 4900,
  CONFIRM_AT = 6400,
  DONE_AT = 8200;
const X0 = 84,
  X1 = 560,
  VW = 700,
  VH = 292;
const yTop = 40,
  yBot = 232;
const HF_MAX = 2.2,
  HF_MIN = 0.9;
const yOf = hf => yTop + (HF_MAX - hf) / (HF_MAX - HF_MIN) * (yBot - yTop);
// MARKETPLACE-LENDING-AGENT §4.2 / R2.17: the animation and the deploy form
// must agree, so these are the SHIPPED defaults (the operator's ruling of
// 2026-09-06, closing OQ2), not the design export's 1.15 / 1.55.
const TRIGGER = 1.2,
  TARGET = 1.5,
  START = 1.9,
  LOW = 1.08,
  RECOVERED = 1.52;
const N = 170;
const LOSS = "var(--loss)",
  LP = "var(--cat-lp)";
function LendingExplainer({
  protocol = "Venus"
}) {
  const [e, setE] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const [pts, setPts] = React.useState(() => new Array(N).fill(yOf(START)));
  const st = React.useRef({
    e: 0,
    cur: yOf(START),
    last: 0,
    playing: true
  });
  st.current.playing = playing;
  React.useEffect(() => {
    let raf;
    const loop = ts => {
      const s = st.current;
      const dt = s.last ? Math.min(64, ts - s.last) : 16;
      s.last = ts;
      if (s.playing) {
        const prev = s.e;
        s.e = (s.e + dt) % TOTAL;
        if (s.e < prev) s.cur = yOf(START);
      }
      const ev = s.e;
      let target = START;
      if (ev >= DRIFT_AT && ev < REPAY_AT) target = LOW + (START - LOW) * Math.max(0, 1 - (ev - DRIFT_AT) / (REPAY_AT - DRIFT_AT));else if (ev >= REPAY_AT && ev < CONFIRM_AT) target = LOW + (RECOVERED - LOW) * ((ev - REPAY_AT) / (CONFIRM_AT - REPAY_AT));else if (ev >= CONFIRM_AT) target = RECOVERED;
      s.cur += (yOf(target) - s.cur) * 0.14;
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
  }, []);
  const sceneIdx = SCENES.reduce((acc, s, i) => e >= s.t ? i : acc, 0);
  const scene = SCENES[sceneIdx];
  const jump = i => {
    const t = SCENES[i].t + 1;
    st.current.e = t;
    setE(t);
  };
  const path = pts.map((py, i) => `${(X0 + i * (X1 - X0) / (N - 1)).toFixed(1)},${py.toFixed(1)}`).join(" ");
  const headY = pts[pts.length - 1];
  const danger = e >= TRIGGER_AT && e < CONFIRM_AT;
  const repaying = e >= REPAY_AT && e < CONFIRM_AT;
  const hfNow = e >= CONFIRM_AT ? RECOVERED : e >= REPAY_AT ? LOW + (RECOVERED - LOW) * ((e - REPAY_AT) / (CONFIRM_AT - REPAY_AT)) : e >= DRIFT_AT ? LOW + (START - LOW) * Math.max(0, 1 - (e - DRIFT_AT) / (REPAY_AT - DRIFT_AT)) : START;
  const FILLS = [{
    t: TRIGGER_AT + 300,
    tone: "warn",
    text: "HF 1.14 crossed trigger 1.15",
    sub: "repay queued"
  }, {
    t: REPAY_AT + 300,
    tone: "lp",
    text: "Repaid 42 USDT of vUSDT debt",
    sub: "largest debt market \u00b7 wallet balance only"
  }, {
    t: CONFIRM_AT + 300,
    tone: "ok",
    text: "HF confirmed 1.62 on-chain",
    sub: "0x91c4\u2026a02 \u00b7 journaled"
  }];
  const pulse = FILLS.find(f => e >= f.t && e < f.t + 650);
  const feed = FILLS.filter(f => e >= f.t);
  const tint = t => t === "warn" ? "var(--warn-tint)" : t === "ok" ? "var(--live-tint)" : "var(--cat-lp-tint)";
  const tone = t => t === "warn" ? "var(--warn)" : t === "ok" ? "var(--profit)" : LP;
  return /*#__PURE__*/React.createElement("section", {
    style: {
      border: "1px solid var(--border-card)",
      borderRadius: "var(--radius-md)",
      background: "var(--surface-card)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
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
  }, protocol, " lending"), /*#__PURE__*/React.createElement("button", {
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
  }, /*#__PURE__*/React.createElement("rect", {
    x: X0,
    y: yOf(1.0),
    width: X1 - X0,
    height: yBot - yOf(1.0),
    fill: "var(--loss)",
    opacity: "0.08"
  }), /*#__PURE__*/React.createElement("text", {
    x: X0,
    y: yBot + 16,
    style: {
      font: "var(--type-mono-xs)",
      fill: LOSS
    }
  }, "LIQUIDATION AT 1.00"), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: yOf(TRIGGER),
    x2: X1,
    y2: yOf(TRIGGER),
    stroke: danger ? LOSS : "var(--ink-2)",
    strokeWidth: "1.5",
    strokeDasharray: "4 4",
    style: {
      transition: "stroke .3s ease"
    }
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 10,
    y: yOf(TRIGGER) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: danger ? LOSS : "var(--text-subtle)"
    }
  }, "TRIGGER 1.20"), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: yOf(TARGET),
    x2: X1,
    y2: yOf(TARGET),
    stroke: LP,
    strokeWidth: "1.5",
    strokeDasharray: "4 4",
    opacity: "0.7"
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 10,
    y: yOf(TARGET) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: LP
    }
  }, "TARGET 1.50"), /*#__PURE__*/React.createElement("polyline", {
    points: path,
    fill: "none",
    stroke: danger ? LOSS : "var(--brand)",
    strokeWidth: "1.8",
    strokeLinejoin: "round",
    style: {
      transition: "stroke .3s ease"
    }
  }), pulse && /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: 10 + (e - pulse.t) / 650 * 28,
    fill: "none",
    stroke: tone(pulse.tone),
    strokeWidth: "1.5",
    opacity: 1 - (e - pulse.t) / 650
  }), /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: "4.5",
    fill: danger ? LOSS : "var(--brand)"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: "11",
    fill: "none",
    stroke: "var(--brand-line)"
  }), /*#__PURE__*/React.createElement("text", {
    x: X0,
    y: 24,
    style: {
      font: "var(--type-mono-xs)",
      fill: danger ? LOSS : "var(--profit)"
    }
  }, "HF ", hfNow.toFixed(2), repaying ? " \u00b7 REPAYING" : danger ? " \u00b7 BELOW TRIGGER" : ""))), /*#__PURE__*/React.createElement("div", {
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
      border: `1px solid ${tint(f.tone)}`,
      background: tint(f.tone),
      color: "var(--ink-1)"
    }
  }, f.text, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-subtle)"
    }
  }, f.sub)))), /*#__PURE__*/React.createElement("div", {
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
  }, scene.body)), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("span", null, "TRIGGER HF 1.20"), /*#__PURE__*/React.createElement("span", null, "TARGET HF 1.50"), /*#__PURE__*/React.createElement("span", null, "REPAYS FROM THE AGENT RESERVE ONLY")));
}

export { LendingExplainer };

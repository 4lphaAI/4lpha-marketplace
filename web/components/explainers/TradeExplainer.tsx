// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its inline scene/geometry helpers would each need a hand-written
// prop interface; annotating them would mean editing the very markup this port
// exists to preserve.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/TradeExplainer.jsx).
   The body is unchanged; only the IIFE wrapper and the `window.TradeExplainer`
   global became a real import/export. */
import React from "react";

const SCENES = [{
  t: 0,
  title: "It screens new pairs as they appear",
  body: "Every new pair on the venue is scored: market cap, liquidity, and the model's confidence in it."
}, {
  t: 1700,
  title: "Your entry filter rejects most of them",
  body: "Below your market-cap floor, under your confidence threshold, or already held — none of those get an entry."
}, {
  t: 3300,
  title: "One passes, and it sizes the entry",
  body: "The entry is your fixed size, not the model's opinion, and it only opens if you have a free position slot."
}, {
  t: 4900,
  title: "From there it manages the position",
  body: "Your take-profit targets sit above the entry, your stop below. Both are set before the trade exists."
}, {
  t: 6400,
  title: "Take-profit fills in stages",
  body: "The first target sells part of the position and moves the stop to break-even, so the rest runs at no risk to your capital."
}, {
  t: 8200,
  title: "It closes on a target, the stop, or your clock",
  body: "Whichever comes first. The exit, the fees and the net result go in your log."
}];
const TOTAL = 10000;
const PASS_AT = 2900,
  ENTRY_AT = 3500,
  TP_AT = 6600,
  EXIT_AT = 8500;
const VW = 700,
  VH = 292,
  N = 150,
  X0 = 300,
  X1 = 560;
const yP = pct => 244 - (pct + 40) * (128 / 110);
const YELLOW = "var(--cat-yield)";
const CANDS = [{
  t: 250,
  v: 1900,
  pair: "PEPE / BNB",
  meta: "MC $3.1M · CONF 78",
  ok: false,
  why: "under MC floor"
}, {
  t: 550,
  v: 2200,
  pair: "TAO / BNB",
  meta: "MC $84M · CONF 61",
  ok: false,
  why: "confidence < 72"
}, {
  t: 850,
  v: 2500,
  pair: "CAKE / BNB",
  meta: "MC $412M · CONF 80",
  ok: false,
  why: "already held"
}, {
  t: 1150,
  v: PASS_AT,
  pair: "ASTER / BNB",
  meta: "MC $42M · CONF 84",
  ok: true,
  why: "passes"
}];
function TradeExplainer({
  pair = "BNB / USDT",
  protocol = "PancakeSwap v3"
}) {
  const [e, setE] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const [pts, setPts] = React.useState(() => new Array(N).fill(yP(0)));
  const st = React.useRef({
    e: 0,
    cur: yP(0),
    last: 0,
    playing: true,
    seed: 0
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
        if (s.e < prev) s.cur = yP(0);
      }
      const ev = s.e;
      const target = ev < ENTRY_AT ? 1 : ev < 5600 ? 14 : ev < TP_AT ? 41 : ev < EXIT_AT ? 33 : 31;
      s.seed += dt / 1000;
      const j = Math.sin(s.seed * 2.5) * 3.4 + Math.sin(s.seed * 6.9) * 1.6 + Math.sin(s.seed * 16.3) * 0.7;
      s.cur += (yP(target + j) - s.cur) * 0.12;
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
    st.current.cur = yP(t < ENTRY_AT ? 1 : t < TP_AT ? 20 : 33);
    setE(t);
  };
  const entered = e >= ENTRY_AT;
  const tpHit = e >= TP_AT;
  const closed = e >= EXIT_AT;
  const stopPct = tpHit ? 0 : -25;
  const path = pts.map((py, i) => `${(X0 + i * (X1 - X0) / (N - 1)).toFixed(1)},${py.toFixed(1)}`).join(" ");
  const headY = pts[pts.length - 1];
  const FILLS = [{
    t: PASS_AT,
    tone: "y",
    text: "3 of 4 candidates rejected",
    sub: "min MC $10M · confidence ≥ 72 · no re-entry"
  }, {
    t: ENTRY_AT,
    tone: "y",
    text: "Entered 0.005 BNB",
    sub: "position 2 of 3 max · slippage cap 0.75%"
  }, {
    t: TP_AT,
    tone: "ok",
    text: "TP1 filled at +40% on half",
    sub: "stop moved to break-even"
  }, {
    t: EXIT_AT,
    tone: "ok",
    text: "Closed +31.4% net",
    sub: "0x4b71…9de · journaled"
  }];
  const pulse = FILLS.slice(1).find(f => e >= f.t && e < f.t + 600);
  const feed = FILLS.filter(f => e >= f.t);
  const tone = t => t === "ok" ? "var(--profit)" : YELLOW;
  const tint = t => t === "ok" ? "var(--live-tint)" : "var(--cat-yield-tint)";
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
  }, "Signal entries \xB7 ", protocol), /*#__PURE__*/React.createElement("button", {
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
    x: 28,
    y: 24,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--text-subtle)"
    }
  }, "NEW PAIRS"), CANDS.map((c, i) => {
    const shown = e >= c.t;
    const judged = e >= c.v;
    const col = !judged ? "var(--line-2)" : c.ok ? "var(--profit)" : "var(--ink-4)";
    return /*#__PURE__*/React.createElement("g", {
      key: c.pair,
      style: {
        opacity: shown ? judged && !c.ok ? 0.4 : 1 : 0,
        transition: "opacity .4s ease"
      }
    }, /*#__PURE__*/React.createElement("rect", {
      x: 28,
      y: 40 + i * 42,
      width: 240,
      height: 34,
      rx: "4",
      fill: judged && c.ok ? "var(--live-tint)" : "var(--surface-sunken)",
      stroke: col
    }), /*#__PURE__*/React.createElement("text", {
      x: 40,
      y: 54 + i * 42,
      style: {
        font: "var(--type-mono-xs)",
        fill: judged && c.ok ? "var(--ink-1)" : "var(--text-muted)"
      }
    }, c.pair), /*#__PURE__*/React.createElement("text", {
      x: 40,
      y: 68 + i * 42,
      style: {
        font: "var(--type-mono-xs)",
        fill: "var(--text-subtle)"
      }
    }, c.meta), judged && /*#__PURE__*/React.createElement("text", {
      x: 256,
      y: 61 + i * 42,
      textAnchor: "end",
      style: {
        font: "var(--type-mono-xs)",
        fill: c.ok ? "var(--profit)" : "var(--ink-3)"
      }
    }, c.ok ? "PASS" : "SKIP · " + c.why));
  }), /*#__PURE__*/React.createElement("text", {
    x: X0,
    y: 24,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--text-subtle)"
    }
  }, entered ? closed ? "CLOSED · +31.4%" : "ASTER / BNB · OPEN" : "AWAITING A PASS"), /*#__PURE__*/React.createElement("g", {
    style: {
      opacity: entered ? 1 : 0.25,
      transition: "opacity .5s ease"
    }
  }, /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: yP(40),
    x2: X1,
    y2: yP(40),
    stroke: YELLOW,
    strokeWidth: "1.5",
    strokeDasharray: tpHit ? "3 6" : undefined
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 10,
    y: yP(40) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: YELLOW
    }
  }, "TP1 +40%"), /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: yP(0),
    x2: X1,
    y2: yP(0),
    stroke: "var(--line-3)",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 10,
    y: yP(0) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--text-subtle)"
    }
  }, tpHit ? "ENTRY · STOP AT B/E" : "ENTRY"), /*#__PURE__*/React.createElement("g", {
    style: {
      transform: `translateY(${yP(stopPct) - yP(-25)}px)`,
      transition: "transform .6s var(--ease-out)"
    }
  }, /*#__PURE__*/React.createElement("line", {
    x1: X0,
    y1: yP(-25),
    x2: X1,
    y2: yP(-25),
    stroke: "var(--loss)",
    strokeWidth: "1.5",
    strokeDasharray: "4 4"
  }), /*#__PURE__*/React.createElement("text", {
    x: X1 + 10,
    y: yP(-25) + 4,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--loss)",
      opacity: tpHit ? 0 : 1,
      transition: "opacity .3s ease"
    }
  }, "STOP -25%"))), /*#__PURE__*/React.createElement("polyline", {
    points: path,
    fill: "none",
    stroke: "var(--brand)",
    strokeWidth: "1.8",
    strokeLinejoin: "round"
  }), pulse && /*#__PURE__*/React.createElement("circle", {
    cx: X1,
    cy: headY,
    r: 9 + (e - pulse.t) / 600 * 26,
    fill: "none",
    stroke: tone(pulse.tone),
    strokeWidth: "1.5",
    opacity: 1 - (e - pulse.t) / 600
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
  }), /*#__PURE__*/React.createElement("g", {
    style: {
      opacity: entered ? 1 : 0,
      transition: "opacity .4s ease"
    }
  }, /*#__PURE__*/React.createElement("text", {
    x: X0,
    y: 272,
    style: {
      font: "var(--type-mono-xs)",
      fill: "var(--text-subtle)"
    }
  }, "SIZE 0.005 BNB \xB7 SLOTS ", closed ? "1" : "2", " / 3 \xB7 HOLD ", closed ? "412" : "168", " / 480 MIN")))), /*#__PURE__*/React.createElement("div", {
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
  }, /*#__PURE__*/React.createElement("span", null, "MODELS MID-CAP / DEGEN / SIGMA"), /*#__PURE__*/React.createElement("span", null, "MAX 3 OPEN POSITIONS"), /*#__PURE__*/React.createElement("span", null, "NO RE-ENTRY"), /*#__PURE__*/React.createElement("span", null, "MAX HOLD 480 MIN")));
}

export { TradeExplainer };

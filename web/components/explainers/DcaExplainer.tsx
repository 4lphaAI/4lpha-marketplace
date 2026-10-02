// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose.
// The animation source is mechanically extracted from the supplied Claude Design standalone.
"use client";
import React from "react";
/* TradFi · Auto DCA explainer. Mirrors the deploy form's `dca` section: one bStock, total budget,
   buy trigger (interval / price drop / both), amount per cycle, extra buy on drop below the last fill,
   take profit + stop loss from the average cost, sell style, restart after take-profit. */
const TOKEN = "SPCXB";
const PER = 100, BUDGET = 1000, TP = 25, SL = 30, DIP = 5;
const SCENES = [
  { t: 0, title: "You pick one bStock, a budget and a buy trigger", body: "100 USDT of " + TOKEN + " every day from a 1,000 USDT budget. The trigger can be a fixed interval, a price drop, or both." },
  { t: 1200, title: "It buys a fixed amount every cycle", body: "Each cycle spends the same USDT inside your slippage cap, so more tokens come in when the price is lower." },
  { t: 3050, title: "A drop below the last fill adds an extra buy", body: "When price falls 5% under the last fill, it adds one cycle right away instead of waiting for the next interval." },
  { t: 4700, title: "Your average cost sets the exit lines", body: "Take profit sits 25% above your average cost and the stop 30% below it. Both lines move with every new buy." },
  { t: 8100, title: "Take profit sells the position", body: "All at once, or in 4 tranches if you chose scale-out. The fill, the fees and the net result go in your log." },
  { t: 9300, title: "Then the schedule starts again", body: "With restart on, a new cycle begins after the take-profit fills, and keeps going until the budget or your max cycles runs out." },
];
const TOTAL = 11800, SPAN = 10600;
const KEYS = [[0, 101], [1200, 100], [2400, 97], [3100, 91.5], [3600, 92.2], [4800, 95], [6000, 104], [7200, 112], [8150, 123.1], [8700, 120.4], [9400, 119.5], [10600, 120.6]];
const BUYS = [
  { t: 1200, kind: "interval" }, { t: 2400, kind: "interval" }, { t: 3100, kind: "dip" }, { t: 3600, kind: "interval" },
  { t: 4800, kind: "interval" }, { t: 6000, kind: "interval" }, { t: 7200, kind: "interval" },
].map((b) => ({ ...b, p: priceAt(b.t) }));
const SELL_AT = 8150, RESTART_AT = 9400;
const RESTART = { t: RESTART_AT, kind: "interval", p: priceAt(RESTART_AT) };
function priceAt(t) {
  let k = 0;
  while (k < KEYS.length - 2 && t > KEYS[k + 1][0]) k++;
  const [t0, p0] = KEYS[k], [t1, p1] = KEYS[k + 1];
  const u = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return p0 + (p1 - p0) * ((1 - Math.cos(u * Math.PI)) / 2) + Math.sin(t * 0.011) * 0.35 * Math.sin(u * Math.PI);
}
const VW = 700, VH = 292, X0 = 28, X1 = 452, RX = 492;
const xT = (t) => X0 + (Math.min(t, SPAN) / SPAN) * (X1 - X0);
const yP = (p) => 214 - (p - 86) * (170 / 44);
const YELLOW = "var(--cat-yield)";
const mono = { font: "var(--type-mono-xs)" };

function DcaExplainer({ protocol = "PancakeSwap v3" }) {
  const [e, setE] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const st = React.useRef({ e: 0, last: 0, playing: true });
  st.current.playing = playing;
  React.useEffect(() => {
    let raf;
    const loop = (ts) => {
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

  const sceneIdx = SCENES.reduce((acc, s, i) => (e >= s.t ? i : acc), 0);
  const scene = SCENES[sceneIdx];
  const jump = (i) => { const t = SCENES[i].t + 1; st.current.e = t; setE(t); };

  const sold = e >= SELL_AT;
  const restarted = e >= RESTART_AT;
  const cycle1 = BUYS.filter((b) => e >= b.t);
  const open = sold ? (restarted ? [RESTART] : []) : cycle1;
  const tokens = open.reduce((a, b) => a + PER / b.p, 0);
  const avg = open.length ? (open.length * PER) / tokens : null;
  const spent = (sold ? BUYS.length + (restarted ? 1 : 0) : cycle1.length) * PER;
  const c1Tokens = BUYS.reduce((a, b) => a + PER / b.p, 0);
  const c1Avg = (BUYS.length * PER) / c1Tokens;
  const proceeds = c1Tokens * priceAt(SELL_AT);

  const et = Math.min(e, SPAN);
  const pts = [];
  for (let t = 0; t <= et; t += 60) pts.push(`${xT(t).toFixed(1)},${yP(priceAt(t)).toFixed(1)}`);
  pts.push(`${xT(et).toFixed(1)},${yP(priceAt(et)).toFixed(1)}`);
  const hx = xT(et), hy = yP(priceAt(et));

  const FEED = [
    ...BUYS.map((b, i) => ({ t: b.t, tone: b.kind === "dip" ? "y" : "ok", text: b.kind === "dip" ? `Extra buy on −${DIP}% drop` : `Cycle ${i + 1 - (i > 2 ? 1 : 0)} · bought`, sub: `${PER} USDT at ${b.p.toFixed(2)} · ${(PER / b.p).toFixed(4)} ${TOKEN}` })),
    { t: SELL_AT, tone: "ok", text: `Take profit · sold ${c1Tokens.toFixed(4)} ${TOKEN}`, sub: `${proceeds.toFixed(0)} USDT back · +${TP}% on ${c1Avg.toFixed(2)} avg` },
    { t: RESTART_AT, tone: "y", text: "Schedule restarted", sub: `cycle 1 · ${PER} USDT at ${RESTART.p.toFixed(2)}` },
  ];
  const feed = FEED.filter((f) => e >= f.t).slice(-2);
  const pulse = FEED.find((f) => e >= f.t && e < f.t + 600);
  const tone = (t) => (t === "ok" ? "var(--profit)" : YELLOW);
  const tint = (t) => (t === "ok" ? "var(--live-tint)" : "var(--cat-yield-tint)");
  const lastFill = open.length ? open[open.length - 1].p : null;
  const tpP = avg ? avg * (1 + TP / 100) : null;

  return (
    <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line-1)" }}>
        <span style={{ font: "var(--type-card-title)" }}>How this agent works</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>TradFi · Auto DCA · {protocol}</span>
          <button onClick={() => setPlaying((p) => !p)} style={{ font: "var(--type-mono-xs)", color: "var(--text-muted)", background: "none", border: "1px solid var(--line-2)", borderRadius: 999, padding: "3px 10px", cursor: "pointer" }}>{playing ? "Pause" : "Play"}</button>
        </div>
      </div>

      <div style={{ padding: "8px 12px 0" }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} style={{ display: "block", width: "100%", height: "auto" }}>
          <text x={X0} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>{TOKEN} / USDT</text>

          {BUYS.filter((b) => b.kind === "interval").concat([RESTART]).map((b) => (
            <line key={b.t} x1={xT(b.t)} x2={xT(b.t)} y1={40} y2={220} stroke="var(--line-1)" strokeDasharray="2 4" />
          ))}

          <g style={{ opacity: avg ? 1 : 0, transition: "opacity .4s ease" }}>
            <g style={{ transform: `translateY(${avg ? Math.max(yP(128) + 10, yP(tpP)) - yP(120) : 0}px)`, transition: "transform .6s var(--ease-out)" }}>
              <line x1={X0} x2={X1} y1={yP(120)} y2={yP(120)} stroke={YELLOW} strokeWidth="1.5" strokeDasharray={sold && !restarted ? "3 6" : undefined} />
              <text x={X1 - 2} y={yP(120) - 6} textAnchor="end" style={{ ...mono, fill: YELLOW }}>TP +{TP}%</text>
            </g>
            <g style={{ transform: `translateY(${avg ? yP(avg) - yP(96) : 0}px)`, transition: "transform .6s var(--ease-out)" }}>
              <line x1={X0} x2={X1} y1={yP(96)} y2={yP(96)} stroke="var(--line-3)" strokeWidth="1" strokeDasharray="4 4" />
              <text x={X1 - 2} y={yP(96) - 6} textAnchor="end" style={{ ...mono, fill: "var(--text-subtle)" }}>AVG</text>
            </g>
          </g>
          {lastFill && !sold && (
            <g style={{ transform: `translateY(${yP(lastFill * (1 - DIP / 100)) - yP(90)}px)`, transition: "transform .6s var(--ease-out)" }}>
              <line x1={X0} x2={X1} y1={yP(90)} y2={yP(90)} stroke="var(--ink-4)" strokeWidth="1" strokeDasharray="1 4" />
              <text x={X1 - 2} y={yP(90) + 14} textAnchor="end" style={{ ...mono, fill: "var(--ink-3)" }}>−{DIP}% DIP</text>
            </g>
          )}

          <polyline points={pts.join(" ")} fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinejoin="round" />

          {BUYS.concat([RESTART]).filter((b) => e >= b.t).map((b) => (
            <circle key={b.t} cx={xT(b.t)} cy={yP(b.p)} r="4.5" fill={b.kind === "dip" ? YELLOW : "var(--ink-2)"} stroke="var(--surface-card)" strokeWidth="1.5" opacity={sold && b.t < SELL_AT ? 0.45 : 1} />
          ))}
          {sold && <g>
            <circle cx={xT(SELL_AT)} cy={yP(priceAt(SELL_AT))} r="5" fill="var(--profit)" stroke="var(--surface-card)" strokeWidth="1.5" />
            <text x={xT(SELL_AT)} y={yP(priceAt(SELL_AT)) - 12} textAnchor="middle" style={{ ...mono, fill: "var(--profit)" }}>SELL</text>
          </g>}

          {pulse && <circle cx={hx} cy={hy} r={9 + ((e - pulse.t) / 600) * 24} fill="none" stroke={tone(pulse.tone)} strokeWidth="1.5" opacity={1 - (e - pulse.t) / 600} />}
          <circle cx={hx} cy={hy} r="4" fill="var(--brand)" />

          <g style={mono}>
            <circle cx={X0 + 4} cy={250} r="4" fill="var(--ink-2)" /><text x={X0 + 14} y={254} style={{ fill: "var(--text-subtle)" }}>INTERVAL BUY</text>
            <circle cx={X0 + 124} cy={250} r="4" fill={YELLOW} /><text x={X0 + 134} y={254} style={{ fill: "var(--text-subtle)" }}>DIP BUY</text>
            <circle cx={X0 + 214} cy={250} r="4" fill="var(--profit)" /><text x={X0 + 224} y={254} style={{ fill: "var(--text-subtle)" }}>TAKE PROFIT</text>
          </g>

          <line x1={RX - 12} x2={RX - 12} y1={14} y2={268} stroke="var(--line-1)" />
          <text x={RX} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>HOLDINGS</text>
          <text x={RX} y={52} style={{ font: "var(--weight-semibold) 20px/1 var(--font-mono)", fill: "var(--ink-1)" }}>{tokens.toFixed(4)}</text>
          <text x={RX} y={70} style={{ ...mono, fill: "var(--text-muted)" }}>{TOKEN}</text>

          <text x={RX} y={102} style={{ ...mono, fill: "var(--text-subtle)" }}>AVERAGE COST</text>
          <text x={RX} y={120} style={{ ...mono, fill: "var(--ink-1)" }}>{avg ? avg.toFixed(2) + " USDT" : "—"}</text>

          <text x={RX} y={152} style={{ ...mono, fill: "var(--text-subtle)" }}>BUDGET</text>
          <rect x={RX} y={162} width={190} height={8} rx="2" fill="var(--raised-3)" />
          <rect x={RX} y={162} width={190 * (spent / BUDGET)} height={8} rx="2" fill="var(--brand)" style={{ transition: "width .4s var(--ease-out)" }} />
          <text x={RX} y={188} style={{ ...mono, fill: "var(--ink-1)" }}>{spent.toLocaleString("en-US")} / {BUDGET.toLocaleString("en-US")} USDT USED</text>

          <text x={RX} y={220} style={{ ...mono, fill: "var(--text-subtle)" }}>EXIT</text>
          <text x={RX} y={238} style={{ ...mono, fill: sold && !restarted ? "var(--profit)" : "var(--ink-1)" }}>{sold && !restarted ? `CLOSED · +${TP}% · ${proceeds.toFixed(0)} USDT` : avg ? `TP ${tpP.toFixed(2)} · STOP ${(avg * (1 - SL / 100)).toFixed(2)}` : `TP +${TP}% · STOP −${SL}%`}</text>
          <text x={RX} y={256} style={{ ...mono, fill: "var(--text-subtle)" }}>{restarted ? "CYCLE 2 · RESTARTED" : "FROM YOUR AVERAGE COST"}</text>
        </svg>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "4px 20px 0", flexWrap: "wrap", minHeight: 62, alignContent: "flex-start" }}>
        {feed.map((f) => (
          <span key={f.t} style={{ display: "inline-flex", gap: 8, alignItems: "baseline", font: "var(--type-mono-xs)", padding: "5px 10px", borderRadius: "var(--radius-sm)", border: `1px solid ${tint(f.tone)}`, background: tint(f.tone), color: "var(--ink-1)" }}>
            {f.text}<span style={{ color: "var(--text-subtle)" }}>{f.sub}</span>
          </span>
        ))}
      </div>

      <div style={{ padding: 20, display: "grid", gap: 6 }}>
        <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>STEP {sceneIdx + 1} / {SCENES.length}</span>
        <span style={{ font: "var(--type-card-title)" }}>{scene.title}</span>
        <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "70ch", textWrap: "pretty" }}>{scene.body}</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${SCENES.length},1fr)`, gap: 6, padding: "0 20px 20px" }}>
        {SCENES.map((s, i) => (
          <button key={s.t} onClick={() => jump(i)} title={s.title}
            style={{ height: 3, borderRadius: 999, border: "none", padding: 0, cursor: "pointer", background: i === sceneIdx ? "var(--brand)" : "var(--line-2)", transition: "background .3s ease" }} />
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--line-1)", padding: "14px 20px", display: "flex", gap: 24, flexWrap: "wrap", font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
        <span>BSTOCKS ONLY</span><span>INTERVAL · PRICE DROP · BOTH</span><span>TP / STOP FROM AVG COST</span><span>SELL ALL OR 4 TRANCHES</span><span>RESTART AFTER TP</span>
      </div>
    </section>
  );
}

export { DcaExplainer };

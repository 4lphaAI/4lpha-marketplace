// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose.
// The animation source is mechanically extracted from the supplied Claude Design standalone.
"use client";
import React from "react";
/* TradFi · Smart Portfolio explainer. Mirrors the deploy form's `smart` section: total capital,
   allocation template + target weights, rebalance when drift exceeds X%, check every N days,
   min rebalance trade, auto-invest new deposits, rebalance only while markets are open. */
const BASKET = [
  { sym: "NVDAB", target: 30 }, { sym: "TSLAB", target: 25 }, { sym: "AAPLB", target: 25 }, { sym: "SPYB", target: 20 },
];
const BAND = 5, MIN_TRADE = 25;
const SCENES = [
  { t: 0, title: "You set a basket and its target weights", body: "1,000 USDT across four bStocks at 30 / 25 / 25 / 20. Start from equal weight, market-cap weighted, or set your own." },
  { t: 1500, title: "Prices move, and the weights drift", body: "When one stock outruns the others, its share of the basket grows past target. The agent checks on your schedule, every day by default." },
  { t: 3000, title: "Inside the drift band, it holds", body: "If every weight is still within 5% of target, the check ends there. No trade, no gas spent on noise." },
  { t: 6000, title: "Past the band, it rebalances to target", body: "It sells the overweight stock and buys the underweight ones on the venue, inside your slippage cap." },
  { t: 7300, title: "Small legs are skipped", body: "Any leg under your $25 minimum rebalance trade is left alone, because it would cost more in gas than it corrects." },
  { t: 9400, title: "New deposits go straight into the weights", body: "With auto-invest on, new USDT is split across the basket instead of sitting idle. With market hours on, it only trades while the underlying markets are open." },
];
const TOTAL = 12000;
const KEYS = [
  { t: 0, w: [30, 25, 25, 20], v: 1000 },
  { t: 2800, w: [32.4, 24.1, 24.6, 18.9], v: 1031 },
  { t: 3000, w: [32.4, 24.1, 24.6, 18.9], v: 1031 },
  { t: 5800, w: [37.2, 21.9, 24.2, 16.7], v: 1062 },
  { t: 6000, w: [37.2, 21.9, 24.2, 16.7], v: 1062 },
  { t: 6900, w: [30.8, 25, 24.2, 20], v: 1061 },
  { t: 9400, w: [30.8, 25, 24.2, 20], v: 1061 },
  { t: 10200, w: [30.3, 25, 24.9, 19.8], v: 1261 },
  { t: TOTAL, w: [30.3, 25, 24.9, 19.8], v: 1261 },
];
const CHECKS = [{ t: 3000, act: "hold" }, { t: 6000, act: "rebalance" }, { t: 8400, act: "hold" }];
const sgn = (d) => { const r = Math.round(d * 10) / 10; return (r < 0 ? "−" : "+") + Math.abs(r).toFixed(1); };
const DEPOSIT_AT = 9400;
function stateAt(t) {
  let k = 0;
  while (k < KEYS.length - 2 && t > KEYS[k + 1].t) k++;
  const a = KEYS[k], b = KEYS[k + 1];
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  const s = (1 - Math.cos(u * Math.PI)) / 2;
  const wig = (i) => (b.t - a.t > 1500 ? Math.sin(t * 0.004 + i * 1.7) * 0.25 * Math.sin(u * Math.PI) : 0);
  return { w: a.w.map((x, i) => x + (b.w[i] - x) * s + wig(i)), v: a.v + (b.v - a.v) * s };
}
const VW = 700, VH = 292, BX0 = 118, BX1 = 404, RX = 492, TL0 = 118, TL1 = 404;
const bx = (pct) => BX0 + (pct / 45) * (BX1 - BX0);
const tx = (t) => TL0 + (t / TOTAL) * (TL1 - TL0);
const YELLOW = "var(--cat-yield)";
const mono = { font: "var(--type-mono-xs)" };

function SmartExplainer({ protocol = "PancakeSwap v3" }) {
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

  const { w, v } = stateAt(e);
  const drifts = w.map((x, i) => x - BASKET[i].target);
  const maxIdx = drifts.reduce((m, d, i) => (Math.abs(d) > Math.abs(drifts[m]) ? i : m), 0);
  const maxDrift = drifts[maxIdx];
  const lastCheck = CHECKS.filter((c) => e >= c.t).slice(-1)[0];
  const nextCheck = CHECKS.find((c) => e < c.t);
  const rebalancing = e >= 6000 && e < 6900;

  const FEED = [
    { t: 3000, tone: "ok", text: "Check 1 · hold", sub: "max drift +2.4% · inside the ±5% band" },
    { t: 6000, tone: "y", text: "Check 2 · rebalance", sub: "NVDAB +7.2% over target" },
    { t: 6300, tone: "ok", text: "Sold 68 USDT NVDAB · bought TSLAB 33 · SPYB 35", sub: protocol },
    { t: 7300, tone: "y", text: "AAPLB leg skipped", sub: `8 USDT < $${MIN_TRADE} minimum trade` },
    { t: 8400, tone: "ok", text: "Check 3 · hold", sub: "max drift +0.8%" },
    { t: DEPOSIT_AT, tone: "ok", text: "Deposit 200 USDT auto-invested", sub: "split across the basket by target weight" },
  ];
  const feed = FEED.filter((f) => e >= f.t).slice(-2);
  const tint = (t) => (t === "ok" ? "var(--live-tint)" : "var(--cat-yield-tint)");
  const skipGlow = e >= 7300 && e < 8400;

  return (
    <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line-1)" }}>
        <span style={{ font: "var(--type-card-title)" }}>How this agent works</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>TradFi · Smart Portfolio · {protocol}</span>
          <button onClick={() => setPlaying((p) => !p)} style={{ font: "var(--type-mono-xs)", color: "var(--text-muted)", background: "none", border: "1px solid var(--line-2)", borderRadius: 999, padding: "3px 10px", cursor: "pointer" }}>{playing ? "Pause" : "Play"}</button>
        </div>
      </div>

      <div className="fl-explainer-visual" style={{ padding: "8px 12px 0" }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} style={{ display: "block", width: "100%", height: "auto" }}>
          <text x={28} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>BASKET · WEIGHT VS TARGET</text>
          <text x={BX1 + 50} y={24} textAnchor="end" style={{ ...mono, fill: "var(--text-subtle)" }}>DRIFT</text>

          {BASKET.map((b, i) => {
            const y = 44 + i * 46;
            const d = drifts[i];
            const out = Math.abs(d) > BAND;
            const skipped = skipGlow && i === 2;
            return (
              <g key={b.sym}>
                <text x={28} y={y + 11} style={{ ...mono, fill: "var(--ink-1)" }}>{b.sym}</text>
                <text x={28} y={y + 26} style={{ ...mono, fill: "var(--text-subtle)" }}>TARGET {b.target}%</text>
                <rect x={BX0} y={y} width={BX1 - BX0} height={24} rx="3" fill="var(--surface-sunken)" />
                <rect x={bx(b.target - BAND)} y={y} width={bx(b.target + BAND) - bx(b.target - BAND)} height={24} fill="var(--line-1)" />
                <rect x={BX0} y={y + 5} width={Math.max(0, bx(w[i]) - BX0)} height={14} rx="2" fill={out ? YELLOW : "var(--brand)"} opacity={skipped ? 0.55 : 1} />
                <line x1={bx(b.target)} x2={bx(b.target)} y1={y - 3} y2={y + 27} stroke="var(--ink-1)" strokeWidth="1.5" />
                <text x={BX1 + 50} y={y + 16} textAnchor="end" style={{ ...mono, fill: out ? YELLOW : skipped ? YELLOW : "var(--text-muted)" }}>{sgn(d)}%</text>
                {skipped && <text x={bx(w[i]) + 8} y={y + 16} style={{ ...mono, fill: YELLOW }}>SKIP · &lt; ${MIN_TRADE}</text>}
              </g>
            );
          })}

          <text x={28} y={240} style={{ ...mono, fill: "var(--text-subtle)" }}>CHECKS</text>
          <line x1={TL0} x2={TL1} y1={236} y2={236} stroke="var(--line-2)" />
          {CHECKS.map((c, i) => {
            const hit = e >= c.t;
            const col = !hit ? "var(--line-3)" : c.act === "rebalance" ? YELLOW : "var(--profit)";
            return (
              <g key={c.t}>
                <circle cx={tx(c.t)} cy={236} r="5" fill={hit ? col : "var(--surface-card)"} stroke={col} strokeWidth="1.5" />
                <text x={tx(c.t)} y={258} textAnchor="middle" style={{ ...mono, fill: hit ? col : "var(--ink-4)" }}>{hit ? (c.act === "rebalance" ? "REBALANCE" : "HOLD") : "DAY " + (i + 1)}</text>
              </g>
            );
          })}
          <g style={{ opacity: e >= DEPOSIT_AT ? 1 : 0.25 }}>
            <rect x={tx(DEPOSIT_AT) - 4} y={228} width={8} height={16} rx="2" fill={e >= DEPOSIT_AT ? "var(--brand)" : "var(--line-3)"} />
            <text x={tx(DEPOSIT_AT) + 10} y={276} textAnchor="middle" style={{ ...mono, fill: "var(--text-subtle)" }}>DEPOSIT</text>
          </g>
          <line x1={tx(e)} x2={tx(e)} y1={226} y2={246} stroke="var(--brand)" strokeWidth="1.5" />

          <line x1={RX - 12} x2={RX - 12} y1={14} y2={268} stroke="var(--line-1)" />
          <text x={RX} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>PORTFOLIO</text>
          <text x={RX} y={52} style={{ font: "var(--weight-semibold) 20px/1 var(--font-mono)", fill: "var(--ink-1)" }}>{Math.round(v).toLocaleString("en-US")}</text>
          <text x={RX} y={70} style={{ ...mono, fill: "var(--text-muted)" }}>USDT · 4 BSTOCKS</text>

          <text x={RX} y={104} style={{ ...mono, fill: "var(--text-subtle)" }}>MAX DRIFT</text>
          <text x={RX} y={122} style={{ ...mono, fill: Math.abs(maxDrift) > BAND ? YELLOW : "var(--ink-1)" }}>{BASKET[maxIdx].sym} {sgn(maxDrift)}% · BAND ±{BAND}%</text>

          <text x={RX} y={156} style={{ ...mono, fill: "var(--text-subtle)" }}>LAST CHECK</text>
          <text x={RX} y={174} style={{ ...mono, fill: "var(--ink-1)" }}>{rebalancing ? "REBALANCING…" : lastCheck ? (lastCheck.act === "rebalance" ? "REBALANCED · 3 LEGS · 1 SKIPPED" : "HOLD · INSIDE BAND") : "—"}</text>

          <text x={RX} y={208} style={{ ...mono, fill: "var(--text-subtle)" }}>NEXT CHECK</text>
          <text x={RX} y={226} style={{ ...mono, fill: "var(--ink-1)" }}>{nextCheck ? "DAY " + (CHECKS.indexOf(nextCheck) + 1) + " · EVERY 1 DAY" : "DAY 4 · EVERY 1 DAY"}</text>
          <text x={RX} y={256} style={{ ...mono, fill: "var(--text-subtle)" }}>MIN TRADE ${MIN_TRADE} · MARKET HOURS</text>
        </svg>
      </div>

      <div className="fl-explainer-visual" style={{ display: "flex", gap: 8, padding: "4px 20px 0", flexWrap: "wrap", minHeight: 62, alignContent: "flex-start" }}>
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
        <span>BSTOCKS BASKET</span><span>EQUAL · MARKET-CAP · CUSTOM</span><span>DRIFT BAND 1 – 50%</span><span>MIN TRADE $25</span><span>AUTO-INVEST DEPOSITS</span>
      </div>
    </section>
  );
}

export { SmartExplainer };

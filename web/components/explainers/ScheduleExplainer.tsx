// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose.
// The animation source is mechanically extracted from the supplied Claude Design standalone.
"use client";
import React from "react";
/* TradFi · Schedule buy explainer. Mirrors the worker cycle in TRADFI-SCHEDULE-BUY-SPEC §2:
   one bStock, fixed USDT per buy, one slot per interval, NAV-premium + market-hours gates
   postpone a slot (never made up), buy only, stop on the finish rule. */
const TOKEN = "SPCXB";
const PER_BUY = 25, BUDGET = 150, LIMIT = 1.5;
const SCENES = [
  { t: 0, title: "You pick one bStock, an amount and a frequency", body: "25 USDT of " + TOKEN + ", daily, from a 150 USDT budget. No model picks tokens and there is no take-profit or stop-loss: it only buys." },
  { t: 1300, title: "Each cycle starts with the NAV premium", body: "Before buying, it compares the venue price with the stock's NAV. A buy only goes ahead inside your premium limit, and never above +1.5%." },
  { t: 2500, title: "Inside the limit, it buys your fixed amount", body: "It quotes the route, checks the premium again at the real fill size, and buys inside your slippage cap. One buy per cycle, never more." },
  { t: 3650, title: "Outside it, that cycle is postponed", body: "Premium over your limit, or the US market closed with market hours only on: the buy is skipped for that period and not made up later. The schedule resumes at the next cycle." },
  { t: 5950, title: "Every fill stays in your wallet", body: "Holdings accumulate in your passkey wallet. The agent never sells, and revoking it leaves the tokens where they are." },
  { t: 9350, title: "It stops at your finish rule", body: "Budget spent, end date reached or number of runs done, whichever you chose. Any USDT too small for one more buy stays in your wallet." },
];
const T0 = 1400, STEP = 1150, TOTAL = 12000;
/* premium % per cycle; kind: buy | premium | closed */
const CYCLES = [
  { p: 0.42, kind: "buy", out: 0.2104 },
  { p: 0.61, kind: "buy", out: 0.2098 },
  { p: 1.89, kind: "premium" },
  { p: 0.74, kind: "buy", out: 0.2112 },
  { p: 0.35, kind: "buy", out: 0.2121 },
  { p: 0.52, kind: "closed" },
  { p: 0.88, kind: "buy", out: 0.2107 },
  { p: 0.47, kind: "buy", out: 0.2117 },
].map((c, i) => ({ ...c, i, at: T0 + i * STEP }));
const FINISH_AT = CYCLES[CYCLES.length - 1].at + 700;
const VW = 700, VH = 292, X0 = 28, X1 = 470, RX = 500;
const cx = (i) => X0 + 30 + i * ((X1 - X0 - 60) / (CYCLES.length - 1));
const yP = (p) => 150 - (p + 0.5) * (106 / 3);
const YELLOW = "var(--cat-yield)";
const mono = { font: "var(--type-mono-xs)" };

const KNOTS = [{ x: X0, p: 0.55 }, ...CYCLES.map((c) => ({ x: cx(c.i), p: c.p })), { x: X1, p: 0.5 }];
function premAt(x) {
  let k = 0;
  while (k < KNOTS.length - 2 && x > KNOTS[k + 1].x) k++;
  const a = KNOTS[k], b = KNOTS[k + 1];
  const u = Math.max(0, Math.min(1, (x - a.x) / (b.x - a.x)));
  const s = (1 - Math.cos(u * Math.PI)) / 2;
  return a.p + (b.p - a.p) * s + Math.sin(x * 0.19) * 0.05 * Math.sin(u * Math.PI);
}
function headX(e) {
  if (e < T0) return X0 + (e / T0) * (cx(0) - X0);
  const last = CYCLES.length - 1;
  const f = Math.min(last, (e - T0) / STEP);
  return cx(0) + f * (cx(1) - cx(0));
}

function ScheduleExplainer({ protocol = "PancakeSwap v3" }) {
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

  const hx = headX(e);
  const done = CYCLES.filter((c) => e >= c.at);
  const buys = done.filter((c) => c.kind === "buy");
  const postponed = done.length - buys.length;
  const spent = buys.length * PER_BUY;
  const held = buys.reduce((a, c) => a + c.out, 0);
  const finished = e >= FINISH_AT;
  const current = CYCLES.find((c) => e < c.at);

  const pts = [];
  for (let x = X0; x <= hx; x += 3) pts.push(`${x.toFixed(1)},${yP(premAt(x)).toFixed(1)}`);
  pts.push(`${hx.toFixed(1)},${yP(premAt(hx)).toFixed(1)}`);
  const headY = yP(premAt(hx));

  const FEED = [
    ...CYCLES.map((c) => c.kind === "buy"
      ? { t: c.at, tone: "ok", text: `C${c.i + 1} · bought ${c.out.toFixed(4)} ${TOKEN}`, sub: `${PER_BUY} USDT · premium +${c.p.toFixed(2)}% · ${protocol}` }
      : { t: c.at, tone: "y", text: `C${c.i + 1} · postponed`, sub: c.kind === "premium" ? `premium +${c.p.toFixed(2)}% over your ${LIMIT}% limit` : "US market closed · market hours only" }),
    { t: FINISH_AT, tone: "ok", text: "Schedule finished", sub: `budget spent · ${buys.length} buys · ${held.toFixed(4)} ${TOKEN} held` },
  ];
  const feed = FEED.filter((f) => e >= f.t).slice(-3);
  const pulse = FEED.find((f) => e >= f.t && e < f.t + 600);
  const tone = (t) => (t === "ok" ? "var(--profit)" : YELLOW);
  const tint = (t) => (t === "ok" ? "var(--live-tint)" : "var(--cat-yield-tint)");
  const closedX = cx(5);

  return (
    <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line-1)" }}>
        <span style={{ font: "var(--type-card-title)" }}>How this agent works</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>TradFi · Schedule buy · {protocol}</span>
          <button onClick={() => setPlaying((p) => !p)} style={{ font: "var(--type-mono-xs)", color: "var(--text-muted)", background: "none", border: "1px solid var(--line-2)", borderRadius: 999, padding: "3px 10px", cursor: "pointer" }}>{playing ? "Pause" : "Play"}</button>
        </div>
      </div>

      <div style={{ padding: "8px 12px 0" }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} style={{ display: "block", width: "100%", height: "auto" }}>
          <text x={X0} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>{TOKEN} · PREMIUM TO NAV</text>

          <rect x={closedX - 27} y={40} width={54} height={172} rx="3" fill="var(--surface-sunken)" />
          <text x={closedX} y={52} textAnchor="middle" style={{ ...mono, fill: "var(--text-subtle)" }}>US CLOSED</text>

          <line x1={X0} x2={X1} y1={yP(LIMIT)} y2={yP(LIMIT)} stroke={YELLOW} strokeWidth="1.5" strokeDasharray="4 4" />
          <text x={X1 - 2} y={yP(LIMIT) - 6} textAnchor="end" style={{ ...mono, fill: YELLOW }}>MAX PREMIUM +{LIMIT}%</text>
          <line x1={X0} x2={X1} y1={yP(0)} y2={yP(0)} stroke="var(--line-3)" strokeWidth="1" />
          <text x={X1 - 2} y={yP(0) + 14} textAnchor="end" style={{ ...mono, fill: "var(--text-subtle)" }}>NAV</text>

          <polyline points={pts.join(" ")} fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinejoin="round" />

          {done.map((c) => {
            const y = yP(premAt(cx(c.i)));
            return c.kind === "buy"
              ? <circle key={c.i} cx={cx(c.i)} cy={y} r="4.5" fill="var(--profit)" stroke="var(--surface-card)" strokeWidth="1.5" />
              : <g key={c.i}>
                  <circle cx={cx(c.i)} cy={y} r="4.5" fill="var(--surface-card)" stroke={YELLOW} strokeWidth="1.5" />
                  {c.kind === "premium" && <text x={cx(c.i)} y={y - 10} textAnchor="middle" style={{ ...mono, fill: YELLOW }}>+{c.p.toFixed(2)}%</text>}
                </g>;
          })}

          {!finished && <line x1={hx} x2={hx} y1={40} y2={212} stroke="var(--brand-line)" strokeWidth="1" />}
          {pulse && !finished && <circle cx={hx} cy={headY} r={9 + ((e - pulse.t) / 600) * 24} fill="none" stroke={tone(pulse.tone)} strokeWidth="1.5" opacity={1 - (e - pulse.t) / 600} />}
          {!finished && <circle cx={hx} cy={headY} r="4" fill="var(--brand)" />}

          {CYCLES.map((c) => {
            const judged = e >= c.at;
            const buy = c.kind === "buy";
            const fill = !judged ? "var(--surface-sunken)" : buy ? "var(--live-tint)" : "var(--cat-yield-tint)";
            const stroke = !judged ? (current && current.i === c.i ? "var(--brand-line)" : "var(--line-2)") : buy ? "var(--profit)" : YELLOW;
            return (
              <g key={c.i}>
                <rect x={cx(c.i) - 23} y={176} width={46} height={32} rx="4" fill={fill} stroke={stroke} strokeDasharray={judged && !buy ? "3 3" : undefined} />
                <text x={cx(c.i)} y={189} textAnchor="middle" style={{ ...mono, fill: "var(--text-subtle)" }}>C{c.i + 1}</text>
                <text x={cx(c.i)} y={202} textAnchor="middle" style={{ ...mono, fill: !judged ? "var(--ink-4)" : buy ? "var(--profit)" : YELLOW }}>{!judged ? "—" : buy ? "BUY" : "SKIP"}</text>
              </g>
            );
          })}
          <text x={X0} y={236} style={{ ...mono, fill: "var(--text-subtle)" }}>ONE CYCLE PER DAY · {PER_BUY} USDT PER BUY · A SKIPPED CYCLE IS NOT MADE UP</text>

          <line x1={RX - 12} x2={RX - 12} y1={14} y2={250} stroke="var(--line-1)" />
          <text x={RX} y={24} style={{ ...mono, fill: "var(--text-subtle)" }}>HOLDINGS</text>
          <text x={RX} y={52} style={{ font: "var(--weight-semibold) 20px/1 var(--font-mono)", fill: "var(--ink-1)" }}>{held.toFixed(4)}</text>
          <text x={RX} y={70} style={{ ...mono, fill: "var(--text-muted)" }}>{TOKEN} · IN YOUR WALLET</text>

          <text x={RX} y={104} style={{ ...mono, fill: "var(--text-subtle)" }}>BUDGET</text>
          <rect x={RX} y={114} width={180} height={8} rx="2" fill="var(--raised-3)" />
          <rect x={RX} y={114} width={180 * (spent / BUDGET)} height={8} rx="2" fill="var(--brand)" style={{ transition: "width .4s var(--ease-out)" }} />
          <text x={RX} y={140} style={{ ...mono, fill: "var(--ink-1)" }}>{spent} / {BUDGET} USDT SPENT</text>

          <text x={RX} y={174} style={{ ...mono, fill: "var(--text-subtle)" }}>BUYS</text>
          <text x={RX} y={192} style={{ ...mono, fill: "var(--ink-1)" }}>{buys.length} OF {BUDGET / PER_BUY} DONE · {postponed} POSTPONED</text>

          <text x={RX} y={226} style={{ ...mono, fill: "var(--text-subtle)" }}>{finished ? "STATUS" : "NEXT BUY"}</text>
          <text x={RX} y={244} style={{ ...mono, fill: finished ? "var(--profit)" : "var(--ink-1)" }}>{finished ? "FINISHED · BUDGET SPENT" : current ? `CYCLE ${current.i + 1} · ${current.i === 5 ? "MARKET CLOSED" : "DUE"}` : "CHECKING…"}</text>
          <text x={RX} y={272} style={{ ...mono, fill: "var(--text-subtle)" }}>SELLS · NEVER</text>
        </svg>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "4px 20px 0", flexWrap: "wrap", minHeight: 27 }}>
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
        <span>BSTOCKS ONLY</span><span>EVERY 1H – DAILY</span><span>MAX PREMIUM 0.5 – 1.5%</span><span>BUY ONLY · NO SELLS</span><span>7-DAY SESSION</span>
      </div>
    </section>
  );
}

export { ScheduleExplainer };

// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose (see
// ListAgentScreen.tsx for the rationale).
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/SkillsDemo.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxy and the window global became real imports/exports. */
import React from "react";
import { Icon } from "@/design-system";

const SCENES = [
  { skill: "4lpha-stock-compare", label: "Compare", prompt: "NVDAB or NVDAon for 100 USDT?",
    tool: "stock_compare ticker=NVDA usdt=100",
    out: [["Quotes", "stored 6 min ago · size 100 USDT"], ["bStock", "buy cost 0.18% · RFQ route"], ["Ondo", "buy cost 0.41% · session closed"], ["Verdict", "bStock better by 0.23%", "profit"]] },
  { skill: "4lpha-bstock-analysis", label: "Analysis", prompt: "Analyse NVDAB on the 1h chart",
    tool: "bstock_analysis token=NVDAB interval=1h",
    out: [["Session", "US market open · regime risk_on", "live"], ["Trend", "EMA12 above EMA26"], ["Momentum", "RSI14 58.2 · MACD hist +0.41"], ["Price", "premium vs NAV +0.12% · deep pool"]] },
  { skill: "4lpha-hire", label: "Hire", prompt: "I want to buy SPYB every day without watching it",
    tool: "get_hire_link agent=agentic-schedule",
    out: [["Schedule buy", "a fixed USDT amount, at a fixed interval"], ["Term", "7 or 30 days · min buy 5 USDT"], ["Wallet", "USDT + BNB for gas · Agentic Wallet"], ["Deploy", "4lpha.tech/deploy/trading", "link"]] },
  { skill: "4lpha-agent-status", label: "Status", prompt: "How is the agent on 0xebeb…e148 doing?",
    tool: "agent_status wallet=0xebeb…e148",
    out: [["TradFi Portfolio Agent", "running · 7-day term", "live"], ["Value", "125.32 USDT"], ["PnL", "+0.32 USDT", "profit"], ["Basket", "CRCLB · METAB · HOODB · MSTRB · SOXLB"]] },
  { skill: "4lpha-meme-stocks", label: "Memes", prompt: "Which stock has the most meme activity?",
    tool: "meme_stocks limit=3",
    out: [["NVDAB", "42 memes · 9 live · 1h vol $38.2k"], ["QQQB", "27 memes · 5 live · 1h vol $12.9k"], ["BNCB", "19 memes · 3 live · 1h vol $6.1k"], ["Flags", "clone · sniper_heavy shown per meme", "warn"]] },
];

const TONE = { live: "var(--live)", profit: "var(--profit)", warn: "var(--warn)", link: "var(--brand)" };

function SkillsDemo({ onScene }) {
  const reduce = React.useMemo(() => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [i, setI] = React.useState(0);
  const [t, setT] = React.useState(0);
  const [hover, setHover] = React.useState(false);
  const sc = SCENES[i];
  const typeEnd = sc.prompt.length;
  const toolAt = typeEnd + 14;
  const lineAt = (n) => toolAt + 16 + n * 10;
  const end = lineAt(sc.out.length - 1) + 110;

  React.useEffect(() => { onScene && onScene(sc.skill); }, [i]);
  React.useEffect(() => {
    if (hover) return;
    const id = setInterval(() => setT((v) => v + 1), reduce ? 60 : 32);
    return () => clearInterval(id);
  }, [hover, i, reduce]);
  React.useEffect(() => {
    if (t >= end) { setI((v) => (v + 1) % SCENES.length); setT(reduce ? end - 100 : 0); }
  }, [t, end]);
  React.useEffect(() => { if (reduce) setT(lineAt(sc.out.length)); }, [i]);

  const jump = (n) => { setI(n); setT(reduce ? 999 : 0); };
  const typed = sc.prompt.slice(0, Math.min(t, typeEnd));
  const typing = t < typeEnd;
  const showTool = t >= toolAt;
  const running = showTool && t < lineAt(0);

  return (
    <div className="fl-sk-term" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 40, padding: "0 14px", borderBottom: "1px solid var(--line-1)" }}>
        <span style={{ display: "flex", gap: 6 }}>
          {[0, 1, 2].map((d) => <span key={d} style={{ width: 9, height: 9, borderRadius: 9, background: "var(--raised-3)" }}></span>)}
        </span>
        <span style={{ flex: 1, textAlign: "center", font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>assistant · 4lpha skills</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--type-mono-xs)", color: hover ? "var(--text-subtle)" : "var(--live)" }}>
          <span className={hover ? "" : "fl-sk-pulse"} style={{ width: 6, height: 6, borderRadius: 6, background: "currentColor" }}></span>{hover ? "paused" : "live"}
        </span>
      </div>
      <div style={{ padding: "20px 20px 8px", minHeight: 268, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, font: "var(--weight-medium) var(--text-md)/1.5 var(--font-mono)", color: "var(--ink-1)" }}>
          <span style={{ color: "var(--brand)" }}>›</span>
          <span>{typed}{typing && <span className="fl-sk-caret"></span>}</span>
        </div>
        {showTool && (
          <div className="fl-sk-in" style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", padding: "6px 10px", border: "1px solid var(--brand-line)", borderRadius: "var(--radius-sm)", background: "var(--brand-tint)", font: "var(--type-mono-xs)", color: "var(--brand)" }}>
            <span className={running ? "fl-sk-spin" : ""} style={{ display: "flex" }}><Icon name={running ? "refresh" : "success"} size={12} /></span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>4lpha · {sc.tool}</span>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sc.out.map((row, n) => t >= lineAt(n) && (
            <div key={i + "-" + n} className="fl-sk-in" style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0, 1fr)", gap: 14, padding: "7px 0", borderBottom: n < sc.out.length - 1 ? "1px dashed var(--line-1)" : "none" }}>
              <span style={{ font: "var(--type-label)", color: n === 0 && row[2] ? "var(--ink-1)" : "var(--text-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row[0]}</span>
              <span style={{ font: "var(--type-metric-sm)", color: TONE[row[2]] || "var(--ink-2)" }}>{row[1]}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "12px 14px", borderTop: "1px solid var(--line-1)" }}>
        {SCENES.map((s, n) => (
          <button key={s.skill} type="button" onClick={() => jump(n)} className={"fl-sk-dot" + (n === i ? " fl-sk-dot--on" : "")}>
            {s.label}
            {n === i && <span className="fl-sk-bar" style={{ transform: "scaleX(" + Math.min(1, t / end) + ")" }}></span>}
          </button>
        ))}
        <span style={{ marginLeft: "auto", font: "var(--type-mono-xs)", color: "var(--text-disabled)" }}>sample output</span>
      </div>
    </div>
  );
}

export { SkillsDemo };

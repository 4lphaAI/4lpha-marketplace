// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose (see
// ListAgentScreen.tsx for the rationale).
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/SkillsScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { Button, Icon } from "@/design-system";
import { RESOURCES } from "@/lib/design-resources";
import { SkillsDemo } from "@/components/screens/SkillsDemo";

const MCP_URL = "https://4lpha.tech/mcp";
const INSTALL = {
  skills: { cmd: "npx skills add 4lphaAI/4lpha-marketplace", note: "Installs all five skills. Node.js 22+, no API key." },
  mcp: { cmd: "Add MCP server 4lpha: " + MCP_URL, note: "Same tools as a remote MCP server, for any MCP client.", noPrompt: true },
};
const CLIENTS = [["Claude Code", RESOURCES.aiClaude], ["Codex", RESOURCES.aiCodex], ["Cursor", RESOURCES.aiCursor], ["OpenClaw", RESOURCES.aiOpenClaw]];

const SKILLS = [
  { id: "4lpha-hire", icon: "plus", title: "Hire an agent", tools: ["list_agents", "get_hire_link", "explain_strategy"],
    does: "Picks the right Agentic agent (AI Trade, Schedule buy, Auto DCA, Smart Portfolio, Earn opt-in), checks what the wallet needs and hands over the Deploy link.",
    prompts: ["DCA into NVDAB automatically", "Rebalance a basket of stocks for me", "What do I need in my Agentic Wallet to start?"] },
  { id: "4lpha-agent-status", icon: "activity", title: "Agent status", tools: ["agent_status"],
    does: "Status, positions and results of the 4lpha agent on a wallet address: running or ended and why, term dates, PnL, the Earn position and its ERC-8004 identity.",
    prompts: ["How is my 4lpha agent doing on 0x…?", "Why did my agent stop?", "What did my agent buy?"] },
  { id: "4lpha-bstock-analysis", icon: "yield", title: "bStock analysis", tools: ["bstock_analysis"],
    does: "The indicators AI Trade reads (RSI, MACD, EMA, Bollinger, ATR, VWAP) on 15m and 1h, the US market regime, premium vs NAV, session and pool depth for one bStock.",
    prompts: ["Analyse NVDAB", "Is TSLAB overbought?", "How does the market look for tokenized stocks today?"] },
  { id: "4lpha-stock-compare", icon: "sort", title: "Stock compare", tools: ["stock_compare"],
    does: "Compares the bStock and the Ondo token of one US stock for the same USDT: shares received, cost against the share price, exit cost, session and a verdict per size.",
    prompts: ["Where do I get the most NVDA for 500 USDT?", "NVDAB or NVDAon?", "Which tokenized SPY is cheaper to buy?"] },
  { id: "4lpha-meme-stocks", icon: "spark", title: "Meme stocks", tools: ["meme_stocks"],
    does: "Meme tokens quoted in a bStock, grouped by stock: how many are alive, last hour's trades and volume, lifecycle labels, taxes and risk flags.",
    prompts: ["Which stocks have the most meme activity?", "Is there a meme on QQQB that is alive?"] },
];

const GUARDS = [
  { icon: "eye", title: "Read-only", body: "Skills never sign, place an order, hold a key or log in to your wallet." },
  { icon: "wallet", title: "One session per wallet", body: "Signing in elsewhere ends a running agent, so skills check agent status before any baw command." },
  { icon: "payment", title: "Paid calls need a yes", body: "x402 spend (CMC data, Stock Analyze Agent) runs only after you agree to the stated price." },
  { icon: "clock", title: "10 calls / min per IP", body: "The public endpoint also has a shared ceiling across all users." },
];

const FAQ = [
  ["Do the skills trade for me?", "No. They explain the agents, check the numbers with you, hand over the Deploy link and read status. Trading is done by 4lpha's hosted agents after you hire one on 4lpha.tech and approve it in the Binance App."],
  ["Skills or MCP server?", "Both reach the same public endpoint. The skills add workflows and safety rules on top of the tools; the MCP server alone gives the raw tools to any MCP client."],
  ["Do I need an API key or an account?", "No. Node.js 22 or newer is enough for the skills. Agent status only needs the wallet address."],
  ["How do I stop an agent?", "Sign out of the session in the Binance App. That ends the agent for good; holdings stay in your wallet."],
  ["Can I run a skill by hand?", "Yes: node skills/4lpha-bstock-analysis/scripts/cli.mjs bstock-analysis token=NVDAB. Arguments are key=value pairs, which work unchanged in bash, zsh and PowerShell."],
];

const CSS = `
.fl-sk-hero{position:relative;overflow:hidden;border-bottom:1px solid var(--line-1)}
.fl-sk-hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(var(--line-1) 1px,transparent 1px),linear-gradient(90deg,var(--line-1) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(ellipse 70% 80% at 70% 30%,#000 10%,transparent 75%);mask-image:radial-gradient(ellipse 70% 80% at 70% 30%,#000 10%,transparent 75%);pointer-events:none}
.fl-sk-hero:after{content:"";position:absolute;width:640px;height:640px;right:-120px;top:-260px;border-radius:50%;background:radial-gradient(circle,rgb(134 220 87 / .13),transparent 65%);pointer-events:none}
.fl-sk-heroin{position:relative;z-index:1;max-width:var(--page-max);margin:0 auto;padding:72px var(--page-gutter) 80px;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,1fr);gap:48px;align-items:center}
.fl-sk-wrap{max-width:var(--page-max);margin:0 auto;padding:0 var(--page-gutter)}
.fl-sk-term{border:1px solid var(--line-2);border-radius:var(--radius-md);background:linear-gradient(180deg,var(--raised),var(--base));box-shadow:0 30px 80px -30px rgb(0 0 0 / .7),0 0 0 1px rgb(134 220 87 / .05)}
.fl-sk-caret{display:inline-block;width:8px;height:1.05em;margin-left:2px;vertical-align:-2px;background:var(--brand);animation:flSkBlink 1s steps(1) infinite}
.fl-sk-in{animation:flSkIn .28s var(--ease-out, ease-out) both}
.fl-sk-spin{animation:flSkSpin .9s linear infinite}
.fl-sk-pulse{animation:flSkPulse 1.6s ease-in-out infinite}
.fl-sk-dot{position:relative;overflow:hidden;height:28px;padding:0 12px;border:1px solid var(--line-1);border-radius:var(--radius-pill);background:transparent;color:var(--text-subtle);font:var(--type-label);cursor:pointer;transition:var(--transition-control)}
.fl-sk-dot:hover{color:var(--ink-1);border-color:var(--line-3)}
.fl-sk-dot--on{color:var(--brand);border-color:var(--brand-line);background:var(--brand-tint)}
.fl-sk-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--brand);transform-origin:left;transition:transform .1s linear}
.fl-sk-copy{transition:var(--transition-control)}.fl-sk-copy:hover{border-color:var(--line-3)!important;color:var(--ink-1)!important}
.fl-sk-tab{transition:var(--transition-control)}.fl-sk-tab:hover{background:var(--raised-2)!important}
.fl-sk-prompt{transition:var(--transition-control)}.fl-sk-prompt:hover{border-color:var(--brand-line)!important;background:var(--brand-tint)!important}
.fl-sk-guard{transition:var(--transition-control)}.fl-sk-guard:hover{border-color:var(--line-2)!important;transform:translateY(-2px)}
.fl-sk-faq summary{list-style:none;cursor:pointer}.fl-sk-faq summary::-webkit-details-marker{display:none}
.fl-sk-faq[open] .fl-sk-chev{transform:rotate(180deg)}
.fl-sk-explorer{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:0}
.fl-sk-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
@keyframes flSkBlink{50%{opacity:0}}
@keyframes flSkIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes flSkSpin{to{transform:rotate(360deg)}}
@keyframes flSkPulse{50%{opacity:.35}}
@media (max-width:960px){.fl-sk-heroin{grid-template-columns:minmax(0,1fr);padding:48px var(--page-gutter-mobile, 16px) 56px;gap:36px}.fl-sk-explorer{grid-template-columns:minmax(0,1fr)}.fl-sk-steps{grid-template-columns:minmax(0,1fr)}.fl-sk-wrap{padding:0 var(--page-gutter-mobile, 16px)}}
@media (prefers-reduced-motion:reduce){.fl-sk-caret,.fl-sk-spin,.fl-sk-pulse,.fl-sk-in{animation:none}}
`;

function copyText(t) {
  try { if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t); } catch (e) {}
  const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove();
}
function useCopied() {
  const [k, setK] = React.useState(null);
  const ref = React.useRef();
  const copy = (key, text) => { copyText(text); setK(key); clearTimeout(ref.current); ref.current = setTimeout(() => setK(null), 1400); };
  return [k, copy];
}

function Cmd({ text, copied, onCopy, prompt = "$", big, fit }) {
  return (
    <div style={{ display: "flex", width: fit ? "fit-content" : undefined, maxWidth: "100%", alignItems: "center", gap: 12, minWidth: 0, padding: "0 6px 0 16px", height: big ? 54 : 46, border: "1px solid var(--line-2)", borderRadius: "var(--radius-sm)", background: "rgb(10 12 14 / .6)" }}>
      {prompt && <span style={{ font: "var(--type-metric-sm)", color: "var(--brand)", flex: "0 0 auto" }}>{prompt}</span>}
      <code style={{ flex: fit ? "0 1 auto" : 1, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap", font: "var(--weight-medium) " + (big ? "var(--text-md)" : "var(--text-base)") + "/1.2 var(--font-mono)", color: "var(--ink-1)", padding: "14px 0", scrollbarWidth: "none" }}>{text}</code>
      <button type="button" onClick={onCopy} aria-label="Copy command" className="fl-sk-copy"
        style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, height: big ? 40 : 34, padding: "0 12px", border: "1px solid var(--line-2)", borderRadius: "var(--radius-sm)", background: copied ? "var(--brand-tint)" : "var(--raised-2)", color: copied ? "var(--brand)" : "var(--ink-2)", font: "var(--type-label)", cursor: "pointer" }}>
        <Icon name={copied ? "success" : "copy"} size={14} />{copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function SectionHead({ eyebrow, title, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 28, maxWidth: 640 }}>
      <span className="fl-eyebrow" style={{ color: "var(--brand)" }}>{eyebrow}</span>
      <h2 style={{ font: "var(--weight-semibold) var(--text-3xl)/1.15 var(--font-sans)", letterSpacing: "var(--tracking-tight)", margin: 0, textWrap: "balance" }}>{title}</h2>
      {sub && <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", margin: 0, textWrap: "pretty" }}>{sub}</p>}
    </div>
  );
}

function SkillsScreen({ go }) {
  const [mode, setMode] = React.useState("skills");
  const [sel, setSel] = React.useState(SKILLS[0].id);
  const [copiedKey, copy] = useCopied();
  const inst = INSTALL[mode];
  const s = SKILLS.find((x) => x.id === sel);
  const Demo = SkillsDemo;

  return (
    <div>
      <style>{CSS}</style>

      <section className="fl-sk-hero">
        <div className="fl-sk-heroin">
          <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, alignSelf: "flex-start", height: 26, padding: "0 11px", borderRadius: "var(--radius-pill)", background: "var(--integration-bg)", border: "1px solid var(--integration-gold-tint)", color: "var(--integration-gold)", font: "var(--type-label)" }}>
              <Icon name="wallet" size={13} />Skills & MCP for Binance Agentic Wallet
            </span>
            <h1 style={{ font: "var(--weight-semibold) clamp(36px, 4.6vw, 54px)/1.04 var(--font-sans)", letterSpacing: "-0.03em", margin: 0, textWrap: "balance" }}>
              Your Agentic Wallet agents,<br></br><span style={{ color: "var(--brand)" }}>one prompt away.</span>
            </h1>
            <p style={{ font: "var(--weight-regular) var(--text-lg)/1.55 var(--font-sans)", color: "var(--text-muted)", margin: 0, maxWidth: "52ch", textWrap: "pretty" }}>
              Hire, track and analysis tokenized stocks from your AI assistant.<br></br><span style={{ color: "var(--ink-1)", fontWeight: "var(--weight-medium)" }}>No Login. No Key. Just Skill.</span>
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 4 }}>
                {[["skills", "Agent Skills"], ["mcp", "MCP server"]].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setMode(v)} className="fl-sk-dot" style={mode === v ? { color: "var(--ink-1)", borderColor: "var(--line-3)", background: "var(--raised-2)" } : { borderColor: "transparent" }}>{l}</button>
                ))}
              </div>
              <Cmd big fit prompt={inst.noPrompt ? "" : "$"} text={inst.cmd} copied={copiedKey === "hero-" + mode} onCopy={() => copy("hero-" + mode, inst.cmd)} />
              <span style={{ font: "var(--type-body)", color: "var(--text-subtle)" }}>{inst.note}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, paddingTop: 4 }}>
              <span style={{ font: "var(--type-label)", color: "var(--text-subtle)", marginRight: 2 }}>Works with</span>
              {CLIENTS.map(([name, file]) => (
                <span key={name} title={name} style={{ height: 30, display: "inline-flex", alignItems: "center", gap: 6, padding: "0 10px 0 8px", borderRadius: "var(--radius-pill)", border: "1px solid var(--line-2)", background: "var(--raised)", font: "var(--type-label)", color: "var(--ink-1)" }}>
                  <img src={file} alt="" style={{ width: 16, height: 16, objectFit: "contain", flex: "0 0 auto" }} />{name}
                </span>
              ))}
              <span style={{ font: "var(--type-label)", color: "var(--text-subtle)", whiteSpace: "nowrap" }}>+ any MCP client</span>
            </div>
          </div>
          <div style={{ minWidth: 0 }}>{Demo && <Demo />}</div>
        </div>
      </section>

      <div className="fl-sk-wrap" style={{ paddingTop: 88, paddingBottom: 96, display: "flex", flexDirection: "column", gap: 96 }}>

        <section>
          <SectionHead eyebrow="How it works" title="From install to a running agent in three steps." />
          <div className="fl-sk-steps">
            {[
              { n: "01", t: "Install", d: "One command adds the five skills to your assistant.", cmd: INSTALL.skills.cmd },
              { n: "02", t: "Ask", d: "Describe what you want. The skill calls 4lpha and explains the result.", ask: "DCA into NVDAB automatically" },
              { n: "03", t: "Hire & approve", d: "Open the Deploy link, choose Agentic Wallet and scan the QR in the Binance App.", cta: true },
            ].map((st) => (
              <div key={st.n} style={{ position: "relative", display: "flex", flexDirection: "column", gap: 14, padding: 24, border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ font: "var(--weight-semibold) var(--text-4xl)/1 var(--font-mono)", color: "var(--brand)", letterSpacing: "-0.04em" }}>{st.n}</span>
                  <span style={{ flex: 1, height: 1, margin: "0 0 0 16px", background: "linear-gradient(90deg, var(--brand-line), transparent)" }}></span>
                </div>
                <h3 style={{ font: "var(--type-section-title)", margin: 0 }}>{st.t}</h3>
                <p style={{ font: "var(--type-body)", color: "var(--text-muted)", margin: 0, textWrap: "pretty" }}>{st.d}</p>
                <div style={{ marginTop: "auto" }}>
                  {st.cmd && <Cmd text={st.cmd} copied={copiedKey === "step1"} onCopy={() => copy("step1", st.cmd)} />}
                  {st.ask && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, height: 46, padding: "0 16px", border: "1px solid var(--line-2)", borderRadius: "var(--radius-sm)", background: "rgb(10 12 14 / .6)", font: "var(--weight-medium) var(--text-base)/1 var(--font-mono)", color: "var(--ink-1)" }}>
                      <span style={{ color: "var(--brand)" }}>›</span>{st.ask}<span className="fl-sk-caret"></span>
                    </div>
                  )}
                  {st.cta && <Button variant="primary" iconRight={<Icon name="arrow-right" size={14} />} onClick={() => go("/deploy/trading")}>Open Deploy</Button>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHead eyebrow="Five skills" title="What your assistant can do with 4lpha." sub="Pick a skill to see what it covers and a few prompts to start with. Click a prompt to copy it." />
          <div className="fl-sk-explorer" style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden" }}>
            <div role="tablist" style={{ display: "flex", flexDirection: "column", padding: 8, gap: 2, borderRight: "1px solid var(--line-1)", background: "var(--surface-sunken)" }}>
              {SKILLS.map((k) => {
                const on = k.id === sel;
                return (
                  <button key={k.id} type="button" role="tab" aria-selected={on} onClick={() => setSel(k.id)} className="fl-sk-tab"
                    style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", padding: "12px", border: "1px solid " + (on ? "var(--line-2)" : "transparent"), borderRadius: "var(--radius-sm)", background: on ? "var(--raised-2)" : "transparent", cursor: "pointer", color: "inherit" }}>
                    <span style={{ width: 34, height: 34, flex: "0 0 auto", display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", background: on ? "var(--brand-tint)" : "var(--raised)", border: "1px solid " + (on ? "var(--brand-line)" : "var(--line-1)"), color: on ? "var(--brand)" : "var(--ink-2)" }}>
                      <Icon name={k.icon} size={17} />
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                      <span style={{ font: "var(--type-card-title)", color: on ? "var(--ink-1)" : "var(--ink-2)" }}>{k.title}</span>
                      <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{k.id}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div key={s.id} className="fl-sk-in" style={{ display: "flex", flexDirection: "column", gap: 24, padding: 32, minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <h3 style={{ font: "var(--weight-semibold) var(--text-2xl)/1.2 var(--font-sans)", margin: 0 }}>{s.title}</h3>
                <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", margin: 0, maxWidth: "64ch", textWrap: "pretty" }}>{s.does}</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <span className="fl-eyebrow">Try asking</span>
                <div style={{ display: "grid", gap: 8 }}>
                  {s.prompts.map((p, n) => {
                    const key = s.id + n, on = copiedKey === key;
                    return (
                      <button key={key} type="button" onClick={() => copy(key, p)} className="fl-sk-prompt"
                        style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", padding: "13px 16px", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", color: "var(--ink-1)", font: "var(--type-body-md)", cursor: "pointer" }}>
                        <span style={{ color: "var(--brand)", font: "var(--type-metric-sm)" }}>›</span>
                        <span style={{ flex: 1, minWidth: 0 }}>{p}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 5, font: "var(--type-label)", color: on ? "var(--brand)" : "var(--text-subtle)" }}><Icon name={on ? "success" : "copy"} size={13} />{on ? "Copied" : ""}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: "auto", paddingTop: 18, borderTop: "1px solid var(--line-1)" }}>
                <span style={{ font: "var(--type-label)", color: "var(--text-subtle)", marginRight: 4 }}>Calls MCP tool</span>
                {s.tools.map((t) => <span key={t} style={{ font: "var(--type-mono-xs)", color: "var(--brand)", padding: "4px 9px", border: "1px solid var(--brand-line)", borderRadius: "var(--radius-pill)", background: "var(--brand-tint)" }}>{t}</span>)}
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHead eyebrow="Guardrails" title="Built to stay out of your wallet." sub="Trading is done by 4lpha's hosted agents after you hire one and approve it in the Binance App. The skills only read." />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 16 }}>
            {GUARDS.map((g) => (
              <div key={g.title} className="fl-sk-guard" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 22, border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)" }}>
                <span style={{ width: 36, height: 36, display: "grid", placeItems: "center", borderRadius: "var(--radius-sm)", background: "var(--raised-2)", color: "var(--brand)" }}><Icon name={g.icon} size={18} /></span>
                <h3 style={{ font: "var(--type-card-title)", margin: 0 }}>{g.title}</h3>
                <p style={{ font: "var(--type-body)", color: "var(--text-muted)", margin: 0, textWrap: "pretty" }}>{g.body}</p>
              </div>
            ))}
          </div>
          <p style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)", margin: "16px 0 0" }}>Nothing here is investment advice.</p>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 40, alignItems: "start" }}>
          <SectionHead eyebrow="FAQ" title="Questions before you install." />
          <div style={{ borderTop: "1px solid var(--line-1)" }}>
            {FAQ.map(([q, a], n) => (
              <details key={q} className="fl-sk-faq" open={n === 0} style={{ borderBottom: "1px solid var(--line-1)" }}>
                <summary style={{ display: "flex", alignItems: "center", gap: 16, padding: "18px 0" }}>
                  <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{String(n + 1).padStart(2, "0")}</span>
                  <span style={{ flex: 1, font: "var(--type-card-title)", color: "var(--ink-1)" }}>{q}</span>
                  <span className="fl-sk-chev" style={{ display: "flex", color: "var(--text-subtle)", transition: "transform .2s" }}><Icon name="chevron-down" size={16} /></span>
                </summary>
                <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", margin: "0 0 20px 34px", maxWidth: "62ch", textWrap: "pretty" }}>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section style={{ position: "relative", overflow: "hidden", display: "grid", gap: 20, justifyItems: "center", textAlign: "center", padding: "56px 24px", border: "1px solid var(--brand-line)", borderRadius: "var(--radius-md)", background: "radial-gradient(ellipse 60% 120% at 50% 0%, rgb(134 220 87 / .12), transparent 70%), var(--surface-card)" }}>
          <h2 style={{ font: "var(--weight-semibold) var(--text-3xl)/1.15 var(--font-sans)", letterSpacing: "var(--tracking-tight)", margin: 0, textWrap: "balance" }}>Add 4lpha to your assistant.</h2>
          <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", margin: 0, maxWidth: "52ch" }}>One command, then ask about your agent or any bStock in plain language.</p>
          <div style={{ width: "100%", maxWidth: 560, textAlign: "left" }}>
            <Cmd big text={INSTALL.skills.cmd} copied={copiedKey === "cta"} onCopy={() => copy("cta", INSTALL.skills.cmd)} />
          </div>
          <span style={{ font: "var(--type-body)", color: "var(--text-subtle)" }}>
            MCP only: <code style={{ font: "var(--type-mono-xs)", color: "var(--ink-2)" }}>{MCP_URL}</code>
          </span>
        </section>
      </div>
    </div>
  );
}

export { SkillsScreen };

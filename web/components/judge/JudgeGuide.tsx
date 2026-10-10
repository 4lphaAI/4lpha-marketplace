"use client";
/* Unlisted judge guide (`/judge`). Content lives in `lib/judge-data.ts`; this file
   is layout only. It does not mount KitApp, so the desktop-only gate does not
   apply: a judge can read the instructions and copy the commands on a phone. */
import React from "react";

import { Icon } from "@/design-system";
import { RESOURCES } from "@/lib/design-resources";
import {
  AGENTIC_GUIDE, ASSISTANT_COMMANDS, CODE_COMMANDS, COMMANDS, DATA_REPO, DESK_COMMANDS, GROUPS, LIMITS, LIVE_AGENTS,
  PRIZES, REPO, SITE, STATUS_LABEL, VIDEOS, FEATURED_VIDEOS, type Video, addr, agentPage, erc8004, ipfs, type Command, type Evidence, type GuideStep, type Status,
} from "@/lib/judge-data";
import { SigmaHero } from "@/components/judge/SigmaHero";
import { PlayIcon, runSpec, useOnLiveHost, type RunResult } from "@/components/judge/run";

const CSS = `
.fl-jg{max-width:1160px;margin:0 auto;padding:0 24px 96px;color:var(--ink-1)}
.fl-jg a{color:var(--brand);text-decoration:none}.fl-jg a:hover{text-decoration:underline}
.fl-jg-nav{position:sticky;top:0;z-index:30;background:rgb(13 15 18 / .78);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line-1)}
.fl-jg-navin{max-width:1160px;margin:0 auto;padding:0 24px;height:64px;display:flex;align-items:center;gap:14px}
.fl-jg-logo{display:flex;align-items:center;flex:0 0 auto}
.fl-jg-logo .fl-brand__logo{width:128px!important;height:40px!important}
.fl-jg-navtag{flex:0 0 auto;height:24px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid var(--integration-gold-tint);border-radius:var(--radius-pill);background:var(--integration-bg);color:var(--integration-gold);font:var(--type-label);white-space:nowrap}
.fl-jg-navlinks{display:flex;align-items:center;gap:2px;margin-left:auto}
.fl-jg-navlinks a{height:32px;display:inline-flex;align-items:center;padding:0 11px;border-radius:var(--radius-sm);font:var(--weight-medium) var(--text-sm)/1 var(--font-sans);color:var(--text-muted)!important;white-space:nowrap}
.fl-jg-navlinks a:hover{background:var(--raised-2);color:var(--ink-1)!important;text-decoration:none!important}
.fl-jg-navcta{flex:0 0 auto}
@media (max-width:900px){.fl-jg-navlinks{display:none}.fl-jg-navcta{margin-left:auto}}
@media (max-width:420px){.fl-jg-navtag{display:none}}
.fl-jg-hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:48px;align-items:center;padding:64px 0 24px}
.fl-jg-h1{font:var(--weight-semibold) clamp(32px,4.2vw,50px)/1.05 var(--font-sans);letter-spacing:-0.03em;margin:0;text-wrap:balance}
.fl-jg-lead{font:var(--weight-regular) var(--text-lg)/1.55 var(--font-sans);color:var(--text-muted);margin:0;max-width:60ch}
.fl-jg-links{display:flex;flex-wrap:wrap;gap:8px}
.fl-jg-pill{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--line-2);border-radius:var(--radius-pill);background:var(--raised);font:var(--type-label);color:var(--ink-1)!important;cursor:pointer}
.fl-jg-pill:hover{border-color:var(--line-3);text-decoration:none!important}
.fl-jg-pill--brand{border-color:var(--brand-line);background:var(--brand-tint);color:var(--brand)!important}
.fl-jg-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line-1);border-radius:var(--radius-md);overflow:hidden}
.fl-jg-stat{padding:14px 16px;display:grid;gap:4px;border-right:1px solid var(--line-1)}
.fl-jg-stat:last-child{border-right:0}
.fl-jg-stat b{font:var(--weight-semibold) var(--text-2xl)/1 var(--font-mono);color:var(--ink-1)}
.fl-jg-stat span{font:var(--type-label);color:var(--text-subtle)}
.fl-jg-sec{padding-top:72px;display:grid;gap:22px;scroll-margin-top:80px}
.fl-jg-eyebrow{font:var(--type-label);color:var(--brand);text-transform:uppercase;letter-spacing:.08em}
.fl-jg-h2{font:var(--weight-semibold) var(--text-3xl)/1.15 var(--font-sans);letter-spacing:var(--tracking-tight);margin:0}
.fl-jg-sub{font:var(--type-body-md);color:var(--text-muted);margin:0;max-width:72ch}
.fl-jg-card{border:1px solid var(--border-card);border-radius:var(--radius-md);background:var(--surface-card);padding:20px;display:grid;gap:10px;min-width:0;align-content:start}
.fl-jg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:16px}
.fl-jg-h3{font:var(--type-card-title);margin:0}
.fl-jg-p{font:var(--type-body);color:var(--text-muted);margin:0}
.fl-jg-mono{font:var(--type-mono-xs);color:var(--ink-2);word-break:break-all}
.fl-jg-badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:var(--radius-pill);font:var(--type-label);white-space:nowrap;border:1px solid}
.fl-jg-badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.fl-jg-badge--live{color:var(--brand);border-color:var(--brand-line);background:var(--brand-tint)}
.fl-jg-badge--beta{color:var(--warn);border-color:var(--line-2);background:transparent}
.fl-jg-ev{display:flex;flex-wrap:wrap;gap:6px}
.fl-jg-ev a{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid var(--line-2);border-radius:var(--radius-pill);background:var(--raised);font:var(--type-label);color:var(--ink-2)!important}
.fl-jg-ev a:hover{border-color:var(--brand-line);color:var(--brand)!important;text-decoration:none!important}
.fl-jg-thumb{display:block;border:1px solid var(--line-2);border-radius:var(--radius-sm);overflow:hidden;aspect-ratio:16/9;background:var(--surface-sunken)}
.fl-jg-thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:50% 14%;transition:transform .3s}
.fl-jg-thumb:hover img{transform:scale(1.03)}
.fl-jg-cmd{display:grid;gap:8px;min-width:0}
.fl-jg-cmdtitle{font:var(--type-body-md);color:var(--ink-1)}
.fl-jg-cmdbox{display:flex;align-items:flex-start;gap:8px;padding:12px 12px 12px 14px;border:1px solid var(--line-2);border-radius:var(--radius-sm);background:rgb(10 12 14 / .6)}
.fl-jg-cmdbox pre{flex:1;min-width:0;margin:0;overflow-x:auto;font:var(--weight-medium) 13px/1.5 var(--font-mono);color:var(--ink-1);white-space:pre-wrap;word-break:break-all}
.fl-jg-btn{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border:1px solid var(--line-2);border-radius:var(--radius-sm);background:var(--raised-2);color:var(--ink-2)!important;font:var(--type-label);cursor:pointer;text-decoration:none!important}
.fl-jg-btn:hover{border-color:var(--line-3);color:var(--ink-1)!important}
.fl-jg-btn:disabled{opacity:.65;cursor:progress}
.fl-jg-btn--on{color:var(--brand)!important;background:var(--brand-tint)}
.fl-jg-btn--run{color:#0b0d0f!important;background:var(--brand);border-color:var(--brand);font-weight:600}
.fl-jg-btn--run:hover{color:#0b0d0f!important;filter:brightness(1.08)}
.fl-jg-out{border:1px solid var(--line-2);border-radius:var(--radius-sm);background:var(--surface-sunken);overflow:hidden;animation:flJgIn .25s ease-out both}
.fl-jg-outhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line-1);font:var(--type-mono-xs);color:var(--text-subtle)}
.fl-jg-outhead b{font-weight:600}
.fl-jg-out pre{margin:0;padding:12px 14px;max-height:380px;overflow:auto;font:12.5px/1.5 var(--font-mono);color:var(--ink-2);white-space:pre-wrap;word-break:break-word}
.fl-jg-out--mini{margin-top:8px}
.fl-jg-out--mini pre{max-height:180px;font-size:11.5px;padding:10px 12px}
.fl-jg-hint{margin:0;padding:10px 12px;font:var(--type-body);color:var(--text-muted)}
.fl-jg-note{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:1px solid var(--line-2);border-radius:var(--radius-sm);background:var(--raised);font:var(--type-body);color:var(--text-muted)}
.fl-jg-note--warn{border-color:rgb(240 185 11 / .35);background:rgb(240 185 11 / .07);color:var(--ink-2)}
.fl-jg-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);animation:flJgPulse 1s ease-in-out infinite}
.fl-jg-steps{display:grid;gap:18px}
.fl-jg-step{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.5fr);gap:32px;align-items:start;padding:24px;border:1px solid var(--border-card);border-radius:var(--radius-md);background:var(--surface-card)}
.fl-jg-step--text{grid-template-columns:minmax(0,1fr);height:100%;align-content:start}
.fl-jg-steprow{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px}
.fl-jg-stepn{font:var(--weight-semibold) var(--text-3xl)/1 var(--font-mono);color:var(--brand);letter-spacing:-0.04em}
.fl-jg-shot{display:block;border:1px solid var(--line-2);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface-sunken)}
.fl-jg-shot img{display:block;width:100%;height:auto}
.fl-jg-shot--narrow{max-width:520px;justify-self:center;width:100%}
.fl-jg-list{margin:0;padding-left:20px;display:grid;gap:8px;font:var(--type-body-md);color:var(--text-muted)}
.fl-jg-sigma{display:grid;justify-items:center;gap:6px;align-self:center}
.fl-jg-bubble{position:relative;width:min(100%,420px);padding:16px 18px 12px;border:1px solid var(--line-2);border-radius:18px;background:linear-gradient(180deg,var(--raised-2),var(--raised));box-shadow:0 24px 60px -30px rgb(0 0 0 / .8)}
.fl-jg-bubble:after{content:"";position:absolute;left:50%;bottom:-9px;width:16px;height:16px;transform:translateX(-50%) rotate(45deg);background:var(--raised);border-right:1px solid var(--line-2);border-bottom:1px solid var(--line-2)}
.fl-jg-bubble p{margin:0;font:var(--weight-medium) var(--text-md)/1.5 var(--font-sans);color:var(--ink-1)}
.fl-jg-caret{display:inline-block;width:2px;height:1em;margin-left:2px;vertical-align:-2px;background:var(--brand);animation:flJgPulse .8s steps(1) infinite}
.fl-jg-bubbledots{display:flex;gap:5px;justify-content:center;margin-top:10px}
.fl-jg-bubbledots span{width:5px;height:5px;border-radius:50%;background:var(--line-3)}
.fl-jg-bubbledots span.on{width:14px;border-radius:3px;background:var(--brand)}
.fl-jg-sigmabtn{padding:0;border:0;background:none;cursor:pointer;filter:drop-shadow(0 18px 30px rgb(134 220 87 / .18));transition:transform .2s}
.fl-jg-sigmabtn:hover{transform:translateY(-3px)}
.fl-jg-videos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}
.fl-jg-video{display:grid;gap:10px;min-width:0}
.fl-jg-vframe{position:relative;display:block;width:100%;aspect-ratio:16/9;padding:0;border:1px solid var(--line-2);border-radius:var(--radius-sm);overflow:hidden;background:var(--surface-sunken);cursor:pointer}
.fl-jg-vframe img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .3s,filter .3s;filter:saturate(.95) brightness(.85)}
.fl-jg-vframe:hover img{transform:scale(1.04);filter:none}
.fl-jg-vframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.fl-jg-vplay{position:absolute;left:50%;top:50%;width:54px;height:54px;transform:translate(-50%,-50%);display:grid;place-items:center;border-radius:50%;background:var(--brand);color:#0b0d0f;box-shadow:0 10px 30px rgb(0 0 0 / .45);transition:transform .2s}
.fl-jg-vframe:hover .fl-jg-vplay{transform:translate(-50%,-50%) scale(1.08)}
.fl-jg-featured{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:20px}
.fl-jg-video--big{gap:12px;padding:16px;border:1px solid var(--border-card);border-radius:var(--radius-md);background:var(--surface-card)}
.fl-jg-video--big .fl-jg-vplay{width:68px;height:68px}
.fl-jg-vbadge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:var(--radius-pill);border:1px solid var(--brand-line);background:var(--brand-tint);color:var(--brand);font:var(--type-label);white-space:nowrap}
.fl-jg-vmeta{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.fl-jg-prize{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:28px 32px;padding:28px;border:1px solid var(--border-card);border-radius:var(--radius-md);background:var(--surface-card)}
.fl-jg-prizeh{font:var(--weight-semibold) var(--text-2xl)/1.2 var(--font-sans);margin:0}
.fl-jg-items{display:grid;gap:8px;align-content:start}
.fl-jg-item{display:grid;gap:3px;padding:12px 14px;border:1px solid var(--line-1);border-radius:var(--radius-sm);background:var(--surface-sunken)}
.fl-jg-item code{font:var(--weight-medium) 13px/1.4 var(--font-mono);color:var(--brand)}
.fl-jg-wide{grid-column:1/-1;display:grid;gap:10px}
.fl-jg-table{width:100%;border-collapse:collapse;font:var(--type-body)}
.fl-jg-table th{text-align:left;font:var(--type-label);color:var(--text-subtle);padding:10px 14px;border-bottom:1px solid var(--line-1);white-space:nowrap}
.fl-jg-table td{padding:12px 14px;border-bottom:1px solid var(--line-1);color:var(--ink-2);vertical-align:middle}
.fl-jg-table tr:last-child td{border-bottom:0}
.fl-jg-tablewrap{overflow-x:auto;border:1px solid var(--line-1);border-radius:var(--radius-sm);background:var(--surface-sunken)}
@keyframes flJgIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes flJgPulse{50%{opacity:.3}}
@media (max-width:960px){.fl-jg-hero{grid-template-columns:minmax(0,1fr);gap:32px}.fl-jg-prize{grid-template-columns:minmax(0,1fr);padding:20px}}
@media (max-width:760px){.fl-jg-step{grid-template-columns:minmax(0,1fr);gap:16px;padding:18px}.fl-jg-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.fl-jg-stat:nth-child(2){border-right:0}.fl-jg-stat:nth-child(-n+2){border-bottom:1px solid var(--line-1)}}
@media (max-width:640px){.fl-jg{padding:0 16px 64px}.fl-jg-hero{padding:32px 0 16px}.fl-jg-sec{padding-top:52px}.fl-jg-h2{font-size:var(--text-2xl)}}
@media (prefers-reduced-motion:reduce){.fl-jg-out,.fl-jg-dot,.fl-jg-caret{animation:none}.fl-jg-sigmabtn{transition:none}.fl-jg-thumb img{transition:none}}
`;

function copyText(t: string) {
  try { if (navigator.clipboard && window.isSecureContext) { void navigator.clipboard.writeText(t); return; } } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
}

function Cmd({ c }: { c: Command }) {
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState<RunResult | { error: string } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copy = () => { copyText(c.cmd); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1400); };
  const run = async () => {
    if (!c.run || busy) return;
    setBusy(true);
    try { setOut(await runSpec(c.run)); } catch { setOut({ error: "The request did not complete. Check the connection and try again." }); }
    setBusy(false);
  };
  return (
    <div className="fl-jg-cmd">
      <span className="fl-jg-cmdtitle">{c.title}</span>
      <div className="fl-jg-cmdbox">
        <pre>{c.cmd}</pre>
        {c.run && (
          <button type="button" onClick={() => void run()} disabled={busy} aria-label={`Run: ${c.title}`} className="fl-jg-btn fl-jg-btn--run">
            <PlayIcon />{busy ? "Running" : "Run"}
          </button>
        )}
        <button type="button" onClick={copy} aria-label={`Copy: ${c.title}`} className={"fl-jg-btn" + (copied ? " fl-jg-btn--on" : "")}>
          <Icon name={copied ? "success" : "copy"} size={13} />{copied ? "Copied" : "Copy"}
        </button>
      </div>
      {busy && !out && <div className="fl-jg-out"><div className="fl-jg-outhead"><span className="fl-jg-dot" />Calling {c.run?.path === "/mcp" ? "the MCP server" : "4lpha"}...</div></div>}
      {out && (
        <div className="fl-jg-out" aria-live="polite">
          <div className="fl-jg-outhead">
            {"error" in out ? <b style={{ color: "var(--loss)" }}>{out.error}</b> : <>
              <b style={{ color: out.ok ? "var(--brand)" : "var(--loss)" }}>{out.label}</b>
              <span>{out.ms} ms</span>
              {busy && <span className="fl-jg-dot" />}
            </>}
            <button type="button" onClick={() => setOut(null)} className="fl-jg-btn" style={{ marginLeft: "auto", height: 24 }}>Clear</button>
          </div>
          {"text" in out && (out.hint ? <p className="fl-jg-hint">{out.hint}</p> : <pre>{out.text}</pre>)}
        </div>
      )}
    </div>
  );
}

function Badge({ s }: { s: Status }) {
  return <span className={`fl-jg-badge fl-jg-badge--${s}`}>{STATUS_LABEL[s]}</span>;
}

function EvLinks({ items }: { items: Evidence[] }) {
  return (
    <div className="fl-jg-ev">
      {items.map((e) => {
        const internal = e.href.startsWith("#");
        return (
          <a key={e.href + e.label} href={e.href} {...(internal ? {} : { target: "_blank", rel: "noreferrer" })}>
            {e.label}{!internal && <Icon name="external" size={11} />}
          </a>
        );
      })}
    </div>
  );
}

function Section({ id, eyebrow, title, sub, children }: { id?: string; eyebrow: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="fl-jg-sec">
      <div style={{ display: "grid", gap: 8 }}>
        <span className="fl-jg-eyebrow">{eyebrow}</span>
        <h2 className="fl-jg-h2">{title}</h2>
        {sub && <p className="fl-jg-sub">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** Thumbnail first; the YouTube player (no-cookie domain) loads only after a click. */
function VideoCard({ v, blurb, badge }: { v: Video; blurb?: string; badge?: string }) {
  const [playing, setPlaying] = React.useState(false);
  const big = blurb !== undefined;
  return (
    <div className={"fl-jg-video" + (big ? " fl-jg-video--big" : "")}>
      {playing ? (
        <div className="fl-jg-vframe">
          <iframe src={`https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`} title={v.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />
        </div>
      ) : (
        <button type="button" className="fl-jg-vframe" onClick={() => setPlaying(true)} aria-label={`Play: ${v.title}`}>
          <img src={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`} alt="" loading="lazy" />
          <span className="fl-jg-vplay"><PlayIcon size={big ? 22 : 18} /></span>
        </button>
      )}
      <div className="fl-jg-vmeta">
        <h3 className="fl-jg-h3" style={big ? { font: "var(--weight-semibold) var(--text-xl)/1.25 var(--font-sans)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } : undefined}>
          {v.mode}{badge && <span className="fl-jg-vbadge">{badge}</span>}
        </h3>
        <a href={v.url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 5, font: "var(--type-label)" }}>YouTube<Icon name="external" size={11} /></a>
      </div>
      {blurb && <p className="fl-jg-p" style={{ font: "var(--type-body-md)" }}>{blurb}</p>}
    </div>
  );
}

function Step({ n, step }: { n: number; step: GuideStep }) {
  const img = step.image;
  const narrow = img !== undefined && img.width < 2880;
  return (
    <div className={"fl-jg-step" + (img ? "" : " fl-jg-step--text")}>
      <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
        <span className="fl-jg-stepn">{String(n).padStart(2, "0")}</span>
        <h3 style={{ font: "var(--weight-semibold) var(--text-xl)/1.25 var(--font-sans)", margin: 0 }}>{step.title}</h3>
        {step.before && (
          <div className="fl-jg-note fl-jg-note--warn">
            <Icon name="info" size={16} />
            <span><b style={{ color: "var(--ink-1)" }}>Before this step:</b> {step.before}</span>
          </div>
        )}
        <p className="fl-jg-p" style={{ font: "var(--type-body-md)" }}>{step.body}</p>
        {step.links && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {step.links.map((l) => (
              <a key={l.href} className="fl-jg-pill fl-jg-pill--brand" href={l.href} target="_blank" rel="noreferrer">{l.label}<Icon name="external" size={12} /></a>
            ))}
          </div>
        )}
      </div>
      {img && (
        <a className={"fl-jg-shot" + (narrow ? " fl-jg-shot--narrow" : "")} href={img.src} target="_blank" rel="noreferrer" title="Open full size">
          <img src={img.src} alt={img.alt} width={img.width} height={img.height} loading="lazy" />
        </a>
      )}
    </div>
  );
}

/** Steps with a screenshot get a full row; consecutive text-only steps share one row. */
function groupSteps(steps: GuideStep[]): Array<Array<{ n: number; step: GuideStep }>> {
  const rows: Array<Array<{ n: number; step: GuideStep }>> = [];
  steps.forEach((step, i) => {
    const last = rows[rows.length - 1];
    if (!step.image && last && !last[0]!.step.image) last.push({ n: i + 1, step });
    else rows.push([{ n: i + 1, step }]);
  });
  return rows;
}

const TX_COUNT = new Set([
  ...GROUPS.flatMap((g) => g.features.flatMap((f) => f.evidence.map((e) => e.href))),
  ...PRIZES.flatMap((p) => p.links.map((l) => l.href)),
  ...PRIZES.flatMap((p) => (p.jobs ?? []).flatMap((j) => [j.fund, j.submit, ...(j.extra ? [j.extra.href] : [])])),
].filter((h) => h.includes("bscscan.com/tx/"))).size;

const NAV: Array<[string, string]> = [["#videos", "Videos"], ["#run", "Run it"], ["#connect", "Connect a wallet"], ["#features", "Features"], ["#prizes", "Prizes"], ["#limits", "Limits"]];

const STATS: Array<[string, string]> = [
  ["4", "strategies"],
  ["2", "wallet options"],
  [String(LIVE_AGENTS.length), "agents to open now"],
  [String(TX_COUNT), "mainnet txs linked"],
];

export function JudgeGuide() {
  const onLiveHost = useOnLiveHost();
  return (
    <div className="fl-page">
      <style>{CSS}</style>
      <nav className="fl-jg-nav" aria-label="Judge guide">
        <div className="fl-jg-navin">
          <a href={SITE} className="fl-jg-logo" aria-label="4lpha home"><img className="fl-brand__logo" src={RESOURCES.brandLogo} alt="4lpha" /></a>
          <span className="fl-jg-navtag">Judge guide</span>
          <div className="fl-jg-navlinks">
            {NAV.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          </div>
          <a className="fl-jg-pill fl-jg-pill--brand fl-jg-navcta" href={SITE} target="_blank" rel="noreferrer">Open the app<Icon name="external" size={12} /></a>
        </div>
      </nav>
      <div className="fl-jg">

        <header className="fl-jg-hero">
          <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
            <span className="fl-jg-eyebrow">For judges</span>
            <h1 className="fl-jg-h1">4lpha: hosted agents that trade tokenized US stocks on BNB Chain.</h1>
            <p className="fl-jg-lead">
              Agents trade bStocks 24/7 on BSC mainnet: AI Trade, Schedule buy, Auto DCA and Smart Portfolio.
              Hire once with an Altana passkey or a Binance Agentic Wallet. Every claim links to on-chain proof.
            </p>
            <div className="fl-jg-stats">
              {STATS.map(([n, l]) => <div key={l} className="fl-jg-stat"><b>{n}</b><span>{l}</span></div>)}
            </div>
            <div className="fl-jg-links">
              <a className="fl-jg-pill fl-jg-pill--brand" href="#run"><PlayIcon />Run it here</a>
              <a className="fl-jg-pill" href="#videos"><PlayIcon size={11} />Watch the 4-minute demo</a>
              <a className="fl-jg-pill" href="#connect"><Icon name="wallet" size={13} />Connect an Agentic Wallet</a>
              <a className="fl-jg-pill" href="#prizes"><Icon name="spark" size={13} />Prize tracks</a>
              <a className="fl-jg-pill" href={REPO} target="_blank" rel="noreferrer"><Icon name="external" size={13} />GitHub</a>
            </div>
          </div>
          <SigmaHero />
        </header>

        <Section eyebrow="Start here" title="Agents running right now." sub="Public read-only pages, no login: status, positions with entry and exit amounts, the agent's reasons and its ERC-8004 identity.">
          <div className="fl-jg-grid">
            {LIVE_AGENTS.map((a) => (
              <div key={a.wallet} className="fl-jg-card">
                <a className="fl-jg-thumb" href={agentPage(a.wallet)} target="_blank" rel="noreferrer" title="Open the live page">
                  <img src={a.shot} alt={`${a.mode} agent page`} loading="lazy" />
                </a>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <h3 className="fl-jg-h3">{a.mode}</h3><Badge s={a.status} />
                </div>
                <p className="fl-jg-p">{a.note}</p>
                <span className="fl-jg-mono">{a.wallet}</span>
                <EvLinks items={[
                  { label: "Agent page", href: agentPage(a.wallet) },
                  { label: "BscScan", href: addr(a.wallet) },
                  ...(a.erc8004 ? [{ label: `ERC-8004 #${a.erc8004}`, href: erc8004(a.erc8004) }] : []),
                ]} />
              </div>
            ))}
          </div>
        </Section>

        <Section id="videos" eyebrow="Video walkthroughs" title="See it before you try it." sub="Start with the 4-minute demo, then the skills and one short tutorial per strategy. Press play to watch here, or open them on YouTube.">
          <div className="fl-jg-featured">
            {FEATURED_VIDEOS.map((v, i) => <VideoCard key={v.id} v={v} blurb={v.blurb} badge={i === 0 ? "Start here" : "Wallet Skills prize"} />)}
          </div>
          <span className="fl-jg-eyebrow" style={{ color: "var(--text-subtle)", marginTop: 8 }}>One tutorial per strategy</span>
          <div className="fl-jg-videos">
            {VIDEOS.map((v) => <VideoCard key={v.id} v={v} />)}
          </div>
        </Section>

        <Section id="run" eyebrow="5 minutes, no wallet" title="Run it right here." sub="Press Run to call production from this page and read the live answer, or copy the line into a terminal (bash, zsh or Git Bash). The public endpoint allows 10 calls per minute per IP.">
          {!onLiveHost && (
            <div className="fl-jg-note fl-jg-note--warn">
              <Icon name="info" size={16} />
              <span>This copy of the page is not on 4lpha.tech, so Run calls this host, where the live data tools are switched off. On 4lpha.tech/judge every Run answers with live data.</span>
            </div>
          )}
          <div style={{ display: "grid", gap: 22 }}>
            {COMMANDS.map((c) => <Cmd key={c.id} c={c} />)}
          </div>
        </Section>

        <Section id="connect" eyebrow="Visual guide" title="Connect a Binance Agentic Wallet." sub="The hire flow on the live app, screen by screen. The same strategies can also run on an Altana passkey wallet; you choose at step 2.">
          <div className="fl-jg-steps">
            {groupSteps(AGENTIC_GUIDE).map((row) => row.length === 1 && row[0]!.step.image
              ? <Step key={row[0]!.step.title} n={row[0]!.n} step={row[0]!.step} />
              : <div key={row[0]!.step.title} className="fl-jg-steprow">{row.map((r) => <Step key={r.step.title} n={r.n} step={r.step} />)}</div>)}
          </div>
          <p className="fl-jg-p">Mainnet only: use a small amount in a dedicated wallet.</p>
        </Section>

        {GROUPS.map((g, i) => (
          <Section key={g.id} id={i === 0 ? "features" : g.id} eyebrow={`Features ${i + 1} of ${GROUPS.length}`} title={g.title} sub={g.sub}>
            <div className="fl-jg-grid">
              {g.features.map((f) => (
                <div key={f.id} className="fl-jg-card">
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <h3 className="fl-jg-h3">{f.title}</h3><Badge s={f.status} />
                  </div>
                  <p className="fl-jg-p">{f.what}</p>
                  {f.note && <p className="fl-jg-p" style={{ color: "var(--text-subtle)" }}>{f.note}</p>}
                  <div style={{ marginTop: "auto", paddingTop: 4 }}><EvLinks items={[...(f.see ?? []), ...f.evidence]} /></div>
                </div>
              ))}
            </div>
          </Section>
        ))}

        <Section id="prizes" eyebrow="Special prizes" title="Where each track is covered.">
          {PRIZES.map((p) => (
            <div key={p.id} id={`prize-${p.id}`} className="fl-jg-prize">
              <div style={{ display: "grid", gap: 16, alignContent: "start", minWidth: 0 }}>
                <span className="fl-jg-eyebrow" style={{ color: "var(--integration-gold)" }}>Special prize</span>
                <h3 className="fl-jg-prizeh">{p.title}</h3>
                <p style={{ margin: 0, font: "var(--type-body-md)", color: "var(--ink-2)" }}>{p.tagline}</p>
                <ul className="fl-jg-list">{p.points.map((t) => <li key={t}>{t}</li>)}</ul>
                <EvLinks items={p.links} />
              </div>
              <div className="fl-jg-items">
                <span className="fl-jg-eyebrow" style={{ color: "var(--text-subtle)" }}>{p.itemsTitle}</span>
                {p.items.map((it) => (
                  <div key={it.name} className="fl-jg-item"><code>{it.name}</code><span className="fl-jg-p">{it.body}</span></div>
                ))}
              </div>
              {p.jobs && (
                <div className="fl-jg-wide">
                  <span className="fl-jg-eyebrow" style={{ color: "var(--text-subtle)" }}>Paid ERC-8183 jobs on mainnet</span>
                  <div className="fl-jg-tablewrap">
                    <table className="fl-jg-table">
                      <thead><tr><th>Job</th><th>What happened</th><th>On chain</th><th>Deliverable</th></tr></thead>
                      <tbody>
                        {p.jobs.map((j) => (
                          <tr key={j.id}>
                            <td style={{ font: "var(--weight-medium) 13px/1.4 var(--font-mono)", color: "var(--ink-1)", whiteSpace: "nowrap" }}>#{j.id}</td>
                            <td>{j.what}</td>
                            <td><EvLinks items={[{ label: "Fund", href: j.fund }, { label: "Submit", href: j.submit }, ...(j.extra ? [j.extra] : []), ...(j.rating ? [j.rating] : [])]} /></td>
                            <td><EvLinks items={[{ label: "Report", href: j.report }, { label: "IPFS", href: ipfs(j.cid) }]} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {p.jobsNote && <p className="fl-jg-p" style={{ color: "var(--text-subtle)" }}>{p.jobsNote}</p>}
                </div>
              )}
              <div className="fl-jg-wide" style={{ gap: 18 }}>
                <span className="fl-jg-eyebrow" style={{ color: "var(--text-subtle)" }}>{p.id === "studio" ? "Try the desk agent (terminal)" : "Add 4lpha to an AI assistant"}</span>
                {(p.id === "studio" ? DESK_COMMANDS : ASSISTANT_COMMANDS).map((c) => <Cmd key={c.id} c={c} />)}
                {p.id === "studio" && <p className="fl-jg-p" style={{ color: "var(--text-subtle)" }}>The desk agent does not accept calls from a browser page on another site, so these run in a terminal.</p>}
              </div>
            </div>
          ))}
        </Section>

        <Section id="code" eyebrow="Source" title="Run the code." sub={`Public, MIT licensed. Market data plane: ${DATA_REPO.replace("https://", "")}.`}>
          <div style={{ display: "grid", gap: 20 }}>
            {CODE_COMMANDS.map((c) => <Cmd key={c.id} c={c} />)}
          </div>
        </Section>

        <Section id="limits" eyebrow="Read before judging" title="Known limits, stated plainly.">
          <ul className="fl-jg-list">{LIMITS.map((t) => <li key={t}>{t}</li>)}</ul>
        </Section>
      </div>
    </div>
  );
}

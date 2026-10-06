"use client";
/* The Earn tab of the Agentic public pages (AI Trade, Schedule, Auto DCA), after the Claude Design `AgenticEarnTab`
   (AGENTIC-EARN-SPEC 3.15). Every figure comes from the plane's public view: the chain read (supplied and liquid USDT), the
   agent's own committed rows (activity) and the APYs it read from Binance (not live, and labelled so). A figure without a
   source shows a dash with its reason, never a number. The self-rescue commands are the plane's, never composed here. */
import * as React from "react";
import { Button, Icon } from "@/design-system";
import { AGENTIC_EARN_COPY, agenticEarnTabData, isAgenticEarnDto, type AgenticEarnActivity } from "@/lib/agentic";

type Protocol = "venus" | "aave-v3";
const LOGO = { usdt: "/design/protocols/usdt.png", venus: "/design/protocols/venus.png", "aave-v3": "/design/protocols/aave.png" } as const;
const NAME: Readonly<Record<Protocol, string>> = { venus: "Venus", "aave-v3": "Aave v3" };
const COLOR = { venus: "oklch(0.80 0.14 85)", "aave-v3": "oklch(0.72 0.12 300)", liquid: "var(--raised-3)" } as const;
const ACTIVITY_COLUMNS = "104px minmax(0,1fr) minmax(0,1fr) minmax(0,0.8fr) minmax(0,0.7fr) minmax(0,1.3fr) 72px";
const E16 = 10n ** 16n;

const mono: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-mono)", color: "var(--text-subtle)", textTransform: "uppercase", letterSpacing: "var(--tracking-caps)" };
const body: React.CSSProperties = { font: "var(--weight-regular) var(--text-sm)/1.55 var(--font-sans)", color: "var(--text-muted)", margin: 0, textWrap: "pretty", maxWidth: "78ch" };
const label: React.CSSProperties = { font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" };
const card: React.CSSProperties = { border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)" };

/** Whole USDT with two decimals (truncated): 60.00 */
const f2e = (wei: bigint): string => `${(wei / 10n ** 18n).toLocaleString("en-US")}.${((wei % 10n ** 18n) / E16).toString().padStart(2, "0")}`;
const usdt = (wei: bigint | null): string => wei === null ? "-" : f2e(wei);
const pct = (bps: number | null): string => bps === null ? "n/a" : `${(bps / 100).toFixed(2)}%`;
const share = (part: bigint, whole: bigint): number => whole <= 0n ? 0 : Number(part * 10_000n / whole) / 100;
const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function Logo({ src, size = 24 }: { src: string; size?: number }) {
  return <img src={src} alt="" style={{ width: size, height: size, borderRadius: 999, flex: "0 0 auto", background: "var(--raised-3)", display: "block" }} />;
}

function EarnStat({ label: text, value, note, tone }: { label: string; value: string; note?: string | undefined; tone?: "profit" }) {
  return <div style={{ display: "grid", gap: 8, alignContent: "start", minWidth: 0 }}>
    <span className="fl-trade-kicker">{text}</span>
    <span style={{ font: "var(--weight-semibold) var(--text-xl)/1 var(--font-mono)", color: tone === "profit" ? "var(--profit)" : "var(--ink-1)" }}>{value}</span>
    {note === undefined ? null : <span style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: "var(--text-subtle)" }}>{note}</span>}
  </div>;
}

/** The "why" of an operation, in the owner's words (AGENTIC-EARN-SPEC rule 12 reasons). */
function whyOf(row: AgenticEarnActivity): string {
  if (row.reason === "redeem-all") return "Withdrawing before 4lpha signs out";
  if (row.reason === "gate") return "Operator test";
  if (row.action === "withdraw") return "Cash for the next buys";
  return row.otherApyBps === null ? "Best rate" : `Best rate (${NAME[row.protocol === "venus" ? "aave-v3" : "venus"]} ${pct(row.otherApyBps)})`;
}

export function AgenticEarnTab({ earn, refresh }: { earn: unknown; refresh: () => Promise<unknown> }) {
  if (!isAgenticEarnDto(earn)) return <p role="alert">Earn data unavailable.</p>;
  const { liquidWei, rates, activity } = agenticEarnTabData(earn);
  const protocols: Protocol[] = ["venus", "aave-v3"];
  const read = (protocol: Protocol): { name: string; supplied: bigint | null; apy: number | null; reason: string | null } => {
    const p = earn.products.find(row => row.protocol === protocol);
    return { name: NAME[protocol], supplied: p !== undefined && typeof p.valueWei === "string" && /^\d+$/u.test(p.valueWei) ? BigInt(p.valueWei) : null, apy: rates[protocol], reason: p?.reason ?? "chain-unreadable" };
  };
  const rows = protocols.map(key => ({ key, ...read(key) }));
  const readable = rows.every(r => r.supplied !== null);
  const supplied = readable ? rows.reduce((sum, r) => sum + r.supplied!, 0n) : null;
  const wallet = supplied === null || liquidWei === null ? null : supplied + liquidWei;
  const holding = supplied !== null && supplied > 0n;
  const known = rows.filter(r => r.apy !== null);
  // "Earning now": the product holding the most; with nothing supplied, the best known rate (and a note saying so).
  const active = holding ? rows.reduce((a, b) => b.supplied! > a.supplied! ? b : a) : known.length > 0 ? known.reduce((a, b) => b.apy! > a.apy! ? b : a) : null;
  const best = rows[0]!.apy !== null && rows[1]!.apy !== null ? (rows[0]!.apy >= rows[1]!.apy ? rows[0]!.key : rows[1]!.key) : null;
  const daily = readable && known.length > 0 ? known.reduce((sum, r) => sum + r.supplied! * BigInt(r.apy!) / 10_000n / 365n, 0n) : null;
  const dailyText = daily === null ? "-" : `+${(daily / 10n ** 14n / 10_000n).toString()}.${((daily / 10n ** 14n) % 10_000n).toString().padStart(4, "0")} USDT`;
  const held = earn.open?.held === true ? (AGENTIC_EARN_COPY.held as Readonly<Record<string, string>>)[earn.open.holdReason ?? "other"] ?? AGENTIC_EARN_COPY.held.other : null;
  const rescue = earn.products.flatMap(p => p.selfRescue === null ? [] : [p.selfRescue]);
  const segments = [{ key: "venus" as const, name: "Venus", v: rows[0]!.supplied, logo: LOGO.venus }, { key: "aave-v3" as const, name: "Aave v3", v: rows[1]!.supplied, logo: LOGO["aave-v3"] },
    { key: "liquid" as const, name: "Kept in wallet", v: liquidWei, logo: LOGO.usdt }];
  return <div style={{ display: "grid", gap: 16 }} data-testid="earn-tab">
    {held !== null ? <div role="status" data-testid="earn-held" style={{ padding: "10px 12px", border: "1px solid var(--warn)", borderRadius: "var(--radius-sm)", font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-mono)", color: "var(--warn)" }}>
      Held for review: {held}. The agent does nothing else with this wallet until it is resolved.</div> : null}
    {earn.withdrawingBeforeSignOut ? <div role="status" style={{ padding: "10px 12px", border: "1px solid var(--warn)", borderRadius: "var(--radius-sm)", font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-mono)", color: "var(--warn)" }}>
      Withdrawing everything before 4lpha signs out.</div> : null}

    <section style={{ ...card, padding: "22px 24px", display: "grid", gap: 22 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) repeat(3, minmax(0,1fr))", gap: 24, alignItems: "start" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", minWidth: 0 }}>
          <Logo src={LOGO.usdt} size={40} />
          <EarnStat label="Earning on idle USDT" value={supplied === null ? "-" : `${f2e(supplied)} USDT`}
            note={supplied === null ? "Supplied amount unavailable: the chain read failed." : wallet === null ? "Wallet balance unavailable" : `Supplied from ${f2e(wallet)} USDT in the Agentic Wallet`} />
        </div>
        <EarnStat label="Earning now" value={active === null || active.apy === null ? "n/a" : `${(active.apy / 100).toFixed(2)}% APY`}
          note={active === null ? "No rate known yet" : holding ? `On ${active.name}` : `Nothing supplied right now (best rate: ${active.name})`} />
        <EarnStat label="Est. per day" value={dailyText} {...(daily === null ? {} : { tone: "profit" as const })} note={daily === null ? "No rate or amount to estimate from" : "At the last known rates, before gas"} />
        <EarnStat label="Kept liquid" value={liquidWei === null ? "-" : `${f2e(liquidWei)} USDT`} note={liquidWei === null ? "Wallet balance unavailable" : "Ready for the next buys"} />
      </div>
      {rates.atMs === null ? null : <span style={{ ...mono, textTransform: "none", letterSpacing: 0 }} data-testid="earn-rates-note">Rates from the agent's last Binance read, {new Date(rates.atMs).toLocaleString()}</span>}
      <div style={{ display: "grid", gap: 12 }}>
        {wallet === null || wallet <= 0n ? null : <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", gap: 2, background: "var(--surface-sunken)" }}>
          {segments.filter(s => s.v !== null && s.v > 0n).map(s => <i key={s.key} title={`${s.name} ${f2e(s.v!)} USDT`} style={{ width: `${share(s.v!, wallet)}%`, background: COLOR[s.key] }} />)}
        </div>}
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          {segments.map(s => <span key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, ...label, opacity: s.v !== null && s.v > 0n ? 1 : 0.5 }}>
            <i style={{ width: 8, height: 8, borderRadius: 999, background: COLOR[s.key], border: s.key === "liquid" ? "1px solid var(--line-3)" : "none" }} />
            <Logo src={s.logo} size={18} />{s.name}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-subtle)" }}>{s.v === null || wallet === null ? "-" : `${f2e(s.v)} USDT · ${share(s.v, wallet).toFixed(0)}%`}</span>
          </span>)}
        </div>
      </div>
    </section>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 16 }}>
      {rows.map(p => {
        const on = p.supplied !== null && p.supplied > 0n;
        return <section key={p.key} data-testid={`earn-product-${p.key}`} style={{ ...card, padding: "18px 20px", display: "grid", gap: 16, ...(on ? { borderColor: COLOR[p.key] } : {}) }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Logo src={LOGO[p.key]} size={32} />
            <span style={{ display: "grid", gap: 5 }}>
              <span style={{ font: "var(--weight-semibold) var(--text-base)/1 var(--font-sans)", color: "var(--ink-1)" }}>{p.name}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, ...mono }}><Logo src={LOGO.usdt} size={12} />USDT SUPPLY MARKET</span>
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {p.key === best ? <span style={{ ...mono, padding: "4px 8px", borderRadius: 999, border: "1px solid var(--profit)", color: "var(--profit)" }}>BEST RATE</span> : null}
              <span style={{ ...mono, padding: "4px 8px", borderRadius: 999, border: "1px solid var(--line-2)", color: on ? "var(--ink-1)" : "var(--text-subtle)" }}>{on ? "SUPPLYING" : "STANDBY"}</span>
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 16, paddingTop: 14, borderTop: "1px solid var(--line-1)" }}>
            <EarnStat label="Supply APY" value={pct(p.apy)} />
            <EarnStat label="Supplied" value={usdt(p.supplied)} note={p.supplied === null && p.reason !== null ? p.reason.replace(/-/gu, " ") : "USDT"} />
            <EarnStat label="Share" value={p.supplied === null || supplied === null ? "-" : `${share(p.supplied, supplied).toFixed(0)}%`} note="of supplied USDT" />
          </div>
        </section>;
      })}
    </div>

    <section className="fl-trade-table" data-testid="earn-activity">
      <div className="fl-trade-table__bar"><span>Earn activity</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void refresh()}>Refresh</Button></div>
      <div className="fl-row__head" style={{ gridTemplateColumns: ACTIVITY_COLUMNS, alignItems: "center" }}>
        <span>Action</span><span>Protocol</span><span>Time</span><span>Amount</span><span>APY</span><span>Reason</span><span style={{ justifySelf: "end" }}>Tx</span>
      </div>
      {activity.length === 0 ? <div className="fl-trade-empty">No earn activity yet.</div> : activity.map(r => <div key={r.txHash} className="fl-row" data-testid="earn-activity-row" style={{ gridTemplateColumns: ACTIVITY_COLUMNS, cursor: "default", alignItems: "center" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, ...label, color: r.action === "supply" ? "var(--profit)" : "var(--ink-1)" }}>
          <span style={{ width: 20, height: 20, borderRadius: 999, display: "grid", placeItems: "center", border: "1px solid currentColor", font: "var(--weight-semibold) 11px/1 var(--font-sans)" }}>{r.action === "supply" ? "↑" : "↓"}</span>{r.action === "supply" ? "Supply" : "Withdraw"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, ...label }}><Logo src={LOGO[r.protocol]} size={20} />{NAME[r.protocol]}</span>
        <span style={{ font: "var(--weight-regular) var(--text-sm)/1 var(--font-sans)", color: "var(--text-muted)" }}>{when(r.atMs)}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>
          <Logo src={LOGO.usdt} size={14} />{r.amountWei === null ? <span title="All of the position: the amount was not recorded">- (all)</span> : `${f2e(r.amountWei)} USDT`}</span>
        <span style={{ font: "var(--weight-regular) var(--text-sm)/1 var(--font-mono)", color: "var(--text-muted)" }}>{r.apyBps === null ? "-" : pct(r.apyBps)}</span>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-sans)", color: "var(--text-subtle)" }}>{whyOf(r)}</span>
        <span style={{ justifySelf: "end" }}><a href={`https://bscscan.com/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer" className="fl-btn fl-btn--ghost fl-btn--sm" style={{ gap: 5, textDecoration: "none" }}>Tx<Icon name="external" size={13} /></a></span>
      </div>)}
    </section>

    {rescue.length === 0 ? null : <details style={{ ...card, padding: "14px 18px" }} data-testid="earn-rescue">
      <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, ...label }}><Icon name="key" size={14} />If you sign 4lpha out while USDT is supplied</summary>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <p style={body}>4lpha withdraws everything before it signs out. If you sign it out first, 4lpha can no longer withdraw. Withdraw it yourself with the Binance Agentic Wallet CLI (signing in ends this agent):</p>
        {rescue.map(command => <code key={command} style={{ ...mono, textTransform: "none", letterSpacing: 0, color: "var(--ink-1)", padding: "8px 10px", border: "1px solid var(--line-1)", borderRadius: 4, background: "var(--surface-sunken)", overflowWrap: "anywhere", justifySelf: "start" }}>{command}</code>)}
      </div>
    </details>}
  </div>;
}

"use client";

import React, { useEffect, useState } from "react";
import { Button, Icon, SegmentedToggle } from "@/design-system";
import { TokenIcon } from "@/components/TokenIcon";
import { txUrl, type TradeSettings, type TradeView } from "@/lib/trade";
import { TradeRunLog, runLabel } from "./TradeRunLog";
import { RunLogPanel } from "./TradeSimulationLog";

type Portfolio = NonNullable<TradeView["portfolio"]>;
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const COLORS = ["var(--cat-grid)", "var(--cat-lp)", "var(--cat-yield)", "var(--cat-health)", "oklch(0.70 0.10 150)"];
const HCOLS = "minmax(170px,1.4fr) minmax(120px,1fr) minmax(80px,.65fr) minmax(85px,.7fr) 70px minmax(210px,1.9fr) 70px";
const OCOLS = "minmax(155px,1.3fr) 60px 90px minmax(130px,1fr) 80px 80px 110px 60px";

function money(raw: string | null, signed = false): string {
  if (raw === null) return "—";
  const value = BigInt(raw), positive = value < 0n ? -value : value;
  const cents = (positive + 5n * 10n ** 15n) / 10n ** 16n;
  return `${value < 0n ? "−" : signed && value > 0n ? "+" : ""}${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")} USDT`;
}
function unitPrice(raw: string | null): string {
  if (raw === null) return "—";
  const value = BigInt(raw), scale = 10n ** 14n;
  if (value > 0n && value < scale / 2n) return "<0.0001 USDT";
  const rounded = (value + scale / 2n) / scale;
  const whole = (rounded / 10_000n).toLocaleString("en-US");
  const decimals = (rounded % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return `${whole}${decimals ? `.${decimals}` : ""} USDT`;
}
function quantity(raw: string | null): string {
  if (raw === null) return "—";
  const value = BigInt(raw), scale = 10n ** 14n;
  if (value > 0n && value < scale / 2n) return "<0.0001";
  const rounded = (value + scale / 2n) / scale;
  const whole = (rounded / 10_000n).toLocaleString("en-US");
  const decimals = (rounded % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return decimals ? `${whole}.${decimals}` : whole;
}
function percent(bps: number | bigint | null, signed = false): string {
  if (bps === null) return "—";
  const value = BigInt(bps), positive = value < 0n ? -value : value;
  return `${value < 0n ? "−" : signed && value > 0n ? "+" : ""}${positive / 100n}.${(positive % 100n).toString().padStart(2, "0")}%`;
}
function reason(code: string | null | undefined, old = false): string {
  if (old || code === undefined) return "Needs the updated execution plane.";
  return code === "no-buy" ? "No initial buy recorded." : code === "not-recorded" ? "Executed quantity not recorded."
    : code === "not-verified" ? "Initial buy cost not verified." : "Evidence unavailable.";
}

export function PortfolioSummary({ portfolio, settings, status, sessionExpiresAt }: {
  readonly portfolio: Portfolio; readonly settings: TradeSettings; readonly status: string | null; readonly sessionExpiresAt: number | null | undefined;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const left = Math.max(0, Math.ceil((portfolio.nextCheckAtMs - clock) / 1000));
  const hours = Math.floor(left / 3600), minutes = Math.floor(left % 3600 / 60), seconds = left % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  const countdown = left === 0 ? "Due now" : hours >= 24 ? `Next in ${Math.floor(hours / 24)}d ${pad(hours % 24)}h ${pad(minutes)}m`
    : hours > 0 ? `Next in ${hours}h ${pad(minutes)}m ${pad(seconds)}s` : `Next in ${minutes}m ${pad(seconds)}s`;
  const next = status === "revoked" || status === "retired" ? "Stopped"
    : sessionExpiresAt != null && clock >= sessionExpiresAt * 1000 ? "Session expired · renew to continue"
      : status === "paused" ? "Paused" : status === "provisioning" ? "Waiting for activation" : countdown;
  const pnl = portfolio.pnlWei === null ? null : BigInt(portfolio.pnlWei);
  const invested = BigInt(portfolio.netInvestedWei);
  const pnlPercent = pnl === null || invested <= 0n ? null : pnl * 10000n / invested;
  const pnlPercentTone = pnlPercent === null || pnlPercent === 0n ? "normal" : pnlPercent > 0n ? "profit" : "loss";
  const interval = ({ 86400: "Daily", 43200: "Every 12h", 28800: "Every 8h", 14400: "Every 4h" } as Record<number, string>)[portfolio.intervalSec] ?? "—";
  const tiles: { readonly label: string; readonly value: string; readonly tone?: string; readonly note?: string; readonly noteTone?: string; readonly help?: string }[] = [
    { label: "Total Delegated", value: money(portfolio.capitalQuoteWei) },
    { label: "Execution model", value: "TradFi - Smart Portfolio" },
    { label: "PnL since hire", value: money(portfolio.pnlWei, true), tone: pnl === null || pnl === 0n ? "normal" : pnl > 0n ? "profit" : "loss",
      note: pnl === null ? "Stock quote unavailable." : pnlPercent === null ? "No positive net-invested basis." : percent(pnlPercent, true),
      noteTone: pnlPercentTone,
      help: "Stock value minus net invested. Uses the agent’s conservative buy reservations and verified sale proceeds; excludes idle USDT and BNB gas." },
    { label: "Scheduled check", value: interval, note: `${next}${portfolio.check?.state === "rebalancing" ? " · Current check incomplete" : ""}`,
      help: "Next scheduled check; a check may hold without trading." },
    { label: "Rebalance when drift exceeds", value: percent(settings.portfolioDriftBps ?? null), help: "At or above the threshold, checked on schedule." },
  ];
  return <div className="fl-trade-metrics" data-testid="portfolio-summary">{tiles.map((tile) => <div className="fl-trade-metric" key={tile.label} title={tile.help}>
    <span className={`fl-trade-kicker${tile.label === "Rebalance when drift exceeds" ? " fl-trade-kicker--single-line" : ""}`}>{tile.label}</span><strong className={`fl-trade-metric__value fl-trade-metric__value--${tile.tone ?? "normal"}${tile.label === "Execution model" ? " fl-trade-metric__value--execution-model" : ""}`}>{tile.value}</strong>
    {tile.note ? <span className={`fl-trade-metric__note${tile.noteTone === undefined || tile.noteTone === "normal" ? "" : ` fl-trade-metric__value--${tile.noteTone}`}`}>{tile.note}</span> : null}
  </div>)}</div>;
}

export function PortfolioDetail({ portfolio, settings, runs, icons, refresh, simulationLog }: {
  readonly portfolio: Portfolio; readonly settings: TradeSettings; readonly runs: TradeView["runs"];
  readonly icons: Readonly<Record<string, string | null>>; readonly refresh: () => Promise<unknown>;
  /** The read-only pre-flight simulation log; shown inside the Run log tab (Runs | Simulate toggle) only when supplied. */
  readonly simulationLog?: React.ReactNode;
}) {
  const [tab, setTab] = useState("Holdings");
  const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(null);
  const total = portfolio.totalValueWei === null ? null : BigInt(portfolio.totalValueWei);
  const available = total !== null && total > 0n;
  const circumference = 2 * Math.PI * 47;
  const slices = [...portfolio.tokens.map((token, index) => ({ name: token.symbol, valueWei: token.valueWei, color: COLORS[index] ?? "var(--brand)" })),
    { name: "Cash", valueWei: portfolio.portfolioCashWei, color: "var(--ink-3)" }];
  const rawSliceLengths = available ? slices.map((slice) => Number(BigInt(slice.valueWei ?? "0") * 1_000_000n / total) / 1_000_000 * circumference) : slices.map(() => 0);
  const cashIndex = portfolio.tokens.length;
  const cashLength = rawSliceLengths[cashIndex] ?? 0;
  const cashExtra = BigInt(portfolio.portfolioCashWei) > 0n ? Math.max(0, 3 - cashLength) : 0;
  const largestSliceIndex = rawSliceLengths.reduce((largest, length, index, all) => length > (all[largest] ?? 0) ? index : largest, 0);
  const sliceLengths = rawSliceLengths.map((length, index) => index === cashIndex ? length + cashExtra
    : index === largestSliceIndex ? Math.max(0, length - cashExtra) : length);
  const activeSlice = activeSliceIndex === null ? null : slices[activeSliceIndex] ?? null;
  const cashWeightBps = total === null || total <= 0n ? null : BigInt(portfolio.portfolioCashWei) * 10000n / total;
  let offset = 0;
  const blocked = new Map<string, string>(), committed = new Set<string>();
  for (const run of runs) {
    if (portfolio.check === null || run.createdAt < portfolio.check.checkedAt) continue;
    for (const event of [...(run.events ?? [])].reverse()) {
      if (event.token === undefined) continue;
      const token = event.token.toLowerCase();
      if ((event.stage === "buy" || event.stage === "sell") && event.code === "committed") committed.add(token);
      else if (event.stage === "screen" && event.code.startsWith("portfolio-") && !committed.has(token) && !blocked.has(token))
        blocked.set(token, runLabel(event.code === "portfolio-refused" ? event.reason ?? event.code : event.code));
    }
  }
  return <>
    <section className="fl-trade-table fl-portfolio-allocation" aria-label="Allocation">
      <svg width="104" height="104" viewBox="0 0 104 104" role={available ? "group" : "img"} aria-label={available ? "Managed portfolio allocation" : "Allocation unavailable"}>
        <circle cx="52" cy="52" r="47" fill="none" stroke="var(--line-1)" strokeWidth="10" />
        {available && slices.map((slice, index) => {
          const sliceValue = BigInt(slice.valueWei ?? "0");
          const length = sliceLengths[index] ?? 0;
          const start = offset; offset += length;
          return length === 0 ? null : <circle key={index} cx="52" cy="52" r="47" fill="none" stroke={slice.color}
            strokeWidth="10" opacity={activeSliceIndex === null || activeSliceIndex === index ? 1 : 0.38}
            strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-start}
            transform="rotate(-90 52 52)" role="button" tabIndex={0} aria-label={`${slice.name} ${percent(sliceValue * 10000n / total)}`}
            onMouseEnter={() => setActiveSliceIndex(index)} onMouseLeave={() => setActiveSliceIndex(null)}
            onFocus={() => setActiveSliceIndex(index)} onBlur={() => setActiveSliceIndex(null)}
            style={{ cursor: "pointer", transition: "opacity 140ms ease" }} />;
        })}
        {available && activeSlice === null ? <text x="52" y="55" textAnchor="middle" pointerEvents="none" fill="var(--text-subtle)" fontSize="9">Portfolio</text> : null}
        {available && activeSlice !== null ? <g pointerEvents="none">
          <text x="52" y="49" textAnchor="middle" fill="var(--ink-1)" fontSize="9" fontWeight="600">{activeSlice.name}</text>
          <text x="52" y="64" textAnchor="middle" fill="var(--ink-1)" fontSize="10" fontWeight="600">{percent(BigInt(activeSlice.valueWei ?? "0") * 10000n / total)}</text>
        </g> : null}
      </svg>
      <div className="fl-portfolio-allocation__list">{[...portfolio.tokens, { token: USDT, symbol: "USDT", balanceAtomic: portfolio.portfolioCashWei, valueWei: portfolio.portfolioCashWei }].map((row, index) => <div className="fl-portfolio-allocation__item" key={row.token}>
        <i style={{ background: index === portfolio.tokens.length ? "var(--ink-3)" : COLORS[index] }} /><TokenIcon src={icons[row.token.toLowerCase()] ?? null} symbol={row.symbol} size={24} />
        <span><strong>{index === portfolio.tokens.length ? "Cash" : row.symbol}</strong><small>{index === portfolio.tokens.length ? money(portfolio.portfolioCashWei) : quantity(row.balanceAtomic)}
          {index === portfolio.tokens.length && BigInt(portfolio.idleUsdtWei) > 0n ? ` · ${money(portfolio.idleUsdtWei)} idle · not managed` : ""}</small></span>
        <span>{available && row.valueWei !== null ? percent(BigInt(row.valueWei) * 10000n / total) : "—"}</span>
      </div>)}</div>
      {!available ? <p className="fl-trade-budget__note">{total === null ? "Allocation unavailable: a stock quote is unavailable." : "No managed value yet."}</p> : null}
    </section>
    <div className="fl-portfolio-tabs"><SegmentedToggle value={tab} onChange={setTab} options={["Holdings", "Order history", "Run log"]} /></div>
    {tab === "Holdings" ? <section className="fl-trade-table fl-portfolio-panel"><div className="fl-trade-table__bar"><span>Holdings</span></div><div className="fl-portfolio-table" role="region" aria-label="Holdings table" tabIndex={0}>
      <div className="fl-row__head" style={{ gridTemplateColumns: HCOLS }}><span>Asset</span><span>Current</span><span>Quantity</span><span>Allocation</span><span>Target</span><span>Weight vs band</span><span>Drift</span></div>
      {portfolio.tokens.map((row) => {
        const target = total === null ? null : total * BigInt(row.targetBps) / 10000n;
        const value = row.valueWei === null ? null : BigInt(row.valueWei);
        const difference = value === null || target === null ? null : value - target;
        const driftMagnitude = difference === null || target === null || target <= 0n
          ? null : (difference < 0n ? -difference : difference) * 10000n / target;
        const drift = driftMagnitude === null || difference === null ? null : difference < 0n ? -driftMagnitude : driftMagnitude;
        const outside = driftMagnitude !== null && driftMagnitude >= BigInt(settings.portfolioDriftBps ?? 0);
        const threshold = (settings.portfolioDriftBps ?? 0) / 10000;
        const lower = Math.max(0, row.targetBps / 100 * (1 - threshold)), upper = Math.min(100, row.targetBps / 100 * (1 + threshold));
        const weightBps = value === null || total === null || total <= 0n ? null : value * 10000n / total;
        const weight = weightBps === null ? null : Number(weightBps) / 100;
        const displayName = row.displayName?.replace(/\s*\(bStocks\)$/iu, "").trim();
        const unavailableReason = total === null || row.valueWei === null ? "Stock quote unavailable." : total === 0n ? "No managed value yet." : "No target value.";
        const basis = row.initial?.quoteWei ?? null;
        const change = row.valueWei === null || basis === null || BigInt(basis) <= 0n ? null : (BigInt(row.valueWei) - BigInt(basis)) * 10000n / BigInt(basis);
        return <div className="fl-row fl-portfolio-row" style={{ gridTemplateColumns: HCOLS }} key={row.token}>
          <span className="fl-portfolio-asset"><TokenIcon src={icons[row.token.toLowerCase()] ?? null} symbol={row.symbol} size={26} /><span><strong>{row.symbol}</strong><small>{row.displayName === undefined ? "Needs the updated execution plane." : displayName || "Name unavailable"}</small></span></span>
          <span>{money(row.valueWei)}<small title="Holding-value change versus the first buy’s cost; includes later purchases, sales and transfers. Not investment return.">{change === null ? `— · ${row.valueWei === null ? "Stock quote unavailable." : reason(row.initial?.quoteReason, row.initial === undefined)}` : <span className={change > 0n ? "fl-num--profit" : change < 0n ? "fl-num--loss" : undefined}>{percent(change, true)}</span>}</small>
            {portfolio.check?.state === "rebalancing" && blocked.has(row.token.toLowerCase()) ? <small>{blocked.get(row.token.toLowerCase())}</small> : null}</span>
          <span>{quantity(row.balanceAtomic)}</span>
          <span>{percent(weightBps)}{weightBps === null ? <small>{unavailableReason}</small> : null}</span>
          <span>{percent(row.targetBps)}</span>
          <span className="fl-portfolio-band" aria-label={weight === null || drift === null ? "Weight unavailable" : `Current weight ${weight.toFixed(2)}%, target ${(row.targetBps / 100).toFixed(2)}%, bounds ${lower.toFixed(2)}–${upper.toFixed(2)}%, relative drift ${percent(drift, true)}`}>
            {weight === null ? <>—<small>{unavailableReason}</small></> : <><i className="fl-portfolio-band__range" style={{ left: `${lower}%`, width: `${upper - lower}%` }} /><i className="fl-portfolio-band__fill" style={{ width: `${Math.min(100, weight)}%`, background: outside ? "var(--cat-yield)" : "var(--brand)" }} /><i className="fl-portfolio-band__target" style={{ left: `${row.targetBps / 100}%` }} /></>}
          </span><span style={outside ? { color: "var(--cat-yield)" } : undefined}>{percent(drift, true)}{drift === null ? <small>{unavailableReason}</small> : null}</span>
        </div>;
      })}
      <div className="fl-row fl-portfolio-row" style={{ gridTemplateColumns: HCOLS }}><span className="fl-portfolio-asset"><TokenIcon src={icons[USDT] ?? null} symbol="USDT" size={26} /><span><strong>USDT</strong></span></span><span>{money(portfolio.portfolioCashWei)}</span><span>{money(portfolio.portfolioCashWei).replace(/ USDT$/u, "")}</span><span>{percent(cashWeightBps)}</span><span title="Not applicable">—</span><span title="Not applicable">—</span><span title="Not applicable">—</span></div>
    </div><div className="fl-portfolio-legend"><span>Bar: current weight</span><span>Band: ±{percent(settings.portfolioDriftBps ?? null)} relative to target</span><span>Line: target weight</span></div></section> : null}
    {tab === "Order history" ? <section className="fl-trade-table fl-portfolio-panel"><div className="fl-trade-table__bar"><span>Order history</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void refresh()}>Refresh</Button></div><div className="fl-portfolio-table" role="region" aria-label="Order history table" tabIndex={0}>
      <div className="fl-row__head" style={{ gridTemplateColumns: OCOLS }}><span title="Recorded order time">Time</span><span>Side</span><span>Asset</span><span>Reason</span><span>Price</span><span>Amount</span><span>Value</span><span>Tx</span></div>
      {[...portfolio.legs].sort((a, b) => b.createdAt - a.createdAt || (b.detail?.id ?? "").localeCompare(a.detail?.id ?? "")).map((leg, index) => <div className="fl-row fl-portfolio-row" style={{ gridTemplateColumns: OCOLS }} key={leg.detail?.id ?? `${leg.slot}:${leg.token}:${index}`}>
        <time title="Recorded order time">{new Date(leg.createdAt).toLocaleString()}</time><span style={{ color: leg.side === "buy" ? "var(--profit)" : "var(--loss)" }}>{leg.side === "buy" ? "Buy" : "Sell"}</span><span>{leg.symbol}</span>
        <span>{leg.slot === 0 ? "Initial allocation" : "Rebalance"}<small>{leg.detail === undefined ? "Needs the updated execution plane." : leg.detail.executionState ?? reason(leg.detail.executionReason)}</small></span>
        <span>{leg.detail?.quantityAtomic && BigInt(leg.detail.quantityAtomic) > 0n && leg.detail.quoteWei !== null
          ? unitPrice(BigInt(leg.detail.quoteWei) * 10n ** 18n / BigInt(leg.detail.quantityAtomic) + "") : <>—<small>{leg.detail === undefined ? "Needs the updated execution plane." : "Executed quantity not recorded."}</small></>}</span>
        <span>{quantity(leg.detail?.quantityAtomic ?? null)}{leg.detail?.quantityAtomic == null ? <small>{leg.detail === undefined ? "Needs the updated execution plane." : "Executed quantity not recorded."}</small> : null}</span>
        <span>{money(leg.detail?.quoteWei ?? null)}{leg.detail?.quoteWei == null ? <small>{leg.detail === undefined ? "Needs the updated execution plane." : "Verified value unavailable."}</small> : null}</span>
        <span>{txUrl(leg.txHash) ? <a href={txUrl(leg.txHash)!} target="_blank" rel="noreferrer">Tx ↗</a> : <span>—<small>Transaction hash unavailable.</small></span>}</span>
      </div>)}{portfolio.legs.length === 0 ? <div className="fl-trade-empty">No orders recorded yet.</div> : null}</div></section> : null}
    {tab === "Run log" ? <RunLogPanel simulationLog={simulationLog} runLog={<section className="fl-trade-table fl-portfolio-panel"><div className="fl-trade-table__bar"><span>Run log</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void refresh()}>Refresh</Button></div>
      <TradeRunLog runs={runs} symbols={Object.fromEntries(portfolio.tokens.map((row) => [row.token.toLowerCase(), row.symbol]))} portfolio portfolioLegs={portfolio.legs} /></section>} /> : null}
  </>;
}

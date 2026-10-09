"use client";
import * as React from "react";
import { Button, Icon, StatusBadge } from "@/design-system";
import { SessionExpiryChip, useSessionClock } from "@/components/agent/SessionExpiry";
import { TokenIcon, useTokenIcons } from "@/components/TokenIcon";
import { MarketChart, type MarketChartMarker } from "@/components/MarketChart";
import { ZeroGCredit } from "@/components/ZeroGCredit";
import { Erc8004IdentityStatus } from "@/components/agent/Erc8004IdentityStatus";
import { ClosedPositionRow, CmcLog, DcaDetail, DcaTiles, Metric, PositionRow, bps, closedNewestFirst, compactAddress, heldDuration, usdt2, type PositionRowSettings } from "@/components/trade/TradeAgentDetail";
import { AGENTIC_DCA_COPY, AGENTIC_MEME_COPY, agenticDcaView, agenticRequest, isAgenticDcaDto, isAgenticMemeDecisionLog, isAgenticMemeDto, isAgenticMemeLastCycle, memeReasonLabel,
  type AgenticMemeDecisionLogDto, type AgenticMemeDto } from "@/lib/agentic";
import { AgenticEarnTab } from "./AgenticEarnTab";
import { relativeTime } from "@/lib/exec/agent-detail";
import { parseErc8004Identity } from "@/lib/exec/erc8004-identity";
import { TradeRunLog } from "@/components/trade/TradeRunLog";
import { ScheduleSummary, ScheduleTabs } from "@/components/trade/ScheduleDetail";
import { PortfolioDetail, PortfolioSummary } from "@/components/trade/PortfolioDetail";
import { RunLogPanel } from "@/components/trade/TradeSimulationLog";
import { TRADE_LLM_MODELS, isTradePortfolioBlock, type TradePositionView, type TradeView } from "@/lib/trade";

type PublicPosition = { ref: string; token: string; symbol: string | null; decimals: number | null; status: string; openedAt: number; closedAt: number | null;
  entryUsdtWei: string | null; exitUsdtWei: string | null; tokenAmount: string | null; pnlBps: string | null; closeReason: string | null;
  entryTxHash: string | null; exitTxHash: string | null; unsold: null | { code: string; atMs: number | null };
  live: null | { liveWalletBalance: string | null; currentQuoteWei: string | null; quoteStatus: string } };
/** The Schedule block as the plane sends it; the holding's wallet balance is null when the chain read failed. */
type PublicSchedule = Omit<NonNullable<TradeView["schedule"]>, "holding"> & { holding: Omit<NonNullable<TradeView["schedule"]>["holding"], "walletBalance"> & { walletBalance: string | null } };
type PublicWallet = { wallet: string; custody: "binance-agentic"; agent: null | {
  name: string; status: string; holdCode: string | null; endReason: string | null; termDays: number; termEndAction: string;
  hireStartedAtMs: number; entryCutoffAtMs: number; hireEndsAtMs: number; connection: string; lastProbeAtMs: number | null;
  heldOrders: number; logoutPending: boolean; settings: Record<string, string | number | boolean | null>;
  cmc: { authorizedTotalWei: string; settledWei: string; remainingWei: string; status: string };
  summary: { openPositions: number; maxOpenPositions: number; closedTrades: number; wins: number | null; winRateBps: number | null; grossDeltaWei: string | null; grossComplete: boolean };
  positions: PublicPosition[];
  /** Absent until the plane serving this view has restarted with the runs field. */
  runs?: TradeView["runs"];
  /** Public for now (operator 2026-10-03), opaque operation ids; absent until the plane has restarted with this field. */
  cmcLog?: TradeView["cmcLog"];
  /** The granted universe with lane tickers; absent until the plane has restarted with this field. */
  pinned?: { address: string; symbol: string | null }[];
  /** Present only for a Schedule buy hire; an AI hire never carries the key. */
  schedule?: PublicSchedule;
  /** Present only for a Smart Portfolio hire: the Altana block, or null when a required read failed. */
  portfolio?: TradeView["portfolio"] | null;
  /** Present only for an Agentic Auto DCA hire; read through isAgenticDcaDto, never cast. */
  dca?: unknown;
  /** The ERC-8004 summary (absent before the identity is enrolled or on a plane without the field); read through parseErc8004Identity, never cast. */
  erc8004Identity?: unknown;
  /** Present only for a paper meme hire (AGENTIC-MEME-STOCKS-SPEC 9.3); read through isAgenticMemeDto, never cast. */
  meme?: unknown;
  /** Present only for an earn hire (AGENTIC-EARN-SPEC 3.15); read through isAgenticEarnDto, never cast. */
  earn?: unknown;
} };
type Tab = "Open Positions" | "Closed Positions" | "Kept Positions" | "Run log" | "Earn" | "CMC x402";

/** Not a number: every amount formatter the rows use prints a dash for it, so a value the public view does not carry is never invented. */
const UNAVAILABLE = "unavailable";
const CLOSE_REASONS = ["owner-request", "stop-loss", "take-profit", "max-hold", "llm", "balance-gone", "crash-stop", "session-expiring", "trailing-stop", "stale-exit"] as const;
const QUOTE_STATUSES = ["quoted", "unattributed", "balance-gone", "unavailable", "closed"] as const;
const CMC_STATUS: Readonly<Record<string, string>> = { disabled: "Off", "setup-required": "Setup required", pending: "Pending owner evidence", ready: "Ready", exhausted: "Exhausted" };
const NO_POSITIONS: readonly PublicPosition[] = [];
const USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";

type MemePosition = AgenticMemeDto["paper"]["positions"][number];
type MemeTab = "Open Positions" | "Closed Positions" | "Run log" | "Decision log";
/** Paper exit codes (spec 6.6) in words. */
const MEME_CLOSE: Readonly<Record<string, string>> = { stop: "Stop loss (-30%)", trailing: "Trailing stop", "dead-chart": "Dead chart", "smart-out": "Smart money left",
  "flow-flip": "Sellers took over", time: "Max hold (4 h)", drain: "Agent stopping", ended: "Agent ended" };
const memeVenue = (venue: string): string => venue === "flap-bonding" || venue === "fourmeme-bonding" ? "curve" : "graduated";
/** Paper token amounts are 18 decimals (spec 8.1); a missing amount (older plane) is a dash. */
function memeAmount(wei: string | undefined): string {
  if (wei === undefined || !/^\d+$/u.test(wei)) return "-";
  return (Number(BigInt(wei) / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function memePrice(entryWei: string, tokens: string | undefined): string {
  if (tokens === undefined || !/^\d+$/u.test(tokens) || !/^\d+$/u.test(entryWei) || BigInt(tokens) === 0n) return "-";
  const price = Number(BigInt(entryWei) * 10n ** 18n / BigInt(tokens)) / 1e18;
  return price >= 1 ? price.toLocaleString("en-US", { maximumFractionDigits: 4 }) : price.toPrecision(4);
}
const memeTone = (pnl: number | null): "flat" | "profit" | "loss" => pnl === null ? "flat" : pnl < 0 ? "loss" : "profit";
const memePnlUsdt = (p: MemePosition): string => p.pnlUsdtWei === undefined ? "-" : usdt2(p.pnlUsdtWei, true);
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

function MemeTokenHead({ p, icon }: { p: MemePosition; icon: string | null }) {
  const symbol = p.symbol ?? compactAddress(p.token);
  return <div className="fl-trade-position__token"><TokenIcon src={icon} symbol={symbol} size={26} /><span><strong>{symbol} / {p.quoteSymbol ?? "bStock"}</strong><small><MemeTokenCell address={p.token} /></small></span></div>;
}

function MemeOpenRow({ p, icon, expanded, onExpand }: { p: MemePosition; icon: string | null; expanded: boolean; onExpand: () => void }) {
  const symbol = p.symbol ?? compactAddress(p.token), tone = memeTone(p.pnlBps), held = Math.floor((Date.now() - p.openedAt) / 60_000);
  const marker: readonly MarketChartMarker[] = [{ timestamp: p.openedAt, side: "buy" }];
  return <>
    <div className="fl-trade-position" data-testid="meme-paper-row">
      <MemeTokenHead p={p} icon={icon} />
      <div className="fl-trade-position__age">{relativeTime(p.openedAt, Date.now()).text}</div>
      <div className="fl-trade-position__size"><strong>{memeAmount(p.tokens)} <small>{symbol}</small></strong><span>{usdt2(p.entryUsdtWei)} paper · {memeVenue(p.venue)}</span><span>@ {typeof p.entryMcapUsd === "number" ? `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(p.entryMcapUsd)} MCap` : `${memePrice(p.entryUsdtWei, p.tokens)} USDT / ${symbol}`}</span></div>
      <div className="fl-trade-position__plan"><strong><i className="is-tp" />Trail from +10%{p.peakPnlBps == null ? "" : ` · peak ${bps(p.peakPnlBps, true)}`}</strong><span><i />Stop -30% · max 4 h</span></div>
      <button type="button" className={`fl-trade-chart-button ${expanded ? "is-active" : ""}`} aria-label={`${expanded ? "Hide" : "Show"} ${symbol} chart`} onClick={onExpand}><Icon name="yield" size={18} /></button>
      <div className={`fl-trade-position__pnl is-${tone}`} title={p.markAtMs === null ? undefined : `Marked ${relativeTime(p.markAtMs, Date.now()).text}`}>
        <strong>{p.pnlBps === null ? "-" : memePnlUsdt(p)}</strong><span>{p.pnlBps === null ? "no mark yet" : bps(p.pnlBps, true)}</span></div>
      <div className="fl-trade-position__actions"><span title="Paper trade: no transaction">Paper</span></div>
    </div>
    {expanded ? <div className="fl-trade-position__expanded">
      <div className="fl-trade-position__chart-head"><strong>{symbol} / {p.quoteSymbol ?? "bStock"} paper position</strong><span className="is-entry">● Entry</span><strong className={`is-${tone}`}>{p.pnlBps === null ? "-" : bps(p.pnlBps, true)}</strong></div>
      <MarketChart kind="token" address={p.token} title={symbol} markers={marker} embedded height={230} />
      <div className="fl-trade-position__chart-foot"><span>ENTRY {hhmm(p.openedAt)}</span><span>HOLD {held} / 240 MIN</span></div>
    </div> : null}
  </>;
}

function MemeClosedRow({ p, icon }: { p: MemePosition; icon: string | null }) {
  const symbol = p.symbol ?? compactAddress(p.token), tone = memeTone(p.pnlBps);
  return <div className="fl-trade-position fl-trade-position--closed" data-testid="meme-paper-row">
    <MemeTokenHead p={p} icon={icon} />
    <div className="fl-trade-position__reason"><span>{MEME_CLOSE[p.closeCode ?? ""] ?? (p.closeCode ?? "closed").replace(/-/gu, " ")}</span><small>{memeVenue(p.venue)}{p.costBps === undefined ? "" : ` · cost ${bps(p.costBps)}`}</small></div>
    <div>{heldDuration(p.openedAt, p.closedAt)}</div>
    <div>{memeAmount(p.tokens)} {symbol}</div>
    <div><strong>{usdt2(p.entryUsdtWei)}</strong><span className="fl-trade-position__closed-sub"> → {usdt2(p.exitUsdtWei)}</span></div>
    <div className={`fl-trade-position__pnl is-${tone}`} title="After fees, taxes and gas"><strong>{memePnlUsdt(p)}</strong><span>{p.pnlBps === null ? "-" : bps(p.pnlBps, true)}</span></div>
    <div className="fl-trade-position__actions"><span title="Paper trade: no transaction">Paper</span></div>
  </div>;
}

/** 9.4 (review R2-M2): a paper meme hire shows only its paper ledger, labelled paper; it has no real-summary tile, and a tile without a paper source shows a dash with its reason.
 * Operator 2026-10-06: laid out like the real TradFi detail (tiles, tabs, position rows with chart), every figure still the paper one. */
function MemePaper({ meme, capital, model, maxOpen, runs, symbols, icons, refresh }: { meme: AgenticMemeDto; capital: string | null; model: string; maxOpen: number;
  runs: NonNullable<TradeView["runs"]>; symbols: Record<string, string>; icons: Readonly<Record<string, string | null>>; refresh: React.ReactNode }) {
  const [tab, setTab] = React.useState<MemeTab>("Open Positions"), [expanded, setExpanded] = React.useState<string | null>(null);
  const s = meme.paper.summary, pnl = s.pnlUsdtWei, tone = pnl === null || !/^-?\d+$/u.test(pnl) ? "normal" : BigInt(pnl) < 0n ? "loss" : "profit";
  const pnlPercent = pnl === null || capital === null || !/^-?\d+$/u.test(pnl) || !/^\d+$/u.test(capital) || BigInt(capital) <= 0n ? null : bps((BigInt(pnl) * 10_000n / BigInt(capital)).toString(10), true);
  const open = meme.paper.positions.filter(p => p.status !== "closed").sort((a, b) => b.openedAt - a.openedAt);
  const closed = meme.paper.positions.filter(p => p.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const tabs: readonly MemeTab[] = isAgenticMemeDecisionLog(meme.decisionLog) ? ["Open Positions", "Closed Positions", "Run log", "Decision log"] : ["Open Positions", "Closed Positions", "Run log"];
  const shown: MemeTab = tabs.includes(tab) ? tab : "Open Positions";
  const icon = (token: string) => icons[token.toLowerCase()] ?? null;
  return <>
    <div className="fl-trade-message" role="status" data-testid="meme-paper-banner"><p><strong>{AGENTIC_MEME_COPY.banner}</strong></p><p>{AGENTIC_MEME_COPY.noTokenList}</p></div>
    <div className="fl-trade-metrics">
      <Metric label="Paper budget" value={usdt2(capital)} note={capital === null ? "Capital is not recorded for this agent." : "Sizing only: no USDT is held"} />
      <Metric label="Execution model" value="Meme stocks" note={`LLM model: ${modelLabel(model)}`} credit={<ZeroGCredit />} />
      <Metric label="Paper PnL (closed)" value={usdt2(pnl, true)} tone={tone} note={pnl === null ? "No closed paper trade yet" : `${pnlPercent === null ? "" : pnlPercent + " · "}after fees, taxes and gas`} noteTone={pnl !== null} />
      <Metric label="Paper win rate" value={s.winRateBps === null ? "-" : bps(s.winRateBps)} note={s.winRateBps === null ? "No closed paper trade yet" : `${s.wins}/${s.closed} wins`} />
      <Metric label="Open positions" value={`${s.open} / ${maxOpen}`} note={`${s.closed} closed`} />
    </div>
    <MemeLastCycle value={meme.lastCycle} />
    <div className="fl-trade-tabs">{tabs.map((item) => <button key={item} type="button" className={shown === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
    {shown === "Run log" ? <RunLogPanel runLog={<section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span>{refresh}</div><TradeRunLog runs={runs} symbols={symbols} /></section>} />
      : shown === "Decision log" && isAgenticMemeDecisionLog(meme.decisionLog) ? <MemeDecisionLog log={meme.decisionLog} />
      : <section className="fl-trade-table" aria-label={shown === "Open Positions" ? "Open paper positions" : "Closed paper positions"}>
        <div className="fl-trade-table__bar"><span>{shown}</span>{refresh}</div>
        {shown === "Open Positions"
          ? <><div className="fl-trade-position fl-trade-position--head"><span>Position</span><span>Age</span><span>Size</span><span>Exit plan</span><span>Chart</span><span className="fl-trade-heading-end">Unrealised</span><span className="fl-trade-heading-end">Actions</span></div>
            {open.map((p) => <MemeOpenRow key={p.ref} p={p} icon={icon(p.token)} expanded={expanded === p.ref} onExpand={() => setExpanded(expanded === p.ref ? null : p.ref)} />)}</>
          : <><div className="fl-trade-position fl-trade-position--head fl-trade-position--closed"><span>Position</span><span>Exit reason</span><span>Held</span><span>Size</span><span>Entry / exit</span><span className="fl-trade-heading-end">Realised</span><span className="fl-trade-heading-end">Transactions</span></div>
            <div className="fl-trade-scroll" role="region" aria-label="Closed positions" tabIndex={0}>{closed.map((p) => <MemeClosedRow key={p.ref} p={p} icon={icon(p.token)} />)}</div></>}
        {(shown === "Open Positions" ? open : closed).length === 0 ? <div className="fl-trade-empty">{meme.paper.positions.length === 0 ? "No paper positions yet." : `No ${shown.toLowerCase()}.`}</div> : null}
      </section>}
  </>;
}

/** Operator hotfix 2026-10-06: the newest paper cycle as counts. A missing or stale cycle shows a dash with its reason, never stale numbers as current. */
const MEME_CYCLE_STALE_MS = 180_000;
const memeText: React.CSSProperties = { margin: 0, padding: "4px 16px", color: "var(--text-muted)", font: "var(--type-mono-xs)" };
function MemeLastCycle({ value }: { value: unknown }) {
  const c = isAgenticMemeLastCycle(value) ? value : null, now = Date.now();
  const reasons = c === null ? [] : Object.entries(c.reasons).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const stale = c !== null && now - c.atMs > MEME_CYCLE_STALE_MS;
  const count = (n: number | null, what: string) => `${n === null ? "-" : n} ${what}`;
  return <section className="fl-trade-table" aria-label="Last cycle" data-testid="meme-last-cycle">
    <div className="fl-trade-table__bar"><span>Last cycle</span><span className="fl-trade-heading-end">{c === null ? "-" : relativeTime(c.atMs, now).text}</span></div>
    {c === null || stale ? <div className="fl-trade-empty">{c === null ? "- (no cycle in the last 30 minutes: is the trade-worker running?)"
      : `- (last cycle ${relativeTime(c.atMs, now).text}: more than 3 minutes ago, is the trade-worker running?)`}</div> : <div style={{ padding: "8px 0" }}>
      <p style={memeText}>{count(c.listSize, "on the meme list")} · {count(c.checked, "checked on price bars")} · {c.llmAsked} sent to the model · {c.paperEntries} paper entries · {c.paperExits} paper exits</p>
      <p style={memeText}>{reasons.length === 0 ? `Result: ${c.code ?? "-"}` : `Not taken: ${reasons.map(([code, n]) => `${memeReasonLabel(code)} ${n}`).join(" · ")}`}</p>
      <p style={memeText}>Data lag {c.barLagMs === null ? "-" : `${Math.round(c.barLagMs / 1000)} s`} · cycle took {c.elapsedMs === null ? "-" : `${(c.elapsedMs / 1000).toFixed(1)} s`}</p>
    </div>}
  </section>;
}

/** Local debug: click the short address to copy the full one; the gmgn link opens the token page in a new tab. */
function MemeTokenCell({ address }: { address: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => { void navigator.clipboard?.writeText(address).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }).catch(() => undefined); };
  return <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
    <button type="button" onClick={copy} title={`Copy ${address}`} data-testid="meme-copy-token"
      style={{ all: "unset", cursor: "pointer", textDecoration: "underline dotted" }}>{copied ? "copied" : compactAddress(address)}</button>
    <a href={`https://gmgn.ai/bsc/token/${address}`} target="_blank" rel="noopener noreferrer" data-testid="meme-gmgn-link">gmgn</a>
  </span>;
}

/** Operator 2026-10-07: "Refreshed 40 s ago (17:21:25) · every 60 s · data plane 52 s old", so a stuck market feed shows as a growing age. */
function memeFreshness(market: { atMs: number; prevAtMs?: number | null; asOf?: number | null }, now: number): string {
  const ago = (ms: number) => { const s = Math.max(0, Math.round((now - ms) / 1000)); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; };
  const clock = new Date(market.atMs).toLocaleTimeString("en-GB", { hour12: false });
  return [`Refreshed ${ago(market.atMs)} ago (${clock})`,
    market.prevAtMs === undefined || market.prevAtMs === null ? null : `every ${Math.round((market.atMs - market.prevAtMs) / 1000)} s`,
    market.asOf === undefined || market.asOf === null ? null : `data plane ${ago(market.asOf)} old`].filter(Boolean).join(" · ");
}

/** Local debug only (the plane adds it with AGENTIC_MEME_DECISION_LOG_PUBLIC=true): the newest market read, this agent's signals and model asks. */
function MemeDecisionLog({ log }: { log: AgenticMemeDecisionLogDto }) {
  const now = Date.now(), n = (v: number | null, digits = 0) => v === null ? "-" : v.toLocaleString("en-US", { maximumFractionDigits: digits });
  const pct = (v: number | null) => v === null ? "-" : `${Math.round(v * 100)}%`;
  const cell: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid var(--line-1)", whiteSpace: "nowrap", textAlign: "left" };
  const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", font: "var(--type-mono-xs)", color: "var(--text-muted)" };
  return <section className="fl-trade-table" aria-label="Decision log" data-testid="meme-decision-log">
    <div className="fl-trade-table__bar"><span>Decision log (local debug)</span><span className="fl-trade-heading-end" data-testid="meme-market-freshness">{log.market === null ? "no market read in the last 5 minutes" : memeFreshness(log.market, now)}</span></div>
    <div className="fl-trade-scroll" role="region" aria-label="Decision log rows" tabIndex={0}>
      {log.market === null || log.market.rows.length === 0 ? <div className="fl-trade-empty">- (no market rows)</div> : <table style={table}><thead><tr>
        {["Token", "Quote", "Stage", "Vol 5m $", "Tx 5m", "Buys/Sells 5m", "Smart 5m $", "Smart 1h $", "Tax b/s", "Verdict", "Burst x", "Follow x", "Dead", "Range 15m / cost"].map(h => <th key={h} style={cell}>{h}</th>)}
      </tr></thead><tbody>{log.market.rows.map(r => <tr key={r.address} data-testid="meme-decision-row">
        <td style={cell}><MemeTokenCell address={r.address} /></td><td style={cell}>{r.quoteSymbol ?? "-"}</td>
        <td style={cell}>{[...new Set([r.stage, r.venue === "flap-bonding" || r.venue === "fourmeme-bonding" ? "curve" : r.venue === "pancake-v2" ? "graduated" : r.venue].filter(Boolean))].join(" · ")}</td>
        <td style={cell}>{n(r.volume5mUsd)}</td><td style={cell}>{n(r.txs5m)}</td>
        <td style={cell}>{r.flow5mBuys === null ? "-" : `${r.flow5mBuys}/${r.flow5mSells ?? "-"}`}</td><td style={cell}>{n(r.smart5mNetUsd)}</td><td style={cell}>{n(r.smart1hNetUsd)}</td>
        <td style={cell}>{r.buyTaxBps === null ? "-" : `${r.buyTaxBps / 100}% / ${(r.sellTaxBps ?? 0) / 100}%`}</td>
        <td style={cell}>{r.verdict === "bars-unavailable" && r.bars !== null && r.bars < 8 ? `Too new: ${r.bars}/8 minutes of bars`
          : r.verdict === null ? "-" : memeReasonLabel(r.verdict)}{r.burstReason === null ? "" : ` (${r.burstReason})`}</td>
        <td style={cell}>{n(r.burstRatio, 2)}</td><td style={cell}>{n(r.followRatio, 2)}</td><td style={cell}>{r.deadScore === null ? "-" : `${n(r.deadScore)}${r.hardVeto ? " veto" : ""}`}</td>
        <td style={cell}>{r.range15Bps === null ? "-" : `${n(r.range15Bps)} / ${n(r.costEstBps)} bps`}</td>
      </tr>)}</tbody></table>}
      <table style={table}><thead><tr>{["Signal", "Token", "Verdict", "Cost est", "Cost rule", "Model", "Data lag"].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead>
        <tbody>{log.signals.length === 0 ? <tr><td style={cell} colSpan={7}>- (no signal in the last 30 minutes: nothing passed the bar checks)</td></tr> : log.signals.map((s, i) => <tr key={`${s.atMs}-${i}`}>
          <td style={cell}>{relativeTime(s.atMs, now).text}</td><td style={cell}>{s.token === null ? "-" : <MemeTokenCell address={s.token} />}</td><td style={cell}>{s.verdict === null ? "-" : memeReasonLabel(s.verdict)}</td>
          <td style={cell}>{s.costEstBps === null ? "-" : `${s.costEstBps} bps`}</td><td style={cell}>{s.costRule === null ? "-" : s.costRule ? "pass" : "fail"}</td><td style={cell}>{s.llm ?? "-"}</td>
          <td style={cell}>{s.barLagMs === null ? "-" : `${Math.round(s.barLagMs / 1000)} s`}</td></tr>)}</tbody></table>
      <table style={table}><thead><tr>{["Model ask", "Model", "Outcome", "Latency", "Answers", "Jev (shadow)"].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead>
        <tbody>{log.llm.length === 0 ? <tr><td style={cell} colSpan={6}>- (no model ask in the last 30 minutes)</td></tr> : log.llm.map((a, i) => <tr key={`${a.atMs}-${i}`}>
          <td style={cell}>{relativeTime(a.atMs, now).text}</td><td style={cell}>{a.model ?? "-"}</td><td style={cell}>{a.outcome ?? "-"}</td>
          <td style={cell}>{a.latencyMs === null ? "-" : `${(a.latencyMs / 1000).toFixed(1)} s`}</td><td style={{ ...cell, whiteSpace: "normal" }}>{a.decisions === null ? "-" : JSON.stringify(a.decisions)}</td>
          <td style={{ ...cell, whiteSpace: "normal" }} data-testid="meme-jev-shadow">{a.jev === undefined || a.jev === null ? "-" : a.jev.outcome !== "ok" ? `${a.jev.outcome ?? "-"}`
            : a.jev.answers.map(j => `#${j.index ?? "?"} ${j.choice ?? "-"} (buy ${pct(j.pBuy)}, up 60m ${pct(j.pUp60 ?? null)})`).join(", ")}</td></tr>)}</tbody></table>
      <table style={table} data-testid="meme-jev-scan"><thead><tr>{["Jev scan", "Token", "Dropped by", "Jev", "Buy", "Wait", "Reject", "Up 60m"].map(h => <th key={h} style={cell}>{h}</th>)}</tr></thead>
        <tbody>{(log.jevScan ?? []).length === 0 ? <tr><td style={cell} colSpan={8}>- (no Jev scan in the last 30 minutes)</td></tr> : (log.jevScan ?? []).flatMap((s, i) => s.outcome !== "ok"
          ? [<tr key={`${s.atMs}-${i}`}><td style={cell}>{relativeTime(s.atMs, now).text}</td><td style={cell} colSpan={7}>{s.outcome ?? "-"}</td></tr>]
          : s.answers.map((j, k) => <tr key={`${s.atMs}-${i}-${k}`}><td style={cell}>{k === 0 ? relativeTime(s.atMs, now).text : ""}</td>
            <td style={cell}>{j.token === null ? "-" : <MemeTokenCell address={j.token} />}</td><td style={cell}>{j.verdict === null ? "-" : memeReasonLabel(j.verdict)}</td>
            <td style={cell}>{j.choice ?? "-"}</td><td style={cell}>{pct(j.pBuy)}</td><td style={cell}>{pct(j.pWait)}</td><td style={cell}>{pct(j.pReject)}</td><td style={cell}>{pct(j.pUp60 ?? null)}</td></tr>))}</tbody></table>
    </div>
  </section>;
}

function modelLabel(id: string): string {
  return (TRADE_LLM_MODELS.find((model) => model.id === id)?.label ?? id).replace(/^Auto:\s*/u, "");
}

/** The public projection as the trade rows read it. Entry and exit come only from the verified public amounts. */
function tradePosition(p: PublicPosition, observedAt: number): TradePositionView {
  const closed = p.status === "closed", entry = p.entryUsdtWei;
  const exitVerified = closed && p.exitUsdtWei !== null && p.tokenAmount !== null && p.closeReason !== "balance-gone";
  let realisedBps: string | null = null;
  if (exitVerified && entry !== null) {
    try { if (BigInt(entry) > 0n) realisedBps = ((BigInt(p.exitUsdtWei!) - BigInt(entry)) * 10_000n / BigInt(entry)).toString(10); } catch { realisedBps = null; }
  }
  const quoteStatus = QUOTE_STATUSES.find((value) => value === p.live?.quoteStatus) ?? "unavailable";
  return { positionId: p.ref, token: p.token, route: { hops: [], fees: [] }, entryWei: entry ?? UNAVAILABLE, verifiedEntryAtomic: entry, settlementAsset: "USDT",
    tokenAmount: p.tokenAmount, fillStatus: entry !== null && p.tokenAmount !== null ? "verified" : "unverified", openedAt: p.openedAt, entryTxHash: p.entryTxHash,
    status: p.status, pnlBps: closed ? realisedBps : p.pnlBps, exitRequestedAt: null, orphanedAt: null, closedAt: p.closedAt, exitWei: p.exitUsdtWei,
    exitTxHash: p.exitTxHash, soldTokenAmount: exitVerified ? p.tokenAmount : null, exitFillStatus: exitVerified ? "verified" : p.exitUsdtWei === null ? null : "unverified",
    closeReason: CLOSE_REASONS.find((value) => value === p.closeReason) ?? null, refusalText: null,
    observation: { positionId: p.ref, symbol: p.symbol, decimals: p.decimals ?? null, recordedPositionAmount: p.tokenAmount, liveWalletBalance: p.live?.liveWalletBalance ?? null,
      currentQuoteWei: p.live?.currentQuoteWei ?? null, pnlBps: p.pnlBps, quoteStatus, reason: null, observedAt } };
}

export function AgenticPublicScreen({ wallet, go }: { wallet: string; go?: (route: string) => void }) {
  const [data, setData] = React.useState<PublicWallet | null>(null), [error, setError] = React.useState<string | null>(null);
  const [loadedAt, setLoadedAt] = React.useState(0), [tab, setTab] = React.useState<Tab>("Open Positions"), [expanded, setExpanded] = React.useState<string | null>(null);
  const active = React.useRef(true);
  const load = React.useCallback(async () => {
    if (!/^0x[0-9a-f]{40}$/i.test(wallet)) { setError("Invalid wallet address."); return; }
    try { const value = await agenticRequest<PublicWallet>("wallets/" + wallet); if (active.current) { setData(value); setError(null); setLoadedAt(Date.now()); } }
    catch { if (active.current) setError("Agentic view is unavailable."); }
  }, [wallet]);
  React.useEffect(() => {
    active.current = true; void load(); const timer = setInterval(() => void load(), 15_000);
    return () => { active.current = false; clearInterval(timer); };
  }, [load]);
  const nowMs = useSessionClock();
  const agent = data?.agent ?? null;
  const positions = agent?.positions ?? NO_POSITIONS;
  // A portfolio hire reads its block as sent: a null or malformed block is never rendered.
  const hasPortfolio = agent !== null && Object.hasOwn(agent, "portfolio");
  const portfolioBlock = hasPortfolio && isTradePortfolioBlock(agent.portfolio) ? agent.portfolio as NonNullable<TradeView["portfolio"]> : null;
  const driftBps = agent?.settings.portfolioDriftBps;
  const portfolioData = portfolioBlock === null || typeof driftBps !== "number" || !Number.isSafeInteger(driftBps) ? null : { portfolio: portfolioBlock, settings: { portfolioDriftBps: driftBps } };
  // An Auto DCA hire reads its block as sent too: a malformed block is never rendered.
  const hasDca = agent !== null && Object.hasOwn(agent, "dca");
  const dcaView = React.useMemo(() => agent !== null && isAgenticDcaDto(agent.dca) ? agenticDcaView(agent.dca) : null, [agent]);
  const memeTokens = React.useMemo(() => agent !== null && isAgenticMemeDto(agent.meme) ? agent.meme.paper.positions.map((p) => p.token) : [], [agent]);
  const icons = useTokenIcons(React.useMemo(() => [...positions.map((p) => p.token), ...(portfolioBlock === null ? [] : [...portfolioBlock.tokens.map((row) => row.token), USDT_ADDRESS]), ...(dcaView === null ? [] : [dcaView.token]), ...memeTokens], [positions, portfolioBlock, dcaView, memeTokens]));
  const rows = React.useMemo(() => positions.map((p) => ({ p, view: tradePosition(p, loadedAt) })), [positions, loadedAt]);
  const open = rows.filter(({ p }) => p.status === "open"), closed = rows.filter(({ p }) => p.status === "closed"), kept = rows.filter(({ p }) => p.status === "kept");
  const symbols = Object.fromEntries([
    ...(agent?.pinned ?? []).flatMap((row) => row.symbol ? [[row.address.toLowerCase(), row.symbol] as const] : []),
    ...positions.map((p) => [p.token.toLowerCase(), p.symbol ?? compactAddress(p.token)] as const),
  ]);
  const settings: PositionRowSettings | null = agent === null ? null : { settlementAsset: "USDT",
    takeProfitBps: typeof agent.settings.takeProfitBps === "number" ? agent.settings.takeProfitBps : null,
    stopLossBps: typeof agent.settings.stopLossBps === "number" ? agent.settings.stopLossBps : null,
    maxHoldSec: typeof agent.settings.maxHoldSec === "number" ? agent.settings.maxHoldSec : null };
  const capital = typeof agent?.settings.capitalQuoteWei === "string" ? agent.settings.capitalQuoteWei : null;
  const gross = agent?.summary.grossDeltaWei ?? null;
  const grossTone = gross === null || !/^-?\d+$/u.test(gross) ? "normal" : BigInt(gross) < 0n ? "loss" : "profit";
  const grossPercent = gross === null || capital === null || !/^-?\d+$/u.test(gross) || !/^\d+$/u.test(capital) || BigInt(capital) <= 0n ? undefined
    : bps((BigInt(gross) * 10_000n / BigInt(capital)).toString(10), true);
  const live = agent !== null && agent.status !== "ended" && agent.status !== "ending";
  // R17.2: a stopped, ended or interrupted last round, or an ended agent whose last round settled (or that never had one), shows the wallet holding.
  const dcaTerminal = dcaView !== null && (dcaView.round !== null && ["stopped", "ended", "interrupted"].includes(dcaView.round.phase)
    || agent !== null && agent.status === "ended" && (dcaView.round === null || dcaView.round.phase === "settled"));
  // A Schedule hire swaps the AI metrics and position tabs for the Schedule body; its settings are read, never cast, from what the plane sent.
  const schedule = agent?.schedule ?? null, isDecimal = (value: unknown): value is string => typeof value === "string" && /^\d+$/u.test(value);
  const scheduleBalance = schedule?.holding.walletBalance, scheduleEntry = agent?.settings.entryWei;
  const scheduleData = schedule === null || !isDecimal(capital) || !isDecimal(scheduleEntry) || !isDecimal(scheduleBalance) ? null
    : { schedule: { ...schedule, holding: { ...schedule.holding, walletBalance: scheduleBalance } }, settings: { capitalQuoteWei: capital, entryWei: scheduleEntry, scheduleMarketHoursOnly: schedule.marketHoursOnly } };
  const scheduleOpen = rows.filter(({ p }) => p.status !== "closed").map(({ view }) => view);
  const state = agent === null ? "paused" : agent.status === "ended" ? "danger" : agent.status === "running" || agent.status === "entries-stopped" ? "live" : "paused";
  const stateLabel = agent === null ? undefined : agent.status === "ended" ? (hasDca && agent.endReason === "stop-loss" ? "Stopped by stop loss" : "Ended") : agent.schedule?.finished != null ? "Finished: " + agent.schedule.finished
    : agent.status === "running" ? undefined : agent.status.replace(/-/gu, " ");
  // The Earn tab exists only for an earn hire (its block is present); a malformed block is reported inside the tab.
  const earnTab = agent !== null && agent.earn !== undefined ? <AgenticEarnTab earn={agent.earn} refresh={load} /> : undefined;
  const earnTabs: readonly Tab[] = earnTab === undefined ? [] : ["Earn"];
  const tabs: readonly Tab[] = kept.length > 0 ? ["Open Positions", "Closed Positions", "Kept Positions", "Run log", ...earnTabs, "CMC x402"] : ["Open Positions", "Closed Positions", "Run log", ...earnTabs, "CMC x402"];
  const shown: Tab = tabs.includes(tab) ? tab : "Open Positions";
  const refresh = <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void load()}>Refresh</Button>;
  const openHead = <div className="fl-trade-position fl-trade-position--head"><span>Position</span><span>Age</span><span>Size</span><span>Exit plan</span><span>Chart</span><span className="fl-trade-heading-end">Unrealised</span><span className="fl-trade-heading-end">Actions</span></div>;
  const toggle = (id: string) => () => setExpanded(expanded === id ? null : id);
  const unsoldPlan = (p: PublicPosition) => <><strong>{(p.unsold?.code ?? "kept").replace(/-/gu, " ")}</strong>{p.unsold?.atMs == null ? null : <span>{relativeTime(p.unsold.atMs, Date.now()).text}</span>}</>;
  return <div className="fl-shell fl-hired-agent-page fl-trade-detail-page">
    {go === undefined ? null : <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => go("/account")}>My agents</Button>}
    <div className="fl-trade-hero">
      <div className="fl-trade-title-stack">
        <div className="fl-trade-title"><span className="fl-card__glyph"><Icon name="yield" size={22} /></span><h1>{agent?.name ?? "Binance Agentic Wallet"}</h1>
          {agent === null ? null : <StatusBadge status={state} pill {...(stateLabel === undefined ? {} : { label: stateLabel })} />}
          {live && agent !== null ? <SessionExpiryChip expiresAt={Math.floor(agent.hireEndsAtMs / 1_000)} nowMs={nowMs} /> : null}</div>
        <span className="fl-trade-kicker fl-trade-agent-id" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}><img src="/design/protocols/agentic-wallet.png" alt="Agentic Wallet" style={{ height: 14, width: "auto", verticalAlign: "middle", marginRight: 8 }} /><a href={`https://bscscan.com/address/${wallet}`} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline", textTransform: "none", letterSpacing: "normal" }}>{wallet}</a>{dcaView === null ? null : <span style={{ marginLeft: 12, textTransform: "none", letterSpacing: "normal" }}>Auto DCA · {dcaView.symbol}</span>}{parseErc8004Identity(agent?.erc8004Identity) === undefined ? null : <span style={{ display: "inline-block", marginLeft: 12, textTransform: "none", letterSpacing: "normal", verticalAlign: "middle" }}><Erc8004IdentityStatus identity={parseErc8004Identity(agent?.erc8004Identity)} /></span>}</span>
      </div>
      <div className="fl-hired-actions">
        {/* Looks like a disabled secondary button (design), but is not a control: this page has no owner actions. */}
        <span role="note" title="No owner actions after hire" aria-label="Read-only: no owner actions after hire" className="fl-btn fl-btn--secondary"
          style={{ gridColumn: "1 / -1", justifySelf: "end", opacity: 0.4, cursor: "default" }}><Icon name="eye" size={15} />Read-only</span>
      </div>
    </div>
    {agent !== null && (agent.holdCode || agent.heldOrders > 0 || agent.endReason === "owner-signed-out" || agent.logoutPending || agent.connection === "unreachable") ? <div className="fl-trade-message" role="status">
      {agent?.holdCode ? <p>Settings hold: {agent.holdCode.replace(/-/gu, " ")}.</p> : null}
      {agent !== null && agent.heldOrders > 0 ? <p>{agent.heldOrders} order{agent.heldOrders === 1 ? " is" : "s are"} held for review.</p> : null}
      {agent?.endReason === "owner-signed-out" ? <p>Ended: you signed 4lpha out in the Binance App.</p> : null}
      {agent?.logoutPending ? <p>4lpha is still signing out.</p> : null}
      {agent?.connection === "unreachable" ? <p>The Binance connection is unreachable; the figures below are the last verified ones.</p> : null}
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}{data === null && !error ? <p>Loading...</p> : null}{data !== null && agent === null ? <p>No Agentic hire found for this wallet.</p> : null}
    {agent === null ? null : agent.meme !== undefined ? (isAgenticMemeDto(agent.meme) ? <MemePaper meme={agent.meme} capital={capital} model={String(agent.settings.primaryModel ?? "-")} maxOpen={agent.summary.maxOpenPositions} runs={agent.runs ?? []} symbols={symbols} icons={icons} refresh={refresh} />
      : <p role="alert">Paper data unavailable.</p>) : hasDca ? (dcaView === null ? <p role="alert">Auto DCA data unavailable.</p>
      : <>
        {/* The Altana stat row (R3.10): after a stop, a term end or an owner end the round is nulled so the PnL tile takes its rounds rule, and the Average-price tile keeps the holding (R31.3). */}
        <DcaTiles dca={dcaTerminal ? { ...dcaView, round: null } : dcaView} settings={capital === null ? null : { capitalQuoteWei: capital }} live={live}
          {...(dcaTerminal ? { ended: { avgCostE8: dcaView.round?.avgCostE8 ?? null } } : {})} />
        <DcaDetail dca={dcaView} status={live ? "armed" : agent.status} draining={false} planeUnreachable={false} busy={false} refresh={load} icon={icons[dcaView.token.toLowerCase()] ?? null}
        runs={agent.runs ?? []} symbols={{ [dcaView.token.toLowerCase()]: dcaView.symbol }} readOnly endReason={agent.endReason} {...(earnTab === undefined ? {} : { earnTab })}
        holdingsExtra={<section className="fl-trade-budget" data-testid="dca-keepalive-panel">
          <div className="fl-trade-budget__head"><div><span className="fl-trade-kicker">CMC keep-alive (x402)</span><p>{AGENTIC_DCA_COPY.keepAlivePanel}</p></div><strong>{CMC_STATUS[agent.cmc.status] ?? "Unavailable"}</strong></div>
          <div className="fl-trade-budget__facts"><span>Remaining <b>{usdt2(agent.cmc.remainingWei)}</b></span><span>Settled <b>{usdt2(agent.cmc.settledWei)}</b></span><span>Total <b>{usdt2(agent.cmc.authorizedTotalWei)}</b></span>
            <span>Last paid <b>{dcaView.keepAlive?.lastPaidAtMs == null ? "none yet" : new Date(dcaView.keepAlive.lastPaidAtMs).toLocaleString()}</b></span></div>
        </section>} /></>) : hasPortfolio ? (portfolioData === null ? <p role="alert">Portfolio data unavailable.</p> : <>
      <PortfolioSummary portfolio={portfolioData.portfolio} settings={portfolioData.settings} sessionExpiresAt={null}
        status={agent.status === "ended" || agent.status === "ending" || nowMs >= agent.entryCutoffAtMs ? "revoked" : agent.status === "held" ? "paused" : null} />
      <PortfolioDetail portfolio={portfolioData.portfolio} settings={portfolioData.settings} runs={agent.runs ?? []} icons={icons} refresh={load} readOnly />
    </>) : schedule !== null ? (scheduleData === null ? <p role="alert">Schedule data unavailable.</p> : <>
      <ScheduleSummary {...scheduleData} open={scheduleOpen} readOnly label={`Schedule buy · ${scheduleData.schedule.symbol}`} />
      <ScheduleTabs {...scheduleData} trade={{ open: scheduleOpen, runs: agent.runs ?? [] }} refresh={load} readOnly {...(earnTab === undefined ? {} : { earnTab })} />
    </>) : <>
      <div className="fl-trade-metrics">
        <Metric label="Total Delegated" value={usdt2(capital)} {...(capital === null ? { note: "Capital is not recorded for this agent." } : {})} />
        <Metric label="Execution model" value={String(agent.settings.executionModel ?? "-")} note={`LLM model: ${modelLabel(String(agent.settings.primaryModel ?? "-"))}`} credit={<ZeroGCredit />} />
        <Metric label="PnL since hire" value={usdt2(gross, true)} tone={grossTone} note={agent.summary.grossComplete ? grossPercent : "Some verified values are unavailable"} noteTone />
        <Metric label="Win rate" value={agent.summary.winRateBps === null ? "-" : bps(agent.summary.winRateBps)} note={`${agent.summary.wins ?? "-"}/${agent.summary.closedTrades} wins · gross`} />
        <Metric label="Open positions" value={`${agent.summary.openPositions} / ${agent.summary.maxOpenPositions}`} />
      </div>
      <div className="fl-trade-tabs">{tabs.map((item) => <button key={item} type="button" className={shown === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      {shown === "Earn" ? earnTab : shown === "CMC x402" ? <><section className="fl-trade-budget" data-testid="cmc-budget-panel">
        <div className="fl-trade-budget__head"><div><span className="fl-trade-kicker">CMC data (x402)</span><p>Required market data for Agentic Wallet agents, paid from a fixed USDT budget; the paid calls also keep the Binance session active. Never blocks exits.</p></div><strong>{CMC_STATUS[agent.cmc.status] ?? "Unavailable"}</strong></div>
        <div className="fl-trade-budget__facts"><span>Remaining <b>{usdt2(agent.cmc.remainingWei)}</b></span><span>Settled <b>{usdt2(agent.cmc.settledWei)}</b></span><span>Total <b>{usdt2(agent.cmc.authorizedTotalWei)}</b></span></div>
      </section>
      <section className="fl-trade-table"><div className="fl-trade-table__bar"><span>CMC log</span>{refresh}</div><CmcLog log={agent.cmcLog} /></section></> : shown === "Run log" ? <RunLogPanel runLog={<section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span>{refresh}</div>
        <TradeRunLog runs={agent.runs ?? []} symbols={symbols} /></section>} />
      : <section className="fl-trade-table">
        <div className="fl-trade-table__bar"><span>{shown}</span>{refresh}</div>
        {shown === "Closed Positions"
          ? <><div className="fl-trade-position fl-trade-position--head fl-trade-position--closed"><span>Position</span><span>Exit reason</span><span>Held</span><span>Size</span><span>Entry / exit</span><span className="fl-trade-heading-end">Realised</span><span className="fl-trade-heading-end">Transactions</span></div>
            <div className="fl-trade-scroll" role="region" aria-label="Closed positions" tabIndex={0}>{closedNewestFirst(closed.map(({ view }) => view)).map((view) => <ClosedPositionRow key={view.positionId} position={view} icon={icons[view.token.toLowerCase()] ?? null} usdRate={null} settings={settings} />)}</div></>
          : <>{openHead}{(shown === "Open Positions" ? open : kept).map(({ p, view }) => <PositionRow key={p.ref} position={view} open icon={icons[p.token.toLowerCase()] ?? null} expanded={expanded === p.ref} onExpand={toggle(p.ref)} busy={false} settings={settings}
            {...(shown === "Kept Positions" ? { plan: unsoldPlan(p) } : {})} />)}</>}
        {(shown === "Open Positions" ? open : shown === "Closed Positions" ? closed : kept).length === 0 ? <div className="fl-trade-empty">No {shown.toLowerCase()}.</div> : null}
      </section>}
    </>}
  </div>;
}

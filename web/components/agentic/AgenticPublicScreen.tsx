"use client";
import * as React from "react";
import { Button, Icon, StatusBadge } from "@/design-system";
import { SessionExpiryChip, useSessionClock } from "@/components/agent/SessionExpiry";
import { useTokenIcons } from "@/components/TokenIcon";
import { ZeroGCredit } from "@/components/ZeroGCredit";
import { Erc8004IdentityStatus } from "@/components/agent/Erc8004IdentityStatus";
import { ClosedPositionRow, CmcLog, DcaDetail, DcaTiles, Metric, PositionRow, bps, closedNewestFirst, compactAddress, usdt2, type PositionRowSettings } from "@/components/trade/TradeAgentDetail";
import { AGENTIC_DCA_COPY, AGENTIC_MEME_COPY, agenticDcaView, agenticRequest, isAgenticDcaDto, isAgenticMemeDto, type AgenticMemeDto } from "@/lib/agentic";
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

/** 9.4 (review R2-M2): a paper meme hire shows only its paper ledger, labelled paper; it has no real-summary tile, and a tile without a paper source shows a dash with its reason. */
function MemePaper({ meme, capital, runs, symbols }: { meme: AgenticMemeDto; capital: string | null; runs: NonNullable<TradeView["runs"]>; symbols: Record<string, string> }) {
  const s = meme.paper.summary, pnl = s.pnlUsdtWei, tone = pnl === null || !/^-?\d+$/u.test(pnl) ? "normal" : BigInt(pnl) < 0n ? "loss" : "profit";
  const newestFirst = [...meme.paper.positions].sort((a, b) => b.openedAt - a.openedAt);
  return <>
    <div className="fl-trade-message" role="status" data-testid="meme-paper-banner"><p><strong>{AGENTIC_MEME_COPY.banner}</strong></p><p>{AGENTIC_MEME_COPY.noTokenList}</p></div>
    <div className="fl-trade-metrics">
      <Metric label="Paper budget" value={usdt2(capital)} note={capital === null ? "Capital is not recorded for this agent." : "Sizing only: no USDT is held"} />
      <Metric label="Paper PnL (closed)" value={usdt2(pnl, true)} tone={tone} {...(pnl === null ? { note: "No closed paper trade yet" } : { note: "After fees, taxes and gas" })} />
      <Metric label="Paper win rate" value={s.winRateBps === null ? "-" : bps(s.winRateBps)} note={s.winRateBps === null ? "No closed paper trade yet" : `${s.wins}/${s.closed} wins`} />
      <Metric label="Paper positions" value={`${s.open} open`} note={`${s.closed} closed`} />
    </div>
    <section className="fl-trade-table" aria-label="Paper ledger">
      <div className="fl-trade-table__bar"><span>Paper ledger</span></div>
      <div className="fl-trade-scroll" role="region" aria-label="Paper positions" tabIndex={0}>
        {newestFirst.length === 0 ? <div className="fl-trade-empty">No paper positions yet.</div> : newestFirst.map((p) => <div key={p.ref} className="fl-trade-position" data-testid="meme-paper-row">
          <span>{p.symbol ?? compactAddress(p.token)}{p.quoteSymbol === null ? "" : ` / ${p.quoteSymbol}`}</span>
          <span>{p.venue === "flap-bonding" ? "curve" : "graduated"}</span>
          <span>{p.status === "closed" ? (p.closeCode ?? "closed").replace(/-/gu, " ") : "open"}</span>
          <span>{usdt2(p.entryUsdtWei)}</span>
          <span>{p.status === "closed" ? usdt2(p.exitUsdtWei) : p.markUsdtWei === null ? "- (no mark yet)" : usdt2(p.markUsdtWei)}</span>
          <span className="fl-trade-heading-end">{p.pnlBps === null ? "- (no mark yet)" : bps(p.pnlBps, true)}</span>
        </div>)}
      </div>
    </section>
    <RunLogPanel runLog={<section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span></div><TradeRunLog runs={runs} symbols={symbols} /></section>} />
  </>;
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
  const icons = useTokenIcons(React.useMemo(() => [...positions.map((p) => p.token), ...(portfolioBlock === null ? [] : [...portfolioBlock.tokens.map((row) => row.token), USDT_ADDRESS]), ...(dcaView === null ? [] : [dcaView.token])], [positions, portfolioBlock, dcaView]));
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
    {agent === null ? null : agent.meme !== undefined ? (isAgenticMemeDto(agent.meme) ? <MemePaper meme={agent.meme} capital={capital} runs={agent.runs ?? []} symbols={symbols} />
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

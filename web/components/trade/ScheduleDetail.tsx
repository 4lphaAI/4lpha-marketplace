"use client";

/**
 * Schedule buy agent body: the progress card, holdings/PnL metrics, the
 * price panel and the buys table, ported from the operator's mock-up
 * (`schedule-detail.jsx` / `trade-kit-shell.jsx`) onto the live `TradeView`
 * DTO. Rendered by `TradeAgentDetail` in place of the generic position
 * table when `trade.schedule` is present; the hero, session notices and
 * identity line stay in `TradeAgentDetail` unchanged.
 */

import React, { useEffect, useState } from "react";
import { Button, Icon, SegmentedToggle, Skeleton } from "@/design-system";
import { MarketChart, type MarketChartMarker } from "@/components/MarketChart";
import { TokenIcon, useTokenIcons } from "@/components/TokenIcon";
import { formatRemaining } from "@/components/agent/SessionExpiry";
import { TradeRunLog } from "./TradeRunLog";
import { RunLogPanel } from "./TradeSimulationLog";
import type { TradePositionView, TradeSettings, TradeView } from "@/lib/trade";

type Schedule = NonNullable<TradeView["schedule"]>;
/** The three settings the schedule body reads, so the Agentic public page can render it without a full settings object. */
type ScheduleSettings = Pick<TradeSettings, "capitalQuoteWei" | "entryWei" | "scheduleMarketHoursOnly">;

const MONO: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" };
const KICKER: React.CSSProperties = { font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.08em", textTransform: "uppercase" };

/** A fill still unverified after this long is treated as stuck, not imminent — a dash, not an endless skeleton. */
const UNVERIFIED_STALE_MS = 15 * 60_000;

function usdt2(wei: string | null | undefined, signed = false): string {
  if (wei === null || wei === undefined || !/^-?\d+$/u.test(wei)) return "—";
  try {
    const amount = BigInt(wei);
    const magnitude = amount < 0n ? -amount : amount;
    const cents = (magnitude + 5n * 10n ** 15n) / 10n ** 16n;
    const whole = cents / 100n;
    const fraction = (cents % 100n).toString(10).padStart(2, "0").replace(/0+$/u, "");
    const value = fraction === "" ? whole.toString(10) : `${whole}.${fraction}`;
    const negative = amount < 0n && cents > 0n;
    return `${negative ? "-" : signed && amount > 0n && cents > 0n ? "+" : ""}${value} USDT`;
  } catch { return "—"; }
}

function usdt2Plain(wei: string | null | undefined): string {
  return usdt2(wei).replace(/ USDT$/u, "");
}

function bpsPercent(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const percent = value / 100;
  const sign = signed && percent > 0 ? "+" : percent < 0 ? "−" : "";
  return `${sign}${Math.abs(percent).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function compactAddress(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function txUrl(hash: string | null): string | null {
  return hash === null ? null : `https://bscscan.com/tx/${hash}`;
}

function formatTokenAmount(raw: string | null, decimals: number | null): string {
  if (raw === null || decimals === null) return "—";
  try {
    const value = Number(raw) / 10 ** decimals;
    if (!Number.isFinite(value)) return "—";
    return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  } catch { return "—"; }
}

function formatDateTime(ms: number): string {
  const date = new Date(ms);
  return `${date.toLocaleDateString("en-US", { day: "2-digit", month: "short" })} · ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/**
 * "in 3h 12m" until the next due slot. A slot that is due but not yet filled is
 * retried every worker cycle until the following slot starts, so the countdown
 * runs to that boundary and the pending cycle is named underneath.
 */
/** "5m 30s" / "2h 05m 30s" / "1d 03h 12m": seconds are shown under a day so the tick is visible. */
function formatCountdown(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

function scheduleCountdown(schedule: Schedule, nowMs: number): { readonly value: string; readonly note?: string } {
  const intervalMs = schedule.intervalSec * 1_000;
  let dueAtMs = schedule.nextDueAtMs;
  if (dueAtMs <= nowMs && !schedule.currentSlotTaken) {
    dueAtMs += Math.ceil((nowMs - dueAtMs + 1) / intervalMs) * intervalMs;
    const pending = schedule.currentSlot === null ? null : schedule.currentSlot + 1;
    // B4 (TRADFI-SCHEDULE-NATIVE-CAP-PLAN): a pending cycle that is stuck on the
    // on-chain native day cap says so, rather than reading like an ordinary wait.
    const note = pending === null ? undefined
      : schedule.nativeBuysRefused === true ? `cycle ${pending} pending · native day cap` : `cycle ${pending} pending`;
    return { value: `in ${formatCountdown(dueAtMs - nowMs)}`, ...(note === undefined ? {} : { note }) };
  }
  return { value: dueAtMs <= nowMs ? "due now" : `in ${formatCountdown(dueAtMs - nowMs)}` };
}

function scheduleFrequencyLabel(intervalSec: number): string {
  switch (intervalSec) {
    case 3_600: return "1 HOUR";
    case 14_400: return "4 HOURS";
    case 28_800: return "8 HOURS";
    case 43_200: return "12 HOURS";
    default: return "DAILY";
  }
}

function scheduleEndRuleLabel(schedule: Schedule): string {
  if (schedule.endKind === "date") {
    return schedule.endAtSec === null ? "UNTIL BUDGET IS SPENT"
      : `UNTIL ${new Date(schedule.endAtSec * 1_000).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}`;
  }
  if (schedule.endKind === "runs") {
    return schedule.endRuns === null ? "UNTIL BUDGET IS SPENT" : `${schedule.endRuns} RUNS`;
  }
  return "UNTIL BUDGET IS SPENT";
}

function scheduleFinishedLabel(finished: NonNullable<Schedule["finished"]>): string {
  return finished === "budget" ? "Finished — budget spent" : finished === "runs" ? "Finished — runs done" : "Finished — end date reached";
}

/** "balance is zero" / "quote unavailable" — the platform's dash-with-reason text for the plane's two holding-quote failure codes. */
function quoteDashReason(reason: string | null): string | undefined {
  return reason === "balance-zero" ? "balance is zero" : reason === "quote-unavailable" ? "quote unavailable" : undefined;
}

/**
 * Operator ruling (2026-09-21): PnL and Average price stay a skeleton while
 * any open fill's basis is still unverified or the holding quote has not
 * landed yet, and fall back to a dash after 15 minutes rather than spinning
 * forever over a fill the worker will never come back and verify.
 */
function scheduleBasisState(open: readonly TradePositionView[], holding: Schedule["holding"], nowMs: number): "skeleton" | "stale" | "ready" {
  const holdingPending = holding.quoteWei === null && (holding.quoteReason === null || holding.quoteReason === undefined);
  const unverified = open.filter((position) => position.fillStatus !== "verified");
  if (holdingPending || unverified.some((position) => nowMs - position.openedAt <= UNVERIFIED_STALE_MS)) return "skeleton";
  return unverified.length > 0 ? "stale" : "ready";
}

/** Same 15-minute rule, applied to one row's own fill price cell. */
function positionBasisState(position: TradePositionView, nowMs: number): "skeleton" | "stale" | "ready" {
  if (position.fillStatus === "verified") return "ready";
  return nowMs - position.openedAt <= UNVERIFIED_STALE_MS ? "skeleton" : "stale";
}

function ScheduleSegmentBar({ fills, planned }: { readonly fills: number; readonly planned: number }) {
  if (planned <= 0) return <div style={{ height: 10, borderRadius: 2, background: "var(--raised-3)" }} />;
  // Operator ruling: one segment per buy up to 40 planned buys; past that, one continuous bar.
  if (planned <= 40) {
    return <div style={{ display: "flex", gap: 3, height: 10 }}>
      {Array.from({ length: planned }, (_, index) => (
        <i key={index} style={{ flex: 1, borderRadius: 2, background: index < fills ? "var(--brand)" : "var(--raised-3)" }} />
      ))}
    </div>;
  }
  const pct = Math.max(0, Math.min(100, (fills / planned) * 100));
  return <div style={{ height: 10, borderRadius: 2, background: "var(--raised-3)", overflow: "hidden" }}>
    <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: "var(--brand)" }} />
  </div>;
}

function ScheduleProgressCard({ schedule, settings, nowMs, label }: { readonly schedule: Schedule; readonly settings: ScheduleSettings; readonly nowMs: number; readonly label?: string }) {
  const totalWei = (BigInt(schedule.spentWei) + BigInt(schedule.remainingWei)).toString(10);
  const nextBuy = schedule.finished !== null ? { value: scheduleFinishedLabel(schedule.finished), note: "idle · no worker calls" } : scheduleCountdown(schedule, nowMs);
  return (
    <section className="fl-trade-table" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.9fr) minmax(240px,0.9fr)", marginBottom: 18 }} data-testid="schedule-progress-card">
      <div style={{ padding: "20px 24px 22px", display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span style={{ font: "var(--weight-semibold) var(--text-3xl)/1 var(--font-mono)", color: "var(--ink-1)" }}>{usdt2Plain(schedule.spentWei)}</span>
          <span style={{ font: "var(--weight-regular) var(--text-lg)/1 var(--font-mono)", color: "var(--text-subtle)" }}>/ {usdt2(totalWei)} spent</span>
          <span style={{ ...MONO, marginLeft: "auto" }}>{usdt2(schedule.amountWei)} PER BUY · {scheduleFrequencyLabel(schedule.intervalSec)} · {scheduleEndRuleLabel(schedule)}</span>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <ScheduleSegmentBar fills={schedule.fills} planned={schedule.plannedBuys} />
          <div style={{ display: "flex", justifyContent: "space-between", ...MONO }}>
            <span>{schedule.fills} OF {schedule.plannedBuys} BUYS DONE</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", paddingTop: 14, borderTop: "1px solid var(--line-1)" }}>
          {label === undefined ? null : <span style={MONO} data-testid="schedule-progress-label">{label.toUpperCase()}</span>}
          <span style={{ ...MONO, marginLeft: "auto" }}>REMAINING {usdt2(schedule.remainingWei)}</span>
        </div>
      </div>
      <div style={{ borderLeft: "1px solid var(--line-1)", background: "var(--surface-sunken)", display: "grid", alignContent: "start" }}>
        <div style={{ padding: "20px 24px 16px", display: "grid", gap: 8 }}>
          <span style={KICKER}>Next buy</span>
          <strong style={{ font: "var(--weight-semibold) var(--text-2xl)/1 var(--font-mono)", color: "var(--ink-1)" }}>{nextBuy.value}</strong>
          {nextBuy.note === undefined ? null : <span style={MONO}>{nextBuy.note.toUpperCase()}</span>}
        </div>
        <div style={{ padding: "14px 24px 18px", borderTop: "1px solid var(--line-1)", display: "grid", gap: 7 }}>
          <span style={KICKER}>Execution model</span>
          <strong style={{ font: "var(--weight-medium) var(--text-lg)/1.2 var(--font-mono)", color: "var(--ink-1)" }}>TradFi · Schedule Buy</strong>
        </div>
      </div>
    </section>
  );
}

function ScheduleMetric({ label, value, note, tone = "normal", skeleton = false }: {
  readonly label: string; readonly value: string; readonly note?: string; readonly tone?: "normal" | "profit" | "loss"; readonly skeleton?: boolean;
}) {
  return <div className="fl-trade-metric">
    <span className="fl-trade-kicker">{label}</span>
    {skeleton ? <Skeleton w={88} h={22} style={{ display: "inline-block" }} /> : <strong className={`fl-trade-metric__value fl-trade-metric__value--${tone}`}>{value}</strong>}
    {!skeleton && note ? <span className="fl-trade-metric__note" style={tone === "normal" ? undefined : { color: tone === "profit" ? "var(--profit)" : "var(--loss)" }}>{note}</span> : null}
  </div>;
}

function ScheduleMetricRow({ schedule, settings, open, nowMs }: {
  readonly schedule: Schedule; readonly settings: ScheduleSettings; readonly open: readonly TradePositionView[]; readonly nowMs: number;
}) {
  const holding = schedule.holding;
  const basisState = scheduleBasisState(open, holding, nowMs);
  const basisSkeleton = basisState === "skeleton";

  let pnlValue = "—", pnlNote: string | undefined, pnlTone: "normal" | "profit" | "loss" = "normal";
  let avgValue = "—";
  if (basisState === "stale") {
    pnlNote = "basis not verified";
  } else if (basisState === "ready") {
    if (holding.quoteWei === null) {
      pnlNote = quoteDashReason(holding.quoteReason);
    } else {
      const pnlWei = BigInt(holding.quoteWei) - BigInt(holding.verifiedSpentWei);
      pnlValue = usdt2(pnlWei.toString(10), true);
      pnlTone = pnlWei > 0n ? "profit" : pnlWei < 0n ? "loss" : "normal";
      if (settings.capitalQuoteWei !== undefined && BigInt(settings.capitalQuoteWei) > 0n) {
        const percentBps = Number((pnlWei * 10_000n) / BigInt(settings.capitalQuoteWei));
        pnlNote = bpsPercent(percentBps, true);
      }
    }
    avgValue = holding.boughtAtomic === "0" || schedule.decimals === null
      ? "—"
      : usdt2((BigInt(holding.verifiedSpentWei) * 10n ** BigInt(schedule.decimals) / BigInt(holding.boughtAtomic)).toString(10));
  }

  const marketReason = quoteDashReason(holding.quoteReason);
  const marketValue = holding.quoteWei !== null && holding.walletBalance !== "0"
    ? usdt2((BigInt(holding.quoteWei) * 10n ** 18n / BigInt(holding.walletBalance)).toString(10))
    : "—";

  return <div className="fl-trade-metrics" data-testid="schedule-metric-row">
    <ScheduleMetric label="Delegated" value={settings.capitalQuoteWei === undefined ? "—" : usdt2(settings.capitalQuoteWei)} />
    <ScheduleMetric label="Holdings" value={`${formatTokenAmount(holding.walletBalance, schedule.decimals)} ${schedule.symbol}`}
      note={holding.quoteWei !== null ? `≈ ${usdt2(holding.quoteWei)}` : quoteDashReason(holding.quoteReason)} />
    <ScheduleMetric label="PnL since hire" value={pnlValue} tone={pnlTone} note={pnlNote} skeleton={basisSkeleton} />
    <ScheduleMetric label="Average price" value={avgValue} skeleton={basisSkeleton} />
    <ScheduleMetric label="Market price" value={marketValue} note={marketValue === "—" ? marketReason : undefined} />
  </div>;
}

function SchedulePricePanel({ schedule, settings, open, averagePriceValue }: {
  readonly schedule: Schedule; readonly settings: ScheduleSettings; readonly open: readonly TradePositionView[]; readonly averagePriceValue: string;
}) {
  const markers: readonly MarketChartMarker[] = open.map((position) => ({ timestamp: position.openedAt, side: "buy" as const, text: "B" }));
  const premiumText = schedule.premiumBps === undefined || schedule.premiumBps === null ? "premium unavailable" : bpsPercent(schedule.premiumBps, true);
  const premiumLimitBps = schedule.premiumLimitBps ?? schedule.maxPremiumBps;
  return (
    <section className="fl-trade-table" style={{ marginBottom: 16 }} data-testid="schedule-price-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{schedule.symbol} / USDT venue price</span>
      </div>
      <div style={{ padding: "14px 16px 12px" }}>
        <MarketChart kind="token" address={schedule.token} title={`${schedule.symbol} / USDT`} markers={markers} embedded height={230} defaultInterval="15m" />
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line-1)", ...MONO }}>
          <span>AVERAGE PRICE PAID {averagePriceValue}</span>
          <span>NAV PREMIUM {premiumText}</span>
          <span>PREMIUM LIMIT {bpsPercent(premiumLimitBps)}</span>
          {settings.scheduleMarketHoursOnly === true ? <span>MARKET HOURS ONLY</span> : null}
        </div>
      </div>
    </section>
  );
}

function ScheduleBuyRow({ schedule, position, cycle, icon, nowMs }: { readonly schedule: Schedule; readonly position: TradePositionView; readonly cycle: number; readonly icon: string | null; readonly nowMs: number }) {
  const state = positionBasisState(position, nowMs);
  const sizeSpent = position.fillStatus === "verified" && position.verifiedEntryAtomic !== null && position.verifiedEntryAtomic !== undefined
    ? usdt2(position.verifiedEntryAtomic) : `≈ ${usdt2(position.entryWei)}`;
  let fillPrice: React.ReactNode = "—";
  if (state === "skeleton") fillPrice = <Skeleton w={64} h={16} />;
  else if (state === "ready" && position.tokenAmount !== null && position.tokenAmount !== "0" && schedule.decimals !== null
    && position.verifiedEntryAtomic !== null && position.verifiedEntryAtomic !== undefined) {
    fillPrice = usdt2((BigInt(position.verifiedEntryAtomic) * 10n ** BigInt(schedule.decimals) / BigInt(position.tokenAmount)).toString(10));
  }
  const link = txUrl(position.entryTxHash);
  return <div className="fl-row" style={{ gridTemplateColumns: SCHEDULE_BUY_COLS, alignItems: "center" }}>
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>{cycle} <span style={{ color: "var(--text-subtle)" }}>/ {schedule.plannedBuys}</span></span>
    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <TokenIcon src={icon} symbol={schedule.symbol} size={26} />
      <span style={{ display: "grid", gap: 4 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{schedule.symbol} / USDT</span>
        <span style={MONO}>{compactAddress(position.token)}</span>
      </span>
    </span>
    <span style={{ display: "grid", gap: 4 }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{formatDateTime(position.openedAt)}</span>
      <span style={MONO}>{formatRemaining(Math.max(0, nowMs - position.openedAt))} AGO</span>
    </span>
    <span style={{ display: "grid", gap: 4 }}>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>{formatTokenAmount(position.tokenAmount, schedule.decimals)} <span style={{ color: "var(--text-subtle)" }}>{schedule.symbol}</span></span>
      <span style={MONO}>{sizeSpent}</span>
    </span>
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>{fillPrice}</span>
    <span style={{ justifySelf: "end" }}>{link === null ? <span style={{ color: "var(--text-subtle)" }}>—</span> : <a href={link} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-muted)", font: "var(--type-body-xs, var(--type-mono-xs))" }}>Tx <Icon name="external" size={11} /></a>}</span>
  </div>;
}

const SCHEDULE_BUY_COLS = "68px minmax(0,1.15fr) minmax(0,1.15fr) minmax(0,1.05fr) minmax(0,1fr) 92px";

function ScheduleBuysTable({ schedule, open, icon, nowMs, refresh }: {
  readonly schedule: Schedule; readonly open: readonly TradePositionView[]; readonly icon: string | null; readonly nowMs: number; readonly refresh: () => Promise<unknown>;
}) {
  // Cycle = the fill's order (1 = first buy), so postponed slots leave no gaps.
  const rows = [...open].sort((a, b) => b.openedAt - a.openedAt);
  return <section className="fl-trade-table" data-testid="schedule-buys-table">
    <div className="fl-trade-table__bar"><span>Buys</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void refresh()}>Refresh</Button></div>
    <div className="fl-row__head" style={{ gridTemplateColumns: SCHEDULE_BUY_COLS, alignItems: "center" }}>
      <span>Cycle</span><span>Token</span><span>Time</span><span>Size</span><span>Fill price</span><span style={{ justifySelf: "end" }}>Tx</span>
    </div>
    {rows.map((position, index) => <ScheduleBuyRow key={position.positionId} schedule={schedule} position={position} cycle={rows.length - index} icon={icon} nowMs={nowMs} />)}
    {rows.length === 0 ? <div className="fl-trade-empty">No buys yet.</div> : null}
  </section>;
}

/**
 * ROADMAP debt 2026-09-25: an amount per buy above the hire's granted per-buy
 * ceiling is accepted by the settings route, then every buy is refused
 * (`USDT_ENTRY_BOUNDS`). Say so here instead of letting the schedule stall silently.
 */
function scheduleAmountAboveGrant(settings: ScheduleSettings, hiredEntryWei: string | undefined): bigint | null {
  if (hiredEntryWei === undefined || !/^\d+$/u.test(hiredEntryWei) || !/^\d+$/u.test(settings.entryWei)) return null;
  const granted = BigInt(hiredEntryWei);
  return granted > 0n && BigInt(settings.entryWei) > granted ? granted : null;
}

/** What the owner can do once the schedule is finished; the worker makes no calls for it until an edit reopens it. */
function scheduleFinishedNextSteps(schedule: Schedule, readOnly: boolean): string {
  // An Agentic Wallet hire has no owner action: the stock and any leftover USDT are already the owner's, in the Binance App.
  if (readOnly) return `The agent is idle and makes no calls. Your ${schedule.symbol} and any leftover USDT stay in your Agentic Wallet; sell them in the Binance App.`;
  const holdings = `Your ${schedule.symbol} and any leftover USDT stay in the agent wallet; withdraw them from Account with your passkey. Remove revokes the session key and sells nothing.`;
  if (schedule.finished === "budget") {
    return `The agent is idle and makes no calls. The total budget is fixed at hire, so buying more needs a new Schedule hire. ${holdings}`;
  }
  const reopen = schedule.finished === "runs" ? "Edit the number of runs" : "Edit the end date";
  return `The agent is idle and makes no calls. ${reopen} to resume buying on the next cycle while budget remains. ${holdings}`;
}

function ScheduleNotices({ schedule, settings, hiredEntryWei, readOnly }: { readonly schedule: Schedule; readonly settings: ScheduleSettings; readonly hiredEntryWei?: string; readonly readOnly: boolean }) {
  const granted = schedule.finished === null && !readOnly ? scheduleAmountAboveGrant(settings, hiredEntryWei) : null;
  return <>
    {granted === null ? null : <div className="fl-trade-message fl-trade-message--warning" role="alert" style={{ margin: "0 0 16px" }} data-testid="schedule-amount-above-grant">
      <span>Amount per buy {usdt2(settings.entryWei)} is above the {usdt2(granted.toString(10))} this hire's session allows, so every buy is refused. Set it back to {usdt2(granted.toString(10))} or less, or renew / re-hire for a larger amount.</span>
    </div>}
    {schedule.finished === null ? null : <div className="fl-trade-message" role="status" style={{ margin: "0 0 16px" }} data-testid="schedule-finished-next">
      <span>{scheduleFinishedNextSteps(schedule, readOnly)}</span>
    </div>}
  </>;
}

/** Always-visible top of the schedule page: the progress card and the five-tile metric row. Rendered whether or not the owner is editing, mirroring the mock-up. */
export function ScheduleSummary({ schedule, settings, open, hiredEntryWei, readOnly = false, label }: {
  /** Optional footer text on the progress card's left; the Agentic page names the mode there. */
  readonly label?: string;
  readonly schedule: Schedule;
  readonly settings: ScheduleSettings;
  readonly open: readonly TradePositionView[];
  readonly hiredEntryWei?: string;
  /** The Agentic public page: no owner action exists, so the notices that point at one are not shown. */
  readonly readOnly?: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNowMs(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  return <>
    <ScheduleNotices schedule={schedule} settings={settings} readOnly={readOnly} {...(hiredEntryWei === undefined ? {} : { hiredEntryWei })} />
    <ScheduleProgressCard schedule={schedule} settings={settings} nowMs={nowMs} {...(label === undefined ? {} : { label })} />
    <ScheduleMetricRow schedule={schedule} settings={settings} open={open} nowMs={nowMs} />
  </>;
}

/** The Buys / Run log toggle and its panel, shown only while the owner is not editing. */
export function ScheduleTabs({ schedule, settings, trade, refresh, simulationLog, earnTab }: {
  readonly schedule: Schedule;
  readonly settings: ScheduleSettings;
  readonly trade: Pick<TradeView, "open" | "runs">;
  readonly refresh: () => Promise<unknown>;
  /** The read-only pre-flight simulation log; shown inside the Run log tab (Runs | Simulate toggle) only when supplied. */
  readonly simulationLog?: React.ReactNode;
  /** The Agentic public page. Nothing in the tabs is an owner action, so this changes no output; it keeps one contract with ScheduleSummary. */
  readonly readOnly?: boolean;
  /** The Agentic public page of an earn hire: when given, the toggle gains an Earn tab showing this node. Absent, nothing changes. */
  readonly earnTab?: React.ReactNode;
}) {
  const [tab, setTab] = useState<"Buys" | "Run log" | "Earn">("Buys");
  const [showChart, setShowChart] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNowMs(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const icons = useTokenIcons([schedule.token]);
  const icon = icons[schedule.token.toLowerCase()] ?? null;

  const basisState = scheduleBasisState(trade.open, schedule.holding, nowMs);
  const averagePriceValue = basisState !== "ready" || schedule.holding.boughtAtomic === "0" || schedule.decimals === null
    ? "—"
    : usdt2((BigInt(schedule.holding.verifiedSpentWei) * 10n ** BigInt(schedule.decimals) / BigInt(schedule.holding.boughtAtomic)).toString(10));

  return <>
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
      <SegmentedToggle value={tab} onChange={(next: string) => setTab(next === "Run log" || next === "Earn" && earnTab !== undefined ? next : "Buys")} options={earnTab === undefined ? ["Buys", "Run log"] : ["Buys", "Run log", "Earn"]} />
    </div>
    {tab === "Earn" && earnTab !== undefined ? earnTab : tab === "Buys" ? <>
      <div style={{ display: "flex", marginBottom: 12 }}>
        <Button variant="ghost" size="sm" icon={<Icon name="yield" size={14} />} onClick={() => setShowChart((value) => !value)}
          style={showChart ? { background: "var(--cat-yield-tint)", color: "var(--cat-yield)", border: "1px solid var(--cat-yield)" } : undefined}>
          {showChart ? "Hide chart" : "Show chart"}
        </Button>
      </div>
      {showChart ? <SchedulePricePanel schedule={schedule} settings={settings} open={trade.open} averagePriceValue={averagePriceValue} /> : null}
      <ScheduleBuysTable schedule={schedule} open={trade.open} icon={icon} nowMs={nowMs} refresh={refresh} />
    </> : <RunLogPanel simulationLog={simulationLog} runLog={<section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void refresh()}>Refresh</Button></div>
      <TradeRunLog runs={trade.runs} symbols={{ [schedule.token.toLowerCase()]: schedule.symbol }} schedule /></section>} />}
  </>;
}

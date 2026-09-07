"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lpWithdrawOutcome } from "@/lib/lp/withdraw";
import { formatEther, isHex, size } from "viem";
import { ActivityRow, Button, Category, ChartFrame, Icon, MetricTile, Num, SegmentedToggle, StatusBadge } from "@/design-system";
import { MarketChart, type MarketChartMarker } from "@/components/MarketChart";
import { CHART_INTERVALS, emptyRungPairs, liveRungValueWei, relativeTime, rungFillTick, rungHoldsWbnb, shiftFills, type AgentDetailView, type ChartInterval, type DetailMetric, type DetailMotion, type OhlcvResult } from "@/lib/exec/agent-detail";
import { REVIEWED_MAJORS_56, formatAtomic, midpointWbnbUsdtPrice, rangePrices, reviewedPair, type ReviewedPair, priceAtTick } from "@/lib/exec/pairs";
import { gridModelLabel } from "@/lib/grid/economics";
import { useAgentDetail, type ChartUnit, type UseAgentDetailResult } from "@/lib/exec/use-agent-detail";
import { useMockAgentDetail } from "@/lib/mock/use-mock-agent-detail";
import { usePublicClient } from "wagmi";
import { NFPM_56 } from "@/lib/exec/pairs";
import { listWalletPositionIds, readOnChainPosition, readWalletLegBalances, type OnChainPosition, type OnChainPositionRead } from "@/lib/altana/position-reader";
import type { DustRead } from "@/lib/lp/dust";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import type { TradeSettings } from "@/lib/trade";
import { TradeAgentDetail } from "@/components/trade/TradeAgentDetail";
import { LpAgentDetail } from "@/components/agent/LpAgentDetail";
import { LendingAgentDetail } from "@/components/agent/LendingAgentDetail";
import { Erc8004IdentityStatus } from "@/components/agent/Erc8004IdentityStatus";
import {
  EMPTY_REMOVE_PROGRESS,
  advanceRemoveAttempt,
  finalizedAtOrAfter,
  hasFreshRevocationProof,
  newRemoveAttempt,
  nextRemoveStep,
  mayBeginRemoveAttempt,
  parseLegacyRemoveProgress,
  parseRemoveAttempt,
  removeAttemptBindings,
  type FinalizedSessionRevocation,
  type RemoveAttemptBindings,
  type RemoveAttemptExpectation,
  type RemoveAttemptSlot,
  type RemoveAttemptV2,
  type RemoveProgress,
  type RemoveSnapshot,
  type SessionRegistration,
} from "@/lib/exec/remove-agent";
import { PairIcons, TokenIcon } from "@/components/TokenIcon";
import { HireRecoveryActions } from "@/components/deploy/HireRecoveryActions";

type Props = { readonly agentId: string; readonly go: (route: string) => void };
type Tab = "Overview" | "Run log";
type Fill = { readonly motion: DetailMotion; readonly side: "buy" | "sell" };

const TICK_ASK = "var(--warn)", TICK_BID = "var(--cat-grid)";
const LP_HIRE_STORAGE_KEY = "4lpha:lp-hire:v1";
const LENDING_HIRE_STORAGE_KEY = "4lpha:lending-hire:v1";
const DESIGN_NEUTRAL_BAR_HEIGHTS = [38, 46, 42, 54, 50, 62, 58, 74, 66, 82, 96, 98, 90, 114, 96, 106, 94, 86, 96, 102, 78, 70, 62, 54, 58, 50, 46, 42, 38, 34] as const;

function Panel({ title, right, children, pad = 0, className = "" }: { readonly title?: React.ReactNode; readonly right?: React.ReactNode; readonly children: React.ReactNode; readonly pad?: number; readonly className?: string }) {
  return (
    <section className={className} style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "hidden" }}>
      {title ? (
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-1)" }}>
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{title}</span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>{right}</span>
        </header>
      ) : null}
      <div style={{ padding: pad }}>{children}</div>
    </section>
  );
}

function metricValue(metric: DetailMetric | null | undefined): string {
  return metric?.value ?? "—";
}

function fixedSix(value: string | null | undefined, unit: "BNB" | "WBNB"): bigint | null {
  if (value === null || value === undefined) return null;
  const match = new RegExp(`^([+-]?)([0-9]+)(?:\\.([0-9]+))? ${unit}(?: |$)`, "u").exec(value);
  if (match === null) return null;
  const fraction = (match[3] ?? "").slice(0, 6).padEnd(6, "0");
  const magnitude = BigInt(match[2] ?? "0") * 1_000_000n + BigInt(fraction || "0");
  return match[1] === "-" ? -magnitude : magnitude;
}

function signedMetric(metric: DetailMetric | null | undefined): string {
  const value = metric?.value;
  const amount = fixedSix(value, "WBNB");
  if (value === null || value === undefined || amount === null) return "—";
  return amount > 0n && !value.startsWith("+") ? `+${value}` : value;
}

/**
 * The reason a metric is empty, as tile footnote text — without the leading em
 * dash the mapper puts there for inline use, since the tile already shows one.
 */
function emptyNote(metric: DetailMetric | null | undefined): string | undefined {
  if (metric === null || metric === undefined || metric.value !== null) return undefined;
  const reason = metric.reason;
  if (reason === null || reason === undefined || reason.length === 0) return undefined;
  // Internal wording the owner cannot act on, and which the operator asked not
  // to see: the level rows are on the same screen already.
  if (reason.includes("no agent-wide total")) return undefined;
  return reason.replace(/^—\s*/u, "");
}

/**
 * What the grid DOES, for the tile label. The plane's mode word is the
 * machinery (`shift` = PHASE3.22/3.25 atomic pair); with the drift lane signed
 * off (`driftPctOfGap: 0`) the only motion left is the cross a fill causes —
 * the flip. `shift` is shown exactly when drift is on, because then it is true.
 */
export function modeLabel(view: AgentDetailView | null | undefined): string {
  const grid = view?.grid;
  if (grid === undefined || grid.mode === "fixed") return grid === undefined ? "" : " · flip";
  if (grid.mode === "shift") return grid.driftPctOfGap === 0 ? " · flip" : grid.driftPctOfGap === null ? " · shift" : " · shift + drift";
  return ` · ${grid.mode}`;
}

function metricTone(value: string): "profit" | "loss" | "flat" {
  if (value.startsWith("-")) return "loss";
  if (value === "—" || /^0(?:\.0+)?(?:\s|%|$)/u.test(value)) return "flat";
  return "profit";
}

function pnlPercent(delta: DetailMetric | null | undefined, delegated: DetailMetric | null | undefined): string {
  const deltaValue = fixedSix(delta?.value, "WBNB");
  const delegatedValue = fixedSix(delegated?.value, "BNB");
  if (deltaValue === null || delegatedValue === null || delegatedValue <= 0n) return "—";
  const magnitude = deltaValue < 0n ? -deltaValue : deltaValue;
  const hundredths = (magnitude * 10_000n + delegatedValue / 2n) / delegatedValue;
  const sign = deltaValue < 0n ? "-" : deltaValue > 0n ? "+" : "";
  return `${sign}${hundredths / 100n}.${(hundredths % 100n).toString(10).padStart(2, "0")}%`;
}

/**
 * The pair comes from the VIEW, which already resolved it — from the majors
 * table or from data-plane metadata. Re-deriving it here through the majors
 * table alone is what dashed every price on a four.meme pair whose legs the
 * mapper had resolved perfectly well.
 */
function pairContext(view: AgentDetailView | null | undefined): { readonly pair: ReviewedPair; readonly quote: string; readonly base: string } | null {
  if (view === null || view === undefined || view.grid.base === null || view.grid.quote === null) return null;
  const { symbol0, symbol1, decimals0, decimals1 } = view.grid;
  if (symbol0 === null || symbol1 === null || decimals0 === null || decimals1 === null) return null;
  return {
    pair: {
      chainId: 56,
      token0: view.grid.token0,
      token1: view.grid.token1,
      symbol0,
      symbol1,
      decimals0,
      decimals1,
      wbnbIsToken0: view.grid.wbnbIsToken0,
    },
    quote: view.grid.quote,
    base: view.grid.base,
  };
}

/**
 * The price a rung fills at: an ask completes at the TOP of its range, a bid at
 * the BOTTOM — the two numbers PancakeSwap shows for the same position.
 */
function rangePrice(view: AgentDetailView | null, role: "bid" | "ask"): string | null {
  if (view === null) return null;
  const prices = role === "bid" ? view.grid.buyPrices : view.grid.sellPrices;
  if (prices === null) return null;
  return role === "bid" ? prices.low : prices.high;
}

/**
 * The leg a rung holds, in its own asset: "191.1 mubarak" for an ask, "0.0105
 * WBNB" for a bid. Decimals from the resolved pair; a pair the page cannot
 * resolve still shows the WBNB leg, which is always 18-decimal.
 */
function heldLegText(nft: OnChainPosition, holdsWbnb: boolean, wbnbIsToken0: boolean, context: ReturnType<typeof pairContext>): string | null {
  const wbnbLeg = wbnbIsToken0 ? nft.amounts.amount0 : nft.amounts.amount1;
  const baseLeg = wbnbIsToken0 ? nft.amounts.amount1 : nft.amounts.amount0;
  if (holdsWbnb) {
    const text = formatAtomic(wbnbLeg.toString(10), 18, 6);
    return text === null ? null : `${text} WBNB`;
  }
  if (context === null) return null;
  const decimals = wbnbIsToken0 ? context.pair.decimals1 : context.pair.decimals0;
  const text = formatAtomic(baseLeg.toString(10), decimals, 3);
  return text === null ? null : `${text} ${context.base}`;
}

function observedPrice(view: AgentDetailView | null, tick: number | null): string | null {
  const context = pairContext(view);
  if (view === null || context === null || tick === null || tick <= -887_272 || tick >= 887_272) return null;
  if (tick === view.grid.observedTick && view.grid.observedPrice !== null) return view.grid.observedPrice;
  return priceAtTick(tick, context.pair);
}

function midpointTick(lower: number, upper: number): string {
  const twice = lower + upper;
  return twice % 2 === 0 ? String(twice / 2) : `${twice < 0 ? "-" : ""}${Math.floor(Math.abs(twice) / 2)}.5`;
}

function displayPrice(value: string | null, quote: string | null): string {
  if (value === null) return "—";
  return quote === "USDT" || quote === "USDC" ? `$${value}` : value;
}

/**
 * The pool OHLCV feed prices the BASE token in USD — measured: BTCB/WBNB closes
 * near 77,100, not near 112 — so this chart is a USD chart and says so. A rung
 * quoted in WBNB is converted before it is drawn on the same axis.
 */
function chartPrice(candles: OhlcvResult["candles"]): string {
  const close = candles.at(-1)?.close;
  if (close === undefined) return "—";
  return `${close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function rungUsd(view: AgentDetailView | null, role: "bid" | "ask"): number | null {
  const price = rangePrice(view, role);
  const quoteUsd = view?.grid.quoteUsd ?? null;
  if (price === null || quoteUsd === null) return null;
  const value = Number(price) * quoteUsd;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// The rungs are signed in the quote asset, so the quote view draws them exactly
// and only the USD view has to convert.
function rungOnChart(view: AgentDetailView | null, role: "bid" | "ask", unit: ChartUnit): number | null {
  if (unit === "usd") return rungUsd(view, role);
  const price = rangePrice(view, role);
  if (price === null) return null;
  const value = Number(price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function chartAxis(candles: OhlcvResult["candles"]): readonly string[] {
  if (candles.length === 0) return ["—", "—", "—", "—"];
  const indexes = [0, Math.floor((candles.length - 1) / 3), Math.floor(((candles.length - 1) * 2) / 3), candles.length - 1];
  return indexes.map((index) => new Date(candles[index]?.timestamp ?? 0).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));
}

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function fills(view: AgentDetailView | null): readonly Fill[] {
  return view?.motions.flatMap((motion) => motion.classification !== "settlement" ? [] : [{
    motion,
    side: motion.label === "Buy rung filled" ? "buy" as const : "sell" as const,
  }]) ?? [];
}

function collected(fill: Fill, view: AgentDetailView | null): string {
  const context = pairContext(view);
  const symbol = fill.side === "buy" ? "WBNB" : context?.quote;
  if (symbol === undefined) return "—";
  return fill.motion.collected.split(" + ").find((part) => part.endsWith(` ${symbol}`)) ?? `— ${symbol}`;
}

function fillPrice(fill: Fill, view: AgentDetailView | null): string {
  const context = pairContext(view);
  const price = fill.motion.price.value?.split(" ")[0] ?? "—";
  return `${price} ${context?.quote ?? "—"}`;
}

function chartMarkers(rows: OhlcvResult["candles"], rowsWithFills: readonly Fill[]): readonly MarketChartMarker[] {
  if (rows.length === 0) return [];
  return rowsWithFills.flatMap((fill) => {
    const completedAt = Date.parse(fill.motion.timeTitle);
    if (!Number.isSafeInteger(completedAt)) return [];
    const nearest = rows.reduce((best, row) => Math.abs(row.timestamp - completedAt) < Math.abs(best.timestamp - completedAt) ? row : best, rows[0]!);
    return [{ timestamp: nearest.timestamp, side: fill.side }];
  }).sort((a, b) => a.timestamp - b.timestamp);
}

function responseWarning(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = (payload as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const revoke = (data as { readonly onChainRevoke?: unknown }).onChainRevoke;
  if (typeof revoke !== "object" || revoke === null) return undefined;
  const note = (revoke as { readonly note?: unknown }).note;
  return typeof note === "string" && note.length > 0 ? note : undefined;
}

function loadLegacyProgress(key: string): RemoveProgress {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return EMPTY_REMOVE_PROGRESS;
    return parseLegacyRemoveProgress(JSON.parse(raw) as unknown);
  } catch {
    return { legacyRevokeUnknown: true };
  }
}

function loadAttemptSlot(key: string, bindings: RemoveAttemptBindings): RemoveAttemptSlot {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { kind: "missing" };
    const attempt = parseRemoveAttempt(JSON.parse(raw) as unknown, bindings);
    return attempt === null ? { kind: "invalid" } : { kind: "valid", attempt };
  } catch {
    return { kind: "invalid" };
  }
}

type RemoveStorageCheckpoint = {
  readonly attemptKey: string;
  readonly attemptRaw: string | null;
  readonly legacyRaw: string | null;
};

function readRemoveStorage(
  attemptKey: string,
  legacyKey: string,
  bindings: RemoveAttemptBindings,
): { readonly progress: RemoveProgress; readonly checkpoint: RemoveStorageCheckpoint } {
  const attemptRaw = window.localStorage.getItem(attemptKey);
  const legacyRaw = window.localStorage.getItem(legacyKey);
  const legacy = loadLegacyProgress(legacyKey);
  const slot = loadAttemptSlot(attemptKey, bindings);
  return {
    progress: {
      ...legacy,
      ...(slot.kind === "valid" ? { revokeAttempt: slot.attempt } : {}),
      ...(slot.kind === "invalid" ? { legacyRevokeUnknown: true } : {}),
    },
    checkpoint: { attemptKey, attemptRaw, legacyRaw },
  };
}

async function withAttemptLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (navigator.locks === undefined) {
    throw new Error("Safe removal recovery needs browser lock support. Use the latest Chrome or Edge and try again.");
  }
  return navigator.locks.request(`4lpha:${key}`, { mode: "exclusive" }, task);
}

/** Bounds one click of Remove: pause + two exits + revoke + broadcast + verify is six; the rest is headroom for retries. */
const MAX_REMOVE_STEPS = 12;

function removeSnapshotOf(
  view: AgentDetailView | null,
  registration: SessionRegistration,
  finalizedSessionRevocation: FinalizedSessionRevocation,
): RemoveSnapshot {
  return {
    status: view?.status ?? "unavailable",
    positions: view?.positions.map((position) => ({ positionId: position.positionId, state: position.state })) ?? [],
    sequences: view?.sequences.map((sequence) => ({
      sequenceId: sequence.sequenceId,
      positionId: sequence.positionId,
      kind: sequence.kind,
      state: sequence.state,
      recoveryState: sequence.recoveryState,
      // Optional chain on purpose: older fixtures and a mapper that omits steps must block, not throw.
      steps: (sequence.steps ?? []).map((step) => ({ decisionId: step.decisionId, kind: step.kind, state: step.state })),
    })) ?? [],
    sessionRegistration: registration,
    finalizedSessionRevocation,
  };
}

function removeProgressText(decision: ReturnType<typeof nextRemoveStep>, step: number): string {
  const closed = decision.completedPositionIds.length;
  const total = closed + decision.remainingPositionIds.length;
  const prefix = `Removing (step ${step + 1})`;
  if (decision.kind === "exit") return `${prefix}: closing position ${closed + 1} of ${total}. Up to two relay submissions; this can take a few minutes.`;
  if (decision.kind === "pause") return `${prefix}: pausing automation.`;
  if (decision.kind === "local-revoke") return `${prefix}: revoking the agent on the plane.`;
  if (decision.kind === "broadcast-revoke") return `${prefix}: revoking the session key on chain — approve with your passkey.`;
  if (decision.kind === "check-revoke") return `${prefix}: checking relay status, BNB finality, and the KeyStore postcondition.`;
  if (decision.kind === "retry-revoke") return `${prefix}: retrying the on-chain session-key revoke — approve with your passkey.`;
  return decision.message;
}

function removeConfirmText(decision: ReturnType<typeof nextRemoveStep>): string {
  if (decision.kind === "retry-revoke") {
    return "The previous revoke may have failed or its outcome may be unknown. Retry on-chain revoke? You must approve with your passkey, and relay gas may be spent again.";
  }
  const open = decision.remainingPositionIds.length;
  return open === 0
    ? "Remove this agent? Its session key will be revoked on the plane and on chain."
    : `Remove this agent? ${open} open position${open === 1 ? "" : "s"} will be closed one after another, then the session key revoked on the plane and on chain. Proceeds come back as BNB plus the pool's quote asset.`;
}

function removeActionLabel(decision: ReturnType<typeof nextRemoveStep>, removed: boolean): string {
  if (removed) return "Removed";
  if (decision.kind === "check-revoke") return "Check removal";
  if (decision.kind === "retry-revoke") return "Retry on-chain revoke";
  return "Remove";
}

/** The table used to say "Open order" for every row, closed ones included. */
function positionStateLabel(state: string): string {
  if (state === "open") return "Open order";
  if (state === "closing") return "Closing";
  if (state === "closed") return "Closed";
  return state;
}

/** The plane answers refusals as { error: { code, message } }; show the sentence, not the status. */
async function refusalText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly error?: { readonly code?: unknown; readonly message?: unknown } };
    const message = body.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
    const code = body.error?.code;
    if (typeof code === "string" && code.length > 0) return `Action refused (${code}).`;
  } catch { /* not JSON */ }
  return `Action failed (${response.status}).`;
}

function resolutionSummary(payload: unknown): string {
  const data = (payload as { readonly data?: { readonly disposition?: { readonly action?: unknown; readonly summary?: unknown } } } | null)?.data;
  const action = data?.disposition?.action;
  const summary = data?.disposition?.summary;
  if (typeof action === "string") return `Resolved: ${action}${typeof summary === "string" ? ` — ${summary}` : ""}`;
  return "Resolve submitted; the plane recorded its disposition.";
}

function rungValue(view: AgentDetailView | null, role: "buy" | "sell"): string {
  const position = view?.positions.find((entry) => entry.role === role && entry.state !== "closed");
  return position === undefined ? "—" : metricValue(position.value);
}

function LiquidityTicks({ view }: { readonly view: AgentDetailView | null }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const context = pairContext(view);
  const observedTick = view?.grid.observedTick ?? null;
  const buyPrice = rangePrice(view, "bid");
  const sellPrice = rangePrice(view, "ask");
  const bar = (index: number): { readonly kind: "bid" | "active" | "ask" | "neutral"; readonly tick: string; readonly price: string } => {
    if (index === 10) return { kind: "bid", tick: view === null ? "—" : midpointTick(view.grid.buyRange.tickLower, view.grid.buyRange.tickUpper), price: displayPrice(buyPrice, context?.quote ?? null) };
    if (index === 14) return { kind: "active", tick: observedTick === null ? "—" : String(observedTick), price: displayPrice(observedPrice(view, observedTick), context?.quote ?? null) };
    if (index === 18) return { kind: "ask", tick: view === null ? "—" : midpointTick(view.grid.sellRange.tickLower, view.grid.sellRange.tickUpper), price: displayPrice(sellPrice, context?.quote ?? null) };
    const tick = observedTick === null || view === null ? null : observedTick + (index - 14) * view.grid.tickSpacing;
    return { kind: "neutral", tick: tick === null ? "—" : String(tick), price: displayPrice(observedPrice(view, tick), context?.quote ?? null) };
  };
  return (
    <div style={{ display: "grid", gap: 12, padding: 16, position: "relative" }}>
      {hover !== null ? (() => {
        const d = bar(hover);
        return (
          <div style={{ position: "absolute", left: `calc(${((hover + 0.5) / DESIGN_NEUTRAL_BAR_HEIGHTS.length) * 100}% - 96px)`, top: -6, zIndex: 5, width: 192, padding: "10px 12px", background: "var(--surface-card)", border: "1px solid var(--brand)", borderRadius: "var(--radius-sm)", display: "grid", gap: 5, pointerEvents: "none", boxShadow: "var(--shadow-2, 0 8px 24px rgb(0 0 0 / 0.45))" }}>
            {[["TICK", d.tick], ["PRICE", d.price], ["LIQUIDITY", "—"],
              ["YOUR LIQUIDITY", d.kind === "bid" ? rungValue(view, "buy") : d.kind === "ask" ? rungValue(view, "sell") : "—"]].map(([k, v]) => (
              <span key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.05em" }}>{k}</span>
                <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)" }}>{v}</span>
              </span>
            ))}
          </div>
        );
      })() : null}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 96 }} onMouseLeave={() => setHover(null)}>
        {DESIGN_NEUTRAL_BAR_HEIGHTS.map((height, i) => {
          const d = bar(i);
          const special = d.kind !== "neutral";
          const bg = d.kind === "bid" ? TICK_BID : d.kind === "ask" ? TICK_ASK : d.kind === "active" ? "var(--ink-2)" : "var(--raised-3)";
          return (
            <div key={i} onMouseEnter={() => setHover(i)} style={{ flex: 1, display: "grid", gap: 6, justifyItems: "center", cursor: "crosshair" }}>
              <div style={{ width: "100%", height: special ? 96 : height, background: bg, borderRadius: 2, outline: hover === i ? "1px solid var(--brand)" : "none", outlineOffset: 1 }} />
              {special ? <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", whiteSpace: "nowrap" }}>{d.price}</span> : null}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", paddingTop: 10, borderTop: "1px solid var(--line-1)", font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 8, height: 8, background: TICK_ASK, borderRadius: 1 }} />ASKS · SELL {context?.base ?? "—"}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 8, height: 8, background: TICK_BID, borderRadius: 1 }} />BIDS · BUY {context?.quote ?? "—"}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 8, height: 8, background: "var(--ink-2)", borderRadius: 1 }} />ACTIVE TICK</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 18, flexWrap: "wrap" }}>
          <span title={view?.grid.tickSource === "live" ? "Read straight from the pool by this page, independent of the worker" : view?.grid.tickSource === "worker" ? "The worker's last finalized observation" : undefined}>ACTIVE TICK {observedTick ?? "—"}{view?.grid.tickSource === "live" ? " · LIVE" : ""}</span><span>TICK SPACING {view?.grid.tickSpacing || "—"}</span><span>QUOTES {buyPrice ?? "—"} – {sellPrice ?? "—"} {context?.quote ?? "—"}</span><span>—</span><span>{view?.grid.liveRows ?? "—"} LIVE ORDERS</span>
        </span>
      </div>
    </div>
  );
}

function GridDetail({ detail, view, onChain, discovered, emptyRungs, busy, closePositionNow }: {
  readonly detail: UseAgentDetailResult;
  readonly view: AgentDetailView | null;
  /** What the chain says each NFT holds, so a row can contradict the plane. */
  readonly onChain: ReadonlyMap<string, OnChainPosition>;
  /** NFTs on this pool the wallet holds that the plane has not recorded yet. */
  readonly discovered: readonly OnChainPosition[];
  /** Emptied rungs the wallet still holds on this pool (prior pairs). */
  readonly emptyRungs: readonly OnChainPosition[];
  readonly busy: boolean;
  readonly closePositionNow: (position: OnChainPosition) => void;
}) {
  const [showCharts, setShowCharts] = React.useState(false);
  const candles = detail.market?.candles ?? [];
  // The tiles stay on the 1m USD series; the chart follows its own controls.
  const chartSeries = detail.chartCandles ?? candles;
  const context = pairContext(view);
  const icons = usePairIcons(view?.grid.token0, view?.grid.token1);
  const feed = React.useMemo<readonly Fill[]>(() => {
    const context = pairContext(view);
    const crosses = view === null ? [] : shiftFills({
      sequences: view.sequences,
      priorPairs: emptyRungPairs(emptyRungs, view.grid.wbnbIsToken0),
      wbnbIsToken0: view.grid.wbnbIsToken0,
      pair: context?.pair ?? null,
    }).map((fill): Fill => ({
      side: fill.side,
      motion: {
        sequenceId: fill.sequenceId,
        classification: "settlement",
        label: fill.side === "buy" ? "Buy rung filled" : "Sell rung filled",
        collected: "",
        price: { value: fill.price === null ? null : `${fill.price} ${context?.quote ?? ""}`, reason: fill.price === null ? "— price unavailable" : null },
        time: relativeTime(fill.atMs, Date.now()).text,
        timeTitle: new Date(fill.atMs).toISOString(),
        txHash: fill.txHash,
      },
    }));
    const known = new Set(crosses.map((fill) => fill.motion.sequenceId));
    return [...crosses, ...fills(view).filter((fill) => !known.has(fill.motion.sequenceId))]
      .sort((a, b) => b.motion.timeTitle.localeCompare(a.motion.timeTitle));
  }, [emptyRungs, view]);
  const markers = useMemo(() => chartMarkers(candles, feed), [candles, feed]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex" }}>
        <Button variant={showCharts ? "secondary" : "ghost"} size="sm" onClick={() => setShowCharts(!showCharts)} icon={<Icon name="grid-trading" size={14} />}>{showCharts ? "Hide charts" : "Show charts"}</Button>
      </div>
      {showCharts ? (<>
      <div className="fl-grid-detail-charts" style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(280px,1fr)", gap: 16, alignItems: "start" }}>
        <Panel title={`${view?.grid.pair ?? "—"} pool price`} right={<>
          <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" }}><i style={{ width: 8, height: 8, borderRadius: 999, background: TICK_BID }} />BUY FILL</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", letterSpacing: "0.04em" }}><i style={{ width: 8, height: 8, borderRadius: 999, background: TICK_ASK }} />SELL FILL</span>
          <SegmentedToggle options={CHART_INTERVALS.map((value) => ({ value, label: value }))} value={detail.chartInterval} onChange={(next: string) => detail.setChartInterval(next as ChartInterval)} />
          <SegmentedToggle options={[{ value: "usd", label: "USD" }, { value: "quote", label: view?.grid.quote ?? "QUOTE" }]} value={detail.chartUnit} onChange={(next: string) => detail.setChartUnit(next === "quote" ? "quote" : "usd")} />
        </>}>
          <div style={{ padding: "14px 16px 10px", display: "block" }}>
            {view?.grid.pool == null ? (
              <div style={{ height: 200, display: "grid", placeItems: "center", font: "var(--type-body-sm)", color: "var(--text-subtle)" }}>
                {detail.marketReason ?? "—"}
              </div>
            ) : (
            <MarketChart kind="pool" address={view.grid.pool} title={view.grid.pair} candles={detail.market === null && detail.chartCandles === null ? undefined : chartSeries} markers={markers} priceLines={[{ price: rungOnChart(view, "bid", detail.chartUnit), color: TICK_BID, title: "BID" }, { price: rungOnChart(view, "ask", detail.chartUnit), color: TICK_ASK, title: "ASK" }].flatMap((line) => line.price === null ? [] : [{ price: line.price, color: line.color, title: line.title }])} embedded height={200} />
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>
              {chartAxis(chartSeries).map((time, index) => <span key={index}>{time}</span>)}
            </div>
          </div>
        </Panel>
        <Panel title="Fill feed" right={<span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{view === null ? "—" : feed.length} FILLS</span>}>
          {/* Same height as the chart body beside it (14 + 200 + 8 + axis + 10); a
              longer feed scrolls inside rather than growing the row. */}
          <div style={{ display: "grid", alignContent: "start", maxHeight: 246, overflowY: "auto" }}>
            {feed.length === 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 4, padding: "11px 16px" }}>—</div>
            ) : feed.map((fill, i) => (
              <div key={fill.motion.sequenceId} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 4, padding: "11px 16px", borderBottom: i < feed.length - 1 ? "1px solid var(--line-1)" : "none" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: fill.side === "buy" ? TICK_BID : TICK_ASK, letterSpacing: "0.04em" }}>
                  <i style={{ width: 7, height: 7, borderRadius: 999, background: fill.side === "buy" ? TICK_BID : TICK_ASK }} />
                  {fill.side === "buy" ? "BID BUY" : "ASK SELL"} @ {fillPrice(fill, view)}
                </span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", textAlign: "right" }} title={fill.motion.timeTitle}>{fill.motion.time}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>{fill.side === "buy" ? `Bought ${pairContext(view)?.base ?? "base"} with WBNB` : `Sold ${context?.base ?? "base"} for WBNB`}</span>
                {fill.motion.txHash ? <a href={`https://bscscan.com/tx/${fill.motion.txHash}`} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 4, alignItems: "center", font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{short(fill.motion.txHash)}<Icon name="external" size={11} /></a> : <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>—</span>}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Liquidity" right={<><span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{view?.grid.pair ?? "—"} · PANCAKESWAP V3</span></>}>
        <LiquidityTicks view={view} />
      </Panel>
      </>) : null}

      <Panel className="fl-position-table">
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", height: 28 }}>
          {/* HOW OLD THE ROWS ARE. The view polls every 30s, but polling stops
              the moment the read session expires — and a frozen page that looks
              live is worse than no page. The age is stated, and a stopped poll
              says so in the loss colour instead of quietly aging. */}
          <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: detail.state === "ready" ? "var(--text-subtle)" : "var(--loss)" }}>
            {detail.state === "auth-expired" || detail.state === "signed-out"
              ? "NOT UPDATING · read session expired"
              : detail.asOfMs === null
                ? "—"
                : `Updated ${relativeTime(detail.asOfMs, Date.now()).text}`}
          </span>
          <Button variant="ghost" size="sm" style={{ marginLeft: "auto" }} icon={<Icon name="refresh" size={14} />} onClick={() => void detail.refresh()}>Refresh</Button>
        </div>
        <div className="fl-row__head" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto" }}>
          <span>Position</span><span>Age</span><span>Size</span><span>Side</span><span>Fees</span><span>Unrealised</span><span>Actions</span>
        </div>
        {(view?.positions ?? []).map((position) => {
          const liveOnChain = position.tokenId === null ? undefined : onChain.get(position.tokenId);
          // Price @ from the NFT's OWN range (the chain), not the plane's recorded
          // range for the role: after a re-quote the plane's range lags for
          // minutes. The filled edge is the range's far edge from the tick.
          const rowContext = pairContext(view);
          const liveRange = liveOnChain !== undefined && liveOnChain.liquidity > 0n && rowContext !== null && view?.grid.observedTick !== null && view !== null
            ? { fillTick: rungFillTick({ tickLower: liveOnChain.tickLower, tickUpper: liveOnChain.tickUpper, wbnbIsToken0: view.grid.wbnbIsToken0, holdsWbnb: rungHoldsWbnb({ tickLower: liveOnChain.tickLower, tickUpper: liveOnChain.tickUpper, amount0: liveOnChain.amounts.amount0, amount1: liveOnChain.amounts.amount1, tick: view.grid.observedTick, wbnbIsToken0: view.grid.wbnbIsToken0 }) }), lower: liveOnChain.tickLower, upper: liveOnChain.tickUpper }
            : null;
          const price = liveRange === null || rowContext === null
            ? position.rung?.fillPrice ?? null
            : priceAtTick(liveRange.fillTick, rowContext.pair);
          const band = liveRange !== null && rowContext !== null
            ? `${priceAtTick(liveRange.lower, rowContext.pair)} – ${priceAtTick(liveRange.upper, rowContext.pair)}`
            : position.rung === null ? null : `${position.rung.priceLow} – ${position.rung.priceHigh}`;
          // Size LIVE from the NFT itself: the two legs a full withdrawal would
          // return at the tick just read, priced in WBNB at the page's current
          // tick. The plane's valuation (worker, finalized) is the fallback, so
          // the cell is never a dash while the NFT is readable.
          // Size in the asset the rung HOLDS — an ask is so many base tokens
          // waiting to be sold, a bid so much WBNB waiting to buy — read from
          // the NFT's own legs. The plane's WBNB valuation is the fallback.
          const liveSize = liveOnChain !== undefined && liveOnChain.liquidity > 0n && position.state !== "closed" && view !== null
            ? heldLegText(liveOnChain, position.role !== "sell", view.grid.wbnbIsToken0, pairContext(view))
            : null;
          return (
            <div key={position.positionId} className="fl-row" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto", cursor: "default", alignItems: "center", ...(position.state === "closed" ? { opacity: 0.55 } : {}) }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <PairIcons
                  size={22}
                  token0={{ src: icons[view?.grid.token0?.toLowerCase() ?? ""] ?? null, symbol: context?.pair.symbol0 ?? null }}
                  token1={{ src: icons[view?.grid.token1?.toLowerCase() ?? ""] ?? null, symbol: context?.pair.symbol1 ?? null }}
                />
                <span style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{position.pair}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{position.tokenId === null ? "—" : short(position.tokenId)} · GRID ORDER</span>
                </span>
              </span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-muted)" }} title={position.ageTitle}>{position.age}</span>
              <span style={{ display: "grid", gap: 6 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} title={liveSize === null ? position.value.note : `Live from chain: NFT ${liveOnChain?.tokenId.toString(10) ?? ""} at tick ${view?.grid.observedTick ?? ""}`}>{liveSize ?? metricValue(position.value)}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }} title={band === null ? undefined : `rung ${band} ${context?.quote ?? ""}`}>Price @ {price ?? "—"} {context?.quote ?? "—"}</span>
              </span>
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 7, font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)", letterSpacing: "0.04em" }}>{sideIcon(view, icons, position.role)}{position.sideLabel ?? "—"}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: liveOnChain !== undefined && liveOnChain.liquidity > 0n && position.state === "closed" ? "var(--warning)" : "var(--text-subtle)" }}>{liveOnChain !== undefined && liveOnChain.liquidity > 0n && position.state === "closed" ? "Closed here, live on chain" : liveOnChain !== undefined && liveOnChain.liquidity === 0n && position.state !== "closed" ? "Filled · re-quoting" : positionStateLabel(position.state)}</span>
              </span>
              <Num value="—" tone="flat" size="sm" />
              <Num value={metricValue(position.unrealised)} tone={metricTone(metricValue(position.unrealised))} size="sm" />
              <span style={{ display: "flex", gap: 8 }}>
                {position.nftUrl ? <a href={position.nftUrl} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm" iconRight={<Icon name="external" size={13} />}>Tx</Button></a> : <span>—</span>}
                {liveOnChain !== undefined && liveOnChain.liquidity > 0n
                  ? <Button variant="danger" size="sm" disabled={busy} title={`This NFT still holds liquidity on chain${position.state === "closed" ? ", though the agent recorded it closed" : ""}. Closing it sends both legs to your wallet.`} onClick={() => { if (window.confirm(`Close NFT ${liveOnChain.tokenId.toString(10)} on chain with your passkey? Both legs go to your wallet; you can withdraw them from the Account page.`)) closePositionNow(liveOnChain); }}>Close on chain</Button>
                  : null}
              </span>
            </div>
          );
        })}
        {discovered.map((nft) => {
          // A rung the chain holds and the plane has not recorded yet. Side and
          // fill edge from the range against the page's current tick: a range
          // above the tick holds token0 and completes at its far edge.
          const tick = view?.grid.observedTick ?? null;
          const context = pairContext(view);
          const holdsWbnb = view === null || tick === null ? null : rungHoldsWbnb({ tickLower: nft.tickLower, tickUpper: nft.tickUpper, amount0: nft.amounts.amount0, amount1: nft.amounts.amount1, tick, wbnbIsToken0: view.grid.wbnbIsToken0 });
          const fillTick = holdsWbnb === null || view === null ? nft.tickUpper : rungFillTick({ tickLower: nft.tickLower, tickUpper: nft.tickUpper, holdsWbnb, wbnbIsToken0: view.grid.wbnbIsToken0 });
          const fillPrice = context === null ? null : priceAtTick(fillTick, context.pair);
          const size = holdsWbnb === null || view === null ? null : heldLegText(nft, holdsWbnb, view.grid.wbnbIsToken0, context);
          const id = nft.tokenId.toString(10);
          return (
            <div key={`discovered-${id}`} className="fl-row" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto", cursor: "default", alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ display: "grid", gap: 3 }}>
                  <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{view?.grid.pair ?? "—"}</span>
                  <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--warning)" }} title="On chain in the agent wallet now; the plane records it once the relay confirms the batch.">{id} · NEW RUNG · NOT RECORDED YET</span>
                </span>
              </span>
              <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-muted)" }}>just now</span>
              <span style={{ display: "grid", gap: 6 }}>
                <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }} title={`Live from chain: NFT ${id} at tick ${tick ?? ""}`}>{size ?? "—"}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>Price @ {fillPrice ?? "—"} {context?.quote ?? "—"}</span>
              </span>
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--ink-1)", letterSpacing: "0.04em" }}>{holdsWbnb === null ? "—" : holdsWbnb ? "BID WBNB" : `ASK ${context?.base ?? ""}`}</span>
                <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>Open order</span>
              </span>
              <Num value="—" tone="flat" size="sm" />
              <Num value="—" tone="flat" size="sm" />
              <span style={{ display: "flex", gap: 8 }}>
                <a href={`https://bscscan.com/nft/${NFPM_56.toLowerCase()}/${id}`} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm" iconRight={<Icon name="external" size={13} />}>Tx</Button></a>
              </span>
            </div>
          );
        })}
        {(view?.positions.length ?? 0) === 0 ? <div className="fl-row" style={{ gridTemplateColumns: "1.3fr 1fr 1.2fr 1fr 0.9fr 0.9fr auto", cursor: "default", alignItems: "center" }}>—</div> : null}
      </Panel>
    </div>
  );
}

function sideIcon(
  view: AgentDetailView | null | undefined,
  icons: Record<string, string | null>,
  role: string,
): React.ReactNode {
  if (view == null) return null;
  const address = role === "sell" ? view.grid.baseAddress : role === "buy" ? view.grid.quoteAddress : null;
  const symbol = role === "sell" ? view.grid.base : role === "buy" ? view.grid.quote : null;
  if (address === null && symbol === null) return null;
  return <TokenIcon src={icons[address?.toLowerCase() ?? ""] ?? null} symbol={symbol} size={16} />;
}

function usePairIcons(token0: string | undefined, token1: string | undefined): Record<string, string | null> {
  const [icons, setIcons] = React.useState<Record<string, string | null>>({});
  React.useEffect(() => {
    if (token0 === undefined || token1 === undefined || token0 === "" || token1 === "") return;
    const controller = new AbortController();
    void fetch(`/api/token-icons?addresses=${token0},${token1}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { data?: Record<string, string | null> } | null) => {
        if (payload?.data) setIcons(payload.data);
      })
      .catch(() => undefined); // a missing icon is cosmetic, never an error
    return () => controller.abort();
  }, [token0, token1]);
  return icons;
}

export function HiredAgentScreen({ agentId, go }: Props) {
  // `?mock=1` swaps the VIEW for the recording fixture and nothing else; with
  // the flag absent this is the real result by identity.
  const detail = useMockAgentDetail(useAgentDetail(agentId), agentId);
  const owner = useOwnerActions();
  const [tab, setTab] = useState<Tab>("Overview");
  const [delegatedUnit, setDelegatedUnit] = useState<"USD" | "BNB">("USD");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState<SessionRegistration>(null);
  const [finalizedRevocation, setFinalizedRevocation] = useState<FinalizedSessionRevocation>(null);
  // What the CHAIN says each position NFT holds, keyed by tokenId. The plane's
  // row is bookkeeping; this is the money. They disagreed once (2026-09-03,
  // NFT 7316794 live under a `closed` row), which is why Remove refuses to
  // revoke on the row alone.
  const [onChain, setOnChain] = useState<ReadonlyMap<string, OnChainPosition>>(new Map());
  // NFTs the wallet holds on THIS pool that the plane has not recorded yet: a
  // re-quote's new rungs exist on chain the moment the batch lands, while the
  // plane's row waits for the relay's confirmation (minutes). Read from the
  // NFPM's own enumeration, every on-chain refresh.
  const [discovered, setDiscovered] = useState<readonly OnChainPosition[]>([]);
  // The wallet's EMPTIED rungs on this pool: the only durable trace of prior
  // pairs, since a shift rewrites its rows' tokenIds in place. Feeds the fill
  // feed's side/price derivation (`emptyRungPairs` / `shiftFills`).
  const [emptyRungs, setEmptyRungs] = useState<readonly OnChainPosition[]>([]);
  const [chainReadIdentity, setChainReadIdentity] = useState("");
  const [chainReads, setChainReads] = useState<ReadonlyMap<string, OnChainPositionRead>>(new Map());
  const [dust, setDust] = useState<DustRead | undefined>(undefined);
  const chainGeneration = useRef(0);
  const pendingClose = useRef<{ identity: string; tokenId: string; callsId: `0x${string}` } | null>(null);
  const publicClient = usePublicClient();
  const view = detail.view;
  const chainIdentity = `${owner.ownerAddress?.toLowerCase()}:${agentId}:${view?.walletAddress?.toLowerCase()}:${view?.lp?.pool?.poolAddress ?? view?.grid.pool}:${view?.positions.map(p => p.tokenId).join(",")}`;
  const chainIdentityRef = useRef(chainIdentity);
  chainIdentityRef.current = chainIdentity;
  const progressPrefix = `${owner.ownerAddress?.toLowerCase() ?? "signed-out"}:${agentId}`;
  const legacyProgressKey = `${progressPrefix}:remove-v1`;
  const attemptKey = `${progressPrefix}:remove-attempt-v2`;
  const attemptBindings = useMemo(() => {
    if (owner.ownerAddress === undefined || view === null || view.walletAddress === null || view.sessionPublicKey === null) return null;
    return removeAttemptBindings({ ownerAddress: owner.ownerAddress, agentId, walletAddress: view.walletAddress, sessionPublicKey: view.sessionPublicKey });
  }, [agentId, owner.ownerAddress, view?.sessionPublicKey, view?.walletAddress]);
  const [progress, setProgress] = useState<RemoveProgress>(EMPTY_REMOVE_PROGRESS);
  const [removeStorageCheckpoint, setRemoveStorageCheckpoint] = useState<RemoveStorageCheckpoint | null>(null);
  const removeStorageCheckpointRef = useRef<RemoveStorageCheckpoint | null>(null);
  // AUDIT H3: the persisted hire discriminator is authoritative; trade-v1 agents remain runtime-unbound.
  const trading = view?.hireSizingName === "trade-v1";
  const lpAgent = view?.hireSizingName === "lp-v1";
  const lendingAgent = view?.hireSizingName === "lending-v1";

  useEffect(() => {
    removeStorageCheckpointRef.current = null;
    setRemoveStorageCheckpoint(null);
    if (attemptBindings === null) {
      setProgress(EMPTY_REMOVE_PROGRESS);
      return;
    }
    const stored = readRemoveStorage(attemptKey, legacyProgressKey, attemptBindings);
    setProgress(stored.progress);
    removeStorageCheckpointRef.current = stored.checkpoint;
    setRemoveStorageCheckpoint(stored.checkpoint);
  }, [attemptBindings, attemptKey, legacyProgressKey]);
  const saveSupportProgress = useCallback((next: RemoveProgress) => {
    const support = {
      ...(next.failedPositionId === undefined ? {} : { failedPositionId: next.failedPositionId }),
      ...(next.pendingWarning === undefined ? {} : { pendingWarning: next.pendingWarning }),
    };
    const raw = JSON.stringify(support);
    window.localStorage.setItem(legacyProgressKey, raw);
    const currentCheckpoint = removeStorageCheckpointRef.current;
    if (currentCheckpoint !== null) {
      const nextCheckpoint = { ...currentCheckpoint, legacyRaw: raw };
      removeStorageCheckpointRef.current = nextCheckpoint;
      setRemoveStorageCheckpoint(nextCheckpoint);
    }
    setProgress((current) => ({ ...current, ...support }));
  }, [legacyProgressKey]);

  const beginRemoveAttempt = useCallback(async (
    expected: RemoveAttemptExpectation,
  ): Promise<RemoveAttemptV2> => {
    if (attemptBindings === null) throw new Error("The removal attempt cannot be bound to this owner and session.");
    const observed = removeStorageCheckpointRef.current;
    if (observed === null || observed.attemptKey !== attemptKey) {
      throw new Error("Saved removal evidence is still loading. Try again; no revoke was submitted.");
    }
    return withAttemptLock(attemptKey, async () => {
      const currentAttemptRaw = window.localStorage.getItem(attemptKey);
      const currentLegacyRaw = window.localStorage.getItem(legacyProgressKey);
      if (currentAttemptRaw !== observed.attemptRaw || currentLegacyRaw !== observed.legacyRaw) {
        const fresh = readRemoveStorage(attemptKey, legacyProgressKey, attemptBindings);
        setProgress(fresh.progress);
        removeStorageCheckpointRef.current = fresh.checkpoint;
        setRemoveStorageCheckpoint(fresh.checkpoint);
        throw new Error("Saved removal evidence changed. Review the updated state before retrying; no revoke was submitted.");
      }
      const slot = loadAttemptSlot(attemptKey, attemptBindings);
      const legacy = loadLegacyProgress(legacyProgressKey);
      if (!mayBeginRemoveAttempt(slot, legacy.legacyRevokeUnknown === true, expected)) {
        throw new Error(expected.kind === "none"
          ? "Saved removal evidence changed. Refresh before choosing whether to retry; no revoke was submitted."
          : "A newer removal attempt is already active. Refresh before continuing; no revoke was submitted.");
      }
      const attempt = newRemoveAttempt(attemptBindings, crypto.randomUUID(), Date.now());
      const raw = JSON.stringify(attempt);
      window.localStorage.setItem(attemptKey, raw);
      const checkpoint = { attemptKey, attemptRaw: raw, legacyRaw: currentLegacyRaw };
      removeStorageCheckpointRef.current = checkpoint;
      setRemoveStorageCheckpoint(checkpoint);
      setProgress((current) => ({ ...current, legacyRevokeUnknown: false, revokeAttempt: attempt }));
      return attempt;
    });
  }, [attemptBindings, attemptKey, legacyProgressKey]);

  const commitRemoveAttempt = useCallback(async (
    expectedAttemptId: string,
    update: (current: RemoveAttemptV2) => RemoveAttemptV2,
  ): Promise<RemoveAttemptV2 | null> => {
    if (attemptBindings === null) return null;
    return withAttemptLock(attemptKey, async () => {
      const slot = loadAttemptSlot(attemptKey, attemptBindings);
      if (slot.kind !== "valid" || slot.attempt.attemptId !== expectedAttemptId) return null;
      const candidate = parseRemoveAttempt(update(slot.attempt), attemptBindings);
      if (candidate === null) return null;
      const advanced = advanceRemoveAttempt(slot.attempt, expectedAttemptId, candidate);
      if (advanced === null) return null;
      const raw = JSON.stringify(advanced);
      window.localStorage.setItem(attemptKey, raw);
      const checkpoint = {
        attemptKey,
        attemptRaw: raw,
        legacyRaw: window.localStorage.getItem(legacyProgressKey),
      };
      removeStorageCheckpointRef.current = checkpoint;
      setRemoveStorageCheckpoint(checkpoint);
      setProgress((previous) => ({ ...previous, legacyRevokeUnknown: false, revokeAttempt: advanced }));
      return advanced;
    });
  }, [attemptBindings, attemptKey, legacyProgressKey]);

  const mutate = useCallback(async (action: string, suffix: string, params: unknown): Promise<unknown> => {
    const envelope = await owner.signEnvelope(action, agentId, params);
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(await refusalText(response));
    return response.json() as Promise<unknown>;
  }, [agentId, owner]);

  const readRegistration = useCallback(async (): Promise<FinalizedSessionRevocation> => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/session`, { headers: detail.readHeaders, cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { readonly data?: {
      readonly sessionRegistration?: unknown;
      readonly finalizedSessionRevocation?: unknown;
    } };
    const parseLatest = (evidence: unknown): SessionRegistration => {
      if (typeof evidence !== "object" || evidence === null) return null;
      const kind = (evidence as { readonly kind?: unknown }).kind;
      const checkedAtMs = (evidence as { readonly checkedAtMs?: unknown }).checkedAtMs;
      if (!["registered", "missing", "invalid", "unreadable"].includes(String(kind))
        || !Number.isSafeInteger(checkedAtMs)) return null;
      return { kind, checkedAtMs } as SessionRegistration;
    };
    const parseFinalized = (evidence: unknown): FinalizedSessionRevocation => {
      const basic = parseLatest(evidence);
      if (basic === null || basic.kind === "unreadable") return basic;
      const record = evidence as { readonly finalizedBlockNumber?: unknown; readonly finalizedBlockHash?: unknown };
      if (typeof record.finalizedBlockNumber !== "string" || !/^[1-9][0-9]*$/u.test(record.finalizedBlockNumber)
        || typeof record.finalizedBlockHash !== "string" || !isHex(record.finalizedBlockHash)
        || size(record.finalizedBlockHash) !== 32) return { kind: "unreadable", checkedAtMs: basic.checkedAtMs };
      return { ...basic, finalizedBlockNumber: record.finalizedBlockNumber, finalizedBlockHash: record.finalizedBlockHash };
    };
    const latest = parseLatest(payload.data?.sessionRegistration);
    const finalized = parseFinalized(payload.data?.finalizedSessionRevocation);
    setRegistration(latest);
    setFinalizedRevocation(finalized);
    return finalized;
  }, [agentId, detail.readHeaders]);

  useEffect(() => {
    if (view !== null && ["armed", "paused", "revoked"].includes(view.status)) void readRegistration();
  }, [readRegistration, view]);

  const readOnChainPositions = useCallback(async (target: AgentDetailView | null): Promise<readonly OnChainPositionRead[]> => {
    const identity = chainIdentity, generation = ++chainGeneration.current;
    const isCurrent = () => chainIdentityRef.current === identity && chainGeneration.current === generation;
    if (target === null || target.hireSizingName === "trade-v1") return [];
    const ids = target.positions.flatMap(p => p.tokenId === null ? [] : [p.tokenId]);
    const pool = target.hireSizingName === "lp-v1" ? target.lp?.pool : target.grid;
    const unavailable = (id: string, reason: string): OnChainPositionRead => ({ kind: "unreadable", tokenId: BigInt(id), reason });
    if (!publicClient || !pool || !owner.ownerAddress) {
      const reads = (ids.length ? ids : ["0"]).map(id => unavailable(id, "cannot verify NFT state: client, owner or pool unavailable"));
      if (isCurrent()) {
        setChainReadIdentity(identity); setChainReads(new Map(reads.map(r => [r.tokenId.toString(), r]))); setOnChain(new Map());
        setDust({ kind: "unavailable", reason: "cannot read the agent wallet: client, owner or pool unavailable" });
      }
      return reads;
    }
    const samePool = (candidate: OnChainPosition): boolean => candidate.token0.toLowerCase() === pool.token0.toLowerCase()
      && candidate.token1.toLowerCase() === pool.token1.toLowerCase() && candidate.fee === pool.fee;
    const reads = await Promise.all(ids.map(async id => {
      try {
        const read = await readOnChainPosition(publicClient, NFPM_56 as `0x${string}`, BigInt(id));
        return read.kind === "position" && !samePool(read) ? unavailable(id, "NFT pool does not match this agent") : read;
      } catch { return unavailable(id, "cannot verify NFT state"); }
    }));
    if (!isCurrent()) return [unavailable(ids[0] ?? "0", "NFT request identity changed")];
    const next = new Map<string, OnChainPosition>();
    for (const read of reads) if (read.kind === "position") next.set(read.tokenId.toString(), read);
    setChainReadIdentity(identity); setOnChain(next); setChainReads(new Map(reads.map(r => [r.tokenId.toString(), r])));
    setDiscovered([]); setEmptyRungs([]);
    // The Dust tile's only source: both pool legs in the agent wallet, pinned to
    // one block. Never native BNB — that is the gas reserve, not dust.
    if (target.hireSizingName === "lp-v1" && target.walletAddress) {
      const legs = await readWalletLegBalances(publicClient, target.walletAddress as `0x${string}`, pool.token0 as `0x${string}`, pool.token1 as `0x${string}`);
      if (isCurrent()) setDust(legs);
    }
    try {
      const known = new Set(ids);
      const held = await listWalletPositionIds(publicClient, NFPM_56 as `0x${string}`, target.walletAddress as `0x${string}`);
      const extra = await Promise.all(held.filter(id => !known.has(id.toString())).map(id => readOnChainPosition(publicClient, NFPM_56 as `0x${string}`, id)));
      if (!isCurrent()) return [unavailable(ids[0] ?? "0", "NFT request identity changed")];
      const positions = extra.filter((r): r is OnChainPosition => r.kind === "position" && samePool(r));
      setDiscovered(positions.filter(r => r.liquidity > 0n));
      setEmptyRungs([...next.values(), ...positions].filter(r => r.liquidity === 0n));
      return [...reads, ...positions];
    } catch { return reads; }
  }, [publicClient, chainIdentity, owner.ownerAddress]);

  useEffect(() => {
    void readOnChainPositions(view);
    const timer = setInterval(() => void readOnChainPositions(view), 30_000);
    return () => { clearInterval(timer); chainGeneration.current++; };
  }, [readOnChainPositions, chainIdentity]);

  // LIVE RUNGS: every NFT on this pool with liquidity right now (the plane's
  // rows read from chain, plus the ones the plane has not recorded yet),
  // classified by side against the page's current tick — a range above the
  // tick holds token0. When the chain names a side, its range REPLACES the
  // plane's recorded range in the view the panels draw from, so a re-quote is
  // visible the moment its batch lands rather than when the relay confirms it.
  const liveView = useMemo<AgentDetailView | null>(() => {
    if (view === null || view.hireSizingName === "lp-v1" || view.hireSizingName === "trade-v1") return view;
    if (view === null || view.grid.observedTick === null) return view;
    const context = pairContext(view);
    if (context === null) return view;
    const tick = view.grid.observedTick;
    const live = [...onChain.values(), ...discovered].filter((nft) =>
      nft.liquidity > 0n
      && nft.token0.toLowerCase() === view.grid.token0.toLowerCase()
      && nft.token1.toLowerCase() === view.grid.token1.toLowerCase()
      && nft.fee === view.grid.fee);
    if (live.length === 0) return view;
    // Highest tokenId per side wins: the newest mint is the current rung.
    let buy: OnChainPosition | undefined;
    let sell: OnChainPosition | undefined;
    for (const nft of live) {
      const holdsWbnb = rungHoldsWbnb({ tickLower: nft.tickLower, tickUpper: nft.tickUpper, amount0: nft.amounts.amount0, amount1: nft.amounts.amount1, tick, wbnbIsToken0: view.grid.wbnbIsToken0 });
      if (holdsWbnb) { if (buy === undefined || nft.tokenId > buy.tokenId) buy = nft; }
      else if (sell === undefined || nft.tokenId > sell.tokenId) sell = nft;
    }
    const grid = {
      ...view.grid,
      ...(buy === undefined ? {} : { buyRange: { tickLower: buy.tickLower, tickUpper: buy.tickUpper }, buyPrices: rangePrices(buy.tickLower, buy.tickUpper, context.pair) }),
      ...(sell === undefined ? {} : { sellRange: { tickLower: sell.tickLower, tickUpper: sell.tickUpper }, sellPrices: rangePrices(sell.tickLower, sell.tickUpper, context.pair) }),
    };
    return { ...view, grid };
  }, [discovered, onChain, view]);

  const snapshot = useMemo(
    () => removeSnapshotOf(view, registration, finalizedRevocation),
    [finalizedRevocation, registration, view],
  );
  const remove = nextRemoveStep(snapshot, progress, Date.now());
  const removed = hasFreshRevocationProof(snapshot, Date.now());

  const perform = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try { await task(); } catch (error) { setMessage(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(false); }
  }, []);

  /**
   * Remove is a SERIAL workflow — pause, one exit per position, local revoke,
   * on-chain revoke, verify — and this runs it to the first point it cannot
   * pass on its own. Every step re-reads the plane before deciding the next,
   * so a step that lands nothing (or a reload mid-way) resumes exactly where
   * the data says, never where the click assumed. A grid agent with two rungs
   * used to need two clicks and a guess; now it needs one click and the wait.
   */
  /**
   * Empty ONE position NFT with the owner's passkey — no session, no plane.
   *
   * Reachable however the plane's row reads, because the row is exactly what
   * cannot be trusted in the state this exists for. Refuses only when the price
   * could not be read, since without it there is no floor and a zero-floor
   * withdrawal can be settled at the worst point of the position's own range.
   */
  const closeOnChain = useCallback(async (position: OnChainPosition): Promise<"confirmed" | "pending"> => {
    const identity = chainIdentity;
    if (chainIdentityRef.current !== identity) throw new Error("NFT request identity changed");
    if (pendingClose.current !== null && pendingClose.current.identity === identity) {
      const { readRevokeCallsStatus } = await import("@/lib/altana/client");
      const status = await readRevokeCallsStatus(pendingClose.current.callsId);
      if (chainIdentityRef.current !== identity) throw new Error("NFT request identity changed");
      if (status.kind !== "confirmed" && status.kind !== "failed") return "pending";
      pendingClose.current = null;
      if (status.kind === "confirmed") return "confirmed";
      throw new Error("The prior close failed; refresh before another attempt.");
    }
    if (owner.passkey === null) throw new Error("Closing a position on chain needs the passkey that holds this wallet.");
    if (position.liquidity <= 0n) return "confirmed";
    if (!position.amountsAvailable || (position.minimums.amount0 === 0n && position.minimums.amount1 === 0n)) {
      throw new Error("The pool price could not be read, so this close has no floor to submit. Try again in a moment.");
    }
    const { closeLpPositionWithPasskey } = await import("@/lib/altana/client");
    const result = await closeLpPositionWithPasskey({
      record: owner.passkey,
      nfpm: NFPM_56 as `0x${string}`,
      tokenId: position.tokenId,
      liquidity: position.liquidity,
      amount0Min: position.minimums.amount0,
      amount1Min: position.minimums.amount1,
      deadlineSec: BigInt(Math.floor(Date.now() / 1000) + 600),
    });
    if (result.status === "FAILED") throw new Error(`The on-chain close failed (${result.callsId.slice(0, 10)}…). Nothing left the position.`);
    if (chainIdentityRef.current !== identity) throw new Error("NFT request identity changed");
    if (result.status === "PENDING") { pendingClose.current = { identity, tokenId: position.tokenId.toString(), callsId: result.callsId }; return "pending"; }
    return "confirmed";
  }, [owner.passkey, chainIdentity]);

  const closePositionNow = (position: OnChainPosition) => perform(async () => {
    setMessage(`Closing NFT ${position.tokenId.toString(10)} with your passkey…`);
    const result = await closeOnChain(position);
    if (result === "pending") { setMessage("On-chain close pending — continue after confirmation."); return; }
    setMessage(`NFT ${position.tokenId.toString(10)} emptied into the wallet. Withdraw it from the Account page.`);
    await detail.refresh();
    await readOnChainPositions(view);
  });

  const runRemove = () => perform(async () => {
    let current = view;
    let localProgress = progress;
    let localFinalizedRevocation = finalizedRevocation;
    for (let step = 0; step < MAX_REMOVE_STEPS && current !== null; step += 1) {
      const decision = nextRemoveStep(
        removeSnapshotOf(current, registration, localFinalizedRevocation), localProgress, Date.now(),
      );
      // THE GUARD, and the reason Remove can be one button. Revoking ends the
      // session, so anything still in a position at that moment is beyond the
      // plane for ever. The plane's rows are not evidence of an empty NFT — on
      // 2026-09-03 they said closed while 7316794 held real liquidity — so the
      // chain is asked, and the passkey empties whatever is still there. This
      // also covers the sequence the plane cannot settle: the NFT comes out
      // whether or not its bookkeeping ever agrees.
      if (["local-revoke", "broadcast-revoke", "check-revoke", "retry-revoke"].includes(decision.kind)) {
        if (pendingClose.current?.identity === chainIdentity) {
          const status = await (await import("@/lib/altana/client")).readRevokeCallsStatus(pendingClose.current.callsId);
          if (chainIdentityRef.current !== chainIdentity) throw new Error("NFT request identity changed");
          if (status.kind === "failed") {
            pendingClose.current = null;
            throw new Error("The prior on-chain close failed; refresh before another attempt.");
          }
          if (status.kind !== "confirmed") { setMessage("On-chain close pending — continue after confirmation."); return; }
          pendingClose.current = null;
          current = await detail.refresh();
          continue;
        }
        const reads = await readOnChainPositions(current);
        if (reads.some(r => r.kind === "unreadable")) {
          throw new Error(reads.some(r => r.kind === "unreadable" && r.reason.includes("client, owner or pool unavailable"))
            ? "Cannot verify NFT state — connect the wallet that owns this agent, then try again."
            : "Cannot verify NFT state; removal stopped.");
        }
        const live = reads.filter((r): r is OnChainPosition => r.kind === "position" && r.liquidity > 0n);
        const first = live[0];
        if (first !== undefined) {
          setMessage(`Removing (step ${step + 1}): NFT ${first.tokenId.toString(10)} still holds liquidity on chain. Closing it with your passkey before the session is revoked.`);
          const result = await closeOnChain(first);
          if (result === "pending") { setMessage("On-chain close pending — continue after confirmation."); return; }
          current = await detail.refresh();
          continue;
        }
      }
      setMessage(removeProgressText(decision, step));
      if (decision.kind === "pause") {
        await mutate("pause", "/pause", {});
        current = await detail.refresh();
      } else if (decision.kind === "exit" && decision.positionId !== undefined) {
        try {
          // PHASE3.24 Part B: ask for the inline conversion so the withdraw and
          // the swap ride ONE submission when the deployment allows the token;
          // the plane falls back to the two-submission exit when it does not.
          await mutate("lpExit", `/lp/${encodeURIComponent(decision.positionId)}/exit`, { positionId: decision.positionId, inlineConvert: true });
          const { failedPositionId: _failed, ...rest } = localProgress;
          localProgress = rest;
          saveSupportProgress(rest);
          current = await detail.refresh();
        } catch (error) {
          localProgress = { ...localProgress, failedPositionId: decision.positionId };
          saveSupportProgress(localProgress);
          throw error;
        }
      } else if (decision.kind === "local-revoke") {
        const payload = await mutate("revoke", "/revoke", {});
        localProgress = { ...localProgress, pendingWarning: responseWarning(payload) };
        saveSupportProgress(localProgress);
        current = await detail.refresh();
        localFinalizedRevocation = await readRegistration();
      } else if (decision.kind === "broadcast-revoke" || decision.kind === "retry-revoke") {
        if (owner.passkey === null || current.sessionPublicKey === null) return;
        const attempt = await beginRemoveAttempt(decision.kind === "broadcast-revoke"
          ? { kind: "none" }
          : localProgress.revokeAttempt === undefined
            ? { kind: "ambiguous" }
            : { kind: "replace", attemptId: localProgress.revokeAttempt.attemptId });
        localProgress = { ...localProgress, legacyRevokeUnknown: false, revokeAttempt: attempt };
        const result = await (await import("@/lib/altana/client")).revokeAgentSession({
          record: owner.passkey,
          ownerViewWalletAddress: current.walletAddress as `0x${string}`,
          sessionPublicKey: current.sessionPublicKey as `0x${string}`,
        });
        const saved = await commitRemoveAttempt(attempt.attemptId, (stored) => ({
          ...stored,
          state: result.status === "FAILED" ? "failed" : "pending",
          callsId: result.callsId,
          ...(result.transactionHash === undefined ? {} : { transactionHash: result.transactionHash }),
        }));
        if (saved === null) throw new Error("A newer removal attempt replaced this one. Refresh before continuing.");
        localProgress = { ...localProgress, revokeAttempt: saved };
        if (saved.state === "failed") {
          setMessage("The on-chain revoke failed. Retry requires a new passkey approval and may spend relay gas again.");
          return;
        }
      } else if (decision.kind === "check-revoke") {
        const attempt = localProgress.revokeAttempt;
        if (attempt === undefined || attempt.callsId === undefined) return;
        let observed = attempt;
        if (attempt.state === "pending") {
          const relay = await (await import("@/lib/altana/client")).readRevokeCallsStatus(attempt.callsId, attempt.transactionHash);
          if (relay.kind === "unreadable") {
            setMessage("The relay status is temporarily unreadable. No revoke was retried; press Check removal again.");
            return;
          }
          if (relay.kind === "pending") {
            setMessage("The on-chain revoke is still pending. No second revoke was submitted.");
            return;
          }
          if (relay.kind === "failed") {
            const saved = await commitRemoveAttempt(attempt.attemptId, (stored) => ({ ...stored, state: "failed" }));
            if (saved !== null) localProgress = { ...localProgress, revokeAttempt: saved };
            setMessage("The on-chain revoke failed. Retry requires a new passkey approval and may spend relay gas again.");
            return;
          }
          const saved = await commitRemoveAttempt(attempt.attemptId, (stored) => ({
            ...stored,
            state: "awaiting-finality",
            transactionHash: relay.receipt.transactionHash,
            receipt: relay.receipt,
          }));
          if (saved === null) throw new Error("A newer removal attempt replaced this one. Refresh before continuing.");
          observed = saved;
          localProgress = { ...localProgress, revokeAttempt: saved };
        }
        localFinalizedRevocation = await readRegistration();
        current = await detail.refresh();
        if (current === null) return;
        if (hasFreshRevocationProof(removeSnapshotOf(current, registration, localFinalizedRevocation), Date.now())) continue;
        if (observed.receipt === undefined || !finalizedAtOrAfter(localFinalizedRevocation, observed.receipt.blockNumber)) {
          setMessage("The revoke transaction is confirmed and waiting for BNB finality. No second revoke was submitted.");
          return;
        }
        if (localFinalizedRevocation?.kind === "registered") {
          const saved = await commitRemoveAttempt(observed.attemptId, (stored) => ({ ...stored, state: "postcondition-failed" }));
          if (saved !== null) localProgress = { ...localProgress, revokeAttempt: saved };
          setMessage("The confirmed revoke did not remove the session from KeyStore. Retry needs a new passkey approval and may spend relay gas again.");
        } else {
          setMessage("Finalized KeyStore evidence is unreadable. No second revoke was submitted; press Check removal again.");
        }
        return;
      } else {
        // disabled | blocked | removed — nothing this click can do; the
        // message and, when there is one, the Resolve/Abandon control say why.
        return;
      }
    }
  });

  /**
   * PHASE3.14: settle the ONE step the relay never answered for. The plane
   * takes a single bounded relay status read plus chain evidence and picks
   * ADVANCE or ABANDON itself; nothing is retried and no money moves. The
   * observed block is evidence, never a condition — the server reads its own,
   * exactly as the operator CLI sends 0 when its read fails.
   */
  const resolveBlocker = () => perform(async () => {
    const blocker = remove.blocker;
    if (blocker === undefined || blocker.resolvableDecisionId === null) return;
    const decisionId = blocker.resolvableDecisionId;
    const payload = await mutate("resolveUnknown", `/journal/${encodeURIComponent(decisionId)}/resolve`, { decisionId, observedBlock: "0" });
    setMessage(resolutionSummary(payload));
    await detail.refresh();
  });

  const abandonBlocker = () => perform(async () => {
    const blocker = remove.blocker;
    if (blocker === undefined || !blocker.abandonable) return;
    await mutate("abandonSequence", `/lp/sequences/${encodeURIComponent(blocker.sequenceId)}/abandon`, { sequenceId: blocker.sequenceId });
    setMessage(`Sequence ${blocker.sequenceId.slice(0, 8)} abandoned; whatever it freed stays in the wallet.`);
    await detail.refresh();
  });

  const edit = () => {
    if (view?.hireSizingName === "lp-v1") return;
    const raw = window.prompt("Edit");
    if (raw === null) return;
    void perform(async () => {
      const params = JSON.parse(raw) as unknown;
      if (typeof params !== "object" || params === null || Array.isArray(params)) return;
      await mutate("lpSettings", "/lp/settings", params);
      await detail.refresh();
    });
  };

  const withdrawLp = (positionId: string) => void perform(async () => {
    try {
      const payload = await mutate("lpExit", `/lp/${encodeURIComponent(positionId)}/exit`, { positionId, inlineConvert: true });
      setMessage(lpWithdrawOutcome(payload));
    } finally { await detail.refresh(); }
  });

  const togglePause = () => perform(async () => {
    if (view === null) return;
    const paused = view.status === "paused";
    await mutate(paused ? "unpause" : "pause", paused ? "/unpause" : "/pause", {});
    await detail.refresh();
  });

  const sellNow = (positionId: string) => void perform(async () => {
    await mutate("tradeExit", `/trade/positions/${encodeURIComponent(positionId)}/exit`, { positionId });
    await detail.refresh();
  });

  const saveTradeSettings = async (settings: TradeSettings): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      await mutate("tradeSettings", "/trade/settings", settings);
      await detail.refreshTrade();
      setMessage("Trading settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const runTradeRemove = () => perform(async () => {
    if (view === null) return;
    if (owner.passkey === null || view.sessionPublicKey === null) {
      throw new Error("Removing this agent needs the passkey that owns its wallet.");
    }
    let currentView = view;
    if (view.status === "revoked") {
      const current = await detail.refreshTrade();
      if (current !== null && (current.open.length > 0 || current.pendingIntents.length > 0)) {
        throw new Error("Local revoke is already recorded, but conversion to BNB is incomplete. Use Hard revoke, then Account recovery for the remaining tokens.");
      }
    }
    if (view.status !== "revoked") {
      setMessage("Removing: closing the entry gate and requesting every open position exit to BNB…");
      await mutate("tradeDrain", "/trade/drain", {});
      if (view.status === "paused") {
        setMessage("Removing: resuming the worker so it can exit every open position to BNB…");
        await mutate("unpause", "/unpause", {});
      }
      let drained = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const current = await detail.refreshTrade();
        if (current !== null && current.open.length === 0 && current.pendingIntents.length === 0) {
          drained = true;
          break;
        }
        setMessage("Removing: waiting for confirmed exits and zero token balances…");
        await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      }
      if (!drained) {
        setMessage("The agent is still draining. No new entries can open; press Removing again after the pending exits settle.");
        return;
      }
      setMessage("Removing: positions are empty. Revoking the agent on the execution plane…");
      await mutate("revoke", "/revoke", {});
      currentView = await detail.refresh() ?? view;
    }
    setMessage("Removing: approve the on-chain session-key revocation with your passkey…");
    const result = await (await import("@/lib/altana/client")).revokeAgentSession({
      record: owner.passkey,
      ownerViewWalletAddress: view.walletAddress as `0x${string}`,
      sessionPublicKey: view.sessionPublicKey as `0x${string}`,
    });
    if (result.status === "FAILED") throw new Error("The on-chain session-key revocation failed. The execution plane is already revoked; press Finish removal to retry the chain step.");
    const evidence = await readRegistration();
    currentView = await detail.refresh() ?? currentView;
    if (hasFreshRevocationProof(removeSnapshotOf(currentView, registration, evidence), Date.now())) {
      setMessage("Agent removed. Every verified position was exited to BNB before revocation.");
    } else {
      setMessage("The revocation was submitted. Press Finish removal after the chain confirms it.");
    }
  });

  const runTradeHardRevoke = () => perform(async () => {
    if (view === null || owner.passkey === null || view.sessionPublicKey === null) {
      throw new Error("Hard revoke needs the passkey that owns this wallet.");
    }
    if (view.status === "armed") {
      setMessage("Hard revoke: pausing the worker before revoking session authority…");
      await mutate("pause", "/pause", {});
    }
    setMessage("Hard revoke: approve the on-chain session-key revocation. This does not guarantee conversion of remaining tokens to BNB.");
    const result = await (await import("@/lib/altana/client")).revokeAgentSession({
      record: owner.passkey,
      ownerViewWalletAddress: view.walletAddress as `0x${string}`,
      sessionPublicKey: view.sessionPublicKey as `0x${string}`,
    });
    if (result.status === "FAILED") throw new Error("Hard revoke failed on-chain; no successful removal is being reported.");
    const evidence = await readRegistration();
    const latest = await detail.refresh() ?? view;
    if (!hasFreshRevocationProof(removeSnapshotOf(latest, registration, evidence), Date.now())) {
      setMessage("Hard revoke was submitted but is not yet confirmed. Retry after confirmation; conversion to BNB remains incomplete.");
      return;
    }
    setMessage("Session authority is hard-revoked. Conversion to BNB is incomplete; open Account recovery for any remaining tokens.");
  });

  const cat = Category("grid");
  const status = view?.status === "armed" ? "live" : "paused";
  const statusLabel = view === null ? "—" : ["provisioning", "revoked", "retired"].includes(view.status) ? view.status : undefined;
  const actionsDisabled = busy || view === null || view.provisioning || removed;
  const removeProgressHydrated = attemptBindings !== null
    && removeStorageCheckpoint?.attemptKey === attemptKey;
  const limit = view?.dailyNativeLimit;
  const delegatedUsd = limit?.usd ?? null;
  const delegatedBnb = limit?.bnb ?? null;
  const delegated = limit === undefined || limit.value === null
    ? metricValue(limit)
    // A metric that carries no split units still renders its own text.
    : (delegatedUnit === "USD" ? delegatedUsd ?? delegatedBnb : delegatedBnb ?? delegatedUsd) ?? limit.value;
  // Gross first: it is defined from the moment the grid is armed, while the
  // realised figure waits for a completed round trip and dashes until then.
  const delta = metricValue(view?.grossPnl);
  const percent = metricValue(view?.grossPnlPercent);
  const hodl = metricValue(detail.market?.hodl);
  // Read back from the SIGNED geometry: the preset name is never signed, so the
  // only honest label is the one this gap/width reproduces at this spacing.
  const model = view === null
    ? "—"
    : gridModelLabel({ gapTicks: view.grid.gapTicks, widthTicks: view.grid.widthTicks, tickSpacing: view.grid.tickSpacing }) ?? "—";
  const statusMessage = message || detail.message;
  const removeCallsId = progress.revokeAttempt?.callsId;
  const removeTransactionHash = progress.revokeAttempt?.receipt?.transactionHash ?? progress.revokeAttempt?.transactionHash;
  const sequences = view?.sequences ?? [];
  const identityStatus = <Erc8004IdentityStatus identity={view?.erc8004Identity} />;

  if (trading) {
    return <TradeAgentDetail
      identityStatus={identityStatus}
      agentId={agentId}
      view={view}
      trade={detail.trade}
      busy={busy}
      removed={removed && detail.trade !== null && detail.trade.open.length === 0 && detail.trade.pendingIntents.length === 0}
      message={statusMessage}
      signedOut={detail.state === "signed-out" || detail.state === "auth-expired"}
      go={go}
      signIn={detail.signIn}
      refresh={detail.refreshTrade}
      togglePause={() => void togglePause()}
      remove={() => { if (window.confirm("Remove this agent? It will resume if paused, exit every open position to BNB, then revoke the session key.")) void runTradeRemove(); }}
      hardRevoke={() => { if (window.confirm("Hard revoke session authority now? Remaining tokens may not be converted to BNB and must be handled through Account recovery.")) void runTradeHardRevoke(); }}
      sellNow={sellNow}
      saveSettings={saveTradeSettings}
    />;
  }

  if (lendingAgent) {
    return <LendingAgentDetail
      identityStatus={identityStatus}
      agentId={agentId}
      go={go}
      detail={detail}
      view={view}
      busy={busy}
      message={statusMessage}
      actionsDisabled={actionsDisabled}
      removeDisabled={actionsDisabled || remove.kind === "blocked" || !removeProgressHydrated}
      removeTitle={remove.kind === "blocked" ? remove.message : undefined}
      removeLabel={removeActionLabel(remove, removed)}
      removeCallsId={removeCallsId}
      removeTransactionHash={removeTransactionHash}
      signedOut={detail.state === "signed-out" || detail.state === "auth-expired"}
      onTogglePause={() => void togglePause()}
      onRemove={() => {
        if (remove.kind === "check-revoke" || window.confirm(removeConfirmText(remove))) void runRemove();
      }}
    />;
  }

  if (lpAgent) {
    return <LpAgentDetail
      identityStatus={identityStatus}
      agentId={agentId}
      go={go}
      detail={detail}
      view={view}
      busy={busy}
      message={statusMessage}
      actionsDisabled={actionsDisabled}
      removeDisabled={actionsDisabled || remove.kind === "blocked" || !removeProgressHydrated}
      removeTitle={remove.kind === "blocked" ? remove.message : undefined}
      removeLabel={removeActionLabel(remove, removed)}
      removeCallsId={removeCallsId}
      removeTransactionHash={removeTransactionHash}
      showResolve={remove.kind === "blocked" && remove.blocker !== undefined && remove.blocker.resolvableDecisionId !== null}
      showAbandon={remove.kind === "blocked" && remove.blocker !== undefined && remove.blocker.abandonable && remove.blocker.resolvableDecisionId === null}
      signedOut={detail.state === "signed-out" || detail.state === "auth-expired"}
      onWithdraw={withdrawLp}
      chainReads={chainReadIdentity === chainIdentity ? chainReads : new Map()}
      dust={chainReadIdentity === chainIdentity ? dust : undefined}
      discovered={chainReadIdentity === chainIdentity ? discovered : []}
      onTogglePause={() => void togglePause()}
      onRemove={() => {
        if (remove.kind === "check-revoke" || window.confirm(removeConfirmText(remove))) void runRemove();
      }}
      onResolve={() => {
        if (window.confirm("Resolve the stuck step from chain evidence? Nothing is retried and no money moves.")) void resolveBlocker();
      }}
      onAbandon={() => {
        if (window.confirm("Abandon this sequence? Whatever it already freed stays in the wallet.")) void abandonBlocker();
      }}
    />;
  }

  return (
    <div className="fl-shell fl-hired-agent-page">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => go("/account")}>My agents</Button>

      <div className="fl-hired-hero" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap", margin: "16px 0 24px" }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span className="fl-card__glyph" style={{ width: 44, height: 44, color: cat.color, borderColor: cat.color, background: cat.tint }}><Icon name={cat.icon} size={22} /></span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 style={{ font: "var(--type-page-title)" }}>{view?.id ?? agentId}</h1>
              <StatusBadge status={status} pill {...(statusLabel === undefined ? {} : { label: statusLabel })} />
            </div>
            {statusMessage ? <span role="status" style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{statusMessage}</span> : null}
            {identityStatus}
            {removeCallsId !== undefined ? (
              <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
                Relay call <span title={removeCallsId}>{removeCallsId.slice(0, 12)}…</span>
                {removeTransactionHash === undefined ? null : <> · <a href={`https://bscscan.com/tx/${removeTransactionHash}`} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>View transaction</a></>}
              </span>
            ) : null}
            {view?.gas?.low === true
              // GRID-GAS-RESERVE W2: the pot the relay bills a shift from, against
              // what the worker's gate holds under. Same two figures the plane
              // reports; the worker will not move this grid until they cross.
              ? <span role="alert" style={{ font: "var(--type-mono-xs)", color: "var(--warning)" }}>
                  Gas low: the agent wallet holds {formatEther(BigInt(view.gas.nativeWei))} BNB and the next shift needs at least {formatEther(BigInt(view.gas.nextShiftWei))} BNB for relay gas. Deposit BNB to {view.walletAddress} — the grid holds until then.
                </span>
              : null}
          </div>
        </div>
        <div className="fl-hired-actions" style={{ display: "flex", gap: 8 }}>
          {detail.state === "signed-out" || detail.state === "auth-expired" ? <Button variant="primary" onClick={() => void detail.signIn()}>Sign in to view</Button> : null}
          <Button variant="secondary" icon={<Icon name="settings" size={15} />} disabled={actionsDisabled} onClick={edit}>Edit</Button>
          <Button variant="secondary" icon={<Icon name="pause" size={15} />} disabled={actionsDisabled || (view?.status !== "armed" && view?.status !== "paused")} onClick={() => void togglePause()}>Pause</Button>
          {view?.provisioning
            ? <HireRecoveryActions
                key={agentId}
                agentId={agentId}
                readHeaders={detail.readHeaders}
                go={go}
                storageKey={view?.hireSizingName === "lp-v1" ? LP_HIRE_STORAGE_KEY
                  : view?.hireSizingName === "lending-v1" ? LENDING_HIRE_STORAGE_KEY : undefined}
                deployPath={view?.hireSizingName === "lp-v1" ? "/deploy/lp"
                  : view?.hireSizingName === "lending-v1" ? "/deploy/lending" : "/deploy/grid"}
              />
            : <Button variant="danger" icon={<Icon name="revoke" size={15} />} disabled={actionsDisabled || remove.kind === "blocked" || !removeProgressHydrated} title={remove.kind === "blocked" ? remove.message : undefined} onClick={() => {
                if (remove.kind === "check-revoke" || window.confirm(removeConfirmText(remove))) void runRemove();
              }}>{removeActionLabel(remove, removed)}</Button>}
          {remove.kind === "blocked" && remove.blocker !== undefined && remove.blocker.resolvableDecisionId !== null
            ? <Button variant="secondary" disabled={busy} title={remove.message} onClick={() => { if (window.confirm("Resolve the stuck step from chain evidence? Nothing is retried and no money moves.")) void resolveBlocker(); }}>Resolve</Button>
            : null}
          {remove.kind === "blocked" && remove.blocker !== undefined && remove.blocker.abandonable && remove.blocker.resolvableDecisionId === null
            ? <Button variant="secondary" disabled={busy} title={remove.message} onClick={() => { if (window.confirm("Abandon this sequence? Whatever it already freed stays in the wallet.")) void abandonBlocker(); }}>Abandon</Button>
            : null}
        </div>
      </div>

      {/* One row, equal columns, equal heights: each tile is its own grid item
          and stretches, and the Delegated wrapper stretches WITH it (a plain
          span left its tile short). No footnotes here — the operator reads
          these as four numbers, not as four numbers and an essay. */}
      <div className="fl-metrics-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(0,1fr))", gap: 16, marginBottom: 20, alignItems: "stretch" }}>
        <span style={{ position: "relative", display: "grid" }}>
          <MetricTile label="Delegated" value={delegated} style={{ height: "100%" }} />
          <span style={{ position: "absolute", top: 12, right: 12 }}>
            <SegmentedToggle options={[{ value: "USD", label: "USD" }, { value: "BNB", label: "BNB" }]} value={delegatedUnit} onChange={(next: string) => setDelegatedUnit(next === "BNB" ? "BNB" : "USD")} />
          </span>
        </span>
        <MetricTile size="sm" label={`Execution model${modeLabel(view)}`} value={model} style={{ height: "100%", whiteSpace: "nowrap" }} />
        {/* A dash still needs its reason — "why is this empty" is the question
            an empty tile provokes — but a tile that HAS a number says it with
            the number alone. */}
        <MetricTile label="PnL since hire" value={delta} tone={metricTone(delta)} note={emptyNote(view?.grossPnl)} style={{ height: "100%" }} />
        <MetricTile label="PNL by percent" value={percent} tone={metricTone(percent)} note={emptyNote(view?.grossPnlPercent)} style={{ height: "100%" }} />
        <MetricTile label="HODL benchmark" value={hodl} tone={metricTone(hodl)} note={emptyNote(detail.market?.hodl)} style={{ height: "100%" }} />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <SegmentedToggle value={tab} onChange={(value: string) => setTab(value as Tab)} options={["Overview", "Run log"]} />
      </div>

      {tab === "Overview" && <GridDetail detail={detail} view={liveView} onChain={onChain} discovered={discovered} emptyRungs={emptyRungs} busy={busy} closePositionNow={closePositionNow} />}

      {/* The design export put a "Health factor" chart in the GRID column. It
          was always empty here — a grid agent has no health factor — and the
          lending guard now renders its own on `LendingAgentDetail`, so the
          placeholder is gone rather than dashed (MARKETPLACE-LENDING-AGENT §9). */}
      {tab === "Run log" && (
        <div className="fl-detail-grid" style={{ display: "grid", gap: 16, alignItems: "start" }}>
          <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", padding: "8px 20px 16px" }}>
            {sequences.map((sequence) => {
              const time = relativeTime(sequence.updatedAt, detail.asOfMs ?? Date.now());
              const txHash = sequence.txHashes.at(-1);
              return <ActivityRow key={sequence.sequenceId} timeline title={sequence.kind} detail={sequence.state} time={time.text} {...(txHash === undefined ? {} : { txHash: short(txHash), href: `https://bscscan.com/tx/${txHash}` })} />;
            })}
          </section>
        </div>
      )}
    </div>
  );
}

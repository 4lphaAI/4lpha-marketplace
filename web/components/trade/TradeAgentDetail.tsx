"use client";

import React, { useEffect, useMemo, useState } from "react";
import { formatEther, parseUnits, type Hex } from "viem";
import { Button, Icon, StatusBadge } from "@/design-system";
import { AttentionChip, GasNotice, gasAttention } from "@/components/agent/GasNotice";
import { SessionExpiryChip, SessionExpiryNotice, sessionExpiry, sessionPillOverride, useSessionClock } from "@/components/agent/SessionExpiry";
import { MarketChart, type MarketChartMarker } from "@/components/MarketChart";
import { TradeRunLog } from "./TradeRunLog";
import { RunLogPanel, TradeSimulationLog } from "./TradeSimulationLog";
import { ScheduleSummary, ScheduleTabs } from "./ScheduleDetail";
import { PortfolioDetail, PortfolioSummary } from "./PortfolioDetail";
import { TokenIcon, useTokenIcons } from "@/components/TokenIcon";
import { ZeroGCredit } from "@/components/ZeroGCredit";
import { relativeTime, type AgentDetailView } from "@/lib/exec/agent-detail";
import type { OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { StoredPasskey } from "@/lib/exec/passkey";
import { executeCmcBudgetCalls, validateCmcBudgetCallPlan } from "@/lib/altana/cmc-budget";
import { cmcPendingStorageKey, readCmcPending, writeCmcPending, clearCmcPending, type CmcPendingOperation } from "@/lib/altana/cmc-pending";
import { AGENTIC_DCA_COPY, agenticDcaResting } from "@/lib/agentic";
import { TRADE_LLM_MODELS, dcaOrderPriceE8, dcaPullDoor, stopLossBpsFromPercent, stopLossPercentFromBps, tradeModelLabel, txUrl, type TradeDcaOrderView, type TradeDcaView, type TradePositionView, type TradeSettings, type TradeView } from "@/lib/trade";
import { pancakePositionUrl } from "@/lib/pancake";

type TradeTab = "Open Positions" | "Closed Positions" | "Run log" | "CMC x402";
/** Stable identity: the Simulate tab re-reads when its headers change, never on a re-render. */
const NO_READ_HEADERS: Readonly<Record<string, string>> = {};

type Props = {
  readonly identityStatus?: React.ReactNode;
  readonly agentId: string;
  readonly view: AgentDetailView | null;
  readonly trade: TradeView | null;
  readonly busy: boolean;
  readonly removed: boolean;
  readonly message: string;
  readonly signedOut: boolean;
  readonly go: (route: string) => void;
  readonly signIn: () => Promise<void>;
  readonly refresh: () => Promise<unknown>;
  readonly togglePause: () => void;
  readonly remove: () => void;
  readonly sellNow: (positionId: string) => void;
  /** AUTO-DCA R2.11 / D18: the passkey pull door; one token id closes that order alone. */
  readonly pullDcaOrders?: (tokenId?: string) => void;
  /** The last refresh could not reach the execution plane; the view below is the last verified one. */
  readonly planeUnreachable?: boolean;
  /** The owner-read headers (empty in HttpOnly cookie mode) for the Simulate tab's own read. */
  readonly readHeaders?: Readonly<Record<string, string>>;
  readonly saveSettings: (settings: TradeSettings) => Promise<void>;
  /** The renewal control: the button sits left of Edit, the status is one mono line under the hero (operator, 2026-09-16). */
  readonly renewalButton?: React.ReactNode;
  readonly renewalStatus?: React.ReactNode;
  readonly cmcOwner?: {
    readonly passkey: StoredPasskey | null;
    readonly ownerAddress?: string;
    readonly signEnvelope: (action: string, agentId: string, params: unknown) => Promise<OwnerActionEnvelope>;
    readonly signReadHeader?: (agentId: string) => Promise<string>;
  };
};

export function compactAddress(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function bps(value: number | string | null, signed = false): string {
  if (value === null) return "—";
  const numeric = Number(value) / 100;
  if (!Number.isFinite(numeric)) return "—";
  return `${signed && numeric > 0 ? "+" : ""}${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function bnb(wei: string | null, signed = false): string {
  if (wei === null) return "—";
  try {
    const amount = BigInt(wei);
    const value = Number(formatEther(amount));
    if (!Number.isFinite(value)) return "—";
    const text = value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
    return `${signed && amount > 0n ? "+" : ""}${text} BNB`;
  } catch {
    return "—";
  }
}

function usdt(wei: string | null, signed = false): string {
  if (wei === null || !/^-?\d+$/u.test(wei)) return "—";
  try {
    const amount = BigInt(wei);
    const magnitude = amount < 0n ? -amount : amount;
    const whole = magnitude / 10n ** 18n;
    const fraction = (magnitude % 10n ** 18n).toString(10).padStart(18, "0").replace(/0+$/u, "");
    const value = fraction === "" ? whole.toString(10) : `${whole}.${fraction}`;
    return `${amount < 0n ? "-" : signed && amount > 0n ? "+" : ""}${value} USDT`;
  } catch { return "—"; }
}

/** Display-only USDT: at most two decimals, rounded half-up on the atomic value (operator ruling 2026-09-20). Edit inputs keep the exact `usdt()`. */
export function usdt2(wei: string | null, signed = false): string {
  if (wei === null || !/^-?\d+$/u.test(wei)) return "—";
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

function parseUsdtInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{0,18})?$/u.test(trimmed)) return null;
  try { return parseUnits(trimmed, 18).toString(10); } catch { return null; }
}

function bnbUsdRate(view: AgentDetailView | null): number | null {
  const rawBnb = view?.dailyNativeLimit.bnb?.replace(/[^0-9.]/gu, "") ?? "";
  const rawUsd = view?.dailyNativeLimit.usd?.replace(/[^0-9.]/gu, "") ?? "";
  const native = Number(rawBnb), usd = Number(rawUsd);
  // No fresh WBNB price ⇒ no `usd` text ⇒ no rate: the tiles fall back to BNB amounts instead of printing "$0.00" (seen live 2026-09-16).
  return rawUsd !== "" && Number.isFinite(native) && native > 0 && Number.isFinite(usd) && usd > 0 ? usd / native : null;
}

function fiat(wei: string | null, rate: number | null, signed = false): string {
  if (wei === null || rate === null) return bnb(wei, signed);
  try {
    const amount = Number(formatEther(BigInt(wei))) * rate;
    if (!Number.isFinite(amount)) return bnb(wei, signed);
    return `${amount > 0 && signed ? "+" : amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } catch { return "—"; }
}

/** Entry price per token in the settlement asset: entry (18-dec) / held amount — operator 2026-09-21, replaces the "verified fill" line. */
function entryPricePerToken(position: TradePositionView, asset: "USDT" | "BNB"): string {
  const raw = position.observation?.recordedPositionAmount ?? position.tokenAmount;
  const decimals = position.observation?.decimals;
  if (raw === null || decimals === null || decimals === undefined) return "—";
  try {
    const amount = Number(raw) / (10 ** decimals);
    const entry = Number(positionEntryAtomic(position)) / 1e18;
    if (!(amount > 0) || !Number.isFinite(entry)) return "—";
    const price = entry / amount;
    return `${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: price < 1 ? 4 : 2 })} ${asset}`;
  } catch { return "—"; }
}

function tokenAmount(position: TradePositionView): string {
  const raw = position.observation?.recordedPositionAmount ?? position.tokenAmount;
  const decimals = position.observation?.decimals;
  if (raw === null) return "—";
  try {
    if (decimals === null || decimals === undefined) return raw;
    const value = Number(raw) / (10 ** decimals);
    return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  } catch {
    return "—";
  }
}

function positionSymbol(position: TradePositionView): string {
  return position.observation?.symbol ?? compactAddress(position.token);
}

function positionAge(position: TradePositionView): string {
  return relativeTime(position.openedAt, Date.now()).text.replace(/^about /u, "");
}

/** How long a closed position was held (open → close), e.g. "45m", "5h 12m", "1d 3h". */
export function heldDuration(openedAt: number, closedAt: number | null): string {
  if (closedAt === null || !Number.isFinite(openedAt) || !Number.isFinite(closedAt)) return "—";
  const minutes = Math.floor(Math.max(0, closedAt - openedAt) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return hours % 24 === 0 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Closed positions, most recently closed first. */
export function closedNewestFirst(positions: readonly TradePositionView[]): TradePositionView[] {
  return [...positions].sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
}

function positionPnlWei(position: TradePositionView): string | null {
  const quote = position.observation?.currentQuoteWei;
  if (quote === null || quote === undefined) return null;
  try { return (BigInt(quote) - BigInt(position.verifiedEntryAtomic ?? position.requestedEntryAtomic ?? position.entryWei)).toString(10); }
  catch { return null; }
}

function positionSettlementAsset(position: TradePositionView, settings: Pick<TradeSettings, "settlementAsset"> | null): "USDT" | "BNB" {
  return position.settlementAsset === "USDT" || settings?.settlementAsset === "USDT" ? "USDT" : "BNB";
}

function positionEntryAtomic(position: TradePositionView): string {
  return position.verifiedEntryAtomic ?? position.requestedEntryAtomic ?? position.entryWei;
}

function settlementAmount(wei: string | null, asset: "USDT" | "BNB", signed = false): string {
  return asset === "USDT" ? usdt2(wei, signed) : bnb(wei, signed);
}

export function Metric({ label, value, note, tone = "normal", credit, noteTone = false }: { readonly label: string; readonly value: string; readonly note?: string; readonly tone?: "normal" | "profit" | "loss"; readonly credit?: React.ReactNode; readonly noteTone?: boolean }) {
  return <div className="fl-trade-metric">
    <span className="fl-trade-kicker">{label}</span>
    <strong className={`fl-trade-metric__value fl-trade-metric__value--${tone}`}>{value}</strong>
    {note ? <span className={`fl-trade-metric__note${noteTone && tone !== "normal" ? ` fl-trade-metric__value--${tone}` : ""}`}>{note}</span> : null}
    {credit}
  </div>;
}

function Stepper({ value, suffix, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1 }: {
  readonly value: number;
  readonly suffix: string;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}) {
  const apply = (next: number) => onChange(Math.max(min, Math.min(max, Math.round(next / step) * step)));
  return <div className="fl-trade-stepper">
    <button type="button" onClick={() => apply(value - step)}>−</button>
    <input aria-label={suffix} type="number" value={value} min={min} max={max} step={step} onChange={(event) => apply(Number(event.target.value))} />
    <span>{suffix}</span>
    <button type="button" onClick={() => apply(value + step)}>+</button>
  </div>;
}

/**
 * What "no time limit" means for THIS draft, stated the way the worker
 * actually behaves: a blank time limit gives the model the clock, while a
 * blank price threshold gives it the corresponding price authority (`runExits`).
 */
export function noLimitNote(draft: Pick<TradeSettings, "takeProfitBps" | "stopLossBps">): string {
  const rules = [draft.takeProfitBps === null ? null : "take profit", draft.stopLossBps === null ? null : "stop loss"].filter((rule): rule is string => rule !== null);
  if (rules.length === 0) return "No time limit \u2014 the model decides when to exit.";
  return `No time limit \u2014 the model decides when to exit; ${rules.join(" or ")} still apply.`;
  const model = draft.takeProfitBps === null || draft.stopLossBps === null;
  if (rules.length === 0) return "No time limit — positions exit only when the model says so.";
  return `No time limit — positions exit only on ${rules.join(" or ")}${model ? ", or when the model says so" : ""}.`;
}

/** The wire code as words: "crash-stop" → "crash stop", as the open-position plan already renders reasons (AUDIT A1). */
export function closeReasonLabel(reason: TradePositionView["closeReason"]): string {
  if (reason === "trailing-stop") return "Trailing stop";
  if (reason === "stale-exit") return "Stale position exit";
  return reason === null ? "—" : reason.replace(/-/gu, " ");
}

function operationData(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

function budgetError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { readonly error?: { readonly message?: unknown; readonly code?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : typeof error?.code === "string" ? error.code : fallback;
}

function friendlyCmcReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined || reason === "") return null;
  const messages: Record<string, string> = {
    budget_setup_required: "Set up the agent wallet's finite USDT data budget.",
    budget_exhausted: "The finite USDT data budget is exhausted. Add a top-up to continue advisory data requests.",
    "cmc-capability-matrix-unproven": "This wallet's account version has not been proven for data payments.",
    "cmc-capability-read-failed": "The wallet's data-access capability could not be verified. Try again later.",
    news_disabled: "Advisory data is disabled.",
    owner_auth_required: "Authorize Account access to continue the pending data-access operation.",
    account_session_required: "Authorize Account access to continue the pending data-access operation.",
    trade_not_ready: "The execution service is not ready to process data access yet.",
    session_changed: "The trading session changed. Rebind data access to the new session.",
    session_rebind_required: "The trading session was renewed. Rebind data access to the new session.",
    // CMC-HIRE-SETUP R6.3: the two reasons a hire lands on when R5's continuation
    // step is skipped, which previously fell through to the generic text.
    "cmc-profile-unavailable": "Data payments have not been reviewed for this agent's session shape yet.",
    "cmc-session-spec-unavailable": "The agent's session could not be read for data payments. Refresh the agent and try again.",
  };
  return messages[reason] ?? "Data access is unavailable right now. Refresh the agent and try again.";
}

function friendlyCmcError(error: string): string {
  if (/owner_auth_required|account_session_required|ambiguous_owner_auth/iu.test(error)) return "Authorize Account access to continue the pending data-access operation.";
  if (/prepared CMC owner|prepared CMC|call batch|allowance call|checker call|native-value|key transition|signed Permit2 delta|persisted operation/iu.test(error)) {
    return "The saved data-access operation no longer matches this agent. Refresh the agent and try again.";
  }
  // 2026-09-23: the plane names a capability-gate refusal by its reason code.
  if (/^cmc-[a-z0-9-]+$/u.test(error)) return friendlyCmcReason(error)!;
  if (/capability|unavailable|not proven/iu.test(error)) return "Data access is unavailable for this wallet right now.";
  if (/^[a-z0-9_.-]+$/u.test(error) || /CMC budget|trade_not_ready/iu.test(error)) return "The data-access operation is unavailable right now. Refresh the agent and try again.";
  return error;
}

/** Owner-readable CMC log (2026-09-20): every paid attempt and every cached context, newest first. */
export function CmcLog({ log }: { readonly log: TradeView["cmcLog"] | undefined }) {
  // Operator 2026-09-21: charges (what was paid, with the settle tx) and data
  // (what came back) are two different questions — two lists, one switch.
  const [kind, setKind] = useState<"charges" | "data">("charges");
  const attemptLabel: Record<string, string> = { settled: "Charged and settled on chain", released: "Not charged (expired unused)", unknown: "Disclosed — awaiting settlement proof",
    transmitting: "Request in flight", prepared: "Reserved, not yet sent", reserved: "Reserved" };
  const attempts = log?.attempts ?? [];
  const news = log?.news ?? [];
  return <div className="fl-run-feed">
    <div className="fl-run-filters">{([["charges", `Charges (${attempts.length})`], ["data", `Data log (${news.length})`]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} className={kind === value ? "is-active" : ""} onClick={() => setKind(value)}>{label}</button>)}</div>
    <div className="fl-run-scroll" role="region" aria-label={kind === "charges" ? "CMC charges" : "CMC data log"} tabIndex={0}>
    {kind === "charges" ? attempts.map((attempt) => <details className="fl-run-card" key={attempt.operationId}>
      <summary><span className={`fl-run-dot ${attempt.state === "settled" ? "is-active" : ""}`} /><div><strong>{attemptLabel[attempt.state] ?? attempt.state}</strong><p>{usdt2(attempt.amountWei)} · content {attempt.contentState}</p></div><time>{relativeTime(attempt.createdAt, Date.now()).text}</time></summary>
      <div className="fl-run-detail"><div className="fl-run-meta">{new Date(attempt.createdAt).toLocaleString()} · Operation {attempt.operationId}</div>
        {attempt.txHash ? <p>Settle tx: <a href={txUrl(attempt.txHash)!} target="_blank" rel="noreferrer">{attempt.txHash.slice(0, 12)}…{attempt.txHash.slice(-6)}</a></p> : attempt.settlementTxHint ? <p>Settlement hint: {attempt.settlementTxHint.slice(0, 12)}…</p> : <p>No settlement transaction recorded yet.</p>}
      </div>
    </details>) : news.map((row) => <details className="fl-run-card" key={`${row.ticker}:${row.skill}:${row.asOfMs}`}>
      <summary><span className={`fl-run-dot ${row.status === "available" ? "is-active" : ""}`} /><div><strong>{row.ticker} · {row.skill.replace(/_/gu, " ")}</strong>{row.requestedBy === "llm" ? <p>LLM requested: {row.requestReason ?? "-"}</p> : null}<p>{row.status} · valid until {new Date(row.expiresAtMs).toLocaleTimeString()}</p></div><time>{relativeTime(row.asOfMs, Date.now()).text}</time></summary>
      <div className="fl-run-detail"><div className="fl-run-meta">{new Date(row.asOfMs).toLocaleString()}{row.paymentOperationId ? ` · paid by ${row.paymentOperationId}` : ""}</div>
        <pre className="fl-cmc-context">{row.context ?? "No context text was retained."}</pre>
      </div>
    </details>)}
    {(kind === "charges" ? attempts : news).length === 0 ? <div className="fl-trade-empty">{kind === "charges" ? "No CMC charges yet." : "No CMC data retained yet."}</div> : null}
    </div>
  </div>;
}

function CmcBudgetPanel(props: {
  readonly agentId: string;
  readonly view: AgentDetailView | null;
  readonly settings: TradeSettings;
  readonly budget: TradeView["cmcBudget"];
  readonly renewalStatus?: React.ReactNode;
  readonly owner?: Props["cmcOwner"];
  readonly refresh: () => Promise<unknown>;
}) {
  const enabled = props.settings.settlementAsset === "USDT" && props.settings.cmcNewsEnabled === true;
  const walletAddress = props.view?.walletAddress ?? props.owner?.passkey?.walletAddress ?? null;
  const pendingKey = cmcPendingStorageKey(props.owner?.ownerAddress, walletAddress, props.agentId);
  const [pending, setPending] = useState<CmcPendingOperation | null>(() => readCmcPending(pendingKey));
  const [amount, setAmount] = useState(() => usdt(props.settings.cmcTotalBudgetWei ?? "2000000000000000000").replace(/ USDT$/u, ""));
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submitting = React.useRef(false);
  useEffect(() => {
    const loaded = readCmcPending(pendingKey);
    const matches = loaded !== null && (props.owner?.ownerAddress === undefined || loaded.ownerAddress.toLowerCase() === props.owner.ownerAddress.toLowerCase())
      && (walletAddress === null || loaded.walletAddress.toLowerCase() === walletAddress.toLowerCase()) && loaded.agentId === props.agentId;
    if (loaded !== null && !matches) clearCmcPending(pendingKey);
    setPending(matches ? loaded : null);
  }, [pendingKey, props.agentId, props.owner?.ownerAddress, walletAddress, props.budget, props.renewalStatus]);
  if (props.settings.settlementAsset !== "USDT") return null;
  const budget = props.budget;
  const status = enabled ? budget?.status ?? "setup-required" : "disabled";
  const remaining = budget?.remainingWei ?? "0";
  const rebindRequired = status === "setup-required" && (budget?.generation ?? 0) > 0;
  const initialSetup = status === "setup-required" && !rebindRequired;

  const accountPost = async (path: string, body: string): Promise<Response> => {
    let response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" });
    if (response.status === 401 && props.owner?.signReadHeader !== undefined) {
      const ownerRead = await props.owner.signReadHeader(props.agentId);
      response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-owner-action": ownerRead }, body, cache: "no-store" });
    }
    return response;
  };

  const confirmPending = async (operation: CmcPendingOperation, callsId: `0x${string}`): Promise<void> => {
    const response = await accountPost(`/api/agents/${encodeURIComponent(props.agentId)}/trade/cmc-budget/confirm`, JSON.stringify({ operationId: operation.operationId, callsId }));
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setMessage(friendlyCmcError(budgetError(payload, "Confirmation is still pending.")));
      return;
    }
    clearCmcPending(pendingKey);
    setPending(null);
    setMessage("Setup submitted. Waiting for on-chain confirmation.");
    await props.refresh();
  };

  const submit = async (): Promise<void> => {
    if (!enabled) return;
    if (working || submitting.current) return;
    // A pending record WITHOUT a callsId was prepared but never signed (the
    // passkey step failed or the tab closed); resume it with the same
    // operation/attempt ids — the plane returns the same prepared operation.
    const resume = pending !== null && pending.callsId === null ? pending : null;
    if (pending !== null && pending.callsId !== null) {
      submitting.current = true;
      setWorking(true);
      setMessage(null);
      try { await confirmPending(pending, pending.callsId); }
      catch (error) { setMessage(friendlyCmcError(error instanceof Error ? error.message : "Confirmation is still pending.")); }
      finally { setWorking(false); }
      return;
    }
    if (props.owner?.passkey === null || props.owner === undefined) {
      setMessage("Connect the passkey wallet that owns this agent to set up data access.");
      return;
    }
    if (props.view?.sessionPublicKey === null || props.view?.sessionPublicKey === undefined || props.view.sessionExpiresAt === null || props.view.sessionExpiresAt === undefined || props.view.walletAddress === null) {
      setMessage("The active trading session is unavailable. Renew the agent before setting up data access.");
      return;
    }
    if (props.owner.passkey.walletAddress === undefined || props.owner.passkey.walletAddress.toLowerCase() !== props.view.walletAddress.toLowerCase()) {
      setMessage("The passkey wallet does not match this agent wallet. Switch to the wallet that owns this agent.");
      return;
    }
    const mode = resume?.mode ?? (budget?.status === "setup-required" && budget.generation > 0 ? "rebind" as const : "topup" as const);
    const additionalBudgetWei = resume?.incrementWei ?? (mode === "rebind" ? "0" : initialSetup ? props.settings.cmcTotalBudgetWei : parseUsdtInput(amount));
    if (additionalBudgetWei === undefined || additionalBudgetWei === null || mode === "topup" && BigInt(additionalBudgetWei) <= 0n) {
      setMessage("Enter a positive USDT top-up amount.");
      return;
    }
    const operationId = resume?.operationId ?? crypto.randomUUID().toLowerCase();
    const attemptId = resume?.attemptId ?? crypto.randomUUID().toLowerCase();
    const expectedGeneration = resume?.expectedGeneration ?? budget?.generation ?? 0;
    submitting.current = true;
    setWorking(true);
    setMessage(null);
    try {
      const preparedEnvelope = await props.owner.signEnvelope("tradeCmcBudget", props.agentId, {
        mode, expectedGeneration, additionalBudgetWei,
        sessionPublicKey: props.view.sessionPublicKey, sessionExpiry: props.view.sessionExpiresAt, operationId,
      });
      const preparedResponse = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/trade/cmc-budget`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(preparedEnvelope), cache: "no-store",
      });
      const preparedPayload: unknown = await preparedResponse.json().catch(() => null);
      if (!preparedResponse.ok) throw new Error(friendlyCmcError(budgetError(preparedPayload, "Data-access setup was rejected.")));
      const prepared = operationData(preparedPayload);
      const returnedOperationId = prepared?.operationId;
      if (returnedOperationId !== operationId) throw new Error("CMC budget setup returned a different operation.");
      if (prepared === null) throw new Error("Data-access setup is unavailable until the execution plane returns the verified owner call batch.");
      // The plane now holds this operation; remember it BEFORE validating so a
      // validation or passkey failure can be resumed instead of leaving the
      // plane with a held operation the browser has forgotten.
      const pendingOperation: CmcPendingOperation = { version: 1, ownerAddress: props.owner.ownerAddress ?? "", walletAddress: props.view.walletAddress,
        agentId: props.agentId, operationId, attemptId, callsId: null, mode, expectedGeneration, incrementWei: additionalBudgetWei,
        sessionPublicKey: props.view.sessionPublicKey as `0x${string}`, sessionExpiry: props.view.sessionExpiresAt };
      writeCmcPending(pendingKey, pendingOperation);
      setPending(pendingOperation);
      const calls = validateCmcBudgetCallPlan({ prepared, operationId, mode, incrementWei: additionalBudgetWei,
        expectedGeneration, sessionPublicKey: props.view.sessionPublicKey as Hex, wallet: props.view.walletAddress as `0x${string}` });
      const attemptResponse = await accountPost(`/api/agents/${encodeURIComponent(props.agentId)}/trade/cmc-budget/attempt`, JSON.stringify({ operationId, attemptId }));
      const attemptPayload: unknown = await attemptResponse.json().catch(() => null);
      if (!attemptResponse.ok) throw new Error(friendlyCmcError(budgetError(attemptPayload, "The data-access attempt could not be recorded.")));
      const result = await executeCmcBudgetCalls({ record: props.owner.passkey, calls });
      if (result.status === "FAILED") {
        setMessage("The data-access wallet operation failed. It was kept for explicit recovery and was not retried.");
        return;
      }
      const withCallsId = { ...pendingOperation, callsId: result.callsId };
      writeCmcPending(pendingKey, withCallsId);
      setPending(withCallsId);
      await confirmPending(withCallsId, result.callsId);
    } catch (error) {
      setMessage(friendlyCmcError(error instanceof Error ? error.message : "Data-access setup could not be completed."));
    } finally {
      setWorking(false);
      submitting.current = false;
    }
  };

  const statusText = status === "disabled" ? "Off"
    : status === "setup-required" ? "Setup required"
      : status === "pending" ? "Pending owner evidence"
        : status === "ready" ? "Ready"
          : status === "exhausted" ? "Exhausted"
            : "Unavailable";
  return <section className="fl-trade-budget" data-testid="cmc-budget-panel">
    <div className="fl-trade-budget__head"><div><span className="fl-trade-kicker">CMC data (x402)</span><p>Optional market data, paid from a fixed USDT budget. Never blocks exits.</p></div><strong data-testid="cmc-budget-status">{statusText}</strong></div>
    {enabled ? <>
      <div className="fl-trade-budget__facts"><span>Remaining <b>{usdt2(remaining)}</b></span><span>Total <b>{usdt2(budget?.authorizedTotalWei ?? props.settings.cmcTotalBudgetWei ?? null)}</b></span>{BigInt(budget?.adoptedWei ?? "0") > 0n ? <span><b>{usdt2(budget!.adoptedWei!)}</b> carried over from an earlier agent on this wallet</span> : null}{budget?.reason ? <span>{friendlyCmcReason(budget.reason)}</span> : null}</div>
      {status === "ready" || status === "exhausted" ? <label>Renew data budget
        <div className="fl-trade-budget__input"><input aria-label="CMC top-up amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><span>USDT</span></div>
      </label> : null}
      {rebindRequired ? <p className="fl-trade-budget__note">The trading session changed. Rebind data access to the new session without changing the remaining budget.</p> : null}
      {status === "setup-required" && initialSetup ? <p className="fl-trade-budget__note">Set up a separate finite USDT data allowance in the agent wallet. It does not give the trading session authority over that allowance. A compromised trading key could clear (not spend) this allowance; top it up again if that happens.</p> : null}
      {pending !== null && pending.callsId === null ? <p className="fl-trade-budget__note">A prepared data-access operation was not signed yet. Resume it; the plane returns the same operation and calls.</p>
        : status === "pending" ? <p className="fl-trade-budget__note">A previous data-access operation is held. Do not sign another operation while it is unresolved.</p> : null}
      {status === "unavailable" && !message ? <p className="fl-trade-budget__note">{friendlyCmcReason(budget?.reason) ?? "Not ready yet: payment capability is not verified for this wallet."}</p> : null}
      {pending?.callsId !== null && pending !== null ? <Button variant="secondary" disabled={working} onClick={() => void submit()}>{working ? "Checking finalized evidence…" : "Confirm pending data setup"}</Button>
        : pending !== null ? <Button variant="secondary" disabled={working} onClick={() => void submit()}>{working ? "Waiting for owner evidence…" : "Resume data setup"}</Button>
          : rebindRequired ? <Button variant="secondary" disabled={working} onClick={() => void submit()}>{working ? "Preparing rebind…" : "Rebind data access"}</Button>
          : status === "setup-required" || status === "ready" || status === "exhausted" ? <Button variant="secondary" disabled={working} onClick={() => void submit()}>{working ? "Waiting for owner evidence…" : status === "setup-required" ? "Set up data budget" : "Renew data budget"}</Button> : null}
    </> : <p className="fl-trade-budget__note">News enrichment is disabled. No paid request or payer setup is performed.</p>}
    {message ? <p className="fl-trade-budget__message" role="status">{message}</p> : null}
  </section>;
}

function EditPanel({ initial, onCancel, onSave, busy }: {
  readonly initial: TradeSettings;
  readonly onCancel: () => void;
  readonly onSave: (settings: TradeSettings) => Promise<void>;
  readonly busy: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const v2 = initial.settlementAsset === "USDT";
  const schedule = v2 && initial.tradeMode === "schedule";
  const dcaMode = v2 && initial.tradeMode === "dca";
  const portfolioMode = v2 && initial.tradeMode === "portfolio";
  const [minEntry, setMinEntry] = useState(() => usdt(initial.minEntryWei ?? "0").replace(/ USDT$/u, ""));
  const [maxEntry, setMaxEntry] = useState(() => usdt(initial.entryWei).replace(/ USDT$/u, ""));
  const [cmcBudget, setCmcBudget] = useState(() => usdt(initial.cmcTotalBudgetWei ?? "2000000000000000000").replace(/ USDT$/u, ""));
  const submit = async () => {
    let next = draft;
    if (schedule) {
      if (draft.scheduleEndKind === "date" && (draft.scheduleEndAtSec === null || draft.scheduleEndAtSec === undefined)) {
        setEditError("Pick an end date.");
        return;
      }
      if (draft.scheduleEndKind === "runs"
        && (draft.scheduleEndRuns === null || draft.scheduleEndRuns === undefined || draft.scheduleEndRuns < 1 || draft.scheduleEndRuns > 1_000)) {
        setEditError("Enter a number of runs from 1 through 1000.");
        return;
      }
    } else if (v2 && !dcaMode && !portfolioMode) {
      const minEntryWei = parseUsdtInput(minEntry);
      const maxEntryWei = parseUsdtInput(maxEntry);
      if (minEntryWei === null || maxEntryWei === null || BigInt(minEntryWei) <= 0n || BigInt(maxEntryWei) < BigInt(minEntryWei)) {
        setEditError("Enter positive USDT bounds with Max entry at least Min entry.");
        return;
      }
      const cmcBudgetWei = draft.cmcNewsEnabled === true ? parseUsdtInput(cmcBudget) : null;
      if (draft.cmcNewsEnabled === true && (cmcBudgetWei === null || BigInt(cmcBudgetWei) <= 0n)) {
        setEditError("Enter a positive total CMC budget in USDT.");
        return;
      }
      next = {
        ...draft,
        minEntryWei,
        entryWei: maxEntryWei,
        ...(draft.cmcNewsEnabled === true
          ? { cmcNewsEnabled: true, cmcTotalBudgetWei: cmcBudgetWei! }
          : { cmcNewsEnabled: false, cmcTotalBudgetWei: undefined }),
      };
    }
    setSaving(true);
    setEditError(null);
    try { await onSave(next); onCancel(); }
    finally { setSaving(false); }
  };
  if (dcaMode) {
    // D16: after hire only the slippage and the stop loss can change; the take profit is locked.
    return <section className="fl-trade-edit">
      <div className="fl-trade-edit__intro">
        <div><span className="fl-trade-kicker">Auto DCA</span><p>Live deployment settings. Only the slippage and the stop loss can change; the take profit is locked.</p></div>
      </div>
      <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
        <label><span>Slippage tolerance</span><Stepper value={draft.slippageBps / 100} suffix="%" min={0.5} max={5} step={0.5} onChange={(value) => setDraft({ ...draft, slippageBps: Math.round(value * 100) })} /><small>Between 0.5% and 5%.</small></label>
        <label><span><input type="checkbox" checked={draft.dcaStopLossBps !== null && draft.dcaStopLossBps !== undefined} onChange={(event) => setDraft({ ...draft, dcaStopLossBps: event.target.checked ? 1_500 : null })} /> Stop loss</span>
          <Stepper value={(draft.dcaStopLossBps ?? 1_500) / 100} suffix="%" min={1} max={99} onChange={(value) => setDraft({ ...draft, dcaStopLossBps: Math.round(value * 100) })} /><small>Measured on your total deposit.</small></label>
      </div>
      {editError ? <p className="fl-trade-edit__error" role="alert">{editError}</p> : null}
      <div className="fl-trade-edit__footer"><Button variant="primary" disabled={busy || saving} onClick={() => void submit()}>Save</Button><Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button><span>Changes apply to the live agent immediately.</span></div>
    </section>;
  }
  if (portfolioMode) {
    return <section className="fl-trade-edit"><div className="fl-trade-edit__intro"><div><span className="fl-trade-kicker">Smart Portfolio</span><p>Only slippage can change after hire.</p></div></div>
      <div className="fl-trade-edit__grid fl-trade-edit__grid--three"><label><span>Slippage tolerance</span>
        <Stepper value={draft.slippageBps / 100} suffix="%" min={0.5} max={5} step={0.5} onChange={(value) => setDraft({ ...draft, slippageBps: Math.round(value * 100) })} />
      </label></div>
      {editError ? <p className="fl-trade-edit__error" role="alert">{editError}</p> : null}
      <div className="fl-trade-edit__footer"><Button variant="primary" disabled={busy || saving} onClick={() => void submit()}>Save</Button><Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button></div>
    </section>;
  }
  if (schedule) {
    return <section className="fl-trade-edit">
      <div className="fl-trade-edit__intro">
        <div><span className="fl-trade-kicker">Schedule buy</span><p>Live deployment settings. Only the controls enabled below can change.</p></div>
      </div>
      <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
        <label><span>Frequency</span><select value={draft.scheduleIntervalSec ?? 86400} onChange={(event) => setDraft({ ...draft, scheduleIntervalSec: Number(event.target.value) as NonNullable<TradeSettings["scheduleIntervalSec"]> })}>
          <option value={3600}>1 hour</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option><option value={43200}>12 hours</option><option value={86400}>Daily</option>
        </select><small>Cycles keep counting from the hire time under the new frequency; the signed BNB cap does not change.</small></label>
        <label><span>Slippage tolerance</span><Stepper value={draft.slippageBps / 100} suffix="%" min={0.5} max={5} step={0.5} onChange={(value) => setDraft({ ...draft, slippageBps: Math.round(value * 100) })} /><small>Between 0.5% and 5%.</small></label>
        <label><span>Max premium to NAV</span><Stepper value={(draft.scheduleMaxPremiumBps ?? 150) / 100} suffix="%" min={0.5} max={1.5} step={0.1} onChange={(value) => setDraft({ ...draft, scheduleMaxPremiumBps: Math.round(value * 100) })} /><small>Between 0.5% and 1.5%; the platform never buys above +1.5% regardless.</small></label>
        <label><span><input type="checkbox" checked={draft.scheduleMarketHoursOnly === true} onChange={(event) => setDraft({ ...draft, scheduleMarketHoursOnly: event.target.checked })} /> Market hours only</span><small>Exchange holidays are not modelled.</small></label>
      </div>
      <div className="fl-trade-kicker">Finish</div>
      <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
        <label><span>End rule</span><select value={draft.scheduleEndKind} onChange={(event) => {
          const kind = event.target.value as NonNullable<TradeSettings["scheduleEndKind"]>;
          setDraft({ ...draft, scheduleEndKind: kind,
            scheduleEndAtSec: kind === "date" ? draft.scheduleEndAtSec ?? Math.floor(Date.now() / 1_000) + 86_400 : null,
            scheduleEndRuns: kind === "runs" ? draft.scheduleEndRuns ?? 1 : null });
        }}>
          <option value="budget">Run until the budget is spent</option>
          <option value="date">Run until a date</option>
          <option value="runs">Run a set number of times</option>
        </select></label>
        {draft.scheduleEndKind === "date" ? <label><span>End date</span>
          <input type="date" value={draft.scheduleEndAtSec ? new Date(draft.scheduleEndAtSec * 1_000).toISOString().slice(0, 10) : ""}
            onChange={(event) => setDraft({ ...draft, scheduleEndAtSec: event.target.value === "" ? null : Math.floor(new Date(`${event.target.value}T23:59:59`).getTime() / 1_000) })} />
        </label> : null}
        {draft.scheduleEndKind === "runs" ? <label><span>Number of runs</span>
          <Stepper value={draft.scheduleEndRuns ?? 1} suffix="runs" min={1} max={1_000} onChange={(value) => setDraft({ ...draft, scheduleEndRuns: Math.round(value) })} />
        </label> : null}
      </div>
      {editError ? <p className="fl-trade-edit__error" role="alert">{editError}</p> : null}
      <div className="fl-trade-edit__footer"><Button variant="primary" disabled={busy || saving} onClick={() => void submit()}>Save</Button><Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button><span>Changes apply to the live agent immediately.</span></div>
    </section>;
  }
  return <section className="fl-trade-edit">
    <div className="fl-trade-edit__intro">
      <div><span className="fl-trade-kicker">Execution model</span><p>Live deployment settings. Only the controls enabled below can change.</p></div>
      <button type="button" className="fl-trade-reset" onClick={() => setDraft({ ...draft, noReentry: true, takeProfitBps: 10_000, stopLossBps: 5_000, maxHoldSec: 7_200, crashProtection: true, slippageBps: 300, primaryModel: "0gm-1.0-35b-a3b", fallbackModel: "glm-5.3-flash" })}>Reset parameters to defaults</button>
    </div>
    {v2 ? <>
      <div className="fl-trade-kicker">Settlement</div>
      <div className="fl-trade-edit__grid fl-trade-edit__grid--four">
        <label><span>Settlement asset</span><input value="USDT" readOnly /></label>
        <label><span>Min entry</span><div className="fl-trade-edit__amount"><input inputMode="decimal" value={minEntry} onChange={(event) => setMinEntry(event.target.value)} /><span>USDT</span></div></label>
        <label><span>Max entry</span><div className="fl-trade-edit__amount"><input inputMode="decimal" value={maxEntry} onChange={(event) => setMaxEntry(event.target.value)} /><span>USDT</span></div></label>
        <label><span>Principal capital</span><div className="fl-trade-edit__amount"><input value={usdt(draft.capitalQuoteWei ?? null).replace(/ USDT$/u, "")} readOnly /><span>USDT</span></div><small>Signed principal ceiling; change requires the hire authority path.</small></label>
      </div>
      <div className="fl-trade-edit__check"><input id="trade-cmc-news" type="checkbox" checked={draft.cmcNewsEnabled === true} onChange={(event) => setDraft({ ...draft, cmcNewsEnabled: event.target.checked })} /><label htmlFor="trade-cmc-news">CMC Agent Hub x402</label>{draft.cmcNewsEnabled === true ? <><div className="fl-trade-edit__amount"><input aria-label="CMC total budget" inputMode="decimal" value={cmcBudget} readOnly={initial.cmcNewsEnabled === true} onChange={(event) => setCmcBudget(event.target.value)} /><span>USDT</span></div><small>{initial.cmcNewsEnabled === true ? `Budget top-ups use the owner action below; the signed total stays ${usdt(draft.cmcTotalBudgetWei ?? null)}.` : "Initial total budget is owner signed before paid setup."}</small></> : <small>Off — no paid data request.</small>}</div>
    </> : null}
    <div className="fl-trade-edit__check"><input id="trade-no-reentry" type="checkbox" checked={draft.noReentry} onChange={(event) => setDraft({ ...draft, noReentry: event.target.checked })} /><label htmlFor="trade-no-reentry">No re-entry</label></div>
    <div className="fl-trade-kicker">Exit</div>
    <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
      <label><span><input type="checkbox" checked={draft.takeProfitBps !== null} onChange={(event) => setDraft({ ...draft, takeProfitBps: event.target.checked ? 10_000 : null })} /> Take profit</span><Stepper value={(draft.takeProfitBps ?? 10_000) / 100} suffix="%" min={1} max={100} onChange={(value) => setDraft({ ...draft, takeProfitBps: Math.round(value * 100) })} /></label>
      <label><span><input type="checkbox" checked={draft.stopLossBps !== null} onChange={(event) => setDraft({ ...draft, stopLossBps: event.target.checked ? 5_000 : null })} /> Stop loss</span><Stepper value={stopLossPercentFromBps(draft.stopLossBps ?? 5_000)} suffix="%" min={-100} max={-1} onChange={(value) => setDraft({ ...draft, stopLossBps: stopLossBpsFromPercent(value) })} /></label>
      {/* `null` on the wire is "no limit" (settings.ts), so the control must be able
          to show and set it: before 2026-09-15 this stepper displayed `?? 7_200` as
          "120 min" over a live agent that had no limit at all, and its min of 1
          made the true value unreachable from here. Untick = no time limit. */}
      <label><span><input type="checkbox" checked={draft.maxHoldSec !== null} onChange={(event) => setDraft({ ...draft, maxHoldSec: event.target.checked ? 7_200 : null })} /> Max holding time</span>
        {draft.maxHoldSec === null
          ? <small className="fl-trade-edit__no-limit">{noLimitNote(draft)}</small>
          : <Stepper value={Math.round(draft.maxHoldSec / 60)} suffix="min" min={1} max={10_080} onChange={(value) => setDraft({ ...draft, maxHoldSec: value * 60 })} />}
      </label>
      <label><span><input type="checkbox" checked={draft.crashProtection === true} onChange={(event) => setDraft({ ...draft, crashProtection: event.target.checked })} /> Crash protection</span><small>Two comparable price observations confirm a protective exit.</small></label>
    </div>
    <div className="fl-trade-kicker">Risk and execution</div>
    <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
      <label><span>Slippage tolerance</span><Stepper value={draft.slippageBps / 100} suffix="%" min={0.5} max={5} step={0.5} onChange={(value) => setDraft({ ...draft, slippageBps: Math.round(value * 100) })} /><small>Between 0.5% and 5%.</small></label>
      <label><span>Primary model</span><select value={draft.primaryModel} onChange={(event) => setDraft({ ...draft, primaryModel: event.target.value as TradeSettings["primaryModel"] })}>{TRADE_LLM_MODELS.map((model) => <option key={model.id} value={model.id} disabled={model.id === draft.fallbackModel}>{model.label}</option>)}</select></label>
      <label><span>Fallback model</span><select value={draft.fallbackModel} onChange={(event) => setDraft({ ...draft, fallbackModel: event.target.value as TradeSettings["fallbackModel"] })}>{TRADE_LLM_MODELS.map((model) => <option key={model.id} value={model.id} disabled={model.id === draft.primaryModel}>{model.label}</option>)}</select></label>
    </div>
    {editError ? <p className="fl-trade-edit__error" role="alert">{editError}</p> : null}
    <div className="fl-trade-edit__footer"><Button variant="primary" disabled={busy || saving} onClick={() => void submit()}>Save</Button><Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button><span>Changes apply to the live agent immediately.</span></div>
  </section>;
}

function verifiedRealised(position: TradePositionView): boolean {
  return position.fillStatus === "verified" && position.tokenAmount !== null
    && position.soldTokenAmount === position.tokenAmount
    && position.exitFillStatus === "verified" && position.exitWei !== null;
}

/** What a position row reads from the agent settings; the read-only Agentic page supplies it from its public settings. */
export type PositionRowSettings = Pick<TradeSettings, "settlementAsset" | "takeProfitBps" | "stopLossBps" | "maxHoldSec">;

/** `onSell` absent hides the Sell button and `plan` replaces the Exit plan cell (the read-only Agentic page, for kept holdings). */
export function PositionRow({ position, open, icon, expanded, onExpand, onSell, busy, settings, usdRate, schedule = false, plan }: {
  readonly position: TradePositionView;
  readonly open: boolean;
  readonly icon: string | null;
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly onSell?: () => void;
  readonly busy: boolean;
  readonly settings: PositionRowSettings | null;
  readonly usdRate?: number | null;
  readonly schedule?: boolean;
  readonly plan?: React.ReactNode;
}) {
  const symbol = positionSymbol(position);
  const asset = positionSettlementAsset(position, settings);
  const entryAtomic = positionEntryAtomic(position);
  const realised = open || verifiedRealised(position);
  const pnlWei = open ? positionPnlWei(position) : !realised || position.exitWei === null ? null : (BigInt(position.exitWei) - BigInt(entryAtomic)).toString(10);
  const pnl = open ? position.observation?.pnlBps ?? position.pnlBps : realised ? position.pnlBps : null;
  const tone = pnl === null ? "flat" : BigInt(pnl) < 0n ? "loss" : "profit";
  const marker: readonly MarketChartMarker[] = [{ timestamp: position.openedAt, side: "buy" }];
  return <>
    <div className="fl-trade-position">
      <div className="fl-trade-position__token"><TokenIcon src={icon} symbol={symbol} size={26} /><span><strong>{symbol} / {asset}</strong><small>{compactAddress(position.token)}</small></span></div>
      <div className="fl-trade-position__age">{positionAge(position)}</div>
      <div className="fl-trade-position__size"><strong>{tokenAmount(position)} <small>{symbol}</small></strong><span>{settlementAmount(entryAtomic, asset)} total</span><span>@ {entryPricePerToken(position, asset)} / {symbol}</span></div>
      <div className="fl-trade-position__plan">
        {plan !== undefined ? plan : open ? (settings?.takeProfitBps === null || settings?.takeProfitBps === undefined) && (settings?.stopLossBps === null || settings?.stopLossBps === undefined)
          ? <strong><i className="is-tp" />LLM decides</strong>
          : <><strong><i className="is-tp" />TP {settings?.takeProfitBps === null || settings?.takeProfitBps === undefined ? "LLM decides" : `${bps(settings.takeProfitBps)} pending`}</strong><span><i />Stop {settings?.stopLossBps === null || settings?.stopLossBps === undefined ? "LLM decides" : bps(-settings.stopLossBps)}</span></> : <><strong>{position.closeReason?.replace(/-/gu, " ") ?? "closed"}</strong><span>{position.exitFillStatus === "verified" ? "verified fill" : "unverified fill"}</span></>}
      </div>
      <button type="button" className={`fl-trade-chart-button ${expanded ? "is-active" : ""}`} aria-label={`${expanded ? "Hide" : "Show"} ${symbol} chart`} onClick={onExpand}><Icon name="yield" size={18} /></button>
      <div className={`fl-trade-position__pnl is-${tone}`}><strong>{asset === "USDT" ? usdt2(pnlWei, true) : fiat(pnlWei, usdRate ?? null, true)}</strong><span>{bps(pnl, true)}</span></div>
      <div className="fl-trade-position__actions">
        {open && !schedule && onSell !== undefined ? <Button variant="danger" size="sm" disabled={busy || position.exitRequestedAt !== null} onClick={onSell}>{position.exitRequestedAt === null ? "Sell" : "Selling"}</Button> : null}
        {txUrl(open ? position.entryTxHash : position.exitTxHash) ? <a href={txUrl(open ? position.entryTxHash : position.exitTxHash)!} target="_blank" rel="noreferrer">Tx <Icon name="external" size={11} /></a> : <span>—</span>}
      </div>
    </div>
    {expanded ? <div className="fl-trade-position__expanded">
      <div className="fl-trade-position__chart-head"><strong>{symbol} / {asset} {open ? "open position" : "closed position"}</strong><span className="is-entry">● Entry</span>{open ? <span className="is-tp">● TP</span> : null}<strong className={`is-${tone}`}>{bps(pnl, true)}</strong></div>
      <MarketChart kind="token" address={position.token} title={`${symbol} / ${asset}`} markers={marker} embedded height={230} />
      <div className="fl-trade-position__chart-foot"><span>ENTRY {new Date(position.openedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span>{open ? `HOLD ${Math.floor((Date.now() - position.openedAt) / 60_000)} / ${Math.round((settings?.maxHoldSec ?? 0) / 60)} MIN` : `CLOSED ${position.closedAt === null ? "—" : new Date(position.closedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`}</span></div>
    </div> : null}
  </>;
}

export function ClosedPositionRow({ position, icon, usdRate, settings }: {
  readonly position: TradePositionView;
  readonly icon: string | null;
  readonly usdRate: number | null;
  readonly settings: PositionRowSettings | null;
}) {
  const symbol = positionSymbol(position);
  const asset = positionSettlementAsset(position, settings);
  const entryAtomic = positionEntryAtomic(position);
  const complete = verifiedRealised(position);
  const pnlWei = complete && position.exitWei !== null
    ? (BigInt(position.exitWei) - BigInt(entryAtomic)).toString(10) : null;
  const tone = !complete || position.pnlBps === null ? "flat" : BigInt(position.pnlBps) < 0n ? "loss" : "profit";
  return <div className="fl-trade-position fl-trade-position--closed">
    <div className="fl-trade-position__token"><TokenIcon src={icon} symbol={symbol} size={26} /><span><strong>{symbol} / {asset}</strong><small>{compactAddress(position.token)}</small></span></div>
    <div className="fl-trade-position__reason"><span>{closeReasonLabel(position.closeReason)}</span>{position.closeNote ? <small>{position.closeNote}</small> : null}</div>
    <div>{heldDuration(position.openedAt, position.closedAt)}</div>
    <div>{tokenAmount(position)} {symbol}</div>
    <div><strong>{settlementAmount(entryAtomic, asset)}</strong><span className="fl-trade-position__closed-sub"> → {complete ? settlementAmount(position.exitWei, asset) : "—"}</span></div>
    <div className={`fl-trade-position__pnl is-${tone}`} title={complete ? undefined : "Realised result requires verified basis, sold amount, and proceeds."}><strong>{asset === "USDT" ? usdt2(pnlWei, true) : fiat(pnlWei, usdRate, true)}</strong><span>{complete ? bps(position.pnlBps, true) : "—"}</span></div>
    <div className="fl-trade-position__actions">{([["Buy", position.entryTxHash], ["Sell", position.exitTxHash]] as const).map(([label, hash]) => hash === null ? <span key={label}>{label} —</span> : <a key={label} href={txUrl(hash)!} target="_blank" rel="noreferrer">{label} <Icon name="external" size={11} /></a>)}</div>
  </div>;
}

/** AUTO-DCA §14.3: a level's state in words; R2.16's D5 state reads "skipped (below your price range)". */
const DCA_LEVEL_STATE: Readonly<Record<string, string>> = {
  pending: "pending", resting: "resting", filled: "filled", collected: "collected",
  skipped: "skipped (price moved past it)", "below-range": "skipped (below your price range)",
  cancelled: "cancelled", held: "held",
};

const DCA_READ_REASON: Readonly<Record<string, string>> = {
  "dca-unavailable": "The plane cannot read this agent's Auto DCA state.",
  "chain-unreadable": "The chain could not be read; refresh in a moment.",
  "no-active-round": "No active round.",
};

/**
 * DCA-DETAIL fix pass, MEDIUM 2: the reason a dash stands in for the market
 * price. An absent `mark` (an older plane, the NEW field does not exist)
 * always reads "Needs the updated execution plane.", regardless of the
 * pre-existing `reason` field; a present-but-null `mark` (a real read
 * failure on a current plane) reads the existing `DCA_READ_REASON`.
 */
function dcaMarketReason(dca: TradeDcaView): string | undefined {
  if (dca.mark === undefined) return "Needs the updated execution plane.";
  if (dca.mark === null) return DCA_READ_REASON[dca.reason ?? ""] ?? dca.reason ?? undefined;
  return undefined;
}

function dcaPrice(e8: string | null | undefined): string {
  if (e8 === null || e8 === undefined) return "—";
  const value = Number(e8) / 1e8;
  return Number.isFinite(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT` : "—";
}

function dcaStockAmount(wei: string | null | undefined, symbol: string): string {
  if (wei === null || wei === undefined || !/^\d+$/u.test(wei)) return "—";
  // Operator 2026-09-25: at most 3 decimals, truncated so a holding is never overstated.
  return `${(Math.floor(Number(formatEther(BigInt(wei))) * 1000) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} ${symbol}`;
}

type DcaRoundView = NonNullable<TradeDcaView["round"]>;

/** DCA-DETAIL §2: stock wei × mark, in USDT; "—" while the plane has no mark. */
function dcaVolumeApprox(stockWei: string, markE8: string | null | undefined): string {
  if (markE8 === null || markE8 === undefined) return "—";
  try { return usdt2(((BigInt(stockWei) * BigInt(markE8)) / 100_000_000n).toString(10)); } catch { return "—"; }
}

/** DCA-DETAIL §2's PnL-since-hire tile rule (a)/(b)/(c), amended by AUTO-DCA R4.7. */
function dcaPnlSinceHire(dca: TradeDcaView, capitalQuoteWei: string | undefined): { readonly value: string; readonly note?: string; readonly tone: "normal" | "profit" | "loss" } {
  if (capitalQuoteWei === undefined) return { value: "—", note: "Capital is not recorded for this agent.", tone: "normal" };
  let pnlWei: bigint | null = null;
  let realised = false;
  let markedDiffers = false;
  if (dca.equity !== null) pnlWei = BigInt(dca.equity.equityWei) - BigInt(capitalQuoteWei);
  else if (dca.round === null || dca.round.phase === "settled") {
    // A value that does not parse is "—" with its reason, never a number (audit LOW 10;
    // the same /^-?\d+$/u guard the Rounds row uses for these two fields).
    const realizedWei = /^-?\d+$/u.test(dca.rounds.realizedPnlWei) ? BigInt(dca.rounds.realizedPnlWei) : null;
    const markedWei = dca.rounds.markedPnlWei !== undefined && /^-?\d+$/u.test(dca.rounds.markedPnlWei) ? BigInt(dca.rounds.markedPnlWei) : null;
    pnlWei = markedWei ?? realizedWei;
    if (markedWei !== null && markedWei !== realizedWei) markedDiffers = true; else realised = true;
  }
  if (pnlWei === null) return { value: "—", note: DCA_READ_REASON[dca.reason ?? ""] ?? dca.reason ?? undefined, tone: "normal" };
  const capital = BigInt(capitalQuoteWei);
  const percent = capital > 0n ? bps(((pnlWei * 10_000n) / capital).toString(10), true) : undefined;
  const note = markedDiffers ? `incl. unsold ${dca.symbol}, marked at removal${percent === undefined ? "" : ` · ${percent}`}`
    : realised ? (percent === undefined ? "realised" : `realised · ${percent}`) : percent;
  return { value: usdt2(pnlWei.toString(10), true), note, tone: pnlWei > 0n ? "profit" : pnlWei < 0n ? "loss" : "normal" };
}

/**
 * The holding an ended Agentic DCA agent still has (AGENTIC-DCA-SPEC R31.3): the stock in the wallet, worth its value at the mark when the mark is readable,
 * or the chain-unreadable reason when the wallet read failed. No number appears without its source.
 */
function dcaEndedHoldingNote(dca: TradeDcaView, avgCostE8: string | null): string {
  const base = dca.wallet == null ? DCA_READ_REASON["chain-unreadable"]! : `Holding ${dcaStockAmount(dca.wallet.stockWei, dca.symbol)}${dca.mark == null ? "" : `, worth ${dcaVolumeApprox(dca.wallet.stockWei, dca.mark.e8)} at the market price`}`;
  return avgCostE8 === null ? `${base}; no stock was bought in the last round` : base;
}

/** DCA-DETAIL §2: the five tiles. `ended` (the Agentic public page, after a stop, a term end or an owner end) keeps the Average-price tile on the holding. */
export function DcaTiles({ dca, settings, live, ended }: { readonly dca: TradeDcaView; readonly settings: Pick<TradeSettings, "capitalQuoteWei"> | null; readonly live: boolean; readonly ended?: { readonly avgCostE8: string | null } }) {
  const pnl = dcaPnlSinceHire(dca, settings?.capitalQuoteWei);
  const marketReason = dcaMarketReason(dca);
  return <div className="fl-trade-metrics">
    <Metric label="Total Delegated" value={settings?.capitalQuoteWei === undefined ? "—" : usdt2(settings.capitalQuoteWei)} note={settings?.capitalQuoteWei === undefined ? "Capital is not recorded for this agent." : undefined} />
    <Metric label="Execution model" value="TradFi - Auto DCA" />
    <Metric label="PnL since hire" value={pnl.value} tone={pnl.tone} note={pnl.note} noteTone />
    {ended === undefined
      ? <Metric label="Average price" value={dcaPrice(dca.round?.avgCostE8)} note={dca.round === null ? (live ? "Setting up…" : "No round is open.") : `Holding ${dcaStockAmount(dca.round.stockHeldWei, dca.symbol)}`} />
      : <Metric label="Average price" value={dcaPrice(ended.avgCostE8)} note={dcaEndedHoldingNote(dca, ended.avgCostE8)} />}
    <Metric label="Market price" value={dca.mark === null || dca.mark === undefined ? "—" : dcaPrice(dca.mark.e8)} note={marketReason} />
  </div>;
}

/** The mock's plain label/value pair inside the Current round card. */
function DcaStat({ label, value, note, align }: { readonly label: string; readonly value: string; readonly note?: string; readonly align?: "end" }) {
  return <div style={{ display: "grid", gap: 8, justifyItems: align === "end" ? "end" : "start", minWidth: 0 }}>
    <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-sans)", color: "var(--text-subtle)" }}>{label}</span>
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1.2 var(--font-mono)", color: "var(--ink-1)", textAlign: align === "end" ? "right" : "left" }}>{value}</span>
    {note ? <small style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-sans)", color: "var(--text-subtle)", textAlign: align === "end" ? "right" : "left" }}>{note}</small> : null}
  </div>;
}

/** DCA-DETAIL §2's "Current round" card. `null` when no round is open — the status line above already says so. */
function DcaCurrentRoundCard({ dca, icon, onOpenOngoing }: { readonly dca: TradeDcaView; readonly icon: string | null; readonly onOpenOngoing: () => void }) {
  const round = dca.round;
  if (round === null) return null;
  const tpEdge = round.tp === null ? null : dcaOrderPriceE8(round.tp, "tp");
  const tpResting = round.tp !== null && round.tp.state === "resting";
  const tpValue = tpResting ? dcaPrice(tpEdge) : dcaPrice(round.tpTargetE8);
  const tpNote = tpResting ? undefined : "target — not placed yet";
  // DCA-DETAIL fix pass, MEDIUM 3: the equity figure sits next to the stop line and
  // the deposit, all three from the same `equity` read. When equity has no source
  // (no active round, or a chain-read failure), that part is a dash with its reason.
  const equityReason = dca.equity === null ? DCA_READ_REASON[dca.reason ?? ""] ?? dca.reason ?? undefined : undefined;
  const stopLossExtra = dca.settings.stopLossBps === null ? "Off"
    : dca.equity !== null && dca.equity.stopAtWei !== null
      ? `stop at ${usdt2(dca.equity.stopAtWei)} · equity now ${usdt2(dca.equity.equityWei)} · deposit ${usdt2(dca.equity.baselineWei)}`
      : equityReason !== undefined ? `equity — ${equityReason}` : undefined;
  const stopLossNote = stopLossExtra === "Off" ? undefined : stopLossExtra;
  const cardMarketReason = dcaMarketReason(dca);
  const segments = 1 + dca.settings.maxOrders;
  const baseFilled = round.p0E8 !== null;
  const filledLevels = round.levels.filter((level) => level.state === "filled").length;
  const filledSegments = (baseFilled ? 1 : 0) + filledLevels;
  return <section className="fl-trade-table" style={{ padding: "18px 22px 20px", display: "grid", gap: 18, marginBottom: 18 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ font: "var(--weight-semibold) var(--text-md, 15px)/1 var(--font-sans)", color: "var(--ink-1)" }}>Current round</span>
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", padding: "4px 8px", borderRadius: 999, border: "1px solid var(--line-1)" }}>ROUND {round.roundNo}</span>
      <button type="button" onClick={onOpenOngoing} style={{ marginLeft: "auto", cursor: "pointer", background: "none", border: "none", padding: 0, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--cat-yield)" }}>Ongoing</button>
    </div>
    <button type="button" onClick={onOpenOngoing} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: 0, textAlign: "left" }}>
      <TokenIcon src={icon} symbol={dca.symbol} size={22} />
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{dca.symbol} / USDT</span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>{dca.mark === null || dca.mark === undefined ? "—" : dcaPrice(dca.mark.e8).replace(/ USDT$/u, "")}</span>
        {cardMarketReason !== undefined ? <small style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{cardMarketReason}</small> : null}
        <Icon name="chevron-right" size={13} />
      </span>
    </button>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 16 }}>
      <DcaStat label="Average entry price" value={dcaPrice(round.avgCostE8)} />
      <DcaStat label="Take profit price" value={tpValue} note={tpNote} />
      <DcaStat label="Stop loss price" value="—" note={stopLossNote} />
      <DcaStat label="Volume" align="end" value={`${dcaStockAmount(round.stockHeldWei, dca.symbol)} (≈ ${dcaVolumeApprox(round.stockHeldWei, dca.mark?.e8 ?? null)})`} note={cardMarketReason} />
    </div>
    <div style={{ display: "grid", gap: 8, paddingTop: 14, borderTop: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", gap: 3, height: 8 }}>
        {Array.from({ length: segments }, (_, index) => <i key={index} style={{ flex: 1, borderRadius: 2, background: index < filledSegments ? "var(--cat-yield)" : "var(--raised-3)" }} />)}
      </div>
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>BASE + {filledLevels} OF {dca.settings.maxOrders} DCA ORDERS FILLED</span>
    </div>
  </section>;
}

/** Operator 2026-09-25: USDT is always green and the bStock always yellow in the holdings donut. */
const DCA_USDT_COLOR = "var(--profit)";
const DCA_STOCK_COLOR = "#f0b90b";

/** A two-slice donut; `stockShare` in [0, 1]. */
function DcaHoldingsDonut({ stockShare, centerLabel, centerValue }: { readonly stockShare: number; readonly centerLabel: string; readonly centerValue: string }) {
  const r = 38, c = 2 * Math.PI * r, stockLen = Math.max(0, Math.min(1, stockShare)) * c;
  return <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${centerLabel} ${centerValue}`}>
    <circle cx="48" cy="48" r={r} fill="none" stroke={DCA_USDT_COLOR} strokeWidth="8" />
    {stockLen > 0 ? <circle cx="48" cy="48" r={r} fill="none" stroke={DCA_STOCK_COLOR} strokeWidth="8"
      strokeDasharray={`${stockLen} ${c - stockLen}`} transform="rotate(-90 48 48)" /> : null}
    <text x="48" y="44" textAnchor="middle" style={{ font: "var(--weight-regular) 10px/1 var(--font-sans)", fill: "var(--text-subtle)" }}>{centerLabel}</text>
    <text x="48" y="60" textAnchor="middle" style={{ font: "var(--weight-medium) 12px/1 var(--font-mono)", fill: "var(--ink-1)" }}>{centerValue}</text>
  </svg>;
}

/**
 * Operator 2026-09-25: holdings in their own tab, between Order history and Run log,
 * rendered as a portfolio donut by USDT value. The stock figure is the round's
 * holding (wallet + the resting take-profit order), valued at the plane's mark;
 * the USDT figure is the wallet plus the resting DCA orders (AUTO-DCA R3.8, D-R3-3).
 */
const DCA_USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";

function DcaWalletPanel({ dca }: { readonly dca: TradeDcaView }) {
  const icons = useTokenIcons([dca.token, DCA_USDT_ADDRESS]);
  const reason = dca.wallet === null ? DCA_READ_REASON[dca.reason ?? ""] ?? undefined : undefined;
  const stockWei = dca.round !== null ? dca.round.stockHeldWei : dca.wallet?.stockWei ?? null;
  const markE8 = dca.mark === null || dca.mark === undefined ? null : dca.mark.e8;
  let usdtValue: number | null = null, stockValue: number | null = null, usdtWei: string | null = null;
  try {
    if (dca.wallet !== null) usdtWei = (BigInt(dca.wallet.usdtWei) + (dca.round?.levels ?? []).filter((level) => level.state === "resting")
      .reduce((sum, level) => sum + BigInt(level.usdtWei), 0n)).toString(10);
    if (usdtWei !== null) usdtValue = Number(formatEther(BigInt(usdtWei)));
    if (stockWei !== null && markE8 !== null) stockValue = Number(formatEther((BigInt(stockWei) * BigInt(markE8)) / 100_000_000n));
  } catch { usdtValue = null; stockValue = null; usdtWei = null; }
  const total = usdtValue !== null && stockValue !== null ? usdtValue + stockValue : null;
  const stockShare = total !== null && total > 0 ? stockValue! / total : null;
  const pct = (share: number) => `${(share * 100).toFixed(2)}%`;
  const bigger = stockShare === null ? null : stockShare >= 0.5 ? { label: dca.symbol, share: stockShare } : { label: "USDT", share: 1 - stockShare };
  const legend = (color: string, label: string, share: number | null, icon: string | null) => <div style={{ display: "flex", alignItems: "center", gap: 10, font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>
    <i style={{ width: 8, height: 8, borderRadius: 999, background: color }} /><TokenIcon src={icon} symbol={label} size={18} />
    <span style={{ minWidth: 56 }}>{label}</span>
    <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)" }}>{share === null ? "—" : pct(share)}</span>
  </div>;
  return <section className="fl-trade-table" data-testid="dca-wallet">
    <div className="fl-trade-table__bar"><span>Holdings</span></div>
    <div style={{ padding: "18px 22px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto auto", gap: 28, alignItems: "center" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}><TokenIcon src={icons[dca.token.toLowerCase()] ?? null} symbol={dca.symbol} size={28} /><DcaStat label={`${dca.symbol} holdings`} value={stockWei === null ? "—" : dcaStockAmount(stockWei, dca.symbol)}
        note={stockValue === null ? (dca.round !== null ? dcaMarketReason(dca) ?? undefined : reason) : `≈ ${stockValue.toFixed(2)} USDT · ${dca.round === null ? "in the agent wallet" : "wallet and resting take-profit order"}`} /></div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}><TokenIcon src={icons[DCA_USDT_ADDRESS] ?? null} symbol="USDT" size={28} /><DcaStat label="USDT holdings" value={usdtWei === null ? "—" : usdt2(usdtWei)} note={usdtWei === null ? reason : dca.round === null ? "in the agent wallet" : "wallet and resting DCA orders"} /></div>
      {bigger === null ? <span style={{ font: "var(--type-body-xs)", color: "var(--text-subtle)" }}>{dcaMarketReason(dca) ?? reason ?? "No value to chart."}</span>
        : <DcaHoldingsDonut stockShare={stockShare!} centerLabel={bigger.label} centerValue={pct(bigger.share)} />}
      <div style={{ display: "grid", gap: 12 }}>
        {legend(DCA_STOCK_COLOR, dca.symbol, stockShare, icons[dca.token.toLowerCase()] ?? null)}
        {legend(DCA_USDT_COLOR, "USDT", stockShare === null ? null : 1 - stockShare, icons[DCA_USDT_ADDRESS] ?? null)}
      </div>
    </div>
  </section>;
}

type DcaOrderRowModel = {
  readonly key: string; readonly label: string; readonly stateText: string; readonly priceText: string; readonly priceReason?: string;
  readonly usdtWei: string | null; readonly stockWei: string | null; readonly tokenId: string | null; readonly showNft: boolean;
  readonly txHash: string | null; readonly canClose: boolean;
};

/** DCA-DETAIL §2/§5: TP, Base (only once the NEW field resolves it), then DCA #1..N. */
function dcaOrderRows(dca: TradeDcaView, door: "show" | "removing" | "pause-first"): readonly DcaOrderRowModel[] {
  const round = dca.round;
  if (round === null) return [];
  const closedSuffix = (closedBy: TradeDcaOrderView["closedBy"]) => closedBy === "owner" ? " · closed by you" : closedBy === "elsewhere" ? " · collected elsewhere" : "";
  const rows: DcaOrderRowModel[] = [];
  if (round.tp !== null) {
    const priceE8 = dcaOrderPriceE8(round.tp, "tp");
    rows.push({ key: "tp", label: "Take profit", stateText: `${round.tp.state}${closedSuffix(round.tp.closedBy)}`,
      priceText: priceE8 === null ? "—" : dcaPrice(priceE8), priceReason: priceE8 === null ? "Price not known yet" : undefined,
      usdtWei: round.tp.usdtWei, stockWei: round.tp.stockWei, tokenId: round.tp.tokenId, showNft: true, txHash: round.tp.txHash,
      canClose: door === "show" && round.tp.state === "resting" && round.tp.tokenId !== null });
  }
  // DCA-DETAIL fix pass, LOW 4: `null` means no base fill exists yet (the row is
  // omitted); `undefined` means the NEW field itself is absent (an older plane),
  // shown as a dash with its reason rather than silently dropped.
  if (round.base === undefined && round.p0E8 !== null) {
    rows.push({ key: "base", label: "Base order", stateText: "filled", priceText: "—", priceReason: "Needs the updated execution plane.",
      usdtWei: null, stockWei: null, tokenId: null, showNft: false, txHash: null, canClose: false });
  } else if (round.base !== undefined && round.base !== null) {
    rows.push({ key: "base", label: "Base order", stateText: "filled", priceText: dcaPrice(round.p0E8),
      usdtWei: round.base.usdtWei, stockWei: round.base.stockWei, tokenId: null, showNft: false, txHash: round.base.txHash, canClose: false });
  }
  for (const level of round.levels) {
    const priceE8 = dcaOrderPriceE8(level, "level");
    rows.push({ key: `l${level.levelNo}`, label: `DCA #${level.levelNo}`, stateText: `${DCA_LEVEL_STATE[level.state] ?? level.state}${closedSuffix(level.closedBy)}`,
      priceText: priceE8 === null ? "—" : dcaPrice(priceE8), priceReason: priceE8 === null ? "Price not known yet" : undefined,
      usdtWei: level.usdtWei, stockWei: level.stockWei, tokenId: level.tokenId, showNft: true, txHash: level.txHash,
      canClose: door === "show" && level.state === "resting" && level.tokenId !== null });
  }
  return rows;
}

/** Operator 2026-09-25: even columns, no spacer column. */
const DCA_ORDER_COLUMNS = "minmax(140px,1.2fr) minmax(90px,.8fr) minmax(110px,1fr) minmax(90px,.8fr) minmax(120px,1fr) minmax(110px,.9fr)";

function DcaOrdersTable({ dca, door, busy, pull, refresh, readOnly }: {
  readonly dca: TradeDcaView; readonly door: "show" | "removing" | "pause-first"; readonly busy: boolean;
  readonly pull?: (tokenId?: string) => void; readonly refresh: () => Promise<unknown>; readonly readOnly: boolean;
}) {
  const rows = dcaOrderRows(dca, door);
  return <section className="fl-trade-table">
    <div className="fl-trade-table__bar"><span>Orders</span>
      {door === "show" ? <Button variant="danger" size="sm" disabled={busy || pull === undefined} onClick={() => pull?.()}>Pull resting orders</Button>
        : door === "removing" ? <span data-testid="dca-removing">Remove in progress</span> : null}
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void refresh()}>Refresh</Button>
    </div>
    {door === "show" ? <p className="fl-trade-budget__note" data-testid="dca-pull-note">Pull resting orders closes every resting order in one passkey batch, all or nothing: if one order fails, none is pulled. Close them one at a time below instead.</p> : null}
    <div className="fl-trade-position fl-trade-position--head fl-trade-position--closed" style={{ gridTemplateColumns: DCA_ORDER_COLUMNS }}><span>Order</span><span>State</span><span>Price</span><span>USDT</span><span>{dca.symbol}</span><span className="fl-trade-heading-end">Actions</span></div>
    {rows.map((row) => <div className="fl-trade-position fl-trade-position--closed" style={{ gridTemplateColumns: DCA_ORDER_COLUMNS }} key={row.key} data-testid="dca-order">
      <div><strong>{row.label}</strong>
        {row.showNft && !readOnly ? <div>{row.tokenId === null ? <span style={{ color: "var(--text-subtle)" }}>—</span>
          : <a className="fl-lp-nft-link" href={pancakePositionUrl(row.tokenId)} target="_blank" rel="noreferrer" title="Open this position on PancakeSwap">#{row.tokenId}</a>}</div> : null}
      </div>
      <div style={row.stateText.startsWith("filled") ? { color: "var(--gain, #2cd391)", fontWeight: 500 } : undefined}>{row.stateText}</div>
      <div>{row.priceText}{row.priceReason ? <small style={{ display: "block", color: "var(--text-subtle)" }}>{row.priceReason}</small> : null}</div>
      {/* Agentic public page (operator 2026-10-04): an amount is a number or a dash, never a 0 placeholder for a side the order has not moved. */}
      <div>{row.usdtWei === null || readOnly && /^0+$/u.test(row.usdtWei) ? "—" : usdt2(row.usdtWei)}</div>
      <div>{row.stockWei === null || readOnly && /^0+$/u.test(row.stockWei) ? "—" : dcaStockAmount(row.stockWei, dca.symbol)}</div>
      <div className="fl-trade-position__actions">
        {row.canClose ? <Button variant="ghost" size="sm" disabled={busy || pull === undefined} onClick={() => pull?.(row.tokenId!)}>Close on chain</Button> : null}
        {txUrl(row.txHash) ? <a href={txUrl(row.txHash)!} target="_blank" rel="noreferrer">Tx <Icon name="external" size={11} /></a> : <span>—</span>}
      </div>
    </div>)}
    {rows.length === 0 ? <div className="fl-trade-empty">No orders in this round.</div> : null}
  </section>;
}

/** "+1.23%" against `markE8`; "" when the mark is unknown. */
function dcaPctVsMark(priceE8: string, markE8: string | null): string {
  if (markE8 === null) return "";
  const price = Number(priceE8), mark = Number(markE8);
  if (!Number.isFinite(price) || !Number.isFinite(mark) || mark === 0) return "";
  const percent = ((price - mark) / mark) * 100;
  return ` (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)`;
}

type DcaLadderRow =
  | { readonly kind: "entry"; readonly priceE8: string }
  | { readonly kind: "tp"; readonly priceE8: string; readonly stockWei: string }
  | { readonly kind: "level"; readonly priceE8: string; readonly usdtWei: string; readonly levelNo: number; readonly filled: boolean };

/** DCA-DETAIL §2's Ongoing ladder: entry + TP + every priced level, sorted by price descending. */
function dcaLadderRows(round: DcaRoundView): readonly DcaLadderRow[] {
  const rows: DcaLadderRow[] = [];
  if (round.avgCostE8 !== null) rows.push({ kind: "entry", priceE8: round.avgCostE8 });
  if (round.tp !== null) {
    const price = dcaOrderPriceE8(round.tp, "tp");
    if (price !== null) rows.push({ kind: "tp", priceE8: price, stockWei: round.tp.stockWei });
  }
  for (const level of round.levels) {
    const price = dcaOrderPriceE8(level, "level");
    if (price !== null) rows.push({ kind: "level", priceE8: price, usdtWei: level.usdtWei, levelNo: level.levelNo, filled: level.state === "filled" });
  }
  return [...rows].sort((a, b) => Number(b.priceE8) - Number(a.priceE8));
}

function dcaLadderBuyAmount(usdtWei: string, priceE8: string, symbol: string): string {
  try {
    if (priceE8 === "0") return "—";
    return dcaStockAmount(((BigInt(usdtWei) * 100_000_000n) / BigInt(priceE8)).toString(10), symbol);
  } catch { return "—"; }
}

/** The mock's ladder dot: ▲ take profit, ✓ filled, empty ring pending. */
function DcaLadderDot({ kind }: { readonly kind: "tp" | "done" | "pending" }) {
  return <span style={{ width: 18, height: 18, borderRadius: 999, flex: "0 0 auto", display: "grid", placeItems: "center", background: "var(--surface-card)",
    border: "1.5px solid " + (kind === "tp" ? "var(--profit)" : kind === "done" ? "var(--text-subtle)" : "var(--line-2, var(--line-1))"),
    color: kind === "tp" ? "var(--profit)" : "var(--text-subtle)", font: "var(--weight-medium) 10px/1 var(--font-sans)" }}>
    {kind === "done" ? "✓" : kind === "tp" ? "▲" : ""}
  </span>;
}

/** The mock's price callout (entry price, current price) on the ladder's dotted spine. */
function DcaLadderCallout({ label, value, accent }: { readonly label: string; readonly value: string; readonly accent: boolean }) {
  return <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 12, alignItems: "center", paddingBottom: 18 }}>
    <span style={{ borderTop: `1px dotted ${accent ? "var(--cat-yield)" : "var(--text-subtle)"}`, marginLeft: 9 }} />
    <span style={{ justifySelf: "start", display: "grid", gap: 4, padding: "8px 12px", borderRadius: "var(--radius-sm)",
      background: accent ? "color-mix(in oklab, var(--cat-yield) 14%, var(--surface-card))" : "var(--raised-3, var(--surface-sunken))",
      border: `1px solid ${accent ? "var(--cat-yield)" : "var(--line-1)"}` }}>
      <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-sans)", color: "var(--ink-1)" }}>{label}</span>
      <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", color: "var(--ink-1)" }}>{value}</span>
    </span>
  </div>;
}

function DcaOngoing({ dca, live }: { readonly dca: TradeDcaView; readonly live: boolean }) {
  const round = dca.round;
  if (round === null) return <section className="fl-trade-table"><div className="fl-trade-empty">{live ? "Setting up orders…" : "No round is open."}</div></section>;
  const rows = dcaLadderRows(round);
  const markE8 = dca.mark === null || dca.mark === undefined ? null : dca.mark.e8;
  // DCA-DETAIL fix pass, LOW 5 (operator 2026-09-25: TP and entry count too): the marker sits before the first row priced below
  // the mark, or after every row when the mark is below all of them.
  const belowIndex = markE8 === null ? -1 : rows.findIndex((row) => Number(row.priceE8) < Number(markE8));
  const nowIndex = markE8 === null ? -1 : belowIndex === -1 ? rows.length : belowIndex;
  const current = <DcaLadderCallout label="Current price" value={dcaPrice(markE8)} accent={false} />;
  const item = (row: DcaLadderRow) => {
    if (row.kind === "entry") return <DcaLadderCallout label="Entry price" value={dcaPrice(row.priceE8)} accent />;
    const kind = row.kind === "tp" ? "tp" : row.filled ? "done" : "pending";
    const title = row.kind === "tp" ? "Take-profit order" : `DCA order #${row.levelNo}`;
    const line = row.kind === "tp" ? `Sell ${dcaStockAmount(row.stockWei, dca.symbol)} at ${dcaPrice(row.priceE8)}${dcaPctVsMark(row.priceE8, markE8)}`
      : `Buy ${dcaLadderBuyAmount(dca.settings.orderWei, row.priceE8, dca.symbol)} at ${dcaPrice(row.priceE8)}${dcaPctVsMark(row.priceE8, markE8)}`;
    return <div style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 12, paddingBottom: 18 }}>
      <DcaLadderDot kind={kind} />
      <div style={{ display: "grid", gap: 5 }}>
        <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: kind === "tp" ? "var(--profit)" : kind === "pending" ? "var(--text-muted)" : "var(--ink-1)" }}>
          {title}{kind === "done" ? <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)", marginLeft: 8 }}>FILLED</span> : null}
        </span>
        <span style={{ font: "var(--weight-regular) var(--text-xs)/1.4 var(--font-mono)", color: kind === "tp" ? "var(--profit)" : "var(--text-subtle)" }}>{line}</span>
      </div>
    </div>;
  };
  return <section className="fl-trade-table">
    <div className="fl-trade-table__bar"><span>Ongoing</span>
      <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>
        ROUND {round.roundNo} · STEP {(dca.settings.stepBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% · TP {(dca.settings.takeProfitBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%
      </span>
    </div>
    <div style={{ position: "relative", padding: "18px 20px 2px" }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 28, top: 28, bottom: 30, borderLeft: "1px dashed var(--line-2, var(--line-1))" }} />
      {rows.map((row, index) => <React.Fragment key={index}>
        {index === nowIndex ? current : null}
        {item(row)}
      </React.Fragment>)}
      {nowIndex === rows.length ? current : null}
    </div>
  </section>;
}

const DCA_EXIT_LABEL: Readonly<Record<string, string>> = { "take-profit": "TAKE PROFIT", "stop-loss": "STOP LOSS", removed: "REMOVED" };
const DCA_ROUNDS_PER_PAGE = 3;

function DcaRoundsHistory({ dca }: { readonly dca: TradeDcaView }) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  // Rounds.settled / realizedPnlWei are existing DTO fields (present on any plane); only the
  // per-round list below is the NEW field, absent on an older plane.
  const history = dca.rounds.history;
  // LOW 8: `dca.history.fills` is capped at 60 across ALL rounds, newest first, so an
  // older round can show zero fills here because they fell off that cap, not because
  // the round never traded.
  const fillsCapped = (dca.history?.fills.length ?? 0) >= 60;
  const pages = history === undefined ? 1 : Math.max(1, Math.ceil(history.length / DCA_ROUNDS_PER_PAGE));
  const list = history === undefined ? [] : history.slice(page * DCA_ROUNDS_PER_PAGE, page * DCA_ROUNDS_PER_PAGE + DCA_ROUNDS_PER_PAGE);
  // AUTO-DCA R4.7 / review dispositions #13: the header stays on `realizedPnlWei`;
  // the card notes when any row's Round PnL is marked rather than realized.
  const anyMarked = (history ?? []).some((row) => !row.unreliable && row.markedPnlWei !== undefined && row.markedPnlWei !== null
    && row.unsoldStockWei !== undefined && row.unsoldStockWei !== null && /^\d+$/u.test(row.unsoldStockWei) && BigInt(row.unsoldStockWei) > 0n);
  return <section className="fl-trade-table">
    <div className="fl-trade-table__bar"><span>Rounds</span>
      <span style={{ font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{dca.rounds.settled} COMPLETED · REALISED {usdt2(dca.rounds.realizedPnlWei, true)}{anyMarked ? " · marked where a round left stock" : ""}</span>
    </div>
    {history === undefined ? <div className="fl-trade-empty">Needs the updated execution plane.</div> : <div style={{ padding: "0 16px" }}>
      {list.map((row) => {
        const isOpen = open === row.roundNo;
        const fills = (dca.history?.fills ?? []).filter((fill) => fill.roundNo === row.roundNo);
        const exitLabel = row.closeCause === null ? "CLOSED" : DCA_EXIT_LABEL[row.closeCause] ?? "CLOSED";
        // AUTO-DCA R4.7: Round PnL is `markedPnlWei ?? realizedPnlWei`; a value that
        // does not parse is "—" with "not measurable", never a number.
        const marked = !row.unreliable && row.markedPnlWei !== undefined && row.markedPnlWei !== null && /^-?\d+$/u.test(row.markedPnlWei) ? BigInt(row.markedPnlWei) : null;
        const realized = !row.unreliable && row.realizedPnlWei !== null && /^-?\d+$/u.test(row.realizedPnlWei) ? BigInt(row.realizedPnlWei) : null;
        const pnl = marked ?? realized;
        const unsoldStockWei = row.unsoldStockWei;
        const pnlNote = pnl === null ? "not measurable"
          : marked !== null && unsoldStockWei !== undefined && unsoldStockWei !== null && /^\d+$/u.test(unsoldStockWei) && BigInt(unsoldStockWei) > 0n
            ? `incl. unsold ${dcaStockAmount(unsoldStockWei, dca.symbol)}, marked at removal`
            : undefined;
        return <div key={row.roundNo} style={{ borderBottom: "1px solid var(--line-1)", padding: "14px 0" }}>
          <button type="button" onClick={() => setOpen(isOpen ? null : row.roundNo)} style={{ cursor: "pointer", width: "100%", display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: 0, marginBottom: 12 }}>
            <span style={{ font: "var(--weight-semibold) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>Round {row.roundNo}</span>
            <span style={{ font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", padding: "3px 7px", borderRadius: 999, border: "1px solid var(--line-1)" }}>{exitLabel}</span>
            <span style={{ marginLeft: "auto", font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" }}>{row.settledAt === null ? "—" : new Date(row.settledAt).toLocaleString()}</span>
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 16 }}>
            <Metric label="Duration" value={row.settledAt === null ? "—" : heldDuration(row.openedAt, row.settledAt)} />
            <Metric label="Filled DCA orders" value={String(row.filledLevels)} />
            <Metric label="Max DCA orders" value={String(dca.settings.maxOrders)} />
            <Metric label="Round PnL" value={pnl === null ? "—" : usdt2(pnl.toString(10), true)} tone={pnl === null ? "normal" : pnl > 0n ? "profit" : pnl < 0n ? "loss" : "normal"} note={pnlNote} />
          </div>
          {isOpen ? <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", border: "1px solid var(--line-1)", display: "grid", gap: 6 }}>
            {fills.length === 0 ? <span style={{ font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-subtle)" }}>{fillsCapped ? "Older fills are not loaded." : "No fills recorded."}</span>
              : fills.map((fill, index) => <div key={index} style={{ display: "flex", justifyContent: "space-between", gap: 12, font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-mono)", color: "var(--text-muted)" }}>
                <span>{fill.kind === "base" ? "Base order" : fill.kind === "level" ? `DCA #${fill.levelNo}` : fill.kind === "take-profit" ? "Take profit" : "Remove sale"}</span>
                <span><b style={{ color: fill.side === "buy" ? "var(--profit)" : fill.side === "sell" ? "var(--loss)" : undefined, fontWeight: 500 }}>{fill.side}</b> {usdt2(fill.usdtWei)}</span>
              </div>)}
          </div> : null}
        </div>;
      })}
    </div>}
    {history !== undefined && pages > 1 ? <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, padding: "12px 16px" }}>
      {Array.from({ length: pages }, (_, index) => <button key={index} type="button" aria-pressed={index === page} onClick={() => setPage(index)}>{index + 1}</button>)}
    </div> : null}
  </section>;
}

function dcaFillOrderLabel(fill: NonNullable<TradeDcaView["history"]>["fills"][number]): string {
  return fill.kind === "base" ? "Base" : fill.kind === "level" ? `DCA #${fill.levelNo}` : fill.kind === "take-profit" ? "Take profit" : "Remove sale";
}

/** Price = usdt ÷ stock, 4 dp. */
function dcaFillPrice(fill: NonNullable<TradeDcaView["history"]>["fills"][number]): string {
  try {
    if (fill.stockWei === "0") return "—";
    const price = Number(fill.usdtWei) / Number(fill.stockWei);
    return Number.isFinite(price) ? `${price.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT` : "—";
  } catch { return "—"; }
}

function DcaOrderHistory({ dca, refresh }: { readonly dca: TradeDcaView; readonly refresh: () => Promise<unknown> }) {
  const fills = dca.history?.fills;
  return <section className="fl-trade-table">
    <div className="fl-trade-table__bar"><span>Order history</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void refresh()}>Refresh</Button></div>
    <div className="fl-row__head" style={{ gridTemplateColumns: "minmax(0,1.3fr) 70px minmax(0,1fr) 64px minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) 72px" }}>
      <span>Time</span><span>Round</span><span>Order</span><span>Side</span><span>Price</span><span>Amount</span><span>Value</span><span style={{ justifySelf: "end" }}>Tx</span>
    </div>
    {fills === undefined ? <div className="fl-trade-empty">Needs the updated execution plane.</div>
      : fills.length === 0 ? <div className="fl-trade-empty">No orders yet.</div>
      : fills.map((fill, index) => <div className="fl-row" key={index} style={{ gridTemplateColumns: "minmax(0,1.3fr) 70px minmax(0,1fr) 64px minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) 72px", alignItems: "center" }}>
        <span>{fill.atMs === null ? "—" : new Date(fill.atMs).toLocaleString()}</span>
        <span>{fill.roundNo}</span>
        <span>{dcaFillOrderLabel(fill)}</span>
        <span style={{ color: fill.side === "buy" ? "var(--profit)" : fill.side === "sell" ? "var(--loss)" : undefined, fontWeight: 500 }}>{fill.side}</span>
        <span>{dcaFillPrice(fill)}</span>
        <span>{dcaStockAmount(fill.stockWei, dca.symbol)}</span>
        <span>{usdt2(fill.usdtWei)}</span>
        <span style={{ justifySelf: "end" }}>{txUrl(fill.txHash) ? <a href={txUrl(fill.txHash)!} target="_blank" rel="noreferrer">Tx <Icon name="external" size={11} /></a> : "—"}</span>
      </div>)}
  </section>;
}

/** DCA-DETAIL §6: entry, TP, every resting level's own tick-edge price and every pending level's planned price. The read-only Agentic page has no NFT: an armed (resting) order is drawn at its trigger price. */
function dcaChartPriceLines(dca: TradeDcaView, readOnly = false): readonly { readonly price: number; readonly color: string; readonly title: string }[] {
  const round = dca.round;
  if (round === null) return [];
  const lines: { readonly price: number; readonly color: string; readonly title: string }[] = [];
  const pushLine = (e8: string | null | undefined, color: string, title: string) => {
    if (e8 === null || e8 === undefined) return;
    const price = Number(e8) / 1e8;
    if (Number.isFinite(price) && price > 0) lines.push({ price, color, title });
  };
  pushLine(round.avgCostE8, "#2fd48c", "ENTRY");
  if (round.tp !== null && round.tp.state === "resting" && (round.tp.tokenId !== null || readOnly)) pushLine(round.tp.edgePriceE8, "#2fd48c", "TP");
  // Operator 2026-10-06: every DCA level still to come is drawn, not only the armed ones (a pending level at its planned price).
  for (const level of round.levels) {
    if (level.state === "resting" && (level.tokenId !== null || readOnly)) pushLine(level.edgePriceE8, "#2fd48c", `DCA #${level.levelNo}`);
    else if (level.state === "pending") pushLine(dcaOrderPriceE8(level, "level"), "#2fd48c", `DCA #${level.levelNo}`);
  }
  return lines;
}

/** DCA-DETAIL §6: one marker per current-round fill. */
function dcaChartMarkers(dca: TradeDcaView): readonly MarketChartMarker[] {
  const round = dca.round;
  if (round === null || dca.history === undefined) return [];
  // LOW 7: a fill with no known time (a rolled-back base action) has nothing to plot.
  return dca.history.fills.filter((fill) => fill.roundNo === round.roundNo && fill.atMs !== null).map((fill) => ({
    timestamp: fill.atMs!, side: fill.side, text: fill.kind === "base" ? "B" : fill.kind === "level" ? `DCA #${fill.levelNo}` : "TP",
  }));
}

/**
 * AGENTIC-DCA 4.5, R2.10, R22.2: what the public page says in place of the Altana status notes, in plain words. Each note shows under its own
 * condition; `status` is "armed" while the agent is live (so a hire with no round yet is "setting up", not "no round is open").
 */
function dcaReadOnlyNotes(dca: TradeDcaView, status: string | null, endReason: string | null): readonly (readonly [string, string])[] {
  const round = dca.round;
  return [
    ...(endReason === "stop-loss" ? [["stop-loss", AGENTIC_DCA_COPY.stopLoss] as const] : []),
    ...(endReason === "term-ended" ? [["term-end", AGENTIC_DCA_COPY.termEnd] as const] : []),
    ...(endReason === "owner-signed-out" ? [["owner-end", AGENTIC_DCA_COPY.ownerEnd] as const] : []),
    ...(round === null && status === "armed" ? [["setting-up", AGENTIC_DCA_COPY.settingUp(agenticDcaResting(dca.settings.maxOrders))] as const] : []),
    ...((dca.heldOrders ?? 0) > 0 ? [["held", AGENTIC_DCA_COPY.held(dca.heldOrders!)] as const] : []),
  ];
}

type DcaTab = "Orders" | "Ongoing" | "Rounds" | "Order history" | "Holdings" | "Run log";
const DCA_TABS: readonly DcaTab[] = ["Orders", "Ongoing", "Rounds", "Order history", "Holdings", "Run log"];

/**
 * DCA-DETAIL — the Auto DCA detail page (mock `DCA-DETAIL-MOCK.jsx`, spec
 * `DCA-DETAIL-SPEC.md`): the status/paused/unknown/unreliable/elsewhere
 * notes, the "Current round" card, the tab bar with the chart toggle, and
 * the five tabs (Orders, Ongoing, Rounds, Order history, Run log).
 */
export function DcaDetail({ dca, status, draining, planeUnreachable, busy, pull, refresh, icon, runs, symbols, simulationLog, readOnly = false, endReason = null, holdingsExtra }: {
  readonly dca: TradeDcaView;
  readonly status: string | null;
  readonly draining: boolean;
  readonly planeUnreachable: boolean;
  readonly busy: boolean;
  readonly pull?: (tokenId?: string) => void;
  readonly refresh: () => Promise<unknown>;
  readonly icon: string | null;
  readonly runs: TradeView["runs"];
  readonly symbols: Readonly<Record<string, string>>;
  /** The read-only pre-flight simulation log; shown inside the Run log tab (Runs | Simulate toggle) only when supplied. */
  readonly simulationLog?: React.ReactNode;
  /**
   * The public Agentic page (AGENTIC-DCA 4.5, 4.6): no owner door (no pull, no Close on chain, no NFT link), the plane's own order id as text,
   * and the Agentic notes in place of the Altana status ones. `status` reads "armed" while the agent is live; `endReason` is the agent's own end reason.
   */
  readonly readOnly?: boolean;
  readonly endReason?: string | null;
  /** Extra content under the Holdings tab (the public page's keep-alive panel). */
  readonly holdingsExtra?: React.ReactNode;
}) {
  const [tab, setTab] = useState<DcaTab>("Orders");
  const [showChart, setShowChart] = useState(false);
  const round = dca.round;
  const door = readOnly ? "pause-first" : dcaPullDoor({ status, draining, planeUnreachable });
  const elsewhere = round !== null && [round.tp, ...round.levels].some((order) => order?.closedBy === "elsewhere");
  // AUTO-DCA R4.7: a Remove with no open round left nothing to sweep — nothing was sold.
  const statusLine = draining && round === null
    ? `Every order is back in the agent wallet; nothing was sold. Your USDT and ${dca.symbol} are in the wallet — withdraw them with Withdraw on My agents.`
    : draining ? "Removing" : round?.phase === "stopped" ? "Paused by stop loss — resume to continue"
    : round === null ? (status === "armed" ? "Setting up: buying the base order, then placing the orders." : "No round is open.") : null; // Operator 2026-09-25: the round/phase line duplicated the Current round card.
  const note = (text: string, testId: string) => <div className="fl-trade-message" role="note" data-testid={testId}>{text}</div>;
  return <>
    {readOnly ? dcaReadOnlyNotes(dca, status, endReason).map(([key, text]) => <React.Fragment key={key}>{note(text, `dca-ro-${key}`)}</React.Fragment>) : <>
    {statusLine === null ? null : <div className="fl-trade-message" role="status" data-testid="dca-status">{statusLine}</div>}
    {status === "paused" ? note("Paused. Your resting orders keep trading on chain: a DCA level can still buy and the take profit can still sell. The stop loss does not run while paused. To stop everything, pull the resting orders.", "dca-paused") : null}
    {dca.unknownAction !== null ? note(draining
      ? "A batch's outcome is unknown. It does not stop Remove: the plane pulls whatever is still on chain."
      : "A batch's outcome is unknown, so the plane places nothing new until it is resolved. Your doors: pause and pull the resting orders with your passkey, or Remove.", "dca-unknown") : null}
    {round?.unreliable === true ? note("This round's orders could not all be verified from chain, so its PnL is not measurable and the plane holds. Your doors: Remove, or pause, pull the resting orders and withdraw.", "dca-unreliable") : null}
    {elsewhere ? note("An order was collected to another address. Revoke this agent's session.", "dca-elsewhere") : null}
    </>}
    <DcaCurrentRoundCard dca={dca} icon={icon} onOpenOngoing={() => setTab("Ongoing")} />
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div className="fl-trade-tabs">{DCA_TABS.map((item) => <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      {tab !== "Run log" ? <Button variant={showChart ? "secondary" : "ghost"} size="sm" icon={<Icon name="yield" size={14} />} onClick={() => setShowChart((value) => !value)} style={{ marginLeft: "auto" }}>{showChart ? "Hide chart" : "Show chart"}</Button> : null}
    </div>
    {showChart && tab !== "Run log" ? <section className="fl-trade-table" style={{ marginBottom: 16 }}>
      <div style={{ padding: "14px 16px 12px" }}>
        <MarketChart kind="token" address={dca.token} title={`${dca.symbol} / USDT`} embedded height={230} defaultInterval="15m" priceLines={dcaChartPriceLines(dca, readOnly)} markers={dcaChartMarkers(dca)} />
      </div>
    </section> : null}
    {tab === "Orders" ? <DcaOrdersTable dca={dca} door={door} busy={busy} pull={pull} refresh={refresh} readOnly={readOnly} /> : null}
    {tab === "Ongoing" ? <DcaOngoing dca={dca} live={status === "armed"} /> : null}
    {tab === "Rounds" ? <DcaRoundsHistory dca={dca} /> : null}
    {tab === "Order history" ? <DcaOrderHistory dca={dca} refresh={refresh} /> : null}
    {tab === "Holdings" ? <><DcaWalletPanel dca={dca} />{holdingsExtra}</> : null}
    {tab === "Run log" ? <RunLogPanel simulationLog={simulationLog} runLog={<section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void refresh()}>Refresh</Button></div>
      <TradeRunLog runs={runs} symbols={symbols} dca={{ actions: dca.actions }} readOnly={readOnly} /></section>} /> : null}
  </>;
}

export function TradeAgentDetail(props: Props) {
  const { agentId, view, trade, busy, message, signedOut } = props;
  const [tab, setTab] = useState<TradeTab>("Open Positions");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const settings = trade?.settings ?? null;
  const schedule = trade?.schedule;
  const dca = trade?.dca;
  const portfolio = trade?.portfolio;
  // R2.11: resuming with equity already at or below the stop line pulls everything and pauses again.
  const dcaBelowStop = dca?.equity != null && dca.equity.stopAtWei !== null && BigInt(dca.equity.equityWei) <= BigInt(dca.equity.stopAtWei);
  const positions = tab === "Open Positions" ? trade?.open ?? [] : trade?.closed ?? [];
  const iconAddresses = useMemo(() => [...(trade?.open ?? []), ...(trade?.closed ?? []), ...(trade?.pinned ?? []), ...(dca === undefined ? [] : [{ address: dca.token }]), ...(portfolio === undefined ? [] : [...portfolio.tokens.map((row) => ({ address: row.token })), { address: DCA_USDT_ADDRESS }])].map((item) => "token" in item ? item.token : item.address), [trade, dca, portfolio]);
  const icons = useTokenIcons(iconAddresses);
  const v2 = settings?.settlementAsset === "USDT";
  const delegated = v2 ? usdt2(settings?.capitalQuoteWei ?? null) : view?.dailyNativeLimit.usd ?? view?.dailyNativeLimit.bnb ?? view?.dailyNativeLimit.value ?? "—";
  const usdRate = bnbUsdRate(view);
  const summary = trade?.summary;
  const gross = summary?.grossDeltaWei ?? null;
  const grossTone = gross === null ? "normal" : BigInt(gross) < 0n ? "loss" : "profit";
  // The percent under the dollar figure: gross delta over the DELEGATED capital — the session's daily native cap, which is
  // what a trade hire pins (its `openNativeBudgetWei` is 0; the grid pages measure against their armed budget instead).
  const basisWei = v2 ? settings?.capitalQuoteWei ?? null : view?.dailyNativeLimit.rawWei ?? null;
  const grossPercent = gross === null || basisWei === null || BigInt(basisWei) <= 0n
    ? undefined
    : bps((BigInt(gross) * 10_000n / BigInt(basisWei)).toString(10), true);
  const nowMs = useSessionClock();
  const draining = trade?.lifecycle?.draining === true;
  // TRADFI-EXPIRY-KEEP-REMOVE: the plane's own discriminator, read as the literal `true`.
  const tradfiAi = trade?.tradfiAi === true;
  // A removed TradFi AI agent that was drained earlier still says what it is now, not "draining".
  const removedAi = tradfiAi && (view?.status === "revoked" || view?.status === "retired");
  const keptPositions = trade?.keptPositions ?? 0;
  // An armed agent whose session has expired is not live: nothing it decides
  // can reach the chain. The pill override comes from the shared clock so all
  // four agent pages say the same thing about the same fact.
  const pill = sessionPillOverride(sessionExpiry(view?.sessionExpiresAt, nowMs), view?.status);
  const status = pill?.status ?? (view?.status === "armed" ? "live" : "paused");
  const statusLabel = view === null ? "—" : schedule && schedule.finished !== null ? `Finished — ${schedule.finished}` : draining && !removedAi ? "draining" : pill?.label ?? (["provisioning", "revoked", "retired"].includes(view.status) ? view.status : undefined);
  const unresolved = trade?.pendingIntents ?? [];
  const tradeSymbols = Object.fromEntries([
    ...(trade?.pinned ?? []).flatMap((row) => row.symbol ? [[row.address.toLowerCase(), row.symbol] as const] : []),
    ...[...(trade?.open ?? []), ...(trade?.closed ?? [])].map((position) => [position.token.toLowerCase(), positionSymbol(position)] as const),
  ]);
  const simulationLog = (symbols: Readonly<Record<string, string>>) =>
    <TradeSimulationLog agentId={agentId} readHeaders={props.readHeaders ?? NO_READ_HEADERS} symbols={symbols} />;
  return <div className="fl-shell fl-hired-agent-page fl-trade-detail-page">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => props.go("/account")}>My agents</Button>
    <div className="fl-trade-hero">
      <div className="fl-trade-title-stack">
        <div className="fl-trade-title"><span className="fl-card__glyph"><Icon name="yield" size={22} /></span><h1>{settings?.tradeMode === "portfolio" ? `Smart Portfolio · ${portfolio?.tokens.length ?? "—"} bStocks` : schedule ? `Schedule buy · ${schedule.symbol}` : dca ? `Auto DCA · ${dca.symbol}` : settings?.name ?? view?.id ?? agentId}</h1><StatusBadge status={status} pill {...(statusLabel === undefined ? {} : { label: statusLabel })} /><SessionExpiryChip expiresAt={view?.sessionExpiresAt} nowMs={nowMs} /><AttentionChip state={gasAttention(view?.gas)} title="This agent needs BNB for relay gas." /></div>
        {settings?.tradeMode === "portfolio" ? <span className="fl-trade-kicker fl-trade-agent-id">{agentId}</span> : null}
      </div>
      <GasNotice gas={view?.gas} walletAddress={view?.walletAddress} />
      <div className="fl-hired-actions">
        {signedOut ? <Button variant="primary" onClick={() => void props.signIn()}>Sign in to view</Button> : null}
        {props.renewalButton}
        <Button variant={editing ? "primary" : "secondary"} icon={<Icon name="settings" size={15} />} disabled={busy || settings === null || draining || unresolved.length > 0} onClick={() => setEditing((value) => !value)}>{editing ? "Editing" : "Edit"}</Button>
        {/* A finished schedule is already idle (the worker makes no calls for it), so Pause would only add a signature. Resume stays for a schedule paused earlier. */}
        {schedule && schedule.finished !== null && view?.status === "armed" ? null : <Button variant="secondary" icon={<Icon name="pause" size={15} />} disabled={busy || view === null || (view.status !== "armed" && view.status !== "paused") || draining} onClick={() => {
          if (view?.status === "paused" && dcaBelowStop
            && !window.confirm("Your equity is below your stop loss; resuming will pull all orders and pause again. Lower or turn off the stop loss first.")) return;
          props.togglePause();
        }}>{view?.status === "paused" ? "Resume" : "Pause"}</Button>}
        <Button variant="danger" icon={<Icon name="revoke" size={15} />} disabled={busy || view === null || props.removed} onClick={props.remove}>{props.removed ? "Removed" : view?.status === "revoked" ? "Finish removal" : draining ? "Removing" : "Remove"}</Button>
      </div>
    </div>
    {/* Below the hero, not inside its flex row: in the row it squeezed the title to "Tra…" (seen live 2026-09-15). */}
    <SessionExpiryNotice kind="trade" expiresAt={view?.sessionExpiresAt} nowMs={nowMs} status={view?.status} open={trade?.open.length ?? 0} tradfiAi={tradfiAi} />
    {/* The banner and the renewal reason are adjacent spans: without this space they ran together ("…hire again.finishing a trade intent…"). */}
    {props.renewalStatus ? " " : null}
    {props.renewalStatus}
    {keptPositions > 0 ? <span role="status" data-kept-positions={keptPositions} style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>{`${keptPositions} position${keptPositions === 1 ? "" : "s"} kept in wallet, not counted in PnL. This is the recorded count, not a live balance.`}</span> : null}
    {message ? <div className="fl-trade-message" role="status">{message}</div> : null}
    {props.identityStatus}
    {settings?.tradeMode === "portfolio" && portfolio && settings ? <PortfolioSummary portfolio={portfolio} settings={settings} status={view?.status ?? null} sessionExpiresAt={view?.sessionExpiresAt} /> : settings?.tradeMode === "portfolio" ? null : dca ? <DcaTiles dca={dca} settings={settings} live={view?.status === "armed"} /> : schedule ? <ScheduleSummary schedule={schedule} settings={settings!} open={trade!.open} {...(view?.hiredEntryWei === undefined ? {} : { hiredEntryWei: view.hiredEntryWei })} /> : <div className="fl-trade-metrics">
      <Metric label="Total Delegated" value={delegated} />
      <Metric label="Execution model" value={settings?.executionModel ?? "—"} note={settings === null ? undefined : `LLM model: ${tradeModelLabel(settings.primaryModel).replace(/^Auto:\s*/u, "")}`} credit={settings === null ? undefined : <ZeroGCredit />} />
      <Metric label="PnL since hire" value={v2 ? usdt2(gross, true) : fiat(gross, usdRate, true)} tone={grossTone} note={summary?.grossComplete ? grossPercent : summary?.grossReason ?? undefined} noteTone />
      <Metric label="Win rate" value={summary?.winRateBps === null || summary?.winRateBps === undefined ? "—" : bps(summary.winRateBps)} note={`${summary?.wins ?? "—"}/${summary?.closedTrades ?? 0} wins · gross`} />
      <Metric label="Open positions" value={`${summary?.openPositions ?? 0} / ${summary?.maxOpenPositions ?? settings?.maxOpenPositions ?? "—"}`} />
    </div>}
    {editing && settings !== null ? <EditPanel key={`${settings.name}:${settings.primaryModel}:${settings.fallbackModel}`} initial={settings} busy={busy} onCancel={() => setEditing(false)} onSave={props.saveSettings} />
      : settings?.tradeMode === "portfolio" ? portfolio && settings ? <PortfolioDetail portfolio={portfolio} settings={settings} runs={trade?.runs ?? []} icons={icons} refresh={props.refresh}
          simulationLog={simulationLog(Object.fromEntries(portfolio.tokens.map((row) => [row.token.toLowerCase(), row.symbol])))} />
        : <section className="fl-trade-table"><div className="fl-trade-empty">Portfolio unavailable. Refresh when the execution plane is available.</div></section>
      : dca ? <DcaDetail dca={dca} status={view?.status ?? null} draining={draining} planeUnreachable={props.planeUnreachable === true} busy={busy}
          refresh={props.refresh} icon={icons[dca.token.toLowerCase()] ?? null} runs={trade?.runs ?? []} symbols={{ [dca.token.toLowerCase()]: dca.symbol }}
          simulationLog={simulationLog({ [dca.token.toLowerCase()]: dca.symbol })}
          {...(props.pullDcaOrders === undefined ? {} : { pull: props.pullDcaOrders })} />
      : schedule ? <ScheduleTabs schedule={schedule} settings={settings!} trade={trade!} refresh={props.refresh} simulationLog={simulationLog({ [schedule.token.toLowerCase()]: schedule.symbol })} /> : <>
      <div className="fl-trade-tabs">{(settings?.settlementAsset === "USDT" ? ["Open Positions", "Closed Positions", "Run log", "CMC x402"] as const : ["Open Positions", "Closed Positions", "Run log"] as const).map((item) => <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      {tab === "CMC x402" ? <>
        <CmcBudgetPanel agentId={agentId} view={view} settings={settings!} budget={trade?.cmcBudget} owner={props.cmcOwner} refresh={props.refresh} renewalStatus={props.renewalStatus} />
        <section className="fl-trade-table"><div className="fl-trade-table__bar"><span>CMC log</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void props.refresh()}>Refresh</Button></div><CmcLog log={trade?.cmcLog} /></section>
      </> : tab === "Run log" ? <RunLogPanel {...(settings?.settlementAsset === "USDT" ? { simulationLog: simulationLog(tradeSymbols) } : {})} runLog={<section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void props.refresh()}>Refresh</Button></div><TradeRunLog runs={trade?.runs ?? []} symbols={tradeSymbols} /></section>} />
      : <section className="fl-trade-table">
        <div className="fl-trade-table__bar"><span>{tab}</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void props.refresh()}>Refresh</Button></div>
        {tab === "Open Positions"
          ? <><div className="fl-trade-position fl-trade-position--head"><span>Position</span><span>Age</span><span>Size</span><span>Exit plan</span><span>Chart</span><span className="fl-trade-heading-end">Unrealised</span><span className="fl-trade-heading-end">Actions</span></div>
            {positions.map((position) => <PositionRow key={position.positionId} position={position} open icon={icons[position.token.toLowerCase()] ?? null} expanded={expanded === position.positionId} onExpand={() => setExpanded(expanded === position.positionId ? null : position.positionId)} onSell={() => props.sellNow(position.positionId)} busy={busy} settings={settings} usdRate={usdRate} />)}</>
          : <><div className="fl-trade-position fl-trade-position--head fl-trade-position--closed"><span>Position</span><span>Exit reason</span><span>Held</span><span>Size</span><span>Entry / exit</span><span className="fl-trade-heading-end">Realised</span><span className="fl-trade-heading-end">Transactions</span></div>
            <div className="fl-trade-scroll" role="region" aria-label="Closed positions" tabIndex={0}>{closedNewestFirst(positions).map((position) => <ClosedPositionRow key={position.positionId} position={position} icon={icons[position.token.toLowerCase()] ?? null} usdRate={usdRate} settings={settings} />)}</div></>}
        {positions.length === 0 ? <div className="fl-trade-empty">No {tab.toLowerCase()}.</div> : null}
      </section>}
    </>}
  </div>;
}

/** "in 3h 12m 05s" until the next due slot; once due, the worker's next tick buys. */
export function countdownTo(dueAtMs: number, nowMs: number): string {
  if (!Number.isSafeInteger(dueAtMs) || !Number.isSafeInteger(nowMs)) return "—";
  const left = dueAtMs - nowMs;
  if (left <= 0) return "due now — buys on the next cycle";
  const total = Math.floor(left / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours >= 24 ? `in ${Math.floor(hours / 24)}d ${pad(hours % 24)}h ${pad(minutes)}m` : `in ${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
}

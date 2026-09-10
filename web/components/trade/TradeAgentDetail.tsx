"use client";

import React, { useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import { Button, Icon, StatusBadge } from "@/design-system";
import { AttentionChip, GasNotice, gasAttention } from "@/components/agent/GasNotice";
import { MarketChart, type MarketChartMarker } from "@/components/MarketChart";
import { TradeRunLog } from "./TradeRunLog";
import { TokenIcon } from "@/components/TokenIcon";
import { ZeroGCredit } from "@/components/ZeroGCredit";
import { relativeTime, type AgentDetailView } from "@/lib/exec/agent-detail";
import { TRADE_LLM_MODELS, stopLossBpsFromPercent, stopLossPercentFromBps, tradeModelLabel, type TradePositionView, type TradeSettings, type TradeView } from "@/lib/trade";

type TradeTab = "Open Positions" | "Closed Positions" | "Run log";

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
  readonly hardRevoke: () => void;
  readonly sellNow: (positionId: string) => void;
  readonly saveSettings: (settings: TradeSettings) => Promise<void>;
};

function compactAddress(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function bps(value: number | string | null, signed = false): string {
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

function bnbUsdRate(view: AgentDetailView | null): number | null {
  const rawBnb = view?.dailyNativeLimit.bnb?.replace(/[^0-9.]/gu, "") ?? "";
  const rawUsd = view?.dailyNativeLimit.usd?.replace(/[^0-9.]/gu, "") ?? "";
  const native = Number(rawBnb), usd = Number(rawUsd);
  return Number.isFinite(native) && native > 0 && Number.isFinite(usd) ? usd / native : null;
}

function fiat(wei: string | null, rate: number | null, signed = false): string {
  if (wei === null || rate === null) return bnb(wei, signed);
  try {
    const amount = Number(formatEther(BigInt(wei))) * rate;
    if (!Number.isFinite(amount)) return bnb(wei, signed);
    return `${amount > 0 && signed ? "+" : amount < 0 ? "-" : ""}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function positionPnlWei(position: TradePositionView): string | null {
  const quote = position.observation?.currentQuoteWei;
  if (quote === null || quote === undefined) return null;
  try { return (BigInt(quote) - BigInt(position.entryWei)).toString(10); }
  catch { return null; }
}

function txUrl(hash: string | null): string | null {
  return hash === null ? null : `https://bscscan.com/tx/${hash}`;
}

function useTokenIcons(addresses: readonly string[]): Readonly<Record<string, string | null>> {
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const key = useMemo(() => [...new Set(addresses.map((address) => address.toLowerCase()))].sort().join(","), [addresses]);
  useEffect(() => {
    const unique = key === "" ? [] : key.split(",");
    if (unique.length === 0) return;
    const controller = new AbortController();
    void Promise.all(Array.from({ length: Math.ceil(unique.length / 8) }, (_, index) => {
      const chunk = unique.slice(index * 8, index * 8 + 8);
      return fetch(`/api/token-icons?v=2&addresses=${encodeURIComponent(chunk.join(","))}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : null)
        .then((payload: { readonly data?: Record<string, string | null> } | null) => payload?.data ?? {});
    })).then((chunks) => setIcons(Object.assign({}, ...chunks))).catch(() => undefined);
    return () => controller.abort();
  }, [key]);
  return icons;
}

function Metric({ label, value, note, tone = "normal", credit }: { readonly label: string; readonly value: string; readonly note?: string; readonly tone?: "normal" | "profit" | "loss"; readonly credit?: React.ReactNode }) {
  return <div className="fl-trade-metric">
    <span className="fl-trade-kicker">{label}</span>
    <strong className={`fl-trade-metric__value fl-trade-metric__value--${tone}`}>{value}</strong>
    {note ? <span className="fl-trade-metric__note">{note}</span> : null}
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

function EditPanel({ initial, onCancel, onSave, busy }: {
  readonly initial: TradeSettings;
  readonly onCancel: () => void;
  readonly onSave: (settings: TradeSettings) => Promise<void>;
  readonly busy: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try { await onSave(draft); onCancel(); }
    finally { setSaving(false); }
  };
  return <section className="fl-trade-edit">
    <div className="fl-trade-edit__intro">
      <div><span className="fl-trade-kicker">Execution model</span><p>Live deployment settings. Only the controls enabled below can change.</p></div>
      <button type="button" className="fl-trade-reset" onClick={() => setDraft({ ...draft, noReentry: true, takeProfitBps: 10_000, stopLossBps: 5_000, maxHoldSec: 7_200, slippageBps: 300, primaryModel: "0gm-1.0-35b-a3b", fallbackModel: "glm-5.3-flash" })}>Reset parameters to defaults</button>
    </div>
    <div className="fl-trade-edit__check"><input id="trade-no-reentry" type="checkbox" checked={draft.noReentry} onChange={(event) => setDraft({ ...draft, noReentry: event.target.checked })} /><label htmlFor="trade-no-reentry">No re-entry</label></div>
    <div className="fl-trade-kicker">Exit</div>
    <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
      <label><span><input type="checkbox" checked={draft.takeProfitBps !== null} onChange={(event) => setDraft({ ...draft, takeProfitBps: event.target.checked ? 10_000 : null })} /> Take profit</span><Stepper value={(draft.takeProfitBps ?? 10_000) / 100} suffix="%" min={1} max={100} onChange={(value) => setDraft({ ...draft, takeProfitBps: Math.round(value * 100) })} /></label>
      <label><span><input type="checkbox" checked={draft.stopLossBps !== null} onChange={(event) => setDraft({ ...draft, stopLossBps: event.target.checked ? 5_000 : null })} /> Stop loss</span><Stepper value={stopLossPercentFromBps(draft.stopLossBps ?? 5_000)} suffix="%" min={-100} max={-1} onChange={(value) => setDraft({ ...draft, stopLossBps: stopLossBpsFromPercent(value) })} /></label>
      <label><span>Max holding time</span><Stepper value={Math.round((draft.maxHoldSec ?? 7_200) / 60)} suffix="min" min={1} max={10_080} onChange={(value) => setDraft({ ...draft, maxHoldSec: value * 60 })} /></label>
    </div>
    <div className="fl-trade-kicker">Risk and execution</div>
    <div className="fl-trade-edit__grid fl-trade-edit__grid--three">
      <label><span>Slippage tolerance</span><Stepper value={draft.slippageBps / 100} suffix="%" min={0.5} max={5} step={0.5} onChange={(value) => setDraft({ ...draft, slippageBps: Math.round(value * 100) })} /><small>Between 0.5% and 5%.</small></label>
      <label><span>Primary model</span><select value={draft.primaryModel} onChange={(event) => setDraft({ ...draft, primaryModel: event.target.value as TradeSettings["primaryModel"] })}>{TRADE_LLM_MODELS.map((model) => <option key={model.id} value={model.id} disabled={model.id === draft.fallbackModel}>{model.label}</option>)}</select></label>
      <label><span>Fallback model</span><select value={draft.fallbackModel} onChange={(event) => setDraft({ ...draft, fallbackModel: event.target.value as TradeSettings["fallbackModel"] })}>{TRADE_LLM_MODELS.map((model) => <option key={model.id} value={model.id} disabled={model.id === draft.primaryModel}>{model.label}</option>)}</select></label>
    </div>
    <div className="fl-trade-edit__footer"><Button variant="primary" disabled={busy || saving} onClick={() => void submit()}>Save</Button><Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button><span>Changes apply to the live agent immediately.</span></div>
  </section>;
}

function verifiedRealised(position: TradePositionView): boolean {
  return position.fillStatus === "verified" && position.tokenAmount !== null
    && position.soldTokenAmount === position.tokenAmount
    && position.exitFillStatus === "verified" && position.exitWei !== null;
}

function PositionRow({ position, open, icon, expanded, onExpand, onSell, busy, settings, usdRate }: {
  readonly position: TradePositionView;
  readonly open: boolean;
  readonly icon: string | null;
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly onSell: () => void;
  readonly busy: boolean;
  readonly settings: TradeSettings | null;
  readonly usdRate?: number | null;
}) {
  const symbol = positionSymbol(position);
  const realised = open || verifiedRealised(position);
  const pnlWei = open ? positionPnlWei(position) : !realised || position.exitWei === null ? null : (BigInt(position.exitWei) - BigInt(position.entryWei)).toString(10);
  const pnl = open ? position.observation?.pnlBps ?? position.pnlBps : realised ? position.pnlBps : null;
  const tone = pnl === null ? "flat" : BigInt(pnl) < 0n ? "loss" : "profit";
  const marker: readonly MarketChartMarker[] = [{ timestamp: position.openedAt, side: "buy" }];
  return <>
    <div className="fl-trade-position">
      <div className="fl-trade-position__token"><TokenIcon src={icon} symbol={symbol} size={26} /><span><strong>{symbol} / BNB</strong><small>{compactAddress(position.token)}</small></span></div>
      <div className="fl-trade-position__age">{positionAge(position)}</div>
      <div className="fl-trade-position__size"><strong>{tokenAmount(position)} <small>{symbol}</small></strong><span>@ {bnb(position.entryWei)}</span><span>{position.fillStatus === "verified" ? "verified fill" : "fill amount pending"}</span></div>
      <div className="fl-trade-position__plan">
        {open ? <><strong><i className="is-tp" />TP {bps(settings?.takeProfitBps ?? null)} pending</strong><span><i />Stop {settings?.stopLossBps === null || settings?.stopLossBps === undefined ? "—" : bps(-settings.stopLossBps)}</span></> : <><strong>{position.closeReason?.replace(/-/gu, " ") ?? "closed"}</strong><span>{position.exitFillStatus === "verified" ? "verified fill" : "unverified fill"}</span></>}
      </div>
      <button type="button" className={`fl-trade-chart-button ${expanded ? "is-active" : ""}`} aria-label={`${expanded ? "Hide" : "Show"} ${symbol} chart`} onClick={onExpand}><Icon name="yield" size={18} /></button>
      <div className={`fl-trade-position__pnl is-${tone}`}><strong>{fiat(pnlWei, usdRate ?? null, true)}</strong><span>{bps(pnl, true)}</span></div>
      <div className="fl-trade-position__actions">
        {open ? <Button variant="danger" size="sm" disabled={busy || position.exitRequestedAt !== null} onClick={onSell}>{position.exitRequestedAt === null ? "Sell" : "Selling"}</Button> : null}
        {txUrl(open ? position.entryTxHash : position.exitTxHash) ? <a href={txUrl(open ? position.entryTxHash : position.exitTxHash)!} target="_blank" rel="noreferrer">Tx <Icon name="external" size={11} /></a> : <span>—</span>}
      </div>
    </div>
    {expanded ? <div className="fl-trade-position__expanded">
      <div className="fl-trade-position__chart-head"><strong>{symbol} / BNB {open ? "open position" : "closed position"}</strong><span className="is-entry">● Entry</span>{open ? <span className="is-tp">● TP</span> : null}<strong className={`is-${tone}`}>{bps(pnl, true)}</strong></div>
      <MarketChart kind="token" address={position.token} title={`${symbol} / BNB`} markers={marker} embedded height={230} />
      <div className="fl-trade-position__chart-foot"><span>ENTRY {new Date(position.openedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span><span>{open ? `HOLD ${Math.floor((Date.now() - position.openedAt) / 60_000)} / ${Math.round((settings?.maxHoldSec ?? 0) / 60)} MIN` : `CLOSED ${position.closedAt === null ? "—" : new Date(position.closedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`}</span></div>
    </div> : null}
  </>;
}

function ClosedPositionRow({ position, icon, usdRate }: {
  readonly position: TradePositionView;
  readonly icon: string | null;
  readonly usdRate: number | null;
}) {
  const symbol = positionSymbol(position);
  const complete = verifiedRealised(position);
  const pnlWei = complete && position.exitWei !== null
    ? (BigInt(position.exitWei) - BigInt(position.entryWei)).toString(10) : null;
  const tone = !complete || position.pnlBps === null ? "flat" : BigInt(position.pnlBps) < 0n ? "loss" : "profit";
  return <div className="fl-trade-position fl-trade-position--closed">
    <div className="fl-trade-position__token"><TokenIcon src={icon} symbol={symbol} size={26} /><span><strong>{symbol} / BNB</strong><small>{compactAddress(position.token)}</small></span></div>
    <div>{position.closeReason?.replace(/-/gu, " ") ?? "—"}</div>
    <div>{position.closedAt === null ? "—" : relativeTime(position.openedAt, position.closedAt).text.replace(/^about /u, "")}</div>
    <div>{tokenAmount(position)} {symbol}</div>
    <div><strong>{bnb(position.entryWei)}</strong><span className="fl-trade-position__closed-sub"> → {complete ? bnb(position.exitWei) : "—"}</span></div>
    <div className={`fl-trade-position__pnl is-${tone}`} title={complete ? undefined : "Realised result requires verified basis, sold amount, and proceeds."}><strong>{fiat(pnlWei, usdRate, true)}</strong><span>{complete ? bps(position.pnlBps, true) : "—"}</span></div>
    <div className="fl-trade-position__actions">{([["Buy", position.entryTxHash], ["Sell", position.exitTxHash]] as const).map(([label, hash]) => hash === null ? <span key={label}>{label} —</span> : <a key={label} href={txUrl(hash)!} target="_blank" rel="noreferrer">{label} <Icon name="external" size={11} /></a>)}</div>
  </div>;
}

export function TradeAgentDetail(props: Props) {
  const { agentId, view, trade, busy, message, signedOut } = props;
  const [tab, setTab] = useState<TradeTab>("Open Positions");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const settings = trade?.settings ?? null;
  const positions = tab === "Open Positions" ? trade?.open ?? [] : trade?.closed ?? [];
  const iconAddresses = useMemo(() => [...(trade?.open ?? []), ...(trade?.closed ?? []), ...(trade?.pinned ?? [])].map((item) => "token" in item ? item.token : item.address), [trade]);
  const icons = useTokenIcons(iconAddresses);
  const delegated = view?.dailyNativeLimit.usd ?? view?.dailyNativeLimit.bnb ?? view?.dailyNativeLimit.value ?? "—";
  const usdRate = bnbUsdRate(view);
  const summary = trade?.summary;
  const gross = summary?.grossDeltaWei ?? null;
  const grossTone = gross === null ? "normal" : BigInt(gross) < 0n ? "loss" : "profit";
  const status = view?.status === "armed" ? "live" : "paused";
  const draining = trade?.lifecycle?.draining === true;
  const statusLabel = view === null ? "—" : draining ? "draining" : ["provisioning", "revoked", "retired"].includes(view.status) ? view.status : undefined;
  const unresolved = trade?.pendingIntents ?? [];
  const recoveryRequired = unresolved.length > 0 || (trade?.open ?? []).some((position) => position.status === "orphaned");
  return <div className="fl-shell fl-hired-agent-page fl-trade-detail-page">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => props.go("/account")}>My agents</Button>
    <div className="fl-trade-hero">
      <div className="fl-trade-title"><span className="fl-card__glyph"><Icon name="yield" size={22} /></span><h1>{settings?.name ?? view?.id ?? agentId}</h1><StatusBadge status={status} pill {...(statusLabel === undefined ? {} : { label: statusLabel })} /><AttentionChip state={gasAttention(view?.gas)} title="This agent needs BNB for relay gas." /></div>
      <GasNotice gas={view?.gas} walletAddress={view?.walletAddress} />
      <div className="fl-hired-actions">
        {signedOut ? <Button variant="primary" onClick={() => void props.signIn()}>Sign in to view</Button> : null}
        <Button variant={editing ? "primary" : "secondary"} icon={<Icon name="settings" size={15} />} disabled={busy || settings === null || draining || unresolved.length > 0} onClick={() => setEditing((value) => !value)}>{editing ? "Editing" : "Edit"}</Button>
        <Button variant="secondary" icon={<Icon name="pause" size={15} />} disabled={busy || view === null || (view.status !== "armed" && view.status !== "paused") || draining} onClick={props.togglePause}>{view?.status === "paused" ? "Resume" : "Pause"}</Button>
        <Button variant="danger" icon={<Icon name="revoke" size={15} />} disabled={busy || view === null || props.removed} onClick={props.remove}>{props.removed ? "Removed" : view?.status === "revoked" ? "Finish removal" : draining ? "Removing" : "Remove"}</Button>
      </div>
    </div>
    {message ? <div className="fl-trade-message" role="status">{message}</div> : null}
    {props.identityStatus}
    {recoveryRequired ? <div className="fl-trade-message fl-trade-message--warning" role="alert">
      <span>Removal is blocked by unresolved execution {unresolved.map((intent) => intent.decisionId).join(", ") || "or an orphaned token"}. Hard revoke stops future authority but does not complete conversion to BNB.</span>
      <span className="fl-trade-message__actions"><Button variant="danger" size="sm" disabled={busy || view?.sessionPublicKey === null} onClick={props.hardRevoke}>Hard revoke</Button><Button variant="secondary" size="sm" onClick={() => props.go("/account")}>Account recovery</Button></span>
    </div> : null}
    <div className="fl-trade-metrics">
      <Metric label="Delegated" value={delegated} note="24h spend authority · not escrowed" />
      <Metric label="Execution model" value={settings?.executionModel ?? "—"} note={settings === null ? undefined : `LLM model: ${tradeModelLabel(settings.primaryModel).replace(/^Auto:\s*/u, "")}`} credit={settings === null ? undefined : <ZeroGCredit />} />
      <Metric label="PnL since hire" value={fiat(gross, usdRate, true)} tone={grossTone} note={summary?.grossComplete ? "gross · relay costs excluded" : summary?.grossReason ?? "gross · relay costs excluded"} />
      <Metric label="Win rate" value={summary?.winRateBps === null || summary?.winRateBps === undefined ? "—" : bps(summary.winRateBps)} note={`${summary?.wins ?? "—"}/${summary?.closedTrades ?? 0} wins · gross`} />
      <Metric label="Open positions" value={`${summary?.openPositions ?? 0} / ${summary?.maxOpenPositions ?? settings?.maxOpenPositions ?? "—"}`} note={summary?.maxOpenPositions === null || summary?.maxOpenPositions === undefined ? undefined : `${Math.max(0, summary.maxOpenPositions - summary.openPositions)} slot${summary.maxOpenPositions - summary.openPositions === 1 ? "" : "s"} free`} />
    </div>
    {editing && settings !== null ? <EditPanel key={`${settings.name}:${settings.primaryModel}:${settings.fallbackModel}`} initial={settings} busy={busy} onCancel={() => setEditing(false)} onSave={props.saveSettings} /> : <>
      <div className="fl-trade-tabs">{(["Open Positions", "Closed Positions", "Run log"] as const).map((item) => <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      {tab === "Run log" ? <section className="fl-trade-table"><div className="fl-trade-table__bar"><span>Run log</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void props.refresh()}>Refresh</Button></div><TradeRunLog runs={trade?.runs ?? []} symbols={Object.fromEntries([...(trade?.open ?? []), ...(trade?.closed ?? [])].map((position) => [position.token.toLowerCase(), positionSymbol(position)]))} /></section> : <section className="fl-trade-table">
        <div className="fl-trade-table__bar"><span>{tab}</span><Button variant="ghost" size="sm" icon={<Icon name="refresh" size={13} />} onClick={() => void props.refresh()}>Refresh</Button></div>
        {tab === "Open Positions"
          ? <><div className="fl-trade-position fl-trade-position--head"><span>Position</span><span>Age</span><span>Size</span><span>Exit plan</span><span>Chart</span><span className="fl-trade-heading-end">Unrealised</span><span className="fl-trade-heading-end">Actions</span></div>
            {positions.map((position) => <PositionRow key={position.positionId} position={position} open icon={icons[position.token.toLowerCase()] ?? null} expanded={expanded === position.positionId} onExpand={() => setExpanded(expanded === position.positionId ? null : position.positionId)} onSell={() => props.sellNow(position.positionId)} busy={busy} settings={settings} usdRate={usdRate} />)}</>
          : <><div className="fl-trade-position fl-trade-position--head fl-trade-position--closed"><span>Position</span><span>Exit reason</span><span>Held</span><span>Size</span><span>Entry / exit</span><span className="fl-trade-heading-end">Realised</span><span className="fl-trade-heading-end">Transactions</span></div>
            {positions.map((position) => <ClosedPositionRow key={position.positionId} position={position} icon={icons[position.token.toLowerCase()] ?? null} usdRate={usdRate} />)}</>}
        {positions.length === 0 ? <div className="fl-trade-empty">No {tab.toLowerCase()}.</div> : null}
      </section>}
    </>}
  </div>;
}

"use client";
import { lpSequenceLabel } from "../../lib/exec/remove-agent";
import React, { useEffect, useState } from "react";
import { Button, Category, Icon, MetricTile, Num, SegmentedToggle, StatusBadge } from "@/design-system";
import { TRADE_LLM_MODELS } from "@/lib/trade";
import { PairIcons } from "@/components/TokenIcon";
import { ZeroGCredit } from "@/components/ZeroGCredit";
import { HireRecoveryActions } from "@/components/deploy/HireRecoveryActions";
import { LiquidityChart, displayOrientation, type LiquidityGeometry } from "@/components/lp/LiquidityChart";
import { relativeTime, type AgentDetailView, type DetailMetric, type DetailPosition } from "@/lib/exec/agent-detail";
import type { UseAgentDetailResult } from "@/lib/exec/use-agent-detail";
import type { OnChainPosition, OnChainPositionRead } from "@/lib/altana/position-reader";
import { formatAtomic } from "@/lib/exec/pairs";
import { isTerminalSequence } from "@/lib/exec/remove-agent";
import { formatPrice, priceFromTick } from "@/lib/lp/range";
import { farmAprMetric, unavailableApr, type RangeApr } from "@/lib/lp/pool-range";
import { DUST_EXPLAINER, dustMetric, type DustRead } from "@/lib/lp/dust";
import { liveInRange, liveReadFor, liveValueMetric, type LivePricing } from "@/lib/lp/live";
import { lpAccountingPnl, lpAccountingFees, matchingLpAccounting, type LpAccountingRead } from "@/lib/lp/accounting";
export const LP_EDIT_TITLE = "Settings editing is not available for LP agents yet — the plane does not return owner instructions to the browser, and a partial save would erase them.";
type Props = {
  readonly identityStatus?: React.ReactNode;
  agentId: string;
  go: (route: string) => void;
  detail: UseAgentDetailResult;
  view: AgentDetailView | null;
  busy: boolean;
  message: string;
  actionsDisabled: boolean;
  removeDisabled: boolean;
  removeTitle?: string;
  removeLabel: string;
  removeCallsId?: string;
  removeTransactionHash?: string;
  showResolve: boolean;
  showAbandon: boolean;
  signedOut: boolean;
  onWithdraw: (positionId: string) => void;
  chainReads: ReadonlyMap<string, OnChainPositionRead>;
  dust?: DustRead;
  accounting?: LpAccountingRead;
  discovered?: readonly OnChainPosition[];
  onTogglePause: () => void;
  onRemove: () => void;
  onResolve: () => void;
  onAbandon: () => void;
};
const short = (v: string) => v.length < 14 ? v : `${v.slice(0, 6)}…${v.slice(-4)}`;
const unavailable = (reason: string): DetailMetric => ({ value: null, reason });
export function usdMetric(metric: DetailMetric): DetailMetric {
  return metric.value === null || /^[+-]?\$/.test(metric.value) ? metric : unavailable("USD price unavailable");
}
export function InfoHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <span
    style={{ position: "relative", display: "inline-flex" }}
    onMouseEnter={() => setOpen(true)}
    onMouseLeave={() => setOpen(false)}>
    <button
      type="button"
      aria-label={text}
      title={text}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen(value => !value)}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0,
        borderRadius: 999, border: "1px solid var(--line-1)", background: "transparent", color: "var(--text-subtle)", cursor: "help"
      }}><Icon name="info" size={11} /></button>
    {open ? <span
      role="tooltip"
      style={{
        position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 30, width: 260, padding: "10px 12px",
        borderRadius: "var(--radius-sm)", border: "1px solid var(--border-card)", background: "var(--surface-card)",
        boxShadow: "0 8px 24px rgb(0 0 0 / 0.45)", font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-sans)",
        color: "var(--ink-1)", textTransform: "none", letterSpacing: "normal", whiteSpace: "normal", textAlign: "left"
      }}>{text}</span> : null}
  </span>;
}
export function MetricCell({ metric, money = false, showNote = false }: {
  metric: DetailMetric;
  money?: boolean;
  showNote?: boolean;
}) {
  const reason = metric.reason?.replace(/^—\s*/u, "") ?? "source unavailable";
  return <div title={metric.value === null ? reason : metric.note ?? undefined}>
    <div>
      {money ? <Num value={metric.value ?? "—"} size="sm" /> : metric.value ?? "—"}
    </div>
    {metric.value !== null && showNote && metric.note !== undefined
      ? <small style={{ color: "var(--text-subtle)", display: "block", maxWidth: 230 }}>{metric.note}</small>
      : null}
  </div>;
}
function Panel({ children }: {
  children: React.ReactNode;
}) {
  return <section
    style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", overflow: "auto" }}>
    {children}
  </section>;
}
function useIcons(pool: AgentDetailView["lp"]) {
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const key = pool?.pool ? `${pool.pool.token0},${pool.pool.token1}` : "";
  useEffect(() => {
    setIcons({});
    if (!key)
      return;
    const controller = new AbortController();
    void fetch(`/api/token-icons?addresses=${key}`, { signal: controller.signal }).then(r => r.json()).then((p: {
      data?: Record<string, string | null>;
    }) => {
      if (!controller.signal.aborted)
        setIcons(p.data ?? {});
    }).catch(() => undefined);
    return () => controller.abort();
  }, [key]);
  return icons;
}
function useApr(address: string | null, range: {
  tickLower: number;
  tickUpper: number;
} | null, capital: number | null) {
  const key = address && range && capital !== null && capital > 0 ? `address=${address}&tickLower=${range.tickLower}&tickUpper=${range.tickUpper}&capitalUsd=${capital}` : "";
  const [state, setState] = useState<{
    key: string;
    value: RangeApr;
  }>({ key: "", value: unavailableApr("range and fresh capital price required") });
  useEffect(() => {
    if (!key)
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/pool-range?${key}`, { signal: controller.signal, cache: "no-store" });
        const p = await response.json() as {
          data?: RangeApr;
        };
        if (!controller.signal.aborted)
          setState({ key, value: response.ok && p.data ? p.data : unavailableApr("http unavailable") });
      }
      catch {
        if (!controller.signal.aborted)
          setState({ key, value: unavailableApr("http unavailable") });
      }
      finally {
        if (!controller.signal.aborted)
          timer = setTimeout(load, 30000);
      }
    };
    void load();
    return () => {
      controller.abort(); if (timer)
        clearTimeout(timer);
    };
  }, [key]);
  return state.key === key ? state.value : unavailableApr(key ? "reading range estimate" : "range and fresh capital price required");
}

/**
 * The POOL's CAKE farm APR from the data plane (`cakeFarmApr` — PancakeSwap's
 * own figure), NOT what this position earns. LP v1 never stakes the NFT in
 * MasterChefV3 (`stakingEnabled` must be false, `src/lp/triggers.ts`), so the
 * note says so instead of letting a number imply yield the agent never
 * collects.
 */
function usePoolFarm(address: string | null) {
  const key = address ?? "";
  type Farm = { cakeFarmApr: number | null; asOf: number | null; staleness: string; reason: string | null };
  const [state, setState] = useState<{ key: string; value: Farm }>(
    { key: "", value: { cakeFarmApr: null, asOf: null, staleness: "unavailable", reason: "pool address unavailable" } });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/pools?address=${key}`, { signal: controller.signal, cache: "no-store" });
        const payload = await response.json() as { data?: { cakeFarmApr?: unknown; asOf?: unknown; staleness?: unknown } };
        if (controller.signal.aborted) return;
        const pool = response.ok ? payload.data : undefined;
        const apr = typeof pool?.cakeFarmApr === "number" && Number.isFinite(pool.cakeFarmApr) && pool.cakeFarmApr >= 0 ? pool.cakeFarmApr : null;
        setState({
          key, value: {
            cakeFarmApr: apr,
            asOf: typeof pool?.asOf === "number" && Number.isSafeInteger(pool.asOf) && pool.asOf >= 0 ? pool.asOf : null,
            staleness: typeof pool?.staleness === "string" ? pool.staleness : "unavailable",
            reason: pool === undefined ? "farm data unavailable" : apr === null ? "this pool reports no CAKE farm" : null,
          },
        });
      }
      catch {
        if (!controller.signal.aborted)
          setState({ key, value: { cakeFarmApr: null, asOf: null, staleness: "unavailable", reason: "farm data unavailable" } });
      }
      finally {
        if (!controller.signal.aborted)
          timer = setTimeout(load, 60000);
      }
    };
    void load();
    return () => {
      controller.abort(); if (timer)
        clearTimeout(timer);
    };
  }, [key]);
  return state.key === key ? state.value : { cakeFarmApr: null, asOf: null, staleness: "unavailable", reason: key ? "reading farm APR" : "pool address unavailable" };
}
export function liquidityMetric(read: OnChainPositionRead | undefined, pool: NonNullable<AgentDetailView["lp"]>["pool"]): DetailMetric {
  if (!read)
    return unavailable("waiting for the plane to record this position's NFT");
  if (read.kind === "unreadable")
    return unavailable(read.reason);
  if (read.kind === "burned")
    return unavailable("NFT no longer exists");
  if (read.liquidity === 0n)
    return { value: "0 (empty)", reason: null, note: `snapshot block ${read.blockNumber}` };
  if (!read.amountsAvailable || read.sqrtPriceX96 === null)
    return unavailable("principal price unavailable at snapshot block");
  if (!pool || pool.decimals0 === null || pool.decimals1 === null)
    return unavailable("token decimals unavailable");
  const a = formatAtomic(read.amounts.amount0.toString(), pool.decimals0, 3), b = formatAtomic(read.amounts.amount1.toString(), pool.decimals1, 3);
  const value0 = read.amounts.amount0 * read.sqrtPriceX96 * read.sqrtPriceX96, value1 = read.amounts.amount1 * (1n << 192n);
  const total = value0 + value1, pct0 = total === 0n ? null : Number(value0 * 1000n / total) / 10;
  return { value: `${a} ${pool.symbol0} / ${b} ${pool.symbol1}`, reason: null, note: `${pct0 === null ? "split unavailable" : `${pct0}% / ${(100 - pct0).toFixed(1)}%`}` };
}
export function LpRangeEvents({ live, lp, geometry, positionId, sequences, status, now }: {
  live: boolean;
  lp: AgentDetailView["lp"];
  geometry: LiquidityGeometry | null;
  positionId: string;
  sequences: AgentDetailView["sequences"];
  status: string | undefined;
  now: number;
}) {
  if (!live)
    return <div style={{ marginTop: 12 }}>LAST OBSERVED {lp?.currentTickAsOfMs ? relativeTime(lp.currentTickAsOfMs, now).text : "no current observation"}</div>;
  const band = lp?.liveRange;
  const tick = lp?.currentTick;
  if (!band || tick === null || tick === undefined || !geometry)
    return <MetricCell metric={unavailable(lp?.liveRangeReason ?? "range geometry unavailable")} />;
  const orientation = displayOrientation(geometry);
  const inside = tick >= band.tickLower && tick < band.tickUpper;
  const progress = (tick - band.tickLower) / (band.tickUpper - band.tickLower);
  const through = Math.round(100 * (orientation.quoteIsToken0 ? 1 - progress : progress));
  const above = orientation.quoteIsToken0 ? tick < band.tickLower : tick >= band.tickUpper;
  const blocking = sequences.find(s => s.positionId === positionId && !isTerminalSequence(s));
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12, font: "var(--type-mono-xs)" }}>

    {inside ? <span>{through}% THROUGH BAND</span> : <>

      <span>OUT OF RANGE · {above ? "ABOVE BAND" : "BELOW BAND"}</span>

      {lp?.settingsTrusted && lp.settings ? <span>
        {lp.settings.autoRotate ? `AUTO-REBALANCE ON · cooldown ${lp.settings.rotateMinHoldMinutes}m` : "AUTO-REBALANCE OFF"}
      </span> : <MetricCell metric={unavailable(lp?.settingsReason ?? "rotation settings unavailable")} />}

      {blocking ? <span>BLOCKED · {blocking.kind} {blocking.state}</span> : null}

      {status === "paused" ? <span>PAUSED</span> : null}

      <span>NOT EARNING FEES</span>

    </>}

  </div>;
}
export function LpAgentDetail(props: Props) {
  const { view, detail } = props, lp = view?.lp ?? null, pool = lp?.pool ?? null;
  const [tab, setTab] = useState("Overview"), [expanded, setExpanded] = useState<string | null>(null), [unit, setUnit] = useState("USD"), [invert, setInvert] = useState(false), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setExpanded(null); setTab("Overview"); setInvert(false); }, [props.agentId, pool?.poolAddress]);
  const icons = useIcons(lp), cat = Category("lp"), sigma = lp?.model === "sigma";
  const tickAge = lp?.currentTickAsOfMs === null || lp?.currentTickAsOfMs === undefined ? Infinity : now - lp.currentTickAsOfMs;
  const live = lp?.currentTickFresh === true && tickAge >= 0 && tickAge <= 60000;
  const range = live ? lp?.liveRange ?? null : lp?.openingRange ?? null;
  const geometry: LiquidityGeometry | null = pool && pool.tickSpacing && pool.decimals0 !== null && pool.decimals1 !== null && pool.symbol0 && pool.symbol1 && lp?.currentTick !== null && lp?.currentTick !== undefined
    ? {
      spacing: pool.tickSpacing, currentTick: lp.currentTick, currentTickAsOfMs: lp.currentTickAsOfMs ?? 0,
      orientation: { quoteIsToken0: pool.quoteIsToken0 ?? false, decimals0: pool.decimals0, decimals1: pool.decimals1, symbol0: pool.symbol0, symbol1: pool.symbol1 }, display: { invert }
    } : null;
  const capital = lp?.valuation.rawWei && lp.wbnbUsd ? Number(BigInt(lp.valuation.rawWei)) * lp.wbnbUsd / 1e18 : null;
  const apr = useApr(pool?.poolAddress ?? null, range, capital);
  const aprFresh = apr.meta.asOf !== null && now - apr.meta.asOf >= 0 && now - apr.meta.asOf <= 60000 && apr.meta.staleness === "fresh";
  const aprNumber = apr.estimatedAprPct ?? apr.basis.lpFeeApr24h;
  const aprMetric: DetailMetric = aprNumber === null ? unavailable(apr.unavailable[0] ?? "estimate unavailable") : {
    value: `${aprNumber.toFixed(1)}%`, reason: null,
    note: `${apr.estimatedAprPct === null ? "pool · 24h" : "est. · 24h fee basis"} · ${aprFresh ? "fresh" : "stale"}${!live ? " · opening reference" : ""}${apr.rounded ? " · rounded range" : ""}${apr.unavailable.length ? ` · ${apr.unavailable.join("; ")}` : ""}`
  };
  const farm = usePoolFarm(pool?.poolAddress ?? null);
  // PancakeSwap prices a POSITION's farm APR, not the pool's: a narrow range
  // earns the same share of CAKE emissions that it earns of fees, so the pool
  // figure is scaled by the very multiplier the fee estimate already uses. The
  // residual gap to PancakeSwap's own number is its staked-liquidity share and
  // veCAKE boost, which the data plane does not serve.
  const farmMetric: DetailMetric = farmAprMetric({ ...farm, concentrationMultiplier: apr.concentrationMultiplier });
  const dust = dustMetric({
    read: props.dust,
    decimals0: pool?.decimals0 ?? null, decimals1: pool?.decimals1 ?? null,
    symbol0: pool?.symbol0 ?? "token0", symbol1: pool?.symbol1 ?? "token1"
  });
  const pricing: LivePricing = {
    quoteIsToken0: pool?.quoteIsToken0 ?? false,
    decimals0: pool?.decimals0 ?? null, decimals1: pool?.decimals1 ?? null,
    quoteMicros: pool?.quoteUsd === null || pool?.quoteUsd === undefined ? null : BigInt(Math.round(pool.quoteUsd * 1_000_000)),
    symbol0: pool?.symbol0 ?? "token0", symbol1: pool?.symbol1 ?? "token1",
  };
  const discovered = props.discovered ?? [];
  const wbnbUsdMicros = lp?.wbnbUsd === null || lp?.wbnbUsd === undefined ? null : BigInt(Math.round(lp.wbnbUsd * 1_000_000));
  // The newest open row is the one the tiles speak for.
  const openRow = (view?.positions ?? []).find(row => row.state !== "closed");
  const tileRead = liveReadFor({ tokenId: openRow?.tokenId ?? null, chainReads: props.chainReads, discovered });
  const accounting = matchingLpAccounting({read:props.accounting,wallet:view?.walletAddress ?? null,
    pool:pool?.poolAddress ?? null,tokenId:tileRead?.position.tokenId ?? null,nowMs:now});
  const pnl = lpAccountingPnl(accounting, lp?.budgetWei ?? null, wbnbUsdMicros);
  const pnlTone = pnl.rawWei === undefined || BigInt(pnl.rawWei) === 0n ? "flat" : BigInt(pnl.rawWei) < 0n ? "loss" : "profit";
  const liveFees = lpAccountingFees(accounting,{...pricing,wbnbMicros:wbnbUsdMicros});
  const earnedFees = lp?.feeMetric?.value !== null && lp?.feeMetric !== undefined ? lp.feeMetric : liveFees;
  const limit = view?.dailyNativeLimit ?? unavailable("session limit unavailable");
  const delegated = limit.value === null ? "—" : unit === "USD" ? limit.usd ?? "—" : limit.bnb ?? limit.value;
  const positions = view?.positions ?? [], rows = positions.filter(p => tab === "Closed Positions" ? p.state === "closed" : p.state !== "closed");
  const txFor = (p: DetailPosition) => view?.sequences.filter(s => s.positionId === p.positionId).flatMap(s => s.txHashes)[0];
  const lastHarvest = view?.sequences.find(s => s.kind === "harvest" && s.state === "completed");
  const tile = (label: string, metric: DetailMetric, showNote = false, credit?: React.ReactNode) => <MetricTile
    key={label}
    label={label}
    title={metric.value === null ? metric.reason?.replace(/^—\s*/u, "") ?? "source unavailable" : metric.note}
    value={metric.value ?? "—"}
    credit={credit}
    note={metric.value === null ? undefined : showNote ? metric.note : undefined} />;
  const columns = tab === "Closed Positions" ? "1.3fr 1fr 1.2fr 1fr 1fr auto" : "minmax(240px,1.5fr) 0.8fr minmax(210px,1.5fr) 0.7fr 0.7fr 0.8fr 100px 130px";
  const txLink = (tx: string | undefined) => tx ? <a href={`https://bscscan.com/tx/${tx}`} target="_blank" rel="noreferrer" className="fl-btn fl-btn--ghost fl-btn--sm" style={{ gap: 5, textDecoration: "none" }}>Tx <Icon name="external" size={12} /></a> : null;
  return <div className="fl-shell fl-hired-agent-page">

    <Button variant="ghost" size="sm" onClick={() => props.go("/account")}>My agents</Button>

    <div
      className="fl-hired-hero"
      style={{ display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap", margin: "16px 0 24px" }}>

      <div style={{ display: "flex", gap: 16 }}>
        <span className="fl-card__glyph" style={{ width: 44, height: 44, color: cat.color, background: cat.tint }}>
          <Icon name={cat.icon} size={22} />
        </span>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ font: "var(--type-page-title)" }}>
              {view?.id ?? props.agentId}
            </h1>
            <StatusBadge
              pill
              status={view?.status === "armed" ? "live" : "paused"}
              label={view?.status ?? "state unavailable"} />
          </div>

          {props.message ? <p role="status">
            {props.message}
          </p> : null}
          {props.removeCallsId ? <p>Relay call {short(props.removeCallsId)} {txLink(props.removeTransactionHash)}</p> : null}

          {props.identityStatus}

        </div>
      </div>

      <div className="fl-hired-actions" style={{ display: "flex", gap: 8, alignItems: "start" }}>

        {props.signedOut ? <Button onClick={() => void detail.signIn()}>Sign in to view</Button> : null}

        <Button variant="secondary" disabled title={LP_EDIT_TITLE}>Edit</Button>

        <Button
          variant="secondary"
          disabled={props.actionsDisabled || !["armed", "paused"].includes(view?.status ?? "")}
          onClick={props.onTogglePause}>
          {view?.status === "paused" ? "Resume" : "Pause"}
        </Button>

        {view?.provisioning ? <HireRecoveryActions
          agentId={props.agentId}
          readHeaders={detail.readHeaders}
          go={props.go}
          storageKey="4lpha:lp-hire:v1"
          deployPath="/deploy/lp" /> : <Button
            variant="secondary"
            disabled={props.removeDisabled}
            title={props.removeTitle}
            onClick={props.onRemove}>
          {props.removeLabel}
        </Button>}

        {props.showResolve ? <Button onClick={props.onResolve}>Resolve</Button> : null}
        {props.showAbandon ? <Button onClick={props.onAbandon}>Abandon</Button> : null}

      </div>

    </div>

    <div
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 12, marginBottom: 24 }}>

      <MetricTile
        label={<span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>Delegated <SegmentedToggle options={["USD", "BNB"]} value={unit} onChange={setUnit} /></span>}
        title={limit.value === null ? limit.reason?.replace(/^—s*/u, "") ?? "source unavailable" : undefined}
        value={delegated} />

      {tile("Execution model", lp?.model ? { value: sigma ? "Sigma" : "Custom", reason: null, note: lp.settings?.brain ? "LLM model: " + (TRADE_LLM_MODELS.find(model => model.id === lp.settings?.brain?.primaryModel)?.label ?? lp.settings.brain.primaryModel).replace(/^Auto:\s*/u, "") : undefined } : unavailable(lp?.reason ?? "execution model unavailable"), true, lp?.model ? <ZeroGCredit /> : undefined)}

      <MetricTile label="PnL since hire" value={pnl.value ?? "—"} tone={pnlTone}
        delta={pnl.value === null ? undefined : pnl.note} deltaTone={pnlTone}
        title={pnl.value === null ? pnl.reason ?? undefined : undefined} />

      <MetricTile label="Fees earned" value={earnedFees.value ?? "—"}
        note={earnedFees.value === null ? undefined : earnedFees.tokenBreakdown}
        title={earnedFees.note ?? earnedFees.reason ?? undefined} />

      {sigma ? tile("Open positions", { value: view ? `${positions.filter(p => p.state !== "closed").length} / 1` : null, reason: view ? null : "positions unavailable" }) : <MetricTile
        key="Dust"
        label={<span style={{ display: "flex", alignItems: "center", gap: 6 }}>Dust <InfoHint text={DUST_EXPLAINER} /></span>}
        title={dust.value === null ? dust.reason ?? "source unavailable" : dust.note}
        value={<span style={{ font: "var(--weight-medium) var(--text-lg)/1.3 var(--font-mono)", overflowWrap: "anywhere" }}>{dust.value ?? "—"}</span>}
        note={dust.value === null ? undefined : dust.note} />}

    </div>

    <div style={{ marginBottom: 16 }}>
      <SegmentedToggle
        options={["Overview", ...(sigma ? ["Closed Positions"] : []), "Run log"]}
        value={tab}
        onChange={setTab} />
    </div>

    {tab === "Run log" ? <Panel>
      {/* Bounded height: a busy agent logs a sequence per worker cycle, and an
          unbounded list turned the page into an endless footer (2026-09-06). */}
      <div data-testid="lp-run-log" style={{ padding: 16, maxHeight: 520, overflowY: "auto" }}>
        {view?.sequences.length ? view.sequences.map(s => {
          const debuggable = s.state === "rolled-back" || s.state === "held" || s.outcomeUnavailable || (s.stallCode ?? null) !== null;
          const open = expanded === `log:${s.sequenceId}`;
          return <div key={s.sequenceId} style={{ padding: "12px 0", borderBottom: "1px solid var(--line-1)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <strong>
                {s.kind === "open" && s.state === "completed" && s.positionId === lp?.latestPositionId ? "Agent armed" : lpSequenceLabel(s)}
              </strong>
              <small>· {relativeTime(s.updatedAt, now).text}</small>
              {debuggable ? <Button size="sm" variant="ghost" data-testid={`lp-run-log-expand-${s.sequenceId}`} onClick={() => setExpanded(open ? null : `log:${s.sequenceId}`)}>{open ? "Hide details" : "Details"}</Button> : null}
            </div>
            <div>
              {s.note}
            </div>
            {s.txHashes.map(tx => <React.Fragment key={tx}>
              {txLink(tx)}
            </React.Fragment>)}
            {s.outcomeUnavailable ? <MetricCell metric={unavailable("journal outcome unavailable")} /> : null}
            {open ? <pre data-testid={`lp-run-log-details-${s.sequenceId}`} style={{ margin: "8px 0 0", padding: 10, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", font: "var(--weight-regular) var(--text-xs)/1.5 var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {[
                `sequence  ${s.sequenceId}`,
                `kind      ${s.kind}  state ${s.state}  recovery ${s.recoveryState}`,
                `stall     ${s.stallCode ?? "none"}${(s.stallCount ?? 0) > 0 ? ` ×${s.stallCount}` : ""}`,
                `created   ${s.createdAt === null ? "—" : new Date(s.createdAt).toISOString()}`,
                `updated   ${new Date(s.updatedAt).toISOString()}`,
                s.steps.length === 0
                  ? "steps     none recorded — the step was refused at build time (nothing was submitted); the reason is in the worker log"
                  : ["steps", ...s.steps.map(st => `  #${st.index} ${st.kind}  ${st.state ?? "no journal row"}${st.txHash ? `  tx ${st.txHash}` : ""}\n     ${st.decisionId}`)].join("\n"),
              ].join("\n")}
            </pre> : null}
          </div>;
        }) : <MetricCell metric={unavailable("no recorded activity")} />}
      </div>
    </Panel> : <Panel>

      <header
        style={{ display: "flex", justifyContent: "space-between", padding: 16, borderBottom: "1px solid var(--line-1)" }}>
        <span>
          {tab === "Closed Positions" ? "Closed Positions" : "Positions"}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void detail.refresh()}>Refresh</Button>
      </header>

      <div role="table" style={{ minWidth: 1020 }}>
        <div role="row" className="fl-row__head" style={{ gridTemplateColumns: columns }}>
          {(tab === "Closed Positions" ? ["Position", "Closed", "Last sequence", "Value", "Fees earned", "Tx"] : ["Position", "Value", "Liquidity", "Fee APR", "Farm APR", "Fees earned", "Range", "Actions"]).map(h => <span role="columnheader" key={h} style={{ textAlign: h === "Range" ? "center" : h === "Actions" ? "right" : "left" }}>
            {h}
          </span>)}
        </div>
        <div role="rowgroup">

          {rows.length === 0 ? <div role="row">
            <div role="cell" style={{ padding: 24 }}>
              <MetricCell
                metric={unavailable(view ? tab === "Closed Positions" ? "no closed positions" : "no open positions" : "positions unavailable")} />
            </div>
          </div> : rows.map(p => {
            const tx = txFor(p), last = view?.sequences.find(s => s.positionId === p.positionId), blocking = view?.sequences.some(s => s.positionId === p.positionId && !isTerminalSequence(s));
            const read = liveReadFor({ tokenId: p.tokenId, chainReads: props.chainReads, discovered });
            // The NFT's own bounds against the pool's own tick: no worker cycle
            // stands between a price move and this badge.
            const inside = liveInRange(read, lp?.currentTick ?? null)
              ?? (live && lp?.liveRange && lp.currentTick !== null ? lp.currentTick >= lp.liveRange.tickLower && lp.currentTick < lp.liveRange.tickUpper : null);
            const rowValue = liveValueMetric(read, pricing);
            const rowFees = read?.position.tokenId === accounting?.position.tokenId ? liveFees : unavailable("full collectible fees unavailable");
            const shownTokenId = read?.discovered === true ? read.position.tokenId.toString(10) : p.tokenId;
            const chartRange = read !== undefined && read.position.liquidity > 0n
              ? { tickLower: read.position.tickLower, tickUpper: read.position.tickUpper, fromChain: true }
              : range === null ? null : { tickLower: range.tickLower, tickUpper: range.tickUpper, fromChain: false };
            const chartLive = chartRange?.fromChain === true || live;
            return <React.Fragment key={p.positionId}>
              <div role="row" className="fl-row" style={{ gridTemplateColumns: columns, alignItems: "center" }}>

                <div role="cell">
                  {p.state === "closed" && p.token0 && p.token1 && (p.token0 !== pool?.token0 || p.token1 !== pool?.token1) ? <div>
                    {p.pair}
                  </div> : pool ? <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <PairIcons token0={{ src: icons[pool.token0] ?? null, symbol: pool.symbol0 }} token1={{ src: icons[pool.token1] ?? null, symbol: pool.symbol1 }} />
                      <strong>{pool.base ?? "?"}/{pool.quote ?? "?"}</strong>
                      {p.state !== "closed" ? <StatusBadge pill title={lp?.currentTickReason ?? undefined}
                        status={inside === true ? "live" : inside === false ? "warning" : "paused"}
                        label={inside === true ? "In range" : inside === false ? "Out of range" : shownTokenId === null ? "Loading…" : "Last observed"} /> : null}
                    </div>
                    <small style={{ color: "var(--text-subtle)" }}>{shownTokenId !== null ? <a className="fl-lp-nft-link" title={p.tokenId === null ? "On chain, not yet recorded by the agent" : undefined} href={`https://pancakeswap.finance/liquidity/${shownTokenId}`} target="_blank" rel="noreferrer">#{shownTokenId}{p.tokenId === null ? "*" : ""}</a> : "—"} · V3 · {pool.fee / 10000}%</small>
                  </> : <MetricCell metric={unavailable(lp?.reason ?? "pool not recorded")} />}
                </div>

                {tab === "Closed Positions" ? <>
                  <div role="cell">
                    {p.updatedAt ? relativeTime(p.updatedAt, now).text : <MetricCell metric={unavailable("close time unavailable")} />}
                  </div>
                  <div role="cell">
                    {last ? `${last.kind} · ${last.state}` : <MetricCell metric={unavailable("sequence unavailable")} />}
                  </div>
                  <div role="cell">
                    <MetricCell money metric={unavailable("final valuation not recorded")} />
                  </div>
                  <div role="cell">
                    <MetricCell money metric={unavailable("final valuation not recorded")} />
                  </div>
                  <div role="cell">
                    {txLink(tx) ?? <MetricCell metric={unavailable("no confirmed transaction")} />}
                  </div>
                </> : <>

                  <div role="cell">
                    <MetricCell money metric={rowValue.value === null ? usdMetric(p.value) : rowValue} />
                  </div>
                  <div role="cell">
                    <MetricCell showNote metric={liquidityMetric(read?.position ?? (p.tokenId ? props.chainReads.get(p.tokenId) : undefined), pool)} />
                  </div>
                  <div role="cell">
                    <MetricCell metric={aprMetric} />
                  </div>
                  <div role="cell">
                    <MetricCell metric={farmMetric} />
                  </div>
                  <div role="cell">
                    <MetricCell money metric={p.fees.value !== null ? p.fees : rowFees} />

                  </div>

                  <div role="cell" style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
                    <Button variant="ghost" size="sm" className="fl-lp-range-toggle"
                      title={expanded === p.positionId ? "Hide liquidity chart" : "View liquidity chart"}
                      aria-expanded={expanded === p.positionId}
                      aria-label="Range"
                      aria-pressed={expanded === p.positionId}
                      onClick={() => setExpanded(expanded === p.positionId ? null : p.positionId)}>
                      <Icon name={cat.icon} size={24} />
                      <span>{expanded === p.positionId ? "Hide chart" : "View chart"}</span>
                    </Button>
                  </div>

                  <div role="cell" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy || props.actionsDisabled || props.removeCallsId !== undefined || blocking || !["armed", "paused"].includes(view?.status ?? "")}
                      title="Attempts to convert the freed token to the quote asset; assets remain in the agent wallet."
                      onClick={() => props.onWithdraw(p.positionId)}>Withdraw</Button>
                    {txLink(tx)}
                  </div>

                </>}

              </div>
              {expanded === p.positionId && tab === "Overview" ? <div style={{ padding: 16, borderTop: "1px solid var(--line-1)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                  <span>
                    {chartLive ? "Current range" : "Opening reference"}
                  </span>
                </div>

                <LiquidityChart
                  showSnapshot={false}
                  poolAddress={pool?.poolAddress ?? ""}
                  geometry={geometry}
                  range={chartRange ? { mode: chartLive ? "live" : "reference", tickLower: chartRange.tickLower, tickUpper: chartRange.tickUpper } : { mode: "unavailable", reason: lp?.liveRangeReason ?? "range unavailable" }}
                  legend={{ range: chartLive ? "position range" : "opening reference" }}
                    onFlipUnits={() => setInvert(value => !value)} />

                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 12 }}>
                  {geometry && chartRange ? (() => { const o = displayOrientation(geometry), a = priceFromTick(chartRange.tickLower, o), b = priceFromTick(chartRange.tickUpper, o); return <span>MIN {formatPrice(Math.min(a, b))} · MAX {formatPrice(Math.max(a, b))} {o.quoteSymbol}/{o.baseSymbol}</span>; })() : <MetricCell metric={unavailable("range geometry unavailable")} />}
                  <span>
                    {lp?.settings ? lp.settings.rotateMode === "swapless" ? "Wait for re-entry" : "Both ways" : "— rotation settings unavailable"}
                  </span>
                  <span>
                    {lastHarvest ? `Last compound · ${relativeTime(lastHarvest.updatedAt, now).text}` : "— no completed compound"}
                  </span>
                </div>

                <LpRangeEvents
                  live={chartLive}
                  lp={chartRange?.fromChain === true && lp !== null
                    ? { ...lp, liveRange: { tickLower: chartRange.tickLower, tickUpper: chartRange.tickUpper, asOfMs: read!.position.readAtMs } }
                    : lp}
                  geometry={geometry}
                  positionId={p.positionId}
                  sequences={view?.sequences ?? []}
                  status={view?.status}
                  now={now} />

              </div> : null}
            </React.Fragment>;
          })}

        </div>
      </div>

    </Panel>}

    {lp?.restart ? <p style={{ color: "var(--text-subtle)", marginTop: 16 }}>
      {lp.restart}
    </p> : null}

  </div>;
}

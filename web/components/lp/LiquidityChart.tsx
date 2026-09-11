"use client";
import React from "react";
import { formatPrice, priceFromTick } from "@/lib/lp/range";
export type LiquidityGeometry = {
  spacing: number; currentTick: number; currentTickAsOfMs: number;
  orientation: { quoteIsToken0: boolean; decimals0: number; decimals1: number; symbol0: string; symbol1: string };
  display: { invert: boolean };
};
/** A grid rung painted over the profile: a bid holds quote below the price, an ask holds base above it. */
export type LiquidityRung = { tickLower: number; tickUpper: number; tone: "bid" | "ask" };
export type LiquidityChartProps = {
  showSnapshot?: boolean;
  poolAddress: string; geometry: LiquidityGeometry | null;
  range:
    | { mode: "live" | "reference"; tickLower: number; tickUpper: number }
    | { mode: "unavailable"; reason: string }
    /** GRID-DETAIL-ORIENTATION-HOTFIX — a grid's signed rungs (two, or four for a dual level), each in its own tone. */
    | { mode: "rungs"; rungs: readonly LiquidityRung[] };
  legend: { range: string } | { bid: string; ask: string };
  /** Present only where a unit flip is offered; the deploy form passes none. */
  onFlipUnits?: () => void;
};
const RUNG_TONE = { bid: "var(--cat-grid)", ask: "var(--warn)" } as const;
function toneColor(tone: "range" | "bid" | "ask"): string {
  return tone === "range" ? "var(--cat-lp)" : RUNG_TONE[tone];
}
export function displayOrientation(g: LiquidityGeometry) {
  const quoteIsToken0 = g.orientation.quoteIsToken0 !== g.display.invert;
  return { quoteIsToken0, decimals0: g.orientation.decimals0, decimals1: g.orientation.decimals1,
    quoteSymbol: quoteIsToken0 ? g.orientation.symbol0 : g.orientation.symbol1,
    baseSymbol: quoteIsToken0 ? g.orientation.symbol1 : g.orientation.symbol0 };
}
type ChartState = { readAtMs?: number; pool: string; window: number; bins: { tickLower: number; liquidity: number }[]; currentTick: number | null; blockNumber: string | null; truncated: boolean; error: string | null };
const LIQUIDITY_ZOOM_LEVELS = [30, 60, 120, 250, 500, 1000];
/** How often the live profile is re-read while the form is open. */
const LIQUIDITY_REFRESH_MS = 30_000;
/** More bins than this are grouped so every bar keeps a visible width. */
const LIQUIDITY_MAX_BARS = 240;

/**
 * The zoom level that shows the owner's whole range with ~30 % of air on the
 * wider side, so the default view frames the band instead of a slice of it.
 */
function liquidityAutoZoom(spacing: number, currentTick: number, lo: number | null, hi: number | null) {
  if (lo === null || hi === null) return 1;
  const needBins = Math.ceil((Math.max(currentTick - lo, hi - currentTick) * 1.3) / spacing);
  const index = LIQUIDITY_ZOOM_LEVELS.findIndex((level) => level >= needBins);
  return index === -1 ? LIQUIDITY_ZOOM_LEVELS.length - 1 : index;
}

/**
 * The pool's LIVE liquidity profile — one bar per tick spacing (grouped when
 * zoomed far out), read from the execution plane's finalized-block reader
 * (`/api/pool-liquidity`), refreshed every 30 s, with the owner's typed range
 * painted over it. Bars inside [min, max) are the position's bins; the bin
 * holding the live tick is the market marker. −/+ zoom out/in by changing the
 * window the plane is asked for. Nothing here is a decision input: the plane
 * re-derives and re-checks the signed ticks itself.
 *
 * Honesty rules: a fetch failure shows its reason, never an empty profile that
 * would read as "no liquidity"; a truncated read says so; a profile for a
 * previous pool is dropped the moment the pool changes.
 */
export function LiquidityChart({ poolAddress, geometry: input, range, legend, showSnapshot = true, onFlipUnits }: LiquidityChartProps) {
  const geometry = input === null ? null : { ...input, display: displayOrientation(input) };
  // The painted span: one range, or the outer envelope of every rung so the
  // auto-zoom frames the whole grid.
  const rungs: readonly LiquidityRung[] = range.mode === "rungs" ? range.rungs : [];
  const lo = range.mode === "unavailable" ? null : range.mode === "rungs" ? (rungs.length === 0 ? null : Math.min(...rungs.map((r) => r.tickLower))) : range.tickLower;
  const hi = range.mode === "unavailable" ? null : range.mode === "rungs" ? (rungs.length === 0 ? null : Math.max(...rungs.map((r) => r.tickUpper))) : range.tickUpper;
  const [zoom, setZoom] = React.useState({ pool: "", index: 1 });
  const zoomIndex = zoom.pool === poolAddress
    ? zoom.index
    : (geometry ? liquidityAutoZoom(geometry.spacing, geometry.currentTick, lo, hi) : 1);
  const windowBins = LIQUIDITY_ZOOM_LEVELS[zoomIndex] ?? 60;
  const [state, setState] = React.useState<ChartState>({ pool: "", window: 0, bins: [], currentTick: null, blockNumber: null, truncated: false, error: null });
  const [hover, setHover] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (poolAddress === "") { setState({ pool: "", window: 0, bins: [], currentTick: null, blockNumber: null, truncated: false, error: null }); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const response = await fetch(`/api/pool-liquidity?address=${poolAddress}&window=${windowBins}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({})) as { data?: { bins: { tickLower: number; liquidity: string }[]; currentTick: number; blockNumber: string; truncated?: boolean }; error?: { message?: string; code?: string } };
        if (cancelled) return;
        if (!response.ok || payload.data === undefined) {
          setState({ pool: poolAddress, window: windowBins, bins: [], currentTick: null, blockNumber: null, truncated: false, error: payload.error?.message ?? payload.error?.code ?? "The pool's liquidity profile is unavailable." });
          return;
        }
        // Normalize against the BIGINT peak before any lossy conversion, so a
        // pool whose liquidity is tiny in absolute terms still draws a profile
        // (review finding 3): `liquidity` here is a 0..1 share of the peak.
        const raw = payload.data.bins.map((b) => ({ tickLower: Number(b.tickLower), liquidity: BigInt(b.liquidity) }));
        const peakLiquidity = raw.reduce((m, b) => (b.liquidity > m ? b.liquidity : m), 0n);
        setState({
          readAtMs: Date.now(),
          pool: poolAddress,
          window: windowBins,
          bins: raw.map((b) => ({ tickLower: b.tickLower, liquidity: peakLiquidity === 0n ? 0 : Number((b.liquidity * 1_000_000n) / peakLiquidity) / 1_000_000 })),
          currentTick: Number(payload.data.currentTick),
          blockNumber: String(payload.data.blockNumber),
          truncated: payload.data.truncated === true,
          error: null,
        });
      } catch {
        if (!cancelled) setState({ pool: poolAddress, window: windowBins, bins: [], currentTick: null, blockNumber: null, truncated: false, error: "The pool's liquidity profile is unavailable." });
      } finally {
        if (!cancelled) timer = setTimeout(load, LIQUIDITY_REFRESH_MS);
      }
    };
    void load();
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
  }, [poolAddress, windowBins]);

  const fresh = state.pool === poolAddress && state.window === windowBins;
  const current = fresh && geometry ? state : { readAtMs: undefined, bins: [], currentTick: null, blockNumber: null, truncated: false, error: state.pool === poolAddress && state.window === windowBins ? state.error : null };
  const spacing = geometry ? geometry.spacing : 1;
  const activeBin = current.currentTick === null ? null : Math.floor(current.currentTick / spacing) * spacing;
  // Group adjacent bins when zoomed far out so each bar keeps a visible width.
  const groupSize = current.bins.length > LIQUIDITY_MAX_BARS ? Math.ceil(current.bins.length / LIQUIDITY_MAX_BARS) : 1;
  const bars = [];
  for (let i = 0; i < current.bins.length; i += groupSize) {
    const group = current.bins.slice(i, i + groupSize);
    const first = group[0].tickLower;
    const last = group[group.length - 1].tickLower + spacing;
    // A grouped bar is "in range" only when EVERY bin it covers is signed;
    // a bar that merely straddles a signed boundary is marked partial and
    // drawn in between, so the highlight never overstates the signed range.
    // In rungs mode the same rule runs per rung, and the bar takes that rung's tone.
    const spans: readonly { lo: number; hi: number; tone: "range" | "bid" | "ask" }[] = range.mode === "rungs"
      ? rungs.map((r) => ({ lo: r.tickLower, hi: r.tickUpper, tone: r.tone }))
      : range.mode === "live" && lo !== null && hi !== null ? [{ lo, hi, tone: "range" }] : [];
    const inside = spans.find((s) => first >= s.lo && last <= s.hi);
    const straddled = inside === undefined ? spans.find((s) => first < s.hi && last > s.lo) : undefined;
    bars.push({
      tickLower: first,
      tickUpper: last,
      liquidity: group.reduce((m, b) => Math.max(m, b.liquidity), 0),
      inRange: inside !== undefined,
      partial: straddled !== undefined,
      tone: (inside ?? straddled)?.tone ?? "range",
      isMarket: activeBin !== null && activeBin >= first && activeBin < last,
    });
  }
  // The axis is PRICE, left = min, right = max. Ticks rise with token1-per-token0,
  // so when the displayed quote is token0 (USDT/WBNB: USDT per WBNB) a higher
  // tick is a LOWER price and the tick-ascending bins must be drawn reversed
  // (operator hotfix 2026-09-06).
  if (geometry?.display.quoteIsToken0) bars.reverse();
  const hovered = hover !== null ? bars[hover] : null;
  const canZoomIn = zoomIndex > 0;
  const canZoomOut = zoomIndex < LIQUIDITY_ZOOM_LEVELS.length - 1;
  const setZoomIndex = (index: number) => setZoom({ pool: poolAddress, index: Math.max(0, Math.min(LIQUIDITY_ZOOM_LEVELS.length - 1, index)) });
  const zoomBtn = (enabled: boolean): React.CSSProperties => ({ cursor: enabled ? "pointer" : "default", width: 26, height: 22, borderRadius: 6, border: "1px solid var(--line-1)", background: "transparent", color: enabled ? "var(--ink-1)" : "var(--text-subtle)", opacity: enabled ? 1 : 0.4, font: "var(--weight-medium) var(--text-sm)/1 var(--font-mono)", display: "grid", placeItems: "center" });

  return (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", padding: 16, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", font: "var(--weight-medium) var(--text-xs)/1.2 var(--font-mono)", color: "var(--text-subtle)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span>LIQUIDITY BY TICK</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }} data-testid="lp-liquidity-zoom" data-window={windowBins}>
            <button type="button" aria-label="Zoom out liquidity" disabled={!canZoomOut || !geometry} onClick={() => setZoomIndex(zoomIndex + 1)} style={zoomBtn(canZoomOut && !!geometry)}>−</button>

            <button type="button" aria-label="Zoom in liquidity" disabled={!canZoomIn || !geometry} onClick={() => setZoomIndex(zoomIndex - 1)} style={zoomBtn(canZoomIn && !!geometry)}>+</button>
          </span>
          {onFlipUnits === undefined || geometry === null ? null : <button
            type="button"
            onClick={onFlipUnits}
            title="Show prices the other way round"
            aria-label={`Show prices in ${geometry.display.baseSymbol} per ${geometry.display.quoteSymbol}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 8px", borderRadius: 6,
              border: "1px solid var(--line-1)", background: "transparent", color: "var(--text-subtle)", cursor: "pointer",
              font: "var(--weight-medium) var(--text-xs)/1 var(--font-mono)", letterSpacing: "0.02em"
            }}>{geometry.display.quoteSymbol} per {geometry.display.baseSymbol} ⇄</button>}
        </span>
        <span>
          {!geometry ? poolAddress ? "Price geometry unavailable" : "Select a pool" : current.error ? current.error : current.blockNumber === null ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span className="fl-spin" aria-hidden="true" data-testid="lp-liquidity-spinner" />Reading the pool…</span> : `${range.mode === "live" || range.mode === "rungs" ? "live" : "pool snapshot"}${current.truncated ? " · edges truncated" : ""} · refreshes every 30 s`}
        </span>
      </div>
      {showSnapshot && current.blockNumber !== null ? <small style={{color:"var(--text-subtle)"}}>Pool snapshot · block {current.blockNumber} · read {current.readAtMs === undefined ? "time unavailable" : new Date(current.readAtMs).toLocaleTimeString()}</small> : null}
      <div data-testid="lp-liquidity-legend" data-block={current.blockNumber ?? ""} data-lower={lo ?? ""} data-upper={hi ?? ""} style={{ display: "flex", gap: 14, flexWrap: "wrap", font: "var(--weight-regular) var(--text-xs)/1.2 var(--font-mono)", color: "var(--text-subtle)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "#f7931a", display: "inline-block" }} />
          current price{geometry && current.currentTick !== null ? ` · ${formatPrice(priceFromTick(current.currentTick, geometry.display))} ${geometry.display.quoteSymbol}` : ""}</span>
        {"range" in legend
          ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "var(--cat-lp)", display: "inline-block" }} />{legend.range}</span>
          : <>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: RUNG_TONE.bid, display: "inline-block" }} />{legend.bid}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: RUNG_TONE.ask, display: "inline-block" }} />{legend.ask}</span>
          </>}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: "var(--line-1)", display: "inline-block" }} />other liquidity</span>
      </div>
      {range.mode === "unavailable" ? <span>{range.reason}</span> : null}
      <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 2, height: 72 }}>
        {range.mode === "reference" && lo !== null && hi !== null && bars.length > 0 ? <div data-testid="lp-reference-range" style={{ position: "absolute", pointerEvents: "none", height: "100%", border: "1px dashed var(--cat-lp)", left: `${Math.max(0, Math.min(100, (lo - bars[0].tickLower) / (bars[bars.length - 1].tickUpper - bars[0].tickLower) * 100))}%`, right: `${100 - Math.max(0, Math.min(100, (hi - bars[0].tickLower) / (bars[bars.length - 1].tickUpper - bars[0].tickLower) * 100))}%` }} /> : null}
        {hovered && geometry ? (
          <div style={{ position: "absolute", left: `${((hover ?? 0) / Math.max(1, bars.length - 1)) * 100}%`, top: 0, transform: "translate(-50%, -100%)", background: "var(--surface-card)", border: "1px solid var(--cat-lp)", borderRadius: "var(--radius-sm)", padding: "8px 12px", display: "grid", gap: 3, whiteSpace: "nowrap", zIndex: 2 }}>
            <span style={{ font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)", color: "var(--ink-1)" }}>TICK&nbsp;&nbsp;{hovered.tickLower} … {hovered.tickUpper}</span>
            <span style={{ font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)", color: "var(--ink-1)" }}>PRICE&nbsp;{formatPrice(Math.min(priceFromTick(hovered.tickLower, geometry.display), priceFromTick(hovered.tickUpper, geometry.display)))} … {formatPrice(Math.max(priceFromTick(hovered.tickLower, geometry.display), priceFromTick(hovered.tickUpper, geometry.display)))} {geometry.display.quoteSymbol}</span>
            <span style={{ font: "var(--weight-medium) var(--text-xs)/1.4 var(--font-mono)", color: "var(--text-subtle)" }}>LIQUIDITY&nbsp;{`${(hovered.liquidity * 100).toFixed(0)}% of peak`}</span>
          </div>
        ) : null}
        {bars.length === 0 ? (
          <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", font: "var(--weight-regular) var(--text-xs)/1.3 var(--font-sans)", color: "var(--text-subtle)" }}>
            {geometry && !current.error && current.blockNumber === null ? <span className="fl-spin" aria-hidden="true" /> : "—"}
          </div>
        ) : bars.map((b, i) => {
          const heightPct = Math.max(3, b.liquidity * 100);
          return (
            <div key={b.tickLower} data-tick={b.tickLower} data-tick-upper={b.tickUpper} data-in-range={b.inRange ? "true" : "false"} data-partial={b.partial ? "true" : "false"} data-tone={b.inRange || b.partial ? b.tone : ""} data-market={b.isMarket ? "true" : "false"}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ flex: 1, height: `${heightPct}%`, background: b.isMarket ? "#f7931a" : b.inRange ? toneColor(b.tone) : b.partial ? (b.tone === "range" ? "var(--cat-lp-tint, var(--line-1))" : toneColor(b.tone)) : "var(--line-1)", opacity: b.inRange || b.isMarket ? 1 : b.partial ? (b.tone === "range" ? 0.85 : 0.45) : 0.7, outline: hover === i ? "2px solid #4ade80" : "none", outlineOffset: 1, borderRadius: 1, cursor: "pointer", transition: "background 120ms" }} />
          );
        })}
      </div>
    </div>
  );
}

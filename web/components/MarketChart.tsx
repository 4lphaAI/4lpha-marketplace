"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
  type IPriceLine,
  LineStyle,
} from "lightweight-charts";
import {
  TIMEFRAMES,
  parseMarketDataResponse,
  toChartSeriesData,
  type Candle,
  type MarketDataMeta,
  type MarketResourceKind,
  type Timeframe,
} from "@/lib/market-data";

export interface MarketChartPriceLine {
  readonly price: number;
  readonly color: string;
  readonly title: string;
}

export interface MarketChartMarker {
  readonly timestamp: number;
  readonly side: "buy" | "sell";
}

interface MarketChartProps {
  kind: MarketResourceKind;
  address: string;
  title: string;
  candles?: readonly Candle[];
  markers?: readonly MarketChartMarker[];
  priceLines?: readonly MarketChartPriceLine[];
  embedded?: boolean;
  height?: number;
}

// Lightweight Charts paints on a canvas and parses colours itself, so it understands
// neither a CSS custom property nor a modern colour space: our design tokens resolve to
// lab(), and either form throws "Failed to parse color" from inside the chart's size pass,
// which aborts the whole draw pipeline and leaves every canvas blank at its default size.
// Callers keep passing design tokens; this resolves the variable against the live element
// and then rasterises one pixel so the browser's own colour engine hands back plain sRGB.
function resolveColor(container: HTMLElement, color: string): string {
  const variable = /^var(s*(--[w-]+)s*)$/u.exec(color.trim());
  const value = variable === null
    ? color
    : getComputedStyle(container).getPropertyValue(variable[1] ?? "").trim();
  if (value === "") return color;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return value;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (red === undefined || green === undefined || blue === undefined || alpha === undefined) return value;
  return alpha === 255 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function measureWidth(container: HTMLDivElement): number {
  const width = container.clientWidth || Math.floor(container.getBoundingClientRect().width);
  return width > 0 ? width : 600;
}

export function MarketChart({ kind, address, title, candles: suppliedCandles, markers = [], priceLines = [], embedded = false, height = 470 }: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markerSeriesRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [interval, setInterval] = useState<Timeframe>("1m");
  const [loadedCandles, setLoadedCandles] = useState<Candle[]>([]);
  const [meta, setMeta] = useState<MarketDataMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const candles = suppliedCandles ?? loadedCandles;

  useEffect(() => {
    if (suppliedCandles !== undefined) return;
    const timer = window.setInterval(() => setRefreshVersion((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [suppliedCandles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: measureWidth(container),
      height,
      layout: {
        background: { type: ColorType.Solid, color: embedded ? "transparent" : "#0b0d12" },
        textColor: "#7f8796",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.035)" },
        horzLines: { color: "rgba(255, 255, 255, 0.035)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255, 255, 255, 0.22)", labelBackgroundColor: "#202630" },
        horzLine: { color: "rgba(255, 255, 255, 0.22)", labelBackgroundColor: "#202630" },
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.08)",
        scaleMargins: { top: 0.08, bottom: 0.28 },
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.08)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#2cd391",
      downColor: "#ff5978",
      wickUpColor: "#2cd391",
      wickDownColor: "#ff5978",
      borderVisible: false,
      priceLineColor: "rgba(255, 255, 255, 0.30)",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markerSeriesRef.current = createSeriesMarkers(candleSeries);

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      if (width <= 0) return;
      chart.applyOptions({ width });
      // Bar spacing is computed against the width the chart was fitted at. A panel that
      // mounts hidden (or before layout) fits at a near-zero width and then keeps that
      // spacing when it widens, which draws every bar into a sliver at the right edge.
      chart.timeScale().fitContent();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markerSeriesRef.current = null;
    };
  }, [embedded, height]);

  useEffect(() => {
    if (suppliedCandles !== undefined) {
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const query = new URLSearchParams({ kind, address, interval, limit: "300" });
    void fetch(`/api/market-data/ohlcv?${query.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as unknown;
        if (!response.ok) throw new Error("Candles are temporarily unavailable.");
        return parseMarketDataResponse(payload);
      })
      .then((result) => {
        setLoadedCandles(result.candles);
        setMeta(result.meta);
        if (result.candles.length === 0) setError("No trades in this timeframe yet.");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Candles are temporarily unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [address, interval, kind, refreshVersion, suppliedCandles]);

  useEffect(() => {
    const series = toChartSeriesData([...candles]);
    // The library's default price format is 2 decimals, which renders every
    // sub-cent asset — a four.meme token quoted in WBNB sits near 0.00003813 —
    // as a column of "0.00". The axis, the crosshair label and the rung lines
    // all read from this one format, so it is set from the DATA rather than
    // guessed: enough decimals to keep four significant digits of the smallest
    // price on screen.
    const precision = pricePrecision([
      ...candles.map((candle) => candle.low),
      ...priceLines.map((line) => line.price),
    ]);
    candleSeriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision, minMove: Number(`1e-${precision}`) },
    });
    candleSeriesRef.current?.setData(series.candles);
    volumeSeriesRef.current?.setData(series.volumes);
    if (series.candles.length > 0) chartRef.current?.timeScale().fitContent();
  }, [candles, priceLines]);

  // The signed rungs, drawn as the design's dashed bid/ask lines. They are
  // recreated on every change because a price line has no update API.
  const lineRefs = useRef<IPriceLine[]>([]);
  useEffect(() => {
    const series = candleSeriesRef.current;
    const container = containerRef.current;
    if (!series || !container) return;
    for (const line of lineRefs.current) series.removePriceLine(line);
    lineRefs.current = priceLines
      .filter((line) => Number.isFinite(line.price) && line.price > 0)
      .map((line) => series.createPriceLine({
        price: line.price,
        color: resolveColor(container, line.color),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: line.title,
      }));
  }, [priceLines, candles]);

  useEffect(() => {
    markerSeriesRef.current?.setMarkers(markers.map((marker) => ({
      time: Math.floor(marker.timestamp / 1_000) as UTCTimestamp,
      position: marker.side === "buy" ? "belowBar" : "aboveBar",
      shape: marker.side === "buy" ? "arrowUp" : "arrowDown",
      color: marker.side === "buy" ? "oklch(0.72 0.09 205)" : "#f0913a",
      text: marker.side === "buy" ? "BUY FILL" : "SELL FILL",
    })));
  }, [markers]);

  const latest = candles.at(-1);
  const first = candles.at(0);
  const change = latest && first && first.open !== 0 ? ((latest.close - first.open) / first.open) * 100 : null;
  const pair = useMemo(() => {
    const base = meta?.base?.symbol;
    const quote = meta?.quote?.symbol;
    return base && quote ? `${base} / ${quote}` : title;
  }, [meta, title]);

  if (embedded) {
    return <div ref={containerRef} style={{ width: "100%", height, display: "block" }} data-testid="candlestick-chart" />;
  }

  return (
    <section className="chart-card" aria-label={`${title} candlestick chart`}>
      <div className="chart-toolbar">
        <div>
          <div className="eyebrow">Live market</div>
          <div className="price-line">
            <h2>{pair}</h2>
            {latest ? <span className="current-price">{formatPrice(latest.close)}</span> : null}
            {change !== null ? (
              <span className={change >= 0 ? "positive" : "negative"}>
                {change >= 0 ? "+" : ""}{change.toFixed(2)}%
              </span>
            ) : null}
          </div>
          <div className="market-meta">
            <span className={`live-dot ${meta?.staleness === "fresh" ? "" : "warning"}`} />
            {meta ? `${meta.source} · ${freshnessLabel(meta.asOf, meta.staleness)}` : "Connecting to data plane"}
          </div>
        </div>

        <div className="timeframes" aria-label="Chart timeframe">
          {TIMEFRAMES.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={interval === value}
              className={interval === value ? "active" : ""}
              onClick={() => setInterval(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="chart-shell">
        <div ref={containerRef} className="chart-canvas" data-testid="candlestick-chart" />
        {loading ? <div className="chart-status"><span className="spinner" />Loading {interval} candles</div> : null}
        {!loading && error ? <div className="chart-status error-state">{error}</div> : null}
      </div>

      <div className="chart-footer">
        <span>Pool {shortAddress(address)}</span>
        <a href="https://www.geckoterminal.com/" target="_blank" rel="noreferrer">
          Market data by GeckoTerminal
        </a>
      </div>
    </section>
  );
}

/**
 * How many decimals the axis needs so the SMALLEST price on the chart still
 * shows four significant digits: 645.12 keeps 2, 0.00003813 gets 8. Capped at
 * 12 (the library's own maximum is 8 places past which it stops formatting
 * cleanly, and beyond 12 the label is unreadable anyway).
 */
export function pricePrecision(values: readonly number[]): number {
  const smallest = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)[0];
  if (smallest === undefined) return 2;
  return Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(smallest))));
}

function formatPrice(value: number): string {
  if (value >= 1_000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return value.toPrecision(5);
}

function freshnessLabel(asOf: number, staleness: MarketDataMeta["staleness"]): string {
  if (staleness !== "fresh") return `${staleness} snapshot`;
  const seconds = Math.max(0, Math.round((Date.now() - asOf) / 1000));
  return seconds < 10 ? "updated now" : `updated ${seconds}s ago`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

import type { CandlestickData, HistogramData, UTCTimestamp } from "lightweight-charts";

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export type MarketResourceKind = "pool" | "token";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenRef {
  address: string | null;
  name: string | null;
  symbol: string | null;
}

export interface MarketDataMeta {
  source: string;
  asOf: number;
  staleness: "fresh" | "stale" | "dead";
  base?: TokenRef | null;
  quote?: TokenRef | null;
}

export interface MarketDataResponse {
  candles: Candle[];
  meta: MarketDataMeta;
}

export interface ChartSeriesData {
  candles: CandlestickData<UTCTimestamp>[];
  volumes: HistogramData<UTCTimestamp>[];
}

/** Narrows the BFF response instead of trusting third-party-shaped JSON in the component. */
export function parseMarketDataResponse(payload: unknown): MarketDataResponse {
  if (!isRecord(payload) || !Array.isArray(payload["data"]) || !isRecord(payload["meta"])) {
    throw new Error("Market data returned an unexpected response.");
  }

  const candles = payload["data"].map(parseCandle).filter((value): value is Candle => value !== null);
  const meta = payload["meta"];
  const source = typeof meta["source"] === "string" ? meta["source"] : "unknown";
  const asOf = finiteNumber(meta["asOf"]) ?? Date.now();
  const rawStaleness = meta["staleness"];
  const staleness = rawStaleness === "stale" || rawStaleness === "dead" ? rawStaleness : "fresh";

  return {
    candles,
    meta: {
      source,
      asOf,
      staleness,
      base: parseTokenRef(meta["base"]),
      quote: parseTokenRef(meta["quote"]),
    },
  };
}

/** Converts epoch milliseconds to Lightweight Charts seconds and removes duplicate bars. */
export function toChartSeriesData(rows: Candle[]): ChartSeriesData {
  const unique = new Map<number, Candle>();
  for (const row of rows) unique.set(row.timestamp, row);
  const ordered = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);

  return {
    candles: ordered.map((row) => ({
      time: Math.floor(row.timestamp / 1000) as UTCTimestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    })),
    volumes: ordered.map((row) => ({
      time: Math.floor(row.timestamp / 1000) as UTCTimestamp,
      value: row.volume,
      color: row.close >= row.open ? "rgba(44, 211, 145, 0.32)" : "rgba(255, 89, 120, 0.30)",
    })),
  };
}

function parseCandle(value: unknown): Candle | null {
  if (!isRecord(value)) return null;
  const timestamp = finiteNumber(value["timestamp"]);
  const open = finiteNumber(value["open"]);
  const high = finiteNumber(value["high"]);
  const low = finiteNumber(value["low"]);
  const close = finiteNumber(value["close"]);
  const volume = finiteNumber(value["volume"]);
  if (
    timestamp === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    timestamp <= 0 ||
    open <= 0 ||
    high < Math.max(open, close, low) ||
    low > Math.min(open, close, high) ||
    close <= 0 ||
    volume < 0
  ) {
    return null;
  }
  return { timestamp, open, high, low, close, volume };
}

function parseTokenRef(value: unknown): TokenRef | null {
  if (!isRecord(value)) return null;
  const address = typeof value["address"] === "string" ? value["address"] : null;
  const name = typeof value["name"] === "string" ? value["name"] : null;
  const symbol = typeof value["symbol"] === "string" ? value["symbol"] : null;
  return address === null && name === null && symbol === null ? null : { address, name, symbol };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { describe, expect, it } from "vitest";
import { parseMarketDataResponse, toChartSeriesData } from "./market-data";

describe("parseMarketDataResponse", () => {
  it("keeps valid bars and discards malformed provider rows", () => {
    const result = parseMarketDataResponse({
      data: [
        { timestamp: 1_700_000_000_000, open: 1, high: 3, low: 0.5, close: 2, volume: 10 },
        { timestamp: 1_700_000_060_000, open: 2, high: 1, low: 0.5, close: 2, volume: 10 },
        { timestamp: "bad", open: 1, high: 2, low: 1, close: 2, volume: 1 },
      ],
      meta: {
        source: "geckoterminal",
        asOf: 1_700_000_070_000,
        staleness: "fresh",
        base: { address: null, name: "Base", symbol: "BASE" },
        quote: { address: null, name: "Quote", symbol: "QUOTE" },
      },
    });

    expect(result.candles).toHaveLength(1);
    expect(result.meta.base?.symbol).toBe("BASE");
    expect(result.meta.quote?.symbol).toBe("QUOTE");
  });

  it("refuses an envelope that is not the data-plane contract", () => {
    expect(() => parseMarketDataResponse({ candles: [] })).toThrow(/unexpected response/i);
  });
});

describe("toChartSeriesData", () => {
  it("sorts, deduplicates and converts milliseconds to UTC seconds", () => {
    const result = toChartSeriesData([
      { timestamp: 1_700_000_060_000, open: 2, high: 3, low: 1, close: 1.5, volume: 20 },
      { timestamp: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { timestamp: 1_700_000_060_000, open: 2, high: 4, low: 1, close: 3, volume: 30 },
    ]);

    expect(result.candles.map((row) => row.time)).toEqual([1_700_000_000, 1_700_000_060]);
    expect(result.candles[1]?.close).toBe(3);
    expect(result.volumes[0]?.color).toContain("44, 211, 145");
  });
});

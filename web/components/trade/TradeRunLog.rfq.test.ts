import { describe, expect, it } from "vitest";
import { routeLine } from "./TradeRunLog";

describe("AGENTIC-RFQ-STOCKS routeLine", () => {
  it("names the RFQ route and keeps the guard and refusal wording", () => {
    expect(routeLine([{ stage: "route", code: "binance-rfq", elapsedMs: 1, token: "0xAA", reason: "premium-ok;exit=123" }])).toBe("Route: Binance aggregator (RFQ)");
    expect(routeLine([
      { stage: "route", code: "binance-refused", elapsedMs: 1, token: "0xAA", reason: "premium" },
      { stage: "route", code: "binance-rfq", elapsedMs: 2, token: "0xAA" },
    ])).toBe("Route: Binance aggregator (RFQ) · aggregator refused: premium");
    expect(routeLine([{ stage: "route", code: "binance-guard", elapsedMs: 1, token: "0xAA" }])).toBe("Route: Binance aggregator through the guard");
    expect(routeLine([{ stage: "route", code: "pancake_v3", elapsedMs: 1, token: "0xAA" }])).toBe("Route: direct AMM (pancake v3)");
  });
});

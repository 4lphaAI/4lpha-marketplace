import { describe, expect, it } from "vitest";
import { farmAprMetric, unavailableApr, validateRangeApr } from "./pool-range";

const request = { address: "0x172fcd41e0913e95784454622d1c3724f546f849", lower: -66348, upper: -66248, capital: 12.77, fee: 100, spacing: 1 };
const answer = (extra: Record<string, unknown> = {}) => ({
  data: {
    pool: request.address, fee: 100, requested: { capitalUsd: 12.77 }, ticks: { lower: -66348, upper: -66248, spacing: 1 },
    estimatedAprPct: 985.17, estimatedApr7dPct: 805.16, concentrationMultiplier: 33.9,
    basis: { lpFeeApr24h: 29.06, lpFeeApr7d: 23.75, tvlUsd: 11_661_897 }, inRange: true, unavailable: [], assumptions: [], ...extra,
  },
  meta: { asOf: 1_000, staleness: "fresh", source: "pancake" },
});

describe("validateRangeApr", () => {
  it("carries the concentration multiplier through", () => {
    expect(validateRangeApr(answer(), request, 1_000).concentrationMultiplier).toBe(33.9);
  });

  it("an absent or zero multiplier is null, and never invalidates the estimate", () => {
    for (const extra of [{ concentrationMultiplier: undefined }, { concentrationMultiplier: 0 }]) {
      const parsed = validateRangeApr(answer(extra), request, 1_000);
      expect(parsed.concentrationMultiplier).toBeNull();
      expect(parsed.estimatedAprPct).toBe(985.17);
    }
  });
});

describe("farmAprMetric", () => {
  it("scales the pool's farm APR to this range, the way PancakeSwap prices a position", () => {
    // 6.54% pool × 33.9x concentration on the live USDT/WBNB 0.01% pool.
    const metric = farmAprMetric({ cakeFarmApr: 6.54, concentrationMultiplier: 33.9, staleness: "fresh", reason: null });
    expect(metric.value).toBe("221.7%");
    expect(metric.note).toContain("pool 6.54% × 33.9x");
    expect(metric.note).toContain("not staked, so not earned");
  });

  it("without a multiplier it says the figure is the pool's, not the position's", () => {
    const metric = farmAprMetric({ cakeFarmApr: 6.54, concentrationMultiplier: null, staleness: "stale", reason: null });
    expect(metric.value).toBe("6.5%");
    expect(metric.note).toContain("pool · full range");
    expect(metric.note).toContain("stale");
  });

  it("no farm figure dashes with its own reason", () => {
    expect(farmAprMetric({ cakeFarmApr: null, concentrationMultiplier: 33.9, staleness: "fresh", reason: "this pool reports no CAKE farm" }))
      .toEqual({ value: null, reason: "this pool reports no CAKE farm" });
  });
});

describe("unavailableApr", () => {
  it("carries no multiplier", () => {
    expect(unavailableApr("http unavailable").concentrationMultiplier).toBeNull();
  });
});

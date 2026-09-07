import { describe, expect, it } from "vitest";
import { DUST_EXPLAINER, dustMetric, type DustRead } from "./dust";

const read: DustRead = { kind: "read", token0Wei: 2_432_100_000_000_000_000n, token1Wei: 8_000_000_000_000_000n, blockNumber: 123n, readAtMs: 1_000 };
// WBNB/USDT: token0 = USDT, token1 = WBNB, both 18 decimals on BSC.
const base = { read, decimals0: 18, decimals1: 18, symbol0: "USDT", symbol1: "WBNB" } as const;

describe("dustMetric", () => {
  it("shows both legs at three decimals and nothing else", () => {
    const metric = dustMetric(base);
    expect(metric).toEqual({ value: "2.432 USDT / 0.008 WBNB", reason: null });
  });

  it("a balance under a thousandth never reads as zero", () => {
    const metric = dustMetric({ ...base, read: { ...read, token0Wei: 400_000_000_000_000n, token1Wei: 0n } });
    expect(metric.value).toBe("<0.001 USDT / 0 WBNB");
  });

  it("an unread wallet, a failed read and missing decimals each dash with their own reason", () => {
    expect(dustMetric({ ...base, read: undefined })).toEqual({ value: null, reason: "agent wallet not read yet" });
    expect(dustMetric({ ...base, read: { kind: "unavailable", reason: "wallet balances not readable" } }))
      .toEqual({ value: null, reason: "wallet balances not readable" });
    expect(dustMetric({ ...base, decimals0: null })).toEqual({ value: null, reason: "token decimals unavailable" });
  });

  it("the explainer says what dust is and that native BNB is excluded", () => {
    expect(DUST_EXPLAINER).toContain("after a rebalance");
    expect(DUST_EXPLAINER).toContain("Native BNB is not counted");
  });
});

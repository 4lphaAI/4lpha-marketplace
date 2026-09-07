import { describe, expect, it } from "vitest";
import { liveFeesMetric, liveInRange, livePnlMetric, liveReadFor, liveValueMetric, type LivePricing } from "./live";
import type { OnChainPosition } from "@/lib/altana/position-reader";

// sqrtPriceX96 = 2^96 is price 1, so a dollar quote makes the arithmetic checkable by hand.
const position = (extra: Partial<OnChainPosition> = {}): OnChainPosition => ({
  kind: "position", tokenId: 7350855n, liquidity: 1_000n,
  token0: "0x1111111111111111111111111111111111111111", token1: "0x2222222222222222222222222222222222222222",
  fee: 2500, tickLower: -100, tickUpper: 100, blockNumber: 120_282_210n, readAtMs: 1_000,
  sqrtPriceX96: 1n << 96n, amountsAvailable: true,
  amounts: { amount0: 5_000_000_000_000_000_000n, amount1: 4_000_000_000_000_000_000n },
  minimums: { amount0: 0n, amount1: 0n },
  owed: { amount0: 1_000_000_000_000_000_000n, amount1: 0n },
  ...extra,
});
const pricing: LivePricing = { quoteIsToken0: true, decimals0: 18, decimals1: 18, quoteMicros: 1_000_000n, symbol0: "USDT", symbol1: "WBNB" };
const read = (extra: Partial<OnChainPosition> = {}, discovered = false) => ({ position: position(extra), discovered });

describe("live position figures", () => {
  it("values principal plus uncollected fees at the pool's own price, and names the block", () => {
    const metric = liveValueMetric(read(), pricing);
    expect(metric.value).toBe("$10.00");
    expect(metric.note).toContain("block 120282210");
    expect(metric.note).toContain("principal + uncollected fees");
  });

  it("says when the NFT is on chain but the agent has not recorded it", () => {
    expect(liveValueMetric(read({}, true), pricing).note).toContain("not yet recorded by the agent");
  });

  it("prices only the uncollected fees for the fees figure", () => {
    const metric = liveFeesMetric(read(), pricing);
    expect(metric.value).toBe("$1.00");
    expect(metric.note).toContain("uncollected only");
  });

  it("subtracts the armed budget for PnL, in both directions", () => {
    const wbnbUsd = 3_000_000n; // $3 per WBNB
    expect(livePnlMetric(read(), pricing, "2000000000000000000", wbnbUsd).value).toBe("$4.00");
    expect(livePnlMetric(read(), pricing, "5000000000000000000", wbnbUsd).value).toBe("-$5.00");
  });

  it("refuses every figure without a fresh matching price, and never invents one", () => {
    for (const broken of [{ amountsAvailable: false }, { sqrtPriceX96: null }] as const) {
      expect(liveValueMetric(read(broken), pricing).value).toBeNull();
    }
    expect(liveValueMetric(undefined, pricing)).toEqual({ value: null, reason: "position not read on chain yet" });
    expect(livePnlMetric(read(), pricing, null, 3_000_000n).value).toBeNull();
    // Unpriceable fees still report the raw amounts rather than nothing.
    expect(liveFeesMetric(read({ sqrtPriceX96: null }), pricing).note).toContain("uncollected");
  });

  it("reads in-range from the NFT's own bounds against the pool tick", () => {
    expect(liveInRange(read(), 0)).toBe(true);
    expect(liveInRange(read(), 100)).toBe(false);
    expect(liveInRange(read(), -101)).toBe(false);
    expect(liveInRange(read(), null)).toBeNull();
    expect(liveInRange(undefined, 0)).toBeNull();
  });
});

describe("liveReadFor", () => {
  const recorded = new Map([["7350855", position()]]) as unknown as ReadonlyMap<string, { kind: string }>;

  it("uses the plane's recorded NFT when there is one", () => {
    expect(liveReadFor({ tokenId: "7350855", chainReads: recorded, discovered: [] })?.discovered).toBe(false);
    expect(liveReadFor({ tokenId: "7350855", chainReads: new Map(), discovered: [] })).toBeUndefined();
  });

  it("falls back to the wallet's single live NFT on this pool while the mint is unrecorded", () => {
    const found = liveReadFor({ tokenId: null, chainReads: new Map(), discovered: [position()] });
    expect(found?.discovered).toBe(true);
    expect(found?.position.tokenId).toBe(7350855n);
  });

  it("never guesses between two candidates, and ignores empty NFTs", () => {
    expect(liveReadFor({ tokenId: null, chainReads: new Map(), discovered: [position(), position({ tokenId: 2n })] })).toBeUndefined();
    expect(liveReadFor({ tokenId: null, chainReads: new Map(), discovered: [position({ liquidity: 0n })] })).toBeUndefined();
  });
});

describe("liveReadFor after a rebalance", () => {
  const emptied = position({ tokenId: 7350855n, liquidity: 0n });
  const minted = position({ tokenId: 7351142n });
  const recorded = new Map([["7350855", emptied]]) as unknown as ReadonlyMap<string, { kind: string }>;

  it("an emptied recorded NFT yields to the wallet's live one, marked as unrecorded", () => {
    const read = liveReadFor({ tokenId: "7350855", chainReads: recorded, discovered: [minted] });
    expect(read?.position.tokenId).toBe(7351142n);
    expect(read?.discovered).toBe(true);
  });

  it("a recorded NFT that still holds liquidity always wins", () => {
    const held = new Map([["7350855", position({ tokenId: 7350855n })]]) as unknown as ReadonlyMap<string, { kind: string }>;
    const read = liveReadFor({ tokenId: "7350855", chainReads: held, discovered: [minted] });
    expect(read?.position.tokenId).toBe(7350855n);
    expect(read?.discovered).toBe(false);
  });

  it("with nothing live in the wallet the emptied record is still reported, not hidden", () => {
    const read = liveReadFor({ tokenId: "7350855", chainReads: recorded, discovered: [] });
    expect(read?.position.tokenId).toBe(7350855n);
    expect(read?.discovered).toBe(false);
  });

  it("two live candidates are never guessed between", () => {
    expect(liveReadFor({ tokenId: "7350855", chainReads: recorded, discovered: [minted, position({ tokenId: 9n })] })?.position.tokenId).toBe(7350855n);
  });
});

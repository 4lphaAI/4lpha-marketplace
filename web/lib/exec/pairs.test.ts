import { describe, expect, it } from "vitest";

import {
  USDT_56,
  WBNB_56,
  formatAtomic,
  midpointWbnbUsdtPrice,
  nftPositionUrl,
  reviewedPair,
  pairQuoting,
  poolAddressFor,
  rangePrices,
} from "./pairs";

const BTCB = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";

describe("reviewed WBNB/USDT pair arithmetic", () => {
  it("keys decimals by chain and exact unordered addresses, not symbols", () => {
    expect(reviewedPair(56, WBNB_56, USDT_56, true)).not.toBeNull();
    expect(reviewedPair(56, USDT_56, WBNB_56, false)).not.toBeNull();
    expect(reviewedPair(97, WBNB_56, USDT_56, true)).toBeNull();
    expect(reviewedPair(56, WBNB_56, USDT_56, false)).toBeNull();
    expect(reviewedPair(56, WBNB_56, "0x1111111111111111111111111111111111111111", true)).toBeNull();
  });

  it("preserves a true half-tick and inverts the whole rational", () => {
    const forward = reviewedPair(56, WBNB_56, USDT_56, true)!;
    const reverse = reviewedPair(56, USDT_56, WBNB_56, false)!;
    const a = midpointWbnbUsdtPrice(65_532, 65_533, forward);
    const b = midpointWbnbUsdtPrice(-65_533, -65_532, reverse);
    expect(a.twiceMidTick).toBe(131_065);
    expect(b.twiceMidTick).toBe(-131_065);
    expect(a.value).toBe("701.29060531");
    expect(b.value).toBe(a.value);
    expect(a.value).not.toMatch(/[eE]/u);
  });

  it("formats atomic values above 2^53 without Number conversion", () => {
    expect(formatAtomic(((2n ** 53n) + 123n).toString(10), 18)).toBe("0.009007");
    expect(formatAtomic("1000000000000000001", 18)).toBe("1");
    expect(formatAtomic("01", 18)).toBeNull();
  });

  it("builds only positive-decimal chain-56 NFT links", () => {
    expect(nftPositionUrl("7263905")).toBe(
      "https://bscscan.com/nft/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364/7263905",
    );
    expect(nftPositionUrl("0")).toBeNull();
    expect(nftPositionUrl("07")).toBeNull();
  });

  it("quotes a rung the way the pool does, and derives the pool address without a chain read", () => {
    // The live shift grid, verified against NFPM positions(7310292/7310293) on
    // chain 56: the ask rung fills at 115.441 WBNB per BTCB and the bid at
    // 109.702. Quoting by pool order would print 0.00889 BTCB per WBNB, and
    // quoting always in WBNB inverts the stable pairs.
    const btcbWbnb = reviewedPair(56, BTCB, WBNB_56, false);
    expect(btcbWbnb).not.toBeNull();
    const quoting = pairQuoting(btcbWbnb!);
    expect(quoting).toEqual({ base: "BTCB", quote: "WBNB", invert: false });
    expect(rangePrices(47390, 47490, btcbWbnb!).high).toBe("115.44134504");
    expect(rangePrices(46980, 47080, btcbWbnb!).low).toBe("109.70172761");
    const wbnbUsdt = reviewedPair(56, USDT_56, WBNB_56, false);
    expect(pairQuoting(wbnbUsdt!)).toEqual({ base: "WBNB", quote: "USDT", invert: true });
    expect(poolAddressFor(BTCB, WBNB_56, 500)).toBe("0x6bbc40579ad1bbd243895ca0acb086bb6300d636");
    expect(poolAddressFor(USDT_56, WBNB_56, 100)).toBe("0x172fcd41e0913e95784454622d1c3724f546f849");
  });
});

import { describe, expect, it } from "vitest";
import { pancakePositionUrl } from "./pancake";

describe("pancakePositionUrl", () => {
  it("links to the PancakeSwap liquidity page for the given token id", () => {
    expect(pancakePositionUrl("42")).toBe("https://pancakeswap.finance/liquidity/42");
  });
});

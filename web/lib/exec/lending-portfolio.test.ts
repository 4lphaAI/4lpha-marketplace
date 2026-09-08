import { describe, expect, it } from "vitest";
import { parseLendingPortfolio, portfolioApy, portfolioUsd } from "./lending-portfolio";
describe("portfolio display", () => {
  it("keeps daily sub-cent signs, true zero, and two decimals", () => {
    expect(portfolioUsd("1", true)).toBe("<$0.01");
    expect(portfolioUsd("-1", true)).toBe("-<$0.01");
    expect(portfolioUsd("0", true)).toBe("$0.00");
    expect(portfolioUsd("1234560000000000000", true)).toBe("$1.23");
    expect(portfolioUsd(null)).toBe("—");
    expect(portfolioApy("241")).toBe("+2.41%");
    expect(portfolioApy("-56")).toBe("-0.56%");
  });
  it("rejects stale/malformed portfolio independently of the lending view", () => {
    expect(parseLendingPortfolio({ status: "available" })).toBeNull();
    const data = { status: "available", totalSupplyUsdMantissa: "1", totalBorrowedUsdMantissa: "0", dailyEarningUsdMantissa: "0", netApyBps: null, blockNumber: "42", asOfMs: 1 };
    expect(parseLendingPortfolio(data, 120_002)).toBeNull();
    expect(parseLendingPortfolio(data, 120_001)?.status).toBe("available");
  });
});

import { describe, expect, it } from "vitest";
import { lendingUsdtGrantCap } from "./grant-cap";

describe("new-hire USDT cap headroom", () => {
  it("adds exactly 10% with ceiling rounding, without losing wei", () => {
    expect(lendingUsdtGrantCap("44000000000000000000")).toBe(48400000000000000000n);
    expect(lendingUsdtGrantCap("1")).toBe(2n);
    expect(lendingUsdtGrantCap("27659871722522530168")).toBe(30425858894774783185n);
  });
  it("refuses invalid, zero and overflowing proposals instead of clamping", () => {
    for (const floor of ["0", "-1", "1.2", "", "9".repeat(79), ((1n << 256n) - 1n).toString()]) expect(lendingUsdtGrantCap(floor)).toBeNull();
    const maximumFloor = (((1n << 256n) - 1n) * 100n / 110n).toString();
    expect(lendingUsdtGrantCap(maximumFloor)).not.toBeNull();
  });
});

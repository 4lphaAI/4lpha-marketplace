import { describe, expect, it } from "vitest";
import { maxUsdtDepositAtomic, parseUsdtDepositAmount, USDT_TRANSFER_GAS_LIMIT } from "./FundsModal";

describe("USDT account deposits", () => {
  it("parses 18-decimal amounts exactly and rejects excess precision", () => {
    expect(parseUsdtDepositAmount("5")).toEqual({ atomic: 5_000_000_000_000_000_000n });
    expect(parseUsdtDepositAmount("0.000000000000000001")).toEqual({ atomic: 1n });
    expect(parseUsdtDepositAmount("1.0000000000000000001")).toEqual({ error: "Enter an amount in USDT with up to 18 decimals." });
    expect(parseUsdtDepositAmount("0")).toEqual({ error: "Enter an amount greater than zero." });
  });

  it("offers the token balance only when the connected wallet can pay transfer gas", () => {
    const gasPrice = 1_000_000_000n;
    const reserve = gasPrice * USDT_TRANSFER_GAS_LIMIT * 12n / 10n;
    expect(maxUsdtDepositAtomic({ balanceAtomic: 20n * 10n ** 18n, nativeBalanceWei: reserve, gasPriceWei: gasPrice })).toBe(20n * 10n ** 18n);
    expect(maxUsdtDepositAtomic({ balanceAtomic: 20n * 10n ** 18n, nativeBalanceWei: reserve - 1n, gasPriceWei: gasPrice })).toBe(0n);
    expect(maxUsdtDepositAtomic({ balanceAtomic: 0n, nativeBalanceWei: reserve, gasPriceWei: gasPrice })).toBe(0n);
  });
});

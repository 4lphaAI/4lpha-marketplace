import { describe, expect, it } from "vitest";
import { requiredTradeDepositWei } from "./hire-funding";
import { tradfiV2FundingSnapshot } from "./trade-funding";

const E18 = 10n ** 18n;
const sizing = { maxOpenPositions: 3, grantedTokenCount: 6, tradeRelayFeePerSubmitWei: "100" };

describe("TradFi v2 funding tuple", () => {
  it("reports a USDT shortfall while BNB registration and reserve are funded", () => {
    const result = tradfiV2FundingSnapshot({
      sizing: { ...sizing, nativeReserveWei: "1300" },
      funding: { requiredWei: "1000", balanceWei: "10000", quoteRequiredWei: (100n * E18).toString(), quoteBalanceWei: (50n * E18).toString() },
      capitalQuoteWei: (100n * E18).toString(), cmcTotalBudgetWei: (5n * E18).toString(),
    });
    expect(result.nativeShortfallWei).toBe(0n);
    expect(result.quoteRequiredWei).toBe(100n * E18);
    expect(result.quoteShortfallWei).toBe(50n * E18);
  });

  it("reports a BNB shortfall while USDT is funded", () => {
    const result = tradfiV2FundingSnapshot({
      sizing: { ...sizing, nativeReserveWei: "1300" },
      funding: { requiredWei: "1000", balanceWei: "2000", quoteRequiredWei: (100n * E18).toString(), quoteBalanceWei: (100n * E18).toString() },
      capitalQuoteWei: (100n * E18).toString(),
    });
    expect(result.nativeTargetWei).toBe(2300n);
    expect(result.nativeShortfallWei).toBe(300n);
    expect(result.quoteShortfallWei).toBe(0n);
  });

  it("uses the authoritative native reserve and does not double-add fee or data budget", () => {
    const result = tradfiV2FundingSnapshot({
      sizing: { ...sizing, nativeReserveWei: "1300" },
      funding: { requiredWei: "1000", balanceWei: "0", quoteRequiredWei: (105n * E18).toString(), quoteBalanceWei: "0" },
      capitalQuoteWei: (100n * E18).toString(), cmcTotalBudgetWei: (10n * E18).toString(),
    });
    expect(result.nativeTargetWei).toBe(2300n);
    expect(result.quoteRequiredWei).toBe(105n * E18);
  });

  it("derives the initial native cap from the authoritative stock count when preview omits the field", () => {
    const result = tradfiV2FundingSnapshot({
      sizing: { ...sizing },
      funding: { requiredWei: "0", balanceWei: "0", quoteRequiredWei: "0", quoteBalanceWei: "0" },
      capitalQuoteWei: "0",
    });
    expect(result.nativeReserveWei).toBe(1300n);
  });

  it("keeps legacy BNB deposit arithmetic unchanged", () => {
    const result = requiredTradeDepositWei({ capDayWei: "100", funding: {
      version: 1, observedAtSec: 1, registrationFeeWei: "20", registrations: 1, relayGasHeadroomWei: "30", requiredWei: "50", balanceWei: "0",
    } });
    expect(result.depositTargetWei).toBe(150n);
    expect(result.depositShortfallWei).toBe(150n);
  });
});

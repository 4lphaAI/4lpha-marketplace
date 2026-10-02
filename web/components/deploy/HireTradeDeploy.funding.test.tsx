import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradfiFundingSummary } from "./HireTradeDeploy";

describe("rendered TradFi funding summary", () => {
  it("shows a USDT shortfall with funded BNB", () => {
    const html = renderToStaticMarkup(<TradfiFundingSummary funding={{ nativeReserveWei: 1300n, nativeTargetWei: 2300n, nativeBalanceWei: 10_000n, nativeShortfallWei: 0n, quoteRequiredWei: 100n * 10n ** 18n, quoteBalanceWei: 50n * 10n ** 18n, quoteShortfallWei: 50n * 10n ** 18n }} />);
    expect(html).toContain("shortfall 50 USDT");
    expect(html).toContain("shortfall 0 BNB");
  });

  it("shows a BNB shortfall with funded USDT", () => {
    const html = renderToStaticMarkup(<TradfiFundingSummary funding={{ nativeReserveWei: 1300n, nativeTargetWei: 2300n, nativeBalanceWei: 2000n, nativeShortfallWei: 300n, quoteRequiredWei: 100n * 10n ** 18n, quoteBalanceWei: 100n * 10n ** 18n, quoteShortfallWei: 0n }} />);
    expect(html).toContain("shortfall 0 USDT");
    expect(html).toContain("shortfall 0.0000000000000003 BNB");
  });
});

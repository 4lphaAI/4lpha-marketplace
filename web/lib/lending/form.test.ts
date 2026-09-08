import { describe, expect, it } from "vitest";
import {
  LENDING_CHECK_EVERY_TEXT,
  LENDING_CUSTODY_COPY,
  LENDING_GIFT_COPY,
  LENDING_IRREVERSIBLE_TICK,
  LENDING_NO_LOCK_IN_COPY,
  LENDING_OWN_ACCOUNT_COPY,
  LENDING_RESCUE_COUNT_HINT,
  buildLendingForm,
  derivedDailyRepayLimitWei,
  lendingCheckEveryText,
  lendingControlNumber,
  formatHf,
  hfToMantissa,
  lendingExposureLine,
  parseUsd,
  pinnableDebtMarkets,
  unsupportedDebtSymbols,
  usdToNativeWei,
  usdToUsdtWei,
  usdtDecimalsFrom,
} from "./form";
import type { LendingGuardableView } from "@/lib/exec/lending-types";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_BNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const V_USDC = "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const base = {
  triggerHf: "1.20",
  targetHf: "1.50",
  maxRepayUsd: "240",
  rescueReserveCount: 6,
  cooldownSeconds: 300,
  reserveBps: 2_000,
  debtMarkets: [V_USDT],
  vUsdt: V_USDT,
  vBnb: V_BNB,
  usdt: USDT,
  usdtDecimals: 18,
  wbnbPriceMicros: 900_000_000n, // $900.00
};

describe("the copy the spec fixes verbatim", () => {
  it("carries R2.20's gift sentence, its tick, R3.13's copy, R2.17's hint and §6.2", () => {
    expect(LENDING_GIFT_COPY).toBe(
      "Repayments to this address are final: they cannot be undone.",
    );
    expect(LENDING_IRREVERSIBLE_TICK).toBe("I understand repayments to this address cannot be reversed");
    expect(LENDING_OWN_ACCOUNT_COPY).toBe(
      "The guard needs its own account (a new passkey), not just its own wallet. Switching accounts does not pause your other agent.",
    );
    expect(LENDING_NO_LOCK_IN_COPY).toBe(
      "Your reserve is recoverable with your passkey at any time; the agent's key cannot block it.",
    );
    expect(LENDING_RESCUE_COUNT_HINT).toContain("refusing a rescue is the trap it exists to avoid");
    // "Check every" has NO source at hire time: `/lending/config` does not carry
    // the worker interval, so this must stay a dash with its reason.
    expect(LENDING_CHECK_EVERY_TEXT.startsWith("—")).toBe(true);
  });
});

describe("unit conversion", () => {
  it("prices USDT at a dollar and BNB through the fresh price", () => {
    expect(usdToUsdtWei(240, 18)).toBe(240_000_000_000_000_000_000n);
    // $240 at $900/BNB = 0.2666… BNB
    expect(usdToNativeWei(240, 900_000_000n)).toBe(266_666_666_666_666_666n);
    expect(usdToNativeWei(240, null)).toBeNull();
    expect(usdToUsdtWei(0, 18)).toBeNull();
  });

  it("parses a typed dollar amount and refuses anything that is not one", () => {
    expect(parseUsd("240")).toBe(240);
    expect(parseUsd("$1,000")).toBe(1_000);
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("-5")).toBeNull();
    expect(parseUsd("abc")).toBeNull();
  });

  it("round-trips a health factor through its 1e18 mantissa", () => {
    expect(hfToMantissa("1.20")).toBe(1_200_000_000_000_000_000n);
    expect(formatHf(hfToMantissa("1.5"))).toBe("1.50");
    expect(hfToMantissa("one point two")).toBeNull();
    expect(formatHf(null)).toBe("—");
  });

  it("prefers the CHAIN's own decimals for USDT over the 18-decimal fallback", () => {
    const guardable = {
      markets: [{ vToken: V_USDT, underlyingDecimals: 6 }],
    } as unknown as LendingGuardableView;
    expect(usdtDecimalsFrom(guardable, V_USDT)).toBe(6);
    expect(usdtDecimalsFrom(null, V_USDT)).toBe(18);
    expect(usdtDecimalsFrom(guardable, null)).toBe(18);
  });
});

describe("buildLendingForm", () => {
  it("builds one ceiling per pinned market and nothing else", () => {
    const result = buildLendingForm({ ...base, debtMarkets: [V_USDT, V_BNB] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.maxPerAction).toEqual([
      { token: USDT, maxWei: "240000000000000000000" },
      { token: null, maxWei: "266666666666666666" },
    ]);
    expect(result.settings.triggerHf).toBe("1200000000000000000");
    expect(result.settings.targetHf).toBe("1500000000000000000");
    expect(result.usdtCeilingWei).toBe(240_000_000_000_000_000_000n);
  });

  it("a vBNB-only guard names NO USDT ceiling, so the receipt binds zero", () => {
    const result = buildLendingForm({ ...base, debtMarkets: [V_BNB] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.maxPerAction).toEqual([{ token: null, maxWei: "266666666666666666" }]);
    expect(result.usdtCeilingWei).toBe(0n);
  });

  // A BNB ceiling is signed for SEVEN DAYS. Converting it through a stale price
  // is exactly the thing that must not happen quietly.
  it("refuses a BNB ceiling when the price is not fresh, and says why", () => {
    const result = buildLendingForm({ ...base, debtMarkets: [V_BNB], wbnbPriceMicros: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("not fresh");
    expect(result.message).toContain("seven days");
  });

  it("reuses an EXISTING BNB ceiling verbatim when the Edit panel supplies one", () => {
    const result = buildLendingForm({
      ...base, debtMarkets: [V_BNB], wbnbPriceMicros: null,
      existingNativeMaxWei: 300_000_000_000_000_000n,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.maxPerAction).toEqual([{ token: null, maxWei: "300000000000000000" }]);
  });

  it("restates every plane bound so the refusal arrives BEFORE the passkey ceremony", () => {
    const cases: readonly { readonly patch: Partial<typeof base>; readonly contains: string }[] = [
      { patch: { triggerHf: "1.00" }, contains: "between 1.05 and 3.00" },
      { patch: { triggerHf: "3.50" }, contains: "between 1.05 and 3.00" },
      { patch: { targetHf: "1.22" }, contains: "at least 0.05 above the trigger" },
      { patch: { rescueReserveCount: 0 }, contains: "from 1 to 24" },
      { patch: { rescueReserveCount: 25 }, contains: "from 1 to 24" },
      { patch: { cooldownSeconds: 120 }, contains: "from 300 to 86400" },
      { patch: { reserveBps: 900 }, contains: "between 10% and 50%" },
      { patch: { reserveBps: 5_100 }, contains: "between 10% and 50%" },
      { patch: { maxRepayUsd: "0" }, contains: "greater than zero" },
      { patch: { debtMarkets: [] }, contains: "no debt this guard can repay" },
      { patch: { debtMarkets: [V_USDC] }, contains: "not a v1 debt market" },
    ];
    for (const { patch, contains } of cases) {
      const result = buildLendingForm({ ...base, ...patch });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      if (result.ok) continue;
      expect(result.message, JSON.stringify(patch)).toContain(contains);
    }
  });
});

describe("the derived, read-only figures", () => {
  it("Daily repay limit is `rescueReserveCount x maxPerAction[USDT]`, NOT the on-chain cap", () => {
    expect(derivedDailyRepayLimitWei(6, 240_000_000_000_000_000_000n))
      .toBe(1_440_000_000_000_000_000_000n);
    expect(derivedDailyRepayLimitWei(6, null)).toBeNull();
    expect(derivedDailyRepayLimitWei(0, 1n)).toBeNull();
  });

  // FINDINGS (r): print the PRODUCT (cap x 7), never the per-day rate alone.
  it("the exposure line prints both caps, the 7-day product AND the holdings bound", () => {
    const line = lendingExposureLine({
      reserveCapWei: 44_000_000_000_000_000_000n,
      capDayWei: 90_000_000_000_000_000n,
      usdtDecimals: 18,
    });
    expect(line).toContain("Most this agent's key could move per day: 44 USDT + 0.09 BNB");
    expect(line).toContain("× 7 days = the session's total exposure");
    expect(line).toContain("bounded by what the agent wallet actually holds");
  });

  it("the exposure line never invents a figure it was not given", () => {
    const line = lendingExposureLine({ reserveCapWei: null, capDayWei: null, usdtDecimals: 18 });
    expect(line).toContain("an unquoted amount of USDT");
    expect(line).toContain("an unquoted amount of BNB");
  });
});

describe("which markets a hire may pin", () => {
  const guardable = {
    debts: [
      { vToken: V_USDT, symbol: "vUSDT", borrowWei: "1000", supported: true },
      { vToken: V_BNB, symbol: "vBNB", borrowWei: "0", supported: true },
      { vToken: V_USDC, symbol: "vUSDC", borrowWei: "500", supported: false },
    ],
  } as unknown as LendingGuardableView;

  // S1 refuses a market with no debt in the preview, so the browser must not
  // offer one — the refusal would land AFTER the hire signature.
  it("offers only supported markets carrying a real borrow", () => {
    expect(pinnableDebtMarkets(guardable)).toEqual([V_USDT]);
    expect(pinnableDebtMarkets(null)).toEqual([]);
  });

  it("names the unsupported debt so it can be disclosed rather than hidden", () => {
    expect(unsupportedDebtSymbols(guardable)).toEqual(["vUSDC"]);
  });
});

/* -------------------------------------------------------------------------- */
/* W7 — R2.2's custody paragraph, verbatim                                    */
/* -------------------------------------------------------------------------- */

describe("the custody paragraph is R2.2 verbatim", () => {
  it("carries every clause, including the two the first pass dropped", () => {
    expect(LENDING_CUSTODY_COPY).toBe(
      "Wallet B's reserve is protected by three things and no fourth: the on-chain "
      + "per-token and native caps, the call allowlist, and the 7-day expiry. A leaked "
      + "session key can move the reserve OUT of wallet B to an address of its choosing "
      + "— by approving any spender on USDT, or by naming any recipient on the granted "
      + "router — bounded per rolling day by the USDT cap (reserveCapWei) and the native "
      + "cap (capDayWei), and over the session's life by seven times each. That is the "
      + "same posture venusSessionSpec states and the same posture every LP and Grid "
      + "session on this platform already carries. What the template does remove is the "
      + "ability to borrow, to enter or exit markets, to touch the wallet's own admin "
      + "surface or the KeyStore, and to mint an unredeemable native position. The hard "
      + "stops remain the caps, the expiry, and an owner-signed revoke.",
    );
  });

  // The audit's two named omissions, pinned by name so a future edit that
  // "tightens" the paragraph has to delete an assertion to do it.
  it("names HOW a leaked key moves the reserve, and what the hard stops are", () => {
    expect(LENDING_CUSTODY_COPY).toContain("by approving any spender on USDT, or by naming any recipient on the granted router");
    expect(LENDING_CUSTODY_COPY).toContain("The hard stops remain the caps, the expiry, and an owner-signed revoke.");
  });
});

/* -------------------------------------------------------------------------- */
/* W6 — the control reader that replaced the clamps                           */
/* -------------------------------------------------------------------------- */

describe("lendingControlNumber", () => {
  it("passes a typed value through, in range or not", () => {
    expect(lendingControlNumber("100", 300)).toBe(100);
    expect(lendingControlNumber("99", 6)).toBe(99);
    expect(lendingControlNumber("0", 6)).toBe(0);
    expect(lendingControlNumber("1,200", 300)).toBe(1_200);
    expect(lendingControlNumber(45, 20)).toBe(45);
  });

  it("uses the default only for a blank or unreadable field", () => {
    expect(lendingControlNumber("", 300)).toBe(300);
    expect(lendingControlNumber("   ", 300)).toBe(300);
    expect(lendingControlNumber(null, 6)).toBe(6);
    expect(lendingControlNumber(undefined, 6)).toBe(6);
    expect(lendingControlNumber("abc", 20)).toBe(20);
  });

  it("out-of-range values reach the SHARED builder, which refuses them by name", () => {
    const cooldown = buildLendingForm({ ...base, cooldownSeconds: lendingControlNumber("100", 300) });
    expect(cooldown.ok).toBe(false);
    if (!cooldown.ok) expect(cooldown.message).toContain("from 300 to 86400");

    const count = buildLendingForm({ ...base, rescueReserveCount: lendingControlNumber("99", 6) });
    expect(count.ok).toBe(false);
    if (!count.ok) expect(count.message).toContain("from 1 to 24");

    const split = buildLendingForm({ ...base, reserveBps: Math.round(lendingControlNumber("80", 20) * 100) });
    expect(split.ok).toBe(false);
    if (!split.ok) expect(split.message).toContain("between 10% and 50%");
  });
});

describe("lendingCheckEveryText", () => {
  it("quotes the plane's cadence when there is one, and dashes when there is not", () => {
    expect(lendingCheckEveryText(30_000)).toBe("30 s — the operator's configured cadence");
    expect(lendingCheckEveryText(1_500)).toBe("1.5 s — the operator's configured cadence");
    for (const absent of [undefined, null, 0, -1, Number.NaN]) {
      expect(lendingCheckEveryText(absent), String(absent)).toBe(LENDING_CHECK_EVERY_TEXT);
    }
  });
});

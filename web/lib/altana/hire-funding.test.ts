import { describe, expect, it } from "vitest";
import { depositAmountBnb, depositAmountWei, requiredDepositWei, requiredLendingDepositWei, requiredTradeDepositWei, walletSharedWithLiveAgents } from "./hire-funding";

/**
 * The live numbers from grid-agent-01-5's preview (2026-09-03): budget 0.0627,
 * one registration at 0.000693650169219776, headroom 0.0001128, relay fee
 * 0.0001, wallet 0.0001326784. `reserves.totalWei` is the plane's daily native
 * reserve for the grid-shift preset at that fee (GRID-GAS-RESERVE W1).
 */
const sizing = {
  openNativeBudgetWei: "62700000000000000",
  relayFeePerSubmitWei: "100000000000000",
  reserves: { totalWei: "7800000000000000" }, // 0.0078 BNB
};
const funding = {
  version: 1 as const,
  observedAtSec: 1_788_454_000,
  registrationFeeWei: "693650169219776",
  registrations: 1 as const,
  relayGasHeadroomWei: "112800000000000",
  requiredWei: "806450169219776",
  balanceWei: "132678400000000",
};
// 0.0627 + 0.000693650169219776 + 0.0001128 + 3 × 0.0001 + 0.0078
const TOTAL = 71_606_450_169_219_776n;

describe("requiredDepositWei", () => {
  it("adds the budget, the registration(s), the headroom, an arm gas pad AND the plane's daily reserve", () => {
    const { totalWei, shortfallWei } = requiredDepositWei({ sizing, funding, sharedWithLiveAgents: false });
    expect(totalWei).toBe(TOTAL);
    expect(shortfallWei).toBe(TOTAL - 132_678_400_000_000n);
  });

  it("GRID-GAS-RESERVE W1: on a wallet that already carries a live agent, NONE of the balance is credited", () => {
    // The incident: wallet B held grid-agent-01-5's 0.0015 BNB operating pot;
    // crediting it to btcb's deposit left both agents with 0.000098693 BNB.
    const shared = requiredDepositWei({
      sizing, funding: { ...funding, balanceWei: "1508940000000000" }, sharedWithLiveAgents: true,
    });
    expect(shared.creditedWei).toBe(0n);
    expect(shared.shortfallWei).toBe(TOTAL);
    const alone = requiredDepositWei({
      sizing, funding: { ...funding, balanceWei: "1508940000000000" }, sharedWithLiveAgents: false,
    });
    expect(alone.creditedWei).toBe(1_508_940_000_000_000n);
    expect(alone.shortfallWei).toBe(TOTAL - 1_508_940_000_000_000n);
  });

  it("an older preview without reserves counts the reserve as zero, never throws", () => {
    const { reserves: _omit, ...legacy } = sizing;
    expect(requiredDepositWei({ sizing: legacy, funding, sharedWithLiveAgents: false }).totalWei)
      .toBe(TOTAL - 7_800_000_000_000_000n);
  });

  it("charges two registrations when the wallet has no active key yet", () => {
    const two = requiredDepositWei({ sizing, funding: { ...funding, registrations: 2 }, sharedWithLiveAgents: false });
    expect(two.totalWei - requiredDepositWei({ sizing, funding, sharedWithLiveAgents: false }).totalWei).toBe(693_650_169_219_776n);
  });

  it("is zero once the wallet already covers it, and treats an unreadable balance as empty", () => {
    expect(requiredDepositWei({ sizing, funding: { ...funding, balanceWei: "80000000000000000" }, sharedWithLiveAgents: false }).shortfallWei).toBe(0n);
    expect(requiredDepositWei({ sizing, funding: { ...funding, balanceWei: null }, sharedWithLiveAgents: false }).shortfallWei).toBe(TOTAL);
  });

  it("refuses a non-wei string rather than computing on it", () => {
    expect(() => requiredDepositWei({ sizing: { ...sizing, openNativeBudgetWei: "0.06" }, funding, sharedWithLiveAgents: false })).toThrow(/wei/u);
    expect(() => requiredDepositWei({ sizing: { ...sizing, reserves: { totalWei: "x" } }, funding, sharedWithLiveAgents: false })).toThrow(/wei/u);
  });
});

describe("walletSharedWithLiveAgents", () => {
  const wallet = "0x27146E20c2fb2521c7DD73e97bE030C3147c9da6";
  it("is true when another live agent sits on the same wallet, case-insensitively", () => {
    expect(walletSharedWithLiveAgents({
      agents: [{ id: "grid-agent-01-5", status: "armed", walletAddress: wallet.toLowerCase() }],
      walletAddress: wallet, excludingId: "btcb",
    })).toBe(true);
  });
  it("ignores the agent being hired, retired/revoked rows, and other wallets", () => {
    expect(walletSharedWithLiveAgents({
      agents: [
        { id: "btcb", status: "provisioning", walletAddress: wallet },
        { id: "old", status: "retired", walletAddress: wallet },
        { id: "gone", status: "revoked", walletAddress: wallet },
        { id: "elsewhere", status: "armed", walletAddress: `0x${"11".repeat(20)}` },
      ],
      walletAddress: wallet, excludingId: "btcb",
    })).toBe(false);
  });
  it("treats a row it cannot read as a neighbour (cannot tell ⇒ shared)", () => {
    expect(walletSharedWithLiveAgents({ agents: [{ id: "x" }], walletAddress: wallet, excludingId: "btcb" })).toBe(true);
  });
});

describe("depositAmount", () => {
  it("rounds UP to four places, so the figure is never short of the gate", () => {
    const shortfall = TOTAL - 132_678_400_000_000n; // 0.071473771769219776
    expect(depositAmountBnb(shortfall)).toBe("0.0715");
    expect(depositAmountWei(shortfall)).toBe(71_500_000_000_000_000n);
    expect(depositAmountWei(shortfall) >= shortfall).toBe(true);
  });
  it("keeps an exact four-place amount as it is", () => {
    expect(depositAmountBnb(50_000_000_000_000_000n)).toBe("0.0500");
    expect(depositAmountWei(50_000_000_000_000_000n)).toBe(50_000_000_000_000_000n);
  });
});

describe("requiredTradeDepositWei", () => {
  it("funds Trading capital plus registration and grant headroom, crediting a readable exclusive balance", () => {
    expect(requiredTradeDepositWei({ capDayWei: "10000000000000000", funding })).toEqual({
      depositTargetWei: 10_806_450_169_219_776n,
      depositCreditedWei: 132_678_400_000_000n,
      depositShortfallWei: 10_673_771_769_219_776n,
    });
  });

  it("credits zero when the balance is unreadable", () => {
    const unreadable = { ...funding, balanceWei: null };
    const result = requiredTradeDepositWei({ capDayWei: "10000000000000000", funding: unreadable });
    expect(result.depositShortfallWei).toBe(result.depositTargetWei);
  });
});

describe("requiredLendingDepositWei", () => {
  /*
   * MARKETPLACE-LENDING-AGENT R2.15: the `requiredTradeDepositWei` SHAPE with no
   * `reserves.totalWei` — lending has no LP exit/protect lanes to reserve for,
   * and its own gas reserve is the BNB tier INSIDE the budget (`reserveBps`).
   *
   * 0.0627 + 0.000693650169219776 + 0.0001128 + 3 × 0.0001 = 0.063806450169219776
   */
  const LENDING_TOTAL = 63_806_450_169_219_776n;

  it("adds the reserve budget, the registration(s), the headroom and the arm gas pad — and NOT the LP reserve", () => {
    const result = requiredLendingDepositWei({
      budgetWei: sizing.openNativeBudgetWei,
      relayFeePerSubmitWei: sizing.relayFeePerSubmitWei,
      funding,
    });
    expect(result.totalWei).toBe(LENDING_TOTAL);
    expect(result.totalWei).toBe(TOTAL - 7_800_000_000_000_000n);
    expect(result.creditedWei).toBe(132_678_400_000_000n);
    expect(result.shortfallWei).toBe(LENDING_TOTAL - 132_678_400_000_000n);
  });

  it("credits the readable balance — sound ONLY because R3.13 gates a shared wallet before signing", () => {
    const shared = requiredLendingDepositWei({
      budgetWei: sizing.openNativeBudgetWei,
      relayFeePerSubmitWei: sizing.relayFeePerSubmitWei,
      funding: { ...funding, balanceWei: LENDING_TOTAL.toString(10) },
    });
    expect(shared.shortfallWei).toBe(0n);
    // Which is exactly why the gate must fire first.
    expect(walletSharedWithLiveAgents({
      agents: [{ id: "other", status: "armed", walletAddress: "0xB0B0000000000000000000000000000000000000" }],
      walletAddress: "0xb0b0000000000000000000000000000000000000",
      excludingId: "lending-agent-01",
    })).toBe(true);
  });

  it("credits zero when the wallet balance is unreadable", () => {
    const result = requiredLendingDepositWei({
      budgetWei: sizing.openNativeBudgetWei,
      relayFeePerSubmitWei: sizing.relayFeePerSubmitWei,
      funding: { ...funding, balanceWei: null },
    });
    expect(result.creditedWei).toBe(0n);
    expect(result.shortfallWei).toBe(result.totalWei);
  });
});

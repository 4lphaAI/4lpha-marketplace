import { describe, expect, it } from "vitest";
import { mapAgentDetail } from "./agent-detail";
import { getSqrtRatioAtTick } from "./pairs";

/**
 * Gross PnL exists because realised PnL waits for a completed round trip: a
 * shift ladder that re-ranged seven times and filled nothing dashed forever.
 * It counts the rungs AND the wallet's idle halves, because shift mode leaves
 * ~70% of the capital idle by design — a figure built from the rungs alone
 * would read like a catastrophic loss.
 */
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const MUBARAK = "0x5c85d6c6825ab4032337f11ee92a72df936b46f6";
const NOW = 2_000;

function owner(budgetWei = "41500000000000000"): unknown {
  return {
    data: {
      id: "grid-agent-01-2",
      status: "armed",
      walletAddress: "0x27146e20c2fb2521c7dd73e97be030c3147c9da6",
      httpRuntimeProfile: "lp-v1",
      hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: budgetWei },
      session: null,
    },
  };
}

function position(id: string, tokenId: string, exitValueWei: string | null): unknown {
  return {
    positionId: id,
    state: "open",
    tokenId,
    rowVersion: 1,
    basisWei: "0",
    quoteToken: WBNB,
    token0: MUBARAK,
    token1: WBNB,
    createdAt: 1_000,
    observation: exitValueWei === null ? null : {
      valuation: { exitValueWei, valuedAtMs: 1_500, positionRowVersion: 1, tokenId, quoteToken: WBNB },
    },
  };
}

function lp(gridOverrides: Record<string, unknown> = {}, positions = [position("p1", "7316794", "6193000000000000"), position("p2", "7316844", "6219000000000000")]): unknown {
  return {
    data: {
      positions,
      sequences: [],
      grid: {
        pool: { token0: MUBARAK, token1: WBNB, fee: 2500 },
        wbnbIsToken0: false,
        tickSpacing: 50,
        buyRange: { tickLower: -101_750, tickUpper: -101_650 },
        sellRange: { tickLower: -101_300, tickUpper: -101_200 },
        levels: [{
          positionId: "p1",
          gridRole: "buy",
          observedTick: -101_432,
          observationAgeMs: 1_000,
          pnl: { realisedQuoteWei: null, recordedCycles: 0, overRoundTrips: 0 },
        }],
        cycles: { available: true, recorded: 0, rows: [], note: "no cycles yet" },
        // The wallet's idle halves, as the plane reads them for a shift grid.
        buffer: { quoteWei: "20000000000000000", baseWei: "0", bookBaseWei: null, bookCostWbnbWei: null },
        ...gridOverrides,
      },
      settingsDigest: "0xabc",
    },
  };
}

describe("gross PnL", () => {
  it("counts collectible fees in the exit value once, then counts collected fees in the wallet once", () => {
    const budget = "20000000000000000";
    const beforeCollect = lp({ buffer: { quoteWei: "10000000000000000", baseWei: "0" } }, [
      position("p1", "7316794", "11000000000000000"),
    ]);
    const afterCollect = lp({ buffer: { quoteWei: "11000000000000000", baseWei: "0" } }, [
      position("p1", "7316794", "10000000000000000"),
    ]);
    // Moving 0.001 WBNB of earned fees from the NFT into the wallet leaves
    // total profit unchanged. Fee-history telemetry is not additional money.
    const before = mapAgentDetail(owner(budget), beforeCollect, NOW);
    const after = mapAgentDetail(owner(budget), afterCollect, NOW);
    expect(before.grossPnl.value).toBe("+0.001 WBNB");
    expect(after.grossPnl).toEqual(before.grossPnl);
    expect(after.grossPnlPercent.value).toBe("+5.00%");
  });

  it("excludes the separate native gas reserve from the capital profit calculation", () => {
    const view = mapAgentDetail(owner(), lp({ buffer: {
      quoteWei: "20000000000000000", baseWei: "0",
      nativeWei: "900000000000000000", nextShiftGasWei: "1000000000000000",
    } }), NOW);
    expect(view.grossPnl).toEqual(mapAgentDetail(owner(), lp(), NOW).grossPnl);
  });

  it("adds the rungs to the wallet's idle WBNB and compares against the armed budget", () => {
    const view = mapAgentDetail(owner(), lp(), NOW);
    // 0.006193 + 0.006219 rungs + 0.020000 idle = 0.032412 vs 0.0415 armed.
    expect(view.grossPnl.value).toBe("-0.009088 WBNB");
    expect(view.grossPnlPercent.value).toBe("-21.89%");
    // No WBNB price snapshot in this fixture, so the figure stays in WBNB and
    // carries the same amount as its `bnb` unit. No footnote: the tiles show
    // numbers only.
    expect(view.grossPnl.bnb).toBe("-0.009088 WBNB");
    expect(view.grossPnl.usd).toBeUndefined();
    expect(view.grossPnl.note).toBeUndefined();
  });

  it("prices the idle BASE leg off the observed tick", () => {
    const withBase = mapAgentDetail(owner(), lp({
      buffer: { quoteWei: "20000000000000000", baseWei: "100000000000000000000", bookBaseWei: null, bookCostWbnbWei: null },
    }), NOW);
    const withoutBase = mapAgentDetail(owner(), lp(), NOW);
    expect(withBase.grossPnl.value).not.toBe(withoutBase.grossPnl.value);
    // 100 mubarak near 0.0000381 WBNB is worth ~0.0038 WBNB, so the loss shrinks.
    expect(withBase.grossPnl.value?.startsWith("-0.005")).toBe(true);
  });

  it("refuses a partial total rather than under-reporting it", () => {
    const unvalued = mapAgentDetail(owner(), lp({}, [position("p1", "7316794", "6193000000000000"), position("p2", "7316844", null)]), NOW);
    expect(unvalued.grossPnl.value).toBeNull();
    expect(unvalued.grossPnl.reason).toBe("— a live rung is not valued yet");

    const noBuffer = mapAgentDetail(owner(), lp({ buffer: undefined }), NOW);
    expect(noBuffer.grossPnl.value).toBeNull();
    expect(noBuffer.grossPnl.reason).toBe("— wallet balances unavailable");
  });

  it("says so when the agent carries no armed budget to measure against", () => {
    const noBudget = mapAgentDetail({ data: { ...(owner() as { data: Record<string, unknown> }).data, hireSizing: { name: "grid-shift-v1", version: 1 } } }, lp(), NOW);
    expect(noBudget.grossPnl.value).toBeNull();
    expect(noBudget.grossPnl.reason).toBe("— the armed budget is not recorded on this agent");
  });

  it("is a profit when the holdings exceed the budget", () => {
    const up = mapAgentDetail(owner("20000000000000000"), lp(), NOW);
    expect(up.grossPnl.value?.startsWith("+")).toBe(true);
  });
});

describe("gross PnL in USD", () => {
  // The same snapshot shape the delegated tile prices BNB from.
  const snapshot = {
    data: { symbol: "WBNB", address: WBNB, priceUsd: 700 },
    meta: { asOf: NOW, staleness: "fresh", source: "pancake-v3-slot0" },
  };

  it("reports dollars when a fresh WBNB price supports it, and keeps WBNB beside it", () => {
    const view = mapAgentDetail(owner(), lp(), NOW, snapshot);
    // -0.009088 WBNB at $700 = -$6.36.
    expect(view.grossPnl.value).toBe("-$6.36");
    expect(view.grossPnl.bnb).toBe("-0.009088 WBNB");
    expect(view.grossPnl.usd).toBe("-$6.36");
  });

  it("falls back to WBNB rather than inventing a rate", () => {
    expect(mapAgentDetail(owner(), lp(), NOW).grossPnl.value).toBe("-0.009088 WBNB");
  });

  it("signs a profit in dollars too", () => {
    expect(mapAgentDetail(owner("20000000000000000"), lp(), NOW, snapshot).grossPnl.value?.startsWith("+$")).toBe(true);
  });
});

describe("gross PnL measured in the quote (GRID-PNL-QUOTE, 2026-09-11)", () => {
  // USDT/WBNB: the display base is WBNB, so the grid is measured in USDT. The
  // operator's live case: BNB rose ~4.14 % since arm, the grid sold WBNB three
  // times on the way up and its holdings read 0.9746 × budget in WBNB — a loss
  // in WBNB, a gain in USDT, and behind holding BNB.
  const USDT = "0x55d398326f99059ff775485246999027b3197955";
  const POOL = "0x172fcd41e0913e95784454622d1c3724f546f849";
  const ARM_TICK = -65_600, NOW_TICK = -66_006; // token1/token0 = WBNB per USDT: a LOWER tick is a HIGHER BNB price.
  const budget = 100_000_000_000_000_000n; // 0.1 WBNB
  const benchmark = { status: "ready", method: "arm-transaction-post-swap-v1", txHash: `0x${"11".repeat(32)}`, blockHash: `0x${"22".repeat(32)}`, blockNumber: "100", armedAtMs: 1_000, pool: POOL, token0: USDT, token1: WBNB, sqrtPriceX96: getSqrtRatioAtTick(ARM_TICK).toString(), capitalWei: budget.toString() };
  const liveTick = { poolAddress: POOL, tick: NOW_TICK, blockNumber: "200", readAtMs: NOW };
  function usdtGrid(holdingsWei: bigint, overrides: Record<string, unknown> = {}): unknown {
    return {
      data: {
        positions: [],
        sequences: [],
        grid: {
          pool: { token0: USDT, token1: WBNB, fee: 100 }, poolAddress: POOL, wbnbIsToken0: false, tickSpacing: 1,
          buyRange: { tickLower: -66_100, tickUpper: -66_050 }, sellRange: { tickLower: -65_950, tickUpper: -65_900 },
          levels: [], cycles: { available: true, recorded: 0, rows: [], note: "no cycles yet" },
          buffer: { quoteWei: holdingsWei.toString(), baseWei: "0" },
          benchmark,
          ...overrides,
        },
        settingsDigest: "0xabc",
      },
    };
  }
  const priceAt = (tick: number) => 1 / Math.pow(1.0001, tick);
  const bnbReturn = priceAt(NOW_TICK) / priceAt(ARM_TICK) - 1; // ≈ +4.14 %

  it("measures PnL and HODL in USDT: a WBNB loss is a USDT gain behind holding BNB", () => {
    const holdings = (budget * 9_746n) / 10_000n;
    const view = mapAgentDetail(owner(budget.toString()), usdtGrid(holdings), NOW, undefined, undefined, liveTick);
    expect(view.grid.sideInverted).toBe(true);
    expect(view.hodl?.value).toBe(`+${(bnbReturn * 100).toFixed(2)}%`);
    const expectedPct = 0.9746 * (1 + bnbReturn) - 1; // ≈ +1.50 %
    // Percent truncates to hundredths like every other tile.
    expect(view.grossPnlPercent.value).toBe(`+${(Math.floor(expectedPct * 10_000) / 100).toFixed(2)}%`);
    // USDT is a dollar, so the tile reads in $: budget ≈ $73.4 at the arm price.
    const budgetUsd = 0.1 * priceAt(ARM_TICK);
    expect(view.grossPnl.value).toBe(`+$${(expectedPct * budgetUsd).toFixed(2)}`);
    expect(view.grossPnl.bnb).toMatch(/^\+1\.05\d+ USDT$/u);
    expect(view.grossPnl.note).toBe("gross · measured in USDT, budget at the arm price");
    // The same grid in WBNB would have read -2.54 %: that is the figure the operator saw.
    const inWbnb = mapAgentDetail(owner(budget.toString()), { ...(usdtGrid(holdings) as { data: object }), data: { ...(usdtGrid(holdings) as { data: { grid: object } }).data, grid: { ...(usdtGrid(holdings) as { data: { grid: object } }).data.grid, pool: { token0: MUBARAK, token1: WBNB, fee: 2500 }, benchmark: { ...benchmark, token0: MUBARAK } } } }, NOW, undefined, undefined, liveTick);
    expect(inWbnb.grid.sideInverted).toBe(false);
    expect(inWbnb.grossPnlPercent.value).toBe("-2.54%");
  });

  it("dashes with the reason rather than falling back to WBNB when the arm price is missing", () => {
    const view = mapAgentDetail(owner(budget.toString()), usdtGrid(budget, { benchmark: undefined }), NOW, undefined, undefined, liveTick);
    expect(view.grossPnl.value).toBeNull();
    expect(view.grossPnl.reason).toContain("needed to measure in USDT");
    expect(view.grossPnlPercent.value).toBeNull();
  });
});

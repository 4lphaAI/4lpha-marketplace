import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dcaMaxStepBps, dcaNativeReserveWei } from "@/lib/trade";

// Source-text assertions, the `.schedule-controls.test.ts` style: the screen is
// `@ts-nocheck` ported design JSX with no exported internals. AUTO-DCA §14.1 + R2.14/R2.16.
const deploySource = readFileSync(new URL("./DeployAgentScreen.tsx", import.meta.url), "utf8");

describe("Auto DCA form wiring (§14.1)", () => {
  it("floors the base order at 25 USDT in steps of 5, so Total Delegated defaults to 55.00", () => {
    expect(deploySource).toContain('{ k: "dcaBase", label: "Base order size", type: "stepper", v: "25", step: 5, min: 25, suffix: "USDT" }');
    expect(deploySource).toContain('{ k: "dcaOrder", label: "DCA order size", type: "stepper", v: "10", step: 10, min: 10, suffix: "USDT" }');
    expect(deploySource).toContain('{ k: "dcaMaxOrders", label: "Max DCA orders", type: "stepper", v: "3", step: 1, min: 1, max: 8 }');
  });

  it("builds the signed DCA tuple with its fixed fields and pins the unused AI fields", () => {
    const start = deploySource.indexOf("const tradeSettings = id ===");
    const block = deploySource.slice(start, deploySource.indexOf("} satisfies TradeSettings) : null;", start));
    expect(block).toContain('tradeMode: "dca" as const, dcaToken: dcaStock.address, dcaStepBps: Math.round(dcaNum(values.dcaStep) * 100), dcaStepMultiplierBps: 12_000');
    expect(block).toContain("entryWei: tradfiDca ? dcaBaseWei.toString(10)");
    expect(block).toContain("minEntryWei: tradfiDca ? dcaBaseWei.toString(10)");
    expect(block).toContain("capitalQuoteWei: tradfiDca ? dcaCapitalWei.toString(10)");
    expect(block).toContain("crashProtection: !tradfiDca && !tradfiSmart && values.crashProtection !== false");
    expect(block).toContain("cmcNewsEnabled: tradfiSchedule || tradfiDca ? false");
    expect(block).toContain("dcaStopLossBps: values.dcaSlOn ? Math.round(dcaNum(values.dcaSl) * 100) : null");
    expect(deploySource).toContain("dcaBaseWei + dcaOrderWei * BigInt(dcaMaxOrders)");
  });

  it("blocks deploy with the exact copy for every DCA validation rule", () => {
    for (const copy of [
      'return "Price drop step must be between 1 % and 30 %.";',
      "return `With ${dcaMaxOrders} DCA orders the price drop step can be at most ${(dcaMaxStepBps(dcaMaxOrders) / 100).toFixed(2)} %.`;",
      'return "Take profit must be at least 1.5 %.";',
      "if (dcaStock.feeBps === 1 && !(tp >= 1.5)) return `On ${dcaStock.symbol} the take profit must be at least 1.5 %.`;",
      'return "Base order must be at least 25 USDT.";',
      'if (dcaBaseWei < 25n * 10n ** 18n)',
      'return "DCA order must be at least 10 USDT.";',
      'return "Trigger price must be above 0.";',
      'return "Min must be below max.";',
      'return "Stop loss must be between 1 % and 99 %.";',
    ]) expect(deploySource).toContain(copy);
  });

  it("bounds the step stepper by N (D1) and carries the R2.14 / R2.16 help copy", () => {
    expect(deploySource).toContain("dcaStep: { max: dcaMaxStepBps(orders) / 100,");
    expect(deploySource).toContain("...(lowFeeStock ? { dcaTp: { min: 1.5 } } : {}),");
    expect(deploySource).toContain("Orders sit on the pool's price grid, never above the price you set. On 0.25 % pools a level can sit up to 0.5 % deeper than its step.");
    // Operator ruling 2026-09-25: Auto DCA charges no platform fee, so the hint names none.
    expect(deploySource).toContain("dcaTrigger: { hint: `The base order fires when it can fill at or below ${String(values.dcaTrigger ?? \"\")} after slippage.` },");
    expect(deploySource).toContain("Stop loss is measured on your total deposit. With only the base order filled, the stock must fall about ${baseOnlyFall} % to reach a ${stop} % stop; with every DCA order filled, about ${stop} % below your average price.");
  });

  it("mounts the real hire for Live, and the disabled state for Demo (D8)", () => {
    expect(deploySource).not.toContain("Auto DCA is not live yet.");
    expect(deploySource).toContain("Auto DCA runs live only.");
    expect(deploySource).toContain('values.tradfiMode === "dca" && mode === "Demo" ? (');
  });
});

describe("the DCA mirrors in web/lib/trade.ts", () => {
  it("D1's largest step per N, and the signed native cap (2N + 4) × R_DCA", () => {
    expect([1, 2, 3, 4, 5, 8].map(dcaMaxStepBps)).toEqual([3_000, 3_000, 2_472, 1_676, 1_209, 545]);
    expect(dcaNativeReserveWei(4)).toBe(3_840_000_000_000_000n);
    expect(dcaNativeReserveWei(8)).toBe(6_400_000_000_000_000n);
    expect(() => dcaNativeReserveWei(9)).toThrow();
  });
});

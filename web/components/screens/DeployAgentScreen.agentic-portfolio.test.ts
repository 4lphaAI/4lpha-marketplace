import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-text assertions, matching `.agentic-schedule.test.ts`: the screen is `@ts-nocheck` ported design JSX with no exported internals.
const source = readFileSync(new URL("./DeployAgentScreen.tsx", import.meta.url), "utf8");
const modeLine = (id: string) => source.split(/\r?\n/u).find((line) => line.includes(`{ id: "${id}", label:`) && line.includes("RESOURCES.mode"))!;

describe("Agentic Wallet on the TradFi Smart Portfolio mode", () => {
  it("badges the Smart Portfolio tile with the generic tooltip markup, and still not Auto DCA", () => {
    expect(modeLine("smart")).toContain("agenticWallet: agenticEnabled");
    expect(modeLine("dca")).not.toContain("agenticWallet");
    expect(source).toContain("{m.label} supports Agentic Wallet.");
  });

  it("opens the custody pop-up for tradeMode portfolio and hands the pop-up the basket's tickers in the signed row order", () => {
    expect(source).toContain('tradeSettings.tradeMode === "schedule" || tradeSettings.tradeMode === "portfolio") ? (');
    expect(source).toContain("portfolioSymbols={tradfiSmart ? smartRows.map((row) => row.sym) : undefined}");
    // The signed tokens come from the same rows in the same order, and a dca tuple never reaches the Agentic branch.
    expect(source).toContain("portfolioTokens: smartRows.map((row) => spAddress(row.sym).toLowerCase())");
    expect(source).not.toContain('tradeSettings.tradeMode === "dca") ? (');
  });

  it("keeps the Altana hire for every mode: the Altana tuple builder and crash protection rule are untouched", () => {
    expect(source).toContain("showCrashProtection={!tradfiSmart}");
  });
});

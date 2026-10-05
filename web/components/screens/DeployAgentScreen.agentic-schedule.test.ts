import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-text assertions, matching `.schedule-controls.test.ts`: the screen is `@ts-nocheck` ported design JSX with no exported internals.
const source = readFileSync(new URL("./DeployAgentScreen.tsx", import.meta.url), "utf8");
const modeLine = (id: string) => source.split(/\r?\n/u).find((line) => line.includes(`{ id: "${id}", label:`) && line.includes("RESOURCES.mode"))!;

describe("Agentic Wallet on the TradFi Schedule buy mode", () => {
  it("badges the Schedule buy tile like AI Trade, and leaves Auto DCA without it", () => {
    expect(modeLine("sched")).toContain("agenticWallet: agenticEnabled");
    expect(modeLine("ai")).toContain("agenticWallet: agenticEnabled");
    expect(modeLine("dca")).not.toContain("agenticWallet");
    // AGENTIC-PORTFOLIO (spec 4.1) changed this one pin: Smart Portfolio is badged now; Auto DCA is still not.
    expect(modeLine("smart")).toContain("agenticWallet: agenticEnabled");
  });

  it("words the tooltip with the mode's own label", () => {
    expect(source).toContain("{m.label} supports Agentic Wallet.");
    expect(source).not.toContain("AI Trade supports Agentic Wallet.");
  });

  it("opens the custody pop-up for AI Trade, Schedule buy and Smart Portfolio only", () => {
    // AGENTIC-PORTFOLIO (spec 4.2) changed this one pin: Smart Portfolio (tradeMode "portfolio") opens the pop-up too; Auto DCA does not.
    expect(source).toContain('agenticEnabled && preset === "tradfi" && (!tradeSettings.tradeMode || tradeSettings.tradeMode === "schedule" || tradeSettings.tradeMode === "portfolio") ? (');
    // The form's own Agentic values flag still belongs to AI Trade alone.
    expect(source).toContain('agenticEnabled && agenticCustody && id === "trading" && preset === "tradfi" && !tradeSettings?.tradeMode && mode === "Live"');
  });
});

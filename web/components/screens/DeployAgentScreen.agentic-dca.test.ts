import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-text assertions, matching `.agentic-portfolio.test.ts`: the screen is `@ts-nocheck` ported design JSX with no exported internals.
const source = readFileSync(new URL("./DeployAgentScreen.tsx", import.meta.url), "utf8");
const lines = source.split(/\r?\n/u);
/** The Auto DCA tile object: its first line plus the continuation that carries the badge key (the first line stays free of it, the existing pins read that line). */
const dcaTile = (): string => { const at = lines.findIndex((line) => line.includes('{ id: "dca", label:') && line.includes("RESOURCES.mode")); return `${lines[at]}\n${lines[at + 1]}`; };

describe("Agentic Wallet on the TradFi Auto DCA mode", () => {
  it("badges the Auto DCA tile only with both web flags, through the generic badge markup", () => {
    expect(dcaTile()).toContain("agenticWallet: agenticEnabled && agenticDcaEnabled,");
    expect(source).toContain('import { agenticDcaEnabled, agenticEnabled } from "@/lib/agentic";');
    expect(source).toContain("{m.label} supports Agentic Wallet.");
    // The other tiles keep their one-flag badge.
    for (const id of ["ai", "sched", "smart"]) expect(lines.find((line) => line.includes(`{ id: "${id}", label:`) && line.includes("RESOURCES.mode"))).toContain("agenticWallet: agenticEnabled,");
  });

  it("opens the custody pop-up for tradeMode dca only with both flags, and keeps the AI, Schedule and Portfolio condition text intact", () => {
    expect(source).toContain('agenticEnabled && agenticDcaEnabled && preset === "tradfi" && tradeSettings.tradeMode === "dca" || agenticEnabled && preset === "tradfi" && (!tradeSettings.tradeMode');
    expect(source).toContain('agenticEnabled && preset === "tradfi" && (!tradeSettings.tradeMode || tradeSettings.tradeMode === "schedule" || tradeSettings.tradeMode === "portfolio") ? (');
    // The same wiring serves it: one HireTradeDeploy and one AgenticDeployModal.
    expect(source.match(/<AgenticDeployModal /gu)).toHaveLength(1);
    // The form's own Agentic values flag still belongs to AI Trade alone.
    expect(source).toContain('agenticEnabled && agenticCustody && id === "trading" && preset === "tradfi" && !tradeSettings?.tradeMode && mode === "Live"');
  });
});

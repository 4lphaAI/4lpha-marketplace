import { describe, expect, it } from "vitest";
import { AGENTS, agentDeployKind } from "./design-data";

describe("agent deploy routes", () => {
  it("maps all catalogue cards to one of the four public deploy kinds", () => {
    expect(AGENTS.map((agent) => `/deploy/${agentDeployKind(agent)}`)).toEqual([
      "/deploy/grid",
      "/deploy/grid",
      "/deploy/lp",
      "/deploy/lp",
      "/deploy/trading",
      "/deploy/trading",
      "/deploy/trading",
      "/deploy/trading",
      "/deploy/lending",
    ]);
  });

  it("publishes the four current trading agents and retires the legacy cards", () => {
    const tradingNames = AGENTS
      .filter((agent) => agent.categoryId === "trading")
      .map((agent) => agent.name);

    expect(tradingNames).toEqual([
      "AI Stocks Trader",
      "Tradfi Recurring Buy",
      "Auto DCA Agent",
      "Smart Portfolio Agent",
    ]);
    expect(tradingNames).not.toContain("Sigma Trader");
    expect(tradingNames).not.toContain("Vector Trader");
    expect(tradingNames).not.toContain("Degen Trader");
    expect(tradingNames).not.toContain("Atlas Trader");
  });

  it("keeps the Health Guard card copy protocol-neutral", () => {
    expect(AGENTS.find((agent) => agent.id === "health-guard")?.tagline).toBe(
      "Repays your debt from a reserve before liquidation.",
    );
  });
});

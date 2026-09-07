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
});

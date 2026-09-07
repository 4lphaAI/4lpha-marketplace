import { describe, expect, it } from "vitest";
import { modeLabel } from "./HiredAgentScreen";
import type { AgentDetailView } from "@/lib/exec/agent-detail";

/**
 * The tile said "SHIFT" for a grid the owner had just been told runs flips.
 * Both were true: `shift` is the plane's machinery, the flip is what it does
 * once the drift lane is signed off. The label names the behaviour.
 */
const view = (grid: Partial<AgentDetailView["grid"]>) => ({ grid } as unknown as AgentDetailView);

describe("modeLabel", () => {
  it("calls a shift grid with drift disabled what it is: a flip", () => {
    expect(modeLabel(view({ mode: "shift", driftPctOfGap: 0 }))).toBe(" · flip");
  });
  it("keeps 'shift' exactly when the drift lane is live", () => {
    expect(modeLabel(view({ mode: "shift", driftPctOfGap: 60 }))).toBe(" · shift + drift");
    expect(modeLabel(view({ mode: "shift", driftPctOfGap: null }))).toBe(" · shift");
  });
  it("a fixed grid is the flip machine itself", () => {
    expect(modeLabel(view({ mode: "fixed", driftPctOfGap: null }))).toBe(" · flip");
  });
  it("passes any other mode through, and says nothing with no view", () => {
    expect(modeLabel(view({ mode: "ladder", driftPctOfGap: null }))).toBe(" · ladder");
    expect(modeLabel(null)).toBe("");
  });
});

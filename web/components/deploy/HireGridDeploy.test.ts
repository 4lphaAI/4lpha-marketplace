import { describe, expect, it } from "vitest";
import { nextFreeAgentId } from "./HireGridDeploy";

/**
 * The dead end this numbering closes: an agent id is permanent and owner-scoped
 * INCLUDING after the session is revoked, so a fixed slug made a name hireable
 * exactly once and every later hire resumed the tombstone.
 */
describe("nextFreeAgentId", () => {
  it("keeps the plain slug while it is free", () => {
    expect(nextFreeAgentId("grid-agent-01", [])).toBe("grid-agent-01");
    expect(nextFreeAgentId("grid-agent-01", ["other-agent"])).toBe("grid-agent-01");
  });

  it("numbers from 2 upward, one per collision", () => {
    expect(nextFreeAgentId("grid-agent-01", ["grid-agent-01"])).toBe("grid-agent-01-2");
    expect(nextFreeAgentId("grid-agent-01", ["grid-agent-01", "grid-agent-01-2"])).toBe("grid-agent-01-3");
    expect(nextFreeAgentId("grid-agent-01", ["grid-agent-01", "grid-agent-01-2", "grid-agent-01-3"])).toBe("grid-agent-01-4");
  });

  it("fills a gap rather than always appending", () => {
    expect(nextFreeAgentId("g", ["g", "g-3", "g-4"])).toBe("g-2");
  });

  it("counts a revoked name as taken — that is the whole point", () => {
    // The caller passes the owner's own list, which includes revoked rows.
    expect(nextFreeAgentId("grid-agent-01", ["grid-agent-01"])).not.toBe("grid-agent-01");
  });

  it("refuses rather than looping when a thousand names collide", () => {
    const taken = ["g", ...Array.from({ length: 998 }, (_, index) => `g-${index + 2}`)];
    expect(() => nextFreeAgentId("g", taken)).toThrow(/rename/iu);
  });
});

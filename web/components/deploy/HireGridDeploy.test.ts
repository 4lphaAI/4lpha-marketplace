import { describe, expect, it, vi } from "vitest";
import { armGridAgent } from "./GridLiveDeploy";
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

const armBase = {
  agentId: "grid-agent-01",
  pool: {
    pool: "0x4444444444444444444444444444444444444444",
    token0: "0x5555555555555555555555555555555555555555",
    token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    token0Symbol: "USDT",
    token1Symbol: "WBNB",
    fee: 100,
    tick: 0,
    tvlUsd: null,
    volume24hUsd: null,
    token0Icon: null,
    token1Icon: null,
    wbnbIsToken0: false,
    staleness: null,
  },
  uiPresetId: "balanced",
  capitalBnb: "1",
  stopLossPct: 0,
  takeProfitPct: 0,
  hireProfile: "grid-shift-v1" as const,
  signEnvelope: vi.fn(async () => ({})),
};

describe("armGridAgent shift guards", () => {
  for (const deployPctBps of [2_500, 3_250, 5_500]) {
    it(`refuses utilization ${deployPctBps} before fetch or signature`, async () => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      try {
        await expect(armGridAgent({ ...armBase, deployPctBps })).rejects.toThrow("Capital utilization must be a whole 5% step between 30% and 50%.");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(armBase.signEnvelope).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  for (const shiftsPerDay of [0, 17, 8.5]) {
    it(`refuses ${shiftsPerDay} requotes daily before fetch or signature`, async () => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      try {
        await expect(armGridAgent({ ...armBase, shiftsPerDay })).rejects.toThrow("Max requotes daily must be a whole number between 1 and 16.");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(armBase.signEnvelope).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  it("refuses value-based exits before fetch or signature", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(armGridAgent({ ...armBase, takeProfitPct: 6 })).rejects.toThrow("This grid model closes rungs on price crossings, not on a % target. Turn Take profit and Stop loss off to deploy.");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(armBase.signEnvelope).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

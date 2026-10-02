// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradeSimulationRow } from "@/lib/exec/types";
import { RunLogPanel, TradeSimulationLog } from "./TradeSimulationLog";

const STOCK = "0x1111111111111111111111111111111111111111";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const base: TradeSimulationRow = {
  createdAt: 1_790_000_000_000, journalKind: "trade", exposure: "reduce", route: "guard", outcome: "success", reason: null, blocked: false,
  bareRevert: false, failReason: null, latencyMs: 124, upstreamMs: 110, outputToken: USDT, token: STOCK, predictionKind: "swap-output",
  minOutAtomic: "9900000000000000000", predictedOutAtomic: "10000000000000000000", actualOutAtomic: "10000000000000000000",
  actualTxHash: `0x${"22".repeat(32)}`, journalState: "COMMITTED", journalTxHash: `0x${"22".repeat(32)}`,
};

describe("TradeSimulationLog", () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

  it("reads the BFF on open and renders a passed sell, a blocked buy and a not-simulated row", async () => {
    const rows: TradeSimulationRow[] = [
      base,
      { ...base, exposure: "increase", route: "direct", outcome: "reverted", blocked: true, bareRevert: true, failReason: "execution reverted: STF",
        outputToken: STOCK, predictedOutAtomic: null, actualOutAtomic: null, actualTxHash: null, journalState: "ROLLED_BACK", journalTxHash: null },
      { ...base, outcome: "not-simulated", reason: "timeout", latencyMs: null, predictedOutAtomic: null, actualOutAtomic: null, actualTxHash: null, journalState: "COMMITTED" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { rows, unavailable: null } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<TradeSimulationLog agentId="trade.agent:1" readHeaders={{ "x-owner-action": "signed" }} symbols={{ [STOCK]: "NVDAB" }} />); });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agents/trade.agent%3A1/trade/simulations");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ "x-owner-action": "signed" });
    const lines = [...host.querySelectorAll(".fl-portfolio-row")].map((row) => [...row.children].map((cell) => cell.textContent));
    expect(lines[0]?.slice(1)).toEqual(["Sell", "NVDAB", "Guard", "Passed", "10 USDT", "10 USDT", "0.0000%", "124 ms", "-"]);
    expect(lines[1]?.slice(1)).toEqual(["Buy", "NVDAB", "Direct", "Blocked", "-no prediction", "-blocked, not submitted", "-no prediction", "124 ms", "execution reverted: STF"]);
    expect(lines[2]?.slice(1, 9)).toEqual(["Sell", "NVDAB", "Guard", "Not simulated (timeout)", "-no prediction", "-not recorded", "-no prediction", "-not measured"]);
    await act(async () => { root.unmount(); });
  });
  it("puts the simulation log inside the Run log tab behind a Runs | Simulate toggle", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<RunLogPanel runLog={<p>runs-view</p>} simulationLog={<p>simulate-view</p>} />); });
    expect(host.textContent).toContain("runs-view");
    expect(host.textContent).not.toContain("simulate-view");
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Simulate");
    await act(async () => { button?.click(); });
    expect(host.textContent).toContain("simulate-view");
    await act(async () => { root.render(<RunLogPanel runLog={<p>runs-only</p>} />); });
    expect(host.querySelectorAll("button")).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });
});

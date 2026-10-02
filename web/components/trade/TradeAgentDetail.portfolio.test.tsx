// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentDetailView, DetailMetric } from "@/lib/exec/agent-detail";
import type { TradeSettings, TradeView } from "@/lib/trade";
import { TradeAgentDetail } from "./TradeAgentDetail";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const metric = (): DetailMetric => ({ value: null, reason: "unavailable" });
const view = { id: "portfolio-agent", status: "armed", httpRuntimeProfile: "trade-v1", hireSizingName: "trade-v1",
  walletAddress: "0x3333333333333333333333333333333333333333", sessionPublicKey: `0x${"44".repeat(64)}`,
  sessionExpiresAt: Math.floor(Date.now() / 1000) + 86400, provisioning: false, actionDisabledReason: null, armMs: 1000,
  dailyNativeLimit: metric(), recordedCycleDelta: metric(), grossPnl: metric(), grossPnlPercent: metric(),
  recordedCycles: metric(), levels: [], cycleHistoryAvailable: false, cycleNote: "unavailable", gas: null,
  motions: [], sequences: [], positions: [] } as unknown as AgentDetailView;
const settings: TradeSettings = { name: "Smart Portfolio", executionModel: "tradfi", settlementAsset: "USDT", tradeMode: "portfolio",
  entryWei: "50000000000000000000", minEntryWei: "1000000000000000000", capitalQuoteWei: "50000000000000000000",
  maxOpenPositions: 1, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null,
  stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard",
  instructions: null, skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b",
  crashProtection: false, cmcNewsEnabled: false, portfolioTokens: [A, B], portfolioWeightsBps: [5000, 5000],
  portfolioDriftBps: 500, portfolioIntervalSec: 86400 };
const portfolio: NonNullable<TradeView["portfolio"]> = {
  tokens: [A, B].map((token, index) => ({ token, symbol: index ? "MSFTB" : "NVDAB", targetBps: 5000,
    balanceAtomic: "1000000000000000000", valueWei: "25000000000000000000", valueReason: null,
    weightBps: 5000, driftBps: 0, displayName: index ? "Microsoft" : "NVIDIA",
    initial: { quantityAtomic: null, quantityReason: "not-recorded", quoteWei: null, quoteReason: "not-verified" } })),
  capitalQuoteWei: settings.capitalQuoteWei!, netInvestedWei: "50000000000000000000", cashCapWei: "0",
  walletUsdtWei: "0", portfolioCashWei: "0", idleUsdtWei: "0", stockValueWei: "50000000000000000000",
  totalValueWei: "50000000000000000000", pnlWei: "0", driftBps: 0, intervalSec: 86400, anchorMs: 1000,
  currentSlot: 0, nextCheckAtMs: Date.now() + 3600000, check: null, legs: [] };
const trade: TradeView = { settings, portfolio, open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: true, holidaysModeled: false },
  summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null,
    closedTrades: 0, openPositions: 0, maxOpenPositions: 0, observedAt: null },
  lifecycle: { draining: false, drainingAt: null }, pendingIntents: [] };

describe("Smart Portfolio shared hero and actions", () => {
  it("keeps the five metrics through slippage-only editing and wires actions and icon lookup", async () => {
    const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ data: { [A]: "/a.png", [B]: "/b.png", [USDT]: "/usdt.png" } }), url }));
    vi.stubGlobal("fetch", fetch);
    const pause = vi.fn(), remove = vi.fn(), save = vi.fn(async () => undefined), go = vi.fn();
    const host = document.createElement("div"), root = createRoot(host);
    const props = { agentId: view.id, view, trade, busy: false, removed: false, message: "", signedOut: false,
      identityStatus: <span>ERC-8004 #fixture</span>, go, signIn: async () => undefined, refresh: async () => undefined,
      togglePause: pause, remove, sellNow: () => undefined, saveSettings: save };
    try {
      await act(async () => { root.render(<TradeAgentDetail {...props} />); await Promise.resolve(); });
      expect(host.textContent).toContain("Smart Portfolio · 2 bStocks");
      expect(host.textContent).toContain("portfolio-agent");
      expect(host.textContent).toContain("ERC-8004 #fixture");
      expect(host.querySelectorAll(".fl-trade-metric")).toHaveLength(5);
      expect(fetch.mock.calls[0]?.[0]).toContain(USDT);
      expect(host.querySelector('img[src="/a.png"]')).not.toBeNull();
      expect(host.querySelector('img[src="/usdt.png"]')).not.toBeNull();
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Edit")!.click(); });
      expect(host.querySelectorAll(".fl-trade-metric")).toHaveLength(5);
      expect(host.textContent).toContain("Slippage tolerance");
      expect(host.textContent).not.toContain("Target weights");
      expect(host.textContent).not.toContain("Auto-invest new deposits");
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click(); });
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Pause")!.click(); });
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Remove")!.click(); });
      expect(pause).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });

  it("shows the portfolio unavailable state without generic trade tabs", async () => {
    const host = document.createElement("div"), root = createRoot(host);
    const props = { agentId: view.id, view, trade: { ...trade, portfolio: undefined }, busy: false, removed: false,
      message: "", signedOut: false, go: () => undefined, signIn: async () => undefined, refresh: async () => undefined,
      togglePause: () => undefined, remove: () => undefined, sellNow: () => undefined, saveSettings: async () => undefined };
    try {
      await act(async () => { root.render(<TradeAgentDetail {...props} />); });
      expect(host.textContent).toContain("Portfolio unavailable");
      expect(host.textContent).not.toContain("Open Positions");
    } finally { await act(async () => root.unmount()); }
  });
});

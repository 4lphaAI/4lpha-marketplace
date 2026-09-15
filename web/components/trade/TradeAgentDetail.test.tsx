// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentDetailView, DetailMetric } from "@/lib/exec/agent-detail";
import type { TradeSettings, TradeView } from "@/lib/trade";
import { TradeAgentDetail, noLimitNote } from "./TradeAgentDetail";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const metric = (reason: string): DetailMetric => ({ value: null, reason });

function view(over: Partial<AgentDetailView> = {}): AgentDetailView {
  return {
    id: "trading-agent-01", status: "armed", httpRuntimeProfile: "trade-v1", hireSizingName: "trade-v1",
    walletAddress: "0x2222222222222222222222222222222222222222", sessionPublicKey: `0x${"33".repeat(64)}`, sessionExpiresAt: null,
    provisioning: false, actionDisabledReason: null, armMs: 1_000,
    dailyNativeLimit: metric("— session limit unavailable"), recordedCycleDelta: metric("— not a grid agent"),
    grossPnl: metric("— not a grid agent"), grossPnlPercent: metric("— not a grid agent"), recordedCycles: metric("— not a grid agent"),
    levels: [], cycleHistoryAvailable: false, cycleNote: "— not a grid agent", gas: null, motions: [], sequences: [], positions: [],
    ...over,
  } as AgentDetailView;
}

function settings(over: Partial<TradeSettings> = {}): TradeSettings {
  return {
    name: "Trading Agent 01", executionModel: "blue-chip", entryWei: "2000000000000000", maxOpenPositions: 4,
    minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: true, takeProfitBps: 2_000, stopLossBps: 2_500, maxHoldSec: null,
    breakEvenAfterTp: false, slippageBps: 300, gasPriority: "standard", instructions: null, skillMarkdown: null,
    primaryModel: "glm-5.3-flash", fallbackModel: "0gm-1.0-35b-a3b", ...over,
  };
}

function trade(open = 0, over: Partial<TradeView> = {}): TradeView {
  const position = (index: number): TradeView["open"][number] => ({
    positionId: `p${index}`, token: `0x${(index + 1).toString(16).padStart(40, "0")}`, route: { hops: [], fees: [] }, entryWei: "9800000000000000",
    tokenAmount: "1", fillStatus: "verified", openedAt: NOW - 5 * 86_400_000, entryTxHash: null, status: "open", pnlBps: "-150", exitRequestedAt: null,
    orphanedAt: null, closedAt: null, exitWei: null, exitTxHash: null, soldTokenAmount: null, exitFillStatus: null, closeReason: null, refusalText: null, observation: null,
  });
  return {
    settings: settings(), open: Array.from({ length: open }, (_, index) => position(index)), closed: [], runs: [], pinned: [],
    marketHours: { usEquitiesOpen: false, holidaysModeled: false },
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: open, maxOpenPositions: 4, observedAt: null },
    lifecycle: { draining: false, drainingAt: null }, pendingIntents: [], ...over,
  };
}

function props(v: AgentDetailView, t: TradeView) {
  return {
    agentId: v.id, view: v, trade: t, busy: false, removed: false, message: "", signedOut: false,
    go: () => undefined, signIn: async () => undefined, refresh: async () => undefined, togglePause: () => undefined,
    remove: () => undefined, hardRevoke: () => undefined, sellNow: () => undefined, saveSettings: async () => undefined,
  };
}

describe("the Edit panel tells the truth about \"no time limit\" (2026-09-15)", () => {
  it("phrases the consequence from the thresholds the way the worker behaves", () => {
    expect(noLimitNote({ takeProfitBps: 2_000, stopLossBps: 2_500 })).toBe("No time limit — positions exit only on take profit or stop loss.");
    expect(noLimitNote({ takeProfitBps: 2_000, stopLossBps: null })).toBe("No time limit — positions exit only on take profit, or when the model says so.");
    expect(noLimitNote({ takeProfitBps: null, stopLossBps: 2_500 })).toBe("No time limit — positions exit only on stop loss, or when the model says so.");
    expect(noLimitNote({ takeProfitBps: null, stopLossBps: null })).toBe("No time limit — positions exit only when the model says so.");
  });

  it("shows an unticked box and the note for a null hold, and a stepper once ticked — never \"120 min\" over no limit", async () => {
    const host = document.createElement("div"), root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    try {
      await act(async () => root.render(<TradeAgentDetail {...props(view(), trade())} />));
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Edit")!.click(); });
      const hold = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Max holding time"))!;
      expect(hold.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
      expect(hold.textContent).toContain("No time limit — positions exit only on take profit or stop loss.");
      expect(hold.querySelector('input[type="number"]')).toBeNull();
      await act(async () => { hold.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
      expect(hold.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("120");
      expect(hold.textContent).not.toContain("No time limit");
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
});

describe("the session clock on the trade page (2026-09-15)", () => {
  async function render(v: AgentDetailView, t: TradeView): Promise<{ readonly host: HTMLDivElement; readonly done: () => Promise<void> }> {
    const host = document.createElement("div"), root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    await act(async () => root.render(<TradeAgentDetail {...props(v, t)} />));
    return { host, done: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); } };
  }

  it("says nothing extra while the session has days left", async () => {
    const { host, done } = await render(view({ sessionExpiresAt: Math.floor(Date.now() / 1_000) + 5 * 86_400 }), trade(4));
    try {
      expect(host.querySelector('[data-session-expiry="ok"]')?.textContent).toMatch(/^Session · 4d 23h$|^Session · 5d$/u);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.querySelector(".fl-status")?.textContent).toBe("Live");
    } finally { await done(); }
  });

  it("warns under a day when positions are open, and stays quiet when there is nothing to strand", async () => {
    const soon = Math.floor(Date.now() / 1_000) + 6 * 3_600;
    const withPositions = await render(view({ sessionExpiresAt: soon }), trade(4));
    try {
      expect(withPositions.host.querySelector('[data-session-expiry="soon"]')?.textContent).toMatch(/^Expires in 5h 59m$|^Expires in 6h$/u);
      expect(withPositions.host.querySelector('[role="alert"]')?.textContent).toMatch(/^Session ends in 5h 59m\. Exits stop working after that|^Session ends in 6h\. Exits stop working after that/u);
      expect(withPositions.host.querySelector(".fl-status")?.textContent).toBe("Live");
    } finally { await withPositions.done(); }
    const empty = await render(view({ sessionExpiresAt: soon }), trade(0));
    try {
      expect(empty.host.querySelector('[data-session-expiry="soon"]')).not.toBeNull();
      expect(empty.host.querySelector('[role="alert"]')).toBeNull();
    } finally { await empty.done(); }
  });

  it("stops calling an armed agent Live once the session is dead, and says what to do", async () => {
    const { host, done } = await render(view({ sessionExpiresAt: Math.floor(Date.now() / 1_000) - 60 }), trade(4));
    try {
      expect(host.querySelector(".fl-status")?.textContent).toBe("expired");
      expect(host.querySelector(".fl-status")?.className).toContain("fl-status--danger");
      expect(host.querySelector('[data-session-expiry="expired"]')?.textContent).toBe("Session expired");
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("Session expired. The agent can no longer trade or exit its 4 open positions; withdraw tokens from Account → Withdraw, then remove this agent and hire again.");
    } finally { await done(); }
  });

  it("does not paint a paused or revoked agent as expired-live, and shows no clock without a session", async () => {
    const paused = await render(view({ status: "paused", sessionExpiresAt: Math.floor(Date.now() / 1_000) - 60 }), trade(0));
    try {
      expect(paused.host.querySelector(".fl-status")?.textContent).toBe("Paused");
      expect(paused.host.querySelector('[data-session-expiry="expired"]')).not.toBeNull();
    } finally { await paused.done(); }
    const none = await render(view({ sessionExpiresAt: null }), trade(0));
    try {
      expect(none.host.querySelector("[data-session-expiry]")).toBeNull();
      expect(none.host.querySelector(".fl-status")?.textContent).toBe("Live");
    } finally { await none.done(); }
  });
});

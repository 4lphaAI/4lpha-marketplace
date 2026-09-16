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
    dailyNativeLimit: metric("â€” session limit unavailable"), recordedCycleDelta: metric("â€” not a grid agent"),
    grossPnl: metric("â€” not a grid agent"), grossPnlPercent: metric("â€” not a grid agent"), recordedCycles: metric("â€” not a grid agent"),
    levels: [], cycleHistoryAvailable: false, cycleNote: "â€” not a grid agent", gas: null, motions: [], sequences: [], positions: [],
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
    expect(noLimitNote({ takeProfitBps: 2_000, stopLossBps: 2_500 })).toBe("No time limit — the model decides when to exit; take profit or stop loss still apply.");
    expect(noLimitNote({ takeProfitBps: 2_000, stopLossBps: null })).toBe("No time limit — the model decides when to exit; take profit still apply.");
    expect(noLimitNote({ takeProfitBps: null, stopLossBps: 2_500 })).toBe("No time limit — the model decides when to exit; stop loss still apply.");
    expect(noLimitNote({ takeProfitBps: null, stopLossBps: null })).toBe("No time limit — the model decides when to exit.");
  });

  it("shows an unticked box and the note for a null hold, and a stepper once ticked — never \"120 min\" over no limit", async () => {
    const host = document.createElement("div"), root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    try {
      await act(async () => root.render(<TradeAgentDetail {...props(view(), trade())} />));
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Edit")!.click(); });
      const hold = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Max holding time"))!;
      expect(hold.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
      expect(hold.textContent).toContain("No time limit — the model decides when to exit; take profit or stop loss still apply.");
      expect(hold.querySelector('input[type="number"]')).toBeNull();
      await act(async () => { hold.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
      expect(hold.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("120");
      expect(hold.textContent).not.toContain("No time limit");
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });

  it("round-trips crash protection in the edit panel and renders the automatic labels", async () => {
    const host = document.createElement("div"), root = createRoot(host);
    let saved: TradeSettings | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    try {
      const t = trade(0, { settings: settings({ crashProtection: true }), closed: [{
        positionId: "closed", token: "0x0000000000000000000000000000000000000001", route: { hops: [], fees: [] },
        entryWei: "100", tokenAmount: "100", fillStatus: "verified", openedAt: NOW - 1_000, entryTxHash: null,
        status: "closed", pnlBps: null, exitRequestedAt: null, orphanedAt: null, closedAt: NOW, exitWei: null,
        exitTxHash: null, soldTokenAmount: null, exitFillStatus: "unverified", closeReason: "crash-stop",
        closeNote: "quote -60% vs last reading", refusalText: null, observation: null,
      }] });
      const p = { ...props(view(), t), saveSettings: async (next: TradeSettings) => { saved = next; } };
      await act(async () => root.render(<TradeAgentDetail {...p} />));
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Edit")!.click(); });
      const crash = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Crash protection"))!;
      const checkbox = crash.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(checkbox.checked).toBe(true);
      await act(async () => { checkbox.click(); });
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Save")!.click(); });
      expect((saved as TradeSettings | null)?.crashProtection).toBe(false);
      await act(async () => root.render(<TradeAgentDetail {...p} />));
      await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Closed Positions")!.click(); });
      expect(host.textContent).toContain("crash stop");
      expect(host.textContent).not.toContain("crash-stop");
      expect(host.textContent).toContain("quote -60% vs last reading");
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
      expect(withPositions.host.querySelector('[role="alert"]')?.textContent).toMatch(/^Session ends in (5h 59m|6h) — sell open positions before then, or remove the agent\.$/u);
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
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("Session expired — the agent can't trade or sell. Withdraw tokens from Account, or hire again.");
      expect(host.textContent).not.toContain("Hard revoke");
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

describe("the compact tiles (operator, 2026-09-16)", () => {
  async function render(v: AgentDetailView, t: TradeView): Promise<{ readonly host: HTMLDivElement; readonly done: () => Promise<void> }> {
    const host = document.createElement("div"), root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    await act(async () => root.render(<TradeAgentDetail {...props(v, t)} />));
    return { host, done: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); } };
  }
  it("shows the gross percent over the delegated cap and none of the retired subtitles", async () => {
    const { host, done } = await render(
      view({ dailyNativeLimit: { value: "0.05 BNB", reason: null, bnb: "0.05 BNB", rawWei: "50000000000000000" } }),
      trade(1, { summary: { grossDeltaWei: "1250000000000000", grossComplete: true, grossReason: null, wins: 1, winRateBps: 5_000, closedTrades: 2, openPositions: 1, maxOpenPositions: 4, observedAt: null } }),
    );
    try {
      expect(host.textContent).toContain("+2.5%");
      for (const gone of ["24h spend authority", "slots free", "relay costs excluded", "Hard revoke", "Account recovery"]) expect(host.textContent).not.toContain(gone);
    } finally { await done(); }
  });

  it("falls back to the BNB amount, never $0.00, when the delegated tile carries no fresh USD price", async () => {
    const { host, done } = await render(
      view({ dailyNativeLimit: { value: "0.05 BNB", reason: null, bnb: "0.05 BNB", rawWei: "50000000000000000" } }),
      trade(0, { summary: { grossDeltaWei: "-1075000000000000", grossComplete: true, grossReason: null, wins: 1, winRateBps: 2_500, closedTrades: 4, openPositions: 0, maxOpenPositions: 4, observedAt: null } }),
    );
    try {
      expect(host.textContent).not.toContain("$0.00");
      expect(host.textContent).toContain("BNB");
      expect(host.textContent).toContain("-2.15%");
    } finally { await done(); }
  });
});

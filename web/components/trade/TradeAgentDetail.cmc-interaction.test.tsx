// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailView, DetailMetric } from "@/lib/exec/agent-detail";
import type { OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { StoredPasskey } from "@/lib/exec/passkey";
import type { TradeSettings, TradeView } from "@/lib/trade";
import { runCmcContinuation } from "@/lib/altana/cmc-continuation";
import { GridDeployRun } from "@/lib/altana/grid-hire-recovery";

const executeCmcBudgetCalls = vi.hoisted(() => vi.fn(async () => ({ status: "CONFIRMED" as const, callsId: `0x${"44".repeat(32)}` as `0x${string}` })));
const validateCmcBudgetCallPlan = vi.hoisted(() => vi.fn(() => []));
vi.mock("@/lib/altana/cmc-budget", () => ({
  executeCmcBudgetCalls,
  validateCmcBudgetCallPlan,
}));

import { TradeAgentDetail } from "./TradeAgentDetail";

const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const SESSION = `0x04${"33".repeat(64)}`;
const metric = (reason: string): DetailMetric => ({ value: null, reason });

function view(): AgentDetailView {
  return {
    id: "tradfi-agent", status: "armed", httpRuntimeProfile: "trade-v1", hireSizingName: "trade-v1", walletAddress: WALLET,
    sessionPublicKey: SESSION, sessionExpiresAt: Math.floor(Date.now() / 1_000) + 86_400, provisioning: false, actionDisabledReason: null,
    armMs: 1_000, dailyNativeLimit: metric("unavailable"), recordedCycleDelta: metric("unavailable"), grossPnl: metric("unavailable"),
    grossPnlPercent: metric("unavailable"), recordedCycles: metric("unavailable"), levels: [], cycleHistoryAvailable: false,
    cycleNote: "unavailable", gas: null, motions: [], sequences: [], positions: [],
  } as unknown as AgentDetailView;
}

function settings(): TradeSettings {
  return {
    name: "TradFi Agent", executionModel: "tradfi", settlementAsset: "USDT", entryWei: "20000000000000000000", minEntryWei: "5000000000000000000",
    capitalQuoteWei: "63000000000000000000", cmcNewsEnabled: true, cmcTotalBudgetWei: "2000000000000000000", maxOpenPositions: 3,
    minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: true, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
    breakEvenAfterTp: false, slippageBps: 300, gasPriority: "standard", instructions: null, skillMarkdown: null,
    primaryModel: "glm-5.3-flash", fallbackModel: "0gm-1.0-35b-a3b",
  };
}

function trade(over: Partial<TradeView> = {}): TradeView {
  return {
    settings: settings(), open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: 3, observedAt: null },
    lifecycle: { draining: false, drainingAt: null }, pendingIntents: [], ...over,
  };
}

function owner(signEnvelope: ReturnType<typeof vi.fn>, walletAddress = WALLET) {
  return {
    ownerAddress: OWNER, passkey: { walletAddress } as StoredPasskey,
    signEnvelope: signEnvelope as unknown as (action: string, agentId: string, params: unknown) => Promise<OwnerActionEnvelope>,
    signReadHeader: vi.fn(async () => "read-header"),
  };
}

function renderPage(over: { readonly budget?: TradeView["cmcBudget"]; readonly owner?: ReturnType<typeof owner> } = {}, confirmStatuses: number[] = [200]) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const signEnvelope = vi.fn(async (_action: string, _agentId: string, params: unknown) => ({ signed: "signed", params }));
  const currentOwner = over.owner ?? owner(signEnvelope);
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/trade/cmc-budget/attempt")) { calls.push("attempt"); return { ok: true, status: 200, json: async () => ({ data: {} }) }; }
    if (url.includes("/trade/cmc-budget/confirm")) {
      calls.push("confirm");
      const status = confirmStatuses.shift() ?? 200;
      return { ok: status === 200, status, json: async () => status === 200 ? ({ data: {} }) : ({ error: { code: "pending" } }) };
    }
    if (url.endsWith("/trade/cmc-budget")) {
      calls.push("prepare");
      const body = JSON.parse(String(init?.body ?? "{}")) as { readonly params?: { readonly operationId?: string } };
      const operationId = body.params?.operationId ?? "op-1";
      return { ok: true, status: 200, json: async () => ({ data: { operationId, operation: { operationId }, calls: [] } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  }));
  const props = {
    agentId: "tradfi-agent", view: view(), trade: trade({ cmcBudget: over.budget ?? { asset: "USDT", decimals: 18, generation: 0, authorizedTotalWei: "0", settledWei: "0", reservedWei: "0", remainingWei: "0", status: "setup-required", reason: "budget_setup_required", pendingOperationId: null } }),
    busy: false, removed: false, message: "", signedOut: false, go: () => undefined, signIn: async () => undefined,
    refresh: async () => undefined, togglePause: () => undefined, remove: () => undefined, sellNow: () => undefined,
    saveSettings: async () => undefined, cmcOwner: currentOwner,
  };
  return { host, root, calls, signEnvelope, props };
}

beforeEach(() => {
  executeCmcBudgetCalls.mockClear();
  validateCmcBudgetCallPlan.mockClear();
  window.localStorage.clear();
});

describe("CMC budget rendered interactions", () => {
  it.each(["budget refresh", "renewal completion"])("resumes a cancelled renewal operation in an open CMC tab after %s", async trigger => {
    const budget = { asset: "USDT", decimals: 18, generation: 2, authorizedTotalWei: "2000000000000000000", settledWei: "0", reservedWei: "0", remainingWei: "2000000000000000000", status: "setup-required", reason: "session_rebind_required", pendingOperationId: null } as const;
    const rendered = renderPage({ budget });
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    expect(rendered.host.textContent).toContain("Rebind data access");
    expect(rendered.host.textContent).not.toContain("Resume data setup");
    const prepared = { operationId: "renew-op", continuationAttemptId: "renew-attempt", state: "prepared", calls: [], operation: { expectedGeneration: 2 } };
    executeCmcBudgetCalls.mockRejectedValueOnce(new DOMException("Cancelled", "NotAllowedError"));
    const run = new GridDeployRun();
    const bound = await runCmcContinuation({ agentId: "tradfi-agent", header: { name: "x-renew-action", value: "encoded-renew" }, expectedMode: "rebind",
      ownerAddress: OWNER, wallet: WALLET, passkey: rendered.props.cmcOwner.passkey,
      sessionPublicKey: SESSION as `0x${string}`, sessionExpiry: rendered.props.view.sessionExpiresAt!, incrementWei: "0", run, check: () => run.check(),
      requestJson: async () => ({ response: new Response(JSON.stringify({ data: prepared })), payload: { data: prepared } }),
      preparing: () => undefined, executing: () => undefined });
    expect(bound).toBe(false);
    const updated = trigger === "budget refresh"
      ? { ...rendered.props, trade: { ...rendered.props.trade, cmcBudget: { ...budget, status: "pending" as const, pendingOperationId: "renew-op" } } }
      : { ...rendered.props, renewalStatus: <span data-session-renew="done">Session renewed.</span> };
    await act(async () => rendered.root.render(<TradeAgentDetail {...updated} />));
    expect(rendered.host.textContent).toContain("Resume data setup");
    expect([...rendered.host.querySelectorAll("button")].some(button => button.textContent === "Rebind data access")).toBe(false);
    await act(async () => { [...rendered.host.querySelectorAll("button")].find(button => button.textContent === "Resume data setup")!.click(); });
    const params = rendered.signEnvelope.mock.calls[0]![2] as { operationId: string; mode: string; additionalBudgetWei: string };
    expect(params.operationId).toBe("renew-op");
    expect(params.mode).toBe("rebind");
    expect(params.additionalBudgetWei).toBe("0");
    expect(rendered.calls).toEqual(["attempt", "prepare", "attempt", "confirm"]);
    const attempts = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/attempt"));
    expect(attempts.map(([, init]) => JSON.parse(String(init?.body)) as unknown)).toEqual([
      { operationId: "renew-op", attemptId: "renew-attempt" }, { operationId: "renew-op", attemptId: "renew-attempt" },
    ]);
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();
  });
  it("validates the prepared plan, records attempt, prompts once, and confirms in order", async () => {
    const rendered = renderPage();
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    await act(async () => { [...rendered.host.querySelectorAll("button")].find((button) => button.textContent === "Set up data budget")!.click(); await Promise.resolve(); });
    expect(validateCmcBudgetCallPlan).toHaveBeenCalledTimes(1);
    expect(rendered.calls).toEqual(["prepare", "attempt", "confirm"]);
    expect(executeCmcBudgetCalls).toHaveBeenCalledTimes(1);
    expect(rendered.signEnvelope).toHaveBeenCalledTimes(1);
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();
  });

  it("exposes zero-increment rebind after renewal and signs the rebind mode", async () => {
    const rendered = renderPage({ budget: { asset: "USDT", decimals: 18, generation: 2, authorizedTotalWei: "2000000000000000000", settledWei: "0", reservedWei: "0", remainingWei: "2000000000000000000", status: "setup-required", reason: "session_changed", pendingOperationId: null } });
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    await act(async () => { [...rendered.host.querySelectorAll("button")].find((button) => button.textContent === "Rebind data access")!.click(); await Promise.resolve(); });
    const params = rendered.signEnvelope.mock.calls[0]?.[2] as { readonly mode?: string; readonly additionalBudgetWei?: string };
    expect(params.mode).toBe("rebind");
    expect(params.additionalBudgetWei).toBe("0");
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();
  });

  it("ignores a double click while the owner operation is in flight", async () => {
    const rendered = renderPage();
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    const button = [...rendered.host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Set up data budget")!;
    await act(async () => { button.click(); button.click(); await Promise.resolve(); });
    expect(rendered.signEnvelope).toHaveBeenCalledTimes(1);
    expect(validateCmcBudgetCallPlan).toHaveBeenCalledTimes(1);
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();
  });

  it("resumes a delayed confirmation after reload without signing or resubmitting calls", async () => {
    const key = `4lpha:cmc-budget:${OWNER.toLowerCase()}:${WALLET.toLowerCase()}:tradfi-agent`;
    window.localStorage.setItem(key, JSON.stringify({ version: 1, ownerAddress: OWNER, walletAddress: WALLET, agentId: "tradfi-agent", operationId: "op-1", attemptId: "attempt-1", callsId: `0x${"44".repeat(32)}`, mode: "topup", expectedGeneration: 0, incrementWei: "2000000000000000000", sessionPublicKey: SESSION, sessionExpiry: Math.floor(Date.now() / 1_000) + 86_400 }));
    const budget = { asset: "USDT", decimals: 18, generation: 0, authorizedTotalWei: "2000000000000000000", settledWei: "0", reservedWei: "0", remainingWei: "0", status: "pending", reason: null, pendingOperationId: "op-1" } as const;
    const rendered = renderPage({ budget }, [409]);
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    await act(async () => { [...rendered.host.querySelectorAll("button")].find((button) => button.textContent === "Confirm pending data setup")!.click(); await Promise.resolve(); });
    expect(rendered.calls).toEqual(["confirm"]);
    expect(rendered.signEnvelope).not.toHaveBeenCalled();
    expect(executeCmcBudgetCalls).not.toHaveBeenCalled();
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();

    const resumed = renderPage({ budget }, [200]);
    await act(async () => resumed.root.render(<TradeAgentDetail {...resumed.props} />));
    await openCmcTab(resumed.host);
    await act(async () => { [...resumed.host.querySelectorAll("button")].find((button) => button.textContent === "Confirm pending data setup")!.click(); await Promise.resolve(); });
    expect(resumed.calls).toEqual(["confirm"]);
    expect(resumed.signEnvelope).not.toHaveBeenCalled();
    expect(executeCmcBudgetCalls).not.toHaveBeenCalled();
    await act(async () => resumed.root.unmount());
    vi.unstubAllGlobals();
  });

  it("refuses a passkey wallet that does not match the agent wallet", async () => {
    const rendered = renderPage({ owner: owner(vi.fn(), "0x3333333333333333333333333333333333333333") });
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    await act(async () => { [...rendered.host.querySelectorAll("button")].find((button) => button.textContent === "Set up data budget")!.click(); await Promise.resolve(); });
    expect(rendered.host.textContent).toContain("passkey wallet does not match");
    expect(rendered.signEnvelope).not.toHaveBeenCalled();
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();
  });
});

/** The CMC panel lives under its own tab; open it before reading the panel's text. */
async function openCmcTab(host: HTMLDivElement): Promise<void> {
  await act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === "CMC x402")!.click();
  });
}

describe("CMC-HIRE-SETUP R6: adopted amount and new reason strings", () => {
  it("explains session_rebind_required in the CMC tab", async () => {
    const rendered = renderPage({ budget: { asset: "USDT", decimals: 18, generation: 1, authorizedTotalWei: "2000000000000000000", settledWei: "0", reservedWei: "0", remainingWei: "2000000000000000000", status: "setup-required", reason: "session_rebind_required", pendingOperationId: null } });
    await act(async () => rendered.root.render(<TradeAgentDetail {...rendered.props} />));
    await openCmcTab(rendered.host);
    expect(rendered.host.textContent).toContain("The trading session was renewed. Rebind data access to the new session.");
    expect(rendered.host.textContent).toContain("Rebind data access");
    await act(async () => rendered.root.unmount());
    vi.unstubAllGlobals();
  });
  it("shows the adopted-leftover line only when adoptedWei is greater than zero", async () => {
    const zero = renderPage({ budget: { asset: "USDT", decimals: 18, generation: 1, authorizedTotalWei: "2000000000000000000", settledWei: "0", reservedWei: "0", remainingWei: "2000000000000000000", status: "ready", reason: null, pendingOperationId: null, adoptedWei: "0" } });
    await act(async () => zero.root.render(<TradeAgentDetail {...zero.props} />));
    await openCmcTab(zero.host);
    expect(zero.host.textContent).not.toContain("carried over from an earlier agent");
    await act(async () => zero.root.unmount());
    vi.unstubAllGlobals();

    const adopted = renderPage({ budget: { asset: "USDT", decimals: 18, generation: 1, authorizedTotalWei: "3870000000000000000", settledWei: "0", reservedWei: "0", remainingWei: "3870000000000000000", status: "ready", reason: null, pendingOperationId: null, adoptedWei: "1870000000000000000" } });
    await act(async () => adopted.root.render(<TradeAgentDetail {...adopted.props} />));
    await openCmcTab(adopted.host);
    expect(adopted.host.textContent).toContain("carried over");
    expect(adopted.host.textContent).toContain("1.87 USDT");
    expect(adopted.host.textContent).toContain("carried over from an earlier agent on this wallet");
    await act(async () => adopted.root.unmount());
    vi.unstubAllGlobals();
  });

  it("renders the two continuation-skip reason strings instead of the generic fallback", async () => {
    const profile = renderPage({ budget: { asset: "USDT", decimals: 18, generation: 0, authorizedTotalWei: "0", settledWei: "0", reservedWei: "0", remainingWei: "0", status: "unavailable", reason: "cmc-profile-unavailable", pendingOperationId: null } });
    await act(async () => profile.root.render(<TradeAgentDetail {...profile.props} />));
    await openCmcTab(profile.host);
    expect(profile.host.textContent).toContain("Data payments have not been reviewed for this agent's session shape yet.");
    await act(async () => profile.root.unmount());
    vi.unstubAllGlobals();

    const spec = renderPage({ budget: { asset: "USDT", decimals: 18, generation: 0, authorizedTotalWei: "0", settledWei: "0", reservedWei: "0", remainingWei: "0", status: "unavailable", reason: "cmc-session-spec-unavailable", pendingOperationId: null } });
    await act(async () => spec.root.render(<TradeAgentDetail {...spec.props} />));
    await openCmcTab(spec.host);
    expect(spec.host.textContent).toContain("The agent's session could not be read for data payments. Refresh the agent and try again.");
    await act(async () => spec.root.unmount());
    vi.unstubAllGlobals();
  });
});

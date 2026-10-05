// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";
import { HiredAgentScreen } from "@/components/screens/HiredAgentScreen";
import type { AgentDetailView } from "@/lib/exec/agent-detail";
import type { TradeSettings } from "@/lib/trade";

const hooks = vi.hoisted(() => ({ detail: null as unknown, owner: vi.fn(() => ({ passkey: null, signEnvelope: vi.fn(), signReadHeader: vi.fn() })),
  agent: vi.fn<() => unknown>(() => null), mock: vi.fn((value: unknown) => value) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: hooks.owner }));
vi.mock("@/lib/exec/use-agent-detail", () => ({ useAgentDetail: hooks.agent }));
vi.mock("@/lib/mock/use-mock-agent-detail", () => ({ useMockAgentDetail: hooks.mock }));
vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({}) }));
vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div>Chart</div> }));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", TOKEN = "0x2222222222222222222222222222222222222222", PINNED = "0x3333333333333333333333333333333333333333";
const settings: TradeSettings = { name: "Altana AI Trade", executionModel: "tradfi", settlementAsset: "USDT", capitalQuoteWei: "10000000000000000000",
  minEntryWei: "5000000000000000000", entryWei: "5000000000000000000", maxOpenPositions: 2, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false,
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null,
  skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b" };
const metric = { value: null, reason: "unavailable" };
const view: AgentDetailView = { id: "altana-ai", status: "armed", httpRuntimeProfile: "unbound-v1", hireSizingName: "trade-v1", armedBudgetWei: "0", walletAddress: W,
  sessionPublicKey: null, sessionExpiresAt: null, provisioning: false, actionDisabledReason: null, armMs: NOW,
  dailyNativeLimit: metric, recordedCycleDelta: metric, grossPnl: metric, grossPnlPercent: metric, recordedCycles: metric,
  levels: [], cycleHistoryAvailable: false, cycleNote: "", gas: null, motions: [], sequences: [], positions: [], lp: null,
  grid: { pool: null, pair: "", base: null, quote: null, symbol0: null, symbol1: null, decimals0: null, decimals1: null, token0: TOKEN, token1: W,
    fee: 100, wbnbIsToken0: false, sideInverted: false, observedPrice: null, quoteUsd: null, baseAddress: null, quoteAddress: null, buyPrices: null, sellPrices: null,
    tickSpacing: 1, mode: "fixed", gapTicks: null, widthTicks: null, driftPctOfGap: null, deployPctBps: null, shiftLane: null, buyRange: { tickLower: 0, tickUpper: 1 },
    sellRange: { tickLower: 0, tickUpper: 1 }, buyRungSource: "none", sellRungSource: "none", buyRungGap: null, sellRungGap: null, placement: "unplaced",
    observedTick: null, observationAgeMs: null, observationStale: false, tickSource: null, rangeUnavailableBecause: null, liveRows: 0 } };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("public Trading layout polls only the public endpoint, mounts no owner hooks and leaves Altana AI markup equivalent", async () => {
  // TradeAgentDetail.tsx is shared with the public page now (exports only); the Altana markup is pinned by TradeAgentDetail.altana-golden.test.tsx.
  for (const [file, hash] of [["components/screens/HiredAgentScreen.tsx", "1b492e262c3d33f5245bd10add52f4a0501218e8252823f8090dd953f3a45151"],
    ["components/FundsModal.tsx", "e534cf2621efd607d01a9a0560ca8f46c88d4b432794d0b9ca9594a8cbbdefbf"]]) {
    expect(createHash("sha256").update(readFileSync(join(process.cwd(), file!), "utf8").replace(/\r\n/g, "\n")).digest("hex")).toBe(hash);
  }
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  hooks.detail = { state: "ready", view, market: null, trade: { settings, open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: true, holidaysModeled: false },
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: "unavailable", wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: 2, observedAt: NOW },
    lifecycle: { draining: false, drainingAt: null }, pendingIntents: [] }, asOfMs: NOW, message: "", readHeaders: {}, refresh: vi.fn(), refreshTrade: vi.fn(), signIn: vi.fn() };
  hooks.agent.mockReturnValue(hooks.detail);
  const before = renderToStaticMarkup(<HiredAgentScreen agentId="altana-ai" go={() => undefined} />);
  expect(before).toContain("Altana AI Trade"); expect(before).toContain("Remove"); expect(before).toContain("Open Positions");
  hooks.agent.mockClear(); hooks.owner.mockClear(); hooks.mock.mockClear();
  const position = { ref: "p0", token: TOKEN, symbol: "STOCK", decimals: 18, status: "open", openedAt: NOW, closedAt: null, entryUsdtWei: "5000000000000000000",
    exitUsdtWei: null, tokenAmount: "1000000000000000000", pnlBps: "120", closeReason: null, entryTxHash: "0x" + "ab".repeat(32), exitTxHash: null, unsold: null,
    live: { liveWalletBalance: "1000000000000000000", currentQuoteWei: "5060000000000000000", quoteStatus: "quoted" } };
  const fetch = vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data: { wallet: W, custody: "binance-agentic", agent: { name: "Public AI Trade", status: "running", holdCode: null,
    endReason: null, termDays: 7, termEndAction: "keep", hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 1000, hireEndsAtMs: NOW + 2000, connection: "connected",
    lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false, settings: { executionModel: settings.executionModel, primaryModel: settings.primaryModel,
      capitalQuoteWei: settings.capitalQuoteWei, entryWei: settings.entryWei, minEntryWei: settings.minEntryWei, maxOpenPositions: settings.maxOpenPositions,
      slippageBps: settings.slippageBps, stopLossBps: settings.stopLossBps, takeProfitBps: settings.takeProfitBps, maxHoldSec: settings.maxHoldSec },
    cmc: { authorizedTotalWei: "2000000000000000000", settledWei: "0", remainingWei: "2000000000000000000", status: "ready" },
    summary: { openPositions: 1, maxOpenPositions: 2, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: null, grossComplete: false },
    positions: [position, { ...position, ref: "p1", status: "kept", unsold: { code: "kept-by-choice", atMs: NOW } }], runs: [{ id: "0123456789abcdef", dryRun: false, reason: "at-capacity;candidates=0;refusals=0;entries=0;exits=0", candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW,
      events: [{ stage: "exit-llm", code: "hold", elapsedMs: 1500, token: TOKEN, model: "m", confidence: 70, reason: "Public model reasoning" },
        { stage: "entry-llm", code: "selected", elapsedMs: 2000, token: PINNED }] }], pinned: [{ address: PINNED, symbol: "NVDAB" }],
    cmcLog: { attempts: [{ operationId: "0a1b2c3d4e5f6071", attemptId: "1a2b3c4d5e6f7081", state: "settled", contentState: "available", amountWei: "10000000000000000", txHash: "0x" + "cd".repeat(32), settlementTxHint: null, createdAt: NOW, updatedAt: NOW }],
      news: [{ ticker: "NVDAB", skill: "us_equity_sector_rotation", status: "available", asOfMs: NOW, expiresAtMs: NOW + 1000, sourceUrl: null, paymentOperationId: "0a1b2c3d4e5f6071", requestedBy: null, requestReason: null, context: "Public CMC context" }] } } } }));
  vi.stubGlobal("fetch", fetch);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    // Only the public wallet projection and the public token-icon lookup are fetched; no owner or account route.
    const urls = (fetch.mock.calls as unknown as [string, RequestInit | undefined][]).map((call) => call[0]);
    expect(urls.filter((url) => url === "/api/agentic/wallets/" + W)).toHaveLength(2);
    for (const call of fetch.mock.calls as unknown as [string, RequestInit | undefined][]) {
      if (call[0] === "/api/agentic/wallets/" + W) expect(call[1]!.method).toBe("GET"); else expect(call[0].startsWith("/api/token-icons?")).toBe(true);
    }
    expect(hooks.owner).not.toHaveBeenCalled(); expect(hooks.agent).not.toHaveBeenCalled(); expect(hooks.mock).not.toHaveBeenCalled();
    // Same layout as the Altana trade detail: tiles, tab bar, positions table. No owner control anywhere.
    const labels = () => [...host.querySelectorAll("button")].map((button) => button.textContent ?? button.getAttribute("aria-label"));
    expect(host.querySelectorAll("input, select")).toHaveLength(0); expect(host.querySelectorAll(".fl-trade-metric")).toHaveLength(5);
    for (const text of ["Public AI Trade", "Total Delegated", "Execution model", "LLM model: Qwen3.7 Flash", "AI models by",
      "PnL since hire", "Win rate", "Open positions", "1 / 2", "STOCK / USDT", "0x2222…2222", "1 STOCK", "5 USDT total", "@ 5.00 USDT / STOCK", "LLM decides", "+1.2%", "Tx"]) expect(host.textContent).toContain(text);
    // Header: no info box; the wallet address sits next to the kicker; Read-only is the right-hand panel with no buttons.
    for (const gone of ["How to stop", "While the agent is held", "Term: 7 days"]) expect(host.textContent).not.toContain(gone);
    const kicker = host.querySelector(".fl-trade-hero .fl-trade-kicker")!, link = kicker.querySelector("a")!;
    expect(kicker.textContent).toBe(W); expect(kicker.querySelector("img")?.getAttribute("alt")).toBe("Agentic Wallet"); expect(link.getAttribute("href")).toBe("https://bscscan.com/address/" + W);
    const panel = host.querySelector(".fl-trade-hero .fl-hired-actions")!;
    expect(panel.textContent).toContain("Read-only"); expect(panel.querySelector('[title="No owner actions after hire"]')).not.toBeNull(); expect(panel.querySelectorAll("button")).toHaveLength(0);
    expect(host.querySelector(".fl-trade-tabs")!.textContent).toBe("Open PositionsClosed PositionsKept PositionsRun logCMC x402");
    for (const owner of ["Sell", "Edit", "Pause", "Resume", "Remove", "Renew"]) expect(labels()).not.toContain(owner);
    expect(host.querySelectorAll(".fl-trade-position__actions button")).toHaveLength(0);
    const tab = async (name: string) => act(async () => { ([...host.querySelectorAll(".fl-trade-tabs button")].find((button) => button.textContent === name) as HTMLElement).click(); });
    await tab("Kept Positions"); expect(host.textContent).toContain("kept by choice");
    await tab("Closed Positions"); expect(host.textContent).toContain("No closed positions.");
    await tab("Run log");
    for (const text of ["All position slots occupied", "0 shortlisted · 0 buy attempts · 0 closed · 0 skipped/refused", "All cycles", "Succeeded", "Failed", "Trades", "LLM decisions", "Refresh", "Public model reasoning", "70% confidence"]) expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("Simulate");
    // A pinned token that was never held shows its ticker, not a short address.
    expect(host.textContent).toContain("NVDAB"); expect(host.textContent).not.toContain("0x3333…3333");
    expect(host.querySelectorAll(".fl-run-card")).toHaveLength(1);
    await tab("CMC x402"); expect(host.textContent).toContain("Ready"); expect(host.textContent).not.toContain("not public");
    for (const text of ["CMC log", "Charges (1)", "Data log (1)", "Charged and settled on chain", "0.01 USDT", "Operation 0a1b2c3d4e5f6071", "Settle tx:"]) expect(host.textContent).toContain(text);
    await act(async () => { ([...host.querySelectorAll(".fl-run-filters button")].find((button) => button.textContent === "Data log (1)") as HTMLElement).click(); });
    for (const text of ["NVDAB", "paid by 0a1b2c3d4e5f6071", "Public CMC context"]) expect(host.textContent).toContain(text);
    await tab("Open Positions");
    await act(async () => { host.querySelector<HTMLButtonElement>(".fl-trade-chart-button")!.click(); });
    expect(host.querySelector(".fl-trade-position__expanded")).not.toBeNull();
    expect(renderToStaticMarkup(<HiredAgentScreen agentId="altana-ai" go={() => undefined} />)).toBe(before);
  } finally { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});

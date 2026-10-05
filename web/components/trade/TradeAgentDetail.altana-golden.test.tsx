// @vitest-environment happy-dom
// Pins the Altana AI Trade detail markup (header, tiles, tab bar, open and closed position tables, expanded chart)
// so that sharing its row components with the read-only Agentic page cannot change what Altana renders.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentDetailView, DetailMetric } from "@/lib/exec/agent-detail";
import type { TradePositionView, TradeSettings, TradeView } from "@/lib/trade";
import { TradeAgentDetail } from "./TradeAgentDetail";

vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div>Chart</div> }));
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const metric = (reason: string): DetailMetric => ({ value: null, reason });
const TOKEN_A = "0x5b19000000000000000000000000000000000292", TOKEN_B = "0xd97d00000000000000000000000000000000efaf";
const view = { id: "tradfi-1", status: "armed", httpRuntimeProfile: "trade-v1", hireSizingName: "trade-v1", walletAddress: "0x2222222222222222222222222222222222222222",
  sessionPublicKey: `0x${"33".repeat(64)}`, sessionExpiresAt: null, provisioning: false, actionDisabledReason: null, armMs: 1_000,
  dailyNativeLimit: metric("unavailable"), recordedCycleDelta: metric("n/a"), grossPnl: metric("n/a"), grossPnlPercent: metric("n/a"), recordedCycles: metric("n/a"),
  levels: [], cycleHistoryAvailable: false, cycleNote: "", gas: null, motions: [], sequences: [], positions: [] } as unknown as AgentDetailView;
const settings: TradeSettings = { name: "TradFi Trade Agent", executionModel: "tradfi", settlementAsset: "USDT", capitalQuoteWei: "100000000000000000000",
  minEntryWei: "5000000000000000000", entryWei: "5000000000000000000", maxOpenPositions: 8, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false,
  takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null,
  skillMarkdown: null, primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b" };
const base = { route: { hops: [], fees: [] }, exitRequestedAt: null, orphanedAt: null, refusalText: null, settlementAsset: "USDT" as const };
const open = (id: string, token: string, pnl: string, quote: string): TradePositionView => ({ ...base, positionId: id, token, entryWei: "5000000000000000000",
  verifiedEntryAtomic: "5000000000000000000", tokenAmount: "13465000000000000", fillStatus: "verified", openedAt: NOW - 16 * 3_600_000, entryTxHash: "0x" + "ab".repeat(32),
  status: "open", pnlBps: null, closedAt: null, exitWei: null, exitTxHash: null, soldTokenAmount: null, exitFillStatus: null, closeReason: null,
  observation: { positionId: id, symbol: "TSLAB", decimals: 18, recordedPositionAmount: "13465000000000000", liveWalletBalance: "13465000000000000", currentQuoteWei: quote,
    pnlBps: pnl, quoteStatus: "quoted", reason: null, observedAt: NOW } });
const closed = (id: string, token: string): TradePositionView => ({ ...base, positionId: id, token, entryWei: "5000000000000000000", verifiedEntryAtomic: "5000000000000000000",
  tokenAmount: "13465000000000000", fillStatus: "verified", openedAt: NOW - 20 * 3_600_000, entryTxHash: "0x" + "cd".repeat(32), status: "closed", pnlBps: "120",
  closedAt: NOW - 3_600_000, exitWei: "5060000000000000000", exitTxHash: "0x" + "ef".repeat(32), soldTokenAmount: "13465000000000000", exitFillStatus: "verified",
  closeReason: "take-profit", observation: null });
const trade: TradeView = { settings, open: [open("p1", TOKEN_A, "-46", "4977000000000000000"), open("p2", TOKEN_B, "180", "5090000000000000000")], closed: [closed("c1", TOKEN_A)],
  runs: [], pinned: [], marketHours: { usEquitiesOpen: true, holidaysModeled: false },
  summary: { grossDeltaWei: "-880000000000000000", grossComplete: true, grossReason: null, wins: 1, winRateBps: 5000, closedTrades: 2, openPositions: 2, maxOpenPositions: 8, observedAt: NOW },
  lifecycle: { draining: false, drainingAt: null }, pendingIntents: [] };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("the Altana AI Trade detail markup is unchanged (open, expanded chart, closed, run log, CMC tabs)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host), frames: string[] = [];
  const click = async (label: string) => { await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!.click(); }); frames.push(host.innerHTML); };
  try {
    await act(async () => root.render(<TradeAgentDetail agentId="tradfi-1" view={view} trade={trade} busy={false} removed={false} message="" signedOut={false}
      go={() => undefined} signIn={async () => undefined} refresh={async () => undefined} togglePause={() => undefined} remove={() => undefined}
      sellNow={() => undefined} saveSettings={async () => undefined} />));
    frames.push(host.innerHTML);
    await click("Show TSLAB chart"); await click("Closed Positions"); await click("Run log"); await click("CMC x402");
    expect(frames).toHaveLength(5);
    expect(createHash("sha256").update(frames.join("\n---\n")).digest("hex")).toBe("fb1d1dbc4ceb5c850fc033d2156008fa5f0a4c4a4292203cc7887dee1fc8451b");
  } finally { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});

// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";

vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div>Chart</div> }));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", HASH = "0x" + "ab".repeat(32);
const pending = { version: 1, publicRef: "d96e185c-0948-4004-832e-99de3d50ad9d", revision: 1, category: "agentic-trade", status: "pending",
  agentId: null, registrationTxHash: null, uriUpdateTxHash: null, errorCode: null };
const registered = { ...pending, revision: 3, status: "registered", agentId: "364199", registrationTxHash: HASH, uriUpdateTxHash: HASH };
const agent = (identity: unknown) => ({ name: "Public AI Trade", status: "running", holdCode: null, endReason: null, termDays: 30, termEndAction: "keep",
  hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 1000, hireEndsAtMs: NOW + 2000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  settings: { executionModel: "tradfi", primaryModel: "qwen3.7-flash", capitalQuoteWei: "100000000000000000000", entryWei: "5000000000000000000",
    minEntryWei: "5000000000000000000", maxOpenPositions: 8, slippageBps: 100, stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  cmc: { authorizedTotalWei: "0", settledWei: "0", remainingWei: "0", status: "ready" },
  summary: { openPositions: 0, maxOpenPositions: 8, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: "0", grossComplete: true },
  positions: [], runs: [], pinned: [], ...(identity === undefined ? {} : { erc8004Identity: identity }) });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function render(identity: unknown) {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} })
    : Response.json({ data: { wallet: W, custody: "binance-agentic", agent: agent(identity) } })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const stack = host.querySelector(".fl-trade-hero .fl-trade-title-stack")!;
  const result = { stack: stack.textContent ?? "", links: [...stack.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("rel"), a.textContent]),
    kicker: host.querySelector(".fl-trade-hero .fl-trade-kicker")!.textContent };
  await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  return result;
}

it("a registered Agentic identity links its full id to the fixed 8004scan page on the wallet line", async () => {
  const r = await render(registered);
  expect(r.links).toContainEqual(["https://8004scan.io/agents/bsc/364199", "noopener noreferrer", "ERC-8004 #364199"]);
  // Same line as the wallet address (inside the kicker), after it.
  expect(r.kicker).toBe(W + "ERC-8004 #364199");
});

it("a pending mark shows the pending line with no link; no identity shows nothing", async () => {
  const p = await render(pending);
  expect(p.stack).toContain("ERC-8004 registration pending");
  expect(p.links.map(([href]) => href)).toEqual(["https://bscscan.com/address/" + W]);
  const none = await render(undefined);
  expect(none.stack).not.toContain("ERC-8004");
});

it("a malformed identity never renders a link", async () => {
  const r = await render({ ...registered, uriUpdateTxHash: null, url: "javascript:alert(1)" });
  expect(r.stack).toContain("ERC-8004 registration needs attention");
  expect(r.links.map(([href]) => href)).toEqual(["https://bscscan.com/address/" + W]);
});

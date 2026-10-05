// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";

vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({}) }));
vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div>Chart</div> }));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", E = 10n ** 18n, SPYB = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", QQQB = "0x205812cdbed920aff76c6580abd681a46d11efc7";
const block = (patch: Record<string, unknown> = {}) => ({ tokens: [
  { token: SPYB, symbol: "SPYB", displayName: "SPDR S&P 500", targetBps: 5000, balanceAtomic: (25n * E).toString(), valueWei: (25n * E).toString(), valueReason: null, weightBps: 5000, driftBps: 0,
    initial: { quantityAtomic: null, quantityReason: "not-verified", quoteWei: (25n * E).toString(), quoteReason: null } },
  { token: QQQB, symbol: "QQQB", displayName: null, targetBps: 5000, balanceAtomic: (25n * E).toString(), valueWei: (25n * E).toString(), valueReason: null, weightBps: 5000, driftBps: 0,
    initial: { quantityAtomic: null, quantityReason: "no-buy", quoteWei: null, quoteReason: "no-buy" } }],
capitalQuoteWei: (50n * E).toString(), netInvestedWei: (50n * E).toString(), cashCapWei: "0", walletUsdtWei: (2n * E).toString(), portfolioCashWei: "0", idleUsdtWei: (2n * E).toString(),
stockValueWei: (50n * E).toString(), totalValueWei: (50n * E).toString(), pnlWei: "0", driftBps: 0, intervalSec: 14400, anchorMs: NOW, currentSlot: 0, nextCheckAtMs: NOW + 14_400_000,
check: { slot: 0, state: "done", maxDriftBps: 0, valueWei: (50n * E).toString(), checkedAt: NOW },
legs: [{ slot: 0, side: "buy", token: SPYB, symbol: "SPYB", amountWei: (25n * E).toString(), quotedOutAtomic: null, minOutAtomic: null, proceedsAtomic: null, state: "projected", txHash: null, createdAt: NOW,
  detail: { id: "0123456789abcdef", executionState: "COMMITTED", executionReason: null, quantityAtomic: null, quantityReason: "not-verified", quoteWei: (25n * E).toString(), quoteReason: null } }], ...patch });
const wallet = (agentPatch: Record<string, unknown> = {}, portfolio: unknown = block()) => ({ wallet: W, custody: "binance-agentic", agent: { name: "Public Portfolio", status: "running", holdCode: null, endReason: null, termDays: 7,
  termEndAction: "keep", hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 597_600_000, hireEndsAtMs: NOW + 604_800_000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  settings: { executionModel: "tradfi", primaryModel: "qwen3.7-flash", capitalQuoteWei: (50n * E).toString(), entryWei: (50n * E).toString(), minEntryWei: (E / 10n).toString(), maxOpenPositions: 1, slippageBps: 100,
    stopLossBps: null, takeProfitBps: null, maxHoldSec: null, portfolioDriftBps: 50 },
  cmc: { authorizedTotalWei: (E / 5n).toString(), settledWei: "0", remainingWei: (E / 5n).toString(), status: "ready" }, summary: { openPositions: 0, maxOpenPositions: 1, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: null, grossComplete: true },
  positions: [], runs: [{ id: "0123456789abcdef", dryRun: false, reason: "portfolio-submission-unknown;candidates=2;refusals=0;entries=0;exits=0", candidates: 2, refusals: 0, entries: 0, exits: 0, createdAt: NOW, events: [] }],
  cmcLog: { news: [], attempts: [] }, pinned: [{ address: SPYB, symbol: "SPYB" }, { address: QQQB, symbol: "QQQB" }], portfolio, ...agentPatch } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
  return { host, done: async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}
const forbidden = ["passkey", "Remove", "Edit", "renew", "Renew", "Pause", "Resume"];

it("a portfolio hire renders the Smart Portfolio summary and detail, read-only, without the AI metrics, tabs or owner wording", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, done } = await render(wallet());
  for (const text of ["Public Portfolio", "Read-only", "Total Delegated", "TradFi - Smart Portfolio", "SPYB", "QQQB", "Run log"]) expect(host.textContent).toContain(text);
  for (const gone of ["Open Positions", "Closed Positions", "Kept Positions", "CMC x402", "Win rate", "Session expired", ...forbidden]) expect(host.textContent).not.toContain(gone);
  expect(host.textContent).toContain("Rebalance when drift exceeds");
  expect(host.textContent).toContain("0.50%");
  expect(host.textContent).toMatch(/Next in|Due now/u);
  expect(host.querySelectorAll("input, select")).toHaveLength(0);
  expect(host.querySelector(".fl-hired-actions")!.querySelectorAll("button")).toHaveLength(0);
  await act(async () => { ([...host.querySelectorAll("button")].find(b => b.textContent === "Run log") as HTMLElement).click(); });
  expect(host.textContent).toContain("A trade's outcome is unknown; the agent waits.");
  for (const gone of ["Pause and Remove", ...forbidden]) expect(host.textContent).not.toContain(gone);
  await done();
});

it("the summary shows Stopped for an ended hire and Paused for a held one, and never the renew line", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  for (const [status, text] of [["ended", "Stopped"], ["held", "Paused"]] as const) {
    const { host, done } = await render(wallet({ status }));
    expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("renew to continue");
    await done();
  }
  vi.setSystemTime(NOW + 600_000_000);
  const { host, done } = await render(wallet());
  expect(host.textContent).toContain("Stopped");
  await done();
});

it("a null, malformed or drift-less portfolio block shows the unavailable line and no figures", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  for (const data of [wallet({}, null), wallet({}, block({ intervalSec: 3600 })), wallet({ settings: { executionModel: "tradfi", capitalQuoteWei: (50n * E).toString() } }),
    wallet({ settings: { executionModel: "tradfi", portfolioDriftBps: "50" } }), wallet({ settings: { executionModel: "tradfi", portfolioDriftBps: 50.5 } })]) {
    const { host, done } = await render(data);
    expect(host.textContent).toContain("Portfolio data unavailable.");
    expect(host.textContent).not.toContain("Total Delegated");
    await done();
  }
});

it("an AI or Schedule page without the key is untouched: the AI body still shows its metrics", async () => {
  const { portfolio: _removed, ...agent } = wallet().agent;
  const { host, done } = await render({ wallet: W, custody: "binance-agentic", agent });
  expect(host.textContent).toContain("Win rate");
  expect(host.textContent).toContain("Open Positions");
  expect(host.textContent).not.toContain("Portfolio data unavailable.");
  await done();
});

it("the public page hides the idle line, shows a verified leg's price and amount, and puts the token logo in the order history asset cell", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const leg = { slot: 0, side: "buy", token: SPYB, symbol: "SPYB", amountWei: (25n * E).toString(), quotedOutAtomic: null, minOutAtomic: null, proceedsAtomic: null, state: "projected", txHash: null, createdAt: NOW,
    detail: { id: "0123456789abcdef", executionState: "COMMITTED", executionReason: null, quantityAtomic: (E / 2n).toString(), quantityReason: null, quoteWei: (25n * E).toString(), quoteReason: null } };
  const { host, done } = await render(wallet({}, block({ legs: [leg] })));
  expect(host.textContent).not.toContain("idle · not managed");
  await act(async () => { ([...host.querySelectorAll("button")].find(b => b.textContent === "Order history") as HTMLElement).click(); });
  expect(host.textContent).not.toContain("Executed quantity not recorded.");
  expect(host.textContent).toContain("0.5");
  expect(host.textContent).toContain("50");
  const row = [...host.querySelectorAll(".fl-portfolio-row")].find(r => r.textContent?.includes("Initial allocation"))!;
  expect(row.querySelector(".fl-portfolio-asset")?.textContent).toContain("SPYB");
  expect(row.querySelector(".fl-portfolio-asset")!.children.length).toBe(2);
  await done();
});

it("a leg with a verified quantity but no verified cost says the cost is missing, not the quantity", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const leg = { slot: 0, side: "buy", token: SPYB, symbol: "SPYB", amountWei: (25n * E).toString(), quotedOutAtomic: null, minOutAtomic: null, proceedsAtomic: null, state: "projected", txHash: null, createdAt: NOW,
    detail: { id: "0123456789abcdef", executionState: null, executionReason: "unavailable", quantityAtomic: (E / 2n).toString(), quantityReason: null, quoteWei: null, quoteReason: "unavailable" } };
  const { host, done } = await render(wallet({}, block({ legs: [leg] })));
  await act(async () => { ([...host.querySelectorAll("button")].find(b => b.textContent === "Order history") as HTMLElement).click(); });
  expect(host.textContent).toContain("Executed cost not recorded.");
  expect(host.textContent).not.toContain("Executed quantity not recorded.");
  await done();
});

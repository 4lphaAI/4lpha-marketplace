// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";

vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({}) }));
vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div>Chart</div> }));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", TOKEN = "0x2222222222222222222222222222222222222222", E = "000000000000000000";
const position = { ref: "p0", token: TOKEN, symbol: "NVDAB", decimals: 18, status: "open", openedAt: NOW, closedAt: null, entryUsdtWei: "5" + E, exitUsdtWei: null, tokenAmount: "5" + E,
  pnlBps: null, closeReason: null, entryTxHash: "0x" + "ab".repeat(32), exitTxHash: null, unsold: null, live: null };
const schedule = (patch: Record<string, unknown> = {}, holding: Record<string, unknown> = {}) => ({ token: TOKEN, symbol: "NVDAB", decimals: 18, amountWei: "5" + E, intervalSec: 3600,
  anchorMs: NOW, nextDueAtMs: NOW + 3_600_000, currentSlot: 0, currentSlotTaken: true, fills: 1, postponed: 0, plannedBuys: 2, buysThisSession: 166, spentWei: "5" + E, remainingWei: "5" + E,
  finished: null, endKind: "runs", endAtSec: null, endRuns: 2, marketHoursOnly: false, maxPremiumBps: 150, firstAtSec: null, premiumBps: 42, premiumLimitBps: 150, nativeCapWei: null,
  nativeSpentWei: null, nativeBalanceWei: "1" + E, nativeBuysRefused: null, sessionExpiresAtSec: (NOW + 604_800_000) / 1_000,
  holding: { walletBalance: "5" + E, boughtAtomic: "5" + E, verifiedSpentWei: "5" + E, verifiedFills: 1, quoteWei: "51" + "0".repeat(17), quoteReason: null, ...holding }, ...patch });
const wallet = (agentPatch: Record<string, unknown> = {}) => ({ wallet: W, custody: "binance-agentic", agent: { name: "Public Schedule", status: "running", holdCode: null, endReason: null, termDays: 7,
  termEndAction: "keep", hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 1000, hireEndsAtMs: NOW + 604_800_000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  settings: { executionModel: "tradfi", primaryModel: "qwen3.7-flash", capitalQuoteWei: "10" + E, entryWei: "5" + E, minEntryWei: "5" + E, maxOpenPositions: 1, slippageBps: 100,
    stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  cmc: { authorizedTotalWei: "0", settledWei: "0", remainingWei: "0", status: "disabled" }, summary: { openPositions: 1, maxOpenPositions: 1, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: null, grossComplete: false },
  positions: [position], runs: [{ id: "0123456789abcdef", dryRun: false, reason: "entered;candidates=1;refusals=0;entries=1;exits=0", candidates: 1, refusals: 0, entries: 1, exits: 0, createdAt: NOW, events: [] }],
  cmcLog: { news: [], attempts: [] }, pinned: [{ address: TOKEN, symbol: "NVDAB" }], schedule: schedule(), ...agentPatch } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
  return { host, done: async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}
const forbidden = ["passkey", "Remove", "Edit", "renew", "Renew", "Pause", "Resume", "Sell"];

it("Schedule public page renders the Schedule card and Buys / Run log read-only, without the AI tabs or owner wording", async () => {
  const { host, done } = await render(wallet());
  for (const text of ["Public Schedule", "Read-only", "Buys", "Run log"]) expect(host.textContent).toContain(text);
  // The mode sits in the progress card's footer, not in the header kicker (operator 2026-10-04).
  expect(host.querySelector('[data-testid="schedule-progress-label"]')?.textContent).toBe("SCHEDULE BUY · NVDAB");
  expect(host.querySelector(".fl-trade-kicker")?.textContent ?? "").not.toContain("Schedule buy");
  expect(host.querySelector(".fl-trade-tabs")).toBeNull();
  for (const gone of ["Open Positions", "Closed Positions", "Kept Positions", "CMC x402", "Total Delegated", "Win rate", ...forbidden]) expect(host.textContent).not.toContain(gone);
  expect(host.querySelectorAll("input, select")).toHaveLength(0);
  expect(host.querySelector(".fl-hired-actions")!.querySelectorAll("button")).toHaveLength(0);
  await act(async () => { ([...host.querySelectorAll("button")].find(b => b.textContent === "Run log") as HTMLElement).click(); });
  expect(host.textContent).toContain("Run log");
  await done();
});

it("a finished Schedule hire says so in the badge and points the owner to the Binance App, with no owner action", async () => {
  const { host, done } = await render(wallet({ schedule: schedule({ finished: "runs", fills: 2 }) }));
  expect(host.textContent).toContain("Finished: runs");
  expect(host.textContent).toContain("The agent is idle and makes no calls. Your NVDAB and any leftover USDT stay in your Agentic Wallet; sell them in the Binance App.");
  for (const gone of ["Edit the number of runs", "withdraw them from Account", ...forbidden]) expect(host.textContent).not.toContain(gone);
  await done();
});

it("a Schedule block with an unreadable balance or non-decimal settings shows the unavailable line instead of a number", async () => {
  for (const data of [wallet({ schedule: schedule({}, { walletBalance: null }) }), wallet({ settings: { executionModel: "tradfi", capitalQuoteWei: "ten", entryWei: "5" + E } })]) {
    const { host, done } = await render(data);
    expect(host.textContent).toContain("Schedule data unavailable."); expect(host.querySelector(".fl-trade-metric")).toBeNull();
    await done();
  }
});

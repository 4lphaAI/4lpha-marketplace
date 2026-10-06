// @vitest-environment happy-dom
/** AGENTIC-MEME-STOCKS-SPEC 9.4 (review R2-M2): a paper meme hire's public page: banner, no-token-list sentence, paper tiles and ledger, no real-summary tile, no CMC wording. */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";
import { runLabel } from "@/components/trade/TradeRunLog";
import { AGENTIC_MEME_COPY } from "@/lib/agentic";

vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({}) }));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", E = 10n ** 18n, MEME = "0xabababababababababababababababababababab";
const meme = (positions: unknown[], summary: Record<string, unknown>) => ({ mode: "paper", tokens: [{ address: MEME, symbol: "MEME", quoteSymbol: "NVDAB" }], paper: { summary, positions } });
const wallet = (block: unknown) => ({ wallet: W, custody: "binance-agentic", agent: { name: "Meme paper", status: "running", holdCode: null, endReason: null, termDays: 7, termEndAction: "sell-all",
  hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 597_600_000, hireEndsAtMs: NOW + 604_800_000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  settings: { executionModel: "tradfi", primaryModel: "qwen3.7-flash", capitalQuoteWei: (20n * E).toString(), entryWei: (10n * E).toString(), maxOpenPositions: 2, slippageBps: 500, stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  cmc: { authorizedTotalWei: "0", settledWei: "0", remainingWei: "0", status: "disabled" },
  summary: { openPositions: 0, maxOpenPositions: 2, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: "0", grossComplete: true }, positions: [],
  runs: [{ id: "0123456789abcdef", dryRun: false, reason: "meme-veto:cost", candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW, events: [{ stage: "screen", code: "meme-veto:cost", elapsedMs: 1 }] }],
  pinned: [], meme: block } });
afterEach(() => { vi.unstubAllGlobals(); });
async function render(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
  return { host, done: async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}

it("renders the paper banner, the no-token-list sentence and the paper ledger; no real-summary tile and no CMC wording", async () => {
  const { host, done } = await render(wallet(meme([{ ref: "m0", token: MEME, symbol: "MEME", quoteSymbol: "NVDAB", venue: "pancake-v2", status: "closed", openedAt: NOW - 1, closedAt: NOW,
    entryUsdtWei: (10n * E).toString(), exitUsdtWei: (12n * E).toString(), markUsdtWei: (12n * E).toString(), markAtMs: NOW, pnlBps: 1_900, closeCode: "trailing" }],
    { open: 0, closed: 1, wins: 1, pnlUsdtWei: (19n * E / 10n).toString(), winRateBps: 10_000 })));
  const text = host.textContent ?? "";
  expect(text).toContain(AGENTIC_MEME_COPY.banner);
  expect(text).toContain(AGENTIC_MEME_COPY.noTokenList);
  expect(host.querySelectorAll('[data-testid="meme-paper-row"]').length).toBe(1);
  expect(text).toContain("MEME / NVDAB");
  for (const gone of ["PnL since hire", "Total Delegated", "CMC", "x402", "dividend"]) expect(text).not.toContain(gone);
  await done();
});

it("tiles without a paper source show a dash with its reason, never a zero", async () => {
  const { host, done } = await render(wallet(meme([], { open: 0, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null })));
  const text = host.textContent ?? "";
  expect(text).toContain("No closed paper trade yet");
  expect(text).not.toMatch(/Paper PnL \(closed\)\s*0/u);
  expect(text).toContain("No paper positions yet.");
  await done();
});

it("run-log labels for the closed meme codes", () => {
  expect(runLabel("meme-veto:cost")).toBe("Price range too small for the round-trip cost");
  expect(runLabel("meme-llm:buy_now")).toBe("Model: buy now");
  expect(runLabel("meme-refused:SERVICE_ERROR")).toBe("Binance refused the quote");
  expect(runLabel("meme-exit:stop")).toBe("Paper exit: stop");
});

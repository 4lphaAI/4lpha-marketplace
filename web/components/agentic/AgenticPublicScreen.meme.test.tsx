// @vitest-environment happy-dom
/** AGENTIC-MEME-STOCKS-SPEC 9.4 (review R2-M2): a paper meme hire's public page: banner, no-token-list sentence, paper tiles and ledger, no real-summary tile, no CMC wording. */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";
import { runLabel, runSummary } from "@/components/trade/TradeRunLog";
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
async function clickTab(host: HTMLElement, name: string) {
  const button = [...host.querySelectorAll(".fl-trade-tabs button")].find(b => b.textContent === name) as HTMLButtonElement | undefined;
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}

it("renders the paper banner, the no-token-list sentence and the paper ledger; no real-summary tile and no CMC wording", async () => {
  const { host, done } = await render(wallet(meme([{ ref: "m0", token: MEME, symbol: "MEME", quoteSymbol: "NVDAB", venue: "pancake-v2", status: "closed", openedAt: NOW - 1, closedAt: NOW,
    entryUsdtWei: (10n * E).toString(), exitUsdtWei: (12n * E).toString(), markUsdtWei: (12n * E).toString(), markAtMs: NOW, pnlBps: 1_900, closeCode: "trailing" }],
    { open: 0, closed: 1, wins: 1, pnlUsdtWei: (19n * E / 10n).toString(), winRateBps: 10_000 })));
  expect(host.textContent ?? "").toContain("No open positions.");
  await clickTab(host, "Closed Positions");
  const text = host.textContent ?? "";
  expect(text).toContain(AGENTIC_MEME_COPY.banner);
  expect(text).toContain(AGENTIC_MEME_COPY.noTokenList);
  expect(host.querySelectorAll('[data-testid="meme-paper-row"]').length).toBe(1);
  for (const want of ["MEME / NVDAB", "Trailing stop", "10 USDT", "12 USDT", "+19%"]) expect(text).toContain(want);
  for (const gone of ["PnL since hire", "Total Delegated", "CMC", "x402", "dividend"]) expect(text).not.toContain(gone);
  await done();
});

// Operator 2026-10-06: the paper page reads like the real TradFi detail (tiles, tabs, position rows), every figure still paper.
it("an open paper position: tiles, tabs, size, entry price, exit plan, unrealised in USDT and %, gmgn link, no Tx; an older plane without the amount shows a dash", async () => {
  const open = { ref: "m0", token: MEME, symbol: "MEME", quoteSymbol: "QQQB", venue: "flap-bonding", status: "open", openedAt: NOW - 600_000, closedAt: null,
    entryUsdtWei: (10n * E).toString(), exitUsdtWei: null, markUsdtWei: (8n * E).toString(), markAtMs: NOW, pnlBps: -2_066, closeCode: null,
    tokens: (481_412n * E).toString(), pnlUsdtWei: (-2_066n * E / 1_000n).toString(), peakPnlBps: -1_515, costBps: 891 };
  const { host, done } = await render(wallet(meme([open], { open: 1, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null })));
  const text = host.textContent ?? "";
  expect([...host.querySelectorAll(".fl-trade-tabs button")].map(b => b.textContent)).toEqual(["Open Positions", "Closed Positions", "Run log"]);
  for (const want of ["Paper budget", "Execution model", "Meme stocks", "Open positions", "1 / 2", "481,412 MEME", "10 USDT paper · curve", "@ 0.00002077 USDT / MEME",
    "Trail from +10% · peak -15.15%", "Stop -30% · max 4 h", "-2.07 USDT", "-20.66%", "Paper"]) expect(text).toContain(want);
  expect(host.querySelector('[data-testid="meme-gmgn-link"]')?.getAttribute("href")).toBe(`https://gmgn.ai/bsc/token/${MEME}`);
  expect(host.querySelector('a[href*="bscscan.com/tx"]')).toBeNull();
  await done();
  const { tokens: _t, pnlUsdtWei: _p, peakPnlBps: _k, costBps: _c, ...older } = open;
  const old = await render(wallet(meme([older], { open: 1, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null })));
  expect(old.host.textContent ?? "").toContain("- MEME");
  expect(old.host.textContent ?? "").toContain("@ - USDT / MEME");
  // Operator 2026-10-07: with the market cap at entry, the entry line reads in MCap instead of a price.
  const withMcap = await render(wallet(meme([{ ...open, entryMcapUsd: 32_551.15 }], { open: 1, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null })));
  expect(withMcap.host.textContent ?? "").toContain("@ 32.6K MCap");
  expect(withMcap.host.textContent ?? "").not.toContain("USDT / MEME");
  await withMcap.done();
  await old.done();
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

// Operator hotfix 2026-10-06: the Last cycle tile (counts only), the local debug decision log, and the meme run summary wording.
const cycle = (atMs: number) => ({ atMs, code: "meme-no-candidate", listSize: 22, checked: 17, passedScreen: 17, reasons: { "no-burst": 14, "screen:flow-unknown": 4, "odd-new-code": 1 },
  llmAsked: 0, paperEntries: 0, paperExits: 0, barLagMs: 25_005, elapsedMs: 1_001 });
const emptyMeme = (extra: Record<string, unknown>) => ({ ...meme([], { open: 0, closed: 0, wins: 0, pnlUsdtWei: null, winRateBps: null }), ...extra });

it("Last cycle shows the counts and the labelled reasons (an unknown code as itself); no decision log without the plane flag", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW + 10_000);
  const { host, done } = await render(wallet(emptyMeme({ lastCycle: cycle(NOW) })));
  const text = host.querySelector('[data-testid="meme-last-cycle"]')?.textContent ?? "";
  for (const want of ["22 on the meme list", "17 checked on price bars", "0 sent to the model", "No volume burst 14", "No 5-minute buy/sell data 4", "odd-new-code 1", "Data lag 25 s", "1.0 s"])
    expect(text).toContain(want);
  expect(host.querySelector('[data-testid="meme-decision-log"]')).toBeNull();
  await done(); vi.restoreAllMocks();
});

it("a stale or missing cycle shows a dash with its reason, never old counts as current", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW + 400_000);
  const stale = await render(wallet(emptyMeme({ lastCycle: cycle(NOW) })));
  const staleText = stale.host.querySelector('[data-testid="meme-last-cycle"]')?.textContent ?? "";
  expect(staleText).toContain("more than 3 minutes ago");
  expect(staleText).not.toContain("22 on the meme list");
  await stale.done();
  const missing = await render(wallet(emptyMeme({ lastCycle: null })));
  expect(missing.host.querySelector('[data-testid="meme-last-cycle"]')?.textContent ?? "").toContain("- (no cycle in the last 30 minutes");
  await missing.done(); vi.restoreAllMocks();
});

it("the decision log renders the market rows, signals and model asks when the plane sends it", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW + 10_000);
  const row = { address: MEME, stage: "graduated", status: "active", category: null, venue: "pancake-v2", buyTaxBps: 0, sellTaxBps: 100, liquidityUsd: 5_000, volume5mUsd: 300, txs5m: 12,
    flow5mBuys: 8, flow5mSells: 2, smart5mNetUsd: -10, smart1hNetUsd: 20, quoteSymbol: "BNCB", flags: [], verdict: "no-burst", barLagMs: 25_000, bars: 60, deadScore: 12, hardVeto: false,
    burstRatio: 1.4, burstReason: "volume", followRatio: null, extensionPct: null, range15Bps: 900, costEstBps: 450 };
  const { host, done } = await render(wallet(emptyMeme({ lastCycle: cycle(NOW), decisionLog: { market: { atMs: NOW, prevAtMs: NOW - 60_000, asOf: NOW - 15_000, rows: [row] },
    signals: [{ atMs: NOW, token: MEME, verdict: "cost", costEstBps: 451, costRule: false, llm: null, barLagMs: 25_411 }],
    llm: [{ atMs: NOW, model: "m", outcome: "reject", latencyMs: 2_000, tokens: [MEME], decisions: [{ index: 0, action: "reject", confidence: 90 }],
      jev: { outcome: "ok", model: "jev-1.13.0", latencyMs: 300, answers: [{ index: 0, token: null, verdict: null, choice: "buy_now", pBuy: 0.55, pWait: 0.3, pReject: 0.15, pUp60: 0.41 }] } }],
    jevScan: [{ atMs: NOW, outcome: "ok", model: "jev-1.13.0", latencyMs: 400, answers: [{ index: 0, token: MEME, verdict: "no-burst", choice: "wait", pBuy: 0.2, pWait: 0.7, pReject: 0.1, pUp60: 0.33 }] }] } })));
  await clickTab(host, "Decision log");
  const log = host.querySelector('[data-testid="meme-decision-log"]');
  expect(log).not.toBeNull();
  expect(host.querySelectorAll('[data-testid="meme-decision-row"]').length).toBe(1);
  expect(host.querySelector('[data-testid="meme-gmgn-link"]')?.getAttribute("href")).toBe(`https://gmgn.ai/bsc/token/${MEME}`);
  expect(host.querySelector('[data-testid="meme-copy-token"]')?.getAttribute("title")).toBe(`Copy ${MEME}`);
  for (const want of ["Decision log (local debug)", "BNCB", "No volume burst (volume)", "900 / 450 bps", "Swing too small for the round-trip cost", "fail"])
    expect(log?.textContent ?? "").toContain(want);
  // Operator 2026-10-07: no Liq $ column; the Jev shadow beside the model ask and the Jev scan of dropped tokens (display only).
  expect(log?.textContent ?? "").not.toContain("Liq $");
  const fresh = host.querySelector('[data-testid="meme-market-freshness"]')?.textContent ?? "";
  for (const want of ["Refreshed 10 s ago (", "every 60 s", "data plane 25 s old"]) expect(fresh).toContain(want);
  expect(host.querySelector('[data-testid="meme-jev-shadow"]')?.textContent).toBe("#0 buy_now (buy 55%, up 60m 41%)");
  const scan = host.querySelector('[data-testid="meme-jev-scan"]')?.textContent ?? "";
  for (const want of ["No volume burst", "wait", "20%", "70%", "10%", "33%", "Up 60m"]) expect(scan).toContain(want);
  await done(); vi.restoreAllMocks();
});

it("a meme run's summary counts the memes sent to the model; a stock run still reads shortlisted", () => {
  const base = { id: "0123456789abcdef", dryRun: false, candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW, events: [{ stage: "cycle", code: "meme-no-candidate", elapsedMs: 1 }] };
  expect(runSummary({ ...base, reason: "meme-no-candidate" } as Parameters<typeof runSummary>[0])).toBe("0 sent to the model after every check · 0 paper entries · 0 paper exits");
  expect(runSummary({ ...base, reason: "no-candidates", events: [] } as Parameters<typeof runSummary>[0])).toMatch(/^0 shortlisted · /u);
});

// Operator hotfix 2026-10-07: the run-log filters classify paper meme cycles (paper trades are trades, never failures; model answers are LLM decisions).
it("run-log filters: paper entries and exits are Succeeded and Trades (not Failed); data and Binance failures are Failed; meme model answers are LLM decisions", async () => {
  const { hasLlmDecision, runFailed, tradeCards, TradeRunLog } = await import("@/components/trade/TradeRunLog");
  const base = { dryRun: false, candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW };
  const ev = (stage: string, code: string, extra: Record<string, unknown> = {}) => ({ stage, code, elapsedMs: 1, ...extra });
  const runs = [
    { ...base, id: "entry", reason: "meme-entered", entries: 1, candidates: 1, events: [ev("entry-llm", "meme-llm:buy_now", { token: MEME, confidence: 85, model: "qwen3.7-flash" }),
      ev("route", "meme-cost-measured", { token: MEME }), ev("buy", "meme-paper-entry", { token: MEME })] },
    { ...base, id: "exit", reason: "meme-no-candidate", exits: 1, events: [ev("sell", "meme-exit:flow-flip", { token: MEME })] },
    { ...base, id: "reject", reason: "meme-llm:reject", candidates: 1, events: [ev("entry-llm", "meme-llm:reject")] },
    { ...base, id: "data", reason: "meme-data:shortlist", events: [] },
    { ...base, id: "refused", reason: "meme-no-candidate", events: [ev("route", "meme-refused:SERVICE_ERROR", { token: MEME })] },
    { ...base, id: "waiting", reason: "meme-data:no-candidates", events: [] },
    { ...base, id: "quiet", reason: "meme-no-candidate", events: [ev("cycle", "meme-no-candidate")] },
  ] as Parameters<typeof runSummary>[0][];
  const ids = (pick: (run: Parameters<typeof runSummary>[0]) => boolean) => runs.filter(pick).map(run => run.id);
  const { runSucceeded } = await import("@/components/trade/TradeRunLog");
  expect(ids(runSucceeded)).toEqual(["entry", "exit"]);
  expect(ids(runFailed)).toEqual(["data", "refused"]);
  expect(ids(hasLlmDecision)).toEqual(["entry", "reject"]);
  expect(tradeCards(runs).map(card => [card.side, card.paper, card.detail])).toEqual([["buy", true, null], ["sell", true, "sellers took over"]]);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<TradeRunLog runs={runs} symbols={{ [MEME]: "MEME" }} />));
  const trades = [...host.querySelectorAll(".fl-run-filters button")].find(b => b.textContent === "Trades") as HTMLButtonElement;
  await act(async () => { trades.click(); });
  for (const want of ["Paper bought MEME", "Paper sold MEME · sellers took over", "Model: buy now, 85% confidence (qwen3.7-flash)", "No transaction: paper trade."]) expect(host.textContent ?? "").toContain(want);
  await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgenticPublicScreen } from "./AgenticPublicScreen";

vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({}) }));
vi.mock("@/components/MarketChart", () => ({
  MarketChart: ({ priceLines = [] }: { readonly priceLines?: readonly { readonly price: number; readonly title: string }[] }) => <div data-testid="market-chart" data-price-lines={JSON.stringify(priceLines)}>Chart</div>,
}));
const NOW = 1_900_000_000_000, W = "0x1111111111111111111111111111111111111111", E = 10n ** 18n, NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const HASH = `0x${"b".repeat(64)}`;
type Patch = Record<string, unknown>;
/** The plane's agent.dca block (AGENTIC-DCA R3.10) for N = 4 orders, one filled level, a resting level, a cancelled level and a held level. */
const dca = (patch: Patch = {}, round: Patch | null = {}) => ({
  token: NVDAB, symbol: "NVDAB", fee: 2500, usdtIsToken0: false, mark: { e8: "22300000000", block: "100" },
  settings: { stepBps: 100, takeProfitBps: 150, baseWei: (25n * E).toString(), orderWei: (10n * E).toString(), maxOrders: 4, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: 1500 },
  round: round === null ? null : { roundNo: 2, phase: "active", closeCause: null, openedAt: NOW, p0E8: "22337000000", avgCostE8: "22400000000", tpTargetE8: "22736000000", costUsdtWei: (35n * E).toString(),
    stockHeldWei: (E / 10n).toString(), realizedPnlWei: null,
    levels: [
      { levelNo: 1, levelPriceE8: "22113630000", state: "filled", priceE8: "22113630000", usdtWei: (10n * E).toString(), stockWei: (E / 50n).toString(), txHash: HASH, closedBy: null },
      { levelNo: 2, levelPriceE8: "21900000000", state: "resting", priceE8: "21900000000", usdtWei: (10n * E).toString(), stockWei: "0", txHash: null, closedBy: null },
      { levelNo: 3, levelPriceE8: "21700000000", state: "cancelled", priceE8: "21700000000", usdtWei: (10n * E).toString(), stockWei: "0", txHash: null, closedBy: "binance" },
      { levelNo: 4, levelPriceE8: "21500000000", state: "held", priceE8: "21500000000", usdtWei: (10n * E).toString(), stockWei: "0", txHash: null, closedBy: null }],
    tp: { state: "resting", priceE8: "22736000000", usdtWei: "0", stockWei: (E / 10n).toString(), txHash: null, closedBy: null },
    base: { usdtWei: (25n * E).toString(), stockWei: (E / 10n).toString(), txHash: HASH, atMs: NOW }, ...round },
  rounds: { settled: 1, realizedPnlWei: E.toString(), markedPnlWei: E.toString(), lastSettledAt: NOW,
    history: [{ roundNo: 1, closeCause: "take-profit", openedAt: NOW - 1, settledAt: NOW, filledLevels: 1, realizedPnlWei: E.toString(), markedPnlWei: E.toString() }] },
  equity: { equityWei: (60n * E).toString(), baselineWei: (65n * E).toString(), stopAtWei: (55n * E).toString(), markE8: "22300000000", readingBlock: "100" },
  wallet: { usdtWei: (20n * E).toString(), stockWei: "1" }, walletReason: null, reason: null, heldOrders: 0,
  history: { fills: [{ atMs: NOW, roundNo: 2, kind: "base", levelNo: null, side: "buy", usdtWei: (25n * E).toString(), stockWei: "1", txHash: HASH }] },
  actions: [{ kind: "start", roundNo: 2, state: "finished", txHash: HASH, createdAt: NOW, updatedAt: NOW }],
  keepAlive: { lastActivityAtMs: NOW, dueAtMs: NOW + 43_200_000, lastPaidAtMs: NOW - 3_600_000 }, ...patch });
const wallet = (agentPatch: Patch = {}, block: unknown = dca()) => ({ wallet: W, custody: "binance-agentic", agent: { name: "Public DCA", status: "running", holdCode: null, endReason: null, termDays: 7,
  termEndAction: "keep", hireStartedAtMs: NOW, entryCutoffAtMs: NOW + 597_600_000, hireEndsAtMs: NOW + 604_800_000, connection: "connected", lastProbeAtMs: NOW, heldOrders: 0, logoutPending: false,
  settings: { executionModel: "tradfi", primaryModel: "qwen3.7-flash", capitalQuoteWei: (65n * E).toString(), entryWei: (25n * E).toString(), maxOpenPositions: 1, slippageBps: 100,
    stopLossBps: null, takeProfitBps: null, maxHoldSec: null },
  cmc: { authorizedTotalWei: (E / 5n).toString(), settledWei: (E / 100n).toString(), remainingWei: (19n * E / 100n).toString(), status: "ready" },
  summary: { openPositions: 0, maxOpenPositions: 1, closedTrades: 0, wins: null, winRateBps: null, grossDeltaWei: null, grossComplete: true }, positions: [],
  runs: [{ id: "0123456789abcdef", dryRun: false, reason: "dca-no-tp;candidates=0", candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW, events: [] },
    { id: "0123456789abcdee", dryRun: false, reason: "dca-low-bnb;candidates=0", candidates: 0, refusals: 0, entries: 0, exits: 0, createdAt: NOW - 1, events: [] }],
  pinned: [{ address: NVDAB, symbol: "NVDAB" }], dca: block, ...agentPatch } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(data: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/token-icons") ? Response.json({ data: {} }) : Response.json({ data })));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgenticPublicScreen wallet={W} />));
  const tab = async (label: string) => act(async () => { ([...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement).click(); });
  return { host, tab, done: async () => { await act(async () => root.unmount()); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}
const TABS = ["Orders", "Ongoing", "Rounds", "Order history", "Holdings", "Run log"];
const forbidden = ["Close on chain", "Pull resting orders", "Pause", "Remove", "Edit", "passkey", "renew", "Renew", "Resume"];
const noteText = {
  stopLoss: "Stopped by stop loss: nothing was sold. Your stock and USDT stay in your Agentic Wallet.",
  termEnd: "Term ended: nothing was sold and your holdings stay in your Agentic Wallet.",
  ownerEnd: "Ended: you signed 4lpha out in the Binance App. 4lpha places no more orders; your holdings stay in your Agentic Wallet.",
  held: "3 order(s) are held for review; the agent places nothing new until an operator resolves them.",
};
const notes = (host: HTMLElement): string[] => [...host.querySelectorAll('[role="note"][data-testid^="dca-ro-"]')].map((n) => n.textContent ?? "");

it("an Auto DCA hire renders the Altana stat row and DCA detail read-only: kicker, no AI metrics or tabs, no order ids, no owner door on any tab", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, tab, done } = await render(wallet());
  for (const text of ["Public DCA", "Read-only", "Auto DCA · NVDAB", "Current round", "Total Delegated", "65 USDT", "TradFi - Auto DCA", "PnL since hire", "Average price", "Holding 0.1 NVDAB", "Market price", ...TABS]) expect(host.textContent).toContain(text);
  for (const gone of ["Open Positions", "Closed Positions", "Kept Positions", "CMC x402", "Win rate", "Session expired", "Auto DCA data unavailable.", "ERC-8004"]) expect(host.textContent).not.toContain(gone);
  expect(host.querySelector(".fl-hired-actions")!.querySelectorAll("button")).toHaveLength(0);
  // Orders: no strategy id, no Pancake link, prices from the plane's one trigger price, the level words.
  const rows = [...host.querySelectorAll('[data-testid="dca-order"]')].map((row) => row.textContent ?? "");
  expect(rows[0]).toContain("Take profit"); expect(rows[0]).toContain("227.36 USDT");
  expect(rows[2]).toContain("221.14 USDT"); expect(rows[2]).toContain("filled");
  expect(rows[3]).toContain("resting");
  expect(rows[4]).toContain("cancelled");
  expect(rows[5]).toContain("held");
  for (const row of rows) expect(row).not.toMatch(/#\d{3,}/u);
  expect(host.querySelector("a.fl-lp-nft-link")).toBeNull();
  expect(host.innerHTML).not.toContain("pancakeswap");
  for (const label of TABS) {
    await tab(label);
    for (const gone of [...forbidden, "Price not known yet", "Needs the updated execution plane."]) expect(host.textContent, `${label}: ${gone}`).not.toContain(gone);
    expect(host.querySelectorAll("input, select")).toHaveLength(0);
  }
  await done();
});

it("Show chart draws ENTRY, the armed TP and every armed (resting) DCA level at its trigger price, nothing for filled, cancelled or held levels", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, tab, done } = await render(wallet());
  await tab("Show chart");
  const lines = JSON.parse(host.querySelector('[data-testid="market-chart"]')!.getAttribute("data-price-lines")!) as { price: number; title: string }[];
  expect(lines.map((line) => [line.title, line.price])).toEqual([["ENTRY", 224], ["TP", 227.36], ["DCA #2", 219]]);
  await done();
});

it("Orders cells (operator 2026-10-04): no placeholder line under the order name, and an amount the order has not moved is a dash, never 0", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, done } = await render(wallet());
  const cells = [...host.querySelectorAll('[data-testid="dca-order"]')].map((row) => [...row.children].map((cell) => cell.textContent ?? ""));
  for (const row of cells) expect(row[0]).toMatch(/^(Take profit|Base order|DCA #\d)$/u);
  const tp = cells.find((row) => row[0] === "Take profit")!;
  expect(tp[3]).toBe("—"); expect(tp[4]).toContain("0.1 NVDAB");
  const resting = cells.find((row) => row[0] === "DCA #2")!;
  expect(resting[3]).toBe("10 USDT"); expect(resting[4]).toBe("—");
  const filled = cells.find((row) => row[0] === "DCA #1")!;
  expect(filled[3]).toBe("10 USDT"); expect(filled[4]).not.toBe("—");
  for (const row of cells) { expect(row[3]).not.toMatch(/^0 USDT$/u); expect(row[4]).not.toMatch(/^0 NVDAB$/u); }
  await done();
});

it("shows the Altana-shaped round card and ladder from the adapter: take profit and every level priced, nothing 'not placed yet'", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, tab, done } = await render(wallet());
  expect(host.textContent).not.toContain("target - not placed yet");
  expect(host.textContent).not.toContain("not placed yet");
  await tab("Ongoing");
  expect(host.textContent).toContain("Take-profit order");
  expect(host.textContent).toContain("Sell 0.1 NVDAB at 227.36 USDT");
  expect(host.textContent).toContain("DCA order #2");
  await done();
});

it("the Holdings tab carries the keep-alive panel: budget summary and the last paid time, or none yet", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  let page = await render(wallet());
  await page.tab("Holdings");
  const panel = page.host.querySelector('[data-testid="dca-keepalive-panel"]')!;
  expect(panel.textContent).toContain("CMC keep-alive (x402)");
  expect(panel.textContent).toContain("Ready");
  expect(panel.textContent).toContain("Remaining 0.19 USDT"); expect(panel.textContent).toContain("Settled 0.01 USDT"); expect(panel.textContent).toContain("Total 0.2 USDT");
  expect(panel.textContent).toContain(`Last paid ${new Date(NOW - 3_600_000).toLocaleString()}`);
  expect(page.host.querySelector('[data-testid="dca-wallet"]')).not.toBeNull();
  await page.done();
  page = await render(wallet({}, dca({ keepAlive: { lastActivityAtMs: NOW, dueAtMs: NOW + 43_200_000, lastPaidAtMs: null } })));
  await page.tab("Holdings");
  expect(page.host.querySelector('[data-testid="dca-keepalive-panel"]')!.textContent).toContain("Last paid none yet");
  await page.done();
});

it("a healthy running round shows no note, and the end notes show under their own end reason", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  let page = await render(wallet());
  expect(notes(page.host)).toEqual([]);
  expect(page.host.textContent).not.toContain("Stopped by stop loss");
  await page.done();
  for (const [endReason, label, text] of [["stop-loss", "Stopped by stop loss", noteText.stopLoss], ["term-ended", "Ended", noteText.termEnd], ["owner-signed-out", "Ended", noteText.ownerEnd]] as const) {
    page = await render(wallet({ status: "ended", endReason }));
    expect(notes(page.host)).toEqual([text]);
    expect(page.host.textContent).toContain(label);
    if (endReason !== "stop-loss") expect(page.host.textContent).not.toContain("Stopped by stop loss");
    await page.done();
  }
});

it("held orders show their note; a zero count shows nothing; the deleted notes (stopping, unverified, unattributed, no take profit) never appear", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  let page = await render(wallet({}, dca({ heldOrders: 3 }, { phase: "stopping" })));
  expect(notes(page.host)).toEqual([noteText.held]);
  for (const gone of ["Stop loss triggered", "could not be confirmed cancelled", "did not place", "no take profit order right now", "cancel it there", "sell it in the Binance App"]) expect(page.host.textContent).not.toContain(gone);
  await page.done();
  page = await render(wallet({}, dca({ heldOrders: 0 })));
  expect(notes(page.host)).toEqual([]);
  await page.done();
});

it("a hire with no round yet says it is setting up, with the resting buys of its order count; an ended hire with no round does not", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  let page = await render(wallet({}, dca({}, null)));
  expect(notes(page.host)).toEqual(["Setting up: the base order buys at market, then the agent watches the take profit and 2 buy level(s)."]);
  await page.done();
  page = await render(wallet({}, dca({ settings: { ...dca().settings, maxOrders: 3 } }, null)));
  expect(notes(page.host)).toEqual(["Setting up: the base order buys at market, then the agent watches the take profit and 1 buy level(s)."]);
  await page.done();
  page = await render(wallet({ status: "ended", endReason: "term-ended" }, dca({}, null)));
  expect(notes(page.host)).toEqual([noteText.termEnd]);
  await page.done();
});

it("the Run log tab words the Agentic codes and drops the owner actions", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, tab, done } = await render(wallet());
  await tab("Run log");
  expect(host.textContent).toContain("Held: the round has no take profit order right now");
  expect(host.textContent).toContain("Waiting: BNB for gas is low");
  for (const gone of forbidden) expect(host.textContent).not.toContain(gone);
  await done();
});

it("a malformed block shows the unavailable line and no figures; an AI page without the key is untouched", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  for (const block of [null, "x", { ...dca(), symbol: 1 }, { ...dca(), rounds: null }]) {
    const page = await render(wallet({}, block));
    expect(page.host.textContent).toContain("Auto DCA data unavailable.");
    expect(page.host.textContent).not.toContain("Current round");
    expect(page.host.textContent).not.toContain("Win rate");
    await page.done();
  }
  const { dca: _removed, ...agent } = wallet().agent;
  const { host, done } = await render({ wallet: W, custody: "binance-agentic", agent });
  expect(host.textContent).toContain("Win rate");
  expect(host.textContent).toContain("Open Positions");
  expect(host.textContent).not.toContain("Auto DCA");
  expect(host.textContent).not.toContain("Current round");
  await done();
});

const SKHYB = "0x" + "5".repeat(40);
/** The R3.10 and R31.3 vector: the SKHYB agent (base 25, four orders of 10, capital 65), P0 194.860163, 0.128297131828875825 SKHYB in the wallet, mark 196. */
const skhyb = (patch: Patch = {}, round: Patch | null = {}) => dca({ token: SKHYB, symbol: "SKHYB", mark: { e8: "19600000000", block: "100" }, wallet: { usdtWei: (30n * E).toString(), stockWei: "128297131828875825" },
  equity: { equityWei: "65146238000000000000", baselineWei: (65n * E).toString(), stopAtWei: null, markE8: "19600000000", readingBlock: "100" },
  rounds: { settled: 0, realizedPnlWei: "0", markedPnlWei: "146238000000000000", lastSettledAt: null }, ...patch },
  round === null ? null : { roundNo: 1, avgCostE8: "19486016300", stockHeldWei: "128297131828875825", costUsdtWei: (25n * E).toString(), levels: [], tp: null, ...round });

it("R3.10 vector: the five tiles of the SKHYB agent at a mark of 196: delegated 65 USDT, PnL +0.15 USDT (+0.22%), average price 194.86 USDT holding 0.128 SKHYB, market price 196 USDT", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, done } = await render(wallet({}, skhyb()));
  const tiles = host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  for (const text of ["Total Delegated65 USDT", "Execution modelTradFi - Auto DCA", "+0.15 USDT", "+0.22%", "Average price194.86 USDT", "Holding 0.128 SKHYB", "Market price196 USDT"]) expect(tiles).toContain(text);
  expect(host.textContent).not.toContain("ERC-8004");
  await done();
});

it("R31.3 vector: after a stop the round is nulled for the PnL tile (rounds rule) and the Average-price tile keeps the holding with its worth at the mark", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, done } = await render(wallet({ status: "ended", endReason: "stop-loss" }, skhyb({ equity: null }, { phase: "stopped", closeCause: "stop-loss" })));
  const tiles = host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).toContain("Average price194.86 USDT");
  expect(tiles).toContain("Holding 0.128 SKHYB, worth 25.15 USDT at the market price");
  expect(tiles).toContain("+0.15 USDT");
  expect(tiles).not.toContain("No round is open.");
  expect(host.textContent).toContain("Stopped by stop loss");
  await done();
});

it("R17.2: a term end whose last round SETTLED (no round open) shows the wallet holding, not the settled round, and an ended agent with no round does too", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  let page = await render(wallet({ status: "ended", endReason: "term-ended" }, skhyb({ equity: null }, { phase: "settled", closeCause: "take-profit", stockHeldWei: "0", avgCostE8: null })));
  let tiles = page.host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).toContain("Holding 0.128 SKHYB, worth 25.15 USDT at the market price");
  expect(tiles).not.toContain("No round is open.");
  await page.done();
  page = await render(wallet({ status: "ended", endReason: "term-ended" }, skhyb({ equity: null }, null)));
  tiles = page.host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).toContain("Holding 0.128 SKHYB, worth 25.15 USDT at the market price");
  await page.done();
  page = await render(wallet({}, skhyb({}, { phase: "settled", closeCause: "take-profit" })));
  tiles = page.host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).not.toContain("at the market price");
  await page.done();
});

it("R31.3: with the wallet unreadable the holding note is the chain-unreadable reason, and with no stock bought the value is a dash with its reason", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  let page = await render(wallet({ status: "ended", endReason: "term-ended" }, skhyb({ wallet: null, walletReason: "wallet-unreadable" }, { phase: "ended", closeCause: "term-end" })));
  let tiles = page.host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).toContain("Average price194.86 USDT");
  expect(tiles).toContain("The chain could not be read; refresh in a moment.");
  expect(tiles).not.toMatch(/Holding 0\.\d+ SKHYB/u);
  await page.done();
  page = await render(wallet({ status: "ended", endReason: "term-ended" }, skhyb({}, { phase: "interrupted", closeCause: "owner-end", avgCostE8: null, stockHeldWei: "0" })));
  tiles = page.host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).toContain("Average price—");
  expect(tiles).toContain("no stock was bought in the last round");
  await page.done();
});

it("a failed wallet read on a running agent shows the plane's wallet-unreadable reason as the chain-unreadable note, never a bare dash", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const { host, tab, done } = await render(wallet({}, skhyb({ wallet: null, walletReason: "wallet-unreadable", mark: null, equity: null, reason: "mark-unavailable" })));
  const tiles = host.querySelector(".fl-trade-metrics")!.textContent ?? "";
  expect(tiles).toContain("The chain could not be read; refresh in a moment.");
  await tab("Holdings");
  await done();
});

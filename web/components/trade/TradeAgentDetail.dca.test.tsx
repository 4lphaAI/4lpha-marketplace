// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentDetailView, DetailMetric } from "@/lib/exec/agent-detail";
import { dcaPullDoor, type TradeDcaView, type TradeSettings, type TradeView } from "@/lib/trade";
import { runLabel } from "./TradeRunLog";

vi.mock("@/components/MarketChart", () => ({
  MarketChart: ({ priceLines = [] }: { readonly priceLines?: readonly { readonly price: number; readonly color: string; readonly title: string }[] }) => (
    <div data-testid="market-chart" data-price-lines={JSON.stringify(priceLines)} />
  ),
}));

import { TradeAgentDetail } from "./TradeAgentDetail";

// AUTO-DCA §14.3 + R2.16 + REVIEW2 conditions 9 and 16: the DCA detail states and the pull door.
const metric = (reason: string): DetailMetric => ({ value: null, reason });
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

function view(status: AgentDetailView["status"]): AgentDetailView {
  return {
    id: "auto-dca-01", status, httpRuntimeProfile: "trade-v1", hireSizingName: "trade-v1",
    walletAddress: "0x2222222222222222222222222222222222222222", sessionPublicKey: `0x${"33".repeat(64)}`, sessionExpiresAt: null,
    provisioning: false, actionDisabledReason: null, armMs: 1_000,
    dailyNativeLimit: metric("—"), recordedCycleDelta: metric("—"), grossPnl: metric("—"), grossPnlPercent: metric("—"), recordedCycles: metric("—"),
    levels: [], cycleHistoryAvailable: false, cycleNote: "—", gas: null, motions: [], sequences: [], positions: [],
  } as unknown as AgentDetailView;
}

const order = { tickLower: 0, tickUpper: 50, closedBy: null, usdtWei: "10000000000000000000", stockWei: "0", txHash: null } as const;

function dca(over: Partial<TradeDcaView> = {}): TradeDcaView {
  return {
    token: NVDAB, symbol: "NVDAB", fee: 2500, usdtIsToken0: false,
    settings: { stepBps: 100, takeProfitBps: 150, baseWei: "15000000000000000000", orderWei: "10000000000000000000", maxOrders: 4,
      triggerE8: null, rangeMinE8: "20000000000", rangeMaxE8: null, stopLossBps: 1_500 },
    round: { roundNo: 3, phase: "active", closeCause: null, openedAt: 1, unreliable: false, p0E8: "22337000000", avgCostE8: "22400000000",
      tpTargetE8: "22736000000", costUsdtWei: "15150000000000000000", stockHeldWei: "67000000000000000", realizedPnlWei: null,
      // `null`, not absent: this fixture is a CURRENT plane with no base fill recorded
      // (distinct from `undefined`, which the redesigned-page describe below uses to
      // mean an older plane that lacks the NEW field entirely, LOW 4).
      base: null,
      levels: [
        { ...order, levelNo: 1, levelPriceE8: "22113630000", state: "resting", tokenId: "11" },
        { ...order, levelNo: 2, levelPriceE8: "21845600000", state: "filled", tokenId: "12", usdtWei: "0", stockWei: "45000000000000000" },
        { ...order, levelNo: 3, levelPriceE8: "21500000000", state: "skipped", tokenId: null },
        { ...order, levelNo: 4, levelPriceE8: "19900000000", state: "below-range", tokenId: null },
      ],
      tp: { ...order, state: "resting", tokenId: "10", rangeLowE8: "22740000000", rangeHighE8: "22850000000", usdtWei: "0", stockWei: "67000000000000000" } },
    rounds: { settled: 2, realizedPnlWei: "310000000000000000", lastSettledAt: 1 },
    equity: { equityWei: "54000000000000000000", baselineWei: "55000000000000000000", stopAtWei: "46750000000000000000", markE8: "22300000000", readingBlock: "100" },
    wallet: { usdtWei: "20000000000000000000", stockWei: "1000000000000000" },
    reason: null, inFlight: null, unknownAction: null, ...over,
  };
}

function trade(d: TradeDcaView, draining = false): TradeView {
  return {
    settings: { name: "Auto DCA 01", executionModel: "tradfi", settlementAsset: "USDT", tradeMode: "dca" } as TradeSettings,
    dca: d, open: [], closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: 1, observedAt: null },
    lifecycle: { draining, drainingAt: draining ? 1 : null }, pendingIntents: [],
  };
}

async function render(v: AgentDetailView, t: TradeView, extra: { readonly planeUnreachable?: boolean; readonly pull?: (tokenId?: string) => void; readonly togglePause?: () => void } = {}) {
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
  await act(async () => root.render(<TradeAgentDetail agentId={v.id} view={v} trade={t} busy={false} removed={false} message="" signedOut={false}
    go={() => undefined} signIn={async () => undefined} refresh={async () => undefined} togglePause={extra.togglePause ?? (() => undefined)}
    remove={() => undefined} sellNow={() => undefined} saveSettings={async () => undefined}
    {...(extra.pull === undefined ? {} : { pullDcaOrders: extra.pull })} planeUnreachable={extra.planeUnreachable === true} />));
  return { host, done: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); } };
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);

describe("the pull door's visibility (R2.11, condition 9)", () => {
  it("shows while paused or with the plane unreachable, hides while draining, and asks an armed agent to pause first", () => {
    expect(dcaPullDoor({ status: "paused", draining: false, planeUnreachable: false })).toBe("show");
    expect(dcaPullDoor({ status: "armed", draining: false, planeUnreachable: true })).toBe("show");
    expect(dcaPullDoor({ status: "armed", draining: false, planeUnreachable: false })).toBe("pause-first");
    expect(dcaPullDoor({ status: "paused", draining: true, planeUnreachable: false })).toBe("removing");
    expect(dcaPullDoor({ status: "armed", draining: true, planeUnreachable: true })).toBe("removing");
  });

  it("renders the door, its all-or-nothing copy and the per-order fallback only when shown", async () => {
    const pull = vi.fn();
    const paused = await render(view("paused"), trade(dca()), { pull });
    try {
      expect(paused.host.querySelector('[data-testid="dca-pull-note"]')?.textContent).toContain("all or nothing");
      await act(async () => { button(paused.host, "Pull resting orders")!.click(); });
      expect(pull).toHaveBeenCalledWith();
      const closes = [...paused.host.querySelectorAll("button")].filter((entry) => entry.textContent === "Close on chain");
      expect(closes).toHaveLength(2);
      await act(async () => { closes[0]!.click(); });
      expect(pull).toHaveBeenLastCalledWith("10");
    } finally { await paused.done(); }

    const armed = await render(view("armed"), trade(dca()), { pull });
    try {
      expect(button(armed.host, "Pull resting orders")).toBeUndefined();
      expect(button(armed.host, "Close on chain")).toBeUndefined();
      expect(armed.host.textContent).not.toContain("Pause first to pull resting orders");
    } finally { await armed.done(); }

    const down = await render(view("armed"), trade(dca()), { pull, planeUnreachable: true });
    try { expect(button(down.host, "Pull resting orders")).toBeDefined(); } finally { await down.done(); }

    const draining = await render(view("paused"), trade(dca(), true), { pull });
    try {
      expect(button(draining.host, "Pull resting orders")).toBeUndefined();
      expect(button(draining.host, "Close on chain")).toBeUndefined();
      expect(draining.host.querySelector('[data-testid="dca-removing"]')?.textContent).toBe("Remove in progress");
    } finally { await draining.done(); }
  });
});

describe("the DCA detail states (§14.3, R2.11, R2.12, R2.16)", () => {
  it("shows the round, every level state, the TP, both assets, PnL, and the exact paused banner", async () => {
    const page = await render(view("paused"), trade(dca()));
    try {
      const text = page.host.textContent ?? "";
      expect(text).toContain("Auto DCA · NVDAB");
      expect(page.host.querySelector('[data-testid="dca-status"]')).toBeNull();
      expect(page.host.querySelector('[data-testid="dca-paused"]')?.textContent).toBe("Paused. Your resting orders keep trading on chain: a DCA level can still buy and the take profit can still sell. The stop loss does not run while paused. To stop everything, pull the resting orders.");
      const rows = [...page.host.querySelectorAll('[data-testid="dca-order"]')].map((row) => row.textContent ?? "");
      expect(rows[0]).toContain("Take profit");
      expect(rows[1]).toContain("resting");
      expect(rows[2]).toContain("filled");
      expect(rows[3]).toContain("skipped (price moved past it)");
      expect(rows[4]).toContain("skipped (below your price range)");
      // Operator 2026-09-25: the wallet balances moved out of the round card into one panel beside the run log.
      expect(text).not.toContain("Wallet USDT");
      // DCA-DETAIL: capital is not on this fixture's settings, so the PnL-since-hire tile dashes with its reason.
      expect(text).toContain("Capital is not recorded for this agent.");
      // DCA-DETAIL: "+0.31 USDT" moved from a tile into the Rounds tab header.
      await act(async () => { button(page.host, "Rounds")!.click(); });
      expect(page.host.textContent).toContain("+0.31 USDT");
      expect(page.host.querySelector('[data-testid="dca-wallet"]')).toBeNull();
      await act(async () => { button(page.host, "Holdings")!.click(); });
      expect(page.host.querySelector('[data-testid="dca-wallet"]')?.textContent).toContain("Holdings");
      expect(page.host.querySelector('[data-testid="dca-wallet"]')?.textContent).toContain("USDT holdings");
      // AUTO-DCA R3.8 (D-R3-3): wallet USDT 20 + the resting L1's 10; the filled, skipped and below-range levels add nothing.
      expect(page.host.querySelector('[data-testid="dca-wallet"]')?.textContent).toContain("USDT holdings30 USDTwallet and resting DCA orders");
      // DCA-DETAIL: the stop-loss cell's note reads "stop at", not "stop loss at".
      expect(text).toContain("stop at 46.75 USDT");
    } finally { await page.done(); }
  });

  it("names the unknown, unreliable and collected-elsewhere states with their doors, and dashes unread figures with a reason", async () => {
    const base = dca();
    const page = await render(view("armed"), trade(dca({
      unknownAction: { kind: "fill", actionKey: "dca:a:3:4", note: null },
      round: { ...base.round!, unreliable: true, levels: base.round!.levels.map((level) => level.levelNo === 2 ? { ...level, closedBy: "elsewhere" as const } : level) },
      equity: null, wallet: null, reason: "chain-unreadable",
    })));
    try {
      expect(page.host.querySelector('[data-testid="dca-unknown"]')?.textContent).toContain("pull the resting orders with your passkey, or Remove");
      expect(page.host.querySelector('[data-testid="dca-unreliable"]')?.textContent).toContain("not measurable");
      expect(page.host.querySelector('[data-testid="dca-elsewhere"]')?.textContent).toBe("An order was collected to another address. Revoke this agent's session.");
      expect(page.host.textContent).toContain("The chain could not be read; refresh in a moment.");
      expect(page.host.textContent).not.toMatch(/Equity\s*0/u);
    } finally { await page.done(); }
  });

  it("reads 'Paused by stop loss' for a stopped round and 'Removing' while draining", async () => {
    const base = dca();
    const stopped = await render(view("paused"), trade(dca({ round: { ...base.round!, phase: "stopped" } })));
    try { expect(stopped.host.querySelector('[data-testid="dca-status"]')?.textContent).toBe("Paused by stop loss — resume to continue"); }
    finally { await stopped.done(); }
    const removing = await render(view("paused"), trade(dca(), true));
    try { expect(removing.host.querySelector('[data-testid="dca-status"]')?.textContent).toBe("Removing"); }
    finally { await removing.done(); }
  });

  it("warns before a resume when equity already sits at or below the stop line", async () => {
    const toggle = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const page = await render(view("paused"), trade(dca({ equity: { ...dca().equity!, equityWei: "46000000000000000000" } })), { togglePause: toggle });
    try {
      await act(async () => { button(page.host, "Resume")!.click(); });
      expect(confirm).toHaveBeenCalledWith("Your equity is below your stop loss; resuming will pull all orders and pause again. Lower or turn off the stop loss first.");
      expect(toggle).not.toHaveBeenCalled();
    } finally { await page.done(); }
  });

  it("has run-log copy for every reason the DCA worker writes", () => {
    const reasons = ["dca-disabled", "dca-action-in-flight", "dca-submission-unknown", "dca-waiting", "dca-resumed", "dca-retry-backoff",
      "dca-retry-exhausted", "dca-round-unreliable", "dca-collected-elsewhere", "dca-order-mismatch", "dca-quote-deficit", "dca-plan-refused:bounds",
      "dca-uneconomic", "dca-trigger-not-reached", "dca-below-range", "dca-above-range", "dca-cash-low", "dca-cap-exhausted", "dca-native-cap-exhausted",
      "dca-no-route", "dca-placed", "dca-level-filled", "dca-round-closed", "dca-stop-loss", "dca-stop-loss:waiting-for-an-in-flight-submission",
      "dca-stopped", "dca-removing", "dca-removing:waiting-for-an-in-flight-submission", "dca-removing:waiting-for-an-unknown-mint",
      "dca-removing:sale-backoff", "dca-removing:cost-unavailable", "dca-removed", "dca-receipt-mismatch:receipt-contaminated"];
    for (const reason of reasons) expect(runLabel(reason), reason).not.toBe(reason.replace(/[-_]/gu, " "));
  });
});

describe("DCA-DETAIL: the redesigned page (2026-09-25)", () => {
  function tradeWithCapital(d: TradeDcaView, capitalQuoteWei: string): TradeView {
    const t = trade(d);
    return { ...t, settings: { ...(t.settings as TradeSettings), capitalQuoteWei } };
  }

  it("shows the five tiles: Total capital, the execution model, PnL since hire with %, Average price with holding, and a dashed Market price", async () => {
    const page = await render(view("armed"), tradeWithCapital(dca(), "55000000000000000000"));
    try {
      const text = page.host.textContent ?? "";
      expect(text).toContain("Total Delegated");
      expect(text).toContain("55 USDT");
      expect(text).toContain("TradFi - Auto DCA");
      // equity 54 USDT − capital 55 USDT = −1 USDT (dca()'s default equity.equityWei).
      expect(text).toContain("-1 USDT");
      expect(text).toContain("Average price");
      expect(text).toContain("224 USDT");
      expect(text).toContain("Holding 0.067 NVDAB");
      expect(text).toContain("Market price");
    } finally { await page.done(); }
  });

  it("dashes Market price with 'Needs the updated execution plane.' when mark is absent (an older plane), regardless of any stale reason", async () => {
    // MEDIUM 2: an absent NEW field always reads the structural reason, even when the
    // pre-existing `reason` field happens to carry an unrelated value.
    const page = await render(view("armed"), trade(dca({ reason: "chain-unreadable" })));
    try {
      const text = page.host.textContent ?? "";
      expect(text).toContain("Market price");
      expect(text).toContain("Needs the updated execution plane.");
      expect(text).not.toContain("The chain could not be read; refresh in a moment.");
    } finally { await page.done(); }
  });

  it("dashes Market price, the current-round price and Volume with the read reason when mark is a real null (a current-plane chain-read failure)", async () => {
    const page = await render(view("armed"), trade(dca({ mark: null, reason: "chain-unreadable" })));
    try {
      const text = page.host.textContent ?? "";
      const occurrences = text.split("The chain could not be read; refresh in a moment.").length - 1;
      // Market price tile, the current-round card's price line, and the Volume note.
      expect(occurrences).toBe(3);
    } finally { await page.done(); }
  });

  it("the progress label reads BASE + 1 OF 4 DCA ORDERS FILLED for the fixture round", async () => {
    const page = await render(view("armed"), trade(dca()));
    try { expect(page.host.textContent).toContain("BASE + 1 OF 4 DCA ORDERS FILLED"); }
    finally { await page.done(); }
  });

  it("MEDIUM 3: the stop-loss note shows the equity figure beside the stop line and the deposit", async () => {
    const page = await render(view("armed"), trade(dca()));
    try { expect(page.host.textContent).toContain("stop at 46.75 USDT · equity now 54 USDT · deposit 55 USDT"); }
    finally { await page.done(); }
  });

  it("MEDIUM 3: dashes the equity figure with its reason when equity has no source", async () => {
    const page = await render(view("armed"), trade(dca({ equity: null, reason: "no-active-round" })));
    try { expect(page.host.textContent).toContain("equity — No active round."); }
    finally { await page.done(); }
  });

  it("LOW 4: shows the Base order row with a dash and its reason when the NEW base field is absent (an older plane), instead of omitting it", async () => {
    const base = dca();
    const page = await render(view("armed"), trade(dca({ round: { ...base.round!, base: undefined } })));
    try {
      const rows = [...page.host.querySelectorAll('[data-testid="dca-order"]')];
      const baseRow = rows.find((row) => row.querySelector("strong")?.textContent === "Base order");
      expect(baseRow).toBeDefined();
      expect(baseRow!.textContent).toContain("Needs the updated execution plane.");
    } finally { await page.done(); }
  });

  it("places Current price above Entry price when the mark is above the average cost, and shows no Base row (operator 2026-09-25)", async () => {
    const page = await render(view("armed"), trade(dca({ mark: { e8: "22600000000", block: "1" } })));
    try {
      await act(async () => { button(page.host, "Ongoing")!.click(); });
      const text = page.host.textContent ?? "";
      expect(text.indexOf("Current price")).toBeGreaterThan(-1);
      expect(text.indexOf("Current price")).toBeLessThan(text.indexOf("Entry price"));
      expect(text).not.toContain("Base order");
    } finally { await page.done(); }
  });

  it("LOW 5: shows the Current price marker after every row when the mark sits below all of them", async () => {
    const page = await render(view("armed"), trade(dca({ mark: { e8: "15000000000", block: "1" } })));
    try {
      await act(async () => { button(page.host, "Ongoing")!.click(); });
      expect(page.host.textContent).toContain("Current price150 USDT"); // the mock's callout: label over value
      expect(page.host.textContent?.trim().endsWith("Current price150 USDT")).toBe(true);
    } finally { await page.done(); }
  });

  it("Orders lists TP, Base, then DCA #1..#4 once the NEW base field resolves, and links DCA #1's NFT", async () => {
    const base = dca();
    const withBase = trade(dca({ round: { ...base.round!, base: { usdtWei: "15000000000000000000", stockWei: "67000000000000000", txHash: "0xbase00", atMs: 1 } } }));
    const page = await render(view("armed"), withBase);
    try {
      const rows = [...page.host.querySelectorAll('[data-testid="dca-order"]')];
      expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Take profit", "Base order", "DCA #1", "DCA #2", "DCA #3", "DCA #4"]);
      expect(rows[1]!.textContent).toContain("filled");
      const link = rows[2]!.querySelector("a.fl-lp-nft-link") as HTMLAnchorElement | null;
      expect(link?.getAttribute("href")).toBe("https://pancakeswap.finance/liquidity/11");
    } finally { await page.done(); }
  });

  it("a resting order shows its edgePriceE8 and a pending one falls back to levelPriceE8", async () => {
    const base = dca();
    const levels = base.round!.levels.map((level) => level.levelNo === 1 ? { ...level, edgePriceE8: "22134664852" } : level);
    const page = await render(view("armed"), trade(dca({ round: { ...base.round!, levels } })));
    try {
      const rows = [...page.host.querySelectorAll('[data-testid="dca-order"]')];
      const l1 = rows.find((row) => row.querySelector("strong")?.textContent === "DCA #1")!;
      expect(l1.textContent).toContain("221.35 USDT"); // operator 2026-09-25: USDT prices show at most 2 decimals
      const l3 = rows.find((row) => row.querySelector("strong")?.textContent === "DCA #3")!;
      expect(l3.textContent).toContain("215");
    } finally { await page.done(); }
  });

  it("the pull door and Close on chain sit only in the Orders tab", async () => {
    const page = await render(view("paused"), trade(dca()), { pull: vi.fn() });
    try {
      expect(button(page.host, "Pull resting orders")).toBeDefined();
      expect(button(page.host, "Close on chain")).toBeDefined();
      await act(async () => { button(page.host, "Rounds")!.click(); });
      expect(button(page.host, "Pull resting orders")).toBeUndefined();
      expect(button(page.host, "Close on chain")).toBeUndefined();
    } finally { await page.done(); }
  });

  it("Rounds pages 7 rounds into 3 pages of 3", async () => {
    const base = dca();
    const history = Array.from({ length: 7 }, (_, i) => ({ roundNo: 7 - i, closeCause: "take-profit", openedAt: 1, settledAt: 2,
      filledLevels: 1, realizedPnlWei: "1000000000000000000", unreliable: false }));
    const page = await render(view("armed"), trade(dca({ rounds: { ...base.rounds, history } })));
    try {
      await act(async () => { button(page.host, "Rounds")!.click(); });
      const pageButtons = [...page.host.querySelectorAll("button")].filter((btn) => /^[1-3]$/u.test(btn.textContent ?? ""));
      expect(pageButtons).toHaveLength(3);
      expect(page.host.textContent).toContain("Round 7");
    } finally { await page.done(); }
  });

  it("LOW 7: shows a dash instead of the 1970 epoch for a fill with no known time", async () => {
    const page = await render(view("armed"), trade(dca({ history: { fills: [
      { atMs: null, roundNo: 3, kind: "base", levelNo: null, side: "buy", usdtWei: "1", stockWei: "1", txHash: null },
    ] } })));
    try {
      await act(async () => { button(page.host, "Order history")!.click(); });
      const rows = [...page.host.querySelectorAll(".fl-row")];
      expect(rows[0]?.querySelector("span")?.textContent).toBe("—");
      expect(page.host.textContent).not.toMatch(/1970|12\/31\/1969/u);
    } finally { await page.done(); }
  });

  it("LOW 8: says older fills are not loaded (not 'No fills recorded.') when a round's fills fell off the 60-fill cap", async () => {
    const base = dca();
    const cappedFills = Array.from({ length: 60 }, (_, i) => ({ atMs: 1_000 - i, roundNo: 99, kind: "level" as const, levelNo: 1, side: "buy" as const, usdtWei: "1", stockWei: "1", txHash: null }));
    const history = [{ roundNo: 2, closeCause: "take-profit" as const, openedAt: 1, settledAt: 2, filledLevels: 1, realizedPnlWei: "0", unreliable: false }];
    const page = await render(view("armed"), trade(dca({ rounds: { ...base.rounds, history }, history: { fills: cappedFills } })));
    try {
      await act(async () => { button(page.host, "Rounds")!.click(); });
      const roundButton = [...page.host.querySelectorAll("button")].find((entry) => entry.textContent?.startsWith("Round 2"));
      await act(async () => { roundButton!.click(); });
      expect(page.host.textContent).toContain("Older fills are not loaded.");
      expect(page.host.textContent).not.toContain("No fills recorded.");
    } finally { await page.done(); }
  });

  it("Order history shows rows and tx links from the NEW history.fills field", async () => {
    const page = await render(view("armed"), trade(dca({ history: { fills: [
      { atMs: 1, roundNo: 3, kind: "level", levelNo: 1, side: "buy", usdtWei: "10000000000000000000", stockWei: "45000000000000000", txHash: "0xfill01" },
    ] } })));
    try {
      await act(async () => { button(page.host, "Order history")!.click(); });
      const text = page.host.textContent ?? "";
      expect(text).toContain("DCA #1");
      const link = [...page.host.querySelectorAll("a")].find((a) => a.textContent?.includes("Tx"));
      expect(link?.getAttribute("href")).toBe("https://bscscan.com/tx/0xfill01");
    } finally { await page.done(); }
  });

  it("Show chart renders MarketChart with ENTRY, TP and DCA #1 price lines", async () => {
    const base = dca();
    const levels = base.round!.levels.map((level) => level.levelNo === 1 ? { ...level, edgePriceE8: "22134664852" } : level);
    const round = { ...base.round!, levels, tp: { ...base.round!.tp!, edgePriceE8: "23153424013" } };
    const page = await render(view("armed"), trade(dca({ round })));
    try {
      await act(async () => { button(page.host, "Show chart")!.click(); });
      const chart = page.host.querySelector('[data-testid="market-chart"]');
      const lines = JSON.parse(chart?.getAttribute("data-price-lines") ?? "[]") as readonly { readonly title: string }[];
      expect(lines.map((line) => line.title)).toEqual(expect.arrayContaining(["ENTRY", "TP", "DCA #1"]));
    } finally { await page.done(); }
  });

  it("shows 'Needs the updated execution plane.' where a NEW top-level field is absent (an older plane)", async () => {
    const page = await render(view("armed"), trade(dca()));
    try {
      await act(async () => { button(page.host, "Rounds")!.click(); });
      expect(page.host.textContent).toContain("Needs the updated execution plane.");
      await act(async () => { button(page.host, "Order history")!.click(); });
      expect(page.host.textContent).toContain("Needs the updated execution plane.");
      await act(async () => { button(page.host, "Run log")!.click(); });
      const trades = [...page.host.querySelectorAll("button")].find((btn) => btn.textContent === "Trades")!;
      await act(async () => { trades.click(); });
      expect(page.host.textContent).toContain("Needs the updated execution plane.");
    } finally { await page.done(); }
  });
});

describe("AUTO-DCA R4.7: a removed round's web surfaces", () => {
  it("a removed round's Rounds row shows the marked PnL and 'incl. unsold … marked at removal'", async () => {
    const base = dca();
    const history = [{ roundNo: 3, closeCause: "removed", openedAt: 1, settledAt: 2, filledLevels: 1,
      realizedPnlWei: "1000000000000000000", unreliable: false, unsoldStockWei: "500000000000000", markedPnlWei: "1200000000000000000" }];
    const page = await render(view("armed"), trade(dca({ rounds: { ...base.rounds, history, markedPnlWei: "1200000000000000000" } })));
    try {
      await act(async () => { button(page.host, "Rounds")!.click(); });
      expect(page.host.textContent).toContain("+1.2 USDT"); // the marked figure, not the +1.00 realized one
      expect(page.host.textContent).toContain("incl. unsold");
      expect(page.host.textContent).toContain("marked at removal");
    } finally { await page.done(); }
  });

  it("an unreliable removed round shows '—' and 'not measurable', never a number", async () => {
    const base = dca();
    const history = [{ roundNo: 3, closeCause: "removed", openedAt: 1, settledAt: 2, filledLevels: 1,
      realizedPnlWei: "1000000000000000000", unreliable: true, unsoldStockWei: "500000000000000", markedPnlWei: null }];
    const page = await render(view("armed"), trade(dca({ rounds: { ...base.rounds, history } })));
    try {
      await act(async () => { button(page.host, "Rounds")!.click(); });
      expect(page.host.textContent).toContain("not measurable");
    } finally { await page.done(); }
  });

  it("a legacy row (the new fields absent) shows realized, with no marked note", async () => {
    const base = dca();
    const history = [{ roundNo: 3, closeCause: "take-profit", openedAt: 1, settledAt: 2, filledLevels: 1, realizedPnlWei: "1000000000000000000", unreliable: false }];
    const page = await render(view("armed"), trade(dca({ rounds: { ...base.rounds, history } })));
    try {
      await act(async () => { button(page.host, "Rounds")!.click(); });
      expect(page.host.textContent).not.toContain("incl. unsold");
    } finally { await page.done(); }
  });

  it("PnL since hire uses rounds.markedPnlWei and notes 'incl. unsold …, marked at removal' when it differs from realized", async () => {
    const d = dca({ round: null, equity: null, rounds: { settled: 1, realizedPnlWei: "1000000000000000000", lastSettledAt: 1, markedPnlWei: "1200000000000000000" } });
    const t = trade(d);
    const withCapital: TradeView = { ...t, settings: { ...(t.settings as TradeSettings), capitalQuoteWei: "55000000000000000000" } };
    const page = await render(view("armed"), withCapital);
    try {
      expect(page.host.textContent).toContain("incl. unsold NVDAB, marked at removal");
    } finally { await page.done(); }
  });

  it("draining with no open round shows the 'nothing was sold' status line, and Holdings reads 'in the agent wallet'", async () => {
    const d = dca({ round: null });
    const page = await render(view("armed"), trade(d, true));
    try {
      expect(page.host.querySelector('[data-testid="dca-status"]')?.textContent).toContain("nothing was sold");
      await act(async () => { button(page.host, "Holdings")!.click(); });
      expect(page.host.textContent).toContain("in the agent wallet");
    } finally { await page.done(); }
  });

  it("the unknown note reads the Remove-specific copy while draining", async () => {
    const d = dca({ unknownAction: { kind: "remove", actionKey: "dca:x:1:3", note: null } });
    const page = await render(view("armed"), trade(d, true));
    try {
      expect(page.host.querySelector('[data-testid="dca-unknown"]')?.textContent).toContain("does not stop Remove");
    } finally { await page.done(); }
  });
});

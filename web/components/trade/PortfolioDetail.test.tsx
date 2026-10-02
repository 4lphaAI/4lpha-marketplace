// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseTradeHirePreviewEnvelope, parseTradeViewEnvelope, PORTFOLIO_ERROR_COPY, tradfiPortfolioNativeReserveWei, type TradeSettings, type TradeView } from "@/lib/trade";
import { PortfolioDetail, PortfolioSummary } from "./PortfolioDetail";
import { runLabel } from "./TradeRunLog";

const ATOMIC = 10n ** 18n;
const TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TOKEN2 = "0x80106cb3ead06659a5ad19df39d9b4733863b9b0";
const settings: TradeSettings = { name: "Smart Portfolio", executionModel: "tradfi", entryWei: (50n * ATOMIC).toString(),
  minEntryWei: ATOMIC.toString(), capitalQuoteWei: (50n * ATOMIC).toString(), maxOpenPositions: 1,
  minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: false, takeProfitBps: null, stopLossBps: null, maxHoldSec: null,
  breakEvenAfterTp: false, slippageBps: 100, gasPriority: "standard", instructions: null, skillMarkdown: null,
  primaryModel: "qwen3.7-flash", fallbackModel: "0gm-1.0-35b-a3b", crashProtection: false, settlementAsset: "USDT",
  cmcNewsEnabled: false, tradeMode: "portfolio", portfolioTokens: [TOKEN, TOKEN2], portfolioWeightsBps: [5000, 5000],
  portfolioDriftBps: 500, portfolioIntervalSec: 86400 };

const portfolio: NonNullable<TradeView["portfolio"]> = {
  tokens: [{ token: TOKEN, symbol: "NVDAB", targetBps: 5000, balanceAtomic: ATOMIC.toString(), valueWei: (25n * ATOMIC).toString(),
    valueReason: null, weightBps: 5000, driftBps: 0, displayName: "NVIDIA",
    initial: { quantityAtomic: null, quantityReason: "not-recorded", quoteWei: (20n * ATOMIC).toString(), quoteReason: null } },
    { token: TOKEN2, symbol: "MSFTB", targetBps: 5000, balanceAtomic: ATOMIC.toString(), valueWei: (25n * ATOMIC).toString(),
      valueReason: null, weightBps: 5000, driftBps: 0 }],
  capitalQuoteWei: (50n * ATOMIC).toString(), netInvestedWei: (50n * ATOMIC).toString(), cashCapWei: "0",
  walletUsdtWei: (10n * ATOMIC).toString(), portfolioCashWei: "0", idleUsdtWei: (10n * ATOMIC).toString(),
  stockValueWei: (50n * ATOMIC).toString(), totalValueWei: (50n * ATOMIC).toString(), pnlWei: "0", driftBps: 0,
  intervalSec: 86400, anchorMs: 1_000, currentSlot: 0, nextCheckAtMs: 86_401_000,
  check: { slot: 0, state: "rebalancing", maxDriftBps: 10_000, valueWei: (50n * ATOMIC).toString(), checkedAt: 1_000 },
  legs: [{ slot: 0, side: "sell", token: TOKEN, symbol: "NVDAB", amountWei: ATOMIC.toString(),
    quotedOutAtomic: ATOMIC.toString(), minOutAtomic: ATOMIC.toString(), proceedsAtomic: null,
    state: "projected", txHash: `0x${"11".repeat(32)}`, createdAt: 1_000,
    detail: { id: "sale", executionState: "UNKNOWN", executionReason: null, quantityAtomic: null, quantityReason: "not-recorded", quoteWei: null, quoteReason: "not-verified" } }],
};

describe("Smart Portfolio web wiring", () => {
  it("mirrors all twelve signed BNB day caps", () => {
    const table = [[86400, [8, 11, 17]], [43200, [10, 14, 22]], [28800, [12, 17, 27]], [14400, [18, 26, 42]]] as const;
    for (const [intervalSec, values] of table) for (const [index, tokenCount] of [2, 3, 5].entries())
      expect(tradfiPortfolioNativeReserveWei({ tokenCount, intervalSec })).toBe(BigInt(values[index]!) * 100_000_000_000_000n);
  });

  it("builds the signed deploy tuple, blocked reasons and interval mapping", () => {
    const source = readFileSync("components/screens/DeployAgentScreen.tsx", "utf8");
    for (const text of ["tradeMode: \"portfolio\" as const", "portfolioTokens: smartRows.map", "portfolioWeightsBps: smartRows.map",
      "portfolioDriftBps: Math.round(Number(values.drift) * 100)", "portfolioIntervalSec: smartInterval",
      "\"4h\": 14400", "\"8h\": 28800", "\"12h\": 43200", "Daily: 86400",
      "Pick 2 to 5 stocks.", "Each stock needs a whole percent of at least 10 %.", "Weights must add up to 100 %.",
      "Drift must be 0.5 % to 15 % in 0.5 % steps.", "Smart Portfolio has no demo engine."]) expect(source).toContain(text);
  });

  it("keeps portfolio cap and preview tuple local through the hire", () => {
    const source = readFileSync("components/deploy/HireTradeDeploy.tsx", "utf8");
    for (const text of ["isPortfolio ? portfolioCapDayWei", "portfolioTokens: params.settings.portfolioTokens?.join",
      "portfolioIntervalSec: String(params.settings.portfolioIntervalSec)", "preview.sizing.tradeMode === \"portfolio\"",
      "preview.pin.map((token) => token.address.toLowerCase()).join",
      "!isDca && !isPortfolio && v2NativeCapWei === null"]) expect(source).toContain(text);
  });

  it("the signed portfolio arrays cross the BFF as the unchanged owner envelope", () => {
    const hire = readFileSync("components/deploy/HireTradeDeploy.tsx", "utf8");
    const bff = readFileSync("app/api/agents/[id]/session/route.ts", "utf8");
    expect(hire).toContain("settings: hireSettings");
    expect(hire).toContain('signEnvelope("provisionAgent"');
    expect(bff).toContain("execOwnerMutation(`/agents/${encodeURIComponent(id)}/session`, rawBody)");
  });

  it("parses portfolio preview and rejects an incomplete sizing DTO", () => {
    const preview = { data: { capDayWei: "800000000000000", indicative: true,
      sizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", executionModel: "tradfi", entryWei: settings.entryWei,
        maxOpenPositions: 1, settlementAsset: "USDT", minEntryWei: settings.minEntryWei, capitalQuoteWei: settings.capitalQuoteWei,
        cmcNewsEnabled: false, grantedTokenCount: 2, platformFeeBps: 0, platformFeePerEntryWei: "0", platformFeeTotalWei: "0",
        tradeRelayFeePerSubmitWei: "100000000000000", capitalRequiredWei: settings.capitalQuoteWei, capitalShortfallWei: "0",
        nativeReserveWei: "800000000000000", nativeShortfallWei: "0", tradeMode: "portfolio", tokenCount: 2,
        intervalSec: 86400, depositQuoteWei: settings.capitalQuoteWei, ok: true },
      funding: { version: 1, observedAtSec: 1, registrationFeeWei: "0", registrations: 1,
        relayGasHeadroomWei: "0", requiredWei: "0", balanceWei: "0" },
      pin: [{ symbol: "NVDAB", address: TOKEN }, { symbol: "MSFTB", address: TOKEN2 }] } };
    expect(parseTradeHirePreviewEnvelope(preview).sizing.tradeMode).toBe("portfolio");
    expect(() => parseTradeHirePreviewEnvelope({ data: { ...preview.data, sizing: { ...preview.data.sizing, nativeReserveWei: undefined } } })).toThrow();
  });

  it("renders the managed allocation and seven-column holdings without forbidden controls", () => {
    const html = renderToStaticMarkup(<PortfolioDetail portfolio={portfolio} settings={settings} runs={[]}
      icons={{}} refresh={async () => undefined} />);
    for (const text of ["Allocation", "NVDAB", "MSFTB", "Cash", "Current", "Target", "Weight vs band", "Quantity", "Run log"]) expect(html).toContain(text);
    expect(html).not.toContain(">Initial<");
    expect(html).not.toContain("Managed cash");
    expect(html).not.toContain("At/outside band");
    expect(html).not.toContain("Initial quantity not recorded.");
    expect(html).not.toContain(">Sell<");
    expect(html).not.toContain(">Drain<");
    expect(parseTradeViewEnvelope({ data: { settings, portfolio, open: [], closed: [], runs: [], pinned: [],
      summary: {}, lifecycle: {}, pendingIntents: [], marketHours: {} } }).portfolio?.tokens).toHaveLength(2);
  });

  it("keeps Schedule and DCA market-hours copy while portfolio uses 24/7 copy", () => {
    const source = readFileSync("components/screens/DeployAgentScreen.tsx", "utf8");
    expect(source).toContain('const TF_ADV_RULES = { title: "Advanced settings", adv: true, note: "Execution routing. These never override wallet controls, slippage, stop-loss, or the market-hours guard."');
    expect(source).toContain('const TF_ADV_PORTFOLIO = { ...TF_ADV_RULES, note: "Execution routing. These never override wallet controls, slippage or stop-loss." }');
    expect(source).toContain("TF_RISK_RULES, TF_ADV_PORTFOLIO");
  });

  it("shows only current-check token refusals and clears them after a committed leg", () => {
    const run = (id: string, createdAt: number, stage: string, code: string, reason?: string) => ({
      id, createdAt, dryRun: false, reason: code, candidates: 0, refusals: 0, entries: 0, exits: 0,
      events: [{ stage, code, token: TOKEN, elapsedMs: 0, ...(reason === undefined ? {} : { reason }) }],
    });
    const render = (runs: TradeView["runs"]) => renderToStaticMarkup(<PortfolioDetail portfolio={portfolio} settings={settings}
      runs={runs} icons={{}} refresh={async () => undefined} />);
    const old = run("old", 900, "screen", "portfolio-refused", "portfolio-no-route");
    const refused = run("refused", 1_100, "screen", "portfolio-refused", "portfolio-cash-low");
    const committed = run("committed", 1_200, "buy", "committed");
    expect(render([old])).not.toContain("Wallet USDT is too low for a trade");
    expect(render([refused, old])).toContain("Wallet USDT is too low for a trade");
    expect(render([committed, refused, old])).not.toContain("Wallet USDT is too low for a trade");
    // FR-L1: a proof-conflict event carries a decision id as its reason; the row shows the code label.
    const conflict = run("conflict", 1_150, "screen", "portfolio-proof-conflict", "11111111-2222-3333-4444-555555555555");
    expect(render([conflict])).toContain("Sale proof belongs to another trade");
    expect(render([conflict])).not.toContain("11111111");
  });

  it("maps every portfolio and reused generic reason to dedicated copy", () => {
    const reasons = ["portfolio-disabled", "portfolio-token-not-granted", "portfolio-pending-intent", "portfolio-submission-unknown",
      "portfolio-held", "portfolio-done", "portfolio-hold", "portfolio-empty", "portfolio-quote-unavailable",
      "portfolio-legs-too-small", "portfolio-rebalanced", "portfolio-sold", "portfolio-bought", "portfolio-no-route", "portfolio-refused",
      "portfolio-capital-used", "portfolio-cap-exhausted", "portfolio-cash-low", "portfolio-rwa-unavailable",
      "portfolio-rwa-stale", "portfolio-issuer-not-trading", "portfolio-venue-stale", "portfolio-premium-unknown",
      "portfolio-premium-too-high", "portfolio_leg_taken", "portfolio_slot_changed", "portfolio_capital_exhausted",
      "portfolio_submission_unknown", "portfolio_pending_intent", "portfolio_slot_held", "portfolio_slot_done",
      "portfolio-replan", "portfolio-dry-run", "portfolio-proof-conflict", "settings_changed", "session_changed",
      "entry_budget_changed", "paused", "NATIVE_RESERVE", "QUOTE_DAILY_CAP", "GUARD_QUOTE_EXPIRED",
      "quote-meter-unavailable", "cost-unavailable", "data-plane-unavailable", "session-expiring", "session-expired", "dry-run"];
    for (const code of reasons) expect(runLabel(code), code).not.toBe(code.replace(/[-_]/gu, " "));
    for (const code of ["portfolio_disabled", "portfolio_token_unsupported", "portfolio_token_unquotable", "portfolio_no_sell"])
      expect(PORTFOLIO_ERROR_COPY[code]).toBeTruthy();
  });
});

describe("portfolio detail presentation", () => {
  it("renders distinct metric sources and excludes idle cash from allocation and drift", () => {
    const valued = { ...portfolio, capitalQuoteWei: (120n * ATOMIC).toString(), netInvestedWei: (45n * ATOMIC).toString(),
      stockValueWei: (60n * ATOMIC).toString(), portfolioCashWei: (20n * ATOMIC).toString(),
      idleUsdtWei: (7n * ATOMIC).toString(), walletUsdtWei: (27n * ATOMIC).toString(),
      totalValueWei: (80n * ATOMIC).toString(), pnlWei: (15n * ATOMIC).toString(),
      tokens: portfolio.tokens.map((row, index) => ({ ...row, valueWei: ((index === 0 ? 24n : 36n) * ATOMIC).toString(),
        weightBps: index === 0 ? 3000 : 4500, driftBps: index === 0 ? 4000 : 1000 })) };
    const summary = document.createElement("div");
    summary.innerHTML = renderToStaticMarkup(<PortfolioSummary portfolio={valued} settings={settings} status="armed" sessionExpiresAt={null} />);
    const metrics = [...summary.querySelectorAll(".fl-trade-metric")].map((tile) => [tile.querySelector(".fl-trade-kicker")?.textContent,
      tile.querySelector(".fl-trade-metric__value")?.textContent, tile.querySelector(".fl-trade-metric__note")?.textContent]);
    expect(metrics).toHaveLength(5);
    expect(metrics.map(([label, value]) => [label, value])).toEqual([
      ["Total Delegated", "120.00 USDT"], ["Execution model", "TradFi - Smart Portfolio"],
      ["PnL since hire", "+15.00 USDT"], ["Scheduled check", "Daily"], ["Rebalance when drift exceeds", "5.00%"],
    ]);
    expect(metrics[2]?.[2]).toBe("+33.33%");
    const render = (value: typeof valued) => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<PortfolioDetail portfolio={value} settings={settings} runs={[]} icons={{}} refresh={async () => undefined} />);
      return host;
    };
    const managed = render(valued), moreIdle = render({ ...valued, idleUsdtWei: (70n * ATOMIC).toString(), walletUsdtWei: (90n * ATOMIC).toString() });
    for (const host of [managed, moreIdle]) {
      const items = [...host.querySelectorAll(".fl-portfolio-allocation__item")];
      expect(items.map((item) => item.lastElementChild?.textContent)).toEqual(["30.00%", "45.00%", "25.00%"]);
      expect(items[2]?.textContent).toContain("Cash20.00 USDT");
      expect(host.textContent).not.toContain("Managed cash");
      expect(host.textContent).not.toContain("At/outside band");
      const cashRow = [...host.querySelectorAll(".fl-portfolio-row")].at(-1);
      expect(cashRow?.children[1]?.textContent).toBe("20.00 USDT");
      expect(cashRow?.children[2]?.textContent).toBe("20.00");
      const arcs = [...host.querySelectorAll('svg[aria-label="Managed portfolio allocation"] circle[stroke-dasharray]')];
      expect(arcs).toHaveLength(3);
      for (const [index, share] of [0.3, 0.45, 0.25].entries())
        expect(Number(arcs[index]?.getAttribute("stroke-dasharray")?.split(" ")[0])).toBeCloseTo(2 * Math.PI * 47 * share, 3);
      expect(host.querySelectorAll(".fl-portfolio-band")[0]?.getAttribute("aria-label")).toContain("relative drift −40.00%");
      expect(host.querySelectorAll(".fl-portfolio-band")[1]?.getAttribute("aria-label")).toContain("relative drift −10.00%");
    }
    expect(managed.querySelectorAll(".fl-portfolio-allocation__item")[2]?.textContent).toContain("7.00 USDT idle");
    expect(moreIdle.querySelectorAll(".fl-portfolio-allocation__item")[2]?.textContent).toContain("70.00 USDT idle");
  });

  it("shows signed, zero and unavailable PnL with only a positive percentage basis", () => {
    const metric = (pnlWei: string | null, netInvestedWei: string) => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<PortfolioSummary portfolio={{ ...portfolio, pnlWei, netInvestedWei }} settings={settings} status="armed" sessionExpiresAt={null} />);
      return host.querySelectorAll(".fl-trade-metric")[2]!;
    };
    expect(metric((15n * ATOMIC).toString(), (45n * ATOMIC).toString()).textContent).toContain("+33.33%");
    expect(metric((-5n * ATOMIC).toString(), (45n * ATOMIC).toString()).textContent).toContain("−5.00 USDT−11.11%");
    expect(metric("0", (45n * ATOMIC).toString()).textContent).toContain("0.00 USDT0.00%");
    expect(metric(null, (45n * ATOMIC).toString()).textContent).toContain("—Stock quote unavailable.");
    for (const basis of ["0", (-5n * ATOMIC).toString()]) {
      const tile = metric((15n * ATOMIC).toString(), basis);
      expect(tile.textContent).toContain("+15.00 USDTNo positive net-invested basis.");
      expect(tile.textContent).not.toContain("33.33%");
    }
  });

  it("shows managed cash, truthful evidence and a relative 0–100 weight band", () => {
    const changed = { ...portfolio, portfolioCashWei: (10n * ATOMIC).toString(), totalValueWei: (60n * ATOMIC).toString(),
      tokens: portfolio.tokens.map((row, index) => ({ ...row, valueWei: ((index === 0 ? 31n : 19n) * ATOMIC).toString(),
        weightBps: index === 0 ? 5166 : 3166, driftBps: index === 0 ? 332 : 367 })) };
    const html = renderToStaticMarkup(<PortfolioDetail portfolio={changed} settings={settings} runs={[]} icons={{ [TOKEN]: "/stock.png", "0x55d398326f99059ff775485246999027b3197955": "/usdt.png" }} refresh={async () => undefined} />);
    expect(html).toContain("NVIDIA");
    expect(html).not.toContain("Managed cash");
    expect(html).toContain("idle · not managed");
    expect(html).toContain("/stock.png");
    expect(html).toContain("/usdt.png");
    expect(html).toContain("47.5%");
    expect(html).toContain("52.50%");
    expect(html).toContain("Holding-value change versus the first buy");
    expect(html).not.toContain("Initial quantity not recorded.");
    expect(html).not.toContain("Deposit");
  });

  it("highlights equality on both relative band edges and keeps unavailable allocation neutral", () => {
    const edge = { ...portfolio, stockValueWei: (40n * ATOMIC).toString(), totalValueWei: (40n * ATOMIC).toString(),
      tokens: portfolio.tokens.map((row, index) => ({ ...row, valueWei: ((index === 0 ? 21n : 19n) * ATOMIC).toString(),
        weightBps: index === 0 ? 5250 : 4750, driftBps: 500 })) };
    const html = renderToStaticMarkup(<PortfolioDetail portfolio={edge} settings={settings} runs={[]} icons={{}} refresh={async () => undefined} />);
    expect(html).toContain("relative drift +5.00%");
    expect(html).toContain("relative drift −5.00%");
    expect(html.match(/fl-portfolio-band__fill/g)).toHaveLength(2);
    expect(html.match(/background:var\(--cat-yield\)/g)?.length).toBeGreaterThanOrEqual(2);
    const zero = renderToStaticMarkup(<PortfolioDetail portfolio={{ ...edge, totalValueWei: "0", tokens: edge.tokens.map((row) => ({ ...row, valueWei: "0", weightBps: null, driftBps: null })) }} settings={settings} runs={[]} icons={{}} refresh={async () => undefined} />);
    expect(zero).toContain("No managed value yet.");
    expect(zero).not.toContain("stroke-dasharray");
    expect(zero.match(/<small>No managed value yet\.<\/small>/g)).toHaveLength(4);
    const incomplete = renderToStaticMarkup(<PortfolioDetail portfolio={{ ...edge, totalValueWei: null, tokens: edge.tokens.map((row, index) => index === 0 ? { ...row, valueWei: null, valueReason: "quote-unavailable" as const, weightBps: null, driftBps: null } : { ...row, weightBps: null, driftBps: null }) }} settings={settings} runs={[]} icons={{}} refresh={async () => undefined} />);
    expect(incomplete).toContain("Allocation unavailable: a stock quote is unavailable.");
    expect(incomplete).not.toContain("stroke-dasharray");
    expect(incomplete.match(/<small>Stock quote unavailable\.<\/small>/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps seven and eight columns in scrollable panels at narrow widths", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain(".fl-portfolio-table{overflow-x:auto}");
    expect(css).toContain(".fl-portfolio-table .fl-row__head,.fl-portfolio-row{min-width:940px");
    const html = renderToStaticMarkup(<PortfolioDetail portfolio={portfolio} settings={settings} runs={[]} icons={{}} refresh={async () => undefined} />);
    expect(html.match(/fl-portfolio-row/g)).toHaveLength(3);
    expect(html.match(/grid-template-columns:minmax\(170px,1.4fr\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("switches tabs, preserves the selected tab across a refreshed prop and calls Refresh", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const refresh = vi.fn(async () => undefined);
    await act(async () => { root.render(<PortfolioDetail portfolio={portfolio} settings={settings} runs={[]} icons={{}} refresh={refresh} />); });
    expect(host.querySelectorAll(".fl-row__head span")).toHaveLength(7);
    const order = [...host.querySelectorAll("button")].find((button) => button.textContent === "Order history");
    expect(order).toBeTruthy();
    await act(async () => { order!.click(); });
    expect(host.querySelectorAll(".fl-row__head span")).toHaveLength(8);
    expect(host.textContent).toContain("Initial allocation");
    expect(host.textContent).toContain("UNKNOWN");
    expect(host.textContent).toContain("—");
    expect(host.querySelectorAll(".fl-portfolio-row")[0]?.children[4]?.textContent).toContain("Executed quantity not recorded.");
    await act(async () => { root.render(<PortfolioDetail portfolio={{ ...portfolio, legs: portfolio.legs.map(({ detail: _detail, ...leg }) => leg) }} settings={settings} runs={[]} icons={{}} refresh={refresh} />); });
    expect(host.querySelectorAll(".fl-portfolio-row")[0]?.children[4]?.textContent).toContain("Needs the updated execution plane.");
    await act(async () => { root.render(<PortfolioDetail portfolio={{ ...portfolio, idleUsdtWei: "0" }} settings={settings} runs={[]} icons={{}} refresh={refresh} />); });
    expect(host.querySelector('[aria-label="Order history table"]')).not.toBeNull();
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Refresh");
    await act(async () => { button!.click(); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
  });

  it("counts down locally, stays due at zero and clears its timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const host = document.createElement("div");
    const root = createRoot(host);
    const value = { ...portfolio, nextCheckAtMs: 6_000, check: null };
    try {
      await act(async () => { root.render(<PortfolioSummary portfolio={value} settings={settings} status="armed" sessionExpiresAt={null} />); });
      expect(host.textContent).toContain("Next in 0m 05s");
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(host.textContent).toContain("Next in 0m 04s");
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(host.textContent).toContain("Due now");
      await act(async () => { root.render(<PortfolioSummary portfolio={{ ...value, nextCheckAtMs: 20_000 }} settings={settings} status="paused" sessionExpiresAt={null} />); });
      expect(host.textContent).toContain("Paused");
      await act(async () => { root.render(<PortfolioSummary portfolio={value} settings={settings} status="retired" sessionExpiresAt={null} />); });
      expect(host.textContent).toContain("Stopped");
      await act(async () => { root.unmount(); });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("formats day, hour and minute countdown boundaries like Schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const host = document.createElement("div"), root = createRoot(host);
    try {
      for (const [seconds, expected] of [[86_400, "1d 00h 00m"], [3_600, "1h 00m 00s"], [60, "1m 00s"], [59, "0m 59s"]] as const) {
        await act(async () => { root.render(<PortfolioSummary portfolio={{ ...portfolio, nextCheckAtMs: 1_000 + seconds * 1_000 }} settings={settings} status="armed" sessionExpiresAt={null} />); });
        expect(host.textContent).toContain(`Next in ${expected}`);
      }
    } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
  });
});

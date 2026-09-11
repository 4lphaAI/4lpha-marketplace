// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentDetailView, DetailMetric } from "@/lib/exec/agent-detail";
import type { UseAgentDetailResult } from "@/lib/exec/use-agent-detail";
import { InfoHint, LpAgentDetail, LpRangeEvents, usdMetric } from "./LpAgentDetail";
import { DUST_EXPLAINER } from "@/lib/lp/dust";
import type { LiquidityGeometry } from "@/components/lp/LiquidityChart";
import type { LpAccountingRead } from "@/lib/lp/accounting";
import type { OnChainPosition } from "@/lib/altana/position-reader";

function metric(value: string | null, reason: string | null, extra: Partial<DetailMetric> = {}): DetailMetric {
  return { value, reason, ...extra };
}

function baseView(): AgentDetailView {
  return {
    id: "lp-agent-1",
    status: "armed",
    httpRuntimeProfile: "lp-v1",
    hireSizingName: "lp-v1",
    walletAddress: "0x2222222222222222222222222222222222222222",
    sessionPublicKey: `0x${"33".repeat(64)}`,
    provisioning: false,
    actionDisabledReason: null,
    armMs: 1_000,
    dailyNativeLimit: metric(null, "— session limit unavailable"),
    recordedCycleDelta: metric(null, "— not a grid agent"),
    grossPnl: metric(null, "— no observation with a valuation yet"),
    grossPnlPercent: metric(null, "— no observation with a valuation yet"),
    recordedCycles: metric(null, "— not a grid agent"),
    levels: [],
    cycleHistoryAvailable: false,
    cycleNote: "— not a grid agent",
    gas: null,
    motions: [],
    sequences: [],
    positions: [],
    lp: {
      settingsTrusted: true,
      settingsReason: null,
      model: null,
      pool: null,
      openingRange: null,
      liveRange: null,
      liveRangeReason: "— no observation with ticks yet",
      currentTick: null,
      currentTickAsOfMs: null,
      currentTickSource: null,
      currentTickReason: "— no observation with a current tick yet",
      settings: {
        autoRotate: true,
        rotateMode: "swapped",
        rotateMinHoldMinutes: 90,
        autoHarvest: false,
        harvestMinFeesWei: "1000000000000000",
        takeProfitPct: null,
        stopLossPct: null,
        brain: null,
      },
      valuation: metric(null, "— no observation with a valuation yet"),
      recordedPnl: metric(null, "— not armed yet"),
      budgetWei: "0",
      selectPool: null,
      restart: "Sign lpArm again to open a new position.",
      reason: "not armed yet",
    },
    grid: {
      pool: null,
      pair: "—",
      base: null,
      quote: null,
      symbol0: null,
      symbol1: null,
      decimals0: null,
      decimals1: null,
      token0: "",
      token1: "",
      fee: 0,
      wbnbIsToken0: false,
      sideInverted: false,
      observedPrice: null,
      quoteUsd: null,
      baseAddress: null,
      quoteAddress: null,
      buyPrices: null,
      sellPrices: null,
      tickSpacing: 0,
      mode: "fixed",
      gapTicks: null,
      widthTicks: null,
      driftPctOfGap: null,
      buyRange: { tickLower: 0, tickUpper: 0 },
      sellRange: { tickLower: 0, tickUpper: 0 },
      observedTick: null,
      observationAgeMs: null,
      observationStale: true,
      tickSource: null,
      rangeUnavailableBecause: "— not a grid agent",
      liveRows: 0,
    },
  };
}

function baseDetail(view: AgentDetailView, overrides: Partial<UseAgentDetailResult> = {}): UseAgentDetailResult {
  return {
    state: "ready",
    view,
    market: null,
    chartCandles: null,
    chartBanner: null,
    chartInterval: "1m",
    chartUnit: "quote",
    setChartInterval: () => undefined,
    setChartUnit: () => undefined,
    trade: null,
    lending: null,
    asOfMs: 2_000,
    message: "",
    marketReason: "market data unavailable",
    readHeaders: {},
    signIn: async () => undefined,
    refresh: async () => view,
    refreshTrade: async () => null,
    refreshLending: async () => null,
    ...overrides,
  };
}

function render(view: AgentDetailView, detailOverrides: Partial<UseAgentDetailResult> = {}, propsOverrides: Partial<React.ComponentProps<typeof LpAgentDetail>> = {}): string {
  return renderToStaticMarkup(
    <LpAgentDetail
      agentId={view.id}
      go={() => undefined}
      detail={baseDetail(view, detailOverrides)}
      view={view}
      busy={false}
      message=""
      actionsDisabled={false}
      removeDisabled={false}
      removeLabel="Remove"
      showResolve={false}
      showAbandon={false}
      signedOut={false}
      onWithdraw={() => undefined}
      chainReads={new Map()}
      onTogglePause={() => undefined}
      onRemove={() => undefined}
      onResolve={() => undefined}
      onAbandon={() => undefined}
      {...propsOverrides}
    />,
  );
}

function rangeView(wbnbIsToken0: boolean): AgentDetailView {
  const base = baseView();
  return {
    ...base,
    lp: {
      ...base.lp!,
      model: "sigma",
      pool: wbnbIsToken0
        ? {
            pair: "BTCB / WBNB",
            base: "BTCB",
            quote: "WBNB",
            symbol0: "WBNB",
            symbol1: "BTCB",
            decimals0: 18,
            decimals1: 18,
            token0: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            token1: "0x7130d2a12b9bcbaacbdfa31d5c7d3c2f16c4f2f0",
            fee: 100,
            poolAddress: "0x9999999999999999999999999999999999999999",
            wbnbIsToken0: true,
            tickSpacing: 10,
            baseAddress: "0x7130d2a12b9bcbaacbdfa31d5c7d3c2f16c4f2f0",
            quoteAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            quoteUsd: null,
          }
        : {
            pair: "BTCB / WBNB",
            base: "BTCB",
            quote: "WBNB",
            symbol0: "BTCB",
            symbol1: "WBNB",
            decimals0: 18,
            decimals1: 18,
            token0: "0x7130d2a12b9bcbaacbdfa31d5c7d3c2f16c4f2f0",
            token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            fee: 100,
            poolAddress: "0x9999999999999999999999999999999999999999",
            wbnbIsToken0: false,
            tickSpacing: 10,
            baseAddress: "0x7130d2a12b9bcbaacbdfa31d5c7d3c2f16c4f2f0",
            quoteAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            quoteUsd: null,
          },
      openingRange: { source: "explicit", tickLower: 100, tickUpper: 200 },
      liveRange: { tickLower: 120, tickUpper: 220, asOfMs: 1_900 },
      liveRangeReason: null,
      currentTick: 150,
      currentTickAsOfMs: 1_950,
      currentTickSource: "worker",
      currentTickReason: null,
      settings: {
        autoRotate: true,
        rotateMode: "swapless",
        rotateMinHoldMinutes: 90,
        autoHarvest: true,
        harvestMinFeesWei: "1000000000000000",
        takeProfitPct: 12,
        stopLossPct: 8,
        brain: { primaryModel: "gpt-4.1", fallbackModel: "gpt-4.1-mini" },
      },
      valuation: metric("1.234567 WBNB", null, { note: "as of 1m ago" }),
      recordedPnl: metric("+0.034567 WBNB", null),
      budgetWei: "1200000000000000000",
      selectPool: { by: "fee-apr", window: "24h" },
      restart: null,
      reason: null,
    },
    sequences: [{ sequenceId: "sequence-lp", positionId: "lp-position-1", kind: "rotate", state: "completed", recoveryState: "none", note: null, outcomeUnavailable: false, txHashes: [`0x${"66".repeat(32)}`], steps: [], updatedAt: 2_000, createdAt: 1_800, shiftCause: null, targetBuyRange: null, targetSellRange: null }],
  };
}

describe("LpAgentDetail", () => {
  it("colors both PNL amount and matching percentage, and shows fee quantities under the same total", () => {
    const e=10n**18n;
    const base=rangeView(false);
    const position: OnChainPosition={kind:"position",tokenId:7n,liquidity:100n,blockNumber:100n,readAtMs:Date.now(),
      token0:base.lp!.pool!.token0 as `0x${string}`,token1:base.lp!.pool!.token1 as `0x${string}`,fee:100,
      tickLower:-10,tickUpper:10,amountsAvailable:true,sqrtPriceX96:1n<<96n,
      amounts:{amount0:5n*e,amount1:4n*e},owed:{amount0:0n,amount1:0n},minimums:{amount0:0n,amount1:0n}};
    const accounting: LpAccountingRead={kind:"read",wallet:base.walletAddress,pool:base.lp!.pool!.poolAddress!,position,
      collectible0:e,collectible1:0n,dust0:2n*e,dust1:0n};
    for(const [capital,dollars,percent,tone] of [[10n,"+$6.00","+20.00%","profit"],[15n,"-$9.00","-20.00%","loss"]] as const){
      const view={...base,lp:{...base.lp!,wbnbUsd:3,budgetWei:(capital*e).toString(),feeMetric:{value:"$0.19",reason:null,tokenBreakdown:"2 USDT / <0.001 WBNB"}},
        grossPnlPercent:{value:"-99.99%",reason:null}};
      const host=document.createElement("div");host.innerHTML=render(view,{}, {accounting,discovered:[position]});
      const tiles=[...host.querySelectorAll(".fl-metric")];
      const pnl=tiles.find(t=>t.querySelector(".fl-metric__label")?.textContent==="PnL since hire")!;
      expect(pnl.querySelector(".fl-metric__value")?.textContent).toBe(dollars);
      expect(pnl.querySelector(".fl-metric__foot")?.textContent).toBe(percent);
      expect(pnl.querySelectorAll(`.fl-num--${tone}`)).toHaveLength(2);
      expect(pnl.textContent).not.toContain("-99.99%");
      const fees=tiles.find(t=>t.querySelector(".fl-metric__label")?.textContent==="Fees earned")!;
      expect(fees.querySelector(".fl-metric__value")?.textContent).toBe("$0.19");
      expect(fees.querySelector(".fl-metric__foot")?.textContent).toBe("2 USDT / <0.001 WBNB");
    }
  });
  it("renders the five amended mock-up tiles with reasons and no retired panels", () => {
    const html = render(baseView());
    for (const text of ["Delegated", "Execution model", "PnL since hire", "Fees earned", "Dust", "Fee APR", "Farm APR", "session limit unavailable", "not armed yet", "no open positions"]) expect(html).toContain(text);
    // The percent moved INTO the PnL tile; its own panel is now Dust (operator, 2026-09-06).
    expect(html).not.toContain("PNL by Percent");
    expect(html).toContain("Dust is the base and quote tokens left over");
    for (const text of ["HODL", "Settings editing", "7d"]) if (text !== "Settings editing") expect(html).not.toContain(text);
    expect(html).toMatch(/disabled[^>]*title="Settings editing is not available/);
  });
  it("Sigma has Closed Positions; custom does not", () => {
    expect(render(rangeView(false))).toContain("Closed Positions");
    expect(render(baseView())).not.toContain("Closed Positions");
  });
});

// INVERTED and DECLARED (operator, 2026-09-06): an unsourced figure now shows a
// bare dash. The reason is not deleted, it moves to the hover title — the page
// stays honest without printing a paragraph under every empty cell.
it("every unsourced tile and numeric cell is a bare dash whose reason survives on hover",()=>{
  const base=baseView();const view={...base,positions:[{positionId:"p",state:"open",tokenId:"7",pair:"",role:"position",age:"",ageTitle:"",value:metric(null,"valuation missing"),unrealised:metric(null,"unrealised missing"),fees:metric(null,"fees missing"),nftUrl:null,rung:null,sideLabel:null}]};
  const host=document.createElement("div");host.innerHTML=render(view);
  const tiles=[...host.querySelectorAll(".fl-metric")];expect(tiles).toHaveLength(5);
  for(const tile of tiles){
    expect(tile.querySelector(".fl-metric__value")?.textContent).toBe("—");
    expect(tile.querySelector(".fl-metric__foot")).toBeNull();
    expect(tile.getAttribute("title")?.trim().length).toBeGreaterThan(0);
  }
  const cells=[...host.querySelectorAll('[role="rowgroup"] .fl-row:first-child [role="cell"]')];expect(cells).toHaveLength(8);
  for(const cell of cells.slice(0,6)){
    expect(cell.textContent).toContain("—");
    expect(cell.querySelector("small")).toBeNull();
    expect(cell.querySelector("[title]")?.getAttribute("title")?.trim().length).toBeGreaterThan(0);
  }
});

describe("LP chart footer events", () => {
  const geometry: LiquidityGeometry = { spacing: 10, currentTick: 150, currentTickAsOfMs: 1950,
    orientation: { quoteIsToken0: false, decimals0: 18, decimals1: 18, symbol0: "BTCB", symbol1: "WBNB" }, display: { invert: false } };
  function footer(options: { tick?: number; invert?: boolean; live?: boolean; trusted?: boolean; auto?: boolean; paused?: boolean;
    sequence?: "active" | "held-none" | "held-recovery" | "other-position"; geometry?: boolean } = {}) {
    const view = rangeView(false);
    const sequences = options.sequence ? [{ ...view.sequences[0]!, state: options.sequence === "active" ? "active" : "held",
      recoveryState: options.sequence === "held-recovery" ? "shift-ambiguous" : "none",
      positionId: options.sequence === "other-position" ? "other" : "lp-position-1" }] : [];
    return renderToStaticMarkup(<LpRangeEvents live={options.live ?? true} lp={{ ...view.lp!, currentTick: options.tick ?? 250,
      settingsTrusted: options.trusted ?? true, settingsReason: "settings digest unverified; worker skips this agent",
      settings: { ...view.lp!.settings!, autoRotate: options.auto ?? true } }}
      geometry={options.geometry === false ? null : { ...geometry, display: { invert: options.invert ?? false } }}
      positionId="lp-position-1" sequences={sequences} status={options.paused ? "paused" : "armed"} now={3000} />);
  }
  it("through-band progress starts at the displayed low and reverses with units", () => {
    expect(footer({ tick: 120 })).toContain("0% THROUGH BAND");
    expect(footer({ tick: 145 })).toContain("25% THROUGH BAND");
    expect(footer({ tick: 145, invert: true })).toContain("75% THROUGH BAND");
    expect(footer({ tick: 219, invert: true })).toContain("1% THROUGH BAND");
    expect(footer({ tick: 145 })).not.toContain("NOT EARNING FEES");
  });
  it("out-of-range direction follows the displayed unit, including the exclusive upper edge", () => {
    expect(footer({ tick: 220 })).toContain("OUT OF RANGE · ABOVE BAND");
    expect(footer({ tick: 119 })).toContain("OUT OF RANGE · BELOW BAND");
    expect(footer({ tick: 220, invert: true })).toContain("OUT OF RANGE · BELOW BAND");
    expect(footer({ tick: 119, invert: true })).toContain("OUT OF RANGE · ABOVE BAND");
  });
  it("trusted auto-rebalance on/off and untrusted settings remain distinct", () => {
    expect(footer()).toContain("AUTO-REBALANCE ON · cooldown 90m");
    expect(footer({ auto: false })).toContain("AUTO-REBALANCE OFF");
    expect(footer({ trusted: false })).toContain("settings digest unverified; worker skips this agent");
    expect(footer({ trusted: false })).not.toContain("AUTO-REBALANCE");
  });
  it("uses terminal classification and renders blocking, paused and fee status in order", () => {
    const html = footer({ sequence: "active", paused: true });
    const labels = ["OUT OF RANGE", "AUTO-REBALANCE", "BLOCKED · rotate active", "PAUSED", "NOT EARNING FEES"];
    expect(labels.map(label => html.indexOf(label))).toEqual([...labels.map(label => html.indexOf(label))].sort((a, b) => a - b));
    for (const label of labels) expect(html).toContain(label);
    expect(footer({ sequence: "held-none" })).not.toContain("BLOCKED");
    expect(footer({ sequence: "held-recovery" })).toContain("BLOCKED · rotate held");
    expect(footer({ sequence: "other-position" })).not.toContain("BLOCKED");
    expect(footer()).not.toContain("PAUSED");
  });
  it("non-live ticks suppress every live event and missing geometry has a reason", () => {
    const html = footer({ live: false, sequence: "active", paused: true });
    expect(html).toContain("LAST OBSERVED");
    for (const label of ["THROUGH BAND", "OUT OF RANGE", "AUTO-REBALANCE", "BLOCKED", "PAUSED", "NOT EARNING FEES"]) expect(html).not.toContain(label);
    expect(footer({ geometry: false })).toContain("range geometry unavailable");
  });
  it("expanded chart and badge share live gating; worker-only, old and future ticks stay last observed", async () => {
    const host = document.createElement("div"), root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    try {
      for (const mode of ["browser", "worker", "old", "future"] as const) {
        const base = rangeView(false);
        const view: AgentDetailView = { ...base,
          lp: { ...base.lp!, currentTick: 250, currentTickSource: mode === "worker" ? "worker" : "live",
            currentTickFresh: mode !== "worker", currentTickAsOfMs: Date.now() + (mode === "old" ? -61000 : mode === "future" ? 61000 : 0) },
          positions: [{ positionId: "lp-position-1", tokenId: "7", state: "open", pair: "BTCB / WBNB", role: "position", age: "", ageTitle: "",
            value: metric(null, "valuation missing"), unrealised: metric(null, "unrealised missing"), fees: metric(null, "fees missing"), nftUrl: null, rung: null, sideLabel: null }],
        };
        await act(async () => root.render(<LpAgentDetail key={mode} agentId={view.id} go={() => undefined} detail={baseDetail(view)} view={view}
          busy={false} message="" actionsDisabled={false} removeDisabled={false} removeLabel="Remove" showResolve={false} showAbandon={false}
          signedOut={false} onWithdraw={() => undefined} chainReads={new Map()} onTogglePause={() => undefined} onRemove={() => undefined}
          onResolve={() => undefined} onAbandon={() => undefined} />));
        await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Range"]')!.click(); });
        expect(host.textContent).toContain(mode === "browser" ? "OUT OF RANGE · ABOVE BAND" : "LAST OBSERVED");
        if (mode !== "browser") {
          expect(host.textContent).toContain("Last observed");
          expect(host.textContent).not.toContain("NOT EARNING FEES");
        }
      }
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
  });
});

it("keeps USD metrics in dollars without a WBNB fallback", () => {
 expect(usdMetric(metric("-$1.26", null)).value).toBe("-$1.26");
 expect(usdMetric(metric("0.123 WBNB", null)).value).toBeNull();
 expect(usdMetric(metric(null, "missing")).reason).toBe("missing");
});

it("the Dust info icon opens its explanation on hover and on focus", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<InfoHint text={DUST_EXPLAINER} />));
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { host.querySelector("span")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("left over in the agent wallet");
    await act(async () => { host.querySelector("span")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => host.querySelector("button")!.focus());
    expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("Native BNB is not counted");
    // The icon is a real hit area, not a bare glyph: that is why the first attempt showed nothing.
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe(DUST_EXPLAINER);
    expect(button.getAttribute("style")).toContain("width: 18px");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

// @vitest-environment happy-dom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/deploy/HireGridDeploy", () => ({ HireGridDeploy: () => null }));
vi.mock("@/components/deploy/HireLpDeploy", () => ({
  HireLpDeploy: ({ explicitPrices, blockedReason }: { blockedReason?: string | null; explicitPrices?: {
    minPrice: number;
    maxPrice: number;
    wbnbIsToken0: boolean;
    poolAddress: string;
    ready: boolean;
  } | null }) => <button
    data-testid="lp-deploy-props"
    data-ready={String(explicitPrices?.ready ?? false)}
    data-min={String(explicitPrices?.minPrice ?? "")}
    data-max={String(explicitPrices?.maxPrice ?? "")}
    data-orientation={String(explicitPrices?.wbnbIsToken0 ?? "")}
    data-quote={String((explicitPrices as { quoteIsToken0?: boolean } | null)?.quoteIsToken0 ?? "")}
    data-blocked={blockedReason ?? ""}
    data-pool={explicitPrices?.poolAddress ?? ""}
  >Deploy LP Agent</button>,
}));
vi.mock("@/components/deploy/HireTradeDeploy", () => ({ HireTradeDeploy: () => null }));
vi.mock("@/components/deploy/TradeModelSelect", () => ({ TradeModelSelect: () => null }));

import { DeployAgentScreen } from "./DeployAgentScreen";

describe("LP deploy controls", () => {
  it("omits every control removed by the LP v1 contract from the rendered DOM", () => {
    const html = renderToStaticMarkup(<DeployAgentScreen kind="lp" go={() => undefined} />);
    for (const removed of [
      "Deposit per position", "Max open positions", "No re-entry", "Max holding time",
      "Move the stop to break-even", "Slippage tolerance", "Gas priority", "QuickNode RPC",
      "Custom RPC", "CMC Agent Hub", "rebalanceSchedule",
    ]) {
      expect(html).not.toContain(removed);
    }
    expect(html).toContain("Deploy LP Agent");
  });

  it("clears Custom readiness synchronously on pool switch and re-derives ordered defaults in both orientations", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pools = [
      {
        pool: "0x1111111111111111111111111111111111111111",
        token0: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        token0Symbol: "AAA",
        token1Symbol: "WBNB",
        fee: 500,
        tick: 1_000,
        tvlUsd: 1_000_000,
        volume24hUsd: 100_000,
        token0Icon: null,
        token1Icon: null,
        wbnbIsToken0: false,
        staleness: null,
      },
      {
        pool: "0x2222222222222222222222222222222222222222",
        token0: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        token1: "0xcccccccccccccccccccccccccccccccccccccccc",
        token0Symbol: "WBNB",
        token1Symbol: "BBB",
        fee: 2500,
        tick: -2_000,
        tvlUsd: 2_000_000,
        volume24hUsd: 200_000,
        token0Icon: null,
        token1Icon: null,
        wbnbIsToken0: true,
        staleness: null,
      },
    ];
    const stateResolvers = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/pools") {
        return new Response(JSON.stringify({ data: pools }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/pool-state?address=")) {
        return new Promise<Response>((resolve) => { stateResolvers.set(url, resolve); });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = () => host.querySelector<HTMLButtonElement>('[data-testid="lp-deploy-props"]');
    const search = () => host.querySelector<HTMLInputElement>('input[placeholder^="Search pair"]');
    const pick = (label: string) => [...host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes(label));
    const settlePools = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    try {
      await act(async () => {
        root.render(<DeployAgentScreen kind="lp" go={() => undefined} />);
        await settlePools();
      });

      await act(async () => {
        search()?.blur();
        search()?.focus();
      });
      await act(async () => { pick("AAA / WBNB")?.click(); });
      expect(props()?.dataset.ready).toBe("false");
      // The live-tick wait shows the lightweight spinner beside its reason.
      expect(host.querySelector('[data-testid="lp-range-spinner"]')).not.toBeNull();
      const firstUrl = `/api/pool-state?address=${pools[0].pool}`;
      await act(async () => {
        stateResolvers.get(firstUrl)?.(new Response(JSON.stringify({
          data: { currentTick: 1_000, tickSpacing: 10 },
        }), { status: 200, headers: { "content-type": "application/json" } }));
        await settlePools();
      });
      expect(props()?.dataset.ready).toBe("true");
      expect(props()?.dataset.orientation).toBe("false");
      const firstMin = Number(props()?.dataset.min);
      const firstMax = Number(props()?.dataset.max);
      expect(firstMin).toBeLessThan(firstMax);

      await act(async () => {
        search()?.blur();
        search()?.focus();
      });
      await act(async () => { pick("WBNB / BBB")?.click(); });
      expect(props()?.dataset.ready).toBe("false");
      expect(props()?.dataset.pool).toBe("");
      const secondUrl = `/api/pool-state?address=${pools[1].pool}`;
      await act(async () => {
        stateResolvers.get(secondUrl)?.(new Response(JSON.stringify({
          data: { currentTick: -2_000, tickSpacing: 50 },
        }), { status: 200, headers: { "content-type": "application/json" } }));
        await settlePools();
      });
      expect(props()?.dataset.ready).toBe("true");
      expect(props()?.dataset.orientation).toBe("true");
      expect(props()?.dataset.pool).toBe(pools[1].pool);
      const secondMin = Number(props()?.dataset.min);
      const secondMax = Number(props()?.dataset.max);
      expect(secondMin).toBeLessThan(secondMax);
      expect([secondMin, secondMax]).not.toEqual([firstMin, firstMax]);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it("ticking Take profit or Stop loss reveals its percentage without the '+' button", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/pools") return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<DeployAgentScreen kind="lp" go={() => undefined} />); await Promise.resolve(); });
      expect(host.textContent).not.toContain("Take profit at");
      expect(host.textContent).not.toContain("Stop loss at");
      // The design-system Checkbox is <label class="fl-check">…<input type="checkbox"/></label>;
      // the mode row's header div holds it beside the "TP"/"SL" code and the label text.
      const checkboxFor = (label: string) => [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
        .find((input) => input.closest("label")?.parentElement?.parentElement?.textContent?.includes(label)) ?? null;
      const tp = checkboxFor("Take profit");
      expect(tp).not.toBeNull();
      await act(async () => { tp!.click(); });
      expect(host.textContent).toContain("Take profit at");
      // Unticking folds it again.
      await act(async () => { checkboxFor("Take profit")!.click(); });
      expect(host.textContent).not.toContain("Take profit at");
      // Stop loss behaves the same way.
      const sl = checkboxFor("Stop loss");
      expect(sl).not.toBeNull();
      await act(async () => { sl!.click(); });
      expect(host.textContent).toContain("Stop loss at");
      await act(async () => { checkboxFor("Stop loss")!.click(); });
      expect(host.textContent).not.toContain("Stop loss at");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("paints the live per-tick liquidity profile and re-marks the owner's bins when a bound moves", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pool = {
      pool: "0x3333333333333333333333333333333333333333",
      token0: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
      token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      token0Symbol: "BTCB",
      token1Symbol: "WBNB",
      fee: 500,
      tick: 46_566,
      tvlUsd: 5_000_000,
      volume24hUsd: 900_000,
      token0Icon: null,
      token1Icon: null,
      wbnbIsToken0: false,
      staleness: null,
    };
    const spacing = 10;
    const currentTick = 46_566;
    const bins: { tickLower: number; liquidity: string }[] = [];
    for (let bin = -60; bin <= 60; bin += 1) {
      bins.push({ tickLower: 46_560 + bin * spacing, liquidity: String(10n ** 15n * BigInt(100 - Math.abs(bin))) });
    }
    const liquidityCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/pools") return json({ data: [pool] });
      if (url.startsWith("/api/pool-state?address=")) return json({ data: { pool: pool.pool, currentTick, tickSpacing: spacing } });
      if (url.startsWith("/api/pool-liquidity?address=")) {
        liquidityCalls.push(url);
        return json({ data: { pool: pool.pool, blockNumber: "1", currentTick, tickSpacing: spacing, activeLiquidity: bins[60]!.liquidity, bins, truncated: false } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    const bars = () => [...host.querySelectorAll<HTMLElement>("[data-tick]")];
    try {
      await act(async () => { root.render(<DeployAgentScreen kind="lp" go={() => undefined} />); await settle(); });
      const search = host.querySelector<HTMLInputElement>('input[placeholder^="Search pair"]');
      await act(async () => { search?.blur(); search?.focus(); });
      const pick = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("BTCB / WBNB"));
      await act(async () => { pick?.click(); await settle(); });
      await act(async () => { await settle(); });

      // Price reads as WBNB per BTCB (≈105), not BTCB per WBNB (≈0.0095).
      expect(host.textContent).toMatch(/Current price 10\d\.\d+ WBNB per BTCB · tick 46566/u);
      expect(liquidityCalls[0]).toContain(`address=${pool.pool}`);
      expect(bars()).toHaveLength(121);
      const market = bars().filter((bar) => bar.dataset.market === "true");
      expect(market).toHaveLength(1);
      expect(market[0]!.dataset.tick).toBe("46560");
      const inRangeBefore = bars().filter((bar) => bar.dataset.inRange === "true").length;
      // The default band is ±500 ticks snapped OUTWARD to the 10-tick spacing:
      // [46060, 47070) ⇒ 101 bins.
      expect(inRangeBefore).toBe(101);

      // The quote orientation reaches the deploy component (BTCB/WBNB ⇒ WBNB, token1, is the quote).
      expect(host.querySelector<HTMLButtonElement>('[data-testid="lp-deploy-props"]')?.dataset.quote).toBe("false");
      // The displayed "Signed range" is the same geometry the chart paints:
      // first in-range bin == lower bound, last in-range bin + spacing == upper bound.
      const signed = () => host.querySelector<HTMLElement>('[data-testid="lp-signed-range"]');
      const inRangeTicks = () => bars().filter((bar) => bar.dataset.inRange === "true").map((bar) => Number(bar.dataset.tick));
      expect(Number(signed()?.dataset.lower)).toBe(Math.min(...inRangeTicks()));
      expect(Number(signed()?.dataset.upper)).toBe(Math.max(...inRangeTicks()) + spacing);

      // Nudging the minimum price up by one tick spacing removes exactly one bin,
      // and the signed lower bound moves with it.
      const increaseMin = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Increase Minimum price");
      await act(async () => { increaseMin?.click(); });
      const inRangeAfter = bars().filter((bar) => bar.dataset.inRange === "true").length;
      expect(inRangeAfter).toBe(inRangeBefore - 1);
      expect(Number(signed()?.dataset.lower)).toBe(Math.min(...inRangeTicks()));
      expect(host.querySelector<HTMLElement>('[data-testid="lp-liquidity-legend"]')?.dataset.block).toBe("1");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
    }
  });


  /** Mount the LP Custom form with a scripted pool + pool-state + liquidity answer. */
  async function mountCustomPool(input: {
    readonly pool: Record<string, unknown>;
    readonly currentTick: number;
    readonly spacing: number;
    readonly liquidity: (url: string) => Response | Promise<Response>;
    readonly extraPools?: readonly Record<string, unknown>[];
  }) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const liquidityCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/pools") return json({ data: [input.pool, ...(input.extraPools ?? [])] });
      if (url.startsWith("/api/pool-state?address=")) {
        const address = url.slice("/api/pool-state?address=".length);
        return json({ data: { pool: address, currentTick: input.currentTick, tickSpacing: input.spacing } });
      }
      if (url.startsWith("/api/pool-liquidity?address=")) { liquidityCalls.push(url); return input.liquidity(url); }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    await act(async () => { root.render(<DeployAgentScreen kind="lp" go={() => undefined} />); await settle(); });
    const pick = async (label: string) => {
      const search = host.querySelector<HTMLInputElement>('input[placeholder^="Search pair"]');
      await act(async () => { search?.blur(); search?.focus(); });
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
      await act(async () => { button?.click(); await settle(); });
      await act(async () => { await settle(); });
    };
    return {
      host,
      liquidityCalls,
      pick,
      settle,
      bars: () => [...host.querySelectorAll<HTMLElement>("[data-tick]")],
      props: () => host.querySelector<HTMLButtonElement>('[data-testid="lp-deploy-props"]'),
      signed: () => host.querySelector<HTMLElement>('[data-testid="lp-signed-range"]'),
      unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals(); },
    };
  }

  const BTCB_WBNB = {
    pool: "0x3333333333333333333333333333333333333333",
    token0: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    token0Symbol: "BTCB", token1Symbol: "WBNB", fee: 500, tick: 46_566, tvlUsd: 5_000_000, volume24hUsd: 900_000,
    token0Icon: null, token1Icon: null, wbnbIsToken0: false, staleness: null,
  };
  const USDT_WBNB = {
    pool: "0x4444444444444444444444444444444444444444",
    token0: "0x55d398326f99059ff775485246999027b3197955", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    token0Symbol: "USDT", token1Symbol: "WBNB", fee: 100, tick: -66_415, tvlUsd: 9_000_000, volume24hUsd: 5_000_000,
    token0Icon: null, token1Icon: null, wbnbIsToken0: false, staleness: null,
  };

  it("draws a profile whose liquidity is tiny in absolute terms (bigint-peak normalization)", async () => {
    const bins = Array.from({ length: 21 }, (_, i) => ({ tickLower: 46_460 + i * 10, liquidity: String(1 + Math.abs(i - 10)) }));
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: () =>
      new Response(JSON.stringify({ data: { pool: BTCB_WBNB.pool, blockNumber: "7", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "1", bins, truncated: false } }), { status: 200 }) });
    try {
      await m.pick("BTCB / WBNB");
      const heights = m.bars().map((bar) => parseFloat(bar.style.height));
      expect(heights).toHaveLength(21);
      expect(Math.max(...heights)).toBe(100);
      expect(Math.min(...heights)).toBeGreaterThan(3);
      expect(new Set(heights).size).toBeGreaterThan(5);
    } finally { await m.unmount(); }
  });

  it("shows the upstream reason instead of an empty profile when the liquidity read fails", async () => {
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: () =>
      new Response(JSON.stringify({ error: { code: "internal_error", message: "The pool's liquidity profile could not be read." } }), { status: 503 }) });
    try {
      await m.pick("BTCB / WBNB");
      expect(m.bars()).toHaveLength(0);
      expect(m.host.textContent).toContain("The pool's liquidity profile could not be read.");
      expect(m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-legend"]')?.dataset.block).toBe("");
    } finally { await m.unmount(); }
  });

  it("drops the previous pool's profile the moment another pool is selected, and never paints a stale answer", async () => {
    const resolvers = new Map<string, (r: Response) => void>();
    const m = await mountCustomPool({ pool: BTCB_WBNB, extraPools: [USDT_WBNB], currentTick: 46_566, spacing: 10, liquidity: (url) =>
      new Promise<Response>((resolve) => { resolvers.set(url, resolve); }) });
    try {
      await m.pick("BTCB / WBNB");
      expect(m.bars()).toHaveLength(0);
      // While the profile is in flight the chart shows the lightweight spinner, never an empty profile.
      expect(m.host.querySelector('[data-testid="lp-liquidity-spinner"]')).not.toBeNull();
      await m.pick("USDT / WBNB");
      // The FIRST pool's answer arrives late: it must not paint under the second pool.
      const first = [...resolvers.keys()].find((url) => url.includes(BTCB_WBNB.pool))!;
      await act(async () => {
        resolvers.get(first)?.(new Response(JSON.stringify({ data: { pool: BTCB_WBNB.pool, blockNumber: "1", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "5", bins: [{ tickLower: 46_560, liquidity: "5" }], truncated: false } }), { status: 200 }));
        await m.settle();
      });
      expect(m.bars()).toHaveLength(0);
      expect(m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-legend"]')?.dataset.block).not.toBe("1");
      const second = [...resolvers.keys()].find((url) => url.includes(USDT_WBNB.pool))!;
      await act(async () => {
        resolvers.get(second)?.(new Response(JSON.stringify({ data: { pool: USDT_WBNB.pool, blockNumber: "2", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "5", bins: [{ tickLower: 46_560, liquidity: "5" }, { tickLower: 46_570, liquidity: "3" }], truncated: false } }), { status: 200 }));
        await m.settle();
      });
      expect(m.bars()).toHaveLength(2);
      expect(m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-legend"]')?.dataset.block).toBe("2");
    } finally { await m.unmount(); }
  });

  it("labels each price box with the tick the signature will carry, in the quote-is-token0 orientation too", async () => {
    // USDT/WBNB: USDT is token0 and the quote ⇒ a HIGHER price is a LOWER tick.
    const m = await mountCustomPool({ pool: USDT_WBNB, currentTick: -66_415, spacing: 1, liquidity: () =>
      new Response(JSON.stringify({ data: { pool: USDT_WBNB.pool, blockNumber: "3", currentTick: -66_415, tickSpacing: 1, activeLiquidity: "9", bins: [{ tickLower: -66_415, liquidity: "9" }], truncated: false } }), { status: 200 }) });
    try {
      await m.pick("USDT / WBNB");
      expect(m.props()?.dataset.quote).toBe("true");
      expect(m.host.textContent).toMatch(/Current price 7\d\d\.\d+ USDT per WBNB · tick -66415/u);
      const lower = Number(m.signed()?.dataset.lower);
      const upper = Number(m.signed()?.dataset.upper);
      expect(lower).toBeLessThan(-66_415);
      expect(upper).toBeGreaterThan(-66_415);
      // The MIN price box owns the UPPER tick and the MAX price box the LOWER one.
      const minLabel = m.host.querySelector<HTMLElement>('[data-price-box="Minimum price"]')?.dataset.signedTick;
      const maxLabel = m.host.querySelector<HTMLElement>('[data-price-box="Maximum price"]')?.dataset.signedTick;
      expect(m.host.textContent).not.toMatch(/Minimum price\s*tick/u);
      expect(Number(minLabel)).toBe(upper);
      expect(Number(maxLabel)).toBe(lower);
      expect(m.props()?.dataset.blocked).toBe("");
    } finally { await m.unmount(); }
  });

  it("blocks Deploy with the form's own reason while the typed range cannot be signed", async () => {
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: () =>
      new Response(JSON.stringify({ data: { pool: BTCB_WBNB.pool, blockNumber: "1", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "1", bins: [], truncated: false } }), { status: 200 }) });
    try {
      await m.pick("BTCB / WBNB");
      expect(m.props()?.dataset.blocked).toBe("");
      // Drag the maximum below the live price: the band no longer contains it.
      // One act per click: each step reads the tick the previous render labelled.
      for (let i = 0; i < 60; i += 1) {
        const decreaseMax = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Decrease Maximum price");
        await act(async () => { decreaseMax?.click(); });
      }
      expect(m.props()?.dataset.blocked).toMatch(/must sit inside the typed band|maximum price must be above/u);
    } finally { await m.unmount(); }
  });


  it("explains the chart (current price + tick, your range, other liquidity) and flips the quote direction without moving the signed ticks", async () => {
    const bins = Array.from({ length: 21 }, (_, i) => ({ tickLower: 46_460 + i * 10, liquidity: String(10 ** 15 * (1 + Math.abs(i - 10))) }));
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: () =>
      new Response(JSON.stringify({ data: { pool: BTCB_WBNB.pool, blockNumber: "9", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "1", bins, truncated: false } }), { status: 200 }) });
    try {
      await m.pick("BTCB / WBNB");
      const legend = m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-legend"]');
      expect(legend?.textContent).toMatch(/current price · 10\d\.\d+ WBNB/u);
      expect(legend?.textContent).not.toMatch(/tick/u);
      expect(legend?.textContent).toContain("your range");
      expect(legend?.dataset.lower).toBe(m.signed()?.dataset.lower);
      expect(legend?.textContent).toContain("other liquidity");

      const before = { lower: m.signed()?.dataset.lower, upper: m.signed()?.dataset.upper };
      const beforeProps = { min: m.props()?.dataset.min, max: m.props()?.dataset.max };
      expect(m.host.textContent).toMatch(/Current price 10\d\.\d+ WBNB per BTCB/u);
      const flip = m.host.querySelector<HTMLButtonElement>('[data-testid="lp-flip-quote"]');
      expect(flip?.textContent).toContain("BTCB per WBNB");
      await act(async () => { flip?.click(); });
      // Now quoted the other way round: ≈0.0095 BTCB per WBNB, min/max inverted…
      expect(m.host.textContent).toMatch(/Current price 0\.009\d+ BTCB per WBNB · tick 46566/u);
      // …but the BAND is untouched: the signing helper still receives the same
      // prices in the same orientation (fix review 2, finding 1).
      expect(m.props()?.dataset.quote).toBe("false");
      expect(m.props()?.dataset.min).toBe(beforeProps.min);
      expect(m.props()?.dataset.max).toBe(beforeProps.max);
      // The displayed boxes show reciprocals in BTCB per WBNB.
      const minBox = m.host.querySelector<HTMLInputElement>('[data-price-box="Minimum price"] input');
      expect(Number(minBox?.value)).toBeLessThan(0.02);
      // …and the signed range is byte-identical.
      expect(m.signed()?.dataset.lower).toBe(before.lower);
      expect(m.signed()?.dataset.upper).toBe(before.upper);
      expect(m.props()?.dataset.blocked).toBe("");
      // Flip back restores the pool's own reading.
      await act(async () => { m.host.querySelector<HTMLButtonElement>('[data-testid="lp-flip-quote"]')?.click(); });
      expect(m.host.textContent).toMatch(/Current price 10\d\.\d+ WBNB per BTCB/u);
      expect(m.signed()?.dataset.lower).toBe(before.lower);
      expect(m.signed()?.dataset.upper).toBe(before.upper);
    } finally { await m.unmount(); }
  });


  it("zooms the liquidity window out and in with −/+, re-reading the plane at the new width and grouping dense bins", async () => {
    const windows: number[] = [];
    const m = await mountCustomPool({ pool: USDT_WBNB, currentTick: -66_415, spacing: 1, liquidity: (url) => {
      const window = Number(new URL(`https://x${url}`).searchParams.get("window"));
      windows.push(window);
      const bins = Array.from({ length: 2 * window + 1 }, (_, i) => ({ tickLower: -66_415 - window + i, liquidity: String(1 + (i % 7)) }));
      return new Response(JSON.stringify({ data: { pool: USDT_WBNB.pool, blockNumber: "5", currentTick: -66_415, tickSpacing: 1, activeLiquidity: "3", bins, truncated: false } }), { status: 200 });
    } });
    try {
      await m.pick("USDT / WBNB");
      // Spacing 1 with the default ±500-tick band ⇒ the auto zoom frames the whole band (1000 bins/side).
      const zoomBox = () => m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-zoom"]');
      expect(zoomBox()?.dataset.window).toBe("1000");
      expect(windows.at(-1)).toBe(1000);
      // 2001 bins are grouped so no more than 240 bars are drawn, and the band is still marked.
      expect(m.bars().length).toBeLessThanOrEqual(240);
      expect(m.bars().some((bar) => bar.dataset.inRange === "true")).toBe(true);
      expect(m.bars().filter((bar) => bar.dataset.market === "true")).toHaveLength(1);
      expect(m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-zoom"]')?.dataset.window).toBe("1000");
      // Zoom in: a narrower window is fetched and bars are single bins again.
      const zoomIn = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Zoom in liquidity");
      await act(async () => { zoomIn?.click(); await m.settle(); });
      await act(async () => { await m.settle(); });
      expect(zoomBox()?.dataset.window).toBe("500");
      expect(windows.at(-1)).toBe(500);
      for (let i = 0; i < 4; i += 1) {
        const button = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Zoom in liquidity");
        await act(async () => { button?.click(); await m.settle(); });
        await act(async () => { await m.settle(); });
      }
      expect(zoomBox()?.dataset.window).toBe("30");
      expect(m.bars()).toHaveLength(61);
      expect(m.host.textContent).not.toContain("bins");
      // The zoom-in button is disabled at the tightest level; zoom out re-enables it.
      const tightest = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Zoom in liquidity");
      expect(tightest?.disabled).toBe(true);
      const zoomOut = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Zoom out liquidity");
      await act(async () => { zoomOut?.click(); await m.settle(); });
      expect(zoomBox()?.dataset.window).toBe("60");
      // No tick numbers or block numbers in the visible chart text (operator request).
      const legend = m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-legend"]');
      expect(legend?.textContent).not.toMatch(/tick/u);
      expect(legend?.textContent).not.toContain("bar height");
      expect(m.host.textContent).not.toContain("finalized block");
    } finally { await m.unmount(); }
  });


  it("hands the signing helper the SAME parsed prices the form validated (commas, trailing junk)", async () => {
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: () =>
      new Response(JSON.stringify({ data: { pool: BTCB_WBNB.pool, blockNumber: "1", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "1", bins: [], truncated: false } }), { status: 200 }) });
    try {
      await m.pick("BTCB / WBNB");
      const maxInput = m.host.querySelector<HTMLInputElement>('[data-price-box="Maximum price"] input')!;
      const setValue = (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => { setValue(maxInput, "1,100.5junk"); });
      // The form accepts it as 1100.5 and the deploy props carry that number — never NaN.
      expect(m.props()?.dataset.blocked).toBe("");
      expect(m.props()?.dataset.max).toBe("1100.5");
    } finally { await m.unmount(); }
  });

  it("steps the box that was clicked even while the other price is empty, from a spacing-aligned base", async () => {
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: () =>
      new Response(JSON.stringify({ data: { pool: BTCB_WBNB.pool, blockNumber: "1", currentTick: 46_566, tickSpacing: 10, activeLiquidity: "1", bins: [], truncated: false } }), { status: 200 }) });
    try {
      await m.pick("BTCB / WBNB");
      const minBefore = m.host.querySelector<HTMLInputElement>('[data-price-box="Minimum price"] input')!.value;
      const maxInput = m.host.querySelector<HTMLInputElement>('[data-price-box="Maximum price"] input')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => { setter.call(maxInput, ""); maxInput.dispatchEvent(new Event("input", { bubbles: true })); });
      expect(m.host.querySelector<HTMLInputElement>('[data-price-box="Maximum price"] input')!.value).toBe("");
      const increaseMax = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Increase Maximum price");
      await act(async () => { increaseMax?.click(); });
      // The MAX box gained a value one spacing above the aligned live bin; the MIN box is untouched.
      const maxAfter = Number(m.host.querySelector<HTMLInputElement>('[data-price-box="Maximum price"] input')!.value);
      expect(maxAfter).toBeGreaterThan(0);
      expect(m.host.querySelector<HTMLInputElement>('[data-price-box="Minimum price"] input')!.value).toBe(minBefore);
      const upper = Number(m.host.querySelector<HTMLElement>('[data-price-box="Maximum price"]')?.dataset.signedTick);
      expect(upper).toBe(46_570);
    } finally { await m.unmount(); }
  });

  it("does not keep a previous zoom window's error on screen while the next window is loading", async () => {
    const pending = new Map<string, (r: Response) => void>();
    const m = await mountCustomPool({ pool: BTCB_WBNB, currentTick: 46_566, spacing: 10, liquidity: (url) => {
      const window = Number(new URL(`https://x${url}`).searchParams.get("window"));
      if (window === 120) return new Response(JSON.stringify({ error: { code: "internal_error", message: "old-window-error" } }), { status: 503 });
      return new Promise<Response>((resolve) => { pending.set(url, resolve); });
    } });
    try {
      await m.pick("BTCB / WBNB");
      // Auto zoom for the default ±500-tick band at spacing 10 is 120 bins ⇒ the scripted error.
      expect(m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-zoom"]')?.dataset.window).toBe("120");
      expect(m.host.textContent).toContain("old-window-error");
      const zoomIn = [...m.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Zoom in liquidity");
      await act(async () => { zoomIn?.click(); await m.settle(); });
      expect(m.host.querySelector<HTMLElement>('[data-testid="lp-liquidity-zoom"]')?.dataset.window).toBe("60");
      expect(m.host.textContent).not.toContain("old-window-error");
      expect(m.host.querySelector('[data-testid="lp-liquidity-spinner"]')).not.toBeNull();
    } finally { await m.unmount(); }
  });


  it("draws the range and chart for a pool the rails cannot read yet, but blocks Deploy with the plane's reason", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const young = { ...BTCB_WBNB, pool: "0x47bc06722295ac316a569eef87ac32faa455f441", token0: "0x205812cdbed920aff76c6580abd681a46d11efc7", token0Symbol: "QQQB" };
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/pools") return json({ data: [young] });
      if (url.startsWith("/api/pool-state?address=")) return json({ data: { pool: young.pool, currentTick: -635, tickSpacing: 10, blockNumber: "1", poolLiquidity: "5", observationCardinality: null, railsReady: false, railsReason: "This pool's price history is too short for the manipulation rails (its TWAP cannot be read yet)." } });
      if (url.startsWith("/api/pool-liquidity?address=")) return json({ data: { pool: young.pool, blockNumber: "1", currentTick: -635, tickSpacing: 10, activeLiquidity: "5", bins: [{ tickLower: -640, liquidity: "5" }, { tickLower: -630, liquidity: "3" }], truncated: false } });
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    try {
      await act(async () => { root.render(<DeployAgentScreen kind="lp" go={() => undefined} />); await settle(); });
      const search = host.querySelector<HTMLInputElement>('input[placeholder^="Search pair"]');
      await act(async () => { search?.blur(); search?.focus(); });
      const pick = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("QQQB / WBNB"));
      await act(async () => { pick?.click(); await settle(); });
      await act(async () => { await settle(); });
      // Range and chart are drawn from the light read…
      expect(host.textContent).toContain("Current price");
      expect(host.querySelectorAll("[data-tick]").length).toBe(2);
      // …the plane's rails reason is shown, and Deploy is blocked with exactly that reason.
      expect(host.querySelector('[data-testid="lp-rails-warning"]')?.textContent).toContain("manipulation rails");
      expect(host.querySelector<HTMLButtonElement>('[data-testid="lp-deploy-props"]')?.dataset.blocked).toContain("manipulation rails");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      vi.unstubAllGlobals();
    }
  });

});

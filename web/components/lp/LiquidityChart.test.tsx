// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LiquidityChart, type LiquidityChartProps } from "./LiquidityChart";
const geometry={spacing:10,currentTick:100,currentTickAsOfMs:1,orientation:{quoteIsToken0:true,decimals0:18,decimals1:18,symbol0:"USDT",symbol1:"WBNB"},display:{invert:false}};
afterEach(()=>vi.unstubAllGlobals());
it.each(["live","reference","unavailable","no-geometry"] as const)("shared chart %s preserves honest range and separate fetched tick",async mode=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({data:{bins:[{tickLower:-10,liquidity:"10"},{tickLower:0,liquidity:"20"}],currentTick:-5,blockNumber:"100",truncated:true}}),{status:200})));
  const host=document.createElement("div"),root=createRoot(host);
  const range:LiquidityChartProps["range"]=mode==="unavailable"?{mode:"unavailable",reason:"range unavailable"}:{mode:mode==="live"?"live":"reference",tickLower:-10,tickUpper:10};
  try {
    await act(async()=>{root.render(<LiquidityChart poolAddress="0x1111111111111111111111111111111111111111" geometry={mode==="no-geometry"?null:geometry} range={range} legend={{range:"position range"}}/>);await Promise.resolve();await Promise.resolve();});
    if(mode==="no-geometry"){expect(host.textContent).toContain("Price geometry unavailable");expect(host.querySelector("[data-tick]")).toBeNull();return;}
    expect(host.querySelector('[data-market="true"]')?.getAttribute("data-tick")).toBe("-10");
    expect(host.querySelector('[data-testid="lp-liquidity-legend"]')?.getAttribute("data-block")).toBe("100");
    expect(host.textContent).toContain("edges truncated");
    expect(host.querySelectorAll('[data-in-range="true"]').length).toBe(mode==="live"?2:0);
    if(mode==="reference"){expect(host.querySelector('[data-testid="lp-reference-range"]')).not.toBeNull();expect(host.textContent).toContain("pool snapshot");}
    if(mode==="unavailable")expect(host.textContent).toContain("range unavailable");
  }finally{await act(async()=>root.unmount());}
});

it.each([true,false])("draws the price axis min → max: quote-is-token0=%s",async quoteIsToken0=>{
  // Ticks rise with token1-per-token0. With the quote on token0 (USDT/WBNB) a
  // higher tick is a LOWER price, so the tick-ascending bins must be reversed
  // for the left-to-right price axis (operator hotfix 2026-09-06).
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({data:{bins:[{tickLower:-10,liquidity:"10"},{tickLower:0,liquidity:"20"},{tickLower:10,liquidity:"5"}],currentTick:-5,blockNumber:"100",truncated:false}}),{status:200})));
  const host=document.createElement("div"),root=createRoot(host);
  const g={...geometry,orientation:{...geometry.orientation,quoteIsToken0}};
  try {
    await act(async()=>{root.render(<LiquidityChart poolAddress="0x1111111111111111111111111111111111111111" geometry={g} range={{mode:"live",tickLower:-10,tickUpper:10}} legend={{range:"position range"}}/>);await Promise.resolve();await Promise.resolve();});
    const ticks=[...host.querySelectorAll("[data-tick]")].map(el=>Number(el.getAttribute("data-tick")));
    expect(ticks).toEqual(quoteIsToken0?[10,0,-10]:[-10,0,10]);
  }finally{await act(async()=>root.unmount());}
});

it("offers the unit flip only where a handler is given, and names the unit it is in", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { bins: [{ tickLower: 0, liquidity: "1" }], currentTick: 0, blockNumber: "1" } }), { status: 200 })));
  const host = document.createElement("div"), root = createRoot(host);
  const flip = vi.fn();
  const props = { poolAddress: "0x1111111111111111111111111111111111111111", geometry, range: { mode: "live", tickLower: -10, tickUpper: 10 }, legend: { range: "position range" } } as const;
  try {
    // The deploy form passes no handler: its header keeps exactly the controls it had.
    await act(async () => { root.render(<LiquidityChart {...props} />); await Promise.resolve(); });
    expect([...host.querySelectorAll("button")].some(b => b.textContent?.includes("per"))).toBe(false);

    await act(async () => { root.render(<LiquidityChart {...props} onFlipUnits={flip} />); await Promise.resolve(); });
    const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("per"))!;
    // quoteIsToken0 with invert false: USDT is the quote, WBNB the base.
    expect(button.textContent).toContain("USDT per WBNB");
    expect(button.getAttribute("aria-label")).toBe("Show prices in WBNB per USDT");
    await act(async () => button.click());
    expect(flip).toHaveBeenCalledTimes(1);

    // Flipped by the parent: the label follows the orientation, one inversion only.
    const flipped = { ...geometry, display: { invert: true } };
    await act(async () => { root.render(<LiquidityChart {...props} geometry={flipped} onFlipUnits={flip} />); await Promise.resolve(); });
    expect([...host.querySelectorAll("button")].find(b => b.textContent?.includes("per"))!.textContent).toContain("WBNB per USDT");
  } finally { await act(async () => root.unmount()); }
});

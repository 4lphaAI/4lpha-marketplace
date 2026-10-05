// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TradeDcaView } from "@/lib/trade";

vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div data-testid="market-chart" /> }));
import { DcaDetail } from "./TradeAgentDetail";

/** AGENTIC-DCA 4.6: DcaDetail's default props render as before, and readOnly takes every owner door away. */
const E = 10n ** 18n;
const order = { tickLower: 0, tickUpper: 50, closedBy: null, usdtWei: (10n * E).toString(), stockWei: "0", txHash: null } as const;
const dca = (): TradeDcaView => ({
  token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", symbol: "NVDAB", fee: 2500, usdtIsToken0: false,
  settings: { stepBps: 100, takeProfitBps: 150, baseWei: (15n * E).toString(), orderWei: (10n * E).toString(), maxOrders: 3, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: 1500 },
  round: { roundNo: 1, phase: "active", closeCause: null, openedAt: 1, unreliable: false, p0E8: "22337000000", avgCostE8: "22400000000", tpTargetE8: "22736000000", costUsdtWei: (15n * E).toString(),
    stockHeldWei: "67000000000000000", realizedPnlWei: null, base: null,
    levels: [{ ...order, levelNo: 1, levelPriceE8: "22113630000", state: "resting", tokenId: "11", edgePriceE8: "22113630000" }],
    tp: { ...order, state: "resting", tokenId: "10", rangeLowE8: "22740000000", rangeHighE8: "22850000000", usdtWei: "0", edgePriceE8: "22740000000" } },
  rounds: { settled: 0, realizedPnlWei: "0", lastSettledAt: null }, equity: null, wallet: null, reason: null, inFlight: null, unknownAction: null,
});

async function render(readOnly: boolean | undefined) {
  const host = document.createElement("div"), root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
  await act(async () => root.render(<DcaDetail dca={dca()} status="paused" draining={false} planeUnreachable busy={false} pull={() => undefined} refresh={async () => undefined} icon={null}
    runs={[]} symbols={{}} {...(readOnly === undefined ? {} : { readOnly })} />));
  return { host, done: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; } };
}

describe("DcaDetail readOnly", () => {
  it("by default shows the pull door, Close on chain, the Pancake link and the Altana paused note", async () => {
    for (const flag of [undefined, false]) {
      const page = await render(flag);
      try {
        expect([...page.host.querySelectorAll("button")].some((entry) => entry.textContent === "Pull resting orders")).toBe(true);
        expect([...page.host.querySelectorAll("button")].filter((entry) => entry.textContent === "Close on chain")).toHaveLength(2);
        expect(page.host.querySelector("a.fl-lp-nft-link")?.getAttribute("href")).toContain("pancakeswap.finance/liquidity/10");
        expect(page.host.querySelector('[data-testid="dca-paused"]')).not.toBeNull();
        expect(page.host.querySelector('[data-testid="dca-ro-setting-up"]')).toBeNull();
      } finally { await page.done(); }
    }
  });

  it("under readOnly shows no door, no link and none of the Altana notes, and a dash where the order has no Pancake position", async () => {
    const page = await render(true);
    try {
      const text = page.host.textContent ?? "";
      for (const gone of ["Pull resting orders", "Close on chain", "Pull resting orders closes", "Paused. Your resting orders", "passkey"]) expect(text).not.toContain(gone);
      expect(page.host.querySelector("a.fl-lp-nft-link")).toBeNull();
      expect(page.host.querySelector('[data-testid="dca-pull-note"]')).toBeNull();
      expect(page.host.querySelector('[data-testid="dca-paused"]')).toBeNull();
      const rows = [...page.host.querySelectorAll('[data-testid="dca-order"]')].map((row) => row.textContent ?? "");
      expect(rows[0]).toContain("—");
      expect(rows[1]).toContain("—");
      for (const row of rows) expect(row).not.toMatch(/#\d{3,}/u);
      expect([...page.host.querySelectorAll('[data-testid="dca-order"] a')].some((link) => (link.getAttribute("href") ?? "").includes("pancake"))).toBe(false);
    } finally { await page.done(); }
  });
});

describe("DcaTiles", () => {
  it("renders exactly as before without the ended prop (Altana unchanged) and swaps only the Average-price tile with it", async () => {
    const { DcaTiles } = await import("./TradeAgentDetail");
    const html = async (props: Record<string, unknown>) => {
      const host = document.createElement("div"), root = createRoot(host);
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      await act(async () => root.render(<DcaTiles dca={dca()} settings={{ capitalQuoteWei: (65n * E).toString() }} live {...props} />));
      const out = host.innerHTML;
      await act(async () => root.unmount());
      return out;
    };
    const plain = await html({}), explicit = await html({ ended: undefined });
    expect(explicit).toBe(plain);
    expect(plain).toContain("Holding 0.067 NVDAB");
    const ended = await html({ ended: { avgCostE8: "22400000000" } });
    expect(ended).not.toBe(plain);
    expect(ended).toContain("224 USDT");
    expect(ended).toContain("The chain could not be read; refresh in a moment.");
  });
});

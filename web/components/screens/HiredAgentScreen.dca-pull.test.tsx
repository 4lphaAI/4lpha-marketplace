// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AgentDetailView } from "@/lib/exec/agent-detail";
import type { OnChainPosition } from "@/lib/altana/position-reader";
import type { TradeDcaView, TradeSettings, TradeView } from "@/lib/trade";

// AUTO-DCA R2.11 / D18: the pull door reads the positions from chain in the browser — the
// wallet's NFPM enumeration filtered to the DCA pool with liquidity > 0 — and hands the
// reader's own minimums to ONE `closeLpPositionsWithPasskey` batch.
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const hook = vi.hoisted(() => ({
  detail: null as unknown,
  owner: { ownerAddress: "0x1111111111111111111111111111111111111111", passkey: { walletAddress: "0x2222222222222222222222222222222222222222" } as unknown, signEnvelope: vi.fn() },
  closeLpPositionsWithPasskey: vi.fn(async (_input: unknown) => ({ status: "CONFIRMED", callsId: `0x${"ab".repeat(32)}` })),
  readOnChainPosition: vi.fn(),
  listWalletPositionIds: vi.fn(),
}));
vi.mock("@/lib/exec/use-agent-detail", () => ({ useAgentDetail: () => hook.detail }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => hook.owner }));
vi.mock("@/lib/altana/client", () => ({ closeLpPositionsWithPasskey: hook.closeLpPositionsWithPasskey }));
vi.mock("@/lib/altana/position-reader", () => ({
  readOnChainPosition: hook.readOnChainPosition,
  listWalletPositionIds: hook.listWalletPositionIds,
  readWalletLegBalances: async () => ({ kind: "unavailable", reason: "not read" }),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => ({}), useAccount: () => ({ address: undefined }) }));
vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div /> }));
vi.mock("@/lib/altana/cmc-budget", () => ({ executeCmcBudgetCalls: vi.fn(), keyHashForSession: () => `0x${"ab".repeat(32)}` }));
vi.mock("@/components/FundsModal", () => ({ FundsModal: () => <div /> }));

import { HiredAgentScreen } from "./HiredAgentScreen";

function position(tokenId: bigint, over: Partial<OnChainPosition> = {}): OnChainPosition {
  return { kind: "position", blockNumber: 1n, readAtMs: 1, sqrtPriceX96: 1n, amountsAvailable: true, tokenId, liquidity: 5n,
    token0: NVDAB as `0x${string}`, token1: USDT as `0x${string}`, fee: 2500, tickLower: 0, tickUpper: 50,
    amounts: { amount0: 100n, amount1: 0n }, minimums: { amount0: 99n + tokenId, amount1: 0n }, owed: { amount0: 0n, amount1: 0n }, ...over };
}

const dca = { token: NVDAB, symbol: "NVDAB", fee: 2500, usdtIsToken0: false,
  settings: { stepBps: 100, takeProfitBps: 150, baseWei: "15", orderWei: "10", maxOrders: 4, triggerE8: null, rangeMinE8: null, rangeMaxE8: null, stopLossBps: null },
  round: { roundNo: 1, phase: "active", closeCause: null, openedAt: 1, unreliable: false, p0E8: null, avgCostE8: null, tpTargetE8: null, costUsdtWei: "0",
    stockHeldWei: "0", realizedPnlWei: null, levels: [], tp: { tokenId: "10", tickLower: 0, tickUpper: 50, closedBy: null, usdtWei: "0", stockWei: "1", txHash: null,
      state: "resting", rangeLowE8: "1", rangeHighE8: "2" } },
  rounds: { settled: 0, realizedPnlWei: "0", lastSettledAt: null }, equity: null, wallet: null, reason: "no-active-round", inFlight: null, unknownAction: null } satisfies TradeDcaView;

async function render(): Promise<{ readonly host: HTMLElement; readonly done: () => Promise<void> }> {
  const view = { id: "auto-dca-01", status: "paused", httpRuntimeProfile: "trade-v1", hireSizingName: "trade-v1", walletAddress: "0x2222222222222222222222222222222222222222",
    sessionPublicKey: null, sessionExpiresAt: null, provisioning: false, actionDisabledReason: null, armMs: 1, positions: [], sequences: [], motions: [], levels: [],
    dailyNativeLimit: { value: null, reason: "—" }, grid: { pool: "0x5555555555555555555555555555555555555555", gapTicks: 150, tickSpacing: 10 } } as unknown as AgentDetailView;
  const trade = { settings: { name: "Auto DCA 01", settlementAsset: "USDT", tradeMode: "dca" } as TradeSettings, dca, open: [], closed: [], runs: [], pinned: [],
    marketHours: { usEquitiesOpen: false, holidaysModeled: false }, lifecycle: { draining: false, drainingAt: null }, pendingIntents: [],
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: 0, maxOpenPositions: 1, observedAt: null } } as TradeView;
  hook.detail = { state: "ready", view, market: null, trade, asOfMs: 1, message: "", readHeaders: {}, signIn: vi.fn(), refresh: vi.fn(async () => view),
    refreshTrade: vi.fn(async () => trade), refreshLending: vi.fn() };
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })));
  await act(async () => root.render(<HiredAgentScreen agentId="auto-dca-01" go={() => undefined} />));
  return { host, done: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); } };
}

describe("the DCA pull door's browser discovery (R2.11)", () => {
  it("pulls only the DCA pool's positions with liquidity, at the reader's minimums, in one batch", async () => {
    // X6: 98 sits at the DCA fee in another pair — only the stock/USDT pair is pulled.
    hook.listWalletPositionIds.mockResolvedValue([10n, 11n, 99n, 98n, 12n]);
    hook.readOnChainPosition.mockImplementation(async (_client: unknown, _nfpm: unknown, id: bigint) =>
      id === 11n ? position(11n, { liquidity: 0n }) : id === 99n ? position(99n, { fee: 100 })
        : id === 98n ? position(98n, { token0: "0x9999999999999999999999999999999999999999" }) : position(id));
    const page = await render();
    try {
      const pull = [...page.host.querySelectorAll("button")].find((button) => button.textContent === "Pull resting orders");
      expect(pull).toBeDefined();
      await act(async () => { pull!.click(); });
      for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
      expect(hook.closeLpPositionsWithPasskey).toHaveBeenCalledTimes(1);
      const input = hook.closeLpPositionsWithPasskey.mock.calls[0]![0] as unknown as { readonly positions: readonly { tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint }[] };
      expect(input.positions).toEqual([
        { tokenId: 10n, liquidity: 5n, amount0Min: 109n, amount1Min: 0n },
        { tokenId: 12n, liquidity: 5n, amount0Min: 111n, amount1Min: 0n },
      ]);

      hook.closeLpPositionsWithPasskey.mockClear();
      const close = [...page.host.querySelectorAll("button")].find((button) => button.textContent === "Close on chain");
      await act(async () => { close!.click(); });
      for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
      const one = hook.closeLpPositionsWithPasskey.mock.calls[0]![0] as unknown as { readonly positions: readonly { tokenId: bigint }[] };
      expect(one.positions.map((row) => row.tokenId)).toEqual([10n]);
    } finally { await page.done(); }
  });
});

describe("AUTO-DCA R4.8: the DCA Remove loop (source pins)", () => {
  const source = readFileSync(new URL("./HiredAgentScreen.tsx", import.meta.url), "utf8");

  it("imports dcaRemoveProgress and DCA_REMOVE_PATIENCE_MS from TradeRunLog", () => {
    expect(source).toMatch(/import \{ DCA_REMOVE_PATIENCE_MS, dcaRemoveProgress \} from "@\/components\/trade\/TradeRunLog";/u);
  });

  it("the DCA loop (for (;;)) has no `attempt < 50`; the non-DCA loop keeps it", () => {
    const dcaLoopStart = source.indexOf("if (dcaAgent) {");
    const elseStart = source.indexOf("} else {", dcaLoopStart);
    const dcaLoop = source.slice(dcaLoopStart, elseStart);
    const nonDcaLoopEnd = source.indexOf("\n      }", elseStart);
    const nonDcaLoop = source.slice(elseStart, nonDcaLoopEnd);
    expect(dcaLoop).toMatch(/for \(;;\) \{/u);
    expect(dcaLoop).not.toMatch(/attempt < 50/u);
    expect(nonDcaLoop).toMatch(/attempt < 50/u);
    expect(dcaLoop).toMatch(/dcaRemoveProgress\(/u);
    expect(dcaLoop).toMatch(/DCA_REMOVE_PATIENCE_MS/u);
  });
});

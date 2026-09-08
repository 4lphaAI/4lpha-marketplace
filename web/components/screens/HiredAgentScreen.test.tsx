// @vitest-environment happy-dom
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentDetailView, OhlcvResult } from "@/lib/exec/agent-detail";

const hook = vi.hoisted(() => ({
  detail: null as unknown,
  owner: {
    ownerAddress: "0x1111111111111111111111111111111111111111",
    passkey: null as unknown,
    signEnvelope: vi.fn(),
  },
  readRevokeCallsStatus: vi.fn(async()=>({kind:"pending"})),
  revokeAgentSession: vi.fn(),
  closeLpPositionWithPasskey: vi.fn(),
  publicClient: undefined as unknown,
  readOnChainPosition: vi.fn(),
  listWalletPositionIds: vi.fn(),
}));
vi.mock("@/lib/exec/use-agent-detail", () => ({ useAgentDetail: () => hook.detail }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => hook.owner }));
vi.mock("@/lib/altana/client", () => ({
  readRevokeCallsStatus: hook.readRevokeCallsStatus,
  revokeAgentSession: hook.revokeAgentSession,
  closeLpPositionWithPasskey: hook.closeLpPositionWithPasskey,
}));
vi.mock("@/lib/altana/position-reader", () => ({
  readOnChainPosition: hook.readOnChainPosition,
  listWalletPositionIds: hook.listWalletPositionIds,
  // Dust is telemetry: an unavailable read must never change the Remove path.
  readWalletLegBalances: async () => ({ kind: "unavailable", reason: "wallet balances not readable" }),
}));
// The screen reads each position NFT straight from chain, because the plane's
// row and the chain disagreed once (2026-09-03, NFT 7316794). No client in a
// static render: the reads are skipped and every assertion below is unchanged.
vi.mock("wagmi", () => ({ usePublicClient: () => hook.publicClient }));

import { HiredAgentScreen } from "./HiredAgentScreen";

const metric = (value: string) => ({ value, reason: null });
const view: AgentDetailView = {
  hireSizingName: "grid-shift-v1",
  id: "owner-exact-agent-92",
  status: "armed",
  walletAddress: "0x2222222222222222222222222222222222222222",
  sessionPublicKey: `0x${"33".repeat(64)}`,
  provisioning: false,
  actionDisabledReason: null,
  armMs: 1_000,
  dailyNativeLimit: { ...metric("0.123456 BNB · $79.63"), bnb: "0.123456 BNB", usd: "$79.63" },
  grossPnl: { value: "+0.001200 WBNB", reason: null, note: "gross, excludes gas" },
  grossPnlPercent: { value: "+2.89%", reason: null, note: "gross, excludes gas" },
  recordedCycleDelta: metric("-0.000777 WBNB"),
  recordedCycles: metric("7 recorded · 3 round trips"),
  levels: [{ positionId: "real-position-7", role: "buy", recordedCycles: 7, roundTrips: 3, deltaWei: "-777", delta: metric("-0.000000000000000777 WBNB") }],
  cycleHistoryAvailable: true,
  cycleNote: "Derived telemetry: a row can be lost if the post-confirm write fails; counts are a lower bound.",
  gas: null,
  motions: [{ sequenceId: "sequence-real", classification: "settlement", label: "Buy rung filled", collected: "0.002 WBNB + 9.25 USDT", price: metric("645.12345678 USDT/BNB"), time: "2m ago", timeTitle: "2026-09-02T00:00:00.000Z", txHash: `0x${"44".repeat(32)}` }],
  sequences: [{ sequenceId: "sequence-real", positionId: "real-position-7", kind: "grid-flip", state: "completed", recoveryState: "none", note: "settled", outcomeUnavailable: false, txHashes: [`0x${"44".repeat(32)}`], steps: [{ index: 0, kind: "zap-out", decisionId: "lp:sequence-real:0", state: "COMMITTED" }], updatedAt: 2_000, createdAt: 1_500, shiftCause: null, targetBuyRange: null, targetSellRange: null }],
  positions: [{ positionId: "real-position-7", state: "open", tokenId: "9007199254740993", pair: "WBNB / USDT", role: "buy", sideLabel: "BID USDT", rung: { tickLower: -9, tickUpper: 1, priceLow: "640.00000000", priceHigh: "645.00000000", fillPrice: "640.00000000" }, age: "2h ago", ageTitle: "2026-09-02T00:00:00.000Z", value: metric("0.081 WBNB"), unrealised: metric("-0.004 WBNB"), fees: { value: null, reason: "— fees are counted in unrealised" }, nftUrl: "https://bscscan.com/nft/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364/9007199254740993" }],
  lp: null,
  grid: { pool: "0x5555555555555555555555555555555555555555", pair: "WBNB / USDT", base: "WBNB" as const, quote: "USDT" as const, symbol0: "USDT", symbol1: "WBNB", decimals0: 18, decimals1: 18, token0: "0x55d398326f99059ff775485246999027b3197955", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", fee: 100, wbnbIsToken0: false, observedPrice: "645.00000000", quoteUsd: 1, baseAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", quoteAddress: "0x55d398326f99059ff775485246999027b3197955", buyPrices: { low: "640.00000000", high: "645.00000000" }, sellPrices: { low: "646.00000000", high: "650.00000000" }, tickSpacing: 10, mode: "shift", gapTicks: 150, widthTicks: 100, driftPctOfGap: 0, buyRange: { tickLower: -9, tickUpper: 1 }, sellRange: { tickLower: 1, tickUpper: 11 }, observedTick: -3, observationAgeMs: 2_000, observationStale: false, tickSource: "worker", rangeUnavailableBecause: null, liveRows: 1 },
};
function lpFixture(): NonNullable<AgentDetailView["lp"]> {
  return {model:"custom",pool:{...view.grid,poolAddress:view.grid.pool},openingRange:{source:"explicit",tickLower:-9,tickUpper:1},
    liveRange:null,liveRangeReason:"not observed",currentTick:null,currentTickAsOfMs:null,currentTickSource:null,currentTickReason:"not observed",
    settingsTrusted:true,settingsReason:null,settings:null,valuation:metric("1 WBNB"),recordedPnl:metric("0 WBNB"),budgetWei:"1",selectPool:null,restart:null,reason:null};
}
const market: OhlcvResult = { candles: [{ timestamp: 1_000, open: 640, high: 646, low: 639, close: 645, volume: 1 }], stale: false, banner: null, priceNow: 645, hodl: metric("0.78%") };

function render(nextView: AgentDetailView = view): string {
  hook.detail = { state: "ready", view: nextView, market, trade: null, asOfMs: 2_000, message: "", readHeaders: {}, signIn: vi.fn(), refresh: vi.fn() };
  return renderToStaticMarkup(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
}

describe("Hired agent detail provenance", () => {
  it("shows the shared identity status on Grid, Trading and LP details without new signing actions", () => {
    const identity = { status: "blocked", errorCode: "invalid_identity" } as const;
    for (const hireSizingName of ["grid-shift-v1", "trade-v1", "lp-v1"]) {
      const html = render({ ...view, hireSizingName, lp: hireSizingName === "lp-v1" ? lpFixture() : null, erc8004Identity: identity });
      expect(html).toContain("ERC-8004 registration needs attention");
      expect(html).not.toContain("Identity owned by");
      expect(html).not.toContain("ERC-8004 #");
      expect(hook.owner.signEnvelope).not.toHaveBeenCalled();
    }
    expect(render()).not.toContain("ERC-8004");
  });
  it("renders the exact owner id, fixture-derived metrics, and canonical NFT URL", () => {
    const html = render();
    expect(html).toContain("owner-exact-agent-92");
    // Delegated shows ONE unit, USD by default, with the BNB switch beside it.
    expect(html).toContain("$79.63");
    expect(html).not.toContain("0.123456 BNB · $79.63");
    // The PnL tiles show the GROSS figure (holdings vs armed budget), which is
    // defined before any fill; the realised round-trip delta stays on the view
    // for the level rows.
    expect(html).toContain("+0.001200 WBNB");
    expect(html).toContain("+2.89%");
    expect(html).not.toContain("0.78%"); // Chart return is no longer the HODL baseline.
    expect(html).toContain("Position");
    expect(html).toContain("900719…0993 · GRID ORDER");
    expect(html).toContain("0.081 WBNB");
    expect(html).toContain("-0.004 WBNB");
    expect(html).toContain("https://bscscan.com/nft/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364/9007199254740993");
  });

  it("renders only the on-chain HODL percentage, without amount, description or receipt link", () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const html = render({ ...view, armMs: 1788717275000, hodlArmTxHash: txHash,
      hodl: { value: "-4.78%", reason: null, note: "holding mubarak since on-chain arm" } });
    expect(html).toContain("-4.78%");
    expect(html).not.toContain("-$2.25");
    expect(html).not.toContain("holding mubarak since on-chain arm");
    expect(html).not.toContain(`https://bscscan.com/tx/${txHash}`);
    expect(html).not.toContain("On-chain arm:");
    expect(html).not.toContain("0.78%");
  });

  it("keeps ordinary lifecycle actions disabled and offers cancellation for an incomplete hire", () => {
    const html = render({ ...view, status: "provisioning", provisioning: true, actionDisabledReason: "This agent is still being hired. Finish the on-chain grant, or cancel the hire." });
    expect(html).toContain("provisioning");
    expect(html).not.toContain("This agent is still being hired. Finish the on-chain grant, or cancel the hire.");
    expect((html.match(/disabled=""/gu) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Setup incomplete.");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Cancel hire<\/button>/u);
    expect(html).not.toMatch(/>Remove<\/button>/u);
  });

  it("keeps the approved layout signed out and dashes unsourced values in place", () => {
    hook.detail = { state: "signed-out", view: null, market: null, asOfMs: null, message: "Sign in to load this agent.", readHeaders: {}, signIn: vi.fn(), refresh: vi.fn() };
    const html = renderToStaticMarkup(<HiredAgentScreen agentId="route-only-id" go={() => undefined} />);
    expect(html).toContain("Sign in to view");
    expect(html).toContain("Sign in to load this agent.");
    expect(html).toContain("<h1 style=\"font:var(--type-page-title)\">route-only-id</h1>");
    expect(html).toContain("Delegated");
    expect(html).toContain("PNL by percent");
    expect(html).toContain("Position");
  });

  it("has no legacy mock arrays, chart, fake hashes, or fallback literals in the source", () => {
    const source = readFileSync(join(process.cwd(), "components/screens/HiredAgentScreen.tsx"), "utf8");
    const detailHook = readFileSync(join(process.cwd(), "lib/exec/use-agent-detail.ts"), "utf8");
    for (const legacy of ["const RUNS", "const PRICE", "const FILLS", "const FEED", "const TICKS", "const POSITIONS", "$3,100", "+$284.10", "+0.38%", "+1.42%", "+$0.00", "4 FILLS", "50% WBNB", "0x8f2a…c41", "Daily native session limit", "Recorded cycle delta", "Live lineages", "Motion feed", "Number(rawAtomic)"]) {
      expect(source).not.toContain(legacy);
    }
    for (const approved of ["Delegated", "PnL since hire", "PNL by percent", "HODL benchmark", "Show charts", "Fill feed", "Liquidity", "Position", "Age", "Size", "Side", "Fees", "Unrealised", "Actions", "Refresh", "Overview", "Run log", "Health factor", "Edit", "Pause", "Remove"]) {
      expect(source).toContain(approved);
    }
    expect(source).toContain("classification !== \"settlement\"");
    expect(source).toContain("<MarketChart");
    expect(source).toContain('hireSizingName === "trade-v1"');
    expect(source).toContain('hireSizingName === "lp-v1"');
    expect(detailHook).toContain('hireSizing?.name === "trade-v1"');
    expect(detailHook).toContain('view.hireSizingName === "lp-v1"');
    expect(source).not.toContain('httpRuntimeProfile === "trade-v1"');
    expect(detailHook).not.toContain('httpRuntimeProfile"] === "trade-v1"');
  });

  it("wires fail-closed serialized revoke recovery and exposes relay evidence", () => {
    const source = readFileSync(join(process.cwd(), "components/screens/HiredAgentScreen.tsx"), "utf8");
    for (const required of [
      "navigator.locks.request",
      "mayBeginRemoveAttempt",
      "currentAttemptRaw !== observed.attemptRaw",
      "currentLegacyRaw !== observed.legacyRaw",
      "!removeProgressHydrated",
      "Check removal",
      "Retry on-chain revoke",
      "relay gas may be spent again",
      "Relay call",
      "View transaction",
      "https://bscscan.com/tx/",
    ]) {
      expect(source).toContain(required);
    }
  });

  it("admits only one paid revoke when two mounted tabs observed the same empty storage", async () => {
    hook.publicClient = {};
    hook.listWalletPositionIds.mockResolvedValue([]);
    const revokedView = { ...view, status: "revoked", positions: [], sequences: [] };
    const refresh = vi.fn(async () => revokedView);
    hook.detail = {
      state: "ready", view: revokedView, market: null, trade: null, asOfMs: 2_000,
      message: "", readHeaders: {}, signIn: vi.fn(), refresh,
    };
    hook.owner.passkey = { walletAddress: view.walletAddress };
    hook.owner.signEnvelope.mockReset();
    hook.revokeAgentSession.mockReset();
    let finishFirst: ((value: { status: "PENDING"; callsId: `0x${string}` }) => void) | undefined;
    hook.revokeAgentSession.mockImplementation(() => new Promise((resolve) => { finishFirst = resolve; }));
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: {
        sessionRegistration: { kind: "registered", checkedAtMs: Date.now() },
        finalizedSessionRevocation: {
          kind: "registered", checkedAtMs: Date.now(), finalizedBlockNumber: "100",
          finalizedBlockHash: `0x${"55".repeat(32)}`,
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    let tail = Promise.resolve<unknown>(undefined);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
          const run = tail.then(callback);
          tail = run.catch(() => undefined);
          return run;
        },
      },
    });
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);
    const firstRoot = createRoot(firstHost);
    const secondRoot = createRoot(secondHost);
    await act(async () => {
      firstRoot.render(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
      secondRoot.render(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
      await Promise.resolve();
    });
    const removeButton = (host: HTMLElement) => [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Remove");
    expect(removeButton(firstHost)?.disabled).toBe(false);
    expect(removeButton(secondHost)?.disabled).toBe(false);
    await act(async () => {
      removeButton(firstHost)?.click();
      removeButton(secondHost)?.click();
      await tail;
      await Promise.resolve();
    });
    expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishFirst?.({ status: "PENDING", callsId: "0x1234" });
      await Promise.resolve();
      await Promise.resolve();
    });
    firstRoot.unmount();
    secondRoot.unmount();
    firstHost.remove();
    secondHost.remove();
    vi.unstubAllGlobals();
  });

  for (const mode of ["grid", "lp", "unreadable", "pending", "price-unavailable", "missing-client", "identity-change"] as const) it(`close ? fresh verification ? revoke: ${mode}`, async () => {
    let chainLiquidity = 500n;
    let deferReads = false;
    const pendingReads: (() => void)[] = [];
    const initialOwner = hook.owner.ownerAddress;
    let locallyRevoked = false;
    const effects: string[] = [];
    const closedRowView: AgentDetailView = {
      ...view,
      status: "paused",
      ...(mode === "grid" ? {} : { hireSizingName: "lp-v1", lp: lpFixture() }),
      positions: [{ ...view.positions[0]!, state: "closed" }],
    };
    const refresh = vi.fn(async () => ({
      ...closedRowView,
      status: locallyRevoked ? "revoked" : "paused",
    }));
    hook.detail = {
      state: "ready", view: closedRowView, market: null, trade: null, asOfMs: 2_000,
      message: "", readHeaders: {}, signIn: vi.fn(), refresh,
    };
    hook.owner.passkey = { walletAddress: view.walletAddress };
    hook.owner.signEnvelope.mockReset();
    hook.owner.signEnvelope.mockResolvedValue({ signed: true });
    hook.publicClient = {};
    hook.readOnChainPosition.mockReset();
    if (mode === "missing-client") hook.publicClient = undefined;
    hook.readOnChainPosition.mockImplementation(async () => {
      if (deferReads) await new Promise<void>(resolve => pendingReads.push(resolve));
      return mode === "unreadable" ? { kind: "unreadable", tokenId: 9007199254740993n, reason: "transport" } : ({
      kind: "position", blockNumber:100n,readAtMs:Date.now(),amountsAvailable:mode !== "price-unavailable",sqrtPriceX96:1n<<96n,
      tokenId: 9_007_199_254_740_993n,
      liquidity: chainLiquidity,
      token0: view.grid.token0,
      token1: view.grid.token1,
      fee: view.grid.fee,
      tickLower: -9,
      tickUpper: 1,
      amounts: { amount0: 1_000n, amount1: 2_000n },
      minimums: { amount0: 990n, amount1: 1_980n },
    }); });
    hook.listWalletPositionIds.mockReset();
    hook.listWalletPositionIds.mockResolvedValue([]);
    hook.closeLpPositionWithPasskey.mockReset();
    hook.closeLpPositionWithPasskey.mockImplementation(async () => {
      effects.push("close-nft");
      if (mode !== "pending") chainLiquidity = 0n;
      return { status: mode === "pending" ? "PENDING" : "CONFIRMED", callsId: "0x1234" };
    });
    hook.revokeAgentSession.mockReset();
    hook.revokeAgentSession.mockImplementation(async () => {
      effects.push("broadcast-revoke");
      return { status: "PENDING", callsId: "0xrevoke" };
    });
    window.localStorage.clear();
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() },
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/session")) {
        return new Response(JSON.stringify({ data: {
          sessionRegistration: { kind: "registered", checkedAtMs: Date.now() },
          finalizedSessionRevocation: { kind: "registered", checkedAtMs: Date.now(),
            finalizedBlockNumber: "100", finalizedBlockHash: `0x${"55".repeat(32)}` },
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/revoke")) {
        effects.push("local-revoke");
        locallyRevoked = true;
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      const remove = [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Remove");
      expect(remove?.disabled).toBe(false);
      deferReads = mode === "identity-change";
      await act(async () => {
        remove?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      if (mode === "identity-change") {
        await act(async()=>{hook.owner.ownerAddress="0x3333333333333333333333333333333333333333";root.render(<HiredAgentScreen agentId="changed-agent" go={()=>undefined}/>);await Promise.resolve();});
        deferReads=false;
        await act(async()=>{for(const resolve of pendingReads)resolve();await Promise.resolve();await Promise.resolve();});
        expect(hook.closeLpPositionWithPasskey).not.toHaveBeenCalled();expect(hook.revokeAgentSession).not.toHaveBeenCalled();return;
      }
      if (mode === "unreadable" || mode === "price-unavailable" || mode === "missing-client") {
        if (mode === "missing-client") expect(host.textContent).toContain("Cannot verify NFT state — connect the wallet that owns this agent, then try again.");
        expect(hook.closeLpPositionWithPasskey).not.toHaveBeenCalled();expect(hook.revokeAgentSession).not.toHaveBeenCalled();return;
      }
      expect(hook.closeLpPositionWithPasskey).toHaveBeenCalledTimes(1);
      if (mode === "pending") {
        expect(hook.revokeAgentSession).not.toHaveBeenCalled();
        await act(async()=>{remove?.click();await Promise.resolve();await Promise.resolve();});
        expect(hook.closeLpPositionWithPasskey).toHaveBeenCalledTimes(1);expect(hook.revokeAgentSession).not.toHaveBeenCalled();
        hook.readRevokeCallsStatus.mockResolvedValue({kind:"confirmed"}); chainLiquidity=0n;
        await act(async()=>{remove?.click();await Promise.resolve();await Promise.resolve();await Promise.resolve();});
        expect(hook.closeLpPositionWithPasskey).toHaveBeenCalledTimes(1);expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
        hook.readRevokeCallsStatus.mockResolvedValue({kind:"pending"});return;
      }
      expect(effects[0]).toBe("close-nft");
      expect(effects.indexOf("broadcast-revoke")).toBeGreaterThan(effects.indexOf("close-nft"));
      expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      hook.publicClient = undefined;
      hook.owner.ownerAddress = initialOwner;
      hook.owner.passkey = null;
      vi.unstubAllGlobals();
    }
  });

  it("shows the trade detail controls and keeps Remove available while a position is open", () => {
    hook.detail = {
      state: "ready",
      view: { ...view, httpRuntimeProfile: "unbound-v1", hireSizingName: "trade-v1" },
      market: null,
      trade: {
        settings: null,
        open: [{ positionId: "trade-position-1", token: "0x6666666666666666666666666666666666666666", entryWei: "5000000000000000", status: "orphaned", pnlBps: "125", exitRequestedAt: null, orphanedAt: 1_500, refusalText: "The last trade attempt was refused; the agent will retry when the blocking condition clears.", orphanedText: "This server will not sell this position (the agent was retired). Deploy a new agent on this wallet: it will list this token first and can close the position.", orphanedResidual: "A token outside every model's candidate set remains stranded until ERC-20 withdraw ships." },
          { positionId: "trade-position-2", token: "0x7777777777777777777777777777777777777777", entryWei: "4000000000000000", status: "open", pnlBps: "-40", exitRequestedAt: null, orphanedAt: null, refusalText: null, orphanedText: null, orphanedResidual: null }],
        closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: true, holidaysModeled: false },
        summary: { grossDeltaWei: null, grossComplete: false, grossReason: "live quote unavailable", wins: null, winRateBps: null, closedTrades: 0, openPositions: 2, maxOpenPositions: 3, observedAt: 2_000 },
        lifecycle: { draining: false, drainingAt: null }, pendingIntents: [],
      },
      asOfMs: 2_000, message: "", readHeaders: {}, signIn: vi.fn(), refresh: vi.fn(), refreshTrade: vi.fn(),
    };
    const html = renderToStaticMarkup(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
    expect(html).toContain("Remove");
    expect(html).toContain("Pause");
    expect(html).toContain("Sell");
    expect(html).not.toContain("Redeploy");
    expect(html).not.toContain("Retire");
    expect(html).toContain("Open Positions");
    expect(html).toContain("Refresh");
  });

  it("routes lp-v1 to the LP detail branch and leaves grid and trade branches intact", () => {
    const gridHtml = render({ ...view, hireSizingName: "grid-shift-v1" });
    expect(gridHtml).toContain("Show charts");
    expect(gridHtml).not.toContain("Sequence feed");
    expect(gridHtml).not.toContain("Opening range");

    hook.detail = {
      state: "ready",
      view: {
        ...view,
        httpRuntimeProfile: "unbound-v1",
        hireSizingName: "trade-v1",
      },
      market: null,
      trade: {
        settings: null,
        open: [{ positionId: "trade-position-1", token: "0x6666666666666666666666666666666666666666", entryWei: "5000000000000000", status: "open", pnlBps: "125", exitRequestedAt: null, orphanedAt: null, refusalText: null, orphanedText: null, orphanedResidual: null }],
        closed: [],
        runs: [],
        pinned: [],
        marketHours: { usEquitiesOpen: true, holidaysModeled: false },
        summary: { grossDeltaWei: null, grossComplete: false, grossReason: "live quote unavailable", wins: null, winRateBps: null, closedTrades: 0, openPositions: 1, maxOpenPositions: 3, observedAt: 2_000 },
        lifecycle: { draining: false, drainingAt: null },
        pendingIntents: [],
      },
      asOfMs: 2_000,
      message: "",
      readHeaders: {},
      signIn: vi.fn(),
      refresh: vi.fn(),
      refreshTrade: vi.fn(),
    };
    const tradeHtml = renderToStaticMarkup(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
    expect(tradeHtml).toContain("Open Positions");
    expect(tradeHtml).not.toContain("Sequence feed");
    expect(tradeHtml).not.toContain("Opening range");

    hook.detail = {
      state: "ready",
      view: {
        ...view,
        httpRuntimeProfile: "lp-v1",
        hireSizingName: "lp-v1",
        lp: {
          model: "sigma",
          pool: {
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
          valuation: { value: "1.234567 WBNB", reason: null, note: "as of 1m ago" },
          recordedPnl: { value: "+0.034567 WBNB", reason: null },
          budgetWei: "1200000000000000000",
          selectPool: { by: "fee-apr", window: "24h" },
          restart: null,
          reason: null,
        },
        positions: [],
        sequences: [{ sequenceId: "sequence-lp", positionId: "lp-position-1", kind: "rotate", state: "completed", recoveryState: "none", note: null, outcomeUnavailable: false, txHashes: [`0x${"66".repeat(32)}`], steps: [], updatedAt: 2_000, createdAt: 1_800, shiftCause: null, targetBuyRange: null, targetSellRange: null }],
        motions: [],
      },
      market,
      chartCandles: null,
      chartBanner: null,
      chartInterval: "1m",
      chartUnit: "quote",
      setChartInterval: vi.fn(),
      setChartUnit: vi.fn(),
      trade: null,
      asOfMs: 2_000,
      message: "",
      marketReason: null,
      readHeaders: {},
      signIn: vi.fn(),
      refresh: vi.fn(),
      refreshTrade: vi.fn(),
    };
    const lpHtml = renderToStaticMarkup(<HiredAgentScreen agentId="owner-exact-agent-92" go={() => undefined} />);
    expect(lpHtml).toContain("Liquidity");
    expect(lpHtml).toContain("Closed Positions");
    expect(lpHtml).toContain("Execution model");
    expect(lpHtml).not.toContain("Fill feed");
    expect(lpHtml).not.toContain("Open Positions");
  });

  it("pins the restricted editor, exact closed columns, and terminal recovery copy", () => {
    const source = readFileSync(join(process.cwd(), "components/trade/TradeAgentDetail.tsx"), "utf8");
    for (const forbidden of ["Agent name", "BNB per entry", "Total capital", "Min market cap", "Max market cap", "Gas priority", "Show advanced settings"]) {
      expect(source).not.toContain(forbidden);
    }
    for (const required of ["No re-entry", "Take profit", "Stop loss", "Max holding time", "Slippage tolerance", "Primary model", "Fallback model", "Exit reason", "Held", "Entry / exit", "Transactions", "Realised", "Hard revoke", "Account recovery", "does not complete conversion to BNB"]) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain("<span>Fees</span>");
    expect(source).toContain("LLM model:");
    expect(source).toContain("wins · gross");
    expect(source).toContain("max={100}");
    expect(source).toContain("max={10_080}");
    expect(source).toContain("disabled={model.id === draft.fallbackModel}");
    expect(source).toContain("disabled={model.id === draft.primaryModel}");
  });
});

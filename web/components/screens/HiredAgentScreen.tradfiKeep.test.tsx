// @vitest-environment happy-dom
/**
 * TRADFI-EXPIRY-KEEP-REMOVE §5.2 — the TradFi AI agent's Remove choice, the
 * Keep flow, its resume and completion, and the refreshed-lifecycle branching.
 * Same mocking style as `HiredAgentScreen.test.tsx`: the hooks, the SDK client
 * and `fetch` are doubles; what is asserted is what the screen signs and calls.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailView } from "@/lib/exec/agent-detail";
import type { TradeView } from "@/lib/trade";

const hook = vi.hoisted(() => ({
  detail: null as unknown,
  owner: {
    ownerAddress: "0x1111111111111111111111111111111111111111",
    passkey: null as unknown,
    signEnvelope: vi.fn(),
  },
  readRevokeCallsStatus: vi.fn(async () => ({ kind: "pending" })),
  revokeAgentSession: vi.fn(),
  closeLpPositionWithPasskey: vi.fn(),
}));
vi.mock("@/lib/exec/use-agent-detail", () => ({ useAgentDetail: () => hook.detail }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => hook.owner }));
vi.mock("@/lib/altana/client", () => ({
  readRevokeCallsStatus: hook.readRevokeCallsStatus,
  revokeAgentSession: hook.revokeAgentSession,
  closeLpPositionWithPasskey: hook.closeLpPositionWithPasskey,
}));
vi.mock("@/lib/altana/position-reader", () => ({
  readOnChainPosition: vi.fn(),
  listWalletPositionIds: vi.fn(async () => []),
  readWalletLegBalances: async () => ({ kind: "unavailable", reason: "wallet balances not readable" }),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => undefined, useAccount: () => ({ address: undefined }) }));
vi.mock("@/components/MarketChart", () => ({ MarketChart: () => <div data-testid="market-chart" /> }));
vi.mock("@/lib/altana/cmc-budget", () => ({ executeCmcBudgetCalls: vi.fn(), keyHashForSession: () => `0x${"ab".repeat(32)}` }));
vi.mock("@/components/FundsModal", () => ({ FundsModal: () => <div data-testid="funds-modal" /> }));

import { HiredAgentScreen } from "./HiredAgentScreen";

const AGENT = "tradfi-ai-agent";
const WALLET = "0x2222222222222222222222222222222222222222";
const metric = (value: string) => ({ value, reason: null });
const baseView = {
  hireSizingName: "trade-v1", armedBudgetWei: "50000000000000000", id: AGENT, status: "armed", walletAddress: WALLET,
  sessionPublicKey: `0x${"33".repeat(64)}`, sessionExpiresAt: null, provisioning: false, actionDisabledReason: null, armMs: 1_000,
  dailyNativeLimit: { ...metric("0.123456 BNB · $79.63"), bnb: "0.123456 BNB", usd: "$79.63" },
  grossPnl: metric("+0.0012 WBNB"), grossPnlPercent: metric("+2.89%"), recordedCycleDelta: metric("0"), recordedCycles: metric("0"), levels: [],
  cycleHistoryAvailable: false, cycleNote: "", gas: null, motions: [], sequences: [], positions: [], lp: null,
  grid: { pool: "0x5555555555555555555555555555555555555555", pair: "WBNB / USDT", base: "WBNB", quote: "USDT", symbol0: "USDT", symbol1: "WBNB", decimals0: 18, decimals1: 18,
    token0: "0x55d398326f99059ff775485246999027b3197955", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", fee: 100, wbnbIsToken0: false, sideInverted: true,
    observedPrice: "645.00000000", quoteUsd: 1, baseAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", quoteAddress: "0x55d398326f99059ff775485246999027b3197955",
    buyPrices: { low: "640", high: "645" }, sellPrices: { low: "646", high: "650" }, tickSpacing: 10, mode: "shift", gapTicks: 150, widthTicks: 100, driftPctOfGap: 0,
    deployPctBps: 3_000, shiftLane: { used: 1, perDay: 16 }, buyRange: { tickLower: -9, tickUpper: 1 }, sellRange: { tickLower: 1, tickUpper: 11 }, buyRungSource: "live",
    sellRungSource: "live", buyRungGap: null, sellRungGap: null, placement: "placed", observedTick: -3, observationAgeMs: 2_000, observationStale: false, tickSource: "worker",
    rangeUnavailableBecause: null, liveRows: 1 },
} as unknown as AgentDetailView;

const NOW_SEC = Math.floor(Date.now() / 1_000);

type World = {
  status: "armed" | "paused" | "revoked" | "retired";
  expired: boolean;
  tradfiAi: boolean;
  open: number;
  orphaned: boolean;
  draining: boolean;
  finalized: "registered" | "invalid";
  pendingIntents: number;
  refreshedStatus?: () => "armed" | "paused" | "revoked" | "retired";
  renewalPending?: boolean;
  noPasskey?: boolean;
};

function world(over: Partial<World> = {}): World {
  return { status: "armed", expired: false, tradfiAi: true, open: 2, orphaned: false, draining: false, finalized: "registered", pendingIntents: 0, ...over };
}

function agentView(w: World, status = w.status): AgentDetailView {
  return { ...baseView, status, sessionExpiresAt: w.expired ? NOW_SEC - 60 : NOW_SEC + 5 * 86_400, ...(w.renewalPending === true ? { renewalPending: true } : {}) } as AgentDetailView;
}

function tradeView(w: World): TradeView {
  const row = (index: number): TradeView["open"][number] => ({ positionId: `kept-${index}`, token: `0x${(index + 1).toString(16).padStart(40, "0")}`, route: { hops: [], fees: [] },
    entryWei: "5000000000000000000", tokenAmount: "9", fillStatus: "verified", openedAt: 1, entryTxHash: null, status: w.orphaned ? "orphaned" : "open", pnlBps: null,
    exitRequestedAt: null, orphanedAt: null, closedAt: null, exitWei: null, exitTxHash: null, soldTokenAmount: null, exitFillStatus: null, closeReason: null, refusalText: null, observation: null }) as never;
  const revoked = w.status === "revoked" || w.status === "retired";
  return {
    settings: null, open: Array.from({ length: w.open }, (_, index) => row(index)), closed: [], runs: [], pinned: [], marketHours: { usEquitiesOpen: false, holidaysModeled: false },
    summary: { grossDeltaWei: null, grossComplete: false, grossReason: null, wins: null, winRateBps: null, closedTrades: 0, openPositions: revoked && w.tradfiAi ? 0 : w.open, maxOpenPositions: 2, observedAt: null },
    lifecycle: { draining: w.draining, drainingAt: w.draining ? 1 : null },
    pendingIntents: Array.from({ length: w.pendingIntents }, (_, index) => ({ decisionId: `pending-${index}`, side: "sell", token: `0x${"9".repeat(40)}`, state: "pending", txHash: null, createdAt: 1 })),
    tradfiAi: w.tradfiAi, keptPositions: revoked && w.tradfiAi ? w.open : 0,
  } as TradeView;
}

type Run = {
  readonly host: HTMLElement;
  readonly signed: { readonly action: string; readonly params: unknown }[];
  readonly fetched: string[];
  readonly confirm: ReturnType<typeof vi.fn>;
  readonly w: World;
  readonly cleanup: () => Promise<void>;
};

async function mount(w: World): Promise<Run> {
  const signed: Run["signed"][number][] = [];
  const fetched: string[] = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hook.owner.passkey = w.noPasskey === true ? null : { walletAddress: WALLET };
  hook.owner.signEnvelope.mockReset();
  hook.owner.signEnvelope.mockImplementation(async (action: string, _agent: string, params: unknown) => { signed.push({ action, params }); return { signed: true, action }; });
  hook.revokeAgentSession.mockReset();
  hook.revokeAgentSession.mockImplementation(async () => { w.finalized = "invalid"; return { status: "PENDING", callsId: "0xrevoke" }; });
  window.localStorage.clear();
  const confirm = vi.fn(() => true);
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } });
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
    const url = String(request);
    fetched.push(url.replace(`/api/agents/${AGENT}`, ""));
    if (url.endsWith("/session")) {
      const kind = w.finalized;
      return json({ sessionRegistration: { kind, checkedAtMs: Date.now() }, finalizedSessionRevocation: { kind, checkedAtMs: Date.now(), finalizedBlockNumber: "100", finalizedBlockHash: `0x${"55".repeat(32)}` } });
    }
    if (url.endsWith("/revoke")) { w.status = "revoked"; w.orphaned = true; return json({}); }
    if (url.endsWith("/trade/drain")) { w.draining = true; w.open = 0; w.pendingIntents = 0; return json({ drainingAt: 1, openPositions: 0 }); }
    if (url.endsWith("/unpause")) { w.status = "armed"; return json({}); }
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const refresh = vi.fn(async () => agentView(w, w.refreshedStatus === undefined ? w.status : w.refreshedStatus()));
  const refreshTrade = vi.fn(async () => tradeView(w));
  hook.detail = { state: "ready", view: agentView(w), market: null, trade: tradeView(w), asOfMs: 2_000, message: "", readHeaders: {}, signIn: vi.fn(), refresh, refreshTrade };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<HiredAgentScreen agentId={AGENT} go={() => undefined} />); await Promise.resolve(); await Promise.resolve(); });
  return { host, signed, fetched, confirm, w, async cleanup() { await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals(); } };
}

const settle = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label);
const dialog = (host: HTMLElement) => host.querySelector('[role="dialog"]');

async function click(run: Run, label: string) {
  const target = button(run.host, label);
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => { target!.click(); await settle(); });
}

afterEach(() => { hook.detail = null; });

describe("the dialog is offered only to a TradFi AI agent that holds positions", () => {
  it("opens the two-option dialog BEFORE any confirm, signature or call", async () => {
    const run = await mount(world());
    try {
      await click(run, "Remove");
      expect(dialog(run.host)?.textContent).toContain("Sell all and remove");
      expect(dialog(run.host)?.textContent).toContain("Keep positions and remove");
      expect(run.confirm).not.toHaveBeenCalled();
      expect(run.signed).toEqual([]);
      const radios = [...run.host.querySelectorAll<HTMLInputElement>('input[name="trade-remove-choice"]')];
      expect(radios.map((radio) => [radio.value, radio.checked, radio.disabled])).toEqual([["sell", false, false], ["keep", false, false]]);
      expect([...dialog(run.host)!.querySelectorAll("button")].find((item) => item.textContent === "Remove")?.hasAttribute("disabled")).toBe(true);
      await click(run, "Cancel");
      expect(dialog(run.host)).toBeNull();
      expect(run.signed).toEqual([]);
    } finally { await run.cleanup(); }
  });

  it("shows no dialog for an AI agent with zero non-closed positions: today's Remove, even when the session expired", async () => {
    const live = await mount(world({ open: 0 }));
    try {
      await click(live, "Remove");
      expect(dialog(live.host)).toBeNull();
      expect(live.confirm).toHaveBeenCalledTimes(1);
      expect(String(live.confirm.mock.calls[0]?.[0])).toContain("Remove this agent?");
    } finally { await live.cleanup(); }
    const expired = await mount(world({ open: 0, expired: true }));
    try {
      await click(expired, "Remove");
      expect(dialog(expired.host)).toBeNull();
      expect(String(expired.confirm.mock.calls[0]?.[0])).toContain("The session has expired, so the agent cannot sell.");
      // Today's expired Remove (runTradeHardRevoke): the drain fence, then a plain {} revoke.
      expect(expired.signed.map((row) => row.action)).toEqual(["tradeDrain", "revoke"]);
      expect(expired.signed.every((row) => JSON.stringify(row.params) === "{}")).toBe(true);
    } finally { await expired.cleanup(); }
  });

  it("shows no dialog for any other agent kind: the legacy confirm and flow are unchanged", async () => {
    for (const tradfiAi of [false]) {
      const run = await mount(world({ tradfiAi }));
      try {
        await click(run, "Remove");
        expect(dialog(run.host)).toBeNull();
        expect(String(run.confirm.mock.calls[0]?.[0])).toContain("exit every open position to BNB");
        expect(run.signed.map((row) => row.action)).toEqual(["tradeDrain", "revoke"]);
        expect(run.signed.every((row) => JSON.stringify(row.params) === "{}")).toBe(true);
        expect(run.host.textContent).toContain("Agent removed. Every verified position was exited to BNB before revocation.");
      } finally { await run.cleanup(); }
    }
  });

  it("an expired AI agent with positions goes to the dialog (not the generic expired path): Sell all is disabled with its reason and Keep is preselected", async () => {
    const run = await mount(world({ expired: true }));
    try {
      await click(run, "Remove");
      expect(dialog(run.host)).not.toBeNull();
      expect(run.confirm).not.toHaveBeenCalled();
      expect(run.signed, "the generic expired branch would have signed a `{}` revoke").toEqual([]);
      const [sell, keep] = [...run.host.querySelectorAll<HTMLInputElement>('input[name="trade-remove-choice"]')];
      expect([sell!.disabled, sell!.checked, keep!.disabled, keep!.checked]).toEqual([true, false, false, true]);
      expect(dialog(run.host)?.textContent).toContain("Session expired. The agent can't sell. Renew to sell, or keep positions.");
      expect(button(run.host, "Keep positions and remove")?.hasAttribute("disabled")).toBe(false);
    } finally { await run.cleanup(); }
  });
});

describe("Keep positions and remove", () => {
  for (const status of ["armed", "paused"] as const) {
    it(`a ${status} agent signs exactly {keepPositions:true} once, never drains or unpauses, then runs the shared on-chain tail`, async () => {
      const run = await mount(world({ status }));
      try {
        await click(run, "Remove");
        await act(async () => { run.host.querySelector<HTMLInputElement>('input[value="keep"]')!.click(); });
        await click(run, "Keep positions and remove");
        expect(run.signed).toEqual([{ action: "revoke", params: { keepPositions: true } }]);
        expect(run.fetched.filter((path) => path === "/revoke")).toHaveLength(1);
        expect(run.fetched.some((path) => path.endsWith("/trade/drain") || path.endsWith("/unpause"))).toBe(false);
        expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
        expect(run.host.textContent).toContain("Agent removed. 2 positions were kept in the wallet. Withdraw the stocks and USDT from Account.");
      } finally { await run.cleanup(); }
    });
  }

  it("refuses, before anything is signed, while a renewal is pending or when the passkey is not connected", async () => {
    const pending = await mount(world({ renewalPending: true }));
    try {
      await click(pending, "Remove");
      await act(async () => { pending.host.querySelector<HTMLInputElement>('input[value="keep"]')!.click(); });
      await click(pending, "Keep positions and remove");
      expect(pending.signed).toEqual([]);
      expect(pending.host.textContent).toContain("A renewal is pending; finish or cancel it before removing the agent.");
    } finally { await pending.cleanup(); }
    const noPasskey = await mount(world({ noPasskey: true }));
    try {
      await click(noPasskey, "Remove");
      await act(async () => { noPasskey.host.querySelector<HTMLInputElement>('input[value="keep"]')!.click(); });
      await click(noPasskey, "Keep positions and remove");
      expect(noPasskey.signed).toEqual([]);
      expect(noPasskey.host.textContent).toContain("Removing this agent needs the passkey that owns its wallet.");
    } finally { await noPasskey.cleanup(); }
  });

  it("an expired session whose finalized proof already removes the key needs no passkey prompt and says what was kept", async () => {
    const run = await mount(world({ expired: true, finalized: "invalid", open: 1 }));
    try {
      await click(run, "Remove");
      await click(run, "Keep positions and remove");
      expect(run.signed).toEqual([{ action: "revoke", params: { keepPositions: true } }]);
      expect(hook.revokeAgentSession).not.toHaveBeenCalled();
      expect(run.host.textContent).toContain("Agent removed. 1 position was kept in the wallet. Withdraw the stocks and USDT from Account.");
    } finally { await run.cleanup(); }
  });
});

describe("Sell all and remove keeps today's calls, in USDT wording", () => {
  it("an armed agent: tradeDrain then revoke with {} and no unpause; the proven message says USDT", async () => {
    const run = await mount(world());
    try {
      await click(run, "Remove");
      await act(async () => { run.host.querySelector<HTMLInputElement>('input[value="sell"]')!.click(); });
      await click(run, "Sell all and remove");
      expect(run.signed).toEqual([{ action: "tradeDrain", params: {} }, { action: "revoke", params: {} }]);
      expect(run.host.textContent).toContain("Agent removed. Every verified position was exited to USDT before revocation.");
      expect(run.host.textContent).not.toContain("to BNB");
    } finally { await run.cleanup(); }
  });

  it("a paused agent: tradeDrain, unpause, revoke", async () => {
    const run = await mount(world({ status: "paused" }));
    try {
      await click(run, "Remove");
      await act(async () => { run.host.querySelector<HTMLInputElement>('input[value="sell"]')!.click(); });
      await click(run, "Sell all and remove");
      expect(run.signed.map((row) => row.action)).toEqual(["tradeDrain", "unpause", "revoke"]);
      expect(run.signed.every((row) => JSON.stringify(row.params) === "{}")).toBe(true);
    } finally { await run.cleanup(); }
  });

  it("names USDT (not BNB) when a revoked AI agent still has an intent in flight, and BNB for every other kind", async () => {
    for (const [tradfiAi, word] of [[true, "USDT"], [false, "BNB"]] as const) {
      const run = await mount(world({ status: "revoked", open: 0, pendingIntents: 1, tradfiAi }));
      try {
        await click(run, "Finish removal");
        expect(run.host.textContent).toContain(`Local revoke is already recorded, but conversion to ${word} is incomplete.`);
        expect(dialog(run.host)).toBeNull();
      } finally { await run.cleanup(); }
    }
  });
});

describe("model discriminator: only the TradFi AI agent treats `retired` as already removed on the Remove path", () => {
  it("another kind with a retired status and an intent in flight keeps the old path (drain, then revoke {}), unchanged", async () => {
    const run = await mount(world({ status: "retired", open: 0, pendingIntents: 1, tradfiAi: false }));
    try {
      await click(run, "Remove");
      expect(run.host.textContent).not.toContain("conversion to BNB is incomplete");
      expect(run.signed.map((row) => row.action)).toEqual(["tradeDrain", "revoke"]);
    } finally { await run.cleanup(); }
  });
});

describe("resume, completion and the refreshed lifecycle", () => {
  it("a revoked AI agent with kept rows: Finish removal runs ONLY the on-chain tail — no dialog, no drain, no second /revoke, no incomplete-conversion refusal", async () => {
    const run = await mount(world({ status: "revoked", orphaned: true, open: 2 }));
    try {
      await click(run, "Finish removal");
      expect(dialog(run.host)).toBeNull();
      expect(run.signed).toEqual([]);
      expect(run.fetched.some((path) => path === "/revoke" || path.endsWith("/trade/drain"))).toBe(false);
      expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
      expect(run.host.textContent).not.toContain("conversion to");
      expect(run.host.textContent).toContain("Agent removed. 2 positions were kept in the wallet");
    } finally { await run.cleanup(); }
  });

  it("a retired AI agent resumes at the tail too", async () => {
    const run = await mount(world({ status: "retired", orphaned: true, open: 1 }));
    try {
      await click(run, "Remove");
      expect(dialog(run.host)).toBeNull();
      expect(run.signed).toEqual([]);
      expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
    } finally { await run.cleanup(); }
  });

  it("kept-holdings-finalized-removal-shows-removed: after the finalized revoke proof the page says Removed, not Finish removal, though kept rows remain", async () => {
    const run = await mount(world({ status: "revoked", orphaned: true, open: 2, finalized: "invalid" }));
    try {
      await act(async () => { await settle(); });
      const removed = button(run.host, "Removed");
      expect(removed, run.host.textContent ?? "").toBeDefined();
      expect(removed?.hasAttribute("disabled")).toBe(true);
      expect(button(run.host, "Finish removal")).toBeUndefined();
      expect(run.host.textContent).toContain("2 positions kept in wallet, not counted in PnL");
    } finally { await run.cleanup(); }
  });

  it("remove-branches-on-refreshed-lifecycle: an agent rendered as armed but refreshed as revoked resumes at the tail — no dialog, no /revoke", async () => {
    const run = await mount(world({ status: "armed", refreshedStatus: () => "revoked" }));
    try {
      await click(run, "Remove");
      expect(dialog(run.host)).toBeNull();
      expect(run.signed).toEqual([]);
      expect(run.fetched.includes("/revoke")).toBe(false);
      expect(hook.revokeAgentSession).toHaveBeenCalledTimes(1);
    } finally { await run.cleanup(); }
  });

  for (const later of ["revoked", "retired"] as const) {
    it(`remove-branches-on-refreshed-lifecycle (Sell all path): a plane that ${later === "revoked" ? "revoked" : "retired"} the agent while the dialog was open resumes at the on-chain tail ONCE — no drain, no second /revoke, no incomplete-conversion refusal`, async () => {
      let refreshes = 0;
      const run = await mount(world({ status: "armed", refreshedStatus: () => { refreshes += 1; return refreshes === 1 ? "armed" : later; } }));
      try {
        await click(run, "Remove");
        expect(dialog(run.host)).not.toBeNull();
        await act(async () => { run.host.querySelector<HTMLInputElement>('input[value="sell"]')!.click(); });
        await click(run, "Sell all and remove");
        expect(run.signed, "no drain, unpause or revoke is signed against an agent the plane already removed").toEqual([]);
        expect(run.fetched.includes("/revoke")).toBe(false);
        expect(run.fetched.includes("/trade/drain")).toBe(false);
        expect(hook.revokeAgentSession, "the shared on-chain tail runs exactly once").toHaveBeenCalledTimes(1);
        expect(run.host.textContent).not.toContain("conversion to USDT is incomplete");
      } finally { await run.cleanup(); }
    });
  }

  it("remove-branches-on-refreshed-lifecycle (converse): a refreshed armed agent still gets the dialog", async () => {
    const run = await mount(world({ status: "armed", refreshedStatus: () => "armed" }));
    try {
      await click(run, "Remove");
      expect(dialog(run.host)).not.toBeNull();
    } finally { await run.cleanup(); }
  });
});

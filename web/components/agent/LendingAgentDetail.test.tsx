// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signEnvelope: vi.fn(),
  recover: vi.fn(),
  publicClient: undefined as unknown,
  passkey: null as unknown,
}));

vi.mock("wagmi", () => ({
  usePublicClient: () => mocks.publicClient,
  useAccount: () => ({ address: undefined }),
}));
vi.mock("@/lib/exec/use-owner-actions", () => ({
  useOwnerActions: () => ({ passkey: mocks.passkey, walletAddress: "0x9999999999999999999999999999999999999999", signEnvelope: mocks.signEnvelope }),
}));
vi.mock("@/lib/altana/client", () => ({ recoverLendingReserveWithPasskey: mocks.recover }));

import { LendingAgentDetail } from "./LendingAgentDetail";
import type { AgentDetailView } from "@/lib/exec/agent-detail";
import type { UseAgentDetailResult } from "@/lib/exec/use-agent-detail";
import { INVALID, type LendingAgentView } from "@/lib/exec/lending-types";

const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_BNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}` as const;
// A LIVE session: the recovery door must stay shut while one exists.
const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 86_400;

const CONFIG = {
  chainId: 56, vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB,
  routerV3: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", wbnb: WBNB,
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  swapFeeTier: 100, maxSagaSlippageBps: 50, dustUsdtWei: "10000000000000000", maxMarkets: 24,
};

const guard = {
  status: "armed" as const, hold: null, guardedAccount: ACCOUNT, debtMarkets: [V_USDT],
  reserveBps: 2_000, budgetWei: "50000000000000000", reserveCapWei: "44000000000000000000",
  armTxHash: HASH, armBlock: "120362700", armBlockSource: "receipt" as const, closeReason: null,
  actionSeq: 1, lastActionAtMs: null, updatedAtMs: 1,
};

const market = {
  vToken: V_USDT, symbol: "vUSDT", underlying: USDT, underlyingDecimals: 18,
  supplyUnderlyingWei: "0", borrowWei: "100000000000000000000", isCollateral: false,
  collateralFactor: "800000000000000000", liquidationThreshold: "850000000000000000",
  priceMantissa: "1000000000000000000",
};

function lendingView(patch: Partial<LendingAgentView> = {}): LendingAgentView {
  return {
    guard,
    snapshot: {
      presentAt: 1_700_000_000_000, ageMs: 1_000, staleAfterMs: 60_000, stale: false,
      reason: null, workerIntervalMs: 30_000,
      payload: {
        version: 1,
        account: {
          blockNumber: "120362697", markets: [market],
          accountLiquidity: ["0", "0", "0"], borrowingPower: ["0", "0", "0"], vaiDebt: "0",
        },
        reserve: {
          idleUsdtWei: "1000000000000000000", suppliedUsdtWei: "30000000000000000000",
          vUsdtBalance: "1", poolCashWei: "0", bnbTierWei: "0", nativeBalanceWei: "0",
          walletFloorWei: "0", usdtAllowanceToVUsdt: "0", usdtAllowanceToRouter: "0",
        },
        conditions: [
          { condition: "reserve-low", known: true, detail: "capacity 31 below maxPerAction 240" },
          { condition: "borrow-moved", known: true, detail: "borrow fell before inclusion" },
          { condition: "a-brand-new-condition", known: false, detail: "raw text" },
        ],
        usage: { rescues: 2, lastRescueAtMs: 1_700_000_000_000 },
        observation: { healthFactor: "1180000000000000000", breach: true, consecutive: 1, evaluatedAtMs: 1 },
        session: { expiresAt: FUTURE_EXPIRY },
      },
    },
    rescues: [{
      rescueId: "r1", market: V_USDT, amountWei: "10000000000000000000",
      hfBefore: "1100000000000000000", hfAfter: "1510000000000000000", achievedHf: "1500000000000000000",
      txHash: HASH, effect: "no-effect", partial: true, conditions: ["insufficient-reserve"],
      createdAtMs: 1_700_000_000_000,
    }],
    settings: {
      triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
      maxPerAction: [{ token: USDT, maxWei: "240000000000000000000" }],
      minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: null,
    },
    settingsDigest: HASH,
    session: { expiresAt: FUTURE_EXPIRY, expiring: false },
    recovery: { note: "Your reserve is recoverable with your passkey at any time; the agent's key cannot block it." },
    ...patch,
  };
}

const agentView = {
  id: "lending-agent-01", status: "armed", provisioning: false,
  walletAddress: "0x9999999999999999999999999999999999999999",
  hireSizingName: "lending-v1", sessionPublicKey: null,
} as unknown as AgentDetailView;

function detailStub(
  lending: LendingAgentView | typeof INVALID | null,
  state: UseAgentDetailResult["state"] = "ready",
): UseAgentDetailResult {
  return {
    state, view: agentView, market: null, chartCandles: null, chartBanner: null,
    chartInterval: "1m", chartUnit: "usd",
    setChartInterval: () => undefined, setChartUnit: () => undefined,
    trade: null, lending, asOfMs: 1_700_000_001_000, message: "", marketReason: null,
    readHeaders: {}, signIn: async () => undefined, refresh: async () => agentView,
    refreshTrade: async () => null, refreshLending: async () => lending,
  };
}

let host: HTMLDivElement;
let root: Root | null;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let configOk: boolean;
let wbnbFresh: boolean;
let wbnbPriceUsd: number;
let retirePayload: Record<string, unknown>;
let iconPayload: Record<string, string | null>;
let iconRequests: string[];
let sessionPayload: unknown;
let sessionOk: boolean;

async function mount(
  lending: LendingAgentView | typeof INVALID | null,
  overrides: Record<string, unknown> = {},
  state: UseAgentDetailResult["state"] = "ready",
) {
  const detail = detailStub(lending, state);
  await act(async () => {
    root!.render(<LendingAgentDetail
      agentId="lending-agent-01"
      go={() => undefined}
      detail={detail}
      view={agentView}
      busy={false}
      message=""
      actionsDisabled={false}
      removeDisabled={false}
      removeLabel="Remove"
      signedOut={false}
      onTogglePause={() => undefined}
      onRemove={() => undefined}
      {...overrides}
    />);
  });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  configOk = true;
  wbnbFresh = true;
  wbnbPriceUsd = 900;
  mocks.passkey = null;
  mocks.publicClient = undefined;
  vi.stubGlobal("confirm", () => true);
  retirePayload = {
    status: "completed", cleared: true, poolShort: false, txHash: null,
    redeemAmountWei: "1", swapInWei: "1", minOutWei: "1", remainderUsdtWei: "0", residueUsdtWei: null,
  };
  iconPayload = {};
  iconRequests = [];
  sessionOk = true;
  sessionPayload = {
    data: {
      status: "armed",
      agent: {
        session: {
          publicKey: `0x${"cd".repeat(32)}`,
          expiresAt: FUTURE_EXPIRY,
          allowedCalls: [
            { to: V_USDT, selector: "mint(uint256)" },
            { to: V_USDT, selector: "redeemUnderlying(uint256)" },
            { to: V_USDT, selector: "repayBorrowBehalf(address,uint256)" },
            { to: USDT, selector: "approve(address,uint256)" },
            { to: "0x1b81D678ffb9C0263b24A97847620C99d213eB14" },
          ],
          spendCaps: [
            // `period` is the plane's WORD, not seconds: `SpendPeriod` is
            // "minute" | "hour" | "day" | … (`src/core/types.ts:29`) and the
            // agent read forwards it verbatim (`src/http/wire.ts:1037`). This
            // fixture said `86_400` and the parser demanded a number, so the
            // tab passed here and answered "no live session grant" against
            // every real agent.
            { period: "day", limit: "50000000000000000" },
            { token: USDT, period: "day", limit: "44000000000000000000" },
          ],
        },
      },
    },
  };
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/token-icons")) {
      iconRequests.push(url);
      return new Response(JSON.stringify({ data: iconPayload }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/session")) {
      return sessionOk
        ? new Response(JSON.stringify(sessionPayload), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "execution_unavailable" } }), { status: 502, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("/api/lending/config")) {
      return configOk
        ? new Response(JSON.stringify({ data: CONFIG }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "lending_disabled" } }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("/api/market-data/tokens/")) {
      return new Response(JSON.stringify({
        data: { address: WBNB.toLowerCase(), priceUsd: wbnbPriceUsd },
        meta: { staleness: wbnbFresh ? "fresh" : "stale", source: "test", asOf: Date.now() },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/lending/retire") && init?.method === "POST") {
      return new Response(JSON.stringify({ data: { retire: retirePayload } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/lending/settings") && init?.method === "POST") {
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

const testid = (name: string) => host.querySelector(`[data-testid="${name}"]`)?.textContent ?? "";

/**
 * Switch tabs. The repay table and the timeline live under "Run log" and the
 * grant under "Permissions" since the mock-up port; the assertions below are
 * unchanged, they just have to open the tab first.
 */
async function openTab(name: "Overview" | "Run log" | "Permissions") {
  const tab = [...host.querySelectorAll("button")].find((entry) => entry.getAttribute("data-seg") === name);
  await act(async () => { tab!.click(); });
  await act(async () => { await Promise.resolve(); });
}

describe("the hero and the tiles", () => {
  it("keeps health in the tile and panel, with a target marker from the signed settings", async () => {
    await mount(lendingView());
    expect(host.querySelector("[data-testid='lending-health']")).toBeNull();
    expect(testid("lending-health-panel")).toContain("1.18");
    expect(host.textContent).toContain("liquidation basis");
    expect(host.textContent).toContain("no protocol mismatch recorded by the agent");
    expect(testid("lending-target-marker")).toBe("TARGET 1.50");
    expect(testid("lending-trigger-marker")).toBe("TRIGGER 1.20");
    const base = lendingView();
    await mount(lendingView({ settings: { ...base.settings!, triggerHf: "1600000000000000000", targetHf: "1900000000000000000" } }));
    expect(testid("lending-target-marker")).toBe("TARGET 1.90");
    expect(testid("lending-trigger-marker")).toBe("TRIGGER 1.60");
    const marker = host.querySelector<HTMLElement>("[data-testid='lending-target-marker']");
    expect(Number.parseFloat(marker!.style.left)).toBeCloseTo(64.2857, 3);
    const triggerMarker = host.querySelector<HTMLElement>("[data-testid='lending-trigger-marker']");
    expect(Number.parseFloat(triggerMarker!.style.left)).toBeCloseTo(42.8571, 3);
  });

  it("prices the reserve from the protocol oracle and names its composition", async () => {
    await mount(lendingView());
    expect(host.textContent).toContain("$31.00");
    expect(host.textContent).toContain("30 USDT on Venus · 1 idle USDT · 0 BNB tier");
    // 31 USDT of reserve against 100 USDT of pinned debt.
    expect(host.textContent).toContain("31.0%");
  });

  it("keeps the session countdown in Overview and the recovery explanation in Permissions", async () => {
    await mount(lendingView());
    expect(testid("lending-reserve-panel")).toContain("SESSION");
    expect(testid("lending-reserve-panel")).not.toContain("Your reserve is recoverable");
    await openTab("Permissions");
    expect(host.textContent).toContain("Your reserve is recoverable with your passkey at any time; the agent's key cannot block it.");
  });
});

describe("dash with reason", () => {
  // R2.18: a stale snapshot with no live fallback dashes EVERY tile, each with
  // the staleness reason — never a zero, never a stale number.
  it("dashes every tile with the staleness reason when the worker is silent", async () => {
    await mount(lendingView({
      snapshot: {
        presentAt: 1, ageMs: 9_000_000, staleAfterMs: 60_000, stale: true,
        reason: "The worker has not reported since 2026-09-07T00:00:00.000Z.",
        workerIntervalMs: 30_000, payload: null,
      },
    }));
    expect(testid("lending-health-panel")).toContain("The worker has not reported since");
    expect(testid("lending-stale")).toContain("has not reported recently");
    expect(host.textContent).not.toContain("$31.00");
    expect(host.textContent).not.toContain("31.0%");
  });

  it("renders the live account fallback for the ACCOUNT half, labelled, with the guard half still dashed", async () => {
    await mount(lendingView({
      snapshot: {
        presentAt: 1, ageMs: 9_000_000, staleAfterMs: 60_000, stale: true,
        reason: "no fresh snapshot", workerIntervalMs: 30_000, payload: null,
      },
      liveAccount: {
        account: ACCOUNT, blockNumber: "2",
        bases: {
          borrowingPower: { hf: "1300000000000000000", matched: true },
          liquidation: { hf: "1050000000000000000", matched: true },
        },
        markets: [market], debts: [], guardable: true,
      },
    }));
    expect(testid("lending-health-panel")).toContain("1.05");
    expect(testid("lending-stale")).toContain("read now, not by the agent");
    // The guard half has NO live source and stays dashed.
    expect(host.textContent).not.toContain("$31.00");
  });

  it("keeps the page alive — and honest — when the plane's view cannot be mapped", async () => {
    await mount(INVALID);
    expect(host.textContent).toContain("could not map");
    expect(testid("lending-health-panel")).toContain("—");
    expect(host.textContent).not.toContain("$");
  });

  it("says the venue is unreadable rather than pricing the reserve without it", async () => {
    configOk = false;
    await mount(lendingView());
    expect(host.textContent).toContain("lending venue could not be read");
    expect(host.textContent).not.toContain("$31.00");
  });
});

describe("conditions", () => {
  it("renders every condition the plane emitted, with its owner-facing copy", async () => {
    await mount(lendingView());
    const banner = testid("lending-conditions");
    expect(banner).toContain("reserve-low");
    expect(banner).toContain("refusing a rescue is the trap this agent exists to avoid");
    expect(banner).toContain("borrow-moved");
    expect(banner).toContain("debt fell between the sizing read and inclusion");
  });

  it("shows an unrecognized condition verbatim rather than dropping it", async () => {
    await mount(lendingView());
    const banner = testid("lending-conditions");
    expect(banner).toContain("a-brand-new-condition");
    expect(banner).toContain("not recognized by this page");
    expect(banner).toContain("raw text");
  });
});

describe("the rescue log", () => {
  it("shows amount, market, HF before → after, the flags and a tx link", async () => {
    await mount(lendingView());
    await openTab("Run log");
    const log = testid("lending-rescue-log");
    expect(log).toContain("10 USDT");
    expect(log).toContain("HF 1.10 → 1.51");
    expect(log).toContain("no-effect");
    expect(log).toContain("partial");
    expect(log).toContain("insufficient-reserve");
    expect(host.querySelector(`a[href="https://bscscan.com/tx/${HASH}"]`)).not.toBeNull();
    // An ineffective or partial rescue is exactly where the raw row is needed.
    expect(host.querySelector("[data-testid=\"lending-rescue-details-r1\"]")).not.toBeNull();
  });

  it("says there is nothing rather than showing an empty table", async () => {
    await mount(lendingView({ rescues: [] }));
    await openTab("Run log");
    expect(testid("lending-rescue-log")).toContain("no rescue has been recorded");
  });
});

describe("the action gates", () => {
  // The Edit ENTRY POINT is hidden in the product until the redesigned panel
  // lands (operator, 2026-09-07). Hiding it is presentation: `lendingSettings`
  // is still a route the plane accepts, and the panel below still enforces its
  // own rules — which is why the panel tests open it through `showEdit` rather
  // than being deleted. This pair pins BOTH halves, so putting the button back
  // is a deliberate act and not an accident.
  it("hides Edit by default — the product ships without the entry point", async () => {
    await mount(lendingView());
    const edit = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Edit");
    expect(edit).toBeUndefined();
  });

  it("offers Edit when it is shown — there is no owner text a replacement could erase", async () => {
    await mount(lendingView(), { showEdit: true });
    const edit = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Edit");
    expect(edit?.disabled).toBe(false);
  });

  it("disables Edit when the settings are not readable, rather than saving a guess", async () => {
    await mount(lendingView({ settings: null }), { showEdit: true });
    const edit = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Edit");
    expect(edit?.disabled).toBe(true);
  });

  it("refuses Retire unless the guard is armed or held, and names the status", async () => {
    await mount(lendingView({ guard: { ...guard, status: "retired" } }));
    const retire = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Retire reserve");
    expect(retire?.disabled).toBe(true);
    expect(retire?.getAttribute("title")).toContain("it is retired");
  });

  // §6.1/R3.12: Remove is not reachable while the guard still holds the reserve.
  it("refuses Remove while the reserve is still on Venus, and allows it once retired", async () => {
    await mount(lendingView());
    const removeArmed = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Remove");
    expect(removeArmed?.disabled).toBe(true);
    expect(removeArmed?.getAttribute("title")).toContain("Retire the reserve first");

    await mount(lendingView({ guard: { ...guard, status: "retired", closeReason: "retired" } }));
    const removeRetired = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Remove");
    expect(removeRetired?.disabled).toBe(false);
  });

  // R3.12: a pool-short retire's remainder stays supplied on Venus, and Remove
  // is reachable ONLY behind the owner's declared choice to leave it there.
  it("renders the pool-short choice from the worker's own condition, and gates Remove behind it", async () => {
    const withShort = lendingView({ guard: { ...guard, status: "retiring" } });
    const payload = withShort.snapshot.payload!;
    await mount({
      ...withShort,
      snapshot: {
        ...withShort.snapshot,
        payload: {
          ...payload,
          conditions: [{ condition: "pool-cash-short", known: true, detail: "redeemed 10 of 30 supplied" }],
        },
      },
    });
    const panel = testid("lending-pool-short");
    expect(panel).toContain("Venus could not redeem the whole supply");
    expect(panel).toContain("leave the remaining supply on Venus (recoverable with my passkey)");
    const remove = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Remove");
    expect(remove?.disabled).toBe(true);
    expect(remove?.getAttribute("title")).toContain("leave the remaining supply on Venus");
    // And the condition's own copy is on the page beside it.
    expect(testid("lending-conditions")).toContain("recoverable with your passkey");
  });

  it("offers the passkey recovery only when the session is gone or the plane is unreachable", async () => {
    await mount(lendingView());
    expect([...host.querySelectorAll("button")].some((entry) => entry.textContent === "Recover with passkey")).toBe(false);

    const detail = detailStub(lendingView({ session: { expiresAt: 1, expiring: true } }));
    await act(async () => {
      root!.render(<LendingAgentDetail
        agentId="lending-agent-01" go={() => undefined} detail={detail} view={agentView}
        busy={false} message="" actionsDisabled={false} removeDisabled={false} removeLabel="Remove"
        signedOut={false} onTogglePause={() => undefined} onRemove={() => undefined} />);
    });
    expect([...host.querySelectorAll("button")].some((entry) => entry.textContent === "Recover with passkey")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* W2 — the recovery door survives the outage it exists for (AUDIT G-M2)      */
/* -------------------------------------------------------------------------- */

describe("passkey recovery during a plane outage", () => {
  // §6.2 is "no server, no session, no plane". On a COLD load during an outage
  // there is no guard row at all — it comes from the plane — so gating the door
  // on `guard !== null` closed it in exactly the case it was written for.
  it("offers Recover with passkey with NO guard row when the plane is unreachable", async () => {
    await mount(null, {}, "execution-unavailable");
    expect([...host.querySelectorAll("button")].some((entry) => entry.textContent === "Recover with passkey")).toBe(true);
  });

  it("still shows nothing when the plane is merely quiet — a null guard is not a door", async () => {
    await mount(null);
    expect([...host.querySelectorAll("button")].some((entry) => entry.textContent === "Recover with passkey")).toBe(false);
  });

  it("builds the batch from the REMEMBERED venue and the passkey wallet when the config read fails", async () => {
    // One successful visit remembers the venue addresses…
    await mount(lendingView());
    await act(async () => { root?.unmount(); });
    root = createRoot(host);

    // …then the plane goes away: no guard row, no venue read, no agent view.
    configOk = false;
    mocks.passkey = { x: "0x1", y: "0x2" };
    const reads: string[] = [];
    mocks.publicClient = {
      getBlock: async () => ({ number: 120_362_697n }),
      getCode: async () => "0xef0100",
      getBalance: async () => 10_000_000_000_000_000n,
      readContract: async (args: { functionName: string }) => {
        reads.push(args.functionName);
        return args.functionName === "exchangeRateStored" ? 2n * 10n ** 26n : 1_000_000_000_000_000_000n;
      },
    };
    await mount(null, { view: null }, "execution-unavailable");
    const recover = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Recover with passkey");
    expect(recover, host.textContent ?? "").toBeDefined();
    await act(async () => { recover!.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // It got as far as reading wallet B on chain, which it could only do with
    // the venue addresses — so the cache, not a guess, supplied them.
    expect(reads).toContain("exchangeRateStored");
    expect(host.textContent).not.toContain("no venue was remembered");
  });

  it("refuses rather than guessing a venue when nothing was ever remembered", async () => {
    configOk = false;
    mocks.passkey = { x: "0x1", y: "0x2" };
    await mount(null, { view: null }, "execution-unavailable");
    const recover = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Recover with passkey");
    await act(async () => { recover!.click(); await Promise.resolve(); });
    expect(host.textContent).toContain("no venue was remembered");
  });
});

/* -------------------------------------------------------------------------- */
/* W3 — the Edit panel's BNB leg (AUDIT G-M3)                                 */
/* -------------------------------------------------------------------------- */

describe("Edit prices the BNB leg, or says it cannot", () => {
  const bnbOnly = () => lendingView({
    guard: { ...guard, debtMarkets: [V_BNB] },
    settings: {
      triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
      // vBNB-ONLY: no USDT cap at all. This is the guard whose "$" field used to
      // render EMPTY and change nothing.
      maxPerAction: [{ token: null, maxWei: "200000000000000000" }],   // 0.2 BNB
      minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: null,
    },
  });

  async function openEdit(lending: LendingAgentView) {
    // `showEdit` is FALSE in the product (operator decision 2026-09-07): the
    // button is out of the action bar until the redesigned panel lands. The
    // panel itself is untouched and still owns audited rules (W3 / G-M3), so
    // the tests open it through the same prop rather than losing the coverage.
    await mount(lending, { showEdit: true });
    const edit = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Edit");
    await act(async () => { edit!.click(); });
    await act(async () => { await Promise.resolve(); });
  }

  it("fills the $ field from the signed BNB ceiling at the FRESH price, and says the field prices it", async () => {
    await openEdit(bnbOnly());
    // 0.2 BNB at $900 = $180.00 — a figure, not an empty box.
    const filled = [...host.querySelectorAll("input")].some((entry) => entry.value === "180.00");
    expect(filled, host.innerHTML).toBe(true);
    expect(testid("lending-bnb-ceiling")).toContain("converted to a BNB ceiling at the current BNB price");
  });

  it("renders the ceiling READ-ONLY with its reason when the price is not fresh", async () => {
    wbnbFresh = false;
    await openEdit(bnbOnly());
    const line = testid("lending-bnb-ceiling");
    expect(line).toContain("BNB repay ceiling 0.2 BNB");
    expect(line).toContain("read-only here");
    expect(line).toContain("The BNB price is not fresh");
    // And the "$" box is not left empty pretending to control it.
    expect(line).toContain("only the USDT ceiling above changes");
    // A BNB-ONLY guard has nothing left to re-price, so Save says so rather
    // than refusing on an empty dollar field the panel just made read-only.
    const save = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Save settings");
    expect(save?.disabled).toBe(true);
    expect(save?.getAttribute("title")).toContain("repays BNB only");
  });

  it("keeps Save available for a DUAL guard with a stale price — the USDT ceiling still moves", async () => {
    wbnbFresh = false;
    await openEdit(lendingView({
      guard: { ...guard, debtMarkets: [V_USDT, V_BNB] },
      settings: {
        triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
        maxPerAction: [
          { token: USDT, maxWei: "240000000000000000000" },
          { token: null, maxWei: "200000000000000000" },
        ],
        minSecondsBetweenActions: 300, rescueReserveCount: 6, notifyOnlyBelowHf: null,
      },
    }));
    expect(testid("lending-bnb-ceiling")).toContain("read-only here");
    const save = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Save settings");
    expect(save?.disabled).toBe(false);
  });

  it("says nothing about a BNB ceiling for a USDT-only guard", async () => {
    await openEdit(lendingView());
    expect(host.querySelector("[data-testid=\"lending-bnb-ceiling\"]")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* W8 — an HTTP 200 retire is not "retired"                                   */
/* -------------------------------------------------------------------------- */

describe("the retire outcome comes from data.retire.status", () => {
  async function clickRetire(lending = lendingView()) {
    await mount(lending);
    const retire = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Retire reserve");
    await act(async () => { retire!.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return host.textContent ?? "";
  }

  // The mutation this kills: a component that treats HTTP 200 as "retired".
  // Same status code, five different outcomes, five different sentences.
  it("says HELD, not retired, on a 200 whose status is held", async () => {
    retirePayload = { ...retirePayload, status: "held", cleared: false, reason: "ambiguous relay answer" };
    const text = await clickRetire();
    expect(text).toContain("Retire held");
    expect(text).toContain("ambiguous relay answer");
    expect(text).not.toContain("Retired — the reserve is back");
  });

  it("says ROLLED BACK, not retired, on a 200 whose status is rolled-back", async () => {
    retirePayload = { ...retirePayload, status: "rolled-back", cleared: false, reason: "preflight refused" };
    const text = await clickRetire();
    expect(text).toContain("Retire refused");
    expect(text).toContain("Nothing moved");
    expect(text).not.toContain("Retired — the reserve is back");
  });

  it("says the reserve is NOT fully back on a completed-but-uncleared 200", async () => {
    retirePayload = { ...retirePayload, status: "completed", cleared: false, residueUsdtWei: "12345" };
    const text = await clickRetire();
    expect(text).toContain("not fully back");
    expect(text).toContain("12345");
    expect(text).not.toContain("Retired — the reserve is back");
  });

  it("says retired ONLY when the outcome itself says cleared", async () => {
    const text = await clickRetire();
    expect(text).toContain("Retired — the reserve is back in the agent wallet as BNB.");
  });

  it("claims nothing at all when the outcome block cannot be mapped", async () => {
    retirePayload = { status: "not-a-status" };
    const text = await clickRetire();
    expect(text).toContain("Outcome unavailable");
    expect(text).not.toContain("Retired —");
  });
});

/* -------------------------------------------------------------------------- */
/* MOCK-UP PORT fix 1 — `effect` and `partial` are DIFFERENT things            */
/* -------------------------------------------------------------------------- */

describe("effect and partial are two facts, not one tone", () => {
  const rescue = (patch: Partial<LendingAgentView["rescues"][number]>) => ({
    rescueId: "r1", market: V_USDT, amountWei: "10000000000000000000",
    hfBefore: "1100000000000000000", hfAfter: "1510000000000000000", achievedHf: null,
    txHash: HASH, effect: "changed" as const, partial: false,
    conditions: [] as readonly string[], createdAtMs: 1_700_000_000_000,
    ...patch,
  });

  async function row(patch: Partial<LendingAgentView["rescues"][number]>) {
    await mount(lendingView({ rescues: [rescue(patch)] }));
    await openTab("Run log");
    return {
      dot: host.querySelector("[data-testid=\"lending-rescue-effect-r1\"] i") as HTMLElement | null,
      effectText: testid("lending-rescue-effect-r1"),
      partial: host.querySelector("[data-testid=\"lending-rescue-partial-r1\"]"),
      text: testid("lending-rescue-r1"),
    };
  }

  it("colours a CHANGED repay from the effect and shows no partial chip", async () => {
    const view = await row({ effect: "changed", partial: false });
    expect(view.dot?.style.background).toContain("--profit");
    expect(view.partial).toBeNull();
    expect(view.text).toContain("The debt moved");
  });

  // The mutation this kills: `tone(e)` collapsing partial over effect, which
  // painted a repay that DID move the debt as though it had not.
  it("keeps a CHANGED + PARTIAL repay coloured as changed, with partial as its own chip", async () => {
    const view = await row({ effect: "changed", partial: true });
    expect(view.dot?.style.background).toContain("--profit");
    expect(view.partial).not.toBeNull();
    expect(view.text).toContain("The debt moved");
    expect(view.text).toContain("could not fund the whole sized repay");
  });

  it("says a NO-EFFECT repay confirmed and moved nothing", async () => {
    const view = await row({ effect: "no-effect", partial: true });
    expect(view.dot?.style.background).toContain("--warn");
    expect(view.partial).not.toBeNull();
    expect(view.text).toContain("The receipt confirmed and the debt did not move.");
  });

  it("says an UNVERIFIED repay's post-read failed rather than calling it ineffective", async () => {
    const view = await row({ effect: "unverified", partial: false });
    expect(view.dot?.style.background).toContain("--text-subtle");
    expect(view.partial).toBeNull();
    expect(view.text).toContain("read taken after the receipt failed");
    expect(view.text).not.toContain("did not move");
  });
});

/* -------------------------------------------------------------------------- */
/* fix 2 — both bases carry their match flag                                  */
/* -------------------------------------------------------------------------- */

describe("the two bases and their match flags", () => {
  it("keeps the normal match credit on hover and explains the missing borrowing-power basis", async () => {
    await mount(lendingView());
    const panel = testid("lending-health-panel");
    expect(panel).toContain("Liquidation basis");
    expect(panel).toContain("Borrowing-power basis");
    expect(panel).not.toContain("no protocol mismatch recorded by the agent");
    expect(host.querySelector("[data-testid='lending-health-panel'] [title='no protocol mismatch recorded by the agent']")).not.toBeNull();
    expect(panel).toContain("carries only the liquidation basis");
  });

  it("renders BOTH match flags from the live read, and marks an unmatched basis", async () => {
    await mount(lendingView({
      snapshot: {
        presentAt: 1, ageMs: 9_000_000, staleAfterMs: 60_000, stale: true,
        reason: "no fresh snapshot", workerIntervalMs: 30_000, payload: null,
      },
      liveAccount: {
        account: ACCOUNT, blockNumber: "2",
        bases: {
          borrowingPower: { hf: "1300000000000000000", matched: false },
          liquidation: { hf: "1620000000000000000", matched: true },
        },
        markets: [market], debts: [], guardable: true,
      },
    }));
    const panel = testid("lending-health-panel");
    expect(panel).toContain("1.62");
    expect(panel).toContain("1.30");
    expect(panel).not.toContain("matches Venus's own account-liquidity call");
    expect(host.querySelector('[data-testid="lending-health-panel"] [title="matches Venus\'s own account-liquidity call"]')).not.toBeNull();
    expect(panel).toContain("does NOT match Venus's own account-liquidity call");
    // +62.0% above the liquidation line, exact from the mantissa.
    expect(panel).toContain("+62.0%");
  });

  it("marks the liquidation basis unmatched when the agent recorded a protocol mismatch", async () => {
    const base = lendingView();
    const payload = base.snapshot.payload!;
    await mount({
      ...base,
      snapshot: {
        ...base.snapshot,
        payload: { ...payload, conditions: [{ condition: "protocol-mismatch", known: true, detail: "" }] },
      },
    });
    expect(testid("lending-health-panel")).toContain("does NOT match Venus's own account-liquidity call");
  });
});

/* -------------------------------------------------------------------------- */
/* fix 3 — the stale snapshot, and the live fallback's label                  */
/* -------------------------------------------------------------------------- */

describe("the stale snapshot in the panels", () => {
  it("dashes the health panel's cells with the staleness reason when nothing can stand in", async () => {
    await mount(lendingView({
      snapshot: {
        presentAt: 1, ageMs: 9_000_000, staleAfterMs: 60_000, stale: true,
        reason: "The worker has not reported since 2026-09-07T00:00:00.000Z.",
        workerIntervalMs: 30_000, payload: null,
      },
    }));
    const panel = testid("lending-health-panel");
    expect(panel).toContain("The worker has not reported since");
    expect(panel).toContain("—");
    expect(testid("lending-reserve-panel")).toContain("The worker has not reported since");
  });

  it("labels the live fallback where it is rendered rather than passing it off as the agent's", async () => {
    await mount(lendingView({
      snapshot: {
        presentAt: 1, ageMs: 9_000_000, staleAfterMs: 60_000, stale: true,
        reason: "no fresh snapshot", workerIntervalMs: 30_000, payload: null,
      },
      liveAccount: {
        account: ACCOUNT, blockNumber: "990",
        bases: {
          borrowingPower: { hf: "1300000000000000000", matched: true },
          liquidation: { hf: "1050000000000000000", matched: true },
        },
        markets: [market], debts: [], guardable: true,
      },
    }));
    expect(testid("lending-health-panel")).toContain("block 990");
    expect(testid("lending-health-panel")).not.toContain("read now, not by the agent");
    expect(testid("lending-stale")).toContain("read now, not by the agent");
    expect(testid("lending-position")).toContain("READ NOW, NOT BY THE AGENT");
  });
});

/* -------------------------------------------------------------------------- */
/* fix 4 + fix 5 — no chart, and a timeline of sourced rows only              */
/* -------------------------------------------------------------------------- */

describe("the run log timeline", () => {
  it("contains only events with durable rows, and none of the mock-up's invented ones", async () => {
    await mount(lendingView());
    await openTab("Run log");
    const log = testid("lending-timeline");
    expect(log).toContain("Hired");
    expect(log).toContain("Reserve armed on Venus");
    expect(log).toContain("block 120362700");
    expect(log).toContain("Repaid 10 USDT");
    expect(log).toContain("Watching your Venus position");
    // The mock-up's three unsourced rows: no cause, no price history, no
    // per-cycle check history, no collateral-at-hire figure is stored.
    expect(log).not.toContain("Triggered by");
    expect(log).not.toContain("Checked your Venus position");
    expect(log).not.toContain("placed under watch");
  });

  it("dashes the hire and the arm times rather than inventing them", async () => {
    await mount(lendingView());
    await openTab("Run log");
    const log = testid("lending-timeline");
    expect(log).toContain("the hire's time is not carried by the guard view");
    expect(log).toContain("the guard row records the arm's block, not its time");
    // The arm block is a RECEIPT block in this fixture, and the row says so.
    expect(log).toContain("the block the arm's transaction landed in");
  });

  it("renders no health-factor chart — the observation table keeps one row", async () => {
    await mount(lendingView());
    // `ChartFrame` renders `.fl-chart` and draws its series as an SVG path.
    // Neither exists anywhere on this page — there is no series to draw.
    expect(host.querySelector(".fl-chart")).toBeNull();
    expect(host.querySelector("[data-testid=\"lending-health-panel\"] svg")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* fix 6 — the Permissions tab is the REAL grant                              */
/* -------------------------------------------------------------------------- */

describe("the Permissions tab", () => {
  it("renders the session's own calls and caps, and the honest custody sentence", async () => {
    await mount(lendingView());
    await openTab("Permissions");
    await act(async () => { await Promise.resolve(); });
    const panel = testid("lending-permissions");
    // What it CAN do, from the grant's own rows.
    expect(panel).toContain("repay USDT debt on behalf of the guarded account".replace(/^r/u, "R"));
    expect(panel).toContain("mint(uint256)");
    expect(panel).toContain("Call any function on 0x1b81D678ffb9C0263b24A97847620C99d213eB14");
    // What it CANNOT.
    expect(panel).toContain("Borrow against your account");
    expect(panel).toContain("Enter or exit a Venus market for you");
    expect(panel).toContain("Altana KeyStore");
    // THE BLOCKER: the honest sentence is present and the false one is absent.
    expect(testid("lending-leaked-key")).toContain("A leaked session key CAN move the reserve out of the agent wallet");
    expect(panel).not.toContain("cannot send funds to any wallet but yours");
    // The caps, with the exposure product over the seven-day ceiling.
    expect(panel).toContain("Daily USDT spend cap");
    expect(panel).toContain("44 USDT");
    expect(panel).toContain("over the session's 7 days: up to 308 USDT");
    expect(panel).toContain("the ceiling is 7 days and cannot be raised");
  });

  it("dashes with a reason when the grant cannot be read, rather than describing a grant it never saw", async () => {
    sessionOk = false;
    await mount(lendingView());
    await openTab("Permissions");
    await act(async () => { await Promise.resolve(); });
    const panel = testid("lending-permissions");
    expect(panel).toContain("the session grant could not be read");
    expect(panel).not.toContain("Borrow against your account");
  });
});

/* -------------------------------------------------------------------------- */
/* Token logos                                                                */
/* -------------------------------------------------------------------------- */

describe("token logos on the market rows", () => {
  const vBnbMarket = {
    ...market, vToken: V_BNB, symbol: "vBNB", underlying: null, underlyingDecimals: 18,
    supplyUnderlyingWei: "1000000000000000000", borrowWei: "0",
  };

  async function mountWithMarkets() {
    const base = lendingView();
    const payload = base.snapshot.payload!;
    await mount({
      ...base,
      snapshot: { ...base.snapshot, payload: { ...payload, account: { ...payload.account, markets: [market, vBnbMarket] } } },
    });
    await act(async () => { await Promise.resolve(); });
  }

  it("asks for the underlying of each market, with WBNB standing in for vBNB's null underlying", async () => {
    iconPayload = { [USDT.toLowerCase()]: "https://icons.test/usdt.png", [WBNB.toLowerCase()]: null };
    await mountWithMarkets();
    const request = iconRequests.at(-1) ?? "";
    expect(request).toContain(USDT.toLowerCase());
    // vBNB's `underlying` is NULL — BNB is native — so the row resolves through
    // WBNB's address instead of asking for nothing.
    expect(request).toContain(WBNB.toLowerCase());
  });

  it("falls back to a symbol badge on a miss without dropping or shifting the row", async () => {
    iconPayload = { [USDT.toLowerCase()]: "https://icons.test/usdt.png", [WBNB.toLowerCase()]: null };
    await mountWithMarkets();
    const images = [...host.querySelectorAll("img")];
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("alt")).toBe("USDT");
    // Both rows are still there, missing icon or not.
    const position = testid("lending-position");
    expect(position).toContain("vUSDT");
    expect(position).toContain("vBNB");
  });
});

/* -------------------------------------------------------------------------- */
/* The hold is a banner, not a badge                                          */
/* -------------------------------------------------------------------------- */

describe("guard.hold", () => {
  it("says loudly, above the tiles, that a held guard is not repaying", async () => {
    await mount(lendingView({ guard: { ...guard, hold: "arm-unknown" } }));
    const banner = host.querySelector("[data-testid=\"lending-hold\"]");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("NOT repaying");
    expect(banner?.textContent).toContain("arm-unknown");
    expect(banner?.textContent).toContain("A second arm is blocked");
  });

  it("shows no hold banner when the guard is not held", async () => {
    await mount(lendingView());
    expect(host.querySelector("[data-testid=\"lending-hold\"]")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* fix 7 — the USDT cap is named for what it meters                           */
/* -------------------------------------------------------------------------- */

describe("the USDT cap's label", () => {
  it("keeps the spend cap in Overview and its metering explanation in Permissions", async () => {
    await mount(lendingView());
    const panel = testid("lending-reserve-panel");
    expect(panel).toContain("Daily USDT spend cap");
    expect(panel).toContain("44 USDT");
    expect(panel).not.toContain("charged by every USDT approve the session makes");
    await openTab("Permissions");
    expect(host.textContent).toContain("charged by every USDT approve the session makes");
    expect(host.textContent).toContain("not reported by this view");
    // The old name claimed it bounded repays. It does not.
    expect(host.textContent).not.toContain("Daily repay limit");
  });
});

/**
 * The contract the fixture got wrong once: `SpendPeriod` is a WORD, and the
 * agent read forwards it verbatim. A parser that demands a number answers
 * "no live session grant" for every real agent while a numeric fixture keeps
 * the suite green — which is exactly what happened. Both halves are pinned
 * here: the plane's own shape parses, and a numeric period does not.
 */
describe("the session grant's rolling period", () => {
  it("parses the plane's word and states the seven-day exposure", async () => {
    await mount(lendingView());
    await openTab("Permissions");
    const text = host.textContent ?? "";
    expect(text).not.toContain("no live session grant");
    expect(text).toContain("Daily USDT spend cap");
    expect(text).toContain("over the session's 7 days");
    expect(text).not.toContain("rolling period 86400 s");
  });

  it("refuses to multiply a non-daily cap by seven", async () => {
    sessionPayload = {
      data: { agent: { session: {
        publicKey: `0x${"cd".repeat(32)}`, expiresAt: FUTURE_EXPIRY,
        allowedCalls: [{ to: USDT, selector: "approve(address,uint256)" }],
        spendCaps: [{ token: USDT, period: "hour", limit: "44000000000000000000" }],
      } } },
    };
    await mount(lendingView());
    await openTab("Permissions");
    const text = host.textContent ?? "";
    expect(text).toContain("USDT spend cap per hour");
    expect(text).toContain("the session total is not derived from a non-daily cap");
    expect(text).not.toContain("over the session's 7 days");
  });

  it("voids the grant when the period is not a word at all", async () => {
    sessionPayload = {
      data: { agent: { session: {
        publicKey: `0x${"cd".repeat(32)}`, expiresAt: FUTURE_EXPIRY,
        allowedCalls: [{ to: USDT, selector: "approve(address,uint256)" }],
        spendCaps: [{ token: USDT, period: 86_400, limit: "44000000000000000000" }],
      } } },
    };
    await mount(lendingView());
    await openTab("Permissions");
    expect(host.textContent ?? "").toContain("no live session grant");
  });
});

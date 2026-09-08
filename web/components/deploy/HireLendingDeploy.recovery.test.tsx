// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HireSessionView } from "@/lib/altana/hire-state";
import { paramsHash, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { GuardedAccountState } from "./GuardedAccountSection";

const mocks = vi.hoisted(() => ({
  signReadHeader: vi.fn(),
  signEnvelope: vi.fn(),
  grant: vi.fn(),
  createPasskey: vi.fn(),
  createPasskeyWallet: vi.fn(),
  go: vi.fn(),
  owner: {
    passkey: {},
    walletAddress: "0x1111111111111111111111111111111111111111",
    ownerAddress: "0x2222222222222222222222222222222222222222",
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({
  useOwnerActions: () => ({
    ...mocks.owner,
    signReadHeader: mocks.signReadHeader,
    signEnvelope: mocks.signEnvelope,
    createPasskey: mocks.createPasskey,
  }),
}));
vi.mock("@/lib/altana/client", () => ({
  grantAgentSession: mocks.grant,
  createPasskeyWallet: mocks.createPasskeyWallet,
  GrantAgentSessionError: class extends Error { constructor(readonly code: string) { super(code); } },
}));
vi.mock("@/components/FundsModal", () => ({ FundsModal: () => null }));

import {
  HireLendingDeploy,
  LENDING_ARM_OUTCOME_STORAGE_PREFIX,
  LENDING_ARM_PARAMS_STORAGE_PREFIX,
  LENDING_HIRE_ENVELOPE_STORAGE_PREFIX,
  LENDING_HIRE_STORAGE_KEY,
  LendingArmOutcomeError,
  armLendingAgent,
  type PersistedLendingArmParams,
} from "./HireLendingDeploy";

const ID = "lending-agent-01";
const V_USDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255";
const V_BNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ACCOUNT = "0x3333333333333333333333333333333333333333";
const ATTEMPT_ID = `0x${"55".repeat(32)}` as const;

const CONFIG = {
  chainId: 56, vUsdt: V_USDT, usdt: USDT, vBnb: V_BNB,
  routerV3: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", wbnb: WBNB,
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  swapFeeTier: 100, maxSagaSlippageBps: 50, dustUsdtWei: "10000000000000000", maxMarkets: 24,
};

function guardableView(guardable = true) {
  return {
    account: ACCOUNT,
    blockNumber: "120362697",
    bases: {
      borrowingPower: { hf: "1300000000000000000", matched: true },
      liquidation: { hf: "1180000000000000000", matched: true },
    },
    markets: [{
      vToken: V_USDT, symbol: "vUSDT", underlying: USDT, underlyingDecimals: 18,
      supplyUnderlyingWei: "0", borrowWei: "1000000000000000000000", isCollateral: false,
      collateralFactor: "800000000000000000", liquidationThreshold: "850000000000000000",
      priceMantissa: "1000000000000000000",
    }],
    debts: [{
      vToken: V_USDT, symbol: "vUSDT", borrowWei: "1000000000000000000000",
      debtValueMantissa: "1000000000000000000000", supported: true,
    }],
    guardable,
    ...(guardable ? {} : { refusal: "no-debt" as const }),
    sizing: {
      reserveCapFloorWei: "44000000000000000000",
      minimumCapDayWei: "90000000000000000",
      mintUsdtWei: "40000000000000000000",
      reserveNativeWei: "10000000000000000",
      supplyNativeWei: "40000000000000000",
      ok: guardable,
    },
    previewReceipt: "v1.receipt.bytes",
    expiresAtSec: 1_700_000_030,
  };
}

function guarded(overrides: Partial<GuardedAccountState> = {}): GuardedAccountState {
  return {
    account: ACCOUNT, editing: false, confirmed: true, loading: false, reason: null,
    view: guardableView() as unknown as GuardedAccountState["view"],
    ...overrides,
  };
}

const envelope = {
  signed: { action: "provisionAgent", agentId: ID },
  signature: "0x1234",
  params: { sizingPreset: "lending-v1" },
} as unknown as OwnerActionEnvelope;

const provisioning = (attempt = false): HireSessionView => ({
  status: "provisioning",
  missing: ["account-key", "keystore-id"],
  sessionPublicKey: `0x04${"33".repeat(64)}`,
  sessionAddress: "0x5555555555555555555555555555555555555555",
  expiresAt: 9_999_999_999,
  permissions: { calls: [], spend: [] },
  hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: "50000000000000000" },
  ...(attempt ? { grantAttempt: { version: 1, attemptId: ATTEMPT_ID, startedAtSec: 100 } } : {}),
});

function preview(balanceWei = "1000") {
  return {
    capDayWei: "0",
    sizing: {
      name: "lending-v1", version: 1, openNativeBudgetWei: "50000000000000000",
      relayFeePerSubmitWei: "100000000000000", armSubmissionPad: 3,
    },
    funding: {
      version: 1, observedAtSec: Math.floor(Date.now() / 1000), registrationFeeWei: "2",
      registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei,
    },
  };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), {
  status, headers: { "content-type": "application/json" },
});

const ARMABLE_HIRE = JSON.stringify({
  settings: {
    triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
    maxPerAction: [{ token: USDT, maxWei: "12000000000000000000" }],
    minSecondsBetweenActions: 300, rescueReserveCount: 6,
  },
  budgetWei: "50000000000000000",
  reserveBps: 2000,
  reserveCapWei: "44000000000000000000",
});

function currentArmView(values: PersistedLendingArmParams = JSON.parse(ARMABLE_HIRE) as PersistedLendingArmParams) {
  return {
    guard: {
      status: "provisioning-guard", hold: null, guardedAccount: ACCOUNT, debtMarkets: [V_USDT],
      reserveBps: values.reserveBps, budgetWei: "0", reserveCapWei: values.reserveCapWei,
      armTxHash: null, armBlock: null, closeReason: null, actionSeq: 0, lastActionAtMs: null, updatedAtMs: 1,
    },
    snapshot: { presentAt: null, ageMs: null, staleAfterMs: 60000, stale: true, reason: "not armed", workerIntervalMs: 30000, payload: null },
    rescues: [], settings: { ...values.settings, notifyOnlyBelowHf: "notifyOnlyBelowHf" in values.settings ? values.settings.notifyOnlyBelowHf : null },
    settingsDigest: paramsHash("lendingSettings", values.settings),
    session: { expiresAt: 9999999999, expiring: false }, recovery: { note: "recoverable with your passkey" },
  };
}

let host: HTMLDivElement;
let root: Root | null;
let current: HireSessionView;
let mayInvoke: boolean;
let agentList: { id: string; status: string; walletAddress: string }[];
let armStatus: "completed" | "held" | "rolled-back";
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let provisionResponse: Response | null;
let previewReads: number;
/** FIXREVIEW F2 — what `GET /agents/:id/lending/view` answers this run. */
let lendingViewBody: unknown;
let lendingViewStatus: number;
let lendingViewThrows: boolean;
/** The venue read, so the OPTIONAL `workerIntervalMs` can be present or absent. */
let configPayload: Record<string, unknown>;

function component(props: Partial<React.ComponentProps<typeof HireLendingDeploy>> = {}) {
  return <HireLendingDeploy
    mode="Live"
    agentName="Lending Agent 01"
    capitalBnb="0.05"
    guarded={guarded()}
    triggerHf="1.20"
    targetHf="1.50"
    maxRepayUsd="12"
    rescueReserveCount={6}
    cooldownSeconds={300}
    reserveBps={2000}
    go={mocks.go}
    {...props}
  />;
}

async function mount(props: Partial<React.ComponentProps<typeof HireLendingDeploy>> = {}) {
  await act(async () => { root!.render(component(props)); });
  // Lets the venue config, the price read and the debounced sizing read settle.
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (found === undefined) throw new Error(`Button ${label} not found: ${host.textContent}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  mocks.owner.ownerAddress = "0x2222222222222222222222222222222222222222";
  current = provisioning(false);
  mayInvoke = false;
  provisionResponse = null;
  previewReads = 0;
  armStatus = "completed";
  agentList = [];
  lendingViewBody = currentArmView();
  lendingViewStatus = 200;
  lendingViewThrows = false;
  configPayload = CONFIG;
  mocks.signReadHeader.mockResolvedValue("signed-read");
  mocks.signEnvelope.mockImplementation(async (action: string, agentId: string, params: unknown) => ({
    signed: { action, agentId }, signature: "0x1234", params,
  }));
  mocks.grant.mockResolvedValue({});
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/lending/config")) return json(configPayload);
    if (url.startsWith("/api/market-data/tokens/")) {
      return new Response(JSON.stringify({
        data: { address: WBNB.toLowerCase(), priceUsd: 900 },
        meta: { staleness: "fresh", source: "test", asOf: Date.now() },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("/api/lending/guardable")) return json(guardableView());
    if (url.includes("/hire/preview")) {
      previewReads += 1;
      // The first read is short, so the deposit branch runs; every later read
      // shows the deposit landed, exactly as the LP hire test does.
      return json(preview(previewReads === 1 ? "1000" : "999999999999999999"));
    }
    if (url === "/api/agents") return json({ agents: agentList });
    if (url.endsWith("/session/grant-attempt") && init?.method === "POST") {
      current = provisioning(true);
      return json({ ...current, attemptId: ATTEMPT_ID, mayInvoke });
    }
    if (url.endsWith("/session/grant-attempt/reset") && init?.method === "POST") {
      current = provisioning(false);
      return json(current);
    }
    if (url.endsWith("/session/cancel") && init?.method === "POST") {
      return json({ ...provisioning(false), cancelRequested: true });
    }
    if (url.endsWith("/session")) return init?.method === "POST" ? provisionResponse ?? json(current) : json(current);
    if (url.endsWith("/lending/settings") && init?.method === "POST") {
      const saved = JSON.parse(String(init.body)) as { params: PersistedLendingArmParams["settings"] };
      lendingViewBody = { ...(lendingViewBody as Record<string, unknown>), settings: { ...saved.params, notifyOnlyBelowHf: "notifyOnlyBelowHf" in saved.params ? saved.params.notifyOnlyBelowHf : null }, settingsDigest: paramsHash("lendingSettings", saved.params) };
      return json({ settingsDigest: paramsHash("lendingSettings", saved.params) });
    }
    if (url.endsWith("/lending/arm") && init?.method === "POST") {
      return json({
        arm: {
          status: armStatus, reason: `${armStatus} reason`, txHash: null, effect: "changed",
          idleUsdtWei: "0", mintUsdtWei: "40000000000000000000",
          supplyNativeWei: "40000000000000000", reserveNativeWei: "10000000000000000", swapFeeTier: 100,
        },
      });
    }
    if (url.endsWith("/lending/view")) {
      if (lendingViewThrows) throw new Error("the plane is unreachable");
      return json(lendingViewBody, lendingViewStatus);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("lending durable grant recovery", () => {
  it("reloads an unresolved attempt as convergence and never offers a second grant", async () => {
    current = provisioning(true);
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_HIRE_ENVELOPE_STORAGE_PREFIX}${ID}`, JSON.stringify(envelope));
    await mount();
    expect(button("Continue deploy").disabled, host.textContent ?? "").toBe(false);
    expect(button("Reset stalled grant attempt")).toBeDefined();
    await act(async () => { button("Continue deploy").click(); await vi.advanceTimersByTimeAsync(6_001); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"))).toHaveLength(0);
    expect(localStorage.getItem(LENDING_HIRE_STORAGE_KEY)).toBe(ID);
  });

  it("claims once and lets only mayInvoke=true reach the wallet", async () => {
    mayInvoke = true;
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_HIRE_ENVELOPE_STORAGE_PREFIX}${ID}`, JSON.stringify(envelope));
    await mount();
    await act(async () => { button("Continue deploy").click(); await vi.advanceTimersByTimeAsync(6_001); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"))).toHaveLength(1);
    expect(mocks.grant, host.textContent ?? "").toHaveBeenCalledTimes(1);

    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await mount();
    await act(async () => { button("Continue deploy").click(); });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"))).toHaveLength(1);
  });

  it("renders polling, terminal, cancelled and retired reload states without re-granting", async () => {
    const cases: readonly {
      readonly view: HireSessionView;
      readonly expectedButton: string;
      readonly pointerCleared?: boolean;
    }[] = [
      { view: { ...provisioning(false), missing: ["account-key"] }, expectedButton: "Check hire status" },
      { view: { ...provisioning(false), missing: ["permissions-differ"] }, expectedButton: "Start a new hire" },
      { view: { ...provisioning(false), cancelRequested: true }, expectedButton: "Start a new hire", pointerCleared: true },
      { view: { status: "retired" }, expectedButton: "Deploy Lending Agent", pointerCleared: true },
    ];
    for (const testCase of cases) {
      await act(async () => { root!.unmount(); });
      host.replaceChildren();
      root = createRoot(host);
      localStorage.clear();
      localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
      current = testCase.view;
      await mount();
      expect(button(testCase.expectedButton), host.textContent ?? "").toBeDefined();
      expect(localStorage.getItem(LENDING_HIRE_STORAGE_KEY) === null).toBe(testCase.pointerCleared === true);
      expect(mocks.grant).not.toHaveBeenCalled();
    }
  });

  it("records cancellation before releasing the lending pointer", async () => {
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    current = provisioning(false);
    await mount();
    await act(async () => { button("Cancel hire safely").click(); });
    expect(localStorage.getItem(LENDING_HIRE_STORAGE_KEY)).toBeNull();
    expect(button("Start a new hire")).toBeDefined();
  });
});

describe("the PRE-SIGNATURE gates (R3.13, R2.20)", () => {
  // R3.13: a guard hired onto a wallet that already carries a live agent is
  // refused by the plane AFTER the owner has signed and possibly funded. The
  // browser must refuse first — before `provisionAgent`, and before any passkey
  // wallet ceremony.
  it("blocks a SHARED wallet before the hire signature and before createPasskeyWallet", async () => {
    agentList = [{ id: "grid-agent-01", status: "armed", walletAddress: mocks.owner.walletAddress }];
    await mount();
    await act(async () => { button("Deploy Lending Agent").click(); await vi.advanceTimersByTimeAsync(0); });

    const signedActions = mocks.signEnvelope.mock.calls.map(([action]) => action);
    expect(signedActions).not.toContain("provisionAgent");
    expect(mocks.createPasskey).not.toHaveBeenCalled();
    expect(mocks.createPasskeyWallet).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url).endsWith("/session") && init?.method === "POST")).toHaveLength(0);
    expect(host.textContent).toContain("already carries a live agent");
    expect(host.textContent).toContain("The guard needs its own account");
    expect(host.querySelector("a[href=\"/account\"]")?.textContent).toBe("Create account");
  });

  /**
   * W8 / AUDIT G-L5. The assertion above ("no `createPasskeyWallet`") is
   * VACUOUS on its own: this screen never calls it on any path, so it holds
   * whether or not the gate exists. The real precondition is an ORDER — the
   * wallet is read, and refused, BEFORE `provisionAgent` is signed and before
   * any passkey ceremony — and an order is only provable on the path where both
   * things actually happen. So the un-blocked hire is measured too: the agent
   * list must be read strictly before the first signature.
   */
  it("reads the wallet's occupancy STRICTLY BEFORE the hire signature", async () => {
    await mount();
    await act(async () => { button("Deploy Lending Agent").click(); await vi.advanceTimersByTimeAsync(0); });

    const listOrder = fetchMock.mock.calls
      .map((call, index) => ({ url: String(call[0]), order: fetchMock.mock.invocationCallOrder[index]! }))
      .filter((entry) => entry.url === "/api/agents")
      .map((entry) => entry.order);
    const signOrders = mocks.signEnvelope.mock.calls
      .map((call, index) => ({ action: call[0] as string, order: mocks.signEnvelope.mock.invocationCallOrder[index]! }));
    const provision = signOrders.find((entry) => entry.action === "provisionAgent");

    expect(listOrder.length, host.textContent ?? "").toBeGreaterThan(0);
    expect(provision, host.textContent ?? "").toBeDefined();
    expect(Math.min(...listOrder)).toBeLessThan(provision!.order);
    // …and the gate really is what stops the blocked case: the SAME read runs,
    // and this time no `provisionAgent` follows it.
    expect(mocks.createPasskey).not.toHaveBeenCalled();
  });

  it("disables Deploy with the plane's refusal when the account is NOT guardable", async () => {
    await mount({ guarded: guarded({ view: guardableView(false) as unknown as GuardedAccountState["view"] }) });
    expect(button("Deploy Lending Agent").disabled).toBe(true);
    expect(host.textContent).toContain("owes nothing on Venus");
    expect(mocks.signEnvelope).not.toHaveBeenCalled();
  });

  it("disables Deploy until the irreversibility tick is ticked", async () => {
    await mount({ guarded: guarded({ confirmed: false }) });
    expect(button("Deploy Lending Agent").disabled).toBe(true);
    expect(host.textContent).toContain("I understand repayments to this address cannot be reversed");
  });

  it("shows the exposure line and the DERIVED daily limit before any signature", async () => {
    await mount();
    const derived = host.querySelector("[data-testid=\"lending-derived\"]")?.textContent ?? "";
    expect(derived).toContain("Most this agent's key could move per day: 44 USDT + 0.09 BNB");
    expect(derived).toContain("× 7 days");
    expect(derived).toContain("72 USDT");
    expect(derived).toContain("Reserve: USDT supplied on Venus + BNB tier");
    expect(derived).toContain("A leaked session key can move the reserve OUT of wallet B");
    expect(mocks.signEnvelope).not.toHaveBeenCalled();
  });
});

describe("the S1 envelope", () => {
  it("signs the complete hire — receipt, settings, caps and pinned market — in one action", async () => {
    await mount();
    await act(async () => { button("Deploy Lending Agent").click(); await vi.advanceTimersByTimeAsync(0); });
    const call = mocks.signEnvelope.mock.calls.find(([action]) => action === "provisionAgent");
    expect(call, host.textContent ?? "").toBeDefined();
    const params = call?.[2] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual([
      "capDayWei", "debtMarkets", "guardedAccount", "openNativeBudgetWei", "previewReceipt",
      "reserveBps", "reserveCapWei", "settings", "sizingPreset", "token", "ttlSec", "walletAddress",
    ]);
    expect(params["sizingPreset"]).toBe("lending-v1");
    expect(params["token"]).toBe(USDT);
    expect(params["guardedAccount"]).toBe(ACCOUNT);
    expect(params["debtMarkets"]).toEqual([V_USDT]);
    expect(params["ttlSec"]).toBe(604_800);
    expect(params["reserveBps"]).toBe(2000);
    // The caps and the receipt come from the FRESH receipt-mode read, never from
    // a figure the browser computed.
    expect(params["capDayWei"]).toBe("90000000000000000");
    expect(params["reserveCapWei"]).toBe("44000000000000000000");
    expect(params["previewReceipt"]).toBe("v1.receipt.bytes");
    expect(params["settings"]).toEqual({
      triggerHf: "1200000000000000000",
      targetHf: "1500000000000000000",
      maxPerAction: [{ token: USDT, maxWei: "12000000000000000000" }],
      minSecondsBetweenActions: 300,
      rescueReserveCount: 6,
    });
    // A receipt taken ≤30 s before S1 — the LAST guardable read is receipt mode.
    const receiptReads = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/lending/guardable") && url.includes("previewReceipt=") === false
        && url.includes("budgetWei="));
    expect(receiptReads.length).toBeGreaterThan(0);
  });
});

describe("lending arm browser boundary", () => {
  it.each(["completed", "held"] as const)("ignores a %s arm response after switching owners", async status => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    const originalFetch = fetchMock.getMockImplementation()!;
    let release: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith("/lending/arm") && init?.method === "POST"
      ? new Promise<Response>(resolve => { release = resolve; }) : originalFetch(input, init));
    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(release).toBeDefined();
    mocks.owner.ownerAddress = "0x4444444444444444444444444444444444444444";
    await mount();
    await act(async () => {
      release!(json({ arm: { status, reason: "old owner outcome", txHash: null, effect: "changed", idleUsdtWei: "0", mintUsdtWei: "1", supplyNativeWei: "1", reserveNativeWei: "1", swapFeeTier: 100 } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.go).not.toHaveBeenCalled();
    expect(localStorage.getItem(LENDING_HIRE_STORAGE_KEY)).toBe(ID);
    expect(localStorage.getItem(`${LENDING_ARM_OUTCOME_STORAGE_PREFIX}${ID}`)).toBeNull();
    expect(host.textContent).not.toContain("old owner outcome");
  });

  it("does not post saved settings after the owner changes during the passkey prompt", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    let release: ((value: unknown) => void) | undefined;
    mocks.signEnvelope.mockImplementation(async (action: string, agentId: string, params: unknown) => action === "lendingSettings"
      ? new Promise<unknown>(resolve => { release = resolve; }) : { signed: { action, agentId }, params, signature: "0x1234" });
    await mount({ maxRepayUsd: "13" });
    await act(async () => { button("Save USDT max repay: 13").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(release).toBeDefined();
    mocks.owner.ownerAddress = "0x4444444444444444444444444444444444444444";
    await mount({ maxRepayUsd: "13" });
    await act(async () => { release!(envelope); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/settings"))).toHaveLength(0);
    expect(localStorage.getItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`)).toBe(ARMABLE_HIRE);
  });

  it("reports a cache write failure without claiming save success or arming", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    await mount({ maxRepayUsd: "13" });
    const setItem = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === `${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`) throw new Error("Browser storage full");
      setItem(key, value);
    });
    try {
      await act(async () => { button("Save USDT max repay: 13").click(); await vi.advanceTimersByTimeAsync(0); });
      expect(host.textContent).toContain("Browser storage full");
      expect(host.textContent).not.toContain("Saved USDT max repay:");
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it("saves 12 from an invalid 240 hire and only arms on the separate click", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    const old = JSON.parse(ARMABLE_HIRE) as PersistedLendingArmParams;
    const invalid = { ...old, settings: { ...old.settings, maxPerAction: [{ token: USDT, maxWei: "240000000000000000000" }] }, reserveCapWei: "27576869756323761389" };
    lendingViewBody = currentArmView(invalid);
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, JSON.stringify(invalid));
    await mount({ maxRepayUsd: "12", capitalBnb: "0.5" });
    await act(async () => { button("Save USDT max repay: 12").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain("Saved USDT max repay: 12 USDT");
    const saved = JSON.parse(localStorage.getItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`) ?? "null") as PersistedLendingArmParams;
    expect(saved.settings.maxPerAction).toEqual([{ token: USDT, maxWei: "12000000000000000000" }]);
    expect(saved.budgetWei).toBe(old.budgetWei);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(0);
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    const signedArm = mocks.signEnvelope.mock.calls.find(([action]) => action === "lendingArm")?.[2] as { settings: unknown; budgetWei: string };
    expect(signedArm.settings).toEqual(saved.settings);
    expect(signedArm.budgetWei).toBe(old.budgetWei);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(1);
  });

  it("requires another confirmation if the signed settings change again", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    const old = JSON.parse(ARMABLE_HIRE) as PersistedLendingArmParams;
    const newer = { ...old, settings: { ...old.settings, maxPerAction: [{ token: USDT, maxWei: "20000000000000000000" }] } };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    lendingViewBody = currentArmView(newer);
    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector("[data-testid='lending-arm-recovered']")?.textContent).toContain("20 USDT");
    const latest = { ...newer, settings: { ...newer.settings, maxPerAction: [{ token: USDT, maxWei: "25000000000000000000" }] } };
    lendingViewBody = currentArmView(latest);
    await act(async () => { button("Confirm these values and place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector("[data-testid='lending-arm-recovered']")?.textContent).toContain("25 USDT");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(0);
  });

  it("does not create a new hire whose max repay exceeds the preview grant cap", async () => {
    await mount({ maxRepayUsd: "240" });
    await act(async () => { button("Deploy Lending Agent").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain("proposed session cap of 44 USDT");
    expect(mocks.signEnvelope.mock.calls.map(([action]) => action)).not.toContain("provisionAgent");
  });

  it("explains a blocked resumed arm and makes the button eligible only after acknowledgment", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    await mount({ guarded: guarded({ confirmed: false }), maxRepayUsd: "12" });
    expect(button("Place the reserve").disabled).toBe(true);
    expect(host.textContent).toContain("I understand repayments to this address cannot be reversed");
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.signEnvelope).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(0);
    await mount({ guarded: guarded(), maxRepayUsd: "12" });
    expect(button("Place the reserve").disabled).toBe(false);
  });

  async function directArm(status: "completed" | "held" | "rolled-back" | "replayed") {
    const signed: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => json(
      status === "replayed"
        ? { replayed: true, state: "COMMITTED" }
        : {
          arm: {
            status, reason: `${status} reason`, txHash: null, effect: "changed",
            idleUsdtWei: "0", mintUsdtWei: "1", supplyNativeWei: "1", reserveNativeWei: "1", swapFeeTier: 100,
          },
        },
    )));
    return armLendingAgent({
      agentId: ID,
      settings: {
        triggerHf: "1200000000000000000", targetHf: "1500000000000000000",
        maxPerAction: [{ token: USDT, maxWei: "1" }],
        minSecondsBetweenActions: 300, rescueReserveCount: 6,
      },
      budgetWei: 50_000_000_000_000_000n,
      reserveBps: 2000,
      signEnvelope: async (_action, _agentId, params) => { signed.push(params as Record<string, unknown>); return envelope; },
    }).then((result) => ({ result, signed }));
  }

  it("signs settings, budget and reserveBps and nothing else", async () => {
    const { signed } = await directArm("completed");
    expect(Object.keys(signed[0] ?? {}).sort()).toEqual(["budgetWei", "reserveBps", "settings"]);
    expect(signed[0]?.["budgetWei"]).toBe("50000000000000000");
  });

  it("keeps held and rolled-back on the recovery path with the sanitized reason", async () => {
    for (const status of ["held", "rolled-back"] as const) {
      await expect(directArm(status)).rejects.toMatchObject({
        name: "LendingArmOutcomeError", status, message: `${status} reason`,
      });
    }
  });

  // L9: a replayed envelope carries NO outcome block. Nothing may be inferred.
  it("reports a replay instead of guessing an outcome", async () => {
    const { result } = await directArm("replayed");
    expect(result.replayed).toBe(true);
  });

  it("a HELD arm goes straight to the agent page and keeps the pointer and outcome", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    armStatus = "held";
    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(1);
    expect(mocks.go).toHaveBeenCalledWith(`/account/${ID}`);
    expect(localStorage.getItem(LENDING_HIRE_STORAGE_KEY)).toBe(ID);
    expect(JSON.parse(localStorage.getItem(`${LENDING_ARM_OUTCOME_STORAGE_PREFIX}${ID}`) ?? "{}"))
      .toMatchObject({ status: "held" });
  });

  it("reloads a HELD arm into recovery without re-arming, and a rolled-back one with a retry", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, ARMABLE_HIRE);
    localStorage.setItem(`${LENDING_ARM_OUTCOME_STORAGE_PREFIX}${ID}`, JSON.stringify({ status: "held", reason: "safe hold" }));
    await mount();
    expect(button("Continue from the agent page")).toBeDefined();
    expect(host.textContent).toContain("a second arm is blocked");
    expect(host.textContent).toContain("safe hold");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(0);

    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    localStorage.setItem(`${LENDING_ARM_OUTCOME_STORAGE_PREFIX}${ID}`, JSON.stringify({ status: "rolled-back", reason: "safe rollback" }));
    await mount();
    expect(button("Retry placing the reserve")).toBeDefined();
    expect(host.textContent).toContain("rolled back before anything moved");
    await act(async () => { button("Retry placing the reserve").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(1);
    expect(localStorage.getItem(LENDING_HIRE_STORAGE_KEY)).toBeNull();
  });

  it("exports the outcome error the recovery path branches on", () => {
    const error = new LendingArmOutcomeError("held", "why");
    expect(error.status).toBe("held");
    expect(error.name).toBe("LendingArmOutcomeError");
  });
});

/* -------------------------------------------------------------------------- */
/* W1 — the arm signs THE HIRE, not the form on screen (AUDIT G-M1)           */
/* -------------------------------------------------------------------------- */

describe("the arm signs the S1 values, across a reload", () => {
  // The hire the owner FUNDED: half a BNB, a 30 % reserve split and thresholds
  // nothing on this screen defaults to.
  const SIGNED = {
    settings: {
      triggerHf: "1350000000000000000",
      targetHf: "1900000000000000000",
      maxPerAction: [{ token: USDT, maxWei: "400000000000000000000" }],
      minSecondsBetweenActions: 900,
      rescueReserveCount: 12,
    },
    budgetWei: "500000000000000000",
    reserveBps: 3_000,
    reserveCapWei: "440000000000000000000",
  };

  function armParams(): Record<string, unknown> {
    const call = mocks.signEnvelope.mock.calls.find(([action]) => action === "lendingArm");
    expect(call, host.textContent ?? "").toBeDefined();
    return call?.[2] as Record<string, unknown>;
  }

  it("arms the PERSISTED hire after a reload, never this screen's defaults", async () => {
    current = { ...provisioning(false), status: "armed", missing: [], hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: SIGNED.budgetWei } };
    lendingViewBody = currentArmView(SIGNED);
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`, JSON.stringify(SIGNED));

    // A FRESH component with the screen's default props — exactly what a reload
    // between the grant and the arm produces.
    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    const params = armParams();
    expect(params["budgetWei"]).toBe("500000000000000000");
    expect(params["reserveBps"]).toBe(3_000);
    expect(params["settings"]).toEqual(SIGNED.settings);
    // And emphatically NOT the props the component was handed.
    expect(params["budgetWei"]).not.toBe("50000000000000000");
    expect(params["reserveBps"]).not.toBe(2_000);
  });

  it("REFUSES to arm with no persisted record rather than arming defaults", async () => {
    lendingViewBody = {};
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    expect(mocks.signEnvelope.mock.calls.map(([action]) => action)).not.toContain("lendingArm");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"))).toHaveLength(0);
    expect(host.textContent).toContain("are not saved in this browser");
  });

  it("persists the S1 values as part of the hire, and clears them with the pointer", async () => {
    await mount();
    await act(async () => { button("Deploy Lending Agent").click(); await vi.advanceTimersByTimeAsync(0); });
    const stored = JSON.parse(localStorage.getItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`) ?? "null") as Record<string, unknown>;
    const s1 = mocks.signEnvelope.mock.calls.find(([action]) => action === "provisionAgent")?.[2] as Record<string, unknown>;
    expect(stored, host.textContent ?? "").not.toBeNull();
    expect(stored["settings"]).toEqual(s1["settings"]);
    expect(stored["budgetWei"]).toBe(s1["openNativeBudgetWei"]);
    expect(stored["reserveBps"]).toBe(s1["reserveBps"]);
    expect(stored["reserveCapWei"]).toBe(s1["reserveCapWei"]);

    // The record is account-scoped storage like the pointer, and a cancelled
    // hire must not leave one behind for the next agent to arm from.
    await act(async () => { button("Cancel hire safely").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(localStorage.getItem(`${LENDING_ARM_PARAMS_STORAGE_PREFIX}${ID}`)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* FIXREVIEW F2 — the SECOND-DEVICE arm                                       */
/* -------------------------------------------------------------------------- */

describe("the arm can be completed from a browser that never ran the hire", () => {
  // The hire as the PLANE holds it: `lending_settings` (re-rendered through
  // `lendingSettingsView`, so an unset optional comes back as null) plus the
  // guard row's `reserveBps` and the session's `hireSizing.openNativeBudgetWei`.
  const HIRE_BUDGET = "500000000000000000";
  const SETTINGS_VIEW = {
    triggerHf: "1350000000000000000",
    targetHf: "1900000000000000000",
    maxPerAction: [{ token: USDT, maxWei: "400000000000000000000" }],
    minSecondsBetweenActions: 900,
    rescueReserveCount: 12,
    notifyOnlyBelowHf: null,
  };
  /** The bytes the plane hashed at S1 — the null optional is NOT one of them. */
  const SIGNED_PARAMS = {
    triggerHf: "1350000000000000000",
    targetHf: "1900000000000000000",
    maxPerAction: [{ token: USDT, maxWei: "400000000000000000000" }],
    minSecondsBetweenActions: 900,
    rescueReserveCount: 12,
  };
  const DIGEST = paramsHash("lendingSettings", SIGNED_PARAMS);

  function armedSession(): HireSessionView {
    return {
      ...provisioning(false),
      status: "armed",
      missing: [],
      hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: HIRE_BUDGET },
    };
  }

  function viewData(overrides: { status?: string; settingsDigest?: string | null } = {}) {
    return {
      guard: {
        status: overrides.status ?? "provisioning-guard",
        hold: null,
        guardedAccount: ACCOUNT,
        debtMarkets: [V_USDT],
        reserveBps: 3_000,
        // Zero until the arm writes it: the budget can only come from the hire.
        budgetWei: "0",
        reserveCapWei: "440000000000000000000",
        armTxHash: null, armBlock: null, closeReason: null,
        actionSeq: 0, lastActionAtMs: null, updatedAtMs: 1_700_000_000_000,
      },
      snapshot: {
        presentAt: null, ageMs: null, staleAfterMs: 60_000, stale: true,
        reason: "The worker has not reported for this guard yet.",
        workerIntervalMs: 30_000, payload: null,
      },
      rescues: [],
      settings: SETTINGS_VIEW,
      settingsDigest: overrides.settingsDigest === undefined ? DIGEST : overrides.settingsDigest,
      session: { expiresAt: 9_999_999_999, expiring: false },
      recovery: { note: "recoverable with your passkey" },
    };
  }

  function armParams(): Record<string, unknown> {
    const call = mocks.signEnvelope.mock.calls.find(([action]) => action === "lendingArm");
    expect(call, host.textContent ?? "").toBeDefined();
    return call?.[2] as Record<string, unknown>;
  }

  const armPosts = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lending/arm"));

  it("shows the plane's own record, and signs it only after the owner confirms", async () => {
    current = armedSession();
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    lendingViewBody = viewData();

    // A browser with NO W1 record for this agent — a second device, or this one
    // after `localStorage` was cleared.
    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    // Nothing signed yet: the values are on screen for the owner to read first.
    expect(mocks.signEnvelope.mock.calls.map(([action]) => action)).not.toContain("lendingArm");
    expect(armPosts()).toHaveLength(0);
    const panel = host.querySelector("[data-testid='lending-arm-recovered']");
    expect(panel, host.textContent ?? "").not.toBeNull();
    const shown = panel?.textContent ?? "";
    expect(shown).toContain("0.5 BNB");
    expect(shown).toContain("30%");
    expect(shown).toContain("1.35");
    expect(shown).toContain("1.9");
    expect(shown).toContain("400 USDT");
    expect(shown).toContain("900 s");
    expect(shown).toContain("12");

    await act(async () => { button("Confirm these values and place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    const params = armParams();
    expect(params["settings"]).toEqual(SIGNED_PARAMS);
    expect(params["budgetWei"]).toBe(HIRE_BUDGET);
    expect(params["reserveBps"]).toBe(3_000);
    // And emphatically NOT this screen's defaults, which is what W1 refused for.
    expect(params["budgetWei"]).not.toBe("50000000000000000");
    expect(params["reserveBps"]).not.toBe(2_000);
    expect(armPosts()).toHaveLength(1);
  });

  it("REFUSES when the digest it recomputes is not the one the hire carries", async () => {
    current = armedSession();
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    lendingViewBody = viewData({
      settingsDigest: paramsHash("lendingSettings", { ...SIGNED_PARAMS, rescueReserveCount: 3 }),
    });

    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    expect(mocks.signEnvelope.mock.calls.map(([action]) => action)).not.toContain("lendingArm");
    expect(armPosts()).toHaveLength(0);
    expect(host.querySelector("[data-testid='lending-arm-recovered']")).toBeNull();
    expect(host.textContent).toContain("the plane would refuse them");
  });

  it("refuses with the reason when the view cannot be read, and signs nothing", async () => {
    current = armedSession();
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    lendingViewThrows = true;

    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    expect(mocks.signEnvelope.mock.calls.map(([action]) => action)).not.toContain("lendingArm");
    expect(armPosts()).toHaveLength(0);
    expect(host.textContent).toContain("are not saved in this browser");
    expect(host.textContent).toContain("the execution plane could not be reached");
  });

  it("offers the agent page when the guard is already past the arm", async () => {
    current = armedSession();
    localStorage.setItem(LENDING_HIRE_STORAGE_KEY, ID);
    lendingViewBody = viewData({ status: "armed" });

    await mount();
    await act(async () => { button("Place the reserve").click(); await vi.advanceTimersByTimeAsync(0); });

    expect(armPosts()).toHaveLength(0);
    expect(mocks.signEnvelope.mock.calls.map(([action]) => action)).not.toContain("lendingArm");
    expect(host.textContent).toContain("already armed");
    await act(async () => { button("Open the agent page").click(); });
    expect(mocks.go).toHaveBeenCalledWith(`/account/${ID}`);
  });
});

describe("the deploy form's Check every figure", () => {
  it("renders the plane's cadence when it publishes one, and the dash when it does not", async () => {
    configPayload = { ...CONFIG, workerIntervalMs: 30_000 };
    await mount();
    expect(host.querySelector("[data-testid='lending-check-every']")?.textContent)
      .toContain("30 s — the operator's configured cadence");

    await act(async () => { root!.unmount(); });
    host.replaceChildren();
    root = createRoot(host);
    configPayload = CONFIG;
    await mount();
    const text = host.querySelector("[data-testid='lending-check-every']")?.textContent ?? "";
    expect(text).toContain("the agent page shows it once the guard reports");
    expect(text).not.toContain("30 s");
  });
});

/**
 * The screen's `SegmentedToggle` emits "Demo" | "Live", and grid and LP type
 * their prop that way. This component said `"Paper"`, so `mode === "Paper"` was
 * dead and picking Demo on the lending form rendered the LIVE passkey hire.
 * `DeployAgentScreen` is `@ts-nocheck`, so the mismatch typechecked.
 */
describe("Demo mode", () => {
  it("shows the demo stub and never the live hire path", async () => {
    await mount({ mode: "Demo" });
    expect(host.textContent).toContain("Deploy Lending Agent");
    // The live path's own controls must be absent: no funding read, no
    // guarded-account stage, no passkey prompt reachable from here.
    expect(host.querySelector("[data-testid='lending-derived']")).toBeNull();
    expect(host.querySelector("[data-testid='lending-exposure']")).toBeNull();
    expect(mocks.go).not.toHaveBeenCalled();

    button("Deploy Lending Agent").click();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(host.textContent).toContain("Demo engine coming soon.");
    expect(mocks.go).not.toHaveBeenCalled();
  });
});

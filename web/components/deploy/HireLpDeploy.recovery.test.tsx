// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HireSessionView } from "@/lib/altana/hire-state";
import type { OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { LivePool } from "./GridLiveDeploy";
import { priceFromTick } from "@/lib/lp/range";

const mocks = vi.hoisted(() => ({
  signReadHeader: vi.fn(),
  signEnvelope: vi.fn(),
  grant: vi.fn(),
  go: vi.fn(),
  owner: {
    passkey: {},
    walletAddress: "0x1111111111111111111111111111111111111111",
    ownerAddress: "0x2222222222222222222222222222222222222222",
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({
  useOwnerActions: () => ({ ...mocks.owner, signReadHeader: mocks.signReadHeader, signEnvelope: mocks.signEnvelope }),
}));
vi.mock("@/lib/altana/client", () => ({
  grantAgentSession: mocks.grant,
  GrantAgentSessionError: class extends Error { constructor(readonly code: string) { super(code); } },
}));
vi.mock("@/components/FundsModal", () => ({ FundsModal: () => null }));

import {
  HireLpDeploy,
  LP_ARM_OUTCOME_STORAGE_PREFIX,
  LP_HIRE_ENVELOPE_STORAGE_PREFIX,
  LP_HIRE_STORAGE_KEY,
  armLpAgent,
} from "./HireLpDeploy";

const ID = "lp-agent-recovery";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const TOKEN = "0x3333333333333333333333333333333333333333";
const POOL_ADDRESS = "0x4444444444444444444444444444444444444444";
const ATTEMPT_ID = `0x${"55".repeat(32)}` as const;
const POOL: LivePool = {
  pool: POOL_ADDRESS,
  token0: WBNB,
  token1: TOKEN,
  token0Symbol: "WBNB",
  token1Symbol: "TOKEN",
  fee: 2500,
  tick: 0,
  tvlUsd: 1_000_000,
  volume24hUsd: 100_000,
  token0Icon: null,
  token1Icon: null,
  wbnbIsToken0: true,
  staleness: "fresh",
};

const envelope = {
  signed: { action: "provisionAgent", agentId: ID },
  signature: "0x1234",
  params: { sizingPreset: "lp-v1" },
} as unknown as OwnerActionEnvelope;

const provisioning = (attempt = false): HireSessionView => ({
  status: "provisioning",
  missing: ["account-key", "keystore-id"],
  sessionPublicKey: `0x04${"33".repeat(64)}`,
  sessionAddress: "0x5555555555555555555555555555555555555555",
  expiresAt: 9_999_999_999,
  permissions: { calls: [], spend: [] },
  ...(attempt ? { grantAttempt: { version: 1, attemptId: ATTEMPT_ID, startedAtSec: 100 } } : {}),
});

function preview(balanceWei = "1000") {
  return {
    capDayWei: "1000",
    sizing: { name: "lp-v1", version: 1, openNativeBudgetWei: "100", feeWei: "0", relayFeePerSubmitWei: "1",
      reserves: { exitWei: "1", protectWei: "1", gridFlipWei: "0", totalWei: "2" } },
    funding: { version: 1, observedAtSec: Math.floor(Date.now() / 1000), registrationFeeWei: "2",
      registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei },
  };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), {
  status,
  headers: { "content-type": "application/json" },
});

let host: HTMLDivElement;
let root: Root | null;
let current: HireSessionView;
let mayInvoke: boolean;
let previewReads: number;
let armOutcomeStatus: "completed" | "held" | "rolled-back" = "completed";
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let provisionResponse: Response | null;
let cancelResponse: Response;

function component() {
  return <HireLpDeploy
    mode="Live"
    agentName="LP recovery"
    uiPresetId="wide"
    pool={POOL}
    capitalBnb="0.0000000000000001"
    routeBy="fee-apr"
    takeProfitPct={0}
    stopLossPct={0}
    rotateMode="swapped"
    rotateMinHoldMinutes={60}
    compoundOn={false}
    minFees={10}
    primaryModel="Auto: OGM-1.0-35B-A3B"
    fallbackModel="Qwen3 VL 30B"
    instructions=""
    skillFile={null}
    explicitPrices={null}
    go={mocks.go}
  />;
}

async function mount() {
  await act(async () => { root!.render(component()); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
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
  current = provisioning(false);
  mayInvoke = false;
  previewReads = 0;
  provisionResponse = null;
  cancelResponse = json({ ...provisioning(false), cancelRequested: true });
  mocks.signReadHeader.mockResolvedValue("signed-read");
  mocks.signEnvelope.mockImplementation(async (action: string, agentId: string, params: unknown) => ({
    signed: { action, agentId }, signature: "0x1234", params,
  }));
  mocks.grant.mockResolvedValue({});
  armOutcomeStatus = "completed";
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) {
      previewReads += 1;
      return json(preview(previewReads === 1 ? "1000" : "100000000000001000"));
    }
    if (url === "/api/agents") return json({ agents: [] });
    if (url.endsWith("/session/cancel") && init?.method === "POST") return cancelResponse;
    if (url.endsWith("/session/grant-attempt") && init?.method === "POST") {
      current = provisioning(true);
      return json({ ...current, attemptId: ATTEMPT_ID, mayInvoke });
    }
    if (url.endsWith("/session/grant-attempt/reset") && init?.method === "POST") {
      current = provisioning(false);
      return json(current);
    }
    if (url.endsWith("/session")) return init?.method === "POST" ? provisionResponse ?? json(current) : json(current);
    if (url.endsWith("/lp/arm") && init?.method === "POST") {
      return json({ open: { status: armOutcomeStatus, reason: `${armOutcomeStatus} reason` }, position: { tokenId: "1" } });
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

describe("LP durable grant recovery", () => {
  it("reloads an unresolved attempt as convergence and never offers a second grant", async () => {
    current = provisioning(true);
    localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LP_HIRE_ENVELOPE_STORAGE_PREFIX}${ID}`, JSON.stringify(envelope));
    await mount();
    expect(button("Continue deploy").disabled).toBe(false);
    expect(button("Reset stalled grant attempt")).toBeDefined();
    await act(async () => { button("Continue deploy").click(); await vi.advanceTimersByTimeAsync(6_001); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"))).toHaveLength(0);
    expect(localStorage.getItem(LP_HIRE_STORAGE_KEY)).toBe(ID);
  });

  it("claims once and lets only mayInvoke=true call the wallet; reload remains convergence-only", async () => {
    mayInvoke = true;
    localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LP_HIRE_ENVELOPE_STORAGE_PREFIX}${ID}`, JSON.stringify(envelope));
    await mount();
    expect(button("Continue deploy").disabled, host.textContent ?? "").toBe(false);
    await act(async () => { button("Continue deploy").click(); await vi.advanceTimersByTimeAsync(6_001); });
    const attemptCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"));
    expect(attemptCalls, `${host.textContent}\n${fetchMock.mock.calls.map(([url]) => String(url)).join("\n")}`).toHaveLength(1);
    expect(mocks.grant, host.textContent ?? "").toHaveBeenCalledTimes(1);

    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await mount();
    await act(async () => { button("Continue deploy").click(); });
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"))).toHaveLength(1);
  });

  it("renders polling, terminal, cancelled, and retired reload states without re-granting", async () => {
    const cases: readonly {
      readonly view: HireSessionView;
      readonly expectedButton: string;
      readonly pointerCleared?: boolean;
    }[] = [
      { view: { ...provisioning(false), missing: ["account-key"] }, expectedButton: "Check hire status" },
      { view: { ...provisioning(false), missing: ["permissions-differ"] }, expectedButton: "Start a new hire" },
      { view: { ...provisioning(false), cancelRequested: true }, expectedButton: "Start a new hire", pointerCleared: true },
      { view: { status: "retired" }, expectedButton: "Deploy LP Agent", pointerCleared: true },
    ];
    for (const testCase of cases) {
      await act(async () => { root!.unmount(); });
      host.replaceChildren();
      root = createRoot(host);
      localStorage.clear();
      localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
      current = testCase.view;
      await mount();
      expect(button(testCase.expectedButton)).toBeDefined();
      expect(localStorage.getItem(LP_HIRE_STORAGE_KEY) === null).toBe(testCase.pointerCleared === true);
      expect(mocks.grant).not.toHaveBeenCalled();
    }
  });

  it("records cancellation before releasing the LP pointer and keeps a rejected cancellation retryable", async () => {
    localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
    current = provisioning(false);
    await mount();
    await act(async () => { button("Cancel hire safely").click(); });
    expect(localStorage.getItem(LP_HIRE_STORAGE_KEY)).toBeNull();
    expect(button("Start a new hire")).toBeDefined();

    await act(async () => { root!.unmount(); });
    host.replaceChildren();
    root = createRoot(host);
    localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
    current = provisioning(false);
    cancelResponse = new Response(JSON.stringify({ error: { message: "Please sign again." } }), { status: 401 });
    await mount();
    await act(async () => { button("Cancel hire safely").click(); });
    expect(localStorage.getItem(LP_HIRE_STORAGE_KEY)).toBe(ID);
    expect(button("Cancel hire safely").disabled).toBe(false);
    expect(host.textContent).toContain("Please sign again.");
  });

  it("resumes a 409-existing LP hire and does not submit a second grant", async () => {
    current = provisioning(true);
    provisionResponse = new Response(JSON.stringify({ error: { code: "conflict" } }), { status: 409 });
    await mount();
    await act(async () => { button("Deploy LP Agent").click(); await vi.advanceTimersByTimeAsync(0); });
    const sessionPosts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/session") && init?.method === "POST");
    expect(sessionPosts).toHaveLength(1);
    expect(localStorage.getItem(LP_HIRE_STORAGE_KEY)).not.toBeNull();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/session/grant-attempt"))).toHaveLength(0);
  });
});

describe("LP arm browser boundary", () => {
  async function directArm(input: {
    readonly pool: LivePool;
    readonly compoundOn?: boolean;
    readonly outcome?: "completed" | "held" | "rolled-back";
  }) {
    const signed: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const outcome = input.outcome ?? "completed";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request) => {
      const url = String(request);
      calls.push(url);
      if (url.startsWith("/api/pool-state")) return json({ pool: input.pool.pool, currentTick: 0, tickSpacing: 50 });
      return json({ open: { status: outcome, reason: `${outcome} reason` }, position: { tokenId: "1" } });
    }));
    const result = await armLpAgent({
      agentId: ID, uiPresetId: "blue", pool: input.pool, capitalBnb: "0.01", routeBy: "fee-apr",
      takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
      compoundOn: input.compoundOn ?? false, minFees: 10,
      primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B", instructions: "", skillFile: null,
      explicitPrices: { minPrice: 0.9, maxPrice: 1.1, currentTick: 0, tickSpacing: 50,
        wbnbIsToken0: input.pool.wbnbIsToken0, poolAddress: input.pool.pool, ready: true },
      signEnvelope: async (_action, _agentId, params) => { calls.push("sign"); signed.push(params); return envelope; },
    });
    return { result, signed, calls };
  }

  it("re-reads the signed pool before signing in both WBNB orientations and signs unchecked compound as false", async () => {
    for (const pool of [POOL, { ...POOL, token0: TOKEN, token1: WBNB, wbnbIsToken0: false }] as const) {
      const pending = directArm({ pool, compoundOn: false });
      const { signed, calls } = await pending;
      expect(calls[0]).toContain("/api/pool-state");
      expect(calls[1]).toBe("sign");
      expect((signed[0]?.settings as { autoHarvest?: boolean }).autoHarvest).toBe(false);
    }
    const compounded = await directArm({ pool: POOL, compoundOn: true });
    expect((compounded.signed[0]?.settings as { autoHarvest?: boolean; harvestMinFeesWei?: string }).autoHarvest).toBe(true);
    expect((compounded.signed[0]?.settings as { harvestMinFeesWei?: string }).harvestMinFeesWei).toBe("1000000000000000");
  });

  it("keeps held and rolled-back outcomes on the recovery path with the sanitized reason", async () => {
    for (const outcome of ["held", "rolled-back"] as const) {
      await expect(directArm({ pool: POOL, outcome })).rejects.toMatchObject({
        name: "LpArmOutcomeError", status: outcome, message: `${outcome} reason`,
      });
    }
  });

  it("reloads held into recovery without re-arming, and reloads rolled-back with an explicit retry", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LP_ARM_OUTCOME_STORAGE_PREFIX}${ID}`, JSON.stringify({ status: "held", reason: "safe hold" }));
    await mount();
    expect(button("Continue from the agent page")).toBeDefined();
    expect(host.textContent).toContain("durable position and hire pointer are preserved");
    expect(host.textContent).toContain("safe hold");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lp/arm"))).toHaveLength(0);
    await act(async () => { button("Continue from the agent page").click(); });
    expect(mocks.go).toHaveBeenCalledWith(`/account/${ID}`);

    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    localStorage.setItem(`${LP_ARM_OUTCOME_STORAGE_PREFIX}${ID}`, JSON.stringify({ status: "rolled-back", reason: "safe rollback" }));
    await mount();
    expect(button("Retry opening position")).toBeDefined();
    expect(host.textContent).toContain("rolled back before funding");
    expect(host.textContent).toContain("safe rollback");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lp/arm"))).toHaveLength(0);
    await act(async () => { button("Retry opening position").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lp/arm"))).toHaveLength(1);
    expect(localStorage.getItem(LP_HIRE_STORAGE_KEY)).toBeNull();
  });

  it("a HELD open goes straight to the agent page — no extra press — and keeps the pointer and outcome", async () => {
    current = { ...provisioning(false), status: "armed", missing: [] };
    localStorage.setItem(LP_HIRE_STORAGE_KEY, ID);
    localStorage.setItem(`${LP_ARM_OUTCOME_STORAGE_PREFIX}${ID}`, JSON.stringify({ status: "rolled-back", reason: "safe rollback" }));
    armOutcomeStatus = "held";
    await mount();
    await act(async () => { button("Retry opening position").click(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/lp/arm"))).toHaveLength(1);
    expect(mocks.go).toHaveBeenCalledWith(`/account/${ID}`);
    expect(localStorage.getItem(LP_HIRE_STORAGE_KEY)).toBe(ID);
    expect(JSON.parse(localStorage.getItem(`${LP_ARM_OUTCOME_STORAGE_PREFIX}${ID}`) ?? "{}")).toMatchObject({ status: "held" });
  });

  function armWithLiveState(live: { currentTick: number; tickSpacing: number }, sign: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request) => {
      const url = String(request);
      if (url.startsWith("/api/pool-state")) return json({ pool: POOL.pool, ...live });
      return json({ open: { status: "completed" }, position: { tokenId: "1" } });
    }));
    return armLpAgent({
      agentId: ID, uiPresetId: "blue", pool: POOL, capitalBnb: "0.01", routeBy: "fee-apr",
      takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
      compoundOn: false, minFees: 10, primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B",
      instructions: "", skillFile: null,
      // Prices 0.9 … 1.1 around tick 0 ≈ ticks −1054 … +953.
      explicitPrices: { minPrice: 0.9, maxPrice: 1.1, currentTick: 0, tickSpacing: 50,
        wbnbIsToken0: true, poolAddress: POOL.pool, ready: true },
      signEnvelope: sign as never,
    });
  }

  it("refuses a changed spacing or orientation before any signature", async () => {
    const sign = vi.fn();
    await expect(armWithLiveState({ currentTick: 0, tickSpacing: 10 }, sign)).rejects.toThrow(/changed/u);
    expect(sign).not.toHaveBeenCalled();
  });

  it("derives the signed ticks from the typed prices against the LIVE tick when the price is still inside the band", async () => {
    // The pool moved 0 → 50 between display and signature; the band 0.9–1.1
    // still straddles it, so the owner's prices are signed as-is (live tick).
    const signed: Record<string, unknown>[] = [];
    const sign = vi.fn(async (_action: string, _agentId: string, params: Record<string, unknown>) => { signed.push(params); return envelope; });
    await armWithLiveState({ currentTick: 50, tickSpacing: 50 }, sign);
    expect(sign).toHaveBeenCalledTimes(1);
    const range = signed[0]?.range as { tickLower: number; tickUpper: number };
    expect(range.tickLower).toBeLessThanOrEqual(50);
    expect(range.tickUpper).toBeGreaterThan(50);
    expect(Math.abs(range.tickLower % 50)).toBe(0);
    expect(Math.abs(range.tickUpper % 50)).toBe(0);
  });

  it("refuses — before any signature — when the live price has left the typed band", async () => {
    const sign = vi.fn();
    // tick 2000 ≈ price 1.22, above the 1.1 maximum.
    await expect(armWithLiveState({ currentTick: 2000, tickSpacing: 50 }, sign)).rejects.toThrow(/left the typed band/u);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses when the live price left the band by LESS than one tick spacing (raw band, not the snapped one)", async () => {
    // maxPrice 1.1 ≈ tick 953.1; the snapped upper bound is 1000. A live tick of
    // 970 is INSIDE the snapped range but OUTSIDE the typed band — refused.
    const sign = vi.fn();
    await expect(armWithLiveState({ currentTick: 970, tickSpacing: 50 }, sign)).rejects.toThrow(/left the typed band/u);
    expect(sign).not.toHaveBeenCalled();
    // And symmetrically below: minPrice 0.9 ≈ tick −1053.6, snapped lower −1100; tick −1080 is refused.
    await expect(armWithLiveState({ currentTick: -1080, tickSpacing: 50 }, sign)).rejects.toThrow(/left the typed band/u);
    expect(sign).not.toHaveBeenCalled();
  });

  it("applies the raw-band rule in the quote-is-token0 orientation too", async () => {
    // With the quote on token0 a HIGHER price is a LOWER tick: prices 0.9 … 1.1
    // become ticks +1053 … −953. Live tick −970 (price ≈ 1.1019) has left the band.
    const sign = vi.fn();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request) => {
      const url = String(request);
      if (url.startsWith("/api/pool-state")) return json({ pool: POOL.pool, currentTick: -970, tickSpacing: 50 });
      return json({ open: { status: "completed" }, position: { tokenId: "1" } });
    }));
    await expect(armLpAgent({
      agentId: ID, uiPresetId: "blue", pool: POOL, capitalBnb: "0.01", routeBy: "fee-apr",
      takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
      compoundOn: false, minFees: 10, primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B",
      instructions: "", skillFile: null,
      explicitPrices: { minPrice: 0.9, maxPrice: 1.1, currentTick: 0, tickSpacing: 50,
        wbnbIsToken0: true, quoteIsToken0: true, poolAddress: POOL.pool, ready: true },
      signEnvelope: sign as never,
    })).rejects.toThrow(/left the typed band/u);
    expect(sign).not.toHaveBeenCalled();
  });

  it("quote-is-token0: refuses when the live price fell BELOW the typed minimum, and signs at the band edge", async () => {
    // Quote on token0 ⇒ minPrice 0.9 is tick +1053.6 (snapped lower bound of the
    // signed range is −1000 … the higher tick 1100). Live tick +1080 has price
    // 0.8976 < 0.9: left the band below — refused.
    const arm = (currentTick: number, sign: ReturnType<typeof vi.fn>) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request) => {
        const url = String(request);
        if (url.startsWith("/api/pool-state")) return json({ pool: POOL.pool, currentTick, tickSpacing: 50 });
        return json({ open: { status: "completed" }, position: { tokenId: "1" } });
      }));
      return armLpAgent({
        agentId: ID, uiPresetId: "blue", pool: POOL, capitalBnb: "0.01", routeBy: "fee-apr",
        takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
        compoundOn: false, minFees: 10, primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B",
        instructions: "", skillFile: null,
        explicitPrices: { minPrice: 0.9, maxPrice: 1.1, currentTick: 0, tickSpacing: 50,
          wbnbIsToken0: true, quoteIsToken0: true, poolAddress: POOL.pool, ready: true },
        signEnvelope: sign as never,
      });
    };
    const refused = vi.fn();
    await expect(arm(1080, refused)).rejects.toThrow(/left the typed band/u);
    expect(refused).not.toHaveBeenCalled();
    // Exactly at the typed maximum (price 1.1 ⇔ tick −953.1): the raw band is
    // inclusive and the snapped range [−1000, 1100) contains −953 — signs.
    const signed: Record<string, unknown>[] = [];
    const accepted = vi.fn(async (_a: string, _b: string, params: Record<string, unknown>) => { signed.push(params); return envelope; });
    await arm(-953, accepted);
    expect(accepted).toHaveBeenCalledTimes(1);
    const range = signed[0]?.range as { tickLower: number; tickUpper: number };
    expect(range.tickLower).toBe(-1000);
    expect(range.tickUpper).toBe(1100);
  });

  it("signs when the live price sits EXACTLY on the typed band edge (inclusive raw band, half-open snapped range)", async () => {
    // minPrice is the price AT tick −1000 (quote token1 ⇒ price rises with tick),
    // so a live tick of −1000 puts the live price exactly ON the band's lower
    // edge. The raw band is inclusive and the snapped range [−1000, 1000) is
    // half-open at the top only, so the lower edge is the one that signs. (The
    // upper edge on a spacing multiple is excluded by the half-open rule — the
    // plane enforces the same rule.)
    const edge = priceFromTick(-1_000, { wbnbIsToken0: true });
    const signed: Record<string, unknown>[] = [];
    const sign = vi.fn(async (_a: string, _b: string, params: Record<string, unknown>) => { signed.push(params); return envelope; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (request) => {
      const url = String(request);
      if (url.startsWith("/api/pool-state")) return json({ pool: POOL.pool, currentTick: -1_000, tickSpacing: 50 });
      return json({ open: { status: "completed" }, position: { tokenId: "1" } });
    }));
    await armLpAgent({
      agentId: ID, uiPresetId: "blue", pool: POOL, capitalBnb: "0.01", routeBy: "fee-apr",
      takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
      compoundOn: false, minFees: 10, primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B",
      instructions: "", skillFile: null,
      explicitPrices: { minPrice: edge, maxPrice: 1.1, currentTick: -1_000, tickSpacing: 50,
        wbnbIsToken0: true, poolAddress: POOL.pool, ready: true },
      signEnvelope: sign as never,
    });
    expect(sign).toHaveBeenCalledTimes(1);
    const range = signed[0]?.range as { tickLower: number; tickUpper: number };
    expect(range.tickLower).toBe(-1_000);
    expect(range.tickUpper).toBe(1_000);
  });

  it("refuses a changed pool address or WBNB orientation before any signature", async () => {
    const sign = vi.fn();
    // Pool address differs from the displayed snapshot.
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => json({ pool: "0x9999999999999999999999999999999999999999", currentTick: 0, tickSpacing: 50 })));
    await expect(armLpAgent({
      agentId: ID, uiPresetId: "blue", pool: POOL, capitalBnb: "0.01", routeBy: "fee-apr",
      takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
      compoundOn: false, minFees: 10, primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B",
      instructions: "", skillFile: null,
      explicitPrices: { minPrice: 0.9, maxPrice: 1.1, currentTick: 0, tickSpacing: 50,
        wbnbIsToken0: true, poolAddress: POOL.pool, ready: true },
      signEnvelope: sign as never,
    })).rejects.toThrow(/changed/u);
    // Displayed orientation contradicts the pool's legs.
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => json({ pool: POOL.pool, currentTick: 0, tickSpacing: 50 })));
    await expect(armLpAgent({
      agentId: ID, uiPresetId: "blue", pool: POOL, capitalBnb: "0.01", routeBy: "fee-apr",
      takeProfitPct: 0, stopLossPct: 0, rotateMode: "swapped", rotateMinHoldMinutes: 60,
      compoundOn: false, minFees: 10, primaryModel: "Auto: OGM-1.0-35B-A3B", fallbackModel: "Qwen3 VL 30B",
      instructions: "", skillFile: null,
      explicitPrices: { minPrice: 0.9, maxPrice: 1.1, currentTick: 0, tickSpacing: 50,
        wbnbIsToken0: !POOL.wbnbIsToken0, poolAddress: POOL.pool, ready: true },
      signEnvelope: sign as never,
    })).rejects.toThrow(/changed/u);
    expect(sign).not.toHaveBeenCalled();
  });
});

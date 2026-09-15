// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HireSessionView } from "@/lib/altana/hire-state";

const mocks = vi.hoisted(() => ({
  signReadHeader: vi.fn(), signEnvelope: vi.fn(), grant: vi.fn(), arm: vi.fn(),
  owner: { passkey: {}, walletAddress: "0x1111111111111111111111111111111111111111", ownerAddress: "0x2222222222222222222222222222222222222222" },
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ ...mocks.owner, signReadHeader: mocks.signReadHeader, signEnvelope: mocks.signEnvelope }) }));
vi.mock("@/lib/altana/client", () => ({ grantAgentSession: mocks.grant, GrantAgentSessionError: class extends Error {} }));
vi.mock("@/components/FundsModal", () => ({ FundsModal: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Close deposit</button> }));
vi.mock("./GridLiveDeploy", () => ({ armGridAgent: mocks.arm, GridDeployActions: () => null, UI_PRESET_TO_GEOMETRY: { balanced: "standard" } }));

import { HireGridDeploy } from "./HireGridDeploy";
import { HireRecoveryActions } from "./HireRecoveryActions";
import { GRID_HIRE_CHOICES_STORAGE_KEY } from "@/lib/altana/grid-hire-recovery";

const key = "4lpha:grid-hire:v1";
const id = "grid-agent-01-3";
const session: HireSessionView = {
  status: "provisioning", missing: ["account-key", "keystore-id"],
  sessionPublicKey: `0x${"33".repeat(65)}`, sessionAddress: "0x3333333333333333333333333333333333333333",
  expiresAt: 9999999999, permissions: { calls: [], spend: [] },
};
function preview(balanceWei = "0") {
  return { capDayWei: "1000", sizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "100", feeWei: "0", relayFeePerSubmitWei: "1", reserves: { exitWei: "1", protectWei: "1", gridFlipWei: "1", totalWei: "3" } },
    funding: { version: 1, observedAtSec: Math.floor(Date.now() / 1000), registrationFeeWei: "2", registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
let host: HTMLDivElement;
let root: Root | null;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let currentSession: HireSessionView;
let nextFunding: Promise<Response> | null;
let nextSession: Promise<Response> | null;
let nextProvision: Promise<Response> | null;
let cancelResponse: () => Response;
const gridPool = { pool: "0x4444444444444444444444444444444444444444", token0: "0x5555555555555555555555555555555555555555", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", fee: 2500, wbnbIsToken0: false } as React.ComponentProps<typeof HireGridDeploy>["pool"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  mocks.signReadHeader.mockResolvedValue("signed-read");
  mocks.signEnvelope.mockImplementation(async (action: string, agentId: string, params: unknown) => ({ signed: { action, agentId, owner: mocks.owner.ownerAddress }, signature: "0xsignature", params }));
  mocks.grant.mockResolvedValue({});
  mocks.arm.mockResolvedValue({});
  currentSession = session;
  nextFunding = null;
  nextSession = null;
  nextProvision = null;
  cancelResponse = () => json({ ...session, cancelRequested: true });
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) return nextFunding ?? json(preview());
    if (url === "/api/account/session") return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    if (url === "/api/agents") return json({ agents: [] });
    if (url.endsWith("/session/cancel")) return cancelResponse();
    if (url.endsWith("/session")) return init?.method === "POST" ? nextProvision ?? json(session) : nextSession ?? json(currentSession);
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
async function deploy(input: { readonly pool?: React.ComponentProps<typeof HireGridDeploy>["pool"]; readonly onRestoreChoices?: NonNullable<React.ComponentProps<typeof HireGridDeploy>["onRestoreChoices"]> } = {}) {
  await act(async () => { root!.render(<HireGridDeploy mode="Live" agentName="Grid agent 01 3" uiPresetId="balanced"
    pool={input.pool === undefined ? gridPool : input.pool}
    capitalBnb="0.03" utilizationPct={30} maxRequotesDaily={16} takeProfitPct={0} stopLossPct={0} onRestoreChoices={input.onRestoreChoices} go={vi.fn()} />); });
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Button ${label} not found: ${host.textContent}`);
  return found;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }

describe("grid hire interruption in the rendered UI", () => {
  it("closing funding stops the run even when its in-flight read later says funded", async () => {
    await deploy();
    await click("Deploy grid agent");
    expect(button("Close deposit")).toBeDefined();
    const pending = deferred<Response>();
    nextFunding = pending.promise;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    await click("Close deposit");
    expect(button("Continue deploy").disabled).toBe(false);
    expect(button("Cancel hire safely").disabled).toBe(false);
    await act(async () => { pending.resolve(json(preview("100"))); });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(button("Continue deploy").disabled).toBe(false);
    expect(button("Cancel hire safely").disabled).toBe(false);
  });

  it("cancellation releases the form while the old funding read is still unresolved", async () => {
    await deploy();
    await click("Deploy grid agent");
    const pending = deferred<Response>();
    nextFunding = pending.promise;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    await click("Cancel hire safely");
    expect(button("Start a new hire").disabled).toBe(false);
    await click("Start a new hire");
    expect(button("Deploy grid agent").disabled).toBe(false);
    await act(async () => { pending.resolve(json(preview("100"))); });
    expect(button("Deploy grid agent").disabled).toBe(false);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("a late successful S1 after unmount cannot overwrite a newer hire pointer", async () => {
    const pending = deferred<Response>();
    nextProvision = pending.promise;
    await deploy();
    await click("Deploy grid agent");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    await act(async () => { root!.unmount(); root = null; });
    localStorage.setItem(key, "newer-agent");
    await act(async () => { pending.resolve(json(session)); });
    expect(localStorage.getItem(key)).toBe("newer-agent");
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("unmount during the inner gridArm signature prevents its submission", async () => {
    localStorage.setItem(key, id);
    currentSession = {
      status: "armed",
      hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "30000000000000000" },
    };
    const signature = deferred<unknown>();
    const submitArm = vi.fn();
    mocks.signEnvelope.mockReturnValue(signature.promise);
    mocks.arm.mockImplementation(async (input: { signEnvelope: (action: string, agentId: string, params: Record<string, unknown>) => Promise<unknown> }) => {
      await input.signEnvelope("gridArm", id, {});
      submitArm();
      return {};
    });
    await deploy();
    await click("Arm the grid");
    expect(mocks.signEnvelope).toHaveBeenCalledWith("gridArm", id, {});
    await act(async () => { root!.unmount(); root = null; });
    await act(async () => { signature.resolve({ signed: {}, signature: "0xsig", params: {} }); });
    expect(submitArm).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("unmount while the S1 signature is open never submits that late signature", async () => {
    const signature = deferred<unknown>();
    mocks.signEnvelope.mockReturnValue(signature.promise);
    await deploy();
    await click("Deploy grid agent");
    await act(async () => { root!.unmount(); root = null; });
    await act(async () => { signature.resolve({ signed: {}, signature: "0xsig", params: {} }); });
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith("/api/agents/") && init?.method === "POST")).toHaveLength(0);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("cancel acknowledgement wins over an older poll and immediately permits a new hire", async () => {
    localStorage.setItem(key, id);
    currentSession = { ...session, missing: ["account-key"] };
    await deploy();
    const pending = deferred<Response>();
    nextSession = pending.promise;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await click("Cancel hire safely");
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => { pending.resolve(json(session)); });
    expect(host.textContent).toContain("Cancellation recorded");
    expect(host.textContent).not.toContain("Continue deploy");
    await click("Start a new hire");
    expect(button("Deploy grid agent").disabled).toBe(false);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("reload of an acknowledged cancellation is escapable without another mutation", async () => {
    localStorage.setItem(key, id);
    currentSession = { ...session, cancelRequested: true };
    await deploy();
    expect(localStorage.getItem(key)).toBeNull();
    expect(button("Start a new hire").disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("a rejected cancellation keeps the pointer and a usable retry button", async () => {
    localStorage.setItem(key, id);
    cancelResponse = () => new Response(JSON.stringify({ error: { message: "Please sign again." } }), { status: 401 });
    await deploy();
    await click("Cancel hire safely");
    expect(localStorage.getItem(key)).toBe(id);
    expect(button("Cancel hire safely").disabled).toBe(false);
    expect(host.textContent).toContain("Please sign again.");
    expect(host.textContent).not.toContain("Start a new hire");
  });

  it("the detail Cancel hire signs the exact target and preserves another hire's pointer", async () => {
    localStorage.setItem(key, "grid-agent-other");
    const go = vi.fn();
    await act(async () => { root!.render(<HireRecoveryActions agentId={id} readHeaders={{}} go={go} />); });
    await click("Cancel hire");
    expect(mocks.signEnvelope).toHaveBeenCalledWith("cancelProvisioning", id, {});
    expect(fetchMock).toHaveBeenCalledWith(`/api/agents/${id}/session/cancel`, expect.objectContaining({ method: "POST" }));
    expect(localStorage.getItem(key)).toBe("grid-agent-other");
    expect(host.textContent).toContain("Cancellation recorded");
    await click("Back to deploy");
    expect(go).toHaveBeenCalledWith("/deploy/grid");
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("HTTP success without cancellation acknowledgement does not release the hire", async () => {
    localStorage.setItem(key, id);
    cancelResponse = () => json(session);
    await act(async () => { root!.render(<HireRecoveryActions agentId={id} readHeaders={{}} go={vi.fn()} />); });
    await click("Cancel hire");
    expect(localStorage.getItem(key)).toBe(id);
    expect(host.textContent).toContain("Cancellation is not confirmed");
    expect(host.textContent).not.toContain("Back to deploy");
  });

  it("a custom storage key clears only the LP hire pointer", async () => {
    localStorage.setItem(key, "grid-agent-other");
    localStorage.setItem("4lpha:lp-hire:v1", id);
    currentSession = { ...session, cancelRequested: true };
    await act(async () => {
      root!.render(
        <HireRecoveryActions
          agentId={id}
          readHeaders={{}}
          go={vi.fn()}
          storageKey="4lpha:lp-hire:v1"
        />,
      );
    });
    expect(localStorage.getItem("4lpha:lp-hire:v1")).toBeNull();
    expect(localStorage.getItem(key)).toBe("grid-agent-other");
  });
});

it("preserves wallet occupancy refusal and links the blocking Trading agent without polling a nonexistent Grid", async () => {
  nextProvision = Promise.resolve(new Response(JSON.stringify({ error: { code: "wallet_in_use", message: 'Remove Trading Agent "trading-agent-01" before deploying Grid Agent.' } }), { status: 409, headers: { "content-type": "application/json" } }));
  await deploy();
  await click("Deploy grid agent");
  expect(host.textContent).toContain('Remove Trading Agent "trading-agent-01" before deploying Grid Agent.');
  expect(host.querySelector('a[href="/account/trading-agent-01"]')?.textContent).toBe("Open agent");
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/session") && init?.method !== "POST")).toHaveLength(0);
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.arm).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBeNull();
});

it("does not reinterpret unrelated 409 errors as an existing agent", async () => {
  nextProvision = Promise.resolve(new Response(JSON.stringify({ error: { code: "conflict", message: "Hire temporarily unavailable." } }), { status: 409, headers: { "content-type": "application/json" } }));
  await deploy();
  await click("Deploy grid agent");
  expect(host.textContent).toContain("Hire temporarily unavailable.");
  expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/session") && init?.method !== "POST")).toHaveLength(0);
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("increments the suffix when another owner holds the global agent id", async () => {
  let provisionCalls = 0;
  let choicesAtArm: string | null = null;
  let armed: HireSessionView = { ...session, status: "armed", missing: [], hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "30000000000000000" } };
  mocks.grant.mockImplementation(async () => { currentSession = armed; return {}; });
  mocks.arm.mockImplementation(async (input: { readonly provisionEnvelope?: unknown }) => {
    choicesAtArm = localStorage.getItem(GRID_HIRE_CHOICES_STORAGE_KEY);
    expect(input.provisionEnvelope).toBeDefined();
    return {};
  });
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) return json(preview("1000"));
    if (url === "/api/account/session") return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    if (url.endsWith("/session") && init?.method === "POST") {
      provisionCalls += 1;
      if (provisionCalls === 1) return new Response(JSON.stringify({ error: { code: "agent_exists" }, meta: { owned: false } }), { status: 409 });
      const body = JSON.parse(String(init.body)) as { readonly params?: { readonly armPlan?: { readonly digest?: string } } };
      const signedPlan = body.params?.armPlan;
      armed = { ...armed, ...(signedPlan?.digest === undefined ? {} : { armPlan: { digest: signedPlan.digest as `0x${string}`, kind: "grid", claim: null } }) };
      currentSession = { ...session, armPlan: armed.armPlan };
      return json({ ...currentSession, readSession: { expiry: Math.floor(Date.now() / 1_000) + 900 } });
    }
    if (url.endsWith("/session")) {
      return json(currentSession);
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  await deploy();
  await click("Deploy grid agent");
  await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
  expect(mocks.signEnvelope.mock.calls.filter(([action]) => action === "provisionAgent").map(([, agentId]) => agentId))
    .toEqual(["grid-agent-01-3", "grid-agent-01-3-2"]);
  const choices = JSON.parse(choicesAtArm ?? "null") as Record<string, unknown>;
  expect(choices).toMatchObject({
    version: 1, agentId: "grid-agent-01-3-2", uiPresetId: "balanced", capitalBnb: "0.03",
    utilizationPct: 30, maxRequotesDaily: 16, takeProfitPct: 0, stopLossPct: 0,
  });
  expect(choices.provisionEnvelope).toBeDefined();
  expect(gridLedger()).toEqual(["provisionAgent", "provisionAgent", "grant"]);
  console.info(`HIRE_SIGNATURES_LEDGER grid collision: ${JSON.stringify(["provisionAgent(id)", "provisionAgent(id-2)", "grant"])}`);
  expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/agents")).toBe(false);
  expect(mocks.arm).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("not_found");
});

it("restores a matching choice snapshot before polling and does not auto-continue without a pool", async () => {
  localStorage.setItem(key, id);
  const choices = { version: 1, agentId: id, uiPresetId: "balanced", capitalBnb: "0.0971", utilizationPct: 50, maxRequotesDaily: 4, takeProfitPct: 0, stopLossPct: 0 };
  localStorage.setItem(GRID_HIRE_CHOICES_STORAGE_KEY, JSON.stringify(choices));
  currentSession = { status: "armed", hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "97100000000000000" } };
  const restored = vi.fn();
  await deploy({ pool: null, onRestoreChoices: restored });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(restored).toHaveBeenCalledWith(choices);
  expect(mocks.arm).not.toHaveBeenCalled();
});

it("does not restore or auto-continue a snapshot for another agent", async () => {
  localStorage.setItem(key, id);
  localStorage.setItem(GRID_HIRE_CHOICES_STORAGE_KEY, JSON.stringify({
    version: 1, agentId: "another-agent", uiPresetId: "balanced", capitalBnb: "0.0971", utilizationPct: 50, maxRequotesDaily: 4, takeProfitPct: 0, stopLossPct: 0,
  }));
  currentSession = { status: "armed", hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "97100000000000000" } };
  const restored = vi.fn();
  await deploy({ onRestoreChoices: restored });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(restored).not.toHaveBeenCalled();
  expect(mocks.arm).not.toHaveBeenCalled();
});

it("refuses capital above the immutable hire budget before armGridAgent", async () => {
  localStorage.setItem(key, id);
  currentSession = { status: "armed", hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "20000000000000000" } };
  await deploy();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await click("Arm the grid");
  expect(mocks.arm).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Total capital 0.03 BNB exceeds this hire's budget of 0.02 BNB. Lower it to that amount, or cancel this hire and start again.");
});

it("persists a proven rollback fallback and signs the arm on the next press", async () => {
  localStorage.setItem(key, id);
  localStorage.setItem(GRID_HIRE_CHOICES_STORAGE_KEY, JSON.stringify({
    version: 1, agentId: id, uiPresetId: "balanced", capitalBnb: "0.03",
    utilizationPct: 30, maxRequotesDaily: 16, takeProfitPct: 0, stopLossPct: 0,
  }));
  currentSession = {
    ...session,
    status: "armed",
    missing: [],
    hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "30000000000000000" },
    armPlan: { digest: `0x${"44".repeat(32)}`, kind: "grid", claim: {
      by: "continuation", claimedAtSec: 100, outcome: { status: "rolled-back", message: "safe rollback", atSec: 101 },
    } },
  };
  mocks.arm.mockImplementation(async (input: { readonly signEnvelope: (action: string, agentId: string, params: Record<string, unknown>) => Promise<unknown> }) => {
    await input.signEnvelope("gridArm", id, {});
    return {};
  });
  await deploy();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await click("Arm the grid");
  expect(host.textContent).toContain("safe rollback");
  expect(JSON.parse(localStorage.getItem(GRID_HIRE_CHOICES_STORAGE_KEY) ?? "{}")).toMatchObject({ armPlanFallback: "signed" });
  await click("Arm the grid with a signature");
  expect(mocks.signEnvelope).toHaveBeenCalledWith("gridArm", id, {});
});

it("cancels a scoped Trading draft, clears only its JSON pointer and returns to Trading", async () => {
  const tradeKey = "4lpha:trade-hire:v2";
  const scoped = tradeKey + ":owner:" + mocks.owner.ownerAddress;
  const other = tradeKey + ":owner:0x9999999999999999999999999999999999999999";
  localStorage.setItem("4lpha:account-hire-scoped:v1", "1");
  localStorage.setItem(scoped, JSON.stringify({ agentId: id }));
  localStorage.setItem(other, JSON.stringify({ agentId: id }));
  const go = vi.fn();
  await act(async () => { root!.render(<HireRecoveryActions agentId={id} readHeaders={{}} go={go} storageKey={tradeKey} deployPath="/deploy/trading" />); });
  expect(mocks.signEnvelope).not.toHaveBeenCalled();
  await click("Cancel hire");
  expect(mocks.signEnvelope).toHaveBeenCalledWith("cancelProvisioning", id, {});
  expect(localStorage.getItem(scoped)).toBeNull();
  expect(localStorage.getItem(other)).not.toBeNull();
  expect(mocks.grant).not.toHaveBeenCalled();
  await click("Back to deploy");
  expect(go).toHaveBeenCalledWith("/deploy/trading");
});

it("notifies Account only after confirmed cancellation, including a page reload", async () => {
  const onCancelled = vi.fn();
  await act(async () => { root!.render(<HireRecoveryActions agentId={id} readHeaders={{}} go={vi.fn()} onCancelled={onCancelled} />); });
  expect(onCancelled).not.toHaveBeenCalled();
  cancelResponse = () => json(session);
  await click("Cancel hire");
  expect(onCancelled).not.toHaveBeenCalled();
  cancelResponse = () => json({ ...session, cancelRequested: true });
  await click("Cancel hire");
  expect(onCancelled).toHaveBeenCalledWith(id);
  onCancelled.mockClear();
  currentSession = { ...session, cancelRequested: true };
  await act(async () => { root!.render(<HireRecoveryActions key="reload" agentId={id} readHeaders={{}} go={vi.fn()} onCancelled={onCancelled} />); });
  expect(onCancelled).toHaveBeenCalledWith(id);
});

function signedTarget(init: RequestInit | undefined): string | null {
  const header = new Headers(init?.headers).get("x-owner-action");
  if (header === null) return null;
  const padded = header.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - header.length % 4) % 4);
  const envelope = JSON.parse(atob(padded)) as { signed?: { agentId?: unknown } };
  return typeof envelope.signed?.agentId === "string" ? envelope.signed.agentId : null;
}

function gridLedger(): string[] {
  const entries = mocks.signEnvelope.mock.calls.map((call, index) => ({
    order: mocks.signEnvelope.mock.invocationCallOrder[index]!,
    label: call[0] === "read" ? `read(${String(call[1])})` : String(call[0]),
  }));
  entries.push(...mocks.grant.mock.invocationCallOrder.map((order) => ({ order, label: "grant" })));
  return entries.sort((a, b) => a.order - b.order).map((entry) => entry.label);
}

async function runGridLedger(scenario: {
  readonly issuer: "cookie" | "hidden";
  readonly rememberedExpiryMs?: number;
  readonly fundingWait?: boolean;
}): Promise<string[]> {
  const agentId = "grid-agent-01-3";
  if (scenario.rememberedExpiryMs !== undefined) {
    localStorage.setItem("4lpha:account-read-expiry:v1", String(scenario.rememberedExpiryMs));
  }
  let previewReads = 0;
  currentSession = session;
  let armed: HireSessionView = {
    ...session,
    status: "armed",
    missing: [],
    hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "30000000000000000" },
  };
  mocks.grant.mockImplementation(async () => { currentSession = armed; return {}; });
  mocks.arm.mockImplementation(async (input: { readonly signEnvelope: (action: string, agentId: string, params: Record<string, unknown>) => Promise<unknown>; readonly provisionEnvelope?: unknown }) => {
    if (input.provisionEnvelope === undefined) await input.signEnvelope("gridArm", agentId, {});
    return {};
  });
  fetchMock.mockImplementation(async (request, init) => {
    const url = String(request);
    if (url.includes("/hire/preview")) {
      previewReads += 1;
      const balance = scenario.fundingWait && previewReads < 3
        ? "0" : scenario.fundingWait ? "100000000000000" : "1000";
      return json(preview(balance));
    }
    if (url === "/api/account/session") {
      return scenario.issuer === "cookie"
        ? json({ expiry: Math.floor(Date.now() / 1_000) + 900 })
        : new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }
    if (url.endsWith("/session") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { readonly params?: { readonly armPlan?: { readonly digest?: string } } };
      const signedPlan = body.params?.armPlan;
      if (signedPlan?.digest !== undefined) {
        armed = { ...armed, armPlan: { digest: signedPlan.digest as `0x${string}`, kind: "grid", claim: null } };
        currentSession = { ...session, armPlan: armed.armPlan };
        return scenario.issuer === "cookie"
          ? json({ ...currentSession, readSession: { expiry: Math.floor(Date.now() / 1_000) + 900 } })
          : json(currentSession);
      }
      return json(currentSession);
    }
    if (url.endsWith("/session")) return json(currentSession);
    throw new Error(`Unexpected URL ${url}`);
  });
  await deploy();
  await act(async () => {
    button("Deploy grid agent").click();
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
  if (scenario.fundingWait) {
    await act(async () => { await vi.advanceTimersByTimeAsync(6_001); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  } else {
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  }
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
  }
  return gridLedger();
}

describe("HIRE-SIGNATURES-BC grid prompt ledger", () => {
  it("records the funded cookie ledger and uses the provision-issued read window", async () => {
    const observed = await runGridLedger({ issuer: "cookie" });
    expect(observed).toEqual(["provisionAgent", "grant"]);
    const list = fetchMock.mock.calls.find(([url]) => String(url) === "/api/agents");
    expect(list).toBeUndefined();
    const sessions = fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith("/api/agents/")
      && String(url).endsWith("/session") && init?.method !== "POST");
    expect(sessions.every(([, init]) => new Headers(init?.headers).get("x-owner-action") === null)).toBe(true);
    expect(mocks.signReadHeader).not.toHaveBeenCalled();
    console.info(`HIRE_SIGNATURES_LEDGER grid funded: ${JSON.stringify(observed)}`);
  });

  it("records the warm cookie ledger with no read-session signature", async () => {
    const observed = await runGridLedger({ issuer: "cookie", rememberedExpiryMs: Date.now() + 1_800_000 });
    expect(observed).toEqual(["provisionAgent", "grant"]);
    expect(mocks.signEnvelope).not.toHaveBeenCalledWith("createAccountReadSession", "*", {});
    console.info(`HIRE_SIGNATURES_LEDGER grid warm: ${JSON.stringify(observed)}`);
  });

  it("uses the signed per-agent read fallback when the issuer is hidden", async () => {
    const observed = await runGridLedger({ issuer: "hidden" });
    expect(observed).toEqual(["provisionAgent", "createAccountReadSession", `read(${id})`, "grant"]);
    const list = fetchMock.mock.calls.find(([url]) => String(url) === "/api/agents");
    expect(list).toBeUndefined();
    const sessions = fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith("/api/agents/")
      && String(url).endsWith("/session") && init?.method !== "POST");
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every(([, init]) => signedTarget(init) === id)).toBe(true);
    expect(mocks.signReadHeader).not.toHaveBeenCalled();
    console.info(`HIRE_SIGNATURES_LEDGER grid hidden-issuer: ${JSON.stringify(observed)}`);
  });

  it("treats remembered expiry at exactly 60 seconds as cold", async () => {
    const observed = await runGridLedger({ issuer: "cookie", rememberedExpiryMs: Date.now() + 60_000 });
    expect(observed).toEqual(["provisionAgent", "grant"]);
    expect(mocks.signEnvelope.mock.calls.filter(([action]) => action === "createAccountReadSession")).toHaveLength(0);
  });

  it("keeps the provision-issued read window after a remembered cookie", async () => {
    const observed = await runGridLedger({ issuer: "cookie", rememberedExpiryMs: Date.now() + 1_800_000 });
    expect(observed).toEqual(["provisionAgent", "grant"]);
    expect(mocks.signEnvelope.mock.calls.filter(([action]) => action === "createAccountReadSession")).toHaveLength(0);
  });

  it("does not read the owner list before signing a new hire", async () => {
    const observed = await runGridLedger({ issuer: "cookie" });
    expect(observed[0]).toBe("provisionAgent");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/agents")).toBe(false);
    expect(mocks.signReadHeader).not.toHaveBeenCalled();
  });

  it("keeps one credential across funding expiry and renews before grid convergence", async () => {
    const observed = await runGridLedger({ issuer: "cookie", rememberedExpiryMs: Date.now() + 66_000, fundingWait: true });
    expect(observed).toEqual(["provisionAgent", "grant"]);
    console.info(`HIRE_SIGNATURES_LEDGER grid cold-short: ${JSON.stringify(["provisionAgent", "<MetaMask deposit>", "grant"])}`);
  });

  it("resumes a same-owner collision without provisioning a numbered replacement", async () => {
    const agentId = "grid-agent-01-3";
    let posts = 0;
    currentSession = session;
    const armed: HireSessionView = { ...session, status: "armed", missing: [], hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "30000000000000000" } };
    mocks.grant.mockImplementation(async () => { currentSession = armed; return {}; });
    mocks.arm.mockImplementation(async (input: { readonly signEnvelope: (action: string, agentId: string, params: Record<string, unknown>) => Promise<unknown> }) => {
      await input.signEnvelope("gridArm", agentId, {});
      return {};
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/hire/preview")) return json(preview("1000"));
      if (url === "/api/account/session") return json({ expiry: Math.floor(Date.now() / 1_000) + 900 });
      if (url === "/api/agents") return json({ agents: [] });
      if (url.endsWith("/session") && init?.method === "POST") {
        posts += 1;
        return posts === 1
          ? new Response(JSON.stringify({ error: { code: "agent_exists" }, data: armed, meta: { owned: true } }), { status: 409 })
          : json(currentSession);
      }
      if (url.endsWith("/session")) return json(currentSession);
      throw new Error(`Unexpected URL ${url}`);
    });
    await deploy();
    await act(async () => { button("Deploy grid agent").click(); await vi.advanceTimersByTimeAsync(5_001); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(posts).toBe(1);
    expect(mocks.signEnvelope.mock.calls.filter(([action]) => action === "provisionAgent")).toHaveLength(1);
    expect(gridLedger()).toEqual(["provisionAgent", "gridArm"]);
    expect(host.textContent).not.toContain("Every candidate name");
  });

  it("does not need a read-session signature after a fresh provision", async () => {
    const observed = await runGridLedger({ issuer: "cookie" });
    expect(observed[0]).toBe("provisionAgent");
    expect(mocks.signEnvelope.mock.calls.some(([action]) => action === "createAccountReadSession" || action === "read")).toBe(false);
  });
});

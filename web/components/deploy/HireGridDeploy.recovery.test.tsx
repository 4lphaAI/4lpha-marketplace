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
vi.mock("./GridLiveDeploy", () => ({ armGridAgent: mocks.arm, GridDeployActions: () => null }));

import { HireGridDeploy } from "./HireGridDeploy";
import { HireRecoveryActions } from "./HireRecoveryActions";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  mocks.signReadHeader.mockResolvedValue("signed-read");
  mocks.signEnvelope.mockImplementation(async (action: string, agentId: string, params: unknown) => ({ signed: { action, agentId }, signature: "0xsignature", params }));
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
async function deploy() {
  await act(async () => { root!.render(<HireGridDeploy mode="Live" agentName="Grid agent 01 3" uiPresetId="balanced"
    pool={{ pool: "0x4444444444444444444444444444444444444444", token0: "0x5555555555555555555555555555555555555555", token1: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", wbnbIsToken0: false } as React.ComponentProps<typeof HireGridDeploy>["pool"]}
    capitalBnb="0.03" takeProfitPct={0} stopLossPct={0} go={vi.fn()} />); });
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
      hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "100" },
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
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
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
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) return json(preview("100"));
    if (url === "/api/agents") return json({ agents: [] });
    if (url.endsWith("/session") && init?.method === "POST") {
      provisionCalls += 1;
      return provisionCalls === 1
        ? new Response(JSON.stringify({ error: { code: "agent_exists" } }), { status: 409 })
        : json({ ...session, status: "armed", hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "100" } });
    }
    if (url.endsWith("/session")) {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  await deploy();
  await click("Deploy grid agent");
  expect(mocks.signEnvelope.mock.calls.filter(([action]) => action === "provisionAgent").map(([, agentId]) => agentId))
    .toEqual(["grid-agent-01-3", "grid-agent-01-3-2"]);
  expect(mocks.arm).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("not_found");
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

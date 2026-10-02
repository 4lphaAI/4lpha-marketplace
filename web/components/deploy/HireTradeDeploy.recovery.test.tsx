// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paramsHash, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { TradeSettings } from "@/lib/trade";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  signEnvelope: vi.fn(),
  executeCmcBudgetCalls: vi.fn(async (): Promise<{ readonly status: "CONFIRMED" | "PENDING" | "FAILED"; readonly callsId: `0x${string}` }> =>
    ({ status: "CONFIRMED", callsId: `0x${"44".repeat(32)}` })),
  validateCmcBudgetCallPlan: vi.fn(() => []),
  owner: {
    passkey: {},
    walletAddress: "0x1111111111111111111111111111111111111111",
    ownerAddress: "0x2222222222222222222222222222222222222222",
  },
}));

vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock("@/lib/exec/use-owner-actions", () => ({
  useOwnerActions: () => ({ ...mocks.owner, signEnvelope: mocks.signEnvelope }),
}));
vi.mock("@/lib/altana/client", () => ({
  grantAgentSession: mocks.grant,
  GrantAgentSessionError: class extends Error {},
}));
vi.mock("@/lib/altana/cmc-budget", () => ({
  executeCmcBudgetCalls: mocks.executeCmcBudgetCalls,
  validateCmcBudgetCallPlan: mocks.validateCmcBudgetCallPlan,
}));
vi.mock("@/components/FundsModal", () => ({
  FundsModal: ({ onClose, onDepositSubmitted }: { readonly onClose: () => void; readonly onDepositSubmitted?: (hash: string) => void }) => <>
    <button onClick={onClose}>Close deposit</button>
    <button onClick={() => onDepositSubmitted?.("0xdeposit")}>Submit deposit</button>
  </>,
}));

import { HireTradeDeploy } from "./HireTradeDeploy";
import { DEPLOYED_HOLD_MS } from "./DeployRunModal";

const storageKey = "4lpha:trade-hire:v2";
const hireRunId = "11111111-1111-4111-8111-111111111111";
const settings: TradeSettings = {
  name: "Trading Agent",
  executionModel: "sigma",
  entryWei: "2000000000000000",
  maxOpenPositions: 3,
  minMarketCapUsd: null,
  maxMarketCapUsd: null,
  noReentry: true,
  takeProfitBps: null,
  stopLossBps: null,
  maxHoldSec: 7_200,
  breakEvenAfterTp: true,
  slippageBps: 300,
  gasPriority: "standard",
  instructions: null,
  skillMarkdown: null,
  primaryModel: "0gm-1.0-35b-a3b",
  fallbackModel: "qwen3-vl-30b",
};
const params = {
  walletAddress: mocks.owner.walletAddress,
  capDayWei: "10000000000000000",
  ttlSec: 604_800,
  sizingPreset: "trade-v1",
  executionModel: "sigma",
  hireRunId,
  autoGrant: true,
  settings,
} as const;

function envelope(agentId: string, envelopeParams: typeof params = params): OwnerActionEnvelope {
  return {
    signed: {
      owner: mocks.owner.ownerAddress,
      action: "provisionAgent",
      agentId,
      paramsHash: paramsHash("provisionAgent", envelopeParams),
      nonce: `0x${"44".repeat(32)}`,
      issuedAt: "1",
      expiry: "9999999999",
    },
    signature: "0xsignature",
    params: envelopeParams,
  } as OwnerActionEnvelope;
}

function preview(balanceWei = "0") {
  return {
    capDayWei: params.capDayWei,
    sizing: {
      name: "trade-v1", version: 1, openNativeBudgetWei: "0", executionModel: "sigma",
      entryWei: settings.entryWei, maxOpenPositions: 3, grantedTokenCount: 1,
      platformFeeBps: 0, platformFeePerEntryWei: "0", platformFeeTotalWei: "0",
      tradeRelayFeePerSubmitWei: "100000000000000", capitalRequiredWei: "2500000000000000",
      capitalShortfallWei: "0", ok: true,
    },
    funding: {
      version: 1, observedAtSec: Math.floor(Date.now() / 1_000), registrationFeeWei: "2",
      registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei,
    },
    pin: [{ symbol: "ONE", address: "0x3333333333333333333333333333333333333333" }],
    indicative: true,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let host: HTMLDivElement;
let root: Root | null;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  mocks.grant.mockResolvedValue({});
  mocks.signEnvelope.mockImplementation(async (_action: string, agentId: string, signedParams: typeof params) =>
    envelope(agentId, signedParams));
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) return response(preview());
    if (url.endsWith("/session") && init?.method === "POST") {
      const submitted = JSON.parse(String(init.body)) as OwnerActionEnvelope;
      return response({ status: "provisioning", hireRunId: (submitted.params as typeof params).hireRunId,
        missing: ["account-key", "keystore-id"], permissions: { calls: [], spend: [] },
        sessionPublicKey: `0x${"33".repeat(65)}`, sessionAddress: "0x3333333333333333333333333333333333333333",
        expiresAt: 9_999_999_999 });
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

async function render(go = vi.fn()) {
  await act(async () => {
    root!.render(<HireTradeDeploy agentName={settings.name} executionModel="sigma"
      capitalBnb="0.01" settings={settings} go={go} />);
  });
  await act(async () => { await Promise.resolve(); });
  return go;
}

async function renderStrict(go = vi.fn()) {
  await act(async () => {
    root!.render(<React.StrictMode>
      <HireTradeDeploy agentName={settings.name} executionModel="sigma"
        capitalBnb="0.01" settings={settings} go={go} />
    </React.StrictMode>);
  });
  await act(async () => { await Promise.resolve(); });
  return go;
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (found === undefined) throw new Error(`Button ${label} not found: ${host.textContent}`);
  return found;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

/** Success holds "Agent deployed" on screen before navigating (DEPLOYED_HOLD_MS). */
async function settleDeployedHold(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(DEPLOYED_HOLD_MS); });
}

async function runTradeLedger(balances: readonly string[]): Promise<string[]> {
  let previewReads = 0;
  let sessionView: Record<string, unknown> = {
    status: "provisioning",
    hireRunId,
    missing: ["account-key", "keystore-id"],
    permissions: { calls: [], spend: [] },
    sessionPublicKey: `0x${"33".repeat(65)}`,
    sessionAddress: "0x3333333333333333333333333333333333333333",
    expiresAt: 9_999_999_999,
  };
  mocks.grant.mockImplementation(async () => {
    sessionView = { ...sessionView, status: "armed", missing: [] };
    return {};
  });
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/hire/preview")) {
      const balance = balances[Math.min(previewReads++, balances.length - 1)] ?? "0";
      return response(preview(balance));
    }
    if (url.endsWith("/session/grant-attempt") && init?.method === "POST") {
      sessionView = { ...sessionView, grantAttempt: { version: 1, attemptId: `0x${"55".repeat(32)}`, startedAtSec: 100 } };
      return response({ ...sessionView, attemptId: `0x${"55".repeat(32)}`, mayInvoke: true });
    }
    if (url.endsWith("/session") && init?.method === "POST") {
      const submitted = JSON.parse(String(init.body)) as OwnerActionEnvelope;
      sessionView = { ...sessionView, hireRunId: (submitted.params as typeof params).hireRunId };
      return response({ ...sessionView, readSession: { expiry: Math.floor(Date.now() / 1_000) + 900 } });
    }
    if (url.endsWith("/session")) return response(sessionView);
    throw new Error(`Unexpected URL ${url}`);
  });
  await render();
  await act(async () => { button("Sign hire and create the session key").click(); await vi.advanceTimersByTimeAsync(0); });
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
  if (balances[0] === "0") {
    await act(async () => { await vi.advanceTimersByTimeAsync(6_001); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  } else {
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  }
  await flush();
  const entries = mocks.signEnvelope.mock.calls.map((call, index) => ({ order: mocks.signEnvelope.mock.invocationCallOrder[index]!, label: String(call[0]) }));
  entries.push(...mocks.grant.mock.invocationCallOrder.map((order) => ({ order, label: "grant" })));
  return entries.sort((left, right) => left.order - right.order).map((entry) => entry.label);
}

describe("Trading one-press recovery", () => {
  it("HIRE-SIGNATURES-BC records the funded trade ledger", async () => {
    const observed = await runTradeLedger(["100000000000000000000"]);
    expect(observed).toEqual(["provisionAgent", "grant"]);
    console.info(`HIRE_SIGNATURES_LEDGER trade funded: ${JSON.stringify(observed)}`);
  });

  it("HIRE-SIGNATURES-BC records the short trade ledger with a wallet deposit", async () => {
    const observed = await runTradeLedger(["0", "0", "100000000000000000000"]);
    expect(observed).toEqual(["provisionAgent", "grant"]);
    console.info(`HIRE_SIGNATURES_LEDGER trade cold-short: ${JSON.stringify(["provisionAgent", "<MetaMask deposit>", "grant"])}`);
  });

  it("does not resume another account's pointer after switching", async () => {
    localStorage.setItem("4lpha:account-hire-scoped:v1", "1");
    localStorage.setItem(`${storageKey}:owner:0x3333333333333333333333333333333333333333`, JSON.stringify({ version: 2, agentId: "foreign-agent", hireRunId, provisionEnvelope: envelope("foreign-agent") }));
    fetchMock.mockImplementation(async () => response(preview()));
    await render(); await flush();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("foreign-agent") || init?.method === "POST")).toBe(false);
    expect(mocks.signEnvelope).not.toHaveBeenCalled(); expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("shows a returned account's saved hire but requires explicit Continue", async () => {
    localStorage.setItem("4lpha:account-hire-scoped:v1", "1");
    localStorage.setItem(`${storageKey}:owner:${mocks.owner.ownerAddress}`, JSON.stringify({ version: 2, agentId: "trading-agent", hireRunId, provisionEnvelope: envelope("trading-agent") }));
    fetchMock.mockImplementation(async () => response(preview()));
    await render(); await flush();
    expect(host.textContent).toContain("Continue deploy");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(mocks.signEnvelope).not.toHaveBeenCalled(); expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("rejects a foreign signed legacy hire before POST or continuation read", async () => {
    const foreign = envelope("foreign-agent");
    localStorage.setItem(storageKey, JSON.stringify({ version: 2, agentId: "foreign-agent", hireRunId, provisionEnvelope: { ...foreign, signed: { ...foreign.signed, owner: "0x3333333333333333333333333333333333333333" } } }));
    fetchMock.mockImplementation(async () => response(preview()));
    await render(); await flush();
    expect(host.textContent).toContain("another account");
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("foreign-agent") || init?.method === "POST")).toBe(false);
  });
  it("restarts the exact saved S1 after the Strict Mode synthetic cleanup", async () => {
    const saved = { version: 2, agentId: "trading-agent", hireRunId,
      provisionEnvelope: envelope("trading-agent") } as const;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/hire/preview")) return response(preview());
      if (String(input).endsWith("/trading-agent/session") && init?.method === "POST") {
        return response({ status: "armed", hireRunId });
      }
      throw new Error(`Unexpected URL ${String(input)}`);
    });
    const go = await renderStrict(vi.fn());
    await flush();
    const posts = fetchMock.mock.calls.filter(([input, init]) =>
      String(input).endsWith("/trading-agent/session") && init?.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const [, init] of posts) expect(String(init?.body)).toBe(JSON.stringify(saved.provisionEnvelope));
    // The popup stops on "Agent deployed" first, then moves to the agent page by itself.
    expect(go).not.toHaveBeenCalled();
    expect(document.body.querySelector("[role='dialog']")?.getAttribute("aria-label")).toBe("Agent deployed");
    await settleDeployedHold();
    expect(go).toHaveBeenCalledWith("/account/trading-agent");
    expect(host.textContent).not.toContain("Resuming the exact signed hire…");
  });

  it("ignores a detached run response that resolves after its Strict Mode replacement", async () => {
    const saved = { version: 2, agentId: "trading-agent", hireRunId,
      provisionEnvelope: envelope("trading-agent") } as const;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    let resolveFirst = (_response: Response): void => {};
    let postCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/hire/preview")) return response(preview());
      if (String(input).endsWith("/trading-agent/session") && init?.method === "POST") {
        postCount += 1;
        if (postCount === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; });
        return response({ status: "armed", hireRunId });
      }
      throw new Error(`Unexpected URL ${String(input)}`);
    });
    const go = await render(vi.fn());
    await flush();
    expect(postCount).toBe(1);
    await act(async () => { root!.render(null); });
    await renderStrict(go);
    await flush();
    await settleDeployedHold();
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("/account/trading-agent");
    await act(async () => { resolveFirst(response({ status: "provisioning", hireRunId })); });
    await flush();
    const posts = fetchMock.mock.calls.filter(([input, init]) =>
      String(input).endsWith("/trading-agent/session") && init?.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of posts) expect(String(init?.body)).toBe(JSON.stringify(saved.provisionEnvelope));
    expect(go).toHaveBeenCalledTimes(1);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("does not let a detached 410 response erase its replacement run pointer", async () => {
    const saved = { version: 2, agentId: "trading-agent", hireRunId,
      provisionEnvelope: envelope("trading-agent") } as const;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    let resolveFirst = (_response: Response): void => {};
    let resolveSecond = (_response: Response): void => {};
    let postCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/hire/preview")) return response(preview());
      if (String(input).endsWith("/trading-agent/session") && init?.method === "POST") {
        postCount += 1;
        return new Promise<Response>((resolve) => {
          if (postCount === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        });
      }
      throw new Error(`Unexpected URL ${String(input)}`);
    });
    const go = await render(vi.fn());
    await flush();
    expect(postCount).toBe(1);
    await act(async () => { root!.render(null); });
    await render(go);
    await flush();
    expect(postCount).toBe(2);

    await act(async () => { resolveFirst(response({ code: "hire_no_evidence" }, 410)); });
    await flush();
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(saved));
    expect(host.textContent).toContain("Resuming the exact signed hire…");
    expect(go).not.toHaveBeenCalled();

    await act(async () => { resolveSecond(response({ status: "armed", hireRunId })); });
    await flush();
    await settleDeployedHold();
    expect(go).toHaveBeenCalledWith("/account/trading-agent");
  });

  it("keeps pin data for validation without rendering the full address list", async () => {
    await render();
    await flush();
    expect(host.textContent).not.toContain("Indicative pinned tokens");
    expect(host.textContent).not.toContain("0x3333");
    expect(host.textContent).toContain("Capital floor:");
  });

  it("fails closed without crashing when a running execution plane returns the old preview schema", async () => {
    const old = preview();
    const { capitalRequiredWei: _required, capitalShortfallWei: _shortfall, ...oldSizing } = old.sizing;
    fetchMock.mockResolvedValue(response({
      ...old,
      sizing: { ...oldSizing, requiredWei: "2500000000000000", shortfallWei: "0", minimumCapDayWei: "10000000000000000" },
    }));
    await render();
    await flush();
    expect(host.textContent).toContain("Restart or update the execution plane");
    expect(button("Sign hire and create the session key").disabled).toBe(true);
    expect(mocks.signEnvelope).not.toHaveBeenCalled();
  });

  it("fails closed on malformed preview wei instead of passing it to BigInt", async () => {
    const malformed = preview();
    fetchMock.mockResolvedValue(response({
      ...malformed,
      sizing: { ...malformed.sizing, capitalRequiredWei: "not-wei" },
    }));
    await render();
    await flush();
    expect(host.textContent).toContain("Restart or update the execution plane");
    expect(button("Sign hire and create the session key").disabled).toBe(true);
  });

  it("uses the same fail-closed state when a successful preview is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("not-json", { status: 200 }));
    await render();
    await flush();
    expect(host.textContent).toContain("Restart or update the execution plane");
    expect(button("Sign hire and create the session key").disabled).toBe(true);
  });

  it("lets a fresh actual-fee preview relax the conservative 500 bps preflight", async () => {
    const feeSensitive = { ...settings, entryWei: "3000000000000000" };
    fetchMock.mockImplementation(async (input) => {
      if (!String(input).includes("/hire/preview")) throw new Error(`Unexpected URL ${String(input)}`);
      const result = preview();
      return response({ ...result, sizing: { ...result.sizing, entryWei: feeSensitive.entryWei,
        capitalRequiredWei: "9500000000000000", ok: true } });
    });
    await act(async () => {
      root!.render(<HireTradeDeploy agentName={feeSensitive.name} executionModel="sigma"
        capitalBnb="0.01" settings={feeSensitive} go={vi.fn()} />);
    });
    await flush();
    expect(button("Sign hire and create the session key").disabled).toBe(false);
  });

  it("stops the run when the owner closes funding and never claims or invokes a hidden grant", async () => {
    await render();
    await act(async () => { button("Sign hire and create the session key").click(); });
    await flush();
    expect(button("Close deposit")).toBeDefined();
    await act(async () => { button("Close deposit").click(); });
    await flush();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/grant-attempt"))).toBe(false);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(button("Continue deploy").disabled).toBe(false);
  });

  it("closes the deposit prompt once sent, keeps waiting, and the popup's Stop ends the run without a grant", async () => {
    await render();
    await act(async () => { button("Sign hire and create the session key").click(); });
    await flush();
    const inBody = (label: string): HTMLButtonElement | undefined =>
      [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
    // No stop across the passkey prompts; the deposit prompt owns the screen.
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
    await act(async () => { button("Submit deposit").click(); });
    await flush();
    expect(inBody("Submit deposit")).toBeUndefined();
    const dialog = document.body.querySelector("[role='dialog']");
    expect(dialog?.getAttribute("aria-label")).toBe("Deploying Trading Agent");
    expect(dialog?.textContent).toContain("Deposit sent. Waiting for it to land in the agent wallet…");
    // Still polling the balance after the prompt closed.
    const previewsBefore = fetchMock.mock.calls.filter(([input]) => String(input).includes("/hire/preview")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6_001); });
    await flush();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/hire/preview")).length).toBeGreaterThan(previewsBefore);
    await act(async () => { inBody("Stop deploy")!.click(); });
    await flush();
    expect(document.body.querySelector("[role='dialog']")?.getAttribute("aria-label")).toBe("Deploy stopped");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/grant-attempt"))).toBe(false);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(button("Continue deploy").disabled).toBe(false);
  });

  it("bounds an ambiguous S1 request, preserves the exact signed pointer, and invokes no grant", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/hire/preview")) return response(preview());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    await render();
    await act(async () => { button("Sign hire and create the session key").click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    await flush();
    expect(host.textContent).toContain("did not answer in time");
    expect(button("Continue deploy").disabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "null").provisionEnvelope).not.toBeNull();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("clears a signed-before-POST pointer when continuation proves no row landed", async () => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 2, agentId: "trading-agent", hireRunId, provisionEnvelope: envelope("trading-agent"),
    }));
    fetchMock.mockImplementation(async (input) => String(input).includes("/hire/preview")
      ? response(preview())
      : response({ code: "hire_no_evidence" }, 410));
    await render();
    await flush();
    expect(mocks.signEnvelope).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/trading-agent/session")
      && init?.method === "POST")).toBe(true);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(host.textContent).toContain("previous signature expired");
    expect(button("Sign hire and create the session key")).toBeDefined();
  });

  it("renders the backend's exact wallet blocker and falls back safely for an older plane", async () => {
    const saved = { version: 2, agentId: "trading-agent", hireRunId,
      provisionEnvelope: envelope("trading-agent") } as const;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    fetchMock.mockImplementation(async (input) => String(input).includes("/hire/preview")
      ? response(preview())
      : response({ code: "wallet_in_use",
        message: 'Finish removing Grid Agent "still-valid-grid" before deploying Trading Agent.' }, 409));
    const go = await render(vi.fn());
    await flush();
    expect(host.textContent).toContain('Finish removing Grid Agent "still-valid-grid" before deploying Trading Agent.');
    expect(host.textContent).not.toContain("wallet_in_use");
    const blockerLink = host.querySelector<HTMLAnchorElement>('a[href="/account/still-valid-grid"]');
    expect(blockerLink?.textContent).toBe("Open agent");
    await act(async () => { blockerLink?.click(); });
    expect(go).toHaveBeenCalledWith("/account/still-valid-grid");
    expect(button("Continue deploy").disabled).toBe(false);
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(saved));

    fetchMock.mockImplementation(async (input) => String(input).includes("/hire/preview")
      ? response(preview())
      : response({ code: "wallet_in_use" }, 409));
    await act(async () => { button("Continue deploy").click(); });
    await flush();
    expect(host.textContent).toContain("Remove the existing agent before deploying Trading Agent.");
  });

  it("requires an explicit restart for a legacy ambiguous S1 before signing a fresh hire", async () => {
    const saved = { version: 2, agentId: "trading-agent", hireRunId,
      provisionEnvelope: envelope("trading-agent") } as const;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    let sessionPosts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/hire/preview")) return response(preview());
      if (url.endsWith("/trading-agent/session") && init?.method === "POST") {
        sessionPosts += 1;
        if (sessionPosts === 1) return response({ code: "s1_ambiguous" }, 409);
        const submitted = JSON.parse(String(init.body)) as OwnerActionEnvelope;
        return response({ status: "provisioning", hireRunId: (submitted.params as typeof params).hireRunId,
          missing: ["account-key", "keystore-id"], permissions: { calls: [], spend: [] },
          sessionPublicKey: `0x${"33".repeat(65)}`, sessionAddress: "0x3333333333333333333333333333333333333333",
          expiresAt: 9_999_999_999 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    await render();
    await flush();
    expect(mocks.signEnvelope).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(saved));
    expect(host.textContent).toContain("previous signed hire cannot be proven");
    expect(button("Restart hire").disabled).toBe(false);

    await act(async () => { button("Restart hire").click(); });
    await flush();
    expect(mocks.signEnvelope).toHaveBeenCalledTimes(1);
    const fresh = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
      readonly hireRunId: string;
      readonly provisionEnvelope: unknown;
    };
    expect(fresh.hireRunId).not.toBe(hireRunId);
    expect(fresh.provisionEnvelope).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/grant-attempt"))).toBe(false);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("allocates the next suffix after a mismatched persisted candidate and navigates to that exact id", async () => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 2, agentId: "trading-agent", hireRunId, provisionEnvelope: envelope("trading-agent"),
    }));
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/hire/preview")) return response(preview("10000000000000005"));
      if (url.endsWith("/trading-agent/session") && init?.method === "POST") {
        return response({ code: "agent_exists" }, 409);
      }
      if (url.endsWith("/trading-agent/session")) {
        return response({ code: "conflict" }, 409);
      }
      if (url.endsWith("/trading-agent-2/session") && init?.method === "POST") {
        return response({ status: "armed", hireRunId });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const go = await render(vi.fn());
    await flush();
    expect(mocks.signEnvelope).toHaveBeenCalledWith("provisionAgent", "trading-agent-2", params);
    await settleDeployedHold();
    expect(go).toHaveBeenCalledWith("/account/trading-agent-2");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("clears the scoped bearer when cancellation is first observed during convergence polling", async () => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 2, agentId: "trading-agent", hireRunId, provisionEnvelope: envelope("trading-agent"),
    }));
    let continuationReads = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/hire/preview")) return response(preview("10000000000000005"));
      if (url.endsWith("/trading-agent/session")) {
        continuationReads += 1;
        return response({
          status: "provisioning",
          hireRunId,
          grantAttempt: { attemptId: `0x${"55".repeat(32)}` },
          ...(continuationReads === 1 ? {} : { cancelRequested: true }),
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    await render();
    await flush();
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(host.textContent).toContain("This hire cannot continue");
  });
});

// CMC-HIRE-SETUP R5: the provision continuation completes the owner's signed
// CMC opt-in inside the hire run itself, right after the grant, with no second
// owner signature. R-4: a failure anywhere in this step never fails the hire.
describe("Trading one-press recovery — TradFi hire with CMC enabled", () => {
  const tradfiAgentId = "tradfi-cmc-agent";
  const tradfiSessionKey = `0x04${"77".repeat(64)}` as const;
  const tradfiCmcSettings: TradeSettings = {
    name: "TradFi CMC Agent", executionModel: "tradfi", settlementAsset: "USDT",
    entryWei: "20000000000000000000", minEntryWei: "5000000000000000000",
    capitalQuoteWei: "63000000000000000000", cmcNewsEnabled: true, cmcTotalBudgetWei: "2000000000000000000",
    maxOpenPositions: 3, minMarketCapUsd: null, maxMarketCapUsd: null, noReentry: true,
    takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false,
    slippageBps: 300, gasPriority: "standard", instructions: null, skillMarkdown: null,
    primaryModel: "0gm-1.0-35b-a3b", fallbackModel: "qwen3-vl-30b",
  };

  function tradfiCmcPreview(url: string) {
    const capDayWei = new URL(url, "http://localhost").searchParams.get("capDayWei") ?? "0";
    const capitalQuoteWei = tradfiCmcSettings.capitalQuoteWei!;
    const cmcTotalBudgetWei = tradfiCmcSettings.cmcTotalBudgetWei!;
    const quoteRequired = (BigInt(capitalQuoteWei) + BigInt(cmcTotalBudgetWei)).toString();
    return {
      capDayWei,
      sizing: {
        name: "trade-v1", version: 1, openNativeBudgetWei: "0", executionModel: "tradfi",
        entryWei: tradfiCmcSettings.entryWei, maxOpenPositions: tradfiCmcSettings.maxOpenPositions, grantedTokenCount: 6,
        platformFeeBps: 0, platformFeePerEntryWei: "0", platformFeeTotalWei: "0",
        tradeRelayFeePerSubmitWei: "100000000000000",
        capitalRequiredWei: capitalQuoteWei, capitalShortfallWei: "0", ok: true,
        settlementAsset: "USDT", minEntryWei: tradfiCmcSettings.minEntryWei, capitalQuoteWei,
        cmcNewsEnabled: true, cmcTotalBudgetWei,
      },
      funding: {
        version: 1, observedAtSec: Math.floor(Date.now() / 1_000), registrationFeeWei: "2",
        registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei: "999999999999999999999999",
        quoteAsset: "USDT", quoteRequiredWei: quoteRequired, quoteBalanceWei: quoteRequired, quoteShortfallWei: "0",
      },
      pin: [{ symbol: "AAAX", address: "0x3333333333333333333333333333333333333333" }],
      indicative: true,
    };
  }

  function pendingKey(): string {
    return `4lpha:cmc-budget:${mocks.owner.ownerAddress.toLowerCase()}:${mocks.owner.walletAddress.toLowerCase()}:${tradfiAgentId}`;
  }

  /**
   * Drives one TradFi+CMC hire to "armed" and installs the fetch mock for the
   * CMC continuation route triple. `cmc` overrides let each test simulate one
   * failure point without repeating the whole grant/converge plumbing.
   */
  async function runTradfiCmcHire(cmc: {
    readonly prepare?: (body: unknown) => { readonly status: number; readonly body: unknown };
    readonly attempt?: (body: unknown) => { readonly status: number; readonly body: unknown };
    readonly confirm?: (body: unknown) => { readonly status: number; readonly body: unknown };
  } = {}): Promise<{ readonly go: ReturnType<typeof vi.fn>; readonly cmcCalls: readonly { readonly path: string; readonly headers: Record<string, string> | undefined; readonly body: unknown }[] }> {
    let sessionView: Record<string, unknown> = {
      status: "provisioning", hireRunId: "",
      missing: ["account-key", "keystore-id"], permissions: { calls: [], spend: [] },
      sessionPublicKey: tradfiSessionKey, sessionAddress: "0x3333333333333333333333333333333333333333",
      expiresAt: 9_999_999_999,
    };
    mocks.grant.mockImplementation(async () => {
      sessionView = { ...sessionView, status: "armed", missing: [],
        agent: { walletAddress: mocks.owner.walletAddress, session: { publicKey: tradfiSessionKey, expiresAt: 9_999_999_999 } } };
      return {};
    });
    const cmcCalls: { readonly path: string; readonly headers: Record<string, string> | undefined; readonly body: unknown }[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/hire/preview")) return response(tradfiCmcPreview(url));
      if (url.endsWith("/session/grant-attempt") && init?.method === "POST") {
        sessionView = { ...sessionView, grantAttempt: { version: 1, attemptId: `0x${"55".repeat(32)}`, startedAtSec: 100 } };
        return response({ ...sessionView, attemptId: `0x${"55".repeat(32)}`, mayInvoke: true });
      }
      if (url.endsWith("/session") && init?.method === "POST") {
        const submitted = JSON.parse(String(init.body)) as OwnerActionEnvelope;
        sessionView = { ...sessionView, hireRunId: (submitted.params as { readonly hireRunId: string }).hireRunId };
        return response({ ...sessionView, readSession: { expiry: Math.floor(Date.now() / 1_000) + 900 } });
      }
      if (url.endsWith("/session")) return response(sessionView);
      if (url.endsWith("/trade/cmc-budget/confirm") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as unknown;
        cmcCalls.push({ path: "confirm", headers: init.headers as Record<string, string> | undefined, body });
        const result = cmc.confirm?.(body) ?? { status: 200, body: { data: {} } };
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/trade/cmc-budget/attempt") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as unknown;
        cmcCalls.push({ path: "attempt", headers: init.headers as Record<string, string> | undefined, body });
        const result = cmc.attempt?.(body) ?? { status: 200, body: { data: { operationId: "op-1", attemptId: "attempt-1", state: "attempted" } } };
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/trade/cmc-budget") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as unknown;
        cmcCalls.push({ path: "prepare", headers: init.headers as Record<string, string> | undefined, body });
        const result = cmc.prepare?.(body) ?? { status: 200, body: { data: {
          operationId: "op-1", mode: "topup", calls: [], continuationAttemptId: "attempt-1", state: "prepared",
          operation: { operationId: "op-1", mode: "topup", expectedGeneration: 0, incrementWei: tradfiCmcSettings.cmcTotalBudgetWei,
            sessionPublicKey: tradfiSessionKey, sessionExpiry: 9_999_999_999, wallet: mocks.owner.walletAddress, keyHash: `0x${"99".repeat(32)}`, oldCheckerKeyHash: null },
        } } };
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const go = vi.fn();
    await act(async () => {
      root!.render(<HireTradeDeploy agentName={tradfiCmcSettings.name} executionModel="tradfi"
        capitalBnb="0.01" settings={tradfiCmcSettings} go={go} />);
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { button("Sign hire and create the session key").click(); await vi.advanceTimersByTimeAsync(0); });
    for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    await flush();
    return { go, cmcCalls };
  }

  beforeEach(() => {
    mocks.signEnvelope.mockImplementation(async (_action: string, agentId: string, signedParams: unknown) => ({
      signed: { owner: mocks.owner.ownerAddress, action: "provisionAgent", agentId,
        paramsHash: paramsHash("provisionAgent", signedParams),
        nonce: `0x${"66".repeat(32)}`, issuedAt: "1", expiry: "9999999999" },
      signature: "0xsignature", params: signedParams,
    } as OwnerActionEnvelope));
  });

  it("HIRE-SIGNATURES-BC records the funded TradFi ledger with CMC and navigates after confirm", async () => {
    const { go, cmcCalls } = await runTradfiCmcHire();
    const entries = mocks.signEnvelope.mock.calls.map((call, index) => ({ order: mocks.signEnvelope.mock.invocationCallOrder[index]!, label: String(call[0]) }));
    entries.push(...mocks.grant.mock.invocationCallOrder.map((order) => ({ order, label: "grant" })));
    const prepareCallIndex = fetchMock.mock.calls.findIndex(([input, init]) => String(input).endsWith("/trade/cmc-budget") && (init as RequestInit | undefined)?.method === "POST");
    expect(prepareCallIndex).toBeGreaterThanOrEqual(0);
    entries.push({ order: fetchMock.mock.invocationCallOrder[prepareCallIndex]!, label: "cmc-budget" });
    const observed = entries.sort((left, right) => left.order - right.order).map((entry) => entry.label);
    expect(observed).toEqual(["provisionAgent", "grant", "cmc-budget"]);
    console.info(`HIRE_SIGNATURES_LEDGER trade funded + CMC: ${JSON.stringify(observed)}`);

    expect(mocks.signEnvelope).toHaveBeenCalledTimes(1);
    // `mocks.owner` never declares `signReadHeader`; the mocked owner-actions surface has no such
    // method to call, so the hire step cannot reach it (it must not: a read signature here is a 4th prompt).
    const [, prepareInit] = fetchMock.mock.calls[prepareCallIndex]!;
    expect((prepareInit as RequestInit).headers).toMatchObject({ "x-provision-action": expect.any(String) });

    // Navigation happens after the confirm call, not before.
    const confirmIndex = fetchMock.mock.calls.findIndex(([input]) => String(input).endsWith("/trade/cmc-budget/confirm"));
    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(go.mock.invocationCallOrder[0]!).toBeGreaterThan(fetchMock.mock.invocationCallOrder[confirmIndex]!);
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);

    // R1.11: the second attempt POST re-posts with the callsId hint.
    const secondAttempt = cmcCalls.filter((call) => call.path === "attempt")[1];
    expect((secondAttempt?.body as { readonly callsId?: string } | undefined)?.callsId).toBe(`0x${"44".repeat(32)}`);
    expect(localStorage.getItem(pendingKey())).toBeNull();
  });

  it("a final prepare refusal (409 conflict) still navigates, and leaves no pending record", async () => {
    const { go } = await runTradfiCmcHire({ prepare: () => ({ status: 409, body: { error: { code: "conflict", message: "Data access was already set up or has another operation pending." } } }) });
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    expect(mocks.executeCmcBudgetCalls).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey())).toBeNull();
  });

  // CMC-TOKEN-CLASS-SPEC R5: an unreviewed grant shape never becomes reviewed by
  // waiting, so the step returns at once instead of retrying for the usual 45 s.
  it("a permanent cmc-profile-unavailable refusal makes exactly one prepare call and still navigates", async () => {
    const { go } = await runTradfiCmcHire({ prepare: () => ({ status: 409, body: { error: { code: "cmc_setup_unavailable", message: "cmc-profile-unavailable" } } }) });
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    const prepareCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/trade/cmc-budget") && (init as RequestInit | undefined)?.method === "POST");
    expect(prepareCalls.length).toBe(1);
    expect(mocks.executeCmcBudgetCalls).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey())).toBeNull();
  });

  it("a call-plan validation throw still navigates, and keeps the pending record for the panel's Resume", async () => {
    mocks.validateCmcBudgetCallPlan.mockImplementationOnce(() => { throw new Error("The prepared CMC owner operation does not match the signed budget action."); });
    const { go } = await runTradfiCmcHire();
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    expect(mocks.executeCmcBudgetCalls).not.toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem(pendingKey()) ?? "null") as { readonly callsId: string | null; readonly operationId: string } | null;
    expect(saved?.operationId).toBe("op-1");
    expect(saved?.callsId).toBeNull();
  });

  it("a rejected passkey execute still navigates, and keeps the pending record", async () => {
    mocks.executeCmcBudgetCalls.mockRejectedValueOnce(new Error("The user declined the request."));
    const { go } = await runTradfiCmcHire();
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    const saved = JSON.parse(localStorage.getItem(pendingKey()) ?? "null") as { readonly callsId: string | null } | null;
    expect(saved?.callsId).toBeNull();
  });

  it("a FAILED wallet operation still navigates, and keeps the pending record for explicit recovery", async () => {
    mocks.executeCmcBudgetCalls.mockResolvedValueOnce({ status: "FAILED", callsId: `0x${"44".repeat(32)}` });
    const { go } = await runTradfiCmcHire();
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    const saved = JSON.parse(localStorage.getItem(pendingKey()) ?? "null") as { readonly callsId: string | null } | null;
    expect(saved?.callsId).toBeNull();
  });

  it("an already-attempted operation with no local callsId is left alone, without executing", async () => {
    const { go } = await runTradfiCmcHire({
      prepare: () => ({ status: 200, body: { data: {
        operationId: "op-1", mode: "topup", calls: [], continuationAttemptId: "attempt-1", state: "attempted",
        operation: { operationId: "op-1", mode: "topup", expectedGeneration: 0, incrementWei: tradfiCmcSettings.cmcTotalBudgetWei,
          sessionPublicKey: tradfiSessionKey, sessionExpiry: 9_999_999_999, wallet: mocks.owner.walletAddress, keyHash: `0x${"99".repeat(32)}`, oldCheckerKeyHash: null },
      } } }),
    });
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    expect(mocks.executeCmcBudgetCalls).not.toHaveBeenCalled();
    expect(mocks.validateCmcBudgetCallPlan).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey())).toBeNull();
  });

  it("AUDIT: a refused attempt (non-2xx) never executes the batch, and still navigates", async () => {
    const { go } = await runTradfiCmcHire({ attempt: () => ({ status: 503, body: { error: { code: "trade_not_ready" } } }) });
    expect(go).toHaveBeenCalledWith(`/account/${tradfiAgentId}`);
    expect(mocks.executeCmcBudgetCalls).not.toHaveBeenCalled();
  });
});

// R2.3 (MEDIUM-1): a failed v2/schedule preview must name the side that is actually
// short — the BNB relay reserve, not the USDT sentence, when only nativeShortfallWei
// is positive. Covers both `sizingMessage` (background preview) and `loadPreview`
// (the fresh hire-time re-check inside startHire).
describe("R2.3: BNB-side preview shortfall copy", () => {
  const tradfiSettings: TradeSettings = { ...settings, executionModel: "tradfi", settlementAsset: "USDT",
    entryWei: "10000000000000000000", minEntryWei: "10000000000000000000", maxOpenPositions: 1,
    capitalQuoteWei: "1000000000000000000000", cmcNewsEnabled: false,
    tradeMode: "schedule", scheduleIntervalSec: 3_600, scheduleEndKind: "budget",
    scheduleEndRuns: null, scheduleEndAtSec: null, scheduleFirstAtSec: null };

  function schedulePreview(capDayWei: string, shortfall: boolean) {
    return {
      capDayWei,
      sizing: {
        name: "trade-v1", version: 1, openNativeBudgetWei: "0", executionModel: "tradfi",
        entryWei: tradfiSettings.entryWei, maxOpenPositions: tradfiSettings.maxOpenPositions,
        grantedTokenCount: 6, platformFeeBps: 0, platformFeePerEntryWei: "0", platformFeeTotalWei: "0",
        tradeRelayFeePerSubmitWei: "100000000000000",
        capitalRequiredWei: tradfiSettings.entryWei, capitalShortfallWei: "0",
        settlementAsset: "USDT", minEntryWei: tradfiSettings.minEntryWei, capitalQuoteWei: tradfiSettings.capitalQuoteWei,
        cmcNewsEnabled: false, tradeMode: "schedule", plannedBuys: 100, buysThisSession: 166,
        nativeReserveWei: "800000000000000000",
        ...(shortfall ? { ok: false, nativeShortfallWei: "100000000000000000" } : { ok: true, nativeShortfallWei: "0" }),
      },
      funding: { version: 1, observedAtSec: Math.floor(Date.now() / 1_000), registrationFeeWei: "2",
        registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei: "0" },
      pin: [{ symbol: "AAAX", address: "0x3333333333333333333333333333333333333333" }],
      indicative: true,
    };
  }

  function mockSchedulePreview(shortfall: () => boolean): void {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (!url.includes("/hire/preview")) throw new Error(`Unexpected URL ${url}`);
      const capDayWei = new URL(url, "http://localhost").searchParams.get("capDayWei") ?? "0";
      return response(schedulePreview(capDayWei, shortfall()));
    });
  }

  it("sizingMessage names the BNB side, not USDT, for a native-only shortfall", async () => {
    mockSchedulePreview(() => true);
    await act(async () => {
      root!.render(<HireTradeDeploy agentName={tradfiSettings.name} executionModel="tradfi"
        capitalBnb="0.01" settings={tradfiSettings} go={vi.fn()} />);
    });
    await flush();
    expect(host.textContent).toContain("BNB relay reserve is too small; the plane needs 0.8 BNB for 166 buys.");
    expect(host.textContent).not.toContain("USDT capital is too small");
  });

  it("loadPreview throws the BNB-side message when a fresh hire-time preview reveals a native-only shortfall", async () => {
    let shortfall = false;
    mockSchedulePreview(() => shortfall);
    await act(async () => {
      root!.render(<HireTradeDeploy agentName={tradfiSettings.name} executionModel="tradfi"
        capitalBnb="0.01" settings={tradfiSettings} go={vi.fn()} />);
    });
    await flush();
    expect(button("Sign hire and create the session key").disabled).toBe(false);
    shortfall = true;
    await act(async () => { button("Sign hire and create the session key").click(); });
    await flush();
    expect(host.textContent).toContain("BNB relay reserve is too small; the plane needs 0.8 BNB for 166 buys.");
    expect(host.textContent).not.toContain("USDT capital is below the required maximum-entry budget");
  });
});

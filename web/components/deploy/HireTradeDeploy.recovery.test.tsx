// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paramsHash, type OwnerActionEnvelope } from "@/lib/exec/owner-action";
import type { TradeSettings } from "@/lib/trade";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  signEnvelope: vi.fn(),
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
vi.mock("@/components/FundsModal", () => ({
  FundsModal: ({ onClose }: { readonly onClose: () => void }) => <button onClick={onClose}>Close deposit</button>,
}));

import { HireTradeDeploy } from "./HireTradeDeploy";

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

describe("Trading one-press recovery", () => {
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

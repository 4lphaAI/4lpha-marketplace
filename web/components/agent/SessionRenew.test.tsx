// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRenew, diagnostic } from "./SessionRenew";

const mocks = vi.hoisted(() => {
  class MockGrantAgentSessionError extends Error {
    readonly code: string;
    readonly cause: unknown;
    constructor(code: string, cause?: unknown) { super(code); this.name = "GrantAgentSessionError"; this.code = code; this.cause = cause; }
  }
  return {
    grant: vi.fn(),
    revoke: vi.fn(),
    signEnvelope: vi.fn(),
    owner: { passkey: {} as unknown, walletAddress: "0x2222222222222222222222222222222222222222", signEnvelope: vi.fn() },
    GrantAgentSessionError: MockGrantAgentSessionError,
  };
});

vi.mock("@/lib/altana/client", () => ({
  grantAgentSession: mocks.grant,
  revokeAgentSession: mocks.revoke,
  GrantAgentSessionError: mocks.GrantAgentSessionError,
}));
vi.mock("@/lib/exec/use-owner-actions", () => ({
  useOwnerActions: () => mocks.owner,
}));

const NOW = Math.floor(Date.now() / 1_000);
const sessionKey = `0x${"33".repeat(64)}`;
const pending = (phase: string, extra: Record<string, unknown> = {}) => ({
  grantDigest: `0x${"44".repeat(32)}`,
  permissions: { calls: [], spend: [] },
  expiresAt: NOW + 7_200,
  sessionPublicKey: sessionKey,
  sessionAddress: "0x3333333333333333333333333333333333333333",
  phase,
  ...extra,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.signEnvelope.mockResolvedValue({ signed: {}, signature: "0xsig" });
  mocks.owner.signEnvelope.mockResolvedValue({ signed: {}, signature: "0xsig" });
  mocks.grant.mockResolvedValue({ publicKey: sessionKey, expiry: NOW + 7_200 });
  mocks.revoke.mockResolvedValue({ status: "SUCCESS" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(overrides: Partial<React.ComponentProps<typeof SessionRenew>> = {}): Promise<void> {
  await act(async () => root.render(<SessionRenew agentId="agent" walletAddress="0x2222222222222222222222222222222222222222" sessionExpiresAt={NOW - 1} kind="trade" {...overrides} />));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("SessionRenew", () => {
  it("renders nothing before the session ends (no button, no line)", () => {
    const html = renderToStaticMarkup(<SessionRenew agentId="agent" walletAddress="0x2222222222222222222222222222222222222222" sessionExpiresAt={NOW + 3_600} kind="trade" />);
    expect(html).toBe("");
  });

  it("[F12] reconciles a grant error once and offers convergence when evidence is observed", async () => {
    let sessionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session") && init?.method !== "POST") {
        sessionReads += 1;
        return json({ data: { pendingRenewal: pending(sessionReads === 1 ? "granting" : "observed") } });
      }
      if (url.endsWith("/session/renew")) return json({ data: { ...pending("granting"), expiry: NOW + 7_200 } });
      if (url.endsWith("/grant-attempt")) return json({ data: { mayInvoke: true } });
      throw new Error(`unexpected ${url}`);
    }));
    mocks.grant.mockRejectedValue(new mocks.GrantAgentSessionError("grant_pending", { name: "Error", message: "Session grant did not confirm: status=PENDING" }));
    await mount();
    expect(host.textContent).toContain("Retry grant");
    await act(async () => { host.querySelector<HTMLButtonElement>("button")?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(sessionReads).toBe(2);
    expect(host.textContent).toContain("Converging");
    expect(host.textContent).toContain("relay did not confirm");
    expect(host.textContent).not.toContain("Retry grant");
  });

  it("[F12] applies the wire selection order for cancelled retry and revoke states", async () => {
    const cases = [
      { row: pending("cancelled", { cancelReason: "owner", authorityObserved: false }), revoke: false, button: "Retry renewal", absent: "Revoke new key" },
      { row: pending("cancelled", { cancelReason: "expired", authorityObserved: false }), revoke: false, button: "", absent: "Retry renewal" },
      { row: pending("granting"), revoke: true, button: "Revoke new key", absent: "Retry grant" },
    ] as const;
    for (const testCase of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => json({ data: { pendingRenewal: testCase.row, ...(testCase.revoke ? { onChainRevoke: { chainId: 56, calls: [] } } : {}) } })));
      await mount();
      if (testCase.button !== "") expect(host.textContent).toContain(testCase.button);
      expect(host.textContent).not.toContain(testCase.absent);
      await act(async () => root.unmount());
      host.innerHTML = "";
      root = createRoot(host);
    }
  });

  it("[F12] keeps the cancel response when the wire uses expiresAt", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        reads += 1;
        return json({ data: { pendingRenewal: pending("observed") } });
      }
      if (url.endsWith("/renew/cancel")) return json({ data: pending("cancelled", { cancelReason: "owner", authorityObserved: false }) });
      throw new Error(`unexpected ${url}`);
    }));
    await mount();
    const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel renewal");
    expect(cancel).toBeDefined();
    await act(async () => { cancel?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Retry renewal");
    expect(reads).toBe(1);
  });

  it("[F12] treats a failed read and a failed fresh owner read as unresolved", async () => {
    let sessionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/session")) {
        sessionReads += 1;
        if (sessionReads === 1) return json({ data: { pendingRenewal: pending("granting") } });
        throw new Error("plane unavailable");
      }
      throw new Error("unexpected request");
    }));
    await mount({ refresh: async () => ({ id: "agent", status: "paused", walletAddress: "0x2222222222222222222222222222222222222222", sessionExpiresAt: NOW - 60 }) });
    expect(host.textContent).toContain("Retry grant");
    await act(async () => { host.querySelector<HTMLButtonElement>("button")?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Could not read the renewal state");
    expect(host.textContent).not.toContain("Retry grant");
    expect(host.textContent).not.toContain("Session renewed until");
    expect(sessionReads).toBe(2);
  });

  it("[F12/R11.1] does not decide completion from the captured expired view after a failed refresh", async () => {
    let sessionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        sessionReads += 1;
        return sessionReads === 1 ? json({ data: { pendingRenewal: pending("granting") } }) : json({ data: { status: "paused" } });
      }
      if (url.endsWith("/session/renew")) return json({ error: { code: "renewal_pending" } }, 409);
      throw new Error(`unexpected ${url}`);
    }));
    await mount({ refresh: async () => null });
    await act(async () => { host.querySelector<HTMLButtonElement>("button")?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Could not read the renewal state");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Renew");
  });

  it("[F12] uses a successful fresh owner read for paused completion", async () => {
    let sessionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        sessionReads += 1;
        if (sessionReads === 1) return json({ data: { pendingRenewal: pending("granting") } });
        return json({ data: { status: "paused" } });
      }
      if (url.endsWith("/session/renew")) return json({ error: { code: "renewal_pending" } }, 409);
      throw new Error(`unexpected ${url}`);
    }));
    await mount({ refresh: async () => ({ id: "agent", status: "paused", walletAddress: "0x2222222222222222222222222222222222222222", sessionExpiresAt: NOW + 7_200 }) });
    await act(async () => { host.querySelector<HTMLButtonElement>("button")?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Session renewed until");
    expect(sessionReads).toBe(2);
  });

  it("[F12/R11.3] renders only the fixed diagnostic allowlist", () => {
    expect(diagnostic({ name: "HttpRequestError", shortMessage: "request context: {signature: abc}" })).toBe("relay unreachable");
    expect(diagnostic({ name: "ContractFunctionRevertedError", shortMessage: "request context: {signature: abc}" })).toBeNull();
    expect(diagnostic({ name: "Error", message: "Session grant did not confirm: status=PENDING signing-context=secret" })).toBeNull();
    expect(diagnostic({ name: "Error", message: "Session grant did not confirm: status=FAILED" })).toBe("grant failed on chain");
  });
});

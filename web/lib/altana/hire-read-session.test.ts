import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_READ_EXPIRY_KEY,
  credentialUsable,
  ensureHireReadCredential,
  HireReadRefused,
  pollStatusText,
  readOwnedAgents,
  readHireSession,
  rememberedHireReadCredential,
  type HireReadCredential,
} from "./hire-read-session";
import type { OwnerActionEnvelope } from "../exec/owner-action";

/**
 * The bug this closes, from a live hire: a signed `read` header lives 120 s,
 * the convergence poll ran for ten minutes on one of them, and from the third
 * minute every poll was `owner_auth_failed` — painted red over a hire that was
 * doing nothing wrong.
 */
const NOW = 1_700_000_000_000;

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    map,
  };
}

type Signer = (action: string, agentId: string, params: unknown) => Promise<OwnerActionEnvelope>;

function signer(): { sign: ReturnType<typeof vi.fn<Signer>>; envelopes: string[] } {
  const envelopes: string[] = [];
  const sign = vi.fn<Signer>(async (action, agentId, params) => {
    envelopes.push(action);
    return {
      signed: { action, agentId, expiry: String(Math.floor(NOW / 1_000) + 120) },
      signature: "0xsig",
      params,
    } as unknown as OwnerActionEnvelope;
  });
  return { sign, envelopes };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ensureHireReadCredential", () => {
  it("issues the 900 s account read session with ONE signature and remembers its window", async () => {
    const { sign, envelopes } = signer();
    const storage = memoryStorage();
    const fetcher = vi.fn(async () => json({ data: { expiry: Math.floor(NOW / 1_000) + 900 } }));
    const credential = await ensureHireReadCredential({ current: null, target: "*", signEnvelope: sign, storage, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
    expect(credential.mode).toBe("cookie");
    expect(credential.expiryMs).toBe(NOW + 900_000);
    expect(envelopes).toEqual(["createAccountReadSession"]);
    expect(storage.map.get(ACCOUNT_READ_EXPIRY_KEY)).toBe(String(NOW + 900_000));
  });

  it("reuses a live window without signing — including the agent page's own", async () => {
    const { sign } = signer();
    const storage = memoryStorage({ [ACCOUNT_READ_EXPIRY_KEY]: String(NOW + 600_000) });
    const fetcher = vi.fn();
    const credential = await ensureHireReadCredential({ current: null, target: "*", signEnvelope: sign, storage, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
    expect(credential).toEqual({ mode: "cookie", expiryMs: NOW + 600_000 });
    expect(sign).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renews rather than polls into the expiry", async () => {
    const current: HireReadCredential = { mode: "cookie", expiryMs: NOW + 30_000 };
    expect(credentialUsable(current, NOW, "*")).toBe(false);
    const { sign, envelopes } = signer();
    const fetcher = vi.fn(async () => json({ data: { expiry: Math.floor(NOW / 1_000) + 900 } }));
    const renewed = await ensureHireReadCredential({ current, target: "*", signEnvelope: sign, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
    expect(renewed.expiryMs).toBe(NOW + 900_000);
    expect(envelopes).toEqual(["createAccountReadSession"]);
  });

  it("uses the exact target for signed renewal instead of reissuing the account session", async () => {
    const { sign, envelopes } = signer();
    const current: HireReadCredential = {
      mode: "signed", target: "*", header: "old-list-read", expiryMs: NOW + 60_000,
    };
    const renewed = await ensureHireReadCredential({
      current, target: "agent-1", signEnvelope: sign, nowMs: NOW,
    });
    expect(renewed).toMatchObject({ mode: "signed", target: "agent-1" });
    expect(envelopes).toEqual(["read"]);
    expect(sign).toHaveBeenCalledWith("read", "agent-1", {});
  });

  it("surfaces an issuer rate limit instead of falling back to a signed read", async () => {
    const { sign, envelopes } = signer();
    const fetcher = vi.fn(async () => json({ error: { code: "rate_limited" } }, 429));
    await expect(ensureHireReadCredential({
      current: null, target: "*", signEnvelope: sign,
      fetcher: fetcher as unknown as typeof fetch, nowMs: NOW,
    })).rejects.toMatchObject({ status: 429, message: "rate_limited" });
    expect(envelopes).toEqual(["createAccountReadSession"]);
  });

  it("reuses a matching signed credential at 60,001 ms and renews it at 60,000 ms", async () => {
    const current: HireReadCredential = {
      mode: "signed", target: "agent-1", header: "signed-read", expiryMs: NOW + 120_001,
    };
    expect(credentialUsable(current, NOW + 60_000, "agent-1")).toBe(true);
    expect(credentialUsable(current, NOW + 60_001, "agent-1")).toBe(false);
    const { sign } = signer();
    await expect(ensureHireReadCredential({ current, target: "agent-1", signEnvelope: sign, nowMs: NOW + 60_000 }))
      .resolves.toBe(current);
    await ensureHireReadCredential({ current, target: "agent-1", signEnvelope: sign, nowMs: NOW + 60_001 });
    expect(sign).toHaveBeenCalledWith("read", "agent-1", {});
  });

  it("applies the same strict boundary to a remembered cookie for every target", () => {
    const storage = memoryStorage({ [ACCOUNT_READ_EXPIRY_KEY]: String(NOW + 120_001) });
    const remembered = rememberedHireReadCredential(storage, NOW);
    expect(remembered).not.toBeNull();
    expect(credentialUsable(remembered, NOW + 60_000, "agent-1")).toBe(true);
    expect(credentialUsable(remembered, NOW + 60_001, "agent-1")).toBe(false);
    expect(credentialUsable(remembered, NOW + 60_001, "agent-2")).toBe(false);
  });

  it("falls back to the 120 s signed header when the issuer is hidden (404) or unreachable", async () => {
    for (const fetcher of [vi.fn(async () => json({ error: { code: "not_found" } }, 404)), vi.fn(async () => { throw new Error("Unexpected URL"); })]) {
      const { sign, envelopes } = signer();
      const credential = await ensureHireReadCredential({ current: null, target: "*", signEnvelope: sign, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
      expect(credential.mode).toBe("signed");
      expect(credential.expiryMs).toBe(NOW + 120_000);
      expect(envelopes).toEqual(["createAccountReadSession", "read"]);
    }
  });
});

describe("readHireSession", () => {
  it("sends no header on the cookie credential and the signed header otherwise", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return json({ data: { status: "provisioning", missing: [] } });
    });
    await readHireSession({ agentId: "grid-agent-01-4", credential: { mode: "cookie", expiryMs: NOW + 1 }, fetcher: fetcher as unknown as typeof fetch });
    await readHireSession({ agentId: "grid-agent-01-4", credential: { mode: "signed", target: "grid-agent-01-4", header: "signed-read", expiryMs: NOW + 1 }, fetcher: fetcher as unknown as typeof fetch });
    expect(calls[0]?.headers).toEqual({});
    expect(calls[1]?.headers).toEqual({ "x-owner-action": "signed-read" });
    expect(calls[0]?.url).toBe("/api/agents/grid-agent-01-4/session");
  });

  it("names a 401 as a refused credential so the caller re-issues instead of surfacing it", async () => {
    const fetcher = vi.fn(async () => json({ error: { code: "owner_auth_failed" } }, 401));
    await expect(readHireSession({ agentId: "a", credential: { mode: "cookie", expiryMs: NOW }, fetcher: fetcher as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(HireReadRefused);
  });

  it("refuses a signed credential bound to another agent before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(readHireSession({
      agentId: "agent-2",
      credential: { mode: "signed", target: "agent-1", header: "signed-read", expiryMs: NOW },
      fetcher,
    })).rejects.toThrow("not bound");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("readOwnedAgents", () => {
  it("accepts both list response shapes and sends no header for a cookie", async () => {
    const calls: { readonly url: string; readonly init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return json(calls.length === 1
        ? { data: [{ id: "agent-1", status: "armed" }] }
        : { data: { agents: [{ id: "agent-2", walletAddress: "0x1" }] } });
    });
    await expect(readOwnedAgents({ credential: { mode: "cookie", expiryMs: NOW }, fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual([{ id: "agent-1", status: "armed" }]);
    await expect(readOwnedAgents({ credential: { mode: "signed", target: "*", header: "signed-list", expiryMs: NOW }, fetcher: fetcher as unknown as typeof fetch }))
      .resolves.toEqual([{ id: "agent-2", walletAddress: "0x1" }]);
    expect(calls[0]?.init?.headers).toEqual({});
    expect(calls[1]?.init?.headers).toEqual({ "x-owner-action": "signed-list" });
  });

  it("refuses a non-wildcard signed list credential before any fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(readOwnedAgents({
      credential: { mode: "signed", target: "agent-1", header: "signed-agent", expiryMs: NOW }, fetcher,
    })).rejects.toThrow("agent list");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces list authentication and rate-limit responses", async () => {
    for (const status of [401, 429] as const) {
      const fetcher = vi.fn(async () => json({ error: { code: status === 401 ? "owner_auth_failed" : "rate_limited" } }, status));
      await expect(readOwnedAgents({ credential: { mode: "cookie", expiryMs: NOW }, fetcher: fetcher as unknown as typeof fetch }))
        .rejects.toMatchObject({ status });
    }
  });
});

describe("pollStatusText", () => {
  const view = (missing: string[]) => ({ status: "provisioning", missing } as unknown as Parameters<typeof pollStatusText>[0]);
  it("does not claim grant evidence for a wallet the plane has not seen registered", () => {
    expect(pollStatusText(view(["account-key", "wallet-not-registered"]))).toMatch(/registered on chain/u);
    expect(pollStatusText(view(["evidence-unreadable"]))).toMatch(/could not be read/u);
    expect(pollStatusText(view(["account-key"]))).toMatch(/on its way/u);
  });
});

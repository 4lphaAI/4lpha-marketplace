import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_READ_EXPIRY_KEY,
  credentialUsable,
  ensureHireReadCredential,
  HireReadRefused,
  pollStatusText,
  readHireSession,
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
    const credential = await ensureHireReadCredential({ current: null, signEnvelope: sign, storage, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
    expect(credential.mode).toBe("cookie");
    expect(credential.expiryMs).toBe(NOW + 900_000);
    expect(envelopes).toEqual(["createAccountReadSession"]);
    expect(storage.map.get(ACCOUNT_READ_EXPIRY_KEY)).toBe(String(NOW + 900_000));
  });

  it("reuses a live window without signing — including the agent page's own", async () => {
    const { sign } = signer();
    const storage = memoryStorage({ [ACCOUNT_READ_EXPIRY_KEY]: String(NOW + 600_000) });
    const fetcher = vi.fn();
    const credential = await ensureHireReadCredential({ current: null, signEnvelope: sign, storage, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
    expect(credential).toEqual({ mode: "cookie", expiryMs: NOW + 600_000 });
    expect(sign).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renews rather than polls into the expiry", async () => {
    const current: HireReadCredential = { mode: "cookie", expiryMs: NOW + 30_000 };
    expect(credentialUsable(current, NOW)).toBe(false);
    const { sign, envelopes } = signer();
    const fetcher = vi.fn(async () => json({ data: { expiry: Math.floor(NOW / 1_000) + 900 } }));
    const renewed = await ensureHireReadCredential({ current, signEnvelope: sign, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
    expect(renewed.expiryMs).toBe(NOW + 900_000);
    expect(envelopes).toEqual(["createAccountReadSession"]);
  });

  it("falls back to the 120 s signed header when the issuer is hidden (404) or unreachable", async () => {
    for (const fetcher of [vi.fn(async () => json({ error: { code: "not_found" } }, 404)), vi.fn(async () => { throw new Error("Unexpected URL"); })]) {
      const { sign, envelopes } = signer();
      const credential = await ensureHireReadCredential({ current: null, signEnvelope: sign, fetcher: fetcher as unknown as typeof fetch, nowMs: NOW });
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
    await readHireSession({ agentId: "grid-agent-01-4", credential: { mode: "signed", header: "signed-read", expiryMs: NOW + 1 }, fetcher: fetcher as unknown as typeof fetch });
    expect(calls[0]?.headers).toEqual({});
    expect(calls[1]?.headers).toEqual({ "x-owner-action": "signed-read" });
    expect(calls[0]?.url).toBe("/api/agents/grid-agent-01-4/session");
  });

  it("names a 401 as a refused credential so the caller re-issues instead of surfacing it", async () => {
    const fetcher = vi.fn(async () => json({ error: { code: "owner_auth_failed" } }, 401));
    await expect(readHireSession({ agentId: "a", credential: { mode: "cookie", expiryMs: NOW }, fetcher: fetcher as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(HireReadRefused);
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

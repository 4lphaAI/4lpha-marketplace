import { encodeReadHeader, type OwnerActionEnvelope } from "../exec/owner-action";
import type { HireSessionView } from "./hire-state";
import { ACCOUNT_READ_EXPIRY_KEY, rememberReadExpiry } from "../exec/read-session-window";
export { ACCOUNT_READ_EXPIRY_KEY } from "../exec/read-session-window";

/**
 * The credential a hire poll reads with.
 *
 * WHY THIS EXISTS: a signed `read` envelope expires 120 s after it is signed
 * (`owner-action.ts`: `expiry = now + 120`, inside the plane's 300 s window).
 * The hire flow polled `GET /agents/:id/session` for up to ten minutes on ONE
 * such header, so from the third minute every poll came back
 * `owner_auth_failed` and the screen painted a red auth error over a hire that
 * was doing nothing wrong. The agent detail page never had this problem: it
 * signs `createAccountReadSession` once and reads on the resulting HttpOnly
 * cookie until browser close (at most 24 hours). This module gives the hire flow the same window — and
 * because the cookie is shared, a hire that follows a visit to the agent page
 * asks for no passkey at all.
 *
 * `cookie` mode sends NO header (the BFF forwards the cookie as a bearer);
 * `signed` mode is the 120 s fallback for a deployment that hides the issuer
 * (HTTP 404) or cannot reach it, and callers re-issue it when it lapses.
 */
export type HireReadCredential =
  | { readonly mode: "cookie"; readonly expiryMs: number }
  | { readonly mode: "signed"; readonly header: string; readonly expiryMs: number };

/** Same key `use-agent-detail` remembers its window under, so the two share one cookie. */


/** Renew when less than this remains: a poll must never straddle the expiry. */
export const RENEW_BEFORE_MS = 60_000;

type Signer = (action: string, agentId: string, params: unknown) => Promise<OwnerActionEnvelope>;
type ReadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function credentialUsable(credential: HireReadCredential | null, nowMs: number): boolean {
  return credential !== null && credential.expiryMs - nowMs > RENEW_BEFORE_MS;
}

export function rememberedHireReadCredential(storage: ReadStorage | undefined, nowMs: number): HireReadCredential | null {
  if (storage === undefined) return null;
  try {
    const raw = storage.getItem(ACCOUNT_READ_EXPIRY_KEY);
    if (raw === null) return null;
    const expiryMs = Number(raw);
    if (!Number.isSafeInteger(expiryMs)) return null;
    const window: HireReadCredential = { mode: "cookie", expiryMs };
    return credentialUsable(window, nowMs) ? window : null;
  } catch {
    return null;
  }
}

/**
 * A usable read credential, reusing the remembered cookie window when one is
 * live and asking for exactly one passkey signature otherwise.
 */
export async function ensureHireReadCredential(input: {
  readonly current: HireReadCredential | null;
  readonly signEnvelope: Signer;
  readonly storage?: ReadStorage;
  readonly fetcher?: typeof fetch;
  readonly nowMs?: number;
}): Promise<HireReadCredential> {
  const nowMs = input.nowMs ?? Date.now();
  if (credentialUsable(input.current, nowMs)) return input.current as HireReadCredential;
  const remembered = rememberedHireReadCredential(input.storage, nowMs);
  if (remembered !== null) return remembered;

  const envelope = await input.signEnvelope("createAccountReadSession", "*", {});
  try {
    const response = await (input.fetcher ?? fetch)("/api/account/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (response.ok) {
      const payload = await response.json() as { data?: { expiry?: unknown } };
      const expirySec = payload.data?.expiry;
      if (typeof expirySec === "number" && Number.isSafeInteger(expirySec * 1_000)) {
        const expiryMs = expirySec * 1_000;
        rememberReadExpiry(input.storage, expiryMs);
        return { mode: "cookie", expiryMs };
      }
    }
    // 404 = the issuer is capability-hidden on this deployment; anything else
    // unexpected is treated the same way rather than failing the hire.
  } catch {
    // Unreachable issuer: fall through to the signed window.
  }
  const fallback = await input.signEnvelope("read", "*", {});
  const expiry = fallback.signed.expiry;
  const expiryMs = typeof expiry === "string" && /^\d+$/u.test(expiry) ? Number(BigInt(expiry) * 1_000n) : nowMs + 120_000;
  return { mode: "signed", header: encodeReadHeader(fallback), expiryMs };
}

export class HireReadRefused extends Error {
  constructor(readonly status: number) { super(status === 401 ? "owner_auth_failed" : `HTTP ${status}`); }
}

/**
 * One read of the hire row. A `signed` credential for `*` is accepted by the
 * plane's read binding for any agent; a `cookie` credential sends nothing and
 * lets the BFF forward the HttpOnly bearer.
 */
export async function readHireSession(input: {
  readonly agentId: string;
  readonly credential: HireReadCredential;
  readonly fetcher?: typeof fetch;
}): Promise<HireSessionView> {
  const headers: Record<string, string> = input.credential.mode === "signed" ? { "x-owner-action": input.credential.header } : {};
  const response = await (input.fetcher ?? fetch)(`/api/agents/${encodeURIComponent(input.agentId)}/session`, { headers, cache: "no-store" });
  const payload = await response.json() as { data?: HireSessionView; error?: { code?: string; message?: string } };
  if (!response.ok || payload.data === undefined) {
    if (response.status === 401) throw new HireReadRefused(401);
    throw new Error(payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`);
  }
  return payload.data;
}

/**
 * What the owner is actually waiting on while a hire is in `poll`. The old
 * text claimed "some grant evidence has landed" for EVERY poll state, including
 * a wallet the plane has not even seen registered yet.
 */
export function pollStatusText(view: HireSessionView): string {
  const missing = new Set(view.missing ?? []);
  if (missing.has("wallet-not-registered")) return "Waiting for the agent wallet to be registered on chain — the grant registers it; nothing else is pending.";
  if (missing.has("evidence-unreadable")) return "The relay or chain could not be read just now; the plane keeps checking. Nothing is re-granted.";
  return "The grant is on its way: waiting for the relay, account, KeyStore and owner-binding evidence to agree. Another grant will not be sent automatically.";
}

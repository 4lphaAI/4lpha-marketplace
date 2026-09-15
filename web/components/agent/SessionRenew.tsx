"use client";

import React from "react";
import type { SessionPermissions } from "@altananetwork/sdk";
import type { Address, Hex } from "viem";
import { Button } from "@/design-system";
import { GrantAgentSessionError, grantAgentSession, revokeAgentSession } from "@/lib/altana/client";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";

type WirePermissions = {
  readonly calls: readonly { readonly to?: string; readonly signature?: string }[];
  readonly spend: readonly { readonly token?: string; readonly period: string; readonly limit: string }[];
};

type RenewalData = {
  readonly grantDigest: Hex;
  readonly permissions: WirePermissions;
  readonly expiry: number;
  readonly expiresAt?: number;
  readonly sessionPublicKey: Hex;
  readonly sessionAddress: Address;
  readonly funding?: { readonly requiredWei?: string; readonly balanceWei?: string | null };
  readonly previous?: { readonly publicKey?: Hex; readonly expiry?: number; readonly expired?: boolean };
  readonly universe?: { readonly tokens?: readonly string[]; readonly held?: number; readonly pinned?: number; readonly dropped?: readonly string[] };
  readonly renewActionId?: Hex;
  readonly phase?: string;
  readonly cancelReason?: "owner" | "expired" | "renewal_coverage_lost";
  readonly authorityObserved?: boolean;
  readonly onChainRevoke?: unknown;
  readonly coverageLossToken?: string;
};

type RevokeInstructions = {
  readonly chainId: number;
  readonly calls: readonly { readonly to: string; readonly from: string; readonly data: string; readonly note: string }[];
};

type SessionPayload = {
  readonly data?: {
    readonly pendingRenewal?: RenewalData & { readonly phase?: string; readonly authorityObserved?: boolean; readonly onChainRevoke?: unknown };
    readonly renewalPhase?: string;
    readonly quiescing?: string;
    readonly universe?: RenewalData["universe"];
    readonly funding?: RenewalData["funding"];
    readonly agent?: { readonly session?: { readonly expiresAt?: number } };
    readonly onChainRevoke?: unknown;
  };
};

export type SessionRenewProps = {
  readonly agentId: string;
  readonly walletAddress: string;
  readonly sessionExpiresAt: number | null | undefined;
  readonly status?: string;
  readonly kind: "trade" | "grid" | "lp";
  readonly readHeaders?: Readonly<Record<string, string>>;
  readonly refresh?: () => Promise<unknown>;
};

function expired(expiresAt: number | null | undefined): boolean {
  return expiresAt !== null && expiresAt !== undefined && Math.floor(Date.now() / 1_000) >= expiresAt;
}

function responseData(payload: unknown): RenewalData | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const data = (payload as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const expiry = typeof value["expiry"] === "number" ? value["expiry"] : value["expiresAt"];
  return typeof value["grantDigest"] === "string" && typeof expiry === "number"
    && typeof value["sessionPublicKey"] === "string" && typeof value["sessionAddress"] === "string"
    ? { ...value, expiry } as unknown as RenewalData : null;
}

function dateText(expiresAt: number): string {
  return new Date(expiresAt * 1_000).toISOString();
}

function remainingText(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Math.floor(Date.now() / 1_000));
  const hours = Math.floor(remaining / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
}

export function diagnostic(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) return null;
  const value = cause as { readonly name?: unknown; readonly message?: unknown };
  const name = typeof value.name === "string" ? value.name : null;
  const message = typeof value.message === "string" ? value.message : null;
  if (message === "Session grant did not confirm: status=PENDING") return "relay did not confirm";
  if (message === "Session grant did not confirm: status=FAILED" || message === "Session grant did not confirm: status=REVERTED") return "grant failed on chain";
  if (name === "NotAllowedError" || name === "AbortError" || name === "TimeoutError"
    || name === "SecurityError" || name === "InvalidStateError") return "passkey prompt cancelled or timed out";
  if (name === "HttpRequestError") return "relay unreachable";
  return null;
}

function ownerExpiry(value: unknown): number | null | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as { readonly id?: unknown; readonly status?: unknown; readonly walletAddress?: unknown; readonly sessionExpiresAt?: unknown };
  if (typeof row.id !== "string" || typeof row.status !== "string" || typeof row.walletAddress !== "string"
    || !Object.prototype.hasOwnProperty.call(row, "sessionExpiresAt")) return undefined;
  if (row.sessionExpiresAt === null) return null;
  return typeof row.sessionExpiresAt === "number" && Number.isSafeInteger(row.sessionExpiresAt) && row.sessionExpiresAt >= 0
    ? row.sessionExpiresAt : undefined;
}

function grantErrorMessage(error: GrantAgentSessionError): string {
  const base = error.code === "grant_pending"
    ? "The relay did not confirm the new key in time. Retry — the same key is reused."
    : error.code === "grant_rejected"
      ? "The passkey prompt was cancelled or timed out. Retry — the same key is reused."
      : error.code === "grant_underfunded"
        ? "The wallet cannot pay the grant fee."
        : "The grant failed. Retry — the same key is reused.";
  const detail = diagnostic(error.cause);
  return detail === null ? base : `${base} (${detail})`;
}

async function jsonResponse(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; } catch { return null; }
}

function grantPermissions(value: WirePermissions): SessionPermissions {
  return {
    calls: value.calls.map((call) => {
      if (call.to !== undefined && call.signature !== undefined) return { to: call.to as Address, signature: call.signature };
      if (call.to !== undefined) return { to: call.to as Address };
      if (call.signature !== undefined) return { signature: call.signature };
      throw new Error("The renewal permission set is malformed.");
    }),
    spend: value.spend.map((spend) => ({
      ...(spend.token === undefined ? {} : { token: spend.token as Address }),
      period: spend.period as "minute" | "hour" | "day" | "week" | "month" | "year",
      limit: BigInt(spend.limit),
    })),
  };
}

function revokeInstructions(value: unknown): RevokeInstructions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row["chainId"] !== "number" || !Array.isArray(row["calls"])) return null;
  const calls = row["calls"].flatMap((call): RevokeInstructions["calls"][number][] => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
    const item = call as Record<string, unknown>;
    return typeof item["to"] === "string" && typeof item["from"] === "string" && typeof item["data"] === "string" && typeof item["note"] === "string"
      ? [{ to: item["to"], from: item["from"], data: item["data"], note: item["note"] }]
      : [];
  });
  return calls.length === row["calls"].length ? { chainId: row["chainId"], calls } : null;
}

export function SessionRenew(props: SessionRenewProps): React.ReactElement | null {
  const owner = useOwnerActions();
  const [preview, setPreview] = React.useState<SessionPayload["data"] | null>(null);
  const [pending, setPending] = React.useState<RenewalData | null>(null);
  const [completedExpiresAt, setCompletedExpiresAt] = React.useState<number | null>(null);
  const [step, setStep] = React.useState<"idle" | "preview" | "signing" | "granting" | "retry" | "retryExpired" | "converging" | "done" | "cancelled">("idle");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const selectPending = React.useCallback((data: NonNullable<SessionPayload["data"]>): void => {
    const value = data?.pendingRenewal;
    if (value === undefined) {
      setPending(null);
      return;
    }
    const renewal = data?.onChainRevoke === undefined
      ? value
      : { ...value, onChainRevoke: data.onChainRevoke };
    setPending(renewal);
    const phase = data?.renewalPhase ?? renewal.phase;
    const hasRevoke = renewal.onChainRevoke !== undefined
      || (renewal.authorityObserved === true && renewal.phase === "cancelled");
    if (hasRevoke) setStep("cancelled");
    else if (phase === "observed" || phase === "quiescing" || phase === "ready") setStep("converging");
    else if (phase === "cancelled") setStep("cancelled");
    else if (phase === "granting") setStep("retry");
    else setStep("converging");
  }, []);

  const readSession = React.useCallback(async (): Promise<NonNullable<SessionPayload["data"]> | null> => {
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/session`, { headers: props.readHeaders, cache: "no-store" });
      const payload = await jsonResponse(response) as SessionPayload;
      if (!response.ok || payload.data === undefined) return null;
      setPreview(payload.data);
      selectPending(payload.data);
      return payload.data;
    } catch {
      return null;
    }
  }, [props.agentId, props.readHeaders, selectPending]);

  React.useEffect(() => { if (expired(props.sessionExpiresAt)) void readSession(); }, [props.sessionExpiresAt, readSession]);

  const completeFromOwnerRead = React.useCallback(async (): Promise<boolean> => {
    if (props.refresh === undefined) return false;
    let fresh: unknown;
    try { fresh = await props.refresh(); } catch { return false; }
    const expiry = ownerExpiry(fresh);
    if (expiry === undefined) return false;
    setPending(null);
    if (expiry !== null && !expired(expiry)) {
      setCompletedExpiresAt(expiry);
      setStep("done");
    } else {
      setStep("idle");
    }
    return true;
  }, [props.refresh]);

  const reconcileAfterError = React.useCallback(async (fallback: string, retryExpired: boolean): Promise<void> => {
    const current = await readSession();
    if (current === null) {
      setMessage("Could not read the renewal state — refresh.");
      return;
    }
    if (current.pendingRenewal !== undefined) {
      if (retryExpired) {
        const value = current.pendingRenewal;
        const expiry = typeof value.expiry === "number" ? value.expiry : value.expiresAt;
        if (typeof expiry === "number") {
          setStep("retryExpired");
          setMessage(`Retry closed: the reserved key expires ${dateText(expiry)}; a fresh renewal opens after that.`);
        } else {
          setMessage("Could not read the renewal state — refresh.");
        }
      } else setMessage(fallback);
      return;
    }
    if (!await completeFromOwnerRead()) setMessage("Could not read the renewal state — refresh.");
    else setMessage(fallback);
  }, [completeFromOwnerRead, readSession]);

  const start = React.useCallback(async () => {
    setBusy(true); setMessage(null); setStep("signing");
    try {
      const params = { ttlSec: 604_800 };
      const envelope = await owner.signEnvelope("renewSession", props.agentId, params);
      const response = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/session/renew`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
      const payload = await jsonResponse(response);
      if (!response.ok) {
        const row = typeof payload === "object" && payload !== null ? payload as { readonly error?: { readonly code?: unknown; readonly message?: unknown } } : {};
        const code = row.error?.code === "renewal_retry_expired";
        const fallback = typeof row.error?.message === "string" ? row.error.message : "Renewal could not be started.";
        await reconcileAfterError(fallback, code);
        return;
      }
      const data = responseData(payload);
      if (data === null || owner.passkey === null || owner.walletAddress === undefined) throw new Error("The renewal response is incomplete.");
      setPending(data); setStep("granting");
      const attempt = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/session/renew/grant-attempt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
      const attemptPayload = await jsonResponse(attempt) as { readonly data?: { readonly mayInvoke?: unknown } };
      if (!attempt.ok || attemptPayload.data?.mayInvoke !== true) throw new Error("The grant attempt is already in progress; refresh to resume it.");
      await grantAgentSession({ record: owner.passkey, walletAddress: owner.walletAddress as Address, permissions: grantPermissions(data.permissions), expiry: data.expiry, sessionPublicKey: data.sessionPublicKey, sessionAddress: data.sessionAddress });
      setStep("converging");
      for (let count = 0; count < 40; count += 1) {
        const current = await readSession();
        if (current === null) {
          setMessage("Could not read the renewal state — refresh.");
        } else if (current.pendingRenewal === undefined) {
          if (await completeFromOwnerRead()) return;
          setMessage("Could not read the renewal state — refresh.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      setMessage("The grant landed, but the plane is still converging. Keep this page open or refresh to resume.");
    } catch (error) {
      const fallback = error instanceof GrantAgentSessionError
        ? grantErrorMessage(error)
        : error instanceof Error ? error.message : "Renewal failed.";
      await reconcileAfterError(fallback, false);
    } finally { setBusy(false); }
  }, [completeFromOwnerRead, owner, props.agentId, readSession, reconcileAfterError]);

  const cancel = React.useCallback(async () => {
    if (pending === null) return;
    setBusy(true); setMessage(null);
    try {
      const envelope = await owner.signEnvelope("cancelRenewal", props.agentId, { grantDigest: pending.grantDigest });
      const response = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/session/renew/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
      const payload = await jsonResponse(response);
      if (!response.ok) throw new Error("Renewal cancellation was refused.");
      const data = responseData(payload);
      if (data !== null) setPending(data);
      setStep("cancelled");
      await props.refresh?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Renewal cancellation failed."); }
    finally { setBusy(false); }
  }, [owner, pending, props.agentId, props.refresh]);

  const revokeNewKey = React.useCallback(async () => {
    if (pending === null || owner.passkey === null || owner.walletAddress === undefined) return;
    setBusy(true); setMessage(null);
    try {
      const result = await revokeAgentSession({ record: owner.passkey, ownerViewWalletAddress: owner.walletAddress as Address, sessionPublicKey: pending.sessionPublicKey });
      if (result.status === "FAILED") throw new Error("The new-key revoke failed; retry after checking the relay.");
      await readSession();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The new key could not be revoked."); }
    finally { setBusy(false); }
  }, [owner, pending, readSession]);

  if (props.sessionExpiresAt === null || props.sessionExpiresAt === undefined) return null;

  if (props.kind === "trade" || props.kind === "grid" || props.kind === "lp") {
    if (!expired(props.sessionExpiresAt) && step === "idle") return <p data-testid="renewal-before-expiry" style={{ color: "var(--text-subtle)", font: "var(--type-mono-xs)" }}>Renewal opens when the session ends.</p>;
  }
  if (!expired(props.sessionExpiresAt) && pending === null && step === "idle") return null;

  return <section data-testid="session-renew" style={{ margin: "12px 0", padding: 14, border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <div><strong>Renew session</strong><div style={{ color: "var(--text-subtle)", fontSize: 12, marginTop: 4 }}>{preview?.universe?.tokens ? `${preview.universe.tokens.length} tokens · ${preview.universe.held ?? 0} held kept · ${(preview.universe.dropped ?? []).length} dropped` : "Seven days · two passkey prompts"}</div></div>
      {step === "idle" ? <Button size="sm" onClick={() => { setStep("preview"); void readSession(); }}>Renew</Button> : null}
    </div>
    {step === "preview" ? <div style={{ marginTop: 12 }}><p>Funding required: {preview?.funding?.requiredWei ?? "unavailable"} wei. Preview the trade universe, then sign the renewal.</p><Button size="sm" disabled={busy} onClick={() => void start()}>Sign renewal</Button></div> : null}
    {step === "signing" ? <p role="status" style={{ marginTop: 12 }}>Waiting for the renewal signature…</p> : null}
    {step === "granting" ? <p role="status" style={{ marginTop: 12 }}>Granting the new session key…</p> : null}
    {step === "retry" ? <div style={{ marginTop: 12 }}><p role="status">Retrying the pending renewal — the reserved key expires {pending?.expiry === undefined ? "on an unavailable date" : `${dateText(pending.expiry)} (${remainingText(pending.expiry)})`}. Each retry signs one more grant of the same key.</p><Button size="sm" disabled={busy} onClick={() => void start()}>Retry grant</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel renewal</Button></div> : null}
    {step === "retryExpired" ? <p role="status" style={{ marginTop: 12 }}>{message ?? (pending?.expiry === undefined ? "Retry closed." : `Retry closed: the reserved key expires ${dateText(pending.expiry)}; a fresh renewal opens after that.`)}</p> : null}
    {step === "converging" ? <div style={{ marginTop: 12 }}><p role="status">Converging: {preview?.renewalPhase ?? pending?.phase ?? "granting"}{preview?.quiescing ? ` · ${preview.quiescing}` : ""}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel renewal</Button></div> : null}
    {step === "done" ? <p role="status" style={{ marginTop: 12 }}>Session renewed until {completedExpiresAt === null ? "the recorded expiry" : dateText(completedExpiresAt)}.</p> : null}
    {step === "cancelled" ? <div style={{ marginTop: 12 }}><p role="status">Renewal cancelled. The agent remains on its expired session.</p>{pending?.coverageLossToken === undefined ? null : <p>Coverage changed; retry after resolving {pending.coverageLossToken}.</p>}{pending?.authorityObserved === true || revokeInstructions(pending?.onChainRevoke) !== null ? <><p>Revoke the new key to retire the cancelled renewal.</p>{(() => { const instructions = revokeInstructions(pending?.onChainRevoke); return instructions === null ? null : <ol>{instructions.calls.map((call, index) => <li key={`${call.to}-${index}`}><span>{call.note}</span><br /><code>{call.to}</code><br /><code>{call.data}</code></li>)}</ol>; })()}<Button size="sm" disabled={busy} onClick={() => void revokeNewKey()}>Revoke new key</Button></> : pending?.cancelReason === "owner" ? <Button size="sm" disabled={busy} onClick={() => void start()}>Retry renewal</Button> : null}</div> : null}
    {message ? <p role="alert" style={{ color: "var(--loss)", marginTop: 10 }}>{message}</p> : null}
  </section>;
}

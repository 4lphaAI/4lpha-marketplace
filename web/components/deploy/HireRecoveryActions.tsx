"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/design-system";
import { useOwnerActions } from "@/lib/exec/use-owner-actions";
import { accountHireStorage } from "@/lib/exec/account-hire-storage";
import type { HireSessionView } from "@/lib/altana/hire-state";
import { cancelGridHire, cancellationMessage, cancellationRecorded, forgetHire } from "@/lib/altana/grid-hire-recovery";

/** Provisioning has its own owner action; ordinary Remove cannot accept it. */
export function HireRecoveryActions({ agentId, readHeaders, go, storageKey = "4lpha:grid-hire:v1", deployPath = "/deploy/grid", onCancelled }: {
  readonly agentId: string;
  readonly readHeaders: Readonly<Record<string, string>>;
  readonly go: (route: string) => void;
  readonly storageKey?: string;
  readonly onCancelled?: (agentId: string) => void;
  readonly deployPath?: "/deploy/grid" | "/deploy/lp" | "/deploy/lending" | "/deploy/trading";
}) {
  const { signEnvelope, ownerAddress } = useOwnerActions();
  const storage = React.useMemo(() => accountHireStorage(typeof window === "undefined" ? undefined : window.localStorage, ownerAddress), [ownerAddress]);
  const [session, setSession] = useState<HireSessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const cancelling = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    if (cancelling.current) return;
    const controller = new AbortController();
    void fetch(`/api/agents/${encodeURIComponent(agentId)}/session`, { headers: readHeaders, cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { data?: HireSessionView };
        if (current !== generation.current || !response.ok || payload.data === undefined) return;
        setSession(payload.data);
        if (cancellationRecorded(payload.data)) forgetHire(storage, agentId, storageKey);
      }).catch(() => undefined);
    return () => { generation.current += 1; controller.abort(); };
  }, [agentId, readHeaders, storageKey, storage]);

  const cancel = async () => {
    if (cancelling.current) return;
    cancelling.current = true;
    generation.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await cancelGridHire({
        agentId,
        signEnvelope,
        storage,
        storageKey,
      });
      if (mounted.current) setSession(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Cancellation could not be recorded.");
    } finally {
      cancelling.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const cancelled = cancellationRecorded(session);
  useEffect(() => {
    if (cancelled) onCancelled?.(agentId);
  }, [cancelled, agentId, onCancelled]);
  return <div style={{ display: "grid", gap: 8, maxWidth: 390 }}>
    <span role="status" style={{ font: "var(--type-body-sm)", color: "var(--text-subtle)" }}>
      {error ?? (cancelled && session !== null ? cancellationMessage(session) : "Setup incomplete. The session grant has not been verified.")}
    </span>
    <div style={{ display: "flex", gap: 8 }}>
      {cancelled
        ? <Button variant="secondary" onClick={() => go(deployPath)}>Back to deploy</Button>
        : <Button variant="danger" disabled={busy} onClick={() => void cancel()}>{busy ? "Cancelling…" : "Cancel hire"}</Button>}
    </div>
  </div>;
}

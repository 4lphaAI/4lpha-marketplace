"use client";
import React from "react";
import { Button } from "@/design-system";
import { accountTransition, activateAccount, rememberedAccounts, retainUnsavedAccount } from "@/lib/exec/account-switch";
import { passkeyRpId, type StoredPasskey } from "@/lib/exec/passkey";

export function AccountSwitcher({ active, disabled = false }: { readonly active: StoredPasskey | null; readonly disabled?: boolean }) {
  const [mode, setMode] = React.useState<"switch" | "create" | null>(null);
  const [accounts, setAccounts] = React.useState<StoredPasskey[]>([]);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<StoredPasskey | null>(null);
  const running = React.useRef(false);
  const run = async (getRecord: () => Promise<StoredPasskey>) => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(null);
    try {
      await accountTransition(async () => {
        const record = await getRecord();
        retainUnsavedAccount();
        setPending(record);
        await activateAccount(record);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account change failed. Your current account is unchanged.");
    } finally { running.current = false; setBusy(false); }
  };
  const open = (next: "switch" | "create") => {
    setError(null);
    try { setAccounts(rememberedAccounts().filter((r) => r.rpId === passkeyRpId())); setMode(next); }
    catch { setError("Browser storage is unavailable. Enable site storage to manage accounts."); }
  };
  return <section aria-label="Account management" style={{ marginBottom: 20 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {active?.label && <span style={{ marginRight: "auto", color: "var(--text-muted)" }}>{active.label}</span>}
      <Button variant="secondary" disabled={disabled || busy || pending !== null} onClick={() => open("switch")}>Switch account</Button>
      <Button variant="secondary" disabled={disabled || busy || pending !== null} onClick={() => open("create")}>Create account</Button>
    </div>
    {mode && <div style={{ marginTop: 12, padding: 16, border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)" }}>
      <p style={{ marginTop: 0, color: "var(--text-muted)" }}>Each account has its own passkey and agent wallet. Connected wallets only fund it. Switching changes all tabs; existing agents keep running and submitted transactions continue.</p>
      {mode === "switch" ? <div style={{ display: "grid", gap: 8 }}>
        {accounts.map((record) => <Button key={record.credentialId} variant="secondary" disabled={busy || pending !== null || disabled || record.credentialId === active?.credentialId}
          onClick={() => void run(async () => record)}>
          {record.label || "Account"} · {record.walletAddress || "No agent wallet"}{record.credentialId === active?.credentialId ? " · Current" : ""}
        </Button>)}
        <Button variant="primary" disabled={busy || pending !== null || disabled} onClick={() => void run(async () => (await import("@/lib/altana/client")).recoverWalletFromPasskey())}>Use another passkey</Button>
      </div> : <form onSubmit={(event) => {
        event.preventDefault();
        const label = name.trim();
        if (!label || label.length > 64 || /[\x00-\x1f\x7f]/u.test(label)) { setError("Enter an account name, up to 64 characters."); return; }
        void run(async () => (await import("@/lib/altana/client")).createPasskeyWallet({ name: label, label }));
      }}>
        <label style={{ display: "grid", gap: 8 }}>Account name<input autoFocus value={name} maxLength={64} required disabled={busy || pending !== null || disabled}
          onChange={(event) => setName(event.target.value)} placeholder="e.g. Trading account" style={{ padding: 10, color: "var(--ink-1)", background: "var(--raised)", border: "1px solid var(--line-1)", borderRadius: 6 }} /></label>
        <p style={{ color: "var(--text-muted)" }}>Creates a new, empty wallet with a separate passkey. Your existing account and funds stay where they are. Keep this browser’s site data until the new wallet is registered on-chain; recovery on another device may be unavailable before then.</p>
        <Button type="submit" variant="primary" disabled={busy || pending !== null || disabled}>{busy ? "Waiting for your device…" : "Create with passkey"}</Button>
      </form>}
      {!pending && <Button variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>}
    </div>}
    {pending && !busy && <div role="status" style={{ marginTop: 12 }}>
      <p>Account metadata is ready for {pending.walletAddress ?? "this passkey"}. Keep this page open and retry activation; no new passkey will be created.</p>
      <Button variant="primary" disabled={disabled} onClick={() => void run(async () => pending)}>Retry activation</Button>
    </div>}
    {error && <p role="alert" style={{ color: "var(--warning)" }}>{error}</p>}
  </section>;
}

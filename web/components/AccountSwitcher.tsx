"use client";
import React from "react";
import { Button, IconButton } from "@/design-system";
import { accountTransition, activateAccount, rememberedAccounts, renameAccount, retainUnsavedAccount, savedAccountLabel, validAccountLabel } from "@/lib/exec/account-switch";
import { passkeyRpId, type StoredPasskey } from "@/lib/exec/passkey";

const INPUT_STYLE: React.CSSProperties = { padding: 10, color: "var(--ink-1)", background: "var(--raised)", border: "1px solid var(--line-1)", borderRadius: 6 };

function PencilIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.2 2.3a1.5 1.5 0 0 1 2.1 2.1L5.5 12.2 2.5 13l.8-3z" /><path d="M10 3.5l2.5 2.5" />
  </svg>;
}

export function AccountSwitcher({ active, disabled = false }: { readonly active: StoredPasskey | null; readonly disabled?: boolean }) {
  const [mode, setMode] = React.useState<"switch" | "create" | null>(null);
  const [accounts, setAccounts] = React.useState<StoredPasskey[]>([]);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<StoredPasskey | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [activeLabel, setActiveLabel] = React.useState<string | undefined>(undefined);
  const running = React.useRef(false);
  // Read after mount: the saved directory name can differ from the label frozen into the active record.
  const refreshActiveLabel = React.useCallback(() => {
    if (!active) { setActiveLabel(undefined); return; }
    try { setActiveLabel(savedAccountLabel(active)); } catch { setActiveLabel(active.label); }
  }, [active]);
  React.useEffect(refreshActiveLabel, [refreshActiveLabel]);
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
  const rename = async (record: StoredPasskey) => {
    if (running.current || disabled) return;
    if (validAccountLabel(draft) === null) { setError("Enter an account name, up to 64 characters."); return; }
    running.current = true; setBusy(true); setError(null);
    try {
      await accountTransition(async () => { renameAccount(record, draft); });
      setAccounts(rememberedAccounts().filter((r) => r.rpId === passkeyRpId()));
      setEditing(null);
      refreshActiveLabel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Rename failed. The saved name is unchanged.");
    } finally { running.current = false; setBusy(false); }
  };
  const open = (next: "switch" | "create") => {
    setError(null); setEditing(null);
    try { setAccounts(rememberedAccounts().filter((r) => r.rpId === passkeyRpId())); setMode(next); }
    catch { setError("Browser storage is unavailable. Enable site storage to manage accounts."); }
  };
  const shownLabel = activeLabel ?? active?.label;
  return <section aria-label="Account management" style={{ marginBottom: 20 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {shownLabel && <span style={{ marginRight: "auto", color: "var(--text-muted)" }}>{shownLabel}</span>}
      <Button variant="secondary" disabled={disabled || busy || pending !== null} onClick={() => open("switch")}>Switch account</Button>
      <Button variant="secondary" disabled={disabled || busy || pending !== null} onClick={() => open("create")}>Create account</Button>
    </div>
    {mode && <div style={{ marginTop: 12, padding: 16, border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)" }}>
      <p style={{ marginTop: 0, color: "var(--text-muted)" }}>Each account has its own passkey and agent wallet. Connected wallets only fund it. Switching changes all tabs; existing agents keep running and submitted transactions continue.</p>
      {mode === "switch" ? <div style={{ display: "grid", gap: 8 }}>
        {accounts.map((record) => editing === record.credentialId
          ? <form key={record.credentialId} onSubmit={(event) => { event.preventDefault(); void rename(record); }} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input aria-label="Account name" autoFocus value={draft} maxLength={64} required disabled={busy || disabled}
              onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }}
              style={{ ...INPUT_STYLE, flex: 1, minWidth: 160 }} />
            <Button type="submit" variant="primary" disabled={busy || disabled}>Save</Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <p style={{ flexBasis: "100%", margin: 0, color: "var(--text-muted)" }}>The new name is saved in this browser only. Your device's passkey list keeps the name it was created with.</p>
          </form>
          : <div key={record.credentialId} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="secondary" style={{ flex: 1, minWidth: 0 }} disabled={busy || pending !== null || disabled || record.credentialId === active?.credentialId}
              onClick={() => void run(async () => record)}>
              {record.label || "Account"} · {record.walletAddress || "No agent wallet"}{record.credentialId === active?.credentialId ? " · Current" : ""}
            </Button>
            <IconButton label={`Rename ${record.label || "account"}`} variant="bordered" disabled={busy || pending !== null || disabled}
              onClick={() => { setError(null); setDraft(record.label ?? ""); setEditing(record.credentialId); }}><PencilIcon /></IconButton>
          </div>)}
        <Button variant="primary" disabled={busy || pending !== null || disabled} onClick={() => void run(async () => (await import("@/lib/altana/client")).recoverWalletFromPasskey())}>Use another passkey</Button>
      </div> : <form onSubmit={(event) => {
        event.preventDefault();
        const label = validAccountLabel(name);
        if (label === null) { setError("Enter an account name, up to 64 characters."); return; }
        void run(async () => (await import("@/lib/altana/client")).createPasskeyWallet({ name: label, label }));
      }}>
        <label style={{ display: "grid", gap: 8 }}>Account name<input autoFocus value={name} maxLength={64} required disabled={busy || pending !== null || disabled}
          onChange={(event) => setName(event.target.value)} placeholder="e.g. Trading account" style={INPUT_STYLE} /></label>
        <p style={{ color: "var(--text-muted)" }}>Creates a new, empty wallet with a separate passkey. Your existing account and funds stay where they are. Keep this browser’s site data until the new wallet is registered on-chain; recovery on another device may be unavailable before then.</p>
        <Button type="submit" variant="primary" disabled={busy || pending !== null || disabled}>{busy ? "Waiting for your device…" : "Create with passkey"}</Button>
      </form>}
      {!pending && <Button variant="secondary" disabled={busy} onClick={() => { setMode(null); setEditing(null); }}>Cancel</Button>}
    </div>}
    {pending && !busy && <div role="status" style={{ marginTop: 12 }}>
      <p>Account metadata is ready for {pending.walletAddress ?? "this passkey"}. Keep this page open and retry activation; no new passkey will be created.</p>
      <Button variant="primary" disabled={disabled} onClick={() => void run(async () => pending)}>Retry activation</Button>
    </div>}
    {error && <p role="alert" style={{ color: "var(--warning)" }}>{error}</p>}
  </section>;
}

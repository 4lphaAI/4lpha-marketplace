"use client";
/* Account panel "Observe an Agentic Wallet", laid out after the Claude Design export
   (ui_kits/marketplace ObserveAgenticWallet). Read-only: it only links to the public
   /agentic/<wallet> page; each remembered wallet's name and state come from that
   same public projection, never invented. */
import * as React from "react";
import { AgenticWalletBadge, Button, Icon, Input, StatusBadge } from "@/design-system";
import { agenticRequest } from "@/lib/agentic";

type Summary = { name: string; status: string } | null;
const mono: React.CSSProperties = { font: "var(--weight-regular) var(--text-xs)/1 var(--font-mono)", color: "var(--text-subtle)" };
const short = (address: string) => address.slice(0, 6) + "…" + address.slice(-4);

function badge(status: string): { status: string; label?: string } {
  if (status === "ended") return { status: "danger", label: "Ended" };
  if (status === "running" || status === "entries-stopped") return { status: "live" };
  return { status: "paused", label: status.replace(/-/gu, " ") };
}

export function ObserveAgenticWallet({ wallets, go }: { wallets: readonly string[]; go(route: string): void }) {
  const [address, setAddress] = React.useState("");
  const [summaries, setSummaries] = React.useState<Readonly<Record<string, Summary>>>({});
  const valid = /^0x[0-9a-f]{40}$/i.test(address);
  React.useEffect(() => {
    let active = true;
    for (const wallet of wallets) {
      void agenticRequest<{ agent?: { name?: unknown; status?: unknown } | null }>("wallets/" + wallet).then((value) => {
        const agent = value.agent;
        const summary = agent && typeof agent.name === "string" && typeof agent.status === "string" ? { name: agent.name, status: agent.status } : null;
        if (active) setSummaries((previous) => ({ ...previous, [wallet]: summary }));
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [wallets]);
  return <section aria-label="Observe an Agentic Wallet" style={{ border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", padding: "16px 20px", marginBottom: 20, display: "grid", gap: 14 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <AgenticWalletBadge />
      <span style={{ ...mono, marginLeft: "auto", fontWeight: 500, fontSize: 12, color: "var(--ink-1)" }}>Read-only</span>
    </div>
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <span style={{ flex: "1 1 360px", minWidth: 0 }}><Input mono placeholder="0x..." aria-label="Agentic Wallet address" value={address} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAddress(event.target.value)} /></span>
      <Button variant="secondary" disabled={!valid} onClick={() => go("/agentic/" + address.toLowerCase())}>Observe Agentic Wallet</Button>
    </div>
    {wallets.length > 0 ? <div style={{ display: "grid", gap: 8 }}>
      <span style={{ font: "var(--type-eyebrow)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", fontSize: 12, color: "var(--ink-1)" }}>Your Agentic Wallets</span>
      {wallets.map((wallet) => {
        const summary = summaries[wallet] ?? null;
        const state = summary === null ? null : badge(summary.status);
        return <button key={wallet} type="button" title={wallet} onClick={() => go("/agentic/" + wallet)}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", cursor: "pointer", textAlign: "left", minWidth: 0 }}>
          {state === null ? null : <StatusBadge status={state.status} pill {...(state.label === undefined ? {} : { label: state.label })} />}
          <span style={{ font: "var(--weight-medium) var(--text-sm)/1 var(--font-sans)", color: "var(--ink-1)" }}>{summary?.name ?? "Agentic Wallet"}</span>
          <span style={mono}>{short(wallet)}</span>
          <span style={{ marginLeft: "auto", color: "var(--text-subtle)", display: "grid" }}><Icon name="chevron-right" size={14} /></span>
        </button>;
      })}
    </div> : null}
  </section>;
}

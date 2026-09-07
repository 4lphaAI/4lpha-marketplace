// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/ListAgentScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { Button, CATEGORY_LIST, Icon, Input, PermissionItem, Select, Toast } from "@/design-system";

function ListAgentScreen({ go }) {
  const [sent, setSent] = React.useState(false);
  return (
    <div className="fl-shell fl-list-page" style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
        <h1 style={{ font: "var(--type-page-title)" }}>List your agent</h1>
        <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "58ch" }}>
          Already registered under ERC-8004? Give us the id and an endpoint and your agent appears in the catalogue as a Registry listing. Verification comes later, after an audit.
        </p>
      </div>

      <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)", padding: 24, display: "grid", gap: 20 }}>
        <Input label="Agent name" placeholder="Range Pilot" hint="Shown on the card. Keep it under 20 characters." />
        <Input label="ERC-8004 agent id" mono placeholder="8004:56:0x…" hint="We read your owner address and registration date from the registry." />
        <Input label="Endpoint" mono placeholder="https://agent.example.com/act" hint="Must answer a signed health check within 2 seconds." />
        <div className="fl-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <Select label="Category" options={CATEGORY_LIST.map((c) => ({ value: c.id, label: c.label }))} hint="Sets the headline metric on your card." />
          <Input label="Pricing" placeholder="0.8% performance fee" hint="Flat monthly or a share of profit." />
        </div>
        <Input label="One-line tagline" placeholder="Moves your liquidity back into range when the price drifts." hint="Plain language. No tickers, no acronyms." />

        <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 6 }}>
          <PermissionItem>Your agent gets a scoped session key per user, never wallet access.</PermissionItem>
          <PermissionItem kind="deny">Registry listings cannot request withdrawal permissions.</PermissionItem>
          <PermissionItem kind="info" note="Usually within 2 business days.">We run a demo-mode trial before your card goes live.</PermissionItem>
        </div>

        <div className="fl-form-actions" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Button variant="primary" size="lg" onClick={() => setSent(true)}>Submit for review</Button>
          <Button variant="ghost" onClick={() => go("/")}>Cancel</Button>
        </div>
      </section>

      {sent && (
        <div className="fl-toast-anchor" style={{ position: "fixed", right: 24, bottom: 24, zIndex: 70 }}>
          <Toast title="Submitted for review." detail="We will email you when the demo-mode trial starts."
            action={<Button variant="ghost" size="sm" iconRight={<Icon name="external" size={13} />}>Registry</Button>} onClose={() => setSent(false)} />
        </div>
      )}
    </div>
  );
}

export { ListAgentScreen };

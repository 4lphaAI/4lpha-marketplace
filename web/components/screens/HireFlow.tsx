// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/HireFlow.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { Button, Category, Checkbox, Icon, Input, Modal, Num, PermissionItem, SegmentedToggle, StepIndicator } from "@/design-system";

const STEPS = ["Fund", "Permissions", "Confirm"];

function HireFlow({ agent, sheet, onClose, onDone }) {
  const [step, setStep] = React.useState(0);
  const [amount, setAmount] = React.useState("500");
  const [mode, setMode] = React.useState("demo");
  const [notify, setNotify] = React.useState(true);
  const [done, setDone] = React.useState(false);
  const cat = Category(agent.categoryId);
  const cap = Math.max(1, Math.round(Number(amount || 0) / 2));

  if (done) {
    return (
      <Modal sheet={sheet} title="" header={<span className="fl-modal__title">Agent hired</span>} onClose={onClose}
        footer={<><Button variant="ghost" onClick={onClose}>Back to marketplace</Button><span style={{ flex: 1 }} /><Button variant="primary" size="lg" onClick={onDone}>Open My agents</Button></>}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "8px 0 4px", textAlign: "center" }}>
          <span className="fl-card__glyph" style={{ width: 44, height: 44, color: "var(--live)", borderColor: "var(--live)", background: "var(--live-tint)" }}>
            <Icon name="success" size={22} />
          </span>
          <span style={{ font: "var(--type-section-title)" }}>Agent is now watching your position.</span>
          <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "40ch" }}>
            {agent.name} is {mode === "live" ? "live" : "running in demo mode"} with ${amount} USDT delegated. You will see its first action in your run log.
          </p>
        </div>
        <div style={{ borderTop: "1px solid var(--line-1)" }}>
          <PermissionItem kind="info" note="Revoking is a single on-chain transaction.">You can pause or revoke it at any time from My agents.</PermissionItem>
        </div>
      </Modal>
    );
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>{step === 0 ? "Cancel" : "Back"}</Button>
      <span style={{ flex: 1 }} />
      <Button variant="primary" size="lg" onClick={() => (step === 2 ? setDone(true) : setStep(step + 1))}>
        {step === 0 ? "Continue" : step === 1 ? "Grant and continue" : `Confirm and hire ${agent.name}`}
      </Button>
    </>
  );

  return (
    <Modal sheet={sheet} onClose={onClose} footer={footer}
      header={<StepIndicator steps={STEPS} current={step} compact={sheet} />}>
      {step === 0 && (
        <>
          <Input label="Capital to delegate" mono prefix="$" suffix="USDT" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            hint="Held in your agent wallet, which only your own credential controls. Withdraw arrives with passkey wallets." />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="fl-field__label">Mode</span>
            <SegmentedToggle accent value={mode} onChange={setMode} options={[{ value: "demo", label: "Demo" }, { value: "live", label: "Live" }]} />
            <span className="fl-field__hint">{mode === "demo" ? "Demo mode uses live prices and no real funds. Switch to live whenever you want." : "Live mode moves real funds inside the limits you set next."}</span>
          </div>
        </>
      )}

      {step === 1 && (
        <div>
          <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", marginBottom: 6 }}>
            {agent.name} will be able to do exactly this, and nothing else:
          </p>
          <PermissionItem>Spend up to <b>{cap} USDT</b> per day from the ${amount} you delegated.</PermissionItem>
          <PermissionItem>Trade only <b>{agent.pair || "BNB / USDT"}</b> on {agent.protocol}.</PermissionItem>
          <PermissionItem kind="deny">Send funds to any wallet but yours.</PermissionItem>
          <PermissionItem kind="deny">Touch the rest of your wallet.</PermissionItem>
          <PermissionItem kind="info" note="Revoking is a single on-chain transaction.">You can revoke anytime.</PermissionItem>
          <div style={{ paddingTop: 14 }}>
            <Checkbox checked={notify} onChange={setNotify}>Email me if this agent pauses itself.</Checkbox>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, border: "1px solid var(--line-1)", borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)" }}>
            <span className="fl-card__glyph" style={{ color: cat.color, borderColor: cat.color, background: cat.tint }}><Icon name={cat.icon} size={17} /></span>
            <div>
              <div className="fl-card__name">{agent.name}</div>
              <div className="fl-cat" style={{ marginTop: 3 }}>{cat.label} · {agent.protocol}</div>
            </div>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {[["Capital delegated", `$${amount} USDT`], ["Mode", mode === "live" ? "Live" : "Demo"], ["Daily spending limit", `${cap} USDT`], ["Fee", `${agent.price} ${agent.priceUnit}`], ["You keep control of", "Withdrawals and revoking"]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, font: "var(--type-body-md)" }}>
                <span style={{ color: "var(--text-subtle)" }}>{k}</span><Num value={v} tone="flat" style={{ color: "var(--ink-1)" }} />
              </div>
            ))}
          </div>
          <PermissionItem kind="info" note="One signature. No token approvals to unknown contracts.">Confirming grants a scoped session key, not wallet access.</PermissionItem>
        </div>
      )}
    </Modal>
  );
}

export { HireFlow };

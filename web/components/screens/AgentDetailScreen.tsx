// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/AgentDetailScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { ActivityRow, Button, Category, ChartFrame, Icon, MetricTile, Num, PermissionItem, PROTOCOL_LOGOS, SegmentedToggle, TierBadge } from "@/design-system";
import { RESOURCES } from "@/lib/design-resources";
import { GridLadderExplainer } from "@/components/explainers/GridLadderExplainer";
import { TradeExplainer } from "@/components/explainers/TradeExplainer";
import { RangeExplainer } from "@/components/explainers/RangeExplainer";
import { CompoundExplainer } from "@/components/explainers/CompoundExplainer";
import { LendingExplainer } from "@/components/explainers/LendingExplainer";
import { agentDeployKind } from "@/lib/design-data";

/** A protocol/venue name renders as its logo when the design ships one. */
function ProtocolMark({ name }) {
  return PROTOCOL_LOGOS[name]
    ? <img src={PROTOCOL_LOGOS[name]} alt={name} title={name} className="fl-card__protocol-logo" />
    : <span>{name}</span>;
}

function Panel({ title, action, children, pad = true }) {
  return (
    <section style={{ border: "1px solid var(--border-card)", borderRadius: "var(--radius-md)", background: "var(--surface-card)" }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line-1)" }}>
          <span style={{ font: "var(--type-card-title)" }}>{title}</span>{action}
        </div>
      )}
      <div style={pad ? { padding: 20 } : undefined}>{children}</div>
    </section>
  );
}

function AgentDetailScreen({ agent, go, onHire }) {
  const cat = Category(agent.categoryId);
  const isAegisLP = agent.id === "aegis-lp";
  const [range, setRange] = React.useState("30d");
  const metrics = agent.metrics || [
    { label: cat.metricLabel, value: agent.metricValue, tone: agent.metricTone === "flat" ? "flat" : "profit", note: "on-chain" },
    { label: "Users hiring", value: String(agent.hiredCount), note: "right now" },
    { label: "Fee", value: agent.price, note: agent.priceUnit },
    { label: "Protocol", value: agent.protocol, note: "BNB Chain" },
  ];
  return (
    <div className="fl-shell fl-agent-detail-page">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />} onClick={() => go("/")}>Marketplace</Button>

      <div className="fl-detail-hero" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 32, flexWrap: "wrap", margin: "16px 0 28px" }}>
        <div style={{ display: "flex", gap: 16, minWidth: 0 }}>
          <span className="fl-card__glyph" style={{ width: 44, height: 44, color: cat.color, borderColor: cat.color, background: cat.tint }}>
            <Icon name={cat.icon} size={22} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ font: "var(--type-page-title)" }}>{agent.name}</h1>
              <TierBadge tier={isAegisLP ? "verified" : agent.tier} />
            </div>
            <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "62ch" }}>{agent.tagline}</p>
            <div className="fl-card__meta" style={{ padding: 0 }}>
              <ProtocolMark name={agent.protocol} />
              {(agent.relatedProtocols || []).map((n) => <ProtocolMark key={n} name={n} />)}
              <span>{cat.label}</span>
            </div>
          </div>
        </div>
        <div className="fl-detail-cta" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <Button variant="primary" size="lg" onClick={() => go(`/deploy/${agentDeployKind(agent)}`)} disabled={agent.disabled}>{agent.disabled ? "At capacity" : "Hire Now"}</Button>
          <span style={{ font: "var(--weight-regular) var(--text-sm)/1 var(--font-sans)", color: "var(--text-subtle)" }}>Takes 3 steps. You can revoke anytime.</span>
        </div>
      </div>

      <div className="fl-metrics-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {metrics.map((m) => <MetricTile key={m.label} {...m} />)}
      </div>

      <div className="fl-detail-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.55fr) minmax(0,1fr)", gap: 16, marginTop: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {agent.categoryId === "grid"
            ? <GridLadderExplainer pair={agent.pair || "BNB / USDT"} protocol={agent.protocol} budget={agent.dailyCap || "500 USDT"} />
            : agent.explainer === "compound" ? <CompoundExplainer pair={agent.pair || "BNB / USDT"} protocol={agent.protocol} />
            : agent.explainer === "trade" ? <TradeExplainer pair={agent.pair || "BNB / USDT"} protocol={agent.protocol} />
            : agent.explainer === "lending" ? <LendingExplainer protocol={agent.protocol} />
            : agent.categoryId === "lp" ? <RangeExplainer pair={agent.pair || "BNB / USDT"} protocol={agent.protocol} />
            : <>
          <ChartFrame title="Cumulative PnL" value={agent.metricValue} valueTone="profit" height={180}
            right={<SegmentedToggle value={range} onChange={setRange} options={["7d", "30d", "90d"]} />}
            series={agent.series || [0, 12, 9, 30, 26, 48, 62, 58, 84, 96, 92, 118]}
            axis={["12 Jun", "27 Jun", "Today"]} />

          <Panel title="On-chain activity" pad={false}
            action={<a href="https://bscscan.com" target="_blank" rel="noreferrer" style={{ font: "var(--type-mono-xs)", display: "flex", gap: 5, alignItems: "center" }}>BscScan<Icon name="external" size={12} /></a>}>
            <div>
              {(agent.activity || []).map((r, i) => <ActivityRow key={i} {...r} href="https://bscscan.com" />)}
              {!agent.activity && <div style={{ padding: 20, font: "var(--type-body-md)", color: "var(--text-subtle)" }}>No public activity in the last 24 hours.</div>}
            </div>
          </Panel>
            </>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Panel title="What this agent is allowed to do">
            {agent.explainer === "lending" ? (
              <>
                <PermissionItem>Watch the health factor on your {agent.protocol} account — no other protocol, no other wallet.</PermissionItem>
                <PermissionItem>Repay your largest debt market first when your health factor crosses your trigger line.</PermissionItem>
                <PermissionItem>Use only the wallet balance held for this — never a new borrow, never your other assets.</PermissionItem>
                <PermissionItem>Re-read the health factor on-chain after repaying, and stop once it clears your target.</PermissionItem>
                <PermissionItem>Log every repay, with the transaction and the before/after health factor.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any wallet but yours.</PermissionItem>
                <PermissionItem kind="deny">Supply new collateral or open new borrows on its own.</PermissionItem>
              </>
            ) : agent.explainer === "trade" ? (
              <>
                <PermissionItem>Enter only pairs that match the selected model.</PermissionItem>
                <PermissionItem>Size each entry within your delegated capital and position limits.</PermissionItem>
                <PermissionItem>Buy and sell on {agent.protocol} inside your slippage cap.</PermissionItem>
                <PermissionItem>Take profit in stages and exit on stop loss.</PermissionItem>
                <PermissionItem>Close on your stop loss or max holding time, whichever comes first.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any wallet but yours.</PermissionItem>
                <PermissionItem kind="deny">Spend past the total capital you delegate, or raise its own limits.</PermissionItem>
              </>
            ) : agent.explainer === "compound" ? (
              <>
                <PermissionItem>Manage only the liquidity you delegate on {agent.protocol}.</PermissionItem>
                <PermissionItem>Collect the swap fees that position has earned.</PermissionItem>
                <PermissionItem>Swap the part of those fees needed to match the pool ratio.</PermissionItem>
                <PermissionItem>Add the fees back into the same position.</PermissionItem>
                <PermissionItem>Wait until unclaimed fees are worth more than gas to compound.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any wallet but yours.</PermissionItem>
                <PermissionItem kind="deny">Move your range, or add capital beyond what you delegate.</PermissionItem>
              </>
            ) : agent.categoryId === "lp" ? (
              <>
                <PermissionItem>Manage only the liquidity you delegate on {agent.protocol}.</PermissionItem>
                <PermissionItem>Move position to a new price range when price drifts outside band.</PermissionItem>
                <PermissionItem>Collect the fees earns and put them back in your positions.</PermissionItem>
                <PermissionItem>Swap between the two tokens only as much as re-ranging needs.</PermissionItem>
                <PermissionItem>Wait out your drift trigger and cooldown before it moves anything.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any wallet but yours.</PermissionItem>
                <PermissionItem kind="deny">Add liquidity beyond what you delegate.</PermissionItem>
              </>
            ) : (
              <>
                <PermissionItem>Minimum delegate capital is 0.0456 $BNB.</PermissionItem>
                <PermissionItem>Choose any pair on Panckeswap v3 with $WBNB leg.</PermissionItem>
                <PermissionItem>Place, settle and refill grid levels inside the price range you set.</PermissionItem>
                <PermissionItem>Profit from Volatility. Capitalizes on small price fluctuations.</PermissionItem>
                <PermissionItem>Close everything and stop at your take-profit or stop-loss.</PermissionItem>
                <PermissionItem kind="deny">Withdraw funds to any wallet but yours.</PermissionItem>
                <PermissionItem kind="deny">Touch anything outside the capital you delegate.</PermissionItem>
              </>
            )}
            <PermissionItem kind="info" note="Takes effect immediately, on-chain.">You can revoke this at any time.</PermissionItem>
          </Panel>

          <Panel title="Pricing">
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ font: "var(--weight-semibold) var(--text-3xl)/1 var(--font-mono)" }}>0%</span>
              <span style={{ font: "var(--type-body)", color: "var(--text-muted)" }}>performance fee</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <PermissionItem kind="info">Zero fees this month, include LLM model usage.</PermissionItem>
              <PermissionItem kind="info">Gas &amp; CMC x402 data is paid by the agent operator.</PermissionItem>
            </div>
          </Panel>

          <Panel title="On-chain identity">
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <img src={RESOURCES.erc8004} alt="ERC-8004" style={{ width: 48, height: 48 }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ font: "var(--type-body)", color: "var(--text-subtle)" }}>Standard</span>
                <span className="fl-num fl-num--flat" style={{ color: "var(--ink-1)", font: "var(--type-body)" }}>ERC-8004</span>
              </div>
            </div>
            <Button variant="secondary" size="sm" block iconRight={<Icon name="external" size={13} />}>View registry record</Button>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export { AgentDetailScreen, Panel };

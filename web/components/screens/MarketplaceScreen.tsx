// @ts-nocheck -- Ported design JSX, kept byte-identical on purpose. The export is
// untyped and its ~20 inline sub-components would each need a hand-written prop
// interface; annotating them would mean editing the very markup this port exists
// to preserve. Type safety stops at this boundary: KitApp, KitHeader, the design
// system declarations and lib/ are all fully checked.
"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/MarketplaceScreen.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { AgentCard, Button, CATEGORY_LIST, EmptyState, FilterChip } from "@/design-system";
import { AGENTS, agentDeployKind } from "@/lib/design-data";
import { DeployAgentSection } from "@/components/screens/DeployAgentScreen";

const MARKETPLACE_CARD_CSS = `
.fl-marketplace-page .fl-card__price-value--zero{display:inline-block;padding:0;border:0;background:transparent;letter-spacing:normal;position:static}
.fl-marketplace-page .fl-card__price-value--zero::before{content:none;animation:none}
.fl-marketplace-page .fl-card__price-unit{padding-left:0}
.fl-marketplace-page .fl-zerofee{position:relative;display:inline-flex;align-items:center;border-radius:999px;padding:3px 10px;isolation:isolate}
.fl-marketplace-page .fl-zerofee__ring{position:absolute;inset:0;border-radius:inherit;overflow:hidden}
.fl-marketplace-page .fl-zerofee__ring::before{content:"";position:absolute;inset:-60%;background:conic-gradient(from 0deg,transparent 0deg 250deg,var(--brand-hover) 285deg,var(--brand) 305deg,transparent 330deg 360deg);animation:fl-zerofee-spin 2.6s linear infinite}
.fl-marketplace-page .fl-zerofee__ring::after{content:"";position:absolute;inset:1.5px;border-radius:inherit;background:var(--surface-card)}
.fl-marketplace-page .fl-card:hover .fl-zerofee__ring::after{background:var(--surface-card-hover)}
.fl-marketplace-page .fl-card--registry .fl-zerofee__ring::after{background:var(--surface-sunken)}
.fl-marketplace-page .fl-zerofee__text{position:relative;z-index:1;font:var(--weight-semibold) var(--text-xs)/1 var(--font-mono);color:var(--brand);letter-spacing:.02em}
@keyframes fl-zerofee-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.fl-marketplace-page .fl-zerofee__ring::before{animation:none}}
`;

function MarketplaceScreen({ go, onHire, search = "" }) {
  const [filter, setFilter] = React.useState("all");
  const query = search.trim().toLocaleLowerCase();
  const list = AGENTS.filter((agent) => {
    const matchesFilter = filter === "all" || agent.categoryId === filter;
    if (!query) return matchesFilter;
    const searchable = [agent.name, agent.tagline, agent.protocol, agent.pair, agent.categoryId].filter(Boolean).join(" ").toLocaleLowerCase();
    return matchesFilter && searchable.includes(query);
  });
  const count = (id) => AGENTS.filter((a) => a.categoryId === id).length;

  return (
    <div className="fl-shell fl-marketplace-page">
      <style>{MARKETPLACE_CARD_CSS}</style>
      <DeployAgentSection go={go} />
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={{ font: "var(--type-page-title)" }}>Hire an agent</h1>
          <p style={{ font: "var(--type-body-md)", color: "var(--text-muted)", maxWidth: "56ch" }}>
            Autonomous agents that work your DeFi positions on BNB Chain.
          </p>
        </div>
      </div>

      <div className="fl-marketplace-filters" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "24px 0 20px" }}>
        <FilterChip active={filter === "all"} count={AGENTS.length} onClick={() => setFilter("all")} />
        {CATEGORY_LIST.map((c) => (
          <FilterChip key={c.id} categoryId={c.id} count={count(c.id)} active={filter === c.id} onClick={() => setFilter(c.id)} />
        ))}
      </div>

      {list.length ? (
        <div className="fl-grid">
          {list.map((a) => (
            <AgentCard key={a.id} {...a} onOpen={() => go(`/agent/${a.id}`)} onHire={() => go(`/deploy/${agentDeployKind(a)}`)} style={{ cursor: "pointer" }}
              onClick={(e) => { if (!e.target.closest("button")) go(`/agent/${a.id}`); }} />
          ))}
        </div>
      ) : (
        <EmptyState icon="search" title="No agents match these filters" action={<Button variant="primary" onClick={() => setFilter("all")}>Show all agents</Button>}>
          Try a different search or filter, or browse all {AGENTS.length} agents.
        </EmptyState>
      )}
    </div>
  );
}

export { MarketplaceScreen };

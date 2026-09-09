"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/KitHeader.jsx).
   The JSX body is unchanged; only the IIFE wrapper, the design-system
   namespace proxies and the window globals became real imports/exports. */
import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Button, Icon, Input } from "@/design-system";
import { RESOURCES } from "@/lib/design-resources";
import { TUTORIAL_PLAYLIST } from "@/lib/tutorials";

function KitHeader({ route, go, search, onSearchChange }: {
  route: string;
  go: (r: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const [netOpen, setNetOpen] = React.useState(false);
  const nav: Array<[string, string]> = [["/", "Marketplace"], ["/account", "Account"]];
  const isOn = (href: string) => route.startsWith(href) && (href !== "/" || route === "/");
  // `whiteSpace: nowrap` keeps a label and its external icon on one line: the
  // nav shares the header row with a flexible search field, so at 1280px the
  // links get compressed and a two-word or icon-bearing item would otherwise
  // wrap under itself. The search box absorbs the difference instead.
  const linkBase = { padding: "0 10px", height: 28, display: "flex", alignItems: "center", gap: 6, borderRadius: "var(--radius-sm)", font: "var(--weight-medium) var(--text-base)/1 var(--font-sans)", textDecoration: "none", whiteSpace: "nowrap" as const, flex: "0 0 auto" };
  return (
    <header className="fl-header">
      <a className="fl-brand" href="#" onClick={(e) => { e.preventDefault(); go("/"); }} style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none" }}>
        <img className="fl-brand__logo" src={RESOURCES.brandLogo} alt="4lpha" style={{ width: 150, height: 150, borderRadius: "var(--radius-sm)" }} />
      </a>
      <nav className="fl-primary-nav" aria-label="Primary navigation" style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {nav.map(([href, label]) => (
          <a key={href} href="#" className={"fl-navlink" + (isOn(href) ? " fl-navlink--active" : "")} onClick={(e) => { e.preventDefault(); go(href); }}
            style={{ ...linkBase, color: isOn(href) ? "var(--brand)" : "var(--text-muted)" }}>{label}</a>
        ))}
        <span aria-disabled="true" title="Available after the hackathon"
          style={{ ...linkBase, color: "var(--text-disabled)", background: "transparent", cursor: "not-allowed" }}>List your agent</span>
        <a href="https://x.com/4lpha_agent" target="_blank" rel="noreferrer" className="fl-navlink" style={{ ...linkBase, color: "var(--text-muted)" }}>X</a>
        <a href="https://docs.4lpha.tech/" target="_blank" rel="noreferrer" className="fl-navlink" style={{ ...linkBase, color: "var(--text-muted)" }}>Docs<Icon name="external" size={12} /></a>
        <a href={TUTORIAL_PLAYLIST} target="_blank" rel="noreferrer" className="fl-navlink" style={{ ...linkBase, color: "var(--text-muted)" }}>Tutorial<Icon name="external" size={12} /></a>
      </nav>
      <div className="fl-header-search" style={{ flex: 1, maxWidth: 320 }}>
        <Input
          icon={<Icon name="search" size={15} />}
          placeholder="Search agents"
          aria-label="Search agents"
          type="search"
          value={search}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onSearchChange(event.target.value)}
        />
      </div>
      <div className="fl-header-actions" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        {/* Network selector. BNB Chain is the only network this plane serves, so
            the menu lists exactly one option — the design shows it rather than
            implying a choice the app does not have. */}
        <span style={{ position: "relative" }}>
          <button type="button" aria-haspopup="listbox" aria-expanded={netOpen} onClick={() => setNetOpen(!netOpen)} className="fl-netbtn">
            <img src={RESOURCES.bnbChain} alt="" style={{ width: 16, height: 16, flex: "0 0 auto" }} />
            <span>BNB CHAIN</span>
            <Icon name="chevron-down" size={14} />
          </button>
          {netOpen && (
            <ul role="listbox" className="fl-netmenu">
              <li role="option" aria-selected="true" className="fl-netmenu__opt">
                <img src={RESOURCES.bnbChain} alt="" style={{ width: 16, height: 16, flex: "0 0 auto" }} />
                <span>BNB CHAIN</span>
              </li>
            </ul>
          )}
        </span>
        {/* The design shipped a hard-coded `connected` boolean and a frozen
            address. The markup below is the design's, verbatim; only the state
            behind it is now real wagmi/RainbowKit state. */}
        <ConnectButton.Custom>
          {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
            const ready = mounted;
            const connected = ready && account && chain;
            if (!connected) {
              return (
                <Button className="fl-wallet-button" variant="primary" icon={<Icon name="wallet" size={15} />} onClick={openConnectModal}
                  style={!ready ? { opacity: 0, pointerEvents: "none", userSelect: "none" } : undefined}
                  aria-hidden={!ready}>Connect wallet</Button>
              );
            }
            if (chain.unsupported) {
              return <Button className="fl-wallet-button" variant="primary" icon={<Icon name="wallet" size={15} />} onClick={openChainModal}>Wrong network</Button>;
            }
            return (
              <span className="fl-wallet-account" role="button" tabIndex={0} onClick={openAccountModal}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAccountModal(); } }}
                style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 12px", border: "1px solid var(--line-2)", borderRadius: "var(--radius-sm)", background: "var(--raised)", font: "var(--type-metric-sm)", color: "var(--ink-1)", cursor: "pointer" }}>
                <Icon name="wallet" size={14} />{account.displayName}
              </span>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </header>
  );
}

export { KitHeader };

"use client";

import React from "react";
import { HireRecoveryActions } from "@/components/deploy/HireRecoveryActions";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { useAccount, usePublicClient } from "wagmi";
import { Button, DenseRow, DenseRowHeader, EmptyState, Icon, IconButton, MetricTile, SegmentedToggle, Select, Skeleton } from "@/design-system";
import { AGENTS } from "@/lib/design-data";
import { FundsModal, truncateAddress } from "@/components/FundsModal";
import { useOwnerActions, type OwnerKind } from "@/lib/exec/use-owner-actions";
import type { StoredPasskey } from "@/lib/exec/passkey";
import type { AccountPortfolio } from "@/lib/exec/types";
import { accountPortfolioForOwner, currentAccountRequest, displayablePnlUsdMicros, nativeBalanceWei, signedReadFallbackRequired, withdrawableTokens } from "@/lib/exec/account-view";
import { canWithdraw, formatBnb, maxTokenWithdrawAtomic, tokenWithdrawShortfallWei, withdrawReserveBnb } from "@/lib/altana/withdraw";
import { readSessionStorage, rememberReadExpiry, subscribeReadExpiry } from "@/lib/exec/read-session-window";
import { RESOURCES } from "@/lib/design-resources";

const RECOVERY_READ_HEADERS: Readonly<Record<string, string>> = {};

type Props = { readonly go: (route: string) => void };
type Unit = "USD" | "BNB";
type Wallet = AccountPortfolio["wallets"][number];

function micros(value: string | null): number | null {
  if (value === null || !/^-?\d+$/u.test(value)) return null;
  const number = Number(value) / 1_000_000;
  return Number.isFinite(number) ? number : null;
}

function money(value: number | null, unit: Unit, bnbUsd: number | null, signed = false): string {
  if (value === null || (unit === "BNB" && (!bnbUsd || bnbUsd <= 0))) return "—";
  const shown = unit === "USD" ? value : value / bnbUsd!;
  const sign = shown < 0 ? "-" : signed && shown > 0 ? "+" : "";
  const amount = Math.abs(shown);
  return unit === "USD"
    ? `${sign}$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${sign}${amount.toFixed(4)} BNB`;
}

/**
 * The portfolio card — now the ONLY card on this screen.
 *
 * The separate "Agent wallet" header panel is gone: it named the same address
 * this card sizes its tiles against, so the two could disagree by construction.
 * The address, the copy control and the two money buttons live here instead.
 *
 * Available / Deployed / Total belong to the SELECTED wallet when there is one
 * — that is the wallet this header names and the Withdraw button sizes against,
 * so showing owner-wide figures beside it would be two different numbers under
 * one label. The owner totals are the fallback when no wallet is selected.
 *
 * Deposit and Withdraw are gated on DIFFERENT facts because they run on
 * different machines: deposit needs a connected wallet that is not B (MetaMask
 * signs), withdraw needs the PASSKEY that is B's admin key plus enough liquid
 * native to leave the gas reserve behind. At most ONE reason sentence renders,
 * under the tiles.
 */
/** "Powered by Altana", the footer strip shared by the portfolio card and its
    skeleton. Altana supplies the EIP-7702 wallet, the passkey owner binding and
    the session every agent executes under, so the credit belongs on this panel
    rather than in the page chrome. */
function PoweredByAltana() {
  return <div className="fl-powered-by fl-powered-by--page">
    <span className="fl-powered-by__label">Powered by</span>
    <img src={RESOURCES.altana} alt="" />
    <span className="fl-powered-by__name">Altana</span>
  </div>;
}

function PortfolioPanel({ portfolio, wallet, wallets, index, setIndex, connectedAddress, ownerAddress, withdrawReason, onDeposit, onWithdraw, unit, setUnit, refresh, loading }: {
  readonly portfolio: AccountPortfolio;
  readonly wallet: Wallet | null;
  readonly wallets: readonly Wallet[];
  readonly index: number;
  readonly setIndex: (index: number) => void;
  readonly connectedAddress?: string;
  /** The passkey identity the portfolio is scoped to. Identity only, never payable. */
  readonly ownerAddress?: string;
  readonly withdrawReason: string | null;
  readonly onDeposit: (wallet: Wallet) => void;
  readonly onWithdraw: (wallet: Wallet) => void;
  readonly unit: Unit;
  readonly setUnit: (unit: Unit) => void;
  readonly refresh: () => void;
  readonly loading: boolean;
}) {
  const available = micros(wallet ? wallet.availableUsdMicros : portfolio.totals.walletUsdMicros);
  const deployed = micros(wallet ? wallet.deployedUsdMicros : portfolio.totals.deployedUsdMicros);
  const total = available === null || deployed === null ? null : available + deployed;
  const ownerTotal = micros(portfolio.totals.totalUsdMicros);
  const ownerWallet = micros(portfolio.totals.walletUsdMicros);
  const ownerDeployed = micros(portfolio.totals.deployedUsdMicros);
  const pnl = micros(portfolio.totals.grossLpPnlUsdMicros);
  const bnbUsd = micros(portfolio.assets.find((asset) => asset.kind === "native" && asset.priceUsdMicros !== null)?.priceUsdMicros ?? null);
  const allocation = ownerWallet !== null && ownerDeployed !== null && ownerTotal !== null && ownerWallet >= 0 && ownerDeployed >= 0 && ownerTotal > 0 && ownerDeployed <= ownerTotal
    ? Math.floor(ownerDeployed * 10_000 / ownerTotal) / 100
    : null;
  const pnlPercent = portfolio.totals.grossLpPnlBps === null ? null : Number(portfolio.totals.grossLpPnlBps) / 100;
  const active = portfolio.agents.filter((agent) => agent.status === "armed").length;
  const sameAddress = wallet !== null && connectedAddress !== undefined
    && connectedAddress.toLowerCase() === wallet.address.toLowerCase();
  const depositReason = wallet === null
    ? "No agent wallet on this browser yet."
    : connectedAddress === undefined
      // A deposit is a transaction FROM the connected wallet. Without one there
      // is no sender, and the modal's confirm would fail inside wagmi rather
      // than here, where the reason can be stated.
      ? "Connect a wallet to deposit from."
      : sameAddress ? "The connected wallet is the agent wallet, so there is nothing to deposit." : null;
  // ONE sentence. A disabled Withdraw outranks the self-transfer note, and the
  // missing-wallet case outranks both because it disables the pair.
  const reason = wallet === null ? depositReason : withdrawReason ?? depositReason;
  return <section className="fl-portfolio" style={{ border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", overflow: "hidden", marginBottom: 20 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", flexWrap: "wrap" }}>
      <Icon name="wallet" size={16} />
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginRight: "auto", minWidth: 0 }}>
        <h2 style={{ font: "var(--weight-semibold) var(--text-lg)/1 var(--font-sans)", color: "var(--ink-1)" }}>Agent portfolio</h2>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, font: "var(--type-mono-xs)", color: "var(--text-muted)" }}>
          {wallet === null
            ? <span>No agent wallet yet</span>
            : <>
              <span title={wallet.address}>{truncateAddress(wallet.address)}</span>
              <IconButton label="Copy agent wallet address" onClick={() => { void navigator.clipboard?.writeText(wallet.address); }}><Icon name="copy" size={13} /></IconButton>
            </>}
        </span>
        {/* WHOSE account this is, and what funds it — because the passkey is the
            identity and the connected wallet is only a funding source, so
            disconnecting or switching wallets does NOT change the portfolio.
            Without this line that behaviour reads as a bug, and the Withdraw
            destination prefills from a wallet the screen never named. */}
        <span style={{ font: "var(--type-mono-xs)", color: "var(--text-subtle)" }}>
          {ownerAddress === undefined ? "Not signed in" : `Signed in with passkey ${truncateAddress(ownerAddress)}`}
          {" · "}
          {connectedAddress === undefined ? "no wallet connected" : `funds from ${truncateAddress(connectedAddress)}`}
        </span>
      </div>
      {wallets.length > 1 && <Select label="Wallet" value={String(index)} onChange={(event: { target: { value: string } }) => setIndex(Number(event.target.value))}
        options={wallets.map((entry, position) => ({ value: String(position), label: truncateAddress(entry.address) }))} />}
      <SegmentedToggle options={[{ value: "USD", label: "USD" }, { value: "BNB", label: "BNB" }]} value={unit} onChange={(value: string) => setUnit(value as Unit)} />
      <IconButton label="Refresh balances" onClick={refresh} disabled={loading}><Icon name="activity" size={15} /></IconButton>
      <Button variant="primary" disabled={depositReason !== null} title={depositReason ?? undefined}
        onClick={wallet === null || depositReason !== null ? undefined : () => onDeposit(wallet)}>Deposit</Button>
      <Button variant="secondary" disabled={wallet === null || withdrawReason !== null} title={withdrawReason ?? undefined}
        onClick={wallet === null || withdrawReason !== null ? undefined : () => onWithdraw(wallet)}>Withdraw</Button>
    </div>
    <div className="fl-account-metrics-scroll">
      <div className="fl-account-metrics">
        <MetricTile size="sm" label="Total" value={money(total, unit, bnbUsd)} note="Available plus deployed." />
        <MetricTile size="sm" label="Available" value={money(available, unit, bnbUsd)} note="Liquid in the agent wallet." />
        <MetricTile size="sm" label="Deployed" value={money(deployed, unit, bnbUsd)} note={allocation === null ? "Allocation unavailable" : `${allocation.toFixed(2)}% allocated`} />
        <MetricTile size="sm" label="PNL" value={money(pnl, unit, bnbUsd, true)} tone={pnl !== null && pnl > 0 ? "profit" : pnl !== null && pnl < 0 ? "loss" : "flat"} note={pnlPercent === null ? "No eligible LP basis" : `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`} />
        <MetricTile size="sm" label="Active agents" value={String(active)} note="Live now" />
      </div>
      {reason && <p style={{ margin: 0, padding: "0 16px 14px", font: "var(--type-body-sm)", color: "var(--text-subtle)" }}>{reason}</p>}
    </div>
  </section>;
}

/**
 * The loading state, drawn as the CARD that is coming.
 *
 * It used to be an `EmptyState` reading "Loading portfolio" — a blank panel of
 * a different height, so the whole screen jumped the moment data arrived. This
 * is the same frame, the same header row, the same three-tile grid and the same
 * stats/rows blocks as {@link PortfolioPanel}, with the design system's own
 * `Skeleton` primitives standing in for the values. It invents no copy: the
 * only literal text is the tile and column LABELS, which are fixed and are the
 * same words the loaded card shows.
 *
 */
function PortfolioSkeleton() {
  return <div aria-busy="true" aria-live="polite">
    <section className="fl-portfolio" style={{ border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", overflow: "hidden", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line-1)", flexWrap: "wrap" }}>
        <Icon name="wallet" size={16} />
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginRight: "auto", minWidth: 0 }}>
          <h2 style={{ font: "var(--weight-semibold) var(--text-lg)/1 var(--font-sans)", color: "var(--ink-1)" }}>Agent portfolio</h2>
          <Skeleton w={132} h={11} />
        </div>
        <Skeleton w={96} h={30} radius="var(--radius-sm)" />
        <Skeleton w={84} h={30} radius="var(--radius-sm)" />
        <Skeleton w={92} h={30} radius="var(--radius-sm)" />
      </div>
      <div className="fl-account-metrics-scroll">
        <div className="fl-account-metrics">
          {["Total", "Available", "Deployed", "PNL", "Active agents"].map((label) => <div className="fl-metric fl-metric--sm" key={label}>
            <span className="fl-metric__label">{label}</span>
            <Skeleton w="70%" h={22} />
            <Skeleton w="55%" h={10} />
          </div>)}
        </div>
      </div>
    </section>
    <div className="fl-rows">
      <DenseRowHeader columns={["Agent", "PnL", ""]} />
      {[0, 1, 2].map((row) => <div key={row} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--line-1)" }}>
        <Skeleton w={32} h={32} radius="var(--radius-sm)" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginRight: "auto", minWidth: 0, flex: 1 }}>
          <Skeleton w="34%" h={13} />
          <Skeleton w="52%" h={10} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          <Skeleton w={84} h={13} />
          <Skeleton w={112} h={10} />
        </div>
      </div>)}
    </div>
  </div>;
}

/**
 * A wallet row the plane has not observed.
 *
 * The plane now reads a wallet the client DECLARES on the portfolio request, so
 * this fallback only covers the case where the read itself failed or the flag
 * did not reach it. The synthesized row carries NULL marks rather than zeros:
 * nothing measured it.
 */
function localWalletRow(address: string): Wallet {
  return { address, custodyModel: "passkey", depositable: true, source: "declared", availableUsdMicros: null, deployedUsdMicros: "0", deployedReason: "declared", passkeyVerified: "unreadable" };
}

/**
 * `passkeyVerified` is DELIBERATELY not rendered.
 *
 * `"not-registered"` is the ordinary state of a funded passkey wallet whose
 * first admin action has not landed, and `"unreadable"` is an RPC hiccup —
 * neither is news, and rendering them made the normal case look like a fault.
 * The field still rides the DTO and the plane still refuses the one verdict it
 * can PROVE is an impostor (`"no-matching-key"`, 400) before this screen ever
 * sees the payload.
 *
 * ---
 *
 * Every wallet the screen can act on, agent wallet B first.
 *
 * B is what the user deposits into and withdraws from, so it leads regardless
 * of how the plane happened to order its entries.
 */
export function accountWallets(portfolio: AccountPortfolio, passkeyWallet: string | undefined): readonly Wallet[] {
  const known = [...portfolio.wallets];
  if (passkeyWallet !== undefined && !known.some((entry) => entry.address.toLowerCase() === passkeyWallet.toLowerCase())) {
    known.unshift(localWalletRow(passkeyWallet.toLowerCase()));
  }
  return passkeyWallet === undefined
    ? known
    : [...known].sort((a, b) => Number(b.address.toLowerCase() === passkeyWallet.toLowerCase()) - Number(a.address.toLowerCase() === passkeyWallet.toLowerCase()));
}

const CARD = { border: "1px solid var(--line-1)", borderRadius: "var(--radius-lg)", background: "var(--raised)", padding: 16, marginBottom: 20, display: "grid", gap: 12 } as const;
const SUBTLE = { font: "var(--type-body-sm)", color: "var(--text-subtle)" } as const;

/** Only the operator ever wanted the raw credential; it is off by default. */
function passkeyDebugEnabled(): boolean {
  return process.env["NEXT_PUBLIC_PASSKEY_DEBUG"] === "true";
}

/**
 * Signing in IS recovery, and creating is the exception.
 *
 * There is exactly ONE primary action while this browser holds no passkey
 * record: "Sign in with passkey", which runs Altana's `recoverFromPasskey` —
 * the ceremony that finds the wallet the credential's own user handle names.
 * Creating is offered only AFTER that finds nothing, as a clearly separate
 * secondary, and never automatically: creating while a wallet already existed
 * is precisely how a user ends up with a second, empty agent wallet and no path
 * back to the first.
 *
 * There is no sign-out here on purpose. One browser, one agent wallet.
 */
function SignInCard(props: {
  readonly onSignIn: () => void;
  readonly onCreateWallet?: () => void;
  readonly offerCreate: boolean;
  readonly busy: boolean;
  readonly notice: string | null;
}) {
  return <section className="fl-account-signin" style={CARD}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span className="fl-eyebrow">Agent wallet</span>
        <span style={SUBTLE}>Your passkey holds the agent wallet. Sign in to find it on this device.</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={props.busy} onClick={props.onSignIn}>{props.busy ? "Waiting for your device…" : "Sign in with passkey"}</Button>
        {props.offerCreate && props.onCreateWallet &&
          <Button variant="secondary" disabled={props.busy} onClick={props.onCreateWallet}>Create a new agent wallet</Button>}
      </div>
    </div>
    {props.notice && <p style={{ ...SUBTLE, margin: 0, color: "var(--warning)" }}>{props.notice}</p>}
    {props.offerCreate && <p style={{ ...SUBTLE, margin: 0 }}>Create a new wallet only if you have never made one. A new wallet is empty, and it does not replace an existing one.</p>}
  </section>;
}

/** The operator's credential dump, off unless `NEXT_PUBLIC_PASSKEY_DEBUG`. */
function PasskeyDebug(props: { readonly passkey: StoredPasskey; readonly ownerAddress?: string }) {
  if (!passkeyDebugEnabled()) return null;
  return <div style={{ ...CARD, font: "var(--type-mono-xs)", color: "var(--text-muted)", wordBreak: "break-all", gap: 4 }}>
    <span>Public key x: {props.passkey.x}</span>
    <span>Public key y: {props.passkey.y}</span>
    <span>Owner identity: {props.ownerAddress ?? "—"} (identity only, not a deposit address)</span>
    <span>Credential id: {props.passkey.credentialId}</span>
    <span>Relying party: {props.passkey.rpId}</span>
    <span>Agent wallet: {props.passkey.walletAddress ?? "none yet"}</span>
  </div>;
}

export function AccountScreenContent(props: {
  readonly isConnected: boolean;
  readonly portfolio: AccountPortfolio | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly needsSignature: boolean;
  readonly narrow: boolean;
  readonly unit: Unit;
  readonly setUnit: (unit: Unit) => void;
  readonly refresh: () => void;
  readonly authorize: () => void;
  readonly go: (route: string) => void;
  readonly connectedAddress?: string;
  readonly ownerKind?: OwnerKind;
  readonly ownerAddress?: string;
  readonly passkey?: StoredPasskey | null;
  /** Recovery-first sign-in. Absent ⇒ no passkey affordance renders at all. */
  readonly signIn?: () => void;
  /** Offered only once `signIn` has failed to find a wallet. */
  readonly createWallet?: () => void;
  readonly offerCreateWallet?: boolean;
  readonly walletBusy?: boolean;
  readonly walletNotice?: string | null;
  /** Whether wallet B has code on chain; `null` ⇒ the larger reserve. */
  readonly walletRegistered?: boolean | null;
  readonly accountManagement?: boolean;
}) {
  // Owner effects run after paint; never paint the prior account during that gap.
  if (props.portfolio && props.ownerAddress && props.portfolio.ownerAddress.toLowerCase() !== props.ownerAddress.toLowerCase()) {
    props = { ...props, portfolio: null };
  }
  const allRows = props.portfolio?.agents ?? [];
  // Incomplete hires need recovery actions without being counted as live agents.
  const [cancelledHires, setCancelledHires] = React.useState<ReadonlySet<string>>(() => new Set());
  const recoveryOwner = props.portfolio?.ownerAddress.toLowerCase() ?? "";
  const hideCancelledHire = React.useCallback((agentId: string) => {
    const key = recoveryOwner + ":" + agentId;
    setCancelledHires(previous => previous.has(key) ? previous : new Set([...previous, key]));
  }, [recoveryOwner]);
  const pendingRows = allRows.filter((row) => row.status === "provisioning" && !cancelledHires.has(recoveryOwner + ":" + row.id));
  const rows = allRows.filter((row) => row.status === "armed" || row.status === "paused");
  const [funding, setFunding] = React.useState<{ readonly wallet: Wallet; readonly tab: "deposit" | "withdraw" } | null>(null);
  const [index, setIndex] = React.useState(0);
  const ownerKind: OwnerKind = props.ownerKind ?? "wallet";
  // A passkey owner needs no wallet connection: the credential IS the identity.
  const hasOwner = props.isConnected || ownerKind === "passkey";
  const passkeyWallet = props.passkey?.walletAddress;
  const wallets = props.portfolio === null ? [] : accountWallets(props.portfolio, passkeyWallet);
  const wallet = wallets.length === 0 ? null : wallets[Math.min(index, wallets.length - 1)]!;
  const isPasskeyWallet = wallet !== null && passkeyWallet !== undefined && passkeyWallet.toLowerCase() === wallet.address.toLowerCase();
  const nativeWei = props.portfolio === null || wallet === null ? null : nativeBalanceWei(props.portfolio, wallet.address);
  // What an exit can leave behind: the WBNB quote leg, or the volatile leg when
  // the conversion was skipped. Both are withdrawable through the same modal, so
  // a wallet holding only tokens is not "nothing to withdraw".
  const heldTokens = props.portfolio === null || wallet === null ? [] : withdrawableTokens(props.portfolio, wallet.address);
  const tier = { registered: props.walletRegistered ?? null };
  const tokenWithdrawable = nativeWei !== null && heldTokens.some((entry) => maxTokenWithdrawAtomic({ balanceAtomic: entry.balanceAtomic, nativeWei, ...tier }) > 0n);
  const withdrawReason = wallet === null
    ? null
    : !isPasskeyWallet
      ? "Withdrawing needs the passkey that holds this wallet."
      : nativeWei === null
        ? "The wallet balance could not be read."
        : !canWithdraw(nativeWei, tier) && !tokenWithdrawable
          // Two different dead ends, and telling them apart is the whole point:
          // with tokens in the wallet the remedy is a small deposit, not "you
          // have nothing to withdraw".
          ? (heldTokens.length > 0
            ? `Deposit ${formatBnb(tokenWithdrawShortfallWei({ nativeWei, ...tier }), 8)} BNB to cover the fee for moving ${heldTokens.map((entry) => entry.symbol).join(" and ")}.`
            : `Below the ${withdrawReserveBnb(tier)} BNB kept back for network fees.`)
          : null;

  return <div className="fl-shell fl-account-page">
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, marginBottom: 20, flexWrap: "wrap" }}><div style={{ display: "flex", flexDirection: "column", gap: 8 }}><h1 style={{ font: "var(--type-page-title)" }}>Account</h1><p style={{ font: "var(--type-body-md)", color: "var(--text-muted)" }}>Your live wallet balance, allocation, and position-level LP PnL.</p></div></div>
    {props.accountManagement && <AccountSwitcher active={props.passkey ?? null} disabled={funding !== null} />}
    {!props.accountManagement && props.signIn && !props.passkey && <SignInCard onSignIn={props.signIn} {...(props.createWallet ? { onCreateWallet: props.createWallet } : {})}
      offerCreate={props.offerCreateWallet === true} busy={props.walletBusy === true} notice={props.walletNotice ?? null} />}
    {props.passkey && <PasskeyDebug passkey={props.passkey} {...(props.ownerAddress ? { ownerAddress: props.ownerAddress } : {})} />}
    {!hasOwner ? <EmptyState icon="wallet" title="Connect your owner wallet">Account data is owner-scoped and never exposed through the browser service credential. You can also use a passkey instead of a wallet.</EmptyState>
      : props.needsSignature && !props.portfolio ? <EmptyState icon="wallet" title="Authorize Account access" action={<Button variant="primary" onClick={props.authorize} disabled={props.loading}>{props.loading ? "Authorizing…" : "Sign once to load portfolio"}</Button>}>Sign in once for this browser session, up to 24 hours. It cannot trade, pause, or revoke agents.</EmptyState>
      : props.error && !props.portfolio ? <EmptyState icon="wallet" title="Portfolio unavailable" action={<Button variant="secondary" onClick={props.refresh}>Try again</Button>}>{props.error}</EmptyState>
      : props.portfolio ? <>
        {funding && <FundsModal open onClose={() => setFunding(null)} wallet={funding.wallet} initialTab={funding.tab} connectedAddress={props.connectedAddress}
          availableWei={nativeBalanceWei(props.portfolio, funding.wallet.address)} tokens={withdrawableTokens(props.portfolio, funding.wallet.address)} passkey={props.passkey ?? null} ownerAddress={props.ownerAddress}
          walletRegistered={props.walletRegistered ?? null} onWithdrawn={props.refresh} />}
        <PortfolioPanel portfolio={props.portfolio} wallet={wallet} wallets={wallets} index={Math.min(index, Math.max(wallets.length - 1, 0))} setIndex={setIndex}
          {...(props.connectedAddress ? { connectedAddress: props.connectedAddress } : {})}
          {...(props.ownerAddress ? { ownerAddress: props.ownerAddress } : {})} withdrawReason={withdrawReason}
          onDeposit={(entry) => setFunding({ wallet: entry, tab: "deposit" })} onWithdraw={(entry) => setFunding({ wallet: entry, tab: "withdraw" })}
          unit={props.unit} setUnit={props.setUnit} refresh={props.refresh} loading={props.loading} />
        {props.portfolio.venus && <p style={{ color: "var(--text-muted)", marginBottom: 14 }}>Venus stored value: supply {money(micros(props.portfolio.venus.supplyUsdMicros), "USD", null)}, debt {money(micros(props.portfolio.venus.borrowUsdMicros), "USD", null)}, net {money(micros(props.portfolio.venus.netUsdMicros), "USD", null, true)}.</p>}
        {props.portfolio.coverage.total.state === "partial" && <p style={{ color: "var(--warning)", marginBottom: 14 }}>Some values are incomplete: {props.portfolio.coverage.total.reasons.join(", ")}.</p>}
        {pendingRows.length > 0 && <section aria-label="Incomplete agent setups" style={{ ...CARD, marginBottom: 20 }}>
          <h2 style={{ font: "var(--type-body-md)" }}>Setup incomplete</h2>
          {pendingRows.map((row) => {
            const trade = row.httpRuntimeProfile === "trade-v1";
            const lp = row.httpRuntimeProfile === "lp-v1";
            return <div key={row.id} style={{ display: "grid", gap: 8 }}>
              <strong>{row.id}</strong>
              <HireRecoveryActions agentId={row.id} readHeaders={RECOVERY_READ_HEADERS} go={props.go} onCancelled={hideCancelledHire}
                storageKey={trade ? "4lpha:trade-hire:v2" : lp ? "4lpha:lp-hire:v1" : "4lpha:grid-hire:v1"}
                deployPath={trade ? "/deploy/trading" : lp ? "/deploy/lp" : "/deploy/grid"} />
            </div>;
          })}
        </section>}
        {rows.length === 0 && pendingRows.length > 0 ? null : rows.length === 0 ? <EmptyState icon="wallet" title={allRows.length === 0 ? "No agents found" : "No agents in service"} action={<Button variant="primary" onClick={() => props.go("/")}>Browse the marketplace</Button>}>{allRows.length === 0 ? "No owner-controlled agents are recorded for this wallet." : "No live or paused agents are currently in service."}</EmptyState> : <div className="fl-rows"><DenseRowHeader columns={["Agent", "PnL", ""]} />
          {rows.map((row) => { const design = AGENTS.find((agent) => agent.id === row.id); const pnl = micros(displayablePnlUsdMicros(row)); const live = row.status === "armed"; return <div key={row.id} role="button" tabIndex={0} style={{ cursor: "pointer" }} title={`Open ${row.id}`} onClick={() => props.go(`/account/${row.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.go(`/account/${row.id}`); } }}><DenseRow name={design?.name ?? row.id} categoryId={design?.categoryId ?? "defi"} status={live ? "live" : "paused"} statusLabel={live ? "Live" : "Pause"} statusLine={`${row.httpRuntimeProfile} · ${row.holdings.state}`} value={money(pnl, "USD", null, true)} valueTone={pnl !== null && pnl > 0 ? "profit" : pnl !== null && pnl < 0 ? "loss" : undefined} valueSub={row.pnl.coverage === "full" ? "gross LP mark-to-basis" : row.pnl.reason} /></div>; })}
        </div>}
      </> : <PortfolioSkeleton />}
    <PoweredByAltana />
  </div>;
}

export function MyAgentsScreen({ go }: Props) {
  const { address, isConnected } = useAccount();
  // THE identity for every owner-scoped check on this screen. Under passkey
  // custody the connected wallet is a funding source and nothing else, so the
  // portfolio must be matched against the passkey-derived owner instead.
  const { ownerAddress, ownerKind, passkey, createPasskey, recoverWallet, signEnvelope, signReadHeader } = useOwnerActions();
  const [walletBusy, setWalletBusy] = React.useState(false);
  const [walletNotice, setWalletNotice] = React.useState<string | null>(null);
  const [offerCreateWallet, setOfferCreateWallet] = React.useState(false);
  const [portfolio, setPortfolio] = React.useState<AccountPortfolio | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [needsSignature, setNeedsSignature] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const [unit, setUnit] = React.useState<Unit>("USD");
  const [walletRegistered, setWalletRegistered] = React.useState<boolean | null>(null);
  const requestGeneration = React.useRef(0);
  const currentAddress = React.useRef(ownerAddress);
  currentAddress.current = ownerAddress;
  const publicClient = usePublicClient();
  const walletAddress = passkey?.walletAddress;

  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  /**
   * Does wallet B have code yet?
   *
   * This decides which gas reserve a withdrawal leaves behind, and it is read
   * ONCE here rather than inside the modal so the enable gate and the modal's
   * max cannot disagree. A failed read stays `null`, which every consumer
   * resolves to the LARGER first-action reserve — over-reserving strands dust,
   * under-reserving strands the wallet.
   */
  React.useEffect(() => {
    let cancelled = false;
    setWalletRegistered(null);
    if (!walletAddress || !publicClient) return;
    void (async () => {
      try {
        const code = await publicClient.getCode({ address: walletAddress as `0x${string}` });
        if (!cancelled) setWalletRegistered(code !== undefined && code !== "0x");
      } catch { if (!cancelled) setWalletRegistered(null); }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, publicClient]);

  const load = React.useCallback(async () => {
    const generation = ++requestGeneration.current;
    const requestedOwner = ownerAddress;
    setLoading(true); setError(null);
    try {
      // The DECLARED wallet. A passkey user funds B before hiring anything, so
      // the plane owns no row naming it and the portfolio would come back with
      // "0 wallets observed" over a wallet holding real money. The address comes
      // from this browser's own passkey record.
      const query = walletAddress ? `?wallets=${encodeURIComponent(walletAddress)}` : "";
      const response = await fetch(`/api/account/portfolio${query}`, { cache: "no-store" });
      if (!currentAccountRequest(generation, requestGeneration.current, requestedOwner, currentAddress.current)) return;
      if (response.status === 401) { setNeedsSignature(true); setPortfolio(null); return; }
      if (!response.ok) throw new Error("Portfolio service is temporarily unavailable.");
      const body = await response.json() as unknown;
      const accepted = requestedOwner ? accountPortfolioForOwner(body, requestedOwner) : null;
      if (accepted === null) {
        setPortfolio(null); setNeedsSignature(true);
        throw new Error("The Account session belongs to a different owner. Authorize this identity to continue.");
      }
      setPortfolio(accepted); setNeedsSignature(false);
    } catch (cause) { if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : "Could not load portfolio."); }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }, [ownerAddress, walletAddress]);

  React.useEffect(() => { requestGeneration.current += 1; setPortfolio(null); setNeedsSignature(false); setLoading(false); setError(null); if (ownerAddress) void load(); }, [ownerAddress, load]);

  React.useEffect(() => subscribeReadExpiry(() => { if (ownerAddress) void load(); }), [ownerAddress, load]);

  const authorize = React.useCallback(async () => {
    const requestedOwner = ownerAddress;
    setLoading(true); setError(null);
    try {
      const envelope = await signEnvelope("createAccountReadSession", "*", {});
      const response = await fetch("/api/account/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
      if (currentAddress.current !== requestedOwner) return;
      if (signedReadFallbackRequired(response.status)) {
        const signedRead = await signReadHeader("*");
        const query = walletAddress ? `?wallets=${encodeURIComponent(walletAddress)}` : "";
        const fallback = await fetch(`/api/account/portfolio${query}`, { headers: { "x-owner-action": signedRead }, cache: "no-store" });
        if (!fallback.ok) throw new Error("Wallet authorization was rejected.");
        const body = await fallback.json() as unknown;
        const accepted = ownerAddress ? accountPortfolioForOwner(body, ownerAddress) : null;
        if (currentAddress.current !== requestedOwner || accepted === null) throw new Error("Portfolio owner did not match the signing identity.");
        setPortfolio(accepted); setNeedsSignature(false); setLoading(false); return;
      }
      if (!response.ok) throw new Error("Wallet authorization was rejected.");
      const session = await response.json() as { data?: { expiry?: unknown } };
      const expirySec = session.data?.expiry;
      if (typeof expirySec !== "number" || !Number.isSafeInteger(expirySec * 1_000)) throw new Error("Invalid read session response.");
      rememberReadExpiry(readSessionStorage(), expirySec * 1_000);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not authorize Account reads."); setLoading(false); }
  }, [ownerAddress, load, signEnvelope, signReadHeader, walletAddress]);

  /**
   * Sign in = RECOVER first.
   *
   * `recoverFromPasskey` is the only ceremony that can find a wallet this
   * browser has forgotten, so it runs before anything is created. A failure
   * unlocks the create affordance and says why — it never creates by itself.
   */
  const onSignIn = React.useCallback(() => {
    setWalletBusy(true); setWalletNotice(null);
    void recoverWallet()
      .then(() => { setOfferCreateWallet(false); })
      .catch((cause: unknown) => {
        setWalletNotice(cause instanceof Error ? cause.message : "No agent wallet was found for a passkey on this device.");
        setOfferCreateWallet(true);
      })
      .finally(() => setWalletBusy(false));
  }, [recoverWallet]);

  /** The deliberate second step: one credential, one new Altana wallet. */
  const onCreateWallet = React.useCallback(() => {
    setWalletBusy(true); setWalletNotice(null);
    void createPasskey("4lpha owner")
      .catch((cause: unknown) => { setWalletNotice(cause instanceof Error ? cause.message : "Could not create an agent wallet on this device."); })
      .finally(() => setWalletBusy(false));
  }, [createPasskey]);

  return (
    <AccountScreenContent isConnected={isConnected} portfolio={portfolio} loading={loading} error={error} needsSignature={needsSignature} narrow={narrow} unit={unit} setUnit={setUnit} refresh={() => void load()} authorize={() => void authorize()} go={go} connectedAddress={address}
        ownerKind={ownerKind} ownerAddress={ownerAddress} passkey={passkey} signIn={onSignIn} createWallet={onCreateWallet} offerCreateWallet={offerCreateWallet}
      walletBusy={walletBusy} walletNotice={walletNotice} walletRegistered={walletRegistered} accountManagement />
  );
}

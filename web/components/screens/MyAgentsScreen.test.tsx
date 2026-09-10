import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AccountPortfolio } from "@/lib/exec/types";

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useBalance: () => ({ data: undefined }),
  useGasPrice: () => ({ data: undefined }),
  usePublicClient: () => undefined,
  useSendTransaction: () => ({ sendTransaction: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
}));
vi.mock("@/lib/exec/use-owner-actions", () => ({ useOwnerActions: () => ({ signEnvelope: vi.fn(), signReadHeader: vi.fn() }) }));
import { AccountScreenContent } from "./MyAgentsScreen";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT_WALLET = "0x3333333333333333333333333333333333333333";
const CONNECTED = "0x4444444444444444444444444444444444444444";
const empty: AccountPortfolio = {
  generatedAt: 1,
  asOf: null,
  ownerAddress: OWNER,
  wallets: [],
  assets: [],
  agents: [],
  venus: null,
  totals: { walletUsdMicros: "0", deployedUsdMicros: "0", totalUsdMicros: "0", grossLpPnlUsdMicros: null, grossLpPnlBps: null, eligibleLpBasisNativeWei: null },
  coverage: { universe: "known-assets", wallet: { state: "empty", reasons: ["none"] }, deployed: { state: "empty", reasons: ["none"] }, total: { state: "empty", reasons: ["none"] }, pnl: { state: "empty", reasons: ["none"] }, truncated: { agents: false, wallets: false, tokens: false, walletTokenPairs: false, positions: false } },
};
const partial: AccountPortfolio = {
  ...empty,
  wallets: [{ address: AGENT_WALLET, custodyModel: "passkey", depositable: true, source: "agents", availableUsdMicros: "1500000", deployedUsdMicros: "2500000", deployedReason: "none" }],
  totals: { walletUsdMicros: null, deployedUsdMicros: null, totalUsdMicros: null, grossLpPnlUsdMicros: null, grossLpPnlBps: null, eligibleLpBasisNativeWei: null },
  agents: [{
    id: "live-agent", status: "armed", httpRuntimeProfile: "lp-v1", walletAddress: OWNER, attention: "partial-data", gas: null,
    holdings: { method: "sellable-lp-exit-v1", state: "partial", reason: "missing-mark", valueUsdMicros: null, venusReference: null, held: false },
    pnl: { method: "gross-lp-mark-plus-residue-to-declared-basis-v2", coverage: "partial", reason: "missing-mark", eligibleBasisNativeWei: null, markNativeWei: null, pnlNativeWei: null, pnlUsdMicros: null, pnlBps: null, basisSources: [], excluded: ["relay-and-gas", "wallet-residue", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"] },
  }],
  coverage: { ...empty.coverage, wallet: { state: "partial", reasons: ["unreadable"] }, deployed: { state: "partial", reasons: ["missing-mark"] }, total: { state: "partial", reasons: ["unreadable", "missing-mark"] }, pnl: { state: "partial", reasons: ["missing-mark"] } },
};

function render(overrides: Partial<React.ComponentProps<typeof AccountScreenContent>> = {}): string {
  return renderToStaticMarkup(<AccountScreenContent isConnected portfolio={null} loading={false} error={null} needsSignature={false} narrow={false} unit="USD" setUnit={() => undefined} refresh={() => undefined} authorize={() => undefined} go={() => undefined} {...overrides} />);
}

describe("Account screen states", () => {
  it("never paints the previous owner's portfolio during account selection", () => {
    const html = render({ portfolio: partial, ownerAddress: CONNECTED, ownerKind: "passkey", passkey: WALLET_PASSKEY, accountManagement: true });
    expect(html).not.toContain("live-agent");
    expect(html).toContain("Switch account");
    expect(html).toContain("Create account");
  });
  it("renders disconnected, loading, authorization, and error states", () => {
    expect(render({ isConnected: false })).toContain("Connect your owner wallet");
    // The loading state is the CARD, not a message: the same frame, the same
    // five tiles and the same row list as the loaded panel, with skeleton
    // placeholders in the value positions, so nothing moves when data lands.
    const loadingHtml = render();
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain("Agent portfolio");
    expect(loadingHtml).toContain("fl-account-metrics");
    expect(loadingHtml.match(/fl-metric fl-metric--sm/gu)?.length).toBe(5);
    expect(loadingHtml).toContain("fl-skel");
    expect(loadingHtml).not.toContain("Loading portfolio");
    expect(render({ needsSignature: true })).toContain("Sign once to load portfolio");
    expect(render({ error: "read failed" })).toContain("read failed");
  });

  it("renders an honest empty portfolio", () => {
    const html = render({ portfolio: empty });
    expect(html).toContain("$0.00");
    expect(html).toContain("No agents found");
  });

  it("renders real rows, partial warnings, and the refresh control without fake actions", () => {
    const html = render({ portfolio: partial });
    expect(html).toContain("PNL");
    expect(html).not.toContain("Gross LP PnL estimate");
    expect(html).not.toContain("Current allocation");
    expect(html.match(/fl-metric fl-metric--sm/gu)?.length).toBe(5);
    expect(html.indexOf("Total")).toBeLessThan(html.indexOf("Available"));
    expect(html.indexOf("Available")).toBeLessThan(html.indexOf("Deployed"));
    expect(html.indexOf("Deployed")).toBeLessThan(html.indexOf("PNL"));
    expect(html.indexOf("PNL")).toBeLessThan(html.indexOf("Active agents"));
    expect(html).toContain("Some values are incomplete");
    expect(html).toContain("live-agent");
    expect(html).toContain("Live");
    expect(html).not.toContain("Attention");
    expect(html).not.toContain("fl-row--warning");
    expect(html).toContain("Refresh balances");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("Pause");
  });

  it("shows incomplete setups for cancellation without treating them as live", () => {
    const row = partial.agents[0]!;
    const portfolio: AccountPortfolio = { ...partial, agents: [
      row,
      { ...row, id: "paused-agent", status: "paused", attention: "paused" },
      { ...row, id: "broken-agent", status: "provisioning", attention: "provisioning" },
      { ...row, id: "removed-agent", status: "revoked", attention: "none" },
      { ...row, id: "retired-agent", status: "retired", attention: "none" },
    ] };
    const html = render({ portfolio });
    expect(html).toContain("live-agent");
    expect(html).toContain("paused-agent");
    expect(html).toContain("Live");
    expect(html).toContain("Pause");
    expect(html).not.toContain("Attention");
    expect(html).not.toContain("fl-row--warning");
    expect(html).toContain("broken-agent");
    expect(html).toContain("Setup incomplete");
    expect(html).toContain("Cancel hire");
    expect(html).not.toContain("removed-agent");
    expect(html).not.toContain("retired-agent");

    const allInactive: AccountPortfolio = { ...partial, agents: [{ ...row, status: "retired", attention: "none" }] };
    expect(render({ portfolio: allInactive })).toContain("No agents in service");
    expect(render({ portfolio: empty })).toContain("No owner-controlled agents are recorded");
  });
  it("names the agent wallet inside the portfolio card and never renders the owner identity", () => {
    const html = render({ portfolio: partial, connectedAddress: CONNECTED, signIn: () => undefined });
    // The separate header panel is GONE; the address lives in the portfolio card.
    expect(html).not.toContain("fl-account-header");
    expect(html).toContain("Agent portfolio");
    expect(html).toContain("0x3333…3333");
    expect(html).toContain("Copy agent wallet address");
    expect(html).toContain("Available");
    expect(html).toContain("Deployed");
    expect(html).toContain("$1.50");
    expect(html).toContain("$2.50");
    expect(html).toContain("Deposit");
    expect(html).toContain("Withdraw");
    // No passkey is supplied here, so Withdraw is disabled and SAYS WHY rather
    // than vanishing.
    expect(html).toContain("Withdrawing needs the passkey that holds this wallet.");
    expect(html).not.toContain(OWNER);
    expect(html).not.toContain("0x1111…1111");
  });

  it("says why there is nothing to deposit when the connected wallet is the agent wallet", () => {
    const html = render({ portfolio: withNative("1000000000000000000"), connectedAddress: AGENT_WALLET, passkey: WALLET_PASSKEY, ownerKind: "passkey", ownerAddress: OWNER });
    expect(html).toContain("The connected wallet is the agent wallet, so there is nothing to deposit.");
    expect(html).toContain("Withdraw");
  });

  it("keeps the whole passkey-management surface off this screen", () => {
    const html = render({ portfolio: partial, ownerKind: "passkey", ownerAddress: OWNER, passkey: WALLET_PASSKEY, signIn: () => undefined, createWallet: () => undefined });
    expect(html).not.toContain("Forget passkey");
    expect(html).not.toContain("Recover wallet from passkey");
    expect(html).not.toContain("Use a passkey");
    expect(html).not.toContain("Sign in with passkey");
    expect(html).not.toContain("Create a new agent wallet");
  });
});

const PASSKEY = { x: `0x${"11".repeat(32)}`, y: `0x${"22".repeat(32)}`, credentialId: "Y3JlZC1pZA", rpId: "localhost", createdAt: 1 } as const;
const WALLET_PASSKEY = { ...PASSKEY, walletAddress: AGENT_WALLET } as const;

describe("signing in (recovery first)", () => {
  it("offers exactly one primary action when this browser holds no passkey", () => {
    const html = render({ portfolio: partial, connectedAddress: CONNECTED, ownerKind: "wallet", ownerAddress: CONNECTED, passkey: null, signIn: () => undefined, createWallet: () => undefined });
    expect(html).toContain("Sign in with passkey");
    expect(html).not.toContain("Create a new agent wallet");
    expect(html).not.toContain("Recover wallet from passkey");
  });

  it("offers creating a wallet only after a sign-in found none, and says what that means", () => {
    const html = render({ portfolio: partial, passkey: null, signIn: () => undefined, createWallet: () => undefined, offerCreateWallet: true, walletNotice: "No passkey was picked." });
    expect(html).toContain("No passkey was picked.");
    expect(html).toContain("Create a new agent wallet");
    expect(html).toContain("Create a new wallet only if you have never made one.");
  });

  it("surfaces a ceremony failure rather than failing silently", () => {
    const html = render({ portfolio: partial, passkey: null, signIn: () => undefined, walletNotice: "This browser does not support passkeys." });
    expect(html).toContain("This browser does not support passkeys.");
  });

  it("loads the portfolio without a connected wallet when a passkey is the owner", () => {
    const html = render({ isConnected: false, portfolio: partial, ownerKind: "passkey", ownerAddress: OWNER, passkey: PASSKEY, signIn: () => undefined });
    expect(html).not.toContain("Connect your owner wallet");
    expect(html).toContain("Agent portfolio");
  });

  it("hides the operator credential dump by default", () => {
    const html = render({ portfolio: partial, ownerKind: "passkey", ownerAddress: OWNER, passkey: WALLET_PASSKEY, signIn: () => undefined });
    expect(html).not.toContain("Public key x");
    expect(html).not.toContain(PASSKEY.x);
    expect(html).not.toContain("Credential id");
  });
});

/* -------------------------------------------------------------------------- */
/* Wallet B (R6/R7) and the plane's declared entry                            */
/* -------------------------------------------------------------------------- */

/** What the plane now returns for a wallet the client declared: source "declared". */
const declared: AccountPortfolio = {
  ...partial,
  wallets: [{ address: AGENT_WALLET, custodyModel: "passkey", depositable: true, source: "declared", availableUsdMicros: "4200000", deployedUsdMicros: "0", deployedReason: "declared", passkeyVerified: "verified" }],
  assets: [{
    kind: "native", walletAddress: AGENT_WALLET, tokenAddress: null, symbol: "BNB", decimals: 18,
    balanceAtomic: "7000000000000000", priceUsdMicros: "600000000", pricedAt: 1, valueUsdMicros: "4200000",
    status: "priced", method: "wallet-native-v1",
  }],
};

/** A portfolio the plane reported no wallets in at all — the read-failed case. */
const noWallets: AccountPortfolio = { ...partial, wallets: [], assets: [] };

function withNative(balanceWei: string): AccountPortfolio {
  return {
    ...partial,
    assets: [{
      kind: "native", walletAddress: AGENT_WALLET, tokenAddress: null, symbol: "BNB", decimals: 18,
      balanceAtomic: balanceWei, priceUsdMicros: null, pricedAt: null, valueUsdMicros: null,
      status: "priced", method: "wallet-native-v1",
    }],
  };
}

describe("agent wallet (wallet B)", () => {
  it("shows the plane's DECLARED entry with its balance — the bug this closes", () => {
    const html = render({ portfolio: declared, ownerKind: "passkey", ownerAddress: OWNER, passkey: WALLET_PASSKEY, signIn: () => undefined });
    expect(html).toContain("0x3333…3333");
    // Available is priced, Deployed is an honest zero, and neither is "—".
    expect(html).toContain("$4.20");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("The wallet balance could not be read.");
    expect(html).not.toContain(OWNER);
  });

  it("never renders the KeyStore verdict — the counterfactual is normal, not a notice", () => {
    const passkeyProps = { ownerKind: "passkey" as const, ownerAddress: OWNER, passkey: WALLET_PASSKEY, signIn: () => undefined };
    const entry = declared.wallets[0]!;

    for (const verdict of ["verified", "not-registered", "unreadable"] as const) {
      const html = render({ portfolio: { ...declared, wallets: [{ ...entry, passkeyVerified: verdict }] }, ...passkeyProps });
      expect(html).not.toContain("Not yet registered on chain.");
      expect(html).not.toContain("Ownership could not be checked");
      // The balance is still shown in every verdict.
      expect(html).toContain("$4.20");
    }
  });

  it("still names B from the local record when the plane reports no wallets", () => {
    const html = render({ portfolio: noWallets, ownerKind: "passkey", ownerAddress: OWNER, passkey: WALLET_PASSKEY, signIn: () => undefined });
    expect(html).toContain("0x3333…3333");
    expect(html).not.toContain("Recover wallet from passkey");
    expect(html).not.toContain(OWNER);
  });

  it("disables both money buttons and says why when there is no wallet at all", () => {
    const html = render({ portfolio: noWallets, ownerKind: "passkey", ownerAddress: OWNER, passkey: PASSKEY, signIn: () => undefined });
    expect(html).toContain("No agent wallet yet");
    expect(html).toContain("No agent wallet on this browser yet.");
    expect(html).not.toContain("0x3333…3333");
    expect(html).not.toContain(OWNER);
  });

  it("enables Withdraw once Available clears the reserve, and names the tier when it does not", () => {
    const passkeyProps = { ownerKind: "passkey" as const, ownerAddress: OWNER, passkey: WALLET_PASSKEY, signIn: () => undefined };
    const rich = render({ portfolio: withNative("1000000000000000000"), ...passkeyProps });
    expect(rich).not.toContain("kept back for network fees");
    expect(rich).not.toContain("Withdrawing needs the passkey");

    const poor = render({ portfolio: withNative("1000000000000000"), ...passkeyProps });
    expect(poor).toContain("Below the 0.0015 BNB kept back for network fees.");

    // The same balance clears the STEADY reserve once B has code on chain.
    const registered = render({ portfolio: withNative("1000000000000000"), ...passkeyProps, walletRegistered: true });
    expect(registered).not.toContain("kept back for network fees");

    const unreadable = render({ portfolio: partial, ...passkeyProps });
    expect(unreadable).toContain("The wallet balance could not be read.");
  });
});

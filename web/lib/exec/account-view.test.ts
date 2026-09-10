import { describe, expect, it } from "vitest";
import { accountPortfolioForOwner, currentAccountRequest, displayablePnlUsdMicros, signedReadFallbackRequired } from "./account-view";
import type { AccountCoverage, AccountPortfolio } from "./types";
import { erc20BalanceAtomic, isRemovedAgent, withdrawableTokens } from "./account-view";

const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";
const emptyCoverage: AccountCoverage = { state: "empty", reasons: ["none"] };
const payload: { data: AccountPortfolio } = { data: { generatedAt: 1, asOf: null, ownerAddress: OWNER_A, wallets: [], assets: [], agents: [], venus: null, totals: { walletUsdMicros: "0", deployedUsdMicros: "0", totalUsdMicros: "0", grossLpPnlUsdMicros: null, grossLpPnlBps: null, eligibleLpBasisNativeWei: null }, coverage: { universe: "known-assets", wallet: emptyCoverage, deployed: emptyCoverage, total: emptyCoverage, pnl: emptyCoverage, truncated: { agents: false, wallets: false, tokens: false, walletTokenPairs: false, positions: false } } } };

describe("Account browser boundary", () => {
  it("refuses a still-valid cookie response after the connected wallet changes", () => {
    expect(accountPortfolioForOwner(payload, OWNER_A)).not.toBeNull();
    expect(accountPortfolioForOwner(payload, OWNER_B)).toBeNull();
  });

  it("drops an owner-A response that completes after owner B starts loading", () => {
    expect(currentAccountRequest(1, 2, OWNER_A, OWNER_B)).toBe(false);
    expect(currentAccountRequest(2, 2, OWNER_B, OWNER_B)).toBe(true);
  });

  it("never displays a partial PnL subtotal", () => {
    const agent = { pnl: { coverage: "partial", pnlUsdMicros: "123" } } as AccountPortfolio["agents"][number];
    expect(displayablePnlUsdMicros(agent)).toBeNull();
  });

  it("uses the signed-read fallback only when session issuance is capability-hidden", () => {
    expect(signedReadFallbackRequired(404)).toBe(true);
    expect(signedReadFallbackRequired(401)).toBe(false);
  });

  it("accepts a typed deposit target and refuses a bare address or a non-depositable one", () => {
    const wallet = { address: OWNER_B, custodyModel: "passkey", depositable: true, source: "agents", availableUsdMicros: "0", deployedUsdMicros: null, deployedReason: "none" } as const;
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [wallet] } }, OWNER_A)?.wallets[0]?.address).toBe(OWNER_B);
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [OWNER_B] } }, OWNER_A)).toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...wallet, depositable: false }] } }, OWNER_A)).toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...wallet, custodyModel: "eoa" }] } }, OWNER_A)).toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ address: OWNER_B, custodyModel: "passkey", depositable: true }] } }, OWNER_A)).toBeNull();
  });

  it("accepts a DECLARED wallet only when it admits it measured no deployed value", () => {
    const declared = { address: OWNER_B, custodyModel: "passkey", depositable: true, source: "declared", availableUsdMicros: "4200000", deployedUsdMicros: "0", deployedReason: "declared", passkeyVerified: "verified" } as const;
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [declared] } }, OWNER_A)?.wallets[0]?.source).toBe("declared");
    // A declared entry may not claim a measured deployed figure...
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...declared, deployedUsdMicros: "1" }] } }, OWNER_A)).toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...declared, deployedReason: "none" }] } }, OWNER_A)).toBeNull();
    // ...and an agent-derived entry may not borrow the declared excuse.
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...declared, source: "agents" }] } }, OWNER_A)).toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...declared, source: "guessed" }] } }, OWNER_A)).toBeNull();
  });

  it("requires the KeyStore verdict on a declared entry and forbids it on an agent one", () => {
    const declared = { address: OWNER_B, custodyModel: "passkey", depositable: true, source: "declared", availableUsdMicros: "4200000", deployedUsdMicros: "0", deployedReason: "declared", passkeyVerified: "verified" } as const;
    for (const verdict of ["verified", "not-registered", "no-matching-key", "unreadable"] as const) {
      const wallets = [{ ...declared, passkeyVerified: verdict }];
      expect(accountPortfolioForOwner({ data: { ...payload.data, wallets } }, OWNER_A)?.wallets[0]?.passkeyVerified).toBe(verdict);
    }
    // A declared entry with NO verdict is not a valid answer any more: "we did
    // not check" has its own word, and silence is not it.
    const { passkeyVerified: _omitted, ...withoutVerdict } = declared;
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [withoutVerdict] } }, OWNER_A)).toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...declared, passkeyVerified: "probably" }] } }, OWNER_A)).toBeNull();
    // An AGENTS entry makes no caller claim, so it must not carry a verdict.
    const agentEntry = { address: OWNER_B, custodyModel: "passkey", depositable: true, source: "agents", availableUsdMicros: "0", deployedUsdMicros: null, deployedReason: "none" } as const;
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [agentEntry] } }, OWNER_A)).not.toBeNull();
    expect(accountPortfolioForOwner({ data: { ...payload.data, wallets: [{ ...agentEntry, passkeyVerified: "verified" }] } }, OWNER_A)).toBeNull();
  });

  it("rejects incomplete and cross-field-inconsistent wire DTOs", () => {
    expect(accountPortfolioForOwner({ data: { ownerAddress: OWNER_A } }, OWNER_A)).toBeNull();
    const inconsistent = { data: { ...payload.data, coverage: { ...payload.data.coverage, total: { state: "partial", reasons: ["dependency"] } } } };
    expect(accountPortfolioForOwner(inconsistent, OWNER_A)).toBeNull();
    const duplicateReasons = { data: { ...payload.data, totals: { ...payload.data.totals, totalUsdMicros: null }, coverage: { ...payload.data.coverage, total: { state: "partial", reasons: ["dependency", "dependency"] } } } };
    expect(accountPortfolioForOwner(duplicateReasons, OWNER_A)).toBeNull();
  });

  it("accepts every canonical aggregate coverage state with matching subtotal semantics", () => {
    for (const state of ["complete", "empty"] as const) {
      const candidate = { data: { ...payload.data, coverage: { ...payload.data.coverage, total: { state, reasons: ["none"] } } } };
      expect(accountPortfolioForOwner(candidate, OWNER_A)).not.toBeNull();
    }
    for (const state of ["partial", "unavailable"] as const) {
      const candidate = { data: { ...payload.data, totals: { ...payload.data.totals, totalUsdMicros: null }, coverage: { ...payload.data.coverage, total: { state, reasons: ["dependency"] } } } };
      expect(accountPortfolioForOwner(candidate, OWNER_A)).not.toBeNull();
    }
  });

  it("reads one known ERC-20 balance per wallet and answers null rather than zero when unreadable or unlisted", () => {
    const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const row = { kind: "erc20" as const, walletAddress: OWNER_A, tokenAddress: wbnb, symbol: "WBNB", decimals: 18, balanceAtomic: "7000000000000000", priceUsdMicros: null, pricedAt: null, valueUsdMicros: null, status: "unpriced" as const, method: "wallet-known-erc20-v1" as const };
    const portfolio = { ...payload.data, assets: [row] };
    expect(erc20BalanceAtomic(portfolio, OWNER_A.toUpperCase(), wbnb.toLowerCase())).toBe(7_000_000_000_000_000n);
    expect(erc20BalanceAtomic({ ...portfolio, assets: [{ ...row, status: "unreadable" as const, balanceAtomic: null }] }, OWNER_A, wbnb)).toBeNull();
    expect(erc20BalanceAtomic(portfolio, OWNER_A, "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c")).toBeNull();
  });

  it("treats revoked and retired as removed, and nothing else", () => {
    const agent = { status: "armed" } as AccountPortfolio["agents"][number];
    expect(["armed", "paused", "provisioning"].map((status) => isRemovedAgent({ ...agent, status: status as typeof agent.status }))).toEqual([false, false, false]);
    expect(["revoked", "retired"].map((status) => isRemovedAgent({ ...agent, status: status as typeof agent.status }))).toEqual([true, true]);
  });

  it("lists only tokens the wallet provably holds, and never one it could not read or price the decimals of", () => {
    const base = { kind: "erc20" as const, walletAddress: OWNER_A, tokenAddress: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", decimals: 18, balanceAtomic: "88852141410136", priceUsdMicros: null, pricedAt: null, valueUsdMicros: null, status: "unpriced" as const, method: "wallet-known-erc20-v1" as const };
    const portfolio = { ...payload.data, assets: [
      base,
      { ...base, tokenAddress: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", balanceAtomic: "0", status: "zero" as const },
      { ...base, tokenAddress: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", balanceAtomic: null, status: "unreadable" as const },
      { ...base, tokenAddress: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", symbol: "CAKE", decimals: null, balanceAtomic: "5" },
      { ...base, walletAddress: OWNER_B, symbol: "OTHER-WALLET" },
    ] };
    expect(withdrawableTokens(portfolio, OWNER_A.toUpperCase())).toEqual([
      { address: base.tokenAddress, symbol: "BTCB", decimals: 18, balanceAtomic: 88_852_141_410_136n },
    ]);
    expect(withdrawableTokens(portfolio, OWNER_B)).toHaveLength(1);
  });
});

describe("AGENT-GAS-ATTENTION: the account DTO's gas block", () => {
  const agentRow = (gas: unknown) => ({
    id: "lp-agent", status: "armed", httpRuntimeProfile: "lp-v1", walletAddress: OWNER_A,
    attention: "none", gas,
    holdings: { method: "sellable-lp-exit-v1", state: "empty", reason: "none", valueUsdMicros: null, venusReference: null, held: false },
    pnl: { method: "gross-lp-mark-plus-residue-to-declared-basis-v2", coverage: "unavailable", reason: "none",
      eligibleBasisNativeWei: null, markNativeWei: null, pnlNativeWei: null, pnlUsdMicros: null, pnlBps: null,
      basisSources: [], excluded: ["relay-and-gas", "wallet-residue", "closed-lineages", "prior-exits", "external-cashflows", "zero-basis-lineages"] },
  });
  const withAgent = (gas: unknown) =>
    accountPortfolioForOwner({ data: { ...payload.data, agents: [agentRow(gas)] } } as unknown, OWNER_A);
  const block = (over: Record<string, unknown> = {}) => ({
    state: "low", nativeWei: "300000000000000", nextMotionWei: "155200000000000",
    warnWei: "465600000000000", blockWei: "77600000000000", enforcement: "block", ...over,
  });

  it("accepts the well-formed cases — the CONTROL for every refusal below", () => {
    // Without this, a validator that refused EVERYTHING would pass the rest of
    // this suite while breaking the Account page outright.
    expect(withAgent(null)).not.toBeNull();
    expect(withAgent(block())?.agents[0]?.gas?.state).toBe("low");
    expect(withAgent(block({ nativeWei: "0", state: "blocked" }))?.agents[0]?.gas?.state).toBe("blocked");
    expect(withAgent(block({ nativeWei: "999999999999999999", state: "ok" }))?.agents[0]?.gas?.state).toBe("ok");
    expect(withAgent(block({ nativeWei: null, state: "unknown" }))?.agents[0]?.gas?.state).toBe("unknown");
  });

  it("refuses a state that contradicts its own thresholds", () => {
    // Review 2 probed a zero balance declared healthy against a positive floor.
    expect(withAgent(block({ nativeWei: "0", state: "ok" }))).toBeNull();
    expect(withAgent(block({ nativeWei: "0", state: "low" }))).toBeNull();
    expect(withAgent(block({ state: "blocked" }))).toBeNull();
    expect(withAgent(block({ nativeWei: "999999999999999999", state: "low" }))).toBeNull();
  });

  it("refuses zero, mis-ordered, malformed and contradictory-balance blocks", () => {
    expect(withAgent(block({ nextMotionWei: "0" }))).toBeNull();
    expect(withAgent(block({ blockWei: "0" }))).toBeNull();
    expect(withAgent(block({ warnWei: "0" }))).toBeNull();
    expect(withAgent(block({ blockWei: "999999999999999999" }))).toBeNull();
    expect(withAgent(block({ warnWei: "1" }))).toBeNull();
    expect(withAgent(block({ enforcement: "sometimes" }))).toBeNull();
    expect(withAgent(block({ state: "sideways" }))).toBeNull();
    expect(withAgent(block({ nativeWei: null }))).toBeNull();
    expect(withAgent(block({ state: "unknown" }))).toBeNull();
    // Unknown keys are still refused outright.
    expect(withAgent({ ...block(), extra: 1 })).toBeNull();
  });

  it("still refuses an agent row that omits the gas key entirely", () => {
    const { gas: _gas, ...withoutGas } = agentRow(null);
    expect(accountPortfolioForOwner({ data: { ...payload.data, agents: [withoutGas] } } as unknown, OWNER_A)).toBeNull();
  });
});

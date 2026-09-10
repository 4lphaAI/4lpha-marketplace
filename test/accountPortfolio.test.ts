import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, slice, type Address, type Hex } from "viem";
import { buildAccountPortfolio } from "../src/account/portfolio.js";
import {
  DeclaredWalletNotOwnedError,
  MAX_KEYS_PER_WALLET,
  verifyDeclaredWallet,
  type KeyStoreReader,
} from "../src/account/keyStoreReader.js";
import { passkeyOwnerAddress } from "../src/auth/webauthnEnvelope.js";
import type { DataPlaneClient } from "../src/clients/dataPlane.js";
import type { WalletProvider } from "../src/core/types.js";
import type { AgentRecord, AgentStore } from "../src/store/agents.js";
import type { LpObservationStore } from "../src/store/lpObservations.js";
import type { LpPositionRecord, LpSequenceStore } from "../src/store/lpSequences.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const TOKEN = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const NOW = 1_800_000;

/**
 * The GOLDEN VECTOR, measured by hand on BNB mainnet 2026-09-02.
 *
 * `KeyStore.getKeys(MAINNET_WALLET)` returned exactly one keyId and
 * `getPublicKey` returned MAINNET_PUBLIC_KEY — 64 bytes of FLAT P-256 `x || y`
 * (its leading byte is 0x04 by coincidence, not as a SEC1 prefix). Deriving
 * over its two halves reproduces PASSKEY_OWNER, the authenticated identity.
 * The reader is faked here; the BYTES are the chain's.
 */
const MAINNET_WALLET = getAddress("0xfab7ae2f15124a05b2939365b0e51533a122bee9");
const MAINNET_PUBLIC_KEY: Hex = "0x04ccb6ffbbbb453d1a48afbf210af19039f36a7ad8c9cec5bad78a403fee9ae7aeb84d4bdffcd380b37d34af01deae93184c3bbbac9bd0aa8038f1945be579a2";
const PASSKEY_OWNER = getAddress("0x324693514904b143041BeaE670780872f0E4465E");
const OTHER_PUBLIC_KEY: Hex = `0x${"11".repeat(64)}`;
const KEY_ID: Hex = `0x${"22".repeat(32)}`;

function fakeKeyStore(keyIds: readonly Hex[], publicKey: (keyId: Hex) => Hex): KeyStoreReader {
  return {
    listKeys: async (_wallet: Address) => keyIds,
    publicKeyFor: async (_wallet: Address, keyId: Hex) => publicKey(keyId),
  };
}

function deps(rows: readonly AgentRecord[]) {
  const agents = {
    listAgentsBounded: async () => ({ rows, hasMore: false }),
  } as unknown as AgentStore;
  const provider = {
    getBalance: async () => 2n * 10n ** 18n,
    getTokenBalance: async () => 0n,
  } as unknown as WalletProvider;
  const dataPlane = {
    tokenEnvelope: async (address: string) => ({ data: { address, priceUsd: 600 }, meta: { asOf: NOW - 1_000, staleness: "fresh" } }),
    venusAccount: async () => ({ kind: "untracked" as const }),
  } as unknown as DataPlaneClient;
  return { agents, provider, dataPlane, chainId: 56, wbnb: WBNB, now: () => NOW };
}

function agent(id: string, profile: AgentRecord["httpRuntimeProfile"], custodyModel: AgentRecord["custodyModel"] = "self-eoa"): AgentRecord {
  // AGENT-GAS-ATTENTION review finding 3: an LP position's two legs must each
  // produce an asset row before wallet residue may be attributed, and the token
  // universe comes from the session spend caps. A production LP session always
  // names both legs (it has to move them), so the fixture does too.
  const spendCaps = [{ token: WBNB, limit: 1n, period: "day" as const }, { token: TOKEN, limit: 1n, period: "day" as const }];
  return { id, ownerAddress: OWNER, walletAddress: WALLET, custodyModel, sessionFacts: { spec: { allowedCalls: [], spendCaps, expiresAt: 9_999_999_999 }, permissions: { calls: [], spend: [] }, publicKey: OTHER_PUBLIC_KEY, expiry: 9_999_999_999 } as unknown as AgentRecord["sessionFacts"], sessionRevocation: null, caps: null, status: "armed", httpRuntimeProfile: profile, erc8004AgentId: null, pendingGrant: null, rowVersion: 1, createdAt: 1, updatedAt: 1 };
}

describe("account portfolio", () => {
  it("returns an honest empty account", async () => {
    const view = await buildAccountPortfolio(OWNER, deps([]));
    assert.equal(view.coverage.wallet.state, "empty");
    assert.equal(view.totals.totalUsdMicros, "0");
    assert.deepEqual(view.wallets, []);
  });

  it("prices owner wallet native balance without inventing strategy PnL", async () => {
    const view = await buildAccountPortfolio(OWNER, deps([agent("raw-agent", "raw-v1")]));
    assert.equal(view.totals.walletUsdMicros, "1200000000");
    assert.equal(view.totals.totalUsdMicros, "1200000000");
    assert.equal(view.totals.grossLpPnlUsdMicros, null);
    assert.deepEqual(view.coverage.pnl.reasons, ["unsupported-profile"]);
    assert.equal(view.agents[0]?.httpRuntimeProfile, "raw-v1");
  });

  it("rejects a price envelope for a different token identity", async () => {
    const base = deps([agent("raw-agent", "raw-v1")]);
    const view = await buildAccountPortfolio(OWNER, {
      ...base,
      dataPlane: {
        ...base.dataPlane,
        tokenEnvelope: async () => ({ data: { address: OWNER, priceUsd: 600 }, meta: { asOf: NOW, staleness: "fresh" } }),
      },
    });
    assert.equal(view.totals.walletUsdMicros, null);
    assert.deepEqual(view.coverage.wallet.reasons, ["unpriced"]);
  });

  it("types each wallet as a deposit target carrying its own available and deployed value (R3/R4)", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: false }) } as unknown as LpSequenceStore;
    const observations = { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 5n * 10n ** 17n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.deepEqual(view.wallets, [{
      address: WALLET.toLowerCase(),
      custodyModel: "self-eoa",
      depositable: true,
      source: "agents",
      availableUsdMicros: "1200000000",
      deployedUsdMicros: "300000000",
      deployedReason: "none",
    }]);
    // The per-wallet split reconciles with the owner totals it sits beside.
    assert.equal(view.totals.walletUsdMicros, "1200000000");
    assert.equal(view.totals.deployedUsdMicros, "300000000");
  });

  it("refuses a per-wallet deployed figure it cannot complete", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: false }) } as unknown as LpSequenceStore;
    const observations = { get: async () => null } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.equal(view.wallets[0]?.deployedUsdMicros, null);
    assert.equal(view.wallets[0]?.availableUsdMicros, "1200000000");
  });

  it("builds the token-balance wallet ref from the ROW's owner, not the session owner (R1)", async () => {
    const rows = [{ ...agent("trade-agent", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }] } } }] as unknown as readonly AgentRecord[];
    const base = deps(rows);
    let seen: { readonly ownerAddress: string; readonly custodyModel: string } | null = null;
    const provider = {
      getBalance: async () => 0n,
      getTokenBalance: async ({ wallet }: { wallet: { ownerAddress: string; custodyModel: string } }) => { seen = wallet; return 0n; },
      getTokenMetadata: async () => ({ decimals: 18, symbol: "TEST" }),
    } as unknown as WalletProvider;
    await buildAccountPortfolio(OWNER, { ...base, provider });
    assert.equal(seen!.ownerAddress, rows[0]!.ownerAddress);
    assert.equal(seen!.custodyModel, "self-eoa");
  });

  it("nulls partial LP figures and every aggregate on position capacity", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: true }) } as unknown as LpSequenceStore;
    const observations = { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 12n * 10n ** 17n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.equal(view.coverage.pnl.state, "partial");
    assert.deepEqual(view.coverage.pnl.reasons, ["capacity"]);
    assert.equal(view.totals.grossLpPnlUsdMicros, null);
    assert.equal(view.totals.eligibleLpBasisNativeWei, null);
    assert.equal(view.agents[0]?.holdings.valueUsdMicros, null);
    assert.equal(view.agents[0]?.holdings.reason, "capacity");
    assert.equal(view.agents[0]?.pnl.pnlNativeWei, null);
  });

  it("does not publish eligible LP subsets when one mark is missing", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const positions = ["p-1", "p-2"].map((positionId, index) => ({ positionId, agentId: "lp-agent", tokenId: String(index + 1), rowVersion: 1, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" })) as unknown as readonly LpPositionRecord[];
    const store = { listOwnerPositionsBounded: async () => ({ rows: positions, hasMore: false }) } as unknown as LpSequenceStore;
    const observations = { get: async (_owner: unknown, _agent: unknown, positionId: string) => positionId === "p-1" ? { valuation: { method: "sellable-exit-v1", exitValueWei: 12n * 10n ** 17n, quoteToken: WBNB, tokenId: "1", positionRowVersion: 1, blockNumber: 10n, valuedAtMs: NOW } } : null } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.equal(view.agents[0]?.pnl.coverage, "partial");
    assert.equal(view.agents[0]?.pnl.pnlUsdMicros, null);
    assert.equal(view.agents[0]?.pnl.eligibleBasisNativeWei, null);
    assert.equal(view.totals.grossLpPnlUsdMicros, null);
  });

  it("computes positive full LP mark-to-declared-basis PnL", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: false }) } as unknown as LpSequenceStore;
    const observations = { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 12n * 10n ** 17n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.equal(view.totals.grossLpPnlUsdMicros, "120000000");
    assert.equal(view.totals.grossLpPnlBps, "2000");
    assert.equal(view.coverage.pnl.state, "complete");
  });

  it("excludes a zero-basis lineage from PnL", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 0n, basisSource: "minted" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: false }) } as unknown as LpSequenceStore;
    const observations = { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 1n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.equal(view.agents[0]?.pnl.coverage, "unavailable");
    assert.equal(view.agents[0]?.pnl.reason, "zero-basis");
    assert.equal(view.totals.grossLpPnlUsdMicros, null);
  });

  /* ---- the batched balance reader (the account read's own client) ------- */

  it("takes every balance from the batched reader in ONE call each, and never touches the provider", async () => {
    const rows = [
      { ...agent("a", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }] } } },
      { ...agent("b", "trade-v1"), walletAddress: getAddress("0x3333333333333333333333333333333333333333"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }] } } },
    ] as unknown as readonly AgentRecord[];
    const base = deps(rows);
    // The provider MUST NOT be reached: its client is the money path, and the
    // whole point of the seam is that the account read stops using it.
    const provider = {
      getBalance: async () => { throw new Error("provider must not be used"); },
      getTokenBalance: async () => { throw new Error("provider must not be used"); },
      getTokenMetadata: async () => { throw new Error("provider must not be used"); },
    } as unknown as WalletProvider;
    let nativeCalls = 0; let tokenCalls = 0; let metadataCalls = 0;
    const balanceReader = {
      nativeBalances: async (addresses: readonly Address[]) => { nativeCalls += 1; return addresses.map(() => 10n ** 18n); },
      tokenBalances: async (pairs: readonly unknown[]) => { tokenCalls += 1; return pairs.map(() => 2n * 10n ** 18n); },
      tokenMetadata: async (tokens: readonly Address[]) => { metadataCalls += 1; return tokens.map(() => ({ decimals: 18, symbol: "TEST" })); },
    };
    const view = await buildAccountPortfolio(OWNER, { ...base, provider, balanceReader });
    assert.deepEqual([nativeCalls, tokenCalls, metadataCalls], [1, 1, 1]);
    assert.equal(view.assets.filter((asset) => asset.kind === "native").length, 2);
    assert.equal(view.assets.filter((asset) => asset.kind === "erc20").length, 2);
    // 2 x 1 BNB + 2 x 2 TEST, all at $600.
    assert.equal(view.totals.walletUsdMicros, "3600000000");
    assert.deepEqual(view.coverage.wallet.reasons, ["none"]);
  });

  it("keeps a null from the batched reader positional, so one bad token never loses the others", async () => {
    const other = getAddress("0x5678000000000000000000000000000000005678");
    const rows = [{ ...agent("a", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }, { token: other }] } } }] as unknown as readonly AgentRecord[];
    const base = deps(rows);
    const sorted = [TOKEN.toLowerCase(), other.toLowerCase()].sort();
    const balanceReader = {
      nativeBalances: async () => [null],
      // `null` for the FIRST pair only; the second must still price.
      tokenBalances: async (pairs: readonly unknown[]) => pairs.map((_pair, index) => (index === 0 ? null : 10n ** 18n)),
      tokenMetadata: async (tokens: readonly Address[]) => tokens.map(() => ({ decimals: 18, symbol: "TEST" })),
    };
    const view = await buildAccountPortfolio(OWNER, { ...base, balanceReader });
    const erc20 = view.assets.filter((asset) => asset.kind === "erc20");
    assert.equal(erc20.length, 2);
    assert.equal(erc20.find((asset) => asset.tokenAddress === sorted[0])?.status, "unreadable");
    assert.equal(erc20.find((asset) => asset.tokenAddress === sorted[1])?.status, "priced");
    assert.equal(view.assets.find((asset) => asset.kind === "native")?.status, "unreadable");
    assert.deepEqual(view.coverage.wallet.reasons, ["unreadable"]);
    assert.equal(view.totals.walletUsdMicros, null);
  });

  it("falls back to the provider byte-identically when no batched reader is wired", async () => {
    const rows = [{ ...agent("a", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }] } } }] as unknown as readonly AgentRecord[];
    const base = deps(rows);
    let providerCalls = 0;
    const provider = {
      getBalance: async () => { providerCalls += 1; return 10n ** 18n; },
      getTokenBalance: async () => { providerCalls += 1; return 10n ** 18n; },
      getTokenMetadata: async () => { providerCalls += 1; return { decimals: 18, symbol: "TEST" }; },
    } as unknown as WalletProvider;
    const view = await buildAccountPortfolio(OWNER, { ...base, provider });
    assert.equal(providerCalls, 3);
    assert.equal(view.totals.walletUsdMicros, "1200000000");
  });

  it("treats a throwing batched reader as an unread answer, never as a failed request", async () => {
    const rows = [{ ...agent("a", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }] } } }] as unknown as readonly AgentRecord[];
    const base = deps(rows);
    const balanceReader = {
      nativeBalances: async () => { throw new Error("rpc down"); },
      tokenBalances: async () => { throw new Error("rpc down"); },
      tokenMetadata: async () => { throw new Error("rpc down"); },
    };
    const view = await buildAccountPortfolio(OWNER, { ...base, balanceReader });
    assert.equal(view.assets.length, 2);
    assert.ok(view.assets.every((asset) => asset.status === "unreadable"));
    assert.equal(view.totals.walletUsdMicros, null);
  });

  it("marks conflicting custody identity unreadable", async () => {
    const view = await buildAccountPortfolio(OWNER, deps([agent("a", "raw-v1"), agent("b", "raw-v1", "passkey")]));
    assert.equal(view.totals.walletUsdMicros, null);
    assert.deepEqual(view.coverage.wallet.reasons, ["identity-conflict"]);
  });

  it("counts Venus once and keeps only a shared agent reference", async () => {
    const base = deps([agent("venus-a", "venus-v1"), agent("venus-b", "venus-v1")]);
    const dataPlane = { ...base.dataPlane, venusAccount: async () => ({ kind: "ok" as const, envelope: { data: { schemaVersion: 2, chainId: 56, pool: "core", status: "available", owner: OWNER, observedAt: NOW, unavailable: [], positions: [{ vToken: "0x4444444444444444444444444444444444444444", underlying: { decimals: 18 }, suppliedUnderlyingStored: { value: "2000000000000000000", decimals: 18 }, borrowStored: { value: "500000000000000000", decimals: 18 }, prices: { scaleKind: "venus_underlying_price", decimals: 18, spot: "1000000000000000000" } }] }, meta: { asOf: NOW, staleness: "fresh" } } }) };
    const view = await buildAccountPortfolio(OWNER, { ...base, dataPlane });
    assert.equal(view.venus?.netUsdMicros, "1500000");
    assert.equal(view.totals.deployedUsdMicros, "1500000");
    assert.equal(view.agents[0]?.holdings.valueUsdMicros, null);
    assert.equal(view.agents[1]?.holdings.venusReference, "owner-wide");
  });

  it("propagates aggregate cancellation into an in-flight owner store", async () => {
    let releaseStarted!: () => void; const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    let observedAbort = false;
    const stalled = { listAgentsBounded: async (_owner: unknown, _limit: unknown, signal?: AbortSignal) => await new Promise<never>((_resolve, reject) => {
      releaseStarted();
      signal?.addEventListener("abort", () => { observedAbort = true; reject(new Error("store cancelled")); }, { once: true });
    }) } as unknown as AgentStore;
    const controller = new AbortController();
    const work = buildAccountPortfolio(OWNER, { ...deps([]), agents: stalled }, undefined, controller.signal);
    await started; controller.abort();
    await assert.rejects(work, /timed out/u);
    assert.equal(observedAbort, true);
  });

  it("rejects stale and row-version-mismatched LP marks", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: false }) } as unknown as LpSequenceStore;
    for (const valuation of [
      { method: "sellable-exit-v1", exitValueWei: 2n * 10n ** 18n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 1, blockNumber: 10n, valuedAtMs: NOW },
      { method: "sellable-exit-v1", exitValueWei: 2n * 10n ** 18n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW - 900_001 },
    ] as const) {
      const observations = { get: async () => ({ valuation }) } as unknown as LpObservationStore;
      const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 600_000 } });
      assert.equal(view.agents[0]?.pnl.coverage, "unavailable");
      assert.equal(view.agents[0]?.pnl.pnlNativeWei, null);
    }
  });

  it("includes the BNB price timestamp when a zero LP mark publishes negative PnL", async () => {
    const base = deps([agent("lp-agent", "lp-v1")]);
    const position = { positionId: "p-1", agentId: "lp-agent", tokenId: "7", rowVersion: 2, quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget" } as unknown as LpPositionRecord;
    const store = { listOwnerPositionsBounded: async () => ({ rows: [position], hasMore: false }) } as unknown as LpSequenceStore;
    const observations = { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 0n, quoteToken: WBNB, tokenId: "7", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore;
    const view = await buildAccountPortfolio(OWNER, { ...base, lp: { store, observations, workerIntervalMs: 30_000 } });
    assert.equal(view.totals.grossLpPnlUsdMicros, "-600000000");
    assert.equal(view.asOf, NOW - 1_000);
  });

  it("caps wallet RPC fan-out at six", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...agent(`raw-${index}`, "raw-v1"),
      walletAddress: getAddress(`0x${(index + 10).toString(16).padStart(40, "0")}`),
    }));
    let active = 0; let peak = 0;
    const provider = {
      getBalance: async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; return 1n; },
      getTokenBalance: async () => 0n,
    } as unknown as WalletProvider;
    const base = deps(rows);
    await buildAccountPortfolio(OWNER, { ...base, provider });
    assert.equal(peak, 6);
  });

  it("deduplicates a shared wallet and preserves bigint precision", async () => {
    let balanceReads = 0;
    const base = deps([agent("a", "raw-v1"), agent("b", "raw-v1")]);
    const provider = { getBalance: async () => { balanceReads += 1; return 10n ** 30n; }, getTokenBalance: async () => 0n } as unknown as WalletProvider;
    const view = await buildAccountPortfolio(OWNER, { ...base, provider });
    assert.equal(balanceReads, 1);
    assert.equal(view.wallets.length, 1);
    assert.equal(view.totals.walletUsdMicros, "600000000000000000000");
  });

  it("canonicalizes case-variant wallet-token attribution", async () => {
    const rows = [
      { ...agent("a", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN }] } } },
      { ...agent("b", "trade-v1"), sessionFacts: { spec: { spendCaps: [{ token: TOKEN.toLowerCase() }] } } },
    ] as unknown as readonly AgentRecord[];
    let tokenReads = 0;
    const base = deps(rows);
    const provider = {
      getBalance: async () => 0n,
      getTokenBalance: async ({ token }: { token: string }) => { tokenReads += 1; assert.equal(token.toLowerCase(), TOKEN.toLowerCase()); return 10n ** 18n; },
      getTokenMetadata: async ({ token }: { token: string }) => { assert.equal(token.toLowerCase(), TOKEN.toLowerCase()); return { decimals: 18, symbol: "TEST" }; },
    } as unknown as WalletProvider;
    const view = await buildAccountPortfolio(OWNER, { ...base, provider });
    const erc20 = view.assets.filter((asset) => asset.kind === "erc20");
    assert.equal(tokenReads, 1);
    assert.equal(erc20.length, 1);
    assert.equal(erc20[0]?.tokenAddress, TOKEN.toLowerCase());
    assert.equal(view.totals.walletUsdMicros, "600000000");
  });

  it("preserves every persisted agent status with deterministic attention", async () => {
    const statuses = ["provisioning", "armed", "paused", "revoked", "retired"] as const;
    const rows = statuses.map((status) => ({ ...agent(status, "raw-v1"), status }));
    const view = await buildAccountPortfolio(OWNER, deps(rows));
    assert.deepEqual(view.agents.map((entry) => entry.status), statuses);
    assert.deepEqual(view.agents.map((entry) => entry.attention), ["provisioning", "none", "paused", "none", "none"]);
  });

  it("caps wallet-token pairs at 128 and nulls totals", async () => {
    const tokens = Array.from({ length: 20 }, (_, index) => getAddress(`0x${(index + 100).toString(16).padStart(40, "0")}`));
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...agent(`raw-${index}`, "raw-v1"),
      walletAddress: getAddress(`0x${(index + 10).toString(16).padStart(40, "0")}`),
      sessionFacts: { spec: { spendCaps: tokens.map((token) => ({ token })) } },
    })) as unknown as readonly AgentRecord[];
    const base = deps(rows);
    const provider = { getBalance: async () => 0n, getTokenBalance: async () => 0n, getTokenMetadata: async () => ({ decimals: 18, symbol: null }) } as unknown as WalletProvider;
    const view = await buildAccountPortfolio(OWNER, { ...base, provider });
    assert.equal(view.coverage.truncated.walletTokenPairs, true);
    assert.equal(view.assets.filter((asset) => asset.kind === "erc20").length, 128);
    assert.equal(view.totals.totalUsdMicros, null);
  });

  /* ---- declared wallets (the fresh passkey owner with no rows) ---------- */

  it("reads a declared wallet with no agent rows at all", async () => {
    const base = deps([]);
    const seen: string[] = [];
    const provider = {
      getBalance: async ({ address }: { address: string }) => { seen.push(address.toLowerCase()); return 3n * 10n ** 18n; },
      getTokenBalance: async () => 0n,
      getTokenMetadata: async () => ({ decimals: 18, symbol: "TEST" }),
    } as unknown as WalletProvider;
    const view = await buildAccountPortfolio(OWNER, { ...base, provider }, { declaredWallets: [WALLET] });
    assert.deepEqual(seen, [WALLET.toLowerCase()]);
    assert.equal(view.wallets.length, 1);
    assert.equal(view.wallets[0]?.address, WALLET.toLowerCase());
    assert.equal(view.wallets[0]?.source, "declared");
    assert.equal(view.wallets[0]?.custodyModel, "passkey");
    assert.equal(view.wallets[0]?.depositable, true);
    assert.equal(view.wallets[0]?.availableUsdMicros, "1800000000");
    assert.equal(view.wallets[0]?.deployedUsdMicros, "0");
    assert.equal(view.wallets[0]?.deployedReason, "declared");
    // The owner totals carry it: this is the figure the screen shows.
    assert.equal(view.totals.walletUsdMicros, "1800000000");
    assert.equal(view.totals.totalUsdMicros, "1800000000");
    assert.equal(view.coverage.wallet.state, "complete");
    assert.equal(view.assets.some((asset) => asset.kind === "native" && asset.walletAddress === WALLET.toLowerCase()), true);
  });

  it("reads the six pinned BSC tokens for a declared wallet and nothing else", async () => {
    const base = deps([]);
    const tokens: string[] = [];
    const provider = {
      getBalance: async () => 0n,
      getTokenBalance: async ({ token }: { token: string }) => { tokens.push(token.toLowerCase()); return 0n; },
      getTokenMetadata: async () => ({ decimals: 18, symbol: "TEST" }),
    } as unknown as WalletProvider;
    await buildAccountPortfolio(OWNER, { ...base, provider }, { declaredWallets: [WALLET] });
    assert.deepEqual(tokens.sort(), [
      "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
      "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
      "0x55d398326f99059ff775485246999027b3197955",
      "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    ]);
  });

  it("does not double a declared wallet that already carries agent rows", async () => {
    let balanceReads = 0;
    const base = deps([agent("raw-agent", "raw-v1")]);
    const provider = { getBalance: async () => { balanceReads += 1; return 2n * 10n ** 18n; }, getTokenBalance: async () => 0n } as unknown as WalletProvider;
    const view = await buildAccountPortfolio(OWNER, { ...base, provider }, { declaredWallets: [WALLET] });
    assert.equal(balanceReads, 1);
    assert.equal(view.wallets.length, 1);
    // The agent-derived entry wins: it carries real knowledge.
    assert.equal(view.wallets[0]?.source, "agents");
    assert.equal(view.totals.walletUsdMicros, "1200000000");
  });

  it("caps declared wallets at two and deduplicates case variants", async () => {
    const other = getAddress("0x9999999999999999999999999999999999999999");
    const third = getAddress("0x8888888888888888888888888888888888888888");
    const base = deps([]);
    const view = await buildAccountPortfolio(OWNER, base, { declaredWallets: [WALLET, getAddress(WALLET.toLowerCase()), other, third] });
    assert.equal(view.wallets.length, 2);
    // Deduplicated, sorted, then capped — so the two lowest addresses survive.
    assert.deepEqual(view.wallets.map((entry) => entry.address), [WALLET.toLowerCase(), third.toLowerCase()]);
  });

  /* ---- the KeyStore proof behind a declared wallet ---------------------- */

  it("proves a declared wallet against the pinned mainnet KeyStore vector", async () => {
    // Measured on BNB mainnet 2026-09-02: this wallet lists exactly one keyId,
    // whose registered public key is a 64-byte FLAT P-256 `x || y` deriving
    // this passkey owner identity. No network here — the reader is a fake
    // replaying the bytes the chain returned.
    const verdict = await verifyDeclaredWallet({
      owner: PASSKEY_OWNER,
      wallet: MAINNET_WALLET,
      reader: fakeKeyStore([KEY_ID], () => MAINNET_PUBLIC_KEY),
    });
    assert.equal(verdict, "verified");
    assert.equal(passkeyOwnerAddress(slice(MAINNET_PUBLIC_KEY, 0, 32), slice(MAINNET_PUBLIC_KEY, 32, 64)), PASSKEY_OWNER);
  });

  it("names every non-verified verdict without confusing them", async () => {
    const cases: readonly [string, KeyStoreReader | undefined, string][] = [
      ["empty registry", fakeKeyStore([], () => MAINNET_PUBLIC_KEY), "not-registered"],
      ["someone else's key", fakeKeyStore([KEY_ID], () => OTHER_PUBLIC_KEY), "no-matching-key"],
      ["absent reader", undefined, "unreadable"],
      ["listKeys throws", { listKeys: async () => { throw new Error("rpc down"); }, publicKeyFor: async () => MAINNET_PUBLIC_KEY }, "unreadable"],
      // Every key read threw ⇒ the registry did not answer. That is not
      // evidence about ownership, so it must NOT become the refusing verdict.
      ["publicKeyFor throws", { listKeys: async () => [KEY_ID], publicKeyFor: async () => { throw new Error("rpc down"); } }, "unreadable"],
      // Bounded work: more keys than the cap is "could not check", not "not yours".
      ["too many keys", fakeKeyStore(Array.from({ length: MAX_KEYS_PER_WALLET + 1 }, () => KEY_ID), () => MAINNET_PUBLIC_KEY), "unreadable"],
      // A 65-byte SEC1 blob is not a candidate — never coerced into a derivation.
      ["wrong key length", fakeKeyStore([KEY_ID], () => `0x04${MAINNET_PUBLIC_KEY.slice(2)}` as Hex), "no-matching-key"],
    ];
    for (const [label, reader, expected] of cases) {
      const verdict = await verifyDeclaredWallet({ owner: PASSKEY_OWNER, wallet: MAINNET_WALLET, ...(reader === undefined ? {} : { reader }) });
      assert.equal(verdict, expected, label);
    }
  });

  it("carries the verdict on the declared entry and refuses only the provable impostor", async () => {
    const base = deps([]);
    const provider = { getBalance: async () => 10n ** 18n, getTokenBalance: async () => 0n, getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }) } as unknown as WalletProvider;
    for (const [reader, expected] of [
      [fakeKeyStore([KEY_ID], () => MAINNET_PUBLIC_KEY), "verified"],
      [fakeKeyStore([], () => MAINNET_PUBLIC_KEY), "not-registered"],
      [undefined, "unreadable"],
    ] as const) {
      const view = await buildAccountPortfolio(PASSKEY_OWNER, { ...base, provider, ...(reader === undefined ? {} : { keyStoreReader: reader }) }, { declaredWallets: [MAINNET_WALLET] });
      assert.equal(view.wallets[0]?.passkeyVerified, expected);
      // Balances are still returned: the counterfactual must not blank the screen.
      assert.equal(view.wallets[0]?.availableUsdMicros, "600000000");
    }
    await assert.rejects(
      buildAccountPortfolio(PASSKEY_OWNER, { ...base, provider, keyStoreReader: fakeKeyStore([KEY_ID], () => OTHER_PUBLIC_KEY) }, { declaredWallets: [MAINNET_WALLET] }),
      DeclaredWalletNotOwnedError,
    );
  });

  it("never puts the verdict on a wallet the plane owns rows for", async () => {
    const base = deps([agent("raw-agent", "raw-v1")]);
    const view = await buildAccountPortfolio(OWNER, { ...base, keyStoreReader: fakeKeyStore([KEY_ID], () => MAINNET_PUBLIC_KEY) });
    assert.equal(view.wallets[0]?.source, "agents");
    assert.equal(Object.prototype.hasOwnProperty.call(view.wallets[0]!, "passkeyVerified"), false);
  });

  it("rejects malformed, stale, and duplicate Venus snapshots", async () => {
    const base = deps([agent("venus", "venus-v1")]);
    const validPosition = { vToken: "0x4444444444444444444444444444444444444444", underlying: { decimals: 18 }, suppliedUnderlyingStored: { value: "1", decimals: 18 }, borrowStored: { value: "0", decimals: 18 }, prices: { scaleKind: "venus_underlying_price", decimals: 18, spot: "1" } };
    for (const data of [
      { schemaVersion: 2, chainId: 56, pool: "core", status: "available", owner: OWNER, observedAt: NOW - 300_001, unavailable: [], positions: [validPosition] },
      { schemaVersion: 2, chainId: 56, pool: "core", status: "available", owner: OWNER, observedAt: NOW, unavailable: [], positions: [validPosition, validPosition] },
      { schemaVersion: 2, chainId: 56, pool: "core", status: "available", owner: OWNER, observedAt: NOW, unavailable: ["oracle"], positions: [validPosition] },
    ]) {
      const dataPlane = { ...base.dataPlane, venusAccount: async () => ({ kind: "ok" as const, envelope: { data, meta: { asOf: data.observedAt, staleness: "fresh" } } }) };
      const view = await buildAccountPortfolio(OWNER, { ...base, dataPlane });
      assert.equal(view.venus, null);
      assert.equal(view.totals.totalUsdMicros, null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* AGENT-GAS-ATTENTION §4 — wallet residue in the Account PnL                  */
/* -------------------------------------------------------------------------- */

describe("account portfolio wallet residue (PnL v2)", () => {
  /** An agent whose session names both position legs, so both are swept. */
  function lpAgentWithLegs(id: string, walletAddress = WALLET): AgentRecord {
    return {
      ...agent(id, "lp-v1"),
      walletAddress,
      sessionFacts: {
        spec: { allowedCalls: [], spendCaps: [{ token: WBNB, limit: 1n, period: "day" }, { token: TOKEN, limit: 1n, period: "day" }], expiresAt: 9_999_999_999 },
        permissions: { calls: [], spend: [] },
        publicKey: OTHER_PUBLIC_KEY,
        expiry: 9_999_999_999,
      },
    } as unknown as AgentRecord;
  }

  function lpStores(agentIds: readonly string[]) {
    const rows = agentIds.map((agentId, index) => ({
      positionId: `p-${index}`, agentId, tokenId: String(index + 1), rowVersion: 2,
      quoteToken: WBNB, token0: WBNB, token1: TOKEN, state: "open",
      basisWei: 10n ** 18n, basisSource: "owner-budget",
    })) as unknown as readonly LpPositionRecord[];
    return {
      store: { listOwnerPositionsBounded: async () => ({ rows, hasMore: false }) } as unknown as LpSequenceStore,
      observations: { get: async (_o: unknown, _a: unknown, positionId: string) => {
        const index = rows.findIndex((row) => row.positionId === positionId);
        return index < 0 ? null : { valuation: { method: "sellable-exit-v1", exitValueWei: 10n ** 18n,
          quoteToken: WBNB, tokenId: rows[index]!.tokenId, positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } };
      } } as unknown as LpObservationStore,
    };
  }

  it("attributes residue to the sole live agent on the wallet", async () => {
    // Position marks exactly at basis (PnL 0 before residue), then 1 WBNB and
    // 1 TOKEN of idle dust at $600 each = $1200 = 2 BNB of gross gain.
    const base = deps([lpAgentWithLegs("lp-agent")]);
    const view = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getTokenBalance: async () => 10n ** 18n, getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }) } as unknown as WalletProvider,
      lp: { ...lpStores(["lp-agent"]), workerIntervalMs: 30_000 },
    });

    const pnl = view.agents[0]!.pnl;
    assert.equal(pnl.method, "gross-lp-mark-plus-residue-to-declared-basis-v2");
    assert.equal(pnl.coverage, "full");
    assert.equal(pnl.pnlNativeWei, (2n * 10n ** 18n).toString());
    // And the exclusion list stops claiming the residue was left out.
    assert.ok(!pnl.excluded.includes("wallet-residue"));
    assert.ok(pnl.excluded.includes("relay-and-gas"), "gas stays excluded: PnL is GROSS");
  });

  it("refuses to attribute residue on a wallet shared by two live agents", async () => {
    const base = deps([lpAgentWithLegs("lp-a"), lpAgentWithLegs("lp-b")]);
    const view = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getTokenBalance: async () => 10n ** 18n, getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }) } as unknown as WalletProvider,
      lp: { ...lpStores(["lp-a", "lp-b"]), workerIntervalMs: 30_000 },
    });

    for (const view_ of view.agents) {
      assert.equal(view_.pnl.coverage, "partial");
      assert.equal(view_.pnl.reason, "shared-wallet");
      assert.ok(view_.pnl.excluded.includes("wallet-residue"), "an unattributable residue stays declared as excluded");
      assert.equal(view_.pnl.pnlNativeWei, null, "no guess, no split, no published figure");
    }
    assert.equal(view.totals.grossLpPnlUsdMicros, null);
  });

  it("THE TRAP: residue must not reach the deployed aggregate or the account total", async () => {
    // Wallet residue is ALREADY counted in `totals.walletUsdMicros` via the
    // `assets` rows. If it also entered `deployedUsdMicros`, the account total
    // would count the same dust twice. This is the assertion the plan asks the
    // review to check.
    const base = deps([lpAgentWithLegs("lp-agent")]);
    const withDust = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getTokenBalance: async () => 10n ** 18n, getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }) } as unknown as WalletProvider,
      lp: { ...lpStores(["lp-agent"]), workerIntervalMs: 30_000 },
    });
    const noDust = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getTokenBalance: async () => 0n, getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }) } as unknown as WalletProvider,
      lp: { ...lpStores(["lp-agent"]), workerIntervalMs: 30_000 },
    });

    // Deployed counts the POSITION only, so the dust changes it not at all.
    assert.equal(withDust.totals.deployedUsdMicros, noDust.totals.deployedUsdMicros);
    // The total moves by exactly the dust's own wallet value, and by no more.
    const walletDelta = BigInt(withDust.totals.walletUsdMicros!) - BigInt(noDust.totals.walletUsdMicros!);
    const totalDelta = BigInt(withDust.totals.totalUsdMicros!) - BigInt(noDust.totals.totalUsdMicros!);
    assert.equal(totalDelta, walletDelta, "the dust must be counted exactly once");
  });

  it("publishes nothing when a leg cannot be priced", async () => {
    const base = deps([lpAgentWithLegs("lp-agent")]);
    const view = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getTokenBalance: async () => { throw new Error("rpc down"); } } as unknown as WalletProvider,
      lp: { ...lpStores(["lp-agent"]), workerIntervalMs: 30_000 },
    });
    assert.equal(view.agents[0]?.pnl.coverage, "partial");
    assert.equal(view.agents[0]?.pnl.pnlNativeWei, null);
  });
});

describe("AGENT-GAS-ATTENTION review fixes", () => {
  function lpAgentWithLegs2(id: string): AgentRecord {
    return {
      ...agent(id, "lp-v1"),
      sessionFacts: {
        spec: { allowedCalls: [], spendCaps: [{ token: WBNB, limit: 1n, period: "day" }, { token: TOKEN, limit: 1n, period: "day" }], expiresAt: 9_999_999_999 },
        permissions: { calls: [], spend: [] },
        publicKey: OTHER_PUBLIC_KEY,
        expiry: 9_999_999_999,
      },
    } as unknown as AgentRecord;
  }

  function stores(agentId: string) {
    const rows = [{
      positionId: "p-0", agentId, tokenId: "1", rowVersion: 2, quoteToken: WBNB,
      token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget",
    }] as unknown as readonly LpPositionRecord[];
    return {
      store: { listOwnerPositionsBounded: async () => ({ rows, hasMore: false }) } as unknown as LpSequenceStore,
      observations: { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 10n ** 18n,
        quoteToken: WBNB, tokenId: "1", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore,
    };
  }

  it("REVIEW FINDING 3: a leg with no asset row makes the residue UNKNOWN, not zero", async () => {
    // The defect: the residue summed the rows it could SEE and never proved the
    // rows it NEEDED existed. Here the session grants only ONE of the two legs,
    // so the other never produces an asset row — exactly what token/pair
    // truncation does on a busy account. The first build published
    // `coverage: "full"` with the missing leg counted as nothing.
    const oneLeg = {
      ...agent("lp-agent", "lp-v1"),
      sessionFacts: {
        spec: { allowedCalls: [], spendCaps: [{ token: WBNB, limit: 1n, period: "day" }], expiresAt: 9_999_999_999 },
        permissions: { calls: [], spend: [] }, publicKey: OTHER_PUBLIC_KEY, expiry: 9_999_999_999,
      },
    } as unknown as AgentRecord;
    const base = deps([oneLeg]);
    const view = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getTokenBalance: async () => 10n ** 18n, getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }) } as unknown as WalletProvider,
      lp: { ...stores("lp-agent"), workerIntervalMs: 30_000 },
    });
    assert.equal(view.agents[0]?.pnl.coverage, "partial");
    assert.equal(view.agents[0]?.pnl.pnlNativeWei, null);
    assert.ok(view.agents[0]?.pnl.excluded.includes("wallet-residue"));
  });

  it("REVIEW FINDING 5: a short Venus wallet is gas-low, never gas-blocked", async () => {
    // A Venus guard is WARN-ONLY: it keeps submitting reduced repays. Reporting
    // it as stood down would tell an owner their liquidation guard had given up
    // while it was still working for them.
    const base = deps([agent("venus-agent", "venus-v1")]);
    const view = await buildAccountPortfolio(OWNER, {
      ...base,
      provider: { ...base.provider, getBalance: async () => 1n } as unknown as WalletProvider,
      lp: { store: {} as unknown as LpSequenceStore, observations: {} as unknown as LpObservationStore,
        workerIntervalMs: 30_000, relayFeePerSubmitWei: 38_800_000_000_000n },
    });
    const venus = view.agents.find((row) => row.id === "venus-agent");
    assert.equal(venus?.gas?.enforcement, "warn-only");
    assert.equal(venus?.gas?.state, "blocked", "the plane still classifies the shortfall honestly");
    assert.equal(venus?.attention, "gas-low", "but it must never be REPORTED as stood down");
  });
});

describe("AGENT-GAS-ATTENTION review 2: the truncation vetoes have teeth", () => {
  function lpAgentLegs(id: string): AgentRecord {
    return {
      ...agent(id, "lp-v1"),
      sessionFacts: {
        spec: { allowedCalls: [], spendCaps: [{ token: WBNB, limit: 1n, period: "day" }, { token: TOKEN, limit: 1n, period: "day" }], expiresAt: 9_999_999_999 },
        permissions: { calls: [], spend: [] }, publicKey: OTHER_PUBLIC_KEY, expiry: 9_999_999_999,
      },
    } as unknown as AgentRecord;
  }
  const rows = [{
    positionId: "p-0", agentId: "lp-agent", tokenId: "1", rowVersion: 2, quoteToken: WBNB,
    token0: WBNB, token1: TOKEN, state: "open", basisWei: 10n ** 18n, basisSource: "owner-budget",
  }] as unknown as readonly LpPositionRecord[];
  const lpDeps = {
    store: { listOwnerPositionsBounded: async () => ({ rows, hasMore: false }) } as unknown as LpSequenceStore,
    observations: { get: async () => ({ valuation: { method: "sellable-exit-v1", exitValueWei: 10n ** 18n,
      quoteToken: WBNB, tokenId: "1", positionRowVersion: 2, blockNumber: 10n, valuedAtMs: NOW } }) } as unknown as LpObservationStore,
    workerIntervalMs: 30_000,
  };
  const provider = (base: ReturnType<typeof deps>) => ({
    ...base.provider, getTokenBalance: async () => 10n ** 18n,
    getTokenMetadata: async () => ({ decimals: 18, symbol: "T" }),
  } as unknown as WalletProvider);

  it("a TRUNCATED AGENT census cannot prove the wallet is sole-tenant", async () => {
    // Review 2: removing both truncation vetoes survived the previous suite,
    // because nothing exercised a truncated read. 33 agents forces
    // `truncated.agents`, and the sole-live-agent count is then unprovable —
    // attributing dust on it would hand one agent another's money.
    const base = deps([lpAgentLegs("lp-agent")]);
    const truncatedAgents = {
      listAgentsBounded: async () => ({ rows: [lpAgentLegs("lp-agent")], hasMore: true }),
    } as unknown as AgentStore;
    const view = await buildAccountPortfolio(OWNER, {
      ...base, agents: truncatedAgents, provider: provider(base), lp: lpDeps,
    });
    assert.equal(view.coverage.truncated.agents, true, "the fixture must actually truncate");
    const row = view.agents.find((entry) => entry.id === "lp-agent");
    assert.equal(row?.pnl.reason, "shared-wallet");
    assert.equal(row?.pnl.pnlNativeWei, null);
    assert.ok(row?.pnl.excluded.includes("wallet-residue"));
  });

  it("a TRUNCATED TOKEN sweep cannot prove the legs were all read", async () => {
    // 65 granted tokens forces `truncated.tokens`. The fillers are chosen to
    // sort AFTER both legs (`0xff…`), so the legs DO survive the 64-token cap
    // and their rows are present — which means only the VETO can produce
    // `partial` here. With low-sorting fillers the legs are cut instead and the
    // leg-presence check fires, which would test the wrong thing: verified by
    // mutation, where removing the tokens veto alone survived that version.
    const caps = Array.from({ length: 65 }, (_, i) => ({
      token: `0xff${(i + 1).toString(16).padStart(38, "0")}`, limit: 1n, period: "day",
    }));
    const wide = {
      ...agent("lp-agent", "lp-v1"),
      sessionFacts: { spec: { allowedCalls: [], spendCaps: [...caps, { token: WBNB, limit: 1n, period: "day" }, { token: TOKEN, limit: 1n, period: "day" }], expiresAt: 9_999_999_999 },
        permissions: { calls: [], spend: [] }, publicKey: OTHER_PUBLIC_KEY, expiry: 9_999_999_999 },
    } as unknown as AgentRecord;
    const base = deps([wide]);
    const view = await buildAccountPortfolio(OWNER, { ...base, provider: provider(base), lp: lpDeps });
    assert.equal(view.coverage.truncated.tokens, true, "the fixture must actually truncate");
    assert.equal(view.agents[0]?.pnl.coverage, "partial");
    assert.equal(view.agents[0]?.pnl.pnlNativeWei, null);
  });
});

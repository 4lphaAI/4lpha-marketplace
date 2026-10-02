/**
 * Auto DCA part B — the plane routes (AUTO-DCA-SPEC §13 with Revision 2;
 * REVIEW2 §7). Offline: memory stores, a fake DCA chain, no RPC, no env.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import type { GrantEvidenceReader } from "../src/wallet/grantEvidence.js";
import { APPROVE_SELECTOR, TRADFI_GUARD_SWAP_SELECTOR, tradeSessionSpec } from "../src/ops/policy.js";
import { NFPM_56 } from "../src/ops/nfpm.js";
import {
  FLAP_PORTAL_56,
  FOUR_MEME_TOKEN_MANAGER_56,
  PANCAKE_V2_ROUTER_56,
  PANCAKE_V3_ROUTER_56,
  UNISWAP_V3_ROUTER02_56,
  WBNB_56,
} from "../src/ops/venues.js";
import { MemoryAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryDcaRoundStore } from "../src/store/dcaRounds.js";
import type { TradeDataPlaneReads } from "../src/trade/dataPlaneReads.js";
import type { TradeReadiness } from "../src/trade/readiness.js";
import { tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { dcaNativeReserveWei } from "../src/trade/sizing.js";
import { dcaLevelPrice, dcaPoolForToken, dcaPoolLegs, dcaPriceAtTick, type DcaBatchPlan, type DcaBatchKind } from "../src/trade/dca.js";
import { createDcaChainReads, type DcaPoolIdentity, type DcaPositionRead } from "../src/trade/dcaResolve.js";
import { getSqrtRatioAtTick } from "../src/lp/tickMath.js";
import { E18, NV, NVDAB, NV_TICK, dcaRpcEndpoint, dcaSettings } from "./support/dcaFixtures.js";
import { call, createHarness, EXEC_TOKEN, NOW_SEC, ownerAccount, signOwnerAction, toReadHeader, tradeConfig, type Harness, type SignedEnvelope } from "./support/serverHarness.js";

const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const GUARD = getAddress("0x9000000000000000000000000000000000009000");
const PUBLIC_KEY = `0x04${"ab".repeat(64)}` as Hex;
const CAP = dcaNativeReserveWei(4);
const VENUES = { chainId: 56, pancakeRouterV2: PANCAKE_V2_ROUTER_56, pancakeRouterV3: PANCAKE_V3_ROUTER_56,
  uniswapRouterV3: UNISWAP_V3_ROUTER02_56, fourMemeTokenManager: FOUR_MEME_TOKEN_MANAGER_56, flapPortal: FLAP_PORTAL_56, wbnb: WBNB_56 };

type ChainState = {
  gasThrows: boolean;
  readThrows: boolean;
  identity: DcaPoolIdentity;
  positions: Map<bigint, DcaPositionRead>;
};

async function fixture(options: { readonly enabled?: boolean; readonly withDca?: boolean; readonly guardVerified?: boolean } = {}) {
  const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, { chainId: 56, keyStoreAddress: KEYSTORE });
  const store = new Proxy(memory, {
    get(target, property, receiver): unknown {
      if (property === "durable" || property === "keyEncryptionConfigured") return true;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentStore;
  const journal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
  const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_SEC * 1_000);
  const positions = new MemoryTradePositionStore(() => NOW_SEC * 1_000);
  const intents = new MemoryTradeIntentStore(() => NOW_SEC * 1_000);
  const reads = { universe: 0 };
  const dataPlane: TradeDataPlaneReads = {
    async universe() { reads.universe += 1; throw new Error("no pin is read for Auto DCA"); },
    async tokensBatch(addresses) {
      return addresses.map((address) => ({ address, symbol: "X", priceUsd: address.toLowerCase() === WBNB_56.toLowerCase() ? 769.4 : 1,
        marketCapUsd: 1, volume24hUsd: 1, holders: 1, priceChange24hPct: 0, asOf: NOW_SEC * 1_000 }));
    },
    async eligibilityBatch() { return []; },
    async security() { return { data: {}, meta: {} }; },
  };
  const readiness: TradeReadiness = { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(), stop() {} };
  const evidence: GrantEvidenceReader = {
    async readFunding(_wallet, relayGasHeadroomWei, observedAtSec) {
      return { version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2,
        relayGasHeadroomWei: relayGasHeadroomWei.toString(10), requiredWei: "7", balanceWei: "1000000000000000000" };
    },
    async readGrant() {
      return { relayKeys: [], accountKey: null, accountSpend: [], canExecute: [], keyStore: { kind: "missing" }, ownerVerdict: "verified" };
    },
  };
  const keyStoreReader: KeyStoreReader = {
    async listKeys() { return []; },
    async publicKeyFor() { return `0x${"22".repeat(64)}` as Hex; },
    async isValidKey() { return false; },
    async finalizedBlock() { throw new Error("finalized unavailable"); },
    async blockAt(blockNumber) { return { number: blockNumber, hash: `0x${"91".repeat(32)}` as Hex }; },
    async listKeysAt() { return []; },
    async publicKeyForAt() { return PUBLIC_KEY; },
    async isValidKeyAt() { return false; },
  };
  const legs = dcaPoolLegs(NV);
  const chainState: ChainState = { gasThrows: false, readThrows: false, positions: new Map(),
    identity: { token0: legs.token0, token1: legs.token1, fee: NV.fee, tickSpacing: NV.tickSpacing } };
  const dcaStore = new MemoryDcaRoundStore();
  const chain = {
    async reading() {
      if (chainState.readThrows) throw new Error("rpc down");
      return { block: 100n, tick: NV_TICK, sqrtPriceX96: getSqrtRatioAtTick(NV_TICK) };
    },
    async position(tokenId: bigint) { return chainState.positions.get(tokenId) ?? "burned" as const; },
    async walletTokenIds() { return [...chainState.positions.keys()]; },
    async tokenBalance() { return 0n; },
    async gasPriceWei() { if (chainState.gasThrows) throw new Error("rpc down"); return 50_000_000n; },
    async poolIdentity() { return chainState.identity; },
  };
  const observeCalls = { count: 0 };
  const harness = await createHarness({ seedAgent: false, agentStore: store, journal, keyStoreReader,
    tradeAgent: {
      settingsStore, positions, intents, dataPlane, readiness, feeBps: 100,
      guardVerified: async () => options.guardVerified ?? true,
      observer: { async observe() { observeCalls.count += 1; return []; } },
      ...(options.withDca === false ? {} : { dca: { enabled: options.enabled ?? true, store: dcaStore, chain } }),
    },
    config: { chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true,
      accountReadSession: { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
        environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }) },
      tradeAgentEnabled: true, executeRawEnabled: false,
      trade: tradeConfig({ venues: VENUES, feeTreasury: TREASURY, aggregatorGuard: GUARD }),
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
    hire: { evidence, nfpm: NFPM_56, routerV3: PANCAKE_V3_ROUTER_56, wbnb: WBNB_56, treasury: TREASURY,
      feeBps: 100, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
  harness.provider.tokenBalances.set(USDT_56.toLowerCase(), 100n * E18);
  return { harness, store, settingsStore, positions, dcaStore, chain, chainState, reads, observeCalls };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function hireParams(settings: TradeSettings = dcaSettings(), capDayWei: bigint = CAP) {
  return { walletAddress: WALLET, capDayWei: capDayWei.toString(10), ttlSec: 604_800, sizingPreset: "trade-v1", executionModel: "tradfi",
    hireRunId: "33333333-3333-4333-8333-333333333333", autoGrant: true, settings };
}

function previewQuery(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({ walletAddress: WALLET, capDayWei: CAP.toString(10), sizingPreset: "trade-v1", executionModel: "tradfi",
    entryWei: (15n * E18).toString(10), maxOpenPositions: "1", settlementAsset: "USDT", minEntryWei: (15n * E18).toString(10),
    capitalQuoteWei: (55n * E18).toString(10), cmcNewsEnabled: "false", tradeMode: "dca", dcaToken: NVDAB, dcaStepBps: "100",
    dcaTakeProfitBps: "150", dcaOrderWei: (10n * E18).toString(10), dcaMaxOrders: "4", ...overrides }).toString();
}

async function preview(f: Fixture, query = previewQuery()) {
  const response = await f.harness.app.request(`/agents/hire/preview?${query}`, { headers: { "x-exec-token": EXEC_TOKEN } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function signed(action: "provisionAgent" | "tradeSettings" | "tradeExit" | "tradeDrain" | "revoke" | "read" | "renewSession", id: string, params: unknown) {
  return signOwnerAction(action, params, { agentId: id, chainId: 56, network: "mainnet" });
}

async function post(harness: Harness, path: string, envelope: SignedEnvelope) {
  return call(harness, path, { method: "POST", body: envelope });
}

function code(response: { readonly body: unknown }): string | undefined {
  return (response.body as { error?: { code?: string } }).error?.code;
}

/** A hired DCA agent: the §9.1 grant (without the guard rule unless asked), its signed settings. */
async function seedDcaAgent(f: Fixture, id: string, options: { readonly expired?: boolean; readonly withGuardRule?: boolean; readonly quotePerTradeWei?: string; readonly settings?: TradeSettings } = {}) {
  const seeded = options.settings ?? dcaSettings();
  const expiresAt = options.expired === true ? NOW_SEC - 1 : NOW_SEC + 604_800;
  const spec = tradeSessionSpec({ venues: VENUES, treasury: TREASURY, ...(options.withGuardRule === true ? { aggregatorGuard: GUARD } : {}),
    tokens: [{ token: NV.stock }], nativeCaps: [{ limit: CAP, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 275n * E18,
    quotePerTradeCapWei: 15_150_000_000_000_000_000n, platformFeeBps: 100, nfpm: NFPM_56,
    expiresAt, nowSeconds: options.expired === true ? NOW_SEC - 3_600 : NOW_SEC });
  await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey",
    status: "armed", httpRuntimeProfile: "trade-v1",
    sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: PUBLIC_KEY, expiry: expiresAt,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", entryWei: seeded.entryWei,
        minEntryWei: seeded.minEntryWei!, quotePerTradeWei: options.quotePerTradeWei ?? "15150000000000000000", capitalQuoteWei: seeded.capitalQuoteWei!,
        cmcNewsEnabled: false } } });
  const settings = seeded;
  await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });
  return { spec, settings };
}

function plan(): DcaBatchPlan {
  return { kind: "level-place", roundNo: 1, readingBlock: 100n, deadlineSec: 1n, exits: [], mints: [], swap: null, feeWei: 0n,
    quoteSpendWei: 0n } as unknown as DcaBatchPlan;
}

/** DCA-DETAIL §3.2: a fake batch plan of the given `kind`/`roundNo`, with an optional sell swap leg (for `remove`). */
function planOf(kind: DcaBatchKind, roundNo: number, sellAmountWei?: bigint): DcaBatchPlan {
  return { kind, roundNo, readingBlock: 100n, deadlineSec: 1n, exits: [], mints: [], feeWei: 0n, quoteSpendWei: 0n,
    swap: sellAmountWei === undefined ? null : { side: "sell", amountInWei: sellAmountWei, minOutWei: 0n, calls: [] } } as unknown as DcaBatchPlan;
}

/** DCA-DETAIL §3.2: commit a `plan.kind` action against `roundNo` at `atMs`, returning its actionKey. */
async function commitAction(f: Fixture, id: string, roundNo: number, expectedRowVersion: number, planValue: DcaBatchPlan, txHash: Hex, atMs: number = NOW_SEC * 1_000) {
  const claimed = await f.dcaStore.claimAction({ agentId: id, ownerAddress: ownerAccount.address, roundNo, expectedRowVersion, plan: planValue, nowMs: atMs });
  if (claimed.kind !== "claimed") throw new Error(`claimAction refused: ${claimed.kind}`);
  await f.dcaStore.setActionState({ ownerAddress: ownerAccount.address, actionKey: claimed.action.actionKey, from: ["intended"], to: "committed", txHash, nowMs: atMs });
  return claimed.action.actionKey;
}

/** As {@link commitAction}, then `finishAction` (state "finished") — the remove-sale rule reads only finished actions. */
async function commitAndFinishAction(f: Fixture, id: string, roundNo: number, expectedRowVersion: number, planValue: DcaBatchPlan, txHash: Hex, atMs: number = NOW_SEC * 1_000) {
  const actionKey = await commitAction(f, id, roundNo, expectedRowVersion, planValue, txHash, atMs);
  await f.dcaStore.finishAction({ ownerAddress: ownerAccount.address, actionKey, plan: planValue, roundWrites: [], roundInserts: [], orders: [], nowMs: atMs });
  return actionKey;
}

describe("AUTO-DCA §13.1 — hire preview", () => {
  it("DCA_ENABLED off, or no DCA composition, refuses 400 dca_disabled", async () => {
    for (const options of [{ enabled: false }, { withDca: false }]) {
      const f = await fixture(options);
      const response = await preview(f);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal((response.body["error"] as { code: string }).code, "dca_disabled");
    }
  });

  it("a stock outside the 17 is dca_token_unsupported; a partial tuple is invalid_request", async () => {
    const f = await fixture();
    const unknown = await preview(f, previewQuery({ dcaToken: "0x9999999999999999999999999999999999999999" }));
    assert.equal(unknown.status, 400);
    assert.equal((unknown.body["error"] as { code: string }).code, "dca_token_unsupported");
    const partial = new URLSearchParams(previewQuery());
    partial.delete("dcaMaxOrders");
    const missing = await preview(f, partial.toString());
    assert.equal(missing.status, 400);
    assert.equal((missing.body["error"] as { code: string }).code, "invalid_request");
  });

  it("sizes the one-stock grant, reads no pin, and returns the R2.16 economics to the cent (NVDAB, TP 1.5 %, 0.05 gwei)", async () => {
    const f = await fixture();
    const response = await preview(f);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(f.reads.universe, 0, "an Auto DCA preview reads no pin");
    const data = response.body["data"] as { sizing: Record<string, unknown>; pin: readonly { address: string }[]; funding: Record<string, string> };
    const sizing = data.sizing;
    assert.deepEqual(data.pin.map((row) => row.address), [NV.stock]);
    assert.equal(sizing["tradeMode"], "dca");
    assert.equal(sizing["ok"], true);
    assert.equal(sizing["grantedTokenCount"], 1);
    assert.equal(sizing["nativeReserveWei"], "3840000000000000");
    assert.equal(sizing["nativeShortfallWei"], "0");
    assert.equal(sizing["depositQuoteWei"], (55n * E18).toString(10));
    assert.equal(data.funding["quoteRequiredWei"], "55000000000000000000", "the USDT target is the principal alone: Auto DCA charges no platform fee");
    assert.equal(sizing["usdtDayCapWei"], (275n * E18).toString(10));
    // R3.8: a no-fill round spends B + a·D of the USDT cap (275 / 35 = 7).
    assert.deepEqual(sizing["roundsPerDayAtCap"], { noFill: 7, full: 5 });
    const economics = sizing["economics"] as { r0CostUsdtWei: string; r0GrossUsdtWei: string; holdEngagesAtGwei: number; perFillNetUsdtWei: string; gasPriceGwei: number };
    assert.equal(economics.gasPriceGwei, 0.05);
    // R3.8 at calibration R1: NVDAB, TP 1.5 %, N = 4 (a = 2): R0 cost 0.2231, gross 0.3013, engages at 0.0675, per fill +0.076.
    assert.equal((Number(economics.r0CostUsdtWei) / 1e18).toFixed(4), "0.2231");
    assert.equal((Number(economics.r0GrossUsdtWei) / 1e18).toFixed(4), "0.3013");
    assert.equal(economics.holdEngagesAtGwei.toFixed(4), "0.0675");
    assert.equal((Number(economics.perFillNetUsdtWei) / 1e18).toFixed(3), "0.076");
  });

  it("a native cap below dcaNativeReserveWei(N) reports the BNB shortfall, and unreadable gas leaves economics null, not an error", async () => {
    const f = await fixture();
    f.chainState.gasThrows = true;
    const response = await preview(f, previewQuery({ capDayWei: (CAP - 1n).toString(10) }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const sizing = (response.body["data"] as { sizing: Record<string, unknown> }).sizing;
    assert.equal(sizing["ok"], false);
    assert.equal(sizing["nativeShortfallWei"], "1");
    assert.equal(sizing["economics"], null);
  });
});

describe("AUTO-DCA §13.2 — provision", () => {
  it("DCA_ENABLED off refuses 400 dca_disabled before any write", async () => {
    const f = await fixture({ enabled: false });
    const response = await post(f.harness, "/agents/dca-off/session", await signed("provisionAgent", "dca-off", hireParams()));
    assert.equal(response.status, 400, response.text);
    assert.equal(code(response), "dca_disabled");
    assert.equal(await f.store.getAgentById("dca-off"), null);
  });

  it("an invalid tuple is refused by the parser before any write", async () => {
    const f = await fixture();
    const response = await post(f.harness, "/agents/dca-bad/session",
      await signed("provisionAgent", "dca-bad", hireParams(dcaSettings({ dcaStepBps: 1_677 }))));
    assert.equal(response.status, 400, response.text);
    assert.equal(code(response), "invalid_request");
    assert.match((response.body as { error: { message: string } }).error.message, /With 4 DCA orders the price drop step can be at most 16\.76 %/u);
    assert.equal(await f.store.getAgentById("dca-bad"), null);
  });

  it("a pool whose finalized identity differs is dca_pool_mismatch, before any write", async () => {
    const f = await fixture();
    f.chainState.identity = { ...f.chainState.identity, fee: 100 };
    const response = await post(f.harness, "/agents/dca-pool/session", await signed("provisionAgent", "dca-pool", hireParams()));
    assert.equal(response.status, 400, response.text);
    assert.equal(code(response), "dca_pool_mismatch");
    assert.equal(await f.store.getAgentById("dca-pool"), null);
  });

  it("the route's capDayWei ≥ dcaNativeReserveWei(N) check is authoritative (one wei short refuses, naming BNB)", async () => {
    const f = await fixture();
    const response = await post(f.harness, "/agents/dca-cap/session", await signed("provisionAgent", "dca-cap", hireParams(dcaSettings(), CAP - 1n)));
    assert.equal(response.status, 400, response.text);
    assert.equal(code(response), "capital_too_small");
    assert.match((response.body as { error: { message: string } }).error.message, /BNB day cap of at least 0\.00384 BNB/u);
    assert.equal(await f.store.getAgentById("dca-cap"), null);
  });

  it("grants exactly USDT + the stock + three NFPM rules (14 rules / 3 caps, no fee transfer) with the v2 trade-v1 pending sizing", async () => {
    const f = await fixture();
    const id = "dca-happy";
    const response = await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, hireParams()));
    assert.equal(response.status, 200, response.text);
    assert.equal(f.reads.universe, 0, "an Auto DCA hire reads no pin");
    const pending = (await f.store.getAgentById(id))?.pendingGrant;
    assert.ok(pending);
    assert.deepEqual(pending.sessionSpec.allowedCalls, [
      { to: PANCAKE_V2_ROUTER_56 },
      { to: PANCAKE_V3_ROUTER_56 },
      { to: UNISWAP_V3_ROUTER02_56, selector: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" },
      { to: UNISWAP_V3_ROUTER02_56, selector: "exactInput((bytes,address,uint256,uint256))" },
      { to: UNISWAP_V3_ROUTER02_56, selector: "unwrapWETH9(uint256,address)" },
      { to: UNISWAP_V3_ROUTER02_56, selector: "refundETH()" },
      { to: FOUR_MEME_TOKEN_MANAGER_56 },
      { to: FLAP_PORTAL_56 },
      { to: GUARD, selector: TRADFI_GUARD_SWAP_SELECTOR },
      { to: NV.stock, selector: APPROVE_SELECTOR },
      { to: USDT_56, selector: APPROVE_SELECTOR },
      { to: NFPM_56, selector: "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" },
      { to: NFPM_56, selector: "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" },
      { to: NFPM_56, selector: "collect((uint256,address,uint128,uint128))" },
    ]);
    assert.equal(pending.sessionSpec.spendCaps.length, 3);
    assert.deepEqual(pending.sessionSpec.spendCaps[0], { limit: CAP, period: "day" });
    assert.deepEqual(pending.sessionSpec.spendCaps.slice(1).map((cap) => cap.token?.toLowerCase()).sort(),
      [NV.stock.toLowerCase(), USDT_56.toLowerCase()].sort());
    assert.equal(pending.sizing.sizingPreset, "trade-v1");
    assert.equal(pending.sizing.entryWei, (15n * E18).toString(10));
    assert.equal(pending.sizing.minEntryWei, (15n * E18).toString(10));
    assert.equal(pending.sizing.quotePerTradeWei, "15000000000000000000");
    assert.equal(pending.funding.quoteRequiredWei, "55000000000000000000");
  });
});

describe("AUTO-DCA owner routes", () => {
  it("renewal renews the spec verbatim with the guard rule appended once when missing and verified, and reads no pin", async () => {
    const f = await fixture();
    const id = "dca-renew";
    const { spec } = await seedDcaAgent(f, id, { expired: true });
    const response = await post(f.harness, `/agents/${id}/session/renew`, await signed("renewSession", id, { ttlSec: 3_600 }));
    assert.equal(response.status, 200, response.text);
    assert.equal(f.reads.universe, 0, "the DCA renewal never reaches the pin or its `< 5` refusal");
    const renewed = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal?.sessionSpec;
    assert.ok(renewed);
    assert.deepEqual(renewed.allowedCalls, [...spec.allowedCalls, { to: GUARD, selector: TRADFI_GUARD_SWAP_SELECTOR }]);
    assert.deepEqual(renewed.spendCaps, spec.spendCaps);
    assert.equal(renewed.expiresAt, NOW_SEC + 3_600);

    const g = await fixture();
    const { spec: guarded } = await seedDcaAgent(g, id, { expired: true, withGuardRule: true });
    const again = await post(g.harness, `/agents/${id}/session/renew`, await signed("renewSession", id, { ttlSec: 3_600 }));
    assert.equal(again.status, 200, again.text);
    assert.deepEqual((await g.store.getAgent(ownerAccount.address, id))?.pendingRenewal?.sessionSpec.allowedCalls, guarded.allowedCalls);
  });

  it("settings edit: slippage and stop loss change (D16), the take profit is refused by the immutability branch", async () => {
    const f = await fixture();
    const id = "dca-edit";
    const { settings } = await seedDcaAgent(f, id);
    const editable = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, { ...settings, slippageBps: 150, dcaStopLossBps: 1_500 }));
    assert.equal(editable.status, 200, editable.text);
    const locked = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, { ...settings, slippageBps: 150, dcaStopLossBps: 1_500, dcaTakeProfitBps: 200 }));
    assert.equal(locked.status, 400, locked.text);
    assert.match((locked.body as { error: { message: string } }).error.message, /dcaTakeProfitBps cannot be changed after deploy/u);
  });

  it("settings edit at FEE_BPS 100 with the real DCA hire sizing (ceiling = entry, fee 0) is accepted", async () => {
    // The hire signs quotePerTradeWei = entryWei (DCA fee 0); the ceiling check must use the DCA fee, not the global 1 %.
    const f = await fixture();
    const id = "dca-edit-real-sizing";
    const { settings } = await seedDcaAgent(f, id, { quotePerTradeWei: (15n * E18).toString(10) });
    const editable = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, { ...settings, slippageBps: 150, dcaStopLossBps: 1_500 }));
    assert.equal(editable.status, 200, editable.text);
  });

  it("settings edit at FEE_BPS 100: the capital check also uses the DCA fee (entry 1500, one 10 USDT order, capital 1510)", async () => {
    // DCA capital must equal entry + N x order; a 1 % global fee would ask for 1515 and refuse a slippage edit.
    const f = await fixture();
    const id = "dca-edit-large-entry";
    const big = dcaSettings({ entryWei: (1_500n * E18).toString(10), minEntryWei: (1_500n * E18).toString(10), dcaMaxOrders: 1,
      capitalQuoteWei: (1_510n * E18).toString(10) });
    const { settings } = await seedDcaAgent(f, id, { settings: big, quotePerTradeWei: (1_500n * E18).toString(10) });
    const editable = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, { ...settings, slippageBps: 150 }));
    assert.equal(editable.status, 200, editable.text);
  });

  it("settings edit: a signed per-entry ceiling below the entry is still refused (the check is pinned)", async () => {
    const f = await fixture();
    const id = "dca-edit-ceiling";
    const { settings } = await seedDcaAgent(f, id, { quotePerTradeWei: (15n * E18 - 1n).toString(10) });
    const refused = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, { ...settings, slippageBps: 150 }));
    assert.equal(refused.status, 400, refused.text);
    assert.match((refused.body as { error: { message: string } }).error.message, /per-entry ceiling is immutable/u);
  });

  it("drain is accepted; a per-position exit is 409 dca_no_manual_sell", async () => {
    const f = await fixture();
    const id = "dca-drain";
    await seedDcaAgent(f, id);
    const exit = await post(f.harness, `/agents/${id}/trade/positions/p-1/exit`, await signed("tradeExit", id, { positionId: "p-1" }));
    assert.equal(exit.status, 409, exit.text);
    assert.equal(code(exit), "dca_no_manual_sell");
    const drain = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
    assert.equal(drain.status, 200, drain.text);
  });

  it("revoke is refused while a batch is intended or the chain shows liquidity, and admitted past an unknown action once the chain is empty", async () => {
    const f = await fixture();
    const id = "dca-revoke";
    await seedDcaAgent(f, id);
    await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, phase: "active", p0UsdtWei: 15n * E18,
      p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n, carriedStockWei: 0n, carriedCostWei: 0n,
      slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    const claimed = await f.dcaStore.claimAction({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, expectedRowVersion: 1, plan: plan(), nowMs: NOW_SEC * 1_000 });
    assert.equal(claimed.kind, "claimed");
    const drain = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
    assert.equal(drain.status, 200, drain.text);

    const inFlight = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(inFlight.status, 409, inFlight.text);
    assert.match((inFlight.body as { error: { message: string } }).error.message, /still being submitted/u);

    if (claimed.kind !== "claimed") return;
    await f.dcaStore.setActionState({ ownerAddress: ownerAccount.address, actionKey: claimed.action.actionKey, from: ["intended"], to: "unknown", nowMs: NOW_SEC * 1_000 });
    const legs = dcaPoolLegs(NV);
    f.chainState.positions.set(7n, { liquidity: 5n, tickLower: 54_400, tickUpper: 54_450, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    const live = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(live.status, 409, live.text);
    assert.match((live.body as { error: { message: string } }).error.message, /still hold funds on chain/u);

    f.chainState.readThrows = true;
    const unreadable = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(unreadable.status, 409, unreadable.text);

    f.chainState.readThrows = false;
    f.chainState.positions.set(7n, { liquidity: 0n, tickLower: 54_400, tickUpper: 54_450, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    const admitted = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(admitted.status, 200, admitted.text);
  });

  it("H-2: a transport failure under position() refuses revoke (409); the live order is never read as burned", async (t) => {
    const f = await fixture();
    const id = "dca-revoke-rpc";
    await seedDcaAgent(f, id);
    const drain = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
    assert.equal(drain.status, 200, drain.text);
    const legs = dcaPoolLegs(NV);
    f.chainState.positions.set(7n, { liquidity: 5n, tickLower: 54_400, tickUpper: 54_450, token0: legs.token0, token1: legs.token1, fee: NV.fee });
    Object.assign(f.chain, { position: createDcaChainReads({ rpcUrls: [await dcaRpcEndpoint(t)], nfpm: NFPM_56 }).position });
    const refused = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(refused.status, 409, refused.text);
    assert.match((refused.body as { error: { message: string } }).error.message, /could not be read on chain/u);
  });

  it("the view carries the DCA block, never calls the position observer, and dashes equity with a reason when the chain is unreadable", async () => {
    const f = await fixture();
    const id = "dca-view";
    await seedDcaAgent(f, id);
    await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, phase: "active", p0UsdtWei: 15n * E18,
      p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15_150_000_000_000_000_000n, stockAcquiredWei: 67n * 10n ** 15n, carriedStockWei: 0n, carriedCostWei: 0n,
      slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    const base = { agentId: id, roundNo: 1, tickLower: 0, tickUpper: 50, tokenId: null, liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n,
      collectedUsdtWei: 0n, collectedStockWei: 0n, crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null,
      exitedByAction: null, lastSeenLiveBlock: null, closedBy: null, updatedAtMs: NOW_SEC * 1_000 } as const;
    await f.dcaStore.putOrder({ ...base, orderKey: "r1:l1", role: "level", levelNo: 1, state: "exited", collectedStockWei: 45n * 10n ** 15n, closedBy: "owner" });
    await f.dcaStore.putOrder({ ...base, orderKey: "r1:l2", role: "level", levelNo: 2, state: "skipped" });
    await f.dcaStore.putOrder({ ...base, orderKey: "r1:tp", role: "tp", levelNo: null, state: "live", tokenId: 9n, liquidity: 1n, tickLower: 54_400, tickUpper: 54_450 });
    const read = { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } };
    const ok = await call(f.harness, `/agents/${id}/trade/view`, read);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(f.observeCalls.count, 0, "a DCA view must not call the per-position observer");
    const dca = (ok.body as { data: { dca?: Record<string, unknown> } }).data.dca;
    assert.ok(dca);
    assert.equal(dca["symbol"], "NVDAB");
    const round = dca["round"] as { roundNo: number; phase: string; levels: readonly { levelNo: number; state: string; closedBy: string | null }[]; tp: { state: string; tokenId: string } };
    assert.equal(round.roundNo, 1);
    assert.deepEqual(round.levels.map((level) => [level.levelNo, level.state, level.closedBy]), [[1, "filled", "owner"], [2, "skipped", null]]);
    assert.equal(round.tp.state, "resting");
    assert.equal(round.tp.tokenId, "9");
    assert.ok(dca["equity"] !== null, "an active round reads its equity");
    assert.deepEqual(dca["wallet"], { usdtWei: "0", stockWei: "0" });
    assert.ok(dca["mark"] !== null, "mark is set whenever the reading succeeds, unlike equity.markE8");

    f.chainState.readThrows = true;
    const dashed = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(dashed.status, 200, dashed.text);
    const dashedDca = (dashed.body as { data: { dca: Record<string, unknown> } }).data.dca;
    assert.equal(dashedDca["equity"], null);
    assert.equal(dashedDca["wallet"], null);
    assert.equal(dashedDca["mark"], null);
    assert.equal(dashedDca["reason"], "chain-unreadable");
  });

  it("16. an R3 round prices its levels from the landed start's ladder anchor (never a rolled-back attempt's); a legacy round from p0", async () => {
    const f = await fixture();
    const id = "dca-anchor";
    await seedDcaAgent(f, id);
    const p0 = { num: 15n * E18, den: 68n * 10n ** 15n };
    await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, phase: "active", p0UsdtWei: p0.num, p0StockWei: p0.den,
      costUsdtWei: 15n * E18, stockAcquiredWei: p0.den, carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    await f.dcaStore.putOrder({ agentId: id, roundNo: 1, orderKey: "r1:l1", role: "level", levelNo: 1, tickLower: 53_900, tickUpper: 53_950, tokenId: null,
      state: "pending", liquidity: 0n, mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n, crossCount: 0, crossLastBlock: null,
      crossLastAtMs: null, createdByAction: null, exitedByAction: null, lastSeenLiveBlock: null, closedBy: null, updatedAtMs: NOW_SEC * 1_000 });
    const levelPrice = async (): Promise<string> => {
      const view = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(view.status, 200, view.text);
      return ((view.body as { data: { dca: { round: { levels: readonly { levelPriceE8: string }[] } } } }).data.dca.round.levels[0]!).levelPriceE8;
    };
    const e8 = (price: { readonly num: bigint; readonly den: bigint }) => {
      const level = dcaLevelPrice(price, 1, 100);
      return ((level.num * 100_000_000n) / level.den).toString(10);
    };
    assert.equal(await levelPrice(), e8(p0), "a round started before R3: p0");
    const a1 = { num: 224n * E18, den: E18 }, a2 = { num: 223n * E18, den: E18 };
    const version = async () => (await f.dcaStore.getOpenRound(ownerAccount.address, id))!.rowVersion;
    const attempt1 = await f.dcaStore.claimAction({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, expectedRowVersion: await version(),
      plan: { ...planOf("start", 1), ladderAnchor: a1 }, nowMs: NOW_SEC * 1_000 + 1 });
    assert.ok(attempt1.kind === "claimed");
    await f.dcaStore.setActionState({ ownerAddress: ownerAccount.address, actionKey: attempt1.action.actionKey, from: ["intended"], to: "rolled-back", note: "FAILED", nowMs: NOW_SEC * 1_000 + 1 });
    await commitAction(f, id, 1, await version(), { ...planOf("start", 1), ladderAnchor: a2 }, `0x${"a7".repeat(32)}` as Hex, NOW_SEC * 1_000 + 2);
    assert.equal(await levelPrice(), e8(a2), "review C4 / I13: the landed attempt's anchor");
  });

  it("DCA-DETAIL §3.2(c): mark is present even with no active round, and rounds.history is capped at 12", async () => {
    const f = await fixture();
    const id = "dca-no-round";
    await seedDcaAgent(f, id);
    const read = { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } };
    const noRound = await call(f.harness, `/agents/${id}/trade/view`, read);
    assert.equal(noRound.status, 200, noRound.text);
    const noRoundDca = (noRound.body as { data: { dca: Record<string, unknown> } }).data.dca;
    assert.equal(noRoundDca["round"], null);
    assert.equal(noRoundDca["reason"], "no-active-round");
    assert.ok(noRoundDca["mark"] !== null, "mark does not require an active round");

    // 13 settled rounds plus one open: the history caps at 12, newest first.
    for (let roundNo = 1; roundNo <= 13; roundNo += 1) {
      const inserted = await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo, phase: "active",
        p0UsdtWei: null, p0StockWei: null, costUsdtWei: 0n, stockAcquiredWei: 0n, carriedStockWei: 0n, carriedCostWei: 0n,
        slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
      assert.ok(inserted, `round ${roundNo}`);
      assert.ok(await f.dcaStore.writeRound({ ...inserted!, phase: "settled", settledAtMs: NOW_SEC * 1_000 + roundNo, realizedPnlWei: 0n }));
    }
    const capped = await call(f.harness, `/agents/${id}/trade/view`, read);
    assert.equal(capped.status, 200, capped.text);
    const cappedDca = (capped.body as { data: { dca: { rounds: { history: readonly { roundNo: number }[] } } } }).data.dca;
    assert.equal(cappedDca.rounds.history.length, 12);
    assert.deepEqual(cappedDca.rounds.history.map((row) => row.roundNo), Array.from({ length: 12 }, (_, i) => 13 - i));
  });

  it("DCA-DETAIL §3/§5: mark, edgePriceE8 (a, c), round.base (d), rounds.history + fills (e), actions (f), a throwing listOrders (g)", async () => {
    const f = await fixture();
    const id = "dca-detail";
    await seedDcaAgent(f, id);

    // Round 1 (settled): started by a plain "start" action, closed at take profit;
    // one filled level, one exited TP, and a base fill — every §3.2 fill kind but remove-sale.
    const round1Insert = await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    assert.ok(round1Insert);
    let atMs = NOW_SEC * 1_000;
    const startTx = "0x1111111111111111111111111111111111111111111111111111111111a1" as Hex;
    await commitAction(f, id, 1, round1Insert!.rowVersion, planOf("start", 1), startTx, atMs += 1_000);
    const orderBase = { agentId: id, roundNo: 1, tickLower: 0, tickUpper: 0, tokenId: null, liquidity: 0n,
      crossCount: 0, crossLastBlock: null, crossLastAtMs: null, createdByAction: null, lastSeenLiveBlock: null, closedBy: null, updatedAtMs: NOW_SEC * 1_000 } as const;
    const levelExitTx = "0x2222222222222222222222222222222222222222222222222222222222a2" as Hex;
    const levelExitAction = await commitAction(f, id, 1, (await f.dcaStore.getOpenRound(ownerAccount.address, id))!.rowVersion, planOf("fill", 1), levelExitTx, atMs += 1_000);
    // A rounding case: collected 1 USDT more than minted, so the level fill's `usdtWei` clamps at 0 (§3.2).
    await f.dcaStore.putOrder({ ...orderBase, orderKey: "r1:l1", role: "level", levelNo: 1, tickLower: 54_000, tickUpper: 54_050, tokenId: 11n,
      state: "exited", mintedUsdtWei: 10n * E18, mintedStockWei: 0n, collectedUsdtWei: 11n * E18, collectedStockWei: 45n * 10n ** 15n, exitedByAction: levelExitAction });
    const tpExitTx = "0x3333333333333333333333333333333333333333333333333333333333a3" as Hex;
    const tpExitAction = await commitAction(f, id, 1, (await f.dcaStore.getOpenRound(ownerAccount.address, id))!.rowVersion, planOf("close", 1), tpExitTx, atMs += 1_000);
    // Likewise: collected more stock than minted, so the TP fill's `stockWei` clamps at 0.
    await f.dcaStore.putOrder({ ...orderBase, orderKey: "r1:tp", role: "tp", levelNo: null, tickLower: 54_400, tickUpper: 54_450, tokenId: 9n,
      state: "exited", mintedUsdtWei: 0n, mintedStockWei: 1n, collectedUsdtWei: 26n * E18, collectedStockWei: 112n * 10n ** 15n, exitedByAction: tpExitAction });
    const round1Settled = { ...(await f.dcaStore.getOpenRound(ownerAccount.address, id))!, phase: "settled" as const, realizedPnlWei: 310_000_000_000_000_000n,
      settledAtMs: NOW_SEC * 1_000, unreliable: false };
    assert.ok(await f.dcaStore.writeRound(round1Settled));

    // Round 2 (open, active): started by the close-start that closed round 1 (roundNo N-1 = 1).
    const closeStartTx = "0x4444444444444444444444444444444444444444444444444444444444a4" as Hex;
    const round1AfterClose = (await f.dcaStore.listRounds(ownerAccount.address, id)).find((row) => row.roundNo === 1)!;
    await commitAction(f, id, 1, round1AfterClose.rowVersion, planOf("close-start", 1), closeStartTx, atMs += 1_000);
    const round2 = await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 2, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 68n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 68n * 10n ** 15n,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    assert.ok(round2);
    // A pending level (never minted) and a resting level + TP, to exercise §5's edgePriceE8 rule.
    await f.dcaStore.putOrder({ ...orderBase, roundNo: 2, orderKey: "r2:l1", role: "level", levelNo: 1, tickLower: 54_000, tickUpper: 54_050, tokenId: 21n,
      state: "live", mintedUsdtWei: 10n * E18, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n, exitedByAction: null });
    await f.dcaStore.putOrder({ ...orderBase, roundNo: 2, orderKey: "r2:l2", role: "level", levelNo: 2, tickLower: 53_600, tickUpper: 53_650, tokenId: null,
      state: "pending", mintedUsdtWei: 0n, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n, exitedByAction: null });
    await f.dcaStore.putOrder({ ...orderBase, roundNo: 2, orderKey: "r2:tp", role: "tp", levelNo: null, tickLower: 54_400, tickUpper: 54_450, tokenId: 19n,
      state: "live", mintedUsdtWei: 0n, mintedStockWei: 112n * 10n ** 15n, collectedUsdtWei: 0n, collectedStockWei: 0n, exitedByAction: null });
    // A remove-sale on round 2 (two finished batches, so the fill sums their swap legs).
    const removeTx = "0x5555555555555555555555555555555555555555555555555555555555a5" as Hex;
    const round2AfterMints = (await f.dcaStore.getOpenRound(ownerAccount.address, id))!;
    await commitAndFinishAction(f, id, 2, round2AfterMints.rowVersion, planOf("remove", 2, 30n * E18), "0x6666666666666666666666666666666666666666666666666666666666a6" as Hex, atMs += 1_000);
    const round2AfterRemove1 = (await f.dcaStore.getOpenRound(ownerAccount.address, id))!;
    await commitAndFinishAction(f, id, 2, round2AfterRemove1.rowVersion, planOf("remove", 2, 20n * E18), removeTx, atMs += 1_000);
    const round2WithSale = { ...(await f.dcaStore.getOpenRound(ownerAccount.address, id))!, saleProceedsWei: 49_500_000_000_000_000_000n };
    assert.ok(await f.dcaStore.writeRound(round2WithSale));

    const read = { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } };
    const response = await call(f.harness, `/agents/${id}/trade/view`, read);
    assert.equal(response.status, 200, response.text);
    const dca = (response.body as { data: { dca: Record<string, unknown> } }).data.dca;

    // (c) mark is present with an active round.
    const mark = dca["mark"] as { e8: string; block: string } | null;
    assert.ok(mark !== null);

    // (a) edgePriceE8: a resting TP/level show their tick-edge price; a pending level is null.
    const round = dca["round"] as { levels: readonly { levelNo: number; edgePriceE8: string | null }[]; tp: { edgePriceE8: string | null };
      base: { usdtWei: string; stockWei: string; txHash: string | null; atMs: number | null } | null };
    const e8Price = (price: { readonly num: bigint; readonly den: bigint }): string => ((price.num * 100_000_000n) / price.den).toString(10);
    // Worked example (§5): stock = token0, price rises with tick, so the TP's edge is its
    // HIGHER tick and the level's is its LOWER — both measured directly, not hardcoded.
    assert.equal(round.tp.edgePriceE8, e8Price(dcaPriceAtTick(NV, 54_450)));
    assert.equal(round.levels.find((l) => l.levelNo === 1)!.edgePriceE8, e8Price(dcaPriceAtTick(NV, 54_000)));
    assert.equal(round.levels.find((l) => l.levelNo === 2)!.edgePriceE8, null);

    // (d) round.base resolves for round 2 via its close-start action (roundNo 1 = N-1).
    assert.ok(round.base);
    assert.equal(round.base!.txHash, closeStartTx);

    // (e) rounds.history: newest-first (only round 1 settled), filledLevels from the exited-with-stock rule.
    const roundsBlock = dca["rounds"] as { history: readonly { roundNo: number; filledLevels: number; realizedPnlWei: string | null }[] };
    assert.deepEqual(roundsBlock.history.map((row) => row.roundNo), [1]);
    assert.equal(roundsBlock.history[0]!.filledLevels, 1);
    assert.equal(roundsBlock.history[0]!.realizedPnlWei, "310000000000000000");

    // (e) fills: base (round1), level (clamped usdt), take-profit (clamped stock), and remove-sale (summed).
    const fills = (dca["history"] as { fills: readonly { kind: string; roundNo: number; usdtWei: string; stockWei: string; txHash: string | null }[] }).fills;
    const byKind = (kind: string, roundNo: number) => fills.find((row) => row.kind === kind && row.roundNo === roundNo);
    assert.equal(byKind("base", 1)!.txHash, startTx);
    assert.equal(byKind("base", 1)!.usdtWei, (15n * E18).toString(10));
    const level = byKind("level", 1)!;
    assert.equal(level.usdtWei, "0", "clamp: collected 1 USDT more than minted, floors at 0 instead of going negative");
    assert.equal(level.stockWei, (45n * 10n ** 15n).toString(10));
    assert.equal(level.txHash, levelExitTx);
    const tpFill = byKind("take-profit", 1)!;
    assert.equal(tpFill.stockWei, "0", "clamp: collected more stock than minted, floors at 0 instead of going negative");
    assert.equal(tpFill.usdtWei, (26n * E18).toString(10));
    assert.equal(tpFill.txHash, tpExitTx);
    const removeSale = byKind("remove-sale", 2)!;
    assert.equal(removeSale.stockWei, (50n * E18).toString(10), "sums both remove batches' swap legs");
    assert.equal(removeSale.usdtWei, "49500000000000000000");
    assert.equal(removeSale.txHash, removeTx, "the newest remove batch's tx");

    // (f) actions: newest first, tx-only.
    const actionsView = dca["actions"] as readonly { kind: string; txHash: string }[];
    assert.ok(actionsView.length >= 5);
    assert.equal(actionsView[0]!.txHash, removeTx, "newest first");
    assert.ok(actionsView.every((row) => typeof row.txHash === "string" && row.txHash.length > 0));

    // (g) a throwing listOrders leaves the view 200 with the history arrays empty.
    const originalListOrders = f.dcaStore.listOrders.bind(f.dcaStore);
    f.dcaStore.listOrders = (async (agentId: string, roundNo: number) => {
      if (roundNo === 1) throw new Error("store down");
      return originalListOrders(agentId, roundNo);
    }) as typeof f.dcaStore.listOrders;
    try {
      const broken = await call(f.harness, `/agents/${id}/trade/view`, read);
      assert.equal(broken.status, 200, broken.text);
      const brokenDca = (broken.body as { data: { dca: Record<string, unknown> } }).data.dca;
      assert.deepEqual((brokenDca["rounds"] as { history: readonly unknown[] }).history, []);
      assert.deepEqual((brokenDca["history"] as { fills: readonly unknown[] }).fills.filter((row) => (row as { roundNo: number }).roundNo === 1), []);
    } finally { f.dcaStore.listOrders = originalListOrders; }
  });

  it("AUTO-DCA R4.6: a removed round's history row carries unsoldStockWei and markedPnlWei; rounds.markedPnlWei sums marked-or-realized; unreliable ⇒ markedPnlWei null", async () => {
    const f = await fixture();
    const id = "dca-removed-view";
    await seedDcaAgent(f, id);
    const insertedReliable = await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    assert.ok(insertedReliable);
    assert.ok(await f.dcaStore.writeRound({ ...insertedReliable!, phase: "settled", closeCause: "removed", realizedPnlWei: 5n * E18,
      unsoldStockWei: 3n * 10n ** 15n, unsoldCostWei: 1n * E18, unsoldValueWei: 2n * E18, settledAtMs: NOW_SEC * 1_000, unreliable: false }));
    const insertedUnreliable = await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 2, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    assert.ok(insertedUnreliable);
    assert.ok(await f.dcaStore.writeRound({ ...insertedUnreliable!, phase: "settled", closeCause: "removed", realizedPnlWei: 5n * E18,
      unsoldStockWei: 3n * 10n ** 15n, unsoldCostWei: 1n * E18, unsoldValueWei: 2n * E18, settledAtMs: NOW_SEC * 1_000, unreliable: true }));

    const read = { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } };
    const response = await call(f.harness, `/agents/${id}/trade/view`, read);
    assert.equal(response.status, 200, response.text);
    const dca = (response.body as { data: { dca: Record<string, unknown> } }).data.dca;
    const roundsBlock = dca["rounds"] as { markedPnlWei: string;
      history: readonly { roundNo: number; realizedPnlWei: string | null; unsoldStockWei: string | null; markedPnlWei: string | null; unreliable: boolean }[] };
    const reliableRow = roundsBlock.history.find((row) => row.roundNo === 1)!;
    assert.equal(reliableRow.realizedPnlWei, (5n * E18).toString(10));
    assert.equal(reliableRow.unsoldStockWei, (3n * 10n ** 15n).toString(10));
    assert.equal(reliableRow.markedPnlWei, (5n * E18 + 2n * E18 - 1n * E18).toString(10), "realized + unsoldValue − unsoldCost");
    const unreliableRow = roundsBlock.history.find((row) => row.roundNo === 2)!;
    assert.equal(unreliableRow.markedPnlWei, null, "an unreliable removed round has no marked figure");
    // rounds.markedPnlWei sums marked-or-realized over EVERY settled round: reliable's marked figure, unreliable's realized (its marked is null).
    assert.equal(roundsBlock.markedPnlWei, (6n * E18 + 5n * E18).toString(10));
  });

  it("DCA-DETAIL §5(b): edgePriceE8 in the usdtIsToken0 orientation — TP shows the lower tick, the level shows the upper", async () => {
    const f = await fixture();
    const id = "dca-detail-orient";
    const spcxb = dcaPoolForToken("0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1")!;
    assert.equal(spcxb.usdtIsToken0, true);
    const spec = tradeSessionSpec({ venues: VENUES, treasury: TREASURY, tokens: [{ token: spcxb.stock }], nativeCaps: [{ limit: CAP, period: "day" }],
      quoteToken: USDT_56, quoteDailyCapWei: 275n * E18, quotePerTradeCapWei: 15_150_000_000_000_000_000n, platformFeeBps: 100, nfpm: NFPM_56,
      expiresAt: NOW_SEC + 604_800, nowSeconds: NOW_SEC });
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey",
      status: "armed", httpRuntimeProfile: "trade-v1",
      sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: PUBLIC_KEY, expiry: NOW_SEC + 604_800,
        hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT", entryWei: (15n * E18).toString(10),
          minEntryWei: (15n * E18).toString(10), quotePerTradeWei: "15150000000000000000", capitalQuoteWei: (55n * E18).toString(10),
          cmcNewsEnabled: false } } });
    const settings = dcaSettings({ dcaToken: spcxb.stock.toLowerCase() });
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });
    const round = await f.dcaStore.insertRound({ agentId: id, ownerAddress: ownerAccount.address, roundNo: 1, phase: "active",
      p0UsdtWei: 15n * E18, p0StockWei: 67n * 10n ** 15n, costUsdtWei: 15n * E18, stockAcquiredWei: 67n * 10n ** 15n,
      carriedStockWei: 0n, carriedCostWei: 0n, slBaselineWei: 55n * E18, nowMs: NOW_SEC * 1_000 });
    assert.ok(round);
    const orderBase = { agentId: id, roundNo: 1, liquidity: 1n, crossCount: 0, crossLastBlock: null, crossLastAtMs: null,
      createdByAction: null, exitedByAction: null, lastSeenLiveBlock: null, closedBy: null, updatedAtMs: NOW_SEC * 1_000 } as const;
    // Both orders share one tick range: the TABLE's own rule (§5) is what is under test,
    // not which range a real TP/level would sit at.
    await f.dcaStore.putOrder({ ...orderBase, orderKey: "r1:tp", role: "tp", levelNo: null, tickLower: 54_400, tickUpper: 54_450, state: "live", tokenId: 9n,
      mintedUsdtWei: 0n, mintedStockWei: 1n, collectedUsdtWei: 0n, collectedStockWei: 0n });
    await f.dcaStore.putOrder({ ...orderBase, orderKey: "r1:l1", role: "level", levelNo: 1, tickLower: 54_400, tickUpper: 54_450, state: "live", tokenId: 11n,
      mintedUsdtWei: 1n, mintedStockWei: 0n, collectedUsdtWei: 0n, collectedStockWei: 0n });
    const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(response.status, 200, response.text);
    const dcaRound = (response.body as { data: { dca: { round: { tp: { edgePriceE8: string }; levels: readonly { levelNo: number; edgePriceE8: string }[] } } } }).data.dca.round;
    const e8Price = (price: { readonly num: bigint; readonly den: bigint }): string => ((price.num * 100_000_000n) / price.den).toString(10);
    // usdtIsToken0=true: price FALLS with tick, so the TP (wants the higher USDT price) shows
    // tickLower and the level (wants the lower USDT price) shows tickUpper.
    assert.equal(dcaRound.tp.edgePriceE8, e8Price(dcaPriceAtTick(spcxb, 54_400)));
    assert.equal(dcaRound.levels[0]!.edgePriceE8, e8Price(dcaPriceAtTick(spcxb, 54_450)));
    assert.ok(BigInt(dcaRound.tp.edgePriceE8) > BigInt(dcaRound.levels[0]!.edgePriceE8));
  });
});

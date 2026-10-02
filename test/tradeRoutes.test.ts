import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { canonicalEncode, paramsHash } from "../src/auth/canonical.js";
import { parseAccountReadSessionSecret, verifyAccountReadSession } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import type { GrantEvidenceReader } from "../src/wallet/grantEvidence.js";
import { APPROVE_SELECTOR, grantsTokenSell, tradeSessionSpec, TRADFI_GUARD_SWAP_SELECTOR } from "../src/ops/policy.js";
import { buildPancakeSell } from "../src/ops/pancake.js";
import { MemoryAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryNonceStore, type NonceStore, type ProvisionClaimLease } from "../src/store/nonces.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import type { TradeDataPlaneReads, TradfiFlashQuote, UniverseLane, UniverseRow, VenueRow } from "../src/trade/dataPlaneReads.js";
import type { RwaFact } from "../src/trade/rwa.js";
import type { TradfiQuote } from "../src/trade/route.js";
import { DEFAULT_TRADE_SETTINGS, isTradfiAiSettings, parseTradeSettings, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import type { TradeReadiness } from "../src/trade/readiness.js";
import { pinUniverse, type PinnedCandidate } from "../src/trade/universe.js";
import { KEPT_POSITION_TEXT, ORPHANED_POSITION_TEXT } from "../src/trade/view.js";
import { encodeInertEvidence } from "../src/trade/inertSubmission.js";
import { DCA_POOLS_56 } from "../src/trade/dca.js";
import { dcaSettings } from "./support/dcaFixtures.js";
import { privateKeyToAccount } from "viem/accounts";
import type { PendingRenewal } from "../src/store/agents.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { runTradeWorkerOnce, type TradeWorkerDeps } from "../src/trade/worker.js";
import { TRADFI_BINANCE_FLASH_ROUTER_56, TRADFI_BINANCE_FLASH_SPENDER_56, type TradfiCapabilityProbeResult } from "../src/trade/guard.js";
import type { RouteQuoteReader } from "../src/trade/route.js";
import type { TradeRunEvent } from "../src/store/tradeRunTrace.js";
import { MemoryTradeCmcStore, type CmcBudgetStore } from "../src/store/tradeCmc.js";
import { MemoryTradeSimulationStore, type TradeSimulationLogReader } from "../src/store/tradeSimulations.js";
import { CMC_GLOBAL_TOOL } from "../src/trade/cmc.js";
import { CMC_SKILL_PLANNING, CMC_SKILL_SECTOR } from "../src/trade/cmcUsEquity.js";
import { DRAFT_KEY, pendingDraft } from "./support/provisioningDraft.js";
import {
  call,
  createHarness,
  EXEC_TOKEN,
  NOW_SEC,
  OTHER_OWNER_PK,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
  tradeConfig,
  type Harness,
  type SignedEnvelope,
} from "./support/serverHarness.js";

const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const ROUTER_V2 = getAddress("0x5000000000000000000000000000000000000005");
const ROUTER_V3 = getAddress("0x5100000000000000000000000000000000000005");
const WBNB = getAddress("0x6000000000000000000000000000000000000006");
const NFPM = getAddress("0x4000000000000000000000000000000000000004");
const TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const CAP = 30_000_000_000_000_000n;
const LEGACY_PUBLIC_KEY = `0x04${"ab".repeat(64)}` as Hex;
const FINALIZED_HASH = `0x${"91".repeat(32)}` as Hex;
const TOKENS = Array.from({ length: 6 }, (_, index) =>
  getAddress(`0x${(index + 101).toString(16).padStart(40, "0")}`));

type DataMode = "ok" | "small" | "unreadable";
type TradfiQuoteFn = (input: { readonly token: Address; readonly amountInAtomic: bigint; readonly slippageBps: number;
  readonly venues?: readonly unknown[]; readonly signal?: AbortSignal }) => Promise<TradfiQuote>;

function universeRows(lane: UniverseLane, count = TOKENS.length): readonly UniverseRow[] {
  return TOKENS.slice(0, count).map((address, index) => ({
    address,
    symbol: `T${index}`,
    lane,
    source: "test",
    ...(lane === "bstocks" ? { marketHours: "us-equities" as const } : {}),
  }));
}

async function fixture(options: {
  readonly dataMode?: DataMode;
  readonly ready?: boolean;
  readonly allowlistAvailable?: boolean;
  readonly agentStore?: AgentStore;
  readonly journal?: Harness["journal"];
  readonly nonceStore?: NonceStore;
  readonly finalizedSession?: "missing" | "registered" | "unreadable";
  readonly keyStoreReader?: KeyStoreReader;
  readonly scheduleQuotes?: { readonly buy: TradfiQuoteFn; readonly sell: TradfiQuoteFn };
  readonly guardVerified?: (guard: Address) => Promise<boolean>;
  readonly dataPlane?: TradeDataPlaneReads;
  readonly aggregatorGuard?: Address;
  readonly schedulableWarm?: { readonly amountWei: bigint; readonly slippageBps: number };
  /** AUDIT MEDIUM-1: override the hardcoded always-"capable" default, to exercise R2.4's unknown/incapable branches. */
  readonly tradfiV2CapabilityProbe?: (input: { readonly candidate: PinnedCandidate; readonly minEntryAtomic: bigint;
    readonly slippageBps: number; readonly signal?: AbortSignal }) => Promise<TradfiCapabilityProbeResult>;
  /** TRADFI-CMC-EQUITY AUDIT M8: an optional CMC store, so the owner-view route's `cmcLog` block is exercised. */
  readonly cmc?: CmcBudgetStore;
  /** TRADFI-EXPIRY-KEEP-REMOVE §5.3: sees exactly the rows the owner view hands the observer. */
  readonly onObserve?: (rows: readonly { readonly positionId: string; readonly status: string }[]) => void;
  readonly simulations?: TradeSimulationLogReader;
} = {}) {
  const memory = options.agentStore ?? new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
    chainId: 56,
    keyStoreAddress: KEYSTORE,
  });
  const store = new Proxy(memory, {
    get(target, property, receiver): unknown {
      if (property === "durable" || property === "keyEncryptionConfigured") return true;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentStore;
  const journal = options.journal ?? new MemoryExecutionJournal(() => NOW_SEC * 1_000);
  const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_SEC * 1_000);
  const positions = new MemoryTradePositionStore(() => NOW_SEC * 1_000);
  const intents = new MemoryTradeIntentStore(() => NOW_SEC * 1_000);
  const mode = options.dataMode ?? "ok";
  const dataPlane: TradeDataPlaneReads = options.dataPlane ?? {
    async universe(lane) {
      if (mode === "unreadable") throw new Error("data plane unavailable");
      return universeRows(lane, mode === "small" ? 4 : TOKENS.length);
    },
    async tokensBatch(addresses) {
      if (mode === "unreadable") throw new Error("data plane unavailable");
      return addresses.map((address, index) => ({ address, symbol: `T${index}`,
        priceUsd: 1, marketCapUsd: 2_000_000, volume24hUsd: 10_000 - index,
        holders: 100, priceChange24hPct: 1 }));
    },
    async eligibilityBatch() { return []; },
    async security() { return { data: {}, meta: {} }; },
  };
  const readiness: TradeReadiness = {
    ready: options.ready ?? true,
    allowlistAvailable: options.allowlistAvailable ?? true,
    bstocksAddresses: new Set(TOKENS.map((token) => token.toLowerCase())),
    stop() {},
  };
  const evidence: GrantEvidenceReader = {
    async readFunding(_wallet, relayGasHeadroomWei, observedAtSec) {
      return { version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2,
        relayGasHeadroomWei: relayGasHeadroomWei.toString(10), requiredWei: "7", balanceWei: "1000000000000000000" };
    },
    async readGrant() {
      return { relayKeys: [], accountKey: null, accountSpend: [], canExecute: [],
        keyStore: { kind: "missing" }, ownerVerdict: "verified" };
    },
  };
  const defaultKeyStoreReader: KeyStoreReader = {
    async listKeys() { return []; },
    async publicKeyFor() { return `0x${"22".repeat(64)}` as Hex; },
    async isValidKey() { return false; },
    async finalizedBlock() {
      if (options.finalizedSession === undefined || options.finalizedSession === "unreadable") {
        throw new Error("finalized unavailable");
      }
      return { number: 101n, hash: FINALIZED_HASH, timestampSec: 1_700_000_000n };
    },
    async blockAt(blockNumber) { return { number: blockNumber, hash: FINALIZED_HASH, timestampSec: 1_700_000_000n }; },
    async listKeysAt() {
      return options.finalizedSession === "registered"
        ? [keccak256(LEGACY_PUBLIC_KEY)]
        : [];
    },
    async publicKeyForAt() { return LEGACY_PUBLIC_KEY; },
    async isValidKeyAt() { return options.finalizedSession === "registered"; },
  };
  const keyStoreReader = options.keyStoreReader ?? defaultKeyStoreReader;
  const venues = { chainId: 56, pancakeRouterV2: ROUTER_V2, pancakeRouterV3: ROUTER_V3, wbnb: WBNB };
  const observeCalls = { count: 0 };
  const harness = await createHarness({ seedAgent: false, agentStore: store, journal,
    ...(options.nonceStore === undefined ? {} : { nonceStore: options.nonceStore }), keyStoreReader,
    tradeAgent: {
      settingsStore, positions, intents, dataPlane, readiness, feeBps: 0,
      // Bypasses the on-chain-venue admission `pinUniverse` would otherwise
      // require for a tradfi-model pin; only the schedulable route's OWN venue
      // check (schedulableTokens) still gates a direct listing. Every existing
      // caller in this file uses a non-tradfi model, so this is inert for them.
      tradfiV2CapabilityProbe: options.tradfiV2CapabilityProbe ?? (async () => "capable" as const),
      ...(options.cmc === undefined ? {} : { cmc: options.cmc }),
      ...(options.simulations === undefined ? {} : { simulations: options.simulations }),
      ...(options.scheduleQuotes === undefined ? {} : { scheduleQuotes: options.scheduleQuotes }),
      ...(options.guardVerified === undefined ? {} : { guardVerified: options.guardVerified }),
      observer: {
        async observe(_agent, rows) {
          observeCalls.count += 1;
          options.onObserve?.(rows);
          return rows.map((row) => ({
            positionId: row.positionId,
            symbol: null,
            decimals: null,
            recordedPositionAmount: row.tokenAmount === null ? null : row.tokenAmount.toString(10),
            liveWalletBalance: row.tokenAmount === null ? null : row.tokenAmount.toString(10),
            currentQuoteWei: row.status === "closed" ? row.exitWei?.toString(10) ?? null : null,
            pnlBps: row.exitWei === null ? null : "0",
            quoteStatus: row.status === "closed" ? "closed" as const : "unavailable" as const,
            reason: null,
            observedAt: NOW_SEC * 1_000,
          }));
        },
      },
    },
    config: { chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true,
      accountReadSession: { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
        environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }) },
      tradeAgentEnabled: true, executeRawEnabled: false,
      trade: tradeConfig({ venues, ...(options.aggregatorGuard === undefined ? {} : { aggregatorGuard: options.aggregatorGuard }) }),
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true },
      ...(options.schedulableWarm === undefined ? {} : { schedulableWarm: options.schedulableWarm }) },
    hire: { evidence, nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB, treasury: TREASURY,
      feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
  return { harness, store, journal, settingsStore, positions, intents, venues, dataPlane, observeCalls };
}

function hireParams(overrides: Partial<Record<"capDayWei" | "executionModel", string>> = {}) {
  const executionModel = overrides.executionModel ?? "sigma";
  return { walletAddress: WALLET, capDayWei: overrides.capDayWei ?? CAP.toString(10), ttlSec: 3_600,
    sizingPreset: "trade-v1", executionModel, hireRunId: "11111111-1111-4111-8111-111111111111",
    autoGrant: true, settings: { ...DEFAULT_TRADE_SETTINGS, executionModel } };
}

async function signed(action: "provisionAgent" | "cancelProvisioning" | "resetGrantAttempt" | "tradeSettings" | "tradeExit" | "tradeDrain" | "revoke" | "read", id: string, params: unknown, pk?: Hex) {
  return signOwnerAction(action, params, { agentId: id, chainId: 56, network: "mainnet", ...(pk === undefined ? {} : { pk }) });
}

async function post(harness: Harness, path: string, envelope: SignedEnvelope) {
  return call(harness, path, { method: "POST", body: envelope });
}

async function seedTradeAgent(f: Awaited<ReturnType<typeof fixture>>, id: string, capDayWei = CAP) {
  const spec = tradeSessionSpec({ venues: f.venues, tokens: TOKENS.map((token) => ({ token })),
    nativeCaps: [{ limit: capDayWei, period: "day" }], expiresAt: NOW_SEC + 3_600, nowSeconds: NOW_SEC });
  return f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", httpRuntimeProfile: "unbound-v1",
    caps: { dailyNativeWei: capDayWei }, sessionFacts: { spec, permissions: { calls: [], spend: [] },
      publicKey: `0x04${"ab".repeat(64)}` as Hex, expiry: NOW_SEC + 3_600,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } } });
}

async function seedRevokedGrid(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const spec = tradeSessionSpec({ venues: f.venues, tokens: TOKENS.map((token) => ({ token })),
    nativeCaps: [{ limit: CAP, period: "day" }], expiresAt: NOW_SEC + 3_600, nowSeconds: NOW_SEC });
  await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", httpRuntimeProfile: "lp-v1",
    caps: { dailyNativeWei: CAP }, sessionFacts: { spec, permissions: { calls: [], spend: [] },
      publicKey: LEGACY_PUBLIC_KEY, expiry: NOW_SEC + 3_600,
      hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "0" } } });
  await f.store.putAgentSessionKey(ownerAccount.address, id, `0x${"11".repeat(32)}` as Hex);
  const revoked = await f.store.updateAgentStatus(ownerAccount.address, id, "revoked");
  assert.equal(revoked?.status, "revoked");
  return revoked!;
}

async function seedExpiredRevoked(f: Awaited<ReturnType<typeof fixture>>, id: string, index: number) {
  const expiresAt = NOW_SEC - 1;
  const publicKey = `0x04${(index + 1).toString(16).padStart(2, "0").repeat(64)}` as Hex;
  const spec = tradeSessionSpec({ venues: f.venues, tokens: TOKENS.map((token) => ({ token })),
    nativeCaps: [{ limit: CAP, period: "day" }], expiresAt, nowSeconds: NOW_SEC - 3_600 });
  await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", httpRuntimeProfile: "lp-v1",
    caps: { dailyNativeWei: CAP }, sessionFacts: { spec, permissions: { calls: [], spend: [] },
      publicKey, expiry: expiresAt,
      hireSizing: { name: "grid-shift-v1", version: 1, openNativeBudgetWei: "0" } } });
  const revoked = await f.store.updateAgentStatus(ownerAccount.address, id, "revoked");
  assert.equal(revoked?.status, "revoked");
}

async function assertNonceFree(f: Awaited<ReturnType<typeof fixture>>, envelope: SignedEnvelope,
  owner: Address = ownerAccount.address) {
  assert.equal(await f.harness.nonceStore.consume(owner,
    envelope.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), true);
}

describe("trading-agent owner routes", () => {
  it("permits Trading S1 after signed cancellation of multiple Grid drafts and preserves each canceled record/key", async () => {
    const f = await fixture();
    for (const id of ["canceled-grid-1", "canceled-grid-2"]) {
      const pending = pendingDraft(ownerAccount.address, WALLET, NOW_SEC);
      await f.store.createProvisioningAgent({ record: { id, ownerAddress: ownerAccount.address,
        walletAddress: WALLET, custodyModel: "passkey" }, sessionKey: DRAFT_KEY,
        pendingGrant: { ...pending, sizing: { ...pending.sizing, sizingPreset: "grid-v1" } } });
      const blocked = await post(f.harness, `/agents/before-${id}/session`, await signed("provisionAgent", `before-${id}`, hireParams()));
      assert.equal(blocked.status, 409, blocked.text);
      assert.match(blocked.text, /before deploying Trading Agent/u);
      const canceled = await post(f.harness, `/agents/${id}/session/cancel`, await signed("cancelProvisioning", id, {}));
      assert.equal(canceled.status, 200, canceled.text);
      assert.equal((canceled.body as { data: { cancelRequested: boolean } }).data.cancelRequested, true);
    }
    const replacement = await post(f.harness, "/agents/replacement-trading/session", await signed("provisionAgent", "replacement-trading", hireParams()));
    assert.equal(replacement.status, 200, replacement.text);
    assert.equal((await f.store.getAgent(ownerAccount.address, "replacement-trading"))?.pendingGrant?.sizing.sizingPreset, "trade-v1");
    for (const id of ["canceled-grid-1", "canceled-grid-2"]) {
      const row = await f.store.getAgent(ownerAccount.address, id);
      assert.equal(row?.status, "provisioning");
      assert.equal(row?.sessionFacts, null);
      assert.equal(await f.store.getAgentSessionKey(ownerAccount.address, id), DRAFT_KEY);
    }
    assert.equal(f.harness.provider.executeCalls.length, 0);
    assert.equal(f.harness.provider.restoreCalls.length, 0);
  });
  it("refuses every pre-nonce S1 failure without creating a row", async () => {
    const cases = [
      { options: { allowlistAvailable: false }, params: hireParams({ executionModel: "mid-cap" }), status: 400, code: "model_unavailable" },
      { options: { dataMode: "small" as const }, params: hireParams(), status: 400, code: "universe_too_small" },
      { options: { dataMode: "unreadable" as const }, params: hireParams(), status: 503, code: "evidence_unreadable" },
      { options: {}, params: hireParams({ capDayWei: "1" }), status: 400, code: "capital_too_small" },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const f = await fixture(testCase.options);
      const id = `trade-refusal-${index}`;
      const action = await signed("provisionAgent", id, testCase.params);
      const response = await post(f.harness, `/agents/${id}/session`, action);
      assert.equal(response.status, testCase.status, response.text);
      const error = (response.body as { error: { code: string; message?: string } }).error;
      assert.equal(error.code, testCase.code);
      if (testCase.code === "capital_too_small") {
        assert.equal(error.message, "Total capital must be at least 0.01 BNB.");
        assert.doesNotMatch(error.message, /wei/u);
      }
      assert.equal(await f.store.getAgentById(id), null);
      await assertNonceFree(f, action);
    }
  });

  it("persists the verbatim pin and the singular native cap in the trade-v1 pending grant", async () => {
    const f = await fixture();
    const id = "trade-happy";
    const response = await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, hireParams()));
    assert.equal(response.status, 200, response.text);
    const row = await f.store.getAgentById(id);
    assert.equal(row?.status, "provisioning");
    assert.equal(row?.httpRuntimeProfile, "unbound-v1");
    assert.equal(row?.caps?.dailyNativeWei, CAP);
    assert.equal(row?.caps?.perTradeNativeWei, BigInt(DEFAULT_TRADE_SETTINGS.entryWei));
    assert.equal(row?.pendingGrant?.hireRunId, "11111111-1111-4111-8111-111111111111");
    assert.equal(row?.pendingGrant?.autoGrant, true);
    assert.deepEqual(row?.pendingGrant?.initialTradeSettings, {
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS),
    });
    assert.deepEqual(row?.pendingGrant?.sizing, { capDayWei: CAP.toString(10), openNativeBudgetWei: "0",
      sizingPreset: "trade-v1", sizingPresetVersion: 1 });
    const native = row?.pendingGrant?.sessionSpec.spendCaps.filter((cap) => cap.token === undefined && cap.period === "day");
    assert.deepEqual(native, [{ limit: CAP, period: "day" }]);
    const pinned = row?.pendingGrant?.permissions.spend.filter((cap) => cap.token !== undefined).map((cap) => cap.token);
    assert.deepEqual(pinned, TOKENS);
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    assert.match(source, /if \(nativeCaps\.length !== 1\) throw new HireEvidenceError\(\);/u);
  });

  it("issues the read session only on fresh Trading acceptance, never on replay", async () => {
    const f = await fixture();
    const id = "trade-read-session";
    const action = await signed("provisionAgent", id, hireParams());
    const first = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(first.status, 200, first.text);
    const readSession = (first.body["data"] as { readSession?: { token?: unknown; expiry?: unknown } }).readSession;
    assert.equal(typeof readSession?.token, "string");
    assert.equal(typeof readSession?.expiry, "number");
    const config = { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
      environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }) };
    assert.equal(verifyAccountReadSession(readSession?.token as string, config, NOW_SEC), ownerAccount.address);
    const replay = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(replay.status, 200, replay.text);
    assert.equal((replay.body["data"] as Record<string, unknown>)["readSession"], undefined);
  });

  it("converges a removed Grid key that is absent at one stable finalized block before Trading S1", async () => {
    const f = await fixture({ finalizedSession: "missing" });
    const removed = await seedRevokedGrid(f, "removed-grid");
    const response = await post(f.harness, "/agents/trade-after-remove/session",
      await signed("provisionAgent", "trade-after-remove", hireParams()));
    assert.equal(response.status, 200, response.text);
    const converged = await f.store.getAgent(ownerAccount.address, removed.id);
    assert.equal(converged?.sessionRevocation?.verdict, "missing");
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, removed.id), false);
    assert.equal((await f.store.getAgentById("trade-after-remove"))?.status, "provisioning");
  });

  it("keeps a listed valid Grid key blocked and returns its exact public remedy", async () => {
    const f = await fixture({ finalizedSession: "registered" });
    await seedRevokedGrid(f, "still-valid-grid");
    const response = await post(f.harness, "/agents/trade-blocked/session",
      await signed("provisionAgent", "trade-blocked", hireParams()));
    assert.equal(response.status, 409, response.text);
    assert.deepEqual((response.body as { error: { code: string; message: string } }).error, {
      code: "wallet_in_use",
      message: 'Finish removing Grid Agent "still-valid-grid" before deploying Trading Agent.',
    });
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, "still-valid-grid"), true);
    assert.equal(await f.store.getAgentById("trade-blocked"), null);
  });

  it("does not infer an unfinished session setup safe and names its exact status and expiry", async () => {
    const f = await fixture();
    const first = await post(f.harness, "/agents/trade-draft/session",
      await signed("provisionAgent", "trade-draft", hireParams()));
    assert.equal(first.status, 200, first.text);
    const draft = await f.store.getAgentById("trade-draft");
    const response = await post(f.harness, "/agents/trade-next/session",
      await signed("provisionAgent", "trade-next", hireParams()));
    assert.equal(response.status, 409, response.text);
    const message = (response.body as { error: { code: string; message: string } }).error.message;
    assert.equal(message,
      `Trading Agent "trade-draft" still has an unfinished session setup until ${new Date(draft!.pendingGrant!.expiresAt * 1_000).toISOString()}. Cancel or finish that setup before deploying Trading Agent.`);
    assert.equal(await f.store.getAgentById("trade-next"), null);
  });

  it("keeps a committed proof prefix but creates no nonce claim or Trading row after the shared deadline", async () => {
    const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
      chainId: 56,
      keyStoreAddress: KEYSTORE,
    });
    let crossDeadline = (): void => {};
    const delayed = new Proxy(memory, {
      get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        if (property === "confirmSessionRevokedCas") {
          return async (...args: Parameters<AgentStore["confirmSessionRevokedCas"]>) => {
            const result = await target.confirmSessionRevokedCas(...args);
            crossDeadline();
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStore;
    const f = await fixture({ agentStore: delayed, finalizedSession: "missing" });
    crossDeadline = () => { f.harness.advance(12_001); };
    await seedRevokedGrid(f, "deadline-grid");
    const action = await signed("provisionAgent", "deadline-trade", hireParams());
    const response = await post(f.harness, "/agents/deadline-trade/session", action);
    assert.equal(response.status, 503, response.text);
    assert.equal((response.body as { error: { code: string } }).error.code, "evidence_unreadable");
    assert.equal((await f.store.getAgentById("deadline-grid"))?.sessionRevocation?.verdict, "missing");
    assert.equal(await f.store.getAgentById("deadline-trade"), null);
    await assertNonceFree(f, action);
  });

  it("names the atomic winner when two distinct Trading S1s race one free wallet", async () => {
    const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
      chainId: 56,
      keyStoreAddress: KEYSTORE,
    });
    let releaseBoth = (): void => {};
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let entered = 0;
    const racing = new Proxy(memory, {
      get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        if (property === "createProvisioningAgent") {
          return async (...args: Parameters<AgentStore["createProvisioningAgent"]>) => {
            entered += 1;
            if (entered === 2) releaseBoth();
            await bothEntered;
            return target.createProvisioningAgent(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStore;
    const f = await fixture({ agentStore: racing });
    const [left, right] = await Promise.all([
      post(f.harness, "/agents/trade-race-left/session",
        await signed("provisionAgent", "trade-race-left", hireParams())),
      post(f.harness, "/agents/trade-race-right/session",
        await signed("provisionAgent", "trade-race-right", hireParams())),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);
    const winner = (await f.store.listAgents(ownerAccount.address)).find((row) => row.status === "provisioning");
    assert.notEqual(winner, undefined);
    const loser = left.status === 409 ? left : right;
    assert.deepEqual((loser.body as { error: { code: string; message: string } }).error, {
      code: "wallet_in_use",
      message: `Trading Agent "${winner!.id}" still has an unfinished session setup until ${new Date(winner!.pendingGrant!.expiresAt * 1_000).toISOString()}. Cancel or finish that setup before deploying Trading Agent.`,
    });
  });

  it("converges 32 absent legacy rows with no more than four finalized reads in flight", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    let finalizedLists = 0;
    const reader: KeyStoreReader = {
      async listKeys() { return []; },
      async publicKeyFor() { return LEGACY_PUBLIC_KEY; },
      async isValidKey() { return false; },
      async finalizedBlock() { return { number: 101n, hash: FINALIZED_HASH, timestampSec: 1_700_000_000n }; },
      async blockAt(blockNumber) { return { number: blockNumber, hash: FINALIZED_HASH, timestampSec: 1_700_000_000n }; },
      async listKeysAt() {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        finalizedLists += 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return [];
      },
      async publicKeyForAt() { return LEGACY_PUBLIC_KEY; },
      async isValidKeyAt() { return false; },
    };
    const f = await fixture({ keyStoreReader: reader });
    for (let index = 0; index < 32; index += 1) {
      await seedExpiredRevoked(f, `legacy-${String(index).padStart(2, "0")}`, index);
    }
    const response = await post(f.harness, "/agents/trade-after-32/session",
      await signed("provisionAgent", "trade-after-32", hireParams()));
    assert.equal(response.status, 200, response.text);
    assert.equal(finalizedLists, 32);
    assert.equal(maximumInFlight, 4);
    const rows = await f.store.listAgents(ownerAccount.address);
    assert.equal(rows.filter((row) => row.sessionRevocation?.verdict === "missing").length, 32);
    assert.equal(rows.find((row) => row.id === "trade-after-32")?.status, "provisioning");
  });

  it("fails hasMore before proof, nonce, key, or candidate-row mutation", async () => {
    const f = await fixture({ finalizedSession: "missing" });
    for (let index = 0; index < 33; index += 1) {
      const wallet = getAddress(`0x${(index + 1_000).toString(16).padStart(40, "0")}`);
      await f.store.createAgent({ id: `inventory-${String(index).padStart(2, "0")}`,
        ownerAddress: ownerAccount.address, walletAddress: wallet, custodyModel: "self-eoa", status: "armed" });
    }
    const action = await signed("provisionAgent", "trade-overflow", hireParams());
    const response = await post(f.harness, "/agents/trade-overflow/session", action);
    assert.equal(response.status, 503, response.text);
    assert.equal(await f.store.getAgentById("trade-overflow"), null);
    assert.equal((await f.store.listAgents(ownerAccount.address)).every((row) => row.sessionRevocation === null), true);
    await assertNonceFree(f, action);
  });

  it("does not create a Trading row when the final bounded inventory finishes after deadline", async () => {
    const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
      chainId: 56,
      keyStoreAddress: KEYSTORE,
    });
    let crossDeadline = (): void => {};
    let lists = 0;
    const delayed = new Proxy(memory, {
      get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        if (property === "listAgentsBounded") {
          return async (...args: Parameters<AgentStore["listAgentsBounded"]>) => {
            const result = await target.listAgentsBounded(...args);
            lists += 1;
            if (lists === 2) crossDeadline();
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStore;
    const f = await fixture({ agentStore: delayed, finalizedSession: "missing" });
    crossDeadline = () => { f.harness.advance(12_001); };
    await seedRevokedGrid(f, "final-list-grid");
    const action = await signed("provisionAgent", "final-list-trade", hireParams());
    const response = await post(f.harness, "/agents/final-list-trade/session", action);
    assert.equal(response.status, 503, response.text);
    assert.equal((await f.store.getAgentById("final-list-grid"))?.sessionRevocation?.verdict, "missing");
    assert.equal(await f.store.getAgentById("final-list-trade"), null);
    await assertNonceFree(f, action);
  });

  it("honors request cancellation during the final inventory and starts no candidate mutation", async () => {
    const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
      chainId: 56,
      keyStoreAddress: KEYSTORE,
    });
    const controller = new AbortController();
    let lists = 0;
    const cancelled = new Proxy(memory, {
      get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        if (property === "listAgentsBounded") {
          return async (...args: Parameters<AgentStore["listAgentsBounded"]>) => {
            const result = await target.listAgentsBounded(...args);
            lists += 1;
            if (lists === 2) controller.abort();
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStore;
    const f = await fixture({ agentStore: cancelled, finalizedSession: "missing" });
    await seedRevokedGrid(f, "cancel-final-grid");
    const action = await signed("provisionAgent", "cancel-final-trade", hireParams());
    const response = await f.harness.app.request("/agents/cancel-final-trade/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-exec-token": EXEC_TOKEN },
      body: JSON.stringify(action),
      signal: controller.signal,
    });
    assert.equal(response.status, 503, await response.text());
    assert.equal((await f.store.getAgentById("cancel-final-grid"))?.sessionRevocation?.verdict, "missing");
    assert.equal(await f.store.getAgentById("cancel-final-trade"), null);
    await assertNonceFree(f, action);
  });

  it("does not confirm proof after an abort-ignoring finalized read completes late", async () => {
    const controller = new AbortController();
    const reader: KeyStoreReader = {
      async listKeys() { return []; },
      async publicKeyFor() { return LEGACY_PUBLIC_KEY; },
      async isValidKey() { return false; },
      async finalizedBlock() { return { number: 101n, hash: FINALIZED_HASH, timestampSec: 1_700_000_000n }; },
      async blockAt(blockNumber) { return { number: blockNumber, hash: FINALIZED_HASH, timestampSec: 1_700_000_000n }; },
      async listKeysAt() {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 2));
        return [];
      },
      async publicKeyForAt() { return LEGACY_PUBLIC_KEY; },
      async isValidKeyAt() { return false; },
    };
    const f = await fixture({ keyStoreReader: reader });
    await seedRevokedGrid(f, "late-read-grid");
    const action = await signed("provisionAgent", "late-read-trade", hireParams());
    const response = await f.harness.app.request("/agents/late-read-trade/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-exec-token": EXEC_TOKEN },
      body: JSON.stringify(action),
      signal: controller.signal,
    });
    assert.equal(response.status, 503, await response.text());
    assert.equal((await f.store.getAgentById("late-read-grid"))?.sessionRevocation, null);
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, "late-read-grid"), true);
    assert.equal(await f.store.getAgentById("late-read-trade"), null);
    await assertNonceFree(f, action);
  });

  it("uses strict Trading and neutral copy for armed or paused blockers", async () => {
    const trading = await fixture();
    await seedTradeAgent(trading, "armed-trading");
    const tradingBlocked = await post(trading.harness, "/agents/trade-beside-trading/session",
      await signed("provisionAgent", "trade-beside-trading", hireParams()));
    assert.equal((tradingBlocked.body as { error: { message: string } }).error.message,
      'Remove Trading Agent "armed-trading" before deploying Trading Agent.');

    const unknown = await fixture();
    await unknown.store.createAgent({ id: "paused-legacy", ownerAddress: ownerAccount.address,
      walletAddress: WALLET, custodyModel: "passkey", status: "paused" });
    const unknownBlocked = await post(unknown.harness, "/agents/trade-beside-legacy/session",
      await signed("provisionAgent", "trade-beside-legacy", hireParams()));
    assert.equal((unknownBlocked.body as { error: { message: string } }).error.message,
      'Remove Agent "paused-legacy" before deploying Trading Agent.');
  });

  it("repairs an expired accepted S1 without extending its fixed session expiry", async () => {
    const f = await fixture();
    const id = "trade-expired-replay";
    const provision = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC, expiry: NOW_SEC + 1,
    });
    const first = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(first.status, 200, first.text);
    const expiresAt = (await f.store.getAgentById(id))?.pendingGrant?.expiresAt;
    f.harness.advance(2_000);
    const replay = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(replay.status, 200, replay.text);
    assert.equal((await f.store.getAgentById(id))?.pendingGrant?.expiresAt, expiresAt);
  });

  it("terminalizes only a cryptographically valid expired S1 with no durable evidence", async () => {
    const f = await fixture();
    const id = "trade-expired-no-evidence";
    const expired = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC - 121, expiry: NOW_SEC - 1,
    });
    const terminal = await post(f.harness, `/agents/${id}/session`, expired);
    assert.equal(terminal.status, 410, terminal.text);
    assert.equal((terminal.body as { error: { code: string } }).error.code, "hire_no_evidence");
    assert.equal(await f.store.getAgentById(id), null);
    assert.equal((await post(f.harness, `/agents/${id}/session`, expired)).status, 410);

    const forged = { ...expired, signed: { ...expired.signed, nonce: `0x${"ab".repeat(32)}` as Hex },
      signature: `0x${"00".repeat(65)}` as Hex };
    assert.equal((await post(f.harness, `/agents/${id}-forged/session`, {
      ...forged, signed: { ...forged.signed, agentId: `${id}-forged` },
    })).status, 401);
    const retainedThroughMs = (NOW_SEC - 1 + hireParams().ttlSec) * 1_000 + 999;
    assert.equal(await f.harness.nonceStore.prune(retainedThroughMs), 0,
      "terminal evidence must cover the full accepted expiry second");
    assert.equal(await f.harness.nonceStore.prune(retainedThroughMs + 1), 1);
  });

  it("serializes materialization through expiry and makes the waiter join the exact row", async () => {
    let releaseCreate = (): void => {};
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markCreateEntered = (): void => {};
    const createEntered = new Promise<void>((resolve) => { markCreateEntered = resolve; });
    const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000);
    let held = true;
    const delayed = new Proxy(memory, {
      get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        if (property === "createProvisioningAgent") {
          return async (...args: Parameters<AgentStore["createProvisioningAgent"]>) => {
            if (held) {
              held = false;
              markCreateEntered();
              await createGate;
            }
            return target.createProvisioningAgent(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStore;
    const f = await fixture({ agentStore: delayed });
    const id = "trade-held-materialize";
    const provision = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC, expiry: NOW_SEC + 1,
    });
    const materializer = post(f.harness, `/agents/${id}/session`, provision);
    await createEntered;
    f.harness.advance(2_000);
    let waiterSettled = false;
    const waiter = post(f.harness, `/agents/${id}/session`, provision).then((value) => {
      waiterSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(waiterSettled, false, "the expiry-crossing waiter must remain behind materialization");
    releaseCreate();
    const [first, second] = await Promise.all([materializer, waiter]);
    assert.equal(first.status, 200, first.text);
    assert.equal(second.status, 200, second.text);
    assert.equal((second.body as { meta?: { replayed?: boolean } }).meta?.replayed, true);
    assert.notEqual(await f.store.getAgentById(id), null);
  });

  it("lets terminal win both concurrent expired arrivals and creates no row", async () => {
    const f = await fixture();
    const id = "trade-terminal-first";
    const provision = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC, expiry: NOW_SEC + 1,
    });
    f.harness.advance(2_000);
    const [first, second] = await Promise.all([
      post(f.harness, `/agents/${id}/session`, provision),
      post(f.harness, `/agents/${id}/session`, provision),
    ]);
    assert.deepEqual([first.status, second.status], [410, 410]);
    assert.equal(await f.store.getAgentById(id), null);
  });

  it("lets an expiry-crossed terminal request beat a pre-expiry request gated before the nonce lock", async () => {
    const inner = new MemoryNonceStore();
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstWaiting = (): void => {};
    const firstWaiting = new Promise<void>((resolve) => { markFirstWaiting = resolve; });
    let entries = 0;
    const gated: NonceStore = {
      consume: (...args) => inner.consume(...args),
      async withProvisionClaimLock<T>(ownerAddress: Address, nonce: string,
        operation: (claim: ProvisionClaimLease) => Promise<T>): Promise<T> {
        entries += 1;
        if (entries === 1) {
          markFirstWaiting();
          await firstGate;
        }
        return inner.withProvisionClaimLock(ownerAddress, nonce, operation);
      },
      prune: (now) => inner.prune(now),
      close: () => inner.close(),
    };
    const f = await fixture({ nonceStore: gated });
    const id = "trade-terminal-beats-delayed-fresh";
    const provision = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC, expiry: NOW_SEC + 1,
    });
    const delayedFresh = post(f.harness, `/agents/${id}/session`, provision);
    await firstWaiting;
    f.harness.advance(2_000);
    const terminal = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(terminal.status, 410, terminal.text);
    releaseFirst();
    const delayed = await delayedFresh;
    assert.equal(delayed.status, 410, delayed.text);
    assert.equal(await f.store.getAgentById(id), null);
  });

  it("repairs an exact live claim after a pre-row materialization failure", async () => {
    const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000);
    let createCalls = 0;
    const failsOnce = new Proxy(memory, {
      get(target, property, receiver): unknown {
        if (property === "durable" || property === "keyEncryptionConfigured") return true;
        if (property === "createProvisioningAgent") {
          return async (...args: Parameters<AgentStore["createProvisioningAgent"]>) => {
            createCalls += 1;
            if (createCalls === 1) throw new Error("injected pre-row failure");
            return target.createProvisioningAgent(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentStore;
    const f = await fixture({ agentStore: failsOnce });
    const id = "trade-claim-before-row";
    const provision = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC, expiry: NOW_SEC + 1,
    });
    const failed = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(failed.status, 500, failed.text);
    assert.equal(await f.store.getAgentById(id), null);
    f.harness.advance(2_000);
    const repaired = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(repaired.status, 200, repaired.text);
    assert.equal(createCalls, 2);
    assert.equal((await f.store.getAgentById(id))?.pendingGrant?.expiresAt, NOW_SEC + hireParams().ttlSec);
  });

  it("repairs the exact row and journal after journal persistence fails", async () => {
    const memoryJournal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
    let beginCalls = 0;
    const failsOnce = new Proxy(memoryJournal, {
      get(target, property, receiver): unknown {
        if (property === "begin") {
          return async (...args: Parameters<Harness["journal"]["begin"]>) => {
            beginCalls += 1;
            if (beginCalls === 1) throw new Error("injected row-before-journal failure");
            return target.begin(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Harness["journal"];
    const f = await fixture({ journal: failsOnce });
    const id = "trade-row-before-journal";
    const provision = await signOwnerAction("provisionAgent", hireParams(), {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC, expiry: NOW_SEC + 1,
    });
    const failed = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(failed.status, 503, failed.text);
    const partial = await f.store.getAgentById(id);
    assert.notEqual(partial, null);
    const firstPublicKey = partial?.pendingGrant?.sessionPublicKey;
    const firstExpiresAt = partial?.pendingGrant?.expiresAt;
    f.harness.advance(2_000);
    const repaired = await post(f.harness, `/agents/${id}/session`, provision);
    assert.equal(repaired.status, 200, repaired.text);
    assert.equal((await f.store.getAgentById(id))?.pendingGrant?.sessionPublicKey, firstPublicKey);
    assert.equal((await f.store.getAgentById(id))?.pendingGrant?.expiresAt, firstExpiresAt);
    assert.equal((await f.journal.get(partial!.pendingGrant!.provisionActionId))?.state, "COMMITTED");
  });

  it("never terminalizes invalid, future, or plain legacy S1 variants", async () => {
    const expiredOptions = { chainId: 56, network: "mainnet", issuedAt: NOW_SEC - 121,
      expiry: NOW_SEC - 1 } as const;
    const cases: readonly {
      readonly name: string;
      readonly make: (id: string) => Promise<SignedEnvelope>;
      readonly nonceOwner?: Address;
    }[] = [
      { name: "forged", make: async (id) => {
        const value = await signOwnerAction("provisionAgent", hireParams(), { ...expiredOptions, agentId: id });
        return { ...value, signature: `0x${"00".repeat(65)}` as Hex };
      } },
      { name: "wrong-owner", nonceOwner: getAddress("0x9999999999999999999999999999999999999999"),
        make: async (id) => {
          const value = await signOwnerAction("provisionAgent", hireParams(), { ...expiredOptions, agentId: id });
          return { ...value, signed: { ...value.signed,
            owner: getAddress("0x9999999999999999999999999999999999999999") } };
        } },
      { name: "wrong-domain", make: (id) => signOwnerAction("provisionAgent", hireParams(), {
        ...expiredOptions, agentId: id, chainId: 97,
      }) },
      { name: "tampered", make: async (id) => {
        const value = await signOwnerAction("provisionAgent", hireParams(), { ...expiredOptions, agentId: id });
        return { ...value, params: { ...hireParams(), capDayWei: (CAP + 1n).toString(10) } };
      } },
      { name: "not-yet-valid", make: (id) => signOwnerAction("provisionAgent", hireParams(), {
        agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC + 120, expiry: NOW_SEC + 240,
      }) },
    ];
    for (const testCase of cases) {
      const f = await fixture();
      const id = `trade-terminal-${testCase.name}`;
      const provision = await testCase.make(id);
      const response = await post(f.harness, `/agents/${id}/session`, provision);
      assert.equal(response.status, 401, `${testCase.name}: ${response.text}`);
      assert.equal(await f.store.getAgentById(id), null);
      await assertNonceFree(f, provision, testCase.nonceOwner ?? ownerAccount.address);
    }

    const legacy = await fixture();
    const id = "trade-terminal-legacy";
    const provision = await signOwnerAction("provisionAgent", hireParams(), { ...expiredOptions, agentId: id });
    assert.equal(await legacy.harness.nonceStore.consume(ownerAccount.address,
      provision.signed.nonce as Hex, (NOW_SEC + 3_600) * 1_000), true);
    const response = await post(legacy.harness, `/agents/${id}/session`, provision);
    assert.equal(response.status, 409, response.text);
    assert.equal((response.body as { error: { code: string } }).error.code, "s1_ambiguous");
    assert.equal((await post(legacy.harness, `/agents/${id}/session`, provision)).status, 409);
    assert.equal(await legacy.store.getAgentById(id), null);
  });

  it("uses exact S1 continuation and gives invocation authority to only the fresh grant-attempt creator", async () => {
    const f = await fixture();
    const id = "trade-grant-fence";
    const provision = await signed("provisionAgent", id, hireParams());
    assert.equal((await post(f.harness, `/agents/${id}/session`, provision)).status, 200);

    const first = await post(f.harness, `/agents/${id}/session/grant-attempt`, provision);
    assert.equal(first.status, 200, first.text);
    const firstData = (first.body as { data: { attemptId: Hex; mayInvoke: boolean } }).data;
    assert.equal(firstData.mayInvoke, true);
    const firstRow = await f.harness.agentStore.getAgent(ownerAccount.address, id);
    assert.equal(firstData.attemptId, keccak256(stringToBytes(canonicalEncode({
      purpose: "tradeGrantAttempt/v1",
      provisionActionId: firstRow?.pendingGrant?.provisionActionId,
    }))));

    const replay = await post(f.harness, `/agents/${id}/session/grant-attempt`, provision);
    assert.equal(replay.status, 200, replay.text);
    const replayData = (replay.body as { data: { attemptId: Hex; mayInvoke: boolean } }).data;
    assert.equal(replayData.attemptId, firstData.attemptId);
    assert.equal(replayData.mayInvoke, false);

    const continued = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-provision-action": toReadHeader(provision) },
    });
    assert.equal(continued.status, 200);
    const continuedBody = await continued.json() as { data: { hireRunId: string; grantAttempt: { attemptId: Hex } } };
    assert.equal(continuedBody.data.hireRunId, hireParams().hireRunId);
    assert.equal(continuedBody.data.grantAttempt.attemptId, firstData.attemptId);

    const differentSignature = await signed("provisionAgent", id, hireParams());
    const mismatched = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-provision-action": toReadHeader(differentSignature) },
    });
    assert.equal(mismatched.status, 409);
    const tamperedProvision = { ...provision, params: { ...hireParams(), capDayWei: "10000000000000000" } };
    const tamperedContinuation = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-provision-action": toReadHeader(tamperedProvision) },
    });
    assert.equal(tamperedContinuation.status, 401);

    const reset = await signed("resetGrantAttempt", id, { attemptId: firstData.attemptId });
    const resetResponse = await post(f.harness, `/agents/${id}/session/grant-attempt/reset`, reset);
    assert.equal(resetResponse.status, 200, resetResponse.text);
    const second = await post(f.harness, `/agents/${id}/session/grant-attempt`, provision);
    assert.equal(second.status, 200, second.text);
    const secondData = (second.body as { data: { attemptId: Hex; mayInvoke: boolean } }).data;
    assert.notEqual(secondData.attemptId, firstData.attemptId);
    assert.equal(secondData.mayInvoke, true);

    const alteredOldReset = { ...reset, params: { attemptId: secondData.attemptId } };
    assert.equal((await post(f.harness, `/agents/${id}/session/grant-attempt/reset`, alteredOldReset)).status, 401);
    assert.equal((await post(f.harness, `/agents/${id}/session/grant-attempt/reset`, reset)).status, 200);
    const afterOldReplay = await f.harness.agentStore.getAgent(ownerAccount.address, id);
    assert.equal(afterOldReplay?.pendingGrant?.grantAttempt?.attemptId, secondData.attemptId);
  });

  it("previews trade-v1 without openNativeBudgetWei and marks the server pin indicative", async () => {
    const f = await fixture();
    assert.equal((await pinUniverse("sigma", { dataPlane: f.dataPlane })).length, TOKENS.length);
    const response = await f.harness.app.request(`/agents/hire/preview?walletAddress=${WALLET}&capDayWei=${CAP}&sizingPreset=trade-v1&executionModel=sigma&entryWei=${DEFAULT_TRADE_SETTINGS.entryWei}&maxOpenPositions=${DEFAULT_TRADE_SETTINGS.maxOpenPositions}`,
      { headers: { "x-exec-token": EXEC_TOKEN } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { capDayWei: string; indicative: boolean;
      pin: readonly { address: Address }[]; sizing: Record<string, unknown> } };
    assert.equal(body.data.capDayWei, CAP.toString(10));
    assert.equal(body.data.indicative, true);
    assert.deepEqual(body.data.pin.map((row) => row.address), TOKENS);
    assert.deepEqual(Object.keys(body.data.sizing).sort(), [
      "capitalRequiredWei", "capitalShortfallWei", "entryWei", "executionModel", "grantedTokenCount",
      "maxOpenPositions", "name", "ok", "openNativeBudgetWei", "platformFeeBps",
      "platformFeePerEntryWei", "platformFeeTotalWei", "tradeRelayFeePerSubmitWei", "version",
    ]);
  });

  it("[F5] builds an expiry-renewed trade spec held-first, with kept and added entries and sellable held calls", async () => {
    const f = await fixture();
    const id = "trade-renewal-s2";
    const currentSpec = tradeSessionSpec({ venues: f.venues, tokens: [{ token: TOKENS[0]! }],
      nativeCaps: [{ limit: CAP, period: "day" }], expiresAt: NOW_SEC - 1, nowSeconds: NOW_SEC - 3_600 });
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "passkey", status: "armed", httpRuntimeProfile: "unbound-v1", caps: { dailyNativeWei: CAP },
      sessionFacts: { spec: currentSpec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY,
        expiry: NOW_SEC - 1, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } } });
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    for (const [index, token] of [TOKENS[4]!, TOKENS[4]!, TOKENS[5]!].entries()) {
      await f.positions.open({ positionId: `held-${index}`, agentId: id, ownerAddress: ownerAccount.address,
        token, route: { hops: [], fees: [] }, entryWei: 100n, tokenAmount: 10n,
        fillStatus: "verified", openedAt: NOW_SEC * 1_000 });
    }
    const action = await signOwnerAction("renewSession", { ttlSec: 3_600 },
      { agentId: id, chainId: 56, network: "mainnet" });
    const response = await post(f.harness, `/agents/${id}/session/renew`, action);
    assert.equal(response.status, 200, response.text);
    const universe = (response.body["data"] as { universe: { tokens: readonly Address[]; held: number; pinned: number } }).universe;
    assert.equal(universe.held, 2);
    assert.equal(universe.pinned, TOKENS.length);
    assert.deepEqual(new Set(universe.tokens.slice(0, 2).map((token) => token.toLowerCase())), new Set([TOKENS[4]!.toLowerCase(), TOKENS[5]!.toLowerCase()]));
    assert.equal(new Set(universe.tokens.map((token) => token.toLowerCase())).size, universe.tokens.length);

    const pending = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
    assert.notEqual(pending, null);
    assert.notEqual(pending, undefined);
    const renewedSpec = pending!.sessionSpec;
    assert.equal(renewedSpec.expiresAt, NOW_SEC + 3_600);
    assert.deepEqual(renewedSpec.spendCaps.filter((cap) => cap.token === undefined), currentSpec.spendCaps.filter((cap) => cap.token === undefined));
    assert.deepEqual(renewedSpec.allowedCalls.filter((rule) => rule.to?.toLowerCase() === TOKENS[0]!.toLowerCase()),
      currentSpec.allowedCalls.filter((rule) => rule.to?.toLowerCase() === TOKENS[0]!.toLowerCase()));

    const finalTokens = renewedSpec.allowedCalls
      .filter((rule) => rule.selector === "approve(address,uint256)" && rule.to !== undefined)
      .map((rule) => rule.to!);
    assert.deepEqual(new Set(finalTokens.map((token) => token.toLowerCase())), new Set(universe.tokens.map((token) => token.toLowerCase())));
    const currentTokens = new Set(currentSpec.spendCaps.filter((cap) => cap.token !== undefined).map((cap) => cap.token!.toLowerCase()));
    const addedTokens = finalTokens.filter((token) => !currentTokens.has(token.toLowerCase()));
    const generatedAdded = tradeSessionSpec({ venues: f.venues, tokens: addedTokens.map((token) => ({ token })),
      nativeCaps: currentSpec.spendCaps.filter((cap) => cap.token === undefined), expiresAt: renewedSpec.expiresAt, nowSeconds: NOW_SEC });
    assert.deepEqual(renewedSpec.allowedCalls.filter((rule) => rule.selector === "approve(address,uint256)"
      && rule.to !== undefined && !currentTokens.has(rule.to.toLowerCase())),
      generatedAdded.allowedCalls.filter((rule) => rule.selector === "approve(address,uint256)"));
    assert.deepEqual(renewedSpec.spendCaps.filter((cap) => cap.token !== undefined && !currentTokens.has(cap.token.toLowerCase())),
      generatedAdded.spendCaps.filter((cap) => cap.token !== undefined));

    for (const token of [TOKENS[4]!, TOKENS[5]!]) {
      assert.equal(grantsTokenSell(renewedSpec, token), true);
      const sell = buildPancakeSell({ router: f.venues.pancakeRouterV2!, wbnb: f.venues.wbnb!, token,
        amountInWei: 10n, minOutWei: 1n, recipient: WALLET, deadline: BigInt(NOW_SEC + 120) });
      assert.deepEqual(sell.slice(0, 2).map((call) => call.to), [token, token]);
      assert.equal(sell[2]?.to, f.venues.pancakeRouterV2);
    }

    const small = await fixture({ dataMode: "small" });
    const smallId = "trade-renewal-pin-small";
    const smallSpec = tradeSessionSpec({ venues: small.venues, tokens: [{ token: TOKENS[0]! }],
      nativeCaps: [{ limit: CAP, period: "day" }], expiresAt: NOW_SEC - 1, nowSeconds: NOW_SEC - 3_600 });
    await small.store.createAgent({ id: smallId, ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "passkey", status: "armed", httpRuntimeProfile: "unbound-v1", caps: { dailyNativeWei: CAP },
      sessionFacts: { spec: smallSpec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY,
        expiry: NOW_SEC - 1, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } } });
    await small.settingsStore.put({ agentId: smallId, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    const tooSmall = await post(small.harness, `/agents/${smallId}/session/renew`, await signOwnerAction("renewSession", { ttlSec: 3_600 },
      { agentId: smallId, chainId: 56, network: "mainnet" }));
    assert.equal(tooSmall.status, 409, tooSmall.text);
    assert.equal((tooSmall.body as { error: { code: string } }).error.code, "renewal_universe_unavailable");
    assert.equal((await small.store.getAgent(ownerAccount.address, smallId))?.pendingRenewal, null);
  });

  it("[F8] reads one coherent executing session tuple for each trade submission", async () => {
    const f = await fixture();
    const id = "trade-read-session-once";
    await seedTradeAgent(f, id);
    assert.equal((await f.store.bindHttpRuntimeProfile(ownerAccount.address, id, "trade-v1")).kind, "updated");
    await f.store.putAgentSessionKey(ownerAccount.address, id, `0x${"11".repeat(32)}` as Hex);
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    let reads = 0;
    const original = f.harness.agentStore.readExecutingSession.bind(f.harness.agentStore);
    f.harness.agentStore.readExecutingSession = async (owner, agentId) => {
      reads += 1;
      return original(owner, agentId);
    };
    const response = await call(f.harness, `/agents/${id}/trade`, { method: "POST", body: {
      decisionId: "trade-read-session-once", venue: "pancake", side: "buy", token: TOKENS[0],
      amountWei: "1000", minOutWei: "995", quotedOutWei: "1000",
    } });
    assert.equal(response.status, 200, response.text);
    assert.equal(f.harness.provider.executeCalls.length, 1);
    assert.equal(reads, f.harness.provider.executeCalls.length);
  });

  it("blocks settings while any other journal row is PENDING", async () => {
    const f = await fixture();
    const id = "trade-settings-pending";
    await seedTradeAgent(f, id);
    await f.journal.begin({ idempotencyKey: `0x${"44".repeat(32)}` as Hex, agentId: id,
      ownerAddress: ownerAccount.address, kind: "trade" });
    const response = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, DEFAULT_TRADE_SETTINGS));
    assert.equal(response.status, 409);
    assert.equal(await f.settingsStore.get(ownerAccount.address, id), null);
  });

  it("validates settings against the persisted native day cap and upserts the signed digest", async () => {
    const tooSmall = await fixture();
    const badId = "trade-settings-small";
    await seedTradeAgent(tooSmall, badId, 1n);
    const bad = await post(tooSmall.harness, `/agents/${badId}/trade/settings`,
      await signed("tradeSettings", badId, DEFAULT_TRADE_SETTINGS));
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: { code: string; message: string } }).error.code, "capital_too_small");

    const f = await fixture();
    const id = "trade-settings-ok";
    await seedTradeAgent(f, id);
    const response = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, DEFAULT_TRADE_SETTINGS));
    assert.equal(response.status, 200, response.text);
    const stored = await f.settingsStore.get(ownerAccount.address, id);
    assert.equal(stored?.digest, tradeSettingsDigest(DEFAULT_TRADE_SETTINGS));
    const immutable = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, { ...DEFAULT_TRADE_SETTINGS, name: "renamed after deploy" }));
    assert.equal(immutable.status, 400);
  });

  it("drains idempotently, fences settings and entries, and blocks revoke until every row is closed", async () => {
    const f = await fixture();
    const id = "trade-drain";
    await seedTradeAgent(f, id);
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    await f.positions.open({ positionId: "p1", agentId: id, ownerAddress: ownerAccount.address,
      token: TOKENS[0]!, route: { hops: [], fees: [] }, entryWei: 5n, tokenAmount: 9n,
      fillStatus: "verified", openedAt: NOW_SEC * 1_000 });

    const before = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(before.status, 409);
    const first = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
    assert.equal(first.status, 200, first.text);
    const drainingAt = (await f.settingsStore.get(ownerAccount.address, id))?.drainingAt;
    assert.equal(drainingAt, NOW_SEC * 1_000);
    assert.equal((await f.positions.get(ownerAccount.address, id, "p1"))?.exitRequestedAt, NOW_SEC * 1_000);
    const second = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
    assert.equal(second.status, 200, second.text);
    assert.equal((await f.settingsStore.get(ownerAccount.address, id))?.drainingAt, drainingAt);
    assert.equal((await f.settingsStore.withEntryFence(ownerAccount.address, id, async () => "entered")).kind, "draining");

    const settings = await post(f.harness, `/agents/${id}/trade/settings`,
      await signed("tradeSettings", id, DEFAULT_TRADE_SETTINGS));
    assert.equal(settings.status, 409);
    const stillOpen = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(stillOpen.status, 409);
    await f.positions.closePosition({ ownerAddress: ownerAccount.address, agentId: id, positionId: "p1",
      exitWei: 7n, soldTokenAmount: 9n, exitFillStatus: "verified", reason: "owner-request" });
    const removed = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
    assert.equal(removed.status, 200, removed.text);
  });

  it("binds tradeExit params to the route and mutates only exit_requested_at", async () => {
    const f = await fixture();
    const id = "trade-exit";
    await seedTradeAgent(f, id);
    const before = await f.positions.open({ positionId: "position-1", agentId: id,
      ownerAddress: ownerAccount.address, token: TOKENS[0]!, route: { hops: [], fees: [] },
      entryWei: 1n, tokenAmount: 2n, fillStatus: "verified", openedAt: NOW_SEC * 1_000 });
    const mismatch = await post(f.harness, `/agents/${id}/trade/positions/position-1/exit`,
      await signed("tradeExit", id, { positionId: "position-2" }));
    assert.equal(mismatch.status, 400);
    const response = await post(f.harness, `/agents/${id}/trade/positions/position-1/exit`,
      await signed("tradeExit", id, { positionId: "position-1" }));
    assert.equal(response.status, 200);
    const after = await f.positions.get(ownerAccount.address, id, "position-1");
    assert.deepEqual({ ...after, exitRequestedAt: before.exitRequestedAt }, before);
    assert.equal(after?.exitRequestedAt, NOW_SEC * 1_000);
  });

  it("keeps trade view owner-scoped and exposes the persisted trade discriminator on owner-view", async () => {
    const f = await fixture();
    const id = "trade-view-owner";
    await seedTradeAgent(f, id);
    const wrong = await signed("read", id, {}, OTHER_OWNER_PK);
    assert.equal((await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(wrong) } })).status, 404);
    const read = await signed("read", id, {});
    const owner = await call(f.harness, `/agents/${id}/owner-view`, { headers: { "x-owner-action": toReadHeader(read) } });
    assert.equal(owner.status, 200);
    const body = owner.body as { data: { httpRuntimeProfile: string; hireSizing: { name: string } } };
    assert.equal(body.data.httpRuntimeProfile, "unbound-v1");
    assert.equal(body.data.hireSizing.name, "trade-v1");
  });

  it("AUDIT M8/R2.7/L1: trade view's cmcLog filters out retired _GLOBAL rows (old crypto skill), a dossier row and a _PROBE row, keeping only the current skill set", async () => {
    const cmc: CmcBudgetStore = new MemoryTradeCmcStore(() => NOW_SEC * 1_000);
    const id = "trade-view-cmc-filter";
    const putNews = (ticker: string, skill: string) => cmc.putNews({ agentId: id, ownerAddress: ownerAccount.address, ticker, skill,
      generation: 0, status: "available", context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null,
      paymentOperationId: null, asOfMs: NOW_SEC * 1_000, expiresAtMs: NOW_SEC * 1_000 + 3_600_000 });
    // Retired: the old crypto-wide macro-events tool, the dossier, and a probe row (all still IN the store, never deleted).
    await putNews("_GLOBAL", "get_upcoming_macro_events");
    await putNews("NVDA", "us_equity_research_dossier");
    await putNews("_PROBE", "us_equity_sector_rotation");
    // Current: one of the five live skills.
    await putNews("_GLOBAL", CMC_SKILL_SECTOR);
    await putNews("_GLOBAL", CMC_GLOBAL_TOOL);
    const f = await fixture({ cmc });
    await seedTradeAgent(f, id);
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    const read = await signed("read", id, {});
    const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(read) } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = response.body as { data: { cmcLog?: { news: readonly { ticker: string; skill: string }[] } } };
    assert.ok(body.data.cmcLog, "the cmc store was supplied, so cmcLog must be present");
    const skills = body.data.cmcLog!.news.map((row) => `${row.ticker}/${row.skill}`).sort();
    assert.deepEqual(skills, [`_GLOBAL/${CMC_GLOBAL_TOOL}`, `_GLOBAL/${CMC_SKILL_SECTOR}`]);
    assert.ok(!skills.some((s) => s.includes("get_upcoming_macro_events")));
    assert.ok(!skills.some((s) => s.includes("us_equity_research_dossier")));
    assert.ok(!skills.some((s) => s.startsWith("_PROBE/")), "AUDIT L1: a _PROBE-ticker row must be filtered out by ticker too, not skill alone");
  });

  it("AUDIT L-7/R2.7: trade view's cmcLog passes through requestedBy/requestReason for an LLM-requested row, and null/absent for a scheduled row", async () => {
    const cmc: CmcBudgetStore = new MemoryTradeCmcStore(() => NOW_SEC * 1_000);
    const id = "trade-view-cmc-llm-label";
    await cmc.putNews({ agentId: id, ownerAddress: ownerAccount.address, ticker: "NVDA", skill: CMC_SKILL_PLANNING,
      generation: 0, status: "available", context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null,
      paymentOperationId: null, asOfMs: NOW_SEC * 1_000, expiresAtMs: NOW_SEC * 1_000 + 3_600_000,
      requestedBy: "llm", requestReason: "NVDA line reads unknown" });
    await cmc.putNews({ agentId: id, ownerAddress: ownerAccount.address, ticker: "MSFT", skill: CMC_SKILL_PLANNING,
      generation: 0, status: "available", context: "{}", sourceUrl: null, publishedAtMs: null, payloadHash: null,
      paymentOperationId: null, asOfMs: NOW_SEC * 1_000, expiresAtMs: NOW_SEC * 1_000 + 3_600_000 });
    const f = await fixture({ cmc });
    await seedTradeAgent(f, id);
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    const read = await signed("read", id, {});
    const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(read) } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = response.body as { data: { cmcLog?: { news: readonly { ticker: string; requestedBy?: string | null; requestReason?: string | null }[] } } };
    const nvda = body.data.cmcLog!.news.find((row) => row.ticker === "NVDA");
    const msft = body.data.cmcLog!.news.find((row) => row.ticker === "MSFT");
    assert.equal(nvda?.requestedBy, "llm");
    assert.equal(nvda?.requestReason, "NVDA line reads unknown");
    assert.ok(msft?.requestedBy === null || msft?.requestedBy === undefined, `expected a scheduled row's requestedBy to be null/absent, got ${JSON.stringify(msft?.requestedBy)}`);
  });

  it("Trading detail reuses the account bearer without granting cross-owner or write access", async () => {
    const f = await fixture();
    const id = "trade-bearer-view";
    await seedTradeAgent(f, id);
    await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address,
      params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) });
    await f.positions.open({ positionId: "filled", agentId: id, ownerAddress: ownerAccount.address,
      token: TOKENS[0]!, route: { hops: [], fees: [] }, entryWei: 5n, tokenAmount: 10n,
      fillStatus: "verified", openedAt: NOW_SEC * 1_000 });
    const issue = async (pk?: Hex) => {
      const envelope = await signOwnerAction("createAccountReadSession", {}, {
        agentId: "*", chainId: 56, network: "mainnet", ...(pk === undefined ? {} : { pk }) });
      const response = await post(f.harness, "/owner-read-session", envelope);
      assert.equal(response.status, 200);
      return (response.body["data"] as { token: string }).token;
    };
    const token = await issue();
    const headers = { authorization: `Bearer ${token}` };
    const path = `/agents/${id}/trade/view`;
    const response = await call(f.harness, path, { headers });
    assert.equal(response.status, 200);
    const data = response.body["data"] as { open: readonly unknown[]; settings: { executionModel: string } };
    assert.equal(data.open.length, 1);
    assert.equal(data.settings.executionModel, DEFAULT_TRADE_SETTINGS.executionModel);
    assert.equal((await call(f.harness, path)).status, 401);
    assert.equal((await call(f.harness, path, { headers: { authorization: "Bearer invalid" } })).status, 401);
    assert.equal((await call(f.harness, path, { headers: { ...headers,
      "x-owner-action": toReadHeader(await signed("read", id, {})) } })).status, 401);
    assert.equal((await call(f.harness, path, { headers: { authorization: `Bearer ${await issue(OTHER_OWNER_PK)}` } })).status, 404);
    for (const suffix of ["trade/settings", "trade/drain", "trade/positions/filled/exit", "pause", "trade"]) {
      const response = await call(f.harness, `/agents/${id}/${suffix}`, { method: "POST", body: {}, headers });
      assert.notEqual(response.status, 200, suffix);
    }
    assert.equal(f.harness.provider.executeCalls.length, 0);
  });

  it("returns trade_not_ready from all four trade owner routes", async () => {
    const f = await fixture({ ready: false });
    for (const [method, path] of [["POST", "/agents/a/trade/settings"], ["POST", "/agents/a/trade/drain"], ["POST", "/agents/a/trade/positions/p/exit"], ["GET", "/agents/a/trade/view"]] as const) {
      const response = await call(f.harness, path, { method });
      assert.equal(response.status, 503);
      assert.equal((response.body as { error: { code: string } }).error.code, "trade_not_ready");
    }
  });

  it("SIMTAB simulation log is an owner read like trade view: 401 unauthenticated, 404 other owner, 200 rows, store-unavailable without a store", async () => {
    const simulations = new MemoryTradeSimulationStore();
    const id = "trade-simulations-owner";
    await simulations.insertSimulation({ idempotencyKey: `0x${"11".repeat(32)}`, agentId: id, ownerAddress: ownerAccount.address, journalKind: "trade",
      exposure: "reduce", route: "guard", outcome: "success", reason: null, blocked: false, bareRevert: false, failReason: null, latencyMs: 120, upstreamMs: 100,
      outputToken: USDT_56, predictionKind: "swap-output", minOutAtomic: 1n, predictedOutAtomic: 10n, createdAtMs: NOW_SEC * 1_000 });
    const f = await fixture({ simulations });
    await seedTradeAgent(f, id);
    const path = `/agents/${id}/trade/simulations`;
    assert.equal((await call(f.harness, path)).status, 401);
    assert.equal((await call(f.harness, path, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {}, OTHER_OWNER_PK)) } })).status, 404);
    const ok = await call(f.harness, path, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const data = ok.body["data"] as { rows: readonly { predictedOutAtomic: string; exposure: string }[]; unavailable: string | null };
    assert.equal(data.unavailable, null); assert.equal(data.rows.length, 1); assert.equal(data.rows[0]?.predictedOutAtomic, "10");
    const bare = await fixture();
    await seedTradeAgent(bare, id);
    const none = await call(bare.harness, path, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
    assert.equal(none.status, 200);
    assert.deepEqual(none.body["data"], { rows: [], unavailable: "store-unavailable" });
    const notReady = await call((await fixture({ ready: false, simulations })).harness, path);
    assert.equal(notReady.status, 503);
  });
});

describe("TradFi schedule buy routes", () => {
  const E = 10n ** 18n;
  const SCHEDULE_TOKEN = TOKENS[0]!;
  const NO_VENUE_TOKEN = TOKENS[1]!;
  const THROWS_TOKEN = TOKENS[2]!;
  const ONDO_TOKEN = TOKENS[3]!;
  const FILLER_A = TOKENS[4]!;
  const FILLER_B = TOKENS[5]!;
  const SCHEDULE_RELAY_FEE_WEI = 100_000_000_000_000n; // RELAY_FEE_PER_EXIT_WEI
  // R2.1 + the exit reserve: the schedule reserve for scheduleSettings()'s defaults (hourly, budget end,
  // 10 USDT/buy, 1000 USDT budget) is (min(plannedBuys=100, buysThisSession=166) + 2) * R (A1/A3 — the
  // reserve is ONE token, never the chain-granted count) — a real cap, not an inflated "1 BNB" that
  // hides BLOCKER-1.
  const SCHEDULE_CAP_DAY_WEI = 102n * SCHEDULE_RELAY_FEE_WEI;

  function scheduleVenue(overrides: Partial<VenueRow> = {}): VenueRow {
    return { dex: "pancakeswap", version: "v2", pool: getAddress("0x4400000000000000000000000000000000004400"),
      feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 10, liquidityUsd: 50_000, volume24hUsd: 1,
      asOf: NOW_SEC * 1_000, ...overrides };
  }

  function scheduleRwaFact(ticker: string, venues: readonly VenueRow[]): RwaFact {
    return { platform: "bstock", underlyingTicker: ticker, tokenPriceUsd: 10, referencePriceUsd: 10, premiumBps: 0,
      openState: true, marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
      onchainPriceUsd: 10, venues };
  }

  function scheduleQuoteFor(token: Address): TradfiQuote {
    return { venue: "pancake_v2", router: ROUTER_V2, route: { hops: [], fees: [] }, settlementToken: USDT_56, token,
      amountInAtomic: 10n * E, quotedOutAtomic: 10n * E, minOutAtomic: 9n * E, observedAt: NOW_SEC * 1_000, expiresAt: NOW_SEC * 1_000 + 30_000 };
  }

  function scheduleSettings(overrides: Partial<TradeSettings> = {}): TradeSettings {
    return { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", entryWei: (10n * E).toString(10), maxOpenPositions: 1,
      takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, noReentry: false,
      settlementAsset: "USDT", minEntryWei: (10n * E).toString(10), capitalQuoteWei: (1_000n * E).toString(10), cmcNewsEnabled: false,
      tradeMode: "schedule", scheduleToken: SCHEDULE_TOKEN.toLowerCase(), scheduleIntervalSec: 3_600,
      scheduleFirstAtSec: null, scheduleEndKind: "budget", scheduleEndAtSec: null, scheduleEndRuns: null,
      scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150, ...overrides };
  }

  let universeReads: number;
  let buyAmounts: bigint[] = [];

  function scheduleFixture(options: { readonly buyThrows?: boolean; readonly ready?: boolean;
    readonly binanceQuoteAndSwap?: TradeDataPlaneReads["binanceQuoteAndSwap"];
    readonly guardVerified?: (guard: Address) => Promise<boolean>; readonly aggregatorGuard?: Address;
    readonly schedulableWarm?: { readonly amountWei: bigint; readonly slippageBps: number };
    readonly tradfiV2CapabilityProbe?: (input: { readonly candidate: PinnedCandidate; readonly minEntryAtomic: bigint;
      readonly slippageBps: number; readonly signal?: AbortSignal }) => Promise<TradfiCapabilityProbeResult> } = {}) {
    buyAmounts = [];
    universeReads = 0;
    const dataPlane: TradeDataPlaneReads = {
      async universe(lane) {
        universeReads += 1;
        if (lane === "bstocks") return [
          { address: SCHEDULE_TOKEN, symbol: "AAAX", lane: "bstocks", source: "fixture",
            rwa: scheduleRwaFact("AAA", [scheduleVenue()]), venues: [scheduleVenue()] },
          { address: NO_VENUE_TOKEN, symbol: "BBBX", lane: "bstocks", source: "fixture",
            rwa: scheduleRwaFact("BBB", []), venues: [] },
          { address: THROWS_TOKEN, symbol: "CCCX", lane: "bstocks", source: "fixture",
            rwa: scheduleRwaFact("CCC", [scheduleVenue()]), venues: [scheduleVenue()] },
          // Filler so the pin clears MIN_PIN (5); neither is the token under test.
          { address: FILLER_A, symbol: "EEEX", lane: "bstocks", source: "fixture",
            rwa: scheduleRwaFact("EEE", [scheduleVenue()]), venues: [scheduleVenue()] },
          { address: FILLER_B, symbol: "FFFX", lane: "bstocks", source: "fixture",
            rwa: scheduleRwaFact("FFF", [scheduleVenue()]), venues: [scheduleVenue()] },
        ];
        if (lane === "ondo") return [{ address: ONDO_TOKEN, symbol: "DDDX", lane: "ondo", source: "fixture",
          rwa: scheduleRwaFact("DDD", [scheduleVenue()]), venues: [scheduleVenue()] }];
        return [];
      },
      async tokensBatch(addresses) { return addresses.map((address, index) => ({ address, symbol: `T${index}`,
        priceUsd: 10, marketCapUsd: 2_000_000, volume24hUsd: 10_000, holders: 100, priceChange24hPct: 1 })); },
      async eligibilityBatch() { return []; },
      async security() { return { data: {}, meta: {} }; },
      ...(options.binanceQuoteAndSwap === undefined ? {} : { binanceQuoteAndSwap: options.binanceQuoteAndSwap }),
    };
    return fixture({
      ...(options.ready === undefined ? {} : { ready: options.ready }),
      dataPlane,
      scheduleQuotes: {
        buy: async (input) => { buyAmounts.push(input.amountInAtomic); if (options.buyThrows === true && input.token.toLowerCase() === THROWS_TOKEN.toLowerCase()) throw new Error("no route"); return scheduleQuoteFor(input.token); },
        sell: async (input) => scheduleQuoteFor(input.token),
      },
      ...(options.guardVerified === undefined ? {} : { guardVerified: options.guardVerified }),
      ...(options.aggregatorGuard === undefined ? {} : { aggregatorGuard: options.aggregatorGuard }),
      ...(options.schedulableWarm === undefined ? {} : { schedulableWarm: options.schedulableWarm }),
      ...(options.tradfiV2CapabilityProbe === undefined ? {} : { tradfiV2CapabilityProbe: options.tradfiV2CapabilityProbe }),
    });
  }

  it("hire preview with schedule params reports tradeMode, plannedBuys, buysThisSession and nativeReserveWei", async () => {
    const f = await scheduleFixture();
    const query = new URLSearchParams({
      walletAddress: WALLET, capDayWei: SCHEDULE_CAP_DAY_WEI.toString(10), sizingPreset: "trade-v1",
      executionModel: "tradfi", entryWei: (10n * E).toString(10), maxOpenPositions: "1",
      settlementAsset: "USDT", minEntryWei: (10n * E).toString(10), capitalQuoteWei: (1_000n * E).toString(10),
      cmcNewsEnabled: "false", tradeMode: "schedule", scheduleIntervalSec: "3600", scheduleEndKind: "runs", scheduleEndRuns: "5",
    });
    const response = await f.harness.app.request(`/agents/hire/preview?${query}`, { headers: { "x-exec-token": EXEC_TOKEN } });
    const body = await response.json() as { data: { sizing: { tradeMode?: string; plannedBuys?: number; buysThisSession?: number; nativeReserveWei?: string; ok: boolean } } };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.sizing.tradeMode, "schedule");
    assert.equal(body.data.sizing.plannedBuys, 5);
    assert.equal(typeof body.data.sizing.buysThisSession, "number");
    assert.equal(typeof body.data.sizing.nativeReserveWei, "string");
  });

  it("AUDIT M20/G2: a schedule-mode preview pin never contains the Ondo-lane row", async () => {
    const f = await scheduleFixture();
    const query = new URLSearchParams({
      walletAddress: WALLET, capDayWei: SCHEDULE_CAP_DAY_WEI.toString(10), sizingPreset: "trade-v1",
      executionModel: "tradfi", entryWei: (10n * E).toString(10), maxOpenPositions: "1",
      settlementAsset: "USDT", minEntryWei: (10n * E).toString(10), capitalQuoteWei: (1_000n * E).toString(10),
      cmcNewsEnabled: "false", tradeMode: "schedule", scheduleIntervalSec: "3600", scheduleEndKind: "runs", scheduleEndRuns: "5",
    });
    const response = await f.harness.app.request(`/agents/hire/preview?${query}`, { headers: { "x-exec-token": EXEC_TOKEN } });
    const body = await response.json() as { data: { pin?: readonly { address: string }[] } };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.data.pin !== undefined && body.data.pin.length > 0, "the preview must return a pin");
    assert.ok(!body.data.pin.some((row) => row.address.toLowerCase() === ONDO_TOKEN.toLowerCase()),
      "a schedule-mode pin must never contain the Ondo-lane row (G2) — server.ts must pass lanes: [\"bstocks\"]");
  });

  it("refuses an invalid schedulable query with 400", async () => {
    const f = await scheduleFixture();
    const response = await call(f.harness, "/agents/hire/schedulable?amountWei=0&slippageBps=1");
    assert.equal(response.status, 400);
  });

  it("pre-warms the configured schedulable key at boot so the first listing is served from cache", async () => {
    const f = await scheduleFixture({ schedulableWarm: { amountWei: 5n * E, slippageBps: 100 } });
    // The warm sweep runs on boot without any request; wait for its quotes to land.
    for (let i = 0; i < 50 && buyAmounts.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(buyAmounts.length > 0, "the boot warm-up quoted nothing");
    assert.ok(buyAmounts.every((amount) => amount === 5n * E));
    const readsAfterWarm = universeReads;
    const quotesAfterWarm = buyAmounts.length;
    const response = await call(f.harness, `/agents/hire/schedulable?amountWei=${(5n * E).toString(10)}&slippageBps=100`);
    const body = response.body as { data: { tokens: readonly { address: string }[] } };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.data.tokens.length > 0);
    assert.equal(universeReads, readsAfterWarm, "the warmed key re-read the universe");
    assert.equal(buyAmounts.length, quotesAfterWarm, "the warmed key re-quoted");
  });

  it("not-ready is refused 503 even for an invalid query (readiness gates first)", async () => {
    const f = await fixture({ ready: false });
    const response = await call(f.harness, "/agents/hire/schedulable?amountWei=0&slippageBps=1");
    assert.equal(response.status, 503);
    assert.equal((response.body as { error: { code: string } }).error.code, "trade_not_ready");
  });

  it("returns trade_not_ready when the plane has no schedule quote seam", async () => {
    const f = await fixture();
    const response = await call(f.harness, "/agents/hire/schedulable?amountWei=10000000000000000000&slippageBps=300");
    assert.equal(response.status, 503);
    assert.equal((response.body as { error: { code: string } }).error.code, "trade_not_ready");
  });

  it("lists only the bstock with an admitted venue, drops Ondo and a throwing quote, and caches 30s", async () => {
    const f = await scheduleFixture({ buyThrows: true });
    const query = `amountWei=${(10n * E).toString(10)}&slippageBps=300`;
    const first = await call(f.harness, `/agents/hire/schedulable?${query}`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const tokens = (first.body as { data: { tokens: readonly { address: string }[] } }).data.tokens;
    // Admitted-venue bstocks quote through; the venue-less token and the one whose
    // quote throws are both dropped, and the Ondo-lane row never entered the list.
    assert.deepEqual(new Set(tokens.map((t) => t.address.toLowerCase())),
      new Set([SCHEDULE_TOKEN.toLowerCase(), FILLER_A.toLowerCase(), FILLER_B.toLowerCase()]));
    assert.ok(!tokens.some((t) => t.address.toLowerCase() === NO_VENUE_TOKEN.toLowerCase()));
    assert.ok(!tokens.some((t) => t.address.toLowerCase() === THROWS_TOKEN.toLowerCase()));
    assert.ok(!tokens.some((t) => t.address.toLowerCase() === ONDO_TOKEN.toLowerCase()));
    const readsAfterFirst = universeReads;
    assert.ok(readsAfterFirst > 0);
    const second = await call(f.harness, `/agents/hire/schedulable?${query}`);
    assert.equal(second.status, 200);
    assert.equal(universeReads, readsAfterFirst, "a cache hit inside 30s must not re-read the universe");
  });

  it("R2.7 (LOW-4): the aggregator branch drops a wrong-taker Flash quote and lists a correct-taker one", async () => {
    const guard = getAddress(`0x${(900).toString(16).padStart(40, "0")}`);
    const wrongTaker = getAddress(`0x${(901).toString(16).padStart(40, "0")}`);
    // schedulableTokens has no injectable clock (unlike the rest of this harness, which runs
    // on the fixed NOW_SEC): its freshness check reads the real wall clock, so this quote's
    // timestamps must be real Date.now(), not NOW_SEC.
    const flashQuoteFor = (taker: Address): TradfiFlashQuote => ({
      version: "tradfi-binance-flash-v1", chainId: 56, taker, tokenIn: USDT_56, tokenOut: NO_VENUE_TOKEN,
      amountInAtomic: (10n * E).toString(10), quotedOutAtomic: (10n * E).toString(10), minOutAtomic: (9n * E).toString(10),
      router: ROUTER_V2, spender: ROUTER_V2, calldata: "0xad43f73d", value: "0",
      observedAt: Date.now(), expiresAt: Date.now() + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
      feeAmountAtomic: "0", feeToken: null,
    });
    const query = `amountWei=${(10n * E).toString(10)}&slippageBps=300`;

    // NO_VENUE_TOKEN has no admitted direct venue, so it is aggregator-only; a wrong taker
    // must not list it even though the guard is verified and every other field is fresh.
    const wrong = await scheduleFixture({ aggregatorGuard: guard, guardVerified: async () => true,
      binanceQuoteAndSwap: async () => flashQuoteFor(wrongTaker) });
    const wrongResponse = await call(wrong.harness, `/agents/hire/schedulable?${query}`);
    assert.equal(wrongResponse.status, 200, JSON.stringify(wrongResponse.body));
    const wrongTokens = (wrongResponse.body as { data: { tokens: readonly { address: string }[] } }).data.tokens;
    assert.ok(!wrongTokens.some((t) => t.address.toLowerCase() === NO_VENUE_TOKEN.toLowerCase()));

    // The same quote, correct taker: NO_VENUE_TOKEN is now listed via the aggregator.
    const right = await scheduleFixture({ aggregatorGuard: guard, guardVerified: async () => true,
      binanceQuoteAndSwap: async () => flashQuoteFor(guard) });
    const rightResponse = await call(right.harness, `/agents/hire/schedulable?${query}`);
    assert.equal(rightResponse.status, 200, JSON.stringify(rightResponse.body));
    const rightTokens = (rightResponse.body as { data: { tokens: readonly { address: string; venue: string }[] } }).data.tokens;
    const listed = rightTokens.find((t) => t.address.toLowerCase() === NO_VENUE_TOKEN.toLowerCase());
    assert.equal(listed?.venue, "binance");
  });

  function scheduleHireParams(overrides: Partial<TradeSettings> = {}) {
    const settings = scheduleSettings(overrides);
    return { walletAddress: WALLET, capDayWei: SCHEDULE_CAP_DAY_WEI.toString(10), ttlSec: 604_800,
      sizingPreset: "trade-v1", executionModel: "tradfi", hireRunId: "22222222-2222-4222-8222-222222222222",
      autoGrant: true, settings };
  }

  describe("schedule provisioning", () => {
    it("refuses a scheduleToken the pin never granted", async () => {
      const f = await scheduleFixture();
      const params = scheduleHireParams({ scheduleToken: getAddress("0x9999999999999999999999999999999999999999").toLowerCase() });
      const response = await post(f.harness, "/agents/not-granted/session", await signed("provisionAgent", "not-granted", params));
      assert.equal(response.status, 400, response.text);
      assert.equal((response.body as { error: { code: string } }).error.code, "schedule_token_not_granted");
    });

    it("refuses a granted token that does not quote at the signed amount (no admitted venue)", async () => {
      const f = await scheduleFixture();
      const params = scheduleHireParams({ scheduleToken: NO_VENUE_TOKEN.toLowerCase(), minEntryWei: (10n * E).toString(10) });
      const response = await post(f.harness, "/agents/unquotable/session", await signed("provisionAgent", "unquotable", params));
      assert.equal(response.status, 400, response.text);
      assert.equal((response.body as { error: { code: string } }).error.code, "schedule_token_unquotable");
    });

    it("refuses a first buy outside the 7-day session window", async () => {
      const f = await scheduleFixture();
      const params = scheduleHireParams({ scheduleFirstAtSec: NOW_SEC + 604_800 });
      const response = await post(f.harness, "/agents/first-oos/session", await signed("provisionAgent", "first-oos", params));
      assert.equal(response.status, 400, response.text);
      assert.equal((response.body as { error: { code: string } }).error.code, "schedule_first_buy_out_of_session");
    });

    it("refuses an end date already in the past", async () => {
      const f = await scheduleFixture();
      const params = scheduleHireParams({ scheduleEndKind: "date", scheduleEndAtSec: NOW_SEC - 1 });
      const response = await post(f.harness, "/agents/end-past/session", await signed("provisionAgent", "end-past", params));
      assert.equal(response.status, 400, response.text);
      assert.equal((response.body as { error: { code: string } }).error.code, "schedule_end_in_past");
    });

    it("grants the normal pinned list, not just the one scheduled token", async () => {
      const f = await scheduleFixture();
      const id = "schedule-happy";
      const params = scheduleHireParams();
      const response = await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params));
      assert.equal(response.status, 200, response.text);
      const row = await f.store.getAgentById(id);
      assert.equal(row?.status, "provisioning");
      assert.equal(row?.pendingGrant?.sizing.sizingPreset, "trade-v1");
      const grantedTokens = (row?.pendingGrant?.permissions.calls ?? [])
        .flatMap((rule) => "to" in rule && rule.to !== undefined ? [rule.to.toLowerCase()] : []);
      // The grant is the full capable pin (SCHEDULE_TOKEN + THROWS_TOKEN both quote directly), not one token.
      assert.ok(grantedTokens.includes(SCHEDULE_TOKEN.toLowerCase()));
      assert.ok(grantedTokens.includes(THROWS_TOKEN.toLowerCase()));
    });

    it("G3/G4/R2.3 (H2): grants a pool-less token sorted past position 28, with at most 28 tokens granted", async () => {
      const GUARD = getAddress("0x5555555555555555555555555555555555555555");
      // 29 priced bStocks (admitted venue, descending liquidity, distinct
      // tickers) plus one pool-less bStock — sorted last under `tradfiCompare`
      // (liquidity 0), so it never reaches a pre-G3 slice(0, 28) probe.
      const priced = Array.from({ length: 29 }, (_, i) => {
        const address = getAddress(`0x${(0x7000 + i).toString(16).padStart(40, "0")}`);
        return { address, symbol: `P${i}X`, lane: "bstocks" as const, source: "fixture" as const,
          rwa: scheduleRwaFact(`PRICED${i}`, [scheduleVenue({ liquidityUsd: 100_000 - i })]), venues: [scheduleVenue({ liquidityUsd: 100_000 - i })] };
      });
      const POOLLESS = getAddress("0x9000000000000000000000000000000000009000");
      const poolLess = { address: POOLLESS, symbol: "POOLX", lane: "bstocks" as const, source: "fixture" as const,
        rwa: scheduleRwaFact("POOLLESS", []), venues: [] };
      const dataPlane: TradeDataPlaneReads = {
        async universe(lane) { return lane === "bstocks" ? [...priced, poolLess] : []; },
        async tokensBatch(addresses) { return addresses.map((address, index) => ({ address, symbol: `T${index}`,
          priceUsd: 10, marketCapUsd: 2_000_000, volume24hUsd: 10_000, holders: 100, priceChange24hPct: 1 })); },
        async eligibilityBatch() { return []; },
        async security() { return { data: {}, meta: {} }; },
        async binanceQuoteAndSwap(request) {
          return { version: "tradfi-binance-flash-v1", chainId: 56, taker: GUARD, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
            amountInAtomic: request.amountAtomic, quotedOutAtomic: (10n * E).toString(10), minOutAtomic: (9n * E).toString(10),
            router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d", value: "0",
            observedAt: Date.now(), expiresAt: Date.now() + 30_000, estimatedGasUnits: "100000", gasPriceWei: "1000000000",
            feeAmountAtomic: "0", feeToken: null };
        },
      };
      const f = await fixture({ dataPlane, aggregatorGuard: GUARD, guardVerified: async () => true,
        scheduleQuotes: { buy: async (input) => scheduleQuoteFor(input.token), sell: async (input) => scheduleQuoteFor(input.token) } });
      const id = "schedule-poolless";
      const params = scheduleHireParams({ scheduleToken: POOLLESS.toLowerCase(), minEntryWei: (10n * E).toString(10) });
      const response = await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params));
      assert.equal(response.status, 200, response.text);
      const row = await f.store.getAgentById(id);
      // Only APPROVE_SELECTOR rules are per-token grants; the venue router
      // rules (pancakeRouterV2/V3) and the v2 USDT quote-token approve are
      // fixed and not part of `grantedTokenCount` (H2's own definition).
      const grantedTokens = (row?.pendingGrant?.permissions.calls ?? [])
        .flatMap((rule) => "to" in rule && rule.to !== undefined && "signature" in rule && rule.signature === APPROVE_SELECTOR
          ? [rule.to.toLowerCase()] : [])
        .filter((token) => token !== USDT_56.toLowerCase());
      assert.ok(grantedTokens.includes(POOLLESS.toLowerCase()), "the chosen pool-less token must be granted");
      assert.ok(grantedTokens.length <= 28, `at most 28 tokens may be granted (H2); got ${grantedTokens.length}`);
    });
  });

  describe("schedule agent owner routes", () => {
    async function seedScheduleAgent(f: Awaited<ReturnType<typeof scheduleFixture>>, id: string, overrides: Partial<TradeSettings> = {},
      seedOptions: { readonly capDayWei?: bigint; readonly expired?: boolean } = {}) {
      const expiresAt = seedOptions.expired === true ? NOW_SEC - 1 : NOW_SEC + 604_800;
      // Mirrors the [F5] renewal fixture: expiresAt must be in the future relative to the spec's
      // OWN construction-time nowSeconds, even though it is already past the harness's real NOW_SEC.
      const specNowSeconds = seedOptions.expired === true ? NOW_SEC - 3_600 : NOW_SEC;
      const spec = tradeSessionSpec({ venues: f.venues, tokens: [{ token: SCHEDULE_TOKEN }, { token: THROWS_TOKEN }],
        nativeCaps: [{ limit: seedOptions.capDayWei ?? SCHEDULE_CAP_DAY_WEI, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 1_000n * E,
        quotePerTradeCapWei: 10n * E, platformFeeBps: 0, expiresAt, nowSeconds: specNowSeconds });
      await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey",
        status: "armed", httpRuntimeProfile: "trade-v1",
        sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY,
          expiry: expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
      const settings = scheduleSettings(overrides);
      await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });
      return settings;
    }

    it("refuses drain and position exit for a schedule agent with schedule_no_sell", async () => {
      const f = await scheduleFixture();
      const id = "schedule-no-sell";
      await seedScheduleAgent(f, id);
      const drain = await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}));
      assert.equal(drain.status, 409, drain.text);
      assert.equal((drain.body as { error: { code: string } }).error.code, "schedule_no_sell");
      await f.positions.open({ positionId: "fill-1", agentId: id, ownerAddress: ownerAccount.address, token: SCHEDULE_TOKEN,
        route: { hops: [], fees: [] }, entryWei: 10n * E, tokenAmount: 10n * E, fillStatus: "verified", openedAt: NOW_SEC * 1_000 });
      const exit = await post(f.harness, `/agents/${id}/trade/positions/fill-1/exit`, await signed("tradeExit", id, { positionId: "fill-1" }));
      assert.equal(exit.status, 409, exit.text);
      assert.equal((exit.body as { error: { code: string } }).error.code, "schedule_no_sell");
    });

    it("revokes a schedule agent without a drain and with its fills still open, but not while a buy is settling", async () => {
      const f = await scheduleFixture();
      const id = "schedule-revoke";
      await seedScheduleAgent(f, id);
      await f.positions.open({ positionId: "fill-1", agentId: id, ownerAddress: ownerAccount.address, token: SCHEDULE_TOKEN,
        route: { hops: [], fees: [] }, entryWei: 10n * E, tokenAmount: 10n * E, fillStatus: "verified", openedAt: NOW_SEC * 1_000 });
      await f.intents.create({ decisionId: "buy-in-flight", idempotencyKey: `0x${"45".repeat(32)}` as Hex, agentId: id, ownerAddress: ownerAccount.address,
        side: "buy", token: SCHEDULE_TOKEN, route: { hops: [], fees: [] }, amountWei: 10n * E, entryWei: 10n * E, positionId: "buy-in-flight",
        closeReason: null, settlementAsset: "USDT", scheduleSlot: 1 });
      const settling = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
      assert.equal(settling.status, 409, settling.text);
      await f.intents.markRolledBack(ownerAccount.address, id, "buy-in-flight", "test");
      const revoked = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, {}));
      assert.equal(revoked.status, 200, revoked.text);
      const positions = await f.positions.list(ownerAccount.address, id);
      assert.ok(positions.some((position) => position.positionId === "fill-1" && position.status !== "closed"), "the fill stays open as a holding");
    });

    it("view carries the schedule block, a holding quote reason on failure, and never calls the position observer", async () => {
      const f = await scheduleFixture();
      const id = "schedule-view";
      await seedScheduleAgent(f, id);
      await f.positions.open({ positionId: "fill-1", agentId: id, ownerAddress: ownerAccount.address, token: SCHEDULE_TOKEN,
        route: { hops: [], fees: [] }, entryWei: 10n * E, tokenAmount: 10n * E, fillStatus: "verified", openedAt: NOW_SEC * 1_000 });
      // Joined onto the fill by positionId, mirroring the worker's own fence guard read.
      await f.intents.create({ decisionId: "fill-1-intent", idempotencyKey: `0x${"46".repeat(32)}` as Hex, agentId: id, ownerAddress: ownerAccount.address,
        side: "buy", token: SCHEDULE_TOKEN, route: { hops: [], fees: [] }, amountWei: 10n * E, entryWei: 10n * E, positionId: "fill-1",
        closeReason: null, settlementAsset: "USDT", scheduleSlot: 3 });
      // No wallet balance seeded: the schedule view's holding quote must dash with a reason, not throw.
      const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(response.status, 200, response.text);
      const body = (response.body as { data: {
        schedule?: { token: string; holding: { quoteWei: string | null; quoteReason: string | null }; premiumBps: number | null; premiumLimitBps: number };
        open: readonly { positionId: string; scheduleSlot?: number | null }[];
      } }).data;
      assert.ok(body.schedule);
      assert.equal(body.schedule?.token.toLowerCase(), SCHEDULE_TOKEN.toLowerCase());
      assert.equal(body.schedule?.holding.quoteWei, null);
      assert.equal(body.schedule?.holding.quoteReason, "balance-zero");
      assert.equal(f.observeCalls.count, 0, "the schedule view must not call the per-position observer");
      // The fixture's bstocks row for SCHEDULE_TOKEN prices the venue at NAV (10 / 10 = 0 bps),
      // computed exactly as the worker's own schedule gate does (readRwaLaneSnapshot + rwaPremiumBps).
      assert.equal(body.schedule?.premiumBps, 0);
      assert.equal(body.schedule?.premiumLimitBps, 150);
      const fill = body.open.find((position) => position.positionId === "fill-1");
      assert.equal(fill?.scheduleSlot, 3);
    });

    it("B2: view exposes the native meter/balance/session fields, and nulls them on a failed read", async () => {
      const f = await scheduleFixture();
      const id = "schedule-view-native";
      await seedScheduleAgent(f, id);
      const R = SCHEDULE_RELAY_FEE_WEI;
      f.harness.provider.nativeDayMeterResult = { kind: "day", limitWei: 100n * R, currentSpentWei: 40n * R, grantedTokenCount: 29 };
      f.harness.provider.getBalance = async () => 7n * R;
      const ok = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(ok.status, 200, ok.text);
      const okBody = (ok.body as { data: { schedule?: { nativeCapWei: string | null; nativeSpentWei: string | null;
        nativeBalanceWei: string | null; nativeBuysRefused: boolean | null; sessionExpiresAtSec: number | null } } }).data;
      assert.equal(okBody.schedule?.nativeCapWei, (100n * R).toString(10));
      assert.equal(okBody.schedule?.nativeSpentWei, (40n * R).toString(10));
      assert.equal(okBody.schedule?.nativeBalanceWei, (7n * R).toString(10));
      // grantedTokenCount 29 on chain, but the A1 override reserves ONE token:
      // remaining 60R clears ownFee(R) + reserve(1R), so buys are not refused.
      assert.equal(okBody.schedule?.nativeBuysRefused, false);
      assert.ok(typeof okBody.schedule?.sessionExpiresAtSec === "number");

      f.harness.provider.nativeDayMeterError = new Error("rpc down");
      f.harness.provider.getBalance = async () => { throw new Error("rpc down"); };
      const failed = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(failed.status, 200, failed.text);
      const failedBody = (failed.body as { data: { schedule?: { nativeCapWei: string | null; nativeSpentWei: string | null;
        nativeBalanceWei: string | null; nativeBuysRefused: boolean | null } } }).data;
      assert.equal(failedBody.schedule?.nativeCapWei, null);
      assert.equal(failedBody.schedule?.nativeSpentWei, null);
      assert.equal(failedBody.schedule?.nativeBalanceWei, null);
      assert.equal(failedBody.schedule?.nativeBuysRefused, null);
    });

    it("view's schedule premium is null when the bstocks lane has no row for the scheduled token", async () => {
      const f = await scheduleFixture();
      const id = "schedule-view-no-row";
      const missingToken = getAddress("0x9999999999999999999999999999999999999999");
      await seedScheduleAgent(f, id, { scheduleToken: missingToken.toLowerCase() });
      const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(response.status, 200, response.text);
      const body = (response.body as { data: { schedule?: { premiumBps: number | null } } }).data;
      assert.ok(body.schedule);
      assert.equal(body.schedule?.premiumBps, null);
    });

    it("HTTP settings edit: an editable key is accepted, an immutable key is refused, a past end date is refused", async () => {
      const f = await scheduleFixture();
      const id = "schedule-edit";
      const settings = await seedScheduleAgent(f, id);
      const editable = await post(f.harness, `/agents/${id}/trade/settings`,
        await signed("tradeSettings", id, { ...settings, scheduleMarketHoursOnly: !settings.scheduleMarketHoursOnly }));
      assert.equal(editable.status, 200, editable.text);
      // R2.13: a faster cadence is an edit, not a re-grant — the signed cap stays and the day
      // meter bounds it at execution; the edit must not be refused on the BNB side.
      const faster = await post(f.harness, `/agents/${id}/trade/settings`,
        await signed("tradeSettings", id, { ...settings, scheduleIntervalSec: 3600 as const }));
      assert.equal(faster.status, 200, faster.text);
      const immutable = await post(f.harness, `/agents/${id}/trade/settings`,
        await signed("tradeSettings", id, { ...settings, scheduleToken: THROWS_TOKEN.toLowerCase() }));
      assert.equal(immutable.status, 400, immutable.text);
      const pastEnd = await post(f.harness, `/agents/${id}/trade/settings`,
        await signed("tradeSettings", id, { ...settings, scheduleEndKind: "date" as const, scheduleEndAtSec: NOW_SEC - 1, scheduleEndRuns: null }));
      assert.equal(pastEnd.status, 400, pastEnd.text);
      assert.equal((pastEnd.body as { error: { code?: string; message?: string } }).error.message, "schedule_end_in_past");
    });

    it("R2.2: renewal preview is eligible when the kept native day cap equals the schedule reserve, not the v2 (N+3)*R floor", async () => {
      const f = await scheduleFixture();
      const id = "schedule-renew-eligible";
      // Daily, run ONCE, 10 USDT/buy: plannedBuys = 1, so the schedule reserve is
      // (min(1, 7) + 2) * R = 3R (TRADFI-SCHEDULE-NATIVE-CAP-PLAN A3 — the reserve
      // no longer scales with the chain-granted token count, a schedule agent
      // never sells through the plane). The v2 floor this replaces would be
      // (2*1 + 6 + 1) * R = 9R with the pin's six capable tokens (five bstocks
      // plus one Ondo row, the capability probe stubbed true) — proof of the fix,
      // not a cap so large it would pass either way.
      await seedScheduleAgent(f, id, { scheduleIntervalSec: 86400, scheduleEndKind: "runs", scheduleEndRuns: 1 }, { capDayWei: 3n * SCHEDULE_RELAY_FEE_WEI, expired: true });
      const preview = await call(f.harness, `/agents/${id}/session/renew/preview`,
        { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(preview.status, 200, preview.text);
      const body = (preview.body as { data: { eligible: boolean; reason?: string } }).data;
      assert.equal(body.eligible, true, JSON.stringify(body));
    });

    it("A2: the owner-view native meter agrees with the gate — it reports and reserves ONE token, not the chain grant", async () => {
      const f = await scheduleFixture();
      const id = "schedule-native-meter";
      await seedScheduleAgent(f, id);
      const R = SCHEDULE_RELAY_FEE_WEI;
      // The chain says this key can still sell 29 tokens; the schedule override
      // (A1/A2) must reserve and report ONE, since this agent never sells through
      // the plane. Remaining is exactly the ONE-token floor, one wei to spare.
      const remaining = 2n * R + 1n;
      f.harness.provider.nativeDayMeterResult = { kind: "day", limitWei: 1_000n * R, currentSpentWei: 1_000n * R - remaining, grantedTokenCount: 29 };
      const response = await call(f.harness, `/agents/${id}/owner-view`,
        { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(response.status, 200, response.text);
      const meter = (response.body as { data: { nativeMeter?: Record<string, unknown> } }).data.nativeMeter;
      assert.ok(meter, "the owner view must carry the native meter");
      assert.equal(meter?.["grantedTokenCount"], 1, "the count the floor actually used, not the chain's raw 29");
      assert.equal(meter?.["reserveWei"], R.toString(10));
      assert.equal(meter?.["buysRefused"], false, "the schedule override is what keeps this agent buying");
    });
  });

  /**
   * TRADFI-AGGREGATOR-ACTIVATION-BUILD R3.8 — the three owed tests: C5/R2.9's
   * renewal-adds-the-rule coverage, R3.1's D3 pin-mode seam (plus the R3.5
   * hire-writes-nothing check), and C8's worker-cycle refusal-code coverage.
   * Reuses `scheduleFixture`/`scheduleSettings`/`scheduleHireParams` (the
   * existing v2/schedule fixtures in this file) rather than inventing new
   * ones, per the smallest-change instruction.
   */
  describe("TradFi aggregator activation — owed tests", () => {
    const GUARD = getAddress("0x9000000000000000000000000000000000009000");

    async function seedV2Agent(f: Awaited<ReturnType<typeof scheduleFixture>>, id: string,
      options: { readonly aggregatorGuard?: Address; readonly expired?: boolean } = {}) {
      const expiresAt = options.expired === true ? NOW_SEC - 1 : NOW_SEC + 604_800;
      // Mirrors seedScheduleAgent: expiresAt must be in the future relative to the
      // spec's OWN construction-time nowSeconds even when it is already past NOW_SEC.
      const specNowSeconds = options.expired === true ? NOW_SEC - 3_600 : NOW_SEC;
      const spec = tradeSessionSpec({ venues: f.venues, tokens: [{ token: SCHEDULE_TOKEN }, { token: THROWS_TOKEN }],
        nativeCaps: [{ limit: SCHEDULE_CAP_DAY_WEI, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 1_000n * E,
        quotePerTradeCapWei: 10n * E, platformFeeBps: 0,
        ...(options.aggregatorGuard === undefined ? {} : { aggregatorGuard: options.aggregatorGuard }),
        expiresAt, nowSeconds: specNowSeconds });
      await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey",
        status: "armed", httpRuntimeProfile: "trade-v1",
        sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY,
          expiry: expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
      const settings = scheduleSettings();
      await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });
    }

    function guardRuleCount(spec: { readonly allowedCalls: readonly { readonly to?: Address; readonly selector?: string }[] }): number {
      return spec.allowedCalls.filter((rule) => rule.to?.toLowerCase() === GUARD.toLowerCase() && rule.selector === TRADFI_GUARD_SWAP_SELECTOR).length;
    }

    describe("C5/R2.9/R3.5 — renewal adds the guard rule exactly once, and verification gating", () => {
      it("adds exactly one guard rule to a guard-less spec, and the grant digest differs from a no-guard control renewal", async () => {
        const f = await scheduleFixture({ aggregatorGuard: GUARD, guardVerified: async () => true });
        const id = "renew-adds-guard";
        await seedV2Agent(f, id, { expired: true });
        const response = await post(f.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(response.status, 200, response.text);
        const pending = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
        assert.ok(pending, "a renewal must be recorded");
        assert.equal(guardRuleCount(pending!.sessionSpec), 1);

        const control = await scheduleFixture();
        await seedV2Agent(control, id, { expired: true });
        const controlResponse = await post(control.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(controlResponse.status, 200, controlResponse.text);
        const controlPending = (await control.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
        assert.equal(guardRuleCount(controlPending!.sessionSpec), 0, "no configured guard must add no rule");
        assert.notEqual(pending!.grantDigest, controlPending!.grantDigest, "the added rule must change what the owner signs");
      });

      it("a second renewal of a spec that already carries the rule adds no duplicate", async () => {
        const f = await scheduleFixture({ aggregatorGuard: GUARD, guardVerified: async () => true });
        const id = "renew-no-duplicate";
        await seedV2Agent(f, id, { expired: true, aggregatorGuard: GUARD });
        const response = await post(f.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(response.status, 200, response.text);
        const pending = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
        assert.equal(guardRuleCount(pending!.sessionSpec), 1, "still exactly one, never two");
      });

      it("a guard-less spec with an unverified configured guard refuses renewal 503, and the preview reports the reason", async () => {
        const f = await scheduleFixture({ aggregatorGuard: GUARD, guardVerified: async () => false });
        const id = "renew-guard-unverified";
        await seedV2Agent(f, id, { expired: true });
        const preview = await call(f.harness, `/agents/${id}/session/renew/preview`,
          { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
        assert.equal(preview.status, 200, preview.text);
        const previewBody = (preview.body as { data: { eligible: boolean; reason?: string } }).data;
        assert.equal(previewBody.eligible, false);
        assert.equal(previewBody.reason, "guard_unverified");

        const response = await post(f.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(response.status, 503, response.text);
        assert.equal((response.body as { error: { code: string } }).error.code, "guard_unverified");
        assert.equal((await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal, null, "a refused renewal must write nothing");
      });

      it("a spec that already has the guard rule renews even when verification fails", async () => {
        const f = await scheduleFixture({ aggregatorGuard: GUARD,
          guardVerified: async () => { throw new Error("must not be called: the rule is already granted"); } });
        const id = "renew-skip-verify";
        await seedV2Agent(f, id, { expired: true, aggregatorGuard: GUARD });
        const response = await post(f.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(response.status, 200, response.text);
      });
    });

    describe("R3.1/R3.5 — the D3 pin-mode seam, and a refused hire writes nothing", () => {
      const PIN_TOKENS = Array.from({ length: 5 }, (_, index) => getAddress(`0x${(700 + index).toString(16).padStart(40, "0")}`));
      const POOLLESS_TOKEN = getAddress("0x0000000000000000000000000000000000000799");

      function pinModeDataPlane(): TradeDataPlaneReads {
        const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: getAddress("0x4488000000000000000000000000000000004488"),
          feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: NOW_SEC * 1_000 };
        // pinUniverse (universe.ts:253) refuses any "tradfi" candidate with no `rwa`
        // fact at all (open+TRADING), regardless of venues — every row needs one.
        const rows: UniverseRow[] = [
          ...PIN_TOKENS.map((address, index): UniverseRow => ({ address, symbol: `PIN${index}`, lane: "bstocks", source: "test",
            rwa: scheduleRwaFact(`PIN${index}`, [venue]), venues: [venue] })),
          { address: POOLLESS_TOKEN, symbol: "POOLLESS", lane: "bstocks", source: "test",
            rwa: scheduleRwaFact("POOLLESS", []), venues: [] },
        ];
        return {
          async universe(lane) { return lane === "bstocks" ? rows : []; },
          async tokensBatch(addresses) { return addresses.map((address, index) => ({ address, symbol: `T${index}`,
            priceUsd: 1, marketCapUsd: 2_000_000, volume24hUsd: 10_000, holders: 100, priceChange24hPct: 1 })); },
          async eligibilityBatch() { return []; },
          async security() { return { data: {}, meta: {} }; },
        };
      }

      function previewQuery(mode: "ai" | "schedule"): URLSearchParams {
        const base: Record<string, string> = { walletAddress: WALLET, capDayWei: CAP.toString(10), sizingPreset: "trade-v1",
          executionModel: "tradfi", entryWei: (20n * E).toString(10), maxOpenPositions: "1", settlementAsset: "USDT",
          minEntryWei: (5n * E).toString(10), capitalQuoteWei: (100n * E).toString(10), cmcNewsEnabled: "false" };
        if (mode === "schedule") Object.assign(base, { tradeMode: "schedule", scheduleIntervalSec: "3600", scheduleEndKind: "runs", scheduleEndRuns: "5" });
        return new URLSearchParams(base);
      }

      async function previewPin(f: Awaited<ReturnType<typeof fixture>>, mode: "ai" | "schedule"): Promise<readonly Address[]> {
        const response = await f.harness.app.request(`/agents/hire/preview?${previewQuery(mode)}`, { headers: { "x-exec-token": EXEC_TOKEN } });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const body = JSON.parse(text) as { data: { pin: readonly { address: Address }[] } };
        return body.data.pin.map((row) => row.address);
      }

      it("an AI preview never admits a pool-less token, whether or not a Schedule preview with the same key ran first", async () => {
        const scheduleFirst = await fixture({ dataPlane: pinModeDataPlane() });
        const schedulePin = await previewPin(scheduleFirst, "schedule");
        assert.ok(schedulePin.some((address) => address.toLowerCase() === POOLLESS_TOKEN.toLowerCase()), "Schedule mode must still admit the pool-less token");
        const aiAfterSchedule = await previewPin(scheduleFirst, "ai");
        assert.ok(!aiAfterSchedule.some((address) => address.toLowerCase() === POOLLESS_TOKEN.toLowerCase()),
          "an AI preview right after a Schedule refresh with the same minEntry/slippage key must not inherit the pool-less token");

        const aiFirst = await fixture({ dataPlane: pinModeDataPlane() });
        const aiPin = await previewPin(aiFirst, "ai");
        assert.ok(!aiPin.some((address) => address.toLowerCase() === POOLLESS_TOKEN.toLowerCase()));
        const scheduleAfterAi = await previewPin(aiFirst, "schedule");
        assert.ok(scheduleAfterAi.some((address) => address.toLowerCase() === POOLLESS_TOKEN.toLowerCase()),
          "the reverse order must still grant the pool-less token to a Schedule hire");
      });

      it("R3.5: a hire refused 503 guard_unverified writes no agent row and no claim", async () => {
        const f = await scheduleFixture({ aggregatorGuard: GUARD, guardVerified: async () => false });
        const id = "hire-guard-unverified";
        const response = await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, scheduleHireParams()));
        assert.equal(response.status, 503, response.text);
        assert.equal((response.body as { error: { code: string } }).error.code, "guard_unverified");
        assert.equal(await f.store.getAgentById(id), null, "no agent row may exist after a refused hire");
      });
    });

    describe("AUDIT MEDIUM-1 — R2.4 hire capability distinction and R2.5 renewal ordering/refusal", () => {
      const FILLERS = Array.from({ length: 5 }, (_, index) => getAddress(`0x${(800 + index).toString(16).padStart(40, "0")}`));
      const TARGET = getAddress("0x0000000000000000000000000000000000000899");

      function capabilityDataPlane(): TradeDataPlaneReads {
        const venue: VenueRow = { dex: "pancakeswap", version: "v2", pool: getAddress("0x4499000000000000000000000000000000004499"),
          feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: NOW_SEC * 1_000 };
        const rows: UniverseRow[] = [
          ...FILLERS.map((address, index): UniverseRow => ({ address, symbol: `FIL${index}`, lane: "bstocks", source: "test",
            rwa: scheduleRwaFact(`FIL${index}`, [venue]), venues: [venue] })),
          // Pool-less, so it is the one candidate the capability probe actually
          // decides (an admitted-venue row is "capable" without a call).
          { address: TARGET, symbol: "TARGETX", lane: "bstocks", source: "test", rwa: scheduleRwaFact("TARGET", []), venues: [] },
        ];
        return {
          async universe(lane) { return lane === "bstocks" ? rows : []; },
          async tokensBatch(addresses) { return addresses.map((address, index) => ({ address, symbol: `T${index}`,
            priceUsd: 1, marketCapUsd: 2_000_000, volume24hUsd: 10_000, holders: 100, priceChange24hPct: 1 })); },
          async eligibilityBatch() { return []; },
          async security() { return { data: {}, meta: {} }; },
        };
      }

      function probeReturning(result: TradfiCapabilityProbeResult) {
        return async (input: { readonly candidate: PinnedCandidate }): Promise<TradfiCapabilityProbeResult> =>
          input.candidate.address.toLowerCase() === TARGET.toLowerCase() ? result : "capable";
      }

      it("R2.4: an unknown chosen token answers a retryable 503 capability_preview_incomplete, not schedule_token_not_granted", async () => {
        const f = await fixture({ dataPlane: capabilityDataPlane(), tradfiV2CapabilityProbe: probeReturning("unknown") });
        const id = "hire-unknown";
        const response = await post(f.harness, `/agents/${id}/session`,
          await signed("provisionAgent", id, scheduleHireParams({ scheduleToken: TARGET.toLowerCase() })));
        assert.equal(response.status, 503, response.text);
        assert.equal((response.body as { error: { code: string } }).error.code, "capability_preview_incomplete");
        assert.equal(await f.store.getAgentById(id), null, "no agent row may exist after a retryable refusal");
      });

      it("R2.4 (contrast): a definitively incapable chosen token still answers schedule_token_not_granted", async () => {
        const f = await fixture({ dataPlane: capabilityDataPlane(), tradfiV2CapabilityProbe: probeReturning("incapable") });
        const id = "hire-incapable";
        const response = await post(f.harness, `/agents/${id}/session`,
          await signed("provisionAgent", id, scheduleHireParams({ scheduleToken: TARGET.toLowerCase() })));
        assert.equal(response.status, 400, response.text);
        assert.equal((response.body as { error: { code: string } }).error.code, "schedule_token_not_granted");
      });

      it("R2.5: renewal keeps a currently granted chosen token that is now incapable and absent from the fresh pin", async () => {
        const f = await fixture({ dataPlane: capabilityDataPlane(), tradfiV2CapabilityProbe: probeReturning("incapable") });
        const id = "renew-keep-chosen";
        const expiresAt = NOW_SEC - 1;
        const specNowSeconds = NOW_SEC - 3_600;
        const spec = tradeSessionSpec({ venues: f.venues, tokens: [{ token: TARGET }],
          nativeCaps: [{ limit: SCHEDULE_CAP_DAY_WEI, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 1_000n * E,
          quotePerTradeCapWei: 10n * E, platformFeeBps: 0, expiresAt, nowSeconds: specNowSeconds });
        await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey",
          status: "armed", httpRuntimeProfile: "trade-v1",
          sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY,
            expiry: expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
        const settings = scheduleSettings({ scheduleToken: TARGET.toLowerCase() });
        await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });

        const response = await post(f.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(response.status, 200, response.text);
        const pending = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
        assert.ok(pending, "the renewal must be recorded");
        const grantedTokens = pending!.sessionSpec.allowedCalls
          .filter((rule) => rule.selector === APPROVE_SELECTOR && rule.to !== undefined).map((rule) => rule.to!.toLowerCase());
        assert.ok(grantedTokens.includes(TARGET.toLowerCase()), "the currently granted chosen token must be kept even though it is now incapable");
        // held -> chosen -> pin: TARGET is both held and chosen here, plus the 5 capable fillers.
        assert.ok(grantedTokens.length <= 28);
      });

      it("R2.5: renewal refuses schedule_token_not_renewable when the chosen token is neither granted nor capable", async () => {
        const f = await fixture({ dataPlane: capabilityDataPlane(), tradfiV2CapabilityProbe: probeReturning("incapable") });
        const id = "renew-refuse-chosen";
        const expiresAt = NOW_SEC - 1;
        const specNowSeconds = NOW_SEC - 3_600;
        const spec = tradeSessionSpec({ venues: f.venues, tokens: [{ token: FILLERS[0]! }],
          nativeCaps: [{ limit: SCHEDULE_CAP_DAY_WEI, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: 1_000n * E,
          quotePerTradeCapWei: 10n * E, platformFeeBps: 0, expiresAt, nowSeconds: specNowSeconds });
        await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey",
          status: "armed", httpRuntimeProfile: "trade-v1",
          sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY,
            expiry: expiresAt, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
        // TARGET was never granted here, and the fresh pin (fillers only, TARGET incapable) never admits it either.
        const settings = scheduleSettings({ scheduleToken: TARGET.toLowerCase() });
        await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });

        const preview = await call(f.harness, `/agents/${id}/session/renew/preview`,
          { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
        assert.equal(preview.status, 200, preview.text);
        assert.equal((preview.body as { data: { reason?: string } }).data.reason, "schedule_token_not_renewable");

        const response = await post(f.harness, `/agents/${id}/session/renew`,
          await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
        assert.equal(response.status, 409, response.text);
        assert.equal((response.body as { error: { code: string } }).error.code, "schedule_token_not_renewable");
        assert.equal((await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal, null, "a refused renewal must write nothing");
      });
    });

    describe("C8 — Flash refusal codes are observed on the worker cycle", () => {
      const TOKEN_NOT_GRANTED = getAddress("0x0000000000000000000000000000000000000801");
      const TOKEN_MISMATCH = getAddress("0x0000000000000000000000000000000000000802");
      const TOKEN_EXPIRED = getAddress("0x0000000000000000000000000000000000000803");
      const TOKEN_PROXY_ERROR = getAddress("0x0000000000000000000000000000000000000804");
      const OTHER_TAKER = getAddress("0x0000000000000000000000000000000000009999");
      const OWNER = ownerAccount.address;
      const throwingReader: RouteQuoteReader = {
        async quoteV2() { throw new Error("no public AMM"); }, async quoteV3Single() { throw new Error("no public AMM"); },
        async quoteV3Path() { throw new Error("no public AMM"); }, async quoteUniV3Single() { throw new Error("no public AMM"); },
        async quoteUniV3Path() { throw new Error("no public AMM"); },
      };

      it("records not-granted, request-mismatch, expired and a proxy:<code>:<reason> refusal in one worker cycle", async () => {
        const agents = new MemoryAgentStore(null, () => NOW_SEC * 1_000, { chainId: 56, keyStoreAddress: KEYSTORE });
        const settingsStore = new MemoryTradeSettingsStore(agents, () => NOW_SEC * 1_000);
        const positions = new MemoryTradePositionStore(() => NOW_SEC * 1_000);
        const intents = new MemoryTradeIntentStore(() => NOW_SEC * 1_000);
        const journal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
        const tokens = [TOKEN_NOT_GRANTED, TOKEN_MISMATCH, TOKEN_EXPIRED, TOKEN_PROXY_ERROR];
        const balance = 1n * E;
        for (const [index, token] of tokens.entries()) {
          const id = `c8-${token.slice(-4)}`;
          // Each agent needs its OWN wallet: MemoryAgentStore refuses a second
          // agent sharing one wallet ("cannot safely share Trading capital").
          const wallet = getAddress(`0x${(9_000 + index).toString(16).padStart(40, "0")}`);
          const publicKey = `0x04${(index + 1).toString(16).padStart(2, "0").repeat(64)}` as Hex;
          const spec = tradeSessionSpec({ venues: { chainId: 56, pancakeRouterV2: ROUTER_V2, wbnb: WBNB },
            tokens: [{ token }], nativeCaps: [{ limit: CAP, period: "day" }], quoteToken: USDT_56,
            quoteDailyCapWei: 100n * E, quotePerTradeCapWei: 20n * E, aggregatorGuard: GUARD,
            nowSeconds: NOW_SEC, expiresAt: NOW_SEC + 86_400 });
          await agents.createAgent({ id, ownerAddress: OWNER, walletAddress: wallet, custodyModel: "passkey", status: "armed",
            sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey, expiry: spec.expiresAt,
              grantedAtSec: NOW_SEC - 86_400, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
                settlementAsset: "USDT", minEntryWei: (5n * E).toString(), capitalQuoteWei: (100n * E).toString() } } });
          const settings: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
            minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: (100n * E).toString(),
            cmcNewsEnabled: false, maxOpenPositions: 1, takeProfitBps: 5_000, stopLossBps: 2_000, maxHoldSec: 3_600 };
          await settingsStore.put({ agentId: id, ownerAddress: OWNER, params: settings, digest: tradeSettingsDigest(settings) });
          await positions.open({ positionId: `${id}-pos`, agentId: id, ownerAddress: OWNER, token, route: { hops: [], fees: [] },
            entryWei: balance, tokenAmount: balance, fillStatus: "verified", openedAt: NOW_SEC * 1_000,
            settlementAsset: "USDT", requestedEntryAtomic: balance, verifiedEntryAtomic: balance });
        }
        const flashBody = (token: Address) => ({
          version: "tradfi-binance-flash-v1" as const, chainId: 56 as const, taker: GUARD, tokenIn: token, tokenOut: USDT_56,
          amountInAtomic: balance.toString(10), quotedOutAtomic: balance.toString(10), minOutAtomic: (balance * 97n / 100n).toString(10),
          router: TRADFI_BINANCE_FLASH_ROUTER_56, spender: TRADFI_BINANCE_FLASH_SPENDER_56, calldata: "0xad43f73d" as const, value: "0" as const,
          observedAt: NOW_SEC * 1_000, expiresAt: NOW_SEC * 1_000 + 15_000, estimatedGasUnits: "100000", gasPriceWei: "1",
          feeAmountAtomic: null, feeToken: null,
        });
        const deps: TradeWorkerDeps = {
          agentStore: agents, settingsStore, positions, intents, journal, platformFeeBps: 0, aggregatorGuard: GUARD,
          dataPlane: {
            async universe() { return []; }, async tokensBatch(addresses) { return addresses.map((address) => ({ address, symbol: "USDT",
              priceUsd: 1, marketCapUsd: null, volume24hUsd: 1, holders: 1, priceChange24hPct: 0 })); },
            async eligibilityBatch() { return []; }, async security() { return { riskLevel: "ok", flags: [] }; },
            async binanceQuoteAndSwap(request) {
              if (request.tokenIn.toLowerCase() === TOKEN_NOT_GRANTED.toLowerCase()) return { ...flashBody(TOKEN_NOT_GRANTED), taker: OTHER_TAKER };
              if (request.tokenIn.toLowerCase() === TOKEN_MISMATCH.toLowerCase()) return { ...flashBody(TOKEN_MISMATCH), amountInAtomic: (balance + 1n).toString(10) };
              if (request.tokenIn.toLowerCase() === TOKEN_EXPIRED.toLowerCase()) return { ...flashBody(TOKEN_EXPIRED), expiresAt: NOW_SEC * 1_000 + 3_000 };
              throw new Error("binance_unavailable:database timeout");
            },
          },
          provider: { async getTokenBalance() { return balance; }, async getTokenMetadata() { return { decimals: 18, symbol: "STOCK" }; },
            async readSpendInfos() { return [{ token: USDT_56, period: "day", periodCode: 2, limitWei: 100n * E, currentSpentWei: 0n }]; } },
          llmFor: () => ({ async complete() { throw new Error("no LLM call expected — concrete thresholds must skip it"); } }),
          executor: { async execute() { throw new Error("no submission expected — every scenario refuses before a decision"); } },
          executorDeps: {}, readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(tokens.map((token) => token.toLowerCase())) },
          rpcUrls: [], routeReader: throwingReader, tradfiNativeCostUsdtAtomic: async () => 1n,
          forbiddenAddresses: () => new Set(), executionIdentity: (_agent, request) => ({ idempotencyKey: keccak256(stringToBytes(request.decisionId)), paramsHash: `0x${"77".repeat(32)}` as Hex }),
          recoverFill: async (intent) => ({ side: "buy", entryWei: intent.entryWei, tokenAmount: null, fillStatus: "unverified" }),
          now: () => NOW_SEC * 1_000,
        };
        const report = await runTradeWorkerOnce(deps);
        const events = report.outcomes.flatMap((outcome) => (outcome as unknown as { events?: readonly TradeRunEvent[] }).events ?? []);
        const refusals = events.filter((event) => event.stage === "route" && event.code === "binance-refused");
        const reasons = refusals.map((event) => event.reason);
        const dump = JSON.stringify(reasons);
        assert.ok(reasons.includes("not-granted"), `expected not-granted, got ${dump}`);
        assert.ok(reasons.includes("request-mismatch"), `expected request-mismatch, got ${dump}`);
        assert.ok(reasons.includes("expired"), `expected expired, got ${dump}`);
        assert.ok(reasons.some((reason) => reason?.startsWith("proxy:binance_unavailable")), `expected a proxy:<code>:<reason> refusal, got ${dump}`);
      });
    });
  });
});

describe("TradFi AI expiry / keep-remove (owner routes, view, renewal admission)", () => {
  const E = 10n ** 18n;
  const STOCK = TOKENS[0]!;
  const OTHER_STOCK = TOKENS[1]!;

  function aiSettings(overrides: Partial<TradeSettings> = {}): TradeSettings {
    return { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", entryWei: (10n * E).toString(10), maxOpenPositions: 2,
      takeProfitBps: null, stopLossBps: null, maxHoldSec: null, breakEvenAfterTp: false, noReentry: false,
      settlementAsset: "USDT", minEntryWei: (10n * E).toString(10), capitalQuoteWei: (1_000n * E).toString(10), cmcNewsEnabled: false, ...overrides };
  }

  async function seed(f: Awaited<ReturnType<typeof fixture>>, id: string, options: { readonly settings?: TradeSettings | null;
    readonly status?: "armed" | "paused" | "revoked" | "retired"; readonly expired?: boolean; readonly hireSizingName?: "trade-v1" | "lp-v1" } = {}) {
    const expiresAt = options.expired === true ? NOW_SEC - 1 : NOW_SEC + 3_600;
    const spec = tradeSessionSpec({ venues: f.venues, tokens: TOKENS.map((token) => ({ token })), nativeCaps: [{ limit: CAP, period: "day" }],
      quoteToken: USDT_56, quoteDailyCapWei: 1_000n * E, quotePerTradeCapWei: 10n * E, platformFeeBps: 0,
      expiresAt, nowSeconds: options.expired === true ? NOW_SEC - 3_600 : NOW_SEC });
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey", status: "armed",
      httpRuntimeProfile: options.hireSizingName === "lp-v1" ? "lp-v1" : "trade-v1", caps: { dailyNativeWei: CAP },
      sessionFacts: { spec, permissions: { calls: [], spend: [] }, publicKey: LEGACY_PUBLIC_KEY, expiry: expiresAt,
        hireSizing: { name: options.hireSizingName ?? "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
    if (options.settings !== null) {
      const settings = options.settings ?? aiSettings();
      await f.settingsStore.put({ agentId: id, ownerAddress: ownerAccount.address, params: settings, digest: tradeSettingsDigest(settings) });
    }
    if (options.status !== undefined && options.status !== "armed") {
      const updated = await f.store.updateAgentStatus(ownerAccount.address, id, options.status);
      assert.equal(updated?.status, options.status);
    }
  }

  let openCounter = 0;
  async function open(f: Awaited<ReturnType<typeof fixture>>, id: string, token: Address = STOCK, positionId = `held-${openCounter + 1}`,
    options: { readonly close?: { readonly exitWei: bigint } } = {}) {
    openCounter += 1;
    await f.positions.open({ positionId, agentId: id, ownerAddress: ownerAccount.address, token, route: { hops: [], fees: [] }, entryWei: 5n * E,
      tokenAmount: 9n, fillStatus: "verified", openedAt: NOW_SEC * 1_000, settlementAsset: "USDT", requestedEntryAtomic: 5n * E,
      verifiedEntryAtomic: 5n * E, receiptOwnershipKey: `56|${FINALIZED_HASH}|${WALLET.toLowerCase()}|${openCounter}|${FINALIZED_HASH}` });
    if (options.close !== undefined) {
      await f.positions.closePosition({ ownerAddress: ownerAccount.address, agentId: id, positionId, exitWei: options.close.exitWei, soldTokenAmount: 9n,
        exitFillStatus: "verified", reason: "llm" });
    }
    return positionId;
  }

  async function revoke(f: Awaited<ReturnType<typeof fixture>>, id: string, params: unknown) {
    return post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id, params));
  }

  const code = (response: { readonly body: Record<string, unknown> }): string | undefined => (response.body as { error?: { code?: string } }).error?.code;

  it("the paramsHash of {} differs from {keepPositions:true} (the signed field is bound)", () => {
    assert.notEqual(paramsHash("revoke", {}), paramsHash("revoke", { keepPositions: true }));
  });

  for (const status of ["armed", "paused"] as const) {
    it(`keepPositions:true on a ${status} TradFi AI agent revokes locally without draining, exit requests or position changes; the worker skips it and the sweep orphans`, async () => {
      const f = await fixture();
      const id = `ai-keep-${status}`;
      await seed(f, id, { status });
      const first = await open(f, id, STOCK);
      const second = await open(f, id, OTHER_STOCK);
      const response = await revoke(f, id, { keepPositions: true });
      assert.equal(response.status, 200, response.text);
      const data = response.body["data"] as { agent: { status: string }; onChainRevoke: unknown };
      assert.equal(data.agent.status, "revoked");
      assert.notEqual(data.onChainRevoke, undefined);
      assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "revoked");
      assert.equal((await f.settingsStore.get(ownerAccount.address, id))?.drainingAt, null, "Keep never drains: draining means sell");
      for (const positionId of [first, second]) {
        const row = await f.positions.get(ownerAccount.address, id, positionId);
        assert.equal(row?.exitRequestedAt, null, "Keep never requests an exit");
        assert.equal(row?.status, "open", "the positions are untouched");
      }
      assert.equal(await f.harness.killswitch.isAgentPaused(id, ownerAccount.address), true);
      const deps = { agentStore: f.store, settingsStore: f.settingsStore, positions: f.positions, intents: f.intents, journal: f.journal,
        readiness: { ready: false, allowlistAvailable: true, bstocksAddresses: new Set<string>() }, now: () => NOW_SEC * 1_000 } as unknown as TradeWorkerDeps;
      const report = await runTradeWorkerOnce(deps);
      assert.deepEqual(report.outcomes, [], "a revoked agent gets no cycle");
      for (const positionId of [first, second]) assert.equal((await f.positions.get(ownerAccount.address, id, positionId))?.status, "orphaned");
    });
  }

  it("keep-not-supported: every other model, a missing or unparseable settings row, and a non-trade agent answer 409 keep_not_supported and change nothing", async () => {
    const cases: readonly (readonly [string, NonNullable<Parameters<typeof seed>[2]>])[] = [
      ["sigma", { settings: DEFAULT_TRADE_SETTINGS }],
      ["schedule", { settings: aiSettings({ maxOpenPositions: 1, tradeMode: "schedule", scheduleToken: STOCK.toLowerCase(), scheduleIntervalSec: 3_600, scheduleFirstAtSec: null,
        scheduleEndKind: "budget", scheduleEndAtSec: null, scheduleEndRuns: null, scheduleMarketHoursOnly: false, scheduleMaxPremiumBps: 150 }) }],
      ["portfolio", { settings: aiSettings({ maxOpenPositions: 1, entryWei: (50n * E).toString(10), minEntryWei: E.toString(10), capitalQuoteWei: (50n * E).toString(10), crashProtection: false, tradeMode: "portfolio",
        portfolioTokens: DCA_POOLS_56.slice(0, 2).map((pool) => pool.stock.toLowerCase()), portfolioWeightsBps: [5_000, 5_000], portfolioDriftBps: 500, portfolioIntervalSec: 86_400 }) }],
      ["dca", { settings: dcaSettings() }],
      ["missing-settings", { settings: null }],
      ["unparseable-settings", { settings: { not: "settings" } as unknown as TradeSettings }],
      ["non-trade", { settings: null, hireSizingName: "lp-v1" }],
    ];
    for (const [name, options] of cases) {
      const f = await fixture();
      const id = `keep-refused-${name}`;
      if (["sigma", "schedule", "portfolio", "dca"].includes(name)) {
        const parsed = parseTradeSettings(options.settings);
        assert.equal(parsed.ok && !isTradfiAiSettings(parsed.value.effective), true, `${name}: the fixture is a VALID settings row of another model`);
      }
      await seed(f, id, options);
      const response = await revoke(f, id, { keepPositions: true });
      assert.equal(response.status, 409, `${name}: ${response.text}`);
      assert.equal(code(response), "keep_not_supported", name);
      assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "armed", `${name}: no state change`);
    }
  });

  it("keep on an agent that is still provisioning answers 409 keep_not_supported and changes nothing", async () => {
    const f = await fixture();
    const id = "ai-keep-provisioning";
    const draft = pendingDraft(ownerAccount.address, WALLET, NOW_SEC);
    await f.store.createProvisioningAgent({ record: { id, ownerAddress: ownerAccount.address, walletAddress: WALLET, custodyModel: "passkey" },
      sessionKey: DRAFT_KEY, pendingGrant: { ...draft, sizing: { ...draft.sizing, sizingPreset: "trade-v1" } } });
    const response = await revoke(f, id, { keepPositions: true });
    assert.equal(response.status, 409, response.text);
    assert.equal(code(response), "keep_not_supported");
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "provisioning");
  });

  it("keep-truthy-nonboolean-refuses — strict params: an extra key, false and every non-boolean-true value answer 400 and change nothing", async () => {
    const f = await fixture();
    const id = "ai-keep-strict";
    await seed(f, id);
    const bad: readonly unknown[] = [{ keepPositions: false }, { keepPositions: true, extra: 1 }, { other: true }, { keepPositions: "true" },
      { keepPositions: 1 }, { keepPositions: {} }, { keepPositions: [true] }, { keepPositions: null }, [], null];
    for (const params of bad) {
      const response = await revoke(f, id, params);
      assert.equal(response.status, 400, `${JSON.stringify(params)}: ${response.text}`);
      assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "armed");
    }
  });

  it("an unsettled intent refuses Keep with 409 and no state change; a disposed (rolled-back) one proceeds", async () => {
    const f = await fixture();
    const id = "ai-keep-unsettled";
    await seed(f, id);
    await open(f, id);
    const idempotencyKey = `0x${"a7".repeat(32)}` as Hex;
    await f.intents.create({ decisionId: "in-flight-sell", idempotencyKey, agentId: id, ownerAddress: ownerAccount.address, side: "sell", token: STOCK,
      route: { hops: [], fees: [] }, amountWei: 9n, entryWei: 5n * E, positionId: "held-1", closeReason: "llm", settlementAsset: "USDT" });
    const settling = await revoke(f, id, { keepPositions: true });
    assert.equal(settling.status, 409, settling.text);
    assert.match((settling.body as { error: { message?: string } }).error.message ?? "", /still settling/u);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "armed");
    const disposed = await f.intents.disposeInertSell(ownerAccount.address, id, "in-flight-sell", encodeInertEvidence({ v: 1, kind: "inert-ambiguous-sell",
      key: LEGACY_PUBLIC_KEY.toLowerCase() as Hex, verdict: "invalid", block: "101", blockHash: FINALIZED_HASH, blockTimeSec: NOW_SEC, expirySec: NOW_SEC - 1, journalKey: idempotencyKey }));
    assert.equal(disposed.changed, true);
    const proceeds = await revoke(f, id, { keepPositions: true });
    assert.equal(proceeds.status, 200, proceeds.text);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "revoked");
  });

  it("already revoked or retired answers 409 already_revoked (the UI resumes at the on-chain tail); {} keeps its 400", async () => {
    for (const status of ["revoked", "retired"] as const) {
      const f = await fixture();
      const id = `ai-keep-${status}`;
      await seed(f, id, { status });
      const keep = await revoke(f, id, { keepPositions: true });
      assert.equal(keep.status, 409, keep.text);
      assert.equal(code(keep), "already_revoked");
      assert.equal((await revoke(f, id, {})).status, 400, "the empty-params call is unchanged");
    }
  });

  it("a pending renewal refuses Keep with 409 and no state change", async () => {
    const f = await fixture();
    const id = "ai-keep-renewal";
    await seed(f, id, { expired: true });
    const agent = await f.store.getAgent(ownerAccount.address, id);
    const next = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const pending: PendingRenewal = { version: 1, recoveredOwner: ownerAccount.address, walletAddress: WALLET, sessionAddress: next.address,
      sessionPublicKey: next.publicKey, accountKeyHash: keccak256(stringToBytes(next.address)), keyStoreKeyId: keccak256(next.publicKey),
      sessionSpec: agent!.sessionFacts!.spec, permissions: agent!.sessionFacts!.permissions, grantDigest: `0x${"44".repeat(32)}` as Hex, expiresAt: NOW_SEC + 3_600,
      sizing: { openNativeBudgetWei: "0", capDayWei: "1000", sizingPreset: "trade-v1", sizingPresetVersion: 1 },
      funding: { version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "1", registrations: 1, relayGasHeadroomWei: "1", requiredWei: "2", balanceWei: "10" },
      createdAtSec: NOW_SEC, keyStoreVerdictAtS1: "verified", renewActionId: `0x${"55".repeat(32)}` as Hex,
      previous: { publicKey: LEGACY_PUBLIC_KEY, keyStoreKeyId: keccak256(LEGACY_PUBLIC_KEY), accountKeyHash: keccak256(stringToBytes(WALLET)), expiry: NOW_SEC - 1 }, phase: "granting" };
    const created = await f.store.createPendingRenewalCas({ ownerAddress: ownerAccount.address, agentId: id, expectedRowVersion: agent!.rowVersion,
      nowSec: NOW_SEC, pendingRenewal: pending, sessionKey: `0x${"22".repeat(32)}` as Hex });
    assert.equal(created.kind, "updated");
    const response = await revoke(f, id, { keepPositions: true });
    assert.equal(response.status, 409, response.text);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "armed");
  });

  it("{} is unchanged for a TradFi AI agent: refused before a drain, allowed once drained and empty", async () => {
    const f = await fixture();
    const id = "ai-empty-params";
    await seed(f, id);
    const positionId = await open(f, id);
    assert.equal((await revoke(f, id, {})).status, 409);
    assert.equal((await post(f.harness, `/agents/${id}/trade/drain`, await signed("tradeDrain", id, {}))).status, 200);
    await f.positions.closePosition({ ownerAddress: ownerAccount.address, agentId: id, positionId, exitWei: 7n * E, soldTokenAmount: 9n, exitFillStatus: "verified", reason: "owner-request" });
    assert.equal((await revoke(f, id, {})).status, 200);
  });

  describe("kept holdings view (§5.3)", () => {
    async function view(f: Awaited<ReturnType<typeof fixture>>, id: string) {
      const response = await call(f.harness, `/agents/${id}/trade/view`, { headers: { "x-owner-action": toReadHeader(await signed("read", id, {})) } });
      assert.equal(response.status, 200, response.text);
      return response.body["data"] as { tradfiAi: boolean; keptPositions: number; summary: Record<string, unknown>;
        open: readonly { positionId: string; status: string; orphanedText?: string; orphanedResidual?: string | null; observation: unknown }[] };
    }
    const realised = (data: { summary: Record<string, unknown> }) => ({ grossDeltaWei: data.summary["grossDeltaWei"], grossComplete: data.summary["grossComplete"],
      wins: data.summary["wins"], closedTrades: data.summary["closedTrades"], openPositions: data.summary["openPositions"] });

    it("excludes every kept holding from the summary, the observer and the PnL — before the sweep, after orphaning, after a price move, after a withdrawal — and counts it", async () => {
      const observed: (readonly { readonly positionId: string; readonly status: string }[])[] = [];
      const f = await fixture({ onObserve: (rows) => { observed.push(rows); } });
      const id = "ai-kept-view";
      await seed(f, id);
      await open(f, id, STOCK, "win", { close: { exitWei: 7n * E } });
      await open(f, id, OTHER_STOCK, "loss", { close: { exitWei: 4n * E } });
      const armed = await view(f, id);
      assert.equal(armed.tradfiAi, true);
      assert.equal(armed.keptPositions, 0, "an armed agent keeps nothing");
      await open(f, id, STOCK, "kept-a");
      await open(f, id, OTHER_STOCK, "kept-b");
      assert.equal((await revoke(f, id, { keepPositions: true })).status, 200);
      const before = await view(f, id);
      assert.equal(before.keptPositions, 2);
      assert.equal(before.summary["openPositions"], 0);
      assert.equal(before.summary["closedTrades"], 2);
      assert.equal(before.summary["grossComplete"], true);
      assert.equal(before.summary["grossDeltaWei"], (7n * E - 5n * E + 4n * E - 5n * E).toString(10), "realised results only");
      assert.deepEqual(before.open.map((row) => row.positionId).sort(), ["kept-a", "kept-b"]);
      for (const row of before.open) {
        assert.equal(row.orphanedText, KEPT_POSITION_TEXT, "model-specific copy replaces the generic remedy");
        assert.equal(row.orphanedResidual, null);
      }
      for (const rows of observed.slice(-1)) assert.deepEqual(rows.map((row) => row.positionId).sort(), ["loss", "win"], "kept rows are never observed");
      for (const positionId of ["kept-a", "kept-b"]) await f.positions.markOrphaned(ownerAccount.address, id, positionId);
      const orphaned = await view(f, id);
      assert.deepEqual(realised(orphaned), realised(before));
      assert.equal(orphaned.keptPositions, 2);
      for (const rows of observed.slice(-1)) assert.deepEqual(rows.map((row) => row.positionId).sort(), ["loss", "win"]);
      // A price move and a withdrawal change nothing the view reads: kept rows are not observed at all.
      const afterMove = await view(f, id);
      assert.deepEqual(realised(afterMove), realised(before));
    });

    it("a late-landing sell adds exactly one closed row (documented §5.1 behaviour); a late-landing buy is kept, not summarised", async () => {
      const f = await fixture();
      const id = "ai-kept-late";
      await seed(f, id);
      await open(f, id, STOCK, "closed-1", { close: { exitWei: 6n * E } });
      await open(f, id, OTHER_STOCK, "kept-sell");
      assert.equal((await revoke(f, id, { keepPositions: true })).status, 200);
      const before = await view(f, id);
      const gross = BigInt(before.summary["grossDeltaWei"] as string);
      await f.positions.closePosition({ ownerAddress: ownerAccount.address, agentId: id, positionId: "kept-sell", exitWei: 9n * E, soldTokenAmount: 9n,
        exitFillStatus: "verified", reason: "llm" });
      const afterSell = await view(f, id);
      assert.equal(afterSell.summary["closedTrades"], 2);
      assert.equal(BigInt(afterSell.summary["grossDeltaWei"] as string), gross + (9n * E - 5n * E), "the figure changes by exactly that row");
      assert.equal(afterSell.keptPositions, 0);
      await open(f, id, STOCK, "kept-buy");
      const afterBuy = await view(f, id);
      assert.equal(afterBuy.keptPositions, 1);
      assert.deepEqual(realised(afterBuy), realised(afterSell), "a late buy is counted in keptPositions and never in the summary");
    });

    it("non-AI agents are unchanged: a revoked schedule/legacy agent keeps the generic orphaned copy, its positions in the summary and keptPositions 0", async () => {
      const f = await fixture();
      const id = "legacy-orphaned-view";
      await seed(f, id, { settings: DEFAULT_TRADE_SETTINGS });
      await open(f, id, STOCK, "orphan");
      await f.store.updateAgentStatus(ownerAccount.address, id, "revoked");
      await f.positions.markOrphaned(ownerAccount.address, id, "orphan");
      const data = await view(f, id);
      assert.equal(data.tradfiAi, false);
      assert.equal(data.keptPositions, 0);
      assert.equal(data.summary["openPositions"], 1);
      assert.equal(data.open[0]?.orphanedText, ORPHANED_POSITION_TEXT);
      assert.notEqual(data.open[0]?.orphanedResidual, null);
    });
  });

  describe("renewal admission recognises a disposed inert sell (§2.3) through the HTTP closure", () => {
    const IDEMPOTENCY = `0x${"c3".repeat(32)}` as Hex;
    async function ambiguousSell(f: Awaited<ReturnType<typeof fixture>>, id: string) {
      await f.intents.create({ decisionId: "ambiguous-sell", idempotencyKey: IDEMPOTENCY, agentId: id, ownerAddress: ownerAccount.address, side: "sell", token: STOCK,
        route: { hops: [], fees: [] }, amountWei: 9n, entryWei: 5n * E, positionId: "held-1", closeReason: "llm", settlementAsset: "USDT" });
      await f.journal.begin({ idempotencyKey: IDEMPOTENCY, agentId: id, ownerAddress: ownerAccount.address, kind: "trade", decisionId: "ambiguous-sell",
        externalRef: { paramsHash: `0x${"77".repeat(32)}` as Hex, publicKey: LEGACY_PUBLIC_KEY, sessionGeneration: 0 } });
      await f.journal.markUnknown(IDEMPOTENCY, "provider error -32602: please assign a tracer");
    }
    const evidence = (over: Record<string, unknown> = {}) => encodeInertEvidence({ v: 1, kind: "inert-ambiguous-sell", key: LEGACY_PUBLIC_KEY.toLowerCase() as Hex,
      verdict: "invalid", block: "101", blockHash: FINALIZED_HASH, blockTimeSec: NOW_SEC, expirySec: NOW_SEC - 1, journalKey: IDEMPOTENCY, ...over } as never);
    async function renew(f: Awaited<ReturnType<typeof fixture>>, id: string) {
      return post(f.harness, `/agents/${id}/session/renew`, await signOwnerAction("renewSession", { ttlSec: 3_600 }, { agentId: id, chainId: 56, network: "mainnet" }));
    }

    it("refuses while the sell is pending, and after an ordinary rollback with no evidence; accepts the disposed row", async () => {
      const pendingF = await fixture();
      await seed(pendingF, "renew-pending", { expired: true });
      await ambiguousSell(pendingF, "renew-pending");
      const pending = await renew(pendingF, "renew-pending");
      assert.equal(pending.status, 409, pending.text);
      assert.equal(code(pending), "renewal_busy");
      assert.match((pending.body as { error: { message?: string } }).error.message ?? "", /finishing a trade intent/u);

      const ordinary = await fixture();
      await seed(ordinary, "renew-ordinary", { expired: true });
      await ambiguousSell(ordinary, "renew-ordinary");
      await ordinary.intents.markRolledBack(ownerAccount.address, "renew-ordinary", "ambiguous-sell", "Trade journal rolled back before projection.");
      const ordinaryResponse = await renew(ordinary, "renew-ordinary");
      assert.equal(code(ordinaryResponse), "renewal_busy");
      assert.match((ordinaryResponse.body as { error: { message?: string } }).error.message ?? "", /journal UNKNOWN/u);

      const disposed = await fixture();
      await seed(disposed, "renew-disposed", { expired: true });
      await ambiguousSell(disposed, "renew-disposed");
      assert.equal((await disposed.intents.disposeInertSell(ownerAccount.address, "renew-disposed", "ambiguous-sell", evidence())).changed, true);
      const admitted = await renew(disposed, "renew-disposed");
      assert.notEqual(code(admitted), "renewal_busy", admitted.text);
    });

    it("keeps refusing for a non-AI agent even with valid-looking evidence, and for evidence bound to another key or journal row", async () => {
      const nonAi = await fixture();
      await seed(nonAi, "renew-non-ai", { expired: true, settings: DEFAULT_TRADE_SETTINGS });
      await ambiguousSell(nonAi, "renew-non-ai");
      await nonAi.intents.disposeInertSell(ownerAccount.address, "renew-non-ai", "ambiguous-sell", evidence());
      assert.equal(code(await renew(nonAi, "renew-non-ai")), "renewal_busy");

      const wrongKey = await fixture();
      await seed(wrongKey, "renew-wrong-key", { expired: true });
      await ambiguousSell(wrongKey, "renew-wrong-key");
      await wrongKey.intents.disposeInertSell(ownerAccount.address, "renew-wrong-key", "ambiguous-sell", evidence({ key: `0x04${"cd".repeat(64)}` }));
      assert.equal(code(await renew(wrongKey, "renew-wrong-key")), "renewal_busy");

      const wrongJournal = await fixture();
      await seed(wrongJournal, "renew-wrong-journal", { expired: true });
      await ambiguousSell(wrongJournal, "renew-wrong-journal");
      await wrongJournal.intents.disposeInertSell(ownerAccount.address, "renew-wrong-journal", "ambiguous-sell", evidence({ journalKey: `0x${"d4".repeat(32)}` }));
      assert.equal(code(await renew(wrongJournal, "renew-wrong-journal")), "renewal_busy");
    });
  });
});

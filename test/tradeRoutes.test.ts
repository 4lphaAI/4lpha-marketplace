import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { canonicalEncode } from "../src/auth/canonical.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import type { GrantEvidenceReader } from "../src/wallet/grantEvidence.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { MemoryAgentStore, type AgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryNonceStore, type NonceStore, type ProvisionClaimLease } from "../src/store/nonces.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import type { TradeDataPlaneReads, UniverseLane, UniverseRow } from "../src/trade/dataPlaneReads.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import type { TradeReadiness } from "../src/trade/readiness.js";
import { pinUniverse } from "../src/trade/universe.js";
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
  const dataPlane: TradeDataPlaneReads = {
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
      return { number: 101n, hash: FINALIZED_HASH };
    },
    async blockAt(blockNumber) { return { number: blockNumber, hash: FINALIZED_HASH }; },
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
  const harness = await createHarness({ seedAgent: false, agentStore: store, journal,
    ...(options.nonceStore === undefined ? {} : { nonceStore: options.nonceStore }), keyStoreReader,
    tradeAgent: {
      settingsStore, positions, intents, dataPlane, readiness, feeBps: 0,
      observer: {
        async observe(_agent, rows) {
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
      tradeAgentEnabled: true, executeRawEnabled: false, trade: tradeConfig({ venues }),
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
    hire: { evidence, nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB, treasury: TREASURY,
      feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
  return { harness, store, journal, settingsStore, positions, intents, venues, dataPlane };
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
      async finalizedBlock() { return { number: 101n, hash: FINALIZED_HASH }; },
      async blockAt(blockNumber) { return { number: blockNumber, hash: FINALIZED_HASH }; },
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
      async finalizedBlock() { return { number: 101n, hash: FINALIZED_HASH }; },
      async blockAt(blockNumber) { return { number: blockNumber, hash: FINALIZED_HASH }; },
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
});

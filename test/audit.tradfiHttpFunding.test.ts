import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, toFunctionSelector, type Hex } from "viem";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { issueAccountReadSession, parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { MemoryAgentStore, type AgentStore, type PendingGrant } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { buildCheckerApprovalCall, buildIncreaseAllowanceCall } from "../src/trade/cmcOwnerService.js";
import { USDT_56 } from "../src/trade/settlement.js";
import { tradeSessionSpec } from "../src/ops/policy.js";
import { validateSessionSpec } from "../src/core/session.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import type { TradeAgentServerDeps } from "../src/server.js";
import { call, createHarness, NOW_SEC, ownerAccount, signOwnerAction, toReadHeader, tradeConfig } from "./support/serverHarness.js";

const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const ROUTER = getAddress("0x5000000000000000000000000000000000000005");
const ROUTER_V3 = getAddress("0x5100000000000000000000000000000000000005");
const WBNB = getAddress("0x6000000000000000000000000000000000000006");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const NFPM = getAddress("0x9000000000000000000000000000000000000009");
const TOKENS = Array.from({ length: 6 }, (_, i) => getAddress(`0x${(101 + i).toString(16).padStart(40, "0")}`));
const E = 10n ** 18n;
const CAP = 30_000_000_000_000_000n;
const SETUP_COST = 7n;
const CAPITAL = 60n * E;
const DATA = 2n * E;
const KEY = `0x04${"77".repeat(64)}` as Hex;
const H = `0x${"88".repeat(32)}` as Hex;
const OWNER = ownerAccount.address;
const SETTINGS: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: CAPITAL.toString(),
  cmcNewsEnabled: true, cmcTotalBudgetWei: DATA.toString() };
const READ_CONFIG = { key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
  environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }) };

function exactEvidence(pending: PendingGrant): GrantEvidenceSnapshot {
  return { relayKeys: [{ hash: pending.accountKeyHash, expiry: pending.expiresAt, role: "session",
    permissions: { calls: [...pending.permissions.calls.map(rule => ({ ...("to" in rule ? { to: rule.to } : {}),
      ...("signature" in rule ? { signature: toFunctionSelector(rule.signature) } : {}) })),
      { to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", signature: "0x32323232" }], spend: pending.permissions.spend } }],
    accountKey: { expiry: pending.expiresAt, isSuperAdmin: false }, accountSpend: pending.permissions.spend,
    canExecute: [...pending.permissions.calls.map(() => true), true],
    keyStore: { kind: "registered", publicKey: pending.sessionPublicKey }, ownerVerdict: "verified" };
}

async function fixture(resume?: TradeAgentServerDeps["cmcOwnerResumePending"]) {
  const memory = new MemoryAgentStore(null, () => NOW_SEC * 1000, { chainId: 56, keyStoreAddress: KEYSTORE });
  const store = new Proxy(memory, { get(target, property, receiver): unknown {
    if (property === "durable" || property === "keyEncryptionConfigured") return true;
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } }) as AgentStore;
  const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_SEC * 1000);
  const positions = new MemoryTradePositionStore(() => NOW_SEC * 1000);
  const intents = new MemoryTradeIntentStore(() => NOW_SEC * 1000);
  const cmc = new MemoryTradeCmcStore(() => NOW_SEC * 1000);
  const balances = { native: CAP + SETUP_COST, grantExact: false, fundingReads: 0 };
  const evidence: GrantEvidenceReader = {
    readFunding: async (_wallet, headroom, observedAtSec) => { balances.fundingReads += 1; return {
      version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2, relayGasHeadroomWei: headroom.toString(),
      requiredWei: SETUP_COST.toString(), balanceWei: balances.native.toString() }; },
    readGrant: async pending => balances.grantExact ? exactEvidence(pending) : { relayKeys: [], accountKey: null,
      accountSpend: [], canExecute: [], keyStore: { kind: "missing" }, ownerVerdict: "verified" },
  };
  const venues = { chainId: 56, pancakeRouterV2: ROUTER, pancakeRouterV3: ROUTER_V3, wbnb: WBNB };
  const harness = await createHarness({ seedAgent: false, agentStore: store,
    journal: new MemoryExecutionJournal(() => NOW_SEC * 1000),
    keyStoreReader: { listKeys: async () => [], publicKeyFor: async () => KEY, isValidKey: async () => false },
    tradeAgent: { settingsStore, positions, intents, cmc, ...(resume === undefined ? {} : { cmcOwnerResumePending: resume }), feeBps: 0,
      readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(TOKENS.map(token => token.toLowerCase())), stop() {} },
      tradfiV2CapabilityProbe: async () => "capable" as const,
      dataPlane: { universe: async lane => lane === "bstocks" ? TOKENS.map((address, i) => ({ address, symbol: `STK${i}`, lane,
        source: "fixture", rwa: { platform: "bstocks", underlyingTicker: `STK${i}`, tokenPriceUsd: 1, referencePriceUsd: 1,
          premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
          // R3.1 (D3 seam): an AI-mode pin only admits a direct-venue candidate — this
          // file is about funding checks, not pinning, so give every token one
          // admitted venue rather than relying on the (now AI-irrelevant) capability probe.
          onchainPriceUsd: 1, venues: [{ dex: "pancakeswap" as const, version: "v2" as const, pool: address,
            feeTier: null, quote: USDT_56, quoteSymbol: "USDT", priceUsd: 1, liquidityUsd: 50_000, volume24hUsd: 1, asOf: NOW_SEC * 1_000 }] } })) : [],
        tokensBatch: async addresses => addresses.map(address => ({ address, symbol: "STOCK", priceUsd: 1, marketCapUsd: 1_000_000_000,
          volume24hUsd: 10_000, holders: 100, priceChange24hPct: 0 })), eligibilityBatch: async () => [], security: async () => ({}) },
      observer: { observe: async () => [] } },
    config: { chainId: 56, network: "mainnet", keyStore: KEYSTORE, hireEnabled: true, tradeAgentEnabled: true,
      accountReadSession: READ_CONFIG, trade: tradeConfig({ venues }),
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
    hire: { evidence, nfpm: NFPM, routerV3: ROUTER_V3, wbnb: WBNB, treasury: OWNER, feeBps: 0,
      relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n } });
  harness.provider.tokenBalances.set(USDT_56.toLowerCase(), CAPITAL + DATA);
  return { harness, store, settingsStore, positions, intents, cmc, balances, venues };
}

function readHeaders() {
  const { token } = issueAccountReadSession({ owner: OWNER, nowSec: NOW_SEC,
    signedIssuedAt: BigInt(NOW_SEC), signedExpiry: BigInt(NOW_SEC + 3600), config: READ_CONFIG });
  return { authorization: `Bearer ${token}` };
}

async function provision(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const envelope = await signOwnerAction("provisionAgent", { walletAddress: WALLET, capDayWei: CAP.toString(), ttlSec: 3600,
    sizingPreset: "trade-v1", executionModel: "tradfi", hireRunId: "11111111-1111-4111-8111-111111111111", autoGrant: true, settings: SETTINGS },
  { agentId: id, chainId: 56, network: "mainnet" });
  const response = await call(f.harness, `/agents/${id}/session`, { method: "POST", body: envelope });
  assert.equal(response.status, 200, response.text);
  return envelope;
}

for (const scenario of [
  { name: "funded BNB and short USDT", native: CAP + SETUP_COST, usdt: CAPITAL + DATA - 1n, status: 402 },
  { name: "funded USDT and short BNB", native: CAP + SETUP_COST - 1n, usdt: CAPITAL + DATA, status: 402 },
  { name: "both exact funding targets", native: CAP + SETUP_COST, usdt: CAPITAL + DATA, status: 200 },
] as const) test(`HTTP funding audit: first grant attempt checks ${scenario.name}`, async () => {
  const f = await fixture();
  const envelope = await provision(f, "funding-case");
  f.balances.native = scenario.native;
  f.harness.provider.tokenBalances.set(USDT_56.toLowerCase(), scenario.usdt);
  const response = await call(f.harness, "/agents/funding-case/session/grant-attempt", { method: "POST", body: envelope });
  assert.equal(response.status, scenario.status, response.text);
  if (scenario.status === 402) {
    assert.equal((await f.store.getAgent(OWNER, "funding-case"))?.pendingGrant?.grantAttempt, undefined);
    const funding = (response.body.data as { funding: { quoteRequiredWei: string } }).funding;
    assert.equal(funding.quoteRequiredWei, (CAPITAL + DATA).toString());
  } else assert.equal((response.body.data as { mayInvoke: boolean }).mayInvoke, true);
  assert.equal(f.harness.provider.executeCalls.length, 0);
});

test("HTTP funding audit: an existing grant attempt remains readable without funding or reinvocation", async () => {
  const f = await fixture();
  const envelope = await provision(f, "attempt-recovery");
  const path = "/agents/attempt-recovery/session/grant-attempt";
  const first = await call(f.harness, path, { method: "POST", body: envelope });
  assert.equal(first.status, 200, first.text);
  const firstData = first.body.data as { attemptId: Hex; mayInvoke: boolean };
  const readCount = f.balances.fundingReads;
  f.balances.native = 0n;
  f.harness.provider.tokenBalances.set(USDT_56.toLowerCase(), 0n);
  const recovered = await call(f.harness, path, { method: "POST", body: envelope });
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual({ attemptId: (recovered.body.data as { attemptId: Hex }).attemptId,
    mayInvoke: (recovered.body.data as { mayInvoke: boolean }).mayInvoke }, { attemptId: firstData.attemptId, mayInvoke: false });
  assert.equal(f.balances.fundingReads, readCount);
});

test("HTTP funding audit: activation after grant does not charge the registration target again", async () => {
  const f = await fixture();
  const envelope = await provision(f, "post-grant");
  assert.equal((await call(f.harness, "/agents/post-grant/session/grant-attempt", { method: "POST", body: envelope })).status, 200);
  f.balances.native = CAP;
  f.balances.grantExact = true;
  const response = await call(f.harness, "/agents/post-grant/session", { headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(response.status, 200, response.text);
  assert.equal((await f.store.getAgent(OWNER, "post-grant"))?.status, "armed", response.text);
  assert.equal(f.harness.provider.executeCalls.length, 0);
});

test("HTTP funding audit: activation still refuses one wei below the remaining native cap", async () => {
  const f = await fixture();
  const envelope = await provision(f, "post-grant-short");
  assert.equal((await call(f.harness, "/agents/post-grant-short/session/grant-attempt", { method: "POST", body: envelope })).status, 200);
  f.balances.native = CAP - 1n;
  f.balances.grantExact = true;
  const response = await call(f.harness, "/agents/post-grant-short/session", { headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(response.status, 402, response.text);
  assert.equal((await f.store.getAgent(OWNER, "post-grant-short"))?.status, "provisioning");
});

async function seedExpired(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const spec = tradeSessionSpec({ venues: f.venues, tokens: TOKENS.map(token => ({ token })),
    nativeCaps: [{ limit: CAP, period: "day" }], quoteToken: USDT_56, quoteDailyCapWei: CAPITAL,
    quotePerTradeCapWei: 20n * E, platformFeeBps: 0, expiresAt: NOW_SEC - 1, nowSeconds: NOW_SEC - 3600 });
  await f.store.createAgent({ id, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed",
    httpRuntimeProfile: "trade-v1", sessionFacts: { spec, permissions: validateSessionSpec(spec, { nowSeconds: NOW_SEC - 3600 }),
      publicKey: KEY, expiry: NOW_SEC - 1, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0",
        settlementAsset: "USDT", entryWei: SETTINGS.entryWei, minEntryWei: SETTINGS.minEntryWei!,
        quotePerTradeWei: (20n * E).toString(), capitalQuoteWei: CAPITAL.toString(), cmcNewsEnabled: true, cmcTotalBudgetWei: DATA.toString() } } });
  await f.settingsStore.put({ agentId: id, ownerAddress: OWNER, params: SETTINGS, digest: tradeSettingsDigest(SETTINGS) });
  await f.cmc.putInitial({ agentId: id, ownerAddress: OWNER, wallet: WALLET, totalWei: DATA });
  const row = await f.cmc.get(id, OWNER);
  assert.ok(row);
  const snapshot = f.cmc.snapshot(id);
  f.cmc.restore({ ...snapshot, budget: { ...row, generation: 1, settledWei: 3n * E / 2n,
    reservedWei: E / 10n, allowanceWei: E / 2n, optedIn: false, setupProved: true,
    checkerSessionPublicKey: KEY, sessionExpiry: NOW_SEC - 1, pendingOperationId: "pending-charge" } }, new Map());
}

test("HTTP funding audit: renewal and retry reserve remaining disabled pending CMC exposure", async () => {
  const f = await fixture();
  const id = "renew-exposure";
  await seedExpired(f, id);
  f.harness.provider.tokenBalances.set(USDT_56.toLowerCase(), CAPITAL + E / 2n);
  const renewal = async () => signOwnerAction("renewSession", { ttlSec: 3600 }, { agentId: id, chainId: 56, network: "mainnet" });
  const first = await call(f.harness, `/agents/${id}/session/renew`, { method: "POST", body: await renewal() });
  assert.equal(first.status, 200, first.text);
  const firstData = first.body.data as { grantDigest: Hex; funding: { quoteRequiredWei: string } };
  assert.equal(firstData.funding.quoteRequiredWei, (CAPITAL + E / 2n).toString());
  f.harness.provider.tokenBalances.set(USDT_56.toLowerCase(), CAPITAL + E / 2n - 1n);
  // Operator ruling 2026-09-30: a USDT shortfall never refuses a renewal; it stays visible on `funding`.
  const short = await call(f.harness, `/agents/${id}/session/renew`, { method: "POST", body: await renewal() });
  assert.equal(short.status, 200, short.text);
  const shortData = short.body.data as { funding: { quoteShortfallWei: string; quoteRequiredWei: string } };
  assert.equal(shortData.funding.quoteShortfallWei, "1");
  assert.equal(shortData.funding.quoteRequiredWei, (CAPITAL + E / 2n).toString());
  f.harness.provider.tokenBalances.set(USDT_56.toLowerCase(), CAPITAL + E / 2n);
  const retry = await call(f.harness, `/agents/${id}/session/renew`, { method: "POST", body: await renewal() });
  assert.equal(retry.status, 200, retry.text);
  const retryData = retry.body.data as { grantDigest: Hex; funding: { quoteRequiredWei: string } };
  assert.equal(retryData.grantDigest, firstData.grantDigest);
  assert.equal(retryData.funding.quoteRequiredWei, (CAPITAL + E / 2n).toString());
});

test("HTTP read audit: owner bearer resumes the stored CMC callsId and rereads the adopted budget", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const resumed: string[] = [];
  f = await fixture(async input => {
    resumed.push(`${input.agentId}|${input.operationId}|${input.callsId}`);
    const current = await f.cmc.getOwnerOperation(input.agentId, input.ownerAddress, input.operationId);
    assert.ok(current);
    const adopted = await f.cmc.confirmOwnerOperation({ ...input, expectedGeneration: current.expectedGeneration,
      allowanceWei: DATA, executionProof: { chainId: 56, wallet: WALLET, txHash: H, blockHash: H,
        blockNumber: 100n, blockTimestamp: BigInt(NOW_SEC), intentId: H, executionNonce: 1n } });
    return { operation: adopted?.operation ?? null, reason: null };
  });
  const id = "cmc-resume-read";
  const spec = tradeSessionSpec({ venues: f.venues, tokens: TOKENS.map(token => ({ token })), nativeCaps: [{ limit: CAP, period: "day" }],
    quoteToken: USDT_56, quoteDailyCapWei: CAPITAL, quotePerTradeCapWei: 20n * E, platformFeeBps: 0,
    expiresAt: NOW_SEC + 3600, nowSeconds: NOW_SEC });
  await f.store.createAgent({ id, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey", status: "armed",
    sessionFacts: { spec, permissions: validateSessionSpec(spec, { nowSeconds: NOW_SEC }), publicKey: KEY, expiry: NOW_SEC + 3600,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0", settlementAsset: "USDT" } } });
  await f.settingsStore.put({ agentId: id, ownerAddress: OWNER, params: SETTINGS, digest: tradeSettingsDigest(SETTINGS) });
  await f.cmc.putInitial({ agentId: id, ownerAddress: OWNER, wallet: WALLET, totalWei: DATA });
  const calls = [buildIncreaseAllowanceCall({ amountWei: DATA }), buildCheckerApprovalCall({ wallet: WALLET, keyHash: H, approved: true })];
  assert.ok(await f.cmc.prepareOwnerOperation({ operationId: "pending-owner", agentId: id, ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: DATA, sessionPublicKey: KEY, sessionExpiry: NOW_SEC + 3600,
    priorAllowanceWei: 0n, expectedAllowanceWei: DATA, wallet: WALLET, oldCheckerKeyHash: null, keyHash: H, callsDigest: H, calls }));
  assert.ok(await f.cmc.recordOwnerAttempt({ operationId: "pending-owner", agentId: id, ownerAddress: OWNER, attemptId: "owner-attempt", callsId: H }));
  assert.equal((await call(f.harness, `/agents/${id}/trade/view`)).status, 401);
  assert.deepEqual(resumed, []);
  const headers = readHeaders();
  const first = await call(f.harness, `/agents/${id}/trade/view`, { headers });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(resumed, [`${id}|pending-owner|${H}`]);
  const budget = (first.body.data as { cmcBudget: { generation: number; authorizedTotalWei: string } }).cmcBudget;
  assert.equal(budget.generation, 1);
  assert.equal(budget.authorizedTotalWei, DATA.toString());
  assert.equal((await call(f.harness, `/agents/${id}/trade/view`, { headers })).status, 200);
  assert.equal(resumed.length, 1);
  assert.equal(f.harness.provider.executeCalls.length, 0);
});

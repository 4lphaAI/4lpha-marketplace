/**
 * CMC-HIRE-SETUP — `POST /agents/:id/trade/cmc-budget` accepts the provision
 * continuation (spec R1, Revision 2 R1.2'/R1.3/R1.11), and the adopted-leftover
 * amount (R2) is a recorded, readable fact.
 *
 * The fixture is `test/audit.tradfiHttpFunding.test.ts`'s shared HTTP harness
 * pattern (a real signed `provisionAgent` hire driven through grant-attempt and
 * activation), extended with a `cmcOwner` built from `createCmcOwnerService`
 * over configurable chain/capability fakes — the "existing CMC test fakes" the
 * spec names, matching `test/tradfiCmcAdoptLeftover.test.ts`'s style.
 */
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
import {
  createCmcOwnerService,
  hireCmcUuid,
  type CmcOwnerStateReader,
  type CmcOwnerCall,
} from "../src/trade/cmcOwnerService.js";
import type { CmcCapabilityGate, CmcCapabilityVerdict } from "../src/trade/cmcCapability.js";
import { ERC20_INCREASE_ALLOWANCE_SELECTOR } from "../src/trade/cmcOwnerService.js";
import { USDT_56 } from "../src/trade/settlement.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import type { TradeAgentServerDeps } from "../src/server.js";
import { call, createHarness, NOW_SEC, ownerAccount, signOwnerAction, toReadHeader, tradeConfig, errorCode } from "./support/serverHarness.js";

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
const LEFTOVER = 187n * E / 100n; // 1.87 USDT, the measured re-hire residual (memory `lp-rotate-unknown-mint-is-doorless` sibling hotfix)
const KEY = `0x04${"77".repeat(64)}` as Hex;
const OWNER = ownerAccount.address;
const SETTINGS: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: CAPITAL.toString(),
  cmcNewsEnabled: true, cmcTotalBudgetWei: DATA.toString() };
const SETTINGS_NO_CMC: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: (5n * E).toString(), entryWei: (20n * E).toString(), capitalQuoteWei: CAPITAL.toString(),
  cmcNewsEnabled: false };
const HIRE_RUN_ID = "11111111-1111-4111-8111-111111111111";
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

/** The mutable chain/capability fakes `createCmcOwnerService` reads through. */
function cmcOwnerFakes() {
  const state = { capabilityAvailable: true, allowanceWei: 0n, checkerApproved: false, oldCheckerKeyHash: null as Hex | null };
  const capability: CmcCapabilityGate = {
    check: async () => (state.capabilityAvailable
      ? { available: true, profileId: "reviewed" } as unknown as CmcCapabilityVerdict
      : { available: false, reason: "cmc-profile-unavailable" }),
  };
  const chain: CmcOwnerStateReader = {
    readState: async () => ({ allowanceWei: state.allowanceWei, checkerApproved: state.checkerApproved, oldCheckerKeyHash: state.oldCheckerKeyHash }),
    // A deterministic "the chain did exactly what the plan said" verifier: it
    // re-derives every fact from the operation it is handed, exactly as the
    // real relay-backed reader re-derives from finalized receipts.
    verifyOwnerExecution: async ({ operation, callsId }) => ({
      finalized: true, callsDigest: operation.callsDigest,
      allowanceWei: operation.expectedAllowanceWei ?? operation.incrementWei,
      checkerApproved: true, sessionKeyHash: operation.keyHash,
      executionProof: { chainId: 56, wallet: operation.wallet, txHash: callsId, blockHash: callsId,
        blockNumber: 1n, blockTimestamp: BigInt(NOW_SEC), intentId: callsId, executionNonce: 1n },
    }),
  };
  return { state, capability, chain };
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
  const { state: cmcChainState, capability, chain } = cmcOwnerFakes();
  const cmcOwner = createCmcOwnerService({ store: cmc, capability, chain, now: () => NOW_SEC * 1000 });
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
    tradeAgent: { settingsStore, positions, intents, cmc, cmcOwner, ...(resume === undefined ? {} : { cmcOwnerResumePending: resume }), feeBps: 0,
      readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(TOKENS.map(token => token.toLowerCase())), stop() {} },
      tradfiV2CapabilityProbe: async () => "capable" as const,
      dataPlane: { universe: async lane => lane === "bstocks" ? TOKENS.map((address, i) => ({ address, symbol: `STK${i}`, lane,
        source: "fixture", rwa: { platform: "bstocks", underlyingTicker: `STK${i}`, tokenPriceUsd: 1, referencePriceUsd: 1,
          premiumBps: 0, openState: true, marketStatus: "regular", reasonCode: "TRADING", staleness: "fresh", tokenToShareRatio: 1,
          // Master 6735bd2 (aggregator activation): an AI-mode pin admits only a
          // direct-venue candidate, so every fixture token carries one admitted venue.
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
  return { harness, store, settingsStore, positions, intents, cmc, cmcChainState, balances, venues };
}

function readHeaders() {
  const { token } = issueAccountReadSession({ owner: OWNER, nowSec: NOW_SEC,
    signedIssuedAt: BigInt(NOW_SEC), signedExpiry: BigInt(NOW_SEC + 3600), config: READ_CONFIG });
  return { authorization: `Bearer ${token}` };
}

async function provision(f: Awaited<ReturnType<typeof fixture>>, id: string, settings: TradeSettings = SETTINGS) {
  const envelope = await signOwnerAction("provisionAgent", { walletAddress: WALLET, capDayWei: CAP.toString(), ttlSec: 3600,
    sizingPreset: "trade-v1", executionModel: "tradfi", hireRunId: HIRE_RUN_ID, autoGrant: true, settings },
  { agentId: id, chainId: 56, network: "mainnet" });
  const response = await call(f.harness, `/agents/${id}/session`, { method: "POST", body: envelope });
  assert.equal(response.status, 200, response.text);
  return envelope;
}

/** Drive a provisioned hire through grant-attempt and activation to "armed". */
async function arm(f: Awaited<ReturnType<typeof fixture>>, id: string, envelope: Awaited<ReturnType<typeof provision>>) {
  const attempt = await call(f.harness, `/agents/${id}/session/grant-attempt`, { method: "POST", body: envelope });
  assert.equal(attempt.status, 200, attempt.text);
  f.balances.native = CAP;
  f.balances.grantExact = true;
  const activated = await call(f.harness, `/agents/${id}/session`, { headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(activated.status, 200, activated.text);
  const agent = await f.store.getAgent(OWNER, id);
  assert.equal(agent?.status, "armed", "hire must reach armed before the CMC continuation is exercised");
  return agent!;
}

function cmcBudget(body: Record<string, unknown>): { operationId: string; state: string; calls: readonly CmcOwnerCall[];
  meta: { authority?: string }; continuationAttemptId?: string; budget: { adoptedWei: string; authorizedTotalWei: string } } {
  return { ...(body["data"] as object), meta: body["meta"] } as never;
}

test("CMC hire setup: continuation prepare happy path on a clean wallet", async () => {
  const f = await fixture();
  const id = "cmc-continuation-happy";
  const envelope = await provision(f, id, SETTINGS);
  const agent = await arm(f, id, envelope);
  const provisionActionId = agent.sessionFacts!.provisionActionId!;
  const expectedOperationId = hireCmcUuid(provisionActionId, "cmc-hire-setup:v1");
  assert.match(expectedOperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  const response = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(response.status, 200, response.text);
  const parsed = cmcBudget(response.body);
  assert.equal(parsed.operationId, expectedOperationId);
  assert.equal(parsed.state, "prepared");
  assert.equal(parsed.meta.authority, "provision-continuation");
  assert.ok(typeof parsed.continuationAttemptId === "string" && parsed.continuationAttemptId.length > 0);
  assert.equal(parsed.calls.length, 2);
  assert.equal(getAddress(parsed.calls[0]!.to), USDT_56);
  assert.equal(parsed.calls[0]!.data.slice(0, 10).toLowerCase(), ERC20_INCREASE_ALLOWANCE_SELECTOR);
  assert.equal(getAddress(parsed.calls[1]!.to), WALLET);
});

test("CMC hire setup: replay returns the same operation, and confirmed after confirm", async () => {
  const f = await fixture();
  const id = "cmc-continuation-replay";
  const envelope = await provision(f, id, SETTINGS);
  await arm(f, id, envelope);

  const first = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(first.status, 200, first.text);
  const firstParsed = cmcBudget(first.body);

  const replay = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(replay.status, 200, replay.text);
  const replayParsed = cmcBudget(replay.body);
  assert.equal(replayParsed.operationId, firstParsed.operationId);
  assert.equal(replayParsed.state, "prepared");

  const headers = readHeaders();
  const attemptRes = await call(f.harness, `/agents/${id}/trade/cmc-budget/attempt`, { method: "POST", headers,
    body: { operationId: firstParsed.operationId, attemptId: firstParsed.continuationAttemptId } });
  assert.equal(attemptRes.status, 200, attemptRes.text);
  const callsId = `0x${"aa".repeat(32)}` as Hex;
  const confirmRes = await call(f.harness, `/agents/${id}/trade/cmc-budget/confirm`, { method: "POST", headers,
    body: { operationId: firstParsed.operationId, callsId } });
  assert.equal(confirmRes.status, 200, confirmRes.text);

  const afterConfirm = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(afterConfirm.status, 200, afterConfirm.text);
  assert.equal(cmcBudget(afterConfirm.body).state, "confirmed");
});

test("CMC hire setup: an envelope that never opted in to CMC is refused", async () => {
  const f = await fixture();
  const id = "cmc-continuation-no-optin";
  const envelope = await provision(f, id, SETTINGS_NO_CMC);
  await arm(f, id, envelope);
  const response = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(response.status, 409, response.text);
  assert.equal(errorCode(response.body), "conflict");
});

test("CMC hire setup: refused when the trade settings changed since the hire", async () => {
  const f = await fixture();
  const id = "cmc-continuation-settings-changed";
  const envelope = await provision(f, id, SETTINGS);
  await arm(f, id, envelope);
  const changed = { ...SETTINGS, crashProtection: false };
  await f.settingsStore.put({ agentId: id, ownerAddress: OWNER, params: changed, digest: tradeSettingsDigest(changed) });
  const response = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(response.status, 409, response.text);
  assert.equal(errorCode(response.body), "conflict");
});

test("CMC hire setup: both authorities present is refused", async () => {
  const f = await fixture();
  const both = await call(f.harness, "/agents/whatever/trade/cmc-budget", { method: "POST", body: {},
    headers: { "x-provision-action": "placeholder", "x-owner-action": "placeholder" } });
  assert.equal(both.status, 400);
  assert.equal(errorCode(both.body), "ambiguous_owner_auth");
  const withBearer = await call(f.harness, "/agents/whatever/trade/cmc-budget", { method: "POST", body: {},
    headers: { "x-provision-action": "placeholder", authorization: "Bearer x" } });
  assert.equal(withBearer.status, 400);
  assert.equal(errorCode(withBearer.body), "ambiguous_owner_auth");
});

test("CMC hire setup: a non-empty body is refused", async () => {
  const f = await fixture();
  const response = await call(f.harness, "/agents/whatever/trade/cmc-budget", { method: "POST", body: { foo: 1 },
    headers: { "x-provision-action": "placeholder" } });
  assert.equal(response.status, 400);
  assert.equal(errorCode(response.body), "ambiguous_owner_auth");
});

test("CMC hire setup: a garbled envelope is unauthorized, an unknown agent is not found", async () => {
  const f = await fixture();
  const garbled = await call(f.harness, "/agents/whatever/trade/cmc-budget", { method: "POST", body: {},
    headers: { "x-provision-action": "not-valid-base64url-json" } });
  assert.equal(garbled.status, 401);
  assert.equal(errorCode(garbled.body), "owner_auth_failed");

  const unknownId = "cmc-continuation-unknown-agent";
  const envelope = await signOwnerAction("provisionAgent", { walletAddress: WALLET, capDayWei: CAP.toString(), ttlSec: 3600,
    sizingPreset: "trade-v1", executionModel: "tradfi", hireRunId: HIRE_RUN_ID, autoGrant: true, settings: SETTINGS },
  { agentId: unknownId, chainId: 56, network: "mainnet" });
  const notFound = await call(f.harness, `/agents/${unknownId}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(notFound.status, 404);
  assert.equal(errorCode(notFound.body), "not_found");
});

test("CMC hire setup: the capability gate refusing is retryable, an already-set-up budget is final", async () => {
  const f = await fixture();
  const id = "cmc-continuation-capability-refused";
  const envelope = await provision(f, id, SETTINGS);
  await arm(f, id, envelope);
  f.cmcChainState.capabilityAvailable = false;
  const refused = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(errorCode(refused.body), "cmc_setup_unavailable");
  // 2026-09-23: the refusal names the gate's reason on both doors.
  assert.equal((refused.body["error"] as { message?: string }).message, "cmc-profile-unavailable");
  const agent = (await f.store.getAgent(OWNER, id))!;
  const signed = await signOwnerAction("tradeCmcBudget", { mode: "topup", expectedGeneration: 0,
    additionalBudgetWei: DATA.toString(), sessionPublicKey: agent.sessionFacts!.publicKey, sessionExpiry: agent.sessionFacts!.expiry,
    operationId: hireCmcUuid(agent.sessionFacts!.provisionActionId!, "cmc-hire-signed-refusal:v1") },
  { agentId: id, chainId: 56, network: "mainnet" });
  const signedRefused = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: signed });
  assert.equal(signedRefused.status, 409, signedRefused.text);
  assert.equal(errorCode(signedRefused.body), "cmc_capability_unavailable");
  assert.equal((signedRefused.body["error"] as { message?: string }).message, "cmc-profile-unavailable");

  // A separate fixture: the wallet is a single-occupancy resource, and the
  // first agent above is still armed on it.
  const f2 = await fixture();
  const id2 = "cmc-continuation-already-set-up";
  const envelope2 = await provision(f2, id2, SETTINGS);
  await arm(f2, id2, envelope2);
  const row = await f2.cmc.putInitial({ agentId: id2, ownerAddress: OWNER, wallet: WALLET, totalWei: DATA });
  const snapshot = f2.cmc.snapshot(id2);
  f2.cmc.restore({ ...snapshot, budget: { ...row, setupProved: true, allowanceWei: DATA,
    checkerSessionPublicKey: KEY, sessionExpiry: NOW_SEC + 7_200 } }, new Map());
  f2.cmcChainState.allowanceWei = DATA;
  const already = await call(f2.harness, `/agents/${id2}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope2) } });
  assert.equal(already.status, 409, already.text);
  assert.equal(errorCode(already.body), "conflict");
});

test("CMC hire setup: the initial confirm adopts a leftover allowance and the view shows it", async () => {
  const f = await fixture();
  const id = "cmc-continuation-adopts";
  const envelope = await provision(f, id, SETTINGS);
  await arm(f, id, envelope);
  f.cmcChainState.allowanceWei = LEFTOVER;

  const prepared = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(prepared.status, 200, prepared.text);
  const parsed = cmcBudget(prepared.body);

  const headers = readHeaders();
  assert.equal((await call(f.harness, `/agents/${id}/trade/cmc-budget/attempt`, { method: "POST", headers,
    body: { operationId: parsed.operationId, attemptId: parsed.continuationAttemptId } })).status, 200);
  const callsId = `0x${"bb".repeat(32)}` as Hex;
  const confirmed = await call(f.harness, `/agents/${id}/trade/cmc-budget/confirm`, { method: "POST", headers,
    body: { operationId: parsed.operationId, callsId } });
  assert.equal(confirmed.status, 200, confirmed.text);

  const view = await call(f.harness, `/agents/${id}/trade/view`, { headers });
  assert.equal(view.status, 200, view.text);
  const cmcView = (view.body["data"] as { cmcBudget: { adoptedWei: string; authorizedTotalWei: string } }).cmcBudget;
  assert.equal(cmcView.adoptedWei, LEFTOVER.toString(10));
  assert.equal(cmcView.authorizedTotalWei, (LEFTOVER + DATA).toString(10));
});

test("CMC hire setup: restore backfills adoptedWei for a legacy confirmed snapshot", async () => {
  const store = new MemoryTradeCmcStore(() => NOW_SEC * 1000);
  const agentId = "cmc-restore-backfill";
  await store.putInitial({ agentId, ownerAddress: OWNER, wallet: WALLET, totalWei: DATA });
  const H = `0x${"cc".repeat(32)}` as Hex;
  assert.ok(await store.prepareOwnerOperation({ operationId: "op-legacy", agentId, ownerAddress: OWNER,
    mode: "topup", expectedGeneration: 0, incrementWei: DATA, sessionPublicKey: KEY, sessionExpiry: NOW_SEC + 3_600,
    priorAllowanceWei: LEFTOVER, expectedAllowanceWei: LEFTOVER + DATA, wallet: WALLET, oldCheckerKeyHash: null,
    keyHash: H, callsDigest: H, calls: [] }));
  assert.ok(await store.recordOwnerAttempt({ operationId: "op-legacy", agentId, ownerAddress: OWNER, attemptId: "attempt-legacy" }));
  const confirmed = await store.confirmOwnerOperation({ operationId: "op-legacy", agentId, ownerAddress: OWNER,
    expectedGeneration: 0, callsId: H, allowanceWei: LEFTOVER + DATA,
    executionProof: { chainId: 56, wallet: WALLET, txHash: H, blockHash: H, blockNumber: 1n, blockTimestamp: 1n, intentId: H, executionNonce: 1n } });
  assert.ok(confirmed);
  assert.equal(confirmed.budget.adoptedWei, LEFTOVER);

  // Simulate a pre-phase snapshot that never recorded `adoptedWei`.
  const snapshot = store.snapshot(agentId);
  const { adoptedWei: _drop, ...legacyBudget } = snapshot.budget!;
  store.restore({ ...snapshot, budget: legacyBudget }, new Map());
  const backfilled = await store.get(agentId, OWNER);
  assert.equal(backfilled?.adoptedWei, LEFTOVER);
});

test("CMC hire setup: the signed tradeCmcBudget path is unchanged by the refactor", async () => {
  const f = await fixture();
  const id = "cmc-signed-path-unchanged";
  const envelope = await provision(f, id, SETTINGS);
  const agent = await arm(f, id, envelope);
  const signed = await signOwnerAction("tradeCmcBudget", { mode: "topup", expectedGeneration: 0,
    additionalBudgetWei: DATA.toString(), sessionPublicKey: agent.sessionFacts!.publicKey, sessionExpiry: agent.sessionFacts!.expiry,
    operationId: hireCmcUuid(agent.sessionFacts!.provisionActionId!, "cmc-hire-signed-test:v1") },
  { agentId: id, chainId: 56, network: "mainnet" });
  const response = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: signed });
  assert.equal(response.status, 200, response.text);
  const data = response.body["data"] as { operationId: string; mode: string; calls: readonly CmcOwnerCall[]; state: string };
  assert.equal(data.mode, "topup");
  assert.equal(data.state, "prepared");
  assert.equal(data.calls.length, 2);
  assert.equal((response.body["meta"] as { authority?: string }).authority, undefined);
});

test("CMC hire setup R1.11: a callsId hint recorded on the attempt is resumed by the view, a different one is refused", async () => {
  const resumed: string[] = [];
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async input => {
    resumed.push(`${input.agentId}|${input.operationId}|${input.callsId}`);
    const current = await f.cmc.getOwnerOperation(input.agentId, input.ownerAddress, input.operationId);
    return { operation: current, reason: null };
  });
  const id = "cmc-continuation-callsid-hint";
  const envelope = await provision(f, id, SETTINGS);
  await arm(f, id, envelope);

  const prepared = await call(f.harness, `/agents/${id}/trade/cmc-budget`, { method: "POST", body: {},
    headers: { "x-provision-action": toReadHeader(envelope) } });
  assert.equal(prepared.status, 200, prepared.text);
  const parsed = cmcBudget(prepared.body);
  const headers = readHeaders();

  const firstAttempt = await call(f.harness, `/agents/${id}/trade/cmc-budget/attempt`, { method: "POST", headers,
    body: { operationId: parsed.operationId, attemptId: parsed.continuationAttemptId } });
  assert.equal(firstAttempt.status, 200, firstAttempt.text);

  const hint = `0x${"dd".repeat(32)}` as Hex;
  const withHint = await call(f.harness, `/agents/${id}/trade/cmc-budget/attempt`, { method: "POST", headers,
    body: { operationId: parsed.operationId, attemptId: parsed.continuationAttemptId, callsId: hint } });
  assert.equal(withHint.status, 200, withHint.text);

  assert.deepEqual(resumed, []);
  const view = await call(f.harness, `/agents/${id}/trade/view`, { headers });
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(resumed, [`${id}|${parsed.operationId}|${hint}`]);

  const differentHint = `0x${"ee".repeat(32)}` as Hex;
  const conflicting = await call(f.harness, `/agents/${id}/trade/cmc-budget/attempt`, { method: "POST", headers,
    body: { operationId: parsed.operationId, attemptId: parsed.continuationAttemptId, callsId: differentHint } });
  assert.equal(conflicting.status, 409, conflicting.text);
});

import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import { parseOwnerActionEnvelope } from "../src/http/wire.js";
import { MemoryAgentStore, type AgentStore, type PendingRenewal } from "../src/store/agents.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { MemoryTradePositionStore } from "../src/store/tradePositions.js";
import { MemoryTradeIntentStore } from "../src/store/tradeIntents.js";
import { MemoryTradeCmcStore } from "../src/store/tradeCmc.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest, type TradeSettings } from "../src/trade/settings.js";
import { buildCheckerApprovalCall, createCmcOwnerService, hireCmcUuid, type CmcOwnerService } from "../src/trade/cmcOwnerService.js";
import { CMC_PERMIT2 } from "../src/trade/cmcCapability.js";
import { accountKeyHashForAddress } from "../src/wallet/altana.js";
import { call, createHarness, errorCode, NOW_SEC, ownerAccount, sessionFacts, signOwnerAction, toReadHeader } from "./support/serverHarness.js";

const ID = "renew-cmc";
const OWNER = ownerAccount.address;
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const K1 = privateKeyToAccount(`0x${"31".repeat(32)}`).publicKey;
const K2 = privateKeyToAccount(`0x${"32".repeat(32)}`).publicKey;
const EXPIRY = NOW_SEC + 3600;
const SETTINGS: TradeSettings = { ...DEFAULT_TRADE_SETTINGS, executionModel: "tradfi", settlementAsset: "USDT",
  minEntryWei: "5000000000000000000", entryWei: "20000000000000000000", capitalQuoteWei: "60000000000000000000",
  cmcNewsEnabled: true, cmcTotalBudgetWei: "2000000000000000000" };

async function fixture() {
  const envelope = await signOwnerAction("renewSession", { ttlSec: 604_800 }, { agentId: ID, chainId: 56, network: "mainnet" });
  const parsed = parseOwnerActionEnvelope(envelope);
  assert.ok(parsed.ok);
  const renewActionId = ownerActionIdempotencyKey(parsed.value.signed);
  const memory = new MemoryAgentStore(null, () => NOW_SEC * 1000);
  const state = { agent: await memory.createAgent({ id: ID, ownerAddress: OWNER, walletAddress: WALLET,
    custodyModel: "self-eoa", status: "armed", sessionFacts: { ...sessionFacts(EXPIRY), publicKey: K2, renewActionId } }),
    prepareCalls: 0, available: true, oldCheckerKeyHash: accountKeyHashForAddress(privateKeyToAccount(`0x${"31".repeat(32)}`).address) as Hex | null };
  // Seed the converged swap's persisted facts; route authority must use these,
  // independently of the envelope signature's expiry or renewal history.
  const store = new Proxy(memory, { get(target, property, receiver): unknown {
    if (property === "durable" || property === "keyEncryptionConfigured") return true;
    if (property === "getAgent") return async () => state.agent;
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as AgentStore;
  const settingsStore = new MemoryTradeSettingsStore(store, () => NOW_SEC * 1000);
  await settingsStore.put({ agentId: ID, ownerAddress: OWNER, params: SETTINGS, digest: tradeSettingsDigest(SETTINGS) });
  const cmc = new MemoryTradeCmcStore(() => NOW_SEC * 1000);
  await cmc.putInitial({ agentId: ID, ownerAddress: OWNER, wallet: WALLET, totalWei: 2n * 10n ** 18n });
  const snapshot = cmc.snapshot(ID);
  cmc.restore({ ...snapshot, budget: { ...snapshot.budget!, setupProved: true, generation: 1, checkerSessionPublicKey: K1,
    allowanceWei: 2n * 10n ** 18n, optedIn: true } }, new Map());
  const service = createCmcOwnerService({ store: cmc, now: () => NOW_SEC * 1000,
    capability: { check: async () => state.available ? { available: true, profileId: "reviewed" } as never : { available: false, reason: "cmc-profile-unavailable" } },
    chain: { readState: async () => ({ allowanceWei: 2n * 10n ** 18n, checkerApproved: false, oldCheckerKeyHash: state.oldCheckerKeyHash }),
      verifyOwnerExecution: async ({ operation, callsId }) => ({ finalized: true, callsDigest: operation.callsDigest,
        allowanceWei: 2n * 10n ** 18n, checkerApproved: true, sessionKeyHash: operation.keyHash,
        executionProof: { chainId: 56, wallet: WALLET, txHash: callsId, blockHash: callsId, blockNumber: 1n,
          blockTimestamp: BigInt(NOW_SEC), intentId: callsId, executionNonce: 1n } }) } });
  const cmcOwner: CmcOwnerService = { ...service, prepare: async input => { state.prepareCalls += 1; return service.prepare(input); } };
  const harness = await createHarness({ seedAgent: false, agentStore: store, tradeAgent: { settingsStore,
    positions: new MemoryTradePositionStore(), intents: new MemoryTradeIntentStore(), cmc, cmcOwner, feeBps: 0,
    readiness: { ready: true, allowlistAvailable: true, bstocksAddresses: new Set(), stop() {} },
    dataPlane: { universe: async () => [], tokensBatch: async () => [], eligibilityBatch: async () => [], security: async () => ({}) },
    observer: { observe: async () => [] } }, config: { chainId: 56, network: "mainnet", tradeAgentEnabled: true, hireEnabled: true,
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true } },
    hire: { nfpm: WALLET, routerV3: WALLET, wbnb: WALLET, treasury: OWNER, feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 1n,
      evidence: { readFunding: async () => { throw new Error("No funding read in continuation"); }, readGrant: async () => { throw new Error("No grant read in continuation"); } } } });
  const prepare = (header = toReadHeader(envelope), headers: Record<string, string> = {}, body: unknown = {}) =>
    call(harness, `/agents/${ID}/trade/cmc-budget`, { method: "POST", headers: { "x-renew-action": header, ...headers }, body });
  return { state, cmc, service, settingsStore, harness, envelope, renewActionId, prepare };
}

test("CMC renew rebind: prepares only checker calls with derived identities and zero increment", async () => {
  const f = await fixture();
  const response = await f.prepare();
  assert.equal(response.status, 200, response.text);
  const data = response.body["data"] as { operationId: string; continuationAttemptId: string; mode: string; calls: unknown[]; operation: { incrementWei: string; expectedGeneration: number } };
  assert.equal(data.operationId, hireCmcUuid(f.renewActionId, "cmc-renew-rebind:v1"));
  assert.equal(data.continuationAttemptId, hireCmcUuid(f.renewActionId, "cmc-renew-rebind-attempt:v1"));
  assert.equal(data.mode, "rebind");
  assert.equal(data.operation.incrementWei, "0");
  assert.equal(data.operation.expectedGeneration, 1);
  assert.equal((response.body["meta"] as { authority: string }).authority, "renew-continuation");
  const newHash = accountKeyHashForAddress(privateKeyToAccount(`0x${"32".repeat(32)}`).address);
  const expected = [buildCheckerApprovalCall({ wallet: WALLET, keyHash: f.state.oldCheckerKeyHash!, approved: false }),
    buildCheckerApprovalCall({ wallet: WALLET, keyHash: newHash, approved: true })].map(c => ({ ...c, value: "0" }));
  assert.deepEqual(data.calls, expected);
  assert.ok(JSON.stringify(data.calls).includes(CMC_PERMIT2.slice(2).toLowerCase()));
  const noOld = await fixture();
  noOld.state.oldCheckerKeyHash = null;
  const single = await noOld.prepare();
  assert.equal(single.status, 200, single.text);
  assert.deepEqual((single.body["data"] as { calls: unknown[] }).calls, expected.slice(1));
});

const refusals: readonly { name: string; change: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void; status?: number }[] = [
  { name: "pending renewal", change: f => { f.state.agent = { ...f.state.agent, pendingRenewal: {} as PendingRenewal }; } },
  { name: "older renewal", change: f => { f.state.agent = { ...f.state.agent, sessionFacts: { ...f.state.agent.sessionFacts!, renewActionId: `0x${"aa".repeat(32)}` } }; } },
  { name: "owner mismatch", change: f => {
    f.state.agent = { ...f.state.agent, ownerAddress: WALLET };
    f.settingsStore.get = async () => { throw new Error("Settings must not be read for a different owner"); };
  } },
  { name: "missing session", change: f => { f.state.agent = { ...f.state.agent, sessionFacts: null }; } },
  ...(["revoked", "retired"] as const).map(status => ({ name: status, change: (f: Awaited<ReturnType<typeof fixture>>) => { f.state.agent = { ...f.state.agent, status }; } })),
  { name: "CMC off", change: async f => {
    const { cmcTotalBudgetWei: _budget, ...settings } = SETTINGS;
    const params = { ...settings, cmcNewsEnabled: false };
    await f.settingsStore.put({ agentId: ID, ownerAddress: OWNER, params, digest: tradeSettingsDigest(params) });
  } },
  { name: "budget not set up", change: f => { const s = f.cmc.snapshot(ID); f.cmc.restore({ ...s, budget: { ...s.budget!, setupProved: false } }, new Map()); } },
  { name: "generation zero", change: f => { const s = f.cmc.snapshot(ID); f.cmc.restore({ ...s, budget: { ...s.budget!, generation: 0 } }, new Map()); } },
  { name: "another owner operation", change: f => { const s = f.cmc.snapshot(ID); f.cmc.restore({ ...s, budget: { ...s.budget!, pendingOwnerOperationId: "other" } }, new Map()); } },
];
for (const scenario of refusals) test(`CMC renew rebind: refuses ${scenario.name}`, async () => {
  const f = await fixture();
  await scenario.change(f);
  const response = await f.prepare();
  assert.equal(response.status, 409, response.text);
  assert.equal(errorCode(response.body), "conflict");
  assert.equal(f.state.prepareCalls, 0);
});

for (const [name, action, id, badHash] of [
  ["wrong action", "pause", ID, false], ["wrong agent", "renewSession", "other", false], ["bad paramsHash", "renewSession", ID, true],
] as const) test(`CMC renew rebind: refuses ${name}`, async () => {
  const f = await fixture();
  const envelope = await signOwnerAction(action, { ttlSec: 604_800 }, { agentId: id, chainId: 56, network: "mainnet",
    ...(badHash ? { paramsHash: `0x${"bb".repeat(32)}` as Hex } : {}) });
  const response = await f.prepare(toReadHeader(envelope));
  assert.equal(response.status, 401, response.text);
  assert.equal(errorCode(response.body), "owner_auth_failed");
  assert.equal(f.state.prepareCalls, 0);
});

for (const header of ["x-provision-action", "x-owner-action", "authorization"]) test(`CMC renew rebind: refuses mixed ${header}`, async () => {
  const f = await fixture();
  const response = await f.prepare(undefined, { [header]: "other" });
  assert.equal(response.status, 400, response.text);
  assert.equal(errorCode(response.body), "ambiguous_owner_auth");
  assert.equal(f.state.prepareCalls, 0);
});

test("CMC renew rebind: refuses non-empty body", async () => {
  const f = await fixture();
  const response = await f.prepare(undefined, {}, { foo: 1 });
  assert.equal(response.status, 400, response.text);
  assert.equal(errorCode(response.body), "ambiguous_owner_auth");
});

test("CMC renew rebind: alreadyBound skips prepare case-insensitively", async () => {
  const f = await fixture();
  const s = f.cmc.snapshot(ID);
  f.cmc.restore({ ...s, budget: { ...s.budget!, checkerSessionPublicKey: `0x${K2.slice(2).toUpperCase()}` } }, new Map());
  const response = await f.prepare();
  assert.equal(response.status, 200, response.text);
  assert.equal((response.body["data"] as { alreadyBound: boolean }).alreadyBound, true);
  assert.equal(f.state.prepareCalls, 0);
});

test("CMC renew rebind: replay before confirm returns the same operation", async () => {
  const f = await fixture();
  const first = await f.prepare();
  const replay = await f.prepare();
  assert.equal(first.status, 200, first.text);
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.body, first.body);
  assert.equal(f.cmc.snapshot(ID).ownerOperations.length, 1);
  const data = first.body["data"] as { operationId: string; continuationAttemptId: string };
  assert.ok(await f.service.recordAttempt({ agentId: ID, ownerAddress: OWNER, operationId: data.operationId, attemptId: data.continuationAttemptId }));
  assert.ok(await f.service.confirm({ agentId: ID, ownerAddress: OWNER, operationId: data.operationId, callsId: `0x${"99".repeat(32)}` }));
  const after = await f.prepare();
  assert.equal(after.status, 200, after.text);
  assert.equal((after.body["data"] as { alreadyBound: boolean }).alreadyBound, true);
});

test("CMC renew rebind: capability refusal names the retryable reason", async () => {
  const f = await fixture();
  f.state.available = false;
  const response = await f.prepare();
  assert.equal(response.status, 409, response.text);
  assert.equal(errorCode(response.body), "cmc_setup_unavailable");
  assert.equal((response.body["error"] as { message: string }).message, "cmc-profile-unavailable");
});

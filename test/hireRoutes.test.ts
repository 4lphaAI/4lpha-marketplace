import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalEncode } from "../src/auth/canonical.js";
import { AgentWalletInUseError, MemoryAgentStore, type AgentStore, type PendingGrant } from "../src/store/agents.js";
import { MemoryExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import { parseAccountReadSessionSecret, verifyAccountReadSession } from "../src/auth/accountReadSession.js";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { parseHireParams, parseOwnerActionEnvelope } from "../src/http/wire.js";
import { lpSettingsParamsView } from "../src/http/lpWire.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import { DEFAULT_TRADE_SETTINGS } from "../src/trade/settings.js";
import { DEFAULT_LP_SETTINGS, type LpGridSettings } from "../src/lp/triggers.js";
import { gridDeriveRanges } from "../src/lp/gridGeometry.js";
import {
  call,
  createHarness,
  EXEC_TOKEN,
  NOW_SEC,
  OTHER_OWNER_PK,
  ownerAccount,
  otherOwnerAccount,
  signOwnerAction,
  toReadHeader,
  type Harness,
  type SignedEnvelope,
} from "./support/serverHarness.js";

const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const TOKEN = getAddress("0x3000000000000000000000000000000000000003");
const NFPM = getAddress("0x4000000000000000000000000000000000000004");
const ROUTER = getAddress("0x5000000000000000000000000000000000000005");
const WBNB = getAddress("0x6000000000000000000000000000000000000006");
const TREASURY = getAddress("0x7000000000000000000000000000000000000007");
const KEYSTORE = getAddress("0x8000000000000000000000000000000000000008");
const RENEWAL_OLD_KEY = `0x${"99".repeat(32)}` as Hex;

type EvidenceMode = "absent" | "exact" | "unreadable" | "unreadable-snapshot";

function exactEvidence(pending: PendingGrant): GrantEvidenceSnapshot {
  return {
    relayKeys: [{
      hash: pending.accountKeyHash,
      expiry: pending.expiresAt,
      role: "session",
      permissions: {
        calls: [...pending.permissions.calls.map((call) => ({
          ...("to" in call ? { to: call.to } : {}),
          ...("signature" in call ? { signature: toFunctionSelector(call.signature) } : {}),
        })), { to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", signature: "0x32323232" }],
        spend: pending.permissions.spend,
      },
    }],
    accountKey: { expiry: pending.expiresAt, isSuperAdmin: false },
    accountSpend: pending.permissions.spend,
    canExecute: [...pending.permissions.calls.map(() => true), true],
    keyStore: { kind: "registered", publicKey: pending.sessionPublicKey },
    ownerVerdict: "verified",
  };
}

async function fixture(options: {
  readonly walletOwner?: "missing" | "different" | "unreadable";
  readonly failCreateOnce?: boolean;
  readonly failJournalBeginOnce?: boolean;
  readonly failJournalCommitAfterWriteOnce?: boolean;
  readonly lp?: Parameters<typeof createHarness>[0]["lp"];
} = {}) {
  const memory = new MemoryAgentStore(null, () => NOW_SEC * 1_000, {
    chainId: 56,
    keyStoreAddress: KEYSTORE,
  });
  let failCreate = options.failCreateOnce === true;
  let forceSessionKeyPresent = false;
  const store = new Proxy(memory, {
    get(target, property, receiver): unknown {
      if (property === "durable") return true;
      if (property === "keyEncryptionConfigured") return true;
      if (property === "hasAgentSessionKey" && forceSessionKeyPresent) {
        return async () => true;
      }
      if (property === "createProvisioningAgent") {
        return async (...args: Parameters<AgentStore["createProvisioningAgent"]>) => {
          if (failCreate) {
            failCreate = false;
            throw new Error("injected pre-insert crash");
          }
          return target.createProvisioningAgent(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentStore;
  const memoryJournal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
  let failBegin = options.failJournalBeginOnce === true;
  let failCommit = options.failJournalCommitAfterWriteOnce === true;
  const journal = new Proxy(memoryJournal, {
    get(target, property, receiver): unknown {
      if (property === "begin") {
        return async (...args: Parameters<ExecutionJournal["begin"]>) => {
          if (failBegin) {
            failBegin = false;
            throw new Error("injected pre-journal crash");
          }
          return target.begin(...args);
        };
      }
      if (property === "markCommitted") {
        return async (...args: Parameters<ExecutionJournal["markCommitted"]>) => {
          const result = await target.markCommitted(...args);
          if (failCommit) {
            failCommit = false;
            throw new Error("injected post-journal crash");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExecutionJournal;
  let mode: EvidenceMode = "absent";
  let fundingOverride: Awaited<ReturnType<GrantEvidenceReader["readFunding"]>> | null = null;
  let grantReads = 0;
  let sessionReadMode: "missing" | "invalid" | "unreadable" = "missing";
  let keyStoreReads = 0;
  let finalizedSession: {
    readonly mode: "invalid" | "registered" | "missing" | "unreadable" | "hash-change";
    readonly keyId: Hex;
    readonly publicKey: Hex;
  } = { mode: "unreadable", keyId: `0x${"00".repeat(32)}` as Hex, publicKey: "0x" };
  const finalizedReads: string[] = [];
  const finalizedHash = `0x${"91".repeat(32)}` as Hex;
  const evidence: GrantEvidenceReader = {
    async readFunding(_wallet, relayGasHeadroomWei, observedAtSec) {
      if (mode === "unreadable") throw new Error("rpc failed");
      if (fundingOverride !== null) return {
        ...fundingOverride,
        observedAtSec,
        relayGasHeadroomWei: relayGasHeadroomWei.toString(10),
      };
      return {
        version: 1, observedAtSec, registrationFeeWei: "2", registrations: 2,
        relayGasHeadroomWei: relayGasHeadroomWei.toString(10),
        requiredWei: (4n + relayGasHeadroomWei).toString(10), balanceWei: "1000000",
      };
    },
    async readGrant(pending) {
      grantReads += 1;
      if (mode === "unreadable") throw new Error("rpc failed");
      if (mode === "exact") return exactEvidence(pending);
      if (mode === "unreadable-snapshot") return {
        relayKeys: [], accountKey: null, accountSpend: [], canExecute: [],
        keyStore: { kind: "unreadable" }, ownerVerdict: "verified",
      };
      return {
        relayKeys: [], accountKey: null, accountSpend: [], canExecute: [],
        keyStore: { kind: "missing" }, ownerVerdict: "verified",
      };
    },
  };
  const keyStoreReader: KeyStoreReader = {
    async listKeys() {
      keyStoreReads += 1;
      if (options.walletOwner === "unreadable" || sessionReadMode === "unreadable") throw new Error("rpc failed");
      if (sessionReadMode === "invalid") return [finalizedSession.keyId];
      return options.walletOwner === "different" ? [`0x${"11".repeat(32)}` as Hex] : [];
    },
    async publicKeyFor() { return sessionReadMode === "invalid"
      ? finalizedSession.publicKey : `0x${"22".repeat(64)}` as Hex; },
    async isValidKey() { return false; },
    async finalizedBlock() {
      finalizedReads.push("finalized");
      if (finalizedSession.mode === "unreadable") throw new Error("finalized unavailable");
      return { number: 101n, hash: finalizedHash };
    },
    async blockAt(blockNumber) {
      finalizedReads.push(`block:${blockNumber}`);
      return { number: blockNumber, hash: finalizedSession.mode === "hash-change"
        ? `0x${"92".repeat(32)}` as Hex : finalizedHash };
    },
    async listKeysAt(_wallet, blockNumber) {
      finalizedReads.push(`list:${blockNumber}`);
      return finalizedSession.mode === "missing" ? [] : [finalizedSession.keyId];
    },
    async publicKeyForAt(_wallet, _keyId, blockNumber) {
      finalizedReads.push(`public:${blockNumber}`);
      return finalizedSession.publicKey;
    },
    async isValidKeyAt(_wallet, _keyId, blockNumber) {
      finalizedReads.push(`valid:${blockNumber}`);
      return finalizedSession.mode === "registered";
    },
  };
  const harness = await createHarness({
    seedAgent: false,
    agentStore: store,
    journal,
    keyStoreReader,
    ...(options.lp === undefined ? {} : { lp: options.lp }),
    config: {
      chainId: 56,
      network: "mainnet",
      keyStore: KEYSTORE,
      hireEnabled: true,
      passkey: { enabled: true, rpId: "4lpha.test", origins: ["https://4lpha.test"], uvRequired: true },
      executeRawEnabled: false,
      accountReadSession: {
        key: parseAccountReadSessionSecret("cd".repeat(32))!,
        chainId: 56,
        environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }),
      },
    },
    hire: {
      evidence, nfpm: NFPM, routerV3: ROUTER, wbnb: WBNB, treasury: TREASURY,
      feeBps: 0, relayFeePerSubmitWei: 1n, grantGasHeadroomWei: 3n,
    },
  });
  return {
    harness,
    store,
    setForcedSessionKeyPresent(next: boolean) { forceSessionKeyPresent = next; },
    setMode(next: EvidenceMode) { mode = next; },
    setFunding(next: Awaited<ReturnType<GrantEvidenceReader["readFunding"]>> | null) { fundingOverride = next; },
    setSessionReadMode(next: "missing" | "invalid" | "unreadable") { sessionReadMode = next; },
    setFinalizedSession(
      mode: "invalid" | "registered" | "missing" | "unreadable" | "hash-change",
      keyId: Hex,
      publicKey: Hex,
    ) { finalizedSession = { mode, keyId, publicKey }; },
    finalizedReads: () => [...finalizedReads],
    grantReads: () => grantReads,
    keyStoreReads: () => keyStoreReads,
  };
}

function params() {
  return { walletAddress: WALLET, token: TOKEN, capDayWei: "1053", openNativeBudgetWei: "1000", ttlSec: 3600, sizingPreset: "grid-v1" };
}

function shiftArmPlan(shiftCount = 16): { readonly params: Record<string, unknown>; readonly digest: Hex } {
  const fullGrid: LpGridSettings = {
    pool: { token0: TOKEN, token1: WBNB, fee: 2_500 },
    wbnbIsToken0: false,
    tickSpacing: 50,
    ...gridDeriveRanges({ currentTick: 0, tickSpacing: 50, gapTicks: 50, widthTicks: 50, wbnbIsToken0: false, minTick: -887_272, maxTick: 887_272 }),
    maxFlipsPerDay: 1,
    minNetEdgeBps: 0,
    mode: "shift",
    shift: { gapTicks: 50, widthTicks: 50, deployPctBps: 3_000, driftPctOfGap: 0, shiftsPerDay: shiftCount },
  };
  const settings = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, autoRotate: false, autoHarvest: false, minMinutesBetweenExits: 5, grid: fullGrid });
  const gridView = settings["grid"] as Record<string, unknown>;
  const { buyRange: _buy, sellRange: _sell, ...planGrid } = gridView;
  void _buy;
  void _sell;
  const plan = { kind: "grid", settings: { ...settings, grid: planGrid }, budgetWei: "1000", levels: 2 };
  return { params: plan, digest: keccak256(stringToBytes(canonicalEncode(plan))) };
}

function routedLpArmPlan(): { readonly params: Record<string, unknown>; readonly digest: Hex } {
  const settings = lpSettingsParamsView({ ...DEFAULT_LP_SETTINGS, autoRotate: true, rotateMinHoldMinutes: 5, minMinutesBetweenExits: 5 });
  const plan = { kind: "lp", settings, budgetWei: "1000", selectPool: { by: "fee-apr", window: "24h" }, range: "server-fenced" };
  return { params: plan, digest: keccak256(stringToBytes(canonicalEncode(plan))) };
}

function tradeParams() {
  return {
    walletAddress: WALLET,
    capDayWei: "10000000000000000",
    ttlSec: 3_600,
    sizingPreset: "trade-v1",
    executionModel: "sigma",
    hireRunId: "11111111-1111-4111-8111-111111111111",
    autoGrant: true,
    settings: DEFAULT_TRADE_SETTINGS,
  };
}

async function signed(action: "provisionAgent" | "cancelProvisioning" | "resetGrantAttempt" | "renewSession" | "cancelRenewal" | "read" | "pause" | "unpause" | "changeBudget" | "bindRuntimeProfile" | "revoke", id: string, body: unknown = {}) {
  return signOwnerAction(action, body, { agentId: id, chainId: 56, network: "mainnet" });
}

async function post(harness: Harness, path: string, envelope: SignedEnvelope) {
  return call(harness, path, { method: "POST", body: envelope });
}

describe("marketplace hire routes", () => {
  it("[F1] refuses an unexpired route renewal and refuses lending with the contract code", async () => {
    const f = await fixture({ lp: { store: { listSequences: async () => [] }, readers: {} } as unknown as NonNullable<Parameters<typeof createHarness>[0]["lp"]> });
    const liveId = "renew-f1-route-live";
    const liveExpiry = NOW_SEC + 3_600;
    const liveFacts = {
      spec: { allowedCalls: [{ to: NFPM }], spendCaps: [{ limit: 1_000n, period: "day" as const }], expiresAt: liveExpiry },
      permissions: { calls: [], spend: [] }, publicKey: privateKeyToAccount(RENEWAL_OLD_KEY).publicKey, expiry: liveExpiry,
      hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" },
    };
    await f.store.createAgent({ id: liveId, ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "self-eoa", sessionFacts: liveFacts, status: "armed", httpRuntimeProfile: "lp-v1" });
    const live = await post(f.harness, `/agents/${liveId}/session/renew`, await signed("renewSession", liveId, { ttlSec: 3_600 }));
    assert.equal(live.status, 409, live.text);
    assert.equal((live.body as { error: { code: string; message: string } }).error.code, "renewal_pending");
    assert.match((live.body as { error: { message: string } }).error.message, /Renewal opens when the session ends/u);
    assert.equal((await f.store.getAgent(ownerAccount.address, liveId))?.pendingRenewal, null);

    const lendingId = "renew-f1-route-lending";
    const lendingExpiry = NOW_SEC - 1;
    await f.store.createAgent({ id: lendingId, ownerAddress: ownerAccount.address,
      walletAddress: getAddress("0x9000000000000000000000000000000000000009"), custodyModel: "self-eoa",
      sessionFacts: { ...liveFacts, spec: { ...liveFacts.spec, expiresAt: lendingExpiry }, expiry: lendingExpiry,
        hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: "0" } },
      status: "armed", httpRuntimeProfile: "unbound-v1" });
    const lending = await post(f.harness, `/agents/${lendingId}/session/renew`, await signed("renewSession", lendingId, { ttlSec: 3_600 }));
    assert.equal(lending.status, 409, lending.text);
    assert.equal((lending.body as { error: { code: string } }).error.code, "renewal_unsupported_kind");
  });

  it("[F2] refuses a renewal request while its persisted journal work is pending", async () => {
    const f = await fixture();
    const id = "renew-f2-route-journal";
    const expiry = NOW_SEC - 1;
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "self-eoa", sessionFacts: {
        spec: { allowedCalls: [{ to: NFPM }], spendCaps: [{ limit: 1_000n, period: "day" }], expiresAt: expiry },
        permissions: { calls: [], spend: [] }, publicKey: privateKeyToAccount(RENEWAL_OLD_KEY).publicKey, expiry,
      }, status: "armed", httpRuntimeProfile: "unbound-v1" });
    await f.harness.journal.begin({ idempotencyKey: `0x${"77".repeat(32)}` as Hex, agentId: id,
      ownerAddress: ownerAccount.address, kind: "lp" });
    const response = await post(f.harness, `/agents/${id}/session/renew`, await signed("renewSession", id, { ttlSec: 3_600 }));
    assert.equal(response.status, 409, response.text);
    assert.equal((response.body as { error: { code: string } }).error.code, "renewal_busy");
    assert.match((response.body as { error: { message: string } }).error.message, /journal PENDING/u);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal, null);
  });

  it("[F6] previews and replays renewal routes, binds grant attempts, cancels by digest, and retires the outcome", async () => {
    const f = await fixture({ lp: { store: { listSequences: async () => [] }, readers: {} } as unknown as NonNullable<Parameters<typeof createHarness>[0]["lp"]> });
    const id = "renew-f6-routes";
    const expiry = NOW_SEC - 1;
    const oldFacts = {
      spec: { allowedCalls: [{ to: NFPM }], spendCaps: [{ limit: 1_000n, period: "day" as const }], expiresAt: expiry },
      permissions: { calls: [], spend: [] }, publicKey: privateKeyToAccount(RENEWAL_OLD_KEY).publicKey, expiry,
      hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" },
    };
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "self-eoa", sessionFacts: oldFacts, status: "armed", httpRuntimeProfile: "lp-v1" });

    const previewRead = await signed("read", id);
    const preview = await f.harness.app.request(`/agents/${id}/session/renew/preview`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(previewRead) },
    });
    assert.equal(preview.status, 200);
    const previewData = (await preview.json() as { data: Record<string, unknown> }).data;
    assert.equal(previewData["eligible"], true);
    assert.equal((previewData["previous"] as Record<string, unknown>)["expiry"], expiry);
    assert.equal((previewData["previous"] as Record<string, unknown>)["expired"], true);
    assert.equal((previewData["quiescent"] as Record<string, unknown>)["quiescent"], true);
    assert.deepEqual(Object.keys(previewData).sort(), ["eligible", "funding", "previous", "quiescent"]);

    const first = await signed("renewSession", id, { ttlSec: 3_600 });
    const created = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(created.status, 200, created.text);
    const grantDigest = (created.body["data"] as { grantDigest: Hex }).grantDigest;
    const pendingReplay = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(pendingReplay.status, 200, pendingReplay.text);
    assert.equal((pendingReplay.body["meta"] as { replayed?: boolean }).replayed, true);
    assert.equal((pendingReplay.body["data"] as { grantDigest: Hex }).grantDigest, grantDigest);

    f.setMode("exact");
    const different = await signed("renewSession", id, { ttlSec: 3_600 });
    const pendingConflict = await post(f.harness, `/agents/${id}/session/renew`, different);
    assert.equal(pendingConflict.status, 409, pendingConflict.text);
    assert.equal((pendingConflict.body as { error: { code: string } }).error.code, "renewal_pending");

    const attempt = await post(f.harness, `/agents/${id}/session/renew/grant-attempt`, first);
    assert.equal(attempt.status, 200, attempt.text);
    assert.equal((attempt.body["data"] as { mayInvoke: boolean }).mayInvoke, true);
    const attemptReplay = await post(f.harness, `/agents/${id}/session/renew/grant-attempt`, first);
    assert.equal(attemptReplay.status, 200, attemptReplay.text);
    assert.equal((attemptReplay.body["data"] as { mayInvoke: boolean }).mayInvoke, false);
    const wrongAttempt = await post(f.harness, `/agents/${id}/session/renew/grant-attempt`, different);
    assert.equal(wrongAttempt.status, 409, wrongAttempt.text);

    const cancel = await signed("cancelRenewal", id, { grantDigest });
    const canceled = await post(f.harness, `/agents/${id}/session/renew/cancel`, cancel);
    assert.equal(canceled.status, 200, canceled.text);
    assert.equal((canceled.body["data"] as { phase: string }).phase, "cancelled");
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal?.cancelReason, "owner");
    const canceledReplay = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(canceledReplay.status, 409, canceledReplay.text);
    assert.equal((canceledReplay.body as { error: { code: string } }).error.code, "renewal_cancelled");

    const observedCancel = await post(f.harness, `/agents/${id}/session/renew/cancel`, cancel);
    assert.equal(observedCancel.status, 200, observedCancel.text);
    assert.equal(((observedCancel.body["data"] as { onChainRevoke?: { calls: unknown[] } }).onChainRevoke?.calls ?? []).length, 2);
    const observed = await f.store.getAgent(ownerAccount.address, id);
    assert.notEqual(observed?.pendingRenewal, null);
    assert.notEqual(observed?.pendingRenewal, undefined);
    f.setFinalizedSession("invalid", observed!.pendingRenewal!.keyStoreKeyId, observed!.pendingRenewal!.sessionPublicKey);
    const retired = await post(f.harness, `/agents/${id}/session/renew/cancel`, cancel);
    // The replayed cancel re-runs the finalized K2 proof before retirement.
    assert.equal(retired.status, 200, retired.text);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal, null);
    const gone = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(gone.status, 410, gone.text);
    assert.equal((gone.body as { error: { code: string } }).error.code, "renewal_gone");

    const second = await signed("renewSession", id, { ttlSec: 3_600 });
    const secondCreated = await post(f.harness, `/agents/${id}/session/renew`, second);
    assert.equal(secondCreated.status, 200, secondCreated.text);
    const secondRenewActionId = (secondCreated.body["data"] as { renewActionId: Hex }).renewActionId;
    const sessionRead = await signed("read", id);
    const converged = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(sessionRead) },
    });
    assert.equal(converged.status, 200, await converged.text());
    const current = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(current?.pendingRenewal, null);
    assert.equal(current?.sessionFacts?.renewActionId, secondRenewActionId);
    const historyReplay = await post(f.harness, `/agents/${id}/session/renew`, second);
    assert.equal(historyReplay.status, 200, historyReplay.text);
    assert.equal((historyReplay.body["meta"] as { replayed?: boolean }).replayed, true);
  });

  it("[F10b/F10c/F10d/F10e/F11] retries with fresh funding, clears the bound ledger, and converges under the new id", async () => {
    const f = await fixture({ lp: { store: { listSequences: async () => [] }, readers: {} } as unknown as NonNullable<Parameters<typeof createHarness>[0]["lp"]> });
    const id = "renew-f10-retry";
    const expiry = NOW_SEC - 1;
    const oldFacts = {
      spec: { allowedCalls: [{ to: NFPM }], spendCaps: [{ limit: 1_000n, period: "day" as const }], expiresAt: expiry },
      permissions: { calls: [], spend: [] }, publicKey: privateKeyToAccount(RENEWAL_OLD_KEY).publicKey, expiry,
      hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" },
    };
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "self-eoa", sessionFacts: oldFacts, status: "armed", httpRuntimeProfile: "lp-v1" });
    const first = await signed("renewSession", id, { ttlSec: 3_600 });
    const created = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(created.status, 200, created.text);
    const firstData = created.body["data"] as { grantDigest: Hex; sessionAddress: string; sessionPublicKey: Hex; expiry: number; renewActionId: Hex };
    const storedBefore = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
    assert.notEqual(storedBefore, null);
    assert.notEqual(storedBefore, undefined);
    const firstAttempt = await post(f.harness, `/agents/${id}/session/renew/grant-attempt`, first);
    assert.equal(firstAttempt.status, 200, firstAttempt.text);
    assert.equal((firstAttempt.body["data"] as { mayInvoke: boolean }).mayInvoke, true);

    f.setFunding({ version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "2", registrations: 1,
      relayGasHeadroomWei: "3", requiredWei: "1000001", balanceWei: "1000000" });
    const underfundedAction = await signed("renewSession", id, { ttlSec: 604_800 });
    const underfunded = await post(f.harness, `/agents/${id}/session/renew`, underfundedAction);
    assert.equal(underfunded.status, 402, underfunded.text);
    assert.equal((underfunded.body as { error: { code: string } }).error.code, "renewal_underfunded");
    assert.equal((underfunded.body as { data: { funding: { requiredWei: string; balanceWei: string } } }).data.funding.requiredWei, "1000001");
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal?.renewActionId, firstData.renewActionId);

    f.setFunding({ version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "2", registrations: 1,
      relayGasHeadroomWei: "3", requiredWei: "1", balanceWei: "1000000" });
    const retry = await signed("renewSession", id, { ttlSec: 604_800 });
    const retried = await post(f.harness, `/agents/${id}/session/renew`, retry);
    assert.equal(retried.status, 200, retried.text);
    const retryData = retried.body["data"] as { grantDigest: Hex; sessionAddress: string; sessionPublicKey: Hex; expiry: number; renewActionId: Hex; funding: { requiredWei: string } };
    assert.equal((retried.body["meta"] as { retried?: boolean }).retried, true);
    assert.equal(retryData.grantDigest, firstData.grantDigest);
    assert.equal(retryData.sessionAddress, firstData.sessionAddress);
    assert.equal(retryData.sessionPublicKey, firstData.sessionPublicKey);
    assert.equal(retryData.expiry, firstData.expiry);
    assert.notEqual(retryData.renewActionId, firstData.renewActionId);
    assert.equal(retryData.funding.requiredWei, "1");
    const reopened = (await f.store.getAgent(ownerAccount.address, id))?.pendingRenewal;
    assert.equal(reopened?.funding.requiredWei, storedBefore!.funding.requiredWei);
    assert.equal(reopened?.grantAttempt, undefined);
    assert.equal(reopened?.cancelRequestedAtSec, undefined);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.renewalOutcomes?.find((row) => row.renewActionId === firstData.renewActionId)?.outcome, "superseded");

    const oldAttempt = await post(f.harness, `/agents/${id}/session/renew/grant-attempt`, first);
    assert.equal(oldAttempt.status, 409, oldAttempt.text);
    const newAttempt = await post(f.harness, `/agents/${id}/session/renew/grant-attempt`, retry);
    assert.equal(newAttempt.status, 200, newAttempt.text);
    assert.equal((newAttempt.body["data"] as { mayInvoke: boolean }).mayInvoke, true);
    const oldReplayWhilePending = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(oldReplayWhilePending.status, 409, oldReplayWhilePending.text);
    assert.equal((oldReplayWhilePending.body as { error: { code: string } }).error.code, "renewal_pending");

    f.setMode("exact");
    const read = await signed("read", id);
    const converged = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) },
    });
    assert.equal(converged.status, 200, await converged.text());
    const current = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(current?.pendingRenewal, null);
    assert.equal(current?.sessionFacts?.renewActionId, retryData.renewActionId);
    assert.equal(current?.sessionFacts?.expiry, firstData.expiry);
    assert.equal(current?.sessionFacts?.grantedAtSec, NOW_SEC);
    const executing = await f.store.readExecutingSession(ownerAccount.address, id);
    assert.equal(executing?.facts.renewActionId, retryData.renewActionId);
    const oldReplayAfterDone = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(oldReplayAfterDone.status, 410, oldReplayAfterDone.text);
  });

  it("[F10] reopens an owner-cancelled unobserved descriptor and keeps its cancellation receipt", async () => {
    const f = await fixture({ lp: { store: { listSequences: async () => [] }, readers: {} } as unknown as NonNullable<Parameters<typeof createHarness>[0]["lp"]> });
    const id = "renew-f10-cancelled-retry";
    const expiry = NOW_SEC - 1;
    const oldFacts = {
      spec: { allowedCalls: [{ to: NFPM }], spendCaps: [{ limit: 1_000n, period: "day" as const }], expiresAt: expiry },
      permissions: { calls: [], spend: [] }, publicKey: privateKeyToAccount(RENEWAL_OLD_KEY).publicKey, expiry,
      hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" },
    };
    await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: getAddress("0x2100000000000000000000000000000000000021"),
      custodyModel: "self-eoa", sessionFacts: oldFacts, status: "armed", httpRuntimeProfile: "lp-v1" });
    const first = await signed("renewSession", id, { ttlSec: 3_600 });
    const created = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(created.status, 200, created.text);
    const grantDigest = (created.body["data"] as { grantDigest: Hex }).grantDigest;
    const cancel = await signed("cancelRenewal", id, { grantDigest });
    const canceled = await post(f.harness, `/agents/${id}/session/renew/cancel`, cancel);
    assert.equal(canceled.status, 200, canceled.text);
    const retry = await signed("renewSession", id, { ttlSec: 604_800 });
    const retried = await post(f.harness, `/agents/${id}/session/renew`, retry);
    assert.equal(retried.status, 200, retried.text);
    const outcomes = (await f.store.getAgent(ownerAccount.address, id))?.renewalOutcomes ?? [];
    assert.deepEqual(outcomes.map((row) => row.outcome), ["cancelled"]);
    const oldReplay = await post(f.harness, `/agents/${id}/session/renew`, first);
    assert.equal(oldReplay.status, 409, oldReplay.text);
    assert.equal((oldReplay.body as { error: { code: string } }).error.code, "renewal_cancelled");
  });

  it("[F10g] performs one fail-closed pre-reopen evidence read", async () => {
    const make = async (id: string) => {
      const f = await fixture({ lp: { store: { listSequences: async () => [] }, readers: {} } as unknown as NonNullable<Parameters<typeof createHarness>[0]["lp"]> });
      const expiry = NOW_SEC - 1;
      const oldFacts = {
        spec: { allowedCalls: [{ to: NFPM }], spendCaps: [{ limit: 1_000n, period: "day" as const }], expiresAt: expiry },
        permissions: { calls: [], spend: [] }, publicKey: privateKeyToAccount(RENEWAL_OLD_KEY).publicKey, expiry,
        hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" },
      };
      await f.store.createAgent({ id, ownerAddress: ownerAccount.address, walletAddress: getAddress(`0x${(0x220 + id.length).toString(16).padStart(40, "0")}`),
        custodyModel: "self-eoa", sessionFacts: oldFacts, status: "armed", httpRuntimeProfile: "lp-v1" });
      const first = await signed("renewSession", id, { ttlSec: 3_600 });
      const created = await post(f.harness, `/agents/${id}/session/renew`, first);
      assert.equal(created.status, 200, created.text);
      return { f, first };
    };

    const observed = await make("renew-f10g-observed");
    observed.f.setMode("exact");
    const observedRetry = await post(observed.f.harness, "/agents/renew-f10g-observed/session/renew", await signed("renewSession", "renew-f10g-observed", { ttlSec: 3_600 }));
    assert.equal(observedRetry.status, 409, observedRetry.text);
    assert.equal((observedRetry.body as { error: { code: string } }).error.code, "renewal_pending");
    assert.equal(observed.f.grantReads(), 1);
    assert.equal((await observed.f.store.getAgent(ownerAccount.address, "renew-f10g-observed"))?.pendingRenewal?.authorityObserved, true);

    const unreadable = await make("renew-f10g-unreadable");
    unreadable.f.setMode("unreadable");
    const unreadableRetry = await post(unreadable.f.harness, "/agents/renew-f10g-unreadable/session/renew", await signed("renewSession", "renew-f10g-unreadable", { ttlSec: 3_600 }));
    assert.equal(unreadableRetry.status, 503, unreadableRetry.text);
    assert.equal((await unreadable.f.store.getAgent(ownerAccount.address, "renew-f10g-unreadable"))?.pendingRenewal?.authorityObserved, undefined);

    const resolvedUnreadable = await make("renew-f10g-resolved-unreadable");
    resolvedUnreadable.f.setMode("unreadable-snapshot");
    const resolved = await post(resolvedUnreadable.f.harness, "/agents/renew-f10g-resolved-unreadable/session/renew", await signed("renewSession", "renew-f10g-resolved-unreadable", { ttlSec: 3_600 }));
    assert.equal(resolved.status, 503, resolved.text);
    assert.equal((await resolvedUnreadable.f.store.getAgent(ownerAccount.address, "renew-f10g-resolved-unreadable"))?.pendingRenewal?.authorityObserved, undefined);
  });

  it("requires a durable chain-56 passkey composition at server construction", async () => {
    await assert.rejects(() => createHarness({ seedAgent: false, config: { hireEnabled: true } }), /HIRE_ENABLED requires/u);
  });

  it("returns the mandatory fresh preview from server-owned arithmetic and funding", async () => {
    const f = await fixture();
    const response = await f.harness.app.request(`/agents/hire/preview?walletAddress=${WALLET}&openNativeBudgetWei=1000&sizingPreset=grid-v1`, { headers: { "x-exec-token": EXEC_TOKEN } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { capDayWei: string; sizing: { terms: { maxGridFlipsPerDay: number } }; funding: { observedAtSec: number } } };
    assert.equal(body.data.capDayWei, "1053");
    assert.equal(body.data.sizing.terms.maxGridFlipsPerDay, 12);
    assert.equal(body.data.funding.observedAtSec, NOW_SEC);
  });

  it("accepts a shift arm plan, stores it verbatim, and refuses a profile failure before nonce consumption", async () => {
    const f = await fixture();
    const goodPlan = shiftArmPlan();
    const good = await signed("provisionAgent", "hire-shift-plan", {
      ...params(), capDayWei: "10000", sizingPreset: "grid-shift-v1", armPlan: goodPlan,
    });
    const accepted = await post(f.harness, "/agents/hire-shift-plan/session", good);
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual((await f.store.getAgent(ownerAccount.address, "hire-shift-plan"))?.pendingGrant?.initialArmPlan, {
      params: goodPlan.params, digest: goodPlan.digest, kind: "grid",
    });

    const badPlan = shiftArmPlan(17);
    const bad = await signed("provisionAgent", "hire-shift-plan-bad", {
      ...params(), sizingPreset: "grid-shift-v1", armPlan: badPlan,
    });
    const refused = await post(f.harness, "/agents/hire-shift-plan-bad/session", bad);
    assert.equal(refused.status, 400);
    assert.equal(await f.store.getAgentById("hire-shift-plan-bad"), null);
    assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, bad.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), true);
  });

  it("issues a read session only on a fresh provision and the token reaches only the account-read allowlist", async () => {
    const f = await fixture();
    const action = await signed("provisionAgent", "hire-read-session", { ...params(), capDayWei: "10000" });
    const first = await post(f.harness, "/agents/hire-read-session/session", action);
    const data = first.body["data"] as Record<string, unknown>;
    const readSession = data["readSession"] as { token?: unknown; expiry?: unknown };
    assert.equal(typeof readSession.token, "string");
    assert.equal(typeof readSession.expiry, "number");
    const config = {
      key: parseAccountReadSessionSecret("cd".repeat(32))!, chainId: 56,
      environment: resolveDomainSalt({ chainId: 56, network: "mainnet" }),
    };
    assert.equal(verifyAccountReadSession(readSession.token as string, config, NOW_SEC), ownerAccount.address);
    assert.equal(verifyAccountReadSession(readSession.token as string, config, NOW_SEC + 86_400 - 1), ownerAccount.address);
    assert.equal(verifyAccountReadSession(readSession.token as string, config, NOW_SEC + 86_400), null);
    const replay = await post(f.harness, "/agents/hire-read-session/session", action);
    assert.equal((replay.body["data"] as Record<string, unknown>)["readSession"], undefined);
    const bearer = await f.harness.app.request("/agents/hire-read-session/session", {
      headers: { "x-exec-token": EXEC_TOKEN, authorization: `Bearer ${readSession.token as string}` },
    });
    assert.equal(bearer.status, 200);
  });

  it("marks owned agent_exists responses and never discloses a foreign row", async () => {
    const ownedFixture = await fixture();
    const ownedId = "hire-owned-collision";
    await post(ownedFixture.harness, `/agents/${ownedId}/session`, await signed("provisionAgent", ownedId, params()));
    const ownedRetry = await signed("provisionAgent", ownedId, params());
    const owned = await post(ownedFixture.harness, `/agents/${ownedId}/session`, ownedRetry);
    assert.equal(owned.status, 409);
    assert.deepEqual(owned.body["meta"], { owned: true });
    assert.equal((owned.body["data"] as Record<string, unknown>)["status"], "provisioning");
    assert.equal((owned.body["data"] as Record<string, unknown>)["readSession"], undefined);
    assert.equal(await ownedFixture.harness.nonceStore.consume(ownerAccount.address, ownedRetry.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), true);

    const foreignFixture = await fixture();
    const foreignId = "hire-foreign-collision";
    await foreignFixture.store.createAgent({
      id: foreignId,
      ownerAddress: otherOwnerAccount.address,
      walletAddress: otherOwnerAccount.address,
      custodyModel: "self-eoa",
      status: "armed",
    });
    const foreignRetry = await signed("provisionAgent", foreignId, params());
    const foreign = await post(foreignFixture.harness, `/agents/${foreignId}/session`, foreignRetry);
    assert.equal(foreign.status, 409);
    assert.deepEqual(foreign.body["meta"], { owned: false });
    assert.equal(foreign.body["data"], undefined);
    assert.equal(await foreignFixture.harness.nonceStore.consume(ownerAccount.address, foreignRetry.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), true);
  });

  it("accepts routed and explicit LP arm plans and rejects armPlan on fixed grid, trade, and lending", async () => {
    const f = await fixture();
    const routed = routedLpArmPlan();
    const lp = { ...params(), capDayWei: "10000", sizingPreset: "lp-v1" as const, armPlan: routed };
    const routedResponse = await post(f.harness, "/agents/hire-lp-plan/session", await signed("provisionAgent", "hire-lp-plan", lp));
    assert.equal(routedResponse.status, 200, routedResponse.text);
    assert.equal((await f.store.getAgent(ownerAccount.address, "hire-lp-plan"))?.pendingGrant?.initialArmPlan?.kind, "lp");

    const explicitPlan = {
      kind: "lp",
      settings: routed.params["settings"],
      budgetWei: "1000",
      pool: { address: "0x9000000000000000000000000000000000000009", token0: TOKEN, token1: WBNB, fee: 2_500 },
      prices: { minPrice: 0.9, maxPrice: 1.1, tickSpacing: 50, wbnbIsToken0: false },
    };
    const explicit = { ...lp, armPlan: { params: explicitPlan, digest: keccak256(stringToBytes(canonicalEncode(explicitPlan))) } };
    const explicitFixture = await fixture();
    const explicitResponse = await post(explicitFixture.harness, "/agents/hire-lp-explicit/session", await signed("provisionAgent", "hire-lp-explicit", explicit));
    assert.equal(explicitResponse.status, 200, explicitResponse.text);

    assert.equal(parseHireParams({ ...params(), armPlan: routed }).ok, false);
    assert.equal(parseHireParams({ ...tradeParams(), armPlan: routed }).ok, false);
    assert.equal(parseHireParams({ ...params(), sizingPreset: "lending-v1", armPlan: routed }).ok, false);
  });

  it("persists row+key before the journal and exact retry returns the durable view", async () => {
    const f = await fixture();
    const id = "hire-success";
    const action = await signed("provisionAgent", id, params());
    const first = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(first.status, 200, first.text);
    const row = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(row?.status, "provisioning");
    assert.notEqual(await f.store.getAgentSessionKey(ownerAccount.address, id), null);
    const retry = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(retry.status, 200);
    assert.match(retry.text, /"replayed":true/u);
    const retryAgain = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(retryAgain.status, 200);
    assert.match(retryAgain.text, /"replayed":true/u);
  });

  it("fences and resets an lp-v1 grant attempt with the exact accepted S1", async () => {
    const f = await fixture();
    const id = "lp-grant-fence";
    const lpParams = { ...params(), sizingPreset: "lp-v1" as const };
    const provision = await signed("provisionAgent", id, lpParams);
    assert.equal((await post(f.harness, `/agents/${id}/session`, provision)).status, 200);
    const pending = (await f.store.getAgent(ownerAccount.address, id))?.pendingGrant;
    assert.deepEqual(pending?.sizing, {
      openNativeBudgetWei: lpParams.openNativeBudgetWei,
      capDayWei: lpParams.capDayWei,
      sizingPreset: "lp-v1",
      sizingPresetVersion: 1,
    });
    const parsedProvision = parseOwnerActionEnvelope(provision);
    if (!parsedProvision.ok) assert.fail(parsedProvision.message);
    assert.equal(
      pending?.provisionActionId,
      ownerActionIdempotencyKey(parsedProvision.value.signed),
    );

    const first = await post(f.harness, `/agents/${id}/session/grant-attempt`, provision);
    assert.equal(first.status, 200, first.text);
    const firstData = (first.body as { data: { attemptId: Hex; mayInvoke: boolean } }).data;
    assert.equal(firstData.mayInvoke, true);
    const row = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(firstData.attemptId, keccak256(stringToBytes(canonicalEncode({
      purpose: "lpGrantAttempt/v1",
      provisionActionId: row?.pendingGrant?.provisionActionId,
    }))));

    const replay = await post(f.harness, `/agents/${id}/session/grant-attempt`, provision);
    assert.equal(replay.status, 200, replay.text);
    const replayData = (replay.body as { data: { attemptId: Hex; mayInvoke: boolean } }).data;
    assert.equal(replayData.attemptId, firstData.attemptId);
    assert.equal(replayData.mayInvoke, false);

    const altered = { ...provision, params: { ...lpParams, capDayWei: "1054" } };
    assert.equal((await post(f.harness, `/agents/${id}/session/grant-attempt`, altered)).status, 401);
    const reset = await signed("resetGrantAttempt", id, { attemptId: firstData.attemptId });
    assert.equal((await post(f.harness, `/agents/${id}/session/grant-attempt/reset`, reset)).status, 200);
    const second = await post(f.harness, `/agents/${id}/session/grant-attempt`, provision);
    assert.equal(second.status, 200, second.text);
    assert.equal((second.body as { data: { mayInvoke: boolean } }).data.mayInvoke, true);
  });

  it("requires a fresh signature only for a crash after nonce and before insert", async () => {
    const f = await fixture({ failCreateOnce: true });
    const id = "hire-pre-insert-crash";
    const firstAction = await signed("provisionAgent", id, params());
    const first = await post(f.harness, `/agents/${id}/session`, firstAction);
    assert.equal(first.status, 500);
    assert.equal(await f.store.getAgentById(id), null);
    assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, firstAction.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), false);
    const retrySame = await post(f.harness, `/agents/${id}/session`, firstAction);
    assert.equal(retrySame.status, 401);
    const fresh = await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    assert.equal(fresh.status, 200);
  });

  it("repairs a row written before its journal entry", async () => {
    const f = await fixture({ failJournalBeginOnce: true });
    const id = "hire-pre-journal-crash";
    const action = await signed("provisionAgent", id, params());
    const first = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(first.status, 503);
    assert.equal((await f.store.getAgentById(id))?.status, "provisioning");
    assert.notEqual(await f.store.getAgentSessionKey(ownerAccount.address, id), null);
    const repaired = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(repaired.status, 200);
    assert.match(repaired.text, /"repaired":true/u);
  });

  it("replays the durable row after the journal committed but the response failed", async () => {
    const f = await fixture({ failJournalCommitAfterWriteOnce: true });
    const id = "hire-post-journal-crash";
    const action = await signed("provisionAgent", id, params());
    const first = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(first.status, 503);
    const retry = await post(f.harness, `/agents/${id}/session`, action);
    assert.equal(retry.status, 200);
    assert.match(retry.text, /"replayed":true/u);
  });

  it("spends both nonces when different signatures race one global agent id", async () => {
    const f = await fixture();
    const id = "hire-global-id-race";
    const left = await signed("provisionAgent", id, params());
    const right = await signed("provisionAgent", id, params());
    const responses = await Promise.all([
      post(f.harness, `/agents/${id}/session`, left),
      post(f.harness, `/agents/${id}/session`, right),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, left.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), false);
    assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, right.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), false);
  });

  it("leaves the nonce free on the 403 owner binding and 503 evidence refusals", async () => {
    for (const [walletOwner, status, code] of [["different", 403, "wallet_owner_mismatch"], ["unreadable", 503, "evidence_unreadable"]] as const) {
      const f = await fixture({ walletOwner });
      const action = await signed("provisionAgent", `hire-${walletOwner}`, params());
      const response = await post(f.harness, `/agents/hire-${walletOwner}/session`, action);
      assert.equal(response.status, status);
      assert.match(response.text, new RegExp(code, "u"));
      const nonce = action.signed["nonce"] as Hex;
      assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, nonce, (NOW_SEC + 120) * 1_000), true);
      assert.equal(await f.store.getAgentById(`hire-${walletOwner}`), null);
    }
  });

  it("leaves the nonce free on a pre-existing global id and a stale sizing preview", async () => {
    const f = await fixture();
    const id = "hire-preexisting";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    const collision = await signed("provisionAgent", id, params());
    const conflict = await post(f.harness, `/agents/${id}/session`, collision);
    assert.equal(conflict.status, 409);
    assert.match(conflict.text, /agent_exists/u);
    assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, collision.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), true);

    const badSizing = await signed("provisionAgent", "hire-stale-sizing", { ...params(), capDayWei: "1052" });
    const invalid = await post(f.harness, "/agents/hire-stale-sizing/session", badSizing);
    assert.equal(invalid.status, 400);
    assert.equal(await f.harness.nonceStore.consume(ownerAccount.address, badSizing.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000), true);
  });

  it("converges on GET and throttles by owner+id for ten seconds", async () => {
    const f = await fixture();
    const id = "hire-poll";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    f.setMode("exact");
    const read = await signed("read", id);
    const headers = { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) };
    const one = await f.harness.app.request(`/agents/${id}/session`, { headers });
    const two = await f.harness.app.request(`/agents/${id}/session`, { headers });
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    assert.equal((await one.json() as { data: { status: string } }).data.status, "armed");
    assert.equal(f.grantReads(), 1);
  });

  it("accepts an account bearer on session GET and never on session mutations", async () => {
    const f = await fixture();
    const id = "hire-bearer";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    const issueEnvelope = await signOwnerAction("createAccountReadSession", {}, {
      agentId: "*",
      chainId: 56,
      network: "mainnet",
    });
    const issued = await post(f.harness, "/owner-read-session", issueEnvelope);
    assert.equal(issued.status, 200);
    const token = (issued.body["data"] as { token: string }).token;
    const read = await call(f.harness, `/agents/${id}/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(read.status, 200);
    const cancel = await call(f.harness, `/agents/${id}/session/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    assert.equal(cancel.status, 401);
  });

  it("reads bounded session-registration evidence for armed, paused, and revoked rows without CAS", async () => {
    const f = await fixture();
    const id = "hire-registration-readback";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    f.setMode("exact");
    const read = await signed("read", id);
    const headers = { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) };
    await f.harness.app.request(`/agents/${id}/session`, { headers });

    const armedBefore = await f.store.getAgent(ownerAccount.address, id);
    const armed = await f.harness.app.request(`/agents/${id}/session`, { headers });
    const armedBody = await armed.json() as { data: { status: string; sessionRegistration: { kind: string; checkedAtMs: number } } };
    assert.equal(armedBody.data.status, "armed");
    assert.equal(armedBody.data.sessionRegistration.kind, "missing");
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.rowVersion, armedBefore?.rowVersion);

    await post(f.harness, `/agents/${id}/pause`, await signed("pause", id));
    const pausedBefore = await f.store.getAgent(ownerAccount.address, id);
    const paused = await f.harness.app.request(`/agents/${id}/session`, { headers });
    const pausedBody = await paused.json() as { data: { status: string; sessionRegistration: { kind: string } } };
    assert.equal(pausedBody.data.status, "paused");
    assert.equal(pausedBody.data.sessionRegistration.kind, "missing");
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.rowVersion, pausedBefore?.rowVersion);

    await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id));
    f.setSessionReadMode("unreadable");
    const revokedBefore = await f.store.getAgent(ownerAccount.address, id);
    const revoked = await f.harness.app.request(`/agents/${id}/session`, { headers });
    const revokedBody = await revoked.json() as { data: { status: string; sessionRegistration: { kind: string; checkedAtMs: number } } };
    assert.equal(revokedBody.data.status, "revoked");
    assert.equal(revokedBody.data.sessionRegistration.kind, "unreadable");
    assert.equal(Number.isSafeInteger(revokedBody.data.sessionRegistration.checkedAtMs), true);
    assert.equal((await f.store.getAgent(ownerAccount.address, id))?.rowVersion, revokedBefore?.rowVersion);
  });

  it("keeps S1 continuation read-only, then owner account-read commits finalized invalid proof and releases the wallet", async () => {
    const f = await fixture();
    const id = "hire-revoke-release";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    f.setMode("exact");
    const read = await signed("read", id);
    const readHeaders = { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) };
    assert.equal((await f.harness.app.request(`/agents/${id}/session`, { headers: readHeaders })).status, 200);
    const armed = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(armed?.status, "armed");
    const revoke = await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id));
    assert.equal(revoke.status, 200, revoke.text);
    const provision = await signed("provisionAgent", id, tradeParams());
    const parsedProvision = parseOwnerActionEnvelope(provision);
    if (!parsedProvision.ok) throw new Error(parsedProvision.message);
    const tagged = await f.store.updateAgentSessionFacts(ownerAccount.address, id, {
      ...armed!.sessionFacts!,
      hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" },
      provisionActionId: ownerActionIdempotencyKey(parsedProvision.value.signed),
      hireRunId: tradeParams().hireRunId,
    });
    assert.notEqual(tagged, null);
    const revoked = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(revoked?.status, "revoked");
    assert.notEqual(revoked?.sessionFacts, null);
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, id), true);
    const keyId = keccak256(revoked!.sessionFacts!.publicKey);
    f.setFinalizedSession("invalid", keyId, revoked!.sessionFacts!.publicKey);

    const unauthenticated = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN },
    });
    assert.equal(unauthenticated.status, 401);
    const foreign = await signOwnerAction("read", {}, {
      agentId: id, chainId: 56, network: "mainnet", pk: OTHER_OWNER_PK,
    });
    assert.equal((await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(foreign) },
    })).status, 404);
    const expired = await signOwnerAction("read", {}, {
      agentId: id, chainId: 56, network: "mainnet", issuedAt: NOW_SEC - 120, expiry: NOW_SEC - 1,
    });
    assert.equal((await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(expired) },
    })).status, 401);
    assert.deepEqual(f.finalizedReads(), [], "failed account auth must not enter finalized convergence");

    const s1Only = await f.harness.app.request(`/agents/${id}/session`, {
      headers: { "x-exec-token": EXEC_TOKEN, "x-provision-action": toReadHeader(provision) },
    });
    assert.equal(s1Only.status, 200, await s1Only.text());
    const afterS1 = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(afterS1?.rowVersion, revoked?.rowVersion);
    assert.equal(afterS1?.sessionRevocation, null);
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, id), true);
    assert.deepEqual(f.finalizedReads(), [], "S1 must not even enter finalized convergence");

    const ownerRead = await f.harness.app.request(`/agents/${id}/session`, { headers: readHeaders });
    assert.equal(ownerRead.status, 200);
    const ownerReadBody = await ownerRead.json() as { data: {
      finalizedSessionRevocation: { kind: string; checkedAtMs: number; finalizedBlockNumber?: string; finalizedBlockHash?: string };
    } };
    assert.deepEqual(ownerReadBody.data.finalizedSessionRevocation,
      { kind: "invalid", checkedAtMs: NOW_SEC * 1_000, finalizedBlockNumber: "101", finalizedBlockHash: `0x${"91".repeat(32)}` });
    const released = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(released?.sessionRevocation?.verdict, "invalid", JSON.stringify(f.finalizedReads()));
    assert.equal(released?.sessionRevocation?.blockNumber, "101");
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, id), false);
    assert.deepEqual(f.finalizedReads(), ["finalized", "list:101", "public:101", "valid:101", "block:101"]);

    f.setForcedSessionKeyPresent(true);
    const corrupt = await f.harness.app.request(`/agents/${id}/session`, { headers: readHeaders });
    assert.equal(corrupt.status, 409);
    assert.equal(((await corrupt.json()) as { error: { code: string } }).error.code,
      "session_integrity_corrupt");
    f.setForcedSessionKeyPresent(false);

    const replacement = await f.store.createAgent({
      id: "trade-after-grid", ownerAddress: ownerAccount.address, walletAddress: WALLET,
      custodyModel: "passkey", status: "armed",
    });
    assert.equal(replacement.id, "trade-after-grid");
  });

  it("accepts stable finalized absence as removal proof and releases the wallet", async () => {
    const f = await fixture();
    const id = "hire-release-missing";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    f.setMode("exact");
    const read = await signed("read", id);
    const headers = { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) };
    await f.harness.app.request(`/agents/${id}/session`, { headers });
    await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id));
    const row = await f.store.getAgent(ownerAccount.address, id);
    f.setFinalizedSession("missing", keccak256(row!.sessionFacts!.publicKey), row!.sessionFacts!.publicKey);
    f.setSessionReadMode("invalid");
    const beforeVersion = row!.rowVersion;
    const response = await f.harness.app.request(`/agents/${id}/session`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: {
      sessionRegistration: { kind: string };
      finalizedSessionRevocation: { kind: string; checkedAtMs: number; finalizedBlockNumber?: string; finalizedBlockHash?: string };
    } };
    assert.equal(body.data.sessionRegistration.kind, "invalid");
    assert.equal(body.data.finalizedSessionRevocation.kind, "missing");
    assert.equal(body.data.finalizedSessionRevocation.checkedAtMs, NOW_SEC * 1_000);
    assert.equal(body.data.finalizedSessionRevocation.finalizedBlockNumber, "101");
    assert.equal(body.data.finalizedSessionRevocation.finalizedBlockHash, `0x${"91".repeat(32)}`);
    const after = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(after?.rowVersion, beforeVersion + 1);
    assert.equal(after?.sessionRevocation?.verdict, "missing");
    assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, id), false);
    const replacement = await f.store.createAgent({ id: "replacement-missing", ownerAddress: ownerAccount.address,
      walletAddress: WALLET, custodyModel: "passkey", status: "armed" });
    assert.equal(replacement.id, "replacement-missing");
  });

  it("revalidates a durable stored proof at read time instead of aging Removed back into retry", async () => {
    const f = await fixture();
    const id = "hire-durable-removed";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    f.setMode("exact");
    const read = await signed("read", id);
    const headers = { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) };
    await f.harness.app.request(`/agents/${id}/session`, { headers });
    await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id));
    const row = await f.store.getAgent(ownerAccount.address, id);
    assert.ok(row?.sessionFacts !== null && row?.sessionFacts !== undefined);
    const oldObservedAtMs = NOW_SEC * 1_000 - 60_000;
    const confirmed = await f.store.confirmSessionRevokedCas({
      ownerAddress: ownerAccount.address,
      agentId: id,
      expectedRowVersion: row.rowVersion,
      expectedPublicKey: row.sessionFacts.publicKey,
      expectedChainId: 56,
      expectedKeyStoreAddress: KEYSTORE,
      evidence: {
        version: 1,
        chainId: 56,
        keyStoreAddress: KEYSTORE,
        walletAddress: row.walletAddress,
        keyId: keccak256(row.sessionFacts.publicKey),
        sessionPublicKey: row.sessionFacts.publicKey,
        verdict: "missing",
        blockNumber: "101",
        blockHash: `0x${"91".repeat(32)}`,
        observedAtMs: oldObservedAtMs,
      },
    });
    assert.equal(confirmed.kind, "confirmed");
    const response = await f.harness.app.request(`/agents/${id}/session`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { finalizedSessionRevocation: { kind: string; checkedAtMs: number; finalizedBlockNumber: string } } };
    assert.deepEqual(body.data.finalizedSessionRevocation,
      { kind: "missing", checkedAtMs: NOW_SEC * 1_000, finalizedBlockNumber: "101", finalizedBlockHash: `0x${"91".repeat(32)}` });
  });

  it("returns finalized non-authorizing diagnostics and keeps the wallet locked", async () => {
    for (const mode of ["registered", "hash-change"] as const) {
      const f = await fixture();
      const id = `hire-no-release-${mode}`;
      await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
      f.setMode("exact");
      const read = await signed("read", id);
      const headers = { "x-exec-token": EXEC_TOKEN, "x-owner-action": toReadHeader(read) };
      await f.harness.app.request(`/agents/${id}/session`, { headers });
      await post(f.harness, `/agents/${id}/revoke`, await signed("revoke", id));
      const row = await f.store.getAgent(ownerAccount.address, id);
      f.setFinalizedSession(mode, keccak256(row!.sessionFacts!.publicKey), row!.sessionFacts!.publicKey);
      f.setSessionReadMode("invalid");
      const beforeVersion = row!.rowVersion;
      const response = await f.harness.app.request(`/agents/${id}/session`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: {
        sessionRegistration: { kind: string };
        finalizedSessionRevocation: { kind: string; checkedAtMs: number; finalizedBlockNumber?: string; finalizedBlockHash?: string };
      } };
      assert.equal(body.data.sessionRegistration.kind, "invalid");
      assert.equal(body.data.finalizedSessionRevocation.kind,
        mode === "hash-change" ? "unreadable" : mode);
      assert.equal(body.data.finalizedSessionRevocation.checkedAtMs, NOW_SEC * 1_000);
      assert.equal(body.data.finalizedSessionRevocation.finalizedBlockNumber,
        mode === "registered" ? "101" : undefined);
      assert.equal(body.data.finalizedSessionRevocation.finalizedBlockHash,
        mode === "registered" ? `0x${"91".repeat(32)}` : undefined);
      const after = await f.store.getAgent(ownerAccount.address, id);
      assert.equal(after?.rowVersion, beforeVersion);
      assert.equal(after?.sessionRevocation, null);
      assert.equal(await f.store.hasAgentSessionKey(ownerAccount.address, id), true);
      await assert.rejects(f.store.createAgent({ id: `replacement-${mode}`, ownerAddress: ownerAccount.address,
        walletAddress: WALLET, custodyModel: "passkey", status: "armed" }), AgentWalletInUseError);
    }
  });

  it("uses the exact provisioning lifecycle remedy and pre-expiry cancel is non-destructive", async () => {
    const f = await fixture();
    const id = "hire-cancel";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    const pause = await post(f.harness, `/agents/${id}/pause`, await signed("pause", id));
    assert.equal(pause.status, 400);
    assert.match(pause.text, /This agent is still being hired\. Finish the on-chain grant, or cancel the hire\./u);
    const cancel = await post(f.harness, `/agents/${id}/session/cancel`, await signed("cancelProvisioning", id));
    assert.equal(cancel.status, 200, cancel.text);
    const row = await f.store.getAgent(ownerAccount.address, id);
    assert.equal(row?.status, "provisioning");
    assert.notEqual(row?.pendingGrant?.cancelRequestedAtSec, undefined);
    assert.notEqual(await f.store.getAgentSessionKey(ownerAccount.address, id), null);
  });

  it("refuses every remaining ordinary lifecycle mutation while provisioning", async () => {
    const f = await fixture();
    const id = "hire-lifecycle";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    const remedy = "This agent is still being hired. Finish the on-chain grant, or cancel the hire.";
    const attempts = [
      { path: "unpause", envelope: await signed("unpause", id) },
      { path: "change-budget", envelope: await signed("changeBudget", id, { dailyNativeWei: "7" }) },
      { path: "runtime-profile", envelope: await signed("bindRuntimeProfile", id, { profile: "lp-v1" }) },
      { path: "revoke", envelope: await signed("revoke", id) },
    ] as const;
    const sentinel = await signed("pause", id);

    for (const attempt of attempts) {
      const response = await post(f.harness, `/agents/${id}/${attempt.path}`, attempt.envelope);
      assert.equal(response.status, 400, attempt.path);
      assert.equal((response.body as { error: { message: string } }).error.message, remedy, attempt.path);
      assert.equal((await f.store.getAgent(ownerAccount.address, id))?.status, "provisioning", attempt.path);
      assert.equal(
        await f.harness.nonceStore.consume(ownerAccount.address, attempt.envelope.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000),
        false,
        `${attempt.path} must consume only its own mutation nonce`,
      );
    }
    assert.equal(
      await f.harness.nonceStore.consume(ownerAccount.address, sentinel.signed["nonce"] as Hex, (NOW_SEC + 120) * 1_000),
      true,
      "an unrelated signed nonce must remain unconsumed",
    );
  });

  it("a cancel request that observes authority keeps the key and returns both revoke legs", async () => {
    const f = await fixture();
    const id = "hire-live-cancel";
    await post(f.harness, `/agents/${id}/session`, await signed("provisionAgent", id, params()));
    f.setMode("exact");
    const response = await post(f.harness, `/agents/${id}/session/cancel`, await signed("cancelProvisioning", id));
    assert.equal(response.status, 200);
    const body = response.body as { data: { revocationRequired: boolean; onChainRevoke: { calls: unknown[] }; note: string } };
    assert.equal(body.data.revocationRequired, true);
    assert.equal(body.data.onChainRevoke.calls.length, 2);
    assert.equal(body.data.note, "the canceled agent will not activate; detected on-chain session authority still needs owner revocation");
    assert.notEqual(await f.store.getAgentSessionKey(ownerAccount.address, id), null);
  });
});

it("Grid S1 wallet occupancy names the owner's blocking Trading agent", async () => {
  const f = await fixture();
  await f.store.createAgent({ id: "trading-agent-01", ownerAddress: ownerAccount.address, walletAddress: WALLET,
    custodyModel: "passkey", status: "armed", httpRuntimeProfile: "trade-v1" });
  const response = await post(f.harness, "/agents/grid-blocked/session", await signed("provisionAgent", "grid-blocked", params()));
  assert.equal(response.status, 409, response.text);
  assert.match(response.text, /wallet_in_use/u);
  assert.match(response.text, /Remove.*trading-agent-01.*before deploying Grid Agent/u);
  assert.equal(await f.store.getAgentById("grid-blocked"), null);
  assert.equal((await f.store.getAgentById("trading-agent-01"))?.status, "armed");
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, toFunctionSelector, type Hex } from "viem";
import { canonicalEncode } from "../src/auth/canonical.js";
import { AgentWalletInUseError, MemoryAgentStore, type AgentStore, type PendingGrant } from "../src/store/agents.js";
import { MemoryExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";
import type { KeyStoreReader } from "../src/account/keyStoreReader.js";
import { parseAccountReadSessionSecret } from "../src/auth/accountReadSession.js";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import { resolveDomainSalt } from "../src/auth/ownerAuth.js";
import { parseOwnerActionEnvelope } from "../src/http/wire.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import { DEFAULT_TRADE_SETTINGS } from "../src/trade/settings.js";
import {
  call,
  createHarness,
  EXEC_TOKEN,
  NOW_SEC,
  OTHER_OWNER_PK,
  ownerAccount,
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

type EvidenceMode = "absent" | "exact" | "unreadable";

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

async function signed(action: "provisionAgent" | "cancelProvisioning" | "resetGrantAttempt" | "read" | "pause" | "unpause" | "changeBudget" | "bindRuntimeProfile" | "revoke", id: string, body: unknown = {}) {
  return signOwnerAction(action, body, { agentId: id, chainId: 56, network: "mainnet" });
}

async function post(harness: Harness, path: string, envelope: SignedEnvelope) {
  return call(harness, path, { method: "POST", body: envelope });
}

describe("marketplace hire routes", () => {
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

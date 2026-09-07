import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, toFunctionSelector, type Hex } from "viem";
import { MemoryAgentStore, type PendingGrant } from "../src/store/agents.js";
import type { GrantEvidenceReader, GrantEvidenceSnapshot } from "../src/wallet/grantEvidence.js";
import { convergeProvisioning } from "../src/wallet/provisioning.js";
import { createProvisioningWorker } from "../src/wallet/provisioningWorker.js";
import { MemoryTradeSettingsStore } from "../src/store/tradeSettings.js";
import { DEFAULT_TRADE_SETTINGS, tradeSettingsDigest } from "../src/trade/settings.js";
import { authorizeExecute } from "../src/auth/executeDecision.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import { cancelDraft } from "./support/provisioningDraft.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TARGET = getAddress("0x3333333333333333333333333333333333333333");
const KEY_STORE = getAddress("0x4444444444444444444444444444444444444444");
const PUBLIC_KEY = `0x04${"55".repeat(64)}` as Hex;
const ACCOUNT_HASH = `0x${"66".repeat(32)}` as Hex;
const KEY_ID = `0x${"77".repeat(32)}` as Hex;
const DIGEST = `0x${"88".repeat(32)}` as Hex;
const SESSION_KEY = `0x${"99".repeat(32)}` as Hex;

function pending(id: string, expiresAt = 2_000): PendingGrant {
  return {
    version: 1,
    recoveredOwner: OWNER,
    walletAddress: WALLET,
    sessionAddress: getAddress(`0x${id.padStart(40, "0")}`),
    sessionPublicKey: PUBLIC_KEY,
    accountKeyHash: ACCOUNT_HASH,
    keyStoreKeyId: KEY_ID,
    sessionSpec: {
      allowedCalls: [{ to: TARGET, selector: "approve(address,uint256)" }],
      spendCaps: [{ token: TARGET, period: "day", limit: 100n }],
      expiresAt,
    },
    permissions: {
      calls: [{ to: TARGET, signature: "approve(address,uint256)" }],
      spend: [{ token: TARGET, period: "day", limit: 100n }],
    },
    grantDigest: DIGEST,
    expiresAt,
    sizing: { openNativeBudgetWei: "100", capDayWei: "1000", sizingPreset: "grid-v1", sizingPresetVersion: 1 },
    funding: { version: 1, observedAtSec: 1_000, registrationFeeWei: "2", registrations: 1, relayGasHeadroomWei: "3", requiredWei: "5", balanceWei: "10" },
    createdAtSec: 1_000,
    keyStoreVerdictAtS1: "verified",
    provisionActionId: `0x${id.padStart(64, "0")}` as Hex,
  };
}

function exactEvidence(): GrantEvidenceSnapshot {
  return {
    relayKeys: [{
      hash: ACCOUNT_HASH,
      expiry: 2_000,
      role: "session",
      permissions: {
        calls: [{ to: TARGET, signature: toFunctionSelector("approve(address,uint256)") }, { to: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", signature: "0x32323232" }],
        spend: [{ token: TARGET, period: "day", limit: "100" }],
      },
    }],
    accountKey: { expiry: 2_000, isSuperAdmin: false },
    accountSpend: [{ token: TARGET, period: "day", limit: 100n }],
    canExecute: [true, true],
    keyStore: { kind: "registered", publicKey: PUBLIC_KEY },
    ownerVerdict: "verified",
  };
}

function reader(read: (grant: PendingGrant) => Promise<GrantEvidenceSnapshot>): GrantEvidenceReader {
  return {
    async readFunding() { throw new Error("not used"); },
    readGrant: read,
  };
}

async function seed(store: MemoryAgentStore, id: string, expiresAt = 2_000, wallet = WALLET) {
  return store.createProvisioningAgent({
    record: { id, ownerAddress: OWNER, walletAddress: wallet, custodyModel: "passkey", caps: { dailyNativeWei: 100n }, httpRuntimeProfile: "lp-v1" },
    pendingGrant: { ...pending(id.replace(/\D/gu, "") || "1", expiresAt), walletAddress: wallet },
    sessionKey: SESSION_KEY,
  });
}

describe("provisioning convergence", () => {
  it("loses a stale arm after cancellation and replacement even when complete grant evidence arrives late", async () => {
    const store = new MemoryAgentStore(Buffer.alloc(32, 81), () => 1_500_000);
    const row = await store.createProvisioningAgent({
      record: { id: "late-trade", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" },
      pendingGrant: { ...pending("8"), autoGrant: true,
        sizing: { ...pending("8").sizing, sizingPreset: "trade-v1" },
        initialTradeSettings: { params: DEFAULT_TRADE_SETTINGS, digest: tradeSettingsDigest(DEFAULT_TRADE_SETTINGS) } },
      sessionKey: SESSION_KEY,
    });
    const settings = new MemoryTradeSettingsStore(store);
    let entered = (): void => {};
    let release = (): void => {};
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = convergeProvisioning({ store, tradeSettings: settings, evidence: reader(async () => {
      entered(); await gate; return exactEvidence();
    }), ownerAddress: OWNER, agentId: row.id, keyStore: KEY_STORE, nowSec: 1_500 });
    await reading;
    assert.equal((await cancelDraft(store, OWNER, row.id, 1_500)).updated, true);
    const replacement = await seed(store, "replacement");
    release();
    const stale = await inFlight;
    assert.equal(stale.agent?.status, "provisioning");
    assert.equal(stale.agent?.sessionFacts, null);
    // The stale settings write is allowed; it cannot confer execution authority.
    assert.notEqual(await settings.get(OWNER, row.id), null);
    assert.equal(await store.getAgentSessionKey(OWNER, row.id), SESSION_KEY);
    for (const reducesExposure of [false, true]) {
      const result = await authorizeExecute({ agent: stale.agent!, killswitch: new MemoryKillSwitch(), now: 1_500, reducesExposure });
      assert.equal(result.allowed, false);
      if (!result.allowed) assert.equal(result.code, "NO_SESSION");
    }
    for (const status of ["armed", "paused"] as const) assert.equal(await store.updateAgentStatus(OWNER, row.id, status), null);
    const late = await convergeProvisioning({ store, tradeSettings: settings, evidence: reader(async () => exactEvidence()),
      ownerAddress: OWNER, agentId: row.id, keyStore: KEY_STORE, nowSec: 1_500 });
    assert.equal(late.revocationRequired, true);
    assert.equal(late.onChainRevoke?.state, "pending_owner_broadcast");
    assert.equal(late.agent?.sessionFacts, null);
    const expired = await convergeProvisioning({ store, evidence: reader(async () => { throw new Error("expiry must not read evidence"); }),
      ownerAddress: OWNER, agentId: row.id, keyStore: KEY_STORE, nowSec: 2_000 });
    assert.equal(expired.agent?.status, "retired");
    assert.equal(await store.hasAgentSessionKey(OWNER, row.id), false);
    assert.deepEqual(await store.getAgent(OWNER, replacement.id), replacement);
  });
  it("persists the exact S1 Trading settings before arm and refuses a conflicting first write", async () => {
    const initial = { ...DEFAULT_TRADE_SETTINGS, name: "Signed at S1" };
    const seedTrade = async (store: MemoryAgentStore, id: string) => store.createProvisioningAgent({
      record: { id, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey",
        caps: { dailyNativeWei: 10_000_000_000_000_000n }, httpRuntimeProfile: "unbound-v1" },
      pendingGrant: { ...pending("9"), sizing: { openNativeBudgetWei: "0", capDayWei: "10000000000000000",
        sizingPreset: "trade-v1", sizingPresetVersion: 1 }, hireRunId: "11111111-1111-4111-8111-111111111111",
        autoGrant: true, initialTradeSettings: { params: initial, digest: tradeSettingsDigest(initial) } },
      sessionKey: SESSION_KEY,
    });

    const store = new MemoryAgentStore();
    const settings = new MemoryTradeSettingsStore(store);
    await seedTrade(store, "trade-initial");
    const armed = await convergeProvisioning({ store, tradeSettings: settings,
      evidence: reader(async () => exactEvidence()), ownerAddress: OWNER, agentId: "trade-initial",
      keyStore: KEY_STORE, nowSec: 1_500 });
    assert.equal(armed.agent?.status, "armed");
    assert.equal(armed.agent?.sessionFacts?.hireRunId, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual((await settings.get(OWNER, "trade-initial"))?.params, initial);

    const blockedStore = new MemoryAgentStore();
    const blockedSettings = new MemoryTradeSettingsStore(blockedStore);
    await seedTrade(blockedStore, "trade-conflict");
    await blockedSettings.put({ agentId: "trade-conflict", ownerAddress: OWNER,
      params: { ...initial, name: "Different" }, digest: tradeSettingsDigest({ ...initial, name: "Different" }) });
    const blocked = await convergeProvisioning({ store: blockedStore, tradeSettings: blockedSettings,
      evidence: reader(async () => exactEvidence()), ownerAddress: OWNER, agentId: "trade-conflict",
      keyStore: KEY_STORE, nowSec: 1_500 });
    assert.equal(blocked.agent?.status, "provisioning");
    assert.equal(blocked.activationError, "settings_conflict");
  });

  it("arms exact evidence through one CAS and retains the immutable hire sizing", async () => {
    const store = new MemoryAgentStore();
    await seed(store, "agent-1");
    const result = await convergeProvisioning({ store, evidence: reader(async () => exactEvidence()), ownerAddress: OWNER, agentId: "agent-1", keyStore: KEY_STORE, nowSec: 1_500 });
    assert.equal(result.agent?.status, "armed");
    assert.deepEqual(result.agent?.sessionFacts?.hireSizing, { name: "grid-v1", version: 1, openNativeBudgetWei: "100" });
    assert.equal(result.agent?.pendingGrant, null);
  });

  it("never arms a cancel-requested row, reports revoke calls, and only expiry clears the key", async () => {
    const store = new MemoryAgentStore();
    const row = await seed(store, "agent-2");
    await store.cancelProvisioningAgent({ ownerAddress: OWNER, agentId: row.id, expectedRowVersion: row.rowVersion, expectedGrantDigest: DIGEST, nowSec: 1_500, cancelActionId: `0x${"aa".repeat(32)}` });
    const live = await convergeProvisioning({ store, evidence: reader(async () => exactEvidence()), ownerAddress: OWNER, agentId: row.id, keyStore: KEY_STORE, nowSec: 1_600 });
    assert.equal(live.agent?.status, "provisioning");
    assert.equal(live.revocationRequired, true);
    assert.equal(live.onChainRevoke?.calls.length, 2);
    assert.equal(await store.getAgentSessionKey(OWNER, row.id), SESSION_KEY);
    const expired = await convergeProvisioning({ store, evidence: reader(async () => exactEvidence()), ownerAddress: OWNER, agentId: row.id, keyStore: KEY_STORE, nowSec: 2_000 });
    assert.equal(expired.agent?.status, "retired");
    assert.equal(await store.getAgentSessionKey(OWNER, row.id), null);
  });

  it("reads evidence once and never arms each over-grant, mismatch, or unreadable case", async () => {
    const cases: readonly [string, string, (value: GrantEvidenceSnapshot) => GrantEvidenceSnapshot | null][] = [
      ["extra-call", "permissions-differ", (value) => ({ ...value, relayKeys: [{ ...value.relayKeys[0]!, permissions: {
        ...(value.relayKeys[0]!.permissions as object),
        calls: [
          ...((value.relayKeys[0]!.permissions as { calls: readonly unknown[] }).calls),
          { to: WALLET, signature: "0x12345678" },
        ],
      } }] })],
      ["extra-spend", "permissions-differ", (value) => ({ ...value, relayKeys: [{ ...value.relayKeys[0]!, permissions: {
        ...(value.relayKeys[0]!.permissions as object),
        spend: [
          ...((value.relayKeys[0]!.permissions as { spend: readonly unknown[] }).spend),
          { token: WALLET, period: "hour", limit: 1n },
        ],
      } }] })],
      ["account-extra-spend", "permissions-differ", (value) => ({ ...value, accountSpend: [
        ...value.accountSpend,
        { token: WALLET, period: 1, limit: 1n, spent: 0n, lastUpdated: 0n, currentSpent: 0n, current: 0n },
      ] })],
      ["call-refused", "permissions-differ", (value) => ({ ...value, canExecute: [false] })],
      ["different-expiry", "permissions-differ", (value) => ({ ...value, relayKeys: [{ ...value.relayKeys[0]!, expiry: 1_999 }] })],
      ["superadmin", "permissions-differ", (value) => ({ ...value, accountKey: { expiry: 2_000, isSuperAdmin: true } })],
      ["different-admin", "wallet-owner-mismatch", (value) => ({ ...value, ownerVerdict: "no-matching-key" })],
      ["wallet-unregistered", "wallet-not-registered", (value) => ({ ...value, ownerVerdict: "not-registered" })],
      ["keystore-id", "keystore-id", (value) => ({ ...value, keyStore: { kind: "missing" } })],
      ["keystore-pubkey", "keystore-pubkey", (value) => ({ ...value, keyStore: { kind: "registered", publicKey: `0x04${"aa".repeat(64)}` as Hex } })],
      ["relay-unreadable", "evidence-unreadable", () => null],
    ];
    let suffix = 100;
    for (const [label, reason, mutate] of cases) {
      const store = new MemoryAgentStore();
      const id = `agent-${suffix++}`;
      await seed(store, id);
      let reads = 0;
      const result = await convergeProvisioning({
        store,
        evidence: reader(async () => {
          reads += 1;
          const changed = mutate(exactEvidence());
          if (changed === null) throw new Error("relay unavailable");
          return changed;
        }),
        ownerAddress: OWNER,
        agentId: id,
        keyStore: KEY_STORE,
        nowSec: 1_500,
      });
      assert.equal(reads, 1, label);
      assert.deepEqual(result.missing, [reason], label);
      assert.equal(result.agent?.status, "provisioning", label);
      assert.equal((await store.getAgent(OWNER, id))?.status, "provisioning", label);
    }
  });
});

describe("bounded provisioning worker", () => {
  it("processes at most 32 in one pass and reaches later ids on the next pass", async () => {
    const store = new MemoryAgentStore();
    for (let index = 1; index <= 34; index += 1) {
      await seed(store, `agent-${String(index).padStart(2, "0")}`,
        2_000, getAddress(`0x${(1_000 + index).toString(16).padStart(40, "0")}`));
    }
    const worker = createProvisioningWorker({ store, evidence: reader(async () => exactEvidence()), keyStore: KEY_STORE, nowSec: () => 1_500 });
    assert.equal((await worker.sweep()).processed, 32);
    assert.equal((await worker.sweep()).processed, 2);
    assert.equal((await store.getAgent(OWNER, "agent-34"))?.status, "armed");
  });

  it("isolates one unreadable row from the rest", async () => {
    const store = new MemoryAgentStore();
    await seed(store, "agent-1");
    await seed(store, "agent-2", 2_000, getAddress("0x2222222222222222222222222222222222222223"));
    let calls = 0;
    const worker = createProvisioningWorker({
      store,
      evidence: reader(async () => { calls += 1; if (calls === 1) throw new Error("secret https://rpc.invalid"); return exactEvidence(); }),
      keyStore: KEY_STORE,
      nowSec: () => 1_500,
    });
    assert.equal((await worker.sweep()).processed, 2);
    assert.equal((await store.getAgent(OWNER, "agent-1"))?.status, "provisioning");
    assert.equal((await store.getAgent(OWNER, "agent-2"))?.status, "armed");
  });

  it("stops at expiry without making an evidence request", async () => {
    const store = new MemoryAgentStore();
    await seed(store, "agent-1", 1_500);
    let reads = 0;
    const worker = createProvisioningWorker({
      store,
      evidence: reader(async () => { reads += 1; return exactEvidence(); }),
      keyStore: KEY_STORE,
      nowSec: () => 1_500,
    });
    assert.equal((await worker.sweep()).processed, 1);
    assert.equal(reads, 0);
    assert.equal((await store.getAgent(OWNER, "agent-1"))?.status, "provisioning");
  });
});

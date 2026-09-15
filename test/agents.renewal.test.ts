import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryAgentStore, PostgresAgentStore, type AgentStore, type PendingRenewal, type SessionFacts } from "../src/store/agents.js";
import { createPgSqlClient } from "../src/store/sql.js";
import { localPostgres } from "./support/localPostgres.js";
import { DRAFT_KEY, pendingDraft } from "./support/provisioningDraft.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const OLD_KEY = `0x${"11".repeat(32)}` as Hex;
const NEW_KEY = `0x${"22".repeat(32)}` as Hex;
const COVERAGE_TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const NOW_MS = 1_900_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1_000);
const MATRIX_WALLETS = Array.from({ length: 8 }, (_, index) =>
  getAddress(`0x${(0x100 + index).toString(16).padStart(40, "0")}`));

function facts(publicKey: Hex, expiry: number, armPlan = true): SessionFacts {
  return {
    spec: { allowedCalls: [{ to: WALLET }], spendCaps: [{ limit: 1_000n, period: "day" }], expiresAt: expiry },
    permissions: { calls: [], spend: [] }, publicKey, expiry,
    hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" },
    provisionActionId: `0x${"33".repeat(32)}` as Hex,
    ...(armPlan ? { armPlan: { params: { kind: "grid" }, digest: keccak256(stringToBytes("plan")), kind: "grid" as const, claim: null } } : {}),
  };
}

function pending(fact: SessionFacts): PendingRenewal {
  const account = privateKeyToAccount(NEW_KEY);
  const expiresAt = NOW_SEC + 3_600;
  return {
    version: 1, recoveredOwner: OWNER, walletAddress: WALLET, sessionAddress: account.address,
    sessionPublicKey: account.publicKey, accountKeyHash: keccak256(stringToBytes(account.address)),
    keyStoreKeyId: keccak256(account.publicKey), sessionSpec: { ...fact.spec, expiresAt }, permissions: fact.permissions,
    grantDigest: `0x${"44".repeat(32)}` as Hex, expiresAt,
    sizing: { openNativeBudgetWei: "0", capDayWei: "1000", sizingPreset: "trade-v1", sizingPresetVersion: 1 },
    funding: { version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "1", registrations: 1, relayGasHeadroomWei: "1", requiredWei: "2", balanceWei: "10" },
    createdAtSec: NOW_SEC - 1, keyStoreVerdictAtS1: "verified", renewActionId: `0x${"55".repeat(32)}` as Hex,
    previous: { publicKey: fact.publicKey, keyStoreKeyId: keccak256(fact.publicKey), accountKeyHash: keccak256(stringToBytes(privateKeyToAccount(OLD_KEY).address)), expiry: fact.expiry },
    phase: "granting",
  };
}

async function stores(): Promise<{ readonly stores: readonly AgentStore[]; readonly close: () => Promise<void> }> {
  const memory = new MemoryAgentStore(Buffer.alloc(32, 7), () => NOW_MS);
  const local = await localPostgres();
  if (local === null) return { stores: [memory], close: () => memory.close() };
  const postgres = await PostgresAgentStore.create(await createPgSqlClient(local.url), Buffer.alloc(32, 7), () => NOW_MS);
  return { stores: [memory, postgres], close: async () => { await memory.close(); await postgres.close(); await local.close(); } };
}

describe("session renewal agent store", () => {
  it("[F1] enforces the renewal admission matrix in memory and Postgres", async () => {
    const fixture = await stores();
    try {
      for (const store of fixture.stores) {
        const label = store.durable ? "postgres" : "memory";
        const liveFacts = facts(privateKeyToAccount(OLD_KEY).publicKey, NOW_SEC + 3_600);
        const live = await store.createAgent({ id: `renew-f1-live-${label}`, ownerAddress: OWNER,
          walletAddress: MATRIX_WALLETS[0]!, custodyModel: "self-eoa", sessionFacts: liveFacts, status: "armed" });
        const liveResult = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: live.id,
          expectedRowVersion: live.rowVersion, nowSec: NOW_SEC, pendingRenewal: pending(liveFacts), sessionKey: NEW_KEY });
        assert.equal(liveResult.kind, "conflict", `${label}: an unexpired session must not renew`);
        assert.equal((await store.getAgent(OWNER, live.id))?.pendingRenewal, null);

        const pausedFacts = facts(privateKeyToAccount(OLD_KEY).publicKey, NOW_SEC - 1);
        const paused = await store.createAgent({ id: `renew-f1-paused-${label}`, ownerAddress: OWNER,
          walletAddress: MATRIX_WALLETS[1]!, custodyModel: "self-eoa", sessionFacts: pausedFacts, status: "paused" });
        const pausedResult = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: paused.id,
          expectedRowVersion: paused.rowVersion, nowSec: NOW_SEC, pendingRenewal: pending(pausedFacts), sessionKey: NEW_KEY });
        assert.equal(pausedResult.kind, "updated", `${label}: paused is an eligible renewal status`);

        for (const [index, status] of (["provisioning", "revoked", "retired"] as const).entries()) {
          const row = await store.createAgent({ id: `renew-f1-${status}-${label}`, ownerAddress: OWNER,
            walletAddress: MATRIX_WALLETS[index + 2]!, custodyModel: "self-eoa", sessionFacts: pausedFacts, status });
          const result = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: row.id,
            expectedRowVersion: row.rowVersion, nowSec: NOW_SEC, pendingRenewal: pending(pausedFacts), sessionKey: NEW_KEY });
          assert.equal(result.kind, "conflict", `${label}: ${status} must be refused`);
        }

        const draft = await store.createProvisioningAgent({
          record: { id: `renew-f1-pending-grant-${label}`, ownerAddress: OWNER, walletAddress: MATRIX_WALLETS[5]!, custodyModel: "self-eoa" },
          pendingGrant: pendingDraft(OWNER, MATRIX_WALLETS[5]!, NOW_SEC), sessionKey: DRAFT_KEY,
        });
        const pendingGrantResult = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: draft.id,
          expectedRowVersion: draft.rowVersion, nowSec: NOW_SEC, pendingRenewal: pending(pausedFacts), sessionKey: NEW_KEY });
        assert.equal(pendingGrantResult.kind, "conflict", `${label}: a pending grant must block renewal`);

        const pendingAgent = await store.createAgent({ id: `renew-f1-pending-${label}`, ownerAddress: OWNER,
          walletAddress: MATRIX_WALLETS[6]!, custodyModel: "self-eoa", sessionFacts: pausedFacts, status: "armed" });
        const first = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: pendingAgent.id,
          expectedRowVersion: pendingAgent.rowVersion, nowSec: NOW_SEC, pendingRenewal: pending(pausedFacts), sessionKey: NEW_KEY });
        assert.equal(first.kind, "updated");
        const second = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: pendingAgent.id,
          expectedRowVersion: first.kind === "updated" ? first.agent.rowVersion : 0, nowSec: NOW_SEC,
          pendingRenewal: pending(pausedFacts), sessionKey: NEW_KEY });
        assert.equal(second.kind, "conflict", `${label}: a pending renewal must block another renewal`);
        const canceled = await store.cancelPendingRenewalCas({ ownerAddress: OWNER, agentId: pendingAgent.id,
          expectedRowVersion: first.kind === "updated" ? first.agent.rowVersion : 0,
          expectedGrantDigest: pending(pausedFacts).grantDigest, nowSec: NOW_SEC,
          cancelActionId: `0x${"66".repeat(32)}` as Hex, outcome: "cancelled", reason: "owner" });
        assert.equal(canceled.kind, "updated");
        const retained = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: pendingAgent.id,
          expectedRowVersion: canceled.kind === "updated" ? canceled.agent.rowVersion : 0, nowSec: NOW_SEC,
          pendingRenewal: pending(pausedFacts), sessionKey: NEW_KEY });
        assert.equal(retained.kind, "conflict", `${label}: cancelled-retained renewal must remain a blocker`);

        const lendingFacts: SessionFacts = { ...pausedFacts,
          hireSizing: { name: "lending-v1", version: 1, openNativeBudgetWei: "0" } };
        const lending = await store.createAgent({ id: `renew-f1-lending-${label}`, ownerAddress: OWNER,
          walletAddress: MATRIX_WALLETS[7]!, custodyModel: "self-eoa", sessionFacts: lendingFacts, status: "armed" });
        const lendingResult = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: lending.id,
          expectedRowVersion: lending.rowVersion, nowSec: NOW_SEC, pendingRenewal: pending(lendingFacts), sessionKey: NEW_KEY });
        assert.equal(lendingResult.kind, "conflict", `${label}: lending renewal is unsupported in v1`);
      }
    } finally { await fixture.close(); }
  });

  it("seals K2 separately, swaps by CAS, preserves armPlan, and retires cancelled K2", async () => {
    const fixture = await stores();
    try {
      for (const store of fixture.stores) {
        const oldFacts = facts(privateKeyToAccount(OLD_KEY).publicKey, NOW_SEC - 1);
        const agent = await store.createAgent({ id: `renew-${store.durable ? "pg" : "mem"}`, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa", sessionFacts: oldFacts, status: "armed" });
        await store.putAgentSessionKey(OWNER, agent.id, OLD_KEY);
        const renewal = pending(oldFacts);
        const created = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: agent.id, expectedRowVersion: agent.rowVersion + 1, nowSec: NOW_SEC, pendingRenewal: renewal, sessionKey: NEW_KEY, checkQuiescent: async () => ({ quiescent: true }) });
        assert.equal(created.kind, "updated");
        const executingOld = await store.readExecutingSession(OWNER, agent.id);
        assert.equal(executingOld?.key, OLD_KEY);
        const swapped = await store.swapSessionCas({ ownerAddress: OWNER, agentId: agent.id, expectedRowVersion: created.kind === "updated" ? created.agent.rowVersion : 0, expectedGrantDigest: renewal.grantDigest, sessionFacts: { ...oldFacts, spec: renewal.sessionSpec, permissions: renewal.permissions, publicKey: renewal.sessionPublicKey, expiry: renewal.expiresAt, generation: 1, grantedAtSec: NOW_SEC, renewActionId: renewal.renewActionId, renewalHistory: [{ renewActionId: renewal.renewActionId, grantDigest: renewal.grantDigest, completedAtSec: NOW_SEC }], renewals: 1 }, checkQuiescent: async () => ({ quiescent: true }) });
        assert.equal(swapped.kind, "updated");
        const executingNew = await store.readExecutingSession(OWNER, agent.id);
        assert.equal(executingNew?.key, NEW_KEY);
        const current = await store.getAgent(OWNER, agent.id);
         assert.equal(current?.pendingRenewal, null);
         assert.equal(current?.renewalCleanupPending, true);
         assert.equal(current?.renewalOutcomes?.[0]?.outcome, "completed");
         assert.deepEqual(current?.sessionFacts?.armPlan, oldFacts.armPlan);
         const cleanup = await store.clearRenewalCleanup({ ownerAddress: OWNER, agentId: agent.id, expectedRowVersion: current?.rowVersion ?? 0 });
         assert.equal(cleanup.kind, "updated");
         assert.equal((await store.getAgent(OWNER, agent.id))?.renewalCleanupPending, false);
      }
    } finally { await fixture.close(); }
  });

  it("[F3] cancels a swap when coverage is lost and records the held token", async () => {
    const fixture = await stores();
    try {
      for (const store of fixture.stores) {
        const oldFacts = facts(privateKeyToAccount(OLD_KEY).publicKey, NOW_SEC - 1);
        const agent = await store.createAgent({ id: `renew-f3-${store.durable ? "pg" : "mem"}`,
          ownerAddress: OWNER, walletAddress: getAddress(`0x${(0x400 + (store.durable ? 1 : 0)).toString(16).padStart(40, "0")}`),
          custodyModel: "self-eoa", sessionFacts: oldFacts, status: "armed" });
        await store.putAgentSessionKey(OWNER, agent.id, OLD_KEY);
        const renewal = pending(oldFacts);
        const created = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: agent.id,
          expectedRowVersion: agent.rowVersion + 1, nowSec: NOW_SEC, pendingRenewal: renewal, sessionKey: NEW_KEY });
        assert.equal(created.kind, "updated");
        const result = await store.swapSessionCas({ ownerAddress: OWNER, agentId: agent.id,
          expectedRowVersion: created.kind === "updated" ? created.agent.rowVersion : 0,
          expectedGrantDigest: renewal.grantDigest,
          sessionFacts: { ...oldFacts, spec: renewal.sessionSpec, permissions: renewal.permissions,
            publicKey: renewal.sessionPublicKey, expiry: renewal.expiresAt, generation: 1, grantedAtSec: NOW_SEC,
            renewActionId: renewal.renewActionId },
          checkCoverage: async () => ({ ok: false, token: COVERAGE_TOKEN }), nowSec: NOW_SEC });
        assert.equal(result.kind, "cancelled");
        assert.equal(result.agent?.pendingRenewal?.cancelReason, "renewal_coverage_lost");
        assert.equal(result.agent?.pendingRenewal?.coverageLossToken, COVERAGE_TOKEN);
        assert.equal(result.agent?.renewalOutcomes?.[0]?.outcome, "cancelled");
        assert.equal((await store.readExecutingSession(OWNER, agent.id))?.key, OLD_KEY);
      }
    } finally { await fixture.close(); }
  });
});

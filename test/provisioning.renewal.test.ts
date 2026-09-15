import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryAgentStore, type AgentRecord, type PendingRenewal, type SessionFacts } from "../src/store/agents.js";
import { MemoryExecutionJournal } from "../src/store/journal.js";
import type { TradeIntentStore } from "../src/store/tradeIntents.js";
import type { LpSequenceStore } from "../src/store/lpSequences.js";
import { assessRenewalQuiescence, convergeRenewal } from "../src/wallet/provisioning.js";
import type { GrantEvidenceReader } from "../src/wallet/grantEvidence.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const OLD_KEY = `0x${"11".repeat(32)}` as Hex;
const NEW_KEY = `0x${"22".repeat(32)}` as Hex;
const NOW_SEC = 1_900_000_000;

function makeFacts(): SessionFacts {
  const old = privateKeyToAccount(OLD_KEY);
  return { spec: { allowedCalls: [{ to: WALLET }], spendCaps: [{ limit: 1_000n, period: "day" }], expiresAt: NOW_SEC - 1 }, permissions: { calls: [], spend: [] }, publicKey: old.publicKey, expiry: NOW_SEC - 1, hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } };
}

function makePending(facts: SessionFacts): PendingRenewal {
  const next = privateKeyToAccount(NEW_KEY);
  return { version: 1, recoveredOwner: OWNER, walletAddress: WALLET, sessionAddress: next.address, sessionPublicKey: next.publicKey, accountKeyHash: keccak256(stringToBytes(next.address)), keyStoreKeyId: keccak256(next.publicKey), sessionSpec: { ...facts.spec, expiresAt: NOW_SEC + 100 }, permissions: facts.permissions, grantDigest: `0x${"44".repeat(32)}` as Hex, expiresAt: NOW_SEC + 100, sizing: { openNativeBudgetWei: "0", capDayWei: "1000", sizingPreset: "trade-v1", sizingPresetVersion: 1 }, funding: { version: 1, observedAtSec: NOW_SEC, registrationFeeWei: "1", registrations: 1, relayGasHeadroomWei: "1", requiredWei: "2", balanceWei: "10" }, createdAtSec: NOW_SEC, keyStoreVerdictAtS1: "verified", renewActionId: `0x${"55".repeat(32)}` as Hex, previous: { publicKey: facts.publicKey, keyStoreKeyId: keccak256(facts.publicKey), accountKeyHash: keccak256(stringToBytes(privateKeyToAccount(OLD_KEY).address)), expiry: facts.expiry }, phase: "granting" };
}

describe("renewal provisioning convergence", () => {
  it("[F2] inventories every persisted busy kind and keeps a swap behind quiescence", async () => {
    const base = {
      id: "renew-f2", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa" as const,
      sessionFacts: makeFacts(), sessionRevocation: null, caps: null, status: "armed" as const,
      httpRuntimeProfile: "trade-v1" as const, erc8004AgentId: null, pendingGrant: null,
      pendingRenewal: null, rowVersion: 1, createdAt: 1, updatedAt: 1,
    } as AgentRecord;
    const tradeIntents = { listUnsettled: async () => [{ decisionId: "f2-intent" }] } as unknown as Pick<TradeIntentStore, "listUnsettled">;
    const tradeBusy = await assessRenewalQuiescence(base, { tradeIntents });
    assert.equal(tradeBusy.quiescent, false);
    assert.match(tradeBusy.reason ?? "", /f2-intent/u);

    const lpAgent = { ...base, id: "renew-f2-lp", httpRuntimeProfile: "lp-v1" as const,
      sessionFacts: { ...makeFacts(), hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" } } };
    const lpSequences = { listSequences: async () => [{ sequenceId: "f2-sequence", state: "active", recoveryState: "none" }] } as unknown as Pick<LpSequenceStore, "listSequences">;
    const lpBusy = await assessRenewalQuiescence(lpAgent, { lpSequences });
    assert.equal(lpBusy.quiescent, false);
    assert.match(lpBusy.reason ?? "", /f2-sequence/u);

    for (const state of ["PENDING", "IN_PROGRESS"] as const) {
      const journal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
      const id = `renew-f2-${state.toLowerCase()}`;
      const key = `0x${state === "PENDING" ? "61" : "62"}${"00".repeat(31)}` as Hex;
      await journal.begin({ idempotencyKey: key, agentId: id, ownerAddress: OWNER, kind: "trade" });
      if (state === "IN_PROGRESS") await journal.markInProgress(key, { callsId: `0x${"63".repeat(32)}` as Hex });
      const busy = await assessRenewalQuiescence({ ...base, id, httpRuntimeProfile: "unbound-v1" as const,
        sessionFacts: { ...makeFacts(), hireSizing: undefined } as unknown as SessionFacts }, { journal });
      assert.equal(busy.quiescent, false);
      assert.match(busy.reason ?? "", new RegExp(`journal ${state}`, "u"));
      await journal.close();
    }

    const unknownJournal = new MemoryExecutionJournal(() => NOW_SEC * 1_000);
    const unknownKey = `0x${"64".repeat(32)}` as Hex;
    await unknownJournal.begin({ idempotencyKey: unknownKey, agentId: "renew-f2-unknown", ownerAddress: OWNER, kind: "trade" });
    await unknownJournal.markUnknown(unknownKey, "transport");
    const unknown = await assessRenewalQuiescence({ ...base, id: "renew-f2-unknown", httpRuntimeProfile: "unbound-v1" as const,
      sessionFacts: { ...makeFacts(), hireSizing: undefined } as unknown as SessionFacts }, { journal: unknownJournal });
    assert.equal(unknown.quiescent, false);
    assert.match(unknown.reason ?? "", /journal UNKNOWN/u);
    await unknownJournal.close();

    const claimAgent = { ...base, id: "renew-f2-claim", httpRuntimeProfile: "lp-v1" as const,
      sessionFacts: { ...makeFacts(), hireSizing: { name: "lp-v1" as const, version: 1 as const, openNativeBudgetWei: "0" }, armPlan: { params: { kind: "grid" }, digest: `0x${"65".repeat(32)}` as Hex,
        kind: "grid" as const, claim: { by: "signed" as const, actionId: `0x${"66".repeat(32)}` as Hex,
          claimedAtSec: NOW_SEC, outcome: null } } } };
    const claimBusy = await assessRenewalQuiescence(claimAgent, { lpSequences: { listSequences: async () => [] } });
    assert.equal(claimBusy.quiescent, false);
    assert.match(claimBusy.reason ?? "", /arm claim/u);

    const store = new MemoryAgentStore(Buffer.alloc(32, 2), () => NOW_SEC * 1_000);
    const facts = makeFacts();
    const agent = await store.createAgent({ id: "renew-f2-swap", ownerAddress: OWNER, walletAddress: WALLET,
      custodyModel: "self-eoa", sessionFacts: facts, status: "armed" });
    await store.putAgentSessionKey(OWNER, agent.id, OLD_KEY);
    const renewal = makePending(facts);
    const created = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: agent.id,
      expectedRowVersion: agent.rowVersion + 1, nowSec: NOW_SEC, pendingRenewal: renewal, sessionKey: NEW_KEY });
    assert.equal(created.kind, "updated");
    const swap = await store.swapSessionCas({ ownerAddress: OWNER, agentId: agent.id,
      expectedRowVersion: created.kind === "updated" ? created.agent.rowVersion : 0,
      expectedGrantDigest: renewal.grantDigest, sessionFacts: { ...facts, generation: 1 },
      checkQuiescent: async () => ({ quiescent: false, reason: "finishing a trade intent f2-intent" }) });
    assert.equal(swap.kind, "conflict");
    assert.equal((await store.getAgent(OWNER, agent.id))?.pendingRenewal?.grantDigest, renewal.grantDigest);
    assert.equal((await store.readExecutingSession(OWNER, agent.id))?.key, OLD_KEY);
    await store.close();
  });

  it("cancels an expired pending renewal without an owner action and retains its outcome", async () => {
    const store = new MemoryAgentStore(Buffer.alloc(32, 1), () => NOW_SEC * 1_000);
    const facts = makeFacts();
    const agent = await store.createAgent({ id: "renew-expired", ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "self-eoa", sessionFacts: facts, status: "armed" });
    await store.putAgentSessionKey(OWNER, agent.id, OLD_KEY);
    const renewal = { ...makePending(facts), expiresAt: NOW_SEC - 1, sessionSpec: { ...facts.spec, expiresAt: NOW_SEC - 1 } };
    const created = await store.createPendingRenewalCas({ ownerAddress: OWNER, agentId: agent.id, expectedRowVersion: agent.rowVersion + 1, nowSec: NOW_SEC, pendingRenewal: renewal, sessionKey: NEW_KEY });
    assert.equal(created.kind, "updated");
    const evidence: GrantEvidenceReader = { readFunding: async () => renewal.funding, readGrant: async () => ({ relayKeys: [], accountKey: null, accountSpend: [], canExecute: [], keyStore: { kind: "missing" }, ownerVerdict: "verified" }) };
    const result = await convergeRenewal({ store, evidence, ownerAddress: OWNER, agentId: agent.id, keyStore: getAddress("0x3333333333333333333333333333333333333333"), nowSec: NOW_SEC });
    assert.equal(result.phase, "cancelled");
    const current = await store.getAgent(OWNER, agent.id);
    assert.equal(current?.pendingRenewal?.cancelReason, "expired");
    assert.equal(current?.renewalOutcomes?.[0]?.outcome, "expired");
    await store.close();
  });
});

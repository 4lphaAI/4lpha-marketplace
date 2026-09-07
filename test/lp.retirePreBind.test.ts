import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { MemoryLpObservationStore } from "../src/store/lpObservations.js";
import { canonicalPreparedIntentIdentityV1 } from "../src/lp/preparedIntent.js";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import { MemoryLpSequenceStore, PostgresLpSequenceStore, lpStepDecisionId,
  type LpSequenceStore } from "../src/store/lpSequences.js";
import { MemoryLpSettingsStore } from "../src/store/lpSettings.js";
import { PostgresAgentStore } from "../src/store/agents.js";
import { MemoryExecutionJournal, PostgresExecutionJournal } from "../src/store/journal.js";
import { MemoryPreBindRetirementFinalizer, PostgresPreBindRetirementFinalizer,
  type PreBindRetirementFinalizer, type PreBindRetirementFinalizerWrite } from "../src/lp/preBindRetirementFinalizer.js";
import type { LpServerDeps } from "../src/server.js";
import { call, createHarness, ownerAccount, signOwnerAction } from "./support/serverHarness.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const AGENT = "retire-pre-bind-agent";
const TOKEN0 = getAddress("0x0000000000000000000000000000000000000034");
const TOKEN1 = getAddress("0x0000000000000000000000000000000000000056");
const H1 = `0x${"11".repeat(32)}` as Hex;

function lpDeps(store: LpSequenceStore, finalizer?: PreBindRetirementFinalizer): LpServerDeps {
  return {
    store, settingsStore: new MemoryLpSettingsStore(), observations: new MemoryLpObservationStore(),
    workerIntervalMs: 60_000, railsResult: { ok: false, message: "unused by retirement" },
    venue: { nfpm: TOKEN0, routerV3: TOKEN1, wbnb: TOKEN0 },
    // F3 has no reader/provider capability; a touched reader fails the test.
    readers: new Proxy({}, { get: () => () => { throw new Error("F3 reached a reader"); } }),
    ...(finalizer === undefined ? {} : { preBindRetirementFinalizer: finalizer }),
  } as unknown as LpServerDeps;
}

async function fixture(input: {
  readonly afterWrite?: (write: PreBindRetirementFinalizerWrite) => void | Promise<void>;
  /** Route-only seam for deterministic CAS-loss tests; finalizers retain the raw store. */
  readonly routeStore?: (store: MemoryLpSequenceStore) => LpSequenceStore;
  readonly finalizerFactory?: (input: {
    readonly journal: MemoryExecutionJournal; readonly store: MemoryLpSequenceStore;
  }) => PreBindRetirementFinalizer;
} = {}) {
  const store = new MemoryLpSequenceStore();
  const journal = new MemoryExecutionJournal();
  const finalizer = input.finalizerFactory?.({ journal, store }) ??
    (input.afterWrite === undefined ? undefined : new MemoryPreBindRetirementFinalizer({
      journal, store, afterWrite: input.afterWrite,
    }));
  const lp = lpDeps(input.routeStore?.(store) ?? store, finalizer);
  const harness = await createHarness({ lp, journal });
  await harness.agentStore.createAgent({ id: AGENT, ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address, custodyModel: "self-eoa", status: "armed" });
  const position = await store.createPosition({ positionId: "retire-position", agentId: AGENT,
    ownerAddress: ownerAccount.address, token0: TOKEN0, token1: TOKEN1, fee: 500, basisWei: 5n });
  const sequence = await store.createSequence({ agentId: AGENT, ownerAddress: ownerAccount.address,
    positionId: position.positionId, kind: "open" });
  const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
  const targetKey = "retire-target";
  await store.appendStep(ownerAccount.address, AGENT, sequence.sequenceId,
    { kind: "zap-in-mint", journalIdempotencyKey: targetKey });
  const fingerprint = JSON.stringify({ scheme: "porto-erc7579-calls-v1", executionDataHash: H1 });
  await harness.journal.begin({ idempotencyKey: targetKey, agentId: AGENT,
    ownerAddress: ownerAccount.address, kind: "lp", decisionId, begunAtBlock: 10n,
    finalCallsFingerprint: fingerprint, finalCallsFingerprintHash: keccak256(stringToHex(fingerprint)) });
  await harness.journal.markUnknown(targetKey, "durable binder was never invoked");
  return { harness, store, decisionId, targetKey, sequenceId: sequence.sequenceId,
    positionId: position.positionId };
}

async function postgresFixture(input: {
  readonly afterWrite?: (write: PreBindRetirementFinalizerWrite) => void | Promise<void>;
  /** Route-only seam for deterministic CAS-loss tests; finalizers retain the raw store. */
  readonly routeStore?: (store: PostgresLpSequenceStore) => LpSequenceStore;
  readonly finalizerFactory?: (input: {
    readonly sql: FakeSqlClient; readonly journal: PostgresExecutionJournal;
    readonly store: PostgresLpSequenceStore;
  }) => PreBindRetirementFinalizer;
} = {}) {
  const sql = new FakeSqlClient();
  const now = () => 1_900_000_000_000;
  const agentStore = await PostgresAgentStore.create(sql, null, now);
  const journal = await PostgresExecutionJournal.create(sql, now);
  const store = await PostgresLpSequenceStore.create(sql, now);
  const finalizer = input.finalizerFactory?.({ sql, journal, store }) ??
    new PostgresPreBindRetirementFinalizer(sql, input);
  const harness = await createHarness({ seedAgent: false, agentStore, journal,
    lp: lpDeps(input.routeStore?.(store) ?? store, finalizer) });
  await harness.agentStore.createAgent({ id: AGENT, ownerAddress: ownerAccount.address,
    walletAddress: ownerAccount.address, custodyModel: "self-eoa", status: "armed" });
  const position = await store.createPosition({ positionId: "retire-position-pg", agentId: AGENT,
    ownerAddress: ownerAccount.address, token0: TOKEN0, token1: TOKEN1, fee: 500, basisWei: 5n });
  const sequence = await store.createSequence({ agentId: AGENT, ownerAddress: ownerAccount.address,
    positionId: position.positionId, kind: "open" });
  const decisionId = lpStepDecisionId(sequence.sequenceId, 0);
  const targetKey = "retire-target-pg";
  await store.appendStep(ownerAccount.address, AGENT, sequence.sequenceId,
    { kind: "zap-in-mint", journalIdempotencyKey: targetKey });
  const fingerprint = JSON.stringify({ scheme: "porto-erc7579-calls-v1", executionDataHash: H1 });
  await journal.begin({ idempotencyKey: targetKey, agentId: AGENT,
    ownerAddress: ownerAccount.address, kind: "lp", decisionId, begunAtBlock: 10n,
    finalCallsFingerprint: fingerprint, finalCallsFingerprintHash: keccak256(stringToHex(fingerprint)) });
  await journal.markUnknown(targetKey, "durable binder was never invoked");
  return { harness, store, decisionId, targetKey, sequenceId: sequence.sequenceId,
    positionId: position.positionId };
}

async function post(fx: { readonly harness: Awaited<ReturnType<typeof fixture>>["harness"];
  readonly decisionId: string }, envelope?: unknown) {
  const issuedAt = fx.harness.nowSec();
  const signed = envelope ?? await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
    { agentId: AGENT, issuedAt, expiry: issuedAt + 120 });
  return call(fx.harness,
    `/agents/${AGENT}/journal/${fx.decisionId}/retire-pre-bind/v1`, { method: "POST", body: signed });
}

function retirementActionKey(envelope: Awaited<ReturnType<typeof signOwnerAction>>): Hex {
  const signed = envelope.signed;
  return ownerActionIdempotencyKey({
    owner: getAddress(String(signed.owner)), agentId: String(signed.agentId),
    action: "retireLpPreBindV1", paramsHash: String(signed.paramsHash) as Hex,
    nonce: String(signed.nonce) as Hex, issuedAt: BigInt(String(signed.issuedAt)),
    expiry: BigInt(String(signed.expiry)),
  });
}

/**
 * Models a CAS loser without weakening any durable store invariant. The first
 * new owner action reaches the reclaim boundary but observes a lost CAS; the
 * next fresh action uses the real store method and wins the still-expired row.
 */
function firstReclaimLoses(store: LpSequenceStore): LpSequenceStore {
  let first = true;
  return new Proxy(store, {
    get(target, property) {
      if (property === "reclaimSequenceForPreBindRetirement") {
        return async (...args: Parameters<LpSequenceStore["reclaimSequenceForPreBindRetirement"]>) => {
          if (first) {
            first = false;
            return null;
          }
          return target.reclaimSequenceForPreBindRetirement(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type RetirementFixture = {
  readonly harness: Awaited<ReturnType<typeof fixture>>["harness"];
  readonly store: LpSequenceStore;
  readonly decisionId: string;
  readonly targetKey: string;
  readonly sequenceId: string;
  readonly positionId: string;
};

describe("F3 pre-bind retirement route", () => {
  it("is a no-reader, no-submit local finalizer and exact retries return the stored result", async () => {
    const fx = await fixture();
    const before = await fx.harness.journal.get(fx.targetKey);
    const beforeSequence = await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId);
    const beforePosition = await fx.store.getPosition(ownerAccount.address, AGENT, fx.positionId);
    assert.equal(before?.state, "UNKNOWN");
    assert.equal(before?.kind, "lp");
    assert.equal(beforeSequence?.kind, "open");
    assert.equal(beforeSequence?.state, "active");
    assert.equal(beforePosition?.state, "open");
    assert.equal(beforePosition?.tokenId, null);
    assert.equal(before?.ownerAddress.toLowerCase(), beforeSequence?.ownerAddress.toLowerCase());
    assert.equal(beforePosition?.ownerAddress.toLowerCase(), beforeSequence?.ownerAddress.toLowerCase());
    assert.equal(before?.agentId, beforeSequence?.agentId);
    assert.equal(beforePosition?.agentId, beforeSequence?.agentId);
    assert.equal(before?.decisionId, fx.decisionId);
    assert.equal(beforePosition?.positionId, beforeSequence?.positionId);
    assert.equal(beforeSequence?.recoveryState, "none");
    assert.equal(beforeSequence?.retirementTargetJournalKey, null);
    assert.equal(beforeSequence?.retirementActionIdempotencyKey, null);
    assert.equal(beforeSequence?.retirementLeaseUntil, null);
    assert.equal(beforeSequence?.retirementSnapshotHash, null);
    const issuedAt = fx.harness.nowSec();
    const envelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
      { agentId: AGENT, issuedAt, expiry: issuedAt + 120 });
    const first = await post(fx, envelope);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const target = await fx.harness.journal.get(fx.targetKey);
    assert.equal(target?.state, "ROLLED_BACK");
    assert.equal(target?.lastError, "durable binder was never invoked", "diagnostic survives retirement");
    assert.deepEqual(target?.externalRef.retirementEvidence, { scheme: "retired-pre-bind-v1" });
    assert.equal((await fx.store.getPosition(ownerAccount.address, AGENT, fx.positionId))?.state, "closed");
    assert.equal((await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId))?.state, "rolled-back");
    const replay = await post(fx, envelope);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, first.body);
  });

  it("rolls back each finalizer write on Memory and PostgreSQL/FakeSql, then completes an exact retry", async () => {
    const writes: readonly PreBindRetirementFinalizerWrite[] = [
      "begin", "position", "target", "reservation", "action", "sequence",
    ];
    const backends: readonly {
      readonly name: string;
      readonly make: (afterWrite: (write: PreBindRetirementFinalizerWrite) => void) =>
        Promise<RetirementFixture>;
    }[] = [
      { name: "memory", make: (afterWrite) => fixture({ afterWrite }) },
      { name: "postgres(fake)", make: (afterWrite) => postgresFixture({ afterWrite }) },
    ];
    for (const backend of backends) {
      for (const doomedWrite of writes) {
        let faultArmed = true;
        const fx = await backend.make((write) => {
          if (faultArmed && write === doomedWrite) {
            faultArmed = false;
            throw new Error(`injected ${doomedWrite} fault`);
          }
        });
        const issuedAt = fx.harness.nowSec();
        const envelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
          { agentId: AGENT, issuedAt, expiry: issuedAt + 120 });
        const failed = await post(fx, envelope);
        assert.equal(failed.status, 500, `${backend.name}/${doomedWrite}: ${JSON.stringify(failed.body)}`);
        assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "UNKNOWN");
        assert.equal((await fx.store.getPosition(ownerAccount.address, AGENT, fx.positionId))?.state, "open");
        const claimed = await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId);
        assert.equal(claimed?.state, "retiring-pre-bind");
        assert.equal(claimed?.retirementDispositionStarted, false);
        const retried = await post(fx, envelope);
        assert.equal(retried.status, 200, `${backend.name}/${doomedWrite}: ${JSON.stringify(retried.body)}`);
        assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "ROLLED_BACK");
        assert.equal((await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId))?.state, "rolled-back");
      }
    }
  });

  it("renews a stale exact retirement lease before entering its atomic finalizer", async () => {
    let first = true;
    const fx = await fixture({ finalizerFactory: ({ journal, store }) => {
      const atomic = new MemoryPreBindRetirementFinalizer({ journal, store });
      return {
        async finalize(input) {
          if (first) {
            first = false;
            throw new Error("injected before transaction");
          }
          return atomic.finalize(input);
        },
      };
    } });
    const issuedAt = fx.harness.nowSec();
    const envelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
      { agentId: AGENT, issuedAt, expiry: issuedAt + 300 });
    assert.equal((await post(fx, envelope)).status, 500);
    const claimed = await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId);
    assert.equal(claimed?.state, "retiring-pre-bind");
    assert.equal(claimed?.retirementDispositionStarted, false);
    fx.harness.advance(121_000);
    const retried = await post(fx, envelope);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
  });

  it("lets a newly signed action reclaim an expired untouched lease on Memory and PostgreSQL/FakeSql", async () => {
    const factories: readonly {
      readonly name: string;
      readonly make: () => Promise<RetirementFixture>;
    }[] = [
      { name: "memory", make: () => {
        let first = true;
        return fixture({ finalizerFactory: ({ journal, store }) => {
          const atomic = new MemoryPreBindRetirementFinalizer({ journal, store });
          return { async finalize(input) {
            if (first) { first = false; throw new Error("crash before finalizer transaction"); }
            return atomic.finalize(input);
          } };
        } });
      } },
      { name: "postgres(fake)", make: () => {
        let first = true;
        return postgresFixture({ finalizerFactory: ({ sql }) => {
          const atomic = new PostgresPreBindRetirementFinalizer(sql);
          return { async finalize(input) {
            if (first) { first = false; throw new Error("crash before finalizer transaction"); }
            return atomic.finalize(input);
          } };
        } });
      } },
    ];
    for (const backend of factories) {
      const fx = await backend.make();
      const issuedAt = fx.harness.nowSec();
      const firstEnvelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt, expiry: issuedAt + 300 });
      assert.equal((await post(fx, firstEnvelope)).status, 500, backend.name);
      const stranded = await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId);
      assert.equal(stranded?.state, "retiring-pre-bind", backend.name);
      assert.equal(stranded?.retirementDispositionStarted, false, backend.name);
      fx.harness.advance(121_000);
      const freshIssuedAt = fx.harness.nowSec();
      const freshEnvelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt: freshIssuedAt, expiry: freshIssuedAt + 300 });
      assert.notDeepEqual(freshEnvelope.signed, firstEnvelope.signed, backend.name);
      const reclaimed = await post(fx, freshEnvelope);
      assert.equal(reclaimed.status, 200, `${backend.name}: ${JSON.stringify(reclaimed.body)}`);
      assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "ROLLED_BACK", backend.name);
      assert.equal((await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId))?.state,
        "rolled-back", backend.name);
      const originalReplay = await post(fx, firstEnvelope);
      assert.equal(originalReplay.status, 200, `${backend.name}: stale action must not stay PENDING`);
      assert.deepEqual(originalReplay.body, reclaimed.body, backend.name);
    }
  });

  it("refuses a new signature before the untouched retirement lease expires without writing its action", async () => {
    const factories: readonly {
      readonly name: string;
      readonly make: () => Promise<RetirementFixture>;
    }[] = [
      { name: "memory", make: () => {
        let first = true;
        return fixture({ finalizerFactory: ({ journal, store }) => {
          const atomic = new MemoryPreBindRetirementFinalizer({ journal, store });
          return { async finalize(input) {
            if (first) { first = false; throw new Error("crash before finalizer transaction"); }
            return atomic.finalize(input);
          } };
        } });
      } },
      { name: "postgres(fake)", make: () => {
        let first = true;
        return postgresFixture({ finalizerFactory: ({ sql }) => {
          const atomic = new PostgresPreBindRetirementFinalizer(sql);
          return { async finalize(input) {
            if (first) { first = false; throw new Error("crash before finalizer transaction"); }
            return atomic.finalize(input);
          } };
        } });
      } },
    ];
    for (const backend of factories) {
      const fx = await backend.make();
      const issuedAt = fx.harness.nowSec();
      const firstEnvelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt, expiry: issuedAt + 300 });
      assert.equal((await post(fx, firstEnvelope)).status, 500, backend.name);
      fx.harness.advance(1_000); // deliberately inside the 120-second retirement lease
      const freshIssuedAt = fx.harness.nowSec();
      const freshEnvelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt: freshIssuedAt, expiry: freshIssuedAt + 300 });
      const refused = await post(fx, freshEnvelope);
      assert.equal(refused.status, 400, `${backend.name}: ${JSON.stringify(refused.body)}`);
      assert.equal(await fx.harness.journal.get(retirementActionKey(freshEnvelope)), null,
        `${backend.name}: no fresh PENDING action may survive pre-admission refusal`);
      const sequence = await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId);
      assert.equal(sequence?.state, "retiring-pre-bind", backend.name);
      assert.equal(sequence?.retirementActionIdempotencyKey, retirementActionKey(firstEnvelope), backend.name);
      assert.equal(sequence?.retirementDispositionStarted, false, backend.name);
    }
  });

  it("refuses a new signature after the disposition latch is durable, even when its lease is expired", async () => {
    const factories: readonly {
      readonly name: string;
      readonly make: () => Promise<RetirementFixture>;
    }[] = [
      { name: "memory", make: fixture },
      { name: "postgres(fake)", make: postgresFixture },
    ];
    for (const backend of factories) {
      const fx = await backend.make();
      const active = await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId);
      const position = await fx.store.getPosition(ownerAccount.address, AGENT, fx.positionId);
      assert.ok(active);
      assert.ok(position);
      const claimed = await fx.store.claimSequenceForPreBindRetirement(
        ownerAccount.address, AGENT, fx.sequenceId, {
          expectedState: "active", expectedRecoveryState: "none", expectedUpdatedAt: active.updatedAt,
          expectedPositionId: position.positionId, expectedPositionVersion: position.rowVersion,
          expectedRetirementRowVersion: active.retirementRowVersion, targetJournalKey: fx.targetKey,
          actionIdempotencyKey: "old-retirement-action", snapshotHash: H1,
          leaseUntilMs: fx.harness.nowSec() * 1_000 - 1,
        },
      );
      assert.ok(claimed, backend.name);
      const begun = await fx.store.beginSequencePreBindRetirement(
        ownerAccount.address, AGENT, fx.sequenceId, fx.targetKey,
        claimed.retirementFence, claimed.retirementRowVersion,
      );
      assert.ok(begun, backend.name);
      assert.equal(begun.retirementDispositionStarted, true, backend.name);
      const issuedAt = fx.harness.nowSec();
      const freshEnvelope = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt, expiry: issuedAt + 300 });
      const refused = await post(fx, freshEnvelope);
      assert.equal(refused.status, 400, `${backend.name}: ${JSON.stringify(refused.body)}`);
      assert.equal(await fx.harness.journal.get(retirementActionKey(freshEnvelope)), null,
        `${backend.name}: a latched disposition must reject before action begin`);
      assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "UNKNOWN", backend.name);
      assert.equal((await fx.store.getPosition(ownerAccount.address, AGENT, fx.positionId))?.state, "open", backend.name);
    }
  });

  it("completes a deterministic fresh-action reclaim CAS loser after the other action finalizes", async () => {
    const factories: readonly {
      readonly name: string;
      readonly make: () => Promise<RetirementFixture>;
    }[] = [
      { name: "memory", make: () => {
        let firstFinalizer = true;
        return fixture({ routeStore: firstReclaimLoses, finalizerFactory: ({ journal, store }) => {
          const atomic = new MemoryPreBindRetirementFinalizer({ journal, store });
          return { async finalize(input) {
            if (firstFinalizer) {
              firstFinalizer = false;
              throw new Error("crash before finalizer transaction");
            }
            return atomic.finalize(input);
          } };
        } });
      } },
      { name: "postgres(fake)", make: () => {
        let firstFinalizer = true;
        return postgresFixture({ routeStore: firstReclaimLoses, finalizerFactory: ({ sql }) => {
          const atomic = new PostgresPreBindRetirementFinalizer(sql);
          return { async finalize(input) {
            if (firstFinalizer) {
              firstFinalizer = false;
              throw new Error("crash before finalizer transaction");
            }
            return atomic.finalize(input);
          } };
        } });
      } },
    ];
    for (const backend of factories) {
      const fx = await backend.make();
      const initialIssuedAt = fx.harness.nowSec();
      const initial = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt: initialIssuedAt, expiry: initialIssuedAt + 300 });
      assert.equal((await post(fx, initial)).status, 500, backend.name);
      fx.harness.advance(121_000);
      const issuedAt = fx.harness.nowSec();
      const loser = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt, expiry: issuedAt + 300 });
      const winner = await signOwnerAction("retireLpPreBindV1", { decisionId: fx.decisionId },
        { agentId: AGENT, issuedAt, expiry: issuedAt + 300 });
      assert.notEqual(retirementActionKey(loser), retirementActionKey(winner), backend.name);
      const lost = await post(fx, loser);
      assert.equal(lost.status, 400, `${backend.name}: ${JSON.stringify(lost.body)}`);
      assert.equal((await fx.harness.journal.get(retirementActionKey(loser)))?.state, "PENDING",
        `${backend.name}: the controlled CAS loser is retriable, not silently dropped`);
      const completed = await post(fx, winner);
      assert.equal(completed.status, 200, `${backend.name}: ${JSON.stringify(completed.body)}`);
      const loserReplay = await post(fx, loser);
      assert.equal(loserReplay.status, 200,
        `${backend.name}: the losing action cannot remain an opaque PENDING row`);
      assert.deepEqual(loserReplay.body, completed.body, backend.name);
      assert.equal((await fx.harness.journal.get(retirementActionKey(loser)))?.state, "COMMITTED", backend.name);
      assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "ROLLED_BACK", backend.name);
      assert.equal((await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId))?.state,
        "rolled-back", backend.name);
    }
  });

  it("does not create a second action for a new signature after the terminal result", async () => {
    const fx = await postgresFixture();
    const first = await post(fx);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await post(fx);
    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "ROLLED_BACK");
  });

  it("rejects malformed retirement action descriptors before either journal backend writes a row", async () => {
    const factories: readonly (() => Promise<MemoryExecutionJournal | PostgresExecutionJournal>)[] = [
      async () => new MemoryExecutionJournal(),
      async () => PostgresExecutionJournal.create(new FakeSqlClient()),
    ];
    let serial = 0;
    for (const make of factories) {
      const journal = await make();
      for (const externalRef of [
        {},
        { retirementAction: { scheme: "retire-lp-pre-bind-action-v1", targetJournalKey: "target",
          decisionId: "lp:seq:0", state: "TERMINAL" } },
        { retirementAction: { scheme: "retire-lp-pre-bind-action-v1", targetJournalKey: "target",
          decisionId: "not-an-lp-step", state: "PENDING" } },
        { retirementAction: { scheme: "retire-lp-pre-bind-action-v1", targetJournalKey: "target",
          decisionId: "lp:seq:0", state: "PENDING", extra: true } },
      ]) {
        const key = `malformed-${serial++}`;
        await assert.rejects(journal.begin({ idempotencyKey: key, agentId: AGENT,
          ownerAddress: ownerAccount.address, kind: "retireLpPreBindV1",
          externalRef: externalRef as never }));
        assert.equal(await journal.get(key), null);
      }
    }
  });

  it("refuses an incompatible prepared row without creating an action claim", async () => {
    const fx = await fixture();
    const row = await fx.harness.journal.get(fx.targetKey);
    assert.ok(row);
    const prepared = canonicalPreparedIntentIdentityV1({ scheme: "porto-intent-v1",
      decoder: "porto-orchestrator-intent-v055", chainId: "56",
      eoa: ownerAccount.address.toLowerCase() as `0x${string}`,
      orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751", orchestratorVersion: "0.5.5",
      nonce: "7", expiry: "100", executionDataHash: H1, keyHash: H1 });
    await fx.harness.journal.bindPreparedIntent(fx.targetKey, {
      canonicalIdentity: prepared.canonical, identityHash: prepared.hash,
      expectedBindingVersion: 0,
    });
    const response = await post(fx);
    assert.equal(response.status, 400);
    assert.equal((await fx.store.getSequence(ownerAccount.address, AGENT, fx.sequenceId))?.state, "active");
    assert.equal((await fx.harness.journal.get(fx.targetKey))?.state, "UNKNOWN");
  });

  it("keeps the dedicated retirement fence identical in Memory and Postgres/FakeSql", async () => {
    const factories: readonly (() => Promise<LpSequenceStore>)[] = [
      async () => new MemoryLpSequenceStore(() => 1_000),
      async () => PostgresLpSequenceStore.create(new FakeSqlClient(), () => 1_000),
    ];
    for (const makeStore of factories) {
      const store = await makeStore();
      const position = await store.createPosition({ positionId: "p-retirement", agentId: AGENT,
        ownerAddress: ownerAccount.address, token0: TOKEN0, token1: TOKEN1, fee: 500, basisWei: 5n });
      const sequence = await store.createSequence({ agentId: AGENT, ownerAddress: ownerAccount.address,
        positionId: position.positionId, kind: "open" });
      const claimed = await store.claimSequenceForPreBindRetirement(
        ownerAccount.address, AGENT, sequence.sequenceId, {
          expectedState: "active", expectedRecoveryState: "none", expectedUpdatedAt: sequence.updatedAt,
          expectedPositionId: position.positionId, expectedPositionVersion: position.rowVersion,
          expectedRetirementRowVersion: sequence.retirementRowVersion, targetJournalKey: "target",
          actionIdempotencyKey: "action", snapshotHash: H1, leaseUntilMs: 2_000,
        });
      assert.equal(claimed?.state, "retiring-pre-bind");
      await assert.rejects(store.appendStep(ownerAccount.address, AGENT, sequence.sequenceId,
        { kind: "zap-in-mint", journalIdempotencyKey: "must-not-append" }));
      // The worker's discovery query must omit the fenced position before it
      // can call a reader/evaluator, and every ordinary mutation is fenced in
      // both backends while the retirement owns that position.
      assert.equal((await store.listOpenPositionsForWorker()).some((row) =>
        row.positionId === position.positionId), false);
      await assert.rejects(store.setOwnershipMismatch(ownerAccount.address, AGENT, position.positionId,
        { count: 1, reason: "must-not-write", firstSeenAtMs: 1_000 }, position.rowVersion));
      await assert.rejects(store.updatePositionTokenId(ownerAccount.address, AGENT, position.positionId,
        "77", position.rowVersion));
      await assert.rejects(store.setPositionState(ownerAccount.address, AGENT, position.positionId,
        "closing", position.rowVersion));
      assert.ok(claimed);
      const begun = await store.beginSequencePreBindRetirement(ownerAccount.address, AGENT,
        sequence.sequenceId, "target", claimed.retirementFence, claimed.retirementRowVersion);
      assert.ok(begun);
      const closed = await store.setPositionStateForPreBindRetirement(ownerAccount.address, AGENT,
        position.positionId, { sequenceId: sequence.sequenceId, targetJournalKey: "target",
          fence: begun.retirementFence, expectedRetirementRowVersion: begun.retirementRowVersion,
          expectedPositionVersion: position.rowVersion, state: "closed" });
      assert.ok(closed);
      const finished = await store.finishSequencePreBindRetirement(ownerAccount.address, AGENT,
        sequence.sequenceId, { targetJournalKey: "target", fence: closed.sequence.retirementFence,
          expectedRetirementRowVersion: closed.sequence.retirementRowVersion });
      assert.equal(finished?.state, "rolled-back");
      assert.equal(finished?.retirementTargetJournalKey, null);
      assert.equal(finished?.retirementDispositionStarted, false);
      await store.close();
    }
  });
});

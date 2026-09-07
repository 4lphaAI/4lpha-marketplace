import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Hex } from "viem";
import { provisioningView } from "../src/http/wire.js";
import { AgentWalletInUseError, MemoryAgentStore, PostgresAgentStore, agentOccupiesWallet,
  validProvisioningCancellation, type AgentRecord, type AgentStore, type CreateProvisioningAgentInput,
  type SessionFacts } from "../src/store/agents.js";
import { FakeSqlClient } from "./support/fakeSql.js";
import { CANCEL_ACTION, DRAFT_KEY, cancelDraft, pendingDraft } from "./support/provisioningDraft.js";
import { call, createHarness, tradeConfig } from "./support/serverHarness.js";
import { executeTradeForAgent } from "../src/trade/execute.js";
import { MemoryExecutionJournal, type ExecutionJournal } from "../src/store/journal.js";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const NOW = 1_900_000_000;
const pending = () => pendingDraft(OWNER, WALLET, NOW);
const create = (id: string): CreateProvisioningAgentInput => ({
  record: { id, ownerAddress: OWNER, walletAddress: WALLET, custodyModel: "passkey" },
  pendingGrant: pending(), sessionKey: DRAFT_KEY,
});
const facts = (): SessionFacts => ({ spec: pending().sessionSpec, permissions: pending().permissions,
  publicKey: pending().sessionPublicKey, expiry: pending().expiresAt });

const factories = [
  { name: "memory", make: async (clock = () => NOW * 1_000) => new MemoryAgentStore(Buffer.alloc(32, 71), clock) },
  { name: "postgres(fake)", make: (clock = () => NOW * 1_000) => PostgresAgentStore.create(new FakeSqlClient(), Buffer.alloc(32, 71), clock) },
] as const;

for (const factory of factories) describe(`R5 canceled wallet — ${factory.name}`, () => {
  it("cannot inject a cancellation marker by mutating creation input while the wallet fence waits", async () => {
    const store = await factory.make();
    const input = create("mutable-input");
    const inserting = store.createProvisioningAgent(input);
    Object.assign(input.pendingGrant, { cancelRequestedAtSec: NOW, cancelActionId: CANCEL_ACTION });
    const created = await inserting;
    assert.equal(created.pendingGrant?.cancelRequestedAtSec, undefined);
    assert.equal(created.pendingGrant?.cancelActionId, undefined);
    assert.equal(validProvisioningCancellation(created, NOW), false);
    await assert.rejects(store.createProvisioningAgent(create("still-blocked")), AgentWalletInUseError);
    await store.close();
  });
  it("rechecks expiry under the wallet lock instead of using the insertion's earlier clock", async () => {
    let nowMs = NOW * 1_000;
    const store = await factory.make(() => nowMs);
    await store.createProvisioningAgent(create("expires-while-waiting"));
    await cancelDraft(store, OWNER, "expires-while-waiting", NOW);
    const inserting = store.createProvisioningAgent(create("late-insert"));
    nowMs = pending().expiresAt * 1_000;
    await assert.rejects(inserting, AgentWalletInUseError);
    assert.equal(await store.hasAgentSessionKey(OWNER, "expires-while-waiting"), true);
    await store.close();
  });
  it("retains canceled history/key while exactly one of two replacements wins", async () => {
    const store = await factory.make();
    await store.createProvisioningAgent(create("old"));
    await assert.rejects(store.createProvisioningAgent(create("blocked")), AgentWalletInUseError);
    assert.deepEqual(await cancelDraft(store, OWNER, "old", NOW), { updated: true, retired: false });
    const old = await store.getAgent(OWNER, "old");
    assert(old !== null);
    assert.equal(validProvisioningCancellation(old, NOW), true);
    assert.equal(agentOccupiesWallet(old, null, NOW * 1_000, true), false);
    assert.equal(await store.getAgentSessionKey(OWNER, old.id), DRAFT_KEY);
    const results = await Promise.allSettled([store.createProvisioningAgent(create("new-a")), store.createProvisioningAgent(create("new-b"))]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const loser = results.find((result) => result.status === "rejected");
    assert(loser?.status === "rejected" && loser.reason instanceof AgentWalletInUseError);
    assert.deepEqual(await store.getAgent(OWNER, "old"), old);
    for (const status of ["armed", "paused", "retired", "revoked"] as const) {
      assert.equal(await store.updateAgentStatus(OWNER, old.id, status), null);
    }
    assert.equal(await store.updateAgentSessionFacts(OWNER, old.id, facts()), null);
    assert.deepEqual(await store.armProvisioningAgent({ ownerAddress: OWNER, agentId: old.id,
      expectedRowVersion: old.rowVersion, expectedGrantDigest: pending().grantDigest, sessionFacts: facts() }),
    { updated: false, failure: "state_changed" });
    assert.equal((await store.startGrantAttemptCas({ ownerAddress: OWNER, agentId: old.id,
      expectedGrantDigest: pending().grantDigest, attemptId: CANCEL_ACTION, startedAtSec: NOW })).kind, "conflict");
    assert.equal((await store.resetGrantAttemptCas({ ownerAddress: OWNER, agentId: old.id,
      expectedGrantDigest: pending().grantDigest, attemptId: CANCEL_ACTION, resetActionId: CANCEL_ACTION, resetAtSec: NOW })).kind, "conflict");
    assert.deepEqual(await cancelDraft(store, OWNER, old.id, pending().expiresAt), { updated: true, retired: true });
    assert.equal(await store.hasAgentSessionKey(OWNER, old.id), false);
    assert.equal((await store.getAgent(OWNER, old.id))?.status, "retired");
    await store.close();
  });

  for (const cancelFirst of [true, false]) it(`races arm/cancel with ${cancelFirst ? "cancel" : "arm"} invoked first`, async () => {
    const store = await factory.make();
    const row = await store.createProvisioningAgent(create("race"));
    const arm = () => store.armProvisioningAgent({ ownerAddress: OWNER, agentId: row.id,
      expectedRowVersion: row.rowVersion, expectedGrantDigest: pending().grantDigest, sessionFacts: facts() });
    const cancel = () => store.cancelProvisioningAgent({ ownerAddress: OWNER, agentId: row.id,
      expectedRowVersion: row.rowVersion, expectedGrantDigest: pending().grantDigest, nowSec: NOW, cancelActionId: CANCEL_ACTION });
    const result = await Promise.all(cancelFirst ? [cancel(), arm()] : [arm(), cancel()]);
    assert.equal(result.filter((entry) => entry.updated).length, 1);
    const canceled = result[cancelFirst ? 0 : 1]!.updated;
    if (canceled) assert.equal((await store.createProvisioningAgent(create("replacement"))).status, "provisioning");
    else await assert.rejects(store.createProvisioningAgent(create("replacement")), AgentWalletInUseError);
    await store.close();
  });

  it("rejects every pre-populated cancellation field without persisting a row/key", async () => {
    const store = await factory.make();
    for (const marker of [{ cancelRequestedAtSec: NOW }, { cancelActionId: CANCEL_ACTION },
      { cancelRequestedAtSec: NOW, cancelActionId: CANCEL_ACTION }, { cancelActionId: undefined }, { cancelActionId: null }]) {
      const input = { ...create("forged"), pendingGrant: { ...pending(), ...marker } } as unknown as CreateProvisioningAgentInput;
      await assert.rejects(store.createProvisioningAgent(input), /store-owned/u);
      assert.equal(await store.getAgent(OWNER, "forged"), null);
      assert.equal(await store.hasAgentSessionKey(OWNER, "forged"), false);
    }
    await store.close();
  });

  it("refuses malformed cancel action/time and preserves the original row and key", async () => {
    const store = await factory.make();
    const row = await store.createProvisioningAgent(create("invalid"));
    for (const invalid of [{ cancelActionId: "0x" }, { cancelActionId: `0x${"a".repeat(63)}` },
      { cancelActionId: `0x${"g".repeat(64)}` }, { nowSec: -1 }, { nowSec: NaN }, { nowSec: Infinity },
      { nowSec: Number.MAX_SAFE_INTEGER + 1 }, { nowSec: NOW + 0.1 }, { nowSec: pending().createdAtSec - 1 }]) {
      const result = await store.cancelProvisioningAgent({ ownerAddress: OWNER, agentId: row.id,
        expectedRowVersion: row.rowVersion, expectedGrantDigest: pending().grantDigest,
        nowSec: NOW, cancelActionId: CANCEL_ACTION, ...invalid } as Parameters<AgentStore["cancelProvisioningAgent"]>[0]);
      assert.equal(result.updated, false);
      assert.deepEqual(await store.getAgent(OWNER, row.id), row);
      assert.equal(await store.getAgentSessionKey(OWNER, row.id), DRAFT_KEY);
    }
    await store.close();
  });
});

describe("R5 untrusted cancellation projection", () => {
  it("keeps raw non-NULL session state blocking through the PostgreSQL adapter", async () => {
    const sql = new FakeSqlClient();
    const store = await PostgresAgentStore.create(sql, Buffer.alloc(32, 71), () => NOW * 1_000);
    try {
      await store.createProvisioningAgent(create("raw-session-state"));
      for (const canceled of [false, true]) {
        if (canceled) assert.equal((await cancelDraft(store, OWNER, "raw-session-state", NOW)).updated, true);
        for (const column of ["session_facts", "session_revocation"] as const) {
          for (const json of ["{}", "[]", "false", '"bad"', "0", "null"]) {
            sql.setAgentSessionStateForTest("raw-session-state", column, json);
            const row = (await store.getAgent(OWNER, "raw-session-state"))!;
            assert.equal(validProvisioningCancellation(row, NOW), false, `${column}: ${json}`);
            assert.equal(provisioningView(row, NOW)["cancelRequested"], false);
            assert.equal(agentOccupiesWallet(row, null, NOW * 1_000, true), true);
            await assert.rejects(store.createProvisioningAgent(create("corrupt-replacement")), AgentWalletInUseError);
            await assert.rejects(store.createAgent({ ...create("corrupt-ordinary").record, status: "armed" }), AgentWalletInUseError);
            assert.equal((await cancelDraft(store, OWNER, row.id, NOW)).updated, false);
            assert.equal((await cancelDraft(store, OWNER, row.id, pending().expiresAt)).updated, false);
            assert.deepEqual(await store.getAgent(OWNER, row.id), row);
            assert.equal(await store.getAgentSessionKey(OWNER, row.id), DRAFT_KEY);
            sql.setAgentSessionStateForTest(row.id, column, null);
          }
        }
      }
      assert.equal(validProvisioningCancellation((await store.getAgent(OWNER, "raw-session-state"))!, NOW), true);
    } finally {
      await store.close();
    }
  });

  it("is total and keeps malformed, partial, expired, mistimed and corrupt drafts blocking", async () => {
    const store = await factories[0].make();
    await store.createProvisioningAgent(create("project"));
    await cancelDraft(store, OWNER, "project", NOW);
    const valid = (await store.getAgent(OWNER, "project"))!;
    const good = valid.pendingGrant!;
    const invalidMarkers: unknown[] = [null, [], "bad", {},
      { ...good, cancelRequestedAtSec: undefined }, { ...good, cancelActionId: undefined },
      { ...good, cancelActionId: `0x${"a".repeat(63)}` }, { ...good, cancelActionId: 1 },
      { ...good, cancelRequestedAtSec: NOW + 31 }, { ...good, cancelRequestedAtSec: good.createdAtSec - 1 },
      { ...good, cancelRequestedAtSec: good.expiresAt }, { ...good, expiresAt: NOW },
      ...["createdAtSec", "cancelRequestedAtSec", "expiresAt"].flatMap((field) =>
        [-1, NaN, Infinity, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1, "1900000000"].map((value) => ({ ...good, [field]: value }))),
    ];
    for (const pendingGrant of invalidMarkers) {
      const row = { ...valid, pendingGrant } as AgentRecord;
      assert.equal(validProvisioningCancellation(row, NOW), false);
      assert.equal(agentOccupiesWallet(row, null, NOW * 1_000, true), true);
      if (typeof pendingGrant === "object" && pendingGrant !== null && "permissions" in pendingGrant) {
        assert.equal(provisioningView(row, NOW)["cancelRequested"], false);
      }
    }
    for (const row of [{ ...valid, sessionFacts: facts() }, { ...valid, sessionRevocation: {} },
      ...["armed", "paused", "revoked"].map((status) => ({ ...valid, status }))]) {
      assert.equal(validProvisioningCancellation(row, NOW), false);
    }
    for (const clock of [NaN, -1, Infinity, NOW + 0.1, Number.MAX_SAFE_INTEGER + 1, good.expiresAt]) {
      assert.equal(validProvisioningCancellation(valid, clock), false);
    }
    for (const row of [undefined, null, [], "bad", 1]) assert.equal(validProvisioningCancellation(row, NOW), false);
    assert.equal(provisioningView(valid, NOW)["cancelRequested"], true);
    assert.equal(validProvisioningCancellation({ ...valid, pendingGrant: { ...good, cancelRequestedAtSec: NOW + 30 } }, NOW), true);
    assert.equal(validProvisioningCancellation({ ...valid, pendingGrant: { ...good, createdAtSec: NOW + 30, cancelRequestedAtSec: NOW + 30 } }, NOW), true);
    assert.equal(validProvisioningCancellation({ ...valid, pendingGrant: { ...good, cancelActionId: `0x${"AB".repeat(32)}` as Hex } }, NOW), true);
    await store.close();
  });
});

describe("R5 execution boundary with retained key", () => {
  it("refuses authenticated raw/trade routes and direct worker trades before any execution journal, reserve or provider", async () => {
    for (const profile of ["raw-v1", "trade-v1"] as const) {
      const store = await factories[0].make();
      const row = await store.createProvisioningAgent({ ...create("no-submit"),
        record: { ...create("no-submit").record, httpRuntimeProfile: profile } });
      await cancelDraft(store, OWNER, row.id, NOW);
      let begins = 0;
      const originalJournal = new MemoryExecutionJournal(() => NOW * 1_000);
      const journal = new Proxy(originalJournal, { get(target, property, receiver): unknown {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property === "begin" || property === "beginWithSpend") return () => { begins += 1; throw new Error("execution journal touched"); };
        return typeof value === "function" ? value.bind(target) : value;
      } }) as ExecutionJournal;
      const h = await createHarness({ seedAgent: false, agentStore: store, journal,
        config: { executeRawEnabled: true, trade: tradeConfig() } });
      const request = { decisionId: "canceled-buy", venue: "pancake" as const, side: "buy" as const,
        token: getAddress("0x9999999999999999999999999999999999999999"), amountWei: "1", minOutWei: "1", quotedOutWei: "1" };
      const response = await call(h, `/agents/${row.id}/${profile === "raw-v1" ? "execute" : "trade"}`, {
        method: "POST", body: profile === "raw-v1"
          ? { decisionId: "canceled-raw", calls: [{ to: WALLET, data: "0x", value: "0" }] } : request,
      });
      assert.equal(response.status, 409, response.text);
      assert.match(response.text, /not_executable/u);
      for (const side of ["buy", "sell"] as const) {
        const result = await executeTradeForAgent({ agent: (await store.getAgent(OWNER, row.id))!,
          request: { ...request, side, decisionId: `direct-${side}`, amountWei: 1n, minOutWei: 1n, quotedOutWei: 1n },
          idempotencyKey: CANCEL_ACTION, paramsHash: CANCEL_ACTION,
          scanGate: { evaluate: async () => { throw new Error("canceled draft reached scanner"); } },
          deps: { chainId: 97, keyStore: WALLET, agentStore: store, journal, killswitch: h.killswitch,
            providerRegistry: { get: () => h.provider }, trade: tradeConfig(), pancake: null, pancakeV3: null,
            flapPortal: null, nowMs: () => NOW * 1_000 } });
        assert.deepEqual(result, { kind: "denied", status: 409, code: "not_executable" });
      }
      assert.equal(begins, 0);
      assert.equal(await journal.sumNativeSpendSince(row.id, 0), 0n);
      assert.equal(h.provider.executeCalls.length, 0);
      assert.equal(h.provider.restoreCalls.length, 0);
      assert.equal(h.provider.preflightCalls.length, 0);
      assert.equal(await store.hasAgentSessionKey(OWNER, row.id), true);
      await store.close();
    }
  });
});

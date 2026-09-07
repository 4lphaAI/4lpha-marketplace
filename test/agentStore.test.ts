/**
 * Offline tests for the multi-tenant agent store.
 *
 * The contract suite runs against BOTH the memory store and the Postgres store
 * driven through an in-memory SqlClient, so the two backends are proven to agree
 * without a live database. On top of that:
 *   - CROSS-TENANT ISOLATION: owner B can never read or mutate owner A's agent;
 *   - the session key is encrypted at rest and never leaks from a non-secret
 *     method;
 *   - the canonical permissions survive a jsonb round-trip byte-for-byte;
 *   - the Postgres store refuses to persist a key without encryption configured.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AgentExistsError,
  AgentWalletInUseError,
  MemoryAgentStore,
  PostgresAgentStore,
  type AgentStore,
  type CreateAgentInput,
  type SessionFacts,
  type PendingGrant,
} from "../src/store/agents.js";
import { parseMasterKey } from "../src/store/crypto.js";
import { validateSessionSpec } from "../src/core/session.js";
import type { SessionSpec } from "../src/core/types.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const MASTER_KEY = parseMasterKey(`0x${"ab".repeat(32)}`);
const OWNER_A = getAddress(privateKeyToAccount(`0x${"a1".repeat(32)}`).address);
const OWNER_B = getAddress(privateKeyToAccount(`0x${"b2".repeat(32)}`).address);
const WALLET = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
const ROUTER = getAddress("0x10ED43C718714eb63d5aA57B78B54704E256024E");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const SESSION_KEY = `0x${"cd".repeat(32)}` as Hex;

function pending(action = `0x${"12".repeat(32)}` as Hex): PendingGrant {
  const spec = sampleSpec();
  return {
    version: 1, recoveredOwner: OWNER_A, walletAddress: WALLET,
    sessionAddress: OWNER_B, sessionPublicKey: `0x04${"11".repeat(64)}` as Hex,
    accountKeyHash: `0x${"22".repeat(32)}` as Hex, keyStoreKeyId: `0x${"33".repeat(32)}` as Hex,
    sessionSpec: spec, permissions: validateSessionSpec(spec), grantDigest: `0x${"44".repeat(32)}` as Hex,
    expiresAt: spec.expiresAt, sizing: { openNativeBudgetWei: "100", capDayWei: "1000", sizingPreset: "grid-v1", sizingPresetVersion: 1 },
    funding: { version: 1, observedAtSec: 1, registrationFeeWei: "10", registrations: 2, relayGasHeadroomWei: "30", requiredWei: "50", balanceWei: "100" },
    createdAtSec: 1, keyStoreVerdictAtS1: "not-registered", provisionActionId: action,
  };
}

function sampleSpec(): SessionSpec {
  return {
    allowedCalls: [{ to: ROUTER }, { to: USDT, selector: "transfer(address,uint256)" }],
    spendCaps: [
      { limit: parseEther("0.5"), period: "day" },
      { limit: 1_000_000n, period: "hour", token: USDT },
    ],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function sampleFacts(): SessionFacts {
  const spec = sampleSpec();
  return {
    spec,
    permissions: validateSessionSpec(spec),
    publicKey: `0x${"ab".repeat(64)}` as Hex,
    expiry: spec.expiresAt,
  };
}

function input(id: string, owner: Address): CreateAgentInput {
  return {
    id,
    ownerAddress: owner,
    walletAddress: WALLET,
    custodyModel: "self-eoa",
    sessionFacts: sampleFacts(),
    caps: { dailyNativeWei: parseEther("1") },
  };
}

/* -------------------------------------------------------------------------- */
/* Shared contract suite                                                      */
/* -------------------------------------------------------------------------- */

type StoreFactory = { name: string; make: () => Promise<AgentStore> };

let clock = 1_000;
const nextClock = (): number => (clock += 1);

const FACTORIES: readonly StoreFactory[] = [
  {
    name: "memory",
    make: async () => new MemoryAgentStore(MASTER_KEY, nextClock),
  },
  {
    name: "postgres(fake)",
    make: async () =>
      PostgresAgentStore.create(new FakeSqlClient(), MASTER_KEY, nextClock),
  },
];

for (const factory of FACTORIES) {
  describe(`AgentStore contract — ${factory.name}`, () => {
    it("creates and reads back an agent scoped to its owner", async () => {
      const store = await factory.make();
      const created = await store.createAgent(input("a1", OWNER_A));
      assert.equal(created.id, "a1");
      assert.equal(created.ownerAddress, getAddress(OWNER_A).toLowerCase());
      assert.equal(created.walletAddress, WALLET);
      assert.equal(created.status, "provisioning");
      assert.equal(created.httpRuntimeProfile, "unbound-v1");

      const fetched = await store.getAgent(OWNER_A, "a1");
      assert.deepEqual(fetched, created);
      await store.close();
    });

    it("binds the HTTP runtime profile with a one-way atomic CAS", async () => {
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));
      const first = await store.bindHttpRuntimeProfile(OWNER_A, "a1", "trade-v1");
      assert.equal(first.kind, "updated");
      const same = await store.bindHttpRuntimeProfile(OWNER_A, "a1", "trade-v1");
      assert.equal(same.kind, "same");
      const conflict = await store.bindHttpRuntimeProfile(OWNER_A, "a1", "lp-v1");
      assert.equal(conflict.kind, "conflict");
      assert.equal((await store.getAgent(OWNER_A, "a1"))?.httpRuntimeProfile, "trade-v1");
      assert.equal(
        (await store.bindHttpRuntimeProfile(OWNER_B, "a1", "trade-v1")).kind,
        "not_found",
      );
      await store.close();
    });

    it("round-trips the canonical permissions byte-for-byte through jsonb", async () => {
      const store = await factory.make();
      const facts = sampleFacts();
      await store.createAgent({ ...input("a1", OWNER_A), sessionFacts: facts });

      const fetched = await store.getAgent(OWNER_A, "a1");
      assert.deepEqual(fetched?.sessionFacts, facts);
      // bigint limits must survive as bigint, not as strings or lossy numbers.
      assert.equal(typeof fetched?.sessionFacts?.permissions.spend[0]?.limit, "bigint");
      assert.deepEqual(
        fetched?.sessionFacts?.permissions,
        validateSessionSpec(sampleSpec()),
      );
      await store.close();
    });

    it("rejects a duplicate agent id", async () => {
      const store = await factory.make();
      await store.createAgent(input("dup", OWNER_A));
      await assert.rejects(store.createAgent(input("dup", OWNER_A)), /already exists/);
      await store.close();
    });

    it("lists only the querying owner's agents", async () => {
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));
      await store.createAgent(input("a2", OWNER_A));
      await store.createAgent(input("b1", OWNER_B));

      const forA = await store.listAgents(OWNER_A);
      assert.deepEqual(
        forA.map((agent) => agent.id).sort(),
        ["a1", "a2"],
      );
      const forB = await store.listAgents(OWNER_B);
      assert.deepEqual(forB.map((agent) => agent.id), ["b1"]);
      await store.close();
    });

    it("updates status and session facts within the owner scope", async () => {
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));

      const armed = await store.updateAgentStatus(OWNER_A, "a1", "armed");
      assert.equal(armed?.status, "armed");

      const facts = sampleFacts();
      const updated = await store.updateAgentSessionFacts(OWNER_A, "a1", facts);
      assert.deepEqual(updated?.sessionFacts, facts);
      await store.close();
    });

    it("encrypts, stores, and returns the session key only via getAgentSessionKey", async () => {
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));
      await store.putAgentSessionKey(OWNER_A, "a1", SESSION_KEY);

      assert.equal(await store.getAgentSessionKey(OWNER_A, "a1"), SESSION_KEY);

      // The key must not appear in any non-secret method's output.
      const dump = (value: unknown): string =>
        JSON.stringify(value, (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
        );
      const record = await store.getAgent(OWNER_A, "a1");
      const list = await store.listAgents(OWNER_A);
      assert.equal(dump(record).includes(SESSION_KEY.slice(2)), false);
      assert.equal(dump(list).includes(SESSION_KEY.slice(2)), false);
      await store.close();
    });

    it("updates the off-chain caps within the owner scope", async () => {
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));

      const updated = await store.updateAgentCaps(OWNER_A, "a1", {
        dailyNativeWei: parseEther("2"),
        perTradeNativeWei: parseEther("0.25"),
      });
      assert.equal(updated?.caps?.dailyNativeWei, parseEther("2"));
      assert.equal(updated?.caps?.perTradeNativeWei, parseEther("0.25"));
      // Bigints must survive the jsonb round-trip as bigints, not as strings.
      assert.equal(typeof updated?.caps?.dailyNativeWei, "bigint");

      // And another owner cannot touch them.
      assert.equal(await store.updateAgentCaps(OWNER_B, "a1", {}), null);
      await store.close();
    });

    it("getAgentById finds the row unscoped, and carries the authoritative owner", async () => {
      // The runtime execute path has no owner signature, so it resolves tenancy
      // from this row: the owner it reports IS the tenancy decision.
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));
      await store.putAgentSessionKey(OWNER_A, "a1", SESSION_KEY);

      const found = await store.getAgentById("a1");
      assert.equal(found?.id, "a1");
      assert.equal(found?.ownerAddress, getAddress(OWNER_A).toLowerCase());
      assert.equal(await store.getAgentById("nope"), null);

      // Unscoped does not mean unguarded: the key is still not on the record.
      const dump = JSON.stringify(found, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      );
      assert.equal(dump.includes(SESSION_KEY.slice(2)), false);
      await store.close();
    });

    it("stores, updates, and clears the optional ERC-8004 agent id", async () => {
      const store = await factory.make();
      const created = await store.createAgent(input("a1", OWNER_A));
      assert.equal(created.erc8004AgentId, null);

      const set = await store.updateAgentErc8004Id(OWNER_A, "a1", "8004-42");
      assert.equal(set?.erc8004AgentId, "8004-42");
      assert.equal((await store.getAgent(OWNER_A, "a1"))?.erc8004AgentId, "8004-42");

      // Owner-scoped like every other mutation.
      assert.equal(await store.updateAgentErc8004Id(OWNER_B, "a1", "evil"), null);
      assert.equal((await store.getAgent(OWNER_A, "a1"))?.erc8004AgentId, "8004-42");

      const cleared = await store.updateAgentErc8004Id(OWNER_A, "a1", null);
      assert.equal(cleared?.erc8004AgentId, null);
      await store.close();
    });

    it("records and reads executor health", async () => {
      const store = await factory.make();
      await store.putExecutorHealth({
        executor: "worker-1",
        lastOkAt: 1_700_000_000_000,
        lastErrorAt: null,
        lastError: null,
        lastLatencyMs: 42,
        consecutiveFailures: 0,
      });
      const health = await store.getExecutorHealth();
      assert.equal(health.length, 1);
      assert.equal(health[0]?.executor, "worker-1");
      assert.equal(health[0]?.lastLatencyMs, 42);
      await store.close();
    });
  });
}

for (const factory of FACTORIES) {
  describe(`Trading wallet exclusivity — ${factory.name}`, () => {
    it("blocks a Trading hire beside any occupant and blocks any new occupant beside Trading", async () => {
      const occupied = await factory.make();
      await occupied.createAgent({ ...input("grid-live", OWNER_A), status: "armed" });
      await assert.rejects(occupied.createProvisioningAgent({
        record: { id: "trade", ownerAddress: OWNER_A, walletAddress: WALLET,
          custodyModel: "passkey", httpRuntimeProfile: "unbound-v1" },
        pendingGrant: { ...pending(), sizing: { openNativeBudgetWei: "0", capDayWei: "10000000000000000",
          sizingPreset: "trade-v1", sizingPresetVersion: 1 }, autoGrant: true },
        sessionKey: SESSION_KEY,
      }), AgentWalletInUseError);
      await occupied.close();

      const exclusive = await factory.make();
      await exclusive.createProvisioningAgent({
        record: { id: "trade", ownerAddress: OWNER_A, walletAddress: WALLET,
          custodyModel: "passkey", httpRuntimeProfile: "unbound-v1" },
        pendingGrant: { ...pending(), sizing: { openNativeBudgetWei: "0", capDayWei: "10000000000000000",
          sizingPreset: "trade-v1", sizingPresetVersion: 1 }, autoGrant: true },
        sessionKey: SESSION_KEY,
      });
      await assert.rejects(exclusive.createAgent({ ...input("grid", OWNER_A), status: "armed" }), AgentWalletInUseError);
      await exclusive.close();
    });

    it("releases a retired Trading row only after its readable session expiry", async () => {
      const store = await factory.make();
      await store.createAgent({ ...input("old-trade", OWNER_A), status: "retired",
        httpRuntimeProfile: "unbound-v1", sessionFacts: { ...sampleFacts(), expiry: 0,
          hireSizing: { name: "trade-v1", version: 1, openNativeBudgetWei: "0" } } });
      const created = await store.createAgent({ ...input("replacement", OWNER_A), status: "armed" });
      assert.equal(created.id, "replacement");
      await store.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Cross-tenant isolation                                                     */
/* -------------------------------------------------------------------------- */

for (const factory of FACTORIES) {
  describe(`cross-tenant isolation — ${factory.name}`, () => {
    it("owner B cannot read owner A's agent", async () => {
      const store = await factory.make();
      await store.createAgent(input("secret", OWNER_A));
      assert.equal(await store.getAgent(OWNER_B, "secret"), null);
      await store.close();
    });

    it("owner B cannot mutate owner A's agent", async () => {
      const store = await factory.make();
      await store.createAgent(input("secret", OWNER_A));

      assert.equal(await store.updateAgentStatus(OWNER_B, "secret", "paused"), null);
      assert.equal(
        await store.updateAgentSessionFacts(OWNER_B, "secret", sampleFacts()),
        null,
      );
      // A owner's row is untouched.
      const still = await store.getAgent(OWNER_A, "secret");
      assert.equal(still?.status, "provisioning");
      await store.close();
    });

    it("owner B cannot read or write owner A's session key", async () => {
      const store = await factory.make();
      await store.createAgent(input("secret", OWNER_A));
      await store.putAgentSessionKey(OWNER_A, "secret", SESSION_KEY);

      assert.equal(await store.getAgentSessionKey(OWNER_B, "secret"), null);
      await assert.rejects(
        store.putAgentSessionKey(OWNER_B, "secret", `0x${"ee".repeat(32)}` as Hex),
        /not found for this owner/,
      );
      // A's key is unchanged.
      assert.equal(await store.getAgentSessionKey(OWNER_A, "secret"), SESSION_KEY);
      await store.close();
    });

    it("normalizes owner scope across checksum casings", async () => {
      const store = await factory.make();
      await store.createAgent(input("a1", OWNER_A));
      const lowered = OWNER_A.toLowerCase() as Address;
      assert.ok((await store.getAgent(lowered, "a1")) !== null);
      await store.close();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Encryption policy                                                          */
/* -------------------------------------------------------------------------- */

describe("session-key encryption at rest", () => {
  it("stores the key as ciphertext, not plaintext, in Postgres", async () => {
    const sql = new FakeSqlClient();
    const store = await PostgresAgentStore.create(sql, MASTER_KEY, nextClock);
    await store.createAgent(input("a1", OWNER_A));
    await store.putAgentSessionKey(OWNER_A, "a1", SESSION_KEY);

    // Read the raw column straight from the fake DB: it must not be the key.
    const raw = await sql.query<{ session_key_ciphertext: string | null }>(
      "/* agents.getKey */ select session_key_ciphertext from agents where id = $1 and owner_address = $2",
      ["a1", getAddress(OWNER_A).toLowerCase()],
    );
    const ciphertext = raw.rows[0]?.session_key_ciphertext;
    assert.ok(ciphertext !== null && ciphertext !== undefined);
    assert.equal(ciphertext.includes(SESSION_KEY.slice(2)), false);
    // But the store decrypts it back to the original.
    assert.equal(await store.getAgentSessionKey(OWNER_A, "a1"), SESSION_KEY);
    await store.close();
  });

  it("Postgres refuses to persist a key with no encryption configured", async () => {
    const store = await PostgresAgentStore.create(new FakeSqlClient(), null, nextClock);
    await store.createAgent(input("a1", OWNER_A));
    await assert.rejects(
      store.putAgentSessionKey(OWNER_A, "a1", SESSION_KEY),
      /Refusing to persist a session key without encryption/,
    );
    await store.close();
  });

  it("Postgres refuses create-with-key atomically when encryption is absent", async () => {
    const sql = new FakeSqlClient();
    const store = await PostgresAgentStore.create(sql, null, nextClock);
    await assert.rejects(store.createProvisioningAgent({
      record: { id: "hire-no-key", ownerAddress: OWNER_A, walletAddress: WALLET, custodyModel: "passkey" },
      pendingGrant: pending(),
      sessionKey: SESSION_KEY,
    }), /Refusing to persist a session key without encryption/u);
    assert.equal(await store.getAgentById("hire-no-key"), null);
    await store.close();
  });

  it("runs the additive migrations idempotently", async () => {
    const sql = new FakeSqlClient();
    const first = await PostgresAgentStore.create(sql, MASTER_KEY, nextClock);
    const second = await PostgresAgentStore.create(sql, MASTER_KEY, nextClock);
    await first.createAgent(input("after-two-migrations", OWNER_A));
    assert.notEqual(await second.getAgent(OWNER_A, "after-two-migrations"), null);
    await first.close();
    await second.close();
  });

  it("memory tolerates a missing master key for dev, holding it in-process", async () => {
    const store = new MemoryAgentStore(null, nextClock);
    await store.createAgent(input("a1", OWNER_A));
    await store.putAgentSessionKey(OWNER_A, "a1", SESSION_KEY);
    assert.equal(await store.getAgentSessionKey(OWNER_A, "a1"), SESSION_KEY);
    await store.close();
  });
});

for (const factory of FACTORIES) {
  describe(`provisioning CAS â€” ${factory.name}`, () => {
    it("creates row and sealed key atomically, then round-trips pending state", async () => {
      const store = await factory.make();
      const created = await store.createProvisioningAgent({
        record: { id: "hire", ownerAddress: OWNER_A, walletAddress: WALLET, custodyModel: "passkey", caps: { dailyNativeWei: 100n }, httpRuntimeProfile: "lp-v1" },
        pendingGrant: pending(), sessionKey: SESSION_KEY,
      });
      assert.equal(created.rowVersion, 1);
      assert.deepEqual(created.pendingGrant, pending());
      assert.equal(await store.getAgentSessionKey(OWNER_A, "hire"), SESSION_KEY);
      await assert.rejects(() => store.createProvisioningAgent({ record: { id: "hire", ownerAddress: OWNER_A, walletAddress: WALLET, custodyModel: "passkey" }, pendingGrant: pending(), sessionKey: SESSION_KEY }), AgentExistsError);
      await store.close();
    });

    it("arms first-wins and preserves immutable hire sizing", async () => {
      const store = await factory.make();
      const row = await store.createProvisioningAgent({ record: { id: "race", ownerAddress: OWNER_A, walletAddress: WALLET, custodyModel: "passkey", httpRuntimeProfile: "lp-v1" }, pendingGrant: pending(), sessionKey: SESSION_KEY });
      const facts = { ...sampleFacts(), hireSizing: { name: "grid-v1" as const, version: 1 as const, openNativeBudgetWei: "100" } };
      const results = await Promise.all([1, 2].map(() => store.armProvisioningAgent({ ownerAddress: OWNER_A, agentId: "race", expectedRowVersion: row.rowVersion, expectedGrantDigest: pending().grantDigest, sessionFacts: facts })));
      assert.equal(results.filter((result) => result.updated).length, 1);
      const armed = await store.getAgent(OWNER_A, "race");
      assert.equal(armed?.status, "armed"); assert.equal(armed?.rowVersion, 2); assert.equal(armed?.pendingGrant, null);
      assert.deepEqual(armed?.sessionFacts?.hireSizing, facts.hireSizing);
      await store.close();
    });

    it("gives exactly one winner to arm versus cancel at the same grant version", async () => {
      const store = await factory.make();
      const p = pending();
      const row = await store.createProvisioningAgent({
        record: { id: "arm-cancel-race", ownerAddress: OWNER_A, walletAddress: WALLET, custodyModel: "passkey" },
        pendingGrant: p,
        sessionKey: SESSION_KEY,
      });
      const [cancelled, armed] = await Promise.all([
        store.cancelProvisioningAgent({
          ownerAddress: OWNER_A, agentId: row.id, expectedRowVersion: row.rowVersion,
          expectedGrantDigest: p.grantDigest, nowSec: p.expiresAt - 1,
          cancelActionId: `0x${"55".repeat(32)}` as Hex,
        }),
        store.armProvisioningAgent({
          ownerAddress: OWNER_A, agentId: row.id, expectedRowVersion: row.rowVersion,
          expectedGrantDigest: p.grantDigest, sessionFacts: sampleFacts(),
        }),
      ]);
      assert.equal([cancelled.updated, armed.updated].filter(Boolean).length, 1);
      const current = await store.getAgent(OWNER_A, row.id);
      assert.equal(current?.rowVersion, row.rowVersion + 1);
      if (current?.status === "provisioning") assert.notEqual(current.pendingGrant?.cancelRequestedAtSec, undefined);
      else assert.equal(current?.status, "armed");
      await store.close();
    });

    it("records pre-expiry cancellation without tearing down key, then expires destructively", async () => {
      const store = await factory.make();
      const p = pending();
      const row = await store.createProvisioningAgent({ record: { id: "cancel", ownerAddress: OWNER_A, walletAddress: WALLET, custodyModel: "passkey" }, pendingGrant: p, sessionKey: SESSION_KEY });
      const requested = await store.cancelProvisioningAgent({ ownerAddress: OWNER_A, agentId: "cancel", expectedRowVersion: row.rowVersion, expectedGrantDigest: p.grantDigest, nowSec: p.expiresAt - 1, cancelActionId: `0x${"55".repeat(32)}` as Hex });
      assert.deepEqual(requested, { updated: true, retired: false });
      assert.equal(await store.getAgentSessionKey(OWNER_A, "cancel"), SESSION_KEY);
      const after = await store.getAgent(OWNER_A, "cancel");
      assert.equal(after?.pendingGrant?.cancelRequestedAtSec, p.expiresAt - 1);
      const armAfterCancel = await store.armProvisioningAgent({
        ownerAddress: OWNER_A, agentId: "cancel", expectedRowVersion: after!.rowVersion,
        expectedGrantDigest: p.grantDigest, sessionFacts: sampleFacts(),
      });
      assert.deepEqual(armAfterCancel, { updated: false, failure: "state_changed" });
      const afterArm = await store.getAgent(OWNER_A, "cancel");
      assert.equal(afterArm?.status, "provisioning");
      assert.equal(await store.getAgentSessionKey(OWNER_A, "cancel"), SESSION_KEY);
      const expired = await store.cancelProvisioningAgent({ ownerAddress: OWNER_A, agentId: "cancel", expectedRowVersion: afterArm!.rowVersion, expectedGrantDigest: p.grantDigest, nowSec: p.expiresAt, cancelActionId: `0x${"55".repeat(32)}` as Hex });
      assert.deepEqual(expired, { updated: true, retired: true });
      assert.equal((await store.getAgent(OWNER_A, "cancel"))?.status, "retired");
      assert.equal(await store.getAgentSessionKey(OWNER_A, "cancel"), null);
      await store.close();
    });

    it("enforces the complete ordinary lifecycle matrix inside the store", async () => {
      const store = await factory.make();
      const armed = await store.createAgent({ ...input("armed", OWNER_A), status: "armed" });
      const paused = await store.transitionAgentStatus({
        ownerAddress: OWNER_A, agentId: armed.id, expectedStatus: "armed",
        expectedRowVersion: armed.rowVersion, status: "paused",
      });
      assert.equal(paused?.status, "paused");
      assert.equal(await store.transitionAgentStatus({
        ownerAddress: OWNER_A, agentId: armed.id, expectedStatus: "paused",
        expectedRowVersion: armed.rowVersion, status: "armed",
      }), null, "stale row version must lose");
      const capped = await store.updateAgentCapsCas({
        ownerAddress: OWNER_A, agentId: armed.id, expectedRowVersion: paused!.rowVersion,
        caps: { dailyNativeWei: 7n },
      });
      assert.equal(capped?.caps?.dailyNativeWei, 7n);
      const bound = await store.bindHttpRuntimeProfileCas({
        ownerAddress: OWNER_A, agentId: armed.id, expectedRowVersion: capped!.rowVersion, profile: "lp-v1",
      });
      assert.equal(bound.kind, "updated");
      const unpaused = await store.transitionAgentStatus({
        ownerAddress: OWNER_A, agentId: armed.id, expectedStatus: "paused",
        expectedRowVersion: bound.agent.rowVersion, status: "armed",
      });
      assert.equal(unpaused?.status, "armed");
      const revoked = await store.transitionAgentStatus({
        ownerAddress: OWNER_A, agentId: armed.id, expectedStatus: "armed",
        expectedRowVersion: unpaused!.rowVersion, status: "revoked",
      });
      assert.equal(revoked?.status, "revoked");

      const pausedForRevoke = await store.createAgent({ ...input("paused-revoke", OWNER_A), status: "paused" });
      assert.equal((await store.transitionAgentStatus({
        ownerAddress: OWNER_A, agentId: pausedForRevoke.id, expectedStatus: "paused",
        expectedRowVersion: pausedForRevoke.rowVersion, status: "revoked",
      }))?.status, "revoked");

      for (const status of ["provisioning", "revoked", "retired"] as const) {
        const row = await store.createAgent({ ...input(`closed-${status}`, OWNER_A), status });
        assert.equal(await store.transitionAgentStatus({
          ownerAddress: OWNER_A, agentId: row.id, expectedStatus: status,
          expectedRowVersion: row.rowVersion, status: "armed",
        }), null);
        assert.equal(await store.updateAgentCapsCas({
          ownerAddress: OWNER_A, agentId: row.id, expectedRowVersion: row.rowVersion,
          caps: { dailyNativeWei: 9n },
        }), null);
        assert.equal((await store.bindHttpRuntimeProfileCas({
          ownerAddress: OWNER_A, agentId: row.id, expectedRowVersion: row.rowVersion, profile: "lp-v1",
        })).kind, "conflict");
        assert.equal((await store.getAgent(OWNER_A, row.id))?.rowVersion, row.rowVersion);
      }
      await store.close();
    });

    it("uses bounded stable keyset pages for provisioning work", async () => {
      const store = await factory.make();
      for (const id of ["page-c", "page-a", "page-b"]) {
        await store.createAgent({ ...input(id, OWNER_A), status: "provisioning" });
      }
      await assert.rejects(store.listProvisioningAgentsForWorker({ afterId: null, limit: 0 }), /Invalid provisioning worker limit/u);
      await assert.rejects(store.listProvisioningAgentsForWorker({ afterId: null, limit: 33 }), /Invalid provisioning worker limit/u);
      const first = await store.listProvisioningAgentsForWorker({ afterId: null, limit: 2 });
      assert.deepEqual(first.rows.map((row) => row.id), ["page-a", "page-b"]);
      assert.equal(first.hasMore, true);
      const second = await store.listProvisioningAgentsForWorker({ afterId: "page-b", limit: 2 });
      assert.deepEqual(second.rows.map((row) => row.id), ["page-c"]);
      assert.equal(second.hasMore, false);
      await store.close();
    });
  });
}

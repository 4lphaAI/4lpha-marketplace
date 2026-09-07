import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, keccak256, type Hex } from "viem";
import {
  readFinalizedSessionRevocation,
  type KeyStoreReader,
  type SessionRevocationEvidenceV1,
} from "../src/account/keyStoreReader.js";
import { validateSessionSpec } from "../src/core/session.js";
import {
  AgentWalletInUseError,
  MemoryAgentStore,
  PostgresAgentStore,
  agentSessionIntegrity,
  agentOccupiesWallet,
  type AgentStore,
  type SessionFacts,
} from "../src/store/agents.js";
import { parseMasterKey } from "../src/store/crypto.js";
import { FakeSqlClient } from "./support/fakeSql.js";

const NOW_MS = 1_700_000_000_000;
const OWNER = getAddress("0x1000000000000000000000000000000000000001");
const OTHER_OWNER = getAddress("0x1000000000000000000000000000000000000002");
const WALLET = getAddress("0x2000000000000000000000000000000000000002");
const OTHER_WALLET = getAddress("0x2000000000000000000000000000000000000003");
const KEYSTORE = getAddress("0x3000000000000000000000000000000000000003");
const TARGET = getAddress("0x4000000000000000000000000000000000000004");
const PRIVATE_KEY = `0x${"41".repeat(32)}` as Hex;
const PUBLIC_KEY = `0x04${"51".repeat(64)}` as Hex;
const KEY_ID = keccak256(PUBLIC_KEY);
const BLOCK_HASH = `0x${"61".repeat(32)}` as Hex;
const MASTER_KEY = parseMasterKey(`0x${"71".repeat(32)}`);
const REVOCATION_CONTEXT = { chainId: 56, keyStoreAddress: KEYSTORE } as const;

function facts(publicKey: Hex = PUBLIC_KEY): SessionFacts {
  const spec = {
    allowedCalls: [{ to: TARGET }],
    spendCaps: [{ limit: 10n, period: "day" as const }],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  };
  return { spec, permissions: validateSessionSpec(spec), publicKey, expiry: spec.expiresAt };
}

function evidence(overrides: Partial<SessionRevocationEvidenceV1> = {}): SessionRevocationEvidenceV1 {
  return {
    version: 1,
    chainId: 56,
    keyStoreAddress: KEYSTORE,
    walletAddress: WALLET,
    keyId: KEY_ID,
    sessionPublicKey: PUBLIC_KEY,
    verdict: "invalid",
    blockNumber: "101",
    blockHash: BLOCK_HASH,
    observedAtMs: NOW_MS,
    ...overrides,
  };
}

type StoreFactory = { readonly name: string; readonly make: () => Promise<AgentStore> };
const STORES: readonly StoreFactory[] = [
  { name: "memory", make: async () => new MemoryAgentStore(MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT) },
  { name: "postgres(fake)", make: async () => PostgresAgentStore.create(new FakeSqlClient(), MASTER_KEY, () => NOW_MS, REVOCATION_CONTEXT) },
];

async function revoked(store: AgentStore, id: string) {
  await store.createAgent({
    id,
    ownerAddress: OWNER,
    walletAddress: WALLET,
    custodyModel: "passkey",
    sessionFacts: facts(),
    status: "armed",
  });
  await store.putAgentSessionKey(OWNER, id, PRIVATE_KEY);
  const withKey = await store.getAgent(OWNER, id);
  assert.notEqual(withKey, null);
  const row = await store.transitionAgentStatus({
    ownerAddress: OWNER,
    agentId: id,
    expectedStatus: "armed",
    expectedRowVersion: withKey!.rowVersion,
    status: "revoked",
  });
  assert.notEqual(row, null);
  return row!;
}

describe("finalized KeyStore revocation evidence", () => {
  function reader(options: {
    readonly listed?: boolean;
    readonly valid?: boolean;
    readonly publicKey?: Hex;
    readonly changedHash?: boolean;
    readonly noFinalizedNumber?: boolean;
    readonly malformedValid?: unknown;
    readonly keys?: readonly Hex[];
  } = {}) {
    const reads: string[] = [];
    const value: KeyStoreReader = {
      async listKeys() { throw new Error("latest must not be used"); },
      async publicKeyFor() { throw new Error("latest must not be used"); },
      async isValidKey() { throw new Error("latest must not be used"); },
      async finalizedBlock() {
        reads.push("finalized");
        return { number: options.noFinalizedNumber === true ? null : 101n, hash: BLOCK_HASH };
      },
      async blockAt(blockNumber) {
        reads.push(`block:${blockNumber}`);
        return { number: blockNumber, hash: options.changedHash === true ? `0x${"62".repeat(32)}` as Hex : BLOCK_HASH };
      },
      async listKeysAt(_wallet, blockNumber) {
        reads.push(`list:${blockNumber}`);
        return options.keys ?? (options.listed === false ? [] : [KEY_ID]);
      },
      async publicKeyForAt(_wallet, _keyId, blockNumber) {
        reads.push(`public:${blockNumber}`);
        return options.publicKey ?? PUBLIC_KEY;
      },
      async isValidKeyAt(_wallet, _keyId, blockNumber) {
        reads.push(`valid:${blockNumber}`);
        if (Object.hasOwn(options, "malformedValid")) return options.malformedValid as boolean;
        return options.valid === true;
      },
    };
    return { value, reads };
  }

  it("binds an exact invalid key to one numeric finalized block and stable hash", async () => {
    const fake = reader();
    const result = await readFinalizedSessionRevocation({
      chainId: 56, keyStoreAddress: KEYSTORE, wallet: WALLET, keyId: KEY_ID,
      expectedPublicKey: PUBLIC_KEY, observedAtMs: NOW_MS, reader: fake.value,
    });
    assert.equal(result.kind, "invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid evidence");
    assert.deepEqual(result.evidence, evidence());
    assert.deepEqual(result.observation, { blockNumber: "101", blockHash: BLOCK_HASH });
    assert.deepEqual(fake.reads, ["finalized", "list:101", "public:101", "valid:101", "block:101"]);
  });

  it("promotes stable finalized missing and refuses valid, changed-hash, wrong-key, or unavailable finality", async () => {
    const cases = [
      reader({ listed: false }),
      reader({ valid: true }),
      reader({ changedHash: true }),
      reader({ publicKey: `0x04${"52".repeat(64)}` as Hex }),
      reader({ noFinalizedNumber: true }),
    ];
    const expected = ["missing", "registered", "unreadable", "unreadable", "unreadable"];
    for (let index = 0; index < cases.length; index += 1) {
      const result = await readFinalizedSessionRevocation({
        chainId: 56, keyStoreAddress: KEYSTORE, wallet: WALLET, keyId: KEY_ID,
        expectedPublicKey: PUBLIC_KEY, observedAtMs: NOW_MS, reader: cases[index]!.value,
      });
      assert.equal(result.kind, expected[index]);
      if (index === 0) {
        assert.equal(result.kind, "missing");
        if (result.kind !== "missing") throw new Error("expected missing evidence");
        assert.deepEqual(result.evidence, evidence({ verdict: "missing" }));
        assert.deepEqual(cases[index]!.reads, ["finalized", "list:101", "block:101"]);
      } else {
        assert.equal("evidence" in result, false);
        if (result.kind === "registered") {
          assert.deepEqual(result.observation, { blockNumber: "101", blockHash: BLOCK_HASH });
        }
      }
    }
  });

  it("does not promote a missing key when the finalized hash changes", async () => {
    const fake = reader({ listed: false, changedHash: true });
    const result = await readFinalizedSessionRevocation({
      chainId: 56, keyStoreAddress: KEYSTORE, wallet: WALLET, keyId: KEY_ID,
      expectedPublicKey: PUBLIC_KEY, observedAtMs: NOW_MS, reader: fake.value,
    });
    assert.deepEqual(result, { kind: "unreadable" });
    assert.deepEqual(fake.reads, ["finalized", "list:101", "block:101"]);
  });

  it("fails closed when any finalized KeyStore list member is malformed", async () => {
    const fake = reader({ keys: ["0x12" as Hex] });
    const result = await readFinalizedSessionRevocation({
      chainId: 56,
      keyStoreAddress: KEYSTORE,
      wallet: WALLET,
      keyId: KEY_ID,
      expectedPublicKey: PUBLIC_KEY,
      observedAtMs: NOW_MS,
      reader: fake.value,
    });
    assert.deepEqual(result, { kind: "unreadable" });
  });

  it("treats every falsey non-boolean validity response as unreadable", async () => {
    for (const malformedValid of [undefined, null, 0, ""] as const) {
      const fake = reader({ malformedValid });
      const result = await readFinalizedSessionRevocation({
        chainId: 56, keyStoreAddress: KEYSTORE, wallet: WALLET, keyId: KEY_ID,
        expectedPublicKey: PUBLIC_KEY, observedAtMs: NOW_MS, reader: fake.value,
      });
      assert.deepEqual(result, { kind: "unreadable" });
    }
  });
});

for (const factory of STORES) {
  describe(`wallet reuse after finalized revoke — ${factory.name}`, () => {
    it("keeps the passkey wallet locked until proof+key destruction commit, then permits replacement", async () => {
      const store = await factory.make();
      const old = await revoked(store, "grid-old");
      assert.equal(agentOccupiesWallet(old, REVOCATION_CONTEXT, NOW_MS), true);
      await assert.rejects(store.createAgent({
        id: "trade-too-early", ownerAddress: OWNER, walletAddress: WALLET,
        custodyModel: "passkey", sessionFacts: facts(), status: "armed",
      }), AgentWalletInUseError);

      const proof = evidence({ verdict: "missing" });
      const confirmed = await store.confirmSessionRevokedCas({
        ownerAddress: OWNER, agentId: old.id, expectedRowVersion: old.rowVersion,
        expectedPublicKey: PUBLIC_KEY, expectedChainId: 56,
        expectedKeyStoreAddress: KEYSTORE, evidence: proof,
      });
      assert.equal(confirmed.kind, "confirmed");
      if (confirmed.kind !== "confirmed") throw new Error("confirmation did not win");
      assert.deepEqual(confirmed.agent.sessionRevocation, proof);
      assert.equal(agentOccupiesWallet(confirmed.agent, REVOCATION_CONTEXT, NOW_MS), false);
      assert.equal(agentOccupiesWallet(confirmed.agent, REVOCATION_CONTEXT, NOW_MS, true), true);
      assert.equal(agentSessionIntegrity(
        confirmed.agent, REVOCATION_CONTEXT, NOW_MS, true,
      ), "proof_with_key");
      assert.equal(agentSessionIntegrity(
        confirmed.agent, REVOCATION_CONTEXT, NOW_MS, false,
      ), "ok");
      assert.equal(agentOccupiesWallet(confirmed.agent, { ...REVOCATION_CONTEXT, chainId: 97 }, NOW_MS), true);
      assert.equal(agentOccupiesWallet(confirmed.agent, {
        ...REVOCATION_CONTEXT,
        keyStoreAddress: getAddress("0x3000000000000000000000000000000000000004"),
      }, NOW_MS), true);
      assert.equal(await store.hasAgentSessionKey(OWNER, old.id), false);
      assert.equal(await store.getAgentSessionKey(OWNER, old.id), null);

      const replacement = await store.createAgent({
        id: "trade-replacement", ownerAddress: OWNER, walletAddress: WALLET,
        custodyModel: "passkey", sessionFacts: facts(`0x04${"53".repeat(64)}` as Hex), status: "armed",
      });
      assert.equal(replacement.id, "trade-replacement");

      await assert.rejects(store.putAgentSessionKey(OWNER, old.id, PRIVATE_KEY), /Refusing to restore/u);
      assert.equal(await store.updateAgentSessionFacts(OWNER, old.id, facts(`0x04${"54".repeat(64)}` as Hex)), null);
      assert.deepEqual((await store.getAgent(OWNER, old.id))?.sessionRevocation, proof);
      await store.close();
    });

    it("replays identical evidence before row-version checks and refuses every changed identity", async () => {
      const store = await factory.make();
      const old = await revoked(store, "grid-replay");
      const first = await store.confirmSessionRevokedCas({
        ownerAddress: OWNER, agentId: old.id, expectedRowVersion: old.rowVersion,
        expectedPublicKey: PUBLIC_KEY, expectedChainId: 56,
        expectedKeyStoreAddress: KEYSTORE, evidence: evidence(),
      });
      assert.equal(first.kind, "confirmed");
      const replay = await store.confirmSessionRevokedCas({
        ownerAddress: OWNER, agentId: old.id, expectedRowVersion: old.rowVersion,
        expectedPublicKey: PUBLIC_KEY, expectedChainId: 56,
        expectedKeyStoreAddress: KEYSTORE, evidence: evidence({ observedAtMs: NOW_MS + 1 }),
      });
      assert.equal(replay.kind, "same");
      if (replay.kind !== "same") throw new Error("exact replay did not converge");
      assert.equal(replay.agent.sessionRevocation?.observedAtMs, NOW_MS);
      const changed = await store.confirmSessionRevokedCas({
        ownerAddress: OWNER, agentId: old.id, expectedRowVersion: replay.agent.rowVersion,
        expectedPublicKey: PUBLIC_KEY, expectedChainId: 56,
        expectedKeyStoreAddress: KEYSTORE, evidence: evidence({ blockNumber: "102" }),
      });
      assert.deepEqual(changed, { kind: "conflict" });
      await store.close();
    });

    it("applies one-agent occupancy to passkey categories without broadening self-eoa sharing", async () => {
      const passkey = await factory.make();
      await passkey.createAgent({ id: "grid", ownerAddress: OWNER, walletAddress: WALLET,
        custodyModel: "passkey", sessionFacts: facts(), status: "armed" });
      await assert.rejects(passkey.createAgent({ id: "lp", ownerAddress: OWNER, walletAddress: WALLET,
        custodyModel: "passkey", sessionFacts: facts(), status: "armed" }), AgentWalletInUseError);
      assert.equal((await passkey.createAgent({ id: "other-owner", ownerAddress: OTHER_OWNER, walletAddress: WALLET,
        custodyModel: "passkey", sessionFacts: facts(), status: "armed" })).id, "other-owner");
      assert.equal((await passkey.createAgent({ id: "other-wallet", ownerAddress: OWNER, walletAddress: OTHER_WALLET,
        custodyModel: "passkey", sessionFacts: facts(), status: "armed" })).id, "other-wallet");
      await passkey.close();

      const legacy = await factory.make();
      await legacy.createAgent({ id: "legacy-a", ownerAddress: OWNER, walletAddress: WALLET,
        custodyModel: "self-eoa", sessionFacts: facts(), status: "armed" });
      assert.equal((await legacy.createAgent({ id: "legacy-b", ownerAddress: OWNER, walletAddress: WALLET,
        custodyModel: "self-eoa", sessionFacts: facts(), status: "armed" })).id, "legacy-b");
      await legacy.close();
    });
  });
}

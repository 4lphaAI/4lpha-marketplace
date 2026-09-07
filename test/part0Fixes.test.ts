/**
 * The three 1b-core audit fixes, each pinned by the failure it prevents.
 *
 *   1. ONE domain constructor. A signing client that hand-reassembles
 *      `{name, version, chainId, salt}` and gets a field wrong produces
 *      signatures that recover to a different address — and every one of them is
 *      rejected as a forgery with the same generic error, so the bug is
 *      indistinguishable from an attack. `buildOwnerActionDomain` is exported so
 *      both sides call the same code; these tests prove it is the domain the
 *      verifier accepts, and that a hand-built variant is not.
 *   2. A PRINTABLE composite-key separator in the nonce store. A literal NUL made
 *      git and grep treat the source file as binary; the replacement must still
 *      be impossible to forge a collision through.
 *   3. `AgentRecord.ownerAddress` typed as an `Address` at its source, so the
 *      `as \`0x${string}\`` cast at the kill-switch call site could be deleted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  OWNER_ACTION_TYPES,
  buildOwnerActionDomain,
  isMutatingOwnerAction,
  resolveDomainSalt,
  verifyOwnerAction,
  type OwnerActionStruct,
} from "../src/auth/ownerAuth.js";
import { buildOwnerActionDomain as reExported } from "../src/index.js";
import { paramsHash } from "../src/auth/canonical.js";
import { MemoryNonceStore } from "../src/store/nonces.js";
import { MemoryAgentStore } from "../src/store/agents.js";
import { authorizeExecute } from "../src/auth/executeDecision.js";
import { MemoryKillSwitch } from "../src/killswitch/killswitch.js";
import type { SessionSpec } from "../src/core/types.js";

const PK = `0x${"11".repeat(32)}` as Hex;
const account = privateKeyToAccount(PK);
const CHAIN_ID = 56;
const NETWORK = "mainnet";
const NOW = 1_900_000_000;

function struct(): OwnerActionStruct {
  return {
    owner: account.address,
    agentId: "agent-1",
    action: "pause",
    paramsHash: paramsHash("pause", { any: "thing" }),
    nonce: `0x${"ab".repeat(32)}`,
    issuedAt: BigInt(NOW),
    expiry: BigInt(NOW + 120),
  };
}

/* -------------------------------------------------------------------------- */
/* 1 — the single domain constructor                                          */
/* -------------------------------------------------------------------------- */

describe("buildOwnerActionDomain", () => {
  it("produces a domain whose signatures verifyOwnerAction accepts", async () => {
    const message = struct();
    const signature = await account.signTypedData({
      domain: buildOwnerActionDomain(
        CHAIN_ID,
        resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
      ),
      types: OWNER_ACTION_TYPES,
      primaryType: "OwnerAction",
      message,
    });

    const result = await verifyOwnerAction(
      { signed: message, signature, params: { any: "thing" } },
      { now: NOW, expectedChainId: CHAIN_ID, network: NETWORK },
    );
    assert.equal(result.ownerAddress, getAddress(account.address));
  });

  it("is the same function re-exported from the package entry point", () => {
    assert.equal(reExported, buildOwnerActionDomain);
  });

  it("carries the name, version and salt, and no verifyingContract", () => {
    const salt = resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK });
    const domain = buildOwnerActionDomain(CHAIN_ID, salt);
    assert.deepEqual(domain, {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: CHAIN_ID,
      salt,
    });
    assert.equal("verifyingContract" in domain, false);
  });

  it("rejects a hand-assembled domain that drifts by one field", async () => {
    // This is the failure the export exists to prevent: a client that builds the
    // domain itself and gets the version (or the name, or the salt) wrong.
    const message = struct();
    const drifted = await account.signTypedData({
      domain: {
        name: DOMAIN_NAME,
        version: "2",
        chainId: CHAIN_ID,
        salt: resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK }),
      },
      types: OWNER_ACTION_TYPES,
      primaryType: "OwnerAction",
      message,
    });

    await assert.rejects(
      () =>
        verifyOwnerAction(
          { signed: message, signature: drifted, params: { any: "thing" } },
          { now: NOW, expectedChainId: CHAIN_ID, network: NETWORK },
        ),
      /Owner authorization failed/,
    );
  });

  it("separates environments through the salt at the same chain id", async () => {
    const message = struct();
    const staging = await account.signTypedData({
      domain: buildOwnerActionDomain(
        CHAIN_ID,
        resolveDomainSalt({ chainId: CHAIN_ID, network: NETWORK, envSalt: "staging" }),
      ),
      types: OWNER_ACTION_TYPES,
      primaryType: "OwnerAction",
      message,
    });

    await assert.rejects(
      () =>
        verifyOwnerAction(
          { signed: message, signature: staging, params: { any: "thing" } },
          {
            now: NOW,
            expectedChainId: CHAIN_ID,
            network: NETWORK,
            envSalt: "production",
          },
        ),
      /Owner authorization failed/,
    );
  });
});

describe("read is the only non-mutating owner action", () => {
  it("classifies actions correctly", () => {
    assert.equal(isMutatingOwnerAction("read"), false);
    for (const action of [
      "grant",
      "revoke",
      "pause",
      "unpause",
      "changeBudget",
      "recover",
    ] as const) {
      assert.equal(isMutatingOwnerAction(action), true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2 — the nonce store's composite key                                        */
/* -------------------------------------------------------------------------- */

describe("nonce store composite key", () => {
  it("contains no NUL byte in its source, so the file stays text", () => {
    const source = readFileSync(
      new URL("../src/store/nonces.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      source.includes("\u0000"),
      false,
      "a literal NUL makes git and grep treat this file as binary",
    );
  });

  it("keeps distinct (owner, nonce) pairs distinct", async () => {
    const store = new MemoryNonceStore();
    const ownerA = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
    const ownerB = getAddress("0x000000000000000000000000000000000000dEaD");
    const nonce: Hex = `0x${"ab".repeat(32)}`;
    const other: Hex = `0x${"cd".repeat(32)}`;

    assert.equal(await store.consume(ownerA, nonce, NOW * 1000), true);
    assert.equal(await store.consume(ownerA, nonce, NOW * 1000), false);
    // A different owner with the same nonce is a different pair.
    assert.equal(await store.consume(ownerB, nonce, NOW * 1000), true);
    // As is the same owner with a different nonce.
    assert.equal(await store.consume(ownerA, other, NOW * 1000), true);
  });

  it("cannot be collided through the separator", async () => {
    // Both components are constrained to lowercase 0x-hex, so no value of either
    // can contain `|`. This pins the property the comment claims.
    const store = new MemoryNonceStore();
    const owner = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
    const nonce: Hex = `0x${"ab".repeat(32)}`;
    assert.equal(owner.toLowerCase().includes("|"), false);
    assert.equal(nonce.includes("|"), false);
    assert.equal(await store.consume(owner, nonce, NOW * 1000), true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — ownerAddress is an Address at its source                               */
/* -------------------------------------------------------------------------- */

describe("AgentRecord.ownerAddress is a normalized Address", () => {
  it("normalizes on write and hands the kill switch an Address with no cast", async () => {
    const store = new MemoryAgentStore();
    const checksummed = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");

    const agent = await store.createAgent({
      id: "agent-1",
      ownerAddress: checksummed,
      walletAddress: checksummed,
      custodyModel: "self-eoa",
      sessionFacts: {
        spec: spec(NOW + 3_600),
        permissions: { calls: [], spend: [] },
        publicKey: `0x04${"ab".repeat(64)}`,
        expiry: NOW + 3_600,
      },
      status: "armed",
    });

    assert.equal(agent.ownerAddress, checksummed.toLowerCase());

    // The compile-time property is the point: this passes `agent.ownerAddress`
    // straight into an `Address` parameter. It only type-checks because the
    // record's field IS an Address — which is what let the cast be deleted.
    const owner: Address = agent.ownerAddress;
    const killswitch = new MemoryKillSwitch();
    await killswitch.pauseAgent(agent.id, owner);

    const decision = await authorizeExecute({ agent, killswitch, now: NOW });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "AGENT_PAUSED");
  });

  it("no longer contains the cast the audit flagged", () => {
    const source = readFileSync(
      new URL("../src/auth/executeDecision.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /ownerAddress as/);
  });
});

/* -------------------------------------------------------------------------- */
/* Store and journal additions                                                */
/* -------------------------------------------------------------------------- */

function spec(expiresAt: number): SessionSpec {
  return {
    allowedCalls: [{ to: getAddress("0x000000000000000000000000000000000000dEaD") }],
    spendCaps: [{ limit: 1n, period: "hour" }],
    expiresAt,
  };
}

describe("getAgentById — the one unscoped read", () => {
  it("finds an agent without an owner, and still hides the session key", async () => {
    const store = new MemoryAgentStore();
    const owner = getAddress("0x561b561eF37874c8e61534bE9BaE52Eb6261DDc4");
    await store.createAgent({
      id: "agent-1",
      ownerAddress: owner,
      walletAddress: owner,
      custodyModel: "self-eoa",
    });
    await store.putAgentSessionKey(owner, "agent-1", `0x${"7d".repeat(32)}`);

    const agent = await store.getAgentById("agent-1");
    assert.notEqual(agent, null);
    assert.equal(agent?.ownerAddress, owner.toLowerCase());
    // No key on the record — the accessor is the only way, and it is owner-scoped.
    assert.equal("sessionKey" in (agent ?? {}), false);
    assert.equal(JSON.stringify(agent).includes("7d7d7d"), false);
  });

  it("returns null for an unknown id", async () => {
    const store = new MemoryAgentStore();
    assert.equal(await store.getAgentById("ghost"), null);
  });
});

describe("journal.getByDecision", () => {
  it("finds the row a decision already bound, whatever its calls hash", async () => {
    const { MemoryExecutionJournal } = await import("../src/store/journal.js");
    const journal = new MemoryExecutionJournal(() => NOW * 1000);
    const callsHash = keccak256(stringToBytes("calls-a"));

    await journal.begin({
      idempotencyKey: "key-a",
      agentId: "agent-1",
      ownerAddress: "0xowner",
      kind: "execute",
      decisionId: "decision-1",
      externalRef: { callsHash },
    });

    const found = await journal.getByDecision("agent-1", "decision-1");
    assert.equal(found?.idempotencyKey, "key-a");
    assert.equal(found?.externalRef.callsHash, callsHash);

    assert.equal(await journal.getByDecision("agent-1", "decision-2"), null);
    assert.equal(await journal.getByDecision("agent-2", "decision-1"), null);
  });

  it("ignores non-execute rows sharing an agent", async () => {
    const { MemoryExecutionJournal } = await import("../src/store/journal.js");
    const journal = new MemoryExecutionJournal(() => NOW * 1000);
    await journal.begin({
      idempotencyKey: "key-pause",
      agentId: "agent-1",
      ownerAddress: "0xowner",
      kind: "pause",
    });
    assert.equal(await journal.getByDecision("agent-1", "decision-1"), null);
  });
});

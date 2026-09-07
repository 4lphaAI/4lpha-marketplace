/**
 * Offline tests for the EIP-712 owner-action verifier.
 *
 * Signing is done locally with viem's private-key account (no network), against
 * the SAME domain and types the verifier rebuilds — so a valid path verifies and
 * every tampering or replay class is rejected with the one generic error.
 *
 * The properties under test map directly to the attack classes:
 *   - paramsHash binding (per action), so a signature for X cannot act on Y;
 *   - replay across agent / action / chain / environment, and owner ≠ recovered;
 *   - the freshness window, both ends and the maximum span;
 *   - nonce ordering: a crypto failure never consumes a nonce.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  OWNER_ACTION_TYPES,
  OwnerAuthError,
  authorizeOwnerAction,
  resolveDomainSalt,
  verifyOwnerAction,
  type OwnerActionStruct,
  type OwnerActionType,
} from "../src/auth/ownerAuth.js";
import { paramsHash } from "../src/auth/canonical.js";
import { MemoryNonceStore, type NonceStore } from "../src/store/nonces.js";

const PK1 = `0x${"11".repeat(32)}` as Hex;
const PK2 = `0x${"22".repeat(32)}` as Hex;
const account1 = privateKeyToAccount(PK1);
const account2 = privateKeyToAccount(PK2);

const CHAIN_ID = 56;
const NETWORK = "mainnet";
const NOW = 1_900_000_000;

type SignEnv = { chainId?: number; network?: string; envSalt?: string };

function domainFor(env: SignEnv) {
  const chainId = env.chainId ?? CHAIN_ID;
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    salt: resolveDomainSalt({
      chainId,
      network: env.network ?? NETWORK,
      ...(env.envSalt === undefined ? {} : { envSalt: env.envSalt }),
    }),
  } as const;
}

async function sign(
  pk: Hex,
  message: OwnerActionStruct,
  env: SignEnv = {},
): Promise<Hex> {
  const account = privateKeyToAccount(pk);
  return account.signTypedData({
    domain: domainFor(env),
    types: OWNER_ACTION_TYPES,
    primaryType: "OwnerAction",
    message,
  });
}

const NONCE = `0x${"ab".repeat(32)}` as Hex;

function struct(overrides: Partial<OwnerActionStruct> = {}): OwnerActionStruct {
  const action: OwnerActionType = overrides.action ?? "pause";
  const params = "params" in overrides ? undefined : { any: "thing" };
  return {
    owner: account1.address,
    agentId: "agent-1",
    action,
    paramsHash: overrides.paramsHash ?? paramsHash(action, params),
    nonce: NONCE,
    issuedAt: BigInt(NOW),
    expiry: BigInt(NOW + 120),
    ...overrides,
  };
}

describe("verifyOwnerAction — happy path", () => {
  it("recovers the owner and returns action + agentId", async () => {
    const message = struct({ action: "pause", paramsHash: paramsHash("pause", { any: "thing" }) });
    const signature = await sign(PK1, message);
    const result = await verifyOwnerAction(
      { signed: message, signature, params: { any: "thing" } },
      { now: NOW + 10, expectedChainId: CHAIN_ID, network: NETWORK },
    );
    assert.equal(result.ownerAddress, getAddress(account1.address));
    assert.equal(result.action, "pause");
    assert.equal(result.agentId, "agent-1");
  });
});

describe("verifyOwnerAction — paramsHash binding", () => {
  const cases: ReadonlyArray<{
    name: string;
    action: OwnerActionType;
    signedParams: unknown;
    attackParams: unknown;
  }> = [
    {
      name: "grant spec swap",
      action: "grant",
      signedParams: { spec: { allowedCalls: [{ to: account2.address }], expiresAt: 1 } },
      attackParams: { spec: { allowedCalls: [{ to: account1.address }], expiresAt: 1 } },
    },
    {
      name: "recover to swap",
      action: "recover",
      signedParams: { to: account2.address },
      attackParams: { to: account1.address },
    },
    {
      name: "changeBudget amount swap",
      action: "changeBudget",
      signedParams: { amount: 1_000n },
      attackParams: { amount: 9_999n },
    },
  ];

  for (const testCase of cases) {
    it(`accepts the real params and rejects a swap (${testCase.name})`, async () => {
      const message = struct({
        action: testCase.action,
        paramsHash: paramsHash(testCase.action, testCase.signedParams),
      });
      const signature = await sign(PK1, message);
      const opts = { now: NOW + 10, expectedChainId: CHAIN_ID, network: NETWORK };

      // Control: the real params verify.
      const ok = await verifyOwnerAction(
        { signed: message, signature, params: testCase.signedParams },
        opts,
      );
      assert.equal(ok.action, testCase.action);

      // Swap: different params ⇒ rejected.
      await assert.rejects(
        verifyOwnerAction(
          { signed: message, signature, params: testCase.attackParams },
          opts,
        ),
        (error: unknown) => error instanceof OwnerAuthError,
      );
    });
  }
});

describe("verifyOwnerAction — replay classes", () => {
  const params = { any: "thing" };
  const opts = { now: NOW + 10, expectedChainId: CHAIN_ID, network: NETWORK };

  async function rejectsTampered(mutate: (m: OwnerActionStruct) => OwnerActionStruct) {
    const signedMessage = struct({ action: "pause", paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, signedMessage);
    await assert.rejects(
      verifyOwnerAction({ signed: mutate(signedMessage), signature, params }, opts),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  }

  it("rejects a cross-agent replay", async () => {
    await rejectsTampered((m) => ({ ...m, agentId: "other-agent" }));
  });

  it("rejects a cross-action replay", async () => {
    await rejectsTampered((m) => ({ ...m, action: "revoke" }));
  });

  it("rejects a cross-chain signature (different domain chainId)", async () => {
    const message = struct({ action: "pause", paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, message, { chainId: 97, network: "testnet" });
    await assert.rejects(
      verifyOwnerAction({ signed: message, signature, params }, opts),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });

  it("rejects a cross-environment signature (different salt)", async () => {
    const message = struct({ action: "pause", paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, message, { envSalt: "staging" });
    await assert.rejects(
      verifyOwnerAction(
        { signed: message, signature, params },
        { ...opts, envSalt: "production" },
      ),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });

  it("rejects when the declared owner is not the recovered signer", async () => {
    const message = struct({
      owner: getAddress(account2.address) as Address,
      action: "pause",
      paramsHash: paramsHash("pause", params),
    });
    // Signed by account1, but the struct claims account2 as owner.
    const signature = await sign(PK1, message);
    await assert.rejects(
      verifyOwnerAction({ signed: message, signature, params }, opts),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });
});

describe("verifyOwnerAction — freshness window", () => {
  const params = { any: "thing" };
  const opts = { expectedChainId: CHAIN_ID, network: NETWORK };

  it("rejects an expired signature", async () => {
    const message = struct({ paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, message);
    await assert.rejects(
      verifyOwnerAction({ signed: message, signature, params }, { ...opts, now: NOW + 1_000 }),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });

  it("rejects an issuedAt too far in the future (beyond skew)", async () => {
    const message = struct({
      issuedAt: BigInt(NOW + 500),
      expiry: BigInt(NOW + 600),
      paramsHash: paramsHash("pause", params),
    });
    const signature = await sign(PK1, message);
    await assert.rejects(
      verifyOwnerAction({ signed: message, signature, params }, { ...opts, now: NOW }),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });

  it("rejects a signed window longer than the maximum (300s)", async () => {
    const message = struct({
      issuedAt: BigInt(NOW),
      expiry: BigInt(NOW + 301),
      paramsHash: paramsHash("pause", params),
    });
    const signature = await sign(PK1, message);
    await assert.rejects(
      verifyOwnerAction({ signed: message, signature, params }, { ...opts, now: NOW + 10 }),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });

  it("accepts a signature within skew of issuedAt", async () => {
    const message = struct({ paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, message);
    // now is 5s before issuedAt, inside the 30s default skew.
    const result = await verifyOwnerAction(
      { signed: message, signature, params },
      { ...opts, now: NOW - 5 },
    );
    assert.equal(result.action, "pause");
  });
});

describe("authorizeOwnerAction — nonce ordering", () => {
  const params = { any: "thing" };
  const opts = { now: NOW + 10, expectedChainId: CHAIN_ID, network: NETWORK };

  function countingStore(): { store: NonceStore; consumes: () => number } {
    const inner = new MemoryNonceStore();
    let calls = 0;
    const store: NonceStore = {
      consume: (owner, nonce, expiresAt) => {
        calls += 1;
        return inner.consume(owner, nonce, expiresAt);
      },
      withProvisionClaimLock: (owner, nonce, operation) =>
        inner.withProvisionClaimLock(owner, nonce, operation),
      prune: (now) => inner.prune(now),
      close: () => inner.close(),
    };
    return { store, consumes: () => calls };
  }

  it("does not consume the nonce when a crypto check fails", async () => {
    const message = struct({ action: "pause", paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, message);
    const { store, consumes } = countingStore();

    // Wrong params ⇒ paramsHash recompute fails BEFORE any consume.
    await assert.rejects(
      authorizeOwnerAction(
        { signed: message, signature, params: { any: "different" } },
        { ...opts, nonceStore: store },
      ),
      (error: unknown) => error instanceof OwnerAuthError,
    );
    assert.equal(consumes(), 0);

    // The same nonce is still fresh for a valid request afterwards.
    const ok = await authorizeOwnerAction(
      { signed: message, signature, params },
      { ...opts, nonceStore: store },
    );
    assert.equal(ok.action, "pause");
    assert.equal(consumes(), 1);
  });

  it("rejects a replay of an already-consumed nonce", async () => {
    const message = struct({ action: "pause", paramsHash: paramsHash("pause", params) });
    const signature = await sign(PK1, message);
    const store = new MemoryNonceStore();

    await authorizeOwnerAction({ signed: message, signature, params }, { ...opts, nonceStore: store });
    await assert.rejects(
      authorizeOwnerAction({ signed: message, signature, params }, { ...opts, nonceStore: store }),
      (error: unknown) => error instanceof OwnerAuthError,
    );
  });
});

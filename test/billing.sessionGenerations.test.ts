import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, type Hex } from "viem";
import { authorizeOwnerAction } from "../src/auth/ownerAuth.js";
import { paramsHash } from "../src/auth/canonical.js";
import { parseOwnerActionEnvelope } from "../src/http/wire.js";
import {
  MemoryBillingSessionGenerationRepository,
  canonicalBillingSessionOwnerParams,
  finalizedBillingSessionProof,
  transitionBillingSessionAction,
  validateBillingSessionGeneration,
  type BillingSessionActionV1,
  type BillingSessionChainObservationV1,
  type BillingSessionGenerationV1,
} from "../src/billing/sessionGenerations.js";
import { MemoryNonceStore } from "../src/store/nonces.js";
import { CHAIN_ID, NETWORK, NOW_SEC, signOwnerAction } from "./support/serverHarness.js";

const WALLET = `0x${"12".repeat(20)}` as const;
const KEYSTORE = "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" as const;
const COLLECTOR = `0x${"14".repeat(20)}` as const;
const PUB1 = `0x04${"11".repeat(64)}` as Hex;
const PUB2 = `0x04${"22".repeat(64)}` as Hex;
const KEY1 = keccak256(PUB1);
const KEY2 = keccak256(PUB2);
const ACTION1 = `0x${"31".repeat(32)}` as Hex;
const ACTION2 = `0x${"32".repeat(32)}` as Hex;
const ACTION3 = `0x${"33".repeat(32)}` as Hex;
const CALLS1 = `0x${"41".repeat(32)}` as Hex;
const CALLS2 = `0x${"42".repeat(32)}` as Hex;
const CALLS3 = `0x${"43".repeat(32)}` as Hex;
const TX1 = `0x${"51".repeat(32)}` as Hex;
const TX2 = `0x${"52".repeat(32)}` as Hex;
const TX3 = `0x${"53".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"61".repeat(32)}` as Hex;

function generation(number: bigint, publicKey: Hex, now = 10): BillingSessionGenerationV1 {
  const facts = sessionFacts(publicKey);
  return {
    accountId: "account",
    generation: number,
    kmsKeyArn: `arn:aws:kms:us-east-1:123456789012:key/generation-${number.toString()}`,
    publicKey,
    sessionFactsBytes: facts,
    sessionFactsHash: keccak256(Buffer.from(facts, "base64")),
    expiresAt: 2_000,
    state: "prepared",
    version: 1n,
    createdAt: now,
    updatedAt: now,
  };
}

function factsHash(number: bigint): Hex {
  return keccak256(Buffer.from(sessionFacts(number === 2n ? PUB2 : PUB1), "base64"));
}

function sessionFacts(publicKey: Hex): string {
  const bytes = JSON.stringify({
    version: "billing-session-facts-v1",
    spec: { allowedCalls: [{ to: COLLECTOR, selector: "payInvoice(bytes32,uint64)" }],
      spendCaps: [{ limit: "1000", period: "day" }], expiresAt: 2_000 },
    permissions: { calls: [{ signature: "payInvoice(bytes32,uint64)", to: COLLECTOR }],
      spend: [{ limit: { $uint: "1000" }, period: "day" }] },
    publicKey, expiry: 2_000,
  });
  return Buffer.from(bytes, "utf8").toString("base64");
}

function action(input: Readonly<{
  actionId?: Hex;
  kind?: "grant" | "revoke";
  generation?: bigint;
  targetGeneration?: bigint;
  targetKeyId?: Hex;
  nonceByte?: string;
}> = {}): BillingSessionActionV1 {
  const actionId = input.actionId ?? ACTION1;
  const byte = input.nonceByte ?? actionId.slice(2, 4);
  const kind = input.kind ?? "grant";
  const number = input.generation ?? 1n;
  const target = input.targetGeneration ?? 1n;
  const targetKeyId = input.targetKeyId ?? KEY1;
  const nonce = `0x${byte.repeat(32)}` as Hex;
  const ownerParams = canonicalBillingSessionOwnerParams({
    action: kind,
    accountId: "account",
    wallet: WALLET,
    oldGeneration: kind === "revoke" ? target : number - 1n,
    newGeneration: number,
    kmsPublicKey: targetKeyId === KEY2 ? PUB2 : PUB1,
    keyId: targetKeyId,
    sessionFactsHash: factsHash(target),
    collector: COLLECTOR,
    dayCapWei: 1_000n,
    expiry: 2_000,
    nonce,
    issuedAt: 10,
    expiresAt: 200,
  });
  return {
    actionId,
    accountId: "account",
    generation: number,
    kind,
    targetGeneration: target,
    targetKeyId,
    nonce,
    ownerActionIdempotencyKey: keccak256(Buffer.from(`owner-${actionId}`)),
    ownerParamsBytes: ownerParams.canonical,
    ownerParamsHash: ownerParams.paramsHash,
    state: "prepared",
    version: 1n,
    createdAt: 10,
    updatedAt: 10,
  };
}

function observation(
  row: BillingSessionActionV1,
  input: Readonly<{ transactionHash?: Hex; latestBlockNumber?: bigint }> = {},
): BillingSessionChainObservationV1 {
  const grant = row.kind === "grant";
  return {
    chainId: 56,
    receiptStatus: "success",
    action: row.kind,
    wallet: WALLET,
    keyStore: KEYSTORE,
    keyId: row.targetKeyId,
    callsId: row.callsId ?? CALLS1,
    transactionHash: input.transactionHash ?? TX1,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    latestBlockNumber: input.latestBlockNumber ?? 115n,
    stateBlockNumber: 100n,
    keyStoreValid: grant,
    accountKeyAbsent: true,
    ...(grant ? { canPayCollector: true, dayLimitWei: 1_000n, currentSpentWei: 100n } : {}),
  };
}

describe("billing session generation saga", () => {
  it("adds both exact owner actions to the runtime verifier and nonce-consuming path", async () => {
    for (const ownerAction of ["billingSessionGrant", "billingSessionRevoke"] as const) {
      const request = await signOwnerAction(ownerAction, { accountId: "account" });
      const parsed = parseOwnerActionEnvelope(request);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error("Owner-action test envelope did not parse.");
      const result = await authorizeOwnerAction(parsed.value, {
        now: NOW_SEC,
        expectedChainId: CHAIN_ID,
        network: NETWORK,
        nonceStore: new MemoryNonceStore(),
      });
      assert.equal(result.action, ownerAction);
    }
  });

  it("canonicalizes the owner-visible grant/revoke object and binds key ID to the KMS public key", () => {
    const result = canonicalBillingSessionOwnerParams({
      action: "grant",
      accountId: "account",
      wallet: WALLET,
      oldGeneration: 0n,
      newGeneration: 1n,
      kmsPublicKey: PUB1,
      keyId: KEY1,
      sessionFactsHash: `0x${"71".repeat(32)}`,
      collector: COLLECTOR,
      dayCapWei: 1n,
      expiry: 2_000,
      nonce: `0x${"72".repeat(32)}`,
      issuedAt: 100,
      expiresAt: 200,
    });
    assert.equal(result.paramsHash, paramsHash("billingSessionGrant", result.params));
    assert.deepEqual(Object.keys(JSON.parse(result.canonical) as object), [
      "domain", "action", "accountId", "wallet", "oldGeneration", "newGeneration",
      "kmsPublicKey", "keyId", "sessionFactsHash", "chainId", "keyStore", "collector",
      "dayCapWei", "expiry", "nonce", "issuedAt", "expiresAt",
    ]);
    const revoke = canonicalBillingSessionOwnerParams({
      action: "revoke", accountId: "account", wallet: WALLET,
      oldGeneration: 1n, newGeneration: 2n, kmsPublicKey: PUB1, keyId: KEY1,
      sessionFactsHash: `0x${"71".repeat(32)}`, collector: COLLECTOR,
      dayCapWei: 1n, expiry: 2_000, nonce: `0x${"73".repeat(32)}`,
      issuedAt: 100, expiresAt: 200,
    });
    assert.equal(revoke.paramsHash, paramsHash("billingSessionRevoke", revoke.params));
    assert.throws(() => canonicalBillingSessionOwnerParams({
      ...JSON.parse(result.canonical) as Record<string, never>,
      action: "grant",
      accountId: "account",
      wallet: WALLET,
      oldGeneration: 0n,
      newGeneration: 1n,
      kmsPublicKey: PUB1,
      keyId: KEY2,
      sessionFactsHash: `0x${"71".repeat(32)}`,
      collector: COLLECTOR,
      dayCapWei: 1n,
      expiry: 2_000,
      nonce: `0x${"72".repeat(32)}`,
      issuedAt: 100,
      expiresAt: 200,
    }), /identity/);
  });

  it("validates canonical KMS generation facts and rejects altered or noncanonical facts bytes", () => {
    const base = generation(1n, PUB1);
    assert.doesNotThrow(() => validateBillingSessionGeneration(base));
    assert.throws(() => validateBillingSessionGeneration({ ...base, sessionFactsHash: KEY2 }), /hash mismatch/);
    assert.throws(() => validateBillingSessionGeneration({ ...base, sessionFactsBytes: "e30" }), /base64/);
  });

  it("requires immutable calls identity and finalized proof for contacted action transitions", () => {
    assert.throws(() => transitionBillingSessionAction(action(), 1n, "submitted", {}, 11), /calls ID/);
    const submitted = transitionBillingSessionAction(action(), 1n, "submitted", { callsId: CALLS1 }, 11);
    assert.throws(() => transitionBillingSessionAction(submitted, 2n, "unknown", { callsId: CALLS2 }, 12), /immutable/);
    assert.throws(() => transitionBillingSessionAction(submitted, 2n, "confirmed", {}, 12), /finalized proof/);
    const confirmed = transitionBillingSessionAction(submitted, 2n, "confirmed", {
      transactionHash: TX1,
      proofHash: KEY2,
    }, 12);
    assert.equal(confirmed.state, "confirmed");
    assert.throws(() => transitionBillingSessionAction(confirmed, 3n, "confirmed", {}, 13), /CAS/);
  });

  it("builds exact canonical finalized grant/revoke proofs only from agreeing finalized observations", () => {
    const submittedGrant = transitionBillingSessionAction(action(), 1n, "submitted", { callsId: CALLS1 }, 11);
    const first = observation(submittedGrant);
    const grant = finalizedBillingSessionProof({
      action: submittedGrant,
      wallet: WALLET,
      keyStore: KEYSTORE,
      finalityDepth: 15,
      observations: [first, { ...first, latestBlockNumber: 116n }],
    });
    assert.equal(grant.proof.schema, "4lpha.billing-session-grant-proof.v1");
    assert.equal(grant.proofHash, keccak256(Buffer.from(grant.canonical)));
    assert.deepEqual(Object.keys(grant.proof), [
      "schema", "actionId", "callsId", "transactionHash", "blockNumber", "blockHash",
      "keyStoreValid", "accountKeyAbsent", "canPayCollector", "dayLimitWei", "currentSpentWei",
    ]);

    const revokeRow = action({ actionId: ACTION3, kind: "revoke", generation: 2n, targetGeneration: 1n, targetKeyId: KEY1 });
    const submittedRevoke = transitionBillingSessionAction(revokeRow, 1n, "submitted", { callsId: CALLS3 }, 11);
    const revokeObservation = observation(submittedRevoke, { transactionHash: TX3 });
    const revoke = finalizedBillingSessionProof({
      action: submittedRevoke,
      wallet: WALLET,
      keyStore: KEYSTORE,
      finalityDepth: 15,
      observations: [revokeObservation, { ...revokeObservation, latestBlockNumber: 120n }],
    });
    assert.equal(revoke.proof.schema, "4lpha.billing-session-revoke-proof.v1");
    assert.deepEqual(Object.keys(revoke.proof), [
      "schema", "actionId", "callsId", "transactionHash", "blockNumber", "blockHash",
      "keyStoreValid", "accountKeyAbsent",
    ]);
  });

  it("refuses non-final, failed, wrong-block, wrong-key, or disagreeing dual proof", () => {
    const submitted = transitionBillingSessionAction(action(), 1n, "submitted", { callsId: CALLS1 }, 11);
    const valid = observation(submitted);
    const prove = (left: BillingSessionChainObservationV1, right = left) => finalizedBillingSessionProof({
      action: submitted, wallet: WALLET, keyStore: KEYSTORE, finalityDepth: 15, observations: [left, right],
    });
    assert.throws(() => prove({ ...valid, latestBlockNumber: 114n }), /finalized/);
    assert.throws(() => prove({ ...valid, receiptStatus: "failed" }), /finalized/);
    assert.throws(() => prove({ ...valid, stateBlockNumber: 99n }), /finalized/);
    assert.throws(() => prove({ ...valid, keyId: KEY2 }), /finalized/);
    assert.throws(() => prove(valid, { ...valid, keyStoreValid: false }), /disagree/);
    assert.throws(() => prove({ ...valid, currentSpentWei: 1_001n }), /permission/);
    assert.throws(() => prove({ ...valid, dayLimitWei: 999n, currentSpentWei: 100n }), /permission/);
    assert.throws(() => prove({ ...valid, dayLimitWei: 1_001n, currentSpentWei: 100n }), /permission/);
  });

  it("refuses owner facts-hash, collector, and expiry substitutions at action insertion", async () => {
    const repo = new MemoryBillingSessionGenerationRepository([
      { accountId: "account", walletAddress: WALLET, status: "paused", currentGeneration: null, version: 1n },
    ]);
    const row = generation(1n, PUB1);
    await repo.insertGeneration(row);
    const base = action();
    const altered = (change: Readonly<{ sessionFactsHash?: Hex; collector?: string; expiry?: number }>) => {
      const owner = canonicalBillingSessionOwnerParams({
        action: "grant", accountId: "account", wallet: WALLET, oldGeneration: 0n, newGeneration: 1n,
        kmsPublicKey: PUB1, keyId: KEY1, sessionFactsHash: change.sessionFactsHash ?? row.sessionFactsHash,
        collector: change.collector ?? COLLECTOR, dayCapWei: 1_000n, expiry: change.expiry ?? 2_000,
        nonce: base.nonce, issuedAt: 10, expiresAt: 200,
      });
      return { ...base, ownerParamsBytes: owner.canonical, ownerParamsHash: owner.paramsHash };
    };
    await assert.rejects(repo.insertAction(altered({ sessionFactsHash: KEY2 })), /canonical generation facts/);
    await assert.rejects(repo.insertAction(altered({ collector: `0x${"15".repeat(20)}` })), /canonical generation facts/);
    await assert.rejects(repo.insertAction(altered({ expiry: 2_001 })), /canonical generation facts/);
  });

  it("atomically accepts or refuses a prepared grant with action/generation CAS", async () => {
    const acceptedRepo = new MemoryBillingSessionGenerationRepository([
      { accountId: "account", walletAddress: WALLET, status: "paused", currentGeneration: null, version: 1n },
    ]);
    await acceptedRepo.insertGeneration(generation(1n, PUB1));
    await acceptedRepo.insertAction(action());
    const accepted = await acceptedRepo.acceptPreparedAction(ACTION1, 1n, 1n, CALLS1, 11);
    assert.equal(accepted.action.state, "submitted");
    assert.equal(accepted.generation.state, "grant_pending");
    await assert.rejects(acceptedRepo.acceptPreparedAction(ACTION1, 1n, 1n, CALLS1, 11), /not found/);

    const refusedRepo = new MemoryBillingSessionGenerationRepository([
      { accountId: "account", walletAddress: WALLET, status: "paused", currentGeneration: null, version: 1n },
    ]);
    await refusedRepo.insertGeneration(generation(1n, PUB1));
    await refusedRepo.insertAction(action());
    const refused = await refusedRepo.refusePreparedAction(ACTION1, 1n, 1n, 11);
    assert.equal(refused.action.state, "owner_refused");
    assert.equal(refused.generation.state, "abandoned");
  });

  it("reconciles first grant, replacement grant, and old revoke without an unrepresented authority window", async () => {
    const repo = new MemoryBillingSessionGenerationRepository([
      { accountId: "account", walletAddress: WALLET, status: "paused", currentGeneration: null, version: 1n },
    ]);
    await repo.insertGeneration(generation(1n, PUB1));
    await repo.insertAction(action());
    const acceptedFirst = await repo.acceptPreparedAction(ACTION1, 1n, 1n, CALLS1, 11);
    const firstObservation = observation(acceptedFirst.action, { transactionHash: TX1 });
    let snapshot = await repo.finalizeAction({
      actionId: ACTION1,
      expectedActionVersion: 2n,
      expectedAccountVersion: 1n,
      expectedGenerationVersions: { "1": 2n },
      wallet: WALLET,
      keyStore: KEYSTORE,
      finalityDepth: 15,
      observations: [firstObservation, { ...firstObservation, latestBlockNumber: 116n }],
      now: 12,
    });
    assert.deepEqual({ status: snapshot.account.status, current: snapshot.account.currentGeneration }, { status: "active", current: 1n });
    assert.equal(snapshot.generations[0]?.state, "active");

    await repo.pauseForReplacement("account", 2n);
    await repo.insertGeneration(generation(2n, PUB2, 20));
    const replacementGrant = action({ actionId: ACTION2, generation: 2n, targetGeneration: 2n, targetKeyId: KEY2 });
    await repo.insertAction(replacementGrant);
    const acceptedReplacement = await repo.acceptPreparedAction(ACTION2, 1n, 1n, CALLS2, 21);
    const replacementObservation = observation(acceptedReplacement.action, { transactionHash: TX2 });
    snapshot = await repo.finalizeAction({
      actionId: ACTION2,
      expectedActionVersion: 2n,
      expectedAccountVersion: 3n,
      expectedGenerationVersions: { "1": 3n, "2": 2n },
      wallet: WALLET,
      keyStore: KEYSTORE,
      finalityDepth: 15,
      observations: [replacementObservation, { ...replacementObservation, latestBlockNumber: 117n }],
      now: 22,
    });
    assert.deepEqual({ status: snapshot.account.status, current: snapshot.account.currentGeneration }, { status: "paused", current: 1n });
    assert.equal(snapshot.generations.find((row) => row.generation === 1n)?.state, "active");
    assert.equal(snapshot.generations.find((row) => row.generation === 2n)?.state, "active_pending_old_revoke");

    const revoke = action({ actionId: ACTION3, kind: "revoke", generation: 2n, targetGeneration: 1n, targetKeyId: KEY1 });
    await repo.insertAction(revoke);
    const acceptedRevoke = await repo.acceptPreparedAction(ACTION3, 1n, 3n, CALLS3, 23);
    const revokeObservation = observation(acceptedRevoke.action, { transactionHash: TX3 });
    snapshot = await repo.finalizeAction({
      actionId: ACTION3,
      expectedActionVersion: 2n,
      expectedAccountVersion: 4n,
      expectedGenerationVersions: { "1": 3n, "2": 3n },
      wallet: WALLET,
      keyStore: KEYSTORE,
      finalityDepth: 15,
      observations: [revokeObservation, { ...revokeObservation, latestBlockNumber: 118n }],
      now: 24,
    });
    assert.deepEqual({ status: snapshot.account.status, current: snapshot.account.currentGeneration }, { status: "active", current: 2n });
    assert.equal(snapshot.generations.find((row) => row.generation === 1n)?.state, "retired");
    assert.equal(snapshot.generations.find((row) => row.generation === 2n)?.state, "active");
  });

  it("enforces generation monotonicity, KMS uniqueness, action uniqueness, and complete finalize CAS sets", async () => {
    const repo = new MemoryBillingSessionGenerationRepository([
      { accountId: "account", walletAddress: WALLET, status: "paused", currentGeneration: null, version: 1n },
    ]);
    const first = generation(1n, PUB1);
    await repo.insertGeneration(first);
    await assert.rejects(repo.insertGeneration({ ...generation(2n, PUB2), kmsKeyArn: first.kmsKeyArn }), /conflict/);
    await repo.insertAction(action());
    await assert.rejects(repo.insertAction(action({ actionId: ACTION2, nonceByte: "31" })), /unique/);
    const accepted = await repo.acceptPreparedAction(ACTION1, 1n, 1n, CALLS1, 11);
    const observed = observation(accepted.action);
    await assert.rejects(repo.finalizeAction({
      actionId: ACTION1,
      expectedActionVersion: 2n,
      expectedAccountVersion: 1n,
      expectedGenerationVersions: {},
      wallet: WALLET,
      keyStore: KEYSTORE,
      finalityDepth: 15,
      observations: [observed, observed],
      now: 12,
    }), /CAS/);
  });
});

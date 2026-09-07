import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type Hex } from "viem";
import { ownerActionIdempotencyKey } from "../src/auth/executeDecision.js";
import { MemoryBillingSessionGenerationRepository, canonicalBillingSessionOwnerParams,
  type BillingSessionActionV1, type BillingSessionGenerationV1 } from "../src/billing/sessionGenerations.js";
import { billingAccountId } from "../src/billing/serviceSession.js";
import { MemoryBillingStore } from "../src/billing/store.js";
import type { BillingAccount } from "../src/billing/types.js";
import {
  AGENT_ID,
  NOW_SEC,
  call,
  createHarness,
  ownerAccount,
  signOwnerAction,
  toReadHeader,
} from "./support/serverHarness.js";

const ACCOUNT_ID = billingAccountId(ownerAccount.address, ownerAccount.address);
const PUB = `0x04${"81".repeat(64)}` as Hex;
const KEY_ID = keccak256(PUB);
const ACTION_ID = `0x${"82".repeat(32)}` as Hex;
const NONCE = `0x${"83".repeat(32)}` as Hex;
const CALLS_ID = `0x${"84".repeat(32)}` as Hex;
const COLLECTOR = `0x${"85".repeat(20)}` as const;

async function fixture() {
  const store = new MemoryBillingStore();
  const account: BillingAccount = {
    accountId: ACCOUNT_ID,
    ownerAddress: ownerAccount.address.toLowerCase(),
    walletAddress: ownerAccount.address.toLowerCase(),
    status: "paused",
    sessionFactsBytes: "kms-session-v1",
    encryptedSessionKey: null,
    sessionKmsKeyArn: null,
    sessionGeneration: null,
    sessionPublicKey: null,
    sessionStateVersion: 1n,
    maxDailyUsdMicros: 5_000_000n,
    maxUnpaidExposureUsdMicros: 2_000_000n,
    thresholdUsdMicros: 100_000n,
    grantExpiresAt: NOW_SEC + 3_600,
    createdAt: NOW_SEC,
    updatedAt: NOW_SEC,
  };
  await store.createAccount(account);
  const repo = new MemoryBillingSessionGenerationRepository([
    { accountId: ACCOUNT_ID, walletAddress: ownerAccount.address, status: "paused", currentGeneration: null, version: 1n },
  ]);
  const facts = Buffer.from(JSON.stringify({
    version: "billing-session-facts-v1",
    spec: { allowedCalls: [{ to: COLLECTOR, selector: "payInvoice(bytes32,uint64)" }],
      spendCaps: [{ limit: "1000", period: "day" }], expiresAt: NOW_SEC + 3_600 },
    permissions: { calls: [{ signature: "payInvoice(bytes32,uint64)", to: COLLECTOR }],
      spend: [{ limit: { $uint: "1000" }, period: "day" }] },
    publicKey: PUB, expiry: NOW_SEC + 3_600,
  }), "utf8").toString("base64");
  const generation: BillingSessionGenerationV1 = {
    accountId: ACCOUNT_ID,
    generation: 1n,
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/session-route",
    publicKey: PUB,
    sessionFactsBytes: facts,
    sessionFactsHash: keccak256(Buffer.from(facts, "base64")),
    expiresAt: NOW_SEC + 3_600,
    state: "prepared",
    version: 1n,
    createdAt: NOW_SEC,
    updatedAt: NOW_SEC,
  };
  const preview = canonicalBillingSessionOwnerParams({
    action: "grant",
    accountId: ACCOUNT_ID,
    wallet: ownerAccount.address,
    oldGeneration: 0n,
    newGeneration: 1n,
    kmsPublicKey: PUB,
    keyId: KEY_ID,
    sessionFactsHash: generation.sessionFactsHash,
    collector: COLLECTOR,
    dayCapWei: 1_000n,
    expiry: NOW_SEC + 3_600,
    nonce: NONCE,
    issuedAt: NOW_SEC,
    expiresAt: NOW_SEC + 120,
  });
  const action: BillingSessionActionV1 = {
    actionId: ACTION_ID,
    accountId: ACCOUNT_ID,
    generation: 1n,
    kind: "grant",
    targetGeneration: 1n,
    targetKeyId: KEY_ID,
    nonce: NONCE,
    ownerActionIdempotencyKey: ownerActionIdempotencyKey({
      owner: ownerAccount.address,
      agentId: AGENT_ID,
      action: "billingSessionGrant",
      paramsHash: preview.paramsHash,
      nonce: NONCE,
      issuedAt: BigInt(NOW_SEC),
      expiry: BigInt(NOW_SEC + 120),
    }),
    ownerParamsBytes: preview.canonical,
    ownerParamsHash: preview.paramsHash,
    state: "prepared",
    version: 1n,
    createdAt: NOW_SEC,
    updatedAt: NOW_SEC,
  };
  await repo.insertGeneration(generation);
  await repo.insertAction(action);
  const harness = await createHarness({
    billingOwner: {
      store,
      sessionGenerations: repo,
      executionTicketKeyId: "unused",
      async signExecutionTicket() { throw new Error("not reachable"); },
      async onChainSessionExpiresAt() { throw new Error("not reachable"); },
      async actualUsdMicros() { return 0n; },
    },
  });
  return { harness, repo, preview };
}

test("billing session preview/accept/status uses owner auth and binds the one calls ID", async () => {
  const { harness, repo, preview } = await fixture();
  const read = await signOwnerAction("read", {});
  const previewResponse = await call(harness, `/agents/${AGENT_ID}/billing/session-actions/${ACTION_ID}/preview`, {
    method: "GET",
    headers: { "x-owner-action": toReadHeader(read) },
  });
  assert.equal(previewResponse.status, 200, previewResponse.text);
  const previewData = previewResponse.body["data"] as Record<string, unknown>;
  assert.equal(previewData["ownerParamsCanonical"], preview.canonical);
  assert.equal(previewData["ownerParamsHash"], preview.paramsHash);

  const signed = await signOwnerAction("billingSessionGrant", preview.params, {
    nonce: NONCE,
    issuedAt: NOW_SEC,
    expiry: NOW_SEC + 120,
  });
  const accepted = await call(harness, `/agents/${AGENT_ID}/billing/session-actions/grant/${ACTION_ID}/accept`, {
    method: "POST",
    body: { ...signed, callsId: CALLS_ID },
  });
  assert.equal(accepted.status, 200, accepted.text);
  const snapshot = await repo.snapshot(ACCOUNT_ID);
  assert.equal(snapshot?.actions[0]?.state, "submitted");
  assert.equal(snapshot?.actions[0]?.callsId, CALLS_ID);
  assert.equal(snapshot?.generations[0]?.state, "grant_pending");

  const statusRead = await signOwnerAction("read", {});
  const status = await call(harness, `/agents/${AGENT_ID}/billing/session-actions/${ACTION_ID}/status`, {
    method: "GET",
    headers: { "x-owner-action": toReadHeader(statusRead) },
  });
  assert.equal(status.status, 200, status.text);
  assert.equal((status.body["data"] as Record<string, unknown>)["callsId"], CALLS_ID);
});

test("billing session accept refuses unbound calls ID shapes and cross-action signatures", async () => {
  const { harness, preview } = await fixture();
  const wrongAction = await signOwnerAction("billingSessionRevoke", preview.params, {
    nonce: NONCE,
    issuedAt: NOW_SEC,
    expiry: NOW_SEC + 120,
  });
  const crossed = await call(harness, `/agents/${AGENT_ID}/billing/session-actions/grant/${ACTION_ID}/accept`, {
    method: "POST",
    body: { ...wrongAction, callsId: CALLS_ID },
  });
  assert.equal(crossed.status, 401);

  const signed = await signOwnerAction("billingSessionGrant", preview.params, {
    nonce: NONCE,
    issuedAt: NOW_SEC,
    expiry: NOW_SEC + 120,
  });
  const malformed = await call(harness, `/agents/${AGENT_ID}/billing/session-actions/grant/${ACTION_ID}/accept`, {
    method: "POST",
    body: { ...signed, callsId: "0x12" },
  });
  assert.equal(malformed.status, 400);
});

test("billing session owner refusal is terminal and creates no chain identity", async () => {
  const { harness, repo, preview } = await fixture();
  const signed = await signOwnerAction("billingSessionGrant", preview.params, {
    nonce: NONCE,
    issuedAt: NOW_SEC,
    expiry: NOW_SEC + 120,
  });
  const refused = await call(harness, `/agents/${AGENT_ID}/billing/session-actions/grant/${ACTION_ID}/accept`, {
    method: "POST",
    body: { ...signed, ownerRefused: true },
  });
  assert.equal(refused.status, 200, refused.text);
  const snapshot = await repo.snapshot(ACCOUNT_ID);
  assert.equal(snapshot?.actions[0]?.state, "owner_refused");
  assert.equal(snapshot?.actions[0]?.callsId, undefined);
  assert.equal(snapshot?.generations[0]?.state, "abandoned");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type Hex } from "viem";
import { createBillingSessionActionReconciler, prepareKmsBillingSession } from "../src/billing/sessionLifecycle.js";
import { MemoryBillingSessionGenerationRepository, type BillingSessionChainObservationV1 } from "../src/billing/sessionGenerations.js";
import type { BillingStore } from "../src/billing/store.js";
import type { BillingAccount } from "../src/billing/types.js";

const ACCOUNT = "session-lifecycle-account";
const WALLET = `0x${"a1".repeat(20)}` as const;
const COLLECTOR = `0x${"a2".repeat(20)}` as const;
const TREASURY = `0x${"a3".repeat(20)}` as const;
const KEYSTORE = "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" as const;
const PUBLIC_KEY = `0x04${"a4".repeat(64)}` as Hex;
const NONCE = `0x${"a5".repeat(32)}` as Hex;
const CALLS = `0x${"a6".repeat(32)}` as Hex;
const TX = `0x${"a7".repeat(32)}` as Hex;
const BLOCK = `0x${"a8".repeat(32)}` as Hex;

function account(): BillingAccount {
  return {
    accountId: ACCOUNT, ownerAddress: WALLET, walletAddress: WALLET, status: "paused",
    sessionFactsBytes: "pending", encryptedSessionKey: null, sessionKmsKeyArn: null,
    sessionGeneration: null, sessionPublicKey: null, sessionStateVersion: 1n,
    maxDailyUsdMicros: 1_000_000n, maxUnpaidExposureUsdMicros: 100_000n,
    thresholdUsdMicros: 100_000n, grantExpiresAt: 2_000, createdAt: 1, updatedAt: 1,
  };
}

test("production session preparation and reconciler converge after restart without any resend seam", async () => {
  const value = account();
  const store = { getAccount: async () => value } as unknown as BillingStore;
  const repository = new MemoryBillingSessionGenerationRepository([
    { accountId: ACCOUNT, walletAddress: WALLET, status: "paused", currentGeneration: null, version: 1n },
  ]);
  const prepared = await prepareKmsBillingSession({
    store, repository, accountId: ACCOUNT, ownerAddress: WALLET, walletAddress: WALLET,
    collector: COLLECTOR, treasury: TREASURY, keyStore: KEYSTORE,
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/lifecycle", publicKey: PUBLIC_KEY,
    dayCapWei: 1_000n, sessionExpiresAt: 2_000,
    maxDailyUsdMicros: value.maxDailyUsdMicros,
    maxUnpaidExposureUsdMicros: value.maxUnpaidExposureUsdMicros,
    grant: { agentId: "agent-lifecycle", nonce: NONCE, issuedAt: 10, expiresAt: 100 }, now: 10,
  });
  const submitted = await repository.acceptPreparedAction(prepared.grant.actionId, 1n, 1n, CALLS, 11);
  const observation: BillingSessionChainObservationV1 = {
    chainId: 56, receiptStatus: "success", action: "grant", wallet: WALLET, keyStore: KEYSTORE,
    keyId: keccak256(PUBLIC_KEY), callsId: CALLS, transactionHash: TX,
    blockNumber: 100n, blockHash: BLOCK, latestBlockNumber: 115n, stateBlockNumber: 100n,
    keyStoreValid: true, accountKeyAbsent: true, canPayCollector: true,
    dayLimitWei: 1_000n, currentSpentWei: 0n,
  };
  let statusReads = 0;
  let observationReads = 0;
  const restarted = createBillingSessionActionReconciler({
    repository, wallet: async () => WALLET,
    async relayStatus(callsId) { statusReads += 1; assert.equal(callsId, CALLS); return { state: "CONFIRMED", transactionHash: TX }; },
    async observe(action, transactionHash) {
      observationReads += 1; assert.equal(action.actionId, submitted.action.actionId); assert.equal(transactionHash, TX);
      return [observation, { ...observation, latestBlockNumber: 116n }];
    },
    keyStore: KEYSTORE, finalityDepth: 15, unknownAfterSec: 60, now: () => 120,
  });
  const finalized = await restarted.reconcileAccount(ACCOUNT);
  assert.equal(finalized?.account.currentGeneration, 1n);
  assert.equal(finalized?.actions[0]?.state, "confirmed");
  assert.equal(statusReads, 1);
  assert.equal(observationReads, 1);
  await restarted.reconcileAccount(ACCOUNT);
  assert.equal(statusReads, 1, "terminal restart must not poll or resend the owner action");
});

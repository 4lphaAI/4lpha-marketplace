import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAwsBillingSessionIdentityReader,
  type AwsBillingSessionIdentityDependencies } from "../src/billing/awsBillingSessionIdentity.js";
import { parseProductionManifest } from "../src/billing/productionManifest.js";
import { canonicalBillingSessionOwnerParams, PostgresBillingSessionGenerationRepository,
  type BillingSessionActionV1, type BillingSessionChainObservationV1,
  type BillingSessionGenerationV1 } from "../src/billing/sessionGenerations.js";
import { prepareVerifiedKmsBillingSession } from "../src/billing/sessionLifecycle.js";
import type { BillingStore, BillingStoreSnapshot } from "../src/billing/store.js";
import type { BillingAccount } from "../src/billing/types.js";
import type { SqlClient, SqlResult } from "../src/store/sql.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const ACCOUNT_ID = "postgres-session-account";
const WALLET = `0x${"91".repeat(20)}` as const;
const KEYSTORE = "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" as const;
const SESSION_ACCOUNT = privateKeyToAccount(`0x${"00".repeat(31)}01` as Hex);
const PUB = SESSION_ACCOUNT.publicKey;
const KEY_ID = keccak256(PUB);
const ACTION_ID = `0x${"93".repeat(32)}` as Hex;
const NONCE = `0x${"94".repeat(32)}` as Hex;
const CALLS_ID = `0x${"95".repeat(32)}` as Hex;
const TX = `0x${"96".repeat(32)}` as Hex;
const BLOCK = `0x${"97".repeat(32)}` as Hex;
const MANIFEST = parseProductionManifest(Buffer.from(GOLDEN_PRODUCTION_MANIFEST_V2));
const SESSION_ARN = "arn:aws:kms:us-east-1:123456789012:key/restart-session";

function identityDependencies(failure: "none" | "sts" | "describe" | "public"): AwsBillingSessionIdentityDependencies {
  const spki = Uint8Array.from(Buffer.from(
    `3056301006072a8648ce3d020106052b8104000a034200${PUB.slice(2)}`, "hex"));
  return {
    createRequestHandler() { return {}; },
    createStsClient() { return { async identity() { return { Account: failure === "sts" ? "999999999999" : MANIFEST.aws.accountId,
      Arn: "arn:aws:sts::123456789012:assumed-role/4lpha-billing/task-1" }; }, destroy() {} }; },
    createKmsClient() { return {
      async describe(keyArn) { return { KeyMetadata: { Arn: keyArn,
        KeySpec: failure === "describe" ? "RSA_2048" : "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY",
        KeyState: "Enabled", Enabled: true, SigningAlgorithms: ["ECDSA_SHA_256"] } }; },
      async publicKey() { return { KeySpec: failure === "public" ? "RSA_2048" : "ECC_SECG_P256K1",
        KeyUsage: "SIGN_VERIFY", SigningAlgorithms: ["ECDSA_SHA_256"], PublicKey: spki }; },
      destroy() {},
    }; },
  };
}

type Row = Record<string, unknown>;

class SessionSql implements SqlClient {
  payload: unknown;
  generations: Row[] = [];
  actions: Row[] = [];
  accountProjectionVersion = "1";

  constructor(snapshot: BillingStoreSnapshot) { this.payload = snapshot; }

  async query<ResultRow = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<SqlResult<ResultRow>> {
    let rows: readonly unknown[] = [];
    if (text.includes("billing.session.stateLock") || text.includes("billing.session.censusState")) {
      rows = [{ payload: this.payload }];
    } else if (text.includes("billing.session.generationsLock") || text.includes("billing.session.censusGenerations")) {
      rows = this.generations.filter((row) => row["account_id"] === params[0]);
    } else if (text.includes("billing.session.actionsLock") || text.includes("billing.session.censusActions")) {
      rows = this.actions.filter((row) => row["account_id"] === params[0]);
    } else if (text.includes("billing.session.actionAccount")) {
      const found = this.actions.find((row) => row["action_id"] === params[0]);
      rows = found === undefined ? [] : [{ account_id: found["account_id"] }];
    } else if (text.includes("billing.session.generationInsert")) {
      const row: Row = {
        account_id: params[0], generation: params[1], kms_key_arn: params[2], public_key: params[3],
        session_facts_bytes: params[4], session_facts_hash: params[5], expires_at: params[6],
        state: params[7], version: params[8], created_at: params[9], updated_at: params[10],
      };
      this.generations.push(row);
      rows = [row];
    } else if (text.includes("billing.session.actionInsert")) {
      const row: Row = {
        action_id: params[0], account_id: params[1], generation: params[2], kind: params[3],
        target_generation: params[4], target_key_id: params[5], nonce: params[6],
        owner_action_idempotency_key: params[7], owner_params_bytes: params[8], owner_params_hash: params[9],
        state: params[10], calls_id: params[11], transaction_hash: params[12], proof_hash: params[13],
        version: params[14], created_at: params[15], updated_at: params[16],
      };
      this.actions.push(row);
      rows = [row];
    } else if (text.includes("billing.session.generationCas")) {
      const row = this.generations.find((entry) => entry["account_id"] === params[0] && entry["generation"] === params[1] && entry["version"] === params[2]);
      if (row !== undefined) {
        row["state"] = params[3]; row["version"] = params[4]; row["updated_at"] = params[5];
        rows = [{ generation: row["generation"] }];
      }
    } else if (text.includes("billing.session.actionCas")) {
      const row = this.actions.find((entry) => entry["action_id"] === params[0] && entry["version"] === params[1]);
      if (row !== undefined) {
        row["state"] = params[2]; row["calls_id"] = params[3]; row["transaction_hash"] = params[4];
        row["proof_hash"] = params[5]; row["version"] = params[6]; row["updated_at"] = params[7];
        rows = [{ action_id: row["action_id"] }];
      }
    } else if (text.includes("billing.session.stateCas")) {
      this.payload = JSON.parse(params[0] as string) as unknown;
      rows = [{ singleton: true }];
    } else if (text.includes("billing.session.accountProjectionCas")) {
      if (params[1] === this.accountProjectionVersion) {
        this.accountProjectionVersion = String(params[7]);
        rows = [{ account_id: params[0] }];
      }
    }
    return { rows: rows as readonly ResultRow[] };
  }

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> { return fn(this); }
  async close(): Promise<void> {}
}

function emptySnapshot(account: BillingAccount): BillingStoreSnapshot {
  return {
    accounts: [[account.accountId, account]], walletAccounts: [[account.walletAddress, account.accountId]],
    grants: [], tickets: [], replays: [], logical: [], usages: [], debitIdentities: [], leases: [],
    invoices: [], nonterminalInvoiceByUsage: [], ledger: [], ogReconciliations: [],
  };
}

function kmsAccount(): BillingAccount {
  return {
    accountId: ACCOUNT_ID, ownerAddress: WALLET, walletAddress: WALLET, status: "paused",
    sessionFactsBytes: "kms-session", encryptedSessionKey: null, sessionKmsKeyArn: null,
    sessionGeneration: null, sessionPublicKey: null, sessionStateVersion: 1n,
    maxDailyUsdMicros: 1_000_000n, maxUnpaidExposureUsdMicros: 500_000n,
    thresholdUsdMicros: 100_000n, grantExpiresAt: 2_000, createdAt: 1, updatedAt: 1,
  };
}

function generation(): BillingSessionGenerationV1 {
  const collector = `0x${"98".repeat(20)}`;
  const facts = Buffer.from(JSON.stringify({
    version: "billing-session-facts-v1",
    spec: { allowedCalls: [{ to: collector, selector: "payInvoice(bytes32,uint64)" }],
      spendCaps: [{ limit: "1000", period: "day" }], expiresAt: 2_000 },
    permissions: { calls: [{ signature: "payInvoice(bytes32,uint64)", to: collector }],
      spend: [{ limit: { $uint: "1000" }, period: "day" }] },
    publicKey: PUB, expiry: 2_000,
  }), "utf8").toString("base64");
  return {
    accountId: ACCOUNT_ID, generation: 1n,
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/postgres-session", publicKey: PUB,
    sessionFactsBytes: facts, sessionFactsHash: keccak256(Buffer.from(facts, "base64")),
    expiresAt: 2_000, state: "prepared", version: 1n, createdAt: 1, updatedAt: 1,
  };
}

function action(row: BillingSessionGenerationV1): BillingSessionActionV1 {
  const owner = canonicalBillingSessionOwnerParams({
    action: "grant", accountId: ACCOUNT_ID, wallet: WALLET, oldGeneration: 0n, newGeneration: 1n,
    kmsPublicKey: PUB, keyId: KEY_ID, sessionFactsHash: row.sessionFactsHash,
    collector: `0x${"98".repeat(20)}`, dayCapWei: 1_000n, expiry: 2_000,
    nonce: NONCE, issuedAt: 10, expiresAt: 100,
  });
  return {
    actionId: ACTION_ID, accountId: ACCOUNT_ID, generation: 1n, kind: "grant", targetGeneration: 1n,
    targetKeyId: KEY_ID, nonce: NONCE, ownerActionIdempotencyKey: `0x${"99".repeat(32)}`,
    ownerParamsBytes: owner.canonical, ownerParamsHash: owner.paramsHash,
    state: "prepared", version: 1n, createdAt: 1, updatedAt: 1,
  };
}

function observation(row: BillingSessionActionV1): BillingSessionChainObservationV1 {
  return {
    chainId: 56, receiptStatus: "success", action: "grant", wallet: WALLET, keyStore: KEYSTORE,
    keyId: KEY_ID, callsId: row.callsId ?? CALLS_ID, transactionHash: TX,
    blockNumber: 100n, blockHash: BLOCK, latestBlockNumber: 115n, stateBlockNumber: 100n,
    keyStoreValid: true, accountKeyAbsent: true, canPayCollector: true,
    dayLimitWei: 1_000n, currentSpentWei: 100n,
  };
}

test("Postgres session repository persists prepared -> submitted -> finalized and updates current account projection atomically", async () => {
  const sql = new SessionSql(emptySnapshot(kmsAccount()));
  const repo = await PostgresBillingSessionGenerationRepository.create(sql);
  const createdGeneration = await repo.insertGeneration(generation());
  await repo.insertAction(action(createdGeneration));
  const accepted = await repo.acceptPreparedAction(ACTION_ID, 1n, 1n, CALLS_ID, 2);
  const seen = observation(accepted.action);
  const finalized = await repo.finalizeAction({
    actionId: ACTION_ID, expectedActionVersion: 2n, expectedAccountVersion: 1n,
    expectedGenerationVersions: { "1": 2n }, wallet: WALLET, keyStore: KEYSTORE,
    finalityDepth: 15, observations: [seen, { ...seen, latestBlockNumber: 116n }], now: 3,
  });
  assert.equal(finalized.account.currentGeneration, 1n);
  assert.equal(finalized.account.status, "active");
  const census = await repo.censusForOn();
  assert.equal(census.length, 1);
  assert.equal(census[0]?.account.sessionGeneration, 1n);
  assert.equal(census[0]?.account.sessionFactsBytes, createdGeneration.sessionFactsBytes);
  assert.equal(census[0]?.account.grantExpiresAt, createdGeneration.expiresAt);
  assert.equal(census[0]?.generations[0]?.state, "active");
  assert.equal(census[0]?.actions[0]?.state, "confirmed");
});

test("ON census rejects legacy ciphertext accounts instead of treating them as KMS custody", async () => {
  const kms = kmsAccount();
  const legacy: BillingAccount = {
    accountId: kms.accountId,
    ownerAddress: kms.ownerAddress,
    walletAddress: kms.walletAddress,
    status: "active",
    sessionFactsBytes: kms.sessionFactsBytes,
    encryptedSessionKey: "legacy-ciphertext",
    maxDailyUsdMicros: kms.maxDailyUsdMicros,
    maxUnpaidExposureUsdMicros: kms.maxUnpaidExposureUsdMicros,
    thresholdUsdMicros: kms.thresholdUsdMicros,
    grantExpiresAt: kms.grantExpiresAt,
    createdAt: kms.createdAt,
    updatedAt: kms.updatedAt,
  };
  const repo = PostgresBillingSessionGenerationRepository.attach(new SessionSql(emptySnapshot(legacy)));
  await assert.rejects(repo.censusForOn(), /legacy or dual custody/);
});

test("verified KMS preparation is zero-write on identity mismatch and restart-idempotent through the real Postgres repository", async () => {
  const account = kmsAccount();
  const sql = new SessionSql(emptySnapshot(account));
  const store = { getAccount: async (accountId: string) => accountId === ACCOUNT_ID ? account : null } as unknown as BillingStore;
  let durableOpens = 0;
  const input = {
    openDurableState: async () => {
      durableOpens += 1;
      return { store, repository: PostgresBillingSessionGenerationRepository.attach(sql), async close() {} };
    },
    manifest: MANIFEST,
    accountId: ACCOUNT_ID,
    ownerAddress: WALLET,
    walletAddress: WALLET,
    collector: `0x${"98".repeat(20)}` as const,
    treasury: `0x${"89".repeat(20)}` as const,
    keyStore: KEYSTORE,
    kmsKeyArn: SESSION_ARN,
    dayCapWei: 1_000n,
    sessionExpiresAt: 2_000,
    maxDailyUsdMicros: account.maxDailyUsdMicros,
    maxUnpaidExposureUsdMicros: account.maxUnpaidExposureUsdMicros,
    grant: { agentId: "agent-restart", nonce: NONCE, issuedAt: 10, expiresAt: 100 },
    now: 10,
  } as const;
  for (const failure of ["sts", "describe", "public"] as const) {
    const invalidIdentityReader = createAwsBillingSessionIdentityReader({
      environment: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" },
      dependencies: identityDependencies(failure),
    });
    await assert.rejects(prepareVerifiedKmsBillingSession({ ...input,
      identityReader: invalidIdentityReader }));
    assert.equal(durableOpens, 0, `${failure} mismatch opened durable state`);
    assert.equal(sql.generations.length, 0, `${failure} mismatch wrote a generation`);
    assert.equal(sql.actions.length, 0, `${failure} mismatch wrote an action`);
  }

  const identityReader = createAwsBillingSessionIdentityReader({
    environment: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-1" },
    dependencies: identityDependencies("none"),
  });
  const first = await prepareVerifiedKmsBillingSession({ ...input, identityReader });
  const restarted = await prepareVerifiedKmsBillingSession({
    ...input,
    identityReader,
  });
  assert.equal(first.generation.generation, 1n);
  assert.equal(restarted.grant.actionId, first.grant.actionId);
  assert.equal(sql.generations.length, 1);
  assert.equal(sql.actions.length, 1);
  assert.equal(durableOpens, 2);
  assert.equal(first.account.encryptedSessionKey, null);
});

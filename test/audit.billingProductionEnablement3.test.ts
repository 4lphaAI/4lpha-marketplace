import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Hex } from "viem";
import type { BillingSessionKmsIdentityReaderV1 } from "../src/billing/awsBillingSessionIdentity.js";
import { parseProductionManifest } from "../src/billing/productionManifest.js";
import type { BillingSessionGenerationRepository } from "../src/billing/sessionGenerations.js";
import { prepareVerifiedKmsBillingSession } from "../src/billing/sessionLifecycle.js";
import type { BillingStore } from "../src/billing/store.js";
import { GOLDEN_PRODUCTION_MANIFEST_V2 } from "./fixtures/billing/productionManifestV2.js";

const MANIFEST = parseProductionManifest(Buffer.from(GOLDEN_PRODUCTION_MANIFEST_V2));
const SESSION_ARN = "arn:aws:kms:us-east-1:123456789012:key/audit-deferred-open";
const PUBLIC_KEY = `0x04${"12".repeat(64)}` as Hex;

function preparationInput(input: Readonly<{
  identityReader: BillingSessionKmsIdentityReaderV1;
  openDurableState(): Promise<Readonly<{
    store: BillingStore;
    repository: BillingSessionGenerationRepository;
    close(): Promise<void>;
  }>>;
}>) {
  return {
    ...input,
    manifest: MANIFEST,
    accountId: "audit-deferred-open-account",
    ownerAddress: `0x${"21".repeat(20)}` as const,
    walletAddress: `0x${"21".repeat(20)}` as const,
    collector: `0x${"22".repeat(20)}` as const,
    treasury: `0x${"23".repeat(20)}` as const,
    keyStore: "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a" as const,
    kmsKeyArn: SESSION_ARN,
    dayCapWei: 1_000n,
    sessionExpiresAt: 2_000,
    maxDailyUsdMicros: 1_000_000n,
    maxUnpaidExposureUsdMicros: 100_000n,
    grant: {
      agentId: "audit-deferred-open-agent",
      nonce: `0x${"24".repeat(32)}` as Hex,
      issuedAt: 10,
      expiresAt: 100,
    },
    now: 10,
  } as const;
}

test("audit: production session preparation proves AWS KMS identity before the first PostgreSQL write", async () => {
  const source = await readFile(new URL("../scripts/provision-billing.ts", import.meta.url), "utf8");
  const identityRead = source.indexOf("await identityReader.read(");
  const databaseOpen = source.indexOf("await createPgSqlClient(");
  const databaseBootstrap = source.indexOf("await PostgresBillingStore.create(");

  assert.ok(identityRead >= 0, "the production command must perform the closed identity read explicitly");
  assert.ok(databaseOpen >= 0 && databaseBootstrap >= 0, "the production command must retain its PostgreSQL path");
  assert.ok(identityRead < databaseOpen && identityRead < databaseBootstrap,
    "STS/DescribeKey/GetPublicKey identity proof must complete before PostgreSQL can run DDL, migrations, or seed writes");
});

test("audit: durable open is deferred until identity completion and is never called on identity refusal", async () => {
  const events: string[] = [];
  let releaseIdentity: (() => void) | undefined;
  const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  const identityReader: BillingSessionKmsIdentityReaderV1 = {
    async read() {
      events.push("identity-start");
      await identityGate;
      events.push("identity-refuse");
      throw new Error("identity mismatch");
    },
  };
  const pending = prepareVerifiedKmsBillingSession(preparationInput({
    identityReader,
    async openDurableState() {
      events.push("durable-open");
      throw new Error("must stay unreachable");
    },
  }));

  await Promise.resolve();
  assert.deepEqual(events, ["identity-start"]);
  releaseIdentity?.();
  await assert.rejects(pending, /identity mismatch/u);
  assert.deepEqual(events, ["identity-start", "identity-refuse"]);
});

test("audit: durable state closes exactly once when post-open preparation refuses", async () => {
  const events: string[] = [];
  const identityReader: BillingSessionKmsIdentityReaderV1 = {
    async read() {
      events.push("identity-complete");
      return Object.freeze({
        domain: "4lpha.billing-session-kms-identity.v1",
        kmsKeyArn: SESSION_ARN,
        publicKey: PUBLIC_KEY,
      });
    },
  };
  const store = {
    async getAccount() {
      events.push("durable-write-path");
      throw new Error("post-open preparation refusal");
    },
  } as unknown as BillingStore;
  const repository = {} as BillingSessionGenerationRepository;

  await assert.rejects(prepareVerifiedKmsBillingSession(preparationInput({
    identityReader,
    async openDurableState() {
      events.push("durable-open");
      return {
        store,
        repository,
        async close() { events.push("durable-close"); },
      };
    },
  })), /post-open preparation refusal/u);
  assert.deepEqual(events, [
    "identity-complete",
    "durable-open",
    "durable-write-path",
    "durable-close",
  ]);
});
